// ----- userscript_header.js -----
// ==UserScript==
// @name         mutuals-mapper
// @namespace    https://github.com/andypeterson2/mutual-mapper
// @version      0.1.5
// @description  Map your X/Twitter mutuals network entirely in the browser
// @author       Andy Peterson
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/andypeterson2/mutual-mapper/main/dist/mutuals-mapper.user.js
// @downloadURL  https://raw.githubusercontent.com/andypeterson2/mutual-mapper/main/dist/mutuals-mapper.user.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://d3js.org/d3.v7.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/graphology-communities-louvain@2.0.1/dist/graphology-communities-louvain.umd.min.js
// ==/UserScript==

/* eslint-disable no-undef */
"use strict";

(function () {
  "use strict";
// ----- op_hashes.js -----
// Twitter/X GraphQL operation hashes.
//
// These rotate every few months when X ships a new client build. To survive
// rotations without code changes we:
//   1. Bake in the most recent known-good values (mirrored from twscrape).
//   2. At runtime, scrape the live x.com page for current hashes by inspecting
//      `performance.getEntriesByType('resource')` — the user is browsing x.com
//      while the userscript runs, so x.com's own GraphQL calls get logged
//      there. We extract `<HASH>/<OperationName>` from those URLs.
//   3. Discovered hashes override the baked-in defaults.
//
// Auth bearer token: the public web bearer x.com has used for years. Public,
// not secret. If it ever changes, scrape it from any GraphQL request's
// Authorization header in DevTools.

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const BASE_URL = "https://x.com";

// Known-good hashes (mirrored from twscrape v0.17). Update these manually OR
// rely on `discoverOpHashes` to scrape current values from the live page.
const DEFAULT_HASHES = {
  UserByRestId: "WJ7rCtezBVT6nk6VM5R8Bw",
  UserByScreenName: "1VOOyvKkiI3FMmkeDNxM9A",
  Following: "C1qZ6bs-L3oc_TKSZyxkXQ",
  Followers: "Elc_-qTARceHpztqhI9PQA",
};

const GQL_PATH_RE = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)/;

// Pure helper: given a list of URL strings, return {OperationName: hash} for
// any GraphQL paths found.
function extractOpHashes(urls) {
  const out = {};
  for (const url of urls) {
    if (typeof url !== "string") continue;
    const m = url.match(GQL_PATH_RE);
    if (!m) continue;
    const [, hash, op] = m;
    if (!out[op]) out[op] = hash;
  }
  return out;
}

// Live discovery: pull URLs from the page's Resource Timing API.
function discoverOpHashesFromPerformance(perf = globalThis.performance) {
  if (!perf || typeof perf.getEntriesByType !== "function") return {};
  const entries = perf.getEntriesByType("resource");
  return extractOpHashes(entries.map((e) => e.name));
}

// Returns a hashes object: starts with defaults, overrides with anything seen
// on the page. Caller can re-call to pick up newly observed ops.
function currentHashes(perf) {
  const observed = discoverOpHashesFromPerformance(perf);
  return { ...DEFAULT_HASHES, ...observed };
}

// Diagnostic for the UI: tell the user whether we've seen any live x.com
// GraphQL traffic. If not, our op hashes might be stale and the user should
// scroll x.com a bit before starting a crawl.
//
// Returns one of:
//   - { status: "fresh", count: N } — we observed N live ops, all good
//   - { status: "stale", count: 0 } — only baked-in defaults available
function freshnessReport(perf = globalThis.performance) {
  const observed = discoverOpHashesFromPerformance(perf);
  const count = Object.keys(observed).length;
  if (count === 0) return { status: "stale", count: 0 };
  return { status: "fresh", count };
}

// ----- pacing.js -----
// Jittered pacing + exponential backoff helpers.
//
// Both `sleep` and `rng` are injectable so tests run synchronously without
// real waiting and with deterministic jitter. Mirrors the Python `pacing.py`.
//
// Every wait function accepts an optional `{ signal }` (AbortSignal). When the
// signal fires, in-flight sleeps reject with an AbortError immediately — the
// user clicks "Cancel" once and we don't have to wait out a 60s backoff.

function isAbortError(err) {
  return Boolean(err && (err.name === "AbortError" || err.code === "ABORT_ERR"));
}

function defaultSleep(seconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    let onAbort = null;
    const t = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

class JitteredPacer {
  constructor(
    minSeconds, maxSeconds,
    { sleep = defaultSleep, rng = Math.random, signal = null } = {},
  ) {
    if (minSeconds < 0 || maxSeconds < minSeconds) {
      throw new Error("require 0 <= minSeconds <= maxSeconds");
    }
    this._min = minSeconds;
    this._max = maxSeconds;
    this.sleep = sleep;
    this._rng = rng;
    this.signal = signal;
  }

  async wait() {
    const span = this._max - this._min;
    const jitter = this._min + this._rng() * span;
    // Inject signal as the second arg; injected sleeps are free to ignore it.
    await this.sleep(jitter, { signal: this.signal });
  }
}

function computeBackoffDelay(attempt, { base, max }) {
  const delay = base * Math.pow(2, attempt);
  return Math.min(delay, max);
}

async function withBackoff(
  func,
  {
    isRetryable, baseSeconds, maxSeconds, maxAttempts,
    sleep = defaultSleep, signal = null,
  } = {},
) {
  if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
  let lastExc = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("aborted", "AbortError");
    }
    try {
      return await func();
    } catch (exc) {
      if (isAbortError(exc)) throw exc;          // user cancelled — propagate
      if (!isRetryable(exc)) throw exc;
      lastExc = exc;
      if (attempt + 1 >= maxAttempts) break;
      await sleep(
        computeBackoffDelay(attempt, { base: baseSeconds, max: maxSeconds }),
        { signal },
      );
    }
  }
  throw lastExc;
}

// ----- eta.js -----
// Tiny ETA helper for long-running progress reports.
// Rolling-average over the last N completion timestamps.

class EtaTracker {
  constructor(total, { window = 20, now = () => performance.now() / 1000 } = {}) {
    this.total = total;
    this.completed = 0;
    this._max = window;
    this._window = [];
    this._now = now;
    this._last = now();
  }

  tick() {
    const t = this._now();
    this._window.push(t - this._last);
    if (this._window.length > this._max) this._window.shift();
    this._last = t;
    this.completed += 1;
  }

  remainingSeconds() {
    if (this._window.length === 0) return null;
    const avg = this._window.reduce((a, b) => a + b, 0) / this._window.length;
    return avg * Math.max(this.total - this.completed, 0);
  }

  formatRemaining() {
    const secs = this.remainingSeconds();
    if (secs === null) return "--";
    const total = Math.floor(secs);
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
}

// ----- db.js -----
// Tiny IndexedDB wrapper. Mirrors the SQLite shape of the Python version:
// stores: users, edges, mutuals_seed, fetch_log.
//
// Object stores:
//   users        keyPath "id"          (string)
//   edges        keyPath "key"         ("source_id|target_id"); index by source_id, target_id
//   mutuals_seed keyPath "id"          (string)
//   fetch_log    keyPath ["user_id", "phase"]   ('resolve' | 'crawl')

const DB_NAME = "mutuals-mapper";
const DB_VERSION = 2;
// Cap log entries kept in IndexedDB so a 17h crawl doesn't bloat indefinitely.
const LOG_RING_BUFFER_MAX = 5000;

function openDb(name = DB_NAME, idbFactory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!idbFactory) reject(new Error("indexedDB not available"));
    const req = idbFactory.open(name, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("users")) {
        db.createObjectStore("users", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("edges")) {
        const s = db.createObjectStore("edges", { keyPath: "key" });
        s.createIndex("source_id", "source_id", { unique: false });
        s.createIndex("target_id", "target_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("mutuals_seed")) {
        db.createObjectStore("mutuals_seed", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("fetch_log")) {
        db.createObjectStore("fetch_log", { keyPath: ["user_id", "phase"] });
      }
      // v2: durable log ring buffer (so a long crawl's logs survive reloads).
      if (!db.objectStoreNames.contains("logs")) {
        db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _wrapReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------- users ----------

async function upsertUser(db, user) {
  const tx = db.transaction("users", "readwrite");
  tx.objectStore("users").put(user);
  await _txDone(tx);
}

async function getUser(db, userId) {
  const tx = db.transaction("users", "readonly");
  const got = await _wrapReq(tx.objectStore("users").get(userId));
  return got || null;
}

// ---------- edges ----------

function _edgeKey(source_id, target_id) {
  return `${source_id}|${target_id}`;
}

async function insertEdge(db, edge) {
  // Self-loops dropped silently. Duplicates are no-ops (put with same key).
  if (edge.source_id === edge.target_id) return;
  const tx = db.transaction("edges", "readwrite");
  tx.objectStore("edges").put({
    key: _edgeKey(edge.source_id, edge.target_id),
    source_id: edge.source_id,
    target_id: edge.target_id,
    fetched_at: edge.fetched_at,
  });
  await _txDone(tx);
}

async function listEdges(db) {
  const tx = db.transaction("edges", "readonly");
  return await _wrapReq(tx.objectStore("edges").getAll());
}

async function countEdges(db) {
  const tx = db.transaction("edges", "readonly");
  return await _wrapReq(tx.objectStore("edges").count());
}

// ---------- mutuals_seed ----------

async function setMutuals(db, ids) {
  // Replace the entire set.
  const tx = db.transaction("mutuals_seed", "readwrite");
  const store = tx.objectStore("mutuals_seed");
  store.clear();
  for (const id of ids) store.put({ id });
  await _txDone(tx);
}

async function listMutuals(db) {
  const tx = db.transaction("mutuals_seed", "readonly");
  const all = await _wrapReq(tx.objectStore("mutuals_seed").getAll());
  return all.map((r) => r.id).sort();
}

// ---------- fetch_log ----------

const VALID_PHASES = new Set(["resolve", "crawl"]);

async function upsertFetchLog(db, entry, { phase = "crawl" } = {}) {
  if (!VALID_PHASES.has(phase)) throw new Error(`bad phase: ${phase}`);
  const tx = db.transaction("fetch_log", "readwrite");
  tx.objectStore("fetch_log").put({
    user_id: entry.user_id,
    phase,
    status: entry.status,
    error: entry.error ?? null,
    attempted_at: entry.attempted_at,
  });
  await _txDone(tx);
}

async function getFetchLog(db, userId, { phase = "crawl" } = {}) {
  const tx = db.transaction("fetch_log", "readonly");
  const got = await _wrapReq(tx.objectStore("fetch_log").get([userId, phase]));
  return got || null;
}

// ---------- pending_mutuals (decision logic) ----------

// Pure, easy to unit-test independently of IndexedDB.
function needsRefetch(status, attemptedAt, retryAfterHours, now = new Date()) {
  if (status == null || status === "pending" || status === "in_progress") return true;
  if (status === "done" || status === "skipped") return false;
  if (status === "failed") {
    if (!attemptedAt) return true;
    const t = new Date(attemptedAt).getTime();
    if (Number.isNaN(t)) return true;
    const ageHours = (now.getTime() - t) / (1000 * 60 * 60);
    return ageHours >= retryAfterHours;
  }
  return false;
}

async function pendingMutuals(db, retryAfterHours, { now = new Date() } = {}) {
  const seedIds = await listMutuals(db);
  const out = [];
  const tx = db.transaction("fetch_log", "readonly");
  const store = tx.objectStore("fetch_log");
  for (const id of seedIds) {
    const entry = await _wrapReq(store.get([id, "crawl"]));
    if (needsRefetch(entry?.status, entry?.attempted_at, retryAfterHours, now)) {
      out.push(id);
    }
  }
  return out;
}

// ---------- logs ----------

async function appendLogEntry(db, line, { ts = new Date().toISOString() } = {}) {
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").add({ ts, line });
  await _txDone(tx);
  // Trim to keep the ring buffer bounded (cheap; only fires occasionally).
  if (Math.random() < 0.01) await trimLogs(db, LOG_RING_BUFFER_MAX);
}

async function listLogEntries(db, { limit = 1000 } = {}) {
  const tx = db.transaction("logs", "readonly");
  const store = tx.objectStore("logs");
  // Walk the auto-increment index in reverse to get newest first, capped by limit.
  return await new Promise((resolve, reject) => {
    const out = [];
    const cursorReq = store.openCursor(null, "prev");
    cursorReq.onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur || out.length >= limit) {
        out.reverse();
        resolve(out);
        return;
      }
      out.push({ id: cur.key, ts: cur.value.ts, line: cur.value.line });
      cur.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function clearLogs(db) {
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").clear();
  await _txDone(tx);
}

async function trimLogs(db, keepLast) {
  const tx = db.transaction("logs", "readwrite");
  const store = tx.objectStore("logs");
  const count = await _wrapReq(store.count());
  if (count <= keepLast) { await _txDone(tx); return; }
  const cutoff = count - keepLast;
  return await new Promise((resolve, reject) => {
    let removed = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur || removed >= cutoff) { resolve(undefined); return; }
      cur.delete();
      removed += 1;
      cur.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// ---------- maintenance ----------

async function deleteDb(name = DB_NAME, idbFactory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ----- client.js -----
// X/Twitter GraphQL client — fetch wrapper.
//
// Runs INSIDE x.com origin (userscript scope), so cookies + same-origin
// requests just work. We lift the operation hashes via op_hashes.js (live
// scrape + baked-in defaults).
//
// Returns "User" objects in our domain shape (not x.com's internal shape):
//   { id, handle, name, bio, followers_count, following_count, protected }
//
// Errors are remapped into typed shapes: AuthError, RateLimitError,
// TransientClientError, ClientError. Mirrors the Python version.
// Page size for Following/Followers pagination. x.com's cap is ~20-50; 20
// matches what the web client itself uses, so we look identical to a normal
// browsing pattern.
const FOLLOW_LIST_PAGE_SIZE = 20;
// Cap response text shown in error messages — full responses can be huge HTML.
const ERROR_BODY_PREVIEW_CHARS = 200;

class AuthError extends Error { constructor(msg) { super(msg); this.name = "AuthError"; } }
class RateLimitError extends Error {
  constructor(msg, retryAfterSeconds = null) {
    super(msg); this.name = "RateLimitError"; this.retryAfterSeconds = retryAfterSeconds;
  }
}
class ClientError extends Error { constructor(msg) { super(msg); this.name = "ClientError"; } }
class TransientClientError extends ClientError {
  constructor(msg) { super(msg); this.name = "TransientClientError"; }
}

const FEATURES_USER = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const FEATURES_TIMELINE = {
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

// --- pure helpers ---

function _userFromPayload(node) {
  if (!node || node.__typename !== "User") return null;
  const legacy = node.legacy ?? {};
  return {
    id: String(node.rest_id ?? ""),
    handle: legacy.screen_name ?? null,
    name: legacy.name ?? null,
    bio: legacy.description ?? null,
    followers_count: legacy.followers_count ?? null,
    following_count: legacy.friends_count ?? null,
    protected: typeof legacy.protected === "boolean" ? legacy.protected : null,
  };
}

function _followingCursor(entries) {
  for (const e of entries) {
    const c = e.content ?? {};
    if (c.cursorType === "Bottom") {
      const v = c.value ?? "";
      if (!v || v.startsWith("0|")) return null;
      return v;
    }
  }
  return null;
}

function _parseFollowingPage(payload) {
  const inst = payload?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  const addEntries = inst.find((x) => x.type === "TimelineAddEntries");
  const entries = addEntries?.entries ?? [];
  const ids = [];
  for (const entry of entries) {
    const result = entry?.content?.itemContent?.user_results?.result;
    if (result?.__typename === "User" && result.rest_id) {
      ids.push(String(result.rest_id));
    }
  }
  return { ids, cursor: _followingCursor(entries) };
}

// --- error remapping ---

function _remap(status, body) {
  if (status === 401 || status === 403) {
    return new AuthError(`HTTP ${status}: cookies expired? Re-log into x.com.`);
  }
  if (status === 429) {
    return new RateLimitError("rate limited");
  }
  if (status >= 500 && status < 600) {
    return new TransientClientError(`HTTP ${status}`);
  }
  if (status === 404) {
    return new ClientError(
      `HTTP 404: probably a stale GraphQL operation hash. ` +
      `Refresh the x.com page (loads current hashes) and try again.`
    );
  }
  if (status >= 400) {
    return new ClientError(`HTTP ${status}: ${typeof body === "string" ? body.slice(0, ERROR_BODY_PREVIEW_CHARS) : ""}`);
  }
  return null;
}

// --- request builder ---

function _ct0FromCookies(cookieString = globalThis.document?.cookie ?? "") {
  const m = /(?:^|;\s*)ct0=([^;]+)/.exec(cookieString);
  return m ? decodeURIComponent(m[1]) : "";
}

function _buildUrl(hashes, opName, variables, features) {
  const hash = hashes[opName];
  if (!hash) throw new ClientError(`unknown op: ${opName}`);
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features ?? {}),
  });
  return `https://x.com/i/api/graphql/${hash}/${opName}?${params.toString()}`;
}

class GraphQLClient {
  constructor({
    fetcher = globalThis.fetch?.bind(globalThis),
    cookieSource = () => globalThis.document?.cookie ?? "",
    perf = globalThis.performance,
    log = () => {},
  } = {}) {
    if (!fetcher) throw new Error("fetch is not available in this environment");
    this._fetch = fetcher;
    this._cookieSource = cookieSource;
    this._perf = perf;
    // Logger callback — wired to the overlay's appendLog in production so
    // diagnostic lines surface in the panel + persisted log, not the console.
    this._log = log;
    // One log line per op-name per session, not per request: a long crawl
    // would otherwise paint the same line thousands of times.
    this._loggedOps = new Set();
  }

  _headers() {
    const ct0 = _ct0FromCookies(this._cookieSource());
    return {
      "authorization": `Bearer ${BEARER}`,
      "x-csrf-token": ct0,
      "content-type": "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    };
  }

  async _gqlGet(opName, variables, features, { signal } = {}) {
    const hashes = currentHashes(this._perf);
    const live = discoverOpHashesFromPerformance(this._perf);
    const source = live[opName] ? "live" : "default";
    const hash = hashes[opName];
    if (!this._loggedOps.has(opName)) {
      this._loggedOps.add(opName);
      this._log(`[op] ${opName} hash=${hash} source=${source}`);
    }
    const url = _buildUrl(hashes, opName, variables, features);
    let resp;
    try {
      resp = await this._fetch(url, {
        method: "GET",
        credentials: "include",
        headers: this._headers(),
        signal,
      });
    } catch (e) {
      // Re-throw AbortError as-is so cancel propagates cleanly.
      if (e?.name === "AbortError") throw e;
      throw new TransientClientError(`network: ${e.message ?? e}`);
    }
    if (!resp.ok) {
      this._log(`[op] ${opName} HTTP ${resp.status} hash=${hash} source=${source}`);
      const body = await resp.text().catch(() => "");
      const mapped = _remap(resp.status, body);
      if (mapped) throw mapped;
    }
    let json;
    try {
      json = await resp.json();
    } catch (e) {
      throw new TransientClientError(`malformed JSON: ${e.message ?? e}`);
    }
    return json;
  }

  async getUserByRestId(userId, { signal } = {}) {
    const data = await this._gqlGet(
      "UserByRestId",
      { userId: String(userId), withSafetyModeUserFields: true },
      FEATURES_USER,
      { signal },
    );
    const node = data?.data?.user?.result;
    return _userFromPayload(node);
  }

  async getUserByLogin(handle, { signal } = {}) {
    const screen = handle.replace(/^@/, "");
    const data = await this._gqlGet(
      "UserByScreenName",
      { screen_name: screen, withSafetyModeUserFields: true },
      FEATURES_USER,
      { signal },
    );
    const node = data?.data?.user?.result;
    return _userFromPayload(node);
  }

  // Async generator: yields target user_ids one at a time. Pages internally
  // until the cursor sentinel or maxCount is reached. Pass `{ signal }` to
  // abort mid-iteration — checked between yields so a cancel doesn't take
  // effect until the next page boundary.
  async *iterFollowing(userId, { maxCount, signal } = {}) {
    yield* this._iterFollowList("Following", userId, { maxCount, signal });
  }

  async *iterFollowers(userId, { maxCount, signal } = {}) {
    yield* this._iterFollowList("Followers", userId, { maxCount, signal });
  }

  async *_iterFollowList(opName, userId, { maxCount, signal }) {
    let cursor = null;
    let emitted = 0;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      const variables = {
        userId: String(userId),
        count: FOLLOW_LIST_PAGE_SIZE,
        includePromotedContent: false,
      };
      if (cursor) variables.cursor = cursor;
      const data = await this._gqlGet(opName, variables, FEATURES_TIMELINE, { signal });
      const { ids, cursor: nextCursor } = _parseFollowingPage(data);
      for (const id of ids) {
        if (emitted >= maxCount) return;
        yield id;
        emitted += 1;
      }
      if (!nextCursor || emitted >= maxCount) return;
      cursor = nextCursor;
    }
  }
}

// ----- resolver.js -----
// Per-call user resolver. Mirrors the Python `resolver.py` after the
// twscrape refactor: no batching, paced between calls.
//
// Pass `{ signal }` to cancel mid-loop — checked between iterations and
// honored by the pacer's sleep. A cancelled run returns the partial stats
// it accumulated so the UI can show progress; resume just picks up where it
// left off (the unprocessed users have no fetch_log row).
function _now() { return new Date().toISOString(); }

function _isFresh(user, retryAfterHours, now = new Date()) {
  if (!user || !user.fetched_at) return false;
  const fetched = new Date(user.fetched_at).getTime();
  if (Number.isNaN(fetched)) return false;
  const ageHours = (now.getTime() - fetched) / (1000 * 60 * 60);
  return ageHours < retryAfterHours;
}

async function resolveUsers(db, client, userIds, {
  pacer, onProgress, retryAfterHours = 24, signal = null,
} = {}) {
  // Filter out users already fresh (fetched recently).
  const all = [...userIds].sort();
  const todo = [];
  for (const uid of all) {
    const u = await getUser(db, uid);
    if (!_isFresh(u, retryAfterHours)) todo.push(uid);
  }
  const stats = {
    requested: userIds.size ?? userIds.length ?? 0,
    resolved: 0, failed: 0, not_found: 0, cancelled: false,
  };
  if (todo.length === 0) return stats;

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) { stats.cancelled = true; return stats; }
    if (i > 0) {
      try { await pacer.wait(); }
      catch (e) {
        if (isAbortError(e)) { stats.cancelled = true; return stats; }
        throw e;
      }
    }
    const uid = todo[i];
    let user;
    try {
      user = await client.getUserByRestId(uid, { signal });
    } catch (exc) {
      if (isAbortError(exc)) { stats.cancelled = true; return stats; }
      if (exc instanceof ClientError || exc instanceof TransientClientError) {
        await upsertFetchLog(db, {
          user_id: uid, status: "failed", error: exc.message, attempted_at: _now(),
        }, { phase: "resolve" });
        stats.failed += 1;
        if (onProgress) onProgress(i + 1, todo.length);
        continue;
      }
      throw exc;
    }
    const ts = _now();
    if (user == null) {
      await upsertFetchLog(db, {
        user_id: uid, status: "failed", error: "not_found", attempted_at: ts,
      }, { phase: "resolve" });
      stats.not_found += 1;
    } else {
      await upsertUser(db, { ...user, fetched_at: ts });
      await upsertFetchLog(db, {
        user_id: uid, status: "done", error: null, attempted_at: ts,
      }, { phase: "resolve" });
      stats.resolved += 1;
    }
    if (onProgress) onProgress(i + 1, todo.length);
  }
  return stats;
}

// ----- crawler.js -----
// Per-mutual crawl: fetch each mutual's following list, write inter-mutual
// edges. Skip rules, in-progress marker, retry on transient errors.
//
// v1 scope: single account (whoever's logged in to x.com). No two-account
// routing — private mutuals get marked skipped if their following is gated.
//
// Cancellation: pass `{ signal }`. The crawl loop checks it between mutuals
// and propagates it into the pacer + iterFollowing call so a long backoff or
// in-flight HTTP request aborts immediately. Partial stats are returned with
// `cancelled: true` and the in-flight mutual is left at status='in_progress'
// so the next run picks it up via the resume contract.
function _now() { return new Date().toISOString(); }

// Pure: returns [shouldSkip, reason].
function shouldSkip(user, { maxFollowing }) {
  if (user == null) return [true, "user_not_resolved"];
  if (user.following_count == null) return [true, "following_count_unknown"];
  if (user.following_count > maxFollowing) {
    return [true, `following_count=${user.following_count} > ${maxFollowing}`];
  }
  return [false, null];
}

async function planCrawl(db, { maxFollowing, pageSize = 20 } = {}) {
  const ids = await listMutuals(db);
  const willFetch = [];
  const willSkip = [];
  let estimated = 0;
  for (const id of ids) {
    const user = await getUser(db, id);
    const [skip, reason] = shouldSkip(user, { maxFollowing });
    if (skip) {
      willSkip.push([id, reason]);
    } else {
      willFetch.push(id);
      estimated += Math.ceil(user.following_count / Math.max(pageSize, 1));
    }
  }
  return { willFetch, willSkip, estimated };
}

async function crawl(db, client, {
  maxFollowingToConsider, maxFollowingToFetch,
  pacer,
  backoffBaseSeconds, backoffMaxSeconds, backoffMaxAttempts,
  retryFailedAfterHours,
  onProgress,
  signal = null,
} = {}) {
  const mutualsSet = new Set(await listMutuals(db));
  const todo = await pendingMutuals(db, retryFailedAfterHours);
  const stats = {
    mutuals_processed: 0, mutuals_skipped: 0, mutuals_failed: 0,
    edges_written: 0, cancelled: false,
  };

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) { stats.cancelled = true; return stats; }
    const mid = todo[i];
    const user = await getUser(db, mid);
    const [skip, reason] = shouldSkip(user, { maxFollowing: maxFollowingToConsider });
    if (skip) {
      await upsertFetchLog(db, {
        user_id: mid, status: "skipped", error: reason, attempted_at: _now(),
      });
      stats.mutuals_skipped += 1;
      if (onProgress) onProgress(mid, "skipped");
      continue;
    }

    if (i > 0) {
      try { await pacer.wait(); }
      catch (e) {
        if (isAbortError(e)) { stats.cancelled = true; return stats; }
        throw e;
      }
    }

    await upsertFetchLog(db, {
      user_id: mid, status: "in_progress", error: null, attempted_at: _now(),
    });

    try {
      let edgesForMutual = 0;
      const fetchOne = async () => {
        edgesForMutual = 0;
        for await (const targetId of client.iterFollowing(
          mid, { maxCount: maxFollowingToFetch, signal },
        )) {
          if (mutualsSet.has(targetId) && targetId !== mid) {
            await insertEdge(db, { source_id: mid, target_id: targetId, fetched_at: _now() });
            edgesForMutual += 1;
          }
        }
        return edgesForMutual;
      };
      await withBackoff(fetchOne, {
        isRetryable: (e) => e instanceof RateLimitError || e instanceof TransientClientError,
        baseSeconds: backoffBaseSeconds, maxSeconds: backoffMaxSeconds,
        maxAttempts: backoffMaxAttempts, sleep: pacer.sleep, signal,
      });
      stats.edges_written += edgesForMutual;
      await upsertFetchLog(db, {
        user_id: mid, status: "done", error: null, attempted_at: _now(),
      });
      stats.mutuals_processed += 1;
      if (onProgress) onProgress(mid, "done");
    } catch (exc) {
      if (isAbortError(exc)) { stats.cancelled = true; return stats; }
      await upsertFetchLog(db, {
        user_id: mid, status: "failed", error: exc.message ?? String(exc), attempted_at: _now(),
      });
      stats.mutuals_failed += 1;
      if (onProgress) onProgress(mid, "failed");
    }
  }
  return stats;
}

// ----- archive_parser.js -----
// Twitter archive ZIP parser.
//
// Browser side: uses globalThis.JSZip (loaded via @require in the userscript
// header). For node tests we let the caller pass a JSZip instance.
//
// Real archives lay follower/following data out as JS files like
// data/follower.js + data/following.js + data/account.js, each starting with
// `window.YTD.<x>.partN = [ ... ]`. We strip the prefix and JSON.parse the
// remainder.

function extractJsonArray(text) {
  const bracket = text.indexOf("[");
  if (bracket === -1) throw new Error("no JSON array found in archive file");
  try {
    return JSON.parse(text.slice(bracket));
  } catch (e) {
    throw new Error(`could not parse archive payload: ${e.message ?? e}`);
  }
}

function _matchesPrefix(name, prefix) {
  return name.startsWith(`data/${prefix}.js`) ||
         name.startsWith(`data/${prefix}-part`);
}

async function _readIdList(zip, { prefix, idKey }) {
  const ids = new Set();
  const entries = Object.keys(zip.files).filter(
    (n) => n.endsWith(".js") && _matchesPrefix(n, prefix),
  );
  for (const name of entries) {
    const text = await zip.files[name].async("string");
    let arr;
    try {
      arr = extractJsonArray(text);
    } catch (e) {
      throw new Error(`could not parse ${name}: ${e.message ?? e}`);
    }
    for (const entry of arr) {
      const inner = entry[idKey] ?? entry;
      if (inner.accountId != null) ids.add(String(inner.accountId));
    }
  }
  return ids;
}

async function _readSelfId(zip) {
  const name = "data/account.js";
  if (!zip.files[name]) return null;
  const text = await zip.files[name].async("string");
  let arr;
  try { arr = extractJsonArray(text); } catch { return null; }
  for (const entry of arr) {
    const inner = entry.account ?? entry;
    if (inner.accountId != null) return String(inner.accountId);
  }
  return null;
}

// `JSZip` is the constructor (e.g. globalThis.JSZip in the userscript, or
// passed in for node tests via `await JSZip.loadAsync(buffer)`).
async function parseArchive(blobOrBuffer, { JSZip = globalThis.JSZip } = {}) {
  if (!JSZip) throw new Error("JSZip not available (load via @require in userscript)");
  let zip;
  try {
    zip = await JSZip.loadAsync(blobOrBuffer);
  } catch (e) {
    throw new Error(`not a zip archive: ${e.message ?? e}`);
  }
  const followers = await _readIdList(zip, { prefix: "follower", idKey: "follower" });
  const following = await _readIdList(zip, { prefix: "following", idKey: "following" });
  const selfId = await _readSelfId(zip);
  return { followers, following, selfId };
}

function computeMutuals({ followers, following, selfId }) {
  const out = new Set();
  for (const id of followers) if (following.has(id)) out.add(id);
  if (selfId) out.delete(selfId);
  return out;
}

// ----- viz.js -----
// Build the graph data shape from the IndexedDB stores + render it via D3.
//
// Browser: relies on globalThis.d3 (loaded via @require in the userscript)
// and `graphologyLibrary.communitiesLouvain` for community detection.
// We accept either the `graphology` + `graphology-communities-louvain` libs,
// OR a fallback `componentLouvain` function that just labels each connected
// component as its own community (useful when graphology isn't loaded).
// Pure: produce GraphData from raw nodes/edges arrays + a louvain function.
function buildGraphData(rawNodes, rawEdges, {
  minDegree = 0, sizeExponent = 0.6, louvain = componentLouvain,
} = {}) {
  // Build adjacency to compute degrees + connected components / communities.
  const adj = new Map();
  for (const n of rawNodes) adj.set(n.id, new Set());
  // Dedup undirected edges: store as min/max key.
  const edgeSet = new Set();
  for (const e of rawEdges) {
    if (!adj.has(e.source_id) || !adj.has(e.target_id)) continue;
    const a = e.source_id < e.target_id ? e.source_id : e.target_id;
    const b = e.source_id < e.target_id ? e.target_id : e.source_id;
    const key = `${a}|${b}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    adj.get(a).add(b);
    adj.get(b).add(a);
  }

  // Apply min-degree filter.
  if (minDegree > 0) {
    for (const [id, neigh] of adj) {
      if (neigh.size < minDegree) {
        adj.delete(id);
        for (const other of neigh) adj.get(other)?.delete(id);
      }
    }
  }

  if (adj.size === 0) return { nodes: [], edges: [] };

  // Communities (deterministic — caller's louvain decides the algorithm).
  const community = louvain(adj);

  const nodes = [];
  for (const [id, neigh] of adj) {
    const raw = rawNodes.find((n) => n.id === id) || {};
    const deg = neigh.size;
    nodes.push({
      id,
      handle: raw.handle ?? null,
      name: raw.name ?? null,
      bio: raw.bio ?? null,
      followers_count: raw.followers_count ?? null,
      degree: deg,
      community: community.get(id) ?? 0,
      size: Math.round((5 + Math.pow(deg, sizeExponent) * 5) * 1000) / 1000,
    });
  }

  const edges = [];
  for (const key of edgeSet) {
    const [s, t] = key.split("|");
    if (adj.has(s) && adj.has(t)) edges.push({ source: s, target: t });
  }

  nodes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  edges.sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
  return { nodes, edges };
}

// Fallback "louvain" implementation: each connected component = one community.
// Deterministic; good enough when graphology isn't loaded.
function componentLouvain(adj) {
  const out = new Map();
  let cid = 0;
  // Visit nodes in sorted id order for determinism.
  const ids = [...adj.keys()].sort();
  const visited = new Set();
  for (const start of ids) {
    if (visited.has(start)) continue;
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      if (visited.has(n)) continue;
      visited.add(n);
      out.set(n, cid);
      for (const nb of adj.get(n) ?? []) if (!visited.has(nb)) queue.push(nb);
    }
    cid += 1;
  }
  return out;
}

// Wrapper that tries the real graphology Louvain when available.
function realLouvain(adj, { seed = 42 } = {}) {
  const G = globalThis.graphology;
  const louvainLib = globalThis.graphologyLibrary?.communitiesLouvain;
  if (!G || !louvainLib) return componentLouvain(adj);
  const g = new G.UndirectedGraph();
  for (const id of adj.keys()) g.addNode(id);
  for (const [a, neigh] of adj) {
    for (const b of neigh) {
      if (a < b && !g.hasEdge(a, b)) g.addEdge(a, b);
    }
  }
  const detail = louvainLib.detailed(g, { rng: () => seedRandom(seed)() });
  const out = new Map();
  for (const [id, cid] of Object.entries(detail.communities)) out.set(id, cid);
  return out;
}

// Tiny seeded PRNG (mulberry32) to feed deterministic randomness into Louvain.
function seedRandom(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Load nodes + edges from IndexedDB and build the graph data.
async function buildGraphFromDb(db, opts = {}) {
  const seed = await listMutuals(db);
  const rawNodes = [];
  for (const id of seed) {
    const u = await getUser(db, id);
    if (u) rawNodes.push(u);
  }
  const rawEdges = await listEdges(db);
  return buildGraphData(rawNodes, rawEdges, { louvain: realLouvain, ...opts });
}

// Render the D3 force-directed graph into a container element.
// Browser-only: requires globalThis.d3.
function renderGraph(container, graph) {
  const d3 = globalThis.d3;
  if (!d3) {
    container.innerHTML =
      `<p style="color:#999;padding:20px">D3 not loaded (check @require lines).</p>`;
    return;
  }
  container.innerHTML = "";
  if (graph.nodes.length === 0) {
    container.innerHTML =
      `<p style="color:#888;padding:20px">No data yet — run the pipeline first.</p>`;
    return;
  }

  const w = container.clientWidth || 900;
  const h = container.clientHeight || 600;
  const svg = d3.select(container).append("svg")
    .attr("viewBox", [0, 0, w, h]).attr("width", "100%").attr("height", "100%");
  const g = svg.append("g");

  const palette = d3.schemeTableau10.concat(d3.schemeSet3 || []);
  const color = (c) => palette[c % palette.length];

  // HTML escape — userscript runs as the x.com origin with the user's full
  // session cookies, so any HTML injected via a malicious handle/name/bio is
  // a real session-takeover XSS. Escape every interpolated value.
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const sim = d3.forceSimulation(graph.nodes)
    .force("link", d3.forceLink(graph.edges).id((d) => d.id).distance(60).strength(0.4))
    .force("charge", d3.forceManyBody().strength(-90))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collide", d3.forceCollide().radius((d) => d.size + 2));

  const link = g.append("g").attr("stroke", "#444").attr("stroke-opacity", 0.5)
    .selectAll("line").data(graph.edges).join("line");

  const tip = d3.select(container).append("div")
    .attr("class", "mm-tooltip")
    .style("position", "absolute").style("opacity", 0)
    .style("pointer-events", "none")
    .style("background", "rgba(20,20,24,0.95)").style("color", "#eee")
    .style("border", "1px solid #444").style("border-radius", "4px")
    .style("padding", "8px 10px").style("font-size", "12px");

  const node = g.append("g").selectAll("circle").data(graph.nodes).join("circle")
    .attr("r", (d) => d.size).attr("fill", (d) => color(d.community))
    .attr("stroke", "#000").attr("stroke-width", 0.5).style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag",  (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end",   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on("mouseover", (event, d) => {
      tip.style("opacity", 1).html(
        `<strong>@${escapeHtml(d.handle ?? "?")}</strong> &mdash; ${escapeHtml(d.name ?? "")}<br>` +
        `${escapeHtml(d.bio ?? "")}<br>` +
        `<small>followers: ${escapeHtml(d.followers_count ?? "?")} · ` +
        `degree: ${escapeHtml(d.degree)} · community: ${escapeHtml(d.community)}</small>`
      ).style("left", (event.offsetX + 10) + "px").style("top", (event.offsetY + 10) + "px");
    })
    .on("mouseout", () => tip.style("opacity", 0))
    .on("click", (event, d) => {
      // URL-encode the handle so a malicious value can't break out of the URL.
      if (d.handle) window.open(`https://x.com/${encodeURIComponent(d.handle)}`, "_blank");
    });

  sim.on("tick", () => {
    link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
  });

  svg.call(d3.zoom().scaleExtent([0.1, 8]).on("zoom", (e) => g.attr("transform", e.transform)));
}

// ----- ui_template.js -----
// HTML + CSS for the overlay panel injected on x.com.
//
// Pulled out of ui.js so the wiring file stays focused on logic. These are
// pure constants with no behavior — easy to scan, easy to swap. The IDs in
// HTML are the contract that ui.js's event handlers + render() depend on.

const STYLE = `
  #mm-overlay {
    position: fixed; top: 60px; right: 16px; z-index: 99999;
    width: 460px; max-height: 92vh; overflow-y: auto;
    background: #16181c; color: #e7e7ea; border: 1px solid #2f3336;
    border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
  }
  #mm-overlay .mm-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid #2f3336;
  }
  #mm-overlay .mm-header h2 { margin: 0; font-size: 15px; color: #1d9bf0; }
  #mm-overlay .mm-close {
    background: none; border: none; color: #888; font-size: 18px; cursor: pointer;
  }
  #mm-overlay section { padding: 12px 16px; border-bottom: 1px solid #22262a; }
  #mm-overlay h3 { margin: 0 0 8px; font-size: 13px; color: #1d9bf0; font-weight: 600; }
  #mm-overlay .hint { color: #71767b; font-size: 11px; margin: 0 0 8px; line-height: 1.4; }
  #mm-overlay button {
    background: #1d9bf0; color: white; border: none; border-radius: 4px;
    padding: 6px 12px; font: inherit; cursor: pointer; margin: 2px;
  }
  #mm-overlay button:hover { background: #1a8cd8; }
  #mm-overlay button:disabled { opacity: 0.4; cursor: not-allowed; }
  #mm-overlay button.secondary { background: transparent; border: 1px solid #2f3336; color: #e7e7ea; }
  #mm-overlay input[type="number"], #mm-overlay input[type="text"] {
    background: #0c0d0e; color: #e7e7ea; border: 1px solid #2f3336;
    border-radius: 4px; padding: 4px 6px; font: inherit; width: 90px;
  }
  #mm-overlay .grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px;
    align-items: center;
  }
  #mm-overlay .grid label { color: #71767b; font-size: 11px; }
  #mm-overlay .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; background: #2f3336; color: #71767b;
  }
  #mm-overlay .badge.ok { background: #00ba7c; color: #062c1c; }
  #mm-overlay .badge.warn { background: #ffd400; color: #2c2400; }
  #mm-overlay .badge.error { background: #f4212e; color: #2c0608; }
  #mm-overlay progress {
    width: 100%; height: 12px; border-radius: 4px; border: 1px solid #2f3336;
  }
  #mm-overlay .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #mm-overlay .log {
    background: #0c0d0e; border: 1px solid #2f3336; border-radius: 4px;
    padding: 6px 8px; max-height: 140px; overflow-y: auto;
    font-family: ui-monospace, monospace; font-size: 11px;
    color: #b8c4d4; white-space: pre-wrap; margin-top: 6px;
  }
  #mm-overlay .err { color: #f4212e; font-size: 12px; margin-top: 4px; }
  #mm-overlay #mm-graph { width: 100%; height: 380px; background: #0c0d0e;
    border: 1px solid #2f3336; border-radius: 4px; position: relative;
    overflow: hidden; margin-top: 6px;
  }
  #mm-overlay details summary { cursor: pointer; color: #71767b; font-size: 12px; }
  #mm-launcher {
    position: fixed; bottom: 16px; right: 16px; z-index: 99998;
    background: #1d9bf0; color: white; border: none; border-radius: 999px;
    padding: 10px 16px; font: 600 13px system-ui; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
  }
`;

const HTML = `
  <div class="mm-header">
    <h2>mutuals-mapper</h2>
    <button class="mm-close" id="mm-close" title="Close">×</button>
  </div>

  <section>
    <h3>1. Logged-in account</h3>
    <p class="hint">Cookies are read automatically from your current x.com
    session. Switch accounts in x.com to crawl as a different user.</p>
    <div class="row">
      <span id="mm-acct" class="badge">checking…</span>
      <span id="mm-hashes" class="badge">checking…</span>
    </div>
  </section>

  <section>
    <h3>2. Level-1 ingest</h3>
    <p class="hint">Pick one. Archive is instant; API path uses your current
    session and can take 10-20 min for ~1000 follows.</p>
    <details open>
      <summary><strong>A. Upload Twitter archive ZIP</strong></summary>
      <div style="margin-top:6px">
        <input type="file" id="mm-archive" accept=".zip">
      </div>
    </details>
    <details>
      <summary><strong>B. Fetch from API (current account)</strong></summary>
      <div style="margin-top:6px">
        <button id="mm-fetch-from-api" class="secondary">Fetch followers + following</button>
      </div>
    </details>
    <div class="row" style="margin-top:6px">
      <span id="mm-seed" class="badge">no mutuals seeded</span>
    </div>
  </section>

  <section>
    <h3>3. Settings</h3>
    <details>
      <summary>Tunables</summary>
      <div class="grid" style="margin-top:8px">
        <label>Pacing min (s)</label><input type="number" id="cfg-min" step="0.5">
        <label>Pacing max (s)</label><input type="number" id="cfg-max" step="0.5">
        <label>Skip if following &gt;</label><input type="number" id="cfg-consider">
        <label>Cap per mutual</label><input type="number" id="cfg-fetch">
        <label>Backoff base (s)</label><input type="number" id="cfg-backoff-base">
        <label>Backoff max (s)</label><input type="number" id="cfg-backoff-max">
        <label>Backoff attempts</label><input type="number" id="cfg-backoff-attempts">
        <label>Retry failed after (h)</label><input type="number" id="cfg-retry">
        <label>Min degree (viz)</label><input type="number" id="cfg-mindeg">
        <label>Louvain seed</label><input type="number" id="cfg-seed">
      </div>
      <button id="mm-save-cfg" style="margin-top:8px">Save</button>
    </details>
  </section>

  <section>
    <h3>4. Run pipeline</h3>
    <div class="row">
      <button id="mm-resolve">Resolve profiles</button>
      <button id="mm-crawl">Crawl following</button>
      <button id="mm-cancel" class="secondary">Cancel</button>
    </div>
    <div class="row" style="margin-top:8px">
      <span id="mm-phase" class="badge">idle</span>
      <span id="mm-phase-msg" class="hint" style="margin:0"></span>
    </div>
    <div class="row" style="margin-top:6px">
      <progress id="mm-bar" value="0" max="1"></progress>
      <span id="mm-prog" class="hint" style="margin:0">—</span>
      <span id="mm-eta" class="hint" style="margin:0"></span>
    </div>
    <div id="mm-err" class="err" hidden></div>
    <details open>
      <summary>Live log <span class="hint">(persists across reloads)</span></summary>
      <div class="row" style="margin: 4px 0;">
        <button id="mm-export-logs" class="secondary">Export logs (.txt)</button>
        <button id="mm-clear-logs" class="secondary">Clear</button>
      </div>
      <div id="mm-log" class="log"></div>
    </details>
  </section>

  <section>
    <h3>5. Graph</h3>
    <button id="mm-render">Render / refresh</button>
    <div id="mm-graph"></div>
  </section>
`;

// Defaults for the per-user tunables. The UI loads these on first run, then
// persists overrides via GM_setValue (when running in Tampermonkey).
const DEFAULT_CFG = {
  request_min_seconds: 2.0,
  request_max_seconds: 4.0,
  max_following_to_consider: 10000,
  max_following_to_fetch: 2000,
  backoff_base_seconds: 30,
  backoff_max_seconds: 900,
  backoff_max_attempts: 6,
  retry_failed_after_hours: 24,
  min_degree: 0,
  louvain_seed: 42,
  size_exponent: 0.6,
};

// ----- ui_state.js -----
// Pure helpers for the UI's state machine. Pulled out of ui.js so they're
// directly unit-testable without spinning up a DOM.
function loadCfg(getValue = (typeof GM_getValue === "function" ? GM_getValue : null)) {
  const saved = getValue ? getValue("cfg", null) : null;
  return { ...DEFAULT_CFG, ...(saved || {}) };
}

function saveCfg(cfg, setValue = (typeof GM_setValue === "function" ? GM_setValue : null)) {
  if (setValue) setValue("cfg", cfg);
}

function formatEta(seconds) {
  if (seconds == null || seconds < 0) return "--";
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// Bucket the current phase into a CSS class for the badge.
function phaseBadgeClass(phase) {
  if (phase === "done") return "ok";
  if (phase === "error") return "error";
  if (phase === "idle") return "";
  return "warn";
}

// Make a fresh state object. Kept here so handler tests can construct one
// without importing the whole ui.js (which has side effects on import).
function makeInitialState() {
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

function resetProgress(state, phase, message = "") {
  state.phase = phase;
  state.message = message;
  state.completed = 0;
  state.total = 0;
  state.etaSeconds = null;
  state.err = null;
}

// Bound how big the visible in-memory log tail grows; persisted log is bigger.
const LOG_TAIL_MAX = 200;

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
function isLoggedIn(cookieString) {
  return /(?:^|;\s*)ct0=/.test(cookieString || "");
}

// Returns the user_id parsed from the `twid` cookie, or null if not logged in.
// twid value looks like `u%3D<id>` (URL-encoded "u=<id>") or `"u%3D<id>"` with
// surrounding quotes.
function selfIdFromCookies(cookieString) {
  const m = /twid=(?:%22|")?u%3D(\d+)/.exec(cookieString || "");
  return m ? m[1] : null;
}

function appendLogLine(state, line, { now = () => new Date() } = {}) {
  const ts = now().toLocaleTimeString();
  state.log.push(`${ts}  ${line}`);
  if (state.log.length > LOG_TAIL_MAX) state.log.shift();
  return state.log[state.log.length - 1];
}

// ----- ui.js -----
// Overlay UI panel injected onto x.com.
//
// Keeps state in IndexedDB (via db.js) so closing/refreshing the tab
// preserves progress. Settings persist in GM_setValue.
//
// Visual structure (HTML + CSS) lives in ui_template.js.
// Pure helpers (formatEta, loadCfg, makeInitialState, etc.) live in
// ui_state.js — covered by dedicated unit tests in tests/ui_state.test.js.
// How often (in items) to log a "[N done]" progress line during long-running
// fetches. Raise to chatter less, lower to see finer-grained progress.
const PROGRESS_LOG_INTERVAL = 50;
// Hard cap on follower/following list size we'll fetch from one account.
// 50K is well above any reasonable mutuals graph and stops runaway behaviour
// on accidentally-massive accounts.
const FETCH_FOLLOW_LIST_HARD_CAP = 50000;





const state = makeInitialState();

function appendLog(line, { persist = true } = {}) {
  appendLogLine(state, line);
  render();
  // Fire-and-forget durable write. We don't await: a 17h crawl shouldn't
  // block on log persistence, and a one-off IndexedDB write failure is fine.
  // `persist: false` is used by the failure paths below so we don't recurse
  // forever if the write itself is what's broken.
  if (state.db && persist) {
    appendLogEntry(state.db, line).catch((e) =>
      appendLog(`(log persist failed: ${e?.message ?? e})`, { persist: false }),
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
        appendLog(`ERROR: ${state.err}`);
        if (e?.stack) {
          for (const sl of String(e.stack).split("\n").slice(0, 6)) {
            appendLog(`  ${sl.trim()}`);
          }
        }
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
    appendLog(
      `(failed to load persisted logs: ${e?.message ?? e})`,
      { persist: false },
    );
  }
}

async function init() {
  state.db = await openDb();
  state.client = new GraphQLClient({ log: appendLog });

  const launcher = document.createElement("button");
  launcher.id = "mm-launcher";
  launcher.textContent = "🕸 mutuals-mapper";
  launcher.addEventListener("click", injectOverlay);
  document.body.appendChild(launcher);

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open mutuals-mapper", injectOverlay);
  }
}

// ----- _entry.js -----
// Userscript entry point. Concatenated last by build.js; calls init() once
// the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => init());
} else {
  init();
}

})();
