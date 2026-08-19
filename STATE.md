# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

### search df thresholds are fractions, so query expansion stops drifting every night (2026-08-19, one PR, founder-gated, no follow-up)

- **What:** `fix/275-relative-tagdf`. #275. `search-engine.js`'s `tagDF()` returned an
  **absolute count** and `interpretQuery` compared it against absolute thresholds
  (`df > 60` deleted a term from a query expansion, `df > 25` cut its weight to 0.4x)
  while `scoreMatch` bucketed a multiplier at 10 and 30 — and `corpusDF`, ten lines
  away, was already a fraction. So the catalogue retuned search every night: measured
  over five real nightly snapshots (878 → 1,561 tag entries, 2026-07-19 → 08-18)
  **52 terms crossed the expansion threshold and 125 the score multiplier**, with no
  code change. `tagDF` is now `tagCount / (size of the tag map)`, on a **three-cut
  ladder of fractions** — `TAG_DF_TOO_BROAD` 0.10 (= `BROAD_DF_THRESHOLD`, deliberately
  the same number), `TAG_DF_COMMON` 0.02, `TAG_DF_RARE` 0.008 — and the multiplier
  ternary is now one exported `dfMultiplier()` that the battery reads instead of
  mirroring.
- **The values are measured, not divided.** The today-equivalent fractions were run
  as a control in their exact four-cut form (60/1,561, 25/1,561, 10/1,561, 30/1,561):
  **bit-identical to `main`** — 0 status changes, 0 pick changes, 0 retrieval changes
  over 45 queries — which is what shows the normalisation itself moves nothing, so
  everything the ladder changes is the *values*. Then rejected as values: they sit in
  the densest part of the df distribution and still drift 32 buckets over the same
  five snapshots against 12 for the ladder. `TAG_DF_COMMON` is capped by product
  quality rather than taste: at 0.025 the battery goes red on "parenting" because
  `family` (2.50%) keeps full expansion weight and a hermit-crab kids-science episode
  reaches the top five.
- **What it costs today: 0 status changes over 45 queries, 5 pick changes.** Two are
  pure reorderings ("train history", "rome"); "endurance running", "jazz" and "fiction
  podcast" swap items. `jazz` loses `sticky-notes--gershwin-rhapsody` from its top 10,
  which is the one change worth a founder's eye. All ten queries #275 names are green,
  and 8 queries retrieve MORE (`war` 74 → 78 raw, `video games` 60 → 104) because terms
  that were deleted as too broad now enter expansions at 0.4x.
- **Growth, which is the point:** duplicating today's catalogue 2x moved **35 of 45
  query interpretations** before and **0** after; over the real nightly series the
  interpretation churn halves (76 changes over 30 queries → 38 over 21), and what is
  left is the corpus genuinely becoming more about a term (`crime` 2.2% → 4.2%).
- **Honest limit, and it is NOT df:** query STATUS is still not invariant under
  growth, because `RICH_MIN` counts bar-clearing results — duplicate the corpus and a
  sparse query goes "ok". 5 queries do that at 2x with every df bucket identical. That
  belongs to `classifyResults`, is not fixed here, and is why the new assertions read
  the interpretation rather than the status.
- **`data/item-tags.json` is still copied whole and the ~181 KB is still NOT taken.**
  #275 removes the ARITHMETIC divergence #274 feared (`war` 72 → 24 as counts, but
  4.61% → 3.70% as fractions: same bucket). What survives is SAMPLING — the bundled
  slice is 3 items per show, stratified by show and skewed by topic — so **12 terms
  still change expansion bucket and 62 the multiplier**, down from 66 and 176.
  `comedy` 10.70% → 8.47% is the sharp one: the website deletes it, the app would keep
  it. The follow-up that would buy the bytes is named in `docs/mobile-shell.md` §3.1:
  ship the trimmed map plus a precomputed df table (~1,400 numbers), which is a bundle
  change, not a search-quality one.
- **Shared files:** `search-engine.js`, `tools/test-search.mjs` (**GOVERNED**),
  `test/search-df-scaling.test.js` (new), `test/search-matcher.test.js` (its `tagDF`
  assertions read `tagCount` now), `test/suite-integrity.test.js` (one floor),
  `tools/mobile/prepare-webdir.mjs` + `.test.mjs` (the refusal, re-measured),
  `docs/mobile-shell.md` §3/§3.1, this file. **No `app.js`, no `data/`, no `mobile/`,
  no `player/`** — and deliberately no write to `data/discover.json` or
  `data/item-tags.json`, which another session is reading.
- **Watch out — `path-policy` goes RED, not flagged.** `tools/test-search.mjs` is a
  DENIED path and `PATH_POLICY_ENFORCE=1` (since 2026-08-16), so the check fails until
  a founder applies `founder-approved`. It does not block the merge — `backend` and
  `data-and-site` are the required checks — and the governed edit is not optional: §3
  of the battery mirrored `scoreMatch`'s df tiers, and a fraction against `10` would
  have left that mirror green while measuring nothing.
- **The battery is slower: ~110s → ~170s.** §10 re-interprets every query against a
  2x-duplicated pool. 4x and the whole-vocabulary drift witness live in
  `test/search-df-scaling.test.js` instead, where they cost seconds.

### mobile bundle — the catalogue ships as a bounded slice, and the cap stops being a date (2026-08-18, one PR, no follow-up)

- **What:** `perf/bundle-discover-trim`. `prepare-webdir.mjs` reported **2.98 MB of
  its 3.00 MB cap — 16 KB of headroom** — and `data/discover.json` grows ~35 KB every
  night, so the next catalogue refresh would have failed the mobile build and the
  failure would have read as the build breaking rather than as the catalogue growing.
  The bundle now carries a **bounded slice**: `BUNDLED_ITEMS_PER_SHOW` (3) items of
  each of the 213 shows — its join anchor plus the newest of the rest — plus enough to
  keep every topic represented, and
  **35 files, 1.96 MB** (was 2.98). O(shows × topics), not O(episodes), so a year of
  nightlies adds nothing to that file.
- **Not done, deliberately:** the cap was NOT raised and NOT lowered — 3 MB still
  means "something enormous got in", and a new per-file budget (800 KB) means "the
  slice stopped being bounded". **`data/item-tags.json` is deliberately NOT trimmed** —
  a reviewer caught that `search-engine.js`'s `tagDF()` counts entries across the whole
  map against absolute thresholds, so trimming it re-ranks 176 query terms in the app
  and not on the web. It stays a copy, so the bundle still grows ~4 KB a night: ~245
  nights of headroom, not a year, and `docs/mobile-shell.md` §3.1 says what fixing it
  needs. Fetching the tail of the catalogue at runtime is still **#40**: it needs the
  `connect-src` widening `docs/mobile-shell.md` §2.3 declined to add in advance, and it
  does not fix the build break.
- **Shared files:** `tools/mobile/prepare-webdir.mjs` (+ test),
  `tools/mobile/shell-invariants.test.mjs`, `test/suite-integrity.test.js` (two
  floors), `docs/mobile-shell.md` §0/§2.1/§3/§5, `docs/android-lock-screen.md` §10,
  `docs/narrator-pipeline.md`, `docs/DECISIONS.md`, `HUMAN-ACTIONS.md`, this file.
  **No change to `app.js`, `index.html`, the CSP, `sw.js` or anything the website
  serves** — the web keeps fetching the whole document.
- **Watch out — this PR touches NO `mobile/` file, so the usual "mobile/ waits for a
  human" reasoning does not apply to it.** The whole change lives in `tools/`, `test/`
  and `docs/`, all of which are on `ALLOWED_PREFIXES`. What holds it is one governed
  path: `docs/DECISIONS.md`. `path-policy` is **ENFORCING** (`PATH_POLICY_ENFORCE=1`
  since 2026-08-16, `HUMAN-ACTIONS.md` #1), so that check goes **RED** until a founder
  applies `founder-approved`. It is deliberate: the entry records that the app no
  longer ships the whole catalogue, which is worth a founder's eyes.

### search matcher — `grill` reaches `grilling`, and the third copy of the matcher dies (2026-08-17, one PR, founder-gated, no follow-up)

- **What:** `fix/218-219-suffix-matcher`. #218 (widen the SUFFIX side of
  `hitText`/`hitTag`; give under-4-char terms a plural) and #219 (delete
  `tools/topic-coverage-report.mjs`'s third copy of the matcher). **#216 is
  deliberately untouched** — search orders on `matched` while the strong bar
  filters on `sum`; it is real, separate, and bundling it makes this unreadable.
- **Shared files:** `search-engine.js`, `tools/test-search.mjs` (GOVERNED —
  blocks auto-merge, needs `founder-approved`), `tools/topic-coverage-report.mjs`,
  `data/topic-coverage-report.json` (regenerated), `test/search-matcher.test.js`
  (new), `test/suite-integrity.test.js` (one floor), this file. **Nothing else** —
  no `app.js`, no `player/`, no other `data/`.
- **The suffix set is bounded and named:** `s|es|ing` at >=4 chars, `s` alone
  under 4. Measured over all 1,364 concept terms against every surface word in the
  pool: on a 3-letter stem `es` yields only `rag`->`rages` and `ing` only
  `car`->`caring` — both wrong — so the short branch takes the plural and nothing
  more. **The prefix guard is byte-identical to `main`** and must stay that way;
  it is the only thing blocking `software`/`toward` as "war".
- **`ed` was in the set and was CUT during review, which is the useful lesson.**
  On the 51 needles it looked free (4 on-subject items). Measured over the whole
  vocabulary, ~4 of the ~18 matches it adds are on-subject and the rest are filler
  participles on terms that are not needles at all — "AI-powered threats" for
  `power`, "engineered", "launched" a startup for the space sense of `launch`. A
  51-needle radius answers "did anything break", not "is this suffix worth it".
- **KNOWN COST, disclosed not buried: `ing` makes the railway term `train` match
  `training`.** `train` is a term of the `trains` concept (transport/trains) and
  carries only the railway sense, so 32 fitness/dog-training/AI-pre-training items
  now match it, and `search("train history")` returns "The Pre-Training Wall" and
  a speed-training episode in its top 10. Not fixable by suffix choice — `ing` is
  what #218 asks for and `grill`/`grilling` needs it. It is an ambiguous bare stem
  in a single-sense concept, i.e. the vocabulary substitution #218 itself names,
  and dropping `train` from the concept would stop the natural singular triggering
  it at all. Filed as its own issue. Same shape, 1-2 items: `book`/booking,
  `wind`/winding.
- **There was a FOURTH copy of the matcher, inside `search-engine.js`.** `tagDF`
  inlines the pre-#211 loose predicate as an anonymous arrow, which the new scan
  structurally cannot see. It is behavioural — tagDF drives expansion pruning, and
  13 terms bucket differently than the shared matcher would give them (`ship` 155
  -> dropped vs 6 -> full weight, on a count made of `relationships`/`championship`
  substring hits). **Filed as #249**, not bundled: changing it moves rankings.
- **THE HEADLINE IN #218 IS NOT WHAT A LISTENER EXPERIENCED, and that is the
  finding.** `search("grill")` already returned 8 correct picks on `main`: the
  `bbq` concept hand-authors BOTH `grill` and `grilling`, so expansion rescued the
  query while the matcher stayed wrong. The `0` is the single-needle ORACLE count,
  which is what the battery's on-topic check and every coverage report use. Real
  damage: coverage under-counted, the ranking was wrong (Steven Raichlen, THE
  grilling author, sat 6th for "grill" and 1st for "grilling" — now 1st for both),
  and any term whose inflections nobody hand-authored was simply unreachable.
  `data/semantic-index.json` is full of hand-written inflection pairs
  (`engineering`/`engineers`/`engineer`, `trains`/`train`, `books`/`book`) doing
  this matcher's job by hand. Retiring them is a vocabulary question, filed nowhere
  yet, deliberately out of scope here.
- **All three section-6 collision assertions in the battery were VACUOUS,** found
  by mutation. Deleting the prefix guard left them green: the `diffusion` collision
  returns at raw index 13 with sum 6.00 against a 5.50 bar and is hidden only by
  the 10-pick truncation, while the other two are held out by scoring, not by the
  matcher. They now also assert on raw `results`; the direct witnesses live in the
  new unit suite, where breaking the guard kills 5 tests in milliseconds.
- **Numbers.** 51 needles over `fullPool()` (**1,540** items today, not the 1,516
  in #218): 1,261 -> 1,284, four needles move, all UP, nothing narrows. Coverage
  report, same data: `tag_count` 9,643 -> 8,875 (#219 removing optimism) -> 8,891
  (#218); `text_hits` 5,567 -> 4,966 -> 5,065. Battery 101 -> 107 passed, 0 failed.
  The matcher is also **2.5x faster than `main`** (patterns cached per term).

### playback speed — 0.75x-2x, and it survives a seam (2026-08-17, one PR, no follow-up)

- **What:** `feature/playback-speed`. Founder request: "add play speed options,
  for example 1.5x — copy what speeds are commonly used on other podcast apps."
  Six stops, `0.75 / 1 / 1.25 / 1.5 / 1.75 / 2`, persisted globally in `cp_rate`,
  on a cycle button on BOTH the mini-player sheet (which already had one) and the
  Foray page transport (which did not).
- **Shared files:** `player/playback-rate.js` (new, + suite),
  `player/queue-manager.js`, `player/html-audio-backend.js`,
  `player/client.js`, `player/media-session.js` (comment only), `app.js`,
  `styles.css`, `test/suite-integrity.test.js`, this file. **Nothing else** — no
  `data/`, no `sw.js`, no `mobile/`, no `ios/`, no `.github/`.
- **THE CONTROL ALREADY EXISTED AND WAS BROKEN BY DESIGN, which is the finding.**
  `client.js` shipped a `cp_rate` button with `RATES = [1, 1.25, 1.5, 1.75, 2]`.
  It could not work: `queue-manager.js`'s `restoreRate` effect read
  `item?.rate ?? 1.0`, no queue item this repo builds carries a `rate`, and the
  reducer emits `restoreRate` on **every** `itemLoaded` for a non-TTS item. So a
  stored 1.5x was thrown away by the first `play()` and a mid-listen change
  survived exactly one segment — a median 103 s — then reverted silently. **The
  reset everyone worries about here is the engine's `playbackRate = 1` on `src`
  assignment; ours arrived earlier and was worse.** The backend already survived
  the engine's (`_pendingRate`, re-applied in `play()`).
- **The per-item override is GONE rather than demoted.** `item.rate` is the port of
  the Swift's `item.showRate` (PlayerQueueManager.swift:335) — a per-show speed,
  which Apple really has. Nothing in the JS populates it, and the test helpers
  (`ep`, `seg`, `fseg`) all set a meaningless `rate: 1.0` that `??` cannot tell
  from a deliberate override, so left in it silently beat the listener for every
  item any future test built with them. A per-show speed needs its own key, its
  own control and its own precedence decision; #28 owns retiring the Swift copy.
- **`OUT_POINT_ARM_LEAD_SEC` moved 0.5 s -> 2.0 s, and rate is why.** The fine
  timer's content window is already flat in rate by arithmetic (`(end - now) /
  rate`, pinned with no clock). The **coarse** stage has no such property: its
  window is one tick of WALL clock, i.e. `rate` times as much CONTENT. Measured on
  a driven clock at the widest tick this repo has recorded (**1,825 ms**), with the
  old lead: **1x = 1,198 ms** of overshoot, **2x = 2,476 ms**. With the new lead
  the fine stage is armed at every ladder stop and it is **1x = 11 ms, 2x = 22 ms**
  — bounded by timer latency instead of event latency. At a healthy 250 ms tick
  both leads give 11/22 ms, so this only ever mattered on the tail, which is where
  CI and locked phones live.
- **Real-clock overshoot is NOT the instrument, and saying so is the point.** Four
  runs of the pre-existing real-clock sweeps gave a 1x worst of 183/197/354 ms and
  a 2x worst of 80/147/710/944 ms — an order of magnitude of spread in both
  columns, with one 2x sample landing exactly on what a bare tick check cost in
  the same run. A drafted four-phase 2x sweep was **removed** rather than added: it
  would have doubled this file's real-clock boundary runs on the one suite that has
  already reddened CI at random for a day, to measure something a driven clock
  answers exactly. The file's own rule — assert an ordering on a real clock, never
  a duration — is what that follows.
- **Three decisions, stated so they are not re-litigated by accident:**
  1. **The 2.0 s seam beat stays WALL clock and does not scale.** There is no
     content in it (it is not audio — principle 3), the audiobook section-break
     convention it comes from is perceptual, and it is also the window that hides
     the next segment's load — which takes wall clock. Dividing it by rate would
     shrink the cover exactly when seams arrive twice as often (#224). Pinned in
     `player/foray-playback.test.js`.
  2. **Stored progress is MEDIA time**, and already was: `forayElapsed` sums
     authored segment durations plus `backend.currentTime`, so a resume lands on
     the same audio whatever speed either session used. `ForayProgressStore`
     throttles on the clock VALUE (5 s of media) rather than on wall time, so the
     write cadence is rate-invariant too. The manager's 15 s position timer is wall
     clock and stays so — it skips bounded items entirely, so it does nothing at
     all during a Foray.
  3. **Global, one `cp_rate`.** A speed is a fact about the listener, and a Foray
     is an hour from nine shows, so "per Foray" would mean "per arbitrary bundle of
     nine publishers". Apple's per-show speed is an override on a global default;
     Spotify's failure to persist is its most-complained-about behaviour.
- **`mediaSession` is honest about it.** `setPositionState` now reports
  `backend.rate` — the ELEMENT's rate, not the chosen one — because the OS
  extrapolates as `position + rate x wall` and a rate Safari refused would drift
  the lock-screen scrubber away from the audio. `media-session.js` §4's documented
  beat-drift bound was restated: it is `SEAM_GAP_SEC x rate`, so 4.0 s at 2x rather
  than the flat 2.0 s the comment claimed. `mediaSession` is absent in Android
  WebView at the engine level, so this pays off on web and iOS only.
- **Two things the pre-push review found, both now closed.** (a) `setPositionState`
  reporting the element's rate was argued in three comments and pinned by NOTHING —
  the reviewer reversed both call sites to `manager.rate` and all 796 player tests
  stayed green. Two assertions in `media-session.test.js` now pin it, including the
  one-branch case. (b) `play()`'s `playbackRate` write was the last unguarded element
  write in the backend, and the two GUARDED sites both deferred recovery to it
  ("play() re-applies it") — so a refused rate could still reach `_loadItem`'s catch
  and stop the Foray. Guarded, and the comments no longer point at it.
- **Two presentation numbers that are MEDIA time and stay that way**, recorded
  rather than changed: `remainingLabel` ("42 min left" is 21 real minutes at 2x)
  describes content remaining, which is a stable property of the stored row, where
  the rate belongs to a session that has not happened yet. And `media-session.js`
  §4's restated drift bound is 0.13% of a 51-minute bar, not the 0.11% a first
  draft wrote — that figure used Foray #1's 61-minute runtime against the original
  sentence's 51-minute denominator.
- **The Swift is knowingly divergent and was NOT touched.**
  `ios/App/Player/PlayerQueueManager.swift:335` still reads
  `backend.rate = item.showRate`, i.e. it still has the bug. CLAUDE.md says the two
  mirrored files change together, and this deliberately breaks that: `ios/` is
  outside the auto-merge allowlist, so editing it would take this PR off the
  auto-merge path and onto a human. §12 in `queue-manager.js` names the exact Swift
  line so a porter working #28 cannot "restore" the per-item override by mistake.
- **2x is the top, and that is a Foray-specific answer.** Half the apps checked go
  to 3x or 3.5x. Rate does not slow any one seam load, but it multiplies how many a
  listener meets per wall minute, and a hidden-page load measures 5.1-11.1 s
  against a 20 s deadline — crossing which drops the segment (#224). 2x doubles
  that exposure for a speed people use; 3x trebles it for a speed few do.
  `playback-rate.test.js` asserts `MAX_RATE === 2` so shipping 3x requires
  deliberately editing a test.
### Android native code has a home, and a foreground service in it (2026-08-17, one PR)

- **What:** `feat/android-native-fgs`. `git ls-files` had **zero** `.java` and zero
  `.kt` files and `mobile/android/` is gitignored, so there was nowhere for the
  native code Android needs — and it needs some: **no `navigator.mediaSession` at
  any price** (MP1 §5.4, engine-level) and a **`mediaPlayback` foreground service**
  for backgrounded playback (§5.3). Resolved with a committed local Capacitor plugin
  at `mobile/plugins/foray-audio/`, wired in by Capacitor's own plugin discovery, so
  it survives `cap add android` regenerating the platform with nothing to re-run.
  Full reasoning and what was rejected: **`docs/android-native-code.md`**.
- **Shared files:** `mobile/.gitignore`, `mobile/package.json` + lockfile,
  `mobile/plugins/**` (new), `tools/mobile/prepare-webdir.mjs` (+ test),
  `tools/mobile/shell-invariants.test.mjs`,
  `tools/mobile/foray-audio-shell.test.mjs` (new), `docs/mobile-shell.md`,
  `docs/android-shell-build.md`, this file. **Nothing under `player/`** — #224 and
  PR #241 are live there — and nothing in `.github/`.
- **Both APKs still build**, no version pin needed: debug **5,025,787 B**, unsigned
  release **3,890,405 B**, measured after the rebase onto post-#241 `main`. 11 m 40 s
  and 18 m 33 s from cold, then two incremental rebuilds (3 m 42 s, 4 m 40 s).
  `lintVitalRelease` passed, including `:foray-audio:lintVitalAnalyzeRelease`. The
  growth against #37 is mostly `webDir` (2.63 → 2.73 MB), not the plugin. Same toolchain as #37 (Gradle 8.14.3, AGP
  8.13.0, JDK 21.0.12+8, minSdk 24, compile/target 36).
- **STILL NEVER EXECUTED, and read this before quoting the above.** No emulator, no
  device. The web half's state machine has 57 Node tests against fakes and 23 caught
  mutations; the manifest merge and both APK payloads were read out of build output.
  Whether the service *starts*, holds process importance, or keeps audio alive is
  **unverified** — as is Android 15's audio-focus rule, which cuts both ways
  (`docs/android-native-code.md` §6.2).
- **A REVIEW PASS FOUND FOUR DEFECTS THE FAKES COULD NOT**, and the worst one defeated
  the design's central safety property: `start()` reported the service's state from a
  read that races its own `onStartCommand`, so it was false on every first start, so
  the shell's short-circuit never fired and EVERY play() re-issued a start — including
  the one across a hidden seam, which is the background foreground-service start the
  settle window exists to avoid. Fixed; `state()`/`refresh()` is now the only truthful
  reading. The other three: a fatal media `error` never released the element (the
  service leaked for the session), the visibility net cancelled settle windows that
  were still counting, and `uninstall()` deleted later patches of `play`.
  `docs/android-native-code.md` §5.4.
- **A SECOND review pass found five more**, including the same re-issue loop reached by
  another route: the bridge-call in-flight marker was keyed on the method NAME, so
  across a start/stop/start interleave an earlier call cleared a later one's marker and
  let a redundant background start through. Also: a failed `stopService` reported the
  service as down, `uninstall()` stranded the foreground service, and two of my own
  tests were vacuous in the same way — asserting the dispatch list while a call was
  still in flight, where the queued duplicate is invisible. §5.6. **The lesson, stated
  because it is the transferable part: a fake written from the same mental model as the
  code cannot falsify that model, and an async fake lies specifically about ordering.**
- **DO NOT READ THIS AS A SEAM FIX.** Hidden-page throttling is on the media-load
  task chain and keyed to **visibility**, not audibility, so an FGS does not shorten
  a seam and neither do local files. The seam entries below are unaffected.
- **A live trap for anyone touching `mobile/.gitignore`:** its platform rules are now
  `/android/` and `/ios/`. Unanchored (`android/`) they match at **any depth** and
  silently ignore `mobile/plugins/foray-audio/android/` — that dropped four native
  files from a `git add` with no warning, and the build still passed on the machine
  that had them on disk. `shell-invariants.test.mjs` now asserts this through
  `git check-ignore`.
- **The toolchain lives in `%TEMP%`:** JDK 21 and the Android SDK are at
  `%LOCALAPPDATA%\Temp\mp1-android\{jdk21,sdk}`, with no JDK in `Program Files`,
  nothing on `PATH` and no `JAVA_HOME`. A Windows temp cleanup deletes the ability to
  build this app.

### hidden-page load deadline — a seam stops dropping the segment (2026-08-17, one PR, no follow-up)

- **What:** `fix/hidden-load-deadline`. `LOAD_SETTLE_TIMEOUT_MS` was one number for
  two very different machines. A **visible** load measures **590 ms**; a
  **hidden** load runs the same algorithm as queued tasks delivered seconds apart
  and measures **5.1–11.1 s** for the identical file. So 10 s was ~17x headroom
  visible and *negative* headroom hidden — and crossing it does not mean "slow",
  it means the manager degrades and **the segment is dropped**. Hidden loads now
  get **20 s**; visible stays 10 s; an injected `loadTimeoutMs` still wins.
- **Shared files:** `player/html-audio-backend.js` (+ test),
  `docs/research/mp1-background-audio.md`, this file. **Nothing else** — no
  `data/`, no `tools/`, no `.github/`, no manager change, no reducer change.
- **THE NUMBER COMES FROM A FLOOR. THERE IS NO USABLE CEILING — a first draft of
  this entry claimed one and the reviewer took it apart.** Floor: the worst
  **clean** chain, 9,153 ms (32036295743), × the **1.8x run-to-run spread**, + the
  cold-CDN allowance none of these exercised (TTFB 0.99 s median / 1.41 s worst,
  desktop, a lower bound) ≈ 18 s → **20 s**. The 11,140 ms sample is **excluded**,
  and saying so matters: it had a second element's teardown sharing the task queue
  (a path now parked), and at 11.14 s the same arithmetic gives 21.5 s — so "worst
  evidenced" without the exclusion stated is simply false.
- **WHY THE SUSPENSION IS NOT A CEILING, though it reads like one.** It is measured
  from when the app HIDES; this deadline starts at the BOUNDARY, which the probe
  pins 15.0 s later. Post-boundary the page has only **10.2 / 11.8 / 12.9 s** left,
  and in two of three runs the load finished with **under a second** to spare. So
  nothing above ~13 s can fire in the measured configuration, 20 s included:
  **the floor (~18 s) and the measured post-boundary window (~13 s) are
  incompatible.** That is the finding, not a problem with the number — a value
  below the floor guarantees the drops this exists to prevent, and 20 s means that
  when a hidden load is slow enough to matter, what ends the Foray is the
  SUSPENSION rather than our own impatience. One cause removed, the next exposed,
  which is why the suspension entry below is above this one in priority.
- **CORRECTION — THE "THROTTLING DEEPENS WITH HIDDEN TIME" TABLE DOES NOT HOLD,
  and the reason is a cross-pass pairing.** `hiddenPlaybackSec` (3.294 s in the
  retreat run, 15.124 s pre-#227) lives on **`foray_probe_outpoint`** — a
  different probe pass, a different app launch — and was paired with
  `observedGapMs` from `foray_probe_seam`. Measured on the seam records
  themselves, hidden playback before the boundary is **15.048 s / 15.033 s /
  15.018 s** across the three runs: identical by construction, because
  `probe-seam.js` pins it at `ARM_AFTER_HIDDEN_SEC = 15`. **So the pair cannot
  test the ramp — it does not vary the variable.** The hypothesis is neither
  supported nor refuted and stays open.
  **2026-08-17, PR #240 varied the variable and the answer is a CEILING (run
  32077857553).** The arm went to 60 s and the window to 175 s so the probe's own audio
  never stopped near the number in question. The record still ended at **+24.6 s** and
  the log still shows `didChangeThrottleState(Suspended)` at **+26.3 s** — with audio at
  **0.99992x wall clock** across the whole window and **no assertion-release timer armed
  anywhere**. So the ~26 s is time-since-hidden, not a consequence of our silences, and
  the `15 s of arm + a 10-13 s release` arithmetic that fit the three earlier runs was a
  coincidence (they all shared one arm value). Traced cause, from that log: a **~30 s
  UIKit background-task budget** expiring while the app cannot hold the RBS `'WebKit
  Media Playback'` assertion for want of `com.apple.runningboard.assertions.webkit` --
  the entitlement `UIBackgroundModes: audio` buys a real SIGNED app, so this is the one
  mechanism a Simulator cannot model. **`HUMAN-ACTIONS.md` #11 on a phone is now the
  highest-value twenty minutes in this project.** Both the arm and the window are
  reverted (at a 60 s arm the boundary lands past the ceiling and the probe measures
  nothing about the seam); `suspensionVerdict` and the record's `saveTrail` stay, and
  report it as section 3b of every job summary. **`MIN_HIDDEN_TRANSITIONS = 2` is
  unsatisfiable on this instrument** -- transition 2 needs ~39 s of hidden time -- so
  every `too-few-transitions` verdict to date describes the 30 s budget, not the seam.
- **WHAT THE SAME PAIR DOES SHOW, and it is the more useful finding: 1.8x
  run-to-run variance on identical code.** Retreat **5,114 ms** against pre-#227
  **9,153 ms** — same one-element path, same 15.0 s hidden position, same local
  bundled file. The whole difference is in one phase (`stalled` →
  `loadedmetadata`: **1,902 ms** vs **5,954 ms**). A hidden chain is a
  distribution we have three samples of, not a constant, which is exactly why the
  deadline is a multiple of the worst sample rather than the worst sample.
- **CAUTION ON THE DISCARD CORROBORATION — it is weaker than it looks, and I was
  asked to record it as corroboration.** The retreat improving on the pre-#227
  baseline (5.1 s vs 9.2 s) is tempting to read as "removing `_discardWarm`'s two
  queued steps was worth ~4 s". It is not safe to read that way: those two runs
  are the SAME code path on the discard question, so their 1.8x gap IS the
  variance envelope, and 11.1 s (the run with the discard) sits close to it. The
  real evidence for the serialized-queue diagnosis remains **within-run**: the
  discard's task steps timestamped ahead of the fallback's, and the two
  `selectMediaResource` calls 4 ms apart. Keep the mechanism, drop the arithmetic.

### the page SUSPENDS ~26 s into hidden time — instrument ceiling, possibly a real defect (2026-08-17, findings only, no code)

- **NOT FIXED HERE, and it is bigger than anything in the entry above.** In all
  three seam runs the durable record ends after **25.2 s, 26.8 s and 27.9 s** of
  hidden time, and `simulator-log-seam.txt` says why:
  `WebProcessProxy::didChangeThrottleState(Suspended)`,
  `ProcessThrottler::uiAssertionWillExpireImminently`,
  `WebProcessPool::applicationIsAboutToSuspend: Terminating non-critical
  processes`, `setProcessesShouldSuspend: Processes should suspend 1`. So it is a
  genuine suspension, not merely WebKit declining to flush localStorage.
- **Three consequences, in ascending order of importance.**
  1. **Every hidden number this repo has is from a window that ends at ~26 s.**
     Not "the first 15 s" as a matter of probe convention — a hard ceiling.
  2. **`MIN_HIDDEN_TRANSITIONS = 2` has never been satisfiable, so NO seam run has
     ever returned a pass.** All three record **one** transition and two audible
     items; `seg-b`'s out-point was armed (`outPoint.set 20.00s`) and the last
     durable write lands ~0.3 s before that boundary was due. The workflow's 90 s
     budget is adequate on paper (its own derivation reaches transition 2 at
     ~41 s); the app is not alive to reach it. **`seamTransitionVerdict` therefore
     returns `too-few-transitions` — "Reported as inconclusive rather than as a
     pass" — every time**, including for the retreat run (#235), which is better
     read as "the transition was restored" than as "verified". And the reason that
     rule exists is precisely the failure now evidenced: its own text says *"one
     transition can succeed inside WebKit's `audibleActivityClearDelay` grace
     window and the next still fail once the page has been silent long enough for
     the audibility assertion to lapse."* The probe was designed to catch this and
     has never been able to.
  3. **If this also happens on a real phone, a Foray stops advancing ~26 s after
     the screen locks, and no deadline anywhere fixes that.** It would make the
     seam work moot. **Do not assume it does** — the harness backgrounds the app
     by launching Settings on a Simulator with no real audio route, and
     `UIBackgroundModes: audio` is supposed to keep an app alive precisely while
     audio plays (MP1's central finding). A Simulator suspending a
     silent-to-the-OS app is entirely plausible as an artifact.
- **How to settle it, cheaply, in that order:** (a) `HUMAN-ACTIONS.md` #11 —
  someone's phone, screen off, twenty minutes, does the running order keep
  advancing? That answers the only question that matters and needs no build.
  (b) In the probe, force a `save()` at every boundary *and* shorten `seg-b` so
  transition 2 lands well inside the ~26 s window; that recovers the second data
  point and, with a longer first arm, tests the ramp. Both are `tools/` changes
  and belong to whoever owns #220.
- **Why the ramp was not probed here:** the instrument cannot currently reach
  past ~26 s of hidden time, so raising `ARM_AFTER_HIDDEN_SEC` to 45–60 s would
  move the boundary *beyond the suspension* and measure nothing. That is a
  finding, not a budget problem — the 90 s sleep is not the constraint.

### unsticking — the out-point flake, and PR #198's salvage (2026-08-17, one PR, no follow-up)

- **What:** `fix/flake-and-198`. Two unrelated blockages in one PR: (1) the
  wall-clock out-point budgets in `player/html-audio-backend.test.js` were
  reddening the root group at random; (2) PR #198 had been `DIRTY`/`CONFLICTING`
  for a day after #205 rewrote the file underneath it.
- **Owned files:** `player/html-audio-backend.test.js`,
  `data/breadth-classification.json`, `data/genre-taxonomy-map.json`,
  `tools/classify-breadth.mjs`, `tools/classify/root-dumping-report.mjs`,
  `test/data-topic-integrity.test.js`, `data/discover.json`,
  `data/top-topics.json`, `data/topic-coverage-report.json`. **Shared files
  touched:** `test/suite-integrity.test.js` (floors, isolated final commit),
  `tools/classify/README.md`, `docs/CATALOG-PIPELINE.md`,
  `docs/research/taxonomy-review-2026-08.md`, and this file. **Out of scope,
  deliberately:** `ios/`, `.github/`, `index.html`, `app.js` and any new app
  directory — a sibling session is scaffolding Capacitor there.
- **The flake was the test, not the backend.** Two bugs, both the same mistake:
  a budget that does not stretch with the load the measurement stretches with.
  The comparative fix #195 introduced took `Math.min` of the naive tick cost
  across four runs and `Math.max` of the overshoot across the same four, so the
  budget came from the least-loaded run and the measurement from the most-loaded
  one; and `observedTickMs` silently fell back to the **nominal** 250 ms tick
  when a run delivered fewer than two ticks — i.e. exactly on a slow box, where
  the real interval is wider. Reproduced at 1 run in 12 under 16 busy loops on
  16 cores. Fixed by pairing per run, and the rate claim now needs no clock at
  all (it reads the delay the fine timer is *armed* for). No product change.
- **#198 is landed by re-derivation, not by rebase, and its data file is
  discarded.** 1,000 of its 1,026 changed breadth rows (derived as 1,026 minus the 26
  that still change; #205 had estimated 969 by a different route) had since earned a real
  agent judgement from #205, which outranks the genre map by design — and taking
  its data file wholesale would have **regressed** the per-item metric from
  5,148 to 5,249. Re-running its own fixed generator on top of `main` instead
  gives **5,148 → 5,123**, which is exactly what #205 projected for the two
  together. Its durable half lands intact: the `classify-breadth.mjs`
  destructive-rewrite fix (which by now would have deleted 19,278 agent rows,
  not 1,851), the 7 genre-map corrections, `root-dumping-report.mjs`, and the
  curated pool's 108 → 31.
- **Not ported:** #198's `HUMAN-ACTIONS.md` item **#4** ("are the six classify
  routines alive?"). #205 answered it — all six, never dead, they just open no
  PR — and `main`'s item **#10** already carries the correct successor question.
  The #4 slot stays unused rather than renumbered; item numbers are stable IDs.
### #28 iOS half — the SEAM TRANSITION gets measured, and a wrong reading gets retracted (2026-08-17, one PR, founder-gated, no follow-up)

- **What:** `feat/ios-native-outpoint`, issues **#28** / **#35**. A fourth probe
  phase in the existing iOS CI harness: three bounded segments over three audio
  files, driven through the **real `PlayerQueueManager`**, backgrounded, reporting
  whether each seam transition (2.0 s beat → cross-episode load → seek → play)
  completes with the app never resumed. Docs: `docs/ios-ci.md` §3 "Probe C" and
  `docs/research/mp1-background-audio.md` **§0b**.
- **STACKS ON #213 (`ci/ios-build`) AND #209 (`feat/capacitor-shell`), and must
  merge after both.** Branched from `ci/ios-build`. #209 was `CONFLICTING` when
  this started (`app.js`, `STATE.md`, `HUMAN-ACTIONS.md`,
  `test/suite-integrity.test.js`) — expect a rebase; do not fix #209 from here.
- **THE SEAM RESULT, STATED THE WAY THE CODE STATES IT: `too-few-transitions`,
  NOT a pass.** Run 32036295743 got **1** hidden transition against
  `MIN_HIDDEN_TRANSITIONS = 2`, so **this does NOT close #28's iOS half** and the
  PR does not claim it does. What it does support: one full transition (beat →
  cross-episode load → seek → play) completed with the app backgrounded and never
  resumed, so nothing native is needed for the mechanism. What it also found, and
  the PR gives it equal weight: **the 2.0 s beat took 9,153 ms** — the timer armed
  in 2 ms, the *load* took nine seconds, on a **local bundled file**, and
  `beat-ended` landed on the same millisecond as `canplay`, so the silence is
  `max(beat, load)`. Filed as **#223** and **already fixed by #227** the same day
  (prefetch on a second element, 12 s before the out-point, while audio still
  flows); `seam-gap.js` is now explicit that its number is the BEAT, not the
  silence. **Nothing in `player/` is touched here, before or after that fix.**
- **THIS PROBE IS NOW #227'S ONLY VERIFIER, and #224 is why that matters.** Wyatt
  heard it on a real phone: *"transitions worked ok while my phone was unlocked, but
  when my screen was off then it would just pause"* — the load crossing **our own**
  `LOAD_SETTLE_TIMEOUT_MS` (10 s, `html-audio-backend.js`), which throws into
  `_loadItem`'s catch → `E.error` → idle → pause. **Do not merge the three 10,000 ms
  deadlines:** WebKit's audible-activity clear is **5 s** (measured, and the beat
  crossed it while playback continued), WebKit's foreground-assertion release is
  10 s, and `LOAD_SETTLE_TIMEOUT_MS` is 10 s and is #224's stated cause. The
  measured 9,153 ms is **92% of ours**; it is also 847 ms short of WebKit's, the same
  figure only because the constants match. To verify #227: dispatch `ios-build` on `main` and read `observedGapMs`
  — **expect ~2,000–3,000 ms**. Two traps: a **bridged** Foray is deliberately not
  warmed (eligibility is `seamGapSec > 0`), so "no change" there is not a failed
  fix; and `SEAM_MIN_PLAUSIBLE_MS = 500` stays meaningful because the beat is still
  2.0 s — do not relax it to accommodate a good number.
- **OPEN, and more serious than the gap — do not let it decay into a footnote.**
  The record stops at **+25.2 s of a 90 s hidden window**, 1 s after the second
  segment became audible, with the 1000 ms timer samples ending at the same instant
  and ~32 subsequent 2-second saves never landing. Either **the page stopped being
  scheduled** after a 9.15 s silence (which would make a hidden page descheduable
  mid-Foray and the shell approach unsafe) or **its writes stopped reaching disk**.
  Ruled out: the 90 s budget (~45 s needed, ~65 s unused), the screenshot (device
  screen, not the WebView), and the log (truncated at 20 MB before this pass began).
  `probe-seam.js` now records `saveSeq`/`firstSavedAtWall` so the next run decides
  it from the record alone. Both branches: `docs/ios-ci.md` §4c.
- **Three harness defects fixed on the way, all found by reading the artifact
  rather than the summary:** the log capture's 20 MB cap was spent by pass 1 so the
  seam pass had **no log coverage at all**; its predicate (`CONTAINS "App"`) spent
  the cap on the system (**1,153 of 99,491** lines were ours, ~1.2%); and **zero
  `FORAY_PROBE_` lines
  have ever been captured**, so `collectProbes`' console fallback has never once
  worked and `localStorage` is the only proven channel. Per-pass captures, a
  bundle-id predicate, and an explicit "unproven, not clean" note now ship.
- **SECURITY, fixed here: the evidence artifact was publishing a live credential.**
  `ls-rows-*.json` dumped the whole `localStorage` hex-encoded, and the raw
  `.localstorage` SQLite copies were uploaded too — so `cp_sb_session` (a Supabase
  `access_token` **and a `refresh_token`**, which does not expire in an hour) was
  downloadable by anyone from a public repo. Redaction is an allowlist
  (`/^foray_probe_/`), the raw DBs no longer enter the artifact at all, and a
  redaction failure is fail-closed and loud. **Revoking the leaked anonymous user
  and deleting run 32036295743's `ios-shell-evidence` artifact are founder actions
  and are NOT done here** —
  and the artifact must be deleted only *after* the docs carry its numbers, since
  it is currently the only place the measurement exists.
- **THE OUT-POINT HEADLINE IS A RETRACTION.** `fired-on-resume` from run **32023924627** was
  quoted onward as "the iOS out-point only fires on resume — MP1 §8's failure
  mode". It was a harness race with a **3 ms** overshoot, not a finding. Run
  **32026332637** is authoritative: overshoot **0.0045 s** over a **15.056 s**
  hidden window, 61 hidden `timeupdate` samples at a 252 ms median, `resumedAtWall:
  null`. **iOS needs no native out-point, and no Swift was added.** The same record
  also confirms MP1 §7.5's unverified 1 s DOM-timer alignment (median **1000 ms**),
  which is exactly why the *transition* — a `setTimeout` beat — still needed asking.
- **Owned files:** `tools/mobile/probe/probe-seam.{html,js}` (new).
  **Modified:** `.github/workflows/ios-build.yml` (a second probe pass),
  `tools/mobile/ios-ci.mjs` (+`seamTransitionVerdict`, `pickSeam`),
  `tools/mobile/probe/install-probe.mjs` (a `--phase` flag and two more tones),
  `tools/mobile/probe/probe-bridge.js` (phase routing), the three `tools/mobile`
  suites, `docs/ios-ci.md`, `docs/research/mp1-background-audio.md`.
  **Shared:** `test/suite-integrity.test.js` (three FLOORS raised), this file.
  **Untouched on purpose:** `player/**`, `app.js`, `index.html`, `mobile/**`,
  `ios/**`, `data/**`, `.github/workflows/ci.yml`.
- **NO NATIVE CODE, deliberately.** An AVPlayer stop-owner was started and thrown
  away once run 32026332637 was read: a native backend nobody needs is a
  maintenance burden and an invitation for the web and native players to diverge.
  If probe C comes back `seam-stalls-in-background`, *that* is when something
  native owns the transition — and the record will say which stage failed.
- **Touches `.github/`, which `tools/ci/path-policy.mjs` DENIES.** Correct and
  expected: the PR waits for a founder rather than auto-merging.

### MP4 — iOS builds on a runner, and three claims get measured (2026-08-17, one PR, founder-gated, no follow-up)

- **What:** `ci/ios-build`, issue **#38**. A `macos-latest` workflow that
  generates the Capacitor iOS project, adds the one `Info.plist` background-audio
  key, and builds it **unsigned** — plus two Simulator probes that settle
  questions nothing on this machine can reach. Doc: `docs/ios-ci.md`.
- **STACKS ON #209 (`feat/capacitor-shell`), AND MUST MERGE AFTER IT.** Branched
  from that branch, not from `main`: everything here builds the `mobile/`
  scaffold, which is still awaiting a founder. If #209 changes shape, this needs
  a rebase, not a rewrite.
- **New files:** `.github/workflows/ios-build.yml`,
  `tools/mobile/inject-background-audio.mjs`, `tools/mobile/ios-ci.mjs`,
  `tools/mobile/probe/**`, `docs/ios-ci.md`, and four suites
  (`inject-background-audio`, `ios-ci`, `ios-workflow`, `probe/install-probe`).
  **Shared files it touches:** `test/suite-integrity.test.js` (four FLOORS
  entries, isolated final commit), `HUMAN-ACTIONS.md` (new item **#19**, plus a
  dated note under **#16** and **#18** — no status changed), this file.
  **Untouched on purpose:** `.github/workflows/ci.yml`, `mobile/**`, `app.js`,
  `index.html`, `player/**`, `ios/**`, `data/**`.
- **IT TOUCHES `.github/`, WHICH `tools/ci/path-policy.mjs` DENIES.** That is
  correct and expected: the PR waits for a founder rather than auto-merging, and
  a workflow that can auto-merge a change to its own gates is not a gate.
- **DO NOT MAKE IT A REQUIRED CHECK, and do not widen its path filter.** macOS
  runners bill at 10x. This repo is public so standard runners are free today —
  but at ~12–18 minutes of wall clock a run is ~120–180 billable minutes the day
  it stops being public, and a sister project already suspected
  Actions-minutes exhaustion behind a build freeze. Trigger set is
  `workflow_dispatch` + a path filter on `mobile/`, `tools/mobile/`,
  `index.html`, `app.js`, `player/` and the workflow itself. No `push`, no
  `schedule`. `tools/mobile/ios-workflow.test.mjs` holds every one of those.
- **A SIMULATOR IS NOT A DEVICE, and a pass from one is weaker evidence than a
  failure.** It models neither power management nor true suspension. Anything
  the backgrounding probe reports as *fine* is one removed way of being wrong,
  not a settled question — `HUMAN-ACTIONS.md` #11 and #16 still want a phone.
  The sentence is `SIMULATOR_CAVEAT` in `tools/mobile/ios-ci.mjs` and ships with
  every report on purpose; do not paraphrase it away.
- **Deliberately NOT done:** committing `mobile/ios/` (that is #16 step 7, a
  founder call); Android anything (#18 stays open — a different injection
  mechanism, and this workflow says nothing about it); and the signing/TestFlight
  path is **written and never executed**, gated on seven secrets that do not
  exist (**#19**). Treat its first real run as debugging, not as a release.
### MP2 Android — the shell builds, and the CSP risk is answered (2026-08-17, one PR, no follow-up)

- **What:** `feat/android-shell`, issue **#37**. Android was the last unbuilt
  platform. `mobile/android/` is now generated and **both APKs build on this
  Windows machine**. Write-up: `docs/android-shell-build.md`.
- **THE BUILD, so nobody re-derives the toolchain.** `npm run add:android` clean;
  `./gradlew assembleDebug` **BUILD SUCCESSFUL in 18m 3s** on a cold Gradle cache,
  213 tasks, `app-debug.apk` **4,932,485 bytes (4.70 MiB)**; `assembleRelease`
  likewise unsigned. **Generated by Capacitor 8.5.0's template, not chosen by us:**
  Gradle **8.14.3**, AGP **8.13.0**, `minSdk` **24**, `compileSdk`/`targetSdk`
  **36**, cordova-android 14.0.1, androidx.webkit **1.14.0**. **This machine:**
  Microsoft OpenJDK **21.0.12+8**, SDK platform **android-36**, build-tools
  **36.0.0**. **No version pin and no `gradle.properties` line was needed** — it
  built as generated, which is a better position than iOS (`UIBackgroundModes`
  still has to be injected).
- **Heads-up — MP1's two Android traps are both still real.** Capacitor 8 needs
  **JDK 21** (17 dies at `:capacitor-android:compileDebugJavaWithJavac` with
  `invalid source release: 21`), and `local.properties` is a Java properties file
  so `sdk.dir` **must use forward slashes**. Commands are in `mobile/README.md`
  § Building Android. **No emulator was attempted and none should be** — MP1 §6.2
  burned ~75 minutes on three cold API-36 boots.
- **THE CSP VERDICT: our CSP does NOT block Capacitor's Android bridge, and this
  is an INFERENCE, not a measurement.** `docs/mobile-shell.md` §5 called this the
  top open risk and it is now answered by reading the installed
  `@capacitor/android` **8.5.0** Java. **The part that section got wrong: on 8.5.0
  the inline `<script>` is not the primary path.** `Bridge.loadWebView()` prefers
  `WebViewCompat.addDocumentStartJavaScript(...)` and then sets `injector = null`,
  so `WebViewLocalServer` is built with no injector, every `getInjectedStream` call
  site is null-guarded, and **our HTML is never rewritten** — Capacitor's own doc
  comment says the stream is only changed when `DOCUMENT_START_SCRIPT` is
  unsupported. On the fallback path the script is inserted at `indexOf("<head>")`,
  which in our `index.html` is **line 3**, nineteen lines ahead of the CSP `<meta>`
  on **line 22** — and a meta-delivered policy is only enforced from the point the
  parser reaches it. **Either reason alone is sufficient**, so the verdict does not
  depend on which path a WebView takes. Also read in full: `native-bridge.js`
  (1,039 lines) has **no `eval`, no `new Function`, no `createElement`, no
  `innerHTML`, no Blob and no Worker**, its transport is a `@JavascriptInterface`
  that CSP does not govern, and its `fetch`/XHR patches are gated behind
  `CapacitorHttp` being enabled, which our config does not do. **There is no
  CSP-governed operation in the bridge beyond the script's own execution.**
- **NOTHING WAS LAUNCHED. No emulator, no device, not one line read from a running
  WebView.** Do not cite the above as a measurement, and **do not cite #213's iOS
  "0 CSP violations" as covering Android** — that was `WKUserScript` on
  `capacitor://localhost`, a different mechanism on a different origin, which is
  the whole reason this was a separate open risk. **And be precise about what #213
  measured even on iOS:** the 0-CSP-violations reading is from a booted **iOS
  Simulator**; its arm64/Release step is a **compile only**, unsigned, never
  installed and never launched. An earlier draft of `docs/mobile-shell.md` §5 in
  this branch said "on both a simulator and an arm64 device" and that was wrong —
  caught by the reviewer pass, fixed, and noted here because it is the exact
  inference-to-measurement upgrade this workstream is supposed to be careful about.
  What settles it is a phone over
  USB and `chrome://inspect`, reading three values: any CSP violation,
  `typeof window.Capacitor`, `navigator.serviceWorker.controller` (must be
  `null`). `docs/android-shell-build.md` §3.
- **Good news that follows: the service-worker degradation in
  `docs/mobile-shell.md` §5 does not arise.** With the bridge alive
  `isNativePlatform()` answers `true` and `sw.js` stays off. Worth knowing that
  **Android only ever had ONE of the two signals** — the `capacitor:` origin check
  cannot help at `https://localhost`, deliberately — so a future Capacitor that
  drops or renames `isNativePlatform` takes Android's only signal with it.
  Confirmed from `CapConfig.java` defaults that the Android origin really is
  `https://localhost`.
- **`navigator.mediaSession` is still INFERRED absent, and MP1 §5.4 overstates
  it.** Settling it needs execution in the shipped WebView; this machine cannot
  reach one, so the claim stays exactly where MP1 left it — source-derived from
  `aw_main_delegate.cc`'s `kDisableMediaSessionAPI`. Nothing in this build can
  change it: the switch is appended by the WebView provider's own main delegate,
  so no Capacitor config, `gradle.properties` line or manifest flag turns it back
  on. **One false claim in `docs/research/mp1-background-audio.md` is CORRECTED
  here:** §5.4 ended *"Confirmed live: the spike logs `mediaSession present=` on
  startup — see §6"*, and §6 says the spike **never ran** and not one line was ever
  logged. That sentence described an instrument, not a result, and it was the only
  place an Android claim in that document looked measured. This branch was going to
  leave it alone because #220 had that file open; **#220 merged during the reviewer
  pass**, so it is fixed instead, and the replacement states that the claim is
  source-derived and what would close it.
- **Heads-up — the foreground service is NOT decided, and #227 is why it needed
  re-thinking rather than re-quoting.** #227 shrank a cross-episode seam from a
  measured **9,153 ms of silence** to the authored **2.0 s** by loading on a second
  element while the first is still audible. Audibility is the currency the whole
  Android argument is denominated in (Blink's 30 s `kRecentAudioDelay` grace), and
  it also removed a cliff, not just slack: 9,153 ms was **92% of
  `LOAD_SETTLE_TIMEOUT_MS`**, past which the segment is dropped. **So the
  engine-level case for an FGS is materially weaker.** But #227 is invisible to the
  two OS-level arguments, which are the ones MP1 §5.3 called *"where the shell
  actually fails"*: the **Android 15 audio-focus rule** (we target 36, so we are
  inside it from the first build, and every seam still ends in a `play()` — now on
  a *different element making its first sound*, which is one more surface, not
  fewer), and **process importance** (`startForeground()` confers *visible*;
  playing audio is nowhere on the documented ladder). **Verdict: not claimed either
  way.** Full reasoning in `docs/android-shell-build.md` §5, including the trap
  that #227's safety nets **cannot distinguish** an autoplay refusal from an
  audio-focus denial from a lost session — all three arrive as a rejected `play()`
  or an unexplained `pause`.
- **And the reason the FGS is not optional even if the audio survives:** no
  `mediaSession` means no notification and no lock-screen or steering-wheel
  controls, and an FGS is the only vehicle for them on Android. **#27's Android
  half and the FGS are one job, not two.** Now `docs/mobile-shell.md` §6 item 5.
- **`mobile/android/` is NOT committed, same call as `mobile/ios/`, and now for a
  second reason.** #213 generates iOS *in the job*; ~100 generated files with no
  reviewer, in a tree `cap add` rewrites on every sync, is the Android reason.
  (This bullet said "in a directory that auto-merges with no review window" until
  2026-08-18. That was never true of `mobile/` — it is not on `ALLOWED_PREFIXES`,
  so such a PR waits for a human. Corrected in six files; the decision is
  unchanged, and `docs/android-native-code.md` §8 states the rule.)
  `mobile/.gitignore` now ignores `ios/` and `android/` in full,
  which **reverses what its own comment used to say** — the reversal is argued in
  that file rather than done quietly. Regenerate with
  `npm install && npm run add:android`; nothing outside `mobile/package.json` and
  `capacitor.config.json` is needed.
- **Heads-up — generating the platform BROKE A GREEN TEST, and the fix has a
  second half.** `cap copy` writes a copy of `capacitor.config.json` into each
  platform's native bundle, so *"mobile/ is the only place a Capacitor config
  lives"* counted the artefact and failed on the machine that ran the documented
  command. The walk now skips the two platform directories, **derived from the real
  config's own `ios.path`/`android.path`**, and a **new test asserts both are
  gitignored in full** — because that skip is only honest while nothing inside them
  can be committed. Relax the ignore rule and the new test says so.
- **Heads-up — one guard genuinely lost CI coverage, and it is written down rather
  than papered over.** Android's `res/xml/config.xml` was left un-ignored so the
  `KeepRunning` footgun could be parsed — *an ignored file cannot be checked*. CI
  no longer sees it. **The vector goes away with it**: `KeepRunning="false"` can no
  longer be committed, because the file it would live in cannot be, and `cap add`
  regenerates it from a template that (verified on the real generated file) sets
  **no `<preference>` at all**. The committed half of the guard, over the parsed
  `capacitor.config.json` at any depth and case-insensitively, is untouched.
- **`mobile/package-lock.json` is now committed, and it fixes a false claim.**
  #36 said all seven `@capacitor/*` packages *"resolve to 8.5.0"* from a registry
  check with nothing installed. An install gives 8.5.0 for core/CLI/android/ios and
  **8.1.1 / 8.0.1 / 8.0.2 / 8.0.3** for the four plugins, which version
  independently. #213's workflow names the missing lockfile as *"the first thing
  that would make this job non-reproducible"*; it now has one, and `npm install`
  keeps working either way.
- **Owned files:** `docs/android-shell-build.md` (new), `mobile/package-lock.json`
  (new). **Shared files it touches:** `mobile/.gitignore`, `mobile/README.md`,
  `docs/mobile-shell.md`, `tools/mobile/shell-invariants.test.mjs`,
  `docs/research/mp1-background-audio.md` (one corrected sentence, §5.4 — see
  above), this file.
  **Deliberately untouched:** `HUMAN-ACTIONS.md` — the Android CSP item is **#18**
  and the founder-facing items this produces are **#11** and a new foreground-service
  call, but folding them in is being done by whoever owns that file (#231 has just
  edited #11 and #16), and an agent adding items to it in parallel is how that file
  collides. `player/**` (#227 landed there, #224 open), `.github/**` (governed; the
  Android workflow shape is described in `docs/android-shell-build.md` §3 rather
  than added), `test/suite-integrity.test.js` (not needed —
  `tools/mobile/shell-invariants.test.mjs` is at **32** tests against its existing
  floor of **27**, and that file is a standing collision magnet). No CSP change, no
  dependency beyond what Capacitor pulls, nothing in `data/`, `index.html`, `app.js`
  or `sw.js`.
- **Rebased onto `main` after #220, #211, #221, #222, #226, #214 and #231 landed
  mid-flight.** Three consequences folded in rather than left stale: #220's merge
  unblocked the `mp1-background-audio.md` correction above; **#211 fixed the exact
  wall-clock flake this branch observed** (the buffering-stall test now polls to a
  condition instead of sleeping 350 ms), so do not go hunting it; and #220's own
  `docs/ios-ci.md` is what showed that this branch had overstated #213's iOS result.
- **`tools/mobile/shell-invariants.test.mjs` is at 32 tests against a floor of 27**,
  so `test/suite-integrity.test.js` did not need touching — which is the point,
  since #211 and #220 both have that file open.
- **Related:** #37, #34, #36, #35, #27, #28, #38, #40, #213, #220, #227.

### seam prefetch — MEASURED ON A DEVICE AND RETRACTED; the handover is parked (2026-08-17, two PRs, one follow-up)

- **READ THIS BEFORE THE ENTRY BELOW, WHICH IS NOW WRONG IN ITS CENTRAL CLAIM.**
  The entry that follows describes PR #227 as shipped. It was, it was then
  measured on an iOS Simulator (run **32057395270**), and **it made the seam worse
  than the bug**: `observedGapMs: null`, `lastStage: canplay` — the listener hears
  a segment end and then nothing. Wyatt reported it as *"when my screen was off
  then it would just pause"*. `fix/seam-prefetch-off` parks it.
- **THE PREMISE WAS FALSE, AND THE CORRECTION IS THE MOST REUSABLE THING HERE:
  MEDIA-ELEMENT LOAD TASKS ARE THROTTLED BY VISIBILITY; DOM TIMERS BY
  AUDIBILITY.** They are different schedulers.
  `docs/research/mp1-background-audio.md` **§4.1a** now carries the numbers so
  nobody repeats the generalisation — §4.1 measured *timers* and #227 read it as
  covering *loads*. From that run's `simulator-log-seam.txt` (`WebKit:Media`
  element lifecycle; times are SECONDS SINCE THE PROBE PAGE STARTED and the
  out-point pause is at 32.49 s, so the audible row below happens BEFORE the
  boundary, which is the whole point of quoting it):
  **visible** 0.20/0.24/0.13 s between load-algorithm steps, ~570-590 ms total;
  **hidden + AUDIBLE** +3.47 s and +3.90 s between steps, then 5.0 s with no
  data, never finishing; **hidden + silent** +2.4/+3.5/+5.1 s, **11.14 s** total.
  The middle row is the refutation — those gaps happened at t=23.6 s and t=27.5 s,
  nine and five seconds BEFORE the boundary, while a segment was playing audibly,
  in the same window the out-point fired **1 ms** late. **Stated as an
  observation, not platform law:** N=1 per phase, one run, one engine, a
  Simulator. That is enough to park a feature built on the opposite assumption
  and not enough to quote as a WebKit invariant.
- **What landed to make `main` safe again:** (1) the handover is **default off**,
  and off means the second `<audio>` element is **never constructed** — a media
  element is a client of the same task queue the real load needs, so "off" has to
  mean absent, not idle; (2) **a boundary never does media work on the warm
  element**. That second one is the bug that turned a slow seam into a dropped
  segment: `_discardWarm` called `removeAttribute("src") + load()`, and its steps
  queued AHEAD of the cold fallback on the one queue (`WARM
  selectMediaResource "nothing to load"` at 38.46 s, `PRIMARY
  selectMediaResource` at 38.46 s — 4 ms apart). The fallback measured
  **11.14 s** here against **9.14 s** in run 32036295743: the ORDERING is
  within-run evidence, the ~2 s is a cross-run estimate across different builds,
  and either way it lands on the wrong side of `LOAD_SETTLE_TIMEOUT_MS`. The same
  hazard existed on the PROMOTE path (`_promoteWarm` dropped the demoted
  element's src at the boundary, and that element then becomes the warm one) and
  in the autoplay recovery; both now pause without dropping. Caught by the
  reviewer, not by the device — the promote never fired there.
- **`notReadyFor` was NOT weakened and must not be.** It was the guard working
  correctly; promoting an element that is not ready plays the wrong audio, which
  is worse than silence.
- **`PREFETCH_LEAD_SEC` is not a number to nudge.** 11.78 s of real lead in the
  audible window did not reach a promotable state against an ~11 s task chain
  with ~5 s of it before any data moves. Re-opening the handover needs a
  measurement showing a hidden-page load completing inside a lead a real segment
  can afford — not a second inference from the timer numbers. The machinery and
  its 44 tests stay, exercised behind `prefetch: true`, for whoever does that.
- **Heads-up for the #220 probe: it now measures the SHIPPED default, which is
  one element.** `tools/mobile/probe/probe-seam.js` constructs
  `new HtmlAudioBackend({ element, telemetry })`, so from this PR on it exercises
  the pre-handover path — which is what you want for a baseline, and is why the
  next `ios-build` run should report a ~9-11 s seam again rather than a drop. To
  re-measure the handover itself, that line needs `prefetch: true`, and the probe
  should then log `canPrefetch` so a run cannot be misread as testing something it
  did not.
- **THE FOLLOW-UP, authorised and separate: make `LOAD_SETTLE_TIMEOUT_MS`
  visibility-aware.** A hidden load is **structurally ~11 s on a small LOCAL
  bundled file** against a 10,000 ms deadline, so **dropped segments at seams
  predate #227** — the old path cleared that deadline by 847 ms and the log shows
  that was luck, not headroom. 10 s is generous while visible (a real load is
  590 ms); hidden needs to exceed a platform-imposed chain, with headroom, since a
  cold cross-origin CDN is worse than the local case measured. Converting drops
  into slow seams is the goal: a listener who hears a long gap still has a Foray.
  It changes behaviour for the web PWA too, and a dead URL will then hang for the
  hidden deadline instead of failing at 10 s — both costs go in that PR's body.
  §4.4's "cause is unknown" (3 of 5 hidden Chromium loads failing the same
  deadline) reads as the same finding on the other engine.

### seam prefetch — the original entry, superseded above (2026-08-17, one PR, no follow-up)

- **What:** `feat/seam-prefetch`. The 2.0 s seam beat is **not 2.0 s** —
  measured on a device-class run it is **9,153 ms**, and every millisecond of the
  excess is the media load. The next segment now loads on a **second `<audio>`
  element while the current one is still audible**, and the boundary hands the
  player role to an element that is already `canplay` at its in-point. A warmed
  seam is exactly the authored beat.
- **THE MEASUREMENT, so nobody re-derives it.** Run **32036295743**
  (`ios-build` on PR #220, iOS Simulator, app genuinely backgrounded, real
  `PlayerQueueManager` over real `HtmlAudioBackend`), `foray_probe_seam`:
  `askedGapMs: 2000` → **`observedGapMs: 9153`**. Stage trace: `boundary` +0 ms
  → `beat-armed` **+2 ms** → `load-started` +12 ms → **`stalled` +3,173 ms** →
  `loadedmetadata` **+9,127 ms** → `canplay` +9,142 ms → `beat-ended` +9,142 ms
  → `playing` +9,153 ms. **The JS timer is exonerated** (2 ms) and so is
  `seam-gap.js`. Out-point overshoot on the same transition: **3 ms**. Hidden
  DOM timers in that run: **1,000 ms median** (asked 250).
- **Two things that trace tells you and the headline number does not.**
  (1) The seam is `max(SEAM_GAP_SEC, load)`, so it was never 2.0 s.
  (2) **9,153 ms is 92% of `LOAD_SETTLE_TIMEOUT_MS`.** Cross 10 s and `load()`
  rejects and the segment is DROPPED — and on Chromium that already happens:
  `docs/research/mp1-background-audio.md` §4.4 measured 3 of 5 hidden-page loads
  failing with "did not settle within 10000ms". A slow seam and a dropped
  segment are the same defect at two loads.
- **The cause is SILENCE, not the CDN — this is the design input.** The boundary
  pauses the element, the page stops being audible, and audibility is what keeps
  the process out of suspension: WebKit takes a foreground assertion *because* a
  view is playing audio (§7.4), and Blink is **measured** to throttle a hidden
  page ~21× the moment the element pauses while leaving an audible one alone
  (§4.1: 111 ms median for a 100 ms timer, identical to visible). The file in
  the measured run was `probe-tone-b.wav`, **bundled in the app** — so this is
  not network latency and a warm HTTP cache would not have helped. A load issued
  after the boundary runs in the worst window the platform has.
- **Owned files:** none new. **Shared files it touches:**
  `player/html-audio-backend.js` (+ test), `player/queue-manager.js` (+ test),
  `player/seam-gap.js` (header only — it documented a 2.0 s seam the product did
  not have), `player/client.js` (three lines), `test/suite-integrity.test.js`
  (two floors raised, isolated final commit) and this file. **No `docs/` change:
  the argument, the measurement and the trace live in
  `player/html-audio-backend.js`'s header, which is where someone editing this
  will actually read them.**
  **Nothing in `data/`, nothing in `tools/`, nothing in `index.html`, nothing in
  `sw.js`, no CSP change, no dependency.** `player/queue-state.js` is
  **unchanged** — no new state, no new event.
- **Heads-up — THERE ARE TWO `<audio>` ELEMENTS NOW, and exactly one may make
  sound.** `backend.el` is the player and owns the audio session;
  `backend._warmEl` is a loader that is never played, never un-paused and never
  given a volume, and a handover pauses the outgoing element **before** the
  swap, so at no instant are two elements un-paused. On iOS a second element
  that begins playing takes the session and silences the first, and **a
  foreground test would never show it**. If you touch this file, that invariant
  is the one to preserve; it has a named test.
- **Heads-up — NEVER `backend.el.addEventListener` AGAIN.** The role moves
  between elements at every cross-episode seam, so a listener bound to one
  element is stranded on a paused, src-less element for the rest of the Foray
  and the UI silently stops repainting. `client.js` did exactly this for
  `render` and now calls **`backend.addMediaListener(type, fn)`**, which
  migrates. Both `backend.el.playbackRate` reads are fine — they resolve the
  live element at call time.
- **Heads-up — the lead time is 12 s and it is derived, not chosen.**
  `PREFETCH_LEAD_SEC` = `LOAD_SETTLE_TIMEOUT_MS` (10 s, the longest a load is
  allowed to take before this backend calls it broken) + ~2 s for the trigger's
  own lateness (the widest `timeupdate` interval this repo has recorded is
  1,825 ms against a 250 ms nominal). The measured 9,153 ms load fits with 2.8 s
  to spare. Upper bound is content: no segment may be under **30 s**
  (`segment-length-rules.md` hard floor) and Foray #1's run 51–238 s, median
  103 s — so warming never starts before the current segment is audible and
  costs the last ~11% of a typical one. It is divided by playback rate at the
  point of use, because a load takes wall clock and not content.
- **Heads-up — ONE segment ahead, and same-episode seams are deliberately NOT
  warmed.** **16 of Foray #1's 31 seams cross to a different episode**; the
  other 15 stay inside one and are already served by `load()`'s same-source
  seek, which keeps the buffer. Warming those would refetch a whole podcast to
  reach a position we already hold, and on an ad-stitched host the refetch can
  come back differently stitched — the exact hazard the shortcut exists to
  avoid. (Foray #2: 10 of 21 cross-file.)
- **Heads-up — A BRIDGED FORAY GETS NO WARMING AT ALL, so do not read "no
  change" as a failed fix.** Eligibility is `seamGapSec(...) > 0` and that
  returns 0 for a bridged seam, so if the next queue entry is a narration
  bridge, nothing is warmed — and the load after the bridge is unwarmed too,
  because by then the bridge is the current item. Neither shipped Foray has any
  narration, so today this is theory; the moment one does, its seams revert to
  the old cost and the ear test in `HUMAN-ACTIONS.md` #11 will honestly report
  no improvement. Warming a bridge is a small change (a bridge is our own small
  asset) and is deliberately not in this PR.
- **Heads-up — ONLY an autoplay refusal is recovered, and the check is
  load-bearing.** `AbortError` is the ordinary rejection of a pending `play()`
  that a `pause()` or a fresh `load()` interrupted, and the manager emits
  `pausePlayback` before `loadItem` on both a pause and a skip — so that window
  is reachable by an ordinary tap. Recovering there would re-load the segment,
  re-arm the boundary and CALL PLAY: audio restarting right after the listener
  stopped it, with every surface showing paused. Found by the reviewer pass, not
  by the tests; it now has its own named test.
- **Heads-up — the beat is STILL 2.0 s and that is deliberate.** It is an
  authored pause between two voices (`segment-length-rules.md` §6b), not an
  artifact of loading, so the manager still waits out its remainder after the
  handover. The fix makes the listener hear the 2.0 s the product documents
  instead of 9.2 s of nothing. It also keeps the #220 probe's
  `SEAM_MIN_PLAUSIBLE_MS` (500 ms) floor meaningful.
- **Heads-up — losing the race costs exactly what today costs, by construction.**
  If the warm element is not ready when the out-point fires, `load()` takes the
  identical path it takes today. `load()` also ends with the warm element either
  promoted or **holding nothing** — never a third state — so a buffer warmed for
  a segment the listener skipped past can never be promoted for the wrong item.
  Nothing here can delay or move the boundary; the out-point path is untouched.
- **Heads-up — two safety nets, because the two ways this could fail on iOS are
  both invisible in a foreground test.**
  (1) **Autoplay policy is per ELEMENT.** The element the listener tapped is the
  other one, so a promoted element can be refused. In the Capacitor shells it
  cannot happen (`mediaTypesRequiringUserActionForPlayback = []`, MP1 §7.3) and
  in the web PWA exactly one handover per session is exposed — the first, after
  which both elements have played. A refusal is **recovered**, not reported: the
  player falls back to the element holding the gesture, at the same offset,
  **re-arming the same boundary** (a recovery that forgot it would run a median
  936.5 s of the wrong episode), and warming stops for the session.
  (2) A `pause` **nobody asked for** while a prefetch is in flight is what losing
  the audio session looks like from JS. It is never resumed through — a phone
  call arrives the same way — it is recorded and warming stops for good.
- **Heads-up — NO NEW TIMERS. Not one.** The trigger is `timeupdate` (a media
  event, 252 ms median while hidden); completion is
  `loadedmetadata`/`seeked`/`canplay`. Nothing in this feature depends on a DOM
  timer, which is the point on a platform that aligns hidden-page timers to 1 s.
- **NOT VERIFIED ON A DEVICE — this is the honest gap.** Every number above is
  from run 32036295743 or the Blink measurements in
  `docs/research/mp1-background-audio.md`; the *fix* is proven by 41 new
  mutation-tested unit tests and by a virtual-clock measurement of the seam
  (9,153 ms → 2,000 ms), on a Windows box with no simulator. **The rig to settle
  it already exists and needs no new code:** `ios-build` (on PR #220) triggers on
  `player/**`, and `tools/mobile/probe/probe-seam.js` drives the real manager
  over the real backend across three DIFFERENT files, so it exercises the
  handover as-is. Once #220 lands, dispatch `ios-build` on `main` and read
  `observedGapMs` — expect ~2,000–3,000 ms, not ~9,000. Noted on
  `HUMAN-ACTIONS.md` #11, which is the ear test this makes concrete.
- **For whoever owns #220:** the mechanism your probe measures has changed under
  it. Its header still describes the seam as "wait a 2.0 s beat → load a
  DIFFERENT episode", which is now "load during the tail → hand over → wait out
  the beat". The numbers it records are still the right numbers and the verdict
  logic still holds; only the prose is stale.
- **Related:** #111, #65, #28, #35, #220, #211 (open, edits
  `player/html-audio-backend.test.js` — this branch appends to that file rather
  than editing it, so the two do not collide).

### MP2 — the native app shell (2026-08-17, one PR, founder-gated, no follow-up)

- **What:** `feat/capacitor-shell`, issue **#36**. The Capacitor scaffold and the
  four architecture changes it forces. Architecture doc: `docs/mobile-shell.md`.
- **Owned files:** `mobile/**` (new), `tools/mobile/**` (new),
  `docs/mobile-shell.md` (new). **Shared files it touches:** `app.js` (one
  guarded service-worker registration at the very end of the file),
  `index.html` (one CSP token), `test/suite-integrity.test.js` (two FLOORS
  entries), `ios/README.md` (a status box at the top), `CLAUDE.md` § Layout,
  `docs/DECISIONS.md`, `HUMAN-ACTIONS.md` (new items **#15**, **#16**, **#17**,
  **#18**),
  this file. **Untouched on purpose:** `sw.js`, `data/**`, `player/**`,
  `backend/**`, `.github/**`.
- **THE `ios/` VERDICT — READ THIS BEFORE YOU TOUCH ANYTHING iOS.** `ios/` is now
  **reference material, not the shipping app.** The shipping iOS app is the
  Capacitor shell in **`mobile/`**. `ios/` is **not moved and not renamed** —
  #36 recommended `ios-native-reference/`; `ios.path` in
  `mobile/capacitor.config.json` isolates the generated project for free, so the
  rename was skipped. **That is a deviation from an explicit issue recommendation
  and is cheap to overturn** (one `ci.yml` path + two issue bodies).
  **Get the duplication right — the loose version of this is wrong and was in an
  earlier draft of these docs.** `ios/ForayKit` is alive and CI compiles AND
  TESTS it (`ios-kit`, macOS): `ForayKit/…/PlayerQueueState.swift` ↔
  `player/queue-state.js` is a **maintained mirror, tested on both sides** — change
  both. Only `ios/App/Player/PlayerQueueManager.swift` ↔ `player/queue-manager.js`
  is one-sided, and the two bugs that port surfaced were **fixed** in the Swift by
  PR #50, so it is uncompiled-by-CI rather than known-wrong.
  `IntentGrammar.swift` has no JS counterpart at all. The real argument for the
  web player: `foray-resolve`, `foray-queue`, `seam-gap`, `seek-policy`,
  `html-audio-backend` and `durable-store` have **no Swift counterpart**. Retiring
  the Swift copies belongs to #28.
- **Heads-up — the repo root is still dependency-free, and there is now a test
  that will fail you for changing that.** Capacitor lives entirely in `mobile/`
  with its own `package.json`. `tools/mobile/shell-invariants.test.mjs` asserts the
  root declares **no** dependencies/devDependencies/peerDependencies/
  optionalDependencies, has **exactly one** script (`test`), and has no lockfile
  and no `node_modules`. If you legitimately need to change that, it is a visible
  edit in a PR — which is the point.
- **Heads-up — `mobile/www/` is a BUILD ARTEFACT and is gitignored. Never edit
  anything in it.** It is a *copy* of `index.html`/`app.js`/`styles.css`/`player/`
  plus the runtime `data/` subset, rebuilt by
  `node tools/mobile/prepare-webdir.mjs`. Editing it forks the player, which is
  the specific failure mode that script's header exists to prevent.
- **Heads-up — the bundle's data list is DERIVED from `app.js`'s `fetchJson`
  calls.** Add a `fetchJson("data/new.json")` and the next bundle carries it, no
  edit needed. But the bundle is capped at **3 MB and today it is 1.96 MB** (35
  files). If you make the client fetch something large, `prepare-webdir` **fails the
  build**. Do not raise the cap to make it pass — that cap is what keeps the 16 MB
  `breadth-classification.json` out.
- **Heads-up — `data/discover.json` is NOT copied into the bundle; a bounded SLICE of
  it is.** The bundle hit 2.98 MB of the 3.00 MB cap on 2026-08-18 with
  `discover.json` growing ~35 KB every night, so the next refresh would have failed the
  mobile build. It now carries `BUNDLED_ITEMS_PER_SHOW` (3) items of each of the 213
  shows plus enough to keep every topic — 622 of 1,534 items, 680 KB — which is
  O(shows × topics) rather than O(episodes), so a year of nightlies adds nothing. If you
  add a data file whose size tracks the CATALOGUE rather than the product, it needs a
  `PROJECTED_DATA` entry too. **And do not trim `data/item-tags.json`** — it looks like
  a free 174 KB and it silently re-ranks search in the app; `COPIED_WHOLE` and
  `docs/mobile-shell.md` §3.1 explain why.
- **Heads-up — `app.js` no longer registers the service worker unconditionally.**
  It asks `shouldRegisterServiceWorker(window)`: off inside the shell, on
  everywhere else. Gated on `window.Capacitor.isNativePlatform()` and the
  `capacitor:` origin, and **deliberately not on the hostname** — Capacitor's
  Android default origin is `https://localhost`, so a hostname check would kill the
  service worker for anyone serving the real site from a local dev server, and
  **deliberately not on the user-agent** — every real listener is on a phone, so a
  UA sniff would switch the offline shell off for the whole audience. The two
  signals are in **separate `try` blocks**: sharing one made the guard fail OPEN
  when the bridge threw. Six tests execute the real `app.js` in six environments.
- **Heads-up — `index.html`'s CSP gained `'self'` on `img-src`, and it fixes a
  latent iOS-only bug.** The iOS shell's origin is `capacitor://localhost`, so the
  app's **own bundled icons** matched neither `https:` nor `data:` and would have
  been blocked. Android's `https://localhost` default would never have shown it.
  `media-src https:` was **already** present from #24 — #36 assumed it still needed
  adding; it did not, and it is now pinned by a test. `connect-src` was
  deliberately **not** widened; that belongs with #40's refresh code.
- **NEVER set the Cordova preference `KeepRunning` to anything but `true`** (MP1's
  finding, now mechanical). Note it is an **allowlist**, not a denylist: Cordova
  reads the preference with `Boolean.parseBoolean`, so `0`, `no` and `off` are all
  false too, and an earlier draft of the guard only rejected the literal `false`.
  Two tests: one over the parsed config at any depth, case-insensitively, and one
  that parses the Cordova-compat `config.xml` files `cap add` will generate —
  which is why `mobile/.gitignore` deliberately does **not** ignore Android's
  `res/xml/config.xml`, though Capacitor's own template does. An ignored file
  cannot be checked.
- **THE TOP OPEN RISK IS ANDROID'S INJECTED BRIDGE vs OUR CSP.** Capacitor Android
  injects `native-bridge.js` as an **inline `<script>`**, and our CSP is
  `script-src 'self'` with no `'unsafe-inline'` — which a `<meta>` CSP cannot fix
  with a nonce. If it is blocked, `window.Capacitor` never exists, all four plugins
  are dead, **and the service worker registers inside the Android shell** because
  the origin there is an ordinary `https://localhost`. Unproven (nothing was
  built), and iOS injects via `WKUserScript` so it is likely Android-only. It is
  the first thing to check on a device, and the fix may not be one token — see
  `docs/mobile-shell.md` §5. MP1's spike APK did not load the real `index.html`, so
  it never exercised this either.
- **NOTHING WAS GENERATED, INSTALLED, COMPILED OR LAUNCHED — do not report
  otherwise.** No `cap init`, no `cap add`, no `mobile/node_modules`,
  no `mobile/ios/`, no `mobile/android/`. All seven `@capacitor/*` packages were
  checked against the npm registry and resolve to **8.5.0**, but nothing was
  installed locally. Every claim about a *running* app is unverified, and the CSP
  change specifically is reasoned from WebKit's scheme behaviour rather than
  observed. Committing a few hundred unverifiable generated native files was
  rejected; a founder runs one command on a Mac instead (`HUMAN-ACTIONS.md` **#16**).
- **Heads-up — bundled data is FROZEN at build time.** Nothing in the shell
  re-fetches data, so a shipped app would show its build day's session forever.
  That is #40's remaining half and it is now a named release gate
  (`HUMAN-ACTIONS.md` **#17**).
- **This PR waits for a founder and that is expected.** It touches `ios/`,
  `CLAUDE.md`, `docs/DECISIONS.md`, `index.html` and `mobile/` — `CLAUDE.md` and
  `docs/DECISIONS.md` are auto-merge **DENIED**; the rest are simply unlisted. No
  `hold` label needed.
- **Related:** #36, #34, #35 (the spike that shaped it), #28, #27, #40, #38.
### delete my data — the control Play's deletion question needs (2026-08-17, one PR, no follow-up)

- **What:** `feat/delete-my-data`, issue **#42 (MP8)**. The menu now carries
  **Delete my data**: it clears **both** local tiers and deletes the account's rows
  on the server, or says plainly that it could not. `docs/legal/data-safety.md`
  §A7 flips from **No** to **Yes**, which was the one answer in that file that
  blocked a store submission.
- **New files:** `test/data-deletion.test.js` (37 tests). **Shared files it
  touches:** `app.js` (the § delete my data block + one line in `init()`),
  `player/durable-store.js` (`purge()`), `player/client.js`
  (`stopForDataDeletion()`, and `stopAndClose({ persist })`), `styles.css`,
  `player/durable-store.test.js` (+11), `player/foray-playback.test.js` (+1),
  `test/suite-integrity.test.js` (one new floor, two raised, isolated final
  commit), `docs/legal/{privacy-policy,data-safety}.md`, `HUMAN-ACTIONS.md`
  (#13 step 6 answered, new **#14**), this file. **Nothing in `data/`, nothing in
  `tools/`, nothing in `index.html`, nothing in `sw.js`, nothing in `backend/`.**
- **Heads-up — the ORDER is the feature, and it is easy to "tidy" backwards.**
  Remote rows go first, local second. `cp_sb_session` is the only credential that
  can reach those rows, so clearing local first would strand them permanently. A
  remote failure therefore STOPS the run with the device untouched, reports "your
  server rows were NOT deleted", and offers a separate device-only clear that says
  the rows remain. There is deliberately no success wording on that path.
- **Heads-up — the key list is DERIVED, in the code and in the tests.**
  `DurableStore.purge()` enumerates the tiers (not the facade — `length`/`key(i)`
  hide `cp_storage_health`) and re-reads them afterwards; `unverified` records a
  tier it could not read, because "I could not look" is not "it is empty". The
  suite scans the shipped source for `cp_` literals, requires all 20 families to
  be cleared, and pins them against the privacy policy's §1 table in **both**
  directions. Add a 21st key and CI fails until the policy documents it.
  `SB_USER_TABLES` is pinned against the RLS migration the same way.
- **Heads-up — the anonymous ACCOUNT is not deleted, on purpose.** An `auth.users`
  row needs the Admin API and a service-role key, which cannot ship in a public
  page (CLAUDE.md item 2). Every row keyed to it is deleted and the token is
  discarded, so the next event creates a NEW anonymous user rather than
  re-attaching. Removing the empty shell is `HUMAN-ACTIONS.md` **#14** (a
  `security definer` RPC); the client call is ~10 lines when it exists.
- **Heads-up — the control is BUILT IN JS, not in `index.html`.** Same reason
  `player/client.js` builds the mini-player: `index.html` is not auto-merge
  allowlisted, and this should not need a founder merge. The drawer button is
  appended to `#drawer`; the sheet is appended to `<body>` and reuses the reason
  sheet's CSS shell.
- **Heads-up — playback stops FIRST, without flushing.** A running player writes a
  position every ~15 s, so a clear under live playback is undone one tick later.
  `stopAndClose()` now takes `{ persist }` and every other caller still flushes.
  `buildCards()` is deliberately NOT called after a clear either — it writes
  `cp_recent_branches` and `cp_seen`, and the deletion is also the one action the
  app does not `logEvent` (that would mint `cp_profile_id` and a new account).
- **Left for the founder:** the **data-deletion URL** for both listings
  (`HUMAN-ACTIONS.md` #13 step 2 — a hosting task; policy §7 is written to be that
  page), and **#14** above. Nothing in this PR is blocked on either.
- **Related:** #42, #40 (the tiering this had to defeat), #212 (the audit),
  ADR-0005.

### MP1 spike — background audio in a Capacitor WebView (2026-08-17, one docs PR, no follow-up)

- **What:** `docs/mp1-background-audio`, issue #35 — the spike that gates #34.
  Answer: **`<audio>` keeps playing when the app is backgrounded and the screen
  locks on both platforms — but unprotected on Android without a foreground
  service, and "the audio keeps playing" is the easy half.** Write-up:
  `docs/research/mp1-background-audio.md`. **Deliberately not an ADR**, because
  `docs/adr/` is auto-merge DENIED and this is research, not the decision.
- **Owned files:** `docs/research/mp1-background-audio.md` (new). **Shared files
  it touches:** `HUMAN-ACTIONS.md` (new items **#11** and **#12**; also added the
  `**Status:** OPEN` line that item #9 was missing, so it can actually be
  answered) and this file. **No code at all** — nothing in `data/`, `player/`,
  `tools/`, `app.js` or `.github/`.
- **Three findings that change issue scope:**
  1. **iOS background audio costs ONE `Info.plist` line** — `UIBackgroundModes:
     audio`. No plugin, no Swift, no `NativeAudioBackend`. WebKit sets the
     `AVAudioSession` category to `MediaPlayback` itself, and
     `MediaSessionManagerIOS.mm`'s restriction table deliberately omits
     `MediaType::Audio` from both the background and the under-lock restriction
     (Web Audio carries both — but we cannot use Web Audio anyway, for the CORS
     reason already documented in `html-audio-backend.js`). **#35's own method
     section is wrong on this** and says native session code is needed.
  2. **`navigator.mediaSession` is DISABLED in Android WebView** by a Chromium
     command-line switch (`kDisableMediaSessionAPI` in `aw_main_delegate.cc`,
     comment: "WebView does not support MediaSession API"). So **#27 cannot be
     delivered in the Android shell from JS at any price** — lock-screen and
     steering-wheel controls become native work. Biggest scope change in the
     spike, and nothing to do with backgrounding.
  3. **A missed out-point is a ~15-minute defect, not a 1-second one.** Measured
     over the real data: **0 of 32** Foray #1 segments (and 0 of 22 in Foray #2)
     end within 30 s of their source file's end, so there is no benign case.
     Median overrun **936.5 s**; worst 42 min. Miss only the FIRST out-point and
     the listener gets 2.5 min of Foray then **20.4 min of one Origin Stories
     episode**, with the UI still highlighting segment 1.
- **SUPERSEDED 2026-08-17 by a real iOS measurement — READ THIS BEFORE THE
  PARAGRAPH BELOW.** Run 32036295743 measured the beat at **9,153 ms against 2,000
  ms asked**, backgrounded, on a **local bundled file**. The Chromium figures below
  (2.8–4.6 s) are still correct *for Chromium*, and the "do not redesign the beat"
  ruling still holds — the beat's own `setTimeout` armed in **2 ms** and is
  exonerated. But "SAFE" is no longer the right word: the beat is
  `max(gap, load)` and the LOAD took nine seconds, leaving **~850 ms** of margin
  against WebKit's `audibleActivityClearDelay` — **measured at 5 s, so the beat
  crossed it outright** — rather than the comfortable
  window the paragraph below implies. The "one unmeasured risk" it names at the end
  is therefore no longer unmeasured and was very nearly realised. Details:
  `docs/ios-ci.md` §4c, `docs/research/mp1-background-audio.md` §0b.
- **Heads-up — the 2.0 s seam beat is SAFE ON CHROMIUM backgrounded, and this was
  the specific worry.** The beat pauses the element, which withdraws the audibility
  everything else depends on — but both engines carry a far longer grace window:
  **30 s** on Chromium (`kRecentAudioDelay`, whose source comment reads "A page
  cannot be throttled or frozen 30 seconds after playing audio") and **10 s** on
  WebKit (`audibleActivityClearDelay` — **measured 2026-08-17 as 5 s, not 10 s**;
  the 10 s constant is a different timer, WebKit's foreground-assertion release).
  Measured on Chromium the beat stretches
  to 2.8–4.6 s in a hidden page. Baggy, not broken. **Do not redesign the beat
  for backgrounding.** The one unmeasured risk: a slow cross-episode advance
  (`LOAD_SETTLE_TIMEOUT_MS` is 10 s) could push the silent window past WebKit's
  10 s grace.
- **Heads-up — NEVER set the Cordova preference `KeepRunning` to `false`.**
  Verified in the installed `@capacitor/android` **8.5.0** source:
  `Bridge.java:457` reads `KeepRunning` (default `true`), and when it is false
  `MockCordovaWebViewImpl.setPaused(true)` calls `webView.pauseTimers()` — which
  Android documents as process-global, "not restricted to just this WebView".
  That would stop **every out-point in the app** firing, on every backgrounding.
  The default is safe; the footgun is a one-line config change with a reassuring
  name.
- **THERE IS NO DEVICE MEASUREMENT — do not cite this as one.** Blink's timer
  behaviour and the real `HtmlAudioBackend` out-point were measured in **desktop
  Chromium** (the same engine as Android WebView, source-traced to the same
  `PageSchedulerImpl` with no WebView bypass). Everything about **iOS is
  documentation-derived and was never executed** — this is a Windows machine.
  **The Android emulator run failed:** SDK installed, APK built (32.9 MB around
  our real player modules), AVD up, APK pushed — but `pm install` never
  succeeded and **not one line of app output was ever logged**. §6.2/§6.3 of the
  write-up say so plainly and explain why no conclusion rested on it. Closing
  the gap is `HUMAN-ACTIONS.md` #11.
- **Do not re-attempt the emulator here without budgeting for it.** A cold **API
  36 (Android 16)** x86_64 boot did not complete in ~35 minutes on a 13th-gen i7
  with WHPX, three times. If #38 ever expects CI to boot an emulator, pin an
  older API level or use a snapshot. Also: **Capacitor 8 requires JDK 21** (JDK
  17 dies with `invalid source release: 21`) and generates
  `compileSdk`/`targetSdk` **36**, which puts a stock Capacitor app inside
  Android 15's audio-focus restriction from the first build.
- **Tooling installed outside the repo, reclaimable — 15.5 GB measured:**
  `%LOCALAPPDATA%\Temp\mp1-android` (11.31 GB), `~\.android\avd` (3.09 GB),
  `~\.gradle` (0.92 GB), `%LOCALAPPDATA%\Temp\mp1cap` (0.18 GB). No Android
  Studio, no admin rights, no system settings changed. The throwaway Capacitor
  spike app is **not committed**, per #35 ("the code is expected to be deleted").
  **The repo root still has no `package.json` and no `node_modules`.**
- **Related:** #34, #36, #28, #27, #29, #40.

### classification — the six shard branches land on `main` (2026-08-17, one PR, no follow-up)

- **READ THIS BEFORE YOU CONCLUDE THE CLASSIFY FLEET IS DEAD.** The six
  `foray-classify-shard0-5` cloud routines commit to **`origin/reclassify-<N>`**
  and **open no PR** — §8 of `docs/agents/runner-prompts/classify-batch.md` tells
  them to `gh pr create`; the live routine configuration does not. So `main`'s
  `data/breadth-classification.json` stays frozen while the fleet works, and
  every signal reads as death: no open classify PR, no `classify/*` branch since
  2026-08-03, the `classify-agent-tier1` count stuck at 1,851 of 19,787. **PR
  #198 drew exactly that conclusion in its body and filed it as an owner
  action.** It was wrong: all six were running, and had produced **17,427
  classifications** nobody had merged.
  **To see what the fleet has done, look at the branches, never at `main`:**
  `git fetch origin 'refs/heads/reclassify-*:refs/remotes/origin/reclassify-*'`
  then `node tools/classify/reconcile-shards.mjs --dry-run`.
- **What:** `feat/reconcile-shards`. Agent-classified shows **1,851 → 19,278** of
  19,787 (**509** still have none). New `tools/classify/reconcile-shards.mjs`
  merges the six branches' agent rows into the base layers — **by merging data,
  never by checking out a branch's file**: shards 1–5 descend from
  `origin/reclassify` (last moved 2026-07-25), so checking one out costs 1,707 of
  main's 1,851 agent rows on shards 1/3/4/5, and on **shard 2 costs 1,815 agent
  rows plus 16,799 entries dropped outright**; shard 0 alone loses none, being
  main's own lineage. Verified entry-by-entry against `origin/main`: **0 shows
  went backwards** (0 dropped, 0 without topics, 0 without a source, 0 that lost
  an agent row, 0 topic ids that vanished). 17,507 rows changed, 2,280
  byte-identical.
- **Owned files:** `data/breadth-classification.json`,
  `tools/classify/reconcile-shards.mjs` + `.test.mjs`.
- **Also touched, and worth knowing:** `tools/classify/shard.test.mjs` (#203's,
  re-based off live progress onto a constructed remainder — see below).
- **Shared files it touches:** `tools/classify/merge-results.mjs` (one line — the
  provenance spread below), `test/suite-integrity.test.js` (one new floor, in its
  own final commit), `docs/agents/runners.md`, `tools/classify/README.md`,
  `HUMAN-ACTIONS.md` (#5 update + new #10), this file. **Nothing under `player/`,
  `app.js`, `styles.css`, `backend/`, `.github/`; `data/discover.json`,
  `data/taxonomy.json` and `data/genre-taxonomy-map.json` are untouched** (PR
  #198 owns those).
- **SEQUENCING — decided: this lands FIRST, #198 rebases onto it. No `hold`.**
  #198 went `DIRTY`/`CONFLICTING` while this was being built (`main` moved six
  commits, #202/#203/#204; #198 sits 14 ahead with four files changed on both
  sides), so "land #198 first" is no longer free — someone must resolve its
  conflict either way. Three measured reasons for this order:
  (1) holding a green 0-regression merge behind unowned work re-strands 17,427
  classifications, the exact failure this fixes;
  (2) **order does not protect #198's breadth data anyway — 969 of its 1,026
  topic-changed rows get an agent row in EITHER order**, superseded by a real
  per-show judgement, which is #198's own precedence rule;
  (3) #198's durable half is untouched here and survives its own rebase: the
  `classify-breadth.mjs` rewrite fix, `root-dumping-report.mjs`,
  `data-topic-integrity.test.js`, the 7 `genre-taxonomy-map.json` mappings, and
  the 147 hand-judged `discover.json` tags.
  **Not folded in**, deliberately: 133 hand-judged curated tags plus a 3,451-line
  generated diff would make both changes unreviewable and unrevertable alone.
  **To rebase #198:** re-run its own generator (`node tools/classify-breadth.mjs`
  — its fix preserves every `classify-agent-*` row by design) and
  `root-dumping-report.mjs --baseline <snapshot>` to re-measure; then give its
  newly-created `HUMAN-ACTIONS.md` #4 the same update block #5 got here.
- **Heads-up — #198's improvement is compounded, not lost, but the METRIC flips
  sign and you need to know which one you are reading.** Root-only *pairs*:
  main 9,741 → #198 8,874 → **this branch 13,470** → both 13,445. Root-only
  *items* (a show with no child node anywhere — #198's own harsher view, and the
  one that decides whether any interest slider fires): main 6,107 → #198 5,249 →
  **this branch 5,148** → both **5,123**. Pairs rise because agent rows name more
  branches (7,546 shows gained topics), so the denominator grows — arithmetic,
  not regression. **On the per-item metric this branch beats #198 (5,148 vs
  5,249) and the two together beat either.** No correct merge of judged
  classifications can lower the pairs count below #198's; do not treat that as a
  goal or you will be tempted to bolt coarse secondary branches back on, which
  #198 itself measured as worse (9,741 → 10,502).
- **Heads-up — a row can now carry `superseded_topics`.** 6,758 rows do. When an
  adopted agent row does not carry a topic the row it replaced had, the displaced
  ids move there (with `superseded_source`) instead of being deleted. It is
  deliberately **not** a union: #198 measured that bolting the genre map's coarse
  secondaries onto a judged row makes root dumping *worse* (9,741 → 10,502).
  Anything reading `topics` should keep ignoring `superseded_topics`.
  **It is a one-generation record, not an archive:** `merge-results.mjs` rebuilds
  an entry from the agent's results file, so the next classification of that show
  deletes both fields. Recoverable from git, not from the file — do not cite it
  as durable provenance.
- **Heads-up — the tier-2 escalate queue went 301 → 2,917.** `--mode escalate`
  selects `classify-agent-tier1 && needs_review`, and this merge added 17,427
  tier-1 rows, 2,917 of which are flagged (1,275 for a display-copy miss only,
  1,642 on the classification itself). **Nothing escalates on its own** — the six
  routines run `--mode fresh` — so the queue is latent. But a deliberate tier-2
  pass is now a ~10× bigger job than the last time anyone sized it, and tier 2
  fetches transcripts, so it is a spend decision. Noted in `HUMAN-ACTIONS.md` #10.
- **Heads-up — this rebased over #203, and two of its findings interact.**
  (1) **#203 changed the shard key** (`Number(id) % N` → `fnv1a32(String(id)) % N`).
  Every one of the 17,427 rows on the branches predates that, so the lane check
  picks the key from each row's own `classified_at` against the #203 merge instant
  (`keyForRow()` / `SHARD_KEY_CUTOVER`). Full 1/6 guard strength per row —
  accepting *either* key would have been 1.83x weaker forever — and it is the only
  variant that survives the next shard run, when every branch becomes a
  legacy/hashed mixture. A per-*branch* purity rule was written and rejected for
  exactly that reason: it refuses a mixed-era branch. (2) **#203's
  `shard.test.mjs` measured balance over the shows that REMAIN, with a floor of
  5,000** — this merge takes that set to 509, so five of its tests failed.
  They now measure a *constructed* remainder (`drainLane()` — ~53% of one modulo
  lane classified, the real 2026-08-16 condition, reproducing 2.21x against #203's
  measured 2.20x), which is what its own header asked for ("a pinned count would
  be red by tomorrow lunchtime"). Draining the lane *entirely* was the first
  attempt and was worse than useless: it makes `spread()` Infinity, so the
  assertion could never fail. Its three "partition, not a filter" tests moved to a
  fixed 3,000-show world for the same reason — on the live set they go vacuous at
  509 and stop catching a shard that drops shows. Verified by mutation: reverting
  `shardOf` to modulo turns 4 of the 23 red. **And #203's stated cause was
  wrong:** the 2.20x skew did not come from the done shows being "taken in
  ascending-id order" (draining the lowest 1,851 ids leaves modulo at 1.045x) —
  it came from **1,724 of main's 1,851 agent rows sitting in modulo residue 0**,
  because main had only ever received shard 0's lineage. Its fix is still right,
  and now matters *more*: over the live 509 remainder the modulo key is **15.95x**
  unbalanced (shard 2 is furthest behind), against 1.41x hashed.
- **Heads-up — `merge-results.mjs` now SPREADS `provenance` instead of replacing
  it.** It used to assign a fresh four-key object, which deleted every other
  layer's provenance on the next batch — `base_layer` (from #198's
  `classify-breadth.mjs`) and `reconciled_shards` both live there. One line, but
  it is the difference between the reconciliation record surviving a classify
  batch and vanishing on the next one.
- **Heads-up — root-only moves in two directions, and both are honest.** Root-only
  *pairs* rise 9,741 → 13,470 because agent rows name more branches; root-only
  *items* (shows carrying no child node anywhere, the metric that maps to whether
  an interest slider fires) fall **6,107 → 5,148**. Of the 17,427 merged rows,
  **4,419 sit on a bare root** — they predate PR #175's 194-node taxonomy, which
  was purely additive (0 renamed, 0 removed), so they are **valid, just
  root-heavier**. Re-tagging them to the new children is a separate pass; do not
  fold it into anything else.
- **Two `HUMAN-ACTIONS.md` corrections this produced.** #5 ("give each routine its
  own `--shard i/6`", `[BLOCKING]`) is **refuted** — each shard's own work is a
  clean `Number(id) % 6` slice, 0 off-lane and 0 double-claimed across 17,427
  rows, so sharding already works, and acting on the item would overwrite six
  correct configs through a flag that fails open. (Careful with the weaker claim:
  the branch **files** each hold 115–127 off-lane agent rows, every one
  byte-identical to an inherited row. Count each shard's *own* work, or you will
  conclude five of six ran unsharded.) #4 ("are they alive?") is **yes** — though
  #4 does not exist on `main`; #198 creates it. The real defect is new **#10**:
  nothing lands their output. The backlog is now only **509 shows**, so #10 is a
  small problem, but a promptly-recurring one.
- **Related:** #198, #203 (`--shard` fails open), #175, ADR-0006.

### MediaSession — the lock screen and the car (2026-08-16, one PR, no follow-up)

- **What:** `feat/media-session`, issue #27 (WP7). `navigator.mediaSession` was
  completely unimplemented, so a Foray played with the screen off showed no
  title, no publisher, no artwork and no working hardware pause. Now it does.
  **The only app work not gated on MP1 (#35)** — MediaSession is a web API that
  works in mobile browsers today, a Capacitor shell inherits it, and a native
  audio backend still needs the same metadata mapping, so it cannot be wasted.
- **New files:** `player/media-session.js` (pure: no DOM, no `navigator`, no
  timers) and `player/media-session.test.js` (116 tests, floored at 110).
- **Shared files it touches:** `player/client.js` (the wiring, plus two small
  extractions — `setRunning(want)` and `stopAndClose()` — so the lock screen and
  the in-page button are literally one code path), `player/foray-sources.js`
  (`artworkUrlsByShow`, beside the `collectionIdsByShow` it mirrors), `app.js`
  (three `playForay` call sites now pass `discoverDoc`),
  `test/suite-integrity.test.js` (one floor, isolated final commit), this file,
  `docs/DECISIONS.md`. **Nothing in `data/`**, nothing in `index.html` — the
  CSP was VERIFIED, not changed.
- **Four decisions another session should not silently re-litigate** (all four
  pinned by a named test, all four argued in the module header):
  (1) `title` = source episode, `artist` = source SHOW, `album` = Foray title +
  `part N of M`. The publisher gets `artist` because that field always renders.
  (2) `previoustrack`/`nexttrack` are SEGMENT boundaries and call `forayPrevious`
  / `forayNext` — the page’s own functions, not a second implementation.
  (3) `setPositionState` reports the WHOLE Foray’s clock, matching the #196
  scrubber. A car’s `seekto` therefore lands via `foraySeek`.
  (4) **A seam beat reports `playing`, not `paused`.** 2.0 s of authored silence
  is content; a car display that blinks paused 31 times an hour is not. The cost
  is up to 2.0 s of OS position extrapolation, bounded by the beat and
  self-correcting.
- **Artwork verdict: shipped, but thin, and that is DATA not policy.** The CSP
  (`img-src https: data:`) already permits it, so nothing was widened.
  `data/segment-sources.json` carries no artwork field at all, and the
  `data/discover.json` join by show name covers **1 of the 12 shows** the two
  shipped Forays draw on; the rest fall back to `icon-512.png`. If you add an
  `artwork_url` to a source, the mapping is already there and lights up.
- **Heads-up — a pre-existing flake, not mine.**
  `player/html-audio-backend.test.js` “a faster rate does not loosen the
  boundary” fails roughly 1 run in 3 on a loaded Windows box (wall-clock
  budget; the #195 class its own header warns about). Unrelated to this PR,
  which touches neither that suite nor `html-audio-backend.js`. Worth its own
  fix by whoever owns that file.

### durable storage — resume survives an eviction (2026-08-16, one PR, no follow-up)

- **What:** `feat/durable-progress`, issue **#40 (MP6)**. Every `cp_` key —
  interests, thumbs, episode positions, Foray resume rows, and the Supabase
  anonymous token that is the only identity (ADR-0005) — moves off evictable
  `localStorage` onto a **tiered store** (`player/durable-store.js`): a
  synchronous Storage-shaped facade over memory + localStorage + IndexedDB, with
  `navigator.storage.persist()` requested and a refusal RECORDED rather than
  assumed. Plus the freshness half of #40: a stored row now names the SEGMENT it
  was in, so a network-first `data/forays.json` that changed under it degrades
  instead of seeking wrong. Full write-up: `docs/durable-storage.md`.
- **New files:** `player/durable-store.js` + test (the merge/migration/fault
  logic), `player/idb-tier.js` + test (the IndexedDB adapter, against a fake
  `IDBFactory`), `docs/durable-storage.md`.
- **Shared files it touches:** `app.js` (the `lsGet`/`lsSet` shim and one awaited
  hydrate in `init()`), `player/client.js`, `player/foray-progress.js`,
  `player/foray-resolve.js` (one new export, `progressSegments`),
  `player/position-store.js`, `player/foray-playback.test.js`,
  `player/foray-progress.test.js`, `player/foray-resolve.test.js`,
  `test/app-security.test.js`, `test/suite-integrity.test.js` (two floors, four
  raised, isolated final commit), `HUMAN-ACTIONS.md` (#9), this file. **Nothing
  in `data/`, nothing in `tools/`, nothing in `index.html`, nothing in `sw.js`.**
- **Heads-up — `app.js` CANNOT import the store, and that is structural.** It is
  a classic script; `player/` is ES modules; `index.html` is not auto-merge
  allowlisted so a third classic script tag was not available. So
  `player/client.js` constructs the ONE shared store and publishes
  `window.forayStorage` / `window.forayStorageReady` /
  `window.forayStorageHealth()`, and `app.js`'s shim falls back to raw
  `localStorage` until it appears. Do not "tidy" that into an import.
- **Heads-up — HYDRATION MUST BE AWAITED BEFORE THE FIRST WRITE, and `init()`
  now does.** Reading an evicted (empty) `cp_interests` or `cp_sb_session`,
  writing a default, and only then hearing back from IndexedDB would overwrite
  the restored profile with the default — the fix causing the defect. The store
  also protects every key written since construction (`_dirty`), so the ordering
  and the rule are belt and braces. **If you add anything to `app.js` that writes
  storage before `init()`'s first `await`, it will bypass both.**
- **Heads-up — `setItem` THROWS when no tier accepted the value.** That is
  deliberate and load-bearing: `writeProgress()`'s `return false` and
  `PositionStore`'s refusal counter depend on it, and swallowing there is the
  original defect. Callers that cannot react (the rate button) catch explicitly.
- **Heads-up — nothing is ever deleted to migrate it.** `localStorage` is a
  MIRROR, not a staging area, in both directions. There is no PR in which a `cp_`
  row exists in neither place, and no rename anywhere (CLAUDE.md § Conventions).
- **Heads-up — a resume row has two new fields.** `segment_id` and `into_sec`,
  both optional, both absent on every existing row (`isProgressRecord` does not
  require them, on purpose). `resumePoint(record, { segments })` is the new form;
  without `segments` it behaves exactly as before, plus one added field
  (`drift: "unverified"`). Build the descriptor with `progressSegments(resolved)`
  — never pair a stored index against authored position, because the queue skips
  unplayable items. And do NOT pre-filter the live order before handing it over:
  the returned `index` counts positions in the CALLER's array, so filtering shifts
  every row after a malformed entry.
- **Heads-up — reporting a storage fault is itself a write, and it self-feeds.**
  `onFault` → `logEvent` → `lsSet` → another durable write → another fault. A
  re-entrancy flag does not stop it: an async tier's failure arrives on a later
  tick with the flag already cleared, and review measured 400 events out of ONE
  user write. There is now a notification budget AND a circuit breaker that drops
  a tier after `MAX_CONSECUTIVE_TIER_FAILURES`, after which `setItem` goes back to
  throwing honestly. **If you add another storage-fault consumer, it must not
  write storage unconditionally.**
- **Left for the founder:** `HUMAN-ACTIONS.md` #10 — bump `sw.js` to `foray-v5`
  so the migration cuts over in one load instead of two. Safe without it. Also
  open, and a product call not a task: whether resume state gets a server-side
  copy, which only helps if the anon token survived and therefore really means
  "an account" (`docs/durable-storage.md` § Still open).
- **NOT built, on purpose:** #40's Problem 1 (bundled snapshot + TTL refresh in a
  native app) — it depends on #36's `prepare-webdir.mjs` and a filesystem cache,
  and none of it exists yet. The freshness work here is the web half only.
- **Related:** #40, #34, #26, #36 (blocker for the native half), ADR-0005.

### classify fleet — the shard key, and one transcript label (2026-08-16, one PR, no follow-up)

- **What:** `feat/fleet-cataloguing`. Two things from
  `docs/agents/fleet-review-2026-08.md`, scoped down by Wyatt on the day
  (*"I just want it to flag transcripts, not go overboard"*).
  (1) **The shard key is hashed and stable** — `fnv1a32(String(id)) % N`
  replaces `Number(id) % N`, which is **2.20x unbalanced** over the 17,936
  shows still needing a pass (shard0 1,514 / 8.4% against shard3 3,334 /
  18.6%) and would idle a sixth of the fleet from ~day 12. Now **1.05x**,
  measured over the real catalogue. `--shard` also **fails loud** instead of
  open. (2) **`transcript_labels`** on every batch entry and every merged
  record, read off the feed `prepare-batch.mjs` already fetched and discarded.
  Plus `--batch-size 60` in the prompt.
- **New files:** `tools/classify/labels.mjs`, `tools/classify/select.mjs`, and
  three suites (`shard`, `transcript-label`, `no-exclusion`).
- **Shared files it touches:** `tools/classify/{prepare-batch,merge-results}.mjs`,
  `tools/classify/README.md`, `docs/agents/runner-prompts/classify-batch.md`,
  `docs/agents/runners.md`, `HUMAN-ACTIONS.md` (notes on #5 and #6 — no status
  changed), `test/suite-integrity.test.js` (three floors, isolated final commit),
  this file. **Nothing in `data/`**, nothing under `player/`, nothing in
  `app.js`. Deliberately avoided `data/breadth-classification.json`,
  `data/genre-taxonomy-map.json` and `docs/CATALOG-PIPELINE.md` — PR #198 owns
  those.
- **A TRANSCRIPT IS A COST, NOT A GATE. Do not re-derive the opposite from the
  review.** `fleet-review-2026-08.md` §3 ranks transcript availability as the #1
  binding constraint; that is **wrong**, and the founder corrected it. We make
  our own — measured rate and source in `tools/classify/labels.mjs`, written down
  once on purpose — so a show with no `<podcast:transcript>` is *expensive*, not
  unusable. (Whether ours is *better* than a publisher's is still open: T2, #117.)
  The one thing that genuinely gates today is a **bounded ad delta** (ADR-0008):
  paddable below the threshold, needing a locate step above it.
- **Heads-up — nothing filters, and there is a suite whose whole job is to keep
  it that way.** Founder ruling: *"no show should be excluded at this stage, just
  catalogued. I don't want to accidentally toss out shows that are still useful,
  for example for playlists (not forays)."* `tools/classify/no-exclusion.test.mjs`
  asserts it three ways — the selector picks identically with hostile labels, the
  merge writes no key that reads as a verdict, and the directory's own source is
  scanned for `if (…transcript_present…)`. **If you add a consumer of
  `transcript_labels`, it may sort, display or budget on it — never gate on it.**
- **Heads-up — `tools/classify/*.mjs` must stay importable without
  `backend/node_modules`.** CI's `data-and-site` job never runs `npm ci` in
  `backend/`, so a top-level `require("fast-xml-parser")` makes merely importing
  `prepare-batch.mjs` a hard failure in the one environment that runs its tests.
  It is resolved lazily on first parse now, and the label uses
  `tools/segments/sweep-transcripts.mjs`'s regex parser instead. Do not "tidy"
  either back.
- **Deliberately NOT done, so nobody re-does it as a bug:** enclosure host,
  `<language>` and liveness labels; `format`/`depth`/`expertise_sourced` content
  shape in the classifier prompt; and **the selection-order rework**. On the
  last: selection runs on ascending `apple_collection_id` — show *registration
  age* — while `chart_rank` is passed into every batch and never used for
  ordering. That is a real finding and it is unchanged here; it decides what gets
  catalogued *first*, which is worth its own decision.
- **Still needs the owner:** `HUMAN-ACTIONS.md` #4 (are the six routines alive)
  and #5 (per-routine `--shard i/6`, `--batch-size 60`, four hour-phase offsets).
  Nothing in this PR delivers a single show until those are done.

### Foray #2 authoring — the types of capital available to startups (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray2-capital`. Foray #2 authored end to end: **22 segments,
  51:22**, eight arc slots, eight episodes, `capital-types-1` in
  `data/forays.json` with `status: "draft"`. Write-up:
  `docs/curation/foray2-capital.md`.
- **Owned files:** `data/segments.json` (+26, pool now 62),
  `data/segment-sources.json` (+8, now 17), `data/forays.json` (+1 Foray),
  `docs/curation/foray2-capital.md` (new),
  `tools/foray/check-forays.test.mjs`. **Out of scope:**
  `data/breadth-classification.json` and `data/genre-taxonomy-map.json` (PR
  #198 owns those), anything under `player/`, `app.js`, `styles.css`.
- **Two findings other sessions need.**
  (1) **`findAnchorOccurrences()` returns the CUE's span, not the anchor's** —
  `buildTranscriptIndex()` stamps every token with its cue's start/end. Taking
  its return value as a segment boundary ends segments mid-sentence; nine of
  this batch's sixteen ASR segments did until it was fixed against the word
  stream. **Foray #1 went through the same helper and should be re-checked.**
  `docs/curation/foray2-capital.md` §4.
  (2) **The Full Ratchet injects ads mid-roll**, confirmed from our own audio
  (identical ~26.5 s Ramp pre-roll on four 2014 episodes, and a second read at
  ~1,786 s of ep 235). Four already-transcribed episodes — 17, 18, 40, 235,
  2 h 55 m — are therefore authorable but **not playable**, and the arc lost its
  taxonomy spine and its corporate-VC slot. Do not queue a feed for ASR on a
  PADDABLE tier alone; PADDABLE means authorable. §6.1.
- **Heads-up — the Foray-#1 snapshot tests in
  `tools/foray/check-forays.test.mjs` are now generalised** (per-Foray pins
  instead of whole-file counts, and the §2 row-for-row check is table-driven over
  both curation docs). A third Foray still edits four per-Foray facts there —
  the id array, the held-back list, the mean-deviation counts and the source-id
  array — plus one row in `RUNNING_ORDER_DOCS`.
- **Landed in two PRs, and the second is the lesson.** #200 auto-merged while the
  reviewer subagent was still running, so its findings arrived after the merge and
  became #202: two false claims in the write-up (a "38-second cue gap" that does
  not exist, and a CI guarantee the test did not provide), two §2 claims quoting
  audio outside their own segment, an S2 count measured on the cue instead of the
  anchor, and a §6.1 "cross-check" that was an algebraic identity. **A reviewer
  pass that can finish after the merge is not a reviewer pass** on this repo; on
  an auto-merge path, run it in the foreground or hold the push.

### Foray UI #3 — the seam beat, and the strip becomes a scrubber (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-seams`. (1) **The seam silence.** Foray #1 has no
  narration, so all 31 of its transitions were butt-cuts — one voice stopping
  mid-room-tone and another starting on the same sample. Every unbridged
  segment-to-segment seam now gets **2.0 s** of silence
  (`docs/curation/segment-length-rules.md` §6b / §2e, the audiobook
  section-break convention). (2) **The strip is a scrubber**: a click on it is a
  position in the hour, cold or playing — `foraySeek` was implemented, tested
  and called by nothing. (3) **The live bar fills** as its segment plays, which
  is also how the beat becomes visible.
- **New files:** `player/seam-gap.js` + test (the pure "is this a seam, and how
  long" rule).
- **Shared files it touches:** `player/queue-manager.js` (the beat's clock),
  `player/client.js` (`gap` in the snapshot, `segmentAt` on the bridge),
  `app.js`, `styles.css`, `player/queue-manager.test.js`,
  `player/foray-playback.test.js`, `test/suite-integrity.test.js` (one new
  floor, two raised), `HUMAN-ACTIONS.md` (#3), `docs/ux/README.md`,
  `docs/curation/segment-length-rules.md` §10, this file. **Nothing in `data/`,
  nothing in `tools/`, nothing in `index.html`, nothing in `sw.js`** — no cache
  bump is needed, the shell is unchanged. Foray #1 stays `status: "draft"`.
- **`player/queue-state.js` IS UNCHANGED, on purpose.** The beat is a timer, and
  the reducer models no timers (same reason the 15 s position timer lives in the
  manager). No new state, no new event, no further damage to the "diffable by
  eye against the Swift" promise.
- **Heads-up — the beat has a clock, and tests must inject it.** Any suite that
  constructs `PlayerQueueManager` and drives an auto-advance will otherwise wait
  a real 2.0 s per seam. Pass `scheduler` (`{ nowMs, schedule }`) — both suites
  above have an `INSTANT_SCHEDULER` and a `manualScheduler()` to copy. Do NOT
  assert on wall clock; #195 already cost this repo that lesson.
- **Heads-up — a fake `load()` that resolves synchronously hides real bugs.**
  Reviewing this PR found one that way: cutting a beat used to resolve the
  waiting load's supersession check immediately, which against any load that
  takes real time armed an out-point the replacement `load()` then cleared,
  leaving a segment playing to the end of its whole source episode. Fixed
  (`_transport` releases a parked wait only after the action's own effects are
  done, so `_loadSeq` has moved if it was going to), and pinned by tests using
  an `AsyncLoadBackend` whose `load` resolves a few microtasks later. **If you
  add a player test about ordering, use that backend, not the synchronous
  one.** The `INSTANT_SCHEDULER`s now use `queueMicrotask` for the same reason.
- **Heads-up — `manager.inSeamGap` is a fourth play state.** `isPlaying()` is
  false during a beat (it is structurally `loadingItem`), so every play/pause
  control in `player/client.js` goes through `isRunning()` instead. A control
  that branches on `isPlaying()` will say "Pause" and start audio. There is
  also an `onSeamGapChange` hook, and it is not optional for a surface: a beat
  fires no media events, so without it nothing repaints for the whole 2 s.
- **Heads-up — the strip's DOM changed shape.** `.fy-seg` now contains
  `<i class="fy-seg-fill">`, and a click on `#fy-strip` with `clientX` is a
  seek, not a segment jump. A coordinate-less click still falls back to the
  segment. `.fy-seg.is-played` / `.is-playing` moved from `background` to
  `border-color`; the fill carries the colour now.
- **Heads-up — the two silence specs still disagree.** `04_VOICE_AUDIO_SPEC.md`
  line 12 says 0.5 s (padding around a TTS item); `segment-length-rules.md` §6b
  says ≥ 2.0 s (marking an edit). The player implements 2.0 s. Reconciling the
  documents is a founder call and is `HUMAN-ACTIONS.md` #3 — do not quietly pick
  one while doing something else.
- **Not built, on purpose:** narration bridges (no audio exists), the mockup's
  peek/expand running order, per-show colour, cover art, and anything with a new
  empty screen behind it. A library screen stays premature — one Foray exists
  and it is a draft.
- **Related:** #111, #128, #133, #65.

### Foray UI #2 — resume, feedback, credit (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-ui-2`. Three features from `docs/ux/foray-mockup.jsx`,
  built as design *intent* in the vanilla stack (no React, no deps, no fonts —
  the ruling in `docs/ux/README.md` is unchanged and this does not port that
  file). (1) **Resume across sessions**: closing the tab 20 minutes into Foray #1
  no longer costs the hour — the Foray's own clock is stored per Foray, the page
  opens on it, and the home screen gets the mockup's "Jump back in" rail.
  (2) **Per-segment thumbs** with the mockup's asymmetry: up is one tap, down
  opens the reason sheet and only commits on submit. This is the first `thumbs`
  event the client has ever emitted — the shape is
  `docs/curation/events-client-integration-spec.md` §2's, not a new one.
  (3) **"Where this came from"**: the publisher credit block per Foray.
- **New files:** `player/foray-progress.js` + test (the resume store, pure),
  `player/foray-sources.js` + test (the credit grouping and the show link, pure).
- **Shared files it touches:** `app.js`, `styles.css`, `player/client.js`,
  `player/foray-playback.test.js` (six resume tests against the real Foray),
  `test/suite-integrity.test.js` (two floors, isolated final commit),
  `docs/ux/README.md`, this file. **Nothing in `data/`, nothing in `tools/`,
  nothing in `index.html`.** Foray #1 stays `status: "draft"`.
- **Heads-up — the running order's DOM changed shape.** `.fy-row` used to BE the
  play button; a thumb inside a button is invalid HTML, so the row is now a
  container and `.fy-jump` is the button. `data-fy` and the `is-playing` /
  `is-played` classes moved with it. Anything keying on `.fy-row.is-playing`
  needs `.fy-jump.is-playing`.
- **Heads-up — a stored position is NOT an unlock.** The home rail is gated
  through the same `listableForays` rule as everything else, so a draft's
  progress is remembered and simply not advertised without `?foray=` in the URL.
  Do not "fix" that; it is the leak `player/foray-resolve.js` closed on purpose.
- **Heads-up — the Foray page now has an interactivity test, and it is load
  bearing.** `player/foray-playback.test.js` mounts `app.js` in a `node:vm`
  against a small binding harness and asserts the transport RESPONDS, not just
  that the page renders. It exists because a `ReferenceError` in one binder threw
  before `bindForayTransport` and left the whole page inert while every suite
  stayed green and `node --check` passed. If you add a binder to `renderForay`,
  add it to that harness's selector vocabulary or the test stops covering it.
- **Timing convention for `player/html-audio-backend.test.js`** — the only suite
  in the root group on a real clock. It flaked once in four runs while a
  transcription job saturated all 16 cores: two hard-coded precision budgets
  (50 ms and 100 ms out-point overshoot) are claims about the SCHEDULER, and a
  starved scheduler is late by more than that. Reproduced deliberately — the
  pre-fix file fails exactly those two under 16-core load, the fixed one passes.
  The budget is now **a fraction of the tick interval the run actually
  delivered**, which is the naive `if (currentTime >= end)` cost measured under
  the same load, so both sides stretch together. **Do not re-hardcode a
  millisecond budget here, and do not compare against the NOMINAL tick** — a
  first attempt added measured jitter to a 50 ms constant and capped it at the
  250 ms nominal interval, but a genuinely broken fine watch measures 90–133 ms,
  which fits inside the budget a loaded box produces. It would have passed a real
  regression. Any precision assertion here has to be relative to a cost measured
  in the same run.
- **Not built, on purpose:** `CreateScreen` (on-demand Forays), narrator bridges
  (no audio exists), generated cover art, and the full `ShowScreen` (no
  description or follower data exists for four of the five shows).
- **Related:** #128, #133, #111, #65.

### Foray UI — Foray #1 plays in the browser (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-ui`, issues #128 / #133 / #111. The web app gets a Foray
  surface: the 32-segment running order rendered slot by slot with show,
  length and why-line, a transport (play/pause, previous/next segment, elapsed
  across the WHOLE Foray), click-to-jump, and the played/playing state on every
  row. `app.js` now loads `data/forays.json`, `data/segments.json` and
  `data/segment-sources.json`, and survives any of them 404ing.
- **Open it at:** `https://jw-incorporated.github.io/foray/?foray=grilling-history-1`
  — Foray #1 is `status: "draft"`, so it is NOT listed for an ordinary visitor
  and nothing here publishes it (that stays HUMAN-ACTIONS.md #2). `?foray=<id>`
  is the keyless way in: it unlocks that one id for that one page load, is not
  persisted, and after the first render the route is the ordinary
  `#/foray/<id>`.
- **New files:** `player/foray-resolve.js` (the pure forays+segments+sources
  join, the draft rule and the position maths), `player/foray-resolve.test.js`,
  `player/foray-playback.test.js` (Foray #1 end to end against a fake backend
  and the REAL data files).
- **Shared files it touches:** `app.js`, `styles.css`, `player/client.js`,
  `test/suite-integrity.test.js` (two floors, isolated final commit), this file.
  **Nothing in `data/`, nothing in `tools/`, nothing in `index.html`** — the CSP,
  the script tags and the service worker are unchanged.
- **Heads-up:** `player/client.js`'s "Open episode" link was class `fp-open`,
  which `<body>` also carries while the mini-player is up — so that rule was
  colouring every uncoloured element on the page accent-blue by inheritance. It
  is `fp-openep` now. Cosmetic, but it was real and it is fixed here.
- **Not verified:** actual audio. Every podcast CDN in the source registry was
  unreachable from the machine this was built on, so playback is proven against
  a fake backend (32 segments, in order, each at its own in-point, each stopping
  at its own out-point) and by the real UI driving the real manager — not by ear.

### Foray #2 sourcing — types of capital & startup funding (2026-08-16, one docs PR, no follow-up)

- **What:** `docs/foray2-capital-sourcing`. Sourcing and a work order only —
  **nothing was transcribed and no audio was downloaded.**
  `docs/curation/foray2-capital-sourcing.md` (the shortlist, 16 arc slots) and
  `docs/curation/foray2-asr-manifest.json` (35 episodes, 18.95 h, **17.23
  CPU-hours** at 1.1x; priority 1 alone is 9 episodes / 6.37 h / **5.79
  CPU-hours**).
- **Owned files:** those two, plus this entry. **Touched nothing** in `data/`,
  `player/`, `app.js`, `tools/` or `backend/`.
- **Three findings other sourcing passes should reuse:**
  1. **The 20% relative cap bites hard on short shows, and it is easy to miss.**
     VC Minute (`rss.buzzsprout.com/1970319.rss`) looked like the find of the
     pass: 275 episodes of 60–290 s, **24 probed at ratio 1.0000** (N=2), all
     shipping timed **VTT + SRT + JSON** with speaker labels, zero ASR. But
     `segment-length-rules.md` §0 caps a segment at ≤ 20% of its source, so
     **10 of those 24 cap out below the 30 s hard floor and can yield no
     compliant segment at all**, and the other 14 top out at 30–51 s — `quote`
     tier, never the 75–180 s band. With D4's quote budget that is **≤ 7
     segments, ~5 min of an hour.** If you are sourcing sub-10-minute shows,
     compute `0.2 × duration` before you count the hours.
  2. **NCI's SBIR Innovation Lab is dead audio and it does not look dead.** 16
     agency-published SRTs that fetch 200 and read cleanly; **every enclosure
     tested 404s** — 3 of its 26 episodes, each × 3 URL shapes × 2 UAs, against a
     same-host Libsyn control returning 206. BBQ Nation again, except a
     transcript-availability screen would have admitted it. **Fetch one enclosure
     before believing a feed.**
  3. **Per-episode ad deltas, not per-show.** The Full Ratchet's Libsyn insert
     measures 12.4 s, 22.8 s, 29.3 s and **136.7 s** across 14 episodes of one
     feed — `summariseShow()`'s median would have been wrong for every row. Three
     prefix chains injected nothing on the episodes measured:
     `2.gum.fm→op3.dev→pdcn.co→pdst.fm→podtrac` (Bootstrapped Founder),
     `pscrb.fm` (Capital Allocators), `prfx.byspotify.com` (Startups For the Rest
     of Us).
- **Related:** ADR-0008 (the rule applied), `docs/curation/segment-length-rules.md`
  (the 75–180 s band and the relative cap above), `docs/curation/grilling-foray.md`
  (the 12% yield this was sized against).

### Foray data layer — the running order becomes data (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-data`, issues #182 and #134. Foray #1's 32-segment
  running order moves out of the markdown table in
  `docs/curation/grilling-foray.md` §2 and into **`data/forays.json`**
  (`kind: deep-dive`, ordered `items`, segment ids not inlined timestamps). The
  nine source episodes get **`data/segment-sources.json`** so a segment's
  timestamps resolve to audio — deliberately NOT `data/discover.json`, which is
  machine-owned and is the recommendation pool. `tools/foray/check-forays.mjs`
  makes the tier-A ordering rules (D1, D2, D3, D4, D5, M3, M4) fail CI.
- **Owned directories:** `tools/foray/`. **Owned files:** `data/forays.json`,
  `data/segment-sources.json`.
- **Shared files it touches:** `test/suite-integrity.test.js` (one new floor,
  in its own final commit so a rebase is trivial),
  `docs/curation/grilling-foray.md`, this file. **Nothing under `player/`.**
- **Heads-up for the player/UI track:** `data/forays.json` is `status: "draft"`
  and must not be surfaced until a founder flips it, same rule as ladders.
  Neither new file is fetched by `app.js` yet, and `snapshot()`'s whitelist
  drops anything it does not name — see the PR body for the short list of what
  a client still has to add.
- **Related:** #128, #133, #111, #65.

### merge mechanics — near-zero founder merges (2026-08-16, one PR, no follow-up)

- **What:** `ci/zero-founder-merges`. The path allow/deny policy moves out of
  `.github/workflows/automerge-nightly.yml` into `tools/ci/path-policy.mjs`
  (tested), `backend/test/` is allowlisted while `backend/src/` and `tools/ci/`
  are denied, `enable-automerge` is renamed `automerge-decision` and now reports
  ARMED / NOT ARMED with the reason, a new `pr-hygiene` workflow auto-updates
  behind PRs and labels + comments-once on conflicts, and `HUMAN-ACTIONS.md`
  now exists as the batched "waiting on you" list.
- **Owned files:** `.github/workflows/*`, `tools/ci/path-policy*`,
  `tools/ci/pr-triage*`, `HUMAN-ACTIONS.md`.
- **Shared files it touches:** `test/suite-integrity.test.js` (two new floors),
  `docs/roles.md` (merge-authority section), this file.
- **Heads-up:** `HUMAN-ACTIONS.md` is now auto-merge-allowlisted, so filing an
  owner action no longer costs a founder merge. The generated block in it is
  owned by `node tools/ci/pr-triage.mjs waiting --write` — do not hand-edit
  between its markers.
- **Status:** PR open, not merged. `path-policy` ships report-only; making it
  block is Wyatt's call (HUMAN-ACTIONS.md #1).

### transcription — self-hosted ASR feasibility (Wyatt's Claude, started 2026-08-11)

- **What:** the T-packages of epic #115 — can we transcribe episodes ourselves,
  and is the output good enough to anchor segments?
- **Status:** **T1 (#116) is measured and answered** — the environment installs
  clean, word timestamps are exact, and throughput is **1.33x realtime for
  `base.en`** / 0.53x for `small.en` / ~0.15x for `medium.en`, at only ~2.4
  effective threads of 16. That makes a ~20-episode pilot a weekend and the
  406-episode curated non-DAI pool ~308 hours, i.e. **not feasible on a laptop**
  — so **T7 (#118, GPU host) is a prerequisite for scale, not an optimisation.**
  T2 (#117, WER + timestamp drift) is next; **T4/T5 stay on hold until it
  reports.**
- **Branch prefix:** `spike/*`, `feat/t*` — PRs only.
- **Owned directories:** `tools/transcribe/`.
- **Shared files it touches:** `STATE.md` (this entry) — note that STATE.md is
  in neither the auto-merge ALLOWED nor DENIED list, so a PR touching it waits
  for a human.
- **Heads-up for other sessions — this one is physical, not just a merge
  conflict:** a whisper run pins this laptop for tens of minutes and **two
  concurrent runs starve each other** (measured: 0.23 effective threads each,
  neither finishing). Anything CPU-heavy running alongside a run also
  invalidates its timing numbers — this cost several hours of remeasurement.
  Check for a live `python.exe` running `bench.py` before starting long local
  jobs.
- **Related:** epic #115, ADR-0004 (transcript acquisition ladder), ADR-0007
  (segment anchoring).

### sourcing policy — the ad gate is GONE (2026-08-16, one docs PR, no follow-up)

- **Read this if you are doing any sourcing pass.** Wyatt ruled 2026-08-16 that
  *"ads should not be a blocking issue as long as we can find the approximate
  right timestamp."* **Do not reject a show on ad ratio.** New rule in
  `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`: measure the delta in
  **seconds**, over **N ≥ 2 probes of the SAME episode**, and take the max. The pad
  is `delta_max + margin` — an **upper bound, never a point estimate**. The pad
  controls only the STOP: a pad smaller than the listener's ad load stops early and
  **truncates the segment**; a generous one just adds tail. Admit if
  `pad ≤ 120 s` — which in practice means **well under 120 s of raw delta** (Gastropod's
  66 s delta already produces a 100 s pad). Above that, author the segment now (anchors are durable per
  ADR-0007) and play it once the anchor-resolution rung exists.
  `AD_FREE_THRESHOLD = 1.01` is a label, not a verdict.
- **Measured, and it is why N ≥ 2 is mandatory:** two probes of one Gastropod
  episode, hours apart from the same client, differed by **33.4 s** (+66.1 / +32.7).
  The delta is a property of the *request*, not the episode. **No episode in this repo
  has ever been probed twice**, so no recorded ratio bounds this — and the recorded
  ratios are medians across *different* episodes, which is a different axis again.
- **Second ruling, same day:** a narrator (our script, ElevenLabs audio) will
  cover what no podcast does — braai, Filipino lechon — and is sanctioned in
  principle, but *"let's wait before we deliver that feature."* **Design only.
  Build nothing, add no dependency, spend nothing.** Recorded on #107; #64/#66/#174
  are where the design lives.
- **Branch:** `docs/ad-tolerance-and-narrator` — docs only, and it **waits for a
  founder** because `docs/adr/` and `docs/DECISIONS.md` are auto-merge DENIED.
- **Owned files:** `docs/adr/0008-*`, `docs/DECISIONS.md`, plus superseded-notes
  in `docs/curation/grilling-foray-sourcing.md` and
  `docs/curation/catalogue-broadening.md`. Touched nothing in `data/`.

## Completed workstreams

### corpus/embeddings — the embedding backfill: a measured NO (2026-08-13, COMPLETE)

Branch `corpus/embeddings` (migration 0003: `embedding_models` +
`chunk_embeddings`, replacing the single `chunks.embedding` column; the
quarantined runtime; `search --mode`; a three-mode eval). Ran end to end:
1256 vectors in ~1 minute, local, keyless, $0. **The answer is no — the default
search mode stays `keyword`, and the corpus is left on its original chunking
with no vectors stored.** Keyword beat both candidates on every metric in every
configuration; hybrid is −0.122 Recall@5, −0.028 MRR, −0.104 nDCG and loses one
gold query outright. Embeddings additionally require a re-chunk that costs
keyword a further 0.074 MRR. Full numbers, per query:
`docs/research/corpus/PLAN.md`'s 2026-08-13 retro. Embeddings do genuinely
answer paraphrase queries keyword cannot, which is why the capability is
committed rather than reverted — opt-in, ~65s to reproduce.
- **Caught in review, worth knowing:** the first draft of this verdict rested
  on a metric labelled `Recall@5` that was actually hit rate, pinning the
  baseline at 1.000 and making one gate unpassable by construction. Fixed,
  tested, re-measured; the conclusion held and got stronger.
- **Owned directories:** `tools/corpus/`, `docs/research/corpus/`.
- **Dependency note:** `tools/corpus/embed/` carries `@huggingface/transformers`
  (**373MB installed**, measured). It is a separate package.json; CI's
  `npm ci` in `tools/corpus` never installs it, the whole test suite runs on a
  stub embedder, and `search --mode keyword` works with it absent.
- **A real bug fixed on the way:** the corpus test suite was writing fixtures
  into the real `data-local/corpus/` archive, and since #161's
  `removeStaleArchives` was *deleting* real archived markdown on every
  `npm test`. Archive root is now a parameter alongside the DB.
- **Shared files touched, each its own commit:** `test/suite-integrity.test.js`
  (floors, tools/corpus 175 → 279), `docs/DECISIONS.md`, `CLAUDE.md`.
- **Out of scope, untouched:** `data/*.json`, `tools/segments|transcribe|refresh`,
  `backend/`, `app.js`, `.github/`.

### corpus/refetch-weak-sources — recover the 8 weakest corpus sources (2026-08-13, COMPLETE)

PR: `corpus/refetch-weak-sources`. Recovered both dead links (source 12 AES
TD1004, source 52 LLM-as-a-Judge survey — repointed to a CC0 arXiv preprint,
redistribution verdict flips deny→allow) and 4 of 6 "thin" sources (2, 14, 33,
34, 39) via a new browser-rendered-capture ingestion route
(`corpus ingest-captured`, `tools/corpus/README.md#rendered-html-route`).
Source 37 (TTS Arena V2) stays honestly thin — cross-origin sandboxed iframe,
recorded not hidden. Also fixed a real bug: the manifest loader forked a
duplicate source on a URL edit instead of updating in place; fixed with
`corpus repoint-url`. Corpus: 52/54 → 54/54 ingested, 558 chunks. Full detail:
`docs/research/corpus/PLAN.md`'s 2026-08-13 retro.
- **Owned directories this touched:** `tools/corpus/`, `docs/research/corpus/`.
- **Shared files touched, each its own commit:** `docs/research/foray-research-dossier.md`
  (the two URL repoints), `test/suite-integrity.test.js` (isolated floor-bump
  commit), `CLAUDE.md` (corpus section refreshed to match).
- **Out of scope, untouched:** `data/*.json`, `tools/segments|transcribe|refresh`,
  `backend/`, `app.js`, `.github/`.

### corpus — research corpus ingestion (Joey's Claude, 2026-08-12, COMPLETE)

Done same day: 52/54 dossier sources ingested (480 chunks as first ingested,
~272k est. tokens; the chunker later stopped emitting bare `---` page-break
chunks, so the same 52 sources now rebuild as **451** — 29 junk chunks gone,
no source lost), searchable via `node tools/corpus/corpus.mjs search "..."`. Reports:
`docs/research/corpus/coverage.md` + `dead-links.md`. Retro in the plan doc.
Follow-up (`corpus/corpus-visibility`): the corpus itself stays machine-local,
but `docs/research/corpus/digests.md` + `corpus-index.json` carry the research
into every checkout — per-source digests we wrote, plus a redistribution
verdict for each source. Rationale: `docs/DECISIONS.md`, 2026-08-12 part 2.
PR #149 (ci.yml step to execute the corpus suites) landed 2026-08-12 —
CI/CD is Wyatt's call; he approved verbally by phone, relayed by Joey in
session (provenance recorded in the PR body and merge commit). The 156
corpus tests now run in `data-and-site` on every PR. The embedding
backfill is a future, separate pass.

- **What:** scrape + archive every source in `docs/research/foray-research-dossier.md`
  (~57 sources, 9 areas) into a migration-managed SQLite corpus with FTS5
  search, for later agent context / retrieval experiments / embedding backfill.
- **Branch prefix:** `corpus/*` — never commits to main directly, PRs only.
- **Owned directories:** `tools/corpus/` (new), `docs/research/corpus/` (new).
  DB + raw archives live in `data-local/corpus/` (already gitignored — nothing
  fetched is committed).
- **Shared files it will touch, each as its own isolated commit:**
  `test/suite-integrity.test.js` (mandatory floors for new tools/ suites),
  `docs/DECISIONS.md` (schema decision entry per workflow rule 4).
  Everything else stays inside owned directories.
- **Explicitly out of scope:** `data/*.json`, `tools/segments/`,
  `tools/transcribe/`, `tools/refresh/`, `backend/`, `app.js`, `.github/`
  (a ci.yml test step will be proposed as a separate PR left for Wyatt).
- **Plan:** `docs/research/corpus/PLAN.md`.
