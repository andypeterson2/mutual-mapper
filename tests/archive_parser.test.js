import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import JSZip from "jszip";

import { extractJsonArray, parseArchive, computeMutuals } from "../src/archive_parser.js";

function jsBlock(prefix, key, ids) {
  const entries = ids.map((i) => ({ [key]: { accountId: i } }));
  return `window.YTD.${prefix}.part0 = ` + JSON.stringify(entries);
}

async function makeArchive({ followers = [], following = [], selfId = "999",
                              includeAccount = true } = {}) {
  const zip = new JSZip();
  zip.file("data/follower.js", jsBlock("follower", "follower", followers));
  zip.file("data/following.js", jsBlock("following", "following", following));
  if (includeAccount) {
    zip.file("data/account.js",
      `window.YTD.account.part0 = ` + JSON.stringify([{ account: { accountId: selfId } }]));
  }
  zip.file("data/tweet.js", "window.YTD.tweet.part0 = []");
  return await zip.generateAsync({ type: "uint8array" });
}

describe("extractJsonArray", () => {
  test("strips window prefix", () => {
    assert.deepEqual(extractJsonArray(`window.YTD.follower.part0 = [{"a":1}]`),
                     [{ a: 1 }]);
  });
  test("tolerant of whitespace + extra chars", () => {
    assert.deepEqual(extractJsonArray(`  window.x = \n[{"a":1}]`), [{ a: 1 }]);
  });
  test("throws on no array", () => {
    assert.throws(() => extractJsonArray("window.x = null"), /no JSON array/);
  });
  test("throws on malformed", () => {
    assert.throws(() => extractJsonArray("window.x = [{,]"), /could not parse/);
  });
});

describe("parseArchive", () => {
  test("extracts followers and following", async () => {
    const buf = await makeArchive({ followers: ["10", "20"], following: ["20", "30"] });
    const lists = await parseArchive(buf, { JSZip });
    assert.deepEqual([...lists.followers].sort(), ["10", "20"]);
    assert.deepEqual([...lists.following].sort(), ["20", "30"]);
  });

  test("extracts selfId from account.js", async () => {
    const buf = await makeArchive({ selfId: "42" });
    const lists = await parseArchive(buf, { JSZip });
    assert.equal(lists.selfId, "42");
  });

  test("selfId null when account.js missing", async () => {
    const buf = await makeArchive({ includeAccount: false });
    const lists = await parseArchive(buf, { JSZip });
    assert.equal(lists.selfId, null);
  });

  test("rejects non-zip", async () => {
    await assert.rejects(parseArchive(new Uint8Array([1, 2, 3]), { JSZip }), /not a zip/);
  });

  test("handles multipart files", async () => {
    const zip = new JSZip();
    zip.file("data/follower.js", jsBlock("follower", "follower", ["1"]));
    zip.file("data/follower-part1.js",
      `window.YTD.follower.part1 = ` + JSON.stringify([{ follower: { accountId: "2" } }]));
    zip.file("data/following.js", jsBlock("following", "following", []));
    const buf = await zip.generateAsync({ type: "uint8array" });
    const lists = await parseArchive(buf, { JSZip });
    assert.deepEqual([...lists.followers].sort(), ["1", "2"]);
  });
});

describe("computeMutuals", () => {
  test("returns intersection minus self", () => {
    const m = computeMutuals({
      followers: new Set(["1", "2", "999"]),
      following: new Set(["2", "999", "3"]),
      selfId: "999",
    });
    assert.deepEqual([...m].sort(), ["2"]);
  });
  test("empty when no overlap", () => {
    const m = computeMutuals({
      followers: new Set(["1"]), following: new Set(["2"]), selfId: null,
    });
    assert.equal(m.size, 0);
  });
  test("end-to-end", async () => {
    const buf = await makeArchive({
      followers: ["A", "B", "C"], following: ["B", "C", "D"], selfId: "999",
    });
    const lists = await parseArchive(buf, { JSZip });
    const mutuals = computeMutuals(lists);
    assert.deepEqual([...mutuals].sort(), ["B", "C"]);
  });
});
