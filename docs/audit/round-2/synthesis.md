# 4a audit, round 2 — 163 confirmed findings, 14 causes

Round 1 (2026-09-22, `docs/audit/qa-synthesis.md`) found that "subtly off" meant *a correct fix written once at the call site that hurt and never promoted to the rule*. Round 2 was run on the code after the six round-1 lanes, the release lane, the Foray-data lane, the completeness sweep and visual pass 1 had merged (PRs #739–#744), through eighteen lenses: the ten QA areas again, six personas again, and two new lenses round 1 could not staff — performance and the native shells.

The headline is not that round 1 missed things. It is that round 1's fixes were mostly correct and mostly **local**: 41 of the 163 rows are marked "incomplete fix of" or "second-order interaction between" round-1 rows. The rule was promoted at the site named in the finding and nowhere else, or two independent round-1 fixes now meet in a place neither considered (continuous playback × the Up Next page; the lock-screen 15/30 fix × the steering-wheel next fix; the Foray on the ribbon × failure copy on the bar). That is the same shape round 1 named, one level up.

Three findings are high: the machine settles at the end of an episode and nothing repaints (`player-1`), so continuous playback — the feature the founder asked for on 2026-09-14 — does not fire with the screen off; the Foray strip's hold-and-drag never commits on a touchscreen (`touch-1`); and Delete my data rotates a refresh token without saving it (`persist-1`), stranding the account it was meant to delete. A fourth (`native-2`, Android Forays running with no service) is high on Android only. The rest is medium and low, and — as in round 1 — the medium pile is where "subtly off" lives.

---

## 1. ROOT-CAUSE THEMES

Round-1 letters are kept where a theme is the same cause continued; new causes get R2 letters. Each theme names one rule that, promoted, retires the cluster.

### R2-A. The machine settles and nothing repaints (7 findings, 1 high) — *incomplete fix of persona 47/57/73 and qa 39/40*

The player reducer is correct: at the natural end of an episode it moves to `ended`, then to the next item. But the surface repaints only on **media events** (`timeupdate`, `play`, `pause`) and on `visibilitychange`. When the element stops there is no media event after the backend's own `ended` listener, the reducer moves in a microtask, and nothing calls `render()`. So the bar keeps ❚❚, the lock screen keeps PLAYING and extrapolates past the end, the Up Next episode never starts — until an unrelated event (unlocking the phone) repaints, at which point playback begins. Press ❚❚ first and `resume()` from `ended` cold-starts and replays the finished episode from 0:00 (`player/client.js:2821`). Because the page never writes `none`/`ended`, the 2026-09-23 iOS session model never reaches `releaseAndNotify`, so the app 4a interrupted never learns it may resume.

Same shape: `loadingItem` is a state with no paint (`p-impatient-4` — the impatient user's double tap), a Foray load failure paints only on the Foray page (`player-7`), a restored Foray's clip counter never follows a scrub (`player-10`), the car's clock keeps counting through a stall (`p-car-8`), the Up Next page goes stale as the queue drains (`p-impatient-6`), and a playlist build that finishes late navigates whoever is on screen (`races-3`).

**One theme fix:** the surface paints from `manager.state`, not from media events. An `onStateSettled` hook on `PlayerQueueManager` (the `onSeamGapChange` pattern), fired from `_handle` for every transition, wired to `render()`; `render()` then has a state to paint loading, finished and failed from. Add a `runOut()`-ordered test on the real client.js asserting the bar paints ▶ after `ended`.

### R2-B. A two-step operation whose second step does not know which item asked (8 findings) — *round-1 theme B carried into the player*

Round 1 made superseded loads settle quietly (`_loadSeq`, `_loadedId`). Nothing above them re-checks ownership. `playForay`/`foraySeek` and the restored ribbon are play-then-seek: the seek fires onto whatever loaded next (`races-1` — Next clip during a resume seeks the new clip to the old clip's episode offset and free-plays a stranger's episode). A nudge during `loadingItem` seeks the element, not the resume point (`p-impatient-1` — ↺15 after ▶ restarts from 0:00). `play()` answers "the player is not idle", not "your item is playing" (`p-impatient-2` — the abandoned tap enters History). A scrub while paused is never flushed at hand-over (`player-3`). Search's ✕ clears the field but not the in-flight query (`races-2`). A sync in flight during Delete re-plants the old token (`persist-8`).

**One theme fix:** carry intent into the one step (`manager.play(index, { startOffset })`), answer for the item id after every await, and flush the outgoing item at every hand-over.

### R2-C. The modal owner exists but only Now Playing got the whole contract (11 findings) — *round-1 theme E, incomplete*

Round 1 built `openSheet()`. It owns focus, `inert`, Escape and the body class — for sheets. The drawer is not a sheet: its scrim scrolls the page, Escape does nothing, Tab leaves it (`nav-5`). Eight sheets paint a drag handle that does nothing (`touch-4`). The one sheet that does drag cannot be pulled from its body on a phone because `pointermove.preventDefault()` does not stop a touch scroll (`touch-2`), and it vanishes from mid-screen on dismiss (`touch-8`). Focus: Get started destroys the focused button (`a11y-5`); Stop returns focus to a button and then hides it (`a11y-6`); the only live region is inside the bar the sheet makes inert (`a11y-2`). Android's hardware back is the raw WebView back, so it closes the overlay *and* changes the page (`nav-2`). A drawer link to the current page under the sheet leaves the sheet up (`nav-8`). The first-run sheet has the affordances inverted — the handle is decoration and a scrim tap ends onboarding forever (`p-first-4`), over a playing bar made inert (`p-first-5`).

**One theme fix:** one contract for every overlay — scroll lock, inert, focus in/out that survives a hidden root, Escape and hardware back, drag-dismiss (or no handle), a live region that is a sibling of the sheet — and a test that walks every `openSheet` call site.

### R2-D. Touch was designed with a mouse (10 findings, 1 high) — *round-1 theme F, incomplete*

Round 1's tap-target rule was applied to a hand list. Follow, every sheet's Cancel/primary, Show all, Reset and the notice ✕ are 26–41px (`touch-5`). The strip's hold-and-drag delegates its seek to a `click` no mobile browser fires after a moved touch (`touch-1` — a mouse commits, which is why it looked finished). The nested show link is a 13px target inside a stretched row (`touch-6`, the reverse of qa 12). Half of every two-tier row is dead and the live half lights only the title text (`touch-9`). Timestamp padding overlaps the next line so the gap seeks to the next stamp (`touch-10`). Long-press on any stretched link pops WKWebView's preview of `capacitor://localhost` (`touch-3`). The static strip inherited the live strip's `pan-y` and sticks a rail flick (`touch-11`). The return key does not dismiss the keyboard and autocorrects host names (`search-3`). The search field is the one control whose focus ring is switched off (`a11y-3`).

**One theme fix:** gestures commit on `pointerup` with a non-passive `touchmove`, never on a trailing click; `allowsLinkPreview: false` and `-webkit-touch-callout: none` on stretched links; `tap-targets.test.js` walks every button selector in the stylesheet instead of a list.

### R2-E. The Foray is a second-class episode (16 findings, 1 high on Android) — *second order of persona 7 and persona 58*

Round 1 put the Foray on the ribbon and gave it the seek pair. Every surface built for episodes then needed a Foray clause, and most did not get one. The bar's second line has two wordings (`copy-5`); a restored Foray's lock-screen entry is built as an episode (`player-10`); a Foray failure is silent on the bar and sheet (`player-7`); 30↻ has no end guard inside a Foray and wipes its resume row (`player-5`); Previous during a narration line always restarts the line (`player-4`); ↺15 inside a spoken line does nothing (`player-11`); a finished Foray leaves no trace anywhere while a finished episode says Played everywhere (`honesty-2`); Library's Forays read from the rail's 3-row cap (`honesty-12`); nothing before the Foray page says how long a Foray is (`p-foray-8`); estimated runtimes are marked on one surface of four (`states-11`); Search cannot find a Foray (`p-foray-4`); every show in the published Foray is an in-app dead end (`p-foray-2`). Natively: a narration-first Foray runs on Android with no service and no lock-screen controls (`native-2`), an iOS interruption during a narration line leaves it saying Playing in silence forever (`native-3`), and only narration lines use `.spokenAudio` (`native-10`).

**One theme fix:** four kinds every surface must answer — episode, live Foray, restored Foray, narration line — from one `kindOf(current)`, and a transport-reconcile matrix that runs each action across the four.

### R2-F. Nothing owns "played" or "how long" (13 findings) — *round-1 theme L continued; persona 78 / qa 162 incomplete*

Round 1 added the row progress label and fixed its formatting. It never compared the sources. 26 pool items have `duration_min ≠ round(duration_sec/60)`, 19 by a minute or more, so a row reads "45 min · 53 min left" (`honesty-1`). The row bridge prefers the catalogue's duration while the bar prefers the measured one (`honesty-4`), so a row can say Played with 15 minutes of audio left. "N played" in a playlist header counts opened episodes above rows that say "42 min left" (`honesty-6`); the episode page and Up Next rows carry no progress at all (`honesty-5`); the playlist card on Jump back in has none (`honesty-7`); a newcomer sees "0 played" on every list (`p-first-10`); History is in first-play order (`honesty-3`); one row prints four duration dialects (`copy-2`); the countdown drops its sign for half a second (`honesty-13`).

**One theme fix:** one `progress(item)` — state (none / started / played, where played means finished), percent, seconds left, duration (measured before catalogue), estimated flag — and one dialect formatter, consumed by every row, card, header and the ribbon.

### R2-G. Loading and failure still rendered as fact where the convention was not applied (13 findings) — *round-1 theme G and the 2026-09-23 "no request waits forever" rule, incomplete*

The convention exists; the fetches that bypass it are the show page's episode fetch, the boot fetch and the show-index fetch (`states-4` — no deadline, no service worker in the shell to cut it off), and `retryForayDocs` (`races-7`). A curated show whose fetch fails has no Try again (`states-2`). A missing `segments.json` at boot paints as content: "22 clips couldn't be found" over an empty running order (`states-3` — retry treats the three documents as one artifact; boot does not). "The player didn't load → Try again" waits for a module event that will never fire (`states-6`). A dead episode endpoint fails silently whenever the show pass found anything (`states-7`); a degraded catalogue reply is cached as the answer (`search-4`); the offline empty state stacks three contradicting notes (`search-12`). The show page says every outcome twice (`states-8`); "available offline" and "so far" promise things that do not exist (`states-9`, `states-10`). ☰ and ↻ are painted from the first frame but dead until boot finishes (`nav-9`).

**One theme fix:** every fetch through `withDeadline`; every failed branch — including failed-with-rows, degraded and partial — paints one sentence and one Try again that can succeed.

### R2-H. Search is four passes and the painted list forgets what it knows (10 findings, 1 high) — *second order of #684 and S-03*

`#684` made the list append-only so rows never jump. The merge therefore skips a row it already painted — so the strongest matches (the index's prefix hits, blank grey squares with no byline) never receive the artwork later passes bring (`search-1`: all 24 prefix hits for "daily" are blank). A same-query repaint is now the only thing that shrinks the list, and a trailing space or an early return triggers it (`search-7`). The lazy index loads only on focus, so pills, back-steps and reloads search the curated 220 (`search-6`). The Search tab throws the search away; only ‹ keeps it (`search-5`). Diacritic folding was applied to two of four passes (`search-9`). Remote episode rows carry no artwork, date or show id, so the lock screen shows the 4a icon and the show name is dead text (`search-8`, `p-switcher-7`). The Episodes section stops at 10 without saying so (`honesty-11`). And "Create a playlist about X" is offered exactly when the build is guaranteed to fail (`search-2`) — a one-tap dead end under half of all searches.

**One theme fix:** the painted record is the source of truth (upgrade in place, never shrink on the same query), the query state lives in the hash and the tab remembers it, every result row carries the show-page snapshot fields, and the CTA is offered only when it will succeed.

### R2-I. The boot path is serial and background work fights the listener (10 findings) — *new*

Round 1 could not measure performance. Measured now: the seven data fetches do not begin until the 28-module player graph (five serial round trips) and IndexedDB have settled (`perf-1`); `primeVocabulary` is a 176 ms single task in Node — 0.5–0.9 s on a phone — fired on a 0 ms timer in the shell exactly when the listener starts tapping (`perf-3`); on every deploy day the worker precaches 1.3 MB with `cache: "reload"` in parallel with first paint (`perf-4`); the worker re-hashes ~5 MB into CacheStorage on every launch (`perf-6`); fonts are not in the manifest so every launch flashes the fallback face (`perf-5`); the Search tab loads 167 six-hundred-pixel artworks into 44 px rows (`perf-2`); `render()` walks every `[data-play]` button four times a second in the background (`perf-7`). Hydration overrunning the 5 s bound lets `init()`'s own writes shadow the durable copies for good (`races-4` — only `cp_rate` was fixed). The loading screen paints in the retired v1 light palette and hard-cuts to dark (`p-first-2`).

**One theme fix:** nothing first paint does not need runs before it, idle work yields, hidden pages do no UI work.

### R2-J. Delete my data is not a transaction (9 findings, 1 high) — *round-1 theme J continued*

Round 1 established remote-before-local. The refresh that precedes the DELETEs is not persisted, so one failed table strands the account and the next sync mints a new identity, making the old rows unreachable by anyone (`persist-1`). A sync in flight is not gated (`persist-8`). A finished deletion re-renders Home, which writes `cp_playlists` back into every tier and pops onboarding over the result (`persist-2`). The shard cache survives (`persist-4`); the diagnostics record comes back with the pre-deletion count and the deletion time (`persist-5`); the native Preferences copy rides platform backups and a restore re-attaches the deleted account (`persist-6`); "Clear this device only" does not say the rows become permanently undeletable (`persist-7`); `cp_pos:` rows are never pruned (`persist-9`); and the privacy policy disagrees with `index.html` and data-safety.md on origins, processors and miss-only (`persist-3`).

**One theme fix:** one guarded transaction, one store list read by the code, the policy and the test, plus a connect-src tripwire.

### R2-K. Tokens exist; the rules read three steps of them (20 findings) — *round-1 theme I / qa 51, 53, 55, 60 incomplete*

Visual pass 1 wrote the scale. The rules still read three radii and two heights for text fields (`visual-8`), two type specs and two elevations for the same transport buttons (`visual-5`), three section-title sizes under a comment claiming one (`visual-12`), four gutters (`visual-13`), mixed elevation inside one column (`visual-14` — the qa 53 "taste" deferral now shows on three pages), 600/700 row titles by surface (`visual-15`), two silhouettes on the Up Next row (`visual-11`). Two are outright bugs: a mangled CSS escape renders the notes chevron as a sideways capital A on every episode page (`visual-1`), and the Interests sliders paint UA blue on an amber page (`visual-2`). The rest are rules never written: when a tag is warranted (`visual-9`), when a list is numbered (`visual-10`), when a page shows ‹ (`visual-6`), a branch dot that is violet on most cards (`visual-3`), a Shows tier with no eyebrow (`visual-16`), a doubled Interests heading (`visual-17`), a 3-line sticky title (`visual-4`), a floating ↗ (`visual-7`), a muted "min left" on Home only (`honesty-8`), the wordmark twice on Home (`p-first-8`), no title clamp on result rows (`search-11`), and reduced motion covering three rules of nine (`a11y-9`).

**One theme fix:** one rule per role, consumed by class, with `ui-tokens.test.js` enumerating the selectors that read each role.

### R2-L. Copy has two narrators and four dialects (18 findings) — *round-1 theme H continued; qa 141 / 151 incomplete*

"4a" in most copy, "we/us/our" in the rest, sometimes on one sheet (`copy-11`). One failure worded three ways across the Foray page, sheet and bar (`copy-6`). "This browser has taken storage away … Reload" on a phone (`copy-1`). "Topic" on the down-vote chip where everything else says subject (`copy-7`). Curly quotes on one button (`copy-8`). "Removed from your history" on Up Next for a row nobody removed (`copy-9`). A plural sentence ending in the singular (`copy-10`). Maintainer notes-to-self in the voice picker (`copy-12`). Three registers of page-head fragment (`copy-13`). A Follow note that reads like a bug report (`copy-14`). Every date printing its year (`copy-15`). The narrator with three names (`p-foray-12`); curator's private why-lines as row captions — "Kahl names…", "shares stay his" (`p-foray-5`); a permanent promise of a narrator over the only Foray that has none (`p-first-11`).

**One theme fix:** a DECISIONS rule — the app is 4a, never we, outside legal copy; one duration dialect; one sentence per state — enforced by `listener-copy.test.js` tokenising app.js and client.js together.

### R2-M. The lock screen, the car and the Android shade are a surface nobody designed (13 findings, 1 high on Android) — *new; second order of the 2026-09-23 lock-screen and steering-wheel fixes*

The 15/30 fix relies on the skip pair being what the lock screen draws; the steering-wheel fix enables `nextTrackCommand` at the same moment, so with anything queued iOS may draw ⏭ in place of 30↻, and the glyph flips back mid-drive as Up Next drains (`p-impatient-3`). ◀◀ on an episode jumps to the previous row instead of restarting, unlike every podcast app and the Foray's own previous (`p-car-5`). At the end of the last episode the lock screen and car go blank and every wheel button dies (`p-car-6`). After a call, the page's own reconcile pauses the element mid-interruption, cancelling the OS resume (`p-car-3`). The Android notification never offers 15/30 (`native-7`) and re-posts itself on every press (`native-8`). Zoom was removed citing Dynamic Type, which nothing implements (`a11y-1`). Android back is undesigned (`nav-2`). There is no in-app ⏭ at all — next exists only on the lock screen and the car (`p-impatient-7`).

**One theme fix:** the platform contract written once in DECISIONS.md and both shells driven from one `mediaSessionView`, verified on a device before merge.

### R2-N. First run and Up Next make promises the model cannot keep (15 findings, 1 high) — *second order of persona 14/44 and the continuous-playback fix*

Simulated over the committed data with the app's own `buildCards`: picks [comedy, food, sports] land all three on Home 1% of the time and none 29%; unpicked engineering/history appear in ~35%/31% of slots regardless (`p-first-1`). "Or type a subject yourself" silently discards anything that is not an exact root label — "health", "news", "AI" all vanish (`p-first-3`). "Start listening" starts nothing (`p-first-7`). Two playlist builders with two vocabularies (`p-first-6`). "Followed shows ›" leads a newcomer to an empty page (`p-first-12`). A thumbs-down for "Bad audio quality" lowers interest in the whole subject (`p-foray-6`). On Up Next: the finished row stays as #1 until you touch an arrow (`p-impatient-6`); the workaround for the missing ⏭ replays the abandoned row later because `planAfterEnded` wraps (`p-impatient-7`); reorder is one step per tap with a full rebuild (`p-impatient-8`, `perf-10`); an archived part accepts "+ Up Next" and is then skipped without a word (`p-impatient-10`); the 400-snapshot cap can prune the front of a long queue (`p-impatient-11`).

**One theme fix:** a control names what will happen and is offered only when it can; a pick is a fact; Up Next is a live model patched in place that accepts only playable ids.

**Orphans:** `p-foray-1` (the interlude sting fires inside one conversation — 13 of 21 seams in the only published Foray), `p-foray-7` (a generated Foray's strip overflows the page), `nav-1` (‹ dead when back lands on the same hash), `nav-3`/`races-6`/`nav-7`/`a11y-10` (the qa 80/115 announce-and-restore work was left incomplete on Search, Home, late paints and explicit titles), `nav-10` (relaunch lands on Home), `perf-8` (rails snap to the first card), `a11y-7`, `a11y-8`, `a11y-11`, `p-switcher-2` (the sheet's notes are dead text — the 2026-09-17 ruling reached the episode page only), `p-switcher-5`. Cheap; they just do not ladder.

---

## 2. THE FELT SHORTLIST

Ranked by felt change per line changed, as in round 1.

1. **`player-1`** — a `queueMicrotask(render)` from the backend's `ended` listener (or the `onStateSettled` hook), ~5 lines. Continuous playback happens with the screen off. Nothing else in this round changes as much for as little.
2. **`p-impatient-4`** — paint "Loading…" while `loadingItem`, ~15 lines. Ends the double tap on every cold start.
3. **`touch-1`** — commit the strip scrub on `pointerup`, ~20 lines. The Foray page's signature gesture works on a phone.
4. **`touch-2`** — non-passive `touchmove` on the sheet, ~15 lines. The founder's "drag the page down from the top" works from the artwork.
5. **`visual-1`** — one CSS escape. Every episode page.
6. **`visual-2`** — one `accent-color`. The only blue control is gone.
7. **`p-foray-1`** — same-source seams get no sting, ~5 lines. 13 of 21 jingles disappear from the only Foray a listener can play.
8. **`player-3`** — flush at hand-over, ~4 lines. Scrubs stop being thrown away.
9. **`search-2`** — invert the CTA gate, ~5 lines. Removes a guaranteed dead end under half of all searches.
10. **`search-5` + `search-6`** — the tab remembers the search; the index loads on any query, ~15 lines.
11. **`touch-3`** — `allowsLinkPreview: false`, 2 lines.
12. **`perf-2`** — 100 px art on rows, ~10 lines. Search costs hundreds of KB, not 5–10 MB.
13. **`nav-5`** — drawer scroll lock, ~8 lines.
14. **`p-impatient-1`** — nudge during load uses the resume point, ~8 lines.
15. **`p-car-3`** — do not pause an already-paused element; act on should-resume. ~20 lines and a device. Most felt in the car.

Deliberately not on the list despite being right: the privacy-policy reconciliation, the boot-path reorder, Dynamic Type, backups. Real, expensive, rarely felt.

---

## 3. FOUNDER QUESTIONS

Only true product, taste or spend calls. Everything else in the lane briefs carries a sensible default and ships without a ruling.

1. **Lock screen right-hand button** (`p-impatient-3`): with anything in Up Next iOS may draw ⏭ instead of 30↻. Skip pair always (Overcast/Pocket Casts; track commands only for headset/CarPlay), or the track pair when a queue exists? *Default: skip pair; verify on device which pair iOS actually draws first.*
2. **Auto-resume after a call or Siri** (`p-car-3`; round-1 Q2 still open). *Default: yes, guarded by the record's lag; ruling in DECISIONS either way.*
3. **Does a finished thing stay under Jump back in?** (`honesty-2`, `player-8`) Today a finished episode keeps a Played card for 30 days and a finished Foray vanishes. *Default: finished items leave Jump back in and say "Played — play again" on their own rows and pages.*
4. **Two playlist builders** (`p-first-6`): the drawer order is your 2026-09-03 call and is pinned. Make #/playlists the list only, one builder on Create? *Default: yes.*
5. **Dynamic Type** (`a11y-1`): the no-zoom ruling cited a compensation nothing implements. Spend a native card, or restore pinch? *Default: build the bridge; correct the DECISIONS sentence now.*
6. **Backups of the native Preferences copy** (`persist-6`): a restore re-attaches a deleted account. Token only to Keychain (this-device-only) and declare the rest backed up, or exclude the suite? *Default: token only, policy amended.*
7. **Privacy policy wording** (`persist-3`): three origins, Vercel as a processor, miss-only dropped. Drafted in L5; needs your sign-off because it is the legal text.
8. **"Start listening"** (`p-first-7`; round-1 Q11): rename, or make it true? *Default: "Show my picks" now.*
9. **Up Next model** (`p-impatient-7/8`): playing row k or ⏭ removes the rows above (Apple) rather than wrapping them back in? And drag / Play next / Clear now or later? *Default: remove-on-skip yes; the rest one follow-up card.*
10. **Sheet staples** (`p-switcher-5`): Up Next link and Save are cheap; a sleep timer is a feature. *Default: link + Save now, timer parked.*
11. **Relaunch destination in the shell** (`nav-10`): where you left, or Home? *Default: restore the route in the native shell only; the web keeps bare-URL-means-Home.*

---

## 4. LANE PLAN — eight lanes, every id in exactly one

Partitioned by file ownership so the three shared files (`app.js`, `styles.css`, `player/client.js`) are split by named region, not by topic. Full briefs (themes to promote, pitfalls, tests) are in the lane records; this is the map.

| Lane | Owns | Ids | Themes |
|---|---|---:|---|
| **L1-player-transport** | `player/client.js` render/status/seek/media-session regions (not the sheet region ~2480–2620, not `sDesc` ~1578, not the `row2`/`fp-row` builders ~800–880); `queue-state.js`, `queue-manager.js`, `html-audio-backend.js`, `media-session.js`, `playback-rate.js`; the 2-line `isCurrent` guard in `bindPlay` | 23 | R2-A, R2-B, R2-E, R2-F (clocks) |
| **L2-sheets-drawer-gestures** | client.js sheet region + `sDesc`; `sheet-drag-dismiss.js`; `strip-scrub-gesture.js` + app.js strip handlers (10220–10572); `openSheet` owner (5093–5300), first-run focus, drawer (11055–11112), inert helpers; Capacitor back registration; drawer/sheet-motion CSS only | 13 | R2-C, R2-D (gestures) |
| **L3-queue-and-native-surfaces** | app.js queue/continuous-playback region (1830–2140, 8500–8660, history writer, playlist header); client.js `row2`/`fp-row` builders; `mobile/plugins/foray-audio/**`, `foray-tts` Swift; Dynamic Type bridge; the DECISIONS platform contract | 18 | R2-M, R2-N (queue), R2-F (rows) |
| **L4-search-create-playlists** | app.js search/Create/Playlists regions, in-show search, the Search same-tab branch; `search-engine.js`; `api/episodes/search.ts`, `appleShowSearch.ts`; `tools/build-show-index.mjs` | 21 | R2-H, R2-G (search), R2-N (CTA) |
| **L5-boot-states-storage** | app.js init/boot, storage wait, sync/session, show-page state painters, `retryForayDocs`, bridge-null branch, Delete my data; `sw.js`, `index.html`, manifest tooling; `durable-store.js`, `idb-tier.js`, `diagnostic-log.js`, position pruning; `docs/legal/*`, data-safety; backup config | 24 | R2-G, R2-I, R2-J |
| **L6-navigation-firstrun-copy** | app.js router/landOnPage/pageDidPaint/scroll memory, tab bar (except Search branch), drawer toggles, onboarding picks and strings, interests renderer and thumbs nudge, formatting helpers, explicit badge; string literals anywhere (strings only); `listener-copy`, `format-helpers`, `toggle-labels` tests | 26 | K (cont.), R2-N (first run), R2-F (formatters), R2-L |
| **L7-styles-touch-visual** | `styles.css` entirely; `capacitor.config.json`; the smallest renderer flags for a class (page-head back, tag `inSection`, Shows eyebrow, interests heading, episode head, credits row, `q-num` ctx); `ui-tokens`, `tap-targets`, `card-anatomy`, `transport-controls` tests | 28 | R2-K, R2-D (sizes) |
| **L8-foray-surfaces** | app.js Foray page/list/Library/home-card renderers, credits resolution, `FORAY_ABOUT`, narrator constants; client.js `forayResumeList` and the Foray branch of the remaining labels; `foray-resolve.js` `estimated`; `interlude.js`; `segment-strip.js`; `data/forays.json` why-lines; Foray gates | 10 | R2-E (surfaces), R2-F (Forays), R2-L (Foray copy) |

**Merge order:** L7 and L8 first (CSS and Foray data are disjoint and the felt one-liners live there), then L1 (the player hook the others paint from), L2 and L3 in either order (they touch different client.js regions), L4, L5, L6 last (its string-only hunks rebase cleanly over everything). L1's `onStateSettled` is the one cross-lane dependency: L3's in-place Up Next repaint and L8's Played rows both read state it exposes — they can land before it with a media-event fallback and switch after.

**Standing rules for every lane, from round 1 and still true:** fixed means fixed with a test that fails without the fix and a suite floor; never run `format:write` repo-wide; a device-only confirmation is written into the row's note, not assumed; nothing in `docs/audit/status.tsv` moves to fixed without the PR number.

---

## 5. THE UNCERTAIN PILE

Three items need a device before the mechanism can be chosen, and the lane briefs say so:

- **Which pair the iOS lock screen draws** when both the skip commands and the track commands are enabled (`p-impatient-3`). The finding reasons from `MPRemoteCommandCenter` behaviour; a 30-second device check with two episodes queued settles it and decides between disabling the track commands and routing them through a CarPlay template.
- **Whether `el.pause()` during an OS interruption cancels the resume** (`p-car-3`). The record shows `interruptionEnded should-resume` and nothing after; the mechanism is inferred from the reconcile order. Take a 20 s call mid-episode with the record on.
- **Whether narration's `.spokenAudio` mode survives WebKit's own session management** (`native-10`) — set once at load and check with a Maps prompt.

One item is a measurement the lane must not skip: `p-first-1`'s simulation (200 boots per pick set with the app's own `buildCards`) should be re-run after the fix with real `Math.random`, and the acceptance test should assert the percentage, not the mechanism.

---

## 6. WHAT THIS AUDIT COULD NOT COVER

Stated plainly, as round 1 did, so 163 findings are not mistaken for completeness.

- **The device, still.** Round 2 added the two native shells to scope by reading Swift, Java and the shell JS; it did not run them. Every native finding is a reading of the code against the platform documentation. Real interruption handling, the lock screen's actual glyph pair, Android 12+ foreground-service refusals, WKWebView's session reset, notch and keyboard geometry, Bluetooth route changes — all still unobserved.
- **Performance beyond the numbers we could take in Node.** `primeVocabulary` (176 ms cold) and the boot dependency graph were measured on the committed data; the 3–5× phone multiplier is an estimate, and scroll jank, memory and battery on a real mid-range Android remain unmeasured.
- **The audio.** Whether the narration sounds right, whether the seams land now that 13 stings are proposed for removal, whether a stitched hour is worth an hour. No amount of code reading reaches this, and it is plausibly still the biggest determinant of whether 4a is good.
- **Assistive technology in use.** Every a11y finding is derived from markup and WebKit's documented behaviour. Nobody ran VoiceOver, TalkBack or Switch Control; real testing will contradict some severity calls.
- **The backend and the live network.** `api/`, auth, the sync pipeline's server side and the eight DELETEs were read, not exercised. Search latency and quality were reasoned from the committed index; Apple's directory and rate limits were not re-measured. The round-1 uncertain item — the browse pills as subject vs name search — is unchanged and still unmeasured.
- **The legal text against the law.** `persist-3` and `persist-6` compare the privacy policy to the code. Whether the reconciled text is adequate is a founder/legal call, not an audit finding.
- **Whether the round-1 fixes hold under real use.** Round 2 found 41 incomplete or second-order rows by reading; a listener will find the ones reading cannot. There is still no usage data and no support channel beyond the founder's own reports.
- **Whether the fixes will hold.** As in round 1: most of these 163 rows have no test pinning the correct behaviour today. The pattern that let `player-1` survive — the reconcile suite tests the reducer, the sheet suite tests the DOM, nothing tests that one moves the other — is the pattern to close first. Every lane brief names the suite each fix lands in.
