# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

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
- **Heads-up — the 2.0 s seam beat is SAFE backgrounded, and this was the
  specific worry.** The beat pauses the element, which withdraws the audibility
  everything else depends on — but both engines carry a far longer grace window:
  **30 s** on Chromium (`kRecentAudioDelay`, whose source comment reads "A page
  cannot be throttled or frozen 30 seconds after playing audio") and **10 s** on
  WebKit (`audibleActivityClearDelay`). Measured on Chromium the beat stretches
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
