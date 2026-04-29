import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  JitteredPacer, withBackoff, computeBackoffDelay,
  defaultSleep, isAbortError,
} from "../src/pacing.js";

class _Boom extends Error {}
class _Fatal extends Error {}

function recorder() {
  const calls = [];
  const sleep = async (s) => { calls.push(s); };
  return { calls, sleep };
}

function fixedRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("JitteredPacer", () => {
  test("calls sleep within range", async () => {
    const { calls, sleep } = recorder();
    const p = new JitteredPacer(2.0, 4.0, { sleep, rng: fixedRng([0.5]) });
    await p.wait();
    assert.equal(calls.length, 1);
    assert.ok(calls[0] >= 2.0 && calls[0] <= 4.0);
  });

  test("uses injected rng deterministically", async () => {
    const { calls, sleep } = recorder();
    const p = new JitteredPacer(2.0, 4.0, { sleep, rng: fixedRng([0]) });
    await p.wait();
    assert.equal(calls[0], 2.0);
  });

  test("min === max returns constant", async () => {
    const { calls, sleep } = recorder();
    const p = new JitteredPacer(3, 3, { sleep, rng: fixedRng([0.7]) });
    await p.wait();
    await p.wait();
    assert.deepEqual(calls, [3, 3]);
  });

  test("rejects negative or inverted ranges", () => {
    assert.throws(() => new JitteredPacer(-1, 1));
    assert.throws(() => new JitteredPacer(5, 1));
  });
});

describe("computeBackoffDelay", () => {
  test("first attempt is base", () => {
    assert.equal(computeBackoffDelay(0, { base: 30, max: 900 }), 30);
  });
  test("doubles", () => {
    assert.equal(computeBackoffDelay(1, { base: 30, max: 900 }), 60);
    assert.equal(computeBackoffDelay(2, { base: 30, max: 900 }), 120);
  });
  test("caps at max", () => {
    assert.equal(computeBackoffDelay(99, { base: 30, max: 900 }), 900);
  });
});

describe("withBackoff", () => {
  test("returns immediately on success", async () => {
    const { calls, sleep } = recorder();
    const result = await withBackoff(async () => "ok", {
      isRetryable: () => true, baseSeconds: 1, maxSeconds: 10, maxAttempts: 3, sleep,
    });
    assert.equal(result, "ok");
    assert.equal(calls.length, 0);
  });

  test("retries on retryable exception", async () => {
    const { sleep } = recorder();
    let n = 0;
    const result = await withBackoff(async () => {
      n += 1;
      if (n < 3) throw new _Boom();
      return "ok";
    }, {
      isRetryable: (e) => e instanceof _Boom,
      baseSeconds: 1, maxSeconds: 10, maxAttempts: 5, sleep,
    });
    assert.equal(result, "ok");
    assert.equal(n, 3);
  });

  test("does not retry on non-retryable", async () => {
    const { calls, sleep } = recorder();
    await assert.rejects(
      withBackoff(async () => { throw new _Fatal(); }, {
        isRetryable: (e) => e instanceof _Boom,
        baseSeconds: 1, maxSeconds: 10, maxAttempts: 5, sleep,
      }),
      _Fatal,
    );
    assert.equal(calls.length, 0);
  });

  test("exponential growth capped at max", async () => {
    const { calls, sleep } = recorder();
    await assert.rejects(
      withBackoff(async () => { throw new _Boom(); }, {
        isRetryable: () => true,
        baseSeconds: 10, maxSeconds: 40, maxAttempts: 6, sleep,
      }),
      _Boom,
    );
    assert.deepEqual(calls, [10, 20, 40, 40, 40]);
  });

  test("raises after max attempts", async () => {
    const { calls, sleep } = recorder();
    await assert.rejects(
      withBackoff(async () => { throw new _Boom(); }, {
        isRetryable: () => true,
        baseSeconds: 1, maxSeconds: 10, maxAttempts: 3, sleep,
      }),
      _Boom,
    );
    assert.equal(calls.length, 2);
  });
});

describe("cancel via AbortSignal", () => {
  test("isAbortError recognises both DOMException and Node errors", () => {
    assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
    assert.equal(isAbortError({ code: "ABORT_ERR" }), true);
    assert.equal(isAbortError(new Error("nope")), false);
    assert.equal(isAbortError(null), false);
  });

  test("defaultSleep rejects immediately when signal already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(defaultSleep(60, { signal: ctrl.signal }),
      (e) => isAbortError(e));
  });

  test("defaultSleep aborts a long sleep mid-flight", async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    const promise = defaultSleep(60, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await assert.rejects(promise, (e) => isAbortError(e));
    // Should have rejected fast, well under the 60s sleep.
    assert.ok(Date.now() - start < 1000);
  });

  test("JitteredPacer.wait propagates abort", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = new JitteredPacer(0, 0, { signal: ctrl.signal });
    await assert.rejects(p.wait(), (e) => isAbortError(e));
  });

  test("withBackoff stops retrying when signal aborts mid-loop", async () => {
    const ctrl = new AbortController();
    const { sleep, calls } = recorder();
    let attempts = 0;
    const promise = withBackoff(async () => {
      attempts += 1;
      if (attempts === 2) ctrl.abort();
      throw new _Boom();
    }, {
      isRetryable: () => true,
      baseSeconds: 1, maxSeconds: 10, maxAttempts: 99,
      sleep, signal: ctrl.signal,
    });
    await assert.rejects(promise, (e) => isAbortError(e));
    // Two attempts ran before the abort took effect (the loop checks
    // signal.aborted at the *top* of each iteration).
    assert.equal(attempts, 2);
  });
});
