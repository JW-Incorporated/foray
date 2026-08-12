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
   Exception (added 2026-07-30, see `docs/roles.md` § Merge authority):
   for PRs scoped to product/content/UX, Joey may direct Claude to merge
   once required checks are green, without waiting on Wyatt. This does not
   extend to anything touching architecture, infra, secrets, or CI/CD —
   those still require Wyatt's approval. This exception is provisional
   pending Wyatt's sign-off.
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
7. **On auto-merge paths, review before PUSH — not before merge.** A PR that
   touches only `data/`, `docs/`, `player/`, `tools/`, `test/`, `app.js`,
   `styles.css` or `search-engine.js` has auto-merge enabled and lands the
   moment checks go green (`.github/workflows/automerge-nightly.yml`), so there
   is no window in which to review it. Do the reviewer pass — subagent or your
   own re-read — before `git push`. PR #147 (corpus scraper infra) merged before
   its planned review could start; that review then found a must-fix chunker bug
   which cost a follow-up PR. Label a PR `hold` if you need the window back.

## Never babysit your own PR  (KEEP VERBATIM — starter-kit invariant)

**Open the PR and stop.** Do not arm a `send_later`, a self-check-in, a
Monitor, or any "come back and look at this again" wake-up, and do not
subscribe to PR activity to wake on it. This applies to every session in this
repo — scheduled runners, Joey's sessions, Wyatt's sessions.

**Why:** in Swift2 these self-armed loops reached **~69% of all scheduled agent
token spend** — ~144 cloud sessions/day whose entire output was "still open,
still green, re-arm in 1h". Nothing in any prompt asked for it; the agents
armed it themselves. They left no trace in git, issues or CI, because each was
told not to comment when nothing changed.

**You don't need it.** CI gates the merge, auto-merge lands content PRs the
moment they go green, and the account-wide auditor alerts if a runner goes
dark. If a PR fails CI or hits a conflict, the next scheduled run of that agent
picks it up. If something genuinely needs a human, say so once in the PR body
or one comment, then exit — never poll for the answer.

This lives here, not only in `docs/agents/routine-invariants.md`, because
interactive sessions never read runner prompts — and interactive sessions are
where the loops were armed.

## Never discard uncommitted work

Do not run `git restore`, `git checkout -- <file>`, `git clean`, or
`git reset --hard` unless explicitly asked to throw work away. If the tree
looks wrongly "modified" (e.g. every file at once), suspect line endings or
filemode config — investigate, never "clean up" by reverting. This repo is
developed on Windows against a Unix-normalised tree, so whole-tree CRLF churn
is the expected false alarm, not a real diff. When in doubt, `git stash`.

## Don't stop to ask

The founders are non-coders. Do not ask them technical or workflow questions
you can decide yourself — make the call, state it in one line, keep moving.

Yours: branch/file naming, test framework details, refactor order, commit
granularity, which command variant to run, foreground vs background work.

Ask only for: the three decision-authority items above, product questions,
anything expensive to reverse, or a genuine spec gap where guessing wastes
hours.

## Definition of done

- Acceptance criteria from the spec are met
- All tests pass, including new ones for this change
- Docs updated if behaviour or architecture changed
- No new secrets, keys, or credentials committed

Do not report work as complete if any item is unmet. Say what's missing
instead.

## Verify before committing

- Backend: `cd backend && npm test` (includes `test/copyRules.test.ts`, which
  gates ALL user-facing copy in `data/*.json`).
- Root suites: `node --test "test/*.test.js"` — the app.js security invariants
  **and** `test/suite-integrity.test.js`, the floor check that guards every
  `player/` and `tools/` suite. Run it for any change under those trees.
- The pipeline suite your change touches: `node --test "tools/refresh/*.test.mjs"`
  (likewise `tools/segments/`, `tools/transcribe/`, `player/**/*.test.js`).
  `tools/corpus/` has its own deps: `cd tools/corpus && npm test`.
- Site JS: `node --check app.js`
- Data integrity: CI (`.github/workflows/ci.yml`) validates all JSON + session
  episode refs on push.

**A new test suite needs a floor in the same change.** Adding
`tools/**/*.test.mjs` or `player/**/*.test.js` without an entry in `FLOORS` in
`test/suite-integrity.test.js` fails CI ("every suite on disk is covered by a
floor"). That is deliberate, not friction: an unfloored suite can be quietly
deleted later by a PR that auto-merges, and a deleted suite passes CI.

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
- Root `STATE.md`: the cross-session announcement board. **Read it during
  recon**, before starting anything long-running — another session may already
  own the files you were about to touch. **Post to it** when you start a
  workstream (one entry: what, branch prefix, owned directories, what's out of
  scope), and move the entry to "completed" when it lands. Full plans live in
  `docs/`; STATE.md stays short enough to read every time.
- `tools/`: the committed keyless pipelines, most with their own README —
  `refresh/` (nightly scan → resolve → merge; cloud topology in
  `docs/nightly-refresh-cloud.md`), `classify/`, `segments/`, `transcribe/`,
  `corpus/`, `web/`. The repo root stays dependency-free; a directory that
  needs deps carries its own `package.json` (`corpus/`).
- `backend/`: Node/TS — ingest, dedup, cost metering, curation engine,
  session-builder CLI. Runs keyless in dry-run (StubEnricher); real keys go in
  root `.env` (gitignored).
- `ios/`: SwiftUI app + ForayKit Swift package (state machine + intent grammar,
  unit-tested). Builds only on macOS via XcodeGen. `// AUDIT:` marks unverified
  AVFoundation behavior.
- `docs/brief/`: original product spec (read first). `docs/adr/`,
  `docs/DECISIONS.md`: decisions. `docs/agents/`: runner prompts + registry.
  `docs/roles.md`: who owns what. `docs/marketing/`, `docs/research/` (incl.
  the searchable corpus — see below).
  `docs/ux/foray-m3-prototype.html`: current interactive UX reference for M3
  (onboarding, today menu, player, transitions, library, settings, etc.) — see
  `docs/ux/README.md`.

## Research corpus (local-only) — search it before reasoning from memory

The 54 curated sources in `docs/research/foray-research-dossier.md` are scraped
into a searchable SQLite+FTS5 corpus (52 ingested, 480 chunks; the two failures
are named in `docs/research/corpus/dead-links.md`). Nine areas: podcast
infrastructure, speech processing/ASR, topic segmentation, retrieval and
recommendation, audio assembly, TTS, prior art, legal/policy, LLM pipeline
engineering.

```
node tools/corpus/corpus.mjs search "dynamic ad insertion"   # keyword search
node tools/corpus/corpus.mjs stats                           # per-area coverage
node tools/corpus/corpus.mjs report                          # coverage + dead links
```

Full CLI and schema: `tools/corpus/README.md`.

**When to search it.** Before reasoning from memory on: segment anchoring and
DAI offset drift (`docs/adr/0007-segment-anchoring.md`,
`docs/curation/segment-extraction-pipeline.md`), transcript acquisition,
loudness normalization of stitched audio, retrieval/ranking design, and
anything touching product principle #3 ("legally boring"). It holds the primary
documents themselves — the 9th Circuit's *Hunley* opinion, the AES loudness
recommendation, the WhisperX and TREC papers, Podcast Namespace issue #254 —
and a model's recollection of what a court or a standards body actually said is
confidently wrong often enough that one search is cheaper than the rework.

**It exists only on the machine that built it.** The DB lives in
`data-local/corpus/`, which is gitignored, so cloud runners (nightly refresh,
classification agents on GitHub Actions) and other checkouts do not have it and
cannot query it — never write a runner prompt or doc that tells them to. It is
regenerable from the committed dossier plus the network:

```
node tools/corpus/corpus.mjs init
node tools/corpus/corpus.mjs load-manifest
node tools/corpus/corpus.mjs ingest --all
```

## Conventions

- All escaping in app.js goes through `esc()`; all href/src through `safeUrl()`.
  The page has a strict CSP — no inline styles/scripts.
- localStorage keys keep the legacy `cp_` prefix (renaming would wipe user state).
- `user_id` on every backend table and route — no single-tenant schema shortcuts.
- Every LLM call routes through the cost-metering budget guard.
- PR descriptions open with a 1–2 sentence plain-language **TL;DR for
  reviewers** (what it does + why it matters), then `---`, then detail. The
  founders review by outcome, not by reading the diff.
- Branches: `feature/<short-name>`, `fix/<short-name>`. Bot content branches
  use the prefixes listed in `.github/workflows/automerge-nightly.yml`.

## For future sessions

If you notice a recurring instruction the founders keep repeating, propose
adding it here. If it's a lesson that would apply to the *next* JW project
too, propose it for `JW-Incorporated/starter-kit`'s `LESSONS.md` in the same
week — that repo is only worth having if it grows, and the window in which a
lesson lives only in someone's head is exactly when it repeats.

## Automation

The nightly content refresh runs in the cloud (not on anyone's laptop): a keyless
GitHub Action scans/resolves and publishes a digest; a Claude Cloud agent authors
hooks/tags and opens a PR. Registry: `docs/agents/runners.md`. Topology:
`docs/nightly-refresh-cloud.md`.
