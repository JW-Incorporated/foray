# Package plan: Foray generation correctness + the unblocked G-deck (revision 2)

Written 2026-09-25 against `origin/main` as fetched today; every path and line below was re-checked with `git show origin/main:<path>` / `git grep`. Package id prefix: **GEN-**.

**What changed in this revision (reviewer round).** All nine reviewer problems are accepted and fixed in place: GEN-03's file list is pinned; GEN-01's test 29 uses a POSIX absolute path and `resolveDriverPathArgs` returns `{ args, rewritten }`; GEN-05 adds the flags to `parseArgs` and returns an `exitCode` instead of calling `process.exit`; GEN-04's `--notify` example is `node ../tools/foray/digest.mjs` (the hook runs from `backend/`); GEN-06 places the ruling under `## 10. Sources` and expects a two-file diff; GEN-14 now depends on GEN-07; GEN-18 → GEN-15 → GEN-24 are serialized; GEN-19 depends on GEN-17. Two reviewer premises were corrected while verifying: `sourceBeats.ts` DOES import `segmentPoolLookup` (:180) and `transcriptArchiveLookup` (:206) as well as `audioSourceLookup` (type-only, :18) and `catalogueLookup` (:213) — the pinned five-file list is still the right fix; and `start-run.mjs`'s second usage block is at :52-54, not :11-13. Stale line numbers were also refreshed: `tools/generation/relay.test.mjs` now holds **33** tests (floor `33` at `test/suite-integrity.test.js` :1442), so GEN-01 adds tests 34–36 and GEN-02 adds 37–39; `relay.mjs` cites moved (`doneDir` :368, `counters` :383, `answer()` :489, `pending.delete` :551, `sweepReplies()` :584, the bare `continue` :597); `start-run.mjs` (`splitArgs` :81, `driverEnv` :130, `main` :138, spawn :171, log :176); `generateForays.ts` (`get` :125, `--prompts` :141, `--out` :142, `duration` default :143, `path.resolve(args.prompts)` :801); bench floor at :1429; `VeracityMetrics` :819, `buildVeracityMetrics` :927.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** Make the generation pipeline's *judgements* honest before the first keyed run (the five open issues #704, #706, #709, #710, #712 and the one L4/`long_reason` gap found while verifying #706), land the keyless halves of the G-deck cards that need no founder decision (G-02, G-21a-behind-a-flag, G-21b, G-23 remainder, G-37a/b, G-42b's comparison half), and leave the keyed cards (G-01, G-20, G-37c, G-37d, G-42b's schedule) as ready-to-run opus tasks gated only on the credential and the named decisions.

**Done when.** (1) Every GEN task marked qwen or opus-unblocked is merged, with its mutation-named tests green in CI; (2) `npm run generate-forays` on the founder's PC with a real key prints `MODE: live — … opus=claude-opus-5 sonnet=claude-sonnet-5 haiku=claude-haiku-4-5-20251001` and completes one `medium` Foray whose `report.json` entry carries `usage`, `costUsd`, `tierDecision` and `windowSubjectRelevance`; (3) that candidate's publish PR refuses or passes on content, never on bookkeeping (#712's two false refusals are unrepresentable by test); (4) `tools/generation-bench/run.mjs --compare` prints a band verdict for that run against `baseline.jsonl`.

**What the pipeline runs on today, so nobody re-derives it.** G-30 (a)–(e) is built (`--max-resumes`, `--continue-on-refused-partial`, `--notify`, daily-budget wait) except the `medium` default; G-24 is closed by F-91 (`topicSupply.ts`); F-55 (slot-title suffix, `runPipeline.ts:478-498`) and F-56 (18-word clamp, `runPipeline.ts:417`) are done; G-21c parts 1 and 2 are done; G-42a is done; G-00 is done; G-22 is superseded. The relay `tools/generation/relay.mjs` is the sanctioned transport until a key exists.

**Dependencies.**
- *Credential:* an Anthropic Console API key placed by Wyatt (D1; GEN-23 writes the HUMAN-ACTIONS card). No `gh secret` and no `.env` holds one today. Blocks GEN-26, GEN-28, the keyed half of GEN-27.
- *Human merge click:* `backend/package.json` is **unlisted** in `tools/ci/path-policy.mjs` (neither ALLOWED nor DENIED), so GEN-16 (SDK upgrade) needs a founder click. `backend/src/` is DENIED, so every opus task there merges under the overlord's standing approval, never self-labelled.
- *Founder decisions:* D1 (key + caps), D4 (publish gate / hold default / draft→published), D7 (runtime band, F-58 severity), D11 (bench key in Actions), plus the two new product calls in Q2 and Q3 below.
- *Other packages:* Phase 1 supply (G-10…G-14, G-13b/#547) is not needed by anything here; GEN-15's subject-relevance numbers become more meaningful once G-13 gives per-episode topics. The native engine deck (M2–M4) is untouched. #315 (transcript overruns) stays with the DAI/prepare package; the `past-duration` gate already refuses the class.
- *Devices:* none.

**Open founder questions (with proposed defaults).**
1. **D1 — the key and the caps.** Default: a Console key (not a claude.ai login) in `backend/.env` on the founder's PC (the interim host), spend limit set in the Console, `DAILY_BUDGET_USD=25`, `EPISODE_BUDGET_USD=10` (today's code defaults, `backend/src/config/env.ts:106`).
2. **#709 — when the admissible tape cannot honestly fill the requested duration tier, does the run produce the next shorter tier (and say so in `report.json`), or stop?** Default: **produce the shorter tier**, never silently — `tierDecision` in the report and one log line (GEN-14).
3. **#712 — a seam whose prose the verifier confirmed, and whose only defect is a seed-lost beat (F-99), counts as verified and may publish?** Default: **yes**; the beat count stays visible as `seedLostBeats` (GEN-12).
4. **D4 — publish without `hold` when the veracity gate and the real-data suites are both green?** Default: build it behind `--hold auto` (GEN-22) but **keep `hold` as the default until two keyed Forays have passed** (GEN-26); the `status: draft → published` flip stays the one retained human keystroke.
5. **D7 — F-58 spoken-line rules on generated pages: warn or refuse?** Default: **warn only**, count in `report.json` (GEN-24); the runtime band stays unbuilt.
6. **D11 — a key in GitHub Actions secrets for a scheduled bench?** Default: **no key in Actions**; the host runs the bench on a cron and pushes rows, the workflow only compares (GEN-27).

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| GEN-01 | #704 `start-run.mjs` resolves `--prompts`/`--out` against the invoking directory | qwen | — | — | XS |
| GEN-02 | #710(b) relay refuses a file reply for an id that has left the queue | qwen | — | GEN-01 (same test file) | XS |
| GEN-03 | #706(1) the `sourceBeats.noFetch.test.ts` the module claims exists | qwen | — | — | XS |
| GEN-04 | G-21b `tools/foray/digest.mjs`: one issue comment per candidate from `report.json` | qwen | — | — | S |
| GEN-05 | G-42b(prep) bench `--compare`: trend-with-band verdict against `baseline.jsonl` | qwen | — | — | S |
| GEN-06 | F-37 write the connective-page sources ruling into `narration-craft.md` | qwen | — | — | XS |
| GEN-07 | G-30(c)+F-20 driver hygiene: `--duration` defaults to `medium`; UTF-8 console | opus | DENIED path `backend/src/cli/` | — | XS |
| GEN-08 | #706(2) minted clips over 240 s carry `long_reason` (L4 hatch) | opus | DENIED path; data-shape judgement | — | S |
| GEN-09 | #706(3–9) delete the seven un-deleted predecessors in the tape lane | opus | DENIED path; cross-cutting refactor | GEN-03 | S |
| GEN-10 | #712(3) the disclosure line lowercases a leading function word of the subject | opus | DENIED path | — | XS |
| GEN-11 | #712(1) a quote grounded in ANY of the seam's held docs is grounded | opus | DENIED path; gate semantics | — | S |
| GEN-12 | #712(2) a seed-lost-only seam is verified; `seedLostBeats` stays counted | opus | DENIED path; publish-gate policy (Q3) | GEN-11 (same file) | S |
| GEN-13 | #710(a) the second evidence query is composed, not cut | opus | prompt/retrieval design | — | S |
| GEN-14 | #709(1) the duration tier answers to the offered windows (`tierDecision`) | opus | product judgement (Q2); DENIED path | GEN-07 (same `generateForays.ts`) | S |
| GEN-15 | #709(2)+(3) per-window subject relevance measured into the trace and `report.json` | opus | DENIED path; metric design | GEN-09, GEN-18 | S |
| GEN-16 | Upgrade `@anthropic-ai/sdk` to a version with `output_config`, `effort`, `web_fetch` | opus | credentials-adjacent SDK change; unlisted path (human merge) | — | XS |
| GEN-17 | G-02(a) effort + caps with a thinking allowance + model ids in the MODE banner | opus | LLM design; DENIED path | GEN-16 | S |
| GEN-18 | G-02(c) `usage` and `costUsd` per Foray in `report.json`; bench reads it | opus | DENIED path | GEN-17 | S |
| GEN-19 | G-02(b)/F-48 hold server-attested `cited_text` as the evidence document | opus | LLM/tool design; DENIED path | GEN-16, GEN-17 | S |
| GEN-20 | G-37a prompt caching on the per-slot evidence block and the spine prefix | opus | LLM design; DENIED path | GEN-17 | S |
| GEN-21 | G-37b structured outputs on every builder; delete the re-ask path they retire | opus | LLM design; DENIED path | GEN-16, GEN-17 | S |
| GEN-22 | G-21a `publish-foray --hold auto` (no `hold` when gate and suites are green) | opus | publish-gate policy (D4); DENIED path | — | S |
| GEN-23 | G-01 HUMAN-ACTIONS card for the API key and caps | opus | credentials guidance | — | XS |
| GEN-24 | F-58 `spokenLineErrors` over generated pages as warnings (severity per D7) | opus | narration-rule judgement; DENIED path | GEN-12, GEN-15 | S |
| GEN-25 | Tracker rows F-88…F-103 / I-25…I-28 and roadmap DONE markers | opus | judgement from run records | — | S |
| GEN-26 | G-20 the two keyed runs, every human touch counted | opus | keyed spend; field diagnosis | GEN-07, 08, 11–15, 17, 18, 23 (key) | M |
| GEN-27 | G-42b the scheduled comparison workflow (host runs, Actions compares) | opus | DENIED path `.github/`; D11 | GEN-05, GEN-18 | S |
| GEN-28 | G-37c Haiku verifier trial behind `VERIFIER_TIER` | opus | LLM judgement; needs ≥3 keyed runs | GEN-26 | S |
| GEN-29 | G-37d per-slot streaming: design comment only (D6) | opus | contract design; deferred | GEN-26 | S |

Count: 29 tasks, 6 qwen, 23 opus. The opus share is high because `backend/src/` is a DENIED path; every qwen task is on an allowed lane (`tools/`, `test/`, `backend/test/`, `docs/`).

**Conventions that apply to every task (repeated in each task's "Conventions" line).** Worktree: `git -C "C:/Users/wjduv/Desktop/Vibe Coding/foray" -c core.autocrlf=false worktree add <dir-with-no-spaces, e.g. C:/w/GEN-nn> -b t_GEN-nn/<slug> origin/main` (a path with a space breaks `backend/test/finalizeForay.test.ts`, F-21). Never commit `deploy-manifest.json` or `data/forays-directory.json`; `sw.js` keeps `BUILD_ID = "unstamped"`; never run `format:write` repo-wide; CRLF files stay CRLF. Run one test process at a time. A new `tools/**/*.test.mjs` or `player/**/*.test.js` suite needs a floor in `test/suite-integrity.test.js` `FLOORS` in the same PR; a raised test count in an existing suite raises its floor. Tests that name a Foray use `tools/foray/fixtures/frozen/data/*.json`, never live `data/`. PRs open as **DRAFT**, titled `GEN-nn: <title>`, body cites the issue/card and names each mutation the tests kill; never apply the `founder-approved` label yourself. Commit messages end with the two attribution trailer lines your session was given (`Co-Authored-By: …` and `Claude-Session: …`).

## 3. Tasks

### GEN-01 · #704 `start-run.mjs` resolves `--prompts` / `--out` against the invoking directory — qwen · XS

**Executor:** qwen. `tools/generation/` is an ALLOWED lane; no judgement: the rule is stated below.

**Context (read first).**
- `tools/generation/start-run.mjs` — usage examples at :4 and :52-54; `splitArgs()` :81 (everything after `--` is the driver's, verbatim), `driverEnv()` :130, `main()` :138-190; the spawn at :171 runs the driver with `cwd: backendDir` (= `<repo>/backend`); the log line at :176 prints `args.driverArgs`.
- `backend/src/cli/generateForays.ts` `parseArgs` :125-153 — `get(flag)` :125 reads a space-separated value; `--prompts` :141, `--out` :142 (defaults to `data-local/foray-candidates`); :801 `path.resolve(args.prompts)` resolves against the driver's cwd, which is why a repo-root-relative path fails (issue #704).
- `tools/generation/relay.test.mjs` — :62 already imports `splitArgs, driverEnv, driverEntryFromPackage, PLACEHOLDER_KEY, REPO_ROOT` from `./start-run.mjs`; tests 23–27 (:525-598) exercise the launcher; the suite holds **33** tests and its floor is `"tools/generation/relay.test.mjs": 33` in `test/suite-integrity.test.js` :1442.

**Exact change.**
1. In `tools/generation/start-run.mjs` add and export `DRIVER_PATH_FLAGS = ["--prompts", "--out"]` and `resolveDriverPathArgs(driverArgs, cwd)` → `{ args: string[], rewritten: Array<{ flag: string, from: string, to: string }> }`. `args` is a NEW array (the input is never mutated): for `i` in `0..driverArgs.length-1`, when `driverArgs[i]` is exactly one of `DRIVER_PATH_FLAGS` AND `i + 1 < driverArgs.length` AND `driverArgs[i+1]` does not start with `--` AND `!path.isAbsolute(driverArgs[i+1])`, then `args[i+1] = path.resolve(cwd, driverArgs[i+1])`, push `{ flag, from: driverArgs[i+1], to: args[i+1] }` onto `rewritten`, and skip `i+1`. Every other element passes through untouched (including `--prompts=x` forms, which the driver does not parse either; a value that is already absolute is passed through by identity, `===`).
2. In `main()`: `const { args: driverArgs, rewritten } = resolveDriverPathArgs(args.driverArgs, process.cwd());` before the spawn; use `driverArgs` in the `spawn` call (:171) and in the log line (:176). When `rewritten.length > 0`, log one line before the spawn: `[start-run] path arguments resolved against <cwd>: --prompts <from> -> <to>, --out <from> -> <to>` (one `flag from -> to` clause per entry, comma-separated). Nothing is logged when `rewritten` is empty.
3. Update the usage examples at :4 and :52-54 with one sentence: `--prompts`/`--out` are taken relative to the directory you run the launcher from, not `backend/`.

**Tests to add** (append to `tools/generation/relay.test.mjs`, numbered 34–36; raise the floor at `test/suite-integrity.test.js` :1442 from 33 → 36 with a short comment):
- `34. --prompts and --out written relative to the repo root are resolved against the launcher's cwd, not backend/ (#704)`: `resolveDriverPathArgs(["--prompts","data-local/p.json","--duration","medium","--out","out-1"], "C:/x")` → `.args` deep-equals `["--prompts", path.resolve("C:/x","data-local/p.json"), "--duration","medium","--out", path.resolve("C:/x","out-1")]` and `.rewritten.length === 2` with `rewritten[0].flag === "--prompts"`. Mutation: return the input unchanged → red.
- `35. an absolute path and every other flag pass through verbatim, and the input is not mutated`: input `["--prompts", "/abs/p.json", "--dry-run", "--limit", "3", "--prompts=inline.json"]` with cwd `"C:/x"` → `out.args[1] === "/abs/p.json"` (POSIX-style absolute: `path.isAbsolute` is true on Windows and Linux, and `path.resolve("C:/x", "/abs/p.json")` yields `C:\abs\p.json`, which is NOT the input — so dropping the `isAbsolute` guard goes red on both platforms), `out.args.slice(2)` deep-equals the input's tail, `out.rewritten` deep-equals `[]`, and the original input array is unchanged (compare against a copy taken before the call). Mutation: drop the `isAbsolute` guard → red.
- `36. a trailing --prompts with no value is left alone`: `["--prompts"]` → `{ args: ["--prompts"], rewritten: [] }`. Mutation: index past the end (no `i + 1 < length` guard) → the value becomes `path.resolve(cwd, "undefined")`-ish or throws → red.

**Commands (repo root, one at a time).** `node --test tools/generation/relay.test.mjs` → 36 pass. `node --test test/suite-integrity.test.js` → pass (floor updated). `node --check tools/generation/start-run.mjs` → no output.

**Do not touch.** `backend/src/**` (the driver's own `path.resolve` stays), `tools/generation/relay.mjs`, any running relay under `data-local/relay/`.

**Stop and escalate if:** the driver's `parseArgs` in `generateForays.ts` turns out to accept `--prompts=<v>` (then the rule above would miss a form — report, do not extend); `relay.test.mjs` on your branch does not hold exactly 33 tests (renumber from the actual count and say so in the PR); any test outside `relay.test.mjs` or `suite-integrity.test.js` goes red.

**Definition of done.** All three commands green; DRAFT PR `GEN-01: start-run resolves --prompts/--out against the invoking cwd (#704)` citing #704 and naming the three mutations; the PR body quotes the new log line from one local `node tools/generation/start-run.mjs --relay-only` run (no driver, no key needed — expect no rewrite line, say so) plus the line printed by a `--dry-run` launch with a relative `--prompts`, if a prompts file exists locally; otherwise paste test 34's expected string.

**Conventions.** Worktree on a path without spaces off `origin/main`, branch `t_GEN-01/start-run-paths`; floor raised in the same PR; DRAFT PR; attribution trailers; one test process at a time.

### GEN-02 · #710(b) the relay refuses a file reply for an id that has left the queue — qwen · XS

**Executor:** qwen (allowed lane; deterministic transport rule).

**Context.**
- `tools/generation/relay.mjs` — `createRelay()`; `doneDir` :368; `counters` :383 (`calls, answered, errors, fenceStripped, retriesJoined, timedOut`); `answer(id, payload)` :489-556 returns `{ ok:false, reason:"unknown id" }` / `"already answered"` and, on success, moves `<id>.request.*`/`<id>.reply.*` to `done/` and ends with `pending.delete(id)` (:551; the comment at :417 documents this); `sweepReplies()` :584-616 — the defect is :597 `if (!entry || entry.answered) continue;`: a `<id>.reply.txt|json` for an id no longer parked is silently left in `queue/`; HTTP `POST /answer/:id` already answers 409 with the reason; `GET /kpi` returns `{...counters, pending, kpiPath, queueDir}` (grep `kpiPath` for the handler).
- `tools/generation/relay.test.mjs` — helpers `scratchDir()`, `withRelay(fn, opts)`, `post()`, `waitFor()`, `kpiRows()` (top of file, before test 1); test 11 `an answer written as a file settles the parked call` shows the file-answer path; test 28 (:600) shows how a leftover reply file is handled at start. Floor: `test/suite-integrity.test.js` :1442 (36 after GEN-01 — take whatever is on the branch you start from).

**Exact change.**
1. `counters` gains `rejectedReplies: 0`.
2. In `sweepReplies()`, replace the `continue` at :597 with: when `!entry` (unknown or already settled — `answer()` deletes settled ids from `pending`) or `entry.answered`: compute `target = path.join(doneDir, id + ".reply.rejected" + (json ? ".json" : ".txt"))`; if `fs.existsSync(target)`, insert `-<counters.rejectedReplies>` before the extension (`r9999.reply.rejected-1.txt`); `fs.renameSync(path.join(queueDir, name), target)`; `counters.rejectedReplies += 1`; `log(\`rejected reply for ${id}: not parked (answered or unknown) -> done/${path.basename(target)}\`)`; then `continue`. A half-written file is still left for the next sweep only when the id IS parked (unchanged).
3. No KPI row is appended for a rejected reply (KPI rows are one per call); `/kpi` exposes the counter through the existing spread.
4. Update the header comment's file-surface paragraph with one sentence: a reply for an id that is not parked is moved to `done/<id>.reply.rejected.*` and counted.

**Tests to add** (`tools/generation/relay.test.mjs`, numbered 37–39; raise the floor by 3):
- `37. a reply file for an id the relay never parked is rejected, moved to done/, and counted (#710)`: inside `withRelay`, write `queue/r9999.reply.txt`, call `relay.sweepReplies()`, assert the file is gone from `queue/`, `done/r9999.reply.rejected.txt` exists with the same bytes, `relay.counters.rejectedReplies === 1`, and `GET /kpi` JSON has `rejectedReplies: 1`. Mutation: restore the bare `continue` → red (file stays in `queue/`).
- `38. a reply file written AFTER the id was answered is rejected, not double-answered`: park one call via `post()`, answer it via `POST /answer/<id>` (with the run token, as test 31 does), then write `queue/<id>.reply.txt` and sweep → rejected file in `done/`, `counters.answered === 1`, exactly one KPI row for that id. Mutation: skip the `!entry` branch → red.
- `39. a rejected reply never overwrites an earlier rejected file of the same id`: write, sweep, write again, sweep → two files in `done/` (`.reply.rejected.txt` and `-1` suffixed). Mutation: drop the suffix → red (one file).

**Commands.** `node --test tools/generation/relay.test.mjs` → all pass; `node --test test/suite-integrity.test.js` → pass.

**Do not touch.** `answer()`'s HTTP semantics, `reset()`, `start-run.mjs`, anything under `data-local/`.

**Stop and escalate if:** `answer()` does not delete settled ids from `pending` on your branch (then the `!entry` test cannot hold — report); `sweepReplies` is not exported on the relay object returned by `createRelay()` (report; do not export it without saying so in the PR); any test 1–36 goes red.

**Definition of done.** Commands green; DRAFT PR `GEN-02: relay rejects a reply for an id that left the queue (#710)` naming the three mutations; the PR body says #710's first half (the query composition) is GEN-13.

**Conventions.** Branch `t_GEN-02/relay-rejects-consumed-reply` off `origin/main` (rebase onto GEN-01 if merged; if `FLOORS` conflicts, keep the higher number and re-run suite-integrity); DRAFT; trailers; floors in same PR.

### GEN-03 · #706(1) `backend/test/sourceBeats.noFetch.test.ts` — qwen · XS

**Executor:** qwen (`backend/test/` is ALLOWED; the rule is a source grep with a pinned file list).

**Context.**
- `backend/src/generation/sourceBeats.ts` :244-254 states the rule: nothing in the module, its default cue provider, or its lookup modules opens an HTTP connection or writes a byte to `data-local/`, "verified structurally by `sourceBeats.noFetch.test.ts` (module-source grep for fetch/http/download call sites)". The file does not exist (`git ls-tree origin/main backend/test | grep noFetch` is empty — issue #706 item 1).
- Verified imports of `sourceBeats.ts` at `origin/main`: `./audioSourceLookup` (type-only, :18), `./segmentPoolLookup` (:180), `./transcriptArchiveLookup` (:206), `./catalogueLookup` (:213). All four lookup modules `import * as fs from "fs"` at :1 (:2 for `transcriptArchiveLookup.ts`) for READS only; reading on-disk text is allowed by the rule, only network and WRITES are forbidden. No forbidden pattern below matches in any of the five files today, so the escalation clause is not expected to fire.
- Vitest conventions: `backend/test/parseWithRetry.test.ts` greps module source for drift (use the same `fs.readFileSync(path.join(__dirname, "../src/generation/…"), "utf8")` pattern).

**Exact change.** Create `backend/test/sourceBeats.noFetch.test.ts`:
1. `const FILES = ["sourceBeats.ts", "audioSourceLookup.ts", "catalogueLookup.ts", "segmentPoolLookup.ts", "transcriptArchiveLookup.ts"]` read from `backend/src/generation/`. The list is pinned here; do not derive it from imports.
2. `stripComments(src)`: remove `/* … */` blocks and `//` line comments (regexes `/\/\*[\s\S]*?\*\//g` and `/(^|[^:])\/\/.*$/gm`) so the rule's own prose cannot match.
3. For every file, assert the stripped source has NO match for each of: `/\bfetch\s*\(/`, `/from\s+["'](node:)?https?["']/`, `/from\s+["'](undici|axios|node-fetch)["']/`, `/require\(["'](node:)?(https?|child_process)["']\)/`, `/from\s+["'](node:)?child_process["']/`, `/\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|rmSync|renameSync|unlinkSync)\s*\(/`.
4. Additionally assert `sourceBeats.ts` has no `from "fs"` / `from "node:fs"` import at all (only the lookups read disk).
5. One test per regex family, each named `sourceBeats lane: no <family> — <files>`; plus one test `the pinned lane is five files and each exists` asserting `FILES.length === 5` and `fs.existsSync` for each, so a renamed module cannot silently empty the check.

**Tests / mutations.** Mutation A: temporarily add `const _x = fetch("http://x");` to `sourceBeats.ts` → the fetch test is red. Mutation B: add `import * as fs from "fs"` to `sourceBeats.ts` → the fs-import test is red. Mutation C: add `fs.writeFileSync("x","y")` to `transcriptArchiveLookup.ts` → the writes test is red. Revert all three before committing; name them in the PR.

**Commands.** `cd backend && npx vitest run test/sourceBeats.noFetch.test.ts` → pass. `cd backend && npm run typecheck` → pass.

**Do not touch.** Any `backend/src/**` file (the comment at :253 stays as-is; it now names a real test). No floors apply to `backend/test/`.

**Stop and escalate if:** a forbidden pattern already matches in one of the five files (then #706's claim is wrong in a worse way — report the line, do not "fix" the source); one of the five files is missing on your branch.

**Definition of done.** Commands green; DRAFT PR `GEN-03: the sourceBeats.noFetch test the module claims (#706 item 1)` listing the five files covered and the three mutations.

**Conventions.** Branch `t_GEN-03/nofetch-test`; DRAFT; trailers; one vitest process.

### GEN-04 · G-21b `tools/foray/digest.mjs` — qwen · S

**Executor:** qwen (allowed lane; the input shape and the output template are fixed here).

**Context.**
- `backend/src/cli/generateForays.ts` — `ReportEntry` (grep `interface ReportEntry`; fields `prompt, outcome, detail, ms, file?, ttlA1Ms?, calls?, veracity?, publish?{pr_url, branch, base}, resumes?[], abort?{reason, detail}, refusedAtAct?, notification?`); `report.json` is written as an object whose `entries` key is the `ReportEntry[]` (other top-level keys are batch totals — ignore them); the completion hook (:302-380): `--notify <command>` / `GENERATION_NOTIFY_CMD` runs a shell command once per prompt and at batch end with `summaryLine()` on stdin and in `FORAY_NOTIFY_SUMMARY`, AFTER `report.json` is rewritten. **The hook is `spawn(command, { shell: true, env, stdio })` with NO `cwd` (:357-368), so it inherits the driver's cwd, which is `backend/`** — a relative script path in the command is resolved from `backend/`.
- `backend/src/generation/veracityMetrics.ts` :819-870 `VeracityMetrics` fields: `groundedQuoteRate, purposeFidelity, tapeRelevance, unverifiedPages, seedLostBeats, firstAttemptPassRatePages, firstAttemptPassRateBeats, tapeOfTapePlusNarration` (numbers or `null`).
- Roadmap card G-21b: `docs/curation/foray-to-spec-roadmap.md` :883-892.
- Suite floors: `test/suite-integrity.test.js` `FLOORS` (the `tools/foray/*` entries sit around :1355-1440).

**Exact change.** Create `tools/foray/digest.mjs` (ESM, Node ≥ 22, no deps) exporting:
1. `renderEntry(entry)` → a Markdown string:
   ```
   ### <outcome> — <basename of entry.file without extension, or "(no candidate)">
   - prompt: "<entry.prompt, first 100 chars, then …>"
   - outcome: <entry.outcome>[ (<entry.abort.reason>: <abort.detail first 120 chars>)] · wall <entry.ms/60000 to 1 dp> min · calls <entry.calls ?? "—">[ · resumes <n>]
   - veracity: grounded <r> · purpose <r> · tape <r> · unverified <n> · seedLost <n> · 1st-pass pages <r>
   - PR: <entry.publish.pr_url or "—">
   - human touch: <"none" | "review: <reason>">
   ```
   where each `<r>` prints 3 decimals or `—` for `null`/absent; `human touch` is `review: no PR` when `publish` is absent and `outcome === "generated"`, `review: <abort.reason>` when `abort` exists, `review: unverified pages` when `veracity.unverifiedPages > 0`, else `none` (evaluated in that order).
2. `renderDigest(reportJson)` → header `## Generated Forays — <n> entr(y|ies), <ISO date now>` + one `renderEntry` per `reportJson.entries` in order; throws `Error("report.json has no entries array")` otherwise.
3. CLI: `node tools/foray/digest.mjs --report <path> [--issue <n>] [--repo <owner/name>] [--dry-run]`. Without `--issue`: print the digest to stdout. With `--issue`: write the digest to a temp file and run `gh issue comment <n> --body-file <tmp>` (plus `--repo <r>` when given) via `execFileSync("gh", args, { stdio: "inherit" })`; `--dry-run` prints the `gh` argv instead of running it. Exit 2 with a one-line reason on a missing/invalid report. Export `main(argv, deps = { run: execFileSync, out: console.log })` so tests inject `run`.
4. Header comment: the digest is G-21b's "founders get a digest, not a gate"; it is wired on the driver as `--notify "node ../tools/foray/digest.mjs --report <out>/report.json --issue <N>"` — **the `../` is required because the driver's `--notify` hook runs with `backend/` as its cwd** (`generateForays.ts` :357-368: `shell: true`, no `cwd`); an absolute path to `digest.mjs` also works. `<N>` is the standing "generated Forays" tracking issue the overlord creates (GEN-26).

**Tests to add:** `tools/foray/digest.test.mjs` (node:test; floor 6 in `test/suite-integrity.test.js`):
- `renders one comment per entry from a report with two entries` — fixture object built inline: one `generated` entry with veracity + publish, one `aborted` entry with `abort`; assert the two headings and the PR url. Mutation: drop the loop's second iteration → red.
- `prints — for a null or absent metric, never 0` — `groundedQuoteRate: null` → `grounded —`. Mutation: `?? 0` → red.
- `names the human touch: no PR, abort reason, unverified pages, none` — four entries, four strings. Mutation: swap the abort/unverified order → red.
- `refuses a report without entries` — `assert.throws`. Mutation: default to `[]` → red.
- `--issue posts through gh with --body-file and honours --repo` — `main(["--report", fixturePath, "--issue", "42", "--repo", "a/b"], { run: spy })` → spy called once with `["issue","comment","42","--body-file",<path>,"--repo","a/b"]`. Mutation: drop `--repo` → red.
- `--dry-run never calls gh` — spy not called; stdout has the argv. Mutation: call anyway → red.
Use a report fixture written to `os.tmpdir()` in the test (never `data/`).

**Commands.** `node --test tools/foray/digest.test.mjs` → 6 pass. `node --test test/suite-integrity.test.js` → pass. `node tools/foray/digest.mjs --report tools/generation-bench/fixtures/out-9/report.json --dry-run --issue 1` → prints a digest and the `gh` argv (this fixture is a real run-9 report; confirm it has `entries`).

**Do not touch.** `backend/**`, `HUMAN-ACTIONS.md` (the overlord adds the D4 line when needed), any workflow.

**Stop and escalate if:** `report.json` on the fixture is not `{ entries: [...] }` (then the writer's shape differs — report it); `gh` is required for any test (it must not be); the `--notify` spawn in `generateForays.ts` on your branch has gained a `cwd` option (then the `../` in the header example is wrong — report which cwd it uses and adjust the example to match; do not edit `generateForays.ts`).

**Definition of done.** Commands green; DRAFT PR `GEN-04: tools/foray/digest.mjs — one issue comment per generated candidate (G-21b)`; PR body pastes the fixture digest output and states the `node ../tools/foray/digest.mjs` wiring with the reason (hook cwd = `backend/`).

**Conventions.** Branch `t_GEN-04/digest`; new suite → floor in the same PR; DRAFT; trailers.

### GEN-05 · G-42b(prep) bench `--compare`: a trend-with-band verdict — qwen · S

**Executor:** qwen (allowed lane; arithmetic only; grades against the trend, never against a D0 target).

**Context.**
- `tools/generation-bench/run.mjs` — `COLUMNS` :121-300 (`{ key, header, from, width, kind: "text"|"number", digits }`), `parseArgs(argv)` :692-708 (**throws `unknown flag` for any `--x` not in its list, :701**; `--format both|table|jsonl`, `--candidates`, `--segments`, `--run-id`, `--append`; requires ≥1 positional target), `collectRows` :710-723, `main(argv, out)` :725-737 (**returns `rows`; existing tests call it in-process**), the CLI wrapper :739-747 (`try { main(...) } catch { process.exit(2) }` — the only `process.exit` in the file); header comment :60-90 for the row model; `tools/generation-bench/baseline.jsonl` rows: `{"run","generated_at","outcome","valid","metrics":{<key>: number|null},"sources":{…}}` — **the `run-9` row has `metrics.unverified: 8`**, `run-8` has `4`; `docs/curation/generation-kpis.md` :30-70 "Targets" table (the direction each column improves in).
- `tools/generation-bench/run.test.mjs` (floor 40, `test/suite-integrity.test.js` :1429) — see how it builds rows from `fixtures/out-9/` and how it calls `main` with a collecting `out`.

**Exact change.**
1. Add `direction` to each numeric `COLUMNS` entry: `"down"` for `wall_min, ttl_a1_min, calls, pages_per_seam, narration_share, unverified, seed_lost, intro_restates, calls_per_beat, tokens, cost_usd`; `"up"` for `tape_share, tape_of_runtime, first_pass_pages, first_pass_beats`; omit (no verdict) for `clips, clip_mean_s, clip_max_s, synth_verified, first_pass`. Export `DIRECTIONS` (a `Map<key, "up"|"down">` derived from `COLUMNS`) for the test.
2. `parseArgs` learns four flags, added to its `if/else` chain so they no longer hit `unknown flag`: `--compare <file>` (`args.compare`, default `null`), `--band <fraction>` (`args.band`, default `0.15`, parsed with `Number`, must be finite and > 0), `--window <n>` (`args.window`, default `3`, integer ≥ 2), `--strict` (`args.strict`, boolean). When `args.compare` is set and `args.targets.length !== 1`, throw `Error("--compare grades exactly one run; pass one report or dir")`. Without `--compare`, nothing else in `parseArgs` changes.
3. `compareRow(newRow, baselineRows, { band, window })` (exported, pure): for each column with a `direction`, take the last `window` baseline rows whose `metrics[key]` is a finite number, compute their median (`verdict: null` when fewer than 2 such rows or the new value is not a finite number); `delta = (value - median) / max(|median|, 1e-9)`; verdict `"regressed"` when `direction === "down" && delta > band` or `direction === "up" && delta < -band`; `"improved"` for the mirror case past the band; else `"within"`. Returns `{ columns: [{ key, header, median, n, value, delta, verdict }], regressed: [keys] }`.
4. `main(argv, out)` in compare mode: read `baseline.jsonl` (skip blank lines; rows whose `run` is `"derived"` or whose `metrics` is missing are ignored), build the one target row through the existing `collectRows`, call `compareRow`, print (`--format table` or `both`): one line per column `header | median(n=k) | new | delta% | verdict`, then `regressed: none` or the comma-joined keys; `--format jsonl` (or `both`) prints `JSON.stringify(compare)`. **`main` returns `{ rows, compare, exitCode }` where `exitCode = args.strict && compare.regressed.length > 0 ? 1 : 0`; it never calls `process.exit`.** Without `--compare`, `main` still returns `rows` exactly as today so the existing 40 tests keep passing.
5. CLI wrapper (:739-747): `const result = main(process.argv.slice(2)); if (result && !Array.isArray(result)) process.exitCode = result.exitCode;` — the `catch → process.exit(2)` stays.
6. Nothing in compare mode reads the D0 targets. Header comment: this is G-42b's comparison half; the schedule and the gate past D0 are GEN-27.

**Tests to add** (`tools/generation-bench/run.test.mjs`; raise floor 40 → 46):
- `every numeric column with a verdict declares a direction, and the text columns declare none` — mutation: drop `direction` on `unverified` → red.
- `compareRow uses the median of the last WINDOW finite values, ignoring nulls` — baseline of 5 rows with two nulls, `window: 3`; assert the median and `n`. Mutation: use mean → red.
- `a down-column past the band is regressed; within the band is within; an up-column falling is regressed` — three assertions. Mutation: flip the sign for `"up"` → red.
- `fewer than two comparable rows yields a null verdict, never regressed` — mutation: treat one row as a median → red.
- `--compare returns exitCode 0 and prints a verdict table for the run-9 fixture against baseline.jsonl` — `const r = main(["--compare","tools/generation-bench/baseline.jsonl","--format","table","tools/generation-bench/fixtures/out-9"], collect)`; assert `r.exitCode === 0`, the collected output contains a `| verdict` header line and a `regressed:` line, and `r.compare.columns.length === DIRECTIONS.size`. Mutation: return `exitCode: 1` without `--strict` → red.
- `--strict returns exitCode 1 only when something regressed` — write a synthetic baseline to `os.tmpdir()` with three rows whose `metrics.unverified` is `2` (run-9's `unverified` is `8`; `delta = (8 − 2)/2 = 3.0 > 0.15` → regressed); `main([... "--strict" ...])` → `exitCode === 1` and `compare.regressed` includes `"unverified"`; the same call without `--strict` → `exitCode === 0`. Mutation: ignore `--strict` → red.

**Commands.** `node --test tools/generation-bench/run.test.mjs` → 46 pass; `node --test test/suite-integrity.test.js` → pass; `node tools/generation-bench/run.mjs --compare tools/generation-bench/baseline.jsonl --format table tools/generation-bench/fixtures/out-9; echo $LASTEXITCODE` (PowerShell) → table, `0`.

**Do not touch.** `docs/curation/generation-kpis.md` rows, `baseline.jsonl` content, any target value, the `--append` splice.

**Stop and escalate if:** `COLUMNS` on your branch lacks a key named above (report the mismatch); the fixture run-9 row cannot be built by the existing code path; an existing test asserts `main`'s return shape in a way that conflicts with step 4 (report; do not change that test).

**Definition of done.** Commands green; DRAFT PR `GEN-05: generation-bench --compare (trend with a band, G-42b prep)` with the fixture table pasted and the exit-code contract (`exitCode` returned, set on `process.exitCode` by the wrapper) stated.

**Conventions.** Branch `t_GEN-05/bench-compare`; floor raised in the same PR; DRAFT; trailers.

### GEN-06 · F-37: write the connective-page sources ruling into `narration-craft.md` — qwen · XS

**Executor:** qwen (docs lane; the ruling is already decided in code and is transcribed, not invented; the placement is decided here).

**Context.**
- `docs/curation/generation-findings-tracker.md` :59, row F-37: status `fixed`, last column reads: `The **ruling is not written down**: \`narration-craft.md\` still says nothing about a source-free connective page. Tracked on **WS-K**.`
- `backend/src/types/narration.ts` — `hasDeclarativeSentence(script)` :655; `validateNarratedBeat` :714; the rule at :764: `if (supportingSources === 0 && hasDeclarativeSentence(beat.script)) { … }` (read :755-775 for the exact error text).
- `docs/curation/narration-craft.md` (2006 lines) — `### 3h. Silence, loudness and the bridged seam` :649 contains "or a short declarative." at :661 (a seam-opening rule, NOT where a sources ruling belongs); `## 10. Sources` :1982 is the section on sources and runs to the end of the file.

**Exact change.**
1. In `docs/curation/narration-craft.md`, append as the **last block of `## 10. Sources`** (i.e. at the end of the file, after its final paragraph, separated by one blank line), heading level `###`:
   > ### Sources on a connective page (F-37 ruling, in code since PR #545)
   >
   > A Frame, Hinge or Marker may carry `sources: []` only when its script has no declarative sentence: a question, a tease or a hand-off needs no source; any sentence that states a fact does. This is decided structurally by `validateNarratedBeat` (`backend/src/types/narration.ts`, `hasDeclarativeSentence`), so the verifier never sees the case. The writer prompt's "every factual claim carries a source" and this rule are the same rule. The seam-opening guidance in §3h ("or a short declarative") is about how a Hinge opens, not about whether it carries a source.
2. Do NOT insert anything in §3h.
3. In `docs/curation/generation-findings-tracker.md` :59, replace the last cell of the F-37 row with exactly: `Ruling written into \`narration-craft.md\` §10 (GEN-06). Was tracked on **WS-K**.` Leave every other cell unchanged.

**Tests.** None (docs). Run `node --test test/suite-integrity.test.js` to prove nothing scanned changed.

**Commands.** `git diff --stat` shows exactly two files: `docs/curation/narration-craft.md` and `docs/curation/generation-findings-tracker.md`. `git diff --check` clean (no trailing whitespace, line endings unchanged).

**Do not touch.** `docs/DECISIONS.md`, `docs/adr/`, any prompt file under `backend/src/`, any other tracker row.

**Stop and escalate if:** `narration.ts:764` does not read as described (the ruling in code differs — report, do not paraphrase a rule you cannot see); `## 10. Sources` is no longer the last `##` section of the doc (then append at its end anyway and say where that is).

**Definition of done.** DRAFT PR `GEN-06: narration-craft records the F-37 connective-page sources ruling` with the two-file diff.

**Conventions.** Branch `t_GEN-06/f37-ruling`; DRAFT; trailers.

### GEN-07 · G-30(c) + F-20 driver hygiene — opus · XS

**Executor:** opus — `backend/src/cli/` is DENIED.

**Context.** `backend/src/cli/generateForays.ts` `parseArgs` :125-153 (`duration` default `"short"` at :143), usage comment :73-76; `backend/test/generateForaysArgs.test.ts` :37-45 ("leaves every other flag alone" pins `duration: "medium"` only when given); `docs/curation/generation-run-2026-09-09.md` I-08 (medium ≈ an hour); roadmap G-30 (c) :775. F-20: the driver prints `§` (e.g. "§4.5") and a Windows console in cp1252 double-encodes it (tracker F-20; grep `§` in `generateForays.ts` and `runPipeline.ts` log strings).

**Exact change.** (1) `:143` default becomes `"medium"`; usage comment says so. (2) At the top of `main()` in `generateForays.ts`: `if (process.stdout.isTTY && process.platform === "win32") { process.stdout.setDefaultEncoding("utf8"); process.stderr.setDefaultEncoding("utf8"); }` and replace the literal `§` in every driver/pipeline **console** string (not in comments, not in `report.json` fields) with `section ` — grep `console.(log|warn|error)\(.*§` under `backend/src/generation` and `backend/src/cli`. (3) README/usage text updated. GEN-14 edits the same file afterwards (the `ReportEntry` type and one write site); keep this PR's diff to `parseArgs`, `main()`'s first lines, the usage comment and the console strings.

**Tests.** `generateForaysArgs.test.ts`: `"duration defaults to medium (G-30 c)"` — `parseArgs([...no --duration])` → `medium`; mutation: default `"short"` → red. `"no console string in the generation lane carries the section sign (F-20)"` — grep test over `backend/src/cli/generateForays.ts` and `backend/src/generation/*.ts` for `/console\.(log|warn|error)\([^)]*§/`; mutation: reintroduce one → red.

**Commands.** `cd backend && npx vitest run test/generateForaysArgs.test.ts` → pass; `cd backend && npm run typecheck`; `cd backend && npx vitest run` (whole suite once, since the default changed).

**Do not touch.** `tools/generation/start-run.mjs` (GEN-01), any prompt text, `ReportEntry` (GEN-14).

**Stop and escalate if:** a hands-free test fixture depends on `short` by default and would need its expectations changed for a reason other than the default (report which).

**DoD.** Green; DRAFT PR `GEN-07: driver defaults to medium; UTF-8 console (G-30 c, F-20)`; tracker F-20 row → fixed.

**Conventions.** Branch `t_GEN-07/driver-hygiene`; DRAFT; trailers; merges under the overlord's standing approval (DENIED path).

### GEN-08 · #706(2) minted clips over 240 s carry `long_reason` — opus · S

**Executor:** opus — DENIED path; and the reason text is a data-shape decision.

**Context.** `tools/foray/check-forays.mjs` :108-109 (`ROLE_MAX_SEC`, `L4_SOFT_MAX_SEC = 240`), the L4 loop :1413-1442 (runs on every played segment since 2026-09-15; refuses `duration > 240` unless `needs_review === true` AND a non-empty `long_reason` on the segment row or the Foray item); tests :1526-1565. `backend/src/generation/finalizeForay.ts` `mintedSegmentRow` :197-240 writes `needs_review: true`, `boundary`, `extended_by_sec`, `why` — never `long_reason`. `backend/src/generation/sourceBeats.ts` :996-1012 says a Q-01 clip may run to 1,800 s. Measured on `origin/main` `data/segments.json`: 43 `needs_review` rows, none over 240 s — so the gap has not fired yet, and the first Q-01 long clip will refuse at finalize. `docs/curation/segment-length-rules.md` :572-573, :941, :972 (`long_reason` required over 240 s). `tools/foray/fixture-coverage.test.mjs` :209-223 (`KNOWN_UNCOVERED`, `KNOWN_UNCOVERED_CEILING = 13`). `backend/test/mintedSegmentRow.test.ts`.

**Exact change.** (1) Add `export const L4_SOFT_MAX_SEC_MIRROR = 240` next to the other mirrored constants in `finalizeForay.ts` (or wherever the M4 mirrors live — follow `sourceBeats.ts`'s "constants mirrored from check-forays" pattern) with a subprocess/import test pinning it equal to `check-forays.mjs`'s export. (2) In `mintedSegmentRow`, when `segment.endSec - segment.startSec > 240`, write `long_reason: \`Q-01 cut: relevance to the claim carried the clip ${segment.extendedBySec ?? 0} s past its window to a ${segment.boundary ?? "claim-only"} boundary — ${segment.why}\`` (non-empty by construction; `why` already passed `mintedWhyErrors`). (3) Replace the L4 message tail in `check-forays.mjs` ("Neither field is in the segment schema yet … set both on the Foray item until it is.") with "A generated row carries both from `mintedSegmentRow`; a curated row sets them at merge." — update any test asserting the old text. (4) Run `fixture-coverage.test.mjs`; if it names `segment.long_reason` as an accepted-but-uncovered shape, add a dated `KNOWN_UNCOVERED` entry and bump the ceiling by one (the file's own rule at :223) — do not fabricate a data row.

**Tests.** `mintedSegmentRow.test.ts`: `"a cut over 240 s carries a non-empty long_reason built from its boundary and why"` (300 s → present, contains the `why`); `"a cut at or under 240 s carries none"`; mutation: drop the field → first red; `>=` instead of `>` → second red. `check-forays.test.mjs`: existing L4 tests stay green; the message test updated. Pin test for the mirror constant (mutation: 241 → red).

**Commands.** `cd backend && npx vitest run test/mintedSegmentRow.test.ts test/finalizeForay.test.ts`; `node --test tools/foray/check-forays.test.mjs`; `node --test tools/foray/fixture-coverage.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch.** `data/segments.json`, `tools/segments/merge-segments.mjs` (curated path), `ROLE_MAX_SEC` values (decision recorded: L2/L3 stay curated-only because generation writes no `role`; L4 is the generated clip's ceiling-with-a-reason).

**Stop and escalate if:** any generated row on `main` would now fail `merge-segments.mjs --check` for carrying an unknown field (run it in `--check` against the frozen fixture first).

**DoD.** All four commands green; DRAFT PR `GEN-08: minted clips over 240 s carry long_reason (L4 hatch, #706 item 2)`.

**Conventions.** Branch `t_GEN-08/long-reason`; tests naming a Foray use `tools/foray/fixtures/frozen/`; DRAFT; trailers.

### GEN-09 · #706(3–9) delete the seven un-deleted predecessors — opus · S

**Executor:** opus — DENIED path; cross-cutting deletion under the roadmap's F-100 rule (:1287-1302: a superseding card deletes the path in the same PR, bumps the checkpoint version rather than shimming, and counts ported/deleted tests in the PR body).

**Context (all `origin/main`).** `backend/src/generation/sourceBeats.ts`: `MIN_TAPE_SEGMENT_SEC` import :193; `lengthGate` producer :477, type/comment :687-702, `:1628, :1718, :1795, :1986, :2064`; `placementMakesUniformPair(…, replacing?)` :986 (no caller passes `replacing`; documented merge reading :1081, :1099, :1965); legacy gate spellings `d5-pair`/`d3-mean`/`d5-triple` :788, :902-904, :1163, :2143-2148 (`TIER2_GATE_PROGRESS`), :2361-2365 (`narrationReasonFor`), :2388-2392 (`ASSEMBLY_REFUSAL_CLAUSE`), :2416 (`transcriptionQueueRow`), plus two enums in `runPipeline.ts` (grep `d5-pair`); `cutExtent(…, maxSec)` :2069 with its only call :2058 passing `undefined`; stale doc promises of an F-102-deleted re-extension and the F-80 triple clause :1561-1562. `tapeExtent.ts`: `minSec` :185, `relevanceFloor` :189/:225, `extentText` :468 (zero importers). `smoothSeam.ts`: `smoothActs` :109, header :99 "NO PRODUCTION CALLER SINCE F-66"; `backend/test/smoothSeam.test.ts`. `backend/src/generation/checkpoint.ts` :173 (version gate; version 2 post-dates Q-04). `backend/src/types/tapeSourcing.ts` (the checkpointed schema; grep `lengthGate`). `backend/test/fixtures/*.json` (grep `lengthGate`, `d5-pair`).

**Exact change.** One PR, seven numbered commits: (1) delete `lengthGate` everywhere and `placementMakesUniformPair`; (2) delete the legacy spellings from every union/record/enum and their `case` arms; (3) remove `cutExtent`'s `maxSec` parameter and its dead guards; rewrite its comment to describe the current growth rule; (4) rewrite the three stale doc promises to what exists; (5) delete `extentText`, the `relevanceFloor` and `minSec` options (callers use the module constants) and the unused import; (6) delete `smoothActs` and its tests, keep the F-66 split-out function `stitchForay.ts` uses; (7) if the checkpoint zod schema is strict and lost a field, bump `CHECKPOINT_VERSION` and delete the compatibility comment. Port every test of a RULE onto the surviving path; delete tests of the deleted FLOW; PR body lists counts.

**Tests.** No new suite; the killed mutations are the deletions themselves: after each commit `npx vitest run` in `backend/` is green and `npm run typecheck` is green. Add one grep test to `backend/test/sourceBeats.test.ts`: `"no legacy gate spelling survives in the tape lane (#706)"` asserting `sourceBeats.ts`, `runPipeline.ts`, `tapeSourcing.ts` contain none of `d5-pair`, `d3-mean`, `lengthGate`, `extentText`, `smoothActs`; mutation: reintroduce one string → red.

**Commands.** `cd backend && npm run typecheck`; `cd backend && npx vitest run`; `node --test tools/foray/check-forays.test.mjs` (the TS↔mjs mirror pin); `cd backend && npx vitest run test/sourceBeats.noFetch.test.ts` (GEN-03's lane test must stay green after the deletions).

**Do not touch.** Any constant value (M4/D5/L4), `check-forays.mjs` rules, any prompt.

**Stop and escalate if:** a deletion changes a `check-forays` verdict on the frozen fixture; a fixture checkpoint cannot be regenerated deterministically.

**DoD.** Green; DRAFT PR `GEN-09: tape lane — seven predecessors deleted (#706 items 3–9)` with the ported/deleted counts and the checkpoint-version note.

**Conventions.** Branch `t_GEN-09/tape-lane-deletions` off `origin/main` after GEN-03 merges; DRAFT; trailers.

### GEN-10 · #712(3) the disclosure line lowercases a leading function word — opus · XS

**Executor:** opus — DENIED path (`backend/src/types/`).

**Context.** `backend/src/types/narration.ts` `PRELUDE_BOILERPLATE` :933, `disclosureTemplate(subject)` :937-941 (interpolates the subject raw → live data `data/forays.json` `what-engineers-actually-do-all-day-e08236` item `disclosure` reads "This is a Foray about The real, non-linear arc…"). `tools/foray/check-forays.mjs` `DISCLOSURE_RX` (grep) must keep matching. The comment at :928-931 cites `backend/test/disclosureTemplate.test.ts`, which does NOT exist on `origin/main` — create it. Round-2 ruling 9 (DECISIONS 2026-09-24): existing Forays are accepted as-is; do not edit `data/`.

**Exact change.** In `disclosureTemplate`: `const words = trimmedSubject.split(/\s+/); const first = words[0]; if (LEADING_FUNCTION_WORDS.has(first)) words[0] = first[0].toLowerCase() + first.slice(1);` with `LEADING_FUNCTION_WORDS = new Set(["How","Why","What","When","Where","Who","Which","The","A","An"])` (exact-case match only, so "NASA", "Apple" are untouched; "The Beatles" becomes "the Beatles", which is correct mid-sentence). Join with single spaces.

**Tests.** New `backend/test/disclosureTemplate.test.ts`: `"a subject that starts with a sentence-opener is lowercased mid-sentence (#712)"` ("How medicine accepted…" → "…about how medicine accepted…"); `"a proper-noun subject is untouched"` ("NASA's shuttle program" unchanged); `"the boilerplate still matches check-forays' DISCLOSURE_RX"` (import the mjs; round trip). Mutations: drop the lowercase → first red; add "NASA" to the set → second red; change a boilerplate word → third red.

**Commands.** `cd backend && npx vitest run test/disclosureTemplate.test.ts`; `cd backend && npm run typecheck`; `node --test tools/foray/check-forays.test.mjs`.

**Do not touch.** `data/forays.json`, the Q-07 prelude sentences.

**Stop and escalate if:** `DISCLOSURE_RX` anchors the subject's case (then the checker needs a matching change in the same PR — allowed lane, say so).

**DoD.** Green; DRAFT PR `GEN-10: disclosure line lowercases a leading function word (#712 item 3)`.

**Conventions.** Branch `t_GEN-10/disclosure-case`; DRAFT; trailers.

### GEN-11 · #712(1) a quote grounded in any of the seam's held docs is grounded — opus · S

**Executor:** opus — DENIED path; changes what the veracity gate reads.

**Context.** `backend/src/generation/writeAct.ts` `evidenceCarriedBy(seam, page)` :1225-1235: a page's `evidence` is the subset of `seam.gate.evidence.docs` whose `title === source.publication` or `url === source.url` (plus adjacent tape windows). Two retrievals of the same article can be two docs with the same title and different passages; `find` returns the first, so a quote verbatim in the second is dropped from the page's evidence and `computeGroundedQuoteRate` (`veracityMetrics.ts` :97-160, `normalizeQuote` :74 private) then refuses at publish — #712's first false refusal. The writer prompt promises "THE ACT'S SOURCES ARE ONE SET" (`AnthropicNarrationWriterBuilder.ts` :255).

**Exact change.** (1) Export `normalizeQuote` from `veracityMetrics.ts`. (2) In `evidenceCarriedBy`, for each non-tape source with a non-empty `quote`, ALSO add every doc `d` in `seam.gate.evidence.docs` where `normalizeQuote(d.text).includes(normalizeQuote(source.quote))`; keep the title/url match. (3) Log one `console.warn` when a quote matched by text only (`writeAct: quote for "<publication>" found in a same-set doc with a different title/url (#712)`), so the writer's attribution drift stays visible. (4) No change to the gate thresholds.

**Tests.** In the writeAct-level suite (`backend/test/actNarration.test.ts` or `hingeTapeSource.test.ts`, whichever builds seams): `"a quote verbatim in a held doc whose title differs from the cited publication is carried and grounded (#712)"` — two docs, same title "When filth became dangerous", quote only in the second; after `evidenceCarriedBy` the page's `evidence` includes doc 2 and `computeGroundedQuoteRate` returns 1. Mutation: remove the text match → rate 0.5 → red. `"a quote in no held doc is still ungrounded"` — mutation: match on any doc → red.

**Commands.** `cd backend && npx vitest run test/actNarration.test.ts test/veracityMetrics.test.ts test/hingeTapeSource.test.ts`; `npm run typecheck`.

**Do not touch.** `evaluateVeracityGate`, `GATE_MIN_*`, prompts.

**Stop and escalate if:** `page.evidence` is consumed by `publishForay`'s PR body or the app in a way that assumes ≤ 3 docs (grep `evidence` in `publishForay.ts` and `forayItems.ts` first).

**DoD.** Green; DRAFT PR `GEN-11: a quote grounded in any held doc of the seam is grounded (#712 item 1)`.

**Conventions.** Branch `t_GEN-11/grounded-any-held-doc`; DRAFT; trailers.

### GEN-12 · #712(2) a seed-lost-only seam is verified — opus · S · needs Q3

**Executor:** opus — DENIED path; publish-gate policy (founder question 3, default yes).

**Context.** `writeAct.ts` `finalPageFor` :1143-1185: `settled = uncarried.length === 0 && seedLost.length === 0` (:1153); a confirmed seam whose only gap is a seed-lost beat is returned `verified: false, unverifiedReason: "seed-lost"` (:1166-1172); `seedLostClosed` :1008-1013; `veracityMetrics.ts` `computeUnverifiedPages` :589-613 counts the `"seed-lost"` reason as a stop; `evaluateVeracityGate` :1053-1056 refuses `unverifiedPages > 0`; `seedLostBeats` :850-854/:954 is already a separate count; `types/narration.ts` :355-365 documents the `"seed-lost"` reason. Issue #712 measured that the beat's claim text is absent from the audio.

**Exact change (if Q3 = yes, the default).** (1) `settled = uncarried.length === 0`; when `seedLost.length > 0` the page gets `verified: true`, `purposeAccomplished: true`, `seedLostBeatIds: string[]` (new optional field on `NarratedBeat`), and `verifierNotes` keeps the F-99 note. (2) Delete the `"seed-lost"` branch from `computeUnverifiedPages` and the union member from `unverifiedReason` (F-100 rule: no unreachable reason). (3) `seedLostBeats` in `VeracityMetrics` unchanged; add `seedLostPages` (pages carrying ≥1 seed-lost beat) beside it, reported and not gated. (4) `docs/curation/narration-architecture.md`/tracker F-99 row: one sentence each.

**Tests.** `veracityMetrics.test.ts`: `"a confirmed seam with a seed-lost beat is verified and counted under seedLostPages, not unverifiedPages (#712)"` — mutation: keep `seedLost.length === 0` in `settled` → red. `"an uncarried beat still makes the seam unverified"` — mutation: drop `uncarried` from `settled` → red. `"no page carries unverifiedReason 'seed-lost' any more"` — type-level: grep test on `narration.ts` for `"seed-lost"` in the union → red if reintroduced.

**Commands.** `cd backend && npx vitest run test/veracityMetrics.test.ts test/actNarration.test.ts`; `npm run typecheck`; `npx vitest run` once.

**Do not touch.** The F-51 gate on genuinely unverified pages; `GATE_MIN_*`.

**Stop and escalate if:** Wyatt answers Q3 "no" — then the change is limited to the gate MESSAGE ("kept unverified and dropped" vs "shipped") and the PR is retitled.

**DoD.** Green; DRAFT PR `GEN-12: a seed-lost-only seam is verified; seedLostPages reported (#712 item 2)` quoting the founder's ruling.

**Conventions.** Branch `t_GEN-12/seed-lost-verified` after GEN-11 merges (same file); DRAFT; trailers.

### GEN-13 · #710(a) the second evidence query is composed, not cut — opus · S

**Executor:** opus — retrieval/prompt design.

**Context.** `backend/src/generation/gatherEvidence.ts` `RETRY_QUERY_MAX_WORDS = 14`, `RETRY_QUERY_MIN_WORDS = 4` :199-200; `retryQueryFor(claim)` :262-291 (a PREFIX of the claim cut at a clause boundary — produces "The uncomfortable question is not"); `printEvidenceFor` :533-575 fires both queries concurrently (G-35) and caches by `claimHash`; `leadingNounPhrase` in `types/spine.ts`; tests `backend/test/gatherEvidence.test.ts` :295-315 (`asks a SECOND, differently-worded query…`, `two queries per page, never three`). Issue #710's three non-propositions.

**Exact change.** Replace the body of `retryQueryFor` with a COMPOSED query, deterministic and model-free: `leadingNounPhrase(sentence)` + the predicate's content words (drop stop-words, keep sentence order) up to the 14-word cap, then trim any trailing word in `TRAILING_FORBIDDEN` (determiners, prepositions, conjunctions, auxiliaries, negations, bare numerals) repeatedly; return `""` when fewer than 3 words remain or `searchKey(query) === searchKey(claim)`. Document the rule in the function comment and keep the "never a third query" contract. Keep `RETRY_QUERY_*` names.

**Tests.** `gatherEvidence.test.ts`: `"the composed query never ends on a function word or a bare numeral (#710)"` over #710's three claims (assert the last word is not in `TRAILING_FORBIDDEN` and the query contains the subject NP); `"the composed query keeps the subject and at least two predicate content words"`; existing :295-315 tests keep passing (update the expected string only through `retryQueryFor` itself). Mutations: skip the trailing trim → first red; drop the NP → second red.

**Commands.** `cd backend && npx vitest run test/gatherEvidence.test.ts`; `npm run typecheck`.

**Do not touch.** `printEvidenceFor`'s concurrency, the cache keys, `AnthropicExternalResearcher.ts`.

**Stop and escalate if:** the composed query for the run-9 fixture claims is identical to the claim in > 50 % of cases (the second call would be wasted — report the ratio).

**DoD.** Green; DRAFT PR `GEN-13: the second evidence query is composed from the subject and predicate (#710)`; PR body shows the before/after for #710's three claims.

**Conventions.** Branch `t_GEN-13/composed-retry-query`; DRAFT; trailers.

### GEN-14 · #709(1) the duration tier answers to the offered windows — opus · S · needs Q2 · after GEN-07

**Executor:** opus — product judgement (founder Q2, default: downgrade and say so).

**Context.** `backend/src/generation/runPipeline.ts` spine stage :1136-1170 (`postSeedWithFloor` re-asks once below `SPINE_SEED_FLOOR`); `postSeedSpine.ts` `SPINE_SEED_FLOOR = 0.5` :74, `offeredWindows(researchShape)` :122; `types/spine.ts` `DURATION_SHAPE_BUDGETS` :28-32 (`short` 8–10 items, `medium` 28–36, `long` 80–110), `SHAPE_TOLERANCE` :39; `researchShape.ts` `RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC = 6` :137; `deepenActs.ts` caps `argument` beats (grep the constant); `generateForays.ts` `ReportEntry` (grep `interface ReportEntry`; the `duration` field is at :98 of the request type). Issue #709: 24 offered windows, ~10 usable, a medium tier forced 14–18 seeds. **GEN-07 edits the same `generateForays.ts` (default and console strings) and must be merged first; this task's edits to that file are confined to the `ReportEntry` type block and the single per-entry write site.**

**Exact change.** (1) New `backend/src/generation/tierDecision.ts`: `decideTier(requested, offeredWindowCount)` → `{ requested, used, offeredWindows, neededSeeds: Record<tier, number> }` where `neededSeeds(tier) = ceil(SPINE_SEED_FLOOR × items[0] × (1 − MAX_ARGUMENT_SHARE))` with `MAX_ARGUMENT_SHARE` derived from `deepenActs.ts`'s cap (import it; never a new literal); `used` = the largest tier ≤ requested whose `neededSeeds ≤ offeredWindows`, else `short`. (2) In `runPipeline.ts`, call it after research-shape and before the spine stage; pass `decision.used` to `buildSpineWithReasks`/`postSeedWithFloor` instead of `req.duration`; log `  tier: requested medium, using short — 10 windows offered, 12 seeds needed for medium (#709)` when they differ; bank it in the checkpoint's spine stage input so a resume is stable. (3) `ReportEntry.tierDecision` written on every outcome that reached the spine (type block + one write site in `generateForays.ts`, nothing else in that file). (4) `check-forays.mjs`'s duration band, if any, is judged on `used`.

**Tests.** New `backend/test/tierDecision.test.ts`: the #709 numbers (24 offered, medium → medium if `neededSeeds(medium) ≤ 24`, else short — pin whichever the derived constant gives, and state it); `10 offered, medium → short`; `long → medium → short` walk; `0 offered → short` (the no-supply stop already handles zero upstream). Mutation: `used = requested` → red. `runPipeline.test.ts`: `"the report carries tierDecision and the spine is asked for the used tier"` with a stub research shape of 10 windows — mutation: pass `req.duration` → red.

**Commands.** `cd backend && npx vitest run test/tierDecision.test.ts test/runPipeline.test.ts test/postSeedSpine.test.ts`; `npm run typecheck`; `cd backend && npx vitest run test/generateForaysArgs.test.ts` (GEN-07's `medium` default must still hold).

**Do not touch.** `SPINE_SEED_FLOOR`'s value; `DURATION_SHAPE_BUDGETS`; `parseArgs`, the usage comment and console strings in `generateForays.ts` (GEN-07).

**Stop and escalate if:** Wyatt answers Q2 "stop instead" — then `used === requested` always and a `tier-short` outcome stops the run before the spine with the same report field; GEN-07 is not yet on `main` when you start (wait; do not branch from GEN-07's branch).

**DoD.** Green; DRAFT PR `GEN-14: the duration tier answers to the offered windows (#709)`, quoting Q2's ruling.

**Conventions.** Branch `t_GEN-14/tier-decision` off `origin/main` after GEN-07 merges; DRAFT; trailers.

### GEN-15 · #709(2)+(3) per-window subject relevance, measured — opus · S · after GEN-09 and GEN-18

**Executor:** opus — DENIED path; metric design (measure first, no gate).

**Context.** `postSeedSpine.ts` `scoreWindowForClaim` :167 and `offeredWindowIdf` :150 (share of a claim's distinctive terms a window speaks); `sourceBeats.ts` relevance trace rows (:477-481, :1773-1796 — line numbers shift after GEN-09; re-grep `trace`); `veracityMetrics.ts` `VeracityMetrics` :819-870, `buildVeracityMetrics` :927, `computeTapeRelevance` :420 (lineage-based); `topicSupply.ts` `MIN_TOPIC_SUPPLY` :81; the understander's subject sentence (`understandPrompt.ts`). Issue #709 items 2 and 3. **GEN-18 (merged first) adds a bench column and a `run.test.mjs` test and bumps the bench floor; this task adds its own column and test on top and bumps the floor again by one.**

**Exact change.** (1) `subjectShareFor(windowText, subjectSentence, idf)` = `scoreWindowForClaim` applied with the subject sentence as the claim. (2) Every placed window's trace row gains `subjectShare` (number). (3) `VeracityMetrics.windowSubjectRelevance = { placed, mean, min, belowSeedFloor }` where `belowSeedFloor` counts `subjectShare < ASSIGNED_SEED_MIN_SHARE`; `null` when nothing was placed. (4) `report.json` carries it via the existing veracity block; bench column `subj min` (`from: "report"`, no `direction` until three keyed runs exist — say so in the column comment). No gate, no prompt change.

**Tests.** `veracityMetrics.test.ts`: `"windowSubjectRelevance summarises subjectShare over placed windows and is null when none"` — mutation: mean over offered instead of placed → red. `sourceBeats.test.ts`: `"a placed window's trace row carries subjectShare"` — mutation: omit → red. `tools/generation-bench/run.test.mjs`: the new column prints `—` on run-9 (absent) — floor +1 over whatever GEN-18 left it at.

**Commands.** `cd backend && npx vitest run test/veracityMetrics.test.ts test/sourceBeats.test.ts`; `npm run typecheck`; `node --test tools/generation-bench/run.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch.** Any gate; `tapeWindowIsRelevant`; GEN-18's `cost_usd`/`tokens` column changes; GEN-05's `--compare` (a column without `direction` gets no verdict — nothing to add there).

**Stop and escalate if:** computing the share needs the corpus-wide df table (G-11/G-14) to be meaningful — record it as a caveat, still ship the per-show idf number; GEN-18 is not on `main` yet (wait).

**DoD.** Green; DRAFT PR `GEN-15: per-window subject relevance in the trace and report (#709 items 2–3)`.

**Conventions.** Branch `t_GEN-15/subject-relevance` off `origin/main` after GEN-09 (shares `sourceBeats.ts`) and GEN-18 (shares the bench column list, `run.test.mjs` and its floor) merge; DRAFT; trailers.

### GEN-16 · upgrade `@anthropic-ai/sdk` — opus · XS · human merge click

**Executor:** opus — SDK/credential-adjacent; `backend/package.json` is unlisted in `path-policy.mjs` (needs Wyatt's merge click).

**Context.** `backend/package.json` :26 `"@anthropic-ai/sdk": "^0.68.0"`; installed 0.68.0 has `cache_control` (14 mentions in `resources/messages/messages.d.ts`) but no `output_config`, no `effort`, only `web_search_20250305`. `backend/src/enrich/AnthropicEnricher.ts` :100-104 already notes the missing `output_config` types. Load the `claude-api` skill before choosing the version.

**Exact change.** Bump to the lowest released SDK version whose `messages.d.ts` declares `output_config` with `effort` and `format`, `cache_control`, and a `web_fetch_*` tool type — verify by grep after `npm install`, do not guess. Update `package-lock.json`. Fix any type breaks in `backend/src` minimally (no behaviour change). Record the version and the three greps in the PR body.

**Tests.** `backend/test/models.test.ts` gains `"the installed SDK declares output_config.effort, output_config.format, cache_control and a web_fetch tool"` (grep on the installed `.d.ts`; mutation: pin an older version → red).

**Commands.** `cd backend && npm install && npm run typecheck && npx vitest run`.

**Do not touch.** Model ids in `config/models.ts`; any request body.

**Stop and escalate if:** the upgrade changes `stop_reason`/`usage` field names used by the builders (grep `stop_reason`, `usage.`) — list them and stop.

**DoD.** Green; DRAFT PR `GEN-16: @anthropic-ai/sdk → <version> (output_config, effort, web_fetch types)`; PR body says it needs a human merge click (unlisted path).

**Conventions.** Branch `t_GEN-16/sdk-upgrade`; DRAFT; trailers.

### GEN-17 · G-02(a) effort, caps with a thinking allowance, model ids in the banner — opus · S

**Executor:** opus — LLM design; DENIED path. Load the `claude-api` skill first.

**Context.** Caps: `AnthropicContinuityBuilder.ts` :30 (500), `AnthropicDeepenActBuilder.ts` :30 (4000), `AnthropicExternalResearcher.ts` :45 (`RETRIEVAL_MAX_OUTPUT_TOKENS` = 2000, used at :203) and :105/:139 (800, the F-05 Haiku controversies call and its re-ask), `AnthropicSpineBuilder.ts` :37 (8000), `AnthropicPromptUnderstander.ts` :84 (400), :138 (600), :219 (120); writer/verifier use a `maxOutputTokens` variable (`AnthropicNarrationWriterBuilder.ts` :158/:184/:215-222 truncation check, `AnthropicNarrationVerifierBuilder.ts` :126/:153). `config/models.ts` :59-61 ids; `generateForays.ts` MODE banner (grep `MODE:`); `budgetGuard.ts` :165-190 (`estimatedUsd`); fix plan §WS-G; tracker F-05, F-47. **GEN-19 rewrites the researcher's retrieval call (:90-240) after this task; keep this task's researcher edits to wrapping `max_tokens` and adding `output_config` so GEN-19 rebases cleanly.**

**Exact change.** (1) `config/models.ts`: `export const THINKING_ALLOWANCE_TOKENS = 1024` and `export function outputCapWithThinking(expectedOutput)`; every `max_tokens` above becomes `outputCapWithThinking(<today's value>)`. (2) `output_config: { effort: "low" }` on writer, verifier, continuity, understander (all three calls), researcher (all four `messages.create` sites: :105, :139, :203 and the retry at ~:228); spine untouched. (3) Banner: `MODE: live — Anthropic builders, metered by BudgetGuard (daily $…, per-Foray $…) — opus=… sonnet=… haiku=…` from `MODEL_IDS`. (4) `budgetGuard` estimate helper adds the allowance to the output-token term; name it in the estimate's comment.

**Tests.** `models.test.ts`: `"no Anthropic builder sends a max_tokens a thinking allowance can exhaust"` (grep every `max_tokens:` in `backend/src/generation/Anthropic*.ts` resolves through `outputCapWithThinking`; mutation: one literal → red). Per-builder tests with `helpers/fakeAnthropicClient.ts`: `"sends output_config.effort low"` (mutation: drop → red); `"the spine sends no effort"`. `generateForaysArgs`/hands-free: banner contains the three ids (mutation: drop one → red).

**Commands.** `cd backend && npm run typecheck && npx vitest run`.

**Do not touch.** Prompts' wording; model ids; the researcher's tool type / citations (GEN-19).

**Stop and escalate if:** the SDK rejects `output_config` on Haiku 4.5 (check the skill's model table) — then the researcher keeps no effort and the PR says so.

**DoD.** Green; DRAFT PR `GEN-17: G-02 — effort low, caps with a thinking allowance, model ids in the banner (F-05, F-47)`.

**Conventions.** Branch `t_GEN-17/ws-g-effort` after GEN-16; DRAFT; trailers.

### GEN-18 · G-02(c) `usage` and `costUsd` per Foray in `report.json` — opus · S

**Executor:** opus — DENIED path.

**Context.** `backend/src/generation/usageTracking.ts` (process-global tallies — read it whole first), `config/models.ts` :77-108 (`USD_PER_WEB_SEARCH`, `ModelCost`), `generateForays.ts` `ReportEntry` and `calls` (G-30 c), `tools/generation-bench/run.mjs` `cost_usd` column :286 (prints `—` today) and `tokens` :275; `docs/curation/generation-kpis.md` "cost $" row; bench floor `test/suite-integrity.test.js` :1429 (46 after GEN-05). **GEN-15 and GEN-24 follow this task on `veracityMetrics.ts`/the bench; this task touches only the two existing bench columns named here.**

**Exact change.** (1) Per prompt, snapshot `usageTracking` before/after and write `ReportEntry.usage = { byTier: { opus|sonnet|haiku: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, calls } }, web_searches }` and `ReportEntry.costUsd` computed from `ModelCost` and `USD_PER_WEB_SEARCH` (cache reads at 0.1×, writes at 1.25× per the skill). (2) Bench: `cost_usd` column reads `report.costUsd`; `tokens` reads the sum when `usage` exists (keep the old field as fallback, sources say which). (3) KPI doc's "cost $" row: "measured from `usage` from GEN-18 on".

**Tests.** `generateForays.test.ts`: `"a generated entry carries usage by tier and a costUsd computed from the price table"` with the fake client; mutation: price cache reads at 1× → red. Bench: `run.test.mjs` `"cost_usd reads report.costUsd when present"` (floor +1; mutation: read the old field first → red).

**Commands.** `cd backend && npm run typecheck && npx vitest run test/generateForays.test.ts test/usageTracking.test.ts`; `node --test tools/generation-bench/run.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch.** `BudgetGuard` caps; `baseline.jsonl`; `VeracityMetrics` (GEN-15/GEN-24 own the next fields); GEN-05's `compareRow`.

**Stop and escalate if:** the SDK's `usage` object lacks cache fields on some call types — list which.

**DoD.** Green; DRAFT PR `GEN-18: usage and costUsd per Foray in report.json; bench reads them (G-02, G-20 prep)`.

**Conventions.** Branch `t_GEN-18/usage-cost` after GEN-17; DRAFT; trailers.

### GEN-19 · G-02(b)/F-48 hold server-attested `cited_text` as the evidence document — opus · S · after GEN-17

**Executor:** opus — tool/LLM design; DENIED path.

**Context.** `AnthropicExternalResearcher.ts` :90-240 (`web_search_20250305` :109/:207; `citations` :167 comment names the intended `web_fetch` + `cited_text` design; `RETRIEVAL_MAX_OUTPUT_TOKENS` :45); `gatherEvidence.ts` `EVIDENCE_MAX_PRINT_PASSAGES/CHARS` :70-75, `retrievePassages` doc comment (F-48: passages are the model's restatement); tracker F-48; `veracityMetrics.ts` `computeGroundedQuoteRate` :97 (haystack = held doc text). **Requires GEN-16 (types) and GEN-17 (which wraps this file's `max_tokens` and adds `output_config` at the same call sites) — branch off `origin/main` only after GEN-17 is merged, so the two edits to :90-240 never race.**

**Exact change.** (1) Enable citations on the retrieval call and prefer `cited_text` spans (with `url`, `title`) as the held document text; fall back to the model's passage only when no citation exists, marking the doc `attested: false`. (2) Move the tool type to the version the SDK exposes (`web_search_*`/`web_fetch_*` latest); when a `web_fetch` tool is available, ask for it on the retry query only (cost). (3) `EvidenceDoc.attested: boolean`; `VeracityMetrics.attestedDocShare` (this is the one `VeracityMetrics` field this task adds; if GEN-15/GEN-24 are in flight, add it at the end of the interface to keep the rebase trivial). No gate.

**Tests.** `AnthropicExternalResearcher.test.ts`: `"a cited_text span becomes the document text, marked attested"`; `"an uncited passage is held unattested"`; mutation: ignore citations → red. `gatherEvidence.test.ts`: cap tests unchanged. GEN-17's `"sends output_config.effort low"` for the researcher must stay green.

**Commands.** `cd backend && npm run typecheck && npx vitest run test/AnthropicExternalResearcher.test.ts test/gatherEvidence.test.ts test/models.test.ts`.

**Do not touch.** `printEvidenceFor`'s two-query protocol (GEN-13); GEN-17's `outputCapWithThinking` wrappers and `output_config` lines (keep them on the rewritten calls).

**Stop and escalate if:** citations are unavailable on Haiku 4.5 with server-side search (check the skill) — then the writer tier changes are a founder cost question; stop and report.

**DoD.** Green; DRAFT PR `GEN-19: evidence is held as server-attested cited_text (F-48, G-02 b)`.

**Conventions.** Branch `t_GEN-19/attested-evidence` off `origin/main` after GEN-17 merges; DRAFT; trailers.

### GEN-20 · G-37a prompt caching — opus · S

**Executor:** opus — LLM design; DENIED path. Load the `claude-api` skill (minimum cacheable prefix per model).

**Context.** Roadmap G-37a :1075-1081; `AnthropicNarrationWriterBuilder.ts` and `AnthropicNarrationVerifierBuilder.ts` (per-slot evidence pack is re-sent on select, verify and every retry); `AnthropicDeepenActBuilder.ts` (four deepen calls share the spine prefix); `usageTracking.ts` (cache fields from GEN-18).

**Exact change.** Order each writer/verifier request as `[system rules][evidence pack — cache_control: ephemeral][the seam-specific turn]`; deepen as `[spine prefix — cache_control][act-specific turn]`; only blocks that meet the model's minimum prefix get the marker (helper `markCacheable(block, modelTier)` in `config/models.ts` with the per-model minimum from the skill). Report `cacheReadShare` per Foray from `usage`.

**Tests.** Per-builder with the fake client: `"the evidence block precedes the seam turn and carries cache_control"` (mutation: reorder → red); `"a block under the model's minimum prefix carries no marker"` (mutation: always mark → red).

**Commands.** `cd backend && npm run typecheck && npx vitest run`.

**Do not touch.** Prompt wording.

**Stop and escalate if:** reordering changes any prompt's semantics (the rules text must stay first; if a builder interleaves rules and evidence, stop and report).

**DoD.** Green; DRAFT PR `GEN-20: prompt caching on the evidence pack and the spine prefix (G-37a)`; keyed Done-when (`cache_read_input_tokens > 0` on a slot's second call) moves to GEN-26.

**Conventions.** Branch `t_GEN-20/prompt-caching` after GEN-17 (and after GEN-18 merges, since it reads the usage cache fields); DRAFT; trailers.

### GEN-21 · G-37b structured outputs; delete the re-ask path they retire — opus · S

**Executor:** opus — LLM design; DENIED path; F-100 deletion rule.

**Context.** `parseWithRetry.ts` (`reask` closure, `parseOrRepairJson`), every `Anthropic*Builder.ts` re-ask site (grep `reask`), `backend/test/parseWithRetry.test.ts` (greps for drift), roadmap G-37b :1082-1084, `AnthropicEnricher.ts` :100-104.

**Exact change.** `output_config.format` = the builder's zod schema (via the SDK's JSON-schema helper) on every builder; keep `parseOrRepairJson` as a defensive parse; delete the `reask` closure and the fence strip on the live path (the relay's `stripOneFence` stays — transport only); bump nothing in checkpoints. PR body counts deleted tests/branches.

**Tests.** Per builder: `"sends output_config.format with the schema"` (mutation: drop → red); `parseWithRetry.test.ts`: `"no builder constructs a reask closure any more"` (grep; mutation: reintroduce → red).

**Commands.** `cd backend && npm run typecheck && npx vitest run`.

**Do not touch.** `tools/generation/relay.mjs`.

**Stop and escalate if:** the SDK's structured-output helper cannot express a schema feature a builder uses (e.g. `z.discriminatedUnion`) — list the builder and stop.

**DoD.** Green; DRAFT PR `GEN-21: structured outputs on every builder; the re-ask path deleted (G-37b)`.

**Conventions.** Branch `t_GEN-21/structured-outputs` after GEN-17 and GEN-20 (same builder files, serial); DRAFT; trailers.

### GEN-22 · G-21a `publish-foray --hold auto` — opus · S · D4

**Executor:** opus — publish-gate policy; DENIED path.

**Context.** `backend/src/cli/publishForay.ts` `parseArgs` :205-221 (`hold: force ? true : !noHold`, `holdForcedByForce`), `gateWrittenTree` :537, `publishPrBody` :568-620 (already attaches gate failures and suite failures), the label call :864-866; `automerge-nightly.yml` blocking labels `hold`, `founder-decision`; roadmap G-21a :817-836; `backend/test/publishForay.test.ts`.

**Exact change.** `--hold on|off|auto` (keep `--no-hold` as an alias of `off`; `--force` still forces `on`). `auto`: apply `hold` iff `!gate.ok || !suites.ok`; PR body states which mode decided. **Default stays `on`** until Wyatt's D4 ruling; the flip is a one-line follow-up named in the PR.

**Tests.** `publishForay.test.ts`: `"--hold auto applies no label when the gate and the suites are green"`; `"--hold auto applies hold when either fails"`; `"--force forces hold even under auto"`; mutations: invert each condition → red.

**Commands.** `cd backend && npm run typecheck && npx vitest run test/publishForay.test.ts test/publishSuites.test.ts`.

**Do not touch.** `.github/**`, `path-policy.mjs`, the `status` field flip (retained keystroke).

**Stop and escalate if:** `run("gh", …)` ordering means the PR is briefly mergeable before the label lands — then create with `--label hold` up front and remove it under `auto`; say so.

**DoD.** Green; DRAFT PR `GEN-22: publish-foray --hold auto (G-21a, default unchanged pending D4)`.

**Conventions.** Branch `t_GEN-22/hold-auto`; DRAFT; trailers.

### GEN-23 · G-01 HUMAN-ACTIONS card for the API key and caps — opus · XS

**Executor:** opus — credentials guidance.

**Context.** `HUMAN-ACTIONS.md` :1-35 (format `## #<n> 🔴|🟡 [BLOCKING|DECIDE] <title> (~time)` + `<!-- ha filed=… kind=default -->` + **Why / Steps / Worked if**; next free number after #116 — re-check on your branch); `backend/src/config/env.ts` :53-106 (`DAILY_BUDGET_USD` default 25, `EPISODE_BUDGET_USD` 10, `anthropicDryRun` = key unset); `generateForays.ts` banner (grep `MODE:`); roadmap G-01 :353-370 and §7 cost estimate; `.gitignore` (confirm `backend/.env` is ignored — if not, the card's first step is to add it, in the same PR).

**Exact change.** Add `## #117 🔴 [BLOCKING] Place an Anthropic Console API key on the generation host and set the spend caps (~10 min)` with steps: create a Console key (not a claude.ai login) with a Console spend limit; put `ANTHROPIC_API_KEY=…`, `DAILY_BUDGET_USD=25`, `EPISODE_BUDGET_USD=10` in `backend/.env` on the founder's PC (interim host until D2); never paste the key in chat, an issue or the repo; run `cd backend && npm run generate-forays -- --prompts <file> --duration short --limit 1 --out data-local/foray-candidates/smoke`; **Worked if:** the banner prints `MODE: live …` with three model ids (after GEN-17) and the short Foray completes with no `truncated` reply in `report.json`. Increment the "open" count in the header.

**Tests.** None; docs lane. `node --test test/suite-integrity.test.js` unchanged.

**Do not touch.** `docs/DECISIONS.md` (the D1 ruling entry is the founder's session's to write).

**Stop and escalate if:** `backend/.env` is not gitignored.

**DoD.** DRAFT PR `GEN-23: HUMAN-ACTIONS #117 — the Anthropic key and caps (G-01, D1)`.

**Conventions.** Branch `t_GEN-23/human-action-key`; DRAFT; trailers.

### GEN-24 · F-58 `spokenLineErrors` over generated pages as warnings — opus · S · D7 · after GEN-12 and GEN-15

**Executor:** opus — narration-rule judgement; DENIED path.

**Context.** `tools/foray/check-narration.mjs` `spokenLineErrors(text, where, { hasTape })` :159 (pure, exported; used at :379 and :627); `backend/src/generation/mjs-modules.d.ts` (how `.mjs` is typed for import); `writeAct.ts` `finalPageFor` :1143 (edited by GEN-12 — re-grep on your branch); `veracityMetrics.ts` `VeracityMetrics` :819 and `buildVeracityMetrics` :927 (both extended by GEN-15 — re-grep); tracker F-58; `types/narration.ts` `validateNarratedBeat` :714. **This task appends one field to `VeracityMetrics` and one block to `buildVeracityMetrics` after GEN-15's; it must branch off `origin/main` after GEN-12 (`writeAct.ts`) and GEN-15 (`veracityMetrics.ts`, `veracityMetrics.test.ts`) are merged.**

**Exact change.** After a seam is confirmed, run `spokenLineErrors(page.script, seamId, { hasTape })` and attach `spokenLineWarnings: string[]` to the page; `VeracityMetrics.spokenLineWarnings` = total; printed in the driver's per-Foray summary; **no refusal** (D7 default). Add the declaration to `mjs-modules.d.ts`.

**Tests.** `actNarration.test.ts`: `"a confirmed page carrying a spoken-line error is kept, warned, and counted (F-58)"` (mutation: drop the count → red); `"a clean page carries an empty list"`. `veracityMetrics.test.ts`: the total.

**Commands.** `cd backend && npm run typecheck && npx vitest run test/actNarration.test.ts test/veracityMetrics.test.ts`; `node --test tools/foray/check-narration.test.mjs`.

**Do not touch.** `check-narration.mjs`'s rules; GEN-15's `windowSubjectRelevance`; GEN-12's `seedLostPages`.

**Stop and escalate if:** importing the `.mjs` into vitest fails on Windows paths (F-21 class) — report the path; GEN-12 or GEN-15 is not on `main` yet (wait).

**DoD.** Green; DRAFT PR `GEN-24: spoken-line rules run over generated pages as warnings (F-58; severity per D7)`.

**Conventions.** Branch `t_GEN-24/spoken-line-warnings` off `origin/main` after GEN-12 and GEN-15 merge; DRAFT; trailers.

### GEN-25 · tracker rows F-88…F-103 / I-25…I-28 and roadmap done markers — opus · S

**Executor:** opus — judgement from run records (statuses are read out of prose).

**Context.** `docs/curation/generation-findings-tracker.md` (rows end at F-87, I-28 present; §2 counts stale; GEN-06 edits the F-37 row :59 — if it merged first, leave that row alone); `docs/curation/generation-run-2026-09-09.md` :456-484 (F-89…F-103 headers with "fixed in …"); `docs/curation/foray-to-spec-roadmap.md` cards G-23 :918, G-24 :933-956, G-30 :769-791, G-31 :997-1009, G-33 :1032, G-37 :1074, G-42a :1207.

**Exact change.** Append one tracker row per finding F-88…F-103 and I-25…I-28 copying the ledger's status; recount §2; add DONE/partial markers: G-30 (a)–(e) DONE (`generateForays.ts` G-30 comments), (c) `medium` default → GEN-07, (f) waits on D2; G-24 DONE (F-91); G-23: F-55, F-56 DONE, F-20 → GEN-07, F-58 → GEN-24, step 25 DONE (`uniqueForayId`); G-31: F-64/F-70/F-73 checked at sourcing/stitch (F-79, F-80, F-87, `partialProjection.ts`), runtime band waits on D7; G-21b → GEN-04; G-42b → GEN-05/GEN-27; G-02 → GEN-17/18/19; G-37a/b → GEN-20/21.

**Tests.** None (docs). **Commands.** `git diff --stat` touches only the two docs.

**Do not touch.** `docs/DECISIONS.md`; the F-37 row (GEN-06).

**Stop and escalate if:** a ledger entry's status is ambiguous — leave the row `open` and say so in the PR.

**DoD.** DRAFT PR `GEN-25: tracker and roadmap reflect what main runs (F-88…F-103, G-card markers)`.

**Conventions.** Branch `t_GEN-25/tracker-refresh`; DRAFT; trailers.

### GEN-26 · G-20 the two keyed runs — opus · M · blocked on the key

**Executor:** opus — keyed spend, field diagnosis, the founder's PC (holds the archive until G-14).

**Context.** Roadmap G-20 :793-814; HUMAN-ACTIONS #117 (GEN-23) done; GEN-07/08/11–15/17/18 merged; `tools/foray/digest.mjs` (GEN-04) and a standing "generated Forays" tracking issue (create it: `gh issue create --title "Generated Forays — digest" --body "One comment per candidate (G-21b)"`); `tools/generation-bench/run.mjs --append` (G-42a); `docs/curation/generation-run-2026-09-09.md` §2.

**Exact change.** Prompt 1 (engineering disasters, medium) then prompt 2 (AI systems, medium — or short if `tierDecision` says so): `cd backend && npm run generate-forays -- --prompts <file> --duration medium --budget-usd 10 --out data-local/foray-candidates/run-10 --notify "node ../tools/foray/digest.mjs --report data-local/foray-candidates/run-10/report.json --issue <N>"` (the `../` because the hook runs from `backend/`); then `npm run publish-foray -- --input <candidate> --report …` (hold default). Record in the run doc: wall, `ttlA1Ms`, `firstAttemptPassRatePages`, tokens by tier, `costUsd`, 429 count + `retry-after`, `cache_read_input_tokens` on a slot's second call (G-37a's Done-when), `tierDecision`, `windowSubjectRelevance`, and the human-touch list (target zero after the key). Append the bench row (`--append docs/curation/generation-kpis.md`) and the jsonl row to `baseline.jsonl`. Fix only what blocks; new F-ids in the ledger.

**Tests.** None new; the run is the measurement. **Commands.** As above, plus `node tools/generation-bench/run.mjs --compare tools/generation-bench/baseline.jsonl data-local/foray-candidates/run-10`.

**Do not touch.** `data-local/transcripts/`; the relay.

**Stop and escalate if:** the veracity gate refuses on content (D4 — never `--force` without a founder line); 429s exceed 5 per run (rate tier → G-32 gating).

**DoD.** Two candidates in `data/forays.json` via `publish-foray` PRs (draft status), KPI rows appended, the run-doc table filled, the digest comments on the tracking issue, and an F-id for every fix.

**Conventions.** Keyed runs happen on the founder's PC; PRs from `publish-foray` are DRAFT with `hold` until D4; trailers.

### GEN-27 · G-42b the scheduled comparison workflow — opus · S · D11

**Executor:** opus — `.github/` is DENIED; D11.

**Context.** GEN-05's `--compare` (returns `exitCode`; the CLI sets `process.exitCode`, so `--strict` is a real gate in a workflow step); `.github/workflows/nightly-watch.yml` (the pattern for an advisory job that opens/updates an issue); roadmap G-42b :1256-1262; D11 default (no key in Actions).

**Exact change.** `.github/workflows/generation-bench-watch.yml`: on `push` to `main` touching `tools/generation-bench/baseline.jsonl` and on a weekly schedule: run `node tools/generation-bench/run.mjs --compare tools/generation-bench/baseline.jsonl <the newest row's report dir, committed under tools/generation-bench/fixtures/out-<n>/>` and post/update one issue comment with the table; `continue-on-error: true` until D0 confirms targets (then `--strict`). The host-side cron that runs the bench and pushes the row is a `docs/HUMAN-ACTIONS` line for the founder's PC (or the D2 host). If D11 = yes, a second job runs the keyed bench with `ANTHROPIC_API_KEY` from an environment secret — not built by default.

**Tests.** `tools/mobile/release-workflow.test.mjs`-style YAML test: `test/generation-bench-workflow.test.js` asserting the workflow invokes `run.mjs --compare` and carries `continue-on-error: true` (floor 2; mutation: drop the flag → red).

**Commands.** `node --test test/generation-bench-workflow.test.js`; `node --test test/suite-integrity.test.js`; `node tools/ci/path-policy.mjs` (read-only) to confirm the PR is DENIED-lane.

**Do not touch.** `ci.yml`, `automerge-nightly.yml`.

**Stop and escalate if:** the workflow would need any secret.

**DoD.** Green; DRAFT PR `GEN-27: generation-bench watch workflow (G-42b, no key in Actions)`; one scheduled run id in the PR after merge.

**Conventions.** Branch `t_GEN-27/bench-workflow`; DRAFT; trailers; founder-approved lane.

### GEN-28 · G-37c Haiku verifier trial — opus · S · blocked on ≥3 keyed runs

**Executor:** opus — LLM judgement.

**Context.** `createNarrationVerifierBuilder.ts`, `AnthropicNarrationVerifierBuilder.ts`, `config/models.ts` tiers; roadmap G-37c :1085-1088; GEN-26's three baseline rows.

**Exact change.** `VERIFIER_TIER=sonnet|haiku` env (default sonnet) read in `createNarrationVerifierBuilder`; reported in `report.json` (`verifierTier`) and the bench (`from: "report"`). Three keyed runs per tier; compare `first_pass_beats`, `unverified`, `subj min`; adopt only within the band (GEN-05's `--compare`).

**Tests.** `createNarrationVerifierBuilder` test: `"VERIFIER_TIER=haiku builds the Haiku model id"` (mutation: ignore env → red).

**Commands.** `cd backend && npx vitest run test/createNarrationVerifierBuilder.test.ts` (create if absent), then the runs.

**Stop and escalate if:** Haiku's unverified count exceeds Sonnet's on any run — record and do not adopt.

**DoD.** Six KPI rows and a one-paragraph verdict in `generation-kpis.md`; default unchanged unless within band.

**Conventions.** Branch `t_GEN-28/verifier-tier`; DRAFT; trailers.

### GEN-29 · G-37d per-slot streaming — design comment only — opus · S · deferred (D6)

**Executor:** opus — contract design; nothing built until D6.

**Context.** Roadmap G-37d :1089-1094, G-38 :1096-1101, F-15 (no HTTP server exists), `stitchForay.ts` `onActReady`, `partialCandidate.ts`.

**Exact change.** Write `docs/curation/streaming-design-2026-10.md`: the per-slot partial contract, the relaxed per-slot `check-forays` scope (which rules are monotone per slot), host requirement (D2), and the measured ttlA1 from GEN-26 that the founder needs to rule D6. No code.

**DoD.** Doc in a DRAFT PR `GEN-29: G-37d streaming design (for D6)`; D6 added to the founder queue.

**Conventions.** Branch `t_GEN-29/streaming-design`; DRAFT; trailers.

## 4. Sequencing

**Throttle note (founder, 2026-09-25: "too much running in parallel").** Cap concurrent agents at **three** until the machine recovers: two qwen and one opus in wave 0, then one qwen and two opus. Every task below is still independent where stated; the cap only changes how many run at once, not their order.

**Wave 0 (all independent unless noted; run ≤ 3 at a time).**
- qwen: GEN-01 → GEN-02 (same `relay.test.mjs`; serial), then GEN-03, GEN-04, GEN-05, GEN-06 (pairwise disjoint files). GEN-01/02/04/05 each raise or add a `FLOORS` line in `test/suite-integrity.test.js`; on rebase keep both lines. GEN-06 and GEN-25 both edit `generation-findings-tracker.md` (different rows) — whichever lands second rebases.
- opus: GEN-07 → GEN-14 (same `generateForays.ts`; serial), GEN-08, GEN-10, GEN-11 → GEN-12 (both `writeAct.ts`; serial), GEN-13, GEN-16 (needs the founder's merge click), GEN-22, GEN-23, GEN-25.
- Founder: answer Q1–Q6; place the key (HUMAN-ACTIONS #117); click-merge GEN-16.

**Wave 1 (after the named wave-0 merges).**
- GEN-09 (after GEN-03).
- Builder chain, strictly serial on the `Anthropic*Builder.ts` / researcher files: GEN-17 (after GEN-16) → GEN-18 → GEN-19 (after GEN-17; parallel with GEN-18 is allowed — GEN-18 touches `generateForays.ts`, `usageTracking.ts` and two bench columns, GEN-19 touches the researcher and `gatherEvidence.ts`) → GEN-20 (after GEN-18) → GEN-21 (after GEN-20).
- Metrics chain, strictly serial on `veracityMetrics.ts` / the bench: GEN-18 → GEN-15 (also after GEN-09) → GEN-24 (also after GEN-12).

**Wave 2 (keyed).** GEN-26 once the key exists and GEN-07/08/11–15/17/18 are on main; GEN-27 after GEN-05 and GEN-18 (D11 default needs no secret); GEN-28 after three GEN-26 rows; GEN-29 after GEN-26's ttlA1 number.

**Critical path to the first keyed published Foray:** D1 → GEN-23 (card) → key placed → GEN-16 (click) → GEN-17 → GEN-18 (so the run measures usage) → GEN-26 → D4 → flip GEN-22's default.

**Not tasked, with reasons.** F-19 (Frame budget flex) — obsolete under Q-03's seam writing; F-41 whole-Foray repetition — an LLM-judged check that waits for keyed data (raise after GEN-26); F-57 runtime band — D7; G-32/G-34/G-35/G-36 — gated on GEN-26's 429 count and D6 per the deck; #547 and #315 — supply/DAI packages; `ROLE_MAX_SEC` re-derivation (#706 item 2's other half) — declined: generation writes no `role`, L2/L3 are curated-only by design, and GEN-08 makes L4 the generated clip's rule.
