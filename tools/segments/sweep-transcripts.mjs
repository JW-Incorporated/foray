/* Transcript availability sweep — Lane B (issue #104, epic #102).
   STATIC machinery (committed), keyless, no LLM, no dependencies.

   WHY THIS EXISTS — nothing in this repo currently records where the free
   transcripts are. `tools/refresh/scan.mjs` never reads `<podcast:transcript>`,
   `data/discover.json` items carry no transcript field, and
   `backend/src/feeds/parser.ts` reads the tag on a path that does not produce
   the live catalogue. So "which episodes can we work on for free?" is a guess,
   and every downstream lane — segment extraction (Lane C), Joey's topic
   selection (A10) — is guessing off it. This turns it into a list.

   THE DISTINCTION THAT IS THE WHOLE POINT: `has_timestamps`.
   `text/vtt`, `application/srt`, `application/x-subrip` and `application/json`
   carry a timeline; `text/plain` and `text/html` are prose. A segment boundary
   is a *time*, so a plain-text transcript can tell you an episode discusses
   fusion and can never tell you where that starts (ADR-0007). Format spread
   measured over 208 feeds: vtt 7063, srt 6848, plain 6632, html 1268, json 787,
   x-subrip 621 — plain text is the third most published format, i.e. this
   distinction decides the usable size of the corpus, not a rounding error.
   The preference order below is the same one `parser.ts` uses (issue #103);
   it is restated rather than imported because `tools/` is deliberately
   dependency-free and unbuilt, and backend/ is TypeScript. If one moves, move
   both — `tools/segments/sweep-transcripts.test.mjs` pins this copy.

   NEVER FETCH A TRANSCRIPT BODY. This file indexes availability only, and has
   no code path that requests a `transcript_url`. 8,012 transcribed episodes at
   ~50KB is ~400MB, `data/` is already 44MB, and the extraction pipeline's rule
   is stream-then-discard (docs/curation/segment-extraction-pipeline.md §2).
   Only the index gets committed.

   THE JOIN KEY: `enclosure_url`. Episode rows are keyed by feed `guid`, which
   `data/discover.json` does not carry — its items key on Apple ids. So every
   episode-level join between the two files returned ZERO, and "how many of our
   1,672 curated episodes have a free transcript?" read as "none" when the true
   answer was 158. The enclosure URL is the one field both sides take verbatim
   from the same feed (verified 10/10 on Practical AI), so recording it here is
   what makes the question answerable at all. tools/segments/transcript-coverage.mjs
   is the join; it fails loudly if the match rate collapses again.

   FAILURES ARE NAMED, NEVER SILENT. Every failure mode exits through a
   `SweepError` with a code (`HTTP_429`, `TIMEOUT`, `EMPTY_FEED`, `NOT_RSS`…)
   that lands in the show record and in the run summary; a run where no show
   succeeded exits non-zero. A sweep that reports success while having indexed
   nothing is worse than one that crashes, because the empty index is what
   every later lane reads.

   RESUMABLE BY DESIGN. `data/transcript-progress.json` is rewritten after each
   show, so a killed run resumes at the next show instead of re-fetching 213
   feeds. The breadth tier (19,787 shows) is hours of wall-clock; checkpointing
   is what makes that fine.

   POLITENESS. Concurrency 6 across shows, plus a per-host minimum interval, so
   the many shows sharing one CDN cannot burst it. Honest User-Agent with a
   contact address, backoff that honours `Retry-After` on 429/5xx, hard timeout.

   Usage:
     node tools/segments/sweep-transcripts.mjs
       [--limit N] [--concurrency 6] [--all-episodes] [--retry-failed] [--reset]
       [--catalog PATH] [--out PATH] [--progress PATH]

   Env overrides (mirrors tools/refresh/'s cloud-path-split convention):
     CATALOG_PATH, AVAILABILITY_PATH, TRANSCRIPT_PROGRESS_PATH                */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { durationSeconds, hostOf } from "../refresh/enclosure.mjs";
import { classifyShow, isDaiHost } from "../refresh/dai.mjs";
import { UA, awaitHostSlot, waitBeforeRetry } from "./politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Re-exported so existing importers keep working; it is defined in
   ./politeness.mjs, which is also where the per-host gate and the backoff
   live now. They were duplicated into fetch-transcripts.mjs and had already
   drifted (the copy lost the jitter) while sharing the same two bugs. */
export { UA };
const FEED_TIMEOUT_MS = 30_000; // feeds run to several MB; the 15s used elsewhere times out on the long tail
const MAX_ATTEMPTS = 3;

/* Transcript formats that carry a timeline, in preference order. Mirrors
   TIMED_TRANSCRIPT_TYPES in backend/src/feeds/parser.ts (issue #103). */
export const TIMED_TRANSCRIPT_TYPES = ["text/vtt", "application/srt", "application/x-subrip", "application/json"];

/* Prose formats — known and useless for anchoring. Listed explicitly so an
   unrecognised type reports as "unknown" rather than being silently filed as
   prose; a new timestamped format should show up as a question, not a loss. */
export const PROSE_TRANSCRIPT_TYPES = ["text/plain", "text/html"];

export class SweepError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SweepError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- parsing --
// Regex, not an XML parser, because tools/ has no dependencies and no build
// step (package.json says so deliberately). We read six fields out of a feed;
// the parser scan.mjs borrows from backend/node_modules is not worth dragging
// into a script that must run standalone in CI.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

export function decodeEntities(raw) {
  if (raw == null) return null;
  return String(raw).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Reads one attribute off a raw start-tag string. Single or double quoted,
    entity-decoded — `&amp;` in a URL is the common case, and a transcript URL
    that keeps its literal `&amp;` 404s. */
export function attrOf(tag, name) {
  if (!tag) return null;
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  const raw = m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  if (raw == null) return null;
  const v = decodeEntities(raw).trim();
  return v || null;
}

function textOf(itemXml, localName) {
  // Namespace-prefix-agnostic: most feeds write `itunes:duration`, a few bind
  // the namespace to another prefix, and the prefix carries no meaning for us.
  const m = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, "i").exec(itemXml);
  if (!m) return null;
  const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const v = decodeEntities(inner).replace(/\s+/g, " ").trim();
  return v || null;
}

function tagsOf(itemXml, localName) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*?/?>`, "gi");
  return itemXml.match(re) || [];
}

/** "text/vtt; charset=utf-8" -> "text/vtt". Null for a missing attribute, so a
    malformed tag fails to match rather than throwing. */
export function normalizeMimeType(raw) {
  if (raw == null) return null;
  const base = String(raw).split(";")[0].trim().toLowerCase();
  return base || null;
}

/** The load-bearing call. True only for formats that carry a timeline.
    Unknown/absent types are false: claiming a boundary we cannot resolve is
    the failure that shows up at playback, long after this run. */
export function hasTimestamps(type) {
  const t = normalizeMimeType(type);
  return t !== null && TIMED_TRANSCRIPT_TYPES.includes(t);
}

/** Picks the transcript a segment extractor should use: best timed format
    available, else the first tag at all (recorded so the episode still shows
    up as "has a transcript, cannot anchor it"). Episodes publish ~2.9 tags
    each, so this choice is made often and rarely trivial. */
export function pickTranscript(transcripts) {
  const usable = (transcripts || []).filter((t) => t.url);
  if (usable.length === 0) return null;
  for (const want of TIMED_TRANSCRIPT_TYPES) {
    const hit = usable.find((t) => t.type === want);
    if (hit) return hit;
  }
  return usable[0];
}

/** Parses a feed body into `{ episodes, sample_enclosure_url }`.
    Throws a coded SweepError rather than returning an empty list — an empty
    result and a broken feed must never look the same to the caller. */
export function parseFeed(xml) {
  const body = String(xml || "");
  if (!/<\s*(rss|feed|channel)\b/i.test(body)) {
    throw new SweepError("NOT_XML", `response is not a feed (starts with ${JSON.stringify(body.slice(0, 40))})`);
  }
  const itemBlocks = body.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi);
  if (!itemBlocks) {
    if (/<entry\b/i.test(body)) throw new SweepError("NOT_RSS", "Atom feed (<entry>); this sweep reads RSS <item>");
    throw new SweepError("EMPTY_FEED", "feed parsed but contains zero <item> entries");
  }

  let sample_enclosure_url = null;
  const episodes = itemBlocks.map((itemXml, idx) => {
    const enclosure = tagsOf(itemXml, "enclosure")[0] || null;
    const enclosureUrl = enclosure ? attrOf(enclosure, "url") : null;
    if (!sample_enclosure_url && enclosureUrl) sample_enclosure_url = enclosureUrl;

    const transcripts = tagsOf(itemXml, "transcript")
      .map((t) => ({ url: attrOf(t, "url"), type: normalizeMimeType(attrOf(t, "type")) }))
      .filter((t) => t.url);
    const preferred = pickTranscript(transcripts);
    const chapters = tagsOf(itemXml, "chapters").map((t) => attrOf(t, "url")).find(Boolean) || null;

    return {
      guid: textOf(itemXml, "guid") || enclosureUrl || `item-${idx}`,
      enclosure_url: enclosureUrl,
      title: textOf(itemXml, "title"),
      pub_date: textOf(itemXml, "pubDate"),
      duration_sec: durationSeconds(textOf(itemXml, "duration")),
      transcript_url: preferred ? preferred.url : null,
      transcript_type: preferred ? preferred.type : null,
      has_timestamps: preferred ? hasTimestamps(preferred.type) : false,
      transcript_types: transcripts.map((t) => t.type),
      chapters_url: chapters,
    };
  });

  return { episodes, sample_enclosure_url };
}

// ------------------------------------------------------------- politeness --

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetches a feed body. Retries 429/5xx/network with backoff; 4xx other than
    429 is permanent and fails immediately — retrying a 404 is just rudeness
    with extra steps. */
async function fetchFeed(url, { attempts = MAX_ATTEMPTS, timeoutMs = FEED_TIMEOUT_MS, log = () => {} } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await awaitHostSlot(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
        redirect: "follow",
        signal: ctl.signal,
      });
      if (res.ok) return await res.text();

      const err = new SweepError(`HTTP_${res.status}`, `${res.statusText || "request failed"} for ${url}`);
      if (res.status !== 429 && res.status < 500) throw err; // permanent — do not retry
      lastError = err;
      if (attempt < attempts) {
        // waitBeforeRetry pushes the gate for the WHOLE host, so a 429 quiets
        // every worker rather than only the one that was told to wait.
        const wait = waitBeforeRetry(url, res, attempt);
        log(`    retry ${attempt}/${attempts - 1} in ${Math.round(wait / 1000)}s (${err.code})`);
        await sleep(wait);
      }
    } catch (e) {
      if (e instanceof SweepError && e.code.startsWith("HTTP_") && e.code !== "HTTP_429") throw e;
      // `fetch failed` on its own names nothing — the cause carries the DNS or
      // TLS code that says whether this feed is dead or we are.
      const cause = e?.cause?.code || e?.cause?.message;
      lastError = e.name === "AbortError"
        ? new SweepError("TIMEOUT", `no response in ${timeoutMs}ms from ${url}`)
        : e instanceof SweepError
          ? e
          : new SweepError("NETWORK", `${e.message}${cause ? ` (${cause})` : ""} for ${url}`);
      if (attempt < attempts) await sleep(waitBeforeRetry(url, null, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// ------------------------------------------------------------- checkpoints --

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Write via a temp file + rename so a kill mid-write cannot leave a truncated
    checkpoint — the one corruption that would turn "resumes" into "restarts". */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function emptyProgress() {
  return { version: 1, started_at: new Date().toISOString(), updated_at: null, shows: {} };
}

/** A corrupt or unreadable checkpoint is reported, never silently discarded:
    dropping it costs an hour of re-fetching and looks like a fresh run. */
export function loadProgress(path) {
  if (!existsSync(path)) return emptyProgress();
  const p = readJson(path);
  if (!p || typeof p !== "object" || typeof p.shows !== "object" || p.shows === null) {
    throw new SweepError("BAD_CHECKPOINT", `${path} exists but has no "shows" map; move it aside or pass --reset`);
  }
  return { version: p.version ?? 1, started_at: p.started_at ?? new Date().toISOString(), updated_at: p.updated_at ?? null, shows: p.shows };
}

/** The resume rule: a show already recorded `ok` is done. A show recorded as
    an error is also skipped by default — otherwise every run re-hammers the
    same dead feeds — but `--retry-failed` puts them back in. */
export function pendingShows(shows, progress, { retryFailed = false } = {}) {
  return shows.filter((s) => {
    const done = progress.shows[String(s.show_id ?? s.apple_collection_id)];
    if (!done) return true;
    return retryFailed && done.status === "error";
  });
}

// ---------------------------------------------------------------- sweeping --

/** Per-show DAI verdict. The declared enclosure host is checked against the
    known-DAI list first and, when it already matches, no request is made at
    all: ~38% of this catalogue hides behind measurement prefixes and needs the
    redirect followed, the rest does not, and the cheapest polite request is
    the one you skip. Falls back to `classifyShow`, which follows redirects. */
async function resolveDai(sampleEnclosureUrl) {
  if (!sampleEnclosureUrl) {
    return { dai_suspected: null, dai_reason: "no enclosure url in feed", enclosure_host: null };
  }
  const declared = hostOf(sampleEnclosureUrl);
  if (declared && isDaiHost(declared)) {
    return { dai_suspected: true, dai_reason: `host:${declared} (declared, no resolve needed)`, enclosure_host: declared };
  }
  await awaitHostSlot(sampleEnclosureUrl);
  const verdict = await classifyShow(sampleEnclosureUrl, { userAgent: UA, timeoutMs: 15_000 });
  return { dai_suspected: verdict.dai, dai_reason: verdict.reason, enclosure_host: verdict.resolved_host };
}

export function summarizeShow(show, episodes) {
  const types = {};
  let with_transcript = 0, with_timed_transcript = 0, with_chapters = 0, transcript_tags = 0;
  for (const ep of episodes) {
    if (ep.transcript_url) with_transcript++;
    if (ep.has_timestamps) with_timed_transcript++;
    if (ep.chapters_url) with_chapters++;
    for (const t of ep.transcript_types) {
      transcript_tags++;
      types[t || "unknown"] = (types[t || "unknown"] || 0) + 1;
    }
  }
  return {
    ...show,
    episodes_total: episodes.length,
    episodes_with_transcript: with_transcript,
    episodes_with_timed_transcript: with_timed_transcript,
    episodes_with_chapters: with_chapters,
    transcript_tags,
    transcript_types: types,
  };
}

/** One show, end to end. Fetch feed -> parse -> DAI verdict -> record.
    Only the actionable episodes are kept by default (see `allEpisodes`): the
    213 curated feeds hold ~83k episodes and ~90% of them have neither a
    transcript nor chapters, so storing them would inflate a 2MB index to 12MB
    of rows no downstream lane can do anything with. Counts for every episode
    are kept regardless, which is what the coverage numbers are computed from. */
export async function sweepShow(show, { allEpisodes = false, log = () => {} } = {}) {
  const base = {
    show_id: show.show_id ?? String(show.apple_collection_id),
    apple_collection_id: show.apple_collection_id ?? null,
    title: show.title ?? null,
    feed_url: show.feed_url,
    swept_at: new Date().toISOString(),
  };
  try {
    const xml = await fetchFeed(show.feed_url, { log });
    const { episodes, sample_enclosure_url } = parseFeed(xml);
    const dai = await resolveDai(sample_enclosure_url);
    const kept = allEpisodes ? episodes : episodes.filter((e) => e.transcript_url || e.chapters_url);
    return {
      ...summarizeShow({ ...base, status: "ok", error: null, error_code: null, ...dai }, episodes),
      episode_scope: allEpisodes ? "all" : "with_transcript_or_chapters",
      episodes: kept,
    };
  } catch (e) {
    const err = e instanceof SweepError ? e : new SweepError("UNEXPECTED", e.message);
    return {
      ...base,
      status: "error",
      error: err.message,
      error_code: err.code,
      dai_suspected: null,
      dai_reason: null,
      enclosure_host: null,
      episodes_total: 0,
      episodes_with_transcript: 0,
      episodes_with_timed_transcript: 0,
      episodes_with_chapters: 0,
      transcript_tags: 0,
      transcript_types: {},
      episodes: [],
    };
  }
}

/** Rolls the per-show records into the numbers the epic actually argues over:
    transcript coverage overall, and split by DAI, where the 2026-08-11 probe
    measured 13.4% vs 0.7%. A run that disagrees wildly with that is a bug
    report, not a finding. */
export function summarizeRun(showRecords) {
  const s = {
    shows_total: showRecords.length,
    shows_ok: 0,
    shows_failed: 0,
    episodes_total: 0,
    episodes_with_transcript: 0,
    episodes_with_timed_transcript: 0,
    episodes_with_chapters: 0,
    transcript_tags: 0,
    transcript_types: {},
    error_codes: {},
    dai: { shows: 0, episodes: 0, episodes_with_transcript: 0 },
    non_dai: { shows: 0, episodes: 0, episodes_with_transcript: 0 },
    dai_unknown: { shows: 0, episodes: 0, episodes_with_transcript: 0 },
  };
  for (const r of showRecords) {
    if (r.status === "ok") s.shows_ok++;
    else {
      s.shows_failed++;
      s.error_codes[r.error_code || "UNKNOWN"] = (s.error_codes[r.error_code || "UNKNOWN"] || 0) + 1;
      continue;
    }
    s.episodes_total += r.episodes_total;
    s.episodes_with_transcript += r.episodes_with_transcript;
    s.episodes_with_timed_transcript += r.episodes_with_timed_transcript;
    s.episodes_with_chapters += r.episodes_with_chapters;
    s.transcript_tags += r.transcript_tags;
    for (const [t, n] of Object.entries(r.transcript_types || {})) s.transcript_types[t] = (s.transcript_types[t] || 0) + n;

    const bucket = r.dai_suspected === true ? s.dai : r.dai_suspected === false ? s.non_dai : s.dai_unknown;
    bucket.shows++;
    bucket.episodes += r.episodes_total;
    bucket.episodes_with_transcript += r.episodes_with_transcript;
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  s.transcript_coverage_pct = pct(s.episodes_with_transcript, s.episodes_total);
  s.timed_transcript_coverage_pct = pct(s.episodes_with_timed_transcript, s.episodes_total);
  s.chapters_coverage_pct = pct(s.episodes_with_chapters, s.episodes_total);
  s.dai.transcript_coverage_pct = pct(s.dai.episodes_with_transcript, s.dai.episodes);
  s.non_dai.transcript_coverage_pct = pct(s.non_dai.episodes_with_transcript, s.non_dai.episodes);
  s.dai_unknown.transcript_coverage_pct = pct(s.dai_unknown.episodes_with_transcript, s.dai_unknown.episodes);
  s.transcript_tags_per_transcribed_episode = s.episodes_with_transcript
    ? Math.round((s.transcript_tags / s.episodes_with_transcript) * 100) / 100
    : 0;
  return s;
}

// -------------------------------------------------------------------- main --

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    limit: Number(get("--limit", "Infinity")),
    concurrency: Math.max(1, Number(get("--concurrency", "6"))),
    allEpisodes: argv.includes("--all-episodes"),
    retryFailed: argv.includes("--retry-failed"),
    reset: argv.includes("--reset"),
    catalog: get("--catalog", null),
    out: get("--out", null),
    progress: get("--progress", null),
  };
}

function envPath(name, override, ...def) {
  if (override) return resolvePath(process.cwd(), override);
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = envPath("CATALOG_PATH", args.catalog, "data", "catalog.json");
  const outPath = envPath("AVAILABILITY_PATH", args.out, "data", "transcript-availability.json");
  const progressPath = envPath("TRANSCRIPT_PROGRESS_PATH", args.progress, "data", "transcript-progress.json");

  const catalog = readJson(catalogPath);
  const shows = (catalog.shows || []).filter((s) => s.feed_url).slice(0, args.limit);
  if (shows.length === 0) throw new SweepError("NO_SHOWS", `${catalogPath} yielded zero shows with a feed_url`);

  const progress = args.reset ? emptyProgress() : loadProgress(progressPath);
  const queue = pendingShows(shows, progress, { retryFailed: args.retryFailed });
  console.log(`sweeping ${queue.length} show(s) of ${shows.length} (${shows.length - queue.length} already checkpointed), concurrency ${args.concurrency}`);

  let done = 0;
  const total = queue.length;
  const worker = async () => {
    for (;;) {
      const show = queue.shift();
      if (!show) return;
      const record = await sweepShow(show, { allEpisodes: args.allEpisodes, log: (m) => console.log(m) });
      progress.shows[record.show_id] = record;
      progress.updated_at = new Date().toISOString();
      writeJsonAtomic(progressPath, progress); // checkpoint after EVERY show — this is the resume guarantee
      done++;
      const tag = record.status === "ok"
        ? `${record.episodes_with_transcript}/${record.episodes_total} transcripts (${record.episodes_with_timed_transcript} timed)${record.dai_suspected ? " dai" : ""}`
        : `FAILED ${record.error}`;
      console.log(`  [${done}/${total}] ${record.title ?? record.show_id}: ${tag}`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  // Emit in catalog order, so the committed file diffs cleanly run to run.
  const records = shows.map((s) => progress.shows[String(s.show_id ?? s.apple_collection_id)]).filter(Boolean);
  const summary = summarizeRun(records);
  if (summary.shows_ok === 0) {
    throw new SweepError("ALL_SHOWS_FAILED", `${summary.shows_failed} show(s) swept, none succeeded (${JSON.stringify(summary.error_codes)}) — refusing to write an empty index`);
  }

  writeJsonAtomic(outPath, {
    version: 1,
    generated_at: new Date().toISOString(),
    source_catalog: catalogPath.slice(ROOT.length + 1).replace(/\\/g, "/"),
    policy: "availability index only — transcript bodies are never fetched or stored (issue #104)",
    episode_scope: args.allEpisodes ? "all" : "with_transcript_or_chapters",
    summary,
    shows: records,
  });

  console.log(`\n${summary.shows_ok} ok / ${summary.shows_failed} failed; ${summary.episodes_total} episodes`);
  console.log(`  transcripts: ${summary.episodes_with_transcript} (${summary.transcript_coverage_pct}%), of which timed: ${summary.episodes_with_timed_transcript} (${summary.timed_transcript_coverage_pct}%)`);
  console.log(`  dai ${summary.dai.transcript_coverage_pct}% of ${summary.dai.episodes} | non-dai ${summary.non_dai.transcript_coverage_pct}% of ${summary.non_dai.episodes} | unknown-dai ${summary.dai_unknown.transcript_coverage_pct}% of ${summary.dai_unknown.episodes}`);
  console.log(`  formats: ${Object.entries(summary.transcript_types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (summary.shows_failed) console.log(`  failures: ${JSON.stringify(summary.error_codes)}`);
  console.log(`SWEEP_COMPLETE: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e instanceof SweepError ? e.message : e);
    process.exit(1);
  });
}
