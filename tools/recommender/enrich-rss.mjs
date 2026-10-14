/* RSS metadata enrichment for the recommender's evidence packs (RV-04,
   docs/roadmap/recommender-v1.md; D3).

   WHY THIS EXISTS. 26,340 breadth shows carry a title, an Apple genre and a
   150-char blurb and NO description at all, so every one of them rates at the
   `show-metadata` tier (confidence capped at 0.5). A show's own feed already
   says what it is: the channel description and the last few episode titles and
   descriptions. Fetching those once, politely, lifts a show to
   `episode-metadata` (>= 5 described episodes, `evidence.mjs` RV-03) without a
   transcript.

   WHAT IT WRITES. One file per show, `data-local/recommender/rss/<show_key>.json`
   (never committed; data-local/ is gitignored):
     ok:     { fetched_at, status: "ok", description, episodes: [{ title,
               description, duration_min, published_at }] }   (10 newest first)
     failed: { fetched_at, status: "failed", error }
   A failed file counts as cached, so a dead feed is not asked again until it is
   older than --max-age-days.

   WHAT IT NEVER DOES (#108). It fetches the feed URL and nothing else: no
   enclosure, no transcript (`tools/segments/fetch-transcripts.mjs` is the only
   transcript fetcher), no artwork. The cache keeps no enclosure URL, guid or
   link, and no network/publisher name (D7: raters never see artist_name).

   POLITENESS. Every request goes through `tools/segments/politeness.mjs`:
   `awaitHostSlot` before each attempt (MIN_HOST_INTERVAL_MS per host, across
   workers), `UA` and `ACCEPT_LANGUAGE`, `waitBeforeRetry` on 429/5xx (which
   holds the WHOLE host, so one 429 quiets every worker), at most 3 attempts.
   Bodies are read through `readResponseCapped` (20 MB) under a 20 s timeout,
   the `fetchFeedCapped` numbers of `tools/harvest-episodes.mjs`. Never run it
   alongside Joey's crawler (HUMAN-ACTIONS #140).

   Usage:
     node tools/recommender/enrich-rss.mjs --keys <file.json | curated | gold>
       [--concurrency 4] [--max-age-days 30] [--limit N] [--dry-run]

   --keys curated  every data/catalog.json row with a feed_url (key = show_id)
   --keys gold     data/recommender/gold-set.json's shows[].show_key (RV-07)
   --keys <file>   a JSON array of show keys (or of { show_key, feed_url }),
                   or any { shows: [...] } of the same; a key without a
                   feed_url is looked up in the curated catalogue (show_id) and
                   then the breadth catalogue (String(apple_collection_id)).

   Paths are overridable for tests: RECOMMENDER_CATALOG_PATH,
   RECOMMENDER_BREADTH_PATH, RECOMMENDER_GOLD_SET_PATH, RECOMMENDER_RSS_DIR.

   Prints one JSON line { fetched, cached, failed, skipped } (plus would_fetch
   under --dry-run) and exits 0 on any outcome; 1 only on a usage error or a
   missing feed parser (a run without backend/node_modules would otherwise mark
   every feed failed for 30 days). Calls no model. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { ACCEPT_LANGUAGE, UA, awaitHostSlot, discardBody, waitBeforeRetry } from "../segments/politeness.mjs";
import { BodyTooLargeError, MAX_FEED_BYTES, readResponseCapped } from "../refresh/fetch-limits.mjs";
import { decodeEntities } from "../refresh/entities.mjs";
import { parseFeed } from "../harvest-episodes.mjs";
import { streamJsonArray } from "../segments/rank-breadth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EPISODES_KEPT = 10;
export const MAX_CHANNEL_DESCRIPTION_CHARS = 600;
export const MAX_ATTEMPTS = 3;
export const FEED_TIMEOUT_MS = 20_000; // fetchFeedCapped's default, harvest-episodes' number
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_ERROR_CHARS = 300;

/** A show key is a file name here, so it must be one: an apple id or a slug. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : join(ROOT, def));

/* ---------------------------------------------------------------- parsing */

const stripTags = (s) => s.replace(/<[^>]*>/g, " ");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const unCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/** The channel's own description: `<description>` (else `<itunes:summary>`) as a
    direct child of `<channel>`, read only from the text BEFORE the first `<item>`
    so an episode's description can never stand in for the show's. CDATA
    unwrapped, entities decoded, HTML stripped, capped at 600 chars. Null when
    the channel has neither. Regex on the raw XML on purpose: parseFeed keeps
    only items, and this needs no parser. */
export function channelDescription(xml) {
  const head = String(xml ?? "");
  const channelAt = head.search(/<channel[\s>]/i);
  if (channelAt < 0) return null;
  const itemAt = head.slice(channelAt).search(/<item[\s>]/i);
  const preamble = itemAt < 0 ? head.slice(channelAt) : head.slice(channelAt, channelAt + itemAt);
  for (const tag of ["description", "itunes:summary"]) {
    const m = preamble.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) continue;
    // Decode first so an entity-escaped tag (&lt;p&gt;) is stripped too.
    const text = squash(stripTags(decodeEntities(unCdata(m[1])) ?? ""));
    if (text) return text.slice(0, MAX_CHANNEL_DESCRIPTION_CHARS);
  }
  return null;
}

/** The newest EPISODES_KEPT episodes, newest first, in the cache's four fields.
    `parse` is parseFeed from harvest-episodes.mjs (descriptions already HTML-
    stripped and cut at 280 chars by its episodeOf; that cap is inherited, not
    restated). Null when the document is not RSS. */
export function episodesForCache(xml, { parse = parseFeed } = {}) {
  const parsed = parse(xml);
  if (!parsed) return null;
  return parsed
    .map((e, i) => ({ e, i }))
    // Newest first by date; undated episodes after dated ones, in feed order.
    .sort((a, b) => {
      const da = a.e.published_at || "";
      const db = b.e.published_at || "";
      if (da !== db) return da < db ? 1 : -1;
      return a.i - b.i;
    })
    .slice(0, EPISODES_KEPT)
    .map(({ e }) => ({
      title: decodeEntities(e.title) ?? null,
      // Decoded, then stripped again: an entity-escaped tag (&lt;b&gt;) only
      // becomes a tag once decoded. Neither step can lengthen the text.
      description: squash(stripTags(decodeEntities(e.description || ""))),
      duration_min: e.duration_min ?? null,
      published_at: e.published_at ?? null,
    }));
}

/* ------------------------------------------------------------------ cache */

export function cachePath(dir, key) {
  return join(dir, `${key}.json`);
}

/** The cache file, or null when absent or unreadable (an unreadable file is
    simply refetched and overwritten). */
export function readCache(file) {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/** True when the file was written less than maxAgeDays ago, whatever its status. */
export function isFresh(cache, nowMs, maxAgeDays) {
  const at = Date.parse(cache?.fetched_at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < maxAgeDays * DAY_MS;
}

/** Temp file + rename, as qwen-select.mjs's writeAtomic: a killed run never
    leaves a half-written cache file for evidence.mjs to read. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const writeCache = (file, doc) => writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);

/* ------------------------------------------------------------------ fetch */

export class FeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeedError";
    this.code = code;
  }
}

/** One feed, politely: the host slot before every attempt, UA and
    Accept-Language, 429/5xx and network errors retried through waitBeforeRetry
    (which holds the whole host; the next awaitHostSlot then waits it out), any
    other HTTP status and an oversize body final. Returns the body text. */
export async function fetchFeedPolitely(url, opts = {}) {
  const {
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
    random = Math.random,
    attempts = MAX_ATTEMPTS,
    timeoutMs = FEED_TIMEOUT_MS,
    maxBytes = MAX_FEED_BYTES,
  } = opts;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await awaitHostSlot(url, { sleep, now });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res = null;
    try {
      res = await fetchImpl(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": ACCEPT_LANGUAGE,
          Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        },
        redirect: "follow",
        signal: ctl.signal,
      });
      if (res.ok) return await readResponseCapped(res, ctl, maxBytes);
      await discardBody(res);
      const err = new FeedError(`HTTP_${res.status}`, `HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw err; // permanent
      lastError = err;
    } catch (e) {
      if (e instanceof BodyTooLargeError) throw new FeedError("TOO_LARGE", e.message);
      if (e instanceof FeedError && e.code !== "HTTP_429" && !/^HTTP_5/.test(e.code)) throw e;
      if (!(e instanceof FeedError)) {
        const cause = e?.cause?.code || e?.cause?.message;
        lastError = e?.name === "AbortError"
          ? new FeedError("TIMEOUT", `no response in ${timeoutMs}ms`)
          : new FeedError("NETWORK", `${e?.message || e}${cause ? ` (${cause})` : ""}`);
        res = null;
      }
    } finally {
      clearTimeout(timer);
    }
    // Every retryable outcome holds the host, the last attempt's too: a final
    // 429's Retry-After must still quiet the next worker on this host.
    // waitBeforeRetry only moves the host gate; it never sleeps.
    waitBeforeRetry(url, res, attempt, { now, random });
  }
  throw lastError;
}

const isFeedUrl = (u) => {
  try {
    const { protocol } = new URL(String(u));
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** One show -> "fetched" | "cached" | "failed" | "skipped" | "would_fetch".
    Fetch and parse failures are recorded in the cache file; anything else
    (a write failure, a missing parser module) is thrown. */
export async function enrichShow(show, opts = {}) {
  const { dir, maxAgeDays = DEFAULT_MAX_AGE_DAYS, dryRun = false, now = Date.now, parse = parseFeed } = opts;
  const key = show?.show_key == null ? "" : String(show.show_key);
  if (!SAFE_KEY.test(key) || !isFeedUrl(show?.feed_url)) return "skipped";
  const file = cachePath(dir, key);
  const cached = readCache(file);
  if (cached && isFresh(cached, now(), maxAgeDays)) return "cached";
  if (dryRun) return "would_fetch";

  let doc;
  try {
    const xml = await fetchFeedPolitely(show.feed_url, opts);
    const episodes = episodesForCache(xml, { parse });
    if (!episodes) throw new FeedError("NOT_RSS", "not an RSS document");
    doc = { fetched_at: new Date(now()).toISOString(), status: "ok", description: channelDescription(xml), episodes };
  } catch (e) {
    if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") throw e;
    const error = `${e?.code ? `${e.code}: ` : ""}${e?.message || e}`.slice(0, MAX_ERROR_CHARS);
    writeCache(file, { fetched_at: new Date(now()).toISOString(), status: "failed", error });
    return "failed";
  }
  writeCache(file, doc);
  return "fetched";
}

/** Every show through a pool of `concurrency` workers; the per-host gate in
    politeness.mjs is shared by all of them. Returns the counts. */
export async function enrichAll(shows, opts = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, dryRun = false, log = () => {} } = opts;
  const counts = { fetched: 0, cached: 0, failed: 0, skipped: 0 };
  if (dryRun) counts.would_fetch = 0;
  let next = 0;
  const worker = async () => {
    while (next < shows.length) {
      const show = shows[next++];
      const outcome = await enrichShow(show, opts);
      counts[outcome] += 1;
      if (outcome === "fetched" || outcome === "failed") log(`${outcome} ${show.show_key}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, shows.length || 1)) }, worker));
  return counts;
}

/* ------------------------------------------------------------------- keys */

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Every curated row with a feed_url, keyed by show_id. */
export function curatedShows(catalogPath) {
  return (readJson(catalogPath).shows || [])
    .filter((s) => s.show_id && s.feed_url)
    .map((s) => ({ show_key: String(s.show_id), feed_url: s.feed_url }));
}

/** A keys document (an array, or { shows: [...] }) -> [{ show_key, feed_url? }]. */
export function keyEntries(doc) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.shows) ? doc.shows : null;
  if (!list) throw new Error("keys file must be a JSON array or { shows: [...] }");
  return list.map((x) => (typeof x === "object" && x !== null
    ? { show_key: x.show_key == null ? null : String(x.show_key), feed_url: x.feed_url ?? null }
    : { show_key: String(x), feed_url: null }));
}

/** Fills each entry's feed_url: curated by show_id first, then breadth by
    String(apple_collection_id). The 20 MB breadth file is streamed, and only
    when a key is still unresolved. An unresolvable key keeps feed_url null and
    is counted skipped. Duplicate keys are dropped. */
export function resolveFeeds(entries, { catalogPath, breadthPath, stream = streamJsonArray } = {}) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e.show_key || seen.has(e.show_key)) continue;
    seen.add(e.show_key);
    out.push({ show_key: e.show_key, feed_url: e.feed_url || null });
  }
  let missing = out.filter((e) => !e.feed_url);
  if (missing.length && catalogPath && existsSync(catalogPath)) {
    const byId = new Map(curatedShows(catalogPath).map((s) => [s.show_key, s.feed_url]));
    for (const e of missing) if (byId.has(e.show_key)) e.feed_url = byId.get(e.show_key);
    missing = missing.filter((e) => !e.feed_url);
  }
  if (missing.length && breadthPath && existsSync(breadthPath)) {
    const want = new Map(missing.map((e) => [e.show_key, e]));
    for (const row of stream(breadthPath, "shows")) {
      const e = want.get(String(row.apple_collection_id));
      if (e && row.feed_url) {
        e.feed_url = row.feed_url;
        want.delete(e.show_key);
        if (!want.size) break;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------- CLI */

export function parseArgs(argv) {
  const args = { keys: null, concurrency: DEFAULT_CONCURRENCY, maxAgeDays: DEFAULT_MAX_AGE_DAYS, limit: null, dryRun: false };
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") args.keys = argv[++i];
    else if (a === "--concurrency") args.concurrency = Math.max(1, Math.floor(num(a, argv[++i])));
    else if (a === "--max-age-days") args.maxAgeDays = num(a, argv[++i]);
    else if (a === "--limit") args.limit = Math.floor(num(a, argv[++i]));
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.keys) throw new Error("--keys <file.json | curated | gold> is required");
  return args;
}

const hasParser = () => {
  try {
    createRequire(join(ROOT, "backend", "package.json")).resolve("fast-xml-parser");
    return true;
  } catch {
    return false;
  }
};

export async function main(argv = process.argv.slice(2), opts = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`enrich-rss: ${e.message}`);
    return 1;
  }
  const catalogPath = envPath("RECOMMENDER_CATALOG_PATH", "data/catalog.json");
  const breadthPath = envPath("RECOMMENDER_BREADTH_PATH", "data/catalog-breadth.json");
  const goldPath = envPath("RECOMMENDER_GOLD_SET_PATH", "data/recommender/gold-set.json");
  const dir = envPath("RECOMMENDER_RSS_DIR", "data-local/recommender/rss");

  if (!args.dryRun && !(opts.hasParser ?? hasParser)()) {
    console.error("enrich-rss: fast-xml-parser is not installed; run `npm ci` in backend/ first (nothing fetched).");
    return 1;
  }

  let shows;
  try {
    if (args.keys === "curated") shows = curatedShows(catalogPath);
    else {
      const file = args.keys === "gold" ? goldPath : resolvePath(process.cwd(), args.keys);
      if (!existsSync(file)) throw new Error(`${file} does not exist${args.keys === "gold" ? " (RV-07 builds it)" : ""}`);
      shows = resolveFeeds(keyEntries(readJson(file)), { catalogPath, breadthPath });
    }
  } catch (e) {
    console.error(`enrich-rss: ${e.message}`);
    return 1;
  }
  if (args.limit != null) shows = shows.slice(0, args.limit);

  const counts = await enrichAll(shows, {
    ...opts,
    dir,
    concurrency: args.concurrency,
    maxAgeDays: args.maxAgeDays,
    dryRun: args.dryRun,
    log: opts.log ?? ((line) => console.error(line)),
  });
  console.log(JSON.stringify(counts));
  return 0;
}

if (isEntryScript(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
