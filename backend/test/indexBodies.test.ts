import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { main, parseIndexBodiesArgs, type IndexBodiesResult } from "../src/cli/indexBodies";
import { reconcileCorpus } from "../src/cli/warmTranscriptIndex";
import {
  cuesFromBodyJson,
  FileTranscriptCueProvider,
  locateInListing,
  type TranscriptDigestEntry
} from "../src/generation/transcriptArchiveLookup";
import { cutPassages, type Passage } from "../src/generation/passageCutter";
import { corpusSafeKey, scanNormalizedCorpus } from "../src/generation/transcriptCorpus";
import { FileTranscriptTextIndex, showIndexCacheFile } from "../src/generation/transcriptTextIndex";

/**
 * GV-05 (docs/roadmap/generation-v2.md, from W3-04): the per-show BM25 cache
 * built from a STREAM of bodies must be the cache `FileTranscriptTextIndex`
 * builds from a local mirror — same docs in the same order, same postings —
 * so an index assembled on another box is byte-compatible and judged fresh.
 *
 * The synthetic corpus carries every case the card names: a committed-style row
 * whose guid differs from the body's own guid (Becker's: permalink in the row,
 * slug in the body), a body found only by the guid it records (a file name the
 * writer's key does not produce), a letter-spaced cue and a cue whose end is
 * before its start, plus a body with no cues and a committed row with no body.
 */

const SHOW_A = "gv5-show-alpha";
const SHOW_B = "gv5-show-beta";
const PERMALINK = "https://example.com/podcast/ep-1-the-permalink-guid/";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv05-index-bodies-"));
const corpus = path.join(tmp, "normalized");
const committedDigest = path.join(tmp, "committed-digests.json");
const emptyFeeds = path.join(tmp, "feeds");

type Cue = { text: string; start_sec: number; end_sec: number };
const cue = (text: string, start: number, end: number): Cue => ({ text, start_sec: start, end_sec: end });

function writeBody(showDir: string, fileName: string, body: unknown): void {
  const dir = path.join(corpus, showDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(body), "utf8");
}

const committedRows: TranscriptDigestEntry[] = [
  { show_id: SHOW_A, show_title: "Alpha", guid: PERMALINK, title: "Episode one", cues: 3 },
  { show_id: SHOW_A, show_title: "Alpha", guid: "a2", title: "Episode two", cues: 2 },
  { show_id: SHOW_B, show_title: "Beta", guid: "b1", title: "Beta one", cues: 1 },
  /* A committed row with no body on this machine: walked, never a doc. */
  { show_id: SHOW_B, show_title: "Beta", guid: "b3", title: "Beta three", cues: 4 }
];

beforeAll(() => {
  const dirA = `${SHOW_A}-0123456789`;
  const dirB = `${SHOW_B}-abcdef0123`;
  /* Named by the ROW's guid, recording the SLUG: Becker's case. */
  writeBody(dirA, `${corpusSafeKey(PERMALINK)}.json`, {
    show_id: SHOW_A,
    guid: "ep-1-the-permalink-guid",
    cues: [
      cue("T r a n s c r i p t - E p i s o d e # 5 9 5", 0, 4),
      cue("semmelweis washed his hands before the delivery ward", 4, 9),
      cue("miasma theory backwards timing", 12, 10)
    ]
  });
  writeBody(dirA, `${corpusSafeKey("a2")}.json`, {
    show_id: SHOW_A,
    guid: "a2",
    cues: [cue("pasteur and the swan neck flask experiment", 0, 6), cue("germ theory replaced miasma", 6, 9)]
  });
  /* Not in the committed digests, and under a name no key rule produces: only
     the guid the body records finds it. */
  writeBody(dirA, "old-name-a3.json", {
    show_id: SHOW_A,
    guid: "Buzzsprout-777",
    cues: [cue("cholera maps of the broad street pump", 0, 5)]
  });
  writeBody(dirA, `${corpusSafeKey("a4")}.json`, {
    show_id: SHOW_A,
    guid: "a4",
    cues: [cue("lister carbolic acid antiseptic surgery", 0, 7), cue("surgery deaths fell", 7, 9)]
  });
  /* No cues: never a row, never a doc. */
  writeBody(dirA, `${corpusSafeKey("a5")}.json`, { show_id: SHOW_A, guid: "a5", cues: [] });
  /* Claimed by the guid it records though its file name is no committed key:
     a reconcile adds no row for it. */
  writeBody(dirA, "copy-of-a2.json", { show_id: SHOW_A, guid: "a2", cues: [cue("a duplicate copy of episode two", 0, 3)] });
  writeBody(dirB, `${corpusSafeKey("b1")}.json`, {
    show_id: SHOW_B,
    guid: "b1",
    cues: [cue("plate tectonics and banded iron formations", 0, 8)]
  });
  writeBody(dirB, `${corpusSafeKey("b2")}.json`, {
    show_id: SHOW_B,
    guid: "b2",
    cues: [cue("the constructor of the toothpaste box", 0, 4), cue("__proto__ spoken aloud", 4, 6)]
  });
  fs.writeFileSync(committedDigest, JSON.stringify({ transcripts: committedRows }), "utf8");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The stream a corpus box would send: every body of a show, then end-show. */
function streamLines(options: { endShows?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const show of scanNormalizedCorpus(corpus)) {
    const dir = path.join(corpus, show.dirName);
    for (const fileName of fs.readdirSync(dir)) {
      const full = path.join(dir, fileName);
      const stat = fs.statSync(full);
      const body = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;
      lines.push(JSON.stringify({ kind: "body", show_id: show.showId, fileName, stat: { mtimeMs: stat.mtimeMs, size: stat.size }, body }));
    }
    if (options.endShows !== false) lines.push(JSON.stringify({ kind: "end-show", show_id: show.showId }));
  }
  return lines;
}

function sink(): { stream: Writable; text: () => string } {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    }
  });
  return { stream, text: () => out };
}

async function runIndexBodies(
  lines: string[],
  root: string,
  archive: readonly TranscriptDigestEntry[] = committedRows,
  passagesOut: string | null = null
): Promise<{ result: IndexBodiesResult; out: string; indexRoot: string; stagedOut: string }> {
  const indexRoot = path.join(root, "index");
  const stagedOut = path.join(root, "passage-index", "staged-digest.jsonl");
  const out = sink();
  const result = await main(Readable.from(lines.map((l) => `${l}\n`)), out.stream, {
    indexRoot,
    stagedOut,
    archive,
    committedDigests: [committedDigest],
    showTitle: (showId) => showId,
    passagesOut
  });
  return { result, out: out.text(), indexRoot, stagedOut };
}

async function offlineReconcileRows(): Promise<TranscriptDigestEntry[]> {
  return (await reconcileCorpus({ offline: true, onlyShows: [], normalizedRoot: corpus, committedDigests: [committedDigest], feedCacheDir: emptyFeeds }))
    .rows;
}

function readCache(indexRoot: string, showId: string): { raw: string; json: Record<string, unknown> } {
  const raw = fs.readFileSync(showIndexCacheFile(indexRoot, showId), "utf8");
  return { raw, json: JSON.parse(raw) as Record<string, unknown> };
}

function withoutBuiltAt(raw: string): string {
  return raw.replace(/"builtAt":"[^"]*"/, '"builtAt":""');
}

describe("indexBodies — the streamed cache is the cache FileTranscriptTextIndex builds (GV-05)", () => {
  it("parity: for two shows, the streamed cache deep-equals (and byte-equals, save builtAt) the local build over the reconciled archive", async () => {
    /* MUTATIONS THAT KILL THIS: in indexBodies.ts put the new rows BEFORE the
       archive rows (doc order changes); count terms over the raw body cues
       instead of cuesFromBodyJson's (the letter-spaced and backwards cues
       become postings); map rows with corpusSafeKey only instead of
       locateInListing (Buzzsprout-777 is never found). */
    // The scanNormalizedCorpus prefix rule treats the show dir by its id: sanity.
    expect(scanNormalizedCorpus(corpus).map((s) => s.showId).sort()).toEqual([SHOW_A, SHOW_B]);
    const streamed = await runIndexBodies(streamLines(), path.join(tmp, "streamed"));
    expect(streamed.result.exitCode).toBe(0);

    const archive = [...committedRows, ...(await offlineReconcileRows())];
    const localRoot = path.join(tmp, "local-index");
    const local = new FileTranscriptTextIndex({ archive, bodies: new FileTranscriptCueProvider(corpus), indexRoot: localRoot });
    for (const showId of [SHOW_A, SHOW_B]) {
      expect(local.warmShow(showId)).not.toBeNull();
      const a = readCache(streamed.indexRoot, showId);
      const b = readCache(localRoot, showId);
      expect({ ...a.json, builtAt: "" }).toEqual({ ...b.json, builtAt: "" });
      expect(withoutBuiltAt(a.raw)).toBe(withoutBuiltAt(b.raw));
    }
  });

  it("maps a committed row whose guid differs from its body's to that body, finds a body by its recorded guid, and drops junk cues", async () => {
    /* MUTATION THAT KILLS THIS: in locateInListing, drop the last-resort scan of
       recorded guids (return null after the prefix loop) — Buzzsprout-777 is no
       doc, here and in the provider alike, which parity alone cannot see. */
    const { indexRoot } = await runIndexBodies(streamLines(), path.join(tmp, "mapping"));
    const alpha = readCache(indexRoot, SHOW_A).json as { docs: Array<{ guid: string; length: number }>; postings: Record<string, unknown> };
    expect(alpha.docs.map((d) => d.guid)).toEqual([PERMALINK, "a2", "a4", "Buzzsprout-777"]);
    /* Episode one counts its one good cue and nothing from the backwards one
       ("miasma" is still a term: episode two says it). */
    expect(Object.hasOwn(alpha.postings, "semmelweis")).toBe(true);
    expect(Object.hasOwn(alpha.postings, "backwards")).toBe(false);
    expect(Object.hasOwn(alpha.postings, "timing")).toBe(false);
    const beta = readCache(indexRoot, SHOW_B).json as { docs: Array<{ guid: string }>; postings: Record<string, unknown> };
    expect(beta.docs.map((d) => d.guid)).toEqual(["b1", "b2"]);
  });

  it("after a streamed build, FileTranscriptTextIndex over the same files finds the cache fresh and never rebuilds it", async () => {
    /* MUTATION THAT KILLS THIS: record a stat other than the one streamed
       (e.g. size + 1, or mtimeMs from Date.now()) in keepBody — cacheIsFresh
       refuses the cache and the search re-reads every body. */
    const { indexRoot } = await runIndexBodies(streamLines(), path.join(tmp, "fresh"));
    const before = fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8");
    const archive = [...committedRows, ...(await offlineReconcileRows())];
    const provider = new FileTranscriptCueProvider(corpus);
    const spy = vi.spyOn(provider, "readCuesUncached");
    const index = new FileTranscriptTextIndex({ archive, bodies: provider, indexRoot });
    const hits = index.search("semmelweis washed hands delivery ward pasteur cholera");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entry.guid).toBe(PERMALINK);
    index.warmShow(SHOW_B);
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8")).toBe(before);
  });

  it("stages exactly the rows reconcileCorpus({offline: true}) produces for the same bodies, and writes no body text", async () => {
    /* MUTATION THAT KILLS THIS: in pendingCorpusRows, drop the recorded-guid
       claim test (only the file-name test remains) — copy-of-a2.json is staged
       as a second "a2" row. The explicit guid list catches it even though the
       reconcile shares the core. */
    const { stagedOut, indexRoot } = await runIndexBodies(streamLines(), path.join(tmp, "staged"));
    const staged = fs
      .readFileSync(stagedOut, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as TranscriptDigestEntry);
    expect(staged).toEqual(await offlineReconcileRows());
    expect(staged.map((r) => `${r.show_id}/${r.guid}`)).toEqual([`${SHOW_A}/a4`, `${SHOW_A}/Buzzsprout-777`, `${SHOW_B}/b2`]);
    expect(staged.every((r) => r.title === r.guid && r.enclosure_url === undefined)).toBe(true);
    const stagedText = fs.readFileSync(stagedOut, "utf8");
    expect(stagedText).not.toContain("broad street pump");
    expect(fs.readdirSync(indexRoot).sort()).toEqual([`${SHOW_A}.json`, `${SHOW_B}.json`]);
  });

  it("on a box that has already reconciled (the archive already holds the pending rows), builds no duplicate docs, stays fresh, and still stages the rows", async () => {
    /* This is the production case: loadTranscriptArchive() merges data-local's
       corpus digest, so after any earlier reconcile every pending row is
       already an archive row.
       MUTATION THAT KILLS THIS: in indexBodies.ts delete
       `if (seen.has(row.guid)) continue;` — a4, Buzzsprout-777 and b2 are
       appended a second time, the doc count no longer matches the reader's,
       and cacheIsFresh rebuilds the cache on every read. */
    const reconciled = await offlineReconcileRows();
    const archive = [...committedRows, ...reconciled];
    const { result, indexRoot, stagedOut } = await runIndexBodies(streamLines(), path.join(tmp, "reconciled"), archive);
    expect(result.exitCode).toBe(0);

    // 1) Byte-equal to the local build over that same archive, no duplicate docs.
    const localRoot = path.join(tmp, "reconciled-local-index");
    const local = new FileTranscriptTextIndex({ archive, bodies: new FileTranscriptCueProvider(corpus), indexRoot: localRoot });
    for (const showId of [SHOW_A, SHOW_B]) {
      expect(local.warmShow(showId)).not.toBeNull();
      expect(withoutBuiltAt(readCache(indexRoot, showId).raw)).toBe(withoutBuiltAt(readCache(localRoot, showId).raw));
    }
    const alpha = readCache(indexRoot, SHOW_A).json as { docs: Array<{ guid: string }> };
    expect(alpha.docs.map((d) => d.guid)).toEqual([PERMALINK, "a2", "a4", "Buzzsprout-777"]);
    const beta = readCache(indexRoot, SHOW_B).json as { docs: Array<{ guid: string }> };
    expect(beta.docs.map((d) => d.guid)).toEqual(["b1", "b2"]);

    // 2) A reader over that archive finds the streamed caches fresh.
    const provider = new FileTranscriptCueProvider(corpus);
    const spy = vi.spyOn(provider, "readCuesUncached");
    const reader = new FileTranscriptTextIndex({ archive, bodies: provider, indexRoot });
    expect(reader.search("lister carbolic antiseptic cholera broad street").length).toBeGreaterThan(0);
    reader.warmShow(SHOW_B);
    expect(spy).not.toHaveBeenCalled();

    // 3) The staged rows are still exactly the offline reconcile's.
    const staged = fs
      .readFileSync(stagedOut, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as TranscriptDigestEntry);
    expect(staged).toEqual(reconciled);
  });

  it("a show the stream never ends is not written, and the run reports it", async () => {
    /* MUTATION THAT KILLS THIS: flush every open show at end of input as if it
       had ended — a cache over a possibly partial show gets written. */
    const { result, out, indexRoot } = await runIndexBodies(streamLines({ endShows: false }), path.join(tmp, "partial"));
    expect(result.exitCode).toBe(1);
    expect(result.shows).toEqual([]);
    expect(fs.existsSync(indexRoot)).toBe(false);
    expect(out).toContain(`${SHOW_A}: stream ended before its end-show record`);
  });

  it("rejects malformed records without stopping the stream, and prints a summary line per show", async () => {
    const lines = ["not json", JSON.stringify({ kind: "body", show_id: SHOW_A, fileName: "../escape.json", stat: { mtimeMs: 1, size: 1 }, body: {} }), ...streamLines()];
    const { result, out } = await runIndexBodies(lines, path.join(tmp, "malformed"));
    expect(result.exitCode).toBe(1);
    expect(result.problems).toHaveLength(2);
    expect(result.shows.map((s) => [s.showId, s.docs, s.staged])).toEqual([
      [SHOW_A, 4, 2],
      [SHOW_B, 2, 1]
    ]);
    expect(out).toMatch(new RegExp(`${SHOW_A}: 6 bodies, 4 of 4 rows indexed, \\+2 staged`));
  });

  it("parses --index-root and --staged-out, defaulting under data-local", () => {
    const d = parseIndexBodiesArgs([]);
    expect(d.indexRoot.replace(/\\/g, "/")).toMatch(/data-local\/transcripts\/index$/);
    expect(d.stagedOut.replace(/\\/g, "/")).toMatch(/data-local\/passage-index\/staged-digest\.jsonl$/);
    const e = parseIndexBodiesArgs(["--index-root", "x/idx", "--staged-out", "y/s.jsonl"]);
    expect(e.indexRoot).toBe(path.resolve("x/idx"));
    expect(e.stagedOut).toBe(path.resolve("y/s.jsonl"));
    /* GV-12: no passages unless asked for. */
    expect(d.passagesOut).toBeNull();
    expect(e.passagesOut).toBeNull();
    expect(parseIndexBodiesArgs(["--passages-out", "z/p.jsonl"]).passagesOut).toBe(path.resolve("z/p.jsonl"));
  });

  it("--passages-out (GV-12): appends each mapped body's passages keyed by the ARCHIVE guid, in row order, and leaves the caches unchanged", async () => {
    /* MUTATION THAT KILLS THIS: key the passages by the body's own recorded
       guid (kept.bodyGuid) instead of the archive row's — episode one's
       passage carries "ep-1-the-permalink-guid", which no archive row has. */
    const root = path.join(tmp, "passages");
    const passagesOut = path.join(root, "passage-index", "passages.jsonl");
    const readPassages = (): Passage[] =>
      fs
        .readFileSync(passagesOut, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Passage);
    const { result, out, indexRoot } = await runIndexBodies(streamLines(), root, committedRows, passagesOut);
    expect(result.exitCode).toBe(0);
    const rows = readPassages();
    expect(rows.map((p) => `${p.show_id}/${p.guid}`)).toEqual([
      `${SHOW_A}/${PERMALINK}`,
      `${SHOW_A}/a2`,
      `${SHOW_A}/a4`,
      `${SHOW_A}/Buzzsprout-777`,
      `${SHOW_B}/b1`,
      `${SHOW_B}/b2`
    ]);
    expect(result.shows.map((s) => s.passages)).toEqual([4, 2]);
    expect(out).toContain(", 4 passages\n");
    /* Each row is the cutter's output over the body's filtered cues, keyed by
       the archive guid: the letter-spaced and backwards cues are not in
       episode one's text. */
    const bodyOf = (fileName: string): unknown => JSON.parse(fs.readFileSync(path.join(corpus, `${SHOW_A}-0123456789`, fileName), "utf8"));
    const one = cutPassages({ show_id: SHOW_A, guid: PERMALINK }, cuesFromBodyJson(bodyOf(`${corpusSafeKey(PERMALINK)}.json`))!);
    expect(rows[0]).toEqual(one[0]);
    expect(rows[0]!.text).toBe("semmelweis washed his hands before the delivery ward");
    const buzz = cutPassages({ show_id: SHOW_A, guid: "Buzzsprout-777" }, cuesFromBodyJson(bodyOf("old-name-a3.json"))!);
    expect(rows[3]).toEqual(buzz[0]);
    /* A second run appends the same rows with the same ids. */
    await runIndexBodies(streamLines(), path.join(root, "again"), committedRows, passagesOut);
    expect(readPassages().slice(rows.length)).toEqual(rows);
    /* The caches are the ones a run without the flag writes, and that run
       says nothing of passages. */
    const plain = await runIndexBodies(streamLines(), path.join(root, "plain"));
    expect(plain.out).not.toContain("passages");
    expect(plain.result.shows.map((s) => s.passages)).toEqual([0, 0]);
    for (const showId of [SHOW_A, SHOW_B]) {
      expect(withoutBuiltAt(readCache(indexRoot, showId).raw)).toBe(withoutBuiltAt(readCache(plain.indexRoot, showId).raw));
    }
  });
});

describe("the shared reading and locating rules, now exported (GV-05 refactor)", () => {
  it("cuesFromBodyJson skips bad timings and letter-spaced cues, and answers null for a body with nothing usable", () => {
    /* MUTATION THAT KILLS THIS: drop `end < start` from the timing filter. */
    const cues = cuesFromBodyJson({
      cues: [cue("T r a n s c r i p t", 0, 2), cue("a real sentence", 2, 4), cue("backwards", 9, 3), { text: "no timing" }]
    });
    expect(cues?.map((c) => c.text)).toEqual(["a real sentence"]);
    expect(cuesFromBodyJson(null)).toBeNull();
    expect(cuesFromBodyJson({ cues: "nope" })).toBeNull();
    expect(cuesFromBodyJson({ cues: [cue("backwards", 9, 3)] })).toBeNull();
  });

  it("locateInListing: the writer's key first, a prefix only with a matching recorded guid, then the recorded-guid scan", () => {
    /* MUTATION THAT KILLS THIS: accept the first `${slug}-` prefix candidate
       without asking bodyGuidOf (gen-7's bug). */
    const recorded = new Map([
      ["ep-5-bonus-0123456789.json", "ep-5-bonus"],
      ["Renamed.json", "ep-5"],
      [`${corpusSafeKey("ep-9")}.json`, "something-else"]
    ]);
    const files = new Map([...recorded.keys()].map((real) => [real.toLowerCase(), real]));
    const bodyGuidOf = (real: string) => recorded.get(real) ?? null;
    expect(locateInListing({ files, guid: "ep-9", bodyGuidOf })).toBe(`${corpusSafeKey("ep-9")}.json`);
    expect(locateInListing({ files, guid: "ep-5", bodyGuidOf })).toBe("Renamed.json");
    expect(locateInListing({ files, guid: "ep-5-bonus", bodyGuidOf })).toBe("ep-5-bonus-0123456789.json");
    expect(locateInListing({ files, guid: "ep-404", bodyGuidOf })).toBeNull();
  });
});
