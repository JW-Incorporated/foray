/* PKG-08 (docs/roadmap/corpus.md): export.mjs end to end on the synthetic
   fixture. Every run reads tools/foraycorpus-export/fixtures/synthetic (or a
   tmp copy of it) through jsonlRowSource and writes only under tmp
   directories this suite creates. No network, no database, no credential;
   the catalogue is an empty tmp file, so data/ is not read either.

   Each test names the one-line mutation it kills, per CLAUDE.md "A green
   test is not evidence until you have broken it". The floor for this suite
   lives in test/suite-integrity.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { safeKey } from "./config.mjs";
import { showKeyOf } from "./episodes.mjs";
import { parseExportArgs, runExport, versionDirName } from "./export.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const COUNTS = JSON.parse(readFileSync(join(FIXTURE, "counts.json"), "utf8"));

function jsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function sha256sum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-export-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** English episodes counted straight from the fixture tables, not from the
    exporter: the podcasts with english_candidate_status "yes", then their
    episodes. */
function englishEpisodeCount(fixture) {
  const english = new Set(jsonl(join(fixture, "podcasts.jsonl")).filter((p) => p.english_candidate_status === "yes").map((p) => p.id));
  return jsonl(join(fixture, "episodes.jsonl")).filter((e) => english.has(e.podcast_id)).length;
}

/** One export of `fixture` into `out` at instant `iso`. Returns runExport's
    result plus the lines it logged. */
async function exportAt(tmp, { fixture = FIXTURE, out, iso, dryRun = false }) {
  const catalogPath = join(tmp, "catalog.json");
  if (!existsSync(catalogPath)) writeFileSync(catalogPath, '{"shows":[]}\n');
  const argv = ["--source", `jsonl:${fixture}`, "--out", out, "--catalog", catalogPath];
  if (dryRun) argv.push("--dry-run");
  const lines = [];
  const result = await runExport(parseExportArgs(argv), { now: () => new Date(iso), log: (l) => lines.push(l), warn: () => {} });
  return { ...result, lines };
}

const T1 = "2026-10-05T12:00:00.000Z";
const T2 = "2026-10-05T13:00:00.000Z";
const T3 = "2026-10-05T14:00:00.000Z";

/* (a) Killing mutation: count C. Replace the per-show episode count with a
   count of every `episodes` row (`counts.episodes` = 8, C's two German
   episodes included); also killed by dropping the English filter on the
   podcast id map (C then has no shows row and the run throws). */
test("a run writes shows.jsonl, one episode file per English show and a manifest whose counts are the English ones", async () => {
  await withTmp(async (tmp) => {
    const out = join(tmp, "out");
    const { versionDir, manifest, lines } = await exportAt(tmp, { out, iso: T1 });
    assert.equal(versionDir, join(out, versionDirName(T1)));

    const shows = jsonl(join(versionDir, "shows.jsonl"));
    assert.equal(manifest.counts.shows, COUNTS.podcasts_english);
    assert.equal(shows.length, COUNTS.podcasts_english);
    assert.equal(manifest.counts.episodes, englishEpisodeCount(FIXTURE));
    assert.equal(manifest.counts.episodes, 6, "A 3 + B 2 + D 1; C is German");
    assert.equal(manifest.counts.timed_transcript_episodes, COUNTS.episodes_english_timed);
    assert.equal(manifest.counts.audio_episodes, 3);
    assert.equal(manifest.counts.feeds_known, COUNTS.feeds);
    assert.equal(manifest.counts.feeds_crawled, COUNTS.feeds_crawled);
    assert.equal(manifest.overlap, null, "no --breadth, no overlap block");

    const expected = shows.map((s) => `episodes/${safeKey(String(showKeyOf(s)))}.jsonl`).sort();
    const listed = manifest.files.map((f) => f.path);
    assert.deepEqual(listed.filter((p) => p.startsWith("episodes/")).sort(), expected);
    assert.ok(listed.includes("shows.jsonl"));
    let bytes = 0;
    for (const f of manifest.files) {
      const full = join(versionDir, f.path);
      assert.equal(sha256sum(full), f.sha256, `${f.path} hash`);
      assert.equal(jsonl(full).length, f.rows, `${f.path} rows`);
      bytes += statSync(full).size;
    }
    assert.ok(bytes < 1024 * 1024, `fixture output is ${bytes} bytes; over 1 MB means rows are duplicating`);
    assert.ok(existsSync(join(versionDir, "manifest.json")));
    assert.match(lines.at(-1), /^shows=3 episodes=6 delta_added=6 delta_changed=0 out=/);
  });
});

/* (b) Killing mutation: include `built_at` inside the shows rows (write
   `showRows.map((r) => ({ ...r, built_at: builtAt }))`). The second run's
   shows.jsonl then hashes differently although nothing in the corpus moved. */
test("a second run over the same corpus is a new version with no delta and byte-identical shows.jsonl", async () => {
  await withTmp(async (tmp) => {
    const out = join(tmp, "out");
    const first = await exportAt(tmp, { out, iso: T1 });
    const second = await exportAt(tmp, { out, iso: T2 });
    assert.notEqual(second.versionDir, first.versionDir);
    assert.ok(existsSync(first.versionDir), "the first version is kept");
    assert.equal(first.manifest.delta.episodes_added, 6);
    assert.deepEqual(second.manifest.delta, { episodes_added: 0, episodes_changed: 0, shows_changed: 0 });
    const sha = (m) => m.files.find((f) => f.path === "shows.jsonl").sha256;
    assert.equal(sha(second.manifest), sha(first.manifest));
    assert.equal(sha256sum(join(second.versionDir, "shows.jsonl")), sha256sum(join(first.versionDir, "shows.jsonl")));
  });
});

/* (c) Killing mutation: ignore asset ids (pass `{ ...prevState.high_water,
   max_asset_id: Infinity }` to isChanged, or drop the asset half of
   isChanged). The fixture's episodes keep their `updated_at`, so only the new
   asset id can mark episode 102 changed. */
test("after one asset row with a higher id is appended, the next run reports exactly one changed episode", async () => {
  await withTmp(async (tmp) => {
    const fixture = join(tmp, "fixture");
    cpSync(FIXTURE, fixture, { recursive: true });
    const out = join(tmp, "out");
    await exportAt(tmp, { fixture, out, iso: T1 });
    await exportAt(tmp, { fixture, out, iso: T2 });
    const maxId = Math.max(...jsonl(join(fixture, "assets.jsonl")).map((a) => a.id));
    appendFileSync(
      join(fixture, "assets.jsonl"),
      JSON.stringify({ id: maxId + 1, owner_type: "episode", owner_id: 102, asset_type: "transcript", url: "https://api.omny.fm/synthetic/a/102/transcript.txt", mime_type: "text/plain", language: "en-us", relation: null, declared_byte_length: null }) + "\n",
    );
    const third = await exportAt(tmp, { fixture, out, iso: T3 });
    assert.deepEqual(third.manifest.delta, { episodes_added: 0, episodes_changed: 1, shows_changed: 1 });
    assert.equal(third.manifest.high_water.max_asset_id, maxId + 1);
    assert.match(third.lines.at(-1), /delta_added=0 delta_changed=1 /);
  });
});

/* (d) Killing mutation: write state on a dry run (call writeState before the
   dry-run return). Anything created under outRoot, state.json included,
   makes the directory exist. */
test("--dry-run prints the manifest and leaves outRoot absent", async () => {
  await withTmp(async (tmp) => {
    const out = join(tmp, "out");
    const { versionDir, manifest, lines } = await exportAt(tmp, { out, iso: T1, dryRun: true });
    assert.equal(existsSync(out), false, "nothing may be created under outRoot on a dry run");
    assert.equal(versionDir, null);
    assert.equal(manifest.counts.shows, COUNTS.podcasts_english);
    assert.deepEqual(JSON.parse(lines[0]), manifest, "the manifest is printed");
    assert.match(lines.at(-1), /^shows=3 episodes=6 .*dry run, nothing written/);
  });
});

/* (e) Killing mutation: write latest first (move writeLatest above the
   staging rename; it then finds no manifest and the run throws). Also pins
   the Windows-safe mapping: export_version keeps its ':' and the directory
   name has none. */
test("latest.json's export_version is the exact ISO instant of the newest version directory", async () => {
  await withTmp(async (tmp) => {
    const out = join(tmp, "out");
    await exportAt(tmp, { out, iso: T1 });
    await exportAt(tmp, { out, iso: T2 });
    const dirs = readdirSync(out, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    assert.deepEqual(dirs, [versionDirName(T1), versionDirName(T2)], "two versions, no staging debris");
    const newest = dirs.at(-1);
    assert.ok(!newest.includes(":"), "no ':' in a directory name (NTFS)");
    const latest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(latest.export_version, T2);
    assert.equal(versionDirName(latest.export_version), newest);
    assert.equal(latest.manifest_path, `${newest}/manifest.json`);
    assert.equal(JSON.parse(readFileSync(join(out, latest.manifest_path), "utf8")).export_version, T2);
    assert.equal(JSON.parse(readFileSync(join(out, "state.json"), "utf8")).last_export_version, T2);
  });
});
