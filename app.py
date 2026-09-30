"""
AquaGrow-AI - Flask Backend (Stage 1-6)

Stage 1: Flask server, SQLite database, basic dashboard.
Stage 2: background simulator thread generating sensor readings.
Stage 3: automatic irrigation logic + configurable growth-stage thresholds.
Stage 4: water usage tracking (from flow readings) + leak/blockage detection.
Stage 5: load the trained ML model (see ml/train_model.py) and use it to
         predict, every tick, whether irrigation will likely be needed soon.
Stage 6: accept real sensor readings from an ESP32 (see esp32/), and let it
         poll for the pump command instead of the simulator driving everything.
Stage 7: read back the stored sensor history to measure how fast the soil is
         actually drying (or refilling), and turn that into an ETA for when
         moisture will cross the growth stage's threshold.
"""

import pickle
import sqlite3
import threading
import time
import traceback
from datetime import date, datetime

import pandas as pd
from flask import Flask, g, jsonify, render_template, request

from simulator.sensor_simulator import FORCED_SCENARIOS, INITIAL_STATE, SCENARIOS, generate_reading

app = Flask(__name__)

DATABASE = "database.db"

# How often (seconds) the simulator generates a new reading
SIMULATOR_INTERVAL_SECONDS = 5

# In-memory simulator state. A small-scale Flask app runs as a
# single process, so plain module-level variables are enough - no need
# for a real message queue or task runner.
current_scenario = "normal"
current_state = dict(INITIAL_STATE)

# Irrigation controller state (Stage 3)
current_growth_stage = "Vegetative"
auto_mode = True          # when True, the controller decides the pump; when False, manual_pump_on does
manual_pump_on = False

# Water usage + leak detection state (Stage 4)
irrigation_session_liters = 0.0   # water used so far during the current pump-ON session
irrigation_session_start = None   # time.time() when the current session started
active_alerts = {}                # condition type -> id of its currently open (unresolved) alert row

# Simple leak-detection thresholds (L/min)
LEAK_FLOW_THRESHOLD = 0.3      # flow above this while the pump is OFF looks like a leak
BLOCKAGE_FLOW_THRESHOLD = 0.3  # flow below this while the pump is ON looks like a blockage
LOW_TANK_THRESHOLD = 15        # tank level (%) at or below this triggers a low-tank alert

# ML model state (Stage 5) - populated by load_ml_model() at startup
ML_MODEL_PATH = "ml/model.pkl"
ml_model = None
ml_feature_columns = None

# Moisture forecasting (Stage 7). The rate is measured from stored history,
# so these are in readings and real minutes, not simulator ticks.
# HISTORY_LIMIT is a count of readings, so how much real time it spans depends
# on how often data arrives (2 min of simulator ticks, but hours of ESP32 posts
# if it only reports every few minutes). It is a trade-off: a longer window
# rides out noise but is slower to notice conditions genuinely changing - at 60
# readings, a switch to hot/dry weather took ~2 minutes to show up in the rate.
FORECAST_HISTORY_LIMIT = 24      # how many recent readings to measure the rate over
FORECAST_MIN_PAIRS = 3           # fewer usable changes than this and the rate isn't trustworthy
FORECAST_MAX_GAP_SECONDS = 120   # ignore a change spanning a longer gap - the server was probably restarted
FORECAST_FLAT_RATE = 0.05        # a rate (%/min) smaller than this counts as "holding steady"
FORECAST_MAX_MINUTES = 240       # don't project further ahead than this - it stops being meaningful

# Advisories (Stage 8): guidance when nothing is broken, mostly "don't water yet".
# These are rules over stored measurements, not model output - see detect_advisories().
RECENT_WATERING_SECONDS = 90     # how long after a watering to advise letting the soil equalise
OVERWATERING_MULTIPLIER = 2.0    # today's use this many times the daily average is worth flagging
OVERWATERING_MIN_DAYS = 2        # need this many past days before an average means anything
OVERWATERING_BASELINE_DAYS = 7   # how many past days the average is taken over
SOIL_HOLDING_FRACTION = 0.5      # drying slower than this share of the usual rate = soil is holding on
TYPICAL_RATE_HISTORY_LIMIT = 500 # readings behind the "usual drying rate" baseline
TYPICAL_RATE_CACHE_SECONDS = 60  # that baseline moves slowly, so don't requery it every tick
INEFFECTIVE_FLOW_MINIMUM = 1.0   # L/min - flow this healthy should be moving the moisture reading
INEFFECTIVE_MOISTURE_RISE = 0.5  # % - less rise than this, with good flow, means water isn't reaching the roots
INEFFECTIVE_MIN_SECONDS = 20     # give a watering run this long to show an effect before judging it

# Fertigation timing (Stage 8). TIMING ONLY - there is no EC/pH/NPK sensor on
# this system, so none of this says anything about actual nutrient levels.
FERTIGATION_DRY_MARGIN = 10      # % below threshold where feeding risks burning roots
FERTIGATION_WET_MARGIN = 15      # % above threshold where nutrients leach past the root zone
FERTIGATION_IMMINENT_MINUTES = 15  # irrigation due sooner than this would flush a fresh application

# Data source (Stage 6): while True, the background thread generates fake
# readings. An ESP32 posting to /api/sensor_data switches this off
# automatically, so simulated and real data never get mixed together.
simulator_enabled = True

# ESP32 liveness (Stage 9). The board pushes to us and never listens, so the
# only evidence it is alive is how recently it posted. Without this the
# dashboard reported "ESP32 (Live)" forever after a single POST, while the
# loop kept billing water from a flow reading that stopped updating.
# Derived, not hard-coded: the board is expected to post on the same beat as
# SIMULATOR_INTERVAL_SECONDS, so "gone" has to mean several missed posts. A
# fixed 30s would sit exactly on the boundary if the interval were ever raised
# to 30s for real soil, and the board would flicker offline every cycle.
ESP32_OFFLINE_SECONDS = SIMULATOR_INTERVAL_SECONDS * 6   # six missed posts
esp32_last_seen = None       # time.time() of the most recent /api/sensor_data POST
esp32_address = None         # who sent it, so the dashboard can name the board

# What a board must send to /api/sensor_data, and what it may leave out.
# The optional two need sensors a minimal three-sensor build doesn't have.
REQUIRED_SENSOR_FIELDS = ["soil_moisture", "air_temperature", "humidity", "water_flow", "pump_status"]
OPTIONAL_SENSOR_FIELDS = ["soil_temperature", "water_tank_level"]

# Default moisture thresholds (%) per plant growth stage.
# These are just starting values - they can be changed later from the
# dashboard/database without touching the code.
DEFAULT_GROWTH_STAGES = [
    ("Seedling", 60),
    ("Vegetative", 50),
    ("Flowering", 45),
    ("Fruiting", 40),
]


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    """Open a new database connection if there isn't one for this request."""
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row  # lets us access columns by name
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    """Close the database connection at the end of each request."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create all tables used by the project (if they don't exist yet)."""
    conn = sqlite3.connect(DATABASE)
    cur = conn.cursor()

    # Raw sensor readings coming from the simulator (later: the ESP32)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            soil_moisture REAL,
            soil_temperature REAL,
            air_temperature REAL,
            humidity REAL,
            water_tank_level REAL,
            water_flow REAL,
            pump_status TEXT,
            growth_stage TEXT
        )
        """
    )

    # Every time the pump turns on/off, log why
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS irrigation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            action TEXT NOT NULL,
            reason TEXT,
            duration_seconds REAL,
            water_used_liters REAL
        )
        """
    )

    # Daily / running totals of water used
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS water_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL UNIQUE,
            daily_total_liters REAL DEFAULT 0,
            total_liters REAL DEFAULT 0
        )
        """
    )

    # Configurable moisture threshold per growth stage
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS growth_stages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stage_name TEXT NOT NULL UNIQUE,
            moisture_threshold REAL NOT NULL
        )
        """
    )

    # Leak / blockage / low tank alerts
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            alert_type TEXT NOT NULL,
            message TEXT,
            severity TEXT NOT NULL DEFAULT 'fault',
            resolved INTEGER DEFAULT 0
        )
        """
    )

    # Predictions produced by the ML model
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            prediction TEXT NOT NULL,
            confidence REAL
        )
        """
    )

    # Databases created before Stage 8 have no severity column on alerts
    alert_columns = [row[1] for row in cur.execute("PRAGMA table_info(alerts)")]
    if "severity" not in alert_columns:
        cur.execute("ALTER TABLE alerts ADD COLUMN severity TEXT NOT NULL DEFAULT 'fault'")

    # Seed the growth_stages table with default thresholds, only if empty
    cur.execute("SELECT COUNT(*) FROM growth_stages")
    if cur.fetchone()[0] == 0:
        cur.executemany(
            "INSERT INTO growth_stages (stage_name, moisture_threshold) VALUES (?, ?)",
            DEFAULT_GROWTH_STAGES,
        )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Simulator (Stage 2)
# ---------------------------------------------------------------------------

def save_reading(state):
    """Insert one simulated reading into the sensor_readings table.

    Runs on a background thread (not a Flask request), so it opens its
    own database connection instead of using get_db()/g.
    """
    conn = sqlite3.connect(DATABASE)
    conn.execute(
        """
        INSERT INTO sensor_readings
            (timestamp, soil_moisture, soil_temperature, air_temperature,
             humidity, water_tank_level, water_flow, pump_status, growth_stage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now().isoformat(timespec="seconds"),
            state["soil_moisture"],
            state["soil_temperature"],
            state["air_temperature"],
            state["humidity"],
            state["water_tank_level"],
            state["water_flow"],
            state["pump_status"],
            state["growth_stage"],
        ),
    )
    conn.commit()
    conn.close()


def get_moisture_threshold(stage_name):
    """Look up the configured moisture threshold (%) for a growth stage."""
    conn = sqlite3.connect(DATABASE)
    row = conn.execute(
        "SELECT moisture_threshold FROM growth_stages WHERE stage_name = ?", (stage_name,)
    ).fetchone()
    conn.close()
    return row[0] if row else 50.0


def log_irrigation_event(action, reason, duration_seconds=None, water_used_liters=None):
    """Record a pump ON/OFF event, optionally with how long it ran and how much water it used."""
    conn = sqlite3.connect(DATABASE)
    conn.execute(
        """
        INSERT INTO irrigation_events (timestamp, action, reason, duration_seconds, water_used_liters)
        VALUES (?, ?, ?, ?, ?)
        """,
        (datetime.now().isoformat(timespec="seconds"), action, reason, duration_seconds, water_used_liters),
    )
    conn.commit()
    conn.close()


def add_water_usage(liters):
    """Add water used (from this tick's flow reading) to today's daily and running totals."""
    if liters <= 0:
        return

    conn = sqlite3.connect(DATABASE)
    today = date.today().isoformat()
    row = conn.execute(
        "SELECT daily_total_liters, total_liters FROM water_usage WHERE date = ?", (today,)
    ).fetchone()

    if row:
        new_daily = row[0] + liters
        new_total = row[1] + liters
        conn.execute(
            "UPDATE water_usage SET daily_total_liters = ?, total_liters = ? WHERE date = ?",
            (new_daily, new_total, today),
        )
    else:
        # Carry over the running total from the most recent previous day, if any
        prev = conn.execute("SELECT total_liters FROM water_usage ORDER BY date DESC LIMIT 1").fetchone()
        prev_total = prev[0] if prev else 0.0
        conn.execute(
            "INSERT INTO water_usage (date, daily_total_liters, total_liters) VALUES (?, ?, ?)",
            (today, liters, prev_total + liters),
        )

    conn.commit()
    conn.close()


def detect_faults(state):
    """Hardware faults visible in a single reading: leak, blockage, empty tank.

    Returns a list of (fault_type, message) - every fault that applies, not
    just the first, so a leak no longer hides a low tank the way the old
    single-alert version did.
    """
    faults = []

    if state["pump_status"] == "OFF" and state["water_flow"] > LEAK_FLOW_THRESHOLD:
        faults.append(("leak", f"Possible leak: pump is OFF but water is flowing ({state['water_flow']} L/min)"))

    if state["pump_status"] == "ON" and state["water_flow"] < BLOCKAGE_FLOW_THRESHOLD:
        faults.append(("blockage", f"Possible blockage or pump problem: pump is ON but flow is only {state['water_flow']} L/min"))

    # None means no tank sensor fitted - silence beats a fabricated level
    if state["water_tank_level"] is not None and state["water_tank_level"] <= LOW_TANK_THRESHOLD:
        faults.append(("low_tank", f"Water tank level is low ({state['water_tank_level']}%)"))

    return faults


def create_alert(alert_type, message, severity="fault"):
    """Insert a new unresolved alert and return its id.

    severity is "fault" (something is broken) or "advisory" (nothing is wrong,
    but the grower may want to act differently - usually "don't water yet").
    """
    conn = sqlite3.connect(DATABASE)
    cur = conn.execute(
        "INSERT INTO alerts (timestamp, alert_type, message, severity, resolved) VALUES (?, ?, ?, ?, 0)",
        (datetime.now().isoformat(timespec="seconds"), alert_type, message, severity),
    )
    conn.commit()
    alert_id = cur.lastrowid
    conn.close()
    return alert_id


def resolve_orphaned_alerts():
    """Close any alerts left open when the last run ended.

    active_alerts only lives in memory, so a restart loses track of which rows
    were still open and they would sit unresolved forever - the dashboard kept
    counting month-old alerts as active. Anything still genuinely true is
    recreated on the next tick, so clearing them here loses nothing.
    """
    conn = sqlite3.connect(DATABASE)
    cur = conn.execute("UPDATE alerts SET resolved = 1 WHERE resolved = 0")
    conn.commit()
    orphaned = cur.rowcount
    conn.close()
    if orphaned:
        print(f"Closed {orphaned} alert(s) left open by a previous run.")


def resolve_alert(alert_id):
    """Mark an alert resolved once the condition that triggered it clears."""
    conn = sqlite3.connect(DATABASE)
    conn.execute("UPDATE alerts SET resolved = 1 WHERE id = ?", (alert_id,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Machine learning (Stage 5)
# ---------------------------------------------------------------------------

def load_ml_model():
    """Load the model trained by ml/train_model.py, if it exists yet."""
    global ml_model, ml_feature_columns
    try:
        with open(ML_MODEL_PATH, "rb") as f:
            bundle = pickle.load(f)
        ml_model = bundle["model"]
        ml_feature_columns = bundle["feature_columns"]
        print(f"Loaded ML model from {ML_MODEL_PATH}")
    except FileNotFoundError:
        print(f"No trained model found at {ML_MODEL_PATH} - run 'python ml/train_model.py' to create one.")


def predict_irrigation_need(state, growth_stage, previous_watering):
    """Ask the trained model whether irrigation will likely be needed soon.

    Returns (label, confidence_percent), or (None, None) if no model is loaded.
    """
    if ml_model is None:
        return None, None

    # The model was trained on soil_temperature, so a board without that
    # probe cannot feed it. Substituting air temperature would quietly
    # change what the model is being asked - retrain it on the features
    # actually available instead (see ml/train_model.py).
    if state.get("soil_temperature") is None:
        return None, None

    # Build one row matching the exact columns the model was trained on
    # (one-hot growth stage columns default to 0, then we set the active one)
    row = {col: 0 for col in ml_feature_columns}
    row["soil_moisture"] = state["soil_moisture"]
    row["soil_temperature"] = state["soil_temperature"]
    row["air_temperature"] = state["air_temperature"]
    row["humidity"] = state["humidity"]
    row["previous_watering"] = previous_watering
    stage_column = f"growth_stage_{growth_stage}"
    if stage_column in row:
        row[stage_column] = 1

    X = pd.DataFrame([row])[ml_feature_columns]
    predicted_class = int(ml_model.predict(X)[0])
    confidence = round(float(ml_model.predict_proba(X)[0][predicted_class]) * 100, 1)
    label = "Irrigation likely needed soon" if predicted_class == 1 else "Moisture OK"
    return label, confidence


def save_ai_prediction(label, confidence):
    """Record a prediction so the dashboard (and later, a chart) can show it."""
    conn = sqlite3.connect(DATABASE)
    conn.execute(
        "INSERT INTO ai_predictions (timestamp, prediction, confidence) VALUES (?, ?, ?)",
        (datetime.now().isoformat(timespec="seconds"), label, confidence),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Moisture forecasting (Stage 7)
# ---------------------------------------------------------------------------

def _median(values):
    """Middle value of a list, so one noisy reading can't skew the rate the way a mean would."""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _trim(number):
    """0.5 -> '0.5', 4.0 -> '4' - keeps a duration from reading as '4.0 h'."""
    return f"{number:.1f}".rstrip("0").rstrip(".")


def _format_duration(minutes):
    """Turn a number of minutes into something short enough for a dashboard card."""
    if minutes < 1:
        return "< 1 min"
    if minutes < 90:
        return f"{round(minutes)} min"
    if minutes < 60 * 24:
        return f"{_trim(minutes / 60)} h"
    days = _trim(minutes / 1440)
    return f"{days} day" if days == "1" else f"{days} days"


def _format_eta(minutes):
    """The headline form of a duration - "< 1 min" already reads as approximate, the rest need a "~"."""
    text = _format_duration(minutes)
    return text if text.startswith("<") else f"~ {text}"


def _moisture_rates(rows, pump_status):
    """Per-minute moisture changes across consecutive readings taken in one pump state.

    rows come newest-first, straight from the database. Each reading's
    pump_status describes what the pump was doing during the step that produced
    it, so a change only counts when the *newer* reading matches pump_status -
    that way "how fast is it drying" never accidentally measures a watering run.
    Pairs straddling a long gap (a server restart) are dropped.
    """
    readings = list(reversed(rows))  # oldest first, so each pair moves forward in time
    rates = []

    for previous, current in zip(readings, readings[1:]):
        if current["pump_status"] != pump_status:
            continue  # that step measured the opposite pump state
        seconds = (
            datetime.fromisoformat(current["timestamp"]) - datetime.fromisoformat(previous["timestamp"])
        ).total_seconds()
        if not 0 < seconds <= FORECAST_MAX_GAP_SECONDS:
            continue  # duplicate timestamps, or a gap across a restart
        rates.append((current["soil_moisture"] - previous["soil_moisture"]) / seconds * 60)

    return rates


def estimate_moisture_forecast(threshold):
    """Project how long until soil moisture reaches the growth stage's threshold.

    The Stage 5 model only ever sees one snapshot, so it can say "irrigation
    needed soon" but never how soon. This works from the recent rows of
    sensor_readings instead - the history the dashboard is already storing -
    and turns it into an actual ETA.

    Each reading's pump_status describes what the pump was doing during the
    step that produced it, so only the changes whose *newer* reading matches
    the pump's current state get measured: while the pump is OFF that is how
    fast the soil is drying out, and while it is ON, how fast watering is
    refilling it. Pairs straddling a pump switch (or a server restart) are
    skipped, and the median of what's left is the rate.

    Returns a dict the dashboard renders directly.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT timestamp, soil_moisture, pump_status FROM sensor_readings ORDER BY id DESC LIMIT ?",
        (FORECAST_HISTORY_LIMIT,),
    ).fetchall()
    conn.close()

    # Same keys every time, so the dashboard never has to check for missing fields
    unknown = {
        "state": "unknown",
        "headline": "--",
        "pump_on": None,
        "rate_per_minute": None,
        "minutes_to_threshold": None,
    }

    if not rows:
        return {**unknown, "detail": "No sensor history yet."}

    latest = rows[0]
    # Rounded once here: the simulator already rounds, but an ESP32 can post
    # raw floats, and "64.623456%" has no business on a dashboard card
    moisture = round(latest["soil_moisture"], 1)
    pump_on = latest["pump_status"] == "ON"
    rates = _moisture_rates(rows, latest["pump_status"])

    if len(rates) < FORECAST_MIN_PAIRS:
        return {**unknown, "pump_on": pump_on, "detail": "Collecting readings to estimate a rate..."}

    rate = round(_median(rates), 2)
    forecast = {"pump_on": pump_on, "rate_per_minute": rate, "minutes_to_threshold": None}
    trend = f"{abs(rate)} %/min"
    target = f"{_trim(threshold)}%"  # thresholds come out of SQLite as REALs - show 50%, not 50.0%

    # Barely moving: no meaningful rate to extrapolate, so just say which side of the line it sits on
    if abs(rate) < FORECAST_FLAT_RATE:
        below = moisture < threshold
        return {
            **forecast,
            "state": "dry-now" if below else "steady",
            "headline": "Below threshold" if below else "Holding steady",
            "detail": f"{moisture}% vs {target} threshold - barely moving",
        }

    drying = rate < 0

    # Already past the line: there is no ETA left to give
    if drying and moisture <= threshold:
        return {
            **forecast,
            "state": "dry-now",
            "headline": "Below threshold",
            "detail": f"{moisture}% is under the {target} threshold, still falling {trend}",
        }
    if not drying and moisture >= threshold:
        return {
            **forecast,
            "state": "satisfied",
            "headline": "Fully irrigated",
            "detail": f"{moisture}% is at or above the {target} threshold",
        }

    # Heading toward the line: extrapolate at the measured rate
    minutes = abs(moisture - threshold) / abs(rate)
    forecast["minutes_to_threshold"] = round(minutes, 1)

    if minutes > FORECAST_MAX_MINUTES:
        headline = f"> {_format_duration(FORECAST_MAX_MINUTES)}"
    else:
        headline = _format_eta(minutes)

    if drying:
        return {
            **forecast,
            "state": "drying",
            "headline": headline,
            "detail": f"until the {target} threshold - drying {trend}",
        }
    return {
        **forecast,
        "state": "filling",
        "headline": headline,
        "detail": f"until the {target} threshold - refilling {trend}",
    }


# ---------------------------------------------------------------------------
# Advisories and fertigation timing (Stage 8)
# ---------------------------------------------------------------------------

# Cached so the long baseline query doesn't re-run on every 5-second tick
_typical_rate_cache = {"value": None, "computed_at": 0.0}


def typical_drying_rate():
    """The soil's usual drying rate (%/min, positive), over a long stretch of history.

    This is the baseline an unusually slow dry-down gets compared against.
    Only pump-OFF steps that actually lost moisture count, so watering runs and
    the odd sensor bounce upward don't drag the average down.
    """
    now = time.time()
    if _typical_rate_cache["value"] is not None and now - _typical_rate_cache["computed_at"] < TYPICAL_RATE_CACHE_SECONDS:
        return _typical_rate_cache["value"]

    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT timestamp, soil_moisture, pump_status FROM sensor_readings ORDER BY id DESC LIMIT ?",
        (TYPICAL_RATE_HISTORY_LIMIT,),
    ).fetchall()
    conn.close()

    falling = [rate for rate in _moisture_rates(rows, "OFF") if rate < 0]
    value = abs(_median(falling)) if len(falling) >= FORECAST_MIN_PAIRS else None

    _typical_rate_cache.update({"value": value, "computed_at": now})
    return value


def seconds_since_last_watering():
    """How long since the pump last finished a run, or None if it never has."""
    conn = sqlite3.connect(DATABASE)
    row = conn.execute(
        "SELECT timestamp FROM irrigation_events WHERE action = 'PUMP_OFF' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()

    if row is None:
        return None
    return (datetime.now() - datetime.fromisoformat(row[0])).total_seconds()


def current_watering_progress():
    """How the watering run in progress is going: (seconds_running, moisture_change).

    Walks back through the unbroken stretch of pump-ON readings. Returns
    (None, None) when the pump is off or there isn't enough of a run to judge.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT timestamp, soil_moisture, pump_status FROM sensor_readings ORDER BY id DESC LIMIT ?",
        (FORECAST_HISTORY_LIMIT,),
    ).fetchall()
    conn.close()

    if not rows or rows[0]["pump_status"] != "ON":
        return None, None

    run = []
    for row in rows:  # newest first, so this collects the current run backwards
        if row["pump_status"] != "ON":
            break
        run.append(row)

    if len(run) < 2:
        return None, None

    newest, oldest = run[0], run[-1]
    seconds = (
        datetime.fromisoformat(newest["timestamp"]) - datetime.fromisoformat(oldest["timestamp"])
    ).total_seconds()
    return seconds, newest["soil_moisture"] - oldest["soil_moisture"]


def recent_daily_water_average():
    """(average daily litres over previous days, litres used today).

    The average is None until there are enough past days for one to mean anything.
    """
    conn = sqlite3.connect(DATABASE)
    today = date.today().isoformat()
    past = conn.execute(
        "SELECT daily_total_liters FROM water_usage WHERE date < ? ORDER BY date DESC LIMIT ?",
        (today, OVERWATERING_BASELINE_DAYS),
    ).fetchall()
    row = conn.execute("SELECT daily_total_liters FROM water_usage WHERE date = ?", (today,)).fetchone()
    conn.close()

    today_total = row[0] if row else 0.0
    if len(past) < OVERWATERING_MIN_DAYS:
        return None, today_total
    return sum(day[0] for day in past) / len(past), today_total


def detect_advisories(state, threshold, forecast):
    """Things worth telling the grower when nothing is actually broken.

    These are rules over measurements that already exist, not model output:
    "you watered four minutes ago" is right every time, where the classifier
    tops out around 74% confidence. The model's job stays prediction; these
    answer the question it cannot - whether to act at all.
    """
    advisories = []
    target = f"{_trim(threshold)}%"

    # Just watered: soil needs time to wick before another reading means much
    since_watering = seconds_since_last_watering()
    if since_watering is not None and since_watering < RECENT_WATERING_SECONDS:
        advisories.append((
            "recently_watered",
            f"Watered {round(since_watering)}s ago - let the soil equalise before adding more water",
        ))

    # Tank running down while the soil is genuinely fine: save it for a real deficit
    if (
        state["water_tank_level"] is not None
        and state["water_tank_level"] <= LOW_TANK_THRESHOLD
        and state["soil_moisture"] >= threshold
    ):
        advisories.append((
            "conserve_water",
            f"Tank at {state['water_tank_level']}% but soil is {state['soil_moisture']}%, above the {target} "
            f"threshold - hold off non-essential watering",
        ))

    # Getting through far more water today than the days before it
    average, today_total = recent_daily_water_average()
    if average and today_total > average * OVERWATERING_MULTIPLIER:
        advisories.append((
            "overwatering",
            f"{round(today_total, 1)} L used today against a {round(average, 1)} L daily average - "
            f"check for overwatering or a stuck valve",
        ))

    # Drying far slower than this soil normally does - it can wait longer
    typical = typical_drying_rate()
    rate = forecast.get("rate_per_minute")
    if (
        typical
        and rate is not None
        and rate < 0
        and state["pump_status"] == "OFF"
        and abs(rate) < typical * SOIL_HOLDING_FRACTION
    ):
        advisories.append((
            "soil_holding",
            f"Drying at {abs(rate)} %/min, well under the usual {round(typical, 1)} %/min - "
            f"this can go longer than normal between waterings",
        ))

    return advisories


def detect_conditions(state, threshold, forecast):
    """Every condition worth an alert right now, faults first then advisories.

    A fault means something is broken. An advisory means the system is working
    but the grower may want to act differently - usually "don't water yet".
    """
    conditions = [
        {"type": fault_type, "severity": "fault", "message": message}
        for fault_type, message in detect_faults(state)
    ]

    # Water is flowing properly but the soil isn't responding: it is going
    # somewhere other than the root zone, which no single reading can show.
    seconds, rise = current_watering_progress()
    if (
        seconds is not None
        and seconds >= INEFFECTIVE_MIN_SECONDS
        and state["water_flow"] >= INEFFECTIVE_FLOW_MINIMUM
        and rise < INEFFECTIVE_MOISTURE_RISE
    ):
        conditions.append({
            "type": "ineffective_irrigation",
            "severity": "fault",
            "message": (
                f"Pump has run {round(seconds)}s at {state['water_flow']} L/min but soil moisture moved only "
                f"{round(rise, 1)}% - water may not be reaching the roots"
            ),
        })

    # The board has stopped reporting. Not derivable from a single reading -
    # it is about how old the newest one is.
    status = esp32_status()
    if status["offline"]:
        age = status["seconds_since"]
        ago = f"{round(age)}s" if age < 90 else _format_duration(age / 60)
        conditions.append({
            "type": "esp32_offline",
            "severity": "fault",
            "message": (
                f"No data from the ESP32 for {ago} - readings are frozen, water accounting "
                f"is paused and irrigation is held off until it reports again"
            ),
        })

    conditions += [
        {"type": advisory_type, "severity": "advisory", "message": message}
        for advisory_type, message in detect_advisories(state, threshold, forecast)
    ]
    return conditions


def fertigation_window(state, threshold, forecast):
    """Whether now is a sensible moment to apply liquid fertiliser, and why not if not.

    This is a TIMING check and nothing more. There is no EC, pH or NPK sensor
    on this system, so it has no idea what nutrients the crop actually needs
    and never pretends to - all it can say is whether current soil conditions
    would waste fertiliser or hurt the roots.

    To turn this into real nutrient advice, fit an EC/TDS probe, add a soil_ec
    column to sensor_readings, accept it in /api/sensor_data, and branch on the
    reading here. Until then "Good window" means "nothing about right now is
    obviously wrong", not "your crop needs feeding".
    """
    moisture = state["soil_moisture"]
    target = f"{_trim(threshold)}%"
    reasons = []

    if state["pump_status"] == "ON":
        reasons.append("irrigation is running - fertiliser would wash straight past the roots")

    if moisture <= threshold - FERTIGATION_DRY_MARGIN:
        reasons.append(
            f"soil is {moisture}%, well under the {target} threshold - feeding dry soil risks burning roots, water first"
        )

    if moisture >= threshold + FERTIGATION_WET_MARGIN:
        reasons.append(
            f"soil is {moisture}% and saturated - nutrients will leach below the root zone"
        )

    # About to irrigate anyway, which would flush a fresh application straight through
    minutes_ahead = forecast.get("minutes_to_threshold")
    if (
        forecast.get("state") == "drying"
        and minutes_ahead is not None
        and minutes_ahead <= FERTIGATION_IMMINENT_MINUTES
    ):
        due = "under a minute" if minutes_ahead < 1 else f"about {_format_duration(minutes_ahead)}"
        reasons.append(f"irrigation is due in {due} - it would flush a fresh application through")

    note = "Timing only - no nutrient sensor fitted, so this says nothing about what the crop actually needs."

    if reasons:
        return {"ok": False, "headline": "Hold off", "reasons": reasons, "note": note}

    return {
        "ok": True,
        "headline": "Good window",
        "reasons": [f"soil is {moisture}% near the {target} threshold, with no irrigation running or imminent"],
        "note": note,
    }


def compute_commanded_pump():
    """The simple irrigation rule, shared by the simulator and the ESP32's /api/pump_command poll.

    If soil moisture is below the growth stage's threshold -> pump ON.
    Once soil moisture reaches the threshold -> pump OFF.
    In manual mode, the dashboard's pump button decides instead of the threshold.
    """
    # No fresh data means the moisture reading is frozen at whatever it was
    # when the board went quiet. Refuse to irrigate on it - the ESP32's own
    # COMMAND_TIMEOUT failsafe would shut the pump off anyway, but only after
    # its own delay, and only if it is still awake enough to notice.
    if readings_are_stale():
        return False

    threshold = get_moisture_threshold(current_growth_stage)
    should_irrigate = current_state["soil_moisture"] < threshold
    return should_irrigate if auto_mode else manual_pump_on


def simulator_loop():
    """Background thread: every few seconds, apply irrigation logic to the
    current reading, and (while simulator_enabled) generate that reading too.

    Once an ESP32 starts posting real data to /api/sensor_data,
    simulator_enabled switches off and this loop stops inventing readings -
    it just keeps running irrigation logic, water usage, alerts, and AI
    predictions on top of whatever the ESP32 last reported.

    Also handles Stage 4: turning flow readings into water usage totals, and
    running the leak/blockage/low-tank detection rules every tick.
    """
    global current_state, irrigation_session_liters, irrigation_session_start
    previous_pump_status = current_state["pump_status"]

    while True:
        # One bad tick must not kill irrigation, water accounting and alerts
        # for the rest of the run. A crash here used to take the whole thread
        # down silently while the dashboard carried on showing stale values.
        try:
            if simulator_enabled:
                # A three-sensor board leaves soil_temperature and water_tank_level
                # as None. The simulator does arithmetic on every field, so switching
                # back to it from such a board used to kill this thread outright with
                # "None + float". Restore its own defaults for anything the hardware
                # could not measure.
                for field in OPTIONAL_SENSOR_FIELDS:
                    if current_state.get(field) is None:
                        current_state[field] = INITIAL_STATE[field]

                commanded_pump_on = compute_commanded_pump()
                current_state = generate_reading(current_state, current_scenario, commanded_pump_on)
                current_state["growth_stage"] = current_growth_stage
                save_reading(current_state)

            # WATER USAGE: this tick's flow, turned into liters, is water used
            # (or lost, if it's a leak) regardless of why the pump is in its
            # current state - the flow sensor doesn't know or care why.
            # (When an ESP32 is the data source, have it POST roughly every
            # SIMULATOR_INTERVAL_SECONDS too, so this stays accurate - otherwise
            # a stale flow reading gets reused for ticks between real posts.)
            # A silent ESP32 leaves current_state frozen, so reusing its last flow
            # reading would bill water forever from a sensor that stopped
            # reporting - 2.6 L/min of phantom usage is 3,744 L a day.
            if readings_are_stale():
                tick_liters = 0.0
            else:
                tick_liters = round(current_state["water_flow"] * (SIMULATOR_INTERVAL_SECONDS / 60), 3)
                add_water_usage(tick_liters)

            # CONDITIONS: hardware faults plus advisories ("don't water yet"). Each
            # type gets at most one open row - written when it starts, resolved when
            # it clears - instead of a new row every tick while it persists. Several
            # can be open at once now, so a leak no longer hides a low tank.
            threshold = get_moisture_threshold(current_growth_stage)
            forecast = estimate_moisture_forecast(threshold)
            conditions = detect_conditions(current_state, threshold, forecast)
            current_types = {condition["type"] for condition in conditions}

            for condition_type in list(active_alerts):
                if condition_type not in current_types:
                    resolve_alert(active_alerts.pop(condition_type))

            for condition in conditions:
                if condition["type"] not in active_alerts:
                    active_alerts[condition["type"]] = create_alert(
                        condition["type"], condition["message"], condition["severity"]
                    )

            # AI PREDICTION: was the plant watered on the previous tick? (the
            # model was trained on this as "previous_watering")
            previous_watering = 1 if previous_pump_status == "ON" else 0
            label, confidence = predict_irrigation_need(current_state, current_growth_stage, previous_watering)
            if label is not None:
                save_ai_prediction(label, confidence)

            # Log the moment the pump switches on or off, and why
            if current_state["pump_status"] != previous_pump_status:
                action = "PUMP_ON" if current_state["pump_status"] == "ON" else "PUMP_OFF"
                if current_scenario in FORCED_SCENARIOS:
                    reason = f"Scenario override: {current_scenario}"
                elif auto_mode:
                    reason = "Soil moisture below threshold" if action == "PUMP_ON" else "Soil moisture reached threshold"
                else:
                    reason = "Manual control"

                if action == "PUMP_ON":
                    irrigation_session_liters = 0.0
                    irrigation_session_start = time.time()
                    log_irrigation_event(action, reason)
                else:
                    duration = round(time.time() - irrigation_session_start, 1) if irrigation_session_start else None
                    log_irrigation_event(action, reason, duration, round(irrigation_session_liters, 3))
                    irrigation_session_start = None

                previous_pump_status = current_state["pump_status"]

            # Water used per irrigation: keep a running total for the session in progress
            if current_state["pump_status"] == "ON":
                irrigation_session_liters += tick_liters

        except Exception:
            print("Error in simulator_loop tick - continuing:")
            traceback.print_exc()

        time.sleep(SIMULATOR_INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Page route
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.route("/api/latest")
def api_latest():
    """Return the most recent sensor reading (or a 'no data yet' message)."""
    db = get_db()
    row = db.execute(
        "SELECT * FROM sensor_readings ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if row is None:
        return jsonify({"has_data": False, "message": "No sensor data yet. Simulator not started."})

    return jsonify({"has_data": True, "reading": dict(row)})


@app.route("/api/growth_stages", methods=["GET", "POST"])
def api_growth_stages():
    """GET: list every growth stage's moisture threshold.
    POST: update one stage's threshold, e.g. {"stage_name": "Seedling", "moisture_threshold": 65}.
    """
    db = get_db()

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        stage_name = data.get("stage_name")
        threshold = data.get("moisture_threshold")
        if stage_name is None or threshold is None:
            return jsonify({"error": "stage_name and moisture_threshold are required"}), 400
        db.execute(
            "UPDATE growth_stages SET moisture_threshold = ? WHERE stage_name = ?",
            (threshold, stage_name),
        )
        db.commit()

    rows = db.execute("SELECT stage_name, moisture_threshold FROM growth_stages").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/growth_stage", methods=["GET", "POST"])
def api_growth_stage():
    """Get or set which growth stage is currently active (drives the moisture threshold used)."""
    global current_growth_stage

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        stage = data.get("growth_stage")
        valid_stages = [r["stage_name"] for r in get_db().execute("SELECT stage_name FROM growth_stages").fetchall()]
        if stage not in valid_stages:
            return jsonify({"error": "Unknown growth stage", "valid_stages": valid_stages}), 400
        current_growth_stage = stage

    return jsonify({"growth_stage": current_growth_stage})


@app.route("/api/auto_mode", methods=["GET", "POST"])
def api_auto_mode():
    """Get or set whether the automatic irrigation controller is enabled."""
    global auto_mode

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        auto_mode = bool(data.get("auto_mode", auto_mode))

    return jsonify({"auto_mode": auto_mode})


@app.route("/api/pump", methods=["POST"])
def api_pump():
    """Manually turn the pump on/off. Only takes effect while auto_mode is off."""
    global manual_pump_on

    if auto_mode:
        return jsonify({"error": "Turn off automatic irrigation before controlling the pump manually"}), 400

    data = request.get_json(silent=True) or {}
    manual_pump_on = bool(data.get("pump_on", False))
    return jsonify({"manual_pump_on": manual_pump_on})


@app.route("/api/status")
def api_status():
    """Everything the dashboard's irrigation control panel needs, in one call.

    "recommendation" answers "does it need water right now?" from the current
    reading alone; "forecast" answers "how long until it does?" by measuring
    the drying rate across the stored sensor history (Stage 7).
    """
    threshold = get_moisture_threshold(current_growth_stage)
    forecast = estimate_moisture_forecast(threshold)
    recommendation = "Irrigate" if current_state["soil_moisture"] < threshold else "OK"
    return jsonify(
        {
            "growth_stage": current_growth_stage,
            "moisture_threshold": threshold,
            "recommendation": recommendation,
            "forecast": forecast,
            "fertigation": fertigation_window(current_state, threshold, forecast),
            "auto_mode": auto_mode,
            "manual_pump_on": manual_pump_on,
        }
    )


@app.route("/api/scenario", methods=["GET", "POST"])
def api_scenario():
    """Get or set which scenario the simulator is currently generating."""
    global current_scenario

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        scenario = data.get("scenario")
        if scenario not in SCENARIOS:
            return jsonify({"error": "Unknown scenario", "valid_scenarios": SCENARIOS}), 400
        current_scenario = scenario

    return jsonify({"scenario": current_scenario, "valid_scenarios": SCENARIOS})


@app.route("/api/water_usage")
def api_water_usage():
    """Return today's water usage total (0 if nothing logged yet)."""
    db = get_db()
    today = date.today().isoformat()
    row = db.execute(
        "SELECT daily_total_liters, total_liters FROM water_usage WHERE date = ?",
        (today,),
    ).fetchone()

    if row is None:
        return jsonify({"date": today, "daily_total_liters": 0, "total_liters": 0})

    return jsonify({"date": today, **dict(row)})


@app.route("/api/alerts")
def api_alerts():
    """Return every open alert - faults first, then advisories, newest first within each."""
    db = get_db()
    rows = db.execute(
        """
        SELECT id, timestamp, alert_type, severity, message FROM alerts WHERE resolved = 0
        ORDER BY CASE severity WHEN 'fault' THEN 0 ELSE 1 END, id DESC
        """
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/irrigation_events")
def api_irrigation_events():
    """Return the most recent irrigation (pump ON/OFF) events, newest first."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM irrigation_events ORDER BY id DESC LIMIT 10"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/ai_prediction")
def api_ai_prediction():
    """Return the most recent AI prediction, or an explanation if none is available."""
    if ml_model is None:
        return jsonify({"available": False, "message": "Model not trained yet. Run: python ml/train_model.py"})

    db = get_db()

    # A three-sensor board posts no soil temperature, which the trained
    # model needs. Without this check the dashboard would keep showing the
    # last simulator-era prediction as though it were current.
    latest = db.execute(
        "SELECT soil_temperature FROM sensor_readings ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if latest is not None and latest["soil_temperature"] is None:
        return jsonify({
            "available": False,
            "message": "Model needs soil temperature, which this board doesn't measure. Retrain without it.",
        })

    row = db.execute(
        "SELECT prediction, confidence, timestamp FROM ai_predictions ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return jsonify({"available": False, "message": "No predictions yet."})

    return jsonify({"available": True, **dict(row)})


@app.route("/api/history")
def api_history():
    """Return recent sensor readings, oldest first, for the dashboard charts."""
    limit = request.args.get("limit", 30, type=int)
    db = get_db()
    rows = db.execute(
        """
        SELECT timestamp, soil_moisture, soil_temperature, air_temperature, humidity, water_flow, water_tank_level
        FROM sensor_readings ORDER BY id DESC LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return jsonify([dict(r) for r in reversed(rows)])


@app.route("/api/sensor_data", methods=["POST"])
def api_sensor_data():
    """Stage 6: where a real ESP32 posts its sensor readings instead of the simulator.

    Required: soil_moisture, air_temperature, humidity, water_flow
    (numbers) and pump_status ("ON" or "OFF" - whatever the ESP32's relay
    is currently doing).

    Optional: soil_temperature and water_tank_level. A board built with
    only a moisture probe, a DHT and a flow meter has no way to measure
    either, so it omits them and they are stored as NULL. Features that
    need them (the low-tank alert, the AI prediction) report themselves
    unavailable rather than running on a placeholder number.

    See ../esp32-irrigation-sensor/ for the sketch that posts this.
    """
    global current_state, simulator_enabled

    data = request.get_json(silent=True) or {}
    missing = [f for f in REQUIRED_SENSOR_FIELDS if f not in data]
    if missing:
        return jsonify({"error": f"Missing fields: {missing}"}), 400

    global esp32_last_seen, esp32_address
    simulator_enabled = False  # real data has started arriving - stop inventing readings
    esp32_last_seen = time.time()
    esp32_address = request.remote_addr

    current_state = {field: data[field] for field in REQUIRED_SENSOR_FIELDS}
    # A board without these sensors posts without them, and everything
    # downstream treats None as "no sensor" rather than inventing a value
    for field in OPTIONAL_SENSOR_FIELDS:
        current_state[field] = data.get(field)
    current_state["growth_stage"] = current_growth_stage
    save_reading(current_state)

    return jsonify({"status": "ok"})


@app.route("/api/pump_command")
def api_pump_command():
    """What the ESP32 should currently do with its pump relay.

    The ESP32 sketch polls this after posting a reading, so the same
    threshold-based irrigation logic that drives the simulator also
    drives the real pump.
    """
    return jsonify({"pump_on": compute_commanded_pump()})


def esp32_status():
    """Whether a real board is posting, and how long since it last did.

    "offline" only means something while the ESP32 is the active source -
    with the simulator running there is no board to be offline.
    """
    if esp32_last_seen is None:
        return {"seen": False, "address": None, "seconds_since": None, "offline": False}

    seconds_since = round(time.time() - esp32_last_seen, 1)
    return {
        "seen": True,
        "address": esp32_address,
        "seconds_since": seconds_since,
        "offline": (not simulator_enabled) and seconds_since > ESP32_OFFLINE_SECONDS,
    }


def readings_are_stale():
    """True when the newest reading is too old to act on.

    Only ever true for a silent ESP32: while the simulator runs it generates
    a fresh reading every tick by definition.
    """
    return esp32_status()["offline"]


@app.route("/api/data_source", methods=["GET", "POST"])
def api_data_source():
    """Get or set whether the simulator or a real ESP32 is the active data source."""
    global simulator_enabled

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        simulator_enabled = bool(data.get("simulator_enabled", simulator_enabled))

    return jsonify(
        {
            "simulator_enabled": simulator_enabled,
            "source": "simulator" if simulator_enabled else "esp32",
            "esp32": esp32_status(),
        }
    )


if __name__ == "__main__":
    init_db()
    resolve_orphaned_alerts()
    load_ml_model()

    # Start the simulator in the background so readings keep flowing while
    # the dashboard is open. use_reloader=False keeps this to one process -
    # otherwise Flask's debug reloader would start two simulator threads.
    threading.Thread(target=simulator_loop, daemon=True).start()

    # host="0.0.0.0" makes the server reachable from other devices on the
    # same WiFi network (like an ESP32) - not just from this computer.
    # Port 5001, not 5000: on macOS, AirPlay Receiver permanently occupies
    # port 5000, which would otherwise block both local testing and the
    # ESP32 from ever reaching this server.
    app.run(host="0.0.0.0", port=5001, debug=True, use_reloader=False)
