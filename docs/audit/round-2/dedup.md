# Round 2 — dedup

209 raw findings from 18 lenses. The dedup pass kept 172 unique findings, folded 30 duplicates into 26 of them, and dropped 7 that restated a round-1 verdict or contradicted a recorded ruling (172 + 30 + 7 = 209).

The kept id is the one that appears in `findings.tsv`; a merged finding's one-line claim survives in the kept finding's `duplicates` field in `findings-detail.md`.

## Clusters with merges (26)

| kept | merged | kept finding |
|---|---|---|
| player-1 | p-car-1 | Incomplete fix of persona 47/57/73 (and qa 39/40): at the natural end of an ordinary episode nothing repaints, so continuous playback never starts and the bar keeps saying Pause |
| native-1 | p-car-4 | Continuous playback on Android tears the foreground service down at every episode boundary and cannot bring it back with the screen off |
| p-impatient-4 | player-2 | Between the tap and the first audio, an ordinary episode shows nothing at all — the bar keeps '▶', the row keeps '▶', progress reads 0:00 and the full runtime, and there is no 'Loading…' |
| player-3 | p-car-7 | A scrub made while paused is thrown away by Stop or by playing something else (and switching episodes never flushes the outgoing one) |
| player-6 | p-switcher-3 | Dragging the Now Playing scrubber gives no live time readout — the clocks keep ticking the audio's position, not the thumb's |
| copy-5 | p-foray-10 | The mini bar's second line words a Foray two ways: "Now: <show> · clip 12 of 32" live, "Foray · clip 3 of 32" after a restart |
| nav-5 | touch-7, a11y-4 | The drawer is not modal: a drag on its scrim or on the (short) panel scrolls the page behind it, and there is no Escape, no focus move and no inert |
| visual-8 | visual-18 | Text fields on three radii and two heights (capsule / 16px / 12px) |
| visual-9 | p-first-9 | Tags restate the section they sit in (JUMP BACK IN under "Jump back in", FORAY under "Forays") and vanish where they would help |
| visual-10 | p-switcher-11 | Every episode list is numbered like a queue, including Saved, History, search results and a show's episodes |
| races-3 | p-impatient-9 | A playlist build that finishes after the listener left the page navigates them to the playlist from wherever they are — and on the Playlists page throws on a null note |
| search-6 | races-5 | A browse pill, a return via ‹, or a reload never loads the on-device show index — those searches run over the curated 220 only |
| p-impatient-2 | races-8 | Tap ▶ on row A, then quickly ▶ on row B: A is recorded as played — it enters History, counts toward a playlist's 'N played', and the playlist's next-up marker skips it |
| states-1 | p-switcher-6 | 136 of 220 curated shows silently end at 100 episodes with a blank subtitle and no way to reach the rest |
| states-11 | honesty-10 | An estimated Foray runtime is labelled 'about' on the Foray page but 'N min left' and a plain clock everywhere else (Jump back in, Now Playing sheet, lock screen) |
| copy-2 | honesty-9 | One listener reads four duration dialects on one row: "3h 5m" beside "185 min left" |
| p-foray-8 | copy-4 | Nothing before the Foray page tells you how long a Foray is, and the page shows the runtime in two formats |
| honesty-2 | copy-3 | A finished Foray leaves no trace anywhere — no 'Played', no bar, dropped from Jump back in and Library — while a finished episode says 'Played' on every row and stays in Jump back in for 30 days |
| honesty-3 | p-impatient-5, p-switcher-4 | Library → History is in first-play order, not last-played: replaying an old episode does not move it, so the 'most recent' list can lead with something played weeks ago |
| p-car-3 | native-9 | After a phone call or Siri in the car, 4a stays silent: the page's own reconcile pauses the element mid-interruption, which cancels the OS resume, and interruptionEnded is discarded |
| p-impatient-3 | native-4, p-car-2, p-switcher-1 | With anything in Up Next, the iOS lock screen may swap the founder's 30↻ for ⏭ — the 2026-09-23 steering-wheel 'next' fix enables nextTrackCommand at the same moment the 2026-09-23 15/30 fix relies on the skip commands being what the lock screen shows |
| native-5 | p-car-9 | iOS lock-screen timeline alternates between the source episode's clock (during tape) and the Foray clock (during narration/pause), and is draggable only in one of them |
| perf-2 | search-13 | The Search tab eagerly loads 167 six-hundred-pixel artworks into 44 px rows, with no lazy loading and no size variant |
| p-car-5 | p-switcher-8 | Steering-wheel ◀◀ on an ordinary episode never restarts it — it jumps to the previous list row, or is greyed out — unlike the Foray's own previous and every podcast app |
| p-car-6 | p-switcher-10 | At the end of the last episode with nothing queued, the lock screen and car go completely blank and every wheel button is dead — Apple keeps the finished episode paused and playable |
| p-first-11 | p-foray-11 | The now-permanent Foray explanation promises "a narrator between them" directly above the only Foray a newcomer can play, which has no narration; the returning-user popup adds a stretch Foray that cannot exist |

## Singletons (146)

touch-1, touch-2, touch-3, touch-4, touch-5, touch-6, touch-8, touch-9, touch-10, touch-11, player-4, player-5, player-7, player-8, player-9, player-10, player-11, visual-1, visual-2, visual-3, visual-4, visual-5, visual-6, visual-7, visual-11, visual-12, visual-13, visual-14, visual-15, visual-16, visual-17, a11y-1, a11y-2, a11y-3, a11y-5, a11y-6, a11y-7, a11y-8, a11y-9, a11y-10, a11y-11, races-1, races-2, races-4, races-6, races-7, states-2, states-3, states-4, states-6, states-7, states-8, states-9, states-10, states-12, nav-1, nav-2, nav-3, nav-7, nav-8, nav-9, nav-10, copy-1, copy-6, copy-7, copy-8, copy-9, copy-10, copy-11, copy-12, copy-13, copy-14, copy-15, persist-1, persist-2, persist-3, persist-4, persist-5, persist-6, persist-7, persist-8, persist-9, honesty-1, honesty-4, honesty-5, honesty-6, honesty-7, honesty-8, honesty-11, honesty-12, honesty-13, native-2, native-3, native-6, native-7, native-8, native-10, perf-1, perf-3, perf-4, perf-5, perf-6, perf-7, perf-8, perf-9, perf-10, search-1, search-2, search-3, search-4, search-5, search-7, search-8, search-9, search-10, search-11, search-12, p-car-8, p-switcher-2, p-switcher-5, p-switcher-7, p-first-1, p-first-2, p-first-3, p-first-4, p-first-5, p-first-6, p-first-7, p-first-8, p-first-10, p-first-12, p-impatient-1, p-impatient-6, p-impatient-7, p-impatient-8, p-impatient-10, p-impatient-11, p-foray-1, p-foray-2, p-foray-3, p-foray-4, p-foray-5, p-foray-6, p-foray-7, p-foray-12, p-foray-13

## Dropped before verification (7)

Kept here so they are not re-raised. Each one restates a refuted round-1 row or asks to reverse a recorded ruling without new evidence; reopening any of them is a founder question, not a defect.

- **states-5** — Restates qa 100 ('Home is a bare greeting when any data file fails to load — a success state with zero content'), which docs/audit/status.tsv marks REFUTED by the 2026-09-22 adversarial verifier and 'kept so it is not re-raised'. The evidence (renderHomeV2 helpers return "" on absence) is the same code shape the verifier already ruled on; no regression shown.
- **nav-4** — Contradicts docs/DECISIONS.md D3 (2026-09-10): the four-tab bar keeps 'tab state in the hash router', i.e. the lit tab is a function of the route, not of where the listener came from. qa 120/121/122 are fixed on exactly that per-route rule. The finding asks for origin-aware tab lighting and offers no evidence beyond the consequence D3 accepts (it concedes 'the pinned rule is per-route').
- **nav-6** — Contradicts D3 ('switching tabs is not a back step' — a tab hop is ordinary forward navigation composing with the real back-stack), pinned verbatim by test/back-navigation.test.js §9 ('‹ from a tab-reached page must call history.back() exactly once'). The finding itself says 'Deliberate per DECISIONS D3' and only offers an Apple Podcasts comparison; no new evidence.
- **p-switcher-9** — Same claim as nav-6 (tab-root pages carry a ‹): deliberate per DECISIONS D3 and test/back-navigation.test.js §9; qa 105/125 (back link on every page head) is the fixed round-1 row it sits beside. No regression or new evidence, only the Apple comparison.
- **p-car-10** — Contradicts the DECISIONS.md 2026-09-23 visual-pass ruling, which lists 'persona 10 (the mini bar's ↺15)' among the changes shipped 'on the founder's word'; status.tsv persona 10 is fixed with 'the mini bar carries a 44px borderless back-15 … founder ruling 2026-09-23'. The finding's own r1 note says 'that fix picked the direction'; only an Apple comparison is offered.
- **p-switcher-12** — Same as p-car-10: the mini bar's single skip being ↺15 (and its placement) is the founder-approved persona 10 design recorded in DECISIONS.md 2026-09-23; no new evidence beyond Apple's forward-30 layout.
- **p-foray-9** — Contradicts the DECISIONS.md 2026-09-14 continuous-playback ruling, whose 'What stays true' clause states 'A Foray is untouched: it has its own internal segment-advance machinery, and the player deliberately never reports ended for one'. qa 39 (fixed) already settled the end-state button as 'Start over'. The finding cites the same code fact the ruling records and no new evidence; re-opening it is a founder question, not a defect.
