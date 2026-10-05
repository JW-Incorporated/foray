/* The catalogue directory — the pure decisions behind "refresh the frozen
   catalogue without a store build" (issue #40, narrowed 2026-09-30).

   ── Why this exists ──────────────────────────────────────────────────────
   The first store release ships the catalogue (the discover slice, session,
   taxonomy, item tags, semantic index) frozen at build time: DECISIONS "v1 ships
   the catalogue frozen; Forays are already live" (HA #17) and
   docs/mobile-shell.md §"Ruled 2026-09-30". The fast-follow both name is a
   catalogue directory "on the same pointer mechanism the Forays use, with #40's
   TTL and cached-fresh then bundled precedence". The writer is
   `tools/ci/catalogue-directory.mjs` (stamped into every deploy build by
   `generate-manifest.mjs`, never committed — issue #701). This file is the
   reader's DECISIONS, and only those:

     - TTL: is a pointer check due, or did one answer recently enough that this
       launch makes no network call at all? (#40: "refresh at most once every few
       hours. The pipeline is nightly, so anything tighter is pure waste", and the
       acceptance line "a second launch within the window makes no network call".)
     - PRECEDENCE: of a durably cached catalogue and the bundled one, which does
       the first paint read? #40: "cached-fresh -> bundled -> error"; never the
       network, which is only ever consulted after paint.
     - ADOPTION: given a live pointer and the set held, is it current, older
       (refused — a stale edge never walks a phone backwards), or worth fetching?
     - VERIFICATION: does a fetched file match the pointer's byte count and
       sha256, or is the set torn across two deploys?

   ── What it deliberately is not ──────────────────────────────────────────
   No fetch, no cache tier, no clock of its own: every input is an argument, so
   every rule is a unit test. Nothing imports it yet. The wiring (app.js's
   `fetchJson()`, the single choke point #40 names, and the bundled seed pointer
   in `tools/mobile/prepare-webdir.mjs`) is a follow-up after #1039; it will
   drive these decisions the way `player/foray-directory.js` drives its own.

   "Older" is the Foray directory's `isOlderThan`, imported rather than copied:
   both pointers carry the same `built_at` from the same build
   (`tools/ci/forays-directory.mjs`, `buildTimestamp`), so the two readers must
   never disagree about which of two stamps is behind.

   Nothing here is user data. The catalogue is public JSON. It is not a `cp_`
   key and never will be; the auth token's storage (`cp_sb_session`, device-only
   in the native shell — `player/durable-store.js` DEVICE_ONLY_KEYS) is a
   different store and untouched by this module. */

import { isOlderThan, VERSION_RE } from "./foray-directory.js";

/** Where the pointer lives, relative to any origin that serves the site.
    Pinned equal to `tools/ci/catalogue-directory.mjs`'s by a test. */
export const CATALOGUE_POINTER_PATH = "data/catalogue-directory.json";

/** The five documents, in the pointer's own vocabulary (the writer's
    CATALOGUE_FILES keys, pinned equal by a test). */
export const CATALOGUE_FILE_KEYS = Object.freeze(["discover", "session", "taxonomy", "itemTags", "semanticIndex"]);

/** Six hours between pointer checks that ANSWERED. #40 asks for "at most once
    every few hours" against a nightly pipeline: at most four answered pointer
    checks a day, and a phone still sees a nightly batch the same day it lands. */
export const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;

/** Which catalogue the first paint reads. NONE is #40's "error": there is
    neither a usable cache nor a usable bundle. */
export const SOURCE = Object.freeze({
  CACHE: "cache",
  BUNDLE: "bundle",
  NONE: "none",
});

/** What a live pointer means for the set held. A closed vocabulary, like
    `player/foray-directory.js`'s STATUS, because the follow-up records it in
    the field record, which admits no prose. */
export const DECISION = Object.freeze({
  CURRENT: "current", // the pointer names the version already held, and it is whole
  OLDER: "older",     // the pointer's built_at is behind the held set's: refused
  FETCH: "fetch",     // fetch the five files, verify, then adopt
});

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const finiteTime = (t) => (typeof t === "number" ? t : Date.parse(t ?? ""));

/* ---------- the pointer ---------- */

/**
 * Is this a catalogue pointer, and what does it say? Strict about `version`
 * and all five `files` (without them there is nothing to fetch), tolerant about
 * `bytes` and `sha256` — a missing check is simply not run — exactly as the
 * Foray directory's `validatePointer` is.
 *
 * @returns {{ ok: true, pointer: {version, built_at, partial, files, bytes, sha256} } |
 *           { ok: false, code: string }}
 */
export function validateCataloguePointer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "not-an-object" };
  if (typeof raw.version !== "string" || !VERSION_RE.test(raw.version)) return { ok: false, code: "bad-version" };
  const files = raw.files;
  if (!files || typeof files !== "object") return { ok: false, code: "no-files" };
  const paths = {};
  const bytes = {};
  const sha256 = {};
  for (const k of CATALOGUE_FILE_KEYS) {
    if (!nonEmpty(files[k])) return { ok: false, code: `no-file-${k}` };
    paths[k] = files[k];
    const b = raw.bytes && typeof raw.bytes === "object" ? raw.bytes[k] : null;
    bytes[k] = Number.isInteger(b) && b >= 0 ? b : null;
    const h = raw.sha256 && typeof raw.sha256 === "object" ? raw.sha256[k] : null;
    const hex = typeof h === "string" ? h.replace(/^sha256:/i, "").toLowerCase() : "";
    sha256[k] = /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  }
  return {
    ok: true,
    pointer: {
      version: raw.version,
      built_at: typeof raw.built_at === "string" && Number.isFinite(Date.parse(raw.built_at)) ? raw.built_at : null,
      /* Strictly `true`: only a bundled seed pointer ever says so (the native
         bundle carries a SLICE of discover.json), never the origin's. */
      partial: raw.partial === true,
      files: paths,
      bytes,
      sha256,
    },
  };
}

/* ---------- TTL ---------- */

/**
 * Did a pointer check answer within the last `ttlMs`?
 *
 * `checkedAt` is the time (ms or ISO string) the last pointer check ANSWERED —
 * `current`, `older` or an adopted set alike. A check that never answered
 * (offline, timeout) must not be recorded as one: it would silence the next
 * three hours of launches on a phone that has just found signal.
 *
 * A `checkedAt` in the FUTURE is not "fresh": a device clock moved backwards
 * would otherwise silence every refresh until the clock caught up again. An
 * unknown or unparseable one is not fresh either. A non-finite or negative
 * `ttlMs` falls back to CATALOGUE_TTL_MS; zero means "always due".
 */
export function isWithinTtl(checkedAt, now, ttlMs = CATALOGUE_TTL_MS) {
  const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : CATALOGUE_TTL_MS;
  /* An unparseable side is NaN, and every comparison with NaN is false: so a
     never-checked or garbled stamp reads as "not within", i.e. due. */
  const age = finiteTime(now) - finiteTime(checkedAt);
  return age >= 0 && age < ttl;
}

/** Should this launch (or foreground return) fetch the pointer? The inverse of
    `isWithinTtl`, named for the caller's question. */
export function refreshDue({ checkedAt = null, now, ttlMs = CATALOGUE_TTL_MS } = {}) {
  return !isWithinTtl(checkedAt, now, ttlMs);
}

/* ---------- precedence ---------- */

/**
 * Which catalogue the first paint reads: cached-fresh, then bundled, then the
 * error (#40). The network is never an answer here.
 *
 * "Fresh" is relative to the bundle, NOT to the TTL. A cached catalogue past its
 * TTL is still the newest thing on the device: the TTL decides when to ASK the
 * origin, never whether to show what is held. What makes a cache lose is a store
 * update that outran it — the package carries a newer catalogue than the last
 * one fetched (`built_at` strictly behind the bundle's). The cache is left as it
 * is; the next refresh replaces it once the pointer moves.
 *
 * An unknown `built_at` on either side is "not older" (`isOlderThan`), so a
 * cache wins over a bundle that carries no pointer — the same convention the
 * Foray directory's boot uses.
 *
 * @param {object} args
 * @param {{version, built_at, valid}|null} args.cached   the durably cached set;
 *        `valid` is the caller's verdict that all five documents are present and parse
 * @param {{version, built_at, partial, valid}|null} args.bundled  the package's set
 * @returns {{ source: string, version: string|null, built_at: string|null, why: string }}
 */
export function chooseCatalogue({ cached = null, bundled = null } = {}) {
  const bundleOk = Boolean(bundled && bundled.valid === true);
  const cacheOk = Boolean(cached && cached.valid === true);
  if (cacheOk && !(bundleOk && isOlderThan(cached.built_at, bundled.built_at))) {
    return { source: SOURCE.CACHE, version: cached.version ?? null, built_at: cached.built_at ?? null, why: "cache" };
  }
  if (bundleOk) {
    const why = !cached ? "no-cache" : cacheOk ? "bundle-newer-than-cache" : "cache-invalid";
    return { source: SOURCE.BUNDLE, version: bundled.version ?? null, built_at: bundled.built_at ?? null, why };
  }
  return { source: SOURCE.NONE, version: null, built_at: null, why: cached ? "cache-invalid-no-bundle" : "no-catalogue" };
}

/* ---------- adoption ---------- */

/**
 * What a validated live pointer means for the set held.
 *
 * CURRENT only for a WHOLE held set at the same version: a partial seed (the
 * bundle's discover slice) at the live version still has the rest to fetch,
 * once — the Foray directory's F-92 rule. OLDER is permanent for that pair of
 * stamps, which is why the writer's `built_at` must move forward with `main`
 * (`tools/ci/forays-directory.mjs`, `buildTimestamp`).
 *
 * @param {{ held: {version, built_at, partial}|null, pointer: {version, built_at} }} args
 */
export function decideAgainstPointer({ held = null, pointer } = {}) {
  if (held && held.version && held.version === pointer?.version && held.partial !== true) return DECISION.CURRENT;
  if (held && isOlderThan(pointer?.built_at, held.built_at)) return DECISION.OLDER;
  return DECISION.FETCH;
}

/* ---------- verification ---------- */

/**
 * Does a fetched file agree with the pointer? `byteLength` is the response's
 * size; `sha256` the caller's lower-case hex digest of it, or null when there
 * was no `crypto.subtle` to ask. A pointer that carries no check for a field
 * skips that field; a digest the caller could not compute is `verified: false`
 * rather than a refusal, exactly as the Foray directory records
 * `sha256-unverified`.
 *
 * @returns {{ ok: true, verified: boolean } | { ok: false, code: string }}
 */
export function checkFetchedFile(pointer, key, { byteLength, sha256 = null } = {}) {
  if (!CATALOGUE_FILE_KEYS.includes(key)) return { ok: false, code: "unknown-key" };
  const wantBytes = pointer?.bytes?.[key] ?? null;
  if (wantBytes != null && byteLength !== wantBytes) return { ok: false, code: `bytes-${key}` };
  const wantHash = pointer?.sha256?.[key] ?? null;
  if (!wantHash) return { ok: true, verified: true };
  if (typeof sha256 !== "string" || !sha256) return { ok: true, verified: false };
  if (sha256.toLowerCase() !== wantHash) return { ok: false, code: `sha256-${key}` };
  return { ok: true, verified: true };
}
