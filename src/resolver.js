// Per-call user resolver. Mirrors the Python `resolver.py` after the
// twscrape refactor: no batching, paced between calls.
//
// Pass `{ signal }` to cancel mid-loop — checked between iterations and
// honored by the pacer's sleep. A cancelled run returns the partial stats
// it accumulated so the UI can show progress; resume just picks up where it
// left off (the unprocessed users have no fetch_log row).

import { ClientError, TransientClientError } from "./client.js";
import { upsertUser, getUser, upsertFetchLog } from "./db.js";
import { isAbortError } from "./pacing.js";

function _now() { return new Date().toISOString(); }

function _isFresh(user, retryAfterHours, now = new Date()) {
  if (!user || !user.fetched_at) return false;
  const fetched = new Date(user.fetched_at).getTime();
  if (Number.isNaN(fetched)) return false;
  const ageHours = (now.getTime() - fetched) / (1000 * 60 * 60);
  return ageHours < retryAfterHours;
}

export async function resolveUsers(db, client, userIds, {
  pacer, onProgress, retryAfterHours = 24, signal = null,
} = {}) {
  // Filter out users already fresh (fetched recently).
  const all = [...userIds].sort();
  const todo = [];
  for (const uid of all) {
    const u = await getUser(db, uid);
    if (!_isFresh(u, retryAfterHours)) todo.push(uid);
  }
  const stats = {
    requested: userIds.size ?? userIds.length ?? 0,
    resolved: 0, failed: 0, not_found: 0, cancelled: false,
  };
  if (todo.length === 0) return stats;

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) { stats.cancelled = true; return stats; }
    if (i > 0) {
      try { await pacer.wait(); }
      catch (e) {
        if (isAbortError(e)) { stats.cancelled = true; return stats; }
        throw e;
      }
    }
    const uid = todo[i];
    let user;
    try {
      user = await client.getUserByRestId(uid, { signal });
    } catch (exc) {
      if (isAbortError(exc)) { stats.cancelled = true; return stats; }
      if (exc instanceof ClientError || exc instanceof TransientClientError) {
        await upsertFetchLog(db, {
          user_id: uid, status: "failed", error: exc.message, attempted_at: _now(),
        }, { phase: "resolve" });
        stats.failed += 1;
        if (onProgress) onProgress(i + 1, todo.length);
        continue;
      }
      throw exc;
    }
    const ts = _now();
    if (user == null) {
      await upsertFetchLog(db, {
        user_id: uid, status: "failed", error: "not_found", attempted_at: ts,
      }, { phase: "resolve" });
      stats.not_found += 1;
    } else {
      await upsertUser(db, { ...user, fetched_at: ts });
      await upsertFetchLog(db, {
        user_id: uid, status: "done", error: null, attempted_at: ts,
      }, { phase: "resolve" });
      stats.resolved += 1;
    }
    if (onProgress) onProgress(i + 1, todo.length);
  }
  return stats;
}
