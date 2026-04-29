// Pure-helper tests for ui_state.js. No DOM needed — see ui.test.js for the
// DOM integration tests built on happy-dom.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  loadCfg, saveCfg, formatEta, phaseBadgeClass,
  makeInitialState, resetProgress, appendLogLine, LOG_TAIL_MAX,
  isLoggedIn, selfIdFromCookies,
} from "../src/ui_state.js";
import { DEFAULT_CFG } from "../src/ui_template.js";

describe("formatEta", () => {
  test("null -> --", () => assert.equal(formatEta(null), "--"));
  test("negative -> --", () => assert.equal(formatEta(-5), "--"));
  test("zero -> 00:00:00", () => assert.equal(formatEta(0), "00:00:00"));
  test("60s -> 00:01:00", () => assert.equal(formatEta(60), "00:01:00"));
  test("3661s -> 01:01:01", () => assert.equal(formatEta(3661), "01:01:01"));
  test("hours roll over", () => assert.equal(formatEta(7322), "02:02:02"));
});

describe("phaseBadgeClass", () => {
  test("done -> ok", () => assert.equal(phaseBadgeClass("done"), "ok"));
  test("error -> error", () => assert.equal(phaseBadgeClass("error"), "error"));
  test("idle -> empty", () => assert.equal(phaseBadgeClass("idle"), ""));
  test("crawl -> warn", () => assert.equal(phaseBadgeClass("crawl"), "warn"));
  test("resolve -> warn", () => assert.equal(phaseBadgeClass("resolve"), "warn"));
});

describe("loadCfg / saveCfg", () => {
  test("defaults when storage empty", () => {
    const cfg = loadCfg(() => null);
    assert.deepEqual(cfg, DEFAULT_CFG);
  });
  test("merges user overrides on top of defaults", () => {
    const stored = { request_min_seconds: 5, louvain_seed: 7 };
    const cfg = loadCfg((_k, _d) => stored);
    assert.equal(cfg.request_min_seconds, 5);
    assert.equal(cfg.louvain_seed, 7);
    // unmodified keys keep defaults
    assert.equal(cfg.max_following_to_consider, DEFAULT_CFG.max_following_to_consider);
  });
  test("saveCfg calls setValue with key + payload", () => {
    const calls = [];
    saveCfg({ request_min_seconds: 10 }, (k, v) => calls.push([k, v]));
    assert.deepEqual(calls, [["cfg", { request_min_seconds: 10 }]]);
  });
  test("loadCfg/saveCfg no-op when storage isn't configured", () => {
    const cfg = loadCfg(null);
    assert.deepEqual(cfg, DEFAULT_CFG);
    // Should not throw
    saveCfg({}, null);
  });
});

describe("makeInitialState", () => {
  test("starts at idle with empty log + no task", () => {
    const s = makeInitialState();
    assert.equal(s.phase, "idle");
    assert.equal(s.log.length, 0);
    assert.equal(s.task, null);
    assert.equal(s.abortCtrl, null);
    assert.deepEqual(s.cfg, DEFAULT_CFG);
  });
  test("each call returns a fresh state (no shared mutability)", () => {
    const a = makeInitialState();
    const b = makeInitialState();
    a.log.push("x");
    a.cfg.louvain_seed = 999;
    assert.equal(b.log.length, 0);
    assert.equal(b.cfg.louvain_seed, DEFAULT_CFG.louvain_seed);
  });
});

describe("resetProgress", () => {
  test("clears completed/total/eta/err and sets phase + message", () => {
    const s = makeInitialState();
    s.completed = 50; s.total = 100; s.etaSeconds = 30; s.err = "boom";
    resetProgress(s, "crawl", "go");
    assert.equal(s.phase, "crawl");
    assert.equal(s.message, "go");
    assert.equal(s.completed, 0);
    assert.equal(s.total, 0);
    assert.equal(s.etaSeconds, null);
    assert.equal(s.err, null);
  });
  test("default empty message", () => {
    const s = makeInitialState();
    resetProgress(s, "resolve");
    assert.equal(s.message, "");
  });
});

describe("isLoggedIn (cookie-based heuristic)", () => {
  test("true when ct0 is present", () => {
    assert.equal(isLoggedIn("foo=bar; ct0=abc; baz=qux"), true);
  });
  test("true when ct0 starts the string", () => {
    assert.equal(isLoggedIn("ct0=abc; foo=bar"), true);
  });
  test("false when ct0 is missing", () => {
    // auth_token is HttpOnly, so even if logged in, JS won't see it.
    // Without ct0 there's no JS-visible signal of auth.
    assert.equal(isLoggedIn("guest_id=v1%3A123"), false);
  });
  test("false on empty / null / undefined", () => {
    assert.equal(isLoggedIn(""), false);
    assert.equal(isLoggedIn(null), false);
    assert.equal(isLoggedIn(undefined), false);
  });
  test("does NOT match a substring like xct0= or my_ct0=", () => {
    // boundary check — ct0 must be at start or after `; `
    assert.equal(isLoggedIn("xct0=fake"), false);
    assert.equal(isLoggedIn("my_ct0=fake"), false);
  });
});

describe("selfIdFromCookies", () => {
  test("extracts user_id from the twid cookie (URL-encoded form)", () => {
    assert.equal(selfIdFromCookies("twid=u%3D12345; ct0=abc"), "12345");
  });
  test("extracts when twid value is quoted", () => {
    assert.equal(selfIdFromCookies('twid="u%3D67890"'), "67890");
  });
  test("null when twid is missing", () => {
    assert.equal(selfIdFromCookies("ct0=abc; guest_id=v1"), null);
  });
  test("null on empty / nullish", () => {
    assert.equal(selfIdFromCookies(""), null);
    assert.equal(selfIdFromCookies(null), null);
  });
});

describe("appendLogLine + LOG_TAIL_MAX", () => {
  test("appends with timestamp prefix", () => {
    const s = makeInitialState();
    appendLogLine(s, "hello", { now: () => new Date("2026-04-28T15:30:45Z") });
    // toLocaleTimeString varies by locale (12h vs 24h, AM/PM, etc.) — just
    // assert the message ends the line and a time-shape prefix exists.
    assert.match(s.log[0], /\d\d?:\d\d(:\d\d)?(\s*[AP]M)?\s+hello$/);
  });
  test("rolls off the oldest line past LOG_TAIL_MAX", () => {
    const s = makeInitialState();
    for (let i = 0; i < LOG_TAIL_MAX + 5; i++) appendLogLine(s, `line ${i}`);
    assert.equal(s.log.length, LOG_TAIL_MAX);
    // First retained line should be "line 5" (5 oldest shifted off)
    assert.match(s.log[0], /line 5$/);
  });
});
