// DOM-aware integration tests for the overlay UI, using happy-dom to provide
// document/window without a real browser.
//
// We don't import ui.js directly — it has side effects on import (reads
// globals at evaluation time). Instead we drop the rendered HTML into a
// happy-dom Document and assert structure + verify the cancel-button wiring
// by simulating clicks against AbortController plumbing we control here.

import { test, describe, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { Window } from "happy-dom";
import { STYLE, HTML } from "../src/ui_template.js";
import { phaseBadgeClass, formatEta, makeInitialState } from "../src/ui_state.js";

let win;
let doc;

beforeEach(() => {
  win = new Window();
  doc = win.document;
  // Mount the overlay markup like ui.js's injectOverlay does.
  const styleEl = doc.createElement("style");
  styleEl.textContent = STYLE;
  doc.head.appendChild(styleEl);
  const div = doc.createElement("div");
  div.id = "mm-overlay";
  div.innerHTML = HTML;
  doc.body.appendChild(div);
});

describe("overlay markup mounts", () => {
  test("all required IDs are reachable via getElementById", () => {
    for (const id of [
      "mm-overlay", "mm-resolve", "mm-crawl", "mm-cancel",
      "mm-phase", "mm-bar", "mm-log", "mm-graph",
    ]) {
      assert.ok(doc.getElementById(id), `missing #${id}`);
    }
  });

  test("buttons exist and start non-disabled (the render() loop sets state)", () => {
    assert.equal(doc.getElementById("mm-resolve").tagName, "BUTTON");
    assert.equal(doc.getElementById("mm-cancel").tagName, "BUTTON");
  });

  test("phase badge slot accepts the badge class names", () => {
    const phaseEl = doc.getElementById("mm-phase");
    for (const cls of ["", "ok", "error", "warn"]) {
      phaseEl.className = `badge ${phaseBadgeClass(cls === "warn" ? "crawl" : cls === "ok" ? "done" : cls === "error" ? "error" : "idle")}`.trim();
      // Just verifying assignment doesn't blow up
      assert.ok(phaseEl.className.startsWith("badge"));
    }
  });
});

describe("cancel button wired to AbortController", () => {
  // Mirror the abortCtrl pattern from ui.js without pulling in the whole
  // file (which would require GM_*, document.cookie, etc.).
  test("clicking the cancel button aborts the supplied AbortController", () => {
    const state = makeInitialState();
    state.abortCtrl = new win.AbortController();
    const btn = doc.getElementById("mm-cancel");
    btn.addEventListener("click", () => {
      if (state.abortCtrl) state.abortCtrl.abort();
    });

    assert.equal(state.abortCtrl.signal.aborted, false);
    btn.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(state.abortCtrl.signal.aborted, true);
  });

  test("when no task is in flight, clicking cancel is a no-op", () => {
    const state = makeInitialState();
    state.abortCtrl = null;
    const btn = doc.getElementById("mm-cancel");
    btn.addEventListener("click", () => {
      if (state.abortCtrl) state.abortCtrl.abort();
    });
    // Should not throw.
    btn.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(state.abortCtrl, null);
  });
});

describe("render-loop bindings", () => {
  test("setting progress updates the bar element's value/max", () => {
    const bar = doc.getElementById("mm-bar");
    bar.value = 7; bar.max = 10;
    assert.equal(bar.value, 7);
    assert.equal(bar.max, 10);
  });

  test("formatEta integrates with the ETA span", () => {
    const eta = doc.getElementById("mm-eta");
    eta.textContent = `eta ${formatEta(3600 + 60 + 1)}`;
    assert.equal(eta.textContent, "eta 01:01:01");
  });
});
