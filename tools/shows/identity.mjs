/* Feed-URL normalisation shared by identity (D2: feed URL is the join key)
   and the id-map builder. Same normalisation catalogue-broadening.md used
   to count "138,470 unique feeds" (scheme, case, trailing slash). */
export function normalizeFeedUrl(url) {
  let s = String(url ?? "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "");
  s = s.toLowerCase();
  s = s.replace(/\/+$/, "");
  return s;
}

/* THE TWO KEYS A CURATED SHOW IS RECOGNISED BY, and why this is its own
   function rather than a line inside the filter.

   A curated show is IN 4a by definition — it is hand-picked, it ships in
   `data/catalog.json`, and its episodes play in the app today. D1 ("alive,
   >= 3 episodes, published within 24 months") is a rule for deciding which of
   4.7M unknown feeds to carry; applied to a show we already curate it does the
   opposite of its job, REMOVING content a listener can reach right now. The
   first real run proved it: 16 of 220 curated shows never reached the id-map,
   and the ones I checked by fetching their feeds are simply finished —
   LeVar Burton Reads last published in May 2024, The Robot Brains in August
   2023, Black Box Down in June 2023. All three still serve a full back
   catalogue over HTTP 200. A completed podcast is not a dead one, and for a
   curiosity/learning product it is arguably the better shelf.

   So the exemption is keyed the same two ways `buildIdMap` matches, and built
   once from the curated catalogue rather than recomputed per row: normalised
   feed URL (D2's join key) and Apple collection id (the cross-reference). */
export function curatedKeys(curatedShows = []) {
  const feeds = new Set();
  const itunes = new Set();
  for (const show of curatedShows) {
    const norm = normalizeFeedUrl(show?.feed_url);
    if (norm) feeds.add(norm);
    if (show?.apple_collection_id != null) {
      const id = Number(show.apple_collection_id);
      if (Number.isFinite(id)) itunes.add(id);
    }
  }
  return { feeds, itunes };
}

/** True when a dump row is one of the curated catalogue's shows. Safe against
    a null/absent key set, so callers that have no curated catalogue (tests,
    a dry run) get the unexempted filter rather than a crash. */
export function isCuratedRow(row, keys) {
  if (!keys) return false;
  const norm = normalizeFeedUrl(row?.url);
  if (norm && keys.feeds.has(norm)) return true;
  if (row?.itunesId != null) {
    const id = Number(row.itunesId);
    if (Number.isFinite(id) && keys.itunes.has(id)) return true;
  }
  return false;
}
