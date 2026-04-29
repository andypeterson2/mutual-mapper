// Tiny ETA helper for long-running progress reports.
// Rolling-average over the last N completion timestamps.

export class EtaTracker {
  constructor(total, { window = 20, now = () => performance.now() / 1000 } = {}) {
    this.total = total;
    this.completed = 0;
    this._max = window;
    this._window = [];
    this._now = now;
    this._last = now();
  }

  tick() {
    const t = this._now();
    this._window.push(t - this._last);
    if (this._window.length > this._max) this._window.shift();
    this._last = t;
    this.completed += 1;
  }

  remainingSeconds() {
    if (this._window.length === 0) return null;
    const avg = this._window.reduce((a, b) => a + b, 0) / this._window.length;
    return avg * Math.max(this.total - this.completed, 0);
  }

  formatRemaining() {
    const secs = this.remainingSeconds();
    if (secs === null) return "--";
    const total = Math.floor(secs);
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
}
