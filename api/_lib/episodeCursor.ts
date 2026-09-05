/**
 * Keyset pagination cursor for the no-DB (live) episodes list (S-02, kanban
 * t_4bd3c0a3, D14). An offset cursor breaks the moment a feed publishes a
 * new episode between two page requests (everything shifts by one); a
 * keyset cursor on `(published_at, guid)` does not, because it resumes
 * strictly after a specific episode's sort key rather than at a numeric
 * position.
 *
 * The cursor is NOT a security boundary: it carries only public metadata
 * (an ISO timestamp + a feed guid) already visible in the same response,
 * this endpoint is read-only, and there is no SQL/query built from it in
 * no-DB mode (it only walks an in-memory array). A tampered cursor's worst
 * case is a wrong page of public episode data — never an error page, per
 * this repo's own "never a 500, never blank" convention (see
 * `episodes.ts`'s and `ingestShowFeed.ts`'s header comments), which is why
 * `decodeCursor` returns `null` on anything malformed instead of throwing.
 */

export interface EpisodeCursorKey {
  publishedAt: string | null; // ISO 8601, or null for episodes with no parseable date
  guid: string;
}

/** Opaque base64 encoding — deliberately not meant to be human-edited, only round-tripped. */
export function encodeCursor(key: EpisodeCursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** Never throws: a malformed/tampered/truncated cursor decodes to `null`, treated as "start from the top". */
export function decodeCursor(raw: string | null | undefined): EpisodeCursorKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      (typeof parsed.publishedAt === "string" || parsed.publishedAt === null) &&
      typeof parsed.guid === "string"
    ) {
      return { publishedAt: parsed.publishedAt, guid: parsed.guid };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strict tuple comparator matching the list's own sort order (published_at
 * descending, nulls last, guid as a tiebreaker ascending for a stable
 * total order). Bulk-imported feeds commonly carry many episodes with an
 * IDENTICAL `published_at` (a backfill import, or a publisher that stamps
 * a batch with one timestamp) — without the guid tiebreaker applied
 * identically in both the sort and the "is this row after the cursor"
 * check, a page boundary that falls inside such a run either skips or
 * duplicates rows.
 */
function keyOf(ep: { published_at: string | null; guid: string }): EpisodeCursorKey {
  return { publishedAt: ep.published_at, guid: ep.guid };
}

/** -1 / 0 / 1 in the list's own sort direction (descending by published_at, then ascending by guid). */
export function compareKeys(a: EpisodeCursorKey, b: EpisodeCursorKey): number {
  const at = a.publishedAt === null ? -Infinity : new Date(a.publishedAt).getTime();
  const bt = b.publishedAt === null ? -Infinity : new Date(b.publishedAt).getTime();
  if (at !== bt) return at > bt ? -1 : 1; // descending by time
  if (a.guid === b.guid) return 0;
  return a.guid < b.guid ? -1 : 1; // ascending by guid, stable tiebreak
}

/**
 * Sorts a full episode list into the canonical order (published_at desc,
 * guid asc tiebreak) and slices one page strictly after `cursor` (or from
 * the top when `cursor` is null/undecodable).
 */
export function paginate<T extends { published_at: string | null; guid: string }>(
  episodes: T[],
  cursor: EpisodeCursorKey | null,
  pageSize: number
): { page: T[]; nextCursor: string | null } {
  const sorted = [...episodes].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const startIdx = cursor === null ? 0 : sorted.findIndex((ep) => compareKeys(keyOf(ep), cursor) > 0);
  const from = startIdx === -1 ? sorted.length : startIdx;
  const page = sorted.slice(from, from + pageSize);
  const last = page[page.length - 1];
  const hasMore = from + pageSize < sorted.length;
  return { page, nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null };
}
