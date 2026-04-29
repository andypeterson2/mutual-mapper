import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  GraphQLClient, AuthError, RateLimitError, ClientError, TransientClientError,
  _userFromPayload, _followingCursor, _parseFollowingPage, _remap,
} from "../src/client.js";

const COOKIE = "auth_token=tok; ct0=csrf";

function fakeFetcher({ status = 200, body = {}, capture = null } = {}) {
  return async (url, init) => {
    if (capture) capture.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => typeof body === "string" ? body : JSON.stringify(body),
      json: async () => typeof body === "string" ? JSON.parse(body) : body,
    };
  };
}

function clientWith(fetcher) {
  return new GraphQLClient({
    fetcher,
    cookieSource: () => COOKIE,
    perf: { getEntriesByType: () => [] },
  });
}

const USER_PAYLOAD = (id = "12", screen = "alice", protected_ = false) => ({
  data: {
    user: {
      result: {
        __typename: "User",
        rest_id: id,
        legacy: {
          screen_name: screen, name: screen.toUpperCase(), description: "bio",
          followers_count: 100, friends_count: 200, protected: protected_,
        },
      },
    },
  },
});

const FOLLOWING_PAGE = (ids, cursor) => ({
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [{
              type: "TimelineAddEntries",
              entries: [
                ...ids.map((id) => ({
                  entryId: `user-${id}`,
                  content: {
                    itemContent: {
                      user_results: {
                        result: { __typename: "User", rest_id: id },
                      },
                    },
                  },
                })),
                {
                  entryId: "cursor-bottom",
                  content: { cursorType: "Bottom", value: cursor },
                },
              ],
            }],
          },
        },
      },
    },
  },
});

describe("_userFromPayload", () => {
  test("maps fields", () => {
    const u = _userFromPayload(USER_PAYLOAD("42", "bob").data.user.result);
    assert.equal(u.id, "42");
    assert.equal(u.handle, "bob");
    assert.equal(u.followers_count, 100);
    assert.equal(u.following_count, 200);
    assert.equal(u.protected, false);
  });

  test("returns null for non-User typename", () => {
    assert.equal(_userFromPayload({ __typename: "UserUnavailable" }), null);
  });

  test("returns null for null", () => {
    assert.equal(_userFromPayload(null), null);
  });

  test("protected true preserved", () => {
    const u = _userFromPayload(USER_PAYLOAD("1", "x", true).data.user.result);
    assert.equal(u.protected, true);
  });
});

describe("_followingCursor", () => {
  test("extracts value", () => {
    const e = [{ entryId: "user-1" },
               { entryId: "cursor-bottom", content: { cursorType: "Bottom", value: "abc" } }];
    assert.equal(_followingCursor(e), "abc");
  });
  test("returns null on '0|' sentinel", () => {
    const e = [{ entryId: "cursor-bottom", content: { cursorType: "Bottom", value: "0|" } }];
    assert.equal(_followingCursor(e), null);
  });
  test("returns null on missing", () => {
    assert.equal(_followingCursor([{}]), null);
  });
});

describe("_remap", () => {
  test("401 -> AuthError", () => assert.ok(_remap(401, "u") instanceof AuthError));
  test("403 -> AuthError", () => assert.ok(_remap(403, "u") instanceof AuthError));
  test("429 -> RateLimitError", () => assert.ok(_remap(429, "u") instanceof RateLimitError));
  test("500 -> TransientClientError", () => assert.ok(_remap(500, "u") instanceof TransientClientError));
  test("503 -> TransientClientError", () => assert.ok(_remap(503, "u") instanceof TransientClientError));
  test("404 -> ClientError (NOT transient)", () => {
    const e = _remap(404, "u");
    assert.ok(e instanceof ClientError);
    assert.ok(!(e instanceof TransientClientError));
    assert.match(e.message, /stale.*hash|404/i);
  });
  test("418 -> ClientError", () => {
    const e = _remap(418, "no");
    assert.ok(e instanceof ClientError);
  });
  test("200 -> null (no error)", () => assert.equal(_remap(200), null));
});

describe("GraphQLClient.getUserByRestId", () => {
  test("returns user on 200", async () => {
    const c = clientWith(fakeFetcher({ body: USER_PAYLOAD("12", "alice") }));
    const u = await c.getUserByRestId("12");
    assert.equal(u.handle, "alice");
  });

  test("returns null on UserUnavailable", async () => {
    const c = clientWith(fakeFetcher({ body: {
      data: { user: { result: { __typename: "UserUnavailable" } } },
    }}));
    assert.equal(await c.getUserByRestId("999"), null);
  });

  test("raises AuthError on 401", async () => {
    const c = clientWith(fakeFetcher({ status: 401 }));
    await assert.rejects(c.getUserByRestId("1"), AuthError);
  });

  test("raises RateLimitError on 429", async () => {
    const c = clientWith(fakeFetcher({ status: 429 }));
    await assert.rejects(c.getUserByRestId("1"), RateLimitError);
  });

  test("raises TransientClientError on 503", async () => {
    const c = clientWith(fakeFetcher({ status: 503 }));
    await assert.rejects(c.getUserByRestId("1"), TransientClientError);
  });

  test("raises ClientError on 404 with refresh hint", async () => {
    const c = clientWith(fakeFetcher({ status: 404 }));
    await assert.rejects(c.getUserByRestId("1"),
      (e) => e instanceof ClientError && !(e instanceof TransientClientError) && /hash/i.test(e.message));
  });

  test("includes auth headers + cookies via include", async () => {
    const calls = [];
    const c = clientWith(fakeFetcher({ body: USER_PAYLOAD("1"), capture: calls }));
    await c.getUserByRestId("1");
    const { url, init } = calls[0];
    assert.match(url, /\/i\/api\/graphql\/.*\/UserByRestId/);
    assert.equal(init.credentials, "include");
    assert.equal(init.headers["x-csrf-token"], "csrf");
    assert.match(init.headers.authorization, /^Bearer /);
  });
});

describe("GraphQLClient.getUserByLogin", () => {
  test("strips @ from handle", async () => {
    const calls = [];
    const c = clientWith(fakeFetcher({ body: USER_PAYLOAD("99", "alice"), capture: calls }));
    await c.getUserByLogin("@alice");
    const { url } = calls[0];
    const variables = JSON.parse(new URL(url).searchParams.get("variables"));
    assert.equal(variables.screen_name, "alice");
  });
});

describe("GraphQLClient.iterFollowing", () => {
  test("paginates two pages then stops on '0|' cursor", async () => {
    const responses = [
      FOLLOWING_PAGE(["10", "20", "30"], "page2"),
      FOLLOWING_PAGE(["40"], "0|end"),
    ];
    let i = 0;
    const c = clientWith(async (url, init) => {
      const body = responses[i++];
      return { ok: true, status: 200, text: async () => "", json: async () => body };
    });
    const ids = [];
    for await (const id of c.iterFollowing("1", { maxCount: 100 })) ids.push(id);
    assert.deepEqual(ids, ["10", "20", "30", "40"]);
  });

  test("stops at maxCount mid-page", async () => {
    const c = clientWith(fakeFetcher({ body: FOLLOWING_PAGE(["10", "20", "30"], "page2") }));
    const ids = [];
    for await (const id of c.iterFollowing("1", { maxCount: 2 })) ids.push(id);
    assert.deepEqual(ids, ["10", "20"]);
  });

  test("propagates RateLimitError", async () => {
    const c = clientWith(fakeFetcher({ status: 429 }));
    await assert.rejects(async () => {
      for await (const _ of c.iterFollowing("1", { maxCount: 5 })) {}
    }, RateLimitError);
  });

  test("handles empty first page", async () => {
    const c = clientWith(fakeFetcher({ body: FOLLOWING_PAGE([], "0|") }));
    const ids = [];
    for await (const id of c.iterFollowing("1", { maxCount: 10 })) ids.push(id);
    assert.deepEqual(ids, []);
  });
});

describe("GraphQLClient.iterFollowers", () => {
  test("yields ids", async () => {
    const c = clientWith(fakeFetcher({ body: FOLLOWING_PAGE(["1", "2", "3"], "0|") }));
    const ids = [];
    for await (const id of c.iterFollowers("99", { maxCount: 10 })) ids.push(id);
    assert.deepEqual(ids, ["1", "2", "3"]);
  });
});
