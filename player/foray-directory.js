/* The Foray directory — how a phone sees a new Foray without a store build
   (deck "the Foray directory", cards FD-03 with FD-01/04/05 alongside).

   ── The problem ───────────────────────────────────────────────────────────
   The native shell bundles `data/forays.json`, `data/segments.json` and
   `data/segment-sources.json` inside its package (`tools/mobile/prepare-webdir.mjs`),
   and the Capacitor WebView loads them from `capacitor://localhost` — its own
   package. So until this file, a new Foray needed a release build. The web never
   had that problem: the PWA fetches `data/*.json` from the deployed site and
   `sw.js` serves them network-first, pinned to the deploy id they shipped with.

   ── The design, in one paragraph ──────────────────────────────────────────
   The directory IS the live site's three files, versioned by the deploy id they
   shipped with. A small pointer (`data/forays-directory.json`, written beside
   `deploy-manifest.json` by `tools/ci/generate-manifest.mjs` — FD-02) names the
   version, when it was built, the three file paths, their byte sizes and their
   sha256s. This module:

     1. at BOOT reads the durably cached set (IndexedDB, one row — see
        `DIRECTORY_DB_NAME`) and the BUNDLED pointer, and chooses what to paint:
        the cache if it validates, else the bundled seed. Bounded (`cacheWaitMs`):
        a hung IndexedDB costs the cache, never the first paint. The network is
        not consulted here at all.
     2. AFTER first paint, and again on return to the foreground (throttled by
        `minRefreshIntervalMs`), fetches the pointer from the live origin with a
        short timeout. If its version differs from the held one and is not older,
        it fetches the three files, checks each one's bytes and sha256 against the
        pointer — a TORN set, files from two deploys, is refused here, the same
        hazard `sw.js` guards on the web — runs the set through
        `validateForayDocuments` (the join the player already uses), and only then
        returns the set to the caller and writes it to the cache.

   Three rules, each one a named test in `player/foray-directory.test.js` and
   `test/foray-directory.test.js`:
     - never block first paint on the network (`boot()` never fetches remotely;
       `refresh()` is the caller's fire-and-forget)
     - never adopt a set that fails validation (`refresh()` returns `invalid` and
       `held()` is untouched)
     - never drop a held set for a network error (`offline` leaves `held()` and
       the cache exactly as they were)

   "Newer" is DIFFERENT, ordered by `built_at`: deploy ids are content hashes with
   no order of their own. A pointer whose `built_at` is behind the held set's is
   refused as `older` rather than adopted, so a stale edge cannot walk a phone
   backwards; a real rollback is a revert commit and carries a newer `built_at`.

   The bundled pointer is read for `version`/`built_at`/`partial` ONLY. The bundle
   carries slices of all three files (`prepare-webdir.mjs` §"the Foray segment
   slice" and `seedCarries`), so the pointer's byte sizes and sha256s describe the
   site's files and would not match the seed — the seed is trusted as the package
   it came in.

   THE SEED IS PARTIAL (F-92, 2026-09-12). The package leaves generated drafts —
   the founder's test track, the drafts switch (#631) — to the directory, so its pointer
   carries `partial: true` (`prepare-webdir.mjs` `seedPointerDoc`). A held set
   marked partial is never `current`, whatever version the live pointer names: a
   fresh install built from the same deploy as the live site would otherwise hold
   a subset at the live version and fetch nothing until the next deploy. The set
   the refresh adopts is whole, is cached whole, and IS `current` from then on.

   Nothing here is user data. The cache holds public JSON that the site serves to
   anyone, keyed by deploy id, in its own IndexedDB database rather than under a
   `cp_` key — so it is neither mirrored into localStorage's 5 MB nor enumerated
   by "Delete my data", which is about the listener, not the catalogue.

   Pure by construction: `fetch`, the cache tier, `crypto.subtle` and the clock are
   injected, which is what makes every failure path testable without a browser.
   `player/client.js` builds the real one and publishes it on
   `window.forayDirectory`; `app.js` (a classic script that cannot import this
   module) drives it from `init()`.
*/

import { validateForayDocuments } from "./foray-resolve.js";

/** Where the pointer lives, relative to any origin that serves the site. */
export const POINTER_PATH = "data/forays-directory.json";

/** The cache's own IndexedDB database. NOT the `foray` database `durable-store`
    hydrates from: a 300 KB row in that store would be deserialised by every
    hydration and filtered straight back out. Its own database, one row. */
export const DIRECTORY_DB_NAME = "foray-directory";
export const CACHE_KEY = "set";

/** The three files, in the pointer's own vocabulary. */
export const FILE_KEYS = Object.freeze(["forays", "segments", "sources"]);

/** Short, because it runs after paint and again on every foreground return. */
export const POINTER_TIMEOUT_MS = 4000;
/** The three files together are a few hundred KB (54 + 174 + 58 on 2026-09-10). */
export const FILES_TIMEOUT_MS = 15000;
/** How long `boot()` waits for the cache and the bundled pointer before painting
    from the seed. One IndexedDB read costs milliseconds; a hung one must not
    cost the page. */
export const CACHE_WAIT_MS = 2000;
/** Between refresh ATTEMPTS. A listener toggling apps does not re-fetch the
    pointer every time. */
export const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

export const SOURCE_BUNDLE = "bundle";
export const SOURCE_CACHE = "cache";
export const SOURCE_NETWORK = "network";

/** Every outcome `refresh()` can report. A closed vocabulary because the outcome
    is recorded in the field record (`diagnostic-log.js`), which admits no prose. */
export const STATUS = Object.freeze({
  ADOPTED: "adopted",       // the set was fetched, verified, validated, and is now held
  CURRENT: "current",       // the pointer names the version already held
  OLDER: "older",           // the pointer's built_at is behind the held set's
  OFFLINE: "offline",       // the pointer or a file did not arrive (network, timeout, HTTP)
  BAD_POINTER: "bad-pointer", // the pointer parsed but is not a pointer
  TORN: "torn",             // a file's bytes or sha256 disagree with the pointer
  INVALID: "invalid",       // the set does not validate (see foray-resolve.js)
  THROTTLED: "throttled",   // too soon after the last attempt
  BUSY: "busy",             // an attempt is already in flight
  NO_ORIGIN: "no-origin",   // the caller gave no origin to fetch from
});

/** A deploy id: `generate-manifest.mjs` writes a short hex hash, but the shape
    is left wide enough for a tagged one. Never prose, never a URL. */
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/* ---------- the pointer ---------- */

/**
 * Is this a pointer, and what does it say?
 *
 * Tolerant about `bytes` and `sha256` — either may be absent or keyed by only
 * some of the three files, and a missing check is simply not run — but strict
 * about `version` and `files`, without which there is nothing to fetch.
 *
 * @returns {{ ok: true, pointer: {version, built_at, files, bytes, sha256} } |
 *           { ok: false, code: string }}
 */
export function validatePointer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "not-an-object" };
  if (typeof raw.version !== "string" || !VERSION_RE.test(raw.version)) return { ok: false, code: "bad-version" };
  const files = raw.files;
  if (!files || typeof files !== "object") return { ok: false, code: "no-files" };
  const paths = {};
  for (const k of FILE_KEYS) {
    if (!nonEmpty(files[k])) return { ok: false, code: `no-file-${k}` };
    paths[k] = files[k];
  }
  return {
    ok: true,
    pointer: {
      version: raw.version,
      built_at: typeof raw.built_at === "string" && Number.isFinite(Date.parse(raw.built_at)) ? raw.built_at : null,
      files: paths,
      bytes: pickBytes(raw.bytes),
      sha256: pickHashes(raw.sha256),
      /* Strictly `true`: only the bundled pointer ever carries it, and a pointer
         from the origin saying anything else is not partial. */
      partial: raw.partial === true,
    },
  };
}

function pickBytes(obj) {
  const out = {};
  for (const k of FILE_KEYS) {
    const v = obj && typeof obj === "object" ? obj[k] : null;
    out[k] = Number.isInteger(v) && v >= 0 ? v : null;
  }
  return out;
}

/** `sha256:<hex>` (the `deploy-manifest.json` spelling) or bare hex, lower-cased. */
function pickHashes(obj) {
  const out = {};
  for (const k of FILE_KEYS) {
    const v = obj && typeof obj === "object" ? obj[k] : null;
    const hex = typeof v === "string" ? v.replace(/^sha256:/i, "").toLowerCase() : "";
    out[k] = /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  }
  return out;
}

/** Strictly behind, and only when BOTH sides carry a clock. An unknown `built_at`
    on either side is "not older": a seed with no bundled pointer, or a cache
    written by a version of this file that did not record one, must not block
    every update forever. */
export function isOlderThan(candidateBuiltAt, heldBuiltAt) {
  const c = Date.parse(candidateBuiltAt ?? "");
  const h = Date.parse(heldBuiltAt ?? "");
  return Number.isFinite(c) && Number.isFinite(h) && c < h;
}

/**
 * The absolute URL a pointer path resolves to on the directory's origin, or null
 * when it would leave that origin. The CSP would refuse a foreign fetch anyway;
 * refusing it here makes the pointer's contract explicit and testable.
 */
export function resolveFileUrl(origin, rel) {
  try {
    const base = new URL(String(origin));
    const u = new URL(String(rel), `${base.origin}/`);
    return u.origin === base.origin ? u.href : null;
  } catch (_) {
    return null;
  }
}

/** Lower-case hex sha256 of `bytes`, or null when there is no `subtle` to ask. */
export async function sha256Hex(bytes, subtle) {
  if (!subtle || typeof subtle.digest !== "function") return null;
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- the cache row ---------- */

/** What is written to the cache, and what is accepted back from it. A row that
    lacks any of the three documents or a version is not a set; it is treated as
    absent rather than repaired. */
export function parseCachedSet(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) { return null; }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.version !== "string" || !VERSION_RE.test(obj.version)) return null;
  for (const k of FILE_KEYS) if (!obj[k] || typeof obj[k] !== "object") return null;
  return {
    version: obj.version,
    built_at: typeof obj.built_at === "string" ? obj.built_at : null,
    fetched_at: typeof obj.fetched_at === "string" ? obj.fetched_at : null,
    forays: obj.forays,
    segments: obj.segments,
    sources: obj.sources,
  };
}

export function serializeSet(set) {
  return JSON.stringify({
    version: set.version,
    built_at: set.built_at ?? null,
    fetched_at: set.fetched_at ?? null,
    forays: set.forays,
    segments: set.segments,
    sources: set.sources,
  });
}

/* ---------- the client ---------- */

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetch]      `fetch`-shaped; defaults to the global, read at call time
 * @param {object|null} [opts.cache]   a `DurableTier` (`idb-tier.js`): `readAll(prefix)`,
 *                                     `write(key, value)`, `remove(key)`. null = no cache.
 * @param {SubtleCrypto|null} [opts.subtle]  defaults to `crypto.subtle` where it exists
 * @param {() => number} [opts.now]
 * @param {Function} [opts.validate]   `validateForayDocuments` unless a test says otherwise
 * @param {Function} [opts.onEvent]    every boot choice and refresh outcome, as flat fields
 *                                     suitable for `PlayerDiagnostics.dataSource()`
 */
export function createForayDirectory({
  fetch: fetchIn = null,
  cache = null,
  subtle = undefined,
  now = () => Date.now(),
  validate = validateForayDocuments,
  onEvent = null,
  pointerTimeoutMs = POINTER_TIMEOUT_MS,
  filesTimeoutMs = FILES_TIMEOUT_MS,
  cacheWaitMs = CACHE_WAIT_MS,
  minRefreshIntervalMs = MIN_REFRESH_INTERVAL_MS,
} = {}) {
  const fetchFn = fetchIn ?? ((...args) => globalThis.fetch(...args));
  const subtleOf = () => {
    if (subtle !== undefined) return subtle;
    try { return globalThis.crypto?.subtle ?? null; } catch (_) { return null; }
  };
  const emit = (fields) => {
    if (typeof onEvent !== "function") return;
    try { onEvent(fields); } catch (_) { /* the record must never become the outage */ }
  };

  let held = null;
  let started = null;
  let inflight = null;
  let lastAttemptAt = null;
  let last = null;

  /* ---- reading what is already here ---- */

  async function readCache() {
    if (!cache || typeof cache.readAll !== "function") return null;
    try {
      const rows = await cache.readAll("");
      return parseCachedSet(rows?.get?.(CACHE_KEY) ?? null);
    } catch (_) {
      emit({ phase: "boot", status: "cache-unreadable" });
      return null;
    }
  }

  async function readLocalPointer(url) {
    const got = await fetchBytes(url, cacheWaitMs);
    if (!got.ok) return null;
    const doc = parseJson(got.bytes);
    const v = doc ? validatePointer(doc) : { ok: false };
    return v.ok ? v.pointer : null;
  }

  function start({ localPointerUrl = POINTER_PATH } = {}) {
    if (!started) {
      started = Promise.all([
        bounded(readCache(), cacheWaitMs, null),
        bounded(readLocalPointer(localPointerUrl), cacheWaitMs, null),
      ]);
    }
    return started;
  }

  /**
   * Choose what to paint. Never the network.
   *
   * @param {{ forays, segments, sources }} seed  the bundled documents, any of which
   *                                              may be null (a 404 in the shell)
   * @returns {Promise<object>} the held set: the three documents plus `source`,
   *          `version`, `built_at`, `valid`, and `why` (which branch chose it)
   */
  async function boot({ seed = {} } = {}) {
    const [cached, seedPointer] = await start();
    const seedSet = {
      forays: seed?.forays ?? null,
      segments: seed?.segments ?? null,
      sources: seed?.sources ?? null,
      version: seedPointer?.version ?? null,
      built_at: seedPointer?.built_at ?? null,
      /* The package says whether what it carries at that version is the whole set
         (F-92). No pointer at all is not partial: an unversioned seed already
         re-fetches on every version, because it can never be `current`. */
      partial: seedPointer?.partial === true,
      source: SOURCE_BUNDLE,
    };
    const seedCheck = safeValidate(seedSet);
    seedSet.valid = seedCheck.ok;
    let chosen = seedSet;
    let why = seedCheck.ok ? "seed" : `seed-${seedCheck.code}`;

    if (cached) {
      const check = safeValidate(cached);
      if (!check.ok) {
        why = `cache-${check.code}`;
      } else if (seedSet.valid && isOlderThan(cached.built_at, seedSet.built_at)) {
        /* A store update outran the cache: the package carries a newer set than
           the last one fetched. The cache is left alone — the next refresh
           replaces it the moment the pointer moves. */
        why = "seed-newer-than-cache";
      } else {
        chosen = { ...cached, source: SOURCE_CACHE, valid: true };
        why = "cache";
      }
    }
    held = chosen;
    /* No `boot` event from here, deliberately: the boot row (FD-01) is written
       by app.js, which alone knows whether the seed came from a package, the
       origin, or a pinned worker generation — and which still writes it on a
       pinned page where this method is never called. One writer per row. */
    return { ...chosen, why, files: filesOf(chosen) };
  }

  /* ---- the refresh ---- */

  /**
   * Ask the live origin whether there is a newer set, and adopt it if it is whole.
   *
   * Never throws. Never touches `held()` or the cache except on `adopted`.
   *
   * @param {object} opts
   * @param {string} opts.origin  e.g. "https://foray-web-seven.vercel.app"
   * @param {string} [opts.reason] what triggered it — "boot", "foreground"
   * @returns {Promise<{status: string, version?: string, set?: object, code?: string}>}
   */
  async function refresh({ origin = null, reason = "manual" } = {}) {
    if (!nonEmpty(origin)) return outcome({ status: STATUS.NO_ORIGIN, reason });
    if (inflight) return { status: STATUS.BUSY, reason };
    const t = now();
    if (lastAttemptAt != null && t - lastAttemptAt < minRefreshIntervalMs) {
      return { status: STATUS.THROTTLED, reason };
    }
    lastAttemptAt = t;
    inflight = run(origin, reason).catch((err) => outcome({
      status: STATUS.OFFLINE, reason, code: "threw", version: null,
    }));
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  async function run(origin, reason) {
    const t0 = now();
    const pointerUrl = resolveFileUrl(origin, POINTER_PATH);
    if (!pointerUrl) return outcome({ status: STATUS.NO_ORIGIN, reason });

    const got = await fetchBytes(pointerUrl, pointerTimeoutMs);
    if (!got.ok) return outcome({ status: STATUS.OFFLINE, reason, code: got.code });
    const doc = parseJson(got.bytes);
    if (!doc) return outcome({ status: STATUS.BAD_POINTER, reason, code: "parse" });
    const v = validatePointer(doc);
    if (!v.ok) return outcome({ status: STATUS.BAD_POINTER, reason, code: v.code });
    const ptr = v.pointer;

    /* `current` only for a WHOLE held set (F-92): a partial seed at the live
       version still has the rest of the set to fetch, once. The older-than guard
       below is unchanged for it — a partial seed is still never walked backwards. */
    if (held && held.version && held.version === ptr.version && held.partial !== true) {
      return outcome({ status: STATUS.CURRENT, reason, version: ptr.version });
    }
    if (held && isOlderThan(ptr.built_at, held.built_at)) {
      return outcome({ status: STATUS.OLDER, reason, version: ptr.version });
    }

    /* The three files, in parallel. Any one not arriving is `offline` — the held
       set is untouched — and any one disagreeing with the pointer is `torn`. */
    const urls = {};
    for (const k of FILE_KEYS) {
      urls[k] = resolveFileUrl(origin, ptr.files[k]);
      if (!urls[k]) return outcome({ status: STATUS.BAD_POINTER, reason, code: `foreign-${k}`, version: ptr.version });
    }
    const fetched = await Promise.all(FILE_KEYS.map((k) => fetchBytes(urls[k], filesTimeoutMs)));
    const docs = {};
    let unverified = 0;
    for (let i = 0; i < FILE_KEYS.length; i++) {
      const k = FILE_KEYS[i];
      const f = fetched[i];
      if (!f.ok) return outcome({ status: STATUS.OFFLINE, reason, code: `${f.code}-${k}`, version: ptr.version });
      if (ptr.bytes[k] != null && f.bytes.byteLength !== ptr.bytes[k]) {
        return outcome({ status: STATUS.TORN, reason, code: `bytes-${k}`, version: ptr.version });
      }
      if (ptr.sha256[k]) {
        let hex = null;
        try { hex = await sha256Hex(f.bytes, subtleOf()); } catch (_) { hex = null; }
        if (hex && hex !== ptr.sha256[k]) {
          return outcome({ status: STATUS.TORN, reason, code: `sha256-${k}`, version: ptr.version });
        }
        if (!hex) unverified += 1;
      }
      docs[k] = parseJson(f.bytes);
      if (!docs[k]) return outcome({ status: STATUS.TORN, reason, code: `parse-${k}`, version: ptr.version });
    }

    const check = safeValidate(docs);
    if (!check.ok) {
      return outcome({
        status: STATUS.INVALID, reason, code: check.code, forayId: check.forayId ?? null, version: ptr.version,
      });
    }

    const set = {
      ...docs,
      version: ptr.version,
      built_at: ptr.built_at,
      fetched_at: new Date(now()).toISOString(),
      source: SOURCE_NETWORK,
      valid: true,
      partial: false,
    };
    held = set;
    let cacheWrite = cache ? "written" : "no-cache";
    if (cache && typeof cache.write === "function") {
      try { await cache.write(CACHE_KEY, serializeSet(set)); } catch (_) { cacheWrite = "write-failed"; }
    }
    return outcome({
      status: STATUS.ADOPTED, reason, version: set.version, set,
      forays: check.forays, playable: check.playable,
      code: unverified ? "sha256-unverified" : null, cacheWrite, ms: now() - t0,
    });
  }

  function outcome(o) {
    last = { ...o, set: undefined, at: now() };
    const { set, ...rest } = o;
    emit({
      phase: "refresh", trigger: rest.reason, status: rest.status, version: rest.version ?? null,
      code: rest.code ?? null, forayId: rest.forayId ?? null,
      forays: rest.forays ?? null, playable: rest.playable ?? null, ms: rest.ms ?? null,
      files: set ? filesOf(set) : null,
    });
    return o;
  }

  /* ---- plumbing ---- */

  async function fetchBytes(url, ms) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    /* The timer is NOT unref'd, and that is a finding rather than an oversight
       (PR #610's first CI run). An unref'd timer cannot keep Node's event loop
       alive, so when the only other pending work is the request that never
       answers — exactly the case this timeout exists for — the loop drains, the
       await is abandoned, and node:test cancels the test and every test after
       it ("Promise resolution is still pending but the event loop has already
       resolved"). Windows masked it with another live handle; Linux did not. A
       browser has no `unref` anyway, and the timer is cleared in `finally` the
       moment the race settles, so it can never outlive its own bound. */
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try { ctrl?.abort(); } catch (_) { /* aborting is best-effort */ }
        resolve({ ok: false, code: "timeout" });
      }, ms);
    });
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
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function safeValidate(docs) {
    try {
      const out = validate({ forays: docs?.forays, segments: docs?.segments, sources: docs?.sources });
      return out && typeof out === "object" ? out : { ok: false, code: "validator-answered-nothing" };
    } catch (_) {
      return { ok: false, code: "validator-threw" };
    }
  }

  return {
    start,
    boot,
    refresh,
    /** The set currently held, or null before `boot()`. */
    held: () => held,
    /** For the diagnostics surface: where the held set came from, and the last
        refresh outcome. */
    describe: () => ({
      source: held?.source ?? null,
      version: held?.version ?? null,
      built_at: held?.built_at ?? null,
      valid: held?.valid ?? null,
      partial: held?.partial ?? null,
      cache: cache ? "idb" : "none",
      last,
    }),
  };
}

/* ---------- helpers ---------- */

/** Race `promise` against `ms`, answering `fallback` on the clock. The timer is
    deliberately NOT unref'd — see `fetchBytes` for the CI failure that taught
    it — and is cleared as soon as either side settles. */
function bounded(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseJson(bytes) {
  try {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    const doc = JSON.parse(text);
    return doc && typeof doc === "object" ? doc : null;
  } catch (_) {
    return null;
  }
}

function countForays(set) {
  const list = set?.forays?.forays;
  return Array.isArray(list) ? list.length : 0;
}

/** Per file, as the field record wants it: `source@version`. The three always
    agree in this design (a set is atomic), and recording them one by one is
    what lets the record NAME the source of `forays.json` rather than imply it. */
function filesOf(set) {
  const tag = `${set?.source ?? "unknown"}@${set?.version ?? "unknown"}`;
  const out = {};
  for (const k of FILE_KEYS) out[k] = set && set[k] ? tag : "absent";
  return out;
}
