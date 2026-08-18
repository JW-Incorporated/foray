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
- **A correction cites.** It says where the other account comes from. A narrator that
  contradicts a named historian on its own unsourced authority is the worst sentence
  the product can emit.
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

Twelve seconds does not hold three jobs, and a listener will take the first one. When
a seam needs more than one, split it: **Marker, then Frame** as two items, or write the
antecedent as a Patch *before* the Frame so the attribution lands last and closest to
the tape. §7a is a seam that needed three things and shows the split.

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
