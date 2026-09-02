# Foray generation architecture — the working prompt

**Status:** design prompt. Nothing described here is built.
**Supersedes:** `Foray Architecture Notes.txt` (2026-08-31).
**Intended home:** `docs/curation/generation-architecture.md`.
**Audience:** an AI session that already knows the 4a codebase. This document does not re-explain the app.

---

## 0. What this document is for

Today a Foray is authored: an agent researches a topic over days, a founder reviews it, and the
result lands in `data/forays.json` as an ordered list of pointers into `data/segments.json`. Four
Forays exist. The one that is fully built — *The history of grilling* — is 3,673 seconds across
6 slots and 32 items.

This document specifies the pipeline that replaces the *authoring* with a **prompt**, and does it
fast enough that a listener can start hearing Act 1 while the rest is still being built.

**What does not change:** the player, the data model, the legal posture, the copy rules, the
product principles. A generated Foray must be indistinguishable in shape from an authored one —
same `forays.json` schema, same `segments.json` pointers, same `check-forays.mjs` gate. If the
generator needs a schema change, that is a finding to surface, not a liberty to take.

**Your job when handed this document:** turn a named section into a spec with acceptance criteria,
or implement a section that already has one. Do not implement across section boundaries in one PR.
Anything in §9 is unresolved and must not be built until it is ruled on.

---

## 1. Rulings — settled 2026-08-31, do not relitigate

Four decisions were taken by Wyatt. Each one closes a fork that otherwise reopens in every session.

### 1.1 Seek-and-stop holds. No derived audio artefact, ever.

ADR-0007 stands unchanged: *"Playback remains seek-and-stop against the publisher's original
enclosure. No derived audio artefact is produced at any point."*

"Stitching," everywhere in this document, means **assembling an ordered manifest of pointers** —
never downloading, re-encoding, concatenating, or re-hosting a publisher's audio. A Foray is a
playlist with in-points and out-points. The only audio bytes 4a may ever originate are its own
narration and its own jingle.

This is product principle #3 and it is not a technical preference. Any proposal that produces a
mixed audio file triggers legal review before anything else happens.

### 1.2 Narration is spoken on-device. A backdoor exists for curated Forays.

Default: the narration item carries a **script**, and the device speaks it with the platform's own
voice engine. Zero TTS spend, zero hosted bytes, works offline, and — critically — nothing has to
be rendered before playback can begin, which is what makes §6 possible at all.

An admin-authored Foray may instead carry a pre-rendered asset for a custom voice. The data model
must support both from day one: **a narration item may carry `script`, `asset`, or both**, and the
player prefers `asset` when present.

This supersedes the assumption in `docs/narrator-pipeline.md` that narration is always pre-rendered
ElevenLabs audio on Supabase. That document's cost work stays valid for the backdoor path; its
premise that narration audio must exist before a Foray can play does not.

> **This ruling has a hard technical dependency that is not yet settled — see §9.1.** The Web
> Speech API is not the `<audio>` element, and the measurement that proved backgrounded audio
> survives on iOS says nothing about `speechSynthesis`. Treat on-device narration as **blocked on a
> native TTS plugin** until someone measures it with the screen locked.

### 1.3 Day 1 is admin-authored. On-demand-and-published follows early.

Three phases, in order:

| Phase | Who prompts | Where the Foray goes | Moderation stakes |
|---|---|---|---|
| **1 — now** | Wyatt and Joey | Reviewed, then the shared catalogue | Low. A founder is the filter. |
| **2 — early** | Any user | Published to the shared catalogue | **High.** See below. |
| **3 — roadmap** | Any user, rewarded for listens | Shared catalogue + creator incentives | High, plus incentive-gaming. |

Build phase 1 so phase 2 is a permission change, not a rewrite. Concretely: the pipeline takes a
prompt and an author identity from the start, and every generated Foray records who prompted it,
even when the answer is always a founder.

> **Phase 2 changes what 4a is to Apple.** The moment a stranger's prompt produces content other
> users can hear, 4a hosts user-generated content and App Store Guideline 1.2 applies: content
> filtering, a mechanism to report objectionable content, a way to block abusive users, and
> published developer contact information. None of the four exist. This is a submission-blocking
> discovery for phase 2 and it belongs in `HUMAN-ACTIONS.md` the day phase 2 is scheduled — not the
> day it ships.

### 1.4 Playback starts before generation finishes.

The listener presses play when Act 1 is complete. Acts 2..N are built while Act 1 plays. See §6 for
the invariants this forces — and note that it makes one step of the original sketch impossible as
written.

---

## 2. Vocabulary — use these words, they already exist

The repo already has a working vocabulary across `docs/curation/`. Do not invent a parallel one.

| Term | Means | Precedent |
|---|---|---|
| **Foray** | The whole session. 15 min to ~3 hr. | `data/forays.json` |
| **Act** | Top-level narrative movement with its own start, end and thesis. 1–7 per Foray. | `alcohol-forms-coverage.md`, "Act I has no strong tape" |
| **Slot** | The subdivision inside an act — the persisted field the player sees. | `forays.json` `slots[]`, `items[].slot` |
| **Beat** | **The atomic unit of content.** One idea that must land. | Used throughout `docs/curation/` — "a beat is strong only where all four hold" |
| **Tape** | Real podcast audio. Radio's word, already ours. | `narration-craft.md`, "joins two pieces of tape" |
| **Narration** | 4a's own spoken words. Six modes, §2.1. | `narration-craft.md` |
| **Seam** | The join between two items. | `player/seam-gap.js` |
| **Spine** | The planned structure before any content is sourced. | `alcohol-forms-spine.md` |
| **Jingle** | 4a's own sonic mark. New; see §4.8. | — |

**One reconciliation to make.** The original sketch nests *act → chapter → key point*. The repo
persists *foray → slot → item*. Rule: **act is the planning layer, slot is the persistence layer,
and one act may contain several slots.** A generated Foray writes acts into the spine document and
slots into `forays.json`. Do not add an `act` field to `forays.json` without deciding whether the
player needs it — today it does not.

### 2.1 The six narration modes

Already defined in `docs/curation/narration-craft.md` with word and character budgets. A script
author picks one per narration item and the mode fixes the budget.

| Mode | Job | Seconds |
|---|---|---|
| Hinge | Closes one piece of tape, opens the next | 3–8 |
| Frame | Introduces tape that carries the beat itself | 4–10 |
| Marker | Announces structure — a boundary, a step out of sequence | 8–20 |
| Correction | Bounds, attributes or contradicts adjacent tape | 6–12 |
| Patch | Supplies the part of a beat its tape misses | 20–45 |
| Carry | **Is** the beat; there is no tape | 45–110 |

A fully-AI Foray is a Foray of Carries. That is permitted (§4.5) and it is the mode to watch: a
three-hour Foray that is 90% Carry is the failure case the original sketch names as "listening to
an AI blab for three hours."

---

## 3. Inputs

A generation request is:

```
{
  prompt:      string,        // freeform, the user's words
  duration:    "short" | "medium" | "long",
  author_id:   uuid,          // auth.uid(); a founder in phase 1
  visibility:  "catalogue"    // phase 1 & 2; reserved for later privacy work
}
```

**Duration targets**, anchored on the one real 60-minute Foray we have (6 slots, 32 items):

| Option | Target runtime | Acts | Slots | Items | Notes |
|---|---|---|---|---|---|
| Short | ~15 min | 1 | 2–3 | 8–10 | One thesis, no act structure worth naming |
| Medium | ~60 min | 3–4 | 5–7 | 28–36 | The proven shape |
| Long | up to ~180 min | 5–7 | 12–18 | 80–110 | Unproven at every layer |

Treat these as budgets the planner must hit, not as outputs to measure afterwards. A Foray that
overshoots its duration by 40% is a defect, because the duration option is the listener saying how
much time they have — overshoot is never justified and the ±40%/±15% figures (§8) always apply to
it as written.

**Undershoot has exactly one sanctioned exception: §9.3's thin-topic ruling.** A topic too thin for
real tape at the requested duration is allowed to come in short, provided the Foray records why
(a `duration_shortened_reason` field on the published item) and says so in an explicit narrated
beat — never padded with filler to hit the requested duration (§9.3). An undershoot with no
recorded reason and no narrated explanation is a defect on the same terms as any overshoot.

---

## 4. The pipeline

Ten stages. Each names its inputs, its output, who runs it, and what constrains it.

### 4.0 — Capture the prompt

A freeform text field plus the duration selector. Nothing else. Resist adding topic pickers,
tone sliders or checkboxes: product principle #2 is *state observed, never declared*, and every
control added here is a declaration the listener has to make before they get anything.

### 4.1 — Understand, disambiguate, and refuse

Three things happen, in this order, and the order matters.

**Safety first.** Check the prompt against the forbidden-topics list before spending anything on
understanding it. Sexual content involving minors, instructions for mass-casualty weapons, targeted
harassment of a named private individual — the list belongs in a committed, tested module, not in a
system prompt where it cannot be reviewed or unit-tested. A rejected prompt gets a plain, specific,
non-preachy explanation and no retry loop.

**Then clarity.** If the prompt is genuinely ambiguous, ask **one** question with two or three
concrete readings and an escape hatch: *"Did you mean A, B, or something else?"* One round, never
two. A listener who wanted to press a button and drive away has already lost patience by the second
question, and an ambiguous prompt resolved badly costs less than an interrogation.

The bar for asking is high. "Roman siege weapons" is not ambiguous. "Mercury" is.

**Then intent.** Produce a structured understanding: the subject, the angle, what the listener
probably already knows, and what would make this Foray a disappointment. That last field is worth
more than the other three — it is what the final coherence check tests against.

**Open:** whether a rejected or clarified prompt is stored. It is a behavioural signal and it is
also a record of what people asked 4a for. Privacy posture is unresolved (§9.4).

### 4.2 — Research to establish the shape

Enough research to know what the acts are, not enough to write them. The goal is a map: what the
major sub-topics are, where the genuine controversies sit, what the non-obvious angle is, and
roughly how much material exists in each direction.

Two sources, and the order is deliberate:

1. **The catalogue we already have.** `data/discover.json` (1,855 items), `data/catalog.json`
   (220 shows), `data/semantic-index.json` and `data/item-tags.json`. This is free, instant, and it
   tells you where tape is likely to exist — which shapes the spine before it constrains it.
2. **External research**, for the parts the catalogue cannot answer.

**A Foray's shape should be influenced by where tape exists, but not dictated by it.** An act with
no tape is permitted (§4.5). An act invented *because* tape happened to exist is how you get a
Foray about the wrong thing.

### 4.3 — Build the spine

One document, produced in one context by one agent. This is the highest-leverage artefact in the
pipeline and splitting it is the most likely way to produce an incoherent Foray.

The spine contains:

- **The acts.** Each with a title, a thesis, an explicit start state and end state — what the
  listener believes at the start of the act and what they should believe at the end — and the
  beats that get them there.
- **The slots** each act decomposes into.
- **The beats**, in order, each stated as a claim rather than a topic. "Charcoal briquettes were a
  Ford Motor Company waste-disposal scheme" is a beat. "Briquettes" is not.
- **The voice.** Writing style, register, sentence rhythm, how much the narrator is allowed to be
  present. A Foray on fusion reactors and a Foray on 1970s fashion do not share a voice, and the
  voice must be decided **here**, once, so that every downstream writer inherits it rather than
  inventing one.
- **The exploration budget.** Product principle #1 keeps a ~30% floor. In a generated Foray this
  means: at least ~30% of beats should go somewhere the prompt did not literally ask for but a
  curious listener would be glad to have been taken. This floor is required and counts toward §8's
  publishability check regardless of how generation goes — it is what makes a generated Foray
  something other than a straight answer to the prompt, and no cutting pass, cost- or time-driven,
  may take it below ~30%.
  Separately, on top of the required floor and **outside the act's planned runtime budget**, mark
  exactly **two additional exploration beats per act as "deferrable."** These are held in reserve,
  not scheduled into the act's normal running time, and are the one and only §6.3 time-buffer
  valve: on a **time** shortfall they get inserted to genuinely extend the act while act N+1
  finishes, which is the recovery buffer §6.3 needs; when generation is on schedule they are simply
  never generated or played. A **cost**-cutting pass drops them outright, same effect as never
  needing them. Because they sit outside the required floor and outside the runtime budget either
  way, neither path touches the number §8 checks or the duration §3 budgets.

**The spine is frozen before playback begins.** See §6.

### 4.4 — Deepen each act

One agent per act, in parallel. Each receives the full spine — not just its own act — and owns
exactly one act. It refines that act's slots, sharpens its beats, and writes the act's own
introduction and its exit into the next act.

The full-spine context is what stops act 3 from re-explaining what act 1 established.

### 4.5 — Source each beat: tape or narration

For every beat: is there real tape that carries this, or do we write it?

**Tape is preferred and the preference is not close.** Real voices, real reporting, real
practitioners. It is what makes 4a a curator rather than a text-to-speech front end, and it is what
the copy rules and the whole segment-extraction pipeline exist to serve.

Search order:

1. **`data/segments.json`** — 212 extracted segments over 64 sources. Already anchored, already
   confidence-rated. Cheapest possible hit.
2. **The transcript archive** — for episodes we hold transcripts for but have not yet cut into
   segments. A hit here produces a *new* segment via the existing extraction path
   (`docs/curation/segment-extraction-pipeline.md`), with real `start_anchor` / `end_anchor` text
   anchors, not raw timestamps.
3. **The catalogue without transcripts** — a candidate episode with no transcript cannot be cut
   and therefore cannot be used. It can be logged as a transcription-queue candidate.

> **The archive is the binding constraint, and it is small.** 15 normalized transcripts on disk,
> 212 segments, 64 sources. At that scale, most beats will find nothing, and the pipeline will
> default to full-AI narration — which is the outcome the original sketch called "acceptable, though
> not totally preferred." **Growing and cataloguing the transcript archive is not a side task; it is
> the difference between 4a and a podcast-shaped chatbot.** Treat it as a parallel workstream with
> its own plan, not as a prerequisite that quietly blocks this one. Note that Joey is focusing heavily on this problem at the moment.

When no tape exists, the beat becomes narration — usually a **Patch** or a **Carry**.

**Resolved (§9.3, 2026-09-02):** there is no ceiling on narration share and no refusal path. A
Medium/Long Foray too thin for real tape at the requested duration gets shorter instead, per §9.3
and §3's undershoot exception — it is never reshaped-toward-tape or refused.

### 4.6 — Resolve the tape

For each chosen segment, produce a pointer: `item_id`, `start_sec`, `end_sec`, and the text anchors
that let the boundaries be re-derived if the episode's audio shifts. This is the existing segment
contract; use it exactly.

Nothing is fetched. Nothing is cut. Nothing is stored but numbers and quoted anchor text. §1.1.

### 4.7 — Write the narration

One page per narration beat, in the spine's voice, in one of the six modes, inside that mode's
budget.

**Factual accuracy is the product risk that kills this feature.** Narrating confident nonsense
loses a listener permanently and there is no recovery, because they will not be listening when you
correct it. Minimum bar:

- Every factual claim in a narration page carries a source, recorded alongside the script even
  though it is never spoken.
- A verification pass reads the page against its sources — a different agent, not the writer.
  Self-review of one's own generated prose does not find this class of error.
- Where a claim is genuinely contested, the narration says so. "Contested" is more interesting
  than a confident wrong answer, and it is also honest.

**The style guide the writers inherit** must be pre-loaded, not rediscovered per Foray:

- The existing copy rules apply, unchanged: hooks ≤ 16 words, why-lines ≤ 18. Banned:
  *fascinating*, *deep dive*, *delve*, *explores*, clickbait withholding, commute-length framing.
- No vulgar or gratuitously edgy content; the register is a well-read friend, not a shock jock.
- Pronunciation control for hard and foreign words — **and see §9.1, because on-device Web Speech
  has no pronunciation API at all.** Whatever mechanism is chosen, the script format must carry the
  pronunciation hint from day one even if nothing consumes it yet.
- Never speak a URL, a citation, or a number the listener cannot hold in their head while driving.

**The first item of every generated Foray is a disclosure**, spoken before anything else:

> *"This is a Foray about \<subject\>. Much of what you'll hear is written by AI. We work hard to
> get the facts right, but AI gets things wrong — so take it as a starting point, not a source."*

Write it once, as a template, and gate it in `check-forays.mjs`: **a generated Foray whose first
item is not the disclosure fails validation.** It should be impossible to publish without it.

### 4.8 — Stitch

Assemble the ordered item list and make it flow. The stitching agent has real authority here: it
may rewrite the leading and trailing sentences of any narration page it owns, and it may reorder
beats within a slot.

Four rules:

**Silence is a valid bridge.** If one piece of tape flows naturally into the next, insert nothing.
A narrator saying *"and that brings us to our next topic"* is worse than a clean cut. Note that
`player/seam-gap.js` already returns 0 for a bridged seam — a bridge and a gap are alternatives,
never both.

**The jingle marks a change of tape.** Where a cut needs marking but not narrating, a short 4a
sonic mark does the work. It must be an original asset we own, roughly 1–2 seconds, and it should
be the same one every time — it is a brand mark, and its value is entirely in being recognized.
It is also the only element in this pipeline the listener will hear a hundred times, so it must be
designed to survive that.

**Texture on a cadence.** Three hours of unbroken narration is unlistenable. RadioLab-grade sound
design is far beyond scope, but a jingle or a beat of silence roughly every few minutes gives the
ear a boundary to rest on. Propose a cadence, measure it against a real long Foray, and write down
what you measured — do not ship a number that was guessed.

**Coverage is checked before flow.** Every beat in the spine is either present or explicitly
dropped with a reason. A silently missing beat is the failure mode that makes a Foray feel like it
was about nothing.

### 4.9 — Finalize and publish

Validate against `check-forays.mjs` and `check-narration.mjs`. Write `data/forays.json`. In phase 1
this is a PR a founder reviews; in phase 2 it is an automated publish and the validators are the
only gate that exists — which is the reason to make them strict now, while a human is still in the
loop to notice what they miss.

### 4.10 — Play

The player renders narration items with the on-device voice engine and tape items by seeking into
the publisher's original enclosure. An admin-authored Foray with a pre-rendered `asset` plays that
instead.

---

## 5. Agent topology — how many agents, and where

*This section answers the "note to reviewer" in the original sketch.*

### The rule

**Parallelize where the unit is independently verifiable. Serialize where coherence is the
deliverable.**

Every parallel boundary costs you a shared context. That cost is worth paying when the work splits
into pieces that can each be checked on their own, and never worth paying when the thing you are
producing *is* the relationship between the pieces.

### The shape

| Stage | Agents | Why |
|---|---|---|
| 4.1 Understand | 1 | Trivial work; splitting it costs more than it saves. |
| 4.2 Research shape | 1, may fan out for lookups | The synthesis has to happen in one head. |
| 4.3 Spine | **1, always** | The spine *is* the coherence. This is the one stage where parallelism is actively destructive. |
| 4.4 Deepen acts | **1 per act** (3–7) | Acts are genuinely independent once the spine fixes their endpoints, and this is the stage with the most work per unit. The natural parallel boundary. |
| 4.5–4.7 Source + write | **The act's own agent**, batched | See below. |
| 4.8 Stitch within act | The act's agent | It wrote the pages; it knows the voice. |
| 4.8 Stitch across acts | **1 continuity agent** | Act seams are the only place no single act agent has context. |
| 4.9 Verify facts | **1 per act**, never the writer | Independent verification is the point. |

**A 60-minute Foray is about 6–8 agents.** One planner, four act agents, four verifiers, one
continuity pass. Not forty.

### Why not an agent per beat

The obvious next step — one agent per beat — is wrong for three reasons, and it is worth stating
them because it will be proposed again:

1. **A beat is small.** A Hinge is 50–135 characters. Spawning an agent to write one sentence costs
   more in prompt overhead than the sentence costs to write.
2. **Voice drifts.** Thirty agents writing thirty pages against the same style guide produce thirty
   subtly different narrators. Voice consistency is not a rule you can write down precisely enough
   to survive that; it survives by one writer holding a whole act.
3. **Flow is lost.** A beat's last sentence exists to set up the next beat's first. An agent that
   cannot see the next beat cannot write that sentence.

Write beats in batches, within an act, by the agent that owns the act.

### Where to scale if a long Foray is too slow

In this order: more acts (which buys more parallelism naturally), then splitting research from
writing within an act, then — last — splitting a single act's writing across two agents with an
explicit handoff at a slot boundary. Never split mid-slot.

---

## 6. Progressive generation — and the one thing it makes impossible

Playback begins when Act 1 is done. This is a good decision — it turns the listener's own listening
time into generation budget, and on-device narration means there is no render step standing between
"written" and "audible." But it forces three invariants and kills one step of the original sketch.

### 6.1 The spine is frozen before playback

Acts are planned in full *before* Act 1 is written. Only then is playback allowed to start. If the
plan could still change, Act 1 could be wrong, and Act 1 is the part you cannot take back.

### 6.2 Revision is forward-only

**Once the listener has heard an act, that act is immutable.** This is the step the original sketch
cannot keep as written: *"an agent does a final pass that the Acts fit together well, and makes
small adjustments as needed."* There is no final pass over a Foray that is already playing.

The work that pass was doing has to move:

- **Global coherence moves to §4.3**, the spine. Decide how the acts fit at plan time, when nothing
  has been heard.
- **The continuity agent becomes forward-only.** It runs at each act boundary and may adjust the
  act about to be built, never the one already played. Act 4 adapts to what act 3 actually said;
  act 3 does not get fixed.
- **A late-discovered gap becomes act N+1's problem**, or it is dropped with a reason. It is never a
  retroactive patch.

This is a real constraint and it costs some polish. It is the price of playing early, and it should
be stated in the spec rather than discovered when someone tries to write the final pass.

### 6.3 The generation lead, and what happens when it runs out

Define an explicit invariant: **act N+1 must be complete before act N has \<X\> minutes remaining.**
Pick X, measure it, write it down.

Then decide what happens when generation falls behind, because it will. Options, none free:

- Stall with a spoken line — honest, and terrible in a car.
- Insert the current act's two reserved deferrable beats (§4.3) to genuinely extend the act while
  act N+1 finishes writing — needs the spine to carry them, which it already does.
- Degrade the remaining acts to a cheaper, faster pipeline — quality cliff, but no silence.

**Recommendation: the reserved deferrable pair.** §4.3 has each act carry two exploration beats
held in reserve, outside the act's normal runtime budget, marked "deferrable." They serve two
different pressures and never both at once: a **time** shortfall (this section) inserts them into
the act, which is what actually buys the extra minutes act N+1 needs — since they are not part of
the act's planned run when on schedule, an on-time act never generates or plays them at all. A
**cost** shortfall (a cutting pass trimming spend, not a live time deficit) drops them outright,
same effect as never needing them — §8's "exploration budget survived" check nets out at most this
reserved pair being actually dropped for cost; the rest of the ~30% floor is never touched by
either pressure. A generation lead that is both behind on time and needs to cut beyond the reserved
pair has exhausted the one buffer this document authorizes and must fall back to one of the other
two options above. Whatever is chosen, a silent stall mid-commute is the worst outcome and the one
to design against.

---

## 7. What this asks of the player that it cannot do today

Concrete gaps. Each is a finding, not a decision.

1. **A narration item with no asset is currently dropped.** `player/foray-queue.js` takes narration
   audio from `audio_url` or `asset` and drops an assetless item with a reason. On-device narration
   inverts this: the common case is **script, no asset**. The queue must treat a script as a
   playable item.
2. **`resetRateForTTS` assumes a rendered file.** It forces 1.0x on the way into narration and
   defers a speed tap until the line ends. With a synthesizer, rate is a property of the utterance,
   not the media element. The intent — *our line plays at the pace we chose* — survives; the
   mechanism does not.
3. **Duration is unknown before speaking.** A rendered file has a length. A synthesized utterance
   does not until it is spoken, which means `runtime_sec`, the seam logic and the generation-lead
   calculation in §6.3 are all working from an estimate. `narration-craft.md`'s
   characters-per-minute figures are the estimator; their error bars need measuring.
4. **The jingle needs a home.** A third item kind alongside tape and narration, or a property of a
   seam. Decide before it is scattered through the schema.
5. **`check-forays.mjs` barely validates narration.** Today a narration item needs a non-empty `id`
   and nothing else — no script, no asset, no mode, no slot binding. For generated Forays this
   validator is the last gate before publish; it needs to enforce the disclosure item, the mode
   budgets, beat coverage, and the presence of either a script or an asset.
6. **Transcripts are not available at playback time.** They live in `data-local/`, gitignored,
   machine-local. Nothing in the shipped app can read them. This does not block generation, but it
   blocks §10 entirely.

---

## 8. Quality bars

A generated Foray is publishable only if all of these hold:

- Every spine beat is present, or explicitly dropped with a recorded reason.
- Every factual claim in narration has a recorded source, and a verifier other than the writer
  has checked it.
- The disclosure is the first item.
- Copy rules pass: hooks ≤ 16 words, why-lines ≤ 18, no banned phrasing.
- Runtime is within tolerance of the requested duration: ±15% (a defensible starting point), except
  an undershoot made under §9.3's thin-topic exception, which is exempt from the tolerance provided
  it carries a recorded `duration_shortened_reason` and an explicit narrated explanation (§3).
  Overshoot has no exception at any margin (§3).
- Narration share may be up to 100% (§9.3) — there is no ceiling. A Medium/Long Foray whose topic is
  too thin for real tape at the requested duration must take the §9.3 shortening path instead of
  padding with synthetic filler to raise or preserve narration share.
- The exploration budget survived — the required ~30% floor (§4.3) is untouched, net of at most the
  two per-act "deferrable" beats actually dropped by a §6.3 cost-cutting pass. Those two beats
  being inserted for a time shortfall, or simply never generated because the act stayed on
  schedule, are not deductions against the floor; only an actual cost-driven drop is.
- `check-forays.mjs` and `check-narration.mjs` pass.

---

## 9. Open questions

Unresolved. Do not build past these; surface them.

**9.1 — Does on-device speech survive a locked screen?** *Owner: engineering. Blocks §1.2.*
The whole product is locked-screen listening in a car. CI measured that a plain `<audio>` element
survives backgrounding on iOS with 0.004 s out-point overshoot — but `speechSynthesis` is a
different API with no such exemption, and it very likely stops when the WebView is backgrounded.
If it does, on-device narration in the Capacitor shell requires a **native TTS plugin**
(`AVSpeechSynthesizer` on iOS with the right audio-session category, `TextToSpeech` on Android)
rather than the Web Speech API. That plugin also solves pronunciation, which Web Speech cannot do
at all. **Measure this before anything else in this document is built** — it is cheap to test and
it invalidates a whole branch if it fails.

**9.2 — What is the per-Foray cost ceiling?** *Owner: Wyatt.*
Research, a spine, per-act deepening, per-beat writing and independent verification is a lot of
tokens. Phase 2 lets strangers spend it. Every call routes through the cost-metering budget guard,
but the guard needs a number, and a Foray that costs more than a listener is worth is a product
that cannot ship. Needed: a ceiling per duration tier, and what happens at the ceiling.

Answer from Joey (2026-08-31): Set generous now (~$5–10/Foray) — this is founder-only in Phase 1
and cost is not the binding constraint yet. Revisit before Phase 2, when a stranger's prompt spends
the budget.

**9.3 — What is the maximum narration share?** *Owner: Joey.*
Full-AI is permitted. But a three-hour Foray that is 95% synthetic narration is a different product
from the one 4a claims to be, and with 212 segments in the archive it is also the *default* outcome
today. Needed: a ceiling, and the behaviour at the ceiling — refuse, reshape toward where tape
exists, or shorten.

Answer from Joey (2026-08-31): 100% AI narration is permitted. If a Medium/Long Foray is requested
on a topic too thin for real tape (the doc's own example: a 3-hour Foray on the origin of
"onomatopoeia"), the Foray gets SHORTER instead, with an explicit narrated explanation of why —
never padded with filler to hit the requested duration. Reshaping-toward-tape and outright refusal
were both explicitly rejected in favor of this.

**Resolved (2026-09-02):** there is no narration-share ceiling; §8's quality bar and §3's duration
contract have been corrected to state this directly rather than pointing back here for a number
that was never set. The undershoot this ruling authorizes is the one sanctioned exception to §3's
duration-tolerance rule — see §3 and §8.

**9.4 — Are prompts stored, and are they public?** *Owner: Wyatt + legal.*
Prompts are a strong behavioural signal and a privacy liability. In phase 2 a published Foray
implicitly exposes what someone asked for. Needed: retention, whether the prompt is shown on the
published Foray, and whether rejected prompts are kept.

Answer from Wyatt: Each prompt is discarded. the Foray is given a title on creation, which is retained.

**Flagged for founder clarification (2026-09-02) — collides with §9.6.** §9.6's dedup ruling
requires detecting "when a prompt is very similar to an existing Foray," which needs the original
prompt text (or a vector derived from it) to compare against; a retained title is not a working
substitute — titles are short, editorial, and not written to be prompt-similarity-preserving.
`backend/test/promptNoPersistence.test.ts` (kanban t_825eee4c, merged) currently enforces this
stage's *literal* no-persistence behaviour — it scans the §4.0-4.1 source for a fixed set of direct
persistence calls (`fs.write*`, `localStorage`, SQL/`Pool`/`localforage` calls) and confirms the
returned intent object carries no field literally named `prompt` or `rawPrompt`. It does not, as
written, catch every possible route to persisting a *derived* value (an embedding stored through an
unlisted API, or returned under a different field name) — so it is a real but partial safeguard,
not a guarantee that would need "relaxing." Resolving §9.4 vs §9.6 is still a real product/privacy
tradeoff, not a wording ambiguity to default past. **One line needed from Wyatt (+ legal per this
section's own owner line):** is a one-way prompt embedding (not the raw text, never displayed,
unrecoverable to the original wording) an acceptable exception to "each prompt is discarded,"
solely to power §9.6 dedup? If yes, §9.6 is implemented against that embedding and
`promptNoPersistence.test.ts` is extended — not merely relaxed — to explicitly allow and verify
exactly that one derived artifact (asserting what it stores and does not store) rather than being
silently satisfied by omission. If no, §9.6 must be re-scoped to title-similarity only (a
materially weaker dedup, which should be said explicitly rather than implied) — do not build the
embedding path until this line is answered.

**9.5 — What does a listener do with a bad Foray?**
No feedback path is specified. This matters more in phase 2, and it is also the raw material for
phase 3's ranking. Thumbs already exist in the client; decide whether Foray-level feedback is the
same mechanism or a different one.

**9.6 — Deduplication.** Two listeners ask for the same thing a week apart. Regenerate, serve the
existing Foray, or generate a variant? Affects cost, catalogue quality, and whether the catalogue
fills with near-duplicates.

Answer: when a prompt is very similar to an existing Foray, the user is asked if they want to listen
to that Foray. If they decline, a new one is created.

**Not fully buildable yet — depends on §9.4.** The similarity comparison this ruling requires needs
a stored representation of the prompt to compare against (see §9.4's flagged founder
clarification). Do not implement the similarity check until §9.4 answers whether a one-way
embedding is permitted; until then, at most a title-similarity check can ship, and it should be
labeled in code and UI copy as approximate, not as the dedup this ruling describes.

---

## 10. Roadmap — the interruptible narrator

*Not now. Specified here so the pipeline does not foreclose it.*

The goal: at any point, the listener asks a question about what they are hearing and gets a real
answer, in context, hands-free. *"The podcaster just said something about cherry blossoms — what was
that?"*

### 10.1 There is no wake word, and this is already decided

`docs/brief/01_PROMPT.md` constraint #6 is explicit: **"No wake word — not reliably possible for
third-party iOS apps in background; don't burn time on it."** The "Hey 4a" framing in the original
sketch is not achievable on iOS for a third-party app.

What is achievable, and gets most of the value:

- **Hold-to-talk** — a large, reachable button; already the specified interaction, already carrying
  `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` in the iOS config.
- **Siri App Intents** — *"Hey Siri, ask 4a about that"* is genuinely hands-free and is the real
  answer for driving.
- **CarPlay controls** — a steering-wheel button is better than a wake word in a car anyway.

### 10.2 Most of the architecture exists

`ForayKit/IntentGrammar.swift` already implements a two-tier design: **Tier 1** is a deterministic
offline keyword grammar answering in under 300 ms, returning `recognized`, `needsConfirmation`, or
`unrecognized`, with ordinals beating fuzzy title matches and no guessing under road noise.
**Tier 2** is free-text fallback for anything Tier 1 does not recognize.

Open-ended Q&A is Tier 2, extended. It is not a new architecture; it is the branch that was always
planned and never built. Note that `IntentGrammar.swift` has no JavaScript counterpart, so the
Capacitor shell has none of this today.

### 10.3 What has to be built

1. **Audio choreography.** Duck playback, capture, answer, resume at the exact position. The brief
   already calls this the highest-polish-risk area in the app: `AVAudioSession` category
   transitions across playback, recording, nav-prompt ducking, phone-call interruption and
   Bluetooth route changes. Prototype it before building UI on top of it.
2. **On-device ASR.** `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`. Already the
   ruling; keep it. Mic audio should not leave the phone.
3. **The context payload — the hard part.** To answer "what did they just say about cherry
   blossoms," the model needs the transcript window around the playhead. Today transcripts are
   machine-local and gitignored (§7.6). This needs a delivery path that does not exist: transcript
   windows available at playback time, aligned to position, for the currently-playing segment only.
   **This is the single largest piece of work in the feature** and it is invisible from the UI
   description.
4. **The answer.** One LLM call with the transcript window, the beat's own context, the spine, and
   the question. Through the budget guard. Spoken by the same voice path as narration.
5. **Actions, not just answers.** *"Start a Foray about that"* routes back into §4.0 with the
   context as the prompt. This is where the interrupt feature and the generation pipeline meet, and
   it is the most compelling thing in this document.
6. **Graceful degradation.** Tunnels exist. Tier 1 works offline by design; Tier 2 cannot. Failing
   loudly and instantly is better than a five-second silence.

### 10.4 What it costs

Every interrupt is an LLM call at the moment of maximum impatience, so latency is the whole
experience. It is also an open-ended AI assistant inside the app, which changes the App Store review
posture again and adds a moderation surface that has nothing to do with Forays. Both belong in the
spec before this is scheduled.

---

## 11. Roadmap — creator rewards

*Phase 3. Recorded so phase 2 does not make it impossible.*

Users whose Forays attract listens get rewarded. Two things to preserve now, both cheap now and
expensive later:

- **Attribution.** Every generated Foray records who prompted it, from phase 1. Already required by
  §1.3.
- **Listen accounting.** Per-Foray listen events, attributable, at a granularity that can
  distinguish a real listen from an open-and-abandon. The events pipeline already exists and is
  live; the schema needs to carry `foray_id` from the start.

And one thing to decide before it is built: **rewarding listens creates an incentive to game
them**, and it points the catalogue toward whatever is most clickable. That is in direct tension
with product principle #1 — curiosity first, no engagement dark patterns. A reward mechanism that
optimizes for listens will, given time, produce exactly the content the exploration floor exists to
prevent. Design the incentive against the principle, or decide the principle bends. Do not discover
the conflict after it ships.
