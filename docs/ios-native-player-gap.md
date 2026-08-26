# A native iOS playback engine: what it would have to contain, against what exists

CarPlay is happening (founder decision). Whether CarPlay *requires* native playback
rather than the HTML `<audio>` element in the Capacitor WebView is a separate
question being established elsewhere and is **deliberately not answered here** —
this document is the inventory, which is worth the same either way, because it is
also the price tag `#28` left open when it closed on 2026-08-17.

**This document does not recommend a decision, and it is not an ADR.** It prices
three options. The founder chooses.

The starting point is `docs/DECISIONS.md` (2026-08-17), which reclassified `ios/`
as reference material and said:

> the machinery the product actually runs on — `foray-resolve`, `foray-queue`,
> `seam-gap`, `seek-policy`, `html-audio-backend`, `durable-store` — has no Swift
> counterpart at all.

That is still true. What follows is the same claim with numbers attached, plus
three things that entry did not say: the state-machine mirror is a mirror of the
**July** state machine and cannot represent a Foray segment at all; the hardest
module is hard for reasons that are *measured* rather than architectural; and
there is a shipped Android precedent for getting car controls with **zero** lines
ported.

---

## 0. How every number here was obtained

The table this repo keeps before it quotes itself.

| Claim | How |
|---|---|
| Every line count in §2 | **Measured** — `wc -l` on the checked-out tree at `ee7fd18`. |
| Every test count in §2 | **Measured** — each suite executed with `node --test <file>`; the number is the runner's own `tests`/`pass` line. All 956 passed. Cross-checked against `test/suite-integrity.test.js`'s `FLOORS`, which they meet or exceed (floors are minimums, so where they differ the executed count is the one quoted). |
| Swift line counts and test counts | **Measured** — `wc -l`; Swift test counts are `grep -cE '^\s*(func test|@Test)'` per file, i.e. counted declarations, not an executed run. **No Swift was compiled for this document** (Windows). CI's `ios-kit` job does compile and run `ios/ForayKit`. |
| Which module imports which | **Measured** — every `from "./…"` in `player/*.js`, read out of the files. §1 is that graph, not a guess. |
| Divergence between `PlayerQueueState.swift` and `queue-state.js` | **Measured** — enumerated cases on both sides, plus `git log -1` per file. |
| Data-side anchoring coverage (212 segments, 64 sources, 0 `dai_suspected`) | **Measured** — read out of `data/segments.json` and `data/segment-sources.json` with `node`. |
| Every device number quoted (9,153 ms seam, 5.1–11.1 s hidden load, 1,825 ms widest `timeupdate`, 1000 ms hidden DOM-timer alignment, 4.5 ms out-point overshoot) | **Quoted, not re-measured.** Each is a CI-run artefact recorded in `docs/ios-ci.md` §4b/§4c and `player/html-audio-backend.js`'s own header, with run ids. |
| **Anything about AVPlayer, AVAudioSession, MPNowPlayingInfoCenter or CarPlay behaviour** | **NEITHER MEASURED NOR INFERRED FROM THIS REPO — assumed from Apple's documented API surface.** No Apple SDK was compiled or run. Where a Swift-side claim is load-bearing it is flagged inline. `ios/README.md`'s 9 `// AUDIT:` items are the existing register of exactly this class of unknown, and this document adds to it rather than resolving any of it. |
| Port effort in engineer-time | **NOT ESTIMATED ANYWHERE IN THIS DOCUMENT.** §2's difficulty column names a *reason*, never a size. Nothing here can be converted into a day count without the device measurements §6 says are missing. |

---

## 1. The real dependency graph

Read out of the imports, not assumed. Arrows point from importer to imported.

```
client.js ──┬─> queue-manager.js ──┬─> queue-state.js
  (1,669)   │      (1,247)         ├─> queue-strategy.js
            │                      ├─> seek-policy.js
            │                      ├─> foray-queue.js ──> seek-policy.js
            │                      ├─> seam-gap.js ──> queue-state.js
            │                      └─> playback-rate.js
            ├─> html-audio-backend.js ──> queue-state.js
            │      (1,935)
            ├─> foray-resolve.js ──> foray-queue.js
            ├─> segment-strip.js ──> foray-queue.js, foray-resolve.js
            ├─> media-session.js ──> queue-state.js
            ├─> diagnostic-log.js        (no imports)
            ├─> durable-store.js         (no imports)
            ├─> idb-tier.js              (no imports)
            ├─> foray-progress.js        (no imports)
            ├─> foray-sources.js         (no imports)
            ├─> position-store.js        (no imports)
            ├─> seek-policy.js
            ├─> playback-rate.js
            ├─> queue-strategy.js
            └─> foray-queue.js
```

Two properties of that shape decide most of §2.

**`client.js` is the only node with browser knowledge that isn't a backend or a
storage tier.** 56 references to `document`/`window`/`navigator`/`localStorage`
across its 1,669 lines. `queue-manager.js` has **one** — and it is a comment.
`queue-state.js`, `queue-strategy.js`, `seam-gap.js`, `seek-policy.js`,
`foray-queue.js`, `foray-resolve.js` and `foray-sources.js` have **zero**. That
purity is deliberate and stated in every one of their headers, and it is what
makes them cheap to port.

**The browser is concentrated in four files**: `client.js` (56),
`html-audio-backend.js` (28), `durable-store.js` (27, all injected), `idb-tier.js`
(10). Everything else is arithmetic and decision tables.

---

## 2. The table

Sizes are `wc -l`. Test counts are executed counts. "Swift status" uses the three
labels `docs/DECISIONS.md` insisted on, and adds one it did not have a name for.

| JS module | Responsible for | Lines | Tests / suite | Swift counterpart, exact status | How hard, and **why** | What its tests are worth in Swift, and what cannot carry |
|---|---|---|---|---|---|---|
| **`queue-state.js`** | The formal reducer. `reduce(state, event) -> [state, effects]`. 6 states, 11 events, 11 effects. Owns interruption/route/TTS-rate/single-player-invariant policy, plus (added 2026-08-16) segment **bounds**, **seek** and **out-points**. | 601 | **56** / `queue-state.test.js` | **Maintained mirror, tested both sides — but a mirror of the July core only.** `ForayKit/…/PlayerQueueState.swift`, 544 lines, **34** declared tests in `PlayerQueueStateTests.swift`, compiled and run by CI's `ios-kit` on a macOS runner. **Measured divergence:** the Swift has 6 states, **10** events, **8** effects. It has no `seek` event, no `seekTo`/`seekRejected`/`setOutPoint` effects, no `pendingSeek`, and `QueueItemRef` has **no `bounds` field** (`grep -c bounds` = 0). Last touched **2026-07-07** (a rename); `queue-state.js` last changed **2026-08-16** (#111/#190). So it cannot represent a Foray segment. This is documented, not an accident — `queue-state.js`'s header labels both as "Extension beyond the Swift". | **Cheapest thing on this list, and the only one with a real head start.** The port is not a port: it is bringing a live, CI-green Swift file forward by three documented extensions. Pure function, no I/O, no timers, no platform. | **Highest carry-over of anything here.** The 56 JS tests are (state, event) → (state, effects) assertions with no clock and no device; they are mechanically expressible in Swift and 34 equivalents already exist and pass. The **22-test difference** is the extension surface. Nothing in this suite is device-measured. |
| **`queue-manager.js`** | Everything the reducer refuses to own: the queue and its index, resolving "next" over bridges, interpreting every effect into a backend call, the 15 s position timer, cold-launch restore, route policy, the single-instance invariant, the **in-point**, the **seam beat's clock**, the **ADR-0007 drift gate at load** (`_segmentGate`), and the parked prefetch wiring. | 1,247 | **99** / `queue-manager.test.js` | **One-sided and uncompiled.** `App/Player/PlayerQueueManager.swift`, 820 lines, **0** tests, not compiled by CI. Last touched 2026-07-26 by PR #50, which *fixed* the two position bugs the JS port surfaced (`currentIndex`/`targetIndex` split) — so it is uncompiled, not known-wrong. It predates segments, out-points, the seam beat, the drift gate, playback rate and the transport reconcile: **427 lines of JS growth (1,247 vs 820) is roughly the un-mirrored surface.** | **Medium, and the reason is that its hard parts are logic rather than platform.** It has exactly one `document` reference and that is a comment; the scheduler is injected (`REAL_SCHEDULER`) so its clock is a test seam already. What makes it non-trivial is volume of policy — 25 numbered concerns in its header — and one specific hazard: `_segmentGate` and `persistCurrentPosition` read `this.backend.currentTime` / `.duration` **synchronously**. There are **11 synchronous read sites** across this file and `client.js`. A Capacitor plugin cannot serve a synchronous getter. See §4. | **High carry-over.** All 99 tests run against an injected fake backend and an injected scheduler; none needs a device. The parked-prefetch block (7 + 2 = **9 tests**) is about a mechanism that exists only because of WebView load throttling and would be re-derived, not translated. The other 90 — seam beat timing (25 across four sections), out-point-from-manager (9), ADR-0007 ladder at load (4), cold launch (4), route policy (2), interruption (2), corner-case #19 (2) — are behaviour a native engine must also have. |
| **`html-audio-backend.js`** | The one `PlayerBackend` implementation: two `<audio>` elements with a strict single-audible invariant, the **two-stage out-point watch**, the visibility-aware **load deadline**, the autoplay-rejection path, the no-`crossorigin` CORS posture, rate/volume, and the parked prefetch handover. | 1,935 | **112** / `html-audio-backend.test.js` | **Nothing at all for the shipping contract.** `App/Player/PlayerBackend.swift` (197 lines, 0 tests, uncompiled by CI, last touched 2026-07-07) is a **precursor to a narrower contract**: 8 members (`load(url:startOffset:)`, `seek(to:)`, `play`, `pause`, `rate`, `currentTime`, `currentDuration`, `onItemDidPlayToEnd`). The shipping contract has 12 and includes **`setOutPoint`**, `setVolume`, `release`, `onError`, a `precise` seek flag, and an end **reason** (`END_NATURAL` vs `END_OUT_POINT`). The out-point is the whole reason a Foray can exist. So: a 197-line AVPlayer wrapper for a design that predates segments. | **By far the hardest, and §3.1 is the argument.** It is browser-coupled by definition, and its 1,935 lines are ~40% comment explaining *measured* WebKit behaviour. The port is not a translation — it is **re-running the measurement programme against AVFoundation and finding out which of these compensations AVPlayer needs, which it makes unnecessary, and which it replaces with new ones.** | **Lowest carry-over of anything here, and the number is countable.** By section: prefetch/warming/handover/safety-nets/window = **38**, visibility-aware deadline = **9**, autoplay policy = **7**, CORS posture = **1** → **55 of 112 tests exist to compensate for browser media behaviour** and have no meaning against AVPlayer. What *does* carry is the **policy**, not the mechanism: "the stop is never early at any rate under any stall" (out-point arithmetic 4, driven-clock overshoot 2, scrub-past 3, mid-segment speed change 10, back-to-back same-episode segments 9 = **28 tests**) is a claim any backend must satisfy. |
| **`media-session.js`** | The lock screen / head unit / headphone pinch: what `title`/`artist`/`album` mean for a 32-segment Foray, the artwork URL gate, position state on the **Foray's** clock, playback state including the seam beat, and the action table. | 599 | **131** / `media-session.test.js` | **Nothing at all.** `PlayerQueueManager.swift` contains `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` wiring inline (AUDIT items 7 and 10), but there is no Swift module holding the *mapping decisions* this file argues for. | **Low-to-medium, and there is a shipped precedent that makes it lower.** The module is pure — 4 `navigator` references, all in comments/docstrings — and the live object arrives as an argument. **Android already solved this without porting anything**: `mobile/plugins/foray-audio/web/foray-media-session.js` (925 lines) supplies a `navigator.mediaSession` and `WebViewPlayer.java` (435 lines, a Media3 `SimpleBasePlayer`) plays the part of the browser behind it, so `player/media-session.js` "runs unmodified" (`docs/android-lock-screen.md` §1.2). The iOS analogue is MPNowPlayingInfoCenter + MPRemoteCommandCenter behind the same shim. | **The mapping tests carry as *product* assertions wherever the mapping lives**: mapping (16), against the real committed Forays (7), position/playback state (18), actions (17) = **58**. The **48** tests in "the bridge, and graceful absence" (27) and "the wiring is real" (21) are about a `navigator.mediaSession` object specifically and would be replaced. The 17 artwork-gate tests encode the page CSP's `https:`/`data:image/`/relative rule — a native app has no CSP, so that gate changes meaning rather than porting. |
| **`durable-store.js`** | The two-tier synchronous `Storage` facade under the `cp_` namespace: memory authoritative, `localStorage` as a mirror, async durable tiers write-behind. Hydration that never clobbers a session write, faults that surface instead of `catch(_){}`, dead-tier disabling, and `purge()` for #42. | 849 | **74** / `durable-store.test.js` | **Nothing at all.** | **Medium, and the difficulty is legal-adjacent rather than technical.** The code is pure by construction — no `localStorage`, `indexedDB` or `navigator` reference of its own; all 27 platform references are on injected objects. Its own header already names the seam: "it is the substrate the native shell replaces with `UserDefaults`/`SharedPreferences`, which genuinely are not evictable". So a Swift tier is a small adapter, not a rewrite. **What is not small is §3.4**: the whole *reason* this file has two tiers is browser eviction, and `UserDefaults` does not have that problem — so a native store makes the file's central argument moot while making two published documents wrong. | **Good carry-over for the merge/fault/purge logic** — hydration-does-not-clobber (3), migration-loses-nothing (6), conflicts (6), failed-write-surfaces (11), purge (15), health (5) = **46 tests** that are about a tier list, not about a browser. **Does not carry:** `persist()` (5 — `navigator.storage.persist()` has no iOS equivalent), eviction-from-the-other-side (2 — the defect that motivated the file), and the 13 wiring-helper tests. |
| **`seek-policy.js`** | The single chokepoint that decides whether a timestamp may be trusted: `OWN`/`FOREIGN` provenance, the ADR-0007 ladder (local → non-DAI → drift-within-30 s → locate step → approximate/skip), ADR-0008's pad tier, and `formatTimestamp`'s honesty rule. | 287 | **33** / `seek-policy.test.js` | **Nothing at all.** | **Cheap as code; expensive as a question — see §3.3.** Pure, zero platform references, one exported decision function. But it exists because seeking was found unreliable in ways nobody designed for, and the failure modes it encodes are **content** failures (dynamic ad insertion moving a stranger's timeline), not browser failures. Those recur identically on AVPlayer. What would *change* is the layer beneath it: `precise: true` in this repo means "assign `currentTime` and trust it"; on AVFoundation the analogous control is seek tolerance (`toleranceBefore`/`toleranceAfter`), which `PlayerBackend.swift` already sets to zero at two sites, both marked `// AUDIT:` and never compiled. | **Near-total carry-over.** ADR-0008 pad (10), the #22 provenance refinement (5), rendering/honesty (5), ADR-0007 rung 3 (4), rung-4 named-absence (2), defaults (3), local-file override (2), static enclosures (1), the property that matters (1) = **33 tests, none of which touches a browser or a clock.** This is the single best-value port on the list. |
| **`foray-queue.js`** | Foray document → typed player queue. Item identity (synthetic per-segment ids), structural refusals, ADR-0007's "a DAI source needs both anchors", ADR-0008's pad tier, and the `needs_drift_check` flag the load-time gate consumes. | 350 | **37** / `foray-queue.test.js` | **Nothing at all.** | **Cheap. Pure — zero platform references — and its only import is `seek-policy.js`.** Its header states what it deliberately cannot decide (rung 3 needs the duration of the copy in hand), which means the port has a hard boundary rather than a fuzzy one. | **Full carry-over.** Structural refusals (8), narration duration (8), ADR-0008's pad (7), happy path (5), ADR-0007's anchor rule (4), reporting (3), duration warning (1), download path (1) = **37**, all pure-data assertions. |
| **`foray-resolve.js`** | The three-document join (`forays.json` + `segments.json` + `segment-sources.json`), what to do when either side is missing (drop the one item, name the reason, keep the Foray), draft visibility, and position ↔ segment mapping across the whole Foray. | 497 | **54** / `foray-resolve.test.js` | **Nothing at all.** `ForayKit/…/SessionModels.swift` (449 lines, 7 declared tests) decodes `data/session.json` v1 — a *different* document. There is no Swift decoder for forays, segments or segment-sources. | **Cheap as logic, non-trivial as Codable.** Pure, no DOM/network/timers. The cost is that Swift needs real `Codable` types for three documents whose JS reader is deliberately forgiving ("a malformed or absent document yields an empty index rather than throwing"); reproducing *that* tolerance in Swift is the actual work, and `SessionModels.swift`'s open-enum-degrades-to-`.other` pattern is the existing precedent for how. | **Full carry-over of the join semantics** — including the "site must survive a 404 on any one data file" rule, which is exactly the assertion a strict Swift decoder would break. 54 tests, no device. |
| **`seam-gap.js`** | The seam decision table: which transitions get the authored 2.0 s beat and which get none. | 128 | **17** / `seam-gap.test.js` | **Nothing at all.** | **Trivial. One screen of decision table, zero platform references, one import.** | **Full carry-over, 17 tests.** One caveat: `SEAM_GAP_SEC = 2.0` is **authored** (from `docs/curation/segment-length-rules.md` §6b, adopted from the audiobook section-break convention), not measured — so it is a constant that survives a platform change intact. Its *delivery* does not: the measured `observedGapMs: 9153` against `askedGapMs: 2000` is the seam defect, and it lives in the backend, not here. |
| **`diagnostic-log.js`** | The bounded local field record (`cp_diag`, 200 entries): seam durations, out-point overshoot, stops, resumes, visibility transitions — parsed out of telemetry strings, never storing the text, never transmitted. | 1,049 | **50** / `diagnostic-log.test.js` (+ **23** in `diagnostic-record.test.js`, which asserts it is actually *wired* to the real player) | **Nothing at all.** | **Medium, and it would need re-deciding rather than porting.** Only 6 platform references (an injected storage object). But its entire design is a response to *these* instruments: it parses a fixed vocabulary of telemetry strings the JS player emits, including stage names (`stalled`, `waiting`, `canplay`) that are **HTML media element event names**. An AVPlayer emits a different vocabulary. The two-suite split (mechanism vs. wiring) is the pattern worth keeping. | **Partial carry-over.** The privacy rule ("the message text is never stored — only matched numbers, authored ids, stage names from a fixed vocabulary, and an error *class*") is the load-bearing part and carries as a rule. The parse table does not: its regexes match strings the browser backend produces. All 73 tests would need re-pointing, and the 23 wiring tests are the ones that would catch a silent disconnection. |
| **`foray-progress.js`** | "Jump back in" — one row per Foray (`cp_foray:<id>`), the Foray's own clock plus a segment hint, with drift verdicts and its own resume/near-end/max-age thresholds re-derived rather than copied from `PositionStore`. | 437 | **58** / `foray-progress.test.js` | **Nothing at all.** | **Cheap. Pure — the storage object is injected — and 7 platform references, all on that injection.** | **Full carry-over, 58 tests.** The three thresholds (`MIN_RESUME_SEC` 20, `NEAR_END_SEC` 45, `MAX_AGE_H` 720) are explicitly **not tuned against real listening** — its header says so — so nothing is lost by carrying them, and nothing is gained either. |
| **`position-store.js`** | Per-episode playhead (`cp_pos:<id>`), the ≤15 s loss bar of corner case #17, refused-write counting. | 106 | **0 direct.** No unit suite; the real class is only constructed end-to-end via `client.js` in `transport-reconcile.test.js` (27) and `diagnostic-record.test.js` (23). `queue-manager.test.js` uses a fake. | **Partial, one-sided and uncompiled.** `PlayerQueueManager.swift` carries a `UserDefaultsPositionStore` inline; `ios/README.md`'s M0 test-plan row 13 flags that cold-launch restore "is not implemented (there's no local persistence store beyond `UserDefaultsPositionStore`'s per-item seconds)". | **Trivial to port and the only module where Swift is arguably *ahead*** — `UserDefaults` is the non-evictable store `durable-store.js` exists to approximate. | **Nothing to carry: it has no unit tests.** That is a gap on the JS side, not a saving. A port would be writing this suite for the first time. |
| **`playback-rate.js`** | The speed ladder (`0.75, 1, 1.25, 1.5, 1.75, 2`), labels, cycling, and the stored value (`cp_rate`). | 243 | **22** / `playback-rate.test.js` | **Nothing at all.** The TTS-always-1.0x rule lives in `PlayerQueueState.swift` (`resetRateForTTS`/`restoreRate`), so the *policy* is mirrored; the ladder is not. | **Trivial as code.** The stops are researched, not invented (Apple/Spotify/YouTube/Pocket Casts/Overcast/Audible, checked 2026-08-17) and are platform-independent. | **Full carry-over, 22 tests.** But note the one **coupled** decision: `MAX_RATE = 2` and not 3 is a *Foray-specific* answer justified by the measured 5.1–11.1 s hidden seam load — "a Foray pays a cost per seam that a single episode does not". A native backend that removed the seam cost would remove the argument for the ceiling. So this is a cheap port whose *value* is contingent on §3.1. |
| **`queue-strategy.js`** | What the queue *is* — `SINGLE_ITEM` (default, per product principle 1: no autoplay chains), `PICKED_FIRST`, `CONTINUE_TAIL`. | 60 | **4**, inside `queue-manager.test.js` ("the blocking decision, made pluggable") | **Nothing at all.** | **Trivial. Three closures.** | **Full carry-over, 4 tests.** |
| **`foray-sources.js`** | The publisher-credit block: which shows and episodes a Foray draws on, in the order met, with runtime share, and where "go and subscribe" honestly points. | 175 | **24** / `foray-sources.test.js` | **Nothing at all.** | **Cheap. Pure, zero platform references.** Not strictly playback, but it is in the `client.js` import graph and it is the other half of product principle 3 — a native player that dropped it would be shipping the credit surface's absence. | **Full carry-over, 24 tests.** |
| **`segment-strip.js`** | The Foray at a glance: capsule geometry, seams as gaps rather than hue, narration as a first-class capsule, past/current/upcoming, the fill fraction. `stripModel` is pure; `renderStrip`/`mountStrip` touch the DOM. | 433 | **29** / `segment-strip.test.js` | **Nothing at all.** | **Split. The arithmetic is cheap; the rendering is a rewrite.** 6 platform references, all in the render half. `stripModel` is where the tested arithmetic lives. In SwiftUI the render half is not a port at all — it is a new view. It is also the module a **CarPlay** template would most need an equivalent of, and CarPlay's driver-distraction constraints (corner case #14) are a different design brief, not a translation. | **The `stripModel` tests carry** (widths, capsule boundaries, fill fraction, the summary sentence). The CSP constraint the file lives under — "NO INLINE STYLES, `test/app-security.test.js` fails the build on a `style=` attribute" — is meaningless natively. |
| **`client.js`** | The only file that connects the player to the page: its own DOM (mini-player + Now Playing sheet), the Foray clock, the durable-store singleton, the diagnostic sink, `stopForDataDeletion()`, and the transport reconcile of #263. | 1,669 | **0 own suite.** Covered by `transport-reconcile.test.js` (**27**) and `diagnostic-record.test.js` (**23**), both of which boot the real file over a ~90-line DOM stub, plus 2 source-text regex tests in `foray-playback.test.js`. | **Nothing at all.** `App/Views/NowPlayingView.swift` (206 lines) is explicitly "a skeleton per the task brief… It does not run any audio yet"; `TodayView.swift` (167) is a card picker. | **Highest total rewrite cost, lowest *logic* cost.** It is 56 browser references and a DOM tree; almost none of it translates. What must survive is the **wiring order**, which is where the field defects were: `hydrate()` before the first write, the reconcile against the element rather than the surface belief, forced progress writes at pause and page-hide (because "the next tick may never come"), and a stop that persists nothing during data deletion. | **The 50 tests here are the highest-value ones to reproduce and the hardest, because they are wiring tests.** Their own headers say what they cannot do: *"NOT reproduced, and not claimed: an iOS page being suspended, an audio route physically disappearing, a car… You cannot simulate a car."* A native engine gets the same sentence with `page` replaced by `process`. |
| **`idb-tier.js`** | The IndexedDB adapter for `DurableStore`: one DB, one store, one record per `cp_` key, callback-to-promise plumbing. | 148 | **23** / `idb-tier.test.js` | **Nothing at all.** | **Not a port — a deletion.** Its two hazards (transaction handlers must be assigned before the request is issued; a failed open must not be cached as a success) are IndexedDB semantics with no `UserDefaults` analogue. | **Nothing carries.** Its own header already says the 23 tests "prove the CALL SEQUENCE, the prefix filtering, the promise plumbing and every error path" and cannot prove browser semantics — quota, eviction, durability on iOS are marked `// AUDIT:` unverified. A native tier would need a new suite of a different shape. |
| — | *cross-cutting* `foray-playback.test.js`: Foray #1 end-to-end against the **real committed data** on disk, not fixtures. | — | **87** | n/a | n/a | **Carries as a *pattern*, not as tests.** This is the suite that answers "does the grilling Foray play, all of it, in order". A native engine needs its own, and it needs the real documents on disk, which means a Swift-side reader for `data/*.json` (see `foray-resolve.js`). Its stated assumption — that **no committed Foray authors a narration bridge** — is a live tripwire: one 40 s bridge in Foray #1 "turns 22 tests across five player suites red". |

### Totals

| | Count |
|---|---|
| Modules in the shipping playback path | **18** source files, **10,813** lines |
| Test lines | **17,029** across **18** suites |
| **Tests that would need re-establishing** | **956** (all executed, all green at `ee7fd18`) |
| Modules with **no Swift counterpart at all** | **14** of 18 (`client`, `media-session`, `durable-store`, `idb-tier`, `seek-policy`, `foray-queue`, `foray-resolve`, `foray-sources`, `seam-gap`, `diagnostic-log`, `foray-progress`, `playback-rate`, `queue-strategy`, `segment-strip`) — **6,924** lines, **552** tests in their own suites (`queue-strategy`'s 4 live inside `queue-manager.test.js`, and `client`'s 50 inside the two cross-cutting suites) |
| Modules **one-sided and uncompiled** | **3** (`queue-manager` ↔ 820 Swift lines; `html-audio-backend` ↔ its precursor `PlayerBackend.swift`, 197 lines on a narrower 8-member contract; `position-store` ↔ inline `UserDefaultsPositionStore`) — **3,288** lines, **211** tests |
| Modules that are a **maintained mirror tested both sides** | **1** (`queue-state` ↔ `PlayerQueueState.swift`, 34 Swift tests, CI-green) — and it is a mirror of the 2026-07-07 core, missing bounds, seek and out-points |
| Swift that exists and is CI-tested | `ios/ForayKit`: 1,376 source lines, **59** declared tests. Of those, **34** (`PlayerQueueStateTests`) are player-relevant; `IntentGrammar` (383 lines, 18 tests) has no JS counterpart at all and is orthogonal to playback |
| Swift that exists and is **not** compiled by CI | `ios/App/`: **1,492** lines across **6** files (of which `App/Player/` is **1,017**), **0** tests, **9 open `// AUDIT:` items** |

### How much of the 956 is device-measured rather than logical

**None of the 956 tests requires a device, and none asserts a device number.** That
is the point of the architecture, and two suites say so explicitly —
`diagnostic-record.test.js`: *"NO WALL-CLOCK BUDGET ASSERTIONS… a budget here would
be a flake with a story"*; `transport-reconcile.test.js`: *"You cannot simulate a
car."*

What is device-measured is not the tests but the **constants they pin**, and there
are **four**, all in `html-audio-backend.js`:

| Constant | Value | Derived from |
|---|---|---|
| `OUT_POINT_ARM_LEAD_SEC` | 2.0 s | The widest `timeupdate` interval this repo has recorded, **1,825 ms** against a 250 ms nominal. Raised from 0.5 s when the speed control shipped, because the coarse stage's window is wall clock and therefore `rate`× the content. |
| `LOAD_SETTLE_TIMEOUT_MS` | 10,000 ms | A visible load measured at **590 ms** (run 32057395270) — ~17× headroom. |
| `LOAD_SETTLE_TIMEOUT_HIDDEN_MS` | 20,000 ms | Three backgrounded-Simulator samples (5,114 / 9,153 / 11,140 ms), worst *clean* 9,153 × the 1.8 spread + a cold cross-origin CDN ≈ 18 s, rounded. Its own comment records that **no value both clears that floor and fits the ~13 s measured post-boundary window** — the incompatibility is the finding. |
| `PREFETCH_LEAD_SEC` | 12 s | Sized against the 10 s deadline + 2 s trigger slop; **re-derived at 22 s and found unusable**, because 22 s × 2× rate exceeds the 30 s segment floor by 47%. The feature is parked default-off. |

**Tests that exist because of those four numbers: 47** (38 prefetch/warming/handover
+ 9 visibility-aware deadline), plus 7 autoplay-policy and 1 CORS tests that are
browser-mechanism rather than measured — **55 of 956, all in one file.** Every one of
those measurements was taken on a **WKWebView `<audio>` element in an iOS Simulator**
and none of them transfers to AVPlayer. Re-establishing them is a CI-runner
programme, not a coding task: `tools/mobile/probe/` (3 probes + their installer, **1,494** lines, plus a **694**-line
suite) and `tools/mobile/ios-ci.mjs` (**1,547** lines, **116** tests in
`ios-ci.test.mjs`) is what it took to obtain them the first time, and `docs/ios-ci.md` §4d records that **a cross-origin fetch can never be
measured there at all** — permanently.

---

## 3. The rows that decide the estimate

### 3.1 `html-audio-backend.js` — what it is compensating for

Its header names the compensations. Grouped by whether the *problem* is a browser
problem or a physics problem, because that is the split that decides whether a port
inherits it:

**Browser-specific (would not exist in an AVPlayer backend):**

- **`timeupdate` is not a boundary.** It fires ~4 Hz "at the UA's discretion", so a
  bare `if (currentTime >= end)` overshoots by up to a quarter second of wall clock
  — *half a second of content at 2×, a whole sentence of the next thing*. Hence the
  two-stage coarse/fine watch, the 2.0 s arm lead, the prediction that never stops on
  itself, and the stall stand-down that prevents a spin at the timer floor. **AVPlayer
  has a purpose-built replacement for the entire mechanism** (boundary-time observers,
  and `AVPlayerItem.forwardPlaybackEndTime`) — *assumed from Apple's documented API,
  unverified here.* If that assumption holds, ~28 of the out-point tests become
  assertions about a framework rather than about our own watch.
- **Autoplay rejection is normal, not exceptional** — `play()` returns a rejecting
  promise without a user gesture (7 tests). No iOS analogue.
- **No `crossorigin` attribute**, because podcast CDNs send no
  `Access-Control-Allow-Origin` (measured, #20 §3) and setting the attribute turns a
  working no-cors load into a hard failure. The cost is that Web Audio cannot touch
  the element, so ducking uses `.volume` rather than a gain node. **AVPlayer is not a
  browser origin and ignores CORS entirely** — which is `#28`'s second independent
  argument for going native, and the precondition for offline downloads (#29/WP9).
- **`currentTime` before metadata is lost** — assigning while `readyState` is 0 either
  throws or is silently discarded depending on the browser.
- **Two elements, one audible.** The web restatement of corner case #19's
  two-AVPlayers bug. `AVPlayerBackend.swift` already takes the opposite approach —
  one long-lived `AVPlayer`, `replaceCurrentItem(with:)` — flagged `// AUDIT:` for
  "no pops on swap", never compiled.
- **The visibility-throttled load.** The finding that cost the most: *media-element
  load tasks appear to be throttled by **visibility**; DOM timers by **audibility**.
  Different rules.* Generalising the second to the first is what produced the prefetch
  handover, which shipped, was measured making the seam **worse** (`observedGapMs:
  null`), and is now parked default-off. 38 tests guard a mechanism that is off.

**Not browser-specific (any engine on this content inherits it):**

- **A cross-episode seam is a cold cross-origin range request into the middle of
  somebody else's podcast.** Measured against six real sources in
  `data/segment-sources.json`: **0.99 s median / 1.41 s worst TTFB**, desktop, home
  network — explicitly a lower bound. Foray #1 crosses to a different episode at
  **16 of its 31 seams**. A native HTTP stack removes the queued-task chain; it does
  not remove the network.
- **A stalled fetch is silent.** `canplay`/`seeked`/`error` do not cover a network
  that simply stops — it fires `stalled`, `suspend`, then nothing forever. Every load
  path needs a deadline or the state machine sits in `loadingItem` with no path out.
  AVPlayer needs the same guard for the same reason, and the number will be different.

**So the honest shape of the answer:** the 9,153 ms seam is a WebView defect and the
strongest single technical argument for a native backend. But its *replacement* is not
zero — it is an unmeasured AVPlayer number, and this repo's own history says the
plausible-sounding inference about a platform is the thing that has been wrong twice
(the prefetch premise; the `fired-on-resume` reading that started a native out-point
owner and had it thrown away). **A native backend's seam cost is currently unknown,
not known-better.**

### 3.2 Segment anchoring and seams — how much lives in code, and how much in data

This is the reassuring row, and it is measured.

**ADR-0007's dual anchoring is overwhelmingly a data property.** Of 212 segments in
`data/segments.json`: **212 carry `start_anchor` and `end_anchor`, and 212 carry
`reference_duration_sec`.** 100%. The anchor is "free at authoring time" by the ADR's
own argument — a substring of the transcript the extractor already had in context.
**A port inherits all of that for nothing**, because it is JSON.

The code side is small and concentrated:

| Rung | Where it lives | Lines | Tests |
|---|---|---|---|
| Local file → exact | `seek-policy.js` | in 287 | 2 |
| Not DAI → exact | `seek-policy.js` | in 287 | 1 |
| DAI + drift ≤ 30 s → exact | `seek-policy.js` + `queue-manager._segmentGate` (22 lines) | in 287 + 22 | 4 + 4 |
| Anchor resolution (the **locate step**) | **Not implemented, and not faked.** `locateStep()` exists so the gap is "a named, callable, tested absence rather than a silence" | — | 2 |
| Unresolvable → approximate → **skip, never play at the wrong place** | `seek-policy.js` | in 287 | 3 |
| ADR-0008's pad (`delta_max + margin ≤ 120 s`, stop only, upper bound) | `seek-policy.js` + `foray-queue.js` | in 287 + 350 | 10 + 7 |
| ADR-0007's "a DAI source needs both anchors" | `foray-queue.js` | in 350 | 4 |

**And today the runtime gate is inert for shipped content.** `dai_suspected` is
**false for all 64 rows** of `data/segment-sources.json` and for all 212 segments, so
`needs_drift_check` is false everywhere and `_segmentGate` returns `{ok: true}` on the
first line for every segment that currently ships. **8 of 64 sources carry an
`ad_pad_sec`**, and `allowAdPad` defaults to **false** pending ADR-0008's unanswered
open question 2 — so the pad path is also inert. That is not a reason to skip porting
it (the pool is 69% DAI as of ADR-0007's measurement, and shrinking is the direction
of travel), but it does mean **a native port could ship a Foray without the drift gate
working and no current content would reveal it.** That is a specific, dated blind spot
worth naming out loud.

**The seam is the opposite case: the rule is 128 lines, the difficulty is entirely in
delivery.** `SEAM_GAP_SEC = 2.0` is authored — the audiobook section-break
convention, not a measurement — and `seam-gap.js`'s 17 tests are a pure decision
table. The 2.0 s beat arms in **2 ms** and the whole 9,153 ms is the media load.
So: the seam *policy* is one of the cheapest things on this list, and the seam
*defect* is not in any of these modules.

### 3.3 `seek-policy.js` — would those failures recur on AVPlayer?

`seek-policy.js` exists because of **dynamic ad insertion**, not because of browsers.
Corner case #2, ADR-0007 and ADR-0008 all locate the problem in the *content*: a DAI
host stitches ads per request, the same GUID serves different bytes and a duration
that moves 1–4 minutes, and a timestamp authored against one copy misaligns against
another. The measured worst case is a segment landing **~11 minutes** from its
intended position, "several segment-lengths".

**None of that changes on AVPlayer.** The provenance distinction (`OWN` vs `FOREIGN`),
the 30 s drift tolerance, the 120 s pad ceiling, the honesty rule (`~roughly minute
70`, never a hard-seek claim), and the "skip rather than cut badly" degradation are all
platform-free. All 33 tests carry.

**What is replaced is the layer under it.** In this repo `precise` means "assign
`currentTime`". On AVFoundation the analogous control is `seek(to:toleranceBefore:
toleranceAfter:)`, and `PlayerBackend.swift` already passes `.zero` at two sites —
both marked `// AUDIT:` ("zero tolerance forces frame-accurate seeking (slower)…
verify exact signature") and never compiled. So the *policy* recurs unchanged and the
*failure modes of the seek itself* are new and unmeasured: a zero-tolerance seek into
the middle of a remote stitched MP3 has a cost profile nothing in this repo has
observed. Note the interaction with §3.2: this is exactly the same seek that must land
inside 30 s of a reference duration for the gate to pass, and no shipped segment
currently exercises it.

### 3.4 `durable-store.js` — the `cp_` discipline, and what the legal documents can claim

The iOS equivalent is named in the file's own header: `UserDefaults`, dropping into
the existing tier list — the file is pure by construction precisely so it can. That
part is a small adapter.

**What is not small is that a native store makes two published documents wrong.**

`docs/legal/privacy-policy.md` §1 states, as a fact about the product:

> 4a keeps its state under keys beginning `cp_`. **Nearly every key is written to two
> places on your device**: `localStorage` and an IndexedDB database (name `foray`,
> object store `kv`).

and then adds two honest qualifications: `cp_storage_health` is deliberately never
written to IndexedDB, and until the player module loads, writes go to plain
`localStorage` only. §1's table has **21 `cp_` rows** with a "does it leave your
device?" column. `docs/legal/data-safety.md` Part C's forecast row reads: *"Local
storage tiers | localStorage + IndexedDB | **Same**, inside the WebView | None."*

A native engine changes the *mechanism* those sentences describe (and, for a
CarPlay-era build, possibly which of them the app even has). **It does not change
what is collected or what is transmitted** — nothing here becomes a new collection
surface, and `data-safety.md`'s own "What would change these answers" table lists the
things that *do* flip a declaration (an analytics SDK, a crash reporter, backend sync,
per-user APIs, on-device AI calls). A storage-tier swap is on none of those rows.

So the accurate statement is narrow and worth getting exactly right: **the port would
require rewriting privacy-policy §1's mechanism paragraph and data-safety Part C's
storage row, in the same PR, per that file's own rule — and it would not require
re-answering a single Apple or Play declaration question.** The `cp_` key *names* must
survive regardless: "renaming a key wipes user state" is a `CLAUDE.md` convention the
policy is written against, and a Swift store keyed differently would orphan every
existing listener's profile silently.

One thing genuinely improves: `navigator.storage.persist()` is "a REQUEST a browser
may refuse" and the Safari ~7-day sweep "has no JavaScript fix at all". `UserDefaults`
is not evictable. The 5 `persist()` tests become meaningless in the good direction —
and `player/durable-store.js`'s central argument for having two tiers becomes moot,
which means a native store is not a port of this file so much as a **replacement for
its reason to exist**.

### 3.5 The three hardest modules

1. **`html-audio-backend.js`** — 1,935 lines, 112 tests, and **55 of them
   compensate for browser media behaviour that has no AVPlayer analogue**. The Swift
   precursor implements 8 of the 12 contract members and is missing `setOutPoint`,
   which is the member the whole segment product rests on. The port is not a
   translation; it is re-running a measurement programme (`tools/mobile/probe/`,
   1,494 lines of probe + 694 of suite; `ios-ci.mjs`, 1,547 lines, 116 tests) against a different engine, in
   a lab that `docs/ios-ci.md` §4d says can never measure the cross-origin case at
   all.
2. **`client.js`** — 1,669 lines, no unit suite, 50 tests that all boot the *real*
   file over a DOM stub, and 56 platform references. Almost none of it translates and
   all of the field defects lived here (#263's spent press, #224's wrong resume). Its
   tests' own headers say what they cannot reproduce: a suspended page, a vanishing
   route, a car. A native engine gets the same limitation with different nouns.
3. **`queue-manager.js`** — 1,247 lines, 99 tests, and the module where the
   architecture actually bites. The Swift is 820 lines, uncompiled, and predates
   segments, out-points, the seam beat, the drift gate, the rate control and the
   transport reconcile. Worse for the "keep JS, plug in native" option: it reads
   `backend.currentTime` / `.duration` **synchronously** at 11 sites across itself and
   `client.js`, and a Capacitor plugin cannot serve a synchronous getter.

---

## 4. What a partial port would look like

There are three coherent stopping points. Only the first two are "partial".

### Tier 0 — the shim: native controls, WebView audio. **Zero lines of `player/` ported.**

Supply the missing native surface and let native play the part of the browser. This
is not hypothetical: **it shipped on Android on 2026-08-18.**
`docs/android-lock-screen.md` §1: *"`navigator.mediaSession` is polyfilled… and the
native side plays the part of the browser behind it. **Nothing under `player/` is
modified.** It does not know this file exists."* The page writes metadata, position
and playback state; `WebViewPlayer.java` (435 lines, a Media3 `SimpleBasePlayer`)
extrapolates position from the last report and the rate, so the page can write once a
second instead of four times; transport presses come back as calls to the handlers
the page registered. Cost, measured: **3,743 lines** of plugin (1,913 Java + 1,830 web) and **156**
tests in its two suites (`foray-audio-shell.test.mjs` 89, `foray-media-session.test.mjs`
67), and `player/media-session.js` ran unmodified.

The iOS analogue is the same shape: an `MPNowPlayingInfoCenter` +
`MPRemoteCommandCenter` back end for a `navigator.mediaSession` shim, plus CarPlay's
`CPTemplateApplicationSceneDelegate` / `CPNowPlayingTemplate` /`CPListTemplate` reading
the same state. iOS already has the two things Android lacked:
`UIBackgroundModes: audio` **lands in the generated plist (measured**, PlistBuddy,
run 32021861601), and iOS injects the Capacitor bridge via `WKUserScript` so the CSP
question that threatens Android does not arise.

**What it sacrifices:** every measured WebView playback defect, unchanged.
- The seam stays **5.1–11.1 s** hidden, against an authored 2.0 s.
- **Dropped segments at seams are structural, not bad luck** — a hidden load measured
  **11.14 s on a small local bundled file** against a 10,000 ms deadline; on Chromium
  3 of 5 hidden loads already fail that way. The 20 s hidden deadline converts drops
  into slow seams *inside the window we have observed* and no further.
- The open question in `docs/ios-ci.md` §4c is unresolved and it is the one that
  matters: whether a hidden page can be **descheduled mid-Foray after sustained
  silence**. Reading (a) of run 32036295743 — the record simply stops at +25.2 s of a
  90 s hidden window — *"would mean a hidden page can be descheduled mid-Foray, which
  is the failure that makes the whole WebView-shell approach unsafe."* **Under
  reading (a), Tier 0 is not viable at all**, and no amount of native control surface
  fixes it.
- No offline downloads (#29/WP9): browser `fetch()` cannot read CORS-less CDN bytes.
- CarPlay-specific: whether a WebView-backed audio app is acceptable to CarPlay
  (technically and to review) is **the question this document deliberately does not
  answer**.

### Tier 1 — native backend only: port `html-audio-backend.js`, keep everything else in JS

This is `#28`'s own recommendation: *"JS keeps the queue, plugin is a dumb backend —
it preserves the single testable state machine, which is the whole architectural
bet."*

**What gets ported:** one module, 1,935 lines, behind the existing 12-member
contract. `queue-manager.js` "never learns which one it is driving" — the contract is
already injected, never imported, which is why 99 tests run under `node --test`
against a fake.

**What stays single-sourced:** 17 of 18 modules, **844 of 956 tests**, including all
of `seek-policy` (33), `foray-queue` (37), `foray-resolve` (54), `seam-gap` (17),
`queue-state` (56), `queue-manager` (99), `durable-store` (74), `media-session` (131).
The ADR-0007/0008 ladder, the anchoring rules, the seam decision table and the reducer
are never duplicated. **This is the option in which nothing in §5 happens.**

**What it costs, specifically:**
- **The synchronous getters.** `currentTime` and `duration` are read synchronously at
  11 sites. Every Capacitor bridge call is async. Android's shim solved the *inverse*
  direction (native reading the page) with a pushed mirror plus extrapolation; this
  direction needs the same trick — the page caching a pushed position — and that is a
  real change to `queue-manager.js` and `client.js`, not just to the backend. It also
  reintroduces staleness into `_segmentGate`, which compares `backend.duration`
  against a reference duration to decide whether a segment may play at all.
- **The out-point crosses the bridge.** `setOutPoint` becomes a native boundary
  observer, and the end must come back as the *same* `onItemEnded` a natural end
  produces — that indistinguishability is load-bearing (`_handleBackendItemEnded`
  "cannot tell the difference, and that is the design"). Getting the reason
  (`END_NATURAL` / `END_OUT_POINT`) right across an async boundary is where a subtle
  version of the 936.5-second-median disaster would live.
- **The 4 device constants and 55 tests in §2 are lost and must be re-earned** on a
  new instrument.
- Two `PlayerBackend` implementations exist (web for the site, native for the app), so
  the contract must be tested twice — which the repo already does for `queue-state`
  and calls a maintained mirror.

**What it does *not* fix:** the surrounding page can still be suspended. If
`docs/ios-ci.md` §4c reading (a) is true, native *audio* keeps playing while the JS
that owns the queue stops being scheduled — which relocates the failure from "silence
at the seam" to "the Foray stops advancing", and that is arguably worse. **Tier 1's
viability depends on the same unresolved measurement as Tier 0.**

### Tier 2 — the native engine: the plugin owns the queue, JS is a remote control

`#28` names this and argues against it, with one caveat: *"there is a real
counter-argument for Android background reliability (a foreground service that dies
when the WebView sleeps is a known failure mode)."* The iOS restatement of that
counter-argument is exactly reading (a) above.

This is the option §5 is about. It duplicates the reducer, the queue manager, the
seam rule, the seek ladder, the anchoring gates, the resolve join and the media
mapping: **at minimum 4,449 lines and 511 tests — 477 net of the 34 that already exist in Swift** (`queue-state` 601/56,
`queue-manager` 1,247/99, `seam-gap` 128/17, `seek-policy` 287/33, `foray-queue`
350/37, `foray-resolve` 497/54, `media-session` 599/131, `playback-rate` 243/22,
`queue-strategy` 60/4, `foray-progress` 437/58). That excludes `client`,
`html-audio-backend`, `durable-store`, `idb-tier`, `position-store`,
`foray-sources`, `segment-strip` and `diagnostic-log` — some of which a native
engine would also need, so 4,449 is a floor and not an estimate.

**Is there a subset that gets CarPlay working without porting everything?** On the
evidence in this repo: **Tier 0 ports nothing and has a shipped precedent on the other
platform; Tier 1 ports one module and keeps every rule single-sourced.** Which of the
three CarPlay actually permits is the question being established in parallel. What
this document can say is that **nothing in the CarPlay surface itself
(`CPListTemplate`, `CPNowPlayingTemplate`, the driver-distraction constraints of corner
case #14) requires porting a single line of the queue, the anchoring or the seam
logic.** The templates need metadata and transport commands. Both are already
computed, purely and testably, in `media-session.js` — the module Android proved can
drive a native session unmodified.

---

## 5. What would become duplicated, and what that costs

Say it plainly, because leaving it implicit is how it happens.

**This repo has paid, repeatedly and expensively, for a policy that was copied instead
of imported.** The pattern is documented in the tree at least eight times over,
sometimes at book length:

- **The app id / bundle id / Java package.** One string, three founder rulings in two
  days (`com.jwincorporated.foray` → `dev.jwlabs.foura` → `ai.jwlabs.foura`),
  **thirteen files** carrying it plus **five more** carrying a *stale* copy, and a
  `DECISIONS.md` entry warning that a blind find-and-replace would be wrong. The
  near-miss "reproduced itself exactly, and was caught."
- **`ios/project.yml`'s `com.wjduvall.foray`**, a fourth copy of the same string, in
  the reference tree, predating the org, never published.
- **`data/item-tags.json`.** Trimming the bundled copy moved **66 query terms** across
  an expansion threshold and **176** across a score multiplier: *"the app would rank
  differently from the website with every guard green."* After normalisation the
  sampling half still survives at **12 terms and 62 multipliers**. So it is copied
  whole and asserted byte-identical.
- **The bundled `webDir` data list.** #36 wrote the runtime files down by hand and
  said to verify them; *"a list that must be manually verified is a list that will
  drift"*, so `prepare-webdir.mjs` derives it from `app.js`'s own `fetchJson` calls
  and puts a floor on the derivation.
- **`test/suite-integrity.test.js`.** Floors and the execution plan are pinned to each
  other *in both directions* because a suite that is floored but never executed
  "reads as coverage and protects nothing" — two lists that could disagree, welded so
  they "cannot drift".
- **`OUT_POINT_ARM_LEAD_SEC` vs `PREFETCH_LEAD_SEC`.** Two constants sized off the same
  measured 1,825 ms. The prefetch one went stale when the hidden deadline moved and is
  *"inert only because prefetch is default-off"* — its own comment says so.
- **`docs/DECISIONS.md`'s own cross-references.** A correction dated 2026-08-25 fixes
  an entry that pointed at "the 2026-08-18 entry below" when there is no such heading
  and the file ascends. A copy of a pointer, drifted.
- **`session_fixture.json` / `sample_session.json`.** Two copies of `data/session.json`
  in `ios/`, whose drift was already an action item (`architecture-assessment.md` A9:
  *"run it once to fix current drift"*).
- **`fitLine()`.** Regenerated banned copy and *"slips the copy gate twice over"*,
  because the regexes were a second, hand-maintained statement of the rule.
- And the one closest to home: **`PlayerQueueState.swift` itself.** It is the
  best-behaved duplicate in the repo — CI-compiled, tested on both sides, deliberately
  diffable by eye — and it is **still 40 days stale**, missing bounds, seek and
  out-points, which is to say **it can no longer represent the product's core unit.**
  Nobody neglected it. It drifted because that is what a second copy does.

**A second playback engine in a second language is that risk at its largest, and it is
worse than any item above in three specific ways.**

1. **The duplicated things are *arguments*, not values.** A bundle id is one string and
   a byte comparison catches it. `media-session.js`'s header argues, for 200 lines, why
   `artist` is the source show and not our name, why `album` carries "part 12 of 32",
   why the display must change at every seam. `docs/android-lock-screen.md` §1.1 already
   rejected deciding that natively for exactly this reason: *"The lock screen would then
   say one thing in the Android app and another in mobile Chrome… **Two opinions about
   what a Foray is, diverging at the first edit to either.**"* No test asserts
   byte-equality between two languages' worth of reasoning.
2. **The divergence would be silent and would take the form of a bad cut.** Every rule
   in §3.2 exists to guarantee "skip rather than play the wrong 40 seconds". A Swift
   drift gate that is 30 s where JS says 30 s but reads `duration` from a different
   place, or a Swift pad applied to the start as well as the stop, produces audio that
   plays and is wrong. ADR-0008 is explicit that *"anyone tempted to ship a
   LOCATE-REQUIRED segment by loosening the drift check is choosing a bad cut over a
   skipped one; do not"* — and a second implementation is the easiest way to loosen it
   without deciding to.
3. **The mechanism that catches drift today does not extend across the language
   boundary.** `test/suite-integrity.test.js` welds floors to the execution plan for
   `player/` and `tools/`. `ios-kit` runs `swift test` on `ios/ForayKit` only — **not
   on `ios/App/`, which is where a native queue manager would live**, and which has
   carried 0 tests and 9 open `// AUDIT:` items for seven weeks. A second engine under
   `App/` would inherit exactly that: **real, shipped, and outside every guard this
   repo trusts.**

**The maintenance cost, stated as a rate rather than a total.** In the fourteen days
to 2026-08-17, `player/` grew **66 KB → 480 KB** (`DECISIONS.md`, on why the bundle cap
was not lowered). Between 2026-07-07 (when `PlayerQueueState.swift` was last touched)
and 2026-08-21, the JS side landed out-points, in-points, the seam beat, the ADR-0007
ladder, the ADR-0008 pad, the rate control, the durable store, the diagnostic record,
the transport reconcile and the prefetch parking. **Tier 2 means every one of those
lands twice, in two languages, forever, with the second one compiled by a job that is
"not a required check" on a runner that bills at 10×.** Tier 1 means one module lands
twice. Tier 0 means none of it does.

---

## 6. What this document does not know

- **Whether CarPlay requires native playback.** Deliberately out of scope; being
  established in parallel. Everything in §4 is conditional on it.
- **Anything measured about AVPlayer, AVAudioSession, MPNowPlayingInfoCenter,
  MPRemoteCommandCenter or CarPlay.** No Apple SDK was compiled or run for this
  document; the machine is Windows. Every Swift-side capability claim here is assumed
  from Apple's documented API surface, and `ios/README.md`'s **9 open `// AUDIT:`
  items** are the standing register of that class of unknown. In particular: whether
  AVPlayer's boundary-time observation is accurate enough to replace the two-stage
  out-point watch, what an AVPlayer cold-start into a remote stitched MP3 actually
  costs, and whether zero-tolerance seeking into one is affordable.
- **`docs/ios-ci.md` §4c's open question — reading (a) vs (b).** Whether a hidden
  WKWebView page can be descheduled mid-Foray after sustained silence is *unresolved*,
  and it is the single measurement that most changes the answer: under (a), Tier 0 is
  not viable and Tier 1 is compromised. This document assumes neither.
- **The seam cost of a native engine.** The WebView's is measured (5.1–11.1 s hidden,
  9,153 ms at one real seam). AVPlayer's is **unknown, not known-better.** The
  underlying network cost is partly bounded — 0.99 s median / 1.41 s worst ranged-GET
  TTFB against six real sources — but that was desktop on a home network and is
  explicitly a lower bound. **No cellular measurement of anything exists in this
  repo**, and `docs/ios-ci.md` §4d says the CI runner can never provide one.
- **How many Swift tests would replace the 55 lost browser-compensation tests.**
  Unknowable before the AVPlayer measurements exist. It is not necessarily fewer.
- **Whether the 34 `PlayerQueueStateTests` still pass against the *extended* reducer.**
  They pass against the July reducer, which is what CI compiles. Nobody has written
  bounds, seek or out-points into the Swift, so nobody knows what breaks when they are.
- **Effort in engineer-time, for anything.** §2's difficulty column names reasons on
  purpose. Converting it to a schedule needs the missing measurements above.
- **Whether `ios/App/`'s 1,492 uncompiled lines — 1,017 of them in `App/Player/` — are worth harvesting or worth deleting.**
  `#28` says "harvest the logic; re-verify every AUDIT item against a real compiler and
  a real device", and `DECISIONS.md` leaves the retirement question open. Nothing here
  settles it. What is now measured is that the 1,017 player lines implement a **narrower
  contract for a product without segments**: `PlayerBackend.swift` has 8 of the 12
  members and no `setOutPoint`, and `PlayerQueueManager.swift` predates six of the
  concerns its JS counterpart now owns.
- **What Apple's review would make of any of this.** The CarPlay audio entitlement is
  account-wide, locks the app to one category, "wants to see a substantive working
  iPhone app before granting it", and has no published SLA
  (`docs/marketing/05-legal-risk-memo.md`). Not applied for.
- **Whether the drift gate works at all.** It cannot be observed on current content:
  `dai_suspected` is false for all 64 sources and all 212 segments, and `allowAdPad`
  defaults off. A port could ship it broken and no shipped Foray would say so.
