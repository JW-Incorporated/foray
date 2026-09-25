import type { ParsedEpisode } from "../../backend/src/feeds/parser";
import { episodeIdentity } from "../../backend/src/feeds/episodeIdentity";

/**
 * The id a live-feed episode is served under, by BOTH the per-show list
 * (api/shows/[show_id]/episodes.ts) and the show-scoped search
 * (api/episodes/search.ts). A guid-less episode needs a fallback, and the two
 * used to disagree: the list minted `noguid:<title>:<published_at or feed
 * position>` while search returned `guid: null`, so the client could not match
 * a search hit to the row it already had (round-3 audit, supporting L2's
 * app-1-5). `idx` is the episode's position in the WHOLE parsed feed, before
 * any filtering, so both endpoints mint the same string for the same item;
 * it is used only for an item with neither a date nor an enclosure URL.
 * An empty-string guid is no identity at all and takes the fallback too.
 */
export function liveEpisodeGuid(ep: Pick<ParsedEpisode, "guid" | "title" | "publishedAt"> & { enclosureUrl?: string | null }, idx: number): string {
  // The DB ingest mints its ids with the same function (round-3 review, L6),
  // so a guid-less episode keeps one id whichever path served it. For an
  // undated one the enclosure URL now stands in for the feed position, which
  // shifted every time the publisher prepended an episode.
  return episodeIdentity(ep, idx);
}
