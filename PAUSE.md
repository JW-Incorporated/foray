# PAUSE — Redesign 2026, night 2 (written 2026-10-06 ~23:15 PDT)

Claude's weekly usage was at 91% and runs out overnight; it resets **2026-10-07 16:00 PDT**.
The build was moved onto Codex so it keeps going without Claude. Assume you remember nothing:
everything you need is here and in git. **Trust git and the driver's `status` over this file.**

## Where

- Worktree: `C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`,
  trunk branch `feature/redesign-2026`. `mobile/VERSION` shows modified: line endings only, leave it.
- Direction branches: `feature/redesign-2026-tactile`, `feature/redesign-2026-ambient`.
- Rules: `docs/redesign-2026/PLAN.md`. Progress board: `docs/redesign-2026/PROGRESS.md`.

## What is running (or ran)

**The Codex build driver**, a detached Node process (not a Claude workflow):
`docs/redesign-2026/workflows/build-directions.codex.mjs` (how it works:
`docs/redesign-2026/workflows/CODEX-DRIVER.md`). It runs phases 3-5 for both directions with
`codex exec` for every implement/check/fix/review/merge/QA step, and `claude -p` for the taste
calls (Fable art-director fidelity, Opus beats-today judges, both orders) while Claude has usage;
when Claude fails it marks Claude down for 30 min and uses a Codex judge instead, recording the
engine per verdict. It keeps the PC awake while it runs. State: `data-local/redesign/codex-driver/`
(`state.json`, `run.log`, `driver.lock` with the PID, `steps/`); step worktrees under
`C:\Users\Fourtys\fw\`.

Position when this file was written: foundation `p3-tokens` merged in both directions (by the
earlier Claude workflow `wf_7ee4833f-b81`, now stopped); `p3-icons` built on
`redesign/<d>-p3-icons` but not merged (the driver resumes it); then `p3-primitives`,
`p3-gallery`, the screens (tactile 19, ambient 16, order in
`data-local/redesign/codex-driver/plans.json`), QA, lab builds.

## On resume, in order

1. `cd` to the worktree, `git pull --ff-only`.
2. `node docs/redesign-2026/workflows/build-directions.codex.mjs status`
   - **Lock PID alive:** the driver is still building. Do not start another driver or the Claude
     workflow. It returns to Claude judges by itself after the reset. Go to step 4 only when it
     has finished; meanwhile you may do step 5's read-only checks.
   - **Lock PID dead and the run log does not end with `driver complete`:** it died. Relaunch it
     detached (PowerShell), same command; merged units are skipped by git, an interrupted unit
     continues from its pushed work branch:
     `Start-Process node -ArgumentList 'docs/redesign-2026/workflows/build-directions.codex.mjs','run','--directions','tactile,ambient','--max-iters','4' -WorkingDirectory <worktree> -WindowStyle Hidden -RedirectStandardOutput <worktree>\data-local\redesign\codex-driver\driver.out.log -RedirectStandardError <worktree>\data-local\redesign\codex-driver\driver.err.log`
     If it dies twice at the same unit, relaunch with `--skip-screens <id>` and record that
     screen under **Blocked** in PROGRESS.md.
   - **Finished:** go to step 3.
3. **Re-judge with Claude** what Codex judged overnight:
   `node docs/redesign-2026/workflows/build-directions.codex.mjs rejudge --directions tactile,ambient`
   (detached like step 2). It re-judges every merged screen whose verdicts include `codex` or
   that is UNJUDGED, with Claude only, and builds a fix unit for each one Claude rejects. If the
   `rejudge` subcommand does not exist yet (it was being added on 2026-10-06; check
   `CODEX-DRIVER.md`), dispatch Codex with the brief in
   `docs/redesign-2026/workflows/briefs/rejudge.md` first.
4. **Verify and report** (RESTART.md step 6): one agent checks both direction branches carry the
   merged units; `gh workflow run ci.yml --ref feature/redesign-2026-<dir>` for each direction,
   report the Linux jobs; `gh run list --workflow lab-build.yml` for the lab builds the driver
   dispatched. Update PROGRESS.md (phase rows 3-5, a log line per direction with merged /
   escalated / UNJUDGED / not-merged units, Fable count from `status`), commit, push, short report
   to the owner. Name every unit that was not merged and why.
5. Delete this file (commit the deletion) once each step above is genuinely picked up.

## Standing rules (unchanged)

Never push to `main`, never open a PR into `main`, never push `v*` tags, never dispatch
`release.yml`, `pages.yml` or `android-release.yml`; `lab-build.yml` only with `--ref main -f
ref=feature/redesign-2026-<dir>`. `git add` explicit paths only; never `git restore` /
`checkout --` / `clean` / `reset --hard` / bare `git stash`. No paid tools. Fable is authorized for
art-director calls in phases 3-5; log the count. Lean on Codex (`codex exec`, explicit `-m
gpt-5.6-sol` and effort per dispatch; `gpt-5.3-codex-spark` is NOT available on this account) for
build work; keep Claude for taste and orchestration.

## Session-local extra

A one-shot resume prompt was scheduled in the 2026-10-06 night session for 2026-10-07 16:07 PDT
(CronCreate job `576e2399`). It dies if that session closed. Either way: this file is in the repo;
say "resume" in a new session opened in the worktree and follow it.
