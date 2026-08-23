/* Tests for the breadth suspect measurement. Run: node --test tools/segments/

   What this scan decides: whether 2,821 timed transcripts — 71% of tranche 1's
   anchorable haul, sitting in seven shows — are supply or noise. Both answers
   are useful; a guess is not. So the arithmetic that turns byte counts into
   that verdict is worth pinning line by line. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  probeTargets,
  impliedDeltaSec,
  maxDeltaSec,
  insertedSamples,
  unmeasuredSamples,
  varyingSamples,
  maxDeliverySpread,
  dispositionOf,
  adrTier,
  recount,
  selectPool,
  hostTotals,
  measurementSplit,
  constantOffsetBytes,
  deriveRow,
  isSettled,
  plausibleDeliveries,
  fetchNoteOf,
  decodeIndex,
  decodeOverride,
  gridIndex,
  GRID_REPORT_RELS,
  gridOverride,
  combineOverrides,
  decodeUnderreports,
  probeCorroborated,
  CONSTANT_OFFSET_TOLERANCE_BYTES,
  INSERT_EVIDENCE_SEC,
  PADDABLE_CEILING_SEC,
  NO_DECLARED_LENGTH_REASON,
  INFERRED_STATIC_REASON,
} from "./measure-suspects.mjs";
import { AD_FREE_THRESHOLD, AD_FREE_FLOOR, summariseShow, undersizedSamples } from "../transcribe/ad-inflation.mjs";

const ep = (over = {}) => ({
  guid: "g",
  enclosure_url: "https://static.example.org/e.mp3",
  enclosure_bytes: 40_000_000,
  has_timestamps: true,
  duration_sec: 2400,
  ...over,
});

/* ---------------------------------------------------------------- targeting */

/* MUTATION: drop the `enclosure_bytes` check from `probeTargets`. Verified
   failing.

   A probe of an episode with no declared length spends a real request on a
   host to learn nothing: `inflationRatio` returns null for a null denominator,
   so the sample can only ever come back `unknown`. Politeness is the point —
   the cheapest polite request is the one you do not make. */
test("only episodes that could actually answer the question are probed", () => {
  const eps = [
    ep({ guid: "ok" }),
    ep({ guid: "no-length", enclosure_bytes: null }),
    ep({ guid: "zero-length", enclosure_bytes: 0 }),
    ep({ guid: "prose", has_timestamps: false }),
    ep({ guid: "no-url", enclosure_url: null }),
    ep({ guid: "ok2" }),
  ];
  assert.deepEqual(probeTargets(eps, 5).map((e) => e.guid), ["ok", "ok2"]);
});

/* MUTATION: raise or remove the `out.length >= perShow` break. Verified
   failing. Five probes per show was #316's budget and it is what keeps a
   seven-show scan at 35 requests rather than at the size of the feeds. */
test("perShow caps the requests, and it is a cap not a target", () => {
  const eps = Array.from({ length: 40 }, (_, i) => ep({ guid: `g${i}` }));
  assert.equal(probeTargets(eps, 5).length, 5);
  assert.equal(probeTargets(eps, 1).length, 1);
  assert.equal(probeTargets([], 5).length, 0);
  assert.equal(probeTargets(undefined, 5).length, 0);
});

/* -------------------------------------------------------- bytes to seconds */

/* MUTATION: in `impliedDeltaSec`, divide by `deliveredBytes` instead of
   `declaredBytes`. Verified failing.

   The bitrate has to come from the copy whose duration we know. The feed
   declares length AND duration for the same file, so `declared / duration` is
   that file's bitrate; `delivered / duration` is the bitrate of a longer file
   pretending to have the shorter one's runtime, which understates every gap. */
test("a byte gap becomes seconds at the episode's own implied bitrate", () => {
  // 40,000,000 bytes over 2400 s is ~133 kbps; 481,071 extra bytes is ~29 s.
  assert.equal(impliedDeltaSec(40_000_000, 40_481_071, 2400), 29);
  assert.equal(impliedDeltaSec(40_000_000, 40_000_000, 2400), 0);
  // Under-delivery is negative, not absolute: the sign is the whole signal.
  assert.equal(impliedDeltaSec(40_000_000, 39_950_000, 2400), -3);
});

/* MUTATION: make `impliedDeltaSec` return 0 rather than null for a missing or
   zero duration. Verified failing.

   Zero reads as "measured, and there is no gap" — a clean bill of health
   invented from an absent input. Null reads as "not measured", which is what
   it is, and `maxDeltaSec` filters it out rather than averaging it in. */
test("an unmeasurable delta is null, never a reassuring zero", () => {
  assert.equal(impliedDeltaSec(40_000_000, 40_481_071, null), null);
  assert.equal(impliedDeltaSec(40_000_000, 40_481_071, 0), null);
  assert.equal(impliedDeltaSec(null, 40_481_071, 2400), null);
  assert.equal(impliedDeltaSec(0, 40_481_071, 2400), null);
  assert.equal(impliedDeltaSec(40_000_000, null, 2400), null);
});

/* MUTATION: make `maxDeltaSec` return the median, or the last element, instead
   of the largest magnitude. Verified failing.

   ADR-0008: "a point estimate is the wrong statistic: it is too small about
   half the time." The verdict takes a median so one odd episode cannot
   reclassify a show; a displacement figure needs the opposite, because the
   episode that hurts a listener is the worst one, not the typical one. The two
   statistics are deliberately different and neither is derived from the other. */
test("the reported delta is the worst episode, not the typical one", () => {
  assert.equal(maxDeltaSec([{ delta_sec_implied: 0 }, { delta_sec_implied: 30 }, { delta_sec_implied: 0 }]), 30);
  assert.equal(maxDeltaSec([{ delta_sec_implied: -3 }, { delta_sec_implied: -1 }]), -3);
  assert.equal(maxDeltaSec([{ delta_sec_implied: null }, { delta_sec_implied: 90 }]), 90);
  assert.equal(maxDeltaSec([{ delta_sec_implied: null }]), null);
  assert.equal(maxDeltaSec([]), null);
});

/* ------------------------------------------------------------- the verdict */

/* MUTATION: in `dispositionOf`, delete the `inserted > 0` branch so the median
   verdict decides alone. Verified failing — and this is the mutant that ships
   the actual bug, so it is worth stating what it costs.

   All five Spreaker shows in this pool insert in discrete ~30 s slots on SOME
   episodes and not others. `summariseShow`'s median therefore measures how many
   of our five samples happened to draw a filled slot: Baseball Prospectus (339
   transcripts) and PWTorch VIP (60) each came back `ad-free` holding the same
   481,071-byte creative that got The WWE Podcast classified `injected`, and
   Sasquatch Experience (82) came back `ad-free` with three episodes holding a
   different creative of the same 30 s duration. Same platform, same mechanism,
   opposite verdicts, decided by sampling luck. Without this branch the scan
   admits 481 transcripts from shows it had already caught injecting. */
test("one episode caught mid-insert condemns the show, whatever the median says", () => {
  assert.equal(dispositionOf("ad-free", { inserted: 0 }), "recover");
  assert.equal(dispositionOf("ad-free", { inserted: 1 }), "drop");
  assert.equal(dispositionOf("injected", { inserted: 5 }), "drop");
  // `unknown` outranks everything: it is the refusal to answer, and a refusal
  // must never read as either a pass or a condemnation.
  assert.equal(dispositionOf("unknown", { inserted: 0 }), "unresolved");
  assert.equal(dispositionOf("unknown", { inserted: 3 }), "unresolved");
});

/* MUTATION: delete the `undersized > 0 || unmeasured > 0` branch from
   `dispositionOf`, or stop passing either argument at the call site. Verified
   failing on both halves.

   `undersized` was computed and recorded and then never consulted, which made
   the recorded number decoration. `ad-inflation.mjs`'s `AD_FREE_FLOOR`
   docstring is explicit that under-delivery "disqualifies a transcript for
   exactly the reason injection does".

   `unmeasured` is the hole a reviewer found in the seconds test: `impliedDeltaSec`
   returns null without an `itunes:duration`, so a seconds-only insert check
   returns 0 for a feed that omits the tag and the show reads as clean. Replayed
   with the real Baseball Prospectus byte counts and `duration_sec` nulled, 339
   transcripts from a show caught mid-insert flipped from `drop` to `recover`
   with nothing on the row showing the evidence had been dropped. Both land in
   `unresolved` rather than `drop`: neither is evidence of ads, and overstating
   what was seen is its own kind of wrong answer. */
test("what could not be checked is unresolved, never recovered", () => {
  assert.equal(dispositionOf("ad-free", { inserted: 0, undersized: 1 }), "unresolved");
  assert.equal(dispositionOf("ad-free", { inserted: 0, unmeasured: 1 }), "unresolved");
  // An insert seen outright still condemns outright — `drop` is the stronger
  // claim and the evidence for it is stronger too.
  assert.equal(dispositionOf("ad-free", { inserted: 1, undersized: 1 }), "drop");
});

/* MUTATION: remove the ratio fallback from `insertedSamples`, leaving only the
   seconds test. Verified failing.

   This is the H1 hole in its own right: without a duration the seconds test
   cannot see an insert at all, so the ratio has to answer when it can. What the
   ratio still cannot see is a sub-1% insert — 30 s on a 113-minute episode,
   which is exactly PWTorch VIP's real 1.004 sample — and that gap is why
   `unmeasuredSamples` exists rather than being papered over here. */
test("a feed with no duration cannot disarm the insert check", () => {
  const noDuration = [
    { ratio: 1.192, delta_sec_implied: null },
    { ratio: 1.0, delta_sec_implied: null },
  ];
  assert.equal(insertedSamples(noDuration), 1, "the ratio answers when seconds cannot");
  assert.equal(unmeasuredSamples(noDuration), 2, "and both samples are still flagged as unchecked in seconds");

  // The sub-1% insert the ratio cannot see: not counted as an insert, but the
  // show is not clean either -- it is unresolved.
  const subOnePercent = [{ ratio: 1.004, delta_sec_implied: null }];
  assert.equal(insertedSamples(subOnePercent), 0);
  assert.equal(unmeasuredSamples(subOnePercent), 1);
  assert.equal(
    dispositionOf("ad-free", { inserted: 0, unmeasured: unmeasuredSamples(subOnePercent) }),
    "unresolved",
  );

  // A measured-in-seconds sample is never counted as unmeasured.
  assert.equal(unmeasuredSamples([{ ratio: 1.0, delta_sec_implied: 0 }]), 0);
});

/* MUTATION: gate on `adrTier` anywhere in `dispositionOf` or `recount`, or
   change `PADDABLE_CEILING_SEC`. Verified failing.

   ADR-0008 reversed a >1% sourcing gate and its status line says so. The tier
   is REPORTED so that "not anchorable as published" is never read as "gone" —
   818 of these transcripts screen as paddable, and the ADR keeps even the
   locate-required ones ("author now, play once the locate step exists"). The
   moment anything branches on it, the reversed gate is back wearing a
   seconds-shaped hat. */
test("the ADR-0008 tier is reported and gates nothing", () => {
  assert.equal(PADDABLE_CEILING_SEC, 120, "ADR-0008's ceiling, and merge-segments' ANCHOR_TIME_TOLERANCE_SEC");
  assert.equal(adrTier(30), "paddable-screened");
  assert.equal(adrTier(120), "paddable-screened", "the ceiling is inclusive");
  assert.equal(adrTier(121), "locate-required");
  assert.equal(adrTier(522), "locate-required");
  assert.equal(adrTier(null), null);
  // The verdict is identical either side of the ceiling: the tier informs, the
  // insert evidence decides.
  assert.equal(dispositionOf("ad-free", { inserted: 1 }), dispositionOf("injected", { inserted: 5 }));
});

/* MUTATION: set `INSERT_EVIDENCE_SEC` to 0, or to 60. Verified failing in both
   directions.

   At 0 the container/tag noise this scan actually measured (-3 s to 0 s on
   every clean episode) becomes "evidence of an insert" and nothing is ever
   recoverable. At 60 the 30 s slot that IS the finding goes unseen. 10 s is an
   order of magnitude above the measured noise floor and a third of the smallest
   observed slot, which is why both edges below are asserted rather than just
   the one. */
test("the insert threshold separates the two populations we measured", () => {
  assert.ok(INSERT_EVIDENCE_SEC > 3, "must sit above the measured container noise");
  assert.ok(INSERT_EVIDENCE_SEC < 24, "must sit below the smallest observed ad slot");
  assert.equal(insertedSamples([{ delta_sec_implied: -3 }, { delta_sec_implied: 0 }]), 0);
  assert.equal(insertedSamples([{ delta_sec_implied: 30 }, { delta_sec_implied: 0 }]), 1);
  assert.equal(insertedSamples([{ delta_sec_implied: 90 }]), 1);
  assert.equal(insertedSamples([]), 0);
  /* THE BOUNDARY ITSELF, because the assertions above classify identically for
     any threshold in 4..23 and so cannot tell `>` from `>=`. A sample landing
     exactly on the line is an insert. */
  assert.equal(insertedSamples([{ delta_sec_implied: INSERT_EVIDENCE_SEC }]), 1);
  assert.equal(insertedSamples([{ delta_sec_implied: INSERT_EVIDENCE_SEC - 1 }]), 0);
});

/* MUTATION: in `dispositionOf`, treat a DAI redirect chain as condemning on its
   own. Verified failing.

   Tempting, and it would give the same answer for all seven shows here — but it
   contradicts `AD_FREE_SHOWS`, every member of which is a DAI-platform show
   admitted on exactly this evidence (#316: Being an Engineer is on Buzzsprout,
   which is on the host list, and earned its place with 41 of 41 episodes at
   ratio 1.0000). Being able to inject is not injecting. That distinction is the
   entire reason `ad_inflation` sits beside `dai` rather than replacing it, and
   a scan that erased it would quietly re-impose the sourcing gate ADR-0008
   reversed. */
test("a DAI platform alone does not condemn a show that never injects", () => {
  assert.equal(dispositionOf("ad-free", { inserted: 0 }), "recover");

  /* A SOURCE SCAN, because the obvious assertion here is hollow. The first
     version passed `{ inserted: 0, daiChain: true }` and asserted `recover` —
     but `dispositionOf` destructures only the keys it knows, so an unrecognised
     key is a no-op and that assertion holds whether or not the chain has a
     vote. It would catch exactly one mutant: the one that happens to read the
     option under that name. Same shape as the `daiReason` guard: assert the
     positive fact first, so a scanner that has stopped seeing the file says so
     instead of passing quietly. */
  const src = readFileSync(new URL("./measure-suspects.mjs", import.meta.url), "utf8");
  assert.match(src, /const screened = dispositionOf\(/, "the scanner has lost sight of the call site");
  const call = src.match(/dispositionOf\(summary\.verdict, \{([^}]*)\}\)/);
  assert.ok(call, "dispositionOf is not called the way this guard expects");
  for (const forbidden of ["dai", "chain", "via"]) {
    assert.ok(
      !call[1].includes(forbidden),
      `the chain reached dispositionOf via "${forbidden}" — it is corroboration, not a vote`,
    );
  }

  /* THE DECODE IS THE ONE THING ALLOWED TO OVERRULE IT, and it does so AFTER
     `dispositionOf` has spoken rather than by voting inside it. The distinction
     matters for the same reason the chain is kept out: `dispositionOf` is the
     byte screen's verdict and has to stay readable as exactly that. The
     override sits beside it, both values are committed when they differ, and
     `decodeOverride` is where the precedence is argued. */
  assert.match(src, /const disposition = override \? override\.disposition : screened;/,
    "the decode override must sit outside dispositionOf, not inside it");
  assert.ok(!call[1].includes("decode"), "the decode must not become a vote inside the byte screen");
});


/* ------------------------------------------------ the decode, which outranks

   These guard the one place in this file where a full download is allowed to
   overrule five ranged GETs. The rules are asymmetric on purpose and the
   asymmetry is the thing worth pinning: a decode that FOUND something is proof
   and settles the show on one observation, while a decode that found nothing is
   a sample of one and settles nothing on a host whose byte figures have already
   been caught being master lengths.

   MUTATION-TESTED, each verified to have changed the file on disk first. */

/** A decode row in the shape `decode-compare.mjs` commits. */
const decodeRow = (over = {}) => ({
  id: "t",
  show_id: "S1",
  episode: "An Episode",
  resolved_host: "cdn.example.com",
  downloaded_bytes: 1_000_000,
  probe_recorded_bytes: 1_000_000,
  transcript: { last_cue_sec: 1000 },
  comparison: {
    verdict: "matches-transcript",
    decoded_sec: 1002,
    last_cue_sec: 1000,
    feed_duration_sec: 1000,
    beyond_transcript_sec: 2,
    declared_bytes: 1_000_000,
    delivered_bytes: 1_000_000,
  },
  ...over,
});

/* MUTATION: `delivered - probed > toleranceBytes` -> `>= -toleranceBytes`.
   Verified failing:
     a host is only blind when it DELIVERED more than it declared
   Reverted. */
test("a host is only blind when it DELIVERED more than it declared", () => {
  // The flightcast finding, in its real numbers.
  assert.equal(
    decodeUnderreports(decodeRow({ probe_recorded_bytes: 67_510_022, comparison: { delivered_bytes: 68_884_898 } })),
    true,
  );
  // Delivering exactly what was declared is the honest case. Delivering LESS is
  // NOT this function's question — an under-delivery is a stale or wrong probe
  // figure, not an origin hiding bytes — but it is not "agreement" either, and
  // `probeCorroborated` below is what refuses to acquit on it. Splitting the
  // two was a reviewer's correction: one function answering both questions had
  // to be one-sided, and the side it took was the one that kept transcripts.
  assert.equal(decodeUnderreports(decodeRow({ probe_recorded_bytes: 30_112_183, comparison: { delivered_bytes: 30_112_183 } })), false);
  assert.equal(decodeUnderreports(decodeRow({ probe_recorded_bytes: 51_989_683, comparison: { delivered_bytes: 51_890_380 } })), false);

  // No fallback to the feed's declared length. A DAI show added to TARGETS with
  // no probe figure delivers more than its feed declares by definition, and the
  // old fallback would have marked its whole CDN blind on that alone.
  assert.equal(
    decodeUnderreports({ probe_recorded_bytes: null, comparison: { declared_bytes: 1000, delivered_bytes: 9_000_000 } }),
    false,
    "a feed declaration is not a Content-Range total",
  );

  // One frame of slack, the same band `constantOffsetBytes` uses.
  assert.equal(decodeUnderreports(decodeRow({ probe_recorded_bytes: 1000, comparison: { delivered_bytes: 1000 + CONSTANT_OFFSET_TOLERANCE_BYTES } })), false);
  assert.equal(decodeUnderreports(decodeRow({ probe_recorded_bytes: 1000, comparison: { delivered_bytes: 1001 + CONSTANT_OFFSET_TOLERANCE_BYTES } })), true);

  // Missing inputs say "no", never "yes": an absent number must not condemn a host.
  assert.equal(decodeUnderreports(decodeRow({ probe_recorded_bytes: null, comparison: { delivered_bytes: 9e9, declared_bytes: null } })), false);
  assert.equal(decodeUnderreports(null), false);
});

/* MUTATION: `if (id && !row.diagnostic)` -> `if (id)`. Verified failing:
     a diagnostic row is evidence about an instrument, not about a show
   Reverted. */
test("a diagnostic row is evidence about an instrument, not about a show", () => {
  const diag = decodeRow({
    show_id: "S1", resolved_host: "atelier.flightcast.com", diagnostic: true,
    probe_recorded_bytes: 67_510_022,
    comparison: { verdict: "excess-audio", decoded_sec: 9, last_cue_sec: 1, feed_duration_sec: 1, beyond_transcript_sec: 8, delivered_bytes: 68_884_898 },
  });
  const index = decodeIndex({ results: [diag] });

  // It must not be able to speak for the show...
  assert.equal(index.byShow.has("S1"), false);
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, index), null);

  // ...but what it observed about the HOST is exactly what it was fetched for.
  assert.deepEqual([...index.blindHosts], ["atelier.flightcast.com"]);
});

test("an incoming fetch note still wins over the override's", () => {
  // The docstring on `deriveRow` promises it: "the feed would not load"
  // explains a row better than any verdict drawn from the samples that failure
  // prevented. Both are kept, so nothing is lost either way.
  const base = { show_id: "S1", title: "t", enclosure_host: "h", samples: [] };
  const decodes = decodeIndex({
    results: [decodeRow({ show_id: "S1", resolved_host: "h", probe_recorded_bytes: 1, comparison: { verdict: "excess-audio", decoded_sec: 9, last_cue_sec: 1, feed_duration_sec: 1, beyond_transcript_sec: 8, delivered_bytes: 1 } })],
  });
  const row = deriveRow(base, { note: "feed unreadable: socket hang up", decodes });
  assert.match(row.note, /^feed unreadable: socket hang up/);
  assert.match(row.note, /also: DECODED/);
});

test("the condemning note reads correctly when the file is SHORT, not long", () => {
  const index = decodeIndex({
    results: [decodeRow({ show_id: "S1", resolved_host: "h", probe_recorded_bytes: 1, episode: "Ep",
      comparison: { verdict: "short-of-transcript", decoded_sec: 10, last_cue_sec: 500, feed_duration_sec: 500, beyond_transcript_sec: -490, delivered_bytes: 1 } })],
  });
  const out = decodeOverride({ show_id: "S1", enclosure_host: "h" }, index);
  assert.equal(out.disposition, "drop");
  assert.match(out.note, /490s SHORTER than the timeline/);
  assert.doesNotMatch(out.note, /-490s this show's own transcript does not describe/);
});

/* MUTATION: `Math.abs(delivered - probed) <= tol` -> `delivered - probed <= tol`.
   Verified failing:
     acquitting needs the probe and the wire to have measured the same object
   Reverted — that mutation is precisely the one-sided version a reviewer
   caught, which treated a 99,303-byte under-delivery as agreement. */
test("acquitting needs the probe and the wire to have measured the same object", () => {
  assert.equal(probeCorroborated(decodeRow({ probe_recorded_bytes: 100_000, comparison: { delivered_bytes: 100_000 } })), true);
  assert.equal(probeCorroborated(decodeRow({ probe_recorded_bytes: 51_989_683, comparison: { delivered_bytes: 51_890_380 } })), false, "99,303 bytes apart is a different object");
  assert.equal(probeCorroborated(decodeRow({ probe_recorded_bytes: 67_510_022, comparison: { delivered_bytes: 68_884_898 } })), false);
  assert.equal(probeCorroborated(decodeRow({ probe_recorded_bytes: null, comparison: { delivered_bytes: 1 } })), null, "unknown is not disagreement");
});

/* A DECODE OF A DIFFERENT OBJECT IS NOT EVIDENCE EITHER WAY, so the override
   stands aside entirely rather than downgrading a show whose own byte screen is
   fine. Returning `unresolved` here would let a stale probe figure demote a
   show the samples settled — punishing the row for a measurement we chose to
   take. */
test("a clean decode whose bytes the probe did not corroborate changes nothing", () => {
  const index = decodeIndex({
    results: [decodeRow({ show_id: "S1", resolved_host: "cdn.example.com", probe_recorded_bytes: 51_989_683, comparison: { verdict: "matches-transcript", decoded_sec: 8625.53, last_cue_sec: 8625.44, feed_duration_sec: 8625, beyond_transcript_sec: 0.09, delivered_bytes: 51_890_380 } })],
  });
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, index), null);
});

/* THE TWO INSTRUMENTS MUST NOT DISAGREE ABOUT HOW MANY SECONDS ARE TOO MANY.
   `TRAILING_ALLOWANCE_SEC` is 30s and this file's `INSERT_EVIDENCE_SEC` is 10s,
   so without the stricter clause a decode landing 11-30s past the transcript
   would acquit a show over a screen that condemns the identical delta — the
   override being the route by which the looser threshold wins.

   MUTATION: drop the `< INSERT_EVIDENCE_SEC` clause from `clean`.
   Verified failing:
     a decode cannot acquit at a delta the byte screen would condemn
   Reverted. */
test("a decode cannot acquit at a delta the byte screen would condemn", () => {
  const at = (sec) => decodeIndex({
    results: [decodeRow({ show_id: "S1", resolved_host: "cdn.example.com", probe_recorded_bytes: 100, comparison: { verdict: "matches-transcript", decoded_sec: 1000 + sec, last_cue_sec: 1000, feed_duration_sec: 1000, beyond_transcript_sec: sec, delivered_bytes: 100 } })],
  });
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, at(0.09)).disposition, "recover");
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, at(2.31)).disposition, "recover");
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, at(INSERT_EVIDENCE_SEC - 0.01)).disposition, "recover");
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, at(INSERT_EVIDENCE_SEC)), null, "at the screen's own condemning delta, the decode may not acquit");
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, at(25)), null);
});

test("decodeIndex groups by show and collects the hosts caught under-declaring", () => {
  const index = decodeIndex({
    results: [
      decodeRow({ show_id: "S1", resolved_host: "atelier.flightcast.com", probe_recorded_bytes: 67_510_022, comparison: { verdict: "excess-audio", delivered_bytes: 68_884_898 } }),
      decodeRow({ show_id: "S2", resolved_host: "atelier.flightcast.com" }),
      decodeRow({ show_id: "S2", resolved_host: "atelier.flightcast.com" }),
    ],
  });
  assert.equal(index.byShow.get("S1").length, 1);
  assert.equal(index.byShow.get("S2").length, 2);
  assert.deepEqual([...index.blindHosts], ["atelier.flightcast.com"]);
  assert.deepEqual([...decodeIndex(null).blindHosts], [], "no ledger is not a blind host");
  assert.equal(decodeIndex({ results: [] }).byShow.size, 0);
});

/* MUTATION: reorder `decodeOverride` so the `blindHosts` branch runs before the
   `bad` branch. Verified failing:
     a decode that found excess audio condemns whatever the bytes said
   Reverted. That order is the whole rule: a host being blind is a reason we
   cannot ACQUIT on its bytes, never a reason to withhold a condemnation we
   already have in hand. */
test("a decode that found excess audio condemns whatever the bytes said", () => {
  const index = decodeIndex({
    results: [decodeRow({
      show_id: "S1", resolved_host: "atelier.flightcast.com", probe_recorded_bytes: 67_510_022,
      episode: "Financial Crash Expert",
      comparison: { verdict: "excess-audio", decoded_sec: 5740.38, last_cue_sec: 5601.25, feed_duration_sec: 5626, beyond_transcript_sec: 139.13, delivered_bytes: 68_884_898 },
    })],
  });
  const out = decodeOverride({ show_id: "S1", enclosure_host: "atelier.flightcast.com" }, index);
  assert.equal(out.disposition, "drop");
  assert.match(out.note, /139\.13s this show's own transcript does not describe/);
  assert.match(out.note, /the ranged-GET screen above did not see it/);

  // `short-of-transcript` is the same disqualification from the other side.
  const short = decodeIndex({ results: [decodeRow({ comparison: { verdict: "short-of-transcript", decoded_sec: 10, last_cue_sec: 500, feed_duration_sec: 500, beyond_transcript_sec: -490, delivered_bytes: 1 } })] });
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "cdn.example.com" }, short).disposition, "drop");
});

/* THE EXPENSIVE RULE, and the one a future reader will want to relax. Do not:
   all five DOAC samples read within 0.5s of the feed's own duration while the
   delivered file carried 114s more, so "the bytes look clean" is precisely the
   output the failure produces.

   MUTATION: drop the `index.blindHosts.has(host)` branch entirely.
   Verified failing:
     one clean decode cannot acquit a show on a host caught under-declaring
   Reverted. */
test("one clean decode cannot acquit a show on a host caught under-declaring", () => {
  const blind = decodeRow({ show_id: "DIRTY", resolved_host: "atelier.flightcast.com", probe_recorded_bytes: 67_510_022, comparison: { verdict: "excess-audio", decoded_sec: 1, last_cue_sec: 1, feed_duration_sec: 1, beyond_transcript_sec: 0, delivered_bytes: 68_884_898 } });
  const clean = decodeRow({ show_id: "CLEAN", resolved_host: "atelier.flightcast.com" });
  const index = decodeIndex({ results: [blind, clean] });

  const out = decodeOverride({ show_id: "CLEAN", enclosure_host: "atelier.flightcast.com" }, index);
  assert.equal(out.disposition, "unresolved");
  assert.match(out.note, /more bytes than its Content-Range declares/);
  assert.match(out.note, /1 episode decoded clean, below the 2-sample floor/);

  /* Two decoded-clean episodes clear the same floor `summariseShow` applies to
     ratios, and then the DECODES issue the verdict themselves. Returning null
     here — letting the screen decide — was the earlier behaviour and it was
     wrong in the direction that costs: the screen's byte figures for this host
     are master lengths, which is the whole reason it is on the blind list, so
     handing back to it would let two real measurements merely unblock evidence
     this function had just finished voiding. */
  const two = decodeIndex({ results: [blind, clean, decodeRow({ show_id: "CLEAN", resolved_host: "atelier.flightcast.com" })] });
  const admitted = decodeOverride({ show_id: "CLEAN", enclosure_host: "atelier.flightcast.com" }, two);
  assert.equal(admitted.disposition, "recover");
  assert.match(admitted.note, /DECODED CLEAN 2x/);
  assert.match(admitted.note, /this host's byte figures are master lengths and took no part/);

  /* AND THE FLOOR IS A FLOOR. One clean decode plus one that found excess is
     not two clean ones. */
  const mixed = decodeIndex({ results: [blind, clean, decodeRow({ show_id: "CLEAN", resolved_host: "atelier.flightcast.com", comparison: { verdict: "excess-audio", decoded_sec: 9, last_cue_sec: 1, feed_duration_sec: 1, beyond_transcript_sec: 8, delivered_bytes: 1 } })] });
  assert.equal(decodeOverride({ show_id: "CLEAN", enclosure_host: "atelier.flightcast.com" }, mixed).disposition, "drop");

  // A show on the blind host that nobody decoded at all says so in as many words.
  const none = decodeOverride({ show_id: "UNSEEN", enclosure_host: "atelier.flightcast.com" }, index);
  assert.equal(none.disposition, "unresolved");
  assert.match(none.note, /no episode of this show has been decoded/);
});

/* MUTATION: return `{ disposition: "recover" }` before the blindHosts branch.
   Verified failing (it is the test above). This one pins the other direction:
   on a host nobody has caught lying, a clean decode is allowed to settle the
   thing the ratio could not — the Art Bell case, worth 1,368 transcripts. */
test("a clean decode acquits on a host whose bytes were corroborated", () => {
  const index = decodeIndex({
    results: [decodeRow({
      show_id: "ARTBELL", resolved_host: "dn720303.ca.archive.org",
      episode: "October 16, 2015: Open Lines",
      probe_recorded_bytes: 51_890_380,
      comparison: { verdict: "matches-transcript", decoded_sec: 8625.53, last_cue_sec: 8625.44, feed_duration_sec: 8625, beyond_transcript_sec: 0.09, delivered_bytes: 51_890_380 },
    })],
  });
  const out = decodeOverride({ show_id: "ARTBELL", enclosure_host: "dn720303.ca.archive.org" }, index);
  assert.equal(out.disposition, "recover");
  assert.match(out.note, /DECODED CLEAN: 8625\.53s/);
  assert.match(out.note, /0\.09s of trailing audio/);
});

test("no decode ledger changes nothing at all", () => {
  // The common case: nobody has spent a download on this pool. Every assertion
  // in this suite about the byte screen has to keep holding, so the override
  // must be a strict no-op rather than a default.
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "h" }, null), null);
  assert.equal(decodeOverride({ show_id: "S1", enclosure_host: "h" }, decodeIndex({ results: [] })), null);
  assert.equal(decodeOverride({ show_id: "UNKNOWN", enclosure_host: "h" }, decodeIndex({ results: [decodeRow()] })), null);

  const base = { show_id: "S1", title: "t", samples: [{ ratio: 1, delivered_bytes: 5_000_000, declared_bytes: 5_000_000, duration_sec: 100, delta_sec_implied: 0 }, { ratio: 1, delivered_bytes: 6_000_000, declared_bytes: 6_000_000, duration_sec: 100, delta_sec_implied: 0 }] };
  assert.equal(deriveRow(base).disposition, "recover");
  assert.equal(deriveRow(base, { decodes: null }).disposition, "recover");
  assert.equal(deriveRow(base).screened_disposition, undefined, "no override means no second opinion to record");
});

/* MUTATION: `const disposition = override ? override.disposition : screened;`
   -> `= screened;`. Verified failing:
     deriveRow lets the decode overrule the byte screen, and records both
   Reverted. */
test("deriveRow lets the decode overrule the byte screen, and records both", () => {
  const base = {
    show_id: "S1",
    title: "t",
    enclosure_host: "atelier.flightcast.com",
    samples: [{ ratio: 1, delivered_bytes: 5_000_000, declared_bytes: 5_000_000, duration_sec: 100, delta_sec_implied: 0 },
              { ratio: 1, delivered_bytes: 6_000_000, declared_bytes: 6_000_000, duration_sec: 100, delta_sec_implied: 0 }],
  };
  assert.equal(deriveRow(base).disposition, "recover", "the byte screen on its own admits this show");

  const decodes = decodeIndex({
    results: [decodeRow({
      show_id: "S1", resolved_host: "atelier.flightcast.com", probe_recorded_bytes: 5_000_000,
      comparison: { verdict: "excess-audio", decoded_sec: 500, last_cue_sec: 100, feed_duration_sec: 100, beyond_transcript_sec: 400, delivered_bytes: 9_000_000 },
    })],
  });
  const row = deriveRow(base, { decodes });
  assert.equal(row.disposition, "drop");
  assert.equal(row.screened_disposition, "recover", "the overruled verdict is kept, not erased");
  assert.equal(row.decided_by, "decode-and-compare");
  assert.match(row.note, /DECODED/);
  // The measurement itself is untouched — an override changes the judgement,
  // never the evidence.
  assert.equal(row.verdict, "ad-free");
  assert.equal(row.samples.length, 2);
});

/* ---------------------------------------------------------- the arithmetic */

/* MUTATION: in `recount`, add `still_unresolved` into `anchorable_after`.
   Verified failing.

   An unresolved show is an unknown, and reporting unknowns as wins is how a
   yield number becomes a promise the corpus cannot keep. `breadth-yield.mjs`
   already takes exactly this direction for `dai_suspected === null`; this is
   the same rule one layer up. */
test("only measured-clean transcripts are counted as recovered", () => {
  const r = recount(
    [
      { disposition: "recover", timed_transcripts: 339 },
      { disposition: "drop", timed_transcripts: 998 },
      { disposition: "unresolved", timed_transcripts: 14 },
    ],
    { gross: 3952, net: 1131 },
  );
  assert.equal(r.recovered, 339);
  assert.equal(r.not_anchorable_as_published, 998);
  assert.equal(r.still_unresolved, 14);
  assert.equal(r.anchorable_after, 1131 + 339);
  assert.equal(r.anchorable_before, 1131);
  assert.equal(r.anchorable_gross_before, 3952);
  /* NAMED `not_anchorable_as_published`, NOT `dropped`, and the rename is the
     finding rather than a tidy-up. ADR-0008 keeps both of its tiers in the
     corpus — locate-required shows are "author now, play once the locate step
     exists" — so a field called `dropped` invites a founder to read 2,807
     transcripts as gone when 1,823 of them screen as paddable. */
  assert.equal(r.dropped, undefined, "the word `dropped` overstates what ADR-0008 does with these");
});

/* MUTATION: in `recount`, key the sum off `dispositionOf(r.verdict)` instead of
   the recorded `r.disposition`. Verified failing.

   That is the shape this function had first, and it silently discards the
   insert evidence: `dispositionOf` called with no `inserted` argument defaults
   it to 0, so every `ad-free` median counts as recovered no matter how many of
   its episodes were caught mid-insert. The row already carries the disposition
   that was computed WITH the evidence; recomputing it from a subset is how the
   two disagree. */
test("the recount reads the disposition that was actually decided", () => {
  const rows = [{ verdict: "ad-free", disposition: "drop", timed_transcripts: 339 }];
  assert.equal(recount(rows, { gross: 3952, net: 1131 }).recovered, 0);
  assert.equal(recount(rows, { gross: 3952, net: 1131 }).not_anchorable_as_published, 339);
});

/* ------------------------------------------------------ imported, not copied

   MUTATION: give this module its own `const AD_FREE_THRESHOLD = 1.01`, or its
   own `summariseShow`. Verified failing.

   This repo has paid four separate times for a policy copied instead of
   imported — #211/#219/#249 (four matcher copies), #313 (two throttles), #316
   (three header copies), #318 (ten User-Agents) — and #317's agent did it again
   mid-branch with `AD_FREE_SHOWS`. A scan whose threshold quietly disagreed
   with the scan it claims to reproduce would be the most expensive version yet,
   because both numbers would look plausible. */
test("the thresholds and the summariser come from ad-inflation.mjs, not from here", () => {
  const src = readFileSync(new URL("./measure-suspects.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*summariseShow[^}]*\} from "\.\.\/transcribe\/ad-inflation\.mjs"/);
  for (const name of ["AD_FREE_THRESHOLD", "AD_FREE_FLOOR", "MIN_SAMPLES_FOR_AD_FREE", "RATIO_PRECISION"]) {
    assert.doesNotMatch(
      src,
      new RegExp(`(const|let|var)\\s+${name}\\s*=`),
      `${name} is declared here instead of imported from ad-inflation.mjs`,
    );
  }
  // ...and the values it defers to are the ones #316 measured against.
  assert.equal(AD_FREE_THRESHOLD, 1.01);
  assert.equal(AD_FREE_FLOOR, 0.99);
});

/* ------------------------------------------------- the committed evidence */

/* MUTATION: change any verdict, median or disposition in
   data/breadth-suspect-inflation.json by hand. Verified failing.

   The file is the evidence a founder decision rests on, and its verdicts must
   be REPRODUCIBLE from the byte counts beside them rather than merely asserted.
   This recomputes every one of them from the samples in the file, which is the
   difference between a measurement and a claim. */
test("every committed verdict is reproducible from its own samples", () => {
  const ev = JSON.parse(readFileSync(new URL("../../data/breadth-suspect-inflation.json", import.meta.url), "utf8"));
  assert.equal(ev.results.length, 7, "the seven suspects of tranche 1");

  for (const r of ev.results) {
    const recomputed = summariseShow(r.samples.map((s) => s.ratio));
    assert.equal(recomputed.verdict, r.verdict, `${r.title}: verdict`);
    assert.equal(recomputed.median, r.median, `${r.title}: median`);
    assert.equal(recomputed.n, r.n, `${r.title}: sample count`);
    assert.equal(insertedSamples(r.samples), r.inserted_samples, `${r.title}: inserted samples`);
    assert.equal(unmeasuredSamples(r.samples), r.unmeasured_samples ?? 0, `${r.title}: unmeasured samples`);
    assert.equal(
      dispositionOf(r.verdict, {
        inserted: r.inserted_samples,
        undersized: r.undersized_samples ?? 0,
        unmeasured: r.unmeasured_samples ?? 0,
      }),
      r.disposition,
      `${r.title}: disposition`,
    );
    assert.equal(maxDeltaSec(r.samples), r.max_delta_sec_implied, `${r.title}: worst delta`);
    assert.equal(adrTier(r.max_delta_sec_implied), r.tier, `${r.title}: ADR-0008 tier`);

    for (const s of r.samples) {
      if (s.ratio == null) {
        assert.ok(s.error, "a sample with no ratio must say why");
        continue;
      }
      assert.equal(Math.round((s.delivered_bytes / s.declared_bytes) * 1000) / 1000, s.ratio, `${r.title}: ratio arithmetic`);
      assert.equal(impliedDeltaSec(s.declared_bytes, s.delivered_bytes, s.duration_sec), s.delta_sec_implied);
    }
  }

  // The headline the PR quotes, recomputed rather than transcribed.
  const totals = recount(ev.results, { gross: 3952, net: 1131 });
  assert.equal(
    totals.recovered + totals.not_anchorable_as_published + totals.still_unresolved,
    2821,
    "every suspect transcript is accounted for in exactly one bucket",
  );
  assert.equal(totals.still_unresolved, 0, "all seven were settled; none needs a retry");
  /* And the tiers partition the same 2,821 the other way, so neither reading
     can quietly lose a show. */
  assert.equal(totals.adr0008.paddable_screened + totals.adr0008.locate_required, 2821);

  /* A result carrying the no-denominator note must ALSO look like one: no
     samples, and unresolved. Asserting the constant is merely long — which is
     what this line used to do — pins nothing. */
  for (const r of ev.results.filter((x) => x.note === NO_DECLARED_LENGTH_REASON)) {
    assert.equal(r.n, 0, `${r.title}: claims no denominator but reports samples`);
    assert.equal(r.disposition, "unresolved");
  }
});

/* ================================================== #321: the anchorable pool

   The suspects were the small end. After #320 every one of the 46 anchorable
   shows carries `dai_reason: "unknown"` — a negative filed as a pass — and
   10,933 timed transcripts rest on it. These pin the selection, the ordering,
   and the one instrument that can answer a feed publishing no length at all. */

const showRow = (over = {}) => ({
  show_id: "s1",
  title: "A Show",
  feed_url: "https://example.org/feed.xml",
  enclosure_host: "cdn.example.org",
  anchorable: true,
  episodes_with_timed_transcript: 10,
  ...over,
});

const reportWith = (shows, suspects = []) => ({ shows, suspect_anchorable: suspects });

/* MUTATION: make the `pool === "suspects"` branch fall through to the
   anchorable one. Verified failing.

   #319's behaviour has to survive byte for byte. `breadth-suspect-inflation.json`
   is the evidence five `measured-injecting` rows rest on, and a re-run that
   quietly measured a different pool would rewrite that file with rows for shows
   nobody asked about while dropping the ones that are cited. */
test("the suspects pool is the shortlist the yield report already computed", () => {
  const shortlist = [{ show_id: "x", title: "X", timed_transcripts: 5 }];
  const report = reportWith([showRow()], shortlist);
  assert.deepEqual(selectPool(report, { pool: "suspects" }), shortlist);
  // ...and it is the default, so an un-flagged invocation cannot silently
  // switch instruments on the file it is about to overwrite.
  assert.deepEqual(selectPool(report), shortlist);
});

/* MUTATION: drop `settled` from the skip set in `selectPool`, keeping only the
   shortlist ids. Verified failing.

   This is a real bug, caught by running the tool rather than by reading it.
   A suspect measured `recover` LEAVES the shortlist — that is what
   `suspectAnchorable` does with a recovery — so it comes back as an ordinary
   anchorable row with a measurement already committed against it. Apokalypse &
   Filterkaffee is exactly that show: #319 spent five probes on it, and a
   shortlist-only exclusion spends five more to re-learn the same answer, on a
   host that has already been asked. */
test("a show already measured is not probed again, even after it left the shortlist", () => {
  const report = reportWith([
    showRow({ show_id: "measured-clean", episodes_with_timed_transcript: 14 }),
    showRow({ show_id: "never-measured", episodes_with_timed_transcript: 99 }),
  ]);
  const pool = selectPool(report, { pool: "anchorable", settled: new Set(["measured-clean"]) });
  assert.deepEqual(pool.map((s) => s.show_id), ["never-measured"]);
});

/* MUTATION: order `selectPool` by `episodes_with_timed_transcript` alone,
   dropping the host-total key. Verified failing.

   Ordering by the show's own size interleaves platforms: on the real pool it
   puts a 1,368-transcript archive.org show ahead of three flightcast shows and
   answers five platform questions at 20% each. The corpus is CONCENTRATED —
   one host carries 47% of it — so a run that gets interrupted should have
   settled the biggest platform, not the biggest show. */
test("shows are ordered by how much of the corpus their platform carries", () => {
  /* THE HOSTNAMES SORT AGAINST THE ANSWER ON PURPOSE. An earlier fixture used
     `fleet.example` and `solo.example`, where alphabetical order happens to
     agree with host-total order — so the mutant that deletes the host-total key
     SURVIVED, falling through to the hostname tiebreak and producing the same
     list. A fixture that cannot distinguish the rule from its neighbour pins
     nothing. Here `a-solo` sorts first alphabetically and must still come last. */
  const report = reportWith([
    showRow({ show_id: "lonely-giant", enclosure_host: "a-solo.example", episodes_with_timed_transcript: 900 }),
    showRow({ show_id: "big-a", enclosure_host: "z-fleet.example", episodes_with_timed_transcript: 500 }),
    showRow({ show_id: "big-b", enclosure_host: "z-fleet.example", episodes_with_timed_transcript: 450 }),
  ]);
  assert.deepEqual(
    selectPool(report, { pool: "anchorable" }).map((s) => s.show_id),
    ["big-a", "big-b", "lonely-giant"],
    "950 across two shows on one host outranks 900 on another",
  );
});

/* MUTATION: drop the `String(a.show_id).localeCompare(...)` tiebreak. Verified
   failing (the two rows are identical on every earlier key). A `--limit` run
   whose order depends on input order probes a different set than the one it
   reported the last time it ran. */
test("the order is total, so a --limit run is reproducible", () => {
  const tied = [showRow({ show_id: "b" }), showRow({ show_id: "a" })];
  assert.deepEqual(selectPool(reportWith(tied), { pool: "anchorable", limit: 1 }).map((s) => s.show_id), ["a"]);
  assert.deepEqual(selectPool(reportWith([...tied].reverse()), { pool: "anchorable", limit: 1 }).map((s) => s.show_id), ["a"]);
});

/* MUTATION: let an unrecognised `--pool` fall through to the anchorable branch.
   Verified failing. A typo'd pool name that silently measured everything would
   spend hundreds of requests nobody asked for. */
test("an unknown pool name is refused rather than guessed at", () => {
  assert.throws(() => selectPool(reportWith([]), { pool: "anchorble" }), /--pool/);
});

/* MUTATION: change `reason` on the anchorable rows to "clean" or "suspect".
   Verified failing. The word is load-bearing: these rows were selected because
   NOTHING measured them, and a shortlist that reads "clean" is a claim nobody
   checked being laundered into a file. */
test("an anchorable row says why it was selected, and it is not a verdict", () => {
  const [row] = selectPool(reportWith([showRow()]), { pool: "anchorable" });
  assert.equal(row.reason, INFERRED_STATIC_REASON);
  assert.equal(row.reason, "inferred-static");
});

test("hostTotals sums timed transcripts per enclosure host", () => {
  const totals = hostTotals([
    showRow({ enclosure_host: "a", episodes_with_timed_transcript: 3 }),
    showRow({ enclosure_host: "a", episodes_with_timed_transcript: 4 }),
    showRow({ enclosure_host: "b", episodes_with_timed_transcript: 5 }),
  ]);
  assert.equal(totals.get("a"), 7);
  assert.equal(totals.get("b"), 5);
});

/* ------------------------------------------- probing a feed with no length */

/* MUTATION: flip `requireDeclaredLength`'s default to false. Verified failing.

   The denominator rule is right whenever the RATIO is the instrument: a probe
   of an episode with no declared length can only ever return `unknown`, so it
   spends a real request on a host to learn nothing. Defaulting the rule off
   would silently reintroduce exactly the wasted requests `probeTargets` was
   written to prevent, on every caller that never heard of repeats. */
test("the denominator rule holds by default and lifts only when asked", () => {
  const eps = [ep({ guid: "has-length" }), ep({ guid: "no-length", enclosure_bytes: null })];
  assert.deepEqual(probeTargets(eps, 5).map((e) => e.guid), ["has-length"]);
  assert.deepEqual(
    probeTargets(eps, 5, { requireDeclaredLength: false }).map((e) => e.guid),
    ["has-length", "no-length"],
  );
  // Lifting the denominator rule does not lift the others: a probe still needs
  // a URL, and a transcript is still the reason the show is in the pool.
  assert.deepEqual(
    probeTargets([ep({ guid: "prose", has_timestamps: false, enclosure_bytes: null })], 5, {
      requireDeclaredLength: false,
    }),
    [],
  );
});

/* MUTATION: count a single delivery as varying (drop the `seen.length >= 2`
   guard). Verified failing.

   A one-probe run records no `deliveries` at all and a resumed #319 row has
   none either; treating "fewer than two observations" as disagreement would
   condemn every show measured before repeats existed. */
test("variance needs two observations of the same episode, not one", () => {
  assert.equal(varyingSamples([{ deliveries: [40_000_000] }]), 0);
  assert.equal(varyingSamples([{ ratio: 1.0 }]), 0);
  assert.equal(varyingSamples([{ deliveries: [40_000_000, 40_000_000, 40_000_000] }]), 0);
});

/* MUTATION: compare `deliveries[0]` against `deliveries[1]` only, instead of
   `new Set(seen).size > 1`. Verified failing — three probes where the first two
   agree and the third does not is precisely the stitcher that varies
   sometimes, which is the population #319 proved the median cannot see. */
test("one episode delivering two different lengths is the show caught stitching", () => {
  assert.equal(varyingSamples([{ deliveries: [40_000_000, 40_000_000, 49_400_000] }]), 1);
  assert.equal(
    varyingSamples([{ deliveries: [1_000_000, 1_000_000] }, { deliveries: [2_000_000, 2_400_000] }]),
    1,
  );
});

/* MUTATION: drop the `n > 0` filter from the delivered lengths. Verified
   failing. A failed probe records `delivered_bytes: null`, and counting null
   beside a real length would read every partial failure as a stitch — the
   scan's own errors manufacturing its most serious verdict. */
test("a failed probe is not evidence of stitching", () => {
  assert.equal(varyingSamples([{ deliveries: [40_000_000, null] }]), 0);
  assert.equal(varyingSamples([{ deliveries: [null, null] }]), 0);
});

test("maxDeliverySpread reports the widest disagreement, and null when there is none", () => {
  assert.equal(maxDeliverySpread([{ deliveries: [40_000_000, 49_400_000] }]), 9_400_000);
  assert.equal(maxDeliverySpread([{ deliveries: [40_000_000, 40_000_000] }]), null);
  assert.equal(maxDeliverySpread([{ ratio: 1 }]), null);
});

/* MUTATION: move the `varying` check in `dispositionOf` below the
   `verdict === "unknown"` line. Verified failing.

   This is the entire reason repeats exist. A feed that declares no enclosure
   length produces `ratio: null` on every sample, so `summariseShow` returns
   `unknown` — and `unknown` is the FIRST branch. Ordered that way, a host
   caught red-handed serving three different files for one GUID is filed as
   "could not tell". Positive evidence of the mechanism outranks the absence of
   a denominator, and on this pool it is 5,461 transcripts. */
test("a show caught serving different bytes per request is dropped, not shrugged at", () => {
  assert.equal(dispositionOf("unknown", { varying: 1 }), "drop");
  assert.equal(dispositionOf("ad-free", { varying: 1 }), "drop");
  // ...and with nothing varying, `unknown` still refuses to admit the show.
  assert.equal(dispositionOf("unknown", { varying: 0 }), "unresolved");
});

/* MUTATION: make stability acquit — return "recover" when repeats agree and
   nothing else objects. Verified failing.

   Content-Range's total is the length of the resource served, so two totals
   mean two resources and that is proof. The converse is not: a stitcher may key
   on session, IP or time and hand one client the same stitch inside a cache
   window. `ad-inflation.mjs` already refuses to call a thin sample clean for
   the same reason, and a no-length feed is the thinnest evidence there is. */
test("byte-stable across repeats is not a clean bill of health", () => {
  assert.equal(dispositionOf("unknown", { varying: 0, unmeasured: 0 }), "unresolved");
});

/* ---------------------------------------------------------- the deliverable */

/* MUTATION: count `unresolved` transcripts inside `measured_clean`. Verified
   failing. "10,933, all inferred" and "6,000, all measured" are very different
   assets; a split that folds "we probed it and could not tell" into "measured"
   reports the first as the second. */
test("the split counts only what a measurement actually settled", () => {
  const split = measurementSplit([
    { disposition: "recover", timed_transcripts: 995 },
    { disposition: "drop", timed_transcripts: 1368 },
    { disposition: "unresolved", timed_transcripts: 5461 },
    { disposition: "unresolved", timed_transcripts: 42 },
  ]);
  assert.deepEqual(split.measured_clean, { shows: 1, timed_transcripts: 995 });
  assert.deepEqual(split.measured_injecting, { shows: 1, timed_transcripts: 1368 });
  assert.deepEqual(split.unresolved, { shows: 2, timed_transcripts: 5503 });
  /* MUTATION: let repeat_stable_no_denominator count rows that were never
     repeat-probed, or rows that DID vary. Verified failing. It is a named
     slice of unresolved, and on this corpus it is 5,503 of the 5,507 — the
     difference between "nobody could measure flightcast" and "flightcast was
     probed 105 times and never once varied". */
  assert.deepEqual(split.repeat_stable_no_denominator, { shows: 0, timed_transcripts: 0 });
  /* Samples, not stamped fields: the slice reads the observations back so a
     row cannot claim a repeat count it did not earn. */
  const rep = (n, ...sizes) => ({ ratio: null, delivered_bytes: sizes[0], deliveries: sizes.length ? sizes : Array(n).fill(50_000_000) });
  const stable = measurementSplit([
    { disposition: "unresolved", timed_transcripts: 1264, samples: [rep(3), rep(3)] },
    { disposition: "unresolved", timed_transcripts: 99, samples: [rep(0, 50_000_000, 59_400_000)] },
    { disposition: "unresolved", timed_transcripts: 7, samples: [{ ratio: 1.0 }] },
  ]);
  assert.deepEqual(stable.repeat_stable_no_denominator, { shows: 1, timed_transcripts: 1264 });
  assert.equal(stable.unresolved.timed_transcripts, 1370, "it is a slice of unresolved, never an extra bucket");
});

/* -------------------------------------- the committed anchorable evidence */

/* MUTATION: change any verdict, median, disposition or delivered byte count in
   data/breadth-anchorable-inflation.json by hand. Verified failing.

   Same rule as the suspects file one screen up, and it matters more here: this
   file is what turns 10,933 inferred transcripts into a number split by
   evidence, and a founder deciding what to cut segments from reads its
   dispositions. Every one is recomputed from the bytes beside it. */
test("every committed anchorable verdict is reproducible from its own samples", () => {
  const ev = JSON.parse(readFileSync(new URL("../../data/breadth-anchorable-inflation.json", import.meta.url), "utf8"));
  assert.equal(ev.pool, "anchorable", "this file answers the anchorable pool's question");
  assert.ok(ev.results.length > 0);

  for (const r of ev.results) {
    const recomputed = summariseShow(r.samples.map((s) => s.ratio));
    assert.equal(recomputed.verdict, r.verdict, `${r.title}: verdict`);
    assert.equal(recomputed.median, r.median, `${r.title}: median`);
    assert.equal(recomputed.n, r.n, `${r.title}: sample count`);
    assert.equal(insertedSamples(r.samples), r.inserted_samples, `${r.title}: inserted samples`);
    assert.equal(varyingSamples(r.samples), r.varying_samples ?? 0, `${r.title}: varying samples`);
    assert.equal(maxDeliverySpread(r.samples), r.max_delivery_spread_bytes ?? null, `${r.title}: spread`);
    /* THE THREE DERIVED COUNTS A REVIEWER FOUND UNCHECKED. Each was written to
       the row and never recomputed, so each was a claim rather than a
       measurement — and `unmeasured_samples` was a straight regression against
       the suspects-file test one screen up, which does check it. Verified by
       mutation: editing any of them by hand left the suite green. */
    assert.equal(unmeasuredSamples(r.samples), r.unmeasured_samples ?? 0, `${r.title}: unmeasured samples`);
    assert.equal(undersizedSamples(r.samples), r.undersized_samples ?? 0, `${r.title}: undersized samples`);
    assert.equal(constantOffsetBytes(r.samples), r.constant_offset_bytes ?? null, `${r.title}: constant offset`);
    /* THE SCREEN'S VERDICT IS STILL REPRODUCIBLE FROM THE SAMPLES — but on a
       row the decode overruled it is `screened_disposition` that reproduces,
       not `disposition`. That is the whole point of committing both: the byte
       evidence still has to add up on its own terms, and the row has to say so
       in a field this test can check, or "a download said otherwise" becomes an
       unfalsifiable escape hatch for any row whose numbers do not work. */
    const screened = dispositionOf(r.verdict, {
      inserted: r.inserted_samples,
      undersized: r.undersized_samples ?? 0,
      unmeasured: r.unmeasured_samples ?? 0,
      varying: r.varying_samples ?? 0,
    });
    assert.equal(screened, r.screened_disposition ?? r.disposition, `${r.title}: disposition`);
    if (r.screened_disposition) {
      /* TWO INSTRUMENTS MAY NOW OVERRULE THE SCREEN, and the row must name
         which — and then carry THAT instrument's numbers. The pairing is a
         lookup rather than an `if/else` on purpose: a third instrument, or a
         renamed `decided_by`, lands as an undefined here and fails, instead of
         slipping through an `else` branch that asserts nothing. That is the
         same failure this test was written to close, one instrument later. */
      const evidenceOf = {
        "decode-and-compare": /DECODED/,
        "decode-and-compare (probe grid corroborating)": /DECODED/,
        "probe-grid": /PROBE GRID/,
        "probe-grid (over decode-and-compare)": /PROBE GRID/,
      }[r.decided_by];
      assert.ok(evidenceOf, `${r.title}: an overruled row must name what overruled it, got ${r.decided_by}`);
      assert.notEqual(r.disposition, r.screened_disposition, `${r.title}: nothing to record if they agree`);
      assert.match(r.note || "", evidenceOf, `${r.title}: an overruled row must carry its instrument's numbers`);
    }
    assert.equal(maxDeltaSec(r.samples), r.max_delta_sec_implied, `${r.title}: worst delta`);
    assert.equal(adrTier(r.max_delta_sec_implied), r.tier, `${r.title}: ADR-0008 tier`);

    for (const s of r.samples) {
      if (s.ratio != null) {
        assert.equal(
          Math.round((s.delivered_bytes / s.declared_bytes) * 1000) / 1000,
          s.ratio,
          `${r.title}: ratio arithmetic`,
        );
        assert.equal(impliedDeltaSec(s.declared_bytes, s.delivered_bytes, s.duration_sec), s.delta_sec_implied);
      }
      /* A repeat-probed sample must carry the observations its row's verdict
         was computed from. Without this a `varying_samples: 0` is unfalsifiable. */
      if (r.repeats) {
        assert.equal((s.deliveries || []).length, r.repeats, `${r.title}: ${r.repeats} deliveries recorded`);
      }
    }
  }

  /* THE HEADLINE, RECOMPUTED. Every measured transcript lands in exactly one
     bucket — the arithmetic a PR body would otherwise assert by hand. */
  const split = measurementSplit(ev.results);
  /* AGAINST THE COMMITTED BLOCK, not merely against itself. The first version
     of this test asserted an internal sum identity and never compared the
     result to `ev.measurement` — verified by mutation: setting
     `measured_clean.timed_transcripts` to 999999 by hand left all 39 tests
     green. The sibling coverage test in `breadth-yield.test.mjs` had this
     right; this one did not. */
  assert.deepEqual(split, ev.measurement, "the committed measurement block is recomputed, not restated");
  const total = ev.results.reduce((n, r) => n + r.timed_transcripts, 0);
  assert.equal(
    split.measured_clean.timed_transcripts +
      split.measured_injecting.timed_transcripts +
      split.unresolved.timed_transcripts,
    total,
    "every anchorable transcript measured is accounted for in exactly one bucket",
  );

  /* A show reported as unresolved-with-no-samples must actually have none.
     Pinning the constant alone would pin nothing. */
  for (const r of ev.results.filter((x) => x.note === NO_DECLARED_LENGTH_REASON)) {
    assert.equal(r.n, 0, `${r.title}: claims no denominator but reports samples`);
    assert.equal(r.disposition, "unresolved");
  }
});

/* ------------------------------------ a gap that does not grow with the show */

const sample = (declared, delivered, duration = 3000) => ({
  declared_bytes: declared,
  delivered_bytes: delivered,
  duration_sec: duration,
  ratio: Math.round((delivered / declared) * 1000) / 1000,
  delta_sec_implied: impliedDeltaSec(declared, delivered, duration),
});

/* MUTATION: widen `CONSTANT_OFFSET_TOLERANCE_BYTES` to a megabyte, or drop the
   `hi - lo` spread check entirely. Verified failing.

   These are the real Art Bell Archive numbers: +99,324 / +99,387 / +99,331 /
   +99,303 / +99,319 bytes across episodes running 51.9MB to 56.5MB. An 84-byte
   spread over a 4.6MB spread in episode size is a FIXED BLOCK, not ad load —
   ad load scales with slots sold, and every genuinely injecting show in this
   pool shows it doing so. With the tolerance widened, Snail Trail's
   +811,065 / +1,498,237 / -870,068 would read as "constant" too, and the one
   signal that distinguishes a stale length from a stitcher would be gone. */
test("a byte gap identical on every episode is flagged as a fixed block", () => {
  const artBell = [
    sample(53_823_465, 53_922_789, 8565),
    sample(53_088_481, 53_187_868, 8325),
    sample(56_477_648, 56_576_979, 8504),
    sample(51_890_380, 51_989_683, 8625),
    sample(53_066_960, 53_166_279, 8434),
  ];
  assert.equal(constantOffsetBytes(artBell), 99_345);

  const snailTrail = [
    sample(56_322_639, 57_133_704, 3520),
    sample(36_051_203, 37_549_440, 2253),
    sample(74_823_188, 73_953_120, 6235),
    sample(92_623_230, 93_434_295, 5789),
  ];
  assert.equal(constantOffsetBytes(snailTrail), null, "ad load varies per episode; this must not read as constant");

  /* AND THE NEAR MISS, which is what actually pins the tolerance. Snail Trail's
     deltas span 2.4MB, so they stay null even with the tolerance widened a
     thousandfold — the mutant SURVIVED against that fixture alone. A gap
     jittering by ~50KB is the realistic adversary: still ad load, still not
     constant, and only a tight tolerance separates it from an ID3 tag. */
  const jitter = [sample(50_000_000, 50_800_000), sample(56_000_000, 56_830_000), sample(60_000_000, 60_850_000)];
  assert.equal(constantOffsetBytes(jitter), null, "a gap that moves by 50KB is not a fixed block");
});

/* MUTATION: return the offset when fewer than three samples agree. Verified
   failing. Two matching deltas is a coincidence, and this number's only job is
   to be strong enough to justify asking for a decode. */
test("two agreeing episodes are not a pattern", () => {
  assert.equal(constantOffsetBytes([sample(50_000_000, 50_099_000), sample(56_000_000, 56_099_000)]), null);
});

/* MUTATION: drop the `Math.max(sizes) - Math.min(sizes)` guard. Verified
   failing.

   If every sampled episode is the same size, "constant in bytes" and
   "proportional to duration" are the SAME observation — the function would be
   unable to tell a fixed tag from an ad slot and would confidently report the
   ad slot as a tag. A daily show whose episodes are all ~20 minutes is exactly
   that case, and it is common. */
test("a constant offset means nothing when the episodes are all the same size", () => {
  const uniform = [
    sample(20_000_000, 20_800_000),
    sample(20_000_100, 20_800_100),
    sample(19_999_900, 20_799_900),
  ];
  assert.equal(constantOffsetBytes(uniform), null);
});

/* MUTATION: return 0 rather than null when every episode matches its
   declaration exactly. Verified failing — `recover` already says "no gap", and
   a `constant_offset_bytes: 0` on a clean row is a field that reads like a
   finding while describing the absence of one. */
test("a show with no gap at all reports no constant offset", () => {
  assert.equal(constantOffsetBytes([sample(50_000_000, 50_000_000), sample(56_000_000, 56_000_000), sample(60_000_000, 60_000_000)]), null);
});

/* MUTATION: let `constantOffsetBytes` change the disposition — return
   "unresolved" or "recover" for a constant-offset drop. Verified failing.

   ADR-0008 reversed a sourcing gate and this signal must not become one in
   either direction. It is suggestive of what the gap IS; only the decoder can
   say. Re-admitting 1,368 transcripts on a suggestion is precisely the move
   #319 measured and found wanting — six of seven inferred-anchorable shows
   were injecting. */
test("the constant-offset signal explains a drop, it never reverses one", () => {
  const artBell = [
    sample(53_823_465, 53_922_789, 8565),
    sample(53_088_481, 53_187_868, 8325),
    sample(56_477_648, 56_576_979, 8504),
  ];
  const row = deriveRow({ show_id: "ab", samples: artBell });
  // Three of Art Bell's five; the midpoint of 99,324..99,387 is 99,356.
  assert.equal(row.constant_offset_bytes, 99_356);
  assert.equal(row.disposition, "drop", "still dropped: only a decode can settle what the bytes are");
  assert.match(row.note, /decode-and-compare/);
});

/* -------------------------------------------- one derivation, not two copies */

/* MUTATION: in the `--resume` path, push the prior row verbatim instead of
   re-deriving it. Verified failing.

   The samples are the evidence; every other field is an opinion about them. A
   copied row is judged by the rules that existed when it was measured, so one
   file ends up holding rows judged by two standards with nothing on them saying
   which — and any signal added since is silently frozen out of the rows that
   already exist. `constant_offset_bytes` was added after the pass that measured
   Art Bell, and re-derivation is why that row carries it without re-asking a
   publisher for bytes already committed. */
test("a resumed row is re-judged by today's rules, not yesterday's", () => {
  const samples = [
    sample(53_823_465, 53_922_789, 8565),
    sample(53_088_481, 53_187_868, 8325),
    sample(56_477_648, 56_576_979, 8504),
  ];
  const stale = { show_id: "ab", title: "T", samples, disposition: "recover", verdict: "ad-free", median: 9.9, n: 99 };
  const fresh = deriveRow(stale);
  assert.equal(fresh.disposition, "drop", "the stale disposition is recomputed, not trusted");
  assert.equal(fresh.median, 1.002);
  assert.equal(fresh.n, 3);
});

/* MUTATION: derive the note even when the caller supplied one. Verified
   failing. "the feed would not load" explains an empty sample list better than
   any inference drawn from its absence, and losing it would make a transient
   network failure indistinguishable from a feed that declares no lengths — two
   states wanting opposite follow-ups (a retry, and a decode). */
test("a caller's note outranks anything the samples could imply", () => {
  const row = deriveRow({ show_id: "x", samples: [] }, { note: "feed unreadable: socket hang up" });
  assert.equal(row.note, "feed unreadable: socket hang up");
  assert.equal(row.disposition, "unresolved");
  // ...and with no note supplied, the sample-derived one appears.
  assert.equal(deriveRow({ show_id: "x", samples: [] }).note, NO_DECLARED_LENGTH_REASON);
});

/* MUTATION: replace the resume path's `deriveRow(r, ...)` call with a bare
   `results.push(r)`. Verified failing.

   A unit test can pin what `deriveRow` does; only a scan can pin that the
   resume path USES it. Copying a prior row carries yesterday's verdict into
   today's file — one file holding rows judged by two standards, with nothing
   on them saying which — and freezes out every signal added since those rows
   were measured. `constant_offset_bytes` is exactly such a signal. */
test("the resume path re-derives a carried-forward row rather than copying it", () => {
  const src = readFileSync(new URL("./measure-suspects.mjs", import.meta.url), "utf8");
  assert.match(src, /carried\.set\(String\(r\.show_id\), deriveRow\(r,/, "resumed rows must go back through deriveRow");
  assert.doesNotMatch(src, /carried\.set\(String\(r\.show_id\), r\)/, "a prior row must never be stored verbatim");
  /* AND it must hand `deriveRow` the row's fetch note. Without it a carried row
     whose feed had failed is re-derived with no note, and an empty-sample row's
     note is filled with `NO_DECLARED_LENGTH_REASON` — rewriting "retry this"
     as "do not retry this" in committed evidence. `fetchNoteOf` has its own
     unit test; only a scan pins that the resume path calls it. */
  assert.match(src, /deriveRow\(r, \{ note: fetchNoteOf\(r\)[^)]*\}\)/, "a carried row keeps a note the samples cannot re-derive");
  /* AND BOTH LEDGERS. A resumed row that skipped them would be re-judged by
     the ranged-GET screen alone while a freshly probed one was judged by the
     decode and the grid — the same "two standards in one file" failure this
     test exists to prevent, one instrument further up. `grids` is named here
     for the same reason `decodes` was: when the flightcast pass condemned two
     shows the screen had left `unresolved`, a resume that dropped the index
     would have quietly restored them to the corpus on the next run, and the
     only visible symptom would have been the net going back up. */
  assert.match(
    src,
    /deriveRow\(r, \{ note: fetchNoteOf\(r\), decodes, grids \}\)/,
    "a carried row is re-judged against both the decode ledger and the probe grids",
  );
  /* AND SO DOES THE LIVE PROBE PATH. SURVIVED the first mutation run: dropping
     `grids` from the freshly-probed call site left every suite green, because
     this test only ever looked at the resume path. The two paths disagreeing is
     the "one file, two standards" failure in its purest form — a show re-probed
     today would be judged by the ranged-GET screen alone while the show beside
     it, carried forward untouched, was judged by the grid. */
  assert.match(src, /\{ note, decodes, grids \},/, "a freshly probed row is judged by the same ledgers as a carried one");
});

/* MUTATION: filter `deliveries` on `n > 0` instead of `isPlausibleAudioSize`.
   Verified failing.

   The bug a reviewer found, and the most expensive one available in this file.
   `probeEpisode` reads `delivered_bytes` from Content-Range OR a bare
   Content-Length, and it does not retry a 403/404/410 — those are answers. So
   an error page's Content-Length is a small positive integer that looks exactly
   like a measurement. One 404 mid-repeat makes an episode "deliver two
   different lengths", and `dispositionOf` reads variance FIRST, so a show is
   condemned as a stitcher by our own failed request. On Success Story that is
   1,264 transcripts. `ad-inflation.mjs` exports `isPlausibleAudioSize` for
   exactly this ("One host returned 2 bytes"), so the fix is an import and not a
   second threshold. */
test("an error page's Content-Length is not a delivery", () => {
  const real = 41_146_837;
  assert.equal(varyingSamples([{ deliveries: [real, 1136, real] }]), 0, "a 404 body is not a second stitch");
  assert.equal(maxDeliverySpread([{ deliveries: [real, 1136, real] }]), null);
  assert.deepEqual(plausibleDeliveries({ deliveries: [real, 1136, null, real] }), [real, real]);
  // ...and a genuine disagreement between two plausible files still condemns.
  assert.equal(varyingSamples([{ deliveries: [real, real + 9_400_000] }]), 1);
});

/* MUTATION: make `isSettled` return true for any row with a disposition, or for
   any row with at least one sample. Verified failing on both.

   Both weaker rules freeze a transient failure into a permanent verdict, which
   is the thing `--resume` exists to prevent. A feed that would not load yields
   a disposition and NO samples; a host that was rate-limiting yields five
   samples that are all `{ratio: null, delivered_bytes: null, error: "HTTP 503"}`
   — the probe loop records a sample for every episode it attempts, including
   total failures. Only "at least one probe came back with a length" separates
   measured from merely attempted. */
test("a row is settled only when a probe actually returned a length", () => {
  const failedFeed = { disposition: "unresolved", samples: [] };
  const failedProbes = {
    disposition: "unresolved",
    samples: [{ ratio: null, delivered_bytes: null, error: "HTTP 503" }, { ratio: null, delivered_bytes: null, error: "HTTP 503" }],
  };
  const measured = { disposition: "recover", samples: [{ ratio: 1, delivered_bytes: 40_000_000 }] };
  /* The repeat case: no ratio, because the feed declares no length — and still
     settled, because the bytes it exists to compare did arrive. */
  const repeated = { disposition: "unresolved", samples: [{ ratio: null, delivered_bytes: 60_686_420, deliveries: [60_686_420, 60_686_420] }] };

  assert.equal(isSettled(failedFeed), false);
  assert.equal(isSettled(failedProbes), false, "five 503s are not a verdict");
  /* AND the 404 case, which `n > 0` would have called settled: a refusal is not
     retried, so the error body's Content-Length arrives as `delivered_bytes`. */
  assert.equal(
    isSettled({ disposition: "unresolved", samples: [{ ratio: null, delivered_bytes: 1136, error: "HTTP 404" }] }),
    false,
    "an error page's Content-Length is not a measurement",
  );
  assert.equal(isSettled(measured), true);
  assert.equal(isSettled(repeated), true, "a repeat probe with no denominator still measured something");
  assert.equal(isSettled({ samples: [{ delivered_bytes: 1 }] }), false, "no disposition, nothing settled");
});

/* MUTATION: have `writeReport` read `results` or `split` — the two bindings
   that live after the probe loop. Verified failing.

   THIS BUG HAS NOW BITTEN TWICE, both times in the function whose entire job is
   surviving a crash. `writeReport` is called after every show so an interrupted
   run keeps its measured work; it is a hoisted declaration, so calling it
   mid-loop is fine, but anything it CLOSES OVER that is bound after the loop is
   still in its temporal dead zone. First `split`, then `results` when the loop
   moved to a keyed map — and the second one shipped far enough to abort a live
   150-request pass on its very first checkpoint. The failure is invisible to
   every unit test, because it needs the network path to reach it. So it is
   pinned by reading the source: the checkpoint may reference `carried`, which
   is bound before the loop, and nothing else from the summary. */
test("the checkpoint writer touches nothing bound after the probe loop", () => {
  const src = readFileSync(new URL("./measure-suspects.mjs", import.meta.url), "utf8");
  const start = src.indexOf("function writeReport()");
  assert.ok(start > 0, "writeReport must exist and stay a hoisted declaration");
  /* COMMENTS STRIPPED FIRST. `writeReport`'s own docstring names both bindings
     in order to explain why it must not touch them, so a scan over the raw text
     fails on the very sentence that documents the rule. */
  const body = src
    .slice(start, src.indexOf("\n  }", start))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["results", "split"]) {
    assert.doesNotMatch(
      body,
      new RegExp(`(^|[^.\\w])${forbidden}\\b(?!\\s*:)`, "m"),
      `writeReport closes over "${forbidden}", which is in its temporal dead zone at the mid-loop checkpoint`,
    );
  }
  assert.match(body, /\[\.\.\.carried\.values\(\)\]/, "it must take its rows from the map bound before the loop");
});

/* MUTATION: return `row.note` unconditionally from `fetchNoteOf`, or return
   null unconditionally. Verified failing on both.

   A BUG CREATED BY A FIX. Once `--resume` began re-deriving every prior row
   rather than only the settled ones, a row whose feed had momentarily failed
   went back through `deriveRow` with no note — and an empty-sample row's note
   is filled with `NO_DECLARED_LENGTH_REASON`, whose own docstring says it wants
   decode-and-compare "not a retry". So `feed unreadable: socket hang up` was
   rewritten in committed evidence as the opposite follow-up.

   The other direction matters just as much: carrying EVERY note forward would
   freeze the sample-derived ones, and re-deriving those is the entire reason
   the resume path calls `deriveRow` at all. */
test("a failed fetch keeps its note across a resume; a derived note is re-derived", () => {
  assert.equal(fetchNoteOf({ note: "feed unreadable: socket hang up" }), "feed unreadable: socket hang up");
  assert.equal(fetchNoteOf({ note: "no feed_url in the yield report for this show_id" }), "no feed_url in the yield report for this show_id");
  assert.equal(fetchNoteOf({ note: NO_DECLARED_LENGTH_REASON }), null, "a derived note must be recomputed, not carried");
  assert.equal(fetchNoteOf({}), null);

  // End to end: the row a resume would rebuild keeps the reason it cannot be retried away.
  const carried = deriveRow({ show_id: "x", samples: [], note: NO_DECLARED_LENGTH_REASON }, { note: fetchNoteOf({ note: "feed unreadable: 500" }) });
  assert.equal(carried.note, "feed unreadable: 500");
});

/* MUTATION: stamp `repeats` from the `--repeat` flag instead of reading it off
   the samples. Verified failing.

   `probeTargets` admits every timestamped episode under `--repeat N`, but an
   episode that declares a length is probed ONCE however the flag is set. A
   show with a mix then claimed three probes of episodes that got one, the
   `repeat_stable_no_denominator` slice counted it, and its note asserted "each
   probed 3x ... this feed declares no enclosure length" of a feed that does.
   The committed evidence escapes only because that pass was narrowed by
   `--host` to platforms that declare no lengths at all. */
test("a show is only repeat-probed if every one of its samples was", () => {
  const repeated = (n) => ({ ratio: null, delivered_bytes: 50_000_000, deliveries: Array(n).fill(50_000_000) });
  const once = { ratio: 1.0, declared_bytes: 50_000_000, delivered_bytes: 50_000_000, duration_sec: 3000 };

  assert.equal(deriveRow({ show_id: "a", samples: [repeated(3), repeated(3)] }).repeats, 3);
  assert.equal(deriveRow({ show_id: "b", samples: [repeated(3), once] }).repeats, undefined, "a mixed show is not repeat-probed");
  assert.equal(deriveRow({ show_id: "c", samples: [once, once] }).repeats, undefined);

  // ...and the slice that justifies the flightcast claim reads the samples too.
  const mixed = deriveRow({ show_id: "b", title: "Mixed", timed_transcripts: 900, samples: [repeated(3), once] });
  assert.equal(mixed.disposition, "unresolved");
  assert.deepEqual(
    measurementSplit([mixed]).repeat_stable_no_denominator,
    { shows: 0, timed_transcripts: 0 },
    "a show with one ratio-able episode was not 'probed N times with no denominator'",
  );
});

/* ------------------------------------------------------------- the grid

   THE THIRD INSTRUMENT, and the cheapest. Four requests for one URL's length —
   ranged and unranged, under each outbound identity — and no body at all. What
   it decides here: 1,914 timed transcripts that #323 left `unresolved` on the
   one origin it caught assembling per request, and which nothing but a 60 MB
   download could otherwise have settled. */

const gridRow = (over = {}) => ({
  show_id: "S1",
  title: "A Show",
  enclosure_host: "atelier.flightcast.com",
  timed_transcripts: 100,
  grid: {
    status: "stable",
    varies_by_request: false,
    episodes_probed: 3,
    episodes_informative: 3,
    varying_episodes: 0,
    varying_totals: [],
    varying_pairs: [],
    totals_seen: [100],
  },
  ...over,
});

const variesGrid = (over = {}) =>
  gridRow({
    grid: {
      status: "varies",
      varies_by_request: true,
      episodes_probed: 3,
      episodes_informative: 3,
      varying_episodes: 3,
      varying_totals: [7_848_961, 8_383_739, 10_631_316, 11_540_063],
      varying_pairs: ["7848961 vs 10631316", "8383739 vs 11540063"],
      totals_seen: [7_848_961, 8_383_739, 10_631_316, 11_540_063],
    },
    ...over,
  });

/* MUTATION: key `gridIndex` on `enclosure_host` instead of `show_id`. Verified
   failing.

   A PLATFORM VERDICT IS NOT A SHOW VERDICT, and on the flightcast pool that is
   measured rather than cautionary: six shows, one enclosure host, and two
   answers. A host-keyed index condemns 3,406 transcripts on the evidence of
   1,914 — the aggregation `_adswizz_note` forbids and that #321 already found
   wrong on blubrry (9 clean / 1 dirty) and libsyn (4/4 by origin). */
test("grid evidence is keyed on the show, never on the host it shares", () => {
  const index = gridIndex([
    { results: [variesGrid({ show_id: "dirty" }), gridRow({ show_id: "clean" })] },
  ]);
  assert.equal(gridOverride({ show_id: "dirty" }, index).disposition, "drop");
  assert.equal(gridOverride({ show_id: "clean" }, index), null, "same host, different show, no verdict");
});

/* MUTATION: make `gridIndex` keep the FIRST row for a repeated `show_id`.
   Verified failing. Later files supersede earlier ones for the shows they
   re-probed, matching how `--resume` replaces rows by `show_id`; the opposite
   rule would freeze a superseded pass in front of the one that corrected it. */
test("a later grid pass supersedes an earlier one for the same show", () => {
  const index = gridIndex([{ results: [gridRow()] }, { results: [variesGrid()] }]);
  assert.equal(gridOverride({ show_id: "S1" }, index).disposition, "drop");
  assert.equal(gridIndex([]).byShow.size, 0);
  assert.equal(gridIndex(null).byShow.size, 0);
});

/* MUTATION: return a `recover` (or an `unresolved`) from `gridOverride` on a
   `stable` grid. Verified failing.

   THE GRID CAN ONLY EVER CONDEMN, and that asymmetry is the whole of its
   licence. Agreement across four cells proves only that this delivery path does
   not lie the way `atelier.flightcast.com` does — #323's bare-chain control
   returns four identical cells ON THE LYING ORIGIN and stays `unresolved`. A
   grid that could admit a show would have admitted that one. */
test("a grid that agrees with itself moves nothing", () => {
  const index = gridIndex([
    {
      results: [
        gridRow({ show_id: "stable" }),
        gridRow({ show_id: "incon", grid: { ...gridRow().grid, status: "inconclusive", episodes_informative: 1 } }),
      ],
    },
  ]);
  assert.equal(gridOverride({ show_id: "stable" }, index), null);
  assert.equal(gridOverride({ show_id: "incon" }, index), null, "an unspent question is not a negative result");
  assert.equal(gridOverride({ show_id: "never-probed" }, index), null);
  assert.equal(gridOverride({ show_id: "S1" }, null), null, "a null index changes nothing");
});

/* MUTATION: quote `varying_totals` instead of `varying_pairs` in the note.
   Verified failing.

   The claim is "ONE url, two lengths". Pooled across three episodes it renders
   as six numbers for one URL, which overstates the finding inside the sentence
   that reports it — and this note is copied verbatim into
   `data/breadth-anchorable-inflation.json`, which is what a founder reads. */
test("the condemning note quotes one pair per URL", () => {
  const out = gridOverride({ show_id: "S1" }, gridIndex([{ results: [variesGrid()] }]));
  assert.equal(out.disposition, "drop");
  assert.equal(out.decided_by, "probe-grid");
  assert.match(out.note, /7848961 vs 10631316; 8383739 vs 11540063/);
  assert.match(out.note, /No body was read/);
  assert.ok(!/7848961 \/ 8383739 \/ 10631316/.test(out.note), "the union must not be quoted as one URL's lengths");
});

/* MUTATION: collapse `combineOverrides` to `grid || decode`, or to
   `decode || grid`. Verified failing (both, on different branches).

   Neither `||` is right and the reason is the asymmetry `decodeOverride`'s own
   header argues. `grid || decode` throws away a decode's condemnation — the one
   denominated in SECONDS against the show's own transcript — whenever a grid
   also fired. `decode || grid` lets an acquittal drawn from ONE decoded episode
   outrank positive evidence that the show's URLs are assembled per request,
   which makes that episode a sample of one from a distribution. */
test("the decode and the grid are combined by rule, not by whichever came first", () => {
  const grid = { disposition: "drop", decided_by: "probe-grid", note: "GRID" };

  assert.equal(combineOverrides(null, null), null);
  assert.deepEqual(combineOverrides(null, grid), grid, "the grid alone decides when nothing else spoke");
  assert.equal(combineOverrides({ disposition: "recover", note: "D" }, null).disposition, "recover");

  /* CORROBORATION, NOT REPLACEMENT: the decode saw the audio and says more. */
  const both = combineOverrides({ disposition: "drop", note: "DECODED: 139.13s beyond" }, grid);
  assert.equal(both.disposition, "drop");
  assert.match(both.note, /DECODED: 139\.13s beyond/, "the decode's seconds survive");
  assert.match(both.note, /CORROBORATED by the probe grid/);
  assert.match(both.decided_by, /^decode-and-compare/);

  /* SETTLING, NOT OVERRIDING. `unresolved` is not a finding to overturn, and
     this is the branch every flightcast row actually takes. */
  const settled = combineOverrides({ disposition: "unresolved", note: "cannot admit this show" }, grid);
  assert.equal(settled.disposition, "drop");
  assert.equal(settled.decided_by, "probe-grid");
  assert.match(settled.note, /SETTLES what the decode ledger could not/);

  /* THE CONTESTED CASE, unreached on today's evidence and written down anyway. */
  const beat = combineOverrides({ disposition: "recover", note: "DECODED CLEAN: 8625.53s against a cue at 8625.44s" }, grid);
  assert.equal(beat.disposition, "drop", "positive evidence of the mechanism outranks an acquittal built on absence");
  assert.match(beat.decided_by, /over decode-and-compare/);
  /* AND THE OVERRULED DECODE'S NUMBERS SURVIVE. A reviewer caught this branch
     paraphrasing the decode into "the decode ledger's recover" and dropping its
     note — which on this branch is total erasure, because `screened_disposition`
     records the SCREEN, not the decode. The corroboration branch above already
     asserts the same property; asserting it on only one of the two is how the
     loss got baked in unnoticed. */
  assert.match(beat.note, /DECODED CLEAN: 8625\.53s against a cue at 8625\.44s/, "an overruled decode still speaks");
});

/* MUTATION: restore the blind-host note's old ending, "ADR-0008
   decode-and-compare is the ONLY instrument that can settle it". SURVIVED the
   first mutation run — no test looked at that sentence at all.

   IT WAS FALSE IN TWO DIRECTIONS. It was already wrong when #323 shipped
   `probeGrid`: four requests and no body against a 60 MB download. And because
   `combineOverrides` concatenates the decode's note after the grid's, the
   flightcast rows came out asserting that only a decode could settle them, in
   the same sentence as the grid evidence that had just settled them — a
   self-contradiction in committed evidence, which is the specific failure
   #323's reviewer round caught twice.

   The sentence still has to read correctly STANDING ALONE, because that is the
   form the four flightcast shows the grid did not condemn still carry. */
test("the blind-host note names every instrument that could settle the row", () => {
  const index = decodeIndex({
    results: [decodeRow({
      show_id: "S1", resolved_host: "atelier.flightcast.com", probe_recorded_bytes: 67_510_022,
      comparison: { verdict: "excess-audio", decoded_sec: 5740.38, last_cue_sec: 5601.25, feed_duration_sec: 5626, beyond_transcript_sec: 139.13, delivered_bytes: 68_884_898 },
    })],
  });
  const withheld = decodeOverride({ show_id: "S2", enclosure_host: "atelier.flightcast.com" }, index);
  assert.equal(withheld.disposition, "unresolved");
  assert.match(withheld.note, /probe grid/, "the cheap instrument has to be named as a way out");

  /* MATCHED ON THE CLAIM, NOT ON ONE PHRASING OF IT. A reviewer caught the
     first version of this regex (`/only instrument/`) letting "Only ADR-0008
     decode-and-compare can settle it" walk straight past — the same claim, one
     synonym over, which is exactly how the contradiction reached two committed
     files in the first place. `ONLY` near `settle` is the shape to refuse. */
  const claimsSoleInstrument = /\bonly\b[^.]*\bsettle\b|\bsettle\b[^.]*\bonly\b/i;
  assert.ok(!claimsSoleInstrument.test(withheld.note), "a decode has not been the only way to settle a row since #323");

  /* AND THE COMBINED FORM MUST NOT CONTRADICT ITSELF. */
  const settled = combineOverrides(withheld, { disposition: "drop", decided_by: "probe-grid", note: "PROBE GRID: two lengths" });
  assert.equal(settled.disposition, "drop");
  assert.ok(!claimsSoleInstrument.test(settled.note), "the row must not deny the instrument that decided it");

  /* AND SO MUST EVERY NOTE IN BOTH COMMITTED LEDGERS. The contradiction lived
     in `regrid-clean.mjs`'s wording while this file's was correct, so a test
     scoped to one module would have passed while the two artifacts disagreed
     about the same four show_ids. */
  for (const rel of ["breadth-anchorable-inflation", "flightcast-settle-regrid", "breadth-clean-regrid"]) {
    const f = JSON.parse(readFileSync(new URL(`../../data/${rel}.json`, import.meta.url), "utf8"));
    for (const r of f.results || []) {
      assert.ok(!claimsSoleInstrument.test(r.note || ""), `${rel} / ${r.title}: claims one instrument is the only way to settle`);
    }
  }
});

/* MUTATION: drop `grids` from `deriveRow`'s options, or stop passing it at
   either call site. Verified failing.

   And the null case is the one that must not regress: every pool nobody has
   gridded passes `null` here, and a null index has to leave the screen's
   verdict exactly as it found it — the same property `decodeOverride` is
   pinned on. */
test("a grid reaches the row's disposition, and a missing one changes nothing", () => {
  const base = { show_id: "S1", enclosure_host: "atelier.flightcast.com", timed_transcripts: 1264, samples: [] };
  const grids = gridIndex([{ results: [variesGrid()] }]);

  const ungridded = deriveRow(base);
  assert.equal(ungridded.disposition, "unresolved");
  assert.equal(ungridded.grid_status, undefined, "no grid, no claim that one was spent");
  assert.deepEqual(deriveRow(base, { grids: null }), ungridded, "a null index is the same row");

  const gridded = deriveRow(base, { grids });
  assert.equal(gridded.disposition, "drop");
  assert.equal(gridded.screened_disposition, "unresolved");
  assert.equal(gridded.decided_by, "probe-grid", "credit the instrument that actually decided");
  assert.equal(gridded.grid_status, "varies");

  /* A STABLE GRID LEAVES THE DISPOSITION ALONE AND STILL SAYS IT WAS ASKED.
     Without `grid_status` the four flightcast shows the grid did not condemn
     are indistinguishable from four nobody probed — #324's whole point about
     `inconclusive` is that an unspent question and a spent one that came back
     negative are opposite facts a single absence renders identically. */
  const stable = deriveRow(base, { grids: gridIndex([{ results: [gridRow()] }]) });
  assert.equal(stable.disposition, "unresolved");
  assert.equal(stable.grid_status, "stable");
  assert.equal(stable.decided_by, undefined);
});

/* MUTATION: hand-edit `disposition` on one of the two dropped rows in the
   committed file, or edit its `grid_status`. Verified failing, and verified
   changing bytes on disk first.

   THE NUMBER IN THE FOUNDER'S HANDS. `anchorable_net_of_suspects` fell 10,747
   to 8,833 on exactly these two rows, and the evidence for both is four
   requests per episode recorded in `data/flightcast-settle-regrid.json`. This
   pins the committed measured file against the committed grid file so neither
   can drift without the other. */
test("the committed drops are the shows the committed grids condemned", () => {
  const measured = JSON.parse(
    readFileSync(new URL("../../data/breadth-anchorable-inflation.json", import.meta.url), "utf8"),
  );
  const grids = gridIndex([
    JSON.parse(readFileSync(new URL("../../data/breadth-clean-regrid.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../../data/flightcast-settle-regrid.json", import.meta.url), "utf8")),
  ]);

  const byGrid = measured.results.filter((r) => r.decided_by === "probe-grid");
  assert.equal(byGrid.length, 2);
  assert.equal(byGrid.reduce((n, r) => n + r.timed_transcripts, 0), 1914);

  for (const r of measured.results) {
    const evidence = grids.byShow.get(String(r.show_id));
    assert.equal(r.grid_status ?? null, evidence?.grid?.status ?? null, `${r.title}: the row records what the grid saw`);
    /* THE OVERRIDE IS RE-DERIVABLE FROM THE COMMITTED EVIDENCE. A row claiming
       the grid decided it, on a grid that did not vary, would be a number with
       no measurement under it. */
    if (r.decided_by === "probe-grid") {
      assert.equal(evidence.grid.status, "varies", `${r.title}: credited to a grid that saw nothing`);
      assert.equal(r.disposition, "drop");
    }
    if (evidence?.grid?.status === "varies") assert.equal(r.disposition, "drop", `${r.title}: condemned but not dropped`);
  }
});

/* MUTATION: remove `data/flightcast-settle-regrid.json` from
   `GRID_REPORT_RELS`. Verified failing.

   `GRID_REPORT_RELS` IS HAND-MAINTAINED AND NOTHING ELSE POINTS AT IT. A
   committed ledger missing from the list is evidence that was bought, written
   to disk, and then never consulted — the two condemned shows would revert to
   `unresolved` and 1,914 transcripts would return to the anchorable count with
   no diff in any data file to show for it. The artifact naming is independent
   of the list (`defaultOutFor` produces a path from the pool; the flightcast
   pass was also narrowed by `--host` and is committed under a narrower name),
   so the two can only be kept in step by asserting it. */
test("every committed grid ledger is one the scan actually reads", () => {
  const dir = new URL("../../data/", import.meta.url);
  const committed = readdirSync(dir).filter((f) => f.endsWith("-regrid.json"));
  assert.ok(committed.length >= 2, "both grid passes are committed");
  for (const f of committed) {
    assert.ok(
      GRID_REPORT_RELS.some((rel) => rel.replaceAll("\\", "/").endsWith(`data/${f}`)),
      `data/${f} is committed but GRID_REPORT_RELS does not read it`,
    );
  }
  /* ...and nothing in the list points at a file that is not there. */
  for (const rel of GRID_REPORT_RELS) {
    assert.ok(existsSync(new URL(`../../${rel.replaceAll("\\", "/")}`, import.meta.url)), `${rel} is listed but missing`);
  }
});

/* MUTATION: hand-add a `grid_status` to a row in
   `data/breadth-suspect-inflation.json` that disagrees with its grid. Verified
   failing.

   BOTH MEASURED LEDGERS, NOT ONE. The suspects file and the anchorable file are
   two pools of one scan and `deriveRow` writes both, so a guard scoped to one
   of them checks half the corpus. It is written to tolerate a MISSING
   `grid_status` — `data/breadth-suspect-inflation.json` predates the field and
   regenerating it would drag twelve unrelated shows and their re-probes into a
   flightcast change — but never a WRONG one, which is the failure that could
   move a number. */
test("no measured row claims a grid result its grid did not produce", () => {
  const grids = gridIndex(
    GRID_REPORT_RELS.map((rel) =>
      JSON.parse(readFileSync(new URL(`../../${rel.replaceAll("\\", "/")}`, import.meta.url), "utf8")),
    ),
  );
  for (const rel of ["breadth-anchorable-inflation", "breadth-suspect-inflation"]) {
    const f = JSON.parse(readFileSync(new URL(`../../data/${rel}.json`, import.meta.url), "utf8"));
    for (const r of f.results || []) {
      if (r.grid_status == null) continue;
      const evidence = grids.byShow.get(String(r.show_id));
      assert.equal(r.grid_status, evidence?.grid?.status, `${rel} / ${r.title}: grid_status has no grid behind it`);
    }
    /* AND A CONDEMNING GRID IS NEVER IGNORED IN EITHER FILE. This is the half
       that can move a number, so it is checked unconditionally. */
    for (const r of f.results || []) {
      if (grids.byShow.get(String(r.show_id))?.grid?.status === "varies") {
        assert.equal(r.disposition, "drop", `${rel} / ${r.title}: condemned by the grid but not dropped`);
      }
    }
  }
});
