/* PKG-13 (docs/roadmap/corpus.md): sync-r2.mjs mirrors R2 into a local
   transcripts directory. Every test runs syncR2 against a fake S3 client and a
   fresh tmp directory: no network, no credential, no node_modules (the three
   command classes are injected fakes named like the SDK's, and the fake client
   switches on `cmd.constructor.name`, as r2-client.test.mjs does).

   The fake lists the stored objects under the requested Prefix and ALSO
   returns every "stray" key whatever the prefix (a legacy whisper JSON at the
   bucket root, a fingerprints/ object), so the defensive key parse is what
   keeps them out, not the listing's prefix. GET returns the farm's shape:
   Body.transformToByteArray() and Metadata {sha256}. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeKey } from "./config.mjs";
import { sha256 } from "./r2-client.mjs";
import { buildShowMap } from "./show-map.mjs";
import { STATE_FILE_NAME, parseSyncArgs, syncR2 } from "./sync-r2.mjs";

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
class HeadObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
const commands = { ListObjectsV2Command, GetObjectCommand, HeadObjectCommand };

/* objects: [{key, body, meta?}] where meta defaults to the body's real
   sha256 and `meta: null` means the object carries no sha256 metadata.
   LastModified is far in the future, so a sync that compared the local
   file's mtime against it would always refetch. */
function fakeClient(objects, strays = []) {
  const store = new Map(
    objects.map(({ key, body, meta }) => {
      const bytes = Buffer.from(body);
      return [key, { bytes, meta: meta === undefined ? sha256(bytes) : meta }];
    }),
  );
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
          Contents: keys.map((Key) => ({ Key, Size: store.get(Key)?.bytes.length ?? 7, ETag: '"x"', LastModified: new Date("2100-01-01T00:00:00Z") })),
        };
      }
      const o = store.get(cmd.input.Key);
      if (!o) throw new Error(`fake: no such key ${cmd.input.Key}`);
      const Metadata = o.meta === null ? {} : { sha256: o.meta };
      if (name === "HeadObjectCommand") return { Metadata, ContentLength: o.bytes.length };
      if (name === "GetObjectCommand") {
        return { Metadata, ContentLength: o.bytes.length, ETag: '"x"', Body: { transformToByteArray: async () => new Uint8Array(o.bytes) } };
      }
      throw new Error(`fake: unexpected command ${name}`);
    },
  };
}

/* A queue row the farm wrote under its PodcastIndex id, joined by feed URL
   to the curated show `being-an-engineer`. */
const { map: showMap } = buildShowMap({
  queue: { shows: [{ title: "Being an Engineer", feed_url: "https://feeds.example.com/bae", podcastindex_feed_id: 470582, apple_collection_id: 1 }] },
  catalog: { shows: [{ show_id: "being-an-engineer", feed_url: "https://feeds.example.com/bae" }] },
});
const R2_DIR = safeKey("470582");
const LOCAL_DIR = safeKey("being-an-engineer");
const key = (dir, file) => `transcripts/normalized/${dir}/${file}`;

/* Deliberately not what JSON.stringify would produce: extra spaces, `1.50`,
   a \u escape and no trailing newline. The body's show_id is the farm's. */
const BODY_A =
  '{"show_id":"470582",  "guid":"ep-1","source_url":"https://e.example/x.mp3",' +
  '"cues":[{"start_sec":0,"end_sec":1.50,"text":"caf\\u00e9 talk"}],"warnings":[],"transcript_source":"publisher"}';
const body = (guid, extra = {}) =>
  JSON.stringify({ show_id: "470582", guid, source_url: "https://e.example/y.mp3", cues: [{ start_sec: 0, end_sec: 2, text: "hi" }], warnings: [], ...extra });

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "sync-r2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const run = (client, out, extra = {}) =>
  syncR2({ client, bucket: "bkt", out, showMap, commands, now: () => new Date("2026-10-05T00:00:00Z"), log: () => {}, ...extra });
const readState = (out) => JSON.parse(readFileSync(join(out, STATE_FILE_NAME), "utf8"));

/* (a) A normalized object under the farm's directory lands at
   <out>/normalized/<safeKey(foray show_id)>/<R2 file name>, byte-identical,
   with the farm's show_id inside left alone.
   Mutation that turns this red: in syncR2 write
   `JSON.stringify(body)` instead of `got.body` (the bytes differ). */
test("(a) a mapped normalized body lands under safeKey(show_id) byte-identical", async (t) => {
  const out = tmp(t);
  const client = fakeClient([{ key: key(R2_DIR, "ep-1-abc.json"), body: BODY_A }]);
  const { state } = await run(client, out);
  const local = join(out, "normalized", LOCAL_DIR, "ep-1-abc.json");
  assert.ok(Buffer.from(BODY_A).equals(readFileSync(local)), "bytes on disk equal the R2 bytes");
  assert.equal(JSON.parse(readFileSync(local, "utf8")).show_id, "470582");
  assert.equal(state.written, 1);
  assert.deepEqual(state.shows[LOCAL_DIR], { show_id: "being-an-engineer", via: "catalog-feed", bodies: 1 });
});

/* (b) A second sync over an unchanged bucket writes nothing: the local
   sha256 equals the HEAD's metadata sha256, so no GET is sent.
   Mutation that turns this red: replace the sha comparison with a
   modification-time check (`statSync(localPath).mtime >= obj.lastModified`;
   the fake's LastModified is in 2100, so every run refetches and writes), or
   drop the `skipped_same` branch. */
test("(b) a second sync is skipped_same and sends no GET", async (t) => {
  const out = tmp(t);
  const client = fakeClient([{ key: key(R2_DIR, "ep-1-abc.json"), body: BODY_A }]);
  await run(client, out);
  client.calls.length = 0;
  const { state } = await run(client, out);
  assert.equal(state.written, 0);
  assert.equal(state.skipped_same, 1);
  assert.deepEqual(
    client.calls.filter(([n]) => n === "GetObjectCommand"),
    [],
  );
});

/* (c) A legacy whisper JSON at the bucket root and a fingerprints/ object
   come back from the listing but are counted `ignored`, never fetched and
   never written.
   Mutation that turns this red: in parseBodyKey take the last two segments of
   any key ending `.json` as dir/file (drop the four-segment `transcripts/`
   check, and the `startsWith(listed)` test in syncR2). */
test("(c) bucket-root legacy and fingerprints/ keys are ignored", async (t) => {
  const out = tmp(t);
  const strays = ["some-show/title-abcdef1234.json", "fingerprints/470582/ep-1.json"];
  const client = fakeClient([{ key: key(R2_DIR, "ep-1-abc.json"), body: BODY_A }], strays);
  const { state } = await run(client, out);
  assert.equal(state.objects_seen, 3);
  assert.equal(state.ignored, 2);
  assert.equal(state.written, 1);
  assert.deepEqual(
    client.calls.filter(([n]) => n === "GetObjectCommand").map(([, k]) => k),
    [key(R2_DIR, "ep-1-abc.json")],
  );
  assert.deepEqual(readdirSync(join(out, "normalized")), [LOCAL_DIR]);
});

/* (d) transcript_source outside TRANSCRIPT_SOURCES quarantines the body and
   nothing is written; an allowed source beside it ("apple-podcasts") is.
   Mutation that turns this red: drop the transcript_source check from
   bodyShapeError (the bad body is written). */
test("(d) an unknown transcript_source is quarantined and absent on disk", async (t) => {
  const out = tmp(t);
  const client = fakeClient([
    { key: key(R2_DIR, "bad-src.json"), body: body("ep-2", { transcript_source: "not-a-source" }) },
    { key: key(R2_DIR, "apple.json"), body: body("ep-3", { transcript_source: "apple-podcasts" }) },
  ]);
  const { state } = await run(client, out);
  assert.deepEqual(state.quarantined, [{ key: key(R2_DIR, "bad-src.json"), reason: "BAD_SHAPE:transcript_source" }]);
  assert.equal(existsSync(join(out, "normalized", LOCAL_DIR, "bad-src.json")), false);
  assert.equal(existsSync(join(out, "normalized", LOCAL_DIR, "apple.json")), true);
});

/* (e) Bytes whose sha256 differs from the farm's metadata are quarantined
   SHA_MISMATCH and not written.
   Mutation that turns this red: remove the `got.sha256Meta && sha256(...)
   !== ...` check (the body is in shape, so it would be written). */
test("(e) a sha256 metadata mismatch is quarantined", async (t) => {
  const out = tmp(t);
  const client = fakeClient([{ key: key(R2_DIR, "ep-4.json"), body: body("ep-4"), meta: sha256(Buffer.from("something else")) }]);
  const { state } = await run(client, out);
  assert.deepEqual(state.quarantined, [{ key: key(R2_DIR, "ep-4.json"), reason: "SHA_MISMATCH" }]);
  assert.equal(state.written, 0);
  assert.equal(existsSync(join(out, "normalized", LOCAL_DIR, "ep-4.json")), false);
});

/* (f) A directory the show map does not know keeps its R2 name locally and
   is reported in unmapped_dirs with its object count.
   Mutation that turns this red: drop the
   `unmapped.set(parsed.dir, ...)` line in syncR2. */
test("(f) an unmapped directory keeps its name and is listed", async (t) => {
  const out = tmp(t);
  const client = fakeClient([
    { key: key("mystery-dir", "a.json"), body: body("a") },
    { key: key("mystery-dir", "b.json"), body: body("b") },
  ]);
  const { state } = await run(client, out);
  assert.ok(existsSync(join(out, "normalized", "mystery-dir", "a.json")));
  assert.deepEqual(state.unmapped_dirs, [{ dir: "mystery-dir", objects: 2 }]);
  assert.deepEqual(state.shows["mystery-dir"], { show_id: null, via: "unmapped", bodies: 2 });
  assert.deepEqual(readState(out).unmapped_dirs, state.unmapped_dirs);
});

/* (g) The state file's bodies_expected is the number of normalized bodies on
   disk after the run: a body already on disk that R2 no longer has stays
   (nothing is deleted) and counts; a quarantined object and the ignored
   strays do not.
   Mutation that turns this red: set `bodies_expected` to
   `state.objects_seen` (4) or to `counts.written` (1) instead of summing the
   per-directory disk counts (2). */
test("(g) bodies_expected equals the normalized bodies on disk after the run", async (t) => {
  const out = tmp(t);
  const dir = join(out, "normalized", LOCAL_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gone-from-r2.json"), body("old"));
  const client = fakeClient(
    [
      { key: key(R2_DIR, "new.json"), body: body("new") },
      { key: key(R2_DIR, "broken.json"), body: JSON.stringify({ show_id: "470582", guid: "x", cues: [{ start_sec: "0", end_sec: 1, text: "t" }] }) },
    ],
    ["legacy-show/t-0123456789.json", "fingerprints/x.bin"],
  );
  await run(client, out);
  const state = readState(out);
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.deepEqual(onDisk.sort(), ["gone-from-r2.json", "new.json"]);
  assert.equal(state.objects_seen, 4);
  assert.deepEqual(state.quarantined, [{ key: key(R2_DIR, "broken.json"), reason: "BAD_SHAPE:cues[0].start_sec" }]);
  assert.equal(state.bodies_expected, onDisk.length);
  assert.equal(state.shows[LOCAL_DIR].bodies, 2);
});

/* (h) --dry-run (through parseSyncArgs) creates nothing: no body, no state
   file, not even the out directory, while still reporting what it would
   write.
   Mutation that turns this red: drop the `if (dryRun)` guard around
   writeBytesAtomic (or around writeJsonAtomic for the state file). */
test("(h) --dry-run leaves out absent", async (t) => {
  const out = join(tmp(t), "never-created");
  const args = parseSyncArgs(["--dry-run", "--out", out]);
  assert.equal(args.dryRun, true);
  const client = fakeClient([{ key: key(R2_DIR, "ep-1-abc.json"), body: BODY_A }]);
  const { state, summary } = await syncR2({ ...args, client, bucket: "bkt", showMap, commands, log: () => {} });
  assert.equal(existsSync(out), false);
  assert.equal(state.written, 1);
  assert.equal(state.bodies_expected, 1);
  assert.match(summary, /dry run, nothing written/);
});
