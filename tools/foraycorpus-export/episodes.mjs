/* Per-show episodes.jsonl builder for the corpus export (PKG-05, G-10;
   docs/roadmap/corpus.md §3 "PKG-05 · episodes.mjs").

   One file per show, `episodes/<safeKey(showKey)>.jsonl`, one row per
   episode, newest first. Independent of catalogue.mjs (PKG-04): the caller
   passes the podcast ids and the chosen-feed Map that buildShows returned,
   so this module never imports the shows builder and either can change
   without the other.

   Transcript choice: publishers emit 2-3 formats per episode (corpus brief
   §2, docs/curation/corpus-integration-brief.md:40-79 — Omny emits srt + vtt
   + text/plain for every episode), so one asset is chosen and the rest are
   listed as alternates. Classification is mimes.mjs's classifyTranscriptMime
   (no mime list is defined here); the preference order among timed formats
   follows the idiom of tools/segments/sweep-transcripts.mjs pickTranscript
   (vtt first), normalising with that file's normalizeMimeType.

   Audio rows are `asset_type === "alternate"` with an audio mime (brief §3,
   :81-110); `declared_byte_length` is null on every one of them in the real
   corpus today, so `audio.declared_bytes` is usually null. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";

import { normalizeMimeType } from "../segments/sweep-transcripts.mjs";
import { safeKey } from "./config.mjs";
import { classifyTranscriptMime } from "./mimes.mjs";

/** Timed formats in preference order; any other timed mime ranks after
    these, in input order. */
const TIMED_PREFERENCE = Object.freeze(["text/vtt", "application/srt", "application/x-subrip", "application/json"]);

export class EpisodesError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "EpisodesError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

function isTranscriptAsset(a) {
  return a != null && (a.asset_type == null || a.asset_type === "transcript");
}

/**
 * The transcript asset an episode row points at: the best timed asset
 * (text/vtt > application/srt > application/x-subrip > application/json >
 * other timed), else the first plain one, else null. Assets whose
 * `asset_type` is set to something other than "transcript" (audio
 * alternates, chapters) are never candidates.
 */
export function pickTranscriptAsset(assets) {
  const candidates = (assets || []).filter(isTranscriptAsset);
  let best = null;
  let bestRank = Infinity;
  let firstPlain = null;
  for (const a of candidates) {
    const kind = classifyTranscriptMime(a.mime_type);
    if (kind === "timed") {
      const idx = TIMED_PREFERENCE.indexOf(normalizeMimeType(a.mime_type));
      const rank = idx === -1 ? TIMED_PREFERENCE.length : idx;
      if (rank < bestRank) {
        best = a;
        bestRank = rank;
      }
    } else if (kind === "plain" && firstPlain === null) {
      firstPlain = a;
    }
  }
  return best ?? firstPlain;
}

/** The file key for a show: catalog.json's show id when the show is curated
    (or String(itunes_id)), else the corpus public id. Takes a shows.jsonl
    row; does not import catalogue.mjs. */
export function showKeyOf(showRow) {
  return showRow?.foray_show_id ?? showRow?.corpus_podcast_id ?? null;
}

function toIsoOrNull(value) {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function isAudioAlternate(a) {
  return a.asset_type === "alternate" && typeof a.mime_type === "string" && a.mime_type.toLowerCase().startsWith("audio/");
}

function episodeRow(e, record, assets) {
  const sortedAssets = [...assets].sort((x, y) => x.id - y.id);
  const transcriptAssets = sortedAssets.filter((a) => a.asset_type === "transcript");
  const chosen = pickTranscriptAsset(transcriptAssets);
  const chapters = sortedAssets.find((a) => a.asset_type === "chapters") ?? null;
  const audio = sortedAssets.find(isAudioAlternate) ?? null;
  return {
    corpus_episode_id: e.public_id,
    guid: record?.guid_raw ?? null,
    title: e.canonical_title ?? null,
    published_at: toIsoOrNull(e.source_published_at),
    duration_sec: e.duration_seconds ?? null,
    explicit: e.explicit ?? null,
    transcript: chosen ? { url: chosen.url, mime: chosen.mime_type ?? null, timed: classifyTranscriptMime(chosen.mime_type) === "timed" } : null,
    transcript_alternates: transcriptAssets.filter((a) => a !== chosen).map((a) => ({ url: a.url, mime: a.mime_type ?? null })),
    chapters_url: chapters ? chapters.url : null,
    audio: audio ? { url: audio.url, mime: audio.mime_type, declared_bytes: audio.declared_byte_length ?? null } : null,
    asset_ids: sortedAssets.map((a) => Number(a.id)).sort((x, y) => x - y),
    updated_at: toIsoOrNull(e.updated_at),
  };
}

/** Newest first; an undated episode sorts last; ties break on the corpus id
    so the file is byte-stable across runs. */
function newestFirst(a, b) {
  const ta = a.published_at == null ? -Infinity : Date.parse(a.published_at);
  const tb = b.published_at == null ? -Infinity : Date.parse(b.published_at);
  if (ta !== tb) return tb - ta;
  return a.corpus_episode_id < b.corpus_episode_id ? -1 : a.corpus_episode_id > b.corpus_episode_id ? 1 : 0;
}

/**
 * Builds the episode rows for each podcast.
 *
 * @param source a row source (row-source.mjs interface)
 * @param {{podcastIds?: Iterable<number>, chosenFeedByPodcast?: Map<number, number>}} options
 *   `podcastIds` are corpus-internal podcast ids (default: the Map's keys);
 *   `chosenFeedByPodcast` (from buildShows) picks the source record whose
 *   `feed_id` is the show's chosen feed when an episode has several.
 * @yields {{podcast_id: number, rows: object[]}} in `podcastIds` order.
 */
export async function* buildEpisodes(source, { podcastIds, chosenFeedByPodcast = new Map() } = {}) {
  const order = [...(podcastIds ?? chosenFeedByPodcast.keys())];
  const wanted = new Set(order);

  const episodesByPodcast = new Map(order.map((id) => [id, []]));
  const podcastOfEpisode = new Map();
  for await (const e of source.rows("episodes")) {
    if (!wanted.has(e.podcast_id)) continue;
    episodesByPodcast.get(e.podcast_id).push(e);
    podcastOfEpisode.set(e.id, e.podcast_id);
  }

  // Source record per episode: the one on the chosen feed, else the first.
  const recordOf = new Map();
  for await (const r of source.rows("episode_source_records")) {
    const podcastId = podcastOfEpisode.get(r.episode_id);
    if (podcastId === undefined) continue;
    const chosenFeed = chosenFeedByPodcast.get(podcastId);
    const cur = recordOf.get(r.episode_id);
    if (cur === undefined || (r.feed_id === chosenFeed && cur.feed_id !== chosenFeed)) recordOf.set(r.episode_id, r);
  }

  const assetsOf = new Map();
  for await (const a of source.rows("assets")) {
    if (a.owner_type !== "episode" || !podcastOfEpisode.has(a.owner_id)) continue;
    if (!assetsOf.has(a.owner_id)) assetsOf.set(a.owner_id, []);
    assetsOf.get(a.owner_id).push(a);
  }

  for (const podcastId of order) {
    const rows = episodesByPodcast
      .get(podcastId)
      .map((e) => episodeRow(e, recordOf.get(e.id), assetsOf.get(e.id) ?? []))
      .sort(newestFirst);
    yield { podcast_id: podcastId, rows };
  }
}

/**
 * Writes `<outDir>/episodes/<safeKey(showKey)>.jsonl` via a tmp file +
 * rename, so a reader never sees a half-written file. Returns the path.
 *
 * Two refusals. (1) A showKey that is empty or path-shaped (contains a
 * separator, or is "." / "..") is refused outright: show keys are catalogue
 * ids or corpus public ids and never contain one, so such a key is a bug
 * upstream and must not be silently slugged into a plausible file name.
 * (2) The resolved path must stay under `<outDir>/episodes/` — the two-line
 * guard copied from tools/segments/fetch-transcripts.mjs transcriptPath
 * (`full.startsWith(base + sep)`, :225). As there, safeKey already makes an
 * escape impossible through this signature; the guard is belt-and-braces for
 * a future caller that builds the name from something safeKey never saw.
 */
export function writeEpisodesFile(outDir, showKey, rows) {
  if (typeof showKey !== "string" && typeof showKey !== "number") {
    throw new EpisodesError("BAD_SHOW_KEY", `show key must be a string: ${JSON.stringify(showKey)}`);
  }
  const key = String(showKey);
  if (key === "" || key === "." || key === ".." || /[\\/]/.test(key) || key.includes("\0")) {
    throw new EpisodesError("BAD_SHOW_KEY", `refusing path-shaped show key ${JSON.stringify(key)}`);
  }
  const base = resolvePath(outDir, "episodes");
  const full = resolvePath(base, `${safeKey(key)}.jsonl`);
  if (!full.startsWith(base + sep)) {
    throw new EpisodesError("PATH_ESCAPE", `refusing to write outside ${base}: ${full}`);
  }
  mkdirSync(base, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, full);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return full;
}
