import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  BEARER, BASE_URL, DEFAULT_HASHES,
  extractOpHashes, discoverOpHashesFromPerformance, currentHashes,
  freshnessReport,
} from "../src/op_hashes.js";

describe("constants", () => {
  test("BEARER is set", () => assert.ok(BEARER && BEARER.length > 50));
  test("BASE_URL is x.com", () => assert.equal(BASE_URL, "https://x.com"));
  test("default hashes include the four we use", () => {
    for (const op of ["UserByRestId", "UserByScreenName", "Following", "Followers"]) {
      assert.ok(DEFAULT_HASHES[op], `missing default for ${op}`);
    }
  });
});

describe("extractOpHashes", () => {
  test("pulls hash + operation name from a URL", () => {
    const urls = [
      "https://x.com/i/api/graphql/AbC123/UserByRestId?variables=%7B%7D",
      "https://x.com/i/api/graphql/XyZ789/Following",
    ];
    assert.deepEqual(extractOpHashes(urls), {
      UserByRestId: "AbC123",
      Following: "XyZ789",
    });
  });

  test("ignores non-graphql URLs", () => {
    const urls = ["https://x.com/foo", "https://x.com/i/api/2/notifications"];
    assert.deepEqual(extractOpHashes(urls), {});
  });

  test("first occurrence wins", () => {
    const urls = [
      "https://x.com/i/api/graphql/first/Following",
      "https://x.com/i/api/graphql/second/Following",
    ];
    assert.deepEqual(extractOpHashes(urls), { Following: "first" });
  });

  test("tolerates non-strings", () => {
    assert.deepEqual(extractOpHashes(["x", null, 5, "https://x.com/i/api/graphql/abc/Op"]),
                     { Op: "abc" });
  });
});

describe("discoverOpHashesFromPerformance", () => {
  test("empty when no perf api", () => {
    assert.deepEqual(discoverOpHashesFromPerformance(null), {});
    assert.deepEqual(discoverOpHashesFromPerformance({}), {});
  });

  test("reads Resource Timing entries", () => {
    const perf = {
      getEntriesByType: (k) => k === "resource" ? [
        { name: "https://x.com/i/api/graphql/HASH1/UserByRestId" },
        { name: "https://x.com/i/api/graphql/HASH2/Following" },
      ] : [],
    };
    assert.deepEqual(discoverOpHashesFromPerformance(perf), {
      UserByRestId: "HASH1",
      Following: "HASH2",
    });
  });
});

describe("freshnessReport", () => {
  test("stale when no GraphQL traffic seen", () => {
    const perf = { getEntriesByType: () => [] };
    assert.deepEqual(freshnessReport(perf), { status: "stale", count: 0 });
  });

  test("fresh when at least one op observed", () => {
    const perf = {
      getEntriesByType: () => [
        { name: "https://x.com/i/api/graphql/HASH/UserByRestId" },
        { name: "https://x.com/i/api/graphql/HASH2/Following" },
      ],
    };
    assert.deepEqual(freshnessReport(perf), { status: "fresh", count: 2 });
  });

  test("missing perf API is stale", () => {
    assert.equal(freshnessReport(null).status, "stale");
  });
});

describe("currentHashes", () => {
  test("falls back to defaults when nothing observed", () => {
    const perf = { getEntriesByType: () => [] };
    const hashes = currentHashes(perf);
    assert.equal(hashes.UserByRestId, DEFAULT_HASHES.UserByRestId);
    assert.equal(hashes.Following, DEFAULT_HASHES.Following);
  });

  test("observed hashes override defaults", () => {
    const perf = {
      getEntriesByType: () => [
        { name: "https://x.com/i/api/graphql/NEWHASH/UserByRestId" },
      ],
    };
    const hashes = currentHashes(perf);
    assert.equal(hashes.UserByRestId, "NEWHASH");
    // others fall back
    assert.equal(hashes.Following, DEFAULT_HASHES.Following);
  });
});
