/* Bookmarks inside episodes (issue #30 §1; roadmap PQ-12).

   A bookmark is the listener's OWN marker on the copy they were holding, which
   is the one kind of timestamp `player/seek-policy.js` lets us trust on a
   stitched show (see its header: OWN vs FOREIGN). So every row keeps the
   episode's duration at the moment it was set — `duration_sec` — and
   `bookmarkPrecision` hands that to `seekPrecision` as `recordedDuration`.
   If the copy later comes back 45 seconds longer, the bookmark is shown as
   "around minute N" instead of a hard-seek claim (corner case #2c).

   ── Where the rows live ───────────────────────────────────────────────────
   One `cp_bookmarks` key, `{ [episodeId]: Bookmark[] }`, on the device only
   (roadmap Q19: no new event type, never sent, never synced). The store is
   injected as `{ get(key, fallback), edit(key, fallback, fn) }` — app.js's
   storedValue/editStored — and this module never touches `localStorage`
   itself. `cp_` prefix: renaming wipes user state (CLAUDE.md).

   A WRITE IS AN EDIT, NOT A SET (code-health CH-09a, A1-03). `edit` hands
   `fn` the stored value and keeps what it returns; before storage has
   hydrated, app.js queues it and re-runs it over the SETTLED value, so a mark
   made while IndexedDB is still slow lands beside the durable bookmarks
   instead of writing `{thisOne}` over them. So every change below is a pure
   function of the stored value (it may run more than once, over a value this
   module has not seen), and the rules — dedupe and caps — are applied again
   inside it. What `get` shows (the page's view, queued edits included)
   decides only what the caller is told.

   ── The rules ─────────────────────────────────────────────────────────────
   - A row is `{ sec, label, created_at, duration_sec }`; `sec` is rounded to a
     whole second, `created_at` is the caller's clock as ISO.
   - Two bookmarks within DEDUPE_WINDOW_SEC of each other on one episode are
     the same bookmark: a double tap must not make two rows, and the existing
     one is handed back so the UI can say "already marked".
   - PER_EPISODE_CAP and TOTAL_CAP bound the key. Over either, the OLDEST
     `created_at` goes — per episode first, then overall — so a listener who
     marks a lot keeps what they marked most recently.
   - A refused write (store.edit returning false) adds nothing and returns
     null; the caller decides what to tell the listener. Nothing throws on a
     corrupt key: rows that are not `{sec: finite >= 0, created_at: string}`
     are dropped on read.
*/

import { seekPrecision, describeTimestamp, OWN } from "./seek-policy.js";

export const KEY = "cp_bookmarks";
export const PER_EPISODE_CAP = 50;
export const TOTAL_CAP = 500;
/** Two marks this close on one episode are one mark. */
export const DEDUPE_WINDOW_SEC = 5;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validRow(row) {
  return isPlainObject(row)
    && typeof row.sec === "number" && Number.isFinite(row.sec) && row.sec >= 0
    && typeof row.created_at === "string";
}

function normaliseRow(row) {
  return {
    sec: row.sec,
    label: typeof row.label === "string" && row.label ? row.label : null,
    created_at: row.created_at,
    duration_sec: typeof row.duration_sec === "number" && Number.isFinite(row.duration_sec) ? row.duration_sec : null,
  };
}

const bySec = (a, b) => a.sec - b.sec;
const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

/**
 * Every bookmark on the device, keyed by episode id. A non-object key reads as
 * `{}`; an episode whose value is not an array, or whose rows are all corrupt,
 * is left out; corrupt rows inside a good array are dropped.
 * @param {{get(key:string, fallback:any):any}} store
 * @returns {{[episodeId:string]: Array<{sec:number,label:string|null,created_at:string,duration_sec:number|null}>}}
 */
export function readAll(store) {
  let raw;
  try { raw = store.get(KEY, {}); } catch { raw = {}; }
  return normaliseAll(raw);
}

/** The stored value as rows: the rule `readAll` applies, for an edit too. */
function normaliseAll(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [episodeId, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter(validRow).map(normaliseRow).sort(bySec);
    if (kept.length) out[episodeId] = kept;
  }
  return out;
}

/** Change the stored map by `fn` (normalised map -> map) through the
    store's edit. False when the store refused it. */
function edit(store, fn) {
  let ok;
  try { ok = store.edit(KEY, {}, (raw) => fn(normaliseAll(raw))); } catch { ok = false; }
  return ok !== false;
}

/** The mark within DEDUPE_WINDOW_SEC of `sec` among `rows`, if any. */
const nearRow = (rows, sec) => rows.find((r) => Math.abs(r.sec - sec) <= DEDUPE_WINDOW_SEC);

/** `all` with `row` added under `episodeId` and both caps applied -- or
    unchanged when a mark within the dedupe window is already there. Mutates
    and returns `all` (the edit's own fresh copy). */
function placeRow(all, episodeId, row) {
  const rows = all[episodeId] || [];
  if (nearRow(rows, row.sec)) return all;

  let next = [...rows, row].sort(bySec);
  // Per-episode cap: the oldest marks on THIS episode go first.
  while (next.length > PER_EPISODE_CAP) {
    const oldest = [...next].sort(byCreated)[0];
    next = next.filter((r) => r !== oldest);
  }
  all[episodeId] = next;

  // Total cap: the oldest marks anywhere go, never the one just made (it is
  // the newest by construction unless the caller's clock ran backwards, in
  // which case we still keep it: the listener asked for it just now).
  let total = Object.values(all).reduce((n, list) => n + list.length, 0);
  while (total > TOTAL_CAP) {
    let victimEp = null;
    let victim = null;
    for (const [ep, list] of Object.entries(all)) {
      for (const r of list) {
        if (r === row) continue;
        if (!victim || byCreated(r, victim) < 0) { victim = r; victimEp = ep; }
      }
    }
    if (!victim) break;
    all[victimEp] = all[victimEp].filter((r) => r !== victim);
    if (!all[victimEp].length) delete all[victimEp];
    total -= 1;
  }
  return all;
}

/**
 * Mark a moment. Returns the row that now stands for it: the new one, or an
 * existing one within DEDUPE_WINDOW_SEC (nothing written then). Returns null
 * for a bad input or a refused write. The dedupe answers from the page's view
 * (`get`) and is applied again inside the edit, over the value it lands on.
 * @param {{get:Function,edit:Function}} store
 * @param {{episodeId:string, sec:number, durationSec?:number|null, label?:string|null, now?:number}} mark
 */
export function addBookmark(store, { episodeId, sec, durationSec = null, label = null, now = Date.now() } = {}) {
  if (!episodeId || typeof episodeId !== "string") return null;
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return null;

  const rounded = Math.round(sec);
  const near = nearRow(readAll(store)[episodeId] || [], rounded);
  if (near) return near;

  const row = {
    sec: rounded,
    label: typeof label === "string" && label ? label : null,
    created_at: new Date(now).toISOString(),
    duration_sec: typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : null,
  };

  // A fresh copy per run: the edit may be re-run, and the total cap finds
  // "the one just made" by identity.
  if (!edit(store, (all) => placeRow(all, episodeId, { ...row }))) return null;
  return row;
}

/**
 * Remove one bookmark by its `created_at`. True when something was removed
 * and the write took; the episode's key goes with its last row.
 */
export function removeBookmark(store, episodeId, createdAt) {
  if (!episodeId || typeof createdAt !== "string") return false;
  const rows = readAll(store)[episodeId];
  if (!rows || !rows.some((r) => r.created_at === createdAt)) return false;
  return edit(store, (all) => {
    const next = (all[episodeId] || []).filter((r) => r.created_at !== createdAt);
    if (next.length) all[episodeId] = next; else delete all[episodeId];
    return all;
  });
}

/** The episode's bookmarks, sorted by `sec`, as a copy the caller may mutate. */
export function listBookmarks(store, episodeId) {
  const rows = readAll(store)[episodeId];
  return rows ? rows.map((r) => ({ ...r })) : [];
}

/**
 * Can this bookmark be seeked to exactly? The bookmark is the listener's OWN
 * marker, so it is EXACT unless the episode is `dai_suspected` AND the copy in
 * hand has drifted more than DRIFT_TOLERANCE_SEC from the one it was set on.
 * @returns {{precision:string, reason:string}}
 */
export function bookmarkPrecision(item, bookmark, observedDurationSec) {
  return seekPrecision(item, {
    source: OWN,
    recordedDuration: bookmark?.duration_sec ?? undefined,
    observedDuration: observedDurationSec ?? undefined,
  });
}

/** What to call it: the listener's label, else "at 1:02:03" / "around minute 62". */
export function bookmarkLabel(bookmark, precision) {
  return bookmark?.label || describeTimestamp(bookmark?.sec, precision?.precision ?? precision);
}
