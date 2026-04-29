// Sanity tests for the HTML/CSS template strings. We don't render — these
// just guard against bit-rot drift between the template's IDs and the IDs
// that ui.js's event handlers + render() depend on.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { STYLE, HTML, DEFAULT_CFG } from "../src/ui_template.js";

// Note: `mm-overlay` is the *container* div that ui.js creates and sets the
// HTML on — the inner template doesn't (and shouldn't) self-reference it.
const REQUIRED_IDS = [
  "mm-close", "mm-acct", "mm-hashes", "mm-seed",
  "mm-archive", "mm-fetch-from-api", "mm-save-cfg",
  "mm-resolve", "mm-crawl", "mm-cancel",
  "mm-phase", "mm-phase-msg", "mm-bar", "mm-prog", "mm-eta",
  "mm-err", "mm-log", "mm-export-logs", "mm-clear-logs",
  "mm-render", "mm-graph",
  "cfg-min", "cfg-max", "cfg-consider", "cfg-fetch",
  "cfg-backoff-base", "cfg-backoff-max", "cfg-backoff-attempts",
  "cfg-retry", "cfg-mindeg", "cfg-seed",
];

describe("HTML template", () => {
  for (const id of REQUIRED_IDS) {
    test(`contains element id="${id}"`, () => {
      assert.match(HTML, new RegExp(`id="${id}"`));
    });
  }

  test("HTML is non-trivial (sanity)", () => {
    assert.ok(HTML.length > 1000);
  });
});

describe("STYLE", () => {
  test("scopes everything under #mm-overlay", () => {
    // Every selector in the stylesheet should start with #mm-overlay or
    // #mm-launcher (the floating button). Avoids leaking styles into x.com.
    const lines = STYLE.split("\n").map((l) => l.trim()).filter(Boolean);
    const selectors = lines
      .filter((l) => l.endsWith("{"))
      .map((l) => l.slice(0, -1).trim());
    for (const sel of selectors) {
      assert.ok(
        sel.startsWith("#mm-overlay") || sel.startsWith("#mm-launcher"),
        `unscoped selector "${sel}" — would leak into x.com`,
      );
    }
  });
});

describe("DEFAULT_CFG", () => {
  test("includes every key the UI inputs read", () => {
    const required = [
      "request_min_seconds", "request_max_seconds",
      "max_following_to_consider", "max_following_to_fetch",
      "backoff_base_seconds", "backoff_max_seconds", "backoff_max_attempts",
      "retry_failed_after_hours", "min_degree", "louvain_seed", "size_exponent",
    ];
    for (const k of required) {
      assert.ok(k in DEFAULT_CFG, `DEFAULT_CFG missing key: ${k}`);
    }
  });
  test("all numeric defaults", () => {
    for (const [k, v] of Object.entries(DEFAULT_CFG)) {
      assert.equal(typeof v, "number", `${k} is not a number`);
    }
  });
});
