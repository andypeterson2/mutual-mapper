import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { EtaTracker } from "../src/eta.js";

function fakeClock() {
  let t = 1000;
  const fn = () => t;
  fn.advance = (s) => { t += s; };
  return fn;
}

describe("EtaTracker", () => {
  test("formats dashes before first tick", () => {
    const eta = new EtaTracker(10);
    assert.equal(eta.formatRemaining(), "--");
    assert.equal(eta.remainingSeconds(), null);
  });

  test("uses rolling average", () => {
    const clock = fakeClock();
    const eta = new EtaTracker(10, { now: clock });
    clock.advance(2); eta.tick();
    clock.advance(4); eta.tick();
    // avg = 3, 8 remaining -> 24
    assert.equal(eta.remainingSeconds(), 24);
  });

  test("formats HH:MM:SS", () => {
    const clock = fakeClock();
    const eta = new EtaTracker(100, { now: clock });
    clock.advance(60); eta.tick();
    // 60s/tick * 99 = 5940s = 01:39:00
    assert.equal(eta.formatRemaining(), "01:39:00");
  });

  test("window caps at N", () => {
    const clock = fakeClock();
    const eta = new EtaTracker(100, { window: 2, now: clock });
    for (const d of [1, 2, 3, 4]) {
      clock.advance(d);
      eta.tick();
    }
    // window keeps last 2 deltas (3, 4) -> avg 3.5; 96 remaining * 3.5 = 336
    assert.equal(eta.remainingSeconds(), 336);
  });

  test("zero remaining when complete", () => {
    const clock = fakeClock();
    const eta = new EtaTracker(2, { now: clock });
    clock.advance(1); eta.tick();
    clock.advance(1); eta.tick();
    assert.equal(eta.remainingSeconds(), 0);
  });
});
