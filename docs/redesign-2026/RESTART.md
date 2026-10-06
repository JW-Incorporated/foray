# Restart prompt

Paste this after `/clear` to resume the redesign without losing progress.

---

Resume the 4a Redesign 2026 effort, running fully unattended: no questions,
no approvals, no stopping. Anything that needs a human goes into HUMAN-ACTIONS.md
and you route around it.

1. Work only in the worktree
   `C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`
   on branch `feature/redesign-2026`. If the session is not already there, call
   EnterWorktree with that `path`. Then `git pull --ff-only` on the trunk.
2. Read `docs/redesign-2026/PLAN.md` (rules and decisions) and
   `docs/redesign-2026/PROGRESS.md` (status, in-flight runs, blocked items). Do not
   read anything else yourself unless you are about to edit it. Keep your own
   context small and delegate reading, building and verifying to agents and
   workflows, which return short summaries.
3. For each run listed under **In flight**: if it is still running, wait for its
   notification. If it finished, check its deliverables on disk via an agent.
   If it died, relaunch the unfinished part; every step is written to skip
   outputs that already exist.
4. Continue with the next phase in PLAN.md. The owner has authorized
   multi-agent workflows with up to 20 concurrent agents, Fable for Phase 2 art
   directors, and Mac CI minutes as needed. Paid tools are not authorized.
5. At the Phase 2 checkpoint: publish the prototypes and a comparison page as
   private artifact links, file a HUMAN-ACTIONS item for the pick, then keep
   doing direction-independent work (0d, 0e, harness). Do not wait idle while
   such work remains.
6. Update PROGRESS.md and push after every deliverable. Never push to `main`, never
   open a PR into `main` from redesign work, never push `v*` tags.
