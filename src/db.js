// Tiny IndexedDB wrapper. Mirrors the SQLite shape of the Python version:
// stores: users, edges, mutuals_seed, fetch_log.
//
// Object stores:
//   users        keyPath "id"          (string)
//   edges        keyPath "key"         ("source_id|target_id"); index by source_id, target_id
//   mutuals_seed keyPath "id"          (string)
//   fetch_log    keyPath ["user_id", "phase"]   ('resolve' | 'crawl')

export const DB_NAME = "mutuals-mapper";
export const DB_VERSION = 2;
// Cap log entries kept in IndexedDB so a 17h crawl doesn't bloat indefinitely.
export const LOG_RING_BUFFER_MAX = 5000;

export function openDb(name = DB_NAME, idbFactory = globalThis.indexedDB) {
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

export async function upsertUser(db, user) {
  const tx = db.transaction("users", "readwrite");
  tx.objectStore("users").put(user);
  await _txDone(tx);
}

export async function getUser(db, userId) {
  const tx = db.transaction("users", "readonly");
  const got = await _wrapReq(tx.objectStore("users").get(userId));
  return got || null;
}

// ---------- edges ----------

export function _edgeKey(source_id, target_id) {
  return `${source_id}|${target_id}`;
}

export async function insertEdge(db, edge) {
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

export async function listEdges(db) {
  const tx = db.transaction("edges", "readonly");
  return await _wrapReq(tx.objectStore("edges").getAll());
}

export async function countEdges(db) {
  const tx = db.transaction("edges", "readonly");
  return await _wrapReq(tx.objectStore("edges").count());
}

// ---------- mutuals_seed ----------

export async function setMutuals(db, ids) {
  // Replace the entire set.
  const tx = db.transaction("mutuals_seed", "readwrite");
  const store = tx.objectStore("mutuals_seed");
  store.clear();
  for (const id of ids) store.put({ id });
  await _txDone(tx);
}

export async function listMutuals(db) {
  const tx = db.transaction("mutuals_seed", "readonly");
  const all = await _wrapReq(tx.objectStore("mutuals_seed").getAll());
  return all.map((r) => r.id).sort();
}

// ---------- fetch_log ----------

const VALID_PHASES = new Set(["resolve", "crawl"]);

export async function upsertFetchLog(db, entry, { phase = "crawl" } = {}) {
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

export async function getFetchLog(db, userId, { phase = "crawl" } = {}) {
  const tx = db.transaction("fetch_log", "readonly");
  const got = await _wrapReq(tx.objectStore("fetch_log").get([userId, phase]));
  return got || null;
}

// ---------- pending_mutuals (decision logic) ----------

// Pure, easy to unit-test independently of IndexedDB.
export function needsRefetch(status, attemptedAt, retryAfterHours, now = new Date()) {
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

export async function pendingMutuals(db, retryAfterHours, { now = new Date() } = {}) {
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

export async function appendLogEntry(db, line, { ts = new Date().toISOString() } = {}) {
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").add({ ts, line });
  await _txDone(tx);
  // Trim to keep the ring buffer bounded (cheap; only fires occasionally).
  if (Math.random() < 0.01) await trimLogs(db, LOG_RING_BUFFER_MAX);
}

export async function listLogEntries(db, { limit = 1000 } = {}) {
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

export async function clearLogs(db) {
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").clear();
  await _txDone(tx);
}

export async function trimLogs(db, keepLast) {
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

export async function deleteDb(name = DB_NAME, idbFactory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
