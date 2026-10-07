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
