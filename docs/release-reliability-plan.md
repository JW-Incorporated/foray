# Release reliability — the plan

**Status, 2026-09-22 (updated same day):** all three pieces are built. Piece 1
shipped in PR #737 (the upload retry). Pieces 2 and 3 — the watchdog and the
trigger — are in PR #739 (`audit-fix/l7-release`), awaiting a founder merge because
they add `.github/workflows/` files. §6 says what was built and where it departs
from the design below. Neither piece does anything until that merge.

> **FOUNDER, 2026-09-22:** "It seems these releases are usually quite rocky and
> fail on a somewhat regular basis. Is there a better structure we can set up
> here, ideally one without any agent involvement required, which triggers
> appropriately, pushes things where they need to push, and monitors outcomes?
> […] the goal here is some lightweight script that doesn't require agent
> involvement unless something is fucked."

## 1. WHAT IS ACTUALLY WRONG — three defects, only one of them flakiness

Measured over the first 24 runs of `release.yml` (2026-09-06 → 2026-09-22).
Twenty succeeded, one was cancelled, **three failed**:

| run | date | outcome |
|---|---|---|
| `34042838342` | 2026-09-06 | android failed, ios uploaded |
| `34739630705` | 2026-09-13 | ios failed, android uploaded |
| `35672098914` | 2026-09-22 | ios failed, android uploaded |

That is an 87.5% success rate, which is not the story. **The story is that all
three failures were PARTIAL** — one store got the build and the other did not.
The two app stores have silently diverged on 12% of releases, and nothing in the
system says so afterwards.

Three separate defects, worth naming separately because they need different
fixes:

### D1 — Nothing triggers a release

All 24 runs were `workflow_dispatch` on `main`, every one started by a human (or
an agent typing `gh workflow run`). There are **zero `v*` tags in the repo**, so
the tag-push trigger in `release.yml:96-97`, the tag-matches-`mobile/VERSION`
assertion at `:151-160`, and the ancestry check in
`tools/mobile/release-ci.mjs:111-116` have never executed for real.

Consequence: merged fixes sit unreleased until somebody remembers. This has now
happened twice — eight fixes once, and sixteen hours on 2026-09-22.

### D2 — Nothing retries

`xcrun altool --upload-app` was invoked exactly once
(`.github/actions/ios-archive/action.yml`), with no loop and no
`continue-on-error`. So was the Play upload. Run `35672098914` lost a fully
built, signed, exported and version-verified archive to one `500` from Apple's
ingestion server.

**Fixed** in PR #737 — `tools/release/upload-retry.mjs`.

### D3 — Nothing notices

The 00:28 failure on 2026-09-22 was discovered sixteen hours later, by the
founder noticing the app was missing two fixes.

**And "the run goes red" is not a channel.** This is the most important finding
of the whole investigation, because it kills the obvious design:

- `nightly-refresh.yml` has failed its last three scheduled runs.
- `nightly-watch.yml` — the repo's existing watchdog — has failed its last three
  runs.
- `HUMAN-ACTIONS.md` #46, which is *about* those workflows not firing, has been
  open since 2026-09-13.

(Diagnosed later the same day, and it sharpens the point: both workflows fire
every day and are red ON PURPOSE. Every nightly-refresh run from 2026-09-15 to
2026-09-22 stopped at its `OVERWRITE_WOULD_LOSE` guard, because the Cloud routine
that turns a digest into a PR, `foray-nightly-enrich`, has been disabled since
2026-09-13 — so the 2026-09-14 digest was never consumed. The guards did their
job for eight days, correctly, and nobody saw. HUMAN-ACTIONS #46 now says so.)

Red runs are demonstrably not reaching a human here. `nightly-watch.yml:50-57`
already anticipated this in its own header: *"It does not open an issue, comment,
or page anyone… Routing that red somewhere noisier is a real improvement and a
separate decision, because it needs `issues: write` and a dedup rule."*

That decision is made below.

## 2. WHY NOT A SCRIPT ON THE FOUNDER'S LAPTOP

The founder offered this option explicitly ("perhaps it's just a script that runs
every hour on my computer"). It is the wrong home, for four reasons:

1. **The machine is off.** A watchdog that only runs when a laptop is awake is
   silent exactly during the overnight window when the nightly pipeline runs.
2. **It cannot act.** Dispatching a release needs credentials; the workflow
   already has them and a laptop script would need its own.
3. **The precedent is already here.** `nightly-watch.yml` +
   `tools/refresh/watch-nightly.mjs` is this repo's watchdog pattern, with a
   suite and a `FLOORS` entry. A second one should look like the first.
4. **GitHub is where the evidence lives.** The only durable record of what was
   last released is the `release.yml` run history — off-repo, and readable with
   `GITHUB_TOKEN` and nothing else.

All of it goes in GitHub Actions, keyless, per CLAUDE.md decision-authority
item 1.

## 3. THE DESIGN

### Piece 2 — the watchdog (`tools/release/watch-release.mjs` + `.github/workflows/release-watch.yml`)

Modelled on `watch-nightly.mjs`. Keyless: `contents: read`, `actions: read`,
plus `issues: write` for the alarm. Four gates:

| gate | red when |
|---|---|
| **G1 failed** | the newest *completed* release run has `conclusion != success` and no newer success exists, for more than a 60-minute grace |
| **G2 divergent** | that run's `ios` and `android` job conclusions disagree while both credential gates reported `ready` |
| **G3 stalled** | the oldest release-relevant commit on `main` not contained in the last successful run's `head_sha` is older than 6 hours |
| **G4 stuck** | a release run has been `in_progress` for more than 60 minutes |

The API calls, all verified available to `GITHUB_TOKEN`:

- `GET /actions/workflows/release.yml/runs?per_page=10` — newest run, newest
  success. **No branch filter**: a tag-triggered run's `head_branch` is the tag.
- `GET /compare/{last_success_sha}...main` — `ahead_by`, `commits[]` (with
  dates), `files[]`. Caps at 250 commits / 300 files; **if the cap is hit,
  alarm** rather than reason from a truncated diff.
- `GET /actions/runs/{id}/jobs` — per-job conclusions. **Caveat, verified:**
  composite-action steps are opaque to REST. The `ios` job exposes only
  `Run ./.github/actions/ios-archive | success|failure`; `uploaded=true` and
  `state=ready` go to `$GITHUB_OUTPUT`/`$GITHUB_STEP_SUMMARY`, which REST does
  not return. To distinguish "green and uploaded" from "green because signing was
  absent", grep the job **log** (`GET /actions/jobs/{id}/logs`).

### Which commits need a release — an ALLOW-list, not a deny-list

This is the one place the design deliberately departs from
`tools/web/vercel-should-build.mjs`, and the reasoning inverts.

`vercel-should-build.mjs` is a deny-list because allow-list drift there *silently
stops deploying* a file that has started mattering — a production 404. Here the
failure modes swap: allow-list drift silently stops *nagging*, which is the
status quo and harmless, while deny-list drift produces **daily false alarms** —
and this repo's own doctrine is that a flaky alarm is worse than none
(`nightly-watch.yml:49-51`).

Concretely, reusing the Vercel deny-list would fire on `api/`, `vercel.json`,
`deploy-manifest.json`, `sw.js` and `data/forays-directory.json` — the last three
of which the manifest-autofix bot rewrites on **nearly every PR**.

Ground truth for "what reaches a store build" is executable, not a hand list:
`node tools/mobile/prepare-webdir.mjs --list` prints the 53-file plan, and
`buildPlan()` is exported (`prepare-webdir.mjs:506`). The allow-list is that
output **plus** the native inputs that never pass through `www/`:

- `mobile/**`
- `tools/mobile/{prepare-webdir,minify,inject-*,fetch-models,ios-embedded-frameworks}.mjs`
- `.github/actions/ios-archive/**`, `.github/actions/android-bundle/**`,
  `.github/workflows/release.yml`

…minus `*.test.*` and `*.md`.

Note on `data/`: the app reads the Foray directory live from the site at boot
(`prepare-webdir.mjs:154-161`), so Foray data changes reach phones **without** a
release, and `nightly-refresh` commits `data/discover.json` daily. Treat `data/`
as a low-priority "the bundled seed is stale" tier, never a release trigger.

### The alarm — one evolving issue

`issues: write` with `GITHUB_TOKEN`. **One sticky issue**, reopened and edited
rather than one per run — which is what `docs/DECISIONS.md:476-478` already asks
for. Opening or reopening it sends the founder a GitHub notification; closing it
when all four gates go green is how it stays quiet.

Rejected alternatives and why: Discord needs the out-of-repo `ha.py` on the
Hermes VM and a bot token (no Discord code, webhook or secret exists in this
repo); writing `HUMAN-ACTIONS.md` from CI cannot land on protected `main` because
a `GITHUB_TOKEN` PR triggers no checks (`tools/ci/pr-triage.mjs:48-57`); a PR
label needs a PR to hang off.

**The watchdog needs its own liveness check**, because HUMAN-ACTIONS #46 is
precisely the case of a scheduled watchdog silently not firing.

### Piece 3 — the trigger

A scheduled job — not a `push: main` trigger — that dispatches `release.yml`
when G3 says there is release-relevant work, `main` is green, and no release is
already queued or running (`release.yml` has `concurrency: release`,
`cancel-in-progress: false`).

Scheduled rather than push-triggered for three reasons: it batches naturally (the
four merges on 2026-09-21 between 15:57 and 00:27 become one release, not four);
it retries naturally; and each iOS run costs 4–19 macOS minutes, which bill at
10×, so per-PR releases would be worse than the founder's current same-day
cadence.

### ⚠️ THE BUILD NUMBER COLLIDES ON A RE-RUN — read this before automating anything

`release.yml:172` computes `RUN_OF_DAY=$(( (github.run_number - 1) % 99 + 1 ))`
and `version.mjs:139` makes `YYYYMMDDnn` from it. Despite the header at
`release.yml:33-35` calling it a "clamp", it is a **modulo wrap**, and
`github.run_number` is the workflow's lifetime counter, not a per-day one.

Consequences, both real:

1. **"Re-run failed jobs" produces the SAME build number** — the `version` job
   does not even re-execute, its cached outputs are reused. Apple then rejects
   the upload as a redundant binary. **So the fix for a failed release is a fresh
   dispatch, never a re-run**, and any automation must do that.
2. Two runs on the same UTC day whose `run_number`s differ by a multiple of 99
   collide.

This should be fixed independently of the automation.

## 4. ALSO FOUND, AND WORTH ITS OWN CARD

**A diagnostics record cannot say which build produced it.** The founder pastes
`playback diagnostics` to report bugs, and there is no build number anywhere in
the header — `app.js` carries no build stamp, and `sw.js`'s `BUILD_ID` is
excluded from the native bundle (`prepare-webdir.mjs:274`). This cost real time
twice on 2026-09-22: a fix merged, the upload failed, and the next field report
could not be placed against a build. Options and a recommendation are in the
2026-09-22 recon (`stamp` agent).

## 5. THE SUMMARY JOB'S CURRENT BLIND SPOTS

For whoever touches `release.yml:232-283`:

- If a platform job dies **before** its credential-gate step (npm install,
  Gradle, SPM resolve), its `state` output is empty, the summary falls into the
  "documented-absent" warning branch and **exits 0**. The run is still red
  because that job is red, but the summary itself does not flag it.
- If both platforms are `ready` and **both fail** to upload, the summary passes
  with "Both stores had credentials and agree (uploaded=false)".
- Play secret present + keystore absent yields `play_state=ready` but
  `uploaded=false`, which trips the "stores disagree" failure with no message
  naming the keystore as the cause.

## 6. AS BUILT (2026-09-22)

Files: `tools/release/watch-release.mjs` (every decision, pure and
dependency-free), `.github/workflows/release-watch.yml` (hourly, `:23`),
`.github/workflows/release-trigger.yml` (every 2 hours, `:47` — founder, 2026-09-23), a
`RELEASE_OUTCOME` line in `release.yml`'s summary step, and
`tools/release/watch-release.test.mjs` (floored), which replays the real
2026-09-22 night from real runs, the real summary-job log and real `git log`.
`tools/release/` is now on `DENIED_PREFIXES` — `upload-retry.mjs` runs beside the
App Store Connect key, and the trigger spends macOS minutes.

The gates are as designed in §3: G1 failed (60-minute grace), G2 divergent (both
credential gates `ready`), G3 stalled (6 hours), G4 stuck (60 minutes). The
numbers and their reasons are at the top of `watch-release.mjs`.

**The trigger** dispatches `gh workflow run release.yml --ref main -f bump=none`
when a release-relevant commit is waiting, and holds when a release is queued or
running, when nothing relevant is waiting (a data-only night says so), when the
last **2** releases in a row failed, or when main's own push-triggered runs are
red or still building. A failed release is retried the same way new work ships —
its commits are still waiting — so one transient store outage heals at the next
slot, and a second failure in a row stops spending 10×-billed macOS minutes until
a person looks. **It only ever dispatches; nothing in either workflow re-runs**,
and the suite pins that.

**The alarm** is one issue, found by an HTML marker in its body (so a person can
retitle it), created or reopened when any gate goes red, edited when the picture
changes, closed by the watchdog with a comment when every gate is green.

**Liveness.** The two workflows watch each other: a peer whose workflow `state`
is not `active` (the #46 banner) is red at once; a peer with no successful
*scheduled* run in 3 hours (watchdog) or 4 hours (trigger) is red. Both exit 0
whenever they managed to evaluate — the issue carries the verdict, the run colour
carries only "did the watcher work" — which is what makes "no recent success"
mean "down". The trigger may raise the issue for a dead watchdog but never close
it. A failure the two SHARE (they run one module) is invisible to liveness, so the
watchdog's issue step also runs after its own failure and raises the issue on the
second failed scheduled run in a row. **The honest limit:** if both workflows stop
firing together, or Actions is off for the org (billing), nothing inside GitHub
can say so.

**Departures from §3, both deliberate:**

- `git log` over the full-history checkout, not `GET /compare`. The compare API
  caps at 250 commits / 300 files and returns only the AGGREGATE file list, so it
  cannot say which commit touched what — and G3's clock is the oldest *relevant*
  commit. git has neither limit.
- G2 reads one `RELEASE_OUTCOME` line from the summary job's log rather than
  grepping each platform job's log. Runs from before that line existed are read
  from the runner's own echo of the summary step's `env:` block. Per PLATFORM, a
  blank state ("not reached": the job died before its credential gate) is
  unknown, not "not ready", and falls back to that platform's job conclusion —
  which is what catches §5's first blind spot (run 34042838342: android died
  before its gate, the summary job went green, G2 names it; replayed from that
  run's real summary log, which echoes `ANDROID_STATE: ` blank). Only an
  explicit non-ready state (`absent`, `partial`) is the documented gap. The
  summary log is also the one fetch allowed to fail: logs expire after 90 days,
  and G2's job-conclusion fallback does not need it.

**Still open, not built here:** the build number is still derived from the
lifetime `run_number` (§3's warning stands; the trigger simply never re-runs);
§4's build stamp in diagnostics; and §5's second and third blind spots in the
summary step itself — G1 already reds on every one of those runs, so they cost a
worse message, not a missed alarm.
