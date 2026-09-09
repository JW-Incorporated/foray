import * as fs from "fs";
import * as path from "path";
import type { TranscriptDigestEntry } from "./transcriptArchiveLookup";

/**
 * The `data/segment-sources.json` row a TIER-2 MINTED SEGMENT needs to be
 * playable — and the refusal to invent one (fix plan WS-C plumbing; the tier-2
 * half of F-49).
 *
 * THE DEFECT THIS CLOSES. §4.5 tier 2 mints a segment from a transcript-archive
 * episode and hands it out as `SourceBeatsResult.newSegments`. Nothing consumed
 * it: `runPipeline.ts` checkpointed the array and dropped it, so the candidate
 * Foray referenced a `segment_id` that is in no file on disk. `check-forays.mjs`
 * calls that "unknown segment_id ... not in data/segments.json", drops the item
 * before every ordering rule, and counts its seconds nowhere — the same
 * "cost zero everywhere" hole its own narration-duration block exists to close.
 * So the moment F-49's fix produced real tier-2 tape, finalize would have
 * failed the Foray. The registry rule behind it is the deeper one: an episode
 * the pool refers to must resolve to audio, "or its segments can never be
 * played".
 *
 * WHAT THIS MODULE WILL AND WILL NOT DO. It builds the row from things already
 * committed to the repo — the digest's own `enclosure_url` and
 * `feed_duration_sec`, the show's title, and a DAI verdict taken from the same
 * three files, in the same precedence, that
 * `tools/segments/prepare-segment-batch.mjs` uses. When any of those is missing
 * it returns `null`, and the beat gets narration instead of tape. It never
 * defaults `dai_suspected` to `false`: that is the exact value
 * `merge-segments.mjs` ("a missing verdict would waive the anchor rule") and
 * `check-forays.mjs` ("a missing flag reads as falsy") both exist to reject,
 * and ADR-0007 gates seek precision on it. A minted segment whose audio cannot
 * be vouched for is not tape this pipeline may use.
 *
 * WHY THE PRECEDENCE IS MIRRORED, NOT IMPORTED. `prepare-segment-batch.mjs` is
 * an ESM build script and this is a CommonJS backend module — the same reason
 * `transcriptArchiveLookup.ts` mirrors `merge-segments.mjs`'s `canonical()`
 * rather than importing it. The rule mirrored is that file's own: the sweep's
 * per-show verdict (`data/transcript-availability.json`,
 * `data/breadth-transcript-yield.json`) is the fallback, and
 * `data/dai-classification.json`'s resolved-chain verdict wins where it exists.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** One `data/segment-sources.json` row, in that file's own field names. */
export interface MintedSegmentSource {
  id: string;
  show: string;
  title: string;
  feed_url: string | null;
  episode_guid: string;
  audio_url: string;
  audio_type: string;
  duration_sec: number;
  dai_suspected: boolean;
  /** Provenance, so a human reading `data/segment-sources.json` can tell a row
   * this pipeline minted from one a curator's batch wrote. */
  source: "generation-tier-2";
}

/** Resolves the audio row for one archive episode, or `null` when the evidence
 * to write an honest one is not on disk. */
export type AudioSourceResolver = (entry: TranscriptDigestEntry, itemId: string) => MintedSegmentSource | null;

export interface ShowAudioMeta {
  dai: boolean | null;
  feedUrl: string | null;
  appleCollectionId: number | null;
}

/** Mirrors `prepare-segment-batch.mjs`'s `enclosureMime` — the media type from
 * the URL's own path extension, because no feed field carries it. */
export function enclosureMime(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const ext = withoutQuery.toLowerCase().match(/\.(mp3|m4a|mp4|aac|ogg|opus|wav)$/)?.[1];
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function readJson(root: string, rel: string): unknown {
  const full = path.join(root, rel);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path list, not external input.
  if (!fs.existsSync(full)) return null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

/** The per-show DAI/feed table. See the module doc comment for the precedence,
 * and `prepare-segment-batch.mjs`'s `resolveDaiVerdicts` for why an unknown
 * verdict stays `null` instead of folding to `false`. */
export function loadShowAudioMeta(root: string = REPO_ROOT): Map<string, ShowAudioMeta> {
  const map = new Map<string, ShowAudioMeta>();
  const put = (id: unknown, meta: ShowAudioMeta): void => {
    if (id === null || id === undefined) return;
    const key = String(id);
    if (!map.has(key)) map.set(key, meta);
  };
  const verdict = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  for (const file of ["data/transcript-availability.json", "data/breadth-transcript-yield.json"]) {
    const doc = readJson(root, file) as { shows?: Array<Record<string, unknown>> } | null;
    for (const s of doc?.shows ?? []) {
      put(s.show_id, {
        dai: verdict(s.dai_suspected),
        feedUrl: typeof s.feed_url === "string" ? s.feed_url : null,
        appleCollectionId: typeof s.apple_collection_id === "number" ? s.apple_collection_id : null
      });
    }
  }

  const classification = readJson(root, "data/dai-classification.json") as { shows?: Record<string, { dai?: unknown }> } | null;
  const resolved = classification?.shows ?? {};
  for (const [showId, meta] of map) {
    const row = meta.appleCollectionId === null ? undefined : resolved[String(meta.appleCollectionId)];
    if (!row || typeof row.dai !== "boolean") continue;
    map.set(showId, { ...meta, dai: row.dai });
  }
  return map;
}

let cached: { root: string; map: Map<string, ShowAudioMeta> } | null = null;

/**
 * The resolver a real run uses. Reads only committed catalogue files, caches
 * the per-show table per process (same convention and cache-bust env var as
 * `loadSegmentPool`), and returns `null` for every episode it cannot vouch for.
 */
export function createDigestAudioSourceResolver(options: { root?: string } = {}): AudioSourceResolver {
  const root = options.root ?? REPO_ROOT;
  return (entry: TranscriptDigestEntry, itemId: string): MintedSegmentSource | null => {
    if (!cached || cached.root !== root || process.env.FORAY_SKIP_CATALOGUE_CACHE === "1") {
      cached = { root, map: loadShowAudioMeta(root) };
    }
    return mintSegmentSource(entry, itemId, cached.map);
  };
}

/**
 * Builds the row for one episode from an already-loaded show table — the pure
 * half of the resolver, so a test can exercise every refusal without a
 * checkout.
 *
 * `itemId` is passed in rather than re-derived: it must be the SAME id the
 * minted segment carries (`sourceBeats.ts`'s `deriveItemId`), and two modules
 * deriving it separately is how a slug rule drifts and the registry stops
 * resolving.
 *
 * The refusals, each naming a rule `check-forays.mjs` would otherwise fail on:
 * no enclosure URL (nothing to play); a non-https or tokened URL (the
 * registry's own two lexical checks, mirroring ci.yml's data invariants); no
 * positive feed duration (the registry needs `duration_sec > 0`, and it is also
 * what a minted segment's `reference_duration_sec` is compared against, to 2 s);
 * no show or episode title (both must be non-empty strings); and no boolean DAI
 * verdict.
 */
export function mintSegmentSource(
  entry: TranscriptDigestEntry,
  itemId: string,
  showMeta: Map<string, ShowAudioMeta>
): MintedSegmentSource | null {
  const audioUrl = typeof entry.enclosure_url === "string" ? entry.enclosure_url.trim() : "";
  if (!audioUrl) return null;
  if (!/^https:\/\//.test(audioUrl)) return null;
  if (/[?&](token|auth|api_?key|secret|password|session)=/i.test(audioUrl)) return null;

  const durationSec = typeof entry.feed_duration_sec === "number" ? entry.feed_duration_sec : 0;
  if (!(durationSec > 0)) return null;

  const meta = showMeta.get(String(entry.show_id));
  if (!meta || typeof meta.dai !== "boolean") return null;

  const show = String(entry.show_title ?? "").trim();
  const title = String(entry.title ?? "").trim();
  if (!show || !title) return null;

  return {
    id: itemId,
    show,
    title,
    feed_url: meta.feedUrl,
    episode_guid: String(entry.guid),
    audio_url: audioUrl,
    audio_type: enclosureMime(audioUrl),
    duration_sec: durationSec,
    dai_suspected: meta.dai,
    source: "generation-tier-2"
  };
}
