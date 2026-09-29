import type { ParsedEpisode } from "./parser";

/**
 * THE fallback identity for a feed episode, shared by the DB ingest
 * (catalog/ingestShowFeed.ts) and the live per-show list and show-scoped
 * search (api/_lib/liveEpisodeId.ts). One rule, so the same guid-less episode
 * has the same id whichever path served it (round-3 review, L6: the DB key
 * had grown an enclosure-URL prefix the live key did not have, so list and
 * search disagreed once DATABASE_URL was set, and every stored guid-less row
 * was duplicated on the next ingest).
 *
 *  - a real guid wins; an empty one is no identity (backend-rest-10);
 *  - otherwise title + publish date, the key both paths already used, which
 *    survives an enclosure URL rotating (tracking prefixes, CDN moves);
 *  - with no date, title + enclosure URL, which does not shift when the
 *    publisher prepends an episode the way a feed position does;
 *  - a feed position only as the last resort, for an item with neither.
 */
export function episodeIdentity(
  ep: Pick<ParsedEpisode, "guid" | "title" | "publishedAt"> & { enclosureUrl?: string | null },
  position?: number
): string {
  if (ep.guid) return ep.guid;
  if (ep.publishedAt) return `noguid:${ep.title}:${ep.publishedAt}`;
  if (ep.enclosureUrl) return `noguid:${ep.title}:${ep.enclosureUrl}`;
  return `noguid:${ep.title}:${position ?? ""}`;
}
