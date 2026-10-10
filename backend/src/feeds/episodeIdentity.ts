import type { ParsedEpisode } from "./parser";

/**
 * THE id a feed episode is served and stored under, by every path that mints
 * one: the DB ingest and the live per-show list (both through
 * catalog/ingestShowFeed.ts toCatalogEpisode) and the show-scoped search
 * (api/episodes/search.ts mapLiveEpisode). One rule, so the same episode has
 * the same id whichever path served it:
 *  - the list and the search used to disagree for a guid-less episode (the
 *    list minted a fallback, search returned `guid: null`), so the client
 *    could not match a search hit to the row it already had (round-3 audit,
 *    supporting L2's app-1-5);
 *  - the DB key had grown an enclosure-URL prefix the live key did not have,
 *    so list and search disagreed once DATABASE_URL was set, and every stored
 *    guid-less row was duplicated on the next ingest (round-3 review, L6).
 *
 * The rule:
 *  - a real guid wins; an empty one is no identity (backend-rest-10);
 *  - otherwise title + publish date, the key both paths already used, which
 *    survives an enclosure URL rotating (tracking prefixes, CDN moves);
 *  - with no date, title + enclosure URL, which does not shift when the
 *    publisher prepends an episode the way a feed position does.
 *
 * NO FEED POSITION (code-health-2 CH2-35, B1-07, A1-13). The enclosure URL is
 * required: every caller drops an item without one before it asks (no audio,
 * no playable episode), so the position-keyed last resort this used to have
 * was unreachable, and the api/ pass-through module that wrapped this
 * function and the feed index threaded through both endpoints existed only to
 * feed it. A position shifts on every prepend; do not reintroduce one (the
 * identity test in api/_test/live-episode-id.test.mjs pins the one-argument
 * signature).
 */
export function episodeIdentity(
  ep: Pick<ParsedEpisode, "guid" | "title" | "publishedAt"> & { enclosureUrl: string }
): string {
  if (ep.guid) return ep.guid;
  if (ep.publishedAt) return `noguid:${ep.title}:${ep.publishedAt}`;
  return `noguid:${ep.title}:${ep.enclosureUrl}`;
}
