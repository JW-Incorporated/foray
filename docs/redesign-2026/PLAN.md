# Redesign 2026 — plan and standing rules

Every agent working on this effort reads this file first. It is the brief's
shared half: decisions, hard limits, and where things go. Progress lives in
`PROGRESS.md` beside it; the restart prompt for a cleared session is
`RESTART.md`.

**Goal.** Take 4a (formerly Foray) from "meh" to a gorgeous, fully researched
2026 app that can earn App Store featuring, built as a working, testable app
that runs **beside** the current one, not instead of it.

## Owner decisions (Joey, 2026-10-05, in session)

1. **Every founder ruling may be challenged** by a design direction: dark-only,
   4 tabs + drawer IA, no zoom, card anatomy, section order, palette. A direction
   that overturns one must say so explicitly; the owner decides at the pick.
2. **Up to 20 concurrent agents** authorized (root CLAUDE.md default is 5).
3. **No paid tools.** No Prolific, no image-generation API, no designer, no
   font licences, no Mobbin. Taste validation = the owner plus people around
   him. Free/OFL fonts only.
4. **App icon is out of scope.** Lab builds use today's icon with a LAB badge.
5. **Mac CI minutes: fine, as needed.**
6. **Fable 5.1 for the art directors** (Phase 2 only). Logged in PROGRESS.md.
7. **Devices:** Joey = Android phone, Wyatt = iPhone. **iPad out of scope.**
8. **One checkpoint**, after Phase 2: the owner picks the directions to build
   (2 recommended).
9. **Run unattended.** No questions, no approvals overnight. Anything that
   needs a human goes to `HUMAN-ACTIONS.md` (on main, via the kickoff PR) and
   the work routes around it.
10. **Token-efficient.** The orchestrating session keeps a small context;
    agents do the reading and building and return short summaries.
11. **The current app must not be affected** (see Isolation).

## Isolation — the current app stays untouched

- Trunk branch: `feature/redesign-2026`. Work branches: `redesign/<phase>-<task>`,
  merged into the trunk, never into `main`.
- **Never open a PR into `main` from redesign work.** A PR into main touching only
  allow-listed paths auto-merges on green and then ships to TestFlight within
  ~2h (`release-trigger.yml`). PRs, if any, target the trunk.
- Never push a `v*` tag. Never dispatch `release.yml`, `pages.yml`,
  `android-release.yml`.
- Lab app identity: iOS bundle id `ai.jwlabs.foura.lab`, Android applicationId
  `ai.jwlabs.foura.lab`, display name `4a Lab`. It installs beside the real app.
- **Lab builds must not write to production.** The client posts anonymous
  sign-ups and event rows to Supabase (`app.js` `/auth/v1/signup`,
  `/rest/v1/events`). Lab builds turn event sync and anonymous sign-up off.
  GET calls to the catalog/search API stay (read-only, harmless).
- Exception, doc-only: one kickoff PR to main adds the STATE.md workstream entry
  and the HUMAN-ACTIONS items. It touches no app code.

## Hard limits still in force (directions may not challenge these)

- Security: every interpolation via `esc()`, every href/src via `safeUrl()`,
  strict CSP (no inline `style=`/script, no `javascript:`), localStorage only via
  the shim with `cp_` keys (renaming wipes user state).
- Product principles 1–4 in CLAUDE.md: ~30% exploration floor, no streaks, no
  infinite scroll, continuous playback allowed, state observed not declared,
  legally boring (never rehost/transform audio), copy rules (why ≤18 words,
  hooks ≤16, banned words; no "we/us/our"; "subject" not "topic").
- Accessibility: 44px tap targets, focus management in sheets, one
  reduced-motion block covering every transition, WCAG AA contrast.
- **Public repo:** never commit third-party screenshots, competitor imagery or
  other copyrighted reference material. Those live in `data-local/redesign/`
  (gitignored). Commit only our own words, our own code, and our own renders.
- No new secrets in git. No paid services.
- Testing discipline from CLAUDE.md "A green test is not evidence until you have
  broken it": name and run the mutation for every new test; a new
  `*.test.{js,mjs}` suite needs its floor in `test/suite-integrity.test.js`.
- `git add` explicit paths only (blanket `git add -A`/`.` is guard-denied).
  Never `git restore`/`checkout --`/`clean`/`reset --hard`. Never bare
  `git stash`.

## Phases and deliverables

| Phase | What | Output (all under the trunk unless noted) |
|---|---|---|
| 0a Eyes | Playwright screenshot harness: every route × state × viewport, frozen clock, seeded data, network stubbed | `tools/ui-lab/` (scripts, README); renders in `data-local/redesign/shots/` |
| 0b Judge | Written rubric, pairwise judging protocol, calibration against reference apps | `docs/redesign-2026/judge/` (rubric, protocol, calibration report); refs in `data-local/redesign/refs/` |
| 0c Tests | Classify every UI-touching suite: keep (hard limit) vs rewrite-on-purpose (pins today's look) | `docs/redesign-2026/test-classification.md` |
| 0d Split | Split `app.js` into per-screen classic scripts, behaviour-preserving, all suites green | `app/` (or `ui/`) scripts, `index.html`, test helper, `prepare-webdir`, `sw.js` |
| 0e Lab | Lab build path for iOS (TestFlight, separate app) and Android (Play internal, separate app); lab flag turning off production writes; LAB badge icon | workflow file + `tools/mobile/` changes; needs owner setup (HUMAN-ACTIONS) and `founder-approved` once |
| 1 Research | Competitors, 2026 platform design (iOS 27 Liquid Glass, Material 3 Expressive), featuring criteria, our own docs/audits/corpus, brand | `docs/redesign-2026/research/*.md` + `design-brief.md` |
| 2 Directions | 4–6 named art directions (Fable), clickable prototypes of the hero screens using real data and artwork, 3 critique/revise rounds, judge ranking | `docs/redesign-2026/directions/<name>/` (brief + prototype); checkpoint package |
| — | **Checkpoint**: owner picks | HUMAN-ACTIONS item |
| 3 Foundation | Tokens incl. motion, SVG icon sprite, primitives, component gallery = regression baseline | per chosen direction |
| 4 Build | Screen-by-screen build loops (implement → screenshot → judge → fix), Now Playing first | one branch per direction: `feature/redesign-2026-<direction>` |
| 5 QA + kit | Adversarial QA, perf budget, regression baselines, store screenshots/copy (no icon) | |

While the checkpoint waits, only **direction-independent** work continues
(0d, 0e, harness hardening, baseline machinery).

## Agent roster

| Role | Model | Why |
|---|---|---|
| Orchestrator (main session) | Opus 5.5 | Judgment, integration, verifying agent claims |
| Researchers | Sonnet | Volume web + repo reading |
| Engineers (harness, split, lab) | Sonnet, isolated worktrees | Bulk code work; worktrees stop collisions |
| Art directors | **Fable 5.1** | Taste is the ceiling task |
| Prototype builders | Sonnet | Turn a direction into HTML |
| Judges / critics / reviewers | Opus | Taste and code-review judgment |

Judges compare **pairwise** against the rubric, never absolute scores, and the
rubric is trusted only after calibration: it must rank reference apps above
today's 4a and above deliberately degraded variants.

## Progress protocol

- After finishing a deliverable: commit it (explicit paths), push the branch,
  and add one line to the PROGRESS.md log (date, what, where, commit).
- Report blockers in PROGRESS.md under **Blocked** with the reason, then move on.
- Never stop to ask. Make the call, write it down, keep going.
