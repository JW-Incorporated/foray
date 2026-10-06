/* The downloads record: what is on this device, what state each file is in,
 * which one goes first when the cap is reached, and what the player should
 * actually open.
 *
 * Issue #29, Store/Policy; docs/roadmap/player-features.md PQ-16. The founder
 * defaults in force (roadmap README Q17): downloads are MANUAL and per
 * episode, Wi-Fi only unless the listener flips the cellular switch, a 2 GB
 * cap enforced by least-recently-played eviction that never takes an episode
 * the listener is partway through, and no prefetch of any kind.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is the pure half — rules over one JSON
 * value, no I/O beyond a Storage-shaped read/write pair, no bridge, no
 * element. The native downloader and its events are PQ-17's bridge
 * (`download-bridge.js`), the controls and the Library section are PQ-18's
 * app.js work, and playing from the file is PQ-19's client.js change. Keeping
 * the rules here means every one of them is tested without a device, and the
 * Swift and Media3 ports have one place to read the contract from.
 *
 * ONE ROW, NOT ONE ROW PER EPISODE. `cp_pos:<id>` is per episode because a
 * position is written every few seconds while playing; a download changes
 * state a handful of times in its life, and the Library needs the whole set
 * at once to draw a list and a usage line. One record under one key is the
 * cheaper shape for both.
 *
 * WHAT IS NOT STORED HERE. The listener's POSITION in a downloaded episode is
 * `position-store.js`'s and nobody else's — `evictionPlan` takes positions as
 * an argument precisely so this module never grows a second opinion about
 * where the listener got to. The audio bytes live in the app's own files
 * directory (Application Support on iOS, the files dir on Android), never in
 * this record; `path` is where to find them. */

import { NEAR_END_SEC, MIN_RESUME_SEC } from "./position-store.js";

/** The one record. `cp_` prefix: renaming wipes user state (CLAUDE.md), and
    the prefix is what "Delete my data" enumerates. */
export const KEY = "cp_downloads";

/** Q17 default: 2 GB, binary — the unit the usage line shows. */
export const DEFAULT_CAP_BYTES = 2 * 1024 ** 3;

/** The closed life of a download, in the order a file goes through it.
 *
 *   queued           asked for, not yet moving (also: waiting for Wi-Fi)
 *   downloading      bytes arriving; `bytes` of `total`
 *   done             on disk at `path`; the only status that counts towards
 *                    the cap or plays from the file
 *   failed           the downloader gave up; `reason` says why; retryable
 *   unplayable-here  fetched, but this device cannot decode it (`reason`);
 *                    streaming may still work
 *   missing          was `done`, but the file is gone (the OS reclaimed it,
 *                    a restore from backup without the files); streams
 *
 * An unknown status in a stored record is dropped on read rather than
 * guessed at — a row from a newer build is not a row this build can act on. */
export const STATUSES = ["queued", "downloading", "done", "failed", "unplayable-here", "missing"];

const STATUS_SET = new Set(STATUSES);
const KEEPS_REASON = new Set(["failed", "unplayable-here"]);
const IN_FLIGHT = new Set(["queued", "downloading"]);

/* ---------- small, local helpers ---------- */

const isStr = (v) => typeof v === "string" && v.length > 0;
const strOrNull = (v) => (isStr(v) ? v : null);
const nonNegOrZero = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const posOrNull = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/** Timestamps are ISO strings in the record so a JSON round trip is lossless
    and two records compare with `<`. Accepts a Date, epoch ms or an ISO
    string; anything unreadable is "now". */
function iso(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (typeof now === "number" && Number.isFinite(now)) return new Date(now).toISOString();
  if (typeof now === "string") {
    const t = Date.parse(now);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** One item, normalised, or null when it is not a row this build can hold.
    A `done` row with no `path` is a contradiction a crash or a half-written
    JSON could leave behind: it is read back as `missing`, which is what the
    player does with a done row whose file is not there anyway. */
function normaliseItem(id, raw) {
  if (!isStr(id) || !raw || typeof raw !== "object") return null;
  if (!STATUS_SET.has(raw.status)) return null;
  let status = raw.status;
  let path = strOrNull(raw.path);
  if (status === "done" && !path) status = "missing";
  if (status === "missing") path = null;
  return {
    status,
    bytes: nonNegOrZero(raw.bytes),
    total: posOrNull(raw.total),
    path,
    webSrc: strOrNull(raw.webSrc),
    observed_duration_sec: posOrNull(raw.observed_duration_sec),
    updated_at: strOrNull(raw.updated_at),
    last_played_at: strOrNull(raw.last_played_at),
    reason: KEEPS_REASON.has(status) ? strOrNull(raw.reason) : null,
    source_url: strOrNull(raw.source_url),
  };
}

/** The whole value, normalised. Anything that is not an object becomes the
    empty record with the founder's defaults — a corrupt value is the same as
    no value, and losing a list of downloads beats a Library that dies on a
    parse. */
export function normaliseDownloads(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const settings = value.settings && typeof value.settings === "object" ? value.settings : {};
  const items = {};
  if (value.items && typeof value.items === "object") {
    for (const id of Object.keys(value.items)) {
      const rec = normaliseItem(id, value.items[id]);
      if (rec) items[id] = rec;
    }
  }
  return {
    settings: {
      cellular: settings.cellular === true,
      capBytes: posOrNull(settings.capBytes) ?? DEFAULT_CAP_BYTES,
    },
    items,
  };
}

/** Read the record, or the empty one. Never throws.

    `storage` is anything Storage-shaped (`getItem`/`setItem`/`removeItem` over
    strings). On the web that is the backend app.js's lsGet/lsSet use —
    DurableStore once player/client.js has published it — so this pair is the
    ONE reader and writer of `cp_downloads` (CH-02, X1-03): app.js's
    `downloadsValue`/`saveDownloads` are thin calls through it and never spell
    the key. */
export function readDownloads(storage) {
  if (!storage) return normaliseDownloads(null);
  try {
    const raw = storage.getItem(KEY);
    return normaliseDownloads(raw ? JSON.parse(raw) : null);
  } catch (_) {
    return normaliseDownloads(null);
  }
}

/** Write it. `null` removes the row (Delete my data takes the files
    separately; this is the record). Returns whether the store took it. */
export function writeDownloads(storage, value) {
  if (!storage) return false;
  try {
    if (value === null) { storage.removeItem(KEY); return true; }
    return storage.setItem(KEY, JSON.stringify(normaliseDownloads(value))) !== false;
  } catch (_) {
    return false;
  }
}

/* ---------- transitions ---------- */

/** A progress report from the downloader → the next value. Pure: the input
    is never mutated, and a report the record cannot accept returns the SAME
    value (identity), so a caller can tell a refusal from a no-op change.
    Refused: no id, an unknown status, and `done` without a `path` — a done
    row with nowhere to play from is the one shape the player cannot act on,
    so it never enters the record. `failed` / `unplayable-here` keep their
    `reason`; every other status clears it, so a retried download does not
    carry last week's error.

    A LATE TICK NEVER UN-FINISHES A FILE (integration review, 2026-10-04).
    Progress and completion arrive on different paths — PQ-22 polls
    `DownloadManager` every 2 s while a broadcast receiver reports completion,
    and iOS delivers `URLSession` callbacks on their own queue — so a
    `downloading` tick can land AFTER `done`. Taken at face value it would
    flip "Downloaded ✓" back to "Downloading 100%" for good (no second `done`
    follows), stop the file counting against the cap and stream an episode
    that is on disk. So `queued`/`downloading` for a `done` row is refused
    (identity). A real re-download goes through Remove first, which deletes
    the row.
    MUTATION TO BREAK THIS: delete the `IN_FLIGHT` guard line and `a late
    progress tick after done is refused` fails. */
export function applyProgress(value, report = {}) {
  const { id, status, bytes, total, path, webSrc, reason, now } = report;
  if (!isStr(id) || !STATUS_SET.has(status)) return value;
  if (status === "done" && !isStr(path)) return value;
  const base = normaliseDownloads(value);
  const prev = base.items[id] || null;
  if (prev && prev.status === "done" && IN_FLIGHT.has(status)) return value;
  const next = {
    status,
    bytes: Number.isFinite(bytes) ? nonNegOrZero(bytes) : (prev ? prev.bytes : 0),
    total: Number.isFinite(total) ? posOrNull(total) : (prev ? prev.total : null),
    path: status === "missing" ? null : (isStr(path) ? path : (prev ? prev.path : null)),
    webSrc: isStr(webSrc) ? webSrc : (prev ? prev.webSrc : null),
    observed_duration_sec: posOrNull(report.observed_duration_sec) ?? (prev ? prev.observed_duration_sec : null),
    updated_at: iso(now),
    last_played_at: prev ? prev.last_played_at : null,
    reason: KEEPS_REASON.has(status) ? (strOrNull(reason) ?? (prev ? prev.reason : null)) : null,
    source_url: strOrNull(report.source_url) ?? (prev ? prev.source_url : null),
  };
  // A finished file is its own total: the usage line should not read 0 of null.
  if (status === "done" && next.total == null && next.bytes > 0) next.total = next.bytes;
  return { ...base, items: { ...base.items, [id]: next } };
}

/**
 * One `download-bridge.js` event → the report `applyProgress` takes, or null
 * for an event this build does not know or a payload with no id.
 *
 * WHY THIS EXISTS (integration review, 2026-10-04). The bridge forwards
 * `onEvent(name, payload)` and `applyProgress` keys on a record `status`, and
 * nothing joined the two: `downloadProgress` carries no status at all, and
 * `downloadFailed`'s `status` is the HTTP status (403), not a record status —
 * spread straight into `applyProgress` it is an unknown status and the
 * failure is silently dropped. The mapping is a rule, so it lives here,
 * beside the record it feeds, rather than in app.js:
 *
 *   downloadProgress {id, bytes, total}   → downloading
 *   downloadDone     {id, path, bytes}    → done (the file is its own total;
 *                                            `webSrc` is the caller's
 *                                            `bridge.fileSrc({path})`)
 *   downloadFailed   {id, reason, status} → unplayable-here when the host
 *                                            refused this device (HTTP 403, the
 *                                            plan's PQ-20/22 rule) or the
 *                                            plugin says so; else failed. The
 *                                            reason is the plugin's, or
 *                                            "http <status>".
 *
 * MUTATION TO BREAK THIS: map `downloadFailed` to `status: p.status` and
 * `reportFromEvent maps each bridge event to a record status` fails.
 */
export function reportFromEvent(name, payload, { webSrc, now } = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (!isStr(p.id)) return null;
  if (name === "downloadProgress") return { id: p.id, status: "downloading", bytes: p.bytes, total: p.total, now };
  if (name === "downloadDone") return { id: p.id, status: "done", path: p.path, bytes: p.bytes, total: p.bytes, webSrc, now };
  if (name === "downloadFailed") {
    const refused = p.status === 403 || p.reason === "unplayable-here";
    const reason = strOrNull(p.reason) ?? (Number.isFinite(p.status) ? `http ${p.status}` : null);
    return { id: p.id, status: refused ? "unplayable-here" : "failed", reason, now };
  }
  return null;
}

/** The episode was played from its download: it moves to the back of the
    eviction queue. An id with no record is a no-op (identity).

    THE ONE CALLER (CH-02, P2-01). app.js's `window.forayDownloads.onPlayedFromFile`,
    which player/client.js's `play()` fires where a LOCAL load succeeded — the
    point it spends its `localAttempt` ticket on success. Not from `playSource`
    or client.js's `localSourceFor`: they CHOOSE the file, and a chosen file can
    be missing (the load fails, the record is marked `missing`, the play
    streams). Stamping there would call an evicted file the freshest one. Until
    this had a caller every `last_played_at` was null and the
    least-recently-played cap evicted the file listened to daily first. */
export function markPlayed(value, id, now) {
  const base = normaliseDownloads(value);
  const prev = base.items[id];
  if (!prev) return value;
  return { ...base, items: { ...base.items, [id]: { ...prev, last_played_at: iso(now) } } };
}

/** The file is not where the record said. The row stays — the listener asked
    for this episode and the Library should say so — but it is `missing`:
    streams, counts for nothing against the cap, and is one tap from a
    re-download. An id with no record is a no-op (identity). */
export function markMissing(value, id) {
  const base = normaliseDownloads(value);
  const prev = base.items[id];
  if (!prev) return value;
  return {
    ...base,
    items: { ...base.items, [id]: { ...prev, status: "missing", path: null, reason: null } },
  };
}

/** The record without one episode's row: what Remove, Remove all's per-file
    step and an eviction leave behind. The plugin deletes the FILE; this is the
    record's half, and it lives here beside the other transitions rather than
    in app.js (CH-02, P2-11). An id with no record is a no-op (identity). */
export function removeRow(value, id) {
  const base = normaliseDownloads(value);
  if (!base.items[id]) return value;
  const items = { ...base.items };
  delete items[id];
  return { ...base, items };
}

/* ---------- the cap ---------- */

/** Bytes on disk: `done` rows only. A download in flight has not yet earned
    its place, and a missing one has none to count. */
export function usedBytes(value) {
  const { items } = normaliseDownloads(value);
  let sum = 0;
  for (const rec of Object.values(items)) if (rec.status === "done") sum += rec.bytes;
  return sum;
}

/** Is this episode one the listener is partway through? The resume rules are
    `position-store.js`'s — under MIN_RESUME_SEC nothing is worth resuming to,
    and inside NEAR_END_SEC of the end it is effectively finished — and this
    reads them rather than restating them. An unknown duration with a real
    position counts as in progress: with no end in sight the listener may be
    anywhere, and evicting a half-heard three-hour episode to save 80 MB is
    the complaint this guard exists to prevent. */
export function isInProgress(pos, record) {
  if (!pos || !Number.isFinite(pos.sec)) return false;
  const dur = posOrNull(pos.durationSec) ?? (record && posOrNull(record.observed_duration_sec)) ?? null;
  return pos.sec >= MIN_RESUME_SEC && (dur == null || pos.sec <= dur - NEAR_END_SEC);
}

/** Least recently PLAYED. A download that was never played ranks by when it
    finished — its one "use" is the download itself — and a row with neither
    ranks first. Ties break on id so two devices with the same record agree. */
function lruKey(rec) {
  return rec.last_played_at ?? rec.updated_at ?? "";
}

/**
 * Which downloads to remove so that the `done` bytes fit under the cap.
 *
 * `positions = { [id]: { sec, durationSec|null } }` — the listener's stored
 * positions, read by the caller from `position-store.js`. Oldest
 * `last_played_at` goes first, one at a time, until the sum fits. An episode
 * in progress (`isInProgress`) is NEVER in the plan, even when that leaves
 * the record over the cap: the cap is a courtesy to the device, the half-heard
 * episode is the listener's. An id absent from `positions` has no position
 * and is evictable. Pure; returns ids in removal order.
 */
export function evictionPlan(value, positions = {}) {
  const base = normaliseDownloads(value);
  const pos = positions && typeof positions === "object" ? positions : {};
  const cap = base.settings.capBytes;
  let used = usedBytes(base);
  if (used <= cap) return [];
  const candidates = Object.entries(base.items)
    .filter(([id, rec]) => rec.status === "done" && !isInProgress(pos[id], rec))
    .sort(([ia, a], [ib, b]) => {
      const ka = lruKey(a), kb = lruKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  const plan = [];
  for (const [id, rec] of candidates) {
    if (used <= cap) break;
    plan.push(id);
    used -= rec.bytes;
  }
  return plan;
}

/* ---------- what the player opens ---------- */

/**
 * A filesystem path as a `file://` URL, each segment percent-encoded; a path
 * that is already a `file://` URL is taken as given.
 *
 * WHY ENCODE (integration review, 2026-10-04). The store PQ-20 writes lives
 * under `Library/Application Support/foray-downloads/` — a path with a SPACE
 * in it on every iPhone. AVDeck builds its URL with `URL(string:)`, which on
 * iOS 15 and 16 (the app's floor is iOS 15: `Package.swift`
 * `.iOS(.v15)`) returns nil for a string with a raw space, so the load fails
 * as "no-url" and the downloaded copy never plays. iOS 17 encodes it
 * silently, which is exactly how a phone on 17 would hide this from a device
 * check. `#` and `?` would cut the path short on any version.
 * MUTATION TO BREAK THIS: return `"file://" + path` and `playSource
 * percent-encodes the iPhone path` fails.
 */
function fileUrl(path) {
  if (path.startsWith("file://")) return path;
  return "file://" + path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** THE ONE GATE for "this download has a file to open" (CH-27, P2-18): `done`
    with a non-empty `path`. It is `normaliseItem`'s rule read the other way —
    a done row without a path is read back as `missing` — so a row the record
    calls missing never opens a file, whichever reader asks. `playSource` (the
    engine) and `readSource` (the WebView's own fetch) both go through it. */
function hasFile(record) {
  return !!record && record.status === "done" && isStr(record.path);
}

/**
 * The URL the WEBVIEW can fetch a downloaded file at, or null — for a reader
 * that opens the bytes itself (the chapter reader, `id3-chapters.js`), not for
 * the engine (that is `playSource`).
 *
 * Same gate as `playSource` (`hasFile`). The URL is the bridge's
 * `fileSrc({path})` first — Capacitor's `convertFileSrc`, computed now, so a
 * record whose `webSrc` was stamped by an older shell or another origin is not
 * trusted over the live answer — then the stored `webSrc`.
 *
 * A `file:` URL IS REFUSED. On iOS the native engine takes `file://` (that is
 * `playSource`'s iPhone branch), but the page's `fetch` cannot: the WebView's
 * origin is `capacitor://localhost` / `https://localhost`, and a `file:` read
 * from it is blocked. Handing it over would only spend the reader's deadline
 * on a request that cannot succeed. Total: a bridge that throws is null.
 */
export function readSource(record, bridge) {
  if (!hasFile(record)) return null;
  try {
    const src = bridge?.fileSrc?.({ path: record.path }) ?? record.webSrc;
    return isStr(src) && !src.startsWith("file:") ? src : null;
  } catch (_) {
    return null;
  }
}

/**
 * The source to hand the engine for this item. A `done` record with a path
 * plays from the file: on iOS the native engine takes any absolute URL with a
 * scheme (AVDeck.swift), so it is the path as a `file://` URL (`fileUrl`, encoded); elsewhere the WebView
 * cannot read the files dir directly and plays the bridge's `webSrc` (the URL
 * the Android shell serves the file at). Anything else — no record, not
 * done, no path, a platform whose local URL the record cannot supply — is the
 * item's own remote `audio_url`, so a download that is not ready never breaks
 * a play that streaming would have served.
 */
export function playSource(item, record, { platform } = {}) {
  const remote = { audio_url: item ? item.audio_url : undefined, isLocalFile: false };
  if (!hasFile(record)) return remote;
  const local = platform === "ios" ? fileUrl(record.path) : record.webSrc;
  if (!isStr(local)) return remote;
  return { audio_url: local, isLocalFile: true };
}

/** The item as the queue should carry it when it plays locally: the local
    URL in `audio_url`, the remote one kept as `source_audio_url` (so a
    missing-file degrade can fall back without a lookup, and the event log
    still names the episode by its real address), and `isLocalFile` for the
    seek policy's precision rule (PQ-19). The same item, untouched, when the
    source is remote — a caller can `===` it. */
export function localPlayable(item, src) {
  if (!src || !src.isLocalFile) return item;
  return { ...item, audio_url: src.audio_url, source_audio_url: item.audio_url, isLocalFile: true };
}

/* ---------- the Library's one line ---------- */

const GB = 1024 ** 3;

/** "1.2 GB" — binary, one decimal; the cap drops a trailing ".0" ("2 GB"). */
function gb(bytes, { trim = false } = {}) {
  const s = (bytes / GB).toFixed(1);
  return (trim && s.endsWith(".0") ? s.slice(0, -2) : s) + " GB";
}

/** `"1.2 GB of 2 GB used · 7 episodes"`, or `"0 episodes downloaded"` when no
    download has finished. Counts `done` rows only, like the bytes. */
export function usageLine(value) {
  const base = normaliseDownloads(value);
  const done = Object.values(base.items).filter((r) => r.status === "done");
  if (done.length === 0) return "0 episodes downloaded";
  const used = done.reduce((s, r) => s + r.bytes, 0);
  const n = done.length;
  return `${gb(used)} of ${gb(base.settings.capBytes, { trim: true })} used · ${n} episode${n === 1 ? "" : "s"}`;
}
