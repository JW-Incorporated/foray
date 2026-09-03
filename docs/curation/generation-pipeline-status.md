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

There is currently **no single CLI or script that drives all nine stages
end to end.** `backend/src/cli/generateForay.ts` (§4.0-4.1's own CLI)
stops at "understood" — §4.2 (research) is genuinely the next stage that
needs its own orchestration, not a gap this stage (§4.9) is responsible
for closing. `backend/src/cli/publishForay.ts` (§4.9's own CLI) picks up
at the OTHER end: it takes a `stitchForay()` result as a JSON file and
runs it through `finalizeForay()`. A founder (or a future orchestrating
script) is the connective tissue between the two today. Wiring one
top-to-bottom command is real, valuable future work — it is out of scope
for §4.9's own task brief ("finalize AND PUBLISH", not "orchestrate
4.0-4.8") and is recorded here rather than silently assumed away.

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
