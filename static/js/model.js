// Derived dashboard state. Turns the raw API responses into the facts every
// component shows (moisture status, connection state, alerts, AI summary...),
// so the rules live in one place instead of being re-decided per card.
//
// Nothing here invents a reading: every value comes from the API, and a
// missing one stays missing (null) all the way to the screen.

import { clockTime, humanize, isNum, parseTimestamp, secondsSince, timeAgo } from "./ui.js";

// Mirrors of backend constants, used only to explain the backend's decisions
export const FORCED_SCENARIOS = new Set(["irrigation", "leak", "abnormal_flow"]); // simulator/sensor_simulator.py
export const LOW_TANK_THRESHOLD = 15;   // app.py LOW_TANK_THRESHOLD - the backend raises a fault at or below this
export const OPTIMAL_BAND = 15;         // app.py FERTIGATION_WET_MARGIN - above threshold + 15% the soil is saturated
export const ESP32_PUMP_ON_AT = 0;      // app.py ESP32_PUMP_ON_AT
export const ESP32_PUMP_OFF_AT = 30;    // app.py ESP32_PUMP_OFF_AT
export const TANK_WARNING_LEVEL = 25;   // dashboard-only early warning, before the backend's low-tank fault
export const FLOW_FAULT_THRESHOLD = 0.3; // app.py LEAK_FLOW_THRESHOLD / BLOCKAGE_FLOW_THRESHOLD (L/min)
export const APPROACH_MARGIN = 3;       // % above threshold, while drying, that counts as "approaching"

export const METRICS = {
    soil_moisture: { label: "Soil moisture", short: "Soil Moisture", unit: "%", decimals: 1, icon: "droplet" },
    air_temperature: { label: "Air temperature", short: "Temperature", unit: "°C", decimals: 1, icon: "thermometer" },
    humidity: { label: "Humidity", short: "Humidity", unit: "%", decimals: 1, icon: "humidity" },
    water_tank_level: { label: "Water tank", short: "Tank Level", unit: "%", decimals: 1, icon: "tank" },
    water_flow: { label: "Water flow", short: "Water Flow", unit: "L/min", decimals: 2, icon: "waves" },
    soil_temperature: { label: "Soil temperature", short: "Soil Temp", unit: "°C", decimals: 1, icon: "thermometer" },
    pump_status: { label: "Pump", icon: "power", text: true },
    growth_stage: { label: "Growth stage", icon: "sprout", text: true },
};

export const SCENARIOS = [
    { id: "normal", label: "Normal Soil", icon: "leaf", text: "Soil dries slowly and the controller waters at the growth-stage threshold." },
    { id: "dry_soil", label: "Dry Soil", icon: "sun", text: "A fast dry-down that pushes moisture below threshold to trigger irrigation." },
    { id: "irrigation", label: "Irrigation", icon: "droplet", text: "Pump forced on: moisture climbs while the tank drains." },
    { id: "low_tank", label: "Low Water Tank", icon: "tank", text: "The tank drains toward empty to raise the low-water fault." },
    { id: "leak", label: "Water Leak", icon: "warning", text: "Water keeps flowing with the pump off, so leak detection fires." },
    { id: "abnormal_flow", label: "Abnormal Flow", icon: "waves", text: "Pump on with almost no flow, so blockage detection fires." },
];

// The backend's stages, plus the end of the crop cycle (shown, never selectable)
export const LIFECYCLE_END = "Harvest";

// General temperature guidance per stage, for context only - the backend has no
// temperature rule, and these are typical vegetable-crop ranges, not crop-specific.
export const STAGE_TEMPERATURE_GUIDE = {
    Seedling: [20, 25],
    Vegetative: [20, 28],
    Flowering: [18, 27],
    Fruiting: [20, 30],
};

const ALERT_TITLES = {
    leak: "Possible water leak",
    blockage: "Abnormal water flow",
    low_tank: "Water tank low",
    ineffective_irrigation: "Water not reaching the roots",
    esp32_offline: "ESP32 offline",
    recently_watered: "Recently watered",
    conserve_water: "Conserve water",
    overwatering: "Possible overwatering",
    soil_holding: "Soil is holding moisture",
};

// Faults that mean real damage or a blind controller are critical; a low tank
// is serious but expected, so it reads as a warning rather than a red alarm.
const CRITICAL_FAULTS = new Set(["leak", "blockage", "ineffective_irrigation", "esp32_offline"]);

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

export function scenarioLabel(id) {
    return (SCENARIOS.find((s) => s.id === id) || { label: humanize(id) }).label;
}

// ---------------------------------------------------------------------------

export function derive(state) {
    const latest = state.latest || {};
    const source = state.source || {};
    const status = state.status || {};
    const esp32 = source.esp32 || {};

    const loaded = state.loaded;
    const simulator = Boolean(source.simulator_enabled);
    const waiting = loaded && (Boolean(latest.waiting_for_esp32) || latest.has_data === false);
    const offline = Boolean(esp32.offline) && !simulator;
    const reading = waiting ? null : latest.reading || null;
    const readingAt = parseTimestamp(reading && reading.timestamp);

    const threshold = isNum(status.moisture_threshold) ? status.moisture_threshold : null;
    const moisture = reading ? reading.soil_moisture : null;
    const forecast = status.forecast || null;

    const v = {
        ...state,
        loaded,
        error: state.error,
        simulator,
        mode: simulator ? "simulator" : "esp32",
        waiting,
        offline,
        reading,
        readingAt,
        readingAge: secondsSince(readingAt),
        value: (key) => (reading && isNum(reading[key]) ? reading[key] : null),
        stage: status.growth_stage || null,
        threshold,
        band: threshold === null ? null : [threshold, Math.min(100, threshold + OPTIMAL_BAND)],
        forecast,
        autoMode: status.auto_mode !== false,
        manualPumpOn: Boolean(status.manual_pump_on),
        pumpOn: Boolean(reading && reading.pump_status === "ON"),
        scenario: state.scenario,
        forced: simulator && FORCED_SCENARIOS.has(state.scenario),
        esp32,
        esp32Age: isNum(esp32.seconds_since) ? esp32.seconds_since + (Date.now() - state.sourceFetchedAt) / 1000 : null,
    };

    v.moistureStatus = moistureStatus(moisture, threshold, forecast);
    v.trend = trendOf(forecast);
    v.connection = connection(v);
    v.issues = issues(v);
    v.faultCount = v.issues.filter((i) => i.severity === "critical").length;
    return v;
}

export function moistureStatus(moisture, threshold, forecast) {
    if (!isNum(moisture)) return { key: "none", label: "No reading", tone: "muted" };
    if (threshold === null) return { key: "unknown", label: "Measured", tone: "muted" };
    if (moisture < threshold) return { key: "low", label: "Below threshold", tone: "warning" };
    if (moisture > threshold + OPTIMAL_BAND) return { key: "high", label: "Saturated", tone: "warning" };
    if (moisture - threshold < APPROACH_MARGIN && forecast && forecast.state === "drying") {
        return { key: "near", label: "Approaching threshold", tone: "warning" };
    }
    return { key: "ok", label: "Optimal", tone: "good" };
}

function trendOf(forecast) {
    if (!forecast || !isNum(forecast.rate_per_minute)) return null;
    const rate = forecast.rate_per_minute;
    if (Math.abs(rate) < 0.05) return { dir: "flat", icon: "minus", text: "Holding steady" };
    return rate > 0
        ? { dir: "up", icon: "trend-up", text: `Rising ${Math.abs(rate)} %/min` }
        : { dir: "down", icon: "trend-down", text: `Falling ${Math.abs(rate)} %/min` };
}

// What the header/sidebar say about the controller link
// state: the one-word condition, device: what it refers to, sub: the evidence
function connection(v) {
    if (v.error) return { tone: "critical", state: "No server", device: "AquaGrow server", sub: "Retrying every 5 sec" };
    if (!v.loaded) return { tone: "muted", state: "Connecting", device: "AquaGrow server", sub: "Checking…", blink: true };
    if (v.simulator) {
        return {
            tone: "info",
            state: "Simulation",
            device: "Simulator",
            sub: v.esp32.seen ? `ESP32 last seen: ${timeAgo(v.esp32Age)}` : "No ESP32 connected",
        };
    }
    if (v.waiting) return { tone: "warning", state: "Waiting", device: "ESP32", sub: "No reading received yet", blink: true };
    if (v.offline) return { tone: "critical", state: "Offline", device: "ESP32", sub: `Last seen: ${timeAgo(v.esp32Age)}` };
    return { tone: "good", state: "Connected", device: "ESP32", sub: `Last sync: ${timeAgo(v.esp32Age)}` };
}

// Backend alerts, plus early warnings worked out from the live reading
function issues(v) {
    const list = (v.alerts || []).map((alert) => {
        const fault = alert.severity === "fault";
        return {
            id: `a${alert.id}`,
            severity: fault ? (CRITICAL_FAULTS.has(alert.alert_type) ? "critical" : "warning") : "info",
            kind: fault ? "Fault" : "Advisory",
            title: ALERT_TITLES[alert.alert_type] || humanize(alert.alert_type),
            message: alert.message,
            at: parseTimestamp(alert.timestamp),
        };
    });

    if (v.reading && !v.offline) {
        const tank = v.value("water_tank_level");
        if (tank !== null && tank > LOW_TANK_THRESHOLD && tank <= TANK_WARNING_LEVEL) {
            list.push({
                id: "live-tank",
                severity: "warning",
                kind: "Live check",
                title: `Water tank below ${TANK_WARNING_LEVEL}%`,
                message: `Tank is at ${tank}% - plan a refill before it reaches the ${LOW_TANK_THRESHOLD}% low-water fault.`,
            });
        }
        if (v.moistureStatus.key === "near") {
            list.push({
                id: "live-moisture",
                severity: "warning",
                kind: "Live check",
                title: "Soil moisture approaching irrigation threshold",
                message: `${v.value("soil_moisture")}% against a ${v.threshold}% threshold - ${v.forecast.headline} to go.`,
            });
        }
    }

    return list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ---------------------------------------------------------------------------
// Narrative text
// ---------------------------------------------------------------------------

export function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return "Good evening";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
}

export function farmHeadline(v) {
    if (v.error) return { tone: "critical", tag: "No server", text: "Can't reach the AquaGrow server. Retrying…" };
    if (!v.loaded) return { tone: "muted", tag: "Loading", text: "Loading farm status…" };
    if (v.waiting) return { tone: "warning", tag: "Waiting", text: "Waiting for the ESP32 controller to report its first reading." };
    if (v.offline) return { tone: "critical", tag: "Offline", text: "Controller has stopped reporting. Irrigation is on hold." };
    if (v.faultCount) {
        return { tone: "critical", tag: "Fault", text: `${v.faultCount} issue${v.faultCount === 1 ? " needs" : "s need"} attention.` };
    }
    if (v.pumpOn) return { tone: "good", tag: "Irrigating", text: "Irrigation in progress." };
    if (v.moistureStatus.key === "low") return { tone: "warning", tag: "Attention", text: "Soil moisture below threshold. Irrigation recommended." };
    if (v.issues.some((i) => i.severity === "warning")) return { tone: "warning", tag: "Attention", text: "System operating. Some readings need watching." };
    if (v.moistureStatus.key === "none") return { tone: "muted", tag: "No data", text: "Controller online, but no soil moisture reading." };
    return { tone: "good", tag: "Normal", text: "Your farm is healthy. No irrigation action required." };
}

// The irrigation controller's current reasoning, in one sentence
export function systemMessage(v) {
    if (!v.loaded) return { tone: "muted", text: "Checking controller status…" };
    if (v.waiting) return { tone: "warning", text: "Waiting for the ESP32's first reading. The pump stays off until then." };
    if (v.offline) return { tone: "critical", text: "Controller offline. Irrigation is held off until it reports again." };
    if (v.forced) {
        return { tone: "info", text: `Scenario override: the “${scenarioLabel(v.scenario)}” simulation is forcing the pump ${v.pumpOn ? "on" : "off"}.` };
    }
    if (!v.autoMode) {
        return { tone: "info", text: `Manual control. The pump is commanded ${v.manualPumpOn ? "ON" : "OFF"} until you change it or return to automatic.` };
    }
    const moisture = v.value("soil_moisture");
    if (moisture === null) return { tone: "muted", text: "No soil moisture reading, so the pump won't switch on automatically." };

    if (!v.simulator) {
        // Real board: the backend's hysteresis rule, not the stage threshold
        if (v.pumpOn) return { tone: "info", text: `Watering. The pump stops once soil moisture is back up to ${ESP32_PUMP_OFF_AT}%.` };
        return {
            tone: "good",
            text: `Soil moisture is ${moisture}%. The ESP32 pump starts at ${ESP32_PUMP_ON_AT}% and runs until ${ESP32_PUMP_OFF_AT}%.`,
        };
    }
    // The pump reacts on the next 5-second cycle, so a reading can briefly
    // disagree with the pump state - say so instead of contradicting it
    if (moisture < v.threshold) {
        return v.pumpOn
            ? { tone: "info", text: `Soil moisture is below the ${v.threshold}% irrigation threshold, so the pump is running.` }
            : { tone: "info", text: `Soil moisture is below the ${v.threshold}% threshold. The pump starts on the next cycle.` };
    }
    if (v.pumpOn) return { tone: "good", text: `Threshold of ${v.threshold}% reached. The pump stops on the next cycle.` };
    return { tone: "good", text: "Soil moisture is above the irrigation threshold." };
}

export function autoRuleText(v) {
    if (!v.simulator) return `Pump on at ${ESP32_PUMP_ON_AT}% soil moisture, off at ${ESP32_PUMP_OFF_AT}% (ESP32 rule)`;
    if (v.threshold === null) return "Pump on below the growth-stage threshold";
    return `Pump on below ${v.threshold}% (${v.stage} threshold), off once it's reached`;
}

export function aiSummary(v) {
    if (!v.loaded) return { tone: "muted", icon: "clock", headline: "Analysing farm conditions…", body: "" };
    if (v.waiting) {
        return {
            tone: "muted",
            icon: "clock",
            headline: "Waiting for sensor data.",
            body: "Recommendations start as soon as the ESP32 sends its first reading.",
        };
    }
    if (v.offline) {
        return {
            tone: "critical",
            icon: "critical",
            headline: "Recommendations paused.",
            body: "The controller stopped reporting, so the latest readings are frozen and can't be trusted.",
        };
    }
    const moisture = v.value("soil_moisture");
    const stage = v.stage || "current";
    if (moisture === null) {
        return { tone: "muted", icon: "info", headline: "Soil moisture sensor not reporting.", body: "Irrigation advice needs a valid soil moisture reading." };
    }
    if (v.pumpOn) {
        return {
            tone: "info",
            icon: "droplet",
            headline: "Irrigation in progress.",
            body: `Soil moisture is ${moisture}% against the ${v.threshold}% target for the ${stage} stage.`,
        };
    }
    switch (v.moistureStatus.key) {
        case "low": {
            let next = v.autoMode ? " Automatic irrigation will start the pump." : " Manual mode is on, so start the pump from Irrigation Control.";
            if (v.autoMode && !v.simulator) next = ` The ESP32's automatic rule waters at ${ESP32_PUMP_ON_AT}% moisture.`;
            return {
                tone: "warning",
                icon: "droplet",
                headline: "Irrigation recommended.",
                body: `Soil moisture (${moisture}%) is below the ${v.threshold}% threshold for the ${stage} growth stage.${next}`,
            };
        }
        case "near":
            return {
                tone: "warning",
                icon: "clock",
                headline: "Irrigation needed soon.",
                body: `Soil moisture is ${moisture}%, just above the ${v.threshold}% threshold and drying.`,
            };
        case "high":
            return {
                tone: "good",
                icon: "check",
                headline: "Irrigation is not required right now.",
                body: `Soil moisture (${moisture}%) is above the optimal range for the ${stage} stage. Hold off watering.`,
            };
        default:
            return {
                tone: "good",
                icon: "check",
                headline: "Irrigation is not required right now.",
                body: `Soil moisture is within the optimal range for the current ${stage} growth stage.`,
            };
    }
}

// When the forecast says the threshold will be crossed - measured by the
// backend from stored history, not guessed here
export function nextIrrigation(v) {
    const f = v.forecast;
    if (!v.loaded || v.waiting || !f) return { value: "—", sub: "Waiting for readings" };
    if (v.offline) return { value: "On hold", sub: "Controller offline" };
    if (v.pumpOn) return { value: "Now", sub: "Pump is running" };
    switch (f.state) {
        case "drying": {
            if (f.minutes_to_threshold > 240) return { value: "Beyond 4 h", sub: "Soil drying slowly" };
            const at = new Date(Date.now() + f.minutes_to_threshold * 60000);
            const tomorrow = at.getDate() !== new Date().getDate();
            return { value: `${clockTime(at)}${tomorrow ? " tomorrow" : ""}`, sub: `In ${f.headline.replace(/^~\s*/, "about ")}` };
        }
        case "dry-now":
            return { value: "Now", sub: "Below threshold" };
        case "filling":
            return { value: "In progress", sub: `${f.headline} to the threshold` };
        case "satisfied":
            return { value: "Not needed", sub: "At or above threshold" };
        case "steady":
            return { value: "Not forecast", sub: "Moisture holding steady" };
        default:
            return { value: "Calculating…", sub: f.detail || "Collecting readings" };
    }
}

// Average water used by recent completed pump runs (from the events log)
export function waterPerRun(events) {
    const runs = (events || []).filter((e) => e.action === "PUMP_OFF" && isNum(e.water_used_liters) && e.water_used_liters > 0);
    if (!runs.length) return { value: null, sub: "No completed irrigation runs yet" };
    const avg = runs.reduce((sum, e) => sum + e.water_used_liters, 0) / runs.length;
    return { value: avg, sub: `Average of the last ${runs.length} irrigation run${runs.length === 1 ? "" : "s"}` };
}

export function tankStatus(level) {
    if (!isNum(level)) return { tone: "muted", label: "No reading" };
    if (level <= LOW_TANK_THRESHOLD) return { tone: "warning", label: "Low water" };
    if (level <= TANK_WARNING_LEVEL) return { tone: "warning", label: "Refill soon" };
    return { tone: "good", label: "Healthy" };
}
