/* PKG-05 (docs/roadmap/corpus.md): the per-show episodes.jsonl builder over
   the synthetic fixture (fixtures/synthetic/: A has 3 episodes with vtt +
   audio and one chapters asset on 101; D has one episode with srt + json).
   Reads tracked fixture files and writes only to a tmp dir this suite
   creates; no network, no database, no credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EpisodesError, buildEpisodes, pickTranscriptAsset, writeEpisodesFile } from "./episodes.mjs";
import { jsonlRowSource } from "./row-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");

/* The chosen-feed Map is injected (buildShows returns it in the exporter);
   these are the fixture's podcast → feed ids for the English shows. */
const CHOSEN = new Map([
  [1, 11],
  [2, 12],
  [4, 14],
]);

async function episodesFor(podcastId) {
  for await (const show of buildEpisodes(jsonlRowSource(FIXTURE), { podcastIds: [podcastId], chosenFeedByPodcast: CHOSEN })) {
    if (show.podcast_id === podcastId) return show.rows;
  }
  throw new Error(`no rows for podcast ${podcastId}`);
}

/* Timed preference is vtt > srt > x-subrip > json, independent of input
   order; with no timed asset the first plain one is chosen.
   Mutation that turns this red: in episodes.mjs swap "text/vtt" and
   "application/srt" in TIMED_PREFERENCE. */
test("pickTranscriptAsset prefers vtt over srt over json, then plain", () => {
  const json = { id: 3, asset_type: "transcript", url: "j", mime_type: "application/json" };
  const srt = { id: 2, asset_type: "transcript", url: "s", mime_type: "application/srt" };
  const vtt = { id: 1, asset_type: "transcript", url: "v", mime_type: "text/vtt; charset=utf-8" };
  const plain = { id: 4, asset_type: "transcript", url: "p", mime_type: "text/plain" };
  const chapters = { id: 5, asset_type: "chapters", url: "c", mime_type: "application/json" };
  assert.equal(pickTranscriptAsset([json, plain, srt, vtt]), vtt);
  assert.equal(pickTranscriptAsset([json, plain, srt]), srt);
  assert.equal(pickTranscriptAsset([plain, json]), json);
  assert.equal(pickTranscriptAsset([plain, { ...plain, url: "p2" }]), plain);
  assert.equal(pickTranscriptAsset([chapters]), null);
  assert.equal(pickTranscriptAsset([]), null);
});

/* A: every episode has its alternate audio; only 101 has a chapters asset.
   The chapters asset is found by asset_type, not mime: D's application/json
   transcript must not become chapters_url.
   Mutation that turns this red: in episodes.mjs episodeRow pick any json
   asset as chapters — `(a) => a.asset_type === "chapters"` →
   `(a) => /json/.test(a.mime_type ?? "")` (D's json transcript becomes D's
   chapters_url). */
test("A yields 3 rows with audio; only the first episode has chapters", async () => {
  const rows = await episodesFor(1);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.audio && r.audio.url.startsWith("https://traffic.omny.fm/"), JSON.stringify(r.audio));
  const byId = Object.fromEntries(rows.map((r) => [r.corpus_episode_id, r]));
  assert.equal(byId["ep-synth-a-101"].chapters_url, "https://api.omny.fm/synthetic/a/101/chapters.json");
  assert.equal(byId["ep-synth-a-102"].chapters_url, null);
  assert.equal(byId["ep-synth-a-103"].chapters_url, null);
  assert.equal(byId["ep-synth-a-101"].audio.declared_bytes, 28800000);
  assert.equal(byId["ep-synth-a-102"].audio.declared_bytes, null);
  assert.deepEqual(byId["ep-synth-a-101"].asset_ids, [1001, 1002, 1003]);
  assert.equal(byId["ep-synth-a-101"].guid, "synthetic-guid-101");
  assert.deepEqual(byId["ep-synth-a-101"].transcript, { url: "https://api.omny.fm/synthetic/a/101/transcript.vtt", mime: "text/vtt", timed: true });
  const [d] = await episodesFor(4);
  assert.equal(d.chapters_url, null);
});

/* D's single episode carries srt + json: srt is chosen, json is the one
   alternate, and the chosen asset is not repeated among the alternates.
   Mutation that turns this red: in episodes.mjs drop the
   `.filter((a) => a !== chosen)` on transcript_alternates (length 2). */
test("D yields 1 row: srt chosen, json the only alternate, no audio", async () => {
  const rows = await episodesFor(4);
  assert.equal(rows.length, 1);
  const [d] = rows;
  assert.equal(d.transcript.mime, "application/srt");
  assert.equal(d.transcript.timed, true);
  assert.equal(d.transcript_alternates.length, 1);
  assert.deepEqual(d.transcript_alternates[0], { url: "https://transcripts.example.org/d/108.json", mime: "application/json" });
  assert.equal(d.audio, null);
  assert.equal(d.updated_at, "2026-09-10T00:08:00.000Z");
});

/* A path-shaped show key is refused before anything is written; a normal
   key lands at episodes/<safeKey(key)>.jsonl via tmp + rename (no tmp file
   left behind).
   Mutation that turns this red: in episodes.mjs writeEpisodesFile delete the
   BAD_SHOW_KEY refusal for path-shaped keys (safeKey then slugs "../x" into
   "x-<hash>.jsonl" and the write succeeds). */
test("writeEpisodesFile refuses a showKey of ../x and writes atomically otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg05-episodes-"));
  try {
    assert.throws(
      () => writeEpisodesFile(dir, "../x", [{ corpus_episode_id: "e" }]),
      (err) => err instanceof EpisodesError && err.code === "BAD_SHOW_KEY",
    );
    assert.equal(existsSync(join(dir, "episodes")), false);
    assert.deepEqual(readdirSync(dir), []);
    const path = writeEpisodesFile(dir, "111", [{ corpus_episode_id: "e2" }, { corpus_episode_id: "e1" }]);
    assert.equal(dirname(path), join(dir, "episodes"));
    assert.match(path, /[\\/]111-[0-9a-f]{10}\.jsonl$/);
    assert.equal(readFileSync(path, "utf8"), '{"corpus_episode_id":"e2"}\n{"corpus_episode_id":"e1"}\n');
    assert.deepEqual(readdirSync(join(dir, "episodes")), [path.split(/[\\/]/).pop()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Rows come out newest first (the fixture lists A's episodes oldest first).
   Mutation that turns this red: in episodes.mjs newestFirst return
   `ta - tb` instead of `tb - ta` (ascending). */
test("rows are sorted by published_at, newest first", async () => {
  const rows = await episodesFor(1);
  assert.deepEqual(rows.map((r) => r.corpus_episode_id), ["ep-synth-a-103", "ep-synth-a-102", "ep-synth-a-101"]);
  assert.deepEqual(rows.map((r) => r.published_at), ["2026-08-03T12:00:00.000Z", "2026-08-02T12:00:00.000Z", "2026-08-01T12:00:00.000Z"]);
});
