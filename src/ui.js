// Overlay UI panel injected onto x.com.
//
// Keeps state in IndexedDB (via db.js) so closing/refreshing the tab
// preserves progress. Settings persist in GM_setValue.
//
// Visual structure (HTML + CSS) lives in ui_template.js.
// Pure helpers (formatEta, loadCfg, makeInitialState, etc.) live in
// ui_state.js — covered by dedicated unit tests in tests/ui_state.test.js.

import {
  openDb, listMutuals, countEdges, setMutuals,
  appendLogEntry, listLogEntries, clearLogs,
} from "./db.js";
import { GraphQLClient } from "./client.js";
import { freshnessReport } from "./op_hashes.js";
import { JitteredPacer } from "./pacing.js";
import { EtaTracker } from "./eta.js";
import { resolveUsers } from "./resolver.js";
import { crawl, planCrawl } from "./crawler.js";
import { parseArchive, computeMutuals } from "./archive_parser.js";
import { buildGraphFromDb, renderGraph } from "./viz.js";
import { STYLE, HTML } from "./ui_template.js";
import {
  loadCfg, saveCfg, formatEta, phaseBadgeClass,
  makeInitialState, resetProgress,
  appendLogLine, isLoggedIn, selfIdFromCookies,
} from "./ui_state.js";

// How often (in items) to log a "[N done]" progress line during long-running
// fetches. Raise to chatter less, lower to see finer-grained progress.
const PROGRESS_LOG_INTERVAL = 50;
// Hard cap on follower/following list size we'll fetch from one account.
// 50K is well above any reasonable mutuals graph and stops runaway behaviour
// on accidentally-massive accounts.
const FETCH_FOLLOW_LIST_HARD_CAP = 50000;





const state = makeInitialState();

function appendLog(line) {
  appendLogLine(state, line);
  render();
  // Fire-and-forget durable write. We don't await: a 17h crawl shouldn't
  // block on log persistence, and a one-off IndexedDB write failure is fine.
  if (state.db) {
    appendLogEntry(state.db, line).catch((e) =>
      console.warn("[mutuals-mapper] log persist failed:", e),
    );
  }
}

function downloadBlob(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

async function onExportLogsClick() {
  const entries = await listLogEntries(state.db, { limit: 50000 });
  const lines = entries.map((e) => `${e.ts}  ${e.line}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBlob(`mutuals-mapper-${stamp}.log.txt`, lines.join("\n") + "\n");
  appendLog(`Exported ${entries.length} log lines`);
}

async function onClearLogsClick() {
  if (!confirm("Clear all persisted log entries?")) return;
  await clearLogs(state.db);
  state.log = [];
  appendLog("(logs cleared)");
}

function render() {
  const el = (id) => document.getElementById(id);
  if (!el("mm-overlay")) return;

  const phaseEl = el("mm-phase");
  phaseEl.textContent = state.phase;
  phaseEl.className = `badge ${phaseBadgeClass(state.phase)}`.trim();
  el("mm-phase-msg").textContent = state.message;

  if (state.total > 0) {
    el("mm-bar").value = state.completed; el("mm-bar").max = state.total;
    el("mm-prog").textContent = `${state.completed} / ${state.total}`;
  } else {
    el("mm-bar").value = 0; el("mm-bar").max = 1; el("mm-prog").textContent = "—";
  }
  el("mm-eta").textContent = state.etaSeconds != null
    ? `eta ${formatEta(state.etaSeconds)}` : "";

  const errEl = el("mm-err");
  if (state.err) { errEl.textContent = state.err; errEl.hidden = false; }
  else errEl.hidden = true;

  el("mm-log").textContent = state.log.join("\n");

  const running = state.task != null;
  el("mm-resolve").disabled = running;
  el("mm-crawl").disabled = running;
  el("mm-cancel").disabled = !running;
  el("mm-render").disabled = running;
  el("mm-fetch-from-api").disabled = running;
}


async function refreshSeed() {
  const seedCount = (await listMutuals(state.db)).length;
  const edgeCount = await countEdges(state.db);
  const el = document.getElementById("mm-seed");
  if (seedCount === 0) {
    el.className = "badge"; el.textContent = "no mutuals seeded";
  } else {
    el.className = "badge ok";
    el.textContent = `${seedCount} mutuals · ${edgeCount} edges`;
  }
}

function detectAccount() {
  const el = document.getElementById("mm-acct");
  const cookies = document.cookie;
  if (!isLoggedIn(cookies)) {
    el.className = "badge error";
    el.textContent = "not logged in to x.com";
    el.title = (
      "Couldn't see the ct0 cookie. If you ARE logged in, try reloading the page " +
      "or visiting https://x.com/home — sometimes ct0 isn't set until you've " +
      "loaded a real x.com page (not just a sub-route)."
    );
    return false;
  }
  const selfId = selfIdFromCookies(cookies);
  el.className = "badge ok";
  el.textContent = selfId ? `logged in (id ${selfId})` : "logged in";
  el.title = (
    "Auth detected via ct0 cookie. Note that auth_token itself is HttpOnly " +
    "(invisible to JS) but is still sent on same-origin fetches — so requests " +
    "will succeed even if this badge somehow misreads."
  );
  return true;
}

function reportHashFreshness() {
  // Tell the user whether we've seen live GraphQL traffic to validate our
  // baked-in op hashes. If not, suggest scrolling x.com to warm Resource Timing.
  const el = document.getElementById("mm-hashes");
  const report = freshnessReport();
  if (report.status === "fresh") {
    el.className = "badge ok";
    el.textContent = `op-hashes: live (${report.count} ops seen)`;
    el.title = "Live GraphQL hashes scraped from this x.com tab — should be current.";
  } else {
    el.className = "badge warn";
    el.textContent = "op-hashes: baked-in only";
    el.title = (
      "Haven't seen any x.com GraphQL traffic in this tab yet. If a crawl 404s, " +
      "scroll a profile + their following list, then reopen this overlay."
    );
  }
}

function fillCfgInputs() {
  const c = state.cfg;
  document.getElementById("cfg-min").value = c.request_min_seconds;
  document.getElementById("cfg-max").value = c.request_max_seconds;
  document.getElementById("cfg-consider").value = c.max_following_to_consider;
  document.getElementById("cfg-fetch").value = c.max_following_to_fetch;
  document.getElementById("cfg-backoff-base").value = c.backoff_base_seconds;
  document.getElementById("cfg-backoff-max").value = c.backoff_max_seconds;
  document.getElementById("cfg-backoff-attempts").value = c.backoff_max_attempts;
  document.getElementById("cfg-retry").value = c.retry_failed_after_hours;
  document.getElementById("cfg-mindeg").value = c.min_degree;
  document.getElementById("cfg-seed").value = c.louvain_seed;
}

function readCfgInputs() {
  const num = (id) => parseFloat(document.getElementById(id).value);
  state.cfg = {
    ...state.cfg,
    request_min_seconds: num("cfg-min"),
    request_max_seconds: num("cfg-max"),
    max_following_to_consider: num("cfg-consider"),
    max_following_to_fetch: num("cfg-fetch"),
    backoff_base_seconds: num("cfg-backoff-base"),
    backoff_max_seconds: num("cfg-backoff-max"),
    backoff_max_attempts: num("cfg-backoff-attempts"),
    retry_failed_after_hours: num("cfg-retry"),
    min_degree: num("cfg-mindeg"),
    louvain_seed: num("cfg-seed"),
  };
  saveCfg(state.cfg);
  appendLog("Config saved");
}

function startPhase(phase, message = "") {
  resetProgress(state, phase, message);
  render();
}

function makePacer({ signal } = {}) {
  return new JitteredPacer(
    state.cfg.request_min_seconds, state.cfg.request_max_seconds,
    { signal },
  );
}

async function withTask(fn) {
  if (state.task) { appendLog("(already running)"); return; }
  state.abortCtrl = new AbortController();
  state.task = (async () => {
    try { await fn(state.abortCtrl.signal); }
    catch (e) {
      // AbortError is an expected user action, not a failure.
      if (e?.name === "AbortError") {
        state.phase = "error"; state.err = "Cancelled by user";
        appendLog("Cancelled by user");
      } else {
        state.phase = "error"; state.err = `${e.name ?? "Error"}: ${e.message ?? e}`;
        appendLog(`ERROR: ${state.err}`); console.error(e);
      }
    } finally {
      state.task = null; state.abortCtrl = null; render(); refreshSeed();
    }
  })();
}

async function onResolveClick() {
  await withTask(async (signal) => {
    startPhase("resolve", "Resolving profiles…");
    appendLog("Starting resolve");
    const ids = new Set(await listMutuals(state.db));
    state.total = ids.size;
    const pacer = makePacer({ signal });
    const eta = new EtaTracker(ids.size);
    const stats = await resolveUsers(state.db, state.client, ids, {
      pacer, retryAfterHours: state.cfg.retry_failed_after_hours, signal,
      onProgress: (done, total) => {
        eta.tick(); state.completed = done; state.total = total;
        state.etaSeconds = eta.remainingSeconds();
        if (done % PROGRESS_LOG_INTERVAL === 0 || done === total) {
          appendLog(`[${done}/${total}] resolved`);
      }
        render();
      },
    });
    if (stats.cancelled) {
      state.phase = "error"; state.err = "Cancelled by user";
      appendLog(`Cancelled after ${stats.resolved} resolved`); return;
    }
    state.message =
      `Done: ${stats.resolved} resolved, ${stats.not_found} not_found, ${stats.failed} failed.`;
    appendLog(state.message); state.phase = "done"; render();
  });
}

async function onCrawlClick() {
  await withTask(async (signal) => {
    startPhase("crawl", "Crawling following lists…");
    appendLog("Starting crawl");
    const pacer = makePacer({ signal });
    const stats = await crawl(state.db, state.client, {
      maxFollowingToConsider: state.cfg.max_following_to_consider,
      maxFollowingToFetch: state.cfg.max_following_to_fetch,
      pacer,
      backoffBaseSeconds: state.cfg.backoff_base_seconds,
      backoffMaxSeconds: state.cfg.backoff_max_seconds,
      backoffMaxAttempts: state.cfg.backoff_max_attempts,
      retryFailedAfterHours: state.cfg.retry_failed_after_hours,
      signal,
      onProgress: (mid, status) => {
        state.completed += 1;
        if (state.total === 0) state.total = state.completed;
        appendLog(`  ${mid}: ${status}`);
        render();
      },
    });
    if (stats.cancelled) {
      state.phase = "error"; state.err = "Cancelled by user";
      appendLog(
        `Cancelled after ${stats.mutuals_processed} processed, ${stats.edges_written} edges`,
      );
      return;
    }
    state.message =
      `Done: ${stats.mutuals_processed} processed, ${stats.mutuals_skipped} skipped, ` +
      `${stats.mutuals_failed} failed, ${stats.edges_written} edges written.`;
    appendLog(state.message); state.phase = "done"; render();
  });
}

async function onFetchFromApiClick() {
  if (!confirm("Fetch follower + following lists via the current x.com account?")) return;
  await withTask(async (signal) => {
    startPhase("parse", "Fetching follower + following lists…");
    appendLog("Looking up your user_id from cookies…");
    const selfId = selfIdFromCookies(document.cookie);
    if (!selfId) throw new Error("couldn't read your user_id from twid cookie");
    appendLog(`self_id = ${selfId}`);
    state.message = "Fetching followers…"; render();
    const followers = new Set();
    let i = 0;
    for await (const id of state.client.iterFollowers(selfId, {
      maxCount: FETCH_FOLLOW_LIST_HARD_CAP, signal,
    })) {
      followers.add(id); i++;
      if (i % PROGRESS_LOG_INTERVAL === 0) {
        state.completed = i; appendLog(`  ${i} followers fetched…`); render();
      }
    }
    appendLog(`Got ${followers.size} followers. Fetching following…`);
    const following = new Set();
    i = 0;
    for await (const id of state.client.iterFollowing(selfId, {
      maxCount: FETCH_FOLLOW_LIST_HARD_CAP, signal,
    })) {
      following.add(id); i++;
      if (i % PROGRESS_LOG_INTERVAL === 0) {
        state.completed = i; appendLog(`  ${i} following fetched…`); render();
      }
    }
    const mutuals = new Set();
    for (const id of followers) if (following.has(id) && id !== selfId) mutuals.add(id);
    await setMutuals(state.db, [...mutuals]);
    state.message =
      `Found ${followers.size} followers, ${following.size} following, ${mutuals.size} mutuals.`;
    appendLog(state.message); state.phase = "done"; render();
  });
}

async function onArchiveClick(file) {
  await withTask(async () => {
    startPhase("parse", "Parsing archive…");
    const buffer = await file.arrayBuffer();
    const lists = await parseArchive(buffer);
    const mutuals = computeMutuals(lists);
    await setMutuals(state.db, [...mutuals]);
    state.message =
      `Found ${lists.followers.size} followers, ${lists.following.size} following, ${mutuals.size} mutuals.`;
    appendLog(state.message); state.phase = "done"; render();
  });
}

async function onRenderClick() {
  appendLog("Building graph…");
  const graph = await buildGraphFromDb(state.db, {
    minDegree: state.cfg.min_degree,
    sizeExponent: state.cfg.size_exponent,
  });
  appendLog(`Rendering ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
  renderGraph(document.getElementById("mm-graph"), graph);
}

function onCancelClick() {
  if (state.abortCtrl) {
    state.abortCtrl.abort();
    appendLog("(cancel requested)");
  }
}

function injectOverlay() {
  if (document.getElementById("mm-overlay")) return;
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
  const div = document.createElement("div");
  div.id = "mm-overlay";
  div.innerHTML = HTML;
  document.body.appendChild(div);

  document.getElementById("mm-close").addEventListener("click", () => div.remove());
  document.getElementById("mm-resolve").addEventListener("click", onResolveClick);
  document.getElementById("mm-crawl").addEventListener("click", onCrawlClick);
  document.getElementById("mm-cancel").addEventListener("click", onCancelClick);
  document.getElementById("mm-render").addEventListener("click", onRenderClick);
  document.getElementById("mm-fetch-from-api").addEventListener("click", onFetchFromApiClick);
  document.getElementById("mm-save-cfg").addEventListener("click", readCfgInputs);
  document.getElementById("mm-export-logs").addEventListener("click", onExportLogsClick);
  document.getElementById("mm-clear-logs").addEventListener("click", onClearLogsClick);
  document.getElementById("mm-archive").addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (f) onArchiveClick(f);
  });

  fillCfgInputs();
  detectAccount();
  reportHashFreshness();
  refreshSeed();
  // Hydrate the in-memory log tail from IndexedDB so reopening the overlay
  // shows recent persisted lines (instead of a blank slate).
  hydrateLogTail();
  render();
}

async function hydrateLogTail() {
  if (!state.db) return;
  try {
    const entries = await listLogEntries(state.db, { limit: 200 });
    if (entries.length > 0) {
      state.log = entries.map((e) => `${e.ts}  ${e.line}`);
      render();
    }
  } catch (e) {
    console.warn("[mutuals-mapper] failed to load persisted logs:", e);
  }
}

export async function init() {
  state.db = await openDb();
  state.client = new GraphQLClient();

  const launcher = document.createElement("button");
  launcher.id = "mm-launcher";
  launcher.textContent = "🕸 mutuals-mapper";
  launcher.addEventListener("click", injectOverlay);
  document.body.appendChild(launcher);

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open mutuals-mapper", injectOverlay);
  }
}
