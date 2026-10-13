import * as fs from "fs";
import * as path from "path";
import { FileTranscriptCueProvider, loadTranscriptArchive, type TranscriptDigestEntry } from "../generation/transcriptArchiveLookup";
import { corpusCoverage, corpusCoverageLine, corpusSafeKey, scanNormalizedCorpus } from "../generation/transcriptCorpus";
import { fetchFeedConditional } from "../feeds/conditionalGet";
import { parseFeed } from "../feeds/parser";
import { FileTranscriptTextIndex } from "../generation/transcriptTextIndex";
import { loadShowAudioMeta, mintSegmentSource, type ShowAudioMeta } from "../generation/audioSourceLookup";
import { nodesForArchiveEntry } from "../generation/taxonomyFamily";

/**
 * WARM THE TRANSCRIPT CORPUS BEFORE A RUN, AND PRINT THE BILL (issue #703).
 *
 * Run it through its launcher, which is where the founder's other run commands
 * live:
 *
 *     node tools/generation/warm-transcript-index.mjs
 *     node tools/generation/warm-transcript-index.mjs --offline
 *     node tools/generation/warm-transcript-index.mjs --show this-podcast-will-kill-you
 *
 * GV-53 adds three opt-in modes for a box that streams bodies instead of
 * holding them (see the GV-53 block below the reconcile):
 *
 *     node tools/generation/warm-transcript-index.mjs --from-staged data-local/passage-index/staged-digest.jsonl [--offline]
 *     node tools/generation/warm-transcript-index.mjs --resolve-legacy keys.txt [--legacy-map-from foray-db-map.json] [--offline]
 *     node tools/generation/warm-transcript-index.mjs --supply-report
 *
 * WHAT "WARM" MEANS HERE, AND WHY IT IS TWO JOBS. #703 asked for the index to
 * be built for every show ahead of a run. Building indexes turns out to be the
 * SMALLER half: `FileTranscriptTextIndex.search` already builds a missing
 * index on the spot for every show the lineage gate admits, so an unindexed
 * show in the archive was never actually unreachable — only slow, and slow
 * inside the §4.2 call where a stall reads as a hung pipeline. The half that
 * really cost 4,318 episodes is the ARCHIVE:
 *
 *   1. RECONCILE. `data/transcript-digests.json` and its breadth twin are what
 *      `loadTranscriptArchive()` searches, and `tools/segments/fetch-transcripts.mjs`
 *      rewrites its digest file whole, with only the targets of that run. So
 *      the digests are a record of the last fetch, not of the corpus, and seven
 *      shows with 3,328 bodies on disk had no row in either. This pass walks
 *      `data-local/transcripts/normalized/` and writes a row for every body the
 *      committed digests do not already carry, into the machine-local
 *      `data-local/transcripts/corpus-digest.json` that `loadTranscriptArchive`
 *      now also reads. Nothing committed is touched.
 *
 *   2. BUILD. Then every show's BM25 index, one show at a time, timed and
 *      measured, so the cost is a number in a run log instead of a mystery
 *      inside a research call.
 *
 * FEEDS, AND WHAT A ROW IS WORTH WITHOUT ONE. A body on disk knows its show and
 * its guid and nothing else — no episode title, no enclosure URL, no duration.
 * `audioSourceLookup.mintSegmentSource` refuses a row without a title, an https
 * enclosure and a positive duration, so a row built from the body alone is
 * SEARCHABLE (the research map can read it, the spine can write from it) but
 * not MINTABLE (no clip can be cut from it). This pass therefore fetches each
 * missing show's RSS feed once — the feed_url is already in `data/catalog.json`
 * — joins it by guid, and caches it under `data-local/transcripts/feeds/`.
 * `--offline` skips that and says, per show, how many rows came out searchable
 * only. Audio is never fetched (#108): the enclosure URL is recorded, never
 * followed.
 *
 * MEMORY. The machine this runs on has 16 GB and other agents on it. One show
 * is built at a time and dropped before the next (`forget`), bodies are parsed
 * one at a time by the cue provider, and the largest single object that ever
 * exists is one show's inverted index — `stuff-you-should-know`'s, the biggest
 * in this corpus. Measured peak RSS for a full warm is printed at the end, so
 * the next person does not have to guess either.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const NORMALIZED_ROOT = path.join(REPO_ROOT, "data-local", "transcripts", "normalized");
const CORPUS_DIGEST = path.join(REPO_ROOT, "data-local", "transcripts", "corpus-digest.json");
const FEED_CACHE = path.join(REPO_ROOT, "data-local", "transcripts", "feeds");

export interface WarmArgs {
  offline: boolean;
  shows: string[];
  reconcileOnly: boolean;
  buildOnly: boolean;
}

export function parseWarmArgs(argv: string[]): WarmArgs {
  const shows: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--show" && argv[i + 1]) {
      shows.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return {
    offline: argv.includes("--offline"),
    shows,
    reconcileOnly: argv.includes("--reconcile-only"),
    buildOnly: argv.includes("--build-only")
  };
}

/** One episode from a show's RSS feed: the three fields a digest row needs and a
 * body file does not have. */
export interface FeedEpisode {
  guid: string;
  title: string;
  enclosureUrl: string | null;
  durationSec: number | null;
}

/**
 * The feed's episodes that have a guid, through `feeds/parser.ts` — the
 * project's ONE RSS parser, duration rule (`feeds/duration.ts`) and entity
 * decoder (`feeds/html.ts`). CH2-06 (B2-05): this file used to carry its own
 * regex parser, duration parser and five-entity decoder, which stored
 * `Rockets &#038; Rails` literally and counted `12:75` mintable at 795 s.
 *
 * An item with no guid is dropped: a row keyed on nothing can never be joined
 * to a body. An item with no `<title>` keeps the empty title it always had
 * here, never the shared parser's `(untitled item #N)` placeholder — an
 * invented title would make the row mintable and put a made-up episode name in
 * a Foray. The join key must stay byte-equal to the guid
 * `tools/segments/sweep-transcripts.mjs` reads; the suite pins that parity.
 */
function feedEpisodes(xml: string): FeedEpisode[] {
  const out: FeedEpisode[] = [];
  for (const episode of parseFeed(xml).episodes) {
    if (!episode.guid) continue;
    out.push({
      guid: episode.guid,
      title: episode.warnings.includes("missing title") ? "" : episode.title,
      enclosureUrl: episode.enclosureUrl,
      durationSec: episode.duration.seconds
    });
  }
  return out;
}

/** `<show_id>-<10 hex>` is the directory; `<show_id>` is what a digest row says.
 * Exported for GV-05's streamed index build, which titles its new rows exactly
 * as a reconcile does. */
export function catalogueShows(): Map<string, { title: string; feedUrl: string | null }> {
  const out = new Map<string, { title: string; feedUrl: string | null }>();
  try {
    const file = path.join(REPO_ROOT, "data", "catalog.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { shows?: Array<{ show_id?: string; title?: string; feed_url?: string }> };
    for (const show of parsed.shows ?? []) {
      if (typeof show.show_id !== "string") continue;
      out.set(show.show_id, { title: String(show.title ?? show.show_id), feedUrl: typeof show.feed_url === "string" ? show.feed_url : null });
    }
  } catch {
    /* No catalogue is a checkout problem, not a warm problem: rows still get a
       show id, and their show title falls back to the id. */
  }
  return out;
}

/** A cached feed older than this is refetched (conditionally) before use. */
export const FEED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoadFeedOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAgeMs?: number;
  /** Guids the caller needs; one missing from the cached feed forces a refetch. */
  needGuids?: readonly string[];
}

/**
 * A show's feed, joined by guid, from the cache or the network.
 *
 * backend-rest-14: this used a bare `fetch` with no timeout and no byte cap,
 * and reused the cached XML forever, so episodes published after the first
 * warm never got enclosure URLs. It now goes through `fetchFeedConditional`
 * (15 s timeout, 20 MB cap, the project's one user agent) and refetches when
 * the cache is older than `FEED_CACHE_MAX_AGE_MS` or lacks a guid a pending
 * body needs, as a conditional GET keyed on the cache file's mtime so an
 * unchanged feed costs a 304. A failed refetch falls back to the cache.
 */
export async function loadFeed(
  showId: string,
  feedUrl: string | null,
  offline: boolean,
  opts: LoadFeedOptions = {}
): Promise<Map<string, FeedEpisode>> {
  const cacheDir = opts.cacheDir ?? FEED_CACHE;
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? FEED_CACHE_MAX_AGE_MS;
  const cacheFile = path.join(cacheDir, `${showId.replace(/[^a-z0-9_-]+/gi, "-")}.xml`);
  let xml: string | null = null;
  let cachedAtMs: number | null = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path slugged from a catalogue show id.
    if (fs.existsSync(cacheFile)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      xml = fs.readFileSync(cacheFile, "utf8");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      cachedAtMs = fs.statSync(cacheFile).mtimeMs;
    }
  } catch {
    xml = null;
    cachedAtMs = null;
  }

  const index = (text: string | null) => {
    const byGuid = new Map<string, FeedEpisode>();
    if (text) for (const episode of feedEpisodes(text)) byGuid.set(episode.guid, episode);
    return byGuid;
  };
  let byGuid = index(xml);

  const stale =
    xml === null ||
    cachedAtMs === null ||
    now() - cachedAtMs > maxAgeMs ||
    (opts.needGuids ?? []).some((g) => !byGuid.has(g));
  if (!stale || offline || !feedUrl) return byGuid;

  /* The project's ONE outbound identity lives in fetchFeedConditional (#316:
     `tools/segments/politeness.test.mjs` refuses any file under `backend/src/`
     that writes its own). */
  const res = await fetchFeedConditional(
    feedUrl,
    { etag: null, lastModified: xml !== null && cachedAtMs !== null ? new Date(cachedAtMs).toUTCString() : null },
    { fetchImpl: opts.fetchImpl }
  );
  try {
    if (res.notModified && xml !== null) {
      const t = new Date(now());
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      fs.utimesSync(cacheFile, t, t);
    } else if (res.body !== null && !res.error) {
      xml = res.body;
      byGuid = index(xml);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the feed cache directory (or a test's).
      fs.mkdirSync(cacheDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      fs.writeFileSync(cacheFile, xml, "utf8");
    }
    /* A feed that will not answer costs this show its enclosure URLs and
       nothing else: the cache (if any) is used as it is. */
  } catch {
    /* A cache write failure is not a warm failure. */
  }
  return byGuid;
}

/**
 * backend-rest-8: the rows to write to corpus-digest.json. A `--show X` warm
 * reconciles only X, so it REPLACES X's rows and keeps every other show's;
 * the old code wrote X's rows alone and dropped the rest of the archive. A
 * full warm (no `--show`) is the whole truth and replaces everything,
 * including with an empty list, so stale rows are pruned.
 */
export function mergeCorpusRows(
  existing: readonly TranscriptDigestEntry[],
  fresh: readonly TranscriptDigestEntry[],
  onlyShows: readonly string[]
): TranscriptDigestEntry[] {
  if (onlyShows.length === 0) return [...fresh];
  const kept = existing.filter((r) => !onlyShows.includes(r.show_id));
  return [...kept, ...fresh].sort((a, b) => a.show_id.localeCompare(b.show_id) || a.guid.localeCompare(b.guid));
}

/** The rows currently in a corpus digest file, or none. */
export function readCorpusDigestRows(file: string = CORPUS_DIGEST): TranscriptDigestEntry[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed machine-local path (or a test's).
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { transcripts?: unknown };
    return Array.isArray(parsed.transcripts) ? (parsed.transcripts as TranscriptDigestEntry[]) : [];
  } catch {
    return [];
  }
}

/** What one body file says about itself. */
function readBody(file: string): { guid: string; cues: number } | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this module's own directory walk.
    return bodyIdentity(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** What one parsed body says about itself: the guid it records and how many
 * cues it carries (before any reading filter — the digest row's `cues`). Null
 * for a body with no guid or no cues, which no reconcile turns into a row.
 * Exported for GV-05's streamed index build, which gets bodies as JSON. */
export function bodyIdentity(json: unknown): { guid: string; cues: number } | null {
  if (json === null || typeof json !== "object") return null;
  const parsed = json as { guid?: unknown; cues?: unknown };
  if (typeof parsed.guid !== "string" || !Array.isArray(parsed.cues) || parsed.cues.length === 0) return null;
  return { guid: parsed.guid, cues: parsed.cues.length };
}

/** The identity of one body file, for the "is this episode already covered"
 * question. Lowercased because a directory listing on Windows is not
 * case-authoritative and `corpusSafeKey` is lowercase by construction. */
function claimKey(showId: string, keyWithoutExtension: string): string {
  return `${String(showId).toLowerCase()}/${String(keyWithoutExtension).toLowerCase()}`;
}

/**
 * One corpus-digest row: a body on disk joined to its feed episode, if the
 * feed had one. MINTABLE means `audioSourceLookup.mintSegmentSource` will
 * accept it — a title, an enclosure and a positive duration; anything less is
 * SEARCHABLE only, which is what `--offline` produces for every row.
 */
export function corpusDigestRow(
  showId: string,
  showTitle: string,
  body: { guid: string; cues: number },
  episode: FeedEpisode | undefined
): { row: TranscriptDigestEntry; mintable: boolean } {
  const row: TranscriptDigestEntry = {
    show_id: showId,
    show_title: showTitle,
    guid: body.guid,
    /* A row with no title cannot mint tape, and an INVENTED title would be
       worse than none: `mintSegmentSource` would accept it and the Foray
       would carry a made-up episode name. The guid is the honest fallback —
       it is what the archive already calls this episode. */
    title: episode?.title ?? body.guid,
    cues: body.cues
  };
  if (episode?.enclosureUrl) row.enclosure_url = episode.enclosureUrl;
  if (episode?.durationSec) row.feed_duration_sec = episode.durationSec;
  return { row, mintable: Boolean(episode?.title && episode.enclosureUrl && episode.durationSec) };
}

export interface ReconcileResult {
  rows: TranscriptDigestEntry[];
  perShow: Array<{ showId: string; added: number; mintable: number; searchableOnly: number }>;
}

/** The digests a reconcile treats as already describing the corpus. */
export const COMMITTED_DIGEST_FILES: readonly string[] = [
  path.join(REPO_ROOT, "data", "transcript-digests.json"),
  path.join(REPO_ROOT, "data", "breadth-transcript-digests.json")
];

/**
 * The body files the committed digests already describe, as `claimKey`s.
 *
 * KEYED ON THE BODY FILE, NOT ON THE GUID (measured, and it matters).
 *
 * A committed row and the body it describes do NOT always agree about the
 * guid: Becker's Healthcare rows carry the permalink URL
 * (`https://blubrry.com/.../david-dunkle-.../`) while the body file's own
 * `guid` field is the slug it was saved under. Dedupe on the guid string and
 * all 990 look unrepresented, a second row is written for each, and the
 * archive holds the same episode twice — which is how the first run of this
 * tool reported "6162 of 5041 episodes searchable" for a 5,041-episode
 * corpus. The FILE is the thing that is or is not already covered, and
 * `corpusSafeKey` is what maps a committed row onto one.
 */
export function claimedFilesFromDigests(files: readonly string[] = COMMITTED_DIGEST_FILES): Set<string> {
  const claimedFiles = new Set<string>();
  for (const full of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed digest paths (or a test's).
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { transcripts?: TranscriptDigestEntry[] };
    for (const t of parsed.transcripts ?? []) claimedFiles.add(claimKey(t.show_id, corpusSafeKey(String(t.guid))));
  }
  return claimedFiles;
}

/** One body a reconcile has read: its file name in the show directory, the
 * guid it records about itself, and how many cues it carries. */
export interface CorpusBodyListing {
  fileName: string;
  guid: string;
  cues: number;
}

/** Whether a body file is already described by a committed row: by its file
 * name (the cheap test, asked before the body is read), or by the guid it
 * records (for a body saved under a name no committed row maps to but whose
 * guid one of them does carry). */
function isClaimed(showId: string, fileName: string, guid: string | null, claimedFiles: ReadonlySet<string>): boolean {
  if (claimedFiles.has(claimKey(showId, fileName.replace(/\.json$/i, "")))) return true;
  return guid !== null && claimedFiles.has(claimKey(showId, corpusSafeKey(guid)));
}

/**
 * THE PURE CORE OF A RECONCILE, for one show: the corpus-digest rows its bodies
 * add to the archive, in corpus-digest order (by guid), and how many of them
 * are mintable. A body the committed digests already claim adds nothing; every
 * other body with cues adds one row, joined to `feed` when the feed carries its
 * guid and searchable-only (titled by its guid) otherwise.
 *
 * `reconcileCorpus` reads the bodies from `data-local/` and calls this; GV-05's
 * streamed index build (`cli/indexBodies.ts`) calls it over bodies it was sent,
 * with no feed, and so stages exactly the rows an offline reconcile with no
 * cached feed writes.
 */
export function pendingCorpusRows(
  showId: string,
  showTitle: string,
  bodies: readonly CorpusBodyListing[],
  claimedFiles: ReadonlySet<string>,
  feed: ReadonlyMap<string, FeedEpisode> = new Map()
): { rows: TranscriptDigestEntry[]; mintable: number } {
  const rows: TranscriptDigestEntry[] = [];
  let mintable = 0;
  for (const body of bodies) {
    if (!(body.cues > 0) || isClaimed(showId, body.fileName, body.guid, claimedFiles)) continue;
    const joined = corpusDigestRow(showId, showTitle, { guid: body.guid, cues: body.cues }, feed.get(body.guid));
    if (joined.mintable) mintable += 1;
    rows.push(joined.row);
  }
  rows.sort(compareCorpusRows);
  return { rows, mintable };
}

/** The corpus digest's row order: show, then guid. */
function compareCorpusRows(a: TranscriptDigestEntry, b: TranscriptDigestEntry): number {
  return a.show_id.localeCompare(b.show_id) || a.guid.localeCompare(b.guid);
}

export interface ReconcileOptions {
  offline: boolean;
  onlyShows: string[];
  /** Defaults to `data-local/transcripts/normalized/`. */
  normalizedRoot?: string;
  /** Defaults to `COMMITTED_DIGEST_FILES`. */
  committedDigests?: readonly string[];
  /** Defaults to `data-local/transcripts/feeds/`. */
  feedCacheDir?: string;
}

/**
 * Build corpus-digest rows for every body on disk that the COMMITTED digests do
 * not already describe.
 *
 * Keyed on `show_id + guid`, which is the same key `loadTranscriptArchive`
 * dedupes on, so a row here can never shadow a committed one — this pass only
 * ever ADDS episodes to the searchable universe. Which bodies are already
 * described is `claimedFilesFromDigests`'s question, and the rows are
 * `pendingCorpusRows`'s answer; this function only reads the disk and the feed.
 */
export async function reconcileCorpus(options: ReconcileOptions): Promise<ReconcileResult> {
  const normalizedRoot = options.normalizedRoot ?? NORMALIZED_ROOT;
  const claimedFiles = claimedFilesFromDigests(options.committedDigests);
  const catalogue = catalogueShows();
  const rows: TranscriptDigestEntry[] = [];
  const perShow: ReconcileResult["perShow"] = [];

  for (const show of scanNormalizedCorpus(normalizedRoot)) {
    if (options.onlyShows.length > 0 && !options.onlyShows.includes(show.showId)) continue;
    const dir = path.join(normalizedRoot, show.dirName);
    const meta = catalogue.get(show.showId);
    const showTitle = meta?.title ?? show.showId;
    /* The bodies this show has and the committed digests do not. Read FIRST, so
       a show that needs nothing never causes a network request. */
    const unclaimed: CorpusBodyListing[] = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory came from `scanNormalizedCorpus`.
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      /* The cheap test first: a file a committed row already names is not read
         at all. That is what keeps a re-warm of a 2,857-episode show from
         re-parsing 306 MB of JSON to learn it has nothing to do. */
      if (isClaimed(show.showId, name, null, claimedFiles)) continue;
      const body = readBody(path.join(dir, name));
      if (!body) continue;
      unclaimed.push({ fileName: name, guid: body.guid, cues: body.cues });
    }
    /* The guid test second, inside the pure core. */
    const searchable = pendingCorpusRows(show.showId, showTitle, unclaimed, claimedFiles);
    if (searchable.rows.length === 0) continue;

    const feed = await loadFeed(show.showId, meta?.feedUrl ?? null, options.offline, {
      cacheDir: options.feedCacheDir,
      needGuids: searchable.rows.map((r) => r.guid)
    });
    const added = pendingCorpusRows(show.showId, showTitle, unclaimed, claimedFiles, feed);
    rows.push(...added.rows);
    perShow.push({
      showId: show.showId,
      added: added.rows.length,
      mintable: added.mintable,
      searchableOnly: added.rows.length - added.mintable
    });
  }

  rows.sort(compareCorpusRows);
  return { rows, perShow };
}

const CORPUS_DIGEST_POLICY =
  "machine-local — describes the transcript bodies under data-local/transcripts/normalized/ that the committed digests do not carry (issue #703). Never committed; rebuild with tools/generation/warm-transcript-index.mjs.";

/** GV-53: the policy line a `--from-staged` write records, since its rows came
 * from a streamed index build rather than from the normalized directory. */
const STAGED_DIGEST_POLICY =
  "machine-local — describes transcript bodies the committed digests do not carry: bodies under data-local/transcripts/normalized/ (issue #703) and bodies a streamed index build staged (GV-53, --from-staged). Never committed; rebuild with tools/generation/warm-transcript-index.mjs.";

function writeCorpusDigest(rows: TranscriptDigestEntry[], file: string = CORPUS_DIGEST, policy: string = CORPUS_DIGEST_POLICY): number {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the corpus digest path (data-local or a test's).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(
    {
      version: 1,
      generated_at: new Date().toISOString(),
      policy,
      summary: { transcripts: rows.length },
      transcripts: rows
    },
    null,
    0
  );
  const tmp = `${file}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.writeFileSync(tmp, body, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.renameSync(tmp, file);
  return Buffer.byteLength(body);
}

/* ===========================================================================
 * GV-53 (docs/roadmap/generation-v2.md, from W3-03; covers R2-16, GP-22):
 * DIGEST ROWS FOR STREAMED EPISODES.
 *
 * Three CLI modes, each new and each opt-in; the default warm (reconcile the
 * normalized directory, then build) is unchanged byte for byte. They reuse
 * the pure helpers above — `loadFeed` (the ONLY network path, and it honours
 * `--offline`), `corpusDigestRow` (mintable = title + enclosure + duration),
 * `claimedFilesFromDigests` and `writeCorpusDigest` — rather than a second
 * joiner. The Postgres join of the original card is dropped: pg-row-source.mjs
 * has no enclosure column.
 *
 *   --from-staged [<staged-digest.jsonl>]  GV-05's streamed index build stages
 *       one searchable-only row per new body (titled by its guid, no feed).
 *       This joins those rows to their show's feed, per show, and merges them
 *       into corpus-digest.json. It replaces the normalized-dir scan, so it
 *       works on a box that holds no bodies at all. With no file it reads
 *       DEFAULT_STAGED_DIGEST, where the streamed build stages by default.
 *   --resolve-legacy <keys.txt>  legacy faster-whisper keys
 *       (`<show-slug>/<title-slug>-<sha1(guid)[:10]>.json`, GV-06's listing)
 *       to {show_id, guid, title}, through the catalogue title slug, the
 *       show's feed and GV-23's `resolveLegacyEpisode`, into
 *       data-local/passage-index/legacy-map.json. `--legacy-map-from <json>`
 *       (foray-db's own mapping export) wins over the feed, because feeds
 *       often drop old episodes.
 *   --supply-report  per show in the archive: how many rows the gated stages
 *       can SEARCH and how many can actually MINT a clip, and the first mint
 *       condition the show is missing.
 * ======================================================================== */

export const DEFAULT_STAGED_DIGEST = path.join(REPO_ROOT, "data-local", "passage-index", "staged-digest.jsonl");
export const DEFAULT_LEGACY_MAP = path.join(REPO_ROOT, "data-local", "passage-index", "legacy-map.json");
export const DEFAULT_SUPPLY_REPORT = path.join(REPO_ROOT, "data-local", "passage-index", "supply-report.json");

/** The three GV-53 modes and their inputs, as `parseWarmModes` reads them. */
export interface WarmModeArgs {
  fromStaged: string | null;
  resolveLegacy: string | null;
  legacyMapFrom: string | null;
  supplyReport: boolean;
  /** Mode flags given without a usable value or out of place. A run with any
   * refuses outright (exit 2): it must never fall through to the default
   * warm, whose full reconcile rewrites corpus-digest.json from the
   * normalized dir alone, which is empty on a streamed box. */
  errors: string[];
}

/** The value after `flag` ("" when the flag is absent), or null when the flag
 * is present with no value: the next token is missing, empty or another flag. */
function flagValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0) return "";
  const value = argv[i + 1];
  return value === undefined || value === "" || value.startsWith("--") ? null : String(value);
}

/** The GV-53 modes in `argv`. Kept apart from `parseWarmArgs` so the default
 * warm's parsed shape is what it always was. Routing is on a flag's presence,
 * not its value: a bare `--from-staged` reads the file GV-05's streamed build
 * stages by default (DEFAULT_STAGED_DIGEST); a bare `--resolve-legacy` or
 * `--legacy-map-from`, or `--legacy-map-from` without `--resolve-legacy`, is
 * an error, never "no mode". */
export function parseWarmModes(argv: readonly string[]): WarmModeArgs {
  const errors: string[] = [];
  const staged = flagValue(argv, "--from-staged");
  const legacy = flagValue(argv, "--resolve-legacy");
  const mapFrom = flagValue(argv, "--legacy-map-from");
  if (legacy === null) errors.push("--resolve-legacy needs a keys file (one legacy key per line)");
  if (mapFrom === null) errors.push("--legacy-map-from needs foray-db's mapping export (a JSON file)");
  if (mapFrom !== "" && legacy === "") errors.push("--legacy-map-from only applies with --resolve-legacy <keys.txt>");
  return {
    fromStaged: staged === "" ? null : (staged ?? DEFAULT_STAGED_DIGEST),
    resolveLegacy: legacy || null,
    legacyMapFrom: mapFrom || null,
    supplyReport: argv.includes("--supply-report"),
    errors
  };
}

/** Whether any GV-53 mode was asked for, including a malformed one (the
 * default warm runs only when none was). */
export function anyWarmMode(modes: WarmModeArgs): boolean {
  return modes.fromStaged !== null || modes.resolveLegacy !== null || modes.supplyReport || modes.errors.length > 0;
}

/** A catalogue as `catalogueShows` returns it; injectable for tests. */
export type CatalogueShows = ReadonlyMap<string, { title: string; feedUrl: string | null }>;

/** What the feed-reading modes share. */
export interface FeedJoinOptions {
  offline: boolean;
  /** Defaults to `catalogueShows()`. */
  catalogue?: CatalogueShows;
  /** Defaults to `data-local/transcripts/feeds/`. */
  feedCacheDir?: string;
  /** Passed to `loadFeed` (tests inject a fake; it is never reached offline). */
  fetchImpl?: typeof fetch;
}

/** The staged rows in a JSONL file, and the lines that were not rows. */
export function readStagedRows(file: string): { rows: TranscriptDigestEntry[]; problems: string[] } {
  const rows: TranscriptDigestEntry[] = [];
  const problems: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the staged digest path the operator named (or a test's).
  const text = fs.readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: not JSON`);
      return;
    }
    const r = parsed as Partial<TranscriptDigestEntry> | null;
    if (!r || typeof r !== "object" || typeof r.show_id !== "string" || r.show_id === "" || typeof r.guid !== "string" || r.guid === "") {
      problems.push(`line ${i + 1}: no show_id or guid`);
      return;
    }
    if (!(typeof r.cues === "number" && r.cues > 0)) {
      problems.push(`line ${i + 1}: no cues`);
      return;
    }
    rows.push(r as TranscriptDigestEntry);
  });
  return { rows, problems };
}

export interface StagedJoinResult extends ReconcileResult {
  /** Staged rows a committed digest already describes; never rewritten. */
  claimed: number;
  /** Staged rows repeated (same show and guid) after their first line. */
  duplicates: number;
}

/**
 * THE --from-staged JOIN: each staged row, per show, joined to the show's feed
 * by guid (`loadFeed` with `needGuids` = the show's staged guids, then
 * `corpusDigestRow`). A row with a feed episode carrying title, enclosure and
 * duration is MINTABLE; one the feed lacks stays searchable only, titled by
 * its guid exactly as it was staged. A staged row a COMMITTED digest already
 * describes (the same claim test a reconcile applies, by `corpusSafeKey` of
 * the guid) is dropped: the committed row is the better one and is never
 * restated.
 */
export async function joinStagedRows(staged: readonly TranscriptDigestEntry[], options: FeedJoinOptions & { committedDigests?: readonly string[] }): Promise<StagedJoinResult> {
  const claimedFiles = claimedFilesFromDigests(options.committedDigests);
  const catalogue = options.catalogue ?? catalogueShows();
  const byShow = new Map<string, TranscriptDigestEntry[]>();
  const seen = new Set<string>();
  let claimed = 0;
  let duplicates = 0;
  for (const row of staged) {
    const key = `${row.show_id}\u0000${row.guid}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    if (claimedFiles.has(claimKey(row.show_id, corpusSafeKey(row.guid)))) {
      claimed += 1;
      continue;
    }
    const list = byShow.get(row.show_id) ?? [];
    list.push(row);
    byShow.set(row.show_id, list);
  }

  const rows: TranscriptDigestEntry[] = [];
  const perShow: ReconcileResult["perShow"] = [];
  for (const showId of [...byShow.keys()].sort()) {
    const list = byShow.get(showId) ?? [];
    const meta = catalogue.get(showId);
    const showTitle = meta?.title ?? list[0]?.show_title ?? showId;
    const feed = await loadFeed(showId, meta?.feedUrl ?? null, options.offline, {
      cacheDir: options.feedCacheDir,
      fetchImpl: options.fetchImpl,
      needGuids: list.map((r) => r.guid)
    });
    let mintable = 0;
    for (const row of list) {
      const joined = corpusDigestRow(showId, showTitle, { guid: row.guid, cues: row.cues }, feed.get(row.guid));
      if (joined.mintable) mintable += 1;
      rows.push(joined.row);
    }
    perShow.push({ showId, added: list.length, mintable, searchableOnly: list.length - mintable });
  }
  rows.sort(compareCorpusRows);
  return { rows, perShow, claimed, duplicates };
}

/** Whether a corpus-digest row carries the feed fields a mint needs. */
function hasFeedMetadata(row: TranscriptDigestEntry): boolean {
  return Boolean(row.enclosure_url) && typeof row.feed_duration_sec === "number" && row.feed_duration_sec > 0;
}

/**
 * Staged rows merged into the corpus digest's rows, keyed on show + guid (the
 * archive's own key). Every existing row of any show is kept — a staged file
 * describes NEW bodies, not a show's whole truth, so nothing is pruned. A
 * staged row replaces the existing row for its episode, except that a row
 * already carrying feed metadata is never downgraded by a re-join that found
 * none (an `--offline` run, or a feed that has since dropped the episode).
 */
export function mergeStagedRows(existing: readonly TranscriptDigestEntry[], fresh: readonly TranscriptDigestEntry[]): TranscriptDigestEntry[] {
  const byKey = new Map<string, TranscriptDigestEntry>();
  for (const row of existing) byKey.set(`${row.show_id}\u0000${row.guid}`, row);
  for (const row of fresh) {
    const key = `${row.show_id}\u0000${row.guid}`;
    const old = byKey.get(key);
    if (old && hasFeedMetadata(old) && !hasFeedMetadata(row)) continue;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort(compareCorpusRows);
}

export interface FromStagedOptions extends FeedJoinOptions {
  stagedFile: string;
  /** Defaults to data-local/transcripts/corpus-digest.json. */
  corpusDigest?: string;
  committedDigests?: readonly string[];
}

/** --from-staged end to end: read, join, merge, write. */
export async function runFromStaged(options: FromStagedOptions): Promise<StagedJoinResult & { problems: string[]; total: number; bytes: number }> {
  const corpusDigest = options.corpusDigest ?? CORPUS_DIGEST;
  const { rows: staged, problems } = readStagedRows(options.stagedFile);
  const joined = await joinStagedRows(staged, options);
  const merged = mergeStagedRows(readCorpusDigestRows(corpusDigest), joined.rows);
  const bytes = writeCorpusDigest(merged, corpusDigest, STAGED_DIGEST_POLICY);
  return { ...joined, problems, total: merged.length, bytes };
}

/* ---------------------------------------------------------------- legacy */

/** The parts of GV-23's legacy-whisper.mjs this mode calls. */
interface LegacyWhisperModule {
  parseLegacyKey: (key: string) => { key: string; showSlug: string; titleSlug: string; guidSha1_10: string } | null;
  titleSlugs: (title: string) => Set<string>;
  resolveLegacyEpisode: (
    key: { key: string; showSlug: string; titleSlug: string; guidSha1_10: string },
    candidates: Array<{ guid: string; title?: string }>
  ) => { status: "matched" | "unmatched" | "ambiguous"; guid: string | null; reason: string | null; hits: unknown[] };
}

/** GV-23's rules, loaded the way finalizeForay.ts loads check-forays.mjs:
 * one implementation, in tools/, imported as-is. */
async function loadLegacyWhisper(): Promise<LegacyWhisperModule> {
  return (await import("../../../tools/foraycorpus-export/legacy-whisper.mjs")) as unknown as LegacyWhisperModule;
}

/** The legacy keys in a listing: one per line (the first token), blanks and
 * `#` comments skipped, repeats dropped, order kept. */
export function readLegacyKeys(file: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the key listing the operator named (or a test's).
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const key = line.trim().split(/\s+/)[0] ?? "";
    if (key === "" || key.startsWith("#") || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export interface LegacyMapEntry {
  show_id: string;
  guid: string;
  title: string;
  /** Where the answer came from: the show's RSS feed, or foray-db's export. */
  via: "rss" | "foray-db";
}

export interface LegacyUnresolved {
  status: "unmatched" | "ambiguous";
  reason: string;
  /** The catalogue show the key's slug named, when exactly one did. */
  show_id: string | null;
}

/**
 * foray-db's own legacy mapping, exported (transcript_publications rows whose
 * normalized_key is a legacy key). Read from an array of rows (or `{rows}`),
 * each {normalized_key | key, show_id, guid, title?}, or from an object keyed
 * by the legacy key, {key: {show_id, guid, title?}}. A row with no show_id or
 * guid is skipped.
 */
export function readLegacyMapExport(file: string): Map<string, { show_id: string; guid: string; title: string }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the export the operator named (or a test's).
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const out = new Map<string, { show_id: string; guid: string; title: string }>();
  const take = (key: unknown, value: unknown): void => {
    if (typeof key !== "string" || key === "" || !value || typeof value !== "object") return;
    const v = value as { show_id?: unknown; guid?: unknown; title?: unknown };
    if (typeof v.show_id !== "string" || v.show_id === "" || typeof v.guid !== "string" || v.guid === "") return;
    if (!out.has(key)) out.set(key, { show_id: v.show_id, guid: v.guid, title: typeof v.title === "string" ? v.title : "" });
  };
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : null;
  if (rows) {
    for (const row of rows) {
      const r = row as { normalized_key?: unknown; key?: unknown } | null;
      take(r?.normalized_key ?? r?.key, row);
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) take(key, value);
  }
  return out;
}

export interface LegacyMapReport {
  version: 1;
  generated_at: string;
  /** Resolved keys: {key: {show_id, guid, title, via}}. */
  map: Record<string, LegacyMapEntry>;
  /** Every key that did not resolve, with why. */
  unresolved: Record<string, LegacyUnresolved>;
  counts: {
    keys: number;
    byStatus: { matched: number; ambiguous: number; unmatched: number };
    byReason: Record<string, number>;
    byVia: { rss: number; "foray-db": number };
  };
}

export interface ResolveLegacyOptions extends FeedJoinOptions {
  /** foray-db's mapping, which wins over the feed. */
  overrides?: ReadonlyMap<string, { show_id: string; guid: string; title: string }>;
  now?: () => Date;
}

/**
 * THE --resolve-legacy DECISION, per key:
 *   1. a key foray-db's export maps is matched from it (feeds truncate old
 *      episodes; the database remembers them);
 *   2. otherwise the key's show slug must name exactly one catalogue show,
 *      by `titleSlugs(catalogue title)` — slugify, the rule foray-db and
 *      show-map.mjs use, plain and accent-folded (none: unmatched
 *      `show_not_in_catalog`; two: ambiguous `show_slug_multi_show`);
 *   3. that show's feed (`loadFeed`, cached per show, `--offline` honoured)
 *      gives the candidate guids (none: unmatched `no_feed`);
 *   4. GV-23's `resolveLegacyEpisode` decides by sha1(guid)[:10] alone,
 *      matched, ambiguous (two episodes share the prefix) or unmatched.
 */
export async function resolveLegacyKeys(keys: readonly string[], options: ResolveLegacyOptions): Promise<LegacyMapReport> {
  const legacy = await loadLegacyWhisper();
  const catalogue = options.catalogue ?? catalogueShows();
  const overrides = options.overrides ?? new Map<string, { show_id: string; guid: string; title: string }>();

  const showsBySlug = new Map<string, string[]>();
  for (const [showId, meta] of catalogue) {
    for (const slug of legacy.titleSlugs(meta.title)) {
      const list = showsBySlug.get(slug) ?? [];
      if (!list.includes(showId)) list.push(showId);
      showsBySlug.set(slug, list);
    }
  }
  const feeds = new Map<string, Map<string, FeedEpisode>>();
  const feedOf = async (showId: string): Promise<Map<string, FeedEpisode>> => {
    let feed = feeds.get(showId);
    if (!feed) {
      feed = await loadFeed(showId, catalogue.get(showId)?.feedUrl ?? null, options.offline, {
        cacheDir: options.feedCacheDir,
        fetchImpl: options.fetchImpl
      });
      feeds.set(showId, feed);
    }
    return feed;
  };

  const report: LegacyMapReport = {
    version: 1,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    map: {},
    unresolved: {},
    counts: { keys: keys.length, byStatus: { matched: 0, ambiguous: 0, unmatched: 0 }, byReason: {}, byVia: { rss: 0, "foray-db": 0 } }
  };
  const resolved = (key: string, entry: LegacyMapEntry): void => {
    report.map[key] = entry;
    report.counts.byStatus.matched += 1;
    report.counts.byVia[entry.via] += 1;
  };
  const refused = (key: string, status: LegacyUnresolved["status"], reason: string, showId: string | null): void => {
    report.unresolved[key] = { status, reason, show_id: showId };
    report.counts.byStatus[status] += 1;
    report.counts.byReason[reason] = (report.counts.byReason[reason] ?? 0) + 1;
  };

  for (const key of keys) {
    const fromDb = overrides.get(key);
    if (fromDb) {
      resolved(key, { show_id: fromDb.show_id, guid: fromDb.guid, title: fromDb.title, via: "foray-db" });
      continue;
    }
    const parsed = legacy.parseLegacyKey(key);
    if (!parsed) {
      refused(key, "unmatched", "not_a_legacy_key", null);
      continue;
    }
    const shows = showsBySlug.get(parsed.showSlug) ?? [];
    if (shows.length === 0) {
      refused(key, "unmatched", "show_not_in_catalog", null);
      continue;
    }
    if (shows.length > 1) {
      refused(key, "ambiguous", "show_slug_multi_show", null);
      continue;
    }
    const showId = shows[0] as string;
    const feed = await feedOf(showId);
    if (feed.size === 0) {
      refused(key, "unmatched", "no_feed", showId);
      continue;
    }
    const verdict = legacy.resolveLegacyEpisode(
      parsed,
      [...feed.values()].map((e) => ({ guid: e.guid, title: e.title }))
    );
    if (verdict.status === "matched" && verdict.guid !== null) {
      resolved(key, { show_id: showId, guid: verdict.guid, title: feed.get(verdict.guid)?.title ?? "", via: "rss" });
    } else {
      refused(key, verdict.status === "ambiguous" ? "ambiguous" : "unmatched", verdict.reason ?? "unresolved", showId);
    }
  }
  return report;
}

/** Writes JSON to `file` through a temp file, as the corpus digest is written. */
function writeJsonFile(file: string, value: unknown): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a data-local output path (or a test's).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.renameSync(tmp, file);
}

export interface RunResolveLegacyOptions extends ResolveLegacyOptions {
  keysFile: string;
  /** foray-db's export (`--legacy-map-from`), read into `overrides`. */
  legacyMapFrom?: string | null;
  /** Defaults to data-local/passage-index/legacy-map.json. */
  out?: string;
}

/** --resolve-legacy end to end: read the keys (and the export), resolve, write. */
export async function runResolveLegacy(options: RunResolveLegacyOptions): Promise<LegacyMapReport> {
  const keys = readLegacyKeys(options.keysFile);
  const overrides = options.legacyMapFrom ? readLegacyMapExport(options.legacyMapFrom) : options.overrides;
  const report = await resolveLegacyKeys(keys, { ...options, overrides });
  writeJsonFile(options.out ?? DEFAULT_LEGACY_MAP, report);
  return report;
}

/* ---------------------------------------------------------- supply report */

/** Why an archive row cannot mint a clip, in the order the conditions are
 * checked: lineage first (a row the gated stages never search is never minted
 * from), then the RQ-03 DAI verdict, then the row's own feed fields. */
export const MINT_CONDITIONS = ["not-in-catalog", "no-dai-verdict", "no-enclosure", "no-duration", "no-title"] as const;
export type MintRefusal = (typeof MINT_CONDITIONS)[number];

export interface SupplyShowRow {
  show_id: string;
  show_title: string;
  /** Archive rows of the show. */
  rows: number;
  /** Rows the taxonomy lineage gate can admit, so the gated stages can search. */
  searchable: number;
  /** Searchable rows `mintSegmentSource` accepts: a clip can be cut. */
  mintable: number;
  /** The first missing mint condition (MINT_CONDITIONS order) among the
   * show's unmintable rows; null when every row is mintable. */
  reason_not_mintable: MintRefusal | null;
  /** Unmintable rows by their first missing condition. */
  reasons: Partial<Record<MintRefusal, number>>;
}

export interface SupplyReport {
  version: 1;
  generated_at: string;
  totals: { shows: number; rows: number; searchable: number; mintable: number; searchableOnlyShows: number };
  shows: SupplyShowRow[];
}

export interface SupplyReportOptions {
  /** Whether the lineage gate can admit a row. Defaults to
   * `nodesForArchiveEntry(entry).length > 0`, the gated stages' own question. */
  hasLineage?: (entry: TranscriptDigestEntry) => boolean;
  /** The per-show DAI/feed table. Defaults to `loadShowAudioMeta()`. */
  showMeta?: Map<string, ShowAudioMeta>;
  now?: () => Date;
}

/** The first mint condition one row misses, or null when it can mint. The
 * verdict is `mintSegmentSource`'s own; the reason only names which of its
 * refusals applied first. */
export function mintRefusal(entry: TranscriptDigestEntry, searchable: boolean, showMeta: Map<string, ShowAudioMeta>): MintRefusal | null {
  if (!searchable) return "not-in-catalog";
  if (mintSegmentSource(entry, "supply-report", showMeta) !== null) return null;
  if (typeof showMeta.get(String(entry.show_id))?.dai !== "boolean") return "no-dai-verdict";
  const url = typeof entry.enclosure_url === "string" ? entry.enclosure_url.trim() : "";
  if (!url || !/^https:\/\//.test(url) || /[?&](token|auth|api_?key|secret|password|session)=/i.test(url)) return "no-enclosure";
  if (!(typeof entry.feed_duration_sec === "number" && entry.feed_duration_sec > 0)) return "no-duration";
  return "no-title";
}

/** THE --supply-report: per show in the archive, searchable vs mintable. */
export function buildSupplyReport(archive: readonly TranscriptDigestEntry[], options: SupplyReportOptions = {}): SupplyReport {
  const hasLineage = options.hasLineage ?? ((entry: TranscriptDigestEntry) => nodesForArchiveEntry(entry).length > 0);
  const showMeta = options.showMeta ?? loadShowAudioMeta();
  const byShow = new Map<string, SupplyShowRow>();
  for (const entry of archive) {
    const showId = String(entry.show_id);
    let row = byShow.get(showId);
    if (!row) {
      row = { show_id: showId, show_title: String(entry.show_title ?? showId), rows: 0, searchable: 0, mintable: 0, reason_not_mintable: null, reasons: {} };
      byShow.set(showId, row);
    }
    row.rows += 1;
    const searchable = hasLineage(entry);
    if (searchable) row.searchable += 1;
    const refusal = mintRefusal(entry, searchable, showMeta);
    if (refusal === null) {
      row.mintable += 1;
      continue;
    }
    row.reasons[refusal] = (row.reasons[refusal] ?? 0) + 1;
  }
  const shows = [...byShow.values()].sort((a, b) => a.show_id.localeCompare(b.show_id));
  for (const show of shows) show.reason_not_mintable = MINT_CONDITIONS.find((c) => (show.reasons[c] ?? 0) > 0) ?? null;
  return {
    version: 1,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    totals: {
      shows: shows.length,
      rows: shows.reduce((n, s) => n + s.rows, 0),
      searchable: shows.reduce((n, s) => n + s.searchable, 0),
      mintable: shows.reduce((n, s) => n + s.mintable, 0),
      searchableOnlyShows: shows.filter((s) => s.searchable > 0 && s.mintable === 0).length
    },
    shows
  };
}

/** The report as a plain-text table, for a run log or a #1163 comment. */
export function supplyReportTable(report: SupplyReport): string {
  const header = ["show", "rows", "searchable", "mintable", "first missing"];
  const body = report.shows.map((s) => [s.show_id, String(s.rows), String(s.searchable), String(s.mintable), s.reason_not_mintable ?? "-"]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 || i === 4 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ").trimEnd();
  const t = report.totals;
  return [
    line(header),
    ...body.map(line),
    "",
    `${t.shows} shows, ${t.rows} rows: ${t.searchable} searchable, ${t.mintable} mintable; ${t.searchableOnlyShows} show(s) searchable but unable to supply a clip.`
  ].join("\n");
}

/** --supply-report end to end: build, write the JSON, return it. */
export function runSupplyReport(
  options: SupplyReportOptions & { archive?: readonly TranscriptDigestEntry[]; out?: string } = {}
): SupplyReport {
  const report = buildSupplyReport(options.archive ?? loadTranscriptArchive(), options);
  writeJsonFile(options.out ?? DEFAULT_SUPPLY_REPORT, report);
  return report;
}

/** The GV-53 modes, in dependency order: legacy keys (independent), staged
 * rows (which change the archive), then the report over that archive. Returns
 * the exit code: 2, with nothing run or written, when a mode flag was
 * malformed (`WarmModeArgs.errors`); 0 otherwise. */
export async function runWarmModes(modes: WarmModeArgs, offline: boolean): Promise<number> {
  if (modes.errors.length > 0) {
    for (const error of modes.errors) console.error(`warm-transcript-index: ${error}`);
    console.error("nothing was run: a mode flag never falls through to the default warm.");
    return 2;
  }
  const rel = (file: string) => path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  if (modes.resolveLegacy !== null) {
    console.log(`resolving legacy keys in ${modes.resolveLegacy}${modes.legacyMapFrom ? ` (foray-db mapping ${modes.legacyMapFrom} first)` : ""}...`);
    const report = await runResolveLegacy({ keysFile: modes.resolveLegacy, legacyMapFrom: modes.legacyMapFrom, offline });
    const c = report.counts;
    console.log(`  ${c.keys} keys: ${c.byStatus.matched} matched (${c.byVia.rss} rss, ${c.byVia["foray-db"]} foray-db), ${c.byStatus.ambiguous} ambiguous, ${c.byStatus.unmatched} unmatched`);
    for (const [reason, n] of Object.entries(c.byReason).sort()) console.log(`    ${reason}: ${n}`);
    console.log(`  wrote ${rel(DEFAULT_LEGACY_MAP)}`);
  }
  if (modes.fromStaged !== null) {
    console.log(`joining staged rows in ${modes.fromStaged} to their feeds${offline ? " (offline: cached feeds only)" : ""}...`);
    const result = await runFromStaged({ stagedFile: modes.fromStaged, offline });
    for (const problem of result.problems) console.log(`  skipped ${problem}`);
    for (const show of result.perShow) {
      const tail = show.searchableOnly > 0 ? `, ${show.searchableOnly} searchable-only (no feed metadata, cannot mint tape)` : "";
      console.log(`  ${show.showId}: +${show.added} rows, ${show.mintable} mintable${tail}`);
    }
    if (result.claimed > 0) console.log(`  ${result.claimed} staged row(s) already described by a committed digest, left alone`);
    console.log(`  corpus-digest.json now holds ${result.total} rows (${mb(result.bytes)})`);
    /* The archive cache was read before this write; a report below must see it. */
    process.env.FORAY_SKIP_CATALOGUE_CACHE = "1";
  }
  if (modes.supplyReport) {
    console.log("supply report: per show, searchable vs mintable...");
    const report = runSupplyReport();
    console.log(supplyReportTable(report));
    console.log(`  wrote ${rel(DEFAULT_SUPPLY_REPORT)}`);
  }
  return 0;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const args = parseWarmArgs(process.argv.slice(2));
  /* GV-53: a mode runs alone. A streamed box has no bodies to reconcile or
     index (GV-05 already built its caches), so the default warm is skipped. */
  const modes = parseWarmModes(process.argv.slice(2));
  if (anyWarmMode(modes)) {
    process.exitCode = await runWarmModes(modes, args.offline);
    return;
  }
  const startedAt = Date.now();

  if (!args.buildOnly) {
    console.log("reconciling data-local/transcripts/normalized/ against the committed digests...");
    const { rows: fresh, perShow } = await reconcileCorpus({ offline: args.offline, onlyShows: args.shows });
    /* Always written: a --show warm merges into the other shows' rows, and a
       full warm replaces the file even with nothing to add, so stale rows go. */
    const rows = mergeCorpusRows(readCorpusDigestRows(), fresh, args.shows);
    const bytes = writeCorpusDigest(rows);
    if (fresh.length === 0) {
      console.log("  nothing to add: every body on disk already has a committed digest row.");
      console.log(`  corpus-digest.json now holds ${rows.length} rows (${mb(bytes)})`);
    } else {
      for (const show of perShow) {
        const tail = show.searchableOnly > 0 ? `, ${show.searchableOnly} searchable-only (no feed metadata, cannot mint tape)` : "";
        console.log(`  ${show.showId}: +${show.added} rows, ${show.mintable} mintable${tail}`);
      }
      console.log(`  wrote ${rows.length} rows to data-local/transcripts/corpus-digest.json (${mb(bytes)})`);
    }
  }

  /* The archive cache was populated before the corpus digest was written, so
     the index below must be told to read it again. */
  process.env.FORAY_SKIP_CATALOGUE_CACHE = "1";

  const cueProvider = new FileTranscriptCueProvider();
  const textIndex = new FileTranscriptTextIndex({ bodies: cueProvider });

  if (!args.reconcileOnly) {
    console.log("\nbuilding the text index, one show at a time...");
    let episodes = 0;
    let bytes = 0;
    let built = 0;
    for (const { showId, rows } of textIndex.shows().sort((a, b) => b.rows - a.rows)) {
      if (args.shows.length > 0 && !args.shows.includes(showId)) continue;
      const t0 = Date.now();
      const warmed = textIndex.warmShow(showId);
      textIndex.forget(showId);
      const ms = Date.now() - t0;
      if (!warmed) {
        console.log(`  ${showId}: ${rows} archive rows, NO BODIES on this machine (${ms} ms)`);
        continue;
      }
      built += 1;
      episodes += warmed.episodes;
      bytes += warmed.bytes;
      console.log(
        `  ${showId}: ${warmed.episodes} episodes, ${warmed.terms} terms, ${mb(warmed.bytes)} cache, ${(ms / 1000).toFixed(1)} s` +
          ` (peak RSS ${mb(process.memoryUsage().rss)})`
      );
    }
    console.log(`\n  ${built} show(s) indexed, ${episodes} episodes, ${mb(bytes)} of cache.`);
  }

  const coverage = corpusCoverage({
    archive: loadTranscriptArchive(),
    hasBody: (entry) => cueProvider.bodyStat(entry as TranscriptDigestEntry) !== null,
    normalizedRoot: NORMALIZED_ROOT
  });
  console.log(`\n${corpusCoverageLine(coverage)}`);
  console.log(`total ${((Date.now() - startedAt) / 1000).toFixed(1)} s, peak RSS ${mb(process.memoryUsage().rss)}`);
  /* A blind spot left after a warm is the run's problem, not this tool's, but
     it must not look like success. */
  process.exitCode = coverage.blindSpots.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
