import * as fs from "fs";
import * as path from "path";
import type { MintedSegmentSource } from "./audioSourceLookup";
import { deriveItemId, legacyItemId, type TranscriptDigestEntry } from "./transcriptArchiveLookup";

/**
 * GV-83 (W3-12; MQ-07, QK-21, GP-22): which SHOW a tape item came from, as one
 * stable key, so the report can say how many shows a Foray quotes and how much
 * of its tape the largest one carries.
 *
 * THE ITEM-ID PREFIX ALONE IS NOT RELIABLE. A minted or archive-backed id is
 * `<show_id>--<slug>` (`legacyItemId`), but 69 of the 255 committed pool rows in
 * `data/segments.json` carry an id with no `--` at all (`am-sba-lender-
 * roundtable`), and `taxonomyFamily.ts` notes 67 of 212 pool segments have no
 * catalogue show. So the key is resolved in this order, the first that answers
 * wins:
 *
 *   1. The archive entry the id was derived from (`deriveItemId`, or the
 *      pre-gen-6 `legacyItemId`): its `show_id`. Every minted item has one.
 *   2. The show TITLE the item is filed under: the run's own minted source rows
 *      first (`newSegmentSources`, not on disk yet), then
 *      `data/segment-sources.json` (the same item-id -> title registry
 *      `taxonomyFamily.ts` and `veracityMetrics.ts` read). A title that matches
 *      a `data/catalog.json` show is that show's `show_id`; one that does not is
 *      `title:<normalized title>`.
 *   3. Last resort: the item id's prefix before `--`, or the whole id.
 *
 * Measure-only (no gate reads it). A show whose catalogue title differs from
 * its segment-sources title would split into two keys; the committed-data test
 * in showIdentity.test.ts measures that join.
 */

export interface ShowIdentityContext {
  /** The run's transcript digest archive (`loadTranscriptArchive`). */
  archive?: readonly TranscriptDigestEntry[];
  /** The `data/segment-sources.json` rows this run minted (`SourceBeatsResult.newSegmentSources`). */
  newSegmentSources?: readonly MintedSegmentSource[];
  /** Repo root holding `data/catalog.json` and `data/segment-sources.json`. */
  root?: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** A show title as a key: diacritics folded, lower case, every run of
 * non-alphanumerics one space, trimmed. */
export function normalizeShowTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface ShowTables {
  showIdByTitle: Map<string, string>;
  showTitleByItemId: Map<string, string>;
}

const tablesByRoot = new Map<string, ShowTables>();

function cachingDisabled(): boolean {
  return process.env.FORAY_SKIP_CATALOGUE_CACHE === "1";
}

function readJsonIfPresent<T>(file: string): T | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-relative data file under the caller's root, not external input.
  if (!fs.existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function showTables(root: string): ShowTables {
  const cached = tablesByRoot.get(root);
  if (cached && !cachingDisabled()) return cached;
  const showIdByTitle = new Map<string, string>();
  const catalog = readJsonIfPresent<{ shows?: Array<{ show_id?: unknown; title?: unknown }> }>(path.join(root, "data", "catalog.json"));
  for (const show of catalog?.shows ?? []) {
    if (typeof show.show_id !== "string" || !show.show_id || typeof show.title !== "string") continue;
    const key = normalizeShowTitle(show.title);
    /* The first catalogue row under a title keeps it. */
    if (key && !showIdByTitle.has(key)) showIdByTitle.set(key, show.show_id);
  }
  const showTitleByItemId = new Map<string, string>();
  const sources = readJsonIfPresent<{ sources?: Array<{ id?: unknown; show?: unknown }> }>(path.join(root, "data", "segment-sources.json"));
  for (const source of sources?.sources ?? []) {
    if (typeof source.id === "string" && typeof source.show === "string") showTitleByItemId.set(source.id, source.show);
  }
  const tables = { showIdByTitle, showTitleByItemId };
  tablesByRoot.set(root, tables);
  return tables;
}

/** Test seam: drops the per-root catalogue tables and archive indexes. */
export function resetShowIdentityCache(): void {
  tablesByRoot.clear();
  archiveIndexes = new WeakMap();
}

let archiveIndexes = new WeakMap<readonly TranscriptDigestEntry[], Map<string, string>>();

/** item id -> show_id over an archive, built once per archive array. The
 * current id (`deriveItemId`) wins over a legacy one an entry shares. */
function archiveIndex(archive: readonly TranscriptDigestEntry[]): Map<string, string> {
  const cached = archiveIndexes.get(archive);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const entry of archive) {
    if (typeof entry.show_id === "string" && entry.show_id) index.set(deriveItemId(entry), entry.show_id);
  }
  for (const entry of archive) {
    if (typeof entry.show_id !== "string" || !entry.show_id) continue;
    const legacy = legacyItemId(entry);
    if (!index.has(legacy)) index.set(legacy, entry.show_id);
  }
  archiveIndexes.set(archive, index);
  return index;
}

/** The show key for one tape item id (see the module comment for the order).
 * Never empty for a non-empty id. */
export function showKeyForItem(itemId: string, ctx: ShowIdentityContext = {}): string {
  const id = String(itemId ?? "").trim();
  if (!id) return "";
  if (ctx.archive && ctx.archive.length > 0) {
    const showId = archiveIndex(ctx.archive).get(id);
    if (showId) return showId;
  }
  const tables = showTables(ctx.root ?? REPO_ROOT);
  const minted = ctx.newSegmentSources?.find((s) => s.id === id);
  const title = minted && typeof minted.show === "string" && minted.show.trim() ? minted.show : tables.showTitleByItemId.get(id);
  if (title !== undefined) {
    const normalized = normalizeShowTitle(title);
    if (normalized) return tables.showIdByTitle.get(normalized) ?? `title:${normalized}`;
  }
  const cut = id.indexOf("--");
  return cut > 0 ? id.slice(0, cut) : id;
}
