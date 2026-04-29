// Tests for db.js using fake-indexeddb (works in node).
import { test, describe, before, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import "fake-indexeddb/auto";

import {
  openDb, deleteDb, upsertUser, getUser, insertEdge, listEdges, countEdges,
  setMutuals, listMutuals, upsertFetchLog, getFetchLog, pendingMutuals,
  needsRefetch, appendLogEntry, listLogEntries, clearLogs, trimLogs,
} from "../src/db.js";

let dbCounter = 0;
async function freshDb() {
  const name = `test-${dbCounter++}-${Date.now()}`;
  return await openDb(name);
}

describe("schema + CRUD", () => {
  test("creates all stores on open", async () => {
    const db = await freshDb();
    const names = Array.from(db.objectStoreNames).sort();
    assert.deepEqual(names, ["edges", "fetch_log", "logs", "mutuals_seed", "users"]);
    db.close();
  });

  test("upsertUser then getUser round-trips", async () => {
    const db = await freshDb();
    await upsertUser(db, { id: "1", handle: "alice", name: "Alice", bio: "bio",
                            followers_count: 10, following_count: 20,
                            fetched_at: "2026-04-28T00:00:00Z", protected: false });
    const got = await getUser(db, "1");
    assert.equal(got.handle, "alice");
    assert.equal(got.followers_count, 10);
  });

  test("getUser returns null for unknown", async () => {
    const db = await freshDb();
    assert.equal(await getUser(db, "missing"), null);
  });

  test("upsertUser overwrites existing", async () => {
    const db = await freshDb();
    await upsertUser(db, { id: "1", handle: "alice" });
    await upsertUser(db, { id: "1", handle: "ALICE" });
    assert.equal((await getUser(db, "1")).handle, "ALICE");
  });

  test("preserves long string ids", async () => {
    const db = await freshDb();
    const longId = "1820000000000000123";
    await upsertUser(db, { id: longId, handle: "x" });
    const got = await getUser(db, longId);
    assert.equal(got.id, longId);
  });
});

describe("edges", () => {
  test("insertEdge basic", async () => {
    const db = await freshDb();
    await insertEdge(db, { source_id: "1", target_id: "2", fetched_at: "t" });
    assert.equal(await countEdges(db), 1);
  });

  test("self-loops dropped silently", async () => {
    const db = await freshDb();
    await insertEdge(db, { source_id: "1", target_id: "1", fetched_at: "t" });
    assert.equal(await countEdges(db), 0);
  });

  test("duplicate insert is no-op", async () => {
    const db = await freshDb();
    await insertEdge(db, { source_id: "1", target_id: "2", fetched_at: "t1" });
    await insertEdge(db, { source_id: "1", target_id: "2", fetched_at: "t2" });
    assert.equal(await countEdges(db), 1);
  });
});

describe("mutuals_seed", () => {
  test("setMutuals replaces full set", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1", "2", "3"]);
    await setMutuals(db, ["4", "5"]);
    assert.deepEqual(await listMutuals(db), ["4", "5"]);
  });

  test("listMutuals returns sorted", async () => {
    const db = await freshDb();
    await setMutuals(db, ["3", "1", "2"]);
    assert.deepEqual(await listMutuals(db), ["1", "2", "3"]);
  });
});

describe("fetch_log + pendingMutuals", () => {
  function entry(uid, status, hoursAgo = 0) {
    const attempted = new Date(2026, 3, 28, 12);
    attempted.setHours(attempted.getHours() - hoursAgo);
    return { user_id: uid, status, error: null, attempted_at: attempted.toISOString() };
  }

  test("upsert + get round trip per phase", async () => {
    const db = await freshDb();
    await upsertFetchLog(db, entry("1", "done"), { phase: "resolve" });
    await upsertFetchLog(db, entry("1", "in_progress"), { phase: "crawl" });
    assert.equal((await getFetchLog(db, "1", { phase: "resolve" })).status, "done");
    assert.equal((await getFetchLog(db, "1", { phase: "crawl" })).status, "in_progress");
  });

  test("pendingMutuals excludes done/skipped (crawl phase)", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1", "2", "3"]);
    await upsertFetchLog(db, entry("1", "done"));
    await upsertFetchLog(db, entry("2", "skipped"));
    const pending = await pendingMutuals(db, 24);
    assert.deepEqual(pending, ["3"]);
  });

  test("pendingMutuals re-includes failed after retry window", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1"]);
    await upsertFetchLog(db, entry("1", "failed", 48));
    const now = new Date(2026, 3, 28, 12);
    const pending = await pendingMutuals(db, 24, { now });
    assert.deepEqual(pending, ["1"]);
  });

  test("pendingMutuals does NOT re-include failed within window", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1"]);
    await upsertFetchLog(db, entry("1", "failed", 1));
    const now = new Date(2026, 3, 28, 12);
    const pending = await pendingMutuals(db, 24, { now });
    assert.deepEqual(pending, []);
  });

  test("includes pending and in_progress", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1", "2"]);
    await upsertFetchLog(db, entry("1", "pending"));
    await upsertFetchLog(db, entry("2", "in_progress"));
    assert.deepEqual(await pendingMutuals(db, 24), ["1", "2"]);
  });
});

describe("logs (durable ring buffer)", () => {
  test("append + list round trip preserves order", async () => {
    const db = await freshDb();
    for (let i = 0; i < 5; i++) {
      await appendLogEntry(db, `line ${i}`, { ts: `t${i}` });
    }
    const got = await listLogEntries(db);
    assert.deepEqual(got.map((e) => e.line), ["line 0", "line 1", "line 2", "line 3", "line 4"]);
  });

  test("listLogEntries respects limit (most recent kept)", async () => {
    const db = await freshDb();
    for (let i = 0; i < 10; i++) {
      await appendLogEntry(db, `line ${i}`, { ts: `t${i}` });
    }
    const got = await listLogEntries(db, { limit: 3 });
    assert.deepEqual(got.map((e) => e.line), ["line 7", "line 8", "line 9"]);
  });

  test("clearLogs wipes the store", async () => {
    const db = await freshDb();
    await appendLogEntry(db, "hello");
    await clearLogs(db);
    assert.deepEqual(await listLogEntries(db), []);
  });

  test("trimLogs drops oldest beyond keepLast", async () => {
    const db = await freshDb();
    for (let i = 0; i < 10; i++) {
      await appendLogEntry(db, `line ${i}`, { ts: `t${i}` });
    }
    await trimLogs(db, 4);
    const got = await listLogEntries(db);
    assert.deepEqual(got.map((e) => e.line),
                     ["line 6", "line 7", "line 8", "line 9"]);
  });
});

describe("needsRefetch (pure)", () => {
  test("null -> true", () => assert.equal(needsRefetch(null, null, 24), true));
  test("done -> false", () => assert.equal(needsRefetch("done", "anything", 24), false));
  test("skipped -> false", () => assert.equal(needsRefetch("skipped", "x", 24), false));
  test("failed within window -> false", () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const just_now = new Date("2026-04-28T11:00:00Z").toISOString();
    assert.equal(needsRefetch("failed", just_now, 24, now), false);
  });
  test("failed beyond window -> true", () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const long_ago = new Date("2026-04-26T00:00:00Z").toISOString();
    assert.equal(needsRefetch("failed", long_ago, 24, now), true);
  });
  test("unknown status -> false (defensive)", () => {
    assert.equal(needsRefetch("weird-status", "x", 24), false);
  });
});
