import * as fs from "fs";
import type { TranscriptSource } from "../types/tapeSourcing";
import {
  guidIndexOfListing,
  locateInListing,
  type TranscriptCue,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import type { TranscriptBodySource, TranscriptBodyStat } from "./transcriptTextIndex";

/**
 * THE EPISODE MANIFEST AS A BODY SOURCE (GV-16; roadmap
 * docs/roadmap/generation-v2.md, from W3-08; covers R1-09 and GP-09).
 *
 * The stream indexer (GV-09, `tools/passage-index/stream-index.mjs`) writes one
 * row per body it streamed to `data-local/passage-index/episodes.jsonl`:
 *     {show_id, fileName, bodyGuid, cues, lastEndSec, size, mtimeMs, origin, indexedAt}
 * and builds each show's BM25 cache with the stat it recorded there. On the box
 * that streams R2 there is no body on disk to `stat`, so a
 * `FileTranscriptCueProvider` would call every one of those caches stale. This
 * source answers `bodyStat` FROM THE MANIFEST instead, which is the stat the
 * cache was built under, so `FileTranscriptTextIndex.cacheIsFresh` judges the
 * streamed caches fresh with no body on disk.
 *
 * THE SAME MAPPING RULE AS THE BUILD. An archive row is mapped onto a manifest
 * row by `locateInListing` over that show's file names, with each row's
 * recorded `bodyGuid` standing in for opening the file: exactly what
 * `cli/indexBodies.ts` did with the streamed names, and what the provider does
 * with a directory listing. Committed rows and bodies can disagree on the guid
 * (Becker's: a permalink in the row, a slug in the body); the writer's key, the
 * bare slug, a guid-verified prefix and the recorded-guid scan resolve it here
 * as they did there.
 *
 * CUES COME FROM AN INJECTED `CueStore`. `getCues`, `readCuesUncached` and
 * `transcriptSource` delegate to it. The server's default is a
 * `FileTranscriptCueProvider` over a local normalized directory; GV-54 adds a
 * store that reads through to R2. This module never opens a body itself.
 *
 * READ-ONLY. It reads the manifest file and nothing else, and writes nothing,
 * so `promptNoPersistence.test.ts`'s rule for `generation/` holds without an
 * exemption.
 */

/** One row of `episodes.jsonl` (tools/passage-index/manifest.mjs). Only the
 * fields this source reads are typed; the rest ride along. */
export interface EpisodeManifestRow {
  show_id: string;
  fileName: string;
  /** The guid the body records about itself, or null. */
  bodyGuid: string | null;
  cues?: number;
  size: number;
  mtimeMs: number;
  /** Where the body came from ({kind, key, sha256|etag}); opaque here. */
  origin?: unknown;
  /** A later writer may record the body's provenance; read when present. */
  transcript_source?: TranscriptSource;
}

/**
 * Where the cues for an episode come from. `FileTranscriptCueProvider` is one:
 * its `getCues`, `readCuesUncached`, `transcriptSource` and `bodyStat` are all
 * this interface asks for. `bodyStat`, when present, is how a caller asks
 * "can you serve this body" without reading it.
 */
export interface CueStore extends TranscriptCueProvider {
  readCuesUncached?(entry: TranscriptDigestEntry): TranscriptCue[] | null;
  bodyStat?(entry: TranscriptDigestEntry): TranscriptBodyStat | null;
}

/** Whether a value is a usable manifest row. */
function isManifestRow(value: unknown): value is EpisodeManifestRow {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.show_id === "string" &&
    v.show_id.length > 0 &&
    typeof v.fileName === "string" &&
    v.fileName.length > 0 &&
    typeof v.size === "number" &&
    Number.isFinite(v.size) &&
    typeof v.mtimeMs === "number" &&
    Number.isFinite(v.mtimeMs) &&
    (v.bodyGuid === null || v.bodyGuid === undefined || typeof v.bodyGuid === "string")
  );
}

/**
 * The rows of an `episodes.jsonl` text, in file order. A blank, unparseable or
 * malformed line is skipped and counted, never fatal: the manifest is rewritten
 * whole per show by the indexer, and one bad line must not take a show down.
 */
export function parseEpisodeManifest(text: string): { rows: EpisodeManifestRow[]; skipped: number } {
  const rows: EpisodeManifestRow[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (!isManifestRow(parsed)) {
      skipped += 1;
      continue;
    }
    rows.push({ ...parsed, bodyGuid: typeof parsed.bodyGuid === "string" ? parsed.bodyGuid : null });
  }
  return { rows, skipped };
}

/** `parseEpisodeManifest` over a file; null when the file does not exist. */
export function readEpisodeManifest(file: string): { rows: EpisodeManifestRow[]; skipped: number } | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the manifest path (data-local/passage-index/ or the server's --manifest).
  if (!fs.existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  return parseEpisodeManifest(fs.readFileSync(file, "utf8"));
}

interface ShowListing {
  /** Lowercased file name -> real file name, in manifest order. */
  files: Map<string, string>;
  byName: Map<string, EpisodeManifestRow>;
  guidIndex: Map<string, string> | null;
}

export interface ManifestBodySourceOptions {
  rows: readonly EpisodeManifestRow[];
  cues: CueStore;
}

export class ManifestBodySource implements TranscriptBodySource {
  private readonly cues: CueStore;
  private readonly listings = new Map<string, ShowListing>();
  private readonly located = new Map<string, EpisodeManifestRow | null>();

  constructor(options: ManifestBodySourceOptions) {
    this.cues = options.cues;
    for (const row of options.rows) {
      let listing = this.listings.get(row.show_id);
      if (!listing) {
        listing = { files: new Map(), byName: new Map(), guidIndex: null };
        this.listings.set(row.show_id, listing);
      }
      /* The indexer's own rule for a repeated name: the later row wins. */
      const lower = row.fileName.toLowerCase();
      const previous = listing.files.get(lower);
      if (previous !== undefined && previous !== row.fileName) listing.byName.delete(previous);
      listing.files.set(lower, row.fileName);
      listing.byName.set(row.fileName, row);
    }
  }

  /** The manifest row an archive entry maps to, or null. */
  rowFor(entry: TranscriptDigestEntry): EpisodeManifestRow | null {
    const showId = String(entry.show_id);
    const guid = String(entry.guid);
    const key = `${showId}\u0000${guid}`;
    if (this.located.has(key)) return this.located.get(key) ?? null;
    const listing = this.listings.get(showId);
    let row: EpisodeManifestRow | null = null;
    if (listing) {
      const bodyGuidOf = (real: string): string | null => listing.byName.get(real)?.bodyGuid ?? null;
      const real = locateInListing({
        files: listing.files,
        guid,
        bodyGuidOf,
        guidIndex: () => (listing.guidIndex ??= guidIndexOfListing(listing.files, bodyGuidOf))
      });
      row = real === null ? null : (listing.byName.get(real) ?? null);
    }
    this.located.set(key, row);
    return row;
  }

  /** The stat the body was indexed under, from its manifest row. */
  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null {
    const row = this.rowFor(entry);
    return row ? { mtimeMs: row.mtimeMs, size: row.size } : null;
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    return this.cues.getCues(entry);
  }

  readCuesUncached(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    return this.cues.readCuesUncached ? this.cues.readCuesUncached(entry) : this.cues.getCues(entry);
  }

  transcriptSource(entry: TranscriptDigestEntry): TranscriptSource | null {
    return this.cues.transcriptSource ? this.cues.transcriptSource(entry) : null;
  }

  /** The shows the manifest describes. */
  showIds(): string[] {
    return [...this.listings.keys()];
  }
}
