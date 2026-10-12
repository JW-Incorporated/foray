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
| `elapsed m` | ≤ 6 min p50 | **proposed (D0)** | §1.2 prompt → finished, validated Foray, keyed after Phase 3. First stage start to last stage end: the report's `elapsedMs` when it carries one, else the span of `veracity.stageTimings` (stages marked `resumed` left out) |
| `ttlA1 m` | ≤ 0.5 min p50 | settled | §1.2 prompt → Act 1 playable (fix plan WS-D); §1.2 itself says the deck cannot reach it and names **D6** as the re-baseline |
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

## The trend

| run | outcome | valid | stageSum m | elapsed m | ttlA1 m | calls | tapeSh | tape/rt | clips | clip mean | clip max | pg/seam | narrSh | 1stPg | 1stBt | 1stPass? | unver | synth | seedLost | introRe | call/bt | tokens | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
<!-- bench:rows:begin -->
| run-4 | no-tape | no | 4.4 | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| run-5 | generated | no | 40.6 | — | 0.1 | 49 | — | — | — | — | — | — | — | — | — | 0.67 | 2 | — | — | — | — | 100380 | — |
| run-6 | generated | yes | 55.0 | — | 21.2 | 72 | — | 0.598 | 11 | 142.6 | 237.8 | — | — | — | — | 0.73 | 4 | — | — | — | 0.80 | 128592 | — |
| run-7 | generated | yes | 63.9 | — | 20.4 | 84 | — | 0.595 | 10 | 102.5 | 181.4 | — | — | — | — | 0.55 | 10 | — | — | — | 1.03 | 156534 | — |
| run-8 | generated | yes | 91.1 | — | 34.0 | 78 | — | 0.776 | 16 | 122.3 | 176.7 | — | — | — | — | 0.68 | 4 | 7 | — | — | 1.13 | 239347 | — |
| run-9 | generated | yes | 107.7 | 44.6 | 38.7 | 69 | 0.684 | 0.557 | 10 | 107.5 | 188.3 | 0.86 | 0.316 | — | — | 0.05 | 8 | 0 | — | 0 | 0.55 | 128050 | — |
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
- **Cost is `—` on every row** and will stay that way until a keyed run records
  `usage`. §1.2's cost row is an estimate, and D0 is where it stops being one.
