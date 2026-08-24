# Assembling `geology-plates-1` from the Geology Bites batch

The running order for the fourth Foray, why each seam is where it is, and the
one finding that decided its shape: **it carries no narration, on purpose.**

Companion to `docs/curation/segment-length-rules.md` (the rules it is gated on)
and `docs/curation/narration-architecture.md` (the machinery it declines to
use). The Foray itself is `data/forays.json` → `geology-plates-1`; that file is
the only record of the order, and §2 below is pinned against it row for row by
`tools/foray/check-forays.test.mjs`, so the two cannot drift apart.

**Status: draft.** All four Forays in the repo are drafts. Publishing one out of
draft is a founder action.

---

## 0. TL;DR

| | |
|---|---|
| Segments in the running order | **19** |
| Tape runtime | **2,420.4 s — 40 min 20 s** |
| Playback runtime incl. bridges | same — **no narration is authored** (§4) |
| Mean / median segment | **127.4 s / 123.2 s** |
| Shortest / longest | 62.5 s / 238.8 s |
| Interquartile range | 57.53 s (R-7) |
| Episodes used | **11**, all from one show |
| Show | **Geology Bites**, 125 episodes in `data/catalog-breadth.json` |
| Voices | **11 researchers**, one per episode |
| Segments drawn from | `batch_id` `seg-2026-08-23-geology`, 101 segments |
| `transcript_source` | **`publisher`** everywhere |
| `dai_suspected` / `needs_review` | **false** everywhere |
| Global rules missed | **X1 and M6.** Every seam here is unbridged, because narration cannot be voiced without founder spend. §4 |

**The honest headline: the gate is green and the rule that matters most to a
listener is not met.** D1 passes at 6 starts against a budget of 8, D5 passes
with an IQR of 57.5 s against a floor of 45, M4's worst episode is 18.4 % of
runtime against a cap of 25 %. None of that is what a listener would notice
first. What they would notice is that eighteen times in forty minutes the voice
changes with nothing said in between.

---

## 1. Why this Foray exists at all

Before it, the pool held 212 segments and 57 of them were reachable by a Foray —
every one from the three older assemblies. The 143 segments cut on 2026-08-23,
including all 101 from Geology Bites, could not be played by anything. Supply
was not the constraint; a running order was.

The earlier finding that "subjects don't connect" came from drawing *across*
shows. This draws inside one show whose episodes are each a single researcher on
a single subject, and that is the difference. Eleven experts appear here and
none of them is introduced — the subject introduces them.

---

## 2. The running order

Nineteen segments, in argument order. Times are cumulative tape positions.
`tools/foray/check-forays.test.mjs` compares this table against
`data/forays.json` row for row — position, label, duration and role — and the
slot header rows against the declared slots.

| # | at | label | duration | role |
|---|---|---|---|---|
| | **SLOT 1 — A planet that should have seized up** (3 segments, 5:45) | | | |
| 1 | 0:00 | FACC-1 | 123.56 s | explanation |
| 2 | 2:04 | BERC-1 | 78.50 s | explanation |
| 3 | 3:22 | ELK-1 | 143.08 s | explanation |
| | **SLOT 2 — When the plates started moving** (3 segments, 7:51) | | | |
| 4 | 5:45 | CAW-1 | 110.50 s | explanation |
| 5 | 7:36 | BREN-1 | 121.44 s | explanation |
| 6 | 9:37 | CAW-2 | 238.80 s | explanation |
| | **SLOT 3 — What is actually pulling them** (3 segments, 5:52) | | | |
| 7 | 13:36 | VH-1 | 131.50 s | explanation |
| 8 | 15:47 | VH-2 | 150.60 s | explanation |
| 9 | 18:18 | VH-3 | 69.50 s | explanation |
| | **SLOT 4 — Two blobs at the bottom of the mantle** (7 segments, 15:24) | | | |
| 10 | 19:27 | MCN-1 | 88.70 s | explanation |
| 11 | 20:56 | ROM-1 | 123.20 s | explanation |
| 12 | 22:59 | MCN-2 | 157.40 s | explanation |
| 13 | 25:37 | ROM-2 | 81.00 s | explanation |
| 14 | 26:58 | MCN-3 | 199.10 s | explanation |
| 15 | 30:17 | JOHN-1 | 175.72 s | explanation |
| 16 | 33:13 | JOHN-2 | 98.84 s | explanation |
| | **SLOT 5 — The cycle, and the next supercontinent** (3 segments, 5:29) | | | |
| 17 | 34:51 | EVAN-1 | 114.50 s | explanation |
| 18 | 36:46 | NANC-1 | 152.00 s | explanation |
| 19 | 39:18 | EVAN-2 | 62.50 s | explanation |

**Runtime 2,420.44 s — 40.34 min, ending at 40:20. Mean 127.4 s, inside the
75–180 s target band. Eighteen seams, fifteen of them cross-episode.**

### Who each label is

| prefix | voice | episode |
|---|---|---|
| FACC | Claudio Faccenna | on the dynamics of subduction zones |
| BERC | David Bercovici | on how plate subduction starts |
| ELK | Lindy Elkins-Tanton | on the origin of Earth's water |
| CAW | Peter Cawood | on when plate tectonics started |
| BREN | Alec Brenner | on when tectonic plates first moved |
| VH | Douwe van Hinsbergen | on what drives the motions of tectonic plates |
| MCN | Allen McNamara | on the deep mantle structure of the Earth |
| ROM | Barbara Romanowicz | on seeing deep into the Earth |
| JOHN | Clark Johnson | on the banded iron formations |
| EVAN | David Evans | on supercontinents |
| NANC | Damian Nance | on what drives the supercontinent cycle |

---

## 3. The arc

The Foray opens by defining the machine and then immediately breaking it: an
ocean plate gets heavier as it cools, which should make it sink, but it also
gets *stronger*, which should stop it — so on the physics alone Earth should
have no subduction zones, and the answer is water, which is also why the planet
next door has none. Slot 2 asks when the machine switched on and answers it
twice over, once from a rock that demonstrably moved and once from the global
date and the two planets that never reached it. Slot 3 asks what is actually
pulling, finds that the mantle barely moves so the plates must drive themselves,
and then hands the listener the two continents where that answer fails. Slot 4
goes down: the instrument, the two blobs it sees, the chemistry that says they
are real, and the claim that the strange stuff at the very bottom might be the
rusted-out iron of an ocean three billion years gone. Slot 5 closes the loop —
those blobs sit where Pangaea used to be, the cycle that made Pangaea is
self-organising, and Australia is currently on its way to Taiwan.

The through-line is one question asked four ways: *why does this planet have
plate tectonics when the others do not?* Venus is named in slot 1 and again in
slot 2, from two directions.

### Why each seam is where it is

- **FACC-1 → BERC-1.** Definition, then the hole in it. Faccenna ends on gravity
  and viscosity; Bercovici's in-point is literally the interviewer asking "why
  is subduction initiation such a thorny problem?" — the question the first
  segment leaves open.
- **BERC-1 → ELK-1.** Bercovici ends on a question — *how do we undo the effect
  of cooling as a plate thickens?* — and Elkins-Tanton opens on one: *how would
  Earth have evolved if it had no water?* Question answered by question, across
  two episodes, and it reads as a reply.
- **ELK-1 → CAW-1.** Venus hands off to what Earth looked like before it had
  plates.
- **CAW-1 → BREN-1 → CAW-2.** Picture, measurement, date. Brenner is placed
  *between* the two Cawood segments deliberately: a second voice supplies the
  evidence for the claim Cawood then generalises, which is a stronger shape than
  one voice asserting both, and it breaks a 22-minute same-episode span into two
  cross-episode seams.
- **CAW-2 → VH-1.** The date is settled; the mechanism is not.
- **VH-3 → MCN-1.** The best answer to "what drives the plates" has just failed
  on Australia and India. The next move is to go and look, which is what
  tomography is.
- **ROM-1 / MCN-2 / ROM-2 alternate on purpose.** Romanowicz and McNamara
  describe the same deep structures from a seismological and a geochemical
  angle. Alternating them is §6d's texture preference doing real work, and it
  also keeps the two McNamara segments with a 5.4-minute elision from landing
  adjacent.
- **MCN-3 → JOHN-1 is the seam the whole Foray is built toward.** McNamara ends
  by saying the ultra-low velocity zones are his favourite because banded iron
  formations are "the most tangible" thing they might be. Johnson's episode is
  banded iron formations. This is the one place where two episodes were clearly
  describing the same object without knowing it.
- **JOHN-2 → EVAN-1.** The hardest seam here and the one most obviously short a
  bridge: iron provenance to supercontinents. Evans is placed first in slot 5
  rather than Nance because Evans's in-point is a clean question that names its
  subject, and Nance's ("that time. OK, so we've learned a lot more") names
  nothing. Nance then follows with the evidence, which lands better once
  supercontinents have been raised.
- **NANC-1 → EVAN-2.** Nance ends on deep-mantle involvement in the Pangaea
  breakup; Evans turns the clock forward and names Amasia. A 62-second close
  after a 152-second one.

---

## 4. Narration: there is none, and that is a decision

**X1 — "a cross-episode seam always carries narration" — is unmet at 15 of the
18 seams here.** The other three are same-episode (VH-1→VH-2, VH-2→VH-3,
JOHN-1→JOHN-2) and two of those elide more than five minutes (8.23 min and
7.99 min), so **M6** wants narration at them too. Nothing in this Foray is
bridged.

That is not an oversight. Scripts are free to write; **voicing them is
ElevenLabs spend and a founder decision, so this assembly could not produce
audio.** The question was therefore whether to ship *unvoiced* narration items —
items with a `script` and no `audio_url` — to satisfy X1 on paper.

**Answer: no.** The player handles them safely; the app surfaces them as damage.

What was checked, and what it does:

1. `player/foray-resolve.js` → `hydrateForayItems` passes a narration item
   straight through and stamps `duration_sec` from `narrationDuration`
   (`estimated`, script length ÷ 17 chars/s). No crash, no drop.
2. `player/foray-queue.js` → `buildForayQueue` reads
   `raw.audio_url ?? raw.asset ?? null` and, finding nothing, **drops the item**
   with the reason `"narration has no asset"`. The comment there is explicit
   that this is the rule: *"A missing narration line must not stall the Foray."*
3. So the item is absent from `resolved.playable`, absent from `totalSec` and
   absent from `progressSegments` — which means **resume stays correct** and the
   queue cannot strand on it. `tools/foray/check-forays.mjs` mirrors the same
   `??` expression verbatim and warns rather than failing, so an unvoiced bridge
   is a blessed authoring state.

**Playback is safe. The page is not.** `resolveForay` still returns the item in
`entries`, so `app.js` renders it: `forayRow` takes the `!entry.playable` branch
and prints `Can't play: narration has no asset`, with an empty label and an
empty why-line — a narration item carries neither — and a meta line holding only
the estimated duration, because that is the one display field
`hydrateForayItems` stamps on it. `renderForay` then computes
`lost = r.unplayable.length` and prints a banner: *"15 segments can't play —
listed below."*

Fifteen bridges would therefore ship as fifteen near-blank rows and a banner
announcing the Foray is broken, in exchange for satisfying a rule no gate
checks. A Foray that plays is worth more than one that satisfies a rule on paper
and stalls on a phone, and this one plays: **19 of 19 items resolve,
`unplayable` is empty, `totalSec` equals `runtime_sec`.**

**What the seams get instead.** `player/seam-gap.js` spends **2.0 s** between
two auto-advanced segments — §6b's audiobook section-break number — so every
seam reached by playing straight through is marked as an edit. It is just not
*explained* as one. (A seam a listener jumps or scrubs to gets no beat; the rule
is `isSegment(from) && isSegment(to)` on an auto-advance, and it is
episode-agnostic rather than aimed at cross-episode seams.) The ordering above
was written to compensate: wherever possible the next segment's in-point is an
interviewer question that names its own subject, which is the closest thing to a
bridge that tape alone can supply.

**What is owed.** Fifteen bridge scripts and one voicing budget. The scripts can
be written at any time at zero cost and would slot into `items` as
`{ "type": "narration", ... }` entries without touching a single segment. The
runtime and `runtime_sec` would then need restating, and at 40.34 minutes there
are 4.66 minutes of headroom before the Foray crosses 45 minutes and D1's budget
drops from 8 to 6 — enough for roughly 15 bridges at the spec's 8 s ceiling,
with nothing to spare. **X2** (a bridge names its source) is unmet for the same
reason; `show` and `episode_title` are already on every hydrated entry, so a
bridge would have the attribution to hand.

---

## 5. Rule verdicts

`node tools/foray/check-forays.mjs` exits 0, and `node tools/ci/run-suites.mjs`
is green.

```
geology-plates-1 (draft): 19 segments, 40.3 min, mean 127.4 s
  D1 6/8 starts per 600 s   D5 0 triples, IQR 57.53 s
```

| rule | budget | this Foray |
|---|---|---|
| D1 rolling cut budget | ≤ 8 starts / 600 s (≤ 45 min band) | **6** |
| D2 burst rule | ≤ 2 consecutive < 60 s | 0 — the shortest segment is 62.5 s |
| D3 mean | ≥ 90 s | **127.4 s** |
| D4 quote share | ≤ 20 %, ≤ 2 adjacent | 0 quotes; all 19 are `explanation` |
| D5 pairwise triples | 0 | **0** |
| D5 IQR (R-7) | ≥ 45 s | **57.53 s** |
| L2 / L3 role bounds | 60–360 s for `explanation` | 62.5–238.8 s |
| L4 soft max | > 240 s needs `long_reason` | longest is 238.80 s — none needed |
| M3 chronology | never out of order | clean |
| M4 concentration | ≤ 25 % of segments and runtime | worst is McNamara, **15.8 % / 18.4 %** |
| X1 cross-episode narration | required | **unmet, 15 seams — §4** |
| M6 elision > 5 min ⇒ narration | required | **unmet, 2 seams — §4** |

D1 was never fought. The order in §2 was written first and measured second, and
the tightest ten minutes hold six starts against a budget of eight; no segment
was moved to buy a window.

**D5's IQR floor did real work and is worth recording.** Three successive drafts
of this order failed it at 39.8, 43.5 and 44.0 s, all under 45. The Geology Bites
batch has a fat middle — 11 of the first 18 candidates landed between 110 and
160 s — and the rule caught exactly the defect §2d of the rules doc describes: a
sequence that is individually varied and collectively metronomic. Fixing it
meant choosing tape at the tails on purpose (a 62.5 s close, a 69.5 s
counterexample, a 238.8 s centrepiece), not raising a number, and two mid-length
segments were dropped for it. The finished order reads better. One
mean-deviation warning remains (ELK-1 / CAW-1 / BREN-1, 14.5 %); `main` already
carries five of those and they are not gated.

**On `why` lines.** Every item's `why` comes from `data/segments.json` — that is
what `hydrateForayItems` renders (`why: seg.why ?? ""`), so a `why` written onto
a Foray *item* would be silently overwritten and never reach a listener. The
per-item editorial reasoning therefore lives in §3 of this document rather than
as inert JSON.

---

## 6. Would I listen to it?

Yes, and I would finish it. Slots 1, 4 and 5 are the strongest: 1 because it
sets a real puzzle in two minutes and answers it in four, 4 because it is a
descent with a genuine surprise at the bottom, 5 because it lands on a date and
a place name rather than a summary.

Three honest weaknesses:

- **Slot 3 is the thinnest**, and it is the only slot carried by a single voice.
  Van Hinsbergen is good and the three segments are a real argument
  (framing → finding → counterexample), but fourteen minutes in, the listener
  stops meeting new people for six minutes. A fourth voice belongs here. The
  candidate was Faccenna's toroidal-flow segment (`…faccenna…#770`, 193.6 s),
  cut to keep the Foray near forty minutes: adding it makes this a 43.57-minute
  Foray, which still clears the 45-minute band edge by 86 s but spends most of
  the headroom §4 wants for bridges.
- **JOHN-2 → EVAN-1 does not hold unbridged.** Iron provenance to
  supercontinents is a subject change the tape cannot make on its own. It is
  where a listener is most likely to wonder what they are hearing, and the
  honest description is that it works because Evans opens with a question, not
  because the two segments connect.
- **JOHN-1's in-point is the weakest in the Foray** — it lands mid-sentence on
  "ferrous iron, reduced iron" with no framing. That is the price of the
  MCN-3 → JOHN-1 seam, which is worth paying, but it is the clearest single case
  for a bridge in the whole running order.

The thing the last assembly attempt got right — that the tape can be good and
the sequence still not hold — does not apply here, and the reason is specific
rather than lucky: 125 episodes of one show, each a single researcher on a
single subject, means the connective tissue is already in the material. Drawing
across shows had to invent it.
