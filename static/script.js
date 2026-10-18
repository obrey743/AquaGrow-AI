// AquaGrow-AI Dashboard - frontend entry point
//
// Polls the Flask API every 5 seconds, derives one view of the farm from the
// responses (static/js/model.js), and hands it to every component on the page
// (static/js/components.js). Controls POST back to the same endpoints as
// always - see static/js/api.js. Pages are client-side routes (#/overview,
// #/irrigation...), so switching between them never reloads or loses state.

import { get } from "./js/api.js";
import { HistoryStore, RANGES, rowsForRange } from "./js/charts.js";
import { REGISTRY } from "./js/components.js";
import { derive } from "./js/model.js";
import { $, $$, prefs } from "./js/ui.js";

const REFRESH_INTERVAL_MS = 5000;
const TICK_INTERVAL_MS = 1000;

// Everything the dashboard polls, keyed by where it lands in state
const ENDPOINTS = {
    latest: "/api/latest",
    status: "/api/status",
    source: "/api/data_source",
    stages: "/api/growth_stages",
    water: "/api/water_usage",
    alerts: "/api/alerts",
    events: "/api/irrigation_events",
    ai: "/api/ai_prediction",
    scenario: "/api/scenario",
};

const state = {
    loaded: false,
    error: false,
    latest: null,
    status: null,
    source: null,
    stages: [],
    water: null,
    alerts: [],
    events: [],
    ai: null,
    scenario: "normal",
    syncedAt: null,
    sourceFetchedAt: Date.now(),
};

const store = new HistoryStore();
state.history = store;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const components = $$("[data-component]")
    .map((el) => {
        const factory = REGISTRY[el.dataset.component];
        if (!factory) {
            console.warn(`Unknown component: ${el.dataset.component}`);
            return null;
        }
        return factory(el, { ...el.dataset }, { store });
    })
    .filter(Boolean);

function render() {
    const v = derive(state);
    components.forEach((component) => {
        try {
            component.update(v);
        } catch (err) {
            console.error("Component failed to render:", err);
        }
    });
    renderChrome(v);
}

// Once a second: just the "4 seconds ago" style text, no data fetch
function tick() {
    if (!state.loaded) return;
    const v = derive(state);
    components.forEach((component) => component.tick && component.tick(v));
}

function renderChrome(v) {
    const alerting = v.issues.filter((i) => i.severity !== "info");
    const count = $("[data-bind='nav-alert-count']");
    count.hidden = !alerting.length;
    count.textContent = alerting.length;
    count.className = `nav-count ${v.faultCount ? "is-critical" : ""}`;

    const dot = $("[data-bind='notif-dot']");
    dot.hidden = !v.issues.length;
    dot.className = `notif-dot ${v.faultCount ? "is-critical" : alerting.length ? "is-warning" : "is-info"}`;
    $("#notif-btn").setAttribute("aria-label", v.issues.length ? `Notifications (${v.issues.length})` : "Notifications");

    $("[data-bind='nav-sim-pill']").hidden = !v.simulator;

    // A silent controller leaves its last readings on screen - dim them so they read as frozen
    document.body.classList.toggle("is-stale", v.offline);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let inFlight = null;
let queued = false;

async function refreshAll() {
    if (inFlight) {
        queued = true; // a control was used mid-poll - fetch again right after
        return inFlight;
    }
    inFlight = (async () => {
        const keys = Object.keys(ENDPOINTS);
        const results = await Promise.allSettled(keys.map((key) => get(ENDPOINTS[key])));

        let succeeded = 0;
        results.forEach((result, i) => {
            const key = keys[i];
            if (result.status !== "fulfilled") {
                console.error(`Failed to fetch ${ENDPOINTS[key]}:`, result.reason);
                return;
            }
            succeeded += 1;
            state[key] = key === "scenario" ? result.value.scenario : result.value;
            if (key === "source") state.sourceFetchedAt = Date.now();
        });

        state.error = succeeded === 0;
        if (succeeded) state.syncedAt = Date.now();
        state.loaded = Boolean(state.latest && state.status && state.source);

        if (state.loaded) {
            // The history endpoint answers per data source - start over when it changes
            const waiting = Boolean(state.latest.waiting_for_esp32);
            store.setKey(`${state.source.simulator_enabled}:${waiting}`);
            const defaultRange = RANGES.find((r) => r.id === prefs.get("defaultRange", "6h")) || RANGES[0];
            await store.poll(rowsForRange(defaultRange.ms));
        }
        render();
    })();

    try {
        await inFlight;
    } finally {
        inFlight = null;
        if (queued) {
            queued = false;
            refreshAll();
        }
    }
}

document.addEventListener("aquagrow:refresh", () => refreshAll());

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

// Old in-page anchors from the previous single-page layout still land somewhere sensible
const LEGACY_ANCHORS = { charts: "analytics", simulate: "simulator", control: "irrigation", thresholds: "growth", events: "alerts" };
const views = $$(".view");

function route() {
    let id = location.hash.replace(/^#\/?/, "") || "overview";
    id = LEGACY_ANCHORS[id] || id;
    const view = views.find((el) => el.dataset.view === id) || views[0];

    views.forEach((el) => {
        el.hidden = el !== view;
    });
    view.classList.remove("view-enter");
    void view.offsetWidth; // restart the entrance animation
    view.classList.add("view-enter");

    $$(".nav a[data-route]").forEach((link) => {
        if (link.dataset.route === view.dataset.view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });

    $("#page-title").textContent = view.dataset.title;
    $("#page-section").textContent = view.dataset.section;
    document.title = `${view.dataset.title} · AquaGrow-AI`;

    setNavOpen(false);
    closeNotifications();
    window.scrollTo({ top: 0 });
    render(); // charts skip work while hidden, so draw the newly visible ones now
}

window.addEventListener("hashchange", route);

// ---------------------------------------------------------------------------
// Mobile navigation + notifications popover
// ---------------------------------------------------------------------------

const app = $("#app");
const menuBtn = $("#menu-btn");
const scrim = $("#scrim");

function setNavOpen(open) {
    app.classList.toggle("nav-open", open);
    scrim.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
}

menuBtn.addEventListener("click", () => setNavOpen(!app.classList.contains("nav-open")));
scrim.addEventListener("click", () => setNavOpen(false));

const notifBtn = $("#notif-btn");
const notifPop = $("#notif-pop");

function closeNotifications() {
    notifPop.hidden = true;
    notifBtn.setAttribute("aria-expanded", "false");
}

notifBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = notifPop.hidden;
    notifPop.hidden = !open;
    notifBtn.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (e) => {
    if (!notifPop.hidden && !notifPop.contains(e.target)) closeNotifications();
});

document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeNotifications();
    setNavOpen(false);
});

// ---------------------------------------------------------------------------

route();
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL_MS);
setInterval(tick, TICK_INTERVAL_MS);
