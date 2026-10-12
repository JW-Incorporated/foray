/* GV-09 (W3-05, docs/roadmap/generation-v2.md): the stream indexer. Every run
   uses tmp directories, an injected statfs, a fake S3 client (the
   sync-r2.test.mjs pattern) or a tmp normalized tree, and a recording indexer
   stub in place of the tsx spawn. The spawn protocol itself is exercised
   against a plain node child that speaks indexBodies' line protocol, so no
   test needs backend/node_modules, the network or a credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { safeKey } from "../foraycorpus-export/config.mjs";
import { sha256 } from "../foraycorpus-export/r2-client.mjs";
import { buildShowMap } from "../foraycorpus-export/show-map.mjs";
import { EPISODES_FILE, QUARANTINE_FILE, readManifest } from "./manifest.mjs";
import { listLocal, listR2Normalized, readLocal, readR2 } from "./sources.mjs";
import {
  CueCache,
  DEFAULT_INDEX_ROOT,
  estimateNeedBytes,
  INDEX_ENTRY,
  parseStreamArgs,
  PASSAGES_FACTOR,
  POSTINGS_FACTOR,
  spawnIndexer,
  streamIndex,
} from "./stream-index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/* A mutable fake bucket: `objects` maps key -> {body, meta?, etag, lastModified}. */
function fakeBucket(initial) {
  const objects = new Map();
  const put = (key, bodyText, extra = {}) => objects.set(key, { bytes: Buffer.from(bodyText), etag: `"${sha256(Buffer.from(bodyText)).slice(0, 8)}"`, lastModified: new Date("2026-10-01T00:00:00Z"), ...extra });
  for (const [k, v] of Object.entries(initial)) put(k, v);
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
      const meta = o.meta === undefined ? sha256(o.bytes) : o.meta;
      return { Metadata: { sha256: meta }, ContentLength: o.bytes.length, ETag: o.etag, Body: { transformToByteArray: async () => new Uint8Array(o.bytes) } };
    },
  };
  return { client, calls, objects, put, gets: () => calls.filter(([n]) => n === "GetObjectCommand").map(([, k]) => k) };
}

/* A recording indexer: the records it was sent, in order, and how often it was opened. */
function recordingIndexer() {
  const records = [];
  const factory = (paths) => {
    factory.opened += 1;
    factory.paths = paths;
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

const roomy = () => ({ bavail: 1e15, bsize: 1 });
const body = (guid, text = "hello") => JSON.stringify({ show_id: "farm", guid, cues: [{ start_sec: 0, end_sec: 3 }, { start_sec: 3, end_sec: 7.25, text }].map((c) => ({ text: "x", ...c })), transcript_source: "asr-local" });
const key = (dir, file) => `transcripts/normalized/${dir}/${file}`;

const { map: showMap } = buildShowMap({
  queue: { shows: [{ title: "Being an Engineer", feed_url: "https://feeds.example.com/bae", podcastindex_feed_id: 470582, apple_collection_id: 1 }] },
  catalog: { shows: [{ show_id: "being-an-engineer", feed_url: "https://feeds.example.com/bae" }, { show_id: "geology-bites", feed_url: "https://feeds.example.com/gb" }] },
});
const BAE_PI = safeKey("470582");
const BAE = safeKey("being-an-engineer");
const GEO = safeKey("geology-bites");

function r2Run(bucket, root, extra = {}) {
  const ix = extra.indexer ?? recordingIndexer();
  const lines = [];
  return {
    ix,
    lines,
    run: () =>
      streamIndex({
        list: () => listR2Normalized({ client: bucket.client, bucket: "b", showMap, commands }),
        read: (entry) => readR2(entry, { client: bucket.client, bucket: "b", commands }),
        manifestDir: join(root, "passage-index"),
        indexRoot: join(root, "index"),
        stagedOut: join(root, "passage-index", "staged-digest.jsonl"),
        statfs: roomy,
        now: () => new Date("2026-10-11T00:00:00Z"),
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
  if (existsSync(root)) walk(root);
  return out.sort();
}

const tmp = () => mkdtempSync(join(tmpdir(), "gv09-run-"));

/* The package contract run-suites.mjs relies on. Mutation: set the script to
   "node --experimental-sqlite --test sources.test.mjs" and this fails. */
test("package.json test script ends in `node ... --test`, so file arguments are forwarded", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies, undefined, "no dependencies of its own");
  assert.match(pkg.scripts?.test, /(^|\s)node(\s+--[\w-]+)*\s+--test$/);
  assert.match(pkg.scripts.test, /--experimental-sqlite/);
});

test("parseStreamArgs: defaults, every flag, and refusals", () => {
  const d = parseStreamArgs([]);
  assert.equal(d.source, "local");
  assert.equal(d.full, false);
  assert.equal(d.indexRoot, DEFAULT_INDEX_ROOT);
  assert.equal(d.passagesOut, null);
  assert.equal(d.cueCache, null);
  assert.equal(d.minFreeGb, 20);
  const a = parseStreamArgs(["--source", "r2", "--show", "geology-bites", "--full", "--passages-out", "p.jsonl", "--cue-cache", "cc", "--cue-cache-gb", "1.5", "--min-free-gb", "0"]);
  assert.equal(a.source, "r2");
  assert.equal(a.show, "geology-bites");
  assert.equal(a.full, true);
  assert.ok(a.passagesOut.endsWith("p.jsonl"));
  assert.ok(a.cueCache.endsWith("cc"));
  assert.equal(a.cueCacheGb, 1.5);
  assert.equal(a.minFreeGb, 0);
  assert.throws(() => parseStreamArgs(["--source", "s3"]), /BAD_SOURCE/);
  assert.throws(() => parseStreamArgs(["--bogus"]), /UNKNOWN_FLAG/);
  assert.throws(() => parseStreamArgs(["--show"]), /MISSING_VALUE/);
  assert.throws(() => parseStreamArgs(["--min-free-gb", "-1"]), /BAD_NUMBER/);
  assert.equal(INDEX_ENTRY, "src/cli/indexBodies.ts");
  assert.ok(existsSync(join(HERE, "..", "..", "backend", INDEX_ENTRY)), "the spawned entry exists");
});

/* Acceptance: fetched exactly once, grouped by show with an end-show after
   each, nothing on disk but the manifest. Mutation: drop the
   `await ix.endShow(showId)` and the end-show markers vanish. */
test("R2 --full: each object fetched once, records grouped by show with an end-show after each, only the manifest written", async () => {
  const root = tmp();
  try {
    const bucket = fakeBucket({
      [key(BAE_PI, "ep-b.json")]: body("b"),
      [key(GEO, "g1.json")]: body("g1"),
      [key(BAE, "ep-a.json")]: body("a"),
    });
    const { ix, run } = r2Run(bucket, root, { full: true });
    const result = await run();

    assert.deepEqual(bucket.gets().sort(), [key(BAE, "ep-a.json"), key(BAE_PI, "ep-b.json"), key(GEO, "g1.json")].sort());
    assert.equal(new Set(bucket.gets()).size, bucket.gets().length);
    assert.deepEqual(
      ix.records.map((r) => [r.kind, r.show_id, r.fileName ?? null]),
      [
        ["body", "being-an-engineer", "ep-a.json"],
        ["body", "being-an-engineer", "ep-b.json"],
        ["end-show", "being-an-engineer", null],
        ["body", "geology-bites", "g1.json"],
        ["end-show", "geology-bites", null],
      ]
    );
    const first = ix.records[0];
    assert.deepEqual(first.stat, { size: Buffer.byteLength(body("a")), mtimeMs: Date.parse("2026-10-01T00:00:00Z") });
    assert.equal(first.body.guid, "a");
    assert.deepEqual(ix.paths, { indexRoot: join(root, "index"), stagedOut: join(root, "passage-index", "staged-digest.jsonl"), passagesOut: null });
    assert.deepEqual(result.rebuilt, ["being-an-engineer", "geology-bites"]);
    assert.equal(result.bodies, 3);

    assert.deepEqual(filesUnder(root), [`passage-index/${EPISODES_FILE}`, `passage-index/${QUARANTINE_FILE}`]);
    const rows = readFileSync(join(root, "passage-index", EPISODES_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows[0], {
      show_id: "being-an-engineer",
      fileName: "ep-a.json",
      bodyGuid: "a",
      cues: 2,
      lastEndSec: 7.25,
      size: Buffer.byteLength(body("a")),
      mtimeMs: Date.parse("2026-10-01T00:00:00Z"),
      origin: { kind: "r2", key: key(BAE, "ep-a.json"), etag: bucket.objects.get(key(BAE, "ep-a.json")).etag, sha256: sha256(Buffer.from(body("a"))) },
      indexedAt: "2026-10-11T00:00:00.000Z",
    });
    assert.equal(rows.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Acceptance: an unchanged second run rebuilds nothing and GETs nothing;
   changing one object rebuilds only its show, whole. Mutation: make
   showsToRebuild return every listed show and the second run GETs all three.
   Mutation: drop the etag comparison in entryMatches and the same-size
   re-tagged object is not rebuilt. */
test("delta: an unchanged rerun issues no GET and opens no indexer; one changed object re-streams only its show, whole", async () => {
  const root = tmp();
  try {
    const bucket = fakeBucket({
      [key(BAE, "ep-a.json")]: body("a"),
      [key(BAE, "ep-b.json")]: body("b"),
      [key(GEO, "g1.json")]: body("g1"),
    });
    await r2Run(bucket, root).run();
    assert.equal(bucket.gets().length, 3);

    bucket.calls.length = 0;
    const second = r2Run(bucket, root);
    const r2 = await second.run();
    assert.deepEqual(bucket.gets(), []);
    assert.deepEqual(r2.rebuilt, []);
    assert.equal(r2.unchanged, 2);
    assert.equal(second.ix.opened, 0, "no indexer is spawned when nothing changed");

    bucket.calls.length = 0;
    bucket.put(key(BAE, "ep-b.json"), body("b", "a longer revised transcript"));
    const third = r2Run(bucket, root);
    const r3 = await third.run();
    assert.deepEqual(r3.rebuilt, ["being-an-engineer"]);
    assert.deepEqual(bucket.gets(), [key(BAE, "ep-a.json"), key(BAE, "ep-b.json")], "the whole show, and only it");
    assert.ok(third.lines.some((l) => l.includes("rebuild being-an-engineer (changed ep-b.json)")));

    /* Same size, new etag: still a change. */
    bucket.calls.length = 0;
    const o = bucket.objects.get(key(GEO, "g1.json"));
    o.etag = '"retagged"';
    const r4 = await r2Run(bucket, root).run();
    assert.deepEqual(r4.rebuilt, ["geology-bites"]);

    /* A new file in a show, and --show narrowing. */
    bucket.calls.length = 0;
    bucket.put(key(BAE, "ep-c.json"), body("c"));
    bucket.put(key(GEO, "g2.json"), body("g2"));
    const r5 = await r2Run(bucket, root, { show: GEO }).run();
    assert.deepEqual(r5.rebuilt, ["geology-bites"], "--show by directory name narrows the run");
    assert.deepEqual(bucket.gets(), [key(GEO, "g1.json"), key(GEO, "g2.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Acceptance: a quarantined object is reported and skipped and the run goes
   on. Mutation: drop the `continue` after a quarantine item and the stub is
   sent a body-less record (and the bad object becomes an episode row).
   Mutation: stop consulting quarantine rows in showsToRebuild and the second
   run re-streams Being an Engineer. */
test("quarantine: reported and skipped, the run continues; a persisted quarantine does not re-stream its show, a failed GET does", async () => {
  const root = tmp();
  try {
    const bucket = fakeBucket({
      [key(BAE, "bad.json")]: body("bad"),
      [key(BAE, "good.json")]: body("good"),
      [key(GEO, "g1.json")]: body("g1"),
    });
    bucket.objects.get(key(BAE, "bad.json")).meta = "f".repeat(64);
    const first = r2Run(bucket, root);
    const r1 = await first.run();
    assert.deepEqual(r1.quarantined, [{ show_id: "being-an-engineer", key: key(BAE, "bad.json"), reason: "SHA_MISMATCH" }]);
    assert.deepEqual(r1.rebuilt, ["being-an-engineer", "geology-bites"]);
    assert.deepEqual(first.ix.records.filter((r) => r.kind === "body").map((r) => r.fileName), ["good.json", "g1.json"]);
    assert.equal(r1.exitCode, 0);
    const m = readManifest(join(root, "passage-index"));
    assert.deepEqual(m.episodes.get("being-an-engineer").map((r) => r.fileName), ["good.json"]);
    assert.deepEqual(m.quarantine.get("being-an-engineer").map((r) => [r.fileName, r.reason]), [["bad.json", "SHA_MISMATCH"]]);

    bucket.calls.length = 0;
    const r2 = await r2Run(bucket, root).run();
    assert.deepEqual(r2.rebuilt, []);
    assert.equal(r2.carried_quarantine, 1);
    assert.deepEqual(bucket.gets(), []);

    /* A transient GET failure is not remembered: the show is retried. */
    const flaky = fakeBucket({ [key(GEO, "g1.json")]: body("g1"), [key(GEO, "g2.json")]: body("g2") });
    const send = flaky.client.send.bind(flaky.client);
    let failOnce = true;
    flaky.client.send = async (cmd) => {
      if (failOnce && cmd.constructor.name === "GetObjectCommand" && cmd.input.Key.endsWith("g2.json")) {
        failOnce = false;
        const e = new Error("reset");
        e.name = "NetworkingError";
        throw e;
      }
      return send(cmd);
    };
    const root2 = tmp();
    try {
      const a = await r2Run(flaky, root2).run();
      assert.deepEqual(a.quarantined.map((q) => q.reason), ["GET_FAILED:NetworkingError"]);
      assert.equal(readManifest(join(root2, "passage-index")).quarantine.size, 0);
      const b = await r2Run(flaky, root2).run();
      assert.deepEqual(b.rebuilt, ["geology-bites"]);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Acceptance: the disk guard refuses before the first GET. Mutation: skip
   the guard and the run GETs and indexes instead of refusing. */
test("disk guard: refuses with DISK_SPACE before any GET or write; the estimate counts postings, passages and the cue cache; --min-free-gb 0 never asks statfs", async () => {
  assert.equal(estimateNeedBytes({ bodyBytes: 1000 }), Math.ceil(1000 * POSTINGS_FACTOR));
  assert.equal(estimateNeedBytes({ bodyBytes: 1000, passages: true }), Math.ceil(1000 * (POSTINGS_FACTOR + PASSAGES_FACTOR)));
  assert.equal(estimateNeedBytes({ bodyBytes: 1000, cueCacheCapBytes: 300 }), Math.ceil(400 + 300));
  assert.equal(estimateNeedBytes({ bodyBytes: 1000, cueCacheCapBytes: 1e12 }), 1400);

  const root = tmp();
  try {
    const bucket = fakeBucket({ [key(GEO, "g1.json")]: body("g1") });
    const size = Buffer.byteLength(body("g1"));
    const asked = [];
    /* Free space covers the margin plus postings, but not passages too. */
    const tight = (p) => {
      asked.push(p);
      return { bavail: 20e9 + Math.ceil(size * POSTINGS_FACTOR) + 1, bsize: 1 };
    };
    const refused = r2Run(bucket, root, { statfs: tight, passagesOut: join(root, "passages.jsonl") });
    await assert.rejects(refused.run(), (e) => e.code === "DISK_SPACE");
    assert.deepEqual(bucket.gets(), [], "no GET before the guard");
    assert.equal(refused.ix.opened, 0);
    assert.deepEqual(filesUnder(root), []);
    assert.ok(asked.length > 0);

    const ok = await r2Run(bucket, root, { statfs: tight }).run();
    assert.deepEqual(ok.rebuilt, ["geology-bites"]);

    let called = 0;
    const root2 = tmp();
    try {
      const off = await r2Run(bucket, root2, { statfs: () => (called++, { bavail: 0, bsize: 1 }), minFreeGb: 0 }).run();
      assert.deepEqual(off.rebuilt, ["geology-bites"]);
      assert.equal(called, 0);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Mutation: evict from the newest end (iterate the entries reversed) and the
   oldest body survives while the one just written is deleted. */
test("cue cache: byte-identical bodies under <dir>/<fileName>, LRU eviction by bytes, reopened in mtime order, only when --cue-cache is set", async () => {
  const root = tmp();
  try {
    const cacheDir = join(root, "cue-cache");
    const c = new CueCache(cacheDir, 25);
    c.put("show-a", "1.json", Buffer.from("0123456789"));
    c.put("show-a", "2.json", Buffer.from("abcdefghij"));
    c.put("show-b", "3.json", Buffer.from("ABCDEFGHIJ"));
    assert.equal(c.bytes, 20);
    assert.equal(c.evicted, 1);
    assert.ok(!existsSync(join(cacheDir, "show-a", "1.json")), "the oldest is evicted first");
    assert.equal(readFileSync(join(cacheDir, "show-b", "3.json"), "utf8"), "ABCDEFGHIJ");
    assert.equal(c.put("show-b", "huge.json", Buffer.alloc(26)), false, "a body over the whole cap is not kept");

    /* Reopened: the order is the files' mtime, so a touched file is warm. */
    utimesSync(join(cacheDir, "show-a", "2.json"), new Date("2030-01-01"), new Date("2030-01-01"));
    utimesSync(join(cacheDir, "show-b", "3.json"), new Date("2029-01-01"), new Date("2029-01-01"));
    const reopened = new CueCache(cacheDir, 25);
    reopened.put("show-c", "4.json", Buffer.from("klmnopqrst"));
    assert.ok(!existsSync(join(cacheDir, "show-b", "3.json")));
    assert.ok(existsSync(join(cacheDir, "show-a", "2.json")));
    assert.ok(statSync(join(cacheDir, "show-c", "4.json")).size === 10);

    /* Through a run: the cache gets the exact bytes, under the local dir. */
    const runRoot = join(root, "run");
    const bucket = fakeBucket({ [key(BAE_PI, "ep-a.json")]: body("a"), [key(GEO, "g1.json")]: body("g1") });
    const cueCache = join(runRoot, "cues");
    const r = await r2Run(bucket, runRoot, { full: true, cueCache, cueCacheGb: 1 }).run();
    assert.equal(readFileSync(join(cueCache, BAE, "ep-a.json"), "utf8"), body("a"));
    assert.equal(r.cue_cache.files, 2);
    assert.deepEqual(filesUnder(runRoot), [`cues/${BAE}/ep-a.json`, `cues/${GEO}/g1.json`, `passage-index/${EPISODES_FILE}`, `passage-index/${QUARANTINE_FILE}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local source: records carry the file's own stat (what a local FileTranscriptTextIndex compares), and a touched file re-streams its show", async () => {
  const root = tmp();
  try {
    const normalized = join(root, "normalized");
    mkdirSync(join(normalized, GEO), { recursive: true });
    mkdirSync(join(normalized, BAE), { recursive: true });
    writeFileSync(join(normalized, GEO, "g1.json"), body("g1"));
    writeFileSync(join(normalized, BAE, "a.json"), body("a"));
    const run = (ix) =>
      streamIndex({
        list: async () => listLocal(normalized),
        read: async (entry) => readLocal(entry),
        manifestDir: join(root, "passage-index"),
        indexRoot: join(root, "index"),
        statfs: roomy,
        log: () => {},
        indexer: ix,
      });
    const ix = recordingIndexer();
    const r = await run(ix);
    assert.deepEqual(r.rebuilt, ["being-an-engineer", "geology-bites"]);
    const st = statSync(join(normalized, GEO, "g1.json"));
    const rec = ix.records.find((x) => x.fileName === "g1.json");
    assert.deepEqual(rec.stat, { size: st.size, mtimeMs: st.mtimeMs });

    const again = recordingIndexer();
    assert.deepEqual((await run(again)).rebuilt, []);
    utimesSync(join(normalized, GEO, "g1.json"), new Date("2031-01-01"), new Date("2031-01-01"));
    const touched = recordingIndexer();
    assert.deepEqual((await run(touched)).rebuilt, ["geology-bites"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* The real launcher's line protocol against a plain node child that answers
   like indexBodies (a `<show>: ...` summary per end-show, `problem:` lines at
   the end). Mutation: resolve endShow on the first stdout line whatever its
   show and the second show's await returns the first show's line. */
test("spawnIndexer: streams JSONL to the child, waits for each show's summary line, collects problems and the exit code", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const counts = new Map();",
    "rl.on('line', (l) => { const r = JSON.parse(l);",
    "  if (r.kind === 'body') counts.set(r.show_id, (counts.get(r.show_id) || 0) + 1);",
    "  else { console.log('noise line'); console.log(r.show_id + ': ' + (counts.get(r.show_id) || 0) + ' bodies'); } });",
    "rl.on('close', () => { console.log('problem: line 9: no show_id'); process.exitCode = 1; });",
  ].join("\n");
  const seen = [];
  const ix = spawnIndexer({ command: process.execPath, args: ["-e", script], cwd: HERE, log: (l) => seen.push(l) });
  let closed = null;
  try {
    await ix.send({ kind: "body", show_id: "s1", fileName: "a.json", stat: { size: 1, mtimeMs: 1 }, body: {} });
    await ix.send({ kind: "body", show_id: "s1", fileName: "b.json", stat: { size: 1, mtimeMs: 1 }, body: {} });
    assert.equal(await ix.endShow("s1"), "s1: 2 bodies");
    await ix.send({ kind: "body", show_id: "s2", fileName: "c.json", stat: { size: 1, mtimeMs: 1 }, body: {} });
    assert.equal(await ix.endShow("s2"), "s2: 1 bodies");
  } finally {
    /* Closing stdin ends the child, so a failed assertion cannot leave it running. */
    closed = await ix.close();
  }
  assert.equal(closed.exitCode, 1);
  assert.deepEqual(closed.problems, ["line 9: no show_id"]);
  assert.ok(seen.includes("[indexBodies] noise line"));

  /* A child that dies before answering rejects the wait instead of hanging. */
  const dead = spawnIndexer({ command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(3), 50);"], cwd: HERE, log: () => {} });
  await assert.rejects(dead.endShow("s1"), (e) => e.code === "INDEXER_EXIT" || e.code === "EPIPE");
  assert.equal((await dead.close()).exitCode, 3);
});
