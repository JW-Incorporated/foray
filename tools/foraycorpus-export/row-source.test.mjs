/* PKG-02 (docs/roadmap/corpus.md): the JSONL row source over the synthetic
   fixture. Reads only tracked fixture files and a tmp dir this suite writes;
   no network, no database, no credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TABLES, RowSourceError, jsonlRowSource } from "./row-source.mjs";
import { isTimedMime } from "./mimes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const COUNTS = JSON.parse(readFileSync(join(FIXTURE, "counts.json"), "utf8"));

async function collect(source, table) {
  const out = [];
  for await (const row of source.rows(table)) out.push(row);
  return out;
}

/* The fixture README's "Files and columns" table is the record of how many
   rows each file holds; every table in TABLES must appear there and match.
   Mutation that turns this red: delete the last line of
   fixtures/synthetic/assets.jsonl. */
test("every table yields the row count the fixture README records", async () => {
  const readme = readFileSync(join(FIXTURE, "README.md"), "utf8");
  const recorded = {};
  for (const m of readme.matchAll(/^\| `(\w+)\.jsonl` \| (\d+) \|/gm)) recorded[m[1]] = Number(m[2]);
  assert.deepEqual(Object.keys(recorded).sort(), [...TABLES].sort());
  const source = jsonlRowSource(FIXTURE);
  assert.deepEqual(await source.counts(), recorded);
  assert.equal(source.kind, "jsonl");
  assert.equal(source.describe(), `jsonl:${FIXTURE}`);
});

/* A corrupt row must stop the export with a pointer to the exact line, not
   be skipped (a silently short export reads as a real catalogue shrink).
   Line numbers are physical lines, so the blank line 2 still counts.
   Mutation that turns this red: in row-source.mjs replace
   `throw new RowSourceError("MALFORMED_ROW", ...)` with `continue`. */
test("a malformed line throws MALFORMED_ROW naming file and line number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg02-rowsrc-"));
  try {
    writeFileSync(join(dir, "podcasts.jsonl"), '{"id":1}\n\n{"id":2,\n{"id":3}\n');
    const source = jsonlRowSource(dir);
    const seen = [];
    await assert.rejects(
      (async () => {
        for await (const row of source.rows("podcasts")) seen.push(row.id);
      })(),
      (err) => {
        assert.ok(err instanceof RowSourceError);
        assert.equal(err.code, "MALFORMED_ROW");
        assert.ok(err.message.endsWith(`${join(dir, "podcasts.jsonl")}:3`), err.message);
        return true;
      },
    );
    assert.deepEqual(seen, [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A typo in a table name must not read as "this table is empty".
   Mutation that turns this red: in row-source.mjs replace the UNKNOWN_TABLE
   throw with `return;`. */
test("an unknown table throws UNKNOWN_TABLE", async () => {
  const source = jsonlRowSource(FIXTURE);
  await assert.rejects(collect(source, "podcast"), (err) => {
    assert.ok(err instanceof RowSourceError);
    assert.equal(err.code, "UNKNOWN_TABLE");
    return true;
  });
});

/* The headline counts are DISTINCT EPISODES of English podcasts, recomputed
   from the rows with the package's own classifier. D has two timed assets
   (srt + json) on one episode, so counting assets gives 5, not 4.
   Mutations that turn this red: set "episodes_english_timed":5 in
   fixtures/synthetic/counts.json (the asset count, not distinct episodes); or
   in mimes.mjs make isTimedMime return `classifyTranscriptMime(raw) !== "other"`
   (B's plain episodes then count as timed: 6). */
test("episodes_english_timed and _timed_audio recompute from the rows", async () => {
  const source = jsonlRowSource(FIXTURE);
  const english = new Set((await collect(source, "podcasts")).filter((p) => p.english_candidate_status === "yes").map((p) => p.id));
  const podcastOf = new Map((await collect(source, "episodes")).map((e) => [e.id, e.podcast_id]));
  const timed = new Set();
  const audio = new Set();
  for (const a of await collect(source, "assets")) {
    if (a.owner_type !== "episode" || !english.has(podcastOf.get(a.owner_id))) continue;
    if (isTimedMime(a.mime_type)) timed.add(a.owner_id);
    if (a.asset_type === "alternate" && typeof a.mime_type === "string" && a.mime_type.startsWith("audio/")) audio.add(a.owner_id);
  }
  const timedAudio = [...timed].filter((id) => audio.has(id));
  assert.equal(timed.size, COUNTS.episodes_english_timed);
  assert.equal(timedAudio.length, COUNTS.episodes_english_timed_audio);
});

/* The plain totals in counts.json agree with the files.
   Mutation that turns this red: change "assets":13 to "assets":12 in
   fixtures/synthetic/counts.json. */
test("assets, episodes, podcasts and feed totals equal counts.json", async () => {
  const source = jsonlRowSource(FIXTURE);
  const podcasts = await collect(source, "podcasts");
  const feeds = await collect(source, "podcast_feeds");
  assert.equal((await collect(source, "assets")).length, COUNTS.assets);
  assert.equal((await collect(source, "episodes")).length, COUNTS.episodes);
  assert.equal(podcasts.length, COUNTS.podcasts);
  assert.equal(podcasts.filter((p) => p.english_candidate_status === "yes").length, COUNTS.podcasts_english);
  assert.equal(feeds.length, COUNTS.feeds);
  assert.equal(feeds.filter((f) => f.last_success_at != null).length, COUNTS.feeds_crawled);
});
