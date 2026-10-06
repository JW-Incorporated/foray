/* player/catalogue-directory.js — the catalogue directory's pure decisions
   (issue #40, narrowed 2026-09-30): the pointer's shape, the TTL, the
   cached-fresh -> bundled -> error precedence, adoption against a live pointer,
   and per-file verification.

   No fetch, no cache tier, no clock: every input is an argument. The writer's
   half (and the writer/reader agreement on the path and the five keys) is
   tools/ci/catalogue-directory.test.mjs.

   Every test names the one-line mutation that turns it red, and each one was
   run. The fixtures are this suite's own; nothing here reads data/. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CATALOGUE_POINTER_PATH, CATALOGUE_FILE_KEYS, CATALOGUE_TTL_MS, SOURCE, DECISION,
  validateCataloguePointer, isWithinTtl, refreshDue, chooseCatalogue, decideAgainstPointer, checkFetchedFile,
} from "./catalogue-directory.js";

const HEX = (c) => c.repeat(64);
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-05T12:00:00.000Z");

function pointer(extra = {}) {
  return {
    version: "0123456789abcdef",
    built_at: "2026-10-05T03:00:00.000Z",
    files: {
      discover: "data/discover.json", session: "data/session.json", taxonomy: "data/taxonomy.json",
      itemTags: "data/item-tags.json", semanticIndex: "data/semantic-index.json",
    },
    bytes: { discover: 10, session: 20, taxonomy: 30, itemTags: 40, semanticIndex: 50 },
    sha256: { discover: HEX("a"), session: HEX("b"), taxonomy: HEX("c"), itemTags: HEX("d"), semanticIndex: HEX("e") },
    ...extra,
  };
}

/* ---------- the contract ---------- */

test("the pointer path, the five catalogue keys and a six-hour TTL are the module's contract", () => {
  /* The five are the documents DECISIONS "v1 ships the catalogue frozen" names.
     The TTL is #40's "at most once every few hours" against a nightly pipeline.
     KILLED BY: `CATALOGUE_TTL_MS = 60 * 60 * 1000` (an hour: four times the
     traffic for nothing), or dropping "semanticIndex" from the keys. */
  assert.equal(CATALOGUE_POINTER_PATH, "data/catalogue-directory.json");
  assert.deepEqual([...CATALOGUE_FILE_KEYS], ["discover", "session", "taxonomy", "itemTags", "semanticIndex"]);
  assert.ok(Object.isFrozen(CATALOGUE_FILE_KEYS));
  assert.equal(CATALOGUE_TTL_MS, 6 * HOUR);
});

/* ---------- the pointer ---------- */

test("a whole pointer validates, and sha256s are normalised from the manifest's `sha256:` spelling", () => {
  /* KILLED BY: dropping `.replace(/^sha256:/i, "")` in validateCataloguePointer
     (every prefixed hash then reads as absent, and no file is ever verified). */
  const v = validateCataloguePointer(pointer({ sha256: { ...pointer().sha256, discover: "sha256:" + HEX("A") } }));
  assert.equal(v.ok, true);
  assert.equal(v.pointer.version, "0123456789abcdef");
  assert.equal(v.pointer.built_at, "2026-10-05T03:00:00.000Z");
  assert.equal(v.pointer.partial, false);
  assert.equal(v.pointer.sha256.discover, HEX("a"));
  assert.equal(v.pointer.bytes.semanticIndex, 50);
  assert.deepEqual(Object.keys(v.pointer.files), [...CATALOGUE_FILE_KEYS]);
});

test("a pointer without a usable version or any one of the five files is refused, by name", () => {
  /* Without a version there is nothing to compare; without a file there is
     nothing to fetch. KILLED BY: deleting the `no-file-${k}` return (a pointer
     missing semanticIndex would validate and the fetch would ask for
     "undefined"), or the VERSION_RE test (a URL would pass as a version). */
  assert.deepEqual(validateCataloguePointer(null), { ok: false, code: "not-an-object" });
  assert.deepEqual(validateCataloguePointer([pointer()]), { ok: false, code: "not-an-object" });
  assert.deepEqual(validateCataloguePointer(pointer({ version: "https://evil.test/x" })), { ok: false, code: "bad-version" });
  assert.deepEqual(validateCataloguePointer(pointer({ files: null })), { ok: false, code: "no-files" });
  const noSemantic = pointer();
  delete noSemantic.files.semanticIndex;
  assert.deepEqual(validateCataloguePointer(noSemantic), { ok: false, code: "no-file-semanticIndex" });
  assert.deepEqual(validateCataloguePointer(pointer({ files: { ...pointer().files, session: "  " } })), { ok: false, code: "no-file-session" });
});

test("bytes and sha256 are optional per file, built_at must parse, and only a literal `true` is partial", () => {
  /* Tolerant where a missing check is merely a check not run. KILLED BY:
     `partial: Boolean(raw.partial)` (an origin pointer saying "yes" would
     make a whole set look partial and re-fetch forever), or dropping the
     Date.parse guard on built_at (garbage would then order sets). */
  const v = validateCataloguePointer(pointer({
    bytes: { discover: -1, session: 1.5 }, sha256: { discover: "not-hex" }, built_at: "yesterday-ish", partial: "yes",
  }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.pointer.bytes, { discover: null, session: null, taxonomy: null, itemTags: null, semanticIndex: null });
  assert.deepEqual(v.pointer.sha256, { discover: null, session: null, taxonomy: null, itemTags: null, semanticIndex: null });
  assert.equal(v.pointer.built_at, null);
  assert.equal(v.pointer.partial, false);
  assert.equal(validateCataloguePointer(pointer({ partial: true })).pointer.partial, true);
});

/* ---------- TTL ---------- */

test("TTL: a check that answered inside the window means no network call; at the window's edge it is due", () => {
  /* #40's acceptance line: "a second launch within the window makes no network
     call". KILLED BY: `age < ttl` -> `age <= ttl` (the boundary launch is
     skipped and the check slips a whole extra window on a phone that launches on
     a schedule). */
  assert.equal(isWithinTtl(T0, T0 + 1), true);
  assert.equal(isWithinTtl(T0, T0 + CATALOGUE_TTL_MS - 1), true);
  assert.equal(isWithinTtl(T0, T0 + CATALOGUE_TTL_MS), false);
  assert.equal(isWithinTtl(T0, T0 + 30 * HOUR), false);
  assert.equal(refreshDue({ checkedAt: T0, now: T0 + HOUR }), false);
  assert.equal(refreshDue({ checkedAt: T0, now: T0 + 7 * HOUR }), true);
});

test("TTL: a check recorded in the future (the device clock moved back) is due, not fresh until the clock catches up", () => {
  /* KILLED BY: dropping `age >= 0` from isWithinTtl — a phone whose clock was
     set back a day would make no catalogue check for a day. */
  assert.equal(isWithinTtl(T0 + HOUR, T0), false);
  assert.equal(refreshDue({ checkedAt: T0 + 24 * HOUR, now: T0 }), true);
});

test("TTL: never checked or an unreadable stamp is due; ISO strings work; a bad TTL falls back and zero means always", () => {
  /* KILLED BY: `const ttl = ttlMs;` in isWithinTtl (no fallback): an Infinity
     TTL would answer "within" forever, which is the frozen catalogue again, and
     a NaN one "not within" forever. Also by
     `const finiteTime = (t) => (typeof t === "number" ? t : Number(t));` —
     the ISO-string stamp would read as NaN, so a phone that checked an hour ago
     would check again on every launch. */
  assert.equal(refreshDue({ now: T0 }), true);
  assert.equal(refreshDue({ checkedAt: null, now: T0 }), true);
  assert.equal(refreshDue({ checkedAt: "not a date", now: T0 }), true);
  assert.equal(isWithinTtl("2026-10-05T11:00:00.000Z", "2026-10-05T12:00:00.000Z"), true);
  assert.equal(isWithinTtl(T0, T0 + 7 * HOUR, Infinity), false, "Infinity is not a TTL; the default applies");
  assert.equal(isWithinTtl(T0, T0 + HOUR, Number.NaN), true, "NaN falls back to the default six hours");
  assert.equal(isWithinTtl(T0, T0 + 1, -5), true, "a negative TTL falls back too");
  assert.equal(isWithinTtl(T0, T0, 0), false, "zero: always due");
});

/* ---------- precedence ---------- */

const bundle = (extra = {}) => ({ version: "b".repeat(16), built_at: "2026-10-01T00:00:00.000Z", partial: true, valid: true, ...extra });
const cache = (extra = {}) => ({ version: "c".repeat(16), built_at: "2026-10-04T00:00:00.000Z", valid: true, ...extra });

test("precedence: a valid cache newer than the bundle paints first — cached-fresh before bundled", () => {
  /* KILLED BY: swapping the two branches in chooseCatalogue (the bundle checked
     first, so it always wins when valid). */
  assert.deepEqual(chooseCatalogue({ cached: cache(), bundled: bundle() }), {
    source: SOURCE.CACHE, version: "c".repeat(16), built_at: "2026-10-04T00:00:00.000Z", why: "cache",
  });
});

test("precedence: a store update that outran the cache paints the bundle, and says so", () => {
  /* A new package carries a newer catalogue than the last one fetched. KILLED BY:
     dropping the `isOlderThan(cached.built_at, bundled.built_at)` clause — the
     phone would paint the older cached catalogue over the newer one it shipped
     with. */
  const r = chooseCatalogue({ cached: cache({ built_at: "2026-09-20T00:00:00.000Z" }), bundled: bundle() });
  assert.equal(r.source, SOURCE.BUNDLE);
  assert.equal(r.why, "bundle-newer-than-cache");
  assert.equal(r.version, "b".repeat(16));
});

test("precedence: the TTL never decides it — a cache long past its TTL, or tied with the bundle, still paints", () => {
  /* "Fresh" is relative to the bundle: the TTL says when to ASK the origin, not
     whether to show what is held, and chooseCatalogue takes no clock at all. A
     tie goes to the cache (it is whole; the bundle is a slice). KILLED BY:
     `isOlderThan(cached.built_at, bundled.built_at)` ->
     `!isOlderThan(bundled.built_at, cached.built_at)` (a tie then goes to the
     bundle). */
  const tie = chooseCatalogue({ cached: cache({ built_at: bundle().built_at }), bundled: bundle() });
  assert.equal(tie.source, SOURCE.CACHE);
  const ancient = chooseCatalogue({ cached: cache({ built_at: "2026-10-02T00:00:00.000Z" }), bundled: bundle() });
  assert.equal(ancient.source, SOURCE.CACHE);
});

test("precedence: an invalid or absent cache falls back to the bundle, with the reason", () => {
  /* KILLED BY: `const cacheOk = Boolean(cached)` (an unparseable cache row would
     paint an empty catalogue over a good bundle). */
  assert.deepEqual(
    { ...chooseCatalogue({ cached: cache({ valid: false }), bundled: bundle() }) },
    { source: SOURCE.BUNDLE, version: "b".repeat(16), built_at: "2026-10-01T00:00:00.000Z", why: "cache-invalid" }
  );
  assert.equal(chooseCatalogue({ cached: null, bundled: bundle() }).why, "no-cache");
  assert.equal(chooseCatalogue({ bundled: bundle() }).source, SOURCE.BUNDLE);
});

test("precedence: neither a usable cache nor a usable bundle is #40's error, and an invalid bundle never outranks a valid cache", () => {
  /* KILLED BY: `const bundleOk = Boolean(bundled)` — an unreadable bundle with
     a newer stamp would push a good cache aside and paint nothing. */
  assert.deepEqual(chooseCatalogue({}), { source: SOURCE.NONE, version: null, built_at: null, why: "no-catalogue" });
  assert.equal(chooseCatalogue({ cached: cache({ valid: false }), bundled: bundle({ valid: false }) }).why, "cache-invalid-no-bundle");
  const r = chooseCatalogue({
    cached: cache({ built_at: "2026-09-01T00:00:00.000Z" }),
    bundled: bundle({ valid: false, built_at: "2026-10-30T00:00:00.000Z" }),
  });
  assert.equal(r.source, SOURCE.CACHE);
});

test("precedence: an unknown built_at on either side is not older, so the cache paints (the Foray directory's convention)", () => {
  /* KILLED BY: replacing `isOlderThan` with a comparison that treats NaN as 0
     (`(Date.parse(a) || 0) < (Date.parse(b) || 0)`) — an undated cache would
     always lose to a dated bundle. */
  assert.equal(chooseCatalogue({ cached: cache({ built_at: null }), bundled: bundle() }).source, SOURCE.CACHE);
  assert.equal(chooseCatalogue({ cached: cache(), bundled: bundle({ built_at: null }) }).source, SOURCE.CACHE);
});

/* ---------- adoption ---------- */

test("adoption: same version and whole is current; same version but a partial seed is fetched once", () => {
  /* The bundle carries a SLICE of discover.json, so a fresh install built from
     the live deploy still has the rest to fetch. KILLED BY: dropping
     `held.partial !== true` from decideAgainstPointer (the install would hold
     the slice at the live version and never fetch until the next deploy). */
  const p = validateCataloguePointer(pointer()).pointer;
  assert.equal(decideAgainstPointer({ held: { version: p.version, built_at: p.built_at, partial: false }, pointer: p }), DECISION.CURRENT);
  assert.equal(decideAgainstPointer({ held: { version: p.version, built_at: p.built_at, partial: true }, pointer: p }), DECISION.FETCH);
});

test("adoption: a pointer older than the held set is refused; a newer or undated one, or nothing held, is fetched", () => {
  /* A stale edge must never walk a phone backwards. KILLED BY: deleting the
     OLDER branch (the stale pointer would be fetched and adopted). */
  const p = validateCataloguePointer(pointer()).pointer; // built 2026-10-05T03:00Z
  assert.equal(decideAgainstPointer({ held: { version: "f".repeat(16), built_at: "2026-10-06T00:00:00.000Z" }, pointer: p }), DECISION.OLDER);
  assert.equal(decideAgainstPointer({ held: { version: "f".repeat(16), built_at: "2026-10-04T00:00:00.000Z" }, pointer: p }), DECISION.FETCH);
  assert.equal(decideAgainstPointer({ held: { version: "f".repeat(16), built_at: null }, pointer: p }), DECISION.FETCH);
  assert.equal(decideAgainstPointer({ held: null, pointer: p }), DECISION.FETCH);
});

/* ---------- verification ---------- */

test("verification: a file that matches is verified; a wrong size or a wrong digest is torn, by file", () => {
  /* A torn set — files from two deploys — must be refused before adoption.
     KILLED BY: dropping the bytes comparison, or the digest comparison, in
     checkFetchedFile. */
  const p = validateCataloguePointer(pointer()).pointer;
  assert.deepEqual(checkFetchedFile(p, "discover", { byteLength: 10, sha256: HEX("a") }), { ok: true, verified: true });
  assert.deepEqual(checkFetchedFile(p, "discover", { byteLength: 11, sha256: HEX("a") }), { ok: false, code: "bytes-discover" });
  assert.deepEqual(checkFetchedFile(p, "itemTags", { byteLength: 40, sha256: HEX("9") }), { ok: false, code: "sha256-itemTags" });
  assert.deepEqual(checkFetchedFile(p, "itemTags", { byteLength: 40, sha256: HEX("D") }), { ok: true, verified: true }, "digest case does not matter");
});

test("verification: no digest to compare is unverified rather than torn; a check the pointer omits is skipped; unknown keys are refused", () => {
  /* No `crypto.subtle` (an insecure context) must not refuse every update.
     KILLED BY: `return { ok: false, code: ... }` in place of the
     `verified: false` return. */
  const p = validateCataloguePointer(pointer()).pointer;
  assert.deepEqual(checkFetchedFile(p, "session", { byteLength: 20, sha256: null }), { ok: true, verified: false });
  const loose = validateCataloguePointer(pointer({ bytes: {}, sha256: {} })).pointer;
  assert.deepEqual(checkFetchedFile(loose, "session", { byteLength: 999, sha256: null }), { ok: true, verified: true });
  assert.deepEqual(checkFetchedFile(p, "forays", { byteLength: 1 }), { ok: false, code: "unknown-key" });
});
