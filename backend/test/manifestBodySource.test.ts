import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { main as indexBodies } from "../src/cli/indexBodies";
import {
  ManifestBodySource,
  parseEpisodeManifest,
  readEpisodeManifest,
  type CueStore,
  type EpisodeManifestRow
} from "../src/generation/manifestBodySource";
import { FileTranscriptCueProvider, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { corpusSafeKey } from "../src/generation/transcriptCorpus";
import { FileTranscriptTextIndex, showIndexCacheFile } from "../src/generation/transcriptTextIndex";

/**
 * GV-16 (docs/roadmap/generation-v2.md, from W3-08): the episode manifest the
 * stream indexer writes (GV-09) answers `bodyStat` for the retrieval server,
 * so caches built from a body STREAM (GV-05's indexBodies) are fresh with no
 * body on disk, and an archive row is mapped onto its manifest row by the same
 * locate rule the build used.
 *
 * Everything is synthetic: invented sentences, invented stats, tmp dirs. No
 * body file exists anywhere in this suite; the bodies only ever travel in the
 * stream, as they do from R2.
 */

const SHOW_A = "gv16m-alpha";
const SHOW_B = "gv16m-beta";
const PERMALINK = "https://example.com/podcast/ep-1-the-permalink-guid/";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv16-manifest-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cue = (text: string, start: number, end: number): TranscriptCue => ({ text, start_sec: start, end_sec: end });

interface Body {
  show: string;
  fileName: string;
  /** The guid the body records about itself. */
  bodyGuid: string;
  cues: TranscriptCue[];
  stat: { mtimeMs: number; size: number };
}

const BODIES: Body[] = [
  /* Becker's: the committed row's guid is a permalink, the body records a
     slug, and the file is named by the writer's key for the ROW's guid. */
  {
    show: SHOW_A,
    fileName: `${corpusSafeKey(PERMALINK)}.json`,
    bodyGuid: "ep-1-the-permalink-guid",
    cues: [cue("semmelweis washed his hands before the delivery ward", 0, 6)],
    stat: { mtimeMs: 1_760_000_000_001, size: 1201 }
  },
  { show: SHOW_A, fileName: `${corpusSafeKey("a2")}.json`, bodyGuid: "a2", cues: [cue("pasteur and the swan neck flask", 0, 5)], stat: { mtimeMs: 1_760_000_000_002, size: 1202 } },
  /* Found only by the guid it records: no key rule produces this name. */
  { show: SHOW_A, fileName: "old-name-a3.json", bodyGuid: "Buzzsprout-777", cues: [cue("cholera maps of the broad street pump", 0, 5)], stat: { mtimeMs: 1_760_000_000_003, size: 1203 } },
  /* A prefix trap: "ep-5" is a prefix of this name, but the body is ep-5-bonus. */
  { show: SHOW_A, fileName: "ep-5-bonus-0123456789.json", bodyGuid: "ep-5-bonus", cues: [cue("a bonus episode about lister", 0, 4)], stat: { mtimeMs: 1_760_000_000_004, size: 1204 } },
  { show: SHOW_B, fileName: `${corpusSafeKey("b1")}.json`, bodyGuid: "b1", cues: [cue("plate tectonics and banded iron", 0, 8)], stat: { mtimeMs: 1_760_000_000_005, size: 1205 } }
];

const ARCHIVE: TranscriptDigestEntry[] = [
  { show_id: SHOW_A, show_title: "Alpha", guid: PERMALINK, title: "Episode one", cues: 1 },
  { show_id: SHOW_A, show_title: "Alpha", guid: "a2", title: "Episode two", cues: 1 },
  { show_id: SHOW_A, show_title: "Alpha", guid: "Buzzsprout-777", title: "Episode three", cues: 1 },
  /* No body named for it: the prefix candidate records another guid. */
  { show_id: SHOW_A, show_title: "Alpha", guid: "ep-5", title: "Episode five", cues: 1 },
  { show_id: SHOW_A, show_title: "Alpha", guid: "ep-5-bonus", title: "Episode five bonus", cues: 1 },
  { show_id: SHOW_B, show_title: "Beta", guid: "b1", title: "Beta one", cues: 1 }
];

/** The rows tools/passage-index/manifest.mjs manifestRow writes for these bodies. */
function manifestRows(bodies: Body[] = BODIES): EpisodeManifestRow[] {
  return bodies.map((b) => ({
    show_id: b.show,
    fileName: b.fileName,
    bodyGuid: b.bodyGuid,
    cues: b.cues.length,
    size: b.stat.size,
    mtimeMs: b.stat.mtimeMs,
    origin: { kind: "r2", key: `transcripts/normalized/${b.show}-0123456789/${b.fileName}`, etag: `"etag-${b.fileName}"` }
  }));
}

/** A cue store that must never be asked for anything in a fresh-cache test. */
function spyStore(): CueStore & { calls: () => number } {
  const store = {
    getCues: vi.fn((): TranscriptCue[] | null => null),
    readCuesUncached: vi.fn((): TranscriptCue[] | null => null),
    transcriptSource: vi.fn(() => null),
    calls: () => store.getCues.mock.calls.length + store.readCuesUncached.mock.calls.length
  };
  return store;
}

const sink = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    }
  });

/** Build the caches the way the stream indexer does: indexBodies over a stream. */
async function streamIndex(indexRoot: string): Promise<void> {
  const committed = path.join(tmp, `committed-${path.basename(indexRoot)}.json`);
  fs.writeFileSync(committed, JSON.stringify({ transcripts: ARCHIVE }), "utf8");
  const lines: string[] = [];
  for (const show of [SHOW_A, SHOW_B]) {
    for (const b of BODIES.filter((x) => x.show === show)) {
      lines.push(JSON.stringify({ kind: "body", show_id: show, fileName: b.fileName, stat: b.stat, body: { show_id: show, guid: b.bodyGuid, cues: b.cues } }));
    }
    lines.push(JSON.stringify({ kind: "end-show", show_id: show }));
  }
  const result = await indexBodies(Readable.from(lines.map((l) => `${l}\n`)), sink(), {
    indexRoot,
    stagedOut: path.join(indexRoot, "..", "staged.jsonl"),
    archive: ARCHIVE,
    committedDigests: [committed],
    showTitle: (s) => s
  });
  expect(result.exitCode).toBe(0);
}

describe("ManifestBodySource — archive rows mapped onto manifest rows by the build's own locate rule", () => {
  it("maps a Becker-style guid-mismatched row, a row found by its recorded guid, and refuses a prefix whose body records another guid", () => {
    /* MUTATIONS THAT KILL THIS: in rowFor, answer bodyGuidOf with null (the
       recorded-guid scan never finds Buzzsprout-777); key the listing by the
       body's recorded guid instead of locateInListing (the permalink row
       misses its file); store fileNames case-sensitively (a mixed-case
       manifest name is missed by the writer's-key lookup). Ran the first two
       — red. */
    const source = new ManifestBodySource({ rows: manifestRows(), cues: spyStore() });
    const [becker, a2, buzz, ep5, bonus, b1] = ARCHIVE as [
      TranscriptDigestEntry,
      TranscriptDigestEntry,
      TranscriptDigestEntry,
      TranscriptDigestEntry,
      TranscriptDigestEntry,
      TranscriptDigestEntry
    ];
    expect(source.rowFor(becker)?.fileName).toBe(`${corpusSafeKey(PERMALINK)}.json`);
    expect(source.rowFor(becker)?.bodyGuid).toBe("ep-1-the-permalink-guid");
    expect(source.bodyStat(becker)).toEqual({ mtimeMs: 1_760_000_000_001, size: 1201 });
    expect(source.bodyStat(a2)).toEqual({ mtimeMs: 1_760_000_000_002, size: 1202 });
    expect(source.rowFor(buzz)?.fileName).toBe("old-name-a3.json");
    expect(source.bodyStat(ep5)).toBeNull();
    expect(source.rowFor(bonus)?.fileName).toBe("ep-5-bonus-0123456789.json");
    expect(source.bodyStat(b1)).toEqual({ mtimeMs: 1_760_000_000_005, size: 1205 });
    expect(source.bodyStat({ ...b1, show_id: "gv16m-nowhere" })).toBeNull();
    /* The same row under another show is not this show's body. */
    expect(source.bodyStat({ ...a2, show_id: SHOW_B })).toBeNull();
    expect(source.showIds().sort()).toEqual([SHOW_A, SHOW_B]);
  });

  it("caches built by indexBodies from a stream are judged fresh with NO body on disk, and the cue store is never read", async () => {
    /* The point of the module. MUTATIONS THAT KILL THIS: answer bodyStat from
       the cue store (or return null) — every cache is stale; swap size and
       mtimeMs in bodyStat — the stats differ from the ones the cache records.
       Ran both — red (warmFromCache null). */
    const indexRoot = path.join(tmp, "fresh", "index");
    await streamIndex(indexRoot);
    const store = spyStore();
    const index = new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: new ManifestBodySource({ rows: manifestRows(), cues: store }), indexRoot });
    const before = fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8");
    expect(index.warmFromCache(SHOW_A)).toMatchObject({ episodes: 4 });
    expect(index.warmFromCache(SHOW_B)).toMatchObject({ episodes: 1 });
    const hits = index.search("semmelweis washed hands delivery ward");
    expect(hits[0]?.entry.guid).toBe(PERMALINK);
    expect(store.calls()).toBe(0);
    expect(fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8")).toBe(before);

    /* The contrast: the file provider over an empty normalized dir has no
       body to stat, so the same cache is stale to it. */
    const fileIndex = new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: new FileTranscriptCueProvider(path.join(tmp, "no-bodies")), indexRoot });
    expect(fileIndex.warmFromCache(SHOW_A)).toBeNull();
  });

  it("warmFromCache never builds: a stale manifest stat is refused without reading a body or touching the cache", async () => {
    /* MUTATION THAT KILLS THIS: make warmFromCache fall through to showIndex()
       (build on a miss) — readCuesUncached is called and the cache rewritten. */
    const indexRoot = path.join(tmp, "stale", "index");
    await streamIndex(indexRoot);
    const changed = manifestRows().map((r) => (r.bodyGuid === "a2" ? { ...r, size: r.size + 1 } : r));
    const store = spyStore();
    const index = new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: new ManifestBodySource({ rows: changed, cues: store }), indexRoot });
    const before = fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8");
    expect(index.warmFromCache(SHOW_A)).toBeNull();
    expect(index.warmFromCache(SHOW_B)).not.toBeNull();
    expect(store.calls()).toBe(0);
    expect(fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_A), "utf8")).toBe(before);
    /* `cache: false` holds nothing from disk either. */
    const noCache = new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: new ManifestBodySource({ rows: manifestRows(), cues: store }), indexRoot, cache: false });
    expect(noCache.warmFromCache(SHOW_B)).toBeNull();
  });

  it("cues and provenance come from the injected store; readCuesUncached falls back to getCues", () => {
    /* MUTATION THAT KILLS THIS: have readCuesUncached call getCues even when
       the store has its own uncached read (the store's LRU fills on a rebuild). */
    const entry = ARCHIVE[1] as TranscriptDigestEntry;
    const cues = [cue("pasteur", 0, 1)];
    const full: CueStore = {
      getCues: vi.fn(() => cues),
      readCuesUncached: vi.fn(() => cues),
      transcriptSource: vi.fn(() => "asr-local" as const)
    };
    const source = new ManifestBodySource({ rows: manifestRows(), cues: full });
    expect(source.getCues(entry)).toBe(cues);
    expect(source.readCuesUncached(entry)).toBe(cues);
    expect(full.readCuesUncached).toHaveBeenCalledTimes(1);
    expect(full.getCues).toHaveBeenCalledTimes(1);
    expect(source.transcriptSource(entry)).toBe("asr-local");

    const bare: CueStore = { getCues: vi.fn(() => cues) };
    const viaGet = new ManifestBodySource({ rows: [], cues: bare });
    expect(viaGet.readCuesUncached(entry)).toBe(cues);
    expect(viaGet.transcriptSource(entry)).toBeNull();
  });

  it("parses episodes.jsonl leniently: blank and bad lines are skipped and counted, a repeated file name keeps the later row", () => {
    /* MUTATION THAT KILLS THIS: keep the FIRST row for a repeated fileName in
       the constructor — the re-streamed stat (size 2) is not the one answered. */
    const good = { show_id: SHOW_B, fileName: "x.json", bodyGuid: "x", size: 1, mtimeMs: 5 };
    const text = [
      JSON.stringify(good),
      "",
      "{not json",
      JSON.stringify({ show_id: SHOW_B, fileName: "y.json", size: "big", mtimeMs: 1 }),
      JSON.stringify({ ...good, size: 2 }),
      JSON.stringify({ show_id: SHOW_B, fileName: "z.json", size: 3, mtimeMs: 6 })
    ].join("\r\n");
    const { rows, skipped } = parseEpisodeManifest(text);
    expect(skipped).toBe(2);
    expect(rows.map((r) => [r.fileName, r.size, r.bodyGuid])).toEqual([
      ["x.json", 1, "x"],
      ["x.json", 2, "x"],
      ["z.json", 3, null]
    ]);
    const source = new ManifestBodySource({ rows, cues: spyStore() });
    expect(source.bodyStat({ show_id: SHOW_B, show_title: "Beta", guid: "x", title: "x", cues: 1 })).toEqual({ mtimeMs: 5, size: 2 });

    expect(readEpisodeManifest(path.join(tmp, "absent", "episodes.jsonl"))).toBeNull();
    const file = path.join(tmp, "episodes.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(good)}\n`, "utf8");
    expect(readEpisodeManifest(file)).toEqual({ rows: [good], skipped: 0 });
  });
});
