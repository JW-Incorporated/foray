/* GV-09 (W3-05, docs/roadmap/generation-v2.md): the stream indexer's body
   sources. Local runs walk a tmp normalized tree; R2 runs use a fake S3 client
   (the sync-r2.test.mjs pattern: command classes named like the SDK's, the
   client switching on cmd.constructor.name). No network, no credential, no
   node_modules. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { safeKey } from "../foraycorpus-export/config.mjs";
import { convertWhisperDoc, toNormalizedBody } from "../foraycorpus-export/legacy-whisper.mjs";
import { sha256 } from "../foraycorpus-export/r2-client.mjs";
import { buildShowMap } from "../foraycorpus-export/show-map.mjs";
import { EPISODES_FILE, QUARANTINE_FILE, readManifest } from "./manifest.mjs";
import {
  listLocal,
  listR2All,
  listR2Legacy,
  listR2Normalized,
  localSource,
  r2NormalizedSource,
  readLegacyMap,
  readR2,
  readR2Any,
  readR2Legacy,
  resolveLegacyKey,
  showIdOfDir,
} from "./sources.mjs";
import { DEFAULT_LEGACY_MAP, parseStreamArgs, streamIndex } from "./stream-index.mjs";

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

/* ------------------------------------------------------------------------
   GV-60 (W3-06, docs/roadmap/generation-v2.md): the legacy whisper source.
   A fake bucket mixes farm, legacy, fingerprint and probe keys; the legacy
   bodies are W3-02's synthetic whisper fixtures; the legacy map is a stub in
   the shape GV-53's --resolve-legacy writes. Runs go through streamIndex
   with a recording indexer, so no spawn, no network, no credential. */

const WHISPER = join(dirname(fileURLToPath(import.meta.url)), "..", "foraycorpus-export", "fixtures", "synthetic", "legacy-whisper");
const DOC_OK = readFileSync(join(WHISPER, "doc-ok.json"), "utf8");
const DOC_BAD = readFileSync(join(WHISPER, "doc-bad.json"), "utf8");
const GEO = safeKey("geology-bites");

const L_KETTLE = "geology-bites/the-copper-kettle-aaaaaaaaaa.json";
const L_FARMDUP = "geology-bites/already-farmed-bbbbbbbbbb.json";
const L_BAE = "being-an-engineer/bridges-cccccccccc.json";
const L_BADDOC = "being-an-engineer/not-whisper-1111111111.json";
const L_UNMATCHED = "geology-bites/lost-dddddddddd.json";
const L_AMBIG = "mystery-hour/twins-eeeeeeeeee.json";
const L_NOMAP = "new-show/fresh-ffffffffff.json";
const L_SECOND = "geology-bites/kettle-again-2222222222.json";
const FARM_DUP = key(GEO, `${safeKey("geo-farmed")}.json`);
const FARM_ONLY = key(GEO, `${safeKey("geo-only-farm")}.json`);

const legacyMap = {
  version: 1,
  generated_at: "2026-10-12T00:00:00.000Z",
  map: {
    [L_KETTLE]: { show_id: "geology-bites", guid: "geo-kettle", title: "The copper kettle", via: "rss" },
    [L_FARMDUP]: { show_id: "geology-bites", guid: "geo-farmed", title: "Already farmed", via: "rss" },
    [L_BAE]: { show_id: "being-an-engineer", guid: "bae-bridges", title: "Bridges", via: "foray-db" },
    [L_BADDOC]: { show_id: "being-an-engineer", guid: "bae-bad", title: "Bad", via: "rss" },
  },
  unresolved: {
    [L_UNMATCHED]: { status: "unmatched", reason: "no_episode_for_guid_hash", show_id: "geology-bites" },
    [L_AMBIG]: { status: "ambiguous", reason: "show_slug_multi_show", show_id: null },
  },
};

const farmBody = (guid) => JSON.stringify({ show_id: "geology-bites", guid, cues: [{ start_sec: 0, end_sec: 2, text: `farm ${guid}` }], transcript_source: "publisher" });

/* A mutable bucket: key -> {bytes, etag, lastModified, meta}. Farm objects
   carry the farm's sha256 metadata; legacy objects carry none. */
function legacyBucket() {
  const objects = new Map();
  const put = (k, text, extra = {}) =>
    objects.set(k, {
      bytes: Buffer.from(text),
      etag: `"${sha256(Buffer.from(text)).slice(0, 8)}"`,
      lastModified: new Date("2026-09-01T00:00:00Z"),
      meta: k.startsWith("transcripts/") ? undefined : null,
      ...extra,
    });
  put(FARM_DUP, farmBody("geo-farmed"));
  put(FARM_ONLY, farmBody("geo-only-farm"));
  put(`transcripts/raw/${GEO}/${safeKey("geo-farmed")}.vtt`, "WEBVTT");
  put(L_KETTLE, DOC_OK);
  put(L_FARMDUP, DOC_OK);
  put(L_BAE, DOC_OK);
  put(L_BADDOC, DOC_BAD);
  put(L_UNMATCHED, DOC_OK);
  put(L_AMBIG, DOC_OK);
  put(L_NOMAP, DOC_OK);
  put("fingerprints/geology-bites/kettle-aaaaaaaaaa.json", "{}");
  put("_probe/canary-0123456789.json", "{}");
  put("transcript-originals/geology-bites/old-0123456789.json", "{}");
  const calls = [];
  const client = {
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push([name, cmd.input.Key ?? cmd.input.Prefix]);
      if (name === "ListObjectsV2Command") {
        const keys = [...objects.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).sort();
        return { IsTruncated: false, Contents: keys.map((Key) => ({ Key, Size: objects.get(Key).bytes.length, ETag: objects.get(Key).etag, LastModified: objects.get(Key).lastModified })) };
      }
      const o = objects.get(cmd.input.Key);
      if (!o) throw new Error(`fake: no such key ${cmd.input.Key}`);
      const meta = o.meta === undefined ? sha256(o.bytes) : o.meta;
      return { Metadata: meta === null ? {} : { sha256: meta }, ContentLength: o.bytes.length, ETag: o.etag, Body: { transformToByteArray: async () => new Uint8Array(o.bytes) } };
    },
  };
  return { client, calls, objects, put, gets: () => calls.filter(([n]) => n === "GetObjectCommand").map(([, k]) => k) };
}

/* The recording indexer stream-index.test.mjs uses. */
function recordingIndexer() {
  const records = [];
  const factory = () => {
    factory.opened += 1;
    return {
      send: async (record) => {
        records.push(record);
      },
      endShow: async (showId) => {
        records.push({ kind: "end-show", show_id: showId });
        return `${showId}: ok`;
      },
      close: async () => ({ exitCode: 0, problems: [] }),
    };
  };
  factory.opened = 0;
  factory.records = records;
  return factory;
}

function legacyRun(bucket, root, { source = "r2-legacy", map = legacyMap, ...extra } = {}) {
  const ix = recordingIndexer();
  const lines = [];
  const opts = { client: bucket.client, bucket: "b", commands };
  const list = source === "r2-all" ? () => listR2All({ ...opts, showMap, legacyMap: map }) : () => listR2Legacy({ ...opts, legacyMap: map });
  const read = source === "r2-all" ? (entry) => readR2Any(entry, opts) : (entry) => readR2Legacy(entry, opts);
  return {
    ix,
    lines,
    run: () =>
      streamIndex({
        list,
        read,
        manifestDir: join(root, "passage-index"),
        indexRoot: join(root, "index"),
        stagedOut: join(root, "passage-index", "staged-digest.jsonl"),
        statfs: () => ({ bavail: 1e15, bsize: 1 }),
        now: () => new Date("2026-10-13T00:00:00Z"),
        log: (l) => lines.push(l),
        ...extra,
        indexer: ix,
      }),
  };
}

function filesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/* Acceptance: unresolved keys are counted by reason and never indexed; farm
   keys, fingerprints and probe keys are never legacy. Mutation: drop the
   parseLegacyKey filter in listR2Legacy and the six non-legacy keys count as
   no-map (no-map 1 -> 7, ignored 6 -> 0). Mutation: make resolveLegacyKey
   ignore the map's unresolved status and unmatched/ambiguous read 0. */
test("legacy listing: only parseLegacyKey keys, resolved through the legacy map, skips counted by reason, list only", async () => {
  const bucket = legacyBucket();
  const listing = await listR2Legacy({ client: bucket.client, bucket: "b", legacyMap, commands });
  assert.deepEqual(listing.legacy, {
    listed: 13,
    keys: 7,
    resolved: 4,
    skipped: { unmatched: 1, ambiguous: 1, "no-map": 1 },
    duplicates: { legacy: 0, normalized: 0 },
  });
  assert.equal(listing.ignored, 6, "the 3 farm keys, fingerprints/, _probe/ and transcript-originals/");
  assert.deepEqual([...listing.shows.keys()], ["being-an-engineer", "geology-bites"]);
  const geo = listing.shows.get("geology-bites");
  assert.deepEqual(geo.map((e) => e.origin.key).sort(), [L_FARMDUP, L_KETTLE].sort());
  assert.deepEqual(
    geo.map((e) => e.fileName),
    [`${safeKey("geo-farmed")}.json`, `${safeKey("geo-kettle")}.json`].sort()
  );
  const kettle = geo.find((e) => e.origin.key === L_KETTLE);
  assert.equal(kettle.fileName, `${safeKey("geo-kettle")}.json`, "the locate rule's exact name: corpusSafeKey(guid).json");
  assert.equal(kettle.dir, GEO, "the local dir is localDirFor(show_id)");
  assert.equal(kettle.guid, "geo-kettle");
  assert.equal(kettle.size, Buffer.byteLength(DOC_OK));
  assert.equal(kettle.mtimeMs, Date.parse("2026-09-01T00:00:00Z"));
  assert.deepEqual(kettle.origin, { kind: "legacy", key: L_KETTLE, etag: bucket.objects.get(L_KETTLE).etag });
  assert.ok(bucket.calls.every(([name]) => name === "ListObjectsV2Command"), "listing sends no GET");
  assert.deepEqual(bucket.calls.map(([, p]) => p), [""], "one listing, of the bucket root");

  /* Two legacy keys for one episode: the first listed is kept and counted. */
  bucket.put(L_SECOND, DOC_OK);
  const both = { ...legacyMap, map: { ...legacyMap.map, [L_SECOND]: { show_id: "geology-bites", guid: "geo-kettle" } } };
  const twice = await listR2Legacy({ client: bucket.client, bucket: "b", legacyMap: both, commands });
  assert.equal(twice.legacy.duplicates.legacy, 1);
  assert.equal(twice.shows.get("geology-bites").find((e) => e.guid === "geo-kettle").origin.key, L_SECOND, "kettle-again sorts before the-copper-kettle");

  /* No map at all: every legacy key is no-map and nothing is listed. */
  const none = await listR2Legacy({ client: bucket.client, bucket: "b", legacyMap: null, commands });
  assert.deepEqual(none.legacy.skipped, { unmatched: 0, ambiguous: 0, "no-map": 8 });
  assert.equal(none.shows.size, 0);
});

/* Acceptance: legacy objects are converted and reach the indexer with no
   local body file; converted bodies carry transcript_source "asr-local" and
   no source_url. Mutation: pass keepWords: true to convertWhisperDoc in
   readR2Legacy and the cue deepEqual fails (cues gain `words`). Mutation:
   name the entry after the key's basename instead of safeKey(guid) and the
   fileName assertion fails. */
test("legacy --full: converted bodies reach the indexer stub, asr-local with no source_url, no body file on disk, a non-whisper doc quarantined", async () => {
  const root = mkdtempSync(join(tmpdir(), "gv60-run-"));
  try {
    const bucket = legacyBucket();
    const { ix, run, lines } = legacyRun(bucket, root, { full: true });
    const result = await run();

    const expected = convertWhisperDoc(JSON.parse(DOC_OK));
    const bodies = ix.records.filter((r) => r.kind === "body");
    assert.deepEqual(
      ix.records.map((r) => [r.kind, r.show_id, r.fileName ?? null]),
      [
        ["body", "being-an-engineer", `${safeKey("bae-bridges")}.json`],
        ["end-show", "being-an-engineer", null],
        ...[`${safeKey("geo-farmed")}.json`, `${safeKey("geo-kettle")}.json`].sort().map((f) => ["body", "geology-bites", f]),
        ["end-show", "geology-bites", null],
      ]
    );
    for (const r of bodies) {
      assert.equal(r.body.transcript_source, "asr-local");
      assert.equal(Object.hasOwn(r.body, "source_url"), false, "never a source_url: it would relabel ASR as publisher");
      assert.deepEqual(r.body.cues, expected.cues);
      assert.equal(r.body.show_id, r.show_id);
      assert.deepEqual(r.stat, { size: Buffer.byteLength(DOC_OK), mtimeMs: Date.parse("2026-09-01T00:00:00Z") }, "the object's stat");
    }
    assert.equal(bodies[0].body.guid, "bae-bridges");
    assert.ok(expected.cues.length > 0);

    assert.deepEqual(result.quarantined, [{ show_id: "being-an-engineer", key: L_BADDOC, reason: "LEGACY_SHAPE:not_a_whisper_doc" }]);
    assert.equal(result.bodies, 3);
    assert.deepEqual(result.legacy.skipped, { unmatched: 1, ambiguous: 1, "no-map": 1 });
    assert.ok(lines.includes("stream-index: legacy keys=7 resolved=4 skipped unmatched=1 ambiguous=1 no-map=1 duplicates normalized=0 legacy=0"));
    assert.deepEqual(bucket.gets().sort(), [L_BADDOC, L_BAE, L_FARMDUP, L_KETTLE].sort(), "only resolved keys are fetched, each once");

    assert.deepEqual(filesUnder(root), [`passage-index/${EPISODES_FILE}`, `passage-index/${QUARANTINE_FILE}`], "no body file is written");
    const manifest = readManifest(join(root, "passage-index"));
    const row = manifest.episodes.get("geology-bites").find((r) => r.bodyGuid === "geo-kettle");
    assert.deepEqual(row.origin, { kind: "legacy", key: L_KETTLE, etag: bucket.objects.get(L_KETTLE).etag, sha256: sha256(Buffer.from(DOC_OK)) });
    assert.equal(row.cues, expected.cues.length);
    assert.equal(manifest.quarantine.get("being-an-engineer")[0].reason, "LEGACY_SHAPE:not_a_whisper_doc");

    /* With the cue cache the converted bytes land at <localDir>/<safeKey(guid)>.json. */
    const cached = mkdtempSync(join(tmpdir(), "gv60-cue-"));
    const root2 = mkdtempSync(join(tmpdir(), "gv60-run2-"));
    try {
      await legacyRun(legacyBucket(), root2, { full: true, cueCache: cached, show: "geology-bites" }).run();
      const text = readFileSync(join(cached, GEO, `${safeKey("geo-kettle")}.json`), "utf8");
      assert.deepEqual(JSON.parse(text), toNormalizedBody(expected, { show_id: "geology-bites", guid: "geo-kettle" }));
    } finally {
      rmSync(cached, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Acceptance: a legacy duplicate of a farm-normalized episode is skipped.
   Mutation: drop the `yielded` filter in listR2All and geo-farmed is sent
   twice (and its legacy object is fetched). */
test("r2-all: the farm-normalized body wins a (show_id, guid) both hold, the legacy duplicate is never fetched, and a rerun is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "gv60-all-"));
  try {
    const bucket = legacyBucket();
    const first = legacyRun(bucket, root, { source: "r2-all" });
    const result = await first.run();

    const geo = first.ix.records.filter((r) => r.kind === "body" && r.show_id === "geology-bites");
    assert.deepEqual(geo.map((r) => [r.fileName, r.body.transcript_source]).sort(), [
      [`${safeKey("geo-farmed")}.json`, "publisher"],
      [`${safeKey("geo-kettle")}.json`, "asr-local"],
      [`${safeKey("geo-only-farm")}.json`, "publisher"],
    ].sort());
    assert.equal(geo.filter((r) => r.body.guid === "geo-farmed").length, 1, "the episode is indexed once");
    assert.equal(result.legacy.duplicates.normalized, 1);
    assert.ok(!bucket.gets().includes(L_FARMDUP), "the legacy duplicate is never fetched");
    assert.ok(bucket.gets().includes(FARM_DUP));
    assert.deepEqual(bucket.calls.filter(([n]) => n === "ListObjectsV2Command").map(([, p]) => p), ["transcripts/normalized/", ""], "normalized first, then the root");

    bucket.calls.length = 0;
    const second = legacyRun(bucket, root, { source: "r2-all" });
    const again = await second.run();
    assert.deepEqual(again.rebuilt, [], "no listed file lacks a manifest row, so nothing churns");
    assert.deepEqual(bucket.gets(), []);
    assert.equal(second.ix.opened, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* An etag change triggers a rebuild. Mutation: set origin.etag to null in
   listR2Legacy and the same-size, same-mtime re-tagged object is not
   rebuilt (the delta falls back to mtime). */
test("legacy delta: an unchanged rerun fetches nothing; an etag change re-streams only its show, whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "gv60-delta-"));
  try {
    const bucket = legacyBucket();
    await legacyRun(bucket, root).run();
    bucket.calls.length = 0;
    const unchanged = await legacyRun(bucket, root).run();
    assert.deepEqual(unchanged.rebuilt, []);
    assert.deepEqual(bucket.gets(), []);

    const o = bucket.objects.get(L_KETTLE);
    bucket.objects.set(L_KETTLE, { ...o, etag: '"re-tagged"' });
    bucket.calls.length = 0;
    const third = legacyRun(bucket, root);
    const r3 = await third.run();
    assert.deepEqual(r3.rebuilt, ["geology-bites"]);
    assert.deepEqual(bucket.gets().sort(), [L_FARMDUP, L_KETTLE].sort(), "the whole show, and only it");
    assert.ok(third.lines.some((l) => l.includes(`rebuild geology-bites (changed ${safeKey("geo-kettle")}.json)`)));
    const row = readManifest(join(root, "passage-index")).episodes.get("geology-bites").find((r) => r.bodyGuid === "geo-kettle");
    assert.equal(row.origin.etag, '"re-tagged"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* The flag: the new sources are opt-in and the default stays local.
   Mutation: drop "r2-all" from SOURCES and parseStreamArgs refuses it. */
test("stream-index flags: --source r2-legacy|r2-all and --legacy-map are accepted, the default source stays local", () => {
  const d = parseStreamArgs([]);
  assert.equal(d.source, "local");
  assert.equal(d.legacyMap, DEFAULT_LEGACY_MAP);
  assert.ok(DEFAULT_LEGACY_MAP.endsWith(join("data-local", "passage-index", "legacy-map.json")));
  assert.equal(parseStreamArgs(["--source", "r2-legacy"]).source, "r2-legacy");
  const a = parseStreamArgs(["--source", "r2-all", "--legacy-map", "m.json"]);
  assert.equal(a.source, "r2-all");
  assert.ok(a.legacyMap.endsWith("m.json"));
  assert.throws(() => parseStreamArgs(["--legacy-map"]), /MISSING_VALUE/);

  const dir = mkdtempSync(join(tmpdir(), "gv60-map-"));
  try {
    assert.equal(readLegacyMap(join(dir, "absent.json")), null);
    writeFileSync(join(dir, "legacy-map.json"), JSON.stringify(legacyMap));
    assert.deepEqual(readLegacyMap(join(dir, "legacy-map.json")), legacyMap);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(resolveLegacyKey(legacyMap, L_KETTLE), { show_id: "geology-bites", guid: "geo-kettle" });
  assert.deepEqual(resolveLegacyKey({ map: { [L_KETTLE]: { show_id: "", guid: "g" } } }, L_KETTLE), { skip: "no-map" }, "a malformed row is no-map");
});
