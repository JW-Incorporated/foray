# Foray generation and storage — requirements

**Status:** authoritative reference for the pipeline **as built** on branch
`generation-run-2026-09-09`, read out of the code on 2026-09-09 and **refreshed the
same day against the tip after PRs #551–#555** (F-49, F-50, F-51, F-59, F-60, and
WS-H's text-level tier 2 for F-06 — plus the three wiring defects the first pass of
this document found, F-52/F-53/F-54). Every prompt below was re-read from source
for that refresh.
**Audience:** founders and agents. It assumes no knowledge of the codebase.
**Relationship to the other documents:**

| Document | What it is | Authority |
|---|---|---|
| `docs/curation/generation-architecture.md` | The design prompt. Its own header says "design prompt. Nothing described here is built." | Design intent only. Where it and the code disagree, **the code is what runs** and this document says so explicitly. |
| `docs/curation/narration-craft.md` | The narration craft doctrine — six modes, budgets, seam rules, the ratio. | Source of the numbers the code mirrors (`MODE_CHAR_BANDS`, 17 chars/s). |
| `docs/curation/generation-run-2026-09-09.md` | The findings table (F-01…F-62) and interventions ledger from runs 1 and 2. | The evidence base. Finding ids cited throughout. |
| `docs/curation/generation-fix-plan-2026-09-09.md` | The workstream spec (WS-A…WS-F, plus WS-H) built against those findings. | What this branch implements. |
| **This document** | What the code on this branch actually does, stage by stage, prompt by prompt. | The single reference. Every claim cites `path:function`. |

Nothing here is invented. Where behaviour is absent, this document says
**"not implemented"** or **"design only, see generation-architecture.md §N"**.

---

## 1. Purpose and scope

### 1.1 What a Foray is

A Foray is a **listening session, 15 minutes to ~3 hours, assembled as an ordered
list of pointers** — not an audio file. Two kinds of thing occupy the listener's
clock:

- **Tape** — real podcast audio, played by seeking into the publisher's own
  original enclosure between an in-point and an out-point. 4a never downloads,
  re-encodes, concatenates or re-hosts a publisher's bytes.
- **Narration** — 4a's own words, carried as a **script** the device speaks with
  its own voice engine (or, for an admin-authored Foray, a pre-rendered `asset`).

A third item type, **jingle**, is a fixed 1.5-second 4a sonic mark
(`player/foray-queue.js:JINGLE_DURATION_SEC`, mirrored at
`backend/src/generation/runPipeline.ts:JINGLE_DURATION_SEC`).

### 1.2 The anchoring constraint

This is the constraint that governs every design decision below, and it is not a
technical preference. ADR-0007, restated in `generation-architecture.md` §1.1:

> *"Playback remains seek-and-stop against the publisher's original enclosure. No
> derived audio artefact is produced at any point."*

Consequences the code enforces:

- A tape pointer is **numbers plus quoted anchor text** and nothing else —
  `backend/src/types/tapeSourcing.ts:TapePointerSchema` (`segmentId`, `itemId`,
  `startSec`, `endSec`, `startAnchor`, `endAnchor`, `tier`, `confidence`).
- The anchors exist so boundaries can be **re-derived** if the publisher's audio
  shifts; a raw timestamp alone is never sufficient.
- No module under `backend/src/generation/` opens an HTTP connection to fetch
  audio. This is checked structurally, not promised: `sourceBeats.noFetch.test.ts`
  greps the module sources for fetch/http/download call sites
  (`backend/src/generation/sourceBeats.ts` module doc comment).
- Exactly **two** modules under `backend/src/generation/` may write to disk, and
  both write public text about the world rather than a user's words:
  `backend/src/generation/evidenceCache.ts` (retrieved passages, keyed by a claim
  hash) and — new with WS-H — `backend/src/generation/transcriptTextIndex.ts`
  (an inverted index over podcast cue text, keyed by `show_id`).
  `backend/test/promptNoPersistence.test.ts` names both as the only permitted
  exceptions (`PERSISTENCE_EXEMPT`), scans every other file in the directory for a
  persistence primitive, and holds each exemption to §9.4 with its own test — the
  index test asserts that the claim a search ran for never appears in the cache
  file.

### 1.3 What this document governs

- Every data file and directory the generation pipeline reads or writes (§2).
- Every stage of `backend/src/generation/runPipeline.ts:runForayPipeline` — its
  model tier and id, its `max_tokens`, its **exact prompt text**, its response
  schema, the mechanical validation applied to the reply, its retries,
  parallelism, checkpointing and failure modes (§3).
- The budget guard, checkpoint/resume, the shared JSON parser, usage tracking,
  stage timing, the stub builders and `--dry-run` (§4).
- The two quality gates (`tools/foray/check-forays.mjs`,
  `tools/foray/check-narration.mjs`), the spine structural gate, the veracity
  metrics and the publish gate (§5).
- The candidate JSON, the partial candidate, `report.json`, the checkpoint file,
  the evidence cache and the publish path into `data/forays.json` (§6).
- The CLI commands, flags and environment variables (§7).
- What is still open (§8).

### 1.4 What this document does not govern

- **The player.** How `player/foray-queue.js` and `app.js` turn a published Foray
  into audio is out of scope except where the checker mirrors it (§5.1).
- **Segment extraction as a standing pipeline.** `docs/curation/segment-extraction-pipeline.md`
  owns how a transcript becomes a committed segment. The generation pipeline
  *mints* a tier-2 segment in memory, carries it on the candidate, and — only at
  publish time, in the same PR as the Foray — `publishForay.ts` appends it to
  `data/segments.json` and its episode row to `data/segment-sources.json`, flagged
  `source: "generation-tier-2"` and `needs_review: true` (§3.6.6, §3.10, §6.5).
  No generation-stage module writes either file.
- **Transcript acquisition.** `docs/adr/0004-transcript-acquisition-ladder.md` and
  `docs/curation/transcription-scale-plan.md` own it.
- **TTS.** Whether on-device speech survives a locked screen is
  `generation-architecture.md` §9.1, open, and blocks nothing in this pipeline.
- **Progressive playback in the app.** The pipeline emits a partial candidate
  (§3.11); nothing serves it over HTTP (§8.8).

---

## 2. Inputs and their storage

Three storage classes. **Committed** files live in `data/` and are in git.
**Machine-local** files live in `data-local/`, are gitignored, and exist only on
the machine that fetched them. **Generated output** lives in the `--out`
directory, default `data-local/foray-candidates/`.

### 2.1 Committed catalogue and pool files

Counts are what the files on this branch actually hold, measured 2026-09-09. Where
`generation-architecture.md` quotes a different number it is stale, and this
document uses the measured one.

| File | Shape | Count | Read by |
|---|---|---|---|
| `data/segments.json` | `{version, notes, built_at, provenance, segments[]}` | **212** segments over **64** episodes, **24** distinct `topic` values, confidence `high`/`medium` only; durations 50.3 s min / 124.5 s median / 259.9 s max | `segmentPoolLookup.ts:loadSegmentPool`, `runPipeline.ts:runtimeSecFor`, `veracityMetrics.ts:computeTapeRelevance`, `check-forays.mjs` |
| `data/segment-sources.json` | `{version, built_at, notes, provenance, sources[]}` | **64** source episodes | `taxonomyFamily.ts:loadShowByItemId`, `veracityMetrics.ts:loadSegmentSources`, `check-forays.mjs` |
| `data/catalog.json` | `{version, built_at, notes, shows[]}` | **220** shows | `catalogueLookup.ts:loadCatalogueData`, `taxonomyFamily.ts:loadShowNodes` |
| `data/discover.json` | `{version, built_at, items[]}` | **2,050** items (the architecture doc's "1,855" is stale) | `catalogueLookup.ts:loadCatalogueData`, `gatherEvidence.ts:titlesForItem` |
| `data/item-tags.json` | `{version, built_at, tags: {itemId: string[]}}` | **2,077** keys | `catalogueLookup.ts:queryTapeAvailability` |
| `data/semantic-index.json` | `{version, built_at, concepts: {key: {terms, topics, related}}, modifiers}` | **120** concepts; **361** multi-word terms attached to at least one topic | `catalogueLookup.ts:matchConceptsInText`, `resolveTopic.ts:loadConceptTermWeights` |
| `data/taxonomy.json` | `{version, notes, nodes[], episode_attributes}` | **194** nodes, **1** of which carries a `terms` list (`engineering/energy-fusion`) | `resolveTopic.ts:loadTaxonomyNodes`, `taxonomyFamily.ts:buildLineages`, `check-forays.mjs` |
| `data/forays.json` | `{version, built_at, notes, forays[]}` | **4** Forays, none `generated` | `finalizeForay.ts:loadCandidateFiles`, `publishForay.ts`, the app at runtime |
| `data/transcript-digests.json` | `{version, generated_at, policy, selection, summary, transcripts[]}` | **587** entries (curated shows) | `transcriptArchiveLookup.ts:loadTranscriptArchive` |
| `data/breadth-transcript-digests.json` | same shape | **1,131** entries (breadth shows) | same |
| `data/breadth-classification.json` | `{entries: {collectionId: {topics[]}}}`, ~17 MB | lazily loaded, **only** for a numeric (Apple collection) show id | `taxonomyFamily.ts:loadBreadthNodes` |
| `data/transcript-availability.json` | `{version, generated_at, policy, summary, shows[]}` | **220** shows | `audioSourceLookup.ts:loadShowAudioMeta` |
| `data/breadth-transcript-yield.json` | same `shows[]` shape | **3,000** shows | same |
| `data/dai-classification.json` | `{built_at, shows: {appleCollectionId: {dai}}}` | **220** entries | same — the resolved DAI verdict, which wins over the two sweep files |

**Digest totals.** 587 + 1,131 = **1,718** entries; `loadTranscriptArchive` keeps
the **1,708** with `cues > 0` and `span_implausible !== true`, across **15**
distinct `show_id`s.

#### 2.1.1 Field-level shapes and key identifiers

**`data/segments.json` `segments[]`** — one anchored slice of one episode:

```
id                      "causality-engineered-network--47-hyatt-regency-kansas-city#1964"
item_id                 the episode it was cut from  (joins segment-sources.sources[].id)
topic                   a data/taxonomy.json node id ("engineering/disasters")
start_sec, end_sec      the in- and out-points, seconds
reference_duration_sec  the episode length the anchors were authored against
start_anchor, end_anchor  verbatim quoted text at each boundary
why                     the curator's one-line note (copy rules cap it at 18 words)
confidence              "high" | "medium" | "low"
transcript_source, dai_suspected, source, batch_id, needs_review   (optional)
```

Typed at `backend/src/generation/segmentPoolLookup.ts:SegmentRecord`.

A row **this pipeline** mints for a tier-2 anchor
(`finalizeForay.ts:mintedSegmentRow`) fills the same field names, carries the
Foray's resolved `topic` (the lineage the topic gate admitted the episode on),
sets `source: "generation-tier-2"` and `needs_review: true`, and deliberately
carries **no `why`** — that field is a curator's own note and nothing machine-made
belongs in it (§3.10).

**`data/segment-sources.json` `sources[]`** — how an episode is played:

```
id            the item id (the join key; matches segments[].item_id)
show          the show TITLE (joins data/catalog.json shows[].title)
title         the episode title
feed_url, episode_guid
audio_url     https, no tokens (both checked by check-forays.mjs)
audio_type, audio_bytes
duration_sec  must agree with any segment's reference_duration_sec to within 2 s
dai_suspected boolean, required — a true value makes every segment of that
              episode a hard failure (out-points cannot be anchored on a
              dynamically-stitched feed)
ad_free_ratio, audio_verified_on
```

**`data/catalog.json` `shows[]`** — `show_id`, `title`, `apple_collection_id`,
`feed_url`, `artwork_url`, `apple_genre`, `episode_count`, `editorial_note`,
**`taxonomy_node_ids[]`**, `archetype_fit`, `cadence_hint`, `explicit`, `source`.
`taxonomy_node_ids` is the topic gate's right-hand side (§3.6.5).

**`data/discover.json` `items[]`** — `id`, `show` (title), `title`,
`apple_collection_id`, `apple_track_id`, `apple_episode_url`, `release_date`,
`duration_min`, `artwork_url`, **`topics[]`**, **`hook`**, `audio_url`,
`audio_type`, `audio_bytes`, `duration_sec`, `dai_suspected`. Used only for the
§4.2 tape-availability *signal* and for episode titles.

**`data/semantic-index.json` `concepts`** — `{conceptKey: {terms[], topics[],
related[]}}`. `terms` are matched against the intent text; `topics` are taxonomy
node ids; `related` supplies breadth (§3.2.2).

**`data/taxonomy.json` `nodes[]`** — `id` (`"engineering/disasters"`), `parent`
(`"engineering"` or `null`), `label`, an **optional `terms[]`** (distinctive
vocabulary the node advertises, added with F-59 — see §3.4), plus `apple_anchor`,
`weight`, `confidence`, `last_evidence_at` which generation ignores. Two levels.
`terms` is optional in `backend/src/types/taxonomy.ts:TaxonomyNodeSchema`, and
exactly one node carries one today: `engineering/energy-fusion`, whose eleven
terms are `fusion`, `fusion-energy`, `tokamak`, `stellarator`, `plasma`,
`plasma-physics`, `reactor`, `iter`, `inertial-confinement`,
`magnetic-confinement`, `ignition`.

**`data/transcript-digests.json` / `data/breadth-transcript-digests.json`
`transcripts[]`** — metadata only, never transcript text:

```
show_id, show_title, guid, title
transcript_url, transcript_type, enclosure_url, bytes, sha256
cues                 number of cues in the body (must be > 0 to be usable)
first_cue_sec, last_cue_sec, span_implausible
feed_duration_sec, speakers, warnings
```

Typed at `backend/src/generation/transcriptArchiveLookup.ts:TranscriptDigestEntry`
(`show_id`, `show_title`, `guid`, `title`, `cues`, `feed_duration_sec`,
`span_implausible`, and — since a tier-2 segment has to be playable —
**`enclosure_url`**, optional, because a digest row without one is a row this
pipeline may not mint tape from rather than a parse error; see §3.6.6's
audio-source lookup).

**`data/forays.json` `forays[]`** — the published record; see §6.5 for the exact
shape the pipeline writes.

#### 2.1.2 How they join

```
spine beat claim
   │  token overlap (tier 1)
   ▼
data/segments.json  segments[].id  ─────────────► forays.json items[].segment_id
        │ item_id
        ▼
data/segment-sources.json sources[].id ──► .show (a TITLE)
                                              │
                                              ▼
                              data/catalog.json shows[].title ──► taxonomy_node_ids[]
                                                                        │
data/taxonomy.json nodes[] (id/parent lineage) ◄────────────────────────┘
        ▲
        └── forays.json foray.topic, resolved by resolveTopic.ts

transcript digests (show_id, guid, title)
   │  deriveItemId(entry) = `${show_id}--${slug(title)}`   (tier 2 item id)
   │  (show_id, guid) ────► data-local/transcripts/normalized/<show_id>-<hash>/<guid-slug>-<hash>.json
   ▼
minted segment id = `${itemId}#${Math.round(startSec)}`  (collision → `-2`, `-3`, …)
```

Two joins are documented as **lossy, measured against a live checkout**
(`veracityMetrics.ts:computeTapeRelevance` doc comment):

- **0 of 212** pooled segments' `item_id`s resolve against `data/discover.json`
  item ids. `discover.json` is *not* the item registry for the pool.
- **44 of 64** `segment-sources.json` show titles have a matching
  `catalog.json` `shows[].title`. The 20 that do not are the smaller shows
  (*Origin Stories*, *The Grill Coach*, *Rewilding Earth Podcast*).

This is why the topic gate unions two signals rather than trusting either
(`sourceBeats.ts:nodesForSegment`).

**Ownership.** All of `data/` is committed and founder-owned; it changes by PR.
The generation pipeline **never writes to `data/`** — the only writer is
`backend/src/cli/publishForay.ts`, only to `data/forays.json` and (when the run
minted tier-2 tape) `data/segments.json` and `data/segment-sources.json`, all in
one commit, and only through a branch + PR (§6.5).

### 2.2 Machine-local files (`data-local/`, gitignored)

| Path | Shape | Present on this machine | Owner |
|---|---|---|---|
| `data-local/transcripts/normalized/<show_id>-<hash>/<guid-slug>-<hash>.json` | `{show_id, guid, source_url, cues: [{start_sec, end_sec, text, speaker}], warnings[]}` | **1,713** files across **15** show directories | `tools/segments/` fetch/normalise step |
| `data-local/transcripts/raw/…` | the fetched SRT/VTT before normalisation | 1,713 files | same |
| `data-local/transcripts/index/<show_id>.json` | `{version, showId, builtAt, docs: [{guid, length, mtimeMs, size}], postings: {term: [[docIndex, tf]]}}` | **1** file (`practical-ai.json`, 613 KB) — one per show tier 2 has searched | `transcriptTextIndex.ts:FileTranscriptTextIndex` |
| `data-local/evidence/<claim-hash>.json` | `{cachedAt, docs: EvidenceDoc[]}` | **empty** (no keyed run yet) | `evidenceCache.ts` |
| `data-local/corpus/corpus.db` | SQLite: `sources`, `documents`, `chunks`, `chunks_fts` (FTS5), `chunk_embeddings`, `embedding_models` | **558** chunks over 54 markdown documents | the corpus tooling |
| `data-local/corpus/{markdown,raw,hostgate}/` | fetched reference documents + per-host fetch policy | 54 markdown | same |
| `data-local/foray-candidates/` | the pipeline's own output (§6) | empty | `generateForays.ts` |

**`corpus.db` is still not read by the generation pipeline at all.** Nothing
under `backend/src/generation/` opens it. F-06 named it as the obvious fix for
title-only episode matching; WS-H solved that problem a different way, with its
own BM25 index over the normalised **episode transcripts** in
`data-local/transcripts/normalized/` (§3.6.6), because `corpus.db` holds reference
documents rather than podcast cue text. `corpus.db` remains unused.

**The transcript archive is the binding constraint and it is machine-local.** A
checkout without `data-local/transcripts/` gets
`transcriptArchiveLookup.ts:NullTranscriptCueProvider` **and**
`transcriptTextIndex.ts:NullTranscriptTextIndex` behaviour — every episode returns
`null` cues, the text search returns no candidates and reports `enabled: false`,
tier 2 falls back to the title path and can never anchor, and the only tape
available is the 212-row committed pool. The generation machine is therefore not
interchangeable with a CI runner (§7.5).

### 2.3 The request

`backend/src/types/generation.ts:GenerationRequestSchema`:

```
{
  prompt:     string   (trimmed, non-empty)
  duration:   "short" | "medium" | "long"
  author_id:  string   (trimmed, non-empty; a founder in phase 1)
  visibility: "catalogue"   (literal — the only accepted value)
}
```

The batch driver builds this per prompt from the prompts file plus
`--duration`/`--author` (`generateForays.ts:generateOneCandidate`).

**The prompt is never persisted.** `understandPrompt.ts` is a pure function that
takes the string, calls two collaborators and returns; it writes to no sink. The
guarantee is enforced by `backend/test/promptNoPersistence.test.ts`, which scans
`backend/src/generation/` for persistence primitives and permits exactly one file
(`evidenceCache.ts`). This implements `generation-architecture.md` §9.4 ("Each
prompt is discarded"). What *is* retained is the resulting Foray's title, summary
and topic (§6.5).

### 2.4 Duration budgets

`backend/src/types/spine.ts:DURATION_SHAPE_BUDGETS`, taken verbatim from
`generation-architecture.md` §3:

| Tier | Acts | Slots | Beats | Target runtime (design) |
|---|---|---|---|---|
| `short` | 1–1 | 2–3 | 8–10 | ~15 min |
| `medium` | 3–4 | 5–7 | 28–36 | ~60 min |
| `long` | 5–7 | 12–18 | 80–110 | up to ~180 min |

`SHAPE_TOLERANCE = 0.15` is applied as slack **outside** the band, not instead of
it: a count `n` passes when `n >= min * 0.85 && n <= max * 1.15`
(`spine.ts:withinTolerance`, `spineStructure.ts:withinTolerance`).

`EXPLORATION_FLOOR = 0.3` — at least `ceil(beats * 0.3)` beats must carry
`exploration: true` (`spine.ts:validateSpine`).

**The runtime target itself is never checked.** `DURATION_SHAPE_BUDGETS` bounds
*counts*, not seconds. Nothing in the pipeline compares the finished
`runtime_sec` against ~15/~60/~180 minutes, and `check-forays.mjs` only checks
that `runtime_sec` matches the items' own sum. The ±15 % *runtime* tolerance in
`generation-architecture.md` §8 is **not implemented** (§8.11).

---

## 3. The pipeline, stage by stage

### 3.0 Orchestration overview

One function drives everything:
`backend/src/generation/runPipeline.ts:runForayPipeline(request, options, deps)`.
It is a **batch chain** — every stage completes before the next begins. §6's
progressive generation is not built; the function returns one finished candidate
(`runPipeline.ts` module doc comment, "WHAT IT DELIBERATELY DOES NOT DO").

Stage order, with the checkpoint key each is persisted under:

| # | Stage | Checkpoint key | Model tier | Model calls |
|---|---|---|---|---|
| 1 | Safety, then clarity, then intent | `understand` | haiku | 1–2 |
| 2 | Research shape (catalogue + external) | `research-shape` | haiku | 0–8 |
| 3 | Build spine | `spine` | opus | 1 |
| — | Resolve topic | *(not checkpointed)* | none — deterministic | 0 |
| 4 | Deepen acts, in parallel | `deepen:0`, `deepen:1`, … | sonnet, 1 per act | acts (×2 on retry) |
| 5 | Source beats | `source` | none — deterministic | 0 |
| 6 | Gather evidence | *(runs inside stage 7)* | haiku, 1–2 per uncached beat | beats |
| 7 | Write narration, one act at a time | `narrate:0`, `narrate:1`, … plus a per-slot `narrate:0:0`, `narrate:0:1`, … | sonnet | ≤ 3 per slot per attempt |
| 8 | Stitch + cross-act continuity | `stitch` | sonnet, 1 per act boundary | acts − 1 |
| 9 | Finalize (validate) | *(not checkpointed)* | none | 0 |

Every dependency is injectable (`runPipeline.ts:RunPipelineDeps`): the seven
builders, the transcript **cue provider**, the tier-2 **text index**
(`textIndex`, WS-H), the **audio-source resolver** (`audioSourceFor`, defaulting
to the real `createDigestAudioSourceResolver`), the `finalize` function, the
`onActReady` callback and the checkpoint store. The defaults are the `create*()`
factories, each of which returns a **Stub** when `ANTHROPIC_API_KEY` is absent and
an **Anthropic-backed** builder when it is present. One code path serves both
(§4.6). `cueProvider` and `textIndex` both default to honest-nothing
implementations, so a caller that supplies neither gets exactly the pre-WS-H
behaviour rather than a guess.

After sourcing, `runPipeline` prints one line per slot — `summarizeSourcing`'s
tape/narration split and the single most common reason its narrated beats found
no tape (§3.6.9). Run 2 finished with zero tape beats and the operator's first
evidence of it was an all-narration candidate half an hour later.

Three seams wrap the stages:

- **`runPipeline.ts:timed(name, fn)`** — records wall time into `StageTimingLog`,
  and on a throw walks the `cause` chain for a budget error, re-throwing it as
  `BudgetStopError` naming the stage (§4.1).
- **`runPipeline.ts:stage(name, parse, fn)`** — `timed`, plus
  resume-from-checkpoint and persist-on-completion, with the stage's own zod
  schema re-validating anything read back off disk (§4.2).
- `resetUsageTracking()` is called once at the top and `getUsageTotals()` once at
  the end, bracketing exactly one run's token usage (§4.4).

Outcomes (`runPipeline.ts:RunPipelineOutcome`) — exactly one of:

| Outcome | When | Carries |
|---|---|---|
| `rejected` | safety refused the prompt | `category`, `explanation`, `timings` |
| `needs-clarification` | the prompt is genuinely ambiguous | `question`, `readings`, `timings` |
| `unresolved-topic` | no taxonomy node could be resolved | `title`, ranked `candidates`, `timings` |
| `generated` | a Foray was built, whether or not it validates | `input` (the candidate), `result` (validation), `spine`, `tapeRelevance`, `timings`, `ttlA1Ms` |

---

### 3.1 Stage 1 — Understand: safety, then clarity, then intent

**Module:** `backend/src/generation/understandPrompt.ts:understandPrompt`
**Collaborator:** `PromptUnderstander` — `AnthropicPromptUnderstander` or
`StubPromptUnderstander`, selected by `createPromptUnderstander()`
**Purpose:** refuse what must be refused, ask at most one clarifying question, and
turn a freeform prompt into four structured fields.
**Inputs:** `request.prompt`; `ctx = {userId, sessionId?}`.
**Order is enforced:** safety is synchronous and free and runs before either model
call, so nothing is spent understanding a prompt that will be refused.

#### 3.1.1 Safety check — no model call

`backend/src/generation/safetyCheck.ts:checkSafety` is pure, synchronous and
dependency-free. Three rules, each requiring **two** signals to co-occur (a
subject-matter term AND an intent/action term), so that "Roman siege weapons" and
"the history of the Manhattan Project" both pass:

| Category | subject pattern | intent pattern |
|---|---|---|
| `sexual-content-minors` | child, children, kid, kids, minor, minors, toddler, toddlers, underage, preteen, pre-teen | sex, sexual, sexualiz*, nude, naked, porn*, erotic, explicit |
| `mass-casualty-weapons` | bomb, explosive device, nerve agent, bioweapon, biological weapon, chemical weapon, nuclear device, dirty bomb, sarin, vx gas, anthrax, improvised explosive | "how to / how do i / how can i / how would i", "instructions for", "recipe for", "steps to", synthesise/synthesize, "build a", "make a", "construct a", "assemble a" |
| `targeted-harassment` | "my " + ex, neighbor, neighbour, coworker, co-worker, boss, classmate, roommate, room-mate, landlord, manager, teacher, professor | dox, doxx, expose, humiliate, harass, stalk, ruin, blackmail, "out them", "get back at" |

All patterns are word-bounded, case-insensitive regexes; the exact source is
`safetyCheck.ts:RULES`. A rejection returns
`{allowed: false, category, explanation}` with the explanation text written
verbatim in that file, and the run ends. There is **no retry loop**.

The bias is deliberate and stated in the module: phase 1 is founder-only, so a
false negative is caught by the founder reviewing the PR (§4.9), while a false
positive costs a confusing rejection with no recourse.

#### 3.1.2 Clarity call

**Model tier:** `haiku` → `claude-haiku-4-5-20251001`
(`backend/src/config/models.ts:DEFAULT_MODEL_IDS`)
**`max_tokens`:** 400
**Operation name (for the budget guard):** `prompt_clarity`
**Budget estimate:** `ceil(promptText.length / 4) × $1/MTok + 200 × $5/MTok`

Exact prompt (`AnthropicPromptUnderstander.ts:buildClarityPrompt`, lines joined
with `\n`; `{{prompt}}` is the user's raw prompt, and the surrounding double
quotes are part of the template):

```text
A user has asked for an AI-generated audio documentary (a "Foray") on this prompt:

"{{prompt}}"

Decide if this prompt is GENUINELY ambiguous — meaning it names something with two or
more substantially different plausible subjects (e.g. "Mercury" could mean the planet,
the element, or the Roman god). Do NOT flag a prompt as ambiguous just because it is broad
or could be narrowed — "Roman siege weapons" is NOT ambiguous even though it covers many
devices, because there is one clear subject. The bar is high: only flag it when a wrong
guess would produce a genuinely different Foray.

If ambiguous, give exactly 2-3 concrete readings (do not include an "or something else"
option in `readings` — that is appended separately) and a single one-sentence question
offering those readings.

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"ambiguous": boolean, "readings": string[], "question": string|null}
```

Response schema (`AnthropicPromptUnderstander.ts:ClaritySchema`):

```ts
z.object({
  ambiguous: z.boolean(),
  readings: z.array(z.string()).max(3),
  question: z.string().nullable()
})
```

**Mechanical validation applied to the reply:** the schema, and nothing else.
`ambiguous: true` ends the run with outcome `needs-clarification`; a `null`
question falls back to `"Could you say more about what you mean — or something
else?"` (`understandPrompt.ts`).

**Retries:** none at the stage level. The shared parser's single metered re-ask
applies (§4.3).

#### 3.1.3 Intent call

**Model tier:** `haiku`. **`max_tokens`:** 600. **Operation:** `prompt_intent`.
**Budget estimate:** `ceil(len/4) × in + 400 × out`.

Exact prompt (`AnthropicPromptUnderstander.ts:buildIntentPrompt`):

```text
A user asked for an AI-generated audio documentary (a "Foray") on this prompt:

"{{prompt}}"

Produce a structured understanding of the request with exactly these four fields:
- subject: the concrete subject of the Foray
- angle: the specific angle or thesis worth taking, not just the topic
- priorKnowledge: what the listener probably already knows about this
- disappointment: what would make this Foray a disappointment to the listener — this is
  the most important field; be concrete, not generic

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string}
```

Response schema (`AnthropicPromptUnderstander.ts:IntentSchema`); the
pipeline-level `types/generation.ts:IntentUnderstandingSchema` additionally trims
each field and requires it non-empty:

```ts
z.object({
  subject: z.string(),
  angle: z.string(),
  priorKnowledge: z.string(),
  disappointment: z.string()
})
```

#### 3.1.4 Checkpointing, parallelism, failure

- **Checkpoint key:** `understand`. The stored value is the whole
  `UnderstandPromptResult` union, re-validated on resume by
  `runPipeline.ts:UnderstandCheckpointSchema`.
- **Parallelism:** none — two serial calls at most.
- **`rejected`** and **`needs-clarification`** are terminal. The run returns, and
  `generateForays.ts` **deletes the checkpoint and the partial file** for both,
  because re-running the same prompt reproduces the same answer.
- Any throw (transport, schema-after-re-ask, budget) propagates. The batch driver
  records `outcome: "error"` for that prompt, keeps the checkpoint, and continues
  with the next prompt.

**Stub behaviour** (`StubPromptUnderstander.ts`): `ambiguous = words.length <= 2`
(so a bare "Mercury" is ambiguous and "Roman siege weapons" is not); the intent is
a deterministic fixture seeded by a sha1 of the subject.

---

### 3.2 Stage 2 — Research to establish shape

**Module:** `backend/src/generation/researchShape.ts:buildResearchShape`
**Collaborators:** `catalogueLookup.ts` (free, deterministic, no model call) and
`ExternalResearcher` (`AnthropicExternalResearcher` / `StubExternalResearcher`)
**Purpose:** produce a *map* — candidate sub-topics, a tape-availability signal
per candidate, known controversies. Not a spine.
**Inputs:** the `IntentUnderstanding`; `options.root`; `options.topic`, which
`runPipeline` deliberately omits so this stage resolves its own filter topic.

#### 3.2.1 The F-11 topic filter

`researchShape.ts:resolveFilterTopic` calls `resolveTopic.ts:resolveTopic` on
`"{subject} {angle}"`. A miss returns `null`, which **disables** the filter rather
than emptying the map; a missing `data/taxonomy.json` is caught and also yields
`null`. Passing `topic: null` explicitly is distinct from omitting it, and means
"do not filter".

#### 3.2.2 Candidate seeds — deterministic, no model call

`researchShape.ts:buildCandidateSeeds`:

1. `catalogueLookup.ts:matchConceptsInText("{subject} {angle}", concepts, {topic})`
   returns concept keys, best first. Per-term scoring
   (`catalogueLookup.ts:scoreTerm`):
   - a multi-word hyphenated term matching an adjacent run of query words → **2**
   - an exact whole-token or whole-word match → **2**
   - a stem match in either direction, both strings ≥ `MIN_STEM_TERM_LENGTH = 4` → **1**
   - an arbitrary interior substring → **0**

   Then the **off-branch drop**: when a topic is known and a concept scored no
   exact hits at all, it is dropped unless one of its `topics` shares a taxonomy
   family with the Foray's topic (`catalogueLookup.ts:sharesTopicFamily` — the
   same node, or one a path-prefix ancestor of the other; **not** "same root
   segment").

   *This is F-11's fix, and the finding's own diagnosis was wrong.* F-11 blamed
   shared tokens (`engineering`). The actual mechanism: the `ai` concept's first
   term is the two-letter string `ai`, the prompt contained "chains", and the old
   matcher accepted any interior substring — `ch-ai-ns` matched, and the 761-item
   *Practical AI* corpus was attached to a bridge-collapse Foray. The word-boundary
   rule alone removes it. A root-segment filter would have **kept** the leak
   (`engineering/ai-robotics` shares the `engineering` root with
   `engineering/disasters`) while deleting `bridges`, `disasters`,
   `infrastructure` and `decision-making` — the four most on-topic concepts run 1
   matched, all under other roots.

2. Zero concept matches → a single `literal-term` seed built from the subject
   itself, tokenised by `tokenizeForCatalogueQuery`. §4.2's guardrail: a genuinely
   untaped subject must still produce a real candidate, not an empty map.

3. Otherwise take the top `MAX_SUBTOPICS = 8` concepts, then add up to
   `MAX_RELATED_CONCEPTS = 3` of the best-matched concept's `related` entries for
   breadth, never exceeding 8 seeds total.

#### 3.2.3 Tape availability — a signal, never a filter

`catalogueLookup.ts:queryTapeAvailability` counts `data/discover.json` items whose
`title + hook + topics + item-tags` contain any of the seed's terms as a
case-insensitive **substring** (substring, not whole word, because catalogue terms
are frequently compound). `researchShape.ts:tapeSignalFor` bands the count:

| itemCount | signal |
|---|---|
| 0 | `none` |
| 1–4 | `thin` |
| 5–19 | `moderate` |
| ≥ 20 | `strong` |

Nothing removes a candidate for having a `none` signal — that is structural, not a
convention (`researchShape.ts` module doc comment).

#### 3.2.4 External research — only for a catalogue gap

`researchShape.ts:fanOutExternalResearch` runs **only** over seeds whose signal is
`none`, in parallel via `Promise.all`, at most 8 calls.

**This is F-12.** In run 1 every seed reported strong or moderate tape (because of
F-11's inflated matches), so the web-search stage never fired and the Foray was
shaped entirely from what the archive's titles suggested. The gating rule is
unchanged on this branch; the F-11 fix is what makes a genuine gap detectable at
all.

**Model tier:** `haiku`. **`max_tokens`:** 800.
**Tools:** the server-side `web_search_20250305` tool, `max_uses: 3`
(`MAX_SEARCHES_PER_TOPIC`). **Operation:** `external_research`.
**Budget estimate:** `ceil(len/4) × in + 500 × out + 3 × USD_PER_WEB_SEARCH`,
where `USD_PER_WEB_SEARCH = 0.01` and lives in `config/models.ts` beside the token
rates.

Exact prompt (`AnthropicExternalResearcher.ts:buildResearchPrompt`):

```text
Research this candidate sub-topic for an audio documentary: "{{topic}}".

Use web search only as much as needed to answer these two questions:
1. What are the genuine controversies or contested points about this sub-topic, if any?
2. What is generally known about it that a researcher without web access could not have guessed?

Do not write a script or narration — this is research to establish SHAPE, not content.
Be concise. If there is nothing genuinely contested, say so plainly rather than inventing controversy.

After your research, respond with ONLY a single JSON object as your FINAL message, no markdown
fences, no other text, matching exactly: {"notes": string, "controversies": string[]}
```

Response schema (`AnthropicExternalResearcher.ts:ResearchSchema`):

```ts
z.object({ notes: z.string(), controversies: z.array(z.string()) })
```

Parsed with `parseLastJsonBlock` rather than `parseWithRetry` (§4.3), because a
tool-using reply wraps its final JSON in prose. The re-ask, if it fires, is sent
**without** the web_search tool and therefore carries no per-search cost.

**F-05 stands, unchanged:** the cheapest tier in the pipeline, with an 800-token
output ceiling, is what decides a topic's "genuine controversies".

#### 3.2.5 Output

`backend/src/types/research.ts:ResearchShapeSchema`:

```ts
z.object({
  subject: z.string(),
  angle: z.string(),
  generatedAt: z.string(),
  subtopics: z.array(SubtopicCandidateSchema).min(1),
  nonObviousAngle: z.string().nullable(),   // carried through from intent.angle
  externalGapsResearched: z.array(z.string())
})

// SubtopicCandidateSchema
z.object({
  label: z.string().min(1),
  source: z.enum(["semantic-concept", "literal-term"]),
  tape: z.object({
    signal: z.enum(["none", "thin", "moderate", "strong"]),
    itemCount: z.number().int().min(0),
    showCount: z.number().int().min(0),
    exampleItemIds: z.array(z.string())     // up to 5, for a human spot-check
  }),
  controversies: z.array(z.string()),
  externalNotes: z.string().nullable(),
  externallyResearched: z.boolean()
})
```

**Checkpoint key:** `research-shape`, re-validated by `ResearchShapeSchema` on
resume. **Parallelism:** the external fan-out only (§5's "1, may fan out for
lookups"). **Failure:** any throw fails the stage and the Foray; there is no
partial research shape.

**Stub behaviour:** `StubExternalResearcher.research` returns a fixed note naming
dry-run mode and an **empty** `controversies` array, so a keyless run's spine
prompt carries no controversies at all.

---

### 3.3 Stage 3 — Build the spine

**Module:** `backend/src/generation/buildSpine.ts:buildSpine`
**Collaborator:** `SpineBuilder` — `AnthropicSpineBuilder` / `StubSpineBuilder`
**Purpose:** the one document that fixes acts, slots, beats, the exploration
budget and the **voice**, before any per-act work begins. §5's topology table
calls this "1, always" and "the one stage where parallelism is actively
destructive".
**Inputs:** the `IntentUnderstanding`, the `ResearchShape`, the duration tier.

**Model tier:** `opus` → `claude-opus-5` (`config/models.ts`)
**`max_tokens`:** 8000 (`AnthropicSpineBuilder.ts:MAX_OUTPUT_TOKENS`)
**Operation:** `spine_build`
**Budget estimate:** `ceil(len/4) × $5/MTok + 8000 × $25/MTok` ≈ $0.20 + prompt

Called **exactly once per Foray** — never per act, never per beat.

#### 3.3.1 The prompt

`AnthropicSpineBuilder.ts:buildSpinePrompt`. `{{subtopicLines}}` is one line per
research-map subtopic, formatted by the same function as:

```text
- {{label}} ({{source}}, tape: {{signal}}, {{itemCount}} items[; controversies: {{c1}}; {{c2}}][; external research: {{externalNotes}}])
```

where the `controversies` clause appears only when the list is non-empty and the
`external research` clause only when `externallyResearched && externalNotes`.
`{{source}}` is `semantic-concept` or `literal-term`; `{{signal}}` is
`none`/`thin`/`moderate`/`strong`.

The full prompt, verbatim (lines joined with `\n`; the "Duration tier" line and
the final JSON-contract line are each a single line built by string
concatenation):

```text
Build the SPINE for an audio documentary ("Foray") on: "{{subject}}".
Angle: {{angle}}
What the listener probably already knows: {{priorKnowledge}}
This Foray disappoints if: {{disappointment}}

Research map (candidate subtopics found so far):
{{subtopicLines}}

Duration tier: {{duration}}. Target exactly, within a small tolerance: {{minActs}}-{{maxActs}} acts, {{minSlots}}-{{maxSlots}} slots total, {{minBeats}}-{{maxBeats}} beats total.

For EACH act, give: title, thesis, startState (what the listener believes entering), endState
(what they believe leaving), and slots (each with a title and an ordered list of beats).

Every beat MUST be a CLAIM, not a topic. Example: "Charcoal briquettes were a Ford Motor
Company waste-disposal scheme" is a beat; "Briquettes" is not.

Mark at least 30% of ALL beats (across the whole spine) with exploration: true — beats that go
somewhere the prompt didn't literally ask for but a curious listener would want. Do not just
sprinkle a token few; hit the floor for real.

Decide the VOICE once for the whole spine (style, register, sentenceRhythm, narratorPresence) —
it applies to every act; do not vary it per act.

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"voice": {"style": string, "register": string, "sentenceRhythm": string, "narratorPresence": string}, "acts": [{"title": string, "thesis": string, "startState": string, "endState": string, "slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean}]}]}]}
```

The min/max numbers are read from `DURATION_SHAPE_BUDGETS[duration]` (§2.4), so a
`medium` request says "3-4 acts, 5-7 slots total, 28-36 beats total".

#### 3.3.2 Response schema

`AnthropicSpineBuilder.ts:RawSpineSchema`:

```ts
z.object({
  voice: z.object({
    style: z.string(), register: z.string(),
    sentenceRhythm: z.string(), narratorPresence: z.string()
  }),
  acts: z.array(z.object({
    title: z.string(), thesis: z.string(),
    startState: z.string(), endState: z.string(),
    slots: z.array(z.object({
      title: z.string(),
      beats: z.array(z.object({ claim: z.string(), exploration: z.boolean() }))
    }))
  }))
})
```

The builder then adds `subject`, `angle`, `duration` and `generatedAt` and returns
a `Spine`. `buildSpine.ts` re-parses that against
`backend/src/types/spine.ts:SpineSchema`, which is `.strict()` throughout — so a
per-act `voice` field cannot even parse. **Voice is spine-level, structurally.**

#### 3.3.3 Mechanical validation — two gates, both fatal

**Gate 1: `types/spine.ts:validateSpine`.** Issue codes and rules:

| Code | Rule |
|---|---|
| `act-count-out-of-budget` | acts outside `[min×0.85, max×1.15]` |
| `slot-count-out-of-budget` | slots outside the same-tolerance band |
| `item-count-out-of-budget` | beats outside the same-tolerance band |
| `beat-not-claim-shaped` | any beat failing `isClaimShaped` |
| `exploration-floor-not-met` | fewer than `ceil(beats × 0.3)` beats with `exploration: true` |

`isClaimShaped` is a **lexical heuristic, deliberately biased toward accepting**,
and the file says why at length: a false rejection throws out the whole paid Opus
call, a false acceptance lets one topic-shaped beat through. It requires ≥ 3 words
and then looks for verb-shaped evidence anywhere past the first word — a
closed-class auxiliary/modal/copula, a listed common irregular past, an
invariant-form verb, regular `-ed`, `-s`/`-es` agreement (gated by a small
plural-noun exception list), `-ing` directly after a be-auxiliary, a narrow
bare-form fallback (`Researchers study…`), or a clause-adjunct word
(`throughout`, `because`, `during`, …) in a sentence of ≥ 5 words. The doc's own
non-claim, "Briquettes", fails.

A failure throws `buildSpine.ts:InvalidSpineError` carrying the whole
`SpineValidationResult`.

**Gate 2: `backend/src/generation/spineStructure.ts:assertSpineStructure`** — the
confirmation loop **F-13** found missing. It runs between §4.3 and §4.4 because
that is the last point at which a bad spine costs one Opus call rather than three
deepen calls plus sourcing plus 31 narration pages. It checks the relationships a
per-beat schema cannot see:

| Code | Rule | Motivating finding |
|---|---|---|
| `act-count-out-of-budget` / `slot-count-out-of-budget` / `beat-count-out-of-budget` | restated from the same budgets and the same `SHAPE_TOLERANCE`, so the two gates cannot disagree | F-13 |
| `duplicate-beat-claim` | the same claim (normalised: lowercased, non-alphanumerics collapsed) appears in two places; the message names both | F-13 |
| `beat-claim-too-long` | more than `MAX_BEAT_CLAIM_WORDS = 60` words — a check for a **paragraph pasted into a beat**, not a style rule | F-41, F-46 |
| `beat-claim-not-single-sentence` | `countSentences(claim) > 1` | F-41 |
| `act-missing-start-state` / `act-missing-end-state` | an act with an empty `startState`/`endState`, which §4.4's deepening and §4.8's continuity both read | F-13 |

`countSentences` counts `.`/`!`/`?` followed by whitespace and a capital or digit,
excusing a full stop after a known abbreviation (`mr`, `no`, `vs`, `inc`, `ca`, …)
and after a single letter (`U.S. Steel`, `W. E. B.`). Every defect is collected in
one pass so a re-ask could fix them all at once; a failure throws
`InvalidSpineStructureError`.

Run 1's real spine — 3 acts, 6 slots, 31 beats — is the fixture that must keep
passing (fix plan WS-F.4).

#### 3.3.4 Checkpointing, parallelism, failure

- **Checkpoint key:** `spine`, re-validated by `SpineSchema` on resume.
- **Parallelism:** none, by design.
- **Retries:** none at this stage. Either gate failing **fails the Foray** — the
  spine is not re-asked automatically. The batch driver records `outcome: "error"`
  and keeps the checkpoint (which holds `understand` and `research-shape`, so a
  re-run pays only for the spine onward).

**Stub behaviour** (`StubSpineBuilder.ts`): builds a spine at the exact midpoint
of the tier's act/slot/beat bands, distributes slots and beats evenly, marks
`ceil(beats × 0.35)` beats as exploration (comfortably over the 0.3 floor) spread
across the range, and composes each claim from a template plus a **qualifier**
list of 40 entries so no two beats in a 110-beat long-tier spine collide — a fix
made after F-13's structural gate correctly began rejecting the stub's previously
duplicated claims.

---

### 3.4 Topic resolution — deterministic, keyless, between the spine and deepening

**Module:** `backend/src/generation/resolveTopic.ts:resolveTopic`
**Called from:** `runPipeline.ts`, immediately after the spine.

**Why here.** It used to run after narration, beside the other §4.9 fields.
§4.5's topic gate needs it (fix plan WS-C.3, finding F-29): the taxonomy node is
the only thing that can tell sourcing that a barbecue episode is not tape for an
engineering-disasters Foray, and sourcing runs long before finalize. Resolving it
here also means an unresolvable topic stops the run **before** the two most
expensive stages.

**Input text:** `[intent.subject, intent.angle, every act title].join(" ")`.
**Title:** `` `${subject}${angle ? ": " + angle : ""}`.slice(0, 120) ``.

**What F-59 changed, and why counting shared tokens was not enough.** Run 2's
topic text — *"the end-to-end engineering pipeline of building and operating
machine learning systems in production…"* — resolved to
**`engineering/energy-fusion`**, and §3.6.5's lineage gate then refused every
AI-adjacent show in the archive as off-topic (every slot's trace read
`tier2:lineage`). Nothing about fusion appears anywhere in that prompt. The node
won on exactly two words: `engineering`, which all seven nodes under that root get
free from their own ids, and `systems`, from the label *"Fusion & energy systems"*
— the only label in the tree containing it, so the rarity rule scored it as the
most distinctive word there is. Meanwhile `engineering/ai-robotics`, the right
answer, could match **nothing**: the shared tokenizer drops two-letter words, so
`ai` is not even a token, and "Ai Robotics" advertises no vocabulary a
production-ML prompt uses. The same magnet appears in show classification (#547).

**Scoring** (`resolveTopic.ts:scoreTopics`) now separates two kinds of evidence,
and only the second can resolve a topic. Tokenise the query with
`tokenizeForCatalogueQuery`; for each of the 194 nodes, tokenise `id` (path
separators and hyphens split into words) plus `label`, then:

| Signal | Weight | Constant |
|---|---|---|
| an **advertised term** the query contains | `TERM_MATCH_WEIGHT = 2`, divided for a concept phrase by how many topics its concept names | `TERM_MATCH_WEIGHT` |
| a shared **distinctive** id/label token | 1 | — |
| a shared **generic** token | `GENERIC_TOKEN_WEIGHT = 0.25` | `GENERIC_TOKEN_MAX_NODES`, `GENERIC_LABEL_WORDS` |
| the node has a parent (a child beats its own root) | **+0.5**, a tie-breaker between matches only | — |

Ties are broken by id, so the order is stable and pinnable in a test. A node with
no shared token **and** no matched term is not a candidate at all.

**A token is generic** when it is carried by more than
`GENERIC_TOKEN_MAX_NODES = 3` nodes (`engineering`, `history`, `music`), **or**
when it is one of `GENERIC_LABEL_WORDS` — words that name a *form* rather than a
subject: `system`, `systems`, `general`, `misc`, `other`, `topics`, `studies`,
`modern`, `world`. That second list exists because the node-count rule cannot
catch them: "systems" appears in exactly one label and would otherwise score as
the rarest word in the tree. It is kept short and evidence-led on purpose — a word
that names a real subject for some node (`technology`, `management`, `design`,
`history`, `science`, `energy`) is deliberately **not** on it, because listing it
would stop that node ever resolving; the suite asserts that.

**Advertised terms** come from two places, merged
(`nodeTermWeights` ∪ `loadConceptTermWeights`, `mergeTermWeights` keeping the
higher weight per term):

- **`terms` on the node itself** in `data/taxonomy.json` — curated against the
  node, so no restriction on length. One node has one today (§2.1.1).
- **The multi-word phrases `data/semantic-index.json` already maps to a node.**
  "machine learning" has pointed at `engineering/ai-robotics` all along (the `ai`
  concept); the resolver was the one matcher in the pipeline not reading that file.
  **Multi-word only**: a concept's single words are corpus vocabulary, not
  node-distinguishing vocabulary — the concepts pointing at
  `engineering/precision-mfg` list "production", "systems" and "engineering", and a
  prototype using them replaced one magnet with a worse one (precision-mfg
  outscored everything on run 2's text *and* pulled run 1's disasters prompt to
  `architecture/infrastructure`). **A phrase hit is divided by its concept's topic
  count**: "machine-learning" is listed by `ai` (1 topic) and by `machine-learning`
  (2 topics), and a term that names one node is decisive where the same term spread
  over three is a hint.

Term matching (`queryHasTerm`) is the **strict** subset of `catalogueLookup`'s
rule — an exact token, or an adjacent word run for a hyphenated term, **no
stems**. A wrong concept in the research map is one line in a prompt; a wrong node
here is every sourcing decision in the run.

**The bar** (`resolveTopic`), in order:
- the best candidate matched **any advertised term** → resolved. It was written
  against that node and nothing else.
- otherwise, if its `distinctiveTokens` is **empty** → `resolved: null`. Generic
  words accumulate score for ranking and can never resolve, however many there are
  — this is exactly what stops "engineering … systems" reaching the fusion node.
- otherwise `MIN_TOKEN_OVERLAP = 2` **matched** tokens (generic ones count toward
  this second bar, once a distinctive one exists) → resolved.
- otherwise the **rare-token escape hatch**: a single *distinctive* token resolves
  it if that token appears in at most `RARE_TOKEN_MAX_NODES = 2` nodes ("fusion",
  "bbq" are decisive; "history" is not).
- otherwise `resolved: null`, and the run ends with outcome `unresolved-topic`.

**Diagnostics.** `TopicCandidate` carries `matchedTokens`, `distinctiveTokens` and
`matchedTerms` beside `score`, and the **top-5 shortlist is returned on the
resolved path as well as the unresolved one** — F-59 needed an offline replay to
diagnose precisely because a resolved topic reported nothing about why it resolved.

Pinned regressions: run 2's text resolves to `engineering/ai-robotics` on the
phrase with `distinctiveTokens: []`; `engineering/energy-fusion` still *matches*
that text on `["engineering", "systems"]` and cannot resolve on them, and is not
even on the shortlist; run 1's engineering-disasters prompt still resolves to
`engineering/disasters`; a genuinely fusion prompt still resolves via `terms`;
"the history of grilling" → `food/grilling-bbq` and "roman concrete…" → `null`.

**It fails rather than guesses**, and the module says why: `check-forays.mjs` only
asks whether the node *exists*, never whether it is the *right* one, so a
wrong-but-valid topic would never be caught downstream.

**`options.topic`** (the CLI's per-prompt `topic` field) overrides resolution
entirely — a human has already ruled.

**The Foray id** is minted here too (`resolveTopic.ts:forayIdFor`):
`slug(title).slice(0,48)` + `-` + first 6 hex of `sha1(title + "\n" + startedAt)`.
Two runs on the same subject therefore produce two different ids, which is correct
— they are two different Forays. The id is seeded from `startedAt` (read from the
injected clock at this point), **not** `generatedAt`, so the partial candidate and
the finished candidate are the same Foray (`runPipeline.ts`, "WHICH TIMESTAMP THE
PARTIAL CANDIDATE CARRIES").

---

### 3.5 Stage 4 — Deepen each act

**Module:** `backend/src/generation/deepenActs.ts:deepenActs`
**Collaborator:** `DeepenActBuilder` — `AnthropicDeepenActBuilder` / `StubDeepenActBuilder`
**Purpose:** refine one act's slots and beats, tag each beat `account` or
`argument`, and write the act's own introduction and exit.
**Inputs:** the frozen spine, one target act, its index.

**Model tier:** `sonnet` → `claude-sonnet-5`. **`max_tokens`:** 4000.
**Operation:** `deepen_act`.
**Budget estimate:** `ceil(len/4) × $2/MTok + 4000 × $10/MTok` ≈ $0.048 per act.

**Parallelism: one call per act, all at once** (`Promise.all` in `deepenActs`).
This is §5's "the natural parallel boundary", and run 1 confirmed it fires
(finding P-01: the three deepen calls arrived within the same second).

**Every call receives the FULL spine**, not just its own act. This is
load-bearing: "the full-spine context is what stops act 3 from re-explaining what
act 1 established."

#### 3.5.1 The prompt

`AnthropicDeepenActBuilder.ts:buildDeepenActPrompt`.

`{{otherActsSummary}}` is one line per act:

```text
Act {{n}} (THIS IS THE ACT YOU ARE DEEPENING — full detail below): "{{title}}"
Act {{n}}: "{{title}}" — thesis: {{thesis}} — start: {{startState}} — end: {{endState}}
```

(the first form for the target act, the second for every other act).

`{{targetSlotLines}}` is, per slot:

```text
  Slot {{n}}: "{{slotTitle}}"
    - {{claim}}
    - {{claim}} [exploration]
```

(`[exploration]` appended only when `beat.exploration` is true).

The full prompt, verbatim:

```text
You are deepening ONE act of a full spine for an audio documentary ("Foray") on: "{{subject}}".
Angle: {{angle}}
Voice (decided once for the whole spine — do not vary it): style: {{style}}; register: {{register}}; sentence rhythm: {{sentenceRhythm}}; narrator presence: {{narratorPresence}}

FULL SPINE (all acts, for context — you own only the target act):
{{otherActsSummary}}

TARGET ACT (Act {{n}} of {{N}}): "{{targetActTitle}}"
Thesis: {{thesis}}
Start state: {{startState}}
End state: {{endState}}
Slots and beats to refine:
{{targetSlotLines}}

Your job:
1. Refine this act's slots and sharpen its beats — make the claims more specific/concrete where they
   are still high-level. Do NOT add or remove slots. You may refine beat wording but every beat must
   remain a CLAIM, never a topic (e.g. "Charcoal briquettes were a Ford Motor Company waste-disposal
   scheme" is a beat; "Briquettes" is not).
2. Tag every beat `kind`. "account" is the DEFAULT and covers most beats: an event, a practice, a
   measurement, or a mechanism someone could be heard describing — a person explaining how a thing
   is done is an account, not an argument. Use "argument" ONLY for a claim about what something
   MEANS or what someone SHOULD do, which no recording of an event, a person or a practice could
   carry. Arguments are narrated, never illustrated with tape, so a beat wrongly tagged "argument"
   silently loses its tape; at most a third of any one slot's beats may be arguments.
3. Write this act's own INTRODUCTION — what a listener hears entering this act. Use the full spine so
   act {{n}} does not re-explain what an earlier act already established.
4. Write this act's EXIT — the connective tissue into the next act (its own half of the handoff; a
   later continuity pass reconciles the full cross-act seam, this is just this act's side of it).

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"title": string, "thesis": string, "startState": string, "endState": string, "slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean, "kind": "account" | "argument"}]}], "introduction": string, "exit": string}
```

Instruction 2 is **WS-C.1**, closing **F-38**: run 1 ran the same token scorer
over a thesis ("every link in a failure chain gets evaluated against a local
question and almost never against the global one") and anchored it to a *Geology
Bites* episode on banded iron formations.

**Instruction 2's narrowing is F-49's fix.** Told only that an argument is a
"thesis or generalisation", the deepen stage tagged **29 of run 2's 35 beats**
`argument`, §3.6.3 skipped the tape search for all 29, and the pipeline produced
an all-narration Foray on the subject this archive is richest in. On an
angle-driven spine ("the unglamorous reality of production ML is engineering
discipline, not research") every beat reads as evidence for the thesis. So the
line is now drawn at what a *recording* can carry, `account` is stated as the
default, and — because the prompt is exactly what drifted — the ratio is also
bounded in code (§3.5.3a).

#### 3.5.2 Response schema

`AnthropicDeepenActBuilder.ts:RawDeepenedActSchema`:

```ts
z.object({
  title: z.string(), thesis: z.string(),
  startState: z.string(), endState: z.string(),
  slots: z.array(z.object({
    title: z.string(),
    beats: z.array(z.object({
      claim: z.string(),
      exploration: z.boolean(),
      kind: z.enum(["account", "argument"]).optional()    // optional on purpose
    }))
  })),
  introduction: z.string(),
  exit: z.string()
})
```

`kind` is **optional and defaulted downstream**: a model that omits it must not
cost the whole act a retry, and an absent kind means `account`, which is the
search-for-tape behaviour that predates the field
(`types/spine.ts:BeatKindSchema`, `gatherEvidence.ts:beatKindOf`).

Re-parsed at the stage level against `types/spine.ts:DeepenedActSchema`
(`ActSchema` extended with non-empty `introduction` and `exit`, an optional
**`warnings: string[]`** — see §3.5.3a — and `.strict()`).

#### 3.5.3 Mechanical validation

`types/spine.ts:validateDeepenedAct(original, deepened)`:

| Code | Rule |
|---|---|
| `slot-count-changed` | deepening added or removed a slot — §4.4 refines, it does not restructure |
| `beat-not-claim-shaped` | a refined beat fails `isClaimShaped` |
| `introduction-missing` | empty introduction |
| `exit-missing` | empty exit |

A failure throws `InvalidDeepenedActError`.

#### 3.5.3a The argument cap — a structural rule, not a prompt line (F-49)

`deepenActs.ts:capArgumentBeats`, applied **after** validation, on the way out of
`deepenOneActWithRetry`: it is this stage's own rule about the act it returns, not
a schema property of what the builder said.

- **The cap:** `argumentCapFor(beatCount) = max(1, ceil(beatCount × MAX_ARGUMENT_SHARE_PER_SLOT))`
  with `MAX_ARGUMENT_SHARE_PER_SLOT = 1/3`. A 3-beat slot may hold 1 argument, a
  6-beat slot 2, a 1-beat slot 1 (a cap of zero would stop a single-beat slot
  holding an argument at all, which is a different rule than the one asked for).
- **Which beats are re-tagged:** the ones over the cap, appearing **last in the
  slot, in slot order**. Ranking beats by how argument-shaped they look would have
  this module re-judge the model's judgement with a worse instrument, and the
  ranking would be a second silent heuristic; slot order is deterministic,
  explicable in one sentence, and a slot states its thesis at the top.
- **Re-tagging is the safe direction.** `account` only means "§3.6 may look for
  tape for this"; the search still has to clear every threshold and gate, so a
  re-tagged beat with no real tape simply becomes narration — which it was going to
  be anyway. The reverse mistake is the one that costs tape silently.
- **What it records:** a line per corrected slot pushed onto the act's own
  `warnings` array — *"Slot "X": 5 of 6 beats came back tagged "argument"; at most
  2 may be (one third of the slot, rounded up). The last 3 were re-tagged
  "account", so §4.5 looks for tape for them."* A field rather than a
  `console.warn`, because a field is checkpointed with the act, survives a resume,
  and can be asserted in a test. Run 2's only symptom was the absence of tape four
  stages later.
- **Unchanged acts are unchanged.** With nothing over the cap the function returns
  the **same object**, so an act that needed no correction is byte-identical to
  what the builder returned and carries no `warnings` key.
- **Idempotent, and applied to a resumed act too** — an act checkpointed before
  this rule existed (run 2's own checkpoint, 29 arguments in 35 beats) is corrected
  on resume rather than faithfully replaying the defect the resume exists to avoid
  re-paying for.
- **The stub goes through the same function**, not a second copy of it: a dry run
  that could hand back a slot of six arguments would let a regression in the cap
  pass every keyless test.

Replayed over run 2's real deepen output
(`backend/test/fixtures/run2-deepen-2026-09-09.json`, lifted verbatim from that
run's checkpoint): **29 arguments → 12**, every slot at or under its cap, six
warnings.

#### 3.5.4 Retries, checkpointing, failure

- **Retries:** exactly one, per act (`deepenActs.ts:deepenOneActWithRetry` loops
  twice). The retry is **uninformed** — the identical prompt is re-sent; nothing
  is appended about why the first attempt failed.
- **Checkpoint keys:** `deepen:0`, `deepen:1`, … — one per act, saved the moment
  that act is built and validated, **before `Promise.all` settles**. That is the
  F-17 case: an act that succeeded is banked even when a sibling act exhausts its
  retry budget and fails the stage.
- Note the stage as a whole runs under `timed("deepen", …)`, **not** under
  `stage(…)`, so there is no `deepen` key — only the per-act ones.
- **Failure:** a second failure for any act throws `ActDeepeningError`, which
  fails the whole Foray. A deepened act is not optional content. `ActDeepeningError`
  carries the original on `cause`, which is why `findBudgetError` walks the chain
  (§4.1).

**Stub behaviour** (`StubDeepenActBuilder.ts`): appends a fixed sharpening clause
to each claim, derives `kind` from a generalisation-marker regex (`every`,
`always`, `never`, `almost`, `tends`, `generally`, `typically`, `in general`,
`means that`, `is why`) — defaulting to `account` for everything else, for the
same reason the real prompt does — so the dry-run path exercises §4.5's argument
branch, composes deterministic introduction/exit strings, and returns the act
through `capArgumentBeats` (§3.5.3a).

---

### 3.6 Stage 5 — Source each beat: tape or narration

**Module:** `backend/src/generation/sourceBeats.ts:sourceBeats`
**Purpose:** decide, per beat, whether real tape carries it (and resolve the
pointer) or whether it becomes narration.
**Inputs:** the deepened acts; the segment pool; the transcript archive; a
`TranscriptCueProvider`; a `TranscriptTextIndex` (§3.6.6a); an
`AudioSourceResolver` (§3.6.6c); the resolved `topic`. Every one of the last four
is **inert when omitted** — the Null cue provider returns no cues, the Null text
index returns no candidates, an absent resolver leaves tier 2 exactly as it was
before a minted segment had to be playable, and an absent topic makes the gate
inert. A caller that supplies none behaves exactly as this module did before those
seams existed, which is what keeps CI and every pre-existing test on one path.

**No model call happens in this stage at all.** It is a deterministic
tokenize-and-score matcher against fixed thresholds — the task brief's own
preference ("prefer a deterministic scorer with a confidence threshold over
calling out to the LLM"). There is no builder quad and no budget-guard call site,
because neither would have anything to guard.

**The guardrail this stage cannot break:** the beat list going in must equal the
beat list coming out — same count, same claims, same order. Only the per-beat
sourcing decision may differ. Checked by
`types/tapeSourcing.ts:validateSourcing`, and a violation throws.

#### 3.6.1 Foray-wide ledgers

`sourceBeats.ts:sourceBeats` keeps four, all Foray-wide rather than per-slot,
because the rules they serve span the whole running order:

| Ledger | Rule it serves |
|---|---|
| `usedSegmentIds` | a segment may not play twice (`check-forays.mjs`: "appears twice in one Foray") |
| `lastStartByItem` | segments from one episode must play in ascending time order (**M3**) |
| `usedCountByItem` + `placedTapeCount` | no one episode over 25 % of the Foray (**M4**) |
| `mintedIds` | tier-2 segment id collision resolution |

**Both tiers consult and update them** (F-70). Tier 2 mints a segment rather than
picking one out of the pool, and until F-70 it consulted none of these: run 2
attempt 4b put two windows of one *Practical AI* episode in one slot, backwards,
and the Foray failed **M3** and **M4** at once. The two rules now live in
`m4ShareAllows` / `m3OrderAllows` and every placement goes through `placeTape`, so
there is one statement of each rule and one place the ledgers move. A tier-2
refusal falls through to the next candidate episode exactly as tier 1's does, and
names the same gate (`m4-share`, `m3-order`) in the trace.

`m4SegmentCapFor(placed) = max(1, floor(placed × M4_ITEM_SHARE_MAX))` with
`M4_ITEM_SHARE_MAX = 0.25`, asked at placement time against the count this
placement would make it. The denominator is the tape **placed so far**, not the
beat count: M4 is a share of the finished Foray's *segments*, and run 2 attempt 4b
sourced 5 tape segments from 24 beats, so the old `floor(totalBeats × 0.25)` cap
read 6 where the number that mattered was 1 — a cap that cannot bind. Asking at
placement time is safe because `floor(placed × 0.25)` never decreases as the Foray
grows, so an admission stays admissible; the readable form of the rule is that an
episode's **second** segment needs a Foray of at least 8 tape segments and its
third needs 12. `max(1, …)` is every episode's exemption for its first segment:
a 3-segment Foray fails M4's count clause whichever episodes it drew on, and the
answer to that is more tape, not less. Sourcing bounds the *count* share only, not
the runtime share (one long segment among four short ones is over 25 % of runtime
with no episode repeated, and refusing an episode's only segment for being long
would cost tape without moving anyone else's share); the checker remains the
authority on both.

#### 3.6.2 Tokenisation

`catalogueLookup.ts:tokenizeForSourcing` = `tokenize` (lowercase, split on
non-alphanumerics, drop tokens ≤ 2 chars and a 27-word stopword list) **minus** a
further ~150-word `SOURCING_STOPWORDS` list of function words. That second list is
**F-29's fix**: run 1 matched a Kansas City walkway claim to a British
hearth-cooking segment on `have`, `one`, `people`, `would` — four "shared tokens",
zero shared meaning. It is kept separate from `tokenizeForCatalogueQuery` so a
human-typed catalogue query ("how to…") keeps its old behaviour.

#### 3.6.3 Argument beats skip tape entirely

```
if (beat.kind === "argument") → narration, reason:
  "This beat is an argument, not an account — §4.5 does not look for tape for a
   claim no recording can be about."
```

No transcription-queue candidate is logged either: nothing to transcribe would
ever help (**F-38**).

#### 3.6.4 Tier 1 — the committed segment pool

`segmentPoolLookup.ts:findTier1Match`. For every segment in the 212-row pool:

- **Haystack:** the segment's own **transcript window** — the words actually
  spoken between `start_sec` and `end_sec`, supplied by
  `sourceBeats.ts:makeSegmentWindowText` (which joins `segments[].item_id` to a
  digest entry via `deriveItemId` and asks the cue provider) — falling back to
  `topic + why + start_anchor + end_anchor` metadata only when no transcript body
  is available. **This is F-06/F-29's fix**: matching a claim against an 18-word
  curator note was never going to separate "this tape is about this event" from
  "this tape is about engineering".
- **Score:** count of the claim's distinct content tokens present in the haystack.
- **Bar** (`segmentPoolLookup.ts:requiredOverlapFor`): metadata haystack →
  `TIER1_MATCH_THRESHOLD = 3` (raised from 2 mid-run-1 as intervention I-16 after
  **F-33**); transcript haystack → `max(3, ceil(claimTokenCount × TIER1_WINDOW_COVERAGE))`
  with `TIER1_WINDOW_COVERAGE = 0.25`. A two-minute window holds 200–400 words, so
  three of a claim's words turning up in it is close to free; the window's bar is
  therefore **coverage of the claim** (a quarter of what the claim says must be
  said in the window), not a flat count.
- **The ranked walk applies the caller's veto inside the search**, skipping any
  candidate that is below its own bar, already used, over the M4 cap, would break
  M3, or fails the topic gate — and continuing to the next candidate rather than
  stopping. **F-29(c)** was the opposite behaviour: falling through to the
  next-best stranger. When nothing usable clears the bar the answer is a genuine
  `null` and the beat degrades to narration.

A hit produces a `TapePointer` with `tier: 1` and the segment's own `confidence`.

#### 3.6.5 The topic gate

`backend/src/generation/taxonomyFamily.ts:familyGateAllows(forayTopic, candidateNodes, root)`.

- **Family means LINEAGE, not the first path segment.** A node's family is itself,
  its ancestors and its descendants in `data/taxonomy.json`. For
  `engineering/disasters` that is `{engineering/disasters, engineering}`: tape
  classified under the node, and tape classified only under its parent, both
  count; a sibling trade like `engineering/precision-mfg` does not. The relation is
  symmetric, so a broadly-classified show reaches a narrow Foray and vice versa.
- **A candidate's nodes** are a union, and deliberately the *same* union WS-B's
  metric computes, so the gate and the metric that scores the gate cannot disagree
  about one anchor:
  - tier 1 (`sourceBeats.ts:nodesForSegment`): the segment's own `topic` ∪
    `taxonomyNodesForItemId(item_id)` (→ `segment-sources.json` show title →
    `catalog.json` `taxonomy_node_ids`).
  - tier 2 (`sourceBeats.ts:nodesForArchiveEntry`): `taxonomyNodesForShowId(show_id)`
    ∪ `taxonomyNodesForItemId(deriveItemId(entry))`. A numeric (Apple collection)
    show id additionally consults `data/breadth-classification.json`, loaded lazily
    because it is 17 MB.
- **Asymmetric failure modes, deliberately:** the gate is **inert** when the Foray
  has no resolved topic (a direct `sourceBeats` call, a test), and **fails closed**
  when the candidate's nodes are unknown. "I could not tell" is not evidence that
  the tape is on topic.
- The reporting twin, `taxonomyFamily.ts:isOnTopic`, returns `boolean | null` —
  `null` meaning nothing could be established, which WS-B excludes from both
  numerator and denominator.

#### 3.6.6 Tier 2 — the transcript archive

**WS-H changed the candidate search, and only that.** Until this branch the only
way to reach an episode's tape was for its **title** to share three content words
with the claim, so run 2's 23 searching beats never got past the title bar —
*Practical AI*, 63 of 63 transcript bodies present on the generation machine, best
title scoring **one** against a claim about ImageNet's label errors. Every gate
that decides whether tape is *about* a claim was working and was never reached.
Lowering `TIER2_MATCH_THRESHOLD` re-admits run 1's Chernobyl-for-Hyatt class
(pinned by tests), because a title is not evidence about a claim in the first
place. So the search now runs over the transcripts' own words, and the title bar
survives as a **fallback candidate and a tie-breaker, never as a gate** — which is
the whole of **F-06**.

Tier 2 builds a candidate list (§3.6.6a), then walks it in order and takes the
**first candidate that passes every one of the following gates**, unchanged from
before WS-H. A beat still takes at most one tier-2 segment.

1. **Cue text must exist** — `cueProvider.getCues(entry)`. Gate `no-body`.
2. **Anchor location** (`transcriptArchiveLookup.ts:resolveAnchorFromCues`), gate
   `no-anchor`. The claim's content words (> 2 chars) are
   searched for as a **contiguous verbatim run** in the canonicalised token
   stream, longest window first: `MAX_ANCHOR_WORDS = 12` down to
   `MIN_ANCHOR_WORDS = 4`. Canonicalisation
   (`canonicalizeForAnchorMatch`) mirrors `tools/segments/merge-segments.mjs`'s
   `canonical()` exactly — NFKC, lowercase, apostrophes elided, every other
   non-alphanumeric collapsed to one space — so an anchor this module accepts is
   still verbatim to the real merge validator.
3. **The anchored-window check** (`anchoredWindowEvidence` +
   `anchoredWindowIsOnTopic`), gate `window-overlap`. *This is F-24(b)'s fix.* An anchor proves a phrase
   was spoken; it does not prove the tape there is about the claim (run 1's
   anchors were runs like "the original design required", which occur in almost
   any hour of talk). So the claim's content words must also turn up **around** the
   anchor: within `ANCHOR_WINDOW_PAD_SEC = 30` s either side of the matched
   phrase, **excluding the phrase's own words** — the anchor is not allowed to
   vouch for itself. Pass if `beyondAnchorOverlap >= TIER2_WINDOW_OVERLAP_MIN = 3`,
   **or** if the anchor phrase itself carries
   `>= TIER2_SELF_SUFFICIENT_ANCHOR_WORDS = 6` content words (a six-content-word
   verbatim run is a person saying the claim).

4. **The audio-source check** (§3.6.6c), gate `no-audio-source`. Tape nothing can
   play is not tape.

**The minted segment** (`cutSpanToCueBoundaries`) — *F-24(c)'s fix.* Run 1 minted
the anchor's own few seconds. Now the span is cut to **whole cues** (never opening
or closing mid-sentence), grown alternately either side until it reaches
`MIN_TAPE_SEGMENT_SEC = 45` or the transcript runs out, and capped at
`MAX_TAPE_SEGMENT_SEC = 240`. (For scale: the real pool's shortest segment is
50.3 s, its median 124.5 s, its longest 259.9 s.) The boundary anchors are the
first/last `ANCHOR_TEXT_WORDS = 8` words of the boundary cues, taken from the
token stream so a word-level transcript still yields an anchor of the required
length. A cut whose anchors fall below `MIN_ANCHOR_WORDS`, or with no duration, is
rejected and the search continues.

A tier-2 hit produces:
- a `TapePointer` with `tier: 2`, `confidence: "medium"`, whose `startSec`/`endSec`
  are the **cue boundaries** `cutSpanToCueBoundaries` chose, not the matched
  phrase's own few seconds;
- a `NewSegment` pushed onto `newSegments` with
  `id = "{itemId}#{round(startSec)}"` (suffixed `-2`, `-3`… on collision),
  `referenceDurationSec = entry.feed_duration_sec ?? span.endSec`; and
- a `MintedSegmentSource` put into `newSegmentSources`, keyed by item id so two
  beats taking two segments from one episode produce exactly one registry row
  (§3.6.6c).

**`newSegments` and `newSegmentSources` are now consumed.** `runPipeline` merges
the minted rows into the pool it measures `runtimeSecFor` against, carries both
arrays on the candidate as `segments`/`segmentSources`, `finalizeForay` merges them
into the files it hands the checkers, and `publishForay` writes them to
`data/segments.json` and `data/segment-sources.json` in the same commit as
`data/forays.json` (§3.10, §6.1, §6.5). Before this branch both arrays were
returned and dropped, which made any tier-2 anchor a publish-blocking failure —
see §8.2, now closed.

#### 3.6.6a The tier-2 candidate search — transcript text (WS-H)

**Module:** `backend/src/generation/transcriptTextIndex.ts`. **No model call.**

`sourceBeats.ts:tier2Candidates(claim, state, isUsable)` returns, best first:

1. the text index's top `TRANSCRIPT_TEXT_CANDIDATES = 8` episodes for the claim,
   with the caller's **lineage veto applied before anything is indexed or scored**,
   then
2. `findTranscriptArchiveMatch`'s title-metadata match, appended **last** if it is
   not already among them.

Keeping (2) means this change can only **add** candidates: a beat that found tape
by title before still finds it, and a checkout with no transcript bodies walks
exactly the title path it always did.

**The index itself** (`FileTranscriptTextIndex`):

- A read-only **inverted index over the normalised cue text**, tokenised with the
  same `tokenizeForSourcing` (and the same stopword lists) the two §3.6 scorers
  use, so "content word" means one thing in this pipeline.
- **BM25** with document-length normalisation, `k1 = 1.2`, `b = 0.75`. The length
  half is the one that matters here: episodes in this archive run from 12 minutes
  to three hours, and without it the longest episode wins every query. Neither
  constant is tuned against a labelled set and the module says so.
- **One corpus, not one per show.** Indexes are stored per show — that is what can
  be built and invalidated independently — but the `idf` a candidate is scored with
  is computed across every show the query touches, because two BM25 scores from two
  corpora are not comparable and tier 2 has to rank them against each other.
- **The demoted title bar is the tie-breaker.** `scored.sort` orders by BM25, then
  by `titleTokenScore(queryTokens, entry)` — the same function the tier-2 threshold
  uses, extracted so one rule has one implementation — then by `guid`, so the order
  is total and a replay is reproducible. The title cannot decide whether an episode
  is worth opening; between two episodes the text ranks equally it is a real, free
  signal.
- **Built lazily, per show, and only for shows the lineage gate admits.** In a real
  run that is one show of fifteen. Building costs one pass over that show's bodies,
  through the provider's own read.
- **Cached** at `data-local/transcripts/index/<show>.json`, keyed by **every body
  file's mtime + size** (not a count, not a build timestamp — a re-transcribed
  episode keeps its guid, and that is the change most likely to make an index
  quietly wrong). A cache whose `version !== TRANSCRIPT_TEXT_INDEX_VERSION = 1`, or
  whose stats disagree, is discarded and rebuilt. Written through a temp file and a
  rename; an unreadable, half-written or unwritable cache costs a rebuild and never
  fails a run.
- **It reads `data-local/` only through a provider.** The cue text and the file
  stats both come from a `TranscriptBodySource` — `TranscriptCueProvider` plus
  `bodyStat(entry)`, implemented by `FileTranscriptCueProvider` — never from a path
  this module opens itself.
- **`NullTranscriptTextIndex` is the default**: no candidates, `enabled: false`.
  That flag is load-bearing for the trace — a beat that failed a search which never
  happened must not be reported as one the text index had no candidate for.

`TranscriptTextCandidate` carries `entry`, `score` (BM25), `matchedTerms` (how many
distinct claim content words are spoken in the episode at all) and `rank`.

**What it is not:** a relevance verdict. It says which episodes are worth
*opening*; gates 1–4 above still decide whether the tape is about the claim.

#### 3.6.6b What WS-H measured, offline, on the real archive

Sourcing run keyless over run 2's own 35 deepened beats
(`backend/test/fixtures/run2-deepen-2026-09-09.json`), real digests, real bodies,
real `data/segments.json`:

| run | tape beats | where the search stopped |
|---|---|---|
| as run 2 ran (topic `engineering/energy-fusion`) | **0 of 35** | 29 `skipped:argument`, 6 `tier2:lineage` — the topic gate refuses *Practical AI* before anything else runs (**F-59**, §3.4) |
| topic corrected to `engineering/ai-robotics` | **0 of 35** | 29 `skipped:argument`, **6 `tier2:no-anchor`, all inside *Practical AI*** |
| corrected topic + the argument cap (§3.5.3a) | **0 of 35** | 12 `skipped:argument`, **23 `tier2:no-anchor`, all inside *Practical AI*** |

The gate moved from "no title matched" to "the tape itself does not say this",
which is what WS-H set out to do: the episodes reached are real bodies chosen by
text (`foundBy: "text-index"`, 8 candidates opened per beat, BM25 13–21), where the
same episodes scored `0` against a `requiredScore` of 3 on their titles.

**Tape yield is still 0 for that fixture, and that is a finding rather than a bug
in the search.** `resolveAnchorFromCues` needs a contiguous run of ≥ 4 of the
*claim's own* words spoken verbatim; across all 63 *Practical AI* bodies exactly
one of the 23 account claims has such a run anywhere, and the anchored-window test
correctly refuses it. **These claims are written prose, tape is speech** — the
verbatim-anchor rule is now the binding constraint (**F-61**, §8.3).

That the path works end to end is pinned by a case that quotes the show: a beat
claiming "aviation treats a crash as a regression test… food safety… medical
adverse event reporting" mints
`practical-ai--ai-incidents-audits-and-the-limits-of-benchmarks#316`,
**316.13 → 382.79 s (66.7 s)**, anchored `"and you see this in aviation a plane"` →
`"price before and after and theres an impact"`. The same beat with the index
removed gets no tape at all — F-06 stated as a test. Its one blemish is **F-62**
(§8.3): the cut grows symmetrically to reach `MIN_TAPE_SEGMENT_SEC`, and this
archive's ~28 s cues meant one leading cue is off-claim.

#### 3.6.6c The audio-source lookup — tape nothing can play is not tape

**Module:** `backend/src/generation/audioSourceLookup.ts`. Injected as
`SourceBeatsOptions.audioSourceFor`; `runPipeline` always supplies
`createDigestAudioSourceResolver`, and an omitted resolver leaves tier 2 exactly as
it behaved before one existed.

A minted segment is a pointer into an episode's audio, and `check-forays.mjs`
refuses a pool item id with no `data/segment-sources.json` row ("nothing can
resolve its audio"). So the row is minted here, from committed data only, or the
candidate episode is **passed over**.

`mintSegmentSource(entry, itemId, showMeta)` returns a
`MintedSegmentSource` — `{id, show, title, feed_url, episode_guid, audio_url,
audio_type, duration_sec, dai_suspected, source: "generation-tier-2"}` — built from
the digest's own `enclosure_url` and `feed_duration_sec`, the show title, and a DAI
verdict. `audio_type` comes from `enclosureMime(url)`, the URL path extension
(`m4a`/`mp4` → `audio/mp4`, `aac`, `ogg`/`opus`, `wav`, else `audio/mpeg`),
mirroring `prepare-segment-batch.mjs`.

**The DAI precedence is mirrored, not imported** (that file is ESM, this is a CJS
backend module): the per-show sweep verdicts in `data/transcript-availability.json`
and `data/breadth-transcript-yield.json` are the fallback, and
`data/dai-classification.json`'s resolved chain — joined by
`apple_collection_id` — wins where it exists.

**It refuses rather than invents.** Every one of these returns `null`, and the beat
gets narration with trace gate `no-audio-source`:

| Refusal | The rule it would otherwise break |
|---|---|
| no `enclosure_url` | nothing to play |
| a non-`https://` URL, or one whose query carries `token`/`auth`/`api_key`/`secret`/`password`/`session` | the registry's own two lexical checks (§5.1.1) |
| `feed_duration_sec` not `> 0` | the registry needs a positive `duration_sec`, and it is what a minted `reference_duration_sec` is compared against to 2 s |
| an empty show or episode title | both must be non-empty strings |
| no **boolean** DAI verdict for the show | defaulting `dai_suspected` to `false` is the exact value `merge-segments.mjs` and `check-forays.mjs` both exist to reject; ADR-0007 gates seek precision on it |

The per-show table is cached per process and bust by
`FORAY_SKIP_CATALOGUE_CACHE=1`, like every other catalogue read. `itemId` is
**passed in** rather than re-derived, because it must be the same id the minted
segment carries and two modules deriving it separately is how a slug rule drifts.

#### 3.6.7 Tier 3 and the fall-through

Anything that reaches here becomes narration and logs **one**
`TranscriptionQueueCandidate` naming the episode the search got **furthest** into
and what stopped it there — this pipeline's own log, never written into
`data/transcription-queue.json`, which has its own producer
(`tools/transcribe/build-transcription-queue.mjs`). `{found}` below is
`"Transcript text matched"` when the candidate came from the text index and
`"Transcript-archive metadata matched"` when it came from the title fallback:

| Situation | `reason` |
|---|---|
| audio could not be registered | "Transcript-archive tape was located in "…", but no data/segment-sources.json row can be written for it (no resolvable https audio URL, feed duration, or DAI verdict), so nothing could play it." |
| anchor found, window too thin | "{found} ("…") and a N-content-word anchor was located, but only M further claim content words are spoken within 30 s of it — below the 3 needed to call the tape there on topic." |
| body present, no verbatim run | "{found} ("…") but no run of 4 of the claim's own words is spoken verbatim anywhere in it, so no anchor could be located." |
| no cue text on this machine | "{found} ("…") but no cue text was available to locate a verbatim anchor." |
| nothing was worth opening at all | "No hit in data/segments.json or the transcript archive; logged for future transcription/extraction, not acted on here." |

The beat's own narration `reason` (carried into §3.8) is keyed to the same
furthest gate: `no-audio-source` → *"Tape was found for this beat but its
episode's audio cannot be resolved, so it cannot be played."*; `window-overlap` →
*"A transcript anchor was found but the tape around it is not about this claim."*;
everything else → *"No tape found anywhere in the §4.5 search order for this
beat."*

**`transcriptionQueueCandidates` is still dropped** — it is checkpointed and never
surfaced in the outcome or in `report.json`. What replaced it as the readable
account of a run is `sourcingTrace` (§3.6.9a), which *is* checkpointed and *is*
printed.

#### 3.6.8 The Patch/Carry decision

Resolved **per slot, after every beat in that slot has been resolved**, because
the mode depends on whether *any other* beat in the slot got tape:

- slot has other tape-sourced beats → **Patch** ("this beat patches what the
  slot's tape misses")
- slot has no tape at all → **Carry** ("this beat carries the content alone")

The `reason` string concatenates the resolution reason and the slot rationale, and
is carried on the beat for §4.7.

#### 3.6.9 Output, checkpointing, failure

`types/tapeSourcing.ts:SourceBeatsResult`:

```ts
{
  acts: SourcedAct[],                        // beats annotated with sourcing
  newSegments: NewSegment[],                 // tier-2 cuts — carried to finalize/publish
  newSegmentSources: MintedSegmentSource[],  // their episode registry rows, deduped by item id
  transcriptionQueueCandidates: [...],       // logged, still dropped downstream
  tapeRelevance: TapeRelevanceInput[],       // one row per TAPE beat, WS-B's input
  sourcingTrace: SourcingTrace[]             // one row per NARRATION beat (§3.6.9a)
}
```

`tapeRelevance` and `sourcingTrace` **partition the Foray's beats**: every beat
appears in exactly one of them.

Each `TapeRelevanceInput` row carries `actIndex`, `slotIndex`, `beatIndex`,
`claim`, `itemId`, `segmentId`, `tier`, `taxonomyNodeIds`, `families` (the nodes'
roots), `forayTopic`, `forayFamily`, and `onTopic: boolean | null`. §4.5 is the
only stage that knows all of it at once; run 1 had to count "5 of 22 anchors on
topic" by hand from the narration prompts.

- **Checkpoint key:** `source`, re-validated by `runPipeline.ts:SourceCheckpointSchema`.
  `sourcingTrace` and `newSegmentSources` are `.default([])` in that schema, so a
  checkpoint written before they existed still resumes — and resumes to the same
  Foray it would have produced.
- **Parallelism:** none needed — the whole stage is synchronous and in-memory.
- **Failure:** only the beat-preservation guardrail throws, and it is
  structurally unreachable. A beat with no tape is not a failure; it is narration.

#### 3.6.9a The sourcing trace, and the per-slot summary line (F-49)

Run 2 finished with zero tape beats out of 35, and the only evidence was one
sentence repeated six times — *"No tape found anywhere in the §4.5 search order"* —
while the research map for the same prompt reported *Ai: 761 items* as strong tape
and the machine held every *Practical AI* transcript. That sentence cannot
distinguish "the pool has nothing about AI" from "the best episode was two title
tokens short" from "the taxonomy gate refused it" from "the body is not on this
machine": four faults with four different fixes. Every threshold in this stage was
therefore tuned by argument rather than against data.

**`SourcingTrace`** (`types/tapeSourcing.ts`) is that data — one row per
narration-degraded beat: `actIndex`, `slotIndex`, `beatIndex`, `claim`, an
`outcome` of `skipped:argument` (both tiers `null`, no search ran) or `no-tape`,
and a row per tier.

**`Tier1TraceRow`** — `bestSegmentId`, `bestItemId`, `score`, `requiredScore` (the
bar *that* candidate had to clear, per `requiredOverlapFor`), `matchedIn`
(`transcript` | `metadata` | `null`), and `gate`:

| `Tier1Gate` | Meaning |
|---|---|
| `no-candidates` | no segment shares a single content word |
| `threshold` | the best candidate scored below its own bar |
| `topic-lineage` | it cleared the bar and is in another taxonomy family |
| `exhausted` | it cleared everything, but another beat of this Foray already played it |
| `m4-share` | its episode already holds its quarter of the Foray |
| `m3-order` | it sits earlier in an episode already joined later |

It is computed **before any ledger is updated for this beat**, or the vetoes it
reports would be the beat's own footprint.

**`Tier2TraceRow`** — `bestShowId`, `bestEpisodeTitle`, `score` (the title score),
`requiredScore` (`TIER2_MATCH_THRESHOLD`), `gate`, plus, once an anchor was
located, `anchorContentWords` and `beyondAnchorOverlap`; and, from WS-H,
`foundBy` (`"text-index"` | `"title"`), `textScore` (BM25, 3 dp), `textRank`,
`textMatchedTerms` and `candidatesConsidered`. Without those last five a row saying
`no-anchor` could not be told from one where no text search ran at all — the
confusion that let run 2's result look like an empty archive rather than a title
bar.

| `Tier2Gate` | Meaning |
|---|---|
| `text-index:no-candidate` | the text index ran and no lineage-admissible episode was worth opening — the search reached the transcripts' own words and they had nothing |
| `title-tokens` | **no** text search ran (no bodies on this machine) and no episode reached the title bar |
| `lineage` | the best-scoring episode's show is in another family |
| `no-body` | matched, but no transcript body is on this machine |
| `no-anchor` | the body is here, but no run of `MIN_ANCHOR_WORDS` claim words is spoken verbatim |
| `window-overlap` | an anchor was located, but the tape around it is not about the claim (F-24) |
| `no-audio-source` | everything matched, but no honest registry row can be written (§3.6.6c) |
| `m4-share` | the episode already supplies its quarter of this Foray's segments (F-70; same rule and same name as the tier-1 gate) |
| `m3-order` | the window would sit earlier in an episode this Foray has already joined later (F-70) |

**The reported row is the candidate that got FURTHEST**, not the last one walked or
the highest-ranked one (`TIER2_GATE_PROGRESS` ranks the gates in the order the walk
asks them: `text-index:no-candidate`, `lineage`, `title-tokens`, `m4-share`,
`no-body`, `window-overlap`, `no-anchor`, `m3-order`, `no-audio-source`). A beat that reached the window test on one episode and a bare title on
seven others is a beat whose story is the window test; the furthest gate is the one
a person would go and argue with. When nothing was worth opening at all,
`traceTier2Rejected` reports the best **on-topic** episode against the title bar,
or — when the lineage gate is what emptied the field — the best episode of *any*
family, named as `lineage`; and when the text index was enabled and that would have
read `title-tokens`, the row is reported as `text-index:no-candidate` with
`candidatesConsidered: 0`.

**The per-slot summary** (`sourceBeats.ts:summarizeSourcing`) is a pure function
returning strings — the pipeline prints them, tests read them, a report could carry
them without this module knowing about any of the three:

```text
source: act 1 slot 2 "Where Did This Number Come From?" — 0 tape / 6 narration; top reason: skipped:argument (5 of 6)
```

`topReasonFor` picks the label the same way: `skipped:argument` outright; else
`tier2:<gate>` when the search reached a real episode; else `tier1:<gate>`. Ties
break toward the reason appearing first in the slot, so a slot's line is stable.
Every pre-existing output of this stage is byte-identical; the trace is a new array
beside `tapeRelevance`.

---

### 3.7 Stage 6 — Gather the evidence pack

**Module:** `backend/src/generation/gatherEvidence.ts:DefaultEvidenceGatherer.gather`
**Runs:** inside stage 7, once per page, all pages of a slot in parallel
(`writeNarration.ts:writeSlot`, `Promise.all`).
**Purpose:** produce the documents a narration page's quotes must be **looked up
in**, before any writer call.

This is WS-A's first move and the whole design turns on it. The fix plan's
one-sentence diagnosis: *"The writer is asked to produce verbatim quotes,
publications and contested flags for every claim while being given no text to
quote from… The fix is to make a quote a lookup rather than a claim."* Every one
of F-27 (a Chernobyl "publication" for a Kansas City claim), F-30 (a tape slug as
a publication), F-32 (the same span moving between Wikipedia and Britannica), F-42
(spans shrinking to `"debris"`) and F-46 (the beat purpose quoted back as a
source) is a symptom of the same missing thing: text.

#### 3.7.1 What goes in a pack

`gatherEvidence.ts:EvidencePack`:

The request (`gatherEvidence.ts:EvidenceBeat`) is `{claim, kind?, tape?,
requiresEvidence?}`. **`requiresEvidence`** is set by `writeNarration.ts:writeSlot`
from the page's mode — true for a `Patch` or a `Carry`, which carry the beat's
content, false for a connective page, which may legitimately be written from no
documents at all. It is the one input that decides whether an empty retrieval is
retried (§3.7.2a).

```ts
{
  purpose: string,              // the beat's claim — the same string the
                                // mechanical quote check and the verifier read
  beatKind: "account" | "argument",
  docs: EvidenceDoc[],          // {docId, kind: "tape"|"print", title, url?, retrievedAt?, text}
  tape?: {                      // who is on the tape, if any
    itemId, showTitle, episodeTitle, startSec, endSec
  }
}
```

Two sources, in this order:

**(a) Tape evidence — only for an `account` beat that has a tape pointer.**
`gatherEvidence.ts:tapeEvidenceFor`:
- `findDigestForItem` resolves the tape item id to a transcript digest entry —
  first by exact `deriveItemId` match (which covers a tier-2 minted id), then, for
  a hand-slugged catalogue id, by show prefix plus ≥ 2 shared episode-title words
  (> 3 chars).
- `titlesForItem` resolves the show and episode titles from `data/discover.json`
  first (it covers the tier-1 pool) and the digest entry second (it covers a
  tier-2 episode the catalogue never listed). **`null` when neither knows** —
  better no tape evidence at all than a source attributed to a name the pipeline
  made up.
- `cueWindowText(cues, startSec, endSec, EVIDENCE_TAPE_WINDOW_SEC = 90)` joins
  every cue overlapping `[start − 90, end + 90]`, capped at
  `EVIDENCE_MAX_TAPE_CHARS = 3000` and trimmed on a word boundary (a half-word
  would make a legitimate quote at the window's edge unmatchable).
- The resulting doc is `{docId: "tape:{segmentId}", kind: "tape", title:
  "{showTitle} — {episodeTitle}", text}`. A source citing it therefore gets a real
  work with a real name as its `publication` — exactly what F-30's slug was not.

**An `argument` beat gets print evidence only, never tape** (WS-C): there is no
moment on tape that *is* an argument, and anchoring one to tape is what produced
run 1's off-topic anchors.

**(b) Print evidence — for every beat.** `gatherEvidence.ts:printEvidenceFor`
drives at most **two** retrievals (§3.7.2a); each one, `retrieveFor`, is:
- **Cache first.** `claimHash(claim)` = first 16 hex of
  `sha1(claim.toLowerCase().replace(/\s+/g," ").trim())`. A hit in
  `data-local/evidence/<hash>.json` returns immediately and costs nothing.
- Otherwise call `ExternalResearcher.retrievePassages({claim, maxPassages:
  EVIDENCE_MAX_PRINT_PASSAGES = 3, maxChars: EVIDENCE_MAX_PASSAGE_CHARS = 1500})`.
  The method is **optional** on the interface: a researcher without retrieval
  simply supplies no print evidence, and the page is written from whatever else is
  held.
- Passages with empty text or empty title are filtered out; the rest are capped at
  3 and become `{docId, kind: "print", title, url?, retrievedAt, text}` with the
  text sliced to 1500 chars.
- **Retrieval failing is not the run failing.** A throw is caught, logged as a
  warning, and the page is written from whatever evidence did arrive — and if that
  is nothing, the mechanical rules downstream refuse to let it assert anything,
  which is the correct outcome and a much better one than a page that invents a
  citation because retrieval was down. Since **F-60** an empty pack on a
  content-carrying page does not even cost a writer call: §3.8.2a degrades the page
  instead.

#### 3.7.2 The retrieval call

**Model tier:** `haiku`. **`max_tokens`:** `RETRIEVAL_MAX_OUTPUT_TOKENS = 2000`.
**Tools:** `web_search_20250305`, `max_uses: 3`. **Operation:** `evidence_retrieval`.
**Budget estimate:** `ceil(len/4) × in + min(2000, ceil(3 × 1500 / 4) + 200) × out
+ 3 × $0.01`.

Exact prompt (`AnthropicExternalResearcher.ts:buildRetrievalPrompt`):

```text
Find published text that bears on this claim: "{{claim}}".

Search the web, then COPY passages out of the pages you retrieved — up to {{maxPassages}}, each at most {{maxChars}} characters.
Every passage must be the page's own wording, character for character: do not paraphrase, do not join separated
sentences, do not write a sentence the page does not contain. Prefer a primary or reported source over an
encyclopaedia. If the search finds nothing usable, return an empty array — that is a correct answer.

Respond with ONLY a single JSON object as your FINAL message, no markdown fences, matching exactly:
{"passages": [{"title": string, "url": string, "text": string}]}
```

Response schema (`AnthropicExternalResearcher.ts:PassagesSchema`), parsed with
`parseLastJsonBlock`:

```ts
z.object({
  passages: z.array(z.object({
    title: z.string(),
    url: z.string().optional(),
    text: z.string()
  }))
})
```

The builder mints `docId: "print:{n}"` per passage, stamps a shared
`retrievedAt`, and slices each `text` to `maxChars`.

**Nothing here trusts the model with attribution.** `writeNarration.ts` derives
every `publication` from the held document's own `title`, so a passage whose text
the model wrote rather than retrieved simply becomes a document nothing can be
quoted from that is not in it.

**F-48, open and stated in the code:** what comes back is *the retrieval model's
transcription of a search result*, not bytes fetched from the url. The downstream
substring gate therefore proves a quote is consistent with what this call wrote,
not with the page at that url — so `groundedQuoteRate = 1.0` overstates what has
been checked. The tool type is also still the basic `web_search_20250305`. See
§8.4.

#### 3.7.2a One rephrased retry, and never a third query (F-60)

Run 2's act 1 page **p5** asked once, got `{"passages": []}`, cached the emptiness,
and handed the writer a `Carry` page with no documents — which the mechanical rule
then refused three times over, once per selection call, before ending the Foray.
`printEvidenceFor` now:

1. runs the first retrieval on the beat's purpose verbatim;
2. if it returned documents, **or** the beat is not `requiresEvidence`, stops;
3. otherwise builds a second query with `rephraseClaimForRetrieval(purpose)` and
   runs it **once**, cached under **its own** claim hash so the first query's
   emptiness is never served in its place. If the rephrasing is empty, or hashes to
   the same string as the original, no second call is made at all.

`rephraseClaimForRetrieval` is deliberately mechanical — a model call to rewrite a
query is exactly the kind of spend this finding is about. Take the words of the
**first sentence** (a purpose's later clauses are analogy and consequence); drop
words under 4 characters, duplicates, and a ~140-word `RETRIEVAL_STOPWORDS` list;
keep the **longest** remaining `REPHRASED_QUERY_MAX_WORDS = 8` (length is a free
and good proxy for rarity in English, and rarity is what makes a search term
distinctive), ties broken by first appearance; emit them **in their original
order** so the query still reads as a phrase. Fewer than 3 candidate words → `""`,
and no second call. A one-clause purpose shorter than the query tops up from the
rest of the text rather than returning three words.

For p5 the second query is
`"Mature pipelines dataset out-of-range outright compile letting corrupted"`
rather than the whole editorial sentence. There is never a third query.

#### 3.7.3 The evidence cache

`backend/src/generation/evidenceCache.ts` — one of the **two** places a
generation-stage module writes to disk (the other is `transcriptTextIndex.ts`,
§3.6.6a), isolated into its own file so the rule it is an exception to stays
enforceable.

- Directory: `data-local/evidence/`, chosen by
  `DefaultEvidenceGatherer`'s constructor as
  `researcher.providerName === "stub" ? null : <repo>/data-local/evidence`. A
  stub's "passages" are fixtures, so a dry-run never writes to the cache and a
  test run never writes to `data-local/`.
- File: `<claim-hash>.json` containing `{cachedAt, docs}`. `cacheFile` refuses a
  hash that is not 8–64 hex characters.
- **Why it does not break §9.4** ("Each prompt is discarded"): the file is *named*
  by a hash and there is no field for the claim text, so nothing on disk can be
  read back as a prompt or a beat purpose; and what is written is passages from
  published documents, which is public text about the world, not text about the
  listener. `backend/test/promptNoPersistence.test.ts` names this file as one of the
  two permitted writers and asserts both rules.
- Reads and writes both fail soft: a corrupt cache is a miss, and a cache that
  cannot be written logs a warning and never takes a run down.
- **An EMPTY entry expires** (`EMPTY_EVIDENCE_TTL_MS = 24 h`, F-60). Documents are
  cached forever — a passage retrieved yesterday is the same passage today, and
  re-paying for it is the waste this file exists to stop. An empty result is not
  that kind of fact: it says one query, run once, against a moving web, matched
  nothing. `readEvidenceCache(dir, hash, now)` treats a zero-document entry as a
  **miss** once it is `>= 24 h` old, and a missing or unparseable `cachedAt` counts
  as stale — ask again rather than serve nothing. Run 2's p5 is what treating an
  empty result as durable costs.

#### 3.7.4 The cue provider now reaches the gatherer (was §8.1)

Until this branch `writeNarration` built its gatherer as
`createEvidenceGatherer()` — **with no options** — so `DefaultEvidenceGatherer`
fell back to `NullTranscriptCueProvider` and a tape beat's pack carried the show
and episode **titles** and not one word of the ±90 s cue window, on the same
machine where §3.6 was anchoring against real cues. WS-A's first bullet was
half-built: the who, yes; the words, no (**F-52**).

It is wired now, in two call sites:

- `WriteNarrationOptions` gains **`cueProvider`**, and
  `writeNarration.ts:evidenceGathererFor(options)` returns
  `options.evidence ?? createEvidenceGatherer(options.cueProvider ? {cueProvider} : {})`
  — ignored when a caller injects its own `evidence`, since that caller built its
  own gatherer.
- `runPipeline` passes `deps.cueProvider` into every per-act `writeNarration` call
  — the same provider §3.6 sources against.

`DefaultEvidenceGatherer.cueProvider` is **public readonly** so a test can prove
the provider arrives rather than a comment promising it does; both that assertion
and `evidenceGathererFor` are exported for exactly that reason, because
`createEvidenceGatherer()` with no arguments is valid, silent, and gives every tape
beat a pack with no tape in it.

**Consequence in a real run:** for an `account` beat with a tape pointer whose
episode has a body on this machine, the pack now carries the
`docId: "tape:{segmentId}"` document — the `EVIDENCE_TAPE_WINDOW_SEC = 90` window,
capped at `EVIDENCE_MAX_TAPE_CHARS = 3000` — and a quote on a tape-adjacent page
can be looked up in the tape itself. Where no body exists the pack still carries
`pack.tape` (the titles) and no tape document, which is the honest degraded case
rather than a silent default.

---

### 3.8 Stage 7 — Write the narration

**Module:** `backend/src/generation/writeNarration.ts:writeNarration`
**Collaborators:** `NarrationWriterBuilder` and `NarrationVerifierBuilder` —
**two distinct instances, enforced structurally**: `writeNarration` throws if a
caller passes the same object reference for both (§4.7 rule 2, §5's "1 per act,
never the writer").
**Inputs:** one `SourcedAct` at a time (driven per act by `runPipeline`), the
spine's `Voice`, `ctx`.

#### 3.8.1 The order of operations is the design

```
evidence  → the documents this page may quote          (gatherEvidence.ts)
CODE      → a content page with NO documents is degraded here and never
            enters `pending` — zero model calls for it (§3.8.2a, F-60)
select    → ONE call per slot: which claims, and the span behind each
CODE      → is that span really in that document? long enough? not the purpose
            read back?  — decided by substring checks, never by a model
prose     → ONE call per slot: the scripts, from those claims only
CODE      → structural + copy + negative-claim + empty-source rules, and every
            `publication` derived from the held document
verify    → ONE call per slot: three questions a model is actually needed for
```

A model is never asked to decide something a string comparison can decide, and
never gets to be the last check on one.

**Parallelism (WS-D1):** every **slot** of an act is written in parallel
(`Promise.all` over `act.slots`). Nothing in a slot depends on another slot's
text — the running order and the M3/M4 guarantees were fixed at sourcing time,
over the whole Foray. **Acts stay sequential**, driven one at a time by
`runPipeline` so each act can be checkpointed as it finishes.

**Call count:** at most **3 model calls per slot per round**, whatever the page
count — down from run 1's 4.2 calls *per beat*. And **zero** for a slot whose every
content page arrived with an empty evidence pack (§3.8.2a).

**G-34 — how the order above is paid for (latency model M3, levers a and b).**
Nothing in the order changes; two things about its cost do:

- **`select` and `prose` are one call** when the builder offers
  `NarrationWriterBuilder.selectAndWrite` (the Anthropic and stub builders both
  do; a builder without it gets the two-call pair). The reply carries, per page,
  the claims *with* their quotes *and* the script. The mechanical gate on the
  quotes (§3.8.4) runs on that reply exactly as it ran between the two replies —
  a quote that is not a span of the named document still never becomes a source.
  A page whose quotes all resolve keeps its script; a page with a quote that does
  not has spent that script (the roadmap card accepts this: "a rejected quote now
  wastes a script"), **keeps the claims that did resolve**, and re-runs **only
  that page's prose** from them on the next round through `writePages`. A page
  left with no grounded claim re-selects — there is nothing to write from.
- **A rejection after the gate re-runs prose + verify for the rejected pages
  only.** Whether the structural gate (§3.8.6) or the verifier (§3.8.8) refused
  the page, its claims were proven spans of held documents and that proof does
  not expire: the next round is one `writePages` call for those pages, from
  those claims, plus one verifier call. Pages that passed keep their scripts and
  are never named in a later request. This is uniform across the verifier's three
  questions on purpose — even "not supported by its quote" is a property of the
  *script* against the quote, and the writer can assert fewer claims without a
  fresh selection.

So a first round is two requests (merged, verify) and a retry round is two
(prose, verify), where each used to be three for the whole slot. A page still
gets at most `NARRATION_PAGE_ATTEMPTS` attempts (§3.8.9), and every F-51 outcome
(§3.8.10) is unchanged. Lever (c) — treating a `purposeRevised` page's
`purposeAccomplished: false` as accepted — is a founder decision (roadmap D6)
and is **not** built; a test pins that such a page is still a rejection.
`meta.veracity` reports `narrationCallsPerBeat`, `narrationCalls` and
`retryRounds` (§5.4) so the saving is measured, not asserted.

#### 3.8.2 Which beats get a page

- Every `sourcing: "narration"` beat gets a page in its assigned mode (`Patch` or
  `Carry`).
- A `sourcing: "tape"` beat gets a **connective** page only when
  `writeNarration.ts:decideConnectiveNarration(slot, beatIndex)` returns a mode.
  That function is narration-craft §3b's seam table reduced to a positional rule
  this stage can apply without stitching context, and it is deliberately
  conservative — it returns **`"Frame"`** in exactly three cases and `null`
  otherwise:

| Position | Result | narration-craft basis |
|---|---|---|
| the tape beat **opens** its slot | `Frame` | §3b S1/S2, "a Frame introduces tape that carries the beat" |
| the previous beat is **narration** | `Frame` | §3b S4/S5, a narration item exiting into tape needs a Frame-shaped handoff |
| the previous beat is tape from a **different** `itemId` | `Frame` | §3b S1, cross-episode tape-to-tape, attribution mandatory |
| the previous beat is tape from the **same** `itemId` | `null` | §3b S3 is a duration judgement out of this stage's scope; §4.8's silence-is-a-valid-bridge rule applies |

The connective page carries a `contextNote`:

```text
This page hands the listener into or out of real tape — segment {{segmentId}}. It does not restate what the tape itself says (narration-craft.md's spoiler rule).
```

#### 3.8.2a The no-evidence guard, before any model call (F-60)

`writeSlot` gathers every page's evidence pack in parallel, and then — **before the
attempt loop** — walks the pages once:

```
if (pageCarriesContent(page.mode) && page.evidence.docs.length === 0)
    → page.result = handOffPage("no-evidence", …)      // no writer call, ever
```

`pageCarriesContent(mode)` is `mode === "Patch" || mode === "Carry"` — the two
modes `validateNarratedBeat` requires a source from, and therefore the two that
cannot be written from an empty pack. Marking the page here takes it out of
`pending`, so **a slot whose every content page is in this state makes zero writer
and zero verifier calls**. Run 2 spent three selection calls discovering this per
page, on a prompt whose own text said *"Documents: none were retrieved for this
page"*, each rejection telling the writer to fix something it had no way to fix.

The degraded page (`handOffPage`) is:

```ts
{
  mode: HANDOFF_MODE = "Hinge",
  script: HANDOFF_SCRIPT,
  sources: [], pronunciationHints: [],
  verified: false,
  unverifiedReason: "no-evidence",
  verifierNotes: NO_EVIDENCE_NOTE = "no evidence retrieved after two queries",
  evidence: heldDocsOf(pack),   // empty
  attempts: []
}
```

`HANDOFF_SCRIPT` is *"Where does this part of the story go next? Keep listening —
the thread picks it up on the other side."* That shape is not decorative: it is the
**only** shape `validateNarratedBeat` permits with zero sources (F-36/F-37/F-44's
rule), because every sentence is a question or opens with a listener imperative, so
`hasDeclarativeSentence` finds nothing to demand a source for. A test pins that the
degraded page's *only* validation issue is `not-verified`. `Hinge` rather than the
beat's original Carry mode, because a ~100-character page claiming a 765–1,870
character budget would fail its own band.

**Why the page is kept rather than dropped.** A connective page can be dropped
because its beat survives as its tape (`WrittenBeat`'s tape variant simply carries
no `connectiveNarration`). A narration beat **is** its page — the narration variant
has no page-less form — so dropping the page drops the beat, and §3.6's guarantee
that the beat list comes out of the pipeline exactly as it went in
(`validateSourcing`, plus `stitchAct`'s coverage and `computePagesDropped`, which
index written beats positionally against sourced ones) would break. Counting it in
`pagesDropped` would also mislabel it: that counter means "a connective page nobody
hears the absence of", and this is a page a listener *would* hear. So the page
stays, marked, counted in `meta.veracity.unverifiedPages`, and refused by the
publish gate.

#### 3.8.3 Call A — claim selection

**Model tier:** `sonnet`. **`max_tokens`:** 4000
(`AnthropicNarrationWriterBuilder.ts:MAX_OUTPUT_TOKENS`, sized for the largest
realistic slot — 7 beats, the medium tier's upper bound — with Carry-band
scripts). **Operation:** `narration_select_claims`.

`{{evidenceBlocks}}` is one block per pending page, joined by a blank line
(`AnthropicNarrationWriterBuilder.ts:evidenceBlock`):

```text
PAGE {{pageId}} — mode {{mode}}
Purpose (editorial direction, NOT a source): {{purpose}}
Context: {{contextNote}}
Tape this page sits against: "{{episodeTitle}}" from {{showTitle}}. That is audio, not a print source.
--- docId: {{docId}} | {{title}} | {{url}}
{{documentText}}
REJECTIONS SO FAR: {{retryNote}}
```

with the `Context:`, `Tape this page sits against:`, `| {{url}}` and
`REJECTIONS SO FAR:` lines each present only when that field exists. When a page
has no documents at all the document lines are replaced by the single line
`Documents: none were retrieved for this page.`

The full prompt, verbatim (`buildSelectionPrompt`; `MIN_QUOTE_WORDS` is 8):

```text
You are selecting the factual claims for the narration pages of one slot ("{{slotTitle}}") of an audio documentary.
For each page, choose the claims it should make and, for each claim, COPY the span of one document below that backs it.

A quote must be copied character for character out of the document you name, and must be at least 8 words or one whole sentence.
Never quote the purpose or this prompt: they are direction, not documents.
If a document does not support a claim worth making, select no claim for that page rather than a weak one.
If the documents contradict or complicate the purpose, select the claims that show that: the page's job is then to report the tension, not to assert the purpose.
"contested" means reputable sources actively disagree about the fact itself — not that you are unsure.

{{evidenceBlocks}}

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"pages": [{"pageId": string, "claims": [{"claimText": string, "quote": string, "docId": string, "contested": boolean}]}]}
```

Response schema (`AnthropicNarrationWriterBuilder.ts:RawSelectionSchema`):

```ts
z.object({
  pages: z.array(z.object({
    pageId: z.string(),
    claims: z.array(z.object({
      claimText: z.string(),
      quote: z.string(),
      docId: z.string(),
      contested: z.boolean()
    }))
  }))
})
```

#### 3.8.4 The mechanical gate on the selection

`writeNarration.ts:decodeClaimEntities` runs **first**: HTML/XML entities
(`&amp;`, `&quot;`, `&#39;`, numeric refs) are decoded out of `claimText` and
`quote` using `feeds/html.ts:decodeEntities`. This is **F-26**, and the ordering
is load-bearing — the held documents carry `&`, not `&amp;`, so decoding after
the substring check would reject a perfectly good quote for a difference no reader
can see. `publication` is not in the list because it is no longer writer-supplied
text at all.

`writeNarration.ts:validateSelectedClaims(claims, page)` — every rule is a
substring or a word count; none is a judgement, and none is ever asked of a model:

| # | Rule | Message shape | Finding |
|---|---|---|---|
| 1 | Zero claims on a `Patch`/`Carry` page is rejected: "a Patch page carries the beat's content by definition and must select at least one claim…" (or "no evidence could be gathered for this Patch page…" when the pack is empty). Zero claims on a connective page is allowed here. | — | §4.7 rule 1, F-36/F-37 |
| 2 | A claim with empty `claimText` | "a selected claim has no claim text" | — |
| 3 | `docId` not among the documents provided | `cites docId "X", which is not one of the documents provided` | — |
| 4 | **The quote is not a verbatim span of the named document.** `findHoldingDoc` normalises both sides — NFKC, curly quotes/dashes/ellipses folded to ASCII, whitespace collapsed, lowercased — and requires containment. If the span is in a *different* held document, the message says so by name. | `the quote is not in "A" — it is in "B". Quote the document you cite.` / `the quote is not a verbatim span of any document provided. Copy a span out of one of them; do not write one from memory (F-14/F-27).` | **F-14, F-27** |
| 5 | **Minimum span.** `quoteWords(quote).length < MIN_QUOTE_WORDS (8)` and not `isCompleteSentence(quote, doc.text)` | `the quote is N word(s). Take at least 8 words, or a whole sentence (F-42).` | **F-42** |
| 6 | **Purpose echo.** `quoteEchoesPurpose(quote, purposeText)` where `purposeText = [beat claim, contextNote].join(" ")` | `the quote repeats this beat's own purpose or prompt text. The purpose is editorial direction, never a source (F-46).` | **F-46** |

`isCompleteSentence` (in `types/narration.ts`) accepts a short span only when it
is a whole sentence: an initial capital, a terminal `.`/`!`/`?`, ≥ 3 words, **and**
— when the holding document is known — the span must sit at a real sentence
boundary in it, so a mid-sentence fragment cannot be dressed up by capitalising it.

`quoteEchoesPurpose` compares **word sequences**, never raw strings (a one-word
purpose is a substring of almost any quote). It fires when either run contains the
other, or when any `MAX_PURPOSE_OVERLAP_WORDS = 6`-word window of the quote appears
in the purpose. 6 is set below `MIN_QUOTE_WORDS = 8` so a quote that *is* the
purpose can never slip through on length.

**A page whose selection fails is rejected without a prose call.** Writing a
script from ungrounded claims would only produce a page that fails again one call
later.

#### 3.8.5 Call B — prose

**Model tier:** `sonnet`. **`max_tokens`:** 4000. **Operation:** `narration_write`.

`{{prosePageBlocks}}` is one block per page that survived the gate
(`AnthropicNarrationWriterBuilder.ts:prosePageBlock`), where `{{min}}`/`{{max}}`
come from `MODE_CHAR_BANDS[mode]`:

```text
PAGE {{pageId}} — mode {{mode}}, {{min}}-{{max}} characters (the script MUST land inside that band).
What this page must accomplish: {{purpose}}
Context: {{contextNote}}
It sits against tape: "{{episodeTitle}}" from {{showTitle}}.
Claims:
  [0] {{claimText}}
  [1] {{claimText}} (CONTESTED — the script must say so)
REJECTIONS SO FAR: {{retryNote}}
```

and, when the page selected no claims, that whole `Claims:` block is replaced by
the single line:

```text
Claims: none. This page may assert nothing — ask a question or hand off to the listener.
```

The full prompt, verbatim (`buildProsePrompt`):

```text
You are writing the narration pages of one slot ("{{slotTitle}}") of an audio documentary ("Foray").
Voice (decided once for the whole Foray — do not vary it): style: {{style}}; register: {{register}}; sentence rhythm: {{sentenceRhythm}}; narrator presence: {{narratorPresence}}

Write each page from its listed claims and nothing else. The claims are already sourced; you do not return sources.
If the claims contradict or complicate the purpose, write the tension — that page accomplishes its purpose — and set purposeRevised true for it.
List the indices of the claims your script actually asserts. A page that asserts none must be a question or a hand-off to the listener, with no statement about the world in it.
Do not say what the record does or does not contain unless a claim below says it.

Copy rules, unchanged and non-negotiable:
- Never say: fascinating, deep dive, delve, explores.
- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.
- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving.
- If a claim below is marked contested, the script must say the point is disputed.

{{prosePageBlocks}}

Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"pages": [{"pageId": string, "script": string, "usedClaims": [number], "purposeRevised": boolean, "pronunciationHints": [{"word": string, "hint": string}]}]}
```

Response schema (`AnthropicNarrationWriterBuilder.ts:RawProseSchema`):

```ts
z.object({
  pages: z.array(z.object({
    pageId: z.string(),
    script: z.string(),
    usedClaims: z.array(z.number()),
    purposeRevised: z.boolean().optional(),   // F-50 — see below
    pronunciationHints: z.array(z.object({ word: z.string(), hint: z.string() }))
  }))
})
```

**`purposeRevised` is asked for in the contract line and optional in the schema.**
A reply that omits it is still valid JSON for this stage, and an absent flag means
"not claimed" — which is what a page that simply did its purpose should say. It is
**recorded, not trusted**: `runSlotAttempt` copies it onto the beat only when it is
literally `true`, and the verifier answers the same question independently (§3.8.8).

**The writer never returns a source.** `writeNarration.ts:sourcesFor(usedClaims,
claims, pack)` builds the `sources[]` array itself: for each valid, unique index
the script says it used, it takes the claim's `claimText`, `quote` and
`contested`, and reads `publication` from the **held document's `title`** and
`url`/`retrieved` from the document's own fields. That is what makes **F-30** (a
tape slug as a publication) and **F-32** (the same span moving between Wikipedia
and Britannica across two attempts) *unrepresentable* rather than merely
forbidden.

The script is passed through `decodeEntities` on the way in — a narrator does not
say "ampersand a-m-p semicolon" (F-26).

#### 3.8.6 The mechanical gate on the prose

`types/narration.ts:validateNarratedBeat(beat, {bannedPhrasePatterns, heldDocs,
purposeText})`. Every issue code, with its rule and the finding that motivated it:

| Code | Rule | Finding |
|---|---|---|
| `script-empty` | the script trims to nothing | — |
| `out-of-budget` | `script.length` outside `MODE_CHAR_BANDS[mode]` (see §3.8.7) | narration-craft §0 |
| `missing-sources` | a `Patch` or `Carry` page with `sources.length === 0` — it carries the beat's content by definition | §4.7 rule 1 |
| `contested-not-flagged-in-text` | any source marked `contested` while `containsContestedLanguage(script)` is false | §4.7 rule 3, **F-43** |
| `sources-empty-with-claims` | zero sources **and** `hasDeclarativeSentence(script)` — "a page with no sources may only ask a question or hand off to the listener" | **F-36 / F-37 / F-44** |
| `quote-not-held` | the quote is not a verbatim span of any held document — "a quote is a lookup, not a recollection" | **F-14 / F-27** |
| `publication-not-held` | `publication` is neither the holding document's `title` nor its `url` — "attribution is read off the document, never written" | **F-30 / F-32** |
| `quote-too-short` | `< MIN_QUOTE_WORDS (8)` words and not a complete sentence in the holding document | **F-42** |
| `quote-echoes-purpose` | `quoteEchoesPurpose(quote, purposeText)` | **F-28 / F-46** |
| `unsourced-negative-claim` | `containsNegativeRecordClaim(script)` while no source's *quote* also carries a negative-record claim | **F-45** |
| `banned-copy` | the script matches any pattern in `backend/src/copy/rules.js:BANNED` | copy rules |
| `not-verified` | `beat.verified !== true` | §4.7 rule 2 |

Plus one rule applied by the orchestrator rather than the validator
(`writeNarration.ts:looksLikeSlug`): a `publication` shaped like a
`data/segments.json` item id — all lowercase, hyphen/`#`-separated, ≥ 2
separators, no doubled separators — is rejected with *"is a tape item id, not a
publication"*. It can now only fire if a held document is itself named like a
slug; it is kept as a last guard because the cost of it firing wrongly is one
retry and the cost of it not existing was a podcast about griddles cited as a
source (**F-30**). It is deliberately three linear tests rather than one regex,
because the obvious `/^[a-z0-9]+(?:[-#][a-z0-9]+){2,}$/` is catastrophically
backtrackable on model output.

**`containsContestedLanguage`** matches **stems**, not phrases —
`contest`, `disput`, `debat`, `disagree`, `argue`, `argued`, `argument`,
`unsettled`, `unresolved`, `open question`, `not everyone agrees`,
`accounts differ`, `the evidence is mixed`, `no consensus`, `cannot settle`,
`can't settle`, `still ask`. **F-43** is why: run 1 rejected two correct pages
because the writer said "historians still argue over" and "historians still
dispute", neither of which was on the old phrase list. Note that on this branch
the *decision* has also moved to the verifier's third question, which judges rule
3 with the source list in hand; this list is the structural backstop.

**`containsNegativeRecordClaim`** is eight explicit regexes (F-45): "the
record/file/archive/documentation … does not/doesn't/never/cannot/fails to",
"the records/sources/documents/accounts/files/archives … are silent",
"no one/nobody/no-one knows/knew/recorded/wrote/said/documented/noted/remembers",
"there is/there's/there was/there were no record/account/documentation/evidence/paper trail",
"no record/account/documentation/note/memo says/shows/survives/exists/remains/was kept",
"we/historians/investigators do not/don't/does not/doesn't/still don't/never know",
"is/was/were/are not/never recorded", "was never written down".

**`hasDeclarativeSentence`** splits on sentence terminators and treats a sentence
as declarative unless it ends in `?`, is under 3 words, or opens with one of 16
listener imperatives (`listen`, `notice`, `watch`, `hear`, `keep`, `stay`,
`think`, `consider`, `remember`, `picture`, `imagine`, `follow`, `hold`, `wait`,
`note`, `ask`).

#### 3.8.7 The mode character bands

`types/narration.ts:MODE_CHAR_BANDS`, mirroring narration-craft §0's table.
`backend/test/narration.test.ts` cross-checks these against
`check-narration.mjs`'s own exported table at test time, so the two cannot drift.

| Mode | Characters | Seconds at 17 chars/s | Job |
|---|---|---|---|
| `Hinge` | 50–135 | 3–8 | closes one piece of tape, opens the next |
| `Frame` | 70–170 | 4–10 | introduces tape that carries the beat |
| `Marker` | 135–340 | 8–20 | announces structure |
| `Correction` | 100–205 | 6–12 | bounds, attributes or contradicts adjacent tape |
| `Patch` | 340–765 | 20–45 | supplies the part of a beat its tape misses |
| `Carry` | 765–1870 | 45–110 | **is** the beat; there is no tape |

`NARRATION_CHARS_PER_SEC = 17` (170 wpm × 6.0 chars/word), shared verbatim with
`player/foray-queue.js` and `check-narration.mjs`.

#### 3.8.8 Call C — verification

**Model tier:** `sonnet`. **`max_tokens`:** 2000
(`AnthropicNarrationVerifierBuilder.ts:MAX_OUTPUT_TOKENS`). **Operation:**
`narration_verify`. **A separate class, a separate file, a separate instance** —
it never imports, calls or shares state with the writer.

`{{verifyPageBlocks}}` is one block per page, joined by a blank line
(`verifyPageBlock`):

```text
PAGE {{pageId}} — mode {{mode}}
Purpose: {{purpose}}
Script:
{{script}}
Sources:
  Source 1: claim="{{claimText}}" quote="{{quote}}" publication="{{publication}}" [marked contested]
Documents the page was written from:
  --- {{title}} | {{url}}
{{documentText}}
```

with `  (none declared)` in place of the source lines when there are none, and the
`Documents…` section omitted when the pack held none.

The full prompt, verbatim (`buildVerifyPrompt`):

```text
You are the FACT-VERIFICATION pass for the narration pages of one slot of an audio documentary ("Foray").
You did NOT write these pages. For each page below, answer three questions independently.

1. claimsSupported — does every statement the script makes about the world follow from the quote attached to it?
   A quote that is about the right subject but does not say what the claim says is NOT support.
2. purposeAccomplished — does the script address the SUBJECT its purpose names, using the evidence it was given?
   Contradicting or qualifying the purpose from the documents ACCOMPLISHES it — a purpose is editorial direction and can
   be wrong. Only a page that ignores the subject, or re-tells what earlier pages covered, fails this.
   purposeRevised — true when the page departs from its purpose because the evidence did. Your own judgement, not the writer's.
3. contestedHandled — read the sources: if reputable sources actively disagree about something the script
   asserts, the script must say the point is disputed, in any natural wording. If nothing is genuinely
   contested, this is true. Judge the substance, not the presence of any particular phrase.

Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.

{{verifyPageBlocks}}

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"pages": [{"pageId": string, "claimsSupported": boolean, "purposeAccomplished": boolean, "purposeRevised": boolean, "contestedHandled": boolean, "notes": string (required and specific whenever any answer is false)}]}
```

Response schema (`AnthropicNarrationVerifierBuilder.ts:RawVerifyResultSchema`):

```ts
z.object({
  pages: z.array(z.object({
    pageId: z.string(),
    claimsSupported: z.boolean(),
    purposeAccomplished: z.boolean(),
    purposeRevised: z.boolean().optional(),   // F-50 — a reply that does not
                                              // answer it has not said "no"
    contestedHandled: z.boolean(),
    notes: z.string().optional()
  }))
})
```

Three questions instead of run 1's one. Run 1's prompt said *"read it against ONLY
its declared sources"*, which made the verifier a consistency check on the
writer's own declarations: it passed a page citing Chernobyl interviews for a
Kansas City claim in five seconds (**F-27**), never asked whether a page did the
job its beat existed for (**F-41**), and decided the zero-source case by sampling
— ten rejections and one pass on the same shape of page (**F-44**). Question 3
also takes rule 3 away from the keyword detector (**F-43**).

**Question 2 was redefined by F-50, and that is the change that ended run 2's
class of failure.** The old question — "does the script do the job its purpose
describes?" — made the purpose unfalsifiable. Run 2's act 1 page **p2** had a
deepen-stage purpose asserting that the feature store exists because training and
serving code paths drift apart silently; retrieval returned *Why Feature Stores
Didn't Fix Training–Serving Skew* — *"Feature stores manage data artifacts. They do
not control execution."* Attempt 1 asserted the purpose and was rejected as
unsupported by its quotes and contested by its own source; attempts 2–3 narrowed to
what the documents supported and never said "feature store", and were rejected for
dropping the concept the purpose names. **Every verdict was correct**, and the page
that would have passed — *the feature store was sold as the fix, and the people who
built them say it isn't* — was permitted by neither prompt.

So `purposeAccomplished` now asks whether the page **addresses the purpose's
subject with the evidence available**, *including by contradicting or qualifying
the purpose*. Only a page that ignores the subject — or re-tells what earlier pages
covered — fails. **F-41 is not weakened**: a test replays attempts 2–3 verbatim in
shape and they still fail. The verifier additionally returns its own
`purposeRevised`, kept separately from the writer's flag (§3.8.11) because two
agents answering independently is §4.7 rule 2, and a page one flagged and the other
did not is exactly the page an editor most wants to see.

**It is deliberately not asked whether a quote exists**; that is proven in code
against the held documents before it is ever called.

Failure mapping (`writeNarration.ts:runSlotAttempt`) — the page is rejected with:

- `!claimsSupported` → "a claim in the script is not supported by the quote attached to it"
- `!purposeAccomplished` → "the page does not accomplish the purpose the beat was given"
- `!contestedHandled` → "a genuinely contested point is not handled as §4.7 rule 3 requires"
- a missing verdict for a page in the batch → "the verifier returned no verdict for …"

joined with `; ` and suffixed with the verifier's own `notes` when present.

#### 3.8.9 Retries — three informed attempts, accumulating every rejection

`NARRATION_PAGE_ATTEMPTS = 3` (raised from 2 mid-run-1 after **F-31**, which
computed that at a ~20 % second-attempt failure rate over 31 pages the chance of
finishing a medium Foray was `0.8^31 ≈ 0.1 %`).

A round operates on the slot's still-pending pages only, and (G-34, §3.8.1) does
for each page only what that page needs: a page with grounded claims from an
earlier round is re-written from them, a page without any is re-selected. Every
page a round takes leaves it with exactly one attempt recorded, so a page's
`attempts.length` is the number of rounds it took part in. Each rejection is
appended to `page.rejections`, and the retry note is rebuilt from the **whole
history** (`writeNarration.ts:retryNoteFrom`) — **F-35**, because run 1 overwrote
the note on each failure, so attempt 3 was told about attempt 2 only and regularly
revived the fault attempt 1 was rejected for:

```text
Attempt 1 was rejected for: {{reason}}. Attempt 2 was rejected for: {{reason}}. Write a corrected page that fixes every problem listed above — including the earlier ones — while keeping all other rules.
```

This string is passed as `retryNote` and appears in **both** the selection prompt
(`REJECTIONS SO FAR: …`) and the prose prompt.

Every attempt is recorded on the page as a `NarrationAttemptRecord`
(`{attempt, sources, rejected, rejectionNote?}`), whether it passed or failed;
that is what makes WS-B's `firstAttemptPassRate` and `attributionStability`
computable from data rather than from side effects.

#### 3.8.10 Failure policy — a page never kills the Foray (F-51, F-60)

| Case | Outcome |
|---|---|
| A **connective** page (Frame/Hinge/Marker/Correction around a tape beat) fails all 3 attempts | **The page is dropped and the tape is kept**, unchanged. A `console.warn` names the mode, the first 80 chars of the claim and the joined rejections. §4.8's silence-is-a-valid-bridge rule covers the seam. Run 1 attempt 3 died at beat 5 of 31 because a hand-off line failed twice — thirty beats of finished work discarded (**F-17 / F-31**). |
| A **narration-sourced** page (Patch/Carry) fails all 3 attempts | **The page is KEPT, `verified: false`, and the run continues** (`unverifiedResultFor`). The salvage prefers the last **mechanically clean** page — quotes held, spans long enough, attribution read off the document — that the verifier nonetheless refused (`page.kept`, banked *before* the verifier is called), and falls back to the last page produced at all (`page.lastBeat`). It carries its whole `attempts` history, the verifier's final objection in `verifierNotes`, and `purposeAccomplished`/`purposeRevisedByVerifier` when the verdict supplied them. A `console.warn` names it. |
| A narration page for which **no prose call ever produced a page** | The same hand-off shape as §3.8.2a, with `unverifiedReason: "no-page"` and the last rejection as `verifierNotes`, plus the full `attempts` history — so an editor can tell "there was evidence and nothing usable came back" from "no evidence behind this beat at all". |
| A **content page whose evidence pack is empty** after both retrieval queries | Degraded before any model call — §3.8.2a, `unverifiedReason: "no-evidence"`. |

**This is a reversal of the previous policy, and the thing that justifies it is
downstream.** Run 2 died at act 1 page p2 with **10 of 12 pages verified and 34
model calls spent**, while a veracity gate whose entire job is to judge a flawed
candidate and refuse to publish it sat unused behind it. Throwing here discards
eleven good pages to prevent a twelfth from being published that the gate would
have refused anyway. So: **a page never kills the Foray, the gate decides.**
`meta.veracity.unverifiedPages` counts every page above and
`evaluateVeracityGate` refuses on any of them (§5.4, §5.5).

**`NarrationWriteError` is no longer thrown from any per-page path.** It survives
as the guard on the one thing this stage cannot honestly return — a slot that came
out with fewer beats than it went in with — which is unreachable by construction
(every narration beat leaves a page behind and every tape beat leaves its tape) and
is pinned as unreachable by a test. It stays because the invariant is worth more
than the branch costs: §3.6's beat list must survive §3.8 unchanged, or every
positional consumer downstream (`stitchAct`'s coverage, `computePagesDropped`)
quietly misattributes pages to beats. `InvalidNarratedBeatError` is likewise kept
and no longer thrown by this module — it remains the typed shape of "this page did
not validate, and here is every reason", the record an editor tool would build from
`NarratedBeat.attempts`.

#### 3.8.11 Output and checkpointing

`writeNarration.ts:WrittenAct` — `{title, slots: [{title, beats: WrittenBeat[]}]}`
where a `WrittenBeat` is either
`{sourcing: "tape", claim, exploration, tape, connectiveNarration?}` or
`{sourcing: "narration", claim, exploration, narration}`.

Each kept `NarratedBeat` (`types/narration.ts:NarratedBeatSchema`, `.strict()`)
carries:

```ts
{
  mode, script, sources[], pronunciationHints[],
  verified: boolean,               // false on a kept-unverified or degraded page
  purposeAccomplished?: boolean,   // the verifier's Q2 — WS-B's purposeFidelity
  purposeRevised?: boolean,             // F-50, the WRITER's own flag
  purposeRevisedByVerifier?: boolean,   // F-50, the VERIFIER's independent answer
  verifierNotes?: string,
  unverifiedReason?: "no-evidence" | "no-page",   // F-60
  evidence?: EvidenceDoc[],        // the held documents — WS-B's groundedQuoteRate
  attempts?: NarrationAttemptRecord[]
}
```

`NarratedBeatSchema` stays `.strict()`. The two purpose flags are kept **separate**
rather than merged, because they are two agents answering the same question
independently; `types/narration.ts:purposeWasRevised(beat)` is the single
definition of the disjunction, so no consumer can get it subtly wrong in its own
copy (`veracityMetrics.ts:computePurposeRevisedPages` uses it). A page the verifier
simply refused carries **no** `unverifiedReason` at all — its `verifierNotes` is
the objection, which is the more useful thing to read.

- **Checkpoint keys:** `narrate:0`, `narrate:1`, … — one per act, because
  `runPipeline` drives `writeNarration([act], …)` one act at a time precisely so a
  finished act is banked. Re-validated on resume by
  `runPipeline.ts:WrittenActSchema` (declared there because `WrittenAct` is an
  interface, not a zod type).
- **Per-slot checkpoint keys:** `narrate:<act>:<slot>` (F-51's second half).
  `WriteNarrationOptions` takes a `resume(actIndex, slotIndex)` / `onSlotWritten`
  callback pair — the same pair `deepenActs` has for acts, at slot granularity —
  and `runPipeline` wires them to `checkpoint.resumeSync`/`checkpoint.save` under
  that key, re-validated by `WrittenSlotSchema`. `narrate:<i>` remains the **outer**
  record: once an act finishes, one key holds it and nothing inside it is consulted
  again. But `narrate:<i>` is only *written* when the whole act finishes, so a run
  that died partway through act 1 re-paid for every page of it — run 2's re-run
  would have re-paid for all twelve of act 1's pages to reach the one that failed.
  `onSlotWritten` is awaited **before** the act's `Promise.all` settles, so a slot
  that finished is banked even when a sibling slot throws. `writeNarration` is
  handed one act, so its own act index is always 0; the outer `i` names the key.
- **Call counting:** `runPipeline` wraps both builders in counting proxies, so
  `callsPerBeat` counts **requests** — a four-page slot that passes first time
  costs 1 writer call (G-34's merged select+prose) and 1 verifier call, not 8
  and 4. Selection, prose and the merged call are summed into the one writer
  counter deliberately, to stay comparable with run 1's 4.2. The proxy forwards
  `selectAndWrite` only when the wrapped builder offers it — its absence is what
  sends `writeNarration` down the two-call path.

**Stub behaviour.** `StubNarrationWriterBuilder` **quotes out of the evidence
pack**: `firstLegalSpan` copies the first 8-word window of a held document that is
not an echo of the purpose, so the substring check, the length check and the
purpose-overlap check all run for real in `--dry-run`. When no evidence arrived it
selects nothing and writes a question-only script (the one shape allowed zero
sources), padding to the mode's band from a filler list that contains no banned
word, no digit, no citation token and no negative-record claim.
It always returns `purposeRevised: false`: F-50's permission exists for the live
writer, and a stub claiming it would assert an editorial judgement it has no way to
make ("did the documents contradict the purpose?"). The field is present rather
than omitted so the dry-run path exercises the same shape production does.

`StubNarrationVerifierBuilder` answers each of the three questions with the
strongest **structural** signal available and says nothing it cannot support —
`claimsSupported` fails only on a source attached to no claim; `purposeAccomplished`
requires at least one shared content word between script and the **subject its
purpose names** (F-41's own failure mode), which is exactly what F-50 narrowed the
live question to, so a page that *contradicts* its purpose from the documents
passes here too; `contestedHandled` is the string rule; `purposeRevised` is never
claimed, for the same reason the writer stub never claims it. It additionally
*asserts* F-44's settled case: a zero-source page with a declarative script
reaching verification means the upstream structural rule did not run, and it fails
loudly.

---

### 3.9 Stage 8 — Stitch

**Module:** `backend/src/generation/stitchForay.ts:stitchForay`
**Purpose:** turn the deepened acts (introductions/exits) plus the written acts
(pages) into the final ordered `ForayItem[]`.
**Inputs:** `DeepenedAct[]` and `WrittenAct[]`, same length, same order — checked
defensively and thrown on.

Three steps, in this order:

#### 3.9.1 Cross-act continuity — the only model call in this stage

`backend/src/generation/smoothSeam.ts:smoothActs` runs the **one** continuity
agent at every act boundary — `acts.length − 1` calls, in series. It runs
**before** within-act assembly, so the smoothed introduction is what reaches the
item list.

**Forward-only, structurally.** `ContinuityBuilder.smoothSeam` returns *only* a
replacement `nextIntroduction`; there is no return slot for a revised previous
exit. A builder cannot hand back a rewritten previous act even if it wanted to,
and `smoothActs` returns a **new** array with every untouched act `===`-equal to
the input. This is §6.2's "once the listener has heard an act, that act is
immutable", made true of the data structure and not only of the player.

**Model tier:** `sonnet`. **`max_tokens`:** 500
(`AnthropicContinuityBuilder.ts:MAX_OUTPUT_TOKENS`). **Operation:**
`continuity_smooth`.

Exact prompt (`AnthropicContinuityBuilder.ts:buildSmoothPrompt` — note the triple
double-quotes around each block are part of the template):

```text
You are the continuity editor for an audio documentary ("Foray"), working ONLY at the seam between two acts.
The act that just played, "{{previousActTitle}}", ended with this exit line (already played — DO NOT rewrite it, it is given for context only):
"""{{previousActExit}}"""

The next act, "{{nextActTitle}}", currently opens with this introduction (NOT yet played — this is the ONLY text you may change):
"""{{nextActIntroduction}}"""

Rewrite the next act's introduction so it genuinely connects to how the previous act ended — a real callback or handoff, not mere concatenation.
Keep it a real introduction to "{{nextActTitle}}" — do not drop its own content, only smooth the seam into it.
Never mention or restate the previous act's exit text verbatim; reference it naturally.

Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:
{"nextIntroduction": string}
```

Response schema: `z.object({ nextIntroduction: z.string() })`.

**Mechanical validation** (`smoothSeam.ts:validateSmoothedSeam`), deliberately
minimal because the prose judgement already happened inside the call:

- non-empty after trimming;
- at least **50 %** of the original introduction's length — "looks truncated
  rather than smoothed".

A failure throws `SeamSmoothingError`, which **fails the Foray**. There is no
retry and no verifier for this call; §4.8/§5 never asked for one.

`previousAct` is always read from the **original** array, never from the smoothed
copy, matching §6.2's rule that an act's own exit is fixed once written.

#### 3.9.2 Within-act stitching — deterministic, no model call

`backend/src/generation/stitchAct.ts:stitchAct(act, actLabel)` walks the act's
beats in order and applies §4.8's four rules:

| Rule | Behaviour |
|---|---|
| **1. Silence is a valid bridge** | Two adjacent tape items from the **same** episode, with no connective narration between them, get **nothing** inserted. `player/seam-gap.js` already returns 0 s for a bridged seam, and §4.8 forbids "a bridge and a gap… both". |
| **2. The jingle marks a change of tape** | A **cross-episode** tape-to-tape transition that somehow arrives here with no connective narration on either side gets a `StitchedJingleItem` with `reason: "cut"`. This is a structural backstop only — `decideConnectiveNarration` already assigns a Frame to exactly this case, so the ordinary path never needs it. |
| **3. Texture on a cadence** | A same-episode silent bridge that has let more than `TEXTURE_CADENCE_SEC = 155` seconds elapse since the last audible marker gets a jingle with `reason: "cadence"`. **155 is measured, not guessed**: `tools/foray/measure-cadence.mjs`, run against the real 61-minute `grilling-history-1` Foray, found 17 cut-gaps with a **median of 155.34 s** and a mean of 216.06 s. The median is used because it is least distorted by a handful of long single-episode stretches. Re-run that script and update the constant if that Foray is ever re-curated. |
| **4. Coverage is checked before flow** | Every beat gets exactly one `CoverageEntry` (`status: "present"`; this module never drops a beat itself). `types/stitching.ts:validateActCoverage` is the hard gate. |

A narration item or a jingle both reset the cadence clock; a tape item advances it
by its own duration.

Item ids minted here: `narration-{actLabel}-{beatIndex}-beat`,
`narration-{actLabel}-{beatIndex}-connective`,
`jingle-{cut|cadence}-{actLabel}-{beatIndex}`.

#### 3.9.3 Act seams and final mapping

For each act, `stitchForay` pushes, around the act's own body:

- a narration item `{actLabel}-introduction`, mode `Frame`, script = the
  (possibly smoothed) `introduction`, slot = the act's **first** slot title;
- a narration item `{actLabel}-exit`, mode `Frame`, script = the act's `exit`,
  slot = the act's **last** slot title. **The exit is never touched by
  continuity** — only introductions are ever replaced.

Then `backend/src/generation/forayItems.ts:toForayItems` maps the internal
`StitchedItem[]` to the `data/forays.json` item shape, **field by explicit field,
never by spread**, so that a new internal field cannot silently leak:

```ts
// segment
{ type: "segment", segment_id, slot: slugifySlotTitle(slotTitle), label? }
// narration
{ type: "narration", id, script, mode: <lowercased>, slot? }
// jingle
{ type: "jingle", id? }
```

Every schema is `.strict()`. Mode casing is converted here and only here: the
pipeline's internal `NarrationMode` is capitalised (`Frame`), `data/forays.json`
and `check-narration.mjs` use lowercase (`frame`).

`forayItems.ts:assertNoInternalFieldsLeaked` then asserts that none of
`sources`, `verified`, `pronunciationHints`, `beatIndex`, `narrationKind`,
`startSec`, `endSec`, `itemId` appears as an own property of any mapped item. **A
tape item carries no timestamps** — `data/forays.json` references a segment rather
than restating it.

**Slot ids.** `runPipeline.ts:slotsFromSpine` flattens every act's slots in order,
slugifies each title, and **de-duplicates with a numeric suffix** (`foo`, `foo-2`)
so `check-forays` can join items to slots by id. `toForayItem` slugifies the slot
title **without** that de-duplication — see §8.6.

#### 3.9.4 Failure, checkpointing, parallelism

- `ActCoverageFailedError` on any act fails the whole call. A Foray missing
  coverage for one of its own beats is not a partial success.
- **Checkpoint key:** `stitch`, storing `{items}` re-validated by
  `runPipeline.ts:StitchCheckpointSchema` (an array of `ForayItemSchema`).
- **Parallelism:** none. Continuity is serial by nature; act assembly is
  synchronous.
- **WS-D2's `onActReady` fires from inside this stage**, per act, the instant that
  act's items are assembled and coverage-validated — see §3.11.

---

### 3.10 Stage 9 — Finalize

**Module:** `backend/src/generation/finalizeForay.ts:finalizeForay`
**Purpose:** build the exact `data/forays.json` record and run it through the two
real validators. **It writes nothing.**

`buildForayRecord` produces:

```jsonc
{
  "id": "<forayIdFor(title, startedAt)>",
  "kind": "deep-dive",
  "title": "<subject[: angle]>, ≤120 chars",
  "topic": "<a data/taxonomy.json node id>",
  "status": "draft",
  "summary": "<intent.subject>",
  "runtime_sec": <runtimeSecFor(items)>,
  "generated": true,
  "slots": [{ "id": "...", "title": "..." }],
  "items": [ ... ]
}
```

**`generated: true` is set here and only here.** It is the single bit
`check-forays.mjs` gates its generated-Foray-only rules on (the disclosure item, a
mandatory `mode` on every narration item, script-or-asset). None of the four
committed Forays carries it.

`buildCandidateFiles` (formerly `loadCandidateFiles`, and now **exported** so a
test can assert the merge without loading the `.mjs` checkers) reads
`data/forays.json`, `data/segments.json`, `data/segment-sources.json` and
(optionally) `data/taxonomy.json`, and substitutes:

- a copy of the forays file with this candidate **appended** — a duplicate id
  throws before validation;
- a copy of the pool with this run's **minted tier-2 segments** appended, each
  through `mintedSegmentRow(segment, input.topic)`;
- a copy of the registry with their **episode source rows** appended.

Both merges skip any id already on disk: a committed row is the authority for a
segment a curator's batch has already merged. **Nothing is written** — a failing
validation leaves every data file untouched, exactly as before.

**Why the candidate has to carry them** (`FinalizeForayInput.segments` /
`segmentSources`). A tier-2 pointer names a segment that is not in
`data/segments.json` yet: it was cut from a transcript this run, and the merge path
that would write it (`tools/segments/merge-segments.mjs`) runs on a curator's
batch, not inside a generation run. `check-forays.mjs` resolves every item against
the pool it is given, so without these it calls the item an *"unknown segment_id"*,
drops it before every ordering rule, counts its seconds nowhere, and the Foray
fails — which is what would have happened to the first Foray this pipeline sourced
any tier-2 tape for (§8.2, now closed). `tools/foray/check-forays.test.mjs` pins the
end-to-end case: a Foray using a segment tier 2 minted this run resolves with zero
errors and its 120 s land on the listener's clock; dropping either pushed row turns
it red with the two messages above.

`finalizeForay.ts:mintedSegmentRow` is the single producer of a minted pool row
(§2.1.1) and is shared with `publishForay.ts`, so the row the checker validated is
byte-for-byte the row that gets committed.

Both checkers are then **imported and called as-is** via dynamic `import()`, never
reimplemented: a second backend-side copy of D1/D5/L2/L3 would drift from the CI
gate the moment either changed.

`finalizeForay` is injectable on `RunPipelineDeps` for one honest reason, stated
in the code: Vitest re-resolves the `.mjs` dynamic import through its own loader,
which percent-encodes the space in `Vibe Coding`, so `finalizeForay.test.ts` fails
on a Windows checkout under a path with a space and passes on CI's Linux runner.
The real implementation is the default; a test that injects a fake says so.

**Output** (`FinalizeForayResult`): `{validation, forayRecord?, timings}` where
`forayRecord` is present **only** when `validation.ok`, and `validation` carries
`checkForaysErrors`, `checkForaysWarnings`, `checkNarrationErrors`,
`checkNarrationWarnings`.

**Runtime arithmetic** (`runPipeline.ts:runtimeSecFor(items, pool = loadSegmentPool())`)
— the listener's clock, computed the way the checker recomputes it:

- a `segment` item contributes `end_sec − start_sec` resolved from the **pool it is
  given**, because a `ForayItem` deliberately carries no duration. `runPipeline`
  passes `runtimePool` = the committed pool **plus this run's minted tier-2 rows**;
  without that a tier-2 item would contribute 0 s and `check-forays.mjs` would fail
  the Foray for a `runtime_sec` that disagrees with its own items. An unresolvable
  segment still contributes **0** (the checker fails it on the missing reference,
  with a better message than a runtime mismatch would give);
- a `jingle` contributes `JINGLE_DURATION_SEC = 1.5`;
- a narration item contributes `round(script.length / 17 × 1000) / 1000`.

The disclosure item is prepended **before** this sum, so it counts in both this
function and the checker, and the two agree.

**No stage checkpoint** — `finalize` runs under `timed(…)` only.

---

### 3.11 The partial candidate (WS-D2)

Optional, and off unless the caller supplies `deps.onActReady`. The batch driver
supplies it for every non-dry run.

`stitchForay`'s `onActReady` fires per act with the act's own items and the
cumulative items so far. `runPipeline` then:

1. sets `ttlA1Ms = Date.now() − pipelineStartMs` **once**, on act index 0
   (real wall time, not the injected deterministic clock);
2. prepends the disclosure item (a partial candidate is validated by the same
   `check-forays` gates, so it needs the same opening item);
3. calls `partialCandidate.ts:buildPartialCandidate`, which runs the **same**
   `finalize` over the items and slots finished so far — handed this run's
   **minted tier-2 segments and source rows** (`sourced.newSegments` /
   `sourced.newSegmentSources`), exactly as the whole-Foray input is (F-71).
   Without them the checker cannot resolve a segment that was cut from a
   transcript during the run and is not in `data/segments.json`: run 2 attempt
   4b's partial candidate reported five `unknown segment_id … — not in
   data/segments.json` errors and then "no resolvable segment items" while the
   final candidate, same items, resolved all five. The partial candidate must
   fail and pass on the same rules as the final record;
4. hands the result to `deps.onActReady`, which writes/rewrites
   `<out>/<slug>-<hash>.partial.json`.

Shape (`partialCandidate.ts:PartialCandidate`): `id`, `title`, `topic`, `summary`,
`status: "partial" | "complete"`, **`visibility: "private"`**, `authorId`,
`acts: [{index, title, status: "ready" | "pending"}]`, `slots`, `items`,
`runtimeSec`, `ttlA1Ms`, `builtAt`, `updatedAt`, `validation`.

Honestly noted in the module rather than hidden: some of `check-forays.mjs`'s
checks (D5's interquartile floor over segment durations, for one) are sized for a
whole Foray and **may read a short Act-1-only slice as a false failure** that the
same content clears once every act is in.

`ttlA1Ms` stays `null` on a **resumed** run whose `stitch` stage was checkpointed:
the stored items are returned and `stitchForay` is never called, so no act
boundary is ever timed. The resumed process did not take that long and the process
that did is gone; reporting a number measured from this run's start would be a
fiction.

`backend/src/generation/generationStatus.ts:readPartialCandidate(candidateDir,
forayId, requestingUserId)` is the read path a future HTTP handler would call. It
refuses to return a candidate whose `authorId` does not match the requester, and
never lists or globs by anything but the caller-named Foray id, so it cannot leak
the existence of another listener's in-flight generation. **There is no HTTP
server in this repo** — no express, no fastify, no router — so nothing calls it
today (§8.8).

---

## 4. Cross-cutting mechanisms

### 4.1 The budget guard

**Module:** `backend/src/cost/budgetGuard.ts`. Every `Anthropic*Builder` calls
`this.budgetGuard.checkAndRecord({userId, operation, provider, model,
estimatedUsd, sessionId})` **before** it calls out, so a run that exceeds a
ceiling stops inside the stage that crossed it. `runPipeline` adds no second
budget: two budget checks that can disagree is worse than one.

**Two independent caps:**

| Cap | Env var | Default | Enforced |
|---|---|---|---|
| Daily, per user | `DAILY_BUDGET_USD` | **$25.00** | always |
| Per Foray, per generation run | `EPISODE_BUDGET_USD` | **$10.00** | **only when the caller passes a `sessionId`** — which the batch driver now does |

**The per-Foray cap is live in the batch path** (was §8.10, F-54).
`generateForays.ts:generateOneCandidate` passes `sessionId: checkpointKey` into
`runForayPipeline`'s options, and `runPipeline` forwards `options.sessionId` into
every builder's `ctx`. The checkpoint key — the candidate's basename — is the right
value: one id per Foray, stable across a resume, and already the name a human reads
when a run stops. Before this branch nothing set it, so in the only path that
generates anything a runaway Foray was bounded by the daily cap alone.

`checkAndRecord` computes the tier from the operation name prefix
(`tier0`/`tier1`/`tier2`); **no generation operation is tier-prefixed**, so they
all score **tier 1**, whose cutoff fraction is **1.0** — the full daily budget.
The daily check is `spentToday + estimatedUsd > dailyBudgetUsd × 1.0` →
`BudgetExceededError`. The episode check, when a `sessionId` is present, is
`spentThisSession + estimatedUsd > episodeBudgetUsd` →
`EpisodeBudgetExceededError`.

**Where the defaults come from** (`config/env.ts`, the arithmetic written into the
file so it can be reviewed rather than guessed). Every builder meters
`estimatedInputTokens × in + MAX_OUTPUT_TOKENS × out`, so these are the numbers
the guard actually compares against:

```
§4.1 understand   2 haiku  (~500 in, 200/400 out max)      ≈ $0.004
§4.2 research     ≤3 haiku web-search calls
                  (3 searches @ $0.01 + 800 out max each)  ≈ $0.104
§4.3 spine        1 opus   (~3,000 in, 8,000 out max)      ≈ $0.215
§4.4 deepen       4 sonnet (~4,000 in, 4,000 out max)      ≈ $0.192
§4.7 narrate      36 beats × 2 writer (2,000 out max)
                       + 2 verifier (1,000 out max)        ≈ $2.808
§4.8 continuity   3 sonnet (~1,500 in, 500 out max)        ≈ $0.024
                                                    total  ≈ $3.35
```

Two things that estimate deliberately does **not** do: it does not assume the
≤ 1.5-calls-per-beat target (it assumes four narration calls per beat, close to
run 1's measured 4.2, because a budget sized for the target stops every run until
the target is met); and it bills `max_tokens` rather than tokens produced, exactly
as the guard does, so real spend lands well under it.

`EPISODE_BUDGET_USD = $10.00` is the top of §9.2's founder-approved ~$5–10/Foray
phase-1 range and ~3× the estimate. `DAILY_BUDGET_USD = $25.00` is two and a half
Forays at the per-Foray ceiling plus room for the enrichment pipeline. It **must**
be at least the per-Foray ceiling, or the episode cap would be unreachable and
every run would stop at the daily one instead.

**Validation.** `DAILY_BUDGET_USD` is schema-checked (finite, non-negative, ≤
`MAX_DAILY_BUDGET_USD = 1000`) and a present-but-malformed value **fails startup**
with a message naming only the variable, never the value. `EPISODE_BUDGET_USD`
still uses the lenient `readNumber` fallback — a deliberate, documented scope
boundary, not an oversight.

**`--budget-usd N`** (`generateForays.ts`) calls
`defaultBudgetGuard.setCaps({dailyUsd: N, episodeUsd: N})` for the process. Both
move together because generation calls score tier 1, so raising only the per-Foray
cap would just move the stop to the daily one. `setCaps` ignores a non-finite or
negative value — it can raise or lower a declared ceiling, never remove one.

**`BudgetStopError`** is thrown by `runPipeline.ts:timed`, not by the guard. The
guard's own message ("Daily budget exceeded for tier 1: spent $1.9970 + attempted
$0.0240 > cap $2.0000") is true, unactionable and stage-blind — it reads
identically whether it stopped the spine call or beat 23 of 31. `BudgetStopError`
adds the stage name, the spend so far, the cap, the scope (`daily` | `per-foray`),
and the resume hint:

```text
Budget stop in stage "narrate:2": the daily cap of $25.00 was reached (spent $24.9970; this call would have added $0.0240). Everything finished so far is checkpointed under "<key>", so a re-run restarts at this stage. Raise the cap with --budget-usd (or DAILY_BUDGET_USD) and re-run.
```

`findBudgetError(err)` walks the `cause` chain up to 8 levels (bounded, so a cause
cycle cannot hang the process on the way to reporting an error), because §4.4
wraps an act's failure in `ActDeepeningError` and would otherwise bury the dollar
figures one level down. This is F-04's real fix.

The batch driver prints a `BudgetStopError` **untruncated** — its message is the
whole point — and does **not** print the "checkpoint kept" line for it, because
the message already carries the resume instruction.

### 4.2 Checkpoint and resume

**Modules:** `backend/src/generation/checkpoint.ts` (interface, session,
fingerprint — no file access) and `backend/src/cli/checkpointStore.ts`
(`FileCheckpointStore`, the only code that opens a file).

The split is a rule, not a preference: `promptNoPersistence.test.ts` scans every
file in `src/generation/` for a persistence primitive, and the §4 stages must not
be able to write anything. The driver writes, and always did.

**What run 1 lost without this:** attempt 4 ran 2 h 35 m, made 103 model calls,
finished 22 of 31 beats, and discarded all of it when beat 23 failed a third time
(**F-17**). The driver's own resume key was the candidate *file*, which a failed
run never writes, so the re-run started again at the clarity check (**F-18**), and
the orchestrator's answer four times over was to hand the pipeline the previous
attempt's answers by hand and log it as an intervention (I-11, I-14).

**Keys:** `understand`, `research-shape`, `spine`, `deepen:<n>`, `source`,
`narrate:<n>`, `narrate:<n>:<slot>`, `stitch`. Deepening and narration are keyed
**per act**, which is what makes a beat-23 failure cost act 3's narration rather
than the Foray — and narration is additionally keyed **per slot** inside the act
(F-51), because `narrate:<n>` is only written when the whole act finishes, so a run
that died partway through act 1 used to re-pay for every page of it.

**Fingerprint** (`checkpoint.ts:checkpointFingerprint`): first 12 hex of
`sha1(prompt + "\n" + duration + "\n" + (topic ?? ""))`. Everything that changes
what a stage would produce is in it. The **author id deliberately is not** — two
founders generating the same prompt at the same duration are doing the same work.

**Discard rules:**

| Situation | Effect |
|---|---|
| No store, or no `checkpointKey` | `CheckpointSession.open` returns an inert session: nothing resumes, nothing is saved |
| The file is missing, unreadable, or malformed JSON | treated as nothing to resume; the run starts clean |
| `file.version !== CHECKPOINT_VERSION (1)` or `file.fingerprint !== fingerprint` | every stored stage is discarded — silently resuming a spine built for a different duration tier is a *wrong* Foray rather than a slow one |
| A stored stage fails its own schema on the way back in | that stage alone is dropped and re-run; a wrong resume is more expensive than a repeated one |
| A `save` throws | swallowed — a checkpoint that cannot be written must never fail a stage that succeeded |
| The candidate file is written | `checkpointStore.discard(key)` — the candidate is the resume record from then on |
| Outcome `rejected` / `needs-clarification` / `unresolved-topic` | discarded — terminal, a re-run would only reproduce it |
| Outcome `generated` but validation failed | **kept**, with the partial file — the stages are sound and the checkers refused the assembly, so a re-run should pay only for what it must |
| `--no-resume` | `discard(key)` before the run, forcing every stage to be rebuilt |

**Re-validation is the point, not ceremony**: a checkpoint file is JSON a person
can edit and a killed process can truncate. Every read goes through the same
schema the stage's own output is checked against. Two stages had no zod schema of
their own (§4.7's `WrittenAct[]`/`WrittenSlot` and §4.8's items are interfaces), so
`runPipeline.ts` declares `WrittenActSchema`, `WrittenSlotSchema` and
`StitchCheckpointSchema` rather than trusting them unparsed.

**New fields are `.default([])`, not required.** `SourceCheckpointSchema`'s
`sourcingTrace` and `newSegmentSources`, and every WS-H field inside a
`Tier2TraceRow`, are optional or defaulted, so a checkpoint written before those
fields existed still resumes rather than being discarded as malformed. The one
place a resumed value is deliberately *corrected* rather than replayed is
`deepen:<n>`, which goes through the idempotent argument cap (§3.5.3a).

**Write discipline** (`FileCheckpointStore.save`): the whole file is rewritten
through a temp file and a rename, because a run killed mid-write — precisely the
situation this exists for; see I-15, where the harness killed run 1's shell —
would otherwise leave a file that parses as valid JSON and is missing half a stage.

A resumed stage is recorded by `StageTimingLog.markResumed(name)` as
`{name, startedAt, ms: 0, resumed: true}` — present rather than inferred from
`ms: 0`, because a report that shows a 0 ms spine without saying why reads as a
broken measurement.

### 4.3 The shared JSON parser

**Module:** `backend/src/generation/parseWithRetry.ts`. Every real
`Anthropic*` class uses it. `backend/test/parseWithRetry.test.ts` fails if a
private `function parseWithRetry` reappears anywhere else under
`src/generation/` — **F-40**, because three builders written after the extraction
each carried a fresh private copy, so fixing F-39 in the shared file would have
fixed nothing in the narration stage.

Three mechanisms, in order:

1. **Fence strip.** One leading ` ```json ` / ` ``` ` and one trailing ` ``` ` are
   removed before parsing. Models ignore "no markdown fences" roughly half the
   time (**F-10**).
2. **Tail repair** (`parseOrRepairJson`). If the text does not parse, walk it
   tracking string state and bracket depth; close an unterminated string, drop a
   trailing comma, and append the missing `}`/`]` in reverse order. If the repair
   parses, use it; otherwise return the original so the caller reports the real
   failure. **F-39**: verifier call #34 of run 1 returned an object missing its
   final `}`, and the parse error was charged to the narration page as one of its
   three attempts.
3. **One metered re-ask.** If it still does not parse, the builder's `reask`
   closure re-sends the original prompt **plus the bad reply** plus one user turn:

   ```text
   Your previous reply was not valid JSON; reply with the JSON object only.
   ```

   Exactly one re-ask, then failure. **The re-ask is its own real API call** and
   is its own metered spend: every builder's closure calls
   `budgetGuard.checkAndRecord` with the same operation/provider/model/user and a
   fresh estimate **before** calling out. `parseWithRetry` has no guard and cannot
   meter it itself.

Error messages distinguish the three exits, and `cause` is set deliberately: when
the **re-ask itself** fails (transport, or a budget refusal inside the closure),
the message still leads with the original parse failure but `cause` is the re-ask
error — so a `findBudgetError`-style walker can see a budget refusal there rather
than have it buried in a string.

`parseLastJsonBlock` is the variant for the two web-search calls, whose model may
wrap its final JSON in prose around tool calls: it takes the **last** fenced block
if any exist, else the raw text, then delegates.

### 4.4 Usage tracking

`backend/src/generation/usageTracking.ts` — `recordUsage(response.usage)` is
called immediately after every real `messages.create`, summing `input_tokens` and
`output_tokens` into a module-level counter. `runForayPipeline` calls
`resetUsageTracking()` at the top and `getUsageTotals()` before finalize, and the
total becomes `meta.veracity.pipelineTokens`.

**Stated limitation, not hidden:** this is **one counter for the whole process**,
not one per run. That is correct today because `generateForays.ts`'s batch loop
runs one Foray's pipeline to completion before starting the next. It stops being
correct the day two pipeline runs execute concurrently in one process, at which
point the collector must become per-run.

Not every re-ask records usage: the writer's and verifier's `reask` closures call
`recordUsage(retryResponse.usage)`; the understander's, spine's, deepen's,
continuity's and researcher's do not — so a run with re-asks under-counts slightly.

### 4.5 Stage timing

`backend/src/generation/stageTiming.ts` — `measureStage(name, fn)` records
`{name, startedAt, ms}` from `Date.now()`, no estimate and no jitter, and never
swallows an error. `StageTimingLog` collects them in order and adds
`markResumed(name)`.

`finalizeForay` runs its own `StageTimingLog` over `build-record`,
`check-forays` and `check-narration`. `runPipeline` appends those to the
pipeline's own list with a `finalize.` name prefix, by mutating the same
`veracity` object `input.meta` already references, so one flat orderable list
covers both.

The module is explicit that this is **not** §6.3's generation-lead invariant:
nothing here runs progressively, so there is no lead to monitor and nothing
pretends to monitor one. It exists so that when a live system is eventually built
it has real per-stage numbers rather than guesses.

### 4.6 The stub builders and `--dry-run`

Two independent switches, often confused:

| Switch | Effect |
|---|---|
| **No `ANTHROPIC_API_KEY`** (`env.anthropicDryRun`) | Every `create*()` factory returns the **Stub** builder. Zero network, zero spend, deterministic fixtures. The batch driver prints `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty.` |
| **`--dry-run` flag** | The driver writes **nothing**: no candidate file, no `report.json`, no checkpoint (the store is not passed at all), no partial file. It still runs the whole pipeline. |

The two compose: a keyed `--dry-run` makes real calls and discards the output; a
keyless run without `--dry-run` writes a stub candidate to disk.

The stubs are **fixture generators, not content stand-ins**, and each is written
so that the structural machinery it feeds runs for real: the spine stub hits the
tier's counts and the exploration floor and emits unique claims; the deepen stub
emits both `account` and `argument` kinds so §4.5's argument branch is exercised;
the writer stub quotes out of the held document so the substring gate is live; the
researcher stub returns a passage that deliberately contains **no word of the
claim**, so it cannot pass the substring check while violating the purpose-overlap
rule; the verifier stub asserts the zero-source structural rule ran upstream.

Every stub still calls `budgetGuard.checkAndRecord` with `estimatedUsd: 0` and
`dryRun: true`, so the metering path is exercised too.

### 4.7 The test-drive relay transport

Run 1 was driven without an API key by pointing `ANTHROPIC_BASE_URL` at a local
relay (`scratchpad/relay/relay.mjs`), which received each request unchanged —
model name, `max_tokens`, the exact prompt the builder composed — parked it, and
returned whatever an orchestrator wrote back in the Messages API shape; one Claude
Code subagent answered each request at the matching tier
(`claude-opus-4-1 → opus`, `claude-sonnet-4-5 → sonnet`,
`claude-haiku-4-5 → haiku`). **Zero pipeline code changed for the transport**, and
nothing in `backend/` reads `ANTHROPIC_BASE_URL` — the SDK does. Token counts on
that path are estimates (chars ÷ 4), wall times include human-paced orchestration
turns, and the interventions it required (I-03, I-06, I-07, I-09, I-10, I-17,
I-19, I-20) are logged in `docs/curation/generation-run-2026-09-09.md` §1b. Read
that document for what the relay proves and what it does not; it is not a
production path.

---

## 5. Quality gates

Four independent gates, in the order a Foray meets them.

### 5.1 `tools/foray/check-forays.mjs` — the publish gate on the data

No network, no dependencies, no build step: it runs from a bare checkout in a
keyless Action. It imports `backend/src/copy/rules.js` (the banned-phrase list),
`player/foray-queue.js` (`narrationDuration`, `NARRATION_CHARS_PER_SEC`,
`JINGLE_DURATION_SEC`) and `check-narration.mjs` (`MODE_CHAR_BANDS`, for the
six-mode enum) rather than re-declaring any of them — a second copy is how two
gates come to disagree. **Errors fail; warnings never fail.**

#### 5.1.1 Registry and shape rules

- `data/forays.json` and `data/segment-sources.json` must be `version: 1` with an
  array; anything else is a hard stop before any Foray is examined.
- Every source needs a non-empty `show`, `title`, `audio_url`, `audio_type`, a
  positive `duration_sec`, and a **boolean `dai_suspected`** (a missing flag reads
  as falsy and it gates seek precision).
- `audio_url` must be `https://` and must not look tokened
  (`token|auth|api_key|secret|password|session` in the query string).
- Every `item_id` the pool refers to must exist in the registry, or nothing can
  resolve its audio.
- A source's `duration_sec` must agree with any segment's `reference_duration_sec`
  to within **2 s** — two independent measurements of the same episode
  disagreeing means the wrong episode is registered.
- Foray ids unique; `kind` must be `"deep-dive"`; `status` must be `"draft"` or
  `"published"`; `topic` must be a non-empty string **and a real
  `data/taxonomy.json` node**; `slots` ids unique.

#### 5.1.2 Copy rules

Applied to `title`, `summary` and every slot `title` — the fields a UI renders as
4a's own prose (publisher episode titles in the registry are quoted fact and are
deliberately not gated):

- **≤ `MAX_WHY_LINE_WORDS = 18` words** each;
- none may match any pattern in `backend/src/copy/rules.js:BANNED`:
  `/fascinat/i`, `/deep[\s-]dive/i`, `/delve/i`, `/\bexplores?\b/i`,
  `/you won'?t believe/i`, `/fits? your drive/i`, `/your commute\b/i`,
  `/-min(ute)? drive/i`.

The Foray **title** the pipeline mints is `subject[: angle]` truncated to 120
characters — which can be well over 18 words. See §8.7.

#### 5.1.3 Generated-Foray-only rules — gated on `generated: true`

`isGeneratedForay(foray)` requires the explicit `generated === true` bit, rather
than inferring "generated" from shape: a curated Foray may carry narration too
(§1.2's admin backdoor), and it must not be held to §4.7's disclosure requirement
or §2.1's mode enum.

| Rule | Behaviour |
|---|---|
| **The disclosure is `items[0]`** | Checked on the raw first item, ahead of and independent of the resolve loop, so a malformed disclosure cannot hide behind a different failure. It must be `type: "narration"` with a `script` matching `DISCLOSURE_RX` — the §4.7 template **as a whole line**, with only `<subject>` wild: `This is a Foray about … . Much of what you'll hear is written by AI. We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source.` A paraphrase fails. |
| **Script or asset, never neither** | A narration item with no `script` and no `audio_url`/`asset` is a hard failure — "a generated Foray's narrator must always say something". |
| **`mode` is mandatory** | Every narration item must declare one of the six modes. (A *present* `mode` is enum-checked on **any** Foray; requiring it to exist applies only to a generated one.) |

The single producer of the disclosure string is
`types/narration.ts:disclosureTemplate(subject)`, and
`backend/test/disclosureTemplate.test.ts` round-trips it against `DISCLOSURE_RX`
so the two cannot drift. `runPipeline.ts:disclosureItem` wraps it as
`{type:"narration", id:"disclosure", script, mode:"marker", slot:<first slot id>}`
— it carries a slot, and must, because an item that opens a Foray has no preceding
item to inherit one from and the checker rejects that case explicitly.

#### 5.1.4 Per-item rules

- **Narration:** an `id` is required and must be unique within the Foray; a
  present `duration_sec` must be a positive finite number; a `slot`, if declared,
  must be in `slots`, and an item that **opens** the Foray must declare one;
  neither a `duration_sec` nor a `script` is a hard failure (nothing could say how
  long it is, so it would run for real seconds and count as zero everywhere); a
  `script` under **`NARRATION_MIN_CHARS = 50`** characters is a placeholder, not a
  bridge (the floor is on the *script*, never on a measured duration); an asset
  URL, when present, gets the same https/tokened checks.
- **Jingle:** `id` optional but, if present, non-empty and unique. It occupies the
  clock at `JINGLE_DURATION_SEC` but is **not** a segment start.
- **Segment:** `segment_id` must resolve in `data/segments.json`; a segment may
  not appear twice; `slot` must be declared; `label`, if present, must be unique
  and consistent with `label_prefixes`; `role`, if present, must be in the L6 enum
  and must not disagree with the segment's own.

#### 5.1.5 Duration ceilings and the two clocks

- Narration **hard max 180 s** (`NARRATION_HARD_MAX_SEC`) — an error, and the item
  is dropped from the clock so one bad `duration_sec` cannot cascade into a
  spurious runtime drift and a D1 failure.
- Narration **soft max 150 s** (`NARRATION_SOFT_MAX_SEC`) — a warning: "it should
  state what the extra minute does". Both numbers are narration-craft §0's own for
  its longest mode; they live on the gate rather than in the player, because
  refusing an over-long bridge at playback would turn an authoring mistake into a
  silent gap in a listener's ear.
- **`tapeRuntime`** = the sum of the segments. Every per-segment rule measures
  against it.
- **`runtime`** = tape + narration + jingles — the listener's clock, what
  `runtime_sec` must match to within **0.5 s**, and what sets D1's band.
- **D1's start list is built on the listener's clock**: a narration item's
  *duration* advances the 600 s window, but a narration item **is not a segment
  start**. The file argues the ruling at length: §5c caps *segment* starts; the
  mechanism is the re-orientation cost of an unfamiliar voice, and the narrator is
  the cheapest transition available, not another instance of the expensive one;
  narration is already budgeted separately and more tightly by narration-craft §0.

#### 5.1.6 The ordering rules

| Rule | Constant | Check |
|---|---|---|
| **D1** | `D1_WINDOW_SEC = 600`; budget **8** for a Foray ≤ 45 min, **6** for ≤ 120 min, **5** above | at most *budget* segment starts in any rolling 600 s window |
| **D2** | 60 s / 150 s | at most 2 consecutive segments under 60 s, and the next must be ≥ 150 s. Walked as **runs**, so a run of three is reported once and a Foray *ending* on two short segments still fails |
| **D3** | `D3_MEAN_FLOOR_SEC = 90` | mean segment duration ≥ 90 s |
| **D4** | `D4_QUOTE_SHARE_MAX = 0.2`, `D4_ADJACENT_QUOTE_MAX = 2` | quote share and adjacency — **skipped with a warning unless every item records a `role`** |
| **D5** | `D5_TOLERANCE = 0.2`, `D5_IQR_FLOOR_SEC = 45` | no 3 consecutive durations within ±20 % of each other (**pairwise** reading: `max/min ≤ 1.2`), and the interquartile range (R-7) of segment durations ≥ 45 s. The mean-deviation reading is computed and reported as a **warning**, not gated |
| **L2/L3/L4** | `ROLE_FLOOR_SEC {quote 30, explanation 60, exchange 75, narrative 120}`, `ROLE_MAX_SEC {quote 90, explanation 360, exchange 480, narrative 480}`, `L4_SOFT_MAX_SEC = 240` | per-role floors and ceilings; past 240 s a segment needs `needs_review: true` **and** a `long_reason`. **Skipped entirely when `role` is absent** |
| **M3** | — | segments from one episode never play out of chronological order |
| **M4** | `M4_SHARE_MAX = 0.25` | no one episode over 25 % of **segments** or of **tape runtime**. The denominator is tape, deliberately: dividing by the listener's clock would let a Foray buy its way under the cap by adding narration |
| slots | — | slot blocks must be contiguous and in the declared order |
| audio | — | a `dai_suspected` source fails every segment of that episode; `end_sec` may not exceed the episode's `duration_sec + 2` |

**Tier-2 tape resolves here now.** The checker itself is unchanged; what changed is
the *pool it is handed* — `finalizeForay` merges this run's minted segments and
their episode rows into the files it passes in (§3.10), so a tier-2 `segment_id`
resolves, its seconds land on the listener's clock, and every ordering rule sees
the item. `tools/foray/check-forays.test.mjs` pins both halves and the two failure
messages that appear when either row is missing.

**What this means for a generated Foray today:** `forayItems.ts:toForayItem` emits
no `role` and no `label`, so **D4 is warned-not-evaluated and L2/L3/L4 never run**.
The rules that bind are the shape rules, the disclosure, D1, D2, D3, D5, M3, M4,
the copy rules and the runtime agreement. **M4 is the one that actually bit**:
finding F-08 records a keyless stub run failing `M4 FAIL: one show is 30.9 % of
runtime, over the 25 % cap` — the gate doing its job on a 212-row pool that
concentrates on few shows.

The report block per Foray carries `segments`, `runtime_sec`, `tape_runtime_sec`,
`narration_items`, `narration_unvoiced`, `narration_sec`, `jingle_items`,
`jingle_sec`, `narration_share`, `mean_sec`, `d1_budget`,
`d1_max_starts_in_window`, `d5_iqr_sec`, `d5_pairwise_violations`.
**`narration_share` is reported, never gated** — narration-craft's 25 % target and
35 % ceiling are that document's own invention, and it says the ratio is "a
symptom, not a budget".

### 5.2 `tools/foray/check-narration.mjs` — and what it can actually prove here

This validator gates the **curation artifacts** under
`docs/curation/narration/<foray_id>/{arc.json, threads/, beats/}` — where a script
exists before it becomes a `data/forays.json` item.

**The automated pipeline never writes those files.** `writeNarration.ts` produces
`WrittenAct[]` in memory and hands it straight to `stitchForay.ts`, which maps it
directly into `ForayItem[]`. So calling `checkNarration(root)` from
`finalizeForay` validates whatever **other** Forays' curation artifacts already
exist on disk — it is not, and structurally cannot be, a check of this Foray's own
narration content, because this Foray has no `docs/curation/narration/<id>/`
directory. `finalizeForay.ts`'s own doc comment states this plainly rather than
implying an audit it never performed. Today no such artifacts fail, so the call
contributes no errors.

What it *would* enforce, for the record, and the shared constants it owns:

- `MODE_CHAR_BANDS` (lowercase keys) — the table `types/narration.ts` mirrors and
  `backend/test/narration.test.ts` cross-checks (§3.8.7).
- `NARRATION_CHARS_PER_SEC = 17`, `NARRATION_SOFT_MAX_SEC = 150`,
  `NARRATION_HARD_MAX_SEC = 180`.
- **N6**, the anti-hallucination rule: every number token in a claim must appear
  inside a span somebody fetched.
- **N5**, the tier floor: a claim whose text carries a digit or a superlative is
  tier 2 whatever it declares, and a tier 2 claim **may never rest on inference**.
- **Ruling 3's leak check** (`REFERENCE_LEAK_RE`): no URL, `wikipedia`, `et al`,
  `according to`, `doi`, `ibid`, `op. cit.`, `as cited`, `cites`, `citation`, a
  bare domain, or `p./pp. N` may reach a spoken line.
- **§5d**: no digit in a spoken line (numbers are written as spoken); mean
  sentence length 12–15 words; longest sentence ≤ 25 words; a rhythm rule
  requiring one sentence under 6 words in any beat over 20 s; at most
  `NUMERIC_FACTS_PER_ITEM_MAX = 3` numeric facts per item.
- `BANNED_HEDGES` (`some say`, `it is believed`, `many historians believe`,
  `legend has it`, `it is often said`, `experts think`, `some argue`,
  `it is thought that`), `BANNED_ADJECTIVES` (`remarkable`, `fascinating`,
  `surprising`, `extraordinary`, `striking`, `deep dive`, `delve`) and
  `BANNED_OPENERS` (`it turns out`, `as it happens`, `interestingly`,
  `of course`, `now` — sentence-initially only).
- **N16/N17**: at most `NARRATION_ITEMS_PER_THREAD_MAX = 2` narration items per
  thread, and the second of two consecutive must be shorter.
- **N22/N23**: one establisher per key, and every assumed key must be established
  earlier or declared as a `requires` start criterion.

Two of these overlap the generated path but are enforced elsewhere: the mode
character bands by `validateNarratedBeat` (§3.8.6), and the banned-phrase list by
`copy/rules.js:BANNED`. The digit rule, the reference-leak rule and the sentence
rules are **not** applied to generated narration at all — see §8.9.

**Neither checker was changed for F-51, deliberately.** An unverified page
(§3.8.10) passes both untouched: this one never sees the candidate, `check-forays.mjs`
reads no `verified` field (`grep -n verified tools/foray/check-narration.mjs` is
likewise empty), and `forayItems.ts` does not emit one into a published item — its
internal-field-leak guard covers that. So the only thing between an unverified page
and a listener is the veracity gate (§5.5), which is exactly where F-51 put the
decision; teaching a checker about `verified` would move it back into a gate that
cannot see the metric. Recorded at `finalizeForay.ts`'s `check-narration` call site.

### 5.3 The spine structural gate

`spineStructure.ts:assertSpineStructure`, run between §4.3 and §4.4. Full rule
list in §3.3.3.

### 5.4 The veracity metrics

`backend/src/generation/veracityMetrics.ts:buildVeracityMetrics`, computed by
`runPipeline` **before** finalize, so `meta.veracity` rides on every candidate the
function returns — including one that fails the checkers, which
`generateForays.ts` still records in `report.json`.

Every metric reads only what the pipeline already produced. Nothing is re-judged
and no new model call is made. **`null` never means "fine"** — the module's own
framing: run 1's whole postmortem is a catalogue of "nothing checks X, so X reads
as fine", and a metric that quietly reported 1.0 for an unmeasured claim would be
the same bug wearing a metrics hat.

| Metric | Definition | `null` means |
|---|---|---|
| `groundedQuoteRate` | over every page that carries an `evidence` array: the share of its `sources[].quote` values that are whitespace-normalised substrings of one of that page's held documents | **no page in the candidate carries evidence at all** — nothing could be checked. A quote on a page with no evidence is *uncheckable*, not ungrounded: it is excluded from both numerator and denominator |
| `groundedQuoteCounts` | `{checkable, grounded}` — the raw numerator and denominator | — |
| `ungroundedPages` | one entry per page with at least one ungrounded quote: `{claim, mode, reason: "ungrounded-quote", detail}` naming up to two offending spans | — |
| `attributionStability` | over pages with ≥ 2 recorded attempts: the share of claims recurring across attempts whose `publication` never changed (**F-32**) | nothing had two attempts with a matching claim to compare — an absence of the test, not evidence of stability |
| `purposeFidelity` | the average of `NarratedBeat.purposeAccomplished` — the verifier's second question (**F-41**) | no page carries the field. Deliberately **not** `verified`, which is trivially `true` on every kept page and would print 1.0 forever. Read this as a **regression alarm**: below 1.0 means the question stopped being asked or stopped being enforced |
| `tapeRelevance` | the share of tape anchors sharing a taxonomy family with the Foray's resolved topic. Computed from §4.5's own `TapeRelevanceInput` rows when present — the gate must be scored on what the gate saw — else re-derived from disk by a coarser root-segment join | either there are no tape anchors at all (`tapeRelevanceAnchors` empty), or anchors exist but **none** resolved. The publish gate treats those two cases differently |
| `tapeRelevanceAnchors` | every anchor as `{itemId, claim, onTopic, families}`, for human spot-check | per-anchor `onTopic: null` = neither signal resolved |
| `firstAttemptPassRate` | share of **kept** pages with `attempts.length === 1`. Honest scope: a connective page dropped after 3 failures never reaches the written acts, so its 0-for-3 record is invisible here — `pagesDropped` counts those separately | no page carries `attempts` |
| `callsPerBeat` | `(writerCalls + verifierCalls) / attemptedPages`, where attempted pages are recomputed deterministically from the sourced acts (every narration beat plus every tape beat `decideConnectiveNarration` assigned a mode). Per *page*, despite the name — kept for comparability with run 1's 4.2 | zero attempted pages |
| `narrationCallsPerBeat` | **G-34.** The same request count over **every** beat in the sourced acts, tape and narration alike — the denominator the fix plan's ≤ 1.5 target is stated over | zero beats |
| `narrationCalls` | **G-34.** `{writer, verifier}` — the raw request counts both rates are made from. A merged select+prose call is one writer request | — |
| `retryRounds` | **G-34.** How many times a slot went back to the writer after its first round, summed over the run — the number the retry tax is paid in. Counted by `writeNarration` itself (`NarrationWriteStats`), not by the request proxies, which cannot tell a round from a call | the caller did not thread `stats` through (older callers) — reported as `null`, never guessed as zero |
| `pagesDropped` | connective pages `decideConnectiveNarration` asked for that are absent from the final acts. Recomputed from the sourced acts with the same pure function the pipeline used, because a dropped page and a page never wanted look identical in the output | — (an integer) |
| `unverifiedPages` | **F-51.** How many kept pages carry `verified: false` — a page the verifier refused three times, a page no prose call ever produced (`no-page`), or a page with no evidence to write from (`no-evidence`). **Read the count, not a rate**: one is a stop, so there is nothing for an average to say, and unlike `pagesDropped` each of these is a page a listener *would* hear, carrying an objection somebody has to answer | — (an integer) |
| `unverifiedPageDetails` | the same pages as `FailingPage` rows — `{claim, mode, reason: "unverified-page", detail}`, the detail being the verifier's note (first 200 chars) or the recorded attempt count — so the gate can print which ones | — |
| `purposeRevisedPages` | **F-50.** How many pages corrected their purpose from the evidence: the writer said so, the verifier said so, or both (`types/narration.ts:purposeWasRevised` is the one definition of that disjunction). **Reported, never gated** — a page that reports a contradiction between its brief and its documents is the most valuable thing evidence-first narration can produce. It exists so an editor can *find* those pages, and so a deepen stage that keeps writing purposes the evidence contradicts shows up as a rising count rather than as a dead run | — (an integer) |
| `pipelineTokens` | sum of every reply's `usage` for this run (§4.4) | — |
| `stageTimings` | the pipeline's stage list plus `finalize.*` | — |

### 5.5 The publish gate

`veracityMetrics.ts:evaluateVeracityGate`, called by
`backend/src/cli/publishForay.ts` **after** `finalizeForay` passes and **before**
anything is written:

| Threshold | Constant | Value |
|---|---|---|
| `groundedQuoteRate` | `GATE_MIN_GROUNDED_QUOTE_RATE` | **1** (every quote must be grounded) |
| `purposeFidelity` | `GATE_MIN_PURPOSE_FIDELITY` | **0.8** |
| `unverifiedPages` | — | **0**, absolute (F-51) |
| `tapeRelevance` | `GATE_MIN_TAPE_RELEVANCE` | **0.9** |

- A missing `meta.veracity` **fails**: "groundedQuoteRate/purposeFidelity/tapeRelevance
  were never computed".
- **`null` fails** for `groundedQuoteRate` and `purposeFidelity` — unmeasured is
  not passing.
- **Any `unverifiedPages` fails.** Not a floor — one such page refuses the whole
  candidate: *"N page(s) were kept without passing verification — a page that never
  satisfied the verifier is not publishable (F-51)"*, with each
  `unverifiedPageDetails` row printed beneath as `  [mode] claim — detail`. It is
  listed **before** the tape check because it is the most concrete failure in the
  set: not a rate below a floor, but a specific page with a specific unanswered
  objection. §3.8 now finishes a Foray that contains one rather than throwing the
  Foray away, and this is the only thing standing between that page and a listener
  — neither checker reads `verified`, and `forayItems.ts` does not emit it into a
  published item (§5.2, and the note at `finalizeForay`'s `check-narration` call
  site).
- `purposeRevisedPages` is **reported and never gated**.
- `tapeRelevance` gets one exception: a candidate with **no tape anchors at all**
  has nothing to judge and does not block. A candidate **with** anchors where none
  resolved **does** block — that is a real "cannot confirm" gap, not an absence of
  tape.
- Failures print one line each, with the specific failing pages (mode, first 80
  chars of the claim, the detail) or off-topic anchors (item id, families, claim)
  indented beneath.

**`--force`** overrides the veracity gate **only**. It does not skip
`check-forays.mjs` or `check-narration.mjs`, which have no override, and the
override plus its specific failures are written into the PR body:

```text
**WS-B veracity gate overridden with --force.** Failures at publish time:
- <failure>
```

---

## 6. Outputs and storage

### 6.1 The candidate file

Written by `generateForays.ts` to
`<out>/<slug>-<hash>.json` **only when `outcome === "generated"` and
`validation.ok`**, as pretty-printed JSON with a trailing newline. It is exactly
`runPipeline`'s `outcome.input`, i.e. `finalizeForay.ts:FinalizeForayInput`:

```jsonc
{
  "id":         "how-engineering-disasters-actually-happen-a1b2c3",
  "title":      "<subject[: angle]>, ≤ 120 chars",
  "topic":      "engineering/disasters",
  "summary":    "<intent.subject>",
  "slots":      [{ "id": "the-first-decision", "title": "The first decision" }],
  "items":      [ /* ForayItem[] — see below */ ],
  "runtimeSec": 3512.412,
  "builtAt":    "2026-09-09T04:11:02.145Z",
  "meta": { "veracity": { /* §5.4 */ } },
  "segments":       [ /* NewSegment[]          — this run's tier-2 cuts */ ],
  "segmentSources": [ /* MintedSegmentSource[] — their episode registry rows */ ]
}
```

`segments`/`segmentSources` are present (and usually empty) on every candidate.
They are what makes a tier-2 anchor publishable: `finalizeForay` merges them into
the pool and registry it validates against (§3.10) and `publishForay` commits them
(§6.5). Nothing else in the candidate refers to them — a tier-2 tape item is an
ordinary `{type: "segment", segment_id}` row.

**Filename** (`generateForays.ts:candidateFilename`):
`slug(prompt).slice(0,40)` + `-` + first 8 hex of `sha1(prompt)` + `.json`. It is
the **outer resume key**: a prompt whose candidate file exists is skipped.

**Item types** (`forayItems.ts`, all `.strict()`):

```jsonc
{ "type": "segment",   "segment_id": "...", "slot": "...", "label"?: "...", "role"?: "quote|explanation|exchange|narrative" }
{ "type": "narration", "id": "...", "script": "...", "mode": "hinge|frame|marker|correction|patch|carry", "slot"?: "..." }
{ "type": "jingle",    "id"?: "..." }
```

The pipeline emits `label` and `role` never, and `slot` always.

**`meta.veracity` is not read by `finalizeForay` and is not written into the
published record.** It rides on the candidate purely so the file on disk carries
it and `publishForay.ts` can read it back to gate the PR.

### 6.2 The partial candidate file

`<out>/<slug>-<hash>.partial.json` — the same slug and hash, so a reader can find
both without a lookup table (`generateForays.ts:partialCandidateFilename`).
Rewritten on **every** act. Shape in §3.11: `status: "partial" | "complete"`,
**`visibility: "private"`**, `authorId`, `acts[].status`, `ttlA1Ms`, `validation`.

Deleted wherever the checkpoint is deleted, and kept wherever the checkpoint is
kept — the two answer the same question ("is there more to do for this prompt?")
and must not disagree. On success it is deleted once the candidate exists: its job
is done, and leaving it would be a second, staler copy of the same content.

Never written under `--dry-run`, and never written on a resumed run whose `stitch`
stage was checkpointed (the callback fires from inside that stage).

### 6.3 `report.json`

Written to `<out>/report.json` at the end of every non-dry run:

```jsonc
{
  "generated_at": "2026-09-09T05:41:00.000Z",
  "dry_run": false,
  "entries": [
    {
      "prompt":   "<the prompt>",
      "outcome":  "generated" | "rejected" | "needs-clarification" | "unresolved-topic" | "error",
      "detail":   "OK <id> (32 items, 3512.41s)" | "INVALID <id> — <first 2 check-forays errors>"
                  | "REJECTED (<category>) — <explanation>" | "AMBIGUOUS — <question>"
                  | "NO TOPIC — nearest: a, b, c" | "<error message>",
      "ms":       <sum of every stage's ms>,
      "file":     "<absolute path>",       // only when a candidate was written
      "ttlA1Ms":  <number | null>,
      "veracity": { /* §5.4 */ }           // present for every "generated" outcome
    }
  ]
}
```

`veracity` is present even for a candidate that **failed** validation, so a
reviewer can see why the numbers looked the way they did rather than only for
candidates that made it to disk.

The closing summary counts what actually happened: `publishable` is the number of
entries whose `detail` starts with `"OK "`, not the number tagged `generated` — a
run that reached §4.9 and failed validation still carries `outcome: "generated"`,
and the first end-to-end run printed "0 did not produce a Foray" while producing
zero publishable candidates.

### 6.4 The checkpoint file

`<out>/<candidate-basename-without-.json>.checkpoint.json`:

```jsonc
{
  "version": 1,
  "key": "how-engineering-disasters-actually-a1b2c3d4",
  "fingerprint": "9f2c1ab30de4",
  "updatedAt": "2026-09-09T04:02:11.900Z",
  "stages": {
    "understand": { ... }, "research-shape": { ... }, "spine": { ... },
    "deepen:0": { ... }, "deepen:1": { ... },
    "source": {
      "acts": [...], "newSegments": [...], "newSegmentSources": [...],
      "transcriptionQueueCandidates": [...], "tapeRelevance": [...], "sourcingTrace": [...]
    },
    "narrate:0:0": { "title": "...", "beats": [...] },
    "narrate:0:1": { ... },
    "narrate:0": { ... }, "stitch": { "items": [...] }
  }
}
```

A finished act's `narrate:<n>` supersedes its own `narrate:<n>:<slot>` keys — the
per-slot ones are written first and are never consulted again once the act key
exists (§3.8.11).

Rules in §4.2. It sits beside the candidate the same prompt will eventually
produce, so a human can see which prompt a half-finished run belongs to.

### 6.5 The publish path

`npm run publish-foray -- --input <candidate>.json [--dry-run] [--no-hold] [--force]`
(`backend/src/cli/publishForay.ts`), in order:

1. `finalizeForay(input)` — the same two validators. **On failure: print every
   error, exit 1. Nothing written, no branch, no commit, no PR.**
2. Warnings printed; the veracity gate evaluated (§5.5). Refusal exits 1 unless
   `--force`.
3. `--dry-run` prints the record and stops.
4. Otherwise: append `forayRecord` to `data/forays.json` and write it back
   pretty-printed with a trailing newline.
4a. **Append this run's tier-2 tape**, if any: each minted segment
   (`mintedSegmentRow`, the same producer `finalizeForay` validated against) to
   `data/segments.json`, and each episode row to `data/segment-sources.json`, both
   skipping ids already on disk (a committed row is the authority). Publishing the
   Foray without them would ship a `segment_id` no reader can resolve — the same
   "unknown segment_id" failure, moved from the checker to the player. Written in
   the same commit so the three files are never out of step. Each write prints its
   own line (`Wrote data/segments.json (+N tier-2 segment(s), flagged needs_review).`).
5. `git switch -c generate/<foray id>`, `git add` **every file actually written**
   (`data/forays.json`, plus `data/segments.json` and `data/segment-sources.json`
   when tier-2 tape was minted),
   `git commit -m "Generated Foray: <title> (<id>)"`, `git push -u origin HEAD`.
6. `gh pr create --base main --title "Generated Foray: <title>" --body <body>` —
   **never a direct commit to main**.
7. Unless `--no-hold`, `gh pr edit <url> --add-label hold`. `automerge-nightly.yml`
   would otherwise auto-merge any green PR touching only `data/`; that path exists
   for machine-authored content whose failure mode is a red CI check, and a
   generated Foray's failure mode is prose a validator cannot judge. Phase 2 is
   the point where the hold comes off — not this stage.

**The published record** is `buildForayRecord`'s output (§3.10) — `id`, `kind`,
`title`, `topic`, `status: "draft"`, `summary`, `runtime_sec`, `generated: true`,
`slots`, `items`. It carries **no** `meta`, no veracity, no spine, no sources, no
evidence. Everything the pipeline knew about *why* a page says what it says lives
in the candidate file and the report, never in `data/`.

### 6.6 What the app reads at runtime

`app.js` fetches exactly three files (`app.js:7067–7069`): `data/forays.json`,
`data/segments.json`, `data/segment-sources.json` — "the order lives in
data/forays.json, the timestamps in data/segments.json, the audio in
data/segment-sources.json; the join, the queue and the position maths all" follow
from those three.

It therefore reads **nothing** the generation pipeline produces except a published
`forays.json` entry. It does not read candidates, partial candidates, reports,
checkpoints, the evidence cache, transcripts or the corpus. A generated Foray is
indistinguishable to the player from an authored one except for the `generated`
bit and the disclosure item — which is the whole point.

---

## 7. Operating the pipeline

Every command runs from `backend/` (the scripts are declared in
`backend/package.json` and run through `tsx`; there is no build step required).

### 7.1 The batch driver

```
npm run generate-forays -- --prompts <file>.json
                          [--out data-local/foray-candidates]
                          [--duration short|medium|long]
                          [--limit N]
                          [--author <id>]
                          [--budget-usd N]
                          [--no-resume]
                          [--dry-run]
                          [--max-resumes N]
                          [--continue-on-refused-partial]
                          [--notify <command>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--prompts` | *(required)* | A JSON **array**, either of strings or of `{prompt, duration?, topic?}` objects. `topic` pins the taxonomy node by hand and skips resolution. Anything else throws with the index that failed. |
| `--out` | `data-local/foray-candidates` | Where candidates, partials, checkpoints and `report.json` are written. Created if missing. |
| `--duration` | **`short`** | Applies to any prompt that does not carry its own. Note the default is `short`, not `medium`. |
| `--limit` | none | Take only the first N prompts. Ignored unless a positive finite integer. |
| `--author` | `founder-1` | Becomes `author_id` on the request, `userId` on every budget event, and `authorId` on the partial candidate. |
| `--budget-usd` | none | Re-caps **both** the daily and the per-Foray ceiling for this process (§4.1). Ignored unless positive and finite. |
| `--no-resume` | off | Delete any checkpoint for each prompt before running, forcing every stage to be rebuilt. |
| `--dry-run` | off | Run the pipeline and write **nothing** — no candidate, no partial, no checkpoint, no report. |
| `--max-resumes` | **`3`** | G-30: how many times one prompt resumes itself from its checkpoint after a *transient* failure before the driver records `resumes-exhausted`. `0` restores the single attempt. |
| `--continue-on-refused-partial` | off | G-30: carry on past an act whose partial candidate failed `check-forays`. Off, the run **aborts** with reason `refused-partial` (D4's interim policy). |
| `--notify` | `GENERATION_NOTIFY_CMD`, else none | G-30: a shell command run with a one-line summary at each prompt's end, at the batch's end, and on a crash. The flag wins over the environment variable. |

#### 7.1.1 Hands-free runs (G-30)

The latency brief's §4 counted every step a person did by hand during a run;
the roadmap's rule is that each one is a defect. The driver now does five of
them itself, and records what it did in `report.json` so nothing it decided
alone is invisible afterwards. All of it works on the test-drive relay
(`ANTHROPIC_BASE_URL` → local relay) as well as keyed: the relay's failure
shape — `Request timed out.` after the answering session dies (I-27) — is the
first thing the resume loop was written against.

**Self-resuming (manual step 9).** A pipeline failure is classified before
anything else happens. *Transient* — a transport timeout, `Connection error.`,
`ECONNRESET`/`ECONNREFUSED`/`socket hang up`, an HTTP 408/429/5xx (checked as a
number on the error, never as digits in prose), an `overloaded` or rate-limit
reply, wrapped at any depth in `cause` — is resumed from the same checkpoint
in-process after a backoff of 30 s, 60 s, 120 s … (capped at 10 min), up to
`--max-resumes` times. The `retry` line names the attempt, the wait and the
reason. A resumed attempt pays only for the stages that had not finished, as
any re-run did before; the difference is that nobody has to type it.
Everything else — a bug, a bad fixture — is still one `ERROR` line and no
retry: repeating a deterministic failure three times is three times the cost.

**Budget window (manual step 26).** A *daily* `BudgetStopError` counts as
resumable: the driver sleeps until the next local midnight plus a minute (the
window `BudgetGuard` sums against) and resumes. A *per-Foray* stop is not — the
same Foray would trip it again — and ends the prompt with reason `budget-stop`.
Raising a cap stays a decision, not a retry.

**Refused partial (manual step 10).** WS-D2 already validates every act's
partial candidate with `check-forays`. By default a refused act now ends the
run from inside the `stitch:<i>` stage with a `RefusedPartialError` naming the
act and the checker's errors — after the partial is written (it is the
evidence) and before that act's stitch is checkpointed (so a re-run rebuilds
it). The entry reads `ABORTED (refused-partial) — …`. With
`--continue-on-refused-partial` the run carries on to the whole-Foray finalize
and the entry's `refusedPartials` lists the act indices that were refused on
the way, whether or not the finished Foray then passed. Abort-vs-continue as a
*policy* is D4's; this is the interim default.

**Notification (manual step 24).** `--notify <command>` (or
`GENERATION_NOTIFY_CMD`) is run through the shell with one line —

```text
foray-generation built id=beyond-the-algorithm-e6533b minutes=40.3 calls=51 — OK beyond-the-algorithm-e6533b (51 items, 2421s)
```

— on stdin and as `FORAY_NOTIFY_SUMMARY` (plus `_OUTCOME`, `_ID`, `_MINUTES`,
`_CALLS`, `_DETAIL`). It fires once per prompt (`built`, `invalid`,
`aborted:<reason>`, `error`, or a pipeline stop such as `no-tape`), once at
the batch's end (`batch-done`), and on a crash (`crashed`). A hook that fails
or hangs (60 s) is recorded, never thrown: its `exitCode`/`error` land in the
entry's `notification` and the report's top-level `notification`. It is a
shell hook and not a service on purpose — `gh issue comment N -F -`, a curl,
or `cat >> run.log` are all one line for the operator to choose.

**Duplicate id (manual step 25).** `runForayPipeline` reads the ids already
in `data/forays.json` *before* minting this run's id and suffixes a collision
`-2`, `-3`, … (`uniqueForayId`). The suffix is applied once, ahead of the first
partial candidate's own `finalizeForay` call, so neither that nor the final
validation can throw on the duplicate after the run has been paid for.
`finalizeForay`'s own throw stays as the last line of defence.

**What `report.json` records (G-30 e).** Top level: `max_resumes`,
`continue_on_refused_partial`, `resumes` (total automatic resumes), `aborts`,
`notify` (the command) and `notification` (the batch-end hook's result). Per
entry: `resumes[]` (`attempt`, `kind`, `reason`, `waitedMs`, `at`),
`abort {reason, detail}` when `outcome` is `aborted`, `refusedPartials[]`,
`calls` (model calls across every attempt) and `notification`. The `POLICY:`
line at the top of the log states the same three settings before the first
prompt runs.

The driver prints its mode before doing anything expensive — a run that silently
used stubs and produced 200 placeholder Forays would look exactly like a
successful run until someone listened to one:

```text
MODE: live — Anthropic builders, metered by BudgetGuard (daily $25, per-Foray $10).
MODELS: opus=claude-opus-5 sonnet=claude-sonnet-5 haiku=claude-haiku-4-5-20251001
```

or `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is
structurally real but editorially empty.` The `MODELS:` line exists because F-03
was found by reading source, which is not where a run's behaviour should have to
be looked up.

Per prompt it prints one line: `skip`, `resume` (naming the stages already done),
`built`, `stop`, `retry` (an automatic resume, §7.1.1), `ABORT` (a named
reason), or `ERROR`. **One prompt's failure never ends the batch** — a
rate limit or a budget stop on prompt 7 still leaves 1–6 on disk and 8 attempted.

### 7.2 Publishing

```
npm run publish-foray -- --input <candidate>.json [--dry-run] [--no-hold] [--force]
```

Semantics in §6.5. `--force` overrides the veracity gate only, and notes the
override in the PR body.

### 7.3 The §4.0–4.1-only CLI

```
npm run generate-foray -- --prompt "<text>" --duration short|medium|long [--author-id <id>]
```

`backend/src/cli/generateForay.ts` runs **only** safety/clarity/intent and prints
the result. It persists nothing. Exit codes: `1` rejected, `2` needs
clarification (distinct, because the caller should re-prompt rather than retry),
`0` understood. It predates the orchestrator and is kept as the prompt-capture
surface; it is not how a Foray is built.

### 7.4 Environment variables

Read through `backend/src/config/env.ts`, which loads the **repo-root `.env`**
first and then an optional `backend/.env.local` that overrides it. Values are
never logged; `envPresenceSummary()` reports booleans only.

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | **The one switch between stub and live.** Unset → every `create*()` returns a Stub, `$0`, no network. Set → the Anthropic builders. |
| `DAILY_BUDGET_USD` | `25.00` | Daily per-user cap. Schema-validated: finite, ≥ 0, ≤ 1000; a present-but-malformed value **fails startup**. |
| `EPISODE_BUDGET_USD` | `10.00` | Per-Foray cap — enforced only when a caller passes a `sessionId`, which the batch driver **now does** (the checkpoint key; §4.1). Leniently parsed. |
| `FORAY_MODEL_OPUS` | `claude-opus-5` | Override the id a tier resolves to. |
| `FORAY_MODEL_SONNET` | `claude-sonnet-5` | Same. |
| `FORAY_MODEL_HAIKU` | `claude-haiku-4-5-20251001` | Same. Pinned to a **dated snapshot** deliberately: it is the only tier whose alias still resolves to a 4.x model, and pinning makes "this is deliberately last-generation, not stale" reviewable — exactly what F-03 found missing. |
| `FORAY_MODEL_{OPUS,SONNET,HAIKU}_USD_PER_MTOK_IN` / `_OUT` | opus 5/25, sonnet 2/10, haiku 1/5 | Per-million-token prices for the budget estimate. **An id override does not change the price** — the guard would rather over-estimate against a cheaper substitute than under-estimate against a dearer one, so override the price alongside the id when it matters. |
| `FORAY_SKIP_CATALOGUE_CACHE` | unset | `=1` disables the per-process caches in `catalogueLookup`, `segmentPoolLookup`, `transcriptArchiveLookup`, `taxonomyFamily`, `audioSourceLookup` and `veracityMetrics`, for tests that mutate a fixture directory. |
| `ANTHROPIC_BASE_URL` | unset | Read by the **Anthropic SDK**, not by this repo. This is what pointed run 1 at the relay (§4.7). |
| `PODCASTINDEX_API_KEY` / `_SECRET`, `DATABASE_URL` | unset | Read by `env.ts`; **not used by generation**. |

**`NARRATION_CONNECTIVE_MODEL` does not exist.** WS-D1 proposed it ("optional
Haiku for Frame/Hinge/Marker behind `NARRATION_CONNECTIVE_MODEL`, default
unchanged"); nothing in `backend/src/` references it. Every narration call is
`sonnet`.

### 7.5 What needs a key, and what the machine needs

| Runs keyless | Needs `ANTHROPIC_API_KEY` |
|---|---|
| Safety check | Clarity and intent |
| Catalogue lookup and the tape-availability signal | External research and evidence retrieval |
| Topic resolution | The spine |
| Beat sourcing (both tiers, the transcript text index, the anchor maths, the topic gate, the audio-source lookup) | Act deepening |
| Stitching's within-act rules and the item mapping | Narration selection, prose and verification |
| `check-forays.mjs`, `check-narration.mjs`, the veracity metrics, the publish gate | Cross-act continuity |

**Machine requirements.** The generation machine must hold
`data-local/transcripts/normalized/` — it is gitignored and machine-local, so a CI
runner or a fresh clone has no transcript bodies and **tier-2 sourcing can never
fire** there: `NullTranscriptCueProvider` returns `null` for every episode and
`NullTranscriptTextIndex` returns no candidates and reports `enabled: false`, so
tier 2 falls back to the title path and stops at `no-body`. On this machine there
are 1,713 normalised bodies across 15 shows, and the text index writes its own
cache beside them under `data-local/transcripts/index/` (rebuilt automatically when
a body's mtime or size changes, so it never needs clearing by hand). Everything
else the pipeline reads is committed. Node with `tsx` (already a dependency) and,
for publishing, `git` and the `gh` CLI authenticated against the repo.

The founder's own plan (`C:\Users\wjduv\Desktop\4a-forays-in-app-plan.md`,
2026-09-08) states the same four requirements and records that three of them are
present on this PC and the key is the missing one.

---

## 8. Known gaps and open decisions

Ordered by what would hurt a real keyed run soonest. Each ends with what it would
take. **Section numbers are stable**: §8.1, §8.2, §8.3 and §8.10 are cited from
earlier sections and from the run doc, so a closed gap keeps its number and says
what closed it rather than being deleted and shifting the rest.

### 8.1 The transcript cue window never reached the writer — **closed by #551**

`writeNarration` built its evidence gatherer with `createEvidenceGatherer()` and no
options, and `runPipeline` passed no `evidence` dependency, so
`DefaultEvidenceGatherer` fell back to `NullTranscriptCueProvider`: a tape beat's
pack carried the show and episode **titles** and never the `tape:<segmentId>`
transcript document, on the same machine where §3.6 was anchoring against real cues
(**F-52**). `WriteNarrationOptions` now takes a `cueProvider`, `runPipeline` passes
`deps.cueProvider`, and `DefaultEvidenceGatherer.cueProvider` is public readonly so
a test proves the provider arrives. Mechanics in §3.7.4.

### 8.2 A tier-2 anchor made the Foray unpublishable — **closed by #552**

`sourceBeats` minted a `NewSegment` per tier-2 hit and **nothing consumed it**, so
the candidate named a `segment_id` in no file on disk: `runtimeSecFor` scored it 0 s
and `check-forays.mjs` failed it with `unknown segment_id "…"` (**F-53**). The
moment F-49's and WS-H's fixes yielded tier-2 tape, finalize would have failed the
Foray. Closed end to end: sourcing also returns `newSegmentSources` built by
`audioSourceLookup.ts` and refuses to mint tape it cannot register (§3.6.6c); the
candidate carries `segments`/`segmentSources` (§6.1); `finalizeForay` merges both
into the pool and registry it validates against and `runtimeSecFor` measures against
the merged pool (§3.10); `publishForay` commits them beside `data/forays.json`
(§6.5); and `tools/foray/check-forays.test.mjs` pins the whole path.

**One half is still open, and it is a small one.** `transcriptionQueueCandidates`
is produced, checkpointed and never surfaced in the outcome or `report.json`, so
the "log it for transcription" behaviour §3.6.7 describes still produces no
artefact anybody reads. What replaced it in practice is `sourcingTrace` (§3.6.9a),
which *is* checkpointed and printed per slot.
**To close:** put the queue rows in `report.json`, or drop the array and let the
trace be the record.

### 8.3 F-61 — the verbatim-anchor rule is the wall after WS-H

F-06 is closed (§3.6.6a): tier 2 now chooses its candidate episodes by BM25 over
the transcripts' own words, and the offline replay shows every one of run 2's 23
searching beats reaching real *Practical AI* bodies. **Tape yield is still zero on
that fixture**, and the gate that now decides is `resolveAnchorFromCues`: it
requires a contiguous run of **≥ 4 of the claim's own words** spoken verbatim.
Claims are written prose; tape is speech. Across all 63 bodies exactly one of the
23 claims has such a run anywhere — in an episode BM25 ranks 53rd — and the
anchored-window test correctly refuses it, because it is precisely the generic run
F-24 exists to reject.

The rule conflates two different things: **which window carries the beat** (a
relevance judgement, now answered by BM25 plus the anchored-window overlap) and
**which spoken phrases mark that window's edges** for ADR-0007's drift-tolerant
anchoring — which must be verbatim tape words, but the *tape's*, not the claim's.
**To close:** pick the window by overlap, then mint `startAnchor`/`endAnchor` from
the first/last distinctive phrases **inside** that window's cue text; keep the ≥ 3
content-word overlap and the lineage gate; add a relevance floor so a weak window is
refused. Regression: run 1's Chernobyl/griddle/San Bruno anchors must stay refused.

**F-62 rides with it.** `cutSpanToCueBoundaries` grows a short window
**symmetrically** to reach `MIN_TAPE_SEGMENT_SEC = 45`, and this archive's cues
average ~28 s, so WS-H's one successful mint pulls in a leading cue that is off-claim
— roughly 28 s about Underwriters Laboratories before the passage the claim
describes. **To close:** grow by overlap (prefer the side whose next cue shares
claim terms), never symmetrically, and allow a shorter segment over an off-claim
lead-in.

### 8.4 F-48 — print evidence is the retrieval model's restatement

`AnthropicExternalResearcher.retrievePassages` runs a web-search call and asks the
model to return `{title, url, text}` passages; the pipeline holds *that text* as
the document and checks quotes against it. The substring gate therefore proves a
quote is consistent with what the retrieval stage wrote, **not** with the page at
that url — one model copying a search result faithfully is likely but is not
verified, so `groundedQuoteRate = 1.0` overstates what has been checked. The tool
type is also still `web_search_20250305`.
**To close:** retrieve with `web_fetch` + `citations: {enabled: true}` and hold
server-attested `cited_text` spans as the document (or store the search tool's own
result blocks rather than the model's restatement), moving to the `_20260209` tool
types alongside F-47.

### 8.5 F-47 — adaptive thinking inside tight `max_tokens`

`claude-opus-5` and `claude-sonnet-5` have adaptive thinking on by default; its
tokens bill as output and count against `max_tokens`. **No builder sets `thinking`
or `output_config`** (verified by grep over `backend/src/`), and several caps are
tight: continuity **500**, understander **400/600**, researcher **800**, verifier
**2000**. A keyed run on the current ids can therefore truncate a JSON reply
inside the thinking budget — F-39's failure, now systematic — and the budget
estimate under-counts by the thinking tokens. **The relay transport did not
exercise this**, so run 1's data says nothing about it.
**To close:** set `output_config: { effort: "low" }` on the per-page calls
(writer, verifier, continuity, understander), leave the spine at default effort,
raise the small caps by a thinking allowance, and make `env.ts`'s estimate include
it.

### 8.6 F-55 — duplicate slot titles collapse in the item mapping

`runPipeline.ts:slotsFromSpine` de-duplicates slot ids with a numeric suffix
(`foo`, `foo-2`) so `check-forays` can join items to slots. `forayItems.ts:toForayItem`
slugifies each item's slot title **without** that de-duplication. Two slots that
share a title therefore both emit `slot: "foo"`; the declared `foo-2` gets no
items, and if the two slots are not adjacent in the running order,
`check-forays.mjs`'s contiguity rule fails with "slots are interleaved rather than
contiguous".
**To close:** pass the resolved slot-id list into the mapping instead of
re-slugifying, or forbid duplicate slot titles in `spineStructure.ts`.

### 8.7 F-56 — the Foray title can exceed the 18-word copy limit

`runPipeline` builds `title = "{subject}: {angle}"` truncated to **120
characters**; `check-forays.mjs` rejects a title over **18 words**. A wordy
subject-plus-angle can be inside 120 characters and outside 18 words, and nothing
between the two catches it — the failure surfaces only at finalize, after every
stage has been paid for.
**To close:** apply `wordCount` at title-mint time, or ask the intent stage for a
short title field.

### 8.8 Progressive playback has no server

The partial candidate exists, is validated, is written per act, and
`generationStatus.ts:readPartialCandidate` implements the authorised read. **There
is no HTTP server anywhere in this repo** — no express, no fastify, no route — so
nothing serves it, and `app.js`'s Create page keeps its disabled Foray toggle.
`generation-architecture.md` §4.9 names this gap itself and declines to resolve
it. The founder's Desktop plan calls the fix **Path B** and lists the four
decisions it needs before anything is built:

1. **Where it runs** — `hermes-vm` on the tailnet vs. a founder-owned box (ties to
   the tailnet ACL, same shape as `foray-db`).
2. **Spend** — whose key, and a per-day/per-run cap.
3. **The review gate** — stress-test Forays must skip the founder-review publish
   gate to be useful, which means unreviewed Forays are briefly live to the
   tester. Acceptable for a testing track; **must not** become the path to the
   public catalogue. This deliberately bends §1.3.
4. **CSP** — adding the service's tailnet origin to `connect-src` in `index.html`.

The plan's own recommendation is **Path A first** (the batch driver, which needs
only a key) and Path B once Path A shows the output is worth a button. B3 also
notes the request/response problem: a real run takes minutes, so the service must
stream progress or return a job id the app polls.
**To close:** the four decisions above, then a small tailnet HTTP service wrapping
`runForayPipeline` plus a player-side append path.

### 8.9 F-58 — generated narration is never checked against `check-narration.mjs`'s rules

The pipeline writes no `docs/curation/narration/<id>/` artifacts, so that
validator inspects other Forays' files and contributes nothing about this one
(§5.2). The mode bands and the banned-phrase list are enforced elsewhere, but the
**digit-in-a-spoken-line rule, the reference-leak rule, the sentence mean/max/rhythm
rules, the numeric-facts cap and the hedge/adjective/opener lists are not applied
to generated narration at all** — even though the prose prompt *asks* for three of
them in words.
**To close:** either lift `spokenLineErrors` into `validateNarratedBeat` (it is a
pure function over one sentence), or have §4.7 emit the curation artifacts the
validator already understands.

### 8.10 The per-Foray budget cap was inert in the batch path — **closed by #551**

`BudgetGuard.checkAndRecord` enforces `EPISODE_BUDGET_USD` only when the caller
passes a `sessionId`, and `generateForays.ts` never set one, so in the only path
that generates anything a runaway Foray was bounded by the daily cap alone
(**F-54**). `generateOneCandidate` now passes `sessionId: checkpointKey` — one id
per Foray, stable across a resume, already the name a human reads when a run stops
(§4.1). `--budget-usd` still re-caps both ceilings together, because generation
calls score tier 1.

### 8.11 F-57 — the ±15 % runtime tolerance is not implemented

`generation-architecture.md` §3/§8 make runtime tolerance a publishability
condition. The code bounds **counts** (acts/slots/beats) and never compares the
finished `runtime_sec` against the tier's target minutes. A `medium` Foray that
lands at 25 minutes or 100 minutes passes every gate.
**To close:** a founder-approved band per tier plus a check in `finalizeForay`,
and — because a narration item's length is an estimate until it is spoken — a
decision on the error margin (`generation-architecture.md` §7.3, itself open).

### 8.12 Design-only features, listed so nobody re-discovers them

| Feature | Status |
|---|---|
| **Deferrable exploration beats** as a live time buffer (§4.3/§6.3) | **Not implemented, and not buildable** — the doc surfaces its own storage/player gap and rules that an act produces zero deferrable beats until a schema/player contract is approved. |
| **Per-act runtime gate** before an act enters the reachable running order (§4.9) | Not implemented; there is no progressive running order to gate. |
| **Forward-only continuity across a playing act** (§6.2) | The *data* contract is implemented (`smoothSeam.ts` returns a new array; the builder cannot return a revised exit). The playback half does not exist. |
| **The jingle asset** | The item type, the two insertion rules and the 1.5 s constant exist; the fixed sonic mark itself is a brand asset outside this pipeline. |
| **Pronunciation hints** | Carried on every page (`pronunciationHints`) and **stripped by `toForayItem`** — nothing consumes them, by design, until §9.1 picks a mechanism. |
| **Deduplication of near-identical prompts** (§9.6) | Open. The comparison basis is settled (embed the incoming prompt transiently; compare against each Foray's retained `title`/`summary`/`topic`/slot titles) but the model, metric and threshold are a founder call, and §9.6 says do not build past it. |
| **Listener feedback on a bad Foray** (§9.5) | Open. |
| **Phase 2 (any user prompts, published to the shared catalogue)** | Open, and App Store Guideline 1.2 applies the moment it ships: content filtering, a report mechanism, a way to block abusive users, published developer contact. None exist. |

### 8.13 Findings from runs 1 and 2 still open or only partly closed

| Finding | State on this branch |
|---|---|
| **F-05** — the cheapest tier (haiku, 800 output tokens) decides a topic's "genuine controversies" | unchanged |
| **F-06** — tier-2 episode matching is title-only; `corpus.db` FTS unused | **closed** by WS-H (#553): tier 2 ranks candidates by BM25 over transcript text and the title bar is demoted to a tie-breaker (§3.6.6a). `corpus.db` is still unused, deliberately — it holds reference documents, not episode transcripts |
| **F-07** — the SDK's 10-minute timeout and 2 retries can mint duplicate requests on a slow transport | unchanged; irrelevant with a real key, relevant to any queued transport |
| **F-12** — external research fires only for catalogue-gap seeds | unchanged by design; F-11's fix is what makes a gap detectable |
| **F-19 / F-25** — a Frame's 70–170 characters and rule 3 are close to incompatible | *mitigated*, not resolved: "contested" is now narrowly defined in the selection prompt and rule 3 is judged by the verifier rather than a keyword list, but a contested source on a Frame page still has to be voiced inside 170 characters |
| **F-20** — the driver's error text double-encodes `§` on a Windows console | unchanged, cosmetic |
| **F-47** — adaptive thinking bills as output inside tight `max_tokens`; no builder sets `thinking`/`output_config` | **open**, §8.5. Still verified by grep over `backend/src/`; the tight caps (continuity 500, understander 400/600, researcher 800, verifier 2000) are unchanged on this branch |
| **F-48** — print evidence is the retrieval model's restatement, not fetched bytes; still `web_search_20250305` | **open**, §8.4. Unchanged: `groundedQuoteRate = 1.0` still overstates what has been proven |
| **F-49** — run 2 sourced zero tape for 35 beats | **closed** in both halves: the `kind` definition plus the per-slot argument cap (§3.5.3a) and the sourcing trace (§3.6.9a) from #552, the text-level candidate search from #553. What remains is F-61, a different rule |
| **F-50** — evidence that contradicts the purpose left the page no honest move | **closed** by #551 (§3.8.3, §3.8.5, §3.8.8, `purposeRevisedPages`) |
| **F-51** — a narration beat's third rejection failed the whole Foray | **closed** by #551 (§3.8.10, `unverifiedPages`, the gate) |
| **F-52 / F-53 / F-54** — the requirements-doc audit's three wiring defects | **closed**: §8.1, §8.2, §8.10 |
| **F-55** — duplicate slot titles collapse in the item mapping | **open**, §8.6. Low: `slotsFromSpine` de-duplicates, `toForayItem` re-slugifies without |
| **F-56** — the minted title is capped at 120 characters, `check-forays` rejects over 18 words | **open**, §8.7. Low: cap by words at mint time |
| **F-57** — the ±15 % runtime tolerance is not implemented anywhere | **open**, §8.11. Medium: a `medium` Foray can finalize far from ~60 min |
| **F-58** — `check-narration.mjs` structurally cannot validate generated narration | **open**, §8.9. Medium: a whole checker believed to be in the path is not. Reconfirmed while ruling that F-51 needed no checker change (§5.2) |
| **F-59** — `resolveTopic` resolved run 2's AI/ML prompt to `engineering/energy-fusion` | **closed** for the resolver by #554 (§3.4). The **show-classification half is untouched** — #547's magnet, where CBC Ideas, Lex Fridman and Catalyst all carry `energy-fusion` as their only node — and should reuse `GENERIC_LABEL_WORDS`, the `GENERIC_TOKEN_MAX_NODES` rarity rule and the node `terms` field rather than re-deriving them |
| **F-60** — a page with no evidence still cost three model calls | **closed** by #555 (§3.7.2a, §3.8.2a, the 24 h empty-cache TTL) |
| **F-61** — the verbatim-anchor rule is the next wall after WS-H | **open, Critical for tape yield**, §8.3 |
| **F-62** — the cut grows symmetrically and pulls in an off-claim lead-in | **open**, §8.3. Medium, listener-visible once tape flows |
| **I-01** | closed by `--budget-usd`, the new defaults, and (since #551) a real per-Foray cap — §8.10 |

---

## 9. Appendix

### 9.1 Stage table — a medium Foray (3–4 acts, 5–7 slots, 28–36 beats)

Call counts assume 4 acts, 6 slots (~1.5 slots per act), 32 beats, and pages
passing on the first attempt. A rejected page costs its slot another full
3-call attempt, up to 3 attempts.

| # | Stage | Module | Tier · model | `max_tokens` | Calls | Checkpoint key | What fails it |
|---|---|---|---|---|---|---|---|
| 0 | Safety | `safetyCheck.ts` | — | — | 0 | (inside `understand`) | Two co-occurring signals → terminal `rejected` |
| 1a | Clarity | `AnthropicPromptUnderstander` | haiku · `claude-haiku-4-5-20251001` | 400 | 1 | `understand` | `ambiguous: true` → terminal `needs-clarification` |
| 1b | Intent | same | haiku | 600 | 1 | `understand` | schema failure after one re-ask |
| 2 | Research shape | `researchShape.ts` + `AnthropicExternalResearcher` | haiku (+ web_search ×3) | 800 | 0–8 | `research-shape` | any throw |
| 3 | Spine | `AnthropicSpineBuilder` | **opus · `claude-opus-5`** | **8000** | **1** | `spine` | `validateSpine` or `assertSpineStructure` — **no retry** |
| — | Topic | `resolveTopic.ts` | — | — | 0 | — | no distinctive evidence, or no node clears the bar → `unresolved-topic` |
| 4 | Deepen acts | `AnthropicDeepenActBuilder` | sonnet · `claude-sonnet-5` | 4000 | **4** (×2 on retry) | `deepen:0…3` | second failure of any act → `ActDeepeningError`. The argument cap re-tags rather than fails, and records a `warnings` line |
| 5 | Source beats | `sourceBeats.ts` (+ `transcriptTextIndex.ts`, `audioSourceLookup.ts`) | — | — | 0 | `source` | only the beat-preservation guardrail (unreachable). Prints one summary line per slot |
| 6 | Gather evidence | `gatherEvidence.ts` + retriever | haiku (+ web_search ×3) | 2000 | ≤ 32, **≤ 2 queries per content page**, cached by query hash | (inside `narrate:*`) | never — retrieval failure degrades to no print evidence, and an empty pack degrades the page with **zero** writer calls |
| 7a | Select claims | `AnthropicNarrationWriterBuilder` | sonnet | 4000 | **6** (1/slot) | `narrate:0…3`, `narrate:<act>:<slot>` | ungrounded/short/echoing quote → retry |
| 7b | Write prose | same | sonnet | 4000 | **6** | same | band, copy, negative-claim, empty-source, slug rules → retry |
| 7c | Verify | `AnthropicNarrationVerifierBuilder` | sonnet | 2000 | **6** | same | any of the three answers false → retry; 3rd failure drops a connective page and **keeps a Patch/Carry page `verified: false`** — the veracity gate refuses it, nothing throws |
| 8a | Continuity | `AnthropicContinuityBuilder` | sonnet | **500** | **3** (acts − 1) | `stitch` | empty or < 50 % of the original → `SeamSmoothingError`, fatal |
| 8b | Stitch + map | `stitchAct.ts`, `forayItems.ts` | — | — | 0 | `stitch` | coverage gap → `ActCoverageFailedError`; a leaked internal field → throw |
| 9 | Finalize | `finalizeForay.ts` | — | — | 0 | — | any `check-forays` / `check-narration` error → `validation.ok === false`, no candidate written. Minted tier-2 segments and their source rows are merged in-memory before the checkers run |

**Total: ~28 model calls** for a clean medium Foray (1 opus, ~5 haiku + up to 32
evidence retrievals, ~22 sonnet), against run 1's **103** for 22 of 31 beats.
Estimated ceiling per the budget arithmetic: **≈ $3.35** (§4.1). A page whose
retrieval comes back empty adds at most one extra haiku call and **subtracts**
three sonnet calls (§3.8.2a).

### 9.2 Glossary

**Act** — a top-level narrative movement with its own title, thesis, explicit
start state and end state. The **planning** layer. 1–7 per Foray. Deepened by one
agent each, in parallel.

**Beat** — the atomic unit of content: one idea that must land, stated as a
**claim**, never a topic. "Charcoal briquettes were a Ford Motor Company
waste-disposal scheme" is a beat; "Briquettes" is not. Enforced by
`isClaimShaped`.

**Slot** — the subdivision inside an act, and the **persistence** layer: it is the
field `data/forays.json` and the player actually see. One act may contain several
slots. Items join to slots by a slugified id.

**Spine** — the one document, produced in one call by one agent, that fixes acts,
slots, beats, the exploration budget and the voice before any content is sourced.
Frozen from that point on.

**Tape** — real podcast audio, played by seeking into the publisher's own
enclosure. Radio's word.

**Narration** — 4a's own spoken words, carried as a script.

**Tier-1 sourcing** — a hit in the committed `data/segments.json` pool: already
anchored, already confidence-rated, the cheapest possible hit.

**Tier-2 sourcing** — a hit in the transcript archive: an episode we hold a
transcript for but have not cut into segments. Candidates are chosen by **BM25 over
the episode's own cue text** (§3.6.6a), then gated by a real verbatim anchor, the
anchored-window overlap test, the taxonomy lineage, a cut to whole cues and a
playable audio row. Produces a **new** segment plus its `segment-sources` row, both
carried on the candidate and committed by `publishForay`. Requires transcript
bodies on the local machine.

**Transcript text index** — `transcriptTextIndex.ts`: a read-only, per-show
inverted index over normalised cue text, BM25-scored, cached under
`data-local/transcripts/index/` and keyed by each body's mtime+size. Says which
episodes are worth *opening*; never whether tape is about a claim.

**Sourcing trace** — one row per narration-degraded beat saying what each tier's
best candidate was, what it scored, what bar it had to clear and **which gate**
refused it (§3.6.9a). The machine-readable half of a run; the per-slot summary line
is the human half.

**Minted segment source** — the `data/segment-sources.json` row
`audioSourceLookup.ts` writes for a tier-2 episode, from the digest's own enclosure
plus a real DAI verdict. It **refuses rather than invents**: no honest row, no tape.

**Unverified page** — a page kept with `verified: false` because the verifier
refused it three times, because no prose call ever produced one (`no-page`), or
because no evidence could be retrieved for it (`no-evidence`). It holds its beat's
place, asserts nothing it cannot source, is counted by `unverifiedPages`, and is
refused by the publish gate.

**Purpose revised** — a page that departs from its brief *because the evidence
did*: the documents contradict or complicate the purpose and the page reports that
tension. Flagged independently by the writer (`purposeRevised`) and the verifier
(`purposeRevisedByVerifier`), counted by `purposeRevisedPages`, and **never gated**
— it is the most valuable thing evidence-first narration can produce.

**Tier 3** — a catalogue episode with no transcript. Cannot be cut, so it is
logged as a transcription-queue candidate and the beat becomes narration.

**Frame** — narration that introduces tape which carries the beat itself. 70–170
characters. The only connective mode this pipeline assigns.

**Hinge** — narration that closes one piece of tape and opens the next. 50–135
characters. Defined and validated, never assigned by
`decideConnectiveNarration`.

**Marker** — narration that announces structure: a boundary, a step out of
sequence. 135–340 characters. Used only for the disclosure item.

**Correction** — narration that bounds, attributes or contradicts adjacent tape.
100–205 characters. Defined and validated, never assigned.

**Patch** — narration that supplies the part of a beat its tape misses. 340–765
characters. Assigned when a beat has no tape but its **slot** does.

**Carry** — narration that **is** the beat; there is no tape. 765–1,870
characters. Assigned when a beat's whole slot has no tape.

**Connective page** — a Frame/Hinge/Marker/Correction page written *around* a
tape beat rather than *as* a beat. It may carry zero sources if it asserts
nothing, and it is **dropped rather than fatal** when it cannot be written: the
beat's content is the tape.

**Exploration** — a beat that goes somewhere the prompt did not literally ask for
but a curious listener would be glad to have been taken. At least 30 % of all
beats must be marked `exploration: true`; the spine validator enforces the floor.

**Voice** — style, register, sentence rhythm and narrator presence, decided once
for the whole spine. Structurally spine-level: an act schema has no `voice` field
and cannot parse one.

**Seam** — the join between two items. Silence, a jingle, or narration — never a
bridge *and* a gap.

**Jingle** — 4a's own 1.5-second sonic mark, inserted as a structural backstop at
an unmarked cross-episode cut, or on the measured 155 s texture cadence.

**Evidence pack** — the documents a page's quotes must be looked up in: a tape
transcript window (± 90 s, wired since #551 — §3.7.4) and up to three retrieved
print passages of ≤ 1,500 characters each, from at most two retrieval queries.

**Grounded quote** — a quote that is a whitespace-normalised substring of a
document the pipeline actually holds. The opposite of a recollection.

**DAI** — dynamic ad insertion. A `dai_suspected` episode's timeline shifts
between listeners, so an authored out-point cannot be anchored; `check-forays.mjs`
fails every segment of such an episode.

**Disclosure** — the mandatory first item of every generated Foray, spoken before
anything else, matched verbatim by `check-forays.mjs`'s `DISCLOSURE_RX`:

> *This is a Foray about &lt;subject&gt;. Much of what you'll hear is written by AI.
> We work hard to get the facts right, but AI gets things wrong — so take it as a
> starting point, not a source.*
