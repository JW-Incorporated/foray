# Task: add a `rejudge` subcommand to the Codex build driver

You are dispatched from the trunk checkout of the 4a Redesign 2026 effort
(`C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`, branch
`feature/redesign-2026`). **The build driver may be running from that checkout and writing
PROGRESS.md there, so do not edit or commit in it.** Instead: from it, `git fetch origin
feature/redesign-2026` and `git worktree add -c core.longpaths=true --detach
C:\Users\Fourtys\fw\dev-rejudge origin/feature/redesign-2026` (put `-c core.longpaths=true`
before `worktree` if your git wants it there), work only in that new worktree, and deliver with
`git fetch origin feature/redesign-2026 && git rebase origin/feature/redesign-2026 && git push
origin HEAD:feature/redesign-2026` (retry the fetch/rebase/push once if the push is rejected
because the driver pushed a PROGRESS.md line meanwhile). When pushed, remove the worktree with
`git worktree remove` (no `--force`; if it refuses, leave it and say so).

Read `docs/redesign-2026/workflows/build-directions.codex.mjs` and `CODEX-DRIVER.md` beside it,
and `build-directions.workflow.js` for the original semantics.

## Why

Overnight, Claude usage runs out, so the driver falls back to Codex for the taste verdicts
(art-director fidelity, beats-today judges) and may mark some units UNJUDGED. The judges were
calibrated on Claude (Opus) and the art directors are Claude Fable. After Claude's usage resets
(2026-10-07 16:00 PDT) every screen merged without a full set of Claude verdicts must be re-judged
by Claude, and fixed where Claude disagrees.

## Behaviour

```
node docs/redesign-2026/workflows/build-directions.codex.mjs rejudge --directions tactile,ambient [--dry-run]
```

- Takes the same `driver.lock` as `run` (refuses while a `run` is alive; `run` must likewise refuse
  while `rejudge` holds the lock), so the two never touch a direction branch at the same time.
- Candidates: taste units (screens; not foundation, not QA fixes) recorded in state.json as merged
  whose verdicts include any `codex` engine or that are `unjudged`, and that have not already been
  re-judged (record `rejudged: {at-iteration, engines, result}` per unit).
- Per candidate, sequential within a direction, directions in parallel:
  1. Check step (as in buildUnit, Codex, effort medium) but against `origin/<dirBranch>` (the
     merged state), producing the implementation / prototype / today / side-by-side shots for
     that screen under `<ROOT>/loop/<d>/<id>/rejudge/`.
  2. Claude verdicts only (fidelity: Fable then Opus; beats-today: Opus, both orders). If Claude
     is unavailable, stop the rejudge run cleanly (do NOT fall back to Codex: the whole point is a
     Claude verdict) and log that it should be rerun later.
  3. If faithful and beats today in both orders: record `rejudged ... pass`.
  4. Otherwise build a follow-up unit with the same `buildUnit` machinery, work branch
     `redesign/<d>-<id>-rejudge`, acceptance criteria = the screen's original acceptance plus the
     Claude findings (deviations / judges' reasons), taste=true, so it loops implement -> check ->
     Claude judges -> fix -> review -> merge exactly like a normal screen, and its merge message
     stays `Merge redesign/<d>-<id>-rejudge into <dirBranch>: ...` (merged-unit skip by git works
     on relaunch).
- PROGRESS.md lines (through the driver's existing serialised trunk writer): one per candidate
  result and one summary per direction.
- `status` shows rejudge candidates remaining per direction.

## Test

Extend the existing `--dry-run` scenarios: a codex-judged unit that passes Claude re-judging; an
UNJUDGED unit that fails it and gets a follow-up unit merged; Claude unavailable mid-run -> clean
stop with remaining candidates reported; lock contention with a live `run`. Assertions inside the
dry run, non-zero exit on mismatch. Make one deliberate mutation (e.g. allow a Codex fallback
verdict in rejudge), show the dry run fails, revert it.

## Rules

Touch only the driver file and CODEX-DRIVER.md. Commit with explicit paths only, in your own
worktree, delivered as described at the top. Never push to `main`, no PR into `main`, no `v*`
tags, no `git restore` / `checkout --` / `clean` / `reset --hard` / `stash`. Don't modify
`mobile/VERSION`. Don't commit anything under `data-local/`. Do not run the driver for real.
Report: commit sha, dry-run assertions, mutation result.
