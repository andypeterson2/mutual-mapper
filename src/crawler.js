// Per-mutual crawl: fetch each mutual's following list, write inter-mutual
// edges. Skip rules, in-progress marker, retry on transient errors.
//
// v1 scope: single account (whoever's logged in to x.com). No two-account
// routing — private mutuals get marked skipped if their following is gated.
//
// Cancellation: pass `{ signal }`. The crawl loop checks it between mutuals
// and propagates it into the pacer + iterFollowing call so a long backoff or
// in-flight HTTP request aborts immediately. Partial stats are returned with
// `cancelled: true` and the in-flight mutual is left at status='in_progress'
// so the next run picks it up via the resume contract.

import { RateLimitError, TransientClientError } from "./client.js";
import {
  getUser, listMutuals, insertEdge, upsertFetchLog, pendingMutuals,
} from "./db.js";
import { isAbortError, withBackoff } from "./pacing.js";

function _now() { return new Date().toISOString(); }

// Pure: returns [shouldSkip, reason].
export function shouldSkip(user, { maxFollowing }) {
  if (user == null) return [true, "user_not_resolved"];
  if (user.following_count == null) return [true, "following_count_unknown"];
  if (user.following_count > maxFollowing) {
    return [true, `following_count=${user.following_count} > ${maxFollowing}`];
  }
  return [false, null];
}

export async function planCrawl(db, { maxFollowing, pageSize = 20 } = {}) {
  const ids = await listMutuals(db);
  const willFetch = [];
  const willSkip = [];
  let estimated = 0;
  for (const id of ids) {
    const user = await getUser(db, id);
    const [skip, reason] = shouldSkip(user, { maxFollowing });
    if (skip) {
      willSkip.push([id, reason]);
    } else {
      willFetch.push(id);
      estimated += Math.ceil(user.following_count / Math.max(pageSize, 1));
    }
  }
  return { willFetch, willSkip, estimated };
}

export async function crawl(db, client, {
  maxFollowingToConsider, maxFollowingToFetch,
  pacer,
  backoffBaseSeconds, backoffMaxSeconds, backoffMaxAttempts,
  retryFailedAfterHours,
  onProgress,
  signal = null,
} = {}) {
  const mutualsSet = new Set(await listMutuals(db));
  const todo = await pendingMutuals(db, retryFailedAfterHours);
  const stats = {
    mutuals_processed: 0, mutuals_skipped: 0, mutuals_failed: 0,
    edges_written: 0, cancelled: false,
  };

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) { stats.cancelled = true; return stats; }
    const mid = todo[i];
    const user = await getUser(db, mid);
    const [skip, reason] = shouldSkip(user, { maxFollowing: maxFollowingToConsider });
    if (skip) {
      await upsertFetchLog(db, {
        user_id: mid, status: "skipped", error: reason, attempted_at: _now(),
      });
      stats.mutuals_skipped += 1;
      if (onProgress) onProgress(mid, "skipped");
      continue;
    }

    if (i > 0) {
      try { await pacer.wait(); }
      catch (e) {
        if (isAbortError(e)) { stats.cancelled = true; return stats; }
        throw e;
      }
    }

    await upsertFetchLog(db, {
      user_id: mid, status: "in_progress", error: null, attempted_at: _now(),
    });

    try {
      let edgesForMutual = 0;
      const fetchOne = async () => {
        edgesForMutual = 0;
        for await (const targetId of client.iterFollowing(
          mid, { maxCount: maxFollowingToFetch, signal },
        )) {
          if (mutualsSet.has(targetId) && targetId !== mid) {
            await insertEdge(db, { source_id: mid, target_id: targetId, fetched_at: _now() });
            edgesForMutual += 1;
          }
        }
        return edgesForMutual;
      };
      await withBackoff(fetchOne, {
        isRetryable: (e) => e instanceof RateLimitError || e instanceof TransientClientError,
        baseSeconds: backoffBaseSeconds, maxSeconds: backoffMaxSeconds,
        maxAttempts: backoffMaxAttempts, sleep: pacer.sleep, signal,
      });
      stats.edges_written += edgesForMutual;
      await upsertFetchLog(db, {
        user_id: mid, status: "done", error: null, attempted_at: _now(),
      });
      stats.mutuals_processed += 1;
      if (onProgress) onProgress(mid, "done");
    } catch (exc) {
      if (isAbortError(exc)) { stats.cancelled = true; return stats; }
      await upsertFetchLog(db, {
        user_id: mid, status: "failed", error: exc.message ?? String(exc), attempted_at: _now(),
      });
      stats.mutuals_failed += 1;
      if (onProgress) onProgress(mid, "failed");
    }
  }
  return stats;
}
