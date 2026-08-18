# Narration craft — how a Foray's narrator is written

The editorial half of the narrator charter (#247). This document answers five
questions a script author has to have answered before writing a line: how deep to
go, what a segue is, how much of a Foray may be narrator, what the words should be
like, and **how a script gets rejected.**

A parallel document owns *voice* — timbre, warmth, whether there are several
voices, what a 2026 TTS engine can actually deliver. This one owns *words*. Where
the two touch, this document defers.

**Status:** proposed. Nothing here has been voiced; no API was called to write it.
Every second-figure below is derived from a word count, and the word count is the
figure to trust — see §2a.

---

## 0. TL;DR — the numbers

**Six modes.** A script author picks one per item and the mode fixes the budget.

| mode | job | seconds | words | characters |
|---|---|---|---|---|
| **Hinge** | joins two pieces of tape — closes one, opens the next | 3–8 | 8–20 | 50–120 |
| **Frame** | introduces tape that carries the beat itself | 4–10 | 10–25 | 60–150 |
| **Marker** | announces structure — a fan, a boundary, a step out of sequence | 8–20 | 20–50 | 120–300 |
| **Correction** | bounds, attributes or contradicts adjacent tape | 6–12 | 15–30 | 90–180 |
| **Patch** | supplies the part of a beat its tape misses | 20–45 | 50–115 | 300–690 |
| **Carry** | *is* the beat; there is no tape | 45–110 | 115–275 | 690–1650 |

| | value | kind |
|---|---|---|
| Planning rate | **150 wpm, 6.0 chars/word → 15 characters per second** | convention + arithmetic (§2a) |
| Transition item ceiling | **8 s**, or **12 s** when the extra words are a required attribution or correction | divergence from `04_VOICE_AUDIO_SPEC.md` (§2b) |
| Narration item (Patch, Carry) | **not** a transition; the 8 s budget and the payback rule do not apply | our ruling (§2b) |
| Carry soft max | **150 s** → `needs_review`, must state what the extra minute does | invention |
| Carry hard max | **180 s.** The narrator is never the longest item in the Foray | invention |
| Consecutive Carry items | at most **2**, and adjacent empty beats in one chain **merge into one item** | invention (§2e) |
| Narration anti-uniformity | no 3 consecutive narration items within ±20 % of each other | inherited from `segment-length-rules.md` §2d |
| Tape-to-narration **inside a covered beat** | **≥ 90/10**, ceiling 85/15 | resolves the open question in `segment-length-rules.md` §2b |
| Whole-Foray narration share | **target ≤ 25 %, ceiling 35 %** | invention, derived in §4 |
| The essay line | **> 40 % is an essay with clips.** Not a Foray | invention |
| Enforcement | over-ceiling is fixed by **cutting beats, not words** — fan stops first, never chain links | invention (§4c) |
| Cost handle | **250 chars per covered beat, 600 per thin beat, 1,200 per carried beat** | derived (§4d) |

**Five things most likely to be missed.**

- **The ratio is a symptom, not a budget.** A Foray over the ceiling is not
  over-written; it is under-sourced. The fix is fewer beats or more tape (§4c).
- **The complete 40-beat barbecue Foray, written honestly on today's coverage, is
  about 43 % narrator.** It is therefore not shippable as a Foray, and the number
  says so before anyone writes a word (§4b).
- **A Carry item must name a source out loud.** The narrator has no on-air
  authority of its own, so an unattributed Carry is the product asserting on its
  own credit, which it has not earned (§5f).
- **The rejection test that actually catches fluent filler is the substitution
  test** (§6, R2): if the script would fit another beat of the same spine with only
  the proper nouns changed, it is filler, and it is rejected rather than trimmed.
- **A beat can be empty *and* unwritable.** That is a third verdict the coverage
  vocabulary does not currently have, and it is the honest answer for some beats
  (§6d).

---

## 1. What narration is for here, and the one rule everything derives from

### 1a. The inversion, and why it does not license an essay

`segment-length-rules.md` §2b left a question open and marked it founder-facing:

> Is Foray tape-forward (long segments, thin bridges, ~90/10) or narrator-forward
> (short segments, substantial bridges, ~50/50)?

That question was asked about *covered* beats, and this document answers it
tape-forward, unchanged: **where there is tape, the tape carries the beat and the
narration stays out of its way.** §4a holds the line at 90/10 inside a covered beat.

But the coverage numbers have since made a second question urgent, and it is not
the same one. The barbecue spine scored **11 strong / 9 thin / 20 empty** across 40
beats. The alcohol spine has 63 beats and predicts itself narration-heavier still,
with Act I — sixteen chained beats, the most important act in the document — the
thinnest. So on half the beats of a Foray there is no tape to be forward of. The
narrator is not connective tissue there. It is the content.

**That is a fact about coverage. It is not a licence.** The temptation it creates is
exactly the one #226 exists to stop, relocated: a spine with twenty holes and a
fluent narrator will produce twenty passages of plausible prose, and prose is
cheaper to manufacture than tape is to find. The Welsh bakestone segment was
off-plot tape that got admitted because it existed. A padded Carry is off-plot prose
that gets admitted because it can be written. **The second is worse, because tape
that does not fit its beat sounds wrong and prose that does not fit its beat sounds
fine.**

### 1b. The admissibility rule

The base rule is not ours. Mike Ladd, writing on the radio feature for Transom,
states it as a test on every line of script:

> "Only add script if it enhances what the audience hears for itself, adds depth,
> clears up confusion, condenses time and helps the production flow."

That is the whole doctrine and everything below is an operationalisation of it for a
product whose tape comes from strangers. Ladd's list is five licences. Foray's
structure adds a sixth — **carrying a beat that has no tape at all**, which a radio
feature never has to do, because a feature's producer went and recorded what was
missing. We cannot. That sixth licence is where all the risk lives, and §6 is the
gate on it.

The governing rule from #226 applies to a script exactly as it applies to a cut:

> "if we have content that is irrelevant, don't distort the narrative just to use
> more podcast content. Keep it mostly on topic."

Read for narration: **a script earns its place by advancing the claim of the beat it
is bound to.** Not by being about the subject. Not by being well written. Not by
smoothing a seam that did not need smoothing.

### 1c. Three things the narrator is not

- **Not a host.** No greeting, no sign-off, no "welcome back", no name of its own,
  no relationship with the listener. The narrator is the only recurring voice in a
  work otherwise made of strangers, and every ounce of personality it develops is
  an implicit claim to be the authority in the room, which it is not — the
  authorities are on the tape.
- **Not a summariser.** If narration says what the tape is about to say, the tape
  becomes illustration and the listener stops auditioning it (§3c).
- **Not a smoother.** Some seams should be audible. `player/seam-gap.js` spends a
  2.0 s beat at an unbridged seam *deliberately*, and its own comment says
  shortening it "was never the fix". Narration that exists only to make a seam
  disappear has replaced a good marker with a worse one.

---

## 2. The six modes

Named because a script author has to know which one they are writing, and because
the mode is what fixes the budget, the rejection test and the placement rule. Six is
deliberately small enough to hold in the head.

### 2a. The planning constants, and which figure to trust

Everything below is authored in **words** and reported in **seconds** and
**characters**, using two constants:

- **150 words per minute.** Convention, not measurement: it is the middle of the
  band that audiobook and broadcast-read guidance uses. Mark it as convention.
- **6.0 characters per word**, spaces and punctuation included. Arithmetic on
  English word length, not a measurement of our scripts.

Together: **15 characters per second of narration audio, and 900 characters per
minute.** Those are the numbers a cost model wants.

**The word count is the authored figure and the one to trust.** Seconds are a
prediction about an engine nobody has run yet, and characters are a prediction about
our own prose. The pipeline's dry-run mode reports exact characters, and the first
generated batch gives a real words-per-minute; when both exist, every second-figure
in this document is re-derivable from its word-figure, and the word-figures do not
change. Do not tune the word budgets to hit a seconds target measured later.

### 2b. Transition items and narration items are different things

This matters more than it sounds, because two existing rules assume all narration is
a transition, and on an empty-beat spine most of it is not.

`docs/brief/04_VOICE_AUDIO_SPEC.md` budgets **transition TTS ≤ 8 s: "close the last
item, bridge to the next."** `segment-length-rules.md` §3a then ties that budget to
the next segment's length through the payback rule,
`duration ≥ 4 × (bridge + 1) + 4` — an 8 s bridge demands a 40 s segment.

Both are right about transitions and both break on a Carry. A 90-second narration
item that *is* a beat is not machinery to be amortised; it is content. Run the
payback rule on it and it demands a 364-second segment after it, which is absurd,
and the absurdity is the tell that the rule is out of scope rather than wrong.

**The ruling this document makes, and it needs recording as a spec divergence in the
same way `segment-length-rules.md` §6b recorded the 0.5 s / 2.0 s one:**

| | transition item | narration item |
|---|---|---|
| modes | Hinge, Frame, Marker, Correction | Patch, Carry |
| duration | 3–12 s | 20–180 s |
| the spec's ≤ 8 s | applies, as a target | does not apply |
| the payback rule | applies | does not apply |
| `bridged: true` at the seam | yes — it is the bridge | it is an item, and the seams either side of it are their own question (§3h) |
| counts against the ratio | yes | yes |

**On the 8 s target specifically: it is not achievable together with the attribution
rule the curation docs already impose.** `segment-length-rules.md` §6c requires that
"every cross-episode bridge names its source — who is speaking, and what it is
from." Naming a source properly costs 8–12 words on its own — *"Adrian Miller, a
historian of Black foodways, on The Grill Coach"* is twelve words, about five
seconds — before the bridge has done any editorial work at all. So:

> **Transition ceiling.** 8 s is the target. **12 s is permitted only when the extra
> words are a required attribution or a required correction**, and the script records
> which. Anything longer is not a transition: type it as a narration item.

That is a real conflict resolved, not papered over. It touches the player's
accounting, so it wants a founder line the same way the 2.0 s divergence did.

### 2c. The modes

**Hinge — joins two pieces of tape. 3–8 s, 8–20 words, 50–120 characters.**
The workhorse. Closes what just played and opens what is coming. Used at every seam
where both sides are tape. It is the mode with the least licence: it may not
introduce a new claim, may not correct, may not announce structure. If it wants to do
any of those, it is a different mode and §3j says to split it.

**Frame — introduces tape that carries the beat. 4–10 s, 10–25 words, 60–150
characters.**
A Frame is a Hinge with an attribution obligation and a positioning job: it puts the
listener where they need to stand to hear a claim land. It states the *question* the
tape answers and never the answer (§3c). Every cross-episode Frame names its source.

**Marker — announces structure. 8–20 s, 20–50 words, 120–300 characters.**
Both spines demand this mode by name and neither had a word for it. The barbecue
spine: "Act III is a fan and must be announced as one… narration entering beat 8
should say plainly that the next stretch is a tour of traditions that do not descend
from each other, and that the American thread resumes afterwards." Beat 33 is a
"step out of the sequence and back". The alcohol spine: "each family boundary must be
announced as one," which it needs more often because it has more fans, and beat 17's
entry has to say "plainly that everything from here is the key applied."
A Marker over 12 s is authored as a narration item, not a transition — at an act
boundary it can afford to be its own item, and usually should be.

**Correction — bounds, attributes or contradicts adjacent tape. 6–12 s, 15–30 words,
90–180 characters.**
The mode the coverage report keeps asking for without naming. Barbecue beat 15 needs
two: the tape routes the Taíno claim through Spanish *barbacoa* where the spine holds
"jerk" arrives from Quechua *ch'arki*, and "used unframed, `#555` will imply the
lineage beat 15 exists to reject"; and the tape's low-smoke account "must be framed as
the tradition's account". Beat 22's tape pushes back on the spine's own claim. This is
the highest-risk narration in the product, so it has the tightest rules (§3f).
If a correction needs more than 12 s, it is a Patch.

**Patch — supplies the part of a beat its tape misses. 20–45 s, 50–115 words, 300–690
characters.**
The thin-beat mode. `grilling-history-coverage.md` §1 is explicit that "thin" is a
narration verdict — "a thin beat is a **narration beat** that happens to have a
partial supporting cut available… Every thin verdict below states what is missing so
that the narration can supply it." A Patch is written against that "what is missing"
sentence and against nothing else. It is the mode most likely to sprawl, because the
beat is genuinely half-open and the author can feel the gap.

**Carry — is the beat. 45–110 s target, 115–275 words, 690–1,650 characters. Soft max
150 s. Hard max 180 s.**
Twenty of forty barbecue beats and probably thirty of sixty-three alcohol beats. The
mode that is most of the product and all of the risk.
The hard max is a principle first and a number second: **the narrator is never the
longest item in the Foray.** 180 s is the top of the tape target band
(`segment-length-rules.md` §5a, 75–180 s), so the ceiling says the narrator may have
as much room as the best available tape and not one second more. The soft max at
150 s trips `needs_review` and the script must state what the extra minute buys —
the same shape as the 240 s soft max on segments.

### 2d. Two provenances of Carry, and they are not equally fixable

The coverage vocabulary treats every empty beat the same way. For narration they
divide, and the difference decides whether sourcing can ever help.

- **Carry-by-default.** The beat wanted tape and none exists. Barbecue beat 20 (the
  West African inheritance) is the clearest case: two English sources have now been
  spent on it without result. More sourcing could still close it — the coverage report
  names the remaining shots — so the Carry is provisional and the script should be
  written to be *replaceable* by tape.
- **Carry-by-design.** The beat's claim is a conclusion nobody states in one breath,
  so no tape can exist. Alcohol beat 16, the classification key: "almost certainly
  narration, and that is the right outcome"; the spine calls it "the most important
  beat in the Foray and almost certainly the least sourceable, which is a good
  illustration of why source-blindness matters." Barbecue beat 40 is "empty by
  design." Alcohol beat 63 likewise.

**The rejection posture differs.** A Carry-by-default that cannot be written honestly
may be dropped or deferred to more sourcing. **A Carry-by-design may never be
dropped**, because it is the beat the Foray exists to deliver — and it also may not be
padded, which is why it gets the largest word budget in the document and the strictest
version of R2.

### 2e. Consecutive Carry items, and the narration merge rule

Sixteen chained beats in alcohol Act I, predicted the thinnest act in the coverage
report, is a live risk of four unbroken minutes of TTS. That is not a narrated Foray;
it is a lecture with occasional guests.

> **Merge rule for narration.** Two or more adjacent empty beats in the same chain
> are authored as **one** Carry item, not one per beat, unless the merged item would
> exceed the 180 s hard max. Above the max, split at the most natural claim boundary
> and accept two items.

The reasoning is borrowed wholesale from `segment-length-rules.md` §6a, which merges
same-episode segments because a seam between them "signals continuity and the content
contradicts it." Two adjacent narration items are the same defect in its purest form:
same voice, same room, same loudness, ~0.5 s of padding between them, and nothing for
the listener to attribute the boundary to. There is no voice change to justify the
edit, so the edit reads as a glitch. One item that moves through both claims is
strictly better, and it is cheaper — one item's worth of framing instead of two.

> **Consecutive cap.** At most **2** narration items in a row after merging, and the
> second must be shorter than the first. A third means the Foray has run out of tape
> for a stretch long enough that the honest actions are the §4c ones: drop fan stops,
> or ship shorter.

> **Anti-uniformity.** No three consecutive narration items within ±20 % of each
> other, mirroring `segment-length-rules.md`'s D5. Uniformity is a defect there on
> measured grounds (§2d, film shot-length evidence) and the argument transfers
> directly: a Foray where every Hinge is 7 s develops a metronome, and a metronome is
> the sound of machinery.
