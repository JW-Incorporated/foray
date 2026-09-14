import * as fs from "fs";
import * as path from "path";
import { FileTranscriptCueProvider, loadTranscriptArchive, type TranscriptDigestEntry } from "../generation/transcriptArchiveLookup";
import { corpusCoverage, corpusCoverageLine, corpusSafeKey, scanNormalizedCorpus } from "../generation/transcriptCorpus";
import { DEFAULT_FEED_USER_AGENT } from "../feeds/userAgent";
import { FileTranscriptTextIndex } from "../generation/transcriptTextIndex";

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
 * The feed, parsed with two regexes and no XML library.
 *
 * DELIBERATELY SHALLOW. We need exactly guid, title, enclosure url and
 * duration, from feeds that are already known to be well-formed enough for
 * `tools/refresh-feeds.mjs` to have catalogued them. A parser that understands
 * more would be more to keep right; a row this misses simply stays
 * searchable-only, which is the same outcome as `--offline` and is reported the
 * same way.
 */
export function parseFeedEpisodes(xml: string): FeedEpisode[] {
  const out: FeedEpisode[] = [];
  for (const chunk of String(xml).split(/<item[\s>]/).slice(1)) {
    const guid = firstGroup(chunk, /<guid[^>]*>([\s\S]*?)<\/guid>/);
    if (!guid) continue;
    const title = firstGroup(chunk, /<title[^>]*>([\s\S]*?)<\/title>/) ?? "";
    const enclosureUrl = firstGroup(chunk, /<enclosure[^>]*\surl="([^"]+)"/);
    out.push({
      guid: decodeXml(guid),
      title: decodeXml(title),
      enclosureUrl: enclosureUrl ? decodeXml(enclosureUrl) : null,
      durationSec: parseDuration(firstGroup(chunk, /<itunes:duration[^>]*>([\s\S]*?)<\/itunes:duration>/))
    });
  }
  return out;
}

function firstGroup(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m || typeof m[1] !== "string") return null;
  const value = m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
  return value.length > 0 ? value : null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `3501`, `58:21` and `01:02:34` are all durations podcasts publish. */
export function parseDuration(text: string | null): number | null {
  if (!text) return null;
  const parts = text.split(":").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds > 0 ? seconds : null;
}

/** `<show_id>-<10 hex>` is the directory; `<show_id>` is what a digest row says. */
function catalogueShows(): Map<string, { title: string; feedUrl: string | null }> {
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

async function loadFeed(showId: string, feedUrl: string | null, offline: boolean): Promise<Map<string, FeedEpisode>> {
  const cacheFile = path.join(FEED_CACHE, `${showId.replace(/[^a-z0-9_-]+/gi, "-")}.xml`);
  let xml: string | null = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path slugged from a catalogue show id.
    if (fs.existsSync(cacheFile)) xml = fs.readFileSync(cacheFile, "utf8");
  } catch {
    xml = null;
  }
  if (!xml && !offline && feedUrl) {
    try {
      /* The project's ONE outbound identity, imported rather than spelled
         (#316): `tools/segments/politeness.test.mjs` refuses any file under
         `backend/src/` that writes its own, and it is right to — two identities
         is how a publisher blocks half a corpus and nobody can tell which half. */
      const res = await fetch(feedUrl, { headers: { "user-agent": DEFAULT_FEED_USER_AGENT } });
      if (res.ok) {
        xml = await res.text();
        fs.mkdirSync(FEED_CACHE, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
        fs.writeFileSync(cacheFile, xml, "utf8");
      }
    } catch {
      /* A feed that will not answer costs this show its enclosure URLs and
         nothing else. Reported per show, never fatal. */
      xml = null;
    }
  }
  const byGuid = new Map<string, FeedEpisode>();
  if (!xml) return byGuid;
  for (const episode of parseFeedEpisodes(xml)) byGuid.set(episode.guid, episode);
  return byGuid;
}

/** What one body file says about itself. */
function readBody(file: string): { guid: string; cues: number } | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this module's own directory walk.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { guid?: unknown; cues?: unknown };
    if (typeof parsed.guid !== "string" || !Array.isArray(parsed.cues) || parsed.cues.length === 0) return null;
    return { guid: parsed.guid, cues: parsed.cues.length };
  } catch {
    return null;
  }
}

/** The identity of one body file, for the "is this episode already covered"
 * question. Lowercased because a directory listing on Windows is not
 * case-authoritative and `corpusSafeKey` is lowercase by construction. */
function claimKey(showId: string, keyWithoutExtension: string): string {
  return `${String(showId).toLowerCase()}/${String(keyWithoutExtension).toLowerCase()}`;
}

export interface ReconcileResult {
  rows: TranscriptDigestEntry[];
  perShow: Array<{ showId: string; added: number; mintable: number; searchableOnly: number }>;
}

/**
 * Build corpus-digest rows for every body on disk that the COMMITTED digests do
 * not already describe.
 *
 * Keyed on `show_id + guid`, which is the same key `loadTranscriptArchive`
 * dedupes on, so a row here can never shadow a committed one — this pass only
 * ever ADDS episodes to the searchable universe.
 */
export async function reconcileCorpus(options: { offline: boolean; onlyShows: string[] }): Promise<ReconcileResult> {
  /**
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
  const claimedFiles = new Set<string>();
  for (const file of ["data/transcript-digests.json", "data/breadth-transcript-digests.json"]) {
    const full = path.join(REPO_ROOT, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path list.
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { transcripts?: TranscriptDigestEntry[] };
    for (const t of parsed.transcripts ?? []) claimedFiles.add(claimKey(t.show_id, corpusSafeKey(String(t.guid))));
  }

  const catalogue = catalogueShows();
  const rows: TranscriptDigestEntry[] = [];
  const perShow: ReconcileResult["perShow"] = [];

  for (const show of scanNormalizedCorpus(NORMALIZED_ROOT)) {
    if (options.onlyShows.length > 0 && !options.onlyShows.includes(show.showId)) continue;
    const dir = path.join(NORMALIZED_ROOT, show.dirName);
    const meta = catalogue.get(show.showId);
    /* The bodies this show has and the committed digests do not. Read FIRST, so
       a show that needs nothing never causes a network request. */
    const pending: Array<{ guid: string; cues: number }> = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory came from `scanNormalizedCorpus`.
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      /* The cheap test first: a file a committed row already names is not read
         at all. That is what keeps a re-warm of a 2,857-episode show from
         re-parsing 306 MB of JSON to learn it has nothing to do. */
      if (claimedFiles.has(claimKey(show.showId, name.replace(/\.json$/i, "")))) continue;
      const body = readBody(path.join(dir, name));
      if (!body) continue;
      /* And the guid test second, for a body saved under a name no committed
         row maps to but whose guid one of them does carry. */
      if (claimedFiles.has(claimKey(show.showId, corpusSafeKey(body.guid)))) continue;
      pending.push(body);
    }
    if (pending.length === 0) continue;

    const feed = await loadFeed(show.showId, meta?.feedUrl ?? null, options.offline);
    let mintable = 0;
    for (const body of pending) {
      const episode = feed.get(body.guid);
      const row: TranscriptDigestEntry = {
        show_id: show.showId,
        show_title: meta?.title ?? show.showId,
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
      if (episode?.title && episode.enclosureUrl && episode.durationSec) mintable += 1;
      rows.push(row);
    }
    perShow.push({ showId: show.showId, added: pending.length, mintable, searchableOnly: pending.length - mintable });
  }

  rows.sort((a, b) => a.show_id.localeCompare(b.show_id) || a.guid.localeCompare(b.guid));
  return { rows, perShow };
}

function writeCorpusDigest(rows: TranscriptDigestEntry[]): number {
  fs.mkdirSync(path.dirname(CORPUS_DIGEST), { recursive: true });
  const body = JSON.stringify(
    {
      version: 1,
      generated_at: new Date().toISOString(),
      policy:
        "machine-local — describes the transcript bodies under data-local/transcripts/normalized/ that the committed digests do not carry (issue #703). Never committed; rebuild with tools/generation/warm-transcript-index.mjs.",
      summary: { transcripts: rows.length },
      transcripts: rows
    },
    null,
    0
  );
  const tmp = `${CORPUS_DIGEST}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, CORPUS_DIGEST);
  return Buffer.byteLength(body);
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const args = parseWarmArgs(process.argv.slice(2));
  const startedAt = Date.now();

  if (!args.buildOnly) {
    console.log("reconciling data-local/transcripts/normalized/ against the committed digests...");
    const { rows, perShow } = await reconcileCorpus({ offline: args.offline, onlyShows: args.shows });
    if (rows.length === 0) {
      console.log("  nothing to add: every body on disk already has a committed digest row.");
    } else {
      const bytes = writeCorpusDigest(rows);
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
