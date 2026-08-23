# Transcription at scale — what "transcribe thousands of podcasts" actually costs

**Status:** planning doc, 2026-08-15. Written because "we'll transcribe
thousands of episodes" has been an assumption in this project since the
transcription epic (#115) was scoped, and T1 (#116) has now measured enough to
say what that assumption costs. Two of the decisions below need founders.

Companion to `docs/adr/0004-transcript-acquisition-ladder.md` (where transcripts
come from) and `docs/adr/0007-segment-anchoring.md` (how a segment is pinned to
audio). This doc is only about **volume**: how many episodes, by what route, at
what cost.

---

## 1. The short version

**Transcribing thousands of episodes on a laptop is not on the table.** At T1's
measured 1.33x realtime with `base.en`, and the 61 min average of our non-DAI
episodes:

| batch | audio | compute on this laptop | continuous wall time |
|---|---|---|---|
| 100 episodes | 102 h | 76 h | 3.2 days |
| 1,000 episodes | 1,017 h | **765 h** | **32 days** |
| 5,000 episodes | 5,083 h | 3,822 h | 159 days |
| all 22,275 non-DAI episodes | 22,646 h | 17,027 h | **1.9 years** |

And it is worse than the hours suggest: the machine cannot be used for
development while a run is in flight (measured — `gh` calls fail with TLS
timeouts from CPU starvation), and two concurrent runs starve each other to
0.23 effective threads with neither finishing.

**But the more useful finding is that we do not need thousands.**
`data/segments.json` holds **69 segments** as of 2026-08-22, cut from 19 source
episodes; the first 9 were self-transcribed
(`docs/curation/grilling-foray-batch-1.md`).
The next milestone is the first 3 Foray subjects (#112), which needs tens of
episodes, not thousands. Transcription volume should be **demand-driven** —
transcribe what we are about to publish, not the catalogue.

---

## 2. The structural problem, stated plainly

This is the thing worth internalising, because it drives every option below.

**Publisher transcripts exist almost exclusively where we cannot use their
timestamps. Stable timelines exist almost exclusively where no transcript
exists.**

| pool | shows | episodes | with publisher transcript | coverage |
|---|---|---|---|---|
| DAI (dynamic ad insertion) | 144 | 59,768 | 7,966 | **13.3%** |
| non-DAI (stable timeline) | 68 | 22,275 | **46** | **0.2%** |

Measured 2026-08-11, `data/transcript-availability.json`.

A DAI listener's file is assembled per-download: different ads, different
offsets. A timestamp from our copy does not point at the same moment in theirs.
So the 7,966 free transcripts sit on the pool whose timeline we cannot trust,
and the 22,275 episodes with trustworthy timelines have 46 transcripts between
them.

Self-hosted ASR exists to fill exactly that hole — it is the only way to get a
transcript for a non-DAI episode. That is why the epic exists, and it is why
the epic is expensive.

---

## 3. The four routes to a usable segment, cheapest first

| # | route | cost per episode | works on | status |
|---|---|---|---|---|
| 1 | Publisher transcript + stable timeline | **free** | **34 episodes** | works today, but see below |
| 2 | Publisher transcript + DAI, anchored by duration match | **free** | up to 7,966 | **unproven — see §4** |
| 3 | Self-hosted ASR on non-DAI | 46 min compute | 22,275 | proven, slow (T1) |
| 4 | Self-hosted ASR + fingerprint anchoring on DAI | 46 min + DSP | 59,768 | not designed |

### Route 1 is real but it will not carry the first Forays

Anchoring needs *timed* transcripts, so the honest count is **34, not 46** — the
other 12 are plain text with no timestamps. Worse, those 34 are scattered across
five unrelated niches with no subject depth anywhere:

| show | timed episodes | subject |
|---|---|---|
| The BBQ Central Show | 12 | barbecue |
| Causality | 12 | engineering failure analysis |
| Just Fly Performance Podcast | 6 | athletic performance |
| The Enormocast | 2 | climbing |
| Sigma Nutrition Radio | 2 | nutrition science |
| *(Science for Sport)* | *0 of 11* | *plain text only — unusable for anchors* |

A Foray assembles segments on **one subject across several episodes**. Twelve
episodes of barbecue and twelve of engineering post-mortems do not make three
coherent subjects; at best they make one, and it would be chosen for its
transcripts rather than for being worth listening to. That is the wrong reason
to pick launch content.

On the non-DAI pool alone, the free route cannot bootstrap the product. **§4
fixes this** — the measurement there found that the DAI flag over-reports, and
the ad-free shows hiding behind it bring route 1 to **220 timed transcripts
across 10 shows**, including 120 on a single subject.

Route 3 is where all the money and time goes. Route 4 is a later problem.

---

## 4. MEASURED, 2026-08-15 — route 2 is dead, but the DAI flag is wrong a lot

This section originally proposed a probe. The probe has now been run, twice,
because the cheap version of it lied. Results first, method second.

### Route 2 is dead where ads are really injected

Eight episodes downloaded in full across four shows. Compared the last cue in
the publisher's timed transcript against the true decoded duration of the file
we receive:

| show | feed says | transcript ends | audio really is | ads injected |
|---|---|---|---|---|
| Stuff You Should Know | 36.98 m | 36.88 m | **46.93 m** | **+10.0 min** |
| Stuff You Should Know | 47.48 m | 47.37 m | 55.72 m | +8.4 min |
| Odd Lots | 66.43 m | 66.00 m | 76.67 m | +10.7 min |
| Odd Lots | 59.67 m | 59.15 m | 67.92 m | +8.8 min |
| This Podcast Will Kill You | 78.78 m | 78.31 m | 86.27 m | +8.0 min |
| This Podcast Will Kill You | 72.63 m | 72.17 m | 80.13 m | +8.0 min |
| Being an Engineer | 50.28 m | 51.68 m | 50.30 m | **none (+0.8 s)** |
| Being an Engineer | 39.25 m | 39.79 m | 39.26 m | **none (+0.3 s)** |

The pattern is unambiguous: **feed duration and transcript end agree with each
other and both describe the ad-free program**, while the delivered file carries
8–11 extra minutes. That is not a constant offset that a single calibration
fixes — it is a pre-roll plus mid-rolls, so every timestamp after the first ad
break is wrong by a different amount. Duration matching alone cannot rescue it.

### But "DAI" is a claim about the host, not about the file

Being an Engineer is flagged `dai_suspected: true` and delivers **byte-identical
to its feed declaration**. The flag records which host *could* insert ads, not
which one *does*. So the flag over-reports, and each over-report is a show whose
publisher transcripts are usable for free today.

Scanning the 21 shows that ship timed transcripts and appear in
`data/discover.json`:

| | shows | timed transcripts |
|---|---|---|
| deliver ad-free (ratio < 1.01) | **10** | **220** |
| inject ads | 11 | ~5,700 |

Five of those ten ad-free shows are flagged DAI. The two that matter are
**Geology Bites (120 transcripts)** and **Practical AI (63)** — both flagged
DAI, both delivering clean.

**This repairs the §3 problem.** Route 1 is no longer 34 transcripts scattered
across five unrelated niches: Geology Bites alone is 120 timed transcripts on a
single coherent subject, which is enough to build a real Foray from, for free,
today.

### Method, and the trap in it

`tools/transcribe/ad-inflation.mjs`. The measurement is
`delivered bytes / feed-declared length`, and the trap is that **HEAD requests
lie**: on DAI hosts HEAD returns the ad-free master's `Content-Length` while a
real GET delivers the assembled file. The first version of this scan used HEAD,
reported 18/18 shows as byte-stable, and was completely wrong — Stuff You Should
Know's HEAD says 35,549,607 and its download is 44,961,612.

A **2-byte ranged GET** reports the true total in `Content-Range` for one tiny
request per episode. The cheap probe now reproduces the expensive one: 1.15 for
Odd Lots against 1.15 measured, 1.12 for TPWKY against 1.10.

### What is still unproven

The scan covers only the 21 transcript-shipping shows present in
`data/discover.json`. The other ~190 shows in `transcript-availability.json`
have no enclosure URL in the curated pool, so the same scan over the full
catalogue is the obvious follow-up — every ad-free show it finds is free
transcripts. At ~1.2 s per episode, all 213 shows is well under an hour.

### The original proposal, kept for the record

- Take N DAI episodes that ship a timed transcript.
- Download the enclosure twice, hours apart, from different IPs if possible.
- Compare durations and check whether the publisher transcript's timestamps
  line up with either copy.

The outcome was the third of these: **ads are scattered mid-episode at varying
lengths, so route 2 is dead and ASR is the path for injected shows.** The
consolation is the second finding above — the DAI flag over-reports, and every
over-report is free transcripts.

**The §5 numbers are therefore the real budget for injected shows**, but the
first Forays no longer have to wait for any of it.

---

## 5. If ASR at volume is genuinely needed — the options, with numbers

Only relevant once §4 says route 2 is dead. All three need a founder decision
because two cost money and one costs a machine.

**Estimates below are estimates.** T1's lesson was that estimated throughput was
wrong by 2x in both directions; nothing here is trustworthy until measured on
the actual hardware, which is what #118 is for.

| option | throughput | 1,000 episodes | cost | needs |
|---|---|---|---|---|
| **A. This laptop** | 1.33x (measured) | 32 days | $0 | nothing — but the machine is unusable meanwhile |
| **B. Joey's GPU** (#118) | ~10–20x (est.) | ~2–4 days | $0 + electricity | a machine dedicated for days; specs unknown |
| **C. Rented cloud GPU** | ~10–20x (est.) | ~50–100 GPU-h | **~$30–75** (est.) | paid service — founder approval |
| **D. Managed ASR API** | n/a | 1,017 h audio | **~$150–400** (est., verify) | paid service — founder approval |

Two observations on this table:

- **The paid options are far cheaper than they feel.** The instinct is that
  transcribing a thousand podcasts is expensive; at current market rates it is
  a few tens to a few hundreds of dollars. Weigh that against ~32 days of a
  laptop, or days of Joey's GPU plus the ops burden of noticing when it stalls.
- **It conflicts with the Max-only constraint.** The standing preference is
  keyless and $0 (`docs/` scope note, #138). Options C and D break that
  deliberately, for a bounded one-off rather than a recurring bill. That is a
  founder call, not mine — I am flagging that the constraint has a price now
  that we can quote, rather than assuming it.

---

## 6. Recommended sequence

Nothing here needs a decision to start; the first three are already in flight or
free.

1. **Build the first Foray from Geology Bites** (#112) — 120 timed transcripts,
   one coherent subject, ad-free delivery confirmed, **zero compute and zero
   dollars**. This is the shortest path to a populated `segments.json`, which
   the entire client surface (C2/C12/A7) is waiting on. Practical AI (63) is
   the second subject.
2. **Extend the ad-inflation scan to all 213 transcript-shipping shows.** Under
   an hour of polite requests, and every ad-free show it finds is more free
   transcripts. This is the cheapest remaining source of content in the project.
3. **Finish T2 (#117)** — is `base.en` accurate enough to anchor a segment?
   Decides model size and therefore every number in §5. Note it is no longer
   blocking: the first Forays can be built from publisher transcripts while it
   runs.
4. **Then size transcription capacity** against what is actually left — the
   injected shows and the non-DAI pool — via T7 (#118) with real specs, or
   option C/D with a real quote.

The ordering changed on 2026-08-15. ASR was the critical path when the only
usable transcripts were 34 scattered episodes; it is now a scaling concern
behind 220 free ones. **Do not buy capacity before step 2 reports.**

---

## 7. MEASURED, 2026-08-22 — the pool was never counted, because the join was broken

§4 ended by naming the obvious follow-up: scan the rest of the catalogue,
because every ad-free show it finds is free transcripts. Before that could be
sized, a more basic problem surfaced.

### The number everyone was quoting was produced by a broken join

`data/transcript-availability.json` has recorded thousands of transcripts since
2026-08-12. Asking "how many of our 1,672 curated episodes have one?" answered
**zero** — not because the index was empty, but because `data/discover.json`
keys episodes on Apple ids and the index keys them on the feed `<guid>`, and
neither file carries the other's key. Every join — by guid, by track id, by show
slug — matched nothing.

That is the worst shape a measurement can take. An empty index announces itself;
a broken join returns a real number that happens to be zero, and zero was what
everyone already feared, so nobody re-checked it.

The fix is one field. `enclosure_url` is the only value both files take verbatim
from the same feed (10/10 exact on Practical AI before it was added), so
`sweep-transcripts.mjs` now records it and `tools/segments/transcript-coverage.mjs`
joins on it. **All 158 matches land on that exact key.**

### The fuzzy backstop reported 7 more, and all 7 were fiction

Worth recording, because it is the same failure as the broken join wearing
better clothes. The first working version of `joinItem` tried a normalised-title
match and a duration match *independently*, and reported **165**. Auditing those
7 non-exact matches by hand, every one was a different episode:

| show | discover episode | matched to |
|---|---|---|
| Geology Bites | Bernhard Steinberger on Whether Hotspots Are Fixed (1736s) | Alec Brenner on When Tectonic Plates First Moved (1735s) |
| Being an Engineer | S7E21 Rod Scholl (2886s) | S6E26 Katie Karmelek (2887s) |
| The BBQ Central Show | *same title*, 563s | a 303s re-cut |

Neither signal discriminates alone. A show publishes hundreds of episodes and
dozens land within a second of each other; a show also re-releases an episode
under one title with a different cut. The backstop now requires **both**, and on
the real catalogue it contributes **zero** — the exact key does all the work,
which is what a healthy join looks like.

A miss costs one transcript. A mismatch produces a segment whose anchors point
into different audio, and nothing downstream can detect it. **No unit test found
this — only running the real catalogue and reading the 7 by hand did.**

### The curated slice, correctly counted

| | of 1,672 |
|---|---|
| have a publisher transcript | **158 (9.4%)** |
| of which timed, i.e. anchorable | **137 (8.2%)** |
| shows they sit in | **24 of 221** |

### But `discover.json` is a thin slice, and the pool behind it is not

The curated file holds 1,672 of the catalogue's 86,923 episodes, so it
undercounts the asset badly: Geology Bites contributes **1** episode to
`discover.json` and **120 timed transcripts** to its feed. Sweeping all 220
shows (2026-08-22: 219 ok, 1 NETWORK) gives the real picture:

That was the picture on 2026-08-22, and the middle row was the whole
opportunity — 2,573 transcripts on 14 shows nobody had ever measured:

| pool | timed transcripts | shows | status |
|---|---|---|---|
| non-DAI + **measured** ad-free | **587** | 10 | **usable today, free** |
| DAI-flagged, verdict unknown | 2,573 | 14 | **one cheap scan from an answer** |
| measured injecting ads | 4,411 | 3 | dead for anchoring (§4) |
| **total timed** | **7,571** | 27 | |

### The scan ran on 2026-08-23, and the answer is mostly no

All 27 transcript-shipping shows probed, 5 episodes each, 112 ranged GETs over
2.1 minutes. **No host asked us to slow down** — zero 429s, zero retries. There
is no unmeasured pool left:

| pool | timed transcripts | shows | status |
|---|---|---|---|
| **measured** ad-free | **645** | 14 | **anchors for free** |
| measured injecting ads | 6,625 | 12 | dead for anchoring (§4) |
| measured, still cannot say | 301 | 1 | see "Around the House" below |
| **total timed** | **7,571** | 27 | |

The 2,573 split **89 anchorable / 2,183 injecting / 301 unresolved** — the
hoped-for pool paid out at **3.5%**. Five shows came back clean (Tuned In 51,
Lab to Market Leadership 35, and one transcript each from TechSurge, The Violin
Chronicles and Piano Tech Radio Hour); eight came back injecting, including the
four biggest (Las Culturistas 560, Unexplained 431, Broken Record 395, Wicked
Words 292). **Either answer was worth having, and this one is worth having
because it stops the ASR question being deferred any longer** — see §8.

Two findings from the same run that were not what it went looking for:

- **Around the House with Eric G (301) cannot be called.** Four of its five
  sampled episodes deliver a QUARTER FEWER bytes than the feed declares
  (0.691, 0.746, 0.758, 0.759; the fifth is exactly 1.000). The old one-sided
  `ratio < 1.01` read that as ad-free and would have admitted all 301. Under-size
  is not evidence of no ads — it is evidence the declared length does not
  describe the file we receive, which disqualifies the transcript for the same
  reason injection does. The threshold is two-sided now. **What would settle it:**
  ADR-0008’s decode-and-compare — download one episode, decode its true duration,
  and check it against the publisher transcript’s last cue rather than against a
  feed length we have just caught being wrong.
- **Cider Chat (31) was already in the 587 and is injecting** at a median 1.0125
  (samples 1.000 / 1.011 / 1.014 / 1.046). It qualified on its non-DAI flag alone
  and had never been probed. Small — tens of seconds, paddable under ADR-0008 —
  but the "anchorable today" pool has been carrying 31 transcripts that are not
  byte-stable. No behaviour is changed here: `isAnchorableShow` admits non-DAI
  shows by construction, and narrowing that is an ADR-0008 call, not this scan’s.

### What that is worth in segments

`data/segments.json` holds **69 segments cut from 19 source episodes — 3.6 per
episode.** Applying that rate:

| | episodes | segments at 3.6 |
|---|---|---|
| today | 19 | **69** |
| the 587 free anchorable transcripts | 587 | **~2,100** |
| ~~if the 2,573 unmeasured are mostly ad-free~~ | ~~+2,573~~ | ~~+~9,200~~ |
| **measured 2026-08-23: what the scan actually added** | **+89** | **+~320** |
| **anchorable pool after the scan** | **676** | **~2,430** |

The 3.6 rate is re-checked against `data/segments.json` and holds as a mean, but
it is 19 episodes ranging 1–8 segments each (median 4), so treat any projection
built on it as an order of magnitude, not a forecast.

**So free publisher transcripts move the segment pool by roughly 30x, for zero
dollars and zero ASR.** §3's "34 episodes scattered across five unrelated
niches" is superseded: Being an Engineer alone ships 337 timed transcripts and
Geology Bites 120, both measured delivering ad-free, both single coherent
subjects.

### Acquired, 2026-08-22

All 587 fetched and normalised in one polite pass — **0 failures, 0 retries,
no host asked us to slow down** (`tools/segments/fetch-transcripts.mjs`, then
`transcript-normalize.mjs`). Text sits in `data-local/transcripts/`
(gitignored, ~30MB); digests in `data/transcript-digests.json`.

| | |
|---|---|
| transcripts | **587** across 10 shows |
| cues | **181,225** |
| anchored speech | **428.3 hours** |

Two data-quality findings, both from running the real corpus rather than from
any test:

- **One transcript claimed 100 hours on a 70-minute episode.** Inside
  Winemaking 210 ships a single cue ending at `99:59:59.999` — what a writer
  emits when it means "no end time". Summed naively, that one file put the
  corpus total at 527 hours instead of 428: a headline number **24% wrong**
  because of one degenerate file. `spanImplausible()` now flags any transcript
  whose span exceeds 1.5x the feed duration, and the summary counts it at feed
  duration. Flagged rather than dropped — the cues may be individually fine and
  extraction needs to know the timeline is untrustworthy, not lose the evidence.
- **4 of 587 normalise to zero cues.** Three are 9-byte stubs Being an Engineer
  publishes for episodes it has not transcribed. The fourth is a real
  normaliser gap: `tools/segments/transcript-normalize.mjs` cannot read SRT that
  prefixes the speaker onto the timing line (`Mark McLaughlin 00:00:00,000 -->
  …`), which Blubrry emits, so all 2,305 cues were dropped. **Left unfixed
  deliberately** — it affects exactly 1 file of 587 here, and widening a
  well-tested pure parser is not worth doing inside an acquisition pass. It is
  worth doing before `--all-timed`, where the Blubrry-hosted share is unknown.

### This does not settle #108, and sharpens what it is for

ASR is still the only route to the **non-DAI pool's 25,254 episodes**, which is
where subject depth on demand comes from — free transcripts are 587 episodes on
whatever ten subjects those shows happen to cover, not on a subject we choose.
What changed is the urgency and the ordering: nothing needs to be bought before
the first several Forays are built.

**The cheapest content in the project has now been bought, and it was small.**
The ad-inflation scan over the 14 unmeasured shows (§6 step 2) ran on 2026-08-23
for 112 ranged GETs and added **89** transcripts, not the 2,573 the row above
was holding open. That row can no longer be used to defer the ASR decision:
free publisher transcripts top out at **676 episodes on 15 shows** (of which 645
are measured clean and 31 are Cider Chat, measured injecting but admitted by the
non-DAI clause — see `tools/segments/fetch-transcripts.mjs`), and every
subject beyond what those shows happen to cover needs #108.

## 8. MEASURED, 2026-08-22 — the breadth sweep, and the number it actually returns

§7 counted the curated 220. `data/catalog-breadth.json` holds **19,436 more
uncurated feeds** we had never read — 1.1% of reachable shows swept. Tranche 1
read 500 of them (`tools/segments/rank-breadth.mjs`, then the sweep). The
headline is genuinely large and the usable number is genuinely small, and the
gap between them is the finding.

### What it was ranked on, and why not genre

A `<podcast:transcript>` tag is a feature of the **hosting platform**, not a
choice the publisher makes per episode, so the feed's host predicts it far
better than the subject does. Ranked on a per-platform hit rate learned from the
219 curated feeds, shrunk toward the global rate by a pseudo-count in shows so a
1-of-1 host cannot lead, times `episode_count` — because the budget is spent per
**feed**, not per episode. Genre was measured and discarded:
`data/breadth-classification.json` files Odd Lots under `sports/soccer` and 5-4
under `engineering/ai-robotics`, so a topic-weighted rank is a rank on a
classifier's mistakes.

The tranche is deliberately **two arms**: a ranked EXPLOIT head of 300 (capped at
40 feeds per platform, because ranked purely on yield the top 300 rows of the
catalogue are 300 omnycontent feeds and the run would price one host and
discover nothing), and an EXPLORE arm of 200 drawn uniformly at random from the
same pool. A greedy tranche measures the shows we predicted would win; only the
random arm estimates the population, which is the question "is the rest of the
catalogue worth the requests?" actually asks.

### The yield, per feed swept

| arm | feeds | with ≥1 timed | timed transcripts | per feed | anchorable | per feed |
|---|---|---|---|---|---|---|
| baseline (curated 220) | 220 | 27 (12.3%) | 7,571 | 34.4 | 587 | 2.7 |
| **exploit** (ranked) | 300 | 114 (38.4%) | **175,348** | **584.5** | 2,397 | 8.0 |
| **explore** (random) | 200 | 28 (14.1%) | 2,843 | 14.2 | 1,555 | 7.8 |
| tranche 1 total | 500 | 142 (28.6%) | 178,191 | 356.4 | 3,952 | 7.9 |

**500 feeds returned 178,191 timed transcripts — 23.5x the entire curated
catalogue's 7,571, from 2.3x the requests.** The ranking is most of that: the
exploit arm beat the random arm **41x** per feed, which is the whole argument
for #114 existing.

**The random arm is the one that generalises**, and it says the population is
worth reading: 14.2 timed transcripts per feed is below the curated baseline's
34.4 (the curated set was picked for being good shows, and good shows are big),
but **7.8 anchorable per feed against the baseline's 2.7 — 2.9x better.** Breadth
is worse at supply and better at the thing that converts.

### The finding that matters more: "not DAI" almost always means "unrecognised"

Of 178,191 timed transcripts, **3,952 are anchorable** — a 45x haircut, because
transcripts cluster on exactly the big networks that inject ads (ADR-0007). That
was expected. What was not:

**Every anchorable show in the tranche carries `dai_reason: "unknown"`.** Not one
was positively verified as delivering a static file. `classifyShow` follows the
enclosure's redirects and matches the ORIGIN against `tools/refresh/dai.mjs`'s
host list; that list was built from the hosts 220 curated shows use, and breadth
immediately produced origins it has never seen. Unrecognised returns
`{dai: false}`, and false is read downstream as "anchorable".

Two contradictions were measurable from data already in hand:

- **Resolution throws away a positive identification.** `spreaker.com` **is** on
  the DAI host list. Its enclosures redirect to `d1bxy2pveef3fq.cloudfront.net`,
  an anonymous CloudFront distribution that is not. So the redirect-following
  that `dai.mjs` added specifically to *see through* prefixes like pdst.fm
  discards the identification the feed URL already carried. **Five Spreaker
  shows, 2,470 timed transcripts, 62% of the tranche's entire anchorable haul.**
- **The origin names an ad vendor and is still unlisted.**
  `adswizz.podigee-cdn.net` is AdsWizz, an ad-insertion company. Two shows, 351.

| | timed transcripts |
|---|---|
| anchorable as classified | 3,952 |
| suspect (`suspectAnchorable()`) | 2,821 |
| **survive both checks** | **1,131** |

So the honest number is **1,131, about 1.9x the curated 587** — not 3,952, and
certainly not 178,191. Reported and labelled rather than excluded, per the
standing rule: `isAnchorable()` remains identical to the predicate
`fetch-transcripts.mjs` selects on and the suite pins that they agree, so the
report and the fetcher cannot drift apart about what the corpus contains.

**The cheap follow-up this creates.** `dai.mjs` should match the FEED host as
well as the resolved one — a known-DAI platform behind an anonymous CDN is
evidence, not an exoneration — and `adswizz.podigee-cdn.net` should be measured
with `tools/transcribe/ad-inflation.mjs`. Both are small; between them they
decide the status of 2,821 transcripts. Neither is done here, because
`AD_FREE_SHOWS` says in as many words that these lists hold measurements rather
than opinions, and adding a host on suspicion would break that.

### Acquired

All **1,131** fetched in one polite pass, bodies into `data-local/transcripts/`
alongside #313's 587, digests in `data/breadth-transcript-digests.json`. The
corpus is now **1,718 anchorable transcripts across 15 shows.**

### Politeness

**500 feeds, 4 failures (3x HTTP 404, 1 timeout), zero retries, zero 429s, and no
host asked us to slow down** at concurrency 4 through the shared
`tools/segments/politeness.mjs` gate. Two Apple-listed anchor.fm feeds are dead.

### The projection, and the storage rule it forces

At the random arm's rate, the remaining **18,936 unswept feeds** hold on the
order of **269,000 timed transcripts** and **148,000 nominally anchorable ones** —
before the DAI-verdict haircut above, which on tranche 1 removed 71% of them.
Even at that discount the pool is large enough that **the classifier's accuracy,
not the sweep's reach, is now the binding constraint.**

Storage settles the shape:

| shape | tranche 1 (500 feeds) | projected, 19,436 feeds |
|---|---|---|
| episode rows (~951 B each) | 170MB uncapped / 16MB capped | **~6.4GB** |
| one row per show | **352KB** | **~13.4MB** |

Episode rows and bodies stay in gitignored `data-local/`; only
`data/breadth-transcript-yield.json`'s per-show shape is committed. The sweep's
checkpoint is rewritten in full after every show, so uncapped it is quadratic in
episode rows and a full-catalogue run hands `JSON.stringify` a string longer than
V8 will allocate — it throws rather than slowing down. `--max-episode-rows` caps
rows and never counts; every number in this section is exact at any cap.

## 9. What this doc is not

It is not a decision. It is the arithmetic that was missing, so the decisions in
§5 can be made against measured numbers instead of instinct. The measurements
are in `tools/transcribe/README.md` and issue #116; the pool counts are in
`data/transcript-availability.json` (curated), `data/breadth-transcript-yield.json`
(breadth, §8) and `data/discover.json`.
