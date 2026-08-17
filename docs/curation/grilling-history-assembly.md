# Assembly record — `grilling-history-2`

Stage 4 of #226. Stage 1 wrote the spine source-blind
(`docs/curation/grilling-history-spine.md`, 40 beats in five acts); stage 2
scored the tape against it beat by beat
(`docs/curation/grilling-history-coverage.md`, 6 strong / 10 thin / 24 empty);
this document is the assembly and the reasoning behind every inclusion and every
exclusion.

**Status:** `draft`. The founder's decision on 2026-08-17 was to ship a short
version now so that the player can be tested with it, and to keep transcribing in
parallel. `status` stays `"draft"` in `data/forays.json`; publishing is a founder
action, and §9 lists what should happen before it.

**Why this is a new Foray id rather than a rebuild of `grilling-history-1`.**
The intent was to rebuild #1 in place. That turns out to break 103 tests across
`player/`, `test/` and `tools/`, because Foray #1's exact shape — 32 items,
3,673 s, 31 seams, nine episodes of five shows, and its label set — is used as a
live fixture in about 130 places. Most of that is mechanical, but
`tools/foray/check-forays.test.mjs` carries #182's acceptance proofs, and they are
built on properties only the old order has: D1 passing *with the budget exactly
met*, a tightest seven-start span of 620.5 s, and D1 breaking when `GRID-3` is put
back. An eight-segment Foray with D1 headroom cannot express any of them, and
rewriting those proofs to fit new data would leave them green while destroying
what they prove. So `grilling-history-1` stays exactly where it is, as the fixture
those tests need, and **is marked superseded** (§9a); this Foray lands beside it.
Retiring #1 and extracting the fixtures is a separate, reviewed change.

**`grilling-history-1` is superseded, not current.** Anyone testing the player
should use `?foray=grilling-history-2`. The old link plays the 61-minute version
the founder reported as drifting.

---

## 1. What this is, and what it is not

**It is eight segments, 17.6 minutes, and six of the spine's forty beats.** It is
on plot: every segment is traceable to the beat it advances, and the bakestones,
Welsh cakes, medieval seating plans and 18th-century dinner parties the founder
named as the drift are all gone.

**It is not a history of barbecue, and nothing about it should be described as
one.** Thirty-four of the forty beats are absent. Twenty-nine of those thirty-four
are holes in a *chain*, which the spine established is the kind a listener hears
as something missing rather than as a change of subject. Most consequentially,
**the American case is one thin segment out of fifteen beats**, and the four beats
the spine calls the honest weight of the authorship argument — 20, 21, 22 and 30,
the West African inheritance, slavery as the labour system, the archival erasure
and the policy that produced the invisibility — are **all absent**. A listener
would come away from this Foray without having been told the thing the spine was
built to say.

That is not a flaw in the assembly. It is what stage 2 measured, reported
accurately, and the assembly has not papered over. But it means the honest
description of this artifact is **a playable fragment, useful for testing the
player and for hearing whether the on-plot discipline sounds different**, and not
a draft of the product.

Here is the distortion, measured, because it is the one number that says most:

| Act | structure | spine's share | this Foray's share | beats present |
|---|---|---|---|---|
| I — fire, smoke, mechanism | chain | 13 % | 22.6 % | 1 of 5 |
| II — surplus and power | chain | 6 % | **0 %** | 0 of 2 |
| III — the world's parallel answers | **fan** | 23 % | **53.8 %** | 3 of 8 |
| IV — the American case | chain | 36.5 % | **14.3 %** | 1 of 15 |
| V — the re-pricing | chain | 21.5 % | 9.3 % | 1 of 10 |

Act III is more than half of this Foray against an intended 23 %, and Act IV is
14 % against an intended 36.5 %. **Nothing was padded to make that happen** — no
segment was admitted for length, and §5 records every rejection. The proportions
came out that way because Act III is a fan the tape happened to serve and Act IV
is a chain the tape does not reach, which is precisely the inversion stage 2
warned was the worst available outcome.

---

## 2. The running order

Eight segments, in spine order. `beat` is recorded on every item in
`data/forays.json`, so the beat mapping is data rather than prose, and
`tools/foray/check-forays.test.mjs` compares this table against that file row for
row — position, label, duration and role — so the two cannot drift apart.

| # | at | label | duration | role |
|---|---|---|---|---|
| 1 | 0:00 | ORI-1 | 152.50 s | explanation |
| 2 | 2:32 | ORI-2 | 85.68 s | explanation |
| 3 | 3:58 | SATAY-1 | 79.80 s | explanation |
| 4 | 5:17 | ARG-1 | 148.54 s | explanation |
| 5 | 7:46 | ARG-2 | 100.94 s | explanation |
| 6 | 9:27 | JERK-1 | 237.93 s | exchange |
| 7 | 13:25 | MOSS-1 | 151.30 s | explanation |
| 8 | 15:56 | MOSS-2 | 97.86 s | explanation |

**Runtime 1,054.55 s — 17.58 min, ending at 17:34. Mean 131.8 s, inside the
75–180 s target band. Seven seams, four of them cross-episode.**

Which beat each row advances, and which act it belongs to:

| label | beat | act | segment | tier |
|---|---|---|---|---|
| `ORI-1` | **1** — cooking is external digestion | I | `origin-stories-cooking-human#147` | strong |
| `ORI-2` | **1** | I | `origin-stories-cooking-human#678` | strong |
| `SATAY-1` | **9** — the skewer family | III | `satay-okay-e01-satay-myth#736` | thin |
| `ARG-1` | **14** — asado | III | `bbqrn-argentina-open-fire#700` | strong |
| `ARG-2` | **14** | III | `bbqrn-argentina-open-fire#1005` | strong |
| `JERK-1` | **15** — jerk as Maroon synthesis | III | `moreish-jerk-jamaica#266` | strong |
| `MOSS-1` | **23** — the civic barbecue | IV | `bbqc-moss-school#2572` | thin |
| `MOSS-2` | **37** — the revival, dated | V | `bbqc-moss-school#2779` | thin |

The opening is intact and deliberate. `ORI-1` is the segment that was playing when
the founder reported that "the content started good (with man first discovering
cooking over fire)", and `ORI-2` is the honest half of the pair — it says out loud
that controlled fire is hard to prove and sets Wonderwerk Cave against the
anatomical timeline, which is the register beat 1 prefers over the tidy version.
Both were kept, and the beat's third strong candidate (`#448`) was not added:
three segments on the opening beat would be 40 % of this Foray's runtime on 3 % of
the spine, which is the definition of distortion even when the tape is good.

Two notes a reader will otherwise trip on:

- **Labels are not the old Foray's labels.** In `grilling-history-1`, `ORI-2` is
  `#448` and `ORI-3` is `#678`; here `ORI-2` is `#678`. `label_prefixes` in
  `data/forays.json` is the authority and `check-forays.mjs` verifies every label
  against its episode.
- **The slots are the spine's acts**, not the six arc slots `grilling-history-1`
  uses. Act II has no slot because it has no tape.

### 2a. The one new cut, and why it was minted

`satay-okay-e01-satay-myth#736` (735.8 → 815.6, 79.8 s) did not exist in the pool.
Stage 2 documented it and declined to mint it, for the good reason that its
anchors had been validated against a transcript body that pass could not see.

That reason was discharged rather than waived. The publisher's timed WebVTT was
fetched and read end to end, and both anchors are **verbatim and unique** in it:
the start anchor begins at cue 735.799 against a recorded `start_sec` of 735.8, and
the end anchor's last words fall inside the cue running 813.49 → 817.009 against a
recorded `end_sec` of 815.6. Episode metadata was re-checked against the live feed
— guid, `itunes:duration` 2323, enclosure URL and length all agree with what the
earlier pass recorded — and `verify-source-audio.mjs` returns HTTP 206 with total
bytes exactly equal to the declared 37,175,073, ratio 1.0000, so the source is
seekable and carries no dynamic ad insertion. It was merged through
`merge-segments.mjs` with the VTT as the transcript body, so its anchor
conventions and provenance fields are the tool's rather than hand-written.

**The rest of that episode was read too, and contains nothing else on plot.** The
first twelve minutes are podcast introductions and an identity essay; 815–1600 s
is Malaysian national identity and three misconceptions about the country; the
remainder is an interview about preserving family recipes. There is one on-plot
passage in 2,323 seconds and it is the one stage 2 named. That check mattered for
a reason given in §7: a second satay cut would have relaxed the constraint that
cost this Foray its strongest Act V beat, and the honest answer was that no such
cut exists.

---

## 3. The rule this was assembled under

From the founder, on #226:

> "critically, if we have content that is irrelevant, don't distort the narrative
> just to use more podcast content. Keep it mostly on topic"

Applied here as four working tests, in the order they were applied:

1. **A segment enters only against a named beat**, and only if it advances that
   beat's claim. Not for being about food, history, cooking or barbecue.
2. **A thin beat earns its place by advancing its claim, not by adding minutes.**
   Six of the ten thin beats were rejected on that test; see §4.
3. **Length is an output.** 17.6 minutes is what the tape supports. The
   34.2-minute figure in stage 2's report is a *ceiling* computed by admitting
   everything, and it was never a target.
4. **Label, never exclude.** Everything rejected stays in `data/segments.json` and
   in the ASR manifest, for playlists and for later Forays. This document chooses
   what serves *this* Foray; it prunes nothing.

---


## 4. The thin tier, decided beat by beat

Stage 2 found ten thin beats and put the ceiling at 34.2 minutes if all were
admitted. **Three were admitted and seven were not.** Stage 2's own framing governs
here: "a thin beat is a **narration beat** that happens to have a partial
supporting cut available. Stage 4 must not read thin as green."

### Admitted

**Beat 9 — the skewer family. Admitted.** The passage carries three rival origin
theories for satay, one of which is descent from Middle Eastern kebabs by way of
Indian maritime trade, plus the Bayon temple relief as material evidence of
antiquity, and closes on skewered meat being close to universal. Beat 9's first
clause is that the skewer over coals is the oldest grill technology still in daily
use, and its evidence note names satay's "possible descent from the same kebab
family" explicitly. So this advances the claim, not merely the subject. The
speaker is a food writer with a doctorate, so it passes the authority gate that
`Stuff You Should Know` fails. What it does **not** carry is the beat's Ottoman
root — the mangal as equipment and occasion, the codification of named kebabs,
charcoal management along a narrow fire, the vertical spit — and that root has no
source that passes the content gate at any budget. Beat 9 is a **fan** position, so
the missing root reads as a subject the tour did not stop at rather than a broken
link.

**Beat 23 — the civic barbecue. Admitted under protest, and it is this Foray's
largest editorial risk.** Read §7 before judging it: every rule-compliant
assembly available from this pool contains this segment, and there was no version
of shipping that excluded it. On the merits it is genuinely half a beat. Robert
Moss establishes the scale and the civic placement — barbecue up and down the
eastern seaboard, taking root in Virginia, riding west with the settlers to
gold-rush California, and by the 1850s a standard feature of the Fourth of July
and of campaign season. That is real evidence for the beat's first half. **The
beat's second half is absent, and it is the point of the beat**: that a space
which was one of the few regularly biracial public spaces in a segregated society
reproduced the hierarchy inside it, with Black people cooking and serving and
being fed separately or last. The spine says in terms: "reject the harmony
version that omits the seating." Shipped without narration supplying the seating,
this segment *is* the harmony version. §9 makes that a publication gate rather
than a hope.

**Beat 37 — the revival, dated. Admitted, with a caveat.** Moss dates the arc:
barbecue restaurants were large before the war, faded afterwards as stands were
eclipsed by fast food and chains, and it was "really only in the 1990s, early
2000s where people started going back and rediscovering America's barbecue roots",
at which point craft barbecue and Texas take off. Beat 37 claims an inversion
inside about fifteen years, and the dating of that window is a real component of
the claim from a barbecue historian. What is missing is the inversion itself —
barbecue criticism as a beat, national awards, the queue as the story, and above
all brisket's price history read against what the cut cost when the tradition
adopted it. **The caveat:** this segment also contains Moss's skepticism about the
German mustard trace in the South Carolina midlands, which is a beat-27 subject
this Foray does not otherwise touch, so about a quarter of its 98 seconds is a
subject change. That is a mild instance of the defect #226 exists to fix, and it
is recorded rather than hidden.

### Rejected

**Beat 2 — smoke as preservation. Rejected: no separable segment exists.** Its only
candidate is a passage *inside* `moreish-jerk-jamaica#266`, which is beat 15's
carrier and must stay there. Double-cutting one passage across two beats would put
the same voice making the same point twice. Narration owes beat 2 the whole
mechanism: water activity, the surface pellicle, the antimicrobial action of
phenols and organic acids, and why salt plus smoke plus drying do together what
none does alone.

**Beat 6 — a whole animal needs a crowd. Rejected: the candidate is already spent.**
Its candidate is `bbqrn-argentina-open-fire#700`, which is in this Foray carrying
beat 14. It establishes the occasion, which is beat 6's *conclusion*, not its
argument — the fuel and labour arithmetic of a whole carcass, and the
pre-refrigeration framing, are absent.

**Beat 7 — feeding a crowd as a claim to authority. Rejected with the SYSK
register.** Its only candidate was `Stuff You Should Know`; see §5.

**Beats 19, 24 and 30 — pork's ecology, emancipation into enterprise, policy and
dispossession. Rejected with the SYSK register.** These are three of the four
verdicts stage 2 explicitly flagged as resting entirely on that show, and stage 2
said a founder ruling either way would move them. The ruling excludes it, so they
return to empty. Beat 24 was close to strong and its loss is the most expensive of
the three.

**Beat 27 — the Carolinas and contested custody. Rejected: the tape contradicts the
spine rather than covering it.** The candidate is the same `#2779` used at beat 37,
and on beat 27 its content is Moss rejecting one of the beat's own sub-claims.
Stage 2 recorded that as a spine correction, and it is carried here as one: **beat
27 should be revised to hold the mustard belt as a disputed origin rather than a
German settlement trace.** A live dispute is better material than a tidy
derivation by the spine's own standard, and it removes a claim the Foray's best
available speaker rejects. That revision is not made in this pass because the
spine is stage 1's document and #226 asks for spine changes to be decided on the
merits, not applied by the assembler.

---

## 5. What was excluded, and why it stays in the catalogue

Nothing below was deleted. All of it remains in `data/segments.json` and in the
ASR manifest, available to playlists and to later Forays.

**All thirteen `bfh-*` segments.** The griddle, bakestone, medieval-manners and
18th-century-tavern material the founder identified as the drift. Stage 2 scored
each against a beat rather than dismissing it by reputation, and exactly one
survived — `bfh-18c-tavern-briggs#2011`, on broiling as the older English word for
grilling — and only as an alternate for beat 4. **It is not admitted here.** It is
a weaker read of the beat than the beat wants, since beat 4 is about barbecue's
two technologies and not about a different word pair, and it comes from one of the
three episodes the founder named as off-plot. Admitting it would reintroduce the
source that caused the complaint on the strength of its weakest defensible reading.

**`Stuff You Should Know — A Lip-Smacking Look at Barbecue`, entirely.** This was
the largest single exclusion and it is a founder ruling, not a judgement made
here. The reasoning is worth keeping because it will recur: the spine has a beat
(23) whose job is to refute the "barbecue transcends race and class" line this
show contains, twenty seconds after its own Jim Crow passage. **Admitting a source
the narrative refutes is the failure #226 was opened to fix, not a shortcut around
it.** The show also fails the authority gate — two hosts working from an article,
no guest, no sourced expertise, the same register that got other candidates
rejected — and it cannot be played at all until the locate step exists. Excluding
it costs four Act IV beats (7, 19, 24, 30) and two second segments (beats 5 and
32), and the four beats return to narration.

**Santa Maria (`bbqrn-santa-maria-grillzilla#134`), and both Santa Maria episodes
in the ASR queue.** No beat in the spine covers Santa Maria; the American regional
coverage stops at the four styles the founder named. Stage 2 recorded that §6b of
the spine does not acknowledge this omission, and it should, so that the next
sourcing pass stops re-finding Santa Maria tape and wondering where it goes.

**The four Traeger segments.** COVID demand, the 2021 IPO and 2022 crash, grill
price tiers, Kingsford's market share. §6b of the spine excludes equipment and
gear history except where it carries a social argument, and none of these does.
Beat 39 wants a position on whether thermostatic control removes something that
matters, and no Traeger segment takes one.

**The remaining Argentina and Moss cuts.** Offal ordering, Italian settlement of
Argentina, cooking durations, Patagonian lamb terroir, grill marks as Maillard
browning. Each fails a named beat's own reject criteria.

**Beat 1's third strong segment (`origin-stories-cooking-human#448`).** Genuinely
strong tape, deliberately not used. See §2.

---

## 6. The holes, marked

Thirty-four beats have no tape in this Foray. **Twenty-nine are chain holes and
five are fan holes**, and the difference is what the listener hears.

| Act | absent beats | structure | how the gap reads |
|---|---|---|---|
| I | 2, 3, 4, 5 | chain | missing links |
| II | 6, 7 | chain | missing links — the act is entirely absent |
| III | 8, 10, 11, 12, 13 | **fan** | stops the tour did not make |
| IV | 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30 | chain | **one hole where the act was** |
| V | 31, 32, 33, 34, 35, 36, 38, 39, 40 | chain | missing links |

Five things a reader should take from that table rather than from the count:

- **Act II is gone.** Both beats. The pivot from technique to history — that a
  whole animal needs a crowd, and that feeding a crowd is a claim to authority —
  is not in this Foray at all. Every later beat that depends on it arrives
  unexplained.
- **Act IV is one thin segment across fifteen beats.** As a listening experience
  this is not fourteen small holes; it is one hole where the act was, with a
  single plank laid across it. Beats 21 and 22, which the spine calls
  load-bearing, have nothing either beat can use.
- **Beat 4 is absent and beat 34 is absent**, so the ambiguity in the word
  "barbecue" is neither raised nor explained. Stage 2 specified a mintable cut for
  beat 4 from `bbqc-moss-school` at 3106.36 → 3215.23; §7 explains why it could
  not be used here, and it remains the best single addition available without
  buying any ASR.
- **Beat 32 was strong and is absent**, which is the only place in this assembly
  where a strong beat lost to a rule rather than to the tape. §7.
- **Five fan holes are the cheapest part of this**, exactly as the spine designed.
  Braai (13) has no source at any budget and the negative is unusually clean;
  yakitori (11) and Korea (12) have sources that are not in English and are
  permanent narration beats under the English-only ruling; the steppe (8) has no
  source found and none proven absent; only the tandoor (10) could be closed by
  measuring and transcribing.

**What this means for copy.** The Foray's `summary` says "A fragment: most of the
history is missing", and its `title` is "Barbecue: six beats of a forty-beat
history". Both are deliberately unflattering. A listener who is told this is a
history of barbecue has been misled; a listener who is told it is six beats of one
has been told the truth and can judge the six.

**Narration scripts are not written here.** #226 puts them in stage 4 and the spine
§7 confirms it, but the brief for this pass asked for the assembly, the thin-tier
decisions, the marked holes and the work order. Stage 2's closing warning is the
reason to be careful about how they are eventually written: with 34 of 40 beats
narrated, **the narration becomes the place the drift happens**, because nobody is
scoring prose against the beats the way tape was scored. Narration needs the same
gate the tape got.

---

## 7. Two rules decided the shape of this, and neither was the cut budget

This is the part of the assembly a reviewer should read most carefully, because it
is where the result stops being a straightforward reading of stage 2's report.
Stage 2 checked D1, D3 and D5 and concluded "the cut budget is not a constraint at
any of these sizes". That is correct. **It did not check M3 or M4, and both bind
hard.**

- **M3** — same-episode segments never play out of chronological order.
- **M4** — no single episode may exceed 25 % of a Foray's segments *or* of its
  runtime.

The pool has four usable episodes. That is what makes M4 vicious: with four
episodes, every episode must average a quarter of the Foray, so the cap is met
only by near-perfect balance and is breached by almost any real distribution.

**An exhaustive search settles it rather than an argument.** All 2^14 subsets of
the fourteen candidate segments (stage 2's strong tier, its documented alternates,
its two mintable cuts, and the three admissible thin carriers) were evaluated
against M3, M4, D1, D2, D3, D5 in both readings, L4 and the target band. **Exactly
six assemblies satisfy every rule.** Every one of the six:

- **omits beat 5**, because M3 makes beats 5 and 14 mutually exclusive. Both are
  carried by `bbqrn-argentina-open-fire`; beat 5's cut sits at 1437 s and beat
  14's at 700 s and 1205 s, so in spine order they would play backwards. Beat 14
  was kept: it is world coverage the founder explicitly required and has no
  substitute, while beat 5's claim is the single most narratable in the spine
  because it is a one-sentence rule. **Beat 5 is narration for a reason that has
  nothing to do with the tape being unavailable**, which is why re-transcribing
  that episode is priority 2 in the work order.
- **carries only one of beat 15's two jerk segments**, because the pair totals
  321.9 s and would need a Foray of at least 21.5 minutes to sit under M4's
  runtime cap. `#266` was kept as the carrier; `#555` — the segment that says out
  loud that there is no direct evidence for the transmission — is lost, and
  narration owes that honesty.
- **requires a fifth episode**, which is why the satay cut was minted. No
  four-episode assembly passes M4 at any size. The closest misses fail by between
  0.5 and 4 percentage points.
- **contains `bbqc-moss-school#2572`**, beat 23's segment. It is the earliest
  usable cut in that episode, and M3 plus M4 together mean the Moss episode must
  contribute exactly two segments starting from its earliest. **There is no
  compliant assembly of this pool that excludes beat 23**, which is why §4 admits
  it under protest instead of following stage 2's instruction to drop it.

The choice among the six came down to one trade, and it is worth stating because
it is the assembly's least comfortable decision. **Keeping the founder's opening
(`ORI-1`) and keeping beat 32 are mutually exclusive**, and the margin is absurd:
the assembly that keeps both puts the Moss episode at 25.04 % of runtime against a
25 % cap — over by 0.45 seconds. Beat 32 is the only strong beat in Act V and the
only tape for the whole re-pricing act. The opening is an explicit founder
instruction and the segment he named as good. **The opening was kept**, Act V is
carried by beat 37's thin segment instead, and this paragraph exists so the cost is
on the record rather than buried in an arithmetic coincidence.

This is also why §2a's reading of the whole satay episode mattered. A second
on-plot satay cut of even 30 seconds would have relaxed the runtime denominator
enough to keep beat 32, beat 14's preferred carrier and possibly beat 15's second
segment. There is no second on-plot passage in that episode. The check was worth
running and the answer was no.

**One honest caveat about M4 itself.** It is computed on the tape timeline, so
narration contributes zero seconds — the same limitation `check-forays.mjs`
documents for D1 in its `TODO(bridges)` comment. In a Foray that is 34 of 40 beats
narration, the true listener-facing runtime would be far larger and every episode
share far smaller, so M4 as measured today is strictly conservative for exactly
this kind of Foray. **That is an argument for revisiting the rule, not for evading
it**, and the gate was obeyed as written. Changing a checker so that one's own
output passes it is the move this whole issue exists to prevent.

---

## 8. What `check-forays.mjs` actually says

The brief for this pass reported `grilling-history-1` as failing today with seven
segment starts in a 600 s window against a budget of six, plus three D5
violations, printed by passing tests so that CI was green while the Foray broke
its own rules. **None of that is what the checker reports, and it was verified by
running it rather than by reading the code.** Recording the correction here so the
next reader does not go looking for a bug that is not there.

The tool exits 0 and prints `forays ok`, on `main` and now. For
`grilling-history-1`, **D1 is 6 starts against a budget of 6 — met exactly, with
no margin**, and **D5 pairwise violations are zero**. The three D5 lines are
**warnings under the mean-deviation reading, which the checker deliberately does
not gate** and documents at length: the gated reading is pairwise because that is
what the rule's own words say, and the mean-deviation reading is computed and
printed anyway so the triples stay visible rather than being quietly resolved in
our favour. The "seven starts" figure is `grilling-foray.md` §5 counting six
*gaps*, which is seven starts; the checker's own comment reconciles the two and
notes that both produce the same verdict.

So there was no failing checker and no hidden red. **The true statement is
narrower: `grilling-history-1` sits exactly on its D1 budget with no margin, and
carries three uncleared non-gated warnings.** Note that `capital-types-1` prints
the same class of warning, so this is a property of the checker's two readings and
of how Forays get assembled, not something specific to grilling.

This Foray was assembled to clear both bars rather than only the gated one:

```
grilling-history-1 (draft): 32 segments, 61.2 min, mean 114.8 s
  D1 6/6 starts per 600 s   D5 0 triples, IQR 57.81 s
grilling-history-2 (draft): 8 segments, 17.6 min, mean 131.8 s
  D1 6/8 starts per 600 s   D5 0 triples, IQR 56.79 s
capital-types-1 (draft): 22 segments, 51.4 min, mean 140.1 s
  D1 5/6 starts per 600 s   D5 0 triples, IQR 71.75 s
18 source episodes registered
WARN foray "grilling-history-1": D5 (mean-deviation reading, not gated): MOSS-2 / MOSS-3 / SM-1 worst deviation 16.5 %
WARN foray "grilling-history-1": D5 (mean-deviation reading, not gated): ARG-1 / ARG-2 / ARG-3 worst deviation 19.7 %
WARN foray "grilling-history-1": D5 (mean-deviation reading, not gated): ARG-5 / ARG-6 / ARG-7 worst deviation 19.1 %
WARN foray "capital-types-1": D5 (mean-deviation reading, not gated): CALM-1 / BOOT-2 / CALM-3 worst deviation 15.1 %
WARN foray "capital-types-1": D5 (mean-deviation reading, not gated): VD-2 / VD-3 / VD-4 worst deviation 19.6 %
forays ok
```

**`grilling-history-2` emits no warnings at all** — it is the only Foray in the
file that is clean under both readings of D5 — and its D1 has two starts of
headroom against its budget rather than sitting on the line. The five remaining
warnings belong to `grilling-history-1` and `capital-types-1`, neither of which
this pass touched; both are byte-identical to `main`. Clearing
`grilling-history-1`'s three is not possible without re-cutting it, which is the
retirement work §9a describes.

Episode shares against M4's 25 % cap: `origin-stories-cooking-human` 25.0 % of
segments and 22.6 % of runtime, `bbqrn-argentina-open-fire` 25.0 % / 23.7 %,
`bbqc-moss-school` 25.0 % / 23.6 %, `moreish-jerk-jamaica` 12.5 % / 22.6 %,
`satay-okay-e01-satay-myth` 12.5 % / 7.6 %.

### 8a. Seams, and why fewer is better right now

**Cross-episode seams drop from 16 of 31 to 4 of 7.** #224 is open and unfixed: the
screen-off seam handover discards a prefetch at the boundary, and the fallback load
takes about 11 seconds structurally against a 10,000 ms deadline — so it does not
merely stall, it **misses the deadline every time**, and a cross-episode seam is
where playback drops with the screen off. Four instead of sixteen is therefore not
a cosmetic improvement; it is four exposures instead of sixteen, and it materially
changes the odds of a clean listen.

Nothing here fixes #224, and **no copy in this Foray claims smooth playback**. This
is also the second, independent reason not to pad: every segment added for length
would have bought another chance to hit a known playback failure. The answer to
scarce tape was a shorter Foray, and the player bug happens to agree with the
editorial rule.

---

## 9. Before this is published

`status` is `draft` deliberately. Four things should happen first, and the first is
a gate rather than a suggestion.

1. **Beat 23 needs narration supplying the seating, or `MOSS-1` should be cut.**
   As shipped, that segment is the harmony version of the civic barbecue — the
   scale and the civic placement with none of the hierarchy. The spine says reject
   that version; §7 explains why no compliant assembly could exclude the segment.
   Publishing without the narration ships the exact reading beat 23 exists to
   refute. If the narration cannot be written, cut `MOSS-1` and accept that
   `check-forays.mjs` will then need the Foray re-solved.
2. **Rule on the three spine questions stage 2 raised**, because two change what
   narration says: beat 27's mustard trace (recommend: revise to a disputed
   origin — the Foray's own best speaker rejects the settlement claim), whether the
   19th-century westward diffusion deserves a beat between 19 and 23, and whether
   §6b should acknowledge that Santa Maria and California are omitted.
3. **Write the narration to the beats, with a gate on it.** 34 of 40 beats are
   narration. Prose always sounds on-topic, which is why it is the likeliest place
   for #226 to recur in a form that is harder to hear.
4. **Decide whether a fragment this shaped should be published at all**, as
   opposed to kept as a draft for player testing. §1 is the honest description and
   it is not a flattering one.

### 9a. How to open it, and the stale-link hazard

Both grilling Forays are `draft`, so neither is listed for an ordinary visitor and
both are reachable only by asking for one by id. The unlock path is generic — it
reads whatever id is in the query string — so no code change was needed:

```
https://jw-incorporated.github.io/foray/?foray=grilling-history-2
```

Verified against the real documents rather than assumed: without the parameter
`findForay` returns `null` and visibility reports `draft — not published`; with it,
visibility reports `draft, opened by id`, `listableForays` returns the Foray, and
it resolves to **8 playable segments, 0 unplayable, 17:34, every source https**,
with the four act slots contiguous in declared order.

**The hazard is the old link.** `?foray=grilling-history-1` still works and still
plays the 61-minute version the founder reported as drifting. Anyone who reuses
the link they were given earlier will re-test the drift and conclude that nothing
changed. So:

- `grilling-history-1` carries `superseded_by: "grilling-history-2"` and a
  `superseded_note` in `data/forays.json`, and its running-order document
  (`docs/curation/grilling-foray.md`) carries a note at the top saying the same
  thing. Neither field is read by the player, so no fixture moves.
- It is deliberately **not deleted**. It is the fixture 103 tests depend on, and
  under label-never-exclude its segments stay in the pool regardless.
- Retiring it means extracting those fixtures first. That is the separate reviewed
  change described at the top of this document, and until it lands
  `grilling-history-1` is a stale draft that is labelled as one.

---

## 10. The ASR work order, re-prioritised

The machine-readable order is `docs/curation/grilling-asr-manifest.json`, re-sorted
on 2026-08-17. Summary of what changed and what it buys.

**The old order was inverted, not merely imperfect.** It was ranked against the six
arc slots in `data/forays.json`, and the spine's 40 beats are a different
instrument. Measured against the beats, **none of the eight priority-1 rows moved a
chain beat off empty**: three bought beats that are already strong (1, 14, 15), one
bought a beat that does not exist in the spine at all (Santa Maria), three are
unusable under the English-only ruling, and the eighth does not advance beat 12 on
its stated subject. Meanwhile the most valuable episode in the manifest sat at
priority 3.

**Priority 1 is now three rows, and the principle is chain beats first, Act IV
first**, because 19 of the 24 empty beats are in chains and 5 are in the fan.

| | source | beats | what it buys |
|---|---|---|---|
| 1 | `The Grill Coach — Adrian Miller and The History of BBQ` (3,306 s) | 18, 20, 21, 22, 38 | The largest single move available, and the only Act IV source needing no ad work at all — measured ad-free at ratio 1.0, so ASR and nothing else. Includes beat 21, which the spine says decides whether the Foray is worth shipping. |
| 2 | `The Moreish Podcast — Caribbean Food History with Dr. Candice Goucher` (3,466 s) | 20, and likely 2 and 15 | The best unread candidate for the West African inheritance — the beat the spine added in revision so that authorship does not rest on hours worked. No Act IV source reaches back across the Atlantic. |
| 3 | `Gastropod — The Birth of Cool` (~49 min) | 31 | Act V's chain hinge, and the closest thing to a free win: already PADDABLE on two measured probes. Was filed under `excluded_by_instruction` on a workstream note ("already being transcribed"), not a rejection. |

Together that is up to **seven chain beats**, including four of the five beats that
make up the authorship argument (20, 21, 22, 38) — the 12 % of runtime the spine
calls the honest weight. Against the old priority 1, which was 3.43 hours of audio
and moved none.

**Cheaper than any of it, and therefore first: read before transcribing.** Two of
the four identified Act IV sources may already ship transcripts. `Proof (America's
Test Kitchen) — Barbecue Trailblazers` is recorded in ADR-0008 as carrying one, and
`A Taste of the Past` should be checked the same way. Reading SYSK's transcript is
what produced four verdict changes in stage 2 for the cost of one fetch — and the
founder then ruled that register out, which is itself the argument for reading
first: the cheap check tells you whether the expensive one is worth buying.

**Priority 2** is the two episodes that unblock specific named beats rather than
adding depth: re-transcribing `moreish-jerk-jamaica`, whose publisher transcript is
untimed and which is the only reason beat 2 cannot have its own cut instead of
double-booking beat 15's; and re-transcribing `bbqrn-argentina-open-fire`, which
would let beat 5 play again by supplying a beat-14 cut after 1437 s, and which is
where the asador-as-a-social-office material beat 21 needs for contrast should be.

**Fifteen rows are unqueued**, with a `blocked_by` reason on each, which takes 4.73
hours of audio out of the queue without removing anything from the catalogue: eight
under the English-only ruling, six for having no beat in the spine, one superseded
by a longer re-release of itself. **The English-only question is settled, not
open** — `docs/DECISIONS.md`, 2026-08-16 — and both `catalogue-broadening.md` §3 and
an earlier draft of the coverage report still frame it as unresolved, which is how
the next agent re-decides it.

**Nothing was transcribed in this pass.** The order was fixed; the CPU was not
spent.

---

## 11. What this document does not decide

- **Whether to publish.** §9. `status` stays `draft`.
- **The narration scripts.** Queued, not written, and not voiced — ElevenLabs
  spend is founder-gated.
- **The three spine questions.** §9.2. They belong to stage 1's document and to a
  reader deciding on the merits, not to the assembler.
- **Whether M4 should be computed against a narration-inclusive runtime.** §7 makes
  the case that it is strictly conservative for a narration-heavy Foray and
  deliberately does not act on it.
- **Whether beat 4's mintable Moss cut should displace something.** It is specified
  in stage 2 §3 and is the best addition available without buying ASR, but M3
  makes it mutually exclusive with all three Moss cuts used or considered here.
- **Anything about how this sounds.** Nobody has heard it. The most useful thing
  that could happen to this document is the founder listening and naming the beat
  that lost him — which, with Act II absent and Act IV a single segment, may be a
  question about what is missing rather than about what is there.
