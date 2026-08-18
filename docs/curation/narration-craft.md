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

---

## 3. The segue

Our seams are not radio's seams. A radio feature cuts from a reporter who was in the
room to tape she recorded herself, that day, for this piece. A Foray cuts from one
stranger to another stranger — different show, different mic chain, different room,
different year, no knowledge of each other, no knowledge of us. Nobody has written
that seam down because until recently nobody had to make one.

The craft that transfers is nonetheless substantial, and it is worth being precise
about what is borrowed and what is ours.

### 3a. The established craft, and its exact shape

**Alison MacAdam's NPR Training toolbox, "Writing through sound: A toolbox for
getting into and out of your tape" (2015), is the closest thing to a published
taxonomy of this move**, and it is worth a script author reading in full. It names
twelve techniques, six in and six out. It also opens by naming the default and
calling it out:

> "The most common way we write into tape goes something like this: *Jane Doe,
> professor of economics at Clemson University, says the policy is short-sighted.*
> […] Basically, that's 'Person X, who has XX job, says Y about Thing Z.' This
> approach is OK, and sometimes it's the best choice, but… it's boring. Especially if
> it's the only way you introduce tape."

Getting **into** tape: *Tease + back ID* (tape first, identify after); *the Hint*
(inflection foreshadows); *Question → Answer* (the narrator asks, the tape answers);
*Signpost* ("in order to understand X, we need to talk about Y", "which brings us
to"); *Set-up → explanation* (general theme, then the specific voice); *Begin a
thought and let the tape complete it.*

Getting **out**: *"That is the sound of…"*; *React*; *Echo* (repeat a word from the
tape and build on it); *Take the next step*; *Emphasise / repeat*; *Complete the
thought or sentence.*

MacAdam also flags the two cautions that matter most to us. On teases: "Teases can
confuse your listener if the tape isn't catchy enough or the voice sounds similar to
other voices in your story." And on the unbridged butt cut, which she treats as a
legitimate technique: "If the voice or idea isn't distinct enough, you'll just confuse
your listeners."

**Karen Everett's documentary-narration tips** supply the complementary rule, and
hers is the one that survives translation from picture to tape best. Her sixth tip is
*"Say Cow? See Cow"* — "avoid saying in narration exactly what we're seeing on
screen." Her others that transfer: be conversational and read aloud; short sentences;
active voice; introduce names with a descriptive title first, "so listeners don't miss
them"; ask *need to know?* of every detail; avoid jargon or define it.

**Mike Ladd, on the radio feature**, supplies the texture rule: "Contrasting textures
bring both variety and clarity," and it is "far more important to hear *how* someone
says what they say" than to read the transcript. `segment-length-rules.md` §6d already
took the assembly consequence of that.

**RTDNA's editing guidance** supplies the constraint: "Don't add sounds that you
obtained at another scene or from another time or place if adding the sounds might
mislead the audience… it also encompasses rearranging sounds in time or place."
`segment-length-rules.md` §2g already reads this as binding on us. **Foray is
structurally the practice RTDNA is warning about**, which is why two of the rules
below are integrity rules rather than craft ones.

**Ira Glass's storytelling talks** are widely circulated as the source of the
*anecdote and reflection* pairing — a sequence of actions, then "somebody's gotta say,
here's why the hell you're listening to the story" — and the *raise a question, answer
it* engine. Flagged as **secondary**: the accessible texts are third-party transcripts
and summaries of talks, not a primary publication, and this document does not rest any
rule on it. It is recorded because it is the best available account of why a Frame that
poses a question works better than one that states a conclusion, and §3c's rule is
independently supported by Everett.

### 3b. The eight seams a Foray actually has

Naming them is most of the work, because a script author's first question is which
situation they are in, and the answer changes the mode, the length and the
obligations.

| | seam | mode | notes |
|---|---|---|---|
| **S1** | tape → tape, **cross-episode**, beat changes | Frame | the common case; attribution mandatory |
| **S2** | tape → tape, **cross-episode**, same beat | Frame | two shows on one claim; the seam must not imply they were talking to each other (§3g) |
| **S3** | tape → tape, **same episode, unmerged** | Hinge | must be marked; narration **required** where the elision exceeds 5 min (`segment-length-rules.md` §6b) |
| **S4** | tape → **narration item** | Hinge, then the item | the exit line hands off; do not write a Frame *for the narrator* |
| **S5** | **narration item** → tape | Frame, inside the item's last sentences | the strongest place in the Foray to use *Set-up → explanation* |
| **S6** | narration → narration | **none — merge** (§2e) | if genuinely unmergeable, the second item opens by naming why it is a new item |
| **S7** | **act or fan boundary** | Marker | states the structure, then hands to S1 or S5 |
| **S8** | **engineered handoff** — a beat that belongs to two structures | Marker + Frame, split | barbecue beat 15 → 16 is the worked case; see §7a |

### 3c. The spoiler rule — the single most important segue rule we have

> **A Frame states the question the tape answers. It never states the answer.**

This is the rule that decides whether a Foray is a work made of authorities or a
narrated essay with illustrations, and it is the one a fluent script author will break
first, because stating the claim is the easiest way to make a seam feel smooth.

Two established supports, from different traditions, pointing the same way: Everett's
*"avoid saying in narration exactly what we're seeing on screen"*, and MacAdam's
verdict on "Person X, who has XX job, says Y about Thing Z" — "OK, and sometimes it's
the best choice, but… it's boring."

The Foray-specific reason is stronger than either, and it is about attention rather
than about craft. **In a Foray the tape is the evidence for the beat's claim.** If
narration states the claim first, the tape becomes confirmation of something the
listener has already accepted, and a listener does not audition confirmation — they
wait it out. Two minutes of the best tape in the pool becomes two minutes of nothing
happening. The spoiler rule protects the thing the product is for.

Note the spec already holds a narrow version of this: `04_VOICE_AUDIO_SPEC.md`, "No
spoilers: narrative-format episodes get topic-shaped intros, not content summaries."
The rule above is that principle generalised from an episode intro to every seam.

**The mechanical check.** Delete the narration and play the tape. If nothing is lost,
the narration was redundant. If the tape is now unintelligible or unattributed, the
narration was doing its job. Run this on every Frame.

### 3d. Attribution, and which side of the seam it goes on

`segment-length-rules.md` §6c already requires that every cross-episode bridge names
its source. Three additions:

- **Attribute on the way in, not on the way out.** Everett's *Title First* —
  "introduce names with descriptive titles so listeners don't miss them" — and
  MacAdam's caution about teases both cut this way. Attribution after the fact makes a
  listener re-audition what they just heard, and a listener who is doing that has
  stopped hearing what is playing now. MacAdam's *tease + back ID* is a real technique
  and it is the exception: usable **once or twice in a Foray**, only where the tape's
  first line is arresting on its own, and never where the previous voice sounded
  similar.
- **Name the show once per source per Foray.** Thereafter *"the same conversation"*,
  *"later in the same interview"*, or the speaker's surname alone. Full re-attribution
  on every return costs 8–12 words each time, and by §4d that is real money.
- **A Carry names the literature.** See §5f — this is the rule that separates an
  honest narration beat from an assertion by an anonymous voice.

### 3e. Cross the distance once, and name only the axis that matters

Our seams cross place, time, discipline, register and room at once. The instinct is to
locate the listener fully. It is wrong.

> **One axis per seam.** A Frame that crosses a large discontinuity names *one* — the
> one the beat needs — in a single clause.

Argentina to Jamaica, barbecue beats 14 → 15, crosses about five thousand miles, two
languages, three centuries and two entirely different arguments. The seam should name
the one that does editorial work, which here is neither the geography nor the date: it
is that both are answers to the same question about fire, which is what makes the fan
a fan. **Inference**, and the reasoning is `segment-length-rules.md` §2a's measured
finding that the orienting response to a voice change does not habituate: the listener
is already spending attention on the new voice, so a Frame that hands them three labels
to file will get one filed and two dropped, and the author does not choose which.

### 3f. Corrections — correct forward for framing, backward for facts

The riskiest narration we write, because it is the narrator disagreeing with the only
people in the room who know anything.

> **Framing goes before the tape. Factual corrections go immediately after it.**

Framing changes how the listener *hears* what is coming, so it is useless afterwards:
barbecue beat 15's requirement that the tape's low-smoke account "be framed as the
tradition's account" only works if it precedes it, because by the time the segment
ends the listener has already filed the claim as fact. A factual correction is the
reverse — pre-empting it spends the listener's attention on an error they have not yet
made, and it makes the tape sound like a trap. Beat 15's *ch'arki* / *barbacoa*
correction belongs immediately after `#555`, not before it.

Four rules on the mode:

- **Adjacent, or not at all.** A correction that arrives a beat later has let a false
  belief set. If the seam cannot hold it, the beat's assembly is wrong.
- **Correct the claim, never the speaker.** "That lineage is disputed" and "she has
  the etymology wrong" are the same fact and only one of them is publishable. The
  speakers did not consent to being in our Foray and they are not here to answer.
- **A correction cites — always in the script, on air when it contradicts a person.**
  The script always records where the other account comes from. It is named *on air*
  when the correction contradicts a named speaker's stated position, and not when it
  corrects an incidental point of fact such as an etymology, where an on-air citation
  would cost more than the correction. A narrator that contradicts a named historian
  on its own unsourced authority is the worst sentence the product can emit.
- **Bound rather than contradict where that is honest.** If the speaker's argument
  survives the correction, say what the correction is *about* rather than that they were
  wrong. §7a does this with beat 15's etymology: the syncretism argument stands, and it
  is only the route of the word that is separate.
- **Never use a correction to bend tape toward a beat.** If the correction is doing
  the work of making off-beat tape fit, the tape is off-beat and the answer is
  rejection. This is the bakestone failure wearing a citation.

### 3g. The two integrity rules

These are not style. They are the RTDNA constraint made specific, and they are hard
rejects (§6, R5).

- **Never let grammar cross a cross-episode seam.** MacAdam's *Begin a thought and let
  the tape complete it* and *Complete the thought or sentence* are excellent
  techniques and they are **forbidden across S1 and S2**. A grammatical hand-off
  asserts that the two utterances are one thought, and when the speakers were recorded
  years apart and have never heard of each other, that assertion is false. Use them
  freely within one voice (S3) or inside a single beat's own tape.
- **Never let a Hinge imply a reply.** "But not everyone agrees", "*[speaker B]* sees
  it differently", "*[speaker A]* would push back on that" — each of these
  manufactures a conversation. The publishable form attributes the disagreement to the
  field rather than to the pairing: *"How much weight that evidence bears is
  contested."* Then the beat, not the edit, carries the disagreement.

### 3h. Silence, loudness and the bridged seam

`player/seam-gap.js` returns **0** when `bridged` is true — "Narration is a better
marker than silence and it carries the 0.5 s padding of its own spec. Silence on top
of it is dead air, not a beat." So at every bridged seam, the only thing separating two
strangers is ~0.5 s of pad and the narrator's voice. Three consequences for the words.

- **The narration has to *be* the marker.** It must be audibly a different act from
  the first syllable, which in copy terms means: never open a Hinge with a sentence
  that could plausibly be the previous speaker still talking. No mid-thought
  connectives — "and so", "which is why", "but the thing is". Open on a noun phrase or
  a short declarative.
- **Narration has a sacrificial head too, and it is about 1 s.**
  `segment-length-rules.md` §2a establishes on measured grounds that a segment's first
  ~4 s carries nothing load-bearing, because the listener is re-orienting to a new
  voice and room. The narrator's voice recurs and is loudness-normalised, so the cost
  is smaller — but §2a's finding is specifically that this cost **does not habituate**,
  so it is not zero. **Rule: no narration item opens on a load-bearing proper noun,
  number or date.** Two or three words of orientation first. *"Two thousand miles
  south, the same problem…"* before the name.
- **The Hinge is the ear's calibration point.** AES TD1004.1.15-10 warns of loudness
  jumps "of up to 7 LU" when externally-produced material is inserted into a program,
  and every cross-episode seam is exactly that insertion. A loudness-normalised
  narrator between two differently-mastered shows is the listener's reference level.
  So: **no dramatic pauses, no whispered asides, no trailing off.** The narrator is the
  most level-consistent thing in the Foray, on purpose. This is a copy rule as much as
  a mastering one, because trailing-off prose produces trailing-off audio.

**One recommendation for the pipeline, not built here.** At an act boundary a listener
benefits from *both* a beat of silence and a Marker — the silence says "that section is
over", the Marker says what the next one is. `seamGapSec({ bridged: true })` currently
returns 0, so that combination cannot be authored. An optional `pre_gap_sec` on a
narration item would allow it, and act boundaries are the only place it is needed.
Recorded as a request to whoever owns the pipeline document, not as a change.

### 3i. Never bridge into tape you have not heard

`grilling-history-coverage.md` says it twice: quotations from `bbqc-moss-school` and
from The Grill Coach are "lightly cleaned and indicative," and "anyone writing
narration against it should listen to the audio at the timestamp given." The SYSK
transcript is "machine-generated and undiarized."

> **A Frame or Hinge that quotes, echoes or completes the tape's own wording requires
> that the audio has been heard, and the script records that it was.**

MacAdam's *Echo* — "the reporter repeats a word or phrase from the tape, and builds on
it" — is one of the best out-of-tape techniques available and it is the one that fails
catastrophically on ASR text, because it puts a word in the narrator's mouth that the
speaker may never have said. Everything else can be written from a transcript. Echo,
*Complete the thought*, and any direct quotation cannot.

### 3j. One seam, one job

> A single transition item may not simultaneously announce a fan, correct the tape and
> supply a missing antecedent.

Twelve seconds does not hold three jobs, and a listener will take the first one.

**The remedies, in order, and the order matters because the first is nearly always
available:**

1. **Compress.** Three jobs fit in 25 well-chosen words more often than an author
   expects. §7a's third item carries an axis, an attribution and a forward framing in
   28 words.
2. **Move a job to the other side of the tape.** A factual correction goes after
   (§3f); an antecedent goes before. Two jobs on opposite sides of a segment are two
   items that are not adjacent.
3. **Move a job to a different seam.** A fan announcement belongs at the boundary, not
   at the seam after it.
4. **Promote to a narration item.** If the cargo is genuinely 20 s or more, it is a
   Patch, and a Patch is allowed to be a Patch.

**What is never the remedy: two transition items back to back.** That is the S6 defect
in miniature — same voice, ~0.5 s of padding, nothing for the listener to attribute the
boundary to — and §2e's merge argument applies to it in full force. Split means "two
items with tape between them", never "two items in a row".

### 3k. Every seam you do not make is a hinge you do not write

The cheapest narration is the narration that is not needed, and this gives
`segment-length-rules.md` §6a's merge rule a second argument it did not have.

A cut's cost used to be counted in seconds of bridge and in the payback arithmetic.
Now it also has a character price: **a Hinge is 50–120 characters and a Frame with
attribution is 60–150.** So a merge that removes one seam removes about **250
characters** of billable narration and one opportunity to write something wrong.

Worked in §7a: barbecue beat 15's two segments have an elided gap of 50.7 s, which
lands in `segment-length-rules.md` §6a's **"should merge"** band, and the coverage
report keeps them separate. Merging removes a Hinge and simplifies where the
*ch'arki* correction goes. That is a live assembly question rather than a ruling from
this document, and it is raised here because the narration cost is a new input to it.

---

## 4. The ratio

### 4a. Three ratios, not one, and the founder question splits along them

`segment-length-rules.md` §2b framed this as one number and marked it founder-facing.
It is three, and conflating them is why the answer looked like a product identity
crisis. Answered separately, two of the three are easy.

| | ratio | target | ceiling | who it is about |
|---|---|---|---|---|
| **R-beat** | tape : narration **inside a covered beat** | **90 / 10** | 85 / 15 | the format's identity |
| **R-foray** | narration as a share of **total runtime** | **≤ 25 %** | **35 %** | the Foray's honesty about its own coverage |
| **R-essay** | the line past which it is a different product | — | **40 %** | whether to ship at all |

**R-beat is 90/10 and this document does not move it.** Where tape exists it carries
the beat, and the machinery around it is a Frame in and a Hinge out — 110–270
characters against a 110-second segment. That is the inversion of radio's published
~50/50 copy-to-tape baseline, and the inversion is the product. Nothing in the coverage
numbers argues against it, because the coverage numbers are about beats that have no
tape at all.

**R-foray is the new number and it is the one that binds.** It is not a statement
about style. It is a statement about how much of a spine a Foray is allowed to
*narrate its way through* before it stops being a work made of authorities.

**R-essay is where the founder's own framing lands.** Past 40 % the narrator is
carrying the argument and the tape is illustrating it, which is a radio feature — a
good form, competently served by others, and not this one. At that point the honest
outputs are a shorter Foray or a written piece, not a longer script.

### 4b. The barbecue arithmetic, which is the reason the ceiling exists

Worked from `grilling-history-coverage.md`'s actual numbers rather than from a guess,
because the result is sharp enough to be a finding.

**Tape available.** Eleven strong beats. Six have measured segment durations in the
coverage report's projected-runtime table (beats 1, 5, 14, 15, 32 at 239, 79, 277, 322
and 127 s) and five more come from The Grill Coach and the proposed beat 4 cut (18, 21,
22, 24, 38 at 182, 171, 90 and two further cuts). Call the strong total **~1,960 s**.
Nine thin beats with a partial cut each at the report's typical lengths, **~990 s**.
Total tape **≈ 2,950 s ≈ 49 min**.

**Machinery for the 20 covered beats.** About 30 segments, so about 29 seams at an
average 7 s Hinge or Frame = 203 s. Five Markers at 15 s = 75 s. Four Corrections at
10 s = 40 s. Nine Patches at 32 s = 288 s. **Narration ≈ 606 s ≈ 10 min.**

**So the covered-beats-only Foray is 3,556 s (59 min) at 17.1 % narration.**
Comfortably inside target, and worth noticing: **a Foray made only of the beats that
have tape is not narration-heavy at all.** The whole problem is the empty beats.

**Now add empty beats.** Each carried beat costs ~80 s. The Carry budget available at a
given ceiling is:

```
narration_allowed = tape_sec × ceiling / (1 − ceiling)
carry_budget      = narration_allowed − machinery_sec
carry_beats       ≈ carry_budget / 80
```

| | narration allowed | headroom over machinery | empty beats carryable |
|---|---|---|---|
| target 25 % | 983 s | 377 s | **~5 of 20** |
| ceiling 35 % | 1,588 s | 982 s | **~12 of 20** |
| all 20 carried | 2,206 s | — | **42.8 % narration** |

**The finding: the complete 40-beat barbecue Foray, written honestly on today's
coverage, is about 86 minutes long and 43 % narrator.** That is past R-essay. It is not
a Foray, and the arithmetic says so before a word is written — which is exactly what a
ratio rule is for.

Three things follow, and the third is the useful one.

- Twelve of the twenty empty beats can be carried at the ceiling. Not twenty.
- **Which twelve is decided by structure, not by which are easiest to write** (§4c).
- **The number of empty beats a Foray can carry is a function of how much tape it has,
  not of how many holes its spine has.** This is the sentence a script author should
  hold on to. Sourcing one more strong episode buys about 180 s of tape, which buys
  about 97 s of narration at the ceiling, which buys **one more carried beat**. Tape
  and narration are not substitutes competing for runtime; tape is what *funds*
  narration.

### 4c. Enforcement — over-ceiling is fixed by cutting beats, not words

This is the rule that keeps the ratio from becoming a licence to compress.

> **When a Foray exceeds R-foray's ceiling, the narration is not trimmed. Beats are
> dropped, in this order: fan stops first, then thin-beat Patches whose missing
> material is not load-bearing, then nothing. Chain links are never dropped.**

The precedent is exact and it is already written down twice. `grilling-history-coverage.md`:
"A beat that comes back empty stays empty." The alcohol spine, §5: "An over-supplied
beat has no claim on runtime that an under-supplied beat lost. Time freed by an empty
beat 9 does not transfer to beat 37; it becomes narration on beat 9, or it becomes a
shorter Foray, **and a shorter Foray is a legitimate outcome.**"

Both spines hand over the drop order directly, and it is the same order in both:

| cheapest to drop | | most expensive |
|---|---|---|
| a fan stop — "a missing stop on a tour is invisible" | a missing step inside a family — "the process narrated up to a gap and then resumed past it" | a chain link — "a missing link in a chain is a hole" |

The alcohol spine's three-grade table (§2a) is the sharper version, and its verdict
is the allocation rule: **"Act I is the most dangerous place in the spine for a hole
and the small family stops in Acts II through V are the safest."**

> **Allocation rule.** Spend the Carry budget **chain-first**. Reserve it for chain
> links before any fan stop gets a second of it, and pay for the reservation by
> dropping fan stops. In alcohol terms: every one of Act I's sixteen beats gets carried
> before beat 25 (the milk alcohols) or beat 50 (arrack) gets anything, because Act I
> "cannot be reordered and cannot be entered late" and a missing family stop costs the
> listener nothing once the boundary is announced.

Note what this rule forbids, since it is the tempting move: **it forbids shortening
Act I's Carry items so that more fan stops fit.** The alcohol spine pre-empts the
mirror-image error in the same paragraph — "above all do not compensate by lengthening
a neighbour" — and the reasoning generalises. A derivation with a rushed step in place
of a missing one is still broken.

### 4d. The cost handle

For the cost model, three per-beat constants and one formula. At 15 characters per
second (§2a):

| beat verdict | narration | characters |
|---|---|---|
| **strong** (Frame + Hinge, share of a Marker) | ~17 s | **~250** |
| **thin** (the above + a Patch) | ~40 s | **~600** |
| **empty, carried** (a Carry, no separate machinery) | ~80 s | **~1,200** |

```
Foray narration characters ≈ 250·(strong) + 600·(thin) + 1200·(carried)
```

**Barbecue**, 11 strong / 9 thin, at the two ratio bounds:

| | carried beats | characters |
|---|---|---|
| target 25 % | 5 | **~14,150** |
| ceiling 35 % | 12 | **~22,550** |
| all 20 (fails R-essay) | 20 | **~32,150** |

**Alcohol**, projected — and flagged as **projection**, because no coverage report
exists yet. Taking the spine's own prediction that it will be narration-heavier with
Act I thinnest, and scaling barbecue's proportions across 63 beats gives roughly 15
strong / 18 thin / 30 empty, tape ≈ 4,680 s:

| | carried beats | characters |
|---|---|---|
| target 25 % | ~6 of 30 | **~21,750** |
| ceiling 35 % | ~18 of 30 | **~35,000** |

So the planning figures a cost model should use are **14k–23k characters of narration
for a barbecue-scale Foray and 22k–35k for an alcohol-scale one**, with the upper
figure of each pair being a ceiling that should not be treated as a plan.

**Re-generation factor: budget 1.5×, and treat anything above 2.0× as a process bug
rather than a cost.** The rejection test in §6 is designed to run on text, before
anything is voiced, and the charter's dry-run requirement exists precisely so that a
rejected script costs nothing. A high re-generation factor means the review gate is
being run *after* generation. That is fixable for free.

**One number this document does not give.** Per-Foray cost in currency, and the count
of Forays. Those belong to the parallel cost work, and the input it needs from here is
the character range above plus the sentence that the ceiling row is not a plan.

---

## 5. The words

Voice is somebody else's document. This section is about what is on the page: person,
tense, register, sentence, number, uncertainty, attribution.

### 5a. Person

- **Third person. The narrator never says "I".** Not once, in any mode. An "I"
  invents a character, and a character has opinions, a biography and a relationship
  with the listener — none of which the product has designed and all of which would
  compete with the people on the tape. This is the copy-side consequence of the same
  fact the voice document is grappling with: the narrator is the only recurring voice
  in a work made of strangers, so every claim it makes on the listener's attention is
  a claim it takes from a source.
- **"We" only where it means humanity**, and only where the beat already does. The
  barbecue spine's Act I is about "the animal doing it", and *"we"* meaning our species
  is correct there. **"We" never means the makers of the Foray.** No "we found", no "we
  could not find a source for this" — see §5e for the publishable form of that
  sentence.
- **"You" is permitted for exactly one job: handing the listener a tool.** The alcohol
  spine's beat 16 is written to a second person by design — "the listener can now place
  a drink they have never heard of", and the beat's proof is "running an unfamiliar one
  through the key from scratch." A key is used by somebody, and telling them so in the
  second person is the whole point. Outside that job, "you" is presumption.

### 5b. Tense

> **Present tense for mechanism. Past tense for history. Never the historical
> present.**

This looks like a style preference and it is load-bearing, because of a structural
decision both spines made. The alcohol spine, §2c: "History is not an act. It is
admitted beat by beat, and only where it explains a production fact." So mechanism and
history are interleaved *inside single beats*, and the listener has no chapter heading
telling them which they are hearing. **In audio, tense is the only cue available.**
Collapse it into a dramatic historical present — "it is 1801, and a Frenchman is
building a column" — and the listener loses the one signal that separates "this is how
the thing works" from "this is how it came to work that way." That distinction is the
whole difference between the Foray the founder asked for and a story about drinks.

The same applies to barbecue's two-clause through-line: technique is present tense
("collagen converts to gelatin"), labour and history are past ("the work was performed
by enslaved people"). Where a beat asserts a live continuity, say so in a clause rather
than by borrowing the wrong tense.

### 5c. Register

Sentence case. No exclamation marks. Beyond that, a list of bans, each with the reason
it earns one:

- **No adjectives of significance.** Remarkable, fascinating, surprising, extraordinary,
  striking. The beat's claim should be interesting; asserting that it is interesting is
  the most reliable tell of a script written to fill a length rather than to make a
  point. Treat every instance as a §6 R2 signal.
- **No "imagine", no "picture this", no second-hand awe.** The narrator did not see it
  either.
- **No suspense constructions.** "Little did they know", "but there was a problem",
  "what happened next changed everything." A Foray is an argument, and its unit of
  interest is a claim being established, not a reveal being withheld.
- **No rhetorical questions**, with one exception: MacAdam's *Question → Answer*, where
  the narrator asks and **the tape answers immediately**. A question the narrator then
  answers itself is a padding pattern.
- **No throat-clearing openers.** "It turns out", "as it happens", "interestingly",
  "of course", "now". Cost: three to six characters per instance, dozens of instances
  per Foray, and zero information.
- **Contractions are correct.** Everett's first tip is "use colloquial language and
  contractions; read aloud to ensure it's speakable," and a TTS engine reads a
  contraction more naturally than the expansion.
- **Jargon is defined at first use or replaced.** Everett's ninth. In a process Foray
  this is constant work: the alcohol spine's Act I has sixteen beats of mechanism, and
  a term used before it is defined costs the listener the rest of the derivation.

### 5d. Sentences and numbers

| | rule | why |
|---|---|---|
| mean sentence length | **12–15 words** | Everett's "short sentences"; at 150 wpm a 20-word sentence is 8 s of unbroken breath, the entire transition budget |
| maximum sentence | **25 words**, one level of subordination | past that a listener holds a clause open across a comma they cannot see |
| rhythm | any narration item over 20 s contains **at least one sentence under 6 words** | anti-uniformity at the sentence scale; the reasoning in `segment-length-rules.md` §2d is about texture, and prose has texture too |
| voice | **active** | Everett's fifth. Also: the passive is how an unattributed claim hides — "it is thought that" has no subject on purpose |
| openers | no sentence begins with a long participial phrase | Everett's second: "move descriptive phrases to sentence endings instead" |
| numbers | **one number per sentence, at most three per narration item** | a spoken number cannot be re-read |
| number form | written as spoken — "about eighteen hours", "eighteen-oh-one", not "18 hrs" or "1801" | correctness for the ear and for the engine; a numeral is an instruction to a TTS voice that we have not tested |
| precision | round unless the precision is the point | "roughly two centuries" is honest; "204 years" is a false claim about our own confidence |

### 5e. Uncertainty — four calibrated forms, and the rule that governs them

The narrator must use **the weakest form the evidence supports**, and the fourth form is
allowed.

| | form | pattern | when |
|---|---|---|---|
| **U1** | flat assertion | *"Collagen converts to gelatin above about 70 degrees."* | the spine's claim asserts it and a named source supports it |
| **U2** | attributed | *"Adrian Miller's account of the newspaper record is that…"* | the claim is one scholar's, or is a reading of evidence |
| **U3** | contested, with the axis named | *"How the transfer is traced is argued, and the argument is about how much weight comparative practice can bear."* | there is a real disagreement — name what it is about, not merely that it exists |
| **U4** | **absent** | *"No recorded conversation we could find makes this argument at length."* | we looked and there is nothing |

**U4 is permitted, and it is better than filling.** This is not a concession; it is the
standard the spines already hold *tape* to. The barbecue spine on beat 1: "Tape that
*names the disagreement* is better tape than tape that asserts the tidy version, because
the disagreement is what makes this history rather than a fun fact." On beat 15, the
chosen segment "says out loud that **there is no direct evidence** for the transmission.
The spine explicitly prizes a speaker who says so over one who asserts it." On beat 20:
"A speaker who is explicit about how much weight that evidence bears is worth more than
one who asserts a direct line."

> **The narrator's uncertainty vocabulary must be at least as good as the best tape's.**
> If a segment earns its place partly by saying "there is no direct evidence", a
> narrator that will not say the same thing about its own material is held to a lower
> standard than the strangers it is introducing.

**Banned outright — the unattributed hedges.** "Some say", "it is believed", "many
historians believe", "legend has it", "it is often said", "experts think", "some
argue". Each has the grammatical shape of U2 or U3 with the attribution deleted, which
means it manufactures authority out of nothing while sounding careful. **This is the
fluency failure in a single phrase**, and it is the highest-yield thing to grep a script
for.

Note the asymmetry with the internal documents. `grilling-history-coverage.md` writes in
the first person and says "I cannot know that" — correct for a working document with a
named author. The narrator has no author and no first person, so its version of the same
honesty is U4 in the third person.

### 5f. Attribution, and the rule that makes a Carry honest

**Pattern:** name, then standing, then show — *"Candice Goucher, an archaeologist who
works on African and Caribbean transmission, on The Moreish Podcast."* Everett's *Title
First*: the descriptive title comes before the listener has to do anything with the
name. Show named once per source per Foray (§3d).

**And then the rule this document most wants remembered:**

> **Every Carry item names, out loud, at least one source it is standing in for.**

The reasoning is not politeness and it is not citation hygiene. **The narrator has no
on-air authority of its own.** Every other voice in a Foray arrives with a show, a
guest credit and a reason to be believed. A Carry item arrives with none of that, so an
unattributed Carry is the product asserting on its own credit — credit it has not
earned and has no mechanism for earning. It is also, exactly, what a padded beat sounds
like, which is why this rule and §6's R3 are the same rule seen from two sides.

For beats where no tape exists, the source named is the **literature**, and the coverage
report usually says which: on barbecue beat 20, "the argument lives in Twitty and in
Miller's own book"; the spine says "Twitty and Miller are the archetype of the
register." So the Carry says so. **A Carry that names a book is doing something a
podcast segment cannot do**, which is worth noticing — it is the one respect in which
a narration beat is better than the tape it replaces, and it is the reason a Carry is a
legitimate artefact rather than a patch over an absence.

**Attribution slots are a hard generation gate.** A script with an unfilled speaker
name — `[speaker: confirm from audio]` — must fail the dry run and must not be voiced.
Both worked examples in §7 carry such a slot, because the coverage report describes the
Argentina guest and the jerk researcher without naming them, and inventing a name is
the single worst thing this pipeline could do.

---

## 6. How a narration script gets rejected

The load-bearing section. Everything above is craft; this is the gate, and it exists
because #226's rule applies to a script exactly as it applies to a cut: **a narration
script must be rejectable for being off-beat.**

The parallel is deliberate and it should be maintained in the tooling. Tape is scored
against a claim by a stage-2 pass that is allowed to return "empty". A script is scored
against the same claim by the tests below and they are allowed to return "unwritable".

### 6a. The six tests

A script fails if it fails **any one**. Order matters only in that R1 and R2 are the
cheap ones and catch the most.

**R1 — the licence test (relevance).**
Read the beat's claim sentence. Then read the script one sentence at a time. Every
sentence must have exactly one of six licences, and the script records which:

1. it asserts or supports **this beat's claim**;
2. it is a **required attribution** (§5f);
3. it is **required structural signposting** — a Marker's job (§3b, S7);
4. it is a **required correction** of adjacent tape (§3f);
5. it supplies an **antecedent the tape assumes** and the coverage report names as
   missing;
6. it is the **sacrificial head** — two or three words of orientation (§3h).

A sentence with no licence is cut. **If more than about a quarter of the item's words
have no licence, the item is rejected rather than trimmed**, because a script that
needed that much filler was written to a length instead of to a claim, and trimming it
leaves the same script shorter.

**R2 — the substitution test. This is the one that catches fluent filler.**

> **Take the script. Change only the proper nouns. Could it now sit under a different
> beat of the same spine? If yes, reject.**

This is the test the product actually needs, because the failure mode is not prose that
is wrong — it is prose that is *plausible*, and plausible prose is exactly prose that
would fit anywhere. A script bound to a specific claim cannot be relocated: its
sentences depend on that claim's mechanism, its numbers, its named evidence and its
place in the chain. A script that is really a well-turned paragraph about barbecue in
general will relocate cleanly, and the relocation is the proof.

The failing form is easy to recognise once named. It moves from the general to the
general; it states that something mattered, was important, shaped what came after; it
attributes to nobody; and it contains no number, no mechanism and no name that the beat
could not do without. §7b shows one and runs the test on it.

Two cheap proxies for R2 that a checker could apply, both signals rather than verdicts:
zero named sources in a Carry (that is R3 anyway), and zero of the beat's own evidence
vocabulary — the "evidence that counts" paragraph of every spine beat is a ready-made
keyword set, and a Carry that contains none of it is very likely relocatable.

**R3 — the evidence test.**
**Every factual assertion in any mode** is attributable to a named source **recorded in
the script** — a Frame that supplies an antecedent is asserting it on the narrator's
credit too, so the recorded-source half of this test is not confined to the long modes.
**On-air naming** is what is confined to Patch and Carry, where at least one source is
spoken (§5f). No source means the sentence is a banned hedge (§5e) or is cut. An
unfilled attribution slot is a generation-blocking failure, not a warning.

**One exception, and it is narrow: the synthesis Carry.** A beat whose claim is a
conclusion drawn from the Foray's own preceding beats — alcohol beat 16, the
classification key; both spines' codas — attributes **to the Foray's own prior tape**,
and says so: *"everything in that key came from the people you have just heard."* That
is real attribution, it is checkable against the assembly, and it is available only to
a beat that is genuinely a synthesis. It is not available to a Carry-by-default that
would like to skip R3.

**R4 — the spoiler and redundancy test.**
For Frame and Hinge: does the script state the claim the adjacent tape makes? Reject
(§3c). Then run the deletion check: remove the narration and play the tape. If nothing
is lost, the narration is redundant and is cut; if the tape becomes unintelligible or
unattributed, the narration is doing its job.

**R5 — the juxtaposition test (integrity, hard reject).**
Does the script imply agreement, disagreement, sequence or reply between speakers
recorded years apart in different rooms? Does grammar run across a cross-episode seam?
Does a Hinge attribute a position to a speaker in order to set up the next one? Any of
these is a hard reject on RTDNA grounds, not a style note (§3g).

**R6 — the budget test (mechanical, checkable).**
Mode band respected. Transition items ≤ 8 s, or ≤ 12 s with the reason recorded.
Carry ≤ 150 s without `needs_review`, ≤ 180 s absolutely. Adjacent empty beats merged.
At most two consecutive narration items. No three consecutive narration items within
±20 %. Foray R-foray share within ceiling. Sentence mean and maximum. Numbers per item.
Banned-phrase list clean.

### 6b. What R1 and R2 look like together

R1 catches a script that wandered. R2 catches a script that never went anywhere. They
are different defects and a padded beat usually passes R1 — every sentence is *about*
the beat — while failing R2 completely, because being about a subject is precisely what
generic prose does. **R2 is the test to run first on a Carry.** R1 is the test to run
first on a Patch, because a Patch's failure mode is scope creep into material the tape
already covers.

### 6c. Who rejects, and what happens to a rejected script

The discipline is `grilling-history-coverage.md`'s: **label, never exclude.** A rejected
script stays in the repo with its rejection reason recorded against the beat, exactly as
rejected segments stay in `data/segments.json` with theirs. Three reasons: the next
author needs to know what was tried; a rejection is evidence about the beat, not only
about the script; and a script rejected under R2 for a beat that later gains tape may be
recoverable as a Patch.

Recorded as a request to the pipeline document: **a rejection reason is a required field,
and a rejected script is not deleted.**

### 6d. Unwritable — the third verdict, and the escalation

Here is the case the coverage vocabulary cannot currently express. A beat is empty. An
author sits down to Carry it. The script cannot pass R2 and R3 — there is nothing
beat-specific and sourced to say, because the material genuinely is not in reach of
anybody writing from what we have.

**That beat is not a narration beat. It is unwritable, and "write it anyway" is not
among the options.** The escalation, in order:

1. **A fan stop: drop it.** Both spines say a missing fan stop is invisible once the
   boundary is announced. This is the cheap and correct outcome and it needs no
   permission.
2. **A chain link: do not ship the act.** Keep sourcing. The barbecue coverage report
   already models this — it names the remaining shots for beat 20 and says that if
   neither lands, "beat 20 is a narration beat permanently and should be written as one
   rather than left open."
3. **The claim is the problem: recommend a spine amendment.** Two are already pending
   (beats 22 and 27). A beat whose claim cannot be written *or* sourced may be a beat
   whose claim is wrong, and that is a finding worth recording rather than a script
   worth faking.

> **The rule, stated to match the one it mirrors.** A beat that comes back empty stays
> empty. **A beat that comes back unwritable stays unwritten.**

**Recommendation to the coverage-report vocabulary:** carry `writable` / `unwritable` as
a second axis on empty beats, and record it at the same time as the empty verdict rather
than discovering it at script time. Stage 2 already knows enough to predict it — an
empty beat whose literature the report can name (beat 20: Twitty, Miller) is writable; an
empty beat where the report cannot say what would be said is not. This document does not
edit the coverage report; it recommends the addition.

### 6e. The thing that makes narration harder to police than tape, said plainly

Bad tape announces itself. The Welsh bakestone segment was audibly about Welsh
bakestones, and anyone listening to the Foray heard a subject change. **Bad narration
does not announce itself.** It is in the house voice, at the house level, in the right
place, at the right length, on topic, grammatical, and it can be produced without limit.
Every quality signal a listener has access to says it belongs.

Which is why the gate is written as text tests run before generation, and why R2 exists
in the form it does. **The only reliable evidence that a Carry is not filler is that it
could not have been written for any other beat.** Everything else — fluency, relevance,
correct length, pleasant delivery — a padded beat has too.

---

## 7. Worked examples

Real beats, real segment ids, real timestamps, from `grilling-history-coverage.md`. The
scripts are **illustrative drafts written to demonstrate the rules**, not approved copy:
each carries at least one `[slot]` that is a generation gate (§5f), and none has been
checked against the audio, which §3i requires before any of them could be voiced.

Word and character counts are exact. Seconds are at the §2a planning rate.

### 7a. Bridging strong tape — barbecue beats 14 → 15

Chosen because it is the hardest real seam in the corpus that has strong tape on both
sides. Argentina to Jamaica: two shows, two voices, two rooms, two hemispheres, and
both are fan stops inside Act III, so neither depends on the other. It also contains a
same-episode seam and a required correction, so it exercises four of the eight seam
types in one stretch.

**What the tape is.**

| | segment | window | length |
|---|---|---|---|
| 1 | `bbqrn-argentina-open-fire#700` | 699.72 → 848.26 | 149 s |
| 2 | `bbqrn-argentina-open-fire#1205` | 1204.72 → 1332.44 | 128 s |
| 3 | `moreish-jerk-jamaica#266` | 266.01 → 503.94 | 238 s |
| 4 | `moreish-jerk-jamaica#555` | 554.64 → 638.62 | 84 s |

**Three facts about that table decide the whole assembly, and two are easy to miss.**

- **`#700` plays first, though the coverage report lists `#1205` as "Chosen" and `#700`
  as "Second".** Those labels are a quality ranking, not a play order.
  `segment-length-rules.md` §6c makes same-episode chronological order an integrity rule,
  not a preference. So the report's instruction that the missing antecedent goes "ahead
  of `#1205`" resolves, in the assembly, to *ahead of `#700`*.
- **The gap between `#700` and `#1205` is 356.5 s — five minutes fifty-six seconds.**
  Past 180 s, so §6a keeps them separate; past 5 minutes, so §6b **requires narration**
  rather than silence, "because across a large gap the listener will otherwise build a
  false model of continuity."
- **The gap between `#266` and `#555` is 50.7 s**, which lands in §6a's *should merge*
  band. The coverage report keeps them separate. See the note at the end of this
  example.

**The script.**

> **Item A1 — Frame, into `#700`. 27 words, 156 characters, ~10.8 s.**
>
> *"The pampas made beef cheaper than almost anywhere on earth, and an export trade
> kept it that way. Scarcity is not the constraint here. [speaker], on [show]."*

Why it is built that way. It carries the antecedent the coverage report says is "nowhere
in the tape" — pampas abundance and the export economy — which is R1 licence 5, and then
attributes, which is licence 2. It is **10.8 s, over the 8 s spec target**, and it
invokes §2b's exception explicitly: the extra words are the required attribution. It
states the beat's *precondition* and not its claim — the claim is that the craft moved
into fire management, and the tape makes it (§3c). Two `[slot]`s, because the coverage
report describes the guest and the show without naming either, and the in-anchor's
*"Al, how do you"* is a hint, not a name.

**What is not in it, and this is the instructive part.** Beat 14's claim also says the
asado "formalised the person doing it into a social office, the asador," and the
coverage report flags that as missing from the tape and "a real loss." **It is not in
this script, because there is no source for it in reach.** Under R3 a narrator may not
assert it on its own credit, and under §3f it cannot be smuggled in as a correction. So
the beat ships without the asador-as-office claim and the coverage report's flag stands
as a sourcing action. That is the gate working: the missing material stayed missing
rather than becoming plausible prose.

> **Item A2 — Hinge, `#700` → `#1205`, same episode. 18 words, 98 characters, ~7.2 s.**
>
> *"Six minutes later, the same conversation, and the question is how you know when the
> fire is ready."*

Seam type S3. It **states the elision** as §6b requires, in §6b's own idiom. Then it
poses the question the tape answers — the hand over the grill, the two-second count,
"you are actually engaged in the cooking process" — and states none of it (§3c). At
7.2 s it is inside the 8 s target with no exception needed, because a same-episode Hinge
needs no attribution: the voice has already been introduced. **This is why S3 seams are
the cheapest narration in the product**, and it is a reason to prefer assemblies that
have some.

> **Item A3 — Frame with a forward framing, `#1205` → `#266`. 28 words, 187
> characters, ~11.2 s.**
>
> *"The same question about fire, answered in the Caribbean. [speaker], who researches
> Jamaican foodstuffs, on The Moreish Podcast, giving the tradition's own account of
> where jerk came from."*

Seam type S1, and the seam that wanted three things: an axis, an attribution, and beat
15's required framing of the tape's low-smoke account as "the tradition's account". Per
§3j the first remedy is compression, and compression worked — three jobs in 28 words.

**One axis, chosen deliberately (§3e).** The seam crosses five thousand miles, three
centuries and two languages. It names none of them. It names the *fan* — "the same
question about fire" — because that is the axis that does editorial work: both traditions
are independent answers to one physical problem, which is the whole reason Act III is a
fan and not a tour. Naming the geography would have been true and would have taught the
listener nothing.

**And note what it does not do.** It does not say the Maroons freed themselves, or that
salt was scarce and wood ash substituted, or that pimento wood is the constant. Those
are the beat's claim and the tape makes all three.

> **Item A4 — Correction, immediately after `#555`. 27 words, 152 characters, ~10.8 s.**
>
> *"One thing the name does not show. Jerk reaches English from ch'arki, a dried-meat
> word from the Andes, by way of Spanish. A separate road from barbacoa."*

The coverage report's warning is that `#555` "routes the Taíno claim through Spanish
*barbacoa*" and that "used unframed, `#555` will imply the lineage beat 15 exists to
reject."

Four rules visible at once. **Backward, because it is a fact** (§3f) — pre-empting it
would have made the tape sound like a trap. **Bounding, not contradicting**: the
speaker's actual argument is the syncretism and the honest admission that there is no
direct evidence, and that argument survives untouched; only the road the word took is
separate. **Not the speaker**: no version of "she has that wrong" appears.
**Cited in the script, not on air**, per §3f's refinement: an etymology is a
lexicographic fact rather than a rival scholar's position, and a ten-second correction
cannot afford an on-air citation. The script records the source; the air does not.

**The stretch, totalled.**

| | |
|---|---|
| tape | 599 s |
| narration | 4 items, **100 words, 593 characters, ~40 s** |
| narration share of the stretch | **6.3 %** |

**That is R-beat working, and it is worth pausing on**: the hardest seam in the corpus,
carrying an antecedent, an elision statement, a fan axis, two attributions and a
correction, still comes in at 6 % narration, inside the 90/10 target with room. **Covered
beats are not where the ratio problem lives.** §4b's arithmetic said so and this is the
demonstration.

**Two loose ends recorded rather than resolved.**

- **The merge question.** `#266` and `#555` are 50.7 s apart, in §6a's *should merge*
  band, kept separate by the coverage report. Merging removes one Hinge — about 250
  characters (§3k) — and it also changes where A4 can go, because a merged segment ends
  on `#555`'s out-anchor and the correction still lands immediately after. The counter is
  that the merged segment is 372.6 s, which is inside the 480 s `exchange` maximum and
  past the 360 s `explanation` one, so the segment's role decides it. **An assembly
  question, flagged with its narration cost attached.**
- **The exit.** Beat 15 is the fan's engineered exit and hands to beat 16, which is
  empty. So the next thing after A4 is an S8 seam into Act IV, and because beat 16 is a
  Carry, §2e says the act's Marker **merges into the head of that Carry item** rather
  than being its own item. That is the S7-plus-S6 case, and it is why the Marker budget
  allows 20 s: at an act boundary it is usually paying for the first sentences of a
  narration item rather than for a transition.

### 7b. Carrying an empty beat — barbecue beat 20

The most important example in this document, because beat 20 is the worst case the
product has: **an empty beat, on a chain, in the most dangerous act, carrying part of
the Foray's central argument, with two English sources already spent on it and nothing
to show.** The spine: "Cut this and the strongest version of the Foray's central
argument is unavailable." The coverage report: "Chain hole, and it weakens the Foray's
central argument."

It is also the beat where the temptation to write fluent filler is strongest, which is
why this section shows a failing script as well as a passing one.

**What the coverage report licenses and forbids.** This is the input a Carry author works
from, and beat 20's entry is unusually explicit:

- The argument "lives in Twitty and in Miller's own book," and the spine names "Twitty
  and Miller" as "the archetype of the register."
- The Goucher episode was transcribed for this beat and rejected — "zero occurrences of
  barbecue, barbacoa, jerk, Maroon, smoke, fire, grill, pit, charcoal, wood, butcher,
  allspice, pimento or vinegar." Its one relevant passage "contains no fire, no butchery,
  no seasoning lineage, and it is about the Caribbean rather than the American South."
  **So Goucher may not be cited for this beat's claim**, however good the episode is.
- The Grill Coach touches the inheritance in one clause — "European cooking and African
  cooking and smoking" — inside beat 18's cut, "which is a mention, not the beat."
- The beat's reject line, which now applies to the script as well as to tape: "generic
  statements that African cooking influenced Southern food, with no technique and no
  mechanism of transfer."

**Where it sits.** Beat 20 is immediately before beat 21, whose segment is
`grill-coach-adrian-miller#1792`, played as `GC-1`. **So the Carry hands directly to
Miller**, which turns out to matter.

**The passing script — Carry, 189 words, 1,101 characters, ~75.6 s.**

> *"Three inheritances meet in American barbecue, and one of them has been the hardest
> to trace.*
>
> *The indigenous pit and the raised grate are the apparatus. European livestock
> supplied the animal. The third is the cooks.*
>
> *Michael Twitty and Adrian Miller argue the same thing about them, in The Cooking Gene
> and in Black Smoke. The people forced to do this work did not arrive as labour to be
> pointed at somebody else's technique. West and Central Africa had live-fire cookery of
> its own, whole-animal butchery, and a seasoning practice built on pepper and acid, all
> of it long before the Atlantic trade.*
>
> *How that gets traced is the hard part, and it is worth saying what the argument is
> actually about. There are almost no documents. The evidence is comparative practice,
> later testimony and archaeology, and the disagreement is over how much weight that
> combination carries. Both men are explicit about it.*
>
> *No recorded conversation we could find makes this argument at length. So what you
> have just heard is a summary of theirs, and Miller himself, on The Grill Coach, makes
> the case that follows from it."*

**Why it passes, test by test.**

- **R1.** Paragraph one is the beat's frame; two, three and four are the claim; five is
  U4 plus an S5 Frame into `GC-1`. No unlicensed sentence, and nothing about barbecue in
  general.
- **R2, the substitution test.** Change the proper nouns and it goes nowhere. *The
  Cooking Gene*, *Black Smoke*, "comparative practice, later testimony and archaeology",
  "how much weight that combination carries" and the three-inheritance structure are all
  specific to this beat's claim and to its named reject criterion. There is no other beat
  in the spine it fits.
- **R3.** Two named sources, both spoken. Two named books. The evidentiary argument
  attributed to the people who make it. No hedge without a subject.
- **R4.** It does not state beat 21's claim — beat 21 is about the labour system and
  about authorship, and nothing here trespasses on it. Checked, because a Carry that
  hands to tape is a Frame in its last sentence and inherits the spoiler rule.
- **R5.** No implied conversation. Twitty and Miller are named as agreeing because they
  do agree in print, and the script says so as a fact about their books rather than as an
  artefact of the edit.
- **R6.** 75.6 s: inside the 45–110 s Carry band, well under the soft max. Twelve
  sentences, mean 15.8 words, longest 34 — **which is one violation**, and the fix is to
  split the West-and-Central-Africa sentence. Recorded rather than hidden, because a
  worked example that quietly passes every test it was written to pass is not a
  demonstration.

**Three things this script does that a script author should copy.**

1. **U4 out loud.** *"No recorded conversation we could find makes this argument at
  length."* This is the sentence the whole §5e ladder exists to make sayable, and it is
  the difference between a narration beat and a fake segment. It also costs 12 words.
2. **It names the literature, which is something the tape cannot do.** A Carry that says
  *The Cooking Gene* and *Black Smoke* gives the listener two things to go and read. **A
  narration beat is not purely a loss.**
3. **It carries the beat with the literature of the voice who speaks next.** Naming
  Miller in the Carry costs nothing extra and turns the whole 76 seconds into a Frame for
  `GC-1`, whose re-attribution then costs three words instead of twelve (§3d). **Where
  the chain allows it, carry an empty beat on the literature of the next voice.** That is
  the cheapest and most coherent structure available for an empty beat, and it fell out of
  the real assembly rather than being designed.

**The failing script — 119 words, 705 characters, ~47.6 s.** Fluent, on topic, correct
length, and it is the defect this whole document exists to catch.

> *"Barbecue as we know it did not appear from nowhere. Its roots run deep, and they run
> across the Atlantic.*
>
> *For centuries, cooks in West Africa had worked with fire. They understood smoke, they
> understood time, and they understood how to make the most of an animal. Those skills
> did not disappear when people were taken from their homes. They travelled with them.*
>
> *It is often said that American barbecue is a melting pot, and in a sense that is
> exactly right. Indigenous technique, European animals and African knowledge came
> together in the American South, and what emerged was something remarkable, a cuisine
> that none of the three could have produced alone.*
>
> *That inheritance is a story worth remembering."*

**Read it once before reading the verdict.** It is on topic. It is about beat 20 and
nothing else. It is the right length, in the right register, with no errors of fact in
it. If it were voiced and dropped into the Foray at 47 seconds, nothing about it would
sound wrong.

**How it fails.**

| test | verdict |
|---|---|
| **R1** | Fails. *"did not appear from nowhere"*, *"Its roots run deep"*, *"That inheritance is a story worth remembering"* have no licence — about 30 of 119 words, past the quarter threshold. **So it is rejected, not trimmed.** |
| **R2** | **Fails outright, and this is the diagnostic.** Swap "West Africa" for "the Ottoman world" and "the American South" for "the Levant" and it is beat 9. Swap in Taíno and Jamaica and it is beat 15. Swap in the pampas and it is beat 14. **A script that fits four beats was written for none of them.** |
| **R3** | Fails. Not one named source. *"It is often said"* is on §5e's banned list and is doing the work of an attribution. The claims about smoke, time and whole-animal use are asserted on the narrator's credit. |
| **R4** | Fails on the hand-off. Nothing prepares `GC-1`, so the Foray's most important cut arrives unframed. |
| **R5** | Passes. Worth noting: the integrity rules are the ones filler tends to pass. |
| **R6** | Fails. *"remarkable"* is a banned adjective of significance; *"It is often said"* is a banned hedge. |

**And the two findings that matter more than the checklist.**

- **The beat's own reject line for tape rejects this script verbatim.** Beat 20 says
  reject "generic statements that African cooking influenced Southern food, with no
  technique and no mechanism of transfer." That is a precise description of the failing
  script. **The tape gate and the script gate are the same gate**, which is what #247
  asked for and what this example demonstrates rather than asserts.
- **It imports a defect that already got tape excluded.** *"A melting pot, and in a
  sense that is exactly right"* is the harmony move, and the coverage report rejects
  Stuff You Should Know's *"kind of transcends race and class"* on exactly that ground —
  "the harmony version beat 23 exists to reject." A fluent narrator will reach for it
  unprompted, because it is what generic prose about this subject does. **The narrator
  can reintroduce, for free, the very material the sourcing gate spent a report
  excluding.**

Note finally that the failing script is **cheaper** — 705 characters against 1,101. A
cost model built on characters will always prefer the padded script. That is a reason the
review gate cannot live downstream of the cost model.

### 7c. A Carry that cannot be sourced and must not be dropped — alcohol beat 16

Short, and labelled clearly: **the alcohol spine has no coverage report yet**, so
everything here follows the spine's own prediction rather than a measured verdict. It is
included because it is the cleanest example of Carry-by-design (§2d) and of the Marker
at a fan boundary, and because it is the beat the spine says the Foray exists for.

**What the spine says.** Beat 16 is the classification key. "Evidence that counts:
almost certainly narration, and that is the right outcome." §5 ranks it first among
beats likely to need narration: "Nobody says this in one breath because it is the
conclusion of an argument rather than a topic. It is the most important beat in the Foray
and almost certainly the least sourceable." Share 1.6 %, about **2.4 minutes**.

**Four consequences, all of them different from beat 20's.**

- **It may never be dropped.** A Carry-by-default can be deferred to more sourcing or,
  if it is a fan stop, dropped. This one cannot: it is a chain link and it is the beat the
  Foray is for. §4c's allocation rule reserves the Carry budget for exactly this.
- **144 s is a legitimate Carry**, above the 45–110 s target and inside the 150 s soft
  max, and the spine's share is the authority for it. The soft max still applies: the
  script must state what the extra minute buys. Here the answer is in the beat's own
  claim — "the proof is running an unfamiliar one through the key from scratch."
- **It is the one place "you" is licensed** (§5a), because the beat's claim is that the
  *listener* can now place a drink they have never heard of, and a key is used by
  somebody.
- **It passes R2 automatically, and that is not luck.** The beat's claim requires a
  worked example — an unfamiliar drink run through the four questions to a prediction.
  **A worked example cannot be relocated to another beat.** So the beat that is hardest
  to source is among the easiest to protect from filler, because its own claim forces the
  specificity R2 tests for. The generalisation is worth having: **a Carry whose claim
  demands a worked example is a safe Carry, and where a beat can be written that way it
  should be.**

Its attribution runs through R3's synthesis exception: the key is a conclusion from the
Foray's own preceding fifteen beats, so it attributes to the voices already heard.

**The Marker out of it — 48 words, 268 characters, ~19.2 s.**

> *"That is the key. Four questions, and every drink from here answers them in some
> order.*
>
> *What follows is not a sequence. The families ahead do not descend from one another,
> and you can miss one without losing your place. First branch: the sugars that were
> already sugar."*

The spine's instruction is that "narration entering beat 17 should say plainly that
everything from here is the key applied, and that the families do not descend from each
other. Then a missing family costs the listener nothing." The Marker says all three
things a fan announcement owes: **that the stretch is parallel**, **that a gap is
survivable**, and **what the ordering principle is** — first branch of the key.

**One contrast with the barbecue equivalent, because it changes the copy.** Barbecue's
Act III Marker must also promise that *the American thread resumes afterwards*, because
that fan is an interruption inside a larger argument. Alcohol's beat 17 Marker must not
promise a resumption, because there is nothing to resume — the fan **is** the rest of the
Foray. A Marker that borrowed barbecue's phrasing would tell the listener to hold a
thread that never comes back, which is a worse error than saying nothing.

At 19.2 s this Marker is over the 12 s transition ceiling and is therefore authored as a
**narration item**, not a transition (§2b) — and since beat 16 is itself a Carry ending
right there, §2e merges it into the tail of that item rather than making it a second item
in a row.

### 7d. What the seven scripts say about the planning constants

A small honesty check, since §2a's constants are convention and arithmetic rather than
measurement, and seven scripts is the first evidence this project has.

| | |
|---|---|
| total | 456 words, 2,667 characters |
| measured characters per word | **5.85** (range 5.44–6.68) |

So the **6.0 chars/word planning constant is conservative by about 2.5 %**, which is the
right direction for a cost estimate to be wrong in. The high outlier is item A3 at 6.68,
and the reason is instructive: attribution is long words. Scripts dense in names and show
titles cost more per word than scripts dense in mechanism.

**Nothing here measures words per minute**, and nothing can until audio exists. When it
does, re-derive every second-figure in this document from its word-figure and leave the
word-figures alone (§2a).
