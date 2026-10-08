# Restart prompt

Paste this after `/clear` to resume the redesign without losing progress.

---

Resume the 4a Redesign 2026 effort, fully unattended: no questions, no approvals,
no stopping. Your worktree is
`C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`
(call EnterWorktree with that path if you are not already in it). Read
`docs/redesign-2026/RESTART.md` there and follow it exactly. Keep your own context
small: delegate reading, building and verifying to agents and workflows.

---

## Day 3 (from 2026-10-07 06:40 PDT): back on Claude, Codex reviews

The overnight Codex driver was too slow (about 4 units in 7 hours) and is stopped; never run it
beside the workflow. The build runs as a Claude workflow: Sonnet builds and fixes, Codex
reviews (thin Claude agent -> `codex exec`, up to 3 rounds, Opus if Codex fails), Fable/Opus
judge, 4 screens in flight per direction (one per screen family), merges one at a time.
Runs: `wf_8c930d5d-182` (06:40-09:19, died on the weekly limit: foundation to 7/8), then
`wf_d90d5c98-c0e` (16:10 to 05:50 on 10-08: 18/35 screens, stopped when the disk filled), then
`wf_00d839e8-3c4` (06:20-06:00, stopped for the token fixes), then **`wf_91b5c34d-c58`**
(from 2026-10-08 06:30 PDT, script @ 19b7b152: cleans up its own worktrees, stops starting
screens under 4 GB free, build/fix agents on a context + turn budget; launched with
`maxIters: 3`). **On every relaunch pass the already-merged screens in `args.skipScreens`** (list them with
`git log origin/feature/redesign-2026-<dir> --merges --grep "into feature/redesign-2026-<dir>"`):
otherwise each one costs an agent just to discover it is merged (~120k tokens apiece).
**Project management is part of the job, not optional** (owner, 2026-10-08,
after one night cost 45% of the weekly plan and filled the disk): beside every run, start
`node docs/redesign-2026/workflows/pm-watchdog.mjs <run transcript dir>` with
`run_in_background`; it costs no tokens and exits with one line (DISK / STALL / ERRORS /
RUNAWAY / STUCK / BURN) when something needs action. Act on it, then re-arm it. Before any
relaunch, audit tokens per role (`node docs/redesign-2026/workflows/token-audit.mjs <run transcript dir>`:
agent transcript, group by label prefix) if spend looks high. If the disk fills anyway: stop the run,
remove finished `wf_*` worktrees whose HEAD is on origin with plain `git worktree remove`
(literal paths, never `--force`), relaunch. Launch / relaunch (same args every
time; merged units are skipped by git, interrupted units continue from their pushed branch):

```
Workflow({ scriptPath: "<worktree>\\docs\\redesign-2026\\workflows\\build-directions.workflow.js",
  args: { directions: ["tactile", "ambient"], screenConcurrency: 4, maxIters: 4,
    plansFile: "<worktree>\\data-local\\redesign\\codex-driver\\plans.json" } })
```

On resume: `git pull --ff-only`; if the run is still going (same session: `/workflows`; new
session: its `journal.jsonl` under this project's `subagents/workflows/<run id>/` is still
growing), wait for its notification. If it died, relaunch as above; if it dies twice at one
screen, add it to `args.skipScreens` and record it under **Blocked** in PROGRESS.md. When it
finishes, do step 6 below. Check `build-directions.stub.mjs` (plain and `STUB_DEAD=1`) after any
script edit. The section below is history.

## Night 2, continued (from 2026-10-06 23:00 PDT): the build runs on Codex

**If `PAUSE.md` exists at the worktree root, follow it first; it outranks this file.**
Claude's weekly usage ran low (91% at 22:31 PDT, resets 2026-10-07 16:00 PDT), so the Claude
workflow below (`wf_7ee4833f-b81`) was stopped after merging `p3-tokens` in both directions, and
phases 3-5 continue in a detached **Codex build driver**:
`docs/redesign-2026/workflows/build-directions.codex.mjs` (`run` / `status` / `rejudge`; how it
works and how to relaunch it: `docs/redesign-2026/workflows/CODEX-DRIVER.md`). It is
interchangeable with the workflow (same branches, same `Merge redesign/<dir>-<unit>` commits, so
merged units are skipped by either). Steps 3-7 below are superseded by the driver while it runs:
never run the driver and the workflow at the same time. Lean on Codex for build work; keep
Claude for taste and orchestration.

## Night 2 (from 2026-10-06): build Tactile and Ambient (phases 3-5)

The owner picked **Tactile and Ambient** and approved Tactile's header font,
**Big Shoulders** (2026-10-06 20:55 PDT). The owner is asleep: every decision is
yours or the direction's art director's (Fable). Anything that truly needs a human
goes into `HUMAN-ACTIONS.md` (invoke the human-actions skill) and you route around it.

1. **Worktree.** Work only in the worktree above, on `feature/redesign-2026`.
   `git pull --ff-only`.
2. **Read** `docs/redesign-2026/PLAN.md` and `docs/redesign-2026/PROGRESS.md` only.
   Do not read anything else yourself unless you are about to edit it.
3. **Is a build run already in flight?** If PROGRESS.md lists one, check its state
   with one agent (direction branches `feature/redesign-2026-tactile` and
   `feature/redesign-2026-ambient` on origin, their `Merge redesign/<dir>-<unit>`
   commits, `docs/redesign-2026/directions/<dir>/BUILD-PLAN.md`). If it is still
   running, wait for its notification. If it died, relaunch it exactly as in step 4:
   units already merged into a direction branch are skipped automatically.
4. **Launch the build** (only if no run is live):

   ```
   Workflow({
     scriptPath: "C:\\Users\\Fourtys\\Documents\\Claude\\Projects\\foray\\.claude\\worktrees\\redesign-2026\\docs\\redesign-2026\\workflows\\build-directions.workflow.js",
     args: {
       directions: ["tactile", "ambient"],
       prep: [{
         direction: "tactile",
         instruction: "Finalise the Tactile prototype for the owner's font decision (the note at the top of docs/redesign-2026/directions/tactile/DIRECTION.md). In docs/redesign-2026/directions/tactile/prototype/: make Big Shoulders the display and title face using the Big Shoulders values in BUILD-NOTES.md section 1; delete font-preview.js and font-preview.css and their script/link tags; delete the Anybody, Dela Gothic One and Archivo WOFF2 files, @font-face rules and tokens; update prototype/README.md. Re-shoot with node tools/ui-lab/shoot.mjs --target url --url <file URL of prototype/index.html> --routes #/home,#/mini,#/now-playing,#/search,#/library,#/foray,#/onboarding --scheme light --out data-local/redesign/shots/tactile/r8 and confirm with pngjs that the Home background pixel is #F7F0E4. Republish the Tactile artifact https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK in place: load the artifact-design skill first, read the live artifact first (action read, no path), rebuild the bundle under data-local/redesign/checkpoint/bundles/tactile/ as docs/redesign-2026/checkpoint/build-checkpoint.mjs does (fonts inlined), publish with url and files, keep the title. Add one PROGRESS.md log line."
       }]
     }
   })
   ```

   Then add an **In flight** entry to PROGRESS.md (run id, what it does, how to
   relaunch), commit that one file, push.
5. **While it runs:** wait for the workflow's notification; do not poll it and do not
   start background `gh run watch` loops (Claude Code reaps them when memory is low on
   this machine; check a CI or lab run with one-off `gh run view` commands instead).
   Don't commit in the trunk worktree while the workflow runs, except PROGRESS.md.
6. **When it finishes:** verify with one agent: direction branches exist and carry
   the merged units; dispatch `gh workflow run ci.yml --ref feature/redesign-2026-<dir>`
   for each direction and report the Linux jobs; check the lab-build runs it
   dispatched (`gh run list --workflow lab-build.yml`). Then update PROGRESS.md
   (phase table rows 3-5, a log line per direction with merged/escalated/not-merged
   units, Fable call count under "Fable invocations"), commit, push, and end with a
   short morning report. If a unit was not merged, say which and why; do not hide it.
7. **If the workflow dies twice at the same unit:** relaunch with that screen in
   `args.skipScreens`, record it under **Blocked** in PROGRESS.md, and keep going.

**Standing rules.** Never push to `main`, never open a PR into `main`, never push
`v*` tags, never dispatch `release.yml`, `pages.yml` or `android-release.yml`.
`lab-build.yml` is allowed (`--ref main -f ref=feature/redesign-2026-<dir>`); both
directions ship to the same "4a Lab" app, so the newest build replaces the previous
one on Play and sits beside it in TestFlight. No paid tools. Fable is authorized for
art-director calls in phases 3-5 (owner, 2026-10-06); log the count. `git add`
explicit paths only; never `git restore` / `checkout --` / `clean` / `reset --hard` /
bare `git stash`. Update PROGRESS.md and push after every deliverable.
