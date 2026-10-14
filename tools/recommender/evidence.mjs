/* RV-03 (docs/roadmap/recommender-v1.md, D3, D7, D10): the evidence pack builder.

   WHAT THIS IS. The one place that turns a show into the text a rater sees.
   Every rater path (a Claude Code agent reading a batch file, the dormant Qwen
   and Jev paths, the embedder) gets its show text from `buildEvidence`, so all
   of them see the same bytes and the same stripping (D10). This module calls no
   model and fetches nothing: it reads committed `data/` files and two local
   caches other cards fill (RV-04's RSS cache, RV-05's / the founder PC's
   normalized transcript bodies).

   EVIDENCE TIERS (D3). `transcript` when at least one normalized body exists for
   the show; else `episode-metadata` when at least five episodes with a title
   and a non-empty description exist (episode archive or RSS cache); else
   `show-metadata` when there is a title and a blurb or editorial note; else
   `none`. The strings match RV-02's `EVIDENCE_TIERS`.

   STRIPPING (D7). A pack is built from an explicit whitelist of fields, never
   by spreading a source row, so a rater never sees chart rank, download or
   popularity counts, the publisher/network (`artist_name`), `in_curated`, a
   PodcastIndex id or anything about ad insertion. `stripped` records which of
   those keys the source rows carried; it is audit metadata, and `raterPack`
   drops it before a pack goes into a batch file. The publisher's name is also
   redacted out of the untrusted text and the editorial note, so a feed
   description that repeats it does not leak it back in. Names of two or more
   characters count (NPR, TED and BBC are the brands D7 hides); a name equal to
   the title is left alone. Matching is by whole token where the name's edge
   is a letter or digit of a script that spaces its words, so "NPR's" loses
   "NPR" but "Islamic" keeps "islami"; at a Han, kana, Thai, Lao, Khmer or
   Myanmar edge (no spaces between words) a bare substring match is used. The
   classifier's `rationale` is never read (it carries the classifier's
   opinion); only `blurb` is.

   DATAMARKING (D7; spotlighting, Hines et al. 2024). Untrusted show text (feed
   description, episode titles and descriptions, the classifier blurb,
   transcript windows) has every whitespace run replaced with DATAMARK
   (U+02C6). The rubric tells the rater that marked text is data, never
   instructions. The show title and the curated `editorial_note` are ours and
   are not marked.

   INJECTION PRE-SCAN. `injectionSuspected` runs a small fixed pattern list over
   the raw untrusted text (and the title); a hit sets
   `flags_prescan.injection_suspected`. It is a cheap tripwire, not a defence:
   the defence is datamarking plus code-validated structured output (RV-09).

   TRANSCRIPT WINDOWS. One episode is picked with a seeded RNG and three ~300 s
   windows (opening / middle / late third) are cut from its cue text. The seed
   defaults to the show key, so the same show gets the same windows on every
   pass and test-retest (RV-11) compares ratings of the same evidence. */

import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { safeKey } from "../foraycorpus-export/config.mjs";
import { listLocal, readLocal } from "../passage-index/sources.mjs";
import { rng, streamJsonArray } from "../segments/rank-breadth.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const EVIDENCE_TIERS = Object.freeze(["transcript", "episode-metadata", "show-metadata", "none"]);
export const EPISODE_METADATA_MIN = 5;
export const MAX_EPISODES = 10;
export const MAX_EPISODE_DESCRIPTION_CHARS = 280;
export const MAX_FEED_DESCRIPTION_CHARS = 600;
export const WORDS_PER_SECOND = 2.5;
export const DATAMARK = "ˆ";
export const PUBLISHER_REDACTION = "[publisher]";

/** Keys a rater must never see (D7). The pack is whitelisted, so this list is
    what `stripped` reports and what the tests scan a serialised pack for. */
export const STRIPPED_KEYS = Object.freeze([
  "chart_rank",
  "chart_rank_overall",
  "chart_genre_id",
  "chart_genre_name",
  "last_charted_at",
  "in_curated",
  "artist_name",
  "podcastindex_id",
  "popularity_score",
  "apple_genre_ids",
  "dai",
  "dai_suspected",
  "dai_reason",
  "enclosure_host",
  "rationale",
]);

/** The fixed injection pattern list. Exported so RV-26's audit reuses it. */
export const INJECTION_PATTERNS = Object.freeze([
  /ignore (all|any|the) (previous|prior|above) instructions/i,
  /you are (now )?(an?|the) (ai|assistant|model)/i,
  /\brate (this|it) (a )?5\b/i,
  /system prompt/i,
  /<\/?(system|assistant|instruction)>/i,
]);

/** Path settings: env override (resolved against cwd, the `envPath` idiom of
    tools/refresh/merge.mjs) or the repo-relative default. */
export const SOURCE_PATHS = Object.freeze({
  catalog: ["RECOMMENDER_CATALOG_PATH", "data/catalog.json"],
  breadth: ["RECOMMENDER_BREADTH_PATH", "data/catalog-breadth.json"],
  classification: ["RECOMMENDER_CLASSIFICATION_PATH", "data/breadth-classification.json"],
  archive: ["RECOMMENDER_EPISODE_ARCHIVE_PATH", "data/episode-archive.json.gz"],
  availability: ["RECOMMENDER_AVAILABILITY_PATH", "data/transcript-availability.json"],
  rssDir: ["RECOMMENDER_RSS_DIR", "data-local/recommender/rss"],
  transcriptsDir: ["RECOMMENDER_TRANSCRIPTS_DIR", "data-local/transcripts/normalized"],
});

export function sourcePaths({ root = REPO_ROOT, env = process.env } = {}) {
  const out = {};
  for (const [name, [envName, def]] of Object.entries(SOURCE_PATHS)) {
    out[name] = env[envName] ? resolvePath(process.cwd(), env[envName]) : resolvePath(root, def);
  }
  return out;
}

/* ------------------------------------------------------------ text helpers */

/** Replaces every whitespace run of untrusted text with the marker. */
export function datamark(text, marker = DATAMARK) {
  if (text === null || text === undefined) return null;
  return String(text).trim().replace(/\s+/g, marker);
}

/** Tests only: the inverse of `datamark` (whitespace runs come back as one space). */
export function undatamark(text, marker = DATAMARK) {
  if (text === null || text === undefined) return null;
  return String(text).split(marker).join(" ");
}

/** True when the text matches any INJECTION_PATTERNS entry. Whitespace runs and
    datamarks are collapsed to one space first, so spacing cannot dodge it. */
export function injectionSuspected(text, patterns = INJECTION_PATTERNS) {
  if (typeof text !== "string" || text === "") return false;
  const flat = text.replace(new RegExp(`[\\s${DATAMARK}]+`, "g"), " ");
  return patterns.some((re) => re.test(flat));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The shortest publisher name that is redacted (NPR, TED; two-letter FX, GQ). */
export const PUBLISHER_MIN_CHARS = 2;

const WORD_CHAR = /[\p{L}\p{N}]/u;
// Scripts written without spaces between words have no token edge to match on.
const UNSPACED_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const needsBoundary = (ch) => WORD_CHAR.test(ch) && !UNSPACED_CHAR.test(ch);

/** The case-insensitive pattern for one publisher name: whole tokens only at
    an edge that is a letter or digit of a spaced script, and any whitespace
    run between its words. */
export function publisherPattern(name) {
  const chars = [...name];
  const body = name.split(/\s+/).map(escapeRegExp).join("\\s+");
  const before = needsBoundary(chars[0]) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = needsBoundary(chars[chars.length - 1]) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${body}${after}`, "giu");
}

/** Removes each publisher name (case-insensitive, whole tokens) from text. */
export function redactPublisher(text, names) {
  if (typeof text !== "string" || !names.length) return text;
  let out = text;
  for (const name of names) out = out.replace(publisherPattern(name), PUBLISHER_REDACTION);
  return out;
}

const clip = (text, max) => {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === "") return null;
  return t.length > max ? t.slice(0, max) : t;
};

/* ----------------------------------------------------------------- loading */

function readJsonMaybeGz(path) {
  const bytes = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(text);
}

/** `.json.gz` or `.json` (fixtures are plain): the given path, else its sibling. */
function archivePathOf(path) {
  if (existsSync(path)) return path;
  const alt = path.endsWith(".gz") ? path.slice(0, -3) : `${path}.gz`;
  return existsSync(alt) ? alt : null;
}

const isoDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/**
 * Every source a pack is built from, keyed for lookup. Catalogue, breadth and
 * classification files are required; the episode archive, the availability
 * index, the RSS cache and the transcript root are optional (absent = empty).
 */
export function loadSources({ root = REPO_ROOT, env = process.env } = {}) {
  const paths = sourcePaths({ root, env });

  const curated = new Map();
  for (const row of readJsonMaybeGz(paths.catalog).shows ?? []) curated.set(String(row.show_id), row);
  const curatedByAcid = new Map();
  for (const row of curated.values()) if (row.apple_collection_id) curatedByAcid.set(String(row.apple_collection_id), row.show_id);

  const breadth = new Map();
  for (const row of streamJsonArray(paths.breadth, "shows")) breadth.set(String(row.apple_collection_id), row);

  // blurb only -- never `rationale`, which carries the classifier's opinion.
  const blurbs = new Map();
  const entries = readJsonMaybeGz(paths.classification).entries ?? {};
  for (const [acid, entry] of Object.entries(entries)) {
    if (typeof entry?.blurb === "string" && entry.blurb.trim() !== "") blurbs.set(String(acid), entry.blurb);
  }

  const archive = new Map();
  const archivePath = archivePathOf(paths.archive);
  if (archivePath) {
    for (const show of readJsonMaybeGz(archivePath).shows ?? []) {
      archive.set(String(show.apple_collection_id), {
        episode_count: show.episode_count_in_feed ?? null,
        episodes: (show.episodes ?? []).map((e) => ({
          guid: e.guid ?? null,
          title: e.title ?? null,
          description: e.description ?? null,
          duration_min: Number.isFinite(e.duration_min) ? e.duration_min : null,
          published_at: isoDate(e.published_at),
        })),
      });
    }
  }

  // Episode titles for curated shows (no descriptions here); dai fields dropped.
  const availability = new Map();
  if (existsSync(paths.availability)) {
    for (const show of streamJsonArray(paths.availability, "shows")) {
      availability.set(String(show.show_id), {
        episode_count: show.episodes_total ?? null,
        episodes: (show.episodes ?? []).map((e) => ({
          guid: e.guid ?? null,
          title: e.title ?? null,
          description: null,
          duration_min: Number.isFinite(e.duration_sec) ? Math.round(e.duration_sec / 60) : null,
          published_at: isoDate(e.pub_date),
        })),
      });
    }
  }

  const transcripts = listLocal(paths.transcriptsDir).shows;

  return { paths, curated, curatedByAcid, breadth, blurbs, archive, availability, transcripts, rssDir: paths.rssDir, rssCache: new Map() };
}

/* ------------------------------------------------------------- resolution */

/**
 * A show reference (a show_key string, a curated row or a breadth row) resolved
 * to its key and every row that describes it. `show_key` is the curated
 * `show_id` or `String(apple_collection_id)` for a breadth row (RV-02).
 */
export function resolveShow(ref, sources) {
  let key;
  if (typeof ref === "string" || typeof ref === "number") key = String(ref);
  else if (ref && typeof ref === "object") key = ref.show_key ?? (ref.show_id && sources.curated.has(String(ref.show_id)) ? String(ref.show_id) : ref.apple_collection_id != null ? String(ref.apple_collection_id) : ref.show_id);
  if (!key) throw new Error("buildEvidence: show reference has no show_key, show_id or apple_collection_id");
  key = String(key);
  let curated = sources.curated.get(key) ?? null;
  let acid;
  if (curated) {
    acid = curated.apple_collection_id != null ? String(curated.apple_collection_id) : null;
  } else {
    acid = /^\d+$/.test(key) ? key : null;
    if (acid && sources.curatedByAcid.has(acid)) curated = sources.curated.get(sources.curatedByAcid.get(acid)) ?? null;
  }
  const breadth = acid ? sources.breadth.get(acid) ?? null : null;
  return { show_key: key, acid, curated, breadth, aliases: [...new Set([key, acid, curated?.show_id].filter(Boolean).map(String))] };
}

function rssOf(show, sources) {
  if (sources.rssCache.has(show.show_key)) return sources.rssCache.get(show.show_key);
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(join(sources.rssDir, `${show.show_key}.json`), "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  if (doc && doc.status === "failed") doc = null;
  sources.rssCache.set(show.show_key, doc);
  return doc;
}

function bodiesOf(show, sources) {
  for (const alias of show.aliases) {
    const entries = sources.transcripts.get(alias);
    if (entries && entries.length) return entries;
  }
  return [];
}

const hasText = (s) => typeof s === "string" && s.trim() !== "";

/** Every known episode, deduped by title (a described copy wins), newest first. */
function episodesOf(show, sources) {
  const rss = rssOf(show, sources);
  const lists = [
    (rss?.episodes ?? []).map((e) => ({ guid: e.guid ?? null, title: e.title ?? null, description: e.description ?? null, duration_min: Number.isFinite(e.duration_min) ? e.duration_min : null, published_at: isoDate(e.published_at) })),
    show.acid ? sources.archive.get(show.acid)?.episodes ?? [] : [],
    show.curated ? sources.availability.get(String(show.curated.show_id))?.episodes ?? [] : [],
  ];
  const byTitle = new Map();
  for (const list of lists) {
    for (const ep of list) {
      if (!hasText(ep.title)) continue;
      const k = ep.title.trim().toLowerCase();
      const prev = byTitle.get(k);
      if (!prev) byTitle.set(k, { ...ep });
      else if (!hasText(prev.description) && hasText(ep.description)) byTitle.set(k, { ...prev, ...ep, guid: prev.guid ?? ep.guid });
    }
  }
  const time = (e) => {
    const ms = Date.parse(e.published_at ?? "");
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return [...byTitle.values()].sort((a, b) => time(b) - time(a));
}

/* ------------------------------------------------------------------- tiers */

/** The evidence tier of a show (D3). */
export function evidenceTierOf(ref, sources) {
  const show = ref && ref.aliases ? ref : resolveShow(ref, sources);
  if (bodiesOf(show, sources).length >= 1) return "transcript";
  const described = episodesOf(show, sources).filter((e) => hasText(e.description)).length;
  if (described >= EPISODE_METADATA_MIN) return "episode-metadata";
  const title = show.curated?.title ?? show.breadth?.title;
  const blurb = show.acid ? sources.blurbs.get(show.acid) : null;
  if (hasText(title) && (hasText(blurb) || hasText(show.curated?.editorial_note))) return "show-metadata";
  return "none";
}

/* ---------------------------------------------------------------- windows */

/** The episode bodies in seeded order; the first one with cue text is used. */
function transcriptWindows(entries, { windows, windowSec, seed, titleOfGuid }) {
  if (!entries.length || windows < 1) return [];
  const next = rng(seed);
  const order = entries.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const maxWords = Math.round(windowSec * WORDS_PER_SECOND);
  for (const entry of order) {
    const body = readLocal(entry).body;
    const cues = Array.isArray(body?.cues) ? body.cues.filter((c) => typeof c?.text === "string" && Number.isFinite(c.start_sec)) : [];
    if (!cues.length) continue;
    const end = Math.max(...cues.map((c) => (Number.isFinite(c.end_sec) ? c.end_sec : c.start_sec)));
    // A normalized body's guid (and file name) is safeKey(<feed guid>).
    const guid = typeof body.guid === "string" ? body.guid : String(entry.fileName).replace(/\.json$/, "");
    const episodeTitle = titleOfGuid.get(guid) ?? null;
    const out = [];
    const span = end / windows;
    for (let i = 0; i < windows; i++) {
      const lo = i * span;
      const start = lo + next() * Math.max(0, span - windowSec);
      const words = cues
        .filter((c) => c.start_sec >= start && c.start_sec < start + windowSec)
        .map((c) => c.text.trim())
        .join(" ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, maxWords);
      if (!words.length) continue;
      const frac = (i + 0.5) / windows;
      out.push({ episode_title: episodeTitle, position: frac < 1 / 3 ? "opening" : frac < 2 / 3 ? "middle" : "late", text: words.join(" ") });
    }
    if (out.length) return out;
  }
  return [];
}

/* ---------------------------------------------------------------- the pack */

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

export function episodeCountBand(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 10) return "<10";
  if (n < 50) return "10-49";
  if (n < 200) return "50-199";
  if (n < 1000) return "200-999";
  return "1000+";
}

/** The catalogue's cadence vocabulary, derived from release gaps when the
    catalogue has no hint. Null under three dated episodes. */
export function cadenceFromDates(dates) {
  const ms = dates.map((d) => Date.parse(d ?? "")).filter(Number.isFinite).sort((a, b) => b - a);
  if (ms.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < ms.length; i++) gaps.push((ms[i - 1] - ms[i]) / 86400e3);
  const g = median(gaps.map((x) => Math.round(x * 10) / 10));
  if (g <= 2) return "daily";
  if (g <= 10) return "weekly";
  if (g <= 20) return "biweekly";
  if (g <= 45) return "monthly";
  return "irregular";
}

/**
 * The evidence pack a rater sees for one show. `seed` defaults to the show key,
 * so every pass over the same show sees the same transcript windows.
 */
export function buildEvidence(ref, sources, { windows = 3, windowSec = 300, seed } = {}) {
  const show = resolveShow(ref, sources);
  const { curated, breadth } = show;
  const tier = evidenceTierOf(show, sources);
  const title = curated?.title ?? breadth?.title ?? null;

  const publishers = [breadth?.artist_name, curated?.artist_name]
    .filter((n) => typeof n === "string" && [...n.trim()].length >= PUBLISHER_MIN_CHARS && n.trim().toLowerCase() !== String(title ?? "").trim().toLowerCase())
    .map((n) => n.trim());
  const untrusted = (text) => redactPublisher(text, publishers);

  const rss = rssOf(show, sources);
  const allEpisodes = episodesOf(show, sources);
  const rawBlurb = untrusted(clip(show.acid ? sources.blurbs.get(show.acid) : null, MAX_FEED_DESCRIPTION_CHARS));
  const rawFeed = untrusted(clip(rss?.description, MAX_FEED_DESCRIPTION_CHARS));
  const rawEpisodes = allEpisodes.slice(0, MAX_EPISODES).map((e) => ({
    title: untrusted(clip(e.title, MAX_EPISODE_DESCRIPTION_CHARS)),
    description: untrusted(clip(e.description, MAX_EPISODE_DESCRIPTION_CHARS)),
    duration_min: e.duration_min ?? null,
    published_at: e.published_at ?? null,
  }));

  const titleOfGuid = new Map();
  for (const e of allEpisodes) if (e.guid && e.title) titleOfGuid.set(safeKey(e.guid), e.title);
  const rawWindows =
    tier === "transcript"
      ? transcriptWindows(bodiesOf(show, sources), { windows, windowSec, seed: seed ?? show.show_key, titleOfGuid }).map((w) => ({
          episode_title: untrusted(w.episode_title),
          position: w.position,
          text: untrusted(w.text),
        }))
      : [];

  const scanned = [title, rawBlurb, rawFeed, ...rawEpisodes.flatMap((e) => [e.title, e.description]), ...rawWindows.flatMap((w) => [w.episode_title, w.text])];

  const stripped = STRIPPED_KEYS.filter((k) => (breadth && k in breadth) || (curated && k in curated));
  if (show.acid && sources.blurbs.has(show.acid)) stripped.push("rationale");

  const episodeCount = breadth?.episode_count ?? curated?.episode_count ?? (show.acid ? sources.archive.get(show.acid)?.episode_count : null) ?? (curated ? sources.availability.get(String(curated.show_id))?.episode_count : null) ?? null;
  const explicit = typeof curated?.explicit === "boolean" ? curated.explicit : typeof breadth?.explicit === "boolean" ? breadth.explicit : null;
  const taxonomy = curated?.taxonomy_node_ids?.length ? curated.taxonomy_node_ids : breadth?.taxonomy_node_ids ?? [];

  return {
    show_key: show.show_key,
    title,
    tier,
    taxonomy_node_ids: [...taxonomy],
    label_scope: curated?.label_scope ?? null,
    cadence_hint: curated?.cadence_hint ?? cadenceFromDates(allEpisodes.slice(0, MAX_EPISODES + 1).map((e) => e.published_at)),
    typical_duration_min: median(allEpisodes.map((e) => e.duration_min)),
    episode_count_band: episodeCountBand(episodeCount),
    explicit,
    editorial_note: hasText(curated?.editorial_note) ? untrusted(curated.editorial_note.trim()) : null,
    blurb: datamark(rawBlurb),
    feed_description: datamark(rawFeed),
    episodes: rawEpisodes.map((e) => ({ title: datamark(e.title), description: datamark(e.description), duration_min: e.duration_min, published_at: e.published_at })),
    transcript_windows: rawWindows.map((w) => ({ episode_title: datamark(w.episode_title), position: w.position, text: datamark(w.text) })),
    flags_prescan: { injection_suspected: scanned.some((t) => injectionSuspected(t)) },
    stripped: [...new Set(stripped)].sort(),
  };
}

/** The pack as it goes into a rater's batch file: the audit-only `stripped`
    list removed, so not even the stripped key names reach the rater. */
export function raterPack(pack) {
  const { stripped: _stripped, ...rest } = pack;
  return rest;
}

/* --------------------------------------------------------------------- CLI */

const USAGE = "usage: node tools/recommender/evidence.mjs <show_key> [<show_key> ...] [--seed <s>] [--windows N] [--window-sec S]";

export function parseArgs(argv) {
  const args = { keys: [], seed: undefined, windows: 3, windowSec: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") args.seed = argv[++i];
    else if (a === "--windows") args.windows = Number(argv[++i]);
    else if (a === "--window-sec") args.windowSec = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}; ${USAGE}`);
    else args.keys.push(a);
  }
  if (!args.keys.length) throw new Error(USAGE);
  if (!Number.isInteger(args.windows) || args.windows < 0) throw new Error(`--windows must be a non-negative integer; ${USAGE}`);
  if (!Number.isFinite(args.windowSec) || args.windowSec <= 0) throw new Error(`--window-sec must be positive; ${USAGE}`);
  return args;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const sources = loadSources();
  for (const key of args.keys) {
    process.stdout.write(`${JSON.stringify(buildEvidence(key, sources, args))}\n`);
  }
  return 0;
}

if (isEntryScript(import.meta.url)) process.exitCode = main();

