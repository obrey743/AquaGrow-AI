# How It Works

This explains what every file does, how the pieces fit together, exactly
how the AI model is used, and how to connect a real ESP32. Useful as
prep notes for a presentation, or just to remind yourself what you built.

## The big picture

```
 ESP32 (optional)  --POST reading-->                 <-- reads/writes --   database.db
                    <--GET pump cmd--   app.py (Flask)  ------------->    (SQLite)
 Browser dashboard <--- HTML/JSON --->                 --- loads -------> ml/model.pkl
```

One Flask process (`app.py`) does everything server-side: serves the
dashboard page, answers its API calls, runs a background thread that
either simulates sensor data or reacts to real ESP32 data, and applies
the irrigation/leak/AI logic every 5 seconds. Everything is stored in
one SQLite file so it's easy to inspect (`sqlite3 database.db`) or wipe
clean (delete the file, restart the app).

## File-by-file

### `app.py` - the server and all the logic

This is the one file that ties the whole project together. Reading it
top to bottom:

- **Database helpers** (`get_db`, `init_db`) - `init_db()` creates all
  six tables the first time the app runs, and seeds default moisture
  thresholds per growth stage.
- **Simulator + water/alerts/ML helpers** (`save_reading`,
  `get_moisture_threshold`, `log_irrigation_event`, `add_water_usage`,
  `detect_alert`, `create_alert`/`resolve_alert`, `load_ml_model`,
  `predict_irrigation_need`, `save_ai_prediction`,
  `compute_commanded_pump`) - small, single-purpose functions the main
  loop calls.
- **`simulator_loop()`** - the heart of the app. Runs forever on a
  background thread, once every 5 seconds:
  1. If the simulator is the active data source, generates a new fake
     reading and saves it (skipped entirely once a real ESP32 takes
     over - see below).
  2. Turns the current water-flow reading into liters used, adding it
     to today's/all-time totals.
  3. Checks the leak-detection rules and opens/resolves an alert.
  4. Asks the trained AI model for a prediction and logs it.
  5. If the pump just switched on or off, logs why (threshold reached,
     manual control, or a forced demo scenario) and how much water that
     cycle used.
- **API routes** (`@app.route(...)`) - one function per endpoint the
  dashboard (or an ESP32) calls. Grouped by what they're for:
  sensor data (`/api/latest`, `/api/history`), irrigation control
  (`/api/status`, `/api/growth_stage(s)`, `/api/auto_mode`, `/api/pump`),
  the demo simulator (`/api/scenario`), water/alerts
  (`/api/water_usage`, `/api/alerts`, `/api/irrigation_events`), AI
  (`/api/ai_prediction`), and ESP32 integration (`/api/sensor_data`,
  `/api/pump_command`, `/api/data_source`).
- **`if __name__ == "__main__":`** - on startup: create the database,
  load the trained model (if one exists), start the background thread,
  then run the Flask server on `0.0.0.0:5001` (reachable from other
  devices on the network, not just this computer).

### `database.db` - the data

A SQLite file, created automatically by `init_db()`. Six tables:

| Table | What it stores |
|---|---|
| `sensor_readings` | Every reading (real or simulated): moisture, temperature, humidity, tank level, flow, pump status, growth stage, timestamp |
| `irrigation_events` | Every pump ON/OFF, why, how long it ran, how much water it used |
| `water_usage` | One row per day: that day's total liters, and the running all-time total |
| `growth_stages` | The 4 growth stages and their configurable moisture thresholds |
| `alerts` | Leak/blockage/low-tank alerts, with a `resolved` flag |
| `ai_predictions` | Every prediction the ML model made, with its confidence |

You can open it directly to poke around: `sqlite3 database.db` then
`.tables`, or `SELECT * FROM sensor_readings ORDER BY id DESC LIMIT 5;`.

### `requirements.txt` - dependencies

- **Flask** - the web server framework serving the dashboard and API.
- **pandas** - builds the labeled training table in `ml/train_model.py`,
  and the one-row DataFrame `app.py` feeds the model at prediction time.
- **numpy** - pandas/scikit-learn both depend on it directly.
- **scikit-learn** - trains and runs the Random Forest classifier.

### `templates/index.html` - the dashboard page structure

The app shell: a sidebar grouped into Main / Irrigation / Crop / System,
a top bar (page title, ESP32 connection indicator, notifications), and
one `<section class="view">` per page - Overview, Farm Monitor,
Analytics, AI Insights, Irrigation Control, Water Tank, Irrigation
Zones, Growth Stages, Crop Health, Sensor Data, Simulator, ESP32,
Events & Alerts and Settings. Pages switch by URL hash (`#/irrigation`)
with no reload, and the old anchors (`#control`, `#simulate`...) still
land on the right page.

Each page is mostly placeholders like `<div data-component="metric"
data-metric="humidity">` - the HTML says *where* a component goes and
JavaScript builds it. The HTML itself holds no live data.

### `static/style.css` - all the visual styling

Laid out like an engineering monitoring console rather than a web
dashboard: one neutral canvas with no boxes or decorative borders.
Hierarchy comes from type size and spacing; hairline dividers appear only
between list/table rows and between major page rows. Typeface is Outfit.
The palette comes from the field - forest-green sidebar, warm sage-grey
canvas, sand soil, muted water blue - and colour always means something:
green healthy/optimal, amber waiting/warning, red critical, blue
water/information. Each measurement keeps one colour in every chart
(`--m-<metric>` tokens in the stylesheet). Design tokens at the top, then
the shell, status indicators, and one block per component. Responsive down to
phone width: the sidebar becomes a slide-out drawer under 1024px and the
grids collapse to one column. Animations respect
`prefers-reduced-motion`.

### `static/script.js` + `static/js/` - the dashboard's brain

- **`script.js`** - entry point. Polls every endpoint every 5 seconds
  (`/api/latest`, `/api/status`, `/api/data_source`,
  `/api/growth_stages`, `/api/water_usage`, `/api/alerts`,
  `/api/irrigation_events`, `/api/ai_prediction`, `/api/scenario`),
  mounts the components, and handles routing, the mobile menu and the
  notifications popover.
- **`js/api.js`** - every control the dashboard sends back (`POST`s to
  growth stage, thresholds, auto mode, pump, scenario, data source).
  Same endpoints and payloads as before the redesign.
- **`js/model.js`** - turns the raw responses into what every card
  shows: moisture status against the stage's optimal range (threshold
  to threshold +15%, the backend's saturation margin), the connection
  state (Connected / Offline / Waiting / Simulation), the AI summary,
  the next irrigation time (from the backend's measured forecast), and
  the alert list. A missing reading stays missing - nothing is invented.
- **`js/components.js`** - the reusable components (process schematic,
  metric tile, soil moisture, AI advisory, irrigation control, water
  tank, alarms, growth lifecycle...). The Overview's process schematic
  draws tank -> pump -> flow meter -> field with live values. Pipes stay
  neutral grey and animate only while water is actually flowing; faults
  ("pump on, no flow", "flow with pump off" - the backend's 0.3 L/min
  leak/blockage limit) show as status on the flow meter. Each builds its DOM once and updates in place,
  so one component can appear on several pages.
- **`js/charts.js`** - the Environmental Overview chart (Chart.js) with
  metric tabs and 6H/24H/7D/30D ranges. `/api/history` only takes a row
  limit, so it fetches enough rows once, then only the newest each poll,
  and averages long ranges down. Gaps in the data stay gaps.

Two settings live only in the browser (Settings page): the tank's
capacity in litres (to turn tank % into an estimate) and the default
chart range.

### `simulator/sensor_simulator.py` - fake sensor data generator

Pure functions, no Flask/database code, so they're easy to test on
their own (`python simulator/sensor_simulator.py` prints sample
readings). `generate_reading()` nudges the previous reading a small step
in whatever direction the active scenario implies - `dry_soil` dries
faster than `normal`, `leak` shows flow with the pump off, etc. Six
scenarios total, matching the dashboard's scenario buttons.

### `ml/train_model.py` and `ml/model.pkl` - see "How AI is used" below.

### `esp32-irrigation-sensor/` - the hardware side (separate project)

Lives as a sibling folder to `AquaGrow-AI/`, not inside it, because
it's opened in Arduino IDE rather than a code editor. See "Connecting a
real ESP32" below.

## How AI is used

There are actually **two separate decision-making systems** in this
project, and it's worth keeping them straight (this is a common
point of confusion when presenting):

### 1. The irrigation controller (rule-based, not AI)

The thing that actually turns the pump on and off is a simple rule in
`compute_commanded_pump()`:

> if soil moisture < the active growth stage's threshold → pump ON,
> otherwise → pump OFF.

This is deterministic and explainable - exactly what the project spec
asked for ("start with simple rules"). It doesn't use the ML model at
all.

### 2. The AI Prediction card (machine learning)

This is a separate, *predictive* layer that runs alongside the
controller, shown on its own dashboard card - it doesn't control
anything. It answers a forward-looking question the simple threshold
rule can't: **"is this plant trending toward needing water soon, given
everything we know right now?"**

**Training** (`ml/train_model.py`, run manually, produces `ml/model.pkl`):

1. Generates 600 rows of *simulated* training data (no real ESP32
   history exists yet). Each row picks random but realistic values for
   soil moisture, soil/air temperature, humidity, growth stage, and
   whether the plant was recently watered.
2. Labels each row using a simple physical rule: hotter + drier air
   dries soil out faster (`dry_pressure`); recent watering offsets that.
   If the *projected* moisture (current moisture minus that drying
   pressure, plus a boost if just watered) would fall below the growth
   stage's threshold, the row is labeled "will need irrigation soon."
   5% of labels are randomly flipped, since real-world conditions are
   never perfectly predictable.
3. One-hot encodes `growth_stage` into four 0/1 columns, splits the data
   80/20 into train/test sets.
4. Trains a **`RandomForestClassifier`** (50 small decision trees, max
   depth 5 each) - deliberately simple, per the project spec ("do not
   use deep learning or complicated AI"). A random forest is just many
   small decision trees voting; each tree learns something like "if
   moisture is low AND it wasn't watered recently AND air is hot, this
   is at risk" - easy to explain in a presentation.
5. Prints a test accuracy (currently **~82%**) and saves the trained
   model, together with the exact list of feature columns it expects, to
   `ml/model.pkl` (via `pickle`).

**Using it live** (`app.py`, every 5-second tick):

`predict_irrigation_need()` builds one row from the current sensor
reading, the active growth stage, and whether the pump was on the
previous tick, runs it through the loaded model, and gets back a
predicted class (0 or 1) plus a confidence percentage
(`model.predict_proba()`). That becomes the "AI Prediction" card's text,
e.g. *"Irrigation likely needed soon (84.3%)"*, and is logged to
`ai_predictions` so there's a history of what the model has said over
time.

If `ml/model.pkl` doesn't exist (you haven't run the training script
yet), `app.py` handles that gracefully - the card just shows "Not
available" instead of crashing.

## Connecting a real ESP32

Full wiring/parts-list/Arduino-IDE walkthrough lives in
`../esp32-irrigation-sensor/README.md` - this is the short version:

1. **Wire up real sensors** to an ESP32 (soil moisture, soil temp, air
   temp/humidity, tank level, flow meter, and a relay for the pump).
2. **Open `esp32-irrigation-sensor/irrigation_sensor/` in Arduino IDE**,
   install the ESP32 board package and the `ArduinoJson` library.
3. **Edit the sketch**: fill in your WiFi name/password, and this
   computer's local network IP as `SERVER_HOST` (find it with
   `ipconfig getifaddr en0` on Mac, or `ipconfig` on Windows - see
   `WINDOWS_SETUP.md`).
4. **Upload it**, then open the Serial Monitor (115200 baud) to confirm
   it connects to WiFi and starts posting successfully.
5. Every 5 seconds, the sketch:
   - Reads its sensors and `POST`s them as JSON to
     `http://<SERVER_HOST>:5001/api/sensor_data`. The instant this
     arrives, `app.py` flips `simulator_enabled` off - the background
     simulator stops inventing readings, and everything downstream
     (irrigation logic, water usage, leak detection, the AI prediction)
     now runs on the ESP32's real numbers instead.
   - `GET`s `http://<SERVER_HOST>:5001/api/pump_command`, which replies
     with the same threshold-based decision described above, and
     switches its relay to match - so the real pump is driven by the
     exact same logic the simulator was using.
6. On the dashboard, the "Source" badge (top-right) and the ESP32
   section both switch to **"ESP32 (Live)"** automatically. Click
   "Switch back to Simulator" there any time to go back to software-only
   demo mode (e.g. if you want to demo the project without the hardware
   plugged in).
