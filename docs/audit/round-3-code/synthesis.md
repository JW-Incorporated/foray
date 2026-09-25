# 4a audit, round 3 (code audit): 174 confirmed findings, 13 causes, 8 lanes

Rounds 1 and 2 (`docs/audit/qa-synthesis.md`, `docs/audit/round-2/synthesis.md`) read the listener-facing app through QA and persona lenses. They found that "subtly off" meant **a correct fix written once, at the call site that hurt, and never promoted to the rule**. Round 3 is a code audit. It covers the whole repository, not just the app: `app.js`, `sw.js`, `player/`, `api/`, `search-engine.js`, `backend/src` (generation and the rest), the CI and release workflows, the native plugins, the data tools and the test suites themselves.

The headline is that the same shape runs through all of it. Two examples:
- `dateValue()` exists because a NaN comparator broke a sort, but `branchChain`, `passesFilters` and `sessionBuilder` still build their own dates.
- The show-search title rule was made Unicode-aware in round 2, but the topic tokenizer, `prettyTitle`, the D13 dedupe key, `normalizeTitle` and `search-probe` are still ASCII-only.

There are four copies of the `itunes:duration` parser and three entity decoders, one of which throws. The publish gate normalises quotes differently from the narration gate that already accepted them. Theme R3-F alone has 20 rows.

**Severity:** 8 high, 53 medium, 113 low. The eight highs are all "a correct thing happens to the wrong input":
- **`security-1`:** the hourly PR sweep will arm and merge a returning outsider's fork PR to `sw.js`/`app.js`, and the repo is public.
- **`ci-release-2`:** renaming a governed file (`CLAUDE.md`, `tools/ci/`) to an allowlisted path passes the path policy, because only `.filename` is read.
- **`player-core-1`:** ‹‹ after a failed load marks a half-heard Foray Played and restarts it.
- **`player-core-2`:** Pause during a narration bridge's load is ignored.
- **`player-core-3`:** a routine `AbortError` is treated as a fatal error that drops a skip into idle.
- **`player-rest-1`:** one hung IndexedDB transaction stalls the vault write of a refreshed auth token, which strands the listener's identity.
- **`gen-1`:** web-search replies are parsed from the preamble block, so the re-ask without the tool gets "verbatim" passages written from memory, and those are published as citations.
- **`mobile-native-1`:** after any skip away from a narration line on iOS, the next narration is silent.

---

## 1. ROOT-CAUSE THEMES

Each theme names one rule that, once promoted, retires the cluster. Round-1 and round-2 themes that continue are named where they do.

### R3-A. Async work that doesn't re-check who asked (13): round-1 B and round-2 B, a third time
This time the pattern is not in the page's render guards, which round 2 fixed, but one layer down:
- `trySyncEvents` starts a new sync per call, so the same rows are POSTed N times and a first launch can mint several anonymous accounts (`app-1-2`).
- `_playTransitionBridge` and `_speakNarration` resume after an await without checking `_loadSeq` (`player-core-2/4/9`).
- The TTS `finished` event carries no utterance identity, so a stale completion advances whichever line is current (`mobile-native-2`).
- `BudgetGuard` reads and records in two awaited steps (`backend-rest-13`).
- `HostGate` computes the same gap for two concurrent slots (`data-tools-10`).

**Rule:** after every await, compare a token captured before it. Anything that can be re-entered shares one in-flight promise or reserves its slot synchronously.

### R3-B. Transient failures treated as definitive (13)
- `sbAuth` returns null for both `invalid_grant` and a 503, so a hiccup signs the device up as a new user (`app-1-4`).
- The evidence prefetch memoises a 429 as an empty pack for the whole run (`gen-5`).
- An iTunes outage is scored as "no match" and the episode is marked seen forever (`data-tools-2`).
- A failed artwork fetch caches "no artwork" for the whole item (`mobile-native-6`).
- An IDB `close` is kept for the page's life (`player-rest-2`).
- `AbortError` is reported as fatal (`player-core-3`).

**Rule:** every failure is classified as definitive, transient or expected cancel, and only definitive failures are cached or acted on destructively.

### R3-C. Reads without a deadline over the body (13)
`fetch()` deadlines that stop at the headers (`app-2-5`, `data-tools-3`, `data-tools-5`, where a 120 s timer covers a 170 MB body), and IDB transactions with no timeout at all (`player-rest-1`). There are also `spawnSync` calls with no timeout or with the 1 MB default buffer (`backend-rest-20`, `gen-16`), CI jobs with no `timeout-minutes` (`tests-4`), and body reads with no byte cap (`data-tools-7`, `backend-rest-14`, `search-api-css-7`). `fetch-limits.mjs` was written to fix exactly this and has one caller.

**Rule:** every deadline covers the body and every read has a ceiling. Use the existing helpers.

### R3-D. Unbounded work (15)
- `cp_saved` stores full untrimmed publisher descriptions and is `JSON.parse`d once per rendered row (`app-1-8`), and four times a second from the player's navigation getters (`perf-3`).
- The Shows search paints about 2,500 rows on the first keystroke (`app-2-2`).
- `TtlCache` never evicts, and the show-scoped path is an unauthenticated request amplifier against podcast hosts (`search-api-css-4`, `-3`, `security-10`).
- The Foray page repaints at 4 Hz with the screen off (`perf-8`).

**Rule:** every cache has a bound, a parse is memoised on its raw string, and painted lists are capped.

### R3-E. Identity re-derived instead of carried (14)
- `sameEpisodeList` compares `id` on rows that only carry `guid`, so every same-length refresh counts as unchanged (`app-1-3`). The unit test passes because its fixture has a shape production never sends.
- Guid-less scoped-search rows all become `<show>--null` (`app-1-5`).
- Slot ids are re-slugified from reworded or duplicated titles (`gen-3`, `gen-4`).
- Tier-2 item ids collide after 60 slug chars (`gen-6`: 28 real collisions in 5,046 digests).
- Relay ids restart at `r0001`, so a stale reply answers a fresh prompt (`data-tools-1`).
- The sync cursor loses microseconds and re-applies the last event every run (`backend-rest-2`).
- The build number wraps from 99 to 1 on the same day (`ci-release-4`).

**Rule:** mint once from a stable key and carry it.

### R3-F. One normaliser per concept (20): round-1 C, still open
ASCII-only text normalisers (`app-1-14`, `search-api-css-6`, `backend-rest-22`, `arch-drift-3`, where three unrelated non-Latin shows collapse into one, and `arch-drift-6`). NaN-unsafe dates (`app-1-13`, `search-api-css-11`, `backend-rest-16`). Route producers that skip `encodeURIComponent` (`app-1-16`, `app-2-13`). Drifted copies of quotes, durations, clocks, the User-Agent and the jingle length (`arch-drift-2/4/5/10/14`).

**Rule:** delete the copy, import the helper, and pin any copy that must survive a runtime boundary.

### R3-G. Untrusted text reaches a throwing decoder or a prototype lookup (5)
- `&#99999999;` in a feed makes `String.fromCodePoint` throw, and the show page returns a 500 in production (`backend-rest-1`).
- `&constructor;` writes native function source into catalogue text (`backend-rest-11`).
- The topic query `constructor theory` throws in search (`search-api-css-2`).
- `&#0;` aborts a non-transactional ingest halfway through (`backend-rest-9`).

**Rule:** one never-throwing, range-checked decoder, and `Object.hasOwn` on every keyed lookup.

### R3-H. Gates that don't see the whole adversarial input; credentials open by default (15)
The merge automation checks files and labels but not the author (`security-1`), not both sides of a rename (`ci-release-2`), not truncation on the sweep path (`ci-release-7`), and not past 100 open PRs (`ci-release-17`).

Credentials and access are open by default:
- The signing secrets are repository-scoped, so the release guard is not a boundary (`ci-release-3`).
- `mobile/gradle/**` and the plugin manifests auto-merge and then run next to the keystore password (`ci-release-5`).
- `ci.yml` runs PR code with a write-all token (`security-3`).
- On Supabase, the public anon key can write the catalogue (`backend-rest-4`) and rewrite the append-only interest log (`backend-rest-5`).
- The localhost relay accepts cross-site POSTs (`security-8`).
- The `hold` label is applied in a second call after `gh pr create` (`backend-rest-6`).

**Rule:** evaluate the full input as an attacker would, and start from least privilege.

### R3-I. CI reads a different signal than production (7)
The api job runs `npm install` while Vercel runs `npm ci` (`ci-release-11`), and the iOS release path does the same (`ci-release-12`). `api/*.ts` is never type-checked (`arch-drift-12`). The release trigger treats advisory `ios-kit` failures as "main is red" (`ci-release-6`, 3 of the last 10 main runs). Concurrency groups drop runs (`ci-release-9`), and a cancelled run counts as coverage (`ci-release-10`).

**Rule:** CI installs, type-checks and judges exactly as the deploy does.

### R3-J. Writes onto an unsettled base, or partial runs that replace (9)
`app-1-1` is the important one, and it is an incomplete fix of round-2 races-4. A write made before IndexedDB hydration marks the key dirty, so hydration then *skips* the durable copy, and a returning listener's whole Saved list is lost to one star tap.

The same shape in the tools:
- `generate-forays` rewrites `report.json` from this run only (`backend-rest-7`).
- `warm --show X` replaces the corpus digest (`backend-rest-8`).
- `fetch-audio` checkpoints lack the fields resume checks (`data-tools-4`).
- `backfill-audio` writes one file before verifying the next (`data-tools-11`).

**Rule:** read-modify-write only on a settled base, merge on partial scope, and verify before the first write.

### R3-K. Transport verbs don't enforce their postcondition (9)
Round 2 hardened `pause()` for #689 but not `stop()` (`player-core-7`). `skipToPrevious(null)` from idle becomes `ended` (`player-core-1`). Foray "Next clip" steps over authored narration and can end the Foray early (`player-core-6`). iOS `speak()` queues behind a paused utterance (`mobile-native-1`). An ended Foray never releases the audio session (`mobile-native-4`). Chapter taps bypass `startEpisodePlay` (`app-2-4`). With continuous playback off, a finished episode stays in Up Next (`app-1-9`).

**Rule:** each verb asserts its end state and is tested from the absent-item case.

### R3-L. The service worker owns too much and pairs too little (6)
On the Vercel origin the worker intercepts `/api/*`, keys the cache without the query string, and serves another query's results on a slow call. Those responses also survive Delete my data (`app-3-2`). It deletes every cache it doesn't own, including the app's own shard cache (`app-3-4`), and strips `Range` from media requests (`app-3-7`). The #233 code/data pairing still breaks three ways (`app-3-5`, `perf-2`, `app-3-3`, where the 'one version behind' notice is shown to pages that are current).

**Rule:** the worker touches only its own paths and caches, and a page's code and data come from one generation.

### R3-M. Tests that cannot fail (10)
- The Playwright "new deploy" specs never install a second worker, because `sw.js` bytes never change (`tests-1`). Four specs pass whatever `sw.js` does.
- The timezone tests run in UTC, where local and UTC formatting are the same (`tests-5`).
- The gitignore guard probes with `.mp3`, which a global rule already ignores (`tests-8`).
- `expect(true).toBe(true)` placeholders count toward the suite floors (`tests-7`), and those floors have 194 tests of slack (`tests-6`).
- Three suites race product timers with fixed sleeps (`tests-2/3/11`).

**Rule:** assert the premise, drive the clock, and ratchet the floors.

---

## 2. FIX-FIRST SHORTLIST

Round 3 is a code audit, so this list is ranked by exposure and irreversibility, not by how often a listener feels it:

1. **`security-1` + `ci-release-2` + `security-3`**: public repo, auto-merge to production. A few lines in `pr-triage.mjs` and one `permissions:` block. Consider `AUTOMERGE_FREEZE` until they merge (founder Q2).
2. **`app-1-1`**: silent, permanent loss of a returning listener's library on the platform (Safari ITP) the durable store exists for.
3. **`player-rest-1` + `app-1-4` + `app-1-2`**: three separate ways a listener's anonymous identity gets split or orphaned. Delete my data can no longer reach the orphaned rows, which has a legal edge.
4. **`gen-1`**: fabricated "verbatim" citations in published Forays. This is a veracity defect, not a UX one.
5. **`backend-rest-4/5`**: public-key writes to the catalogue and the interest log, dormant until DB mode is on but one env var away.
6. **`mobile-native-1` + `player-core-1/2/3`**: silent narration, a pause that doesn't hold, a Foray wrongly marked Played. This is the car experience.
7. **`app-3-2`**: wrong search results on the production-preview origin, plus a privacy trace that survives deletion.
8. **`app-1-3`**: show pages that never show today's episode on a revisit.

---

## 3. FOUNDER QUESTIONS

Only product, spend, legal and credential calls. Everything else has a default in its lane brief.

- **Q1: Family Mode and unrated episodes** (`data-integrity-4`). Default: inherit the show rating, else hide.
- **Q2: admin and credentials.** A `release` environment for the 8 signing secrets plus a v* tag ruleset, a read-only default token with Actions PR-approval off, the fork-approval policy, and optionally `AUTOMERGE_FREEZE` now. Default: the code lands, and the environment PR is held until you create the environment.
- **Q3: apply the RLS migration to production Supabase, and edit two privacy-policy rows.** Default: the file lands and you apply it.
- **Q4: loosening the generation safety check for documentary framings** (`gen-9`). Default: no change.
- **Q5: should reconnecting a car resume audio?** (`player-core-10`). Default: delete the dead web branch and leave route policy to the native engine.

---

## 4. LANE PLAN: eight lanes by file ownership, every id in exactly one

| Lane | Owns | Ids | Merge path |
|---|---|---|---|
| **L1 app-data** | `app.js` ~1-2900, ~13600-15100, `init()` (not the pin block) | 21 | auto (app.js, test/) |
| **L2 app-surface** | `app.js` ~2900-13600 | 24 | auto |
| **L3 player + native TTS** | `player/*.js`, `mobile/plugins/foray-tts`, the session/artwork parts of `ForayAudioPlugin.swift`, `foray-vault` Android | 26 | auto (player/, mobile/), device checks after |
| **L4 web platform** | `sw.js`, `index.html`, `vercel.json`, `api/**`, `search-engine.js`, `styles.css`, the app.js pin block | 24 | split: sw/search/css auto; api + vercel.json human (unlisted) |
| **L5 generation** | `backend/src/generation/**`, `tools/generation/**`, events-server removal | 22 | **founder** (backend/src DENIED), at most 2 PRs |
| **L6 backend-rest** | `backend/src` non-generation, `backend/migrations/**` (new files only) | 22 | **founder**, at most 2 PRs |
| **L7 CI / release / security** | `.github/**`, `tools/ci/**`, `tools/release/**`, `suite-integrity` | 18 | **founder** (all DENIED) |
| **L8 data tools** | `tools/refresh`, `transcribe`, `corpus`, `segments`, `shows`, `classify`, `search-probe` | 17 | auto |

**Cross-lane edits that are allowed, and their owners:**
- L3 changes the jingle literal at `runPipeline.ts:504` (L5 leaves that line alone) and `fmtChapterTime` in `app.js`.
- L6 adds one `SB_USER_TABLES` entry in `app.js` (L1's region) and one assertion to `test/data-deletion.test.js`.
- L4 changes the pin block and the generation-changed handler in `app.js`, and one `mapLiveEpisode` fallback line that supports L2's `app-1-5`.
- L7 adds a `typecheck` key to `api/package.json`, after L4's test-glob change.
- L8 adds one entry to `test/show-search-fallthrough.test.js`'s file list; L2 changes only the sleeps in that file.

**Ordering constraints:**
- L7's security PR goes first.
- L6's `backend-rest-1` lands before L4's feed cache.
- L1's shared fake-DOM helper lands before L2's `tests-3`.
- L4's `tests-1` lands before any other `sw.js` fix, and `search-api-css-5` (move helpers into `_lib`) before the feed cache.
- L5's shared Anthropic-call helper goes before `gen-1`.
- `tests-6` (ratchet the floors) goes **last**, after every lane and after `engine/m1` merges.

**engine/m1 collision map.** The native-engine branch changes about 74k lines and is not yet merged. It overlaps this plan in:
- `player/`: `client.js` ~990 lines, `durable-store.js` ~450, `html-audio-backend.js` ~260, `queue-manager.js` ~95, `diagnostic-log.js`, `position-store.js`, `foray-progress.js`. It also ports `queue-state.js` to Swift, with parity fixtures.
- Outside `player/`: `app.js` ~475, `ci.yml` ~200, `release.yml`, `ios-build.yml`, `ForayAudioPlugin.swift` ~220, `ForayTtsPlugin.swift` ~30, `suite-integrity.test.js` ~260, `data-deletion.test.js`, `fetch-audio.test.mjs`.

L3's brief makes this binding: compare against `origin/engine/m1` before each edit, add guards only at existing lines, make one commit per id, and flag the `player-core-1` reducer change for the Swift port.

---

## 5. THE UNCERTAIN PILE

- **`app-3-7`** (Range stripped on same-origin media). The header drop is certain. Whether WebKit then refuses the jingle needs one iOS Safari check.
- **`search-api-css-5`** (helpers deployed as public functions). This is marked plausible and was not confirmed against a live deployment's function list. L4 verifies it in a preview deploy.
- **`player-core-5`** (the scrubber freezes if a drag returns to its start value). It depends on `change`-event semantics as WebKit and Chromium document them, and was not observed on a device.
- **The native findings** (`mobile-native-1..8`). They are read from Swift and Java against the platform documentation. `mobile-native-1` is the one to check on a phone first: skip away from a narration line, then listen for the next one.
- **`ci-release-9`**. It rests on GitHub's documented one-pending-run-per-group rule. Nobody reproduced a dropped run.

---

## 6. WHAT THIS AUDIT COULD NOT COVER

- **The `engine/m1` branch itself.** Round 3 audited `main`. The native engine branch is about 74k lines of Swift, a JS contract, parity fixtures and CI, and it rewrites much of `player/`. None of it was audited here. Several `player/` findings may already be fixed there, or may be made worse by it, and a separate pass is owed before it merges.
- **The device, still.** No finding in the player, native, service-worker-on-Safari or audio-session areas was observed on hardware. That covers lock screen, CarPlay, Android Auto, Bluetooth routes, WKWebView's IDB process loss and iOS TTS queueing.
- **Production state.** Which Supabase migrations are actually applied, whether RLS is on in the live project, whether DB mode is ever enabled, what Vercel's live function list contains, and which secrets exist where. All of it was reasoned from the repo and `gh` metadata, not inspected in the dashboards.
- **The live network.** Feed parse behaviour across real publishers, Apple rate limits, Vercel cold-start latency against the service worker's 6 s timeout, and the real cost of the show-scoped amplifier. None of it was measured under load.
- **The generation output.** `gen-1` says published citations can be fabricated, but this audit did not re-verify the citations in shipped Forays. Someone should re-check the existing published Forays' `print` cites against their URLs.
- **Spend.** Anthropic token undercounting (`gen-14`), Vercel function minutes (`search-api-css-5`, `-3`) and macOS CI minutes (`tests-4`) are named but not costed.
- **The legal text against the law.** Round 3 found two more places where the privacy policy and the code disagree (`data-integrity-8`, `-10`). Whether the reconciled text is adequate is not an audit call.
- **The audio and the assistive tech.** These are unchanged from rounds 1 and 2: whether narration sounds right, and whether VoiceOver and TalkBack users can drive the app. Code reading reaches neither.
- **Whether the fixes will hold.** R3-M is the reason this is still open. Four service-worker specs, the timezone tests and the gitignore guard could not fail. Every lane brief names the test that must land with each fix, and `tests-6` ratchets the floors after the merge wave so they cannot drift again.
