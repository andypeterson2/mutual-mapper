# mutuals-mapper-userscript

> Sibling project: **[mutuals-mapper](../mutuals-mapper/)** — the Python
> version with a CLI and a local FastAPI web UI. Same algorithms, different
> runtime; pick whichever fits the moment.

Tampermonkey userscript that maps your X/Twitter mutuals network entirely in
the browser — no Python backend, no env file, no cookie pasting.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
   (Chrome, Firefox, Safari, Edge).
2. Open `dist/mutuals-mapper.user.js` in your browser. Tampermonkey detects
   the userscript header and offers to install. Click **Install**.
3. Visit `https://x.com/`. A floating "🕸 mutuals-mapper" button appears in
   the bottom-right corner. (Also available via Tampermonkey menu → "Open
   mutuals-mapper".)
4. Click it. The overlay UI opens.

## Use

The overlay has 5 numbered sections that mirror the Python version's flow:

1. **Logged-in account** — auto-detects your x.com session cookies. Switch
   accounts in x.com to crawl as a different user.
2. **Level-1 ingest** — pick one:
   - **A. Upload Twitter archive ZIP** (instant): get it from x.com Settings
     → Your Account → Download an archive.
   - **B. Fetch from API** (10–20 min): uses your current x.com session to
     fetch your followers + following lists.
3. **Settings** — every tunable (pacing, caps, viz params) editable inline,
   persisted via `GM_setValue`.
4. **Run pipeline** — Resolve profiles → Crawl following lists. Live
   progress, ETA, log tail.
5. **Graph** — D3 force-directed graph rendered inline in the overlay.

State (mutuals seed, resolved users, edges, fetch_log) is persisted in
**IndexedDB scoped to x.com**. Closing the tab pauses the pipeline; next
visit picks up where you left off (skips done mutuals, retries failed ones
after the configured window).

## Develop

```bash
nvm use 22                          # node 22+ required
npm install                         # fake-indexeddb + jszip dev deps
npm test                            # 125 tests, ~0.5s
npm run build                       # → dist/mutuals-mapper.user.js
```

### Project layout

```
src/
├── userscript_header.js  # ==UserScript== block + @require lines for D3, JSZip, graphology
├── op_hashes.js          # baked-in hashes + live-scrape fallback from page Resource Timing
├── pacing.js             # JitteredPacer + withBackoff + computeBackoffDelay
├── eta.js                # rolling-average ETA tracker
├── db.js                 # IndexedDB wrapper (users / edges / mutuals_seed / fetch_log)
├── client.js             # x.com GraphQL fetch wrapper; Auth/RateLimit/Transient/ClientError
├── resolver.js           # per-call user resolver, paced
├── crawler.js            # per-mutual crawl + skip rules + backoff retries
├── archive_parser.js     # ZIP -> {followers, following, selfId} (uses JSZip)
├── viz.js                # graph build + Louvain (real or component fallback) + D3 render
├── ui.js                 # overlay panel HTML/CSS + event wiring
└── _entry.js             # init() bootstrap
build.js                  # concat src/* into dist/mutuals-mapper.user.js (no bundler)
tests/                    # 8 test files, node --test, ~125 assertions
```

### Op hashes

Twitter rotates the GraphQL operation hashes every few months. We handle this
two ways:

1. **Baked in defaults** in `src/op_hashes.js` (mirrored from `twscrape`).
   Update them by editing the file.
2. **Live discovery from the page** — when the userscript runs, x.com's own
   GraphQL calls are recorded in `performance.getEntriesByType('resource')`.
   We extract `<HASH>/<OperationName>` from those URLs and override the
   defaults. As long as you've browsed x.com a bit before opening the
   overlay, hashes are current.

If you ever see 404s from the API: open a profile, scroll their following
list, then re-open the overlay. The fresh hashes will be picked up.

### Tests

`node --test 'tests/**/*.test.js'` runs everything. Coverage is high (every
`src/*.js` has a matching `tests/*.test.js`) but we don't enforce a numeric
threshold (no jest, no nyc, no build pipeline).

## Trade-offs vs the Python version

| Aspect | Python `mutuals-mapper` | Userscript |
|---|---|---|
| Install | venv + pip + 12 deps | Tampermonkey + one .user.js click |
| Cookies | Paste in `.env` or web form | Native (script runs as x.com origin) |
| Op hashes | Hand-managed via `_constants.py` + HAR script | Baked in + live-scraped from page |
| Storage | SQLite on disk | IndexedDB scoped to x.com |
| Crawl alive while tab closed? | Yes | No (page must stay open) |
| Two-account routing (private mutuals) | Yes (`--include-private`) | v1: single account only |
| Tests | pytest, 211 tests, 86% coverage | node --test, 125 tests |

Both projects coexist; pick whichever fits the moment.
