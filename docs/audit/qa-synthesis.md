# 4a audit synthesis — 176 confirmed findings, 12 causes

---

## 1. ROOT-CAUSE THEMES

Two thirds of the 176 findings collapse into twelve causes. Nothing here says the architecture is wrong. The recurring shape is the opposite: **a correct fix was written once, at the call site that hurt, and never promoted to the rule** — so the same defect is still live everywhere else it applies. That is what "subtly off" is.

### A. The curated 220 is treated as the definition of "a real episode" (7 findings, 3 high)

`state.poolIds.has(id)` is the identity test in five places — `app.js:1561` (`rowsForIds`), `:1671` (auto-advance), `:1715`, `:3704`, and `resolveEpisode` at `:6719-6721`. Since show pages gained the full catalogue, most episodes a listener touches are *not* in that pool. So the app classifies its own working episodes as gone.

Findings: Up Next "Episode no longer available" (`:7048`), Library History "No longer available" (`:7178`), Library Saved rendered unplayable (`:7181`), auto-advance stopping silently (`:1671`), "Open episode" → "Episode not found" for the audio currently playing (`:6719`, `:9134`), `#/show/pi:` dead after reload (`:2936`).

The asymmetry is visible in two adjacent functions: `toggleStar` (`app.js:897-899`) snapshots `state.itemIndex[id]` into `cp_saved`; `addToQueue` (`app.js:1519-1525`) stores a bare id and nothing else.

**One theme fix:** make *playability* the test (`state.itemIndex[id]?.audio_url`) instead of pool membership, and give every add-side action the snapshot `toggleStar` already writes. Two functions, ~10 lines, six bugs — three of them the highest-severity items in the whole report.

### B. Async work doesn't know which page asked for it (6 findings, 2 high)

Guards ask "is something still on screen?" rather than "is this still the thing that asked?". `app.js:3125` is the whole guard: `const stillMounted = () => !!container();` — identity-free, so show A's episodes, description and count paint into show B's page.

Same shape: `showSearchToken` not reset on remount (`:2240`), `_loadedId` stamped before the supersession check (`queue-manager.js:1233`), media listeners installed with no `_loadSeq` capture (`html-audio-backend.js:1553`), a foreground directory refresh calling `renderCurrentPage()` wholesale (`:11102`), and `bindForayScripts` re-delegating onto the persistent `#view` on every render (`:7776`) so "Show more" works on odd visits only.

**One theme fix:** a single render-epoch token that `route()` increments and every async continuation compares, plus the same sequence check after each `await` in the two backend load paths.

### C. The rule exists in one module and the running code bypasses it (~15 findings)

The cleanest example is measurable: `PositionStore.resumeOffset` (`position-store.js:93-100`) encodes the near-end and min-resume rules, and **it has zero callers outside its own file** (grepped). The path that actually plays reads raw seconds: `_savedPositionFor` (`queue-manager.js:1931-1936`). That single gap produces "press play on a finished episode, hear the outro", the restored bar showing 0:00 then playing the end, and the Jump-back-in card claiming a finished episode has its whole runtime left (reported three times — one cause).

Same shape, repeatedly:
- `transportIsRunning()` (`client.js:788`) is the #689 authority, used at `:1058/:1455/:1651/:2773` — but `syncCardButtons` (`:1103`) and `mediaSessionView` (`:1636`) still call `isPlaying()`, and `app.js:8968` paints from the stale snapshot. Hence the card glyph, the lock screen and the Foray button each disagreeing with the bar.
- `safeDecode` (`app.js:2018`) is applied at exactly two of six param routes (`:10618`, `:10627`) — with a comment explaining why — while `:10619` and `:10620` use raw `decodeURIComponent` on the very next lines and `#/playlist/`/`#/subject/` decode nothing.
- The correct plural `part${n === 1 ? "" : "s"}` is at `:7191`; `:5602`, `:6276` and `:7235` print "1 parts".
- The conditional-separator subtitle is correct in `forayRow` (`:7797`) and `archivedRow`; `epRow` (`:6567`) and `upNextRow` still emit `"Show ·  · date"`.
- `fmtDate` exists; `:7235` uses raw `toLocaleDateString` and can print "Invalid Date".

**One theme fix:** for each of these six, delete the duplicate logic and call the helper. Nearly all mechanical, all test-lockable.

### D. Two names for one truth — labels written once, state changed underneath (7 findings)

`aria-label` is set at build time; `textContent` is updated on toggle. The show star is the worst case: the visible text becomes "★ Starred" while the accessible name stays "Star show" (`app.js:919`), so the label is now actively wrong. Same for episode stars, every play button (`:719`, `client.js:1103`), the Foray main button that reads "Loading…" and announces "Play" (`:8972`), the mini bar's info button that hides the episode title entirely (`client.js:502`), down-vote chips with no `aria-pressed` (`:7933`), and the Foray running-order's playing/played state being colour-only (`:9054`).

**One theme fix:** one `setToggleLabel(btn, on, {onLabel, offLabel})` used by every toggler, and a standing rule that no control whose text changes may carry a static `aria-label`.

### E. Nothing in the app owns "a modal is open" (6 findings)

No sheet moves focus, traps Tab or closes on Escape — including the first-run sheet a brand-new listener meets (`:4049`) and the full-screen Now Playing sheet, which has no dialog role at all (`client.js:567`). The speed menu has no single-instance guard and stacks (`:8892`). `fy-sheet-open` is in `PERSISTENT_BODY_CLASSES` (`app.js:823`), so a back gesture leaves `overflow:hidden` on `<body>` with no sheet on screen. And `--kb-inset` is written by `installKeyboardChrome` but read by **exactly one CSS rule** (`styles.css:1403`, the docked search bar) — no sheet consumes it, which is why every text field in a sheet ends up behind the keyboard.

**One theme fix:** one `openSheet()/closeSheet()` owning focus, `inert`, Escape, single-instance, the body-class lifecycle and `bottom: var(--kb-inset, 0px)`.

### F. Tap targets were sized by eye, not by a rule (14 findings)

`styles.css` is 3,287 lines and contains **four** 44px targets. Two comments in the file claim sizes the CSS does not deliver: the chapter row comment says 48px over a ~19px live button (`:1840`), and the Foray thumbs comment sizes the layout around "the 44px-ish thumb target" over 30px squares (`:2407`). The consequences aren't neutral — a missed reorder arrow removes the item, a missed Audition changes the narration voice, a missed star starts audio.

Two of the fourteen are gestures, not sizes: the sticky Foray strip opts out of panning so a scroll flick seeks (`:2009`), and `.fp-scrub` has no `touch-action` while the one slider that got it fixed carries a comment describing exactly this failure (`:1874`).

### G. Loading and failure are rendered as fact (11 findings)

An absent thing, a thing still loading and a thing that failed to load all render as a positive claim about the catalogue. "7 episodes · loading the rest…" over zero rows (`:2843`); `No results for "huberman"` painted during the debounce (`:5014`); "0 forays" when `player/client.js` hasn't evaluated (`:6545`) — while the *detail* route for the identical failure says the right thing, so the app already knows the distinction and this route throws it away; "No shows here yet" on a catalogue 404 (`:1964`, `:1976`); a blank body on cold boot (`index.html:61`); "couldn't refresh just now" both before any refresh and after a successful one (`:2858`, `:3427`); "N segments can't play — listed below" listing none (`:8124`).

**One theme fix:** a three-state convention (`loading` / `failed` / `empty`) every list painter must branch on, plus the rule that a count and its rows must come from the same source.

### H. Sticky copy — strings that outlived the thing they described (9 findings)

"build one from the home screen" (`:7193`) points at a builder moved to `#/playlists`. "Pull to refresh" (`:3166`) names a gesture that does not exist. The "Open in:" toggle (`:9374`) governs two dead link builders. "Your browser held the audio back" / "reload the page" (`:8525`) is browser copy inside a Capacitor shell. Notes outlive their causes (`:4977`, `:3657`). The stale-shell banner offers a Reload the code's own comment says reproduces the state (`:11642`). Home's greeting is computed once and still says "Good evening" at 7am (`:6195`).

### I. The v2 redesign is a layer on top of v1, and v1 shows through (~19 findings, 3 high)

`body.ui-v2` (`styles.css:59-77`) defines nine tokens. Five that live rules still read — `--surface-2`, `--text-dim`, `--accent`, `--gold`, `--shadow` — are **not** redefined, so on a phone set to Light they flip to v1's light values (`styles.css:21-33`) while the page stays dark: near-white artwork blocks, invisible shadows, blue accents in five controls, gold where amber belongs, and a destructive "Delete everything" button that renders violet like Play.

The reason this survived is instructive: `test/ui-tokens.test.js` pins the nine *new* tokens and bans hardcoded hex outside the block. It says nothing about tokens v2 never defined, so it passes while the palette breaks.

**One theme fix, five lines:** alias the surviving v1 tokens inside `body.ui-v2` and extend `ui-tokens.test.js` to assert no live rule reads a token v2 doesn't own. The typography/radius/badge findings (`:585`, `:1782`, `:10`, `:3243`, `:716`) are a second, slower pass and need taste calls.

### J. Durability was designed but not finished (8 findings)

`durable-store.js:22` advertises a Capacitor Preferences tier that does not exist, so inside the shipping shell both live tiers are script-evictable — the exact defect the store was built to prevent. A write localStorage refuses but IndexedDB accepts is reverted on next launch *and* overwrites the good durable copy (`:663`), across fourteen keys including `cp_sb_session` — losing that silently makes the listener a new anonymous account. "Delete my data" reports success while `foray_events` survives in a second IndexedDB (`app.js:9645`), and can say "This device is NOT fully clear. 0 key(s) would not clear." (`:9729`). A missing `taxonomy.json` wipes the interests profile on the next play (`:416`).

### K. Back / forward is a guess, because the URL is not the source of truth (12 findings)

`noteNavigation` (`:10778`) infers "back" from stack shape, so a forward tab tap restores a stale scroll position. Scroll restore fires before async pages paint and then records the failure as position 0 (`:10696`). Screen state that matters lives in module variables rather than the hash, so a reload or a back-step loses the show search (`:2384`), the in-show episode search (`:3121`), and a subject queue re-dealt at random per load makes `#/subject/:branch` unanswerable on reload or share (`:1126`). Three spellings of Home cost a dead back press per session (`:10685`), and `tabForHash` leaves no tab lit on three routes (`:9259`, `:9262`, `:10636`).

### L. Two models of the same object, so the numbers disagree (8 findings)

The Foray header says "50 segments" while the strip mounted directly beneath it announces 11 (`:7990`); the header counts shows the credits block refuses to count (`:7991`); 41% of an advertised runtime is a `script.length / 17` estimate printed as a measured clock (`:7992`); "N played" decreases as the 200-entry history ring rotates (`:6682`); a subject card's count and its duration are computed over different populations (`:3833`).

**Orphans:** roughly 50 findings are genuine singletons (e.g. `fmtDur` printing "1h 0m" at `:851`, the "Show more" delegation leak, the restored ribbon's dead lock-screen controls). They are cheap; they just don't ladder.

---

## 2. FIX ORDER

Grouped so edits land in the same file/subsystem. **[M]** = safe mechanical, covered or coverable by the existing 60-file node suite. **[J]** = needs a founder judgement call before code is written.

**Phase 1 — app.js identity & helpers (highest payoff per line)**
1. **[J then M]** Theme A: `rowsForIds` (`:1559`), `addToQueue` (`:1519`), auto-advance (`:1671`), `resolveEpisode` (`:6719`), `restoreNowPlayingRibbon` (`:9134`). *Judgement:* what does "available" mean — is a snapshot with an `audio_url` a promise you're willing to make, or do you want a fourth row state that says "saved copy, may have moved"?
2. **[M]** Theme C's pure helpers, in one commit: `fmtDur` (`:851`), a single `partsLabel` (`:5602`/`:6276`/`:7235`/`:7191`), the subtitle joiner (`:6567` + `upNextRow`), `fmtDate` on the playlists row (`:7235`).
3. **[M]** Router: `safeDecode` on `#/show/`, `#/category/`, `#/foray/`, `#/playlist/`, `#/subject/`; `try/catch` around `route()` in `init()` so a bad first hash can't skip listener wiring; `tabForHash` fallback + `shows($|\/)` + `interests$`.
4. **[M]** Theme B: identity-based `stillMounted` (`:3125`), token reset in `renderAllShows` (`:2240`), `bindForayScripts` bound once from `init()` (`:7776`), dismissal flag on the shell notice (`:11632`).

**Phase 2 — app.js states & copy**
5. **[J]** Theme G: agree the loading/failed/empty convention, then apply at the ten sites. The convention is the judgement; the application is mechanical.
6. **[J]** Theme H + the vocabulary split (segment/clip/part/beat at `:7672`; star/save/starred; topics/subjects/interests; the "daily" claim at `:6691`). One founder ruling on nouns, then a find-and-replace pass and a `copyRules` test extension.
7. **[M]** Theme D: the toggle-label helper and its seven call sites.
8. **[J]** Theme E: the `openSheet` helper. Judgement only on scope — whether the Now Playing sheet becomes a real dialog now or later.

**Phase 3 — styles.css**
9. **[M, do first, ~5 lines]** Alias the five v1 tokens inside `body.ui-v2` (`:59`) + extend `ui-tokens.test.js`. This alone retires the light-mode class of bugs.
10. **[M-ish]** Theme F sizes and `touch-action`. Mechanical edits, but each moves layout — needs a device pass before merge.
11. **[J]** The remaining v2 consistency work: radius scale (`:10`), typography (`:585`, `:1782`, `:254`), badges (`:3243`), pills (`:716`), row shapes (`:795`). All taste.

**Phase 4 — player/ (riskiest, best-covered)**
12. **[M]** `transportIsRunning()` in `syncCardButtons` (`client.js:1103`) and both `mediaSessionView` calls (`:1636`). Two lines; `transport-reconcile.test.js` (1,495 lines) is the net.
13. **[M]** `_savedPositionFor` → `resumeOffset` (`queue-manager.js:1931`), and the raw-seconds read for Jump-back-in display (`client.js:2161`). Note these pull in *opposite* directions — resume uses the collapsed value, display uses the raw one.
14. **[M]** `_loadSeq` guards in `queue-manager.js:1233` and `html-audio-backend.js:1553`; the `foraySeek` out-point clamp (`:809`).
15. **[M]** Restore path: `media.setActions` in `restoreLastEpisode` (`client.js:2197`), scrub handlers writing `restoredPending` (`:1787`).

**Phase 5 — persistence [J throughout]**
16. The durable-store revert (`durable-store.js:663`) and the Capacitor tier claim (`:22`) — decide whether to build the tier or amend the promise.
17. `event-log` purge in `clearLocalData` (`app.js:9645`) and the "0 key(s)" message (`:9729`). This one has a legal edge: the app currently reports a deletion it did not perform.

---

## 3. THE FELT SHORTLIST

The founder's complaint is *"subtly off"*, not *"broken"*. That points at defects firing on every session, not rare-path correctness. Ranked by felt-change per line changed:

1. **Alias the five v1 tokens** (`styles.css:59`) — ~5 lines. Every screen, every session, on any phone set to Light. Cards regain elevation, secondary text regains contrast, stray blues and golds disappear. Nothing else in this report changes as much for as little.
2. **`rowsForIds` playability test + `addToQueue` snapshot** (`app.js:1559`, `:1519`) — ~10 lines. Library, Up Next and History currently tell the listener the app forgot what they did. Those three screens are where trust in a podcast app lives.
3. **`transportIsRunning()` in `syncCardButtons` and MediaSession** (`client.js:1103`, `:1636`) — two lines. The play button is the most-touched control in the app; right now it can show ▶ while audio plays, and the lock screen says paused while sound comes out.
4. **`resumeOffset` in `_savedPositionFor`** (`queue-manager.js:1931`) — three lines. "Press play, hear fifteen seconds of outro, silence" is the kind of thing a listener can't name but never forgets.
5. **Identity-based `stillMounted`** (`app.js:3125`) — two lines. Removes the worst category of confusion: content from a show you aren't looking at, fully playable, under the wrong title.
6. **The six most-used tap targets** (`.fp-scrub` touch-action, `#fy-strip` pan, `.fp-info` stretch, row ▶/☆, queue ✕/arrows) — CSS only. This is most of what "feels subtly off" literally *is*: a phone that half-ignores you.
7. **A one-line cold-boot placeholder** (`index.html:61`) — the first thing every listener sees is currently a blank page under a working toolbar.
8. **Gate "No results" on `owed === 0`** (`app.js:5014`) — search is the primary entry point and it currently tells you it found nothing before it has looked.

Deliberately *not* on this list despite being correct and severe: the durable-store revert, the Foray runtime-estimate honesty, the radius scale. Real, expensive, rarely felt.

---

## 4. THE UNCERTAIN PILE

One item: **the browse-subject pills on `#/shows`**.

The mechanical half is settled and needs no device. `browseTile` (`app.js:2074-2078`) emits `#/shows/q/<label>`, the router dispatches it to `renderAllShows` (`:10627`), the first paint is a **show-title substring search** (`search-engine.js:2024`), and the browse furniture hides itself first (`:2150`). So the destination of a subject-browse control is a name search. That is a design mismatch, not a measurement question.

Three things would settle the rest:

- **A live-network measurement.** Re-run all 41 root labels against the breadth endpoint, the Apple fall-through and the shard pass. A prior measurement (2026-09-13) is recorded in two places — `app.js:2044-2050` and `test/category-browse.test.js:340-346` — claiming 10–50 results for every label. It cannot be verified or refuted by reading, and Apple's directory drifts. Note the auditor's own static count disagrees with the finding's label list in both directions: it adds "Transport" and "Cities" and probably clears "Espionage". **Re-measure; do not copy either list.**
- **A founder ruling on intent.** Is the pill a *subject* browse or a *name* search? If subject, the join already exists (`showsForCategory`, `app.js:1912`, plus a root→descendant walk) and no measurement is needed to know the current wiring is wrong.
- **Nothing, for two sub-parts.** Unconditionally true today: (a) every pill paints `No results for "<label>"` for the 118–561 ms before any endpoint replies — same fix as Theme G; (b) offline, or on an Apple timeout/rate-limit (which `api/shows/search.ts` answers 200 with zero rows *by design*), at least seven labels are a permanent dead end. Both are fixable now regardless of how the ruling goes.

To stop it rotting: put the ruling in the issue, and make the measurement an actual assertion rather than a comment — a comment recording a network result is a claim no CI run will ever re-check.

---

## 5. WHAT THIS AUDIT COULD NOT COVER

Stated plainly so nobody mistakes 176 findings for completeness.

- **Anything that needs a real device.** Actual tap accuracy (every touch finding is a CSS measurement, not an observed miss), soft-keyboard behaviour, iOS safe areas, notch geometry, the Capacitor WebView's real storage eviction, lock screen / CarPlay / Android Auto, Bluetooth interruptions and route changes, backgrounding and audio-session behaviour.
- **Anything that needs a live network.** Real latency and result quality of the four search passes, Apple endpoint behaviour and rate limits, whether arbitrary RSS feeds actually parse, what the breadth endpoint returns today. The shipped JSON was measured; the live answers were not.
- **The audio itself — plausibly the biggest determinant of whether 4a is good.** Whether narration sounds right, whether the TTS voice is acceptable, whether a Foray's seams land, whether a stitched hour is worth an hour. No amount of code reading reaches this.
- **Performance.** Scroll jank, memory, battery, time-to-first-audio, and the cold-phone parse cost of an 11,692-line `app.js` plus a 3,287-line stylesheet.
- **Accessibility with an actual assistive technology.** Every a11y finding is derived from markup. Nobody ran VoiceOver or TalkBack. Real testing will find things this list missed and will contradict some of its severity calls.
- **The backend.** `api/`, `backend/`, auth, the sync pipeline's server side, and what actually happens to a listener's rows when "delete my data" calls the server.
- **Service-worker behaviour across deploys.** One Playwright spec touches partial cache population; the stale-shell findings are read from the client side only.
- **Whether the fixes will hold.** There are ~60 node suites and 7 Playwright specs, but most findings have **no test pinning the correct behaviour**. `ui-tokens.test.js` is the worked example: it passes today while the palette it exists to protect is broken, because it enumerates what was added rather than what is read. Every fix in Phase 1–2 should land with the assertion that would have caught it.
- **Real listeners.** No usage data, no session recordings, no support reports beyond the founder's own. The felt shortlist is an argument from where controls sit and how often they fire — it is a hypothesis about what matters, not evidence.