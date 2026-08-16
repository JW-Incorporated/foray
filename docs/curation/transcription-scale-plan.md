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

**So the free route cannot bootstrap the product on its own.** Either route 2
works, or route 3 is the critical path and needs real capacity — which is
exactly why the §4 probe matters more than any other single task in the epic.

**Route 2 is the highest-leverage unproven thing in the project.** If duration
matching lets a DAI episode's publisher transcript anchor reliably for some
meaningful fraction of listeners, we get thousands of transcripts for zero
compute — which is a bigger win than any amount of GPU. ADR-0007 already
designs for it. Nobody has measured whether it works.

Route 3 is where all the money and time goes. Route 4 is a later problem.

---

## 4. What I would do before buying any hardware

**Measure route 2.** It is cheap to test and it changes the shape of everything
downstream:

- Take N DAI episodes that ship a timed transcript.
- Download the enclosure twice, hours apart, from different IPs if possible.
- Compare durations and check whether the publisher transcript's timestamps
  line up with either copy.

The outcome is one of three, and each implies a different project:

- **Timelines are stable in practice** (ads are baked per-episode, not
  per-request, for most shows) → the DAI label is over-cautious, 7,966
  transcripts become usable, and the ASR epic shrinks to a nice-to-have.
- **Durations vary but by a constant offset** → a single per-download
  calibration fixes it, and route 2 works with modest engineering.
- **Ads are scattered mid-episode at varying lengths** → route 2 is dead,
  ASR is the only path, and the cost estimates in §5 are the real budget.

This is a day of work and it gates a decision worth thousands of dollars and
weeks of compute. **It should happen before T7 (#118) buys or dedicates a GPU.**

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

1. **Finish T2 (#117)** — is `base.en` accurate enough to anchor a segment?
   Decides model size, and therefore every number in §5. *In progress.*
2. **Run the §4 DAI stability probe** — one day of work, and it decides whether
   the ASR epic is a nice-to-have or the critical path. This moved ahead of
   content work because route 1 turned out too thin to bootstrap on (§3), so the
   probe now gates *what the first Forays can even be made of*.
3. **Build the first Foray from whatever route 2 or 3 makes available** (#112).
   One good subject beats three chosen for transcript convenience. Note this
   unblocks the whole client surface (C2/C12/A7), which needs a populated
   `segments.json` far more than it needs a large one.
4. **Then, and only then, size the transcription capacity** against what the
   probe found — T7 (#118) with real specs, or option C/D with a real quote.

The thing to avoid is buying capacity for a job that route 2 might delete.

---

## 7. What this doc is not

It is not a decision. It is the arithmetic that was missing, so the decisions in
§5 can be made against measured numbers instead of instinct. The measurements
are in `tools/transcribe/README.md` and issue #116; the pool counts are in
`data/transcript-availability.json` and `data/discover.json`.
