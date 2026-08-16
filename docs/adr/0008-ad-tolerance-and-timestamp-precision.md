# ADR 0008: Ad tolerance and timestamp precision — when an injected show is still usable

## Status

**Accepted** — Wyatt, 2026-08-16:

> "Ads should not be a blocking issue as long as we can find the approximate
> right timestamp."

This reverses a **binary gate** that three sourcing documents have been applying
since 2026-08-15 (`docs/curation/grilling-foray-sourcing.md` §1,
`docs/curation/catalogue-broadening.md` §3,
`docs/curation/grilling-foray-passages.md` §2): a show whose delivered bytes
exceeded its feed-declared length by more than 1% was **rejected as a source**.
**Eleven** shows were rejected on that ground alone — eight in
`grilling-foray-sourcing.md` §4, three in `catalogue-broadening.md` §3 — several
of them with episodes those documents themselves describe as exactly on brief.

Amends ADR-0007 (segment anchoring) rather than replacing it. ADR-0007's ladder,
its anchors-required rule for DAI items, and its "skip rather than play the wrong
40 seconds" failure mode all stand unchanged. What changes is **where in the
pipeline the ad measurement is consulted**: it stops being a sourcing gate and
becomes a per-episode number that decides how a segment is anchored and whether
it can be played yet.

**Primary sources.** Measured evidence:
`docs/curation/transcription-scale-plan.md` §4 (eight episodes downloaded in
full, 2026-08-15), `tools/transcribe/ad-inflation.mjs` (the probe and its
threshold), `docs/curation/grilling-foray-sourcing.md` §4 and §5.2 (the
rejections and the rank/injection correlation), `docs/curation/catalogue-broadening.md`
§3 (three further rejections with recorded episode durations). DAI mechanics are
digested in `docs/research/corpus/digests.md` entries 9, 48, 19 and 15 — 15
(Chromaprint) is the fingerprint route named in §4 below.

## Context

### What is actually measured, and how

Ad load is measured as **delivered bytes ÷ feed-declared enclosure length**, via
a **2-byte ranged GET** reading the true total out of `Content-Range`.
**HEAD requests lie** on ad-inserting hosts: they return the ad-free master's
`Content-Length` while a real GET delivers the assembled file. The first version
of this scan used HEAD, reported 18 of 18 shows byte-stable, and was completely
wrong — Stuff You Should Know's HEAD says 35,549,607 and its download is
44,961,612. No conclusion in this ADR rests on a HEAD request.

The expensive version of the same question — full downloads, decoded duration
against the feed's own declaration — was run on eight episodes across four
shows on 2026-08-15:

| show | feed says | transcript ends | audio really is | delta |
|---|---|---|---|---|
| Stuff You Should Know | 36.98 m | 36.88 m | **46.93 m** | **+10.0 min** |
| Stuff You Should Know | 47.48 m | 47.37 m | 55.72 m | **+8.4 min** |
| Odd Lots | 66.43 m | 66.00 m | 76.67 m | +10.7 min |
| Odd Lots | 59.67 m | 59.15 m | 67.92 m | +8.8 min |
| This Podcast Will Kill You | 78.78 m | 78.31 m | 86.27 m | +8.0 min |
| This Podcast Will Kill You | 72.63 m | 72.17 m | 80.13 m | +8.0 min |
| Being an Engineer | 50.28 m | 51.68 m | 50.30 m | **none (+0.8 s)** |
| Being an Engineer | 39.25 m | 39.79 m | 39.26 m | **none (+0.3 s)** |

Every indie/self-hosted show measured across both sourcing passes came in at
**0 s** — 41 of 41 episodes at ratio 1.0000 in `grilling-foray-passages.md` §2.

### Gastropod, probed twice — and the finding that reshaped the padding rule

Probed 2026-08-16 by an ad-hoc script, with the numbers recorded in the PR #184
discussion. Episode: *"Out of the Fire, Into the Frying Pan"*, `itunes:duration`
= **2501.0 s**.

| probe | true decoded duration | bytes | delta vs feed |
|---|---|---|---|
| 1 | 2567.1 s | 41,146,837 | **+66.1 s** |
| 2 (fresh, same day, **same client**) | 2533.7 s | 40,612,263 | **+32.7 s** |

**Method:** fetch the enclosure, decode it, and compare the true duration against
the feed's `itunes:duration` — `container.duration / av.time_base` via PyAV
(`av==18.0.0` is already pinned in `tools/transcribe/requirements.txt`). It costs a
full download per probe, and it is the *only* instrument that works here, because
Megaphone declares `length="0"` and a byte ratio cannot be computed at all.
**No committed tool does this** — `ad-inflation.mjs` does ranged GETs only. Per
workflow rule 6, if we probe a second show this belongs beside it as a committed
script with a test floor rather than another ad-hoc run.

**Internal corroboration worth having, because it separates two error sources.**
Both probes decode at ~128.2 kbps (`41,146,837 × 8 ÷ 2567.1` and
`40,612,263 × 8 ÷ 2533.7`), and the byte difference over that bitrate is
`534,574 × 8 ÷ 128,200 =` **33.4 s** — exactly the duration spread. So the spread
is real, delivered audio, not a decoder or metadata artefact.

**But the baseline is a different matter, and this probe is missing the cross-check
the 2026-08-15 method had.** That table carries *both* "feed says" and "transcript
ends" columns and makes a point of their agreeing within a minute. The Gastropod
probe has only `itunes:duration` — and declared durations can be badly wrong with
**no ads at all**: `tools/transcribe/README.md` records Radiolab, flagged
`dai_suspected: false`, decoding at 1989.4 s against a declared 1745 s. **244 s of
pure metadata error on a file with no injection**, which is exactly why that
harness "measures duration from the file itself rather than trusting feed
metadata". So some part of Gastropod's 32.7 s floor may be metadata inaccuracy
rather than ad load. Which way that cuts: a constant metadata error inflates
`delta_max` without inflating actual displacement against the *transcript*
timeline, so the pad would be oversized — safe for the listener, but it can
wrongly push a show past the admission test. **Cross-check against the publisher
transcript's last cue before treating any single-source delta as ad load.** The
33.4 s spread is unaffected by this; only the baseline is.

Three things come out of this, and the third one is the important one:

1. **Gastropod's ad load is real, small, and inside the threshold** — 33–66 s, so
   it is PADDABLE. **One caveat is outstanding and it is not small:** both probes
   were the same client on the same day, and the margin below exists precisely to
   cover *a different requester's* copy, which we have never sampled. See open
   question 3.
2. **A bitrate-implied ratio cannot size a pad.** `grilling-foray-sourcing.md` §4
   records `1.080 — injected (bitrate-implied)` for Gastropod — but **against a
   different episode** (*"Where There's Smoke, There's… Whiskey, Fish, and
   Barbecue!"*), which has not been re-probed. So this is not a case of a
   measurement being refuted; it is two different episodes, and comparing them is
   the very axis error this section is about. What we can say: applied to *this*
   episode's 41.7-minute program, 1.080 would imply ~200 s, i.e. **3–6× what we
   actually measured** (against `delta_max` 66.1 s and probe 2's 32.7 s
   respectively). **Where we can afford the download, decode-and-compare is the
   instrument; the ranged-GET ratio is a screen.** (§7 of that document had already
   listed Gastropod for re-measurement — that flag covers Gastropod only, not the
   other bitrate-implied rows.)
3. **The delta is a property of the REQUEST, not of the episode.** The same
   episode, the same client, hours apart: **33.4 s of variance.** Nothing in this
   repo had measured that before — not because measurements were per-show (many are
   properly per-episode; `grilling-foray-passages.md` §1 insists on it) but because
   **no episode had ever been measured twice.** Per-episode tells you about the
   episode; per-*request* repeats tell you about the stitch, and only the second
   bounds a pad. That distinction is what the padding rule below turns on.

Stuff You Should Know's 8–10 minutes is understood to be **a pre-roll plus
mid-rolls** rather than one block at the front. Note what kind of claim that is:
no ad position was ever located. `transcription-scale-plan.md` §4 **infers** the
shape from the failure of a single calibration ("that is not a constant offset
that a single calibration fixes"), and the same shape was reported with the
ruling. It is a well-founded inference and the industry-standard DAI
configuration, but it is an inference, and §"The threshold" below explains why we
cannot do better without the locate step.

Note what the feed and the transcript agree on: **both describe the ad-free
program.** The declared duration and the publisher transcript's last cue land
within a minute of each other on every row, while the delivered file carries the
extra minutes. So the publisher transcript is a timeline of a file nobody
receives.

### Why the gate was expensive

`grilling-foray-sourcing.md` §5.2 sampled 70 US shows by chart rank, 69 of which
yielded a measurement:
**ranks 1–25 are 33% ad-free (9/27); ranks 26–200 are 71% ad-free (30/42).**
Yates-corrected χ² = 8.22 on 1 df, p < 0.01; the effect survives restriction to
the stronger byte-ratio method (41% vs 72%). So chart rank predicts ad
injection, and a gate on ad injection is therefore a gate on **fame**. The shows
it excluded are disproportionately the ones a listener has heard of — and,
because monetised shows are also the ones that pay for transcription, they are
disproportionately the ones shipping free timed transcripts. Stuff You Should
Know alone ships **2,850** of them and Odd Lots **1,251**; together they are half
of our entire free-transcript inventory (`segment-extraction-pipeline.md`,
`DECISIONS.md` 2026-08-12), and both were excluded.

### The distinction the ruling turns on

"Approximate" is achievable for some shows and not others, and **the distinction
is mid-rolls, not total volume.**

Let `cum(t)` be the injected ad time occurring before content-time `t` in a
given copy. It is a non-decreasing step function: flat between breaks, jumping
by a pod's length at each break, and bounded above by that copy's **total**
delta.

- **Pre-roll only.** Every break is at `t = 0`, so `cum(t)` is the same constant
  `D` everywhere. Every timestamp shifts by one number; a single calibration —
  or a start pad — lands correctly no matter how large `D` is.
- **Mid-rolls.** The error at any point is *our* cumulative ad time before that
  point minus *the listener's*: `err(t) = cum_ours(t) − cum_theirs(t)`. When we
  author from a publisher transcript, `cum_ours ≡ 0` and the error is simply
  minus the listener's cumulative load — so the content we want sits **later** in
  their file, by an amount that **grows through the episode**. When we author
  from our own downloaded (stitched) copy, both terms are non-zero, the sign can
  go either way, and the terms cancel only if two independent stitches happened
  to match break-for-break — which they do not, because each break is filled per
  request.

The consequence that decides everything: **the error can exceed the length of
the segment itself.** Our target band is **75–180 s, centre ~110 s**
(`docs/curation/segment-length-rules.md` §0), and the observed batch median is
62 s. An 8-minute divergence is three to eight segment-lengths wide. A 2-minute
segment displaced by 8 minutes is not a slightly-off cut; it is a different
story, told by a different person, possibly inside an ad.

## Options considered

### 1. Keep the binary gate at ratio < 1.01

The status quo. Safe, and rejected: it costs 67% of the top-25 catalogue, it
selects against fame and against free transcripts simultaneously, and the ruling
overrules it. It also measures the wrong quantity — see option 2.

### 2. Relax the gate to a looser ratio

Rejected, because **a ratio is not the quantity that hurts us.** Anchor
resolution has an absolute tolerance in seconds, so the damage scales with
seconds, not with proportion. Ratio 1.02 on a 78-minute This Podcast Will Kill
You episode is ~94 s; the same 1.02 on a 20-minute episode is ~24 s. Same ratio,
four-fold difference in consequence. And a ratio is **uncomputable exactly where
we most need it**: Megaphone and some WordPress feeds declare `length="0"`, which
is why Gastropod, Proof and olive are all recorded as *bitrate-implied* — while
a delta in seconds is obtainable from decoded duration against `itunes:duration`
on those same feeds. Ratios were the cheap proxy; seconds are the measurement.

### 3. Two tiers, gated on the delta in **seconds** — the decision

Replace the boolean with a per-episode delta in seconds and two tiers:

| tier | condition | what it means |
|---|---|---|
| **PADDABLE** | pad (`delta_max` + margin, N ≥ 2 probes) **≤ 120 s** | usable now: pad by that upper bound |
| **LOCATE-REQUIRED** | pad **> 120 s** | author now, play once the locate step exists |

## The threshold, and why it is 120 s

**120 s, matching `ANCHOR_TIME_TOLERANCE_SEC` in
`tools/segments/merge-segments.mjs`.** Three independent reasons converge on
that number, which is why it is not an arbitrary round figure:

**1. It is the tolerance the pipeline already enforces, and below it the gate is
distribution-free.** `merge-segments.mjs` already accepts an anchor that
resolves within 120 s of its claimed timestamp, and rejects one that does not
("an anchor that resolves twenty minutes from its own `start_sec` means the
timeline cache is junk even though the words are real"). Be precise about what
that check is: it is **authoring-time self-consistency** — the anchor against the
transcript it was authored from — not a playback guarantee. What we are borrowing
is its *judgement about scale*: 120 s is the displacement this project has
already decided is slack rather than junk. Because `cum(t) ≤ total`
for every `t`, a total delta ≤ 120 s bounds the error at **every point in the
episode** at ≤ 120 s — **whatever the ad distribution is.** This is the crux: below
the threshold we do not need to know, and do not need to discover, whether the
ads are a pre-roll or six mid-rolls. (That bound holds *within* a given copy. Which
copy the listener gets is a second question, and the answer moves per request —
see § "The pad must be an UPPER BOUND".) Above it, the distribution decides the
outcome and the distribution is exactly what a byte or duration measurement
cannot see. Two shows with an identical total delta, one pre-roll-only and one
mid-rolled, are indistinguishable from outside the file. Determining which is
*already the locating step*. So the honest rule is: **above 120 s, assume
mid-rolls** — which is also the understood shape of all three heavily-injected
shows in the table above. (Being an Engineer, the fourth show measured, injects
nothing at all: +0.8 s and +0.3 s.)

**2. A pad longer than the segment is not a segment.** 120 s sits just above the
**centre** of our target band (75–180 s, centre ~110 s) — the band's top is 180 s,
and the number that matters here is the centre, because that is the length of a
typical segment the pad has to protect. Padding
costs runtime: seeking to an un-corrected in-point lands us `cum` seconds *early*
in the content, and an un-extended stop lands `cum` seconds early too, truncating
the payload — so the **stop** must be extended by the pad. At a 120 s pad on a
110 s segment, the pad exceeds the thing it protects. Beyond that the "segment" is
just a region of episode with a hopeful name.

**Do not justify that extra head with §3f.** The sacrificial-head rule budgets
**~4 s** ("≈ 11 words at 170 wpm") of *deliberately chosen* run-up. A displaced
seek produces tens of seconds of *incidental* audio, which is a different and much
larger thing — 66 s is ~16× the §3f budget. It is usually harmless (it is program
audio from slightly earlier), but it is not free, and if an ad break happens to
straddle the landing point the segment can **open inside an ad pod**. That is an
editorial cost to accept knowingly, not a rule we already have. It does not touch
R11: playing an ad we happen to land on is the opposite of detecting or stripping
one.

**3. The pad is sized from the show's own measured worst case, not from the
global ceiling.** The ceiling admits; the measurement sizes. Gastropod is padded
by ~100 s rather than by a flat 120 s. But *which* measurement sizes it is the
subtle part, and getting it wrong misses content — see the next section.

### The pad must be an UPPER BOUND on the delta, never a point estimate

This is the rule the Gastropod double-probe forced, and it corrects an earlier
draft of this ADR that said "pad by the measured delta". That was unsafe.

**Padding is asymmetric in cost — and the pad controls only the STOP.** Be precise
about the geometry, because it is easy to state backwards. Content authored at
program-time `t` sits at `t + cum(t)` in the listener's file. So an un-corrected
seek lands us **early** in the content by `cum`, and an un-extended stop lands
**early** too, cutting the payload short. **The early start happens regardless of
the pad** — it is the displacement itself, not something padding buys or reduces.
What the pad decides is whether the stop reaches far enough to cover the payload:

- **Pad ≥ the copy's load → the whole payload is captured**, plus up to
  `pad − cum` seconds of extra tail. Cheap, and the direction the ruling accepts.
- **Pad < the copy's load → the stop lands early and the payload is truncated by
  the shortfall.** This is the one failure padding exists to prevent.

So a point estimate is the wrong statistic: it is too small about half the time,
and every such time loses content. Concretely, from the two probes above: **pad by
the measured 33 s and a listener whose copy carries 66 s stops us 33 s early —
33 s of payload cut off the end.** Pad by 66 s and a listener carrying 33 s stops
33 s late — payload captured, with 33 s of extra tail.

**Scope: this one-way asymmetry assumes we authored against the publisher's
ad-free transcript**, where `cum_ours ≡ 0`. For a segment authored against our own
downloaded (stitched) copy — the fingerprint route below — both terms are non-zero
and, as § "The distinction the ruling turns on" already says, the sign can go
either way. Those segments need a head allowance as well as a tail one, and this
section's stop-only rule is not sufficient for them.

**The rule:**

```
delta_max = max delta over N probes of the SAME episode,  N >= 2
pad        = delta_max + margin,  margin >= the observed spread between probes
admit if   pad <= 120 s
```

- **N = 1 bounds nothing.** Two probes of one episode disagreed by 33.4 s, so a
  single sample is a draw from a distribution whose width we have not measured.
  This is mandatory, not advisory.
- **The margin exists because our probes are not the listener's request.** We can
  only sample our own copies; the listener's is another draw. A margin at least as
  wide as the spread we observed is the cheapest defensible cover. For Gastropod:
  `delta_max` 66.1 s + spread 33.4 s = 99.5 s, i.e. **a ~100 s pad**.
- **The admission test runs on the PAD, not on the raw delta.** Both numbers want
  the same worst-case statistic, for different reasons: admit only if the worst
  plausible displacement stays inside the tolerance, then pad by that same worst
  case. Using a median or a single sample for either is the same class of error
  this ADR already calls out in `summariseShow()`.
- **`summariseShow()` is therefore wrong twice over for this purpose**, not once.
  It takes a median (wrong statistic) across *different episodes* (wrong axis).
  Bounding a pad needs the max across *repeats of one episode*. Both are recorded
  here as consequences; neither is changed in this docs-only PR.

**The honest cost of this correction: the guarantee weakens from deterministic to
probabilistic, and nothing we have measured bounds the tail.** With the delta
fixed per episode, "total ≤ 120 s bounds the error everywhere" was arithmetic. With
the delta varying per request, we bound the listener's load only by sampling our
own, so the claim becomes: *displacement stays within the pad for any copy whose
load is no worse than the worst we sampled, plus the margin.* When a copy exceeds
that, the payload is truncated **by however much it exceeds it** — and the one
spread we have measured is **33.4 s, up to a third of a 110 s segment.** Do not
read this as "a few seconds". Nor can we claim such a copy could never land in a
different story: the admission test caps *our sampled* load, not the listener's,
which is exactly the limitation this paragraph is about. It is still a materially
better failure than the >120 s tier's — truncation of a segment we chose, rather
than a confident cut at an unknown place — but it is a probabilistic argument now
and should not be dressed as a bound.

**Effective headroom is smaller than the ceiling — how much smaller depends on an
assumption, so state it.** Strictly, `pad = delta_max + margin ≤ 120` with
`margin ≥ 33.4 s` gives only `delta_max ≤ 86.6 s`. The tighter figure quoted
elsewhere in this ADR — roughly `delta_max ≤ 60–80 s` — additionally assumes the
margin **scales with the delta** (Gastropod's spread was 0.505 × its `delta_max`),
which is generalised from one ratio on one episode of one show. That assumption is
not measured, and it is the single most load-bearing unmeasured thing here; open
question 3 asks for the two extra probes that would test it. Either way the
direction is unambiguous: **admission headroom is well under 120 s of raw delta**,
which is why every PADDABLE row except Gastropod needs probing before it ships.

## What a large delta costs, and what recovers it

**A large delta is not fatal in principle.** ADR-0007 already decided that a
boundary is *a place in the content*, with time as a cache: "Timestamps are an
optimisation; the anchor is the truth." Content does not move relative to itself,
so an authored segment on a heavy-DAI show is **not wrong** — its anchors stay
verbatim and true under any ad load, forever. Only the cache is stale. This is
precisely the durability argument ADR-0007 made for its own fan-out ("that output
should not have a shelf life measured in ad campaigns"), and it is why authoring
into heavy-DAI shows is safe to start today.

**It is fatal without a locating step**, because playback needs a *time*, and the
only way to turn an anchor into a time is to find the anchor in the copy in hand.

**Duration match cannot supply that step.** It is ADR-0007's third rung — DAI
plus `|observed − reference| ≤ DRIFT_TOLERANCE_SEC` → trust the cache — and it is
a **detector, not a locator**: one scalar cannot invert a piecewise-constant
offset function with `k` unknown break positions and `k` unknown pod lengths.
This is exactly why route 2 in `transcription-scale-plan.md` §4 is dead: "that is
not a constant offset that a single calibration fixes — it is a pre-roll plus
mid-rolls, so every timestamp after the first ad break is wrong by a different
amount."

**The rung that locates is ADR-0007's fourth: "resolve the anchor against a
transcript of the copy in hand."** Two implementations, and the difference is
which one we can afford:

- **Windowed on-device ASR** — the rung itself is named in ADR-0007, which also
  establishes that it needs the audio, therefore the download path (#29),
  therefore native-only. The **windowing** below is this ADR's contribution, not
  ADR-0007's. It is cheaper than it
  looks, and the delta measurement is what makes it cheap: since
  `cum(t) ∈ [0, total]`, the content authored at `t` lies in
  `[t, t + total]` in the listener's file. **The search window is exactly the
  total delta wide** — and, for the same reason the pad must be an upper bound,
  the window must be sized on `delta_max + margin` rather than on a single
  measured delta. A window sized to a point estimate can simply not contain the
  target: the anchor then reads as unresolvable and the segment is skipped, which
  is safe but wastes the whole locate attempt. Sized honestly for a 2-minute segment on a Stuff
  You Should Know episode — `delta_max` 10.0 min, plus a margin (its 1.6 min
  cross-episode spread is the only one on record, and by this ADR's own axis
  argument it does not bound one episode's per-request spread) — the window is
  **~13.6 min of audio to transcribe instead of 47, a ~3.5× saving.** An earlier
  draft said ~12 min, which was the point estimate this section forbids. So
  the per-episode delta is not only the gate; it is the *parameter* of the locate
  step, which is a second reason to record it in seconds rather than throwing it
  away as a boolean.
- **Acoustic fingerprint alignment** (Chromaprint, digest 15; route 4 in
  `transcription-scale-plan.md`, **"not designed"**) — cheaper per lookup, but it
  requires reference audio *at the boundary* to fingerprint. That rules it out
  for every segment authored from a publisher transcript, where we never held
  the audio. Fingerprinting fits self-transcribed episodes; windowed ASR fits
  publisher-transcript episodes. They are complements, not alternatives.

## What we can do today, and what waits

**Today, with no new machinery at all:**

1. **Stop rejecting sources on ad ratio.** Sourcing passes gate on content and
   on transcript availability. Ad load is recorded, not disqualifying.
2. **Author and commit segments for injected shows.** Anchors are durable by
   ADR-0007; the extraction output is correct now and stays correct.
   `merge-segments.mjs` already permits a DAI item when both anchors are present
   and non-empty, and already validates anchors as verbatim — no schema change,
   no validator change, no new constant.
3. **Record the delta in seconds, per episode, over N ≥ 2 probes, alongside the
   ratio.** Where the feed declares a real `length`, repeated 2-byte ranged GETs
   are enough and cost kilobytes — each request reports its own `Content-Range`
   total, so the repeats are what expose per-request variance. Where the feed
   declares `length="0"`, only a decode works, so budget two downloads for that
   episode. Record `delta_max`, the observed spread, and N — a delta with no N is
   not a bound.
4. **Rely on the existing honest-failure path for anything unplayable.** An
   authored segment boundary is `FOREIGN` by ADR-0007's own definition, and
   `seekPrecision()` as it stands today returns **`approximate` for any
   `dai_suspected` item on a foreign timeline whenever there is no downloaded file**
   (`isLocalFile` short-circuits to `exact` ahead of the DAI check, and that path
   needs #29) — it does not
   even reach a duration comparison, because ADR-0007's third and fourth rungs
   are described in that ADR and **not yet implemented**: the live function has
   only `OWN` and `FOREIGN`, and the `DRIFT_TOLERANCE_SEC = 30` check runs solely
   on the `OWN` branch. So the segment is **skipped**. The downside of relaxing
   the gate today is therefore bounded by machinery that already exists: **the
   worst case is a skipped segment, never a bad cut** — and it is bounded more
   tightly than the ADR-0007 ladder implies, because nothing on a DAI item can
   currently claim `exact` from a foreign timestamp at all.

**A player change — small, but larger than "one constant" — needed before a
PADDABLE segment on an injected show actually plays.** Two parts. The stop must
be extended by the **pad** — the upper bound, not the last delta we happened to
measure; and `seekPrecision()` needs a **`FOREIGN` branch that consults a recorded
per-episode pad**, which does not exist today — the function currently returns
`approximate` for every foreign DAI timestamp without looking at durations at all,
and its `DRIFT_TOLERANCE_SEC = 30` comparison lives only on the `OWN` branch. So
this is not "widen a constant": it is implementing the third rung of ADR-0007's
ladder for foreign timestamps, with the tolerance keyed to the segment's recorded
pad rather than to 30 s. Still
bounded — one field on the segment record, one branch, and tests — and
deliberately not built in this PR. Note the 30 s constant itself should **not** be
widened: it guards the listener's own marker against their own copy, which is a
different question with a correct answer already.

**Waits for the locate step (>120 s):** playback of anything in the
LOCATE-REQUIRED tier — all eight of Stuff You Should Know, Odd Lots, This Podcast
Will Kill You, Naan Curry, the BBC Food Programme, The Delicious Legacy, Hungry for
History, and (once headroom is applied) Grill This! and The Fantastic History Of
Food. Authoring does not wait; playing does.

## The unlock, quantified

Reasoned from the recorded measurements in the two sourcing documents; **no new
scan was run** beyond the Gastropod probes above. For a show recorded only as a
ratio, the implied delta is `(r − 1) × program_length`.

**Two health warnings on the table, both consequences of the upper-bound rule.**

1. **The `break-even` column is a SCREEN, not the admission test.** It answers
   "above what program length does the *implied* delta cross 120 s?" —
   `120 ÷ (r − 1)`, read in **ad-free program minutes** (the length the feed
   declares, since `ratio = delivered ÷ declared`). It predates the upper-bound
   rule and is now optimistic in every row, because admission runs on
   `delta_max + margin`, not on a single implied delta. At an illustrative 60 s of
   headroom the same break-evens halve: A Taste of the Past 50 min, Proof
   **35.7 min** (inside its own estimated 30–40 min band), olive 50 min, El Mundo
   62.9 min, The Fantastic History Of Food 23.3 min, Grill This! 13.7 min. Use the
   column to *rank probing effort*, never to admit a show.
2. **No pad is quoted for any row but Gastropod, deliberately.** A pad needs
   `delta_max` and a spread; every other row has a *median across different
   episodes*, from which `delta_max` cannot be derived at all — it is unbounded
   above by construction. An earlier draft of this table quoted pads of
   `2 × implied delta` for those rows; that coefficient appears in no rule, and
   applied to Gastropod it would have produced a 132 s pad and **failed the very
   row we measured.** Withdrawn.

| Show | recorded | break-even (screen only) | episode length | tier |
|---|---|---|---|---|
| Gastropod | **+66.1 / +32.7 s, 2 probes** (decoded duration) | — | 41.7 min (recorded) | **PADDABLE** — `delta_max` 66.1, spread 33.4, **pad ~100 s** (99.5 of a 120 s ceiling: it clears by 17%) |
| A Taste of the Past | 1.020 | 100 min | *est.* ~35–45 min | PADDABLE on the screen — implied 42–54 s. `delta_max` unknown. Needs N≥2 probes |
| Proof (America's Test Kitchen) | 1.028 (bitrate-implied) | 71 min | *est.* ~30–40 min | **TIGHT** — implied 50–67 s, i.e. already at Gastropod's *max*. Needs N≥2 probes |
| olive (Immediate Media) | ~1.02 (bitrate-implied) | 95–100 min | **45 min** (recorded) | **TIGHT** — implied ~54 s. Needs N≥2 probes, by decode (`length="0"`) |
| El Mundo en un Bocado | 1.0159 | 126 min | **47 min** (recorded) | PADDABLE on the screen — implied ~45 s. Needs N≥2 probes |
| The Fantastic History Of Food | 1.043 | 46.5 min (23.3 at 60 s headroom) | unrecorded | **undecided, and likely LOCATE-REQUIRED** once headroom is applied |
| Naan Curry with Sadaf and Archit | 1.0470 | 42.6 min | **67 min** (recorded) | LOCATE-REQUIRED |
| Grill This! | 1.073 | 27.4 min (13.7 at 60 s headroom) | unrecorded | **undecided, and likely LOCATE-REQUIRED** |
| BBC The Food Programme | 1.099 | 20.2 min | *est.* ~28 min (R4 slot) | LOCATE-REQUIRED |
| The Delicious Legacy | 1.170 | 11.8 min | unrecorded — irrelevant, see below | LOCATE-REQUIRED |
| Hungry for History | 1.461 | 4.3 min | unrecorded — irrelevant | LOCATE-REQUIRED |
| Stuff You Should Know | **+8 to +10 min measured** | — | 37–47 m (recorded) | LOCATE-REQUIRED |
| Odd Lots | **+8.8 to +10.7 min** | — | 60–66 m (recorded) | LOCATE-REQUIRED |
| This Podcast Will Kill You | **+8.0 min** | — | 73–79 m (recorded) | LOCATE-REQUIRED |

**No show in the table is rejected on ad load any more.** Beyond that, be careful
with the word *admitted*: it means `pad ≤ 120 s`, and only **Gastropod** has the
measurements to satisfy it. Four more rows screen as plausibly PADDABLE, two are
undecided and likely LOCATE-REQUIRED, and eight are LOCATE-REQUIRED outright —
those eight are emphatically *not* "admitted", they are authorable.

Of the fourteen rows, **eleven were flat rejects** on ad ratio; the other three
(Stuff You Should Know, Odd Lots, This Podcast Will Kill You) were never in a
sourcing rejection table — they were routed to ASR instead, because
`transcription-scale-plan.md` §4 concluded "route 2 is dead and ASR is the path for
injected shows." This ADR gives them a third option that costs no ASR at all.

**Which rows are ready, and which need work — stated explicitly, because this is
the part that is easy to over-claim:**

- **Gastropod is the only row with a defensible pad** — two same-episode probes, a
  measured spread, a `delta_max`, and a pad derived from them. It is the template
  for the rest. **It is not "ready to ship", and this ADR should not be read as
  saying so**, for two reasons outside the ad question: no PADDABLE segment can
  *play* until `seekPrecision()` gains the `FOREIGN` branch described above (open
  question 2 asks whether that work is even funded), and Decision 1 keeps
  **transcript availability** as a rejection ground — nothing in this repo records
  whether Gastropod ships a timed transcript, and
  `grilling-foray-passages.md` §Scope says plainly "no Gastropod was fetched or
  authored here." Confirm the transcript before anyone counts this slot as filled.
- **Screened as plausibly PADDABLE, but not admitted until probed N ≥ 2: every
  other candidate row.** Their deltas are *implied* from a ratio recorded as a
  median across different episodes; no episode was ever probed twice, so
  per-request variance is unbounded and `delta_max` cannot be derived at all. Two of them — **Proof and olive** — are the
  ones to watch: at an implied 50–67 s and ~54 s, their *median* is already at or
  above Gastropod's *maximum*, so their own maximum is likely higher again. **A
  show can fail admission at the probing step, and that is the system working, not
  a regression.**
- **Cheap for some, a download for others.** Where a feed declares a real
  `length`, N repeated 2-byte ranged GETs *do* see per-request variance — each
  request returns its own `Content-Range` total — so N ≥ 2 costs a few kilobytes.
  Where a feed declares `length="0"` (**Gastropod** and **olive** on Megaphone; **Proof**'s host is
  not recorded in this repo), only a decode works, so N ≥ 2 costs **two full downloads per
  episode**. The shows we most want to bound are the ones that cost the most to
  bound. Budget for it rather than skipping the second probe.
- **Safe on their break-even alone, with no duration and no probe:** The Delicious
  Legacy and Hungry for History. Their break-even lengths (11.8 and 4.3 min) are
  below any plausible episode, so LOCATE-REQUIRED holds whatever the length is.
  Same logic in reverse does not apply anywhere — no row is admitted on a
  break-even alone.
- **Safe on measured deltas:** Stuff You Should Know, Odd Lots and This Podcast
  Will Kill You are far enough over the line (+8 to +10.7 min) that per-request
  variance of tens of seconds cannot change their tier.
- **Marked `est.` = an episode length that is NOT recorded in this repo.** Those
  three rows (A Taste of the Past, Proof, BBC The Food Programme) rest on an
  outside-repo expectation of typical episode length. Two independent unknowns
  therefore stack on those rows — the episode length *and* the per-request spread
  — which is why they are the ones to probe first.
- **Undecided on the ratio alone:** The Fantastic History Of Food (break-even
  46.5 min) and Grill This! (27.4 min) sit close enough to plausible episode
  lengths that the ratio does not decide them at all.
- **Proof and olive carry a third caveat inherited from the source docs:** both are
  **bitrate-implied** readings on `length="0"` feeds, and olive's ~1.02 is the
  recorded reading of "delivered bytes imply 163.4 kbps against a 160 kbps encode".
  Gastropod's case is the cautionary one here — its bitrate-implied 1.080 overstated
  the true load by roughly 3×. Bitrate-implied numbers may be wrong in *either*
  direction, so neither of these rows should be read as settled in either
  direction.

None of this changes the thing that actually changed: **no show in the table is
rejected on ad load any more.** What the double-probe changed is the price of
acting on a row — from "read the ratio" to "probe the episode twice" — and one
row has now paid it.

### What this does to Foray #1's arc

Against the eight arc slots in `grilling-foray-passages.md` §3, which currently
hold **8 passages / 8:21 total** across 5 slots:

| Arc slot | Before | After the relaxed gate |
|---|---|---|
| Fire and the origins of cooking | partial, 2:06 — counterpoint only; the cooking hypothesis is in Origin Stories, which publishes no transcript | **Gastropod's "Out of the Fire, Into the Frying Pan" (prehistoric origins) is probed twice and PADDABLE at a ~100 s pad** — the first candidate admitted on measured evidence under this ADR, and a real prospect for the arc's opening slot with no ASR. Two things still gate it, neither about ads: whether it ships a **timed transcript** (unrecorded here), and the `seekPrecision()` `FOREIGN` branch |
| Pre-modern hearth / spit / griddle | filled, 2:13 | The Delicious Legacy (249 eps of ancient/medieval food history) becomes authorable — LOCATE-REQUIRED |
| American barbecue's birth and westward spread | other workstream's | **A Taste of the Past's "Black Smoke, the African American Roots of BBQ" and Proof's 4-part "Barbecue Trailblazers" are PADDABLE** (both on an estimated episode length — one probe each). SYSK's **"A Lip-Smacking Look at Barbecue"** is LOCATE-REQUIRED |
| Regional US divergence (Santa Maria) | blocked, 0:00 — BBQ RADIO NETWORK ships no transcripts | Proof adds a transcript-bearing US-barbecue source; Santa Maria itself unchanged |
| World traditions — satay / SE Asia | 2:17 | unchanged (already ad-free) |
| World traditions — jerk / Caribbean | partial, 1:02 framing only | **A Taste of the Past's "Some Like it Hot — Jamaican Jerk History" is PADDABLE** (estimated length; wide margin); Grill This! (jerk wings) is LOCATE-REQUIRED on any episode over 27 min, and weak on content anyway |
| World traditions — braai, yakitori, Korean, asado, Santa Maria, Mexican, Filipino | 0:00 | **Mexican upgrades** from "three ad-free clips, together worth one 90-second passage" to El Mundo en un Bocado's 47-min *Tacos al Pastor*, PADDABLE. Others unchanged |
| The modern backyard era | 0:44 | BBC Food Programme's "Smoke, Fire and Flame: Trends v Tradition" — LOCATE-REQUIRED |

**Two traditions change status outright:**

- **Tandoor moves from "not sourceable" to reachable.**
  `catalogue-broadening.md` §4 concluded: "tandoor content exists, and it is on
  ad-injecting hosts." That verdict was a consequence of *this gate*, not of the
  content. olive's 45-minute Maunika Gowardhan episode on tandoori cooking is
  **PADDABLE**, and Naan Curry's 67-minute kebab episode is LOCATE-REQUIRED. The
  §4 verdict is superseded.
- **Mangal / kebab gains its first *ad-gated* candidate.** The Delicious Legacy's
  "Kokoretsi: The Ultimate Easter Kebab!" was the only kebab-adjacent food
  episode found in the *first* pass, and was rejected at 1.170. It is now
  authorable, LOCATE-REQUIRED. Be careful not to over-claim this one: the second
  pass found **52 mangal/kebab episode hits across 26 shows**, one of them
  directly on topic and measured **1.0000** (Gurmelik Denemeleri #13) — and that
  one was rejected on the **content** gate, which this ADR does not touch. So the
  tradition was never blocked *solely* by ads, and it is not solved now.

**Two traditions are unaffected, and that is the load-bearing negative:**
**braai** returns **zero episode-level hits** (braai / braaivleis / shisa nyama /
potjie) across all **7,237 crawled feeds** — the feed-level sweep of the full
4.71M-feed index did surface a handful of braai-named feeds, but they are a
5-episode show, an Afrikaans religion station, a business podcast and a society
chat show, none of them a source. **Filipino lechon** has no source at all.
Neither is an ad problem, so no ad tolerance touches them. They
are the case for a narrator (the second 2026-08-16 ruling, `DECISIONS.md`) and
nothing else will reach them.

**And the largest gain is not this Foray.** Stuff You Should Know (2,850 timed
transcripts) and Odd Lots (1,251) between them are half our free-transcript
inventory, and both are now sourceable. They need no ASR budget at all — only the
locate step. That reorders the funding case in `transcription-scale-plan.md` §6:
**the locate step is now competing directly with buying ASR capacity, and it
unlocks more episodes per dollar.**

## Decision

1. **Ad load is not a rejection reason at sourcing.** The content gate ("someone
   has to be *explaining* something") and transcript availability remain the only
   grounds for rejecting a source. Recorded ad-ratio rejections in
   `grilling-foray-sourcing.md` §4 and `catalogue-broadening.md` §3 are
   superseded.
2. **Measure the delta in seconds, per episode, over N ≥ 2 probes of the same
   episode, and take the MAXIMUM.** N = 1 bounds nothing — two probes of one
   Gastropod episode disagreed by 33.4 s. Keep the ratio as a cheap screen; it is
   comparable across neither episode lengths nor feeds that declare `length="0"`,
   and a median across different episodes cannot bound per-request variance at all.
3. **The threshold is 120 s**, equal to `ANCHOR_TIME_TOLERANCE_SEC`, and it is
   applied to the **pad** — `delta_max + margin`, where the margin is at least the
   observed spread between probes. `pad ≤ 120 s` → PADDABLE; otherwise
   LOCATE-REQUIRED. **The pad is an upper bound, never a point estimate**, because
   it controls the stop: a pad smaller than the listener's ad load truncates the
   payload, while a generous one only adds tail. Strictly this leaves headroom of
   `delta_max ≤ 86.6 s` at the one spread we have measured, and ~`60–80 s` if the
   margin scales with the delta (assumed, not measured — open question 3).
4. **`AD_FREE_THRESHOLD = 1.01` in `ad-inflation.mjs` stays as a label, not a
   gate.** It is the right constant for the question it was written to answer —
   "can this publisher's transcript timeline be trusted verbatim?" — and 1% still
   correctly excludes even a 30-second pre-roll. It is simply no longer a verdict
   on whether a show may be used.
5. **LOCATE-REQUIRED shows are authored, not played.** Extraction proceeds;
   playback waits for ADR-0007's fourth rung, whose search window is sized at
   `delta_max + margin` — the same upper bound, for the same reason, and the
   measurement that makes the locate step affordable at all (~12 min of audio
   rather than 47 for a 2-minute Stuff You Should Know segment). No segment is ever
   played at a position we cannot justify.
6. **Nothing in ADR-0007 relaxes.** DAI items still require both anchors,
   non-empty and verbatim. If anything this ADR makes that rule more
   load-bearing, because it is now the only thing standing between a heavy-DAI
   source and a bad cut.

## What this does not do

- **It does not make heavy-DAI shows playable.** Segments authored on any
  LOCATE-REQUIRED show — Stuff You Should Know, Odd Lots, This Podcast Will Kill
  You, Naan Curry, the BBC Food Programme, The Delicious Legacy, Hungry for History
  — **may land minutes away from their intended
  position until the locate step exists** — up to ~11 minutes on the worst
  measured show, which is several segment-lengths and can put a segment in an
  entirely different part of the episode. Today they will not play at all:
  `seekPrecision()` returns `approximate` and the segment is skipped. That is the
  correct behaviour and it is also the honest cost of this decision. Anyone
  tempted to ship a LOCATE-REQUIRED segment by loosening the drift check is
  choosing a bad cut over a skipped one; do not.
- **It does not promise an exact cut even in the PADDABLE tier.** A padded segment
  opens on extra run-up and closes on extra tail, by design, and the amount varies
  per download. And because the pad is bounded from our own samples rather than
  from the listener's request, a copy carrying more ad load than anything we
  probed is **truncated by however much it exceeds the pad** — and the one spread we
  have measured is 33.4 s, up to a third of a 110 s segment. Better than the
  alternative, and honest, but "PADDABLE" means *tolerably approximate* — which is
  what the ruling asked for — and never *frame-accurate*. The extra head can also
  land inside an ad pod if a break straddles the seek point.
- **It does not touch ad detection or ad skipping.** R11 permanently rejects
  automated ad detection and stripping. Nothing here identifies where an ad is;
  the locate step finds *content we already chose*, and the total-delta figure is
  an aggregate byte or duration comparison. That an ad falls outside a chosen
  segment stays incidental and is never a stated feature (product principle 3,
  #63 §3, the 2026-08-11 ruling). A framing that reads as "we removed the ads"
  triggers legal review.
- **It does not change the legal posture.** Playback remains seek-and-stop
  against the publisher's original prefixed enclosure. No derived audio artefact
  is produced, and padding a stop time produces none.
- **It does not change the length rules.** The 30 s floor, the 75–180 s band and
  §3f's sacrificial head are unchanged. The 120 s ceiling is partly *derived* from
  that band's **centre** (~110 s, reason 2 above), so if the centre of mass moves,
  revisit this threshold — not the band's 180 s top, which is a different number
  and never the basis for the pad.
- **It does not lower the content bar.** Every show unlocked here still has to
  pass the gate that rejected Culinary Connections, the Grill Coach and the Idle
  Talk Institute. A Taste of the Past being usable does not make it good; someone
  still has to read it.
- **It does not settle the English-only question.** Four newly-sourced
  traditions are non-English (`catalogue-broadening.md` §3); that is a separate
  standing ruling and this ADR neither helps nor hinders it.

## Open questions for Wyatt

1. **Which locate implementation gets funded** — windowed on-device ASR (the rung
   is named in ADR-0007, needs #29, window = `delta_max` + margin) or Chromaprint
   fingerprint alignment (cheaper per lookup, undesigned, and unusable for
   publisher-transcript segments)? They cover different halves of the catalogue,
   so "both eventually" is a real answer; the question is which first.
2. **Does the playback pad ship before the locate step?** It is what turns six
   shows from *authorable* into *playable*, and it is bounded — a per-episode
   `ad_delta_sec` (now: `delta_max`, spread and N), one new `FOREIGN` branch in
   `seekPrecision()`, and tests — but it is genuinely more than a constant change,
   because that branch does not exist yet (see above). The alternative is holding
   all injected shows out of playback until the locate step exists, which is safer
   and slower.
3. **How big is the margin, and does N stay at 2?** The margin is currently "at
   least the observed spread", justified by a single show's single pair of probes
   (33.4 s on a 33–66 s load). n=2 on one episode of one show is not a
   distribution. A third and fourth probe of Gastropod would cost two downloads
   and would tell us whether the spread is stable, growing, or worse than we think
   — and it is the cheapest way to find out whether "delta_max + spread" is
   generous or optimistic. **Recommend it before the second show is admitted**,
   because every future pad inherits this coefficient.
4. **Does the 120 s threshold need a founder number instead of a derived one?**
   It is derived from two existing constants and one existing band. Note the
   upper-bound rule has already halved its practical effect: admission now needs
   `delta_max ≤ ~60–80 s`, so the *effective* threshold is close to 60 s whether we
   choose it or not. If the editorial answer is that a 100-second pad on a 110-second
   segment — 91% of the segment, past reason 2's own alarm line — already reads as
   sloppy, say so and the number should come down
   explicitly rather than by arithmetic.
