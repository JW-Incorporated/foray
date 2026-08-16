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

**One further delta, and its provenance needs stating precisely, because a lot
below leans on it. Gastropod: +66 s.** That figure was **supplied to this session
alongside the ruling on 2026-08-16** and is **not otherwise recorded in this
repo**. The only Gastropod ad measurement on file is `1.080 — injected
(bitrate-implied)` (`grilling-foray-sourcing.md` §4), which on a 45-minute
episode would be ~216 s, so **the two do not reconcile on any plausible episode
length**. The bitrate-implied reading is the weaker method on a feed that declares
`length="0"`, and §7 of that document already lists Gastropod for
re-measurement — so +66 s is the more likely of the two to be right. But it is
an unreplicated number that contradicts the record, and this ADR does not treat
it as settled: **Gastropod is PADDABLE pending one confirming seconds-based
probe**, exactly like the other rows whose ratio does not decide them. Do not
ship a Gastropod segment before that probe.

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
| **PADDABLE** | max measured delta **≤ 120 s** | usable now: pad by the measured delta |
| **LOCATE-REQUIRED** | max measured delta **> 120 s** | author now, play once the locate step exists |

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
ads are a pre-roll or six mid-rolls. Above it, the distribution decides the
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
in the content (harmless run-up — §3f's sacrificial-head rule already wants
segments to open on run-up) but also stops `cum` seconds early, truncating the
payload, so the **stop** must be extended by the pad. At a 120 s pad on a 110 s
segment, the pad exceeds the thing it protects. Beyond that the "segment" is
just a region of episode with a hopeful name.

**3. The pad applied is the measured delta, not the ceiling.** Because we record
seconds per episode, Gastropod is padded by ~66 s, not by 120 s. The ceiling
gates; the measurement sizes. This keeps the editorial cost proportional to the
actual ad load instead of charging every show the worst case.

**Measure per episode, and summarise with the MAXIMUM.** Two constraints from
the existing data. Stuff You Should Know's own two episodes differ (+10.0 and
+8.4 min), and `grilling-foray-passages.md` §1 already insists on per-episode
measurement, "never per show". And `summariseShow()` in `ad-inflation.mjs`
returns a **median** — correct for classifying a show's behaviour, wrong for
this gate, which is a worst-case bound. The tier is set by the max over probes
(minimum two), because the listener's copy is stitched independently of ours and
their load is not guaranteed to be our median.

**Recorded-number reconciliation, kept honest.** Gastropod is recorded at
**1.080 bitrate-implied** in `grilling-foray-sourcing.md` §4, and its measured
delta is **+66 s**. Those two do not reconcile on any plausible episode length —
1.080 would be ~3.5 min on a 45-minute episode. The ratio came from the weaker
bitrate-implied method on a feed that declares `length="0"`, and §7 of that same
document already lists Gastropod for re-measurement. **The seconds measurement
supersedes the ratio**, and this disagreement is itself the argument for option 3
over option 2.

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
  total delta wide.** For a 2-minute segment on a Stuff You Should Know episode
  that is ~12 minutes of audio to transcribe instead of 47 — a 3–4× saving. So
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
3. **Record the delta in seconds, per episode, alongside the ratio.** The 2-byte
   ranged GET already yields the bytes; the seconds follow from the per-episode
   bitrate that `grilling-foray-passages.md` §1 already corroborates.
4. **Rely on the existing honest-failure path for anything unplayable.** An
   authored segment boundary is `FOREIGN` by ADR-0007's own definition, and
   `seekPrecision()` as it stands today returns **`approximate` for any
   `dai_suspected` item on a foreign timeline, unconditionally** — it does not
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
be extended by the recorded delta; and `seekPrecision()` needs a **`FOREIGN`
branch that consults a recorded per-episode `ad_delta_sec`**, which does not
exist today — the function currently returns `approximate` for every foreign DAI
timestamp without looking at durations at all, and its `DRIFT_TOLERANCE_SEC = 30`
comparison lives only on the `OWN` branch. So this is not "widen a constant": it
is implementing the third rung of ADR-0007's ladder for foreign timestamps, with
the tolerance keyed to the segment's measured delta rather than to 30 s. Still
bounded — one field on the segment record, one branch, and tests — and
deliberately not built in this PR. Note the 30 s constant itself should **not** be
widened: it guards the listener's own marker against their own copy, which is a
different question with a correct answer already.

**Waits for the locate step (>120 s):** playback of anything in the
LOCATE-REQUIRED tier, which is where Stuff You Should Know, Odd Lots, This
Podcast Will Kill You, the BBC Food Programme, The Delicious Legacy and Naan
Curry all sit. Authoring does not wait; playing does.

## The unlock, quantified

Reasoned from the recorded measurements in the two sourcing documents; **no new
scan was run.** For a show recorded only as a ratio, the delta in seconds is
`(r − 1) × program_length`, so each ratio has a **break-even length** —
`120 ÷ (r − 1)` — above which its episodes cross the threshold. That converts
every recorded ratio into a decision without a single new fetch.

*Read the break-even column as **ad-free program minutes**, i.e. the length the
feed declares, not the length of the file you would download.* Since
`ratio = delivered ÷ declared`, the denominator is the program, and for a heavily
injected show the two differ by exactly the quantity under discussion — a
67-minute declared episode delivering 70 minutes is the same row, not a
contradiction.

| Show | recorded | break-even length | episode length | tier |
|---|---|---|---|---|
| Gastropod | **+66 s** (supplied with the ruling; repo records 1.080 bitrate-implied — see § Context) | — | — | **PADDABLE pending one confirming probe** |
| A Taste of the Past | 1.020 | 100 min | *est.* ~35–45 min | **PADDABLE** unless > 100 min |
| Proof (America's Test Kitchen) | 1.028 (bitrate-implied) | 71 min | *est.* ~30–40 min | **PADDABLE** unless > 71 min |
| olive (Immediate Media) | ~1.02 (bitrate-implied) | 95–100 min | **45 min** (recorded) | **PADDABLE** |
| El Mundo en un Bocado | 1.0159 | 126 min | **47 min** (recorded) | **PADDABLE** |
| The Fantastic History Of Food | 1.043 | 46.5 min | unrecorded | **genuinely undecided** — one probe settles it |
| Naan Curry with Sadaf and Archit | 1.0470 | 42.6 min | **67 min** (recorded) | LOCATE-REQUIRED |
| Grill This! | 1.073 | 27.4 min | unrecorded | **undecided** — LOCATE-REQUIRED unless < 27 min |
| BBC The Food Programme | 1.099 | 20.2 min | *est.* ~28 min (R4 slot) | LOCATE-REQUIRED |
| The Delicious Legacy | 1.170 | 11.8 min | unrecorded — irrelevant, see below | LOCATE-REQUIRED |
| Hungry for History | 1.461 | 4.3 min | unrecorded — irrelevant | LOCATE-REQUIRED |
| Stuff You Should Know | **+8 to +10 min measured** | — | 37–47 m (recorded) | LOCATE-REQUIRED |
| Odd Lots | **+8.8 to +10.7 min** | — | 60–66 m (recorded) | LOCATE-REQUIRED |
| This Podcast Will Kill You | **+8.0 min** | — | 73–79 m (recorded) | LOCATE-REQUIRED |

**Six shows move to PADDABLE (two on recorded numbers alone, two on estimates
with wide margins, one pending a confirming probe, one genuinely undecided);
eight move to LOCATE-REQUIRED, one of those eight still undecided.** Of the
fourteen rows, **eleven were flat rejects** on ad ratio; the other three (Stuff
You Should Know, Odd Lots, This Podcast Will Kill You) were never in a sourcing
rejection table — they were routed to ASR instead, because
`transcription-scale-plan.md` §4 concluded "route 2 is dead and ASR is the path
for injected shows." This ADR gives them a third option that costs no ASR at all.

**Which rows are safe without a new measurement, and which are not — stated
explicitly, because this is the part that is easy to over-claim:**

- **Safe on numbers recorded in this repo:** olive and El Mundo en un Bocado and
  Naan Curry (recorded episode durations), plus Stuff You Should Know, Odd Lots
  and This Podcast Will Kill You (deltas measured from full downloads). The
  Delicious Legacy and Hungry for History are also safe *without* a duration,
  because their break-even lengths (11.8 and 4.3 min) are below any plausible
  episode — the tier holds whatever the length turns out to be. Same logic in
  reverse does not apply anywhere.
- **Safe only on a number supplied with the ruling:** Gastropod. Its +66 s is not
  recorded in this repo and contradicts the 1.080 bitrate-implied reading that is
  (see § Context). One confirming probe, then it is the cleanest row in the table;
  until then it is the least settled.
- **Marked `est.` = an episode length that is NOT recorded in this repo.** Those
  three rows (A Taste of the Past, Proof, BBC The Food Programme) rest on an
  outside-repo expectation of typical episode length, and each has a wide margin
  — A Taste of the Past would have to run past 100 minutes to change tier. They
  are still estimates and are labelled as such. **Confirm with one 2-byte probe
  plus `itunes:duration` before a segment from them ships.**
- **Undecided:** The Fantastic History Of Food (break-even 46.5 min) and
  Grill This! (27.4 min) sit close enough to plausible episode lengths that the
  ratio genuinely does not decide them. One probe each.
- **Two PADDABLE rows carry a caveat inherited from the source docs:** Proof and
  olive are **bitrate-implied** measurements on `length="0"` feeds, and olive's
  ~1.02 is the recorded reading of "delivered bytes imply 163.4 kbps against a
  160 kbps encode". Both need the seconds-based re-probe before a segment ships —
  cheap, and specifically what §7 of the sourcing doc already asked for.

None of this changes the count that matters: **no show in the table is rejected
any more, and the work needed to settle every open row is a handful of 2-byte
requests.**

### What this does to Foray #1's arc

Against the eight arc slots in `grilling-foray-passages.md` §3, which currently
hold **8 passages / 8:21 total** across 5 slots:

| Arc slot | Before | After the relaxed gate |
|---|---|---|
| Fire and the origins of cooking | partial, 2:06 — counterpoint only; the cooking hypothesis is in Origin Stories, which publishes no transcript | **Gastropod becomes a candidate for the arc's opening slot, without ASR.** Two things to verify first, neither recorded in this repo: the +66 s delta (§ Context) and the episode itself — *"Out of the Fire, Into the Frying Pan"* (prehistoric origins) was named with the ruling, and the only Gastropod episode on file here is *"Where There's Smoke, There's… Whiskey, Fish, and Barbecue!"*. Confirm both with one feed fetch |
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
2. **Measure the delta in seconds, per episode, and summarise with the maximum**
   over at least two probes. Keep the ratio as a companion; it is comparable
   across neither episode lengths nor feeds that declare `length="0"`.
3. **The threshold is 120 s**, equal to `ANCHOR_TIME_TOLERANCE_SEC`. ≤ 120 s →
   PADDABLE, and the pad applied is the *measured* delta, not the ceiling.
   > 120 s → LOCATE-REQUIRED.
4. **`AD_FREE_THRESHOLD = 1.01` in `ad-inflation.mjs` stays as a label, not a
   gate.** It is the right constant for the question it was written to answer —
   "can this publisher's transcript timeline be trusted verbatim?" — and 1% still
   correctly excludes even a 30-second pre-roll. It is simply no longer a verdict
   on whether a show may be used.
5. **LOCATE-REQUIRED shows are authored, not played.** Extraction proceeds;
   playback waits for ADR-0007's fourth rung. No segment is ever played at a
   position we cannot justify.
6. **Nothing in ADR-0007 relaxes.** DAI items still require both anchors,
   non-empty and verbatim. If anything this ADR makes that rule more
   load-bearing, because it is now the only thing standing between a heavy-DAI
   source and a bad cut.

## What this does not do

- **It does not make heavy-DAI shows playable.** Segments authored on Stuff You
  Should Know, Odd Lots, This Podcast Will Kill You, the BBC Food Programme, The
  Delicious Legacy or Naan Curry **may land minutes away from their intended
  position until the locate step exists** — up to ~11 minutes on the worst
  measured show, which is several segment-lengths and can put a segment in an
  entirely different part of the episode. Today they will not play at all:
  `seekPrecision()` returns `approximate` and the segment is skipped. That is the
  correct behaviour and it is also the honest cost of this decision. Anyone
  tempted to ship a LOCATE-REQUIRED segment by loosening the drift check is
  choosing a bad cut over a skipped one; do not.
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

1. **Which locate implementation gets funded** — windowed on-device ASR (designed
   in ADR-0007, needs #29, window = total delta) or Chromaprint fingerprint
   alignment (cheaper per lookup, undesigned, and unusable for
   publisher-transcript segments)? They cover different halves of the catalogue,
   so "both eventually" is a real answer; the question is which first.
2. **Does the playback pad ship before the locate step?** It is what turns six
   shows from *authorable* into *playable*, and it is bounded — one field
   (`ad_delta_sec`), one new `FOREIGN` branch in `seekPrecision()`, and tests —
   but it is genuinely more than a constant change, because that branch does not
   exist yet (see above). The alternative is holding all injected shows out of
   playback until the locate step exists, which is safer and slower.
3. **Does the 120 s threshold need a founder number instead of a derived one?**
   It is derived from two existing constants and one existing band. If the
   editorial answer is that a 60-second pad already reads as sloppy, the
   threshold should be 60 s and this ADR should say so.
