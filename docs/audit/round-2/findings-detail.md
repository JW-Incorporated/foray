# Round 2 — full findings (2026-09-23)

One section per verified finding, in `findings.tsv` order. Each carries the finder's full record (title, file, line, severity, user_visible, evidence, why_subtle, fix_sketch, suspected_deliberate, relation_to_round1, duplicates) and the adversarial verifier's `verdict`, `verdict_severity` and `verdict_reasoning`. `merged_ids` names the raw findings the dedup pass folded into this one (their one-line claims are in `duplicates`). `lane` is the synthesis lane for a confirmed finding.

`file:line` is against origin/main 9730b5b (2026-09-23); check before trusting it on a later tree.

## player-1 — Incomplete fix of persona 47/57/73 (and qa 39/40): at the natural end of an ordinary episode nothing repaints, so continuous playback never starts and the bar keeps saying Pause

**confirmed** · verifier severity **high** (finder: high) · player · `player/client.js:2821` · L1-player-transport

```json
{
  "id": "player-1",
  "lens": "player",
  "title": "Incomplete fix of persona 47/57/73 (and qa 39/40): at the natural end of an ordinary episode nothing repaints, so continuous playback never starts and the bar keeps saying Pause",
  "file": "player/client.js",
  "line": 2821,
  "severity": "high",
  "user_visible": "An episode plays to its end in the car (screen off). Audio stops. The mini bar and the sheet keep showing ❚❚ / \"Pause\" with the thumb at 100%; the lock screen and the car keep saying PLAYING with the timeline extrapolating past the end; the next Up Next / list episode never starts. The first thing that repaints is an unrelated event (unlocking the phone → visibilitychange, or a native foreground event) — only then does the next episode begin. If the listener presses the bar's ❚❚ first, the press REPLAYS the finished episode from the top (`resume()` from `ended` → cold start → resumeOffset collapses the near-end row to 0) instead of advancing. Because the page never writes playbackState \"none\"/\"ended\", the 2026-09-23 iOS session model never reaches `(.playing, .ended) → releaseAndNotify`, so whatever app 4a interrupted is never told it may resume at the end of an episode either.",
  "evidence": "The only event-driven repaints are `backend.addMediaListener(\"timeupdate\", render); … (\"play\", render); … (\"pause\", render);` (client.js:2821-2823); the `ended` listeners at :2841-2848 only write a diag row and call `setBuffering(false)`, which returns early when unchanged. `_announceEpisodeEndedIfNeeded()` (client.js:983-992) runs only inside `render()` and requires `manager.state.type === \"ended\"`. Both engines fire the end-of-media events in the order timeupdate → pause → ended (the repo's own fake documents it: transport-reconcile.test.js:157-165 \"`pause` BEFORE `ended`\"), so every `render()` runs while the reducer still says `playing`; the reducer only moves to `ended` inside the `ended` listener (`_handleBackendItemEnded` → `handleItemEnded(playing, null)` → `[S.ended(), [emitTelemetry]]`, queue-manager.js:2112-2116, queue-state.js:388) with no pause/media effect that could produce another event. `reconcileOnReturn`'s own comment (client.js:2423-2429) names exactly this class (\"no event left to come and fix it\") but only handles the return-to-foreground case. test/up-next-autoadvance.test.js drives app.js with a FAKE ForayPlayer, so the real trigger is untested. Forays normally end via `_reachOutPoint` (html-audio-backend.js:896-911: `el.pause()` then `onItemEnded`, whose queued `pause` event repaints after the state moved), which is why they look fine — but a Foray whose last item is a spoken narration line (`_onTtsFinished`, no media event) or whose last clip's `end_sec` runs past the real audio (`outPoint.beyondDuration`) hits the same hole.",
  "why_subtle": "Every media event that exists fires BEFORE the state changes, and the code comments assume 'render() is driven by every media event'. In a desk test you tab away and back, which triggers the visibility reconcile that repaints — so it looks like it works. Only the screen-off car case, the founder's headline case, shows it.",
  "fix_sketch": "Give the surface a repaint when the machine settles without a media event: either `backend.addMediaListener(\"ended\", render)` in `ensureBooted` (cheap, but the reducer moves in a microtask after the backend's own `ended` listener runs first — so call `queueMicrotask(render)` or `Promise.resolve().then(render)` from that listener), or better, an `onStateSettled`/`onEnded` hook on `PlayerQueueManager` like `onSeamGapChange`, fired from `_handle` when `next.type === \"ended\"`, wired to `render`. Add a behavioural test on the real client.js with the reconcile suite's `runOut()` ordering asserting `onEpisodeEnded` fires and the bar paints ▶.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of persona 47 / 57 / 73 (continuous playback), and of qa 39 / qa 40 (the finished-state paints only happen if something repaints)",
  "duplicates": [
    "p-car-1: incomplete fix of persona 47/57: continuous playback never fires from a natural episode end — the bar and the car keep saying Pause/playing over silence until the phone is touched"
  ],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read origin/main at 9730b5b (#746, today) and the evidence holds.\n\n- **The only media-event repaints** are timeupdate, play and pause, wired with `render` at client.js:2821-2823.\n- **The `ended` listeners** at :2841-2848 do two things only. They call `diag.mediaEvent`. They call `setBuffering(false)`, and `setBuffering` (client.js:1643-1648) returns early when nothing changed. `buffering` was already cleared by the earlier `pause` event.\n- **At a natural end the order is timeupdate, then pause, then ended.** The backend's `_notePause` (html-audio-backend.js:1239-1248) says so itself: it returns early `if (this.el.ended)`. So the `pause` render runs while `manager.state.type` is still `playing`. `transportIsRunning()` is then true, and the bar paints ❚❚ / \"Pause\".\n- **The machine only moves to `ended` afterwards.** The backend's `_onEnded` (b.js:671-677) calls `onItemEnded(END_NATURAL)`. That goes to `_handleBackendItemEnded`, which dispatches `itemEnded(null)`. The reducer's `handleItemEnded` for `playing` with no next item returns `[S.ended(), [emitTelemetry(\"queue.ended\")]]` (queue-state.js:388). That emits no media effect.\n- **Nothing in `_handle` (q.js:896-913) calls back to the surface.** `_syncTimer` only stops the persist interval. The manager's only surface hooks are `onSeamGapChange` and `onNarrationTick`, and neither fires here.\n- **The Up Next signal is stranded too.** `_announceEpisodeEndedIfNeeded` (client.js:983-992) runs only from `render()` (client.js:1501) and needs state `ended`. So `onEpisodeEnded` (continuous playback), the ▶ glyph and `syncMediaSession` all wait for some unrelated later event, such as `visibilitychange` or a native event.\n- **Ordinary episodes don't get the Foray escape route.** They carry no `end_sec`, so no out-point is armed and `_reachOutPoint`'s own `pause` repaint never happens.\n- **`HtmlAudioBackend` is the only backend** (client.js:2679), so no native engine behaves differently.\n- **No docs/DECISIONS.md ruling covers this, and nothing in the tree fixes it.** The founder ruling of 2026-09-14 quoted at client.js:2862-2865 actually requires continuous playback.\n- **Screen-on is affected too**, because no `timeupdate` fires after `ended`.\n\nI did not trace every step of the claim that pressing the button replays from the top. It is plausible: after `ended`, `transportIsRunning()` is false, so the press takes the play/resume branch. I also did not trace the iOS session-release consequence. Neither changes the verdict. The core defect is real and hits the main listening path: an episode plays to its end and the next never starts.",
  "merged_ids": [
    "p-car-1"
  ],
  "lane": "L1-player-transport"
}
```

## native-1 — Continuous playback on Android tears the foreground service down at every episode boundary and cannot bring it back with the screen off

**uncertain** · verifier severity **medium** (finder: high) · native · `mobile/plugins/foray-audio/web/foray-audio-shell.js:660`

```json
{
  "id": "native-1",
  "lens": "native",
  "title": "Continuous playback on Android tears the foreground service down at every episode boundary and cannot bring it back with the screen off",
  "file": "mobile/plugins/foray-audio/web/foray-audio-shell.js",
  "line": 660,
  "severity": "high",
  "user_visible": "Android, screen off, continuous playback (now ON by default): when episode 1 ends, the media notification and lock-screen controls vanish; episode 2 starts playing but the notification never comes back (Android 12+), so the rest of the drive has no lock-screen pause/skip and the process is unprotected. On Android <12 the notification blinks out and back at every boundary instead.",
  "evidence": "player/client.js render() runs `syncMediaSession()` (line 1496) BEFORE `_announceEpisodeEndedIfNeeded()` (line 1501), so the `ended` payload is flushed first. foray-media-session.js:479-481 `isTransportable(payload)` is `playing || paused`, so `ended` is not loaded; flush() then calls `onLoadedChange(false)` (758-767). foray-audio-shell.js:660-669 `setMediaLoaded(false)`: \"A FALSE STOPS AT ONCE, with no settle window ... after a close there is no `play()` coming that the listener did not ask for from a foreground screen\" -> `cancelStop(); requestStop();`. app.js:2160-2176 `advanceQueueOnEnded` -> `startChained` -> `ForayPlayer.play(next)` then issues `play()` -> `ensureStarted()` -> `callAndRecord(\"start\")` queued behind the stop; ForayAudioPlugin.java:168 `startForegroundService` from a hidden page is exactly the background start the header (lines 31-36, 306-314) says Android 12+ refuses, leaving `startAccepted=false` and every later play() re-issuing a refused start.",
  "why_subtle": "Every piece is individually correct and documented; the `ended = not loaded` rule (foray-media-session.js:86-92) was written when product principle 1 was 'no autoplay chains'. Round 1 flipped continuous playback ON by default (persona 47/57) without revisiting the shell's lifetime rule, so the failure only appears on Android, only with the screen off, only after the first episode ends.",
  "fix_sketch": "Treat `ended` as loaded for the shell (or keep the settle window for the ended->idle transition instead of stopping at once): in `setMediaLoaded(false)` only stop immediately when the payload state is `idle` (player closed); for `ended` arm the normal 25 s settle window so a chained `play()` finds the service still up. Alternatively have client.js report the next item before announcing `ended` (call `_announceEpisodeEndedIfNeeded()` before `syncMediaSession()` and let the new item's `paused` payload land first).",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order regression of persona 47 / persona 57 (continuous playback ON by default) against the #27 shell lifetime; not previously reported.",
  "duplicates": [
    "p-car-4: latent, unmasked by fixing finding 1: on Android the foreground service is stopped at once on `ended`, so the continuous-playback episode that follows starts unprotected and without a notification"
  ],
  "verdict": "uncertain",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main at 9730b5b. The teardown mechanism is in the code as described, but the user-visible symptom as written (\"episode 2 starts playing with the screen off, and the notification never comes back\") depends on an earlier step that does not normally happen at origin/main. So the defect is real but latent, not a high-severity bug users hit today.\n\nWhat holds:\n- The shell stops the service immediately. foray-audio-shell.js:660-669 `setMediaLoaded(false)` runs `cancelStop(); requestStop();` with no settle window whenever `activeCount()===0`. An ended element is pruned by `activeCount()`, so that count is 0 at an episode end.\n- `ended` counts as not loaded. foray-media-session.js:479-481 `isTransportable` is `playing||paused` only. `transportState` maps playbackState \"none\" to \"ended\" (line 397), and `flush()` calls `onLoadedChange(false)` after sending (lines 752-765).\n- The order inside `render()` is as claimed. client.js:1496 `syncMediaSession()` runs before 1501 `_announceEpisodeEndedIfNeeded()`, and the flush is a microtask (line 585). The next episode's play is synchronous up to `await manager.play(0)`: `setNowPlaying` and `setQueueFromPick` do not call `media.update`, and `render()` only runs after the await. So the queued flush still reads playbackState \"none\", reports not-loaded, and the stop goes out before the chained `play()` issues its start. If that chain runs while the page is hidden on Android 12+, the start is a background `startForegroundService`, which the header says is refused.\n\nWhat fails (reachability):\n- `_announceEpisodeEndedIfNeeded` runs only from `render()`.\n- `render()` is wired to the `timeupdate`, `play` and `pause` element events (client.js:2821-2823), plus the change-triggered `setBuffering` (2846-2848). It is not wired to `ended`.\n- On a natural end the element fires timeupdate, then pause, then ended, in that order. The manager only becomes `ended` inside the `ended` handler (html-audio-backend `_onEnded` -> `_handleBackendItemEnded` -> `_handle`, which sets the state synchronously and does not repaint). `setBuffering(false)` on `ended` only repaints if buffering was true.\n- So no render sees the `ended` state at the boundary. The media session stays \"paused\", the shell stays loaded, the service stays up, and continuous playback does not advance at all while hidden.\n- The advance happens on the next render, normally `reconcileOnReturn` when the page becomes visible again. There the stop-then-start does happen, but `startForegroundService` comes from a visible page and succeeds: at most a brief blink of the notification.\n- The hidden-page renders that could reach the described path are rarer: a native `interruptionBegan`, or a `routeChange` \"old-device-gone\" -> `manager.routeChanged().then(render)` (client.js:449-462). Only these can fire the announce, and the chained play, while the screen is off. Then the notification is lost exactly as described.\n\nThis matches the finding's own duplicate note (p-car-4): \"latent, unmasked by fixing finding 1\". Fixing the missing render on `ended` would turn this into the high-severity bug described.\n\nI found no ruling in DECISIONS.md that covers it: the shell comment's reason for the immediate stop (\"after a close there is no play() coming\") simply did not foresee `ended` being followed by an automatic play. It has not been fixed at origin/main.\n\nRecommendation: fix it together with the missing-render-on-ended fix. Keep the settle window for `ended` and stop immediately only for `idle`, or announce the end before syncing the media session.",
  "merged_ids": [
    "p-car-4"
  ],
  "lane": null
}
```

## p-impatient-4 — Between the tap and the first audio, an ordinary episode shows nothing at all — the bar keeps '▶', the row keeps '▶', progress reads 0:00 and the full runtime, and there is no 'Loading…'

**confirmed** · verifier severity **medium** (finder: medium) · p-impatient · `player/client.js:1456` · L1-player-transport

```json
{
  "id": "p-impatient-4",
  "lens": "p-impatient",
  "title": "Between the tap and the first audio, an ordinary episode shows nothing at all — the bar keeps '▶', the row keeps '▶', progress reads 0:00 and the full runtime, and there is no 'Loading…'",
  "file": "player/client.js:1456-1461 (render glyph), 1643-1667 (setBuffering/paintStatus only when transportIsRunning)",
  "line": 1456,
  "severity": "medium",
  "user_visible": "Tap ▶ on a show-page row over a cold connection. For 1-5 s the row still says ▶, the mini bar slides up saying ▶, 0:00 and e.g. '-1:12:00' (for an episode you were 38 min into). Nothing spins, nothing says loading. The impatient user taps ▶ again (a no-op: `handlePlay` loadingItem same-ref), then a third time, at which point audio has started and the third tap pauses it.",
  "evidence": "`render()` paints `running ? '❚❚' : '▶'` where `running = transportIsRunning()` = `isPlaying() || inSeamGap || elementIsAudible`; `loadingItem` is none of those. `setBuffering(on)` is `Boolean(on) && transportIsRunning()`, so `waiting` during the initial load never sets the Buffering… line; `paintStatus` has only failure and buffering states. `syncCardButtons` uses the same `running`. The Foray page has its own 'Loading…' (qa 75); the episode surfaces have none. The position painted is `backend.currentTime` = 0 until `loadedmetadata` applies the offset (backend 1575), so the bar also shows an empty fill and the whole duration left.",
  "why_subtle": "Round 1 made the glyph honest (persona 15: never say playing before audio exists) and added Buffering… for mid-stream stalls (persona 5). The gap between them — the initial load — is a state the transport does have (`loadingItem`) but paints as 'paused'. Combined with finding 1 the second tap is exactly where the resume point gets lost.",
  "fix_sketch": "Add a third status: when `manager.state?.type === 'loadingItem'` (and not `restoredPending`), paint `ui.err`/`ui.sErr` with 'Loading…' and set `aria-busy`/a spinner class on the bar and on the current row's button (`data-loading='1'`); paint the position from `positionReader().resumeOffset(current.id)` while the element does not yet hold this item (`manager.playheadItemId !== current.id`).",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of persona 15 and persona 5 (the honest glyph left the load window with no state at all).",
  "duplicates": [
    "player-2: Pressing play shows no loading state anywhere: the bar, the sheet and the card keep saying ▶ Play for the whole cold load"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read player/client.js at origin/main and the evidence holds. render() at about line 1456 paints `running ? \"❚❚\" : \"▶\"`, with running = transportIsRunning() = isPlaying() || inSeamGap || elementIsAudible (lines 1033/1063). isPlaying() is true only for 'playing' or 'transitioning', so a plain loadingItem paints ▶ on the bar and on bigPlay. syncCardButtons (line 1519) uses the same `running`, so the row also keeps ▶. setBuffering (line ~1643) is `Boolean(on) && transportIsRunning()`, so a `waiting` event during the first load never sets Buffering…. paintStatus shows only the failure line or the buffering line; there is no loading state. A git grep of origin/main for 'Loading…', aria-busy and data-loading finds loading states only on the Foray page (app.js 10787 via the snapshot's `loading` flag) and on page and list loads. Nothing covers the mini bar, the sheet or the episode rows. docs/DECISIONS.md has no ruling on episode loading states. The only deliberate 'no Loading…' comment is about the Foray seam beat, which does not apply here. episodePositionSec() reads backend.currentTime unless restoredPending is set, so the 0:00 or empty-fill claim during a fresh load is plausible (the element has just been given a new src). I did not trace the exact tap-count sequence in the repeat-tap scenario (no-op, then pause), and it is speculative, but the main defect stands: the episode surfaces show no loading state between the tap and the first audio. Severity is medium: the app works, but on a cold connection it gives no feedback, which invites repeated taps.",
  "merged_ids": [
    "player-2"
  ],
  "lane": "L1-player-transport"
}
```

## player-3 — A scrub made while paused is thrown away by Stop or by playing something else (and switching episodes never flushes the outgoing one)

**confirmed** · verifier severity **medium** (finder: medium) · player · `player/queue-state.js:578` · L1-player-transport

```json
{
  "id": "player-3",
  "lens": "player",
  "title": "A scrub made while paused is thrown away by Stop or by playing something else (and switching episodes never flushes the outgoing one)",
  "file": "player/queue-state.js",
  "line": 578,
  "severity": "medium",
  "user_visible": "Pause an episode at 10:00, drag the sheet's scrubber to 30:00 while it is paused, then tap a different episode (or press Stop, or let the car's next-track fire). The Jump back in card says the first episode has \"50 min left\" at 10:00, and resuming it from the ribbon starts at 10:00, not 30:00. The same happens if you scrub back to re-hear something and then leave. Even without a scrub, leaving a PLAYING episode for another one records a position up to 10 s stale.",
  "evidence": "`handleSeek` in `interrupted` emits `[F.savePosition(), F.seekTo(seconds, precise)]` — the save is of the position being LEFT (queue-state.js:574-578). Nothing writes after the seek while paused: `_persistIfDue` returns unless `state.type === \"playing\" || this.elementIsAudible` (queue-manager.js:2177), and `handleStop` from `interrupted` emits no `savePosition` (queue-state.js:622-623), nor does `handlePlay` from `interrupted` or `playing` (`[loadItem]` / `[pausePlayback, loadItem]`, queue-state.js:315-336). `ForayPlayer.play()` replaces the queue (`manager.setQueueFromPick(item)`, client.js:2931) before `manager.play(0)`, so the outgoing item is no longer `_currentItem()` and `_persistPosition` can never run for it; `stopAndClose` flushes only the Foray store (`persistForayProgress`, client.js:2090) before `manager.stop()`. Only `flushPositions()` (pagehide/visibilitychange, :2372-2398) calls `manager._persistPosition()` directly, which is why closing the app does keep the scrub and switching episodes does not.",
  "why_subtle": "The `savePosition`-before-`seekTo` ordering was written for corner case #17 (playing) and reads as careful; the paused branch shares it. The founder's 2026-09-22 'jumped backwards' fix (`resumingInPlace`) covered pause→scrub→PLAY, so the same gesture followed by any other action feels like it should be covered too.",
  "fix_sketch": "Flush the outgoing episode at every hand-over: in `ForayPlayer.play()` call `manager._persistPosition()` (as `flushPositions` does) before `setQueueFromPick`, and in `stopAndClose()` before `manager.stop()`. Optionally make `_persistIfDue` also write on the element's `seeked` event while paused (the element's clock is about this item — `_loadedId === item.id` — so the #689 fabricated-position guard still holds). Pin with a transport-reconcile test: pause, seek, play another item, assert the store holds the seeked position.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order to the #689 resume changes (transport-reconcile part 4 covers scrub-then-play only)",
  "duplicates": [
    "p-car-7: A lock-screen scrub or ↺15 while paused stores the position from BEFORE the seek; if iOS evicts the app you resume one seek stale"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main 9730b5b, and every part of the evidence holds.\n\n1. **The save on a paused seek records the old position.** In `player/queue-state.js`, `handleSeek` (about lines 574-578) returns `[F.savePosition(), F.seekTo(...)]` for both `playing` and `interrupted`. The save runs before the seek, so it stores the position being left, not the new one.\n\n2. **Nothing writes the new position while paused.** `_persistIfDue` in `queue-manager.js` (about line 2177) returns early unless `state.type === \"playing\"` or `elementIsAudible`. The only media listeners are `timeupdate`, `playing` and `pause`; there is no `seeked` hook. The 15 s timer and the 10 s delta both only run while audio is playing.\n\n3. **Stop does not save from a paused state.** `handleStop` returns no `savePosition` for `interrupted` (the default branch, about lines 622-623). It does save from `playing` and `transitioning`.\n\n4. **Playing something else does not save the outgoing episode.** `handlePlay` returns `[loadItem]` from `interrupted` and `[pausePlayback, loadItem]` from `playing`, with no `savePosition` in either.\n\n5. **The outgoing episode cannot be saved after the switch.** In `client.js`, `ForayPlayer.play()` (about line 2931) calls `manager.setQueueFromPick(item)` before `manager.play(0)`. That replaces the queue and sets `currentIndex` to -1, and `play()` then points `currentIndex` at the new item. From then on `_currentItem()` is never the old episode. The only flush on that path is `persistForayProgress`, which covers the Foray store, not episode positions.\n\n6. **Stop and close does not flush episode positions either.** `stopAndClose` (about line 2087) calls `persistForayProgress({force:true})` and then `manager.stop()`, with no `manager._persistPosition()`.\n\n7. **Closing the app is different.** Only `flushPositions()` (about line 2387) calls `manager._persistPosition()` directly, on pagehide/visibilitychange and native session events. That is why backgrounding keeps a scrub but switching episodes or pressing Stop does not.\n\n**What the listener sees.** Pausing saves 10:00 (`handleInterruptionBegan` emits `savePosition`). A scrub to 30:00 while paused is never written. After that, Stop or playing another episode leaves the stored row at 10:00. Leaving an episode that is still playing loses up to about 10 s, the gap `POSITION_MIN_DELTA_SEC` allows.\n\n**Already fixed or deliberate?** No. The #689 comment in `_loadItem` openly describes the pre-seek save, but its only fix is to resume from the player's own clock when the same item is played again. That does nothing for switching away or stopping. docs/DECISIONS.md has no ruling that covers this.\n\n**Severity: medium.** It silently loses the resume point on ordinary actions, but only by the size of the scrub or a few seconds, and the app does not crash.",
  "merged_ids": [
    "p-car-7"
  ],
  "lane": "L1-player-transport"
}
```

## player-6 — Dragging the Now Playing scrubber gives no live time readout — the clocks keep ticking the audio's position, not the thumb's

**confirmed** · verifier severity **medium** (finder: medium) · player · `player/client.js:2615` · L1-player-transport

```json
{
  "id": "player-6",
  "lens": "player",
  "title": "Dragging the Now Playing scrubber gives no live time readout — the clocks keep ticking the audio's position, not the thumb's",
  "file": "player/client.js",
  "line": 2615,
  "severity": "medium",
  "user_visible": "Open the sheet and drag the scrubber. The thumb follows your finger, but the elapsed clock on the left and the countdown on the right keep counting the audio that is still playing; only on release do they jump to where you landed. You cannot aim for '32:00' — you have to release and see. Apple Podcasts shows the target time as you drag. VoiceOver users get the same mismatch: `aria-valuetext` is rewritten on every tick from the live position, not the thumb.",
  "evidence": "`ui.scrub.addEventListener(\"input\", () => { scrubbing = true; });` (client.js:2615) sets a flag and nothing else; `render()` skips only the thumb/fill while scrubbing (`if (!scrubbing) { … }`, :1479-1483) but still writes `ui.tNow.textContent = … pos …`, `aria-valuetext` and `ui.tLeft` from `pos = episodePositionSec()/forayPosition()` (:1484-1491) at 4 Hz. The seek happens only on `change` (:2616-2626).",
  "why_subtle": "The seek itself is correct and instantaneous on release, so the control 'works'; the missing feedback is only felt when trying to land somewhere specific — exactly the details-level wrongness the founder describes.",
  "fix_sketch": "On `input`, compute `const dur = foray ? foray.resolved.totalSec : episodeDurationSec(); const at = (Number(ui.scrub.value)/1000) * (dur || 0);` and paint `tNow`, `tLeft` (`remainingClock(dur - at)`) and `aria-valuetext` from `at`; in `render()` skip those three writes while `scrubbing`. Optional: a small time bubble above the thumb.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; qa 2 fixed the touch-action on `.fp-scrub` but not the readout",
  "duplicates": [
    "p-switcher-3: Scrubbing the Now Playing slider does not move the time labels until the thumb is released"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked origin/main's player/client.js and the finding holds. At line 2615 the handler is `ui.scrub.addEventListener(\"input\", () => { scrubbing = true; });` and it only sets the flag. In render(), `if (!scrubbing) {...}` at lines 1479-1483 guards only the scrub value and the fill width. The next lines, 1484-1491, write ui.tNow, aria-valuetext and ui.tLeft on every tick from `pos = foray ? forayPosition() : episodePositionSec()`, which is the playing audio's position, not the thumb's. The seek runs only in the `change` handler at lines 2616-2626. So while you drag, the thumb moves but both clocks and the VoiceOver value keep following playback, and they only jump to the target when you let go. Nothing else touches these labels during a drag. docs/DECISIONS.md has no ruling about the scrubber, so this is not deliberate. It is not a crash or data bug, so medium fits: you cannot land on a chosen time, and screen-reader users get the same wrong value.",
  "merged_ids": [
    "p-switcher-3"
  ],
  "lane": "L1-player-transport"
}
```

## copy-5 — The mini bar's second line words a Foray two ways: "Now: <show> · clip 12 of 32" live, "Foray · clip 3 of 32" after a restart

**confirmed** · verifier severity **low** (finder: low) · copy · `player/client.js:1180` · L1-player-transport

```json
{
  "id": "copy-5",
  "lens": "copy",
  "title": "The mini bar's second line words a Foray two ways: \"Now: <show> · clip 12 of 32\" live, \"Foray · clip 3 of 32\" after a restart",
  "file": "player/client.js",
  "line": 1180,
  "severity": "low",
  "user_visible": "While a Foray plays, the bar's second line reads \"Now: Acquired · clip 12 of 32\". Kill and reopen 4a and the same bar for the same Foray reads \"Foray · clip 12 of 32\" until you press play, then flips to the \"Now:\" form. No other surface uses a \"Now:\" prefix.",
  "evidence": "forayNowPlaying(): `const show = item.show ? `Now: ${item.show}` : \"Now playing\"; … show: `${show} · clip ${index + 1} of ${total}`` (1177-1180). restoreForay(): `show: at ? `Foray · clip ${at.index + 1} of ${total}` : \"Foray\"` (3049). Ordinary episodes put the bare show name on this line (setNowPlaying).",
  "why_subtle": "The two strings are written 1,900 lines apart for the same element and each is fine alone; only the restore-then-play sequence shows the flip.",
  "fix_sketch": "One builder for the Foray second line used by both paths: `${item.show || \"4a's narrator\"} · clip N of M` (no \"Now:\" — the bar is already the now-playing bar), with restoreForay reading the show from the resolved item at `at.index`.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order of persona 7 (restored Foray on the ribbon) and qa 145 (clip vocabulary)",
  "duplicates": [
    "p-foray-10: The mini bar's Foray subtitle truncates away its one useful fact, and the restored bar uses a different format from the live bar"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Checked at origin/main 9730b5b, player/client.js. forayNowPlaying() (1173-1184) builds the live second line as `Now: ${item.show}` (or \"Now playing\" when there is no show) plus ` · clip ${index + 1} of ${total}`. restoreForay() (3034-3056) sends setNowPlaying the line `Foray · clip ${at.index + 1} of ${total}` (or just \"Foray\"). So after a restart the restored bar says \"Foray · clip N of M\", and after the first press playForay repaints it in the \"Now: <show>\" form. The live format was chosen on purpose: the doc comment at 1166-1172 says it follows the mockup's `Now: <show name>` second line. The restore format has no explanation, though, and nothing ties the two together. The restore path also drops the show name even though resolved.playable[at.index] has it. docs/DECISIONS.md has no ruling on the \"Now:\" prefix or the restored-bar wording. Its only mini-bar hits (lines 106-107) are about the skip button and transport redesign, not this subtitle. The only other \"Now playing\" string (line 1515) is a different control label. So the mismatch is real and a user sees it, but it is cosmetic and lasts only until they press play. It duplicates p-foray-10.",
  "merged_ids": [
    "p-foray-10"
  ],
  "lane": "L1-player-transport"
}
```

## nav-5 — The drawer is not modal: a drag on its scrim or on the (short) panel scrolls the page behind it, and there is no Escape, no focus move and no inert

**confirmed** · verifier severity **medium** (finder: medium) · nav · `styles.css:11055` · L2-sheets-drawer-gestures

```json
{
  "id": "nav-5",
  "lens": "nav",
  "title": "The drawer is not modal: a drag on its scrim or on the (short) panel scrolls the page behind it, and there is no Escape, no focus move and no inert",
  "file": "styles.css:528-543 (#drawer-overlay / #drawer), app.js:11055-11059 (openDrawer), app.js:11106-11112 (bindDrawerChrome), styles.css:1975 (contrast: body.fp-expanded { overflow: hidden })",
  "line": 11055,
  "severity": "medium",
  "user_visible": "Open ☰ on a long page and drag anywhere on the dimmed area, or on the drawer itself when its content fits the screen: the page underneath scrolls. Close the drawer and you have lost your place. On desktop, Escape does nothing and Tab leaves the drawer into the page behind it.",
  "evidence": "`#drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: var(--z-drawer); }` — no touch-action, no overscroll-behavior; `#drawer { position: fixed; ... overflow-y: auto; }` — no overscroll-behavior: contain, so a non-scrollable panel chains the gesture to the document. openDrawer only toggles `hidden` on the two elements; no body class, no `inert` on #view/#tab-bar (compare inertOutside at app.js:4917 for sheets), and the only keydown handlers are the sheet trap and the search field. Every sheet, by contrast, locks the body (`body.fp-expanded { overflow: hidden }`) and carries `overscroll-behavior: contain` (styles.css:1957, 2012).",
  "why_subtle": "The drawer is over everything (z 80/81) so it looks modal; the scroll-through only shows when a thumb rests on the scrim while deciding, and the lost scroll position surfaces later as 'the page moved'.",
  "fix_sketch": "On open add `body.drawer-open { overflow: hidden }` (mirror of fp-expanded), give `#drawer { overscroll-behavior: contain }` and `#drawer-overlay { touch-action: none }`, move focus to the first drawer link, close on Escape, and mark #view/#tab-bar/#foray-player `inert` while open (reuse inertOutside/releaseInert). test/drawer-ownership.test.js can pin the body class and Escape.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; qa 70 (focus/trap/Escape) was fixed for sheets only.",
  "duplicates": [
    "touch-7: The drawer never locks the page: a vertical drag on the dimmed overlay scrolls the page behind it, and the drawer's own scroll chains into the page",
    "a11y-4: The drawer is a modal in every visual sense and in no accessible sense: ☰ has no aria-expanded/aria-controls, opening it moves no focus, closing it returns none, Escape does not close it, and it is one of two unnamed <nav> landmarks"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the files at origin/main after a fresh fetch, and the finding holds. In styles.css, #drawer-overlay (lines 528-532) has only position:fixed, inset:0, a background and a z-index. It has no touch-action or overscroll-behavior. #drawer (533-543) has overflow-y:auto but no overscroll-behavior:contain.\n\nNothing stops the page behind from scrolling. The document body is the scroller: the .home comment says \"body scroll is already live\" and #view has no overflow of its own. The only body scroll locks are body.fp-expanded (1975) and body.fy-sheet-open (2901), and neither applies to the drawer. So a drag on the fixed scrim goes to the document, and so does a drag on a drawer panel too short to scroll.\n\nopenDrawer in app.js (11055-11059) only sets `hidden` on the two elements and calls renderDrawer(). It adds no body class, moves no focus and sets no inert. bindDrawerChrome (11106-11112) binds three click handlers: the ☰ toggle, the overlay close, and the capture-phase onDrawerAction. There are three keydown listeners in app.js: the search input (3093), the sheet trap onSheetKeydown (5107) and one inside a choice control (12211). None of them closes the drawer on Escape. index.html has a bare `<nav id=\"drawer\" hidden>` and a menu button with only aria-label=\"Menu\".\n\ndocs/DECISIONS.md on 2026-09-23 only covers the drawer closing when an item is used ('the drawer leaves when used'). It says nothing that makes the missing scroll lock or keyboard handling deliberate. The recent drawer work (onDrawerAction, the z-index move) did not add either one.\n\nSeverity is medium. The page scrolling behind the drawer is real on touch devices and loses the user's place. The missing Escape, focus move and inert are accessibility and desktop gaps. Nothing breaks, and the drawer still closes when tapped.",
  "merged_ids": [
    "touch-7",
    "a11y-4"
  ],
  "lane": "L2-sheets-drawer-gestures"
}
```

## visual-8 — Text fields on three radii and two heights (capsule / 16px / 12px)

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:857` · L7-styles-touch-visual

```json
{
  "id": "visual-8",
  "lens": "visual",
  "title": "Text fields on three radii and two heights (capsule / 16px / 12px)",
  "file": "styles.css",
  "line": 857,
  "severity": "low",
  "user_visible": "The Search field is a 46px capsule; Create's and Playlists' fields are 52px rounded rectangles with 16px corners beside a capsule button (create.png, playlists.png); the first-run typed-subject input, the feedback note and the Delete-my-data confirm are ~40px boxes with 12px corners.",
  "evidence": "`#sh-compose #sh-form { border-radius: var(--radius-pill) }` (1729-1745) and `#sh-input { min-height: 46px }` (1758-1767); `#cr-input`, `#pl-input` `{ min-height: 52px; border-radius: var(--radius-lg) }` (890-900, 842-852); `.show-ep-search input { min-height: 48px; border-radius: var(--radius-lg) }` (3161-3171); `.ft-typed-input`, `#fy-sheet-note`, `.dd-input` `{ padding: 10px 12px; border-radius: var(--radius-md) }` (2968-2976, 3019-3027, 3302-3310). The comment at 857-860 justifies the lg field \"as Search's pill-beside-field already does\" — Search's field became a capsule itself on 2026-09-13, so the justification is stale.",
  "why_subtle": "No two of these fields are on the same screen, so each reads as 'the field' until you type in three of them in a row.",
  "fix_sketch": "One field rule: `--radius-lg`, ≥48px, `--fs-lg`, for every `input[type=text]`/textarea in a page or sheet (or capsules everywhere, which is what Apple's fields are); keep only the floating search capsule special.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends qa 60 (radius scale) — the scale exists, but inputs read three steps of it",
  "duplicates": [
    "visual-18: Voice-picker 'Preview' button uses the card radius (16px) on a ~31px control — neither pill nor control radius"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked every cited rule in origin/main styles.css (3917 lines), and the evidence holds as written.\n\n- **Search:** `#sh-compose #sh-form` has `border-radius: var(--radius-pill)` (L1729-1745). `#sh-compose #sh-input` has `min-height: 46px` with its own box removed (L1758-1767).\n- **Playlists and Create:** `#pl-input` (L842-852) and `#cr-input` (L890-900) are 52px tall with `--radius-lg` (16px).\n- **Episode search:** `.show-ep-search input` is 48px tall with `--radius-lg` (L3161-3171).\n- **Small fields:** `.ft-typed-input` (L2968), `#fy-sheet-note` (L3019) and `.dd-input` (L3302) all use `padding: 10px 12px`, `--radius-md` (12px) and `--fs-md`. With no min-height set, they come out at about 40px.\n- **Stale comment:** the comment at L857-860 says the field keeps `--radius-lg` \"as Search's pill-beside-field already does\". Search's field is now inside the capsule, so that justification no longer holds.\n\nI found no ruling that covers this. The 2026-09-23 entry in docs/DECISIONS.md approves \"a radius scale\" defined by the `:root` tokens, and that scale's own comment (L36) says `--radius-lg: 16px; /* cards, rows, inputs, panels inside a sheet */`. The three `--radius-md` inputs therefore break the approved scale rather than being covered by it; `--radius-md` is documented for \"buttons and controls\". No test in ui-tokens or card-anatomy pins input radii; the L613 test covers only violet buttons. The inconsistency is still there, so it has not been fixed.\n\nUsers do see it, but it is minor. The fields sit on different screens and in sheets, so the 16px/12px mismatch is subtle. The floating search capsule is arguably a deliberate special case. The real defect is the three 12px, ~40px inputs that go against the token scale's \"inputs = lg\" rule. Severity: low.",
  "merged_ids": [
    "visual-18"
  ],
  "lane": "L7-styles-touch-visual"
}
```

## visual-9 — Tags restate the section they sit in (JUMP BACK IN under "Jump back in", FORAY under "Forays") and vanish where they would help

**confirmed** · verifier severity **low** (finder: low) · visual · `app.js:7752` · L7-styles-touch-visual

```json
{
  "id": "visual-9",
  "lens": "visual",
  "title": "Tags restate the section they sit in (JUMP BACK IN under \"Jump back in\", FORAY under \"Forays\") and vanish where they would help",
  "file": "app.js",
  "line": 7752,
  "severity": "low",
  "user_visible": "Home's \"Jump back in\" section holds one card whose first line is an amber JUMP BACK IN tag; the Forays page (title \"Forays\") lists rows each wearing a violet FORAY tag; the Library's Forays section shows the same Foray as a plain row with a chevron and no tag, and Home's Forays-for-you card shows a strip and no tag. (mini-bar.png, forays.png, library.png)",
  "evidence": "app.js:7752 `<span class=\"hv2-jbi-kicker\">Jump back in</span>` inside the section titled by `.hv2-title` \"Jump back in\"; app.js:10917 `<span class=\"fy-home-kicker\">foray…</span>` on every `.fy-home-row` of renderForays; the Library renders forays via `libSummaryRow`/`.pl-row` (renderLibrary, app.js:8753+) with no kicker; styles.css:2324-2331 and 3811-3818 make both kickers the tag shape.",
  "why_subtle": "Each surface was styled on its own; redundancy is only visible when the section title and the tag are read together, which is how the eye actually reads a screen.",
  "fix_sketch": "Pass a `inSection` flag from the section renderer and omit the kicker when the card sits in a section of the same name; keep tags on mixed surfaces (a JBI card on a mixed rail, a FORAY row in a mixed list).",
  "suspected_deliberate": true,
  "relation_to_round1": "extends the visual pass's 'one tag shape' change (which added the tag shape but not a rule for when a tag is warranted)",
  "duplicates": [
    "p-first-9: After the first play, Home's \"Jump back in\" section repeats its heading as an amber tag on every card"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main (9730b5b) and the evidence holds. In app.js, jumpBackInV2Html (around line 7636) puts `<h2 class=\"hv2-title\">Jump back in</h2>` above the rail, and every card from jumpBackInCardHtml carries `<span class=\"hv2-jbi-kicker\">Jump back in</span>` (line 7752). renderForays gives the page the heading `<h2>Forays</h2>`, and forayListHtml (line 10917) puts a `fy-home-kicker` tag reading \"foray\" on every row. styles.css styles these tags in the one tag shape: violet for foray rows (3554) and amber for Jump back in (3557, 3811). libraryForaysHtml (around 8735) uses libSummaryRow with no tag. So the redundant tags and the missing ones are real.\n\nPartial refutations:\n- The amber \"Jump back in\" rows on the Forays page (jumpBackInHtml, line 11013) are not redundant, because that page has no \"Jump back in\" heading.\n- On the Forays list the tag is not pure restatement for drafts, which read \"foray · draft\".\n\nIs it deliberate? DECISIONS.md:128 only records that the visual pass adopted \"one tag shape\", and the CSS comments deliberately match the colours. No ruling covers when a tag should appear or says it is fine for a tag to repeat its section heading, so the issue is not settled by a decision. It is a cosmetic redundancy, so the severity stays low.",
  "merged_ids": [
    "p-first-9"
  ],
  "lane": "L7-styles-touch-visual"
}
```

## visual-10 — Every episode list is numbered like a queue, including Saved, History, search results and a show's episodes

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:1295` · L7-styles-touch-visual

```json
{
  "id": "visual-10",
  "lens": "visual",
  "title": "Every episode list is numbered like a queue, including Saved, History, search results and a show's episodes",
  "file": "styles.css",
  "line": 1295,
  "severity": "low",
  "user_visible": "A show page's episodes, search results, Library › Saved and History and \"More from this show\" all start each row with a numbered circle (1, 2, 3 …), the same badge Up Next and playlists use for order. A numbered Saved list reads as a playlist the listener did not build; Apple numbers nothing but its queue. (library-full.png, search-lex.png, show.png)",
  "evidence": "`.q-num` (styles.css:1295-1305) is emitted by `epRow` for every context — renderLibrary passes ctx `library-saved`/`library-history` (app.js:8756-8765) and still renders the number; `.q-num.next` (1305, 3513) is the only state that carries meaning (queue position).",
  "why_subtle": "Numbers look like structure, so the eye accepts them; only the comparison with Apple (where the absence of numbers is what makes a list feel like a list) shows the noise.",
  "fix_sketch": "`epRow` already takes a ctx: render `.q-num` only for ctx in {queue, playlist-detail}; on show/search/library rows use the row's leading space for the 44px art thumb Apple shows, or nothing.",
  "suspected_deliberate": true,
  "relation_to_round1": "new",
  "duplicates": [
    "p-switcher-11: Show-page episode rows are numbered 1…N with the NEWEST episode as '1'"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In app.js:8025, `epRow(item, idx, ctx, nextIdx)` always emits `<span class=\"q-num ...\">${idx+1}</span>` and never checks ctx. Every place that renders an episode list calls it with nextIdx=-1, so every row gets a number and none of them gets the `.next` marker:\n- show-page episodes and search, app.js:3846 and 3917\n- the catalogue rowFor, 7328 and 7340\n- \"More from this show\", 8232\n- Library Saved and History, 8763 and 8765\n\n`archivedRow` (8080) and History's unnamed fallback (8771) also print numbers. Only the playlist or queue detail (8165) passes a real nextIdx, so that is the only place the badge means a position. No CSS rule hides `.q-num` in any context: styles.css:1295-1305 is the base style, and body.ui-v2 at 3507-3513 only recolours it. docs/DECISIONS.md has no ruling on row numbering. The #276 comment about a saved part keeping \"its number\" so \"the count above it has to stay true\" refers to playlist parts, not to Saved, History, search or show lists. The numbering is a side effect of reusing one row template, not a recorded design choice. It is a real but cosmetic inconsistency, so low severity. It duplicates the earlier show-page numbering finding.",
  "merged_ids": [
    "p-switcher-11"
  ],
  "lane": "L7-styles-touch-visual"
}
```

## races-3 — A playlist build that finishes after the listener left the page navigates them to the playlist from wherever they are — and on the Playlists page throws on a null note

**confirmed** · verifier severity **medium** (finder: medium) · races · `app.js:4442` · L4-search-create-playlists

```json
{
  "id": "races-3",
  "lens": "races",
  "title": "A playlist build that finishes after the listener left the page navigates them to the playlist from wherever they are — and on the Playlists page throws on a null note",
  "file": "app.js",
  "line": 4442,
  "severity": "medium",
  "user_visible": "On a cold start (search documents still downloading — up to the 30 s SEARCH_DATA_DEADLINE) tap a Create suggestion pill or press Go on Playlists. The button says \"Building…\", nothing else happens, so the listener taps Search or Home and starts doing something else. Seconds later the app jumps to a new playlist page. If instead the build found nothing, the Playlists path throws `note.textContent` on null (console error; the Create path silently drops the message). Meanwhile returning to Create shows enabled pills that do nothing when tapped because `createBuildPending` is still true.",
  "evidence": "app.js:4442-4463 `whenSearchDataReady(() => { ... if (result.status === \"ok\" || result.status === \"sparse\") { location.hash = \"#/\" + playlistRoute(result.playlist); } else { const note = $(\"#pl-note\"); note.textContent = ...` — no render-epoch or route check and no null guard. app.js:8933-8938 same `location.hash = ...` in bindCreateFormSubmit. app.js:1547-1548 `loadSearchData().then(() => setTimeout(fn, 0))` waits on a load bounded at app.js:13401 `SEARCH_DATA_DEADLINE_MS = 30000`. app.js:8987 `if (createBuildPending) return;` with no feedback, and renderCreate (8985) re-enables the pills regardless.",
  "why_subtle": "The build was synchronous until the search documents were moved off the boot path (round 1); `whenSearchDataReady` turned a one-tick defer into a possibly 30-second wait, and the callbacks were written for a page that could not have changed. The founder's 'tap looked like nothing' report was fixed with a flag, which now also disables the CTA silently on a fresh render of the page.",
  "fix_sketch": "Capture `const stillHere = renderToken()` before `whenSearchDataReady` and, in the callback, only navigate/paint when `stillHere()`; otherwise just save the playlist (it is already saved) and drop the navigation. Null-guard `#pl-note`. Have renderCreate paint the pending state (`setCreatePillsDisabled(createBuildPending)`, button 'Building…') so a return to the page says why taps do nothing. Optionally show a status line while the search documents load ('Getting the catalogue ready…').",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order effect of the round-1 change that deferred data/semantic-index.json + item-tags.json off the boot path.",
  "duplicates": [
    "p-impatient-9: Leave the Playlists page while a build is waiting for the search index and the result either yanks you to a playlist from wherever you now are, or throws on a null `#pl-note` and says nothing"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main (app.js) myself and the code matches the finding. In bindPlaylistFormSubmit (4428-4464), `whenSearchDataReady(() => {...})` runs `location.hash = \"#/\" + playlistRoute(...)` on ok or sparse results. On any other result it runs `const note = $(\"#pl-note\"); note.textContent = ...` with no null guard, and nothing checks the route or the render epoch. `#pl-note` exists only in the Playlists page markup (8839). If the listener has moved to another page, `$` returns null and the callback throws a TypeError. The `finally` still restores the detached button, so the throw goes to the console and no message is shown.\n\nbindCreateFormSubmit (8918-8952) has the same unguarded navigation. It does null-check `note`, which it captured before the wait, so a detached note there is written silently where nobody sees it.\n\nwhenSearchDataReady (1545-1549) waits on loadSearchData(), which boot starts (13993). That load is capped by withDeadline at SEARCH_DATA_DEADLINE_MS = 30000 (13401), so on a slow cold start the callback can fire many seconds later, after the listener has moved on. renderToken() exists (12920) and does exactly this job elsewhere, but neither build path uses it.\n\nThe Create part holds too. `createBuildPending` is module-level, and renderCreate builds fresh, enabled pills and a Build button. Their handlers return silently while the flag is true (8987 pill `if (createBuildPending) return;`, 8918 submit), and the `finally` only clears the flag and re-enables the pills once the stale build finishes.\n\nNothing in docs/DECISIONS.md covers any of this. The \"ONE BUILD AT A TIME\" comment shows the pending flag was added on purpose, but it never covers leaving the page while a build waits. So the bug is real and not fixed.\n\nSeverity is medium. It only shows when the search-data load is slow (a cold start on a poor network), and the pending state clears on its own when the load finishes. But an unexpected jump to another page while the listener is doing something else is a clear, user-visible disruption.",
  "merged_ids": [
    "p-impatient-9"
  ],
  "lane": "L4-search-create-playlists"
}
```

## search-6 — A browse pill, a return via ‹, or a reload never loads the on-device show index — those searches run over the curated 220 only

**confirmed** · verifier severity **medium** (finder: medium) · search · `app.js:3130` · L4-search-create-playlists

```json
{
  "id": "search-6",
  "lens": "search",
  "title": "A browse pill, a return via ‹, or a reload never loads the on-device show index — those searches run over the curated 220 only",
  "file": "app.js:3022 (loadShowIndex only on focus), app.js:3130 (renderAllShows runs renderShowSearchResults without it)",
  "line": 3130,
  "severity": "medium",
  "user_visible": "Tap the \"Science\" pill (or come back to a search with ‹, or restore the tab on `#/shows/q/huberman`): the instant local answer is only curated shows whose title contains the word; the 10,113-row index that is supposed to make search feel instant is never fetched, so everything else waits 100-1400 ms for the endpoints — and offline a pill answers with the 220 only. If the listener then taps into the field, the index loads and rows append at the bottom.",
  "evidence": "`loadShowIndex()` has exactly one call site, the focus listener at 3022-3023. `renderAllShows(initialQuery)` deliberately does not focus (\"IT DOES NOT FOCUS THE FIELD\", 2844-2847) and goes straight to `renderShowSearchResults(query)` at 3130. Harness: `renderAllShows(\"deep\")` → `show-index.tsv` fetched 0 times, 0 local rows painted for an index-only title. The #684 pill fix (2026-09-13) turned 41 tiles into `#/shows/q/<label>` searches; S-03 (2026-09-12) had tied the index to focus; neither revisited the other.",
  "why_subtle": "Results still appear (from the network), just slower and in a different order than a typed search for the same word, which reads as 'search is a bit inconsistent' rather than a missing load.",
  "fix_sketch": "In `renderAllShows`, `if (query) loadShowIndex();` before `renderShowSearchResults(query)` — `repaintShowSearchForIndex` already merges the index into a live query when it lands. Add a case to test/show-search-fallthrough.test.js: a `#/shows/q/` arrival fetches the index once.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order between S-03 (lazy index) and #684 (pills as searches).",
  "duplicates": [
    "races-5: Arriving at #/shows/q/<q> (a browse pill, ‹ back, a shared link) never loads the show index, so the same query returns a smaller, differently ordered local list than typing it — until the field is tapped"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main (9730b5b) and the claim holds. In app.js, loadShowIndex (line 5743) has one caller: the focus listener on #sh-input (3022-3023). A route of #/shows/q/<q> (router line 12756) calls renderAllShows(safeDecode(q)). That function never focuses the field, as the comment at 2844-2847 says on purpose. It puts the query in the box and ends with `if (query) renderShowSearchResults(query)` at 3130, without ever calling loadShowIndex. Browse pills link to `#/shows/q/<label>` (line 2682), and noteShowQueryInRoute writes the query into the address (5685), so a pill tap, a return to a search, and a reload all land here with no index. localShowMatches (about line 5795) then answers from the curated catalog only when showIndex is null.\n\nIs it deliberate? The DECISIONS.md entry for 2026-09-12 (S-03) says the index is fetched lazily \"on the first focus of the search box and never at init()\". The test in test/show-search-live.test.js checks \"fetched ZERO times before the search box is focused\", and its mutation note calls out loading it from renderAllShows. The reason given is to avoid about 113 ms of decode for \"a listener who came to press play and never searches\". That reason covers a plain #/shows visit and startup. It does not cover arriving with a query, because a pill tap is a search. The pill-to-search change (#684) came after S-03, and neither decision addresses the other. So this is a gap, not a ruling. The suggested fix, `if (query) loadShowIndex()`, keeps the empty-query visit index-free. The existing test mounts without a query, so it should still pass. repaintShowSearchForIndex already merges index results into a live query when the index arrives.\n\nWhat the user sees: when online, the breadth endpoint still returns results after its round trip, and the index rows show up if the listener taps the field. So it is a speed and consistency loss, not missing results. When offline, a pill search answers from the curated shows only. Medium is right.",
  "merged_ids": [
    "races-5"
  ],
  "lane": "L4-search-create-playlists"
}
```

## p-impatient-2 — Tap ▶ on row A, then quickly ▶ on row B: A is recorded as played — it enters History, counts toward a playlist's 'N played', and the playlist's next-up marker skips it

**confirmed** · verifier severity **medium** (finder: medium) · p-impatient · `app.js:4550` · L1-player-transport

```json
{
  "id": "p-impatient-2",
  "lens": "p-impatient",
  "title": "Tap ▶ on row A, then quickly ▶ on row B: A is recorded as played — it enters History, counts toward a playlist's 'N played', and the playlist's next-up marker skips it",
  "file": "app.js:4550-4562 (bindPlay) with player/client.js:2932-2939 (play returns `state !== 'idle'`) and player/queue-manager.js:1308-1310 (superseded load returns quietly)",
  "line": 4550,
  "severity": "medium",
  "user_visible": "On a show page you tap ▶ on episode 3, change your mind half a second later and tap ▶ on episode 5. Episode 5 plays. Later, Library → History lists episode 3 as something you listened to, the playlist page says '2 played' and puts the amber 'next' marker after episode 3 as if you had heard it, and the events pipeline records a `play_started` for it.",
  "evidence": "`bindPlay` awaits `ForayPlayer.play(item)` and on `ok` runs `logEvent('play_started')`, `recordHistory(id)` and `touchPlaylistPlayed`. `play()` returns `manager.state?.type !== 'idle'` — 'THE ANSWER, NOT THE ATTEMPT'. But when B supersedes A, A's `_loadItem` hits `if (this._loadSeq !== seq) return this._emit('load.superseded …')` (queue-manager.js:1308) and A's `manager.play` resolves normally while the manager is in B's `loadingItem`/`playing` state — not idle — so A's caller receives `true`. `recordHistory` (app.js:1255) then appends A to `cp_history`, which `hasOpened` (8018) and Library's History (8758) both read.",
  "why_subtle": "Round 1 fixed 'play returns true on a 404' by checking the manager's state, which is the state of WHOEVER owns the player now, not of the item this call asked for. The wrong answer is only wrong for a second tap that arrives inside the first load, which is exactly what an impatient thumb does, and the consequences show up on different screens hours later.",
  "fix_sketch": "Have `play()` answer for its own item: `return manager.state?.type !== 'idle' && manager.playheadItemId === item.id` (or compare `current?.id === item.id` after the await). In `bindPlay`, additionally guard the post-play bookkeeping with `window.ForayPlayer.isCurrent(id)`. Add a test: two overlapping `play()` calls, only the second id lands in `cp_history`.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 24 / persona 15 (the 'play reports success' fix answers for the player, not for the item).",
  "duplicates": [
    "races-8: A row play that is superseded during its load is still recorded as played: History and the last-episode pointer gain an episode that never sounded"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main (9730b5b) and the finding holds. In app.js bindPlay (around lines 4550-4575), the handler awaits `ForayPlayer.play(item)`. When `ok` is true it calls logEvent('play_started'), recordHistory(id) and touchPlaylistPlayed. Nothing checks whether this row is still the current item after the await. The only isCurrent check runs before the await, and it decides between toggling and playing. It does not guard the bookkeeping.\n\nIn player/client.js, play() calls `manager.setQueueFromPick(item); await manager.play(0);` and then returns `manager.state?.type !== 'idle'`. That answers for the player, not for this item.\n\nIn queue-manager.js, `play()` goes through `_transport`, which only cuts and parks the seam gap. It does not serialise or queue calls, so two overlapping plays run concurrently. `_loadItem` claims `seq = ++this._loadSeq`. B's load bumps that number synchronously, so when A's `backend.load` resolves, line 1308 returns early with an emit (load.superseded). If A's load instead rejects because the element was re-pointed, the catch at line 1336 also returns quietly, and it deliberately skips dispatching error. On both paths A's manager.play resolves normally while the reducer is in B's loading or playing state, so A's caller gets `true`.\n\nThe window is real. The backend contract says load() resolves \"when ready to produce audio\", which depends on the network, and bindPlay does not disable the buttons while a play is in flight. So tapping a second row a fraction of a second later reproduces it. recordHistory (app.js:1255) then appends A to cp_history. It also calls rememberEpisode for A, and touchPlaylistPlayed and play_started fire for A.\n\nI found no ruling on this in docs/DECISIONS.md, and no play-token guard in client.play. It is not fixed on main. The round-1 'answer, not attempt' fix only covers failed loads, which land the manager in idle. It does not cover a load that was superseded. Medium severity is right: it corrupts History, the playlist's played count and next-up marker, and telemetry, but it breaks no playback.",
  "merged_ids": [
    "races-8"
  ],
  "lane": "L1-player-transport"
}
```

## states-1 — 136 of 220 curated shows silently end at 100 episodes with a blank subtitle and no way to reach the rest

**deliberate** · verifier severity **medium** (finder: high) · states · `app.js:3510`

```json
{
  "id": "states-1",
  "lens": "states",
  "title": "136 of 220 curated shows silently end at 100 episodes with a blank subtitle and no way to reach the rest",
  "file": "app.js",
  "line": 3510,
  "severity": "high",
  "user_visible": "Open Lex Fridman, Odd Lots, EconTalk or any of the 136 catalogue shows with episode_count > 100 (data/catalog-client.json). The page paints exactly 100 rows, the subtitle under the title is an empty line, and the list just stops. Nothing says 'showing the latest 100', nothing says how many there are, and nothing offers more. Apple Podcasts shows the count and scrolls the whole feed.",
  "evidence": "api/shows/[show_id]/episodes.ts:145 `const PAGE_SIZE = 100;` and `paginate(episodes, cursor, PAGE_SIZE)` returns a `next_cursor`. app.js showEpisodeCountLabel: `if (fullyLoaded) { return \\`${loadedCount} episode…\\` } // Partial load: no count … return stale ? \"Showing the last saved list — couldn't refresh just now.\" : \"\";` (3506-3510). The only consumer of `nextCursor` after the 2026-09-13 removal of 'Show more episodes' is `fullyLoaded = nc === null` (4197); the comment at 3941 says 'Reaching older episodes is now the search box's job', but nothing on screen tells the listener that, and the search box only appears once rows load with no hint that it reaches further than the list.",
  "why_subtle": "Every state of the page is honest (no false count), so nothing reads as broken; a listener simply believes a 900-episode show has 100 episodes, and a `<p class=\"sub\">` that is empty leaves a blank line under the title where every other show has a subtitle. It is the majority case, not an edge.",
  "fix_sketch": "When `!fullyLoaded`, say so in the subtitle from the same state: 'Latest 100 episodes · search for older ones' (or `${loadedCount}+ episodes`), and either restore a 'Show older episodes' control wired to `fetchShowEpisodes(show_id, nextCursor)` (idle/fallback modes only, the mode bug that killed it is documented at 3925) or auto-page on scroll. Pin with a test that a page with `next_cursor` never paints an empty subtitle.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order effect of the 2026-09-13 Show-more removal plus qa 94's 'no count on a partial load' rule",
  "duplicates": [
    "p-switcher-6: A show page stops dead at 100 episodes with nothing saying the rest exist"
  ],
  "verdict": "deliberate",
  "verdict_severity": "medium",
  "verdict_reasoning": "The facts in the finding are correct at origin/main (last app.js commit 9730b5b). api/shows/[show_id]/episodes.ts:145 sets PAGE_SIZE = 100, and line 263 paginates and returns nextCursor. In app.js, showEpisodeCountLabel (3458-3511) returns \"\" for a partial load unless the list is stale. fullyLoaded is set from the cursor being null (4127, 4199). The 'Show more episodes' control, paintMoreButton/loadNextPage, was removed; the comment at 3994-4025 says reaching older episodes 'is now the search box's job'. data/catalog-client.json has 220 shows, and 136 of them have episode_count > 100. So listeners do see a list that stops at 100 rows, with a blank subtitle and no control to load more.\n\nIt is not an accident, though. The comment block right above the function (3440-3456) records a 'FOUNDER CALL 2026-09-13': the partial-load branch 'renders NOTHING'. The earlier '100+ episodes loaded so far — more available' was deleted on Wyatt's verdict, 'delete that, it's useless info'. The reason given: once the button was gone, the text advertised 'a door that no longer exists'. A bare '100 episodes' was ruled out as a false completeness claim. The button was removed on purpose after a founder report that it failed in scoped-search mode, and search over the full catalogue was named as the replacement. docs/DECISIONS.md has no entry on this, so the ruling lives only in the code comments.\n\nWhat remains is a real UX gap nobody has ruled on: nothing tells the listener that search reaches past the first 100 episodes, and there is no way to scroll or page further in idle mode, where the old button worked. That makes it worth a follow-up. But the blank subtitle directly contradicts an explicit founder call, and the proposed copy ('Latest 100 · search for older ones') reopens that call, so it needs his sign-off rather than a unilateral fix. Severity is medium, not high: it is a deliberate tradeoff with a stated workaround (search the full catalogue), not a broken feature.",
  "merged_ids": [
    "p-switcher-6"
  ],
  "lane": null
}
```

## states-11 — An estimated Foray runtime is labelled 'about' on the Foray page but 'N min left' and a plain clock everywhere else (Jump back in, Now Playing sheet, lock screen)

**confirmed** · verifier severity **low** (finder: low) · states · `app.js:7701` · L8-foray-surfaces

```json
{
  "id": "states-11",
  "lens": "states",
  "title": "An estimated Foray runtime is labelled 'about' on the Foray page but 'N min left' and a plain clock everywhere else (Jump back in, Now Playing sheet, lock screen)",
  "file": "app.js",
  "line": 7701,
  "severity": "low",
  "user_visible": "For a narrated (draft/test-track) Foray whose bridges have character-count estimates, the Foray header says 'about 41 min' and the clock '~41:00', while Home's Jump back in card says '32 min left', the Now Playing sheet says '-32:00' / 'of 41:00', and the resume line says '32 min left' — all from the same estimated total, none marked. Published capital-types-1 has no narration so the founder's build is not affected today.",
  "evidence": "forayRuntimeLabel: `if (tally && tally.estimated) return \\`about ${player.fmtSpan(totalSec)}\\`;` (9671) and `$(\"#fy-total\").textContent = \\`${tally && tally.estimated ? \"~\" : \"\"}…\\`` (9866) — the only two readers of `estimated` (segment-strip.js:471). player/client.js forayResumeList: `label: point && !point.finished ? remainingLabel(point.remainingSec) : \"\"` (3710) from `liveTotal = resolved.totalSec` (3692); sheet: `ui.tLeft.textContent = dur ? remainingClock(dur - pos) : \"--:--\"` with `dur = foray.resolved.totalSec` (1471-1490); jumpBackInCardHtml paints `c.left` verbatim (7704).",
  "why_subtle": "qa 180 was fixed at the two places named in the finding; the estimate flag never left the strip's tally, so every other surface still reads the same number as measured.",
  "fix_sketch": "Expose `estimated` on the resolved Foray (resolveForay already knows `duration_source`), and have `remainingLabel`/`remainingClock` prefix '~' / 'about' when set; or drop the minutes label for estimated Forays and show percent only.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 180",
  "duplicates": [
    "honesty-10: Incomplete fix of qa 180: the mini bar / Now Playing countdown and the slider's 'of' total present an estimated Foray runtime as an exact clock ('-43:07'), with no tilde"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In app.js, forayRuntimeLabel (line 9671) returns `about ${fmtSpan}` when tally.estimated is set, and #fy-total (line 9864) adds a '~' in the same case. Those are the only readers of `estimated` in the codebase: grep finds it only in app.js at 9671 and 9864, and it is produced by stripTally in player/segment-strip.js at 471. The other surfaces build their text from resolved.totalSec and never check it:\n- player/client.js: the Now Playing sheet (lines 1486 and 1491) sets `dur = foray.resolved.totalSec`, the aria \"of\" text uses fmtClock(dur), and tLeft uses remainingClock(dur - pos). remainingClock (1337) returns a plain `-M:SS` with no tilde.\n- player/client.js: forayResume (3650) and forayResumeList (3710) use remainingLabel(point.remainingSec). remainingLabel (player/foray-progress.js:371) returns a plain `N min left` with no marker.\n- app.js: jumpBackInEntries copies p.label into c.left, and jumpBackInCardHtml paints it unchanged.\nSo one Foray with narration bridges, whose `duration_source` is not \"measured\", shows 'about 41 min' / '~41:00' in the Foray header, but an unmarked '32 min left' and '-32:00' / 'of 41:00' elsewhere.\nI found no ruling in docs/DECISIONS.md that makes this deliberate. The nearby estimate rulings (around lines 1659-1667) say on-device narration is 'a characters-per-minute estimate until spoken … never a measured \"actual\" value, everywhere', which supports calling this a bug. The remainingLabel docstring does argue for whole minutes as a rounding choice, but it doesn't address estimated runtimes.\nI didn't separately trace the lock-screen metadata or check whether the draft rule keeps draft Forays off the Jump back in rail. The Now Playing sheet alone is enough to reproduce the inconsistency. Severity stays low: the text is cosmetic, and published Forays with no narration aren't affected. It duplicates honesty-10 and is an incomplete fix of qa 180.",
  "merged_ids": [
    "honesty-10"
  ],
  "lane": "L8-foray-surfaces"
}
```

## copy-2 — One listener reads four duration dialects on one row: "3h 5m" beside "185 min left"

**confirmed** · verifier severity **low** (finder: medium) · copy · `app.js:952` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-2",
  "lens": "copy",
  "title": "One listener reads four duration dialects on one row: \"3h 5m\" beside \"185 min left\"",
  "file": "app.js",
  "line": 952,
  "severity": "medium",
  "user_visible": "An episode row past the hour reads \"Lex Fridman · 3h 5m · Sep 12, 2026 · 185 min left\". Under an hour the same row spells the unit \"45 min\", over it \"1h 5m\". The remaining label never rolls into hours (a 3-hour episode just started says \"180 min left\" on Home's Jump back in card too). A Foray's header says \"about 95 min\" or \"1:35:07\", the strip caption \"95 min in all\", a clip row \"2 min\"/\"45 sec\". Apple Podcasts uses one dialect everywhere (\"1 hr 20 min\", \"1 hr 20 min left\").",
  "evidence": "fmtDur (app.js 952-958): `if (min < 60) return `${min} min`; … return m ? `${h}h ${m}m` : `${h}h`;` — \"min\" below the hour, \"m\" above it. episodeRemainingLabel (player/episode-progress.js 141): `return mins <= 0 ? \"finished\" : `${mins} min left`;` with no hour branch. remainingLabel (player/foray-progress.js 374): `return `${Math.round(remainingSec / 60)} min left`;`. fmtSpan (player/foray-resolve.js 742-746): `if (total < 90) return `${total} sec`; return `${Math.round(total / 60)} min`;` — no hour branch either. epRow (app.js 8037) joins fmtDur and the progress label on the same line: `joinMeta(showNameLink(item.show), fmtDur(item.duration_min), esc(dateStr), progHtml)`.",
  "why_subtle": "Every formatter is individually correct and each was fixed in round 1 (qa 147/184 fixed \"1h 0m\"); the mismatch only shows on episodes over an hour, which is most of the long-form pool.",
  "fix_sketch": "One duration formatter with one dialect (\"1 hr 5 min\", \"45 min\") used by fmtDur, fmtSpan and both remaining labels (\"1 hr 5 min left\"); keep fmtClock only for the live playhead/scrub clocks. test/format-helpers.test.js gets the ≥60-minute remaining case.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order of qa 147 and persona 78 (the row progress label was added after the duration formatters were settled)",
  "duplicates": [
    "honesty-9: Foray runtime is worded three ways — '51:22' (clock) when measured, 'about 43 min' when estimated, and never in hours — while episode rows on the same screens say '1h 12m'"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and every piece of the evidence checks out. fmtDur (app.js 952-958) gives \"45 min\" under an hour and \"3h 5m\" at or above it. episodeRemainingLabel (player/episode-progress.js 141-147) returns `${mins} min left` and has no branch for an hour or more. episodeProgress (line 183) uses that label for in-progress rows. epRow (app.js 8030-8037) puts fmtDur(item.duration_min) and progHtml together on one joinMeta line, so a partly played 185-minute episode really does show \"3h 5m ... 185 min left\". remainingLabel (player/foray-progress.js 374) and fmtSpan (player/foray-resolve.js 742-746) also never switch to hours.\n\ndocs/DECISIONS.md has no ruling on duration dialect. The code comments explain why the values are rounded to whole minutes, but they don't say why the units differ, so this doesn't look deliberate. It hasn't been fixed on origin/main.\n\nI'd lower the severity to low. It's a cosmetic inconsistency that doesn't change meaning: every number is correct and a listener can still read it. It only shows up on in-progress rows for episodes an hour or longer.",
  "merged_ids": [
    "honesty-9"
  ],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-foray-8 — Nothing before the Foray page tells you how long a Foray is, and the page shows the runtime in two formats

**confirmed** · verifier severity **medium** (finder: medium) · p-foray · `app.js:10917` · L8-foray-surfaces

```json
{
  "id": "p-foray-8",
  "lens": "p-foray",
  "title": "Nothing before the Foray page tells you how long a Foray is, and the page shows the runtime in two formats",
  "file": "app.js",
  "line": 10917,
  "severity": "medium",
  "user_visible": "#/forays rows are a 'FORAY' tag and a title; Home's card is title + strip; Library's row is title (+ 'N min left' only once started). Apple Podcasts shows a duration on every row. Once inside, the header reads '22 clips from 7 shows · 51:22' (a clock) while an estimated Foray reads 'about 43 min'.",
  "evidence": "forayListHtml renders only `<span class=\"fy-home-kicker\">foray...</span><span class=\"fy-home-title\">${esc(f.title)}</span>`; forayCardV2Html (app.js:7783) renders title + strip; libraryForaysHtml (app.js:8740) passes progress label or ''. forayRuntimeLabel (app.js:9670): `if (tally && tally.estimated) return 'about ' + fmtSpan(totalSec); return player.fmtClock(totalSec);`.",
  "why_subtle": "Each surface is internally consistent; the missing fact only shows up when you compare the Foray list with the episode list beside it.",
  "fix_sketch": "Add a sub line to list rows and cards: `${fmtSpan(totalSec)} · ${countLabel(clips,'clip')} · ${countLabel(shows,'show')}` from stripTally/resolve (already computed for the card's strip); use fmtSpan ('51 min') in the header for measured runtimes too, keeping 'about' for estimates.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; qa 180 covered the estimate marker only",
  "duplicates": [
    "copy-4: A Foray is listed with no length anywhere except its own page, and its kicker is \"foray\" on one list and \"Foray\" on the next"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds.\n\n1. Foray list: forayListHtml (app.js:10912-10921) renders only the kicker `foray` (plus ` · draft` for drafts) and the title. There is no length.\n2. Home card: forayCardV2Html (app.js:7766) renders an optional Stretch or draft tag, the title, the segment strip and an optional bridge line. The strip comes from segmentStripHtml in player/segment-strip.js, which draws bars only. Any duration it carries sits in the aria-label from stripSummary, so a screen reader may hear it but nobody sees it.\n3. Library: libraryForaysHtml (app.js:8732) passes the resume-progress label, or 'draft', or ''. A Foray you have not started shows no length.\n4. Foray page header: forayRuntimeLabel (app.js:9670) returns `about ${fmtSpan}` when tally.estimated is set and player.fmtClock(totalSec) otherwise. So a fully measured Foray reads as a clock ('51:22') and an estimated one reads 'about 43 min'.\n\nThe comment above forayRuntimeLabel explains why an estimate gets the word 'about' (audit 2026-09-22, theme L). It does not explain why measured runtimes use a clock, so the mixed format looks like a side effect of that change, not a choice. I searched docs/DECISIONS.md for runtime, duration and length and found nothing that covers Foray list lengths or the header format. The nearest entry says duration is 'shown plainly', and that argues for showing a length, not against it. Nothing on main fixes either part.\n\nI rate it medium. The missing length on every list surface is a real gap in what a listener needs to decide whether to start a Foray. The clock-versus-minutes mismatch is minor polish.",
  "merged_ids": [
    "copy-4"
  ],
  "lane": "L8-foray-surfaces"
}
```

## honesty-2 — A finished Foray leaves no trace anywhere — no 'Played', no bar, dropped from Jump back in and Library — while a finished episode says 'Played' on every row and stays in Jump back in for 30 days

**confirmed** · verifier severity **medium** (finder: high) · honesty · `player/client.js:3645` · L8-foray-surfaces

```json
{
  "id": "honesty-2",
  "lens": "honesty",
  "title": "A finished Foray leaves no trace anywhere — no 'Played', no bar, dropped from Jump back in and Library — while a finished episode says 'Played' on every row and stays in Jump back in for 30 days",
  "file": "player/client.js",
  "line": 3645,
  "severity": "high",
  "user_visible": "Finish capital-types-1. The Forays list row shows just 'foray · title', Library's Forays row has an empty subtitle, Home's Jump back in drops it, and the Foray page opens with no resume banner, no ticked rows and a plain '▶ Play' — indistinguishable from a Foray never opened. Finish a 3-hour episode instead and every row says 'Played', and Home keeps a 'Jump back in' card reading 'Played' with a full bar for 30 days.",
  "evidence": "player/client.js:3645 `if (!point || point.finished) return null;` (forayResume) — a finished Foray yields nothing for the page. app.js:11005 `.filter(p => visible.has(p.id) && p.drift !== \"dropped\" && !p.finished && p.label)` — the rail and (via 8738) Library drop it. Contrast player/episode-progress.js `episodeProgress`: `if (pos > dur - NEAR_END_SEC) return { state: \"played\", percent: 100, label: \"Played\" }` and its comment 'There is deliberately no finished state here… an episode you finished is still the podcast you were listening to'.",
  "why_subtle": "Each half was fixed separately in round 1 (qa 27/158/175 for episodes; the Foray filter predates it). Each is internally consistent; the contradiction only appears when one listener has finished one of each.",
  "fix_sketch": "Give Forays the same vocabulary as episodes: forayResumeList returns finished rows with label 'Played' and percent 100; Library and the Forays list show 'Played' on the row; the Foray page shows a 'Played — Play again' banner (or ticks every row) instead of nothing. Then decide ONCE whether a finished thing belongs under 'Jump back in' and apply it to both kinds.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction between the qa 27/175 fix (finished episode says Played) and the Foray rail filter. Not covered by any round-1 row.",
  "duplicates": [
    "copy-3: \"Jump back in\" keeps a finished episode labelled \"Played\" but drops a finished Foray — two round-1 fixes disagree on what the rail is for"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The behaviour is real at origin/main, but the finding points at the wrong code. The real cause is earlier. In player/client.js, persistForayProgress (around line 1243) runs forayProgress.clear(id) when manager.state.type === \"ended\" and logs \"finished-cleared\", so a finished Foray has no stored row at all. The `point.finished` checks it cites (forayResume at line 3645, forayResumeList at lines 3709-3710, the app.js line 11005 filter) almost never see a finished row. The result is still what the finding describes, and I checked each surface:\n- forayResume returns null, so the Foray page shows no resume banner (app.js line 9779 onward).\n- forayResumeRows is empty for that Foray, so Home's Jump back in (line 7646), the Forays page's Jump back in (line 7977) and Library's Forays row (line 8738, empty subtitle for a published Foray) all show nothing.\nEpisodes do the opposite. episodeProgress in player/episode-progress.js returns {state:\"played\", percent:100, label:\"Played\"}, and its comment says a finished episode must not fall back to looking unplayed.\n\nIs it deliberate? Partly. The comment on persistForayProgress, from PR #193, chooses this on purpose: \"A finished Foray that keeps offering '0 min left' on the home screen is worse than one that quietly goes back to being unplayed.\" But that is a code comment, not a docs/DECISIONS.md ruling; DECISIONS.md has nothing on finished Foray rows. Its reasoning was also overtaken by the later episode fix, which stops a finished item offering \"0 min left\" by labelling it \"Played\" instead of wiping it. So the two kinds now disagree, and nobody has ruled on that. It is not fixed. It duplicates copy-3.\n\nSeverity: medium, not high. It is a consistency and orientation gap: no data is lost and playback works; the listener just can't see that they finished a Foray. Fixing it needs a change at persistForayProgress, which should keep a finished marker instead of clearing the row, not only at forayResume.",
  "merged_ids": [
    "copy-3"
  ],
  "lane": "L8-foray-surfaces"
}
```

## honesty-3 — Library → History is in first-play order, not last-played: replaying an old episode does not move it, so the 'most recent' list can lead with something played weeks ago

**confirmed** · verifier severity **medium** (finder: medium) · honesty · `app.js:1259` · L3-queue-and-native-surfaces

```json
{
  "id": "honesty-3",
  "lens": "honesty",
  "title": "Library → History is in first-play order, not last-played: replaying an old episode does not move it, so the 'most recent' list can lead with something played weeks ago",
  "file": "app.js",
  "line": 1259,
  "severity": "medium",
  "user_visible": "Play A on Sept 1, B on Sept 2, then replay A on Sept 22. History shows B above A. With 200 plays behind you, yesterday's re-listen sits on page 'never' (the Library shows only the last 20 of the ring). Apple Podcasts' Recently Played always leads with what you just heard.",
  "evidence": "app.js:1259 `if (!history.includes(id)) lsSet(\"cp_history\", history.concat(id).slice(-200));` — the one writer appends only on first play and never re-orders. app.js:8758 `const historyIds = pickedHistory().slice().reverse().slice(0, 20);` — the page presents the ring's tail as 'most recent'.",
  "why_subtle": "Membership and recency look identical until something is replayed; the audit's qa 96 fixed what History rows say, not their order.",
  "fix_sketch": "On every play, move the id to the end: `lsSet(\"cp_history\", history.filter(x => x !== id).concat(id).slice(-200))`. hasOpened/branchChain only test membership, so ordering is free to change; add a test that a replay leads the History section.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; qa 96 (History 'No longer available') and qa 189 (played count vs ring rotation) touched cp_history but not ordering.",
  "duplicates": [
    "p-impatient-5: Library → History is 'first-played' order, not 'recently played': replaying something from weeks ago leaves it buried, and it falls off after 200 other plays even though you heard it today",
    "p-switcher-4: The second in-progress episode vanishes: Jump back in holds one episode, and History is ordered by first play, not last"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. In app.js, recordHistory() (lines ~1255-1260) is described as \"THE ONE WRITER OF cp_history\". It only appends: `if (!history.includes(id)) lsSet(\"cp_history\", history.concat(id).slice(-200));`. Replaying an id that is already in the list does nothing, so the id keeps its first-play position. It can also be evicted by the slice(-200) cap even if it was just replayed. renderLibrary() (app.js:8758) shows `pickedHistory().slice().reverse().slice(0, 20)`. The block comment at ~8692 says the History list is \"newest-first\" and matches what \"recently listened\" means. So the code's own stated intent is recency, and first-play order breaks that intent rather than being a deliberate choice. docs/DECISIONS.md has no ruling on cp_history ordering or first-play versus last-play; grepping for history, recently played and first play turned up nothing relevant. Other readers of cp_history (hasOpened ~8014, the Set uses at 1293/8142, diversify at 4278, and the keep-set at 1921) only test membership, so move-to-end reordering would be safe. Users will see this: a re-listened old episode stays buried in, or missing from, the 20-row History. Severity is medium: it is a wrong-order and missing-item annoyance with no data loss.",
  "merged_ids": [
    "p-impatient-5",
    "p-switcher-4"
  ],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-car-3 — After a phone call or Siri in the car, 4a stays silent: the page's own reconcile pauses the element mid-interruption, which cancels the OS resume, and interruptionEnded is discarded

**confirmed** · verifier severity **medium** (finder: high) · p-car · `player/client.js:460` · L1-player-transport

```json
{
  "id": "p-car-3",
  "lens": "p-car",
  "title": "After a phone call or Siri in the car, 4a stays silent: the page's own reconcile pauses the element mid-interruption, which cancels the OS resume, and interruptionEnded is discarded",
  "file": "player/client.js",
  "line": 460,
  "severity": "high",
  "user_visible": "A call comes in over Bluetooth, the podcast ducks out (correct). The call ends; Apple Podcasts and Spotify come back on their own; 4a does not. The lock screen says paused and the driver has to find play. On iOS the record will show 'interruptionEnded should-resume' and nothing after it.",
  "evidence": "onNativeSession routes only interruptionBegan/foreground/mediaServicesReset to reconcileOnReturn and states 'interruptionEnded changes nothing. shouldResume would start audio with no press, which is a product decision (docs/DECISIONS.md)' (client.js:445-462) — DECISIONS.md contains no such ruling (only the session-hold entry), so the decision is pending, not made. Worse, the reconcile is not neutral: the OS interruption fires `pause` on the element → _notePause → onUnexplainedPause → reconcileWithBackend → E.interruptionBegan() → F.pausePlayback (queue-state.js:412-419) → `this.backend.pause()` (queue-manager.js:1096) → `this.el.pause()` unconditionally (html-audio-backend.js:1800, 'pausing an already-paused element is still an instruction not to be audible'). In WebKit a script pause() while the session is Interrupted goes through pauseInternal → PlatformMediaSession::clientWillPausePlayback, which sets stateToRestore = Paused, so endInterruption(MayResumePlaying) resumes nothing; Chromium's WebView MediaSession likewise treats a page pause as leaving the session's resumable set. The manager's own `interruptionEnded(shouldResume)` (queue-manager.js:847, reducer 445-470 'interruption.ended.resumed') exists and has no caller in client.js.",
  "why_subtle": "It is a second-order effect of the #263/#689 reconcile fix: a defensive pause that is harmless on a route loss is destructive inside an interruption, and the code that would resume was built, tested and never connected. The record will read as if everything worked.",
  "fix_sketch": "Two halves: (1) do not issue el.pause() when reconciling an interruption the element already reports as paused (reconcile should move the reducer without the pausePlayback effect, or backend.pause() should skip el.pause() when el.paused is already true and the pause was not ours); (2) wire `foray:session` kind=interruptionEnded reason=should-resume to manager.interruptionEnded(true), guarded by the record's lag so a late event after the listener already resumed is a no-op — and write the ruling in DECISIONS.md either way. Device check: take a 20 s call mid-episode.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; interacts with the 2026-09-22 reconcile fix (founder report 1) and the 2026-09-23 session-hold work, which re-takes the hold after a call but never resumes audio.",
  "duplicates": [
    "native-9: After an interruption ends, tape resumes by itself but narration never does, and neither matches Apple Podcasts' resume-after-call"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main 9730b5b (#746, today's session-hold / \"car resumes Spotify\" fix), and every link in the finding's chain is there.\n\n1. **`interruptionEnded` is dropped.** In player/client.js:431-463, `onNativeSession` sends only interruptionBegan, foreground and mediaServicesReset to `reconcileOnReturn`. `interruptionEnded` only flushes positions. The comment at 445-447 calls resuming \"a product decision (docs/DECISIONS.md)\".\n\n2. **The manager's resume path has no caller.** `manager.interruptionEnded(shouldResume)` (queue-manager.js:847) and the reducer's `interruption.ended.resumed` branch (queue-state.js:445-470) are never called in production. transport-reconcile.test.js:1429 says so outright: \"have NO production caller\".\n\n3. **The page pauses an already-paused element.** An OS pause the page did not ask for goes `_notePause` (html-audio-backend.js:1239) → `onUnexplainedPause` (queue-manager.js:457) → `reconcileWithBackend`. That function sees `playing` with `backend.paused === true` and calls `E.interruptionBegan()` (queue-manager.js:997). The reducer then emits `pausePlayback` (queue-state.js:412-419), which reaches `backend.pause()` (queue-manager.js:1096). That calls `this.el.pause()` with no check (html-audio-backend.js:1800). The comment there says this is on purpose: \"pausing an already-paused element is still an instruction not to be audible.\"\n\n4. **What WebKit does with that pause (from memory of its source, not checked on a device).** During a system interruption, `beginInterruption` saves the old state and moves to Interrupted, then suspends the element while it is notifying the client, so the pause event reaches the page. The page's own `el.pause()` then runs `clientWillPausePlayback` outside that notifying window. With the state Interrupted, that sets the state to restore to Paused. So when the interruption ends with MayResumePlaying, WebKit does not resume.\n\n**No ruling covers it.** docs/DECISIONS.md has nothing on resuming after an interruption. The nearest entry is the #746 session-hold ruling, which re-takes the `.playback` hold on `shouldResume` but never resumes audio. The Swift plugins (ForayAudioPlugin.swift:150-160) and docs/ios-lock-screen.md:396-402 say they only report `shouldResume` because `queue-manager.js` owns the transport. The one layer that owns it never acts on it.\n\n**Partly deliberate.** Leaving the explicit `shouldResume` resume unwired is a known, deferred choice. It comes from the founder's report 1 (audio starting with no press), and transport-reconcile.test.js:1420ff pins that nothing starts audio on its own. But the decision it points to does not exist. And the first half, where the reconcile's `el.pause()` cancels WebKit's own resume, is not acknowledged anywhere. The #746 fix does not touch either half. So I'm confirming it, not calling it deliberate.\n\n**Severity: medium, not high.** The user impact is real and common in a car: after a call or Siri, 4a stays paused while other podcast apps come back, and the driver has to press play. But nothing is lost (the position is saved and the state can be resumed with one press). And whether WKWebView would have resumed in the background without the page's `el.pause()` still needs the proposed 20 s call test on a device.",
  "merged_ids": [
    "native-9"
  ],
  "lane": "L1-player-transport"
}
```

## p-impatient-3 — With anything in Up Next, the iOS lock screen may swap the founder's 30↻ for ⏭ — the 2026-09-23 steering-wheel 'next' fix enables nextTrackCommand at the same moment the 2026-09-23 15/30 fix relies on the skip commands being what the lock screen shows

**confirmed** · verifier severity **medium** (finder: medium) · p-impatient · `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:1007` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-3",
  "lens": "p-impatient",
  "title": "With anything in Up Next, the iOS lock screen may swap the founder's 30↻ for ⏭ — the 2026-09-23 steering-wheel 'next' fix enables nextTrackCommand at the same moment the 2026-09-23 15/30 fix relies on the skip commands being what the lock screen shows",
  "file": "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:1007-1010 with app.js:2125-2130 (EPISODE_NAVIGATION.next) and mobile/plugins/foray-audio/web/foray-media-session.js:457 (hasNext = installed.has('nexttrack'))",
  "line": 1007,
  "severity": "medium",
  "user_visible": "Queue two episodes and lock the phone. The lock screen's right-hand button is ⏭ (next episode) instead of 30↻ — one press skips the rest of the episode you are in AND removes it from Up Next. When the last queued episode starts, Up Next empties, `hasNext` flips false and the button changes back to 30↻ mid-drive. The left button stays ↺15 because `previous` is only offered when a chosen list has a playable row before the current one.",
  "evidence": "`EPISODE_NAVIGATION.next` returns a function whenever `planAfterEnded(cur).nextId` exists (Up Next non-empty). `setEpisodeNavigation` → `media.setActions(episodeMediaSurface)` → `mediaSessionActions` pushes `['nexttrack', …]` (media-session.js:533) → the shim sets `hasNext: installed.has('nexttrack')` → Swift sets `commandCenter.nextTrackCommand.isEnabled = transportable && payload.hasNext` while `skipForwardCommand.isEnabled` is also true. iOS renders one control per side; which one wins when both are enabled is decided by the OS (Apple developer-forum threads report the choice depends on the track commands and on `preferredIntervals`, which this plugin writes on every state change, line 999-1000). `docs/ios-lock-screen.md` §3.3 says `nextTrackCommand.isEnabled` is 'a plain boolean … set directly from payload.hasNext' and does not discuss the collision.",
  "why_subtle": "Both fixes are individually right and merged the same day (commit 9730b5b); the interaction only exists when Up Next is non-empty, which a power user always has and the founder's report (10 s both directions) was made without. Apple Podcasts keeps ⏮/⏭ disabled on the lock screen for exactly this reason and drives 'next' from CarPlay/steering-wheel commands instead. NEEDS A DEVICE CHECK: if iOS lets `preferredIntervals` win, the symptom inverts — the lock screen keeps 15/30 and the ⏭ the steering-wheel fix promises never appears on the lock screen either way.",
  "fix_sketch": "Decide the lock-screen surface explicitly: keep `nextTrackCommand`/`previousTrackCommand` enabled for the media-remote (steering wheel, headset) but verify on device which pair the lock screen draws; if track commands win, follow Overcast/Pocket Casts and either (a) disable the track commands and route ⏭ through a CarPlay template only, or (b) expose a setting. At minimum add an XCTest/device note documenting the chosen behaviour, and stop the glyph flipping as Up Next drains (do not re-evaluate `hasNext` per Up Next edit for the lock-screen surface).",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction between the 2026-09-23 founder fix (lock-screen 15/30) and persona 6 / qa 23 fix (steering-wheel next/previous). Not previously reported.",
  "duplicates": [
    "native-4: iOS lock screen shows track skip (next/previous clip) instead of the 15/30 buttons whenever a next item exists, and flips layout for ordinary episodes depending on Up Next",
    "p-car-2: On iOS the lock screen shows ⏮ / ⏭ instead of ↺15 / ↻30 whenever next/previous are installed — every Foray, and any episode with something in Up Next",
    "p-switcher-1: Second-order of persona 6: a full Up Next enables nexttrack, so the iOS lock screen swaps the 15/30 pair for ⏮/⏭ and the wheel's 'next' abandons the episode"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main at 9730b5b (2026-09-23) and the code matches the finding.\n\n**The chain from Up Next to the lock screen:**\n- app.js:2125-2130: `EPISODE_NAVIGATION.next` is a getter. It returns a function whenever `planAfterEnded(cur).nextId` exists, which is the case whenever Up Next has an item. `refreshEpisodeNavigation` re-reads it after every Up Next edit.\n- player/media-session.js (`mediaSessionActions`, around line 533): pushes `['nexttrack', ...]` whenever `surface.next` exists.\n- foray-media-session.js:457: sets `hasNext: installed.has(\"nexttrack\")`.\n- ForayAudioPlugin.swift, `applyCommandAvailability`: sets `nextTrackCommand.isEnabled = transportable && payload.hasNext`. It enables `skipForwardCommand` at the same moment, and writes `preferredIntervals` on every state change.\n\nSo with anything in Up Next, both the track pair and the 15/30 skip pair are enabled at once. When the last queued item starts, `hasNext` goes false and the track command turns off again.\n\n**Nothing on main addresses it:**\n- The 2026-09-23 lock-screen ruling in DECISIONS.md (items 4-6) only settles where the 15/30 numbers come from and how duplicate presses are dropped.\n- docs/ios-lock-screen.md §3.3 (lines 245-247) calls `nextTrackCommand.isEnabled` a plain boolean from `payload.hasNext` and never discusses the clash with the skip pair.\n- The ruling is not superseded, nothing fixes it, and it was not marked deliberate.\n\n**One thing makes it more likely, not less.** The same ruling makes the shim a TEE: every page handler, `nexttrack` included, is also installed on WebKit's real MediaSession. The ruling itself says WebKit's client is what the lock screen shows during tape. My recollection (not checked in this pass) is that iOS WebKit hides the seek buttons in favour of ⏮/⏭ once track handlers are set, so the swap may happen even if the native command centre would prefer skip.\n\n**What I could not verify.** The final glyph is decided by the OS, and the finding correctly says \"may\". That is the only uncertainty; the code evidence holds.\n\n**Severity: medium.** It is user-visible and hits the exact control the founder just asked to fix. It is not data loss: one ⏭ press abandons the current episode, which is recoverable.",
  "merged_ids": [
    "native-4",
    "p-car-2",
    "p-switcher-1"
  ],
  "lane": "L3-queue-and-native-surfaces"
}
```

## native-5 — iOS lock-screen timeline alternates between the source episode's clock (during tape) and the Foray clock (during narration/pause), and is draggable only in one of them

**deliberate** · verifier severity **low** (finder: medium) · native · `mobile/plugins/foray-audio/web/foray-media-session.js:1127`

```json
{
  "id": "native-5",
  "lens": "native",
  "title": "iOS lock-screen timeline alternates between the source episode's clock (during tape) and the Foray clock (during narration/pause), and is draggable only in one of them",
  "file": "mobile/plugins/foray-audio/web/foray-media-session.js",
  "line": 1127,
  "severity": "medium",
  "user_visible": "On a Foray, the lock screen progress bar reads e.g. 47:12 / 1:32:00 (the publisher's episode) during a clip, then jumps to 10:32 / 52:00 (the Foray) when the narrator speaks or when paused, then back at the next clip — 30+ times an hour. The bar can be dragged while paused/narrating but not during a clip.",
  "evidence": "foray-media-session.js:224-235 `UNMIRRORED_ACTIONS`: \"the timeline WebKit's client shows is the `<audio>` ELEMENT's -- the segment's -- while the page's `seekto` handler is on the Foray's clock\"; line 1126-1127: \"Position state is NOT forwarded and `seekto` is not mirrored\". ForayAudioPlugin.swift:671-672 writes the Foray clock into `MPNowPlayingInfoCenter`; §1 of the same file (46-53) says WebKit's entry is what shows during tape and the plugin's during narration/pause. player/media-session.js:111-127 (§3) argues precisely that a bar on the segment's clock \"reads as a broken app\".",
  "why_subtle": "Documented as a known cost in a comment, but it directly contradicts the product argument in media-session.js §3 and only shows on a real lock screen mid-Foray; the Simulator and the fake bridge cannot render it.",
  "fix_sketch": "Mirror `setPositionState` onto WebKit's real session as well (WebKit honours `MediaSession.positionState` in its Now Playing info when set; if a device shows it is overwritten by `currentTime`, then instead re-post the plugin's entry after each WebKit write so the Foray clock wins) and mirror `seekto` through the same `deliver` wrapper so the scrub is on the Foray clock on both clients. Verify on the §8.5 device check with a stopwatch against the in-app scrubber.",
  "suspected_deliberate": true,
  "relation_to_round1": "New; the tee (2026-09-23) made WebKit's entry carry the right strings but left it on the wrong clock.",
  "duplicates": [
    "p-car-9: The lock-screen scrubber is withheld from WebKit's entry for ordinary episodes too, where the element's clock is the right clock"
  ],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. foray-media-session.js:224-235 defines UNMIRRORED_ACTIONS = [\"seekto\"], and its comment says WebKit rewrites position state with the element's currentTime, so WebKit's bar runs on the element's (clip's) clock. The captureLiveSession header, around lines 1126-1127, says: \"Position state is NOT forwarded and `seekto` is not mirrored\". ForayAudioPlugin.swift's applyNowPlayingInfo writes the Foray-clock duration and position into MPNowPlayingInfoCenter. Its §1 says WebKit's own entry is what the lock screen shows during tape, and the plugin's entry is the only one during narration and while paused and held. So the behaviour described is plausible: the timeline switches clocks between tape and narration/pause, and it can only be scrubbed on the plugin's entry. I could not check on a device whether the tape bar actually shows the full episode or just the segment.\n\nIt was a deliberate choice, though. DECISIONS.md, entry dated 2026-09-23, items 4-6, rules the takeover is a TEE of metadata, playbackState and handlers only. It says `docs/ios-lock-screen.md` §2.1 and §8 \"hold the model\". The ownership table in §2.1 has an explicit row: \"WebKit's own **timeline** and scrub | WebKit's, deliberately | position state is not forwarded and `seekto` is not mirrored (`UNMIRRORED_ACTIONS`): WebKit's bar is the element's — the clip's — and the Foray-clock scrub lives on the plugin's client\". The doc also says what the design cannot promise and routes it to the §8.5 device check. It has not been fixed. It is a known, documented design limitation, and the finding flags itself as suspected-deliberate. The fix sketch's idea that WebKit honours positionState contradicts the code's own finding that WebKit overwrites it with currentTime every tick. It would need to be checked on a device before anything changes.\n\nSeverity: low. It is cosmetic and inconsistent, and WebKit's entry has no scrub during tape, so nothing lands in the wrong place. It is worth mentioning for the §8.5 device check.",
  "merged_ids": [
    "p-car-9"
  ],
  "lane": null
}
```

## perf-2 — The Search tab eagerly loads 167 six-hundred-pixel artworks into 44 px rows, with no lazy loading and no size variant

**confirmed** · verifier severity **medium** (finder: high) · perf · `app.js:5538` · L5-boot-states-storage

```json
{
  "id": "perf-2",
  "lens": "perf",
  "title": "The Search tab eagerly loads 167 six-hundred-pixel artworks into 44 px rows, with no lazy loading and no size variant",
  "file": "app.js:5538 (showResultRow img), app.js:2536 (renderShowIndexPage renders every catalogue row on the idle Search tab), styles.css:1016 (.show-result-art 44px), data/catalog-client.json (all art URLs end in /600x600bb.jpg)",
  "line": 5538,
  "severity": "high",
  "user_visible": "Opening the Search tab (a top-level tab) fires 167 image requests to mzstatic at 600×600 (~40-80 KB each: roughly 5-10 MB on cellular) and decodes 167 full-size bitmaps (~1.4 MB each decoded) to draw 44 px thumbnails; rows paint blank-then-fill in a wave, the tab feels sluggish on first open, memory spikes, and the same list repeats on Followed shows and Library. Apple Podcasts requests 100-200 px variants and lazy-loads.",
  "evidence": "showResultRow: `${art ? `<img class=\"show-result-art\" src=\"${esc(safeUrl(art))}\" alt=\"\">` : …}` — no loading=\"lazy\", no decoding=\"async\", no width/height. renderShowIndexPage: `<div class=\"show-results show-index\">${shows.map(showResultRow).join(\"\")}</div>` for all 220 catalogue rows (167 carry artwork; `node -e` count). styles.css: `.show-result-art { width: 44px; height: 44px; … object-fit: cover; }`. Every catalog-client artwork_url is `…/mza_….jpg/600x600bb.jpg`; discover.json: `{ '600x600bb': 2167 }`. Only miniCard (app.js:4661) uses loading=\"lazy\" and it still requests 600 px for a 56 px box.",
  "why_subtle": "Nothing is broken — the images arrive — so it reads as \"the Search tab is a bit slow\" rather than a bug; the cost is bandwidth, decode CPU and memory, which the founder experiences as heat and lag on the second-most-used tab.",
  "fix_sketch": "One `artUrl(url, px)` helper that rewrites the trailing `/600x600bb.jpg` token to `/100x100bb.jpg` (mzstatic honours any size) for list rows and 56 px cards, keeps 600 for the Now Playing sheet and the episode page; emit `loading=\"lazy\" decoding=\"async\" width=\"44\" height=\"44\"` on every row image (starredShowRow at 1217, showResultRow at 5538, ep-art at 8485). Optionally `content-visibility: auto` on `.show-result`.",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Round 1 touched artwork only for the mini-bar tap target (qa 10) and lift/border consistency (qa 59).",
  "duplicates": [
    "search-13: Search result artwork is eagerly loaded — a one-letter keystroke fires up to ~170 image requests, unlike the lazy Home cards"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b, and the code matches the finding. In app.js, showResultRow (line 5538) and starredShowRow (line 1217) both output a plain `<img class=\"show-result-art\" src=...>` with no loading=\"lazy\", no decoding=\"async\" and no width or height. The Search tab (tab key \"search\", route #/shows, app.js:11136) calls renderShowIndexPage(\"Search\", \"\", shows, ...) at line 2924. That function maps every catalogue show through showResultRow at line 2536 and sets the result on #view.innerHTML, so the idle Search tab builds all 220 rows at once. data/catalog-client.json has 220 shows, and 167 of them carry a 600x600bb mzstatic URL. showArtworkUrl also falls back to the discover pool's 600x600 art (the comment at line 2376 says so), so more than 167 rows may get an image. In styles.css, `.show-result-art` is 44x44 with object-fit: cover (line 1016). The only lazy image is miniCard at line 4661, and it also requests 600px. I found no size-rewrite helper: grep finds no 100x100 and no artUrl. docs/DECISIONS.md has no ruling on lazy loading or thumbnail size, so this is not deliberate, and it has not been fixed. I'd rate it medium, not high. The ~5-10 MB of eager network requests on a top-level tab is real. The claimed memory spike (167 decoded bitmaps of ~1.4 MB) is probably overstated, because WebKit usually decodes an image only when it is painted, not for off-screen rows. The result is a performance and data-cost problem, not a broken feature. The fix is small and safe: rewrite the size token to 100x100bb for rows and cards, and add loading=\"lazy\" decoding=\"async\" width/height to the row images.",
  "merged_ids": [
    "search-13"
  ],
  "lane": "L5-boot-states-storage"
}
```

## p-car-5 — Steering-wheel ◀◀ on an ordinary episode never restarts it — it jumps to the previous list row, or is greyed out — unlike the Foray's own previous and every podcast app

**confirmed** · verifier severity **medium** (finder: medium) · p-car · `app.js:2131` · L3-queue-and-native-surfaces

```json
{
  "id": "p-car-5",
  "lens": "p-car",
  "title": "Steering-wheel ◀◀ on an ordinary episode never restarts it — it jumps to the previous list row, or is greyed out — unlike the Foray's own previous and every podcast app",
  "file": "app.js",
  "line": 2131,
  "severity": "medium",
  "user_visible": "Forty minutes into episode 3 of a show, a driver taps 'previous' to hear the last sentence again (what Apple Podcasts, the car and the Foray page all do) and lands at the start of episode 2. When the episode was started from the mini bar or Jump back in, the previous button is simply dead/greyed instead of restarting.",
  "evidence": "EPISODE_NAVIGATION.previous returns null unless the current episode is in state.playList with a playable row before it, and otherwise returns `() => startChained(prev, \"skip\")` with no restart window (app.js:2131-2142); mediaSessionActions omits `previoustrack` when the surface method is absent (media-session.js:512-532). By contrast forayPrevious restarts the clip unless `into < RESTART_WINDOW_SEC` (client.js:3822-3837, RESTART_WINDOW_SEC = 4 at :3861) and the manager already has `skipToPrevious()` = restart in place (queue-manager.js:704-712, spec 'prevTrack = restart item / previous'). The episode surface never calls it.",
  "why_subtle": "Two 'previous' semantics live in the same app one screen apart; the lock screen inherits whichever surface installed last. The review that added EPISODE_NAVIGATION (2026-09-23) fixed 'greyed out with a full Up Next' and did not ask what previous means with an empty one.",
  "fix_sketch": "Give the episode surface the Foray rule: previous = manager.skipToPrevious() when more than RESTART_WINDOW_SEC into the episode, else the previous list row if any; always install `previoustrack` for an episode so the button is never dead. (Reconcile with finding 2 on iOS: restart belongs to the skip pair there, so the track command can stay off on the lock screen and only serve CarPlay/headset.)",
  "suspected_deliberate": false,
  "relation_to_round1": "extends persona 6 (steering-wheel next/previous dead) — that fix made the buttons live without giving previous its podcast meaning.",
  "duplicates": [
    "p-switcher-8: Steering-wheel/lock-screen ⏮ on an ordinary episode has no restart window — it leaves the episode 40 minutes in"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the evidence holds. In app.js, `EPISODE_NAVIGATION.previous` (around lines 2131-2142) finds the current episode's index in `state.playList` and returns null unless an earlier playable row exists. When one does, it returns a handler that sets the chain and cursor to that row and calls `startChained(prev, \"skip\")`. It never checks the playhead position, so there is no restart window.\n\nIn player/client.js, `episodeMediaSurface.previous` is a getter that returns `episodeNeighbour(\"previous\")`. That is null when the page has nothing to offer, and `mediaSessionActions` in media-session.js then leaves out `previoustrack`, so the button is greyed out.\n\nThe comment on `setPlayList` says outright that a play started from the mini bar, a Foray or Jump back in's own card leaves a list that does not contain the episode. So the \"dead button\" half of the finding holds too. The ordinary episode never reaches the restart-in-place path: neither `manager.skipToPrevious()` (queue-manager.js:700-712, \"prevTrack = restart item / previous\" per 04_VOICE_AUDIO_SPEC) nor the `RESTART_WINDOW_SEC = 4` rule that `forayPrevious` uses (client.js:3822-3861).\n\nNo docs/DECISIONS.md ruling makes previous-means-previous-row deliberate. The 2026-09-14 ruling covers continuous playback and next. The 2026-09-23 entries cover the 15/30 seek and lock-screen ownership. The comment on the persona-58 row calls \"previous restarts the clip\" the convention every player uses. Nothing says an episode's previous should skip the restart.\n\nOn iOS the lock screen itself may show the skip pair instead of track buttons. The car's steering wheel and CarPlay track controls still send previous-track, so a driver will notice. Medium: annoying and against the podcast convention while driving, but nothing is lost, because the listener can seek back or resume.",
  "merged_ids": [
    "p-switcher-8"
  ],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-car-6 — At the end of the last episode with nothing queued, the lock screen and car go completely blank and every wheel button is dead — Apple keeps the finished episode paused and playable

**confirmed** · verifier severity **medium** (finder: medium) · p-car · `player/media-session.js:469` · L1-player-transport

```json
{
  "id": "p-car-6",
  "lens": "p-car",
  "title": "At the end of the last episode with nothing queued, the lock screen and car go completely blank and every wheel button is dead — Apple keeps the finished episode paused and playable",
  "file": "player/media-session.js",
  "line": 469,
  "severity": "medium",
  "user_visible": "Once finding 1 is fixed: the episode you started from Jump back in or the mini bar ends (no list, Up Next empty), the head unit shows nothing for 4a, the car reverts to Spotify/radio, and pressing play on the wheel or a headset pinch does nothing. To hear anything from 4a again you must unlock the phone. Apple Podcasts leaves the finished episode on the lock screen, paused; play restarts it.",
  "evidence": "mediaPlaybackState returns NONE for ended ('a finished Foray is not a paused one, and a play button that cannot do anything is worse than none', media-session.js:465-472); the shim maps that to 'ended' and the Swift then writes `center.nowPlayingInfo = nil` and disables every command including togglePlayPause (`transportable = payload.state != .none && payload.state != .ended`, Swift 994-1011). But for an ordinary episode play CAN do something: setRunning(true) → manager.resume() → handlePlay from `ended` reloads the item (queue-state.js:311-313) at resumeOffset 0 (position-store.js:98) — a clean restart. The 'no list' case is common by design: 'A play started anywhere that is not a row list (the mini bar, a Foray, Jump back in's own card) … stops' (app.js:2052-2057).",
  "why_subtle": "The NONE rule was argued for Forays in 2026-08 and silently extended to episodes; the 2026-09-22 audit then made play-from-ended meaningful ('Start over') without revisiting what the OS surface offers.",
  "fix_sketch": "Report `paused` (with the OS elapsed at the end) rather than `none` for a finished ordinary episode, keeping NONE for a finished Foray if that ruling stands; on the iOS side hold the session through it (sessionMove currently only holds on playing→paused). Consider the same for a finished Foray now that play from ended means 'start over' (2026-09-22 audit).",
  "suspected_deliberate": true,
  "relation_to_round1": "relative of qa 39 (finished Foray: page said Resume, lock screen showed no transport) — that fix changed the page button, not the lock screen.",
  "duplicates": [
    "p-switcher-10: When the last episode ends the OS transport is dropped entirely (playbackState NONE), so the car and lock screen go blank at the end of a list"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main 9730b5b and it matches the finding.\n\n**The chain in the code:**\n- In `player/media-session.js:465-471`, `mediaPlaybackState` returns NONE whenever `ended` is true. The only reason given is a Foray one: \"a finished Foray is not a paused one, and a play button that cannot do anything is worse than none.\"\n- The ordinary-episode branch in `player/client.js` (around line 2358) passes `ended: manager?.state?.type === \"ended\"` too. So ordinary episodes hit the same NONE path.\n- The shim's `transportState` (`mobile/plugins/foray-audio/web/foray-media-session.js:397`) turns \"none\" into \"ended\".\n- In `ForayAudioPlugin.swift`, `applyCommandAvailability` sets `transportable = state != .none && state != .ended`, which disables play, pause, togglePlayPause, next, previous, the skips and scrubbing. `nowPlayingInfo = nil` is the documented behaviour for `.none` (`docs/ios-lock-screen.md` §2.3 and line 261).\n\n**The rationale is false for an ordinary episode.** From `ended`, `handlePlay` reloads the item (`queue-state.js:311-313`). `resumeOffset` returns 0 near the end (`position-store.js:98`), so pressing play would restart the episode cleanly.\n\n**The case is common.** `app.js:2052-2057` says a play started from the mini bar, a Foray or Jump back in's own card stops at its end.\n\n**Deliberate?** Only in part. `docs/ios-lock-screen.md` §2 and §3.1 and the Android doc rule that a *finished Foray* reports \"none\". I found nothing in `docs/DECISIONS.md` that extends this to ordinary episodes. The 2026-09-23 lock-screen ownership entry covers holding the session on pause only. The Foray premise is also stale now: `client.js:2036` makes play on an ended Foray start over (audit 2026-09-22). That entry's hold also happens only on playing → paused, so nothing holds the car after the end.\n\n**Not fixed.** Neither this nor its duplicate (p-switcher-10) is fixed at origin/main.\n\n**What I could not check:**\n- I did not test on a device whether the head unit really goes blank. WebKit's own tee'd Now Playing entry also gets \"none\", so it would most likely drop as well.\n- The finding's \"once finding 1 is fixed\" condition is outside this check.\n\n**Why medium:** a car at the end of a list with a dead wheel is a core hands-free failure, but it happens only at the end of a list.",
  "merged_ids": [
    "p-switcher-10"
  ],
  "lane": "L1-player-transport"
}
```

## p-first-11 — The now-permanent Foray explanation promises "a narrator between them" directly above the only Foray a newcomer can play, which has no narration; the returning-user popup adds a stretch Foray that cannot exist

**confirmed** · verifier severity **low** (finder: low) · p-first · `app.js:4684` · L8-foray-surfaces

```json
{
  "id": "p-first-11",
  "lens": "p-first",
  "title": "The now-permanent Foray explanation promises \"a narrator between them\" directly above the only Foray a newcomer can play, which has no narration; the returning-user popup adds a stretch Foray that cannot exist",
  "file": "app.js",
  "line": 4684,
  "severity": "low",
  "user_visible": "Forays page subtitle: \"…played in turn from the show's own feed, with a narrator between them.\" One row below: \"The types of capital a startup can raise\", 22 clips, zero narration (data/forays.json: the four narrated Forays are all drafts). The intro popup for anyone who is not a genuine first-timer says \"The forays and the episodes each include one pick outside your usual subjects\" — with one published Foray, pickWithStretchFloor can never mark a Foray stretch.",
  "evidence": "`const FORAY_ABOUT = \"… with a narrator between them.\"` (app.js:4684) rendered by `renderForays` as `<p class=\"note fy-about\">` (7957) and in the Welcome sheet (5346); data/forays.json: capital-types-1 published, items 22, narration 0. `showIntroPopupOnce` copy at 5491; `pickWithStretchFloor` returns `stretchIndex: -1` when there is one branch (7545-7556).",
  "why_subtle": "The persona-18/45 fix multiplied the sentence from a one-shot sheet to a permanent page, so the persona-14 mismatch is now on screen every visit, not once.",
  "fix_sketch": "Until a narrated Foray is published (founder question 19), hedge FORAY_ABOUT (\"often with a narrator between them\") or make the subtitle data-driven from `r.playable` narration counts; drop \"The forays … each include\" from the popup while listable Forays span one subject root.",
  "suspected_deliberate": true,
  "relation_to_round1": "Second-order of persona 18/37/45/83 (fixed) × persona 14 (deferred-founder).",
  "duplicates": [
    "p-foray-11: The one sentence that explains a Foray promises 'the best moment of each episode' - the published Foray plays four clips from one episode"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked the code and data at origin/main and the finding holds.\n\n1. app.js:4684 defines FORAY_ABOUT = \"One subject, heard across several podcasts: the best moment of each episode, played in turn from the show's own feed, with a narrator between them.\" `renderForays` shows it at the top of the Forays page as `<p class=\"note fy-about\">` (7957), and the Welcome sheet shows it too (5346).\n\n2. data/forays.json has 7 Forays and only capital-types-1 is published. It has 22 segment items and no narration items, all from one episode. The four Forays with narration items (38-40 each) all have status draft.\n\n3. Only published Forays are listed unless the viewer has unlocked one or turned on `cp_show_drafts`. `cp_show_drafts` defaults to false and is the founder's test-track switch (9061, 9124). So a normal user sees the \"narrator between them\" promise above a single Foray that has no narration.\n\n4. The popup in `showIntroPopupOnce` (5491) says \"The forays and the episodes each include one pick outside your usual subjects, on purpose.\" `foraysForYouHtml` (7808) passes the listed Forays to `pickWithStretchFloor` grouped by topic root. With one candidate there is only one branch, so topCount = max(1, ceil(0.6)) = 1 and no branch is left over for a stretch pick. It returns stretchIndex -1, and the Forays row can never have a stretch pick. The code comment above the popup string (5484-5490) assumes the Forays row has a stretch pick, which suggests the author overlooked this rather than chose it.\n\n5. DECISIONS.md lists persona 14 (\"a narrated published Foray\") as still deferred-founder. That ruling is about whether to publish a narrated Foray. It does not approve copy that promises a narrator before one exists, so this is not 'deliberate'.\n\nSeverity is low because this is wrong copy only; nothing breaks. It overlaps the listed duplicate p-foray-11 (\"best moment of each episode\" when the published Foray plays clips from one episode).",
  "merged_ids": [
    "p-foray-11"
  ],
  "lane": "L8-foray-surfaces"
}
```

## touch-1 — Hold-and-drag scrub on the Foray strip never commits on a touchscreen: the seek is delegated to a `click` that no mobile browser fires after a moved touch

**confirmed** · verifier severity **high** (finder: high) · touch · `app.js:10572` · L2-sheets-drawer-gestures

```json
{
  "id": "touch-1",
  "lens": "touch",
  "title": "Hold-and-drag scrub on the Foray strip never commits on a touchscreen: the seek is delegated to a `click` that no mobile browser fires after a moved touch",
  "file": "app.js:10559-10572 (click handler), app.js:10220-10238 (pointerup/touchmove), player/strip-scrub-gesture.js:20-33 (the design claim)",
  "line": 10572,
  "severity": "high",
  "user_visible": "On the Foray page, press and hold the timeline: the strip zooms and the magnifier bubble follows the thumb. Drag to the second you want and lift. Nothing happens: the Foray keeps playing where it was, the resume line does not move, the bubble just disappears. Only a stationary press-release (no drag) jumps. A mouse on a desktop does commit, which is why it looks finished.",
  "evidence": "player/strip-scrub-gesture.js:20-33: \"WHY THE SEEK IS NOT HERE … A `click` still fires, at the release coordinate, after a `pointerup`/`touchend` that never left the element -- so 'commit wherever the finger ended' falls out of the platform for free, for a plain tap AND for a held-and-dragged gesture alike.\" app.js:10220-10222 `strip.addEventListener(\"pointerup\", (e) => { … finish(); });` seeks nothing; app.js:10559-10572 is the only commit path: `$(\"#fy-strip\").addEventListener(\"click\", async (e) => { … const at = stripElapsedAt(e, r); if (at != null) { if (playerHasForay(r)) return guardForayTap(() => player.foraySeek(at)); …`. And app.js:10236-10238 makes it worse on iOS: `strip.addEventListener(\"touchmove\", (e) => { if (gesture && gesture.zooming …) e.preventDefault(); }, { passive: false });` — a cancelled touchmove is the second thing (after movement past tap slop) that suppresses WebKit's synthetic click. Chrome/Android fires GestureTapCancel once a touch moves past slop regardless of touch-action, so no click there either. No Playwright spec touches the strip (test/playwright/tests has only search specs) and no doc records a device check of the seek-on-release, only of the bubble (\"Joey, live iPhone testing: … there's a bubble view that pops up\").",
  "why_subtle": "Every visible part of the gesture works (zoom, bubble, marker), so it reads as a complete feature; the one invisible step is a platform assumption that holds for a mouse and fails for a finger. Round 1 (qa 1, qa 22, persona 8) all reasoned from the same 'a click follows the release' premise and fixed things around it rather than testing it.",
  "fix_sketch": "Commit on `pointerup` when `gesture.zooming` was true: compute the position from the pointer's clientX against `preZoomRect` (the pre-zoom box the zoom math already uses), mapped through the zoom origin, and call the same `foraySeek`/`startAt` path; set `strip._scrollGesture`-style suppression so a trailing click (mouse) does not seek twice. Do NOT compute from `getBoundingClientRect()` at release: `clearZoomVisual()` has already removed `.is-zooming`, and under `prefers-reduced-motion` (`.fy-strip { transition: none }`, styles.css:2466) the rect is the un-zoomed one while the finger is in zoomed space, so a drag would land off by up to the 2.5x factor. Pin with a test that a zooming gesture's pointerup seeks.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order to qa 1 / qa 22 / persona 8, all of which assumed the click-after-release path works on touch.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I checked origin/main at 9730b5b, which includes #746. The code matches the finding.\n\n- **Release does not seek.** In bindStripZoomScrub (app.js ~10220), `pointerup` only calls `finish()`, and `finish()` clears the hold timer, ends the gesture, removes `.is-zooming` and closes the bubble. Nothing there seeks.\n- **The click handler is the only place that commits a position.** At app.js 10559-10575 it checks `_scrollGesture`, then calls `stripElapsedAt(e, r)`, then `foraySeek` or `startAt`.\n- **The design depends on a click that touch does not send.** player/strip-scrub-gesture.js lines 20-31 say a `click` \"falls out of the platform for free... for a held-and-dragged gesture alike\". That is false on touch. WebKit (iOS Safari and WKWebView) and Chrome on Android both drop the synthetic click once a touch moves past tap slop. The drag that enters zoom must move at least MOVE_TOLERANCE_PX = 10px, which is about the size of that slop.\n- **The touchmove listener adds a second reason on iOS.** The non-passive `touchmove` listener calls `preventDefault()` while the strip is zoomed, and a cancelled touchmove also stops WebKit from firing the click. That listener came from the 2026-09-23 review, and its own comment says it exists so the scrub is not \"ended... with no seek\". The authors plainly expected a seek on release, so this is not deliberate.\n\nWhat the user sees: a hold-and-drag on a phone shows the zoom and the bubble, then does nothing when the finger lifts. A mouse still commits, because desktop browsers fire click after a drag that ends on the same element.\n\nTests don't catch it. test/modal-and-focus.test.js fires `pointerup` on the strip only to check the scroll-suppression flag and the touchmove cancel. No test says that releasing a zoomed gesture seeks. docs/DECISIONS.md has no ruling on strip scrubbing. Nothing at origin/main fixes it.\n\nSeverity is high because this is the headline gesture of the scrub feature and it does nothing on the main platform, the iPhone app/webview. The fix sketch's warning about using the pre-zoom rect instead of the rect at release, because of `clearZoomVisual` and reduced motion, also looks correct.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## touch-2 — Pull-down-to-dismiss the Now Playing sheet only works from the 48px grab strip: the 'anywhere in the body at scrollTop 0' path cannot work on a phone because `pointermove.preventDefault()` does not stop a touch scroll

**confirmed** · verifier severity **medium** (finder: high) · touch · `player/client.js:2583` · L2-sheets-drawer-gestures

```json
{
  "id": "touch-2",
  "lens": "touch",
  "title": "Pull-down-to-dismiss the Now Playing sheet only works from the 48px grab strip: the 'anywhere in the body at scrollTop 0' path cannot work on a phone because `pointermove.preventDefault()` does not stop a touch scroll",
  "file": "player/client.js:2557-2602 (drag wiring), styles.css:2007-2016 (.fp-sheet-scroll has no touch-action)",
  "line": 2583,
  "severity": "high",
  "user_visible": "Open Now Playing, put a thumb on the big artwork or the title and pull down, as in Apple Podcasts. The sheet twitches a few pixels (or not at all), the scroller rubber-bands, and the sheet springs back. Only a pull that starts on the thin handle row directly under the top bar closes it. The founder's own request was to 'drag that page down from the top'; the artwork is where a thumb goes.",
  "evidence": "player/client.js:2573-2583: `ui.sheet.addEventListener(\"pointermove\", (e) => { … setSheetDragOffset(offset); /* … `touch-action: none` on the grab zone covers a drag that STARTED there; this covers one that started on the body at scrollTop 0, which the scroller would otherwise rubber-band. */ if (offset > 0 && e.cancelable) e.preventDefault(); });` — per the Pointer Events spec, preventDefault on pointermove has no effect on the browser's pan; only `touch-action` or a non-passive `touchmove` cancel does. styles.css:2007-2012 `.fp-sheet-scroll { … overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; …}` declares no touch-action (the only touch-action lines in the file are 317, 1205, 1869, 1987, 2004, 2080, 2215, 2258, 2450, 2549, 2691). So once the finger passes the browser's slop the pan starts, iOS and Chrome fire `pointercancel`, and client.js:2597-2602 springs back: `ui.sheet.addEventListener(\"pointercancel\", (e) => { … setSheetDragOffset(0); });`. The comment at client.js:2543-2547 ('LISTENERS ARE ON THE WHOLE SHEET … because Apple's sheet comes down when you pull anywhere in a body that is already at the top') states the intent that does not ship.",
  "why_subtle": "Works with a mouse in desktop Chrome (no pan to compete), so every test and manual check passes; on a device the gesture 'sort of' responds (the first 8-10px), which reads as flaky rather than broken. It is also the same class of mistake as finding 1 (pointer events vs touch defaults).",
  "fix_sketch": "Add a non-passive `touchmove` listener on `ui.sheet` (same pattern as app.js:10236 for the strip): when `drag && drag.allowed` and the first move past slop is downward, call `e.preventDefault()` for the rest of the sequence so the scroller never gets the pan; when the first move is upward, do nothing and let the scroller scroll. Alternatively toggle `touch-action: none` on `.fp-sheet-scroll` only while `scrollTop === 0` AND handle upward moves by not engaging — the touchmove route is simpler. Keep the pointer listeners for mouse.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order to the 2026-09-13 drag-dismiss (#682) and qa 19; the eligibility rule was fixed but the body path never worked on touch.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The code at origin/main matches the finding. In player/client.js (about lines 2557-2602) the sheet listens only for pointer events, and the one attempt to stop the scroller is `if (offset > 0 && e.cancelable) e.preventDefault();` inside pointermove. On a phone that does not stop a scroll. Under the Pointer Events spec, calling preventDefault on pointermove has no effect on panning; only touch-action or a non-passive touchmove cancel does. Nothing on the body path does either:\n- grep finds no touchmove or touchstart listener anywhere in client.js.\n- `.fp-sheet-scroll` (styles.css ~2007) sets overflow-y:auto and overscroll-behavior:contain but no touch-action.\n- `.fp-sheet` sets none either. The only touch-action:none nearby is `.fp-grab-zone` (line 1987, the 48px strip).\n\nSo a downward pull that starts on the artwork or title at scrollTop 0 is claimed by the browser as a pan once the finger passes the slop threshold. The browser then fires pointercancel, and the pointercancel handler resets the offset to 0, so the sheet springs back.\n\nThe repo already knows this mechanism and uses the correct fix elsewhere. app.js ~10236 adds a non-passive touchmove listener with the comment \"Cancelling the touchmove ... is the one way `pan-y` still allows to keep the page still. NON-passive, or the browser ignores the cancel.\" The sheet's own design comment (client.js ~2543) says a pull anywhere in the body at the top should dismiss the sheet, so this is not deliberate. docs/DECISIONS.md names the drag handle and the ✕ as the sheet's ways out and has no ruling that limits dragging to the handle. Nothing at origin/main fixes it, including the latest client.js commit #746.\n\nSeverity: medium rather than high. The 48px grab strip at the top still dismisses by drag, and the ✕ still works, so the user is never stuck. The founder's words, \"drag that page down from the top\", are arguably met by the strip. What the user sees is a gesture that fails on the largest surface, which is a real annoyance on the main playback screen but does not block anything.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## touch-3 — Long-press on any stretched-link card or episode row opens WKWebView's link preview of `capacitor://localhost/#/…` — the new stretched-link pattern made this the whole card face

**confirmed** · verifier severity **low** (finder: medium) · touch · `styles.css:1248` · L7-styles-touch-visual

```json
{
  "id": "touch-3",
  "lens": "touch",
  "title": "Long-press on any stretched-link card or episode row opens WKWebView's link preview of `capacitor://localhost/#/…` — the new stretched-link pattern made this the whole card face",
  "file": "styles.css:1244-1262 (.ep-title-link stretched), styles.css:802-806 (.mc-link), styles.css:3827-3832 (.hv2-jbi-link); mobile/capacitor.config.json (no `ios.allowsLinkPreview: false`)",
  "line": 1248,
  "severity": "medium",
  "user_visible": "Rest a thumb on a Home subject card, an episode row, or a 'Jump back in' card for half a second (which happens while scrolling a long list) and iOS pops the Safari-style peek: a rendered preview of the app booting at an internal URL plus 'Open / Copy Link / Share…' for `capacitor://localhost/#/episode/…`. Apple Podcasts shows a context menu of actions (Play Next, Save…). Nothing in the app has `-webkit-touch-callout: none` and no rule sets `-webkit-tap-highlight-color`.",
  "evidence": "styles.css:1247-1249 explicitly counts on it: \"The title link's ::after now covers the whole `.info` block (the \\\"stretched link\\\" pattern — still one real `<a href>`, so long-press and open-in-new-tab keep working)\". `.ep-row .ep-title-link::after { content: \"\"; position: absolute; inset: 0; }` (1262), `.mc-link::after { … inset: 0; }` (806), `body.ui-v2 .hv2-jbi-link::after { … inset: 0; }` (3831). grep for `touch-callout` and `tap-highlight` in styles.css returns nothing; mobile/capacitor.config.json declares `zoomEnabled` and `SplashScreen` only — Capacitor's `ios.allowsLinkPreview` defaults to true. app.js binds no `contextmenu` handler (grep).",
  "why_subtle": "On the web, 'long-press keeps working' is a virtue; in the shell it exposes the routing scheme and a stale second copy of the app. Round 1 (qa 78) introduced the pattern for a11y and never looked at it from the native side. It only shows on a hold, which testers rarely do on purpose.",
  "fix_sketch": "Set `ios.allowsLinkPreview: false` in mobile/capacitor.config.json (recorded as a decision like `zoomEnabled`), and add `-webkit-touch-callout: none; -webkit-user-select: none;` to `.mc-link, .ep-title-link, .hv2-jbi-link, .hv2-foray-card, .fy-home-row, .pl-row, .show-link, .tab-btn` (or on `a` inside `body.ui-v2`). Optionally set `-webkit-tap-highlight-color: transparent` on the page and rely on the authored `:active` states. Update the comment at styles.css:1247-1249.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order to qa 78 (stretched-link cards).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked every cited fact against origin/main and all of them hold. styles.css defines `.mc-link::after { content:\"\"; position:absolute; inset:0; }` at about line 806, `.ep-row .ep-title-link::after { … inset:0; }` at about line 1262, and `body.ui-v2 .hv2-jbi-link::after { … inset:0; }` at about line 3831. The comment at lines 1247-1249 says the stretched link keeps \"long-press and open-in-new-tab … working\". Running git grep across the whole repo finds no `-webkit-touch-callout`, no `-webkit-tap-highlight-color` in the shipped CSS (it appears only in the docs/ux prototypes), no `allowsLinkPreview`, and no `contextmenu` handler in app.js. mobile/capacitor.config.json sets only `zoomEnabled`, the ios/android paths and SplashScreen. Capacitor iOS leaves `allowsLinkPreview` true unless it is turned off, so in the native iOS app a long-press on any of these cards shows WKWebView's link peek and menu for a `capacitor://localhost/#/…` URL.\n\nNo ruling in docs/DECISIONS.md covers link previews. The founder-ruling entry near line 120 approves qa 78 (the stretched-link cards) but says nothing about long-press or link-preview behaviour. The CSS comment treats long-press as a feature, but it reads as written for the web: open-in-new-tab makes no sense inside the Capacitor shell, so this is an unconsidered side effect, not a deliberate choice.\n\nI'm lowering severity to low for three reasons:\n1. A scrolling touch moves, and movement cancels the long-press, so \"happens while scrolling\" overstates how often it fires. It takes a deliberate press-and-hold.\n2. The peek was already possible on the bare `<a>` titles before this change; the stretched link only widened the area that triggers it.\n3. It is an odd, non-native affordance but it breaks nothing. The fix is still cheap: set `ios.allowsLinkPreview: false` and/or add `-webkit-touch-callout: none` on these links.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## touch-4 — Every sheet in the app paints a drag handle, but only the Now Playing sheet answers a drag — eight false affordances

**confirmed** · verifier severity **low** (finder: medium) · touch · `styles.css:2925` · L2-sheets-drawer-gestures

```json
{
  "id": "touch-4",
  "lens": "touch",
  "title": "Every sheet in the app paints a drag handle, but only the Now Playing sheet answers a drag — eight false affordances",
  "file": "styles.css:2925-2928 (.fy-grab); player/client.js:1885 (rate picker); app.js:5279, 5474, 9523, 10654, 11821, 12171, 12530 (reason, feedback, delete, voice, playlists, diagnostics, first-run sheets)",
  "line": 2925,
  "severity": "medium",
  "user_visible": "The playback-speed picker, the 'What missed?' reason sheet, feedback, Delete my data, Narration voice, Playback diagnostics and the first-run sheet all show the same 38x4px pill at the top. Pulling it down does nothing; the panel (which is `overflow-y: auto`) scrolls or rubber-bands instead. Having learned on Now Playing that the pill means 'drag me', the listener finds it is decoration everywhere else and must find the scrim or a Cancel button.",
  "evidence": "`.fy-grab { width: 38px; height: 4px; margin: 6px auto 12px; border-radius: var(--radius-pill); background: var(--line); }` (styles.css:2925-2928) is appended by `panel.append(grab, title, list, actions)` in client.js:1912 and `ddEl(\"div\", \"fy-grab\")` at the seven app.js sites. The only pointerdown/pointermove listeners in the codebase are on `ui.sheet` (client.js:2557) and `#fy-strip` (app.js:10163); no `.fy-sheet`/`.fy-panel` has any. client.js:773-778 even says the handle is 'reused by class … so a fifth sheet in this app cannot look like a different product' — the look is shared, the behaviour is not.",
  "why_subtle": "Each sheet is fine in isolation; the mismatch only shows once the Now Playing sheet taught the gesture (2026-09-13) and the visual pass made the pill the app's one sheet silhouette.",
  "fix_sketch": "Either wire `sheet-drag-dismiss.js` to the sheet owner (`openSheet` in app.js:5093 knows `panel` and `requestClose`; add pointer + non-passive touchmove listeners on the panel with `fromHandle || panel.scrollTop <= 0`, translateY on the panel, and call `entry.requestClose()` on dismiss), or drop `.fy-grab` from sheets that cannot be dragged. The first matches Apple Podcasts; a one-line shared binder in the owner is the cheaper of the two given the owner already centralises open/close.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order to the Now Playing drag-dismiss and to E ('nothing owns a modal') which was fixed by the sheet owner but not extended to gestures.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the evidence holds. In styles.css, lines 2925-2928 define `.fy-grab` as the 38x4 pill, and `.fy-panel` at 2915-2924 has `overflow-y: auto`. The pill is added at player/client.js:1885, inside openRatePicker. That sheet is a new `.fy-sheet` appended to document.body, not a child of ui.sheet, so the pointerdown drag listener on ui.sheet at client.js:2557 never sees it. The pill is also added at seven places in app.js: 5279, 5474, 9523, 10654, 11821, 12171 and 12530.\n\nA git grep shows that only player/client.js:122 imports sheet-drag-dismiss.js; app.js never uses it. The pointer and touch listeners in app.js are on `#fy-strip` (10163 and 10236) plus a document-level pointerdown at 3280 that has nothing to do with dragging, and there are none on `.fy-panel` or `.fy-sheet`. openSheet at app.js:5093 contains no drag, pointer or swipe code. The comment at client.js:773-778 confirms the handle is shared \"by class\" so every sheet looks the same, but the drag behaviour was not shared.\n\ndocs/DECISIONS.md only mentions the drag handle as one of the Now Playing sheet's two ways out (around line 136). It has no ruling that says the handle is only decoration on other sheets, so this is not deliberate. It has not been fixed.\n\nI set severity to low rather than medium. Every one of these sheets can still be closed with the scrim tap, a Cancel button or the owner's Escape handling, and nothing is lost or broken. The cost is a misleading visual cue that is inconsistent with Now Playing.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## touch-5 — Incomplete fix of theme F (tap-target rule): Follow, every sheet's Cancel/primary button, 'Show all', the interest reset and the shell-notice ✕ are 26-41px and outside the rule

**confirmed** · verifier severity **medium** (finder: medium) · touch · `styles.css:354` · L7-styles-touch-visual

```json
{
  "id": "touch-5",
  "lens": "touch",
  "title": "Incomplete fix of theme F (tap-target rule): Follow, every sheet's Cancel/primary button, 'Show all', the interest reset and the shell-notice ✕ are 26-41px and outside the rule",
  "file": "styles.css:350-370 (the :where() list), 822-834 (button.show-star), 3029-3047 (.fy-sheet-cancel/.fy-sheet-go), 1328-1331 (.lib-more), 1210-1214 (.interest-reset), 1113-1120 (#shell-notice-dismiss)",
  "line": 354,
  "severity": "medium",
  "user_visible": "On a show page the 'Follow' capsule is ~39px tall; on every reason/feedback/delete/voice/rate sheet 'Cancel' is ~38px and the primary button ~41px; Library's 'Show all' is ~40px; the Interests page's per-row 'Reset' is ~26px; the shell notice's ✕ is ~30px. These are the controls that confirm a delete, send feedback, or dismiss a notice — exactly the ones the rule was written for — and they miss more often than the rows around them.",
  "evidence": "The rule's enumeration (styles.css:350-354): `:where( .topbar button, button.star, .play-btn, button.up-next, button.reorder, button.up-next-remove, .fy-thumb, .fp-grab-zone .fp-close, .fp-rate, .fp-stop, .fp-openep, .voice-row-audition, .fy-chip ) { position: relative; }` — none of the five below appear. `button.show-star { … padding: 10px 16px; … font-size: var(--fs-md); }` (822-834) with `--fs-md: 0.9rem` (styles.css:53) and no min-height ⇒ ≈ 10+10+17+2 = 39px. `.fy-sheet-cancel { padding: 10px 16px; … font-size: var(--fs-sm); }` (3029-3037) ⇒ ≈ 38px; `.fy-sheet-go { padding: 11px 16px; … font-size: var(--fs-md) }` ⇒ ≈ 41px. `.lib-more { display: block; … padding: 10px; … font-size: var(--fs-sm) }` (1328-1331) ⇒ ≈ 40px. `.interest-reset { … font-size: var(--fs-sm); padding: 4px 8px; }` (1210-1214) ⇒ ≈ 26px. `#shell-notice-dismiss { … font-size: var(--fs-xl); line-height: 1; padding: 6px 4px; }` (1113-1120) ⇒ ≈ 30px. test/tap-targets.test.js enumerates only the controls the audit measured (its header says so), so none of these are pinned.",
  "why_subtle": "The rule and its test are scoped to the 14 controls round 1 happened to measure, so the codebase now reads as if the floor is universal. The misses are in secondary chrome that testers hit with a mouse.",
  "fix_sketch": "Add `button.show-star, .fy-sheet-cancel, .fy-sheet-go, .lib-more, .interest-reset, #shell-notice-dismiss` to the `:where()` list (each has a free `::after`; `.lib-more` is `display:block` so give it `min-height: 44px` instead), and extend test/tap-targets.test.js to walk every `button` / `.as-btn` / `[role=button]` selector in styles.css rather than a hand list.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of theme F (qa 4-6, 15-20).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read styles.css at origin/main and the finding holds. The hit-area rule's `:where()` list (lines 350-354 and 357-361) names exactly: .topbar button, button.star, .play-btn, button.up-next, button.reorder, button.up-next-remove, .fy-thumb, .fp-grab-zone .fp-close, .fp-rate, .fp-stop, .fp-openep, .voice-row-audition and .fy-chip. None of the six reported controls is in it.\n\nEach control's own CSS, checked line by line:\n- `button.show-star` (822-834): padding 10px 16px, 1px border, font-size var(--fs-md) = 0.9rem, no min-height. That works out to about 39px.\n- `#shell-notice-dismiss` (1113-1120): overrides `.shell-notice button` with border none, padding 6px 4px, font-size 1.15rem, line-height 1. About 30px.\n- `.interest-reset` (1210-1214): padding 4px 8px, font-size 0.82rem, 1px border. About 26px.\n- `.lib-more` (1328-1331): display block, padding 10px, font-size 0.82rem. About 40px.\n- `.fy-sheet-cancel` (3029-3037): about 38px.\n- `.fy-sheet-go` (3038-3047): about 41px.\n\nThe only `body.ui-v2` overrides (3453-3459, 3615-3624, 3737-3738) change colour and border. None adds min-height, and no other rule sets a 44px minimum on these selectors. All six classes and IDs are used in app.js, so real users see these controls.\n\ntest/tap-targets.test.js says in its header that it only lists \"the controls the audit measured\", so nothing pins these six. docs/DECISIONS.md names tap-targets.test.js as part of the design system but has no ruling that exempts these controls. It is not deliberate, and it has not been fixed.\n\nSeverity is medium: most of these miss 44px by only 3-6px, but the Interests reset (about 26px) and the notice ✕ (about 30px) miss badly, and the sheet buttons are the ones that confirm deletes and send feedback.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## touch-6 — Incomplete fix of qa 12: the show link inside the stretched episode row is a ~13px-tall target with no hit area, so a thumb aimed at the show name opens the episode (or vice versa)

**confirmed** · verifier severity **low** (finder: medium) · touch · `styles.css:1263` · L7-styles-touch-visual

```json
{
  "id": "touch-6",
  "lens": "touch",
  "title": "Incomplete fix of qa 12: the show link inside the stretched episode row is a ~13px-tall target with no hit area, so a thumb aimed at the show name opens the episode (or vice versa)",
  "file": "styles.css:1262-1263 (.show-link lifted above the stretched ::after), 1271 (.show-link), 1237 (.ep-row .s)",
  "line": 1263,
  "severity": "medium",
  "user_visible": "In any episode list, the second line of a row reads 'The Daily · 32 min · 12 Sep'. 'The Daily' is underlined and goes to the show page; the rest of the row (including the 4px above and below that text) is the episode link. A thumb centred on 'The Daily' lands outside the 13px text box roughly a third of the time and opens the episode instead — the reverse of the round-1 complaint, now with the odds flipped.",
  "evidence": "`.ep-row .ep-title-link::after { content: \"\"; position: absolute; inset: 0; }` (1262) then `.ep-row .info .show-link { position: relative; z-index: 1; }` (1263) — the exception is lifted but given no size: `.show-link { color: inherit; text-decoration: underline; text-underline-offset: 2px; }` (1271) inside `.ep-row .s { font-size: var(--fs-sm); … }` (1237) with `--fs-sm: 0.82rem` ≈ 13px text on a 1.4 line-height (≈18px line). Compare `.ep-ts` (2128-2138), which got `padding: 10px 4px; margin: -10px -4px` for exactly this reason in the same lane.",
  "why_subtle": "The row now looks like one target and mostly behaves like one; the one nested link inside it has no visual boundary except an underline, so a miss is read as 'the app opened the wrong thing', not 'I missed'.",
  "fix_sketch": "Either give `.show-link` the `.ep-ts` treatment (`padding: 10px 6px; margin: -10px -6px` on the inline box, so it is ~33px tall without reflowing the line), or follow Apple Podcasts and drop the nested show link from rows (the show is one tap away on the episode page), keeping it only where the row is not already a link.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 12 (two unpadded links ~2px apart).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code matches the finding. In styles.css, line 1262 is `.ep-row .ep-title-link::after { content: \"\"; position: absolute; inset: 0; }`, which stretches the episode link over the whole `.info` block (`.ep-row .info { position: relative; }` at line 1250). Line 1263 is `.ep-row .info .show-link { position: relative; z-index: 1; }`. At line 1277 `.show-link` is `{ color: inherit; text-decoration: underline; text-underline-offset: 2px; }`, with no padding, no display change and no min-height. Line 1234, `.ep-row .s`, sets font-size var(--fs-sm) = 0.82rem, and body line-height is 1.4. Across the whole sheet, `show-link` appears only at 1263, 1277 and 1278. The one ui-v2 override (line 3501) changes only colour, and nothing handles `pointer: coarse`.\n\nThe markup matches too. app.js epRow (about line 8033) puts `showNameLink(item.show)` inside `.info .s`, and showNameLink (about line 2456) returns a bare `<a class=\"show-link\">`. So the show name is an inline hit box roughly 13-15px tall, and the episode link surrounds it on every side. Its sibling in the same audit lane, `.ep-ts` (lines 2128-2138), did get `padding: 10px 4px; margin: -10px -4px` for exactly this problem.\n\nTests pin the current state. test/tap-targets.test.js (\"an episode row's whole text block opens the episode, with the show link as the one exception\") checks only the z-index of `.show-link`, never its size. So the gap was not caught, and no test asserts it on purpose.\n\nIt is not a documented decision. The 2026-09-23 entry in docs/DECISIONS.md covers \"qa 78 (the stretched-link cards)\" as approved. That approves the pattern, not an undersized exception inside it, and I found no ruling on the size of the show link's hit area.\n\nI lowered the severity to low for two reasons. First, the \"a third of the time\" figure is an estimate, not a measurement. Second, the fix put the error on the harmless side. The episode is now the default target, and it is the more common intent. A missed tap on the show name opens that episode's page, which has its own show link one tap away. Before the fix, a slightly low tap on the title left for a different page. The target still fails WCAG 2.5.8: it is under 24px, and every side of it touches the episode link. The finding is real and cheap to fix with the `.ep-ts` padding and negative margin, or by dropping the show link from rows. But a mis-tap costs one extra tap and loses nothing.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## touch-8 — Sheets have no entrance or exit motion: Now Playing appears instantly and, after a drag past the dismiss distance, vanishes from mid-screen instead of finishing the slide

**confirmed** · verifier severity **medium** (finder: medium) · touch · `player/client.js:2494` · L2-sheets-drawer-gestures

```json
{
  "id": "touch-8",
  "lens": "touch",
  "title": "Sheets have no entrance or exit motion: Now Playing appears instantly and, after a drag past the dismiss distance, vanishes from mid-screen instead of finishing the slide",
  "file": "player/client.js:2488-2510 (setExpanded), 2586-2592 (endSheetDrag); styles.css:1964 (the only transition), no @keyframes anywhere",
  "line": 2494,
  "severity": "medium",
  "user_visible": "Tap the mini bar: the full sheet is simply there, no slide up. Pull it down 130px and let go: the sheet disappears from where the thumb left it — the page underneath pops into view with a hard cut rather than the sheet continuing off the bottom. A short pull springs back smoothly (the .22s transition), so the dismiss cut is the one motion in the sequence that breaks. Apple's sheet slides both ways.",
  "evidence": "`const setExpanded = (open) => { setSheetDragOffset(0); … ui.sheet.hidden = !open; document.body.classList.toggle(\"fp-expanded\", open); …}` (client.js:2488-2494) — `hidden` goes to `display: none` in the same frame the offset is reset. `endSheetDrag`: `if (dismiss) setExpanded(false); else setSheetDragOffset(0);` (2590-2591) — the dismiss branch never animates. `.fp-sheet:not(.fp-sheet-dragging) { transition: transform .22s ease; }` (styles.css:1964) is the only transition on the sheet; grep for `@keyframes` and `animation:` in styles.css returns nothing, so the `.fy-sheet` family has no motion either.",
  "why_subtle": "The spring-back is animated, so the gesture feels tuned; only its successful outcome is abrupt. Instant open/close reads as 'a bit cheap' rather than as a bug.",
  "fix_sketch": "On dismiss, animate `--fp-sheet-dy` to the sheet's height (transition on, `transitionend` or a 220ms timeout) and only then `setExpanded(false)`; on open, start at `--fp-sheet-dy: 100%` and transition to 0 after unhide (respect `prefers-reduced-motion`). Give `.fy-panel` the same translateY-in.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order to #682 and the visual pass.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds.\n\n- **Opening and closing are instant.** `setExpanded` (player/client.js, about line 2488) calls `setSheetDragOffset(0)`, then sets `ui.sheet.hidden = !open` and toggles `fp-expanded` in the same pass. Nothing sets a start offset first, waits for `transitionend`, or runs a timer, so the sheet appears and disappears with a hard cut.\n- **A long pull-down vanishes mid-screen.** `endSheetDrag` reads `if (dismiss) setExpanded(false); else setSheetDragOffset(0);`. On dismiss, `setSheetDragOffset(0)` removes `.fp-sheet-dragging`, which would turn the .22s transition back on. But `hidden` applies `display: none` in the same task, so the transition never paints and the sheet disappears from wherever the finger left it.\n- **A short pull springs back smoothly.** That branch only resets the offset and the sheet stays visible, so the .22s transition plays.\n- **No other motion exists.** styles.css has no `@keyframes` and no `animation:` anywhere. `.fp-sheet:not(.fp-sheet-dragging) { transition: transform .22s ease; }` (around line 1964) is the sheet's only transition. `.fy-sheet` and `.fy-panel` (around lines 2904-2923) have no entrance transition either.\n- **No ruling covers it.** docs/DECISIONS.md has no entry on sheet motion or animation. The only related line (around 447) is an old home-page pass that says \"no motion beyond the existing tap-scale\", and it explicitly left the in-app player alone. The code comments describe the spring-back transition as intended for the release, which suggests the dismiss cut was overlooked, not chosen.\n- **Not already fixed.** Neither the code nor the comments at origin/main add any entrance or exit motion.\n\nSeverity: medium. Nothing breaks and the sheet stays usable, but it is a visible rough edge on the main player gesture. The founder asked for this drag and cited the Apple sheet as the model, and the half-animated sequence (smooth spring-back, abrupt dismiss) shows.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## touch-9 — Half of every two-tier row is dead to taps, and the half that is live gives feedback only on the title text: the row looks like one card but behaves like a link glued to a toolbar

**confirmed** · verifier severity **low** (finder: low) · touch · `styles.css:1262` · L7-styles-touch-visual

```json
{
  "id": "touch-9",
  "lens": "touch",
  "title": "Half of every two-tier row is dead to taps, and the half that is live gives feedback only on the title text: the row looks like one card but behaves like a link glued to a toolbar",
  "file": "styles.css:1258-1262 (two-tier + stretched link scoped to .info), 1240-1241 (.ep-title-link:active), no .ep-row:active; app.js:8033-8040 (epRow markup)",
  "line": 1262,
  "severity": "low",
  "user_visible": "On an episode row, tapping the title area opens the episode; tapping the empty right-hand half of the second line (right of '+ Up Next', ~150px wide × 40px on a 390px phone), the number circle, or the card's 12px padding ring does nothing. When a tap does land, only the title text underlines (and on iOS WebKit's default grey highlight paints just the inline text box, not the card), so a tap on the meta line lights up a word above the thumb. `.pl-row` and `.mini-card`, by contrast, highlight the whole card.",
  "evidence": "`.ep-row .info { position: relative; }` (1257) and `.ep-row .ep-title-link::after { content: \"\"; position: absolute; inset: 0; }` (1262) confine the stretched link to `.info`; `.ep-row { flex-wrap: wrap; row-gap: 8px; }` (1259) and `.ep-row > .info + :is(.play-btn, button.star, button.up-next, .not-playable) { margin-left: 36px; }` (1261) put the controls on a second tier whose remaining width is the row's padding box. `.ep-title-link:active { text-decoration: underline; }` (1241) is the only feedback; there is `.pl-row:active { background: var(--surface-2); }` (1231) and `.mini-card:active { … }` (727) but no `.ep-row:active`. epRow (app.js:8033-8040): `<div class=\"ep-row\"><span class=\"q-num …\">…</span><div class=\"info\">…</div>${inApp}${starBtn(item.id)}${upNextBtn(item.id)}${unavailable}</div>`.",
  "why_subtle": "The first-tier fix (qa 12) made 'tap the text' reliable, so the row passes every test that taps the text; the dead lower-right is where a thumb resting on a scrolled list naturally lands.",
  "fix_sketch": "Move the stretched link to the row: `.ep-row { position: relative }`, `.ep-row .ep-title-link::after { inset: 0 }` (containing block becomes the row), and lift the second-tier controls with `z-index: 1` (they already have `position: relative` from the tap-target rule). Add `.ep-row:has(.ep-title-link:active) { background: var(--surface-2) }` (or `.ep-row:active`) so the whole card responds, and set `-webkit-tap-highlight-color: transparent` once the authored state exists.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order to qa 12 and persona 40 (two-tier rows).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the code matches the finding; only the line numbers are off by one or two. In styles.css, `.ep-row .info { position: relative; }` is at 1250 and `.ep-row .ep-title-link::after { content:\"\"; position:absolute; inset:0; }` is at 1262, so the stretched link only covers `.info`. Lines 1259-1261 make `.ep-row` wrap onto two tiers and push the controls to a second line indented 36px. The row keeps its 12px padding (1217-1230). The only press feedback is `.ep-title-link:active { text-decoration: underline; }` (1241). `.pl-row:active` (1231, and ui-v2 3499) and `.mini-card:active` (727) exist, but `.ep-row:active` appears nowhere, including in the body.ui-v2 overrides at 3494-3504. The epRow markup (app.js ~8033) matches what the finding quotes: the q-num span and the controls sit outside `.info`. So the empty space right of the second-tier controls, the number circle and the padding ring are all dead to taps, and a successful tap only underlines the title text.\n\nDECISIONS.md (~116-121) records founder approval for persona 40 (the two-tier row) and qa 78 (stretched-link cards). It does not rule that the control tier should be dead or that the row should give no feedback. The comment at styles.css 1242-1249 says the stretched link was added because 'a tap in the empty space right of a short title did nothing although the card looks like one big target'. That shows the intent was a whole-card target, and the later two-tier change left part of the card uncovered again. So this is not deliberate and has not been fixed.\n\nSeverity stays low. Nothing is broken: the title area still opens the episode, and the dead zones and weak feedback are polish problems. One untested caveat: the iOS grey-highlight detail in the finding is plausible WebKit behaviour, but I did not check it on a device.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## touch-10 — Inline description timestamps' 10px vertical padding overlaps the neighbouring lines, so the bottom fifth of a stamp — and the whole gap under it — seeks to the NEXT stamp

**confirmed** · verifier severity **low** (finder: low) · touch · `styles.css:2132` · L7-styles-touch-visual

```json
{
  "id": "touch-10",
  "lens": "touch",
  "title": "Inline description timestamps' 10px vertical padding overlaps the neighbouring lines, so the bottom fifth of a stamp — and the whole gap under it — seeks to the NEXT stamp",
  "file": "styles.css:2128-2138 (.ep-ts), 2113-2117 (.ep-description-text line-height 1.5); app.js:8335 (markup)",
  "line": 2132,
  "severity": "low",
  "user_visible": "Publisher notes commonly list chapters one per line ('00:00 Intro\\n02:15 The news\\n09:40 Interview'). Tapping the lower part of '02:15', or just under it, jumps to 09:40; the gap between lines always belongs to the lower stamp. The listener sees the wrong chapter start and blames their aim.",
  "evidence": "`.ep-ts { display: inline; … padding: 10px 4px; margin: -10px -4px; font: inherit; …}` (2128-2138). Vertical padding on an inline box is hit-testable but the negative vertical margin has no effect on inline boxes, so each stamp's box is ~14.4px of glyph + 20px = ~34px tall inside a 21.6px line (`--fs-md` 0.9rem × `line-height: 1.5`, 2113-2115). The box overhangs 10px into each neighbouring line; a later-in-DOM element wins hit-testing where boxes overlap, so line N+1's stamp owns the bottom ~3px of line N's glyphs and all of the leading between them. The round-1 fix (qa 7) added the padding without checking what the overhang lands on.",
  "why_subtle": "Only bites when stamps are stacked line by line, which is the most common layout of chapter timestamps in show notes; a tap on the middle of the text still works, so it feels like flaky aim.",
  "fix_sketch": "Cap the vertical padding to the available leading (`padding: 0.25em 4px` ≈ 3.6px each side) so boxes meet but do not overlap, and instead render timestamp-led lines as 44px block rows (the `.ep-chapter-row` component already exists at 2171 with exactly that shape) when a line starts with a stamp.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 7 (zero-padding inline timestamps).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code is as the finding describes. styles.css line 2132 sets `.ep-ts { display: inline; padding: 10px 4px; margin: -10px -4px; font: inherit; ... }`, and `.ep-description-text` has `font-size: var(--fs-md); line-height: 1.5; white-space: pre-line`, so chapter lists written one per line render as separate lines. app.js line 8335 outputs `<button class=\"ep-ts\">` in the text flow. The CSS comment calls this a deliberate expansion of the hit area into the leading, but nothing in it or in docs/DECISIONS.md addresses the case where boxes on neighbouring lines overlap. DECISIONS.md has no entry on ep-ts or tap targets.\n\nWhy the overlap happens:\n- Vertical padding on an inline element enlarges its hit-testable border box. A negative vertical margin does nothing on a non-replaced inline element, so the 10px on top and bottom is not cancelled.\n- The line box is 0.9rem × 1.5 = 21.6px. The button's content area is about 17px (a little more than the finding's 14.4px glyph figure, because the content area includes the font's ascent and descent). With padding the box is about 37px tall, so it reaches about 7–8px into the line above and the line below.\n- When two consecutive lines both start with a stamp, their boxes overlap in a band of about 15px around the line boundary. The later element in the DOM paints on top and wins the hit test, so the lower stamp owns the gap between the lines and the bottom 1–3px of the upper stamp's digits.\n\nThe user-visible effect is real but narrow. It only happens when stamps sit directly above each other, which is the common chapter-list layout. Only taps at the very bottom edge of a stamp, or in the gap below it, go to the next chapter. A tap in the middle of a stamp works. Touch-target adjustment may also soften this on mobile. This is a real side effect of the round-1 qa 7 fix, and low severity is right. The suggested fix is sound: keep the padding within the half-leading (about 0.15–0.25em) so the boxes do not overlap.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## touch-11 — The static segment strip inside horizontally scrolling rails carries `touch-action: pan-y`, so a sideways flick that starts on it cannot scroll the rail

**confirmed** · verifier severity **low** (finder: low) · touch · `styles.css:2549` · L7-styles-touch-visual

```json
{
  "id": "touch-11",
  "lens": "touch",
  "title": "The static segment strip inside horizontally scrolling rails carries `touch-action: pan-y`, so a sideways flick that starts on it cannot scroll the rail",
  "file": "styles.css:2547-2549 (.fy-strip--static), 3785 (.hv2-hscroll overflow-x: auto); app.js:7783 (hv2-foray-card is an <a> in the rail)",
  "line": 2549,
  "severity": "low",
  "user_visible": "On Home's 'Forays for you' shelf, a horizontal swipe that begins on a card's coloured strip does not move the shelf; the same swipe an inch higher does. It is a 5px band so it is rare, but on a shelf you flick repeatedly it shows up as the occasional swipe that 'sticks'.",
  "evidence": "`.fy-strip--static { cursor: default; touch-action: pan-y; …}` (2547-2549), justified by the comment above it: \"`touch-action: none` on a card would fight the rail's own scroll for every touch that starts on one\" — but `pan-y` forbids horizontal panning just as `none` would, and the rail is horizontal: `body.ui-v2 .hv2-hscroll { display: flex; gap: 12px; overflow-x: auto; … scroll-snap-type: x proximity; …}` (3785-3794). `forayCardV2Html` returns `<a class=\"hv2-foray-card…\" href=\"#/foray/…\">` (app.js:7783) with the strip inside.",
  "why_subtle": "The strip is 5px tall, so it only fails a fraction of flicks, and a failed flick on a snap rail just looks like the rail hesitated.",
  "fix_sketch": "`.fy-strip--static { touch-action: auto; }` (it has no gesture of its own; the comment already says no handler reaches it), or `pan-x pan-y`. Keep `pan-y` only on the live `#fy-strip`.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order to qa 1 (the pan-y fix on the live strip was copied to the static strip where it is wrong).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked origin/main and the code matches the finding.\n\n- **The static strip:** styles.css:2547-2549 is `.fy-strip--static { cursor: default; touch-action: pan-y; ... flex-wrap: nowrap; overflow: hidden; }`. The comment above it (2540-2546) says it exists so the strip will not \"fight the rail's own scroll for every touch that starts on one\".\n- **The rail:** `body.ui-v2 .hv2-hscroll` at 3785-3794 is `display: flex; overflow-x: auto; scroll-snap-type: x proximity`, so it is a horizontal scroller.\n- **The card:** app.js:7783 `forayCardV2Html` returns an `<a class=\"hv2-foray-card\">` with the output of `segmentStripHtml(..., {size:\"sm\", mergeNarration:true})` inside it. That output is the static strip (test/first-time-onboarding.test.js:374 shows the class set `fy-strip fy-strip--sm fy-strip--static`).\n\nWhy the swipe sticks: under the Pointer Events spec, the touch-action that applies to a touch is the intersection of the values on the touched element and its ancestors, up to the element that scrolls. With `pan-y` on the strip, the browser may not pan horizontally for a touch that starts on the strip or on its `.fy-seg` children. So the rail cannot scroll from that touch, even though the anchor and the rail are both `auto`.\n\nI looked for anything that would cancel this and found nothing:\n- The static strip has no `pointer-events: none`. The only `pointer-events: none` near it is on `.fy-strip-bubble`.\n- No later rule inside `body.ui-v2` resets touch-action on `.hv2-forays .fy-strip`. Line 3854 only sets margin-top.\n- docs/DECISIONS.md has no ruling on the static strip.\n- No test pins touch-action on `.fy-strip--static`.\n\nThe earlier audit notes explain how this happened. Round 1 changed the override on the static strip away from `none`, and the base-strip fix for qa 1 (PR #742) set `pan-y`, the right value for the vertical scrubber, which is a horizontal control. That same value is wrong for a card inside a horizontal rail, and it contradicts the stated reason for the override. Using `none` instead would have given the same result for horizontal swipes.\n\nSeverity is low. The strip is a 5px band (`--strip-h: 5px` at `--sm`), and the swipe still works from the rest of the card. Nothing is lost; some swipes just do nothing. The fix is `touch-action: auto` (or `pan-x pan-y`) on `.fy-strip--static`.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## player-4 — "Previous clip" pressed during a narration line always restarts the line — you can never go back past a narrator

**confirmed** · verifier severity **medium** (finder: medium) · player · `player/client.js:3827` · L1-player-transport

```json
{
  "id": "player-4",
  "lens": "player",
  "title": "\"Previous clip\" pressed during a narration line always restarts the line — you can never go back past a narrator",
  "file": "player/client.js",
  "line": 3827,
  "severity": "medium",
  "user_visible": "Inside a Foray, while the narrator is speaking (or a rendered bridge is playing), press ‹ Previous clip — on the sheet, the Foray page or the steering wheel. The line starts again from its first word. Press it again immediately: it starts again. The 4-second 'previous means the one before' rule never applies, so the only way back to the clip before the narration is the running-order rows or the strip.",
  "evidence": "`forayPrevious()` computes `const into = item ? (backend.currentTime ?? 0) - item.start_sec : 0;` (client.js:3827). A narration/bridge item has no `start_sec` (foray-resolve.js:710-718 documents this; `sourceOffsetFor` has a special case for it at :3892-3894), so `into` is `NaN`; for a spoken line `backend.currentTime` is also the PREVIOUS clip's frozen clock (queue-manager.js:1436-1446). `NaN < RESTART_WINDOW_SEC` is false, so the code always takes `manager.skipToPrevious()` (:3832), which is 'restart in place' (`_forceNextOffset = 0`, queue-manager.js:704-712; `handleSkip` previous with null target → restart, queue-state.js:510-521), and for a synth item `forced == null` fails so `_speakNarration` re-speaks (queue-manager.js:1290-1294).",
  "why_subtle": "The seek pair was moved off previous/next in round 1 (persona 58), so the clip buttons are now the only way to step; the bug only shows on the ~10% of items that are narration, and a restart looks like an intentional 'replay this line'.",
  "fix_sketch": "Measure `into` on the Foray clock rather than the element's: `const pos = forayPlayhead(); const start = segmentStarts(foray.resolved.playable)[index]; const into = pos == null ? Infinity : pos - start;` (or `manager.isNarrationPlayhead ? manager.narrationElapsedSec : backend.currentTime - (item.start_sec ?? 0)`). Add a test in foray-playback for previous during a TTS item at 1 s in → lands on index-1.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; touches the persona 58 rework (clip row) — the row's Previous inherits an old NaN",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b8. In player/client.js:3822-3836, `forayPrevious()` computes `into = item ? (backend.currentTime ?? 0) - item.start_sec : 0`, where `item = foray.resolved.playable[index]`. `playable` is `report.items` from `buildForayQueue` (foray-resolve.js:484). Narration queue items (foray-queue.js, `kind: \"tts\"`) and jingle items (`kind: JINGLE`) are built with no `start_sec` field, so `into` is `number - undefined`, which is NaN. `NaN < 4` is false, so the code never takes the previous-item branch and always calls `manager.skipToPrevious()`. That sets `_forceNextOffset = 0` (queue-manager.js:704-710) and hits `handleSkip` with a null target, which restarts the current item (queue-state.js restartInPlace). For a spoken line, `forced == null` is false, so `resumingSpeech` is false and `_speakNarration` re-speaks the line (queue-manager.js:1290-1292).\n\nThe same missing `start_sec` has already been fixed in two other places: `sourceOffsetFor` (client.js, audit 2026-09-22) and `forayElapsed` (foray-resolve.js:710-718). `forayPrevious` was missed. No docs/DECISIONS.md ruling makes this deliberate. The only restart-window mention I found is docs/android-lock-screen.md, which describes the window as intended to apply to every item. No test covers Previous during a narration or jingle item; foray-playback.test.js only records that the handler is wired.\n\nThe bug shows up on every Previous entry point (the clip row at client.js:2612, the lock screen and steering wheel at 2145/2168, and #fy-prev in app.js:10532). The finding misses one case: the ~jingle items are affected too. Severity is medium: narration is a large share of a Foray and it is a real navigation dead end, but the running-order rows and the strip still get you back.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-5 — 30↻ inside a Foray has no end guard: a forward nudge near the end finishes the Foray and wipes its Jump back in row

**confirmed** · verifier severity **medium** (finder: medium) · player · `player/client.js:1432` · L1-player-transport

```json
{
  "id": "player-5",
  "lens": "player",
  "title": "30↻ inside a Foray has no end guard: a forward nudge near the end finishes the Foray and wipes its Jump back in row",
  "file": "player/client.js",
  "line": 1432,
  "severity": "medium",
  "user_visible": "In the last clip of a Foray with, say, 20 s left, tap 30↻ (sheet, Foray page, mini bar's twin, or the car's skip-forward). The Foray ends: the button flips to \"▶ Start over\", the lock screen drops its transport, and the Foray's resume row is cleared, so it disappears from Jump back in. The same nudge on an ordinary episode stops 1 s before the end precisely so this cannot happen.",
  "evidence": "`nudgeBy` for a Foray is `ForayPlayer.foraySeek(Math.max(0, forayPosition() + offset))` (client.js:1432-1436) — a lower clamp only. `foraySeek` → `segmentAtElapsed` clamps at/past the total to the last item's END (`{ index: last, into: lengthOf(list[last]) }`, foray-resolve.js:654-655) and `sourceOffsetFor` lands `SEEK_INSIDE_END_SEC = 0.25` s inside so \"'take me to the end' ends the Foray\" (client.js:3863-3895). The out-point then fires, `handleItemEnded(playing, null)` → `ended`, and `persistForayProgress` runs `forayProgress.clear(id)` (:1264-1267). Contrast the episode rule: `SEEK_END_GUARD_SEC = 1` \"A 30-second nudge with eight seconds left must not become 'finished'\" (:1376-1388), applied by `clampEpisodeTarget` to every episode seek.",
  "why_subtle": "The 0.25 s 'inside the item' landing was the qa 22 fix for the scrubber and is correct there; the nudge reuses the scrubber's path and so inherits a semantic ('finish') the nudge's label never promised.",
  "fix_sketch": "Apply the same guard to the Foray nudge: in `nudgeBy`, `if (foray) return ForayPlayer.foraySeek(Math.min(Math.max(0, forayPosition() + offset), Math.max(0, foray.resolved.totalSec - SEEK_END_GUARD_SEC)))` (keep the scrubber's 'drag to the end ends it' behaviour from qa 22 untouched by guarding only the nudge). Pin in foray-playback.test.js.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order interaction of qa 22 (sourceOffsetFor) with persona 58 (the seek pair now seeks inside Forays) and qa 35 (the episode-only clamp)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. In player/client.js at lines 1432-1436, `nudgeBy` inside a Foray calls `ForayPlayer.foraySeek(Math.max(0, forayPosition() + offset))`. That clamps only at zero, with no upper bound. Every nudge surface goes through it: the sheet's ↺/↻ buttons (2609-2611), the lock-screen/car `seekBy` (2169) and the Foray page's `nudge` (3321).\n\n`foraySeek` (3839) calls `segmentAtElapsed`. In foray-resolve.js at lines 654-655, that function answers a target at or past the total with `{index:last, into:lengthOf(last)}`. `sourceOffsetFor` (3886-3895) then lands the playhead 0.25 s before the item's out-point, and its own comment says \"take me to the end ends the Foray\". The out-point fires moments later and the Foray finishes. `persistForayProgress` then sees `state.type === \"ended\"` and calls `forayProgress.clear(id)` (1264-1267), so the resume row is gone.\n\nThe episode path works differently. `seekEpisodeTo` → `clampEpisodeTarget` applies `SEEK_END_GUARD_SEC = 1` (1376-1388), and its comment states the exact rationale this finding cites: a nudge must not turn into \"finished\". docs/DECISIONS.md has no ruling about nudges or end guards, so this is not deliberate. It has not been fixed either. The end-clamp in sourceOffsetFor was meant for the scrubber, and the nudge path picked up the same behaviour without that intent.\n\nI rate it medium. A single tap near the end of the last clip silently finishes the Foray and removes it from Jump back in. The trigger is narrow, though: the tap has to come within 30 s of the Foray's end.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-7 — A Foray clip that fails to load says nothing on the mini bar or sheet — the message lives only on the Foray page

**confirmed** · verifier severity **medium** (finder: medium) · player · `player/client.js:1654` · L1-player-transport

```json
{
  "id": "player-7",
  "lens": "player",
  "title": "A Foray clip that fails to load says nothing on the mini bar or sheet — the message lives only on the Foray page",
  "file": "player/client.js",
  "line": 1654,
  "severity": "medium",
  "user_visible": "Start a Foray from the restored ribbon, the Jump back in row on Home, the lock screen or the car, while the Foray page is NOT open. The first clip (or any later one) 404s or times out. The player pauses, the bar shows ▶ over the Foray title, the sheet's status line stays empty, and nothing anywhere says why. The same failure on an ordinary episode paints \"Did not load — press play to try again\" on the bar (round 1's persona 4 fix).",
  "evidence": "`paintStatus()` deliberately drops the failure for a Foray: `const failure = foray ? null : playFailure;` with the comment \"A Foray keeps its own failure line on its page\" (client.js:1650-1660). `onTelemetry` routes a Foray failure only to `foray.error` + `notifyForay()` (:2769-2772) and sets `setPlayFailure` only `if (!foray && current …)` (:2776-2778). `foray.error` is consumed by `paintForay` on the Foray page (app.js:10839 `if (s.error) paintForayFailure(s.error)`), which is not mounted when the Foray was started from the ribbon (`restoreForay`/`setRunning` restored branch, client.js:1956-1970) — the page's `watchForay` is only attached once someone opens `#/foray/:id`.",
  "why_subtle": "Round 1 added the ribbon-resumable Foray (persona 7) AFTER the failure line was designed for 'the Foray page is where a Foray starts'; the two fixes did not meet.",
  "fix_sketch": "Let the bar and sheet carry the Foray failure too: in `paintStatus`, `const failure = foray ? (foray.error ? EP_START_FAILED : null) : playFailure;` (or map the two Foray telemetry classes onto the same two listener sentences, keeping the Foray page's richer line). Clear it in `syncForaySegment` where `foray.error` is already cleared on audio.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order interaction of persona 7 (Foray on the ribbon) with persona 4 / qa 24 (failure copy on the bar); incomplete fix of qa 24 for the Foray case",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and every piece of the evidence holds. In player/client.js at lines 1650-1655, paintStatus() has `const failure = foray ? null : playFailure;` with the comment saying a Foray keeps its own failure line on its page. That means the bar and the sheet can only ever show buffering during a Foray. It applies even when app.js calls reportPlayFailure (line 3064), which sets playFailure but gets hidden the same way.\n\nIn onTelemetry (lines 2769-2778), a Foray failure only sets foray.error and calls notifyForay(). setPlayFailure runs only under `!foray && current`.\n\nforay.error reaches the listener through one place: the watchForay snapshot (line 1216, `error: foray.error`). The Foray page's paintForay reads it (app.js:10839 calls paintForayFailure(s.error)). No other client.js surface shows it. The sheet's `note` only carries the timing-precision line (line 1606).\n\nSo with the Foray page not mounted, a Foray clip that fails pauses silently everywhere the listener can see. An ordinary episode that fails the same way gets EPISODE_FAILED_LINE on the bar. docs/DECISIONS.md has no ruling that covers the bar or sheet staying quiet for a Foray. The 2026-09-23 visual-pass ruling is about design, not failure copy. The only thing close to a \"deliberate\" reason is the code comment, and it assumes the page is showing, which is false for starts from the ribbon, Home, the lock screen or the car.\n\nOne note on the fix sketch: EP_START_FAILED reads \"That episode could not load…\", which is the wrong noun for a Foray clip. EPISODE_FAILED_LINE (\"Did not load — press play to try again\") fits better.\n\nSeverity stays medium. This is a silent failure on a common path, not data loss.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-8 — Jump back in and the restored ribbon disagree about a finished episode: the card says Played 100%, the ribbon shows 0:00 with an empty bar

**confirmed** · verifier severity **low** (finder: low) · player · `player/client.js:3103` · L1-player-transport

```json
{
  "id": "player-8",
  "lens": "player",
  "title": "Jump back in and the restored ribbon disagree about a finished episode: the card says Played 100%, the ribbon shows 0:00 with an empty bar",
  "file": "player/client.js",
  "line": 3103,
  "severity": "low",
  "user_visible": "Finish an episode with nothing queued after it (which, given finding 1, is also the state you are left in when continuous playback fails to fire). Come back later: Home's Jump back in card for that episode reads \"Played\" with a full bar, while the mini bar at the bottom shows the same episode at 0:00 with an empty progress line and \"-58:12\" left, as if never started. Apple Podcasts shows one truth for one episode.",
  "evidence": "`lastEpisodeCard()` paints from the RAW stored row (`episodeProgress(…, stored?.seconds)` → `{state:\"played\", percent:100, label:\"Played\"}`, client.js:2982-2995, episode-progress.js:173-184, the qa 27 fix), while `restoreLastEpisode()` paints from `positions.resumeOffset(rec.id, …)`, which collapses a near-end row to 0 (`restoredPending = { item: rec, positionSec: verdict.positionSec }`, client.js:3103-3128; position-store.js:93-100, the qa 155/156 fix); `episodePositionSec()` then returns `restoredPending.positionSec` = 0 for the bar (:1356-1360) and `render()` paints `frac = 0` and `tLeft = remainingClock(dur - 0)` (:1479-1491).",
  "why_subtle": "Two round-1 fixes pulled the same value in opposite directions on purpose (display = raw, resume = collapsed) and each is right in isolation; the ribbon is a display surface that took the resume value.",
  "fix_sketch": "Decide one presentation for a finished episode and use it on both: e.g. restore the ribbon with `positionSec: stored.seconds` for display (bar full, \"0:00\" left) but keep `resumeOffset` for where PLAY starts (`setRunning`'s restored branch already seeks only `moved || positionSec > 0`; add a `finished: true` flag so the start goes to 0), or drop a finished episode from the ribbon entirely and let the card be the only surface. Pin in foray-ribbon-restore.test.js.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order interaction of qa 27 (card reads raw) with qa 155/156 (ribbon reads resumeOffset)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main, and the evidence holds. The Home card: `lastEpisodeCard()` (client.js:2976-2995) builds its bar and label from the raw `stored?.seconds` through `episodeProgress`. For a position within NEAR_END_SEC (30 s) of a known end, that returns `{state:\"played\", percent:100, label:\"Played\"}` (episode-progress.js:173-180). app.js:7678-7700 shows `percent` and `left` on the Jump back in card. The ribbon: app.js:10947 calls `restoreLastEpisode()` on launch. That function (client.js:3095-3126) uses `positions.resumeOffset(...)`. `resumeOffset` returns 0 when `r.seconds > dur - NEAR_END_SEC` (position-store.js:93-100). `lastEpisodeState` still answers \"resume\" whatever the position (it only checks age), so the ribbon is restored with `restoredPending.positionSec = 0`. From there `episodePositionSec()` returns 0 (:1356-1358), and `render()` paints `frac = 0` and `tLeft = remainingClock(dur - 0)` (:1479-1488). A finished episode does leave a near-end row. queue-manager saves the position on `timeupdate` every 10 s of movement (`POSITION_MIN_DELTA_SEC = 10`, `_persistIfDue`/`_persistPosition`). Nothing clears the position row or the last-episode pointer when an episode ends, and the pointer is written only in `play()`. So one finished episode shows two different states: \"Played\" with a full bar on the card, and a 0:00 empty bar with the full time left on the ribbon. The card's comment (qa 27 fix) names the raw-vs-offset difference, but only for the card. No DECISIONS.md ruling covers the ribbon's presentation of a finished episode, and it has not been fixed. Severity stays low: it is a cosmetic mismatch, and pressing play correctly starts the episode over from 0.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-9 — Both speed buttons open a menu, but their accessible name still says "tap for the next speed"

**confirmed** · verifier severity **low** (finder: low) · player · `player/playback-rate.js:202` · L1-player-transport

```json
{
  "id": "player-9",
  "lens": "player",
  "title": "Both speed buttons open a menu, but their accessible name still says \"tap for the next speed\"",
  "file": "player/playback-rate.js",
  "line": 202,
  "severity": "low",
  "user_visible": "With VoiceOver on, the sheet's speed button and the Foray page's speed button announce \"Playback speed 1.5× — tap for the next speed\". Tapping opens the Playback speed sheet (a dialog) and changes nothing until a stop is chosen. A voice-control user told 'next speed' expects a cycle; nothing says a menu will open (no `aria-haspopup`).",
  "evidence": "`rateAriaLabel = (v) => \\`Playback speed ${rateLabel(v)} — tap for the next speed\\`` (playback-rate.js:201-203) is painted onto `ui.rateBtn` by `paintRate` (client.js:1749-1752) and onto `#fy-rate` by `paintRateButton` (app.js:10617-10628). Both click handlers open a picker: `ui.rateBtn.addEventListener(\"click\", () => openRatePicker())` (client.js:2628) and `rateBtn.addEventListener(\"click\", () => … openRateMenu(…))` (app.js:10506-10508, comment: \"THE BUTTON USED TO CYCLE ON TAP\"). `cycleRate`'s doc still says \"the shipped controls all cycle\" (client.js:3355-3366).",
  "why_subtle": "The copy was correct when #242 shipped a cycle button; #349 replaced the behaviour and left the label module untouched because it is 'just the aria string'.",
  "fix_sketch": "Change the name to \"Playback speed 1.5× — opens the speed menu\" and set `aria-haspopup=\"dialog\"` on both buttons (`paintControl`/`setControlLabel` call sites); update the `cycleRate` comment and the playback-rate test that pins the string.",
  "suspected_deliberate": false,
  "relation_to_round1": "new (round 1 fixed name/text mismatches on play buttons — theme D — but not this one)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main (9730b5b) and the finding holds. playback-rate.js:201-203 returns `Playback speed ${rateLabel(v)} — tap for the next speed`, and playback-rate.test.js:209 pins that exact string. client.js:1751 paints it onto ui.rateBtn via paintControl, and client.js:2628 wires that button's click to openRatePicker() (defined at line 1875). app.js:10616-10618 paints player.rateAriaLabel onto #fy-rate. The click handler at app.js:10505-10507 calls openRateMenu, and the comment above it says \"THE BUTTON USED TO CYCLE ON TAP\" and that nothing changes until a stop is tapped. The setPlaybackRate doc at client.js:3368-3369 still says \"the shipped controls all cycle\", which is out of date. No .js or .html file on main contains aria-haspopup. docs/DECISIONS.md has no ruling on the speed control's label, so this is not deliberate. Nothing has fixed it. The impact is low: the button still works, and the only problem is that assistive-tech users hear a description of what tapping does that no longer matches what happens.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-10 — A restored Foray's lock-screen/car entry is built as an episode: the artist slot reads "Foray · clip 3 of 32" and the counter never follows a scrub

**confirmed** · verifier severity **low** (finder: low) · player · `player/client.js:2334` · L1-player-transport

```json
{
  "id": "player-10",
  "lens": "player",
  "title": "A restored Foray's lock-screen/car entry is built as an episode: the artist slot reads \"Foray · clip 3 of 32\" and the counter never follows a scrub",
  "file": "player/client.js",
  "line": 2334,
  "severity": "low",
  "user_visible": "Relaunch with a part-played Foray on the bar (not yet pressed). The lock screen and the car show title = the Foray's name, artist = \"Foray · clip 3 of 32\", album = blank, app icon. Once you press play it changes to the proper episode / show / \"Foray · clip 3 of 32\" layout — the same Foray is described two different ways five seconds apart. On the bar itself, dragging the restored scrubber to 45:00 leaves the second line saying \"clip 3 of 32\".",
  "evidence": "`restoreForay` paints a placeholder item `{ id: 'foray:<id>', forayId, title: resolved.title, show: 'Foray · clip N of M', duration_sec: totalSec }` (client.js:3045-3051) with `foray` still null; `syncMediaSession` therefore takes the single-episode branch `media.update(mediaSessionView({ item: current, forayTitle: \"\", … }))` (:2334-2359), where `mediaMetadata` sets `artist = clean(item?.show)` (media-session.js:407-408). The `show` string is computed once from `startElapsedSec` and `seekEpisodeTo` on a restored bar only rewrites `restoredPending.positionSec` (:1407-1416), never `current.show`.",
  "why_subtle": "The placeholder is an internal convenience that happens to be shaped like an episode, and the lock screen is the one surface where 'show' is a labelled field (artist).",
  "fix_sketch": "In `syncMediaSession`, branch on `current?.forayId` as well as `foray`: build the view with `forayTitle: current.title`, `index`/`total` from `segmentAtElapsed(resolved.playable, episodePositionSec())`, and `item` = that clip (the restored `restoredPending.foray.resolved` is in hand). Recompute the bar's `show` line in `render()` for a restored Foray from the same `segmentAtElapsed`.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order to persona 7 (Foray on the ribbon) and qa 161 (restored ribbon publishes metadata)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this at origin/main 9730b5b and the finding holds. In player/client.js, `restoreForay` (around lines 3035-3055) calls `setNowPlaying` with a placeholder item `{id:'foray:<id>', forayId, title: resolved.title, show: 'Foray · clip N of M', duration_sec}` while `foray` stays null. It keeps the Foray only in `restoredPending.foray`.\n\n`syncMediaSession` (around line 2288) chooses its branch only on `if (foray)`. It never checks `current.forayId`, so a restored Foray gets the single-episode view with `forayTitle: \"\"`, index 0 and total 0. In media-session.js, `mediaMetadata`'s non-narration branch sets title = item.title (the Foray's name) and artist = clean(item.show) (\"Foray · clip 3 of 32\"). `albumOf(\"\", 0, 0)` returns an empty album, and because `showArtworkUrl` = `current.artwork_url` (undefined) the lock screen falls back to the app icon.\n\nOnce play starts, the Foray branch shows the clip's title, the clip's show as artist, and \"<Foray title> · clip N of M\" as album. So the same Foray really is laid out two different ways.\n\nFor the scrub: `seekEpisodeTo` proceeds because `foray` is null, but on a restored bar it only spreads a new `positionSec`/`moved` into `restoredPending` and calls `render()`. The bar's second line comes from `item.show`, which is set only once in `setNowPlaying`, so dragging to 45:00 leaves \"clip 3 of 32\" showing.\n\nNo ruling in docs/DECISIONS.md covers this. The comments near the restored-bar code (qa row 161) fix position and duration only, not the metadata layout. The impact is cosmetic and temporary: it lasts only until the first press and nothing is lost, so severity stays low.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## player-11 — ↺15 during a spoken narration line does nothing, silently

**confirmed** · verifier severity **low** (finder: low) · player · `player/client.js:3886` · L1-player-transport

```json
{
  "id": "player-11",
  "lens": "player",
  "title": "↺15 during a spoken narration line does nothing, silently",
  "file": "player/client.js",
  "line": 3886,
  "severity": "low",
  "user_visible": "While the narrator is speaking a line (synth TTS, no audio file), tap ↺15 on the bar, the sheet or the Foray page, or the car's skip-back. If 15 s back is still inside the same line nothing happens at all — no restart, no message, the clock keeps running. (Crossing back into the previous clip works.)",
  "evidence": "`nudgeBy` → `foraySeek(pos - 15)` → `at.index === manager.currentIndex` so no reload; `sourceOffsetFor(item, into)` returns `null` for `item.kind === TTS && !item.audio_url` (client.js:3886-3895, comment: \"the synthesiser cannot start mid-sentence, so there is nothing to seek\") → `if (offset != null)` skips the seek → `render()` only (:3854-3856).",
  "why_subtle": "The comment records the limitation for the scrubber; the seek pair only gained Foray-clock behaviour in round 1 (persona 58), and the no-op is invisible because the narration keeps going.",
  "fix_sketch": "Treat a back-nudge inside a spoken line as 'restart the line' (`manager.skipToPrevious()` semantics, which re-speaks from the top) and a forward nudge inside it as 'skip the line' (`forayNext`), or at least announce \"Narration can't be scrubbed\" via the existing `ui.announce` live region. Document the choice in DECISIONS.",
  "suspected_deliberate": true,
  "relation_to_round1": "second-order to persona 58 (seek pair seeks in every mode) and qa 37 (NaN scrub into a bridge — fixed by returning null, which is what makes the nudge inert)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding matches origin/main. In player/client.js, nudgeBy (around line 1432) sends every nudge in a Foray to ForayPlayer.foraySeek(max(0, forayPosition()+offset)). The same path is used by the mini-bar ↺15, the sheet and Foray-page pairs, and the lock screen and car seekBy (around line 2169). In foraySeek, when the target is in the same segment as manager.currentIndex and the player is not ended or idle, reload is false, so nothing is reloaded. sourceOffsetFor (lines 3886-3895) then returns null for `item.kind === TTS && !item.audio_url`, which skips the `if (offset != null) await manager.seek(...)` line. That leaves only render(). No restart, no ui.announce message and no disabled state follow, so the tap does nothing the user can see or hear. The code comment (\"the synthesiser cannot start mid-sentence, so there is nothing to seek and the line starts from the top\") was written for the scrubber and for reloads into a bridge. It assumes the line restarts from the top, but that only happens on the reload path, not for a nudge inside the current line. So the inert nudge looks like an unintended side effect of the qa-37 NaN fix, not a design choice. docs/DECISIONS.md has no ruling on seeking or nudging inside a spoken line. Persona 58 only rules that the seek pair stays the seek pair in a Foray. Spoken narration (qa 28) is listed as still deferred to the founder, about speed, not seeking. The bug has not been fixed. Severity stays low: spoken bridge lines are short, the tap costs nothing, and crossing back into the previous clip works.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## visual-1 — Episode-notes disclosure chevron renders as a rotated capital "A" (mangled CSS escape)

**confirmed** · verifier severity **medium** (finder: high) · visual · `styles.css:2085` · L7-styles-touch-visual

```json
{
  "id": "visual-1",
  "lens": "visual",
  "title": "Episode-notes disclosure chevron renders as a rotated capital \"A\" (mangled CSS escape)",
  "file": "styles.css",
  "line": 2085,
  "severity": "high",
  "user_visible": "On every episode page that has publisher notes (all live items), the \"Episode notes\" summary row ends in a sideways letter A with a control-glyph box beside it, instead of the › chevron; it rotates to an upside-down A when opened. Confirmed by rendering the markup in headless Chrome (r2/extra/episode-notes-injected.png).",
  "evidence": "styles.css:2084-2091 `.ep-description-toggle::after { content: \"A\"; /* › — rotated to point down when open */ ... transform: rotate(90deg); }` — the bytes on disk are `\" \\302\\203 A \"` i.e. U+0083 (a C1 control char) followed by a literal A. The drawer's chevron at line 599 is written correctly as `content: \"\\203A\"`. The mangled bytes arrived in 37554f6 (2026-09-20, #725): `git show 37554f6 -- styles.css` already contains `302 203 A` — a `\\203A` CSS hex escape was interpreted as an octal byte + \"A\" by whatever wrote the file.",
  "why_subtle": "The comment beside it says › so a code reader sees nothing wrong; the harness's offline data has no `description` field so no baseline screenshot ever showed the toggle; it only paints on a live episode page below the fold.",
  "fix_sketch": "Replace the value with `content: \"\\203A\";` (matching line 599) or the literal `›`; add a check in test/ui-tokens.test.js (or a new test) that no `content:` string in styles.css contains bytes in U+0080–U+009F.",
  "suspected_deliberate": false,
  "relation_to_round1": "new (not in status.tsv; the toggle was never captured because the harness runs offline)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read styles.css at origin/main (9730b5b), and the evidence holds. The bytes for `.ep-description-toggle::after` at lines 2084-2085 are `content: \"` 0xC2 0x83 `A\";`, which is U+0083 (a C1 control character) followed by a literal \"A\". The comment next to it says the glyph should be › (U+203A). Line 599 writes the drawer chevron correctly as `content: \"\\203A\"`, which supports the claim that a `\\203A` escape got mangled. The rule is live: app.js:8372 renders `<summary class=\"ep-description-toggle\">Episode notes</summary>` in the episode-notes `<details>`, and test/episode-description-links.test.js:300 checks that this summary exists. So every episode page with publisher notes shows an \"A\" turned 90deg, plus whatever the browser draws for U+0083, and the \"A\" flips to -90deg when the section opens. docs/DECISIONS.md says nothing about this chevron or selector, so it is not a deliberate choice. Nothing on main has fixed it. I lowered severity to medium: the glitch is visible on every episode page with notes, but it is purely cosmetic. The toggle still opens and closes, and the \"Episode notes\" label is still readable. The fix is to change the value to `\"\\203A\"`.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-2 — Interests sliders paint the browser's default blue on an amber/violet page

**confirmed** · verifier severity **medium** (finder: medium) · visual · `styles.css:1203` · L7-styles-touch-visual

```json
{
  "id": "visual-2",
  "lens": "visual",
  "title": "Interests sliders paint the browser's default blue on an amber/violet page",
  "file": "styles.css",
  "line": 1203,
  "severity": "medium",
  "user_visible": "On #/interests every slider thumb and filled track is UA system blue (Chrome dark-scheme blue; iOS system blue in WKWebView) — the only blue control in the app, on the page that is nothing but sliders. The Now Playing scrubber on the previous screen is amber. (r2/extra/interests.png)",
  "evidence": "`.interest-slider { flex: 1; min-width: 0; touch-action: pan-y; }` (styles.css:1203-1206) declares no `accent-color`; the only `accent-color` rules in the file are `.fp-scrub` (2208) and `body.ui-v2 .fp-scrub { accent-color: var(--amber) }` (3712). app.js:554 emits `<input type=\"range\" class=\"interest-slider\" role=\"slider\" …>`. `body.ui-v2 { color-scheme: dark }` (124) makes the UA paint its dark-scheme blue.",
  "why_subtle": "It is not a v1-token leak (qa 41 fixed those) but the UA palette, so the ui-tokens test that enumerates read tokens cannot see it; the page looks 'fine' in isolation and only wrong beside the amber scrubber.",
  "fix_sketch": "`body.ui-v2 .interest-slider { accent-color: var(--amber); }` (the listener's own material per #127) — and consider the same for any future range input via `input[type=range]`.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends qa 41 (palette leak) — a different source (UA default), not a regression",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "This holds at origin/main. styles.css:1203-1206 `.interest-slider { flex:1; min-width:0; touch-action:pan-y; }` sets no accent-color and no appearance override. I found no ::-webkit-slider-* or ::-moz-range-* rules. A git grep across the html, js and css files finds only two accent-color declarations, both on .fp-scrub (styles.css:2208 uses var(--accent), and 3712 under body.ui-v2 uses var(--amber)). Nothing sets it on body, :root or input[type=range], and index.html doesn't set it either. app.js:554 renders `<input type=\"range\" class=\"interest-slider\">`. body.ui-v2 sets `color-scheme: dark` (styles.css:124), and its comment names \"the native range thumb\" as UA-painted. With no accent-color, the thumb and filled track fall back to the UA accent, which is system blue in Chrome and WebKit. DECISIONS.md has no ruling on sliders, accent colour or blue. The only related line (444) is about v1's \"blue accent\", which is the old theme, not v2's amber/violet. The fix is a one-line CSS rule. Severity: the sliders work fine, so nothing is broken, but #/interests is almost all sliders and the blue clashes with the palette. That makes it medium or low. I'm keeping it at medium because this is the page's only interactive control.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-3 — Home card branch dot is violet on most cards and reads as part of the Stretch tag

**confirmed** · verifier severity **low** (finder: medium) · visual · `styles.css:725` · L7-styles-touch-visual

```json
{
  "id": "visual-3",
  "lens": "visual",
  "title": "Home card branch dot is violet on most cards and reads as part of the Stretch tag",
  "file": "styles.css",
  "line": 725,
  "severity": "medium",
  "user_visible": "On Home's \"Episodes for you\" every card's kicker starts with a 7px coloured dot that is supposed to encode the subject branch; in practice it is the same violet on Education, Paranormal, Adventure, Espionage… and on a Stretch card the violet dot sits 6px before the violet STRETCH tag, so it looks like a bullet for the tag. (r2/dark/home.png, r2/extra/home-bottom.png)",
  "evidence": "`.mini-card { --branch-color: var(--accent); }` (725) with only ten `[data-branch=…]` overrides (728-737: engineering, science, history, craft, business, comedy, food, true-crime, health, culture). `branchOf()` (app.js:1018-1021) returns `topics[0].split('/')[0]`; data/discover.json has 39 top-level branches — nature 79, music 66, medicine 62, economics 61, sports 59, education 51, automotive 47, kids-family 47, society 41, philosophy 38 … ≈1,000 of ~2,300 items — none of which has a colour, so they all fall to `--accent` = violet. The ten that do have colours are raw v1-era hexes (#4c9aff v1 blue, #b07ce8…) outside the v2 palette.",
  "why_subtle": "Each card looks fine alone; the dot only fails as a *code* when you see four cards with identical dots, and the palette drift is invisible on a dark screen.",
  "fix_sketch": "Either drop the dot (the kicker text already names the subject and the tag carries Stretch) or derive `--branch-color` from a stable hash of the branch onto the measured `--seg-c0…c7` palette so every branch gets a v2 colour; add a test that every branch in data/ has a colour if the dot stays.",
  "suspected_deliberate": false,
  "relation_to_round1": "new (round 1 fixed the Stretch tag colour, qa 46, not the dot)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. In styles.css, `.mini-card` sets `--branch-color: var(--accent)` at line 725, and lines 728-737 give only ten branches their own colour: engineering, science, history, craft, business, comedy, food, true-crime, health and culture. Those ten are raw hex values. Engineering's #4c9aff is the same as the v1 `--accent` at line 8. Under body.ui-v2, line 168 sets `--accent: var(--violet)` (#A78BFA), so every other branch gets a violet dot. The dot is `.mc-kicker::before` (lines 757-763): 7px, inside a flex row with `gap: 6px`. On a stretch card, miniCard() in app.js (lines 4652-4664) puts `<span class=\"mc-stretch\">` first in the kicker, and it is coloured with `var(--accent)`, which is violet in v2. So the violet dot sits 6px in front of a violet STRETCH tag. `branchOf()` (app.js 1018-1021) returns `topics[0].split('/')[0]`. I counted data/discover.json on origin/main: 2,167 items and 39 top-level branches. 913 of those items (42%) fall in the 29 branches with no colour (nature 79, music 66, medicine 62, economics 61, sports 59, education 51, and so on). The stretch slot is drawn from branches outside the listener's top ~60% by interest, so a stretch card will often be one of these uncoloured branches, which makes the dot-plus-tag pairing common. Episodes for you reuses miniCard() (app.js ~7858; styles.css 3888-3903), so the problem shows on the v2 Home. I found no DECISIONS.md ruling on dot colours. Line 445 only records moving the branch colour from a border to a kicker dot, which is the design this finding says is broken. It has not been fixed. One detail in the fix sketch is wrong: the kicker shows the episode count and duration; the subject name is in the h3, not the kicker. That doesn't change the finding. I rated it low rather than medium because it is purely visual and misleading decoration; nothing breaks functionally.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-4 — Episode page's sticky header is the whole 2–3-line title; same title is a step smaller and under the art in Now Playing

**confirmed** · verifier severity **medium** (finder: medium) · visual · `app.js:8478` · L7-styles-touch-visual

```json
{
  "id": "visual-4",
  "lens": "visual",
  "title": "Episode page's sticky header is the whole 2–3-line title; same title is a step smaller and under the art in Now Playing",
  "file": "app.js",
  "line": 8478,
  "severity": "medium",
  "user_visible": "On an episode page with a long title (Lex Fridman: 3 lines at 390px) the pinned header is ~125px + the 44px topbar ≈ 20% of the screen, and it slides back in every time the listener reverses scroll inside the notes or the episode list (r2/extra/episode-scrolled-up.png). The art the founder asked to lead the page starts ~200px down. Tap the mini bar and the same episode shows art first, then the title at a smaller size (now-playing.png).",
  "evidence": "app.js:8478-8484 puts `<h2 class=\"fp-s-title\">` inside `.page-head`; `.page-head h2 { font-size: var(--fs-2xl); font-weight: 700 }` (styles.css:1169, specificity 0,1,1) beats `.fp-s-title { font-size: var(--fs-xl) }` (2032), so the page shows the title at 2xl while the sheet shows it at xl. `.page-head` (1143-1153) is `position: sticky` with no clamp on the h2; `.ep-art` comment at 2048-2052 says \"The artwork LEADS the episode page\" but the head renders before it. Apple's episode page collapses to the show name, not the title.",
  "why_subtle": "Show pages have one-line titles so the sticky head looks right there; the problem only appears on long episode titles and only once you scroll and come back up.",
  "fix_sketch": "On episode pages clamp the head h2 to 2 lines (`display:-webkit-box; -webkit-line-clamp:2`) or render the head as ‹ + show name and put the full title under the art like the sheet does; give `.fp-s-title` one size on both surfaces.",
  "suspected_deliberate": true,
  "relation_to_round1": "new (round 1 fixed page-head/transport overlap, qa 48, not the head's height)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. app.js:8476-8484 renders `<h2 class=\"fp-s-title\">` with the full title plus the show/duration/date line inside `.page-head`, and `.ep-art` comes after it. In styles.css, `.page-head` (1143-1153) is `position: sticky` with a background, and nothing clamps the h2's line count (the only line-clamps are on cards and home v2 titles). `.page-head h2` (1169, specificity 0,1,1, --fs-2xl = 1.3rem) beats `.fp-s-title` (2032, 0,1,0, --fs-xl = 1.15rem), and the ui-v2 overrides at 3437 and 3541 don't change either size. So the episode page shows the title one step larger than the player sheet. In player/client.js:787-790 the sheet builds `fp-s-art` before `fp-s-title`, so Now Playing is art first and the episode page is title first. That contradicts the `.ep-art` comment citing the founder's 2026-09-18 note, \"the default should be I mostly see album artwork\". The header coming back on any upward scroll (onWindowScroll, app.js:13319) is deliberate: Wyatt asked for it on 2026-09-05. But I found no ruling in docs/DECISIONS.md or in comments on how tall the episode-page head may be, whether its title should be clamped, or whether it should show the full title rather than the show name. So the complaint isn't covered by a decision, and neither the round-1 transport-overlap fix nor anything else has fixed it. I didn't re-measure the pixel figures, but a 2–3-line 1.3rem title plus the meta line plus 16px of padding makes ~110-125px plausible. Severity is medium: visible on every long-titled episode page and it goes against a stated founder direction, but it's layout polish, not broken function.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-5 — The same transport buttons have two type specs, two elevations and two heights on the Foray page vs the Now Playing sheet

**confirmed** · verifier severity **low** (finder: medium) · visual · `styles.css:2694` · L7-styles-touch-visual

```json
{
  "id": "visual-5",
  "lens": "visual",
  "title": "The same transport buttons have two type specs, two elevations and two heights on the Foray page vs the Now Playing sheet",
  "file": "styles.css",
  "line": 2694,
  "severity": "medium",
  "user_visible": "On the Foray page ↺15 / 30↻ are 60×48 boxes in bold 0.9rem with a drop shadow; open Now Playing for the same Foray and they are 56×48 boxes in regular 0.82rem with no shadow; the mini bar prints ↺ 15 at 0.74rem. The speed button is 48px tall on the page and 44px in the sheet. (foray.png vs now-playing.png vs mini-bar.png)",
  "evidence": "`.fy-btn { min-width: 60px; min-height: 48px; box-shadow: var(--shadow); font-size: var(--fs-md); font-weight: 600 }` (2694-2703) and `body.ui-v2 .fy-btn` (3570-3574) does not reset the shadow; `.fp-btn { min-width: 56px; height: 48px; font-size: var(--fs-sm) }` (2221-2226) and `body.ui-v2 .fp-btn { box-shadow: none }` (3714-3719); `.fp-rate, .fp-stop { min-height: 44px }` (2274-2278) while the comment at 2268-2273 says they \"share the Foray page's .fy-btn.fy-rate metrics (44px…)\" — `.fy-btn.fy-rate` inherits `min-height: 48px`; `.fp-skip { font-size: var(--fs-xs) }` (1864-1870).",
  "why_subtle": "The two surfaces are never on screen together, so each looks internally consistent; the mismatch is felt as 'the player looks different in the sheet' without being nameable.",
  "fix_sketch": "One shared rule for the seek pair and the rate button (`.fy-btn, .fp-btn { … }` or a `.transport-btn` class emitted by both renderers): 48px, `--fs-md` 600, one elevation; fix the 44/48 comment to match.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends persona 58 / the visual-pass transport work (it unified the controls' behaviour, not their metrics)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read styles.css at origin/main and every cited rule is there as described. `.fy-btn` (2694-2703) sets min-width 60px, min-height 48px, box-shadow var(--shadow), font-size var(--fs-md) (0.9rem) and weight 600. `body.ui-v2 .fy-btn` (3570-3574) resets only the border, background and colour, so the page's seek buttons keep their shadow. `.fp-btn` (2221-2226) sets min-width 56px, height 48px and var(--fs-sm) (0.82rem) with no weight, and `body.ui-v2 .fp-btn` (3714-3719) sets box-shadow none. ui-v2 is now the only UI (app.js:777-790).\n\nBoth renderers use these classes for the same controls: app.js:9831/9833 renders the page's pair as `fy-btn`, and player/client.js:809/815 renders the sheet's pair as `fp-btn`. So on the page ↺15 / 30↻ are 60x48, bold 0.9rem, with a shadow. In the sheet they are 56x48, regular 0.82rem, with no shadow.\n\nThe speed buttons differ too. `.fy-btn.fy-rate` (2721) does not override the inherited min-height of 48px, while `.fp-rate` is 44px (2274). The comment at 2268-2273 says the sheet shares the page's `.fy-btn.fy-rate` metrics (\"44px\"), which is factually wrong. test/transport-controls.test.js:179 only checks `.fp-rate` >= 44, so nothing catches the mismatch.\n\nThe 2026-09-23 visual-pass entry in DECISIONS.md approves persona 58's transport redesign but does not make the page and sheet deliberately different. The intent in the code comment is that they match, so this is drift, not a ruling.\n\nOne part is intentional. The mini bar's ↺15 at var(--fs-xs), 44px and borderless is persona 10's quiet-glyph design, pinned by transport-controls.test.js:76-79. That part of the \"user_visible\" claim is by design, not a defect.\n\nThe main page-vs-sheet mismatch is real but purely cosmetic: size, weight, shadow, and 4px of height. Every target clears the 44px floor. I am lowering severity from medium to low.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-6 — Tab roots (Search, Create, Library, Playlists) carry a boxed ‹ back button while Home has none; boxed ‹ sits under borderless ☰/↻

**confirmed** · verifier severity **low** (finder: medium) · visual · `app.js:903` · L7-styles-touch-visual

```json
{
  "id": "visual-6",
  "lens": "visual",
  "title": "Tab roots (Search, Create, Library, Playlists) carry a boxed ‹ back button while Home has none; boxed ‹ sits under borderless ☰/↻",
  "file": "app.js",
  "line": 903,
  "severity": "medium",
  "user_visible": "Tapping the Search, Create or Library tab lands on a page whose first control is a 44px bordered ‹ that goes to Home — a back button on a tab root, which Apple never shows, directly beneath the topbar's borderless ☰ and ↻ (search-idle.png, create.png, library.png). Home, the fourth tab, has no such button.",
  "evidence": "`<a class=\"back\" href=\"#/\">‹</a>` is emitted by the shared head helper at app.js:903 and by renderLibrary (8798), renderCreate (8963), renderPlaylists (8832) and Search's head; `.page-head .back { width: 44px; height: 44px; border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius-md) }` (styles.css:1158-1168) vs `.topbar button { width: 42px; height: 42px; border: none; background: none }` (477-488). `tabForHash` already knows which route is a tab root (qa 120 fix).",
  "why_subtle": "The button is harmless (it does go somewhere) so nobody files it as a bug; it just makes every tab feel like a sub-page, which is one of the ways the app is 'not like Apple Podcasts'.",
  "fix_sketch": "In the page-head helper, omit `.back` when `tabForHash(route)` equals the page's own tab (Search, Create, Library roots); keep it on pushed pages (show, episode, foray, queue, playlist detail). Optionally make `.back` borderless like the topbar glyphs so the two icon-button treatments agree.",
  "suspected_deliberate": true,
  "relation_to_round1": "new (no round-1 row; not in DECISIONS.md)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main, apart from one wrong citation. The three tab roots really do carry a boxed back link to Home. TAB_ROUTES (app.js:11131) sends Search to #/shows, and renderAllShows draws that page through renderShowIndexPage, which emits `<a class=\"back\" href=\"#/\">‹</a>` at app.js:2541. renderLibrary emits the same link at 8798 and renderCreate at 8963. #/playlists (renderPlaylists, 8832) has one too, but it is not a tab root: it is reached from Create or Library, so its back link is arguably fine. The CSS matches the finding. `.page-head .back` (styles.css:1158-1168) is a 44px box with a 1px var(--line) border on var(--surface), and body.ui-v2 (3432) keeps both the border and the surface. `.topbar button` (477-488) is 42px with `border: none; background: none`. Nothing in the CSS or JS hides .back on tab roots.\n\nCorrection: app.js:903 is not a shared head helper. It is statusPageHtml, which only draws the error and loading pages (the qa 105 fix). Each tab root writes its own page-head inline, so the fix sketch's 'in the page-head helper' does not exist as described. The fix means editing renderShowIndexPage (conditionally, because the category page shares it and should keep its back link), renderLibrary and renderCreate.\n\nDeliberate? No docs/DECISIONS.md entry rules on back buttons on tab roots. The 2026-09-23 visual-pass ruling names Apple Podcasts as the benchmark, which argues for removing them. One test does pin the Search button, though: test/search-page-chrome.test.js:282 asserts `head.includes('class=\"back\"')` with the comment \"the ‹ button is how you leave this page\". That reads as a leftover from before the tab bar, kept while the header shape was being consolidated, not a product ruling. It is still a test a fix must update, and a reason to treat this as 'probably not deliberate' rather than proven accidental.\n\nSeverity: low. Nothing is broken; the button works (it goes Home). The harm is a redundant, un-iOS-like control and two icon-button styles that don't match. That is polish, not a medium defect.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-7 — "Where this came from" rows: the ↗ link floats at a different x on every row

**confirmed** · verifier severity **low** (finder: medium) · visual · `app.js:9631` · L7-styles-touch-visual

```json
{
  "id": "visual-7",
  "lens": "visual",
  "title": "\"Where this came from\" rows: the ↗ link floats at a different x on every row",
  "file": "app.js",
  "line": 9631,
  "severity": "medium",
  "user_visible": "At the bottom of a Foray page the publisher-credit rows put the ↗ (open on Apple Podcasts) at a different horizontal position on each row — x≈548, 481, 416, 449, 447, 533 device px on six consecutive rows — because it is centred in whatever space is left between the show name and the clip count. (r2/extra/foray-bottom.png)",
  "evidence": "app.js:9631-9636 emits `.fy-src-head` with three children (`.fy-src-show`, `a.fy-src-out`, `.fy-src-meta`); `.fy-src-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px }` (styles.css:3117-3120) and `.fy-src-out { flex: none }` (3122), so the middle child is placed at the midpoint of the free space.",
  "why_subtle": "Each row is individually plausible; the wander only shows as a ragged column when several rows are stacked, which is exactly how the section renders.",
  "fix_sketch": "`.fy-src-show { flex: 1 1 auto; min-width: 0 }` and keep ↗ + meta as a trailing group (`.fy-src-out { margin-left: auto }` or move the link after the meta with `gap: 8px`), so the glyph aligns down the right edge.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and it holds. In app.js, foraySourcesHtml (around lines 9628-9636) builds `.fy-src-head` with three children in this order: `span.fy-src-show`, `a.fy-src-out` (↗) and `span.fy-src-meta`. styles.css:3117-3124 sets `.fy-src-head { display:flex; justify-content:space-between; align-items:baseline; gap:10px }`, gives `.fy-src-show` no flex rule, and sets `flex:none` on both `.fy-src-out` and `.fy-src-meta`. With space-between and three children, the middle one (↗) lands halfway through whatever space is left over. That space depends on how long each show name and each \"N clips · span\" label is, so the glyph sits at a different x on every card, just as the finding says.\n\nNothing suggests it was done on purpose. docs/DECISIONS.md has no ruling on this block's layout. The last change to these rules was the audit fix 9c2f7c4 (#742), which only added `:active` to `.fy-src-out` and left the layout alone, so it is not fixed. The fix sketch is sound: put `margin-left:auto` on `.fy-src-out`, or move the link after the meta.\n\nI'm rating it low rather than medium. It is a cosmetic alignment problem in a credits section at the bottom of the page. The link still works, can be tapped and has an aria-label. Nothing is lost or broken; the column just looks ragged.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-11 — Up Next row mixes circular and rounded-square 40px controls on one line

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:1385` · L7-styles-touch-visual

```json
{
  "id": "visual-11",
  "lens": "visual",
  "title": "Up Next row mixes circular and rounded-square 40px controls on one line",
  "file": "styles.css",
  "line": 1385,
  "severity": "low",
  "user_visible": "On #/queue each row's control line is: round ▶, bare ★, then two rounded-square ↑ ↓ boxes, then a round ✕ — two silhouettes for four bordered 40px buttons. (r2/extra/queue-full.png)",
  "evidence": "`button.reorder { width: 40px; height: 40px; border-radius: var(--radius-md) }` (1385-1395) vs `button.up-next-remove { width: 40px; height: 40px; border-radius: var(--radius-round) }` (1399-1410) and `.play-btn { border-radius: var(--radius-round) }` (1422-1431). Design notes: 'controls ≤48px on md' and 'circular controls: play, thumbs, q-num, companion ✕' — the reorder pair and ✕ fall on different sides of that rule while sitting 20px apart.",
  "why_subtle": "Each button is on the radius scale; the inconsistency is between siblings, which no token test can see.",
  "fix_sketch": "Make the reorder pair round (matches ▶ and ✕) or make ✕ md; one silhouette per row.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends the round-1 two-line Up Next row (qa rows on the queue row, persona 40) — the layout was fixed, the shapes were not",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches what the finding says. In styles.css, `button.reorder` (lines 1385-1395) is 40x40 with `border-radius: var(--radius-md)`, which is 12px, a rounded square. `button.up-next-remove` (1399-1410) is 40x40 with `margin-left: 20px` and `border-radius: var(--radius-round)`, which is 50%, a circle. `.play-btn` (1422-1431) is also round. The `body.ui-v2` overrides (3647-3660) change only border, background and color, not the radius. ui-v2 is now the only UI, so the base radii are what users see. app.js:8565-8569 renders the ↑↓ reorder pair right next to the ✕ on each #/queue row, so both shapes show up on the same control line.\n\nI found no ruling that makes this deliberate. docs/DECISIONS.md:1382 covers only where reorder and remove appear (#/queue only), not their shape. The only relevant guidance is in the radius token comments (styles.css:34-39). They assign `--radius-md` to \"buttons and controls (<=48px)\" and `--radius-round` to \"play, thumbs, q-num, companion ✕\". The queue ✕ is not the companion ✕, so it falls on a different side of that rule than the reorder buttons, and nothing explains the split. It has not been fixed. The earlier persona-40 and qa-row work changed row layout, sizes and the ✕ color, but not the shapes.\n\nSeverity is low: this is only a visual inconsistency and nothing breaks.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-12 — Section titles at two steps (and a third on Interests) while the comment claims one

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:2735` · L7-styles-touch-visual

```json
{
  "id": "visual-12",
  "lens": "visual",
  "title": "Section titles at two steps (and a third on Interests) while the comment claims one",
  "file": "styles.css",
  "line": 2735,
  "severity": "low",
  "user_visible": "Home's \"Forays for you\" is 1.15rem; a Foray's running-order headings (\"Why venture capital is the wrong default\") are 1rem/600 — the same size as the row titles they head; Interests group headings are 1rem/700. Three sizes for 'the heading of a group of cards'. (home.png, foray.png, interests.png)",
  "evidence": "`.fy-slot h3 { font-size: var(--fs-lg); font-weight: 600 }` (2735-2741) with the comment 'at the section-title step, like \"Forays for you\" on Home', but `.hv2-title { font-size: var(--fs-xl) }` (3776-3779); `.interest-group-label { font-size: var(--fs-lg); font-weight: 700 }` (1181-1184). design-notes.md defines exactly two heading kinds: section title = display/--fs-xl/600 and eyebrow.",
  "why_subtle": "All three read the display face, so they pass the 'one face by role' test; only the step differs, and headings are never side by side.",
  "fix_sketch": "`.fy-slot h3, .interest-group-label { font-size: var(--fs-xl); font-weight: 600 }` (or, if the lg step is intended as a sub-heading, name it in the type table and fix the comment); pin in test/ui-tokens.test.js that section-title selectors read one step.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 51 (label styles were unified; title steps were not)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main (the latest styles.css commits are 9730b5b, #744 and #742) and the evidence holds.\n\n- **Foray running-order headings:** styles.css:2735-2741 sets `.fy-slot h3` to `font-size: var(--fs-lg); font-weight: 600`. The comment right above it says the heading is \"at the section-title step, like 'Forays for you' on Home\".\n- **Home's \"Forays for you\":** that heading is an `h2.hv2-title` (app.js:7814). styles.css:3776-3779 gives `body.ui-v2 .hv2-title` the size `var(--fs-xl)`, which is a different step.\n- **Interests group headings:** styles.css:1181-1184 gives `.interest-group-label` the size `var(--fs-lg)` and weight 700.\n- **The type table contradicts the comment:** styles.css:54-55 defines `--fs-lg: 1rem` as \"row/card titles, drawer nav, inputs\" and `--fs-xl: 1.15rem` as \"section titles, sheet titles, Now Playing title\". So the Foray's running-order headings sit at the row-title step and the comment is wrong.\n- **Users see it:** ui-v2 is now the only UI (app.js:777, 857), so the `body.ui-v2` rules apply to every page.\n- **Test gap:** the test in test/ui-tokens.test.js (\"the two heading kinds\", around line 546) pins only font-family and text-transform for `.hv2-title`, `.fy-slot h3` and `.page-head h2`. It never checks font-size, so the drift passes.\n- **Not a decision on record:** docs/DECISIONS.md has a 2026-09-23 ruling approving the visual pass in general, but nothing that sets the section-title step at lg for these headings. This finding came out of that pass, so the ruling does not make it deliberate.\n- **Minor correction:** no design-notes.md exists at origin/main. The two-heading-kinds rule the finding cites is actually in the styles.css comment at about line 2093 and in the token table, which support the finding just as well.\n\nIt stays low severity: the two sizes differ by only 0.15rem and nothing breaks.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-13 — Four page gutters: 12px pages, 14px Home, 16px Now Playing sheet, 18px other sheets

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:2013` · L7-styles-touch-visual

```json
{
  "id": "visual-13",
  "lens": "visual",
  "title": "Four page gutters: 12px pages, 14px Home, 16px Now Playing sheet, 18px other sheets",
  "file": "styles.css",
  "line": 2013,
  "severity": "low",
  "user_visible": "The same episode title starts at x=12 on the episode page and x=16 in the Now Playing sheet (24 vs 32 device px in episode.png vs now-playing.png); Home content sits at 14; the feedback/delete/voice sheets at 18.",
  "evidence": "`.page { padding: 12px 12px … }` (1126); `.hv2-greeting/.hv2-title/.hv2-cards { padding: 0 14px }` (3770, 3777, 3796); `.fp-sheet-scroll { padding: 0 16px … }` (2013); `.fy-panel { padding: 8px 18px … }` (2919). design-notes.md sanctions only 12 (pages) and 14 (Home).",
  "why_subtle": "Two-pixel gutter differences are below conscious notice but register as 'this sheet is a different app'; the sheet and the page are opened from each other.",
  "fix_sketch": "One `--gutter` token (14 or 16px) on `:root`, read by `.page`, `.hv2-*`, `.fp-sheet-scroll` and `.fy-panel`; pin it in ui-tokens.test.",
  "suspected_deliberate": true,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read styles.css at origin/main myself and all four gutters are there. `.page` has `padding: 12px 12px …` (line 1123–1126). `body.ui-v2 .hv2-greeting` (3768), `.hv2-title` (3776) and `.hv2-cards` (3796) each use `padding: … 14px`. `.fp-sheet-scroll` has `padding: 0 16px …` (2007–2013); it is the Now Playing sheet's scroller, created in player/client.js:786. `.fy-panel` has `padding: 8px 18px …` (2915–2919). Nothing overrides them: the ui-v2 `.fy-panel` rule at 3608 only changes the background and border. Home is not inside `.page`: its `.hv2-home` container at 3759 has 0 horizontal padding, so Home's inset really is 14px. There is no `--gutter` token. docs/DECISIONS.md has no ruling on gutters or insets. The \"design-notes.md\" the finding cites is not in the repo; styles.css:41 calls it scratchpad notes, so no committed rule allows the difference. I did not look at the screenshots, but the CSS matches the claimed x positions. Severity is low: the edges are a few pixels off from screen to screen, which is inconsistent but breaks nothing.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-14 — Row elevation is mixed inside one column (lifted, flat, lifted) on Library and Foray pages

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:3584` · L7-styles-touch-visual

```json
{
  "id": "visual-14",
  "lens": "visual",
  "title": "Row elevation is mixed inside one column (lifted, flat, lifted) on Library and Foray pages",
  "file": "styles.css",
  "line": 3584,
  "severity": "low",
  "user_visible": "In Library the Forays row has a drop shadow, the Followed-shows row under it is flat, and the Saved rows under that are lifted again (library-full.png); a Foray's clip cards are flat while the episode rows one tap back are lifted.",
  "evidence": "`.ep-row, .pl-row { box-shadow: var(--shadow) }` (1217-1230); `.show-result` (1005-1015) declares no shadow; `body.ui-v2 .fy-row { box-shadow: none }` (3581-3585); `.fy-src` (3110-3116), `.voice-row` (3246-3253), `.rate-option` (3006-3015) none. design-notes.md: `--shadow` = 'cards, rows, inputs'.",
  "why_subtle": "Shadows on a dark surface are faint, so the mismatch reads as 'slightly uneven' rather than as a difference anyone names.",
  "fix_sketch": "Decide once ('row on --surface = --shadow', or flat everywhere like Apple's grouped lists) and apply to `.show-result`, `.fy-row`, `.fy-src`; qa 53 deferred exactly this as taste — it now shows on three pages.",
  "suspected_deliberate": true,
  "relation_to_round1": "extends qa 53 ('elevation difference left as taste')",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the evidence holds. `.ep-row, .pl-row` set `box-shadow: var(--shadow)` at styles.css line 1225. The ui-v2 override at 3494-3498 does not remove it. Library's Forays section uses libSummaryRow, which emits `<a class=\"pl-row\">` (app.js 8706), so those rows are lifted. Followed shows uses `.show-results` > `.show-result` (app.js 8749). That rule (1005-1015) and its ui-v2 override (3477-3481) declare no shadow, so those rows are flat. The Saved rows use rowHtml → ep-row and are lifted again. The user really does see lifted, flat, lifted inside one Library column.\n\nOn a Foray page, the base `.fy-row` (2746-2755) has `box-shadow: var(--shadow)`, and its comment says it matches `.ep-row one page back`. But `body.ui-v2 .fy-row { box-shadow: none }` (3581-3585) cancels that. ui-v2 is now the only UI (app.js ~777), so the clip cards render flat while the episode rows are lifted. The code contradicts its own stated intent. `.fy-src` (3110-3116) also has no shadow.\n\n`--shadow` is documented as 'cards, rows, inputs' (line 68). No ruling in docs/DECISIONS.md covers row elevation. Its only relevant text says the design system has 'four elevations' pinned by tokens. The one precedent is qa 53 in docs/audit/status.tsv: 'fixed … elevation difference left as taste'. That is a status note deferring the question, not a decision ruling that the mix is intended, so the finding is not 'deliberate'. It has not been fixed.\n\nMinor inaccuracies that do not change the verdict: `.voice-row` and `.rate-option` are rows inside sheets, on --surface-2, so they are a weaker comparison. The comment at 1221 mentions `var(--radius)` for `.show-result`, but the code uses `--radius-lg`, which is not relevant to this finding. Severity is low: a purely cosmetic inconsistency.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-15 — Row titles split 600/700 by surface; the Forays page row is heavier than the same Foray's Home card

**confirmed** · verifier severity **low** (finder: low) · visual · `styles.css:2335` · L7-styles-touch-visual

```json
{
  "id": "visual-15",
  "lens": "visual",
  "title": "Row titles split 600/700 by surface; the Forays page row is heavier than the same Foray's Home card",
  "file": "styles.css",
  "line": 2335,
  "severity": "low",
  "user_visible": "The same Foray title is bold-700 on the Forays page and 600 on Home's card; publisher names in 'Where this came from' are 700 while show names in search results are 600; 'used in the following forays' titles are 700 at a smaller (0.9rem) size than every other row title. (forays.png vs home.png; foray-bottom.png)",
  "evidence": "600: `.ep-row .t` (1233), `.show-result-title` (1035-1038), `.hv2-*-title` (3819-3822), `.mc-info h3` (781-783), `.ft-value-prop h4` (2965). 700: `.fy-home-title` (2335), `.fy-src-show` (3121), `.fp-title` (1844), `.interest-row-name` (1198), `.show-forays-title { font-size: var(--fs-md); font-weight: 700 }` (3183). design-notes.md allows 'display titles 600-700' but names no rule for which.",
  "why_subtle": "Fraunces at 600 and 700 differ by a hair on a phone; it reads as inconsistent ink density between pages rather than as a weight change.",
  "fix_sketch": "One `.row-title` treatment (display, --fs-lg, 600) for every list row; keep 700 for page titles and the wordmark only; pin in ui-tokens.test.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends qa 43/51 (faces unified; weights not)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read styles.css at origin/main and every cited line matches. The 600 rules are `.ep-row .t` (1233), `.show-result-title` (1035), `.mc-info h3` (781), `.ft-value-prop h4` (2965) and `body.ui-v2 .hv2-jbi/foray/playlist-title` (3819). The 700 rules are `.fy-home-title` (2335, --fs-lg), `.fy-src-show` (3121), `.fp-title` (1844, --fs-md), `.interest-row-name` (1198) and `.show-forays-title` (3183, --fs-md 700).\n\nThe user does see this. app.js renders the same Foray title as `hv2-foray-title` (600) on Home at line 7786 and as `fy-home-title` (700) at line 10918 on the Forays index. ui-v2 is now the only UI, so the hv2 rule applies.\n\nNo ruling covers it: docs/DECISIONS.md has nothing about title font weight, and design-notes only gives the 600-700 range without saying which to use where. Nothing on main fixes it. The problem is real but cosmetic: it is one weight step inside the documented range, so severity is low.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-16 — Search results: the shows tier has no eyebrow while Episodes and Playlists do

**confirmed** · verifier severity **low** (finder: low) · visual · `app.js:7345` · L7-styles-touch-visual

```json
{
  "id": "visual-16",
  "lens": "visual",
  "title": "Search results: the shows tier has no eyebrow while Episodes and Playlists do",
  "file": "app.js",
  "line": 7345,
  "severity": "low",
  "user_visible": "Searching 'lex' shows a bare show row under the page head, then an EPISODES label, then episode rows (r2/extra/search-lex.png); with playlists present a PLAYLISTS label follows. The first tier is the only unlabelled one.",
  "evidence": "app.js:7345 `<h3>Episodes…</h3>` and 6984 `<h3>Playlists</h3>` wrap their tiers; show rows are emitted at 3382 `<div class=\"show-results\">${shows.map(showResultRow)…}` with no heading.",
  "why_subtle": "A single show row looks like 'the answer' so the missing label goes unnoticed until a query returns several shows and the list reads as two differently-organised lists.",
  "fix_sketch": "Add a `<h3>Shows</h3>` eyebrow above the show tier (same `.ep-more h3` style), or drop all tier labels and separate tiers by row shape alone.",
  "suspected_deliberate": true,
  "relation_to_round1": "extends qa 53 (row shapes in search results)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The substance holds at origin/main, though one citation is wrong. Line 3382 is similarShowsSection, which is on the show page and has its own \"<h3>Similar shows</h3>\". It is not search. The real search show tier is `#sh-results` (app.js:2937, `<div id=\"sh-results\" class=\"show-results\" hidden>`). paintShowResults (about lines 6268-6308) fills it with `results.innerHTML = shows.map(showResultRow).join(\"\")` and never adds a heading. The Episodes tier (7344-7345, `<section class=\"ep-more fy-episode-search\"><h3>Episodes…</h3>`) and the Playlists tier (6983-6984, `<h3>Playlists</h3>`) are both labelled. So a search that returns shows puts an unlabelled show list first, with labelled Episodes and Playlists sections under it, which is what the user would see. The comment at about line 6287 (\"The note sits above the Episodes and Playlists sections… SCOPED TO SHOWS… It names what it searched\") shows the authors know about the tiers. Their fix went into the empty-state note text, not into a label for the non-empty list. In docs/DECISIONS.md, the \"one eyebrow\" item (qa 43/47/51…, line ~117) is about how type is styled. It is not a ruling that the shows tier goes unlabelled, and grep turned up no decision on search-tier labels. The finding may still have been left this way on purpose, since the page head reads \"Search\" and the show rows have their own shape, but nothing documents that. It is cosmetic, so severity is low.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## visual-17 — Interests page says every branch name twice (group heading over a single card with the same name)

**confirmed** · verifier severity **low** (finder: low) · visual · `app.js:582` · L7-styles-touch-visual

```json
{
  "id": "visual-17",
  "lens": "visual",
  "title": "Interests page says every branch name twice (group heading over a single card with the same name)",
  "file": "app.js",
  "line": 582,
  "severity": "low",
  "user_visible": "On #/interests almost every block is a heading 'Adventure' above one card whose title is 'Adventure' (then Architecture/Architecture, Automotive/Automotive…), a slider, and a 'Back to 4a's pick' button — the page is visually twice as long as its content. (r2/extra/interests.png)",
  "evidence": "app.js:582 `<h3 class=\"interest-group-label\">${esc(g.root.label)}</h3>` followed by rows whose `.interest-row-name` is the topic label; for a root with no sub-topics the two labels are identical. `.interest-row-root { border-color: var(--text-dim) }` (styles.css:1193) already marks the root row.",
  "why_subtle": "Both labels are correct data; it is the rendering of a one-child group that produces the echo.",
  "fix_sketch": "When a group has one row whose label equals the root label, render the row without the group heading (or the heading without a card); keep the heading only for roots that have sub-topics.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code is as the finding describes. In renderInterests (app.js around lines 578-584), each group prints `<h3 class=\"interest-group-label\">${esc(g.root.label)}</h3>` and then `g.rows.map(interestSliderRow)`. interestSliderRow prints `.interest-row-name` with `node.label`. In interestGroups (app.js around lines 523-543), every root always gets exactly one row: itself. Leaves are added to a group only after their weight has moved away from the taxonomy default. So a new or lightly used listener sees every group as a heading plus one card with the same name. For such a listener that is every group, which is more than the finding's \"almost every block\".\n\nThe styles make both labels equally prominent. `.interest-group-label` and `.interest-row-name` are both font-weight 700 at --fs-lg (styles.css lines 1181-1198). Each card also has its own border, shadow and 12px padding.\n\nI found no ruling that allows this. The code comment and DECISIONS.md cover grouping by root, always showing roots, the 0-1 range, and having no history feed (D6). None of them says to repeat the heading over a lone root card. The recent commits (#742, #744, #746) did not change this. The problem is only visual: the page is about twice as long and repeats every name, but nothing breaks and no data is wrong. So severity is low.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## a11y-1 — Zoom was removed on the stated ground that "Dynamic Type already scales the page" — but nothing in the page or the iOS shell honours Dynamic Type, so the only text-size affordance a low-vision listener had is gone with no replacement

**confirmed** · verifier severity **medium** (finder: high) · a11y · `docs/DECISIONS.md:41` · L3-queue-and-native-surfaces

```json
{
  "id": "a11y-1",
  "lens": "a11y",
  "title": "Zoom was removed on the stated ground that \"Dynamic Type already scales the page\" — but nothing in the page or the iOS shell honours Dynamic Type, so the only text-size affordance a low-vision listener had is gone with no replacement",
  "file": "docs/DECISIONS.md:41 (claim); index.html:12 (viewport); styles.css:265, styles.css:46-63 (rem scale on a fixed 16px root); mobile/ + ios/ (no handler)",
  "line": 41,
  "severity": "high",
  "user_visible": "A listener with iOS Text Size turned up (Settings > Accessibility > Display & Text Size) opens 4a and every line is the same size it was at the default — 10.5px tab labels, 11.8px captions, 13px meta — and pinch-to-zoom, which was the 2026-09-17 accessibility fallback, no longer works either. Apple Podcasts on the same phone grows with the setting.",
  "evidence": "DECISIONS.md 2026-09-23 §1: \"Cost, named: a listener who relied on pinch to read small text has lost it; the answer to that is type size, not zoom, and Dynamic Type already scales the page.\" But WKWebView applies Dynamic Type only to text set with the `-apple-system-body`/`-apple-system-*` font keywords, and styles.css has none: `grep -rniE 'dynamic ?type|contentSizeCategory|textZoom|preferredContentSize|apple-system-body' mobile ios app.js player styles.css` returns only the DECISIONS line and the comment at styles.css:46. The whole scale is rem on an unset root (`--fs-2xs: 0.66rem` … `--fs-2xl: 1.3rem`, styles.css:52-59), `html { -webkit-text-size-adjust: 100%; }` (265) pins it, and index.html:12 ships `maximum-scale=1, user-scalable=no` with the gesturestart guard at app.js:14083 behind it. Android WebView does apply the system font scale by default (no textZoom override in mobile/), so this is iOS-specific — the platform the founder tests on.",
  "why_subtle": "The comment in index.html and the DECISIONS entry read as though the trade-off was weighed and covered; nobody checks that WKWebView actually scales rem text with Dynamic Type (it does not), and on a developer's phone at the default size nothing looks wrong.",
  "fix_sketch": "Keep the no-zoom ruling and make the compensating claim true: (a) in the iOS shell, read `UIApplication.shared.preferredContentSizeCategory` (and observe `UIContentSizeCategory.didChangeNotification`) and hand a scale factor to the page (e.g. `document.documentElement.style.fontSize = (16 * factor) + 'px'`, or a `--type-scale` custom property the rem scale multiplies by); (b) audit the fixed-px chrome (`--topbar-h: 44px`, `--tab-bar-h: 56px`, `.topbar h1 { overflow: hidden; white-space: nowrap }` at styles.css:439-447) so it grows or wraps at 1.3–1.6x rather than clipping; (c) pin it in a test that fails if no Dynamic Type path exists. Until then, correct the DECISIONS.md sentence so the next reader does not rely on it.",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Round 1's 2026-09-17 ruling kept pinch precisely as the a11y fallback; the 2026-09-23 reversal removed it citing a compensation that is not implemented.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and every part of the evidence holds.\n\n- **The claim.** docs/DECISIONS.md lines 26-41 (2026-09-23 §1) removes zoom and justifies it with \"Dynamic Type already scales the page.\"\n- **The page blocks zoom.** index.html ships `maximum-scale=1, user-scalable=no`.\n- **Text size is pinned.** styles.css:265 sets `html { -webkit-text-size-adjust: 100%; }`. The type scale at styles.css:52-59 is plain rem (0.66rem to 1.3rem), and no font-size is ever set on the root.\n- **No Dynamic Type path exists anywhere.** I searched the whole repo, excluding .md files, for dynamic type, contentSizeCategory, textZoom, preferredContentSize, apple-system-body, documentElement.style.fontSize and a type-scale property. The only hit outside the archive is the comment at styles.css:46, which only compares the scale's sizes to Apple's Dynamic Type sizes and implements nothing.\n- **Nothing in the native code or the app either.** Neither ios/App/*.swift nor mobile/plugins/foray-audio/ios reads the system text size. There is no in-app text-size setting.\n\nWKWebView applies iOS Larger Text only to text that uses the -apple-system-* font keywords, so on iPhone the page stays at its fixed sizes. Pinch-to-zoom, the old fallback, is now blocked, which makes the finding's user-visible description accurate.\n\n**Why this is not 'deliberate':** the ruling deliberately removes zoom, but it rests on a compensation that does not exist. The defect is that false statement plus the missing text scaling, and nothing has fixed either one.\n\n**Why medium, not high:** only listeners who rely on larger text are affected, the app is used mainly by the founder, and the zoom removal was the founder's explicit choice. It is still a real accessibility regression, and the decision record is wrong on a point of fact.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## a11y-2 — The player's only live region sits inside the mini bar, and expanding Now Playing makes that bar inert — so "Buffering…" and "That episode could not load" are never announced from the screen the listener is actually on

**confirmed** · verifier severity **medium** (finder: high) · a11y · `player/client.js:730` · L2-sheets-drawer-gestures

```json
{
  "id": "a11y-2",
  "lens": "a11y",
  "title": "The player's only live region sits inside the mini bar, and expanding Now Playing makes that bar inert — so \"Buffering…\" and \"That episode could not load\" are never announced from the screen the listener is actually on",
  "file": "player/client.js:682-684, 730 (region lives in `bar`); player/client.js:2501-2507 (openSheet inerts the bar); app.js:4917-4934 (inertOutside walks the sheet's siblings); player/client.js:1665 (the write)",
  "line": 730,
  "severity": "high",
  "user_visible": "A VoiceOver/TalkBack user has the Now Playing sheet open. The stream stalls (or a play fails): the sheet paints \"Buffering…\" / \"That episode could not load…\" in `.fp-err-line`, a plain <p>, and nothing is spoken. The same event on the collapsed bar IS spoken. The review of 2026-09-23 moved the region out of the button so VoiceOver would read it — and it is silent again in the sheet, the one place a listener stops to look at the transport.",
  "evidence": "buildUI: `const announce = el(\"span\", \"fp-announce sr-only\"); announce.setAttribute(\"role\", \"status\"); announce.setAttribute(\"aria-live\", \"polite\");` then `bar.append(art, info, skipBtn, playBtn, announce); root.append(progress, bar);` … `root.append(sheet);` (682-730, 893). setExpanded: `owner.openSheet(ui.sheet, { panel: ui.sheet, bodyClass: \"fp-expanded\", keepReachable: [\".topbar\", \"#drawer\", \"#drawer-overlay\"], … })` (2501-2507). inertOutside starts at `node = wrap` and inerts every sibling of `.fp-sheet` inside `#foray-player` — `progress` and `bar` — before walking up (4917-4934); the owner's own comment says so: \"the mini bar under the sheet goes inert\" (2495). paintStatus then writes `ui.announce.textContent = sheetLine` (1665) into an inert subtree, and `ui.sErr` (`<p class=\"fp-err-line\">`, 869-870) carries no role. test/modal-and-focus.test.js models `np.wrap` as a body child (277-295), so the suite cannot see the bar-and-sheet-share-a-root case.",
  "why_subtle": "`inert` is invisible; the failure line is visibly painted in the sheet so a sighted tester sees the fix working; and the test's DOM model puts the sheet on <body>, where the bug cannot occur.",
  "fix_sketch": "Move the live region out of the bar: append `announce` to `root` after the sheet (a sibling of both), and add `\".fp-announce\"` to Now Playing's `keepReachable` — or simplest, give `ui.sErr` `role=\"status\"` `aria-live=\"polite\"` (it is written once per change already) and keep the bar one for the collapsed state. Add a test that opens Now Playing in a DOM where the sheet and bar share `#foray-player` and asserts the region is not inert.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the 2026-09-23 review item that created `.fp-announce` (the \"NOT THE LIVE REGION\" comment at client.js:673-679); second-order interaction with qa 71's openSheet/inert fix.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main (9730b5b) and the evidence holds. In buildUI (client.js 682-684, 729-730), `announce` is the only role=status/aria-live element in player/client.js; a grep turns up no other. It gets appended to `bar`, and `root.append(progress, bar)` runs before `root.append(sheet)` (893). That makes the bar a sibling of the sheet inside #foray-player. When setExpanded opens the sheet (2501-2507) it calls window.ForaySheets.openSheet(ui.sheet, {keepReachable: [\".topbar\",\"#drawer\",\"#drawer-overlay\"]}). At app.js:4917-4934, inertOutside starts at the sheet and sets `inert` on every sibling, so `progress` and `bar` both go inert, and neither matches a keepReachable selector. The comment at client.js:2495 says outright that the mini bar under the sheet goes inert. paintStatus (1665) then writes sheetLine into ui.announce, which is now inside an inert subtree. Inert content is removed from the accessibility tree, so browsers and screen readers do not announce live-region changes there. The sheet's visible line, ui.sErr (`<p class=\"fp-err-line\">`, 869-870), has no role or aria-live. I found nothing in docs/DECISIONS.md about live regions or announcements, and none of the three most recent commits change this. So this is not deliberate and has not been fixed. The user impact is real: a screen-reader user with Now Playing open hears nothing on buffering or a failed play. I rated it medium rather than high because the text is still shown on screen and the collapsed bar still announces it, so this is an accessibility regression in one state. Playback itself is not broken.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## a11y-3 — The search field is the one control on which the app's own focus ring is switched off: `#sh-compose #sh-input:focus { outline: none }` out-ranks the global `:focus-visible` ring and nothing replaces it

**confirmed** · verifier severity **medium** (finder: medium) · a11y · `styles.css:1768` · L7-styles-touch-visual

```json
{
  "id": "a11y-3",
  "lens": "a11y",
  "title": "The search field is the one control on which the app's own focus ring is switched off: `#sh-compose #sh-input:focus { outline: none }` out-ranks the global `:focus-visible` ring and nothing replaces it",
  "file": "styles.css:1768 (the override); styles.css:397 (the one ring); styles.css:1678-1700 (no :focus-within rule on the pill)",
  "line": 1768,
  "severity": "medium",
  "user_visible": "A keyboard or switch user Tabs into the bottom search pill and sees no indication that focus is there — on every other control they get a 2px amber ring (visual pass 1's \"THE ONE FOCUS RING\"). The pill itself does not change either (no `:focus-within` rule on `#sh-compose`), so the only cue is the caret, which a switch user or a low-vision listener on a dark surface may never see.",
  "evidence": "`:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }` (397) is specificity (0,1,0). `#sh-compose #sh-input:focus { outline: none; }` (1768) is (2,1,1) and applies to focus-visible focus too. `grep -n 'focus-within' styles.css` → nothing; `grep -n 'sh-compose.*focus' styles.css` → only 1768. The comment above it says the field \"gives up its own box: the pill is the box now\" — but the pill never draws the ring the field gave up.",
  "why_subtle": "On a phone nobody Tabs, so the missing ring is never seen; the override was written for the tap case (no ring on tap is correct) and quietly took the keyboard case with it.",
  "fix_sketch": "Replace 1768 with `#sh-compose:focus-within { outline: 2px solid var(--amber); outline-offset: 2px; }` (or a `box-shadow` ring on the pill, since it is `border-radius: pill`), and keep `outline: none` on the input only under `:focus:not(:focus-visible)`. Extend test/ui-tokens or a small stylesheet test to fail on any `outline: none` that is not qualified by `:not(:focus-visible)`.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of visual pass 1's focus-ring work (styles.css:390-397); not in status.tsv.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked origin/main styles.css and the finding holds. Line 397 is `:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }`, the \"THE ONE FOCUS RING\" block from visual pass 1. Line 1768 is `#sh-compose #sh-input:focus { outline: none; }`, which is unqualified: it has no `:not(:focus-visible)`, unlike the dialog and heading rules at lines 384 and 388-389. Its specificity is (2,1,0) against (0,1,0), so it removes the ring even when focus arrives by keyboard. Nothing in the file puts the ring back. No rule uses `:focus-within`, and the pill rule `#sh-compose #sh-form` (border, background and shadow) has no focus state. The comment \"The field gives up its own box: the pill is the box now\" is about the border and background; it does not cover the ring. docs/DECISIONS.md does not rule on this. Its only mention (around line 133) says the page \"authors its own focus ring\", which supports the finding rather than excusing it. One small indirect cue exists: app.js:2817 adds `body.sh-searching` while the field has focus, and under ui-v2 that hides the tab bar. That is a side effect, not a focus indicator, and it does nothing without ui-v2. So on the search pill a keyboard or switch user sees only the caret. This fails WCAG 2.4.7 on the app's primary input, and I keep severity at medium.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## a11y-5 — First-run explainer: pressing "Get started" wipes the dialog body, so the focused button is destroyed and focus falls to <body> inside an open modal; the new step's title is never spoken

**confirmed** · verifier severity **medium** (finder: medium) · a11y · `app.js:5381` · L2-sheets-drawer-gestures

```json
{
  "id": "a11y-5",
  "lens": "a11y",
  "title": "First-run explainer: pressing \"Get started\" wipes the dialog body, so the focused button is destroyed and focus falls to <body> inside an open modal; the new step's title is never spoken",
  "file": "app.js:5381 (renderPreferences `body.innerHTML = \"\"`), 5330 (renderWelcome), 5286-5294 (openSheet focuses the panel once)",
  "line": 5381,
  "severity": "medium",
  "user_visible": "A new VoiceOver user on the very first screen reads \"4a picks podcast episodes for you… Get started\", activates it, and hears nothing: the cursor was on a node that no longer exists, the dialog's `aria-labelledby` now points at \"What are you into?\" but a name change is not announced, and the next swipe lands somewhere WebKit chooses. A keyboard user's next Tab is rescued by the trap (onSheetKeydown: `!inside` → first item) but the step change itself is silent.",
  "evidence": "`go.addEventListener(\"click\", renderPreferences);` (5372) → `function renderPreferences() { body.innerHTML = \"\"; …` (5381) which removes `go`; then `title.id = \"first-time-sheet-title\"; panel.setAttribute(\"aria-labelledby\", …)` (5385-5387) and no `focus()` anywhere in the function (grep of 5300-5420 for `focus` → nothing). openSheet's `focusQuietly(panel)` runs once at open (5142-5143), not per step. Compare the voice sheet (qa 64), which was fixed for exactly this class: \"every action … destroys the element that was just activated\".",
  "why_subtle": "The sheet stays open and inert-locked so it feels fine by touch; only a screen-reader or keyboard user experiences the dropped focus, and only once per install.",
  "fix_sketch": "At the end of each step render, `focusQuietly(title)` (give the h3 `tabindex=\"-1\"`) or refocus the panel so the dialog re-announces with its new name; alternatively `announce()` the new step title. Same in any other multi-step body swap (renderWelcome on a Back path).",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the qa 64 pattern (focus destroyed by re-render) — the first-time sheet was not covered.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked app.js at origin/main (9730b5b, 2026-09-23). The code matches the finding, give or take a line. renderWelcome (line 5329) wires `go.addEventListener(\"click\", renderPreferences)` at 5371. renderPreferences (5380) begins with `body.innerHTML = \"\"`, which removes the focused \"Get started\" button. It then rebuilds the title, sets `panel.setAttribute(\"aria-labelledby\", \"first-time-sheet-title\")` and appends new content, but never calls focus(), focusQuietly() or announce() before its go/skip handlers. openSheet calls focusQuietly(panel) once, when the sheet opens (around line 5139), and not again when the step changes. Nothing else rescues focus: the only document-level focusout listener (line 13828) handles the keyboard viewport inset. The focus trap only redirects the next Tab.\n\ndocs/DECISIONS.md has nothing on focus handling for the first-run sheet. It mentions the sheet only as the U-09/PR #503 onboarding feature, so this is not a deliberate ruling, and it has not been fixed.\n\nImpact: after \"Get started\", focus falls to <body> inside an open aria-modal dialog. VoiceOver says nothing about the step change, because changing aria-labelledby is not announced. This is real, but it happens once per install and only affects screen-reader users (keyboard users are partly rescued by the trap). Medium severity is right. The fix is cheap: focusQuietly on the new h3 (with tabindex=-1) or on the panel at the end of renderPreferences.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## a11y-6 — Stop in the Now Playing sheet hands focus to the mini bar's title button and then hides the whole player, so focus dies on a hidden element and the stop is never announced

**confirmed** · verifier severity **medium** (finder: medium) · a11y · `player/client.js:2097` · L2-sheets-drawer-gestures

```json
{
  "id": "a11y-6",
  "lens": "a11y",
  "title": "Stop in the Now Playing sheet hands focus to the mini bar's title button and then hides the whole player, so focus dies on a hidden element and the stop is never announced",
  "file": "player/client.js:2087-2100 (stopAndClose); app.js:5162-5168 (closeSheet's focus return); player/client.js:2506 (`returnFocus: ui.info`)",
  "line": 2097,
  "severity": "medium",
  "user_visible": "A screen-reader user activates Stop. closeSheet moves focus to the mini bar's \"Now playing: …\" button; the very next line hides `#foray-player`, so `document.activeElement` collapses to <body>. VoiceOver reports nothing — no \"Stopped\", no landing spot — and the next swipe starts from the top of whatever page was behind. Apple Podcasts keeps the transport on screen; here the one destructive control in the app leaves the listener nowhere.",
  "evidence": "`const owner = sheetOwner(); if (owner) owner.closeSheet(ui.sheet); ui.root.hidden = true; ui.sheet.hidden = true; document.body.classList.remove(\"fp-open\", \"fp-expanded\");` (2094-2100). closeSheet picks `[entry.opener, entry.returnFocus].find(el => … !inHiddenSubtree(el))` and `focusQuietly(back)` (5162-5168) — `ui.info` is not hidden YET at that instant, so it is chosen, then hidden. No `announce`/live write in stopAndClose.",
  "why_subtle": "Both halves are individually correct — the owner returns focus, the player hides — and the defect exists only in their ordering, which no test observes.",
  "fix_sketch": "In stopAndClose, hide the root BEFORE calling closeSheet (so the owner's `inHiddenSubtree` check skips `ui.info` and falls through), and pass a `returnFocus` that survives — e.g. the page heading via app.js's `landOnPage({navigated:false})`, or `#menu-btn` — and write \"Stopped\" to a live region that is not inside the hidden root (see finding 2). Pin it in now-playing-sheet.test.js: after Stop, `document.activeElement` is connected, visible and not <body>.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction between qa 70/71 (focus return on close) and U-13's Stop; new.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main (9730b5b) myself and the finding holds. In player/client.js, stopAndClose (lines 2087-2100) calls owner.closeSheet(ui.sheet) first and only then sets ui.root.hidden = true. At the moment closeSheet runs in app.js (5147-5168), ui.root is not hidden yet. The focus candidates are entry.opener, which is document.activeElement when the sheet opened (the ui.info button, or <body> if it was opened from the artwork, and <body> is excluded), and returnFocus: ui.info (line 2506). Both are still visible then, so closeSheet focuses ui.info. That button sits inside `bar`, which is inside `root` (root.append(progress, bar) at 731, root.append(sheet) at 892). The next line hides root, so the focused element ends up in a hidden subtree and focus is lost. The only live region, `announce` (682-684, role=status), is also inside bar/root, so it is hidden too. stopAndClose writes nothing to it or to any other live region, so the stop is never announced. The app.js onChange → paintForay path shows no focus handling. No test in now-playing-sheet.test.js checks focus after Stop. The DECISIONS.md ruling on Stop (around lines 136-142) covers where Stop sits and its danger colour, not where focus goes, so this is not deliberate. Severity: medium. It is an accessibility regression on a single path (Stop), and playback stops correctly. The listener just loses their place and gets no confirmation.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## a11y-7 — Seek slider is rewritten four times a second while focused, so a screen reader parked on it hears a running clock instead of a position

**confirmed** · verifier severity **low** (finder: low) · a11y · `player/client.js:1488` · L1-player-transport

```json
{
  "id": "a11y-7",
  "lens": "a11y",
  "title": "Seek slider is rewritten four times a second while focused, so a screen reader parked on it hears a running clock instead of a position",
  "file": "player/client.js:1479-1490 (`ui.scrub.value =` and `aria-valuetext` per tick); app.js:1057-1062 (the app's own rule: write only on change)",
  "line": 1488,
  "severity": "low",
  "user_visible": "A VoiceOver user lands on \"Seek\" to scrub and the slider keeps announcing \"12:03 of 44:10… 12:04 of 44:10…\" every second (WebKit posts a value-changed notification on the focused slider whenever `value`/valuetext change), talking over their own swipe adjustments; on a 60-minute episode one swipe moves 3.6 s (step 1 of 1000), so getting anywhere takes dozens of swipes through the chatter.",
  "evidence": "render(): `if (!scrubbing) { … ui.scrub.value = String(Math.round(frac * 1000)); …}` and unconditionally `ui.scrub.setAttribute(\"aria-valuetext\", dur ? `${ui.tNow.textContent} of …` : …)` (1479-1490), called from the 4 Hz tick (`render()` on every timeupdate). The mini-bar status line already follows the rule \"Written only when it changes, so a repaint does not re-announce it\" (1664) and app.js codifies it at 1057-1062; the slider does not. `scrub.min=\"0\"; scrub.max=\"1000\"` with default step 1 (797-800).",
  "why_subtle": "The valuetext fix made the slider read correctly the FIRST time; the cadence problem only appears if you leave the VoiceOver cursor on the slider while audio plays.",
  "fix_sketch": "Skip the `value`/`aria-valuetext` writes while `document.activeElement === ui.scrub` (or only write when the whole-second clock string changes AND the slider is not focused); set `step` so one AT increment is a useful nudge (e.g. compute step from duration so a swipe is ~10–15 s, or use `aria-valuenow` in seconds with `step=15`). Apple's scrubber announces only on user adjustment.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 72 (aria-valuetext added, cadence not considered).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n- **The writes happen on every tick.** In player/client.js, render() (line 1438) writes `ui.scrub.value` at lines 1479-1482 whenever `!scrubbing`. At lines 1488-1490 it writes `aria-valuetext` on every call, with no check that the text changed. render() is registered on timeupdate at line 2821, which fires about 4 times a second. It is also called from onNarrationTick at line 2710.\n- **Nothing skips the write while the slider has focus.** There is no `document.activeElement` check anywhere. `scrubbing` is only set to true on the `input` event (line 2615), so a screen-reader user who has simply landed on the slider still gets the updates.\n- **The slider's range is 0-1000 with the default step.** Lines 797-800 set min 0 and max 1000, and there is no `scrub.step` anywhere in the file. One increment is 1/1000 of the duration, which is 3.6 s on a 60-minute episode.\n- **The code breaks its own rule.** The status line at line 1664 (\"Written only when it changes\") and `setStatusText` in app.js (lines 1057-1062) both write only on change. The slider does not use either pattern.\n- **No ruling covers it.** docs/DECISIONS.md has nothing about the scrub bar, valuetext or seek slider, so this is not deliberate.\n\nThe chatter is smaller than the finding says. The browser probably ignores writes of an unchanged value, so the announced text actually changes about once a second (the clock), not 4 times. Whether VoiceOver reads out value changes it did not cause on a focused slider depends on the platform, so I could not verify the \"running clock\" symptom exactly without a device. Still, the per-second valuetext change while the slider has focus, plus the very small step, make the complaint credible. I rate it low: it is an accessibility annoyance and nothing breaks.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## a11y-8 — Drawer settings are plain buttons whose only state cue is the word after the colon — no switch role, so "Continuous playback: on" is announced as a button and the flip is never confirmed

**confirmed** · verifier severity **low** (finder: low) · a11y · `app.js:11277` · L6-navigation-firstrun-copy

```json
{
  "id": "a11y-8",
  "lens": "a11y",
  "title": "Drawer settings are plain buttons whose only state cue is the word after the colon — no switch role, so \"Continuous playback: on\" is announced as a button and the flip is never confirmed",
  "file": "app.js:11277 (paintDrawerToggles), 11256-11262 (drawerToggle click), index.html:57-58",
  "line": 11277,
  "severity": "low",
  "user_visible": "A screen-reader user hears \"Family mode: off, button\", activates it, and hears nothing — the button's own text changed under the cursor, which VoiceOver does not re-read. They must swipe away and back to learn whether it took. Apple's Settings toggles read \"Switch, off/on\" and announce the flip.",
  "evidence": "`setControlLabel(btn, `${t.label}: ${t.words[t.read() ? 1 : 0]}`, null)` (11277) writes textContent only; `grep -n 'role=\"switch\"\\|aria-checked' app.js` finds `aria-checked` only in the voice radios (12203) and no `role=\"switch\"` anywhere. The buttons are `<button class=\"drawer-item as-btn\" id=\"family-toggle\">` (index.html:57-58) and `ddEl(\"button\", \"drawer-item as-btn\")` (11249).",
  "why_subtle": "The text does say the state, so a static inspection passes; the failure is only in the dynamics (no re-announce on change).",
  "fix_sketch": "In drawerToggle: `btn.setAttribute(\"role\", \"switch\")` once, and in paintDrawerToggles `btn.setAttribute(\"aria-checked\", String(t.read()))` with the visible text kept as the label (`Family mode` + a visual on/off pill); on click, `announce(`${label} ${on ? 'on' : 'off'}`)`. test/toggle-labels.test.js can pin the role and the checked sync.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; qa 67/68 fixed star/play names, the drawer switches were not looked at.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main. drawerToggle (app.js ~11246-11266) builds or reuses a plain `<button class=\"drawer-item as-btn\">`. It sets no role and no aria-checked or aria-pressed. The click handler only calls write(!read()), renderDrawer() and an optional repaint, and never calls announce(). paintDrawerToggles (~11272-11277) calls setControlLabel(btn, `${label}: ${word}`, null). setControlLabel (app.js:1050) only writes textContent and removes aria-label.\n\nA grep of app.js finds no role=\"switch\" and no aria-checked on these buttons. aria-pressed is used on chips and thumbs, but not in the drawer. In index.html the buttons are at lines 70-71, not 57-58 as cited, but they are the same bare `<button class=\"drawer-item as-btn\" id=\"family-toggle\">` and `id=\"autoadvance-toggle\"`.\n\ndocs/DECISIONS.md rules only that switches keep the drawer open (data-drawer-stay, Joey 2026-08-31). Nothing there chooses plain buttons over switch semantics, so this is not deliberate. It has not been fixed either.\n\nThe state is still spoken as part of the label (\"Family mode: off\"), so it is not missing, only weakly exposed. Whether VoiceOver re-reads a focused button when its text changes varies by platform, so the claim that the user hears nothing after the flip is plausible but not certain. The core defect holds: there is no switch role or checked state, and no confirmation is announced. Low severity.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## a11y-9 — Reduced motion covers three strip rules only; the Now Playing sheet's spring-back, the description chevron, the mini-card press and the page-head collapse still animate under prefers-reduced-motion

**confirmed** · verifier severity **low** (finder: low) · a11y · `styles.css:1964` · L7-styles-touch-visual

```json
{
  "id": "a11y-9",
  "lens": "a11y",
  "title": "Reduced motion covers three strip rules only; the Now Playing sheet's spring-back, the description chevron, the mini-card press and the page-head collapse still animate under prefers-reduced-motion",
  "file": "styles.css:1964 (`.fp-sheet:not(.fp-sheet-dragging) { transition: transform .22s ease; }`), 599, 722, 1151, 2089, 1825; reduced-motion blocks at 2467, 2487, 2663",
  "line": 1964,
  "severity": "low",
  "user_visible": "A listener with Reduce Motion on still sees the full-screen Now Playing sheet slide back up over 220 ms after a partial drag, the progress fill tween, and transform transitions on cards/headers; the strip and magnifier honour the setting, so the app is inconsistent with itself and with iOS, where Reduce Motion replaces sheet slides with cross-fades.",
  "evidence": "`grep -n 'transition:' styles.css` → 599 (summary chevron), 722 (.mini-card transform), 1151 (.page-head transform), 1825 (.fp-fill width .25s), 1964 (.fp-sheet transform .22s), 2089 (.ep-description-toggle::after), 2453/2596 (strip). `grep -n 'prefers-reduced-motion' styles.css` → 2467 (.fy-strip), 2487 (bubble), 2663 (.fy-seg) only. No `@keyframes`, so nothing else moves — this is the complete list.",
  "why_subtle": "Three reduced-motion blocks exist, so a grep for the media query looks like the setting is handled; the coverage is per-rule and the largest moving surface (a full-screen sheet) is the one left out.",
  "fix_sketch": "One block at the end of styles.css: `@media (prefers-reduced-motion: reduce) { .fp-sheet, .mini-card, .page-head, .ep-description-toggle::after, .drawer-dev > summary::after, .fp-fill { transition: none; } }` — and in sheet-drag-dismiss, snap `--fp-sheet-dy` to 0 without the class dance when the media query matches. Pin with a test that every `transition:` selector in a live rule also appears in a reduced-motion block.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read styles.css at origin/main. The `transition:` lines the finding cites are all there: 599 (.drawer-dev summary::after, transform 120ms), 722 (transform .12s), 1151 (transform .18s), 1825 (.fp-fill width .25s linear), 1964 (`.fp-sheet:not(.fp-sheet-dragging) { transition: transform .22s ease; }`), 2089 (transform 120ms). There are also strip transitions at 2453 and 2596. `prefers-reduced-motion` appears only at 2467 (.fy-strip), 2487 (the strip bubble) and 2663 (.fy-seg). There is no @keyframes or animation rule anywhere in the file. Outside CSS, the live code never checks for reduced motion: git grep only finds it in archive/, docs/ux mockups, the ui-transition-plan acceptance line and one segment-strip test comment. So the sheet's 220 ms spring-back after a partial drag, and the other transform transitions, do run under Reduce Motion. docs/DECISIONS.md has no ruling that exempts these. Its only motion mention (line 447) is a note that one pass added no motion beyond the existing tap-scale. I kept severity low because every transition is short (120–250 ms). The .fp-fill width tween is a progress indicator and could reasonably be left alone. The only one a vestibular-sensitive user is likely to notice is the full-screen sheet slide. In the codebase this is a real inconsistency: the strip and bubble respect the setting and the sheet does not.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## a11y-10 — Navigating to Home announces nothing and moves nothing: it has no page heading, so landOnPage's two mechanisms both no-op

**confirmed** · verifier severity **low** (finder: low) · a11y · `app.js:12895` · L6-navigation-firstrun-copy

```json
{
  "id": "a11y-10",
  "lens": "a11y",
  "title": "Navigating to Home announces nothing and moves nothing: it has no page heading, so landOnPage's two mechanisms both no-op",
  "file": "app.js:12880-12896 (landOnPage), 12876-12878 (pageHeading), 7587-7590 (Home's greeting is not a `.page-head h2`)",
  "line": 12895,
  "severity": "low",
  "user_visible": "A screen-reader user on Search taps the Home tab. The tab keeps focus (it survived), the page name is `\"\"` because Home has no `.page-head h2`, so `if (navigated && name) announce(name)` announces nothing and `document.title` becomes plain \"4a\". They hear only the tab's own `aria-current` if their AT re-reads it, and otherwise nothing — every other tab says its name. Home is the one page that never introduces itself.",
  "evidence": "`const head = pageHeading(view); const name = head ? … : \"\"; … if (navigated && name) announce(name);` (12882-12895). pageHeading looks for `.page-head h2` (12876-12878); Home renders `.hv2-greeting` (7587) and sections headed `h2.hv2-title` (7636), none inside `.page-head`. The design comment above (12861-12862) acknowledges \"Home, whose sections have no page heading\" and only handles the title, not the announcement.",
  "why_subtle": "The heading rule is right for every page but one, and the one is the most-visited page, which nobody navigates TO with a screen reader while testing.",
  "fix_sketch": "When `isHomeRoute()` and focus survived, `announce(\"Home\")` (the tab's own label), and when focus was lost, land on `.hv2-greeting` with `tabindex=-1` rather than bare `#view`. One line each in landOnPage.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 80 (route change announces/moves focus) — Home was the exception left out.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. pageHeading() (app.js:12873-12877) returns only a `.page-head h2`. landOnPage() (12880-12896) sets the page name to \"\" when there is no heading and only announces when a name exists (`if (navigated && name) announce(name)`). Home is renderHomeV2() (7887). Its markup is `.hv2-home` holding `.hv2-greeting` (7585-7590) and sections headed `h2.hv2-title` (7636, 7814, 7853, 7882). None of it sits inside a `.page-head`, so pageHeading returns null on Home. The result: when focus survives, for example on a Home tap from the tab bar, nothing is announced and document.title becomes \"4a\". When focus was lost, for example from a drawer link, focus falls back to bare #view with tabindex=-1, not to a named landmark. The design comment at 12861-12862 mentions Home only in the title rule (\"Home ... is plain '4a'\"). It says nothing about the announcement, so that gap looks like an oversight, not a choice. docs/DECISIONS.md has no ruling on landOnPage, page announcements or qa row 80, so this is not 'deliberate'. It is not fixed at origin/main HEAD (9730b5b, #746). Severity stays low. The user impact is a missing screen-reader announcement on a single page, and the tab's own label or aria-current still gives some context.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## a11y-11 — The Explicit badge relies on `aria-label` on a bare <span> and `title` tooltips carry the only explanation of "Stretch" and "Not available to play" — none of which is exposed on touch or to most screen readers

**confirmed** · verifier severity **low** (finder: low) · a11y · `app.js:938` · L6-navigation-firstrun-copy

```json
{
  "id": "a11y-11",
  "lens": "a11y",
  "title": "The Explicit badge relies on `aria-label` on a bare <span> and `title` tooltips carry the only explanation of \"Stretch\" and \"Not available to play\" — none of which is exposed on touch or to most screen readers",
  "file": "app.js:938 (explicit badge), 4653 (Stretch), 8056 (not-playable)",
  "line": 938,
  "severity": "low",
  "user_visible": "VoiceOver reads the explicit badge as \"E\" (aria-label on a generic span is ignored without a role), so a Family-mode parent hears nothing that means \"explicit\". \"Stretch\" and \"Not available to play\" have `title=` tooltips a phone can never show and a screen reader does not read as the name.",
  "evidence": "`<span class=\"explicit-badge\" title=\"Explicit content\" aria-label=\"Explicit\">E</span>` (938); `<span class=\"mc-stretch\" title=\"Outside your usual subjects, on purpose\">Stretch</span>` (4653); `<span class=\"not-playable\" title=\"4a could not get a playable audio file for this episode\">Not available to play</span>` (8056).",
  "why_subtle": "`aria-label` on a span LOOKS labelled in the markup and passes naive lint; the role requirement is the part people forget.",
  "fix_sketch": "Badge: `<span class=\"explicit-badge\" role=\"img\" aria-label=\"Explicit\">E</span>` (or visually-hidden text \"Explicit\" beside the E). Drop the `title`s and put the explanation where a thumb can reach it (the Foray card's own \"why\" line already says the stretch reason; the not-playable row can carry the sentence in `.s`).",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and all three quoted lines match exactly. app.js:938 `explicitBadge()` returns `<span class=\"explicit-badge\" title=\"Explicit content\" aria-label=\"Explicit\">E</span>`, a span with no role. It is used in the show header (3689), episode rows (8036, 8082) and the episode page title (8481). Under ARIA, aria-label is not allowed on the generic role, and Chrome/Android and most screen readers ignore it there, so they read only \"E\". VoiceOver sometimes honours it, but that is not reliable. app.js:4653 in miniCard puts the explanation \"Outside your usual subjects, on purpose\" only in a title attribute. Touch devices cannot show it, and screen readers do not use it as the name. The mini-card has no other visible stretch reason: the hook line is startsWithLine plus subjectBlurb. app.js:8056 notPlayableNote() also carries its explanation only in a title. The only DECISIONS.md ruling on Stretch is the one requiring a visible \"Stretch\" badge, and it says nothing about the tooltip or accessible names. Nothing rules this deliberate, and nothing in the code shows it fixed. Severity stays low. The visible text is still there in every case (\"E\", \"Stretch\", \"Not available to play\"), and \"Not available to play\" explains itself. What gets lost is extra context plus a less clear name for the explicit badge. The Family-mode claim is also a little overstated: Family Mode filters explicit items out entirely, so the badge only shows when Family Mode is off.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## races-1 — A play-then-seek that is superseded mid-load still fires its seek, onto whatever loaded next — a resume followed by Next clip seeks the new clip to the old clip's episode offset and disarms the boundary

**confirmed** · verifier severity **medium** (finder: high) · races · `player/client.js:3606` · L1-player-transport

```json
{
  "id": "races-1",
  "lens": "races",
  "title": "A play-then-seek that is superseded mid-load still fires its seek, onto whatever loaded next — a resume followed by Next clip seeks the new clip to the old clip's episode offset and disarms the boundary",
  "file": "player/client.js",
  "line": 3606,
  "severity": "high",
  "user_visible": "On the Foray page with a \"Jump back in at 23:14\" banner, tap ▶ Resume; on a cell connection the load takes a second or two, so the listener taps \"Next clip ›\" (or a running-order row, the strip, or the lock screen's next). The next clip starts, then jumps to an unrelated point of ITS source episode (the first clip's absolute offset, e.g. 41:40 into a 45-minute episode) with no out-point, and free-plays the rest of a stranger's episode; the strip clock reads nonsense. Same shape on the restored mini bar: press play on yesterday's episode (load in flight), then tap a different row's ▶ on Home — the new episode starts at the old one's stored position (past its end for a short episode, which then 'ends' and auto-advances).",
  "evidence": "client.js:3606-3607 (playForay): `await manager.play(foray.index);\\n      if (offsetAt != null) await manager.seek(offsetAt, { precise: true });` — no check that this Foray/segment is still the one the player is on. client.js:1986-1998 (setRunning restored branch): `const started = await ForayPlayer.play(item); ... if (started && (moved || positionSec > 0)) { await manager.seek(positionSec, { precise: true });` where `started` is `manager.state?.type !== \"idle\"` (client.js:2939) — true when a NEWER load owns the player. client.js:3852-3855 (foraySeek) has the same two-step. Why the first promise resolves early: html-audio-backend.js:1562-1565 rejects a superseded load (`fail(\\`load of ${item.id} superseded\\`)`), queue-manager.js:1336-1338 swallows it (`if (this._loadSeq !== seq) return this._emit(...)`), so `manager.play()` resolves and the caller's trailing `seek` runs. queue-state.js:580-585: a seek during `loadingItem` is parked as `pendingSeek` and applied at `itemLoaded` (\"last wins\"), then `setOutPoint` (html-audio-backend.js:809) computes `_outArmed = this.currentTime < seconds` — false when the stray offset is past the new segment's end_sec, so the boundary is disarmed, the exact outcome queue-manager.js:620-624 calls 'worse than not playing'.",
  "why_subtle": "Every individual piece is guarded (backend `_loadSeq`, manager `_loadSeq`, reducer last-wins seek) and the round-1 fix for qa 'superseded load claims the element' made the superseded load resolve CLEANLY — which is precisely what lets the caller's second step run against the wrong item. It needs a second transport action inside a load window, so it never shows on wifi or in the node:vm suites, and when it does the symptom (wrong audio, a clip that will not end) looks like bad data rather than a race.",
  "fix_sketch": "Give the two-step resume a sequence token: in playForay/foraySeek capture `const mine = ++forayStartSeq` before `manager.play` and skip the seek unless `mine === forayStartSeq && manager.currentIndex === foray.index && manager.playheadItemId === item.id`; likewise in setRunning's restored branch compare `current?.id === item.id` and `manager.playheadItemId` before seeking. Better: pass the offset INTO the load (`manager.play(index, { startOffset })` → `_forceNextOffset`), so there is no second step to race — the manager already carries `startOffset` on the load.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction with the round-1 fix for qa 'HtmlAudioBackend.load() installs media listeners with no _loadSeq guard' / '_loadItem stamps _loadedId before its supersession check': those made the superseded load settle quietly, and nothing above them re-checks ownership.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main (9730b5b) and the evidence holds. playForay (client.js:3606-3607) runs `await manager.play(foray.index); if (offsetAt != null) await manager.seek(offsetAt, {precise:true})` without checking that this Foray still owns the player. `foray.resumeSeekPending` is only read at client.js:1275, and that check only blocks position writes, so it does not stop Next or a row tap. The restored-bar branch (1986-1998) seeks when `started` is true. `started` is `manager.state?.type !== \"idle\"` (2939), which is also true when a newer load has taken the player. foraySeek (3852-3855) has the same two-step.\n\nWhy the stale seek fires:\n- `manager.play` awaits `_handle`, which awaits the loadItem effect, which awaits `_loadItem`.\n- When a newer load starts, `_loadSeq` goes up. On the next media event (the new source's loadedmetadata), the old listener's `superseded()` rejects the old load (html-audio-backend.js ~1562).\n- `_loadItem`'s catch sees `_loadSeq !== seq` and returns quietly with a `load.superseded` emit (queue-manager.js ~1336). So the old `play()` resolves normally and the caller's trailing seek runs.\n- A load that resolved and was then caught at the post-await check (queue-manager.js 1308) also returns quietly.\n\nWhat happens next depends on timing. The microtask chain drains before the new load's canplay, so the reducer is normally in `loadingItem(new target)`. handleSeek parks the seek as `pendingSeek` (last wins, queue-state.js 580-585). handleItemLoaded then applies `seekTo(oldOffset)` before `setOutPoint(endSec)` (queue-state.js 359-364), and `setOutPoint` sets `_outArmed = currentTime < seconds`, which is false when the stray offset is past the new segment's end. The boundary is disarmed and the rest of the source episode plays freely. If the new load had already reached `playing`, the seek goes straight through instead, which is still the wrong clip.\n\nNothing in docs/DECISIONS.md rules on this, and I found no later fix.\n\nI set severity to medium, not high. The result is bad (unbounded playback of the wrong episode, the outcome the codebase calls worse than not playing), but it only happens when the listener presses a transport control inside the one-to-two-second load window.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## races-2 — The Search page's ✕ / Escape clears the field but not the in-flight search: the cleared query's results, episodes, CTA and even its address come back a moment later

**confirmed** · verifier severity **medium** (finder: medium) · races · `app.js:2827` · L4-search-create-playlists

```json
{
  "id": "races-2",
  "lens": "races",
  "title": "The Search page's ✕ / Escape clears the field but not the in-flight search: the cleared query's results, episodes, CTA and even its address come back a moment later",
  "file": "app.js",
  "line": 2827,
  "severity": "medium",
  "user_visible": "Type \"huberman\", then within about a second tap the ✕ (or press Escape). The field empties and the browse pills return — then the shows list, the Episodes section and the playlist CTA for \"huberman\" pop in above the browse furniture under an empty field; if the ✕ landed inside the 250 ms debounce the address also flips back to #/shows/q/huberman, so ‹ and reload bring the search back. Deleting the text with the keyboard does not do this.",
  "evidence": "app.js:2827-2837 `function dismissShowSearch(input) { input.value = \"\"; clearShowSearchResults(); noteShowQueryInRoute(\"\"); showSearchFieldFocused = false; ... }` — no `supersedeShowSearch()` (5691-5695), no token bump, no `clearTimeout(showSearchDebounceTimer)`. Contrast app.js:6851-6856 (a keystroke): `const myToken = ++showSearchToken; if (showSearchDebounceTimer) clearTimeout(...); if (!query) { clearShowSearchResults(); ...}`. The pending tick at 6858-6863 then runs `if (myToken !== showSearchToken) return; noteShowQueryInRoute(query); runShowSearchCostly(query, myToken, local)`, and every merge falls back to `local.localShows` (6566 `paintedShowRows(query, myToken, local.localShows)`) after `clearShowSearchResults` reset `showSearchPainted`, so `paintShowResults` repaints with `results.hidden = false` (6306-6307).",
  "why_subtle": "Round 1 added supersession for a page re-mount (qa 'Leaving and re-entering #/shows does not supersede in-flight passes'), and the keystroke path has always bumped the token, so the one entry point added later (the ✕, mirroring Apple's) is the only one that forgets. It is only visible inside the ~0.25–1 s window after typing, which is exactly when an impatient thumb hits ✕.",
  "fix_sketch": "Call `supersedeShowSearch()` at the top of `dismissShowSearch` (it already does all three things: bump the token, forget the painted record, cancel the debounce). Add a test: type, dismiss inside the debounce, flush timers/fetches, assert `#sh-results` stays hidden and the hash stays `#/shows`.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the round-1 'races' finding at app.js:2240 (supersedeShowSearch covers a re-mount, not the dismiss control).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main at 9730b5b and the code is as the finding says. dismissShowSearch (app.js:2827-2837) empties the field, calls clearShowSearchResults, rewrites the route to #/shows, blurs the field and updates the browse visibility. It does not bump showSearchToken, it does not clear showSearchDebounceTimer, and it does not call supersedeShowSearch (5691-5695). Setting input.value from code does not fire an input event, so onShowSearchInput('') never runs to bump the token either.\n\nIf the dismiss lands inside the 250 ms debounce, the pending tick at 6858-6863 still passes its myToken === showSearchToken check. It then calls noteShowQueryInRoute(query), which puts #/shows/q/<query> back in the address, and runs runShowSearchCostly.\n\nclearShowSearchResults set showSearchPainted.token to -1, so paintedShowRows falls back to local.localShows. The next paintShowResults call (token still current) sets results.hidden = false with rows under an empty, blurred field. updateShowBrowseVisibility has already shown the browse sections again, so both appear together. The episode and playlist passes are gated on the same token, so they paint as well.\n\nA dismiss after the debounce, while the fetches are still in flight, repaints the results the same way (without the address change).\n\nDeleting the text with the keyboard goes through onShowSearchInput, which bumps the token, so it is not affected, as the finding says. The existing token and supersede code covers only a page re-mount. docs/DECISIONS.md has no ruling on dismiss or escape. The fix sketch (call supersedeShowSearch at the top of dismissShowSearch) is correct.\n\nSeverity stays medium. The UI state is visibly wrong, and when the address is restored a reload or ‹ brings the search back. Nothing is lost or corrupted, and the user needs a quick type-then-dismiss to trigger it.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## races-4 — When hydration overruns the 5 s bound, init()'s own writes (profile id, anonymous session, seen-set, and the interests profile on the first play) permanently shadow the durable copies — only the playback rate was fixed

**confirmed** · verifier severity **medium** (finder: medium) · races · `app.js:187` · L5-boot-states-storage

```json
{
  "id": "races-4",
  "lens": "races",
  "title": "When hydration overruns the 5 s bound, init()'s own writes (profile id, anonymous session, seen-set, and the interests profile on the first play) permanently shadow the durable copies — only the playback rate was fixed",
  "file": "app.js",
  "line": 187,
  "severity": "medium",
  "user_visible": "In the case the durable store exists for (localStorage swept, IndexedDB intact) with a slow IndexedDB read (>5 s, the WKWebView-after-background hazard idb-tier.js documents): Home ranks with taxonomy defaults for the whole session, the first play or thumbs-up writes those defaults over the listener's learned interests for good, the listener gets a new analytics profile id and a new anonymous account, and the 'seen' window resets so recently shown episodes are dealt again. Nothing on screen says any of it happened.",
  "evidence": "app.js:187-197 `await Promise.race([store.hydrate(), new Promise(resolve => setTimeout(resolve, STORAGE_WAIT_MS))])` then app.js:13922-13923 `loadInterests(); buildCards();` and 13958-13959 `logEvent(\"session_shown\", ...); trySyncEvents();`. app.js:425-430 seeds `state.interests[n.id] = saved[n.id] ?? Math.max(0, n.weight)` from the un-hydrated read and is never re-run; app.js:445-449 `saveInterests` writes `{ ...base, ...state.interests }` — every id is present in state.interests so the defaults override the (by then hydrated) stored profile. app.js:1337-1338 writes `cp_recent_branches`/`cp_seen`; app.js:199-206 mints `cp_profile_id`; app.js:312-316 signs up a new anon user when `cp_sb_session` reads empty. durable-store.js:59-61 'Every key written since construction is `_dirty` and hydration will not touch it' and :766 `if (this._dirty.has(k)) continue; // property 2: this session wins`. client.js:1683-1719 fixes exactly this shape for `cp_rate` only ('app.js gives up on hydration after 5 s and renders anyway ... So repaint once when it lands').",
  "why_subtle": "The 5 s bound is documented as 'the last resort, not the answer', and the module-side rate fix (qa 168) proves the team knows the pattern — but app.js reads five other keys on the same path and has no `storageHydrated.then` re-read for any of them. The loss is invisible: the profile 'works', it is just a fresh one.",
  "fix_sketch": "After the bound, subscribe once: `window.forayStorageReady?.then(() => { if (!hydratedInTime) { loadInterests(); /* re-seed only ids not nudged this session */ } })`. Make `saveInterests` write only ids this session actually nudged (track a `touched` Set) so defaults never overwrite stored weights. Defer `profileId()`/`trySyncEvents()` until `forayStorageReady` settles (they are not on the critical path). Record `storage=not-hydrated` in the boot row (client.js already does) and log a `cp_interests`-shadowed diagnostic.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 168 (the same hydration race was closed for cp_rate only); related to persist finding at app.js:416 (taxonomy-missing wipe), different cause.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the evidence holds. Line numbers are off by a few, but the code matches.\n\n- **The 5 s bound.** app.js:187-197 `storageReady()` races `store.hydrate()` against a 5 s timeout (`STORAGE_WAIT_MS`). init() (around line 13868) awaits it and then runs `loadInterests(); buildCards();` (around 13922). That is followed by `logEvent(\"session_shown\")` and `trySyncEvents()` (around 13958).\n- **Nothing re-runs on late hydration.** app.js has no reference to `storageHydrated` or `forayStorageReady`. Nothing re-runs `loadInterests` when hydration lands late.\n- **Interests get shadowed.** `loadInterests()` (line 425) seeds every taxonomy node as `saved[n.id] ?? Math.max(0, n.weight)`, reading from the un-hydrated memory. `saveInterests()` (line 445) writes `{ ...base, ...state.interests }`. Because `state.interests` holds every id, the defaults override the hydrated stored profile on the first nudge (lines 494, 597, 619, 4755).\n- **Other keys get shadowed.** `buildCards` writes `cp_seen` at 1263-1264. `logEvent` calls `profileId()`, which mints `cp_profile_id` when the read comes back empty (lines 199-206, 229). `trySyncEvents` calls `ensureAnonSession()`, which signs up a new anonymous user when `cp_sb_session` is empty (lines 300-316, 371).\n- **Hydration can't undo it.** durable-store.js:766 `if (this._dirty.has(k)) continue; // property 2: this session wins`. So these writes permanently beat the IndexedDB copies. The header at durable-store.js:55-61 calls `_dirty` \"the belt\" and says callers should still await `hydrate()` first. The 5 s bound breaks exactly that ordering.\n- **Only the rate was fixed.** client.js (around 1683-1719) fixes this race for `cp_rate` only, through `storageHydrated`. Its own comment describes the swept-localStorage / slow-IndexedDB case as real.\n\nCould not refute:\n- docs/DECISIONS.md has no ruling on the hydration bound.\n- The init() comment claims hydration \"must finish before the first write\", which contradicts the bounded wait, so this is not deliberate.\n- It has not been fixed.\n\nWhy medium: the trigger is narrow. It needs localStorage evicted, IndexedDB intact, and an IndexedDB read slower than 5 s. But when it happens, the listener silently and permanently loses their learned interests, analytics profile id, anonymous account and seen-window.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## races-6 — Incomplete fix of qa 80: pages that paint 'Loading…' first (Foray page, Forays list, Library before the module) never announce their name — the late paint lands with navigated:false and focus already on #view

**confirmed** · verifier severity **low** (finder: low) · races · `app.js:13018` · L6-navigation-firstrun-copy

```json
{
  "id": "races-6",
  "lens": "races",
  "title": "Incomplete fix of qa 80: pages that paint 'Loading…' first (Foray page, Forays list, Library before the module) never announce their name — the late paint lands with navigated:false and focus already on #view",
  "file": "app.js",
  "line": 13018,
  "severity": "low",
  "user_visible": "With VoiceOver, opening a Foray from Home says nothing: the title bar briefly reads '4a', focus sits on the view container, and when the real page arrives a tick later neither the heading nor the page name is spoken. A show page (which paints its heading synchronously) is announced; a Foray page is not.",
  "evidence": "app.js:9707 paints `statusPageHtml({ note: \"Loading…\", back: \"#/forays\" })` (no h2) before `await playerBridge()` (9709). route() then runs app.js:12838 `landOnPage({ navigated: ... })` against that DOM: 12884 `document.title = name && !isHomeRoute() ? ... : \"4a\"` and 12888-12893 focuses `#view` because there is no heading. The real paint calls app.js:13018 `landOnPage({ navigated: false })`, where `lost` is false (#view is still connected and focused) so 12895 `if (navigated && name) announce(name)` never fires. Same shape at 7960-7967 (renderForays 'Loading…') and 8818-8822 (renderLibrary).",
  "why_subtle": "The round-1 rule 'a navigation is said, not only drawn' is correct for synchronous pages; the async pages hand off to pageDidPaint, which deliberately never announces because it also serves background refreshes. The two together leave exactly the async pages silent.",
  "fix_sketch": "Track in route() whether the navigation was announced (`announcedFor = h` only when a name existed). In pageDidPaint, if `renderedHash !== announcedFor` and the page now has a name, announce it once and set `announcedFor`. Alternatively give the loading status page an h2 with the destination's known title (Foray title is resolvable synchronously from state.forays).",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 80.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds for the Foray page, but two of the three pages it names are wrong. On the Foray page: app.js:9707 (origin/main) paints `statusPageHtml({ note: \"Loading…\", back: \"#/forays\" })`. With no title, statusPageHtml (app.js:897-907) writes an empty `<div>` in `.page-head` and no h2. renderCurrentPage (12727) calls renderForay without awaiting it, so route() immediately calls `landOnPage({ navigated })` against that loading DOM. pageHeading() returns null and name is \"\", so document.title becomes \"4a\" (12884). If the tapped Home card was inside #view, focus is lost and goes to #view (12888-12893). If focus survived (a tab-bar link), `navigated && name` is false because name is empty. Either way nothing is announced. The real paint then reaches pageDidPaint (9874), which calls `landOnPage({ navigated: false })` (13018). Here #view is still connected and focused, so `lost` is false and the `navigated && name` announce can never fire. The title is corrected silently, and neither focus nor an announcement reaches the Foray title h2. The comment at 12871-12873 says `navigated:false` \"never announces\", so this is designed that way, but it defeats the qa row 80 goal for this route. No docs/DECISIONS.md ruling covers it (grep found nothing on announce, row 80 or landOnPage).\n\nThe finding overreaches on the other two pages. renderForays' loading paint (7948-7961) already includes `<h2>Forays</h2>` in its head, so route()'s landOnPage announces \"Forays\" or focuses the heading synchronously. renderLibrary paints its full page synchronously and only re-renders later via renderCurrentPage. So the confirmed scope is the Foray page, which is reached from Home, the Forays list and `?foray=` links. Severity stays low: it is a VoiceOver-only issue, the page is still reachable, and focus lands at the top of #view.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## races-7 — retryForayDocs repaints whatever page is on screen when its three un-deadlined fetches finally return — and fetchJson has no deadline, so the Foray page's 'Try again' can never reach a failed state on a stalled socket

**confirmed** · verifier severity **low** (finder: low) · races · `app.js:13473` · L5-boot-states-storage

```json
{
  "id": "races-7",
  "lens": "races",
  "title": "retryForayDocs repaints whatever page is on screen when its three un-deadlined fetches finally return — and fetchJson has no deadline, so the Foray page's 'Try again' can never reach a failed state on a stalled socket",
  "file": "app.js",
  "line": 13473,
  "severity": "low",
  "user_visible": "On a Foray page that could not load its documents, tap 'Try again' on a dead-zone connection: nothing changes (no spinner, no failure, the button is spent because bindRetry is once). Give up, go to Search and start typing; when the OS finally times the sockets out (tens of seconds) the Search page re-renders under the listener, dropping the typed query and the keyboard. If the fetches succeed late, the same repaint happens on whatever page they are on.",
  "evidence": "app.js:13473-13481 `async function retryForayDocs() { const [forays, segments, sources] = await Promise.all([fetchJson(...), fetchJson(...), fetchJson(...)]); if (forays && segments && sources) applyForaySet({...}); renderCurrentPage(); }` — no renderToken/route check. app.js:13355-13360 `fetchJson` is a bare `fetch(pinnedUrl(path), { cache: \"no-cache\" })` with no `withDeadline`, while 13390-13401 gives only `fetchApiJson` and the search documents a deadline ('NO REQUEST WAITS FOREVER'). Bound at 9720 and 7972 via `bindRetry` (914-921, `{ once: true }`), so a stalled retry also leaves no button.",
  "why_subtle": "The deadline review covered /api/* and the search documents; data/*.json was assumed to be answered by the worker or the bundle, but a first web visit, a pinned page, or a shell with a missing file goes to the network. The late repaint only bites the listener who left, which is the natural thing to do after a dead 'Try again'.",
  "fix_sketch": "Wrap the three fetches in `withDeadline(..., API_DEADLINE_MS, () => null)`; capture `const stillHere = renderToken(); const hash = currentHash();` before the await and repaint only when `stillHere()` (or when the current route is a Foray surface and the set changed, via the existing signature check). Paint 'Trying again…' and re-arm the button on failure.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; gap left by the 2026-09-23 'no request waits forever' review and the theme-G 'Try again' work.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked the code at origin/main (app.js) and it matches the finding.\n\n- **No deadline on the fetches.** `retryForayDocs` (13473-13481) runs `Promise.all` over three `fetchJson` calls. Whether or not all three succeed, it then calls `renderCurrentPage()` without any `renderToken()` or route check. `fetchJson` (13355-13360) is a plain `fetch(pinnedUrl(path), {cache:\"no-cache\"})` with no `withDeadline` and no AbortController. Only `fetchApiJson` (13378-13390) has the deadline. The 'NO REQUEST WAITS FOREVER' comment right below it names search and playlist states but not this retry.\n- **The repaint hits whatever page is showing.** `renderCurrentPage` (12702) increments `renderEpoch` and re-renders from the current hash, so a late return repaints the page the user is on now.\n- **The button is used up.** `bindRetry` (914-921) uses `{ once: true }` and paints no spinner or 'Trying again…' state. Both call sites (7972 in the Forays list, 9720 in the Foray page) bind `retryForayDocs`.\n- **Not deliberate.** docs/DECISIONS.md has no ruling on this. The review comments dated 2026-09-23 fixed the all-three-documents check but not the deadline or the route guard.\n\nWhy low: on a stalled socket nothing changes on screen after the tap and the button no longer works, so the 'failed state + fresh Try again' the doc comment promises is unreachable. A late return could also re-render another page under the user. That is a rare timing, though. The browser or OS usually times the socket out eventually. I did not check that the search page actually loses the typed query when re-rendered (the query may survive in the hash), but losing focus and the keyboard is likely. The fix sketch (wrap the fetches in `withDeadline`, repaint only if the route still matches, show a pending state) is sound.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-2 — A curated show whose episode fetch fails offers no Try again — the subtitle says 'couldn't load the full list' and nothing on the page can retry it

**confirmed** · verifier severity **medium** (finder: high) · states · `app.js:3916` · L5-boot-states-storage

```json
{
  "id": "states-2",
  "lens": "states",
  "title": "A curated show whose episode fetch fails offers no Try again — the subtitle says 'couldn't load the full list' and nothing on the page can retry it",
  "file": "app.js",
  "line": 3916,
  "severity": "high",
  "user_visible": "Offline or on a dead cell, open any of the 220 catalogue shows (the ones Home, Search browse, and 'Shows we vouch for' link to). The subtitle reads 'N episodes in 4a's catalogue (couldn't load the full list)', a handful of old hand-picked rows paint, and there is no Try again anywhere. Only a breadth show (zero curated rows) gets the button. The header ↻ works but nothing points at it.",
  "evidence": "paintBody(): `if (loadState !== \"loading\" && curatedEps.length) { c.innerHTML = curatedEps.map(…); bindRows(c); return; }` (3916-3920) returns BEFORE `if (loadState === \"failed\") { c.innerHTML = failedNoteHtml(BODY_PLACEHOLDER.failed); bindRetry(c, retryEpisodes); return; }` (3932-3936). `retryEpisodes` (4213) is therefore unreachable for every curated show. test/show-episode-load-states.test.js:410 asserts the rows survive and the subtitle carries the failure, but never asserts a retry exists; the Try-again test at :543 mounts a breadth show only.",
  "why_subtle": "Theme G's rule ('failed — say it failed, and offer Try again wired to the SAME fetch') is satisfied in the body branch and lost in the curated branch, which was written to preserve rows, not to drop the button. The page looks 'sort of loaded' so the missing control is not obvious until you want the real list.",
  "fix_sketch": "In the curated branch, when `loadState === \"failed\"` append `failedNoteHtml(BODY_PLACEHOLDER.failed)` under the rows (or a compact 'Couldn't load the full list — Try again' line) and `bindRetry(c, retryEpisodes)`. Extend the :410 test to assert `m.retry()` is present for `failed-with-curated`.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 134 / persona 22 / persona 75 (Try again on the show page) and of issue #687's one-writer refactor",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The code at origin/main (app.js, latest commit 9730b5b) is as the finding describes. In paintBody(), the check `if (loadState !== \"loading\" && curatedEps.length) { ...epRow...; bindRows(c); return; }` sits at about lines 3916-3920 and returns before `if (loadState === \"failed\") { c.innerHTML = failedNoteHtml(BODY_PLACEHOLDER.failed); bindRetry(c, retryEpisodes); return; }` at 3928-3932. The only call site for retryEpisodes (defined at 4208) is that failed branch; a grep for retryEpisodes and bindRetry finds no other retry path on the show page. So a curated show whose full-list fetch fails shows its curated rows and the subtitle \"N episodes in 4a's catalogue (couldn't load the full list)\" (line 3494), and nothing on the page offers Try again.\n\nThe test at test/show-episode-load-states.test.js (the \"keeps its real rows\" case) checks that the rows survive and the subtitle reports the failure. It never checks for a retry control.\n\nIs it deliberate? The long comment in paintBody and the test's comment justify keeping the curated rows instead of replacing them with the failure placeholder. Nothing in that reasoning, or in docs/DECISIONS.md (I grepped for retry, \"try again\", \"full list\" and \"curated\"), argues for leaving out a retry control. The retryEpisodes comment ('\"Try again\" on the failed body') suggests the authors meant it to be reachable whenever the fetch fails. So this is an oversight in the #687 one-writer refactor, not a ruling.\n\nI set severity to medium, not high. The page is not empty: it shows real, playable curated rows and an honest subtitle, and the header refresh (plus navigating away and back) still recovers. What is missing is a recovery affordance, not the content itself.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-3 — A Foray whose segments.json (or segment-sources.json) did not load paints as content — 'N clips from this foray couldn't be found, so they're left out' over an empty running order, with no Try again

**confirmed** · verifier severity **medium** (finder: high) · states · `app.js:9854` · L5-boot-states-storage

```json
{
  "id": "states-3",
  "lens": "states",
  "title": "A Foray whose segments.json (or segment-sources.json) did not load paints as content — 'N clips from this foray couldn't be found, so they're left out' over an empty running order, with no Try again",
  "file": "app.js",
  "line": 9854,
  "severity": "high",
  "user_visible": "On a stale service-worker generation or a partial deploy (init's own comment: the three Foray documents are 'the most likely to be missing from a cached service worker'), #/forays lists the Foray fine, the Foray page opens with the title, '0 clips', a total of 0:00, an empty strip, the sentence '22 clips from this foray couldn't be found, so they're left out.', and Play that plays nothing. Home's 'Forays for you' cards show the same Foray with no strip. There is no failure line and no retry.",
  "evidence": "init(): `[…, state.forays, state.segments, state.segmentSources, state.catalog] = await Promise.all([… fetchJson(\"data/forays.json\"), fetchJson(\"data/segments.json\"), fetchJson(\"data/segment-sources.json\") …])` (13905-13911) — each may be null independently. renderForay guards only `if (!state.forays)` (9719); it then resolves with `segmentsDoc: state.segments` (null). foray-resolve.js hydrateForayItems: `const seg = segIndex.get(raw.segment_id); if (!seg) { dropped.push({… reason: \\`segment ${raw.segment_id} is not in data/segments.json\\` }); return; }` (299-305) — with `asMap(null)` → empty Map, every tape item is dropped. renderForay: `const missing = Math.max(0, r.unplayable.length - shownOut);` → `${countLabel(missing, \"clip\")} from this foray couldn't be found, so … left out.` (9854). retryForayDocs' own header (13462-13470) names exactly this outcome for the retry path and fixes it there only ('Adopted only when ALL THREE came back'); the boot path still adopts a partial set.",
  "why_subtle": "The copy is written for a data-authoring defect (one bad segment id), so a whole-document network failure is described in the same calm voice as a real editorial gap, and every count on the page is internally consistent with the lie.",
  "fix_sketch": "Treat the three documents as one artifact at boot exactly as retryForayDocs does: if any of the three is null, set all three null (`applyForaySet` with nulls) so renderForays/renderForay/libraryForaysHtml take their existing 'Couldn't load forays right now' + Try again branch. Alternatively in renderForay, `if (!state.segments || !state.segmentSources)` → the same failed status page. Pin with a test mounting forays.json present and segments.json null.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 178 / qa 99 (Forays failed-doc states) — the 2026-09-23 review closed it for Try again but not for first boot",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In init() (app.js ~13900-13911), forays.json, segments.json and segment-sources.json are fetched with Promise.all, and each fetchJson result can be null independently. bootForayDirectory (13500) then passes that possibly partial seed to directory.boot and applies a set only when source === \"cache\". With no valid cache, or on a pinned page where boot is skipped, the partial seed stays in state as it is. renderForay (9718) checks only `!state.forays` before calling player.resolve with segmentsDoc = null. foray-resolve.js hydrateForayItems drops every tape item whose segment_id is missing from the index, with the reason \"segment X is not in data/segments.json\". The page then shows the \"N clips from this foray couldn't be found, so they're left out\" note, and there is no retry. retryForayDocs (13473) has a comment naming exactly this failure, and it adopts a set only when all three documents arrive. The boot path does not have the same all-or-nothing rule. Nothing in docs/DECISIONS.md makes this deliberate.\n\nTwo things can hide it, but neither closes it. First, refreshForayDirectory(\"boot\") after route() can adopt a whole network set. It returns early on a pinned page, though. When the held seed's version matches the live pointer and the set is not marked partial, it returns `current` and does not refetch. A refresh that did adopt also repaints only if the signature changed. Second, sw.js now stages whole, sha256-verified generations (DECISIONS ~1748). That makes a partial cached generation less likely than the finding's stale-service-worker story suggests. The realistic trigger is a one-file network or 404 failure during boot.\n\nI lowered severity to medium. The trigger is transient and a reload fixes it, but when it happens the user is told something false about the content and has no in-page way to recover.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-4 — The show page's episode fetch, the boot fetch and the show-index fetch have no deadline — 'Loading episodes…' / 'Loading 4a…' can spin forever on a black-holed connection, and the native shell has no service worker to cut it off

**confirmed** · verifier severity **medium** (finder: medium) · states · `app.js:3315` · L5-boot-states-storage

```json
{
  "id": "states-4",
  "lens": "states",
  "title": "The show page's episode fetch, the boot fetch and the show-index fetch have no deadline — 'Loading episodes…' / 'Loading 4a…' can spin forever on a black-holed connection, and the native shell has no service worker to cut it off",
  "file": "app.js",
  "line": 3315,
  "severity": "medium",
  "user_visible": "In the iOS/Android app on a captive portal or a dead zone that accepts the SYN, open a show: 'Loading episodes…' in the subtitle and body, and nothing ever changes — no failure, no Try again. On the web, the very first visit (no worker installed yet) can sit on 'Loading 4a…' the same way. On the Search page, one hung show-index fetch means the index never loads for the rest of the session.",
  "evidence": "fetchShowEpisodesUncached: `const res = await fetch(apiUrl(url));` (3315) — a bare fetch, no AbortController, no withDeadline; fetchJson: `const res = await fetch(pinnedUrl(path), { cache: \"no-cache\" });` (13357); loadShowIndex: `const res = await fetch(SHOW_INDEX_PATH, { cache: \"no-cache\" });` (5749) inside a promise whose `finally { showIndexPromise = null; }` never runs if it never settles, while `if (showIndexPromise) return showIndexPromise;` (5745) hands every later focus the same hung promise — contradicting the header's 'A later focus retries'. The 2026-09-23 'NO REQUEST WAITS FOREVER' review (13389-13397) added `API_DEADLINE_MS` to fetchApiJson and fetchShardRows only. sw.js `NET_TIMEOUT_MS = 6000` covers same-origin data on the web but not `apiUrl()` requests to `API_ORIGIN = \"https://foray-web-seven.vercel.app\"` (280), and the shell registers no worker (`shouldRegisterServiceWorker` returns false for `capacitor:`).",
  "why_subtle": "Every other loading state on the page now resolves to loaded/failed/empty, so a permanent 'Loading…' looks like a slow network rather than a bug; the founder's device is precisely the environment with no worker to rescue it.",
  "fix_sketch": "Route fetchShowEpisodesUncached through the same AbortController + `withDeadline(…, API_DEADLINE_MS)` shape as fetchApiJson, returning `{ episodes: null, error: \"timeout\" }` so the existing failed branch and Try again fire. Give fetchJson and loadShowIndex a deadline too (session.json under a longer one, since the boot failure already offers Try again).",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of the 2026-09-23 review's 'no request waits forever' rule (qa 101/persona 43 boot state)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js after a fresh fetch and the evidence holds.\n\n- **Show page episodes:** `fetchShowEpisodesUncached` at line 3304 calls `const res = await fetch(apiUrl(url));` at line 3315. It has no AbortController and no `withDeadline`, and its only safety net is a catch. The show page's `loadEpisodes` (around line 4139) reaches the \"failed\" state and its Try again only when that promise settles. With no cached list, the page paints \"loading\" (line 4132) and waits on it indefinitely. `fetchShowEpisodes` keeps the promise in `showEpisodesInFlight` and clears it only in `.finally`, so a hung first fetch also makes every later visit to the same show reuse the hung promise.\n- **Boot fetch:** `fetchJson` at lines 13355-13360 is a bare `fetch(pinnedUrl(path), {cache:\"no-cache\"})`. The boot code awaits `fetchJson(\"data/session.json\")` at line 13868 behind `BOOT_LOADING_HTML` \"Loading 4a…\".\n- **Show index:** `loadShowIndex` at lines 5743-5766 matches the finding. `if (showIndexPromise) return showIndexPromise;` returns the in-flight promise, and `showIndexPromise` is only reset in a `finally` that never runs if the fetch never settles. That contradicts the header comment's \"A later focus retries.\"\n- **The 2026-09-23 fix was partial:** the \"NO REQUEST WAITS FOREVER\" block (lines 13389-13397) plus `API_DEADLINE_MS`/`withDeadline` is applied to `fetchApiJson`, to the searchData load at line 1525 and to the call near line 5996. None of the three paths above got it.\n- **No service worker on native:** `shouldRegisterServiceWorker` (line 14117) returns false for `capacitor:`/`ionic:` and for native Capacitor, so the shell has no worker to time requests out.\n- **No ruling covers it:** docs/DECISIONS.md has no ruling exempting these paths.\n\n**Where the impact is smaller than claimed:** on native, `fetchJson` and the relative `SHOW_INDEX_PATH` most likely resolve to files bundled in the app package (prepare-webdir copies data files in), which cannot black-hole. So the boot and index hangs mainly matter on the web on a first visit with no worker installed. The show-page API fetch goes to the remote `API_ORIGIN` on native, so it is the solid user-visible case: a first visit to a show with no cached episodes, on a stalled connection, sits on \"Loading episodes…\" with no Try again. The trigger needs a network that stalls rather than fails fast, so I agree with medium severity.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-6 — 'Try again' after 'The player didn't load' cannot succeed — it only waits another 5 s for a module event that will never fire

**confirmed** · verifier severity **low** (finder: medium) · states · `app.js:9143` · L5-boot-states-storage

```json
{
  "id": "states-6",
  "lens": "states",
  "title": "'Try again' after 'The player didn't load' cannot succeed — it only waits another 5 s for a module event that will never fire",
  "file": "app.js",
  "line": 9143,
  "severity": "medium",
  "user_visible": "If player/client.js fails to load (a 404 on a stale generation, a parse error, a blocked script in the shell), #/forays and every Foray page say 'The player didn't load.' with Try again. Pressing it shows 'Loading…' for five seconds and then the same message, indefinitely; the only remedy that works, a reload, is never suggested.",
  "evidence": "`function playerBridge() { if (window.ForayPlayer) return Promise.resolve(window.ForayPlayer); return new Promise(resolve => { … window.addEventListener(\"forayplayer:ready\", finish, { once: true }); setTimeout(finish, PLAYER_WAIT_MS); }); }` (9143-9151), `PLAYER_WAIT_MS = 5000` (9141). renderForays: `paintStatus(failedNoteHtml(\"The player didn't load.\")); bindRetry($(\"#view\"), renderForays);` (7967-7968); renderForay: `bindRetry($(\"#view\"), () => renderForay(id));` (9716). Nothing re-inserts the `<script type=\"module\">` or otherwise retries the load. The Try-again convention (895) promises the button re-runs 'the SAME fetch that failed'; here no fetch is re-run.",
  "why_subtle": "A button labelled Try again that visibly does something (Loading… for 5 s) is more misleading than no button; the module failure is rare but it is exactly the stale-cache case sw.js's generation logic exists for, where the fix IS a reload.",
  "fix_sketch": "On a null bridge, distinguish 'still loading' from 'failed to load' (listen for the module script's `error` event or check `document.querySelector('script[type=module][src*=client]')`), and paint the stale-shell remedy — 'Reload 4a' wired to `location.reload()` — instead of Try again; or make the retry re-append the module script tag with a cache-busting query.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 99 / qa 178 (they added Try again; the retry is inert for the module half)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against the origin/main snapshot of app.js, and the evidence matches what the finding says.\n\n- **The wait:** PLAYER_WAIT_MS is 5000 (line 9141). playerBridge (9143-9151) either returns window.ForayPlayer or waits for the 'forayplayer:ready' event until 5 s run out, then resolves to window.ForayPlayer or null.\n- **renderForays (7960-7968):** when there is no bridge, it paints \"Loading…\". If the bridge comes back null, it paints failedNoteHtml(\"The player didn't load.\") and calls bindRetry($(\"#view\"), renderForays).\n- **renderForay (9712-9716):** same pattern, using statusPageHtml with retry: true and a retry that calls renderForay(id).\n- **bindRetry (914-921):** it only calls run() again. Nothing in app.js re-inserts or re-imports the module. index.html:79 is the only place player/client.js is loaded (`<script type=\"module\" src=\"player/client.js\">`). So when the module has actually failed (a 404, a parse error, or a blocked script), window.ForayPlayer is never set and the event never fires. Each Try again shows \"Loading…\" for 5 s and then the same failure, with no end.\n\n**Partial refutation (not enough to overturn it):** the retry does work when the module was only slow, meaning it took more than 5 s but still loaded. By the time of the retry, window.ForayPlayer exists, or the event fires during the next wait. The comment at 9707 (\"the retry re-runs this route, which re-awaits the player\") shows that this slow-load case was the one designed for.\n\n**Not a deliberate ruling:** that same comment says the \"Reload the page\" advice was dropped on purpose, because \"a native shell that has no page to reload\" makes it wrong. That undercuts the finding's suggested 'Reload 4a' fix, but it is not a ruling that a retry which can never succeed is acceptable. docs/DECISIONS.md does not mention this case either way.\n\n**Severity:** I rate it low. A hard load failure of the module needs a broken or stale deploy, and in that state most of the app is degraded anyway. Better fixes would be re-injecting the module script with a cache-busting query, or detecting the script's error event.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-7 — Search: a dead episode endpoint and dead breadth passes fail silently whenever the local pass found anything — no failure line, no Try again

**confirmed** · verifier severity **medium** (finder: medium) · states · `app.js:7448` · L4-search-create-playlists

```json
{
  "id": "states-7",
  "lens": "states",
  "title": "Search: a dead episode endpoint and dead breadth passes fail silently whenever the local pass found anything — no failure line, no Try again",
  "file": "app.js",
  "line": 7448,
  "severity": "medium",
  "user_visible": "On Wi-Fi with no internet (navigator.onLine stays true), type 'huberman' or 'daily' in Search. A few curated/index show names paint from the device; the Episodes section never appears and no line says the search only partly ran. 'Part of this search didn't load' + Try again appears only when the show list is EMPTY. The listener concludes 4a has no episodes for that query.",
  "evidence": "renderEpisodeSearchResults `.then((data) => { … paintEpisodeSearchResults(query, data, container, local); …})` (7434-7450) — with `data === null` and no local rows, paintEpisodeSearchResults does `container.innerHTML = \"\"; container.hidden = true; return 0;` (7286-7290). runShowSearchCostly's `showPassDone`: `showSearchSettled = { token: myToken, failed: showPassFailed }; const rows = paintedShowRows(…); if (!rows.length) paintShowResults(query, rows, myToken);` (6603-6612) — the failed flag is only ever painted through the empty branch of paintShowResults (6299-6304). The episode pass never reports into `showPassFailed` at all.",
  "why_subtle": "Theme G was applied to the shows tier; the episodes tier kept its pre-audit 'offline degrades to nothing rendered' rule (7263-7268), and the failure signal exists (`epHits: null` in diagnostics) but never reaches the screen.",
  "fix_sketch": "Track `episodePassFailed` alongside `showPassFailed`; when a pass failed and the token is still current, paint one 'Part of this search didn't load' + Try again line above the results regardless of row count (reuse paintShowSearchEmptyOffer's failed half in a `#sh-partial-note`). Pin with a mount where `api/episodes/search` resolves null while the local show pass returns rows.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 102 / qa 177 (the settled-search rule covers shows only)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read app.js at origin/main and the evidence holds. renderEpisodeSearchResults (about lines 7381-7450) passes `data` straight to paintEpisodeSearchResults when the endpoint fails. fetchApiJson swallows network and parse errors and returns null. When there are no local episode matches, paintEpisodeSearchResults clears the container and hides it (7286-7290), so no failure text appears. The episode pass never sets a failed flag; it only reports diagnostics. In runShowSearchCostly, showPassDone (6603-6612) records showSearchSettled with the failed flag, but it repaints only when paintedShowRows is empty. The only place 'Part of this search didn't load.' is shown is paintShowSearchEmptyOffer (6332), and it is reached only through the empty-shows branch of paintShowResults (6298-6301). So when local or curated show rows exist and a breadth pass or the episode endpoint fails, the listener gets no partial-failure line and no Try again. The Episodes section just disappears. navigator.onLine === false is special-cased, but a captive or no-internet Wi-Fi connection that still reports online is not. I found no ruling in docs/DECISIONS.md that allows a silent partial failure. The code comments call the failed endpoint pass 'leave the local tier as it was', which covers repainting the local rows, not hiding the failure. The failed response is not cached (the cache is only written when data is truthy), so retyping the query retries. That softens the impact, but the user still has no sign that anything failed. Medium severity fits.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## states-8 — The show page says every outcome twice, in two wordings, one under the title and one in the body

**confirmed** · verifier severity **low** (finder: low) · states · `app.js:3480` · L5-boot-states-storage

```json
{
  "id": "states-8",
  "lens": "states",
  "title": "The show page says every outcome twice, in two wordings, one under the title and one in the body",
  "file": "app.js",
  "line": 3480,
  "severity": "low",
  "user_visible": "Loading: subtitle 'Loading episodes…' and, 200 px lower, a body line 'Loading episodes…'. Failed (breadth show): subtitle 'Couldn't load this show's episodes right now.' and body 'Couldn't load these episodes.' + Try again. Empty: subtitle 'No episodes found for this show.' and body 'No episodes yet.' Each screen carries the same fact twice, phrased differently.",
  "evidence": "showEpisodeCountLabel: `return \"Loading episodes…\";` (3480), `: \\`Couldn't load this show's episodes right now.\\`` (3485), `\"No episodes found for this show.\"` (3495); BODY_PLACEHOLDER `{ loading: \"Loading episodes…\", empty: \"No episodes yet.\", failed: \"Couldn't load these episodes.\" }` (3868-3872); both are painted by paintEpisodeOutcome (`paintBody(); paintCount();`, 3960-3961) for every outcome.",
  "why_subtle": "Issue #687's fix made the two regions agree on STATE; nobody then asked whether both should speak. It is the kind of doubled copy the founder reads as 'subtly off'.",
  "fix_sketch": "While the body carries a status placeholder, let the subtitle be empty (or vice versa): in showEpisodeCountLabel return \"\" for loading/empty/failed-with-no-curated-rows when the body will say it, and keep a subtitle only where rows are on screen. One sentence per outcome.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order effect of qa 94 / issue #687",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main app.js and the finding holds. showEpisodeCountLabel returns \"Loading episodes…\" whenever loadState is \"loading\" (line 3480). When a load fails and there are no curated rows, it returns \"Couldn't load this show's episodes right now.\" When the show is empty and has no curated rows, it returns \"No episodes found for this show.\" or, for a breadth-tier show, \"…yet.\". BODY_PLACEHOLDER (lines 3868-3872) is {loading: \"Loading episodes…\", empty: \"No episodes yet.\", failed: \"Couldn't load these episodes.\"}. paintEpisodeOutcome calls paintBody() and then paintCount() for every outcome. paintBody always puts up the placeholder while loading, because curated rows are held back during loading on the founder's 2026-09-21 instruction. For failed and empty, it puts up the placeholder whenever curatedEps is empty. The subtitle is the page-head element `<p class=\"sub\" data-show-count>`, so both strings are on screen together. One detail in the finding is off: the loading pair uses the same words twice, not two different wordings. The failed and empty pairs do use different wordings. Where curated rows exist, the subtitle shows a count and the body shows rows, so nothing is repeated there. docs/DECISIONS.md has no ruling on this subtitle/body doubling. The #687 comments are about the two regions contradicting each other, not about them repeating each other, so this is not a deliberate choice. It has not been fixed. It is cosmetic redundancy, not wrong information, so the severity stays low.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## states-9 — 'Showing shows available offline' promises something 4a does not have — those shows are names only and every tap on one fails

**confirmed** · verifier severity **low** (finder: low) · states · `app.js:2936` · L4-search-create-playlists

```json
{
  "id": "states-9",
  "lens": "states",
  "title": "'Showing shows available offline' promises something 4a does not have — those shows are names only and every tap on one fails",
  "file": "app.js",
  "line": 2936,
  "severity": "low",
  "user_visible": "With the device reporting offline, search shows a list of curated/index show names under 'Showing shows available offline'. Tap any of them: 'Couldn't load these episodes' (breadth) or a few stale curated rows (curated). Nothing is available offline; there is no download feature (DECISIONS/persona 71: deliberate).",
  "evidence": "`<p id=\"sh-offline-note\" class=\"note\" hidden>Showing shows available offline</p>` (2936); shown by paintShowResults `if (offlineNote) offlineNote.hidden = !isOfflineForShardSearch();` (6276) whenever `navigator.onLine === false` (5903). The rows come from `localShowMatches` (curated 220 + show-index.tsv title projections) — no episodes are resident (7222-7228: 'zero episodes are on the device at boot').",
  "why_subtle": "The sentence was written from the search engine's point of view (which TIERS answered) and reads to a listener as a product promise.",
  "fix_sketch": "Reword to what is true: 'You're offline — showing show names 4a already knows; episodes need a connection.' and hide the note when the local list is empty.",
  "suspected_deliberate": true,
  "relation_to_round1": "related to qa 103 (which fixed when the note hides, not what it says); persona 71 marks no-offline as deliberate",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. app.js:2936 has `<p id=\"sh-offline-note\" class=\"note\" hidden>Showing shows available offline</p>`. paintShowResults (around line 6272-6274) sets `offlineNote.hidden = !isOfflineForShardSearch()`, and that function (around line 5902) returns `navigator.onLine === false`. The note appears whether or not the list is empty. The comment at line 6262 says the note is meant to explain why the shard and directory tiers are missing (\"the local pass still answers instantly offline\"). So the words mean \"results from local data\", but a reader takes them to mean the shows can be used offline, which is false.\n\nWhat a tap does offline: line 7076 says the curated catalogue is \"220 shows / 100 KB carrying `episode_count` and NO episodes\". A show page's episode fetch fails and paintBody shows \"Couldn't load these episodes.\" (line 3872). For a curated show, paintBody instead shows its stale curated rows (line 3913 onward), and playing one of those still needs the network.\n\nRefutation checks:\n(a) Not already fixed. qa 103 (PR #742) only changed when the note hides (clearShowSearchResults, line 6244) and left the wording alone.\n(b) No docs/DECISIONS.md ruling covers this copy. The only D9 there is an unrelated version policy, and no DECISIONS entry mentions \"available offline\". The string comes from a kanban card's acceptance line (S-05, 4a-shows-pipeline-plan §3.2). test/offline-search.test.js:202-209 pins it exactly, so a fix has to update that test as well. Persona 71's \"no downloads is deliberate\" covers the missing feature, not a note that implies the feature exists.\n\nSeverity stays low: the note is misleading copy in an edge state (the device must report offline) and nothing is lost.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## states-10 — Episode-search fallback note says '(N of the full list loaded so far)' but nothing will ever load more

**confirmed** · verifier severity **low** (finder: low) · states · `app.js:3988` · L4-search-create-playlists

```json
{
  "id": "states-10",
  "lens": "states",
  "title": "Episode-search fallback note says '(N of the full list loaded so far)' but nothing will ever load more",
  "file": "app.js",
  "line": 3988,
  "severity": "low",
  "user_visible": "On a show page, when the scoped search endpoint is down, typing in 'Search this show's episodes' shows e.g. '2 matches — searching loaded episodes only (100 of the full list loaded so far).' 'So far' implies the list is still growing; since 'Show more episodes' was deleted on 2026-09-13, it never will.",
  "evidence": "paintSearchNote: `\\`${matchCount} match${…} — searching loaded episodes only (${loaded.length} of the full list loaded so far).\\`` (3988); the removal note at 3925-3955 documents that nothing advances past page 1.",
  "why_subtle": "Copy left over from the pagination era; it is only visible on the endpoint-failure path so it survived two audits.",
  "fix_sketch": "'… searching the latest 100 episodes only — the connection didn't answer for the rest.' and offer Try again wired to runSearch.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order effect of the 2026-09-13 Show-more removal",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main. Line 3988 in paintSearchNote is exactly as the finding describes. In fallback mode (searchMode === \"fallback\", set when searchShowEpisodesScoped returns episodes === null) with fullyLoaded false, it renders `${matchCount} match(es) — searching loaded episodes only (${loaded.length} of the full list loaded so far).` The comment at 3776-3781 confirms that since the 2026-09-13 removal of \"Show more episodes\", nothing advances past page 1. The REMOVED block at 3991-4025 confirms paintMoreButton and loadNextPage are gone, so `loaded` never grows and \"so far\" implies loading that will never happen.\n\nThis was not left in on purpose. The founder call at 3440-3446 dropped the matching \"100+ episodes loaded so far — more available\" wording from the count label, because it would advertise \"a door that no longer exists\". The same reasoning applies to this note, but it was missed. docs/DECISIONS.md has no ruling on this wording, and the code has not been fixed.\n\nUsers only see it in a degraded path: the scoped search endpoint has to fail, the show has to have more than one page of episodes, and the user has to type a query. The note is still accurate about the scope (it searches loaded episodes only). Only \"so far\" misleads, so this is a low-severity copy issue.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## states-12 — Search with a failed catalogue: 'Couldn't load the show list' + Try again sits beneath live search results and is hidden/unhidden by the focus rule as if it were browse furniture

**refuted** · verifier severity **low** (finder: low) · states · `app.js:2700`

```json
{
  "id": "states-12",
  "lens": "states",
  "title": "Search with a failed catalogue: 'Couldn't load the show list' + Try again sits beneath live search results and is hidden/unhidden by the focus rule as if it were browse furniture",
  "file": "app.js",
  "line": 2700,
  "severity": "low",
  "user_visible": "When data/catalog-client.json failed, #/shows shows the failed line at the bottom. Tap the field and it vanishes (it is treated as browse furniture); type 'lex', results paint from the show index; blur, and 'Couldn't load the show list.' reappears under a list of shows — contradicting the rows above it. The Try again is also unreachable while the field has focus, i.e. while you are looking for a show.",
  "evidence": "showBrowseSections: `return [$(\"#sh-browse\"), $(\"#view .show-index\"), $(\"#view .show-index-failed\")].filter(Boolean);` (2700-2702) — all hidden by `updateShowBrowseVisibility` while `showSearchFieldFocused || input.value.trim()` (2755). renderShowIndexPage paints the failed block last: `${above}${list}` (2549-2550) with `list = <div class=\"show-index-failed\">${failedNoteHtml(\"Couldn't load the show list.\")}</div>` (2534).",
  "why_subtle": "The failed block was added to the hide list so it would not sit under results (qa 110's fix), which made it disappear at the very moment a retry would matter and left its wording generic ('the show list') on a page whose list is now the search.",
  "fix_sketch": "Word it for what failed — 'Couldn't load the A–Z catalogue' — and keep it visible (but small, above the results) while a query is active, or move it into `#sh-empty-offer`'s failed branch so a settled empty search also offers the catalogue retry.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order effect of qa 110 + the 2026-09-13 hide-on-focus rule",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the quoted snippets are accurate. showBrowseSections() (app.js 2700-2702) does include `.show-index-failed`. updateShowBrowseVisibility hides it when `showSearchFieldFocused || input.value.trim()`. renderShowIndexPage does paint the failed block after `above`.\n\nThe contradiction the finding describes still can't happen. The blur handler (about 3086) sets focused=false and calls updateShowBrowseVisibility. The predicate still hides the furniture while the field has text, and the comment at 2740-2750 says so: \"blur with a live query -> STAYS hidden\". So typing 'lex' and then blurring does not bring back 'Couldn't load the show list.' under the results.\n\nThe failed line only comes back once the query is empty. At that point onShowSearchInput('') (6851) and dismissShowSearch (2825) both call clearShowSearchResults, which hides #sh-results, #ep-search-results and #pl-search-results. That means no list of shows can sit above the failed note.\n\nOne part of the claim is real: the catalogue Try again is hidden while the field is focused or holds a query. That follows from the founder's rule of 2026-09-13, documented at 2718-2750, which hides all browse furniture including the A-Z index on focus. The failed note and its retry show at rest, which is where the catalogue is offered. The wording nit ('show list' vs 'A-Z catalogue') is cosmetic. The headline user-visible defect is refuted, and what is left is intended behaviour of low consequence.",
  "merged_ids": [],
  "lane": null
}
```

## nav-1 — ‹ goes dead when history.back() lands on an entry with the same hash — hashchange never fires, backPending never clears

**confirmed** · verifier severity **medium** (finder: medium) · nav · `app.js:13184` · L6-navigation-firstrun-copy

```json
{
  "id": "nav-1",
  "lens": "nav",
  "title": "‹ goes dead when history.back() lands on an entry with the same hash — hashchange never fires, backPending never clears",
  "file": "app.js:13184-13191 (onBackClick), app.js:13123-13147 (noteNavigation), app.js:13167-13175 (leaveRemovedPlaylist), app.js:14041 (only hashchange is listened to)",
  "line": 13184,
  "severity": "medium",
  "user_visible": "After a reload on a playlist page reached from Playlists, remove that playlist: the app lands on Playlists. Tap ‹ — nothing. Tap again — nothing, forever, until some other link is tapped. Same dead ‹ after: search 'foo' on the Search page → tap the Search tab (clears it, pushes an entry) → type 'foo' again → ‹. Or: show page → in-show search 'abc' → tap a link back to the same show → search 'abc' again → ‹.",
  "evidence": "onBackClick: `if (backPending) return; backPending = true; history.back();`. The only thing that clears it is `noteNavigation` (`backPending = false;` at its first line), which only runs from route(), which only runs from `window.addEventListener(\"hashchange\", route)` — there is no popstate listener. Per the HTML spec, traversing to an entry whose fragment equals the current one fires popstate but NOT hashchange. Adjacent same-hash entries are created by (a) leaveRemovedPlaylist after a reload: `navHashes` is empty after a reload (it is page-life state) so `navHashes[navIndex - 1] === \"#/playlists\"` is false and it takes `replaceHash(\"#/playlists\"); route()`, rewriting the current entry to the same hash as the entry behind it; (b) rewriteRouteInPlace (app.js:12946) rewriting the current entry (`#/shows` → `#/shows/q/foo`) to equal the previous entry's hash. test/back-navigation.test.js's fakeHistory (line 95, 152) calls `route()` unconditionally after `back()`, so the suite cannot see this.",
  "why_subtle": "Every individual piece is correct: the debounce (round-1 fix for double-tap) and the in-place rewrites (qa 126/127/133 fixes) each work alone; their second-order interaction is a history where two neighbouring entries share a hash, which the hashchange-only router cannot traverse. It surfaces only after a reload or a retype, so it reads as 'the back button sometimes just stops working'.",
  "fix_sketch": "Also bind `window.addEventListener(\"popstate\", () => { if (currentHash() === renderedHash) { backPending = false; noteNavigation(currentHash()); } })` — or simply route on popstate and make route() idempotent for same hash. Additionally, in leaveRemovedPlaylist after a reload, prefer `history.back()` when `history.state.fyIdx > 0` and the URL behind cannot be known, or at minimum clear backPending on a timer/popstate. Add a fakeHistory test where back() does not fire hashchange for an equal fragment.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction of qa 117 (leaveRemovedPlaylist), qa 126/127/133 (in-place query rewrites) and the ‹ double-tap debounce; not previously reported.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js and the code matches the finding. onBackClick (around line 13184) does `if (backPending) return; backPending = true; history.back();`. leaveRemovedPlaylist (13167) also sets backPending = true before history.back(). The only place that clears it is the first line of noteNavigation (13124), and only route() (12813) calls noteNavigation. route is bound only to `window.addEventListener(\"hashchange\", route)` (14041). No popstate listener, timer or other reset exists anywhere in the file (I grepped for backPending and popstate).\n\nBrowsers fire hashchange on a traversal only when the fragment changes, so a history.back() onto an adjacent entry with the same hash never runs route(). backPending then stays true. navIndex also never moves, so canGoBackInApp() stays true and every later tap on ‹ returns early. ‹ stays dead until a link or tab tap triggers a real hashchange.\n\nBoth ways to get two adjacent entries with the same hash are real:\n(a) navHashes is page-life state (`const navHashes = []`), and after a reload noteNavigation only fills navHashes[navIndex]. That makes `navHashes[navIndex - 1] === \"#/playlists\"` false, so leaveRemovedPlaylist runs `replaceHash(\"#/playlists\"); route()`, and the current entry now has the same hash as the Playlists entry behind it.\n(b) rewriteRouteInPlace (12946) uses replaceHash to change the current entry's hash in place, for example after a tab tap pushed #/shows and the same query is typed again.\n\ntest/back-navigation.test.js's harness `back()` runs `nav.history.back(); evalIn(\"route()\")` unconditionally, so the suite cannot catch this. docs/DECISIONS.md has no ruling on backPending, popstate or same-hash handling. It is not deliberate and not fixed.\n\nOn what the user sees: in the search case the first ‹ tap already looks like it does nothing (same page), which makes this look minor. But every later tap also does nothing, so the user cannot go back further until they tap a link. Severity is medium: the paths are uncommon and recovery is easy, but the main back control silently stops working.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## nav-2 — Android hardware back is the raw WebView back: with the drawer or Now Playing sheet open it closes the overlay AND changes the page underneath

**confirmed** · verifier severity **medium** (finder: medium) · nav · `mobile/package.js:12826` · L2-sheets-drawer-gestures

```json
{
  "id": "nav-2",
  "lens": "nav",
  "title": "Android hardware back is the raw WebView back: with the drawer or Now Playing sheet open it closes the overlay AND changes the page underneath",
  "file": "mobile/package.json:23 (@capacitor/app present, no listener anywhere), app.js:12813-12834 (route closes drawer + all sheets on any hash change), app.js:11055-11059 (drawer is not a history entry), player/client.js:2502-2508 (sheet is not a history entry)",
  "line": 12826,
  "severity": "medium",
  "user_visible": "On Android: open ☰ and press the system back — the drawer closes but you are also on the previous page. Expand Now Playing and press back — the sheet collapses AND the page behind it changes. Open a sheet on Home with nothing behind it and press back — the app exits with the sheet still up.",
  "evidence": "grep for `backButton`, `App.addListener`, `onBackPressed`, `popstate` across app.js, player/*.js and mobile/ returns nothing. Capacitor's BridgeActivity default when no `backButton` listener is registered is `webView.goBack()` if it can, else finish. The drawer is toggled with `$(\"#drawer\").hidden = !open` and sheets via `openSheet`/`sheetStack`, neither pushes history; route() then does `openDrawer(false); if (h !== previousHash) closeAllSheets();` on the hash step the WebView's goBack produced.",
  "why_subtle": "On iOS there is no hardware back and no swipe-back in the shell, so the founder's iPhone never shows it; on Android every native app treats back as 'dismiss the top-most thing', and here it dismisses the top-most thing and one more.",
  "fix_sketch": "Register `App.addListener('backButton', ...)` in the shell path: if the drawer is open → openDrawer(false); else if openSheetCount() > 0 → close the top sheet (ForaySheets.closeAllSheets or the top entry's requestClose); else if canGoBackInApp() → history.back(); else App.exitApp(). Expose a tiny `window.ForayNav.handleBack()` in app.js so the ordering lives beside the ownership model that docs/DECISIONS.md 2026-09-23 just wrote down.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; round 1 fixed drawer/sheet ownership for taps (2026-09-23 founder items 2+3) but never for the platform back.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n- **No back-button handling anywhere.** A search of app.js, player/, mobile/ and index.html for backButton, onBackPressed, OnBackPressedCallback, hardwareBackPress, popstate, goBack and exitApp found nothing that handles back. The only hit is a comment at app.js:12232 listing the AppPlugin methods, `toggleBackButtonHandler` among them. mobile/package.json does ship @capacitor/app ^8, but nothing registers a listener on it. The Android back press therefore falls to Capacitor's default: `webView.goBack()` if the WebView has history, otherwise finish the activity.\n- **The drawer and sheets never add history entries.** `openDrawer()` (app.js ~11055) only flips `hidden` on #drawer and #drawer-overlay. The Now Playing sheet (player/client.js ~2502) opens through `owner.openSheet` with no history write. The only pushState/replaceState calls in app.js are the `?foray=` replaceState and the fyIdx index writes. So a WebView goBack always steps back one real page.\n- **route() closes overlays on any hash change.** It runs `openDrawer(false)` and then `if (h !== previousHash) closeAllSheets()`. The route() comment even describes \"a back gesture over a sheet\", so the author knew back can land while a sheet is open. They treated it as a navigation that should close the sheet, not as something the back press should do by itself.\n- **What the user sees.** Back with the drawer or Now Playing open closes the overlay and also changes the page underneath. Back on a first page with no in-app history exits the app.\n- **No ruling covers it.** Nothing in docs/DECISIONS.md is about Android hardware back. Round 1's drawer and sheet fixes covered taps only.\n\nMedium is the right severity. It hits a basic Android gesture on every overlay, but nothing is lost and the user can recover.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## nav-3 — Incomplete fix of qa 115: a back-step to Search results (#/shows/q/<q>) never re-applies its scroll restore, because the Search page never calls pageDidPaint

**confirmed** · verifier severity **medium** (finder: medium) · nav · `app.js:12985` · L6-navigation-firstrun-copy

```json
{
  "id": "nav-3",
  "lens": "nav",
  "title": "Incomplete fix of qa 115: a back-step to Search results (#/shows/q/<q>) never re-applies its scroll restore, because the Search page never calls pageDidPaint",
  "file": "app.js:12985-12991 (the review comment admits it), app.js:2848-3130 (renderAllShows: no pageDidPaint), app.js:6562+ (runShowSearchCostly paints directory/shard/episode results asynchronously), app.js:13012-13023 (pageDidPaint), app.js:12839-12849",
  "line": 12985,
  "severity": "medium",
  "user_visible": "Search for something, scroll down into the episode results below the show results, open one, tap ‹. You land part-way up the page (wherever the synchronous show rows ended), not where you were, and for the next 4 seconds the app also refuses to remember where you scroll to.",
  "evidence": "route(): `scrollPageTo(target); if ((window.scrollY || 0) < target - 1) pendingRestore = {...}` — the restore is clamped because at this instant only `paintShowSearchLocal` has painted; `#ep-search-results` and the directory/shard rows arrive later from `runShowSearchCostly`. Only two callers of pageDidPaint exist (app.js:3962 show page, 9874 Foray page). The 2026-09-23 review comment says so explicitly: \"the Search page (whose directory results paint later)... never do. Their clamped restore stayed owed for the whole visit\" and chose a 4 s expiry (PENDING_RESTORE_MS) rather than a paint hook. rememberScrollPosition: `if (renderedHash === null || restoreStillOwed()) return;` so memory is frozen during the wait.",
  "why_subtle": "It looks like the qa 115 fix works — the show and Foray pages do restore. The Search page is the one page where the listener is most likely to have scrolled past an async boundary, and the failure is a slightly-wrong position rather than the top, which reads as 'random' exactly like the founder's 2026-09-13 show-page report.",
  "fix_sketch": "In runShowSearchCostly, when the last owed pass settles (the point where `showPassesOwed` hits 0 and the episode/playlist halves have reported), call pageDidPaint() once for the token that is still current. Same for renderCategory when shows === null retries. Keep the 4 s expiry as the belt.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 115",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js directly, and the finding's core claim holds, with two corrections.\n\nWhat checks out:\n- route() (about line 12839) calls scrollPageTo(target). It sets pendingRestore only when that scroll was clamped.\n- pageDidPaint (13012) is the only thing that re-applies a clamped restore. Its only callers are line 3962 (show page) and line 9874 (Foray page).\n- renderAllShows(query) (2848-3130) ends with renderShowSearchResults(query), which runs paintShowSearchLocal and then runs runShowSearchCostly synchronously, with no debounce. Neither function calls pageDidPaint.\n- The review comment at 12985-12991 says in so many words that the Search page never calls pageDidPaint. It picked a 4 s PENDING_RESTORE_MS expiry instead of a paint hook.\n- docs/DECISIONS.md has no ruling on scroll restore, so this is not covered as deliberate.\n\nCorrection 1: the gap is narrower than the finding says. On a back-step within the same session the caches are warm, and these all paint synchronously, before route() restores the scroll:\n- the breadth catalogue (showBreadthQueryCache)\n- the directory (showDirectoryQueryCache)\n- the episode endpoint (episodeSearchQueryCache, so #ep-search-results fills synchronously)\n- playlists\n\nThe shard pass is always async. fetchShardRows is an async function, so even a hit in its memory cache resolves in a microtask after route() has already scrolled. mergeBreadth then appends any new shard rows to #sh-results, which sits above #ep-search-results. There is no row cap, so the page is shorter by those rows at the moment of restore. Any pass whose cache is cold (a failed or degraded directory reply is never cached; the caches get cleared at their max size) also paints late.\n\nThe result: a user coming back to a spot in the episode results either gets clamped (the restore stays owed and is never re-applied) or lands at the right y and then sees the content pushed down by the shard rows. Either way they don't land where they were, so the user-visible part holds.\n\nCorrection 2: \"for the next 4 seconds the app refuses to remember where you scroll\" is overstated. touchstart, wheel and keydown all call abandonPendingRestore (line 14072), so any real user scroll immediately clears the owed restore and memory resumes.\n\nThe fix sketch also only covers the clamped case. Calling pageDidPaint when showPassesOwed reaches 0 would re-apply a clamped restore, but it would not undo the shift when the restore was not clamped and shard rows were then inserted above the viewport.\n\nSeverity: medium. It is a visible misplacement on a core back-navigation flow, but it does not lose data and one scroll recovers from it.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## nav-7 — Incomplete fix of qa 80: the document title and the route announcement glue the explicit badge onto the name ('Some EpisodeE · 4a')

**confirmed** · verifier severity **low** (finder: low) · nav · `app.js:12883` · L6-navigation-firstrun-copy

```json
{
  "id": "nav-7",
  "lens": "nav",
  "title": "Incomplete fix of qa 80: the document title and the route announcement glue the explicit badge onto the name ('Some EpisodeE · 4a')",
  "file": "app.js:12880-12896 (landOnPage), app.js:937-939 (explicitBadge), app.js:8482 (renderEpisode h2), app.js:3689 (renderShow h2)",
  "line": 12883,
  "severity": "low",
  "user_visible": "Open an explicit show or episode: the browser tab / window title reads 'Show TitleE · 4a', and VoiceOver/TalkBack announces 'Show TitleE' on arrival and on every back-step to it.",
  "evidence": "landOnPage: `const name = head ? String(head.textContent || \"\").replace(/\\s+/g, \" \").trim() : \"\"; document.title = ... `${name} · 4a`` and `if (navigated && name) announce(name);` while the heading is `<h2>${esc(show.title)}${explicitBadge(show.explicit)}</h2>` and explicitBadge returns `<span class=\"explicit-badge\" title=\"Explicit content\" aria-label=\"Explicit\">E</span>` — textContent ignores aria-label and gives 'E' with no separator.",
  "why_subtle": "Only on explicit content, only in the title bar / screen reader, and the badge is visually fine.",
  "fix_sketch": "Derive the name from the heading minus badges: clone the h2, remove `.explicit-badge` (and any other decoration), then read textContent; or write the plain title into `data-page-title` on `.page-head` and have pageHeading/landOnPage prefer it.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 80",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n- **Badge markup:** app.js:937-939 `explicitBadge()` returns `<span class=\"explicit-badge\" ... aria-label=\"Explicit\">E</span>`.\n- **Where it lands:** the badge is placed straight after the escaped title, with no separator, inside the `.page-head` h2 on two pages. One is the show page (app.js:3689, `<h2>${esc(show.title)}${explicitBadge(show.explicit)}</h2>`). The other is the episode page (app.js:8481, `<h2 class=\"fp-s-title\">${esc(item.title)}${explicitBadge(item.explicit)}</h2>`, inside `<div class=\"page-head\">`).\n- **How the name is built:** `pageHeading()` (app.js:12874) returns that h2. `landOnPage()` (app.js:12880-12895) reads `head.textContent` and only collapses whitespace. It then sets `document.title = \\`${name} · 4a\\`` and calls `announce(name)` when navigated.\n- **Result:** `textContent` ignores aria-label and returns the literal \"E\", so an explicit title gives \"Some EpisodeE · 4a\" in the tab and \"Some EpisodeE\" in the arrival announcement. Nothing strips the `.explicit-badge` before the text is read.\n- **Not a ruling:** docs/DECISIONS.md has no ruling on this. It mentions `document.title` only in the lock-screen Now Playing context, which is unrelated.\n- **Not fixed:** there is no `data-page-title` or badge-stripping path at origin/main.\n\nThe user sees it whenever an item's `explicit === true`. Per-episode explicit flags are real catalogue data (DECISIONS: contentAdvisoryRating).\n\nSeverity stays low. It is a cosmetic tab-title glitch, plus an odd trailing \"E\" in the screen-reader announcement. Nothing breaks.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## nav-8 — A drawer link (or the wordmark) to the page you are already on is a silent no-op — including under the expanded Now Playing sheet, where it leaves the sheet covering the page you asked for

**confirmed** · verifier severity **low** (finder: low) · nav · `app.js:11097` · L2-sheets-drawer-gestures

```json
{
  "id": "nav-8",
  "lens": "nav",
  "title": "A drawer link (or the wordmark) to the page you are already on is a silent no-op — including under the expanded Now Playing sheet, where it leaves the sheet covering the page you asked for",
  "file": "app.js:11097-11103 (onDrawerAction), app.js:11168-11174 (onTabBarClick handles the same-hash case for tabs only), player/client.js:2502-2508 (keepReachable: topbar, drawer), index.html:49 (wordmark href=\"#/\"), index.html:62-66",
  "line": 11097,
  "severity": "low",
  "user_visible": "On Up Next, expand Now Playing, tap ☰ → 'Up Next': the drawer closes and the sheet stays; you are looking at the player, not Up Next. Same for ☰ → Home on Home, and the '4a' wordmark on Home. Off the sheet, the same tap does nothing at all (the tab bar, by contrast, scrolls to top for the same gesture).",
  "evidence": "onDrawerAction only closes the drawer (`openDrawer(false)`) and lets the `<a>` fall through; a same-hash `href` fires no hashchange, so route() — the only thing that calls `closeAllSheets()` and `scrollPageTo(0)` — never runs. The Now Playing sheet deliberately keeps `\".topbar\", \"#drawer\", \"#drawer-overlay\"` reachable (F17), so this path is the one real navigation route under the sheet.",
  "why_subtle": "The drawer does leave (the 2026-09-23 fix), which makes the tap look acknowledged; the missing half is that nothing else changes.",
  "fix_sketch": "In onDrawerAction (or a bubbling click handler on the drawer and the wordmark): if the item is an `<a>` whose `currentHash(href) === currentHash()`, `e.preventDefault(); closeAllSheets(); scrollPageTo(0);` — the same rule onTabBarClick already applies.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order interaction of the 2026-09-23 drawer-ownership fix, F17 (drawer reachable over the sheet) and qa 131 (tab-tap scrolls to top).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b and the finding holds.\n\n- **Drawer:** `onDrawerAction` (app.js ~11097) only calls `openDrawer(false)` and returns. The drawer's `<a>` links (index.html:62-66) then act as ordinary hash links. When the link's hash matches the current one, no hashchange fires, so `route()` (app.js ~12813) never runs.\n- **route() would not fix it anyway:** it only calls `closeAllSheets()` when `h !== previousHash`, so even a same-hash route would leave the sheet open. That is why the fix has to call `closeAllSheets()` and `scrollPageTo(0)` itself. The fix sketch is right to do both explicitly.\n- **Wordmark:** `<a class=\"wordmark\" href=\"#/\">` (index.html:49) has no click handler at all; only `#refresh-btn` is bound.\n- **Now Playing sheet:** player/client.js ~2502 opens it with `keepReachable: [\".topbar\", \"#drawer\", \"#drawer-overlay\"]`, so the ☰ and the wordmark still work over the expanded sheet. Tapping the current page's drawer item closes the drawer and leaves the sheet covering the page. The tab bar is inert under the sheet.\n- **Tab bar comparison:** `onTabBarClick` does handle a same-hash tap (preventDefault + `scrollPageTo(0)`). Its comment says a same-hash tap \"did nothing at all\" before that fix. So the gap is real and applies only to the drawer and the wordmark.\n- **Rulings:** nothing in docs/DECISIONS.md covers it. The 2026-09-23 drawer-ownership entry only rules that the drawer closes before the control acts. Nothing makes a same-hash no-op deliberate.\n\nSeverity is low: it is a small gesture, and the user can still collapse the sheet with its own control or Escape.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## nav-9 — ☰ and ↻ are painted from the first frame but dead until every boot JSON has arrived

**confirmed** · verifier severity **low** (finder: low) · nav · `app.js:14010` · L5-boot-states-storage

```json
{
  "id": "nav-9",
  "lens": "nav",
  "title": "☰ and ↻ are painted from the first frame but dead until every boot JSON has arrived",
  "file": "app.js:13849-13915 (init awaits session.json then seven files), app.js:14010 (bindDrawerChrome), app.js:14031 (refresh-btn), index.html:48-50",
  "line": 14010,
  "severity": "low",
  "user_visible": "On a cold start over a slow cell connection the header shows ☰ and ↻ beside 'Loading 4a…' for several seconds; tapping either does nothing, with no pressed state and no explanation.",
  "evidence": "`bindDrawerChrome(); ... $(\"#refresh-btn\").addEventListener(\"click\", refreshCurrentPage);` sit after `await Promise.all([storageReady(), fetchJson(\"data/session.json\")])` and the second `await Promise.all([...seven fetchJson...])` and `await bootForayDirectory(directory)`. The topbar itself is static HTML (index.html:47-51) and paints immediately.",
  "why_subtle": "On the founder's phone on Wi-Fi the window is under a second; on a cell dead zone it is the whole 'is this broken?' interval the qa 101 loading state was added to cover, and the loading state now draws attention to two buttons that do not work.",
  "fix_sketch": "Bind the drawer chrome and the refresh button before the first await (the drawer's playlists/toggles read local state; guard renderDrawer's toggle registry with an early return until bindDrawerToggles has run), or disable the two buttons (`aria-disabled`, dimmed) until `state.ready` and enable them in route().",
  "suspected_deliberate": false,
  "relation_to_round1": "Adjacent to qa 101 (cold-boot loading state); not previously reported.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. index.html:47-51 puts #menu-btn (☰) and #refresh-btn (↻) in the static topbar, so they paint right away. The only listener on #menu-btn is added by bindDrawerChrome() (app.js:11106-11107). init() calls it at app.js:14010, and adds the refresh-btn listener at app.js:14031. Both calls come after three awaits: `await Promise.all([storageReady(), fetchJson(\"data/session.json\")])`, then an await on seven fetchJson calls (validated-links, taxonomy, discover, forays, segments, segment-sources, catalog-client), then `await bootForayDirectory(directory)`. Neither button is bound anywhere else. The only other script tag is search-engine.js. styles.css has no dimmed or disabled state keyed to boot (no data-boot rule for the buttons). While this happens, #view shows the BOOT_LOADING_HTML text 'Loading 4a…'. The code comment at the session.json failure path confirms it on purpose: \"nothing above this line binds a listener\". So when session.json fails, both buttons stay dead for the whole failed state too, and the user has only the in-view 'Try again'. docs/DECISIONS.md has no ruling that makes this deliberate. The 2026-09-23 drawer entries cover the drawer closing when a control is used, not boot timing. Severity is low. On a slow cell connection the buttons do nothing for a few seconds with no feedback, but nothing breaks, the in-view text explains that the app is loading, and the dead time is the same boot latency the loading state already covers.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## nav-10 — Inside the native shell a relaunch after the OS kills the app lands on Home with no history; the route lives only in the URL hash

**confirmed** · verifier severity **low** (finder: low) · nav · `app.js:13928` · L6-navigation-firstrun-copy

```json
{
  "id": "nav-10",
  "lens": "nav",
  "title": "Inside the native shell a relaunch after the OS kills the app lands on Home with no history; the route lives only in the URL hash",
  "file": "app.js:13925-13928 (init reads location.hash; bare arrival → #/), app.js:13101-13118 (navIndex/stamps live in history.state), no cp_ key stores the route",
  "line": 13928,
  "severity": "low",
  "user_visible": "Listen from a show page, background the app for an afternoon, come back: 4a opens on Home, and ‹ has nothing behind it. Apple Podcasts reopens on the screen you left. (A plain reload keeps the hash and the stamps, so this only happens when the WebView is torn down.)",
  "evidence": "`if (location.hash === \"\" || location.hash === \"#\") replaceHash(\"#/\");` then `route()`. The stamp comment says `history.state survives a reload`; nothing persists `currentHash()` or the stack (grep for last_route/lastRoute/cp_route: none). The shell loads `capacitor://localhost/` fresh on a cold launch, so both the hash and history.state are gone.",
  "why_subtle": "Only after a cold relaunch, which on iOS happens invisibly after memory pressure; it reads as 'the app forgot where I was' rather than as a bug.",
  "fix_sketch": "On every route(), write `currentHash()` to sessionStorage AND (in the shell) to the durable store as `cp_last_route`; in init, when the arrival is bare and the shell is native, replaceHash to the stored route once (and clear it), and treat it as a cold open (navIndex 0, ‹ href fallback). Do not do it on the web, where a bare URL means Home on purpose (qa 132).",
  "suspected_deliberate": true,
  "relation_to_round1": "New; possibly deliberate (Home-on-launch), but nothing in DECISIONS.md rules on it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In app.js init, `if (location.hash === \"\" || location.hash === \"#\") replaceHash(\"#/\");` runs just before the first route(). The nav-stamp block (navIndex, historyIndex, stampHistory) keeps the back stack only in history.state. Its own comment says it survives a reload and that \"a genuinely cold open has no stamp, starts at 0, and keeps the href fallback.\"\n\nNothing saves the route anywhere else. A grep for last_route, lastRoute, cp_route, cp_last and lastScreen finds nothing. The only sessionStorage use in app.js is an unrelated one-time mark around line 12688. The only cp_ resume keys are cp_lastpick and the foray resume point. Those hold where you are in the audio, not which screen you were on. mobile/capacitor.config.json has no server.url and no state-restoration setting, so a cold launch loads the bundled page with an empty hash and lands on Home.\n\nNot deliberate by ruling. The \"A bare arrival is Home\" comment is about web arrivals. A grep of docs/DECISIONS.md for launch, relaunch, reopen, cold open, restore and state restoration finds nothing about reopening on the last screen in the native shell.\n\nSeverity is low. Home's \"Jump back in\" section and the stored audio resume point bring back the listening state. Also, iOS rarely kills an app that is playing audio in the background. What is lost is the screen the user was on and the ‹ back history. That is a small polish gap next to Apple Podcasts, not a bug that loses data.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-1 — Incomplete fix of qa 141: Delete-my-data still says "This browser has taken storage away" and tells a phone listener to "Reload" five times

**confirmed** · verifier severity **low** (finder: medium) · copy · `app.js:11734` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-1",
  "lens": "copy",
  "title": "Incomplete fix of qa 141: Delete-my-data still says \"This browser has taken storage away\" and tells a phone listener to \"Reload\" five times",
  "file": "app.js",
  "line": 11734,
  "severity": "medium",
  "user_visible": "After pressing Delete everything on a phone where part of storage would not clear, the result line reads e.g. \"Your rows on our server are deleted. This device is NOT fully clear. This browser has taken storage away.\" or \"... Storage refused the delete. Reload and try again.\" There is no browser and no reload in the native shell; \"rows\" and \"account token\" are database words.",
  "evidence": "deviceNotClearReason(): `if (reason === \"no-storage\") return \"This browser has taken storage away.\";` then four more branches ending `\"Reload and try again.\"` (11735, 11736, 11738, 11741, 11744, 11746). deletionMessage() 11719-11725: \"Your server rows were NOT deleted…\", \"Your rows on our server were left in place…\", \"No account token was on this device, so no server rows were reachable.\", \"Your rows on our server are deleted.\" Also the sheet body 11769-11770: \"Our server: the events this device sent, and its account rows.\" / \"Your anonymous account row stays.\" test/listener-copy.test.js:186-188 explicitly exempts this string (\"left to the delete-my-data lane, which is rewriting that function's result copy\"), while docs/audit/status.tsv qa 141 says \"the storage line rewritten by L6\" — the two lanes each thought the other did it.",
  "why_subtle": "Only reachable through a typed DELETE confirmation on a device whose storage partly refuses, so nobody sees it in a normal test drive; the ledger says it was fixed.",
  "fix_sketch": "Rewrite deviceNotClearReason in shell-neutral words (\"4a couldn't clear part of this device. Close 4a fully and try again.\"), replace \"rows\"/\"account token\" with \"what 4a stored about you on its server\" / \"this device was never signed in\", and drop the `browser copy` exemption comment from listener-copy.test.js so the STALE regex (`/your browser|reload the page/`) is widened to `/this browser|reload and try again/`.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 141 (and the same lane note on qa 143/183)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main (latest commit 9730b5b). deviceNotClearReason() still returns \"This browser has taken storage away.\" for no-storage, and five other branches end in \"Reload and try again.\" deletionMessage() still uses \"Your server rows were NOT deleted…\", \"Your rows on our server were left in place…\", \"No account token was on this device, so no server rows were reachable.\" and \"Your rows on our server are deleted.\" DD_COVERS still says \"its account rows\" and \"Your anonymous account row stays.\"\n\ntest/listener-copy.test.js still carries the exemption comment (\"This browser has taken storage away.\" … is left to the delete-my-data lane, which is rewriting that function's result copy). Its STALE regex /your browser|reload the page|.../ also cannot match \"This browser\" or \"Reload and try again\". docs/audit/status.tsv marks qa 141 as fixed with the note \"no browser/page copy in the app; the storage line rewritten by L6\". L6 only rewrote the qa 143/183 \"0 key(s)\" count, not the browser wording, so each lane assumed the other had done it. docs/DECISIONS.md has no ruling covering this copy.\n\nSeverity is low: the \"browser\"/\"Reload\" lines appear only on the rare path where local clearing fails. The \"rows\" wording shows on every successful delete, but it is mild jargon rather than something wrong or misleading. The real problem is the audit record, which claims a fix that was never made.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-6 — The same failure is worded three ways across the Foray page, the sheet and the mini bar

**confirmed** · verifier severity **low** (finder: low) · copy · `player/client.js:920` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-6",
  "lens": "copy",
  "title": "The same failure is worded three ways across the Foray page, the sheet and the mini bar",
  "file": "player/client.js",
  "line": 920,
  "severity": "low",
  "user_visible": "A load that fails on the Foray page says \"That clip wouldn't load. Check the connection, then press play.\"; the Now Playing sheet says \"That episode could not load. Check the connection, then press play.\"; the mini bar's line says \"Did not load — press play to try again\". In a Foray the page line and the bar line can be on screen together, one contracted and one not, one ending in a full stop and one not.",
  "evidence": "app.js 10296: `const FY_START_FAILED = \"That clip wouldn't load. Check the connection, then press play.\";` client.js 920: `const EP_START_FAILED = \"That episode could not load. Check the connection, then press play.\";` client.js 1634: `const EPISODE_FAILED_LINE = \"Did not load — press play to try again\";`. The client comment (911-917) explains the uncontracted form as a workaround for the test lexer, not a copy decision.",
  "why_subtle": "Each string was added by a different lane fixing a different silence (persona 4/5, qa 141) and each is grammatical; only a listener who sees two at once notices.",
  "fix_sketch": "One sentence pair (\"couldn't load\" / \"Check the connection, then press play\") in both files; teach the source-text suites to tokenise apostrophes rather than shaping listener copy around the test.",
  "suspected_deliberate": false,
  "relation_to_round1": "second-order of persona 4/5 and the FY_START_FAILED rewrite",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The three strings are exactly as quoted at origin/main. app.js:10296 has FY_START_FAILED = \"That clip wouldn't load. Check the connection, then press play.\" (the file is app.js at the repo root, not player/app.js). player/client.js:920 has EP_START_FAILED = \"That episode could not load. Check the connection, then press play.\" and player/client.js:1634 has EPISODE_FAILED_LINE = \"Did not load — press play to try again\". The comment at client.js 916-919 confirms the uncontracted form is there to avoid breaking the regex string-strippers in the source-text test suites, not because anyone chose that wording. docs/DECISIONS.md has no ruling on this wording; its only \"couldn't load\" mention (line 1996) is about the catalogue fetch. So the inconsistency is real and not covered by a decision.\n\nPart of the finding is wrong, though. It says the Foray page line and the bar line can be on screen at the same time. They can't: paintStatus (client.js ~1653) sets `failure = foray ? null : playFailure`, so the bar and sheet show no failure line during a Foray, and only the Foray page's own line appears. The mismatch is therefore spread across different moments (Foray vs. ordinary episode) and different surfaces (short bar line vs. full sentence in the sheet). A listener never sees two versions next to each other. The shorter bar wording is also partly on purpose: the comment near line 1630 says \"L2's short bar copy\" for the one-line bar. A smaller extra problem: the client.js comment at line 907 quotes the Foray line as \"That segment wouldn't load\", but the code says \"clip\", so the comment is out of date.\n\nSeverity is low. This is copy polish and does not break anything.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-7 — Incomplete fix of qa 151: the down-vote chip still says "topic" where the whole app says "subject"

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:9169` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-7",
  "lens": "copy",
  "title": "Incomplete fix of qa 151: the down-vote chip still says \"topic\" where the whole app says \"subject\"",
  "file": "app.js",
  "line": 9169,
  "severity": "low",
  "user_visible": "Thumb-down a clip and the first reason chip reads \"Not into this topic\". Every other surface — onboarding (\"What are you into?… Type a subject yourself\"), Home (\"Outside your usual subjects\"), Create (\"Name a subject\"), the feedback sheet's own subtitle — says subject.",
  "evidence": "`const FB_CHIPS = [\"Not into this topic\", \"Didn't like the voice\", …]` (9169). qa 151's fix note: \"'usual subjects' everywhere\"; test/listener-copy.test.js STALE list bans only /usual topics/.",
  "why_subtle": "The chip sits in a sheet opened by a thumbs-down that few testers press, and the round-1 regex was written for the one phrase that was reported.",
  "fix_sketch": "\"Not my subject\" (or \"Not into this subject\"); widen the STALE regex to /\\btopics?\\b/ over listener strings.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 151",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The core claim is correct at origin/main (9730b5b). app.js:9168-9169 has `const FB_CHIPS = [\"Not into this topic\", ...]`. feedbackSheetHtml (app.js:9526) renders those chips, and a thumbs-down calls openFeedbackSheet (bindFeedback, ~9585-9595), so any listener who down-votes a segment sees the chip. The rest of the app says \"subject\" in the places the finding lists: onboarding \"What are you into?\" (5384), the \"Or type a subject yourself…\" input (5410-5411), \"Outside your usual subjects\" (4653), and Create's \"Name a subject…\" (8964). test/listener-copy.test.js:197 bans only /usual topics/, so nothing stops this string. docs/DECISIONS.md has no ruling on this chip wording or on topic vs subject, so it is not deliberate.\n\nThree corrections to the finding:\n- **Sheet subtitle is wrong.** The finding says the feedback sheet's own subtitle says \"subject\". It does not. openFeedbackSheet (9544-9545) sets it to \"About ${show} — the more specific, the faster your picks get good.\"\n- **\"Incomplete fix of qa 151\" is a stretch.** qa 151 was about the Stretch tooltip/bridge wording (\"usual topics\" to \"usual subjects\"). The chip string was copied word for word from docs/ux/foray-mockup.jsx:1045, so it was never inside qa 151's scope. The mismatch is real either way.\n- **The chip text is also the stored reason code.** setFeedback stores the chip label in `reasons`, which rides the thumbs event, and docs/legal/data-safety.md:100 calls these \"the fixed reason codes (app.js:FB_CHIPS)\". Renaming the chip changes the analytics value, so either map the old value to the new one or accept the break. The mockup would also need the same edit.\n\nSeverity stays low: a one-word wording mismatch on a secondary sheet. It doesn't mislead the listener or block anything.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-8 — Curly quotes on one button, straight quotes on every other quoted query

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:7007` · L4-search-create-playlists

```json
{
  "id": "copy-8",
  "lens": "copy",
  "title": "Curly quotes on one button, straight quotes on every other quoted query",
  "file": "app.js",
  "line": 7007,
  "severity": "low",
  "user_visible": "After an empty search the button reads Create a playlist about “fusion” with typographic quotes; the note above it reads No shows found for \"fusion\". with straight ones, as do \"No episodes match \"…\".\", \"Not much on \"…\" yet\" and Home's Starts with \"…\" line.",
  "evidence": "createPlaylistCtaHtml: `Create a playlist about “${esc(query)}”` (7007) vs `No shows found for \"${query}\".` (6299), `No episodes match \"${esc(searchQuery.trim())}\".` (3842), `Not much on \"${query}\" yet` (4455-4456), startsWithLine `Starts with \"${esc(t)}…\"` (4640).",
  "why_subtle": "Both glyphs render as quotes; only side-by-side on the empty-search screen does the mismatch register as \"subtly off\".",
  "fix_sketch": "Pick the typographic pair (Apple's) and route every quoted user string through one small helper; a listener-copy test can assert no listener string contains a straight \" around an interpolation.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and the finding holds. Line 7007 has `Create a playlist about “${esc(query)}”`, which is written as “/” escapes, so it renders as curly quotes. It is the only curly-quote use in the file. Every other quoted query uses straight quotes: 6299 `No shows found for \"${query}\".` (and the `Searching for \"${query}\"…` state), 3842 `No episodes match \"…\".`, 4455-4456 and 8944-8945 `Not much on \"${query}\" yet`, and 4640 `Starts with \"…\"`. Users see both styles on the same screen: when show search settles empty, the note reads `No shows found for \"X\".` and the playlist CTA, which appears only when topicSearchStatus is empty, is on the same search page. docs/DECISIONS.md says nothing about curly or straight quotes (its only 'smart quotes' hit is about search normalization), so this is not a deliberate choice, and nothing on main has fixed it. It is cosmetic: the text is still clear and nothing breaks, so severity is low.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## copy-9 — An Up Next row for an episode the catalogue no longer names says "Removed from your history" — nothing was removed and it is not History

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:8557` · L3-queue-and-native-surfaces

```json
{
  "id": "copy-9",
  "lens": "copy",
  "title": "An Up Next row for an episode the catalogue no longer names says \"Removed from your history\" — nothing was removed and it is not History",
  "file": "app.js",
  "line": 8557,
  "severity": "low",
  "user_visible": "On the Up Next page a queued episode whose details can no longer be found shows the title \"Episode no longer available\" and the line \"Removed from your history — no details saved\". The listener did not remove anything and is not looking at History; Library → History uses different words for the same state (\"Previously played, no longer available\").",
  "evidence": "upNextRow(): `: \"Removed from your history — no details saved\";` for `state === \"unnamed\"` (8557); historyRowHtml (8770-8771): `<div class=\"t\">No longer available</div><div class=\"s\">Previously played, no longer available</div>`; archivedRow's unnamed copy (8085): \"Saved before 4a kept episode details\". Three wordings for one state across three pages.",
  "why_subtle": "Only appears when an id in cp_queue is neither in the pool nor in a cp_saved snapshot — a state that arises after a catalogue refresh, not in a fresh test drive.",
  "fix_sketch": "One sentence for the unnamed state everywhere (\"4a no longer has this episode's details\") and drop the \"Removed from your history\" claim.",
  "suspected_deliberate": false,
  "relation_to_round1": "related to qa 142 (one unavailability statement per row) — that fix covered playlists, not Up Next",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and the code matches the finding. In upNextRow (line 8557), a row whose state is \"unnamed\" gets the title \"Episode no longer available\" (8552) and the line \"Removed from your history — no details saved\". A row is unnamed when rowsForIds (1961-1968) finds neither a live pool entry nor a stored snapshot for the id. Real users can hit this: comment 1885-1890 says Up Next used to store only a bare id, so anything queued before snapshots were added still has no details behind it.\n\nThe wording is wrong in two ways. The listener is on the Up Next page, not History, and nothing was removed: the id is still sitting in the queue. It is simply missing its details.\n\nIt is not already fixed and it is not a recorded decision. docs/DECISIONS.md has nothing about unnamed or no-longer-available wording. One part of the finding is weaker than stated. The comment at 8764-8769 explains that History and Saved/playlists use different fallback sentences on purpose, because the same state means something different in each place. So \"three wordings across three pages\" is partly by design, and forcing one sentence everywhere is not clearly the right fix. That comment only defends wording that fits its own page, though, and Up Next's line borrows History's context (\"your history\") and gets it wrong. The core defect holds.\n\nIt is cosmetic copy on a legacy-data edge case, so severity stays low. The fix is to rewrite the Up Next unnamed line so it fits Up Next, for example \"4a no longer has this episode's details\". Merging all three pages onto one sentence is optional.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## copy-10 — partsNote's plural sentence ends in the singular: "they stay listed so you can see where it fits"

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:8101` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-10",
  "lens": "copy",
  "title": "partsNote's plural sentence ends in the singular: \"they stay listed so you can see where it fits\"",
  "file": "app.js",
  "line": 8101,
  "severity": "low",
  "user_visible": "A playlist with two or more aged-out episodes shows: \"2 episodes are not available right now, so they cannot play — they stay listed so you can see where it fits in the playlist.\"",
  "evidence": "`parts.push(`${archived} episode${one ? \" is\" : \"s are\"} not available right now, so ${one ? \"it\" : \"they\"} cannot play — ${one ? \"it stays listed\" : \"they stay listed\"} so you can see where it fits in the playlist.`);` — the final clause is not switched. The sibling sentence directly below (8110) has a comment insisting \"EVERY plural agrees, verbs included.\"",
  "why_subtle": "The one-episode case reads perfectly and is the case anyone tests.",
  "fix_sketch": "`… so you can see where ${one ? \"it fits\" : \"they fit\"} in the playlist.` and a test with archived = 2.",
  "suspected_deliberate": false,
  "relation_to_round1": "new (the sentence was rewritten in the qa 142 fix)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js at line 8101, inside partsNote(). The line is exactly as the finding quotes it. The subject and verb are switched (\"it stays listed\" / \"they stay listed\"), but the last clause is always \"so you can see where it fits in the playlist.\" So when two or more episodes are archived, the sentence goes from \"they\" back to the singular \"it\". partsNote is called at line 8164 in the playlist detail render, so users do see this text whenever a playlist has at least two archived rows. docs/DECISIONS.md has no ruling on this wording. The only other copy is the same sentence in the archived legacy app.js, so the error was carried over unchanged, not chosen on purpose. It contradicts the \"EVERY plural agrees\" comment on the sentence right below it. The suggested fix is correct: `where ${one ? \"it fits\" : \"they fit\"}`. Severity is low: a grammar slip in one note that does not change what the note means.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-11 — Two narrators: the app is "4a" in most copy and "we/us/our" in the rest, sometimes on one screen

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:5603` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-11",
  "lens": "copy",
  "title": "Two narrators: the app is \"4a\" in most copy and \"we/us/our\" in the rest, sometimes on one screen",
  "file": "app.js",
  "line": 5603,
  "severity": "low",
  "user_visible": "\"4a picks podcast episodes for you\" … \"we learn either way\" on the same onboarding sheet; \"Shows we vouch for\" under a Search page whose empty state says \"4a\"; the playlist page says \"here's what we've got\" while the row beneath says \"Saved before 4a kept episode details\"; Delete my data says \"Our server… We cannot delete that\" beside \"Some of what 4a saved here\". The feedback sheet says \"Tell us in your own words\".",
  "evidence": "\"we\" voice: 5387 \"we learn either way, from what you play\", 5603 \"Shows we vouch for\", 8162-8163 \"here's what we've got\" / \"here's what we found\", 8960 \"Name a subject and we'll build a playlist\", 9520 \"Tell us in your own words…\", 11769-11771 \"Our server… We cannot delete that.\", 12484 \"if we ask for it\". \"4a\" voice: 5331 \"4a picks podcast episodes for you\", 1091 \"4a doesn't add its new episodes anywhere\", 8056 \"4a could not get a playable audio file\", 8085 \"Saved before 4a kept episode details\", 10295 \"4a couldn't start the audio\", 574 \"what 4a suggests\", 549 \"Back to 4a's pick\". No voice rule in CLAUDE.md or docs/DECISIONS.md.",
  "why_subtle": "Every sentence is natural on its own; the switch in speaker is felt, not read.",
  "fix_sketch": "Record a rule in DECISIONS (Apple Podcasts never says \"we\"; the app is \"4a\" and the company is \"we\" only in legal copy) and sweep the eight \"we\" strings; add the rule to the listener-copy test as a regex over app.js/client.js strings.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main (9730b5b) and the quotes are there, with line numbers within a few of the ones cited. The \"we\" voice appears at 5387 (\"This is how we tune your suggestions... we learn either way\"), 5604 (h3 \"Shows we vouch for\"), 8162-8163 (\"here's what we've got\" / \"here's what we found\"), 8964 (\"Name a subject and we'll build a playlist\"), 9528 (placeholder \"Tell us in your own words…\"), 11769-11771 (\"Our server...\" / \"We cannot delete that.\") and 12484 (\"if we ask for it\"). The \"4a\" voice appears at 562 (\"Back to 4a's pick\"), 578 (\"what 4a suggests\"), 1091 (FOLLOW_NOTE), 5331 (\"4a picks podcast episodes for you\"), 8056, 8085, 10295 and 11741/11746 (\"Some of what 4a saved here\").\n\nAlmost all of these are rendered text, headings or placeholders the listener sees. The one exception is 8056, which sits in a title attribute and only shows as a tooltip. I searched docs/DECISIONS.md and CLAUDE.md for a voice rule and found none. DECISIONS 2026-08-21 only settles the product name, \"4a\" instead of \"Foray\". Line 459 bans copy that implies the app makes a new audio file and says nothing about pronouns. \"Shows we vouch for\" comes from a requirements-audit item (A3.5), so that label may be intentional, but no ruling makes the mixed voice deliberate. It has not been fixed.\n\nSeverity is low because this is tone and consistency polish, not a functional problem. Each screen still makes sense on its own.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-12 — Voice picker rows carry the maintainer's notes-to-self: "unverified name", "Enhanced tier is a free download", "unknown language"

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:12035` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-12",
  "lens": "copy",
  "title": "Voice picker rows carry the maintainer's notes-to-self: \"unverified name\", \"Enhanced tier is a free download\", \"unknown language\"",
  "file": "app.js",
  "line": 12035,
  "severity": "low",
  "user_visible": "In Settings → Narration voice, rows read \"Nicky — American · female · Enhanced (download) · unverified name\", \"Samantha — American · female · the default; Enhanced tier is a free download\", \"Serena — British · female · Enhanced/Premium (download)\", and an installed voice with no reported language ends \"· unknown language\". Three shorthand styles in one list, and \"unverified name\" is a note about the allowlist, not about the voice.",
  "evidence": "VOICE_ALLOWLIST (12030-12042): `about: \"American · female · the default; Enhanced tier is a free download\"`, `\"… Enhanced (download) · unverified name\"` (Nicky, Aaron), `\"… Enhanced/Premium (download)\"`; the comment above (12024) says an unconfirmed voice \"says 'unverified name' in its own description rather than guessing\". Row sub: `${entry.about} · ${voiceQualityLabel(v)} · ${v.language || \"unknown language\"}` (12284).",
  "why_subtle": "The sheet is one drawer item deep and the words look like specs; only someone reading closely asks what \"unverified name\" is asking them to do.",
  "fix_sketch": "Descriptions as accent · gender only; the tier comes from voiceQualityLabel already; drop \"unverified name\" from the visible text (keep it in a code comment or a `data-` attribute) and omit the language piece when unknown.",
  "suspected_deliberate": true,
  "relation_to_round1": "related to persona 69 (voice copy) — the tier/allowlist annotations were not in scope",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. app.js 12029-12043: VOICE_ALLOWLIST contains `about` strings exactly as quoted. Samantha's is \"American · female · the default; Enhanced tier is a free download\". Nicky and Aaron end \"Enhanced (download) · unverified name\". Serena and Karen say \"Enhanced/Premium (download)\". Line 12284 builds the installed row's subtitle as `${entry.about} · ${voiceQualityLabel(v)} · ${v.language || \"unknown language\"}`, and buildVoiceRow shows it in the Settings \"Narration voice\" sheet (12137, 12436).\n\nIt is actually a little worse than reported. voiceQualityLabel (12122) adds the plugin's own tier, so an installed row reads something like \"American · female · Enhanced (download) · unverified name · enhanced · en-US\". The tier appears twice, and \"(download)\" shows even on a voice that is already installed.\n\nThe case for deliberate is partial. The comment at 12016-12028 says an unconfirmed name \"says 'unverified name' in its own description rather than guessing\", which is an honesty choice. Another comment calls the list a \"TRIAL SET for the founder to download\", so for now its audience is mostly the founder. No docs/DECISIONS.md entry rules on this wording, though. The only related DECISIONS entry, from 2026-09-12, covers cutting the voice picker and the plan to bundle Kokoro. The same comment also says \"Descriptions are accent · gender · tier only\", and the Samantha string breaks that rule.\n\nThe \"unknown language\" fallback and the doubled tier are plainly not deliberate, and none of this has been fixed. Severity stays low: the text is cosmetic and appears in a picker the founder is trialling while it is slated to be replaced by the bundled Kokoro voice.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-13 — Page-head fragments in three registers: "none yet", "0 queued" over "Nothing in Up Next yet", "0 built", and a lowercase Library subtitle

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:11043` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-13",
  "lens": "copy",
  "title": "Page-head fragments in three registers: \"none yet\", \"0 queued\" over \"Nothing in Up Next yet\", \"0 built\", and a lowercase Library subtitle",
  "file": "app.js",
  "line": 11043,
  "severity": "low",
  "user_visible": "The drawer's Playlists list says \"none yet\" (lowercase, no sentence) while every other empty state is a full sentence. Up Next with nothing queued shows \"0 queued\" in the header and \"Nothing in Up Next yet…\" directly below it; Playlists shows \"0 built\" then \"No playlists yet…\". Library's subtitle is \"forays, shows, saved, playlists, Up Next & history\" — lowercase common nouns beside the capitalised Up Next, and \"shows\" for a section called Followed shows.",
  "evidence": "11043: `|| `<p class=\"drawer-empty\">none yet</p>``; renderQueue 8524: `<p class=\"sub\">${rows.length} queued</p>` with the empty note at 8529; renderPlaylists 8833: `<p class=\"sub\">${all.length} built</p>` with 8848's note; 8799: `<p class=\"sub\">forays, shows, saved, playlists, Up Next &amp; history</p>`.",
  "why_subtle": "Each fragment is a fine label in isolation; the duplication and register shifts only appear on empty first-run screens.",
  "fix_sketch": "Omit the count sub when it is zero (the note already says so), \"No playlists yet\" in the drawer, and a Library subtitle that names its sections as they are titled (\"Forays, Followed shows, Saved, Playlists, Up Next, History\") or none at all, as Apple's Library has none.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and every cited line holds. 11043: the drawer's Playlists list falls back to `<p class=\"drawer-empty\">none yet</p>` whenever playlists() is empty. renderQueue 8525 (cited as 8524) prints `<p class=\"sub\">${rows.length} queued</p>` with no zero guard, and the 8529 note \"Nothing in Up Next yet — ...\" sits right below it, so an empty queue shows \"0 queued\" above \"Nothing in Up Next yet\". renderPlaylists 8833 prints `${all.length} built` with no zero guard, and the 8848 note \"No playlists yet — type above...\" renders under it. The Library subtitle at 8799 reads \"forays, shows, saved, playlists, Up Next &amp; history\". Other page heads handle this more carefully, for example 1236 uses countLabel(), so the inconsistency is real. docs/DECISIONS.md has no ruling on empty-state wording, count subtitles or the Library subtitle, so this is not deliberate. Nothing has fixed it. I did not check whether the section is titled exactly \"Followed shows\", but the rest of the finding stands without that. The problem is copy polish only, with no functional impact, so severity is low.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-14 — The Follow note reads like a bug report: "4a doesn't add its new episodes anywhere."

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:1091` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-14",
  "lens": "copy",
  "title": "The Follow note reads like a bug report: \"4a doesn't add its new episodes anywhere.\"",
  "file": "app.js",
  "line": 1091,
  "severity": "low",
  "user_visible": "Under Followed shows (and beside the Follow button) the listener reads \"Following keeps a show one tap away in your Library. 4a doesn't add its new episodes anywhere.\" The second sentence sounds like something is broken rather than a statement of what Follow is.",
  "evidence": "`const FOLLOW_NOTE = \"Following keeps a show one tap away in your Library. 4a doesn't add its new episodes anywhere.\";` The comment above (1085-1090) says the intent is to warn an Apple switcher that Follow is a bookmark and that the noun is \"a founder noun ruling still open\".",
  "why_subtle": "It is factually true and was added to prevent a worse misunderstanding; the tone is the problem, not the content.",
  "fix_sketch": "State the positive: \"Following keeps a show one tap away in your Library. New episodes stay on the show's page — nothing is downloaded or queued for you.\"",
  "suspected_deliberate": true,
  "relation_to_round1": "related to the open Follow/Save noun question in qa-synthesis",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the evidence holds. app.js:1091 is `const FOLLOW_NOTE = \"Following keeps a show one tap away in your Library. 4a doesn't add its new episodes anywhere.\";`. The listener sees it in two places: the Followed shows page (app.js:1242, `<p class=\"note\">`), which shows it whether or not the list is empty, and the show page's hero block right under the Follow button (app.js:3702, `.show-follow-note`). It is not fixed. It was added today in 9c2f7c4 (#742, the 2026-09-22 audit fix), and test/starred-shows.test.js:225 pins the exact wording with the regex /doesn('|&#39;)t add its new episodes anywhere/.\n\nOn whether it is deliberate: the comment at app.js:1084-1090 shows the disclosure is on purpose. It warns an Apple switcher that Follow is only a bookmark (no feed, no notifications, CLAUDE.md principle 2), so the fix has to keep that meaning. But no docs/DECISIONS.md entry rules on this wording. Grepping DECISIONS.md for \"follow\" finds nothing about the Follow note, and the comment itself says the Follow noun is \"a founder noun ruling still open\". The negative wording is an author's copy choice. The test pins that choice, but the test is not a ruling. So the finding is a valid copy/tone issue, not something a ruling covers. \"4a doesn't add its new episodes anywhere\" is vague (add them where?) and reads like a missing feature.\n\nSeverity stays low: the text is accurate and warns the user as intended, and only the tone and clarity are off. Anyone who fixes it must update the regex in test/starred-shows.test.js:225. They should also keep the \"no new episodes are delivered\" meaning, and should check that the fix sketch's \"nothing is downloaded\" is true to the product before using it.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## copy-15 — Every date prints its year, unlike Apple Podcasts, which drops it for the current year

**confirmed** · verifier severity **low** (finder: low) · copy · `app.js:1009` · L6-navigation-firstrun-copy

```json
{
  "id": "copy-15",
  "lens": "copy",
  "title": "Every date prints its year, unlike Apple Podcasts, which drops it for the current year",
  "file": "app.js",
  "line": 1009,
  "severity": "low",
  "user_visible": "Episode rows read \"Lex Fridman · 1h 5m · Sep 12, 2026\" for an episode released last week; Apple Podcasts shows \"Sep 12\" (and relative words for the last few days), reserving the year for older episodes. On a phone the extra \", 2026\" is what pushes the progress label onto the next line.",
  "evidence": "fmtDate(): `const opts = { year: \"numeric\", month: \"short\", day: \"numeric\" }; … return d.toLocaleDateString(\"en-US\", opts);` — unconditional year; used by epRow (8037), archivedRow (8084), the episode page (8482) and playedOnLabel (986).",
  "why_subtle": "Correct and consistent, just heavier than the benchmark on every single row.",
  "fix_sketch": "Omit `year` when the date is in the current calendar year (UTC for release dates, local for played-on), keep it otherwise; one test for a same-year and a prior-year date.",
  "suspected_deliberate": true,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main. fmtDate (line 1009) builds `{ year: \"numeric\", month: \"short\", day: \"numeric\" }` every time and only adds `timeZone: \"UTC\"` when local is false. Nothing ever omits the year. It is called by playedOnLabel (986/987), epRow (8028), archivedRow (8078) and the episode page (8475). The finding's line numbers are off by a few but the call sites are right. In epRow the date goes straight into the row's second line through joinMeta(show, duration, date, progress), so users see \"Show · 1h 5m · Sep 12, 2026\" even for recent episodes. The long comment on fmtDate explains only why dates use UTC and why played-on dates use local time. It says nothing about keeping the year. docs/DECISIONS.md also has no ruling on date or year formatting: grepping for year, date format and fmtDate finds only unrelated hits. So the year looks like a leftover default, not a deliberate choice, and it has not been fixed. I did not check the finding's claim that the extra \", 2026\" pushes the progress label onto a new line on phones, and it may be overstated. This is cosmetic only, a difference from Apple Podcasts conventions, so severity is low.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## persist-1 — Delete my data rotates the Supabase refresh token without saving it, so a remote failure strands the account: retry can never succeed and the next sync silently mints a new identity

**confirmed** · verifier severity **high** (finder: high) · persist · `app.js:11531` · L5-boot-states-storage

```json
{
  "id": "persist-1",
  "lens": "persist",
  "title": "Delete my data rotates the Supabase refresh token without saving it, so a remote failure strands the account: retry can never succeed and the next sync silently mints a new identity",
  "file": "app.js",
  "line": 11531,
  "severity": "high",
  "user_visible": "Open the app after an hour or more (access token expired), tap Delete my data, and one of the eight DELETEs times out or 5xxs on a cell connection. The sheet says \"Your server rows were NOT deleted. Nothing on this device was touched, so you can try again.\" Try again later and it fails again (401), forever. Meanwhile the next pick/thumbs sync creates a NEW anonymous account, so the old rows (thumbs notes included) become unreachable by anyone — the exact outcome §7 of the privacy policy says the remote-before-local ordering prevents.",
  "evidence": "app.js:11525-11546 `existingAnonSession()`: `if (s.refresh_token) { const r = await sbAuth(\"/auth/v1/token?grant_type=refresh_token\", ...); if (r && r.access_token) { return { user_id: ..., access_token: r.access_token, refresh_token: r.refresh_token || s.refresh_token, ... }; } } return s;` — the refreshed session is returned but never `lsSet(\"cp_sb_session\", ...)`. Compare `ensureAnonSession()` app.js:300-317, which does `lsSet(\"cp_sb_session\", s)` after its refresh and, when a refresh fails, falls through to `sbAuth(\"/auth/v1/signup\", {})` — a fresh account. Supabase Auth rotates refresh tokens on use (single-use, with a short reuse interval, 10 s by default), so after a `remote-failed` run the stored `cp_sb_session` holds a consumed refresh token; `deleteMyData` app.js:11916-11921 returns with the device untouched and the rotated session discarded.",
  "why_subtle": "The round-1 fix made the ordering rule (server rows first, device untouched on failure) the centre of the design, and the code comment even describes the refresh. The token rotation happens server-side and is invisible in a fake-fetch test; it only bites when the access token has expired, which is the ordinary next-day case rather than the test's fresh session.",
  "fix_sketch": "Persist the refreshed session the moment it arrives: in `existingAnonSession()` call `lsSet(\"cp_sb_session\", refreshed)` before returning it (or reuse `ensureAnonSession`'s refresh branch with a `noSignup` flag). Additionally keep the refreshed session in a module variable so the retry after `remote-failed` uses it even if the write was refused. Pin with a test: refresh → one table fails → stored session equals the refreshed one, and a second run issues DELETEs with the new bearer.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order consequence of the round-1 'remote before local' rule (qa 157/183 area)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read app.js at origin/main (latest commit 9730b5b, #746) and the code matches the evidence. existingAnonSession() at lines 11525-11546 takes the stored cp_sb_session. If the access token has expired, it POSTs /auth/v1/token?grant_type=refresh_token. On success it returns a new object with the rotated refresh_token but never calls lsSet(\"cp_sb_session\", ...). By contrast, ensureAnonSession() at 300-317 does persist its refresh with lsSet at line 308. deleteRemoteData() at 11577 uses that unsaved session for the table DELETEs. If any table fails, deleteMyData at 11916-11921 returns state \"remote-failed\" and leaves the device alone, so localStorage still holds the old refresh token, which the refresh call already used up. Supabase Auth rotates refresh tokens by default, with about a 10 s reuse interval. A retry after that window is likely to fail: the refresh fails, existingAnonSession falls back to the stale session (`return s`), the expired bearer gets 401 on every table, and the result is remote-failed again. The next trySyncEvents (line 371) calls ensureAnonSession, whose refresh also fails, so it falls through to /auth/v1/signup and silently creates a new anonymous user. The old rows are then out of reach, which is exactly what the \"REMOTE BEFORE LOCAL\" comment block (11491-11496) promises cannot happen. The precondition is common: sync runs only when unsynced events exist, so the stored token has often expired by the time a user opens Delete my data. docs/DECISIONS.md has no ruling covering refresh persistence in the deletion path, and the latest app.js commits do not fix it. Two caveats: this assumes the project keeps Supabase's default refresh-token rotation, and a retry inside the reuse window may still work. It needs a partial remote failure to trigger, but the result is an irreversible privacy-promise failure that the user cannot see, so I am keeping it at high.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-2 — A finished deletion re-renders Home, which writes cp_playlists back into every tier and pops the first-time onboarding sheet over the "Done. This device is clear." message

**confirmed** · verifier severity **medium** (finder: medium) · persist · `app.js:11949` · L5-boot-states-storage

```json
{
  "id": "persist-2",
  "lens": "persist",
  "title": "A finished deletion re-renders Home, which writes cp_playlists back into every tier and pops the first-time onboarding sheet over the \"Done. This device is clear.\" message",
  "file": "app.js",
  "line": 11949,
  "severity": "medium",
  "user_visible": "Type DELETE, tap Delete everything. Before you can read the result, the first-time explainer sheet slides up on top of the delete sheet (the app now looks like a brand-new install with no history, saves or playlists). Dismiss it and you find \"Done. … This device is clear.\" underneath — while `cp_playlists` (`[]`) and, after the dismissal, `cp_intro_dismissed` are already back in localStorage, IndexedDB and the native Preferences store.",
  "evidence": "app.js:11948-11949 `paintDeletion(out); route();` runs inside the `try`, before `finally { ddBusy = false }`. `route()` → `renderCurrentPage()` → `renderHome()` → `renderHomeV2()`, which at app.js:7662 calls `playlists()`; app.js:1756-1790: `let all = lsGet(\"cp_playlists\", null); ... if (all === null) { all = lsGet(\"cp_quests\", []); touched = true; } ... if (touched) lsSet(\"cp_playlists\", all);` — so an emptied store writes `[]` straight back. Then app.js:7900 `if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();` with `isGenuineFirstTimeUser()` (app.js:4700-4706: no history, no saves, no playlists) true and `cp_intro_dismissed` gone (app.js:5266-5268), so `openSheet(wrap, ...)` stacks the explainer over `#dd-sheet`, whose `closeDeleteSheet` refuses while `ddBusy`. The deletion comment at app.js:11930-11931 only guards `buildCards()`. test/data-deletion.test.js:284 parks `init()` on a never-settling fetch, so `state.ready` is false and `route()` returns at its first line — the write-back test at :939 cannot see either effect.",
  "why_subtle": "Two round-1 fixes collide: the onboarding gate now keys off 'no trace of prior use', which is precisely the state a deletion produces, and the re-render was added so a stale resume rail does not linger. Each is right alone; together they turn the one moment the listener most wants confirmation into an unrelated welcome sheet.",
  "fix_sketch": "(1) `playlists()`: set `touched` only when the legacy `cp_quests` array is non-empty, so an absent key is not materialised as `[]`. (2) In `deleteMyData`, either close the delete sheet before `route()` (and show the result as a toast), or re-render with an option that suppresses onboarding (`renderHome({ onboarding: false })`) and let the next real navigation show it. (3) Extend the data-deletion test to run with `state.ready = true` and a real `renderHome()`, asserting no `cp_` key and no second sheet after `route()`.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of persona 23 / qa 183 interplay (onboarding gate vs deletion re-render); new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main at 9730b5b, and the code matches the finding. In deleteMyData, app.js:11948-11949 runs `paintDeletion(out); route();` inside the try, before `finally { ddBusy = false }`. route() (12813) only calls closeAllSheets() when the hash has changed. Its own comment says a finished deletion re-renders the page \"UNDER an open sheet on purpose\", so #dd-sheet stays open, and renderCurrentPage() then runs. On Home, that is renderHome() → renderHomeV2() (7887). renderHomeV2 calls playlistsForYouHtml, which calls playlists() (7845), and isGenuineFirstTimeUser (4700) calls playlists() as well. In playlists() (1756-1790), an absent cp_playlists falls back to `lsGet(\"cp_quests\", [])` and sets touched=true, so `lsSet(\"cp_playlists\", [])` writes the key straight back. The finding says it reaches every tier; I only checked lsSet, which writes to storageBackend(). At 7900, `if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();` runs next. After the wipe there is no history, no saves and no playlists, and cp_intro_dismissed is gone, so showFirstTimeExplainerOnce builds #first-time-sheet and calls openSheet. openSheet (5093) only de-duplicates by the same element or the same id, so the explainer stacks on top of #dd-sheet. Dismissing the explainer writes cp_intro_dismissed (5291). The deletion comment at 11930 only rules out buildCards(). I found no ruling in docs/DECISIONS.md covering this interaction, and nothing on main has fixed it. It only happens when the user deletes while on Home, and that is the likely case because the delete control lives in the global drawer. I did not open the test file myself to check the claim about test coverage. I'm rating it medium because it defeats the \"This device is clear\" promise with a leftover `[]` (no actual data) and hides the result under a first-time onboarding sheet.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-3 — The privacy policy contradicts index.html and data-safety.md on the CSP origin count, on who sees Shows searches, and on whether the search upload is miss-only

**confirmed** · verifier severity **medium** (finder: medium) · persist · `docs/legal/privacy-policy.md:353` · L5-boot-states-storage

```json
{
  "id": "persist-3",
  "lens": "persist",
  "title": "The privacy policy contradicts index.html and data-safety.md on the CSP origin count, on who sees Shows searches, and on whether the search upload is miss-only",
  "file": "docs/legal/privacy-policy.md",
  "line": 353,
  "severity": "medium",
  "user_visible": "A listener reading §5 is told the browser structurally blocks any data leaving except to 'two origins', and §4.3 names GitHub as the only host serving the app. In fact every keystroke-settled Shows query (plus IP and user-agent) goes to a third origin on Vercel, which the policy never names as a party. data-safety.md, which the policy says must be changed in the same PR, says the opposite of §2 about when a query is sent.",
  "evidence": "privacy-policy.md:353-354: \"`connect-src` names only two origins — the app's own, and our Supabase project\". index.html:35: `connect-src 'self' https://qjdllvqdcgacvujhclny.supabase.co https://foray-web-seven.vercel.app`. data-safety.md:57-59 already says \"plus our own API origin (`https://foray-web-seven.vercel.app`, the Vercel project ...)\". privacy-policy.md:204-208: \"There is no 'only if we cannot find it locally' condition; the previous wording said there was, and the code never had one.\" versus data-safety.md:97 and :287: \"when a search misses the local catalogue it looks the query up against a shard/index off-device ... that miss-only lookup\". privacy-policy.md:345-347 lists GitHub Pages as the page host and no Vercel. The `cp_diag` row (policy :119) also omits row kinds the ring now stores — search rows with `qLen`/local hit counts/timings (diagnostic-log.js:1629-1640), now-playing, remote-command and native session rows.",
  "why_subtle": "The policy is unusually honest and detailed, which makes a stale structural claim more misleading than a vague one; the two legal files were written to move together and now disagree in the paragraph a reviewer would quote.",
  "fix_sketch": "Reconcile the three documents: §5 'three origins' naming the API origin as a processor that sees the query text and IP; §4.3 add Vercel; data-safety rows 97/287 drop 'miss-only'; refresh the cp_diag row. Add a tripwire test that parses `connect-src` from index.html and fails when the origin count differs from the number the policy states (the repo already pins cp_ key documentation this way in test/data-deletion.test.js).",
  "suspected_deliberate": false,
  "relation_to_round1": "new (round 1 did not audit the legal docs against index.html)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this at origin/main 9730b5b and it holds.\n\n- **CSP origin count:** privacy-policy.md §5 says \"`connect-src` names only two origins — the app's own, and our Supabase project\". But index.html:35 lists three: 'self', the Supabase project and https://foray-web-seven.vercel.app. app.js:280 sets API_ORIGIN to that Vercel URL. data-safety.md:57-59 already names this third origin.\n- **Search upload:** policy §2 (around lines 200-208) says Shows search text is sent to API_ORIGIN every time, with no \"only if we cannot find it locally\" condition. data-safety.md still calls it a lookup that happens only when a search misses the local catalogue (\"miss-only\") in two rows: the Play in-app search-history row and the Apple Search History row. The two documents contradict each other.\n- **Page host:** §4.3 names only GitHub Pages as the host. The policy refers to the server only as `app.js:API_ORIGIN` and never names Vercel. It does admit that the search text leaves the device, so the reader is not fully misled, but the structural claim in §5 is false.\n\nThe only related ruling in DECISIONS.md is an older entry (around line 1096) that deliberately did not widen connect-src at the time. It does not support the current \"two origins\" wording, so this is not deliberate.\n\nI did not verify the cp_diag sub-claim line by line. It is minor.\n\nSeverity is medium: this is a factual misstatement in a public legal document plus an internal contradiction, not a hidden data flow.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-4 — The Shows-search shard cache is keyed by what you typed and survives Delete my data, and neither it nor the Foray-directory database is in the policy's inventory

**confirmed** · verifier severity **low** (finder: medium) · persist · `app.js:5943` · L5-boot-states-storage

```json
{
  "id": "persist-4",
  "lens": "persist",
  "title": "The Shows-search shard cache is keyed by what you typed and survives Delete my data, and neither it nor the Foray-directory database is in the policy's inventory",
  "file": "app.js",
  "line": 5943,
  "severity": "medium",
  "user_visible": "Nothing on screen. After Delete my data reports \"This device is clear\", Cache Storage bucket `foray-shows-index-v1` still holds one entry per two-letter prefix of the longest word the listener ever searched for in Shows (e.g. `shards/jo.json`, `shards/se.json`), readable in DevTools/site data — a trace of the listener's searches that the deletion did not touch and the policy does not mention.",
  "evidence": "app.js:5884 `const SHARD_CACHE_NAME = \"foray-shows-index-v1\";` app.js:5941-5947 `writeShardToCacheStorage(shardKey, rows, version)` → `cache.put(\\`shards/${shardKey}.json\\`, ...)`; app.js:6825 `const shardKey = SearchEngine.shardKeyForQuery(query);` search-engine.js:2282-2288: `const prefix = longest.length >= 2 ? longest.slice(0, 2) : ...; return normalizeShardPrefixKey(prefix);`. `clearLocalData()` app.js:11603-11633 purges only the `cp_` tiers and `foray_events`. privacy-policy.md:133-138 lists only `foray-gen-*`, `foray-pointer`, `foray-pending`; :457-459 says only the `foray-gen` buckets are untouched. test/data-deletion.test.js:1393-1394 records `idb:foray-directory` and `cache:foray-shows-index-v1` as deliberately kept ('public show-search index shards').",
  "why_subtle": "The cached content is public data, so the test's 'kept' rationale reads as correct; what is listener-derived is the selection of entries, which only becomes visible when you think about the cache as a set rather than as its contents.",
  "fix_sketch": "In `clearLocalData()` add `await caches.delete(SHARD_CACHE_NAME)` (it is a cache; losing it costs one re-fetch) and update the test's kept-list; list `foray-directory` (public, kept) and the shard cache in policy §1 and §7 either way.",
  "suspected_deliberate": true,
  "relation_to_round1": "new; extends qa 157 (a second store the deletion left behind)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read every cited line at origin/main and the evidence holds. app.js:5884 sets SHARD_CACHE_NAME = \"foray-shows-index-v1\". writeShardToCacheStorage (app.js:5941-5947) does cache.put(`shards/${shardKey}.json`, ...). app.js:6825 gets the key from SearchEngine.shardKeyForQuery(query), which (search-engine.js:2282-2288) takes the first two letters of the longest token the listener typed. clearLocalData (app.js:11603) only clears diagnostics, runs clearStoredKeys (the cp_ tiers) and clears the event log. It never calls caches.delete on the shard bucket and never touches the foray-directory database.\n\nThe privacy policy is at docs/legal/privacy-policy.md, not privacy-policy.md, but the claim still holds. §1 (around lines 133-138) lists only the foray-gen-*, foray-pointer and foray-pending caches. The §7 note (around line 457) says only the foray-gen buckets are left alone. Neither the shard cache nor foray-directory appears anywhere in the policy.\n\nKeeping the stores is a choice the repo made on purpose: the STORE_LEDGER in test/data-deletion.test.js:1393-1394 marks both as kept, with reasons (\"public show-search index shards\", \"published Foray documents, identical for every listener\"). I found no docs/DECISIONS.md ruling on this. The ledger only covers keeping the stores. It does not explain why the policy leaves them out, and that omission is a real documentation gap.\n\nI rate it low rather than medium:\n- The trace is tiny. It is a two-letter prefix of the longest word searched, it holds only public index rows, and many different searches land in the same shard.\n- The same prefix already goes to the server as a network request, which the policy's Shows-search section already discloses.\n- The more sensitive store, cp_shard_shows (shows the listener opened), is a cp_ key and does get deleted.\n\nWhat still stands is a small leftover trace after the screen says \"This device is clear\", plus the policy's incomplete list of stores. The suggested fix is cheap: call caches.delete(SHARD_CACHE_NAME) in clearLocalData and update the ledger, and name both stores in policy §1 and §7.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-5 — After Delete my data the diagnostics record comes back carrying the pre-deletion row count and the exact time of the deletion

**confirmed** · verifier severity **low** (finder: medium) · persist · `player/diagnostic-log.js:495` · L5-boot-states-storage

```json
{
  "id": "persist-5",
  "lens": "persist",
  "title": "After Delete my data the diagnostics record comes back carrying the pre-deletion row count and the exact time of the deletion",
  "file": "player/diagnostic-log.js",
  "line": 495,
  "severity": "medium",
  "user_visible": "Delete my data, then pocket the phone (or play anything). Open Developer → Playback diagnostics: the header reads e.g. `recorded 940 · cleared at #939 14:07:31 · 1 recorded since`. The record — which the founder copies into GitHub issues — now states how much activity preceded the deletion and precisely when the listener deleted their data, on a device the app just called clear and for an action the policy says is 'deliberately not logged'.",
  "evidence": "player/diagnostic-log.js:495-508 `clear() { this._load(); this._cleared = { seq: this._seq, wall: this._now() }; this._entries = []; ... }` keeps `_seq` and `_build` on purpose (comment :486-493). player/client.js:530 `window.forayForgetDiagnostics = () => { diagLog.clear(); diag.reset(); return true; };` — the same clear as the founder's button at :517. app.js:11612 calls it from `clearLocalData()`. The next row is automatic: player/client.js:384 `document.addEventListener(\"visibilitychange\", () => diag.visibility(document.hidden === true));` → `record()` → `save()` writes `_blob()` (:404-426) with `seq`, `cleared` and `build`; the report prints it at :2098 `cleared at #${cleared.seq} ${clockOf(cleared.wall)} · ${since} recorded since`. privacy-policy.md:129-131: \"The deletion itself is deliberately not logged\".",
  "why_subtle": "The 2026-09-23 'the fact of the clear survives' fix was written for the founder's Clear button and is correct there; the deletion path reuses it because both were one-liners on the same object. Nothing fails, the key really is absent right after the purge, and the leak appears only on the next background transition.",
  "fix_sketch": "Give `forayForgetDiagnostics` its own method — `DiagnosticLog.forget()` — that resets `_seq = 0`, `_dropped = 0`, `_cleared = null`, `loadError = null`, keeps `_build`, and removes the key; leave `clear()` (the founder's clear-drive-copy loop) as it is. The two window bridges already exist for exactly this distinction; only the implementation is shared.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order between the 2026-09-23 cleared-mark fix and the round-1 forget-on-delete fix",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the code is as the finding describes. player/diagnostic-log.js:495-508: `clear()` sets `_cleared = { seq: this._seq, wall: this._now() }`, empties the entries, removes the storage key, and leaves `_seq` and `_build` in memory on purpose. `_blob()` (:404-426) writes `seq` and `cleared`, and the report prints them at :2098 as `cleared at #${cleared.seq} ${clockOf(cleared.wall)} · ${since} recorded since`. player/client.js:527 makes `forayForgetDiagnostics` the same `diagLog.clear(); diag.reset()` call as the founder's `forayDiagnosticClear` at :515. app.js:11612 calls it from `clearLocalData()`. The page does not reload after the deletion (app.js:11924-11950 only resets state and calls `route()`), so the in-memory `_seq` and `_cleared` survive. The next `diag.visibility()` row (client.js:384) calls `save()` and writes the key back with the pre-deletion count and the deletion's clock time.\n\nNo DECISIONS.md ruling covers this. The 2026-09-23 comments explain why the cleared mark exists for the founder's clear-drive-copy loop, not why a data deletion should keep it. The client.js:520-526 comment calls it \"the same clear\" but never considers the mark. This is second-order from #746 and has not been fixed.\n\nWhy I rate it low rather than medium:\n- The privacy-policy line \"The deletion itself is deliberately not logged\" (docs/legal/privacy-policy.md:130, not the root privacy-policy.md the finding cites) sits in the paragraph about the event queue.\n- cp_diag is a device-local ring the listener sees only under Developer → Playback diagnostics, and it is not synced.\n- What comes back is a counter and a clock time, not activity content.\n\nStill, a `cp_` key the deletion promised to empty reappears holding facts about the deleted activity. The fix sketch (a separate `forget()` that resets `_seq`, `_dropped`, `_cleared` and `loadError`) is sound.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-6 — The native Preferences copy of every cp_ row (including the auth token) rides platform backups, contradicting 'never leaves the device' and undoing Delete my data on a restore

**confirmed** · verifier severity **medium** (finder: medium) · persist · `player/durable-store.js:269` · L5-boot-states-storage

```json
{
  "id": "persist-6",
  "lens": "persist",
  "title": "The native Preferences copy of every cp_ row (including the auth token) rides platform backups, contradicting 'never leaves the device' and undoing Delete my data on a restore",
  "file": "player/durable-store.js",
  "line": 269,
  "severity": "medium",
  "user_visible": "On iPhone/Android the third copy of `cp_sb_session`, interests, history and positions sits in UserDefaults/SharedPreferences, which iCloud/iTunes backup and Android Auto Backup include by default. A listener who deletes their data, then restores the phone from a backup (new device, reset), comes back holding the deleted account's token — the app re-attaches to the old anonymous account instead of creating a new one, which §3/§7 promise it never does.",
  "evidence": "durable-store.js:250-294 `preferencesTier(bridge)` writes every owned key through `@capacitor/preferences` (`call(\"set\", { key, value })`), including `cp_sb_session` (durable-store.js:83-84 names it as a row this tier protects). privacy-policy.md:64-68: \"a third copy, in the app's own preferences store (iOS `UserDefaults`, Android `SharedPreferences`) ... It holds the same `cp_` rows and never leaves the device\"; data-safety.md:397: \"On-device only\". Capacitor's Android template ships `android:allowBackup=\"true\"` and mobile/android is generated rather than committed (mobile/capacitor.config.json has no backup rules), so nothing in the repo excludes `CapacitorStorage.xml`; iOS UserDefaults are in the app container that device backups capture. Not verifiable in-repo; flagged as a policy-accuracy risk.",
  "why_subtle": "The tier was added on 2026-09-22 to defeat WebView storage sweeps; 'not evictable' was the whole point, and 'not backed up' is the same property viewed from the other side. Only the legal text makes the second claim.",
  "fix_sketch": "Decide and state it: either exclude the Preferences suite from backup (Android `dataExtractionRules`/`fullBackupContent` excluding `CapacitorStorage`; iOS: move the token to Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` via a tiny plugin, or accept the backup and say so), or amend §1/§7 and data-safety.md:397 to say the copy is included in the listener's own device backups and a restore re-attaches the account.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; follow-on to qa 172 (native tier wired)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the evidence holds. In player/durable-store.js, preferencesTier(bridge) (around lines 250-294) writes every owned cp_ key through the Capacitor Preferences plugin with call(\"set\", {key, value}). The header comment names cp_sb_session among the rows this tier protects. docs/legal/privacy-policy.md lines 64-68 say the third copy \"holds the same cp_ rows and never leaves the device\". docs/legal/data-safety.md line 397 says \"On-device only. ... nothing new is transmitted.\"\n\nNothing in the repo excludes anything from backup. A git grep for allowBackup, fullBackupContent, dataExtractionRules, ExcludedFromBackup, icloud and backup across .github, mobile, tools/mobile, docs/legal and docs/DECISIONS.md returns nothing. mobile/android and mobile/ios are not committed, and mobile/capacitor.config.json has no backup settings. So the default Capacitor template, with allowBackup=\"true\", and the iOS default of backing up the app container are what ship.\n\nNo DECISIONS.md ruling covers backups, so this is not deliberate.\n\nThe re-attach scenario is real. deleteMyData in app.js (line 11883) runs deleteRemoteData() and then clearLocalData(). It never calls signOut or revokes the refresh token. So the token in a pre-deletion backup is still valid after a restore, and the app re-attaches to the old anonymous account. That contradicts privacy-policy §3 and §7, which say a deletion \"cuts the link\" and the app never re-attaches.\n\nOne correction to the finding: the Preferences copy is not the only one in the backup. On both platforms the WebView's localStorage and IndexedDB also sit in the app data container, and backups capture that too. The fix therefore has to cover all three tiers, for example by revoking the session server-side on deletion or excluding app data from backup, or the policy has to be amended. Excluding only CapacitorStorage would not be enough.\n\nSeverity is medium. The false statement is in store-facing legal copy (the privacy policy and the Play data-safety answer). The listener-facing effect is narrow, because it needs a device restore from a backup taken before the deletion, and the old account has no rows left by then.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-7 — 'Clear this device only' destroys the only credential to the server rows without saying they become permanently undeletable

**confirmed** · verifier severity **low** (finder: low) · persist · `app.js:11811` · L5-boot-states-storage

```json
{
  "id": "persist-7",
  "lens": "persist",
  "title": "'Clear this device only' destroys the only credential to the server rows without saying they become permanently undeletable",
  "file": "app.js",
  "line": 11811,
  "severity": "low",
  "user_visible": "After a remote failure the sheet offers \"Clear this device only\". Tapping it ends with \"Your rows on our server were left in place, as you chose. This device is clear.\" — true, but it does not say that the token that could ever delete those rows was just erased, so 'try again when you are online' is no longer possible; the rows are now in the policy's 'rows nothing can ever reach again' category.",
  "evidence": "app.js:11808-11813 button text \"Clear this device only\" with comment 'states the cost on its own face'; app.js:11721-11722 `remote.deviceOnly ? \"Your rows on our server were left in place, as you chose.\"`; app.js:11913-11914 device-only skips `deleteRemoteData()` and `clearLocalData()` then purges `cp_sb_session` with everything else. privacy-policy.md:428-430 says the sheet 'says plainly that the server rows remain' — it does not say they become unreachable; :446-449 explains exactly that consequence for the browser's site-data screen.",
  "why_subtle": "Every sentence in the sheet was rewritten for honesty in round 1; this one is honest about what happened and silent about what it forecloses.",
  "fix_sketch": "Change the line to \"Your rows on our server were left in place and can no longer be deleted from this device.\" (≤18 words) and, in the button's sub-copy, say the same before the tap. Alternatively keep only `cp_sb_session` on device-only clears so a later full deletion can still reach the rows, and say so.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends qa 183 (deletion copy)",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. The only thing shown before the tap is the button label \"Clear this device only\" (app.js:11811). It has no sub-copy, and the status line above it is the remote-failed message: \"Your server rows were NOT deleted. Nothing on this device was touched, so you can try again.\" (11719). deleteMyData({deviceOnly:true}) skips deleteRemoteData() (11913-11914) and then runs clearLocalData() (11603), which clears every cp_ key and so destroys cp_sb_session. The code's own comment at 11491-11494 calls that token \"the only credential that can delete the server rows\" and says losing it strands \"rows nothing can ever reach again\". The success message after the tap is \"Your rows on our server were left in place, as you chose. This device is clear.\" (11721-11722, 11726). It never says those rows can no longer be deleted. Worse, the \"so you can try again\" line just above the button now misleads. docs/legal/privacy-policy.md:428-430 says only that the sheet \"says plainly that the server rows remain\". The unreachability consequence is explained only for the site-data path (446-449). docs/DECISIONS.md has no ruling covering this wording, so it is not deliberate. The user does see this: the button is shown whenever state === \"remote-failed\" (11960). Severity is low: the result is an honest-copy gap, not data exposure. The server rows hold no name, email, phone number or password, and the user did choose to leave them in place, but not knowing the choice cannot be undone.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-8 — An event sync in flight when Delete is tapped is not gated by dataDeletionInProgress and can re-plant the old cp_sb_session on the cleared device

**confirmed** · verifier severity **low** (finder: low) · persist · `app.js:365` · L5-boot-states-storage

```json
{
  "id": "persist-8",
  "lens": "persist",
  "title": "An event sync in flight when Delete is tapped is not gated by dataDeletionInProgress and can re-plant the old cp_sb_session on the cleared device",
  "file": "app.js",
  "line": 365,
  "severity": "low",
  "user_visible": "Rare: thumbs an episode (sync starts), then immediately Delete my data. If the sync's `ensureAnonSession()` refresh resolves after the purge's verification pass, `cp_sb_session` for the OLD account is written back into every tier on a device the sheet has just called clear, so the next event re-attaches to the deleted account rather than a new one; its POST can also land after the `events` DELETE.",
  "evidence": "app.js:365-395 `trySyncEvents()` has no `dataDeletionInProgress` check; app.js:300-317 `ensureAnonSession()` does `lsSet(\"cp_sb_session\", s)` after a refresh or signup; the flag at app.js:225-228 gates only `logEvent`. `clearLocalData()` app.js:11623-11632 sets the flag only around the purge, and `deleteMyData` does not await any in-flight sync. Triggers: app.js:2194 (auto-advance play), :4495 (pick), :4572, :9201 (thumbs), :13959 (boot).",
  "why_subtle": "The round-1 fix added the flag for the fault-sink loop it had measured; the sync path writes the same key through a different door and only overlaps by timing.",
  "fix_sketch": "Keep the in-flight sync promise in a module variable; `deleteMyData` awaits it before `deleteRemoteData()`. Early-return in `trySyncEvents` and `ensureAnonSession` while `dataDeletionInProgress || ddBusy`, and make `clearLocalData` set the flag before `stopForDataDeletion` rather than after the server step.",
  "suspected_deliberate": false,
  "relation_to_round1": "extends the 2026-09-23 dataDeletionInProgress fix",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main app.js and the code matches the finding. `trySyncEvents()` (app.js:365-395) never checks `dataDeletionInProgress` or `ddBusy`. `ensureAnonSession()` (300-317) calls `lsSet(\"cp_sb_session\", s)` without condition after a successful refresh or signup. The flag is set only inside `clearLocalData()` (11623-11632), after `stopForDataDeletion` and `deleteRemoteData()` have already run. `logEvent` is the only thing it gates. `deleteMyData()` (11883-11955) keeps no handle on an in-flight sync and does not wait for one. The trigger call sites at 2194, 4495, 4572, 9201 and 13959 exist. docs/DECISIONS.md has no ruling that accepts this race. Its only mention of trySyncEvents is about how local-only event types are dropped. The comment in deleteMyData says no new anonymous identity should be created after a deletion, which suggests the gap is an oversight, not a design choice.\n\nWhy the severity is low and the bug is very rare: `deleteConfirmed()` makes the user type \"DELETE\" before the button is armed. That means a sync started by a thumbs or a pick is several seconds old before the deletion even begins. Then `deleteRemoteData` runs one DELETE request per table before the purge. For `cp_sb_session` to be written back after the purge, the sync's refresh or signup request (a plain fetch with no timeout) has to stay hung for that whole time and then succeed. The refresh path also needs the token to be within about 60 seconds of expiry. When it does happen, the effect is real: the old account's session is re-planted on a device the sheet has just called clear, or a late events POST recreates rows under the deleted account. Two smaller corrections to the finding. The boot trigger (13959) can't realistically overlap a deletion. And the auto-advance trigger is partly covered, because `stopForDataDeletion` runs first, but that does nothing to a sync already in flight. The fix sketch is sound.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## persist-9 — cp_pos:<id> rows are never pruned, and the native tier pays one bridge call per row on every launch

**confirmed** · verifier severity **low** (finder: low) · persist · `player/position-store.js:46` · L5-boot-states-storage

```json
{
  "id": "persist-9",
  "lens": "persist",
  "title": "cp_pos:<id> rows are never pruned, and the native tier pays one bridge call per row on every launch",
  "file": "player/position-store.js",
  "line": 46,
  "severity": "low",
  "user_visible": "Nothing today. Over months every episode ever opened for more than a moment leaves a permanent `cp_pos:<id>` row in all three tiers (the policy's 'position in an individual episode'), unlike `cp_history` (200), `cp_episode_snaps` (capped) and `cp_foray:` rows (aged out at 30 days). In the shell each launch's hydration issues one `Preferences.get` per row before the 5 s bound, so the mini-bar/Jump-back-in restore gets later as the collection grows, and `Delete my data` lists hundreds of keys.",
  "evidence": "position-store.js:19 `const KEY = (id) => \\`cp_pos:${id}\\`;`, :46-64 `save()` writes on every 15 s tick; `clear(id)` at :102-105 has no caller for ordinary episodes (player/client.js:1265 clears only `forayProgress`). foray-progress.js:47-50 `MAX_AGE_H = 24 * 30` exists for Foray rows only; `listProgress` filters stale rows but never removes them. durable-store.js:278-290 `readAll`: `const values = await Promise.all(owned.map((key) => call(\"get\", { key })));` — one round trip per key, every boot.",
  "why_subtle": "Each write is tiny and correct; the growth is invisible until a long-lived device, and the native tier's per-key read makes it a latency rather than a quota problem.",
  "fix_sketch": "On hydrate (or once per launch after `storageReady`), remove `cp_pos:` rows whose `updated_at` is older than 30 days, matching Foray progress; or fold positions into one `cp_positions` map with an LRU cap (a migration that copies, never deletes, per the store's property 1).",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n- **Key and write path:** player/position-store.js:19 builds the key as `cp_pos:${id}`. `save()` (lines 46-64) writes a record with `updated_at` on every call. It is called from queue-manager.js:2228 on every savePosition effect and 15 s tick.\n- **Nothing deletes old rows:** `PositionStore.clear(id)` (lines 102-105) has no caller anywhere in non-test player code. `git grep` finds only `forayProgress.clear(id)` at client.js:1265, and queue-manager only calls `save`, `load` and `resumeOffset`. No other code prunes `cp_pos:` rows. The 30-day `MAX_AGE_H` in episode-progress.js and foray-progress.js only hides stale entries when reading. Neither touches `cp_pos:`, and episode-progress.js:35 says outright that `cp_pos:` is \"one row per episode\".\n- **One bridge call per key on the native tier:** durable-store.js:278-290, `preferencesTier.readAll`, lists all keys, then runs `Promise.all(owned.map((key) => call(\"get\", { key })))`. That is one bridge round trip per key on every launch. Its own comment assumes \"a few dozen rows, once a launch\", and nothing enforces that bound. Hydrate waits on this with `HYDRATE_WAIT_MS = 5000` (client.js:279).\n- **Not a deliberate decision:** I found nothing in docs/DECISIONS.md or STATE.md that rules on keeping positions forever. docs/legal/privacy-policy.md:104 just lists `cp_pos:<id>` as a per-episode position.\n\nWhy only low severity:\n- Nobody notices it today.\n- The rows are tiny.\n- The per-key gets run in parallel, so a few hundred rows probably add tens of milliseconds, not seconds. The hydrate delay is plausible but not measured.\n- The \"Delete my data\" point is weak. It purges by prefix, so many keys cost it nothing visible beyond a longer inventory.\n\nIt is still a real unbounded-growth gap. Positions are the only per-item namespace with no cap or age-out, while the Foray and history stores have one.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## honesty-1 — Episode row prints the catalogue's duration_min while its own 'min left' and the player count against duration_sec — for 19 pool items these disagree by a minute or more, two by 5–9 minutes ('45 min · 53 min left')

**confirmed** · verifier severity **medium** (finder: high) · honesty · `app.js:8037` · L6-navigation-firstrun-copy

```json
{
  "id": "honesty-1",
  "lens": "honesty",
  "title": "Episode row prints the catalogue's duration_min while its own 'min left' and the player count against duration_sec — for 19 pool items these disagree by a minute or more, two by 5–9 minutes ('45 min · 53 min left')",
  "file": "app.js",
  "line": 8037,
  "severity": "high",
  "user_visible": "data/discover.json 'in-the-dark--blood-relatives-ep1' carries duration_min 45 but duration_sec 3581 (59:41). Its row reads '45 min'. Seven minutes in, the same row reads '45 min · 53 min left'; open it and the Now Playing sheet counts down from -59:41. 'this-american-life--blackout' is the reverse: row '63 min', player 54:19. 'conan-obrien--josh-groban': '67 min' vs 63:12. Across the shipped pool, 26 items have duration_min ≠ round(duration_sec/60) and 19 differ by ≥ 1 min.",
  "evidence": "app.js:8037 `joinMeta(showNameLink(item.show), fmtDur(item.duration_min), esc(dateStr), progHtml)` — the duration label reads duration_min. app.js:8009-8010 `const durSec = Number(item.duration_sec) > 0 ? Number(item.duration_sec) : (Number(item.duration_min) > 0 ? Number(item.duration_min) * 60 : null)` — the progress label on the SAME line reads duration_sec first. renderEpisode (8482), upNextRow (8554), archivedRow (8084) all print duration_min. Measured with node over data/discover.json: floorMatch 1071, roundMatch 2123 of 2149, off-by-≥1-min 19, off-by-≥5-min 2.",
  "why_subtle": "Both numbers are 'the duration'; the drift is per-item data rot from feeds that re-published with different ad loads, and it only shows as a contradiction once a listener has started the episode (the label and the countdown sit on one line).",
  "fix_sketch": "One source for a row's length: `episodeMinutes(item) = duration_sec > 0 ? Math.round(duration_sec/60) : duration_min` and have fmtDur callers use it; long-term, the pool builder should derive duration_min from duration_sec (or drop duration_min). Add a data gate in tools/ that fails when |duration_min − duration_sec/60| ≥ 1.",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Round 1 fixed the formatting of these labels (qa 109/147/182/184) and added the progress label (persona 78); it never compared the two sources.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked the code at origin/main and the evidence holds. In app.js, epRow calls `fmtDur(item.duration_min)` for the length label (near line 8037). On the same line, rowProgress reads `duration_sec` first (lines 8009-8010), and player/episode-progress.js:144 builds \"N min left\" from `record.duration_sec ?? duration_min*60`. The archived row, renderEpisode and the up-next row also print duration_min. I ran node over data/discover.json at origin/main: 2149 items have both fields, 2123 agree when duration_sec/60 is rounded, 19 differ by 1 minute or more, and 2 differ by 5 minutes or more. Those two are in-the-dark--blood-relatives-ep1 (duration_min 45, duration_sec 3581) and this-american-life--blackout (63 vs 3259). So one row can really show \"45 min · 53 min left\". The id 'conan-obrien--josh-groban' does not exist in discover.json under that name, so that example is wrong, but it does not change the finding. docs/DECISIONS.md has no ruling on duration_min versus duration_sec (the commute-length entry only says \"duration shown plainly\"), and nothing on main has fixed it. I lowered severity from high to medium. Only 2 of 2149 items are off enough to jump out. The other ~17 are off by 1-4 minutes, which is cosmetic. The player itself counts down from the real audio length, so playback is not affected; only the row's catalogue label is wrong.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## honesty-4 — The player's row-progress bridge prefers the catalogue's duration over the duration it measured off the media element — the opposite priority of the mini bar — so 'Played' / 'min left' on rows are computed against the number the same module calls less accurate

**confirmed** · verifier severity **low** (finder: medium) · honesty · `player/client.js:3087` · L1-player-transport

```json
{
  "id": "honesty-4",
  "lens": "honesty",
  "title": "The player's row-progress bridge prefers the catalogue's duration over the duration it measured off the media element — the opposite priority of the mini bar — so 'Played' / 'min left' on rows are computed against the number the same module calls less accurate",
  "file": "player/client.js",
  "line": 3087,
  "severity": "medium",
  "user_visible": "For a catalogue row whose duration_sec is stale (see the 26 drifted pool items), an episode listened to the end can sit at 'N min left' forever, or read 'Played' with 15 minutes of audio remaining ('in-the-dark--blood-relatives-ep1' is 45 min in the catalogue and 59:41 on tape: at 44:40 the row says Played while the sheet says -15:01).",
  "evidence": "player/client.js:3087-3092 `episodeProgress(id, durationSec = null) { const stored = positionReader().load(id); const dur = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : (…stored.duration…)` — the row's own number wins. player/client.js:1366-1374 `episodeDurationSec()` puts the element's duration first and the catalogue second. player/client.js:2970-2975 comment on the same store: 'read off the media element itself, so it is both more available and more accurate than a feed's itunes:duration'.",
  "why_subtle": "Only bites when the catalogue's number is wrong, which is exactly when nobody is looking at it; the code comment two hundred lines up already states the right priority.",
  "fix_sketch": "In the bridge, prefer `stored.duration` when present and fall back to the row's number; PositionStore.save already records the measured duration beside every position. One-line swap plus a test where stored.duration ≠ durationSec.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of persona 78 / qa 162 (qa 162 made the RESTORED bar fall back to the stored duration; the row bridge added for persona 78 inverted the priority).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code matches the finding. At origin/main, player/client.js:3087-3092 `episodeProgress(id, durationSec)` uses the row's durationSec whenever it is positive. It falls back to stored.duration (which PositionStore.save records from the media element) only when the row has no duration. app.js:8009 `rowProgress` passes item.duration_sec, or failing that duration_min*60, so the catalogue number wins whenever a row has one. `episodeDurationSec()` (client.js:1366-1374) puts the element's duration first, but only while the element holds that episode; before that it also puts the catalogue ahead of the stored duration. \"Jump back in\" (`lastEpisodeCard`, client.js:2977-2980) also prefers the catalogue. So the row bridge matches the card and the idle mini bar, and differs only from the bar during live playback. The bridge's own docstring says this order is intended (\"the row's own when it has one; the stored duration otherwise\"). No docs/DECISIONS.md ruling covers it, and no later fix exists.\n\nThe user-visible example is wrong. data/discover.json has 'in-the-dark--blood-relatives-ep1' with duration_min 45 but duration_sec 3581 (59:41). The app.js snapshot projection keeps duration_sec (app.js:657), and rowProgress prefers duration_sec, so that row is measured against 59:41. At 44:40 it would read about '15 min left', not 'Played'. The finding mixed up the stale duration_min with duration_sec.\n\nAcross discover.json (2167 items), only 2 have duration_sec and duration_min more than 5 minutes apart, and 18 have no duration_sec (those already fall back to the stored duration). So a row goes wrong only where the catalogue's duration_sec itself differs from the real tape length. The most plausible case is dynamic ad insertion changing the length (the example item is flagged dai_suspected), and I cannot quantify it from the repo. The mechanism is real and the one-line swap is reasonable, but the impact is much smaller than claimed and the headline repro does not happen. Severity: low.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## honesty-5 — The episode page and Up Next rows carry no 'Played' / 'NN min left' marker although every other episode row does

**confirmed** · verifier severity **medium** (finder: medium) · honesty · `app.js:8482` · L3-queue-and-native-surfaces

```json
{
  "id": "honesty-5",
  "lens": "honesty",
  "title": "The episode page and Up Next rows carry no 'Played' / 'NN min left' marker although every other episode row does",
  "file": "app.js",
  "line": 8482,
  "severity": "medium",
  "user_visible": "Tap a row that says '48 min · 12 min left' and the episode page under it says '48 min · Sep 12' — the progress vanished on the way in. The Up Next page lists the same episodes with no played state, so a half-finished queued episode looks fresh.",
  "evidence": "app.js:8482 `<p class=\"fp-s-show\">${joinMeta(item.show ? showNameLink(item.show) : \"\", fmtDur(item.duration_min), esc(dateStr))}</p>` — no rowProgress. app.js:8553-8557 upNextRow: `joinMeta(esc(item.show || \"\"), fmtDur(item.duration_min))` — no rowProgress. Compare epRow 8032-8037 which appends `progHtml` from `rowProgress(item)`.",
  "why_subtle": "persona 78's fix landed in epRow only; the two other row shapes look identical so the omission reads as 'this one just hasn't been played'.",
  "fix_sketch": "Reuse the same `rowProgress(item)` → `<span class=\"ep-progress\">` fragment in renderEpisode's meta line and in upNextRow; Apple Podcasts shows the progress bar on the episode page itself.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of persona 78 ('Nothing on any list tells me which episodes I already played').",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read app.js at origin/main and the finding holds. renderEpisode builds its meta line at 8482 as `joinMeta(item.show ? showNameLink(item.show) : \"\", fmtDur(item.duration_min), esc(dateStr))`, with no rowProgress. upNextRow (around 8553-8557) builds the live sub-line from `joinMeta(esc(item.show || \"\"), fmtDur(item.duration_min))` and the archived one the same way, also without rowProgress. rowProgress (8006) has three call sites: its definition, hasOpened (8021) and epRow (8029). Only epRow draws the `ep-progress` span; `ep-progress` appears nowhere else in the file. Nothing else on the episode page shows progress either. playBtn (737) is a plain ▶ with no 'Resume' or time-left label, and the page's bind calls are only pick logging, stars, Up Next, play and seeks. The rowProgress comment quotes the 'already played, or how far in I am' complaint, but it does not exempt the episode page or Up Next. docs/DECISIONS.md has no ruling that keeps progress off these surfaces. Its Up Next entries (2026-08-31) cover naming, the separate cp_queue key and auto-advance, not the played state. So it is not deliberate and not fixed: moving from a list row that says 'N min left' to the episode page drops the marker, and a half-played episode in Up Next looks unplayed. The gap is real and easy to see, but no data is lost and playback still resumes correctly, so medium is the right severity.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## honesty-6 — Playlist header's 'N played' counts episodes that were merely opened or are half-way through, directly above rows that say '42 min left' for those same episodes

**confirmed** · verifier severity **low** (finder: medium) · honesty · `app.js:8150` · L3-queue-and-native-surfaces

```json
{
  "id": "honesty-6",
  "lens": "honesty",
  "title": "Playlist header's 'N played' counts episodes that were merely opened or are half-way through, directly above rows that say '42 min left' for those same episodes",
  "file": "app.js",
  "line": 8150,
  "severity": "medium",
  "user_visible": "A 6-episode playlist where you tapped play on one for three seconds and stopped another half-way reads '6 episodes · playlist · 2 played' while none of its rows says Played (one says '31 min left', the other shows nothing). Apple Podcasts' 'played' means finished.",
  "evidence": "app.js:8150 `const played = rows.filter(r => hasOpened(r.item.id, history)).length;` and 8018-8023 `hasOpened(): if (history.has(id)) return true; const p = rowProgress({ id }); return !!p && p.state !== \"unplayed\";` — 'sampled' (position 1–9 s) and 'in-progress' both count. episode-progress.js comment: 'sampled — opened, not listened to… it is still counted as \"played\" by a caller counting what was opened.'",
  "why_subtle": "The fixer wrote the comment justifying 'opened = played' (qa 189), but the same screen's rows now use the stricter definition, so the two disagree in plain sight.",
  "fix_sketch": "Either count `p.state === \"played\"` only (and keep hasOpened for the 'next' marker), or change the word: '2 started' / '1 played · 1 in progress'. The header and the rows must use one definition of played.",
  "suspected_deliberate": true,
  "relation_to_round1": "Second-order interaction between the qa 189 fix (hasOpened) and the persona 78 fix (row labels).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code matches the finding. app.js:8150 is `const played = rows.filter(r => hasOpened(r.item.id, history)).length;`, and the header at 8159 renders it as `${played} played`. hasOpened (8018-8023) returns true when the id is in cp_history or when the stored position is anything other than \"unplayed\". In player/episode-progress.js:173-184, episodeProgress gives four states: \"sampled\" (position between 0 and MIN_RESUME_SEC, no label), \"in-progress\" (label \"NN min left\"), \"played\" (within NEAR_END_SEC of a known end, label \"Played\") and \"unplayed\". So sampled and half-finished episodes both count toward the header's \"N played\", while their rows show nothing or \"NN min left\". The header and the rows really do use two different meanings of \"played\". The same comment in episode-progress.js (lines 166-168) says sampled \"is still counted as 'played' by a caller counting what was opened\", so a developer knew the header counts \"opened\". That is only a code comment: docs/DECISIONS.md has no ruling on it, and the comment gives no reason for showing that count under the word \"played\" next to row labels that use the stricter meaning. It is not fixed. The mismatch goes back further than the persona-78 row labels: history.has(id) always counted any opened episode. The persona-78 labels made it visible by putting \"Played\" and \"NN min left\" on the rows. The fix is easy: rename the word (for example \"N started\"), or count only p.state === \"played\" plus history-finished. I set severity to low rather than medium. It is a wording and count inconsistency on one header line with no data loss or broken action, and a listener who compares the header with the rows can see what it means.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## honesty-7 — Home's Jump back in rail mixes three card grammars: Forays and episodes get a bar and 'N min left', playlists get only 'N episodes' with no progress

**confirmed** · verifier severity **low** (finder: low) · honesty · `app.js:7666` · L6-navigation-firstrun-copy

```json
{
  "id": "honesty-7",
  "lens": "honesty",
  "title": "Home's Jump back in rail mixes three card grammars: Forays and episodes get a bar and 'N min left', playlists get only 'N episodes' with no progress",
  "file": "app.js",
  "line": 7666,
  "severity": "low",
  "user_visible": "On Home, the Jump back in rail shows a Foray card with a bar and '32 min left', an episode card with a bar and '18 min left', and a playlist card with just '12 episodes' — nothing about where you are in it, though the playlist page itself knows ('3 played').",
  "evidence": "app.js:7663-7668 playlist entry: `title: p.title || p.name || \"Playlist\", sub: playlistLengthLabel(p),` — no percent, no left. Foray entry 7646-7650 and episode entry (lastEpisodeCard 7692-7694) both carry `percent` and `left`.",
  "why_subtle": "Three kinds of thing in one rail; the mismatch reads as a missing line rather than an inconsistency until the cards sit side by side.",
  "fix_sketch": "Compute `played / total` for the playlist entry via the same hasOpened/rowProgress the detail page uses and set `left: \"3 of 12 played\"` and `percent: Math.round(played/total*100)`, or the next unplayed part's title as `sub`.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and the finding holds. In jumpBackInEntries() (around line 7663), the playlist entry has only `title` and `sub: playlistLengthLabel(p)`. playlistLengthLabel at line 972 is just countLabel(resolveParts(p).length, \"episode\"), so the card shows \"N episodes\". The entry has no `percent` or `left`, so jumpBackInCardHtml draws no bar and no \"left\" text. The Foray entry and the lastEpisodeCard entry both pass `percent` and `left: label`.\n\nThe playlist detail page does compute progress: line 8159 renders `${played} played`, using the hasOpened/progress helper around lines 8015-8031, so the data exists and a fix is feasible.\n\nNo docs/DECISIONS.md entry covers progress on Jump back in cards. The comment block above the function explains why playlists were added to the rail on 2026-09-18 and why play buttons are episode-only. It says nothing about leaving out progress on purpose, so this is not deliberate.\n\nThe founder asked for playlists on the rail but did not specify a progress indicator, so this is a cosmetic inconsistency and low severity is right.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## honesty-8 — Incomplete fix of qa 55: 'N min left' is amber-bold on the Forays page and the Foray page but muted grey, regular weight on Home's Jump back in card

**confirmed** · verifier severity **low** (finder: low) · honesty · `styles.css:3823` · L7-styles-touch-visual

```json
{
  "id": "honesty-8",
  "lens": "honesty",
  "title": "Incomplete fix of qa 55: 'N min left' is amber-bold on the Forays page and the Foray page but muted grey, regular weight on Home's Jump back in card",
  "file": "styles.css",
  "line": 3823,
  "severity": "low",
  "user_visible": "The same '32 min left' for the same Foray is a bold amber label on #/forays and on the Foray page's resume banner, and a small grey caption on Home.",
  "evidence": "styles.css:3823 `body.ui-v2 .hv2-jbi-sub, body.ui-v2 .hv2-jbi-left, body.ui-v2 .hv2-playlist-sub { font-size: var(--fs-sm); color: var(--muted); }` vs 3562 `body.ui-v2 .fy-jbi-left { color: var(--amber); }` (and 3096 `font-weight: 700`) and 3074 `.fy-resume-left { color: var(--gold); font-weight: 700; }`.",
  "why_subtle": "qa 55 unified gold with amber; the Home v2 card was restyled in the visual pass with its own selector and quietly opted out.",
  "fix_sketch": "Give `.hv2-jbi-left` the same amber/700 treatment as `.fy-jbi-left` (the 'listener's own progress is amber' rule stated at styles.css:3560), leaving `.hv2-jbi-sub` muted.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 55.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the finding holds. Home's Jump back in card is built by jumpBackInCardHtml (app.js:7701-7705), which puts the label in `<span class=\"hv2-jbi-left\">`. The only rule for that class is styles.css:3823-3824, `body.ui-v2 .hv2-jbi-sub, body.ui-v2 .hv2-jbi-left, body.ui-v2 .hv2-playlist-sub { font-size: var(--fs-sm); color: var(--muted); }`. It sets no weight and no amber.\n\nThe #/forays page is different. renderForays calls jumpBackInHtml(resume) (app.js:7977-7981), which renders `.fy-jbi-left` (app.js:11016). That class is font-weight 700 (styles.css:3096) and amber under ui-v2 (styles.css:3562). The Foray page's resume line `.fy-resume-left` (app.js:9811) is `color: var(--gold); font-weight: 700` (styles.css:3074). Under ui-v2, styles.css:172 remaps `--gold: var(--amber)`, so that line is amber and bold too.\n\nThe styles.css:169-171 comment says every surviving --gold reader, including \"their 'N min left'\", is the listener's own material and so amber. The comment at 3555-3560 says the same for the rail. Home's card breaks the rule its own stylesheet states, even though the card's own progress bar (.fy-bar-fill) and kicker are amber. ui-v2 is the only UI, so every listener with a partly played Foray sees this.\n\nNo DECISIONS.md ruling covers it. The only amber/violet decision (line 332) supports the finding. Among the qa-findings-detail rows I found, the qa 55 fix (the gold-to-amber remap) covered .fy-resume-left and .fy-jbi-left and missed .hv2-jbi-left. The one qa-findings row that mentions .hv2-jbi-left only discusses the capitalisation of \"finished\", not its colour.\n\nThe issue is cosmetic: the same datum is styled differently across screens. Nothing breaks, so the severity is low.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## honesty-11 — Search tab's Episodes section is silently capped at 10 rows with no count and no 'more' while the show page's own search says 'N episodes found.'

**confirmed** · verifier severity **low** (finder: low) · honesty · `app.js:7430` · L4-search-create-playlists

```json
{
  "id": "honesty-11",
  "lens": "honesty",
  "title": "Search tab's Episodes section is silently capped at 10 rows with no count and no 'more' while the show page's own search says 'N episodes found.'",
  "file": "app.js",
  "line": 7430,
  "severity": "low",
  "user_visible": "Search 'history' on the Search tab: the Episodes section shows exactly 10 rows and stops, with nothing saying whether that is all of them (the endpoint measured 38+ behind it). Search inside a show and the note says '38 episodes found.'",
  "evidence": "app.js:7430 `fetchApiJson(\\`api/episodes/search?q=${encodeURIComponent(query)}&limit=10\\`)`; 7345 `<h3>Episodes${fromApple && !local.length ? \\` <span class=\"note\">from Apple's index</span>\\` : \"\"}</h3>` — no count, no link. The comment at 7418-7429 says the section's height 'is a layout decision with an owner'. Show-page search (3977): `${countLabel(scopedResults.length, \"episode\")} found.`",
  "why_subtle": "A list that stops at a round number looks complete; the comment records the shortfall being fixed on the endpoint side but leaves the claim on the client side unmade.",
  "fix_sketch": "Have the endpoint return a `total` (it already over-fetches) and print 'Showing 10 of 38' with a 'More' that re-asks with limit=50, or at least 'Top 10 matches'.",
  "suspected_deliberate": true,
  "relation_to_round1": "New; qa 73/98/177 covered the Shows half's notes, not the Episodes section's completeness.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main (9730b5b), and the finding holds.\n- The Search tab's episode pass asks `api/episodes/search?q=…&limit=10`, just above the `.then(`. The Episodes section renders `<h3>Episodes${fromApple && !local.length ? …\"from Apple's index\"… : \"\"}</h3>` and then the rows. There is no count, no \"top 10\" wording and no \"more\" link.\n- The comment above the fetch backs up the measurement: `history` returned 4 rows at a limit of 10 and 38 at a limit of 50. The endpoint now over-fetches and cuts to 10, so the section is always capped at 10 rows, and the listener is never told other matches exist.\n- The show page's search does say `${countLabel(scopedResults.length, \"episode\")} found.` (paintSearchNote, scoped mode). So the two searches are inconsistent, as the finding says.\n\nIs it deliberate? Only partly.\n- The comment says the 10 \"stays 10 deliberately\" and calls the section height \"a layout decision with an owner\". That keeps the number, but it points to an owner rather than recording a ruling.\n- docs/DECISIONS.md has no ruling on the length of the Episodes section or on showing a count or \"more\". codebase-audit-2026-09-14 §1.5 only covers the old shortfall (4 rows), which has since been fixed.\n- The finding does not ask to change the 10. It asks for a label saying there are more matches (\"Showing 10 of N\" or \"Top 10 matches\"), which the comment does not address.\n\nSeverity is low. Nothing is broken. It is a completeness and honesty gap in the copy on a secondary section.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## honesty-12 — Library's Forays section reads its 'N min left' from the Home rail's 3-row cap, so a fourth part-played Foray shows an empty subtitle, and a part-played draft loses its 'draft' tag

**confirmed** · verifier severity **low** (finder: low) · honesty · `app.js:8738` · L8-foray-surfaces

```json
{
  "id": "honesty-12",
  "lens": "honesty",
  "title": "Library's Forays section reads its 'N min left' from the Home rail's 3-row cap, so a fourth part-played Foray shows an empty subtitle, and a part-played draft loses its 'draft' tag",
  "file": "app.js",
  "line": 8738,
  "severity": "low",
  "user_visible": "With four Forays each part-played, Library lists five Forays: three carry 'NN min left', the fourth (also part-played) carries nothing, so it looks unopened. A draft you are half-way through shows '20 min left' and no longer says 'draft' there, though it does on #/forays.",
  "evidence": "app.js:8738 `const progress = new Map(forayResumeRows().map(p => [p.id, p.label]));` — forayResumeRows ends `.slice(0, 3)` (app.js:11006). 8741 `progress.get(f.id) || (f.status === \"published\" ? \"\" : \"draft\")` — the label replaces the tag rather than joining it.",
  "why_subtle": "The cap belongs to the rail's layout and was reused as a data source; it only shows with more than three Forays in progress, which the founder — the heaviest Foray listener — is the likeliest person to hit.",
  "fix_sketch": "Give forayResumeRows a `limit` argument (rail passes 3, Library passes Infinity) and build the subtitle with `joinMeta(draftTag, progressLabel)`.",
  "suspected_deliberate": false,
  "relation_to_round1": "New (Library Forays section was added in the round-1 fix for personas 32/50).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main after a fresh fetch, and the code is as the finding describes. In libraryForaysHtml (app.js:8738), `const progress = new Map(forayResumeRows().map(p => [p.id, p.label]));` builds the progress labels. forayResumeRows (app.js:10988-11007) filters to Forays that are visible, not dropped, not finished and have a label, then ends with `.slice(0, 3)`. That cap exists for the Home \"Jump back in\" rail. Library then shows up to LIBRARY_SECTION_CAP = 5 Forays, so a fourth part-played Foray in those five has no progress entry. A published one falls back to \"\", which is an empty subtitle and looks unopened. At app.js:8741, `progress.get(f.id) || (f.status === \"published\" ? \"\" : \"draft\")` uses the progress label instead of the \"draft\" tag, not alongside it, so a part-played draft loses \"draft\" in Library. I searched docs/DECISIONS.md for resume, min left and library, and nothing rules on either behaviour. Nothing in the code suggests the 3-row cap was meant to apply to Library: the rail and Library simply share the helper. The fix sketch holds: add a limit argument to forayResumeRows and join the draft tag with the progress label. Severity is low because this is cosmetic metadata on a secondary list and needs four or more part-played Forays (or a part-played draft).",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## honesty-13 — remainingClock's comment says 'both clocks floor' but the episode clock rounds: the countdown drops its minus sign for the last half-second at '0:01', and elapsed + remaining can sum to one second more than the duration

**confirmed** · verifier severity **low** (finder: low) · honesty · `player/client.js:1338` · L1-player-transport

```json
{
  "id": "honesty-13",
  "lens": "honesty",
  "title": "remainingClock's comment says 'both clocks floor' but the episode clock rounds: the countdown drops its minus sign for the last half-second at '0:01', and elapsed + remaining can sum to one second more than the duration",
  "file": "player/client.js",
  "line": 1338,
  "severity": "low",
  "user_visible": "In the last second of an episode the countdown reads '-0:01' then '0:01' (no sign) then '0:00'; and at e.g. 12.5 s into a 60.0 s episode the bar reads '0:13' and '-0:48' (13 + 48 = 61).",
  "evidence": "player/client.js:1333-1341: comment 'Both clocks floor, so anything under a second left is zero' but `const clock = foray ? fmtClock(left) : formatTimestamp(left, EXACT); return left >= 1 ? \\`-${clock}\\` : clock;` and player/seek-policy.js:251 `hms`: `const s = Math.max(0, Math.round(totalSeconds));` — rounds. foray-resolve.js fmtClock floors. The test at transport-reconcile.test.js:1687 only checks the exact end.",
  "why_subtle": "Half-second window; only the sign flicker is visible and only if you are staring at the bar as it ends.",
  "fix_sketch": "Sign on `Math.round(left) >= 1` (or floor inside formatTimestamp for the countdown), and derive tLeft from `Math.round(dur) - Math.round(pos)` so the two clocks add up.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of qa 40 (-0:00) — the fix assumed both formatters floor.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In player/client.js:1333-1341, remainingClock's comment says \"Both clocks floor, so anything under a second left is zero\". The ordinary-episode branch actually uses formatTimestamp(left, EXACT), which calls hms() in player/seek-policy.js, and hms() does `Math.round(totalSeconds)`. Only the Foray branch's fmtClock (foray-resolve.js:731) floors.\n\nWhat the user sees on an ordinary episode:\n- **Sign dropped near the end:** with left in [0.5, 1) the sign check `left >= 1` is false but the clock rounds to \"0:01\", so the bar shows an unsigned \"0:01\" between \"-0:01\" and \"0:00\".\n- **Clocks that don't add up:** render() at client.js:1484/1491 shows tNow = formatTimestamp(pos) (rounded) and tLeft = remainingClock(dur - pos) (rounded separately). At pos=12.5 in a 60.0 s episode that is 13 + 48 = 61. This only happens at certain fractional pairs.\n\nThe render loop runs at 4 Hz, so the unsigned \"0:01\" state stays on screen for about 2 ticks and is visible.\n\nIt is not deliberate and not already fixed. No docs/DECISIONS.md entry covers countdown rounding, and the code comment itself states the intent to floor, which the episode path does not do. So the qa-40 fix is incomplete for episodes, and Forays are unaffected. It is cosmetic only (display, no state or seek impact), so severity stays low.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## native-2 — A Foray that opens with narration runs its first minute on Android with no foreground service, no notification and no lock-screen controls, and the first tape segment's start is refused if the phone is already pocketed

**confirmed** · verifier severity **high** (finder: high) · native · `mobile/plugins/foray-audio/web/foray-audio-shell.js:664` · L3-queue-and-native-surfaces

```json
{
  "id": "native-2",
  "lens": "native",
  "title": "A Foray that opens with narration runs its first minute on Android with no foreground service, no notification and no lock-screen controls, and the first tape segment's start is refused if the phone is already pocketed",
  "file": "mobile/plugins/foray-audio/web/foray-audio-shell.js",
  "line": 664,
  "severity": "high",
  "user_visible": "Android: press play on one of the narrated Forays, lock the phone. During the opening narration there is nothing on the lock screen to pause with. When the first clip starts (typically 30-60 s later, hidden), the service start is refused on Android 12+, so the whole Foray plays with no notification, no lock-screen controls and no process protection.",
  "evidence": "foray-audio-shell.js only calls `ensureStarted()` from the patched `HTMLMediaElement.prototype.play` (lines 770-790) and `noteServiceRunning` (434). `setMediaLoaded(true)` explicitly does nothing: line 664 `if (mediaLoaded) return;` with the comment \"A TRUE cancels nothing and starts nothing -- the service is already up from the `play()` that preceded it\". That precondition is false for narration: queue-manager.js:1268 routes a `kind: \"tts\"` item with a script and no asset to `_speakNarration` (ForayTtsPlugin), and no `<audio>` element ever plays. data/forays.json: 4 of the 7 shipped Forays open with 3-4 consecutive `narration(script)` items before the first `segment`.",
  "why_subtle": "The shell was written before on-device narration existed (§7 item 1 'the common case is SCRIPT, NO ASSET'); its header still assumes every Foray begins with an element play. Nothing logs the gap: `inspect()` shows `wanted:false, mediaLoaded:true`, which the docs never describe.",
  "fix_sketch": "Start the service when the transport becomes usable, not only when an element plays: in `setMediaLoaded(true)` (or on the first `playing` payload) call `ensureStarted()` if `activeCount()===0 && !wanted`. The first such payload arrives from the listener's own tap, in the foreground, so the start is always permitted; the 25 s settle window still governs stops.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; round 1 did not cover Android or the native shell.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I checked every link in the chain against origin/main and each one holds.\n\n1. **The service only starts when an element plays.** In foray-audio-shell.js, `ensureStarted()` is called from three places: `noteServiceRunning` (line 434, and only after a start was already accepted and then died, with `activeCount()>0`), `reconcile()` (line 679, only when `activeCount()>0`), and indirectly from the patched `HTMLMediaElement.prototype.play`. `activeCount()` counts only media elements that are actually playing.\n\n2. **`setMediaLoaded(true)` starts nothing.** Lines 660-668: `if (mediaLoaded) return;` comes before any start. The doc comment assumes \"the service is already up from the play() that preceded it\".\n\n3. **No other path starts the service.** The media-session polyfill writes through `ForayAudioPlugin.setNowPlaying` (Java, around line 260). That method only posts to `NowPlayingHub` and explicitly does not touch the service. Its own comment names this case: \"state accepted, service not running yet, because nothing has played\". `ForayTtsPlugin.java` never starts a foreground service.\n\n4. **Narration never plays an `<audio>` element.** `queue-manager.js` `_isSynthNarration` is `kind===TTS && !audio_url && script`, and it routes to `_speakNarration`, which uses the native TTS plugin. `foray-queue.js` maps a narration item's `audio_url` from `raw.audio_url ?? raw.asset`.\n\n5. **Four of the seven shipped Forays open this way.** In `data/forays.json`, four Forays start with 3, 4, 7 and 3 script-only narration items (no `audio_url` or `asset`) before their first segment: beyond-the-algorithm, how-ai-actually-gets-built, the-chain-reaction and what-engineers-actually-do. The other three open directly with a segment.\n\n6. **Consequence.** During the opening narration nothing starts the service, so there is no notification, no lock-screen session and no process protection. If the phone is locked before the first segment, that segment's `play()` calls `startForegroundService` from the background, which Android 12+ refuses. `startAccepted` then stays false. Each later hidden `play()` retries and is refused again. Recovery happens only when the user brings the app back to the foreground: the visibility handler calls `reconcile`, which calls `ensureStarted`.\n\nSo \"the whole Foray\" plays unprotected only if the listener never reopens the app. That is exactly the \"press play and pocket it\" case, and it is very common.\n\n**Not deliberate and not fixed.** `docs/DECISIONS.md` has no ruling on this. The shell's last commits are #244 and #271, and neither covers narration. The shell's own header says none of it has been observed in a WebView.\n\n**Severity: high.** It hits more than half the catalogue, in the most common listening pattern (start, then lock the phone). It removes the lock-screen controls #27 exists to provide, and it leaves the process unprotected.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## native-3 — An iOS interruption (call, Siri, another app) during a narration line leaves the Foray showing 'Playing' in silence forever

**confirmed** · verifier severity **medium** (finder: high) · native · `player/queue-manager.js:985` · L1-player-transport

```json
{
  "id": "native-3",
  "lens": "native",
  "title": "An iOS interruption (call, Siri, another app) during a narration line leaves the Foray showing 'Playing' in silence forever",
  "file": "player/queue-manager.js",
  "line": 985,
  "severity": "high",
  "user_visible": "iOS: a phone call or a steering-wheel Siri press lands while the narrator is speaking (every seam bridge, and the opening of 4 of 7 Forays). After the call the app, the lock screen and the car all still say Playing with a pause button, nothing is heard, the elapsed clock keeps counting, and the Foray never moves to the next clip. Only a manual pause-then-play recovers it.",
  "evidence": "ForayTtsPlugin.swift:137-141: \"`AVSpeechSynthesizer` does NOT surface interruptions of its own: it stops when the session it uses is taken, and the delegate's `didCancel` is not called for that.\" So `speechSynthesizer(_:didFinish:)` (241) never fires. client.js:460-462 turns `interruptionBegan` into `reconcileOnReturn` only; queue-manager.js:981-985 `reconcileWithBackend`: \"A synth narration item is 'playing' from the reducer's point of view ... `if (this._loadedIsSynth) return false;`\", and `_reconcileTowardsPlaying` (1009) likewise bails on `_loadedIsSynth`. The only advance is `_onTtsFinished` (1689-1700); `_tickNarration` (1645-1652) re-arms itself with no deadline. foray-tts.js:596 `state()` (which returns the synthesizer's real `speaking|paused|idle`) is never consulted on an interruption. client.js:445-447 also declines to act on `interruptionEnded`.",
  "why_subtle": "The round-1 wiring of native session events into the player (2026-09-22 founder report 1) fixed tape but explicitly carves narration out; tape segments even self-heal because WebKit resumes its own element after `shouldResume` (`E.elementResumed`), so the bug only shows when the call happens to land on a spoken line.",
  "fix_sketch": "On `interruptionBegan` with `_loadedIsSynth`, drive `E.interruptionBegan()` through the reducer (pause path: `_pauseNarration` -> tts.pause, which is accepted or answers `nothing to act on`) and stamp `_narrationPausedAtMs`; or on any session event for a synth item ask `tts.state()` and reconcile to `paused` when it is not `speaking`. Also give the narration ticker a deadline (estimated duration + margin) that advances or pauses rather than counting forever.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the 2026-09-22 founder report 1 wiring (native session events now reach the player, but never for a synth line).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The code at origin/main (9730b5b) matches the finding. ForayTtsPlugin.swift:137-141 says outright that AVSpeechSynthesizer stops when its session is taken and that didCancel is not called. The plugin's interruption handler (164-177) only emits a 'session' event and does nothing itself; the doc comment calls this deliberate (\"REPORTED, NOT ACTED ON\"). No didFinish fires either, so _onTtsFinished (queue-manager.js ~1689) never advances.\n\nIn client.js onNativeSession, interruptionBegan (and foreground and mediaServicesReset) only call reconcileOnReturn, and interruptionEnded changes nothing. queue-manager.js reconcileWithBackend returns early at ~985 on `if (this._loadedIsSynth) return false;`. _reconcileTowardsPlaying (~1009) also bails on _loadedIsSynth. So for a spoken line the reducer stays 'playing'. _tickNarration re-arms forever while _loadedIsSynth is set, and nothing in queue-manager has a deadline or watchdog for narration. I found no tts.state() query on any session event.\n\nDECISIONS.md does not cover this. Its interruption rulings are about the iOS paused-session hold and the shouldResume auto-resume question. Neither sanctions leaving the transport saying 'playing' over a dead synthesizer. The plugin comment hands the decision to queue-manager.js, and that file then declines to act for synth items, so this is a gap, not a ruling. Manual pause then play goes through interruptionBegan and E.play, which plausibly recovers it, as the finding says.\n\nWhy medium rather than high: the stall can only start while a narration line is speaking. Those lines are short (seam bridges, openers), so a call or Siri press has to land in a narrow window. I also did not verify on a device whether iOS leaves the synthesizer paused (where continueSpeaking would work) or stopped. Either way the UI keeps saying Playing and the Foray does not advance.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## native-6 — The plugin's belief that it holds the audio session goes stale after WebKit's delayed category change, so the car-connect re-hold is skipped

**uncertain** · verifier severity **low** (finder: medium) · native · `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:358`

```json
{
  "id": "native-6",
  "lens": "native",
  "title": "The plugin's belief that it holds the audio session goes stale after WebKit's delayed category change, so the car-connect re-hold is skipped",
  "file": "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift",
  "line": 358,
  "severity": "medium",
  "user_visible": "Pause a clip, lock the phone, get in the car: the car's play can still go to Spotify (the founder's item 1) on the code path where WebKit's own session bookkeeping downgrades the app session two seconds after the pause.",
  "evidence": "`holdSession` (594-605) activates `.playback` on the playing->paused transition and sets `holdsSession = true`. The same file (63-68, 632-637) states WebKit \"moves the category to none two seconds after the last session stops\"; `armReassert` re-writes only `nowPlayingInfo`/commands (651-655), never the session. `handleRouteChange` (341-364) logs `category-change` and does nothing; only `new-device` re-holds, and only through `shouldRehold(state:holding:interrupted:)` (562-564), which requires `!holding` — so once `holdsSession` is stale-true, neither the 3 s re-assert nor the car connecting ever re-activates. `holdsSession` is cleared only by an interruption (312), a media-services reset (371) or a supersede (627).",
  "why_subtle": "The 2026-09-23 review closed five holes in the hold but all of them clear the flag on an event the plugin receives; a category write from WebKit's own process produces only a `category-change` route notification, which the plugin explicitly treats as diagnostics. Needs the §8.5 device check to confirm which way the OS behaves.",
  "fix_sketch": "Do not trust the flag: in `reassertNowPlaying` and on a `category-change`/`new-device` route while paused, read `AVAudioSession.sharedInstance().category` (and `.isOtherAudioPlaying`); if the category is no longer `.playback`, call `holdSession(reason:)` again (still off the playing path, so the F11/F13 rule holds). Record `sessionCategory=` in the `session` event so the next founder record can confirm either way.",
  "suspected_deliberate": false,
  "relation_to_round1": "Possible incomplete fix of the 2026-09-23 founder item 1 (car resumes Spotify).",
  "duplicates": [],
  "verdict": "uncertain",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main (9730b5b, #746) matches the description. `holdSession` (594-605) sets `holdsSession = ok` and nothing ever reads back `AVAudioSession.category` or `isOtherAudioPlaying` (a grep finds no `.category` reads). `armReassert` and `reassertNowPlaying` (639-655) rewrite only nowPlayingInfo and the commands. `handleRouteChange` (341-364) acts only on `new-device`, and only through `shouldRehold` (562-564), which requires `!holding`. `holdsSession` is cleared only at 312, 371, 618 and 627. `remotePlay` (947) is gated on `!holdsSession` too. So if the app-process session really were downgraded behind the plugin's back, the stale flag would block both the car-connect re-hold and the remote-play re-hold. That part holds.\n\nWhat I can't confirm is the trigger. The finding assumes WebKit's delayed category change (MediaSessionManagerCocoa, about 2 s after the last session stops) rewrites the app process's shared AVAudioSession, the one `holdSession` just activated. The file's own design comment says the opposite. At lines 65-69 WebKit activates the session \"from its own media process\", and \"nothing in the APP process ever held one\". The whole hold design depends on the app-process session being separate from WebKit's. Under that model, WebKit's category change leaves the plugin's `.playback` activation alone, and the flag is not stale. The comment at 633-636 about the delayed change is about WebKit dropping its own Now Playing claim, not about our session. Whether iOS's GPU/media process really runs a separate session or one tied to the host app is runtime behavior I can't settle from the source. No device record here shows a `category-change` routeChange after `sessionActivated paused`.\n\nDECISIONS.md (2026-09-23, items 4-6) mentions \"re-asserting its entry after WebKit's category change\" but makes no ruling that losing the session to it is acceptable, so this is not 'deliberate'. Nothing on main fixes it either.\n\nNet: the code facts are right, but the user-visible failure depends on an unverified WebKit/iOS session-sharing assumption that the file's own model contradicts. The proposed fix is cheap diagnostics: log `sessionCategory=` and re-check the category on re-assert. It is worth doing, but as a hedge rather than a confirmed bug.",
  "merged_ids": [],
  "lane": null
}
```

## native-7 — Android media notification never offers 15/30 skips; a single episode with nothing queued has only play/pause and Stop

**confirmed** · verifier severity **medium** (finder: medium) · native · `mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java:487` · L3-queue-and-native-surfaces

```json
{
  "id": "native-7",
  "lens": "native",
  "title": "Android media notification never offers 15/30 skips; a single episode with nothing queued has only play/pause and Stop",
  "file": "mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java",
  "line": 487,
  "severity": "medium",
  "user_visible": "On the Android lock screen and shade, an ordinary episode shows just ⏯ and a Stop ✕ — no way to go back 15 s after missing something. A Foray shows ⏮ ⏯ ⏭ (whole clips) and still no 15/30. Apple Podcasts / Pocket Casts always put the skip pair on that surface.",
  "evidence": "`buildNotification()` adds exactly four actions: previous (479-485), play/pause (487-495), next (496-503) and Stop (516-523); `compactActions` (568-579) picks from those three. `WebViewPlayer.commandsFor` declares `COMMAND_SEEK_BACK`/`COMMAND_SEEK_FORWARD` (252-253) and `getState()` sets the increments (127-128), but nothing puts a seek action on the notification, and SystemUI's media controls render prev/play/next from the session and custom actions from the notification — never rewind/fast-forward. The class comment (395-402) lists 'previous, play/pause, next and stop' as the whole set.",
  "why_subtle": "Every surface the docs describe (Media3 command set, the page's handlers) does carry the seek pair, so the tables read as complete; the shade is the one surface that only shows what `addAction` was given.",
  "fix_sketch": "Add `seekbackward`/`seekforward` notification actions (gated on `canSeekBack`/`canSeekForward`, routed through `transportIntent(\"seekbackward\"/\"seekforward\", 6/7)` -> `NowPlayingHub.dispatch` with `offsetMs` from `np.seekBackMs`/`seekForwardMs`), and prefer them over prev/next in the compact view for single-episode playback; on Media3 1.x also expose them as session custom command buttons so Android 13+ media controls show them.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; round 1 did not look at the Android shell.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds. I read mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java at origin/main. Its latest change is 9730b5b (#746), the six-founder-reports fix.\n\n- **What the notification offers:** `buildNotification()` adds only four actions. They are previoustrack (gated on hasPrevious), play/pause, nexttrack (gated on hasNext) and a \"close\" Stop (gated on isLoaded and canStop).\n- **Compact view:** `compactActions()` picks only from prev, play and next.\n- **Class comment:** it names \"previous, play/pause, next and stop\" as the whole set and says \"a single episode gets no dead skip buttons\".\n- **No seek action anywhere:** a search of the Android plugin finds no seekbackward/seekforward notification action and no Media3 custom layout, CommandButton or MediaButtonPreferences.\n- **The session side exists:** `WebViewPlayer` declares COMMAND_SEEK_BACK and COMMAND_SEEK_FORWARD (lines 252-253) and sets the 15/30 increments (127-128). `handleSeek` routes them to the page (395/397). They are reachable only from car head units or Bluetooth controllers.\n\nWhat the user sees:\n- **API 24-32:** the lock screen shows the notification's own actions, so a single episode gets play/pause plus Stop, and none of them skips 15 or 30 seconds.\n- **API 33+:** SystemUI builds its media controls from the session's PlaybackState. It shows play/pause, prev/next when those actions are set, and otherwise custom actions. It never draws rewind or fast-forward. With no custom layout, a single episode gets only play/pause (and possibly the Stop/close action). A Foray gets prev/play/next.\n\nEither way there is no 15/30 on the Android lock screen or in the shade.\n\nIt is not deliberate. The 2026-09-23 DECISIONS.md entry, \"lock screen's 15/30\", concerns the iOS lock screen showing 10/10 instead of 15/30 and does not mention the Android notification. The \"no dead skip buttons\" comment is about prev/next, not the seek pair.\n\nSeverity is medium. This is a real parity gap with standard podcast apps on a core lock-screen surface. Playback still works, though, and 15/30 is still in the app and on car and Bluetooth controllers.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## native-8 — Every notification button press re-posts the notification through startForeground before the page has answered; on Android 14+ a dismissed notification pops straight back

**confirmed** · verifier severity **low** (finder: low) · native · `mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java:311` · L3-queue-and-native-surfaces

```json
{
  "id": "native-8",
  "lens": "native",
  "title": "Every notification button press re-posts the notification through startForeground before the page has answered; on Android 14+ a dismissed notification pops straight back",
  "file": "mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java",
  "line": 311,
  "severity": "low",
  "user_visible": "Tapping pause on the Android lock screen redraws the notification twice (once with the old state, once with the new); swiping a paused 4a notification away on Android 14 makes it reappear for a beat before the page's close removes it.",
  "evidence": "`onStartCommand` (293-331) dispatches the transport intent (298-303) and then unconditionally calls `ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), ...)` (311) even when `running` is already true; `buildNotification()` reads the hub, which still holds the pre-press state, so the post is byte-identical to the one on screen. `setDeleteIntent(transportIntent(\"close\", 5))` (456) routes a swipe through the same path, so `startForeground` re-posts the notification the user just dismissed, and it only disappears once the page's `stopAndClose` -> `metadata=null` -> `setMediaLoaded(false)` -> `stop` round-trips.",
  "why_subtle": "The comment at 294-297 acknowledges 'a notification we are about to rebuild again' but treats the double post as cheap; the visible flicker and the pop-back only show on a phone.",
  "fix_sketch": "In `onStartCommand`, when the intent is `ACTION_TRANSPORT` and `running` is true, return `START_NOT_STICKY` after dispatching without calling `startForeground` again; for `close`, additionally `stopForeground(STOP_FOREGROUND_REMOVE)` at once so the swipe is honoured immediately.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code is as the finding describes. In PlaybackKeepAliveService.java, onStartCommand (lines 293-331) dispatches ACTION_TRANSPORT to NowPlayingHub. It then always reseeds lastNotificationKey from the state before the press and calls ServiceCompat.startForeground(..., buildNotification(), ...) at line 311, even when the service is already running. It never returns early for a transport intent.\n\ntransportIntent (line 592) uses PendingIntent.getService, so a button press starts an already-foreground service with no requirement to call startForeground again. The repost is unnecessary.\n\nbuildNotification reads the hub before the page has answered, so the first post repeats the current state. When the page does answer, onNowPlayingChanged sees a different key and posts a second time. The comment at 294-297 even admits the notification is rebuilt \"again when the page answers\", so the double post is known but not fixed.\n\nsetDeleteIntent(transportIntent(\"close\", 5)) at about line 456 sends a swipe through the same path. From Android 14, a foreground-service notification can be dismissed, and setOngoing is false while paused. Calling startForeground again with the same ID after a swipe posts the notification again, and it stays until the page's close round trip stops the service. No DECISIONS.md entry covers this: searching it for startForeground, delete intent, swipe and repost found nothing.\n\nWhy the severity is low: the duplicate post is silent (setSilent) and shows the same content, so it is hard to notice. The swipe problem only happens on Android 14+ with a paused Foray, and it clears itself within one round trip to the page.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## native-10 — Only narration lines run with the .spokenAudio session mode, so a navigation prompt pauses 4a mid-sentence but ducks it mid-clip

**confirmed** · verifier severity **low** (finder: low) · native · `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift:647` · L3-queue-and-native-surfaces

```json
{
  "id": "native-10",
  "lens": "native",
  "title": "Only narration lines run with the .spokenAudio session mode, so a navigation prompt pauses 4a mid-sentence but ducks it mid-clip",
  "file": "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift",
  "line": 647,
  "severity": "low",
  "user_visible": "With Maps giving directions: during a clip 4a is turned down under the prompt and comes back up; during the narrator's line 4a is stopped outright (and, per the narration-interruption finding, may not come back). Apple Podcasts uses spoken-audio behaviour throughout, so it always pauses and resumes cleanly.",
  "evidence": "ForayTtsPlugin.swift:647 `setCategory(.playback, mode: .spokenAudio, options: [])` on every `speak()` and again in `resume()` (788); ForayAudioPlugin.swift:590-593 deliberately holds with `mode: .default` (\"a paused podcast is not that\"); WebKit sets the default mode for its element, and the F11/F13 rule (101-109) forbids the audio plugin from touching the session on the playing path, so tape can never be `.spokenAudio`.",
  "why_subtle": "Both plugins are individually reasoned; the inconsistency only appears against a third app's prompt, and which behaviour you get depends on which second the prompt lands in.",
  "fix_sketch": "Pick one mode for the app: either `.spokenAudio` everywhere (set once at `load()` in ForayAudioPlugin via `setCategory` without `setActive`, and keep it in `holdSession`; verify WebKit does not reset it) or `.default` everywhere (drop it from ForayTtsPlugin). Record the choice in docs/DECISIONS.md.",
  "suspected_deliberate": true,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In ForayTtsPlugin.swift, line 647 (in speak()) and line 788 (in resume()) both call `setCategory(.playback, mode: .spokenAudio, options: [])` and then setActive(true). ForayAudioPlugin.swift holdSession (around lines 590-598) uses `mode: .default`, and its doc comment says why: \"ForayTtsPlugin sets that for narration and navigation apps treat it as something to talk over and resume; a paused podcast is not that.\" Its header comment (around lines 101-109) keeps the F11/F13 rule that the playing path never touches the session, so this plugin never sets the mode for tape. A grep of docs/DECISIONS.md finds no ruling on spokenAudio or session mode; the F11/F13 ruling there covers setActive, not the mode. So the mismatch is not recorded as a decision. Only the paused-hold choice of .default is deliberate, stated in a code comment, and nothing rules on clips and narration getting different modes during playback.\n\nWhere the finding is weaker: the claim that the user sees it depends on runtime behaviour I could not check read-only. The session mode is shared by the whole app. I did not verify whether WebKit resets it to .default when an <audio> element starts playing. If it does not, a clip played after narration would inherit .spokenAudio, and the difference would depend on the order things played in rather than always splitting clip vs narration. The TTS comment also claims its category/mode is \"the same one WebKit sets automatically for <audio>\". That is wrong if WebKit uses .default, which is the finding's point, and either way the code's authors expected a single consistent mode.\n\nThat navigation apps interrupt .spokenAudio sessions and duck the others matches Apple's documented `interruptSpokenAudioAndMixWithOthers` behaviour. The only harm is inconsistent prompt behaviour, plus the knock-on effect of the separate narration-interruption finding. So I rate it low.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## perf-1 — Boot's main data fetch waits for the whole 28-module player graph (5 serial round trips) plus IndexedDB hydrate before it starts

**confirmed** · verifier severity **medium** (finder: high) · perf · `app.js:13868` · L5-boot-states-storage

```json
{
  "id": "perf-1",
  "lens": "perf",
  "title": "Boot's main data fetch waits for the whole 28-module player graph (5 serial round trips) plus IndexedDB hydrate before it starts",
  "file": "app.js:13868 (init: `const [, session] = await Promise.all([storageReady(), fetchJson(\"data/session.json\")])`), app.js:13900 (the 7-document Promise.all), app.js:169-183 (waitForStorage), player/client.js:296 + 3920 (forayStorage published / forayplayer:ready dispatched at module end), index.html:75-79 (no modulepreload)",
  "line": 13868,
  "severity": "high",
  "user_visible": "On the web (jw-incorporated.github.io/foray) a cold or revalidating launch sits on \"Loading 4a…\" far longer than the 1.3 MB of data explains: the discover/forays/catalog fetches do not even begin until player/client.js and its 27 transitive imports (depth 5: client → queue-manager → foray-queue → queue-state…) have each been fetched through the service worker's network-first revalidation and evaluated, and IndexedDB has been read. On a 150-200 ms cell RTT that is ~1 s of dead time before the first byte of discover.json; on a black-holed connection it is the 5 s STORAGE_WAIT_MS cap, then the 6 s sw NET_TIMEOUT for the data. session.json is a further serial hop in front of the seven documents.",
  "evidence": "init(): `const [, session] = await Promise.all([storageReady(), fetchJson(\"data/session.json\")]);` … only afterwards `[state.validated, state.taxonomy, state.discover, …] = await Promise.all([fetchJson(\"data/validated-links.json\"), … fetchJson(\"data/catalog-client.json\")])`. storageReady() → waitForStorage(): `window.addEventListener(\"forayplayer:ready\", finish, { once: true }); if (document.readyState === \"loading\") document.addEventListener(\"DOMContentLoaded\", finish …); setTimeout(finish, STORAGE_WAIT_MS /* 5000 */)`. app.js is a sync script at the end of body, so readyState is \"loading\" and DOMContentLoaded itself fires only after the deferred module graph executes. client.js publishes `window.forayStorage = storage;` at line 296 and dispatches `forayplayer:ready` at line 3920 — the last line of a 28-module graph (measured: depth 1 client.js; depth 2 ×17; depth 3 ×5; depth 4 ×2; depth 5 queue-state.js, seek-policy.js). index.html carries no `<link rel=\"modulepreload\">`, and sw.js's fromOrigin sends every one of those 28 requests with `fetch(url, { cache: \"no-cache\" })`.",
  "why_subtle": "Every piece is individually reasoned (hydrate-before-first-write is correct; the boot line hides the blank), so nobody sees that the data fetch was quietly chained behind an unrelated module graph. The native shell loads modules from disk, so the founder's phone build hides most of it; it is the web that pays.",
  "fix_sketch": "Start the seven document fetches (and session.json) synchronously at the top of init(), before `await storageReady()`; only `loadInterests()` (the first read-then-write) needs hydration, so `await storageReady()` immediately before it. Add `<link rel=\"modulepreload\" href=\"player/…\">` for the graph (generate the list from playerSources() in tools/ci/generate-manifest.mjs so it cannot drift), or bundle player/ into one module for the web dist. Keep the 5 s bound but apply it to the write, not the fetch.",
  "suspected_deliberate": false,
  "relation_to_round1": "Extends qa 101 / persona 43 (which added the boot line but did not shorten the critical path) and qa 168 (the 5 s race).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In init() (app.js ~13868), `await Promise.all([storageReady(), fetchJson(\"data/session.json\")])` has to finish before the seven-document Promise.all (validated-links, taxonomy, discover, forays, segments, segment-sources, catalog-client) starts. storageReady() goes through waitForStorage() (app.js 169-185). That function resolves on forayplayer:ready, on DOMContentLoaded (while readyState is \"loading\"), or after the 5 s STORAGE_WAIT_MS timeout. It then races store.hydrate() against another 5 s. index.html loads app.js as a classic script and player/client.js as a module after it, so readyState is still \"loading\" when init runs. Deferred modules run before DOMContentLoaded, so the wait lasts until the whole client.js import graph has been fetched and evaluated. client.js has 26 static imports. It sets window.forayStorage at line 296 and dispatches forayplayer:ready at line 3920, its second-to-last line (the file has 3922). index.html has no modulepreload. sw.js line 394 refetches every non-navigation request with `cache: \"no-cache\"` (NET_TIMEOUT_MS = 6000), so even a warm cache pays a revalidation round trip at each import depth. The app.js comment at the waitForStorage site explains why the wait falls back on DOMContentLoaded rather than the timeout. It never says the data fetches should wait on storage, and docs/DECISIONS.md has no ruling on boot ordering or modulepreload, so this is not deliberate. The data fetches don't depend on hydration: storageReady's return value is thrown away (`const [, session]`). The fix sketch holds up: start the fetches first and await storage only before the first read-then-write. Two small corrections to the finding. session.json runs in parallel with the storage wait, so the serial hop it adds only counts once the storage wait finishes first. On a black-holed connection the effective bound is the module timeout or DOMContentLoaded plus the 5 s hydrate race, not simply \"5 s then 6 s\". The user sees the effect only on the web: a longer \"Loading 4a…\" screen. The page still paints and nothing breaks, it just loses roughly 0.5-1 s on cell RTTs. That makes it a real performance problem on the critical path rather than a correctness bug, so I rate it medium, not high.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## perf-3 — Search-vocabulary priming is a ~0.5-1 s single main-thread task that fires on a 0 ms timer in the native shell, right when the listener starts tapping

**confirmed** · verifier severity **medium** (finder: medium) · perf · `app.js:13994` · L5-boot-states-storage

```json
{
  "id": "perf-3",
  "lens": "perf",
  "title": "Search-vocabulary priming is a ~0.5-1 s single main-thread task that fires on a 0 ms timer in the native shell, right when the listener starts tapping",
  "file": "app.js:13993-13996 (loadSearchData().then → requestIdleCallback(primeSearchVocab, { timeout: 2000 }) else setTimeout(primeSearchVocab, 0)); search-engine.js:515 (primeVocabulary)",
  "line": 13994,
  "severity": "medium",
  "user_visible": "A few seconds after launch — once semantic-index.json and item-tags.json land — the page freezes for a moment: a tap on a Home card or the tab bar lands late or is missed, a rail mid-swipe stutters. Measured in Node on the committed data: `primeVocabulary cold 176.1ms` (warm 1.3 ms); a mid-range phone runs 3-5× slower, so 0.5-0.9 s of blocked main thread. Where requestIdleCallback is missing (the code's own comment names WKWebView / the native shell) it runs on `setTimeout(…, 0)` the instant the documents arrive; where it exists the `timeout: 2000` forces it inside two seconds regardless of whether the user is interacting.",
  "evidence": "`loadSearchData().then(() => { if (typeof requestIdleCallback === \"function\") requestIdleCallback(primeSearchVocab, { timeout: 2000 }); else setTimeout(primeSearchVocab, 0); });` with the header admitting \"it must not compete with that paint or with an impatient user who taps into the playlist search within the first second\" — the fallback does exactly that. Benchmark: vm-loaded search-engine.js + real discover/item-tags/semantic: primeVocabulary cold 176.1 ms.",
  "why_subtle": "It is scheduled 'idle' in name, so it looks solved; the fallback path and the forced timeout are where the jank actually comes from, and it happens once per session at the moment of first interaction, which is exactly when a stutter reads as 'the app feels off'.",
  "fix_sketch": "Chunk the priming (yield with setTimeout/MessageChannel between vocabulary groups, ~30 ms per slice) and start it only after the first user interaction settles, or defer it to the first focus of #sh-input the way the show index already defers its 113 ms decode; longer term move priming and the relaxation scan (persona 28) into a Worker together, since the memoised ctx is the same object.",
  "suspected_deliberate": false,
  "relation_to_round1": "Sibling of persona 28 (the search itself locks the page; Worker deferred to founder). This is the boot-time prime, not reported in round 1.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The code at origin/main matches the finding exactly (HEAD 9730b5b). app.js:13986-13996 defines primeSearchVocab and then runs `loadSearchData().then(() => { if (typeof requestIdleCallback === \"function\") requestIdleCallback(primeSearchVocab, { timeout: 2000 }); else setTimeout(primeSearchVocab, 0); })`. The comment above it names \"older WebKit/the native shell\" as the setTimeout-0 path. WKWebView/Safari still has no requestIdleCallback by default, so in the iOS shell the prime runs on the next task after semantic-index.json and item-tags.json arrive.\n\nsearch-engine.js primeVocabulary (about line 515) does all of its work in one synchronous loop with no yielding. It walks all 1,364 concept terms, runs tagDF and corpusDF on each, and builds itemWordSets over 2,167 discover items the first time. The same comment says the goal is not to \"compete with ... an impatient user who taps ... within the first second\", and the fallback path does exactly that.\n\nI reproduced it in Node with origin/main's search-engine.js and the real data files, on a fresh ctx:\n- Cold primeVocabulary took 1,395 ms, 1,916 ms, 2,696 ms and 1,483 ms across runs.\n- Warm calls took about 2-3 ms.\n\nThat is far more than the finding's 176 ms. Some of the gap is likely load on this machine, but either way it is one long task measured in hundreds of milliseconds or more, and slower on a phone. No docs/DECISIONS.md entry covers this (no hits for prime, idle, t_838a13c0 or a search Worker). The last three app.js commits did not change it.\n\nThe user-visible claim holds: a one-time jank or missed tap a few seconds after a cold launch. I kept severity at medium because it happens once per session, after the first paint, and the only harm is a delayed or dropped input, not wrong behaviour. If the Node timing I measured holds on devices, it leans toward high.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## perf-4 — On every deploy day the first open downloads the whole ~1.3 MB bundle twice, in parallel with first paint

**confirmed** · verifier severity **medium** (finder: medium) · perf · `sw.js:200` · L5-boot-states-storage

```json
{
  "id": "perf-4",
  "lens": "perf",
  "title": "On every deploy day the first open downloads the whole ~1.3 MB bundle twice, in parallel with first paint",
  "file": "sw.js:186 and 200 (precache: `fetch(MANIFEST_URL, { cache: \"reload\" })`, `fetch(path, { cache: \"reload\" })` for all 49 manifest files), sw.js:125 (BUILD_ID restamped per deploy), app.js:14233-14234 (register runs while init()'s fetches are in flight)",
  "line": 200,
  "severity": "medium",
  "user_visible": "The morning after each nightly refresh (sw.js changed 12 times in the last 7 days, so effectively every day) a returning web visitor's first launch is markedly slower than usual: the page's own fetch of discover.json (578 KB gz) competes for the cell link with the new worker's precache of the same discover.json and 48 other files, all with `cache: \"reload\"` so the HTTP cache the page just filled is bypassed. Data usage doubles on exactly the day the data changed; on a slow link the first paint takes longest on the day the content is freshest.",
  "evidence": "precache(): `const res = await fetch(path, { cache: \"reload\" }); … const buf = await res.clone().arrayBuffer(); const digest = await sha256Hex(buf);` for `Object.keys(files)` (49 entries incl. data/discover.json, data/item-tags.json, app.js, player/*.js). `e.waitUntil(precache().then(() => self.skipWaiting()))` on install. Registration: `navigator.serviceWorker.register(\"sw.js\")` at app.js:14234, executed at script end while init() is awaiting its Promise.all. `git log -- sw.js`: 2026-09-23 ×5, 09-22 ×2, 09-21 ×3, 09-20, 09-17.",
  "why_subtle": "The generation-atomic design is right and well argued in the header; the double fetch is a side effect of `reload` chosen for integrity, and it only shows up as 'the app is slower some mornings'.",
  "fix_sketch": "Precache with `cache: \"no-cache\"` (revalidates; an unchanged file is a 304 and a changed one the page already fetched is served from the HTTP cache), or first try `caches.match` in the previous generation and copy entries whose manifest sha256 is unchanged (most player/*.js and taxonomy/validated-links do not change nightly) before fetching anything; and defer `register()` until after `route()` has painted (e.g. from the same idle slot as priming) so install never contends with first paint.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; the SW was not in round 1's scope.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. In sw.js, precache() at lines 186 and 200 fetches the manifest and every manifest path with `{ cache: \"reload\" }`. The install handler runs `e.waitUntil(precache().then(() => self.skipWaiting()))`. deploy-manifest.json lists 49 files, including data/discover.json, which is 578,063 bytes gzipped, as claimed. All 49 files together come to about 1.59 MB gzipped, a bit more than the finding's ~1.3 MB. BUILD_ID (line 125) is restamped on every deploy by design, and git log shows sw.js changed 5 times on 09-23, 2 on 09-22, 3 on 09-21, and once each on 09-20 and 09-17.\n\nOn app.js, init() is called at line 14086, and `navigator.serviceWorker.register(\"sw.js\")` runs later at the end of the script (around line 14234), while init()'s Promise.all fetches are still in flight. Those page fetches go through the old worker's handleData/fromOrigin, which fetches from the network with `cache: \"no-cache\"` (sw.js:394). So a changed file like discover.json really does come over the network once for the page. Then the new worker's install fetches it again with \"reload\", which skips the HTTP cache the page just filled. Unchanged files are also downloaded in full rather than getting a 304. The result is a double download of changed data plus a full re-download of everything else, on the same launch.\n\nNothing in docs/DECISIONS.md or the sw.js comments justifies \"reload\" over \"no-cache\". The 2026-09-01 M4 entry and the sw.js header only say `no-cache` gives a 304 for unchanged files. Their torn-deploy protection is the sha256 check, which works just as well with no-cache, so this looks unintended. It is not fixed on main.\n\nCaveats: part of the fix sketch would not help much. Delaying register() does not stop the browser's own update check on navigation for an already-registered worker, so install still competes with first paint unless the fetches themselves change. The cost also applies to every first-ever visit, not only deploy days. It is a bandwidth and speed problem, not broken behaviour, so I rate it medium.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## perf-5 — Brand fonts are not in the deploy manifest, so every launch flashes the fallback typeface, and a dead zone shows the wrong face for 6 s

**confirmed** · verifier severity **low** (finder: medium) · perf · `tools/ci/generate-manifest.mjs:194` · L5-boot-states-storage

```json
{
  "id": "perf-5",
  "lens": "perf",
  "title": "Brand fonts are not in the deploy manifest, so every launch flashes the fallback typeface, and a dead zone shows the wrong face for 6 s",
  "file": "tools/ci/generate-manifest.mjs:87-95 (SHELL list has no fonts/), styles.css:190-209 (three @font-face with font-display: swap), sw.js:158 (NET_TIMEOUT_MS = 6000), sw.js fromOrigin (`fetch(request.url, { cache: \"no-cache\" })` for every non-navigation), index.html (no font preload)",
  "line": 194,
  "severity": "medium",
  "user_visible": "On every launch the greeting, headings and body text paint in the system serif/sans and then snap to Fraunces / DM Sans a round-trip later (weights and widths change, lines rewrap) — the kind of 'subtly wrong' the founder describes. In a cell dead zone or captive-portal black hole the three fonts each wait the worker's 6 s timeout before the runtime-cached copy is served, so the app runs in the wrong typeface for six seconds and then reflows.",
  "evidence": "SHELL = [\"index.html\",\"app.js\",\"search-engine.js\",\"styles.css\",\"manifest.json\",\"icon-180.png\",\"icon-512.png\"] — fonts/*.woff2 (216 KB) absent, so precache never stores them and offline they depend on an untracked cachePut. Every font request goes through handleShell → fromOrigin: `return isNavigation(request) ? fetch(request) : fetch(request.url, { cache: \"no-cache\" });` with `setTimeout(() => resolve(null), NET_TIMEOUT_MS)`. `@font-face { font-family: \"Fraunces\"; … font-display: swap; src: url(\"fonts/fraunces-variable.woff2\") }` ×3. index.html has `<link rel=\"stylesheet\" href=\"styles.css\">` and no `<link rel=\"preload\" as=\"font\">`.",
  "why_subtle": "`swap` is the textbook choice and the fonts are self-hosted, so it looks done; the forced revalidation in the worker is what turns a one-time FOUT into an every-launch one.",
  "fix_sketch": "Add fonts/ to SHELL (and to prepare-dist's copy list); in sw.js serve content-addressed immutable assets (fonts, icons) cache-first from the current generation, network only on miss; `<link rel=\"preload\" href=\"fonts/fraunces-variable.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>` for the two roman faces; consider `font-display: optional` for the italic so it never causes a late swap.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the code is as the finding describes. In tools/ci/generate-manifest.mjs, SHELL is exactly index.html, app.js, search-engine.js, styles.css, manifest.json, icon-180.png and icon-512.png, with no fonts/. styles.css:190-210 has three @font-face rules with font-display: swap pointing at fonts/*.woff2, and all three files exist in the tree. index.html has only `<link rel=\"stylesheet\" href=\"styles.css\">` and no font preload. In sw.js, NET_TIMEOUT_MS is 6000 at line 158. Every non-data GET goes to handleShell → fromOrigin → networkFetch, which does `fetch(request.url, { cache: \"no-cache\" })` for anything that is not a navigation. So on the web/PWA path each launch revalidates each font over the network before responding. With swap, a revalidation slower than the tiny block period paints the fallback stack first and then swaps. In a black-holed network the worker waits the full 6 s before handleShell falls back to the cached copy. DECISIONS.md 2026-09-06 (U-01) only rules on self-hosting the fonts, the CSP font-src and the mobile bundle. Nothing there covers precaching or swap-flash behaviour, so this is not deliberate, and it has not been fixed.\n\nThe finding needs three corrections that narrow the impact:\n(1) It says offline the fonts depend on an \"untracked cachePut\". cachePut does store paths the manifest does not track into the current generation, so the dead-zone fallback does work after the 6 s wait. The real gap is that a new deploy's generation starts without fonts until they are fetched again.\n(2) The native Capacitor app is not affected. shouldRegisterServiceWorker() returns false for the capacitor: protocol and native platforms, and tools/mobile/prepare-webdir.mjs:269-271 bundles all three fonts locally. The founder's phone build therefore has no 6 s dead zone and at most a negligible local-file swap. The finding's claim that this is what the founder sees on his phone is overstated.\n(3) A worse adjacent bug the finding missed: tools/web/prepare-dist.mjs's SHELL also has no fonts/, and vercel.json builds from that dist. On the Vercel web deploy the fonts are never shipped, so they 404 and the app shows the fallback typeface permanently rather than flashing.\n\nSeverity: low for the flash and dead-zone mechanism as stated, because it only affects web/PWA users and not the native app the founder uses. The Vercel missing-fonts gap alone would justify medium if that deploy is user-facing.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## perf-6 — The service worker re-hashes and rewrites ~5 MB into CacheStorage on every launch, even when nothing changed

**confirmed** · verifier severity **low** (finder: medium) · perf · `sw.js:452` · L5-boot-states-storage

```json
{
  "id": "perf-6",
  "lens": "perf",
  "title": "The service worker re-hashes and rewrites ~5 MB into CacheStorage on every launch, even when nothing changed",
  "file": "sw.js:452-472 (cachePut), sw.js:418-427 (fromOrigin: `if (res && res.ok) env.waitUntil(cachePut(request, res.clone()))`)",
  "line": 452,
  "severity": "medium",
  "user_visible": "Each open of the web app quietly performs ~5 MB of arrayBuffer copies, SHA-256 digests and Cache API writes (discover.json 2.47 MB, item-tags 0.4 MB, app.js 0.74 MB, client.js 0.2 MB, 26 more modules, styles, fonts…) in the worker — disk and battery churn on a phone, and on iOS Safari Cache API writes are slow and can trip storage pressure; a listener who opens the app ten times a day writes 50 MB for no change.",
  "evidence": "cachePut(): `const expected = await trackedHash(cache, key.url); if (expected) { const buf = await response.clone().arrayBuffer(); const digest = await sha256Hex(buf); if (digest !== expected) return; } await cache.put(key, response);` — the put is unconditional when the digest matches, i.e. the identical verified bytes already stored at install are overwritten with themselves. The fetch API returns the HTTP-cache 200 for a 304 revalidation, so `res.ok` is true on every launch.",
  "why_subtle": "It is invisible in devtools' Network panel and only shows as thermal/battery behaviour and slower launches on a full disk.",
  "fix_sketch": "When `expected` matches, `return` without putting (the install-time verified copy is already there); for untracked files compare ETag/Content-Length/Last-Modified with `cache.match(key)` before writing. Keep the write for a genuinely new body.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked origin/main and the code matches the finding. In sw.js, fromOrigin (~line 418-427) calls `env.waitUntil(cachePut(request, res.clone()))` for every live response where `res.ok` is true. networkFetch (line 394) refetches every non-navigation request with `cache: \"no-cache\"`. When the server answers 304 to that revalidation, fetch() hands back the HTTP-cache entry as a 200, so `res.ok` is true on every load, including when nothing changed. The sw.js header comment says so itself: \"An unchanged file answers 304: a repeat visit costs one round trip and no bytes.\"\n\ncachePut (lines ~452-472) looks up the manifest hash with trackedHash. For a tracked path it reads the whole body with arrayBuffer, computes its SHA-256, and returns early only when the digest does NOT match. When it matches, it falls through to an unconditional `await cache.put(key, response)`. That overwrites the copy install already verified with the same bytes. There is no ETag or cache.match check, so untracked paths are rewritten on every load too.\n\ndocs/DECISIONS.md has no ruling covering this. Its only service-worker entries are about the offline shell and the worker not registering inside the Android shell. The long comment above cachePut explains why mismatched bytes are dropped. It gives no reason for rewriting matching bytes, so this is an oversight rather than deliberate. It has not been fixed at origin/main (latest sw.js-touching commit is 9730b5b).\n\nSeverity: I'm lowering it to low. The listener never sees anything: no UI effect, no error, no delay, because the work runs in waitUntil after the response has already gone back to the page. The cost is background CPU for hashing plus a few MB of Cache API writes on each launch. That means some disk and battery churn, and it is somewhat worse on iOS. The waste is real and the fix is trivial: return when `digest === expected`. I have not verified the finding's ~5 MB total or its per-file sizes.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## perf-7 — The player repaints every play button on the page four times a second, including in the background

**confirmed** · verifier severity **low** (finder: medium) · perf · `player/client.js:2821` · L1-player-transport

```json
{
  "id": "perf-7",
  "lens": "perf",
  "title": "The player repaints every play button on the page four times a second, including in the background",
  "file": "player/client.js:2821 (`backend.addMediaListener(\"timeupdate\", render)`), player/client.js:1438 (render), player/client.js:1519-1530 (syncCardButtons: `document.querySelectorAll(\"[data-play]\")` + paintControl per button), player/client.js:645-649 (paintControl sets aria-label unconditionally), player/client.js:2631 (visibilitychange only flushes positions)",
  "line": 2821,
  "severity": "medium",
  "user_visible": "While anything plays, every ~250 ms the page walks every `[data-play]` button (a show page with 50-100 episode rows, a long Up Next, Search's episode results), rewrites `aria-label` on each, rebuilds the media-session view object, and updates the scrubber — whether or not anything changed and whether or not the tab is visible. Symptoms: scroll stutter on long lists while listening, warm phone during long sessions, background CPU during a 3-hour episode with the app minimised. Apple Podcasts does no UI work while hidden.",
  "evidence": "render(): `syncCardButtons(); … syncMediaSession(); if (foray) { persistForayProgress(); notifyForay(); }` on every timeupdate. syncCardButtons: `document.querySelectorAll(\"[data-play]\").forEach((b) => { … paintControl(b, on ? \"❚❚\" : \"▶\", `${on ? \"Pause\" : \"Play\"} ${title}`); })`. paintControl: `if (label && label !== text) btn.setAttribute(\"aria-label\", label); else btn.removeAttribute(\"aria-label\");` — attribute written every tick. No `document.hidden` check anywhere in render(); the visibilitychange handler at 2631 only calls flushPositions().",
  "why_subtle": "Each write is cheap and diffed on textContent, so profiling a short session shows nothing; it is the product of N rows × 4 Hz × hours, and the lack of a hidden guard, that costs.",
  "fix_sketch": "In render(): `if (document.hidden) { persistForayProgress(); return; }` (positions still flush). Track the last painted `{ playingId, running }` and only touch buttons when it changes; in paintControl compare `btn.getAttribute(\"aria-label\") !== label` before setting. Move `syncMediaSession` to a 1 Hz throttle (setPositionState extrapolates).",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main 9730b5b and the mechanics are as described. client.js:2821 wires `timeupdate` (and play/pause) to render(). render() (around line 1440) has no document.hidden check and calls syncCardButtons(), syncMediaSession() and, in a Foray, persistForayProgress() plus notifyForay() on every tick. syncCardButtons (around 1519) runs document.querySelectorAll(\"[data-play]\") and calls paintControl on every button. paintControl (645-649) guards textContent, but it calls setAttribute(\"aria-label\") every time without comparing to the current value. The visibilitychange handler at 2630-2631 only calls flushPositions() when the page is hidden. I found no ruling in docs/DECISIONS.md about render throttling or hidden-tab work, and none of the recent commits (#746, #744, #742, #735) change this.\n\nThe finding overstates the impact, though:\n- textContent is only written when it changes. Setting aria-label to the value it already has causes no layout, and at most a trivial style invalidation.\n- Walking 50-100 nodes with querySelectorAll at about 4 Hz costs microseconds.\n- syncMediaSession sends its view to media.update, and the comment in render() says media.update writes only when something changed. I did not open that function to check.\n- persistForayProgress is throttled (it takes a `force` flag).\n- On the native app, the WebView is usually suspended or throttled when the app is backgrounded.\n\nScroll stutter and a warm phone from this path alone are unlikely, and I don't believe a user would notice them. What remains is real but small: work that isn't needed, plus aria-label rewrites that could make some screen readers re-announce. That makes it a low-severity cleanup, not a medium user-visible defect. The fix sketch is still sound: skip repaints while hidden, compare before setting aria-label, and repaint the buttons only when the playing id or running state changes.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## perf-8 — Horizontal rails on Home snap back to the first card on every return and every in-place re-render

**confirmed** · verifier severity **low** (finder: medium) · perf · `app.js:13046` · L6-navigation-firstrun-copy

```json
{
  "id": "perf-8",
  "lens": "perf",
  "title": "Horizontal rails on Home snap back to the first card on every return and every in-place re-render",
  "file": "app.js:13046 (rememberScrollPosition stores only `window.scrollY`), app.js:7890 (renderHomeV2 rebuilds `#view.innerHTML` with all rails), app.js:10952 (late ribbon restore re-renders Home), app.js:11267 (a drawer toggle with repaint re-renders), styles.css:3784 (.hv2-hscroll is its own scroll container)",
  "line": 13046,
  "severity": "medium",
  "user_visible": "Swipe 'Forays for you' or 'Playlists for you' to the fourth card, tap it, press ‹: the vertical position is restored (round-1 fix) but the rail is back at card one. Same when the now-playing ribbon restores late, or when a settings switch repaints Home under the drawer. Apple Podcasts keeps shelf offsets across navigation.",
  "evidence": "`navScrollY.set(renderedHash, window.scrollY || 0);` is the only scroll memory; route()/renderCurrentPage() replace `$(\"#view\").innerHTML` wholesale (`$(\"#view\").innerHTML = `<div class=\"home hv2-home\">${homeGreeting()}…${foraysForYouHtml()}${playlistsForYouHtml()}…`), so every `.hv2-hscroll` is a fresh element at scrollLeft 0. restoreNowPlayingRibbon: `if ((restored || late) && isHomeRoute()) renderCurrentPage();`.",
  "why_subtle": "Vertical restore was fixed in round 1 (qa 115) so the page 'remembers where you were' — except sideways, which is the axis the Home rails actually use.",
  "fix_sketch": "Extend the scroll memory to `{ y, rails: { [sectionClass]: scrollLeft } }` captured in rememberScrollPosition (one querySelectorAll on the throttled tick) and re-applied in pageDidPaint()/route() after the back-step; for the in-place repaints, patch the changed section rather than rebuilding Home, or carry the offsets across the rebuild.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order to qa 115 / qa 167.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the evidence matches the code. rememberScrollPosition (app.js:13041-13047) keeps only `navScrollY.set(renderedHash, window.scrollY || 0)`. route() (12814+) reads that one Y value, then renderCurrentPage() runs. renderHomeV2 (7887) rebuilds `#view.innerHTML` with the jump-back-in, forays and playlists rails, each a `<div class=\"hv2-hscroll\">` (7637/7815/7854). styles.css:3784 gives `body.ui-v2 .hv2-hscroll` `overflow-x: auto`, so each rail is its own scroll container. The string `scrollLeft` appears nowhere in app.js, so no rail offset is saved or restored. When the user goes back, the page returns to the right height but every rail starts at card one again. The two in-place repaint paths are real as well: restoreNowPlayingRibbon at 10952 (`if ((restored || late) && isHomeRoute()) renderCurrentPage()`) and drawerToggle with `repaint` at 11267. DECISIONS.md has no ruling on rail, shelf or horizontal scroll, and the one styles.css comment that mentions it (line 279) only notes that rails are separate scroll containers. It does not choose to reset them. I rated it low rather than medium. This is a polish and continuity regression with no lost data or broken flow; the user swipes again. The late-ribbon path mostly fires just after the first paint, before anyone has swiped a rail. That leaves back-navigation and drawer switch repaints as the cases people will actually see.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## perf-9 — Incomplete fix of qa 101: on a cold cache the body is still blank under the header until 1 MB of unminified JS has downloaded and parsed

**deliberate** · verifier severity **low** (finder: low) · perf · `app.js:13862`

```json
{
  "id": "perf-9",
  "lens": "perf",
  "title": "Incomplete fix of qa 101: on a cold cache the body is still blank under the header until 1 MB of unminified JS has downloaded and parsed",
  "file": "app.js:13862-13863 (BOOT_LOADING_HTML injected by app.js), index.html:75-79 (sync `<script src=\"search-engine.js\">`, `<script src=\"app.js\">`), tools/mobile/prepare-webdir.mjs:68-79 (minifier exists but only for the shell)",
  "line": 13862,
  "severity": "low",
  "user_visible": "First web launch (or any launch after a deploy, since code is network-first): the topbar paints, then nothing for as long as search-engine.js (139 KB / 52 KB gz) and app.js (737 KB / 258 KB gz) take to arrive and parse — only then does 'Loading 4a…' appear. Measured comment ratio: app.js 65 %, player/client.js 73 %, search-engine.js 81 %, styles.css 61 % — roughly 1.3 MB of the 1.7 MB of text the web ships is comments the tokenizer still has to scan on a phone; GH Pages serves the commented source unchanged.",
  "evidence": "`const view = $(\"#view\"); if (view && !view.firstElementChild) view.innerHTML = BOOT_LOADING_HTML;` — first line of init(), i.e. after app.js has fully downloaded and parsed. index.html: `<main id=\"view\"></main>` is empty. prepare-webdir.mjs header: \"comments and whitespace stripped and EVERY IDENTIFIER KEPT (minify.mjs) … Pages serves the commented source\".",
  "why_subtle": "The round-1 boot line exists and works once app.js runs, so the fix looks complete; the blank it left is the JS download itself, which a warm cache hides during testing.",
  "fix_sketch": "Ship a static `<div class=\"page\" data-boot-static><p class=\"note\">Loading 4a…</p></div>` in index.html and have app.js replace it with its own `data-boot-loading` marker (the webview probe keeps its 'app.js ran' proof by requiring the app.js marker or a rendered page, and refusing the static one). Run the existing tools/mobile/minify.mjs over app.js, search-engine.js, player/*.js and styles.css in tools/web/prepare-dist.mjs for the Vercel/Pages build, regenerating the manifest after minifying.",
  "suspected_deliberate": true,
  "relation_to_round1": "incomplete fix of qa 101 / persona 43",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The facts in the finding are correct at origin/main. index.html has an empty `<main id=\"view\"></main>`, followed by synchronous `<script src=\"search-engine.js\">` (138,819 bytes) and `<script src=\"app.js\">` (736,875 bytes). BOOT_LOADING_HTML is defined at app.js:13847 and painted at app.js:13867 as the first statement of init(). That means \"Loading 4a…\" only appears after both scripts have downloaded and parsed. The minifier runs only in tools/mobile/prepare-webdir.mjs, and tools/web/prepare-dist.mjs copies files byte-identical.\n\nBoth halves of the complaint are recorded choices, though, not oversights.\n\n1. Where the loading text is painted. The comment right above the paint in init() says: \"Painted HERE rather than shipped in index.html, deliberately: tools/mobile/webview-probe.mjs certifies a device launch partly by `#view` having children, as proof app.js ran under the shell's CSP. Static markup would satisfy that with app.js dead.\" The finding's fix proposes a two-marker version of that same trade-off, which is a redesign of a deliberate choice, not a missed piece of the fix.\n\n2. Shipping the commented source. docs/DECISIONS.md, entry 2026-09-04 (\"mobile bundle ... minified; the minifier lives in `tools/mobile/`\"), says: \"The web is untouched — the repo root stays dependency-free and no-build, and GitHub Pages keeps serving the fully commented source.\" It also rules out putting the minifier in the repo root (\"never\"), because a no-build root is what keeps the keyless Pages deploy a plain checkout (pinned by shell-invariants.test.mjs). The founder approved this. The prepare-webdir.mjs header says the same thing.\n\nThe \"incomplete fix of qa 101 / persona 43\" framing also overstates the gap. According to the init() comment, round 1 was about a blank body lasting as long as roughly 3.5 MB of JSON took to fetch on a cell connection. That is fixed: the loading text now paints before the first await. What remains is the time to fetch and parse about 310 KB gzipped of script. On a cold or post-deploy load that is a short blank body under the header, typically under about a second on 4G, so the impact is real but minor.\n\nVerdict: deliberate. Severity: low.",
  "merged_ids": [],
  "lane": null
}
```

## perf-10 — Every Up Next reorder tap rebuilds the whole page and re-snapshots the entire 2,167-item pool

**confirmed** · verifier severity **low** (finder: low) · perf · `app.js:8631` · L3-queue-and-native-surfaces

```json
{
  "id": "perf-10",
  "lens": "perf",
  "title": "Every Up Next reorder tap rebuilds the whole page and re-snapshots the entire 2,167-item pool",
  "file": "app.js:8631, 8643, 8654 (bindUpNextReorder: `renderQueue()` per up/down/remove tap), app.js:8519 (`fullPool(); // populate itemIndex/poolIds`), app.js snapshot() (17 fields copied per item)",
  "line": 8631,
  "severity": "low",
  "user_visible": "With a long queue (the app allows unbounded Up Next), each ▲/▼ tap re-templates every row via innerHTML, re-allocates 2,167 snapshot objects, rebinds every button, and then scrolls to compensate — a visible hitch per tap and a flash of the pressed button losing its active state; on a 100-row queue on a mid-range phone it is a noticeable stutter per tap.",
  "evidence": "`btn.addEventListener(\"click\", (e) => { … moveQueueItem(id, -1); renderQueue(); afterQueueMove(id, -1, top); });` and renderQueue(): `fullPool(); const rows = queueRows(); $(\"#view\").innerHTML = …rows.map((r, i) => upNextRow(r, i, rows.length)).join(\"\")…; bindPickLogging…; bindStars…; bindPlay…; bindUpNextReorder…`. fullPool(): `for (const item of (state.discover?.items || [])) { … pool.push(snapshot(item.id, item)); }` — rebuilt on each call (17 call sites).",
  "why_subtle": "Fine at 5 rows, which is what everyone tests with; it degrades linearly with the queue the app lets you build.",
  "fix_sketch": "Memoise fullPool() on `state.discover` identity + family-mode flag (invalidate in the two writers); in the reorder handlers move the two `.up-next-row` nodes and renumber `.q-num` instead of re-rendering; disable the ▲ on row 1 / ▼ on the last row from the moved state.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main app.js and the code matches the finding. Each tap on ↑, ↓ or ✕ in bindUpNextReorder (around lines 8622-8665) calls moveQueueItem or removeFromQueue, then renderQueue(). renderQueue (line 8517) calls fullPool() at line 8519, rewrites the whole #view with innerHTML over every upNextRow, and then re-binds pick logging, stars, play and reorder. fullPool (line 702) is not memoised: it rebuilds the pool on every call and runs snapshot() for every session episode plus every item in state.discover.items. data/discover.json on main has 2167 \"id\" occurrences, which matches the finding's count, though that is a raw grep and may not equal the number of items. snapshot() copies about 20 fields per item and writes each one to state.itemIndex. docs/DECISIONS.md has no ruling on Up Next rendering performance; its Up Next Stage 1 entry covers product behaviour only.\n\nThe code comment above queueButtonFor says \"The render stays (it is the honest way to repaint a reordered list)\". That keeps the full re-render on purpose, but for correctness, and it does not address cost. So it does not make this finding deliberate.\n\nThe finding overstates what the user sees. afterQueueMove already moves focus to the same episode's button in its new row, scrolls by exactly how far that button moved, and announces the new position. So the claims about losing focus or active state and the row jumping under the thumb are mostly already handled. What remains is a CPU cost on every tap: about 2.2k small objects allocated plus an innerHTML rebuild of N rows. That is probably a few milliseconds to a few tens of milliseconds on a mid-range phone, and it only becomes a noticeable stutter with a very long queue, which is uncommon. The inefficiency is real, and the memoisation / DOM-swap fix sketch is valid. Severity stays low.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## search-1 — Shows found by the on-device index paint a blank grey square and no byline, and keep them after the endpoints deliver the artwork

**confirmed** · verifier severity **medium** (finder: high) · search · `app.js:6464` · L4-search-create-playlists

```json
{
  "id": "search-1",
  "lens": "search",
  "title": "Shows found by the on-device index paint a blank grey square and no byline, and keep them after the endpoints deliver the artwork",
  "file": "app.js:6464 (mergeShowRows `if (ids.has(s.show_id)) continue;`), app.js:2410 (showArtworkUrl), search-engine.js:2134 (parseShowIndex: title/id/rank/curated only)",
  "line": 6464,
  "severity": "high",
  "user_visible": "Type \"daily\": the top rows (the index's prefix hits, i.e. the strongest matches) are blank grey squares with no publisher line, while weaker matches further down that arrived only via the catalogue endpoint or Apple have artwork and a byline. Measured on the committed data: all 24 prefix hits for \"daily\" are breadth rows, so 24 blank squares lead the list. The blanks never fill in for the life of the query.",
  "evidence": "`data/show-index.tsv` carries four columns (title, show_id, chart_rank, curated), so `localShowMatches` paints rows with no `artwork_url`/`artist_name`; `showArtworkUrl` falls back to `_artByShowTitle` built from `state.discover.items`, which only holds curated shows. When the catalogue pass returns the same show_id with `artwork_url`, `mergeBreadth` writes it to `state.breadthShowCache` but `mergeShowRows` hits `if (ids.has(s.show_id)) continue;` and the painted row is never touched; a shard (`pi:`) copy with art is likewise dropped by the title-stem check. Harness (node:vm, origin/main 9730b5b): after the catalogue reply `{show_id:\"1000001\", artwork_url:\"https://art/deep.jpg\", artist_name:\"Some Publisher\"}` merged, `#sh-results` still contained `show-result-art-blank` for that row, no `deep.jpg`, no byline, while `state.breadthShowCache[\"1000001\"].artwork_url` was set. The comment at app.js:6686-6688 says the richer record \"replaces the index's title-only row\" — it only replaces it in the cache `showById` reads on tap.",
  "why_subtle": "Every row is individually correct and the list never reshuffles, so it reads as a design choice (\"some shows have no art\") rather than a merge that forgot the paint. It is worst on exactly the queries where the local index works best.",
  "fix_sketch": "In `mergeShowRows`/`mergeBreadth`, when an incoming row matches an existing painted row (by id, or by title key for directory rows) and carries `artwork_url`/`artist_name` the painted row lacks, upgrade that painted record in place (same index, so the #684 stability rule holds) and repaint; return additions as before. Alternatively add an artwork column to `show-index.tsv` (budget: ~10k URLs would blow the 400KB gzip budget, so in-place upgrade is the cheaper route).",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Round 1's visual pass (qa 60 \"one artwork treatment\") standardised the blank treatment without asking why the best rows were blank.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b and the core claim holds.\n\n1. The index has no artwork. parseShowIndex (search-engine.js ~2134) reads only title, show_id, chart_rank and curated from data/show-index.tsv. localShowMatches (app.js:5800) paints these prefix rows directly.\n\n2. The fallback cannot fill the gap. showResultRow (app.js:5534) calls showArtworkUrl (app.js:2410). That function only looks up art by title in state.discover.items, the curated/episode pool, so a breadth row gets the `show-result-art-blank` span.\n\n3. The data matches the numbers in the finding. show-index.tsv has 24 rows starting with \"daily\" and none is curated. In data/catalog-breadth.json all 19,787 breadth rows carry artwork_url, including all 48 \"daily*\" titles. So the catalogue endpoint (searchBreadthShows / breadthCatalog.ts, which passes artwork_url through) does return art for these same shows.\n\n4. The art is dropped on merge. mergeBreadth (app.js:6690) writes each row to state.breadthShowCache. It then calls mergeShowRows, which does `if (ids.has(s.show_id)) continue;` (app.js:6464) for rows already painted. Only additions are appended. No code path re-renders an already-painted row from breadthShowCache: the only readers are showById (2297) and the seeding at 3619/3660. The comment at 6686-6688 says a richer record \"replaces the index's title-only row\". It does that only in the cache that is read on tap, not in the painted list.\n\n5. So the strongest (prefix) matches stay grey for the whole query, while the catalogue's word-start and substring additions below them show art.\n\n6. No docs/DECISIONS.md ruling covers this. The \"one artwork treatment\" entry standardises how the blank looks, not why these rows are blank. It has not been fixed on main.\n\nCorrection: the byline part is overstated. The committed catalogue rows have no artist_name (0 of 48 \"daily\" rows, and the comment at 5526 says so). Catalogue rows therefore never bring a byline, so \"weaker rows have a byline\" only holds for Apple or shard rows. The artwork half is the real defect.\n\nSeverity: I'd set medium, not high. Nothing breaks: tapping a row resolves through showById and breadthShowCache, where the art does exist. But it hits almost every breadth search, and it is the top of the list.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-2 — "Create a playlist about X" is offered exactly when the build is guaranteed to fail — a one-tap dead end

**confirmed** · verifier severity **high** (finder: high) · search · `app.js:7004` · L4-search-create-playlists

```json
{
  "id": "search-2",
  "lens": "search",
  "title": "\"Create a playlist about X\" is offered exactly when the build is guaranteed to fail — a one-tap dead end",
  "file": "app.js:7004 (createPlaylistCtaHtml) → app.js:7020-7033 (bindCreatePlaylistCta) → bindPlaylistFormSubmit / buildPlaylist",
  "line": 7004,
  "severity": "high",
  "user_visible": "Search \"joe rogan\", \"npr\", \"taylor swift\" or \"knitting\": under the shows a violet button says \"Create a playlist about “joe rogan”\". Tapping it jumps to the Create/Playlists page, shows \"Building…\", then \"Not much on \"joe rogan\" yet — try different words.\" Every time. Meanwhile a query the scorer CAN build from (\"fusion energy\", \"meditation\") shows no button at all.",
  "evidence": "`createPlaylistCtaHtml` returns the CTA only when `topicSearchStatus(query).status === \"empty\"`. The tap dispatches `#pl-form` submit → `buildPlaylist(query)` → the same `scoredResultsFor` (same `searchCache` entry) → `classifyResults` → the same \"empty\" → note \"Not much on … yet\". Harness over the real `data/discover.json` + `item-tags.json` + `semantic-index.json`: joe rogan / npr / taylor swift / knitting → status=empty, ctaShown=true, buildPlaylist=empty, suggestions=[]; call her daddy / crime junkie / fusion energy → status=ok, ctaShown=false, build=ok. The mockup's CTA was \"Create a Foray about X\" (a Foray can be made about anything); the D8 retarget to Playlist kept the empty-only condition.",
  "why_subtle": "The button is styled as the page's one primary action and the failure happens on a different page a second later, so it reads as \"search worked, playlists are just thin\" rather than \"this button can never succeed\".",
  "fix_sketch": "Invert the gate: show the CTA when `topicSearchStatus` is ok/sparse AND no own/generated playlist already matches (the one-tap-yields-a-real-playlist case); on \"empty\" show nothing, or a Create-tab link worded as a Foray/topic prompt rather than a playlist promise. Keep `test/search-playlists.test.js` cases 399/422 but flip their expectations.",
  "suspected_deliberate": true,
  "relation_to_round1": "New. qa 128 (phantom history step from this CTA) was refuted and is unrelated to the gate.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read origin/main app.js directly. createPlaylistCtaHtml (7003) returns the CTA only when topicSearchStatus(query).status === \"empty\". topicSearchStatus (4363) and buildPlaylist (4370) both go through scoredResultsFor(query), which uses the same searchCache key ([query, familyMode(), _interestsGen]), and then the same SearchEngine.classifyResults(..., {listenedShows}). The `null` (no groups/filters) branch returns \"empty\" in both functions too. bindCreatePlaylistCta (7020) navigates to #/playlists, fills in #pl-input and dispatches submit, so bindPlaylistFormSubmit runs buildPlaylist(query) with the trimmed query. The pool, cache entry, family mode and listened shows are all unchanged between the two calls, so the build is effectively certain to come back \"empty\". It then shows \"Not much on \\\"X\\\" yet — try different words.\" or, at best, \"try <suggestions> instead\". It never builds a playlist.\n\nThe user does see this. renderPlaylistSearchResults is called on every Shows search (6846). ui2On survived the cutover as `return true` and the cp_ui_v2 flag is retired, so this is the live path. It triggers whenever no own or generated playlist matches, which the code's own comment calls \"the COMMON case\" (e.g. show-name searches).\n\nI checked whether this is a deliberate ruling. docs/ui-transition-plan.md U-05 does specify the gate (\"CTA appears when a query has no strong result, retargeted from Foray to Playlist per D8\"), and test/search-playlists.test.js enforces it. So the gate condition is deliberate. The plan does not accept or mention the outcome, though. It carried over the \"Create a Foray about X\" condition, where a Foray could be made about anything, to a Playlist that is built from the very scorer that just said \"empty\". I found no DECISIONS.md entry accepting a CTA that always fails.\n\nI did not re-run the finding's harness for the specific queries (joe rogan, npr, etc.). That doesn't change the verdict, because the dead end follows from the code for any query where the CTA appears. The mitigation is small: suggestAdjacentTopics can sometimes put alternative words in the failure note.\n\nSeverity high: a prominent violet primary button, offered on a common search path, that never works.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-3 — The return key does not dismiss the iOS keyboard from the search field, and the keyboard is the wrong keyboard

**confirmed** · verifier severity **medium** (finder: medium) · search · `app.js:2987` · L4-search-create-playlists

```json
{
  "id": "search-3",
  "lens": "search",
  "title": "The return key does not dismiss the iOS keyboard from the search field, and the keyboard is the wrong keyboard",
  "file": "app.js:2987-2992 (#sh-form submit handler), app.js:2928 (#sh-input markup), app.js:3738 (show-page episode input)",
  "line": 2987,
  "severity": "medium",
  "user_visible": "On the phone, typing a query and tapping the keyboard's key labelled \"return\" (not \"Search\") leaves the keyboard up; the only ways down are ✕ (which also erases the query), a downward scroll (needs enough results), or a tap on dead space. The keyboard also autocapitalises and autocorrects host names (\"fridman\" → \"Friedman\").",
  "evidence": "The submit handler is `e.preventDefault(); const query = …; renderShowSearchResults(query);` — no `blur()`. With `preventDefault` on submit, WebKit keeps the field focused and the keyboard up. The comment at 2912-2916 and 2967-2971 states the opposite (\"return is how the keyboard is DISMISSED from inside the field\"), and the Go button was deleted on that premise (founder 2026-09-14). `#sh-input` is `type=\"text\"` with no `enterkeyhint`, `autocorrect`, `autocapitalize` or `spellcheck` attributes (grep: the only `spellcheck=\"false\"` in app.js are two unrelated inputs at 11798/12507). Apple Podcasts' field shows a \"Search\" key, no autocorrect. Not verifiable on a device from this audit; platform behaviour, not a harness result.",
  "why_subtle": "On desktop Enter looks fine (no keyboard), the code comments assert it works, and on the phone the listener just assumes 'this app makes me tap elsewhere'.",
  "fix_sketch": "In the submit handler add `$(\"#sh-input\").blur()` after running the search (blur → `updateShowBrowseVisibility` brings the tab bar back through the existing predicate; the query and results stay). Add `enterkeyhint=\"search\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\"` to both search inputs (keep `type=\"text\"` to avoid WebKit's native clear button beside the custom ✕). Pin with test/search-page-chrome.test.js.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order with the 2026-09-14 Go-button deletion.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked origin/main (latest app.js commit 9730b5b) and the code matches the finding. The #sh-form submit handler (app.js:2987-2992) does `e.preventDefault(); const query = $(\"#sh-input\").value.trim(); if (!query) return; renderShowSearchResults(query);` and nothing in it blurs the field. The field itself has no keydown handler for Enter; its only keydown handler (line 3093) handles Escape. The only places that call blur() on the field are dismissShowSearch (line 2835, which also clears the query and is reached by the ✕ button or Escape) and maybeDismissKeyboardOnScroll (line 13316, which fires only on a downward scroll past a threshold, after 350ms). So the finding's list of ways to close the keyboard is accurate.\n\nThe comments at 2911-2916 and 2967-2971 say the return key is how the keyboard is dismissed from inside the field, but the handler does nothing to make that true. The premise behind deleting the Go button therefore rests on behaviour the code does not implement.\n\n#sh-input (line 2928) is `type=\"text\"` with no enterkeyhint, autocorrect, autocapitalize or spellcheck attributes. The show page's episode input (line ~3738) is the same. The only spellcheck settings in app.js are at 11798 and 12507, on unrelated inputs.\n\ndocs/DECISIONS.md has no ruling on keyboard, return key, Go button, enterkeyhint or autocorrect, so this is not deliberate. It has also not been fixed.\n\nOne wording error in the finding: an iOS text input inside a <form> usually shows a \"go\" key, not \"return\". That does not change the result, because the handler still never blurs the field.\n\nI could not test on a device. The claim that WebKit keeps the keyboard up after a submit that calls preventDefault and never blurs is standard platform behaviour. Severity medium: nothing breaks and no data is lost, but it is the main search interaction on the phone, and the design explicitly relies on the return key closing the keyboard. The fix sketch (blur in the submit handler, plus the four input attributes) looks correct.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-4 — Incomplete fix of adversarial-review defect 2: a degraded catalogue reply is cached as the answer and counted as 'answered', so "No shows found" is permanent with no Try again

**confirmed** · verifier severity **low** (finder: medium) · search · `app.js:6719` · L4-search-create-playlists

```json
{
  "id": "search-4",
  "lens": "search",
  "title": "Incomplete fix of adversarial-review defect 2: a degraded catalogue reply is cached as the answer and counted as 'answered', so \"No shows found\" is permanent with no Try again",
  "file": "app.js:6715-6729 (catalogue pass `.then`)",
  "line": 6719,
  "severity": "medium",
  "user_visible": "When `api/shows/search` answers 200 `{shows:[], degraded:true}` (breadth file unreadable, cold-start failure), a query with no curated hit shows \"No shows found for \"x\".\" with no \"Part of this search didn't load / Try again\", and every retype of that query for the rest of the session answers from the cached empty reply.",
  "evidence": "`if (data) { …showBreadthQueryCache.set(cacheKey, breadthShows); } … showPassDone(!data);` — `data` is non-null for the degraded shape, so it is cached and reported as not-failed. The directory pass 40 lines below does it right: `const answered = !!data && !data.degraded && !(data.fallthrough && data.fallthrough.error)` and caches/reports on `answered` (the 2026-09-12 defect-2 fix, app.js:6770-6808). Harness with the catalogue stub returning `{shows:[],degraded:true}`: note = \"No shows found for \"zzqx\".\", `showBreadthQueryCache.has('zzqx')` = true, `showSearchSettled.failed` = false, empty-offer hidden. `api/shows/search.ts:224-225` sends exactly this shape (with `no-store`, which the client's `cache:\"no-cache\"` + in-memory cache defeats anyway).",
  "why_subtle": "The same bug was found and fixed for the sibling request in the same function; the fixture that models the degraded shape was added for the directory only.",
  "fix_sketch": "Mirror the directory pass: `const answered = !!data && !data.degraded;` cache only when answered, `showPassDone(!answered)`, and `netHits: answered ? breadthShows.length : null`. Add a `catalogueDegraded` fixture to test/show-search-fallthrough.test.js's `mount`.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the 2026-09-12 adversarial review defect 2 (pre-round-1, but round 1's qa 98/102 'no No results until every endpoint replied' relies on `failed` being honest).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In app.js around lines 6715-6729, the catalogue pass caches `data?.shows || []` whenever `data` is non-null and calls `showPassDone(!data)`. A 200 `{query, shows:[], degraded:true}` reply, which api/shows/search.ts sends from its catch block with no-store, is therefore written into the session-lived showBreadthQueryCache, reported as not failed, and settled with netHits 0 and path \"local+net\". The directory pass in the same function uses the `answered` test (`!!data && !data.degraded && !fallthrough.error`). The catalogue pass does not, so the defect-2 fix was applied to only one of the two passes. I found no DECISIONS.md ruling that covers it.\n\nThe user-visible impact is much smaller than the finding claims. The directory pass calls the same endpoint with `&fallthrough=1`, and `searchBreadthShows` throws before the fallthrough branch, so that call returns the same degraded shape. For any query whose key is at least 3 characters (SHOW_DIRECTORY_MIN_QUERY_LENGTH = 3), the directory pass sees `answered=false`. It calls `showPassDone(true)`, and because showPassFailed is sticky across passes, the empty state DOES show \"Part of this search didn't load\" with Try again. The directory result is not cached either. On a retype or Try again it runs again, and once the breadth file reads again its reply contains the catalogue rows merged with Apple's (\"MERGED, NEVER REPLACED\"). So the stale cached empty catalogue answer does not make \"No shows found\" permanent for queries of 3+ characters. The finding's harness probably stubbed only the catalogue call as degraded, a state the real server can't produce except through a split cold start across instances.\n\nThe claimed behaviour, no Try again and a permanently cached empty reply, fully holds only for 1-2 character queries (the directory pass is skipped). It also holds in the narrow case where the two requests reach different serverless instances and only one of them fails. What remains is a real inconsistency: a dishonest `failed`/netHits for this pass and a poisoned cache entry. It is worth the one-line fix in the finding's sketch, but it is low severity.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-5 — Tapping the Search tab throws the search away (second-order with qa 126): only ‹ keeps the query, the tab does not

**confirmed** · verifier severity **medium** (finder: medium) · search · `app.js:11178` · L4-search-create-playlists

```json
{
  "id": "search-5",
  "lens": "search",
  "title": "Tapping the Search tab throws the search away (second-order with qa 126): only ‹ keeps the query, the tab does not",
  "file": "app.js:11178-11184 (onTabBarClick), app.js:12756-12757 (router: #/shows/q vs #/shows)",
  "line": 11178,
  "severity": "medium",
  "user_visible": "Search \"lex\", open a result, then tap the Search tab (the natural way back on a phone): you land on the empty A-Z browse page — query, results and scroll position gone. Tapping the Search tab while the results themselves are on screen (`#/shows/q/lex`) also wipes them. In Apple Podcasts the active tab pops back to the search you left.",
  "evidence": "`onTabBarClick` only special-cases an exact hash match (`if (currentHash(a.getAttribute(\"href\")) !== currentHash()) return; // ordinary navigation`). The tab's href is the literal `#/shows`; from `#/show/<id>` or `#/shows/q/lex` that differs, so the browser navigates to `#/shows` and `renderAllShows()` runs with `initialQuery=\"\"`, which calls `supersedeShowSearch()` and paints the resting state. Round 1 (qa 126/127/133) made the query live in `#/shows/q/<q>` so that ‹ restores it; the tab bar — added the same day with the tap-to-top rule — was not taught that route.",
  "why_subtle": "‹ works, so the fix looks complete; the tab is the gesture the founder actually uses and it goes through a different code path.",
  "fix_sketch": "Remember the last Search-tab hash (`#/shows/q/<q>` or `#/shows`) when leaving it; in `onTabBarClick`, if the tapped tab is already the active tab (`tabForHash(location.hash) === a.dataset.tabKey`) and the hash is not that tab's root, navigate to the remembered hash instead of the root; if it is already on `#/shows/q/*`, treat as same-tab (scroll to top). Pin in test/category-browse.test.js next to the tabForHash cases.",
  "suspected_deliberate": false,
  "relation_to_round1": "Regression-adjacent to qa 126 (fixed): the fix covers ‹ but not the tab.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js and the code matches the finding. The Search tab's href is the literal \"#/shows\" (TAB_ROUTES, around line 11136). onTabBarClick (11168-11174) only steps in when currentHash(href) exactly equals currentHash(). From #/show/<id>, #/episode/..., or #/shows/q/lex that check fails, so the browser follows the link to #/shows. The router then runs renderAllShows() with no argument (12757, after the #/shows/q/ case at 12756). renderAllShows calls supersedeShowSearch() and only seeds the field when the query is not empty (around lines 2998-3010), so the page shows the empty resting browse view. Query, results and scroll position are lost.\n\nThe tab bar always renders. Since the U-11 cutover, ui2On() always returns true and the tab bar's off-branch was retired, so every user hits this path.\n\ntabForHash already treats #/shows/q/* as the Search tab, so the bar knows the tab is active. The click handler just doesn't use that. The worst case is on the results page: tapping the lit Search tab should scroll to the top, the way the same-tab rule's own comment describes, but it wipes the search instead.\n\ndocs/DECISIONS.md does not cover this. D3 records the four-tab bar and says switching tabs is not a back step, but nothing says a tab tap should reset Search to an empty root. No fix is on main.\n\nOne caveat: popping to the tab's root from a pushed page (#/show/<id>) is standard iOS behaviour. That part is defensible, as long as the root keeps the query. The clearer defect is losing the query when you tap the active tab from #/shows/q/<q>. ‹ still restores the query, and the query can be retyped, so this is annoying rather than blocking. Medium severity.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-7 — Re-running the same query (trailing space, or return while passes are in flight) repaints local-only, dropping merged rows and doubling requests

**confirmed** · verifier severity **medium** (finder: medium) · search · `app.js:6851` · L4-search-create-playlists

```json
{
  "id": "search-7",
  "lens": "search",
  "title": "Re-running the same query (trailing space, or return while passes are in flight) repaints local-only, dropping merged rows and doubling requests",
  "file": "app.js:6851-6864 (onShowSearchInput), app.js:6869-6875 (renderShowSearchResults)",
  "line": 6851,
  "severity": "medium",
  "user_visible": "Type \"lex\" and let it settle (~30 rows), then type a space: the list collapses to the local rows for 250 ms and then re-grows. Type \"lex\" and hit return within ~1 s: the rows that were about to land are discarded, the same two endpoint requests are fired again, and the list stays local-only for another full round trip.",
  "evidence": "Both paths trim the query, bump `showSearchToken`, and call `paintShowSearchLocal` → `paintShowResults` which writes `results.innerHTML` wholesale from `localShowMatches` only; merged rows only come back when the (cancelled/rescheduled) tick re-merges from the caches. Harness: after \"deep\" settled with a merged row \"Deep Dive Daily\", typing \"deep \" → row absent immediately, present after 350 ms. Enter at t≈300 ms with a 400 ms catalogue stub → 2 catalogue requests, list local-only until t≈950 ms. Nothing checks `showSearchPainted.query === query`.",
  "why_subtle": "A 250 ms flash on the one keystroke (space) whose result should be identical, and a slower-than-expected settle after return, both look like network jitter.",
  "fix_sketch": "In `onShowSearchInput` and `renderShowSearchResults`, if the trimmed query equals `showSearchPainted.query` for the current token, skip the local repaint; on Enter, do not bump the token — clear the debounce timer and run `runShowSearchCostly` immediately only if a tick was pending, otherwise no-op (blur only, see the return-key finding). Pin with a 'same query, no shrink' case in test/show-search-fallthrough.test.js.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order with #684's append-only stability rule (the repaint is now the only thing that makes the list shrink).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b and the evidence holds.\n\n- **Typing path (app.js:6851-6864).** `onShowSearchInput` trims the query, increments `showSearchToken` and cancels the debounce timer. It then always calls `paintShowSearchLocal` (6509), which calls `paintShowResults` (6268). That function writes `showSearchPainted = {token, query, rows: shows}` and rebuilds `#sh-results` from `localShowMatches` only. Nothing compares the new query with `showSearchPainted.query`. Typing \"lex\" and then a space gives the same trimmed query but a new token, so the painted list falls back to local-only rows. The merged rows come back only when the 250 ms tick runs `runShowSearchCostly`, which re-merges from `showDirectoryQueryCache` and the other caches (line 6762). So the list really does shrink and re-grow. It is a 250 ms flicker, not lost data.\n- **Enter / Go path (2987-2991 → 6869-6875).** `renderShowSearchResults` increments the token, clears the timer, repaints local-only and calls `runShowSearchCostly` straight away. If the earlier tick's fetches are still in flight, their token no longer matches, so `mergeBreadth` is skipped (6798, 6839) and nothing reaches the cache in time. The new pass then misses the cache and fetches again. `fetchApiJson` does not deduplicate: it uses `cache: \"no-cache\"` and nothing tracks in-flight requests. The result is two catalogue and two directory requests, with the list local-only for another full round trip.\n\nThe \"same query, new token\" case is described in the comment at 5660-5663, but only as a merge-safety note. No code or ruling says a same-query repaint should be skipped. Grepping docs/DECISIONS.md for \"same query\", \"trailing space\" and \"repaint\" found no ruling on this, and it has not been fixed.\n\n**Severity: medium.** Pressing the keyboard's search/return key right after typing is common on a phone, and it costs a visible collapse of the merged rows (directory rows are the majority of the list under P-02) plus a duplicate pair of endpoint calls. It is not lost data, though: the list recovers, and the trailing-space case is only a 250 ms flicker.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-8 — Apple episodes starred, queued or played from Search carry no artwork, so the lock screen and car fall back to the 4a icon (incomplete fix of the 2026-09-21 car-art report)

**confirmed** · verifier severity **medium** (finder: medium) · search · `app.js:7331` · L4-search-create-playlists

```json
{
  "id": "search-8",
  "lens": "search",
  "title": "Apple episodes starred, queued or played from Search carry no artwork, so the lock screen and car fall back to the 4a icon (incomplete fix of the 2026-09-21 car-art report)",
  "file": "app.js:7330-7339 (paintEpisodeSearchResults rowFor: snapshot without artwork_url); api/episodes/search.ts:120-172 (row shape has no artwork; mapAppleHit drops artworkUrl); player/client.js:2339 reads current.artwork_url",
  "line": 7331,
  "severity": "medium",
  "user_visible": "Search \"huberman\", tap ▶ or + on an episode in the Episodes section: Now Playing, Up Next and the lock screen/CarPlay show the 4a icon instead of the show's square. The same episode reached from the show page shows the art.",
  "evidence": "`snapshot(id, { show, title, hook, audio_url, duration_min, duration_sec, topics: [] })` — no `artwork_url`. The endpoint's `EpisodeSearchResult` has no artwork field and `mapAppleHit` ignores Apple's `artworkUrl600`. The founder's report was fixed in `fullCatalogueRowToEpRowItem` (app.js:3159 `artwork_url: show.artwork_url || null`) for show pages only; the Search-page mapping is the other producer of playable breadth rows and was not touched. The player publishes `showArtworkUrl: current.artwork_url ?? null` (client.js:2339).",
  "why_subtle": "The Episodes rows themselves show no artwork (epRow has none), so nothing on the Search page looks wrong; it surfaces later on the lock screen, where the founder has already reported and 'fixed' it.",
  "fix_sketch": "In `rowFor` for remote rows: `artwork_url: showArtworkUrl(showById(ep.show_id)) || null` (curated and cached breadth shows resolve locally today), and carry Apple's `artworkUrl600` through `mapAppleHit`/`EpisodeSearchResult` for the rest. Extend test/episode-search.test.js with an artwork assertion.",
  "suspected_deliberate": false,
  "relation_to_round1": "Incomplete fix of the founder's 2026-09-21 field report (fixed for `api/shows/:id/episodes` rows only).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against the code at origin/main, and the finding holds.\n\n- **The Search rows drop the artwork.** In app.js, `paintEpisodeSearchResults` has a helper `rowFor` (lines 7317-7341). For a remote Apple row it creates the id `apple:${show_id}:${guid}` and calls `snapshot(id, {show, title, hook, audio_url, duration_min, duration_sec, topics: []})` with no `artwork_url`. `snapshot()` (line 647) then stores `artwork_url: src.artwork_url ?? null`, so the saved item has `artwork_url: null`.\n- **The endpoint has no artwork to give.** In api/episodes/search.ts, `EpisodeSearchResult` (lines 120-130) has no artwork field. `AppleEpisodeHit` does not declare `artworkUrl600`, and `mapAppleHit` does not map any artwork.\n- **The player has no fallback.** player/client.js line 2339 publishes `showArtworkUrl: current.artwork_url ?? null` for a single episode. Lines 1561/1569 paint the bar and sheet art from `item.artwork_url` only. So a Search-sourced episode reaches the lock screen and the car with the 4a icon.\n- **The earlier fix only covered show pages.** The 2026-09-21 fix is at app.js:3149-3158, inside the show-page mapping, and it adds `artwork_url: show.artwork_url || null`. Its own comment describes the same symptom this finding reports. The Search path was not changed.\n- **The code comments list the gap without ruling on it.** The comment at app.js:7213 says the endpoint's row is thinner than a stored snapshot (\"no `artwork_url`\") and protects only local rows (`_localSnapshot`). It records the gap but does not decide to leave remote rows without art.\n- **No DECISIONS.md ruling covers it.** The artwork mentions there are about design treatment and the validated-links overlay.\n\nA resolver already exists that the fix could reuse: `showArtworkUrl(showById(...))` at app.js:1215/2412. One nit: local rows are fine because `localEpisodeRow` always supplies `_localSnapshot`, so the bug affects Apple (remote) rows only.\n\nSeverity is medium: the user sees it on a common path, and it is the car/lock-screen complaint the founder already reported, but it is cosmetic and playback still works.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-9 — Local passes and the dedup keys are not diacritic-folded while the shard pass and rankShows are — accented titles miss locally, then arrive late and can duplicate

**confirmed** · verifier severity **low** (finder: low) · search · `search-engine.js:2024` · L4-search-create-playlists

```json
{
  "id": "search-9",
  "lens": "search",
  "title": "Local passes and the dedup keys are not diacritic-folded while the shard pass and rankShows are — accented titles miss locally, then arrive late and can duplicate",
  "file": "search-engine.js:2024 (searchShows via showMatchBucket, raw lowercase), search-engine.js:2180 (prefixSearchShows over unfolded keys), app.js:6106 (normaliseShowTitle)",
  "line": 2024,
  "severity": "low",
  "user_visible": "Type \"cafe\": no on-device hit for \"Café …\" titles (591 index titles contain non-ASCII); the show arrives 0.5-1.5 s later via Apple/shard at the bottom of the list. An Apple \"Café X\" and an index \"Cafe X\" are not recognised as the same show and both render.",
  "evidence": "`searchShows(\"cafe\", [{title:\"Café con Pam\"}]).length === 0` while `rankShows(\"cafe\", same).length === 1` keeps it (folded); `prefixSearchShows(\"cafe\", parseShowIndex(\"Café Society\\t1\\t3\\t0\\n\")).length === 0`. `rankShardRows`/`shardRowText` fold with `foldDiacritics` (the 2026-09-15 review fix) but that fix was applied only on the shard/re-rank side. `normaliseShowTitle` lowercases and strips punctuation but keeps combining marks, and its server twin is pinned equal by test/show-search-fallthrough.test.js.",
  "why_subtle": "Only accented titles are affected and they still appear eventually, so it presents as ranking noise.",
  "fix_sketch": "Fold in `parseShowIndex` (store folded keys) and in `tools/build-show-index.mjs`'s sort key so binary search still agrees; fold the query in `searchShows`/`prefixSearchShows`/`scanShowIndex`; add the NFKD strip to `normaliseShowTitle` and `api/shows/appleShowSearch.ts:normaliseShowTitle` together (the pin test forces both).",
  "suspected_deliberate": false,
  "relation_to_round1": "New; incomplete application of the 2026-09-15 fold fix.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. foldDiacritics (search-engine.js:1833) is used only in rankShows (line 2100-2102) and the shard functions (shardRowText at 2306, rankShardRows at 2355). searchShows (2024), prefixSearchShows (2180) and scanShowIndex (2199) only lowercase the query. parseShowIndex (2134) stores keys as title.toLowerCase() with no folding, so the binary-search prefix pass cannot match \"cafe\" against \"café …\". app.js:5802-5806 routes the on-device path through exactly these functions: searchShows over the curated list, then prefixSearchShows over the index. normaliseShowTitle (app.js:6106) lowercases and collapses non-\\p{L}\\p{N} runs. Combining marks are \\p{M}, so it strips them rather than keeping them. Precomposed é is \\p{L}, though, so \"Café\" stays \"café\" and does not equal \"cafe\". The dedup gap holds.\n\nThe data backs this up: 591 index titles in data/show-index.tsv contain non-ASCII, including \"Bon Appétit\", \"90 Day Fiancé: Honestly!\" and \"Brainforest Café\". Typing \"bon appetit\" gets no local hit, and the show only arrives later through the shard or Apple path. The one related ruling in docs/DECISIONS.md is D13, which accent-folds for build-time dedupe. It does not treat local-pass non-folding as deliberate, and the foldDiacritics doc comment calls folding \"a pure widening\" it wants \"everywhere showMatchBucket decides a bucket\". So this is an incomplete fix, not a policy.\n\nOne overstatement: the Apple \"Café X\" versus index \"Cafe X\" duplicate is plausible, but I did not observe it. The missing local hit is the certain part. Impact is limited to a late or lower-ranked result, so severity stays low.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## search-10 — On a first search of the session the index lands after the endpoints and its prefix rows sort under Apple's

**deliberate** · verifier severity **low** (finder: low) · search · `app.js:5785`

```json
{
  "id": "search-10",
  "lens": "search",
  "title": "On a first search of the session the index lands after the endpoints and its prefix rows sort under Apple's",
  "file": "app.js:5785-5794 (repaintShowSearchForIndex appends via mergeShowRows)",
  "line": 5785,
  "severity": "low",
  "user_visible": "First search after install / cleared cache on cellular: the local rows arrive 1-3 s in and are appended beneath the catalogue and directory rows, so the on-device 'best' matches (e.g. the rank-1 prefix hit) sit at the bottom of a list Apple's fuzzy matches lead. Every later search in the session is fine.",
  "evidence": "Harness with a 500 ms index stub and instant endpoints: before index `Deep Dive Daily > Deepak Chopra Presents`; after index `… > Deep History Hour` (a prefix/exact-tier row last). `repaintShowSearchForIndex` merges through `mergeShowRows`, which by the #684 rule only ever appends. The index is 201 KB gzipped and unpinned (fetched on first focus, not precached: DECISIONS 2026-09-12).",
  "why_subtle": "Only the first search of a cold session; by the time anyone investigates, the index is cached and the order is right.",
  "fix_sketch": "When the painted rows for the query came only from the curated pass and the index promise is still pending, hold the endpoint merges (bounded, e.g. until the index resolves or 1 s), or let the index's arrival re-rank just the local tier at the top (it is the tier that was supposed to be first). Alternatively kick `loadShowIndex()` on the Search tab's first render rather than on focus.",
  "suspected_deliberate": true,
  "relation_to_round1": "New; consequence of S-03 lazy load × #684 append-only.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. repaintShowSearchForIndex (app.js:5785-5794) reads what is already painted and passes it to mergeShowRows. mergeShowRows (6453) ranks only the new rows among themselves, and appendShowResults concats them beneath the existing list. The only call to loadShowIndex() is the #sh-input focus handler (3023). It is a lazy, unpinned 201 KB-gzipped fetch, a choice recorded in DECISIONS 2026-09-12 (S-03). So on a first search, if the index resolves after the 250 ms debounce plus the catalogue and directory round trips (101-1407 ms measured), its prefix rows land under the endpoint and Apple rows. On a tile or route search with no focus, the index never loads at all.\n\nThis is covered by the founder-driven #684 rule, written into the mergeShowRows doc comment (6358-6392). That comment names \"the index landing mid-query\" as one of the four callers of THE ONE MERGE RULE. It also states the cost outright: a later row that outranks everything local \"no longer jumps to the top... That is a real ranking concession and it is the intended trade... a list that reshuffles under a thumb is worth less than a slightly worse order that holds still.\"\n\nOne gap remains. The comment justifies the trade by assuming \"the passes arrive best-source-first already (curated local, then the catalogue endpoint, then Apple's directory)\". A late index breaks that assumption, and the comment does not say so. The rule itself is deliberate, but its stated reason does not hold in this narrow window.\n\nImpact: only the first search of a session on a slow link. No rows are lost; they sit lower in the list. Every later search is correct. That fits deliberate/low. The cheap refinement worth noting is kicking loadShowIndex() when the Shows/Search page renders, not on focus.",
  "merged_ids": [],
  "lane": null
}
```

## search-11 — Result-row titles have no line clamp: 152 index titles exceed 80 characters and produce 3-4 line rows beside 1-line rows

**confirmed** · verifier severity **low** (finder: low) · search · `styles.css:1035` · L7-styles-touch-visual

```json
{
  "id": "search-11",
  "lens": "search",
  "title": "Result-row titles have no line clamp: 152 index titles exceed 80 characters and produce 3-4 line rows beside 1-line rows",
  "file": "styles.css:1035-1038 (.show-result-title), app.js:5534 (showResultRow)",
  "line": 1035,
  "severity": "low",
  "user_visible": "Search \"budget\" or \"weight\": some rows are four lines tall (\"Budget Effect: How to Budget, How to Pay off Debt, Save Money, Live on a Budget, Improve your Money Mindset on a single incom\") next to single-line rows; row heights jump and the 44 px art floats mid-row. Apple Podcasts clamps to two lines.",
  "evidence": "`.show-result-title { font-weight: 600; font-size: var(--fs-lg); }` — no `overflow`, `-webkit-line-clamp` or `overflow-wrap`; only the byline is `white-space: nowrap; text-overflow: ellipsis`. Measured over data/show-index.tsv: 152 titles > 80 chars, 14 > 120, max 125 (several already cut mid-word at harvest).",
  "why_subtle": "Only long-tail shows hit it, mostly on generic one-word queries.",
  "fix_sketch": "`.show-result-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }` and keep the full title in a `title=` attribute for hover/VoiceOver.",
  "suspected_deliberate": false,
  "relation_to_round1": "New (round 1's qa 53 fixed row shapes/gaps, not title overflow).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. styles.css:1035-1038 `.show-result-title` has only font-weight and font-size. It has no overflow, line-clamp or overflow-wrap. The only override is body.ui-v2 .show-result-title at line 3363, and it sets font-family only. The byline `.show-result-by` is the only part of the row that gets nowrap and an ellipsis. `.show-result` is flex with `align-items: center`, so the 44px art sits vertically centred next to a tall title block, as the finding says. showResultRow (app.js:5534) renders `show.title` unclamped inside `.show-result-text`, and starredShowRow (app.js:1218) uses the same class, so starred rows are affected too. The stylesheet already clamps elsewhere (line-clamp at lines 786/795/2840/3821), so a clamp is an existing pattern here, not a deliberate omission. docs/DECISIONS.md has nothing on clamping, result rows or long titles. The data claim also holds. Over data/show-index.tsv (10,113 rows), awk counts 164 titles over 80 characters, 16 over 120 and a max of 125. This is close to the finding's 152/14/125; the small gap is probably a byte-vs-character count. The quoted \"Budget Effect: ... on a single incom\" title is in the index word for word, cut mid-word. Severity is low: rows look inconsistent, but nothing breaks and the text does not overflow, because `.show-result-text` has min-width 0 and the text wraps.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## search-12 — An offline (or captive-portal) empty search stacks three contradicting notes under the pill

**confirmed** · verifier severity **low** (finder: low) · search · `app.js:6298` · L4-search-create-playlists

```json
{
  "id": "search-12",
  "lens": "search",
  "title": "An offline (or captive-portal) empty search stacks three contradicting notes under the pill",
  "file": "app.js:6274 (offline note), 6298-6301 (No shows found + empty offer), 6332 (Part of this search didn't load)",
  "line": 6298,
  "severity": "low",
  "user_visible": "Offline, type a show that is not among the curated 220: \"No shows found for \"x\".\" then \"Showing shows available offline\" then \"Part of this search didn't load. [Try again]\" — three lines saying nothing-found, something-shown, and something-failed, over an empty list. On a captive portal the first line arrives only after the 15 s deadline.",
  "evidence": "Harness with `navigator.onLine=false` and rejecting fetch: note=\"No shows found for \"zzqx\".\", `#sh-offline-note.hidden=false`, empty-offer = failedNoteHtml(\"Part of this search didn't load.\"). Each note is written by a different function against a different predicate and none looks at the others.",
  "why_subtle": "Each line is individually true.",
  "fix_sketch": "In `paintShowResults`'s empty branch, when `isOfflineForShardSearch()` collapse to one line: \"You're offline — no saved shows match \"x\".\" with the retry, and hide `#sh-offline-note` when there are no rows to explain.",
  "suspected_deliberate": false,
  "relation_to_round1": "Follows from qa 103 (offline note) and qa 98/102 (settled empty state) landing as separate fixes.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main (9730b5b) myself and the finding holds. In paintShowResults (app.js ~6268-6301), line 6274 sets `#sh-offline-note.hidden = !isOfflineForShardSearch()` whether or not any rows came back. Once the search settles with nothing, the empty branch writes `No shows found for \"${query}\".` and calls paintShowSearchEmptyOffer with `failed: showSearchSettled.failed`.\n\nOffline, two of the three show passes run and one does not:\n- The shard pass skips itself and reports no failure (`showPassDone(false)`, ~6826).\n- The catalogue pass (`fetchApiJson` without fallthrough) gets a rejected fetch, so fetchApiJson catches it and returns null, and the pass reports `showPassDone(!data)`, which is a failure.\n- The directory pass (for queries at or above the minimum length) fails the same way.\n\nSo `failed` is true, and the empty offer shows `failedNoteHtml(\"Part of this search didn't load.\")` with Try again.\n\nIn the DOM the order is #sh-note, then #sh-empty-offer, then #sh-offline-note. The user therefore sees \"No shows found for \"x\".\" / \"Part of this search didn't load. [Try again]\" / \"Showing shows available offline\" over an empty list. That is the same three lines as the finding, in a slightly different order.\n\nThere is one exception. If the query's catalogue result is still in showBreadthQueryCache from earlier in the session, the pass counts as answered and the failure line does not appear.\n\nThe captive-portal half is overstated. There navigator.onLine is usually true, so the offline note stays hidden. After the 15 s API_DEADLINE_MS the user gets two lines (\"No shows found\" plus \"Part of this search didn't load\"), not three. That combination is arguably honest, since the network really did fail.\n\nOn whether it is deliberate: the docstring says the offline note and the results note can both be visible \"in principle\" (S-05/D9). That comment dates from before the failed-pass offer existed and only covers two notes. docs/DECISIONS.md has no ruling covering this. The earlier related fixes, qa 103 (PR #742) and the settled-empty-state work, landed separately and never reconciled the three notes. It has not been fixed.\n\nSeverity is low: the copy contradicts itself and \"Try again\" does nothing useful offline, but nothing is lost or broken.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## p-car-8 — During a network stall the lock screen keeps counting and the car says PLAYING at full rate over silence

**confirmed** · verifier severity **low** (finder: low) · p-car · `player/client.js:2318` · L1-player-transport

```json
{
  "id": "p-car-8",
  "lens": "p-car",
  "title": "During a network stall the lock screen keeps counting and the car says PLAYING at full rate over silence",
  "file": "player/client.js",
  "line": 2318,
  "severity": "low",
  "user_visible": "In a dead zone the mini bar says 'Buffering…' but the head unit shows the clock advancing and PLAYING; when audio returns the lock-screen playhead snaps back several seconds. Apple sets the rate to 0 while buffering so the clock stops.",
  "evidence": "syncMediaSession passes `playbackRate: backend?.rate ?? 1` and `playing: transportIsRunning()` for both branches (client.js:2318/2325 and 2355/2357) and never reads `buffering` (set by setBuffering at :1643). The bar gets BUFFERING_LINE; the OS payload does not. MediaSession's setPositionState cannot carry rate 0 (TypeError, media-session.js:451), but the native payload can (`MPNowPlayingInfoPropertyPlaybackRate`, Swift 678-680).",
  "why_subtle": "The 2026-09-22 stall fix painted the bar and stopped there; the OS surface is painted from a different set of inputs one function away.",
  "fix_sketch": "Add a `buffering` flag to the view; in the shim/native payload write playbackRate 0 (keep state playing) while buffering; on the web MediaSession keep state playing but stop updating position. Cheap, and it makes the car's clock honest.",
  "suspected_deliberate": false,
  "relation_to_round1": "gap left by persona 5 (silent network stall) — the bar was fixed, the car was not.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In player/client.js, syncMediaSession sends `playbackRate: backend?.rate ?? 1` and `playing: transportIsRunning()` on both paths: the Foray branch around line 2318/2325 and the single-episode branch around 2355/2357. Neither path reads the module-level `buffering` flag (declared at :1637, set by setBuffering at :1643, which is driven by the element's `waiting` event at :2846). That flag only reaches paintStatus (:1650), which draws BUFFERING_LINE in the bar and the sheet.\n\nWhile the element waits for data, its playbackRate is still 1 and transportIsRunning() is still true (setBuffering even requires it). So the OS is told PLAYING at full rate and pushes the playhead forward over silence. When audio returns, the next report pulls the playhead back.\n\nOn iOS the rate goes through mediaPositionState (media-session.js:446-453), which turns any rate that is not above zero into 1. The native plugin (mobile/plugins/foray-audio/.../ForayAudioPlugin.swift:315-316) writes rate 0 only when the reported state is not playing. So the native path could carry a 0, but nothing sends one during a stall. One small correction to the finding: that Swift code is at about lines 315-318 on main, not 678-680.\n\nThis is not a documented deliberate choice. media-session.js §4 accepts position drift during the 2.0 s authored seam beat, on purpose. Its reasons are that the beat is authored content and its drift is capped at SEAM_GAP_SEC x rate. A network stall is neither: it has no fixed length, so the drift has no cap. Nothing in docs/DECISIONS.md is about buffering or the lock-screen rate. The client.js comment at :1622 even says the round-1 fix was aimed at \"the car said PLAYING\", but only the bar was fixed.\n\nThe user does see it: after a dead zone the lock-screen or car clock snaps back. Severity stays low: it only shows the wrong time on the display, it corrects itself when audio returns, and position is saved from the app's own playhead, not from the OS.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## p-switcher-2 — Now Playing sheet renders episode notes as dead text: no tappable links, no timestamps, not collapsed — the 2026-09-17 ruling reached only the episode page

**confirmed** · verifier severity **medium** (finder: high) · p-switcher · `player/client.js:1578` · L2-sheets-drawer-gestures

```json
{
  "id": "p-switcher-2",
  "lens": "p-switcher",
  "title": "Now Playing sheet renders episode notes as dead text: no tappable links, no timestamps, not collapsed — the 2026-09-17 ruling reached only the episode page",
  "file": "player/client.js",
  "line": 1578,
  "severity": "high",
  "user_visible": "Reading the notes while listening (the one place an Apple Podcasts user reads them), every URL and every '12:34' chapter time is plain text. The same notes on #/episode/<id> are links and seek buttons and are collapsed under 'Episode notes'; in the sheet a 2,000-word sponsor block is fully expanded under the transport and none of it does anything.",
  "evidence": "player/client.js:1578 `ui.sDesc.textContent = item.description || \"\";` versus app.js:8368-8375 `episodeDescriptionSectionHtml` → `<details class=\"ep-description\">…${episodeDescriptionHtml(item.description, durationSec)}` which turns URLs into `<a>` and timestamps into `<button class=\"ep-ts\" data-ts=…>` (app.js:8310-8366), bound by `bindEpisodeSeeks` (app.js:8412). styles.css:2039 says the sheet is 'the same text' as `.ep-description-text` but only the type scale was unified.",
  "why_subtle": "The sheet's own comment says it follows 'the same order Apple Podcasts uses' and the CSS says 'same text', so it reads as done. The founder's request ('I can click the links, including to time stamps … those then result in jumping to that timestamp') was answered on a page most listeners reach only via the sheet's small 'Episode' link.",
  "fix_sketch": "Build `sDesc` with the same `episodeDescriptionHtml(item.description, durationSec)` (escaped output, so `innerHTML` is safe by construction) inside a `<details>` matching the episode page, and bind `[data-ts]` in the sheet to `seekEpisodeTo` (already the one seek path). Keep `textContent` for Foray items that carry no description.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; extends the founder's 2026-09-17/18 episode-notes rulings to the surface they skipped",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main at 9730b5b and the finding holds.\n\n**What the code does**\n- **Sheet:** `player/client.js:1578` is `ui.sDesc.textContent = item.description || \"\";`, with `hidden` toggled at 1579. `sDesc` is a plain `<p class=\"fp-s-desc\">`, built at line 887 and appended as the last child of the sheet's scroll area at line 890. It has no `<details>` wrapper. URLs and times like `12:34` show as plain text.\n- **Episode page:** `app.js:8368` `episodeDescriptionSectionHtml` wraps the notes in `<details class=\"ep-description\"><summary>Episode notes</summary>` around `episodeDescriptionHtml(...)` (8310). That function turns URLs into escaped `<a target=_blank rel=noopener>` links and times into seek buttons. `bindEpisodeSeeks` (8412) binds those buttons, and `renderEpisode` calls it at 8496.\n- **Styling:** the comment at `styles.css:2039` says the sheet shows \"the same text\", but only the font size and `pre-line` rule were shared.\n\n**Deliberate or already fixed?**\n- No `docs/DECISIONS.md` entry and no other doc covers links, timestamps or collapsing in the sheet's notes. The only mentions of `fp-s-desc` are in audit notes about empty paragraphs.\n- It has not been fixed.\n- Using `textContent` does follow a real rule in the header of `client.js` (lines 7-12): build the DOM with createElement/textContent, never HTML strings, because the text comes from third-party RSS. So the plain text comes from a security rule, not from a decision to leave the sheet without links. But the fix sketch's `innerHTML` route goes against that header. A fix should build the `<a>` and `<button data-ts>` nodes with createElement, or state openly that it is an exception.\n\n**Why medium, not high**\n- The sheet's `openLink` points to the episode page (around client.js:1585), so the working notes are one tap away. The finding's claim that the sheet is \"the one place\" users read notes is overstated.\n- The notes sit last, below all the controls, so the uncollapsed block doesn't push the transport down. It is just a long scroll of dead text.\n- Nothing is lost, nothing crashes and there is no security impact. The real problem is inconsistency: the same notes are links and seek buttons on the episode page and dead text in the sheet.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## p-switcher-5 — Now Playing sheet has no Up Next, no Save and no sleep timer — the three things an Apple user reaches for from the player

**confirmed** · verifier severity **medium** (finder: medium) · p-switcher · `player/client.js:872` · L3-queue-and-native-surfaces

```json
{
  "id": "p-switcher-5",
  "lens": "p-switcher",
  "title": "Now Playing sheet has no Up Next, no Save and no sleep timer — the three things an Apple user reaches for from the player",
  "file": "player/client.js",
  "line": 872,
  "severity": "medium",
  "user_visible": "Expanded player: Stop, speed, 'Episode'. To see what plays next you must collapse the sheet, open ☰ and tap Up Next; to save the episode you must open its page. There is no sleep timer anywhere in the app (bedtime listening ends only by Stop).",
  "evidence": "player/client.js:872 `row2.append(stopBtn, rateBtn, openLink, forayLink);` and buildUI (client.js:652-905) creates no queue, save or timer control; `grep -in sleep app.js player/client.js` returns nothing. Up Next reachable only via index.html:52 drawer link / Library.",
  "why_subtle": "Continuous playback is on and Up Next exists, so the queue is real; it just has no presence on the transport where Apple puts the list icon and the '…' (Save / Go to show). Absence is not a bug a test can fail.",
  "fix_sketch": "Add a queue button on `row2` that opens #/queue (or an in-sheet list of the next 3 from `planAfterEnded`), a `starBtn` for the current episode, and a simple sleep timer (end of episode / 15/30/60 min) that calls `setRunning(false)`.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; persona 79 asked for skip on the bar, not for the sheet's missing staples",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "Checked at origin/main (9730b5b). player/client.js:872 is exactly `row2.append(stopBtn, rateBtn, openLink, forayLink);`. buildUI builds only these sheet controls: grab zone with the collapse ✕, artwork, title, show, why, the scrub bar, times, the ↺15 / play / 30↻ row, the Foray-only Previous/Next clip row, row2 (Stop, speed, Episode, Back to this foray), an error line, a note and the description. It has no Up Next or queue control, no save/star button and no timer. app.js adds nothing to the sheet: its only `.fp-sheet` hit is a comment at line 5082. There is no sleep timer anywhere: `sleep` and `bedtime` don't appear in app.js, and client.js has only unrelated `timer` hits (the hydrate timeout, the give-up timer). docs/DECISIONS.md has no ruling that leaves these controls out on purpose. The 2026-08-31 Up Next entries cover the queue's own page and auto-advance, not the player sheet. The only sleep hit in DECISIONS.md is about search ranking (\"sleep training\"). The docs actually argue the other way. docs/marketing/09-product-feature-review.md lists the sleep timer as TABLE-STAKES and \"ship-with-iOS-v1\" (R18, the six-item player bill, which also includes a session queue / up-next). docs/brief/05_CORNER_CASES.md #17 names the sleep-timer case. So the gap isn't deliberate; the plan names it as required and it hasn't shipped. The user sees what the finding describes: Up Next and saving are only reachable off the sheet. Medium is right: these are expected player staples and not a correctness bug, but the missing sleep timer is called out as a one-star review risk.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-switcher-7 — Episode search results drop the publish date and the show name is not a link for any non-curated show

**confirmed** · verifier severity **medium** (finder: medium) · p-switcher · `app.js:7330` · L4-search-create-playlists

```json
{
  "id": "p-switcher-7",
  "lens": "p-switcher",
  "title": "Episode search results drop the publish date and the show name is not a link for any non-curated show",
  "file": "app.js",
  "line": 7330,
  "severity": "medium",
  "user_visible": "Search results' episode rows read 'Show · 45 min' with no date, while the same episode on its show page reads 'Show · 45 min · Sep 12, 2026'. Under an episode from any of the ~19,900 breadth shows (and every Apple-index result), the show name is plain text — tapping it does nothing, so 'go to the show from an episode' fails everywhere but the 220 curated shows.",
  "evidence": "app.js:7330-7338 `snapshot(id, { show: ep.show_title || ep.show_id, title, hook, audio_url, duration_min, duration_sec, topics: [] })` — no `release_date` although api/episodes/search.ts:169/185 returns `published_at`; compare app.js:3163 `release_date: ep.published_at || null` in `fullCatalogueRowToEpRowItem`. app.js:2438-2447 `showIdForShowName` searches only `state.catalog?.shows` (220 rows) so `showNameLink` (2453) returns bare text for `pi:`/breadth shows and Apple-index rows, on rows and on #/episode.",
  "why_subtle": "Both were fixed once at one call site (the show page) and not promoted to the rule — the exact shape qa-synthesis calls theme C. The rows look complete because the joiner drops empty pieces cleanly.",
  "fix_sketch": "Pass `release_date: ep.published_at ?? null` (and `artwork_url` when the API can supply the show image) in `paintEpisodeSearchResults`; have search-result snapshots carry `show_id` and let `showNameLink` prefer `item.show_id` (via `showById`, which already knows `pi:` shows) before the title lookup.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa 96 / persona 29 (theme A: a real episode is one we hold a snapshot of) — the snapshot is playable but thinner than the show page's",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the evidence holds.\n\n- **Missing date.** In `paintEpisodeSearchResults` (app.js:7275), the remote row (around line 7330) builds `snapshot(id, {show, title, hook, audio_url, duration_min, duration_sec, topics: []})` and passes no `release_date`. The local fallback snapshot does the same. `epRow` (app.js:8025) prints the date with `fmtDate(item.release_date)` inside `joinMeta`, so an empty date is simply left out and the row reads \"Show · 45 min\". The show-page mapping `fullCatalogueRowToEpRowItem` (app.js:3142) does set `release_date: ep.published_at || null`, and api/episodes/search.ts returns `published_at` in both modes: `hit.releaseDate` at line 169 and `ep.publishedAt` at line 185.\n- **Unlinked show name.** `showNameLink` (app.js:2453) calls `showIdForShowName` (app.js:2438). That function matches the title only against `state.catalog?.shows` (the 220 curated shows) plus `TITLE_ALIASES`. It never uses the result's `show_id` or `showById`, even though `showById` also checks the `pi:` shard cache and `breadthShowCache`.\n- **The API's own comment says the link should work.** The API drops any hit that has no 4a `show_id` so a result is \"never surfaced with a broken show link\" (search.ts:147-157). Since P-05 that map covers 19.9k ids and every breadth id resolves. So every search result carries a valid `show_id` the client could link to. The client throws it away and matches on Apple's `collectionName` instead. For breadth shows the name comes out as plain text. Even curated shows only link when Apple's `collectionName` exactly matches the catalog title.\n\nNo docs/DECISIONS.md entry covers this: grepping for \"search result\", \"showNameLink\" and \"release_date\" found only an unrelated freshness-scoring note. Nothing on origin/main fixes it.\n\nSeverity is medium. Nothing is broken: the rows still play and can be starred. But the date is missing and navigation from search fails for most shows. I read the code only; I did not look at the running app.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## p-first-1 — Onboarding picks mostly do not reach the first Home: with real taxonomy weights the +0.20/√n lift loses to Engineering 0.9 / History 0.8 and ±0.25 jitter

**confirmed** · verifier severity **medium** (finder: high) · p-first · `app.js:4727` · L6-navigation-firstrun-copy

```json
{
  "id": "p-first-1",
  "lens": "p-first",
  "title": "Onboarding picks mostly do not reach the first Home: with real taxonomy weights the +0.20/√n lift loses to Engineering 0.9 / History 0.8 and ±0.25 jitter",
  "file": "app.js",
  "line": 4727,
  "severity": "high",
  "user_visible": "Step 2 of the first-run sheet says \"This is how we tune your suggestions. Pick a few\" and the button says \"Start listening\". The newcomer picks Comedy, Food and Sports; the Home that appears shows Engineering and History (unpicked) about as often as the picks. Simulated over the committed data with the app's own buildCards (200 boots each): picks [comedy,food,sports] → all three on Home 1% of the time, none of them 29%; pick [true-crime] alone → appears 36%; picks [true-crime,health,music] → none of them 42%, all three 0%. Meanwhile unpicked engineering/history land in ~35%/31% of slots regardless. The only picks that reliably show are the ones the defaults already favour ([engineering,history,science] → ≥1 shown 88%).",
  "evidence": "`const ONBOARDING_SEED_LIFT = 0.20;` and `const lift = ONBOARDING_SEED_LIFT / Math.sqrt(ids.length);` (app.js:4727, 4748) versus data/taxonomy.json roots `engineering 0.9, history 0.8, science/craft/comedy 0.6`, every other root 0.5 (engineering leaves 1, 0.7, 0.5…; a picked root's leaves are all 0.5 → 0.615 after three picks). buildCards then adds `(Math.random() - 0.5) * 0.5` jitter (app.js:1320) — ±0.25, twice the lift — and takes the top 3 (app.js:1324). test/first-time-onboarding.test.js:662 \"picking three chips … become the top-tier slots\" passes only because its fixture pins `Math.random` to 0.5 (line 625) over a synthetic taxonomy of uniform 0.3 weights.",
  "why_subtle": "The flow, the copy, the redeal (redealAfterOnboardingPicks) and the acceptance test are all in place and green; nothing looks broken in code review. Only the real numbers make the picks inert, so the newcomer's first impression is \"I told it what I like and it ignored me\", which they attribute to the product, not a constant.",
  "fix_sketch": "Make an explicit pick a fact, not a nudge: on onboarding, set picked roots (and leaves) to max(current, 0.85) and/or demote unpicked authored defaults toward 0.5, or bypass jitter for the first deal after picks and reserve slots 2-4 for the picked roots directly (subjectItemsForBranch already builds a queue for any branch). Re-run the acceptance test over data/taxonomy.json with real Math.random and assert ≥2 of 3 picks on Home in 95% of deals.",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Persona 41/46 (\"usual subjects\" on day one) were ruled deliberate; this is the mechanism behind the day-one Home, not the copy.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The code at origin/main matches the finding. app.js:4727 has `const ONBOARDING_SEED_LIFT = 0.20;` and applyOnboardingPicks (app.js:4748) applies `lift = 0.20/sqrt(n)` to the picked root and its leaves, never pushing anything down. buildCards (app.js:1291-1335) ranks branches by the mean interestScore of their items. It adds `(Math.random()-0.5)*0.5` jitter (app.js:1320), puts the stretch slot first and fills the other three slots from the jittered ranking. redealAfterOnboardingPicks does re-deal after the picks, so the first Home really is this deal.\n\nI re-ran it myself in a standalone Node script that copies buildCards' ranking over the committed data at origin/main (session.json + discover.json: 2194 items, 39 branches; taxonomy.json), 2000 deals per case, with real Math.random. Before any picks, branch means come out at: engineering 0.65, history 0.66, comedy 0.59, science 0.55, almost everything else 0.50. Results:\n- [comedy,food,sports]: all three shown 1.35%, none shown 30%.\n- [true-crime] alone: shown 38%.\n- [true-crime,health,music]: all three 0.25%, none 44%.\n- [engineering,history,science]: at least one shown 88%.\n- Unpicked engineering and history each land on about 30-37% of Homes whatever is picked.\nThese match the finding's numbers.\n\nThe effect is weaker than the lift alone suggests because interestScore averages over an item's topics, and the ±0.25 jitter is larger than the lift of at most 0.20.\n\nIs it deliberate? Partly. The size of the lift and the rule that unpicked nodes are never pushed down come from docs/curation/interest-survey-plan.md §4.3 (\"a bounded prior, not a fact\"; not pushing unpicked nodes down is called \"not negotiable\"). So the fix sketch's \"demote unpicked defaults\" option goes against a written design rule. But no ruling accepts that picks fail to reach Home. The plan's own arithmetic (\"moves it from 0.5 to ~0.7\") never accounts for the jitter. The code's own comment at app.js:4760+ says U-09's acceptance line (\"picking three chips changes the FIRST Home render's ranking\") exists to make picks shape the first Home, and in practice they mostly don't. I found no entry in docs/DECISIONS.md about seed lift or jitter.\n\nI did not open test/first-time-onboarding.test.js, so the claims about its fixture (Math.random pinned at line 625, uniform 0.3 synthetic taxonomy) are unchecked.\n\nI rated it medium rather than high. It is a tuning and trust problem on the first-run Home: picks still show up about 56-70% of the time for at least one pick, and nothing breaks. The fixes that fit the plan are to skip the jitter, or reserve slots for picked roots, on the first deal after onboarding. That would leave §4.3's rule against pushing unpicked nodes down intact.\n\nFiles: C:/Users/wjduv/Desktop/Vibe Coding/foray app.js (origin/main) lines 1291-1335, 4727-4760; docs/curation/interest-survey-plan.md §4.3 (lines ~483-535, 672-690). Simulation script (throwaway): C:/Users/wjduv/AppData/Local/Temp/claude/C--Windows-System32/817acc3d-d20a-4c01-b580-a853f7cde090/scratchpad/sim.js.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-first-2 — First launch on a Light-mode phone paints the loading screen in the retired v1 light palette, then hard-cuts to the dark v2 design at first route (second-order of the persona 43 fix)

**confirmed** · verifier severity **medium** (finder: high) · p-first · `app.js:13867` · L5-boot-states-storage

```json
{
  "id": "p-first-2",
  "lens": "p-first",
  "title": "First launch on a Light-mode phone paints the loading screen in the retired v1 light palette, then hard-cuts to the dark v2 design at first route (second-order of the persona 43 fix)",
  "file": "app.js",
  "line": 13867,
  "severity": "high",
  "user_visible": "On an iPhone set to Light appearance (the default), a fresh install opens to a warm off-white page (#faf7f2) with a light top bar and dark \"Loading 4a…\" text under a dark status bar; several seconds later (first install: ~3.5 MB of JSON on cell) it snaps to the #151119 dark design. On a Dark-mode phone it is a smaller flash from #0d1117 to #151119. It happens on every cold launch, and the DECISIONS.md dark-only ruling says the app has one palette.",
  "evidence": "index.html ships `<body>` with no class. `body.ui-v2` is only ever added by `setBodyClass` (app.js:857 `body.className = [...new Set([base, \"ui-v2\", ...])]`), which no route calls until `route()` after every await; meanwhile init paints `view.innerHTML = BOOT_LOADING_HTML` (app.js:13867) under `:root` tokens, whose `@media (prefers-color-scheme: light) { :root { --bg: #faf7f2; --text: #211c14; … } }` block (styles.css:74-92) is still live; `body { background: var(--bg) }` (styles.css:266) and `.topbar { background: var(--bg) }` (styles.css:430) read it. styles.css:118 itself admits \"the v1 blocks now only answer for the instant before the first render\" — but the instant is the whole data load, and persona 43's fix put text into it.",
  "why_subtle": "Developers run with Dark OS and a warm cache, where the flash is a 40 ms shade change. A newcomer on a Light phone, first install, cold cell, watches a different-looking app for the entire boot and then a jarring cut.",
  "fix_sketch": "Put `class=\"ui-v2\"` on `<body>` in index.html (or `document.body.classList.add(\"ui-v2\")` synchronously at the top of app.js before init) and give `:root` the v2 `--bg`/`--text` so the pre-script instant is dark too; drop or scope the v1 light-scheme block. Pin with a test that the boot markup is painted under body.ui-v2.",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order of persona 43 (blank first second → \"Loading 4a…\") and of the 2026-09-23 dark-only ruling; neither round-1 row covers the boot palette.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the code matches the finding.\n\n- **Body class:** index.html:46 ships a bare `<body>` with no class and no inline script. The only code that adds `ui-v2` is setBodyClass (app.js:857), and no route calls it before `route()`.\n- **Boot screen:** init paints BOOT_LOADING_HTML at app.js:13867, then awaits `storageReady()` and `session.json`, then the `Promise.all` of validated-links, taxonomy, discover, forays, segments, segment-sources and catalog-client, then `bootForayDirectory`. Only after all of that does it call `route()`.\n- **Light palette:** during that window, the `:root` `@media (prefers-color-scheme: light)` block (styles.css:74-92) sets `--bg: #faf7f2` and `--text: #211c14`. Both `body` (`background: var(--bg)`) and `.topbar` read `--bg`. So a Light-mode phone paints the warm off-white page and top bar with dark \"Loading 4a…\" text, then cuts to #151119. A Dark-mode phone gets v1 #0d1117, then #151119.\n- **The dark meta doesn't prevent it:** index.html has `<meta name=\"color-scheme\" content=\"dark\">` and `theme-color #151119`. That meta changes how the browser paints its own controls. It does not change what `prefers-color-scheme` media queries match, so the v1 light block still applies.\n\n**Not deliberate:** the 2026-09-23 visual-pass comments and the DECISIONS.md dark-only entry (line 330) say the app ships one palette. That entry keeps the v1 light blocks only \"to govern v1\", and v1 is retired. styles.css:95-99 itself says those blocks \"now only answer for the instant before the first render\". No ruling accepts a light boot screen, and nothing on main fixes it.\n\n**Why medium, not high:** the flash is overstated. Since persona 43, init no longer awaits the two search-only files before painting. It still awaits roughly 3 MB raw (about 700 KB gzipped). In the Capacitor shell the data/*.json files are most likely bundled locally, which I did not check. If so, the light screen lasts a fraction of a second, not \"several seconds on cell\". It is still a visible wrong-palette flash on every cold launch for Light-mode users, but it is cosmetic.",
  "merged_ids": [],
  "lane": "L5-boot-states-storage"
}
```

## p-first-3 — "Or type a subject yourself…" silently discards anything that is not an exact top-level taxonomy label

**confirmed** · verifier severity **medium** (finder: medium) · p-first · `app.js:4740` · L6-navigation-firstrun-copy

```json
{
  "id": "p-first-3",
  "lens": "p-first",
  "title": "\"Or type a subject yourself…\" silently discards anything that is not an exact top-level taxonomy label",
  "file": "app.js",
  "line": 4740,
  "severity": "medium",
  "user_visible": "On the Preferences step the newcomer types \"health\", \"cooking\", \"AI\", \"news\", \"travel\" or \"startups\", taps \"Start listening\", the sheet closes and nothing happens: no message, no chip lit, the subject is gone. Only an exact root label works: \"true crime\" and \"Space\" apply, \"health\" does not (the label is \"Health & Fitness\"), \"news\" does not (\"News & Current Affairs\"). Verified by calling applyOnboardingPicks over the real taxonomy.",
  "evidence": "`const typedNode = taxonomyNodes().find(n => n.parent === null && n.label.toLowerCase() === typed.toLowerCase());` (app.js:4741-4743) and `if (!ids.length) return false;` (4746); the Start handler then does `dismiss()` unconditionally (5427-5428) and only re-deals when `applied`. No feedback path exists for a miss; test/first-time-onboarding.test.js:547 pins the no-op. 24 of the 41 roots are not chips, so the field is the only way to name them, and it works for none of their synonyms.",
  "why_subtle": "The field looks like free text and sits under a friendly \"pick a few, or skip\"; the miss is indistinguishable from success because both end with the sheet closing. The newcomer's first typed act in the app is a silent no-op.",
  "fix_sketch": "Match on the label's words and leaf labels too (\"health\" → Health & Fitness; \"cooking\" → food/cooking), show the resolved subject as a lit chip before closing, and on no match keep the sheet open with an inline \"No subject called 'X' yet — try one of the chips\" instead of dismissing.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds. In app.js:4737-4746, applyOnboardingPicks matches the typed text only where `n.parent === null && n.label.toLowerCase() === typed.toLowerCase()`, and returns false when nothing matches. The \"Start listening\" handler at app.js:5426-5438 calls `dismiss()` whatever the result, and only re-deals and repaints when `applied` is true. Nothing tells the listener their subject was not recognised.\n\ndata/taxonomy.json on origin/main has 41 roots, and many of them are compound labels: \"Health & Fitness\", \"News & Current Affairs\", \"Travel & Places\", \"Religion & Spirituality\", \"TV & Film\", \"Hobbies & Leisure\". So typing \"health\", \"news\", \"travel\", \"cooking\" or \"AI\" matches nothing. Only exact labels work, such as \"Space\", \"Food\" or \"True Crime\".\n\ntest/first-time-onboarding.test.js pins the behaviour: an unmatched typed subject changes nothing and the sheet still dismisses. The code comment says the no-op is on purpose, but only to avoid creating a node that nothing in the pool carries. It does not justify dropping the input without a word or ignoring near matches. docs/DECISIONS.md has no ruling on the typed field.\n\nI'm keeping severity at medium, not higher. This is one onboarding step, the listener still gets the default Home, and the app keeps learning from what they play. Even so, the free-text field is the only way to name the roots that have no chip, and for common words it quietly does nothing.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-first-4 — The first-run sheet's dismiss affordances are inverted: the drawn grab handle does nothing, while a tap on the dimmed background ends onboarding permanently

**confirmed** · verifier severity **low** (finder: medium) · p-first · `app.js:5295` · L2-sheets-drawer-gestures

```json
{
  "id": "p-first-4",
  "lens": "p-first",
  "title": "The first-run sheet's dismiss affordances are inverted: the drawn grab handle does nothing, while a tap on the dimmed background ends onboarding permanently",
  "file": "app.js",
  "line": 5295,
  "severity": "medium",
  "user_visible": "The Welcome/Preferences sheet shows the same 38×4 px grab bar the Now Playing sheet has, so a newcomer tries to swipe it down and nothing happens; a stray tap on the dark area above the panel (trying to see Home behind it, or a mis-aimed scroll) closes the sheet and sets the never-again flag — mid-chip-selection the picks are lost too. Neither step's \"Skip\" was pressed.",
  "evidence": "`const grab = ddEl(\"div\", \"fy-grab\"); grab.setAttribute(\"aria-hidden\", \"true\"); panel.append(grab);` (app.js:5279-5281) with no drag wiring in app.js (sheet-drag-dismiss.js is imported only by player/client.js:122 for the Now Playing sheet). `scrim.addEventListener(\"click\", dismiss);` (app.js:5295) where `dismiss` does `lsSet(\"cp_intro_dismissed\", true)` (5291). The same pair on the returning-user popup (5474, 5507).",
  "why_subtle": "Both affordances look standard. The handle is reused \"so a fifth sheet cannot look like a different product\" (client.js:773), which is exactly why a newcomer expects it to drag. The scrim tap is the one gesture that is never a considered choice, and it is the one that writes the permanent flag.",
  "fix_sketch": "Either wire sheet-drag-dismiss to the onboarding sheet or drop the handle from it; make a scrim tap on the first-run sheet a no-op (or a non-persisting close) and reserve `cp_intro_dismissed` for the two Skip buttons and Start listening.",
  "suspected_deliberate": false,
  "relation_to_round1": "Extends persona 45 (Skip is destructive): the fix gave FORAY_ABOUT a permanent home, but the Preferences step has none and two accidental gestures still end it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked origin/main (9730b5b). The code matches the finding exactly. app.js:5279-5281 appends an aria-hidden `fy-grab` handle to the first-run panel, and nothing in app.js wires drag to it. sheet-drag-dismiss is used only by the Now Playing sheet. At app.js:5295, `scrim.addEventListener(\"click\", dismiss)` runs a `dismiss` that does `lsSet(\"cp_intro_dismissed\", true)` (5291). The returning-user popup does the same at 5474/5503/5507. Users can hit it: `.fy-scrim` is inset:0, and `.fy-panel` is capped at 88vh, so at least the top 12% of the screen is dim scrim. A tap there ends onboarding for good, and any chips picked in the Preferences step so far are lost, because the `picked` Set is written only by \"Start listening\".\n\nMitigations lower the severity:\n(1) Treating a scrim tap as \"not now = Skip\" is a deliberate choice. The code comment at 5288-5289 routes Escape and navigation through `dismiss` on purpose, and DECISIONS.md line 55 sets the house rule \"a sheet's scrim closes that sheet only\". What no ruling covers is that a scrim close sets the never-again flag.\n(2) A grab handle with no drag behind it is the house style on every fy-sheet (app.js 9523, 10654, 11821, 12171, 12530), not something specific to onboarding. DECISIONS names drag only for the Now Playing sheet.\n(3) The finding says the Preferences step \"has none\" (no permanent home), which is overstated. A #/interests page (renderInterests, U-07) lets users set the same interests later, and the Preferences copy says \"we learn either way, from what you play.\"\n\nThe inconsistency is real and not fixed, but the harm is a lost one-time chip selection that can be recovered on #/interests. That makes it low severity, not medium.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## p-first-5 — A newcomer who arrives by a shared Foray link and then taps Home gets the Welcome sheet over a playing player, with the mini bar made inert

**confirmed** · verifier severity **low** (finder: medium) · p-first · `app.js:4917` · L2-sheets-drawer-gestures

```json
{
  "id": "p-first-5",
  "lens": "p-first",
  "title": "A newcomer who arrives by a shared Foray link and then taps Home gets the Welcome sheet over a playing player, with the mini bar made inert",
  "file": "app.js",
  "line": 4917,
  "severity": "medium",
  "user_visible": "Open https://…/#/foray/capital-types-1 from a message, press play, tap ‹ then Home: the first-run sheet opens (\"4a picks podcast episodes for you… Two things make it different\") while audio keeps playing, and the mini bar's ▶/❚❚ and ↺15 stop responding until the sheet is dismissed. The only way to pause on screen is the scrim tap or Skip, which ends onboarding for good.",
  "evidence": "`isGenuineFirstTimeUser()` reads only cp_history/cp_saved/cp_playlists (app.js:4700-4706); Foray playback goes through `player.playForay` (app.js:10467) and never `recordHistory` (its three callers are 2193, 4474, 4562), so the listener is still \"first-time\". `renderHomeV2` then opens the sheet (7900) with `openSheet(wrap, { panel, onRequestClose: dismiss })` and no `keepReachable` (5294), and `inertOutside` sets `inert` on every sibling up to body (4917-4935) — including `#foray-player`, which client.js appends to body (client.js:893).",
  "why_subtle": "Deep links are the product's only viral path and nothing in the sheet's logic considers audio already playing. Lock-screen controls still work, so it looks like an on-screen glitch rather than a rule.",
  "fix_sketch": "Pass `keepReachable: [\"#foray-player\"]` for the onboarding sheets (the Now Playing sheet already keeps the topbar this way), and count a Foray play (or any `lastPlayedForay`) as prior use in `isGenuineFirstTimeUser`, or defer the sheet while `ForayPlayer.isPlaying()`.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; touches theme E's openSheet owner (R5) as a second-order effect.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked every code claim against origin/main and each one holds. The file references are slightly off: the player is created in player/client.js (id set at line 654, `document.body.append(root)` at line 893), and client.js is not at the repo root. `isGenuineFirstTimeUser()` (app.js:4700) looks only at cp_history, saved items and playlists. `recordHistory` (1255) is the only writer of cp_history, and its callers are 2193, 4474 and 4562, none of which is on the Foray play path. `renderHomeV2` (7900) calls `showFirstTimeExplainerOnce()`, which runs `openSheet(wrap, { panel, onRequestClose: dismiss })` with no `keepReachable` (5294). `openSheet` appends the wrap to body. `inertOutside` (4917) therefore makes every body sibling inert, including #foray-player. No `keepReachable:` option is passed anywhere in app.js. So a listener whose only use has been a Foray is still counted as first-time, and the Welcome sheet opens on Home while audio keeps playing.\n\nThe user-visible harm is smaller than the finding claims:\n- The .fy-sheet is `position: fixed; inset: 0; z-index: 70`, with a full-screen scrim over #foray-player (z-index 60). The mini bar is covered by the scrim either way, so `inert` only confirms what any modal already does. A tap on the bar lands on the scrim and dismisses the sheet with one tap.\n- DECISIONS.md (2026-09-10, #125) makes Welcome + Preferences a skippable first-run sheet gated on cp_intro_dismissed, so \"Skip ends onboarding for good\" is intended.\n- A person who has only opened a shared Foray arguably is new to the app, so seeing Welcome is defensible.\n\nWhat remains is a real but minor gap: the first-run check ignores Foray playback, and a modal appears over live audio with no pause control until the sheet is dismissed. No DECISIONS ruling covers that combination, and it has not been fixed. I rate it low rather than medium.",
  "merged_ids": [],
  "lane": "L2-sheets-drawer-gestures"
}
```

## p-first-6 — Two playlist builders with two vocabularies: drawer "Playlists" (#/playlists, "build me a playlist…", Go) and tab "Create" (#/create, "e.g. the semiconductor supply chain", Build) — incomplete fix of persona 76

**confirmed** · verifier severity **medium** (finder: medium) · p-first · `app.js:8835` · L4-search-create-playlists

```json
{
  "id": "p-first-6",
  "lens": "p-first",
  "title": "Two playlist builders with two vocabularies: drawer \"Playlists\" (#/playlists, \"build me a playlist…\", Go) and tab \"Create\" (#/create, \"e.g. the semiconductor supply chain\", Build) — incomplete fix of persona 76",
  "file": "app.js",
  "line": 8835,
  "severity": "medium",
  "user_visible": "In the first minutes the newcomer meets the same job on two pages that look unrelated: the Create tab (Playlist|Foray toggle, three suggestion chips, Build button, note about custom Forays) and the drawer's Playlists page (a bare field \"build me a playlist…\" with a Go button, \"0 built\", \"No playlists yet — type above to build your first one\"). Library's empty state points to Create; the Playlists page points to itself. Apple has one place for this.",
  "evidence": "`renderPlaylists` at app.js:8826-8848 renders `<form id=\"pl-form\"><input placeholder=\"build me a playlist…\"><button type=\"submit\">Go</button>` and the note \"No playlists yet — type above to build your first one.\"; `renderCreate` at 8958-8975 renders `placeholder=\"e.g. the semiconductor supply chain\"` + `Build` + `createToggleHtml()`; Library says `No playlists yet — <a href=\"#/create\">build one on the Create tab</a>` (8789). The drawer lists Playlists (index.html:51) and the tab bar lists Create (app.js:11140); R6 made the drawer use the tab bar's names for Search only. The founder deleted a \"Go\" button on Search on sight (app.js:2898-2900); this one survives.",
  "why_subtle": "Each page is internally fine; the seam is only visible to someone who uses both the drawer and the tab bar in the same session, which a newcomer exploring does.",
  "fix_sketch": "Make #/playlists the list only (own playlists, \"Generated for you\", one \"Build a playlist\" link to #/create) and keep a single builder on Create; or drop the drawer entry in favour of Create. Align the empty-state sentences.",
  "suspected_deliberate": true,
  "relation_to_round1": "Incomplete fix of persona 76/20 (two navigation systems); the drawer list of five is pinned by test/home-information-architecture.test.js and was the founder's own 2026-09-03 order, so a ruling is needed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the evidence holds. renderPlaylists (app.js:8826-8851) renders a \"Playlists\" heading, \"${n} built\", a #pl-form with placeholder \"build me a playlist…\" and a \"Go\" button, and the empty-state line \"No playlists yet — type above to build your first one.\" renderCreate (8958-8975) renders the Create heading, createToggleHtml(), placeholder \"e.g. the semiconductor supply chain\", a \"Build\" button and suggestion chips. Library's empty state (8789) sends people to \"#/create\" (\"build one on the Create tab\"). index.html:65 has the drawer link to #/playlists. The mismatch goes further than the finding says: Search's \"Create a playlist about …\" CTA (bindCreatePlaylistCta, 7012-7033) sends the user to the #/playlists builder, not to Create. So the app routes people to two different builders.\n\nI found no DECISIONS.md ruling that keeps two builders on purpose. The Create page's own header comment and ui-transition-plan U-06 call #/playlists \"the old Playlists page\", and U-06 only requires that both produce identical cp_playlists entries. D7 says Create's Playlist mode is \"today's builder restyled\", which suggests Create was meant to replace the old builder, not sit beside it. The one thing pinning the old builder is test/home-information-architecture.test.js:213-231. It quotes the founder on 2026-09-03 (\"keep all that only on the Playlists page\"). That order predates the Create tab (U-06, 2026-09-06), and it was about taking the builder off Home, not about keeping a second builder once Create existed. The drawer list of five comes from the same order. A fix would have to update that test, so a ruling is sensible. Still, this is leftover duplication, not a recorded deliberate choice.\n\nIt is visible to users: #/playlists is reachable from the drawer and from Library's \"All N playlists ›\" link, and Create is a tab. Both builders call buildPlaylist(), so nothing breaks. The cost is confusing, inconsistent wording and navigation, so medium severity is fair (arguably low-medium).",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## p-first-7 — "Start listening" starts nothing: the button that ends onboarding drops the newcomer on a Home with no play control

**confirmed** · verifier severity **low** (finder: medium) · p-first · `app.js:5418` · L6-navigation-firstrun-copy

```json
{
  "id": "p-first-7",
  "lens": "p-first",
  "title": "\"Start listening\" starts nothing: the button that ends onboarding drops the newcomer on a Home with no play control",
  "file": "app.js",
  "line": 5418,
  "severity": "medium",
  "user_visible": "The last button of onboarding is labelled \"Start listening\". Pressing it closes the sheet onto Home, where nothing plays without two more taps (subject card → row ▶, or Foray card → page ▶). The label promises the one thing Home cannot do on a first run.",
  "evidence": "`const go = ddEl(\"button\", \"fy-sheet-go\", \"Start listening\");` (app.js:5418); its handler only `dismiss()`s and re-deals (5426-5440). On a fresh profile `jumpBackInV2Html()` returns \"\" (7634), and it is the only Home rail that calls `playBtn` (7730); Foray/playlist/subject cards are links (7783, 7833, 4664).",
  "why_subtle": "The copy was written for the mockup's flow; the one-tap play on Home is founder question 11 (persona 44, deferred), so the label outran the decision.",
  "fix_sketch": "Either rename to \"Show my picks\"/\"Done\", or make it true: have Start listening open the first picked subject's queue (or the top card) and start it, which also answers persona 44 for this one path.",
  "suspected_deliberate": true,
  "relation_to_round1": "Second-order of persona 44 (deferred-founder) — the button label assumes the deferred feature exists.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main (9730b5b) and it holds. In app.js, line 5418 creates the button as `ddEl(\"button\",\"fy-sheet-go\",\"Start listening\")`. Its click handler (5426-5440) calls applyOnboardingPicks, then dismiss(), then, only if something was written, redealAfterOnboardingPicks() and renderCurrentPage(). It never starts playback and never navigates anywhere.\n\nThe Home that follows is renderHomeV2 (7887): homeGreeting, testTrackNotice, jumpBackInV2Html, foraysForYouHtml, playlistsForYouHtml and episodesForYouHtml. On a fresh profile jumpBackInV2Html returns \"\" because it has no entries (7634). Jump back in is the only Home rail that calls playBtn (7730). Every other rail is made of links:\n- Foray cards are `<a href=\"#/foray/...\">` (7783).\n- Playlist cards are `<a>` (7833).\n- The \"Episodes for you\" cards come from miniCardV2 and miniCard. miniCard renders a subject `<a class=\"mc-link\">` plus a star button, with no play control (4664).\n\nSo on a first run, getting audio to play takes at least two more taps, as the finding says.\n\nNothing in DECISIONS.md makes the label deliberate. The 2026-09-10 U-09 entry talks about \"Start listening\" re-dealing and repainting Home so the first Home ranks by the picks. That covers what the button does, not the promise in its label. The label comes from the mockup's PrefsScreen and nothing marks it as a ruled wording, so this looks like an inherited label rather than a deliberate decision. It hasn't been fixed.\n\nI'm setting severity to low rather than medium. This is a copy/expectation mismatch at a one-time exit. Nothing is lost or broken, the picks are applied and Home is re-ranked, and a playable item is two taps away. The cheapest fix is to rename the button (for example \"Show my picks\").",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-first-8 — Home opens with the wordmark twice: the topbar's italic "4a" and the greeting's identical italic "4a" stacked ~50 px apart (second-order of qa 47)

**confirmed** · verifier severity **low** (finder: low) · p-first · `styles.css:3773` · L7-styles-touch-visual

```json
{
  "id": "p-first-8",
  "lens": "p-first",
  "title": "Home opens with the wordmark twice: the topbar's italic \"4a\" and the greeting's identical italic \"4a\" stacked ~50 px apart (second-order of qa 47)",
  "file": "styles.css",
  "line": 3773,
  "severity": "low",
  "user_visible": "The first screen reads: [☰] *4a* a daily podcast picker [↻] and directly beneath it \"Good morning *4a*\" in the same Fraunces italic at the same size. To a newcomer the brand appears to be repeated by mistake, and the greeting looks like it is addressing \"4a\" rather than them.",
  "evidence": "`.topbar h1 a { font-family: var(--font-display); font-style: italic; font-size: var(--fs-2xl); font-weight: 600 }` (styles.css:449-462) and `body.ui-v2 .hv2-greeting-brand { font-family: var(--font-display); font-style: italic; font-weight: 600; font-size: var(--fs-2xl) }` (3773-3775); `homeGreeting()` emits `<span class=\"hv2-greeting-word\">Good morning</span> <span class=\"hv2-greeting-brand\">4a</span>` (app.js:7585-7591) at `padding: 4px 14px 0` under the fixed bar.",
  "why_subtle": "qa 47 aligned the topbar wordmark to the greeting's typeface so the two would match; matching made them twins on the one page where both are visible.",
  "fix_sketch": "On Home, hide the topbar wordmark/tagline (body.view-home .topbar h1) or drop the brand from the greeting (\"Good morning.\" alone, as Apple's Listen Now uses the time-of-day heading without a brand).",
  "suspected_deliberate": false,
  "relation_to_round1": "Second-order of qa 47 (wordmark typography), fixed in visual pass 1.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n**What the code does**\n- index.html:47-49 is static markup that paints on every route: `<header class=\"topbar\"><h1><a class=\"wordmark\" href=\"#/\">4a</a> <span class=\"topbar-tag\">a daily podcast picker</span></h1>`.\n- styles.css:449-462 styles `.topbar h1 a` as `var(--font-display)`, italic, `var(--fs-2xl)`, weight 600. Its comment says it deliberately matches \"the same mark Home's greeting draws\" (the qa 47 fix).\n- styles.css:3768-3775 gives `.hv2-greeting` `padding: 4px 14px 0`. `.hv2-greeting-brand` has the same font, italic, 600 weight and `--fs-2xl` size as the topbar mark.\n- The ui-v2 class is always set (app.js:857 always adds \"ui-v2\").\n- `renderHomeV2()` (app.js ~7887) always calls `homeGreeting()` first, and that emits `<span class=\"hv2-greeting-word\">Good morning</span> <span class=\"hv2-greeting-brand\">4a</span>` (app.js:7585-7591).\n- No rule hides the topbar wordmark on `view-home`.\n\nSo Home shows two identical italic \"4a\" marks one above the other: the fixed 44px bar, then the greeting just below it.\n\n**Why it is not 'deliberate'**\n- docs/DECISIONS.md has no ruling on the greeting or on showing the brand twice.\n- test/ui-tokens.test.js:571-579 checks that the two marks share one typeface (\"the wordmark is one mark\"). It says nothing about both appearing on one screen.\n- The source mockup (docs/ux/foray-mockup.jsx `HomeScreen`, ~550-556) does put \"Good evening\" over an italic \"foray\" brand. That mockup has no separate topbar wordmark above it, though. The doubling comes from putting the mockup's greeting under the app's permanent topbar, which the qa 47 fix then made pixel-identical.\n- It is not already fixed.\n\n**Severity**\nLow. This is cosmetic and reads as redundancy, with no functional effect. The claim that the greeting \"looks like it is addressing 4a\" is the auditor's opinion, but it is plausible. A fix should keep the test at ui-tokens.test.js:571 passing, for example by dropping the brand span from the greeting or hiding `body.view-home .topbar h1 a`.",
  "merged_ids": [],
  "lane": "L7-styles-touch-visual"
}
```

## p-first-10 — Every subject/playlist page tells a newcomer "0 played" in its subtitle

**confirmed** · verifier severity **low** (finder: low) · p-first · `app.js:8159` · L6-navigation-firstrun-copy

```json
{
  "id": "p-first-10",
  "lens": "p-first",
  "title": "Every subject/playlist page tells a newcomer \"0 played\" in its subtitle",
  "file": "app.js",
  "line": 8159,
  "severity": "low",
  "user_visible": "Tapping any \"Episodes for you\" card or generated playlist gives a head line like \"3 episodes · picked for you · 0 played\" on a first run — a count of nothing on every list the newcomer opens. Apple shows played state per row, never a zero tally in a header.",
  "evidence": "`<p class=\"sub\">${joinMeta(countLabel(rows.length, \"episode\"), p.isSubject ? \"picked for you\" : …, `${played} played`)}</p>` (app.js:8159) — the last piece is always a non-empty string, so joinMeta never drops it.",
  "why_subtle": "The counter is right and tested (qa 189); its zero state was never looked at because audits started from profiles with history.",
  "fix_sketch": "`played ? \\`${played} played\\` : \"\"` so joinMeta omits it; rows already carry per-episode Played / \"NN min left\" (persona 78 fix).",
  "suspected_deliberate": false,
  "relation_to_round1": "Zero-state gap beside qa 189 / persona 78 (played state), which fixed the non-zero case.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js:8159 at origin/main, and the code is exactly as the finding describes. The last argument to joinMeta is always the template string `${played} played`. That string is never empty, even when played is 0. joinMeta (app.js:980) only drops falsy pieces with filter(Boolean), so \"0 played\" is always rendered. played is the count of rows where hasOpened is true. On a first run there is no picked history and no stored positions, so every subject, generated or user playlist page shows a header like \"N episodes · picked for you · 0 played\". docs/DECISIONS.md has no ruling about a played tally or zero-state header. The page is readable and the per-row state is still correct, so this is a cosmetic polish issue: low severity.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-first-12 — Search's top row for a newcomer is "Followed shows ›" leading to an empty page

**confirmed** · verifier severity **low** (finder: low) · p-first · `app.js:2945` · L4-search-create-playlists

```json
{
  "id": "p-first-12",
  "lens": "p-first",
  "title": "Search's top row for a newcomer is \"Followed shows ›\" leading to an empty page",
  "file": "app.js",
  "line": 2945,
  "severity": "low",
  "user_visible": "The Search tab's first tappable thing under the heading is \"Followed shows ›\"; on a fresh install it opens \"Followed shows / 0 shows you follow / No followed shows yet — tap Follow on a show's page to keep it here\" plus the Follow note. A dead-end shortcut at the top of the app's discovery page in minute two.",
  "evidence": "`<a class=\"page-link-row\" href=\"#/starred-shows\">Followed shows ›</a>` is emitted unconditionally at app.js:2945 (moved above the browse cloud in visual pass 1); `renderStarredShows` prints `${countLabel(starred.length, \"show\")} you follow` (1236) and the empty note (1241). Library already lists Followed shows as a section (8802).",
  "why_subtle": "It was placed for a good reason (the pill used to cover it) and mirrors an Apple pattern, but Apple hides Library shortcuts that are empty.",
  "fix_sketch": "Render the row only when `Object.keys(starredShowsMap()).length > 0`, or replace it on a fresh profile with \"Shows we vouch for\" first.",
  "suspected_deliberate": true,
  "relation_to_round1": "Adjacent to persona 32 (followed shows hidden) — that fix added this row; its zero state was not considered.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. app.js:2945 emits `<a class=\"page-link-row\" href=\"#/starred-shows\">Followed shows ›</a>` inside #sh-browse with no check on starredShowsMap(). A comment there says it was moved above the browse cloud in visual pass 1 (2026-09-23). renderStarredShows (1226-1244) shows \"0 shows you follow\" and \"No followed shows yet — tap Follow on a show's page to keep it here.\" when the map is empty, followed by FOLLOW_NOTE. Library also lists Followed shows as a section (8802). The placement is deliberate: comments at ~2592 and 2945 give the order search, then the starred-shows shortcut, then the editorial row, then A-Z. But neither comment, nor anything in docs/DECISIONS.md, rules on what the row should do when nothing is followed. The only DECISIONS hit for page-link-row is an unrelated removed Playlists→Library link. So the ordering is a documented choice, while the empty-profile dead end is an oversight and not a ruling. This is cosmetic and the user can go back in one tap, so the severity is low.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## p-impatient-1 — A ↺15 / 30↻ tap while a resumed episode is still loading throws the resume point away — ↺15 restarts the episode from 0:00, 30↻ lands at 0:30

**confirmed** · verifier severity **medium** (finder: high) · p-impatient · `player/client.js:1424` · L1-player-transport

```json
{
  "id": "p-impatient-1",
  "lens": "p-impatient",
  "title": "A ↺15 / 30↻ tap while a resumed episode is still loading throws the resume point away — ↺15 restarts the episode from 0:00, 30↻ lands at 0:30",
  "file": "player/client.js:1424 (seekEpisodeBy) → player/queue-state.js:580 (handleSeek in loadingItem) → player/html-audio-backend.js:1575 (onMeta applies startOffset)",
  "line": 1424,
  "severity": "high",
  "user_visible": "Jump back in says '38 min left'. Tap ▶ on the card, and — impatient, before audio starts — tap ↺15 to catch the sentence you missed. The episode starts from the very beginning (0:00). Tap 30↻ instead and it starts at 0:30. The stored position is then overwritten by the 15 s writer, so the place you had reached is gone. Same from the lock screen / car: press play on a resumed episode and immediately ⏪15.",
  "evidence": "`seekEpisodeBy` is `seekEpisodeTo(episodePositionSec() + offset)`, and `episodePositionSec()` returns `backend.currentTime` (line 1358) which is the element's `currentTime` (html-audio-backend.js:1877). During a fresh load the resume offset is NOT yet on the element: `load()` assigns `src` and only writes the offset in `onMeta` — comment at 1572: 'Offset is applied here, not before: assigning currentTime at readyState 0 is discarded'. So `currentTime` reads 0, the nudge computes `clampEpisodeTarget(0-15)` = 0 or 0+30 = 30 (1383-1388 never returns null for 0), `nothingToSeekIn` is false because state is `loadingItem` (1407-1409), and `manager.seek(0)` reaches `handleSeek`'s `loadingItem` branch: `return [S.loadingItem(state.target, state.previous, { seconds, precise }), []]` — 'last wins'. `handleItemLoaded` (queue-state.js:359) then pushes `F.seekTo(pendingSeek.seconds)` AFTER the load already positioned the element at the stored offset, so the pending 0/30 overrides the 38-minute resume. Only the restored-bar path survives, because `setRunning`'s restored branch seeks to `positionSec` after `play()` resolves (client.js:1997).",
  "why_subtle": "Every individual piece is correct: the reducer's 'last seek wins while loading' is right for absolute scrubs, the backend's deferred offset is right for browsers, and the bar honestly paints 0:00 during the load. The defect is that a RELATIVE nudge is computed from a clock that does not yet describe the episode. It only bites on episodes with a stored position — exactly the 'Jump back in' / lock-screen resume flow the founder uses most — and a fresh episode makes the same taps look correct, so testers never see it.",
  "fix_sketch": "Carry the intended start in the loading state (e.g. `S.loadingItem(target, previous, pendingSeek, startOffset)` set by `_loadItem` from the `startOffset` it computes at queue-manager.js:1255) and make `handleSeek`'s loading branch compose: a relative seek becomes `startOffset + delta`. Simpler client-side variant: in `seekEpisodeBy`, when `manager.state?.type === 'loadingItem'` and the element does not yet hold this item (`manager.playheadItemId !== current.id`), base the nudge on `positionReader().resumeOffset(current.id, { duration })` instead of `backend.currentTime`, or defer the nudge until `itemLoaded`. Add a transport-reconcile test: resume at 2280 s, nudge -15 during load, expect 2265.",
  "suspected_deliberate": false,
  "relation_to_round1": "New. Adjacent to qa 155/156 (resume offset handling) and persona 58 (nudges in every mode) but neither covered a nudge that races the load.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the chain holds. client.js `nudgeBy` calls `seekEpisodeBy(offset)` when not in a Foray. That is `seekEpisodeTo(episodePositionSec() + offset)`. `episodePositionSec()` returns `restoredPending.positionSec` only when `restoredPending` is set, and a card ▶ tap goes through `setNowPlaying`, which clears it. Otherwise it reads `backend.currentTime`, which is `this.el?.currentTime`.\n\nIn html-audio-backend.js, `load()` (~1487) assigns the new src on the same element, and the resume offset is only written in `onMeta` on `loadedmetadata`. The comment there says currentTime at readyState 0 is discarded. So until metadata arrives, the element reads 0.\n\n`seekEpisodeTo`'s `nothingToSeekIn` covers only restoredPending, idle and ended, so it is false in `loadingItem`. `clampEpisodeTarget(0-15)` gives 0 and 0+30 gives 30. `manager.seek` then goes through `_transport` → `_handle`. Neither serializes against the in-flight load: `_handle` reduces right away while the load effect is still awaiting `backend.load`. `handleSeek`'s loadingItem branch stores `pendingSeek={seconds:0|30}` (\"last wins\"). `handleItemLoaded` then pushes `F.seekTo(pendingSeek.seconds)` after the load has already placed the element at `_savedPositionFor(item)`. `_perform` 'seekTo' calls `backend.seek` with no guard, so the stored resume point is overridden.\n\nNothing in the nudge path guards against a load in progress. docs/DECISIONS.md has no ruling on nudges or pending seeks during a load. The only restore that survives is the restored-bar branch in `setRunning`, which seeks after `play()` resolves.\n\nSeverity is medium, not high. The window only lasts from the src assignment to `loadedmetadata`, usually well under a second to a few seconds on a slow network or car connection. It needs a nudge during that window. But the result is real loss of the listener's place, and the 15 s writer then saves the wrong position.",
  "merged_ids": [],
  "lane": "L1-player-transport"
}
```

## p-impatient-6 — The Up Next page goes stale while you watch it: when an episode ends and continuous playback removes it, the finished row stays listed as #1 and 'N queued' is one too many until you touch an arrow — then the list jumps

**confirmed** · verifier severity **medium** (finder: medium) · p-impatient · `app.js:2106` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-6",
  "lens": "p-impatient",
  "title": "The Up Next page goes stale while you watch it: when an episode ends and continuous playback removes it, the finished row stays listed as #1 and 'N queued' is one too many until you touch an arrow — then the list jumps",
  "file": "app.js:2106-2114 (nextAfterEnded → saveQueueIds) vs app.js:8517 (renderQueue only called from route and bindUpNextReorder)",
  "line": 2106,
  "severity": "medium",
  "user_visible": "Sitting on Up Next as episode 1 finishes: audio moves to episode 2 (its ▶ turns to ❚❚) but episode 1 is still row 1, the header still says '4 queued', and row 1's ▶ now looks tappable. Press ↓ on any row and the page re-renders: row 1 vanishes, every number shifts, the row under your thumb is a different episode. Same when ⏭ on the steering wheel removes the current one.",
  "evidence": "`nextAfterEnded` does `if (plan.rest) saveQueueIds(plan.rest)`; `saveQueueIds` only writes storage and calls `refreshEpisodeNavigation()`. `renderQueue()` is invoked from `renderCurrentPage` and from the three reorder/remove handlers in `bindUpNextReorder` — nothing repaints `#/queue` on an advance. `syncCardButtons` (client.js:1519) does flip the glyphs, which is what makes the mismatch visible.",
  "why_subtle": "Every other page tolerates a stale Up Next toggle because it re-renders on navigation; the Up Next page is the one surface whose content IS the list, and it is where a queue-builder sits while listening. The plan's Q4 ('freezes at what was queued') was about what plays next, not about the page.",
  "fix_sketch": "In `saveQueueIds` (or in `nextAfterEnded`/`removeFromQueue`), if `currentHash() === '#/queue'` schedule `renderQueue()` preserving scroll (`scrollY` before/after, as `afterQueueMove` does) — or mark the finished row 'played, leaving Up Next' and remove it on the next render. Also highlight the now-playing row (`.up-next-row.is-current`), which today is signalled only by the ❚❚ glyph.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; second-order effect of the continuous-playback fix (persona 30/47/57) on the page round 1 only fixed for reorder focus (qa 65 / persona 27).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "Checked against origin/main 9730b5b and the finding holds. In app.js, nextAfterEnded (line 2106) calls saveQueueIds(plan.rest) when the finished episode was in Up Next. planAfterEnded (2081-2093) takes the finished id out of the list. saveQueueIds (1821) only runs lsSet(\"cp_queue\") and refreshEpisodeNavigation(), which just tells the player what next and previous are.\n\nrenderQueue (8517) is called from only two places: the route switch (12761, `#/queue`) and the three click handlers in bindUpNextReorder (8631/8643/8654). Nothing else looks at `#/queue` to repaint after an advance. The only other auto-repaint by hash is the one for #/library at 8821.\n\nSo when an episode ends with auto-advance on, or the wheel's ⏭ calls playNextAfter, #view keeps the stale rows. The finished row stays at #1, the \"N queued\" header is one too high, and every q-num is off by one. Meanwhile syncCardButtons in player/client.js (about line 1519) swaps the glyphs across all [data-play] buttons, so the next episode shows ❚❚ and the finished one shows ▶. The next tap on an arrow runs moveQueueItem and then renderQueue, which reads the fresh cp_queue. The list then jumps and the removed row disappears.\n\nThe scroll compensation in afterQueueMove measures from the pressed button, so the moved episode itself lands back in place. Every other row still gets renumbered or shifts, and ✕ uses queueIds().indexOf, which is fresh. Nothing in docs/DECISIONS.md covers this: the Up Next entries (2026-08-31 Stage 1) say nothing about repainting on advance. I found no fix on main.\n\nMedium severity is right. Nothing is lost or wrong in storage, but the page is visibly out of date, including a ▶ still showing on an episode that has already left the list.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-impatient-7 — There is no in-app way to skip to the next queued episode: the sheet has no ⏭ and no Up Next list, so 'next' exists only on the lock screen and the car — and the in-app workaround (tap row 2 on the Up Next page) replays row 1 later

**confirmed** · verifier severity **medium** (finder: medium) · p-impatient · `player/client.js:808` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-7",
  "lens": "p-impatient",
  "title": "There is no in-app way to skip to the next queued episode: the sheet has no ⏭ and no Up Next list, so 'next' exists only on the lock screen and the car — and the in-app workaround (tap row 2 on the Up Next page) replays row 1 later",
  "file": "player/client.js:808-818 (fp-row: back/play/fwd only), 827-838 (clips row Foray-only), 872 (row2: Stop, rate, Episode, foray link); app.js:2090 (planAfterEnded wraps skipped rows back in)",
  "line": 808,
  "severity": "medium",
  "user_visible": "With five episodes queued you decide the current one is not for you. The sheet offers ↺15, play, 30↻, speed, Stop, Episode — nothing that moves to the next queued episode, and nothing that shows what is queued. You go Library → Up Next → tap ▶ on row 2. Later, when row 5 ends, row 1 (the one you abandoned) starts playing again, because `planAfterEnded` builds `rest.slice(at).concat(rest.slice(0, at))`. Apple's player sheet has an Up Next list and both CarPlay and the lock screen have ⏭; here ⏭ is car-only.",
  "evidence": "`buildUI` appends `row.append(backBtn, bigPlay, fwdBtn)`; `clips` is `hidden = !isForay` (`setSkipButtonMode`); `row2.append(stopBtn, rateBtn, openLink, forayLink)`. No element in client.js links to `#/queue` (grep: only index.html's drawer link). `EPISODE_NAVIGATION.next` is only consumed via `media.setActions`. Playing a row on `#/queue` goes through plain `playBtn(item)` with no removal (`upNextRow`, 8551), and the finished-episode rule then wraps around to the rows above it.",
  "why_subtle": "Each piece is a documented decision (mini bar = play + one skip; removal lives on the queue page; wrap-around keeps unheard rows). Together they mean the person who builds queues has to leave the player to move through the queue, and the queue quietly re-serves what they skipped.",
  "fix_sketch": "In the sheet's row2 add an 'Up Next (N)' link to `#/queue` (hidden when empty) and, when `EPISODE_NAVIGATION.next` exists, a ⏭ 'Next episode' control that calls the same `playNextAfter(cur, 'skip')` the car uses (so the skipped episode leaves Up Next, Apple-style). On `#/queue`, playing row k could remove rows 1..k-1 or at least ask — or document the wrap-around on the page.",
  "suspected_deliberate": true,
  "relation_to_round1": "Related to persona 10/79 (bar has one control) which added ↺15; the absence of any in-app next for a queue was not raised.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "Checked against origin/main at 9730b5b.\n\n**Missing in-app next: confirmed.**\n- In player/client.js, `row.append(backBtn, bigPlay, fwdBtn)` is the whole transport row. The clip row (`clips`) is hidden unless a Foray is loaded. `row2.append(stopBtn, rateBtn, openLink, forayLink)` has no next control.\n- Nothing in client.js links to `#/queue`. The only link to it is the drawer entry in index.html:67.\n- `episodeNavigation` / `EPISODE_NAVIGATION.next` is only used through `media.setActions(episodeMediaSurface)`, which means the lock screen and the car. No button in the page calls it.\n- So with Up Next full, the only in-app way to move on is Library/drawer → Up Next → ▶ on a later row.\n\n**Wrap-around: the code behaves as the finding says.**\n- Playing a row on `#/queue` goes through plain `playBtn(item)` (`upNextRow`, app.js:8547) and does not remove the rows above it.\n- In app.js:2081-2101, `planAfterEnded` builds `fromQueue = rest.slice(at).concat(rest.slice(0, at))`. Worked example with queue [1,2,3,4,5] and row 2 playing: after it ends the order is [3,4,5,1], so row 1 plays again at the end.\n- This part looks intended. The code comment says the rows above were skipped past and are \"still unheard, or it would have left\". But no docs/DECISIONS.md entry rules on it. The 2026-08-31 Up Next entries and the later auto-advance \"keep playing\" ruling cover defaults and scope, not skip-past rows and not an in-app next control. So as a whole the finding is not covered by a ruling.\n\n**Not fixed.** The only \"next\" work is the 2026-09-23 steering-wheel wiring, which is lock screen and car only.\n\n**Severity: medium.** Nothing crashes and a workaround exists. But a common podcast action has no in-app path, and the workaround brings the abandoned episode back later.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-impatient-8 — Up Next reorder is one step per tap with a full page rebuild each time — moving the bottom of a 20-deep queue to the top is 19 taps; no drag handle, no 'play next', no swipe-to-remove, no clear

**confirmed** · verifier severity **low** (finder: low) · p-impatient · `app.js:8622` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-8",
  "lens": "p-impatient",
  "title": "Up Next reorder is one step per tap with a full page rebuild each time — moving the bottom of a 20-deep queue to the top is 19 taps; no drag handle, no 'play next', no swipe-to-remove, no clear",
  "file": "app.js:1854-1862 (moveQueueItem swaps neighbours), 8622-8658 (each press → renderQueue())",
  "line": 8622,
  "severity": "low",
  "user_visible": "You queued ten episodes and want the newest one first. Ten presses of ↑, each re-rendering the whole list (the page scrolls to keep the button under your thumb, but the list flashes each time). There is no 'Play next' on rows, no drag, no way to clear the queue but ten ✕ taps. Apple Podcasts: drag handles, swipe-to-remove, 'Play Next' / 'Play Last'.",
  "evidence": "`moveQueueItem`: `[ids[i], ids[j]] = [ids[j], ids[i]]` with `j = i + dir`. The handlers call `moveQueueItem(id, ±1); renderQueue(); afterQueueMove(...)`. `addToQueue` only appends (`ids.concat(id)`). docs/listening-queue-plan.md §1 left 'drag or up/down controls … deferred to implementation'.",
  "why_subtle": "Round 1 made the arrows big enough and kept focus/scroll stable, which makes the model feel finished; the cost is only felt at queue depth, which is the power user's normal state.",
  "fix_sketch": "Add pointer-drag reorder on the `.q-num`/handle (pointer events, same discipline as the strip scrub), 'Play next' as a second add-side action (insert at index of current+1), and a 'Clear Up Next' action with confirm on the page head. Keep the arrows as the keyboard/AT path.",
  "suspected_deliberate": true,
  "relation_to_round1": "Builds on qa 5/16, persona 11/27 (fixed the controls, not the model).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js and the code matches the finding. `moveQueueItem` (around line 1854) swaps an item only with its neighbour: it sets `j = i + dir` and does nothing if that would run past either end. The up and down handlers in `bindUpNextReorder` (around lines 8622-8645) each call `moveQueueItem(id, ±1); renderQueue(); afterQueueMove(...)`, so every tap moves one step and rebuilds the whole list. `afterQueueMove` scrolls to keep the button under the thumb and announces the new position, so this is a usability gap and nothing breaks. `addToQueue` only appends (`saveQueueIds(ids.concat(id))`). A search for play next, clear queue and `saveQueueIds([])` found nothing: `playNextAfter` is the auto-advance/skip path, not an insert-next action. The only pointerdown handlers are the strip scrub and a document-level listener, so Up Next has no drag reorder. No DECISIONS.md ruling rules out drag, Play next or clear. The 2026-08-31 Up Next Stage 1 entry defers only named/multiple queues and auto-advance. docs/listening-queue-plan.md line 82 says 'drag or up/down controls' was left to implementation, so up/down arrows are an allowed minimum, not a decision against drag. That makes the arrows a cheap first version rather than a ruled choice, not 'deliberate'. Severity is low: reordering, removal and accessibility all work, and the queue is usually short. The 'list flashes' claim follows from the full rebuild, but I did not check it visually.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-impatient-10 — '+ Up Next' on an archived playlist part accepts an episode that cannot play: the button turns '✓ Up Next', the row lands in Up Next as 'not available right now', and continuous playback silently passes over it

**confirmed** · verifier severity **low** (finder: low) · p-impatient · `app.js:8087` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-10",
  "lens": "p-impatient",
  "title": "'+ Up Next' on an archived playlist part accepts an episode that cannot play: the button turns '✓ Up Next', the row lands in Up Next as 'not available right now', and continuous playback silently passes over it",
  "file": "app.js:8087 (archivedRow renders upNextBtn) with 1834-1842 (addToQueue) and 1918-1920 (rememberEpisode no-op without audio_url)",
  "line": 8087,
  "severity": "low",
  "user_visible": "On an older playlist a row reads 'Not available to play' yet still offers '+ Up Next'. Tap it: it confirms '✓ Up Next'. Up Next now shows the row greyed with 'not available right now', no ▶, and when its turn comes the queue skips it without a word (`planAfterEnded` → `find(isPlayableId)`).",
  "evidence": "`archivedRow` emits `${named ? upNextBtn(item.id) : ''}` beside `notPlayableNote()`. `addToQueue` has no playability check (`if (ids.includes(id)) return; saveQueueIds(ids.concat(id))`). `rememberEpisode` returns early because the seeded part has no `audio_url`, so the row can only ever resolve as `archived`.",
  "why_subtle": "The add control is idempotent and always succeeds by design; the row already says the episode cannot play, so the two truths sit side by side and the queue page repeats the contradiction.",
  "fix_sketch": "Omit `upNextBtn` from `archivedRow` (or render it disabled with title 'Not available to play'), and have `addToQueue` refuse ids for which `liveEpisode(id)` is null.",
  "suspected_deliberate": false,
  "relation_to_round1": "New; adjacent to qa 142 (aged-out part states its unavailability twice).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main app.js and the finding holds.\n\n**What the code does**\n- `archivedRow` (around line 8075) renders `${named ? starBtn(item.id) : \"\"}${named ? upNextBtn(item.id) : \"\"}${unavailable}`. A named aged-out playlist part therefore shows \"+ Up Next\" right beside \"Not available to play\".\n- `addToQueue` (line 1834) never checks whether the episode can play. It de-dupes, calls `saveQueueIds(ids.concat(id))`, then `rememberEpisode(id)`.\n- `rememberEpisode` (line 1918) returns early when the snapshot has no `audio_url`, and an archived part never has one because `audio_url` is deliberately not saved.\n- The button switches to \"✓ Up Next\" (UP_NEXT_TOGGLE, line 1092).\n- On `#/queue`, `upNextRow` draws the archived row greyed, with \"not available right now\" and no ▶.\n- `planAfterEnded` picks the next episode with `fromQueue.find(isPlayableId)`, so continuous playback skips the row without saying anything.\n- There is also a side effect the finding does not mention. Because nothing is remembered, after a reload the row can drop to the \"unnamed\" state (\"Episode no longer available\") unless the episode is starred.\n\n**Is it deliberate?**\nOnly partly.\n- `docs/listening-queue-plan.md` Stage 1 and the 2026-08-31 DECISIONS entry both name `archivedRow` as a place for \"+ Up Next\". That was decided when an archived row still had a \"Listen in your podcast app\" link-out.\n- PR #452 removed that link-out, and the button stayed.\n- The 2026-09-22 supersession note makes \"an unplayable row is passed over rather than stopped at\" the intended queue behaviour. So the silent skip is the documented rule.\n- No ruling covers offering \"+ Up Next\" on a row the app itself labels \"Not available to play\".\n- A charitable reading is that queuing is useful in case the episode comes back to the pool, since `liveEpisode` would then resolve it. Nothing documents that intent, and the same row says \"Not available to play\".\n\nSo the finding is confirmed as an inconsistency that followed from #452.\n\n**Severity: low.** Nothing is lost or corrupted. It is a confusing false success, limited to aged-out parts of older playlists.",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-impatient-11 — A queue-builder with a long Up Next can lose the FRONT of it: the 400-snapshot cap prunes oldest keys first, and Up Next + History together exceed it

**confirmed** · verifier severity **low** (finder: low) · p-impatient · `app.js:1921` · L3-queue-and-native-surfaces

```json
{
  "id": "p-impatient-11",
  "lens": "p-impatient",
  "title": "A queue-builder with a long Up Next can lose the FRONT of it: the 400-snapshot cap prunes oldest keys first, and Up Next + History together exceed it",
  "file": "app.js:1895 (EPISODE_SNAPS_CAP = 400) and 1921-1928 (rememberEpisode keep/prune)",
  "line": 1921,
  "severity": "low",
  "user_visible": "Someone who queues generously (200+ from show pages) and has a full 200-entry history sees the earliest queued rows turn into 'not available right now' with no ▶ after the next add, and continuous playback skips them.",
  "evidence": "`keep = new Set(queueIds().concat(pickedHistory(), id))` then `for (const k of ids.slice(0, Math.max(0, ids.length - EPISODE_SNAPS_CAP))) delete next[k]` — deletion is by object-key insertion order, i.e. the oldest remembered episodes, which are the head of Up Next. Show-page episodes are live only through this snapshot (`liveEpisode`, 1946-1950).",
  "why_subtle": "The comment calls the cap 'a backstop, not the usual limit' and assumes 'a few dozen in practice'; the prune order is not queue-aware, so the rows lost are the ones about to play.",
  "fix_sketch": "Prune history-only keys before queue keys (or raise the cap and store hooks separately); at minimum never delete a key that is in `queueIds()`.",
  "suspected_deliberate": false,
  "relation_to_round1": "New.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main of app.js and the code matches the finding. In `rememberEpisode` (lines 1918-1929), `keep` is the Up Next ids plus the history ids plus the new id. Snapshots outside that set are filtered out, and then `ids.slice(0, ids.length - EPISODE_SNAPS_CAP)` deletes the first keys in object-key order. That is insertion order for these non-numeric ids, so the oldest-remembered survivors go first, and nothing stops those from being Up Next ids.\n\nNothing limits the queue's size. `addToQueue` (1834) has no cap, and `cp_queue` is only de-duplicated. History is capped at 200 (`slice(-200)`, line 1259). Suppose Up Next holds about 200 or more ids that are not in history, and history is full. The keep set then exceeds 400, and the next add prunes the earliest-queued snapshots.\n\n`liveEpisode` (1946-1958) plays a non-pool id only from `itemIndex`, `cp_saved` or `cp_episode_snaps`. After a reload, a pruned show-page episode that was never starred shows as an archived or unnamed row that cannot be played.\n\nThe comment at 1892-1894 says the cap is a backstop because Up Next is \"a few dozen in practice\". That is a sizing assumption, not a decision to let queued snapshots be lost. docs/DECISIONS.md has no ruling on this, and nothing has fixed it.\n\nSeverity is low because several conditions have to line up:\n- 200+ queued episodes, far outside normal use\n- a full history\n- the affected episodes are outside the curated pool and not starred\n- a reload before the loss shows up",
  "merged_ids": [],
  "lane": "L3-queue-and-native-surfaces"
}
```

## p-foray-1 — The interlude jingle plays between two clips of the SAME conversation - 13 of the 21 seams in the only published Foray

**confirmed** · verifier severity **medium** (finder: high) · p-foray · `player/interlude.js:123` · L8-foray-surfaces

```json
{
  "id": "p-foray-1",
  "lens": "p-foray",
  "title": "The interlude jingle plays between two clips of the SAME conversation - 13 of the 21 seams in the only published Foray",
  "file": "player/interlude.js",
  "line": 123,
  "severity": "high",
  "user_visible": "Listening to capital-types-1, the 3 s musical sting fires at every auto-advance, including FAM-1>FAM-2, YC-2>YC-3, GR-1>GR-2>GR-3, VD-1>VD-2>VD-3>VD-4, SBA-1>...>SBA-4 and CF-1>CF-2 - same guest, same room, same episode, a minute or two apart. The strip draws those joins as a hairline inside one capsule (no seam), so the ear hears a channel change the eye says did not happen. Over 51 minutes the sting sounds 21 times, about every 2.4 minutes; it reads as the app interrupting one interview with its own logo.",
  "evidence": "interludeEligible({from,to,cause}): `if (cause !== AUTO_ADVANCE) return false; if (!from || !to) return false; if (!isSegment(to)) return false; if (from.kind === JINGLE) return false; return true;` - never compares source episodes. player/seam-gap.js:108 seamGapSec is the same. By contrast player/segment-strip.js sourceKeyOf groups bars by source_item_id, so same-episode neighbours render as one capsule. Data (data/forays.json + data/segments.json, capital-types-1): items 2>3, 4>5, 9>10>11, 12>13>14>15, 16>17>18>19, 20>21 share item_id - 13 same-episode seams of 21. Founder brief as quoted in docs/curation/narration-craft.md:143: 'the little jingle that we want to use as an interlude between podcasts'. docs/curation/segment-length-rules.md section 6b: a same-episode jump cut is marked with >= 2.0 s silence or narration.",
  "why_subtle": "Only audible after listening for a stretch; tests pass because the rule is 'is the next item a segment', and the strip - the thing reviewers look at - already distinguishes the two seam kinds correctly, so audio and visual silently disagree.",
  "fix_sketch": "Give interludeEligible the same source test the strip uses: import sourceKeyOf (or compare from.source_item_id/item_id to to's) and return false when equal, keeping the 2.0 s beat from seamGapSec for same-episode cuts. Add a describeInterlude reason ('same episode'). Pin with the capital-types-1 fixture: exactly 8 jingles for 21 seams.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; qa 32 (jingle then silence) was refuted and is a different claim",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the core claim holds, but the count is wrong: it is 11 same-episode seams out of 21, not 13.\n\n**The code.** In player/interlude.js (line 123, last touched in d8b0de0 / #634), `interludeEligible` checks only four things: the advance was automatic, both items exist, the next item is a segment, and the previous item is not a JINGLE. It never compares `source_item_id` or `item_id`. The one caller, `_armInterlude` in player/queue-manager.js (around line 1909), adds no source check of its own. player/segment-strip.js does have `sourceKeyOf`, which the strip uses to group bars by source episode, but interlude.js does not import or use it.\n\n**The data.** capital-types-1 is the only Foray with status \"published\" in data/forays.json. It has 22 items, all `type: \"segment\"`, with no narration or jingle items, so it has 21 automatic seams and every one qualifies for the jingle. By segment_id episode prefix, these neighbours share an episode:\n- FAM-1>FAM-2 (1 seam)\n- YC-2>YC-3 (1)\n- GR-1>GR-2>GR-3 (2)\n- VD-1..4 (3)\n- SBA-1..4 (3)\n- CF-1>CF-2 (1)\n\nThat is 1+1+2+3+3+1 = 11 same-episode seams. The finding's own list adds up to 11, not 13. BOOT-1, YC-1, CALM-1, BOOT-2 and CALM-3 each sit next to a different episode. With runtime_sec 3082 (about 51 minutes) and 21 jingles, \"about every 2.4 min\" is accurate.\n\n**Is it deliberate?** docs/DECISIONS.md does not mention interlude or jingle. The interlude.js header and narration-craft.md do say \"segment → segment\" on purpose, and the settings label is \"Jingle between segments\", so it was a considered rule. But it disagrees with the founder request quoted in the same doc, \"an interlude between podcasts\". Neither file mentions same-episode joins or rules on them, so this looks like an oversight rather than a decision.\n\n**Severity.** I rate it medium rather than high. It is a real, audible mismatch with the strip's single-capsule display and with the founder's stated intent, affecting about half the seams of the only published Foray. But nothing breaks, the asset is still a placeholder, and there is an off switch in Settings (\"Jingle between segments\", `cp_interlude`).\n\n**Fix.** The suggested fix is sound, with one change: the pinned fixture count should be 10 jingles for 21 seams, not 8.",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## p-foray-2 — Every show in the only published Foray is a dead end in-app: no row links, and all seven credit arrows send the listener to an Apple Podcasts SEARCH page

**confirmed** · verifier severity **medium** (finder: high) · p-foray · `app.js:2438` · L8-foray-surfaces

```json
{
  "id": "p-foray-2",
  "lens": "p-foray",
  "title": "Every show in the only published Foray is a dead end in-app: no row links, and all seven credit arrows send the listener to an Apple Podcasts SEARCH page",
  "file": "app.js",
  "line": 2438,
  "severity": "high",
  "user_visible": "On capital-types-1 the show name on every clip row is plain text, the 'Where this came from' names are plain text, and each ↗ (labelled 'Open X on Apple Podcasts') opens https://podcasts.apple.com/us/search?term=... - a results page, not the show. A listener who loved a clip cannot Follow the show, open its page, or find more episodes without leaving 4a, in an app whose own rule (notPlayableNote comment) is that it 'never sends a listener elsewhere'.",
  "evidence": "showIdForShowName reads only `state.catalog?.shows` (the curated 220): `const shows = state.catalog?.shows || []; let s = shows.find(sh => sh.title === showName);`. forayShowId (app.js:9275) tries entry.show_id via showById, which is also catalog-or-cache only. Measured on data/: none of The Bootstrapped Founder, Y Combinator Startup Podcast, The Startup Solution, Feel the Boot, Run the Numbers, Acquiring Minds, Crowdfunding Demystified is in catalog.json or discover.json (so no apple_collection_id), while data/show-index.tsv - the 10,113-row index the Search tab and show pages already use via pi: ids - carries at least two of them by title and is never consulted here. foraySourcesHtml (app.js:9634) hard-codes 'Open ... on Apple Podcasts' and ignores the `linkKind` (APPLE_SEARCH vs APPLE_SHOW) that player/foray-sources.js exposes precisely 'so a surface can be honest about it'.",
  "why_subtle": "Every other surface moved off the 220-pool identity test in round 1 (theme A) but the Foray page's two joins did not; the page still looks complete because the names are printed and an arrow is present.",
  "fix_sketch": "Resolve credits through the show index too (title match into show-index.tsv -> #/show/pi:<n>, same path renderAllShows uses) before falling back; when only an Apple search link exists, label it 'Search Apple Podcasts for X' or drop the arrow in favour of the in-app show page + Follow. Add a test over the published Foray: every credited show links in-app or the arrow says search.",
  "suspected_deliberate": false,
  "relation_to_round1": "incomplete fix of qa theme A (pool used as identity) on the Foray page; R7 deleted 'Open in' everywhere else",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked the finding against origin/main and the facts hold.\n\n- **The published Foray.** capital-types-1 is the only Foray with status \"published\" in data/forays.json. The other six are drafts.\n- **The seven shows.** They are The Startup Solution, Y Combinator Startup Podcast, Acquiring Minds, Feel the Boot, Crowdfunding Demystified, Run the Numbers and The Bootstrapped Founder. None of them is in catalog.json or in discover.json.\n- **Title lookup.** showIdForShowName (app.js:2438) searches only state.catalog.shows. forayShowId (app.js:9275) tries showById on entry.show_id first, then falls back to the title. So the show names in the clip rows, the cites and \"Where this came from\" render as plain text. The forayShowId comment even says that capital-types-1's small independent shows \"do not link at all\".\n- **The ↗ link.** player/client.js:3728 turns discover.json into collection ids (collectionIdsByShow), and none of these shows is in it. So showLink returns https://podcasts.apple.com/us/search?term=... for all seven, with kind APPLE_SEARCH.\n- **The label.** foraySourcesHtml (app.js:9634) always sets the aria-label to \"Open X on Apple Podcasts\" and never reads linkKind. The foray-sources.js header says linkKind exists \"so a surface can be honest about it\".\n- **The show index.** Only 2 of the 7 titles (Y Combinator Startup Podcast, Acquiring Minds) match a row in show-index.tsv exactly. The suggested fix would only partly help.\n\nNot deliberate. Nothing in DECISIONS.md rules on how Foray credit links should behave. The search fallback itself is a documented design choice in foray-sources.js, but the label that ignores linkKind contradicts that same module's stated intent.\n\nWhy medium rather than high: calling it a \"dead end\" overstates it. The Apple search page does lead to the show, and the credit block does name the source and episode. What is real: nothing links to a show page inside the app, the aria-label says it opens the show when it opens a search, and it breaks the app's own rule that it \"never sends a listener elsewhere\" (the comment at app.js:8064).",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## p-foray-3 — 'Jump back in' Foray cards have no play button, although the founder asked for one-tap play on that card and the ribbon already resumes a Foray in one press

**deliberate** · verifier severity **low** (finder: medium) · p-foray · `app.js:7730`

```json
{
  "id": "p-foray-3",
  "lens": "p-foray",
  "title": "'Jump back in' Foray cards have no play button, although the founder asked for one-tap play on that card and the ribbon already resumes a Foray in one press",
  "file": "app.js",
  "line": 7730,
  "severity": "medium",
  "user_visible": "Home > Jump back in shows a Foray card with a progress bar and '28 min left' but no play control; the episode card beside it has one. Resuming the app's signature object is card > Foray page > Resume (three taps), while an episode is one.",
  "evidence": "`const play = c.kind === 'episode' ? playBtn(c.item, 'jbi-episode') : '';` with the rationale 'a one-tap play on either would be choosing a starting point on the listener's behalf'. For a resume card the starting point is already known (c.percent/c.left come from forayResumeList), and player/client.js:3034 restoreForay + setRunning's restored branch already start a part-played Foray at its stored elapsedSec from a single ribbon press.",
  "why_subtle": "The founder's 2026-09-21 request was implemented for the episode card only; the comment's rationale is true for 'Forays for you' cards and false for resume cards, and nothing looks broken.",
  "fix_sketch": "For c.kind === 'foray' render a sibling play button that resolves the Foray (forayViewOpts) and calls player.playForay(r, { startElapsedSec: resume.elapsedSec, ...}) via guardForayStart - the same call the page's Resume makes; keep the stretched-link card shape from qa 78.",
  "suspected_deliberate": true,
  "relation_to_round1": "new; builds on the 2026-09-21 founder request and persona 7 fix",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. app.js:7730 is `const play = c.kind === \"episode\" ? playBtn(c.item, \"jbi-episode\") : \"\";`, so a Foray (or playlist) Jump back in card gets a bar and a time-left label but no play control. player/client.js restoreForay (around line 3034) does start a part-played Foray at startElapsedSec from one ribbon press, so the one-tap path the finding points to exists.\n\nIt still reads as a deliberate choice rather than an oversight:\n1. The comment directly above line 7730 says in so many words that the card is for episodes only: \"A Foray and a playlist are sequences whose card is a way IN to a running order, and a one-tap play on either would be choosing a starting point on the listener's behalf.\"\n2. Commit 564e682 (#732), which acted on the 2026-09-21 founder report, repeats that rationale in its message (item 2).\n3. The finding overstates the founder's ask. His report (\"press the card then press play\") came from an episode card: the same commit fixes \"EPISODE NOT FOUND\" when he tapped that card. He never asked for play on Foray cards.\n\nNo docs/DECISIONS.md entry rules on JBI play buttons either way, so this is design intent written in code and a commit, not a formal ruling.\n\nThe finding's pushback has some merit. For a resume card the starting point is already known (the stored elapsed time), so the stated rationale is weak in that case. That makes this a product suggestion to revisit the choice, not a bug. Severity: low.",
  "merged_ids": [],
  "lane": null
}
```

## p-foray-4 — Search cannot find a Foray: typing the Foray's own subject returns shows, episodes and playlists, never the Foray

**confirmed** · verifier severity **medium** (finder: medium) · p-foray · `app.js:6869` · L4-search-create-playlists

```json
{
  "id": "p-foray-4",
  "lens": "p-foray",
  "title": "Search cannot find a Foray: typing the Foray's own subject returns shows, episodes and playlists, never the Foray",
  "file": "app.js",
  "line": 6869,
  "severity": "medium",
  "user_visible": "Search 'startup', 'capital', 'venture debt' or 'barbecue': results list shows, episodes and a 'Create a playlist about ...' CTA, but 'The types of capital a startup can raise' never appears, even though it is the one thing 4a made about that subject. The only routes to a Foray are Home's rail, Library, and #/forays.",
  "evidence": "renderShowSearchResults / renderAllShows (app.js:2848-7400 region) contain no Foray result kind; the only Foray mention in that range is the D8 note that the 'Create a Foray about X' CTA was retargeted to Playlist. player/foray-resolve.js already exposes listForays with title/summary/topic that a title-and-summary match could run over synchronously.",
  "why_subtle": "Search is the Apple-Podcasts-shaped door newcomers use first; the omission is invisible unless you know a Foray on that subject exists.",
  "fix_sketch": "Add a 'Forays' group at the top of local results: match query tokens against title, summary and slot titles of forayCards() (published + unlocked), render with forayCardV2Html or the fy-home-row shape; no network, no engine change.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; D8 governs the Create CTA only, not search results",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main (9730b5b) and the finding holds. renderShowSearchResults (app.js:6869) calls only paintShowSearchLocal and runShowSearchCostly, then goes on to renderPlaylistSearchResults. I grepped paintShowSearchLocal (6509), runShowSearchCostly (6562) and the renderAllShows template (2848 onward): none of them has a Foray result kind. In the 6400-7100 range the only mentions of Foray are the D8 comments about moving the \"Create a Foray about X\" CTA to Playlist. Forays are reachable only through forayCards() (10901), which feeds Home, Library and the #/forays list, and through the \"Forays using this show\" footer on a show page (foraysUsingShow at 3399). No search path reaches them.\n\nIt is not covered by a ruling. docs/ui-transition-plan.md D7/U-05 adds a Playlists section beside Shows and Episodes. D8 only keeps Foray generation (the Create CTA) out of the UI. Nothing in docs/DECISIONS.md or the plan says published Forays must be left out of search results. The mockup's SearchScreen has Browse subjects, Popular shows and a create-a-foray suggestion, but no Foray results section. So this is an omission rather than a decision.\n\nIt has not been fixed on main. Severity is medium: this is a findability gap for the product's core object in a small catalogue where the Home rail and Library still reach it. Nothing crashes and no data is wrong.",
  "merged_ids": [],
  "lane": "L4-search-create-playlists"
}
```

## p-foray-5 — Clip rows are captioned with the curator's private 'why' notes: bare surnames and dangling pronouns, and the episode title is never shown on the row

**confirmed** · verifier severity **medium** (finder: medium) · p-foray · `app.js:9480` · L8-foray-surfaces

```json
{
  "id": "p-foray-5",
  "lens": "p-foray",
  "title": "Clip rows are captioned with the curator's private 'why' notes: bare surnames and dangling pronouns, and the episode title is never shown on the row",
  "file": "app.js",
  "line": 9480,
  "severity": "medium",
  "user_visible": "Rows on the published Foray read 'Kahl names the power imbalance that makes venture money wrong for a small SaaS', 'The terms: shares stay his until he sells, and a dividend share above a salary floor', 'Reserves: a seed investor needs 30 to 40 percent more than the first cheque'. Who is Kahl? Whose shares? The row shows only show name and length; the episode title lives only in the credits block at the foot of the page, with no link between the two.",
  "evidence": "forayRow prints `<p class=\"fy-why\">${esc(entry.why)}</p>` under a meta line of `[credit, dur]` only; entry.episode_title (used by forayCredits) is never rendered on the row. data/segments.json `why` values for capital-types-1 (tbf-309-funded#..., tbf-328-tringas#...) are written in editor voice - the field is also what forayBeatName reads aloud to a screen reader (app.js:9312).",
  "why_subtle": "The lines are well written, so they look like copy; they were authored as curation rationale and the person or episode they refer to is only in the curator's head.",
  "fix_sketch": "Add the episode title to the meta line (entry.episode_title, already resolved) or as a second line; add a check-forays / copyRules gate for why-lines starting with a bare capitalised surname or an unanchored 'his/her/their', and rewrite the 22 published lines in listener voice.",
  "suspected_deliberate": true,
  "relation_to_round1": "new; adjacent to persona 62 (raw reasons) and qa 145 (vocabulary) which were about other strings",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. In app.js, forayRow (lines 9435-9495) builds the meta line from `[forayCreditHtml(entry), dur]` only, and then renders `<p class=\"fy-why\">${esc(entry.why)}</p>` at 9461 (unplayable rows) and 9480 (playable rows). No episode title appears anywhere on the row. forayBeatName at 9310-9313 builds the accessible name from `[entry.show, entry.why]`, so screen readers also hear the why-line. The only place episode titles show up is foraySourcesHtml (about line 9621), the \"Where this came from\" block at the foot of the page, and nothing links a row to it. The slot titles in forays.json (\"Why venture capital is the wrong default\", etc.) are not rendered as section headers in the running order either, so they add no context.\n\ndata/segments.json has the three quoted lines word for word:\n- line 3438: \"Reserves: a seed investor needs 30 to 40 percent more than the first cheque\"\n- line 3472: \"Kahl names the power imbalance...\"\n- line 3489: \"The terms: shares stay his until he sells...\"\n\nThese belong to segments tbf-309-funded#51, tbf-309-funded#485 and ss-inlaw-investors#565. Other lines use the same editor voice, e.g. \"Roizen's three tests...\" and \"Chidgey explains...\". player/foray-resolve.js:334 copies `seg.why` straight through. capital-types-1 is the only `status: \"published\"` Foray (data/forays.json:137, confirmed by README.md:47 and the round-1 persona audit), so ordinary visitors see these rows.\n\nWhy this is not 'deliberate': the choice to use `why` as the row caption is documented in the forayBeatName comment. But I found no ruling in docs/DECISIONS.md on who the why-lines are written for, or on leaving the episode title off the row. Only the display surface was chosen. The editor voice and the missing episode title are not.\n\nMitigating points:\n- The show credit sits right above each row, e.g. The Bootstrapped Founder, which Kahl hosts, so a careful listener can partly work out who \"Kahl\" is.\n- Nothing is broken, and the fix is copy plus one meta field.\n\nMedium is the right severity: this is the only published Foray, the text is a visible caption and an accessible name on every row, and it reads as unexplained internal notes.",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## p-foray-6 — A thumbs-down for 'Bad audio quality' or 'Didn't like the voice' lowers the listener's interest in the whole subject, exactly like 'Not into this topic'

**confirmed** · verifier severity **medium** (finder: medium) · p-foray · `app.js:9200` · L6-navigation-firstrun-copy

```json
{
  "id": "p-foray-6",
  "lens": "p-foray",
  "title": "A thumbs-down for 'Bad audio quality' or 'Didn't like the voice' lowers the listener's interest in the whole subject, exactly like 'Not into this topic'",
  "file": "app.js",
  "line": 9200,
  "severity": "medium",
  "user_visible": "On a Foray clip, tapping 👎 and choosing 'Bad audio quality', 'Heard this already' or 'Just not this show' (then 'Tune my picks') quietly reduces Home's business/startups or economics/markets weight - every clip in the published Foray carries one of those two topics - so complaining about one host's microphone makes Home show fewer startup episodes.",
  "evidence": "setFeedback: `nudgeTopics([entry.topic], direction === 'up' ? 0.08 : -0.08);` runs for every down-vote regardless of `reasons`; FB_CHIPS (app.js:9170) include 'Didn't like the voice', 'Bad audio quality', 'Heard this already', 'Just not this show', 'Leans too far left/right'. nudgeTopics (app.js:478) also propagates to the parent node.",
  "why_subtle": "The sheet promises specificity ('the more specific, the faster your picks get good') and the chips look like they steer different things; nothing on screen ever shows what changed.",
  "fix_sketch": "Nudge topic only for topic-shaped reasons ('Not into this topic', 'Too surface-level', 'Too in-the-weeds'); record the others as events only (or a show-level signal for 'Just not this show'); keep the 👍 nudge. Pin in a test that a 'Bad audio quality' vote leaves state.interests unchanged.",
  "suspected_deliberate": false,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main (9730b5b) and the evidence holds. FB_CHIPS is at app.js:9168-9172 and includes \"Didn't like the voice\", \"Bad audio quality\", \"Heard this already\" and \"Just not this show\". The sheet's submit button (\"Tune my picks\", line 9576) calls setFeedback(fbTarget, \"down\", { reasons: sheetPicks(), note }) at line 9608. Inside setFeedback (line 9180), whenever a vote has a direction, line 9200 runs `nudgeTopics([entry.topic], direction === \"up\" ? 0.08 : -0.08)` without ever looking at `reasons`. So a down-vote given only for audio quality or the voice still lowers state.interests[entry.topic] by 0.08. nudgeTopics (line 478) also passes a fraction of that change (PARENT_NUDGE_RATIO) to the topic's parent root, and it bumps _interestsGen so the ranking is recomputed. The comment at the call site (\"A thumb is an action the listener took, so it moves the same weights...\") shows the thumbs nudge itself was meant. Nothing says the reason chips were meant to be ignored, though. docs/DECISIONS.md has no ruling on thumbs reasons or chips. The only related entry (line 389) is about the backend learning job, and it says a \"never this show\" signal is not a topic concept and should go to a show blocklist. That argues against treating \"Just not this show\" as a topic down-vote, so it supports the finding rather than covering it as deliberate. I did not check the claim that every clip in the published Foray is tagged business/startups or economics/markets, but the core defect does not depend on it. I rate it medium: the effect is quiet and small per vote (-0.08, clamped to 0..1), but it adds up across votes and turns non-topic complaints into a wrong taste signal that shapes Home.",
  "merged_ids": [],
  "lane": "L6-navigation-firstrun-copy"
}
```

## p-foray-7 — A generated Foray's strip overflows the phone width on the Foray page and silently degrades the scrubber

**confirmed** · verifier severity **medium** (finder: medium) · p-foray · `player/segment-strip.js:551` · L8-foray-surfaces

```json
{
  "id": "p-foray-7",
  "lens": "p-foray",
  "title": "A generated Foray's strip overflows the phone width on the Foray page and silently degrades the scrubber",
  "file": "player/segment-strip.js",
  "line": 551,
  "severity": "medium",
  "user_visible": "Opening any of the four generated Forays (56 items, 40 narration bars) on a 390px phone: the strip runs off the right edge of the sticky transport, the last bars are unreachable, and a tap that should land 'under the finger' lands elsewhere. Draft-only today, but this is the shape every pipeline Foray has.",
  "evidence": "mountStrip: 'DELIBERATELY NO mergeNarration ... Passing the option here does nothing on purpose.' styles.css:2547 puts `overflow: hidden` only on `.fy-strip--static` ('never on .fy-strip, because the player page's strip is the full hour and must not lose its tail'). At --lg (--seg-min 7px, --seam 5px, styles.css:2525) the 56 bars in ~33 capsules need 56*7 + 32*5 + 23 hairlines ~= 575px against a ~358px strip. app.js stripElapsedFromBars then returns null when `spanned > rect.width + 1` and the click falls back to the flat `frac * totalSec` map that its own comment measures as up to 120 s wrong.",
  "why_subtle": "The Home card had the same overflow (founder report, fixed with merge + clip); the page was exempted for scrub accuracy, so the defect moved rather than closed, and only appears with narrated Forays that are not published yet.",
  "fix_sketch": "Merge narration runs on the page too, but give each merged bar data-seg-from/data-seg-to and let the click handler map x inside the bar across the run's items; or keep bars unmerged with a smaller narration floor (3px + hatch) and overflow: hidden with the tail trimmed. Add a test rendering the frozen 56-item fixture at 358px.",
  "suspected_deliberate": true,
  "relation_to_round1": "new; the card half was fixed by the founder's own report, the page half remains",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked every claim against origin/main and the finding holds.\n- player/segment-strip.js mountStrip (around line 551): the \"DELIBERATELY NO `mergeNarration`\" comment is there, and the function doesn't accept a mergeNarration option at all.\n- app.js:9901 mounts #fy-strip through player.stripInto(strip, r.playable, {size:\"lg\"}). In player/client.js:3272 that is a straight pass-through to mountStrip, so nothing is merged on the Foray page.\n- styles.css:2525 sets .fy-strip--lg to --seg-min 7px and --seam 5px, and .fy-seg has min-width: var(--seg-min) with flex-basis 0. .fy-strip has width 100%, a 1px gap and no overflow rule.\n- The only `overflow: hidden` is on .fy-strip--static (styles.css:2547). Its own comment says it is kept off .fy-strip because the player strip \"must not lose its tail\".\n- .fy-transport (styles.css:2349) doesn't clip either, so the extra bars hang off the right edge.\n- data/forays.json at origin/main holds four generated drafts with 51/40, 50/39, 49/38 and 56/40 items/narration. Even the smallest needs about 49*7 + 48*1 = 391px of bar floors and hairlines before any seams. That is already more than the ~358-362px strip the CSS comments themselves measure for a 390px phone.\n- app.js stripElapsedFromBars returns null when `spanned > rect.width + 1`. stripElapsedAt then falls back to `frac * r.totalSec`. The comment above it measures that flat map at up to 120 s off on capital-types-1, and on these strips it will also be computed against a rect that doesn't contain the overflowed bars.\n\nWhy this isn't 'deliberate': I found no docs/DECISIONS.md entry about the strip, mergeNarration, seg-min or overflow. The deliberate choice in the code is only about not merging bars, and it is justified by scrub and fill indexing. No comment or ruling accepts the page strip overflowing. The static-strip comment actually shows the authors expected the page strip to fit. Nothing is fixed on main.\n\nWhy severity is medium: all four affected Forays are status \"draft\". They only show up when the cp_show_drafts test-track switch is on (app.js:9061), so ordinary users don't see this today. But the founder's test drive does, and every pipeline-generated Foray will have this shape once one is published.",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## p-foray-12 — The narrator has three names on one Foray page

**confirmed** · verifier severity **low** (finder: low) · p-foray · `app.js:9291` · L8-foray-surfaces

```json
{
  "id": "p-foray-12",
  "lens": "p-foray",
  "title": "The narrator has three names on one Foray page",
  "file": "app.js",
  "line": 9291,
  "severity": "low",
  "user_visible": "On a narrated Foray (any generated one, visible on the test track and on the first published narrated Foray) the header says '56 clips: 16 from 4 shows and 40 from 4a's narrator', each narration row is credited 'AI Narrator', a screen reader hears 'narration by 4a's AI Narrator', and the intro sentence says 'a narrator'.",
  "evidence": "forayCreditHtml: `<span class=\"fy-credit is-narrator\">AI Narrator</span>`; forayHeadSub (app.js:9687): `... from 4a's narrator`; forayBeatName (app.js:9311): 'narration by 4a's AI Narrator'; FORAY_ABOUT: 'with a narrator between them'.",
  "why_subtle": "Each string was written in a different lane of the round-1 fix; none is wrong alone.",
  "fix_sketch": "One constant (NARRATOR_NAME = '4a's narrator') used by the credit, the header and the accessible name; pin in listener-copy.test.js.",
  "suspected_deliberate": false,
  "relation_to_round1": "new; second-order effect of L4/L5 lanes",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Checked against origin/main app.js; all four strings are there as the finding quotes them. (1) forayCreditHtml at line 9291 returns `<span class=\"fy-credit is-narrator\">AI Narrator</span>`. (2) forayHeadSub at line 9687 builds `... and ${tally.bridges} from 4a's narrator`, which shows on any Foray whose strip tally has bridges, so every narrated Foray gets it. (3) forayBeatName at line 9311 returns \"narration by 4a's AI Narrator\" and feeds the play and thumbs accessible names. (4) FORAY_ABOUT at line 4684 says \"with a narrator between them\".\n\nSo the page really uses three names: \"AI Narrator\" on each narration row, \"4a's narrator\" in the header, and \"4a's AI Narrator\" for screen readers. FORAY_ABOUT uses the plain noun \"a narrator\", which is less of an inconsistency.\n\nNothing in docs/DECISIONS.md rules on what the narrator is called. It has only the 2026-08-16 ruling that a narrator exists, plus the narrator-pipeline gate entries. The comment at 9284 explains why \"AI Narrator\" is not a link. It does not explain why the header uses a different name. The header wording comes from a 2026-09-22 integration comment that aligned the counts with the strip, not the names. That makes this a second-order effect of the L4/L5 merge, as the finding says. It is not a deliberate choice and has not been fixed.\n\nTwo notes for whoever fixes it. First, test/foray-row-links.test.js (line 366, \"a narration beat is credited AI Narrator ...\") pins the \"AI Narrator\" credit, so that test has to change along with the shared constant. Second, the header's \"4a's narrator\" drops the word \"AI\"; the unified name should arguably keep the AI disclosure, e.g. \"4a's AI narrator\".\n\nSeverity stays low: the wording is inconsistent but nothing is misleading or broken.",
  "merged_ids": [],
  "lane": "L8-foray-surfaces"
}
```

## p-foray-13 — The clip feedback sheet talks about Home 'picks' while the listener is judging a Foray clip, and nothing ever asks about the Foray itself

**refuted** · verifier severity **low** (finder: low) · p-foray · `app.js:9545`

```json
{
  "id": "p-foray-13",
  "lens": "p-foray",
  "title": "The clip feedback sheet talks about Home 'picks' while the listener is judging a Foray clip, and nothing ever asks about the Foray itself",
  "file": "app.js",
  "line": 9545,
  "severity": "low",
  "user_visible": "👎 on a clip opens 'What missed for you?' / 'About The Bootstrapped Founder - the more specific, the faster your picks get good.' with the button 'Tune my picks'. The listener thinks they are rating this clip in this Foray; the copy says they are steering Home suggestions. After the Foray ends no surface asks how the Foray was, and the votes (cp_foray_feedback, keyed by segment id) never change anything visible.",
  "evidence": "openFeedbackSheet sets the sub line to `About ${entry.show || 'this clip'} - the more specific, the faster your picks get good.`; syncSheetCta labels the CTA 'Tune my picks'; setFeedback writes lsSet('cp_foray_feedback', all) and logEvent('thumbs'); no Foray-level prompt exists in renderForay or paintForay's ended branch.",
  "why_subtle": "The mockup's asymmetric thumbs were ported faithfully; the framing was written for the home feed and moved with them.",
  "fix_sketch": "Reword to the object in hand ('About this clip from The Bootstrapped Founder' / 'Send'), and add a one-line ended-state prompt on the Foray page ('How was this foray?' 👍 👎) that logs a foray-level thumbs event.",
  "suspected_deliberate": true,
  "relation_to_round1": "new",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The quoted strings are real at origin/main in app.js: the sub line at 9545 reads `About ${entry.show || \"this clip\"} — the more specific, the faster your picks get good.`, and syncSheetCta at 9576 labels the button \"Tune my picks\". What the finding gets wrong is what the copy means and what the vote does. setFeedback (9180-9203) does more than write cp_foray_feedback. It also logs a `thumbs` event that includes foray_id, calls `nudgeTopics([entry.topic], ±0.08)`, then calls trySyncEvents. So the vote moves the listener's taste weights, and those weights decide Home picks. The comment calls this \"the learning loop's input\". The claim that votes \"never change anything visible\" is false, and \"Tune my picks\" describes the real effect. The comment at 9153-9166 also says the lopsided design (up is a silent tap, down opens a sheet) is deliberate and taken from the mockup, so the framing is intended. The only part that holds is that no Foray-level rating appears when a Foray ends: there is no `session_rated` or \"How was this foray?\" in app.js. That is a missing feature, not misleading copy, and it was already listed as a gap in DECISIONS.md, where the events work noted that session_rated did not exist in the client yet. The main claim, that the copy misleads the listener and does nothing, does not hold up.",
  "merged_ids": [],
  "lane": null
}
```

