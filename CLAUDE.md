# CLAUDE.md — Foray operating manual

Standing instruction set for every AI session in this repo. Read it fully before
doing any work. Foray is a **personal AI podcast curator**. Live site:
https://jw-incorporated.github.io/foray/ (GitHub Pages, deploys from `main` root).

## The company

Two founders + AI agents. No other staff. (Same operating model as our sister
project, Long Live / Swift2.)

- **Joey — CEO / Product.** What to build, what's valuable, what delights.
  Final call on product decisions and content principles.
- **Wyatt — CTO / Engineering.** Architecture, code health, releases, infra.
  Final call on technical decisions and deploys.
- **Claude Code** — planner and primary builder. Executes under the founders'
  authority; makes tactical calls without asking, strategic ones with approval.

Humans make strategic decisions; AI executes. Humans review **behavior and
outcomes**, not code line-by-line. Full role split: `docs/roles.md`.

## Decision authority — three things AI never does without explicit approval

1. **Merge/push to `main` or deploy.** `main` is protected (ruleset
   `protect-main`: PR + green `backend`/`data-and-site` checks, zero bypass).
   Work on a branch; propose via PR. Never push `main`, never force-push.
2. **Touch secrets, credentials, or production infra** (incl. deleting data).
   This repo's cloud automation is deliberately keyless — keep it that way.
3. **Spend money or change product direction.** Any new paid API, any deviation
   from the product principles below, goes to the founders first.

## Workflow rules (non-negotiable)

1. **Plan before building.** For any non-trivial feature, write a short spec
   (behavior, acceptance criteria, files affected) and get approval first.
2. **Work on a branch; never commit to `main`.** Merge only via PR.
3. **Test everything.** Add/update tests for every change; run the suite before
   declaring done. Never open a red PR.
4. **Document decisions.** Anything expensive to reverse (data model, stack,
   deploy, pricing) gets an entry in `docs/DECISIONS.md` before implementation.
5. **Knowledge lives in the repo.** Anything worth remembering goes in a file,
   not only a conversation. Update docs in the same change that makes them stale.
6. **Codify repetition.** If a procedural task recurs, write it as a committed
   script/command/test instead of re-doing it by hand (see `tools/refresh/` —
   this is exactly why the nightly pipeline was consolidated out of `data-local`).

## Verify before committing

- Backend: `cd backend && npm test` (includes `test/copyRules.test.ts`, which
  gates ALL user-facing copy in `data/*.json`).
- Site JS: `node --check app.js`
- Data integrity: CI (`.github/workflows/ci.yml`) validates all JSON + session
  episode refs on push.

## Product principles (supersede everything, including marketing findings)

1. **Curiosity/learning first; anti-echo-chamber.** Discovery surfaces keep a
   hard ~30% exploration floor. No engagement dark patterns (no streaks, no
   infinite scroll, no autoplay chains).
2. **State observed, never declared.** No config fields or manual "done"
   declarations where observation is possible. Commute length is a learned
   parameter, never UI copy.
3. **Legally boring.** Never rehost/proxy/transform episode audio; never strip
   ads; download via original enclosure URLs. Any "skip the sponsor" feature
   request triggers legal review.
4. **Copy rules:** why-lines ≤ 18 words, hooks ≤ 16; banned: "fascinating",
   "deep dive", "delve", "explores", clickbait withholding, commute-length
   framing. Stretch picks must state their bridge.

## Layout

- Root: static site (index.html, app.js, styles.css) + `data/*.json` (session
  doc v1, taxonomy, discover pool, catalog)
- `tools/refresh/`: the committed nightly pipeline (scan → resolve → merge).
  See its README; cloud topology in `docs/nightly-refresh-cloud.md`.
- `backend/`: Node/TS — ingest, dedup, cost metering, curation engine,
  session-builder CLI. Runs keyless in dry-run (StubEnricher); real keys go in
  root `.env` (gitignored).
- `ios/`: SwiftUI app + ForayKit Swift package (state machine + intent grammar,
  unit-tested). Builds only on macOS via XcodeGen. `// AUDIT:` marks unverified
  AVFoundation behavior.
- `docs/brief/`: original product spec (read first). `docs/adr/`,
  `docs/DECISIONS.md`: decisions. `docs/agents/`: runner prompts + registry.
  `docs/roles.md`: who owns what. `docs/marketing/`, `docs/research/`.
  `docs/ux/foray-m3-prototype.html`: current interactive UX reference for M3
  (onboarding, today menu, player, transitions, library, settings, etc.) — see
  `docs/ux/README.md`.

## Conventions

- All escaping in app.js goes through `esc()`; all href/src through `safeUrl()`.
  The page has a strict CSP — no inline styles/scripts.
- localStorage keys keep the legacy `cp_` prefix (renaming would wipe user state).
- `user_id` on every backend table and route — no single-tenant schema shortcuts.
- Every LLM call routes through the cost-metering budget guard.

## Automation

The nightly content refresh runs in the cloud (not on anyone's laptop): a keyless
GitHub Action scans/resolves and publishes a digest; a Claude Cloud agent authors
hooks/tags and opens a PR. Registry: `docs/agents/runners.md`. Topology:
`docs/nightly-refresh-cloud.md`.
