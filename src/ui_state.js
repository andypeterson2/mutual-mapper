// Pure helpers for the UI's state machine. Pulled out of ui.js so they're
// directly unit-testable without spinning up a DOM.

import { DEFAULT_CFG } from "./ui_template.js";

export function loadCfg(getValue = (typeof GM_getValue === "function" ? GM_getValue : null)) {
  const saved = getValue ? getValue("cfg", null) : null;
  return { ...DEFAULT_CFG, ...(saved || {}) };
}

export function saveCfg(cfg, setValue = (typeof GM_setValue === "function" ? GM_setValue : null)) {
  if (setValue) setValue("cfg", cfg);
}

export function formatEta(seconds) {
  if (seconds == null || seconds < 0) return "--";
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// Bucket the current phase into a CSS class for the badge.
export function phaseBadgeClass(phase) {
  if (phase === "done") return "ok";
  if (phase === "error") return "error";
  if (phase === "idle") return "";
  return "warn";
}

// Make a fresh state object. Kept here so handler tests can construct one
// without importing the whole ui.js (which has side effects on import).
export function makeInitialState() {
  return {
    db: null,
    cfg: { ...DEFAULT_CFG },
    client: null,
    phase: "idle",
    message: "",
    completed: 0,
    total: 0,
    etaSeconds: null,
    log: [],
    err: null,
    task: null,
    abortCtrl: null,
  };
}

export function resetProgress(state, phase, message = "") {
  state.phase = phase;
  state.message = message;
  state.completed = 0;
  state.total = 0;
  state.etaSeconds = null;
  state.err = null;
}

// Bound how big the visible in-memory log tail grows; persisted log is bigger.
export const LOG_TAIL_MAX = 200;

// Heuristic for "is the user logged in to x.com?".
//
// We can't use `auth_token` here even though that's the obvious choice: x.com
// sets `auth_token` as HttpOnly, so `document.cookie` does NOT include it.
// (The cookie IS still sent on same-origin fetches — that's why the actual
// auth flow works — but JS can't see it.)
//
// `ct0` is also set on every authenticated request (it's the CSRF token, and
// we read it for the `x-csrf-token` header). It's NOT HttpOnly, so JS can
// see it. Its presence is a reliable proxy for "logged in".
//
// `twid` is even better when present (contains the user_id and is also
// non-HttpOnly), but ct0 is the canonical signal.
export function isLoggedIn(cookieString) {
  return /(?:^|;\s*)ct0=/.test(cookieString || "");
}

// Returns the user_id parsed from the `twid` cookie, or null if not logged in.
// twid value looks like `u%3D<id>` (URL-encoded "u=<id>") or `"u%3D<id>"` with
// surrounding quotes.
export function selfIdFromCookies(cookieString) {
  const m = /twid=(?:%22|")?u%3D(\d+)/.exec(cookieString || "");
  return m ? m[1] : null;
}

export function appendLogLine(state, line, { now = () => new Date() } = {}) {
  const ts = now().toLocaleTimeString();
  state.log.push(`${ts}  ${line}`);
  if (state.log.length > LOG_TAIL_MAX) state.log.shift();
  return state.log[state.log.length - 1];
}
