# Codebase audit, 2026-09-14

**Status:** point-in-time audit at the founder's request. Six lanes, run in
parallel against `main` at `b669a04`, each by its own agent with a read-only
brief. This file is the synthesis; it does not supersede any deck.

The founder's ask, which defines what counts as a finding:

> "audit the code base. Does everything work together well for all these
> pipelines? Any dirty bandaids in place? Make sure it's all cohesive and
> clean."

Every finding below carries a `file:line`. Where a lane reasoned rather than
read, it is marked **inferred** and says what would prove it. Findings that
were already filed as issues, or already written into a deck, were excluded by
brief and are not repeated here.

---

## 0. The verdict in one paragraph

This codebase is in better shape than a repo that merged thirty PRs in four
days has any right to be. Constants are derived and cite their derivation,
refusal vocabularies are closed sets, the two search matchers are pinned
against each other over the real catalogue, the generation pipeline typechecks
clean end to end, and every generated artefact with a real generator is
byte-identical to what its generator produces today. There is almost no rot.

What there is, in every single lane, is **the same failure shape**: a fix
applied once where it was found and not carried to the identical line
elsewhere. The rendered-audio bug that #686 fixed on two platforms had four
siblings in the same file. The `answered` cache guard exists on one of three
passes. The unconditional position flush exists on one of two stores. The
allowlist in `CLAUDE.md` drifted below the allowlist in code. Narration moved
from a beat to an act and the things that *grade* narration were not all moved
with it.

**That is the finding to act on.** It is not a code-quality problem, it is a
process one: work is dispatched per-symptom, and a symptom is usually one
instance of a class. The cheapest correction is a rule — when you fix a line,
grep for the shape and fix every instance, or say in the PR why the others are
different.

---

## 1. The highest-value findings, across all lanes

Ordered by what they cost a listener, not by lane.

### 1.1 Search cannot reach shows the phone is already holding

`app.js:4218` — `if (showIndex && shown().length < SHOW_PREFIX_UNDERDELIVERS_BELOW) {`

The local index scan is suppressed whenever the prefix pass already returned
ten rows. That gate was sound when the comparator read the **bucket** first.
Card P-08 then interposed a **match tier above the bucket**, and the gate was
never revisited.

Measured against the committed `data/show-index.tsv`: query `daily` returns 25
local rows, the scan is skipped, and **The Daily** — `chart_rank` 1,
`show_id` 1200361736, physically present in the index on the device — is
absent from the client's answer entirely. With the scan it appears at 17 of
218. The same holds for `history`, `american`, `money` and `science`.

This is a **reach** gap and is distinct from P-09 and P-10, which are ranking
gaps. P-10 explains why The Daily lands at 17. It does not explain why it is
missing at any position. Off-network, or in the ~250 ms + RTT window before the
endpoint answers, the device cannot reach a row it is holding.

`tools/search-probe.mjs:179-184` already instruments this gate and reports it
**purely as a latency saving** — "never paid in the app" — because nobody asked
what the skip costs in reach.

### 1.2 `setBodyClass` destroys four classes that are supposed to outlive a render

`app.js:772` — `document.body.className = \`${base} ui-v2\`;`

Written wholesale on every page render. Four classes that outlive a render are
destroyed and nothing re-adds them: `fp-open`, `fp-expanded`, `fy-sheet-open`,
`kb-open`. Writers at `player/client.js:1043`, `:1536`, `:1303` and
`app.js:9681`; consumers at `styles.css:1161`, `1355`, `1358`, `1504`, `1590`,
`2250`.

Three user-visible consequences, all of which the founder has since reported or
will:

- After navigating while something is playing, the now-playing bar loses its
  bottom reservation and covers the last row of the page.
- The bottom search pill docks about 96 px too low, i.e. **behind** the
  mini-player — precisely the overlap PR #683's header argues is impossible.
- `--kb-inset` is written to `<html>` and survives every render while `kb-open`
  is written to `<body>` and does not, so the two halves of one decision
  disagree after any render. `installKeyboardChrome`'s own comment claims they
  are "written from the SAME evaluation… so the two can never disagree".

### 1.3 A paused episode that is backgrounded forgets where it was

`player/client.js:1647` — `if (current && isPlaying()) manager._persistPosition();`

The episode position is written on background **only while playing**. Pause,
then background, and it is never written, so the position comes back minutes
stale. The line directly below flushes the **Foray** store unconditionally,
with a comment explaining exactly why a paused Foray must remember where it
was. One rule, two stores, applied to one.

Filed with three sibling symptoms as issue **#689**.

### 1.4 A rate-limited reply is cached as the answer for the whole session

`app.js:4902` — `episodeSearchQueryCache.set(cacheKey, data);`, guarded only by
`if (data)`.

`api/episodes/search.ts:355-365` replies **HTTP 200** with
`{ episodes: [], degraded: true, error: "rate limit exceeded" }`. The bucket is
20/min per warm instance and the endpoint fires on every debounce tick, so
trips are routine. The empty list is then remembered as the answer for that
query for the rest of the session.

The comment thirty lines above states the rule this breaks
(`app.js:4533-4538`): *"ONLY SUCCESSFUL RESPONSES ARE CACHED … a failure
remembered as an answer would turn one bad moment on a train into a permanently
empty Episodes section."* The correctly-guarded directory pass sits 45 lines
below (`app.js:4325`). Same hole in the show catalogue pass at
`app.js:4257-4260`.

### 1.5 The Episodes section is 60-90 % shorter than it needs to be

`app.js:4898` — `api/episodes/search?q=…&limit=10`

Apple's `entity=podcastEpisode` endpoint returns far fewer rows than the limit
when the limit is small. Measured:

| query | rows @ limit=10 | rows @ limit=50 |
|---|---|---|
| `history` | 4 | 37 |
| `true crime` | 6 | 46 |
| `sleep` | 9 | 37 |

The mapping drop rule is not the cause; it eats 0-1 rows at every limit.

### 1.6 `manifest-autofix` runs PR-authored code from a governed path with a write token

`.github/workflows/manifest-autofix.yml:67-70` checks out the **PR head** with
default `persist-credentials: true` under `permissions: contents: write` +
`actions: write`, then runs `node tools/ci/generate-manifest.mjs --write`.

`tools/ci/` is DENIED in `tools/ci/path-policy.mjs:76-82` **precisely so a
change there needs a human merge first**. This workflow executes the unmerged
version. The other three governance workflows each refuse exactly this and say
why in a comment: `path-policy.yml:88-104`, `automerge-nightly.yml:129-136`,
`pr-hygiene.yml:111-116`.

### 1.7 `path-policy` is enforcing but not required, so it blocks nothing

`gh api repos/JW-Incorporated/foray/rulesets/19713996` →
`"required_status_checks":[{"context":"backend"},{"context":"data-and-site"}]`,
`required_approving_review_count: 0`.

`path-policy` runs with `PATH_POLICY_ENFORCE=1` and goes RED on an unapproved
governed path — and is not a required context, so the PR merges anyway. Every
DENIED-path PR this week went red and merged. `api` is likewise not required,
and `tools/ci/run-suites.mjs:114-116` asserts that it *is*, contradicting
`ci.yml:58-60`.

**Fix is settings-only: add `api` and `path-policy` to `required_status_checks`.**
Both are `if:`-free in practice and already report on every PR into main. This
is the single highest-value fix in that lane and it needs no code. **Held for
the founder** — it changes what he can merge too, and it should not land while
agents have PRs in flight.

### 1.8 The interruption diagnostic channel has never delivered an event

`mobile/plugins/foray-tts/ios/.../ForayTtsPlugin.swift:210` emits `session`
events (phone call, route change, media-services reset) on the **`ForayTts`**
plugin name. The only `session` subscription is bound to **`ForayAudio`**:
`mobile/plugins/foray-audio/web/foray-media-session.js:123` and `:772`.

So no TTS session event has ever arrived. Three things document the channel as
wired: `diagnostic-log.js:552` admits `"tts"` as a producer, `client.js:308`
claims both plugins are re-broadcast, and an invariant test asserts the event
name **string** matches — which it does, on a channel with no listener.

Android has none of it at all: `grep -r "AudioManager\|AUDIOFOCUS\|BECOMING_NOISY"
mobile/plugins/*/android/` returns nothing.

This is card M-03's entire "why did it stop?" channel, and it is why issues
#224, #548, #688 and #689 each restart the diagnosis from scratch. That is
issue #264 in one sentence.

---

## 2. Lane by lane

### 2.1 Generation pipeline

**Verdict.** One driver, every stage typed to the next, every dependency
injectable, `tsc --noEmit` exit 0, no `TODO`/`FIXME`/`HACK`/`XXX` anywhere in
`backend/src/generation`, no per-show or per-foray special cases, and every
retry loop provably bounded. What it lacks is a clean seam after the Q-deck:
narration moved from a beat to an act in four days and the things that measure,
validate and report on narration did not all move with it.

**The class that matters — grading the new thing with the old ruler:**

- `veracityMetrics.ts:761` — both Q-05 listening KPIs walk
  `flattenWrittenPages`, which covers only `act.slots[].beats[]`. The two seam
  items the stitcher adds per act come from `DeepenedAct.introduction`/`.exit`
  and never appear in a `WrittenAct` (`stitchForay.ts:185`). They ship, they
  count in runtime, and they are missing from the KPI — **8 narration items on
  a 4-act Foray**. So the deck's own success numbers do not measure what they
  claim.
- `veracityMetrics.ts:504` — `computePagesDropped` still asks
  `decideConnectiveNarration`, the pre-Q-02 per-**beat** rule that `decideIntro`
  replaced. A clip correctly given no intro is counted as a dropped page.
- `veracityMetrics.ts:258` — `firstAttemptUnit` **sniffs the output** to decide
  which era measured it, and mislabels the worst per-act runs as page-measured.
- `veracityMetrics.ts:751` — the KPI Q-05 moved to, tape share of runtime, is
  computed **nowhere in the pipeline**; the only implementation is an offline
  harness (`tools/generation-bench/run.mjs:424`).

**Correctness:**

- `writeAct.ts:756-758` — a truncated writer reply silently **deletes a clip's
  introduction** instead of failing. `stop_reason` is never inspected and
  `parseOrRepairJson` closes the brackets, so a cut-off reply parses as a valid
  short `seams` array and a missing seam becomes `seam.silent = true`. "The
  writer never answered" is recorded as "the writer chose silence", with no
  retry and no warning. The Q-02 headline feature ships missing.
- `writeAct.ts:755` — `delete seam.confirmed;` discards a verification the
  verifier already granted, against the promise at `:419` that "the confirmation
  stands if the writer leaves it alone". A later mechanical refusal then
  downgrades an already-good page to `verified: false`.
- `sourceBeats.ts:1493-1495` — **the same tape can be minted twice as two
  overlapping clips**. `mergeIntoClip` returns `null` for five non-distance
  reasons and the walk falls through and mints a normal second clip; the only
  positional guard admits any `startSec >= lastStart`, so a window *inside* the
  previous clip mints a clip that replays it. Nothing downstream catches it.
- `finalizeForay.ts:610` — a candidate is failed on errors in **other** Forays'
  on-disk curation artifacts. Latent today (0 errors measured), and under the
  abort-on-refused-partial default one red artifact ends a run at act 1.
- `check-forays.mjs:1190` — `if (!p.role) continue;` makes rules L2/L3/L4 and D4
  inert on every generated Foray, because nothing in the tail ever writes
  `role`. Q-01's 1,800 s clips clear L3's 480 s ceiling **by accident**.

**Bandaid whose cause is already fixed:** four seams are justified by a claim
that Vitest cannot load the `.mjs` checkers under a path with a space
(`runPipeline.ts:153-155`, and cited again at `finalizeForay.ts:497`,
`partialCandidate.ts:176`, `runPipeline.ts:395`). Measured: `npx vitest run
test/finalizeForay.test.ts` in this checkout passes **9 of 9**, including the
case that drives both real checkers. The claim is false here and is the stated
reason for an injection seam that can go.

**Dead:** nine orphans of the beat→act retirement, each with zero importers —
including `replayMechanicalGate` (`writeAct.ts:517`, 55 lines, confirmed dead by
three independent sweeps) and `smoothActs` (`smoothSeam.ts:96`, whose own header
says "NO PRODUCTION CALLER SINCE F-66"). Plus a legacy `d5-pair`/`d5-triple`
checkpoint vocabulary whose only justification is a resume that
`CHECKPOINT_VERSION = 2` makes impossible.

Also: `phonemize.ts` describes itself as a live stage and has **zero production
callers** — K-02's bundled-voice work is built, tested, and not wired.

### 2.2 Search

**Verdict.** Two decks in three days and the core held. There are exactly two
show matchers (`search-engine.js` and `backend/src/catalog/searchBreadthShows.ts`)
and they are pinned hard: `backend/test/breadthCatalog.test.ts:361-403` buckets
all ~19,904 real catalogue titles through **both files' actual bytes** and
asserts row-for-row order equality at the `limit` cut. No rule was found in one
and absent from the other. No third matcher exists anywhere in the tree.

The damage is on the edges the decks touched last. Beyond §1.1, §1.4 and §1.5:

- **Episodes diverge with no pin.** Server matches **title only**
  (`api/episodes/search.ts:220`); the client fallback matches **title OR
  description** (`app.js:2400`). `searchShowEpisodesScoped` asks the server
  first, so a description-matching query returns nothing on the happy path and
  starts working when the feed fetch fails.
- **The test for that rule is poisoned.** `test/show-page-search.test.js:320` is
  *named* "matching title **or description**", but every fixture is built with
  `description_text: ""` (`:296`) and the only query run matches a title.
  Deleting `|| desc.includes(q)` leaves the suite green. A test whose name
  asserts a rule its body never exercises is worse than no test.
- **Cache keys ignore the limit.** `app.js:3903` keys on query text alone while
  three caches use two different limits; both server caches already include the
  limit.
- **A header documents a deleted gate as current fact.**
  `api/shows/appleShowSearch.ts:24-29` note (2) still says the endpoint calls
  Apple "only when the full 19,904-row merged catalogue also found nothing. Two
  independent gates, and neither is optional" — removed by P-02, corrected only
  by note (6) forty lines below.

### 2.3 Playback and the native bridge

**Verdict.** Well-reasoned — derived constants with run IDs, closed refusal
vocabularies, a genuinely parallel three-way plugin. But the #686 bug class is
**not unique**: four more values are written on one side of the bridge and
dropped on the other, and one crosses in **different units on each platform**
while being judged against a single 400 MB ceiling.

Beyond §1.8:

- **`peakMemoryBytes` is a different quantity on each platform and is a
  *current* reading on both**, yet it is the sole input to one of K-01's four
  go/no-go conditions. `ForayTtsPlugin.swift:1059` returns `phys_footprint`
  (whole-process, current — the peak field is `ledger_phys_footprint_peak`);
  `ForayTtsPlugin.java:985` returns `getNativeHeapAllocatedSize()` (malloc heap
  only, excluding the mmap'd model and the JVM). `availableMemoryBytes` has the
  same problem: bytes-before-jetsam versus JVM heap headroom, printed as one
  "headroom" number.
- **Android never closes the probe's ONNX session**
  (`KokoroOrtProbeEngine.java:171`), stranding ~90 MB per run and polluting the
  next run's memory reading — which makes it a correctness bug in the
  measurement above, not only a leak.
- **The probe report has a battery line no native half can fill.**
  `kokoro-probe.js:343` reads `batteryDeltaPct`; neither plugin writes it. That
  is why the founder's pasted reading ended `batt —`.
- **`overridesApplied` is the #686 shape again.** iOS computes a bounds-checked
  count of overrides actually applied (`ForayTtsPlugin.swift:656`) and the web
  half discards it, substituting the **requested** count
  (`web/foray-tts.js:235`). On Android `ipaOverrides` is counted
  (`ForayTtsPlugin.java:201`) and **never applied**, so the field reports
  lexicon corrections that were never made.
- **Neither native has a single test asserting a probe result key.**
  `mobile/plugins/foray-tts/android/src/test/` does not exist. The #685 bug was
  Android reading `out[0]` and not `out[1]`, and **there is still no test that
  would fail if `audioColdSec` were dropped from the result map again.** Both
  platforms have an injectable `probeEngine` seam put there for exactly this, so
  both are provable in CI, not on a device.
- **`ended` has no iOS representation.** Android maps it to
  `Player.STATE_ENDED`; iOS collapses it to `playbackRate = 0`, indistinguishable
  from `paused` on a lock screen or car display.
- **A malformed passage and a broken graph report the same sub-code.** A phoneme
  line of ≤2 ids returns `zero-samples`, which the closed vocabulary defines as
  "the output tensor was empty" — re-creating the ambiguity #686 spent a whole
  layer removing.
- **`fetch-models.mjs:350`** has no timeout, no retry and no `AbortSignal`, and
  runs for 14 files (~92 MB) on every mobile CI build; a hung connection stalls
  the job to its 60-minute ceiling.

### 2.4 App shell and UI

**Verdict.** The shell survived ten fixes in a day better than expected. The
removed code is genuinely gone rather than dangling, the duplicate-`id` bug
class is now correctly guarded at the two sites it bit, `!important` appears
exactly once with a documented reason, no listener is registered per render, and
the z-index ladder is documented in one place with every new layer registered.
The five PRs all leaned on `<body>` classes as their coordination medium, which
is what makes §1.2 load-bearing.

Beyond §1.2:

- **`#rate-sheet` is the one fixed-id mount with no guard** (`app.js:7390`,
  appended unguarded at `:7426`) and is not closed on navigation. A hardware
  Back leaves it mounted; returning and tapping again mounts a **second**
  `#rate-sheet` — the exact bug shape that reddened the browser suite, in the
  one place #682 did not look. The player's own rate picker gets this right
  (`player/client.js:1265`).
- **Navigating from the drawer while the Now Playing sheet is expanded strands
  it open with its close button hidden.** The drawer is above the player by
  design, `route()` closes the drawer but nothing collapses the sheet, and
  §1.2 then wipes `fp-expanded` so the ✕ vanishes. The only exit left is the
  drag gesture.
- **#682's back-step scroll restore is lost on every asynchronously-rendered
  page** (`app.js:9192`). `renderForay` paints a ~50 px placeholder
  synchronously, so `scrollTo` clamps to 0 — the identical clamping failure
  #682 measured and fixed for forward navigation.
- **The Shows-page search debounce timer outlives the page** (`app.js:4357`).
  Module-level token and timer; navigate away and back inside 250 ms and the old
  query's results paint into the new page.
- **`renderInterests` bypasses `setBodyClass` and drops `ui-v2`**
  (`app.js:541`), against that function's own header rule — so `#/interests`
  renders on the v1 palette.
- **`installKeyboardChrome`'s teardown does not cancel its pending
  re-evaluation** (`app.js:9694`), so a timer queued microseconds earlier
  re-adds `kb-open` with nothing left running to correct it.

**The test gap that would have caught three of these:** nothing asserts that a
body class survives a page render. Two existing tests pin the **CSS text** by
parsing selectors; neither runs a render and re-reads `document.body.className`.
Node-suite provable with the existing harnesses.

### 2.5 CI, governance and release

**Verdict.** Unusually well-built — the path policy is one tested module driving
both merge routes, the floor mechanism is pinned bidirectionally to the CI
runner and reads FLOORS as **source text** to catch a duplicate key silently
lowering a floor, and every gate script invoked from a workflow is either denied
or acknowledged with a written reason. The model nonetheless does not hold, for
the reasons in §1.6 and §1.7.

**Two of the four "known gaps" are not real as stated.** Worth recording,
because they have been repeated in briefs:

1. *"Merges to `main` do not run CI; Playwright is PR-only."* **False.**
   `ci.yml:4-5` is `push: branches: [main]` and has been since `dcf05ed`
   (2026-07-07); the `playwright` job carries no `if:`. Measured: the last 60
   push-to-main CI runs are `[{"k":"success","n":60}]`. The real residual is
   **notification** — nothing alerts on a red main push. Cheapest fix is an
   `if: failure()` step that opens an issue, about eight lines.
2. *"A PR conflicting from birth gets no workflows."* Real GitHub behaviour, but
   **already handled** — `tools/ci/pr-triage.mjs:376-423` emits `dispatch-ci` for
   a head SHA carrying none of the required checks, and `pr-hygiene.yml` labels
   it `merge-conflict`. The only open such PR (#648) is labelled correctly and
   has a full set of checks. The residual is that the self-heal runs only on the
   6-hourly sweep, leaving an up-to-6-hour window where the PR looks unchecked.

**Real and confirmed:** `npm test` does not scan `*.spec.js`
(`run-suites.mjs:122` — `SUITE_RE = /\.test\.(js|mjs|cjs)$/`). Agents have twice
reported green while Playwright was red, and the repo has already paid for it:
the duplicate-onboarding bug reached a state where only the un-run suite could
see it. **Do not widen `SUITE_RE`** — that breaks the bidirectional pin. Add a
`test:browser` script and one sentence to `CLAUDE.md`.

Other findings:

- **The five Playwright spec files have no floor**, sit under the ALLOWED `test/`
  prefix, and are invisible to the floor scan — a bot PR can delete all eleven
  browser assertions with every check green.
- **Two checks publish `skipped` under their own names** and would become holes
  if promoted: `ios-kit` (`ci.yml:94`, measured `skipped` on PR #648's head) and
  `automerge-decision`. `pr-triage.mjs:184-188` already reasons correctly about
  why a skip satisfying a required check is dangerous.
- **A same-day release re-run reproduces the duplicate-build-number rejection
  `version.mjs` was written to retire.** `release.yml:172` uses
  `github.run_number`, which is unchanged on a re-run; `run_attempt` is not in
  the expression. Result: identical `YYYYMMDDnn` for both stores, App Store
  Connect `-19232` and a duplicate Play `versionCode`.
- **The release lockstep guard cannot fire on the most likely disagreement.**
  `release.yml:264` evaluates only when both platforms report `ready`. If the
  `ios` job fails or times out while `android` uploads, the `else` at `:271`
  prints "this is a documented-absent state, not a failure" and the summary
  exits 0. Play gets a build, TestFlight does not, and the guard says nothing.
- **`CLAUDE.md`'s ALLOWED enumeration is three entries stale** — it omits
  `HUMAN-ACTIONS-DONE.md`, `deploy-manifest.json` and **`sw.js`**, the last of
  which the policy file itself calls "the highest-privilege script on the
  origin". Nothing tests the enumeration.
- **121 tests across 183 floored suites can be deleted with every check green**
  (floors below actual counts). Zero floors are above actual, so nothing is red.
- **`ci.yml` is the only workflow with no `concurrency:` block**, so a SHA can
  carry two runs each publishing the required checks, and the last to finish
  wins.
- **`ios-build.yml`'s probe chain can degrade to measuring nothing and stay
  green, by explicit design** (`:517`, `:533`, `:555` `continue-on-error`, and
  `:828-831` "exits 0 for every verdict including the bad ones"). The reasoning
  is sound; the consequence is that "iOS CI is green" can mean "we learned
  nothing".

### 2.6 Data layer

**Verdict.** Better than the brief assumed. **Every artefact with a real
generator is byte-identical to what its generator produces today**, verified by
regenerating into scratch and diffing: `catalog-client.json` (0 differing
bytes), `show-index.tsv` (byte-identical, 446,334 B, 10,113 rows, 206,746 B
gzip against a 400 KB budget), `deploy-manifest.json` (47/47 sha256 match the
committed blobs, `deploy_id` recomputes exactly), `forays-directory.json` (all
three byte counts and hashes match, `version` == `deploy_id`).

**Two premises in the brief were out of date and are corrected here.** The
`main()`-guard bug that let a Windows contributor commit a stale
`catalog-client.json` is **fixed** (`build-catalog-client.mjs:143` uses
`pathToFileURL`), and issue #327 is **fixed** — `segments.json` is sliced (76 of
255), and `COPIED_WHOLE` is now `["data/item-tags.json"]` alone.

**The seed-vs-live confusion is genuinely closed.** `seedPointerDoc` stamps
`partial: true` and `assertSlicesOnDisk` re-reads the written pointer and demands
that shape; `foray-directory.js:439` refuses `current` for any held set with
`partial !== true`.

Findings:

- **`data/topic-coverage-report.json` is 23 days stale** (`built_at`
  2026-08-21 against inputs from 2026-09-13) and is the one generated artefact
  with **no `--check` and no CI gate**. Regenerating shifts priority-1 topics
  2→6 and `absent` coverage 48→30.
- **`duration_sec` is read by the player and written by nothing** — 0 of 289
  items in `data/forays.json` carry it, so all 157 narration items fall through
  to a `script.length / 17` estimate.
- **`vercel.json`'s immutable cache rule can never fire** — it requires a `?v=`
  query that nothing emits, so 400,008 B of data always serves
  `max-age=0, must-revalidate`, and four tests guard a path production never
  takes.
- **`vercel.json:9` names `data/shows-index-pointer.json`, which does not
  exist** — and a complete committed pipeline (`tools/shows/`,
  `shows-import.yml`, five files) has never produced it. The same line ships
  `data/catalog-breadth.json` (12.5 MB) into every serverless function bundle.
- **26.5 MB of the 74.5 MB in `data/` has no producer or consumer in code** —
  `catalog-breadth-intl.json.gz` (13.8 MB) and `episode-archive.json.gz`
  (12.8 MB), each referenced only by an exclusion assertion or a prose comment.
- **`episode_count` ships to every client and nothing reads it** (6,197 B
  committed, 4,437 B bundled), and 53 of 220 values are `null`. The test that
  pins "exactly the six fields `renderShow()` reads" pins the drift in place.
- **Three separate sources of truth for "what data ships"** — two hand-maintained
  lists (13 and 14 entries) and one derived (10), kept in sync "by design".

**Bundle weight today:** 1,641,554 B from `data/`, 52 % of the 3,145,728 B
ceiling. `discover.json` is at 87 % of its own budget and grows nightly;
`show-index.tsv` is at 85 % of its budget and is 27 % of the data bundle.

---

## 3. What was checked and found clean

Recorded because "we looked and it was fine" is worth as much as a finding, and
because it stops the next audit re-treading it.

- **`tsc --noEmit` over the whole backend: exit 0.** No type-level incoherence
  between any stage output and the next stage's input.
- **No `TODO`/`FIXME`/`HACK`/`XXX`/`@ts-ignore`/`as any`/commented-out code** in
  `backend/src/generation` (~35 files), in `app.js`, or in `styles.css`. One
  `TODO` in the whole player lane, correctly scoped.
- **No special case keyed on a show, episode, or foray id** anywhere in the
  generation pipeline, either search matcher, or the shell.
- **Every retry loop in generation is provably bounded**, and the
  `settledActs`/act-gate race does not exist (the promise resolves one microtask
  before the next act is released).
- **The two show matchers agree rule by rule**, pinned over the real 19,904-row
  catalogue, and the dedup keys are character-for-character identical across the
  wire.
- **The paint race in search is genuinely closed** — no ordering of index-load,
  catalogue, directory and scan loses rows, and `mergeShowRows` only ever
  appends, so a failed pass structurally cannot shorten the list.
- **No duplicated literal `id` in any `#view` template**, and no per-render
  global listener registration — every global listener is installed once in
  `init()`.
- **Every catch in the generation lane degrades honestly** — all are documented
  cache-miss or re-validate-and-redo paths, not swallowed failures.
- **The release guard is correct** — `releaseGuard()` fails closed on every
  unknown event, and the ancestry half is a real `git merge-base --is-ancestor`
  against `origin/main`, not an inference from the event payload.
- **`android-bundle` refuses to call an unsigned build signed** — verifies with
  `jarsigner`, cross-checks signature block counts, greps the Gradle log for the
  keystore password and deletes the log rather than uploading it, shreds the key
  with `if: always()`, and fails when `lintVitalRelease` was skipped rather than
  executed.
- **Both PR fact-gatherers refuse a truncated file list**, naming the 3000-file
  REST cap explicitly.
- **Production byte integrity holds** — dist copies data verbatim and hard-fails
  if the recomputed `deploy_id` differs from the committed one.

---

## 4. The recommendation

Three things, in order.

**1. Adopt a grep-the-shape rule.** Every finding class in §1 is a fix that was
applied once and not carried. Make it explicit: when a PR fixes a line, it
greps for the shape and either fixes every instance or says in the body why the
others are different. This is one sentence in `CLAUDE.md` and it is the highest-
leverage change in this document.

**2. Make the ruleset match the written rules.** §1.7 is settings-only and takes
one API call. Until it lands, the governance model is advisory and `CLAUDE.md`
describes a review that does not happen.

**3. Connect the diagnostic channel.** §1.8 is why four separate playback
reports each began from zero. It is a small wiring fix on iOS and a real piece
of work on Android, and it converts every future report from an investigation
into a lookup.

Everything else in this document is ordinary work that can be scheduled.
