# Deck: listening quality — the Foray has to sound like a story, not a checklist

**Status:** **Q-01..Q-05 landed 2026-09-12; Q-07..Q-09 landed 2026-09-13** (#646, #647, #650, #651 — per-card markers
below). **Q-06, the listening test, is open and is Wyatt's.** Written 2026-09-12 by the
founder's Claude session from Wyatt's listening notes below; the deck had **one commit in
its entire history** (#645, the day it was written) while four PRs landed five of its six
cards, so until 2026-09-12 it still read "plan to cut into kanban cards", still said no
generation run may launch until it is done, and still sent agents to edit a file that had
been deleted by its own Q-01. Corrected by the machinery-audit pass;
`tools/ci/deck-claims.mjs` is the mechanical floor added with it. Cards are **Q-**. Companion to
`docs/curation/foray-to-spec-roadmap.md` (the G-deck, which is about *producing* a
Foray at all); this deck is about what the listener hears. It takes priority over
further generation runs: "let's stop building forays and work on quality."

The rule that governs every card, from `CLAUDE.md`: **measured beats inferred.**
Every number is tagged.

---

## 0. The brief, verbatim

Wyatt, 2026-09-12, after listening to the generated Forays:

> 1. The AI narration script was super clunky. It seems the focus is definitely on
>    explicitly hitting all the beats rather than telling a smooth, cohesive story.
> 2. There was inadequate, if any, introduction to podcast segments. The AI narrator
>    would make the point from the previous beat then it would cut to the part of the
>    podcast that made the point for the beat. While this likely meets the
>    requirements I laid out, it's very clunky. The podcast sounded like it had a
>    relevant introduction that could have been included — or, if not, an intro from
>    the narrator would have been appropriate.
> 3. The podcasts were trimmed too aggressively. I was just starting to get into the
>    podcast and it would cut off. Perhaps effective for rapid fire content, but
>    unpleasant to listen to.

---

## 1. What is measured (the four generated Forays on `main` @ #642, 2026-09-12)

| Foray | segments | segment length mean / min / max | tape share | narration pages | words per page |
|---|---|---|---|---|---|
| Beyond the Algorithm | 11 | 134 / 35 / 211 s | 61 % | 40 | 68 |
| How AI Actually Gets Built | 11 | 139 / 45 / 238 s | 59 % | 39 | 80 |
| The Chain Reaction | 10 | 102 / 31 / 181 s | 59 % | 38 | 56 |
| What Engineers Actually Do All Day | 16 | 122 / 32 / 177 s | 78 % | 40 | 42 |

Item order is the same shape in all four: runs of four to eight narration pages,
then one clip, then the next run (`nnnnnnnSnSnnnnnnnSnnnnnSnnnnSnS…`). A page is
15–30 s of speech. [measured from `data/forays.json` + `data/segments.json`]

Where each of the three complaints comes from, in the code:

- **One page per beat, verified per page.** The spine is a list of beats; the
  writer (`backend/src/generation/writeNarration.ts`, `AnthropicNarrationWriterBuilder.ts`)
  produces one page per beat under a per-page *purpose* contract, and the verifier
  rejects a page that does not accomplish its purpose (up to three attempts, F-51).
  No stage ever reads two adjacent pages together, so cohesion is not a property any
  stage optimises; a page rewritten three times to satisfy its purpose gets more
  literal each time. [measured: `retryRounds` 10 in runs 7 and 8]
- **The clip is cut at the sentence that proves the claim, and the page before it
  restates that sentence.** `selectTapeWindow` (`transcriptArchiveLookup.ts`) sizes a
  window (30–180 s, `TAPE_WINDOW_MIN/MAX_SEC`) to cover the claim's terms, not the
  speaker's thought; F-81/F-82 made Frame and Hinge pages *cite the tape* — restate
  what the clip says — because that restatement is how those pages get verified
  without print. So the narrator says the point, then the guest says the point.
  There is no page role for "who this is, what show, what to listen for".
- **Length is bounded by rules written for variety and ad-safety, not for
  listening.** `D3_MEAN_FLOOR_SEC` 90, `D5_IQR_FLOOR_SEC` 45 with the length ladder
  (105/165/135/210 s, F-73), `M4_ITEM_SHARE_MAX` 0.25, `MAX_TAPE_SEGMENT_SEC` 240,
  `TAPE_WINDOW_MAX_SEC` 180. None of them ask where a thought starts or ends. The
  ad-insertion anchoring constraint only requires that start and end land on stable
  transcript anchors.

---

## 2. The design in one paragraph

**A Foray is a narrated listening session: long clips that begin where the speaker's
thought begins, each introduced by a narrator who tells you who is talking and what
to listen for, joined by prose written per act rather than per beat.** The beats
stay — as the verifier's checklist against the act's prose and as the sourcing
targets — but they stop being the unit of writing. The rules that bound clip length
are re-measured against the new lengths rather than re-baselined by hand, and the
acceptance test for this deck is a listening test, not a pass rate.

---

## 3. Cards

### Q-01 · Clips start and end at thought boundaries, and run longer — **H · M — overlord (backend)** — **DONE** (#647, 2026-09-12; extension to thought boundaries with the 30-minute ceiling, `sourceBeats.ts`. Pass 2 in #651: the extension reaches the seed path, overlapping windows merge into one clip, and `check-forays.mjs` accepts a Q-01 Foray — F-96)
**Ask.** After `selectTapeWindow` finds the claim's window, extend it backwards to
the start of the speaker's turn (or the host's question that prompted it) and
forwards to the end of the answer, using the transcript cues' speaker/turn structure
where the archive has it and sentence boundaries + pause gaps where it does not.
Then keep going: **the clip runs for as long as the content stays relevant**
(Wyatt, 2026-09-12: "if there's a half hour of relevant content then let it
ride"). Relevance is measured, not guessed — a sliding 60 s window scored against
the slot's thesis and the beat's claim (the same `tokenizeForSourcing` terms and
idf the window search already uses); the clip extends while the score holds above
a floor and stops at the first drift or host segue, at a turn boundary. Bounds:
floor 60 s, ceiling 1,800 s (`TAPE_WINDOW_MAX_SEC` 180 → 1800,
`MAX_TAPE_SEGMENT_SEC` 240 → 1800); the floor and ceiling are the only
hand-set numbers. The extension must land on the same kind of anchor the window
already lands on (`start_anchor`/`end_anchor` text), so the ad-insertion
constraint is untouched. Record `boundary: "turn" | "sentence" | "claim-only"`
and `extended_by_sec` on the minted row so the ledger can say how often a real
boundary was found and how far relevance carried.
**Owned.** `backend/src/generation/transcriptArchiveLookup.ts` (`selectTapeWindow`,
a new `extendToThought`), `mintedSegmentCopy.ts`, `types/`, tests.
**Done when.** Fixture cues with a Q/A turn: the window opens at the question and
closes at the end of the answer; a window with no turn data extends to sentence
boundaries; the anchors still satisfy `check-forays`. Measured on the run-8
candidate: mean clip length and the share with `boundary: "turn"` in the report.
**Dependencies.** none. **Human gate.** none.

### Q-02 · Every clip gets an introduction — **H · M — overlord (backend)** — **DONE** (#646, 2026-09-12; the light introduction before each clip, written as part of the act's prose)
**Ask.** A new page role, **Intro**, placed before a segment: one or two sentences —
who is speaking (name, role), on which show, and what to listen for — written from
the clip's *opening*, never from its point. **Light touch** (Wyatt: "don't go
overkill here"): when the host's own introduction of the guest or topic exists in
the tape within ~60 s before the window, Q-01's extension keeps it and there is no
Intro page at all; when the previous clip was the same guest on the same show, the
Intro is one clause or nothing. The F-81/F-82 restate-the-tape rule no
longer applies to the page immediately before a clip; those pages are verified by
the clip itself (tape-cited) without repeating it. The page *after* a clip may
still restate, once, in the act's own words.
**Owned.** `writeNarration.ts`, `AnthropicNarrationWriterBuilder.ts` (prompt),
`types/narration.ts` (role), `tools/foray/check-forays.mjs` (Intro accepted;
fixture-coverage per G-21c), `player/media-session.js` credit, tests.
**Done when.** A fixture act with two clips produces two Intro pages naming
guest and show; a mutation that lets an Intro restate the clip's claim is red; the
run-8 candidate re-narrated shows no page whose text repeats the following clip's
first sentence (a similarity check in the report, `introRestates: 0`).
**Dependencies.** Q-01 (so the Intro is written from the real opening).

### Q-03 · Narration is written per act, verified per beat — **H · L — overlord (backend)** — **DONE** (#646, 2026-09-12; `writeAct.ts` — a page is now a stretch of prose between clips, not a beat. Pass 2 in #650: act-scoped support, modes assigned after writing, retries edit only the failed seams — F-97)
**Ask.** The writer receives an act's whole verified material — its clips (with
Q-01 boundaries), its evidence, its beats — and writes continuous prose for the
act: the bridges between clips and the argument the act carries, in one voice,
with the beats as the things the prose must carry rather than the template it
fills. The verifier then checks each beat's claim against the act's prose and the
clips (the same claim-level verification as today, F-51/F-88 unchanged), and a
missed beat sends back a *note*, not a page: "the prose does not carry beat 3;
add it where it belongs." Retries edit the act, not a page. Pages become the
segments of the act's prose between clips (the data model keeps `narration`
items; there are simply fewer and longer of them).
**Owned.** `writeNarration.ts`, `AnthropicNarrationWriterBuilder.ts`,
`NarrationVerifierBuilder.ts`, `synthesisVerify.ts` (F-88 becomes the normal path
for thesis prose — and, with F-100, its separate post-pass is deleted: the ground
reaches the act writer and the act verifier directly), `runPipeline.ts` (per-act
call already exists, G-32), tests.
**Done when.** Narration items per Foray fall from ~40 to roughly one per seam;
`firstAttemptPassRate` is measured against beats, not pages; a fixture act with
four beats and two clips yields prose that the verifier passes on all four; a
mutation dropping a beat from the prose is red. Cost: narration calls per act ≤ 3.
**Dependencies.** Q-02 (the Intro role is part of the act's prose). **Human
gate.** none for code; Wyatt listens (Q-06).

### Q-04 · Re-measure the placement rules against the new lengths — **M · S — overlord** — **DONE** (#647, 2026-09-12; the placement rules re-derived, and `d5Triple.ts` replaced by `d5Pair.ts` in the same PR — see the **Owned** line below, which named the deleted file until 2026-09-12)
**Ask.** With 60 s to 30 min clips and fewer of them, D3 (mean floor 90 s), D5 (IQR
floor 45 s, ladder 105/165/135/210), M4 (one episode ≤ 25 % of the Foray), D1
(starts in a 600 s window) will fire for the wrong reasons — a 30-minute clip that
Wyatt wants to "let ride" breaks M4 by construction. Re-derive each from the
listening purpose it serves (D1: ad-safety — keep; M4: no single episode
dominating — becomes a per-*Foray* cap of one long clip per episode rather than a
share; D3/D5: variety — restate as "no two consecutive clips within 20 % of the same
length" rather than a ladder) and change the numbers once, with the reasoning in
the checker's comment, not per run. Same in `sourceBeats.ts` and `d5Pair.ts`.
**Owned.** `tools/foray/check-forays.mjs`, `backend/src/generation/sourceBeats.ts`,
`d5Pair.ts`, their tests, the §2 doc table. (Both of those read `d5Triple.ts` until
2026-09-12. That file was DELETED by this card's own PR #647 — `1ac3d4f`, which
added `d5Pair.ts` and `d5Pair.test.ts` and removed `d5Triple.ts` and
`d5Triple.test.ts` — so the deck spent a day sending agents to edit a file that no
longer existed.)
**Done when.** The run-8 candidate re-sourced under Q-01 passes the checker with
zero rule errors and the ledger records old vs new values.
**Dependencies.** Q-01. **Human gate.** D0's targets in the G-deck (Wyatt).
**Corrected 2026-09-12 by F-102** (`docs/curation/generation-run-2026-09-09.md`).
This card shipped the pair clause as a HARD REFUSAL at placement — sourcing
either re-cut the clip shorter (`d5EscapeBelow`) or narrated the beat, and
`check-forays.mjs` failed a Q-01 Foray that held a pair. That is this card
overruling Q-01, three cards above it in the same series: both of those moves
make the Foray play LESS tape, and Q-01 is the founder's own instruction that it
should play more ("if there's a half hour of relevant content then let it
ride"). Measured on the real archive the next morning: four seeded beats refused
at `d5-pair`, nine clips placed against a floor of ten. **D5's pair clause is now
reported and gates nothing** — in the checker (`d5_uniform_pairs`, `d5_iqr_sec`,
warnings only; `d5_gated` removed) and in sourcing (`placementAllows` does not
ask it; the relevance row carries `lengthGate: "d5-pair"` as a mark). Variety is
not pursued by re-ordering candidates either, because every order sourcing may
change is ranked by relevance and that would buy variety with veracity. The
general lesson is in F-102: two cards in one series moved the same quantity in
opposite directions, and the only test that could see it runs on one machine.

### Q-05 · The tape share target moves up, the page count moves down — **M · S — overlord** — **DONE** (#646, 2026-09-12; the two listening KPIs in `veracityMetrics.ts` and the `generateForays.ts` report)
**Ask.** `docs/curation/foray-to-spec-roadmap.md` §1.2's *proposed* targets get two
listening numbers: tape share ≥ 70 % (run 8 reached 78 %; runs 5–7 sat at 59–61 %)
and narration ≤ 25 % of runtime with ≤ 1 page per seam. `report.json` already
carries the inputs; add the two derived fields and the G-42 harness columns.
**Owned.** roadmap §1.2, `veracityMetrics.ts`, `generateForays.ts` report.
**Dependencies.** none. **Human gate.** D0 (Wyatt confirms the numbers).

### Q-07 · Every Foray opens with a prelude — **H · M — overlord (backend)** — **DONE** (2026-09-13)
**Ask.** Wyatt, 2026-09-13, verbatim: "we should add a prelude to each foray
that we generate. It should briefly mention that this is AI generated and
there's risk of fake content but we try hard to avoid that. Most of that text
can likely be boilerplate that's used in every foray. Then give a brief
overview of what's to be covered in this foray to give the listener some
context."

**What was already there, measured before writing anything.** Part one EXISTS
and has since PR #391: `disclosureTemplate` is the boilerplate, it is already
`items[0]` of every generated Foray, `check-forays.mjs` already refuses to
publish without it, and a round-trip test pins the two together. Exactly two
things were missing. The boilerplate said "AI gets things wrong", which a
listener hears as a mistake rather than as invention — so one clause naming
invention was added, which is strictly MORE disclosure than legal signed off
on, never less. And there was no overview at all.

**Shipped.** One item, not two — the founder described one thing the listener
hears first, and two adjacent narration items are two pauses and two renders
for one thought. `preludeTemplate(subject, overview)` in `types/narration.ts`
is the single producer; `PRELUDE_BOILERPLATE` is a named constant the model
never sees, concatenated in code, so it cannot be rewritten per Foray. The
overview is a new REQUIRED field on `SpineSchema`, written by the model in
the same call that writes the acts — one more field on a reply the run
already pays for, rather than a tenth stage for four sentences — and so it is
frozen with the spine, checkpointed with it and identical across a resumed
run. `CHECKPOINT_VERSION` 2 → 3, no shim.

**Where it is minted, and why not the stitcher.** `runPipeline.ts`'s
`preludeItem`, where the disclosure was already minted. The stitcher looks
like the natural home and the code disagrees, for the reason its own doc
comment gives: it "assembles what the acts contain, and the disclosure is not
part of any act". More concretely, `ForayStitcher` runs one act at a time
(F-66) so act 1 can reach a listener while act 4 is still being written, and
`items[0]` has to exist on the first partial candidate as well as on the
finished Foray. The orchestrator is the one place that prepends it on both
paths. `runtimeSecFor` needed no change: it already charges every narration
item its script at `NARRATION_CHARS_PER_SEC`.
**Done when.** `check-forays.mjs` fails a generated Foray with no prelude, and
fails one whose prelude is boilerplate with no overview after it. Both cases
are tested; the four Forays that predate the rule are named once in
`FORAYS_PREDATING_THE_NARRATOR_RULES` because their scripts are already
voiced.

### Q-08 · The narrator never mentions the Foray's own structure — **H · M — overlord (backend)** — **DONE** (2026-09-13)
**Ask.** Wyatt, 2026-09-13, verbatim: "the narrator should never mention acts
or beats in the context of the foray formatting (for example, saying 'this
foray has 3 acts' is NOK but mentioning 'in the first act of Macbeth' is fine
if it's relevant)."

**The measurement that decided the design.** On `main`, 2026-09-13, before
any of this: the four generated Forays break the rule **25 times across 157
narration items** — "Act one opens with", "Every fault this act named", "The
next act", "four acts", "this documentary", "this Foray leaves you with". And
every single one of those 25 is an act INTRODUCTION or EXIT, written by §4.4's
`deepenActs` or replaced by §4.8's continuity agent — not one is a seam. A
rule enforced only at the seam writer, or only at the publish gate, would have
caught none of them.

**The rule.** `backend/src/copy/narratorStructure.js` (plain JS beside
`copy/rules.js`, for that file's own reason: three consumers, no shared build
step). A structural noun — act, beat, segment, part, chapter, section — must be
ANCHORED to something outside this Foray, by an "of" phrase after it ("the
first act OF MACBETH") or a possessive before it ("MACBETH'S first act").
Unanchored, it can only mean the thing playing. Two holes in the "of" anchor,
because both are the banned shape in an anchor's clothes: "part one OF THREE"
counts the Foray's own pieces, and "the first act OF THIS FORAY" is the
self-reference spelled out.

**Where it is enforced — four places, because the prose has four producers.**
`validateDeepenedAct` (act introductions and exits, where the 25 were),
`validateSmoothedSeam` (the one stage that REPLACES an already-validated
introduction), `writeAct.ts`'s `validateSeam` (act prose, in code, so a
violation costs one re-ask rather than a Foray), and `check-forays.mjs` as the
ship gate. Plus the three prompts.

**Where it is imprecise, stated in the module.** It WRONGLY FLAGS a structural
noun whose external referent was named an earlier sentence ago ("Macbeth opens
in a storm. The second act is where it turns."), "the next part" meaning the
next stage of a process, "three parts hydrogen", and "the police beat". It
WRONGLY PASSES every self-reference that avoids those nouns — "coming up", "in
a moment", "before the break", "the second half".

**It caught the stubs.** `StubDeepenActBuilder` and `StubContinuityBuilder`
both spoke the running order ("the last act", "the next act", "this Foray",
and act TITLES, which are production metadata reading "Act 2: ..."), so the
one path a developer can run without an API key was the one path that
reliably produced the banned prose. Both now speak from the subject and the
act's own strand instead.

### Q-09 · A clip introduction names the podcast it came from — **M · S — overlord (backend)** — **DONE** (2026-09-13)
**Ask.** Wyatt, 2026-09-13, verbatim: "we should try to introduce any podcast
with a brief mention of what podcast it is, for example 'here's a clip from
XYZ emphasizing this point'". This extends Q-02, which already put a light
introduction before every clip.

**What was already there.** `introNamesSource` already required a full Intro
to name the show OR someone the episode title names, and `decideIntro` already
gave `full` whenever the EPISODE changed. So the show was already named on
every new episode — including the second, third and ninth episode of the same
show, which is exactly the grating repetition "try to" is hedging against.

**The rule chosen.** The show is named the FIRST time this Foray plays a clip
from it, and never required again. `ClipBrief.showFirstHeard`, computed from a
Foray-wide set of shows already named (`WriteActOptions.showsIntroduced`,
carried across acts like F-88's ground, because a listener does not forget a
name at an act boundary). A later clip from the same show still gets a full
introduction when the episode is new — Q-02's weight is unchanged — but it
owes a NAME, not the show's name, and may refer back lightly instead. The CLIP
line says which case it is, in the imperative, because the general rule is not
what a writer reads when it is looking at one clip. No template: the prompt
says to say it however the sentence wants it, and that the same sentence twice
is worse than not saying it.

### Q-06 · The acceptance test is a listening test — **founder gate**
**Ask.** After Q-01–Q-03 land, regenerate the run-8 prompt (the best-supplied
subject, *Being an Engineer*) and Wyatt listens to the first act on the phone.
Three questions, yes/no: does the narration read as one voice telling a story;
does every clip get an introduction that tells you who and what; does any clip cut
off before the thought ends. Three yeses close the deck; a no reopens the card it
names with the timestamp Wyatt gives. Pass rates in the report are diagnostics,
not the criterion.
**Human gate.** Wyatt.

---

## 4. Order and estimate

Wyatt, 2026-09-12: "Agree with 1, but that still seems short. If there's a half
hour of relevant content then let it ride. For 2, don't go overkill here. 3 sounds
good and likely decreases the number of agent calls. 4: sure. Go ahead and execute
on those." Two lanes, in parallel: **sourcing** (Q-01 then Q-04, one agent, a
day) and **narration** (Q-02 then Q-03 with Q-05's report fields, one agent, two
to three days). Q-06 closes. Everything is in the `backend/` and `tools/foray/`
lanes; the overlord labels under standing approval. No generation run is
launched for any reason other than Q-06 until this deck is done.

**Both lanes finished on 2026-09-12** (#646, #647, #650, #651), so the sentence
above holds nobody up any more: the only card left is **Q-06**, and Q-06 IS a
generation run — regenerate the run-8 prompt and Wyatt listens to act 1 on the
phone. Read the freeze as lifted for that run and for anything gated behind it.

## 5. Rules for the agents

**A card that supersedes a path DELETES the path in the same PR.** This is not
a style preference; it is the finding of the 2026-09-12 audit and of F-100, and
it has cost this pipeline three times. Q-03 replaced the per-slot narration
orchestration and left it standing as "the fallback for a builder without the
act contract" — a fallback no builder either factory returns could ever take,
so what it really was is a second definition of every mechanical rule that
nothing in production exercised. F-88 shipped a synthesis pass whose only
eligible input was produced by that same path, so from Q-03 onward it ran on
nothing. `CHECKPOINT_VERSION` stayed at 1 through nine stage changes, each
paying for itself with a back-compat shim reading a file that, given how
checkpoints are fingerprinted and discarded, does not exist anywhere. None of
the three is a bandaid; each is an un-deleted predecessor, and each made the
code read as though a choice were still open that had in fact been made.

So, concretely, in the PR that lands the card: delete the branch, the methods,
the prompts and the request/reply types the superseded path owned; make the new
contract REQUIRED on the interface rather than optional-with-a-fallback, so a
builder without it is a type error instead of a silent second route; bump
`CHECKPOINT_VERSION` and drop the shim rather than teaching the reader two
shapes; and PORT the tests — a test that only proves the old path still works
goes with it, a test of a RULE moves onto the new path and keeps its mutation
header. Say in the PR body how many were ported, how many deleted as flow-only,
and what behaviour is genuinely gone rather than translated. If deleting is
genuinely not possible in the same PR, say why in the card and open the
follow-up in the same breath; "we will clean it up later" is what produced the
three above.

One PR per card, tests green, mutation named in every test header, CRLF stays
CRLF, no `format:write` repo-wide, never `git worktree remove` a worktree whose
`node_modules` is a junction. Do not apply `founder-approved`. Every new backend
test file gets a floor in `test/suite-integrity.test.js`. Cite the card id in the
PR title. Measure on the run-8 candidate
(`relay/run/out-8/what-engineers-actually-do-all-day-how-e-4e64fd43.json`) before
and after, and put the numbers in the PR body.
