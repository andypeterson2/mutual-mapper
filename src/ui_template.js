// HTML + CSS for the overlay panel injected on x.com.
//
// Pulled out of ui.js so the wiring file stays focused on logic. These are
// pure constants with no behavior — easy to scan, easy to swap. The IDs in
// HTML are the contract that ui.js's event handlers + render() depend on.

export const STYLE = `
  #mm-overlay {
    position: fixed; top: 60px; right: 16px; z-index: 99999;
    width: 460px; max-height: 92vh; overflow-y: auto;
    background: #16181c; color: #e7e7ea; border: 1px solid #2f3336;
    border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
  }
  #mm-overlay .mm-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid #2f3336;
  }
  #mm-overlay .mm-header h2 { margin: 0; font-size: 15px; color: #1d9bf0; }
  #mm-overlay .mm-close {
    background: none; border: none; color: #888; font-size: 18px; cursor: pointer;
  }
  #mm-overlay section { padding: 12px 16px; border-bottom: 1px solid #22262a; }
  #mm-overlay h3 { margin: 0 0 8px; font-size: 13px; color: #1d9bf0; font-weight: 600; }
  #mm-overlay .hint { color: #71767b; font-size: 11px; margin: 0 0 8px; line-height: 1.4; }
  #mm-overlay button {
    background: #1d9bf0; color: white; border: none; border-radius: 4px;
    padding: 6px 12px; font: inherit; cursor: pointer; margin: 2px;
  }
  #mm-overlay button:hover { background: #1a8cd8; }
  #mm-overlay button:disabled { opacity: 0.4; cursor: not-allowed; }
  #mm-overlay button.secondary { background: transparent; border: 1px solid #2f3336; color: #e7e7ea; }
  #mm-overlay input[type="number"], #mm-overlay input[type="text"] {
    background: #0c0d0e; color: #e7e7ea; border: 1px solid #2f3336;
    border-radius: 4px; padding: 4px 6px; font: inherit; width: 90px;
  }
  #mm-overlay .grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px;
    align-items: center;
  }
  #mm-overlay .grid label { color: #71767b; font-size: 11px; }
  #mm-overlay .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; background: #2f3336; color: #71767b;
  }
  #mm-overlay .badge.ok { background: #00ba7c; color: #062c1c; }
  #mm-overlay .badge.warn { background: #ffd400; color: #2c2400; }
  #mm-overlay .badge.error { background: #f4212e; color: #2c0608; }
  #mm-overlay progress {
    width: 100%; height: 12px; border-radius: 4px; border: 1px solid #2f3336;
  }
  #mm-overlay .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #mm-overlay .log {
    background: #0c0d0e; border: 1px solid #2f3336; border-radius: 4px;
    padding: 6px 8px; max-height: 140px; overflow-y: auto;
    font-family: ui-monospace, monospace; font-size: 11px;
    color: #b8c4d4; white-space: pre-wrap; margin-top: 6px;
  }
  #mm-overlay .err { color: #f4212e; font-size: 12px; margin-top: 4px; }
  #mm-overlay #mm-graph { width: 100%; height: 380px; background: #0c0d0e;
    border: 1px solid #2f3336; border-radius: 4px; position: relative;
    overflow: hidden; margin-top: 6px;
  }
  #mm-overlay details summary { cursor: pointer; color: #71767b; font-size: 12px; }
  #mm-launcher {
    position: fixed; bottom: 16px; right: 16px; z-index: 99998;
    background: #1d9bf0; color: white; border: none; border-radius: 999px;
    padding: 10px 16px; font: 600 13px system-ui; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
  }
`;

export const HTML = `
  <div class="mm-header">
    <h2>mutuals-mapper</h2>
    <button class="mm-close" id="mm-close" title="Close">×</button>
  </div>

  <section>
    <h3>1. Logged-in account</h3>
    <p class="hint">Cookies are read automatically from your current x.com
    session. Switch accounts in x.com to crawl as a different user.</p>
    <div class="row">
      <span id="mm-acct" class="badge">checking…</span>
      <span id="mm-hashes" class="badge">checking…</span>
    </div>
  </section>

  <section>
    <h3>2. Level-1 ingest</h3>
    <p class="hint">Pick one. Archive is instant; API path uses your current
    session and can take 10-20 min for ~1000 follows.</p>
    <details open>
      <summary><strong>A. Upload Twitter archive ZIP</strong></summary>
      <div style="margin-top:6px">
        <input type="file" id="mm-archive" accept=".zip">
      </div>
    </details>
    <details>
      <summary><strong>B. Fetch from API (current account)</strong></summary>
      <div style="margin-top:6px">
        <button id="mm-fetch-from-api" class="secondary">Fetch followers + following</button>
      </div>
    </details>
    <div class="row" style="margin-top:6px">
      <span id="mm-seed" class="badge">no mutuals seeded</span>
    </div>
  </section>

  <section>
    <h3>3. Settings</h3>
    <details>
      <summary>Tunables</summary>
      <div class="grid" style="margin-top:8px">
        <label>Pacing min (s)</label><input type="number" id="cfg-min" step="0.5">
        <label>Pacing max (s)</label><input type="number" id="cfg-max" step="0.5">
        <label>Skip if following &gt;</label><input type="number" id="cfg-consider">
        <label>Cap per mutual</label><input type="number" id="cfg-fetch">
        <label>Backoff base (s)</label><input type="number" id="cfg-backoff-base">
        <label>Backoff max (s)</label><input type="number" id="cfg-backoff-max">
        <label>Backoff attempts</label><input type="number" id="cfg-backoff-attempts">
        <label>Retry failed after (h)</label><input type="number" id="cfg-retry">
        <label>Min degree (viz)</label><input type="number" id="cfg-mindeg">
        <label>Louvain seed</label><input type="number" id="cfg-seed">
      </div>
      <button id="mm-save-cfg" style="margin-top:8px">Save</button>
    </details>
  </section>

  <section>
    <h3>4. Run pipeline</h3>
    <div class="row">
      <button id="mm-resolve">Resolve profiles</button>
      <button id="mm-crawl">Crawl following</button>
      <button id="mm-cancel" class="secondary">Cancel</button>
    </div>
    <div class="row" style="margin-top:8px">
      <span id="mm-phase" class="badge">idle</span>
      <span id="mm-phase-msg" class="hint" style="margin:0"></span>
    </div>
    <div class="row" style="margin-top:6px">
      <progress id="mm-bar" value="0" max="1"></progress>
      <span id="mm-prog" class="hint" style="margin:0">—</span>
      <span id="mm-eta" class="hint" style="margin:0"></span>
    </div>
    <div id="mm-err" class="err" hidden></div>
    <details open>
      <summary>Live log <span class="hint">(persists across reloads)</span></summary>
      <div class="row" style="margin: 4px 0;">
        <button id="mm-export-logs" class="secondary">Export logs (.txt)</button>
        <button id="mm-clear-logs" class="secondary">Clear</button>
      </div>
      <div id="mm-log" class="log"></div>
    </details>
  </section>

  <section>
    <h3>5. Graph</h3>
    <button id="mm-render">Render / refresh</button>
    <div id="mm-graph"></div>
  </section>
`;

// Defaults for the per-user tunables. The UI loads these on first run, then
// persists overrides via GM_setValue (when running in Tampermonkey).
export const DEFAULT_CFG = {
  request_min_seconds: 2.0,
  request_max_seconds: 4.0,
  max_following_to_consider: 10000,
  max_following_to_fetch: 2000,
  backoff_base_seconds: 30,
  backoff_max_seconds: 900,
  backoff_max_attempts: 6,
  retry_failed_after_hours: 24,
  min_degree: 0,
  louvain_seed: 42,
  size_exponent: 0.6,
};
