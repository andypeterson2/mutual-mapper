// X/Twitter GraphQL client — fetch wrapper.
//
// Runs INSIDE x.com origin (userscript scope), so cookies + same-origin
// requests just work. We lift the operation hashes via op_hashes.js (live
// scrape + baked-in defaults).
//
// Returns "User" objects in our domain shape (not x.com's internal shape):
//   { id, handle, name, bio, followers_count, following_count, protected }
//
// Errors are remapped into typed shapes: AuthError, RateLimitError,
// TransientClientError, ClientError. Mirrors the Python version.

import { currentHashes, BEARER } from "./op_hashes.js";

// Page size for Following/Followers pagination. x.com's cap is ~20-50; 20
// matches what the web client itself uses, so we look identical to a normal
// browsing pattern.
export const FOLLOW_LIST_PAGE_SIZE = 20;
// Cap response text shown in error messages — full responses can be huge HTML.
const ERROR_BODY_PREVIEW_CHARS = 200;

export class AuthError extends Error { constructor(msg) { super(msg); this.name = "AuthError"; } }
export class RateLimitError extends Error {
  constructor(msg, retryAfterSeconds = null) {
    super(msg); this.name = "RateLimitError"; this.retryAfterSeconds = retryAfterSeconds;
  }
}
export class ClientError extends Error { constructor(msg) { super(msg); this.name = "ClientError"; } }
export class TransientClientError extends ClientError {
  constructor(msg) { super(msg); this.name = "TransientClientError"; }
}

const FEATURES_USER = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const FEATURES_TIMELINE = {
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

// --- pure helpers ---

export function _userFromPayload(node) {
  if (!node || node.__typename !== "User") return null;
  const legacy = node.legacy ?? {};
  return {
    id: String(node.rest_id ?? ""),
    handle: legacy.screen_name ?? null,
    name: legacy.name ?? null,
    bio: legacy.description ?? null,
    followers_count: legacy.followers_count ?? null,
    following_count: legacy.friends_count ?? null,
    protected: typeof legacy.protected === "boolean" ? legacy.protected : null,
  };
}

export function _followingCursor(entries) {
  for (const e of entries) {
    const c = e.content ?? {};
    if (c.cursorType === "Bottom") {
      const v = c.value ?? "";
      if (!v || v.startsWith("0|")) return null;
      return v;
    }
  }
  return null;
}

export function _parseFollowingPage(payload) {
  const inst = payload?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  const addEntries = inst.find((x) => x.type === "TimelineAddEntries");
  const entries = addEntries?.entries ?? [];
  const ids = [];
  for (const entry of entries) {
    const result = entry?.content?.itemContent?.user_results?.result;
    if (result?.__typename === "User" && result.rest_id) {
      ids.push(String(result.rest_id));
    }
  }
  return { ids, cursor: _followingCursor(entries) };
}

// --- error remapping ---

export function _remap(status, body) {
  if (status === 401 || status === 403) {
    return new AuthError(`HTTP ${status}: cookies expired? Re-log into x.com.`);
  }
  if (status === 429) {
    return new RateLimitError("rate limited");
  }
  if (status >= 500 && status < 600) {
    return new TransientClientError(`HTTP ${status}`);
  }
  if (status === 404) {
    return new ClientError(
      `HTTP 404: probably a stale GraphQL operation hash. ` +
      `Refresh the x.com page (loads current hashes) and try again.`
    );
  }
  if (status >= 400) {
    return new ClientError(`HTTP ${status}: ${typeof body === "string" ? body.slice(0, ERROR_BODY_PREVIEW_CHARS) : ""}`);
  }
  return null;
}

// --- request builder ---

function _ct0FromCookies(cookieString = globalThis.document?.cookie ?? "") {
  const m = /(?:^|;\s*)ct0=([^;]+)/.exec(cookieString);
  return m ? decodeURIComponent(m[1]) : "";
}

function _buildUrl(hashes, opName, variables, features) {
  const hash = hashes[opName];
  if (!hash) throw new ClientError(`unknown op: ${opName}`);
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features ?? {}),
  });
  return `https://x.com/i/api/graphql/${hash}/${opName}?${params.toString()}`;
}

export class GraphQLClient {
  constructor({
    fetcher = globalThis.fetch?.bind(globalThis),
    cookieSource = () => globalThis.document?.cookie ?? "",
    perf = globalThis.performance,
  } = {}) {
    if (!fetcher) throw new Error("fetch is not available in this environment");
    this._fetch = fetcher;
    this._cookieSource = cookieSource;
    this._perf = perf;
  }

  _headers() {
    const ct0 = _ct0FromCookies(this._cookieSource());
    return {
      "authorization": `Bearer ${BEARER}`,
      "x-csrf-token": ct0,
      "content-type": "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    };
  }

  async _gqlGet(opName, variables, features, { signal } = {}) {
    const hashes = currentHashes(this._perf);
    const url = _buildUrl(hashes, opName, variables, features);
    let resp;
    try {
      resp = await this._fetch(url, {
        method: "GET",
        credentials: "include",
        headers: this._headers(),
        signal,
      });
    } catch (e) {
      // Re-throw AbortError as-is so cancel propagates cleanly.
      if (e?.name === "AbortError") throw e;
      throw new TransientClientError(`network: ${e.message ?? e}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const mapped = _remap(resp.status, body);
      if (mapped) throw mapped;
    }
    let json;
    try {
      json = await resp.json();
    } catch (e) {
      throw new TransientClientError(`malformed JSON: ${e.message ?? e}`);
    }
    return json;
  }

  async getUserByRestId(userId, { signal } = {}) {
    const data = await this._gqlGet(
      "UserByRestId",
      { userId: String(userId), withSafetyModeUserFields: true },
      FEATURES_USER,
      { signal },
    );
    const node = data?.data?.user?.result;
    return _userFromPayload(node);
  }

  async getUserByLogin(handle, { signal } = {}) {
    const screen = handle.replace(/^@/, "");
    const data = await this._gqlGet(
      "UserByScreenName",
      { screen_name: screen, withSafetyModeUserFields: true },
      FEATURES_USER,
      { signal },
    );
    const node = data?.data?.user?.result;
    return _userFromPayload(node);
  }

  // Async generator: yields target user_ids one at a time. Pages internally
  // until the cursor sentinel or maxCount is reached. Pass `{ signal }` to
  // abort mid-iteration — checked between yields so a cancel doesn't take
  // effect until the next page boundary.
  async *iterFollowing(userId, { maxCount, signal } = {}) {
    yield* this._iterFollowList("Following", userId, { maxCount, signal });
  }

  async *iterFollowers(userId, { maxCount, signal } = {}) {
    yield* this._iterFollowList("Followers", userId, { maxCount, signal });
  }

  async *_iterFollowList(opName, userId, { maxCount, signal }) {
    let cursor = null;
    let emitted = 0;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      const variables = {
        userId: String(userId),
        count: FOLLOW_LIST_PAGE_SIZE,
        includePromotedContent: false,
      };
      if (cursor) variables.cursor = cursor;
      const data = await this._gqlGet(opName, variables, FEATURES_TIMELINE, { signal });
      const { ids, cursor: nextCursor } = _parseFollowingPage(data);
      for (const id of ids) {
        if (emitted >= maxCount) return;
        yield id;
        emitted += 1;
      }
      if (!nextCursor || emitted >= maxCount) return;
      cursor = nextCursor;
    }
  }
}
