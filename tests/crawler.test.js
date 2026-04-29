import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import "fake-indexeddb/auto";

import { crawl, planCrawl, shouldSkip } from "../src/crawler.js";
import { ClientError, RateLimitError, TransientClientError } from "../src/client.js";
import {
  setMutuals, upsertUser, upsertFetchLog, getFetchLog, countEdges, listEdges,
} from "../src/db.js";
import { FakeClient, recorder, pacer, freshDb, makeUser } from "./_helpers.js";

const DEFAULTS = {
  maxFollowingToConsider: 10000,
  maxFollowingToFetch: 2000,
  backoffBaseSeconds: 1,
  backoffMaxSeconds: 10,
  backoffMaxAttempts: 3,
  retryFailedAfterHours: 24,
};

async function seedMutuals(db, ids, { followingCount = 100 } = {}) {
  await setMutuals(db, ids);
  for (const id of ids) {
    await upsertUser(db, makeUser({ id, handle: `u${id}`, following_count: followingCount }));
  }
}

async function _crawl(db, client, sleep, overrides = {}) {
  return crawl(db, client, { ...DEFAULTS, ...overrides, pacer: pacer(sleep) });
}

describe("shouldSkip (pure)", () => {
  test("above threshold", () => {
    assert.deepEqual(
      shouldSkip(makeUser({ following_count: 50000 }), { maxFollowing: 10000 }),
      [true, "following_count=50000 > 10000"],
    );
  });
  test("user null", () => {
    assert.deepEqual(shouldSkip(null, { maxFollowing: 10000 }), [true, "user_not_resolved"]);
  });
  test("following_count null", () => {
    assert.deepEqual(
      shouldSkip(makeUser({ following_count: null }), { maxFollowing: 10000 }),
      [true, "following_count_unknown"],
    );
  });
  test("just under threshold", () => {
    const [skip] = shouldSkip(makeUser({ following_count: 9999 }), { maxFollowing: 10000 });
    assert.equal(skip, false);
  });
});

describe("planCrawl (no HTTP)", () => {
  test("classifies fetch vs skip", async () => {
    const db = await freshDb();
    await setMutuals(db, ["A", "B"]);
    await upsertUser(db, makeUser({ id: "A", following_count: 50000 }));
    await upsertUser(db, makeUser({ id: "B", following_count: 100 }));
    const plan = await planCrawl(db, { maxFollowing: 10000 });
    assert.deepEqual(plan.willFetch, ["B"]);
    assert.equal(plan.willSkip[0][0], "A");
  });
  test("estimates request count", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"], { followingCount: 100 });
    const plan = await planCrawl(db, { maxFollowing: 10000, pageSize: 20 });
    assert.equal(plan.estimated, 5);
  });
});

describe("resume logic", () => {
  test("skips status=done", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    await upsertFetchLog(db, { user_id: "A", status: "done", error: null,
                                attempted_at: new Date().toISOString() });
    const client = new FakeClient({ followings: { "A": ["X"] } });
    const { sleep } = recorder();
    await _crawl(db, client, sleep);
    assert.ok(!client.calls.some(c => c[0] === "iterFollowing"));
  });

  test("skips status=skipped", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    await upsertFetchLog(db, { user_id: "A", status: "skipped", error: "x",
                                attempted_at: new Date().toISOString() });
    const client = new FakeClient({ followings: { "A": ["X"] } });
    const { sleep } = recorder();
    await _crawl(db, client, sleep);
    assert.ok(!client.calls.some(c => c[0] === "iterFollowing"));
  });

  test("retries pending mutuals", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    const client = new FakeClient({ followings: { "A": [] } });
    const { sleep } = recorder();
    await _crawl(db, client, sleep);
    assert.ok(client.calls.some(c => c[0] === "iterFollowing" && c[1] === "A"));
  });
});

describe("skip rules", () => {
  test("mega-account skipped, fetch_log marked", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"], { followingCount: 50000 });
    const client = new FakeClient({ followings: { "A": ["X"] } });
    const { sleep } = recorder();
    const stats = await _crawl(db, client, sleep);
    assert.equal(stats.mutuals_skipped, 1);
    const log = await getFetchLog(db, "A");
    assert.equal(log.status, "skipped");
    assert.ok(!client.calls.some(c => c[0] === "iterFollowing"));
  });
});

describe("edges", () => {
  test("only writes inter-mutual edges", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B"]);
    const client = new FakeClient({ followings: { "A": ["B", "X", "Y"], "B": [] } });
    const { sleep } = recorder();
    const stats = await _crawl(db, client, sleep);
    assert.equal(stats.edges_written, 1);
    assert.equal(await countEdges(db), 1);
    const e = (await listEdges(db))[0];
    assert.equal(e.source_id, "A"); assert.equal(e.target_id, "B");
  });

  test("self loops dropped", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    const client = new FakeClient({ followings: { "A": ["A"] } });
    const { sleep } = recorder();
    await _crawl(db, client, sleep);
    assert.equal(await countEdges(db), 0);
  });

  test("idempotent on re-run", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B"]);
    const client = new FakeClient({ followings: { "A": ["B"], "B": [] } });
    const { sleep } = recorder();
    await _crawl(db, client, sleep);
    // wipe fetch_log, run again
    const tx = db.transaction("fetch_log", "readwrite");
    await new Promise((res) => { tx.objectStore("fetch_log").clear(); tx.oncomplete = res; });
    await _crawl(db, client, sleep);
    assert.equal(await countEdges(db), 1);
  });
});

describe("backoff", () => {
  test("recovers from transient 503", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B"]);
    const client = new FakeClient({
      followings: { "A": ["B"], "B": [] },
      errors: { "A": [new TransientClientError("503")] },
    });
    const { sleep } = recorder();
    const stats = await _crawl(db, client, sleep);
    assert.equal(stats.mutuals_processed, 2);
    assert.equal((await getFetchLog(db, "A")).status, "done");
  });

  test("recovers from rate limit", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    const client = new FakeClient({
      followings: { "A": [] },
      errors: { "A": [new RateLimitError("rl")] },
    });
    const { sleep } = recorder();
    const stats = await _crawl(db, client, sleep);
    assert.equal(stats.mutuals_processed, 1);
  });

  test("does NOT retry permanent ClientError", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A"]);
    const errs = [
      new ClientError("schema"),
      new ClientError("schema"),
      new ClientError("schema"),
    ];
    const client = new FakeClient({ followings: { "A": [] }, errors: { "A": errs } });
    const { sleep } = recorder();
    const stats = await _crawl(db, client, sleep);
    assert.equal(stats.mutuals_failed, 1);
    // Two errors should still be in the queue (only the first was consumed).
    assert.equal(client.errors["A"].length, 2);
  });
});

describe("progress callback", () => {
  test("fires per-mutual", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B"]);
    const client = new FakeClient({ followings: { "A": [], "B": [] } });
    const { sleep } = recorder();
    const events = [];
    await _crawl(db, client, sleep, { onProgress: (m, s) => events.push([m, s]) });
    assert.equal(events.length, 2);
  });
});

describe("cancel via AbortSignal", () => {
  test("returns partial stats with cancelled=true on pre-aborted signal", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B", "C"]);
    const client = new FakeClient({ followings: { "A": [], "B": [], "C": [] } });
    const { sleep } = recorder();
    const ctrl = new AbortController();
    ctrl.abort();
    const stats = await _crawl(db, client, sleep, { signal: ctrl.signal });
    assert.equal(stats.cancelled, true);
    assert.equal(stats.mutuals_processed, 0);
  });

  test("aborts mid-loop after the first mutual", async () => {
    const db = await freshDb();
    await seedMutuals(db, ["A", "B", "C", "D"]);
    const client = new FakeClient({ followings: { "A": [], "B": [], "C": [], "D": [] } });
    const { sleep } = recorder();
    const ctrl = new AbortController();
    let count = 0;
    const stats = await _crawl(db, client, sleep, {
      signal: ctrl.signal,
      onProgress: () => {
        count += 1;
        if (count === 1) ctrl.abort();
      },
    });
    assert.equal(stats.cancelled, true);
    assert.equal(stats.mutuals_processed, 1);
  });
});
