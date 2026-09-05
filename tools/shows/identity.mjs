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
