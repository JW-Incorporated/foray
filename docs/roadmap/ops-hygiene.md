# Ops and repo hygiene — the hand-off plan (package OPS), revision 2

Verified against `origin/main` = `ecb6bfa3` (2026-09-25, after PR #835 and #839 merged; the previous revision was cut at `0b2b8f92`). Line numbers below are at that commit; re-check with `git show origin/main:<path> | cat -n | sed -n 'A,Bp'` before editing. A line that moved is a stop condition only where a task says "stop if"; tasks that must survive later merges (OPS-10) anchor by text, not by line. In Git Bash on Windows, prefix `git show origin/main:.github/...` reads with `MSYS_NO_PATHCONV=1` or the path converter mangles the colon.

**Reviewer problems — disposition.** All seven are accepted and fixed in this revision: OPS-01 (one expected string, smoke command deleted), OPS-03 (three existing tests named as rewrite-in-place; floor recomputed from the real base of 19, not 18), OPS-08/OPS-15 (OPS-08 no longer edits the `nightly-watch` row), OPS-10 (anchored by text; #835 is MERGED so the task shrinks to races-3 — #835's tests-11 already removed the 4 s races-4 wall clock; grep-and-report instead of convert; a "never settled" stop rule), OPS-12 (floor = true count, `fs` injected, two file-deletion tests), OPS-14 (the prompt rewrite split out as OPS-17 with verbatim text), OPS-15 (no presupposed answers; the #46 rewrite moves to OPS-16). One reviewer detail is corrected rather than adopted: the plan's earlier note that `shows-import.yml` has a stale "one `gh release create`" header comment is wrong — `git grep` finds no such line in the workflow — so OPS-03 no longer asks for it.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** Make the unattended machinery honest and green again: the weekly `shows-import` run has been red since 2026-09-20 and nobody could read why; a release re-run still replays a used build number; the founder-waiting block links to JSON (#309) and hides conflicting PRs (#312); nothing audits what auto-merged (#129); one research source reads as "ingested" while it is a loading spinner (#255); a races-3 test still waits on a fixed 5 ms sleep and `NowPlayingPublisherTests` waits on a real 0.2 s deadline; the nightly content step needs a home off Wyatt's account (#760); and the founder's workstation carries 261 registered worktrees, 208 of them for PRs that merged long ago.

**Done when.** `shows-import` has one green scheduled run that publishes a shard release; `release.yml` refuses attempt 2 with a message naming the fresh-dispatch rule; #309, #312, #255 and #129 are closed by merged PRs; `test/create-page.test.js` races-3 and `NowPlayingPublisherTests` wait on state, not on the clock; the rig can run the nightly with two commands around its one judgement step; and `git worktree list | wc -l` on the workstation is under 60.

**Dependencies.**
- PR #835 is MERGED (2026-09-26T00:30Z, commit `9442bba7`). OPS-10 no longer waits on anything.
- OPS-03 is conditional on OPS-02's reading of the first log that carries the new diagnostics.
- Founder merges: every task that touches `.github/`, `tools/ci/` or `tools/release/` (DENIED in `tools/ci/path-policy.mjs`) ends as a `needs-founder` PR. Nothing in this package is blocked on the native-engine deck or the store launch.
- Credentials/devices: the rig needs a GitHub token (Q3); OPS-11 needs the `ios-kit` macOS CI job (`.github/workflows/ci.yml:146`, `xcodebuild test` at 229; no local Mac); OPS-13 runs on Wyatt's workstation only.
- Founder acceptance of the #760 plan (a rig, not the Cloud routine) gates OPS-16 only; OPS-14/15/17 are written so they stay true whichever way Q2/Q3 go.

**Open founder questions (defaults proposed; everything else is decided below).**
1. **#129 merge audit as a keyless GitHub Action, not a Claude Cloud routine?** The issue asked for a routine; the release plan ruling of 2026-09-22 ("a lightweight script that doesn't require agent involvement") and the cloud-routine block (environment_id) both point at an Action. *Default: Action, weekly, one comment per run on issue #129 itself.*
2. **The stranded 2026-09-14 digest (40 episodes):** drop it (one dispatch of `nightly-refresh` with `overwrite_unmerged_digest`) or recover it later on the rig? *Default: drop; the episodes are 11 days stale and recovery needs the judgement step that has no home yet.*
3. **Token for the rig:** a fine-grained PAT on your account scoped to `JW-Incorporated/foray` (Contents: write, Pull requests: write, 90-day expiry) or a machine user? *Default: fine-grained PAT; you create it, the rig's owner installs it; nothing lands in the repo.*
4. **Worktree cleanup on your workstation:** may OPS-13 remove the 208 worktrees whose branch has a MERGED PR (and delete those local branches), prune the 4 stale `%TEMP%` entries, and delete the 47 stray regular files sitting directly under `.claude/worktrees/` (`apiout.txt`, `app.bak`, `c3.cjs`, ...)? The 35 branches with no PR and anything dirty stay. *Default: yes, exactly that set, after a dry-run listing you can read.*

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| OPS-01 | shows-import: print exit code, signal, stderr and stdout of a failed `gh` on their own lines | qwen | — | — | XS |
| OPS-02 | shows-import: dispatch, read the real error, pick the fix, own the tracking issue | opus | diagnosing from field records; dispatching a production workflow | OPS-01 | S |
| OPS-03 | shows-import: draft release + chunked, retried, resumable uploads | qwen | — | OPS-02 verdict | S |
| OPS-04 | release.yml: refuse attempt 2 (the replayed build number) | opus | `.github/` DENIED; release path | — | XS |
| OPS-05 | #309: founder-waiting rows link to the PR page | opus | `tools/ci/` DENIED | — | XS |
| OPS-06 | #312: conflicting founder-queue PRs listed as "need a rebase first" | opus | `tools/ci/` DENIED | OPS-05 (same branch) | S |
| OPS-07 | #129: `tools/audit/merge-audit.mjs` — the pure audit + CLI + tests | qwen | — | — | S |
| OPS-08 | #129: `merge-audit.yml` weekly, comments on #129, one new runners.md row | opus | `.github/` DENIED; posts as the repo bot | OPS-07, Q1 | XS |
| OPS-09 | #255: `status: "thin"` for a capture under the token floor | qwen | — | — | XS |
| OPS-10 | races-3: `holdSearchData` waits on `createBuildPending`, never on a fixed sleep | qwen | — | — | XS |
| OPS-11 | ArtworkCache: injectable deadline; the timeout test fires it by hand | opus | Swift; verified only on macOS CI | — | S |
| OPS-12 | `tools/dev/worktree-gc.mjs`: classify every worktree, remove only the merged and clean | qwen | — | — | S |
| OPS-13 | Run worktree-gc on the workstation | opus | destructive local action; needs the founder's machine and Q4 | OPS-12, Q4 | XS |
| OPS-14 | #760: `tools/refresh/nightly-runner.mjs` — the mechanical halves of the nightly as two commands (code + tests only) | qwen | — | — | S |
| OPS-15 | #760: two runners.md rows, worded as pending | qwen | — | OPS-14 | XS |
| OPS-16 | #760: hand-off comment, token scope, the digest decision executed, HUMAN-ACTIONS #46 step 1 | opus | credentials; a data-loss dispatch; talking to the rig's owner | OPS-14, OPS-15, OPS-17, Q2, Q3 | XS |
| OPS-17 | #760: `foray-nightly.md` steps 1-3 and 5-7 become the two runner commands (verbatim text supplied) | opus | rewriting an agent's operating prompt | OPS-14 | XS |

Conventions every task follows (stated once, binding everywhere): worktree via `git -c core.autocrlf=false worktree add .claude/worktrees/<id> -b <branch> origin/main` and `git worktree remove .claude/worktrees/<id>` after the PR is open; never commit `deploy-manifest.json` or `data/forays-directory.json`; `sw.js` keeps `BUILD_ID = "unstamped"`; a new suite gets a floor in `test/suite-integrity.test.js` (`FLOORS`, `"path": count,`) in the same PR, and a grown suite raises its floor to the true count the run prints; a test that names a Foray uses `tools/foray/fixtures/frozen/`; PRs open as **DRAFT**; commits end with the trailer lines your harness gives you (`Co-Authored-By:` + `Claude-Session:`); one test process at a time; tests run from the repo root unless the command says otherwise.

## 3. Tasks

### OPS-01 — shows-import: the FATAL line carries the facts (qwen, XS)

**Executor:** qwen.

**Context (read first).**
- `tools/shows/run-and-publish.mjs` lines 213-221 (`main()` and its `.catch`; line 219 is `console.error("FATAL:", e instanceof Error ? e.message : e);`) and lines 37-58 (`runBuild`, the child-process contract).
- `tools/shows/publish-release.mjs` lines 104-142 (`publishRelease` and its doc comment: one `gh release create` with every asset) and 215-243 (`publishShardReleases`).
- `tools/shows/run-and-publish.test.mjs` lines 14-60 (imports, `fakeGhRegistry`) and the `test(` names at lines 63, 124, 179, 202, 227, 251, 284.
- `test/suite-integrity.test.js:1971` — `"tools/shows/run-and-publish.test.mjs": 6,`.
- The field record: run 35507245541 (2026-09-20) failed 47 s after `BUILD_COMPLETE` with one log line `FATAL: Command failed: gh release create shows-index-sat-19-sep-2026-23-19-51-gmt-shards-1 <100 shard paths ...>` — the line was cut by the log after the 100 paths, and the exit code / stderr never appeared. The 2026-09-13 and 09-06 failures were `SHARD_TOO_LARGE` (fixed by #716); the two 2026-09-15 failures were the same shape as 09-20 on the top-level release (fixed by #717/#719). `gh release list` shows only `shows-index-sat-12-sep-2026-23-24-31-gmt` and no `-shards-*` release.

**Exact change.**
1. In `tools/shows/run-and-publish.mjs`, add and export `describeExecError(err, { maxArgs = 6, tailChars = 4000 } = {})` returning an array of strings, built as:
   - Line 1: `FATAL: ` + head, where head is: if `typeof err?.cmd === "string"`, `Command failed: ` + the first `maxArgs` whitespace-separated tokens of `err.cmd` joined by a single space + (only when more tokens exist) ` … (+N more args)` where N = total tokens − maxArgs; otherwise the first line of `String(err?.message ?? err)`.
   - If `err?.code !== undefined && err.code !== null`: `FATAL_CODE: ${err.code}`.
   - If `err?.signal`: `FATAL_SIGNAL: ${err.signal}`. If `err?.killed === true`: `FATAL_KILLED: true`.
   - If `"stderr" in Object(err)`: `FATAL_STDERR: ` + (last `tailChars` characters of `String(err.stderr).trim()`, or `(empty)` when that is empty).
   - If `"stdout" in Object(err)`: `FATAL_STDOUT: ` + same rule.
   - Nothing else. Order exactly as listed.
2. Replace the `.catch` body at lines 218-221 with: `for (const line of describeExecError(e)) console.error(line); process.exit(1);`.
3. Do not change `runBuild`, `runAndPublish`, or anything in `publish-release.mjs`.

**Tests to add** (`tools/shows/run-and-publish.test.mjs`, import `describeExecError`):
- `describeExecError: an execFile failure prints code, signal, stderr and stdout on their own lines` — err = `Object.assign(new Error("Command failed: gh release create t a b c d e f g h\nsome stderr"), { cmd: "gh release create t a b c d e f g h", code: 1, signal: null, killed: false, stderr: "some stderr", stdout: "created" })`. The cmd has 12 tokens; with `maxArgs = 6` the expected first line is exactly `"FATAL: Command failed: gh release create t a b … (+6 more args)"`. Assert `lines[0]` equals that string, `lines` includes `"FATAL_CODE: 1"`, `"FATAL_STDERR: some stderr"`, `"FATAL_STDOUT: created"`, and no element starts with `FATAL_SIGNAL`. Mutation that must go red: delete the `FATAL_STDERR` line from the function.
- `describeExecError: an empty stderr is said out loud` — same err with `stderr: ""` → includes `"FATAL_STDERR: (empty)"`. Mutation: return the empty string instead of `(empty)`.
- `describeExecError: a non-exec error keeps its first message line only` — `new Error("boom\nsecond")` → `["FATAL: boom"]`. Mutation: print the whole message.
- Floor at `test/suite-integrity.test.js:1971`: raise `6` to the true count the run prints (the file already holds 7 `test(` blocks; after these three it is at least 9 — write the printed number).

**Commands** (repo root):
- `node --experimental-sqlite --test tools/shows/run-and-publish.test.mjs` → all pass; note the count.
- `node --experimental-sqlite --test tools/shows/publish-release.test.mjs` → 19 pass, untouched.
- `node --test test/suite-integrity.test.js` → pass.

**Do not touch:** `.github/`, `tools/shows/publish-release.mjs`, `tools/shows/import-dump.mjs`, `tools/shows/config.mjs`.

**Stop and escalate if:** `main()` no longer looks like lines 213-221; any test outside `run-and-publish.test.mjs` fails; `describeExecError` would need `publish-release.mjs` to change.

**Definition of done:** the three tests above pass and each named mutation makes exactly its test red; floor raised; DRAFT PR titled `fix(shows-import): a failed gh call prints its exit code, signal and stderr (OPS-01)`; PR body links run 35507245541 and states that the fix is diagnostic only.

### OPS-02 — shows-import: dispatch, read, decide (opus, S)

**Executor:** opus — reads a production run, decides between fixes, may create an issue.

**Context.** Everything in OPS-01's context; `.github/workflows/shows-import.yml` (cron `7 6 * * 0` at line 56, `workflow_dispatch: {}` at 57, `timeout-minutes: 40` at 74; read with `MSYS_NO_PATHCONV=1`); `tools/shows/config.mjs` (`MAX_SHARD_ASSETS_PER_RELEASE = 900`, so all 100 shards go into batch 1; `MAX_SHARD_GZ_P95_BYTES`); `tools/shows/publish-release.mjs:56-69` (`releaseExists` treats any `gh release view` failure other than `release not found|HTTP 404` as fatal).

**Exact steps.**
1. Open a tracking issue `shows-import: the weekly run has been red since 2026-09-20 (the shard release create fails after BUILD_COMPLETE)` with the run ids 35507245541, 34932533162, 34930842940, the fact that no `-shards-1` release or draft exists (`gh api repos/JW-Incorporated/foray/releases?per_page=50 --jq '.[]|select(.draft)|.tag_name'` must print nothing — record the output), and a link to OPS-01's PR.
2. After OPS-01 merges: `gh workflow run shows-import.yml --ref main`, then `gh run watch <id>` (the build alone takes ~2 min). Read `gh api repos/JW-Incorporated/foray/actions/jobs/<job id>/logs | grep -E '^FATAL'`. (Use the raw job log, not `gh run view --log`: the latter dropped the FATAL line on 2026-09-20.)
3. Verify the `gh` feature OPS-03 relies on with one call: `gh release view shows-index-sat-12-sep-2026-23-24-31-gmt --json isDraft,assets --jq '.assets|length'` → `4`. Record the output on the issue.
4. Decide, and write the decision on the issue:
   - `FATAL_STDERR` shows an upload error (5xx, EOF, timeout, `context deadline`), or `FATAL_SIGNAL` is set, or the run reaches the 40-minute timeout → **OPS-03** is the fix.
   - `HTTP 422` naming an asset (name, size, duplicate) → the fix is in how assets are named/sized; write the finding on the issue and hand a new XS task (not in this plan) to qwen with the exact message.
   - `HTTP 403`/`401` → HUMAN-ACTIONS item for the founder (token/permissions); the workflow's `permissions:` block is already `contents: write`.
   - A stranded draft exists (`isDraft: true` for `...-shards-1`) → OPS-03 as well; its resume path is designed for that.
5. Once the eventual fix merges, dispatch once more and confirm `PUBLISHED: ...-shards-1 (100 shard assets, ...)`, `PUBLISHED: <top tag> (4 assets)`, `POINTER_UPDATED`, and that the pointer PR on branch `shows-index/pointer-update` opens and auto-merges. Close the issue with the run id.

**Do not touch:** any code; this task edits only the issue.

**Stop and escalate if:** the dispatched run cannot be started (`gh` refuses), or the FATAL lines still do not appear (then OPS-01 missed a path — reopen it).

**Definition of done:** the issue exists with the diagnosis, the `--json isDraft,assets` check result, and the named next task; after the fix, a green run id is on the issue and it is closed.

### OPS-03 — shows-import: draft, chunked uploads with retry, resumable (qwen, S — conditional on OPS-02)

**Executor:** qwen. Start only when OPS-02's issue comment says "OPS-03" and records the `--json isDraft,assets` check as `4`.

**Context.**
- `tools/shows/publish-release.mjs`: lines 56-69 `releaseExists`; 104-118 the `publishRelease` doc comment ("one atomic call" design being replaced); 119 `publishRelease`; 187 `partitionShardBatches`; 202 `shardReleaseTagFor`; 215 `publishShardReleases`; `class PublishError` near the top (grep it).
- `tools/shows/run-and-publish.mjs` (grep `publishShardReleases(`, `releaseExists(`, `publishRelease(` — the three call sites).
- `tools/shows/publish-release.test.mjs` lines 28-48 (`releaseExists` tests), 76-103 (`publishRelease` tests), 181-239 (`publishShardReleases` with a fake `exec`).
- `tools/shows/run-and-publish.test.mjs` lines 42-60 (`fakeGhRegistry`: answers `release view` and `release create`) and lines 284-310 (the "interrupted" test has its OWN inline fake at 300-305 that answers `view`/`create` — it needs the same teaching).
- Floors: `test/suite-integrity.test.js:1970` (`publish-release.test.mjs`: 19) and `:1971` (run-and-publish: the number OPS-01 wrote).

**Exact change** (all in `tools/shows/publish-release.mjs` unless stated).
1. Add `export async function releaseState(tag, { exec = execFileP, repo = REPO_SLUG } = {})` → `{ state: "absent" | "draft" | "published", assetNames: string[] }`. It runs `gh release view <tag> --repo <repo> --json isDraft,assets --jq '{isDraft: .isDraft, assets: [.assets[].name]}'` and parses stdout as JSON (`isDraft: true` → `"draft"`, else `"published"`). On a thrown error whose `stderr || message` matches `/release not found|HTTP 404/i` → `{ state: "absent", assetNames: [] }`; any other error → throw `new PublishError("RELEASE_CHECK_FAILED", ...)` exactly as `releaseExists` does today.
2. `releaseExists(tag, opts)` becomes `(await releaseState(tag, opts)).state === "published"`. A draft is "not yet there": the resume path below finishes it. Update its doc comment (lines 48-55) to say so.
3. Rewrite `publishRelease({ tag, title, notes, assets, exec = execFileP, repo = REPO_SLUG, chunkSize = 10, attempts = 3, sleep = defaultSleep })`, where `defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))`:
   - `assets` empty → throw `PublishError("NO_ASSETS", ...)` (unchanged, before any call).
   - `st = await releaseState(tag, { exec, repo })`. If `st.state === "published"` → return `{ tag, asset_base_url: assetBaseUrlFor(tag, repo), uploaded: 0, resumed: false }` without any other call.
   - If `st.state === "absent"`: `exec("gh", ["release", "create", tag, "--draft", "--repo", repo, "--title", title, "--notes", notes], { maxBuffer: 64 * 1024 * 1024 })` — no asset paths on this call.
   - `missing = assets.filter((p) => !st.assetNames.includes(basename(p)))` (`basename` from `node:path`).
   - For each chunk of `chunkSize` from `missing`, in order: `exec("gh", ["release", "upload", tag, ...chunk, "--repo", repo, "--clobber"], { maxBuffer: 64 * 1024 * 1024 })`; on a throw, retry the same chunk after `await sleep(attemptIndex * 5000)` (attemptIndex 1-based, so 5 s then 10 s), up to `attempts` total tries; after the last failure rethrow the error unchanged.
   - `exec("gh", ["release", "edit", tag, "--draft=false", "--repo", repo])`.
   - Return `{ tag, asset_base_url: assetBaseUrlFor(tag, repo), uploaded: missing.length, resumed: st.state === "draft" }`.
4. `publishShardReleases` and `run-and-publish.mjs` keep calling `releaseExists` first; no signature change for them. Because `releaseExists` is now false for a draft, the existing "already exists → SKIP" branches skip only published releases, and `publishRelease` resumes drafts.
5. Replace the doc comment at lines 104-118 with one describing the new shape (draft → chunks → publish) and why (2026-09-20 run: one 100-asset call failed with nothing on stderr; a draft with partial assets is resumable, a failed monolithic create is not). Keep the sentence about the per-release 1,000-asset ceiling (PR #718's lesson): chunking uploads against ONE tag does not change how many assets that tag holds; `MAX_SHARD_ASSETS_PER_RELEASE` still bounds it.

**Tests — `tools/shows/publish-release.test.mjs`.**
Rewrite these three existing tests in place (they break on the new call shapes):
- Line 28 `releaseExists: true when gh release view succeeds` — the fake returns `{ stdout: JSON.stringify({ isDraft: false, assets: ["manifest.json"] }) }`; replace the `deepEqual` on `args` with: `args.slice(0, 3)` deep-equals `["release", "view", "shows-index-v1"]`, `args` includes `"--repo"`, `"org/repo"` and `"--json"`. Still asserts `true`.
- Line 181 `publishShardReleases: creates one release per batch and reports first/last key ranges` — the fake still throws `release not found` on `view` and returns `{ stdout: "created" }` otherwise; replace the single `createCall` assertion block (lines 207-211) with: the ordered list of `[args[0], args[1]]` pairs for the batch tag is `["release","view"]`, `["release","create"]`, `["release","upload"]`, `["release","edit"]` (3 assets < chunkSize 10 → one upload); the `create` call includes `"--draft"` and no arg ends with `.json.gz`; the `upload` call includes all three `join("/tmp/out", "shards", "<key>.json.gz")` paths; the `edit` call includes `"--draft=false"`. The first/last key/count assertions stay.
- Line 214 `publishShardReleases: an already-existing batch release is skipped, not re-uploaded` — the `view` fake returns `{ stdout: JSON.stringify({ isDraft: false, assets: ["aa.json.gz"] }) }`; the rest unchanged (`created.length === 0`).
Replace the test at line 83 (`calls gh release create once with every asset`) and add the rest:
- `publishRelease: creates a draft with no assets, uploads in chunks of chunkSize, then publishes` — fake `exec` records every `args`; `view` throws `not found`; 25 asset paths, `chunkSize: 10` → calls in order: `release view`, `release create ... --draft` (assert no arg ends with `.json.gz`), three `release upload` calls with 10/10/5 paths and `--clobber`, then `release edit <tag> --draft=false`. Mutation: drop `--draft` → red; upload everything in one call → red (count).
- `publishRelease: a stranded draft is resumed — only the missing assets are uploaded, then it is published` — fake `view` returns stdout `{"isDraft":true,"assets":["a.json.gz","b.json.gz"]}`; assets a,b,c → exactly one upload carrying only `c.json.gz`, no `create`, one `edit --draft=false`, result `resumed: true, uploaded: 1`. Mutation: ignore `assetNames` → red.
- `publishRelease: a published release is left alone` — `view` returns `isDraft:false` → only the `view` call; `uploaded: 0`.
- `publishRelease: an upload that fails twice and succeeds on the third try still publishes; with attempts 2 a third failure throws` — fake upload throws on the first two calls for chunk 1; `sleep` fake records `[5000, 10000]`; then a second scenario with `attempts: 2` and always-failing upload → rejects with the original error and `sleep` was called once. Mutation: no retry loop → red.
- `releaseExists: a draft is not an existing release` — `view` returns `isDraft:true` → `false`. Mutation: return `state !== "absent"` → red.
- Keep `publishRelease: refuses to publish with zero assets`. Floor at `:1970`: 19 → the true count (19 − 1 + 5 = 23 expected; write the printed number, at least 23).

**Tests — `tools/shows/run-and-publish.test.mjs`.** Teach `fakeGhRegistry` (lines 42-60) and the inline fake at 300-305 the new calls: `view` answers `{ stdout: JSON.stringify({ isDraft, assets }) }` from a `Map` tag → `{ draft, assets }` and throws `release not found` for an unknown tag; `create` stores `{ draft: args.includes("--draft"), assets: [] }` (the `created` set still records the tag once); `upload` appends the basenames of every arg ending `.json.gz` or `.json`; `edit` with `--draft=false` flips `draft`. Every existing test must pass unchanged (the acceptance test at line 63 still sees exactly one `create` per tag).

**Commands** (repo root): `node --experimental-sqlite --test tools/shows/publish-release.test.mjs` → all pass (≥ 23); `node --experimental-sqlite --test tools/shows/run-and-publish.test.mjs` → all pass (OPS-01's count); `node --test test/suite-integrity.test.js` → pass.

**Do not touch:** `.github/workflows/shows-import.yml`, `import-dump.mjs`, `config.mjs`, `api/`.

**Stop and escalate if:** `publishShardReleases` or `run-and-publish.mjs` would need a signature change; any test in `run-and-publish.test.mjs` other than the fakes needs an assertion changed; OPS-02 did not record the `--json isDraft,assets` check as `4`.

**Definition of done:** commands green; each mutation red; DRAFT PR `fix(shows-import): shard releases upload in chunks with retry and resume from a draft (OPS-03)`; body names the OPS-02 issue.

### OPS-04 — release.yml refuses a re-run (opus, XS)

**Executor:** opus — `.github/workflows/release.yml` is DENIED and this is the release path.

**Context.**
- `.github/workflows/release.yml` (read with `MSYS_NO_PATHCONV=1`): the header comment block, which at line 52 says `never a re-run — which is all release-trigger.yml ever does`; job `version` at 154 (ci-release-4 counts runs of the day — the wrap is fixed, PR #821; its bump refusal at 187 already says "re-run this workflow with bump=none", which is a fresh dispatch, not a re-run of the same attempt — keep that wording); job `ios` at 260 with its first step `- uses: actions/checkout@v4` at 268; job `android` at 295 with its checkout at 304.
- `tools/release/build-number.mjs` lines 1-30 (why the count, not `run_number`).
- `tools/mobile/release-workflow.test.mjs` lines 9-20 (loads `WF`; helpers `block`, `step`, `code` from `tools/mobile/workflow-yaml.mjs`); floor `test/suite-integrity.test.js:1815` = 38.
- `docs/release-reliability-plan.md` lines 196-207 (the collision) and line 296 (`lifetime \`run_number\` (§3's warning stands; the trigger simply never re-runs);`).

**Exact change.**
1. In `release.yml`, insert as the FIRST step of both the `ios` job and the `android` job (before `actions/checkout@v4`):
   ```yaml
   - name: A re-run replays attempt 1's build number; dispatch a fresh run instead
     if: github.run_attempt != '1'
     env:
       RUN_ATTEMPT: ${{ github.run_attempt }}
     run: |
       echo "::error::run attempt $RUN_ATTEMPT would ship the build number attempt 1 already used (the version job does not re-execute on a re-run). Dispatch a fresh run: gh workflow run release.yml --ref main -f bump=none"
       exit 1
   ```
2. Amend the header comment near line 52 to say the re-run is now refused in both platform jobs, and keep the "fresh dispatch" sentence.
3. `docs/release-reliability-plan.md` line 296: replace the clause about the lifetime `run_number` with a sentence saying the run-of-day count landed in PR #821 and a re-run is refused by the guard step in `ios`/`android` (this PR).
4. Test in `tools/mobile/release-workflow.test.mjs`: `ios and android refuse a re-run before spending a minute (the version job would replay attempt 1's build number)` — for each of `block(WF, "ios", 2)` and `block(WF, "android", 2)`: the first `- name:` step's text contains `if: github.run_attempt != '1'` and its `run:` contains `exit 1` and the string `gh workflow run release.yml`. Mutation: delete the step from one job → red. Floor 38 → 39.

**Commands:** `cd tools/mobile && npm ci && npm test -- release-workflow.test.mjs` → 39 pass; `cd ../.. && node --test test/suite-integrity.test.js`.

**Do not touch:** `tools/release/*`, `tools/mobile/release-ci.mjs`, the composite actions.

**Stop and escalate if:** `ios`/`android` no longer start with `actions/checkout@v4`; `release-trigger.yml` re-runs anything (it must not — `tools/release/watch-release.test.mjs` pins that).

**Definition of done:** DRAFT PR `fix(release): refuse a re-run, whose build number attempt 1 already used (OPS-04)`; it will carry `needs-founder`; the body quotes the plan's §3 warning.

### OPS-05 — #309: the row link is the PR page (opus, XS)

**Executor:** opus — `tools/ci/` is DENIED.

**Context.** `tools/ci/pr-triage.mjs:125-160` (`normalizePr`; line 150 is `url: raw.url ?? raw.html_url ?? "",`), the `gatherPrs` REST read (grep `pulls/`; the REST object's `url` is the API endpoint and `html_url` the page), `:597` (`renderWaitingBlock` builds `[#N](url)`); `tools/ci/pr-triage.test.mjs:114-126` (the existing REST-shape test asserts `p.url === "u"` from `html_url` only because `url` is absent); floor `test/suite-integrity.test.js:1245` = 120.

**Exact change.** Line 150 → `url: raw.html_url ?? raw.url ?? "",`. Nothing else.

**Test** (`tools/ci/pr-triage.test.mjs`): `the row link is the PR page, never the REST endpoint (#309)` — `normalizePr({ number: 288, url: "https://api.github.com/repos/o/r/pulls/288", html_url: "https://github.com/o/r/pull/288" }).url === "https://github.com/o/r/pull/288"`, and `normalizePr({ number: 1, url: "https://github.com/o/r/pull/1" }).url === "https://github.com/o/r/pull/1"` (the GraphQL shape has no `html_url`). Mutation that must go red: restore `raw.url ?? raw.html_url`. Floor 120 → 121.

**Commands:** `node --test tools/ci/pr-triage.test.mjs` → 121 pass; `node --test test/suite-integrity.test.js`.

**Do not touch:** any other file.

**Stop and escalate if:** line 150 differs from the quoted text.

**Definition of done:** DRAFT PR `fix(pr-triage): #309 founder-waiting rows link to the PR page`, branch `fix/pr-triage-309-312` (OPS-06 stacks on it), labelled by the sweep as `needs-founder`.

### OPS-06 — #312: conflicting founder-queue PRs are still visible (opus, S)

**Executor:** opus — `tools/ci/` is DENIED. Same branch as OPS-05, second commit.

**Context.** `tools/ci/pr-triage.mjs:530-573` (`planFounderQueue`: line 545 `const conflicting = pr.mergeable === "CONFLICTING" || pr.state === "dirty";`, line 546 `const wanted = decision.needsFounder && !conflicting;`), `:576` (`planTriage` returns `{actions, notes, queue}`), `:597` (`renderWaitingBlock(queue, {repo, queueLabel})`), `:909` (`const { actions, notes, queue } = planTriage(prs, {`), `:938` and `:947` (the two `renderWaitingBlock(queue, { repo: opts.repo })` call sites); tests: `tools/ci/pr-triage.test.mjs` (grep `planFounderQueue(` and `renderWaitingBlock(` for the fixtures built with the file's `pr()` helper).

**Exact change.**
1. `planFounderQueue` returns `{ queue, actions, blocked }`. `blocked` collects, for each non-draft PR based on `main` where `decision.needsFounder && conflicting`, the object `{ number, title, url, reason: decision.reason, code: decision.code }`, sorted by number. The queue/label behaviour is unchanged (a conflicting PR still leaves the queue and loses `needs-founder`).
2. `planTriage` passes `blocked` through: `return { actions, notes: m.notes, queue: q.queue, blocked: q.blocked }` (adapt to the actual local names at 576-590).
3. `renderWaitingBlock(queue, opts)` gains `opts.blocked = []`. After the table's closing lines (or after `**Nothing is waiting on a founder right now.**` when the queue is empty) and before `BLOCK_END`, when `blocked.length > 0` append: an empty line, `**${n} PR${n === 1 ? "" : "s"} would be waiting on you but conflict${n === 1 ? "s" : ""} with main first (label \`merge-conflict\`):**`, then one line per PR: `- ${link} ${cell(title)} — needs a rebase by whoever picks it up; the author was probably a session that has ended.` where `link` follows the table's rule (`[#N](url)` or `#N`). Output stays byte-stable for identical input (no timestamps).
4. Both call sites pass `blocked`: line 938 → `renderWaitingBlock(queue, { repo: opts.repo, blocked })` with `blocked` destructured at 909; line 947 → destructure `blocked` from `planFounderQueue` and pass it.

**Tests** (`tools/ci/pr-triage.test.mjs`):
- `a conflicting PR that needs a founder leaves the queue but is reported as blocked (#312)` — `planFounderQueue([pr({ files: [".github/workflows/ci.yml"], mergeable: "CONFLICTING" })])` → `queue.length === 0`, `blocked.length === 1`, `blocked[0].number` matches. Mutation: skip collecting `blocked` → red.
- `renderWaitingBlock lists blocked PRs under the table, with links` — `renderWaitingBlock([], { repo: "o/r", blocked: [{ number: 5, title: "T", url: "https://github.com/o/r/pull/5", reason: "R" }] })` contains `[#5](https://github.com/o/r/pull/5)` and the word `conflict`. Mutation: drop the rendering → red.
- `no blocked PRs renders exactly today's block` — `renderWaitingBlock(queue) === renderWaitingBlock(queue, { blocked: [] })` for the file's existing `renderWaitingBlock` fixture. Mutation: always print the header → red.
- Floor 121 → 124.

**Commands:** `node --test tools/ci/pr-triage.test.mjs` → 124 pass; `node --test test/suite-integrity.test.js`; `node tools/ci/pr-triage.mjs waiting --from <a prs.json you capture with gh api for one open PR> --print` renders without throwing.

**Do not touch:** `.github/workflows/pr-hygiene.yml`, `path-policy.mjs`.

**Stop and escalate if:** `planTriage`'s return shape is consumed by a caller not listed here (grep `planTriage(` — only the CLI at 909 may use it).

**Definition of done:** both commits on `fix/pr-triage-309-312`, one DRAFT PR titled `fix(pr-triage): #309 PR-page links, #312 conflicting PRs stay visible`, body says "closes #309, closes #312" and that `tools/ci/` needs a founder merge.

### OPS-07 — #129: the merge audit script (qwen, S)

**Executor:** qwen. New directory `tools/audit/` (does not exist at origin/main; `run-suites.mjs` discovers `tools/**` suites automatically).

**Context.**
- Issue #129 (the report's five bullets and the hard requirements: one evolving issue, loud failure).
- `tools/ci/path-policy.mjs:446` `export function pathProblem(file)` (returns a string reason for a governed path or null — read its body), `:650` `export function isFounderLogin(login, authors = AUTOMERGE_AUTHORS)`, `:377` `export const APPROVAL_LABEL = "founder-approved"`, `:507` `export function isFreezeActive(value)`. Import them; never edit that file.
- `test/suite-integrity.test.js` (`FLOORS` shape: `"path": N,` lines, optionally followed by a `//` comment); `tools/release/watch-release.mjs:118-160` for the "pure module + thin CLI, every constant explained" house style; `tools/refresh/watch-nightly.mjs` `renderReport` (grep it) for the markdown report style.

**Exact change.** Create `tools/audit/merge-audit.mjs` with:
1. `export function auditMergedPrs(prs, { since, until, pathProblemFn = pathProblem, founderFn = isFounderLogin, approvalLabel = APPROVAL_LABEL } = {})` → `{ rows, zeroReview, governed }`. Input `prs`: REST pull objects extended by the caller with `files: string[]` and `reviews: { state, user: { login } }[]`; the function ignores any PR whose `merged_at` is null or outside `[since, until)` (ISO strings, compared as Dates). For each kept PR, a row `{ number, title, url: pr.html_url ?? pr.url ?? "", author: pr.user?.login ?? "", mergedBy: pr.merged_by?.login ?? "", mergedAt, files: files.length, humanReviewed, governed: files.filter(f => pathProblemFn(f) != null) }` where `humanReviewed = reviews.some(r => r.state === "APPROVED") || (pr.labels ?? []).some(l => (l.name ?? l) === approvalLabel) || founderFn(mergedBy)`. `zeroReview = rows.filter(r => !r.humanReviewed).length`; `governed = rows.filter(r => r.governed.length).length`. Rows sorted by number.
2. `export function parseFloors(text)` → `Map<suite, number>` from every line matching `/^\s*"([^"]+)":\s*(\d+)\s*,/m` inside the `const FLOORS = {` … `};` block only (find the block by those two markers; throw if either is missing).
3. `export function floorDrops(beforeText, afterText)` → `[{ suite, before, after }]` for every suite whose floor fell or vanished (`after: null` when vanished), sorted by suite.
4. `export function renderReport({ since, until, audit, drops, freeze })` → markdown string: first line `## Weekly merge audit — ${since.slice(0,10)} → ${until.slice(0,10)}`; then `**${rows.length} PRs merged, ${zeroReview} with zero human review, ${governed} touching a governed path.**`; a table `| PR | title | author | merged by | files | human review | governed paths |` (one row per PR, `[#N](url)`, governed paths joined by `<br>` or `—`); a `### Floors` section listing drops as `- \`suite\`: before → after` or `- none lowered or removed`; a `### Kill switch` line: `AUTOMERGE_FREEZE is set ("<value>") — auto-merge is halted` when `isFreezeActive(freeze)`, else `AUTOMERGE_FREEZE is not set`; last line `_audit ok_`.
5. `export function renderFailure(err, { step })` → `## Weekly merge audit — FAILED` + `The audit did not run to completion at step \`${step}\`: ${first line of err.message}` + `A false all-clear is worse than no audit; treat this week as unaudited.`
6. CLI (`run(argv)` exported, executed when `import.meta.url` matches `process.argv[1]` as `tools/release/build-number.mjs` does): `node tools/audit/merge-audit.mjs --prs prs.json --floors-before before.js --floors-after after.js --since ISO --until ISO --freeze "<value>" --out body.md [--json]`. Reads the files, writes `body.md`, prints the headline line to stdout, exit 0. Any thrown error → writes `renderFailure(err, { step })` to `--out` (when given) and exits 1. `--json` additionally prints `{ rows, zeroReview, governed, drops }`.

**Tests** (`tools/audit/merge-audit.test.mjs`, inline fixtures, ≥ 11):
- `auditMergedPrs: a merged PR with an APPROVED review is human-reviewed` / `...with the founder-approved label` / `...merged by a founder login (isFounderLogin) counts` / `an unreviewed bot PR is zero-review` / `a PR touching .github/ is governed, one touching data/ is not` / `PRs outside the window or never merged are ignored`. Mutation for each: flip the relevant `||` term or the window comparison → its test red.
- `parseFloors: reads only the FLOORS block and every "path": N line in it` (fixture with a decoy `"x": 3,` outside the block) — mutation: parse the whole file → red.
- `floorDrops: reports a lowered floor and a removed suite, never a raised one`.
- `renderReport: the headline counts, the freeze line, and the trailing "audit ok"` (assert exact strings) and `renderFailure: says FAILED and names the step`.
- `CLI: writes body.md and exits 0; a missing input writes a FAILED body and exits 1` (spawn `process.execPath` in a tmp dir).
- Floor: add `"tools/audit/merge-audit.test.mjs": <the true count>,` (11 if exactly the above).

**Commands** (repo root): `node --test tools/audit/merge-audit.test.mjs` → all pass; `node --test test/suite-integrity.test.js` → pass (it fails until the floor line exists — that is the check working); `node tools/ci/run-suites.mjs --list | grep merge-audit` shows the suite.

**Do not touch:** `tools/ci/**`, `.github/**`, `docs/agents/**` (OPS-08 registers the runner).

**Stop and escalate if:** `pathProblem`, `isFounderLogin`, `APPROVAL_LABEL` or `isFreezeActive` are not exported with those names; `FLOORS` in `suite-integrity.test.js` is not a `"path": N,` list.

**Definition of done:** commands green; mutations red; DRAFT PR `feat(audit): the weekly merge audit as a keyless script (#129, OPS-07)`.

### OPS-08 — #129: the workflow and the registry row (opus, XS)

**Executor:** opus — `.github/workflows/` is DENIED; posts as `github-actions[bot]`. Needs founder Q1 = Action.

**Context.** `.github/workflows/release-watch.yml` lines 1-60 (keyless watchdog shape: `permissions: contents: read, issues: write`, the `retry`/`fetch` helpers, `gh api` gathers, `$GITHUB_STEP_SUMMARY`), `.github/workflows/nightly-watch.yml:13-16` (permissions), `docs/agents/runners.md:18-23` (the Live runners table; you ADD one row after line 23 and change no existing row — OPS-15 owns lines 21 and 23), OPS-07's CLI contract.

**Exact change.**
1. `.github/workflows/merge-audit.yml`: `on: schedule: - cron: "17 7 * * 1"` plus `workflow_dispatch: {}`; `permissions: contents: read, pull-requests: read, issues: write`; `concurrency: merge-audit`; one job on `ubuntu-latest`, `timeout-minutes: 15`, steps: checkout (`fetch-depth: 0`), setup-node 22, gather: `SINCE=$(date -u -d '7 days ago' +%FT%TZ)`, `UNTIL=$(date -u +%FT%TZ)`; `gh api --paginate "repos/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=100" --jq '[.[] | select(.merged_at != null and .merged_at >= "'"$SINCE"'")]'` concatenated into one array (parse per page as `pr-triage.mjs` does around its `--paginate` read), then for each number add `files` (`gh api --paginate repos/$REPO/pulls/N/files --jq '.[].filename'`) and `reviews` (`gh api --paginate repos/$REPO/pulls/N/reviews --jq '[.[] | {state, user: {login: .user.login}}]'`); `git show $(git rev-list -1 --before="$SINCE" origin/main):test/suite-integrity.test.js > before.js`; `cp test/suite-integrity.test.js after.js`; run `node tools/audit/merge-audit.mjs --prs prs.json --floors-before before.js --floors-after after.js --since "$SINCE" --until "$UNTIL" --freeze "${{ vars.AUTOMERGE_FREEZE }}" --out body.md`; post `gh issue comment 129 --repo "$REPO" --body-file body.md`; a final step `if: failure()` posts `gh issue comment 129 --body "Weekly merge audit FAILED before it could report — ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}. Treat this week as unaudited."` Every `gh` call goes through the `retry` helper copied from release-watch.yml.
2. `docs/agents/runners.md`: add ONE row after line 23: `| **merge-audit** | GitHub Actions (\`.github/workflows/merge-audit.yml\`) | Weekly, Monday 07:17 UTC | — (deterministic) | Actions minutes | workflow file → \`tools/audit/merge-audit.mjs\` | live — one comment per run on issue #129; a failed run comments too |`. Do NOT edit the `nightly-watch` row (line 23) or the `foray-nightly-enrich` row (line 21): OPS-15 owns both.
3. Add to `tools/audit/merge-audit.test.mjs` one workflow-shape test: `merge-audit.yml comments on issue 129 on success and on failure` — reads the yml text, asserts two `gh issue comment 129` occurrences and `if: failure()`. Floor +1.
4. Run the CLI locally once with a missing `--prs` file and paste its FAILED body into the PR to show the failure shape. After merge, dispatch once; the first comment on #129 is the dry run the issue asks for.

**Commands:** `node --test tools/audit/merge-audit.test.mjs`; after merge `gh workflow run merge-audit.yml --ref main` → a comment appears on #129 within 5 minutes.

**Do not touch:** `docs/agents/routine-invariants.md` (DENIED), the cloud routine roster, `docs/agents/runners.md` lines 21 and 23.

**Stop and escalate if:** Q1 is answered "routine" (then this task becomes a `docs/agents/runner-prompts/merge-audit.md` prompt plus routine creation, which is blocked on the environment_id problem — say so).

**Definition of done:** DRAFT PR `ci(audit): weekly merge audit comments on #129 (OPS-08)` carrying `needs-founder`; after merge, one real comment on #129; then close #129 with a link to it.

### OPS-09 — #255: an empty capture says "thin" (qwen, XS)

**Executor:** qwen.

**Context.** `tools/corpus/export-index.mjs:170-243` (`buildIndex` at 170; line 197 `status: ok ? "ingested" : r.http_status === null ? "unfetched" : "failed",`; line 214 `const ingested = sources.filter((s) => s.fetch.status === "ingested");`; `totals` with `ingested: ingested.length` at 235; `serializeIndex` at 245), `tools/corpus/export-index.test.mjs` (the `buildIndex` fixture — grep `buildIndex(` — copy its shape; the committed-index tests — grep `corpus-index.json`), `docs/research/corpus/corpus-index.json` (source 37: `estimated_tokens: 16`, `notes: "body-fallback; thin extraction (62 chars)"`; source 27: 186 tokens and a real abstract; the corpus median is 2912), `tools/corpus/package.json` (`"test": "node --experimental-sqlite --test"`), floor `test/suite-integrity.test.js:2074` = 24. The comment on #255 by the founder's account: the fix is a status word, not a manifest.

**Exact change.**
1. `export-index.mjs`: add `export const THIN_TOKEN_FLOOR = 100;` with a comment: 037 (16 tokens, a spinner) is thin; 027 (186, a paper abstract) is not; the floor sits between them and far under the 2,912 median. Line 197 becomes: `status: !ok ? (r.http_status === null ? "unfetched" : "failed") : (Number(r.token_count ?? 0) < THIN_TOKEN_FLOOR ? "thin" : "ingested"),` (use the row's actual token field name if it is not `token_count` — read lines 181-200 first).
2. `totals`: keep `ingested` = count of status `"ingested"`; add `thin` = count of `"thin"` immediately after `ingested`; every other key keeps its position (the committed JSON key order must match what `serializeIndex` emits — check `serializeIndex` at 245 and the `diffIndexAgainstDigests` test).
3. `docs/research/corpus/corpus-index.json`: source 37 `fetch.status` → `"thin"`; `totals.ingested` 54 → 53; insert `"thin": 1` after `"ingested"`. Nothing else in the file changes (not `generated_at`).
4. `tools/corpus/README.md` (grep the sentence about the index carrying fetch status): add one sentence listing the vocabulary `ingested | thin | failed | unfetched` and the floor.

**Tests** (`tools/corpus/export-index.test.mjs`):
- `buildIndex: a capture under THIN_TOKEN_FLOOR tokens is "thin", not "ingested" (#255)` — the existing `buildIndex` fixture with the token field at `16` → `"thin"`, with `186` → `"ingested"`, and `totals.thin === 1`. Mutation: revert line 197 → red.
- `committed index: no "ingested" source sits under the thin floor, and the totals agree` — read the JSON; for every source: status `ingested` ⇒ `estimated_tokens >= THIN_TOKEN_FLOOR`, status `thin` ⇒ `< THIN_TOKEN_FLOOR`; `totals.ingested` and `totals.thin` equal the counts. Mutation: revert the JSON edit → red.
- Floor 24 → 26.

**Commands:** `cd tools/corpus && npm ci && npm test -- export-index.test.mjs` → 26 pass; `cd ../.. && node --test test/suite-integrity.test.js`.

**Do not touch:** `docs/research/corpus/digests.md`, `data-local/`, any other `tools/corpus/*.mjs`.

**Stop and escalate if:** the committed-index tests fail after the JSON edit for a reason other than the two counts (then `serializeIndex` orders keys differently — report, do not guess); the fixture's token field is neither `token_count` nor `estimated_tokens`.

**Definition of done:** commands green; mutations red; DRAFT PR `fix(corpus): an empty capture is "thin", not "ingested" (#255, OPS-09)`; body says "closes #255" and quotes the founder comment's one-word-fix line.

### OPS-10 — races-3 waits on state, not on 5 ms (qwen, XS)

**Executor:** qwen. PR #835 is on `main` (`9442bba7`), so nothing is pending; the races-4 4 s wall clock the previous revision targeted was already removed there (`test/boot-path.test.js:364-371` now holds the ceiling timer and fires it by hand — "NO WALL CLOCK (audit round 3, tests-11)"). What remains is one fixed sleep in `test/create-page.test.js`.

**Context (anchor by TEXT, not by line).**
- `test/create-page.test.js`: the function `function holdSearchData(m) {` (at 480 today) whose last line is `return () => { release(); return new Promise((r) => setTimeout(r, 5)); };`; the three races-3 tests that follow it (each carries a `MUTATION:` comment that must still go red); the harness's `evalIn` (the first races-3 test already reads `m.evalIn("createBuildPending")` at 509); the ctx `setTimeout` wrapper at 241.
- `app.js`: `let createBuildPending = false;` (11850) and its single reset `createBuildPending = false;` (11912) — the flag the build clears when it finishes.
- `test/boot-path.test.js`: `settle`/`sleep` at 48-49; the perf-3 test at ~533-556 uses `t.mock.timers` — read it only to recognise that pattern; do not touch this file except as step 3 says (which is: not at all).

**Exact change.**
1. In `holdSearchData`, replace the returned arrow with:
   ```js
   return async () => {
     release();
     let settled = false;
     for (let i = 0; i < 5000; i++) {
       await new Promise((r) => setImmediate(r));
       if (m.evalIn("createBuildPending") === false) { settled = true; break; }
     }
     if (!settled) throw new Error("the build never settled: createBuildPending stayed true after 5000 ticks");
     for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
   };
   ```
   (The trailing 20 ticks let the paint that follows the flag land.)
2. Do not change any assertion, any `MUTATION:` comment, or `app.js`.
3. Run `grep -n 'await sleep(' test/boot-path.test.js test/create-page.test.js`. Do NOT convert anything. List every hit with its enclosing test name in the PR body. If any hit lies outside a test whose name starts with `perf-3`, stop and escalate (report the test name); otherwise proceed.

**Tests to add:** none new; the proof is the mutation round: for each of the three races-3 tests, apply its `MUTATION:` comment to `app.js` in the worktree, run `node --test test/create-page.test.js`, confirm exactly that test is red, revert. Record the three results in the PR body.

**Commands** (repo root):
- `node --test test/create-page.test.js` → green.
- Stability: `for i in $(seq 1 20); do node --test test/create-page.test.js > /dev/null || { echo FAIL $i; break; }; done` → no FAIL.
- Under load: start `node -e "setInterval(() => { const t = Date.now(); while (Date.now() - t < 60); }, 70)" &` (a CPU hog, not a test process), run the suite once, kill the hog → green.
- `node --test test/suite-integrity.test.js` (floors unchanged).

**Do not touch:** `app.js`, `search-engine.js`, `test/boot-path.test.js`, `test/load-states.test.js`, `test/offline-search.test.js`.

**Stop and escalate if:** any of these strings is absent from `test/create-page.test.js`: `function holdSearchData(m) {`, `setTimeout(r, 5)`, `m.evalIn("createBuildPending")`; any test throws `the build never settled` — do NOT raise the tick count and do NOT add a sleep; report which test; a mutation does not go red (then the test was vacuous before you — report, do not "fix" the assertion).

**Definition of done:** 20/20 and the load run green; three mutations red; the grep listing in the PR body; DRAFT PR `test: races-3 waits on createBuildPending, not the clock (OPS-10)`.

### OPS-11 — ArtworkCache: the deadline is injected (opus, S)

**Executor:** opus — Swift, verified only by the `ios-kit` job (`.github/workflows/ci.yml:146`, `xcodebuild test` at 229, on an iPhone simulator); no Mac here.

**Context.** `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/ArtworkCache.swift:54-82` (`typealias Fetcher` at 56, `static let timeoutSec: Double = 10` at 61, `private let timeoutSec` at 68, `init(timeoutSec: Double = ArtworkCache.timeoutSec, ...` at 79) and line 136 `DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSec) { finish(nil) }`; `.../Tests/ForayAudioPluginTests/Engine/NowPlayingPublisherTests.swift:61` (`func waitUntil(_ what: String, timeout: Double = 5, ...)` polls main every 20 ms up to 5 s) and `:198-226` (`testAnArtworkTimeoutDropsTheKey`: `ArtworkCache(timeoutSec: 0.2, fetcher:` at 201, `waitUntil("the deadline passes")` at 219 — a real 0.2 s wait that a stalled simulator turns into a 5 s failure). Every construction uses labelled arguments (`NowPlayingPublisher.swift:51` `ArtworkCache()`, tests at 172 and 201), so a new defaulted parameter breaks nothing. `TwoDeckPrerollTests.swift` also uses `asyncAfter`, but that is a measured click-track delay — out of scope.

**Exact change.**
1. `ArtworkCache.swift`: add `typealias Deadline = (_ seconds: Double, _ fire: @escaping () -> Void) -> Void` and `static func mainDeadline(_ seconds: Double, _ fire: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: fire) }`; store `private let deadline: Deadline`; add `deadline: @escaping Deadline = ArtworkCache.mainDeadline` as the LAST `init` parameter; line 136 → `deadline(timeoutSec) { finish(nil) }`. No behaviour change for production callers.
2. `testAnArtworkTimeoutDropsTheKey`: build the cache with `timeoutSec: 10` and `deadline: { _, fire in deadlines.append(fire) }` (`var deadlines: [() -> Void] = []`). Keep the first `waitUntil("our icon lands")` (bundle read hops queues; a positive wait with a 5 s cap is fine). After the `publisher.write(... "B" ...)`: `XCTAssertTrue(cache.isLoading(show))`; `deadlines.last?()` (fires on the test's main thread; `finish` → `settle` run synchronously); then assert immediately `!cache.isLoading(show)`, the `.failed` lookup, nil artwork, and the rest unchanged. Remove `waitUntil("the deadline passes")`.
3. Update the `/// TO SEE IT FAIL:` comment: "never fire the injected deadline (or ignore it in `load`) — the load stays pending and `.failed` is never reached".

**Tests:** the rewritten test is the test. Mutation: make `load` ignore `deadline` and arm `asyncAfter` directly → the `isLoading` assertion stays true (the 10 s timeout never elapses inside the test) → red.

**Commands:** none local. Open the PR; the `ios-kit` check runs `xcodebuild test` for `ForayAudioPluginTests`; the PR is done only when it is green and the job log shows `testAnArtworkTimeoutDropsTheKey` passed in under 1 s (grep the log).

**Do not touch:** `NowPlayingPublisher.swift`, `MediaMapping`, anything under `foray-engine-core`.

**Stop and escalate if:** `ArtworkCache(` appears anywhere with positional arguments (grep — today there are none), or `ios-kit` does not run on the PR (a Swift path changed, so it must).

**Definition of done:** `ios-kit` green; DRAFT PR `test(ios): the artwork deadline is injected, the timeout test fires it by hand (OPS-11)`.

### OPS-12 — `tools/dev/worktree-gc.mjs` (qwen, S)

**Executor:** qwen. Pure classification + a CLI that is dry-run by default, with BOTH `exec` and `fs` injected.

**Context.** The measured state on the workstation (2026-09-25): `git worktree list` has 261 entries — the main tree, 234 under `.claude/worktrees/`, ~26 under `%LOCALAPPDATA%/Temp/claude/.../scratchpad/wt-*` and 4 under `%TEMP%/wt*`; 246 carry a branch, 15 are detached HEADs; 208 branches have a MERGED PR, 1 a CLOSED-unmerged PR, 2 an OPEN PR, 35 no PR at all; only 6 branches are ancestors of `origin/main` because PRs squash-merge; 47 stray regular files sit directly in `.claude/worktrees/`. `.gitignore` ignores `.claude/worktrees/`. Patterns to copy: `tools/ci/pr-triage.mjs` (`gh api` via `spawnSync`, `gh.exe` on win32 — grep `defaultExec`), `tools/release/build-number.mjs:31-60` (CLI shape, `pathToFileURL` main guard).

**Exact change.** Create `tools/dev/worktree-gc.mjs`:
1. `export function parseWorktreeList(porcelainText)` → `[{ path, head, branch: string|null, detached: boolean, bare: boolean, prunable: boolean }]` from `git worktree list --porcelain` (records separated by blank lines; lines `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare`, `prunable <reason>`). Strip the `refs/heads/` prefix.
2. `export function classify(entries, { prsByBranch, statusByPath, existsByPath, ancestorByHead })` → `entries.map(e => ({ ...e, verdict, why }))` with verdicts, first match wins: `keep-main` (index 0); `prune` (`!existsByPath[path]` or `e.prunable`); `keep-dirty` (`statusByPath[path]` non-empty); `keep-open-pr` (any PR with `state === "OPEN"`); `remove` (branch set, some PR `state === "MERGED"`, tree clean); `keep-closed-pr` (only CLOSED PRs); `remove-detached` (`detached && ancestorByHead[head] === true`); `keep-detached`; `keep-no-pr` (branch with no PR). `why` is one sentence naming the PR number where one exists.
3. `export function plan(classified)` → `{ removeWorktrees: [paths], deleteBranches: [names], prune: boolean, counts: { verdict: n } }` — `deleteBranches` only for `remove` entries.
4. `export function strayFiles(dir, fs)` → the names of REGULAR files directly under `dir` (`fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile())`); never directories, never anything nested.
5. `export function run(argv, { exec = defaultExec, fs = nodeFs, cwd = process.cwd() } = {})` — CLI `node tools/dev/worktree-gc.mjs [--apply] [--json] [--repo owner/name]`. Gathers via `exec`: `git worktree list --porcelain`; ONE `gh pr list --repo <r> --state all --limit 1000 --json number,state,headRefName` grouped by `headRefName`; per entry `git -C <path> status --porcelain` (skip when `fs.existsSync(path)` is false) and, for detached heads, `git merge-base --is-ancestor <head> origin/main`. Prints a table sorted by verdict, then the counts, then (dry-run) `Nothing changed. Re-run with --apply to remove <n> worktrees, delete <m> branches, prune, and delete <k> stray files under .claude/worktrees/.` — the dry run calls NO mutating `exec` and NO `fs.unlinkSync`/`fs.rmSync`. With `--apply`: for each `remove`/`remove-detached` path run `git worktree remove <path>` (no `--force`; a failure is printed and skipped, never retried with force), then `git branch -D <name>` for `deleteBranches`, then `git worktree prune`, then `fs.unlinkSync(join(cwd, ".claude/worktrees", name))` for each name from `strayFiles` and print each name. Never touch `keep-*` entries.
6. Windows: `defaultExec` uses `spawnSync(process.platform === "win32" ? "gh.exe" : "gh", args)` and `spawnSync("git", args)`; never build shell strings.

**Tests** (`tools/dev/worktree-gc.test.mjs`, injected data only, no real git, no real fs writes — minimum 12):
- `parseWorktreeList: main, a branch worktree, a detached one and a prunable one` (porcelain fixture).
- `classify: main is kept whatever its state` / `a dirty tree is kept even with a merged PR` / `a merged, clean branch worktree is removed and its branch deleted` / `an open PR is kept` / `a closed-unmerged PR is kept` / `a branch with no PR is kept` / `a missing directory is pruned` / `a detached head that is an ancestor of origin/main is removed, otherwise kept`. Mutations: swap the order of the dirty check and the merged check → the dirty test goes red; drop the `existsByPath` check → the prune test goes red.
- `CLI dry-run runs no mutating git command and no fs.unlink/rm` — inject `exec` and a fake `fs`; assert no recorded exec call starts with `["worktree","remove"]`, `["branch","-D"]` or `["worktree","prune"]`, and the fake fs recorded zero `unlinkSync`/`rmSync` calls. Mutation: apply without the flag → red.
- `--apply removes only regular files directly under .claude/worktrees/, never a directory or a nested path` — fake fs whose `readdirSync` returns one file, one directory, and whose subdirectory holds another file → exactly one `unlinkSync` with the top-level file's path. Mutation: drop the `isFile()` check → red.
- Floor: add `"tools/dev/worktree-gc.test.mjs": <the true count>,` (12 if exactly the above).

**Commands:** `node --test tools/dev/worktree-gc.test.mjs`; `node --test test/suite-integrity.test.js`; `node tools/dev/worktree-gc.mjs` (dry-run on your own checkout: prints the table; exit 0; nothing changes).

**Do not touch:** `.claude/` contents, `tools/ci/`, any worktree.

**Stop and escalate if:** `gh pr list --limit 1000` is refused (then page with `gh api --paginate repos/<r>/pulls?state=all&per_page=100` and the `head.ref` field).

**Definition of done:** tests green; the dry-run prints on a real checkout; DRAFT PR `feat(dev): worktree-gc — remove only the worktrees whose PR merged (OPS-12)`.

### OPS-13 — run worktree-gc on the workstation (opus, XS)

**Executor:** opus — destructive on the founder's machine; needs Q4 and a session that runs there. **Context:** OPS-12's CLI; the counts above. **Steps:** after OPS-12 merges, in `C:/Users/wjduv/Desktop/Vibe Coding/foray` on `main`: `node tools/dev/worktree-gc.mjs > gc-dry.txt` and give the founder the counts (expected ≈ 208 remove, 4-30 prune, 35 keep-no-pr, 2 keep-open-pr, 1 keep-closed-pr, some keep-dirty, 47 stray files); on Q4 = yes, `node tools/dev/worktree-gc.mjs --apply > gc-apply.txt`; then `git worktree list | wc -l` (expect < 60) and `git branch | wc -l`. Paste both files' tails in the OPS-12 PR thread or the founder channel. Run this while no other agent session has a worktree open on the machine (it also frees disk and memory — the founder asked for less running in parallel). **Do not:** `--force`, `rm -rf`, or touch anything the tool listed as `keep-*`. **Stop if:** any `remove` fails with "contains modified or untracked files" — list them, do not force. **Done:** counts reported; the tool's own summary shows zero `keep-*` entries touched.

### OPS-14 — #760: `tools/refresh/nightly-runner.mjs` (qwen, S — code and tests only)

**Executor:** qwen. Gives the rig two commands and leaves it exactly one judgement step (authoring `edits.json`). This task touches ONLY `tools/refresh/nightly-runner.mjs`, `tools/refresh/nightly-runner.test.mjs` and the floor line; the prompt edit is OPS-17.

**Context.**
- `docs/agents/runner-prompts/foray-nightly.md` lines 20-78 (steps 1-3: fetch the digest from `origin/refresh-digest:resolved.json`, refuse if older than 12 h, empty → stop) and 135-175 (step 5 `node tools/refresh/merge.mjs`, step 6 `cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts`, step 7 branch, add exactly `data/discover.json data/item-tags.json`, commit `Nightly refresh: +N episodes (YYYY-MM-DD)`, push, `gh pr create`) — read, do not edit.
- `tools/refresh/merge.mjs:13-14, 51-52` (`RESOLVED_PATH`, `EDITS_PATH` env, defaults `data-local/resolved.json`, `data-local/edits.json`), `:158` (`MERGE: 0 items added (nothing to merge).`), `:169` (`ADDED ${added} items. built_at=…`).
- `tools/refresh/watch-nightly.mjs:139` (`export const DEFAULT_THRESHOLD_HOURS = 12`), `:149` `export function digestDate(generatedAt)` (import it — one date rule), `:395` `export function recoveryBranch(date)`.
- `tools/refresh/watch-nightly.test.mjs` for the fixture style; floor line `test/suite-integrity.test.js:1891` (`watch-nightly.test.mjs`: 71) — add the new line next to it.

**Exact change.** Create `tools/refresh/nightly-runner.mjs` exporting `fetchDigest`, `finish`, `run` (CLI with injected `exec`, `fs`, `now`):
1. `fetch-digest [--ref origin/refresh-digest] [--out data-local/resolved.json] [--max-age-hours 12]`: `git fetch origin refresh-digest`; `git show origin/refresh-digest:resolved.json` → write to `--out` (mkdir `data-local`); parse; `age = (now - Date(generated_at)) / 3.6e6`; print and exit: age > max → `DIGEST_STALE generated_at=<iso> age_h=<x.x>` exit 3; `resolved.length === 0` → `DIGEST_EMPTY date=<YYYY-MM-DD>` exit 4; else `DIGEST_OK date=<digestDate(generated_at)> resolved=<n> age_h=<x.x>` exit 0. Also print `CANDIDATES <n>` when a top-level `candidates` array is present (informational, step 3 of the prompt).
2. `finish --date YYYY-MM-DD [--suffix <s>] [--edits data-local/edits.json] [--trailer <line>]...`: refuse (exit 2, `EDITS_MISSING`) when the edits file is absent; run `node tools/refresh/merge.mjs` with `EDITS_PATH`/`RESOLVED_PATH` forwarded; non-zero → print its output, exit 5 `MERGE_FAILED`; parse `N` from `/^ADDED (\d+) items\./m` (a `MERGE: 0 items added` line → exit 4 `NOTHING_ADDED`, no git commands); run `npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts` with `cwd: backend` → non-zero exit 6 `TESTS_FAILED`; `git switch -c nightly/<date>[-<suffix>]`; `git add data/discover.json data/item-tags.json`; `git diff --cached --name-only` must equal exactly those two paths else exit 7 `UNEXPECTED_FILES <list>`; `git commit -m "Nightly refresh: +N episodes (<date>)"` plus one `--trailer <line>` per `--trailer` arg given; `git push -u origin HEAD`; `gh pr create --base main --title "Nightly refresh: +N episodes (<date>)" --body "Automated nightly content refresh. N new episodes from the refresh-digest of <date>. Copy rules + pool integrity green."`; print `PR_OPENED <url>` exit 0. Every git/gh/node call goes through the injected `exec` (default `spawnSync` with args arrays).

**Tests** (`tools/refresh/nightly-runner.test.mjs`, fake exec/fs, `now` pinned):
- `fetch-digest: a fresh digest prints DIGEST_OK with the digest's UTC date and exits 0` / `a digest older than 12 h exits 3 and writes nothing else` / `an empty resolved list exits 4`.
- `finish: merge, tests, branch, add, commit, push, pr — in that order, and the branch is named after the digest date, not today` (assert the exact ordered arg arrays; `now` is a different day than `--date`).
- `finish: a merge failure stops before any git command` / `a third staged file is refused (exit 7)` / `a missing edits.json is refused before merge`.
- `finish: the commit message counts what merge.mjs reported`. Mutation for each: reorder/omit the step → red.
- Floor: add `"tools/refresh/nightly-runner.test.mjs": <the true count>,` (8 if exactly the above).

**Commands:** `node --test tools/refresh/nightly-runner.test.mjs`; `node --test test/suite-integrity.test.js`; `node tools/refresh/nightly-runner.mjs fetch-digest --out "$TMP/x.json"` against the real branch → prints `DIGEST_STALE` (the 2026-09-14 digest is 11 days old) and exits 3 — that is the expected result today.

**Do not touch:** `tools/refresh/merge.mjs`, `scan.mjs`, `resolve.mjs`, `watch-nightly.mjs`, `.github/`, `docs/agents/**` (OPS-15 and OPS-17 own those).

**Stop and escalate if:** `digestDate` is not exported from `watch-nightly.mjs` with that signature; `merge.mjs` prints something other than `ADDED N items.` on success.

**Definition of done:** tests green; the real `fetch-digest` prints the stale verdict; DRAFT PR `feat(refresh): nightly-runner — the mechanical halves of the nightly as two commands (#760, OPS-14)`.

### OPS-15 — #760 docs: two runners.md rows, worded as pending (qwen, XS)

**Executor:** qwen. After OPS-14 merges. Nothing here presupposes Q2/Q3: the rows say the step is moving and to where the founder has not yet confirmed.

**Context.** `docs/agents/runners.md:21` (the `foray-nightly-enrich` row: Where `Claude Cloud routine`, Cadence `Daily ~11:40 UTC (≥2h after the Action)`, Model `Sonnet`, Billing `Wyatt's account`, Status begins `live — ...` followed by long historical notes), `:23` (the `nightly-watch` row, Status `**checker landed, workflow pending a founder merge** — \`.github/\` is governed (#290)` — stale: the workflow exists and runs daily); issue #760's text. OPS-08 adds a NEW row after 23 and does not touch these two; if OPS-08 merged first, the row numbers are unchanged for 21 and 23.

**Exact change.** (1) Row 21: Where → `moving off the Cloud routine to a dedicated runner per #760 (pending the founder's answers there); was a Claude Cloud routine on Wyatt's account, OFF since 2026-09-13 (HA #46)`; Cadence → `Daily, ≥2 h after nightly-refresh (06:40 UTC)`; Model → `the runner's (TBD, #760)`; Billing → `TBD (#760)`; Prompt / source → the existing path plus `; mechanical steps: \`tools/refresh/nightly-runner.mjs\` (fetch-digest, finish)`; Status → replace the leading word `live` with `off — not running anywhere until #760 closes` and keep every historical note that follows, verbatim. (2) Row 23 Status → `live (the workflow is merged and runs daily; red on purpose while HA #46 stands)`. No other row changes; do not touch `HUMAN-ACTIONS.md` (OPS-16). **Tests:** none new; `node --test test/human-actions-integrity.test.js` and `node --test test/suite-integrity.test.js` stay green. **Do not touch:** other rows, `routine-invariants.md`, `HUMAN-ACTIONS.md`, `runner-prompts/`. **Stop if:** line 21 or 23 no longer begins with the runner name quoted above. **Done:** DRAFT PR `docs(#760): the nightly's judgement step is moving off the Cloud routine (OPS-15)`.

### OPS-16 — #760 hand-off (opus, XS)

**Executor:** opus — credentials and a data-loss dispatch. Gated on Q2 and Q3 being answered and OPS-14, OPS-15, OPS-17 merged. **Steps:** (1) Comment on #760 with: the two commands from OPS-14 and the one judgement step (the prompt's step 4); the token scope from Q3 (default: fine-grained PAT, Contents: write, Pull requests: write, repo-scoped, 90-day expiry) and that it lives only on the runner; the schedule constraint (start ≥ 08:40 UTC; `fetch-digest` exits 3 if the Action has not run); the done criteria from the issue. (2) Rewrite `HUMAN-ACTIONS.md` #46 step 1 (line 15) to name the answered arrangement, e.g. "Nightly content resumes on <the runner Q3 named> (#760); nothing to switch on in your account." Keep the `<!-- ha filed=2026-09-13 kind=default -->` marker line (line 10) and the item number; `node --test test/human-actions-integrity.test.js` stays green. (3) Execute Q2: if "drop", `gh workflow run nightly-refresh.yml --ref main -f overwrite_unmerged_digest=true` and confirm the run's summary says the guard was bypassed; if "recover", leave a note that the first runner run uses `fetch-digest` then `finish --date 2026-09-14 --suffix recovery` after re-cutting per the prompt's step 2. (4) When the first `nightly/<date>` PR from the runner merges and `nightly-watch` is green that evening, close #46 (move it to `HUMAN-ACTIONS-DONE.md` per the file's convention) and #760. **Stop if:** Q2/Q3 are unanswered — do not dispatch with the overwrite flag on a default, and do not edit #46.

### OPS-17 — #760: the runner prompt calls the two commands (opus, XS)

**Executor:** opus — this file is the operating prompt a scheduled agent follows exactly; even with the text supplied, folding it in is prompt/ops judgement. After OPS-14 merges. The replacement text below is the contract; keep it verbatim except where a bracket says otherwise.

**Context.** `docs/agents/runner-prompts/foray-nightly.md`: header lines 1-9; step 1 at 22-27; step 2 at 29-75 (the guard at 31-42, the cron note 44-46, the two-way guard 48-52, the recovery paragraph 54-65, the branch-name rule 67-75); step 3 at 77-78 plus the S-11 candidates paragraph 80-89; step 4 at 91-133 (unchanged); step 5 at 135-151; step 6 at 153-157; step 7 at 159-175; Hard constraints 177-190; Notes 192-198 (198: "Version this prompt: if the steps change, bump and record it in `docs/agents/runners.md`"). `tools/refresh/nightly-runner.mjs` as merged by OPS-14 (its exit codes are the source of truth; if they differ from the numbers below, the prompt follows the code and you say so in the PR).

**Exact change.**
1. Header: after line 7 (`Be conservative — ...`) insert a blank line and: `Version 3 (2026-09-25): the mechanical halves are one command each, \`tools/refresh/nightly-runner.mjs\` (issue #760). Steps 1-3 and 5-7 call it; step 4, the judgement, is unchanged.`
2. Replace lines 22-78 (steps 1, 2 and the first two lines of step 3, up to and including `open a PR, do not commit.`) with exactly:
   ```
   1. **Sync.** Ensure you are on an up-to-date `main`.

   2. **Fetch the digest and check it is fresh — one command, before anything else:**
      ```sh
      node tools/refresh/nightly-runner.mjs fetch-digest
      ```
      It pulls `origin/refresh-digest:resolved.json` into `data-local/resolved.json`
      and prints one verdict line. Exit 0 with `DIGEST_OK date=<YYYY-MM-DD> ...`
      means continue; the `date` it prints is the digest's date and is the date
      you use in step 7. **Any other exit code: stop and open no PR.**
      - exit 3 `DIGEST_STALE` — the `nightly-refresh` Action has not published
        today, so the digest is yesterday's and every item in it is already in
        `discover.json`. Say so in your run output so a human notices.
      - exit 4 `DIGEST_EMPTY` — nothing resolved tonight. Stop.

      **If you were sent here to clear a red watchdog**, the digest is older than
      12 h and `fetch-digest` refuses it — correctly. Do not override it. Re-cut
      the digest instead, which is what recovered #290's lost day:
      ```sh
      rm -f data-local/refresh-state.json          # no seen-guid state: re-emit the window
      node tools/refresh/scan.mjs --window-hours 72
      node tools/refresh/resolve.mjs
      ```
      then continue from step 4, and in step 7 pass `--date <the stranded digest's
      date> --suffix recovery`. That branch name, `nightly/<digest date>-recovery`,
      is load bearing: the overwrite guard in `nightly-refresh.yml` clears itself
      only when a PR matching the stranded digest's date appears (#293 got this
      right as `nightly/2026-08-19-recovery`). The red run's own report prints the
      exact date and `--window-hours` to use; prefer those numbers.

   3. **If `fetch-digest` printed `CANDIDATES <n>`**, read on; otherwise go to step 4.
   ```
   Then keep lines 80-89 (the S-11 candidates paragraph) verbatim under step 3, and move the cron note (old lines 44-46) and the two-way-guard paragraph (old lines 48-52) verbatim into a `<details><summary>Why 12 hours, and why the guard points both ways</summary>` block at the end of step 2.
3. Replace lines 135-175 (steps 5, 6, 7) with exactly:
   ```
   5. **Merge, validate, and open the PR — one command** (committed machinery; do
      not edit it, just run it):
      ```sh
      node tools/refresh/nightly-runner.mjs finish --date <the DIGEST_OK date> \
        --trailer "Co-Authored-By: <the trailer your harness gives you>"
      ```
      For a recovery run add `--suffix recovery`. It runs `merge.mjs`, then
      `backend`'s `copyRules` + `poolIntegrity` tests, then creates
      `nightly/<date>`, stages exactly `data/discover.json` and
      `data/item-tags.json`, commits `Nightly refresh: +N episodes (<date>)`,
      pushes, and opens the PR. Exit 0 prints `PR_OPENED <url>`. On any other exit
      it has changed nothing you need to undo:
      - 5 `MERGE_FAILED` — a copy-rule or `topics` failure in `edits.json`. Nothing
        was written. A `not taxonomy node ids: "…"` line is a `topics` typo —
        correct the id against `data/taxonomy.json`, or delete the `topics` key to
        fall back to the show's label. Fix the hook, tags or `topics` (or drop the
        item) and re-run.
      - 6 `TESTS_FAILED` — fix or drop the offenders and re-run.
      - 4 `NOTHING_ADDED` — every item was already in the pool. Stop; no PR.
      - 7 `UNEXPECTED_FILES` — you are on an old checkout that still stamps
        `deploy-manifest.json` or `sw.js`. Stop and re-sync `main`.
      **Do NOT merge the PR yourself.** `automerge-nightly.yml` enables auto-merge
      on `nightly/*` PRs whose changed files are all on `ALLOWED_PREFIXES` — both
      of yours are — so it merges once the required checks (`backend`,
      `data-and-site`) pass; the deploys then build and stamp from `main`.

      <details><summary>What `finish` does, step by step (the old hand steps 5-7)</summary>

      [paste old lines 135-175 here verbatim]

      </details>
   ```
4. Hard constraints (177-190) and Notes (192-198) unchanged, except line 198 gains `Version 3 is recorded there by OPS-15/OPS-17 (#760).`
5. Sanity: every `nightly-runner.mjs` exit code named in the prompt must exist in the merged `tools/refresh/nightly-runner.mjs` (`grep -n "process.exit\|exit(" tools/refresh/nightly-runner.mjs`); the prompt follows the code.

**Tests:** none consume the prompt. Add one shape test to `tools/refresh/nightly-runner.test.mjs`: `the runner prompt calls fetch-digest and finish and names the digest-date rule` — reads `docs/agents/runner-prompts/foray-nightly.md`, asserts it contains `nightly-runner.mjs fetch-digest`, `nightly-runner.mjs finish --date`, `--suffix recovery`, and no longer contains `git switch -c "nightly/$(date -u +%F)"` outside a `<details>` block (assert the string's first index is after the first `<details>`). Floor +1.

**Commands:** `node --test tools/refresh/nightly-runner.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `tools/refresh/*.mjs` code, `docs/agents/runners.md` (OPS-15), `HUMAN-ACTIONS.md` (OPS-16), step 4 of the prompt.

**Stop and escalate if:** OPS-14's merged exit codes differ from 2/3/4/5/6/7 as listed (then align the prompt to the code and say so); the region boundaries quoted above no longer match the file.

**Definition of done:** the prompt reads as one contract with the two commands; the shape test passes; DRAFT PR `docs(#760): the nightly prompt calls nightly-runner for the mechanical steps (OPS-17)`.

## 4. Sequencing

**Concurrency cap (founder, 2026-09-25: "too much running in parallel, the computer is bogging down").** Run at most THREE qwen lanes at once on the workstation and ONE opus lane; opus lanes that only edit issues or dispatch workflows (OPS-02, OPS-13, OPS-16) run from any session. Each lane removes its worktree the moment its PR is open. OPS-13 itself frees the machine (261 worktrees → < 60), so pull it forward as soon as OPS-12 merges and Q4 is answered.

**Wave 1 (parallel, disjoint files), in this priority order for the three qwen slots:** OPS-01 (`tools/shows/run-and-publish.*`) → OPS-12 (`tools/dev/`) → OPS-14 (`tools/refresh/nightly-runner.*`) → OPS-10 (`test/create-page.test.js`) → OPS-09 (`tools/corpus/export-index.*`, the index JSON) → OPS-07 (`tools/audit/`). Opus slot, one at a time: OPS-05→OPS-06 (one branch, `tools/ci/pr-triage.*`), then OPS-04 (`release.yml`, `tools/mobile/release-workflow.test.mjs`, the plan doc), then OPS-11 (Swift; CI does the work, so it can overlap with an issue-only lane). Each code lane also adds or raises one line in `test/suite-integrity.test.js`; those conflicts are one-line and resolved by rebasing onto `main` in the order PRs merge.

**Wave 2:** OPS-02 after OPS-01 merges (dispatch + diagnose) → OPS-03 if so decided (`tools/shows/publish-release.*`, `run-and-publish.test.mjs` fakes). OPS-08 after OPS-07 and Q1 (adds one runners.md row only). OPS-13 after OPS-12 and Q4. OPS-15 and OPS-17 after OPS-14 (disjoint files: `runners.md` vs `runner-prompts/foray-nightly.md` + the runner test); OPS-16 after OPS-15, OPS-17, Q2, Q3.

**No outside waits remain:** PR #835 merged 2026-09-26T00:30Z; OPS-10 is a Wave-1 task.

**Founder merges needed (in this order of value):** OPS-04, OPS-05/06, OPS-08. Everything else auto-merges on green.
