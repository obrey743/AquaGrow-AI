// Reusable dashboard components.
//
// Markup declares where a component goes: <div data-component="metric"
// data-metric="humidity">. Each factory below builds its DOM once and returns
// { update(v) }, called on every poll with the derived state from model.js.
// The same component can appear on several pages (the metric strip, the soil
// moisture card...) without any duplicated markup.

import * as api from "./api.js";
import { EnvChart, sparkline } from "./charts.js";
import {
    ESP32_PUMP_OFF_AT, ESP32_PUMP_ON_AT, FLOW_FAULT_THRESHOLD, LIFECYCLE_END, LOW_TANK_THRESHOLD, METRICS, OPTIMAL_BAND, SCENARIOS,
    STAGE_TEMPERATURE_GUIDE, aiSummary, autoRuleText, farmHeadline, greeting, nextIrrigation, scenarioLabel,
    systemMessage, tankStatus, waterPerRun,
} from "./model.js";
import {
    $, $$, clockTime, confirmDialog, dateTime, esc, fmt, icon, isNum, parseTimestamp, pill, prefs, runAction,
    setHTML, setText, skeleton, timeAgo, toast, tweenNumber,
} from "./ui.js";

const TONE_ICONS = { good: "check-circle", warning: "warning", critical: "critical", info: "info", muted: "clock" };
const SPARK_READINGS = 60;

const slotsOf = (root) => Object.fromEntries($$("[data-slot]", root).map((el) => [el.dataset.slot, el]));

export const tankCapacity = () => {
    const value = parseFloat(prefs.get("tankCapacity"));
    return value > 0 ? value : null;
};

function cardHead(label, right = "") {
    return `<div class="card-head"><h2 class="section-label">${label}</h2>${right}</div>`;
}

function emptyBlock(iconName, title, text, extra = "") {
    return `<div class="empty"><span class="empty-icon">${icon(iconName)}</span>
        <p class="empty-title">${esc(title)}</p><p class="empty-text">${esc(text)}</p>${extra}</div>`;
}

// Big animated number with unit, or a placeholder when there's nothing to show
function setNumber(el, value, decimals, v) {
    if (!v.loaded || v.waiting) {
        el._value = null;
        el.classList.add("is-empty");
        setHTML(el, skeleton("2.4em", "0.9em"));
        return;
    }
    if (!isNum(value)) {
        cancelAnimationFrame(el._raf);
        el._value = null;
        el._html = null;
        setText(el, "—");
        el.classList.add("is-empty");
        return;
    }
    el.classList.remove("is-empty");
    el._html = null;
    if (el.firstElementChild) el.textContent = "";
    tweenNumber(el, value, decimals);
}

// ---------------------------------------------------------------------------
// Connection status (header + sidebar)
// ---------------------------------------------------------------------------

function Connection(el, opts) {
    const sidebar = opts.variant === "sidebar";
    const component = {
        update(v) {
            const c = v.connection;
            const where = v.simulator
                ? `Scenario · ${scenarioLabel(v.scenario)}`
                : v.esp32.address ? `Controller · ${v.esp32.address}` : "Controller · not connected";
            setHTML(el, sidebar
                ? `<a class="conn conn-card tone-${c.tone} ${c.blink ? "blink" : ""}" href="#/esp32">
                        <span class="conn-row"><span class="led"></span><strong class="conn-state">${esc(c.state)}</strong><span class="conn-device">${esc(c.device)}</span></span>
                        <small>${esc(c.sub)}</small>
                        ${v.loaded && !v.error ? `<small class="conn-where">${esc(where)}</small>` : ""}
                   </a>`
                : `<a class="conn conn-header tone-${c.tone} ${c.blink ? "blink" : ""}" href="#/esp32" title="${esc(where)}">
                        <span class="led"></span>
                        <span class="conn-text">
                            <span><strong class="conn-state">${esc(c.state)}</strong><span class="conn-device">${esc(c.device)}</span></span>
                            <small>${esc(c.sub)}</small>
                        </span>
                   </a>`);
        },
    };
    component.tick = component.update;
    return component;
}

// ---------------------------------------------------------------------------
// Overview: greeting, waiting state, simulation banner
// ---------------------------------------------------------------------------

function Greeting(el) {
    return {
        update(v) {
            const headline = farmHeadline(v);
            const today = new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
            const meta = v.loaded && !v.error
                ? `<dl class="statusbar-meta">
                        <div><dt>Source</dt><dd>${v.simulator ? "Simulator" : "ESP32"}</dd></div>
                        <div><dt>Stage</dt><dd>${esc(v.stage || "—")}</dd></div>
                        <div><dt>Mode</dt><dd>${v.autoMode ? "Automatic" : "Manual"}</dd></div>
                   </dl>`
                : "";
            setHTML(el, `
                <div class="statusbar tone-${headline.tone}">
                    <span class="status-tag">${esc(headline.tag)}</span>
                    <div class="statusbar-text">
                        <strong>${esc(headline.text)}</strong>
                        <small>${greeting()} · ${esc(today)}</small>
                    </div>
                    ${meta}
                </div>`);
        },
    };
}

function WaitingState(el) {
    el.addEventListener("click", (e) => {
        const button = e.target.closest("[data-action='start-sim']");
        if (button) runAction(button, () => api.setSimulatorEnabled(true), "Simulation mode started");
    });
    return {
        update(v) {
            if (!v.waiting) return setHTML(el, "");
            setHTML(el, `
                <section class="card waiting">
                    <div class="waiting-body">
                        <p class="eyebrow">Waiting for ESP32</p>
                        <h2>Connecting to your irrigation controller…</h2>
                        <p class="muted">No readings are shown until the board reports. The dashboard never fills the gap with made-up values.</p>
                        <ul class="checklist">
                            <li class="done">${icon("check")}<span>Server online and accepting readings</span></li>
                            <li class="active"><span class="led blink"></span><span>Checking connection: listening on <code>/api/sensor_data</code></span></li>
                            <li class="pending"><span class="led led-off"></span><span>Waiting for sensor readings</span></li>
                        </ul>
                        <div class="actions">
                            <a class="btn btn-secondary" href="#/esp32">Connection details</a>
                            <button type="button" class="btn btn-ghost" data-action="start-sim">Run the simulator instead</button>
                        </div>
                    </div>
                </section>`);
        },
    };
}

function SimBanner(el) {
    return {
        update(v) {
            if (!v.simulator) return setHTML(el, "");
            setHTML(el, `
                <div class="sim-banner" role="status">
                    <span class="sim-dot"></span>
                    <strong>Simulation mode active</strong>
                    <span class="sim-detail">Scenario: ${esc(scenarioLabel(v.scenario))} · readings are generated, not measured</span>
                    <a href="#/simulator">Manage${icon("arrow-right")}</a>
                </div>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Process schematic: tank -> pump -> flow meter -> field
// ---------------------------------------------------------------------------

// What the water line is doing, judged by the same flow rules as the
// backend's leak/blockage detection
function lineState(v) {
    if (!v.reading || v.waiting || v.offline) return { cls: "idle", label: "" };
    const flow = v.value("water_flow");
    if (flow === null) return { cls: "unknown", label: "No flow sensor" };
    if (v.pumpOn && flow < FLOW_FAULT_THRESHOLD) return { cls: "warn", label: "No flow" };
    if (!v.pumpOn && flow > FLOW_FAULT_THRESHOLD) return { cls: "fault", label: "Flow with pump off" };
    if (v.pumpOn) return { cls: "flowing", label: `${fmt(flow, 2)} L/min` };
    return { cls: "idle", label: "" };
}

const level = (value, top, height) => (value === null ? "" : `y="${(top + height * (1 - value / 100)).toFixed(1)}" height="${(height * value / 100).toFixed(1)}"`);

function tankSymbol(value, tone) {
    return `<svg class="sym" viewBox="0 0 48 56" aria-hidden="true">
        ${value === null ? "" : `<rect class="sym-water tone-${tone}" x="9" width="30" ${level(value, 5, 46)}/>`}
        <rect class="sym-body" x="8" y="4" width="32" height="48" rx="1.5"/>
        <line class="sym-mark" x1="8" x2="40" y1="${(4 + 48 * (1 - LOW_TANK_THRESHOLD / 100)).toFixed(1)}" y2="${(4 + 48 * (1 - LOW_TANK_THRESHOLD / 100)).toFixed(1)}"/>
    </svg>`;
}

function pumpSymbol(on) {
    return `<svg class="sym sym-pump ${on ? "is-on" : ""}" viewBox="0 0 48 56" aria-hidden="true">
        <circle class="sym-body" cx="24" cy="28" r="18"/>
        <path class="sym-fill" d="M17 17 L37 28 L17 39 Z"/>
    </svg>`;
}

function meterSymbol(tag) {
    return `<svg class="sym" viewBox="0 0 48 56" aria-hidden="true">
        <circle class="sym-body" cx="24" cy="28" r="16"/>
        <line class="sym-body" x1="8" x2="40" y1="28" y2="28"/>
        <text class="sym-text" x="24" y="24.5" text-anchor="middle">${tag}</text>
    </svg>`;
}

function fieldSymbol(value, threshold) {
    const y = (t) => (22 + 28 * (1 - t / 100)).toFixed(1);
    return `<svg class="sym sym-field" viewBox="0 0 64 56" aria-hidden="true">
        <rect class="sym-soil" x="4" y="22" width="56" height="28"/>
        ${value === null ? "" : `<rect class="sym-moisture" x="4" width="56" ${level(value, 22, 28)}/>`}
        <rect class="sym-body" x="4" y="22" width="56" height="28"/>
        ${threshold === null ? "" : `<line class="sym-mark" x1="4" x2="60" y1="${y(threshold)}" y2="${y(threshold)}"/>`}
        <path class="sym-crop" d="M16 22v-9 M16 16c-3.5 0-5.5-2-5.5-5 3.5 0 5.5 2 5.5 5z M32 22v-12 M32 14c3.5 0 5.5-2 5.5-5-3.5 0-5.5 2-5.5 5z M48 22v-9 M48 16c-3.5 0-5.5-2-5.5-5 3.5 0 5.5 2 5.5 5z"/>
    </svg>`;
}

function node(symbol, tag, name, value, state) {
    return `<div class="node">
        <div class="node-sym">${symbol}</div>
        <div class="node-text">
            <small><span class="node-tag">${tag}</span>${esc(name)}</small>
            <strong>${value}</strong>
            <span class="node-state">${state}</span>
        </div>
    </div>`;
}

function Process(el) {
    return {
        update(v) {
            const live = v.loaded && !v.waiting;
            const read = (key, decimals, unit) => {
                if (!v.loaded) return skeleton("3em");
                const value = v.value(key);
                return !live || value === null ? `<span class="is-na">—</span>` : `${fmt(value, decimals)}<em>${unit}</em>`;
            };
            const tank = v.value("water_tank_level");
            const moisture = v.value("soil_moisture");
            const tankState = live ? tankStatus(tank) : { tone: "muted", label: "No reading" };
            const line = lineState(v);
            // The whole line shares one state; only the metered segment is labelled
            const pipe = (label) => `<div class="pipe pipe-${line.cls}">${label && line.cls === "flowing" ? `<span class="pipe-label">${esc(line.label)}</span>` : ""}</div>`;
            const lineTag = !v.loaded ? null
                : line.cls === "fault" ? ["critical", "Leak"]
                : line.cls === "warn" ? ["warning", "No flow"]
                : v.pumpOn ? ["good", "Irrigating"]
                : ["muted", "Idle"];
            const pumpText = !v.loaded ? skeleton("2em") : v.reading ? esc(v.reading.pump_status) : v.waiting ? "OFF" : "—";
            const moistureState = live ? v.moistureStatus : { tone: "muted", label: v.waiting ? "Waiting for ESP32" : "No reading" };

            const env = [
                ["TT", "Air temperature", read("air_temperature", 1, "°C")],
                ["HT", "Humidity", read("humidity", 1, "%")],
                ["", "Growth stage", esc(v.stage || "—")],
                ["", "Threshold", v.threshold === null ? "—" : `${v.threshold}<em>%</em>`],
                ["", "Data source", v.loaded ? (v.simulator ? "Simulator" : "ESP32") : "—"],
            ];

            setHTML(el, `
                <section class="card process">
                    ${cardHead("Irrigation process · Zone 1",
                        lineTag ? `<span class="status-tag tone-${lineTag[0]}">${lineTag[1]}</span>` : "")}
                    <div class="process-line">
                        ${node(tankSymbol(live ? tank : null, tankState.tone === "good" ? "water" : tankState.tone), "LT", "Water tank",
                            read("water_tank_level", 1, "%"), live && tank !== null ? pill(tankState.tone, tankState.label) : "")}
                        ${pipe(false)}
                        ${node(pumpSymbol(v.pumpOn), "P-1", "Pump", pumpText,
                            v.loaded ? pill(v.pumpOn ? "good" : "muted", v.forced ? "Scenario override" : v.autoMode ? "Automatic" : "Manual") : "")}
                        ${pipe(true)}
                        ${node(meterSymbol("FT"), "FT", "Flow", read("water_flow", 2, "L/min"),
                            line.cls === "fault" ? pill("critical", "Flow with pump off")
                                : line.cls === "warn" ? pill("warning", "Pump on, no flow")
                                : line.cls === "flowing" ? pill("good", "Flowing")
                                : line.cls === "unknown" ? pill("muted", "No flow sensor") : "")}
                        ${pipe(false)}
                        ${node(fieldSymbol(live ? moisture : null, v.threshold), "MT", "Zone 1 soil moisture",
                            read("soil_moisture", 1, "%"), v.loaded ? pill(moistureState.tone, moistureState.label) : "")}
                    </div>
                    <dl class="process-env">
                        ${env.map(([tag, label, value]) => `<div><dt>${tag ? `<span class="node-tag">${tag}</span>` : ""}${label}</dt><dd>${value}</dd></div>`).join("")}
                    </dl>
                </section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Metric tile (summary strip + Farm Monitor)
// ---------------------------------------------------------------------------

function metricSub(key, v) {
    const value = v.value(key);
    if (key === "pump_status") {
        if (v.waiting) return pill("muted", "Held until first reading");
        return pill(v.autoMode ? "good" : "info", v.forced ? "Scenario override" : v.autoMode ? "Automatic" : "Manual");
    }
    if (key === "growth_stage") return v.threshold === null ? "" : `<span class="sub-text">Threshold ${v.threshold}%</span>`;
    if (v.waiting) return `<span class="sub-text">Waiting for ESP32</span>`;
    if (value === null) return `<span class="sub-text">${v.simulator ? "No reading" : "Not reported by controller"}</span>`;

    switch (key) {
        case "soil_moisture":
            return pill(v.moistureStatus.tone, v.moistureStatus.label);
        case "air_temperature": {
            const guide = STAGE_TEMPERATURE_GUIDE[v.stage];
            if (!guide) return "";
            const inside = value >= guide[0] && value <= guide[1];
            return pill(inside ? "good" : "warning", inside ? "Within stage guide" : `Outside ${guide[0]}–${guide[1]}°C guide`);
        }
        case "water_tank_level": {
            const status = tankStatus(value);
            return pill(status.tone, status.label);
        }
        case "water_flow":
            if (v.pumpOn) {
                return value < FLOW_FAULT_THRESHOLD ? pill("warning", "Pump on, no flow") : pill("good", "Pump running");
            }
            return value > FLOW_FAULT_THRESHOLD ? pill("critical", "Flow with pump off") : `<span class="sub-text">No flow</span>`;
        case "humidity":
            return `<span class="sub-text">Relative humidity</span>`;
        case "soil_temperature":
            return `<span class="sub-text">Root zone</span>`;
        default:
            return "";
    }
}

function Metric(el, opts, ctx) {
    const key = opts.metric;
    const meta = METRICS[key];
    el.innerHTML = `
        <div class="metric ${opts.spark ? "metric-lg" : ""}">
            <div class="metric-head">
                <span class="metric-icon">${icon(meta.icon)}</span>
                <span class="metric-label">${esc(meta.label)}</span>
            </div>
            <div class="metric-value">
                <span class="num" data-slot="num">—</span>
                ${meta.unit ? `<span class="unit">${esc(meta.unit)}</span>` : ""}
            </div>
            <div class="metric-sub" data-slot="sub"></div>
            ${opts.spark ? `<div class="metric-spark" data-slot="spark"></div>` : ""}
        </div>`;
    const s = slotsOf(el);
    const root = el.firstElementChild;

    return {
        update(v) {
            if (meta.text) {
                let text = key === "pump_status" ? (v.reading ? v.reading.pump_status : v.waiting ? "OFF" : null) : v.stage;
                if (!v.loaded) setHTML(s.num, skeleton("3em", "0.9em"));
                else setHTML(s.num, esc(text || "—"));
                root.classList.toggle("is-on", key === "pump_status" && v.pumpOn);
            } else {
                setNumber(s.num, v.value(key), meta.decimals, v);
            }
            setHTML(s.sub, v.loaded ? metricSub(key, v) : skeleton("70%"));

            if (s.spark) {
                const rows = ctx.store.recent(SPARK_READINGS);
                const values = rows.map((row) => row[key]);
                const reference = key === "soil_moisture" ? v.threshold : null;
                setHTML(s.spark, v.waiting || !values.some(isNum)
                    ? `<div class="spark spark-empty" style="height:40px"></div><p class="spark-caption">No recent readings</p>`
                    : `${sparkline(values, { height: 40, reference, metric: key })}<p class="spark-caption">Last ${values.length} readings</p>`);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Soil moisture hero
// ---------------------------------------------------------------------------

function SoilHero(el, _opts, ctx) {
    el.innerHTML = `
        <section class="card soil-hero">
            ${cardHead("Soil moisture", `<div data-slot="pill"></div>`)}
            <div class="soil-main">
                <div class="soil-reading"><span class="num" data-slot="num">—</span><span class="unit">%</span></div>
                <div class="soil-status">
                    <p class="soil-status-label" data-slot="label"></p>
                    <p class="soil-trend" data-slot="trend"></p>
                    <p class="soil-updated" data-slot="updated"></p>
                </div>
            </div>
            <div class="range" aria-hidden="true">
                <div class="range-track">
                    <div class="range-band" data-slot="band"></div>
                    <div class="range-threshold" data-slot="threshold"></div>
                    <div class="range-marker" data-slot="marker"></div>
                </div>
                <div class="range-scale"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
            </div>
            <div class="soil-legend" data-slot="legend"></div>
            <div class="soil-spark" data-slot="spark"></div>
            <div class="soil-foot" data-slot="foot"></div>
        </section>`;
    const s = slotsOf(el);

    const updated = (v) => {
        if (!v.loaded || v.waiting || !v.readingAt) return setText(s.updated, "");
        setText(s.updated, `Updated ${timeAgo(v.readingAge)}`);
    };

    return {
        tick: updated,
        update(v) {
            updated(v);
            const moisture = v.value("soil_moisture");
            setNumber(s.num, moisture, 1, v);
            const status = v.waiting ? { tone: "muted", label: "Waiting for ESP32" } : v.moistureStatus;
            setHTML(s.pill, v.loaded ? pill(status.tone, status.label) : "");
            setText(s.label, v.loaded ? status.label : "");
            s.label.className = `soil-status-label tone-${status.tone}`;
            setHTML(s.trend, v.trend ? `${icon(v.trend.icon)}${esc(v.trend.text)}` : v.waiting || !v.loaded ? "" : `${icon("minus")}Trend: collecting readings`);

            if (v.band) {
                s.band.style.left = `${v.band[0]}%`;
                s.band.style.width = `${v.band[1] - v.band[0]}%`;
                s.threshold.style.left = `${v.band[0]}%`;
            }
            s.marker.hidden = moisture === null;
            if (moisture !== null) {
                s.marker.style.left = `${Math.max(0, Math.min(100, moisture))}%`;
                s.marker.className = `range-marker tone-${v.moistureStatus.tone}`;
            }

            setHTML(s.legend, v.band
                ? `<span><i class="lg-threshold"></i>Threshold ${v.band[0]}%</span>
                   <span><i class="lg-band"></i>Optimal ${v.band[0]}–${v.band[1]}%</span>
                   <span class="lg-stage">${icon("sprout")}${esc(v.stage)} stage</span>`
                : "");

            const values = ctx.store.recent(SPARK_READINGS).map((row) => row.soil_moisture);
            setHTML(s.spark, !v.waiting && values.filter(isNum).length > 1
                ? `<div class="soil-spark-head"><span>Recent trend</span><span>Last ${values.length} readings</span></div>${sparkline(values, { height: 56, reference: v.threshold, metric: "soil_moisture" })}`
                : "");

            const f = v.forecast;
            setHTML(s.foot, f && f.state !== "unknown"
                ? `${icon("clock")}<span><strong>${esc(f.headline)}</strong> ${esc(f.detail)}</span>`
                : f ? `${icon("clock")}<span>${esc(f.detail)}</span>` : "");
        },
    };
}

// ---------------------------------------------------------------------------
// AI Farm Intelligence
// ---------------------------------------------------------------------------

function modelBlock(v) {
    const ai = v.ai;
    if (!v.loaded) return skeleton("80%");
    if (!ai || !ai.available) {
        return `<div class="ai-model is-off">${icon("info")}<span>ML model: ${esc((ai && ai.message) || "Not available")}</span></div>`;
    }
    const likely = /needed/i.test(ai.prediction);
    return `<div class="ai-model">
        <span class="ai-model-label">ML prediction</span>
        <strong class="tone-${likely ? "warning" : "good"}">${esc(ai.prediction)}</strong>
        <span class="meter" title="${ai.confidence}% confidence"><span style="width:${Math.max(0, Math.min(100, ai.confidence))}%"></span></span>
        <span class="ai-conf">${fmt(ai.confidence, 1)}%</span>
    </div>`;
}

function aiCardHTML(v, { link = true } = {}) {
    const summary = aiSummary(v);
    const next = nextIrrigation(v);
    const water = waterPerRun(v.events);
    return `
        <section class="card ai-card tone-${summary.tone}">
            <div class="card-head"><h2 class="section-label">AI Farm Intelligence</h2></div>
            <div class="ai-headline">
                <span class="ai-icon">${icon(summary.icon)}</span>
                <h3>${esc(summary.headline)}</h3>
            </div>
            <p class="ai-body">${esc(summary.body)}</p>
            <div class="ai-stats">
                <div>
                    <small>Next recommended irrigation</small>
                    <strong>${esc(next.value)}</strong>
                    <span>${esc(next.sub)}</span>
                </div>
                <div>
                    <small>Typical water per irrigation</small>
                    <strong>${water.value === null ? "—" : `${fmt(water.value, 1)} L`}</strong>
                    <span>${esc(water.sub)}</span>
                </div>
            </div>
            ${modelBlock(v)}
            ${link ? `<a class="btn btn-secondary btn-sm btn-ai" href="#/ai">View AI recommendation${icon("arrow-right")}</a>` : ""}
        </section>`;
}

function AiCard(el) {
    return { update: (v) => setHTML(el, aiCardHTML(v)) };
}

const FORECAST_TONES = { drying: "info", "dry-now": "warning", filling: "info", satisfied: "good", steady: "good", unknown: "muted" };
const FORECAST_LABELS = { drying: "Drying", "dry-now": "Below threshold", filling: "Refilling", satisfied: "Irrigated", steady: "Steady", unknown: "Collecting" };

function forecastHTML(v) {
    const f = v.forecast;
    let body;
    if (!v.loaded) body = `<p>${skeleton("60%", "1.6em")}</p><p>${skeleton("80%")}</p>`;
    else if (v.waiting || !f) body = `<p class="big-stat muted">—</p><p class="muted">The forecast starts once readings arrive.</p>`;
    else {
        body = `
            <div class="forecast-row">
                <p class="big-stat">${esc(f.headline === "--" ? "—" : f.headline)}</p>
                ${pill(FORECAST_TONES[f.state] || "muted", FORECAST_LABELS[f.state] || f.state)}
            </div>
            <p class="muted">${esc(f.detail)}</p>
            ${isNum(f.rate_per_minute) ? `<p class="fine">Measured rate: ${f.rate_per_minute > 0 ? "+" : ""}${f.rate_per_minute} %/min from stored readings</p>` : ""}`;
    }
    return `<section class="card">${cardHead("Moisture forecast")}${body}</section>`;
}

function Forecast(el) {
    return { update: (v) => setHTML(el, forecastHTML(v)) };
}

function AiDetail(el) {
    return {
        update(v) {
            const ai = v.ai;
            const fert = v.status && v.status.fertigation;
            const advisories = v.issues.filter((i) => i.kind === "Advisory");

            const mlCard = !v.loaded
                ? skeleton("100%", "4em")
                : ai && ai.available
                    ? `<div class="forecast-row"><p class="big-stat">${esc(ai.prediction)}</p></div>
                       <div class="confidence"><span class="meter meter-lg"><span style="width:${ai.confidence}%"></span></span><strong>${fmt(ai.confidence, 1)}% confidence</strong></div>
                       <p class="fine">Predicted ${esc(dateTime(parseTimestamp(ai.timestamp)))}</p>`
                    : `<p class="big-stat muted">Unavailable</p><p class="muted">${esc((ai && ai.message) || "No prediction yet.")}</p>`;

            const fertCard = !fert
                ? `<p class="big-stat muted">—</p><p class="muted">${v.waiting ? "Available once readings arrive." : "No assessment yet."}</p>`
                : `<div class="forecast-row"><p class="big-stat">${esc(fert.headline)}</p>${pill(fert.ok ? "good" : "info", fert.ok ? "Good window" : "Hold off")}</div>
                   <ul class="reasons">${(fert.reasons || []).map((r) => `<li>${esc(r.charAt(0).toUpperCase() + r.slice(1))}</li>`).join("")}</ul>
                   <p class="fine">${esc(fert.note || "")}</p>`;

            setHTML(el, `
                <div class="grid grid-hero">
                    ${aiCardHTML(v, { link: false })}
                    <section class="card">
                        ${cardHead("ML irrigation prediction")}
                        ${mlCard}
                        <p class="card-note">A random-forest model trained on soil moisture, soil and air temperature, humidity, growth stage and recent watering. It's predictive only and never switches the pump.</p>
                    </section>
                </div>
                <div class="grid grid-3">
                    ${forecastHTML(v)}
                    <section class="card">${cardHead("Fertigation window")}${fertCard}</section>
                    <section class="card">
                        ${cardHead("Advisories")}
                        ${advisories.length
                            ? `<ul class="alert-list">${advisories.map(alertItem).join("")}</ul>`
                            : emptyBlock("check-circle", "No advisories", v.waiting ? "Advisories start with the first reading." : "Nothing to adjust right now.")}
                    </section>
                </div>
                <section class="card">
                    ${cardHead("How decisions are made")}
                    <div class="explain-grid">
                        <div><span class="explain-icon">${icon("droplet")}</span><h4>Irrigation controller</h4><p>A deterministic rule decides the pump. ${esc(autoRuleText(v))}.</p></div>
                        <div><span class="explain-icon">${icon("insight")}</span><h4>AI prediction</h4><p>The ML model looks ahead: is the crop trending toward needing water soon? It informs you and doesn't act.</p></div>
                        <div><span class="explain-icon">${icon("clock")}</span><h4>Moisture forecast</h4><p>Measures how fast the soil is actually drying from stored readings, then projects when the threshold will be crossed.</p></div>
                        <div><span class="explain-icon">${icon("info")}</span><h4>Advisories</h4><p>Rules over measured data (recent watering, tank level, usage, drying rate) that suggest when to hold off.</p></div>
                    </div>
                </section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Environmental chart
// ---------------------------------------------------------------------------

function EnvChartComponent(el, opts, ctx) {
    return new EnvChart(el, opts, ctx.store);
}

// ---------------------------------------------------------------------------
// Irrigation control
// ---------------------------------------------------------------------------

// A pump command takes effect on the controller's next cycle, so remember what
// was asked for and show "waiting" until a reading confirms it
let pumpPending = null;

function IrrigationControl(el, opts) {
    const compact = opts.variant === "compact";

    el.addEventListener("click", async (e) => {
        const modeBtn = e.target.closest("[data-mode]");
        if (modeBtn) {
            const auto = modeBtn.dataset.mode === "auto";
            if (!auto) {
                const ok = await confirmDialog({
                    title: "Switch to manual control?",
                    body: "Automatic irrigation stops. The pump holds its commanded state until you start or stop it, or switch back to automatic.",
                    confirmLabel: "Switch to manual",
                    iconName: "power",
                });
                if (!ok) return;
            }
            runAction(modeBtn, () => api.setAutoMode(auto), auto ? "Automatic irrigation enabled" : "Manual control enabled");
            return;
        }
        const pumpBtn = e.target.closest("[data-pump]");
        if (pumpBtn) {
            const on = pumpBtn.dataset.pump === "on";
            if (on) {
                const ok = await confirmDialog({
                    title: "Start the pump?",
                    body: "Water will flow until you stop the pump or switch back to automatic irrigation.",
                    confirmLabel: "Start pump",
                    iconName: "power",
                });
                if (!ok) return;
            }
            const result = await runAction(pumpBtn, () => api.setPump(on));
            if (result) {
                pumpPending = { on, at: Date.now() };
                toast(`${on ? "Start" : "Stop"} command sent to pump`, "good");
            }
        }
    });

    return {
        update(v) {
            const msg = systemMessage(v);
            if (pumpPending && v.reading && v.pumpOn === pumpPending.on) pumpPending = null;
            if (pumpPending && Date.now() - pumpPending.at > 30000) pumpPending = null;

            let feedback = "";
            if (!v.autoMode) {
                if (v.waiting || v.offline) feedback = `${icon("info")}Commands are held until the controller reports again.`;
                else if (v.forced) feedback = `${icon("info")}The running scenario overrides manual commands.`;
                else if (pumpPending) feedback = `<span class="spinner spinner-sm"></span>Command sent. Waiting for the controller to confirm…`;
                else feedback = `${icon("check")}Pump confirmed ${v.pumpOn ? "ON" : "OFF"}`;
            }

            const pumpLabel = v.reading ? v.reading.pump_status : v.waiting ? "OFF" : "—";
            setHTML(el, `
                <section class="card irr">
                    ${cardHead("Irrigation control", compact ? `<a href="#/irrigation" class="link-sm">Open</a>` : "")}
                    <div class="readouts">
                        <div class="readout">
                            <small>Pump</small>
                            <strong class="${v.pumpOn ? "is-on" : ""}"><span class="led ${v.pumpOn ? "led-on" : "led-off"}"></span>${!v.loaded ? skeleton("2em") : esc(pumpLabel)}</strong>
                        </div>
                        <div class="readout">
                            <small>Mode</small>
                            <strong>${!v.loaded ? skeleton("5em") : v.autoMode ? "AUTOMATIC" : "MANUAL"}</strong>
                        </div>
                    </div>
                    <div class="irr-status tone-${msg.tone}">
                        <small>System status</small>
                        <p>${esc(msg.text)}</p>
                    </div>
                    ${v.autoMode ? "" : `
                        <div class="pump-cmd">
                            <small>Pump command</small>
                            <div class="btn-row">
                                <button type="button" class="btn btn-sm btn-cmd" data-pump="on" aria-pressed="${v.manualPumpOn}">Start pump</button>
                                <button type="button" class="btn btn-sm btn-cmd" data-pump="off" aria-pressed="${!v.manualPumpOn}">Stop pump</button>
                            </div>
                            <p class="pump-feedback">${feedback}</p>
                        </div>`}
                    <div class="irr-foot">
                        <button type="button" class="btn btn-secondary btn-sm" data-mode="${v.autoMode ? "manual" : "auto"}" ${v.loaded ? "" : "disabled"}>
                            ${v.autoMode ? "Switch to manual" : "Switch to automatic"}
                        </button>
                        <p class="irr-rule">Auto rule: ${esc(autoRuleText(v))}</p>
                    </div>
                </section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Water tank
// ---------------------------------------------------------------------------

function Tank(el, opts, ctx) {
    const compact = opts.variant === "compact";
    el.innerHTML = `
        <section class="card tank-card">
            ${cardHead("Water tank", `<div data-slot="pill"></div>`)}
            <div class="tank-layout">
                <div class="tank-vessel" data-slot="vessel" role="img">
                    <div class="tank-water" data-slot="water"></div>
                    <span class="tank-mark" style="bottom:75%">75</span>
                    <span class="tank-mark" style="bottom:50%">50</span>
                    <span class="tank-mark" style="bottom:25%">25</span>
                    <span class="tank-low" style="bottom:${LOW_TANK_THRESHOLD}%"><span>Low</span></span>
                    <span class="tank-empty-label" data-slot="emptyLabel"></span>
                </div>
                <div class="tank-stats">
                    <div class="tank-pct"><span class="num" data-slot="num">—</span><span class="unit">%</span></div>
                    <p class="tank-liters" data-slot="liters"></p>
                    <dl class="kv" data-slot="kv"></dl>
                </div>
            </div>
            ${compact ? "" : `<div class="soil-spark" data-slot="spark"></div>`}
        </section>`;
    const s = slotsOf(el);

    return {
        update(v) {
            const level = v.value("water_tank_level");
            setNumber(s.num, level, 1, v);
            const status = v.waiting ? { tone: "muted", label: "Waiting" } : tankStatus(level);
            setHTML(s.pill, v.loaded ? pill(status.tone, status.label) : "");
            s.water.style.height = `${level === null ? 0 : Math.max(0, Math.min(100, level))}%`;
            s.water.className = `tank-water tone-${status.tone} ${level === null || level <= 0 ? "is-zero" : ""}`;
            s.vessel.setAttribute("aria-label", level === null ? "Tank level unknown" : `Tank ${level}% full`);
            setText(s.emptyLabel, !v.loaded || level !== null ? "" : v.waiting ? "Waiting" : "No reading");

            const capacity = tankCapacity();
            setHTML(s.liters, level === null
                ? ""
                : capacity
                    ? `≈ <strong>${fmt((level / 100) * capacity, 0)} L</strong> of ${fmt(capacity, 0)} L`
                    : `<a href="#/settings" class="link-sm">Set tank capacity</a> to estimate litres`);

            const water = v.water || {};
            const flow = v.value("water_flow");
            setHTML(s.kv, `
                <div><dt>Used today</dt><dd>${isNum(water.daily_total_liters) ? `${fmt(water.daily_total_liters, 1)} L` : "—"}</dd></div>
                <div><dt>All time</dt><dd>${isNum(water.total_liters) ? `${fmt(water.total_liters, 1)} L` : "—"}</dd></div>
                <div><dt>Flow now</dt><dd>${flow === null ? "—" : `${fmt(flow, 2)} L/min`}</dd></div>`);

            if (s.spark) {
                const values = ctx.store.recent(SPARK_READINGS).map((row) => row.water_tank_level);
                setHTML(s.spark, !v.waiting && values.filter(isNum).length > 1
                    ? `<div class="soil-spark-head"><span>Tank level trend</span><span>Last ${values.length} readings</span></div>${sparkline(values, { height: 56, reference: LOW_TANK_THRESHOLD, metric: "water_tank_level" })}`
                    : "");
            }
        },
    };
}

function WaterUsage(el) {
    el.innerHTML = `
        <section class="card">
            ${cardHead("Water usage")}
            <div class="usage-grid">
                <div><small>Today</small><p class="big-stat"><span class="num" data-slot="today">—</span><span class="unit">L</span></p></div>
                <div><small>All time</small><p class="big-stat"><span class="num" data-slot="total">—</span><span class="unit">L</span></p></div>
                <div><small>Per irrigation run</small><p class="big-stat"><span class="num" data-slot="run">—</span><span class="unit">L</span></p><p class="fine" data-slot="runSub"></p></div>
            </div>
            <p class="card-note">Measured from the flow sensor every cycle, including water lost to leaks.</p>
        </section>`;
    const s = slotsOf(el);
    const always = { loaded: true, waiting: false };

    return {
        update(v) {
            const water = v.water || {};
            const run = waterPerRun(v.events);
            const ready = v.loaded ? always : v;
            setNumber(s.today, isNum(water.daily_total_liters) ? water.daily_total_liters : null, 2, ready);
            setNumber(s.total, isNum(water.total_liters) ? water.total_liters : null, 2, ready);
            setNumber(s.run, run.value, 1, ready);
            setText(s.runSub, run.sub);
        },
    };
}

// ---------------------------------------------------------------------------
// Alerts + events
// ---------------------------------------------------------------------------

const SEVERITY_ICONS = { critical: "critical", warning: "warning", info: "info" };

function alertItem(issue) {
    return `<li class="alert alert-${issue.severity}">
        <span class="alert-icon">${icon(SEVERITY_ICONS[issue.severity])}</span>
        <div class="alert-text">
            <p class="alert-title">${esc(issue.title)}<span class="alert-kind">${esc(issue.kind)}</span></p>
            <p class="alert-msg">${esc(issue.message)}</p>
        </div>
        ${issue.at ? `<time>${esc(dateTime(issue.at))}</time>` : ""}
    </li>`;
}

function Alerts(el, opts) {
    const limit = opts.limit ? parseInt(opts.limit, 10) : null;
    return {
        update(v) {
            if (!v.loaded) {
                return setHTML(el, `<ul class="alert-list">${[1, 2].map(() => `<li class="alert">${skeleton("100%", "2.2em")}</li>`).join("")}</ul>`);
            }
            if (!v.issues.length) {
                const text = v.waiting ? "Monitoring starts with the first ESP32 reading." : "No faults, advisories or warnings.";
                return setHTML(el, `<div class="all-clear ${opts.compact ? "compact" : ""}">
                    <span class="all-clear-icon">${icon("check")}</span>
                    <div><p>${v.waiting ? "No alerts yet" : "System operating normally"}</p><small>${text}</small></div>
                </div>`);
            }
            const shown = limit ? v.issues.slice(0, limit) : v.issues;
            const more = v.issues.length - shown.length;
            setHTML(el, `<ul class="alert-list ${opts.compact ? "compact" : ""}">${shown.map(alertItem).join("")}</ul>
                ${more > 0 ? `<a class="more-link" href="#/alerts">+${more} more${icon("arrow-right")}</a>` : ""}`);
        },
    };
}

function Events(el) {
    return {
        update(v) {
            const events = v.events || [];
            let body;
            if (!v.loaded) body = skeleton("100%", "6em");
            else if (!events.length) body = emptyBlock("droplet", "No irrigation events yet", "Every pump start and stop is logged here with its reason, duration and water used.");
            else {
                body = `<div class="table-wrap"><table class="table">
                    <thead><tr><th>Time</th><th>Action</th><th>Reason</th><th class="num-col">Duration</th><th class="num-col">Water used</th></tr></thead>
                    <tbody>${events.map((e) => `
                        <tr>
                            <td class="nowrap">${esc(dateTime(parseTimestamp(e.timestamp)))}</td>
                            <td>${e.action === "PUMP_ON" ? pill("info", "Pump on") : pill("muted", "Pump off")}</td>
                            <td>${esc(e.reason || "—")}</td>
                            <td class="num-col">${isNum(e.duration_seconds) ? `${fmt(e.duration_seconds, 0)} s` : "—"}</td>
                            <td class="num-col">${isNum(e.water_used_liters) ? `${fmt(e.water_used_liters, 2)} L` : "—"}</td>
                        </tr>`).join("")}</tbody>
                </table></div>`;
            }
            setHTML(el, `<section class="card">${cardHead("Irrigation log")}${body}</section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Growth stages
// ---------------------------------------------------------------------------

function Growth(el, opts) {
    const compact = opts.variant === "compact";

    el.addEventListener("click", (e) => {
        const button = e.target.closest("[data-stage]");
        if (!button || button.getAttribute("aria-current") === "step") return;
        const stage = button.dataset.stage;
        runAction(button, () => api.setGrowthStage(stage), `Growth stage set to ${stage}`);
    });

    return {
        update(v) {
            const stages = (v.stages || []).map((s) => s.stage_name);
            if (!v.loaded || !stages.length) {
                return setHTML(el, `<section class="card">${cardHead("Growth stage")}${skeleton("100%", "4em")}</section>`);
            }
            const current = stages.indexOf(v.stage);
            const steps = stages.concat(LIFECYCLE_END);
            const progress = current < 0 ? 0 : (current / (steps.length - 1)) * 100;
            const thresholds = Object.fromEntries((v.stages || []).map((s) => [s.stage_name, s.moisture_threshold]));

            const lifecycle = `
                <div class="lifecycle-wrap"><div class="lifecycle-inner">
                    <div class="lifecycle-line"><span style="width:${progress}%"></span></div>
                    <ol class="lifecycle">
                        ${steps.map((name, i) => {
                            const end = name === LIFECYCLE_END;
                            const state = i < current ? "done" : i === current ? "current" : "upcoming";
                            return `<li class="step step-${state} ${end ? "step-end" : ""}">
                                <button type="button" ${end ? "disabled" : `data-stage="${esc(name)}"`} ${i === current ? 'aria-current="step"' : ""}
                                    title="${end ? "End of the crop cycle" : `Set growth stage to ${esc(name)}`}">
                                    <span class="step-dot">${state === "done" ? icon("check") : end ? icon("leaf") : i + 1}</span>
                                    <span class="step-name">${esc(name)}</span>
                                    <span class="step-meta">${end ? "End of cycle" : `${thresholds[name]}% min`}</span>
                                </button>
                            </li>`;
                        }).join("")}
                    </ol>
                </div></div>`;

            const guide = STAGE_TEMPERATURE_GUIDE[v.stage];
            const moisture = v.value("soil_moisture");
            const temp = v.value("air_temperature");
            const conditions = v.waiting
                ? `<strong>—</strong><span>Waiting for ESP32</span>`
                : `<strong>${moisture === null ? "—" : `${moisture}%`} · ${temp === null ? "—" : `${temp}°C`}</strong>${pill(v.moistureStatus.tone, v.moistureStatus.label)}`;

            const facts = `
                <div class="stage-facts">
                    <div><small>Current stage</small><strong>${esc(v.stage)}</strong><span>Stage ${current + 1} of ${stages.length}</span></div>
                    <div><small>Recommended moisture</small><strong>${v.band ? `${v.band[0]}–${v.band[1]}%` : "—"}</strong><span>Threshold to saturation</span></div>
                    <div><small>Recommended temperature</small><strong>${guide ? `${guide[0]}–${guide[1]}°C` : "—"}</strong><span>General guideline</span></div>
                    <div><small>Current conditions</small>${conditions}</div>
                </div>`;

            setHTML(el, `
                <section class="card growth-card">
                    ${cardHead("Growth stage", compact ? `<a href="#/growth" class="link-sm">Manage</a>` : `<span class="fine">Select a stage to change the active threshold</span>`)}
                    ${lifecycle}
                    ${facts}
                </section>`);
        },
    };
}

function Thresholds(el) {
    el.addEventListener("click", (e) => {
        const button = e.target.closest("[data-save]");
        if (!button) return;
        const stage = button.dataset.save;
        const input = $(`input[data-stage="${CSS.escape(stage)}"]`, el);
        const value = parseFloat(input.value);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
            input.setAttribute("aria-invalid", "true");
            toast("Enter a threshold between 0 and 100%", "warning");
            return;
        }
        input.removeAttribute("aria-invalid");
        runAction(button, () => api.saveThreshold(stage, value), `${stage} threshold saved at ${value}%`);
    });

    return {
        update(v) {
            // Don't rebuild the table under someone who is typing in it
            if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
            const stages = v.stages || [];
            const rows = stages.map((s) => {
                const active = s.stage_name === v.stage;
                return `<tr class="${active ? "is-active" : ""}">
                    <td><strong>${esc(s.stage_name)}</strong>${active ? pill("good", "Active", "pill-sm") : ""}</td>
                    <td><div class="input-suffix"><input type="number" min="0" max="100" step="1" value="${s.moisture_threshold}" data-stage="${esc(s.stage_name)}" aria-label="${esc(s.stage_name)} moisture threshold"><span>%</span></div></td>
                    <td class="muted">${s.moisture_threshold}–${Math.min(100, s.moisture_threshold + OPTIMAL_BAND)}%</td>
                    <td class="right"><button type="button" class="btn btn-secondary btn-sm" data-save="${esc(s.stage_name)}">Save</button></td>
                </tr>`;
            }).join("");
            setHTML(el, `
                <section class="card">
                    ${cardHead("Moisture thresholds")}
                    <p class="card-note">Below its stage's threshold the simulator's automatic controller starts the pump. Above the threshold +${OPTIMAL_BAND}% the soil counts as saturated.</p>
                    ${!v.loaded ? skeleton("100%", "8em") : `<div class="table-wrap"><table class="table">
                        <thead><tr><th>Stage</th><th>Moisture threshold</th><th>Optimal range</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table></div>`}
                </section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Zones, crop health, sensor table
// ---------------------------------------------------------------------------

function Zones(el) {
    return {
        update(v) {
            const open = $("details", el) ? $("details", el).open : true;
            const moisture = v.value("soil_moisture");
            const readings = ["soil_moisture", "air_temperature", "humidity", "water_tank_level", "water_flow", "soil_temperature"]
                .map((key) => `<div><dt>${esc(METRICS[key].label)}</dt><dd>${v.waiting ? "—" : v.value(key) === null ? "Not reported" : `${fmt(v.value(key), METRICS[key].decimals)} ${METRICS[key].unit}`}</dd></div>`)
                .join("");
            setHTML(el, `
                <details class="card zone" ${open ? "open" : ""}>
                    <summary>
                        <span class="zone-badge">${icon("zones")}</span>
                        <span class="zone-name"><strong>Zone 1</strong><small>${v.simulator ? "Simulated field" : "Main field"} · ${v.simulator ? "Simulator" : esc(v.esp32.address || "ESP32 controller")}</small></span>
                        <span class="zone-stat"><small>Soil moisture</small><strong>${v.waiting || !v.loaded ? "—" : moisture === null ? "—" : `${moisture}%`}</strong></span>
                        <span class="zone-stat"><small>Status</small>${v.loaded ? pill(v.waiting ? "muted" : v.moistureStatus.tone, v.waiting ? "Waiting" : v.moistureStatus.key === "low" ? "Needs irrigation" : v.moistureStatus.label) : ""}</span>
                        <span class="zone-stat"><small>Pump</small><strong class="${v.pumpOn ? "tone-info" : ""}">${v.reading ? esc(v.reading.pump_status) : "OFF"}</strong></span>
                        <span class="zone-chevron">${icon("chevron-down")}</span>
                    </summary>
                    <div class="zone-body">
                        <dl class="kv kv-grid">${readings}
                            <div><dt>Growth stage</dt><dd>${esc(v.stage || "—")}</dd></div>
                            <div><dt>Threshold</dt><dd>${v.threshold === null ? "—" : `${v.threshold}%`}</dd></div>
                            <div><dt>Mode</dt><dd>${v.autoMode ? "Automatic" : "Manual"}</dd></div>
                        </dl>
                        <div class="actions"><a href="#/irrigation" class="btn btn-secondary btn-sm">Irrigation control</a><a href="#/monitor" class="btn btn-ghost btn-sm">Farm monitor</a></div>
                    </div>
                </details>
                <p class="card-note center">This installation has one irrigation zone, driven by a single controller.</p>`);
        },
    };
}

function CropHealth(el) {
    return {
        update(v) {
            if (!v.loaded) return setHTML(el, `<section class="card">${skeleton("100%", "10em")}</section>`);
            if (v.waiting) {
                return setHTML(el, `<section class="card">${cardHead("Crop health")}${emptyBlock("wifi", "Waiting for ESP32 data", "Crop health checks run on live sensor readings.")}</section>`);
            }
            const moisture = v.value("soil_moisture");
            const temp = v.value("air_temperature");
            const humidity = v.value("humidity");
            const guide = STAGE_TEMPERATURE_GUIDE[v.stage];
            const faults = v.issues.filter((i) => i.kind === "Fault");
            const fert = v.status && v.status.fertigation;
            const ai = v.ai;

            const checks = [
                {
                    title: "Soil moisture in optimal range",
                    tone: moisture === null ? "muted" : v.moistureStatus.key === "ok" ? "good" : v.moistureStatus.tone,
                    value: moisture === null ? "No reading" : `${moisture}%`,
                    detail: v.band ? `Target ${v.band[0]}–${v.band[1]}% for ${v.stage}` : "",
                },
                {
                    title: "Air temperature suits the stage",
                    tone: temp === null || !guide ? "muted" : temp >= guide[0] && temp <= guide[1] ? "good" : "warning",
                    value: temp === null ? "No reading" : `${temp}°C`,
                    detail: guide ? `General guideline ${guide[0]}–${guide[1]}°C` : "",
                },
                {
                    title: "Humidity in a moderate band",
                    tone: humidity === null ? "muted" : humidity >= 40 && humidity <= 80 ? "good" : "warning",
                    value: humidity === null ? "No reading" : `${humidity}%`,
                    detail: "General guideline 40–80%: drier stresses plants, wetter favours disease",
                },
                {
                    title: "No active system faults",
                    tone: faults.length ? "critical" : "good",
                    value: faults.length ? `${faults.length} fault${faults.length === 1 ? "" : "s"}` : "Clear",
                    detail: faults.length ? faults.map((f) => f.title).join(", ") : "Leak, blockage, tank and controller checks passing",
                },
                {
                    title: "AI irrigation outlook",
                    tone: !ai || !ai.available ? "muted" : /needed/i.test(ai.prediction) ? "warning" : "good",
                    value: !ai || !ai.available ? "Unavailable" : ai.prediction,
                    detail: !ai || !ai.available ? (ai && ai.message) || "" : `${fmt(ai.confidence, 1)}% confidence`,
                },
                {
                    title: "Fertigation timing",
                    tone: !fert ? "muted" : fert.ok ? "good" : "info",
                    value: fert ? fert.headline : "—",
                    detail: fert ? (fert.reasons || [])[0] || "" : "",
                },
            ];
            const scored = checks.filter((c) => c.tone !== "muted" && c.tone !== "info");
            const passing = scored.filter((c) => c.tone === "good").length;
            const overall = passing === scored.length ? "good" : scored.some((c) => c.tone === "critical") ? "critical" : "warning";

            setHTML(el, `
                <section class="card health-summary tone-${overall}">
                    <span class="health-icon">${icon(TONE_ICONS[overall])}</span>
                    <div>
                        <p class="eyebrow">Crop health</p>
                        <h2>${passing} of ${scored.length} checks passing</h2>
                        <p class="muted">Worked out from live sensor readings against the ${esc(v.stage)} stage. There is no plant-tissue or nutrient sensor, so these are growing-condition checks.</p>
                    </div>
                </section>
                <section class="card">
                    <ul class="check-list">
                        ${checks.map((c) => `
                            <li class="tone-${c.tone}">
                                <span class="check-icon">${icon(TONE_ICONS[c.tone])}</span>
                                <div><p class="check-title">${esc(c.title)}</p><p class="check-detail">${esc(c.detail)}</p></div>
                                <strong class="check-value">${esc(c.value)}</strong>
                            </li>`).join("")}
                    </ul>
                </section>`);
        },
    };
}

const TABLE_KEYS = ["soil_moisture", "air_temperature", "humidity", "water_tank_level", "water_flow", "soil_temperature"];

function SensorTable(el, _opts, ctx) {
    el.addEventListener("click", (e) => {
        if (!e.target.closest("[data-action='csv']")) return;
        const header = ["timestamp", ...TABLE_KEYS];
        const lines = ctx.store.rows.map((row) => [row.timestamp, ...TABLE_KEYS.map((k) => (isNum(row[k]) ? row[k] : ""))].join(","));
        const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `aquagrow-readings-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    });

    return {
        update(v) {
            const rows = ctx.store.rows.slice(-100).reverse();
            let body;
            if (!v.loaded || (!ctx.store.loaded && !v.waiting)) body = skeleton("100%", "12em");
            else if (v.waiting) body = emptyBlock("wifi", "Waiting for ESP32 data", "Readings appear here as soon as the controller reports.");
            else if (!rows.length) body = emptyBlock("table", "No readings yet", "Sensor readings will be listed as they arrive.");
            else {
                body = `<div class="table-wrap table-scroll"><table class="table table-dense">
                    <thead><tr><th>Time</th>${TABLE_KEYS.map((k) => `<th class="num-col">${esc(METRICS[k].short)} <small>${esc(METRICS[k].unit)}</small></th>`).join("")}</tr></thead>
                    <tbody>${rows.map((row) => `<tr><td class="nowrap">${esc(dateTime(new Date(row.t)))}<small class="sec">:${String(new Date(row.t).getSeconds()).padStart(2, "0")}</small></td>${TABLE_KEYS.map((k) => `<td class="num-col">${isNum(row[k]) ? fmt(row[k], METRICS[k].decimals) : `<span class="muted">—</span>`}</td>`).join("")}</tr>`).join("")}</tbody>
                </table></div>`;
            }
            setHTML(el, `
                <section class="card">
                    ${cardHead("Recent readings", `<button type="button" class="btn btn-secondary btn-sm" data-action="csv" ${ctx.store.rows.length ? "" : "disabled"}>${icon("download")}Export CSV</button>`)}
                    <p class="card-note">Latest ${rows.length} of ${ctx.store.rows.length.toLocaleString()} loaded readings, newest first. A dash means the sensor didn't report a valid value. Export includes every loaded reading.</p>
                    ${body}
                </section>`);
        },
    };
}

// ---------------------------------------------------------------------------
// Simulator + ESP32
// ---------------------------------------------------------------------------

function Simulator(el) {
    let view = null;

    el.addEventListener("click", async (e) => {
        if (!view) return;
        const scenarioBtn = e.target.closest("[data-scenario]");
        if (scenarioBtn) {
            const id = scenarioBtn.dataset.scenario;
            const label = scenarioLabel(id);
            if (view.simulator) {
                runAction(scenarioBtn, () => api.setScenario(id), `Scenario: ${label}`);
                return;
            }
            const ok = await confirmDialog({
                title: "Start simulation mode?",
                body: view.esp32.seen
                    ? `The dashboard will switch from live ESP32 readings to simulated ones running the “${label}” scenario. You can switch back from this page.`
                    : `The dashboard will generate simulated readings running the “${label}” scenario.`,
                confirmLabel: "Start simulation",
                iconName: "flask",
            });
            if (!ok) return;
            runAction(scenarioBtn, async () => {
                await api.setScenario(id);
                return api.setSimulatorEnabled(true);
            }, `Simulation started: ${label}`);
            return;
        }
        const toggle = e.target.closest("[data-action]");
        if (!toggle) return;
        if (toggle.dataset.action === "sim-on") runAction(toggle, () => api.setSimulatorEnabled(true), "Simulation mode started");
        if (toggle.dataset.action === "sim-off") runAction(toggle, () => api.setSimulatorEnabled(false), "Switched to the ESP32");
    });

    return {
        update(v) {
            view = v;
            const active = v.simulator;
            const canStop = v.esp32.seen;
            const current = SCENARIOS.find((s) => s.id === v.scenario);
            setHTML(el, `
                <section class="card sim-panel">
                    ${cardHead(active ? `Simulation · ${esc(current ? current.label : v.scenario)}` : "Simulation",
                        `<div class="sim-actions">
                            <span class="status-tag tone-${active ? "good" : "muted"}">${active ? "Active" : "Off"}</span>
                            ${active
                                ? `<button type="button" class="btn btn-secondary btn-sm" data-action="sim-off" ${canStop ? "" : "disabled"} title="${canStop ? "" : "Available once an ESP32 has connected"}">Use ESP32</button>`
                                : `<button type="button" class="btn btn-primary btn-sm" data-action="sim-on">Start simulation</button>`}
                        </div>`)}
                    <p class="card-note">${active
                        ? "Readings are generated every 5 seconds and pass through the same irrigation, alert and AI logic as real sensor data."
                        : v.waiting
                            ? "Waiting for the ESP32. Run a scenario to demonstrate the system without hardware. This switches the data source to the simulator."
                            : "Showing live ESP32 data. Running a scenario switches the data source to the simulator."}
                        ${active && !canStop ? " “Use ESP32” becomes available once a board has connected." : ""}</p>
                    <ul class="scenario-list">
                        ${SCENARIOS.map((s) => {
                            const running = active && s.id === v.scenario;
                            return `<li class="${running ? "is-running" : ""}">
                                <span class="scenario-icon">${icon(s.icon)}</span>
                                <div class="scenario-body"><strong>${esc(s.label)}</strong><small>${esc(s.text)}</small></div>
                                ${running
                                    ? `<span class="status-tag tone-good">Running</span>`
                                    : `<button type="button" class="btn btn-secondary btn-sm" data-scenario="${s.id}">Run</button>`}
                            </li>`;
                        }).join("")}
                    </ul>
                </section>`);
        },
    };
}

function Esp32(el) {
    el.addEventListener("click", (e) => {
        const button = e.target.closest("[data-action]");
        if (!button) return;
        if (button.dataset.action === "use-esp32") runAction(button, () => api.setSimulatorEnabled(false), "Switched to the ESP32");
        if (button.dataset.action === "use-sim") runAction(button, () => api.setSimulatorEnabled(true), "Simulation mode started");
    });

    const component = {
        update(v) {
            const c = v.connection;
            const sensors = ["soil_moisture", "air_temperature", "humidity", "water_tank_level", "water_flow", "soil_temperature"];
            const live = !v.simulator && !v.waiting && v.reading;
            setHTML(el, `
                <section class="card esp-hero tone-${c.tone}">
                    <div class="esp-status">
                        <span class="led led-lg ${c.blink ? "blink" : ""}"></span>
                        <div>
                            <p class="eyebrow">${esc(c.device)}</p>
                            <h2>${esc(c.state)}</h2>
                            <p class="muted">${esc(c.sub)}</p>
                        </div>
                    </div>
                    <dl class="kv kv-grid">
                        <div><dt>Data source</dt><dd>${v.simulator ? "Simulator" : "ESP32"}</dd></div>
                        <div><dt>Board address</dt><dd>${esc(v.esp32.address || "—")}</dd></div>
                        <div><dt>Last reading</dt><dd>${v.esp32.seen ? esc(timeAgo(v.esp32Age)) : "Never"}</dd></div>
                        <div><dt>Offline after</dt><dd>30 s without a post</dd></div>
                    </dl>
                    <div class="actions">
                        <button type="button" class="btn btn-primary btn-sm" data-action="use-esp32" ${v.simulator && v.esp32.seen ? "" : "disabled"}>Use ESP32</button>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="use-sim" ${v.simulator ? "disabled" : ""}>Switch to simulator</button>
                    </div>
                    ${v.simulator && !v.esp32.seen ? `<p class="fine">“Use ESP32” becomes available once a board has posted at least one reading.</p>` : ""}
                </section>
                <div class="grid grid-2">
                    <section class="card">
                        ${cardHead("Sensors reported")}
                        <ul class="sensor-list">
                            ${sensors.map((key) => {
                                const value = v.value(key);
                                const state = !live ? (v.simulator ? "Simulated" : "Waiting") : value === null ? "Not reporting" : `${fmt(value, METRICS[key].decimals)} ${METRICS[key].unit}`;
                                const tone = !live ? "muted" : value === null ? "warning" : "good";
                                return `<li><span class="sensor-icon">${icon(METRICS[key].icon)}</span><span>${esc(METRICS[key].label)}</span>${pill(tone, state)}</li>`;
                            }).join("")}
                        </ul>
                    </section>
                    <section class="card">
                        ${cardHead("Integration")}
                        <ol class="steps">
                            <li><code>POST /api/sensor_data</code><span>Every ~5 seconds the board posts its readings as JSON. The first post switches the dashboard from the simulator to live data.</span></li>
                            <li><code>GET /api/pump_command</code><span>The board then asks what to do with its pump relay and switches it to match.</span></li>
                            <li><code>Auto rule</code><span>Pump on at ${ESP32_PUMP_ON_AT}% soil moisture and off at ${ESP32_PUMP_OFF_AT}%. Pump commands are held off whenever readings go stale.</span></li>
                        </ol>
                        <p class="card-note">Sketch: <code>../esp32-irrigation-sensor/irrigation_sensor/</code></p>
                    </section>
                </div>`);
        },
    };
    component.tick = component.update;
    return component;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function Settings(el) {
    el.addEventListener("submit", (e) => {
        e.preventDefault();
        const form = e.target;
        const capacity = form.capacity.value.trim();
        if (capacity && !(parseFloat(capacity) > 0)) {
            toast("Tank capacity must be a positive number of litres", "warning");
            return;
        }
        prefs.set("tankCapacity", capacity ? String(parseFloat(capacity)) : null);
        prefs.set("defaultRange", form.range.value);
        toast("Settings saved on this device", "good");
        document.dispatchEvent(new CustomEvent("aquagrow:refresh"));
    });

    let built = false;
    return {
        update(v) {
            if (!built) {
                built = true;
                el.innerHTML = `
                    <div class="grid grid-2">
                        <form class="card settings-form">
                            ${cardHead("Display preferences")}
                            <label class="field">
                                <span>Water tank capacity</span>
                                <div class="input-suffix"><input name="capacity" type="number" min="0" step="1" placeholder="e.g. 1000" value="${esc(prefs.get("tankCapacity", ""))}"><span>L</span></div>
                                <small>Used only to turn the tank percentage into an estimate in litres.</small>
                            </label>
                            <label class="field">
                                <span>Default chart range</span>
                                <select name="range">
                                    ${["6h", "24h", "7d", "30d"].map((r) => `<option value="${r}" ${prefs.get("defaultRange", "6h") === r ? "selected" : ""}>${r.toUpperCase()}</option>`).join("")}
                                </select>
                                <small>Applies to charts you haven't set a range on yet.</small>
                            </label>
                            <div class="actions"><button class="btn btn-primary" type="submit">Save preferences</button></div>
                            <p class="fine">Stored in this browser only.</p>
                        </form>
                        <section class="card" data-slot="info"></section>
                    </div>`;
            }
            const info = $("[data-slot='info']", el);
            setHTML(info, `
                ${cardHead("System")}
                <dl class="kv">
                    <div><dt>Data source</dt><dd>${v.simulator ? "Simulator" : "ESP32"}</dd></div>
                    <div><dt>Dashboard refresh</dt><dd>Every 5 seconds</dd></div>
                    <div><dt>Irrigation mode</dt><dd>${v.autoMode ? "Automatic" : "Manual"}</dd></div>
                    <div><dt>Active growth stage</dt><dd>${esc(v.stage || "—")}</dd></div>
                    <div><dt>ML model</dt><dd>${v.ai && v.ai.available ? "Loaded" : esc((v.ai && v.ai.message) || "—")}</dd></div>
                    <div><dt>Last dashboard sync</dt><dd>${v.syncedAt ? esc(clockTime(new Date(v.syncedAt))) : "—"}</dd></div>
                </dl>`);
        },
    };
}

// ---------------------------------------------------------------------------

export const REGISTRY = {
    connection: Connection,
    greeting: Greeting,
    "waiting-state": WaitingState,
    "sim-banner": SimBanner,
    process: Process,
    metric: Metric,
    "soil-hero": SoilHero,
    "ai-card": AiCard,
    "ai-detail": AiDetail,
    forecast: Forecast,
    "env-chart": EnvChartComponent,
    "irrigation-control": IrrigationControl,
    tank: Tank,
    "water-usage": WaterUsage,
    alerts: Alerts,
    events: Events,
    growth: Growth,
    thresholds: Thresholds,
    zones: Zones,
    "crop-health": CropHealth,
    "sensor-table": SensorTable,
    simulator: Simulator,
    esp32: Esp32,
    settings: Settings,
};
