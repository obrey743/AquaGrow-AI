// Small DOM + formatting helpers shared by every component.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const icon = (name, cls = "") =>
    `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export const isNum = (value) => typeof value === "number" && Number.isFinite(value);

// Components re-render every poll; only touch the DOM when the markup actually
// changed, so hover states, focus and CSS transitions survive the refresh.
export function setHTML(el, html) {
    if (el._html !== html) {
        el.innerHTML = html;
        el._html = html;
    }
}

export function setText(el, text) {
    const value = String(text ?? "");
    if (el.textContent !== value) el.textContent = value;
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Counts a number up/down to its new value instead of snapping to it
export function tweenNumber(el, value, decimals = 0) {
    cancelAnimationFrame(el._raf);
    const from = isNum(el._value) ? el._value : value;
    el._value = value;
    if (reduceMotion || from === value) {
        setText(el, value.toFixed(decimals));
        return;
    }
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / 700);
        const eased = 1 - Math.pow(1 - t, 3);
        setText(el, (from + (value - from) * eased).toFixed(decimals));
        if (t < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
}

export function fmt(value, decimals = 1) {
    if (!isNum(value)) return "—";
    return Number(value.toFixed(decimals)).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function timeAgo(seconds) {
    if (!isNum(seconds)) return "never";
    if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
}

// The server writes naive local ISO timestamps; Date parses those as local time
export const parseTimestamp = (iso) => (iso ? new Date(iso) : null);

export const clockTime = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function dateTime(date) {
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? clockTime(date)
        : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clockTime(date)}`;
}

export const secondsSince = (date) => (date ? (Date.now() - date.getTime()) / 1000 : null);

export function humanize(key) {
    const text = String(key || "").replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// Small status chip: a coloured dot plus a text label, so state is never colour-only
export const pill = (tone, label, extra = "") =>
    `<span class="pill pill-${tone} ${extra}"><span class="dot"></span>${esc(label)}</span>`;

export const skeleton = (width = "60%", height = "1em") =>
    `<span class="skeleton" style="width:${width};height:${height}"></span>`;

// Per-browser preferences (tank capacity, chart range). Storage can be blocked
// (private windows), so every access is guarded and falls back to defaults.
export const prefs = {
    get(key, fallback = null) {
        try {
            const value = localStorage.getItem(`aquagrow.${key}`);
            return value === null ? fallback : value;
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            if (value === null || value === "") localStorage.removeItem(`aquagrow.${key}`);
            else localStorage.setItem(`aquagrow.${key}`, value);
        } catch {
            // not remembered - harmless
        }
    },
};

// ---------------------------------------------------------------------------
// Toasts + confirmation dialog
// ---------------------------------------------------------------------------

const TOAST_ICONS = { good: "check-circle", warning: "warning", critical: "critical", info: "info" };

export function toast(message, tone = "good") {
    const host = document.getElementById("toasts");
    const item = document.createElement("div");
    item.className = `toast toast-${tone}`;
    item.innerHTML = `${icon(TOAST_ICONS[tone] || "info")}<span>${esc(message)}</span>`;
    host.appendChild(item);
    setTimeout(() => {
        item.classList.add("leaving");
        item.addEventListener("animationend", () => item.remove(), { once: true });
    }, 3600);
}

export function confirmDialog({ title, body, confirmLabel = "Confirm", tone = "primary", iconName = "info" }) {
    const dialog = document.getElementById("confirm-dialog");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-body").textContent = body;
    document.getElementById("confirm-icon").innerHTML = icon(iconName);
    document.getElementById("confirm-icon").className = `dialog-icon tone-${tone}`;
    const ok = document.getElementById("confirm-ok");
    ok.textContent = confirmLabel;
    ok.className = `btn btn-${tone === "critical" ? "danger" : "primary"}`;

    return new Promise((resolve) => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
        dialog.returnValue = "";
        dialog.showModal();
        ok.focus();
    });
}

// Runs an API action with a busy state on the button and a toast either way
export async function runAction(button, action, successMessage) {
    if (button) {
        button.disabled = true;
        button.classList.add("is-busy");
    }
    try {
        const result = await action();
        if (successMessage) toast(successMessage, "good");
        return result;
    } catch (err) {
        toast(err.message || "Something went wrong", "critical");
        return null;
    } finally {
        if (button) {
            button.disabled = false;
            button.classList.remove("is-busy");
        }
        document.dispatchEvent(new CustomEvent("aquagrow:refresh"));
    }
}
