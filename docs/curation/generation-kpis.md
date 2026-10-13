# Generation KPIs — the trend, one row per run

**What this is.** The output of `tools/generation-bench/run.mjs` (roadmap card
G-42a), one row per generated Foray, in run order. Every cell is read off that
run's `report.json` — the file `backend/src/cli/generateForays.ts` writes — or
measured on the candidate Foray beside it. Nothing here is typed by hand.

**How to add a row.**

```
node tools/generation-bench/run.mjs --append docs/curation/generation-kpis.md <out-dir>
```

The splice replaces a row whose run id already appears rather than appending a
duplicate, so re-reading an archived report is idempotent.

**How to read it.**

- `—` means *the report does not carry that field*. It never means zero. The
  report grew field by field across runs 4–9 (`calls` from run 5, `tapeShare` /
  `narrationShare` / `narrationPagesPerSeam` / `introRestates` from run 9's
  Q-05 code, `synthesisVerifiedPages` from run 8's F-88), so an empty cell on
  an early run is a missing instrument, not a measured zero.
- `*` on a clip figure means it was measured over some of the run's clips, not
  all of them — the durations of tier-1 pool clips a candidate points at
  without minting come from `data/segments.json`, and a row the pool no longer
  holds cannot be measured.
- The table shows the **core** columns. `run.mjs --wide` prints every column,
  including the **detail** group later bench cards add, and the JSONL
  (`--format jsonl`, `baseline.jsonl`) always carries every number column.
- **This table grades nothing.** G-42a's own card says so: "a trend with a
  tolerance band rather than a hard pass/fail — LLM runs are non-deterministic
  and a hard gate would be flaky by construction." The targets below are here
  so a reader knows which direction is good, and three-quarters of them are
  still *proposed*. The gate is G-42b's, past a band, past D0.

## Targets, and which of them are actually settled

From the roadmap's §1.2 acceptance table. A target marked *proposed* there is a
proposal waiting on founder decision **D0** and is printed with a `?` by the
harness; it is not something a run can pass or fail yet.

| Column | Target | Settled? | Where it comes from |
|---|---|---|---|
| `stageSum m` | — | — | `entry.ms`: the SUM of the stage durations, so concurrent acts are counted once each (TM-10). Not wall time; the key stays `wall_min` so the baseline stays comparable |
| `elapsed m` | — | superseded by R1-16 | First stage start to last stage end: the report's `elapsedMs` when it carries one, else the span of `veracity.stageTimings` (stages marked `resumed` left out). §1.2's *proposed* ≤ 6 min p50 (prompt → finished Foray) is replaced by the per-tier whole-Foray-ready target on `allReady s` (GV-52) |
| `ttlA1 m` | — | superseded by R1-16 | §1.2 prompt → Act 1 playable, kept as its own **act-level** row. Its ≤ 0.5 min p50 target (fix plan WS-D) is replaced by the per-tier first-audio target on `1stAudio s` (GV-52) |
| `tier` | — | — | The duration tier the prompt ran at (`entry.duration`, GV-01). It picks the row's targets for the three columns below; `—` on every report before GV-01 |
| `1stAudio s` | per tier | see below | **MT-01.** Seconds from the attempt's start to the first servable item (`delivery.firstServableMs`, GV-33). Phone voice first, so the first servable item is first audio |
| `allReady s` | per tier | see below | **MT-02.** Seconds until every item was ready (`delivery.allItemsReadyMs`), **only when `entry.publishable` is true** (GV-26): a candidate whose gate failed was never ready, so the cell is `—` (not ready: gate failed) even when the report carries the time |
| `minLead s` | per tier | see below | **MT-11.** The smallest lead of generation over the playhead at 1x (`delivery.minLeadSec`): how many seconds before the listener reached an item it was ready. Negative is a stall |
| `tapeSh` | — | — | NOT §1.2's row (F-101): the report's tape ÷ (tape + narration) |
| `tape/rt` | ≥ 0.70 | **proposed (D0)** | §1.2 **tape share of runtime** — the row's own denominator |
| `clip mean` / `clip max` | — | — | Q-01 cuts a clip to a thought inside 60–1,800 s; no §1.2 target |
| `pg/seam` | ≤ 1 | **proposed (D0)** | §1.2 narration pages per seam |
| `narrSh` | ≤ 0.25 | **proposed (D0)** | §1.2 narration share of runtime |
| `1stPg` | ≥ 0.80 | settled | §1.2 first-attempt **page** pass rate — kept pages accepted on the writer's first try |
| `1stBt` | — | — | Q-03's per-act reading: narration **beats** the verifier confirmed on round 1. Not comparable to `1stPg` |
| `1stPass?` | — | — | runs 4–9's single `firstAttemptPassRate`, unit **undeclared** (4–8 are pages, run 9 is beats). F-101 refuses to guess it into either column |
| `unver` | 0 | settled | F-51: any page kept `verified: false` refuses publish (`evaluateVeracityGate`) |
| `synth` | — | — | F-88 counts synthesis-verified pages *beside* the unverified ones; no target |
| `seedLost` | — | — | F-99 counts beats closed as seed-lost; no target, and no report written so far carries it |
| `introRe` | 0 | settled | Q-02: the writer is refused in code for a page that repeats the clip it introduces |
| `call/bt` | ≤ 1.5 | settled | §1.2 narration calls per beat |
| `tokens` | ≤ 50,000 | settled | §1.2 pipeline tokens; §1.2 says **D6** re-baselines it |
| `cost $` | ≤ $10 | **proposed (D0)** | §1.2 cost per Foray, inside `EPISODE_BUDGET_USD`. Empty on every run so far: `ReportEntry` carries no `usage` block, and the harness will not turn §1.2's "[estimated] ≈ $1–4 per attempt" into a measurement by multiplying tokens by a list price |

### The two numbers both called "tape share"

They are different quantities and the table prints both.

- **`tapeSh`** is `meta.veracity.tapeOfTapePlusNarration` (`tapeShare` on runs
  4–9, before F-101 put the denominator in the name) — Q-05's
  `computeListeningShares`: tape seconds over tape + narration seconds, as the
  writer estimated them. Present from run 9 on, because that is when the code
  landed. **It is not §1.2's row and no longer carries §1.2's target.**
- **`tape/rt`** is tape seconds over the candidate's whole `runtimeSec`, which
  also counts jingles and markers. This is the reading §1.2 quotes — "59–61 %
  (runs 5–7), **78 %** (run 8) [measured on `data/forays.json` @ #642]" — and
  the harness reproduces it from the archived candidates: 0.598, 0.595, 0.776,
  0.557 for runs 6, 7, 8, 9.

On run 9 the two read **0.684** and **0.557** — thirteen points apart.
Collapsing them into one column would put a step in the trend line on the day
the report started carrying its own number, so they stay apart. §1.2 named
`report.json tapeShare` as the source for a row titled "Tape share **of
runtime**", which would have graded a *proposed* ≥ 70 % founder target against
the flattering one; **F-101 moved the target onto `tape/rt`** and the roadmap's
source cell with it.

### The rate whose unit changed mid-trend

`firstAttemptPassRate` meant "share of kept **pages** accepted on the writer's
first try" for runs 4–8 and "share of narration **beats** the verifier confirmed
on round 1" from run 9, and which one a report carried was decided by sniffing
the candidate — under one field name, in one column. Run 9's **0.048** is not
run 8's **0.68** measured worse; it is a different measurement, and `writeAct.ts`
cites exactly that pair as evidence the Q-03 contract did not converge.

Reports from F-101 on carry `firstAttemptPassRatePages`,
`firstAttemptPassRateBeats` and `firstAttemptUnit`, and the harness prints
`1stPg` and `1stBt` from them. Runs 4–9 declare no unit, so their number stays
in `1stPass?` rather than being guessed into one of the two — rule 1 applied to
a unit instead of a value. What run 9's regression was really made of is in the
run ledger's F-101 paragraph: under run 9's own contract all four acts ran all
three rounds and the retry re-sent the whole act, so a clean seam was
re-attempted (and one clean Intro dropped) for another seam's failure — the page
unit would have read near zero on run 9 too. The unit change did not manufacture
the regression; it made the column uninterpretable.

### MQ-20 · the founder's listen

**Definition.** MQ-20 is what the founder heard: a blind listen of one act of a
candidate, recorded on the listening card (`listen-card/1`,
`tools/listening/card.mjs`, roadmap card GV-08 for R2-01). Per act the card
scores four axes 1–5 (`onSubject`, `flowsAtSeams`, `oneNarrator`,
`nothingFalseOrOdd`), an `overall` 1–5, a list of timestamped winces, and —
when two versions were heard blind as A and B — a preference (`A`, `B` or
`tie`). It also keeps Q-06's three yes/no answers (`q06.oneVoice`,
`q06.everyClipIntroduced`, `q06.anyClipCutShort`), so MQ-20 stays continuous
with the baseline definition, which was Q-06's three questions. The cards are
committed, append-only, in `docs/curation/listening/cards.jsonl`
(`docs/curation/listening/README.md` says who may append).

**Per candidate**, MQ-20 is the mean `overall` over every card that unseals to
that candidate, with the date of the latest one. **Per stage swap** (R2-21),
it is the pairwise preference rate: the share of blind pairs in which the arm
carrying that swap was preferred (a tie is not a win), from
`tools/listening/unseal.mjs`'s `aggregate()`.

| Column | Target | Settled? | Where it comes from |
|---|---|---|---|
| `listen` | — | — | **detail.** Mean `overall` (1–5) of the founder's cards for this candidate. Joined by candidate id (the report entry's `file` without `.json`) through the pack keys in `data-local/listening/keys/`, which are never committed: on a machine without them the column is `—` |
| `lastListen` | — | — | **detail.** UTC date of the latest card for this candidate. `—` means nobody has listened — the dated field that makes "nobody has listened since run N" visible |

Both are **detail** columns (`run.mjs --wide`, and the JSONL), so the committed
table below does not change shape. No target is proposed: the founder's ear is
the criterion, and a number to grade it against would be the bench grading the
founder.

### Per-call speed (GV-17)

Every attempt since GV-01 writes a `runlog/1` file beside its report
(`runlogs/<checkpointKey>.<attempt>.runlog.jsonl`, named by the entry's
`runLog`, relative to the report's directory), and every model request in it is
a CallRecord (GV-07). `tools/generation-bench/runlog.mjs` summarises it into the
speed scorecard below; `backend/test/runLogBenchParity.test.ts` runs a stub
pipeline under a real RunLog and checks the reader's counts against the log's
own, so the emitter and the reader share one schema.

A report with no `runLog`, or whose runlog was not copied with it (runs 4–9,
every `--dry-run`), prints `—` in every column below. Inside a runlog, a field
no call reports (Anthropic returns no queue time or TTFT on a non-streamed
call) is `—` too: a median or a share over nothing is not zero. The JSONL line
also carries `calls_by_stage` (calls per stage, a meta object rather than a
column) and `prose_basis`.

| Column | Target | Settled? | Where it comes from |
|---|---|---|---|
| `outTok` | — | — | **detail, MT-05.** Output tokens over every model call of the attempt; runlog.mjs keeps them per stage too (`outputTokensByStage`) |
| `series` | — | — | **detail, MT-06.** Calls in series: the longest chain of calls in which each starts at or after the previous one ended. Parallel calls are one link. GV-123's `serialCallChain` must agree with it on `fixtures/runlog-synth` |
| `reasks` | — | — | **detail, MT-07.** Repeat requests: JSON re-asks + spine re-asks (structural and seed-floor) + writer rounds after the first (not themselves re-asks) + continuations |
| `queueP50` | — | — | **detail, MT-04.** Median seconds a call waited in the server's queue, over the calls that report it |
| `ttftP50` | — | — | **detail, MT-04.** Median seconds to the first token, over the calls that report it |
| `cached` | — | — | **detail, MT-04.** Cached prompt tokens ÷ prompt tokens, over the calls that report both |
| `proseTps` | — | — | **detail, MT-12.** The writer's output tokens per second of decode (call time minus TTFT). When no writer call reports a TTFT the cell is the end-to-end rate, printed with `e2e` after it; the two are never mixed |
| `code s` | — | — | **detail, MT-08.** Seconds of code time inside the stages (`CodeSpanAggregate` events; none are emitted until GV-85) |
| `renderX` | — | — | **detail, MT-09.** Seconds of narration audio rendered per second of rendering (`RenderSpan` events) |
| `spark s` | — | — | **detail, MT-10.** Spark seconds charged: reconciled `sparkSeconds` meter events. A reservation is a hold, not a charge (meters land with GV-90) |

No target is proposed for any of them here: the per-tier time targets are
GV-52's (the delivery section below), and this card only measures.

### Delivery and the per-tier targets (GV-52, R1-16)

Every report entry written since GV-33 carries a `delivery` block: the
attempt's delivery timeline (`backend/src/generation/deliveryTimeline.ts`,
decision 14 of `docs/roadmap/generation-v2.md`), with the time the first item,
the first servable item and the last item were ready and the smallest lead over
the playhead at 1x and 1.5x. The bench reads it into three **core** columns and
two **detail** ones. A report with no `delivery` block (runs 4–9) prints `—` in
every one, and so does a resumed attempt, whose banked acts fired no events.

R1-16 replaces the single `ttlA1` ≤ 0.5 min and `elapsed` ≤ 6 min targets with
targets split by tier, chosen per row by its `tier`. The table below is
`TIER_TARGETS` in `run.mjs`; the legend prints it as `per tier` plus one
`targets (s):` line per column.

| MT | Column | Short | Medium | Long |
|---|---|---|---|---|
| MT-01 | `1stAudio s` | ≤ 30 s (settled) | ≤ 40 s (**proposed**) | — |
| MT-02 | `allReady s` | ≤ 90 s (settled) | ≤ 4 min / 240 s (settled) | — |
| MT-11 | `minLead s` | ≥ 30 s (**proposed**) | ≥ 30 s (**proposed**) | — |

**Provenance.** The settled cells are the orchestrator's adopted reading of the
"about 30 seconds" KPI (OQ-03): 30 s to first audio on the short tier and the
whole Foray ready within 90 s (short) or 4 min (medium), recorded as decision
15 of `docs/roadmap/generation-v2.md` (#1286). They rest on that recorded
adoption under the founder-async rule, not on a founder sentence, so a later
founder ruling flips a cell to proposed with a one-line change to
`TIER_TARGETS`. Medium first audio ≤ 40 s and lead ≥ 30 s stay **proposed**
(printed with `?`) until a founder ruling. Long has no target. As everywhere in
this table, nothing grades a row against them.

| Column | Target | Settled? | Where it comes from |
|---|---|---|---|
| `lead1.5x s` | — | — | **detail, MT-11 at 1.5x.** The smallest lead over the playhead when the listener plays at 1.5x (`delivery.minLeadSecAt1_5x`) |
| `render RTF` | — | — | **detail, R1-14.** The report's own render realtime factor (`delivery.render.realtimeFactor`), which the backend render stage (GV-74) adds; `—` until it lands. `renderX` above is the runlog's reading of the same MT-09 |

### The quality scorecard (GV-24, MQ-01..MQ-21)

`tools/generation-bench/score.mjs` scores one Foray on the Baseline's
twenty-one quality metrics, off the timed path. Each cell is
`{ value, source, note }`: `source` is the metric's producer (`report`, the
run's report entry; `candidate`, measured on the candidate Foray; `judged`, a
`<candidate>.judged.json` from the offline judge pass or the report's own judge
field once an in-pipeline judge writes it; `listen`, the founder's cards), and
a metric the row cannot know is `null` with a note saying why — never 0. A
clip-only Foray has no voice, not a voice that scored zero.

- `run.mjs --scorecard` adds a `scorecard` object to each JSONL line and, under
  `--wide`, the MQ columns (**detail**: the committed table below does not
  change). Without the flag the bench's lines and tables are byte-identical.
- `score.mjs --candidate <foray.json> [--report <report.json>]` scores one
  candidate; `score.mjs --forays data/forays.json` scores published Forays,
  which have no report, so only voice, tape, structure and runtime apply.
- **Reference scores.** `tools/generation-bench/golden/reference-scorecard.jsonl`
  holds the 7 Forays committed in `data/forays.json`: 3 labelled
  `curated clip-only` and 4 labelled `generated pre-Q-03`. They are
  **references, not targets**: the four generated ones come from the pre-Q-03
  writer the founder called clunky, and no metric is tuned towards them. If
  MQ-02 and MQ-05 do not separate them from run 9 once judged, that is a
  metric defect (R2-02's own check). Re-derive with
  `node tools/generation-bench/score.mjs --forays data/forays.json --check`
  (exit 1 on drift; `--write` rewrites it). It is a CLI check, not a unit
  test, so a change to `data/forays.json` cannot break CI.

"Today" below is what a run report written at this card's merge carries; a
metric whose producer is a later card says which.

| MQ | Metric | Source | Where it comes from | Available today |
|---|---|---|---|---|
| MQ-01 | Grounded quote rate | report | `veracity.groundedQuoteRate` | yes, from run 9 on; absent on a published Foray |
| MQ-02 | Supported-sentence rate | judged | judged file `MQ-02`, else `veracity.supportedSentenceRate` | no: needs the per-sentence support judge (GV-27) or the judge pass (GV-92) |
| MQ-03 | Attribution accuracy | judged | judged file `MQ-03`, else `veracity.attributionAccuracy` | no: needs GV-92 / the attribution check (GV-120) |
| MQ-04 | Unverified pages kept | report | `veracity.unverifiedPages` | yes, runs 5-9; absent on a published Foray |
| MQ-05 | Clip on subject | judged | judged file `MQ-05`, else `veracity.clipOnSubjectRate` | no: needs the clip scorer (GV-79) or GV-92 |
| MQ-06 | Clean-cut share | candidate | minted rows whose `boundary` is `turn` or `sentence`, over every clip; a pool clip is unknown, never clean | yes on a candidate with Q-01 minted rows; null on the published Forays (pool clips only) |
| MQ-07 | Show variety | candidate | report `veracity.showVariety` (GV-83) when present, else distinct shows / episodes and the largest show's tape share from the candidate (show via its `segmentSources`, then `data/segment-sources.json`, then the pool `show_id`) | yes (candidate fallback) |
| MQ-08 | Tape shape | candidate | tape ÷ runtime, median clip, share of clips under 60 s (run.mjs's `clipDurations`) | yes |
| MQ-09 | Tape yield | report | `veracity.tapeYield.rate` | no: GV-26 adds it |
| MQ-10 | Prompt fit | judged | judged file `MQ-10`, else `veracity.promptFit` | no: needs GV-92 |
| MQ-11 | Beat coverage | report | `veracity.beatCoverage.rate` | no: GV-26 adds it |
| MQ-12 | Seam coherence | judged | judged file `MQ-12`, else `veracity.seamCoherence` | no: needs GV-92 |
| MQ-13 | Intro restates | report | `veracity.introRestates` | yes, from run 9 on |
| MQ-14 | Tier fit | candidate | report `veracity.tierFit.ratio` (GV-106), else runtime ÷ `entry.tierTargetSec`, else runtime ÷ a **proposed** table (short 15 / medium 60 / long 180 min, the committed spec; the R2-15 row expects 8-12 min for short) | partly: needs the entry's tier (`duration`, GV-01); null on a published Foray |
| MQ-15 | Reading grade | candidate | word-weighted Flesch-Kincaid grade of the narration scripts (`voice-metrics.mjs`, GV-10); band 6-9 (OQ-02) | yes where scripts are present; null on clip-only Forays |
| MQ-16 | Sentence shape | candidate | mean and max words, sentences over 25 words, short share | yes where scripts are present |
| MQ-17 | Speakability | candidate | digits, URLs, acronyms, brackets and spoken-line errors per 100 words | yes where scripts are present |
| MQ-18 | Filler | candidate | -ly adverbs, passives, banned words, rhetorical questions per 100 words | yes where scripts are present |
| MQ-19 | Structure leaks | candidate | `narratorStructureLeaks` over the scripts (`backend/src/copy/narratorStructure.js`) | yes where scripts are present |
| MQ-20 | The founder's listen | listen | mean `overall` of the cards that unseal to the Foray (`unseal.listenByCandidate`, GV-08) | only on the machine holding the pack keys; left out of the reference file |
| MQ-21 | Publishable | report | `entry.publishable` | no: GV-26 adds it |

Every score is a heuristic or a judgement to calibrate against the founder's
listening cards before anything gates on it.

## The trend

| run | outcome | valid | stageSum m | elapsed m | ttlA1 m | tier | 1stAudio s | allReady s | minLead s | calls | tapeSh | tape/rt | clips | clip mean | clip max | pg/seam | narrSh | 1stPg | 1stBt | 1stPass? | unver | synth | seedLost | introRe | call/bt | tokens | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
<!-- bench:rows:begin -->
| run-4 | no-tape | no | 4.4 | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| run-5 | generated | no | 40.6 | — | 0.1 | — | — | — | — | 49 | — | — | — | — | — | — | — | — | — | 0.67 | 2 | — | — | — | — | 100380 | — |
| run-6 | generated | yes | 55.0 | — | 21.2 | — | — | — | — | 72 | — | 0.598 | 11 | 142.6 | 237.8 | — | — | — | — | 0.73 | 4 | — | — | — | 0.80 | 128592 | — |
| run-7 | generated | yes | 63.9 | — | 20.4 | — | — | — | — | 84 | — | 0.595 | 10 | 102.5 | 181.4 | — | — | — | — | 0.55 | 10 | — | — | — | 1.03 | 156534 | — |
| run-8 | generated | yes | 91.1 | — | 34.0 | — | — | — | — | 78 | — | 0.776 | 16 | 122.3 | 176.7 | — | — | — | — | 0.68 | 4 | 7 | — | — | 1.13 | 239347 | — |
| run-9 | generated | yes | 107.7 | 44.6 | 38.7 | — | — | — | — | 69 | 0.684 | 0.557 | 10 | 107.5 | 188.3 | 0.86 | 0.316 | — | — | 0.05 | 8 | 0 | — | 0 | 0.55 | 128050 | — |
<!-- bench:rows:end -->

## Provenance of the backfilled rows (runs 4–9)

Runs 4–9 predate this harness. Every cell above was produced by running it over
the archived `report.json` of each run on the generation host
(`relay/run/out-4` … `out-9`) — **no number in the table was copied from the run
ledger's prose.** Where the ledger and the reports disagree, the disagreements
are recorded here rather than reconciled by hand:

- **Run 4's call count.** The ledger says "7 calls"; run 4's report has no
  `calls` field at all (`G-30 (c)` added it after that run), so the cell is `—`.
- **Run 5 was `outcome: "generated"` and not a Foray.** Its `detail` reads
  `INVALID … D5 FAIL …` — the pipeline produced a candidate and
  `check-forays.mjs` refused it (F-80). The `valid` column asks the driver's own
  question (`detail` starts with `OK `), which is why run 5 reads `no`.
- **Run 5 has no candidate on disk**, only a checkpoint and a partial, so its
  clip columns are `—`. Its `narrationCallsPerBeat` is also absent: that run's
  report carries only the older `callsPerBeat` (requests per *attempted page*),
  a different denominator, and the harness does not substitute one for the other.
- **`stageSum m` (the column once headed `wall m`) is the sum of the stage
  durations, not wall time (TM-10).** `generateForays.ts` writes `entry.ms` as
  `outcome.timings.reduce((sum, t) => sum + t.ms, 0)`, and the acts narrate
  concurrently, so every overlapping narrate stage is counted in full. On run 9
  four narrate stages ran side by side and the sum reads 107.7 min where the
  clock read 44.6. An earlier version of this note called `ms` the driver's
  per-prompt elapsed, padded by relay waits; that was wrong. For runs 5, 6 and
  7 the sum agrees with the ledger's window to a tenth of a minute (40.6 / 55.0
  / 63.9 min against 40.6 / 55 / 64); for runs 8 and 9 it is longer than the
  window the ledger records (91.1 and 107.7 min against ~46 and ~32).
- **`elapsed m` is first stage start to last stage end.** A report that
  carries `elapsedMs` (the per-run log's own figure) is read as is; an older
  report gets the span of its `veracity.stageTimings`, leaving out any stage
  marked `resumed` (its start is an earlier attempt's clock). Run 9 is the only
  backfilled run whose report carries stage timings, so it is the only row with
  a number: 2,676,202 ms, 44.6 min. Runs 4–8 are `—`, not zero. The ledger's
  ~32 min for run 9 is the window the operator watched, not the span of the
  report's own stages; the table carries the report's.
- **`ttlA1 m` agrees with the ledger on every run that quotes it** (21.2, 20.4,
  34.0 min for runs 6, 7, 8). Run 5's 0.1 min is the artefact the ledger names:
  act 1 was banked, so the resumed run had a playable partial immediately.
- **`tier`, `1stAudio s`, `allReady s` and `minLead s` are `—` on every
  row** (GV-52): runs 4–9 predate both the tier field (GV-01) and the
  `delivery` block (GV-33). The rows are otherwise exactly what they were; the
  four cells sit after `ttlA1 m`.
- **Cost is `—` on every row** and will stay that way until a keyed run records
  `usage`. §1.2's cost row is an estimate, and D0 is where it stops being one.
