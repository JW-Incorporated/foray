import type { ParsedEpisode } from "../../backend/src/feeds/parser";

/**
 * The id a live-feed episode is served under, by BOTH the per-show list
 * (api/shows/[show_id]/episodes.ts) and the show-scoped search
 * (api/episodes/search.ts). A guid-less episode needs a fallback, and the two
 * used to disagree: the list minted `noguid:<title>:<published_at or feed
 * position>` while search returned `guid: null`, so the client could not match
 * a search hit to the row it already had (round-3 audit, supporting L2's
 * app-1-5). `idx` is the episode's position in the WHOLE parsed feed, before
 * any filtering, so both endpoints mint the same string for the same item.
 * An empty-string guid is no identity at all and takes the fallback too.
 */
export function liveEpisodeGuid(ep: Pick<ParsedEpisode, "guid" | "title" | "publishedAt">, idx: number): string {
  return ep.guid || `noguid:${ep.title}:${ep.publishedAt ?? idx}`;
}
