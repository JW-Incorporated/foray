/* The catalogue directory DRIVER — boot, refresh and the IndexedDB tier over
   the pure decisions in `player/catalogue-directory.js` (issue #40, narrowed
   2026-09-30; due before the first Spark nightly).

   Not on the boot path (CH-07): UNWIRED until the UI freeze ends (founder,
   2026-10-07). Nothing in the page imports this file, so the web neither
   modulepreloads, precaches nor deploys it and the native bundle does not
   carry it (`tools/mobile/prepare-webdir.mjs` `playerFiles`, bundle-budget
   item 10). Importing it from `player/client.js` is what puts it on all
   three; `test/boot-path.test.js` CH-07 lists it among the modules nothing
   imports, so that import is a deliberate, visible change. The wiring itself
   (app.js's `fetchJson()`, the single choke point #40 names) and the bundled
   seed pointer (`prepare-webdir.mjs`) are later cards.

   ── What it does ─────────────────────────────────────────────────────────
   It mirrors `createForayDirectory` (`player/foray-directory.js`), with the
   catalogue's own rules from `catalogue-directory.js`:

     1. boot(): reads the durably cached set and the last-answered check time
        (IndexedDB, its own database — CATALOGUE_DB_NAME) and the BUNDLED
        pointer, each within `cacheWaitMs`, and settles PRECEDENCE
        (`chooseCatalogue`: cached-fresh -> bundled -> error). It NEVER
        fetches: the bundled pointer is handed in by the caller, not read
        over `fetch`, so no network request can ever sit in front of paint.
     2. refresh(): the caller runs it after paint (and on a foreground
        return). TTL first (`refreshDue`): within six hours of the last check
        that ANSWERED it makes no request at all (#40: "a second launch within
        the window makes no network call"). Then the pointer from the live
        origin (`validateCataloguePointer`), ADOPTION (`decideAgainstPointer`:
        `older` is refused, `current` costs nothing more), the cellular gate,
        the five CATALOGUE_FILE_KEYS in parallel, VERIFICATION of each one's
        bytes and sha256 (`checkFetchedFile` — one that disagrees means the
        set is TORN across two deploys and the whole set is refused), and only
        then is the complete set adopted and written to the cache, as ONE row,
        so the cache can never hold half of one deploy and half of another.
     3. current(): `chooseCatalogue` over what is held now.

   Three rules, each a named test in `player/catalogue-directory-driver.test.js`:
     - boot never fetches;
     - nothing short of a complete, verified set is adopted (torn, sha256
       mismatch, a file that does not parse: refused, `current()` unchanged);
     - a network error never drops a held set, and is not recorded as an
       answered check (`isWithinTtl`'s header: it would silence six hours of
       launches on a phone that has just found signal).

   ── UNRULED: cellular ────────────────────────────────────────────────────
   Whether a catalogue refresh (the five files are ~3 MB, discover.json alone
   ~2.5 MB on 2026-10-09) may run on a metered connection has NO founder
   ruling. `cellularPolicy` is therefore an input, not a decision made here:
   a function the caller supplies, asked once per refresh just before the
   files are fetched, answering true (fetch now) or false (defer: nothing
   fetched, nothing recorded, so the next launch on Wi-Fi asks again). The
   default (null) applies no gate, which is only safe because nothing calls
   this yet; the wiring card must not ship without the ruling.

   ── Injected, so every path is a unit test ───────────────────────────────
   `fetch`, `now`, `origin`, `cache` (a `makeIdbTier` tier, idb-tier.js —
   `readAll(prefix)`, `write(key, value)`), `subtle` (for `sha256Hex`,
   foray-directory.js) and `timeouts` (each bound is deadline.js's `withinMs`,
   with an injectable scheduler). `isOlderThan`, `resolveFileUrl` and
   `sha256Hex` are the Foray directory's own, imported rather than copied:
   both pointers come from the same build and must never disagree.

   Nothing here is user data: the catalogue is public JSON, kept in its own
   IndexedDB database rather than under a `cp_` key, so it is neither mirrored
   into localStorage nor enumerated by "Delete my data". */

import {
  CATALOGUE_POINTER_PATH, CATALOGUE_FILE_KEYS, CATALOGUE_TTL_MS, DECISION, SOURCE,
  validateCataloguePointer, refreshDue, chooseCatalogue, decideAgainstPointer, checkFetchedFile,
} from "./catalogue-directory.js";
import { resolveFileUrl, sha256Hex, VERSION_RE } from "./foray-directory.js";
import { withinMs, REAL_SCHEDULER } from "./deadline.js";

/** The cache's own IndexedDB database (the caller passes it to `makeIdbTier`).
    Not `foray` (durable-store hydrates every row of that one) and not
    `foray-directory` (the Foray set's): three MB in either would be read by
    code that never wants it. */
export const CATALOGUE_DB_NAME = "foray-catalogue-directory";
/** The one row holding the whole adopted set. One row, so the write is atomic. */
export const SET_KEY = "set";
/** When the last pointer check ANSWERED (`current`, `older` or `adopted`). */
export const CHECKED_KEY = "checked";

/** Short: it runs after paint and again on a foreground return. */
export const POINTER_TIMEOUT_MS = 4000;
/** Five files, ~3 MB together on 2026-10-09; a slow cell still finishes. */
export const FILES_TIMEOUT_MS = 30000;
/** How long `boot()` waits for the cache and the bundled pointer. */
export const CACHE_WAIT_MS = 2000;

/** Every outcome `refresh()` can report. A closed vocabulary, like the Foray
    directory's STATUS, because the wiring records it in the field record. */
export const STATUS = Object.freeze({
  ADOPTED: "adopted",         // a complete, verified set is now held and cached
  CURRENT: "current",         // the pointer names the whole set already held
  OLDER: "older",             // the pointer's built_at is behind the held set's: refused
  WITHIN_TTL: "within-ttl",   // a check answered under CATALOGUE_TTL_MS ago: no request made
  OFFLINE: "offline",         // the pointer or a file did not arrive (network, timeout, HTTP)
  BAD_POINTER: "bad-pointer", // the pointer arrived but is not a catalogue pointer
  TORN: "torn",               // a file disagrees with the pointer, or does not parse
  DEFERRED: "deferred",       // the cellular policy said not now
  BUSY: "busy",               // a refresh is already in flight
  NO_ORIGIN: "no-origin",     // no origin to fetch from
});

/* ---------- the cache row ---------- */

/** What is written to the cache. The documents ride parsed, inside one JSON
    string (the idb tier stores strings), so the row is the set or nothing. */
export function serializeCatalogueSet(set) {
  return JSON.stringify({
    version: set.version,
    built_at: set.built_at ?? null,
    fetched_at: set.fetched_at ?? null,
    partial: set.partial === true,
    docs: set.docs,
  });
}

/** What is accepted back. A row missing a version or any of the five documents
    is not a set: it is treated as absent, never repaired. */
export function parseCatalogueSet(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) { return null; }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.version !== "string" || !VERSION_RE.test(obj.version)) return null;
  const docs = obj.docs;
  if (!docs || typeof docs !== "object") return null;
  for (const k of CATALOGUE_FILE_KEYS) if (!docs[k] || typeof docs[k] !== "object") return null;
  return {
    version: obj.version,
    built_at: typeof obj.built_at === "string" ? obj.built_at : null,
    fetched_at: typeof obj.fetched_at === "string" ? obj.fetched_at : null,
    partial: obj.partial === true,
    docs,
  };
}

/* ---------- the driver ---------- */

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetch]       `fetch`-shaped; defaults to the global, read at call time
 * @param {() => number} [opts.now]
 * @param {string|null} [opts.origin]   the live site, e.g. "https://foray-web-seven.vercel.app"
 * @param {object|null} [opts.cache]    a `makeIdbTier` tier over CATALOGUE_DB_NAME; null = no cache
 * @param {SubtleCrypto|null} [opts.subtle]  defaults to `crypto.subtle` where it exists
 * @param {{pointerMs?, filesMs?, cacheWaitMs?, scheduler?}} [opts.timeouts]
 * @param {((ctx: {pointer, bytes: number|null}) => boolean|Promise<boolean>)|null} [opts.cellularPolicy]
 *        UNRULED (see the header): may the five files be fetched now? null = no gate.
 * @param {number} [opts.ttlMs]
 * @param {Function} [opts.onEvent]    every refresh outcome, as flat fields
 */
export function createCatalogueDirectory({
  fetch: fetchIn = null,
  now = () => Date.now(),
  origin = null,
  cache = null,
  subtle = undefined,
  timeouts = {},
  cellularPolicy = null,
  ttlMs = CATALOGUE_TTL_MS,
  onEvent = null,
} = {}) {
  const fetchFn = fetchIn ?? ((...args) => globalThis.fetch(...args));
  const pointerMs = timeouts.pointerMs ?? POINTER_TIMEOUT_MS;
  const filesMs = timeouts.filesMs ?? FILES_TIMEOUT_MS;
  const cacheWaitMs = timeouts.cacheWaitMs ?? CACHE_WAIT_MS;
  const scheduler = timeouts.scheduler ?? REAL_SCHEDULER;
  const subtleOf = () => {
    if (subtle !== undefined) return subtle;
    try { return globalThis.crypto?.subtle ?? null; } catch (_) { return null; }
  };
  const emit = (fields) => {
    if (typeof onEvent !== "function") return;
    try { onEvent(fields); } catch (_) { /* the record must never become the outage */ }
  };
  const bounded = (promise, ms, fallback) =>
    withinMs(Promise.resolve(promise).catch(() => fallback), ms, { fallback, scheduler });

  /** The durably cached (or just adopted) set, with its documents. */
  let cached = null;
  /** The package's pointer, read for version/built_at/partial ONLY: its bytes
      and sha256s describe the site's files, not the bundle's slice. */
  let bundled = null;
  let checkedAt = null;
  let started = null;
  let inflight = null;

  async function readCache() {
    if (!cache || typeof cache.readAll !== "function") return { set: null, checked: null };
    const rows = await cache.readAll("");
    const checked = rows?.get?.(CHECKED_KEY) ?? null;
    return {
      set: parseCatalogueSet(rows?.get?.(SET_KEY) ?? null),
      checked: typeof checked === "string" && Number.isFinite(Date.parse(checked)) ? checked : null,
    };
  }

  async function readBundled(bundledPointer) {
    const raw = await bundledPointer;
    const v = raw ? validateCataloguePointer(raw) : { ok: false };
    return v.ok ? v.pointer : null;
  }

  /**
   * Choose what the first paint reads. Never the network.
   *
   * @param {object} [args]
   * @param {object|Promise<object>|null} [args.bundledPointer]  the package's
   *        `data/catalogue-directory.json`, already read by the caller (or a
   *        promise of it); null while no bundle carries one
   * @param {boolean} [args.bundledValid]  the caller's verdict that the five
   *        bundled documents are present and parse
   */
  async function boot({ bundledPointer = null, bundledValid = false } = {}) {
    if (!started) {
      started = Promise.all([
        bounded(readCache(), cacheWaitMs, { set: null, checked: null }),
        bounded(readBundled(bundledPointer), cacheWaitMs, null),
      ]).then(([fromCache, ptr]) => {
        cached = fromCache.set;
        checkedAt = fromCache.checked;
        bundled = { version: ptr?.version ?? null, built_at: ptr?.built_at ?? null, partial: ptr?.partial === true, valid: bundledValid === true };
      });
    }
    await started;
    return current();
  }

  /** `chooseCatalogue` over what is held now, plus the cached documents when
      the cache is the answer (the bundle's are the caller's own). */
  function current() {
    const choice = chooseCatalogue({
      cached: cached ? { version: cached.version, built_at: cached.built_at, valid: true } : null,
      bundled,
    });
    return { ...choice, docs: choice.source === SOURCE.CACHE ? cached.docs : null };
  }

  /** The set the live pointer is judged against: whichever one paints. */
  function heldMeta() {
    const choice = current();
    if (choice.source === SOURCE.CACHE) return { version: cached.version, built_at: cached.built_at, partial: cached.partial };
    if (choice.source === SOURCE.BUNDLE) return { version: bundled.version, built_at: bundled.built_at, partial: bundled.partial };
    return null;
  }

  async function recordChecked() {
    checkedAt = new Date(now()).toISOString();
    if (cache && typeof cache.write === "function") {
      try { await cache.write(CHECKED_KEY, checkedAt); } catch (_) { /* held in memory for this run */ }
    }
  }

  /**
   * Ask the live origin for a newer catalogue, and adopt it only if it is
   * complete and verified. Never throws; never touches `current()` or the
   * cache except on `adopted`.
   */
  async function refresh({ reason = "manual" } = {}) {
    if (inflight) return { status: STATUS.BUSY, reason };
    inflight = run(reason).catch(() => ({ status: STATUS.OFFLINE, reason, code: "threw" }));
    try {
      const o = await inflight;
      emit({ phase: "refresh", trigger: reason, status: o.status, version: o.version ?? null, code: o.code ?? null });
      return o;
    } finally {
      inflight = null;
    }
  }

  async function run(reason) {
    if (!started) await boot();
    else await started;
    if (!refreshDue({ checkedAt, now: now(), ttlMs })) return { status: STATUS.WITHIN_TTL, reason };
    const pointerUrl = typeof origin === "string" && origin ? resolveFileUrl(origin, CATALOGUE_POINTER_PATH) : null;
    if (!pointerUrl) return { status: STATUS.NO_ORIGIN, reason };

    const got = await fetchBytes(pointerUrl, pointerMs);
    if (!got.ok) return { status: STATUS.OFFLINE, reason, code: got.code };
    const v = validateCataloguePointer(parseJson(got.bytes));
    if (!v.ok) return { status: STATUS.BAD_POINTER, reason, code: v.code };
    const ptr = v.pointer;

    const decision = decideAgainstPointer({ held: heldMeta(), pointer: ptr });
    if (decision === DECISION.CURRENT) {
      await recordChecked();
      return { status: STATUS.CURRENT, reason, version: ptr.version };
    }
    if (decision === DECISION.OLDER) {
      await recordChecked();
      return { status: STATUS.OLDER, reason, version: ptr.version };
    }

    const urls = {};
    for (const k of CATALOGUE_FILE_KEYS) {
      urls[k] = resolveFileUrl(origin, ptr.files[k]);
      if (!urls[k]) return { status: STATUS.BAD_POINTER, reason, code: `foreign-${k}`, version: ptr.version };
    }
    if (typeof cellularPolicy === "function") {
      const sizes = CATALOGUE_FILE_KEYS.map((k) => ptr.bytes[k]);
      const total = sizes.every((b) => b != null) ? sizes.reduce((a, b) => a + b, 0) : null;
      let allowed = false;
      try { allowed = (await cellularPolicy({ pointer: ptr, bytes: total })) === true; } catch (_) { allowed = false; }
      if (!allowed) return { status: STATUS.DEFERRED, reason, version: ptr.version };
    }

    /* All five, in parallel. One not arriving is `offline` (held set
       untouched); one disagreeing with the pointer makes the set torn. */
    const fetched = await Promise.all(CATALOGUE_FILE_KEYS.map((k) => fetchBytes(urls[k], filesMs)));
    const docs = {};
    let unverified = 0;
    for (let i = 0; i < CATALOGUE_FILE_KEYS.length; i++) {
      const k = CATALOGUE_FILE_KEYS[i];
      const f = fetched[i];
      if (!f.ok) return { status: STATUS.OFFLINE, reason, code: `${f.code}-${k}`, version: ptr.version };
      let hex = null;
      if (ptr.sha256[k]) {
        try { hex = await sha256Hex(f.bytes, subtleOf()); } catch (_) { hex = null; }
      }
      const check = checkFetchedFile(ptr, k, { byteLength: f.bytes.byteLength, sha256: hex });
      if (!check.ok) return { status: STATUS.TORN, reason, code: check.code, version: ptr.version };
      if (!check.verified) unverified += 1;
      docs[k] = parseJson(f.bytes);
      if (!docs[k]) return { status: STATUS.TORN, reason, code: `parse-${k}`, version: ptr.version };
    }

    const set = {
      version: ptr.version,
      built_at: ptr.built_at,
      fetched_at: new Date(now()).toISOString(),
      partial: false,
      docs,
    };
    cached = set;
    let cacheWrite = cache ? "written" : "no-cache";
    if (cache && typeof cache.write === "function") {
      try { await cache.write(SET_KEY, serializeCatalogueSet(set)); } catch (_) { cacheWrite = "write-failed"; }
    }
    await recordChecked();
    return {
      status: STATUS.ADOPTED, reason, version: set.version,
      code: unverified ? "sha256-unverified" : null, cacheWrite,
    };
  }

  /** One GET within `ms` (deadline.js): on the clock the request is aborted
      and the answer is `{ ok: false, code: "timeout" }`; never rejects. The
      Foray directory's private fetchBytes has the same contract; sharing it
      means exporting it from foray-directory.js (a later card). */
  function fetchBytes(url, ms) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const request = (async () => {
      try {
        const res = await fetchFn(url, { cache: "no-cache", signal: ctrl ? ctrl.signal : undefined });
        if (!res || !res.ok) return { ok: false, code: `http-${res && Number.isInteger(res.status) ? res.status : 0}` };
        const bytes = await res.arrayBuffer();
        return { ok: true, bytes: bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer };
      } catch (_) {
        return { ok: false, code: "network" };
      }
    })();
    return withinMs(request, ms, { fallback: { ok: false, code: "timeout" }, onTimeout: () => ctrl?.abort(), scheduler });
  }

  return {
    boot,
    refresh,
    current,
    /** For the diagnostics surface. */
    describe: () => ({ ...current(), docs: undefined, checkedAt, cache: cache ? "idb" : "none" }),
  };
}

function parseJson(bytes) {
  try {
    const doc = JSON.parse(new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, ""));
    return doc && typeof doc === "object" ? doc : null;
  } catch (_) {
    return null;
  }
}
