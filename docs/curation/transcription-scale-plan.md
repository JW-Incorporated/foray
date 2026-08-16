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
`data/segments.json` currently holds **0 segments**. Nothing has been built yet.
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

## 7. What this doc is not

It is not a decision. It is the arithmetic that was missing, so the decisions in
§5 can be made against measured numbers instead of instinct. The measurements
are in `tools/transcribe/README.md` and issue #116; the pool counts are in
`data/transcript-availability.json` and `data/discover.json`.
