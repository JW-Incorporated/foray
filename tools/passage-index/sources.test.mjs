/* GV-09 (W3-05, docs/roadmap/generation-v2.md): the stream indexer's body
   sources. Local runs walk a tmp normalized tree; R2 runs use a fake S3 client
   (the sync-r2.test.mjs pattern: command classes named like the SDK's, the
   client switching on cmd.constructor.name). No network, no credential, no
   node_modules. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeKey } from "../foraycorpus-export/config.mjs";
import { sha256 } from "../foraycorpus-export/r2-client.mjs";
import { buildShowMap } from "../foraycorpus-export/show-map.mjs";
import { listLocal, listR2Normalized, localSource, r2NormalizedSource, readR2, showIdOfDir } from "./sources.mjs";

class ListObjectsV2Command {
  constructor(input) {
    this.input = input;
  }
}
class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
const commands = { ListObjectsV2Command, GetObjectCommand };

/* objects: [{key, body, meta?, noBody?, fail?}]; meta defaults to the real
   sha256; `strays` are listed whatever the prefix. */
function fakeClient(objects, strays = []) {
  const store = new Map(objects.map((o) => [o.key, { ...o, bytes: Buffer.from(o.body ?? "") }]));
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push([name, cmd.input.Key ?? cmd.input.Prefix]);
      if (name === "ListObjectsV2Command") {
        const keys = [...store.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).concat(strays);
        return {
          IsTruncated: false,
          Contents: keys.map((Key) => ({ Key, Size: store.get(Key)?.bytes.length ?? 7, ETag: `"e-${Key.length}"`, LastModified: new Date("2026-10-01T12:00:00Z") })),
        };
      }
      const o = store.get(cmd.input.Key);
      if (!o) throw new Error(`fake: no such key ${cmd.input.Key}`);
      if (o.fail) {
        const e = new Error("socket hang up");
        e.name = "TimeoutError";
        throw e;
      }
      const meta = o.meta === undefined ? sha256(o.bytes) : o.meta;
      const Metadata = meta === null ? {} : { sha256: meta };
      if (o.noBody) return { Metadata, ETag: '"x"' };
      return { Metadata, ContentLength: o.bytes.length, ETag: `"e-${o.key.length}"`, Body: { transformToByteArray: async () => new Uint8Array(o.bytes) } };
    },
  };
}

const body = (guid, extra = {}) => JSON.stringify({ show_id: "farm", guid, cues: [{ start_sec: 0, end_sec: 4.5, text: `hello ${guid}` }], transcript_source: "asr-local", ...extra });
const key = (dir, file) => `transcripts/normalized/${dir}/${file}`;

/* Being an Engineer, written by the farm under its PodcastIndex id AND under
   its title slug: both directories map to one foray show. */
const { map: showMap } = buildShowMap({
  queue: { shows: [{ title: "Being an Engineer", feed_url: "https://feeds.example.com/bae", podcastindex_feed_id: 470582, apple_collection_id: 1 }] },
  catalog: { shows: [{ show_id: "being-an-engineer", feed_url: "https://feeds.example.com/bae" }] },
});
const PI_DIR = safeKey("470582");
const SLUG_DIR = safeKey("being-an-engineer");

function tmp() {
  return mkdtempSync(join(tmpdir(), "gv09-src-"));
}

/* (a) Local walk order: shows by show_id, files by name, whatever order the
   filesystem lists them in. (The per-show file sort is the shared
   sortedShows; its mutation, dropping the fileName sort, is killed by the R2
   listing test below, where the listing order is the farm-directory order.) */
test("local walk: shows sorted, files sorted, show_id = dir minus the safeKey hash, file stat, only *.json", async () => {
  const root = tmp();
  try {
    const zed = safeKey("zed-show");
    const alpha = safeKey("alpha-show");
    mkdirSync(join(root, zed));
    mkdirSync(join(root, alpha));
    writeFileSync(join(root, zed, "b.json"), body("b"));
    writeFileSync(join(root, zed, "a.json"), body("a"));
    writeFileSync(join(root, zed, "notes.txt"), "not a body");
    writeFileSync(join(root, alpha, "x.json"), "{not json");
    utimesSync(join(root, zed, "a.json"), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

    assert.equal(showIdOfDir(zed), "zed-show");
    const listing = listLocal(root);
    assert.deepEqual([...listing.shows.keys()], ["alpha-show", "zed-show"]);

    const items = [];
    for await (const item of localSource(root, { listing })) items.push(item);
    assert.deepEqual(
      items.map((i) => [i.show_id, i.fileName]),
      [
        ["alpha-show", "x.json"],
        ["zed-show", "a.json"],
        ["zed-show", "b.json"],
      ]
    );
    const a = items[1];
    const st = statSync(join(root, zed, "a.json"));
    assert.deepEqual(a.stat, { size: st.size, mtimeMs: st.mtimeMs });
    assert.equal(a.dir, zed);
    assert.equal(a.body.guid, "a");
    assert.deepEqual(a.origin, { kind: "local", key: `${zed}/a.json`, sha256: sha256(Buffer.from(body("a"))) });
    assert.equal(items[0].body, null, "an unparseable body is still sent, as null, like the provider lists it");

    const only = [];
    for await (const item of localSource(root, { only: new Set(["zed-show"]) })) only.push(item.fileName);
    assert.deepEqual(only, ["a.json", "b.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local walk: two directories that strip to one show keep the first and report the other; a missing root is empty", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "same"));
    mkdirSync(join(root, safeKey("same")));
    writeFileSync(join(root, "same", "a.json"), body("a"));
    writeFileSync(join(root, safeKey("same"), "b.json"), body("b"));
    const listing = listLocal(root);
    assert.deepEqual([...listing.shows.keys()], ["same"]);
    assert.deepEqual(listing.shows.get("same").map((e) => e.fileName), ["a.json"]);
    assert.deepEqual(listing.shadowedDirs, [{ dir: safeKey("same"), show_id: "same", kept: "same" }]);
    assert.equal(listLocal(join(root, "absent")).shows.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* (b) R2 directory mapping. Mutation: key shows by parsed.dir instead of
   mapped.show_id and the two farm directories become two shows. Mutation:
   drop the fileName sort in sortedShows and ep-2.json (listed first, under
   the PodcastIndex directory) precedes ep-1.json. */
test("R2 listing: mapped dirs group under foray's show_id and its local dir, unmapped dirs are kept and reported, strays are ignored", async () => {
  const client = fakeClient(
    [
      { key: key(PI_DIR, "ep-2.json"), body: body("g2") },
      { key: key(SLUG_DIR, "ep-1.json"), body: body("g1") },
      { key: key(safeKey("mystery"), "m.json"), body: body("m") },
      { key: "transcripts/normalized/" + PI_DIR + "/ep-2.vtt", body: "WEBVTT" },
    ],
    ["some-show/an-episode-0123456789.json", "fingerprints/x/y.json"]
  );
  const listing = await listR2Normalized({ client, bucket: "b", showMap, commands });
  assert.deepEqual([...listing.shows.keys()], ["being-an-engineer", "mystery"]);
  const bae = listing.shows.get("being-an-engineer");
  assert.deepEqual(bae.map((e) => e.fileName), ["ep-1.json", "ep-2.json"]);
  assert.ok(bae.every((e) => e.dir === SLUG_DIR), "local dir is localDirFor(show_id)");
  assert.equal(bae[1].mtimeMs, Date.parse("2026-10-01T12:00:00Z"));
  assert.equal(bae[1].origin.key, key(PI_DIR, "ep-2.json"));
  assert.match(bae[1].origin.etag, /^"e-/);
  assert.deepEqual(listing.unmappedDirs, [{ dir: safeKey("mystery"), objects: 1 }]);
  assert.equal(listing.shows.get("mystery")[0].dir, safeKey("mystery"));
  assert.equal(listing.ignored, 3, "the .vtt under normalized/, the legacy root key and fingerprints/ are not bodies");
  assert.ok(client.calls.every(([name]) => name === "ListObjectsV2Command"), "listing sends no GET");
});

/* (c) Quarantines with sync-r2's codes. Mutation: drop the sha check in
   readR2 and the bad-sha object is yielded as a body. */
test("R2 read: SHA_MISMATCH, BAD_JSON, BAD_SHAPE and NO_BODY are quarantined to persist, a failed GET is quarantined without persisting, a good body comes back whole", async () => {
  const dir = SLUG_DIR;
  const good = body("ok");
  const client = fakeClient([
    { key: key(dir, "good.json"), body: good },
    { key: key(dir, "sha.json"), body: body("s"), meta: "0".repeat(64) },
    { key: key(dir, "json.json"), body: "{nope" },
    { key: key(dir, "shape.json"), body: JSON.stringify({ show_id: "x", guid: "y", cues: "no" }) },
    { key: key(dir, "nobody.json"), body: body("n"), noBody: true },
    { key: key(dir, "flaky.json"), body: body("f"), fail: true },
  ]);
  const listing = await listR2Normalized({ client, bucket: "b", showMap, commands });
  const byName = new Map();
  for await (const item of r2NormalizedSource({ client, bucket: "b", commands, listing })) byName.set(item.fileName, item);

  assert.equal(byName.get("good.json").kind, "body");
  assert.equal(byName.get("good.json").bytes.toString("utf8"), good);
  assert.equal(byName.get("good.json").body.guid, "ok");
  assert.equal(byName.get("good.json").origin.sha256, sha256(Buffer.from(good)));
  assert.equal(byName.get("good.json").stat.mtimeMs, Date.parse("2026-10-01T12:00:00Z"));
  const q = (name) => [byName.get(name).kind, byName.get(name).reason, byName.get(name).persist];
  assert.deepEqual(q("sha.json"), ["quarantine", "SHA_MISMATCH", true]);
  assert.deepEqual(q("json.json"), ["quarantine", "BAD_JSON", true]);
  assert.deepEqual(q("shape.json"), ["quarantine", "BAD_SHAPE:cues", true]);
  assert.deepEqual(q("nobody.json"), ["quarantine", "NO_BODY", true]);
  assert.deepEqual(q("flaky.json"), ["quarantine", "GET_FAILED:TimeoutError", false]);

  const gets = client.calls.filter(([name]) => name === "GetObjectCommand").map(([, k]) => k);
  assert.equal(gets.length, 6);
  assert.equal(new Set(gets).size, 6, "each object is fetched exactly once");
});

test("R2 listing: a dot-segment key is quarantined PATH_ESCAPE at list time and never fetched; the last-listed object of a name wins within a show", async () => {
  const client = fakeClient([
    { key: "transcripts/normalized/../evil.json", body: body("e") },
    { key: key(PI_DIR, "same.json"), body: body("from-pi") },
    { key: key(SLUG_DIR, "same.json"), body: body("from-slug-longer") },
  ]);
  const listing = await listR2Normalized({ client, bucket: "b", showMap, commands });
  assert.deepEqual(listing.quarantined.map((q) => [q.origin.key, q.reason]), [["transcripts/normalized/../evil.json", "PATH_ESCAPE"]]);
  const entries = listing.shows.get("being-an-engineer");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].origin.key, key(SLUG_DIR, "same.json"));
  const item = await readR2(entries[0], { client, bucket: "b", commands });
  assert.equal(item.body.guid, "from-slug-longer");
  assert.ok(!client.calls.some(([, k]) => k === "transcripts/normalized/../evil.json"), "the escaping key is never fetched");
});
