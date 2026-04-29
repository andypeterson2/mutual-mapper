import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import "fake-indexeddb/auto";

import { buildGraphData, componentLouvain, buildGraphFromDb } from "../src/viz.js";
import { setMutuals, upsertUser, insertEdge } from "../src/db.js";
import { freshDb, makeUser } from "./_helpers.js";

describe("buildGraphData", () => {
  test("empty input -> empty graph", () => {
    assert.deepEqual(buildGraphData([], []), { nodes: [], edges: [] });
  });

  test("undirected edges deduped", () => {
    const g = buildGraphData(
      [makeUser({ id: "A" }), makeUser({ id: "B" })],
      [{ source_id: "A", target_id: "B" }, { source_id: "B", target_id: "A" }],
    );
    assert.equal(g.edges.length, 1);
  });

  test("min_degree drops isolated nodes", () => {
    const g = buildGraphData(
      [makeUser({ id: "A" }), makeUser({ id: "B" }), makeUser({ id: "C" })],
      [{ source_id: "A", target_id: "B" }],
      { minDegree: 1 },
    );
    assert.deepEqual(g.nodes.map(n => n.id).sort(), ["A", "B"]);
  });

  test("connected components get distinct communities (fallback)", () => {
    const g = buildGraphData(
      [makeUser({ id: "A" }), makeUser({ id: "B" }), makeUser({ id: "C" }), makeUser({ id: "D" })],
      [{ source_id: "A", target_id: "B" }, { source_id: "C", target_id: "D" }],
    );
    const communities = new Set(g.nodes.map(n => n.community));
    assert.equal(communities.size, 2);
  });

  test("nodes sorted by id deterministically", () => {
    const g = buildGraphData(
      [makeUser({ id: "C" }), makeUser({ id: "A" }), makeUser({ id: "B" })],
      [{ source_id: "A", target_id: "B" }, { source_id: "B", target_id: "C" }],
    );
    assert.deepEqual(g.nodes.map(n => n.id), ["A", "B", "C"]);
  });

  test("size scales with degree (size_exponent)", () => {
    const g = buildGraphData(
      [makeUser({ id: "A" }), makeUser({ id: "B" }), makeUser({ id: "C" })],
      [{ source_id: "A", target_id: "B" }, { source_id: "A", target_id: "C" }],
      { sizeExponent: 1.0 },
    );
    const a = g.nodes.find(n => n.id === "A");
    const b = g.nodes.find(n => n.id === "B");
    assert.ok(a.size > b.size);
  });
});

describe("componentLouvain (fallback)", () => {
  test("single component -> one community", () => {
    const adj = new Map([
      ["A", new Set(["B"])], ["B", new Set(["A", "C"])], ["C", new Set(["B"])],
    ]);
    const c = componentLouvain(adj);
    assert.equal(new Set(c.values()).size, 1);
  });

  test("two components -> two communities", () => {
    const adj = new Map([
      ["A", new Set(["B"])], ["B", new Set(["A"])],
      ["C", new Set(["D"])], ["D", new Set(["C"])],
    ]);
    const c = componentLouvain(adj);
    assert.equal(new Set(c.values()).size, 2);
  });

  test("deterministic across runs", () => {
    const adj = new Map([
      ["X", new Set(["Y"])], ["Y", new Set(["X"])],
    ]);
    assert.deepEqual([...componentLouvain(adj).entries()],
                     [...componentLouvain(adj).entries()]);
  });
});

describe("renderGraph XSS hardening (source inspection)", () => {
  // We can't run renderGraph in node (no D3 / no DOM), but we can assert the
  // source contains the expected escape helpers — locks in the fix without
  // requiring a browser test runner.
  test("escapeHtml helper is present", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/viz.js", import.meta.url), "utf8");
    assert.match(src, /const escapeHtml\s*=/);
  });
  test("every tooltip interpolation goes through escapeHtml", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/viz.js", import.meta.url), "utf8");
    const m = src.match(/tip\.style\("opacity",\s*1\)\.html\(([\s\S]*?)\)\s*\.style/);
    assert.ok(m, "tooltip block not found");
    const block = m[1];
    for (const field of ["d.handle", "d.name", "d.bio", "d.followers_count", "d.degree", "d.community"]) {
      const raw = "${" + field;
      let idx = 0;
      while ((idx = block.indexOf(raw, idx)) !== -1) {
        const preceding = block.slice(Math.max(0, idx - 30), idx);
        assert.match(preceding, /escapeHtml\(/,
          `raw ${raw} interpolation must be wrapped in escapeHtml(): "${block.slice(Math.max(0, idx - 30), idx + 30)}"`);
        idx += raw.length;
      }
    }
  });
  test("profile link uses encodeURIComponent on handle", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/viz.js", import.meta.url), "utf8");
    assert.match(src, /encodeURIComponent\(d\.handle\)/);
  });
});

describe("buildGraphFromDb", () => {
  test("end-to-end through IndexedDB", async () => {
    const db = await freshDb();
    await setMutuals(db, ["1", "2", "3"]);
    await upsertUser(db, makeUser({ id: "1" }));
    await upsertUser(db, makeUser({ id: "2" }));
    await upsertUser(db, makeUser({ id: "3" }));
    await insertEdge(db, { source_id: "1", target_id: "2", fetched_at: "t" });
    await insertEdge(db, { source_id: "2", target_id: "3", fetched_at: "t" });
    const g = await buildGraphFromDb(db);
    assert.equal(g.nodes.length, 3);
    assert.equal(g.edges.length, 2);
  });
});
