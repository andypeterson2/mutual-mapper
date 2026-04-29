import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import "fake-indexeddb/auto";

import { resolveUsers } from "../src/resolver.js";
import { ClientError } from "../src/client.js";
import { getUser, getFetchLog, upsertUser } from "../src/db.js";
import { FakeClient, recorder, pacer, freshDb, makeUser } from "./_helpers.js";

describe("resolveUsers", () => {
  test("writes users to db", async () => {
    const db = await freshDb();
    const client = new FakeClient({
      users: { "1": makeUser({ id: "1", handle: "alice" }),
               "2": makeUser({ id: "2", handle: "bob" }) },
    });
    const { sleep } = recorder();
    const stats = await resolveUsers(db, client, new Set(["1", "2"]), { pacer: pacer(sleep) });
    assert.equal(stats.resolved, 2);
    assert.equal((await getUser(db, "1")).handle, "alice");
    assert.equal((await getUser(db, "2")).handle, "bob");
  });

  test("one call per id", async () => {
    const db = await freshDb();
    const users = {};
    for (let i = 0; i < 5; i++) users[String(i)] = makeUser({ id: String(i), handle: `u${i}` });
    const client = new FakeClient({ users });
    const { sleep } = recorder();
    await resolveUsers(db, client, new Set(Object.keys(users)), { pacer: pacer(sleep) });
    const ids = client.calls.filter(c => c[0] === "getUserByRestId").map(c => c[1]);
    assert.deepEqual(ids.sort(), ["0", "1", "2", "3", "4"]);
  });

  test("paces between calls (N-1 sleeps)", async () => {
    const db = await freshDb();
    const users = {};
    for (let i = 0; i < 5; i++) users[String(i)] = makeUser({ id: String(i), handle: `u${i}` });
    const client = new FakeClient({ users });
    const { calls, sleep } = recorder();
    await resolveUsers(db, client, new Set(Object.keys(users)), { pacer: pacer(sleep) });
    assert.equal(calls.length, 4);
  });

  test("records fetch_log done on success (phase=resolve)", async () => {
    const db = await freshDb();
    const client = new FakeClient({ users: { "1": makeUser({ id: "1" }) } });
    const { sleep } = recorder();
    await resolveUsers(db, client, new Set(["1"]), { pacer: pacer(sleep) });
    const log = await getFetchLog(db, "1", { phase: "resolve" });
    assert.equal(log.status, "done");
  });

  test("records fetch_log failed on persistent ClientError", async () => {
    const db = await freshDb();
    const client = new FakeClient({ errors: { "1": [new ClientError("nope")] } });
    const { sleep } = recorder();
    const stats = await resolveUsers(db, client, new Set(["1"]), { pacer: pacer(sleep) });
    assert.equal(stats.failed, 1);
    const log = await getFetchLog(db, "1", { phase: "resolve" });
    assert.equal(log.status, "failed");
    assert.equal(log.error, "nope");
  });

  test("user not found logged as failed/not_found", async () => {
    const db = await freshDb();
    const users = {};
    for (let i = 0; i < 4; i++) users[String(i)] = makeUser({ id: String(i) });
    const client = new FakeClient({ users });
    const { sleep } = recorder();
    const stats = await resolveUsers(db, client, new Set(["0", "1", "2", "3", "4"]),
      { pacer: pacer(sleep) });
    assert.equal(stats.resolved, 4);
    assert.equal(stats.not_found, 1);
    const log = await getFetchLog(db, "4", { phase: "resolve" });
    assert.equal(log.status, "failed");
    assert.equal(log.error, "not_found");
  });

  test("skips already fresh users", async () => {
    const db = await freshDb();
    // Pre-populate with a fetched_at == now (well within 24h)
    const fresh = makeUser({ id: "1", fetched_at: new Date().toISOString() });
    await upsertUser(db, fresh);
    const client = new FakeClient({
      users: { "1": makeUser({ id: "1" }), "2": makeUser({ id: "2" }) },
    });
    const { sleep } = recorder();
    const stats = await resolveUsers(db, client, new Set(["1", "2"]),
      { pacer: pacer(sleep), retryAfterHours: 24 });
    assert.equal(stats.resolved, 1);
    const ids = client.calls.filter(c => c[0] === "getUserByRestId").map(c => c[1]);
    assert.deepEqual(ids, ["2"]);
  });

  test("progress callback invoked", async () => {
    const db = await freshDb();
    const users = {};
    for (let i = 0; i < 3; i++) users[String(i)] = makeUser({ id: String(i) });
    const client = new FakeClient({ users });
    const { sleep } = recorder();
    const events = [];
    await resolveUsers(db, client, new Set(Object.keys(users)),
      { pacer: pacer(sleep), onProgress: (d, t) => events.push([d, t]) });
    assert.deepEqual(events.at(-1), [3, 3]);
  });

  test("empty input no calls no writes", async () => {
    const db = await freshDb();
    const client = new FakeClient();
    const { sleep } = recorder();
    const stats = await resolveUsers(db, client, new Set(), { pacer: pacer(sleep) });
    assert.equal(stats.resolved, 0);
    assert.equal(client.calls.length, 0);
  });

  test("cancelled returns partial stats with cancelled=true", async () => {
    const db = await freshDb();
    const users = {};
    for (let i = 0; i < 10; i++) users[String(i)] = makeUser({ id: String(i) });
    const client = new FakeClient({ users });
    const { sleep } = recorder();
    const ctrl = new AbortController();
    // Abort right away; the loop's top-of-iteration check fires before any work.
    ctrl.abort();
    const stats = await resolveUsers(db, client, new Set(Object.keys(users)),
      { pacer: pacer(sleep), signal: ctrl.signal });
    assert.equal(stats.cancelled, true);
    assert.equal(stats.resolved, 0);
  });
});
