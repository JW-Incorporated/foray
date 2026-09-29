import { isCuratedRow } from "./identity.mjs";

/* D13 dedupe — group by podcastGuid where present, else by normalised
   title+author; canonical record within a group = the one with a non-null
   itunesId, else the newest by newestItemPubdate (the plan's "recency
   field the dump provides" for identity purposes — same field D1 reads for
   liveness, kept consistent rather than introducing a second notion of
   "newest"). */

/** Lowercase, collapse whitespace, strip punctuation that varies between
    otherwise-identical listings ("Show: The Podcast" vs "Show - The
    Podcast"). Deliberately conservative — this is a fallback key, not a
    display string.

    UNICODE LETTERS AND DIGITS, NOT ASCII (audit round 3, arch-drift-3). The
    class was ASCII-only, so a title written only in Japanese, Cyrillic or
    Arabic normalised to "" and every guid-less non-Latin show in the dump
    shared the key `ta:|` and collapsed into ONE canonical row. \p{L}\p{N},
    with NFKD applied before lowercasing, is the rule the app and the API use
    for show titles (normaliseShowTitle). */
export function normalizeKey(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The group key for one row: podcastGuid when present (trimmed, non-empty,
    lowercased — guids are case-insensitive by RFC 4122), else normalised
    title+author. Returns `{ key, kind }` so a caller/test can see which
    path fired.

    A row whose title normalises to nothing (pure punctuation or emoji) has no
    title to group on, so it is keyed by its own id and never merges with
    anything: an unknown identity is not a shared one. */
export function groupKeyFor(row) {
  const guid = String(row.podcastGuid ?? "").trim();
  if (guid) return { key: `guid:${guid.toLowerCase()}`, kind: "guid" };
  const title = normalizeKey(row.title);
  if (!title) return { key: `id:${row.id}`, kind: "title_author" };
  const author = normalizeKey(row.itunesAuthor || row.itunesOwnerName || "");
  return { key: `ta:${title}|${author}`, kind: "title_author" };
}

/** Picks the canonical row within one group: non-null itunesId first
    (stable tie-break: lowest `id` among itunesId holders, for determinism),
    else the row with the newest `newestItemPubdate` (tie-break: lowest
    `id`). Every candidate is deterministic on `id` alone as the final
    tie-break, which is what makes two runs over the same fixture
    byte-identical (the card's acceptance criterion). */
export function pickCanonical(group, curated = null) {
  /* A CURATED MEMBER WINS THE GROUP, ahead of every other rule.

     D13's job is to pick one row when a show has several feeds in the dump.
     Its default preference (has an Apple id, else most recently updated) is
     right for shows we know nothing about, and wrong for the 220 we curate:
     for those, the feed in `data/catalog.json` is the one that was verified by
     hand and the one the app is fetching episodes from right now. Picking a
     sibling row instead breaks the join in `buildIdMap`, which matches on our
     feed URL and Apple id — the show survives the filter and still comes out
     "missing", which is exactly what the first real run reported for Odd Lots:
     a show publishing daily, alive on every measure, unmapped anyway.

     Ties among curated members (a show whose catalogue entry matches two rows)
     fall through to the normal rules below, restricted to those members, so
     the outcome stays deterministic. */
  const curatedMembers = curated ? group.filter((r) => isCuratedRow(r, curated)) : [];
  const scope = curatedMembers.length ? curatedMembers : group;

  const withItunes = scope.filter((r) => r.itunesId != null && r.itunesId !== 0);
  const pool = withItunes.length ? withItunes : scope;

  let best = null;
  for (const row of pool) {
    if (!best) { best = row; continue; }
    if (withItunes.length) {
      // Among itunesId holders there is no recency preference in the spec;
      // break ties on id for determinism.
      if (Number(row.id) < Number(best.id)) best = row;
      continue;
    }
    const a = Number(row.newestItemPubdate) || -Infinity;
    const b = Number(best.newestItemPubdate) || -Infinity;
    if (a > b || (a === b && Number(row.id) < Number(best.id))) best = row;
  }
  return best;
}

/** Groups rows by D13's key, then reduces each group to one canonical row.
   Returns `{ canonical, counts }` — counts covers group totals and the guid
   vs title+author split, which is what "report per-filter counts" implies
   for this stage too (the card groups D1's counts and D13's dedupe under
   the same "report counts" acceptance line). Deterministic order:
   canonical rows are returned sorted by `id` ascending, independent of
   input order or JS Map iteration quirks, for byte-identical output across
   runs. */
export function applyD13Dedupe(rows, { curatedKeys = null } = {}) {
  const groups = new Map();
  let guidGroups = 0, titleAuthorGroups = 0;
  for (const row of rows) {
    const { key, kind } = groupKeyFor(row);
    if (!groups.has(key)) {
      groups.set(key, { kind, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  const canonical = [];
  for (const { kind, rows: groupRows } of groups.values()) {
    if (kind === "guid") guidGroups++; else titleAuthorGroups++;
    canonical.push(pickCanonical(groupRows, curatedKeys));
  }
  canonical.sort((a, b) => Number(a.id) - Number(b.id));
  return {
    canonical,
    counts: {
      input_rows: rows.length,
      groups: groups.size,
      guid_groups: guidGroups,
      title_author_groups: titleAuthorGroups,
      canonical_rows: canonical.length,
      duplicates_collapsed: rows.length - canonical.length,
    },
  };
}
