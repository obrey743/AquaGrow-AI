"""
Sensor Simulator (Stage 2)

Generates realistic-looking sensor readings without any real hardware.
This lets the whole project (dashboard, irrigation logic, ML model) be
built and demoed before the ESP32 is connected.

How it works: generate_reading() takes the *previous* reading and a
scenario name, and nudges each value a small step in a direction that
makes sense for that scenario. Calling it repeatedly produces smoothly
changing data instead of random jumps.

This file can also be run directly to sanity-check the scenarios:

    python simulator/sensor_simulator.py
"""

import random

# Values used the very first time the simulator runs, before any history exists
INITIAL_STATE = {
    "soil_moisture": 55.0,      # %
    "soil_temperature": 22.0,   # deg C
    "air_temperature": 24.0,    # deg C
    "humidity": 55.0,           # %
    "water_tank_level": 80.0,   # %
    "water_flow": 0.0,          # L/min
    "pump_status": "OFF",
    "growth_stage": "Vegetative",
}

# The scenarios the dashboard can switch between (see SIMULATED SENSORS spec)
SCENARIOS = ["normal", "dry_soil", "irrigation", "low_tank", "leak", "abnormal_flow"]


def _clamp(value, low, high):
    return max(low, min(high, value))


# Scenarios where the pump behavior is forced by the scenario itself, to
# demonstrate that specific situation on demand (see Stage 4 leak detection).
FORCED_SCENARIOS = {"irrigation", "leak", "abnormal_flow"}


def generate_reading(previous_state, scenario="normal", commanded_pump_on=False):
    """Return a new sensor state, evolved one small step from previous_state.

    For "irrigation", "leak", and "abnormal_flow", the pump is forced ON or
    OFF by the scenario, so those situations can be demonstrated on demand.
    For "normal", "dry_soil", and "low_tank", the pump instead follows
    commanded_pump_on - decided by the automatic irrigation controller (or
    a manual toggle) in app.py, based on the current moisture threshold.
    """
    state = dict(previous_state)  # copy so we never mutate the caller's dict

    # Air/soil temperature and humidity drift a little regardless of scenario
    state["air_temperature"] = round(_clamp(state["air_temperature"] + random.uniform(-0.3, 0.3), 15, 40), 1)
    state["humidity"] = round(_clamp(state["humidity"] + random.uniform(-1, 1), 20, 95), 1)
    state["soil_temperature"] = round(_clamp(state["soil_temperature"] + random.uniform(-0.2, 0.2), 10, 35), 1)

    if scenario == "irrigation":
        # Forced demo: pump running regardless of the controller
        state["pump_status"] = "ON"
        state["water_flow"] = round(random.uniform(2.0, 3.0), 2)
        state["soil_moisture"] = round(_clamp(state["soil_moisture"] + random.uniform(2.0, 4.0), 0, 100), 1)
        state["water_tank_level"] = round(_clamp(state["water_tank_level"] - random.uniform(0.5, 1.0), 0, 100), 1)

    elif scenario == "leak":
        # Pump is OFF but water is still flowing -> possible leak
        state["pump_status"] = "OFF"
        state["water_flow"] = round(random.uniform(1.0, 2.0), 2)
        state["water_tank_level"] = round(_clamp(state["water_tank_level"] - random.uniform(0.5, 1.0), 0, 100), 1)
        state["soil_moisture"] = round(_clamp(state["soil_moisture"] + random.uniform(0, 0.5), 0, 100), 1)

    elif scenario == "abnormal_flow":
        # Pump is ON but almost no water flows -> possible blockage/pump problem
        state["pump_status"] = "ON"
        state["water_flow"] = round(random.uniform(0.0, 0.2), 2)
        state["soil_moisture"] = round(_clamp(state["soil_moisture"] + random.uniform(-0.5, 0.5), 0, 100), 1)

    else:
        # "normal", "dry_soil", "low_tank": soil dries out at a
        # scenario-specific rate, and the pump follows commanded_pump_on
        if scenario == "dry_soil":
            dry_rate = random.uniform(1.5, 3.0)
        elif scenario == "low_tank":
            dry_rate = random.uniform(0.5, 1.5)
        else:  # "normal"
            dry_rate = random.uniform(0.2, 0.6)

        if commanded_pump_on:
            state["pump_status"] = "ON"
            state["water_flow"] = round(random.uniform(2.0, 3.0), 2)
            state["soil_moisture"] = round(_clamp(state["soil_moisture"] + random.uniform(2.0, 4.0), 0, 100), 1)
            state["water_tank_level"] = round(_clamp(state["water_tank_level"] - random.uniform(0.5, 1.0), 0, 100), 1)
        else:
            state["pump_status"] = "OFF"
            state["water_flow"] = 0.0
            state["soil_moisture"] = round(_clamp(state["soil_moisture"] - dry_rate, 0, 100), 1)
            state["water_tank_level"] = round(_clamp(state["water_tank_level"] - random.uniform(0, 0.1), 0, 100), 1)

        if scenario == "low_tank":
            # Keep draining the tank toward empty, on top of whatever happened above
            state["water_tank_level"] = round(_clamp(state["water_tank_level"] - random.uniform(0.5, 1.0), 0, 15), 1)

    return state


if __name__ == "__main__":
    # Quick manual check: print a few readings for every scenario
    state = dict(INITIAL_STATE)
    for scenario in SCENARIOS:
        print(f"\n--- scenario: {scenario} ---")
        for _ in range(5):
            state = generate_reading(state, scenario, commanded_pump_on=True)
            print(state)
