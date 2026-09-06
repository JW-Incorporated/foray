# Generation pipeline — build status, honestly stated

Companion to `docs/curation/generation-architecture.md`. That document
describes the whole pipeline (§4.0-4.10) and the progressive-generation
model (§6). This file states, plainly and without hedging, how much of
that design is actually built as of §4.9's own kanban card (t_0b1729d6)
— because §7 of the architecture doc itself asks for this kind of honest
gap-tracking ("concrete gaps... each is a finding, not a decision").

## §4.0-4.9: built, batch, wired stage-to-stage

Every stage §4.0 through §4.9 exists as real, tested TypeScript in
`backend/src/generation/` and `backend/src/types/`, and each stage's
output type is the next stage's input type (`GenerationRequest` ->
`IntentUnderstanding` -> `ResearchShape` -> `Spine` -> `DeepenedAct[]` ->
`SourcedAct[]` -> `WrittenAct[]` -> `StitchForayResult` ->
`FinalizeForayResult`). This is a **batch call chain**: each stage is an
async function call that returns before the next one starts. Nothing
plays while a later stage is still generating.

**UPDATE 2026-09-05: this gap is closed.**
`backend/src/generation/runPipeline.ts` (`runForayPipeline`) drives §4.0
through §4.9 in one call, and `backend/src/cli/generateForays.ts`
(`npm run generate-forays`) runs it over a list of prompts. The paragraph
below is kept because it states what the shape of the gap was.

~~There is currently **no single CLI or script that drives all nine stages
end to end.**~~ `backend/src/cli/generateForay.ts` (§4.0-4.1's own CLI)
stops at "understood". `backend/src/cli/publishForay.ts` (§4.9's own CLI)
picks up at the OTHER end: it takes a `stitchForay()` result as a JSON
file and runs it through `finalizeForay()`. A founder was the connective
tissue between the two, which is why `data/forays.json` had four Forays
in it and not four hundred.

### What the first end-to-end run found

Running the chain for real immediately failed `check-forays.mjs` on every
prompt, four times over, for four different reasons — none of which any
per-stage test could have caught, because each is a property of the whole
Foray rather than of one stage:

| Failure | Cause | Fix |
|---|---|---|
| `items[0] is not the required disclosure` | §4.7's disclosure is a Foray-level obligation and no act produces it, so nothing in §4.0-§4.8 ever emitted it | the orchestrator prepends it |
| `segment "X" appears twice` | per-beat sourcing was stateless; two similar claims resolve to the same best segment | Foray-wide used-segment set, applied inside the ranked search so the beat keeps tape |
| `M3: plays at 1964 s after a later segment from the same episode` | nothing kept one episode's segments in ascending order | per-episode last-start guard |
| `M4: "X" is 33.3 % of segments` | nothing capped one episode's share | per-episode count cap at 25 % of beats |

**What is still not satisfied, and it is not a code gap.** With those four
fixed, candidates now fail only on the D-tier *editorial* rules — D3 (mean
segment duration ≥ 90 s), D5 (interquartile range ≥ 45 s; no three
consecutive durations within ±20 %). Those are distribution properties of
the tape a Foray is built from, and `data/segments.json` holds **212
segments over 64 sources**. The matcher cannot produce a varied running
order out of a pool that thin, and no amount of sourcing logic will change
that. **The binding constraint on publishable Forays is now the size of
the segment pool, not the pipeline.** The ~1,900 word-timestamped
transcripts the transcription farm has published to R2 are the raw
material for exactly that, and cutting them into segments is the next
piece of work.

## §6: progressive generation — NOT built, on purpose

§6 of the architecture doc describes a system where "playback begins
when Act 1 is complete... Acts 2..N are built while Act 1 plays." **None
of that exists.** Specifically:

- **§6.1 (spine frozen before playback)** — vacuously true today only
  because there is no playback-during-generation for a spine to be
  frozen against. `stitchForay()` (§4.8) already requires the full
  `DeepenedAct[]`/`WrittenAct[]` arrays up front; there is no partial or
  streaming variant.
- **§6.2 (revision is forward-only)** — the ONE piece of §6 that IS
  built, but only because it turned out to be the right shape for the
  batch pipeline too: `ContinuityBuilder`/`smoothSeam.ts` only ever
  touches the introduction of the act *about to be stitched*, never a
  prior act, so §6.2's "an already-played act is immutable" invariant
  holds by construction even though nothing has actually played yet
  when it runs.
- **§6.3 (the generation lead, and what happens when it runs out)** —
  **not built.** There is no live system generating act N+1 while act N
  plays, so there is nothing for "act N+1 must be complete before act N
  has \<X\> minutes remaining" to monitor. Building invariant-monitoring
  plumbing for a system that does not exist would be speculative code
  with no real integration point to test it against — the task brief for
  this stage (t_0b1729d6) explicitly calls this out as the wrong thing to
  build.

**What §4.9 DID build from §6.3, honestly scoped down:**
`backend/src/generation/stageTiming.ts`'s `measureStage`/`StageTimingLog`
record REAL wall-clock duration for any async pipeline stage — used by
`finalizeForay.ts` on its own two stages (`check-forays`, `check-narration`)
today. This is not a "generation lead" calculation — it has no live act
to measure against — but it is the honest, minimal, real piece of §6.3
that applies even to a batch pipeline: the day someone builds live
progressive generation, the stage-timing primitive already exists and
already has real numbers on record from the batch pipeline's own runs,
rather than a live system having to invent instrumentation from
scratch. See that module's own doc comment for the same argument in more
detail.

## §4.7's disclosure and §4.9's `generated: true` bit

One structural note worth recording here rather than only in code
comments: `check-forays.mjs`'s generated-Foray-only checks (disclosure
as `items[0]`, mandatory `mode` on narration items) are gated on an
explicit `generated: true` marker that only `finalizeForay.ts` sets
(§4.9's own job, per that file's own header comment and
`check-forays.mjs`'s `isGeneratedForay` doc comment). No committed Foray
in `data/forays.json` carries this bit today — the pipeline has not
published anything yet — so none of those generated-only checks can fire
on the four Forays that exist. The first real end-to-end run through
`publishForay.ts` is what will flip that bit for the first time.

## Summary table

| Section | Status |
|---|---|
| §4.0 Capture | Built (`generateForay.ts`, prompt capture only) |
| §4.1 Understand/safety/clarify | Built |
| §4.2 Research shape | Built |
| §4.3 Spine | Built |
| §4.4 Deepen acts | Built |
| §4.5-4.6 Source beats | Built |
| §4.7 Write narration | Built |
| §4.8 Stitch | Built |
| §4.9 Finalize/publish | Built (this card) |
| End-to-end orchestration (4.0->4.9 in one run) | **Not built** — founder is the connective tissue today |
| §6.1 Spine frozen before playback | N/A — no playback-during-generation exists |
| §6.2 Forward-only revision | Built, incidentally correct for the batch shape too |
| §6.3 Generation lead + stall handling | **Not built** — no live system to attach an invariant to. Minimal real piece (stage timing) built instead. |
