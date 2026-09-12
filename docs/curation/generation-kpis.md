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
| `wall m` | ≤ 6 min p50 | **proposed (D0)** | §1.2 prompt → finished, validated Foray, keyed after Phase 3 |
| `ttlA1 m` | ≤ 0.5 min p50 | settled | §1.2 prompt → Act 1 playable (fix plan WS-D); §1.2 itself says the deck cannot reach it and names **D6** as the re-baseline |
| `tapeSh` | ≥ 0.70 | **proposed (D0)** | §1.2 tape share of runtime |
| `tape/rt` | — | — | not a §1.2 row; the reading §1.2 *quotes* (see below) |
| `clip mean` / `clip max` | — | — | Q-01 cuts a clip to a thought inside 60–1,800 s; no §1.2 target |
| `pg/seam` | ≤ 1 | **proposed (D0)** | §1.2 narration pages per seam |
| `narrSh` | ≤ 0.25 | **proposed (D0)** | §1.2 narration share of runtime |
| `1stPass` | ≥ 0.80 | settled | §1.2 first-attempt page pass rate |
| `unver` | 0 | settled | F-51: any page kept `verified: false` refuses publish (`evaluateVeracityGate`) |
| `synth` | — | — | F-88 counts synthesis-verified pages *beside* the unverified ones; no target |
| `seedLost` | — | — | F-99 counts beats closed as seed-lost; no target, and no report written so far carries it |
| `introRe` | 0 | settled | Q-02: the writer is refused in code for a page that repeats the clip it introduces |
| `call/bt` | ≤ 1.5 | settled | §1.2 narration calls per beat |
| `tokens` | ≤ 50,000 | settled | §1.2 pipeline tokens; §1.2 says **D6** re-baselines it |
| `cost $` | ≤ $10 | **proposed (D0)** | §1.2 cost per Foray, inside `EPISODE_BUDGET_USD`. Empty on every run so far: `ReportEntry` carries no `usage` block, and the harness will not turn §1.2's "[estimated] ≈ $1–4 per attempt" into a measurement by multiplying tokens by a list price |

### The two numbers both called "tape share"

They are different quantities and the table prints both.

- **`tapeSh`** is `meta.veracity.tapeShare` — Q-05's `computeListeningShares`:
  tape seconds over tape + narration seconds, as the writer estimated them.
  Present from run 9 on, because that is when the code landed.
- **`tape/rt`** is tape seconds over the candidate's whole `runtimeSec`, which
  also counts jingles and markers. This is the reading §1.2 quotes — "59–61 %
  (runs 5–7), **78 %** (run 8) [measured on `data/forays.json` @ #642]" — and
  the harness reproduces it from the archived candidates: 0.598, 0.595, 0.776,
  0.557 for runs 6, 7, 8, 9.

On run 9 the two read **0.684** and **0.557**. Collapsing them into one column
would put a step in the trend line on the day the report started carrying its
own number, so they stay apart.

## The trend

| run | outcome | valid | wall m | ttlA1 m | calls | tapeSh | tape/rt | clips | clip mean | clip max | pg/seam | narrSh | 1stPass | unver | synth | seedLost | introRe | call/bt | tokens | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
<!-- bench:rows:begin -->
| run-4 | no-tape | no | 4.4 | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| run-5 | generated | no | 40.6 | 0.1 | 49 | — | — | — | — | — | — | — | 0.67 | 2 | — | — | — | — | 100380 | — |
| run-6 | generated | yes | 55.0 | 21.2 | 72 | — | 0.598 | 11 | 142.6 | 237.8 | — | — | 0.73 | 4 | — | — | — | 0.80 | 128592 | — |
| run-7 | generated | yes | 63.9 | 20.4 | 84 | — | 0.595 | 10 | 102.5 | 181.4 | — | — | 0.55 | 10 | — | — | — | 1.03 | 156534 | — |
| run-8 | generated | yes | 91.1 | 34.0 | 78 | — | 0.776 | 16 | 122.3 | 176.7 | — | — | 0.68 | 4 | 7 | — | — | 1.13 | 239347 | — |
| run-9 | generated | yes | 107.7 | 38.7 | 69 | 0.684 | 0.557 | 10 | 107.5 | 188.3 | 0.86 | 0.316 | 0.05 | 8 | 0 | — | 0 | 0.55 | 128050 | — |
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
- **`wall m` is the driver's own per-prompt elapsed (`entry.ms`)**, not the
  operator's observed window. For runs 5, 6 and 7 the two agree to a tenth of a
  minute (40.6 / 55.0 / 63.9 min against the ledger's 40.6 / 55 / 64). For runs
  8 and 9 the report is longer than the window the ledger records (91.1 and
  107.7 min against ~46 and ~32), because `ms` spans everything the driver did
  for that prompt — the relay's answer-loop waits included — while the ledger
  timestamps the session the operator watched. The report's number is the one
  in this table because it is the one a scheduled bench can read.
- **`ttlA1 m` agrees with the ledger on every run that quotes it** (21.2, 20.4,
  34.0 min for runs 6, 7, 8). Run 5's 0.1 min is the artefact the ledger names:
  act 1 was banked, so the resumed run had a playable partial immediately.
- **Cost is `—` on every row** and will stay that way until a keyed run records
  `usage`. §1.2's cost row is an estimate, and D0 is where it stops being one.
