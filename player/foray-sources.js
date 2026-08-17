/* Who a Foray is actually made of — the publisher credit surface.

   ── Why this matters beyond UX ────────────────────────────────────────────
   A Foray plays nine episodes of five shows from those shows' own enclosure
   URLs (product principle #3, "legally boring": we never rehost, proxy or
   transform anybody's audio). Every second a listener spends here is a download
   against the publisher's own feed and their own numbers. What has been missing
   is the other half of that bargain: the listener seeing whose work they are
   hearing, in one place, with a way to go and get more of it. This module
   computes that block.

   ── What it decides ───────────────────────────────────────────────────────
     - which shows and episodes a resolved Foray draws on, in the order the
       listener meets them, with how much of the runtime each one carries
     - where "go and subscribe" points, given that our own data has a feed URL
       and usually nothing else

   ── The link, and its honest limit ────────────────────────────────────────
   `data/segment-sources.json` carries `feed_url` — an RSS document, which is
   not a page to send a human to. `data/discover.json` carries
   `apple_collection_id` for shows that happen to be in the recommendation pool,
   which today is one of this Foray's five. So the link is a two-tier answer: the
   show's real Apple Podcasts page when we know its id, and an Apple search for
   the show's name when we do not. Both are real https pages that land on the
   show; neither invents an id we have not verified. `linkKind` says which one a
   row got, so a surface can be honest about it rather than implying we have a
   direct page for all five.

   Pure: no DOM, no network. Everything arrives as arguments.
*/

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

export const APPLE_SHOW = "apple-show";
export const APPLE_SEARCH = "apple-search";

/**
 * The Apple Podcasts destination for a show.
 *
 * @param {string} show  the show's name as the source registry spells it
 * @param {number|string|null} [collectionId]  an Apple collection id, if known
 * @returns {{ url: string, kind: string } | null}
 */
export function showLink(show, collectionId = null) {
  if (!nonEmpty(show)) return null;
  const id = collectionIdOf(collectionId);
  if (id != null) {
    return { url: `https://podcasts.apple.com/us/podcast/id${id}`, kind: APPLE_SHOW };
  }
  return {
    url: `https://podcasts.apple.com/us/search?term=${encodeURIComponent(show.trim())}`,
    kind: APPLE_SEARCH,
  };
}

/**
 * Show name -> square artwork URL, harvested from the same pool, by the same
 * exact-name join, for the same reason (issue #27).
 *
 * The lock screen and a car head unit want a picture, and
 * `data/segment-sources.json` carries none — no artwork field exists on a source
 * at all. `data/discover.json` does carry one per show, so this is the only
 * artwork our own data can offer a Foray, and it is thin on purpose rather than
 * by oversight: of the 12 shows the two shipped Forays draw on, exactly one is
 * in the recommendation pool. The rest fall back to the app's own icon
 * (`player/media-session.js`), which is why a miss here is not a defect.
 *
 * Exact-name matched for the reason above: attaching one publisher's artwork to
 * another publisher's segment is the same error as attaching their page, and it
 * would be more visible, not less.
 */
export function artworkUrlsByShow(discoverDoc) {
  const map = new Map();
  const items = Array.isArray(discoverDoc?.items) ? discoverDoc.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !nonEmpty(item.show)) continue;
    if (map.has(item.show)) continue;
    if (nonEmpty(item.artwork_url)) map.set(item.show, item.artwork_url.trim());
  }
  return map;
}

/** Apple collection ids are positive integers. A float, a negative, or the
    string "null" is not one, and guessing produces a 404 with our name on it. */
function collectionIdOf(value) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Show name -> Apple collection id, harvested from the recommendation pool.
 *
 * Matched on the exact show name because that is the only key the two documents
 * share: `data/segment-sources.json` is keyed by episode id and
 * `data/discover.json` by its own item ids. Fuzzy matching here would attach one
 * publisher's page to another publisher's credit, which is the one error this
 * surface must not make — so an unmatched show simply gets the search link.
 */
export function collectionIdsByShow(discoverDoc) {
  const map = new Map();
  const items = Array.isArray(discoverDoc?.items) ? discoverDoc.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !nonEmpty(item.show)) continue;
    if (map.has(item.show)) continue;
    const id = collectionIdOf(item.apple_collection_id);
    if (id != null) map.set(item.show, id);
  }
  return map;
}

/**
 * Group a resolved Foray's running order by show, then by episode.
 *
 * Only PLAYABLE entries are counted. A segment that will not play sends the
 * publisher no traffic, so crediting them for it — and telling the listener "6
 * clips" when they will hear four — would be the flattering version rather than
 * the true one. A show with nothing playable left drops out entirely; the
 * running order above already says what was lost and why.
 *
 * @param {object} resolved  from `resolveForay`
 * @param {object} [opts]
 * @param {Map|object} [opts.collectionIds]  show -> Apple collection id
 * @returns {Array<{ show, clips, seconds, link, linkKind,
 *                   episodes: Array<{ id, title, clips, seconds }> }>}
 *   in the order the listener first meets each show.
 */
export function forayCredits(resolved, { collectionIds = null } = {}) {
  const ids = asMap(collectionIds);
  const byShow = new Map();

  for (const entry of resolved?.entries ?? []) {
    if (!entry || entry.playable !== true || !nonEmpty(entry.show)) continue;
    const seconds = isNum(entry.duration_sec) && entry.duration_sec > 0 ? entry.duration_sec : 0;

    let show = byShow.get(entry.show);
    if (!show) {
      show = { show: entry.show, clips: 0, seconds: 0, episodes: [], _byEpisode: new Map() };
      byShow.set(entry.show, show);
    }
    show.clips += 1;
    show.seconds += seconds;

    // An episode with no id cannot be de-duplicated against another, so it is
    // kept as its own row rather than merged into a bucket it may not belong to.
    const epKey = nonEmpty(entry.item_id) ? entry.item_id : `#${show.episodes.length}`;
    let ep = show._byEpisode.get(epKey);
    if (!ep) {
      ep = { id: nonEmpty(entry.item_id) ? entry.item_id : null, title: entry.episode_title ?? "", clips: 0, seconds: 0 };
      show._byEpisode.set(epKey, ep);
      show.episodes.push(ep);
    }
    ep.clips += 1;
    ep.seconds += seconds;
  }

  return [...byShow.values()].map(({ _byEpisode, ...show }) => {
    const link = showLink(show.show, ids.get(show.show) ?? null);
    return { ...show, link: link?.url ?? null, linkKind: link?.kind ?? null };
  });
}

/** A one-line summary of the credit block: "9 episodes from 5 shows". */
export function creditsSummary(credits) {
  const shows = (credits ?? []).length;
  const episodes = (credits ?? []).reduce((n, c) => n + (c.episodes?.length ?? 0), 0);
  if (!shows) return "";
  return `${episodes} episode${episodes === 1 ? "" : "s"} from ${shows} show${shows === 1 ? "" : "s"}`;
}

function asMap(x) {
  if (x instanceof Map) return x;
  if (x && typeof x === "object") return new Map(Object.entries(x));
  return new Map();
}
