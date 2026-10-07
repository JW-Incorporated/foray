# Redesign 2026 Codex driver

The standalone driver runs phases 3–5 for each direction in parallel, with each
direction's foundation, screens, QA, and lab deliveries kept sequential. Run it
from the `feature/redesign-2026` checkout:

```powershell
node docs/redesign-2026/workflows/build-directions.codex.mjs run --directions tactile,ambient --max-iters 4
```

Add `--skip-screens id,id` to omit screen IDs. `--dry-run` uses only scripted
in-process fakes and an OS temporary directory; it performs no git/network/gh
mutation and asserts the resume, failure, review, judge fallback, lab, QA, and
blocking paths.

## Status, resume, and stop

Status is read-only:

```powershell
node docs/redesign-2026/workflows/build-directions.codex.mjs status
```

It shows the lock PID and liveness, current worktree-backed steps, per-direction
counts, Claude cooldown, successful Fable count, lab URLs, and the last 15 log
lines. Detailed state and step artifacts live under
`data-local/redesign/codex-driver/` (`state.json`, `summary.json`, `run.log`, and
`steps/`). On real runs, step worktrees use short names under `~/fw`
(`C:\Users\<user>\fw` on Windows) to leave enough path length for the deepest
Android sources. Dry runs keep their fake worktrees inside the OS temporary
directory. Both `status` and `run.log` show the full worktree path for each
active step.

To resume after a crash or reboot, run the same `run` command. A live lock is
refused; a stale lock is taken over. The driver checks merge commits on the
remote direction branch and skips completed units. If a work branch has commits
not in the direction branch, the implementer checks out that remote branch and
finishes it instead of starting over. This makes the remote git branches the
authoritative recovery record even if local state is lost.

To stop, get the PID from `status`, then stop the driver and its current child:

```powershell
taskkill /PID <pid> /T /F
```

The next run recognizes the leftover lock as stale. Clean step worktrees are
removed normally. A worktree with uncommitted files is deliberately left in
place and named in `run.log`; the driver never force-removes or cleans it. While
running on Windows, a hidden child requests system-awake execution state and
releases it when the driver exits; it does not change power-plan settings.

## Differences from the Claude workflow

All implementation, checking, fixing, review, merge, QA, and plan-extraction
work uses explicitly tiered `codex exec` calls and fresh git worktrees. Taste
judgments remain on Claude: Fable first for fidelity and Opus for pairwise
judging, with Codex plus image attachments as the automatic fallback. A Claude
failure starts a 30-minute cooldown, after which Claude is tried again. Every
verdict records its engine; an unavailable verdict is `UNJUDGED`, never silently
treated as evidence of a pass.

Git verifies merged-unit skips and verifies every claimed merge on the remote.
The driver itself dispatches only `lab-build.yml`, records its URL, and serializes
`PROGRESS.md` commits on the trunk. Three consecutive null implementers block
only that direction. No model is trusted with this bookkeeping.
