# Package CH — code health from the DHH-style review (duplicate, dead and inconsistent code that causes corner-case bugs) — revision 1

Written 2026-10-05 against `origin/main` @ `cd410d29`. Every path, function, line and count below was verified at that commit by a second agent (the verifier pass; see §0) and the amendments in §0.3 were re-checked against the tree before this file was written. Line numbers are anchors at `cd410d29`; if a cited function is not within ±40 lines, `git grep -n "function <name>"` and continue — only stop if the symbol does not exist.

## 0. Why, method, and what changed in scoping

**Founder request (Wyatt, 2026-10-05).** Review the app code base the way DHH would: find duplicate code, unused code and the inconsistencies between copies that cause corner-case bugs; turn the findings into scoped work on the roadmap; then execute it.

**Method.**
1. **Seven Fable reviewers, one area each:** A1 (`app.js` lines 1–~3600: storage, interests, taxonomy, playlists, queue), A2 (`app.js` ~3600–~13600: Home, rows, search, Library, Up Next), A3 (`app.js` ~13600–end: Foray page, drawer, routing, boot), P1 (`player/` core: client, queue-manager, queue-state, html-audio-backend), P2 (`player/` modules: downloads, bookmarks, progress, gestures, telemetry), N1 (`mobile/`, `.github/`, native plugins), X1 (cross-cutting: sw.js, search-engine.js, api/, styles, constants shared across files). Each reviewer filed issues with id, category (duplicate / dead-code / inconsistency / duplicated-state / stale-comment / drift-risk / needless-complexity / corner-case-bug), severity, locations, evidence, a failure scenario and a fix.
2. **Separate Fable verifiers** reproduced every claim from the source (`git grep`, `node -e` over the data files, reading both sides of each duplicate). Each issue carries a verdict: `confirmed` (every claim held) or `adjusted` (a claim was wrong or overstated; the record says which and the severity was moved). Issues the verifiers refuted outright were dropped before scoping. **116 issues survived**: A1 19, A2 19, A3 16, P1 14, P2 19, N1 9, X1 20. By severity: 5 high, 33 medium, 78 low. The full list is Appendix A.
3. **A Fable scoper** grouped the 116 into cards — one agent, one PR each — ordered into waves so that no two cards in a wave touch the same file except the two permitted `app.js` / `player/client.js` slots per wave, which must edit named, disjoint functions. Every card opens with characterization tests that pin today's behaviour before anything moves, then adds tests whose named mutation goes red. Native (Swift/Java) touches are comment-only or mirrored with a parity fixture re-record, and compile only in CI. Four issues were deferred as founder/product rulings rather than engineering (§5).
4. **A Fable critic** read the scoping against the code and returned 22 amendments (a wave-order violation, a file collision, a cache-name bump that would orphan a bucket on every device, a missing Java reducer mirror, an oversized card, a disguised behaviour change, a hook placed where a missing file would be stamped as played, and fifteen smaller corrections). **All 22 were checked against `cd410d29` and accepted; none were rejected.** They are listed in §0.3 so a reader can see what moved and why.

**Result: 43 cards in 8 waves** (the scoper's 41, plus CH-09 split into CH-09a/CH-09b and CH-11 split into CH-11/CH-11b), 17 opus and 26 qwen, and 4 deferred rulings.

### 0.1 What this package deletes

`player/queue-strategy.js` and its modulepreload; the Kokoro weights from every shell build (~400 MB per IPA, 86 MB per APK; the probe code itself is deferred N1-02); four dead `ForayPlayer` members (`cycleRate`, `stripModel`, `stripSummary`, `lastVoiceFallback()`); the web `setVolume`/`carry-volume` body; `savePlaylists` and the two Apple ids whitelisted into every stored playlist part; `leafNodes`, `boostTopics`, the unreachable snapshot fallback in `paintEpisodeSearchResults`; `canSeekExactly`/`canPlaySegment`/`renderStrip` and two unreachable "finished" branches; two orphan search-engine exports; the pre-S-04c shard-cache branch; one duplicate CSS block; and roughly forty stale sentences that describe behaviour the code no longer has.

### 0.2 What this package fixes that a listener can see

- **CH-01** (A1-01, high): Up Next accepts pool rows with no `audio_url`; the walk then skips them (queue says N, N−1 play).
- **CH-03** (P1-01, high): tapping a timestamp in Episode notes pauses audio in the documented #689 drift, because `ForayPlayer.isPlaying(id)` and `togglePlayback()` read different authorities.
- **CH-02** (P2-01, high): download eviction is documented as least-recently-*played* but nothing ever records a play, so the file you listen to daily is evicted first.
- **CH-09b** (P2-02, high): bookmarks are write-only — the sheet says "Bookmarked." for something no page shows, and the privacy policy already claims a list on the episode page (PQ-15 never landed).
- **CH-32** (A2-03/A2-04/A2-08): the Home stretch card says its reason twice; "3 of 12 played" on Home vs "1 played" on the playlist page; Home and `#/forays` disagree about Jump back in.
- **CH-33** (A2-05): on a DAI show the same chapter stamps read "~68 min / approximate" in Chapters and "1:08:12" exactly in Episode notes.
- **CH-35** (A2-18): a playlist's "· played yesterday" suffix appears on `#/playlists` and not in Search, which says it matches that page.

### 0.3 Critic amendments applied (all 22; none rejected)

1. **Wave order.** CH-39 (wave 7) depended on CH-38 (wave 7). CH-39 moves to wave 8 (app.js only; CH-41 stays the sole `player/` card there).
2. **Wave-6 collision.** CH-35 edited `app.js` 8552–8554 inside CH-36's 8534–8580 shard-cache region. A2-17 (the `isOfflineForShardSearch` rename and its 10386 call site) moves into CH-36; CH-35 keeps 9873–13213.
3. **No `SHARD_CACHE_NAME` bump.** `sw.js:352–363` refuses to delete caches it does not own and names `foray-shows-index-v1` as the example; `deleteMyData` (app.js 16831) deletes only the current name. A bump would orphan the v1 bucket on every device forever. CH-36 deletes the bare-array branch so a bare array falls to `return null` (miss → refetch → rewritten: same network cost, same self-heal) and keeps `-v1`.
4. **CH-11 missed the Java mirror.** `player/parity/jvm-pending.json` lists `queue-state` under `runs`, so the Android ParitySuite executes every fixture case, and `PlayerQueueStateMachine.java:92` carries the same `kind == TTS ? RESET_RATE_FOR_TTS : RESTORE_RATE` rule; `PlayerItemKind.java` has only `EPISODE` and `TTS`. The reducer change is split out as **CH-11b** (wave 3) with the Swift AND Java ports plus the fixture; CH-11 keeps the pure-JS strip/media-session classification. Also corrected: `TTS` is exported from `player/queue-state.js:73` and `JINGLE` from `player/foray-queue.js:76` (not foray-structure.js), and `queue-state.js` must not import `item-kind.js` (cycle).
5. **CH-09 split.** `client.js:171` already publishes the whole bookmarks module as `window.forayBookmarks` (`bookmarkLabel`/`bookmarkPrecision` are exported at bookmarks.js 179/170), and the sheet button already routes through `EPISODE_NAVIGATION.addBookmark`, so no client.js edit is needed. **CH-09a** (wave 2) = the two durability fixes; **CH-09b** (wave 8) = the PQ-15 surface, `listener_visible: true`, following `docs/roadmap/player-features.md:306–310` ("Do not touch: client.js, seek-policy").
6. **CH-38 (a) was a behaviour change.** `firstRunParked` (7751) and `introParked` (8076) are independent today. The shared builder keeps per-sheet parked state (a Set keyed by sheet id) so both flows are preserved; a characterization test parks the explainer and asserts the intro popup still opens.
7. **CH-14: no `claimsTouch` rename.** queue-drag's is called from app.js at 7577, 12382, 12426, 12437 via `window.forayQueueDrag`; sheet-drag-dismiss's is imported by client.js:122 and re-exposed at 5116. Both names stay; each header gets one sentence saying they are per-gesture "does this finger belong to me" predicates with different inputs.
8. **CH-30 parity books.** `player/parity/exclusions.json` 750–770 has four entries whose `why` cites queue-strategy.js and names queue-manager tests CH-30 rewrites; `player/parity/coverage.test.js` (floor 37) checks every excluded test exists. Added to the card with `node --test player/parity/coverage.test.js` and `--check` required green.
9. **CH-07 also derives `tools/web/prepare-dist.mjs`'s `playerSources`** (93–99, a second directory walk deciding what Vercel's dist contains) from the same import closure exported from generate-manifest.mjs (prepare-dist.mjs:26 already imports from it). `tools/mobile/prepare-webdir.mjs:510–513` ("every non-test .js is the whole graph") must be reworded. The `route-resume` parity family keeps reading `player/route-resume.js` from disk and is unaffected.
10. **CH-02 (b): the `markPlayed` hook fires where the local load succeeds**, not inside the pure mapper `localSourceFor` (client.js 4346). Its caller opens a `localAttempt` ticket (4513) whose missing-file path retries the stream; stamping inside the mapper would mark an evicted file as played — the LRU lie the card fixes. Fire where the ticket is cleared on success (4549). Test: a local file whose load fails and falls back to the stream does NOT move `last_played_at`.
11. **CH-06 does not edit `docs/roadmap/player-features.md`** (CH-02 in the same wave does). Its follow-up sentence (an optional downloads parity family) goes in CH-12, which already owns that file.
12. **CH-32 shrinks.** `renderHomeV2` is not renamed (11 test files for a stale comment). The alias stays with a one-sentence comment; the 10 test files listed only for the rename are dropped.
13. **CH-35 (b) keeps `isCurrent`.** `isCurrent` (ForayPlayer.isCurrent) and `cur` (currentPlayingId) can differ while the app's pointer lags. Rule: `!playable || isCurrent || !rules || rules.playNextOrder(ids, id, cur) === ids`; the table test includes `isCurrent && id !== cur`.
14. **CH-36 (a)/(b): a pin test unless every harness loads search-engine.js.** 38 app.js tests run without `SearchEngine`. No `typeof SearchEngine !== "undefined" ? … : localCopy` fallbacks (they recreate the duplicate). If the harnesses cannot all load search-engine.js cheaply, keep `branchOf`/`normaliseShowTitle` and pin them equal to the engine's.
15. **CH-33 (c)** exposes `CALL_TIMEOUT_MS`/`shellUserAgent()` from inside `createId3Reader`'s returned object (client.js:191 publishes it), so client.js is not edited; the 8 s → 10 s device-chapter deadline is the listener-visible timing change and is stated.
16. **CH-24** adds `node tools/parity/record.mjs --check` (the `foray-clock` family exercises `fmtSpan`).
17. **CH-34 (e)**: the carry-volume step is recorded in `player/parity/fixtures/deck/deck-pair.json` (the `deck` family, not deck-episode). Web handler becomes a no-op; no re-record.
18. **CH-15**: the Swift file is `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift` (no `Policy/`); anchors 193/236/246 hold.
19. **CH-21**: `SETTLE_NEAR_SEC` is 1 (deck-policy.js:203), identical to `load()`'s inline `> 1` (1728), so the canplay swap is exactly behaviour-preserving; only the seeked arm tightens. `player/parity/reference-engine.js` imports only `PREFETCH_LEAD_SEC` from the backend, so no fixture should move.
20. **CH-20**: `.github/workflows/lab-build.yml` (#1087) does not fetch models, so the Lab build needs no `probe_build` input. The weights are looked up only at probe time (`KokoroOrtProbeEngine.swift:86–100` via `Bundle.main.url`, `ForayTtsPlugin.java` via `getAssets().list`) and `inject-models.mjs` copies into `App/public` and `assets/` with no pbxproj or Gradle resource declaration — so a build without them compiles and the probe reports `lookedFor`.
21. **CH-28 (f)**: `whenPlayerBridge` must preserve the `late` flag (app.js 15643 passes `whenLaneKnown(true|false)`; 16485 does not): resolve with `{ player, late }`.
22. **CH-40**: the eight characterization tests land as the FIRST commit, before `player/deadline.js` exists; durable-store's `TimeoutError` rejection and download-bridge's `{ok:false, reason:"timeout"}` are the two contracts most at risk of flattening.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** One rule, one place: every duplicated rule in the player and the page has a single owner that the copies import or pin to; dead code and false comments are gone; the five corner-case bugs the duplicates caused are fixed; and every change is behaviour-preserving except the eight listener-visible fixes named in §0.2 and the deliberate decisions each card states.

**Done when.** Every card's PR is merged (wave by wave, in order); `node tools/ci/run-suites.mjs` is green with every floor raised to the true count; `node tools/parity/record.mjs --check` is green after each wave; the four §5 deferrals each have a founder answer recorded (in `HUMAN-ACTIONS.md` as `[DECIDE]` items, or `docs/DECISIONS.md` by the founder); and Appendix A's 116 ids are each either closed by a merged card or deferred by a ruling.

**Dependencies.**
- None on the native-engine deck, the store launch or any credential. Nothing here spends.
- **Governed / human-merge paths touched** (from `tools/ci/path-policy.mjs`): `.github/workflows/*` and `.github/actions/*` (CH-06, CH-20), `tools/ci/generate-manifest.mjs` (CH-07), `index.html` (CH-07, CH-30), `api/` (CH-17), and native sources under `mobile/plugins/*` (CH-06, CH-11b, CH-19: comment-only Swift/Java/Gradle edits, or the reducer mirror with its parity fixture). These PRs open with a TL;DR that says "human merge — governed path: <which>".
- `app.js` is shared with player-features, catalogue-personalization, listener-forays-sharing, kokoro-voice and dai (README). Across packages only one `app.js` PR is in flight at a time; within this package a wave may hold two `app.js` cards in named, disjoint regions, merged one after the other with a rebase between.
- CI compiles the Swift and Java; there is no local Mac or Android toolchain. A card that edits native sources quotes its green `ios-kit` / `android-build` run in the PR.

**Open founder questions (defaults proposed; each card proceeds on the default).**
1. **Delete the Kokoro probe code (N1-02)?** ~3,900 lines of Swift/Java, the `kokoroProbe` plugin method, ProbeLedger boot I/O, ONNX Runtime deps, 150 lines of foray-tts.js. K-01 is PARKED, not withdrawn (`docs/bundled-voice-plan.md:19`). *Default: not in this package.* CH-20 removes the weights from the shell builds and fixes the probe comments now, which captures the release-size and CI-fragility cost; the code deletion is a one-line ruling (recoverable from git either way).
2. **Close the two-element handover question (P1-03)?** The prefetch handover is a documented park with an open measurement (`queue-manager.js` §11, `docs/research/mp1-background-audio.md` §4.1a) and `test/suite-integrity.test.js:193–196` floors its one integration test precisely so it is not deleted as dead. *Default: keep parked.* CH-34 fixes the "exactly two elements" prose so the comments stop lying meanwhile.
3. **The `?v=` immutable rule in `vercel.json` (X1-14)**: implement the versioned shell fetch or retire the rule? It fires on no request today; DECISIONS #606 calls the client "a cheap follow-up"; `test/vercel-headers.test.js` tests 3–4 pin it. *Default: leave it; log the decision in DECISIONS.md when the founder next edits it.* Either way the web must never send `?v=` while `sw.js` strips queries.
4. **Device-chapter deadline (CH-33)**: `readDeviceChapters` moves from its own 8 s to the id3 module's `CALL_TIMEOUT_MS` = 10 s. *Default: yes — one rule.*
5. **`#/forays` Jump back in (CH-32)**: the Forays page renders the Home card markup (Forays only, content rule unchanged) instead of its own `.fy-jbi-row`. *Default: yes.*
6. **Authored jingle rate (CH-11b)**: a `kind: "jingle"` queue item plays at 1.0x like the interlude jingle, on all three engines. No shipped Foray carries the kind (one draft does). *Default: yes.*
7. **Bookmarks surface (CH-09b)**: land PQ-15 as the roadmap scoped it (list on the episode page, tap = play-then-seek, Remove), since the sheet already announces "Bookmarked." and the privacy policy already claims the list. *Default: yes.*

## 2. Task table

| id | title | wave | executor | why-opus | depends-on | size |
|---|---|---:|---|---|---|---|
| CH-01 | Up Next refuses pool rows 4a cannot play; retire the link-out comments | 1 | qwen | | — | S |
| CH-02 | Downloads: one writer for `cp_downloads`, `markPlayed` wired from the successful local load | 1 | opus | three layers (app.js, client.js, module) and a null-semantics decision | — | M |
| CH-03 | `ForayPlayer.isPlaying(id)` answers from the transport, not the reducer belief | 1 | qwen | | — | S |
| CH-04 | durable-store guards `bridge.isNativePlatform()` like it guards `getPlatform()` | 1 | qwen | | — | S |
| CH-05 | queue-state exports its identity/focus rules to queue-manager; header names the live Swift mirror | 1 | qwen | | — | S |
| CH-06 | CI runs foray-downloads' Swift and Java tests; retire the seven "until PQ-21" comments | 1 | opus | `.github/` DENIED; native comment edits; tests may be red on first run | — | M |
| CH-07 | Boot-path preload/precache/dist list derived from client.js's import graph | 1 | opus | `index.html`, `tools/ci/` governed; SW precache blast radius | — | M |
| CH-08 | `cp_playlists` has one writer; `savePlaylists` and the dead Apple ids go | 2 | opus | durability semantics (storage-settle ordering) | CH-01 | M |
| CH-09a | Bookmarks and starred shows write through `editStored`; engine watermark too | 2 | qwen | | — | S |
| CH-10 | A Foray's queue is built once: client.js indexes the list the manager loaded | 2 | qwen | | — | S |
| CH-11 | `player/item-kind.js`: strip and media-session classify a jingle the same way | 2 | qwen | | CH-05 | S |
| CH-12 | download-bridge imports native-engine's listen helper | 2 | qwen | | CH-06 | S |
| CH-13 | event-log shares idb-tier's `openDb` and durable-store's `errText` | 2 | qwen | | CH-04 | S |
| CH-14 | `gesture-math.js` owns `releaseVelocity`; thresholds stop asserting equality in prose | 2 | qwen | | — | S |
| CH-15 | sw.js: full escaper, true comments; a pin that the Swift asset URLs equal the JS constants | 2 | qwen | | — | S |
| CH-16 | search-engine.js export comments name their real readers; two orphan exports go private | 2 | qwen | | — | XS |
| CH-17 | `api/_lib` owns `firstParam`; the catch-all route's array variant is renamed | 2 | opus | `api/` is a human-merge path | — | S |
| CH-19 | Mobile native comments tell the truth: lane names, iOS half, `routeChangeReason` pin | 2 | opus | Swift/Java/JSON comment edits; `docs/plans/` decision record | — | S |
| CH-20 | Kokoro weights leave every shell build; probe comments become history | 2 | opus | `.github/` release workflows | CH-06 | M |
| CH-21 | `HtmlAudioBackend.load()` uses deck-policy's `settledNear`/`warmOffset`; requires nearness on `seeked` | 2 | qwen | | — | S |
| CH-11b | Reducer: a `JINGLE` item keeps 1x — JS, Swift and Java mirrors + the `queue-state` fixture | 3 | opus | Swift + Java reducer ports; parity re-record | CH-11 | M |
| CH-18 | Delete the duplicate `.show-ep-search input` CSS block | 3 | qwen | | CH-09a | XS |
| CH-22 | Foray page lifecycle: one resolve call, one resume-point read, state cleared on leaving | 3 | opus | `renderForay` is the busiest function in the file | — | M |
| CH-23 | One shell detector, one hash rewriter, one fetch shape, one origin literal, one pin write | 3 | qwen | | — | S |
| CH-24 | `player/duration.js` owns the hours-minutes tail; progress modules share `MAX_AGE_H`; test-only exports go | 3 | qwen | | CH-11 | M |
| CH-25 | One load-in-flight marker: a failed load reaches the reducer once | 3 | opus | error-ordering trap across a 225-test suite | CH-05, CH-21 | M |
| CH-26 | Delete the dead `ForayPlayer` members | 3 | qwen | | CH-10 | S |
| CH-27 | `download-store.readSource` is the one "open a downloaded file from the WebView" rule | 3 | qwen | | CH-02 | S |
| CH-28 | Small helper unification: taxonomy, interest commits, generated-playlist literal, one bridge wait | 4 | qwen | | CH-22 | M |
| CH-29 | One indexed title→catalogue-show join; show-page count label and pool helpers; corrected comments | 4 | qwen | | CH-24 | M |
| CH-30 | Delete `queue-strategy.js`; `setQueueFromPick` builds the one-item queue directly | 4 | opus | `index.html` governed; wide test rewrite; parity books | CH-25, CH-07 | M |
| CH-31 | Cross-module vocabulary pins: session errors, data file keys, owned `cp_` prefixes | 4 | qwen | | CH-24, CH-19 | S |
| CH-32 | Home and Forays page: one Foray start path, one Jump back in renderer, one "played" reading, one stretch sentence | 5 | opus | listener-visible copy and layout | CH-22 | M |
| CH-33 | Chapter rows say one thing; device-chapter fetch reads the id3 module's deadline and UA | 5 | opus | listener-visible chapter copy; a timing change | CH-27, CH-24 | M |
| CH-34 | Player comments that lie, one stop-snapshot shape, `routeChanged` prose, web `setVolume` deleted | 5 | qwen | | CH-25, CH-30 | S |
| CH-35 | Row templates and Up Next/Library hygiene: progress chip, playlist row, Play-next rule, repaint helper | 6 | qwen | | CH-01, CH-29, CH-33 | M |
| CH-36 | Search/engine constants hygiene: `branchOf`/`foldDiacritics` pinned or reused; dead symbols; shard-cache branch | 6 | opus | the pin-vs-delete judgement over 38 harnesses | CH-28, CH-32 | S |
| CH-37 | The backend answers "audible?" itself | 6 | qwen | | CH-34 | S |
| CH-38 | One onboarding sheet builder (per-sheet parked state); sheet owners hide; voice settings read the player's constants | 7 | qwen | | CH-36 | M |
| CH-40 | `player/deadline.js`: one "race a promise against a deadline" and one `REAL_SCHEDULER` | 7 | opus | cross-cutting refactor over nine modules | CH-04, CH-12, CH-13, CH-27, CH-33, CH-37 | M |
| CH-09b | Episode page lists bookmarks (PQ-15): tap = play-then-seek, Remove, precision-aware label | 8 | opus | a new listener surface; copy | CH-09a | M |
| CH-39 | Foray page: bridge capabilities visible, true skew comments, cites join like credits, Search is a Foray surface | 8 | qwen | | CH-22, CH-38 | M |
| CH-41 | `player/guards.js` owns `isNum`/`isObj`; the two `clampIndex` contracts get different names | 8 | opus | repo-wide mechanical sweep across 14 modules | CH-40, CH-39, CH-37, CH-34, CH-31, CH-24, CH-11 | M |

**43 cards: 17 opus (CH-02, 06, 07, 08, 11b, 17, 19, 20, 22, 25, 30, 32, 33, 36, 40, 41, 09b), 26 qwen; sizes 2 XS / 21 S / 20 M. Per wave: 1 → 7, 2 → 13, 3 → 8, 4 → 4, 5 → 3, 6 → 3, 7 → 2, 8 → 3. Human-merge PRs: CH-06, CH-07, CH-11b, CH-17, CH-19, CH-20, CH-30.**

## Standard conventions (every card applies these verbatim)

- Repo: `C:/Users/wjduv/Desktop/Vibe Coding/foray`. Start: `git -C "<repo>" fetch origin` then `git -C "<repo>" -c core.autocrlf=false worktree add C:/w/<card-id> -b refactor/<card-id>-<slug> origin/main` and work ONLY in that worktree (LF tree; never run `format:write` repo-wide; never `git restore`/`git clean`; never work in the founder checkout).
- **Characterization first.** Every card's first commit adds the tests that pin today's behaviour (named in the card under "Characterization FIRST") and they pass against the unmodified code. Only then does the refactor land. A reviewer must be able to see the pin before the move.
- **Mutations.** Every new test's comment names the one-line mutation that turns it red, and you run that mutation once before committing.
- **Floors are minimums.** `test/suite-integrity.test.js` asserts `count >= floor`. A NEW suite needs a `FLOORS` entry with its top-level `test()` count in the same PR. When a suite grows by N, raise its floor by N and append `; <old> -> <new> // CH-xx: <what>` to that line's comment. When a card DELETES tests (CH-24, CH-26, CH-30, CH-34), set the floor to the exact new count and say so in the comment. Never delete a test to hit a number.
- **Parity.** Any card touching `player/queue-state.js`, `queue-manager.js`, `html-audio-backend.js`, `deck-policy.js`, `foray-resolve.js`, `foray-progress.js`, `route-resume.js` or `locate-window.js` runs `node tools/parity/record.mjs --check` and reports it. Only CH-11b re-records a family (`queue-state`), per `player/parity/README.md`; a card whose `--check` moves a fixture it was not told to re-record has made a behaviour change and stops.
- Never commit `deploy-manifest.json` or `data/forays-directory.json`. `sw.js` `BUILD_ID` stays the literal `"unstamped"`.
- No new `logEvent("<type>")` strings and no new `cp_` key anywhere in this package (CH-09b reads `cp_bookmarks`, which exists). `test/data-deletion.test.js` and `test/legal-citations.test.js` must stay green untouched.
- `app.js` is a classic script tested in `node:vm` harnesses; new page tests copy the harness of the suite named in the card. 38 of the 109 app.js harnesses do not load `search-engine.js`: never add a top-level `SearchEngine.` read to app.js.
- One test process at a time: run `node --test <files>` sequentially; the CI-equivalent full run is `node tools/ci/run-suites.mjs` (once before the PR).
- Commit messages end with the trailer lines your harness gives you (`Co-Authored-By:` + `Claude-Session:`). PR opened as DRAFT (`gh pr create --draft`), title `refactor(<area>): <card title> (CH-xx)`, body opens with a 1–2 sentence TL;DR then `---`, lists the issues closed by id, names every characterization test and every mutation run, quotes `--check` where required, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and the session URL line. Open the PR and STOP. Never label, never merge.
- **Human-merge cards** (CH-06, 07, 11b, 17, 19, 20, 30): `node tools/ci/path-policy.mjs` reporting a governed path is expected; the TL;DR says "human merge — governed path: <which>".
- **Stop and escalate if:** a cited symbol does not exist on `origin/main`; a characterization test fails against the UNMODIFIED code (the issue's premise is wrong — report, do not "fix" the test); `--check` moves a fixture the card did not name; or the card's region in `app.js`/`client.js` overlaps a change already merged this wave.

## 3. Cards

Each card: the issues it closes (Appendix A), the exact change, files (the agent touches nothing else), governed paths, dependencies, risk, and the tests — characterization first, then the new tests with the mutation each one kills.

### Wave 1 — live bugs and CI gaps (7 cards, all independent)

### CH-01 · Up Next refuses pool rows 4a cannot play; retire the link-out comments (qwen, S)

**Issues:** A1-01 (high), A1-10. **Listener-visible bug fix.**

**Exact change.** In `app.js` make `addToQueue` (~3031), `playNextInQueue` (~3083) and `upNextBtn` (~1875) gate on `isPlayableId(id)` (3369: `liveEpisode` + `audio_url`) instead of bare `liveEpisode(id)`. `isPlayableId` is a function declaration (hoisted); give it a one-line header saying it is THE playability rule the continuation planner already uses via `continuationState` (3453). Rewrite the four stale link-out sentences (3120–3121, 3786–3787, 2473–2474, 6596–6597) to the current rule: no `audio_url` → "Not available to play", no Up Next button, no link.

**Acceptance.** A pool row without `audio_url` renders `notPlayableNote()` and NO `upNextBtn` in `epRow` (11345) and `renderEpisode` (12105); `addToQueue` returns false for it; queue count equals walk count.

**Files:** `app.js`, `test/up-next-queue.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low — pure tightening on an already-fails-closed path; 8 of 2177 discover rows affected.

**Tests (write FIRST, in `test/up-next-queue.test.js`; bump its floor from 26).** (1) Seed the silent item INTO `m.state.poolIds` (the existing tests at 254 and 292 empty `poolIds` — exactly the untested gap) and assert `addToQueue` refuses, `upNextBtn` returns `""` and `planAfterEnded` agrees with the queue length. (2) A pool row WITH `audio_url` still queues (characterizes today's good behaviour). **Mutations:** reverting the gate at 3031 to `liveEpisode` flips test 1; dropping the `audio_url` check in `isPlayableId` flips test 2's companion assertion that `planAfterEnded` plays every queued id.

### CH-02 · Downloads: one writer for `cp_downloads`, `markPlayed` wired from the successful local load (opus, M)

**Issues:** P2-01 (high), X1-03, P2-11, P2-19. **Bug fix:** the documented least-recently-PLAYED eviction never sees a play.

**Exact change.** (a) `player/download-store.js`: add `removeRow(value, id)` (moving app.js's `downloadsWithout` 12657–12661 rule in); make `readDownloads(storage)`/`writeDownloads(storage, value)` take a Storage-shaped adapter. `app.js` 12644–12654 (`downloadsValue`/`saveDownloads`) becomes a thin call through `window.forayDownloads.store` with an adapter `{ getItem: k => lsGet(k, null), setItem: (k, v) => lsSet(k, v), removeItem }` so DurableStore stays the only backend and the literal `"cp_downloads"` (12645, 12653) is replaced by `rules.KEY`. `writeDownloads(null)` keeps its remove-the-key semantics; `saveDownloads(null)` routes to it (characterize current app behaviour first; the spec is that null removes, matching the module). (b) In `player/client.js`, fire a new `window.forayDownloads.onPlayedFromFile?.(item.id)` hook **where the `localAttempt` ticket is cleared on a successful local load** (the `localAttempt = null` at ~4549 after the backend load resolves) — NOT inside `localSourceFor` (4341–4352, a pure mapper whose caller retries the stream when the file is missing). `app.js` implements the hook as `saveDownloads(rules.markPlayed(downloadsValue(), id, Date.now()))`, idempotent. (c) `docs/roadmap/player-features.md:316–319` names the caller.

**Files:** `app.js`, `player/client.js`, `player/download-store.js`, `player/download-store.test.js`, `test/downloads.test.js`, `docs/roadmap/player-features.md`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** medium — adds a write on every successful local play; keep it idempotent and inside the existing lsSet path app.js already uses for downloads. app.js region 12644–12661 only; client.js regions: the `localAttempt` success point and the `window.forayDownloads` publication (970–980).

**Tests.** Characterization FIRST: `test/downloads.test.js` pins that `saveDownloads` goes through `lsSet` (DurableStore) and that the eviction plan over three rows with null `last_played_at` orders by `updated_at` (today); `player/download-store.test.js` pins `readDownloads`/`writeDownloads` round-trip and `writeDownloads(null)` removes. New: a never-played row is evicted before a played-yesterday row once `markPlayed` has run (kills reverting the hook call); a local file whose load FAILS and falls back to the stream does NOT move `last_played_at` (kills moving the hook into the mapper); app.js reads `cp_downloads` through `rules.KEY` (grep-pin: no `"cp_downloads"` literal in app.js; kills re-spelling); `removeRow` equals the old `downloadsWithout` on a 3-row fixture (kills the move). Bump download-store floor from 16.

### CH-03 · `ForayPlayer.isPlaying(id)` answers from the transport, not the reducer belief (qwen, S)

**Issues:** P1-01 (high). **Bug fix:** the episode-notes stamp tap pauses audio in the #689 drift.

**Exact change.** In `player/client.js` change `isPlaying(id)` (4819–4821) to `transportIsRunning() && current?.id === id` so it shares `togglePlayback()`'s authority (4949–4951); `app.js:12051` needs no change. Add a header line on both members saying they read the same predicate.

**Files:** `player/client.js`, `player/transport-reconcile.test.js` (or `foray-playback.test.js`, whichever already has the backend fake with `paused`), `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low — one predicate; client.js region is the `ForayPlayer` object's `isPlaying` member only (CH-02 owns `localAttempt`).

**Tests.** Characterization FIRST: with reducer state `playing`, `isPlaying(id)` is true for current and false for another id. New: backend fake `paused=false`, reducer forced to `interrupted` (the queue-manager.js:1165 drift); assert `isPlaying(current.id) === true` and that app.js's stamp-tap sequence (seek then `if (!isPlaying) togglePlayback`) leaves the element running. **Mutation:** reverting to `isPlaying() && current?.id === id` makes the drift test call `togglePlayback` and the fake records a pause. Bump the floor of the suite that gains the tests.

### CH-04 · durable-store guards `bridge.isNativePlatform()` like it already guards `getPlatform()` (qwen, S)

**Issues:** N1-01. **Bug-risk fix.**

**Exact change.** In `player/durable-store.js` wrap the `bridge.isNativePlatform()` (and any `isPluginAvailable()`) calls in `nativeKvTier` (357–359) and `deferredPrefixesFor` (457–462) in try/catch returning `null` / `[]` respectively, matching the `getPlatform()` posture on 461. Rewrite `mobile/web/foray-type-scale.js:40–41` to state what `typeScaleApplies` actually does (consults `isNativePlatform` inside one try). Do NOT unify the other platform predicates (`shellApplies`, `typeScaleApplies`, `mediaSessionApplies`, `bridgeOf`) — they encode different rules by design.

**Files:** `player/durable-store.js`, `player/durable-store.test.js`, `mobile/web/foray-type-scale.js`. **Governed:** none. **Depends on:** —. **Risk:** low.

**Tests.** Characterization FIRST, beside durable-store.test.js 1845 and 1377: a bridge whose `isNativePlatform` returns false yields `null` / `[]`. New: a bridge whose `isNativePlatform` THROWS yields `null` from `nativeKvTier` and `[]` from `deferredPrefixesFor` (kills removing either try).

### CH-05 · queue-state exports its identity/focus rules to queue-manager; header names the live Swift mirror (qwen, S)

**Issues:** P1-06, P2-09. **Behaviour-preserving.**

**Exact change.** Export `sameRef` and `currentItem` from `player/queue-state.js` (262–277); in `player/queue-manager.js` delete `focusOf` and `sameItemRef` (3314–3334) and import `currentItem as focusOf, sameRef as sameItemRef` (or rename call sites). Rewrite queue-state.js header 1–6 and 56–66: the mirror is `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Reducer/PlayerQueueState.swift`, checked by the `queue-state` parity family (`player/parity/manifest.json`), not by eye; delete the "#111 Swift has NOT been updated / a Foray cannot play on the native backend" paragraph (`native-facades.js:338–381` plays Forays). In `ios/README.md` mark `ios/ForayKit`'s `PlayerQueueState.swift` as a frozen legacy copy pending #28 (it still builds in `ios-build.yml`; do not delete).

**Files:** `player/queue-state.js`, `player/queue-manager.js`, `player/queue-manager.test.js`, `ios/README.md`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low — comment-only in docs; export additions only.

**Tests.** Characterization FIRST: queue-manager.test.js already covers the stale-load guard (player-core-9); add one explicit test that `_loadItem` drops a load whose ref differs only in bounds (pins identity-including-bounds) — it passes before and after. **Mutations:** making the manager's import compare id only fails that test; exporting a `sameRef` that ignores kind fails queue-state's own tests. No JS behaviour change, so no fixture re-record; run `node tools/parity/record.mjs --check`.

### CH-06 · CI runs foray-downloads' Swift and Java tests; retire the seven "not yet declared / until PQ-21" comments (opus, M — human merge)

**Issues:** N1-04, N1-05, P2-12. **CI-coverage gap.**

**Exact change.** Add a `swift test (foray-downloads, iOS Simulator)` step to `.github/workflows/ci.yml`'s `ios-kit` job beside the foray-tts step (~332), mirroring its shape; add `:foray-downloads:testDebugUnitTest` to `android-build.yml:376–377` and `foray-downloads` to the module loop at :390. Rewrite in present tense: `mobile/plugins/foray-downloads/package.json:6`, `Package.swift:15–19`, `android/build.gradle:10–12`, `ios/.../DownloadStore.swift:17–24`, `ios/.../ForayDownloadsPlugin.swift:50–53` (comment-only; compile only in CI), `player/download-bridge.js:18–23` (both halves exist, with paths; the `{ok:false}` deadline path is for a hanging bridge or a shell built without the plugin), `tools/mobile/foray-downloads.test.mjs:243–248`. The optional downloads parity family is a follow-up sentence in the PR body (CH-12 carries it into `player-features.md`).

**Acceptance.** `ci.yml` and `android-build.yml` green with the new steps reporting a non-zero test count; grep for `PQ-21` in the plugin finds only history sentences.

**Files:** `.github/workflows/ci.yml`, `.github/workflows/android-build.yml`, `mobile/plugins/foray-downloads/package.json`, `mobile/plugins/foray-downloads/Package.swift`, `mobile/plugins/foray-downloads/android/build.gradle`, `mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/DownloadStore.swift`, `mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/ForayDownloadsPlugin.swift`, `player/download-bridge.js`, `tools/mobile/foray-downloads.test.mjs`. **Governed:** `.github/workflows/*`, `mobile/plugins/foray-downloads/*` (comment-only). **Depends on:** —. **Risk:** medium — the native tests have never run in CI and may be red on first run; if so, fix forward in the same PR (they are rule tests over `DownloadPolicy`/`DownloadRules`) rather than skipping them.

**Tests.** Characterization: `tools/mobile/foray-downloads.test.mjs:221–240` and 387–405 already pin the test NAMES exist — keep them. New Node test in the same file: the two workflow files name the foray-downloads test targets (kills removing the steps again).

### CH-07 · Boot-path preload/precache/dist list derived from client.js's import graph, not a directory walk (opus, M — human merge)

**Issues:** P2-04. **Deletion-shaped perf fix on the boot path.**

**Exact change.** In `tools/ci/generate-manifest.mjs` replace `playerSources` (185–190) with the static import closure of `player/client.js` (regex over `import … from "./x.js"` lines, recursive, plus any `player/*.js` that `index.html` loads directly) and EXPORT the closure; `tools/web/prepare-dist.mjs`'s `playerSources` (93–99, the second directory walk deciding what Vercel's dist contains) imports it (prepare-dist.mjs:26 already imports from generate-manifest). Update `index.html:65–70` and drop the four `<link rel=modulepreload>` lines (75, 99, 111, 116) for `catalogue-directory`, `show-alerts`, `locate-window`, `route-resume`. `test/boot-path.test.js:246–256` keeps asserting preload == manifest list, now against the import closure. Leave the four modules on disk (their tests, parity fixtures and `tools/transcribe` prose reference them) but add one sentence to each header: not on the boot path; wired by PQ-26 (show-alerts) / parity-only (route-resume, locate-window) / unwired (catalogue-directory). Reword `tools/mobile/prepare-webdir.mjs:510–513` ("every non-test .js is the whole graph" is no longer true; the native webdir may keep the directory walk but the comment cannot claim it equals the graph). The `route-resume` parity family (Swift-run, JVM owed to A-61) keeps reading `player/route-resume.js` from disk and is unaffected. Check `prepare-webdir.mjs` and `sw.js` precache consume the manifest unchanged.

**Acceptance.** No "preloaded but not used" console warnings in a local boot; bundle byte budget in `tools/mobile/prepare-webdir.test.mjs` unchanged or lower; dist and manifest list the same `player/` files.

**Files:** `tools/ci/generate-manifest.mjs`, `tools/web/prepare-dist.mjs`, `index.html`, `test/boot-path.test.js`, `test/prepare-dist-out.test.js`, `tools/mobile/prepare-webdir.mjs` (comment), `player/catalogue-directory.js`, `player/show-alerts.js`, `player/locate-window.js`, `player/route-resume.js`. **Governed:** `index.html`, `tools/ci/generate-manifest.mjs`. **Depends on:** —. **Risk:** medium — the SW precache list is derived from the same manifest; a missed transitive import would 404 offline. The closure test is the guard.

**Tests.** Characterization FIRST: boot-path.test.js asserts the current 4 orphans ARE listed (so the mutation direction is explicit), then flip to assert they are NOT and that every module client.js imports transitively IS (kills a hand-edited list that misses a real import). prepare-dist-out.test.js asserts dist's `player/` set equals the manifest's.

### Wave 2 — behaviour-preserving unifications (13 cards; app.js slots: CH-08, CH-09a; client.js slot: CH-10)

### CH-08 · `cp_playlists` has one writer: `playlists()` stops persisting its backfill; `savePlaylists` and the dead Apple ids go (opus, M)

**Issues:** A1-02, A1-07, A1-09. **Bug fix (A1-02) plus two deletions.**

**Exact change.** (a) In `app.js` `playlists()` (2622–2669) delete the read-path `lsSet("cp_playlists", all)` at 2668; keep the in-memory backfill so readers see repaired rows, and let the next real `editPlaylists` persist it (`editPlaylists` already runs the same backfill via `withMirror`; verify, else add a pure `backfillPlaylists(list)` that `editPlaylists` applies first). Alternative only if a test shows a listener-visible gap: have `markStorageSettled` (406–413) flush `pendingStoredEdits` before the other waiters. (b) Delete `savePlaylists` (2672) and seed the 24 test references across boot-path, format-helpers, jump-back-in-kinds, playlist-durability, save-playlist, up-next-queue tests via `m.store.set("cp_playlists", …)` (or a test-local helper); make `PLAYLISTS_CAP` (2698) the only cap and fix the 2697 comment. (c) Drop `apple_collection_id`/`apple_track_id` from `PLAYLIST_PART_FIELDS` (2513), update the byte table 2465–2477 and the field lists in `test/playlist-durability.test.js:369` and save-playlist.test.js; rewrite the 2476–2477 rationale (no derivation exists; `shareLinkFor`'s `apple_episode_url` fallback at 5527 reads a LIVE item, not a part). Do not touch 6866–6911 except as a test fixture.

**Files:** `app.js`, `test/playlist-durability.test.js`, `test/save-playlist.test.js`, `test/boot-path.test.js`, `test/format-helpers.test.js`, `test/jump-back-in-kinds.test.js`, `test/up-next-queue.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-01 (shares up-next-queue.test.js). **Risk:** medium — a repaired legacy list is not persisted until the next edit; that is the intended single-writer rule and the backfill is deterministic. app.js regions: 387–413, 2465–2513, 2622–2698, 2819–2847.

**Tests.** Characterization FIRST: (1) a playlist with a missing `created` is repaired in the value `playlists()` returns — must still pass; (2) `savePlaylistCopy` on a fresh store returns `saved` and logs one `playlist_saved`. New (kills reverting 2668): pre-hydration Home render queues the onboarding waiter, then a queued save, then a backfill-needing legacy list; on `markStorageSettled` assert status `saved` and exactly one `playlist_saved` event. New: a stored part has no `apple_*` keys (kills re-adding them).

### CH-09a · Bookmarks and starred shows write through `editStored`; the engine watermark too (qwen, S)

**Issues:** A1-03, A1-04. **Two durability bug fixes.**

**Exact change.** (a) `player/bookmarks.js`: add an `edit(key, fallback, fn)` store shape; app.js `BOOKMARK_STORE` (3531) becomes `{ get: lsGet, edit: editStored }` (keep `get` for readers); `readAll`/`write` use `edit`. (b) app.js `applyEngineAdvance` (3644–3646) and `drainEngineEvents` (3678–3681): `editStored(ENGINE_APPLIED_KEY, null, () => step.applied)`. (c) `toggleShowStar` (1893–1918) restructured to `toggleStar`'s shape: compute entry, `const ok = editStored(…)`, log `show_starred`/`show_unstarred` only if `ok`; optional shared `toggleStoredMembership(key, id, entry, events)` used by both. No client.js edit (the module is already published whole at client.js:171).

**Files:** `app.js`, `player/bookmarks.js`, `player/bookmarks.test.js`, `test/bookmarks.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low. app.js regions: `toggleShowStar` 1886–1918, `BOOKMARK_STORE` 3527–3532, engine watermark 3640–3681 — disjoint from CH-08.

**Tests.** Characterization FIRST: test/bookmarks.test.js pins `addBookmark` writes through the store and the sheet announces "Bookmarked."; a show-star test pins `show_starred` is logged on a successful follow. New: a refused `editStored` (quota fake) logs NO `show_starred` and the button repaints unfollowed (kills logging before the write); a bookmark tapped while `storageWaiting()` is queued and lands over hydrated data, not `{thisOne}` (kills reverting to raw get/set); the engine watermark survives a pre-hydration attach (kills raw `lsSet`).

### CH-10 · A Foray's queue is built once: client.js indexes the list the manager actually loaded (qwen, S)

**Issues:** P1-04. **Duplicated-state fix.**

**Exact change.** In `player/client.js`, after `manager.setQueueFromForay(…)` returns its report in `playForay` (5377–5386) and `restoreForay` (3489), store `foray.playable = report.items` and make every `foray.resolved.playable[…]` read (1591, 1637, 5716, `foraySecondLine`) read `foray.playable`. Keep `setQueueFromForay(foray, opts)`'s signature (`native-facades.js:345` and the parity scenario builds share it).

**Files:** `player/client.js`, `player/foray-playback.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low. client.js regions: `playForay`/`restoreForay` and the four `playable` reads.

**Tests.** Characterization FIRST (foray-playback.test.js): the sheet highlights the segment at `foray.index` and `forayPlayhead` subtracts that segment's `start_sec`. New: resolve with `allowAdPad: true` and play with the default so the two builds differ by one skipped segment; assert the highlighted row, the playhead and the resume row all name the segment the manager is playing (kills reverting any one read). One assertion that for the shipped option set the two builds are deep-equal (documents the invariant). Bump foray-playback floor from 92.

### CH-11 · `player/item-kind.js`: strip and media-session classify a jingle the same way (qwen, S)

**Issues:** P2-03 (the JS-classification half; the reducer half is CH-11b). **Latent inconsistency** — no shipped Foray carries `kind: jingle`; one draft does.

**Exact change.** Create `player/item-kind.js` exporting `isNarration(item)` (`kind === TTS || type === "narration"`), `isJingle(item)`, `isTape(item)`, importing `TTS` from `./queue-state.js` (73) and `JINGLE` from `./foray-queue.js` (76). `queue-state.js` must NOT import item-kind (cycle); the reducer keeps its own constants. `segment-strip.js:157–159` imports `isNarration` (and stops spelling `"tts"`); 172–177/378–380 render a jingle as a narration-class hairline, not a show capsule; `stripSummary`/`stripTally` exclude it from clips. `media-session.js:400–401` uses `isNarration || isJingle`. `interlude.js` gets one sentence pointing at item-kind as the classifier. Note in item-kind.js that warming a jingle (`deck-policy.js:842 preparesNext`) is a separate decision, unchanged.

**Files:** `player/item-kind.js`, `player/segment-strip.js`, `player/media-session.js`, `player/interlude.js`, `player/segment-strip.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-05 (queue-state exports). **Risk:** low — pure JS; the only behaviour change is for a kind no published Foray uses.

**Tests.** Characterization FIRST: segment-strip.test.js pins a tts item renders as hairline and a segment as capsule. New: a `kind: "jingle"` item renders hairline and is not counted in `stripTally.clips` (kills removing `isJingle` from the strip); media-session treats it as ours (kills the `|| jingle` drift).

### CH-12 · download-bridge imports native-engine's listen helper instead of a line-number-pinned copy (qwen, S)

**Issues:** P2-06. **Behaviour-preserving.**

**Exact change.** Export `listenTo(cap, plugin, eventName, fn)` from `player/native-engine.js` (body of 116–125, parameterised) and use it there; `player/download-bridge.js:95–108` imports it and deletes its copy plus the "lines 116–124, copied exactly" citations at 43–45 and 95–96. In `docs/roadmap/player-features.md` fix the "cites listen() verbatim" phrasing (PQ-17) and add CH-06's follow-up line: a `download` parity family is optional future work.

**Files:** `player/native-engine.js`, `player/download-bridge.js`, `player/native-engine.test.js`, `player/download-bridge.test.js`, `docs/roadmap/player-features.md`. **Governed:** none. **Depends on:** CH-06 (download-bridge header). **Risk:** low.

**Tests.** Characterization FIRST: native-engine.test.js and download-bridge.test.js pin that with `cap.addListener` present the handle is returned and with only `nativeCallback` present null is returned and the callback registered — for BOTH plugins. **Mutation:** changing the plugin name or event in the shared helper fails one plugin's test.

### CH-13 · event-log shares idb-tier's `openDb` and durable-store's `errText` (qwen, S)

**Issues:** P2-14. **Behaviour-preserving.**

**Exact change.** Export `openDb(factory, name, version, storeName, storeOptions)` from `player/idb-tier.js` (118–135, parameterising the `createObjectStore` options) and import it in `player/event-log.js` (527–543); export `errText` from `player/durable-store.js` (1951–1956) and use it in event-log.js (91–93), updating event-log tests if they assert the plain-message form. Fix the 131–134 comment to be true.

**Files:** `player/idb-tier.js`, `player/event-log.js`, `player/durable-store.js`, `player/event-log.test.js`, `player/idb-tier.test.js`. **Governed:** none. **Depends on:** CH-04 (durable-store). **Risk:** low.

**Tests.** Characterization FIRST: event-log.test.js pins the "blocked by another tab" text and that the store is created with `keyPath id + autoIncrement`; idb-tier tests pin `keyPath key`. **Mutation:** swapping the store options in the shared helper fails one of the two.

### CH-14 · `gesture-math.js` owns `releaseVelocity`; thresholds stop asserting equality in prose (qwen, S)

**Issues:** P2-15. **Behaviour-preserving.**

**Exact change.** New `player/gesture-math.js` exporting `releaseVelocity(prev, last, axis)`; `queue-swipe.js:152–158` and `sheet-drag-dismiss.js:105–111` import it. Keep `FLICK_MIN_PX` 32 vs 40 per gesture but rename so two same-named exports with different values do not exist (`SWIPE_FLICK_MIN_PX` / `SHEET_FLICK_MIN_PX`). Replace `queue-swipe.js:41–44` ("the same 8 px as sheet-drag-dismiss.js") with either an import of `DIRECTION_LOCK_PX` or a sentence that the two are tuned independently. **Keep both `claimsTouch` names** (queue-drag's is called from app.js at 7577/12382/12426/12437; sheet-drag-dismiss's is imported at client.js:122 and re-exposed at 5116); add one header sentence in each saying they are per-gesture "does this finger belong to me" predicates with different inputs.

**Files:** `player/gesture-math.js`, `player/queue-swipe.js`, `player/sheet-drag-dismiss.js`, `player/queue-drag.js` (header sentence only), `player/queue-swipe.test.js`, `player/sheet-drag-dismiss.test.js`, `player/queue-drag.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low.

**Tests.** Characterization FIRST: both gesture tests pin velocity for a fixture of (prev, last, dt) on their axis and the current thresholds. **Mutation:** swapping axis in the shared helper fails the sheet test.

### CH-15 · sw.js: full escaper, true comments; a pin that the Swift engine's asset URLs equal the JS constants (qwen, S)

**Issues:** X1-04, X1-11, X1-18.

**Exact change.** `sw.js` cannot import, so it stays a copy — make it a correct one: `escapeHtmlAttr` (818–820) gets the five-character table with the `?? ""` guard; comment 837 reworded (no `RETAIN_GENERATIONS` exists; `activate()` keeps current + previous); 211 error names `deploy-manifest.json` (interpolate `MANIFEST_URL`); 906–907 says the jingle is cross-origin on Vercel and same-origin only on Pages. Update `test/sw-generation.test.js:791` message. New `test/engine-constants-pin.test.js` reads `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift` (193, 236, 246) with a regex and asserts `jingleAssetUrl`/`interludeAssetUrl`/`siteRoot` equal `foray-queue.js JINGLE_ASSET_URL`, `interlude.js INTERLUDE_ASSET_URL`, `download-bridge.js`'s site root. `PUBLIC_WEB_ORIGIN` derivation is CH-23, not here.

**Files:** `sw.js`, `test/sw-generation.test.js`, `test/engine-constants-pin.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low.

**Tests.** Characterization FIRST: sw-generation.test.js pins the fallback document's meta attribute for a deploy id. New: an id containing `>` and `'` is escaped (kills reverting the table); the Swift pin (kills a one-sided URL rename).

### CH-16 · search-engine.js export comments name their real readers; two orphan exports go private (qwen, XS)

**Issues:** X1-12.

**Exact change.** Rewrite `search-engine.js:2568–2576` and 2585–2589 to list app.js's actual 15 readers (`DEFAULT_CAP`, `STOPWORDS`, `classifyResults`, `foldDiacritics`, `interpretQuery`, `parseShowIndex`, `prefixSearchShows`, `primeVocabulary`, `rankShardRows`, `rankShows`, `scanShowIndex`, `searchShows`, `searchWithRelaxation`, `shardKeyForQuery`, `suggestAdjacentTopics`) vs tests/tools readers; drop `prettyConceptLabel` (1878) and `showIndexLowerBound` (2355) from the export object (delete them if unused internally).

**Files:** `search-engine.js`, `test/search-engine-exports.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low.

**Tests.** Characterization FIRST: a test greps app.js for `SearchEngine.<name>` and asserts every name is exported (kills removing a live export); then assert the two orphans are not on the export object.

### CH-17 · `api/_lib` owns `firstParam` (and `firstHeader`); the catch-all route's array variant is renamed (opus, S — human merge)

**Issues:** X1-13. **Behaviour-preserving.**

**Exact change.** Add `firstParam(v): string | null` to `api/_lib/params.ts` (reuse as `firstHeader` in `cors.ts:53–56`); import it in `api/episodes/search.ts`, `api/shows/search.ts`, `api/shows/[show_id]/episodes.ts`; rename `api/shows/index/[...path].ts:226–230` to `allParams`.

**Files:** `api/_lib/params.ts`, `api/_lib/cors.ts`, `api/episodes/search.ts`, `api/shows/search.ts`, `api/shows/[show_id]/episodes.ts`, `api/shows/index/[...path].ts`. **Governed:** `api/` (human merge). **Depends on:** —. **Risk:** low; TypeScript compiles in CI (`backend` check).

**Tests.** Characterization FIRST: existing api tests (or a new `api/_lib` test) pin `?q=a&q=b` → `a` for the three endpoints and the full array for the index route. **Mutation:** changing the shared helper to prefer the last value fails all three at once (the point).

### CH-19 · Mobile native comments tell the truth: engine lane names, iOS half, `routeChangeReason` pin (opus, S — human merge)

**Issues:** N1-06, N1-07, N1-08, N1-09. **Comment-only in native sources (compile in CI) plus one test pin.**

**Exact change.** `EngineHandshake.java:20` → `js`; `ENGINE_DEFAULT.json:2` android comment rewritten (the Media3 engine exists; ships in release ahead of the A-28 flip); add a glossary paragraph in `player/engine-contract.js` beside 119–137 mapping hello `legacy` == plist/page `js` == override `web`, referenced from `EngineMode.swift:22–50` and `EngineHandshake.java`; record in `docs/plans/android-assessment.md` (A-26/A-28) that the engine ships in release APKs ahead of the flip with the size cost. `mobile/README.md:98–109` rewritten to point at `inject-background-audio.mjs` and `ENGINE_DEFAULT.json`; `foray-audio/package.json:7–8`, `Package.swift:16–22`, `ForayAudioPlugin.swift:10–18` replaced by one sentence (ios/ holds Now Playing AND the native engine under `Engine/`, linking ForayEngineCore); `foray-tts/web/package.json:2` drop "(once wired)". Add to `tools/mobile/shell-invariants.test.mjs` a pin that `ForayAudioPlugin.swift`'s and `ForayTtsPlugin.swift`'s `routeChangeReason` bodies are byte-identical (the `EngineModeFlag.swift` pattern). Do not rename the hello wire value.

**Files:** `mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/EngineHandshake.java`, `mobile/ENGINE_DEFAULT.json`, `player/engine-contract.js`, `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Policy/EngineMode.swift`, `docs/plans/android-assessment.md`, `mobile/README.md`, `mobile/plugins/foray-audio/package.json`, `mobile/plugins/foray-audio/Package.swift`, `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift`, `mobile/plugins/foray-tts/web/package.json`, `tools/mobile/shell-invariants.test.mjs`. **Governed:** mobile native (comment-only Swift/Java/JSON; `package.json`/`Package.swift` are DENIED_PATTERNS). **Depends on:** —. **Risk:** low. `ENGINE_DEFAULT.json` edit is comment-field only; `inject-background-audio.mjs` validates the mode values.

**Tests.** New shell-invariants pin; **mutation:** editing one token table fails it.

### CH-20 · Kokoro weights leave every shell build; probe comments become history (opus, M — human merge)

**Issues:** N1-03 (high). **Deletion from the release path, probe left revivable** (K-01 is parked; the code deletion is deferred N1-02).

**Exact change.** In `.github/workflows/ios-build.yml:252–257`, `.github/actions/ios-archive/action.yml:80–91`, `android-build.yml:304–309` and `.github/actions/android-bundle/action.yml:116–119` remove the fetch-models/inject-models steps, or gate them behind a `probe_build` input defaulting false. `lab-build.yml` (#1087) does not fetch models and needs no input. KEEP `tools/mobile/fetch-models.mjs` and its pins (`render-narration.yml:87–94` depends on `--check` and the fp32/voice pins); empty the ios/android `bundle` lists so `--bundled ios|android` returns nothing; retire `tools/mobile/inject-models.mjs` + its test or leave it a no-op over an empty list (agent's call; say which in the PR). Re-point `test/release-gates.test.js:548–640` iOS/Android bundled-bytes tests at an app without weights and drop the Core ML stage pins only if `render-narration.yml` does not name them. Fix README K-01 §281–364 as history (the ONNX claim at :334 stays false until N1-02 lands — say so), `foray-tts.js:460–464` (`player/kokoro-probe.js` no longer exists), README:306/342. Compile safety: the weights are read only at probe time (`KokoroOrtProbeEngine.swift:86–100` via `Bundle.main.url`; `ForayTtsPlugin.java` via `getAssets().list`) and `inject-models.mjs` copies into `App/public` and `assets/` with no pbxproj or Gradle resource declaration, so a build without them compiles and the probe reports `lookedFor`.

**Files:** `.github/workflows/ios-build.yml`, `.github/actions/ios-archive/action.yml`, `.github/workflows/android-build.yml`, `.github/actions/android-bundle/action.yml`, `tools/mobile/fetch-models.mjs`, `tools/mobile/inject-models.mjs`, `tools/mobile/inject-models.test.mjs`, `test/release-gates.test.js`, `mobile/plugins/foray-tts/README.md`, `mobile/plugins/foray-tts/web/foray-tts.js`. **Governed:** `.github/workflows/*`, `.github/actions/*`. **Depends on:** CH-06 (android-build.yml). **Risk:** medium — release workflow edits; verify with a `workflow_dispatch` of ios-build/android-build before merge. App behaviour unchanged (nothing loads the weights).

**Tests.** Characterization FIRST: release-gates pins the current bundled list; then flip to assert `--bundled ios` and `--bundled android` are empty (kills re-adding) and that `render-narration.yml` still runs `--check` (kills over-deleting).

### CH-21 · `HtmlAudioBackend.load()` uses deck-policy's `settledNear`/`warmOffset` and requires nearness on `seeked` (qwen, S)

**Issues:** P1-07. **Drift-risk fix with one defensive tightening.**

**Exact change.** In `player/html-audio-backend.js` `load()` (1717–1731): normalise `startOffset` once with `warmOffset` (consider aliasing as `deckOffset`); use `settledNear({ atSec: el.currentTime, targetSec: startOffset })` in BOTH `onSeeked` and `onCanPlay` (resolve only when near AND `readyState >= READY_ENOUGH`, as `_seekWithinLoadedSource` 1791 does); replace the third inline offset spelling at 1782–1783. `SETTLE_NEAR_SEC` is 1 (deck-policy.js:203), identical to the inline `> 1` at 1728, so the canplay swap is exactly behaviour-preserving; only the seeked arm tightens. `player/parity/reference-engine.js` imports only `PREFETCH_LEAD_SEC` from the backend, so no parity family exercises `load()`.

**Files:** `player/html-audio-backend.js`, `player/html-audio-backend.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low-medium — the seeked tightening could delay resolution on an engine that reports `currentTime` late; the readyState+near rule already governs the warm path on the same engines.

**Tests.** Characterization FIRST: load with offset 600 resolves after canplay at 600; load with offset 0 resolves on canplay. New: a fake element fires `seeked` at currentTime 0 with readyState 3 BEFORE the offset seek lands; assert `load()` has not resolved, then it resolves once currentTime is near 600 (kills reverting `onSeeked`). **Mutation:** changing `SETTLE_NEAR_SEC` in deck-policy must move `load()`'s behaviour with it (one test parameterised on the constant). Run `--check` (no fixture moves). Bump floor from 129.

### Wave 3 — Foray page, duration, load-error path, reducer mirror (8 cards; app.js slots: CH-22, CH-23; client.js slot: CH-26)

### CH-11b · Reducer: a `JINGLE` item keeps 1x — JS, Swift and Java mirrors + the `queue-state` fixture (opus, M — human merge)

**Issues:** P2-03 (the rate half). **Rate decision, chosen here (founder Q6 default):** a jingle plays at 1.0x like `interlude.js`'s `INTERLUDE_RATE` (113–115 "Always").

**Exact change.** Add a `JINGLE` branch in `player/queue-state.js` `handleItemLoaded` (359) emitting `resetRateForTTS` (the reducer keeps its own `JINGLE` constant; it does not import item-kind). Mirror in `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Reducer/PlayerQueueState.swift` AND in `mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/PlayerQueueStateMachine.java:92`, adding `JINGLE` to `PlayerItemKind.java` (today only `EPISODE`, `TTS`; `EngineConstants.java:223` already has the `"jingle"` token) and to its `of(token)`. Re-record the `queue-state` family (`node tools/parity/record.mjs --family queue-state`, per `player/parity/README.md`) with a new case "jingle keeps 1x". Because the Java port lands in the same PR, no `--jvm-card` is owed; `jvm-pending.json` is unchanged unless record.mjs asks.

**Files:** `player/queue-state.js`, `player/queue-state.test.js`, `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Reducer/PlayerQueueState.swift`, `mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/PlayerQueueStateMachine.java`, `mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/PlayerItemKind.java`, `player/parity/fixtures/queue-state/queue-state.json`, `player/parity/jvm-pending.json` (only if record.mjs requires), `test/suite-integrity.test.js`. **Governed:** mobile native (reducer mirrors + parity fixture). **Depends on:** CH-11. **Risk:** medium — a reducer change with two native mirrors; the parity family is the guard (`ci.yml` foray-engine-core `swift test`; `android-build.yml:436` ParitySuite) and the only behaviour change is for a kind no published Foray uses.

**Tests.** Characterization FIRST: queue-state tests pin TTS → `resetRateForTTS`, EPISODE → `restoreRate`. New: reducer emits `resetRateForTTS` for JINGLE (kills dropping the branch); the fixture case kills either native drift. Quote the green `ios-kit` and `android-build` runs.

### CH-18 · Delete the duplicate `.show-ep-search input` CSS block (qwen, XS)

**Issues:** X1-15.

**Exact change.** Delete `styles.css:3974–3978` (the Playlists-section copy of 3776–3780). No visual change: the later block won the cascade with identical declarations.

**Files:** `styles.css`, `test/styles-duplicates.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-09a (sequencing only). **Risk:** none.

**Tests.** A test greps styles.css for `body.ui-v2 .show-ep-search input` and asserts exactly one occurrence (kills re-adding).

### CH-22 · Foray page lifecycle: one resolve call, one resume-point read, state cleared on leaving the page (opus, M)

**Issues:** A3-01, A3-02, A3-03.

**Exact change.** (a) `resolveListedForay` (15525–15535) is the only `player.resolve(` call: `restoreLastForayRibbon` (15655–15667) and `foraySurfaceSignature` (19218–19223) call it; `renderForay` (14208–14213) wraps its resolve so a throw lands on the existing `statusPageHtml({ note: "Couldn't load forays right now.", retry: true })` branch with `bindRetry(retryForayDocs)`. (b) New `readForayPoint(player, r)` returning `{ resume, played }` (try/catch inside; `{ resolved: r, includeFinished: true }` only); `renderForay` (14265–14270) and `refreshForayResume` (15273–15281) use it; drop `bindForayTransport`'s `resume` param (15005, 15037–15038) and read `state.forayResume` in the restart handler; update the one caller at 14374. (c) New `leaveForayPage()` clearing `state.foray`, `state.forayPlaying`, `state.forayPainted`, `state.forayResume`, `fbTarget` and `forayPaintedLive` (moved onto `state`), and calling `player.watchForay(null)` (client.js 5619 accepts null); `renderCurrentPage` (18069–18081), `deleteMyData` (17187–17190) and `guardForayStart` (14943) call it.

**Files:** `app.js`, `test/foray-page.test.js`, `test/now-playing-ribbon.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** medium — `renderForay` is the busiest function in the file; keep the diff to the named functions. app.js regions: 14153–14270 (resolve + point read only), 14943, 15005–15038, 15269–15344, 15519–15535, 15609–15667, 17187–17190, 18069–18081, 19218–19223.

**Tests.** Characterization FIRST: the page renders "Resume" for a part-played Foray and "Start over" for a finished one; the now-playing bar restores a Foray on boot; navigating Home then back re-renders the page. New: a resolve that throws paints the retry note on the Foray page (kills removing the wrap) and the ribbon falls through to `restoreLastEpisode` (kills the `||` chain skipping); after navigating to Home, `paintForay(IDLE)` does not write `state.forayResume` and `state.foray` is null (kills dropping `leaveForayPage`). **Mutation for (b):** `bindForayTransport`'s restart logs `resumed_from_sec` from `state.forayResume`.

### CH-23 · One shell detector, one hash rewriter, one fetch shape, one origin literal, one pin write (qwen, S)

**Issues:** A1-05, A3-04, X1-08, A3-09, A3-15, A3-16, A1-17. **Behaviour-preserving dedup in app.js's boot/shell region.**

**Exact change.** (a) `function shouldRegisterServiceWorker(win) { return !isNativeShell(win); }` (19902–19915) and rewrite the 1247–1261 header to describe `isNativeShell` (drop the retired U-02 flag text and the false hoisting justification). (b) `enterForayFromQuery` (18058–18060) calls `replaceHash("#/foray/" + encodeURIComponent(id))` instead of inline `replaceState`. (c) SW message handler 20032–20056: drop the redundant `pinnedDeployId = msg.deployId` or replace with an equality check that logs a diagnostics row on mismatch; `window.ForayNav` (15946–15948) exports only `landOnPage` and `announce`; `test/drawer-ownership.test.js` reaches `handleBack` through the vm harness. (d) `fetchJsonAt(url, ms)` inner helper; `fetchJson`/`fetchApiJson` (18996–19036) keep their names and signatures (`tools/mobile/prepare-webdir.mjs:495` regex matches call sites by name). (e) `const PUBLIC_WEB_ORIGIN = API_ORIGIN + "/"` (5468); keep `test/share-links.test.js:264` as the pin.

**Files:** `app.js`, `test/drawer-ownership.test.js`, `test/share-links.test.js`, `test/routing.test.js`, `tools/mobile/shell-invariants.test.mjs`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** —. **Risk:** low. app.js regions: 552, 1247–1275, 5468, 15946–15948, 18058–18060, 18996–19036, 19902–19915, 20032–20056 — disjoint from CH-22.

**Tests.** Characterization FIRST: shell-invariants already pins registration stays behind `shouldRegisterServiceWorker` and the throwing-bridge case; `test/data-deletion.test.js:1802–1811`; a routing test pins that `?foray=<id>` on init lands on `#/foray/<id>` and that a bare hash goes to `relaunchRoute()`. New: a harness where `replaceState` does not reflect into `location.hash` still lands on the Foray route (kills reverting to inline `replaceState`); `fetchJson` and `fetchApiJson` both abort on deadline with the same shape (kills a one-sided fix); `ForayNav` has no `handleBack` (kills re-exporting). Run `tools/mobile/prepare-webdir.test.mjs` (the fetchJson scanner).

### CH-24 · `player/duration.js` owns the hours-minutes tail; progress modules share `MAX_AGE_H`; test-only exports go (qwen, M)

**Issues:** P1-14, P2-07, X1-02, P2-17, P2-16. **Module-side dedup**; app.js's `fmtDur` stays the pinned classic-script copy (it renders cards before the deferred module loads; `test/episode-page.test.js:134` runs without `ForayPlayer`).

**Exact change.** New `player/duration.js` exporting `hoursMinutes(mins)` (the shared "1 hr 5 min" tail) and `fmtSpan(sec)` (the <90 s "N sec" rung on top); `foray-resolve.js` re-exports `fmtSpan` from it; `episode-progress.js` `fmtMinutes` (138–150) and `foray-progress.js` `remainingLabel` (383–399) call `hoursMinutes`. `episode-progress.js` imports `MAX_AGE_H` from `foray-progress.js` (or both from `position-store.js`) and re-exports. Delete `canSeekExactly`/`canPlaySegment` (seek-policy.js:255–264), `renderStrip` and its header prose (segment-strip.js:689–708), the unreachable "finished" branches (episode-progress.js:160, foray-progress.js:384 → return `PLAYED_LABEL` or null) and their tests; LEAVE foray-progress's `failedWrites` alias (parity `counters` fixture + `ForayProgressFamily.swift`).

**Files:** `player/duration.js`, `player/foray-resolve.js`, `player/episode-progress.js`, `player/foray-progress.js`, `player/seek-policy.js`, `player/segment-strip.js`, `player/seek-policy.test.js`, `player/segment-strip.test.js`, `player/episode-progress.test.js`, `player/foray-progress.test.js`, `test/format-helpers.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-11 (segment-strip). **Risk:** low. The `fmtDur` comment update rides in CH-29.

**Tests.** Characterization FIRST: `test/format-helpers.test.js:102–133` already pins the dialect across four files; add `fmtDur(m) === fmtSpan(m*60)` for m in [2, 59, 60, 61, 125] (reads app.js via vm, no app.js edit) and `fmtMinutes(m) === fmtDur(m)` for m ≥ 1. New tests kill: a tail change in duration.js that foray-progress does not follow (its `remainingLabel` test compares to `hoursMinutes`); `MAX_AGE_H` drift (assert `episode-progress.MAX_AGE_H === foray-progress.MAX_AGE_H`). Run `node tools/parity/record.mjs --check` (the `foray-clock` family exercises `fmtSpan`; a re-export must not move it). Floors: seek-policy from 35, segment-strip from 52, format-helpers from 18 — set exact where tests are deleted.

### CH-25 · One load-in-flight marker: a failed load reaches the reducer once (opus, M)

**Issues:** P1-02. **Structural fix**; today's symptom is a duplicate `player.error` row and a second failure paint.

**Exact change.** Option (b) from the issue: `queue-manager.js` keeps ONE `_loadInFlight = { id, seq }` around every `backend.load` call; `_onBackendError` checks it once and defers to the load rejection path; delete `_narrationLoadInFlight`/`_clipLoadInFlight` (784–790), the two try/finally blocks in `_loadRenderedOrCatch` (2116–2134), the two cases in `_onBackendError` (2171–2181) and the dual regex in `narrationFallbackReason` (440; keep one spelling of the code, and make html-audio-backend's `onErr` message carry it). Rewrite header §14 and §16 (207–219, 2106–2115) as one paragraph.

**Files:** `player/queue-manager.js`, `player/html-audio-backend.js`, `player/queue-manager.test.js`, `player/html-audio-backend.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-05, CH-21. **Risk:** medium — the error-ordering trap the headers describe is real; the 225-test characterization suite is the guard. Run `--check` (manager-episode family unchanged).

**Tests.** Characterization FIRST (queue-manager.test.js): a failed rendered-narration load speaks the line from its script; a failed clip load retries then skips (the Phase 2 and NE-45j cases) — must stay green. New: a plain episode whose load errors emits exactly ONE `player.error` telemetry row and ONE `pausePlayback` effect (kills removing the marker); a narration load error still falls back exactly once (kills over-suppression). Bump queue-manager floor from 225.

### CH-26 · Delete the dead `ForayPlayer` members: `cycleRate`, `stripModel`, `stripSummary`, `lastVoiceFallback()` (qwen, S)

**Issues:** P1-12. **Deletion.**

**Exact change.** Remove the four members from the `ForayPlayer` object in `player/client.js` (5046–5050, 5143–5156, 5232–5238) and the `nextRate` import (140); keep `segmentStripHtml`/`stripInto`/`stripTally` and `manager.lastVoiceFallback` (parity). In `player/foray-playback.test.js` drop the `cycleRate` stub from the bridge fake (1059) and retarget the 2590–2603 mutation note (the "no shipped control cycles" assertion still holds against the rate buttons).

**Files:** `player/client.js`, `player/foray-playback.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-10. **Risk:** low. client.js region: the `ForayPlayer` object members named; no other client.js card in wave 3.

**Tests.** Characterization FIRST: a test greps app.js, index.html and sw.js for `.cycleRate|.stripModel|.stripSummary|.lastVoiceFallback` and asserts zero hits, then asserts the members are absent from `window.ForayPlayer` (kills re-adding). Set the foray-playback floor exact.

### CH-27 · `download-store.readSource` is the one "open a downloaded file from the WebView" rule; id3-chapters uses it (qwen, S)

**Issues:** P2-18.

**Exact change.** Add `readSource(record, bridge)` to `player/download-store.js` beside `playSource` (346–362): same done+path gate, a WebView-fetchable URL (`bridge.fileSrc` first, `file:` refused), with the reason documented. `player/id3-chapters.js` `localSrc` (351–359) calls it.

**Files:** `player/download-store.js`, `player/id3-chapters.js`, `player/download-store.test.js`, `player/id3-chapters.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-02. **Risk:** low.

**Tests.** Characterization FIRST: id3-chapters tests pin that a done record yields the `fileSrc` URL and a `file:` `webSrc` is refused; download-store tests pin `playSource`'s gate. New: a `done` row whose status normalises to `missing` yields null from `readSource` and id3-chapters skips the fetch (kills reverting to the inline gate). Bump download-store floor.

### Wave 4 — app.js helper unification, queue-strategy deletion, vocabulary pins (4 cards; app.js slots: CH-28, CH-29; client.js slot: CH-30)

### CH-28 · Small helper unification: taxonomy lookups, interest commits, generated-playlist literal, one player-bridge wait (qwen, M)

**Issues:** A1-08, A1-13, A1-14, A1-15, A1-18, A3-13, X1-20. **Behaviour-preserving dedups in app.js.**

**Exact change.** (a) Delete `leafNodes` (814–816) and the "kept distinct from leafNodes()" sentences (819–825, 832, 4294); change `test/diagnostics-surface.test.js:549` boundary to `function taxonomyNodes`. (b) Inline taxonomy finds at 2125, 4138, 4262, 4365 → `nodeById` (827); `subjectLabel`: `const n = nodeById(branch); return n && n.parent === null ? n.label : branch`. (c) Delete `boostTopics` (958); 1829 calls `nudgeTopics(entry.topics, 0.05)`; update the two test comments. (d) `commitInterests()` = `saveInterests` + `_interestsGen` bump, used by `nudgeTopics` (947–955), the slider and reset (1057–1083), persona seed (6978), onboarding lifts (7025–7030) and 17186. (e) `slotItemIdSet(slots)` and `generatedPlaylistFor(node, items)` shared by `generatedPlaylists`/`generatedPlaylistById` (2231–2284). (f) `whenPlayerBridge({ timeoutMs })` resolving `{ player, late }` so the `late` flag the boot waits pass (15643 `whenLaneKnown(true|false)`) survives; used by `playerBridge` (13458–13477, 5000) and the two boot-time waits (15642–15643, 16484–16485, `timeoutMs` null = unbounded, preserving their semantics); hoist `const PLAYER_READY_EVENT = "forayplayer:ready"` and use it at 225, 314 and in the helper; add a test that greps client.js:5767's dispatch and app.js's constant for the same literal (no client.js edit).

**Files:** `app.js`, `test/diagnostics-surface.test.js`, `test/episode-search.test.js`, `test/player-ready-event.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-22. **Risk:** low. app.js regions: 225/314, 814–829, 858–958, 1057–1083, 1829 (one line), 2125, 2231–2284, 4138/4262/4365, 6978, 7025–7030, 13458–13477, 15642–15643, 16484–16485, 17186 (one line; CH-22 owned 17187–17190).

**Tests.** Characterization FIRST: `searchCache` invalidates after a slider change (`buildPlaylist` re-ranks after `setInterest`+commit); `generatedPlaylistById(id)` deep-equals the matching entry of `generatedPlaylists()`; a module arriving at 7 s still restores the ribbon and engine rows WITH `late === true` (kills routing them through the 5 s bound or dropping the flag); diagnostics-surface green with the new boundary. **Mutations:** assert `_interestsGen` increments once per `commitInterests` call; `subjectLabel` of a leaf id returns the id (kills dropping the `parent === null` check).

### CH-29 · One indexed title→catalogue-show join; show-page count label and pool helpers simplified; Family Mode / back-link / fmtDur comments corrected (qwen, M)

**Issues:** A1-06, A1-11, A1-12, A1-16, A1-19, P1-14 (comment half). **Behaviour-preserving.**

**Exact change.** (a) Extend `catalogShowIndex` with `catalogShowByTitle(title)` (forward + `TITLE_ALIASES`, built once per `state.catalog.shows`); `catalogShowForItem` (1546–1564), `episodesForShow` (3954–3961), `showArtworkUrl` (4036–4051), `showIdForShowName` (4064–4079 → `catalogShowByTitle(name)?.show_id ?? showIndexIdForTitle(name)`, no longer O(shows) per row) and `foraysUsingShow` (5230–5240) use it; rewrite the 3999–4002 comment. (b) `showEpisodeCountLabel` (5285): drop `isBreadthTier` and `loadError` from signature and caller (6029–6038); delete `lastLoadError` (5846, 6273, 6315) if nothing else reads it; plurals at 5333/5339/6092 via `countLabel`. (c) `function queueIds() { return stringList(storedValue("cp_queue", [])); }` (2924–2932, fix the "line ~810" pointer); one `ensurePool()` for `hydrationPool` (2538–2543) and `inDiscoverPool` (5472–5477). (d) Comments: `explicitBadge` header (1566–1573) and section header (1243–1244) point at `familySafe`'s rule table (1466–1478); `renderStarredShows` (1962–1964) says Library is the parent; `fmtDur` header (1609–1624) states the deliberate rounding and that `fmtSpan`'s sec rung differs on purpose, pinned by test/format-helpers (CH-24).

**Files:** `app.js`, `test/show-page.test.js`, `test/up-next-queue.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-24. **Risk:** low. app.js regions: 1243–1244, 1546–1573, 1609–1624, 1962–1964, 2538–2543, 2924–2932, 3954–4079, 4114, 5230–5240, 5285–5345, 5472–5477, 5846/6273/6315, 6029–6038, 6092 — disjoint from CH-28.

**Tests.** Characterization FIRST: show page for a `TITLE_ALIASES` show lists its episodes, artwork and Forays (one test covering the five joins with a second alias injected into a test `TITLE_ALIASES` copy — kills any one site missing the index); `showEpisodeCountLabel` outputs for the table of (loadedCount, familyHidden, fullyLoaded, curatedCount, stale, loadState) unchanged (snapshot before/after); `queueIds` drops non-string ids. **Mutation:** "1 episodes" from a hand-rolled plural fails the `countLabel` assertion.

### CH-30 · Delete `queue-strategy.js`; `setQueueFromPick` builds the one-item queue directly (opus, M — human merge)

**Issues:** P1-09, P2-10. **Deletion of speculative configurability.**

**Exact change.** Remove `player/queue-strategy.js` and `index.html:109`'s modulepreload; in `queue-manager.js` drop the `strategy`/`context` options and `assertStrategy` (263, 493, 566, 583, 890), `setQueueFromPick(picked)` → `this.queue = picked ? [picked] : []` keeping the `queue.built.SINGLE_ITEM` telemetry token literally (`diagnostic-log.js:649`, manager-episode parity fixtures); `client.js` drops the import and option (97, 4194); `native-facades.js:283–296` comment updated; `tools/mobile/probe/install-probe.mjs:121` dependency list updated; one-line product-principle note kept in queue-manager's header. Rewrite the ~10 queue-manager.test.js tests (147–299) and html-audio-backend.test.js:371/430 that used `PICKED_FIRST` to build multi-item queues onto `loadQueue([...])` — the assertions stay identical. Update `player/parity/exclusions.json` 750–770 (four entries whose `why` cites queue-strategy.js and whose test names change) so `player/parity/coverage.test.js` (floor 37) stays green.

**Files:** `player/queue-strategy.js`, `player/queue-manager.js`, `player/client.js`, `player/native-facades.js`, `index.html`, `player/queue-manager.test.js`, `player/html-audio-backend.test.js`, `player/parity/exclusions.json`, `player/parity/coverage.test.js`, `tools/mobile/probe/install-probe.mjs`, `tools/mobile/probe/install-probe.test.mjs`, `test/suite-integrity.test.js`. **Governed:** `index.html`. **Depends on:** CH-25, CH-07. **Risk:** medium — wide test rewrite; keep each test's assertions byte-identical and only change queue construction. client.js region: the import line and the manager construction (4194).

**Tests.** Characterization FIRST: those tests pass before the rewrite; `queue.built.SINGLE_ITEM.n=1` telemetry row still emitted (kills renaming the token). Required green: `node --test player/parity/coverage.test.js`, `node tools/parity/record.mjs --check` (manager-episode unchanged), `test/boot-path.test.js` (manifest/preload list). Floors: queue-manager and html-audio-backend counts may move; set exact.

### CH-31 · Cross-module vocabulary pins: session errors, data file keys, owned `cp_` prefixes (qwen, S)

**Issues:** P2-08, X1-10. **Drift-risk pins; no behaviour change.**

**Exact change.** Move the `cp_` key strings (foray-progress `KEY_PREFIX` :39, episode-progress `KEY` :37, the position key prefix) into `player/engine-vocabulary.js` (pure data) and import them in `foray-progress.js`, `episode-progress.js` and `engine-contract.js` (`OWNED_PREFIXES` :79) — keeps engine-contract's one-import rule (45–51). New `player/vocabulary-pins.test.js`: `[...diagnosticLog.SESSION_ERRORS]` deep-equals engine-vocabulary `SESSION_ERROR_DETAILS` (885–889 vs 73–77); diagnostic-log `DATA_FILE_KEYS` (770) deep-equals foray-directory `FILE_KEYS` (98); every foray-directory `SOURCE_*` and catalogue-directory `SOURCE` token is in diagnostic-log `DATA_SOURCES` (768). `diagnostic-log.js` keeps its no-import design.

**Files:** `player/engine-vocabulary.js`, `player/engine-contract.js`, `player/foray-progress.js`, `player/episode-progress.js`, `player/vocabulary-pins.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-24, CH-19. **Risk:** low.

**Tests.** Characterization FIRST: engine-contract.test.js's `cp_` pins stay green through the move. **Mutation:** adding a 13th session token to engine-vocabulary alone fails the pin (the L13 gap).

### Wave 5 — listener-visible copy fixes and player prose (3 cards; app.js slots: CH-32, CH-33; client.js slot: CH-34)

### CH-32 · Home and Forays page: one Foray start path, one Jump back in renderer, one "played" reading, one stretch sentence, true Home header (opus, M)

**Issues:** A2-02, A2-03, A2-04, A2-08, A2-14. **Three listener-visible copy/consistency fixes** (A2-03 duplicate stretch sentence, A2-04 "3 of 12 played" vs "1 played", A2-08 Home-vs-`#/forays` Jump back in disagreement) **plus two dedups.**

**Exact change.** (a) `startForayCold(player, r, { startElapsedSec|startIndex, discoverDoc })` does resume → `playForay` → one `logEvent("foray_play")`; `startHomeForay` (10743–10790) and `bindForayTransport`'s start/startAt/startOrResume (15023–15088) call it, each keeping its own failure painter; fix the 10623–10627 header. (b) Stretch reason stated once: drop the hv2-bridge append in `miniCardV2` (11098–11109) so `miniCardV2 === miniCard` (keep `STRETCH_WHY` in the hook); move up-next-autoadvance.test.js:705's pin to the hook sentence; delete the stale hover-title comment. (c) `jumpBackInEntries` (10864–10873) counts `rowProgress(r.item)?.state === "played"` like the playlist page (11477–11486); `hasOpened` stays for the next-up marker. (d) `renderForays` (11230) renders `jumpBackInV2Html(jumpBackInEntries().filter(e => e.kind === "foray"))` (content rule preserved: Forays only there); delete `jumpBackInHtml` (15698–15708) and the `.fy-jbi-row` CSS family (styles.css:3383–3384, 3858); rewrite the 11161–11165 header. (e) Delete the four-card header (10456–10483) keeping the IA table; drop "behind cp_ui_v2"; KEEP the `renderHome()` alias (10489–10491) with one sentence that `renderHomeV2` is the name the tests use and `renderHome` the name `renderCurrentPage` calls — no rename.

**Files:** `app.js`, `styles.css`, `test/listener-copy.test.js`, `test/up-next-autoadvance.test.js`, `test/home-play.test.js`, `test/home-v2.test.js`, `test/jump-back-in-kinds.test.js`, `test/forays-page.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-22. **Risk:** medium — the `#/forays` Jump back in markup changes to the Home card (listener-visible by design; content rule unchanged — say so in the PR; founder Q5 default). app.js regions: `miniCard` 6794–6820 (read only), 10456–10497, 10577, 10623–10790, 10823–10982, 11098–11109, 11126, 11161–11165 + 11230, 15023–15088, 15698–15708.

**Tests.** Characterization FIRST: Home and Foray page start a new/part-played/finished Foray at the same index/elapsed (one table test over both buttons via the fake player); Home stretch card contains "Outside your usual subjects" exactly once after the change (first assert twice to document today, then flip); Home card count equals page header count for 3 opened / 1 finished of 12 (kills reverting to `hasOpened`); `#/forays` Jump back in shows the same Foray row Home shows (kills a third renderer). **Mutation:** a second `logEvent("foray_play")` fails the one-event assertion.

### CH-33 · Chapter rows say one thing: notes-promoted stamps use the chapters section's precision rule; device-chapter fetch reads the id3 module's deadline and UA (opus, M)

**Issues:** A2-05, A2-10, P2-13, X1-01. **Listener-visible bug fix** (A2-05: the same stamps read "~68 min / approximate" in Chapters and "1:08:12" exactly in Episode notes on a DAI show).

**Exact change.** (a) `episodeNotesTokens`/`descTokenHtml` (11701–11721) receive the item/precision and format time + aria-label through the same seek-policy call `episodeChaptersHtml` uses (11841–11859); do not promote a chapter row in the notes when `episodeChapterList(item)` already renders those stamps from the description, and require the two-ascending-stamps rule (11883–11886) before promoting (a lone prose stamp stays a plain seek link, not a 44 px chapter row). (b) Drop the inline `~${mins} min` / `around minute ${mins}` fallbacks (11846–11850): render approximate chapters only once `window.ForaySeekPolicy` is present (the exact branch keeps `fmtChapterTime`, which is pinned); optionally prefer `p.formatTimestamp(c.secs, p.EXACT)` when present. (c) `player/id3-chapters.js` exposes `CALL_TIMEOUT_MS` and `shellUserAgent()` on the object `createId3Reader` returns (client.js:191 publishes it as `window.ForayId3Chapters` — no client.js edit); `readDeviceChapters` (11953–11963) reads them and drops the literal 8000. **The device-chapter deadline moves from 8 s to the module's 10 s — the listener-visible timing change (founder Q4 default).** (d) Reword seek-policy.js:365–370 (app.js reads the PRECISION rule; the clock text is copied as `fmtChapterTime` and pinned by test/clock-formatters.test.js).

**Files:** `app.js`, `player/id3-chapters.js`, `player/seek-policy.js`, `player/id3-chapters.test.js`, `test/episode-chapters-visible.test.js`, `test/episode-page-publish-date-description-chapters.test.js`, `test/clock-formatters.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-27, CH-24. **Risk:** medium. app.js regions: 11701–11721, 11825–11886, 11931–11963 — disjoint from CH-32.

**Tests.** Characterization FIRST: a feed-chapter episode renders N rows with exact stamps; a DAI show renders "~N min" and the approximate note. New: DAI show with chapters only in the notes — Chapters section and Episode notes carry the SAME label text for the same stamp (kills the inline exact stamp); a lone prose stamp in the notes is not an `.ep-chapter-row` (kills promoting single stamps); `readDeviceChapters`'s timeout equals `ForayId3Chapters.CALL_TIMEOUT_MS` (kills the literal).

### CH-34 · Player comments that lie, one stop-snapshot shape, `routeChanged` prose, web `setVolume` deleted (qwen, S)

**Issues:** P1-05, P1-08, P1-11, P1-13. **Mostly text, two small deletions.**

**Exact change.** (a) Fix "exactly two `<audio>` elements" (html-audio-backend.js:26–34; client.js:205–207, 4187–4189, 4296–4303) to say the warm element exists only with `prefetch: true`, which production does not pass (P1-03 park); fix "the episode clock rounds" (client.js:1908–1911 — `hms` floors). (b) `emptyForaySnapshot(resolved)` that `forayStateSnapshot` (1742–1783) spreads over and `stopAndClose` (3036–3045) returns, so `gap`/`rate`/`voiceFallback` are present on stop; app.js:15440's `rate != null` guard becomes belt-and-braces (no app.js edit). (c) queue-manager.js `setOutPoint` refusal comment (1659–1666): the second entries are `loadQueue()` and the parity runner's `restoreColdLaunchState` step; production Foray cold-restore is `restoreForay` → `setQueueFromForay` in client.js; mark `restoreColdLaunchState`'s JSDoc as a parity/Swift-mirrored seam. (d) `routeChanged` (1327–1349): drop the `routeName`/`isCarRoute` prose, add one line that the `false` arm is parity-only (reducer token shared with the Swift ports — keep); queue-manager.test.js:417/423 stop passing the ignored args. (e) Delete web `setVolume`/`_volume` and the backend's `carry-volume` action body (html-audio-backend.js:13, 507–509, 1204–1206, 2030–2039) and its two tests (306–309, 2168) — the `carry-volume` step becomes a no-op on the web backend so the `deck` family fixture (`player/parity/fixtures/deck/deck-pair.json`) does not re-record; leave deck-policy.js `handoverSteps`/`deckVolume` and the Swift enum (`DeckPair.swift` executes carry-volume live).

**Files:** `player/queue-manager.js`, `player/html-audio-backend.js`, `player/client.js`, `player/queue-manager.test.js`, `player/html-audio-backend.test.js`, `player/foray-playback.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-25, CH-30. **Risk:** low-medium — (e) touches the parked handover path; the no-op keeps parity fixtures stable. client.js regions: comments at 205–207, 1908–1911, 2229–2231, 4187–4189, 4296–4303 and `forayStateSnapshot`/`stopAndClose` 1742–1783, 3036–3045.

**Tests.** Characterization FIRST: foray-playback.test.js pins the live snapshot keys; new test asserts the stop snapshot has the same key set (kills dropping `emptyForaySnapshot`); html-audio-backend test asserts `setVolume` is absent and a `carry-volume` step is a no-op on the web backend. Run `--check` (`deck` family unchanged). Set floors exact where tests are deleted.

### Wave 6 — rows, search constants, audibility (3 cards; app.js slots: CH-35, CH-36)

### CH-35 · Row templates and Up Next/Library hygiene: progress chip, playlist row, Play-next rule, repaint helper, stale Create/Library comments (qwen, M)

**Issues:** A2-01, A2-06, A2-07, A2-12, A2-13, A2-18, A2-19. **Behaviour-preserving dedups** (A2-17 moved to CH-36).

**Exact change.** (a) `progressChipHtml(item)` used by `epRow` (11333–11336), `renderEpisode` (12089–12092), `upNextRow` (12181–12184; passes null when `!playable`). (b) `upNextRow`'s `playNextDisabled` (12198–12205) becomes `!playable || isCurrent || !rules || rules.playNextOrder(ids, id, cur) === ids` (keep `isCurrent` — `ForayPlayer.isCurrent(id)` and `currentPlayingId()` can differ while the app's pointer lags; missing `queueOrderRules()` = disabled). (c) `playlistRowHtml(p, { badge, sub })` for `renderPlaylists` (13155–13161), `renderPlaylistSearchResults` (9873–9881; gains `playedOnLabel` so Search matches the page it claims to match — listener-visible only as the "· played yesterday" suffix appearing in Search; say so) and Library summaries (12601–12609 shell stays). (d) `repaintLibraryIfShown()` for 12755, 12934, 12949, 13135; `UP_NEXT_EMPTY_NOTE` for 12151/13106. (e) Delete the unreachable `|| {...}` snapshot fallback (10232–10244). (f) Comments: Library link-out parenthetical (12579–12585) deleted; Create/`bindCreateFormSubmit` headers (13164–13213) describe the one builder and `whenSearchDataReady`.

**Files:** `app.js`, `test/up-next-queue.test.js`, `test/episode-page.test.js`, `test/playlists-page.test.js`, `test/episode-search.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-01, CH-29, CH-33. **Risk:** low. app.js regions: 9873–9881, 10232–10244, 11333–11336, 12089–12092, 12151, 12170–12205, 12311–12321, 12579–12609, 12755/12934/12949, 13106, 13135, 13144–13213 — nothing below 9873 (CH-36 owns 8534–8580 and 10386).

**Tests.** Characterization FIRST: `upNextRow`'s disabled state for every reachable row state (current, right-after-current, head with nothing playing, mid-list, AND `isCurrent === true` with `id !== cur`) unchanged — table test before and after (kills a rules-call that diverges or drops `isCurrent`); the three progress chips are byte-identical for a part-played item; Search playlist row contains `playlistLengthLabel` (today) then also `playedOnLabel` (after). **Mutation:** a chip change in one template fails the identity test.

### CH-36 · Search/engine constants hygiene: `branchOf`/`foldDiacritics` reused or pinned, dead symbols, the pre-S-04c shard-cache branch, the offline predicate (opus, S)

**Issues:** A2-11, A2-15, A2-16, A2-17, X1-05, X1-06, X1-09, X1-19. **Behaviour-preserving.**

**Exact change.** (a)/(b) PREFERRED: delete app.js `branchOf` (1710–1713) and have 1498, 2059, 2150 call `SearchEngine.branchOf` at runtime, and compose `normaliseShowTitle` (8763–8765) over `SearchEngine.foldDiacritics` — ONLY IF every Home-grouping and show-dedup harness (including `test/show-search-fallthrough.test.js` and `test/card-anatomy.test.js`) loads `search-engine.js` cheaply. Forbidden: `typeof SearchEngine !== "undefined" ? … : localCopy` fallbacks (they recreate the duplicate). OTHERWISE keep both app.js copies and add a pin test asserting `branchOf(id) === SearchEngine.branchOf(id)` and `normaliseShowTitle(t)` equals the engine-composed form over a fixture. Say which path was taken in the PR. (c) `generatedPerShowCap()` reads `SearchEngine.PER_SHOW_CAP` lazily at 2220 with `GENERATED_PER_SHOW_CAP` as the no-engine fallback (never a top-level `SearchEngine` read). (d) 6848 uses `isForayNarration(i)`; add the entry-shape sentence to its comment (13628–13630). (e) KEEP `SHARD_CACHE_NAME` at `-v1` (sw.js:352–363 names it as a cache the worker must not delete; `deleteMyData` 16831 deletes only the current name — a bump would orphan every device's v1 bucket); delete the `Array.isArray(parsed)` branch (8566–8580) so a bare array falls to `return null` (miss → refetch → rewritten: identical outcome to today's stale-once self-heal) and update the 8560–8568 comment. (f) Delete `|| p.name` (10869); drop `openSheetCount` from `window.ForaySheets` (7695; function stays); cite `SHOW_PREFIX_UNDERDELIVERS_BELOW`'s number in prose and update `test/show-search-reach.test.js:223`; KEEP `SHOWS_SEARCH_OFF_DEVICE` and its release-gates tripwire. (g) `OFFLINE_SEARCH_NOTE` comment (8226–8233) states downloads exist; the note copy stays ("Episodes need a connection." — downloaded episodes are reachable from Library; note that). (h) A2-17: rename `isOfflineForShardSearch` (8552–8554) to `isOffline` and call it at 10386.

**Files:** `app.js`, `test/show-search-reach.test.js`, `test/show-search-fallthrough.test.js`, `test/card-anatomy.test.js`, `test/shard-cache.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-28, CH-32. **Risk:** low — (e) no longer invalidates any cache. app.js regions: 1498/2059/2150 one-liners, 1710–1713, 2194–2220, 6848, 7695, 8215–8233, 8323, 8534–8580, 8763–8765, 10386, 10869, 13628–13630.

**Tests.** Characterization FIRST: a show title with "Café" and "Cafe" dedups to one via `normaliseShowTitle`; generated playlists hold at most 2 per show; a bare-array shard cache entry is treated as stale once (today) — flip to "treated as a miss once" (same network cost); Home branch grouping for a "science/physics" topic lands in "science"; the offline note still renders when `navigator.onLine === false`. **Mutation:** a top-level `SearchEngine` read breaks `test/api-origin.test.js` (no search-engine.js) — the lazy test loads app.js alone and asserts no ReferenceError.

### CH-37 · The backend answers "audible?" itself; `elementIsAudible` stops inverting the paused default (qwen, S)

**Issues:** P1-10. **Corner-case fix.**

**Exact change.** Add `get audible() { return this.el?.paused === false && this.el?.ended !== true; }` to html-audio-backend.js (beside 2054–2067; definite yes only) and mirror in `native-facades.js:141`; `queue-manager.js` `elementIsAudible` (1604–1607) reads `backend.audible === true`; `paused` stays for the towards-paused reconcile.

**Files:** `player/html-audio-backend.js`, `player/queue-manager.js`, `player/native-facades.js`, `player/html-audio-backend.test.js`, `player/queue-manager.test.js`, `player/native-facades.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-34. **Risk:** low.

**Tests.** Characterization FIRST: a paused element is not audible, a playing one is (both lanes). New: an element fake with `paused` undefined is NOT audible through the manager (kills reverting to `paused === false`). Bump floors.

### Wave 7 — onboarding sheets and the deadline helper (2 cards; app.js slot: CH-38; client.js slots: CH-38 voice members, CH-40 storageReady/voice bound)

### CH-38 · One onboarding sheet builder with per-sheet parked state; sheet owners hide; voice settings read the player's constants; `voiceState` shape true (qwen, M)

**Issues:** A2-09, A3-07, A3-10, A3-11, A3-12. **Behaviour-preserving.**

**Exact change.** (a) `openOnboardingSheet({ id, buildPanel, onDismiss })` returning `{ dismiss, park }`; parked state is a Set keyed by sheet id (so `firstRunParked` and `introParked` keep their independent meanings — a first-time user who parks the explainer still gets the intro popup this visit, as today); `showFirstTimeExplainerOnce` (7751–7800) and the intro popup (8008–8076) keep only content. (b) Delete the four `.hidden = true` after `closeSheet` (13962, 17096–17097, 17726–17727, 17911–17912); `closeSheet`'s not-found branch (7611–7620) hides once as belt-and-braces. (c) 17702 uses `FY_VOICE_FALLBACK`. (d) `voiceState` (17376): remove `selected`/`notice`, add `returnToAudition: null`; drop the write at 17534. (e) Expose `VOICE_LIST_LANG` and `qualityRank` on `window.ForayPlayer` beside `defaultVoice` (client.js ~5100–5240; default-voice.js already exports both) and read them in app.js 17314–17329 with the literals as the no-module fallback; for the nudge fallback (14997–15003) keep it and add a pin test importing `player/media-session.js`'s `SEEK_BACKWARD_SEC`/`SEEK_FORWARD_SEC` and comparing to app.js's literal (update transport-controls.test.js:206 to that shape); voice-settings.test.js:423 compares against default-voice.js's export.

**Files:** `app.js`, `player/client.js`, `test/transport-controls.test.js`, `test/voice-settings.test.js`, `test/modal-and-focus.test.js`, `test/first-run.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-36. **Risk:** low. app.js regions: 6911, 7611–7620, 7751–7800, 8008–8076, 13962, 14858, 14997–15003, 17096–17097, 17314–17376, 17534, 17702, 17726–17727, 17911–17912. client.js region: the `ForayPlayer` bridge object's voice members only.

**Tests.** Characterization FIRST (test/modal-and-focus.test.js, first-run tests): parking the explainer sets its parked flag and the scrim click parks; dismissing writes `cp_intro_dismissed`; each of the four sheets is hidden after close; **parking the explainer leaves the intro popup able to open the same visit** (kills a merged flag). **Mutation:** changing `SEEK_FORWARD_SEC` to 45 in media-session.js fails the new pin.

### CH-40 · `player/deadline.js`: one "race a promise against a deadline" and one `REAL_SCHEDULER` (opus, M)

**Issues:** P2-05. **Behaviour-preserving, parametrised.**

**Exact change.** New `player/deadline.js` exporting `withinMs(promise, ms, { fallback, reject, onTimeout, scheduler })` and `REAL_SCHEDULER` with `schedule` + `nowMs` (the queue-manager superset, carrying the un-unref'd-timer CI-hang note once). Replace: build-stamp.js:100–111, foray-directory.js:601–609 and 532–563, id3-chapters.js:333–337, download-bridge.js:136–166 (keeps `{ok:false, reason:"timeout"}`), engine-diagnostics.js:86–102 + 36–41, durable-store.js:1301–1326 (keeps `TimeoutError` rejection), client.js:495–499 and 3504–3508, native-engine.js:93–98, queue-manager.js:472–477. **The eight characterization tests are the FIRST commit of the PR, before `deadline.js` exists**, so a reviewer sees each contract pinned before the module is introduced.

**Files:** `player/deadline.js`, `player/deadline.test.js`, `player/build-stamp.js`, `player/foray-directory.js`, `player/id3-chapters.js`, `player/download-bridge.js`, `player/engine-diagnostics.js`, `player/durable-store.js`, `player/client.js`, `player/native-engine.js`, `player/queue-manager.js`, `player/build-stamp.test.js`, `player/foray-directory.test.js`, `player/id3-chapters.test.js`, `player/download-bridge.test.js`, `player/engine-diagnostics.test.js`, `player/durable-store.test.js`, `player/native-engine.test.js`, `player/queue-manager.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-04, CH-12, CH-13, CH-27, CH-33, CH-37. **Risk:** medium — nine files, but each swap is local and pinned. client.js regions: `storageReady` 495–499 and the voice lookup bound 3504–3508 only (CH-38 owns the bridge object).

**Tests.** Characterization FIRST (commit 1): each site's current visible contract pinned in its own test (resolve-null vs reject vs `{ok:false}`; timer cleared on settle; inner rejection swallowed or not) — eight small tests; they stay green after the swap. **Mutations:** flattening durable-store onto resolve-null fails its `TimeoutError` test; forgetting `clearTimeout` fails the "no live timer after settle" test (fake scheduler). Run `--check`.

### Wave 8 — the sweeps and the two app.js tails (3 cards; app.js slots: CH-39, CH-09b; `player/`: CH-41 only)

### CH-09b · Episode page lists bookmarks (PQ-15): tap = play-then-seek, Remove, precision-aware label (opus, M)

**Issues:** P2-02 (high). **A new listener surface**, justified: the sheet already announces "Bookmarked." for something no page shows, and `docs/legal/privacy-policy.md:137` already claims a list on the episode page. Follows the roadmap's own PQ-15 spec (`docs/roadmap/player-features.md:301–310`, "Do not touch: client.js, seek-policy").

**Exact change.** On the episode page (`renderEpisode` ~12089–12109, handlers near 12011) render `EPISODE_NAVIGATION.bookmarksFor(id)` as a list using `window.forayBookmarks.bookmarkLabel`/`bookmarkPrecision` (already published whole at client.js:171); label through `window.ForaySeekPolicy` precision so a DAI show reads "around minute N"; tap = play-then-seek via the existing stamp-tap path; a Remove control calls `window.forayBookmarks.removeBookmark` through `EPISODE_NAVIGATION`. styles.css gets one small block. No new `logEvent` type, no new `cp_` key.

**Files:** `app.js`, `styles.css`, `test/bookmarks-page.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-09a. **Risk:** medium — new surface; copy is the roadmap's. app.js region: `renderEpisode` bookmark section + its handlers (12011, 12089–12109) — disjoint from CH-39.

**Tests.** New `test/bookmarks-page.test.js`: the list renders N rows with precision-aware labels; Remove drops a row; a DAI label says "around minute". **Mutation:** a hand-rolled "at 1:02:03" inline fails the label test. `test/data-deletion.test.js` and `test/legal-citations.test.js` stay green untouched.

### CH-39 · Foray page: bridge capabilities made visible, true skew comments, cites join like credits, Search is a Foray surface, drawer counts corrected (qwen, M)

**Issues:** A3-05, A3-06, A3-08, A3-14. **Behaviour-preserving with one visibility gain.**

**Exact change.** (a) `bridgeCapabilities(player)` at the top of `renderForay` records which required exports are missing (console.warn + a diagnostics row) and the page degrades exactly as today (sw.js:73–93 relies on the degrade); inline `typeof` guards stay only for genuinely optional exports. Fix the six skew comments (14027–14029, 14843–14846, 14911–14914, 14947–14948, 15427–15430, 16768–16770) to cite the real remaining window (client.js's own fallback, web-only). (b) `citesHtml` (13787) calls `forayShowId`; an unlinked cite renders `<span class="fy-credit" data-credit-show=…>`; `joinForayCreditsToShowIndex` (14078–14101) includes cites in its unlinked test. (c) `isForaySurface` (19197–19202) adds `/^#\/shows\/q\//`; `repaintForaySurface` (19233–19242) gets a Search branch that re-runs `paintForaySearchResults` for the current query in place (keyboard and typed query survive, like the show-page footer branch). (d) Drawer/tab-bar comments: correct counts at 16120, 16206–16208, 19798–19799, 16289–16296 (five rows incl. engine-route-sharing), 19805; `renderTabBar` (16022–16024, 16083) describes create-once + sync aria-current.

**Files:** `app.js`, `test/foray-page.test.js`, `test/foray-credits.test.js`, `test/episode-search.test.js`, `test/drawer-settings-toggle.test.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-22, CH-38. **Risk:** low-medium — `renderForay` top is touched again after CH-22; rebase carefully. app.js regions: 10322–10350, 13663–13667, 13702, 13787, 14027–14029, 14078–14101, `renderForay` top (capability check only), 14843–14846, 14911–14914, 14947–14948, 15427–15430, 16022–16083, 16120–16296, 16358, 16768–16770, 19197–19242, 19798–19805.

**Tests.** Characterization FIRST: a Foray page with a bridge missing `stripTally` renders without the header counts (today) and after the change also logs one diagnostics row (kills a hard-fail page); a cite naming an index-only show links after the index arrives (kills skipping cites); a directory refresh while on Search results updates the Forays group without clearing the input (kills falling through to `renderCurrentPage`).

### CH-41 · `player/guards.js` owns `isNum`/`isObj`; the two `clampIndex` contracts get different names (opus, M)

**Issues:** X1-16, X1-17. **Repo-wide mechanical sweep, last so it conflicts with nothing.**

**Exact change.** New `player/guards.js` exporting `isNum`, `isObj` (array-rejecting); replace the 13 definitions (foray-resolve, foray-progress, foray-queue, foray-directory, foray-sources, foray-structure, media-session, playback-rate, queue-manager, segment-strip, locate-window, client.js `isFiniteNum`, bookmarks `isPlainObject`) with imports; `show-alerts.js` `isObject` (57) adopts the array-rejecting rule (document the change in its header; it has no production caller). Leave engine-contract.js's two one-liners (its one-import rule) and say so in guards.js. Rename foray-progress.js `clampIndex` (345–349) to `indexOrMissing` (client.js's 5746–5749 keeps `clampIndex`).

**Files:** `player/guards.js`, `player/guards.test.js`, `player/foray-resolve.js`, `player/foray-progress.js`, `player/foray-queue.js`, `player/foray-directory.js`, `player/foray-sources.js`, `player/foray-structure.js`, `player/media-session.js`, `player/playback-rate.js`, `player/queue-manager.js`, `player/segment-strip.js`, `player/locate-window.js`, `player/client.js`, `player/bookmarks.js`, `player/show-alerts.js`, `test/suite-integrity.test.js`. **Governed:** none. **Depends on:** CH-40, CH-39, CH-37, CH-34, CH-31, CH-24, CH-11. **Risk:** low per site, wide blast radius; the only `player/` card in its wave.

**Tests.** Characterization FIRST: a guards.test.js table (number, NaN, Infinity, "1", null, [], {}) and one assertion per module that its previous behaviour on a non-finite input is unchanged (reuse existing tests — they stay green). New: show-alerts rejects arrays (kills keeping the loose rule); foray-progress returns -1 for an out-of-range index under the new name (kills a semantic merge with client.js's clamp). Run `node tools/parity/record.mjs --check` (no fixture change expected).

## 4. Sequencing

Waves run in order; a wave starts when the previous wave's PRs are all merged and `node tools/parity/record.mjs --check` is green on `origin/main`. Within a wave every card is independent by file, so cards may run in parallel up to the machine's concurrency rule (README: one local agent at a time until the founder lifts it; CI-only work may overlap).

- **Wave 1** (7): CH-01, CH-02, CH-03, CH-04, CH-05, CH-06*, CH-07*. app.js: CH-01 (1875/3031/3083/3120/3786/2473/6596) and CH-02 (12644–12661). client.js: CH-02 (`localAttempt` success + `forayDownloads` publication) and CH-03 (`isPlaying` member).
- **Wave 2** (13): CH-08, CH-09a, CH-10, CH-11, CH-12, CH-13, CH-14, CH-15, CH-16, CH-17*, CH-19*, CH-20*, CH-21. app.js: CH-08, CH-09a. client.js: CH-10.
- **Wave 3** (8): CH-11b*, CH-18, CH-22, CH-23, CH-24, CH-25, CH-26, CH-27. app.js: CH-22, CH-23. client.js: CH-26.
- **Wave 4** (4): CH-28, CH-29, CH-30*, CH-31. app.js: CH-28, CH-29. client.js: CH-30.
- **Wave 5** (3): CH-32, CH-33, CH-34. app.js: CH-32, CH-33. client.js: CH-34.
- **Wave 6** (3): CH-35, CH-36, CH-37. app.js: CH-35, CH-36.
- **Wave 7** (2): CH-38, CH-40. app.js: CH-38. client.js: CH-38 (voice members), CH-40 (`storageReady`, voice bound).
- **Wave 8** (3): CH-41, CH-39, CH-09b. app.js: CH-39, CH-09b. `player/`: CH-41 alone.

`*` = human-merge PR (governed path). An Opus reviewer reads each DRAFT against its card (characterization tests present and green before the move; every named mutation run; nothing outside the file list changed; `--check` quoted where required), marks it ready and merges when CI is green; governed PRs wait for the founder.

**Cross-package rules that bind here:** only one `app.js` PR across ALL packages at a time (README "app.js is shared"); every floor edit is one line in `test/suite-integrity.test.js` — rebase and keep both lines; no card adds a `logEvent` type or a `cp_` key.

## 5. Deferred — founder or product rulings, not engineering

| issue | title | why deferred | what this package does meanwhile |
|---|---|---|---|
| N1-02 (high) | ~3,900 lines of Kokoro probe code, the `kokoroProbe` plugin method, ProbeLedger boot I/O and ONNX Runtime deps are in every shell build | K-01 is recorded as PARKED, not withdrawn (`docs/bundled-voice-plan.md:19`); deleting is a founder-ruling-sized change and the standing directive is route-don't-staff decisions. Recoverable from git either way. | CH-20 removes the weights from every shell build and fixes the stale probe comments, capturing the release-size and CI-fragility cost now. |
| P1-03 (low) | The two-element handover in `HtmlAudioBackend` (~500 lines, `prefetch` default off) is unreachable in production | A DOCUMENTED park with an open measurement question (`queue-manager.js` §11; `docs/research/mp1-background-audio.md` §4.1a); `test/suite-integrity.test.js:193–196` floors transport-reconcile part 2b precisely so it is not deleted as dead. Closing the question is an architecture decision. | CH-34 fixes the "exactly two elements" prose (option b in the issue). |
| X1-07 (low) | `cp_interlude`'s `"off"` spelling is in app.js (fallback) and interlude.js | Already guarded three ways: `test/drawer-settings-toggle.test.js:271–278` pins app.js's write to interlude.js's read, and the Swift engine reads the same key (`EngineConstants.swift:242`), so a re-encoding fails loudly. app.js:3341–3346 documents why the fallback exists (stale-SW 404 of the deferred module). A bridge export would spend a client.js slot for no behaviour gain. | Nothing; revisit if interlude.js changes its encoding. |
| X1-14 (low) | `vercel.json`'s `?v=` immutable rule fires on no request | A deliberate provision recorded in `docs/DECISIONS.md` (#606, "a cheap follow-up") and pinned by `test/vercel-headers.test.js` tests 3–4; build-or-retire is a product decision to log in DECISIONS.md (governed). Harmless today (the shell has no service worker). | Nothing; founder Q3 in §1. |

## Appendix A — the 116 verified issues

Format: **id** · title — *severity · category · verdict* → card. **Where:** locations at `cd410d29`. **Fails:** the failure scenario the verifier accepted (or "none today" when the cost is drift or hygiene). Verdict `adjusted` means the verifier corrected a claim; the correction is folded into the text below.

### A1 — app.js, storage / interests / taxonomy / playlists / queue (19)

**A1-01** · Up Next accepts pool episodes 4a cannot play: `liveEpisode` (gate) and `isPlayableId` (continuation) disagree — *high · inconsistency · confirmed* → CH-01. **Where:** app.js 3230–3243, 3022–3038, 3082–3083, 1864–1878, 3369, 3453, 11345, 12105, 12170–12175; test/up-next-queue.test.js 254, 292. **Fails:** listener taps "+ Up Next" on one of the 8 pool rows with no `audio_url`: the button flips to "✓ Up Next", the row lands on #/queue with no ▶, and when the previous episode ends `planAfterEnded` skips it. Queue count N, walk plays N−1.

**A1-02** · Two writers of `cp_playlists`: `playlists()`'s read-path `lsSet` can run between settle and the queued-edit flush and flip a save's outcome — *medium · duplicated-state · adjusted* → CH-08. **Where:** app.js 2662–2669, 2627, 406–413, 387–400, 2819–2847, 6901–6908, 6866–6872, 7757–7758. **Fails:** slow hydration; Home painted pre-hydration (onboarding waiter queued); listener saves a Suggested queue (edit queued). Hydration lands: the onboarding waiter → `isGenuineFirstTimeUser` → `playlists()` reads the overlay (copy included); a legacy list needs backfill → `lsSet` writes the overlay. The flush waiter then re-runs the edit over a list that already holds the copy → outcome `exists`; the listener is told the playlist already exists and no `playlist_saved` is logged.

**A1-03** · `cp_bookmarks` and `cp_engine_applied` still do raw lsGet→lsSet read-modify-write, the app-1-1 defect the file says it closed — *medium · inconsistency · confirmed* → CH-09a. **Where:** app.js 3531, 3564–3574, 3644–3646, 3678–3681, 306–321; player/bookmarks.js 70–83; player/client.js 3557, 4021, 4767. **Fails:** localStorage swept, IndexedDB slow. A bookmark tapped in the 5–30 s window reads `{}` and writes `{thisOne}`; durable-store then keeps that one-row map over the durable bookmark list. An engine attach in the same window reads watermark null and rewrites it low, so a redelivered hop logs `play_started` twice.

**A1-04** · `toggleShowStar` and `toggleStar` — described as mirroring each other "exactly" — handle a refused write and event order differently — *medium · inconsistency · confirmed* → CH-09a. **Where:** app.js 1799–1832, 1893–1918, 1886–1887. **Fails:** store at quota: Follow on a show page logs `show_starred` (synced) while the button repaints from storage as not followed. Same for a refused unfollow.

**A1-05** · `isNativeShell` is a copy of `shouldRegisterServiceWorker` under a retired-flag header with a false justification — *medium · duplicate · confirmed* → CH-23. **Where:** app.js 1247–1275, 19902–19915, 20018. **Fails:** none today (they agree). The next shell signal lands in one of them; the SW then registers inside the shell or chapters/relaunch logic treats the shell as web.

**A1-06** · The title→catalogue-show join (with `TITLE_ALIASES`) is implemented five times — *medium · duplicate · confirmed* → CH-29. **Where:** app.js 1546–1564, 3954–3961, 4036–4051, 4064–4079, 5230–5240, 3999–4002, 4114. **Fails:** a second alias is added and one of the five misses it: the show page lists zero episodes while its rows link to it. Today none (one alias). `showIdForShowName` is O(shows) per row.

**A1-07** · `savePlaylists` is called only by tests and hard-codes `50` beside `PLAYLISTS_CAP` — *low · dead-code · confirmed* → CH-08. **Where:** app.js 2672, 2697–2698, 2679–2695. **Fails:** none today. Changing `PLAYLISTS_CAP` leaves the test-only writer slicing at 50, so tests seed a store the app considers over-cap and pass anyway.

**A1-08** · `leafNodes()` has no callers; a test uses its source text as a slice boundary — *low · dead-code · adjusted* → CH-28. **Where:** app.js 814–816, 818–825; test/diagnostics-surface.test.js 549. **Fails:** none today (hygiene). Deleting it without touching the test makes the slice run to end-of-file and the diagnostics-surface test fails loudly.

**A1-09** · `apple_collection_id`/`apple_track_id` are whitelisted into every stored playlist part but no reader uses them from a part — *low · dead-code · adjusted* → CH-08. **Where:** app.js 2513, 1110–1111, 2465–2477, 5527. **Fails:** none today. ~64 B per part of dead weight in the localStorage tier the arithmetic comment is tuned around, and a whitelist whose stated reason (a derivation nothing performs) is false.

**A1-10** · Comments still describe the deleted link-out as live behaviour — *low · stale-comment · confirmed* → CH-01. **Where:** app.js 3120–3121, 3786–3787, 2471–2475, 6596–6597, 1219–1224. **Fails:** a reader trusting 3120–3121 believes a pool row without audio is still useful to queue (A1-01's premise).

**A1-11** · Family Mode comments describe the pre-fail-closed rule — *low · stale-comment · confirmed* → CH-29. **Where:** app.js 1566–1573, 1243–1244, 1466–1503. **Fails:** none today; a reader editing the badge believes null is neutral for Family Mode and loosens the filter.

**A1-12** · `showEpisodeCountLabel` takes two parameters it never reads and hand-rolls the plural `countLabel` exists to own — *low · needless-complexity · confirmed* → CH-29. **Where:** app.js 5285, 5333, 5339, 6092, 6029–6038, 5846, 6273, 6315, 1600–1607, 5926–5931. **Fails:** none today; the next copy change to plural rules lands in `countLabel` and misses three sites.

**A1-13** · `generatedPlaylists` and `generatedPlaylistById` duplicate the slot-id set and the playlist object literal — *low · duplicate · confirmed* → CH-28. **Where:** app.js 2231, 2276, 2249–2252, 2281–2284, 2278. **Fails:** a field added to the generated-playlist shape lands on Home's card and not on the detail page, so `currentCopyOf` finds no copy and Save shows again.

**A1-14** · `nodeById` exists but four sites inline the same taxonomy `find` — *low · duplicate · confirmed* → CH-28. **Where:** app.js 827–829, 2125, 4138, 4262, 4365. **Fails:** none today; a taxonomy lookup change (e.g. an id alias map) misses the inline copies.

**A1-15** · `boostTopics` is a one-line alias of `nudgeTopics` with one caller — *low · needless-complexity · confirmed* → CH-28. **Where:** app.js 958, 1829. **Fails:** none today.

**A1-16** · `renderStarredShows` comment says back goes to #/shows; the link is #/library — *low · stale-comment · confirmed* → CH-29. **Where:** app.js 1962–1964, 1973. **Fails:** none today.

**A1-17** · The Vercel origin is spelled twice as two literals (`API_ORIGIN`, `PUBLIC_WEB_ORIGIN`) — *low · drift-risk · confirmed* → CH-23. **Where:** app.js 552, 5468; test/share-links.test.js 264. **Fails:** none today (pinned). A domain move edits one literal and the test, not the code, says so.

**A1-18** · Six writers repeat the set→save→bump-gen triple that `setInterest`/`nudgeTopics` could own — *low · duplicate · adjusted* → CH-28. **Where:** app.js 858–861, 931–956, 1057–1061, 1081–1083, 6978, 7025–7030, 17186, 6466. **Fails:** a seventh writer of an interest weight forgets the bump and `buildPlaylist` serves a stale ranking for the same query.

**A1-19** · Small reimplementations beside their helpers: `queueIds` redoes `stringList`; `hydrationPool` and `inDiscoverPool` redo "build the pool if there is a session" — *low · duplicate · confirmed* → CH-29. **Where:** app.js 2924–2932, 404, 1988, 2538–2543, 5472–5477. **Fails:** none today.

### A2 — app.js, Home / rows / search / Library / Up Next (19)

**A2-01** · Up Next "Play next" disabled rule re-derives `player/queue-order.js` `playNextOrder` by hand in `upNextRow` — *medium · duplicate · adjusted* → CH-35. **Where:** app.js 12198–12205, 3082–3096, 12311–12321; player/queue-order.js 65–77. **Fails:** none today (the two rules agree for every reachable row state). Drift: `playNextOrder` changes and the button is enabled but its tap moves nothing, or stays disabled where the writer would now move the row.

**A2-02** · Home's Foray play button and the Foray page's main button each own a resume→playForay→logEvent sequence; `foray_play` is written in two places — *medium · drift-risk · adjusted* → CH-32. **Where:** app.js 10743–10790, 15023–15031, 15082–15088, 10623–10627. **Fails:** none today (both paths produce the same start position). Drift: the event gains a field or the resume contract changes and one writer is updated; analytics or start behaviour then differ by which play button was tapped.

**A2-03** · Stretch card on Home states the stretch reason twice; `miniCardV2` comment describes a tooltip that no longer exists — *medium · stale-comment · confirmed* → CH-32. **Where:** app.js 6794, 6820, 11098–11109, 10577. **Fails:** today every stretch card on Home carries two consecutive sentences with the same meaning. A copy edit to one leaves the other.

**A2-04** · "Played" means `hasOpened()` on the Jump back in playlist card and `rowProgress().state === 'played'` on the playlist page — *medium · inconsistency · confirmed* → CH-32. **Where:** app.js 10864–10873, 11477–11486, 11278–11283. **Fails:** listener opens 3 of 12 episodes and finishes 1: Home card says "3 of 12 played" with a 25% bar; one tap later the page header says "1 played".

**A2-05** · Chapter rows promoted inside Episode notes bypass the chapters section's precision and two-ascending-stamps rules — *medium · inconsistency · confirmed* → CH-33. **Where:** app.js 11701–11721, 11841–11859, 11883–11886, 11825–11831, 12109. **Fails:** DAI show, no feed chapters, chapter list in the notes: the Chapters section says "~68 min" and "Times are approximate"; Episode notes shows the same rows reading "1:08:12" exactly. A lone prose stamp becomes a 44 px chapter-row button in the notes while the chapters section correctly ignores it.

**A2-06** · Unreachable fallback snapshot literal in `paintEpisodeSearchResults.rowFor`, already drifted from the live remote literal — *medium · dead-code · confirmed* → CH-35. **Where:** app.js 10232–10244, 10258–10270, 10112–10138, 10148–10170. **Fails:** none today. A future producer of `_localId` rows without `_localSnapshot` would write a thin projection under the listener's real storage id — the artwork-blanking defect the surrounding comment says this code exists to prevent.

**A2-07** · The "Played / NN min left" progress chip template is written three times — *medium · duplicate · confirmed* → CH-35. **Where:** app.js 11333–11336, 12089–12092, 12181–12184. **Fails:** a new progress state or aria attribute lands on one or two of the three; Up Next and the episode page show different marks for the same episode.

**A2-08** · Two "Jump back in" renderers with different content rules; `renderForays` header still says the section moved off Home — *medium · duplicate · adjusted* → CH-32. **Where:** app.js 11158–11166, 11230, 15698–15708, 10823–10829, 10919–10982. **Fails:** a listener who resumed an episode sees it in Jump back in on Home and not on #/forays. Any card fix must be remembered on two markups. (Library renders no Jump back in; only Home does.)

**A2-09** · First-run explainer and intro popup are two hand-built copies of one sheet, with twin this-visit flags — *low · needless-complexity · confirmed* → CH-38. **Where:** app.js 7751–7800, 8008–8073, 8075–8076, 6911. **Fails:** none today. The next sheet-level rule lands in one builder only. (Note: a merged flag would change one edge — kept per-sheet in CH-38.)

**A2-10** · `readDeviceChapters` hard-codes its own 8 s deadline and UA lookup beside the id3 module's `CALL_TIMEOUT_MS` and `getDownloads().userAgent` — *low · duplicate · adjusted* → CH-33. **Where:** app.js 11953–11963; player/id3-chapters.js 50, 375–376. **Fails:** the shell deadline or UA policy is tuned in id3-chapters.js and the podcast:chapters JSON fetch keeps its own values, so the JSON path times out while the MP3 path on the same host succeeds.

**A2-11** · Stale comment: `OFFLINE_SEARCH_NOTE` rationale says "there is no download feature, and that is deliberate" — *low · stale-comment · confirmed* → CH-36. **Where:** app.js 8226–8233, 12612–12620. **Fails:** a reader leaves the note's "Episodes need a connection." unqualified, which is false for a downloaded episode that matches.

**A2-12** · Stale comment: Library header describes an external link-out fallback that `archivedRow`'s own header says was removed 2026-09-03 — *low · stale-comment · confirmed* → CH-35. **Where:** app.js 12579–12585, 11372–11378. **Fails:** none today; documents as current the behaviour the product rule forbids.

**A2-13** · Stale comments: Create header and `bindCreateFormSubmit` cite the #/playlists form and `bindPlaylistFormSubmit`, neither of which exists — *low · stale-comment · confirmed* → CH-35. **Where:** app.js 13164–13192, 13203–13213, 13144–13162. **Fails:** none today; the stated justification points at code nobody can inspect.

**A2-14** · Home header describes the retired four-card layout and "behind cp_ui_v2"; `renderHome()` is a one-line alias of `renderHomeV2()` — *low · stale-comment · confirmed* → CH-32 (header only; alias kept). **Where:** app.js 10456–10497, 10489–10491, 11126. **Fails:** none today; a reader is told the Home invariant is one screen of four cards while the shipped Home is a five-section page.

**A2-15** · Symbols kept alive only by comments or tests: `SHOW_PREFIX_UNDERDELIVERS_BELOW`, `SHOWS_SEARCH_OFF_DEVICE`, `openSheetCount` on `window.ForaySheets`, `p.name` fallback — *low · dead-code · adjusted* → CH-36. **Where:** app.js 8323, 8215, 7695, 10869. **Fails:** none today. (`openSheetCount()` itself is live at 15876; only its window export is unused. `SHOWS_SEARCH_OFF_DEVICE` is a release-gates tripwire — keep.)

**A2-16** · Compatibility branch for the pre-S-04c bare-array shard cache shape kept under the unchanged `-v1` cache name — *low · dead-code · confirmed* → CH-36 (branch deleted; name NOT bumped — see §0.3 item 3). **Where:** app.js 8534, 8566–8580. **Fails:** none today (old entries self-heal once). A second storage format to reason about indefinitely.

**A2-17** · Offline test inlined in `renderEpisodeSearchResults` instead of calling `isOfflineForShardSearch()` — *low · duplicate · confirmed* → CH-36. **Where:** app.js 10386, 8552–8554. **Fails:** a "use the shell's Network plugin" change lands in the helper; the Episodes section keeps reading `navigator.onLine` and shows the offline note while still firing a fetch.

**A2-18** · Three `.pl-row` templates; the Search one has drifted from the Playlists page it says it matches — *low · duplicate · confirmed* → CH-35. **Where:** app.js 9873–9881, 12601–12609, 13155–13161, 9776–9778. **Fails:** the same playlist reads "12 episodes · played yesterday" on #/playlists and "12 episodes" in Search.

**A2-19** · Small repeated literals: "repaint Library if on screen" four times, the Up Next empty-state sentence twice — *low · duplicate · adjusted* → CH-35. **Where:** app.js 12755, 12934, 12949, 13135, 12151, 13106. **Fails:** none today.

### A3 — app.js, Foray page / drawer / routing / boot (16)

**A3-01** · Four copies of the Foray resolve call; only `resolveListedForay` catches a resolver throw — *medium · inconsistency · adjusted* → CH-22. **Where:** app.js 15525–15535, 15655–15667, 19218–19223, 14208–14213. **Fails:** none reproducible today from data (foray-resolve.js never throws on malformed rows). If `resolve` ever throws, one document gets three behaviours: lists render, the now-playing bar restores nothing (episode fallback skipped), the Foray page is stuck on "Loading…" with no Try again.

**A3-02** · Foray page state (`state.foray`, `state.forayPlaying`, `forayPaintedLive`) is never cleared on navigation; only `deleteMyData` clears it, and it misses one — *medium · duplicated-state · confirmed* → CH-22. **Where:** app.js 18069–18081, 15309–15344, 15269, 17187–17190; player/client.js 5619–5623. **Fails:** listener plays Foray A, navigates Home, pauses then closes the bar: `paintForay(IDLE)` runs for Home, `refreshForayResume()` sets `state.forayResume` to A's point while Home is on screen. Nothing on Home reads these today; the next feature that reads `state.foray*` from a non-Foray surface gets A's stale values.

**A3-03** · The resume-point read + finished/resume split is written three times with redundant arguments and inconsistent error handling — *medium · duplicate · confirmed* → CH-22. **Where:** app.js 14265–14270, 15273–15281, 15664, 15005, 15037–15038; player/client.js 5466–5469. **Fails:** `refreshForayResume` swallows a `forayResume` throw; `renderForay` does not (stuck "Loading…"). If the finished-vs-resume rule changes, two copies must change identically.

**A3-04** · `shouldRegisterServiceWorker` re-implements `isNativeShell` with a false justification — *medium · duplicate · confirmed* → CH-23. **Where:** app.js 19902–19915, 1252–1276. **Fails:** none today. The next "are we in the shell" change lands in one copy: either the SW registers inside the shell or relaunch-route/data-source/chapter hydration go wrong on the web.

**A3-05** · Six comments claim app.js and the player module are refreshed independently; `renderForay`'s own note says that mechanism is gone, and ~31 `typeof` guards each degrade silently — *medium · stale-comment · adjusted* → CH-39. **Where:** app.js 14246–14251, 14027–14029, 14843–14846, 14911–14914, 14947–14948, 15427–15430, 16768–16770; sw.js 73–93. **Fails:** a typo or rename of a bridge export ships green: the Foray page renders without the header counts or the strip and nothing says why. (Fix keeps the degrade; sw.js relies on it.)

**A3-06** · `citesHtml` re-implements `forayShowId`'s two-step show join inline, and relinking after the show index loads skips cites — *medium · drift-risk · confirmed* → CH-39. **Where:** app.js 13787, 13663–13667, 14078–14101, 13702. **Fails:** a narrated Foray whose tape beats all join the curated catalogue but whose `cites` name an index-only show: the index is never fetched and the cite stays plain text. Beats relink after the index arrives; cites beside them do not.

**A3-07** · Constants and rules mirrored from player/ without a cross-module pin: nudge fallback, `VOICE_LIST_LANG`, `voiceQualityRank` — *low · drift-risk · adjusted* → CH-38. **Where:** app.js 14997–15003, 17314, 17320–17329; player/media-session.js 224–225; player/default-voice.js 45, 54–71; test/transport-controls.test.js 206; test/voice-settings.test.js 423. **Fails:** founder changes seek to 10/30 in media-session.js: bridge-current pages follow, the skew fallback paints the old pair and the text pin stays green.

**A3-08** · Stale counts and a retired flag in drawer/tab-bar comments — *low · stale-comment · confirmed* → CH-39. **Where:** app.js 16120, 16206–16208, 19798–19799, 16289–16296, 19805, 16083, 16022–16024. **Fails:** none today; a reader counting switches or rows against the comment debugs the wrong thing.

**A3-09** · `enterForayFromQuery` bypasses `replaceHash` despite `replaceHash`'s "every in-place rewrite goes through here" — *low · inconsistency · confirmed* → CH-23. **Where:** app.js 18058–18060, 18463–18478, 19688–19693. **Fails:** in a harness/embedder where `replaceState` does not update `location.hash`, init's next line sees a bare hash and overwrites the Foray entry with Home, while the sessionStorage mark says it was entered.

**A3-10** · Voice-fallback copy exists as a constant and as a second literal — *low · duplicate · confirmed* → CH-38. **Where:** app.js 14858, 17702. **Fails:** a copy edit to the constant leaves the Preview button saying the old sentence.

**A3-11** · Four sheet closers set `.hidden = true` after `closeSheet()` already did — *low · needless-complexity · confirmed* → CH-38. **Where:** app.js 13962, 17096–17097, 17726–17727, 17911–17912, 7611–7620. **Fails:** none today. The duplicate hides a future stack/DOM desync instead of surfacing it.

**A3-12** · `voiceState.selected`/`notice` are written and never read; `voiceState.returnToAudition` is used but not declared — *low · dead-code · confirmed* → CH-38. **Where:** app.js 17376, 17534, 17586–17604. **Fails:** none today.

**A3-13** · Three implementations of "wait for the player bridge", with different timeout semantics — *low · duplicate · adjusted* → CH-28. **Where:** app.js 13458–13477, 15642–15643, 16484–16485. **Fails:** none today. The next readiness-detection change lands in one of three places. (The two boot waits are unbounded on purpose — a module at 7 s still restores the ribbon; the helper must preserve that and the `late` flag.)

**A3-14** · `isForaySurface` omits the Search results route, which paints a Forays group from `forayCards()` — *low · drift-risk · adjusted* → CH-39. **Where:** app.js 19197–19202, 10322–10350, 19233–19242, 16053–16060. **Fails:** a directory refresh adopts a new set while the listener is on Search results: the Forays group keeps the old title/length until the next keystroke; a withdrawn Foray links to "That foray isn't available". (Fix repaints the one slot in place, not the whole page.)

**A3-15** · Code kept for paths its own comments say do not exist: the redundant SW pin write, and `ForayNav.handleBack` consumed only by a test — *low · dead-code · confirmed* → CH-23. **Where:** app.js 20032–20056, 15946–15948; player/client.js 3027–3029. **Fails:** the pin write can move the page onto a different generation than the one its data fetches used if a future worker ever sends a different id. `handleBack` on window is public surface with no owner.

**A3-16** · `fetchJson` and `fetchApiJson` are twins differing only in URL and deadline — *low · duplicate · confirmed* → CH-23. **Where:** app.js 18996–19008, 19023–19036; tools/mobile/prepare-webdir.mjs 495. **Fails:** none today; the next fix to the abort/deadline shape lands in one of the two.

### P1 — player core: client, queue-manager, queue-state, html-audio-backend (14)

**P1-01** · Public `ForayPlayer.isPlaying(id)` answers from the reducer's belief while `togglePlayback()` acts on the element — app.js's stamp tap pauses audio it just asked for in the #689 drift — *high · inconsistency · confirmed* → CH-03. **Where:** player/client.js 4819–4821, 4949–4951, 1565–1567, 2937; player/transport-policy.js 147–148; app.js 12029, 12051. **Fails:** state `interrupted`, element audible. Listener taps a timestamp in the notes: `seekTo` seeks; `isPlaying(id)` is false (belief) so `togglePlayback()` runs; `transportIsRunning()` is true (element) so `setRunning(false)` → PAUSE. The tap that meant "hear this part" stops the audio.

**P1-02** · Every media error reaches the manager twice (persistent `error` listener + load rejection); two identical in-flight markers undo it and a plain episode still dispatches `E.error` twice — *medium · duplicate · adjusted* → CH-25. **Where:** player/html-audio-backend.js 561–565, 616, 1709–1712; player/queue-manager.js 207–219, 434–444, 784–790, 2106–2134, 2169–2181; player/queue-state.js 304–305. **Fails:** a plain episode whose load errors: `E.error` → idle + `pausePlayback` + `player.error`; then the load rejects → `E.error` again → second `pausePlayback`, second `player.error` row, second failure paint. The next item kind with a load-failure policy needs a THIRD marker or the policy silently never runs.

**P1-03** · The two-element handover in `HtmlAudioBackend` is a documented park (default off, unreachable in production) whose ~500 lines every edit to load/pause/play/release must keep consistent — *low · dead-code · adjusted* → DEFERRED (§5); prose fixed in CH-34. **Where:** player/html-audio-backend.js 396, 421–424, 480–531, 962–1266, 1437–1583, 1916; player/queue-manager.js 75–85; player/client.js 4186; test/suite-integrity.test.js 185–196; player/transport-reconcile.test.js 627–679. **Fails:** none today. Maintenance drag for a path nothing in production enables.

**P1-04** · A Foray's queue is built twice and held as two lists — `foray.resolved.playable` for the page, `manager.queue` for playback — indexed by one integer with nothing checking they agree — *medium · duplicated-state · adjusted* → CH-10. **Where:** player/foray-resolve.js 440–444, 488, 527–543; player/queue-manager.js 918–931; player/native-facades.js 345–352; player/client.js 3489, 5377–5386, 1591, 1637, 5716. **Fails:** any divergence between the two option sets (`isLocalFile: true` for a downloaded Foray; `allowAdPad` passed to one build) drops a different segment from one list than the other, and every `foray.index` lookup names the wrong clip: the running order highlights clip 7 while clip 8 plays, `forayPlayhead` subtracts the wrong `start_sec`, the resume row is written for the wrong segment id.

**P1-05** · The `setOutPoint` refusal comment names `restoreColdLaunchState()` as the live cold-restore path; in production a Foray cold-restore goes through `restoreForay` → `setQueueFromForay`, and the method is a parity/Swift-mirrored seam only — *low · stale-comment · adjusted* → CH-34. **Where:** player/queue-manager.js 1659–1666, 1351–1369; player/parity/runner.js 286, 968; ios/App/Player/PlayerQueueManager.swift 201. **Fails:** none today. The comment steers the next reader fixing a cold-restore bug toward the wrong function.

**P1-06** · queue-manager.js re-implements queue-state.js's item identity and focus rules (`sameItemRef`/`focusOf` vs unexported `sameRef`/`currentItem`) — *medium · duplicate · confirmed* → CH-05. **Where:** player/queue-manager.js 3314–3334; player/queue-state.js 249–277. **Fails:** the reducer gains a field in identity and `sameRef` is updated; the manager's copy is not. A load for an item the reducer has already left is NOT dropped as stale and `itemLoaded` lands on another item's `loadingItem` — the "D's out-point armed on C's timeline" case player-core-9 fixed.

**P1-07** · `load()` carries its own inline copies of the settle-nearness and offset rules that deck-policy.js owns, and its `seeked` path resolves without the nearness check its `canplay` path requires — *medium · drift-risk · adjusted* → CH-21. **Where:** player/html-audio-backend.js 1717–1731, 1782–1783, 1791; player/deck-policy.js 201–203, 329–331, 657–659; DeckPolicy.swift 116–117. **Fails:** someone widens `SETTLE_NEAR_SEC`: the in-place seek and the native deck follow, the cold `load()` keeps `> 1`. Separately (unproven): a `seeked` the backend did not request, arriving with `readyState >= 3` before the offset seek lands, resolves `load()` at 0:00.

**P1-08** · Web `setVolume`/`_volume` is "hold-to-talk ducking later" with no production caller; the `carry-volume` handover step it feeds is live only in the native `DeckPair` — *low · dead-code · adjusted* → CH-34. **Where:** player/html-audio-backend.js 13, 507–509, 1204–1206, 2030–2039; player/deck-policy.js 625–629, 723–728; DeckPair.swift 295; DeckPolicyReadings.swift 149–159. **Fails:** none today (hygiene). One more field the parked web handover carries.

**P1-09** · `queue-strategy.js` is speculative configurability: `strategy` only ever takes `SINGLE_ITEM` in production, the other two survive only as a test-side queue builder, and the header argues from a product principle the founder reversed — *low · needless-complexity · adjusted* → CH-30. **Where:** player/queue-strategy.js 1–60; player/queue-manager.js 263, 566–583, 889–896; player/client.js 97, 4194, 3105–3110; index.html 109; player/queue-manager.test.js 147–299; player/html-audio-backend.test.js 371. **Fails:** none today. A reader looking for "what plays next" finds a pluggable seam that says the product forbids chains, while the real answer lives in `continuation.js` + app.js.

**P1-10** · `elementIsAudible` consumes `backend.paused`'s "unknown reads as not-paused" default in the opposite direction the backend documented it for — *low · inconsistency · confirmed* → CH-37. **Where:** player/html-audio-backend.js 2054–2067; player/queue-manager.js 1604–1607, 1555–1562, 1077–1080; player/native-facades.js 141. **Fails:** none today in production. Any element-shaped fake or future backend that models `paused` as undefined-until-known flips `interrupted` → `playing` on the next `visibilitychange` with no audio flowing, and the position writer stamps a stale clock.

**P1-11** · Comments that now lie: "exactly two `<audio>` elements" (four places), "the episode clock rounds", and the stop snapshot's "same shape the live snapshot has" — *low · stale-comment · adjusted* → CH-34. **Where:** player/html-audio-backend.js 26–34; player/client.js 205–207, 4187–4189, 4296–4303, 1908–1911, 2229–2231, 3036–3045, 1742–1783; app.js 15440. **Fails:** none today (app.js guards `rate`). A new snapshot consumer that trusts "same shape" reads `undefined` for `gap`/`rate`/`voiceFallback` on stop.

**P1-12** · Dead public surface on `ForayPlayer`: `cycleRate` (self-described unshipped), `stripModel`, `stripSummary`, `lastVoiceFallback()` — *low · dead-code · confirmed* → CH-26. **Where:** player/client.js 5143–5156, 5046–5050, 5232–5238, 140, 1778–1781; player/foray-playback.test.js 1059, 2590–2603. **Fails:** none today (hygiene). Four entry points app.js could start calling, two a second opinion about state the snapshot already carries.

**P1-13** · `routeChanged({ oldDeviceUnavailable })` in the JS manager only ever takes `true` in production; its `false` arm and the "accepted and ignored" `routeName`/`isCarRoute` prose are parity-only, while the reducer's `routeChanged(false)` case is a shared token the Swift ports still use — *low · needless-complexity · adjusted* → CH-34. **Where:** player/queue-manager.js 1327–1349; player/client.js 718–723; player/parity/runner.js 954–958; player/queue-state.js 477–483; queue-state.json 621; ios/ForayKit PlayerQueueState.swift 136; ios/App PlayerQueueManager.swift 685–688. **Fails:** none today. The next person adding route policy reads "accepted and ignored" and reaches for the dead arm.

**P1-14** · `fmtDur(min)` (app.js) and `fmtSpan(sec)` (foray-resolve.js) duplicate the "1 hr 5 min" tail; the sec rung and minutes rounding differ by documented intent, but a copy ruling on the tail must land in two files — *low · duplicate · adjusted* → CH-24 (module side), CH-29 (app.js comment). **Where:** app.js 1609–1624; player/foray-resolve.js 778–792; player/client.js 5026–5027; index.html 159; test/format-helpers.test.js 102–112; test/episode-page.test.js 134. **Fails:** the next copy ruling on the hour tail has to land in two files and only `fmtDur`'s test pins it. (Routing cards through `window.ForayPlayer.fmtSpan` would blank durations on first paint — not the fix.)

### P2 — player modules: downloads, bookmarks, progress, gestures, telemetry (19)

**P2-01** · Download eviction is documented as least-recently-PLAYED but `markPlayed` has no caller, so `last_played_at` is never written — *high · dead-code · confirmed* → CH-02. **Where:** player/download-store.js 238–245, 285–290, 292–322; app.js 12760–12801; player/client.js 4346–4352; docs/roadmap/player-features.md 318–319. **Fails:** listener downloads A in week 1 and finishes it daily, then downloads B..Z past the 2 GB cap. Every `last_played_at` is null, so `evictionPlan` sorts by `updated_at` and evicts A — the file they use — first.

**P2-02** · Bookmarks are write-only: PQ-15 never landed, so `bookmarksFor`, `removeBookmark`, `bookmarkPrecision`, `bookmarkLabel` have no callers and the privacy row describes a surface that does not exist — *high · dead-code · adjusted* → CH-09b. **Where:** player/bookmarks.js 143–156, 164–181; app.js 3564–3574; player/client.js 3867–3872; docs/roadmap/player-features.md 49, 301–309; docs/legal/privacy-policy.md (cp_bookmarks row). **Fails:** `cp_bookmarks` grows toward TOTAL_CAP 500 with no listener-visible effect while the sheet announces "Bookmarked." and the privacy policy says bookmarks are listed on the episode page.

**P2-03** · An authored `jingle` queue item is classified three different ways: "ours" by media-session, "a segment from an unnamed show" by segment-strip, "rate follows listener" by queue-state while interlude.js pins the jingle to 1.0x — *medium · inconsistency · adjusted* → CH-11 (classification), CH-11b (rate). **Where:** player/segment-strip.js 157–159, 172–177, 378–380; player/media-session.js 400–401; player/foray-queue.js 344–356; player/queue-state.js 359; player/interlude.js 113–115; player/deck-policy.js 842; player/foray-structure.js 66; data/forays.json 1588 (a draft). **Fails:** enable drafts or let the generator publish a jingle-carrying Foray: at 2x the authored jingle plays at 2x while interlude jingles play at 1x; the strip paints it as a coloured clip of a nameless show; `stripTally.clips` and the credits disagree.

**P2-04** · Four modules nothing imports (catalogue-directory, show-alerts, locate-window, route-resume) ship and are modulepreloaded on every cold boot; index.html's comment that every module is imported by client.js is false — *medium · dead-code · confirmed* → CH-07. **Where:** index.html 65–70, 75, 99, 111, 116; tools/ci/generate-manifest.mjs 185–190; test/boot-path.test.js 246–256; the four modules' headers. **Fails:** every cold boot fetches four modules the page never executes (each a SW revalidation on the boot path) and Chromium logs "resource was preloaded but not used" for each. The mechanism guarantees the orphan count only grows.

**P2-05** · The "race a promise against a deadline" helper is written eight times with differing semantics, plus three near-identical `REAL_SCHEDULER` objects — *medium · duplicate · adjusted* → CH-40. **Where:** player/build-stamp.js 100–111; player/foray-directory.js 601–609, 532–563; player/id3-chapters.js 333–337; player/download-bridge.js 136–166; player/engine-diagnostics.js 86–102, 36–41; player/durable-store.js 1301–1326; player/client.js 495–499, 3504–3508; player/native-engine.js 93–98; player/queue-manager.js 472–477. **Fails:** none user-visible today; drift is already real (some copies swallow the inner rejection, some do not). The next deadline fix lands in one copy and not the other seven.

**P2-06** · download-bridge's `listen` is a line-number-pinned verbatim copy of native-engine's `listen` — *medium · duplicate · confirmed* → CH-12. **Where:** player/download-bridge.js 95–108, 43–45; player/native-engine.js 116–125. **Fails:** a fix to the Capacitor listener shape lands in native-engine.js and not download-bridge.js, so engine events keep arriving and download progress events silently stop.

**P2-07** · The one duration dialect ("1 hr 5 min") is implemented four times, three of them in ES modules that could import each other; the copies already disagree on zero and sub-minute values — *medium · duplicate · confirmed* → CH-24. **Where:** app.js 1609–1624; player/foray-resolve.js 777–792; player/episode-progress.js 138–150; player/foray-progress.js 383–399. **Fails:** a copy change is applied to `fmtSpan` and `fmtDur` and missed in episode-progress/foray-progress, so a Home card reads "1 hr 5 min left" beside a header saying "1h 5m".

**P2-08** · Closed vocabularies are duplicated between diagnostic-log.js and engine-vocabulary.js / foray-directory.js with no test pinning them equal — *medium · drift-risk · confirmed* → CH-31. **Where:** player/diagnostic-log.js 885–889, 770, 768; player/engine-vocabulary.js 73–77; player/foray-directory.js 98, 112–114; player/catalogue-directory.js 61–65; player/engine-vocabulary.test.js 11–16. **Fails:** Swift adds an AVAudioSession error token to engine-vocabulary; the legacy plugin's `sessionActivated (failed)` row reaches diagnostic-log.js, `oneOf(SESSION_ERRORS, …)` returns null and the Copy report prints the failure with no reason — the L13 gap the set was added to close.

**P2-09** · queue-state.js header names the wrong Swift mirror and states the native backend cannot play a Foray — both now false — *medium · stale-comment · adjusted* → CH-05. **Where:** player/queue-state.js 1–6, 56–66; ios/README.md 15–26; ios/ForayKit PlayerQueueState.swift; foray-engine-core Reducer/PlayerQueueState.swift; player/native-facades.js 338–381; player/parity/manifest.json 1405–1412. **Fails:** an agent changing the reducer follows the header, edits ios/ForayKit's frozen copy, and leaves foray-engine-core's live reducer unchanged.

**P2-10** · queue-strategy: `PICKED_FIRST` and `CONTINUE_TAIL` are speculative configurability — only `SINGLE_ITEM` has ever been passed — *medium · needless-complexity · adjusted* → CH-30. **Where:** player/queue-strategy.js 108–142; player/client.js 97, 4194; player/queue-manager.js 263, 493, 566, 583, 890; player/native-facades.js 283–296; player/diagnostic-log.js 649; manager-episode scenarios.json; tools/mobile/probe/install-probe.mjs 121. **Fails:** none today. Drift: any change to how `setQueueFromPick` builds the single-item queue has to be written against a pluggable contract for two strategies no product path can select.

**P2-11** · download-store's `readDownloads`/`writeDownloads` have no callers; app.js re-implements them with a hardcoded key and keeps a record rule (`downloadsWithout`) outside the module — *medium · duplicate · confirmed* → CH-02. **Where:** player/download-store.js 129–150, 36; app.js 12644–12654, 12657–12661. **Fails:** the two writers differ on null today (`writeDownloads(null)` removes the key; `saveDownloads(null)` would write "null"), and the Swift/Java ports are told to read the contract from download-store.js, which no longer describes what the web does on remove.

**P2-12** · download-bridge header says the iOS and Android native halves "neither exists yet" — both have shipped — *low · stale-comment · confirmed* → CH-06. **Where:** player/download-bridge.js 18–23; the two plugin halves under mobile/plugins/foray-downloads. **Fails:** a reader triaging a "Download failed" report trusts the header, concludes the plugin is absent, and looks no further.

**P2-13** · app.js carries unpinned inline copies of seek-policy's two approximate chapter-stamp strings as the pre-module fallback — *low · duplicate · adjusted* → CH-33. **Where:** app.js 11846–11850, 11588–11596; player/seek-policy.js 350–364, 370. **Fails:** the honesty wording ("~68 min" → "about 68 min") is changed in seek-policy and the episode page keeps the old form whenever the module has not loaded yet.

**P2-14** · event-log.js re-implements idb-tier's `openDb` and durable-store's `errText` while its header claims the IDB plumbing is "shared rather than copied" — *low · duplicate · confirmed* → CH-13. **Where:** player/event-log.js 527–543, 91–93, 131–134; player/idb-tier.js 118–135; player/durable-store.js 1951–1956. **Fails:** the next open-path fix lands in idb-tier and the telemetry database keeps the old behaviour.

**P2-15** · Gesture modules duplicate `releaseVelocity` and carry same-named constants with different values, cross-referenced by value in comments — *low · drift-risk · confirmed* → CH-14. **Where:** player/queue-swipe.js 152–158, 58, 41–44; player/sheet-drag-dismiss.js 105–111, 47, 53, 169–182; player/queue-drag.js 228–230. **Fails:** someone tunes the sheet's lock to 10 px; queue-swipe's comment still says "the same 8 px" and nobody notices the two gestures now disagree — or an agent "fixes" one to match the stale comment.

**P2-16** · Exports whose only callers are tests: `canSeekExactly`/`canPlaySegment`, `renderStrip`, and an unreachable "finished" label branch in both progress modules — *low · dead-code · adjusted* → CH-24. **Where:** player/seek-policy.js 255–264; player/segment-strip.js 689–700; player/episode-progress.js 155–161, 187–197; player/foray-progress.js 384, 413–417, 522–524 (`failedWrites` — parity-pinned, keep). **Fails:** none today. The two unreachable "finished" strings are the second vocabulary the honesty-2 audit removed; a future direct caller resurrects it.

**P2-17** · episode-progress copies foray-progress's `MAX_AGE_H` by value instead of importing it — *low · drift-risk · confirmed* → CH-24. **Where:** player/episode-progress.js 39–47; player/foray-progress.js 48–50. **Fails:** foray-progress's window is tuned (say 14 days) and the episode pointer keeps 30, so "Jump back in" drops Forays a fortnight before episodes — the bug the comment names.

**P2-18** · id3-chapters' `localSrc` is a third "what does a downloaded episode open from" rule beside `download-store.playSource` and client.js `localSourceFor` — *low · duplicate · confirmed* → CH-27. **Where:** player/id3-chapters.js 351–359; player/download-store.js 346–362; player/client.js 4346–4352; app.js 11915–11921. **Fails:** download-store's done/`missing` normalisation changes, `playSource` follows, and the chapter reader still tries to fetch the stale path, costing a 10 s deadline per episode page open.

**P2-19** · `cp_downloads` is re-spelled twice in app.js instead of read from `window.forayDownloads.store.KEY` — *low · drift-risk · adjusted* → CH-02 (folded into P2-11). **Where:** app.js 12645, 12653; player/download-store.js 36. **Fails:** none today.

### N1 — mobile, workflows, native plugins (9)

**N1-01** · durable-store's `nativeKvTier` and `deferredPrefixesFor` call `bridge.isNativePlatform()` outside any try, and client.js evaluates both at module scope — *medium · corner-case-bug · adjusted* → CH-04. **Where:** player/durable-store.js 357–359, 457–462; player/client.js 256, 262, 309; mobile/web/foray-type-scale.js 40–41; player/durable-store.test.js 1840–1846. **Fails:** a `window.Capacitor` whose `isNativePlatform()` throws (the repo's own hardened case for app.js, shell-invariants 654–675) reaches `deferredPrefixesFor` at client.js:309 during import evaluation; the throw escapes module evaluation and the player does not load. app.js survives the same bridge. (Synthesised in tests, not observed on a device.)

**N1-02** · The Kokoro probe left the page (#1076) but ~3,900 lines of native probe code, the `kokoroProbe` plugin method, its JS half, ONNX Runtime and ProbeLedger boot I/O are still in every shell build — *high · dead-code · confirmed* → DEFERRED (§5). **Where:** mobile/plugins/foray-tts ForayTtsPlugin.swift 169, 228–239, 979–1416; KokoroProbeMatrix.swift; KokoroCoreMLEngine.swift; ProbeLedger.swift; KokoroOrtProbeEngine.swift/.java; ForayTtsPlugin.java 860–1376; Package.swift 52–62; android/build.gradle 89; web/foray-tts.js 442–588, 772–790; foray-audio ForayAudioPlugin.swift 318–341; README.md 281–364; tools/mobile/kokoro-probe-passage.json; tools/mobile/foray-tts.test.mjs 641–700; shell-invariants.test.mjs 3737–3744. **Fails:** every iOS launch does Application Support file I/O for a probe that cannot run from the app; release IPA/APK link ONNX Runtime 1.20.0 with no caller; foray-tts.js ships ~150 lines of unreachable transport.

**N1-03** · Every iOS/Android build and release still fetches and bundles the Kokoro weights whose only readers are the dead probe — *high · dead-code · adjusted* → CH-20. **Where:** .github/workflows/ios-build.yml 252–257; .github/actions/ios-archive/action.yml 80–91; android-build.yml 304–309; .github/actions/android-bundle/action.yml 116–119; tools/mobile/fetch-models.mjs 120–140; tools/mobile/inject-models.mjs; ForayTtsPlugin.swift 988–1004; ForayTtsPlugin.java 954–957; test/release-gates.test.js 548–640; render-narration.yml 87–94 (keeps fetch-models alive). **Fails:** every TestFlight archive carries ~400 MB of weights nothing loads; every shell CI run downloads and hashes them from Hugging Face (an HF outage fails a release build for a dead asset); Android ships 86 MB in the universal APK.

**N1-04** · foray-downloads' native rule tests (`DownloadPolicyTests.swift`, `DownloadRulesTest.java`) are asserted to exist by a Node suite but executed by no CI job — *medium · drift-risk · confirmed* → CH-06. **Where:** .github/workflows/ci.yml 276–333; android-build.yml 376–391; foray-downloads Package.swift 15–19; DownloadPolicyTests.swift; DownloadRulesTest.java 12–18; tools/mobile/foray-downloads.test.mjs 221–240, 387–405. **Fails:** `DownloadPolicy`'s redirect cap or the Java 403 → unplayable-here mapping can be broken with CI green; the Node pins prove the test names exist, not that they pass.

**N1-05** · Seven comments still say foray-downloads is not declared / not compiled / awaiting PQ-21, after PQ-21 shipped — *medium · stale-comment · adjusted* → CH-06. **Where:** foray-downloads package.json 6; Package.swift 15–19; android/build.gradle 10–12; DownloadStore.swift 17–24; ForayDownloadsPlugin.swift 50–53; player/download-bridge.js 18–23; tools/mobile/foray-downloads.test.mjs 243–248. **Fails:** a reader treats the plugin as inert and skips it in a change to the AppDelegate injector, the lockfile or the test matrix; N1-04 is the realised instance.

**N1-06** · `routeChangeReason` is a byte-identical copy in foray-audio and foray-tts with no shell-invariants pin — *low · drift-risk · adjusted* → CH-19. **Where:** ForayAudioPlugin.swift 654–666; ForayTtsPlugin.swift 314–326; tools/mobile/shell-invariants.test.mjs. **Fails:** none today. A new `RouteChangeReason` token added to one copy yields differently spelled `reason` values for the same event across producers; diagnostic-log admits both, so the drift is silent. (Two producers per route change is the designed signal — keep both.)

**N1-07** · Android native engine ships in release APKs reachable only from the debug `EngineDriveReceiver`, and two comments misstate the lane — *low · stale-comment · adjusted* → CH-19. **Where:** EngineHandshake.java 19–20; mobile/ENGINE_DEFAULT.json 2; android AndroidManifest.xml 49–68; ForayPlaybackService.java 83–90; ForayAudioPlugin.java 238–247. **Fails:** none at runtime. A reader of EngineHandshake.java writes `legacy` into ENGINE_DEFAULT.json (rejected at build). The release APK size cost is a roadmap pacing choice to record, not a defect.

**N1-08** · The JS lane has three names — `legacy` (hello), `js` (plist/page), `web` (override) — spread across plist, Swift core, Java core and the JS contract — *low · inconsistency · confirmed* → CH-19. **Where:** mobile/ENGINE_DEFAULT.json 2, 12; EngineMode.swift 22–50; EngineHandshake.java 20–28; player/engine-contract.js 119–137; tools/mobile/inject-background-audio.mjs 521. **Fails:** none today (parity family holds). The realised cost is the already-wrong EngineHandshake.java comment and reader confusion.

**N1-09** · Comments describing foray-audio's iOS half as "Now Playing only / no Swift / no audio-session code" predate the native engine and now lie — *low · stale-comment · confirmed* → CH-19. **Where:** mobile/README.md 98–109; foray-audio package.json 7–8; Package.swift 16–22; ForayAudioPlugin.swift 10–18; foray-tts/web/package.json 2. **Fails:** none at runtime. An agent asked to find the iOS audio-session owner is told there is none while two owners exist.

### X1 — cross-cutting: sw.js, search-engine.js, api/, styles, shared constants (20)

**X1-01** · seek-policy.js publication comment overstates what app.js reads from it; `fmtChapterTime` copy is pinned but could defer to `ForaySeekPolicy` when present — *low · stale-comment · adjusted* → CH-33. **Where:** player/seek-policy.js 365–370; app.js 11588–11596, 11849–11850; test/clock-formatters.test.js 26–47. **Fails:** none today — the three clocks are test-pinned. A reader of the comment believes app.js has no copy.

**X1-02** · Duration dialect implemented four times across classic script and modules; shared only by a pinning test — *low · duplicate · adjusted* → CH-24. **Where:** app.js 1616–1624; player/episode-progress.js 143–150; player/foray-resolve.js 784–792; player/foray-progress.js 383–395; test/format-helpers.test.js 121–133. **Fails:** none today; a wording change must land in four files and the test.

**X1-03** · `cp_downloads` has two writers (download-store's raw `writeDownloads` vs app.js's lsSet path) and `markPlayed` is never called, so LRU eviction never sees a play — *medium · corner-case-bug · adjusted* → CH-02. **Where:** player/download-store.js 130–148, 240–245, 288–290; app.js 12644–12654; player/client.js 970–980, 4341–4351. **Fails:** a listener re-plays an old download daily and downloads new episodes; at the 2 GB cap the daily-played file is evicted first. Future: an agent wiring the bridge calls `store.writeDownloads(storage, v)`; the row bypasses DurableStore's IndexedDB tier and Delete-my-data accounting.

**X1-04** · Jingle/site-root URL is spelled in JS (3 files) and Swift `EngineConstants` with no cross-language pin; sw.js comment assumes the jingle is same-origin; app.js spells the Vercel host twice — *low · drift-risk · adjusted* → CH-15 (pin, sw.js), CH-23 (origin). **Where:** player/interlude.js 95–97; player/foray-queue.js 95; player/download-bridge.js 76; EngineConstants.swift 193, 236, 246; sw.js 904–910; app.js 552, 5468. **Fails:** the asset path is renamed on the JS side while the Swift engine keeps the old URL: the iOS native lane's seam jingle 404s silently while the JS lane plays.

**X1-05** · app.js spells the narration test inline at 6848 instead of calling its own `isForayNarration` — *low · duplicate · adjusted* → CH-36. **Where:** app.js 6848, 13628–13630; player/segment-strip.js 151–159. **Fails:** none today — no app.js surface receives a built queue item.

**X1-06** · app.js `normaliseShowTitle` re-implements `SearchEngine.foldDiacritics` instead of composing it — *low · duplicate · adjusted* → CH-36. **Where:** app.js 8763–8765; search-engine.js 1995–2004; api/_lib/appleShowSearch.ts 171–178 (a pinned copy by necessity). **Fails:** none today (pinned). A future change to `foldDiacritics` would silently not apply to show-title dedup in app.js.

**X1-07** · `cp_interlude`'s "off" literal is spelled in app.js (fallback) and interlude.js; guarded by a test but not by a shared export — *low · drift-risk · adjusted* → DEFERRED (§5). **Where:** player/interlude.js 206–220; app.js 3324–3351; test/drawer-settings-toggle.test.js 271–278; EngineConstants.swift 242. **Fails:** none today — the pinning test and the Swift reader make a re-encoding fail loudly.

**X1-08** · Native-shell detection written twice in app.js with inverted return, on a false source-order premise — *medium · duplicate · confirmed* → CH-23. **Where:** app.js 1255–1275, 19902–19915; tools/mobile/shell-invariants.test.mjs 690. **Fails:** a new platform signal is added to one detector only; the page registers the service worker inside a shell it elsewhere treats as native (or vice versa) — the #213/#220 class of bug.

**X1-09** · `branchOf` is defined identically in app.js and search-engine.js; app.js never uses the exported one — *low · duplicate · confirmed* → CH-36. **Where:** app.js 1710–1713; search-engine.js 281–284, 2561; index.html 158–159. **Fails:** the topic path separator or "other" fallback changes in the ranker's copy; Home's branch grouping keeps the old rule and a subject card lands in a different branch than search puts it in.

**X1-10** · Owned storage-key prefixes and the data-file triplet restated as literals in import-isolated modules without a shared constants source — *low · drift-risk · adjusted* → CH-31. **Where:** player/engine-contract.js 45–51, 79; player/foray-progress.js 39; player/episode-progress.js 37; player/diagnostic-log.js 770; player/foray-directory.js 98. **Fails:** a fourth data document is added to foray-directory's `FILE_KEYS`; diagnostic-log's per-file outcome loop and log line silently omit it.

**X1-11** · sw.js comments reference a constant that does not exist and the wrong manifest file name — *low · stale-comment · confirmed* → CH-15. **Where:** sw.js 836–838, 209–212, 46–52, 157, 356–363. **Fails:** an agent debugging an install failure reads the console error and inspects the PWA manifest.json instead of deploy-manifest.json, then looks for a `RETAIN_GENERATIONS` knob.

**X1-12** · search-engine.js export comments misattribute readers; two exported members have no caller anywhere — *low · stale-comment · confirmed* → CH-16. **Where:** search-engine.js 2568–2576, 2585–2589, 1878, 2355. **Fails:** none today — hygiene. An agent treats the bucket constants and the two orphan exports as UI contract and preserves them through a ranker refactor.

**X1-13** · `firstParam` copied into all four API endpoints, one copy with a different return type — *low · duplicate · confirmed* → CH-17. **Where:** api/episodes/search.ts 134–137; api/shows/search.ts 147–150; api/shows/[show_id]/episodes.ts 149–152; api/shows/index/[...path].ts 226–230; api/_lib/cors.ts 53–56. **Fails:** query-array handling (`?q=a&q=b`) is decided per endpoint; a fix lands in one file and the show-scoped search and the per-show list disagree on the same URL.

**X1-14** · vercel.json immutable-cache rule keyed on a `?v=` query no client sends yet; reserved by #606 and pinned by test/vercel-headers.test.js — *low · dead-code · adjusted* → DEFERRED (§5). **Where:** vercel.json 34–41; test/vercel-headers.test.js 30–38; tools/ci/forays-directory.mjs 24–32; docs/DECISIONS.md 3884. **Fails:** none today. If an agent adopts `?v=` on the WEB, sw.js `stripQuery` collapses the query before caching while the browser HTTP cache treats a nightly-changing file as immutable for a year.

**X1-15** · Identical CSS block declared twice — *low · duplicate · confirmed* → CH-18. **Where:** styles.css 3776–3780, 3974–3978. **Fails:** an agent restyles the search input in whichever block they find; the later block wins the cascade, so edits to the first silently do nothing.

**X1-16** · `isNum` redefined in eleven player modules (plus two `isFiniteNum`, one `isObj`/`isPlainObject` pair, and an `isObject` that accepts arrays) — *low · duplicate · confirmed* → CH-41. **Where:** player/foray-resolve.js 74; foray-progress.js 85; foray-queue.js 125; foray-directory.js 135; foray-sources.js 32; foray-structure.js 74; media-session.js 239; playback-rate.js 115; queue-manager.js 420; segment-strip.js 148; locate-window.js 33; client.js 5744; engine-contract.js 173–174; bookmarks.js 41; show-alerts.js 57. **Fails:** none today — hygiene. show-alerts' `isObject` accepting arrays where every sibling rejects them is the drift this invites.

**X1-17** · Two functions named `clampIndex` with opposite out-of-range behaviour — *low · inconsistency · confirmed* → CH-41. **Where:** player/client.js 5746–5749; player/foray-progress.js 345–349. **Fails:** an agent moving resume logic between the two files keeps `clampIndex(i, n)` and the semantics flip: a stale progress row past the live end resumes at the last segment instead of "not found", or a sheet index becomes -1 and indexes `items[-1]`.

**X1-18** · HTML escaping implemented three times (app.js, segment-strip.js, sw.js); sw.js's table omits `>` and `'` — *low · duplicate · confirmed* → CH-15. **Where:** app.js 98–101; player/segment-strip.js 718–719; sw.js 818–820, 794. **Fails:** low today (the sw.js escaper only sees a deploy id in a double-quoted attribute). It becomes a bug the day `stampPin` interpolates anything else into the fallback document.

**X1-19** · `PER_SHOW_CAP` restated in app.js although `SearchEngine.PER_SHOW_CAP` is exported — *low · duplicate · adjusted* → CH-36. **Where:** app.js 2194–2197, 2220; search-engine.js 1731, 2560. **Fails:** the ranker's cap moves to 3; generated playlists keep 2 and a topic search shows three episodes of a show that the playlist built from the same search refuses to include more than two of. (The read must be lazy — 38 harnesses lack `SearchEngine`.)

**X1-20** · `forayplayer:ready` event name spelled as a literal in seven places across two files with no pin — *low · drift-risk · confirmed* → CH-28. **Where:** player/client.js 5767; app.js 225, 314, 13470–13474, 15643, 16485. **Fails:** a rename or typo in client.js's dispatch never fires; the `once: true` listener silently never runs and a Foray page waiting on it sits in its loading state until `PLAYER_WAIT_MS` gives up.
