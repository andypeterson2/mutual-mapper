// Twitter/X GraphQL operation hashes.
//
// These rotate every few months when X ships a new client build. To survive
// rotations without code changes we:
//   1. Bake in the most recent known-good values (mirrored from twscrape).
//   2. At runtime, scrape the live x.com page for current hashes by inspecting
//      `performance.getEntriesByType('resource')` — the user is browsing x.com
//      while the userscript runs, so x.com's own GraphQL calls get logged
//      there. We extract `<HASH>/<OperationName>` from those URLs.
//   3. Discovered hashes override the baked-in defaults.
//
// Auth bearer token: the public web bearer x.com has used for years. Public,
// not secret. If it ever changes, scrape it from any GraphQL request's
// Authorization header in DevTools.

export const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export const BASE_URL = "https://x.com";

// Known-good hashes (mirrored from twscrape v0.17). Update these manually OR
// rely on `discoverOpHashes` to scrape current values from the live page.
export const DEFAULT_HASHES = {
  UserByRestId: "WJ7rCtezBVT6nk6VM5R8Bw",
  UserByScreenName: "1VOOyvKkiI3FMmkeDNxM9A",
  Following: "C1qZ6bs-L3oc_TKSZyxkXQ",
  Followers: "Elc_-qTARceHpztqhI9PQA",
};

const GQL_PATH_RE = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)/;

// Pure helper: given a list of URL strings, return {OperationName: hash} for
// any GraphQL paths found.
export function extractOpHashes(urls) {
  const out = {};
  for (const url of urls) {
    if (typeof url !== "string") continue;
    const m = url.match(GQL_PATH_RE);
    if (!m) continue;
    const [, hash, op] = m;
    if (!out[op]) out[op] = hash;
  }
  return out;
}

// Live discovery: pull URLs from the page's Resource Timing API.
export function discoverOpHashesFromPerformance(perf = globalThis.performance) {
  if (!perf || typeof perf.getEntriesByType !== "function") return {};
  const entries = perf.getEntriesByType("resource");
  return extractOpHashes(entries.map((e) => e.name));
}

// Returns a hashes object: starts with defaults, overrides with anything seen
// on the page. Caller can re-call to pick up newly observed ops.
export function currentHashes(perf) {
  const observed = discoverOpHashesFromPerformance(perf);
  return { ...DEFAULT_HASHES, ...observed };
}

// Diagnostic for the UI: tell the user whether we've seen any live x.com
// GraphQL traffic. If not, our op hashes might be stale and the user should
// scroll x.com a bit before starting a crawl.
//
// Returns one of:
//   - { status: "fresh", count: N } — we observed N live ops, all good
//   - { status: "stale", count: 0 } — only baked-in defaults available
export function freshnessReport(perf = globalThis.performance) {
  const observed = discoverOpHashesFromPerformance(perf);
  const count = Object.keys(observed).length;
  if (count === 0) return { status: "stale", count: 0 };
  return { status: "fresh", count };
}
