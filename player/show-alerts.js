/* New-episode alerts for followed shows: the rules (PQ-25, issue #761;
 * docs/roadmap/player-features.md §3; README default Q20).
 *
 * Not on the boot path yet (CH-07): nothing in the page imports this module
 * until PQ-26 wires it, so the web neither modulepreloads, precaches nor
 * deploys it — importing it from client.js is what puts it on all three.
 *
 * WHY THIS EXISTS. Following a show (`cp_starred_shows`, written only by
 * app.js `toggleShowStar`) is today a marker and nothing more. Q20 adds one
 * promise to it: when a followed show publishes a new episode, the device
 * notices and says so — on when you follow, with a per-show switch to turn it
 * off. This file is the whole of that rule set, written over the follow
 * record itself so no second store, event type or key is needed: the record
 * `{ show_id, title, artwork_url, starred_at }` GAINS fields and keeps its
 * key (the plan's "only gains fields" clause; the legal row is PQ-27's).
 *
 * THE FIELDS (all optional; an older record has none of them):
 *   alerts               false when the listener turned alerts off for this
 *                        show. ABSENT means on — a record written before this
 *                        file exists is a follow, and a follow has alerts on.
 *   checked_at           ISO time of the last feed check.
 *   latest_published_at  the newest `published_at` the last check saw.
 *   seen_published_at    the watermark: the newest publish date the listener
 *                        has been shown. Rows newer than this are "new".
 *   unseen_count         how many rows the last check found past the
 *                        watermark — what the badge prints.
 *
 * THE RULES.
 * - A fresh follow has no watermark. The FIRST check seeds it to the newest
 *   row and reports 0 new: following a show is not a backlog of alerts for
 *   every episode it ever published.
 * - "New" is `published_at > seen_published_at` as an ISO-8601 string compare
 *   (the API writes UTC ISO strings, so lexical order is time order; no Date
 *   parse, so a malformed row cannot throw). An equal timestamp is not new.
 *   A row without `published_at` cannot be placed and is ignored.
 * - A check is due when there has been none, or at least CHECK_INTERVAL_MS
 *   (6 h) have passed — `>=`, so a check at exactly the interval runs. A
 *   missing `now` means the wall clock; a `now` that cannot be read means
 *   due: the cheap failure is one extra check, the dear one is a show whose
 *   alerts never run again.
 * - The watermark and the latest never move BACKWARDS. A page can shrink or
 *   reorder (an episode unpublished, a transient API answer); if `latest`
 *   followed it down, `markSeen` would lower the watermark and the episode
 *   would be "new" again when it came back — a phantom badge here, a
 *   duplicate notification once the native tasks mirror this rule.
 * - `markSeen` moves the watermark to the latest seen and zeroes the count;
 *   opening the show page is where app.js calls it (PQ-26).
 * - `alertText` is the notification: the show's title over the newest
 *   episode's title.
 *
 * PURE, AND INJECTED. Nothing here reads storage, the clock or the network.
 * Every function takes the record (and rows, and `now`) and returns a NEW
 * record — the caller (PQ-26's app.js wiring, and the native refresh tasks
 * PQ-28/PQ-29 mirror case for case) owns the write through `editStored`.
 * `rows` are `api/shows/[show_id]/episodes` rows, page 1 newest-first; the
 * order is not relied on — the max is computed.
 */

export const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

const isObject = (v) => v != null && typeof v === "object";

/** Rows with a usable `published_at`, in the order given. */
function datedRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => isObject(r) && typeof r.published_at === "string" && r.published_at !== ""
  );
}

/** The later of two ISO stamps (either may be absent). */
function laterOf(a, b) {
  const aOk = typeof a === "string" && a !== "";
  const bOk = typeof b === "string" && b !== "";
  if (!aOk) return bOk ? b : null;
  if (!bOk) return a;
  return b > a ? b : a;
}

/** The newest `published_at` among the rows, or null when none carries one. */
function latestOf(rows) {
  let latest = null;
  for (const r of datedRows(rows)) {
    if (latest === null || r.published_at > latest) latest = r.published_at;
  }
  return latest;
}

/** Alerts are on unless the listener turned them off for this show. */
export function alertsOn(record) {
  return !(isObject(record) && record.alerts === false);
}

/** A copy of the record with the per-show switch set. */
export function setAlerts(record, on) {
  return { ...(isObject(record) ? record : {}), alerts: Boolean(on) };
}

/** True when the show has never been checked, or the interval has elapsed. */
export function dueForCheck(record, now) {
  const checkedAt = isObject(record) ? record.checked_at : undefined;
  if (!checkedAt) return true;
  const then = Date.parse(checkedAt);
  if (!Number.isFinite(then)) return true;
  const at = typeof now === "number" ? now : now == null ? Date.now() : Date.parse(now);
  if (!Number.isFinite(at)) return true;
  return at - then >= CHECK_INTERVAL_MS;
}

/** Rows published after the record's watermark. No watermark → nothing is new. */
export function newSince(rows, record) {
  const seen = isObject(record) ? record.seen_published_at : undefined;
  if (typeof seen !== "string" || seen === "") return [];
  return datedRows(rows).filter((r) => r.published_at > seen);
}

/** The record after a feed check: stamped, the latest noted, the new counted,
 *  and the watermark seeded on a first check. */
export function afterCheck(record, rows, now) {
  const base = isObject(record) ? record : {};
  // Never backwards: a page that lost or reordered a row does not lower the latest.
  const latest = laterOf(latestOf(rows), base.latest_published_at);
  const hadWatermark = typeof base.seen_published_at === "string" && base.seen_published_at !== "";
  /* A `now` that cannot be read (a malformed string, NaN) stamps the wall
     clock rather than throwing out of a feed check — the same "cheap failure"
     rule `dueForCheck` applies, in the other direction. */
  let at = typeof now === "number" ? new Date(now) : new Date(now ?? Date.now());
  if (Number.isNaN(at.getTime())) at = new Date();
  return {
    ...base,
    checked_at: at.toISOString(),
    latest_published_at: latest,
    unseen_count: hadWatermark ? newSince(rows, base).length : 0,
    seen_published_at: hadWatermark ? base.seen_published_at : latest
  };
}

/** The listener has seen the show: the watermark catches up and the badge clears. */
export function markSeen(record) {
  const base = isObject(record) ? record : {};
  return {
    ...base,
    unseen_count: 0,
    // Catches up to the latest, and never steps back below what was already seen.
    seen_published_at: laterOf(base.latest_published_at, base.seen_published_at)
  };
}

/** The notification's two lines: the show over the newest episode. */
export function alertText(record, newest) {
  return {
    title: isObject(record) && typeof record.title === "string" ? record.title : "",
    body: isObject(newest) && typeof newest.title === "string" ? newest.title : ""
  };
}
