/**
 * Episode identity & dedup (ADR 0002, corner case 3).
 *
 * GUIDs are unreliable: hosts regenerate them, feeds get republished, and
 * audio + video feeds of the same show duplicate every episode. Composite
 * identity = normalized(title) + published_date +/- 1 day + duration +/- 90s.
 *
 * Pure functions only — no I/O, no DB — so this is unit-testable in
 * isolation and reusable both at ingest time (compute `identity_key` for
 * the episodes table) and in an offline dedup pass (group candidates into
 * `dedup_group_id`s).
 */

const DATE_BUCKET_TOLERANCE_DAYS = 1;
const DURATION_TOLERANCE_SECONDS = 90;

/** Lowercase, strip punctuation/bracketed noise tags, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // strip bracketed/parenthesized noise commonly added per-feed-variant,
    // e.g. "(Video)", "[Explicit]", "(Audio Only)"
    .replace(/[([][^()[\]]*\b(video|audio|explicit|clean|re-?release|repost)\b[^()[\]]*[)\]]/gi, " ")
    .normalize("NFKD")
    // Strip every combining mark (diacritics in any script), then keep
    // letters and digits in ANY script. The old ASCII-only class deleted
    // CJK, Cyrillic, Greek and Arabic outright, so non-Latin titles never
    // deduplicated and all shared one identity key (backend-rest-22).
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** YYYY-MM-DD (UTC) bucket for a published timestamp, or null if unknown. */
function dateBucket(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export interface EpisodeIdentityInput {
  title: string;
  publishedAt: string | null; // ISO 8601 or null
  durationSeconds: number | null;
}

/**
 * Deterministic string for DB indexing: normalized title + date bucket.
 * This is a *lookup key* (so candidates for fuzzy matching are cheap to
 * find via an index), not itself the full match rule — the +/-1 day and
 * +/-90s tolerances are applied by `isSameEpisode` across neighboring
 * buckets, not baked into this string.
 */
export function computeIdentityKey(input: EpisodeIdentityInput): string {
  const title = normalizeTitle(input.title);
  const bucket = dateBucket(input.publishedAt) ?? "unknown-date";
  return `${title}::${bucket}`;
}

function daysBetween(aIso: string, bIso: string): number | null {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * True when two episode records are the same underlying episode per the
 * composite identity rule. Duration comparison is skipped (non-blocking)
 * when either side is missing a duration, since duration is frequently
 * absent (corner case 6: "treat all metadata as hints") — title + date
 * proximity alone still has to agree.
 */
export function isSameEpisode(a: EpisodeIdentityInput, b: EpisodeIdentityInput): boolean {
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  if (normalizeTitle(a.title).length === 0) return false; // empty titles never match

  if (a.publishedAt && b.publishedAt) {
    const diffDays = daysBetween(a.publishedAt, b.publishedAt);
    if (diffDays === null || diffDays > DATE_BUCKET_TOLERANCE_DAYS) return false;
  } else if (a.publishedAt !== b.publishedAt) {
    // one has a date, the other doesn't — title match alone is too weak
    return false;
  }

  if (a.durationSeconds !== null && b.durationSeconds !== null) {
    if (Math.abs(a.durationSeconds - b.durationSeconds) > DURATION_TOLERANCE_SECONDS) return false;
  }

  return true;
}

export interface DedupCandidate extends EpisodeIdentityInput {
  id: string;
}

/**
 * Groups candidates into dedup clusters via union-find over pairwise
 * `isSameEpisode`. Returns a map of candidate id -> group id (the smallest
 * member id in the group, for determinism). Candidates that don't match
 * anyone else are omitted (caller treats "no entry" as "not part of any
 * group" / singleton).
 *
 * O(n^2) comparisons — fine at single-user/single-show batch sizes (tens to
 * low hundreds of candidates per dedup run, e.g. one show's back catalog
 * against its video-feed sibling). A production-scale version would first
 * bucket by identity_key +/- 1 day before comparing pairwise.
 */
export function groupDuplicates(candidates: DedupCandidate[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // path compression
    let cur = id;
    while (parent.get(cur) && parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // deterministic: smaller id string becomes root
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const c of candidates) {
    if (!parent.has(c.id)) parent.set(c.id, c.id);
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (isSameEpisode(a, b)) union(a.id, b.id);
    }
  }

  const groups = new Map<string, string>();
  for (const c of candidates) {
    const root = find(c.id);
    // record group membership only for actual groups of size >= 2
    groups.set(c.id, root);
  }

  // Drop singleton "groups" (no other member shares the root) so callers
  // can distinguish "genuinely deduped" from "just itself".
  const rootCounts = new Map<string, number>();
  for (const root of groups.values()) rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  for (const [id, root] of [...groups.entries()]) {
    if ((rootCounts.get(root) ?? 0) < 2) groups.delete(id);
  }

  return groups;
}
