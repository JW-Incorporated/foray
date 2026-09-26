# Package plan: shows-pipeline tail and search polish (revision 2)

Written 2026-09-25 against `origin/main` @ **`ecb6bfa3`** (PR #839, 2026-09-26 00:38 UTC), the two stalled Hermes branches (`origin/claude/t_f00c0a28-s09-postgres-path` = PR #714, `origin/claude/t_5f7cadcd-s12-docs` = PR #729), `docs/search-plan.md`, `docs/search-parity-plan.md`, `docs/adr/0001-feed-polling-strategy.md`, and the off-repo `C:\Users\wjduv\Desktop\4a-shows-pipeline-plan.md` (Wyatt, 2026-09-04; NOT in the worktree — no task may depend on reading it). Every path, function and quoted anchor below was re-checked against `ecb6bfa3` with `git grep`/`git cat-file` on 2026-09-25. Executor tags: **qwen** = a capable coder who verifies only by running commands; **opus** = needs judgement, a DENIED/human-merge path, prompt/ranking design, or a data ripple that must be read rather than diffed.

**Revision-2 changes (every reviewer problem accepted; none rejected):** re-pinned to today's main with grep anchors instead of line numbers; HUMAN-ACTIONS ids re-derived (highest open id on main is **#118**, next free is **#119**) and all CLI/test strings now name gate LETTERS, never ids; the "dangling `showsPostgresLive` floor" finding was wrong (it sits in `BACKEND_FLOORS`, whose keys are backend-relative, and main's test `every backend suite on disk is covered by a floor` REQUIRES it) — PKG-02 now adds it; the change-index pointer is **stale** (published 2026-09-15T06:20Z, ceiling 216 h; `shows-import.yml`'s 2026-09-20 scheduled run FAILED at step `Build the shard index and publish a Release (idempotent)`) — new **PKG-00** repairs it and PKG-07/08/12 are re-shaped around it; PKG-08 no longer imports from `tools/shows` (that module pulls `pg-copy-streams` and `node:sqlite` at import); PKG-11 split into 11a/11b and 11b now updates `test/show-page.test.js`'s exact-key pin; PKG-05/06/07 contracts made total (median rule, `applySuccess` exported, `pi_id: number|null` ordering, two distinct 200-thresholds); PKG-06 states why it is not `tools/segments/politeness.mjs`; PKG-03's rewrite is now a mechanical pattern over docs AND the six new HUMAN-ACTIONS bodies with the explicit branch→new mapping.

Findings that shape this package (verified):

- **PR #714 (S-09) conflicts** on `.github/workflows/ci.yml`, `STATE.md`, `docs/DECISIONS.md`, `test/suite-integrity.test.js`; its other 12 files apply clean. Its `"test/showsPostgresLive.test.ts": 3` floor is a `BACKEND_FLOORS` key (backend-relative by design) and is REQUIRED, not dangling.
- **PR #729 (S-12) conflicts** on `HUMAN-ACTIONS.md`, `HUMAN-ACTIONS-DONE.md`, `docs/DECISIONS.md`. Its items #108–#113 collide with main (#109, #114–#118 exist). Its docs and item bodies claim S-10 exists (`tools/poll/`, `0020_watchlist.sql`, "68 tests"); **no such code exists in any ref** (`git ls-tree -r origin/main | grep tools/poll` → 0; `git log --all -- 'tools/poll/*' 'backend/migrations/0020*'` empty). It also names `0019_show_episodes_rekey.sql`; the real file on #714 is `0019_rekey_episodes_by_pi_id.sql`.
- **The S-04 release pointer is stale.** `data/shows-index-pointer.json` `published_at` 2026-09-15T06:20:47Z; `tools/refresh/candidates.mjs` `loadChangeIndex({ maxAgeHours = 24 * 9 })` returns `{ ok:false, reason: "pointer is stale: …" }` today. Cause: the weekly `shows-import.yml` run of 2026-09-20 failed in job `build-and-publish`, step `Build the shard index and publish a Release (idempotent)`. Last success: the 2026-09-15 manual dispatch.
- **P-09's signal is on disk but not in the client files**: `tools/build-catalog-client.mjs` `CLIENT_SHOW_FIELDS` has no `chart_rank`; `tools/build-show-index.mjs` writes `chart_rank: null` for every curated row (line `rows.push({ title, id, chart_rank: null, curated: true });`). `test/show-page.test.js` pins the client file's exact key set (`expectedKeys = ["show_id","title","artwork_url","editorial_note","taxonomy_node_ids","episode_count","explicit"]`) — adding a field without updating that pin turns the required `data-and-site` job red.
- **P-10's signal may exist**: the dump carries `popularityScore`; `top.json` rows carry `i` = itunesId, joinable to breadth ids. Unchecked; PKG-12 checks it (with an unbounded max-age because of the stale pointer).
- **P-03a's re-harvest has not run**: `data/catalog-breadth.json` has zero `artist_name` keys.
- **`tools/segments/politeness.mjs` exists** (`MIN_HOST_INTERVAL_MS = 1200`, `BASE_BACKOFF_MS = 2000`); it is the transcript-fetch policy, not the feed-poll policy. PKG-06 deliberately ports `backend/src/feeds/politeness.ts` (2000/5000/900000) instead — see its header requirement.
- Machine constraint today (founder, 2026-09-25): the box is memory-bound. This plan caps concurrency (see §4) and keeps every test invocation to one process.

---

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** Land the two stalled shows-pipeline PRs in a form that merges (S-09 Postgres path, S-12 docs), repair the weekly change-index release so downstream tools have a fresh pointer, build the S-10 watchlist poller as a no-DB dry-run that is honest about what it would poll, and close the search deck's measurable cards (P-09 data+rule, P-10 measured, P-04 decided, P-07 handed to the founder). **Done when:** #714 and #729 are closed in favour of merged replacements; `data/shows-index-pointer.json` `published_at` is newer than 2026-09-20 and `loadChangeIndex()` returns `ok:true`; `node tools/poll/poll-episodes.mjs --dry-run` runs green from a clean checkout with no database and prints a would-poll summary and a weekly request projection; `data/show-index.tsv` and `data/catalog-client.json` carry `chart_rank` for every curated show that has one and `test/show-page.test.js` is green; `history` and `science` put *Hardcore History* and *Science Vs* first with the rule mirrored server-side; a committed probe report answers P-10's option-1 question with numbers; P-04 is one founder question; P-07 is a numbered HUMAN-ACTIONS item with a protocol.

**Dependencies.**
- Other packages: none blocking. P-07 needs a TestFlight build carrying the search deck (release-lockstep package; PKG-16 names the gate). Native engine M2–M4: none.
- Founder decisions/credentials (all inert-by-design until given): G1 `DATABASE_URL` on Vercel, G2 apply migrations 0017–0019 on Supabase, G3 repo secret `SHOWS_DATABASE_URL`, G8 Supabase tier, G9 watchlist N. Only PKG-10 blocks on them.
- External: GitHub release assets under the pointer's `asset_base_url` (public, no token); GitHub Actions (PKG-00 re-runs `shows-import.yml`; needs `gh` auth, which the founder's box has); Apple `itunes.apple.com/lookup` for PKG-14 (keyless, ≥3 s politeness per `docs/CATALOG-PIPELINE.md`).
- Devices: none.

**Open founder questions** (each with a proposed default; none block Waves 0–3):
1. **G1/G2/G3 — provision a shows Postgres now?** *Default: not yet.* Only PKG-10 waits.
2. **G8 — Supabase tier vs `in_4a`-only storage.** *Default: `in_4a`-only (902,712 rows per the current pointer), decided when PKG-01's `sizingReport` prints bytes/row.*
3. **G9 — watchlist N and weekly request budget; dry-run cadence.** *Default: N = 5,000, target < 40,000 requests/week; the dry-run workflow runs DAILY not hourly until a DB exists.*
4. **P-09's loser — curated shows with no Apple chart row.** Inside one match tier, may they sort below curated shows that have a rank? *Default: yes, never below a breadth row; PKG-13 measures which shows before the rule ships.*
5. **P-10 — pick one of the three options.** *Default: option 3 (accept) unless PKG-12 shows `top_position` coverage ≥ 80 % of breadth rows AND `would_lead_by_top_position` is true for `daily` with no regression on the other three pinned queries.*
6. **P-04 — tail or rows.** *Default: keep the `chart_rank ≤ 100` cut with no author column; decide after PKG-14/15.*
7. **Promote the new `db` CI job to a required check?** *Default: no; revisit when G3 exists.*
8. **P-07 — which build?** *Default: the next TestFlight build the native-engine track ships.*

---

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| PKG-00 | Repair `shows-import.yml` (failed 2026-09-20) and advance the change-index pointer | opus | diagnosing from a CI log; `.github/` DENIED if the fix is in the workflow; a publish side-effect (GitHub release) | — | XS |
| PKG-01 | Re-land #714's `tools/shows` half as a fresh auto-merge PR | qwen | — | — | S |
| PKG-02 | Re-land #714's governed half (migrations, `backend/src`, `db` CI job, `BACKEND_FLOORS`, DECISIONS, STATE); close #714 | opus | DENIED paths (`.github/`, `backend/src/`, `docs/DECISIONS.md`), unlisted `backend/migrations/`, prose conflicts | PKG-01 | S |
| PKG-03 | Re-land #729's non-governed docs; HUMAN-ACTIONS G1..G8 items as #119–#124; strip false S-10 claims | qwen | — | — | S |
| PKG-04 | Re-land #729's DECISIONS + ADR-0001 entries with the S-10 claim corrected; close #729 | opus | DENIED paths (`docs/DECISIONS.md`, `docs/adr/`) | PKG-02, PKG-03 | XS |
| PKG-05 | `tools/poll/tiers.mjs`: seeding, correction, success/failure, dead | qwen | — | — | S |
| PKG-06 | `tools/poll/politeness.mjs` (pinned port of the TS) + `select-due.mjs` | qwen | — | PKG-05 | S |
| PKG-07 | `tools/poll/watchlist.mjs` + committed `data/watchlist-seed.json` builder | qwen | — | PKG-00, PKG-05 | S |
| PKG-08 | `tools/poll/poll-episodes.mjs --dry-run` CLI (no `tools/shows` import) | qwen | — | PKG-06, PKG-07 | S |
| PKG-09 | `.github/workflows/episode-poll.yml` (dry-run, daily) | opus | DENIED `.github/`; spend call Q3 | PKG-08 | XS |
| PKG-10 | Live poller path (migration 0020, conditional GET, upsert) | opus | BLOCKED on G1/G3 + PKG-02; publisher traffic | PKG-02, PKG-08, G1, G3 | M (own plan when unblocked) |
| PKG-11a | P-09 data, index half: `build-show-index.mjs` joins curated `chart_rank`; regenerate `data/show-index.tsv` | qwen | — | — | S |
| PKG-11b | P-09 data, client half: `build-catalog-client.mjs` + new test + `show-page.test.js` pin; regenerate `data/catalog-client.json` | qwen | — | PKG-11a | S |
| PKG-12 | P-10 probe: `top.json` position coverage/order over the index (unbounded pointer age) | qwen | — | — | XS |
| PKG-13 | P-09 rule half: `popularityBand` reads curated ranks (client + server mirror), measured loser table | opus | ranking/product judgement; DENIED `backend/src/catalog/` | PKG-11b | S |
| PKG-14 | Re-harvest `data/catalog-breadth.json` with `artist_name`; regenerate; read the ripple | opus | 12 MB data ripple through pinned real-index tests must be read; Apple politeness | PKG-11b | S |
| PKG-15 | P-04 decision memo + founder question | opus | product judgement, founder-facing | PKG-12, PKG-13, PKG-14 | S |
| PKG-16 | P-07 founder listening test as a HUMAN-ACTIONS item + field-record template | opus | founder-facing protocol; build gate | PKG-03 | XS |

18 tasks: 9 qwen, 9 opus. Nothing above S except PKG-10, deliberately not detailed.

---

## 3. Task sections

Conventions that apply to EVERY task (each task's Commands assume them):
- Repo root: `C:/Users/wjduv/Desktop/Vibe Coding/foray`. Fresh LF worktree: `git -C "<root>" fetch origin main && git -C "<root>" -c core.autocrlf=false worktree add "<root>/.worktrees/<branch>" -b <branch> origin/main`. Never `npm ci`/`npm install` at the repo root; never `git worktree remove` (leave it; say so in the handoff). Never `format:write` repo-wide.
- **Line numbers are hints; always locate by the quoted text with `git grep -n "<text>" -- <file>` and STOP if the text is not found.** Main moves several times a day.
- Never commit `deploy-manifest.json` or `data/forays-directory.json`. `sw.js`'s `BUILD_ID` stays `"unstamped"`; do not touch `sw.js`.
- Every NEW `*.test.js`/`*.test.mjs` under `player/`, `test/`, `tools/` gets a line in `test/suite-integrity.test.js`'s `FLOORS` map (the object starting `const FLOORS = {`, ending before `const BACKEND_FLOORS`) equal to its measured test count, with a comment naming the task id. Raising an existing floor when adding tests to an existing suite is required. Backend vitest suites are floored in `BACKEND_FLOORS` with backend-relative keys (`"test/<name>.test.ts"`); main's test `every backend suite on disk is covered by a floor` fails on any missing key.
- **One test process at a time**, and today at most ONE task running on the founder's box at once (memory-bound; founder directive 2026-09-25). `node --test <one file>`; never a glob; never two in parallel.
- Commits end with the two trailer lines (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017FFM7M73d6sEYQiHroVesz`). PRs open as **DRAFT** (`gh pr create --draft`), body ends with the `🤖 Generated with [Claude Code]` line and the session URL, title starts with the task id and card id.
- No task names a Foray, so `tools/foray/fixtures/frozen/` is not needed; if you find yourself loading a Foray fixture, stop.
- HUMAN-ACTIONS ids: **never hardcode an id in code, tests or CLI output; name gate letters (G1…G9) and "HUMAN-ACTIONS.md".** Re-derive the next free id at task start with: `grep -ohE "^## #[0-9]+" HUMAN-ACTIONS.md | tr -dc '0-9\n' | sort -n | tail -1` and `grep -ohE "^- #[0-9]+ ·" HUMAN-ACTIONS-DONE.md | tr -dc '0-9\n' | sort -n | tail -1`; next = max of both + 1 (on `ecb6bfa3`: 118 → next is 119).
- Path policy (`tools/ci/path-policy.mjs`, `export const ALLOWED_PREFIXES = [`): `data/`, `docs/`, `player/`, `tools/`, `test/`, `backend/test/`, `mobile/`, `app.js`, `styles.css`, `search-engine.js`, `STATE.md`, `HUMAN-ACTIONS.md`, `HUMAN-ACTIONS-DONE.md`, `sw.js` auto-merge when green. DENIED (human merge + `founder-approved`): `.github/`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`, `backend/src/`, `tools/ci/`, `tools/test-search.mjs`, `tools/validate-semantic-index.mjs`, `tools/events-server.mjs`, `tools/mobile/wire-signing.mjs`. Unlisted (human merge): `api/`, `backend/migrations/`. A qwen task that would need a DENIED or unlisted path STOPS.

### PKG-00 · Repair `shows-import.yml` and advance the pointer — opus, XS

**Executor:** opus. Reads a failed CI log and decides whether the fault is in the workflow (`.github/`, DENIED), in `tools/shows/*` (auto-merge), or transient; a successful run publishes a GitHub release and moves `data/shows-index-pointer.json` (a side-effect on every downstream consumer).

**Context:** `.github/workflows/shows-import.yml` (cron `7 6 * * 0`; job `build-and-publish`); `gh run list --workflow shows-import.yml --limit 5` (2026-09-20 scheduled run: FAILED at step `Build the shard index and publish a Release (idempotent)`; 2026-09-15 dispatch: success); `tools/shows/run-and-publish.mjs` and `tools/shows/shard-build.mjs` (the step's entry points; confirm with `git grep -n "run-and-publish" -- .github/workflows/shows-import.yml`); `tools/refresh/candidates.mjs` `export async function loadChangeIndex(` (the 216 h ceiling and the `ok:false` reason string); `data/shows-index-pointer.json` (`published_at`, `release_tag`, `counts`).

**Exact change:**
1. `gh run view <failed id> --log-failed > <scratch>/shows-import-fail.log`; read it. Classify: (a) transient (dump download/rate limit/runner) → re-dispatch only; (b) a `tools/shows/*` defect → fix on a branch `s04/import-repair`, with a test in the owning suite, PR as DRAFT (auto-merge path), then dispatch after merge; (c) a workflow defect → PR on `.github/` with `founder-approved` requested. Do not widen `maxAgeHours` anywhere.
2. `gh workflow run shows-import.yml`; watch with `gh run watch`; when green, `git fetch origin main` and confirm `data/shows-index-pointer.json` `published_at` advanced (the workflow commits the pointer itself; if it opens a PR instead, say which and merge per its policy).
3. From the repo root on fresh main: `node -e "import('./tools/refresh/candidates.mjs').then(m=>m.loadChangeIndex()).then(r=>console.log(r.ok, r.reason||r.changedIds.size))"` → `true <n>`.

**Tests to add:** only if (b): one regression test in the suite that owns the failing function, red before the fix.

**Commands:** the `gh` commands above; if (b), `cd tools/shows && npm test -- <suite>` and `node --test test/suite-integrity.test.js`.

**Do not touch:** `tools/refresh/**`, `data/shows-index-pointer.json` by hand (only the workflow writes it).

**Stop and escalate if:** the failure is an expired/absent secret or a GitHub quota (founder credential call); the re-run fails again for the same reason after a code fix.

**Definition of done:** pointer `published_at` > 2026-09-20; `loadChangeIndex()` prints `true`; a short note (cause, fix, run URL) in the handoff; if (b)/(c), the DRAFT PR `PKG-00 (S-04): shows-import repair — <cause>`.

### PKG-01 · Re-land #714's `tools/shows` half — qwen, S

**Executor:** qwen. Cherry-pick of files that all sit on auto-merge paths, verified by running the suites.

**Context (read first):**
- `git -C <root> cat-file -p origin/claude/t_f00c0a28-s09-postgres-path:tools/shows/load-postgres.mjs` (exports `SHOWS_DATABASE_URL_VARS`, `resolveDatabaseUrl`, `loadCatalogRows`, `loadIdMap`, `backfillLegacyShowIdKeys`, `fetchPreviousNewest`, `buildChangedInDumpReasons`, `sizingReport`, `checkMissingMapping`, `main`; find each with `grep -n "^export"`). Its no-DB path prints a string starting `NO-OP: neither SHOWS_DATABASE_URL nor DATABASE_URL is set.` and exits 0 BEFORE reading any flag. On Git Bash set `MSYS_NO_PATHCONV=1` before `git cat-file -p <ref>:<path>` or the ref gets mangled.
- Same branch: `tools/shows/search-shows.mjs` (`buildFtsQuery`, `buildTrgmQuery`, `searchShows`), `tools/shows/load-postgres.test.mjs`, `tools/shows/search-shows.test.mjs`, `tools/shows/shows-postgres-integration.test.mjs` (gated on `TEST_DATABASE_URL`), `tools/shows/package.json` (adds `pg`, `pg-copy-streams`), `tools/shows/package-lock.json`.
- `origin/main:tools/shows/import-dump.mjs` `export async function runPipeline(` — confirm the parameter object keys match what `load-postgres.mjs` passes (`git grep -n "runPipeline(" origin/main -- tools/shows/import-dump.mjs`).
- `origin/main:test/suite-integrity.test.js`: the line `"tools/shows/run-and-publish-execargv.test.mjs": 1,` (end of the `tools/shows` floor block); `const SCANNED_DIRS = ["player", "test", "tools"];`.
- `origin/main:tools/ci/run-suites.mjs` — how a package with its own `package.json` + lockfile is run (`npm ci` then `npm test`).

**Exact change:**
1. Branch `s09/tools-shows-half` from `origin/main`.
2. `git checkout origin/claude/t_f00c0a28-s09-postgres-path -- tools/shows/load-postgres.mjs tools/shows/search-shows.mjs tools/shows/load-postgres.test.mjs tools/shows/search-shows.test.mjs tools/shows/shows-postgres-integration.test.mjs tools/shows/package.json tools/shows/package-lock.json`. Nothing else from that branch.
3. In `test/suite-integrity.test.js`, directly after the line `"tools/shows/run-and-publish-execargv.test.mjs": 1,` add:
   `"tools/shows/load-postgres.test.mjs": <measured>, // PKG-01 (S-09 tools half): pure-function halves of the Postgres loader`
   `"tools/shows/search-shows.test.mjs": <measured>, // PKG-01: FTS/trgm query builders`
   `"tools/shows/shows-postgres-integration.test.mjs": <measured>, // PKG-01: real-Postgres acceptance; skips without TEST_DATABASE_URL`
   where `<measured>` is the count `node --test` reports for each file (expected 10 / 7 / 8; use the measured number). Do NOT add any `showsPostgresLive` key (that is PKG-02's `BACKEND_FLOORS` entry).
4. In `load-postgres.mjs`, edit BOTH the header sentence containing `HUMAN-ACTIONS.md's Supabase-tier-sizing gate` and the runtime string containing `(HUMAN-ACTIONS.md: Supabase tier sizing gate, fed by this file's own sizing report).` so each reads `gate G8 (Supabase tier, HUMAN-ACTIONS.md)` — letter only, no id. Update the test in `load-postgres.test.mjs` that asserts on that string if one exists (`grep -n "Supabase" tools/shows/load-postgres.test.mjs`).
5. Confirm the inert path: with both vars unset (Git Bash: `env -u SHOWS_DATABASE_URL -u DATABASE_URL node tools/shows/load-postgres.mjs`; PowerShell: `$env:SHOWS_DATABASE_URL=$null; $env:DATABASE_URL=$null; node tools/shows/load-postgres.mjs`) → exit 0, stdout begins `NO-OP:` and contains `G8`. No `--dump-file`.

**Tests to add:** none new beyond the three cherry-picked suites. Mutation check already present: comment out the dead-exclusion clause in `buildFtsQuery` → the `search-shows.test.mjs` dead-by-default test goes red; restore.

**Commands (from the worktree root, one at a time):**
- `cd tools/shows && npm ci` → installs `pg`, `pg-copy-streams`, exit 0.
- `cd tools/shows && npm test -- load-postgres.test.mjs` → all pass. If Node 24 rejects `--experimental-sqlite`, run `node --test load-postgres.test.mjs` and say so in the PR body.
- `cd tools/shows && npm test -- search-shows.test.mjs` → all pass.
- `cd tools/shows && npm test -- shows-postgres-integration.test.mjs` → gated tests SKIP, 0 FAIL (the `checkMissingMapping` tests are ungated and must pass).
- Root: `node --test test/suite-integrity.test.js` → green.
- Once, at the end: `node tools/ci/run-suites.mjs` → green.

**Do not touch:** `backend/**`, `.github/**`, `docs/DECISIONS.md`, `STATE.md`, `tools/shows/import-dump.mjs`, `tools/shows/config.mjs`, any other `tools/shows/*` already on main.

**Stop and escalate if:** `runPipeline`'s signature on main differs from what `load-postgres.mjs` calls; `npm ci` in `tools/shows` fails on Node 24; any test outside the three suites and `test/suite-integrity.test.js` fails; the integration suite reports FAIL rather than SKIP without `TEST_DATABASE_URL`.

**Definition of done:** DRAFT PR `PKG-01 (S-09): Postgres loader + search modules under tools/shows (inert without a database)`, touching only the seven `tools/shows` files and `test/suite-integrity.test.js`; body lists the three counts and the exact `NO-OP:` line; path-policy check all-allowed; both trailers.

### PKG-02 · Re-land #714's governed half; close #714 — opus, S

**Executor:** opus. `backend/migrations/` (unlisted), `backend/src/catalog/showEpisodesStore.ts`, `.github/workflows/ci.yml`, `docs/DECISIONS.md` (DENIED), prose conflict in `STATE.md`, and a `BACKEND_FLOORS` edit. Needs `founder-approved` and a human merge.

**Context:** the branch's `backend/migrations/0017_shows_catalog.sql`, `0018_show_id_map.sql`, `0019_rekey_episodes_by_pi_id.sql`; its `backend/src/catalog/showEpisodesStore.ts` diff (`legacy_show_id as show_id` in four queries); its `backend/test/showsPostgresLive.test.ts` (3 vitest cases gated on `SHOWS_DATABASE_URL || DATABASE_URL`); its `.github/workflows/ci.yml` `db` job (`postgres:17` service, migrate twice, `npm test` with `SHOWS_DATABASE_URL`, then the `tools/shows` suite with `TEST_DATABASE_URL`); its `docs/DECISIONS.md` entry (`## 2026-09-15 — S-09 …`) and `STATE.md` block (`### S-09 …`). On main: `backend/src/cli/migrate.ts`; `.github/workflows/ci.yml` jobs `backend, api, engine-paths, ios-kit, ios-gate, engine-parity, data-and-site, playwright`; `test/suite-integrity.test.js` `const BACKEND_FLOORS = {`, `const TS_TEST_RE = /^\s*(test|it)\(/gm;`, test `every backend suite on disk is covered by a floor`; `STATE.md` heading `### S-11: curation reads the change stream instead of polling all feeds nightly (2026-09-15)`; `docs/DECISIONS.md` top heading (newest-first).

**Exact change:**
1. Branch `s09/governed-half` from `origin/main` after PKG-01 merges. Cherry-pick the three migrations, the `showEpisodesStore.ts` diff and `backend/test/showsPostgresLive.test.ts` verbatim.
2. Re-apply the `db` job to today's `ci.yml` by hand (positional conflict). `node-version: 22` like the other jobs. Keep the "not added to required checks" comment.
3. `test/suite-integrity.test.js`: inside `BACKEND_FLOORS` add `"test/showsPostgresLive.test.ts": <n>, // PKG-02 (S-09): live-Postgres acceptance; every case skips without SHOWS_DATABASE_URL||DATABASE_URL` where `<n>` is the count of lines matching `TS_TEST_RE` in that file (expected 3; measure).
4. DECISIONS: place the branch's entry at the TOP of `docs/DECISIONS.md`, re-dated to the merge day, with one added paragraph: "Landed as two PRs: PKG-01 (tools half, auto-merged) and this one." Drop any claim that the full `backend` suite ran against a live DB unless you re-run it.
5. STATE: append the branch's S-09 block after the S-11 block (locate by the `### S-11:` heading; insert before the next `### ` or `## ` heading that follows it).
6. Open DRAFT; comment on #714 "Superseded by PKG-01 (#…) and this PR; closing." and close #714 (keep its branch).

**Tests to add:** none new; acceptance is CI's `db` job green.

**Commands:** `cd backend && npm ci && npm run typecheck && npm test` (green; `showsPostgresLive.test.ts` skipped). Root: `node --test test/suite-integrity.test.js` (green — proves the `BACKEND_FLOORS` key). Push; read the `db` job log: both `migrate.ts` passes report every file applied then skipped.

**Do not touch:** `tools/shows/**`, `tools/ci/**`, `api/**`.

**Stop and escalate if:** the `db` job fails on `0019` against a fresh schema; `backend/test/userInterests.test.ts` fails when `SHOWS_DATABASE_URL` is set (the branch documents why `DATABASE_URL` must stay unset in that step); `suite-integrity` still reports an unfloored backend suite after step 3.

**Definition of done:** DRAFT PR `PKG-02 (S-09): migrations 0017–0019, episode-store rekey, CI db job, BACKEND_FLOORS, DECISIONS/STATE`; `db` job green; Governance line requests `founder-approved`; #714 closed with a pointer comment.

### PKG-03 · Re-land #729's non-governed docs; gates as #119–#124 — qwen, S

**Executor:** qwen. Mechanical renumbering + a mechanical sentence substitution, both gated by tests/greps.

**Context:** `git diff origin/main...origin/claude/t_5f7cadcd-s12-docs -- HUMAN-ACTIONS.md HUMAN-ACTIONS-DONE.md docs/CATALOG-PIPELINE.md docs/catalog-growth-plan.md docs/curation/catalogue-broadening.md docs/show-pages-plan.md`. On main: `test/human-actions-integrity.test.js` (`const OPEN_HEADING_RE = /^##\s+#(\d+)\b/;`, `const LEDGER_LINE_RE = /^-\s+#(\d+)\s+·/;`, six tests). Main's highest open id: **#118** (`#117` = phone check of six player fixes, `#118` = remove retired events server from Startup); re-derive per the conventions. The branch's items and their mapping to the plan's real gate letters (the off-repo plan is NOT readable from the worktree; this table is authoritative):

| branch heading | new id | new title |
|---|---|---|
| `## #108 🟡 [DECIDE] G2 — DATABASE_URL on the Vercel project (foray-web)` | #119 | `G1 — DATABASE_URL on the Vercel project (foray-web)` |
| `## #109 🟡 [DECIDE] G3 — Apply migrations 0017–0020 on Supabase` | #120 | `G2 — Apply migrations 0017–0019 on Supabase` |
| `## #110 🟡 [DECIDE] G4 — Repo secret SHOWS_DATABASE_URL for GitHub Actions` | #121 | `G3 — Repo secret SHOWS_DATABASE_URL for GitHub Actions` |
| `## #111 🟡 [DECIDE] G6 — Re-confirm D1's …` | #122 | `G6 — …` (title unchanged) |
| `## #112 🟡 [DECIDE] G7 — Joey's PodcastIndex export …` | #123 | `G7 — …` (unchanged) |
| `## #113 🟡 [DECIDE] G8 — Supabase tier vs. in_4a-only storage …` | #124 | `G8 — …` (unchanged) |

**Exact change:**
1. Branch `s12/docs-half` from `origin/main`. Apply the four `docs/**` diffs (`git apply --3way` or by hand); prose only.
2. Insert the six items below `## #118` in `HUMAN-ACTIONS.md`, headings exactly `## #<new id> 🟡 [DECIDE] <new title>`, bodies from the branch. Inside every body: replace `#108`→`#119`, `#109`→`#120`, `#110`→`#121`, `#111`→`#122`, `#112`→`#123`, `#113`→`#124`; delete every parenthetical matching `\(G\d in the plan'?s own numbering[^)]*\)`; replace gate letters in body text per the table (G2→G1, G3→G2, G4→G3 ONLY in these six bodies).
3. Mechanical S-10 scrub, in the four docs AND the six new bodies: for every line matching `tools/poll|0020|S-10.*(built|exists|landed|PR'd)`, replace the whole sentence with exactly `S-10 (watchlist poller) is not built; planned as PKG-05..PKG-10.` Everywhere in these files: `0017–0020`→`0017–0019`, `0019_show_episodes_rekey.sql`→`0019_rekey_episodes_by_pi_id.sql`.
4. `HUMAN-ACTIONS-DONE.md`: apply the branch's `#35` ledger line only if `grep -n "^## #35" HUMAN-ACTIONS.md` finds an open heading on main; otherwise skip and say so.
5. Leave every "S-09 not merged / built, not live" sentence as written.

**Tests to add:** none. Mutation check: duplicate the `## #119` heading → `node --test test/human-actions-integrity.test.js` goes red on reuse-within-file; restore.

**Commands:** `node --test test/human-actions-integrity.test.js` → 6 pass. `grep -nE "tools/poll|0020|S-10|show_episodes_rekey" docs/CATALOG-PIPELINE.md docs/catalog-growth-plan.md docs/show-pages-plan.md docs/curation/catalogue-broadening.md HUMAN-ACTIONS.md` → only hits are the exact "is not built; planned as PKG-05..PKG-10." sentence.

**Do not touch:** `docs/DECISIONS.md`, `docs/adr/**`, `STATE.md`, code.

**Stop and escalate if:** re-derived next id ≠ 119 (then use max+1..max+6 and state them in the PR body — that is allowed; escalate only if the ids collide with something PKG-15/16 already opened); the branch's docs diffs no longer apply because target sections were rewritten.

**Definition of done:** DRAFT PR `PKG-03 (S-12): shows-pipeline doc banners + human gates G1/G2/G3/G6/G7/G8 (#119–#124)`; integrity test green; the grep clean; all files on auto-merge paths.

### PKG-04 · Re-land #729's DECISIONS + ADR-0001; close #729 — opus, XS

**Executor:** opus. DENIED paths; must reconcile with PKG-02's entry and state honestly what is built.

**Context:** the branch's `docs/DECISIONS.md` hunk (`## 2026-09-21 (S-12: the shows-pipeline decisions, D1–D14, as shipped)` + `### Human gates …`) and its ADR-0001 addition; main's ADR-0001 Status paragraph; PKG-03's final ids.

**Exact change:**
1. Branch from `origin/main` after PKG-02 and PKG-03 merge. Add the D1–D14 entry at the TOP of `docs/DECISIONS.md`, re-dated, gate paragraph pointing at PKG-03's ids, S-10 row: "not built (no code in any ref as of 2026-09-25); PKG-05..PKG-10".
2. ADR-0001: replace the branch's paragraph with: "Scheduler still not built as of <date>. Planned shape: `tools/poll/` (PKG-05..08) as a no-DB dry-run first, reusing `PolitenessBudget`'s rules via a pinned JS port (PKG-06), live path after G1/G3 (PKG-10)." Status stays "Accepted (scheduler not yet built)".
3. Comment on #729 that PKG-03 + this PR supersede it; close #729.

**Commands:** `node --test test/human-actions-integrity.test.js`; `node --test test/suite-integrity.test.js`.

**Do not touch:** anything outside the two files.

**Stop and escalate if:** PKG-02 has not merged.

**Definition of done:** DRAFT PR `PKG-04 (S-12): DECISIONS D1–D14 and ADR-0001 status`, `founder-approved` requested, batched with PKG-09; #729 closed.

### PKG-05 · `tools/poll/tiers.mjs` — qwen, S

**Executor:** qwen. Pure functions with numeric contracts.

**Context:** `docs/adr/0001-feed-polling-strategy.md` (tiers `hourly / several_daily / daily / weekly / backoff`); `tools/shows/filter.mjs` (dump pubdates are **unix seconds**: the expression `now - newest * 1000`); `tools/shows/config.mjs` `DUMP_COLUMNS`; `test/suite-integrity.test.js` `const SCANNED_DIRS` (new suites under `tools/` are discovered and must be floored). `tools/poll/` does not exist on main; create it. No `package.json` in `tools/poll/` (its suites run in the root `node --test` group).

**Exact change:** create `tools/poll/tiers.mjs` (ESM, imports only from `node:`), exporting:
1. `TIER_INTERVAL_MS = Object.freeze({ hourly: 3_600_000, several_daily: 6 * 3_600_000, daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000, backoff: 3 * 24 * 3_600_000 })`; `TIERS = Object.freeze(Object.keys(TIER_INTERVAL_MS))`. `dead` is a state, not a tier. "Faster" tier = smaller `TIER_INTERVAL_MS`.
2. `tierFromMeanGapDays(gapDays)`: `≤ 0.5 → "hourly"`, `≤ 1.5 → "several_daily"`, `≤ 4 → "daily"`, else `"weekly"`; `null`/NaN/`≤ 0` → `"weekly"`.
3. `seedTier({ episodeCount, oldestItemPubdate, newestItemPubdate, watchReasons = [] }, nowMs = Date.now())` → `{ tier, meanGapDays }`. `meanGapDays = ((newest - oldest) / 86_400) / Math.max(1, episodeCount - 1)` when both pubdates are finite unix seconds, `newest > oldest`, `episodeCount ≥ 2`; else `null`. Tier = `tierFromMeanGapDays(meanGapDays)`; then if `watchReasons` includes `"curated"` or `"curation_candidate"`, tier = faster of (tier, `"daily"`); then if `newestItemPubdate` is finite and `nowMs/1000 - newestItemPubdate > 730 * 86_400`, tier = `"weekly"` regardless.
4. `correctTier(observedPublishedAtMs)`: array of ms timestamps, any order; fewer than **4** entries → `null`; else sort ascending, consecutive gaps in days, `median` = the value at index `Math.floor((n - 1) / 2)` of the sorted gaps (lower-middle for even n), return `tierFromMeanGapDays(median)`.
5. State shape `{ consecutiveFailures: number, tier: string, state: "active"|"dead", firstNotFoundAtMs: number|null }`. `applySuccess(state)` → new state with `consecutiveFailures: 0`, `firstNotFoundAtMs: null`, `state: "active"`, and `tier: "weekly"` if it was `"backoff"` else unchanged. `applyFailure(state, { status, nowMs })` → new state: `consecutiveFailures + 1`; if `≥ 5` then `tier = "backoff"`; if `status === 410` then `state = "dead"`; if `status === 404`: set `firstNotFoundAtMs = nowMs` when null, and if `nowMs - firstNotFoundAtMs ≥ 30 * 86_400_000` then `state = "dead"`. Both are pure (return a new object). The caller (PKG-10, later) decides which to call; a 2xx/304 is a success.
6. `nextDueAt(tier, lastPolledAtMs)` → `lastPolledAtMs + TIER_INTERVAL_MS[tier]`; unknown tier → `throw new RangeError("unknown tier: " + tier)`.

**Tests to add:** `tools/poll/tiers.test.mjs` (`node:test`):
- "gap thresholds map to the tiers at their edges" (0.5/1.5/4 inclusive; 4.01 → weekly). Mutation: `≤ 4`→`< 4` → red.
- "seedTier reads unix seconds, not ms" (100 episodes over 200 days → gap ≈ 2.02 → daily; ×1000 inputs → `meanGapDays` not ≈ 2.02). Mutation: drop `/ 86_400` → red.
- "curated shows are never slower than daily". Mutation: remove clause → red.
- "a 24-month-stale show is weekly whatever its history". Mutation: remove clause → red.
- "correctTier needs three intervals" (3 → null; 4 → tier). Mutation: `< 4`→`< 3` → red.
- "correctTier uses the lower-middle median" (gaps 1,1,1,30 → daily; and an even-n case where lower-middle ≠ upper-middle). Mutation: mean, or upper-middle → red.
- "five failures land in backoff; applySuccess restores weekly and clears the 404 clock". Mutation: `≥ 5`→`≥ 6` → red.
- "410 is dead at once; 404 is dead at day 30, not day 29". Mutation: `≥ 30`→`> 30` → red.
- "nextDueAt adds the interval and throws RangeError on an unknown tier". Mutation: return `lastPolledAtMs` → red.
Floor: `"tools/poll/tiers.test.mjs": <count>, // PKG-05 (S-10): cadence tiers`.

**Commands:** `node --test tools/poll/tiers.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `backend/**`, `tools/shows/**`, `tools/refresh/**`, `.github/**`.

**Stop and escalate if:** suite-integrity still reports the file unfloored after adding the line; you need a constant not stated here.

**Definition of done:** DRAFT PR `PKG-05 (S-10): tools/poll/tiers.mjs cadence tiers`; tests green; PR body quotes the thresholds.

### PKG-06 · `tools/poll/politeness.mjs` (pinned port) + `select-due.mjs` — qwen, S

**Executor:** qwen. Line-for-line port with a test that reads the TS source and pins the constants.

**Context:** `backend/src/feeds/politeness.ts` (`DEFAULT_CONFIG` literal: `minIntervalMs: 2_000`, `backoffBaseMs: 5_000`, `backoffMaxMs: 15 * 60_000`; class `PolitenessBudget` with `hostOf`, `msUntilAllowed(host, now)`, `recordRequestStart`, `recordSuccess`, `recordFailure` (backoff = min(max, base · 2^(failures−1))), `consecutiveFailuresFor`); `tools/segments/politeness.mjs` (exists; `MIN_HOST_INTERVAL_MS = 1200`, `BASE_BACKOFF_MS = 2000` — the transcript-fetch policy; NOT reused, see step 1); `test/show-search-ranking.test.js` test `the server's bucket table is THIS file's bucket table, constant for constant` (pattern for a cross-file pin); PKG-05's `TIER_INTERVAL_MS`.

**Exact change:**
1. `tools/poll/politeness.mjs`: `export const DEFAULT_CONFIG = { minIntervalMs: 2000, backoffBaseMs: 5000, backoffMaxMs: 900000 }`; `export class PolitenessBudget` with the same six methods and identical arithmetic. Header comment MUST contain: "Port of backend/src/feeds/politeness.ts; politeness.test.mjs pins the constants. Not tools/segments/politeness.mjs: that is the transcript-fetch policy (1.2 s); feed polling mirrors backend/src/feeds/politeness.ts because PKG-10's live path will run there."
2. `tools/poll/select-due.mjs`: `selectDue(watchlist, { nowMs, perRunCap = 300, budget = new PolitenessBudget(), perHostCap = 20 })`. Row shape: `{ pi_id: number|null, feed_url: string, tier: string, next_due_at_ms: number|null, state: "active"|"dead", watch_reasons: string[] }`. Output `{ due: row[], skipped: { dead, notDue, perRunCap, perHostCap, badUrl }, hosts: { [host]: count } }`. Rules in order: drop `state === "dead"` (count `dead`); drop `next_due_at_ms > nowMs` (count `notDue`); `null` `next_due_at_ms` is due; a `feed_url` that `new URL()` throws on counts `badUrl`, skipped; sort candidates by `next_due_at_ms` ascending (null first), then `pi_id` ascending with **null after all numbers**; walk: take a row only if `budget.msUntilAllowed(host, nowMs) === 0` and `hosts[host] < perHostCap` (else count `perHostCap`); do NOT call `recordRequestStart` (the dry-run never advances the budget clock); stop when `due.length === perRunCap` (remaining candidates count `perRunCap`). A null-`pi_id` row is eligible and counted in `hosts`.
3. `weeklyProjection(watchlist)` → `{ requestsPerWeek, byTier: { [tier]: { rows, requestsPerWeek } } }`; each `state === "active"` row contributes `604_800_000 / TIER_INTERVAL_MS[tier]`; dead rows contribute 0 and are not counted in `rows`.

**Tests to add:** `tools/poll/politeness.test.mjs`:
- "the port's constants equal backend/src/feeds/politeness.ts's DEFAULT_CONFIG" — read the TS as text; regex `minIntervalMs:\s*([\d_]+)`, `backoffBaseMs:\s*([\d_]+)`, `backoffMaxMs:\s*([\d_]+)\s*\*\s*([\d_]+)` (fallback single number), strip `_`, multiply; compare. Mutation: `backoffMaxMs` 900001 → red.
- "backoff doubles from base and caps at max" (failures 1..10). Mutation: `2 **`→`1 *` → red.
- "msUntilAllowed is the larger of spacing and block". Mutation: `Math.max`→`Math.min` → red.
`tools/poll/select-due.test.mjs`:
- "dead and not-yet-due rows are skipped and counted". Mutation: drop dead filter → red.
- "per-run cap holds at 300; order is next_due then pi_id with null pi_id last". Mutation: remove sort → red.
- "one host cannot exceed perHostCap" (25 rows on `feeds.libsyn.com` → 20 due, 5 `perHostCap`). Mutation: remove counter → red.
- "null next_due_at is due; a null pi_id row is eligible; a bad URL is counted not thrown". Mutation: null treated as not due → red.
- "weeklyProjection: 5,000 daily rows → 35,000/week; a dead row → 0". Mutation: include dead → red.
Floors for both files.

**Commands:** `node --test tools/poll/politeness.test.mjs`; `node --test tools/poll/select-due.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `backend/src/feeds/politeness.ts`, `tools/segments/**`, anything outside `tools/poll/` and the floors.

**Stop and escalate if:** the TS `DEFAULT_CONFIG` literal no longer matches the regex shapes (do not loosen the regex).

**Definition of done:** DRAFT PR `PKG-06 (S-10): politeness port + due-set selection`; four new files + floors; tests green.

### PKG-07 · `tools/poll/watchlist.mjs` + `data/watchlist-seed.json` builder — qwen, S

**Executor:** qwen. Assembles the watchlist from existing files and an existing loader. **Requires PKG-00 done** (fresh pointer); otherwise the builder exits 2 by design.

**Context:** `tools/refresh/candidates.mjs` `export async function loadChangeIndex({ pointerPath = POINTER_PATH, fetchImpl = fetch, maxAgeHours = 24 * 9, now = Date.now() } = {})` → `{ ok, changedIds: Set<number>, idMap: { [show_id]: pi_id }, topRows }` or `{ ok:false, reason }`; `export function selectChangedCuratedShows(catalogShows, idMap, changedIds)` (the fail-open rule for unmapped curated shows); `tools/shows/shard-build.mjs` `toShardRow` (top.json row `{ id, t, a, i, u, img, n, c }`: `id` pi_id, `u` feed url, `n` episode count, `c` curated flag, `i` itunesId); `data/catalog.json` rows (`show_id`, `title`, `apple_collection_id`, `feed_url`); `data/shows-index-pointer.json`; `tools/build-catalog-client.mjs` `function main()` (the `--out`/`--check` argument shape to copy).

**Exact change:**
1. `tools/poll/watchlist.mjs` exporting:
   - `buildWatchlist({ curatedShows, changeIndex, topN = 5000, nowMs })` → `WatchRow[]`, `WatchRow = { pi_id: number|null, show_id: string|null, title, feed_url, watch_reasons: string[], episode_count: number|null, tier, next_due_at_ms: null, state: "active" }`. (a) every curated show: `pi_id = idMap[show_id] ?? null`, reasons `["curated"]` plus `"unmapped"` when `pi_id === null`, `feed_url` from `catalog.json`; (b) every `topRows` row with `c === false` whose `id ∈ changedIds`, in `topRows` order, cut at `topN`: reasons `["changed_in_dump"]`, `feed_url = u`, `episode_count = n`; a `pi_id` present in both merges reasons (each reason once). Tier via PKG-05 `seedTier({ episodeCount: episode_count, oldestItemPubdate: null, newestItemPubdate: null, watchReasons })` (no pubdates in top.json → weekly, lifted to daily for curated). `changeIndex.ok === false` → only (a) rows.
   - `expireOpened(rows, nowMs, days = 90)` pure: drops rows whose `opened_at_ms` is set and `nowMs - opened_at_ms > days * 86_400_000` (exactly 90 days is kept); unused by the dry-run, documented so.
   - `summarize(rows)` → `{ total, mapped, unmapped, byReason: {...}, byTier: {...} }`.
   - `assertSeedSize(rows, min = 200)` throws `RangeError` when `rows.length < min`.
2. `tools/poll/build-watchlist-seed.mjs` (CLI): reads `data/catalog.json`, `loadChangeIndex()`, writes `data/watchlist-seed.json` = `{ version: 1, built_at, pointer_release_tag, rows: WatchRow[] }` with ONLY the curated rows (~220; `changed_in_dump` is recomputed at run time, never committed). `--check` re-derives and diffs (ignoring `built_at`), exit 1 on stale. `loadChangeIndex` `ok:false` → print reason, exit 2, write nothing. `assertSeedSize` before writing.
3. Commit `data/watchlist-seed.json` (< 60 KB). Do NOT add it to any `RUNTIME_DATA` list.

**Tests to add:** `tools/poll/watchlist.test.mjs` with a fake `changeIndex`:
- "curated rows carry reason curated and the catalogue feed_url; an unmapped curated row is kept with pi_id null and reason unmapped". Mutation: drop unmapped → red.
- "changed ∩ top-N non-curated rows carry changed_in_dump and stop at topN" (topN=2, 3 changed). Mutation: ignore topN → red.
- "a curated row that is also changed has both reasons once". Mutation: push twice → red.
- "curated rows are daily; a changed non-curated row with no pubdates is weekly". Mutation: skip seedTier → red.
- "expireOpened drops rows older than 90 days; exactly 90 days is kept". Mutation: `>`→`>=` → red.
- "assertSeedSize rejects fewer than 200 rows". Mutation: threshold 0 → red.
- "changeIndex.ok false yields curated rows only". Mutation: throw → red.
Floor line.

**Commands:** `node --test tools/poll/watchlist.test.mjs`; `node tools/poll/build-watchlist-seed.mjs` (→ `wrote data/watchlist-seed.json: <n> rows …`); `node tools/poll/build-watchlist-seed.mjs --check` → exit 0; `node --test test/suite-integrity.test.js`.

**Do not touch:** `tools/refresh/candidates.mjs` (import only), `tools/shows/**`, `data/catalog.json`.

**Stop and escalate if:** `loadChangeIndex` returns `ok:false` (PKG-00 not done or regressed; report the reason, do not widen `maxAgeHours`); `summarize().mapped < 200`; `id-map.json` values are not numbers.

**Definition of done:** DRAFT PR `PKG-07 (S-10): watchlist builder + committed seed`; tests and `--check` green; PR body pastes `summarize()` output.

### PKG-08 · `tools/poll/poll-episodes.mjs --dry-run` — qwen, S

**Executor:** qwen. Composition of PKG-05..07 with fixed exit codes; fetches no feeds; **imports nothing from `tools/shows`** (that module pulls `pg-copy-streams` and `node:sqlite` at import time and would break the root `node --test` group in CI).

**Context:** PKG-05/06/07 exports; `.gitignore` line `data-local/`; `tools/shows/load-postgres.mjs` `pathToFileURL` main-guard pattern (read only, for the idiom); `docs/DECISIONS.md` 2026-09-24 issue #701 entry ("nothing generated is committed").

**Exact change:** `tools/poll/poll-episodes.mjs`:
1. Inline `export const DATABASE_URL_VARS = ["SHOWS_DATABASE_URL", "DATABASE_URL"]` and `export function resolveDatabaseUrl(env = process.env) { for (const v of DATABASE_URL_VARS) if (env[v]) return { url: env[v], varName: v }; return { url: null, varName: null }; }`.
2. Flags: `--dry-run`, `--top-n <int>` (5000), `--per-run-cap <int>` (300), `--out <path>` (default `data-local/poll/dry-run-<YYYY-MM-DD>.json`), `--now <ISO>`, `--seed <path>` (default `data/watchlist-seed.json`).
3. Without `--dry-run`: no URL → print `poll-episodes: no database (gates G1 DATABASE_URL / G3 SHOWS_DATABASE_URL, see HUMAN-ACTIONS.md); nothing to do`, exit 0; URL set → print `poll-episodes: live mode is not built (PKG-10); refusing`, exit 3, no network. With `--dry-run`: load seed (unreadable → exit 1); `loadChangeIndex()` (default max-age); `ok:false` → continue with seed only, record `change_index: { ok:false, reason }`; `buildWatchlist`; `selectDue` at `--now`; `weeklyProjection`; write `{ version:1, now, seed_rows, change_index, watchlist: summarize(), due: { count, byHost: top 10, sample: first 20 [pi_id,title,feed_url,tier] }, skipped, projection, fetched: 0 }`; print `dry-run: <due.count> due of <total> watched; <requestsPerWeek>/week projected at N=<topN> (target < 40000); fetched 0`; exit 0.
4. Export `runDryRun(opts)` (accepts an injected `changeIndex` for tests); `main()` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`.

**Tests to add:** `tools/poll/poll-episodes.test.mjs` (header notes: spawns `node` twice, sequentially):
- "no --dry-run and no DB env exits 0 naming gates G1 and G3" (scrubbed env; stdout contains `G1` and `G3` and `HUMAN-ACTIONS.md`). Mutation: exit 1 → red.
- "no --dry-run with SHOWS_DATABASE_URL set refuses with exit 3". Mutation: exit 0 → red.
- "DATABASE_URL_VARS is exactly SHOWS_DATABASE_URL then DATABASE_URL". Mutation: reorder → red.
- "runDryRun with a fake changeIndex writes the summary shape and fetched is 0". Mutation: drop `projection` → red.
- "a failed change index still yields a dry run from the seed alone" (`change_index.ok === false`, `due.count > 0`) — the realistic path whenever the weekly release is late. Mutation: throw on `ok:false` → red.
- "the printed line carries the 40,000 target". Mutation: remove `target` → red.
Floor line.

**Commands:** `node --test tools/poll/poll-episodes.test.mjs`; `node tools/poll/poll-episodes.mjs --dry-run` → one line, exit 0, a file under `data-local/poll/`; `git status --short` shows nothing under `data-local/`; `node --test test/suite-integrity.test.js`; once: `node tools/ci/run-suites.mjs`.

**Do not touch:** `.github/**`, `backend/**`, `tools/refresh/**`, `tools/shows/**`.

**Stop and escalate if:** `data-local/` not gitignored; projection at N=5000 exceeds 40,000/week (report; do not tune tiers); the suite fails in the root group because of an import (means something pulled a package dep — remove it).

**Definition of done:** DRAFT PR `PKG-08 (S-10): poll-episodes dry-run CLI`; tests green; PR body pastes the summary line and `projection`.

### PKG-09 · `.github/workflows/episode-poll.yml` (dry-run) — opus, XS

**Executor:** opus. `.github/` DENIED; cadence is founder Q3.

**Context:** `.github/workflows/shows-import.yml` (cron `7 6 * * 0`, off-the-hour rationale, `concurrency`), `.github/workflows/nightly-watch.yml` (artifact upload), PKG-08's exit codes, `tools/ci/path-policy.test.mjs` (workflow-invoked script acknowledgement rule).

**Exact change:** new `episode-poll` workflow: `schedule: cron "23 5 * * *"` (comment: daily until a DB exists per Q3's default) + `workflow_dispatch`; `concurrency: { group: episode-poll, cancel-in-progress: false }`; `permissions: contents: read`; steps: checkout, setup-node 22, `node tools/poll/poll-episodes.mjs --dry-run --out poll-summary.json`, `actions/upload-artifact` (retention 14 days). No secrets. If `tools/ci/path-policy.test.mjs` flags the invocation, add the acknowledgement with reason "not a gate".

**Commands:** `node --test tools/ci/path-policy.test.mjs`; after merge `gh workflow run episode-poll` and read the artifact.

**Stop and escalate if:** the founder answers Q3 "hourly" (then add a runner-minutes estimate to the PR).

**Definition of done:** DRAFT PR `PKG-09 (S-10): episode-poll dry-run workflow`, `founder-approved` requested, batched with PKG-04.

### PKG-10 · Live poller path — opus, M, BLOCKED

Not detailed on purpose: cannot start until G1/G3 exist and PKG-02 has merged; touches `backend/migrations/0020_watchlist.sql`, real publisher traffic (conditional GET via a port of `backend/src/feeds/conditionalGet.ts` `fetchFeedConditional` or a `tsx` shim), and an upsert into `catalog_show_episodes` keyed by `pi_id`. When unblocked, write its own 5–7 task plan with the acceptance the card names (50-feed local HTTP fixture, fake clock, 304 reschedules, 5 failures → backoff). Until then PKG-08's `exit 3` is the honest state.

### PKG-11a · P-09 data, index half — qwen, S

**Executor:** qwen. A join on a key both files carry; `--check` builder; byte-diffable output. Zero ranking change: `search-engine.js` `function popularityBand(show)` returns 0 for any non-breadth row.

**Context:** `tools/build-show-index.mjs` `export function mergeShowIndexRows(curated, breadth, { maxRank = BUILD_MAX_RANK } = {})`; inside it the curated loop line `rows.push({ title, id, chart_rank: null, curated: true });` and the breadth loop line `if (show?.in_curated) continue; // already carried by the curated row above`; `export function formatShowIndex(rows)`; `tools/build-show-index.test.mjs` tests "committed index equals builder output" and "carries every curated show"; `test/show-index.test.js` test `the committed index is under S-03's 400 KB gzipped budget` (the current index gzips to ~207 KB; the test's "~398 KB" comment is stale — leave it); `test/show-search-ranking.test.js` (must stay green, unedited).

**Exact change:**
1. In `mergeShowIndexRows`, BEFORE the curated loop: `const rankByAppleId = new Map();` filled from **ALL rows of `breadth.shows` with no `in_curated` filter**: key `String(row.apple_collection_id)`, value `Number(row.chart_rank)` only when finite and `> 0`. In the curated loop: `chart_rank: rankByAppleId.get(String(show?.apple_collection_id)) ?? null`. The breadth loop and its `in_curated` skip are unchanged. Header comment paragraph: "P-09 data half (PKG-11a): curated rows carry their Apple chart rank when a breadth twin exists; `popularityBand` ignores it until PKG-13."
2. `node tools/build-show-index.mjs`. The `data/show-index.tsv` diff must change ONLY column 3 of rows whose curated column is `1`. Count: `awk -F'\t' '$4=="1" && $3!=""' data/show-index.tsv | wc -l` (plausible 120–220; P-09 measured 164 on 2026-09-12).

**Tests to add:** in `tools/build-show-index.test.mjs`: "a curated row carries its breadth twin's chart_rank joined on apple_collection_id, and null without a twin" (two curated shows; one twin `in_curated: true`, rank 14). Mutation: remove the Map lookup → red. Raise its floor by 1.

**Commands:** `node --test tools/build-show-index.test.mjs`; `node tools/build-show-index.mjs --check`; `node --test test/show-index.test.js`; `node --test test/show-search-ranking.test.js` (green, unchanged); `node --test test/show-search-live.test.js`; `node --test test/suite-integrity.test.js`; `node tools/search-probe.mjs --check --no-network` (exit 0; paste before/after hit counts for `l`, `lex`, `hist`).

**Do not touch:** `search-engine.js`, `app.js`, `backend/**`, `api/**`, `tools/build-catalog-client.mjs`, `data/catalog-client.json`, `test/show-search-ranking.test.js`, `test/show-page.test.js`, `tools/ci/**`.

**Stop and escalate if:** the diff touches any breadth row or any title/id column; the gz test fails; any `test/show-search-*.test.js` fails; ranked count outside 120–220.

**Definition of done:** DRAFT PR `PKG-11a (P-09 data): curated chart_rank in show-index.tsv`; body states ranked count, gz before/after, "ranking unchanged".

### PKG-11b · P-09 data, client half — qwen, S

**Executor:** qwen. Same join in the client builder, plus the exact-key pin in `test/show-page.test.js` that would otherwise go red. Runs after PKG-11a merges.

**Context:** `tools/build-catalog-client.mjs` `export const CLIENT_SHOW_FIELDS = [`, `export function projectShow(show)`, `export function buildCatalogClient(catalog)`, `function main()` (reads only `data/catalog.json`; `--out`/`--check`); `test/show-page.test.js` test `catalog-client.json carries exactly the six fields renderShow() reads, plus Family mode's show rating, for every show` and its line `const expectedKeys = ["show_id", "title", "artwork_url", "editorial_note", "taxonomy_node_ids", "episode_count", "explicit"].sort();` (its header names "add a field to CLIENT_SHOW_FIELDS" as the mutation); `tools/build-show-index.mjs`'s `rankByAppleId` from PKG-11a (copy the same 5 lines; do not import across builders); `data/catalog-breadth.json` (`shows[].apple_collection_id`, `chart_rank`).

**Exact change:**
1. Append `"chart_rank"` to `CLIENT_SHOW_FIELDS` (last). `buildCatalogClient(catalog, breadth = null)`: when `breadth` is given, build the same `rankByAppleId` Map over ALL `breadth.shows` and set `chart_rank` per row (`null` without a twin); when `breadth` is null, `chart_rank: null`. `main()` reads `data/catalog-breadth.json` and passes it.
2. `test/show-page.test.js`: add `"chart_rank"` to `expectedKeys` with the comment `// P-09 / PKG-11b: curated Apple chart rank, read by popularityBand from PKG-13`, and retitle the test `catalog-client.json carries exactly the six fields renderShow() reads, plus Family mode's show rating and P-09's chart_rank, for every show`.
3. `node tools/build-catalog-client.mjs`; the `data/catalog-client.json` diff must add ONLY `"chart_rank": <n|null>` lines.

**Tests to add:** new `tools/build-catalog-client.test.mjs` (none exists on main; confirm with `ls`): "projectShow/buildCatalogClient emit chart_rank from the breadth join and null otherwise"; "the committed data/catalog-client.json equals the builder's output". Mutation: drop `"chart_rank"` from `CLIENT_SHOW_FIELDS` → both red. Floor line `// PKG-11b (P-09)`.

**Commands:** `node --test tools/build-catalog-client.test.mjs`; `node tools/build-catalog-client.mjs --check`; `node --test test/show-page.test.js`; `node --test test/show-search-ranking.test.js`; `node --test test/show-search-live.test.js`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `search-engine.js`, `app.js`, `player/**`, `backend/**`, `tools/build-show-index.mjs`, `data/show-index.tsv`.

**Stop and escalate if:** `show-page.test.js` has a second key pin you did not expect; the client diff touches any non-`chart_rank` line; ranked count differs from PKG-11a's by more than 0 (same join, same inputs).

**Definition of done:** DRAFT PR `PKG-11b (P-09 data): curated chart_rank in catalog-client.json + show-page pin`; body states ranked count and file-size delta.

### PKG-12 · P-10 probe — qwen, XS

**Executor:** qwen. Measurement script with a committed JSON report; no ranking change. Uses an unbounded pointer age so it runs whether or not PKG-00 is done, and records the age.

**Context:** `docs/search-parity-plan.md` P-10; `tools/shows/shard-build.mjs` `buildTop` (curated + top 2,000 non-curated by `popularityScore`; row `i` = itunesId, `c` curated; the score itself is NOT in the row — position is the signal); `tools/refresh/candidates.mjs` `loadChangeIndex` (accepts `maxAgeHours`); `search-engine.js` `parseShowIndex` (breadth `show_id` = Apple collection id string); `tools/search-probe.mjs` (how it requires `search-engine.js`; usage line `node tools/search-probe.mjs [--out path] [--check] [--no-network]`); `test/show-search-ranking.test.js` the four pinned queries (`["history", "Dan Carlin's Hardcore History"]`, `daily` → *The Daily*, `money` → *Planet Money*, `american` → *This American Life*); `docs/research/` exists.

**Exact change:** `tools/popularity-signal-probe.mjs` (`--out <path>`, `--check` validates shape only):
1. Load `data/show-index.tsv` via `SearchEngine.parseShowIndex` and `data/catalog-client.json` + `data/catalog.json` (for `apple_collection_id`).
2. `loadChangeIndex({ maxAgeHours: Number.POSITIVE_INFINITY })` → `topRows`; `posByItunesId: Map<string, number>` = `String(row.i)` → index in `topRows`; also record `c`.
3. Report: `{ generated_at, pointer_release_tag, pointer_published_at, pointer_age_hours, coverage: { index_rows, breadth_rows_with_top_position, curated_rows_with_top_position, pct_breadth }, queries: { [q]: { top25: [[rank,title,tier,chart_rank,top_position|null]], intended: { title, rank_today, top_position }, would_lead_by_top_position } } }` where `would_lead_by_top_position` = the intended show has the smallest non-null `top_position` among same-tier rows ranked above it. Print a 6-line summary; exit 0.

**Tests to add:** `tools/popularity-signal-probe.test.mjs`: "coverage counts a breadth row by Apple id and a curated row by catalogue apple_collection_id" (mutation: skip `String()` coercion → 0 → red); "would_lead_by_top_position is false when a higher row has a smaller position" (mutation: flip comparison → red); "validateReport rejects a report missing pointer_age_hours or any of the four queries" (mutation: drop a key → red). Floor line.

**Commands:** `node --test tools/popularity-signal-probe.test.mjs`; `node tools/popularity-signal-probe.mjs --out docs/research/popularity-signal-probe-2026-09-25.json` (one release download, < 1 MB); `node --test test/suite-integrity.test.js`.

**Do not touch:** `search-engine.js`, `app.js`, data files, `tools/search-probe.mjs`, `tools/refresh/**`.

**Stop and escalate if:** `top.json` rows lack `i`; breadth coverage is exactly 0 (join bug).

**Definition of done:** DRAFT PR `PKG-12 (P-10): popularityScore position probe + report`; committed JSON; body pastes `pct_breadth`, `pointer_age_hours`, the four `intended` blocks.

### PKG-13 · P-09 rule half — opus, S

**Executor:** opus. A ranking rule with a named loser set, three pinned tests to re-argue, and a server mirror in `backend/src/catalog/` (DENIED).

**Context:** `search-engine.js` `function isBreadthShow(show)`, `const SHOW_PRIOR_BANDS = [10, 50, 200];`, `function popularityBand(show)` (`if (!isBreadthShow(show)) return 0`), `function compareShowMatches(a, b)`; `backend/src/catalog/searchBreadthShows.ts` `export function popularityBand(show: CatalogueShowEntry): number`; `backend/src/catalog/breadthCatalog.ts` line `chart_rank: null, // a curated row has no chart position` and `function normalizeChartRank(`; `test/show-search-ranking.test.js` the `popularityBand(curated("Zeta Curated Show")), 0` pin, the `SHOW_PRIOR_BANDS, [10, 50, 200]` pin, the real-index relation test, the server-table pin; `backend/test/breadthCatalog.test.ts` curated `chart_rank: null` pins; `docs/search-parity-plan.md` P-09 done-when; `tools/search-probe.mjs`.

**Exact change (opus confirms by measurement):**
1. Client: for a curated row `popularityBand` returns `1 + band(chart_rank)` when finite, else `SHOW_PRIOR_BANDS.length + 1`; safe because `compareShowMatches` separates curated from breadth before the band. Re-argue the `=== 0` pin as "a curated row with no rank is the worst CURATED band and still beats every breadth row"; add "history puts Hardcore History above Ancient History Fangirl; science puts Science Vs above Science for Sport" over the real files. Raise the floor.
2. Measure first: list curated shows with `chart_rank === null` in `data/catalog-client.json`; for each, every query in the 12-query battery + `history`/`science`/`news`/`true crime` where its rank moves; table in the PR body. If a founder-important show drops off page 1 for its own name, stop and ask (Q4).
3. Server: `breadthCatalog.ts` curated entries take `chart_rank` via the same Apple-id join; `searchBreadthShows.ts` `popularityBand` mirrors; `backend/test/breadthCatalog.test.ts` pins updated; the client's server-table pin still passes.
4. `tools/search-probe.mjs --check --no-network` before/after in the PR body.

**Commands:** `node --test test/show-search-ranking.test.js`; `node --test test/show-search-live.test.js`; `node --test test/show-search-fallthrough.test.js`; `node --test test/show-index.test.js`; `node --test test/show-page.test.js`; `cd backend && npm test -- breadthCatalog searchBreadthShows`; `node tools/search-probe.mjs --check --no-network`.

**Do not touch:** `app.js`, `api/**`, data files.

**Definition of done:** two DRAFT PRs (`PKG-13a (P-09): curated ranks inside the curated tier`; `PKG-13b (P-09): server mirror`, `founder-approved` requested), each with the before/after table; P-09's done-when quoted and ticked.

### PKG-14 · Re-harvest `data/catalog-breadth.json` with `artist_name` — opus, S

**Executor:** opus. ~170 Apple requests ≥3 s apart rewrite a 12 MB file; chart ranks move; pinned real-index tests may move and someone must read why.

**Context:** `tools/harvest-catalog.mjs` line `artist_name: r.artistName ?? null,`; `docs/CATALOG-PIPELINE.md` politeness section; `tools/build-show-index.mjs` and `tools/build-catalog-client.mjs` (with PKG-11a/b joins); `search-engine.js` comment `P-03b (docs/search-parity-plan.md): artist_name IS DELIBERATELY NOT READ`; `docs/search-plan.md` §1.1.

**Exact change:** run the harvest on the founder's box (only place with the characterised budget), **not concurrently with any other task**; regenerate both data files; run the search suites one at a time; write `docs/research/reharvest-2026-09-<dd>.md` with row count before/after, `artist_name` fill rate, `in_curated` count, index rows and gz bytes, the four pinned queries' positions before/after, ranked-curated count before/after. No ranking rule change; if a pinned test moves, state whether the fixture assumption or the rule broke.

**Commands:** `node tools/harvest-catalog.mjs` (record wall time and request count); `node tools/build-show-index.mjs`; `node tools/build-catalog-client.mjs`; one at a time: `node --test test/show-index.test.js`, `test/show-page.test.js`, `test/show-search-ranking.test.js`, `test/show-search-live.test.js`, `test/show-search-fallthrough.test.js`, `test/show-search-shard.test.js`, `tools/build-show-index.test.mjs`, `tools/build-catalog-client.test.mjs`; `node tools/search-probe.mjs --check`; `cd backend && npm test -- breadthCatalog`; `node tools/mobile/prepare-webdir.mjs --check` if that flag exists (512 KB cap).

**Stop and escalate if:** fewer than 18,000 rows; index over the 400 KB gz budget; more than one pinned real-index query changes position.

**Definition of done:** DRAFT PR `PKG-14 (P-03a): re-harvest with artist_name`, data diff + research note; body says which tests moved and why.

### PKG-15 · P-04 decision memo — opus, S

**Executor:** opus. Product judgement written for the founder.

**Context:** `docs/search-parity-plan.md` P-03b, P-04, P-10, §5 AMENDED paragraph; `docs/search-plan.md` §1.8 (`tim ferriss` prefix defect; `lex fridman` ceiling); PKG-12's report; PKG-14's fill rate and sizes; §2.3 budget.

**Exact change:** append `### P-04 · DECIDED <date>` to `docs/search-parity-plan.md` with three questions and one recommendation each, every number sourced: (1) tail or rows; (2) the leading-article defect (recommend an exact-tier rule for a later card with the 30-query battery as acceptance); (3) P-10 option 1/2/3 from PKG-12's coverage and `would_lead_by_top_position`. File one item in `HUMAN-ACTIONS.md`, `## #<next> 🟡 [DECIDE] Search: tail vs rows, and the P-10 signal` (re-derive the id at the time; expected #126 after PKG-03 and PKG-16).

**Commands:** `node --test test/human-actions-integrity.test.js`.

**Definition of done:** DRAFT PR `PKG-15 (P-04): decision memo + founder question`; docs only.

### PKG-16 · P-07 founder listening test — opus, XS

**Executor:** opus. Founder-facing protocol with an honest build gate (`docs/search-plan.md`: "P-01's build is still the prerequisite for P-07").

**Context:** `docs/search-parity-plan.md` P-07; `tools/search-probe.mjs` `export const SCAN_REACH_CASES = [` and `export const PARITY_CASES = [`; `docs/field-records/` (one record exists; copy its shape); `player/diagnostic-log.js` `search` entry fields.

**Exact change:** add `## #<next> 🟡 [DECIDE] Search listening test (P-07): five searches on your phone (~10 min)` to `HUMAN-ACTIONS.md` (re-derive; expected #125 after PKG-03): which build (name it if known, else "the next build the native-engine track ships"), the protocol (five queries he chooses, typed not pasted, position of the intended show or "not found", Copy diagnostics), where to paste (`docs/field-records/<date>-search-p07.md` from a new `docs/field-records/TEMPLATE-search-p07.md`), and what a miss becomes (a `PARITY_CASES`/`SCAN_REACH_CASES` entry via a follow-up qwen task).

**Commands:** `node --test test/human-actions-integrity.test.js`.

**Definition of done:** DRAFT PR `PKG-16 (P-07): founder listening-test item + field-record template`.

---

## 4. Sequencing

**Concurrency cap today:** the founder's box is memory-bound (2026-09-25). Run **one task at a time on the local machine**; "parallel" below means file-disjoint and safe to interleave, not to be run simultaneously. Cloud/CI-only work (PKG-00's re-dispatch, watching PR checks) may overlap with one local task.

**Wave 0:** PKG-00 (pointer/shows-import repair). Nothing else needs it except PKG-07 (hard) and PKG-08's realistic path.

**Wave 1 (file-disjoint):** PKG-01 (`tools/shows/*` + FLOORS), PKG-03 (`HUMAN-ACTIONS*.md`, four docs), PKG-05 (`tools/poll/tiers*`), PKG-11a (`tools/build-show-index.*`, `data/show-index.tsv`), PKG-12 (`tools/popularity-signal-probe*`, `docs/research/`). PKG-11b follows PKG-11a's merge (`tools/build-catalog-client.*`, `data/catalog-client.json`, `test/show-page.test.js` — no other task edits `show-page.test.js`). PKG-01/05/11a/11b/12 all touch `test/suite-integrity.test.js` on different lines: rebase serially, merge in the order they go green.

**Wave 2:** PKG-02 (after PKG-01; edits `BACKEND_FLOORS` in `test/suite-integrity.test.js` — serialise with any open Wave-1 floor edit; human merge), PKG-06 and PKG-07 (after PKG-05, PKG-07 also after PKG-00; disjoint files), PKG-13 (after PKG-11b; client PR then server PR), PKG-14 (after PKG-11b merges and never alongside PKG-13 — same two data files; also never alongside any other local task, it is the harvest).

**Wave 3:** PKG-04 (after PKG-02 + PKG-03), PKG-08 (after PKG-06 + PKG-07), PKG-16 (after PKG-03; serialise with PKG-15 on `HUMAN-ACTIONS.md`).

**Wave 4:** PKG-09 (after PKG-08; batch its `founder-approved` with PKG-04 and PKG-13b), PKG-15 (after PKG-12, PKG-13, PKG-14).

**Blocked:** PKG-10 until G1/G3 are answered and PKG-02 is merged.

Founder sittings: one label sitting for PKG-02 (+ PKG-13b, + PKG-00 if its fix is in `.github/`), one for PKG-04 + PKG-09; answers to Q1–Q8 whenever convenient, none blocking Waves 0–3.
