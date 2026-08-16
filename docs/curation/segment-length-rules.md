# Segment length and cut-frequency rules

How long a Foray segment may be, how often a Foray may cut, and which of those
rules a machine can check.

Companion to `docs/adr/0007-segment-anchoring.md` (how a boundary is
represented) and `docs/curation/segment-extraction-pipeline.md` (how segments
get authored). Those two answer *where* a boundary goes and *how it survives*.
This one answers *how far apart the boundaries may be*.

Written against the founder question, 2026-08-15:

> "We should be critical about how short of a segment can be used — if it jumps
> around repeatedly that's super annoying, but also the whole point is to not
> have to listen to someone blab about nonsense."

**Status:** proposed. Numbers below are the recommendation; the ones marked
*(judgement)* are calibration knobs the founders can move without breaking the
scheme. The ones marked *(derived)* fall out of constraints already committed
elsewhere in the repo, and moving them means moving those.

---

## 0. TL;DR — the numbers

| | value | kind |
|---|---|---|
| Hard floor, any segment | **30 s** | derived |
| Payback rule | `duration ≥ 4 × (bridge + 1 s) + 4 s` | judgement (the 4×) |
| Sacrificial head | first **~4 s** carries nothing load-bearing | **evidenced** (§2a) |
| Target band | **75–180 s**, centre ~110 s | derived + convergent precedent |
| Soft maximum | **240 s** → `needs_review`, must state what the extra minutes do | judgement |
| Hard maximum | **480 s** (narrative/exchange), 360 s (explanation), 90 s (quote) | judgement |
| Relative maximum | **≤ 20 %** of the source episode's duration | judgement |
| Cut budget, rolling 10 min | **≤ 8 / 6 / 5** starts for Forays ≤ 45 min / 45–120 min / > 120 min | judgement |
| Burst rule | at most **2** consecutive segments < 60 s; the third must be ≥ 150 s | judgement |
| **Anti-uniformity** | no 3 consecutive segments within ±20 % of each other | **evidenced** (§2d) |
| Whole-Foray mean | mean segment duration **≥ 90 s** | judgement |
| Same-episode merge | elided gap **< 45 s → must merge**; 45–180 s → should merge | judgement |
| Same-episode seam silence | **≥ 2.0 s** where narration is not used | convention (audiobook standard) |
| Same-episode order | **never non-chronological** | integrity, not taste |

Two findings most likely to be missed:

- **Uniform segment length is itself a defect.** The founder's word was
  "repeatedly," and it is doing more work than "jumps." §2d.
- **Cut cost does not amortise.** The orienting response to a voice change was
  measured not to habituate across repetitions in a distracted listener — which
  is Foray's whole listening context. There is no "they'll settle into the
  rhythm." That is why the answer is a *budget* and not just a floor. §2a.

---

## 1. The tension is real, but it is two budgets, not one

The founder's sentence names two failures and the instinct is to fix both with
one number. That does not work, and it is worth being explicit about why before
proposing any numbers at all.

- **"Jumps around repeatedly"** is a complaint about **cut frequency**. Twelve
  20-second segments and two 120-second segments both fill four minutes. Only
  one of them is a montage. A minimum segment length does constrain cut
  frequency, but only weakly and only at the bottom: a Foray made entirely of
  segments at exactly the minimum is the montage, and every segment in it passes.
- **"Blab about nonsense"** is a complaint about **filler density** — signal per
  second inside a segment. A four-minute segment can be four minutes of a
  careful explanation or three minutes of throat-clearing wrapped around one
  good sentence. A maximum length constrains the worst case and nothing else.

So the scheme below has four instruments, not one:

1. a **floor** on segment length, which buys re-orientation and payback;
2. a **ceiling**, which caps how much unedited conversation we are willing to
   claim is dense;
3. a **rolling cut budget**, which is the actual answer to "jumps around";
4. a **self-containment gate**, which is the actual answer to "is this a
   segment or a fragment" — and which is the rule the length floor is only a
   proxy for (§7).

One more thing that shapes everything below: Foray is not a clip app. Every cut
in a Foray is *bridged by narration* (`docs/brief/04_VOICE_AUDIO_SPEC.md`:
transition TTS ≤ 8 s, ~0.5 s of silence padding around TTS items). That bridge
is a real asset — it pre-loads the listener's mental model before the new voice
arrives — and a real cost, because it is time the listener spends not hearing
the thing they came for. Both facts drive numbers below, and both are why our
minimum lands *above* the single-clip precedents and our target *below* the
topic-block literature.

---

## 2. Evidence

Sources are the local research corpus first (`docs/research/corpus/digests.md`,
and full-text search on the machine that built the DB), then the repo's own
committed decisions, then the web. Where a number is craft convention rather
than a measurement, it says so.

### 2a. Re-orienting to a new voice, room and topic

A hard cut to a different episode starts several clocks at once, and they are an
order of magnitude apart. Keeping them separate is what stops the "listeners
need N seconds to adjust" folklore from becoming a number in a validator.

| what happens | how long | evidence quality |
|---|---|---|
| the listener *notices* the discontinuity | ~300 ms | solid (N400, 300–500 ms window) |
| auditory attentional blink | 200–500 ms | real but **contested for voices**, and an order of magnitude too short to matter here |
| auditory stream re-stabilisation | **τ ≈ 3.84 s** | solid — the only fitted constant in this literature |
| comprehension recovery after a talker switch | **one sentence**, recovering by the 3rd word (~1.5 s) | solid, directly measured |
| orienting response to a voice change in radio | measured over a **6–10 s** window | solid, and see the non-habituation finding below |
| adaptation to an unfamiliar voice/accent | **12–18 sentences (~45–90 s)** | solid, but this is *accented* speech, so an upper bound |
| top-level situation model of a new topic | paragraph scale, **~30–40 s** | moderate, genuinely contested |

Six things worth pulling out.

**1. The strongest number is ~4 s, and it comes from two unrelated
literatures.** Beauvois & Meddis (1997) fitted an exponential decay constant of
**τ = 3.84 s** for auditory stream biasing (musicians 7.84 s, non-musicians
1.42 s). Independently, Lin & Carlile (2015) measured comprehension across a
talker switch in simulated conversational turn-taking and found the cost lands
almost entirely on **the single sentence after the switch** — recall on that
sentence falls **71.6 % → 51.9 %**, a 10.7 % overall word-recall decrease and
6.9–9.2 % comprehension cost — with within-sentence recovery arriving by about
the third word. One sentence is ~10 words is ~3.5 s at podcast rates.

**2. So a segment has a sacrificial head of about 4 seconds.** This is the most
actionable finding in this document and it is a *boundary-placement* rule, not a
length rule: **put no load-bearing content in the first ~4 s of a segment.**
Start the cut roughly a sentence *before* the sentence you actually want. See
§3f.

**3. Every cut pays full price. The listener does not get used to it.** Wang et
al. (2019) measured the cardiac orienting response to an instantaneous voice
change in radio content over a 6–10 s post-onset window, and found it **did not
habituate across five repetitions** when listeners were doing something else —
which is Foray's entire listening context (driving, chores). This is the single
most important finding for §5c: **the cost of cutting is linear in the number of
cuts, not amortised over the Foray.** It removes the best available argument
*against* a cut budget ("they'll settle into the rhythm"). They do not.

**4. The talker-change cost is real but small, and the folklore version is
wrong.** Mullennix, Pisoni & Martin (1989) measured a **~70 ms** naming-latency
penalty for a talker change (608 → 678 ms) and an identification drop of 68.3 %
→ 58.9 % at +10 dB SNR. The widely repeated "word identification is ~20 % lower
with multiple talkers" is a misreading — the measured overall gap is **6.7
percentage points**. Do not use 20 %. McLaughlin et al. (2023) show via
pupillometry that switch costs are additive (across-accent > within-accent >
no-switch), landing at *sentence* granularity — which matters for us because a
cross-episode cut changes talker, room, mic chain and topic simultaneously.

**5. Full voice adaptation takes ~1 minute, but we do not need full
adaptation.** Clarke & Garrett (2004) and Xie et al. (2018) put accent
adaptation at **12–18 sentences / under a minute**. That is *accented* speech,
i.e. the hard case, and it is the number that would justify a 60 s floor if you
took it at face value. Do not: podcast hosts are not accented relative to their
audience, and Lin & Carlile shows the comprehension penalty is gone after one
sentence even without adaptation. Treat ~1 min as the ceiling of this effect,
not its centre.

**6. Topic integration wants ~30–40 s, and that claim is contested.** Lerner et
al. (2011) scrambled a story at word/sentence/paragraph scale and found parietal
and frontal areas respond reliably **only when intact paragraphs are heard in a
meaningful sequence**; the visual analogue (Hasson et al. 2008) puts the
hierarchy at 4 ± 1 s / 12 ± 3 s / **36 ± 4 s**. But Blank & Fedorenko (2020)
found no evidence for differing temporal receptive windows across fronto-temporal
language regions, and a 2024 *Nature Human Behaviour* paper re-finds them at the
population level. **Use ~30–40 s as a planning number, not a settled fact.** It
is nonetheless the one perceptual line that lands near our floor, and it lands
there from a completely different direction than §3a's arithmetic.

**What this does *not* support.** It does not support a floor anywhere near 60 s
on perceptual grounds, and it would be dishonest to claim it does. The
re-orientation tax is **seconds, front-loaded, and mostly gone after one
sentence.** The reason Foray's floor is 30 s and not 10 s is §3a's payback
arithmetic and §2b's format argument, not this table. What this table does is
(a) fix the sacrificial head at ~4 s, (b) establish that cut cost does not
amortise, and (c) rule out the folklore numbers.

**Folklore flagged and rejected:**
- The ubiquitous "**4–10 s streaming buildup**" is a citation cluster, not a
  fitted constant; the actual fitted constants are *smaller* (1.4–7.8 s).
- "**Multiple talkers cost 20 % of word identification**" — no, 6.7 points.
- Magnuson & Nusbaum's (2007) talker-**expectation** effect **failed a
  preregistered replication** (costs −2 to +7 ms, all n.s.). Do not build on it.
- "**~150 wpm average conversation**" traces to a single non-peer-reviewed web
  page recycled through voiceover calculators. Corpus measurement (Yuan,
  Liberman & Cieri 2006, Switchboard/Fisher/CallHome) gives **196 wpm gross,
  164 wpm turn-wise, 111–291 wpm across conversations**. Our own corpus implies
  ~170 wpm for podcasts independently (TREC's 120 s segments averaging 340
  words), which sits inside that range — **so this document uses 170 wpm and
  treats it as an estimate, not a constant.** There is no published absolute wpm
  mean for podcasts; the one academic analysis of the Spotify podcast dataset
  reports only relative findings.

**Sources:** Beauvois & Meddis 1997, *Perception & Psychophysics* 59(1), https://link.springer.com/article/10.3758/BF03206850 ·
Lin & Carlile 2015, *Front. Neurosci.* 9:124, https://www.frontiersin.org/articles/10.3389/fnins.2015.00124 ·
Wang et al. 2019, *Journal of Cognition*, https://journalofcognition.org/articles/10.5334/joc.43 ·
Mullennix, Pisoni & Martin 1989, *JASA* 85(1), https://pmc.ncbi.nlm.nih.gov/articles/PMC3515846/ ·
McLaughlin et al. 2023, *Psychon Bull Rev*, https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10867039/ ·
Clarke & Garrett 2004, *JASA* 116(6), https://pubmed.ncbi.nlm.nih.gov/15658715/ ·
Xie et al. 2018, *JASA*, https://pmc.ncbi.nlm.nih.gov/articles/PMC5895469/ ·
Lerner et al. 2011, *J Neurosci* 31(8), https://www.jneurosci.org/content/31/8/2906 ·
Hasson et al. 2008, *J Neurosci* 28(10), https://www.jneurosci.org/content/28/10/2539 ·
Blank & Fedorenko 2020, *NeuroImage* 219, https://escholarship.org/uc/item/4kz9d7v0 ·
Denham et al. 2012, *Front. Psychol.* 3:461, https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2012.00461/full ·
Yuan, Liberman & Cieri 2006, Interspeech, https://www.isca-archive.org/interspeech_2006/yuan06_interspeech.html ·
failed replication of Magnuson & Nusbaum 2007, https://pmc.ncbi.nlm.nih.gov/articles/PMC8096357/

**Caveat the founders should hear:** none of this literature tested Foray's
actual stimulus. The closest (Lin & Carlile) switches talker and location but
holds topic constant. The floor below is an inference stacked across four
literatures plus an arithmetic argument — **not a measurement.** A 20-listener
A/B on 15 s / 30 s / 60 s segments measuring post-segment comprehension would
beat every citation in this section, and would cost a day.

### 2b. Why the radio soundbite numbers do not transfer, and the product question hiding in that

This is the place to be most careful, because there is a well-established
professional answer to "how short can an audio excerpt be" and **it is much
shorter than anything recommended in this document.**

| source | number | kind |
|---|---|---|
| NPR Training, "Soundbite essentials" (2026) | *"Ideally, a soundbite should be between 5–15 seconds"* | house style |
| Radio newswriting convention ("actuality") | 10–20 s typical; 8–20 s in J-school glossaries, up to ~30 s on national networks | convention |
| Poynter, on veteran radio reporter Peter King | whole pieces ≤ 26 s; soundbites *"not even two seconds long"* | practitioner report |
| Hallin (1992), *Journal of Communication* 42(2) | US network election soundbite fell **43.1 s (1968) → 8.9 s (1988)** | measured |
| Donsbach & Jandura (2003), via secondary | German TV soundbites average **~20 s** in the same era | measured |

The Hallin series is the useful one precisely because it is measured: it shows
the 9-second soundbite is **an artefact of one medium's incentives**, not a
perceptual constant. Germany's number is more than double the US's for the same
content type in the same decade. Nobody should read "9 seconds" as a finding
about human comprehension.

More importantly, all of these numbers describe **tape inside a narrated
piece**. The published baseline mix for a radio feature is roughly *"50 percent
copy (the reporter's words) and 50 percent tape"* (B-Side Radio). In that
architecture the reporter carries the argument and the tape is evidence for it.
A 12-second actuality works because 12 seconds of setup preceded it.

**Foray inverts that ratio, and the inversion is the product.** The whole point
is that you hear the people who know the thing, not a narrator summarising them.
The target mix is closer to 90/10 tape-to-narration. Run the arithmetic: a Foray
built on 15-second segments with the spec's ≤ 8 s bridges is **a third
narrator** (8 s of machinery per 24 s of elapsed time). That is not a Foray with short segments; that is a different format
— a narrated audio essay illustrated with clips.

**So this is a founder-facing product question, not an engineering one, and it
should be answered deliberately rather than fallen into:**

> Is Foray tape-forward (long segments, thin bridges, ~90/10) or narrator-forward
> (short segments, substantial bridges, ~50/50)? Radio has spent eighty years
> perfecting the second one. This document assumes the first, because #63's
> framing — *"an ordered argument; each segment earns its place"* — and the
> founder's *"not have to listen to someone blab"* both point that way. **If the
> answer is narrator-forward, every number below drops by roughly half and the
> document needs rewriting, not tuning.**

Two more precedents worth having in front of you, both cutting the same way:

- **The clip-app graveyard.** Synth built a whole app on 256-second soundbites;
  Shuffle on a swipeable feed of short clips; Podz on ML-generated 60-second
  clips. All dead (`docs/research/corpus/digests.md` #44,
  `docs/marketing/01-competitive-landscape.md`). This is weak evidence about
  *length* — they died of format, discovery and business model, not of clip
  duration — but it is strong evidence that the short-clip end of the space is
  well-explored and unrewarding, which is a reason to bias long when uncertain.
- **Snipd, the one that lived, punted on the number entirely.** Its snip
  boundaries default to "Auto" — AI-chosen start/end, described as *"the
  preferred option as it will try to find the best start/end point"* — with
  fixed-length as the fallback. The company that has iterated hardest on this
  exact problem shipped **content-aware boundaries as the default and a fixed
  duration as the degraded mode.** That is §7's argument, from a competitor's
  shipped product.

**Sources:** NPR Training, https://www.npr.org/sections/npr-training/2026/01/26/g-s1-104552/sound-bites-choose-good-audio-clips ·
Hallin 1992, https://academic.oup.com/joc/article/42/2/5/4210041 ·
newscript.com glossary, http://newscript.com/glossary.html ·
Poynter, https://www.poynter.org/reporting-editing/2007/tuesday-edition-veteran-radio-reporter-shares-secrets-to-writing-short/ ·
B-Side Radio, http://bsideradio.org/writing-a-radio-script/ ·
Snipd, https://support.snipd.com/en/articles/11926947-snip-customizations

### 2c. What a "segment" is sized at when someone has to define one

| source | unit | note |
|---|---|---|
| Podcast Namespace `<podcast:soundbite>` | *"recommended between 15 and 120 seconds"* | the ecosystem's own standard for a publisher-authored highlight |
| TREC 2020 Podcasts Track | fixed **120 s** windows, 60 s overlap, avg 340 ± 70 words | graded on being *"a good entry point for a human listener"* |
| IAB Podcast Measurement v2.2 | **60 s** minimum download that counts | *"One minute was chosen as a conservative minimum size since other mediums use similar or smaller thresholds"* |
| Spotify ad tiering | listening counted above **60 s** | the industry's "a listen happened" unit |
| Overcast clip sharing (2019.4) | hard **60 s** cap | Arment's post gives ecosystem reasoning, **not** a fair-use or perceptual one; the widely-repeated "fair use" explanation is secondary attribution we could not verify in his words |
| Spotify Clips | > 3 s and < 30 s | platform format spec |
| Audible Clips (2016) | grabs preceding 30 s, max ~44 s | sharing later quietly removed |
| TreeSeg (arXiv 2407.12028) | enforces a minimum segment size (five utterances) | note: the "3–15 minute candidate clips" line in our own digest #7 is *our gloss*, not a number from the paper |

The 120 s figures are the most transferable, because TREC's segments were judged
by human assessors specifically on whether they were a sensible place to start
listening — which is exactly the question a Foray segment has to pass once per
segment, dozens of times per Foray.

**Sources:** `docs/research/corpus/digests.md` #5, #6, #7, #12, #32, #43, #44 ·
Podcast Namespace soundbite tag, https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/soundbite.md ·
Spotify Clips, https://support.spotify.com/us/creators/article/clips/

### 2d. Uniformity is the defect. This is the most useful finding here.

Two independent lines, one measured and one craft, say the same thing:

- **Measured.** Cutting, DeLong & Nothelfer (2010), *Psychological Science*
  21(3), analysed shot lengths in 150 films, 1935–2005, and found shot durations
  became increasingly correlated with their neighbours, giving a power spectrum
  approaching **1/f** — the spectral signature of human attention fluctuation.
  Their claim is that it is the 1/f *structure* of shot lengths, not their
  shortness, that holds attention. A sequence in which every unit is the same
  length is spectrally flat (white), not 1/f. The related 2011 dataset (160
  films) puts average shot length at ~10 s in the 1930s–40s falling below 4 s
  after 2000, with an extreme low of 2.2 s (*Rocky IV*) — i.e. even the fastest
  mass-audience film averages above two seconds, sustained.
- **Craft.** A radio scripting guide states it flatly: *"A series of 20-second
  acts interspersed with 10-second tracks will get pretty monotonous."*
  Transom's *Art of the Radio Feature* makes the same point about timbre rather
  than time: *"Vary the texture. A deep gravelly voice is easy to distinguish
  from a high fluty one… The feel of a voice can be just as important as what it
  has to say semantically."*

**This reframes the founder's complaint.** "If it jumps around **repeatedly**" —
the load-bearing word is *repeatedly*. A montage is not annoying because it cuts;
it is annoying because it cuts *at a constant rate*, which is both perceptually
flat and audibly mechanical. It sounds like a machine made it, because one did.

Two rules follow, and neither is a length limit:

1. **Anti-uniformity (§5c, rule D5).** No three consecutive segments within
   ±20 % of each other's duration. Cheap, mechanical, directly implements the
   finding.
2. **Sequence by voice contrast, not only by duration (§6d).** Two segments of
   identical length feel choppier when the two speakers sound alike than when
   they contrast. This is a real lever on the "jumps around" complaint that has
   nothing to do with clocks, and the extraction pipeline is already positioned
   to capture it — `transcript-normalize.mjs` surfaces a `speaker` field.

It also promotes the burst rule from a grudging exception to a positive
requirement: clustered short segments followed by a long one is the *shape the
evidence recommends*, not a tolerance.

**Sources:** Cutting, DeLong & Nothelfer 2010, https://journals.sagepub.com/doi/10.1177/0956797610361679 ·
Cutting et al. 2011, *i-Perception* 2(6), https://pmc.ncbi.nlm.nih.gov/articles/PMC3485803/ ·
B-Side Radio, http://bsideradio.org/writing-a-radio-script/ ·
Transom, https://transom.org/2022/the-art-of-the-radio-feature/

### 2e. How long a seam needs to be to read as an edit

The only published number for "how much silence tells a listener they have moved
somewhere else" comes from audiobook narration standards: **2.5 s** after a
chapter announcement, and **2–3.5 s** (commonly 2–2.5 s) for a mid-chapter
section break — explicitly including the case where the text gives no visual
cue, *"you may need to add this transitional silence to alert the listener of a
scene change."* ACX's technical spec separately requires 0.5–1 s of room tone at
the head of a file and 1–5 s at the tail.

`docs/brief/04_VOICE_AUDIO_SPEC.md` currently specifies ~0.5 s of padding around
TTS items. That is right for *joining* audio and too short for *marking an
edit*. §6b therefore asks for ≥ 2.0 s where a same-episode seam is left
unbridged. This is convention, not measurement, but it is the only convention
anyone has written down.

**Source:** Narrators Roadmap, https://www.narratorsroadmap.com/standards-for-silence-in-the-book/

### 2f. The seam is also a loudness event

AES TD1004.1.15-10 warns that inserting externally-produced material into a
program can produce loudness jumps *"of up to 7 LU, which is outside the comfort
zone of most"* listeners, and recommends short-form content (60 s or less) be
handled with its own loudness constraint rather than measured like a program.
Every cross-episode seam in a Foray is exactly that insertion — two
independently-mastered shows butted together. This is a cost of cutting that has
nothing to do with comprehension and it scales with cut count, which is another
argument for the rolling budget in §5c.

**Source:** `docs/research/corpus/digests.md` #12.

### 2g. An editing-ethics constraint, not an aesthetic one

RTDNA's video and audio editing guidance speaks directly to sequencing audio
from different times and places:

> *"Don't add sounds that you obtained at another scene or from another time or
> place if adding the sounds might mislead the audience… This goes further than
> never invent or make things up, for it also encompasses rearranging sounds in
> time or place."*

A Foray is, structurally, cross-source juxtaposition. Two segments played back to
back can imply a dialogue, an agreement or a rebuttal that never happened —
especially with a narrator between them saying something that sounds like it
connects them. The mitigations are cheap and belong in the rules:

- Same-episode segments never play out of chronological order (§6c).
- Each cross-episode bridge **names its source** — who is speaking and where
  it's from. This is already the natural content of a bridge, so it costs
  nothing; the point is that it is a requirement rather than a style preference.

**Source:** RTDNA, https://www.rtdna.org/video-and-audio-editing

### 2h. What we could not find, and should not pretend to have

- **Podcast listener drop-off by segment structure: no credible public data.**
  Every circulating figure ("20–35 % drop in the first five minutes," "aim for
  70 % completion") traces to vendor marketing blogs with no methodology and no
  sample, citing each other. Neither Spotify nor Apple publishes aggregate
  retention benchmarks. If we want this, we measure it ourselves.
- **BBC Academy / College of Journalism guidance is not publicly retrievable.**
  Do not accept a "the BBC says N seconds" citation without a URL.
- **No audio-specific supercut/montage pacing rule exists in the literature.**
  Film shot-length research (§2d) is the only quantitative anchor available, and
  it is an analogy, not a transfer.
- **The 2–3 s "subjective present" (Pöppel)** is often cited as a perceptual
  binding window and is genuinely contested — a critical review concludes most
  findings are *not* consistent with the hypothesis. It is suggestive of a floor
  far below anything we would ship, so it does not affect these numbers either
  way. Mentioned so nobody re-derives it as a discovery.

---

## 3. The minimum

**Hard floor: 30 s. No segment below this enters a Foray, in any role, in any
density mode.**

Three arguments converge on roughly this number, and it is worth keeping them
separate because they fail in different circumstances.

### 3a. The payback argument (derived, and the strongest)

A cut is not free. Its cost, in wall-clock time the listener spends on
machinery rather than content, is already fixed by a committed spec:

```
transition cost = bridge TTS (≤ 8 s)  +  padding (2 × ~0.5 s)  ≈ up to 9 s
```

That is before any perceptual re-orientation cost. A 20-second segment
introduced by a 7-second bridge plus a second of padding costs 28 s of
wall clock to deliver 20 s of content — **29 % machinery**. That is not a Foray;
that is a narrator reading a list with illustrations.

So the load-bearing rule is not a bare minimum, it is a **ratio**:

> **Payback rule.** `duration_sec ≥ 4 × (bridge_sec + 1) + 4`
>
> The trailing `+ 4` is the sacrificial head from §2a — the first ~4 s of a
> segment is re-orientation, not content, so it belongs on the machinery side of
> the ledger, not the payback side.

Ignoring the head for a moment: at 4×, transition machinery is exactly 20 % of
elapsed time (machinery `b+1` against elapsed `5(b+1)`). At 3× it is 25 %; at
2×, a third of the Foray is the narrator. **The constant 4 is a judgement
call** — the founders can move it — but the *shape* is not: the minimum length
of a segment should be a function of the length of its own bridge, because those
are the two halves of the same trade.

Worked: a maximum-length 8-second bridge demands a **40-second** segment. A
terse 3-second bridge ("Same question, different answer — here's Whyte.")
demands 20 s, at which point the 30 s floor binds instead. **This coupling is a
feature.** It means short segments are not forbidden, they are *expensive* —
they buy their way in by having a short bridge, which in practice means they are
closely related to what came before and need little setup. That is exactly the
short segment that works.

### 3b. The re-orientation argument — weaker than it sounds

A cross-episode cut changes talker, room acoustics, microphone chain, speech rate
and topic simultaneously, and §2a shows those costs are additive. But the honest
reading of that section is that the tax is **seconds, front-loaded, and largely
discharged within one sentence.** Perception alone would license a floor closer
to 10 s than 30 s.

Two things stop it there. Lerner et al.'s paragraph-scale finding (~30–40 s for
top-level integration) is the one perceptual line that lands near our floor, and
it is contested. And Foray's narration bridge does most of the *topic*-side work
before the audio even arrives — which is precisely the advantage a raw clip feed
does not have, and precisely why it would be wrong to import a clip feed's
numbers in either direction.

So: **§2a fixes the sacrificial head (§3f) and kills the folklore. §3a sets the
floor.** Anyone arguing this floor up or down on perceptual grounds is arguing
from the weakest of the three arguments here.

### 3c. The "is it a segment or a quote" argument

At ~170 words per minute — the rate implied by the TREC 2020 podcast corpus
(120 s segments averaging 340 ± 70 words, `docs/research/corpus/digests.md` #6),
which sits inside the 164–196 wpm conversational range Yuan et al. measured on
Switchboard/Fisher/CallHome — 30 s is **~85 words**, of which the first ~11 are
the sacrificial head (§3f). So a 30-second segment delivers roughly **74 usable
words**: a claim plus one supporting clause. Below it you have a claim with no
support, i.e. a quotation. Foray is allowed to use quotations, but they are a
*role* with a quota (§5b), not the default unit.

(The familiar "150 wpm" is folklore — see §2a. Nothing here turns on the
difference, but the arithmetic should not be built on a number with no source.)

### 3d. The role floors

| role | floor | why |
|---|---|---|
| `quote` | 30 s | a sharp formulation, complete in one or two sentences |
| `explanation` | 60 s | a claim needs its support to be worth cutting to |
| `exchange` | 75 s | two speakers need at least two turns each to read as an exchange |
| `narrative` | 120 s | a story has a shape; below two minutes it is an anecdote fragment |

### 3e. Where this sits against the precedents

Below the "someone had to define a segment" cluster in §2c (Podcast Namespace
15–120 s, TREC 120 s, IAB/Spotify/Overcast 60 s) and well above the radio
soundbite cluster in §2b (5–20 s). That is the right place for one reason:
**every precedent in both clusters is a single excerpt consumed on its own, or
an excerpt framed by a narrator who is doing the arguing.** Foray is neither. Its
segments pay a transition tax the first group never pays, and carry an argument
the second group hands to the reporter.

The honest summary of the floor: **30 s is a hedge, not a measurement.** It is
where the payback arithmetic lands with the spec's own bridge budget, it clears
the "claim plus support" threshold at podcast speech rates, and it sits on the
long side of a space (§2b) whose short end is a graveyard. If any of those three
change, it should move.

### 3f. The sacrificial head — a boundary rule, not a length rule

> **Start the segment roughly one sentence before the sentence you want.**
> Budget the first **~4 s** (≈ 11 words at 170 wpm) as re-orientation. Nothing
> load-bearing goes there.

This is the cleanest actionable result in §2a, and it is the rule most likely to
improve output per unit of effort, because it costs nothing: the extractor is
already choosing a boundary and this only says *choose it slightly earlier.*

It also resolves a tension with §7's cold-open check. The run-up sentence is
allowed to be the throat-clearing one — *"Yeah, so this is the thing people get
wrong—"* — precisely because nobody is expected to be following yet. What must
not happen is the reverse: the load-bearing claim arriving at second zero, where
measured recall on that sentence is around 52 % rather than 72 %.

Practical consequence for `start_anchor`: it should sit at the start of the
*run-up*, not at the start of the money sentence. An extractor that anchors on
the quotable line is placing the boundary about one sentence too late, every
time.

---

## 4. The maximum

**Soft maximum 240 s. Hard maximum 480 s (narrative/exchange), 360 s
(explanation), 90 s (quote). Relative maximum 20 % of the source episode.**

The justification for cutting long is *not* attention. People voluntarily listen
to three-hour episodes; there is no attentional cliff at four minutes and it
would be dishonest to invent one. The justification is narrower and stronger:

**Foray's editorial claim is that every second earns its place. That claim gets
harder to defend, linearly, with every second of unedited conversation we
include.** Eight minutes at ~170 wpm is ~1,350 words — a five-page essay's worth
of words, with none of an essay's editing. Nobody can look at eight continuous
minutes of spontaneous speech and say each second was chosen.

So the rule is a **burden-of-proof flip, not a wall**:

- **≤ 240 s** — normal. No justification needed beyond the `why` line.
- **240–480 s** — permitted, but the segment merges with `needs_review: true`
  and the extractor must supply `long_reason`: what the extra minutes *do*.
  "The argument has three steps and cutting after step two misstates it" is a
  reason. "It's all good" is not.
- **> 480 s** — rejected. Not because minute nine is worse than minute eight,
  but because at that length the honest product action is different (below).

Two supporting arguments:

- **The relative cap.** A segment may not exceed **20 %** of its source
  episode's `reference_duration_sec`. Above that we are not excerpting, we are
  rebroadcasting, and the correct output is *recommend the episode* — a surface
  Foray already has (`data/discover.json`, `data/catalog.json`). This also
  points the same direction as product principle #3 ("legally boring"): a
  smaller taking is a less interesting taking. That is a *directional*
  observation, not legal advice, and it does not change the #63 §3 posture
  (seek-and-stop on the original enclosure, no derived artefact).
- **The `quote` ceiling.** 90 s. A quote that runs past 90 s has stopped being a
  quote and is a mis-roled explanation. This exists to stop the role labels from
  becoming decoration.

---

## 5. Target range, roles, and the cut-frequency rule

### 5a. Target

**75–180 s, centre of mass ~110 s.** A Foray whose segment durations cluster
here will be roughly: bridge, claim, support, land, bridge. That is the unit the
format is actually made of.

This is a target for the *distribution*, not a constraint on any one segment. An
extraction batch whose median segment is 40 s is producing quote reels; one
whose median is 300 s is producing a playlist. Both are checkable at the batch
level and neither is checkable per segment — which is why they belong in §9's
"batch" tier rather than in `merge-segments.mjs`.

### 5b. Roles

| role | floor | target | hard max | quota in one Foray |
|---|---|---|---|---|
| `quote` | 30 s | 35–75 s | 90 s | ≤ 20 % of segments; at most **2** adjacent |
| `explanation` | 60 s | 90–180 s | 360 s | — (the default) |
| `exchange` | 75 s | 120–240 s | 480 s | — |
| `narrative` | 120 s | 180–360 s | 480 s | — |

**Yes, the rules should differ by role, and this is the cheapest place to admit
it.** A single band wide enough to hold a punchy quote and a story is wide
enough to hold anything, i.e. it is not a rule. The cost is one enum field on
the segment schema, authored by the extractor and validated against the taxonomy
of roles — the same shape as `confidence`, which is already there.

The `quote` quota is the important line in that table. Quotes are the segments
that make a Foray feel sharp and the segments that make it feel like a clip
reel, and the difference is entirely density. Two adjacent quotes is a
contrast — *"here is one view, here is the opposite"* — which is a real
rhetorical move and the exact shape §2d's clustering finding endorses. Three
adjacent quotes is a montage. That is where the line goes, and it is deliberately
aligned with the burst rule below so the two cannot disagree.

### 5c. The cut-frequency rule — the actual answer to "jumps around"

A minimum gap between cuts *is* the segment floor, so as a standalone rule it
adds nothing. The rule that has teeth is a budget over a rolling window — and
§2a's non-habituation finding is what makes a budget the right instrument. If
the orienting cost of a voice change decayed with repetition, a Foray could
"warm up" into a faster cut rate and the right rule would be a ramp. It does
not, in exactly the distracted-listener condition Foray ships into, so **total
cut cost is linear in cut count** and the right rule is a cap on rate.

> **Cut budget.** In any rolling 600-second window of Foray playback, the number
> of segment starts must not exceed **N**, where N depends on total Foray
> duration:
>
> | total Foray duration | N per rolling 10 min | implied mean gap |
> |---|---|---|
> | ≤ 45 min | 8 | ≥ 75 s |
> | 45–120 min | 6 | ≥ 100 s |
> | > 120 min | 5 | ≥ 120 s |
>
> **Burst rule.** At most 2 consecutive segments under 60 s. The next segment
> after two short ones must be ≥ 150 s — a *recovery segment*.
>
> **Anti-uniformity rule.** No three consecutive segments whose durations are all
> within ±20 % of one another. Across the whole Foray, the interquartile range of
> segment durations must be ≥ 45 s.
>
> **Whole-Foray mean.** Mean segment duration ≥ 90 s, every mode.

Four things about this, one of them contentious:

- **The anti-uniformity rule is the one that actually answers the founder.**
  Per §2d, a constant cut rate is both perceptually flat (white, not 1/f) and
  audibly mechanical. Twelve 20-second segments is the pathological case not
  because 20 s is short but because *twelve of them are the same*. A 22-minute
  Foray of twelve segments at
  **35/95/40/210/60/130/45/75/180/110/250/90 s** reads as edited and satisfies
  every rule in this box; the same twelve at 110 s each satisfies the floor, the
  budget, the burst rule and the mean, and reads as a machine. The rule is cheap
  to check and it is the only rule here with a measured finding behind it rather
  than a derivation.
- **It permits bursts and forbids sustained chop — and bursts are wanted.**
  Two short segments in a row is a legitimate rhetorical move: *"here is one
  view, here is the opposite."* §2d's 1/f finding says clustered short units
  followed by a long one is the *preferred* shape, not a tolerated one, so the
  burst rule allows exactly two and then forces a recovery segment, while the
  rolling budget makes sure the passage is paid for. Twelve 20-second segments
  fails on the floor, the burst rule, the anti-uniformity rule and the budget —
  four times over.
- **The budget tightens as the Foray gets longer, and that is the contentious
  bit.** *(judgement)* The argument: transition cost is per-cut and roughly
  constant, but tolerance for machinery decays over a session. A 3-hour Foray at
  the 40-minute budget would be 144 transitions; no editorial claim survives
  needing 144 justified cuts. The counter-argument, which is honest and which
  the founders may prefer: a longer Foray also has more genuine topic ground to
  cover, so the same rate may be right. If the founders reject the taper, set
  N = 6 everywhere and the rest of the scheme is unaffected.
- **It is an assembly-time rule, not an extraction-time rule.** No single
  segment can violate it. It belongs wherever a Foray is assembled from the
  segment pool (`data/ladders.json`, task A8), not in
  `tools/segments/merge-segments.mjs`. §9 splits the enforcement points
  accordingly.

### 5d. Density modes (#174) — the mode changes *which* segments, never *how long*

Issue #174 asks whether "super dense/quick" vs medium vs "very long" is a
duration knob or a density knob. The answer this document commits to:

> **A short Foray is the same segments, fewer of them. It is never the same
> segments, shortened.**

A truncated segment is not a shorter version of a segment; it is a different and
worse segment, because everything in §3 and §7 was about self-containment and
truncation is exactly the operation that destroys it. So #174's option 1 (author
one layered set, filter at playback) is the right one, and the tier signal it
needs — `spine` / `supporting` / `colour` — is a schema field, not a length rule.

The one place mode legitimately touches this document is the cut budget, because
the budget is a function of total duration and the mode is what sets total
duration. That is the whole coupling.

**One counterintuitive consequence, worth stating because it is the opposite of
what "dense mode" sounds like:** dropping the supporting layer leaves the surviving spine segments
*further apart in argument space*. The gaps the narrator has to cross get
bigger. So the short mode needs **longer** bridges than the long mode — and by
the payback rule (§3a), longer bridges demand **longer** minimum segments. The
dense 40-minute Foray is not made of short segments. It should end up made of
the *longest*, most self-contained segments in the pool, with the most narration
between them. "Dense" describes the information rate, not the edit rate. That is
a prediction of the scheme rather than an observation, and it is a cheap one to
falsify once #67's hand-authored Forays exist — if the short mode feels
*slower* than the long one, this is the thing that is wrong.

---

## 6. Same-episode segments: merge, or mark the seam

### 6a. Merge

**If two selected segments come from the same `item_id` and the elided gap
between them is short, cut them together into one segment.**

The economics are one-sided. A same-episode rejoin saves nothing on
re-orientation — same voice, same room, same topic — so the only thing a cut
buys is the elided material. Against that it costs a bridge, padding, and a
*continuity violation*: the listener's ears say "this is one continuous
recording" while the content jumps. That is the most disorienting edit available
to us, worse than a clean cut to a new voice, because the audio signals
continuity and the content contradicts it.

> **Merge rule.** For two segments from the same `item_id` with elided gap `g`:
>
> - `g < 45 s` — **must merge.** Saving 45 s of listener time by spending ~9 s
>   of bridge plus a jump-cut artefact is a bad trade.
> - `45 s ≤ g < 180 s` — **should merge**, unless the elided material is
>   genuinely off-topic (an aside, an ad read, a different question). If not
>   merged, the seam must be marked (§6b) and the reason recorded.
> - `g ≥ 180 s` — keep separate. Three minutes is real time saved.
>
> Merging means: `start_sec`/`start_anchor` from the first, `end_sec`/
> `end_anchor` from the second, `why` re-authored for the merged whole. The
> merged segment is then subject to §4's maxima like any other — if merging
> pushes it past 480 s, do not merge, mark the seam.

The 45 s and 180 s thresholds are *(judgement)*. The 45 s one is not arbitrary
though: it is the payback rule (§3a) run backwards. A cut costs `4 × (b+1) + 4`
seconds of segment to justify, which at a maximum bridge is 40 s — so an elision
that saves less than about 40–45 s of listener time has not paid for the cut it
requires. The 180 s upper threshold is a straight judgement call.

### 6b. The bridging rule when they are not merged

**A same-episode jump cut must always be marked. There is no such thing as an
unmarked butt-cut inside one voice.** Two ways, in preference order:

1. **Narration.** The bridge states the elision: *"A few minutes later, same
   conversation, he gets to the mechanism."* Required when the elided span
   exceeds 5 min, because across a large gap the listener will otherwise build a
   false model of continuity and then be confused by a reference to something
   they did not hear.
2. **Silence.** **≥ 2.0 s** of padding, against the ~0.5 s standard from
   `04_VOICE_AUDIO_SPEC.md`. That number is the audiobook section-break
   convention (§2e), which is the only published answer to "how much silence
   tells a listener they have moved." Enough that the listener hears a beat and
   reads it as an edit rather than a defect. Acceptable for short elisions in
   narration-off mode (the spec's verbosity setting), never for long ones.
   Note this is a *deliberate divergence* from `04_VOICE_AUDIO_SPEC.md`'s 0.5 s:
   that number is right for joining audio and too short for marking an edit.

**Cross-episode transitions always carry narration.** A hard cut from one
person's voice to another's, unbridged, is exactly the montage the founder is
worried about, and `04_VOICE_AUDIO_SPEC.md` already budgets ≤ 8 s for it.
(Note the spec's "hard cuts are fine" line applies to the *audio join*, not to
the editorial join — it is about not needing crossfades, not about not needing a
bridge.)

There is a second-order reason to prefer narration at cross-episode seams that
has nothing to do with comprehension: **loudness.** AES TD1004.1.15-10 warns
that inserting externally-produced material into a program can cause loudness
jumps "of up to 7 LU, which is outside the comfort zone of most" listeners
(`docs/research/corpus/digests.md` #12). Every cross-episode seam in a Foray is
exactly that insertion. A loudness-normalised narration item between two
differently-mastered podcasts gives the listener's ears a reference point at the
seam. This is an argument for the bridge, not a substitute for actually
normalising — that stays a real task.

### 6c. Three hard rules

- **Never order same-episode segments non-chronologically.** This is an
  integrity rule, not an aesthetic one, and §2g is the authority: RTDNA's editing
  guidance treats *"rearranging sounds in time or place"* as the same category of
  fault as inventing them. A same-voice sequence played out of order can make a
  speaker appear to answer a question they were never asked, or concede a point
  before it was raised. Mechanically checkable; hard reject.
- **Every cross-episode bridge names its source** — who is speaking, and what
  it is from. This is the natural content of a bridge anyway, so it costs
  nothing; stating it as a rule is what stops a sequence of unattributed voices
  from implying a conversation that never happened (§2g).
- **Concentration cap: ≤ 25 % of a Foray's segments and ≤ 25 % of its runtime
  from any single `item_id`.** Past that we have made an edit of one episode and
  called it a Foray, and the honest action is to recommend the episode.

### 6d. Order by voice contrast, not only by length

The cheapest available improvement to "it jumps around" is not a length rule at
all. Transom's *Art of the Radio Feature* puts it as *"vary the texture"* (§2d):
two adjacent segments feel choppier when the speakers sound alike than when they
contrast, at identical durations. Similar timbre plus a cut is the combination
that reads as a splice, because the ear expects continuity and does not get it —
the same mechanism that makes a same-episode jump cut (§6a) the worst edit
available.

This is a **soft, assembly-time preference**, not a constraint, and it is only
partly mechanisable:

- Mechanisable: prefer sequences that alternate `speaker` labels rather than
  repeating one. `tools/segments/transcript-normalize.mjs` already surfaces a
  `speaker` field where the format carries it (`null` for SRT, always), and the
  source `item_id` is a free proxy when it does not.
- Not mechanisable without audio analysis: actual timbre contrast. Do not build
  that. Note it as a thing a human assembling the first three Forays (#67)
  should listen for, and see whether it matters before anyone measures F0.

---

## 7. The rule that is actually the right shape: self-containment

Everything above is a length rule, and length is a **proxy**. The thing it is a
proxy for is:

> **Does this segment survive being heard cold, by someone who did not hear the
> ten minutes before it?**

That is the real predictor, and it is not correlated with length as tightly as
one would like. "So that's why the whole thing collapsed" is broken at second
zero and stays broken at four minutes. "The Lawson criterion is a statement about
how hot, how dense, and for how long" works at thirty seconds.

**If self-containment could be checked reliably, the hard floor could drop to
about 20 s — where the payback rule bottoms out with a terse bridge — and that
rule would carry the rest of the weight.** It cannot,
so the floor exists to buy statistical protection against the failures the checks
below will miss. That is the honest status of the number 30, and the founders
should know it: it is a hedge, not a measurement.

Two checks that get partway there, both **flag-not-reject**:

- **Cold-open check.** The first word of `start_anchor` must not be an unbound
  discourse connective or pronoun — `so, and, but, because, that, this, it, they,
  he, she, which, then, right, yeah, well, anyway, exactly, again, also, plus, or`
  — unless a proper noun or the segment's topic term appears within the first 12
  words. A single lexical test on a field that already exists. It will produce
  false positives ("So the Lawson criterion is…" is fine); an extractor override
  flag is the answer, not a weaker check.
- **Clean-out check.** `end_anchor` should land on a sentence terminal in the
  source transcript. A segment that ends mid-clause is the one edit listeners
  reliably report as "it cut off."

The part no machine will check: **does the segment state a complete thought.**
That stays the extractor's judgement and the reviewer's, and it is the reason
`confidence` and `needs_review` exist.

---

## 8. Worked examples

**(1) The 22-second zinger.** A guest says something perfectly quotable in 22 s.
→ **Reject.** Below the 30 s hard floor, and with a 6 s bridge the payback rule
wants `4 × 7 + 4 = 32 s` anyway. The fix is almost always to widen, not to argue:
take the run-up sentence in front of it (§3f — you need ~4 s of sacrificial head
regardless) and the landing sentence after it, and it is a 35-second `quote` that
passes. **Widening is not padding.** The extra seconds are what make the
quotable part land, and cutting them out is the thing that produced a 22-second
fragment in the first place.

**(2) Twelve 20-second segments in four minutes.** The founder's exact
nightmare. → **Rejected four times:** every segment is below the 30 s floor; the
burst rule fires at the third; the anti-uniformity rule fires at the third
(twelve identical durations); the rolling budget fires at the ninth start, since
all twelve fall inside one 600 s window and even the most permissive mode allows
8. Note *which* of those four is the interesting one: raising every segment to
40 s fixes the floor and fixes nothing else. The chop is in the repetition and
the rate, which is §2d's point.

**(3) Two 90-second segments from the same Lex episode, 20 s apart.**
→ **Must merge** into one ~200 s segment (`g = 20 s < 45 s`). Keep the first
`start_anchor`, the second `end_anchor`, re-author `why`. One bridge instead of
two, no same-voice jump cut, and the result sits in the target band.

**(4) Two 90-second segments from the same episode, 9 minutes apart.**
→ **Keep separate** (`g ≥ 180 s`) **and bridge with narration**, not silence —
the elision exceeds 5 min, so the listener must be told the conversation moved.
Also check chronology: the earlier one plays first, always.

**(5) A 7-minute narrative passage — a single continuous story.**
→ **Permitted, with friction.** Under the 480 s hard max for `narrative`, over
the 240 s soft max, so it merges with `needs_review: true` and a `long_reason`.
Then check the relative cap: if the source episode is 28 minutes, 7 min is 25 %
> 20 % → **reject and recommend the episode instead.** If the source is 2 hours,
it is 5.8 % and fine.

**(6) A dense 40-minute Foray on one subject.** → Roughly 15–20 segments
averaging ~2 min, drawn from the `spine` tier only, with slightly longer bridges
than the 3-hour version of the same subject would use. **Not** 40 short segments.
Budget check: ≤ 8 starts per rolling 10 min gives ≤ 32 segments; the ≥ 90 s mean
gives ≤ 26. Both are satisfied comfortably, which is the sign the mode is being
built by dropping segments rather than by chopping them.

---

## 9. For the extraction agent

Constraints in checkable form, with where each one lives. **Three enforcement
tiers**, because they need different amounts of context:

- **P — per segment.** `tools/segments/merge-segments.mjs` can enforce these
  today; it already has the segment, the transcript index and
  `reference_duration_sec`.
- **B — per batch.** Distribution checks over one extraction batch. A new
  reporting mode on the merge, or a separate lint.
- **A — per assembled Foray.** Needs the ordered sequence, so it belongs with
  Foray assembly (task A8, `data/ladders.json`), not with extraction.

| # | rule | tier | mechanical? |
|---|---|---|---|
| L1 | `end_sec − start_sec ≥ 30` | P | **yes** |
| L2 | `end_sec − start_sec ≥ role_floor[role]` (30/60/75/120) | P | **yes** |
| L3 | `end_sec − start_sec ≤ role_max[role]` (90/360/480/480) | P | **yes** |
| L4 | `end_sec − start_sec > 240` ⇒ `needs_review: true` and `long_reason` non-empty | P | **yes** |
| L5 | `end_sec − start_sec ≤ 0.20 × reference_duration_sec` | P | **yes** |
| L6 | `role ∈ {quote, explanation, exchange, narrative}` | P | **yes** |
| L7 | payback: `duration ≥ 4 × (bridge_sec + 1) + 4` | A | **yes**, once bridges are authored; unenforceable at extraction time because the bridge does not exist yet |
| S0 | sacrificial head: the load-bearing claim does not begin in the first ~4 s | P | **no. Judgement.** A proxy exists — `start_anchor` should not be the money sentence — but "which sentence is load-bearing" is not machine-decidable. Belongs in the prompt, not the validator |
| S1 | cold-open: first word of `start_anchor` not an unbound connective/pronoun unless a proper noun appears in the first 12 words | P | **flag only** — lexical test, real false positives, needs an override field |
| S2 | clean-out: `end_anchor` ends at a sentence terminal in the transcript | P | **flag only** |
| S3 | the segment states a complete thought | — | **no. Judgement.** This is what `confidence` is for |
| D1 | ≤ N segment starts per rolling 600 s (N = 8/6/5 by Foray duration) | A | **yes** |
| D2 | ≤ 2 consecutive segments < 60 s; the next ≥ 150 s | A | **yes** |
| D3 | mean segment duration ≥ 90 s across the Foray | A | **yes** |
| D4 | ≤ 20 % of segments are `role: quote`; at most 2 adjacent | A | **yes** |
| D5 | anti-uniformity: no 3 consecutive durations within ±20 %; whole-Foray IQR ≥ 45 s | A | **yes** |
| M1 | same `item_id`, elided gap < 45 s ⇒ must be merged (reject the pair) | B | **yes** — needs both segments, so batch tier |
| M2 | same `item_id`, gap 45–180 s ⇒ flag; requires `keep_separate_reason` | B | **flag only** |
| M3 | same `item_id` segments never out of chronological order | A | **yes** |
| M4 | ≤ 25 % of a Foray's segments *and* runtime from one `item_id` | A | **yes** |
| M5 | same-episode seam is marked (narration, or ≥ 2.0 s silence) | A | **yes**, once the bridge record exists |
| M6 | elided span > 5 min ⇒ narration required, silence not sufficient | A | **yes** |
| X1 | cross-episode seam always carries narration | A | **yes** |
| X2 | cross-episode bridge names its source (speaker + show) | A | **flag only** — presence of an attribution is checkable, correctness is not |
| X3 | prefer alternating `speaker` / `item_id` over repeating | A | **soft preference**, not a gate |
| B1 | batch median segment duration in 75–180 s | B | **yes** |

New schema fields this implies on a `segment` record (all additive; nothing
existing changes shape):

```jsonc
{
  "role": "explanation",        // quote | explanation | exchange | narrative
  "tier": "spine",              // spine | supporting | colour   — for #174
  "long_reason": null,          // required when duration > 240 s
  "cold_open_ok": false,        // extractor override for S1
  "keep_separate_reason": null  // required when M2 fires
}
```

Four notes for whoever writes `docs/agents/runner-prompts/segment-batch.md`
(#110):

- **Put the sacrificial head in the prompt, because the validator cannot.** S0
  is the highest-value rule here and the least enforceable: *anchor the start
  about one sentence before the sentence you actually want.* An extractor left
  to itself will anchor on the quotable line every time, which places the
  boundary one sentence too late and lands the payload in the window where
  measured recall is ~52 % instead of ~72 % (§2a).

- **Do not turn these numbers into a quota.** #110's rule 2 — returning zero
  segments is a first-class answer — outranks every number in this document. A
  prompt that says "target 75–180 s" to a model that has found nothing worth
  cutting will produce a 90-second segment of nothing. State the floors as
  *rejections*, and the target band as a property of good output, never as an
  instruction to hit.
- **The fix for a too-short segment is almost always to widen it**, not to
  discard it. A 22 s idea usually has 15 s of setup in front of it that the
  extractor skipped because the setup is not the interesting part. It is the
  part that makes the interesting part land.
- **Boundaries stay editorial.** #63 §3 / R11 are unchanged by any of this: none
  of these rules may be satisfied by moving a boundary to where an ad is, and
  none of them may appear in `why`.

---

## 10. What this document does not decide

- **🔴 Tape-forward or narrator-forward (§2b).** The one question here that is
  genuinely the founders' and that changes every number if answered the other
  way. This document assumes tape-forward (~90/10). Radio's eighty years of
  practice assume narrator-forward (~50/50), and that is why NPR can use
  10-second clips and we cannot. Answer it explicitly; do not let it be settled
  by whichever number someone implements first.
- **The bridge writing rules.** Length of bridge is capped by
  `04_VOICE_AUDIO_SPEC.md` at 8 s; what a good bridge *says* is a separate
  question and a founder-facing one.
- **The 0.5 s → 2.0 s padding divergence.** §6b asks for more silence at an
  unbridged same-episode seam than `04_VOICE_AUDIO_SPEC.md` specifies around TTS
  items. That is deliberate (different job: marking an edit vs joining audio) but
  it is a spec change and needs Wyatt, since it touches the player.
- **Loudness normalisation across segments.** §6b uses it as an argument for
  narration at seams. It is not a substitute for the real work, which is
  unassigned.
- **Whether the cut budget tapers with Foray length.** Flagged in §5c as the one
  genuinely contested number. Recommendation is to taper; setting N = 6
  everywhere costs nothing structurally.
- **The `tier` vocabulary for #174.** `spine`/`supporting`/`colour` is a
  proposal borrowed from #174's own text, not a ruling.
- **Any of this against real listening.** Every number here is derived from
  literature, precedent and internal constraints. None of it has been tested
  against a Foray anyone has heard, because none exists yet. The pool is no
  longer empty, though — the first 9 segments landed 2026-08-16
  (`docs/curation/grilling-foray-batch-1.md`), authored against these rules. The
  first three hand-authored Forays (#67) are the experiment that should move
  these numbers, and the most valuable thing that could happen to this document
  is being contradicted by one.
- **D5 does not say which quartile definition it means, and that is not
  academic.** Batch 1's interquartile range is **41.0 s** under Tukey hinges and
  R-7 linear interpolation (NumPy's and R's default) but **63.6 s** under the
  exclusive definition — so the 45 s floor fails under the common default and
  passes under the other, on the same nine numbers
  (`docs/curation/grilling-foray-batch-1.md` §2). Pick one before anything
  enforces it.
