/* PKG-06 (docs/roadmap/corpus.md): manifest.mjs (file list with sha256,
   source counts, the atomic latest.json pointer) and delta.mjs (high-water
   mark, isChanged). Reads the tracked synthetic fixture and writes only to tmp
   dirs this suite creates; no network, no database, no credential.

   Importing manifest.mjs / delta.mjs pulls in
   tools/segments/sweep-transcripts.mjs for writeJsonAtomic. That module's CLI
   is guarded by `isEntryScript(import.meta.url)` (tools/ci/entry.mjs), so
   the import runs no sweep and opens no connection: this suite importing it
   at all is the check the card asks for ("verify by importing in the test"). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeHighWater, isChanged } from "./delta.mjs";
import { ManifestError, buildManifest, computeSourceCounts, writeLatest } from "./manifest.mjs";
import { jsonlRowSource } from "./row-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");

function sha256sum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-manifest-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A version directory with shows.jsonl + two episode files, its manifest
    written to manifest.json. Returns the manifest. */
async function writeVersion(outRoot, version) {
  const dir = join(outRoot, version);
  mkdirSync(join(dir, "episodes"), { recursive: true });
  writeFileSync(join(dir, "shows.jsonl"), '{"corpus_podcast_id":"pod-synth-a"}\n{"corpus_podcast_id":"pod-synth-b"}\n');
  writeFileSync(join(dir, "episodes", "111.jsonl"), '{"corpus_episode_id":"ep-synth-a-101"}\n');
  writeFileSync(join(dir, "episodes", "pod-synth-b.jsonl"), '{"corpus_episode_id":"ep-synth-b-104"}\n');
  const manifest = await buildManifest({
    exportVersion: version,
    builtAt: "2026-10-01T00:00:00.000Z",
    source: jsonlRowSource(FIXTURE),
    dir,
    files: [
      { path: "shows.jsonl", rows: 2 },
      { path: "episodes/111.jsonl", rows: 1 },
      { path: "episodes/pod-synth-b.jsonl", rows: 1 },
    ],
    counts: { shows: 2, episodes: 2 },
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/* Every listed file carries its byte size and the sha256 of its BYTES,
   computed here independently (whole-file createHash, not the module's
   streaming hasher).
   Mutation that turns this red: in manifest.mjs buildManifest hash the path
   string — `sha256: await hashFile(full)` →
   `sha256: createHash("sha256").update(full).digest("hex")`. */
test("buildManifest lists every file with the sha256 of its bytes", async () => {
  await withTmp(async (outRoot) => {
    const m = await writeVersion(outRoot, "v1");
    assert.deepEqual(
      m.files.map((f) => f.path),
      ["shows.jsonl", "episodes/111.jsonl", "episodes/pod-synth-b.jsonl"],
    );
    for (const f of m.files) {
      const full = join(outRoot, "v1", f.path);
      assert.equal(f.sha256, sha256sum(full), f.path);
      assert.equal(f.bytes, readFileSync(full).length, f.path);
    }
    assert.equal(m.source.kind, "jsonl");
    assert.deepEqual(Object.keys(m.counts), ["shows", "episodes", "timed_transcript_episodes", "audio_episodes", "feeds_known", "feeds_crawled", "inserts_30d"]);
  });
});

/* A file whose bytes change after the manifest was built (same length, so a
   size check alone would pass) must stop the pointer: writeLatest re-hashes.
   Mutation that turns this red: in manifest.mjs writeLatest skip the re-hash —
   `if (sha !== f.sha256 || statSync(full).size !== f.bytes)` →
   `if (statSync(full).size !== f.bytes)`. */
test("writeLatest refuses when a listed file changed after hashing", async () => {
  await withTmp(async (outRoot) => {
    await writeVersion(outRoot, "v1");
    const shows = join(outRoot, "v1", "shows.jsonl");
    const body = readFileSync(shows, "utf8");
    writeFileSync(shows, body.replace("pod-synth-b", "pod-synth-x"));
    await assert.rejects(
      writeLatest(outRoot, { export_version: "v1", manifest_path: "v1/manifest.json", built_at: "2026-10-01T00:00:00.000Z" }),
      (e) => e instanceof ManifestError && e.code === "FILE_MISMATCH" && /shows\.jsonl/.test(e.message),
    );
    assert.equal(existsSync(join(outRoot, "latest.json")), false);

    // Control: with the bytes restored the same call writes the pointer.
    writeFileSync(shows, body);
    await writeLatest(outRoot, { export_version: "v1", manifest_path: "v1/manifest.json", built_at: "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(JSON.parse(readFileSync(join(outRoot, "latest.json"), "utf8")), {
      export_version: "v1",
      manifest_path: "v1/manifest.json",
      built_at: "2026-10-01T00:00:00.000Z",
    });
  });
});

/* A failing rename leaves neither latest.json nor its tmp file behind
   (the rename seam throws a non-lock error, so writeJsonAtomic does not
   retry).
   Mutation that turns this red: in manifest.mjs writeLatest write directly —
   `writeJsonAtomic(latest, {...}, options)` →
   `writeFileSync(latest, JSON.stringify({ export_version, manifest_path, built_at }))`
   with `writeFileSync` added to the node:fs import (latest.json exists and
   nothing throws). */
test("latest.json is absent and the tmp file cleaned when the write throws", async () => {
  await withTmp(async (outRoot) => {
    await writeVersion(outRoot, "v1");
    const failingRename = () => {
      throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
    };
    await assert.rejects(
      writeLatest(outRoot, { export_version: "v1", manifest_path: "v1/manifest.json", built_at: "2026-10-01T00:00:00.000Z" }, { rename: failingRename }),
      /simulated rename failure/,
    );
    assert.equal(existsSync(join(outRoot, "latest.json")), false);
    assert.deepEqual(readdirSync(outRoot).filter((n) => n.startsWith("latest")), []);
  });
});

function fakeSource(tables) {
  return {
    kind: "fake",
    async *rows(table) {
      for (const r of tables[table] ?? []) yield r;
    },
    describe: () => "fake",
  };
}

/* Strictly newer on either half; a row AT the mark is unchanged; a null
   updated_at (row or mark) is false, not a throw, on both isChanged and
   computeHighWater (episodes.updated_at is ASSUMED until PKG-03).
   Mutation that turns this red: in delta.mjs isChanged
   `rowT > hwT` → `rowT >= hwT` (the at-the-mark row reads as changed). */
test("isChanged: newer updated_at or newer asset id; null updated_at is false, never a throw", async () => {
  const hw = await computeHighWater(jsonlRowSource(FIXTURE));
  assert.deepEqual(hw, { max_asset_id: 1013, max_episode_updated_at: "2026-09-10T00:08:00.000Z" });

  assert.equal(isChanged({ updated_at: "2026-09-10T00:09:00Z", asset_ids: [1001] }, hw), true);
  assert.equal(isChanged({ updated_at: "2026-09-10T00:01:00Z", asset_ids: [1001, 1014] }, hw), true);
  // At the mark on both halves, written in the other ISO spelling.
  assert.equal(isChanged({ updated_at: "2026-09-10T00:08:00Z", asset_ids: [1013] }, hw), false);
  assert.equal(isChanged({ updated_at: "2026-09-10T00:01:00.000Z", asset_ids: [1001, 1002] }, hw), false);
  assert.equal(isChanged({ updated_at: null, asset_ids: [1001] }, hw), false);
  assert.equal(isChanged({ updated_at: null }, { max_asset_id: 0, max_episode_updated_at: null }), false);
  assert.equal(isChanged({ updated_at: "2026-09-10T00:09:00Z", asset_ids: [] }, { max_asset_id: 5, max_episode_updated_at: null }), false);

  const noUpdated = await computeHighWater(
    fakeSource({
      assets: [{ id: "7" }, { id: 3 }],
      episodes: [{ id: 1, updated_at: null }, { id: 2 }],
    }),
  );
  assert.deepEqual(noUpdated, { max_asset_id: 7, max_episode_updated_at: null });
});

/* inserts_30d counts episodes at or after built_at - 30 d by updated_at,
   falling back to source_published_at; the boundary instant counts.
   feeds_known / feeds_crawled come from the synthetic feeds (4 / 2).
   Mutation that turns this red: in manifest.mjs computeSourceCounts
   `t >= windowStart` → `t > windowStart` (the boundary row drops out). */
test("computeSourceCounts: inserts_30d counts only the 30-day window", async () => {
  const feeds = [];
  for await (const f of jsonlRowSource(FIXTURE).rows("podcast_feeds")) feeds.push(f);
  const source = fakeSource({
    podcast_feeds: feeds,
    episodes: [
      { id: 1, updated_at: "2026-09-01T00:00:00Z", source_published_at: "2020-01-01T00:00:00Z" }, // boundary: in
      { id: 2, updated_at: "2026-08-31T23:59:59Z", source_published_at: "2026-09-20T00:00:00Z" }, // updated_at wins: out
      { id: 3, updated_at: null, source_published_at: "2026-09-15T00:00:00Z" }, // fallback: in
      { id: 4, updated_at: null, source_published_at: null }, // undated: out, no throw
      { id: 5, updated_at: "2026-09-30T12:00:00Z", source_published_at: null }, // in
    ],
  });
  assert.deepEqual(await computeSourceCounts(source, { builtAt: "2026-10-01T00:00:00Z" }), { feeds_known: 4, feeds_crawled: 2, inserts_30d: 3 });
});
