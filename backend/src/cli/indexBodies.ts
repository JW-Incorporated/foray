import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  cuesFromBodyJson,
  guidIndexOfListing,
  loadTranscriptArchive,
  locateInListing,
  type TranscriptDigestEntry
} from "../generation/transcriptArchiveLookup";
import {
  buildShowIndex,
  countTerms,
  writeShowIndexFile,
  type TranscriptBodyStat
} from "../generation/transcriptTextIndex";
import {
  bodyIdentity,
  catalogueShows,
  claimedFilesFromDigests,
  COMMITTED_DIGEST_FILES,
  pendingCorpusRows,
  type CorpusBodyListing
} from "./warmTranscriptIndex";

/**
 * STREAMED INDEX ASSEMBLY (GV-05; roadmap docs/roadmap/generation-v2.md, from
 * W3-04; covers R1-09 and GP-09).
 *
 * Builds the SAME per-show BM25 cache `FileTranscriptTextIndex` writes, from a
 * stream of transcript bodies instead of a local mirror of
 * `data-local/transcripts/normalized/`. An index assembled on another box (the
 * one that holds or streams the corpus) is then byte-compatible with the one
 * this box would build, save `builtAt`, and `cacheIsFresh` judges it fresh
 * wherever the body stats it records are the stats the reader sees.
 *
 *     <body stream> | npx tsx src/cli/indexBodies.ts [--index-root DIR] [--staged-out FILE]
 *
 * INPUT, one JSON record per line on stdin:
 *     {"kind":"body","show_id":"…","fileName":"<name>.json","stat":{"mtimeMs":…,"size":…},"body":{…normalized body…}}
 *     {"kind":"end-show","show_id":"…"}
 * `body` is the normalized body exactly as `tools/segments/` writes it (an
 * object, or that object as a JSON string); `stat` is the body file's own
 * mtime and size, which is what the cache's freshness test compares.
 *
 * WHY IT IS NOT "INDEX WHATEVER BODIES ARRIVE". `FileTranscriptTextIndex`'s
 * docs are ARCHIVE rows in archive order, each mapped onto a body by the
 * provider's locate rule (`locateInListing`), and each body's cues pass through
 * the provider's reading filter (`cuesFromBodyJson`). A cache built any other
 * way has different doc counts or guids and fails `cacheIsFresh`. So at each
 * end-show this:
 *   1. takes the show's archive rows (`loadTranscriptArchive()` order), plus
 *      the rows an offline reconcile would add for the streamed bodies the
 *      committed digests do not claim (`pendingCorpusRows`, titled by guid);
 *   2. maps each row onto a streamed body with `locateInListing` over the
 *      streamed file names;
 *   3. builds with `buildShowIndex` in row order and writes with
 *      `writeShowIndexFile` to `--index-root` (data-local/transcripts/index/);
 *   4. appends the new rows to `--staged-out`
 *      (data-local/passage-index/staged-digest.jsonl), one row per line, and
 *      frees the show.
 * The new rows land in the build AFTER the show's archive rows, which is where
 * `loadTranscriptArchive` puts them once they are merged into the corpus digest
 * (committed first, local last, first row per guid wins).
 *
 * WHAT IT KEEPS. Per body only {fileName, the guid it records, its cue count,
 * stat, content-word counts}; never the cues, never the body. It writes no
 * body to disk. It makes no network call and reads no feed: a staged row is
 * searchable only until a later reconcile joins it to its feed.
 *
 * No pipeline stage calls this; it is a tool, and a refactor-only change to the
 * modules it shares rules with (GV-05 has no flag).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_INDEX_ROOT = path.join(REPO_ROOT, "data-local", "transcripts", "index");
export const DEFAULT_STAGED_OUT = path.join(REPO_ROOT, "data-local", "passage-index", "staged-digest.jsonl");

export interface IndexBodiesOptions {
  /** Where the per-show caches go. Defaults to `DEFAULT_INDEX_ROOT`. */
  indexRoot?: string;
  /** Where the new digest rows are appended. Defaults to `DEFAULT_STAGED_OUT`. */
  stagedOut?: string;
  /** The archive the reader will search. Defaults to `loadTranscriptArchive()`. */
  archive?: readonly TranscriptDigestEntry[];
  /** The digests that already describe the corpus. Defaults to the committed two. */
  committedDigests?: readonly string[];
  /** A show's title for a new row. Defaults to `data/catalog.json`, else the id. */
  showTitle?: (showId: string) => string;
}

export interface IndexBodiesShowResult {
  showId: string;
  /** Bodies streamed for the show. */
  bodies: number;
  /** Rows the build walked: archive rows plus new ones. */
  rows: number;
  /** Rows that became index docs. */
  docs: number;
  /** New rows appended to the staged digest. */
  staged: number;
  terms: number;
  /** The cache written, or null when no row had a usable body. */
  file: string | null;
  bytes: number;
}

export interface IndexBodiesResult {
  shows: IndexBodiesShowResult[];
  /** Lines that could not be used, and shows the stream never ended. */
  problems: string[];
  exitCode: number;
}

/** What is kept of one streamed body. */
export interface KeptBody {
  fileName: string;
  /** The guid the body records about itself (null when it records none). */
  bodyGuid: string | null;
  /** The body's raw cue count, the digest row's `cues` (0 when it has none). */
  cuesCount: number;
  stat: TranscriptBodyStat;
  /** Content-word counts over the cues that pass the reading filter; null when
   * none do, which is an episode the index skips. */
  counts: Map<string, number> | null;
}

interface ShowState {
  /** Lowercased name -> real name, in arrival order: the show's "listing". */
  files: Map<string, string>;
  byName: Map<string, KeptBody>;
}

function isStat(value: unknown): value is TranscriptBodyStat {
  if (value === null || typeof value !== "object") return false;
  const v = value as { mtimeMs?: unknown; size?: unknown };
  return typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs) && typeof v.size === "number" && Number.isFinite(v.size);
}

/** The body the record carries, parsed; undefined when it carries none. */
function recordBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** One streamed body reduced to what the index and the staged rows need. */
export function keepBody(fileName: string, stat: TranscriptBodyStat, body: unknown): KeptBody {
  const identity = bodyIdentity(body);
  const recorded = body !== null && typeof body === "object" ? (body as { guid?: unknown }).guid : undefined;
  const cues = cuesFromBodyJson(body);
  return {
    fileName,
    bodyGuid: typeof recorded === "string" ? recorded : null,
    cuesCount: identity ? identity.cues : 0,
    stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    counts: cues && cues.length > 0 ? countTerms(cues) : null
  };
}

/** A show's title as a reconcile gives it: the catalogue's, else the id. */
function catalogueTitles(): (showId: string) => string {
  const catalogue = catalogueShows();
  return (showId) => catalogue.get(showId)?.title ?? showId;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Read the record stream, build and write one show's cache at each end-show,
 * and print a summary line per show. Exported for tests; the CLI wraps it.
 */
export async function main(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  opts: IndexBodiesOptions = {}
): Promise<IndexBodiesResult> {
  const indexRoot = opts.indexRoot ?? DEFAULT_INDEX_ROOT;
  const stagedOut = opts.stagedOut ?? DEFAULT_STAGED_OUT;
  const archive = opts.archive ?? loadTranscriptArchive();
  const claimedFiles = claimedFilesFromDigests(opts.committedDigests ?? COMMITTED_DIGEST_FILES);
  const titleOf = opts.showTitle ?? catalogueTitles();

  const shows = new Map<string, ShowState>();
  const results: IndexBodiesShowResult[] = [];
  const problems: string[] = [];
  let lineNo = 0;

  const endShow = (showId: string): void => {
    const state = shows.get(showId) ?? { files: new Map<string, string>(), byName: new Map<string, KeptBody>() };
    shows.delete(showId);

    /* The rows an offline reconcile would add for these bodies — the same
       claim test, the same row, the same order. */
    const listing: CorpusBodyListing[] = [];
    for (const kept of state.byName.values()) {
      if (kept.bodyGuid !== null && kept.cuesCount > 0) listing.push({ fileName: kept.fileName, guid: kept.bodyGuid, cues: kept.cuesCount });
    }
    const pending = pendingCorpusRows(showId, titleOf(showId), listing, claimedFiles).rows;

    /* Archive rows first, in archive order; new rows after them, first row
       per guid winning — `loadTranscriptArchive`'s own rule. */
    const rows = archive.filter((r) => r.show_id === showId);
    const seen = new Set(rows.map((r) => r.guid));
    for (const row of pending) {
      if (seen.has(row.guid)) continue;
      seen.add(row.guid);
      rows.push(row);
    }

    const bodyGuidOf = (real: string): string | null => state.byName.get(real)?.bodyGuid ?? null;
    /* The listing's recorded-guid index, built once per show on first need,
       as the provider builds it once per directory. */
    let guidIndexCache: Map<string, string> | null = null;
    const guidIndex = (): Map<string, string> => (guidIndexCache ??= guidIndexOfListing(state.files, bodyGuidOf));
    const index = buildShowIndex(showId, rows, (entry) => {
      const real = locateInListing({ files: state.files, guid: String(entry.guid), bodyGuidOf, guidIndex });
      if (real === null) return null;
      const kept = state.byName.get(real);
      if (!kept || !kept.counts) return null;
      return { stat: kept.stat, counts: kept.counts };
    });

    let file: string | null = null;
    let bytes = 0;
    if (index) {
      file = writeShowIndexFile(indexRoot, index);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the cache file just written.
      bytes = fs.statSync(file).size;
    }
    if (pending.length > 0) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the staged digest path (data-local or a caller's).
      fs.mkdirSync(path.dirname(stagedOut), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      fs.appendFileSync(stagedOut, pending.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
    }

    const result: IndexBodiesShowResult = {
      showId,
      bodies: state.byName.size,
      rows: rows.length,
      docs: index ? index.docs.length : 0,
      staged: pending.length,
      terms: index ? Object.keys(index.postings).length : 0,
      file,
      bytes
    };
    results.push(result);
    stdout.write(
      index
        ? `${showId}: ${result.bodies} bodies, ${result.docs} of ${result.rows} rows indexed, +${result.staged} staged, ` +
            `${result.terms} terms, ${mb(bytes)} cache\n`
        : `${showId}: ${result.bodies} bodies, NO row of ${result.rows} maps to a usable body, no cache written, +${result.staged} staged\n`
    );
  };

  const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    let record: { kind?: unknown; show_id?: unknown; fileName?: unknown; stat?: unknown; body?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      problems.push(`line ${lineNo}: not JSON`);
      continue;
    }
    if (record === null || typeof record !== "object" || typeof record.show_id !== "string" || record.show_id.length === 0) {
      problems.push(`line ${lineNo}: no show_id`);
      continue;
    }
    const showId = record.show_id;
    if (record.kind === "end-show") {
      endShow(showId);
      continue;
    }
    if (record.kind !== "body") {
      problems.push(`line ${lineNo}: unknown kind ${JSON.stringify(record.kind)}`);
      continue;
    }
    /* The provider lists `.json` files only, so a body under any other name is
       one no reader would ever find. */
    if (typeof record.fileName !== "string" || !record.fileName.endsWith(".json") || /[\\/]/.test(record.fileName)) {
      problems.push(`line ${lineNo}: ${showId}: fileName must be a bare *.json name`);
      continue;
    }
    if (!isStat(record.stat)) {
      problems.push(`line ${lineNo}: ${showId}/${record.fileName}: stat must be {mtimeMs, size}`);
      continue;
    }
    let state = shows.get(showId);
    if (!state) {
      state = { files: new Map(), byName: new Map() };
      shows.set(showId, state);
    }
    const kept = keepBody(record.fileName, record.stat, recordBody(record.body));
    const lower = record.fileName.toLowerCase();
    const previous = state.files.get(lower);
    if (previous !== undefined && previous !== record.fileName) state.byName.delete(previous);
    state.files.set(lower, record.fileName);
    state.byName.set(record.fileName, kept);
  }

  /* A show the stream never ended is not written: its bodies may be partial,
     and a cache over part of a show would describe a corpus nobody has. */
  for (const showId of shows.keys()) {
    problems.push(`${showId}: stream ended before its end-show record; no cache written`);
  }
  for (const problem of problems) stdout.write(`problem: ${problem}\n`);
  return { shows: results, problems, exitCode: problems.length > 0 ? 1 : 0 };
}

export interface IndexBodiesArgs {
  indexRoot: string;
  stagedOut: string;
}

export function parseIndexBodiesArgs(argv: readonly string[]): IndexBodiesArgs {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : null;
  };
  return {
    indexRoot: path.resolve(value("--index-root") ?? DEFAULT_INDEX_ROOT),
    stagedOut: path.resolve(value("--staged-out") ?? DEFAULT_STAGED_OUT)
  };
}

if (require.main === module) {
  const args = parseIndexBodiesArgs(process.argv.slice(2));
  main(process.stdin, process.stdout, args)
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
}
