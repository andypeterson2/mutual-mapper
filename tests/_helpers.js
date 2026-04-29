// Shared test helpers.
import { JitteredPacer } from "../src/pacing.js";

export function recorder() {
  const calls = [];
  const sleep = async (s) => { calls.push(s); };
  return { calls, sleep };
}

export function pacer(sleep) {
  return new JitteredPacer(0, 0, { sleep, rng: () => 0 });
}

// FakeClient: scriptable in-memory TwitterClient for tests.
export class FakeClient {
  constructor({ users = {}, followings = {}, followers = {}, errors = {}, usersByHandle = {} } = {}) {
    this.users = users;
    this.followings = followings;
    this.followers = followers;
    this.errors = errors; // {id: [Error, ...]}
    this.usersByHandle = usersByHandle;
    if (Object.keys(usersByHandle).length === 0) {
      for (const u of Object.values(users)) {
        if (u.handle) this.usersByHandle[u.handle.replace(/^@/, "")] = u;
      }
    }
    this.calls = [];
  }
  _maybe(id) {
    if (this.errors[id]?.length) throw this.errors[id].shift();
  }
  async getUserByRestId(uid) {
    this.calls.push(["getUserByRestId", uid]);
    this._maybe(uid);
    return this.users[uid] ?? null;
  }
  async getUserByLogin(handle) {
    const h = handle.replace(/^@/, "");
    this.calls.push(["getUserByLogin", h]);
    this._maybe(`@${h}`);
    return this.usersByHandle[h] ?? null;
  }
  async *iterFollowing(uid, { maxCount } = {}) {
    this.calls.push(["iterFollowing", uid, { maxCount }]);
    this._maybe(uid);
    const list = this.followings[uid] ?? [];
    for (let i = 0; i < list.length && i < maxCount; i++) yield list[i];
  }
  async *iterFollowers(uid, { maxCount } = {}) {
    this.calls.push(["iterFollowers", uid, { maxCount }]);
    this._maybe(uid);
    const list = this.followers[uid] ?? [];
    for (let i = 0; i < list.length && i < maxCount; i++) yield list[i];
  }
}

let _dbCounter = 0;
export async function freshDb() {
  const { openDb } = await import("../src/db.js");
  return openDb(`test-${_dbCounter++}-${Date.now()}-${Math.random()}`);
}

export function makeUser({ id = "1", handle = "u1", followers_count = 10,
                          following_count = 20, protected: prot = false,
                          fetched_at = null } = {}) {
  return {
    id, handle, name: handle.toUpperCase(), bio: "bio",
    followers_count, following_count, fetched_at, protected: prot,
  };
}
