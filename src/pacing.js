// Jittered pacing + exponential backoff helpers.
//
// Both `sleep` and `rng` are injectable so tests run synchronously without
// real waiting and with deterministic jitter. Mirrors the Python `pacing.py`.
//
// Every wait function accepts an optional `{ signal }` (AbortSignal). When the
// signal fires, in-flight sleeps reject with an AbortError immediately — the
// user clicks "Cancel" once and we don't have to wait out a 60s backoff.

export function isAbortError(err) {
  return Boolean(err && (err.name === "AbortError" || err.code === "ABORT_ERR"));
}

export function defaultSleep(seconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    let onAbort = null;
    const t = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export class JitteredPacer {
  constructor(
    minSeconds, maxSeconds,
    { sleep = defaultSleep, rng = Math.random, signal = null } = {},
  ) {
    if (minSeconds < 0 || maxSeconds < minSeconds) {
      throw new Error("require 0 <= minSeconds <= maxSeconds");
    }
    this._min = minSeconds;
    this._max = maxSeconds;
    this.sleep = sleep;
    this._rng = rng;
    this.signal = signal;
  }

  async wait() {
    const span = this._max - this._min;
    const jitter = this._min + this._rng() * span;
    // Inject signal as the second arg; injected sleeps are free to ignore it.
    await this.sleep(jitter, { signal: this.signal });
  }
}

export function computeBackoffDelay(attempt, { base, max }) {
  const delay = base * Math.pow(2, attempt);
  return Math.min(delay, max);
}

export async function withBackoff(
  func,
  {
    isRetryable, baseSeconds, maxSeconds, maxAttempts,
    sleep = defaultSleep, signal = null,
  } = {},
) {
  if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
  let lastExc = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("aborted", "AbortError");
    }
    try {
      return await func();
    } catch (exc) {
      if (isAbortError(exc)) throw exc;          // user cancelled — propagate
      if (!isRetryable(exc)) throw exc;
      lastExc = exc;
      if (attempt + 1 >= maxAttempts) break;
      await sleep(
        computeBackoffDelay(attempt, { base: baseSeconds, max: maxSeconds }),
        { signal },
      );
    }
  }
  throw lastExc;
}
