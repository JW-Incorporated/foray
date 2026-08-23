/* Tests for the breadth suspect measurement. Run: node --test tools/segments/

   What this scan decides: whether 2,821 timed transcripts — 71% of tranche 1's
   anchorable haul, sitting in seven shows — are supply or noise. Both answers
   are useful; a guess is not. So the arithmetic that turns byte counts into
   that verdict is worth pinning line by line. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  probeTargets,
  impliedDeltaSec,
  maxDeltaSec,
  insertedSamples,
  unmeasuredSamples,
  dispositionOf,
  adrTier,
  recount,
  INSERT_EVIDENCE_SEC,
  PADDABLE_CEILING_SEC,
  NO_DECLARED_LENGTH_REASON,
} from "./measure-suspects.mjs";
import { AD_FREE_THRESHOLD, AD_FREE_FLOOR, summariseShow } from "../transcribe/ad-inflation.mjs";

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
  assert.match(src, /const disposition = dispositionOf\(/, "the scanner has lost sight of the call site");
  const call = src.match(/dispositionOf\(summary\.verdict, \{([^}]*)\}\)/);
  assert.ok(call, "dispositionOf is not called the way this guard expects");
  for (const forbidden of ["dai", "chain", "via"]) {
    assert.ok(
      !call[1].includes(forbidden),
      `the chain reached dispositionOf via "${forbidden}" — it is corroboration, not a vote`,
    );
  }
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
