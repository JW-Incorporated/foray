# Redesign 2026 — progress

Source of truth for a cleared session. Update on every deliverable.

## Where things are

- Worktree: `C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`
- Trunk branch: `feature/redesign-2026` (pushed to origin)
- Plan and rules: `docs/redesign-2026/PLAN.md`
- Restart prompt: `docs/redesign-2026/RESTART.md`

## Phase status

| Phase | Status | Notes |
|---|---|---|
| Kickoff (STATE.md + HUMAN-ACTIONS via doc-only PR to main) | done | PR #1085 (auto-merges on green); HA #142 Apple lab setup, HA #143 Play lab setup |
| 0a Eyes | done | tools/ui-lab/ |
| 0b Judge | done | calibrated, accuracy 100% |
| 0c Test classification | done | docs/redesign-2026/test-classification.md |
| 0d Split app.js | done | merged 2614fc29; see split-notes.md |
| 0e Lab build path | merged into trunk (b74338a0) | owner setup complete |
| 1 Research | done | docs/redesign-2026/research/, design-brief.md |
| 2 Directions | not started | Fable art directors |
| Checkpoint | — | owner picks |
| 3–5 | — | after checkpoint |

## In flight

(Workflow run IDs and what they are doing. Clear an entry when it finishes.)

- **`wf_bab57673-e04` "redesign-2026-night-1"** — launched 2026-10-05 19:40 PDT.
  Runs 0a Eyes, 0b Judge, 0c Tests, 0d Split, 0e Lab, 1 Research, then 2
  Directions (5 Fable art directors: editorial, ambient, native-2026, tactile,
  clarity), Rank, and the checkpoint package (artifacts + HUMAN-ACTIONS PR).
  Its own git steps commit to the trunk and update this file as phases land.
  Script: `C:\Users\Fourtys\.claude\projects\C--Users-Fourtys-Documents-Claude-Projects-foray--claude-worktrees-redesign-2026\feb4d3af-2e95-4551-b3cf-e583135ec9ff\workflows\scripts\redesign-2026-night-1-wf_bab57673-e04.js`.
  If it died: relaunch with Workflow({scriptPath, resumeFromRunId: "wf_bab57673-e04"})
  (cached agents return instantly; works only in the same session). In a new
  session, check what is on disk and on origin (`redesign/p0-split`,
  `redesign/p0-lab`, `docs/redesign-2026/*`) and relaunch only the missing parts.

## Next actions (orchestrator)

- **Lab dry run.** The owner's Apple and Play setup is done (HA #142, #143,
  2026-10-05 19:45 PDT). As soon as `.github/workflows/lab-build.yml` is on main
  (the Lab agent's PR into main, which needs the owner's `founder-approved`
  label) AND `redesign/p0-lab` is merged into the trunk: dispatch
  `gh workflow run lab-build.yml -f ref=feature/redesign-2026 -f platforms=both`
  to ship today's design as "4a Lab" to Wyatt's iPhone and Joey's Android. That
  proves the delivery path before the redesign lands. If Play refuses the first
  upload of the new app, file one HUMAN-ACTIONS item with the AAB link and the
  console clicks.

## Blocked

(Item, reason, what would unblock it.)

## Fable invocations

(Date, phase, count, why. Owner-authorized 2026-10-05 for Phase 2 art direction.)

## Log

- 2026-10-05 — Plan approved by the owner in session; trunk branch created from
  `main` @ 3a9dfefa; PLAN/PROGRESS/RESTART written.
- 2026-10-05/06 — 0a Eyes done: screenshot + a11y harness at `tools/ui-lab/`.
- 2026-10-05/06 — 0b Judge done, calibrated, accuracy 100%: `docs/redesign-2026/judge/`.
- 2026-10-05/06 — 0c Test classification done: `docs/redesign-2026/test-classification.md`.
- 2026-10-05/06 — 1 Research done: `docs/redesign-2026/research/` (7 notes) and `docs/redesign-2026/design-brief.md`.
- 2026-10-05/06 — 0d Split app.js merged into trunk (2614fc29). node --check clean; run-suites had 10 Windows CRLF failures identical to the pre-merge trunk (not caused by the split).
- 2026-10-05/06 — 0e Lab build path merged into trunk (b74338a0). node --check clean; run-suites had the same 10 Windows CRLF failures as the pre-merge trunk (identical set, diffed), none new.
