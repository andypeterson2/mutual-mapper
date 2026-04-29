// Twitter archive ZIP parser.
//
// Browser side: uses globalThis.JSZip (loaded via @require in the userscript
// header). For node tests we let the caller pass a JSZip instance.
//
// Real archives lay follower/following data out as JS files like
// data/follower.js + data/following.js + data/account.js, each starting with
// `window.YTD.<x>.partN = [ ... ]`. We strip the prefix and JSON.parse the
// remainder.

export function extractJsonArray(text) {
  const bracket = text.indexOf("[");
  if (bracket === -1) throw new Error("no JSON array found in archive file");
  try {
    return JSON.parse(text.slice(bracket));
  } catch (e) {
    throw new Error(`could not parse archive payload: ${e.message ?? e}`);
  }
}

function _matchesPrefix(name, prefix) {
  return name.startsWith(`data/${prefix}.js`) ||
         name.startsWith(`data/${prefix}-part`);
}

async function _readIdList(zip, { prefix, idKey }) {
  const ids = new Set();
  const entries = Object.keys(zip.files).filter(
    (n) => n.endsWith(".js") && _matchesPrefix(n, prefix),
  );
  for (const name of entries) {
    const text = await zip.files[name].async("string");
    let arr;
    try {
      arr = extractJsonArray(text);
    } catch (e) {
      throw new Error(`could not parse ${name}: ${e.message ?? e}`);
    }
    for (const entry of arr) {
      const inner = entry[idKey] ?? entry;
      if (inner.accountId != null) ids.add(String(inner.accountId));
    }
  }
  return ids;
}

async function _readSelfId(zip) {
  const name = "data/account.js";
  if (!zip.files[name]) return null;
  const text = await zip.files[name].async("string");
  let arr;
  try { arr = extractJsonArray(text); } catch { return null; }
  for (const entry of arr) {
    const inner = entry.account ?? entry;
    if (inner.accountId != null) return String(inner.accountId);
  }
  return null;
}

// `JSZip` is the constructor (e.g. globalThis.JSZip in the userscript, or
// passed in for node tests via `await JSZip.loadAsync(buffer)`).
export async function parseArchive(blobOrBuffer, { JSZip = globalThis.JSZip } = {}) {
  if (!JSZip) throw new Error("JSZip not available (load via @require in userscript)");
  let zip;
  try {
    zip = await JSZip.loadAsync(blobOrBuffer);
  } catch (e) {
    throw new Error(`not a zip archive: ${e.message ?? e}`);
  }
  const followers = await _readIdList(zip, { prefix: "follower", idKey: "follower" });
  const following = await _readIdList(zip, { prefix: "following", idKey: "following" });
  const selfId = await _readSelfId(zip);
  return { followers, following, selfId };
}

export function computeMutuals({ followers, following, selfId }) {
  const out = new Set();
  for (const id of followers) if (following.has(id)) out.add(id);
  if (selfId) out.delete(selfId);
  return out;
}
