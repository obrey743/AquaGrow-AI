// History cache, sparklines, and the interactive Environmental Overview chart
// (Chart.js, loaded via CDN in index.html).

import { get } from "./api.js";
import { METRICS } from "./model.js";
import { $, $$, esc, fmt, icon, isNum, prefs, setHTML, skeleton } from "./ui.js";

const READING_INTERVAL_SECONDS = 5; // app.py SIMULATOR_INTERVAL_SECONDS - roughly one row per 5 s
const MAX_ROWS = 20000;             // the most history the browser will hold at once
const POLL_ROWS = 60;               // rows fetched each poll to pick up new readings
const MAX_POINTS = 360;             // longer ranges are averaged down to about this many points

export const RANGES = [
    { id: "6h", label: "6H", ms: 6 * 3600e3 },
    { id: "24h", label: "24H", ms: 24 * 3600e3 },
    { id: "7d", label: "7D", ms: 7 * 24 * 3600e3 },
    { id: "30d", label: "30D", ms: 30 * 24 * 3600e3 },
];

export const rowsForRange = (ms) => Math.min(MAX_ROWS, Math.ceil(ms / 1000 / READING_INTERVAL_SECONDS) + POLL_ROWS);

const parseRow = (row) => ({ ...row, t: new Date(row.timestamp).getTime() });

// ---------------------------------------------------------------------------
// History store
// ---------------------------------------------------------------------------

// /api/history only takes a row limit, so time ranges are handled here: fetch
// enough rows for the widest range anyone has asked for once, then each poll
// only fetches the newest handful and appends what's new.
export class HistoryStore {
    constructor() {
        this.key = null;
        this.queue = Promise.resolve();
        this.clear();
    }

    clear() {
        this.rows = [];
        this.limit = 0;
        this.complete = false; // true when the server has no older rows than these
        this.loaded = false;
        this.error = false;
    }

    // The history endpoint answers differently per data source, so switching
    // between simulator and ESP32 (or leaving the waiting state) starts over
    setKey(key) {
        if (key !== this.key) {
            this.key = key;
            this.clear();
        }
    }

    run(task) {
        this.queue = this.queue.then(task, task);
        return this.queue;
    }

    async fetchAll(limit) {
        const key = this.key;
        try {
            const rows = await get(`/api/history?limit=${limit}`);
            if (key !== this.key) return;
            this.rows = rows.map(parseRow);
            this.limit = limit;
            this.complete = rows.length < limit;
            this.loaded = true;
            this.error = false;
        } catch (err) {
            this.error = true;
            console.error("Failed to fetch history:", err);
        }
    }

    load(limit) {
        return this.run(async () => {
            const wanted = Math.min(limit, MAX_ROWS);
            if (this.loaded && (this.complete || wanted <= this.limit)) return;
            await this.fetchAll(Math.max(wanted, this.limit));
        });
    }

    poll(initialLimit) {
        return this.run(async () => {
            if (!this.loaded) return this.fetchAll(Math.min(initialLimit, MAX_ROWS));

            const key = this.key;
            try {
                const fresh = (await get(`/api/history?limit=${POLL_ROWS}`)).map(parseRow);
                if (key !== this.key) return;
                const last = this.rows.length ? this.rows[this.rows.length - 1].t : -Infinity;
                // No overlap with what we hold: readings were missed (tab asleep) - reload
                if (fresh.length === POLL_ROWS && fresh[0].t > last) return this.fetchAll(this.limit);
                const added = fresh.filter((row) => row.t > last);
                if (added.length) {
                    this.rows = this.rows.concat(added);
                    if (this.rows.length > MAX_ROWS) {
                        this.rows = this.rows.slice(-MAX_ROWS);
                        this.complete = false;
                    }
                }
                this.error = false;
            } catch (err) {
                this.error = true;
                console.error("Failed to poll history:", err);
            }
        });
    }

    recent(count) {
        return this.rows.slice(-count);
    }

    isCapped() {
        return !this.complete && this.limit >= MAX_ROWS;
    }
}

// ---------------------------------------------------------------------------
// Sparkline (plain SVG, no library)
// ---------------------------------------------------------------------------

export function sparkline(values, { height = 36, reference = null, metric = "soil_moisture" } = {}) {
    const points = values.map((value, i) => ({ i, value })).filter((p) => isNum(p.value));
    if (points.length < 2) return `<div class="spark spark-empty" style="height:${height}px"></div>`;

    const width = 200;
    const nums = points.map((p) => p.value).concat(isNum(reference) ? [reference] : []);
    let min = Math.min(...nums);
    let max = Math.max(...nums);
    if (max - min < 1) {
        min -= 0.5;
        max += 0.5;
    }
    const pad = 3;
    const x = (i) => (i / (values.length - 1)) * width;
    const y = (value) => pad + (1 - (value - min) / (max - min)) * (height - pad * 2);

    // Break the line wherever a reading is missing, instead of bridging the gap
    let line = "";
    let previous = -2;
    points.forEach((p) => {
        line += `${p.i === previous + 1 ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`;
        previous = p.i;
    });
    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line}L${x(last.i).toFixed(1)},${height}L${x(first.i).toFixed(1)},${height}Z`;
    const ref = isNum(reference)
        ? `<line class="spark-ref" x1="0" x2="${width}" y1="${y(reference).toFixed(1)}" y2="${y(reference).toFixed(1)}"/>`
        : "";

    return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="height:${height}px;--c:var(--m-${metric})" aria-hidden="true">
        <path class="spark-area" d="${area}"/>${ref}
        <path class="spark-line" d="${line}"/>
    </svg>`;
}

// ---------------------------------------------------------------------------
// Environmental Overview chart
// ---------------------------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Optimal band + dashed threshold line behind the soil-moisture series
const bandPlugin = {
    id: "aquaBand",
    beforeDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.band) return;
        const { ctx, chartArea: area, scales } = chart;
        const [low, high] = opts.band;
        const yLow = scales.y.getPixelForValue(low);
        const yHigh = scales.y.getPixelForValue(high);
        ctx.save();
        ctx.beginPath();
        ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
        ctx.clip();
        ctx.fillStyle = css("--chart-band");
        ctx.fillRect(area.left, yHigh, area.right - area.left, yLow - yHigh);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = css("--chart-ref");
        ctx.beginPath();
        ctx.moveTo(area.left, yLow);
        ctx.lineTo(area.right, yLow);
        ctx.stroke();
        ctx.setLineDash([]);
        // Label on a surface-coloured chip so the data line never runs through it
        const label = `Threshold ${low}%`;
        ctx.font = `500 11px ${css("--font")}`;
        const width = ctx.measureText(label).width + 12;
        const x = area.left + 8;
        ctx.fillStyle = css("--surface");
        ctx.fillRect(x, yLow - 8, width, 16);
        ctx.fillStyle = css("--text-2");
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + 6, yLow + 0.5);
        ctx.restore();
    },
};

// Vertical guide line under the tooltip
const crosshairPlugin = {
    id: "aquaCrosshair",
    afterDatasetsDraw(chart) {
        const active = chart.tooltip && chart.tooltip.getActiveElements();
        if (!active || !active.length) return;
        const { ctx, chartArea: area } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = css("--border-strong");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        ctx.restore();
    },
};

// Insert a null wherever readings stopped for a while, so the line breaks
// across an outage instead of drawing a confident straight line through it
function withGaps(points) {
    if (points.length < 3) return points;
    const steps = [];
    for (let i = 1; i < points.length; i++) steps.push(points[i].x - points[i - 1].x);
    steps.sort((a, b) => a - b);
    const gap = Math.max(60e3, steps[Math.floor(steps.length / 2)] * 6);
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
        if (points[i].x - points[i - 1].x > gap) out.push({ x: points[i - 1].x + 1, y: null });
        out.push(points[i]);
    }
    return out;
}

// Average into time buckets so a 30-day view stays fast and readable
function downsample(points, from, to) {
    if (points.length <= MAX_POINTS) return { points, averaged: false };
    const size = (to - from) / MAX_POINTS;
    const buckets = new Map();
    points.forEach((p) => {
        const b = Math.min(MAX_POINTS - 1, Math.floor((p.x - from) / size));
        if (!buckets.has(b)) buckets.set(b, { xs: 0, n: 0, sum: 0, count: 0 });
        const bucket = buckets.get(b);
        bucket.xs += p.x;
        bucket.n += 1;
        if (isNum(p.y)) {
            bucket.sum += p.y;
            bucket.count += 1;
        }
    });
    // An empty bucket means no readings for that whole slice of time: keep it
    // as a break in the line rather than joining the readings either side
    const out = [];
    for (let b = 0; b < MAX_POINTS; b++) {
        const bucket = buckets.get(b);
        if (bucket) out.push({ x: bucket.xs / bucket.n, y: bucket.count ? bucket.sum / bucket.count : null });
        else if (out.length && out[out.length - 1].y !== null) out.push({ x: from + (b + 0.5) * size, y: null });
    }
    return { points: out, averaged: true };
}

export class EnvChart {
    constructor(el, opts, store) {
        this.el = el;
        this.store = store;
        this.metrics = (opts.metrics || "soil_moisture").split(",");
        this.storageKey = `chart.${this.metrics.join("-")}`;
        this.metric = prefs.get(`${this.storageKey}.metric`, this.metrics[0]);
        if (!this.metrics.includes(this.metric)) this.metric = this.metrics[0];
        this.range = RANGES.find((r) => r.id === prefs.get(`${this.storageKey}.range`, prefs.get("defaultRange", "6h"))) || RANGES[0];
        this.chart = null;
        this.fetching = false;

        el.innerHTML = `
            <section class="card chart-card">
                <div class="card-head chart-head">
                    <h2 class="section-label">${esc(opts.title || "Environmental overview")}</h2>
                    <div class="segmented" role="group" aria-label="Time range">
                        ${RANGES.map((r) => `<button type="button" data-range="${r.id}">${r.label}</button>`).join("")}
                    </div>
                </div>
                <div class="metric-tabs" role="tablist" aria-label="Metric">
                    ${this.metrics.map((m) => `
                        <button type="button" role="tab" data-metric="${m}" style="--c:var(--m-${m})">
                            <span class="tab-label">${icon(METRICS[m].icon)}${esc(METRICS[m].short)}</span>
                            <span class="tab-value" data-tab-value="${m}">—</span>
                        </button>`).join("")}
                </div>
                <div class="chart-body ${opts.tall ? "chart-tall" : ""}">
                    <canvas role="img"></canvas>
                    <div class="chart-state" hidden></div>
                    <div class="chart-busy" hidden><span class="spinner"></span></div>
                </div>
                <div class="chart-foot"></div>
            </section>`;

        this.canvas = $("canvas", el);
        this.stateEl = $(".chart-state", el);
        this.busyEl = $(".chart-busy", el);
        this.footEl = $(".chart-foot", el);

        $$("[data-range]", el).forEach((btn) =>
            btn.addEventListener("click", () => this.selectRange(btn.dataset.range))
        );
        $$("[data-metric]", el).forEach((btn) =>
            btn.addEventListener("click", () => {
                this.metric = btn.dataset.metric;
                prefs.set(`${this.storageKey}.metric`, this.metric);
                this.draw(true);
            })
        );
        this.syncControls();
    }

    async selectRange(id) {
        this.range = RANGES.find((r) => r.id === id) || RANGES[0];
        prefs.set(`${this.storageKey}.range`, this.range.id);
        this.syncControls();
        this.fetching = true;
        this.draw(true);
        await this.store.load(rowsForRange(this.range.ms));
        this.fetching = false;
        this.draw(true);
    }

    syncControls() {
        $$("[data-range]", this.el).forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.range === this.range.id)));
        $$("[data-metric]", this.el).forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.metric === this.metric)));
    }

    isVisible() {
        const view = this.el.closest(".view");
        return !view || !view.hidden;
    }

    update(v) {
        this.v = v;
        if (!this.isVisible()) return;
        // A range picked before the history store was reset needs its rows again
        if (this.store.loaded && !this.fetching && this.store.limit < rowsForRange(this.range.ms) && !this.store.complete) {
            this.selectRange(this.range.id);
            return;
        }
        this.draw(false);
    }

    showState(html) {
        this.stateEl.hidden = !html;
        if (html) setHTML(this.stateEl, html);
        this.canvas.style.visibility = html ? "hidden" : "visible";
    }

    draw(changed) {
        const v = this.v;
        if (!v) return;
        this.syncControls();
        this.busyEl.hidden = !this.fetching;

        this.metrics.forEach((m) => {
            const value = v.value(m);
            const el = $(`[data-tab-value="${m}"]`, this.el);
            el.textContent = value === null ? "—" : `${fmt(value, METRICS[m].decimals)} ${METRICS[m].unit}`;
        });

        const meta = METRICS[this.metric];
        this.canvas.setAttribute("aria-label", `${meta.label} over the last ${this.range.label}`);

        if (v.error && !this.store.loaded) {
            this.showState(emptyState("critical", "Can't load history", "The AquaGrow server isn't responding. Retrying automatically."));
            setHTML(this.footEl, "");
            return;
        }
        if (!v.loaded || (!this.store.loaded && !v.waiting)) {
            this.showState(`<div class="chart-skeleton">${skeleton("100%", "100%")}</div>`);
            setHTML(this.footEl, `<span>${skeleton("220px")}</span>`);
            return;
        }
        if (v.waiting) {
            this.showState(emptyState("waiting", "Waiting for ESP32 data", "The chart fills in as soon as the controller sends its first reading. Nothing is plotted until then."));
            setHTML(this.footEl, "");
            return;
        }

        const now = Date.now();
        const from = now - this.range.ms;
        const raw = this.store.rows
            .filter((row) => row.t >= from)
            .map((row) => ({ x: row.t, y: isNum(row[this.metric]) ? row[this.metric] : null }));
        const values = raw.map((p) => p.y).filter(isNum);

        if (!values.length) {
            const fitted = v.value(this.metric) !== null;
            const text = !raw.length
                ? `No readings in the last ${this.range.label.toLowerCase()}. Try a wider time range.`
                : fitted || v.simulator
                    ? `No ${meta.label.toLowerCase()} readings in this range.`
                    : `The controller isn't reporting ${meta.label.toLowerCase()}. This sensor may not be fitted.`;
            this.showState(emptyState("empty", `No ${meta.label.toLowerCase()} data`, text));
            setHTML(this.footEl, "");
            return;
        }
        this.showState("");

        const { points, averaged } = downsample(withGaps(raw), raw[0].x, raw[raw.length - 1].x + 1);
        const band = this.metric === "soil_moisture" && v.band ? v.band : null;
        this.render(points, band, meta, changed, averaged);

        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const d = meta.decimals;
        const note = this.store.isCapped() && raw.length && this.store.rows[0].t > from
            ? `<span class="foot-note">${icon("info")}Showing the most recent ${this.store.rows.length.toLocaleString()} readings</span>`
            : averaged ? `<span class="foot-note">${icon("info")}Averaged for this range</span>` : "";
        setHTML(this.footEl, `
            <span><small>Min</small><strong>${fmt(min, d)} ${meta.unit}</strong></span>
            <span><small>Average</small><strong>${fmt(avg, d)} ${meta.unit}</strong></span>
            <span><small>Max</small><strong>${fmt(max, d)} ${meta.unit}</strong></span>
            <span><small>Readings</small><strong>${values.length.toLocaleString()}</strong></span>
            ${note}`);
    }

    render(points, band, meta, changed, averaged) {
        Chart.defaults.font.family = css("--font");
        const color = css(`--m-${this.metric}`) || css("--chart-line");
        const span = points[points.length - 1].x - points[0].x;
        const long = span > 36 * 3600e3;
        const short = span < 20 * 60e3; // under 20 minutes: minutes alone would repeat
        const dataset = {
            data: points,
            borderColor: color,
            borderWidth: 2,
            tension: 0.2,
            cubicInterpolationMode: "monotone",
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBackgroundColor: css("--surface"),
            pointHoverBorderColor: color,
            spanGaps: false,
            fill: false,
        };

        const values = points.map((p) => p.y).filter(isNum);
        const y = { grid: { color: css("--chart-grid"), drawTicks: false }, border: { display: false }, ticks: { padding: 8, maxTicksLimit: 5, color: css("--text-3"), font: { size: 11 } } };
        if (band) {
            y.suggestedMin = Math.max(0, Math.min(...values, band[0]) - 5);
            y.suggestedMax = Math.min(100, Math.max(...values, band[1]) + 5);
        } else if (this.metric === "water_flow") {
            y.beginAtZero = true;
        } else {
            y.grace = "10%";
        }

        const options = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: changed ? 500 : 0 },
            interaction: { mode: "nearest", axis: "x", intersect: false },
            layout: { padding: { top: 8, right: 4 } },
            scales: {
                x: {
                    type: "linear",
                    min: points[0].x,
                    max: points[points.length - 1].x,
                    grid: { display: false },
                    border: { color: css("--border") },
                    ticks: {
                        maxTicksLimit: 6,
                        maxRotation: 0,
                        color: css("--text-3"),
                        font: { size: 11 },
                        callback: (value) => {
                            const date = new Date(value);
                            if (long) return date.toLocaleDateString([], { month: "short", day: "numeric" });
                            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: short ? "2-digit" : undefined });
                        },
                    },
                },
                y,
            },
            plugins: {
                legend: { display: false },
                aquaBand: { band },
                tooltip: {
                    backgroundColor: css("--surface"),
                    borderColor: css("--border"),
                    borderWidth: 1,
                    titleColor: css("--text-3"),
                    bodyColor: css("--text"),
                    titleFont: { size: 11, weight: "500" },
                    bodyFont: { size: 13, weight: "600" },
                    padding: 8,
                    cornerRadius: 4,
                    displayColors: false,
                    caretSize: 0,
                    callbacks: {
                        title: (items) => new Date(items[0].parsed.x).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: long ? undefined : "2-digit" }),
                        label: (item) => `${averaged ? "Avg " : ""}${meta.label}: ${fmt(item.parsed.y, meta.decimals)} ${meta.unit}`,
                    },
                },
            },
        };

        if (!this.chart) {
            this.chart = new Chart(this.canvas.getContext("2d"), {
                type: "line",
                data: { datasets: [dataset] },
                options,
                plugins: [bandPlugin, crosshairPlugin],
            });
            return;
        }
        this.chart.data.datasets[0] = dataset;
        this.chart.options = options;
        this.chart.update(changed ? undefined : "none");
    }
}

function emptyState(kind, title, text) {
    const glyph = { waiting: "wifi", critical: "critical", empty: "chart" }[kind] || "info";
    return `<div class="empty empty-${kind}">
        <span class="empty-icon">${icon(glyph)}</span>
        <p class="empty-title">${esc(title)}</p>
        <p class="empty-text">${esc(text)}</p>
    </div>`;
}
