// AquaGrow-AI Dashboard - frontend logic (Stage 1-6)
//
// Polls the Flask API every few seconds to keep the dashboard current
// (sensor cards, gauges, charts, alerts, events), and sends control
// changes (scenario, growth stage, auto/manual mode, pump, threshold
// edits, data source) back to the server as the user makes them.

const REFRESH_INTERVAL_MS = 5000;
const GAUGE_ARC_LENGTH = 251.33; // circumference of the gauge's semicircle path

// Filled in by refreshStatus(), read by the gauges for warn-coloring
let cachedStatus = { moisture_threshold: 50, auto_mode: true, manual_pump_on: false };

// Set by refreshDataSource(), read by refreshLatestReading() so the "Live"
// badge can't sit next to "Source: ESP32 (offline)" claiming all is well
let esp32Offline = false;

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

function updateGauge(arcId, needleId, value, isWarning) {
    const pct = Math.max(0, Math.min(100, value)) / 100;

    const arc = document.getElementById(arcId);
    arc.style.strokeDashoffset = GAUGE_ARC_LENGTH * (1 - pct);
    arc.classList.toggle("warn", isWarning);

    const angle = -90 + pct * 180; // -90deg = points left (0), +90deg = points right (100)
    document.getElementById(needleId).style.transform = `rotate(${angle}deg)`;
}

// ---------------------------------------------------------------------------
// Sensor readings + pump status
// ---------------------------------------------------------------------------

async function refreshLatestReading() {
    const statusBadge = document.getElementById("connection-status");

    try {
        const response = await fetch("/api/latest");
        const data = await response.json();

        if (!data.has_data) {
            statusBadge.textContent = "Waiting for data...";
            statusBadge.className = "badge badge-waiting";
            return;
        }

        if (data.waiting_for_esp32) {
            // No values until the board's first post
            statusBadge.textContent = "Waiting for ESP32...";
            statusBadge.className = "badge badge-waiting";
        } else if (esp32Offline) {
            // There is data, but it stopped updating - saying "Live" would be a lie
            statusBadge.textContent = "Stale";
            statusBadge.className = "badge badge-waiting";
        } else {
            statusBadge.textContent = "Live";
            statusBadge.className = "badge badge-ok";
        }

        const r = data.reading;
        document.getElementById("soil-moisture").textContent = r.soil_moisture ?? "--";
        document.getElementById("air-temperature").textContent = formatValue(r.air_temperature, "°C");
        document.getElementById("humidity").textContent = formatValue(r.humidity, "%");
        const hasTankSensor = r.water_tank_level !== null && r.water_tank_level !== undefined;
        document.getElementById("water-tank-level").textContent = hasTankSensor ? r.water_tank_level : "--";
        document.getElementById("water-flow").textContent = formatValue(r.water_flow, "L/min");

        const pumpOn = r.pump_status === "ON";
        document.getElementById("pump-power-state").textContent = r.pump_status || "--";
        document.getElementById("pump-power-btn").classList.toggle("on", pumpOn);

        updateGauge(
            "gauge-moisture-arc", "gauge-moisture-needle",
            r.soil_moisture ?? 0,
            r.soil_moisture !== null && r.soil_moisture < cachedStatus.moisture_threshold
        );
        // No tank sensor: park the gauge at zero without the warning colour,
        // rather than showing a confident-looking 0% that isn't measured
        updateGauge(
            "gauge-tank-arc", "gauge-tank-needle",
            hasTankSensor ? r.water_tank_level : 0,
            hasTankSensor && r.water_tank_level <= 15
        );
    } catch (err) {
        statusBadge.textContent = "Connection error";
        statusBadge.className = "badge badge-waiting";
        console.error("Failed to fetch latest reading:", err);
    }
}

// ---------------------------------------------------------------------------
// Growth stage thresholds (editable table)
// ---------------------------------------------------------------------------

async function refreshGrowthStages() {
    try {
        const response = await fetch("/api/growth_stages");
        const stages = await response.json();

        const tbody = document.querySelector("#growth-stage-table tbody");
        tbody.innerHTML = "";
        stages.forEach((stage) => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${stage.stage_name}</td>
                <td><input type="number" class="threshold-input" data-stage="${stage.stage_name}" value="${stage.moisture_threshold}" min="0" max="100" step="1"></td>
                <td><button class="save-threshold-btn" data-stage="${stage.stage_name}">Save</button></td>
            `;
            tbody.appendChild(row);
        });

        document.querySelectorAll(".save-threshold-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const stage = btn.dataset.stage;
                const input = document.querySelector(`.threshold-input[data-stage="${stage}"]`);
                saveThreshold(stage, parseFloat(input.value));
            });
        });
    } catch (err) {
        console.error("Failed to fetch growth stages:", err);
    }
}

async function saveThreshold(stageName, moistureThreshold) {
    try {
        await fetch("/api/growth_stages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage_name: stageName, moisture_threshold: moistureThreshold }),
        });
        refreshStatus();
    } catch (err) {
        console.error("Failed to save threshold:", err);
    }
}

// ---------------------------------------------------------------------------
// Irrigation status + pump control
// ---------------------------------------------------------------------------

// Shows how long until soil moisture crosses the threshold, measured by the
// server from stored sensor history. The card's colour comes from the state
// name, so "drying" and "dry-now" read differently at a glance.
function renderForecast(forecast) {
    const data = forecast || { state: "unknown", headline: "--", detail: "No forecast available." };

    document.getElementById("forecast-headline").textContent = data.headline || "--";
    document.getElementById("forecast-detail").textContent = data.detail || "";
    document.getElementById("forecast-card").className = `card forecast-card forecast-${data.state || "unknown"}`;
}

// Timing guidance only: the system has no EC/pH/NPK sensor, so the note stays
// on screen to keep "Good window" from reading as "your crop needs feeding".
function renderFertigation(fertigation) {
    const data = fertigation || { ok: false, headline: "--", reasons: [], note: "" };

    document.getElementById("fertigation-headline").textContent = data.headline || "--";
    document.getElementById("fertigation-card").className =
        `card fertigation-card fertigation-${data.ok ? "ok" : "hold"}`;

    const reasons = data.reasons || [];
    document.getElementById("fertigation-reason").textContent = reasons[0] || "";
    document.getElementById("fertigation-detail").textContent = data.ok
        ? "Conditions look right for applying liquid fertiliser."
        : "Not a good moment to apply liquid fertiliser:";

    const list = document.getElementById("fertigation-reasons");
    list.innerHTML = "";
    reasons.forEach((reason) => {
        const item = document.createElement("li");
        item.textContent = reason;
        list.appendChild(item);
    });

    document.getElementById("fertigation-note").textContent = data.note || "";
}

async function refreshStatus() {
    try {
        const response = await fetch("/api/status");
        const status = await response.json();
        cachedStatus = status;

        document.getElementById("growth-stage-select").value = status.growth_stage;
        document.getElementById("growth-stage-display").textContent = status.growth_stage;
        document.getElementById("moisture-threshold").textContent = `${status.moisture_threshold}%`;
        document.getElementById("irrigation-recommendation").textContent = status.recommendation;

        renderForecast(status.forecast);
        renderFertigation(status.fertigation);

        document.getElementById("auto-mode-toggle").checked = status.auto_mode;

        const powerBtn = document.getElementById("pump-power-btn");
        powerBtn.disabled = status.auto_mode;
        document.getElementById("pump-mode-note").textContent = status.auto_mode
            ? "Automatic mode"
            : "Manual mode - click the button to toggle";
    } catch (err) {
        console.error("Failed to fetch status:", err);
    }
}

document.getElementById("growth-stage-select").addEventListener("change", async (e) => {
    await fetch("/api/growth_stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ growth_stage: e.target.value }),
    });
    refreshStatus();
});

document.getElementById("auto-mode-toggle").addEventListener("change", async (e) => {
    await fetch("/api/auto_mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_mode: e.target.checked }),
    });
    refreshStatus();
});

document.getElementById("pump-power-btn").addEventListener("click", async () => {
    if (cachedStatus.auto_mode) return; // disabled attribute already blocks this, but be safe
    const turningOn = document.getElementById("pump-power-state").textContent !== "ON";
    await fetch("/api/pump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pump_on: turningOn }),
    });
    refreshStatus();
    refreshLatestReading();
});

// ---------------------------------------------------------------------------
// Water usage
// ---------------------------------------------------------------------------

async function refreshWaterUsage() {
    try {
        const response = await fetch("/api/water_usage");
        const usage = await response.json();
        document.getElementById("daily-water-usage").textContent = usage.daily_total_liters.toFixed(2);
        document.getElementById("total-water-usage").textContent = usage.total_liters.toFixed(2);
    } catch (err) {
        console.error("Failed to fetch water usage:", err);
    }
}

// ---------------------------------------------------------------------------
// AI prediction
// ---------------------------------------------------------------------------

async function refreshAIPrediction() {
    try {
        const response = await fetch("/api/ai_prediction");
        const data = await response.json();
        const el = document.getElementById("ai-prediction");

        if (!data.available) {
            el.textContent = "Not available";
            return;
        }

        el.textContent = `${data.prediction} (${data.confidence}%)`;
    } catch (err) {
        console.error("Failed to fetch AI prediction:", err);
    }
}

// ---------------------------------------------------------------------------
// Alerts (summary card + detailed list)
// ---------------------------------------------------------------------------

// Faults and advisories share the alerts table but mean different things, so
// they are counted and listed separately - a "hold off watering" suggestion
// shouldn't light up the dashboard like a burst pipe.
function fillAlertList(listId, alerts, emptyText) {
    const list = document.getElementById(listId);
    list.innerHTML = "";

    if (alerts.length === 0) {
        list.innerHTML = `<li class="no-alerts">${emptyText}</li>`;
        return;
    }

    alerts.forEach((alert) => {
        const item = document.createElement("li");
        item.className = `alert-${alert.severity} alert-${alert.alert_type.replace(/_/g, "-")}`;
        item.textContent = `[${alert.timestamp}] ${alert.message}`;
        list.appendChild(item);
    });
}

async function refreshAlerts() {
    try {
        const response = await fetch("/api/alerts");
        const alerts = await response.json();

        const faults = alerts.filter((a) => a.severity === "fault");
        const advisories = alerts.filter((a) => a.severity !== "fault");

        // Only a fault is a problem - advisories stay quiet in the summary
        const icon = document.getElementById("alert-summary-icon");
        icon.textContent = faults.length > 0 ? "⚠" : "✓";
        icon.classList.toggle("active", faults.length > 0);
        document.getElementById("alert-count").textContent = faults.length;
        document.getElementById("alert-status-text").textContent = advisories.length
            ? `${advisories.length} ${advisories.length === 1 ? "advisory" : "advisories"}`
            : "Status: clear";

        fillAlertList("faults-list", faults, "No active faults.");
        fillAlertList("advisories-list", advisories, "No advisories.");
    } catch (err) {
        console.error("Failed to fetch alerts:", err);
    }
}

// ---------------------------------------------------------------------------
// Recent irrigation events
// ---------------------------------------------------------------------------

async function refreshIrrigationEvents() {
    try {
        const response = await fetch("/api/irrigation_events");
        const events = await response.json();

        const tbody = document.querySelector("#irrigation-events-table tbody");
        tbody.innerHTML = "";
        events.forEach((event) => {
            const row = document.createElement("tr");
            const duration = event.duration_seconds !== null ? `${event.duration_seconds}s` : "--";
            const waterUsed = event.water_used_liters !== null ? `${event.water_used_liters} L` : "--";
            row.innerHTML = `
                <td>${event.timestamp}</td>
                <td>${event.action}</td>
                <td>${event.reason || "--"}</td>
                <td>${duration}</td>
                <td>${waterUsed}</td>
            `;
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error("Failed to fetch irrigation events:", err);
    }
}

// ---------------------------------------------------------------------------
// Scenario simulator
// ---------------------------------------------------------------------------

// A sensor with no valid reading (null) shows no value, not a made-up one
function formatValue(value, unit) {
    if (value === null || value === undefined) return "--";
    return `${value} ${unit}`;
}

function highlightActiveScenario(scenario) {
    document.getElementById("active-scenario").textContent = scenario;
    document.querySelectorAll(".scenario-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.scenario === scenario);
    });
}

async function fetchCurrentScenario() {
    try {
        const response = await fetch("/api/scenario");
        const data = await response.json();
        highlightActiveScenario(data.scenario);
    } catch (err) {
        console.error("Failed to fetch current scenario:", err);
    }
}

async function setScenario(scenario) {
    try {
        const response = await fetch("/api/scenario", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario }),
        });
        const data = await response.json();
        highlightActiveScenario(data.scenario);
    } catch (err) {
        console.error("Failed to set scenario:", err);
    }
}

document.querySelectorAll(".scenario-btn").forEach((btn) => {
    btn.addEventListener("click", () => setScenario(btn.dataset.scenario));
});

// ---------------------------------------------------------------------------
// Data source (Stage 6: simulator vs. real ESP32)
// ---------------------------------------------------------------------------

// "Live" used to be sticky: one POST and the badge claimed a live board
// forever, even after it went silent. It now reflects how recently the
// ESP32 actually reported.
function describeEsp32(esp32) {
    if (!esp32 || !esp32.seen) {
        return "No ESP32 has connected yet. It appears here the moment one POSTs to /api/sensor_data.";
    }

    const ago = esp32.seconds_since < 90
        ? `${Math.round(esp32.seconds_since)}s ago`
        : `${(esp32.seconds_since / 60).toFixed(1)} min ago`;

    if (esp32.offline) {
        return `ESP32 at ${esp32.address} is not responding - last reading ${ago}. `
             + `Readings are frozen, water accounting is paused, and irrigation is held off.`;
    }
    return `ESP32 connected at ${esp32.address} - last reading ${ago}.`;
}

async function refreshDataSource() {
    try {
        const response = await fetch("/api/data_source");
        const data = await response.json();
        const esp32 = data.esp32;

        esp32Offline = Boolean(esp32 && esp32.offline && !data.simulator_enabled);

        let label = "Simulator";
        let healthy = false;
        if (!data.simulator_enabled) {
            if (!(esp32 && esp32.seen)) {
                label = "ESP32 (waiting)";
            } else {
                label = esp32.offline ? "ESP32 (offline)" : "ESP32 (Live)";
                healthy = !esp32.offline;
            }
        }

        const badge = document.getElementById("data-source-badge");
        badge.textContent = `Source: ${label}`;
        badge.className = healthy ? "badge badge-ok" : "badge badge-waiting";

        document.getElementById("esp32-source-label").textContent = label;

        const connection = document.getElementById("esp32-connection");
        connection.textContent = describeEsp32(esp32);
        connection.classList.toggle("offline", Boolean(esp32 && esp32.offline));

        // Nothing to switch to until a board has actually been seen
        document.getElementById("use-esp32-btn").disabled =
            !data.simulator_enabled || !(esp32 && esp32.seen);
    } catch (err) {
        console.error("Failed to fetch data source:", err);
    }
}

document.getElementById("use-esp32-btn").addEventListener("click", async () => {
    await fetch("/api/data_source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulator_enabled: false }),
    });
    refreshDataSource();
});

document.getElementById("use-simulator-btn").addEventListener("click", async () => {
    await fetch("/api/data_source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulator_enabled: true }),
    });
    refreshDataSource();
});

// ---------------------------------------------------------------------------
// Charts (Chart.js, loaded via CDN in index.html)
// ---------------------------------------------------------------------------

function makeLineChart(canvasId, datasetConfigs) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    return new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: datasetConfigs },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { display: datasetConfigs.length > 1 } },
        },
    });
}

const moistureChart = makeLineChart("moisture-chart", [
    { label: "Soil Moisture (%)", data: [], borderColor: "#2f6fed", backgroundColor: "#2f6fed", tension: 0.3, pointRadius: 2 },
    { label: "Threshold (%)", data: [], borderColor: "#e03131", backgroundColor: "#e03131", borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, tension: 0 },
]);

const temperatureChart = makeLineChart("temperature-chart", [
    { label: "Air Temp (°C)", data: [], borderColor: "#f08c00", backgroundColor: "#f08c00", tension: 0.3, pointRadius: 2 },
]);

const flowChart = makeLineChart("flow-chart", [
    { label: "Water Flow (L/min)", data: [], borderColor: "#0c8599", backgroundColor: "#0c8599", tension: 0.3, pointRadius: 2 },
]);

async function refreshCharts() {
    try {
        const response = await fetch("/api/history?limit=30");
        const rows = await response.json();

        const labels = rows.map((r) => r.timestamp.split("T")[1] || r.timestamp);

        moistureChart.data.labels = labels;
        moistureChart.data.datasets[0].data = rows.map((r) => r.soil_moisture);
        // Flat line at the active stage's threshold - the level the forecast counts down to
        moistureChart.data.datasets[1].data = rows.map(() => cachedStatus.moisture_threshold);
        moistureChart.update();

        temperatureChart.data.labels = labels;
        temperatureChart.data.datasets[0].data = rows.map((r) => r.air_temperature);
        temperatureChart.update();

        flowChart.data.labels = labels;
        flowChart.data.datasets[0].data = rows.map((r) => r.water_flow);
        flowChart.update();
    } catch (err) {
        console.error("Failed to fetch history for charts:", err);
    }
}

// ---------------------------------------------------------------------------
// Main refresh loop
// ---------------------------------------------------------------------------

function refreshAll() {
    refreshStatus().then(refreshLatestReading); // status first, so gauges have the right threshold
    refreshGrowthStages();
    refreshWaterUsage();
    refreshAlerts();
    refreshIrrigationEvents();
    refreshAIPrediction();
    refreshDataSource();
    refreshCharts();
}

fetchCurrentScenario();
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL_MS);
