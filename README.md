# Smart Irrigation System (School Project)

An AI-assisted smart irrigation system built with Flask, SQLite, and a plain
HTML/CSS/JS dashboard. Designed to run fully in software first (simulated
sensors), then connect to a real ESP32 later.

*Explaining or presenting this project? See [HOW_IT_WORKS.md](HOW_IT_WORKS.md)
for a file-by-file walkthrough, how the AI model works, and how ESP32
integration works. On Windows? See [WINDOWS_SETUP.md](WINDOWS_SETUP.md).*

## Project status: Stage 6 complete (all stages done)

**Stage 1** set up the foundation:

- Flask web server (`app.py`)
- SQLite database (`database.db`) with all tables the project will use:
  `sensor_readings`, `irrigation_events`, `water_usage`, `growth_stages`,
  `alerts`, `ai_predictions`
- A basic dashboard (`templates/index.html` + `static/style.css` +
  `static/script.js`) that displays sensor cards, the growth-stage
  threshold table, and a water usage summary
- The `growth_stages` table is pre-filled with default moisture thresholds
  for Seedling, Vegetative, Flowering, and Fruiting

**Stage 2** added simulated sensors, so the whole project works without
any hardware:

- `simulator/sensor_simulator.py` — pure functions that generate one new
  sensor reading from the previous one, for six scenarios: `normal`,
  `dry_soil`, `irrigation`, `low_tank`, `leak`, `abnormal_flow`. Can be
  run standalone (`python simulator/sensor_simulator.py`) to print sample
  readings for every scenario.
- `app.py` runs the simulator on a background thread, generating a new
  reading every 5 seconds and saving it to `sensor_readings`.
- New `/api/scenario` endpoint (GET current scenario, POST to switch it).
- The dashboard has buttons to switch scenarios live, and now shows real,
  changing sensor values instead of `--` placeholders.

**Stage 3** added the automatic irrigation controller and made growth-stage
thresholds actually drive the pump:

- Simple rule in `simulator_loop()` (`app.py`): if soil moisture is below
  the active growth stage's threshold, the pump turns ON; once moisture
  reaches the threshold, it turns OFF. Runs every simulator tick (5s).
- New "Irrigation Control" panel on the dashboard: pick the active growth
  stage, toggle Automatic/Manual irrigation, and (in manual mode) a button
  to turn the pump on/off yourself.
- The growth-stage threshold table is now editable — type a new value and
  click Save to update it in SQLite immediately.
- Every pump ON/OFF transition is logged to `irrigation_events` with a
  reason (e.g. "Soil moisture below threshold", "Manual control", or
  "Scenario override: leak" for the forced demo scenarios).
- New endpoints: `/api/status` (threshold, recommendation, mode, pump),
  `/api/growth_stage` (active stage), `/api/auto_mode`, `/api/pump`, and
  `/api/growth_stages` now also accepts POST to edit a threshold.

Note: the `irrigation`, `leak`, and `abnormal_flow` scenarios still force
the pump directly (so you can demo those specific situations on demand);
only `normal`, `dry_soil`, and `low_tank` are driven by the automatic
controller described above.

**Stage 4** added water usage tracking and leak detection:

- Every simulator tick, the current water-flow reading (L/min) is converted
  to liters used that tick and added to `water_usage` (both today's total
  and the all-time running total), regardless of *why* water is flowing -
  a flow sensor can't tell normal irrigation from a leak.
- Water used per irrigation cycle is tracked while the pump is ON and
  logged onto the matching `PUMP_OFF` row in `irrigation_events`, along
  with how long that cycle ran (`duration_seconds`).
- Simple leak-detection rules run every tick: pump OFF + flow detected ->
  possible leak; pump ON + almost no flow -> possible blockage/pump
  problem; tank level at/below 15% -> low tank. Each condition opens one
  alert when it starts and resolves it once it clears, instead of
  spamming a new row every 5 seconds.
- New dashboard panels: "Water Usage" (today + all-time totals), "Alerts"
  (now live, color-coded by severity), and "Recent Irrigation Events"
  (action, reason, duration, water used per cycle).
- New endpoints: `/api/alerts` (unresolved alerts) and
  `/api/irrigation_events` (last 10 pump events).

**Stage 5** added the AI prediction, using scikit-learn:

- `ml/train_model.py` generates a small *simulated* dataset (600 rows -
  there's no real ESP32 history yet), using a simple rule: hotter/drier
  air dries soil out faster, and recent watering offsets that. It one-hot
  encodes growth stage, trains a `RandomForestClassifier` (50 trees, max
  depth 5) to predict `will_need_irrigation`, prints an accuracy/
  classification report, and saves the model to `ml/model.pkl`. Run it
  any time you want to retrain: `python ml/train_model.py`.
- `app.py` loads `model.pkl` at startup and, every simulator tick,
  predicts whether irrigation will likely be needed soon from the current
  soil moisture, soil/air temperature, humidity, growth stage, and
  whether the plant was watered on the previous tick. Predictions are
  saved to `ai_predictions` and shown live on the "AI Prediction" card.
- If `model.pkl` doesn't exist yet, the app still runs fine - the AI
  Prediction card just shows "Not available" until you train one.
- New endpoint: `/api/ai_prediction` (latest prediction + confidence %).

**Stage 6** prepared the system for a real ESP32, and the dashboard got a
full visual redesign:

- New standalone project, `../esp32-irrigation-sensor/` (a sibling folder
  to this one, since it's opened in Arduino IDE rather than a code
  editor) — an example Arduino sketch showing how a real ESP32 would
  read its sensors, `POST` them to `/api/sensor_data`, then
  `GET /api/pump_command` and drive a relay from the response. Uses
  placeholder pins/sensor reads (real wiring isn't connected yet), but
  the JSON contract is real and works today. See that folder's own
  README for wiring, parts list, and setup steps.
- `POST /api/sensor_data`: where real readings arrive. The moment one
  comes in, the background simulator automatically stops inventing
  readings (`simulator_enabled` flips off) so simulated and real data
  never mix. `GET /api/pump_command` and `GET/POST /api/data_source`
  (switch back to the simulator, e.g. for a demo without hardware) round
  out the integration.
- The irrigation-logic/water-usage/leak-detection/AI-prediction loop in
  `simulator_loop()` now runs on *whatever* the current reading is,
  whether that reading came from the simulator or the last ESP32 POST -
  none of that logic needed to change to support real hardware.
- **Dashboard redesign**: a dark sidebar with anchor navigation, a
  top summary row (pump power-button control, active-alerts count,
  growth stage, AI prediction), animated semicircle gauges for soil
  moisture and tank level (colored red when a threshold/leak condition
  is crossed), and three live line charts (soil moisture, temperature,
  water flow) via Chart.js, fed by the new `GET /api/history` endpoint.
  The old separate "manual pump" button was folded into the power-button
  control itself (click it while in manual mode to toggle the pump).

## How to run it

*(On Windows? See [WINDOWS_SETUP.md](WINDOWS_SETUP.md) instead - same steps, Windows-specific commands.)*

1. **Open a terminal in the `smart-irrigation` folder.**

2. **(Recommended) Create and activate a virtual environment:**

   ```bash
   python3 -m venv venv
   source venv/bin/activate      # on Windows: venv\Scripts\activate
   ```

3. **Install the dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

4. **Train the AI model (only needs to be done once, or whenever you want to retrain):**

   ```bash
   python ml/train_model.py
   ```

   This prints a test accuracy and classification report, and saves
   `ml/model.pkl`. If you skip this step, the app still runs fine - the
   AI Prediction card just shows "Not available".

5. **Run the app:**

   ```bash
   python app.py
   ```

   The first time you run it, `init_db()` creates `database.db` and fills
   in the default growth-stage thresholds. It listens on port 5001, not
   the more common 5000 - on macOS, AirPlay Receiver permanently occupies
   port 5000, which would otherwise block the app (and later, the ESP32)
   from ever reaching it.

6. **Open the dashboard in your browser:**

   ```
   http://127.0.0.1:5001
   ```

   Within a few seconds the gauges and stat cards should fill in with
   live values and the "Live" badge should turn green — that's the
   background simulator writing readings to SQLite every 5 seconds. Use
   the sidebar to jump between sections. Try the scenario buttons under
   "Simulator" (Dry Soil, Irrigation, Water Leak, etc.) to see the
   values, gauges, and charts respond.

   To see automatic irrigation in action: click "Dry Soil", leave
   "Automatic irrigation" checked (under "Irrigation Control"), and watch
   the Pump Control power button light up green (ON) once the Soil
   Moisture gauge drops below the Moisture Threshold shown for the
   current growth stage - then back off once it recovers.

   To control the pump yourself: uncheck "Automatic irrigation" - the
   Pump Control button becomes clickable, so you can turn it on/off by
   hand.

   To see leak detection in action: click "Water Leak" and watch the
   Active Alerts card turn red within 5 seconds; click "Normal Soil" and
   watch it clear. Try "Abnormal Flow" the same way to see a blockage
   alert instead.

   To see the AI prediction respond: click "Dry Soil", turn off
   "Automatic irrigation" (so the pump stays off and can't mask the
   trend), and watch the AI Prediction card move from "Moisture OK"
   toward "Irrigation likely needed soon" with rising confidence as soil
   moisture drops.

7. **(Optional) Connect a real ESP32:** see `../esp32-irrigation-sensor/README.md`
   for the full wiring + Arduino IDE setup walkthrough. In short: fill in
   your WiFi credentials and this computer's local IP address in the
   sketch, swap in real sensor code for your hardware, and flash it. The
   moment it starts posting, the "ESP32 (Stage 6)" section and the
   top-right badge here will show "Source: ESP32 (Live)" automatically.
   Use the "Switch back to Simulator" button there to go back to
   software-only mode.

## Project structure

```
Development/
├── smart-irrigation/                       (this project - the software side)
│   ├── app.py                              Flask app: routes, simulator loop, irrigation/leak/AI logic
│   ├── database.db                         SQLite database (created on first run)
│   ├── requirements.txt
│   ├── templates/index.html                Dashboard page
│   ├── static/style.css                    Dashboard styling
│   ├── static/script.js                    Dashboard frontend logic (polling, gauges, charts, controls)
│   ├── ml/train_model.py                   Generates training data, trains + saves the model
│   ├── ml/model.pkl                        Trained model (created by train_model.py)
│   ├── simulator/sensor_simulator.py       Simulated sensor reading generator
│   └── README.md                           (this file)
│
└── esp32-irrigation-sensor/                (a separate project - the ESP32/hardware side, Stage 6)
    ├── irrigation_sensor/irrigation_sensor.ino   Arduino sketch, open this folder in Arduino IDE
    └── README.md                           Wiring, parts list, Arduino IDE setup steps
```
