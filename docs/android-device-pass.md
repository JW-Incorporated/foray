# Android device pass: the script (A-14)

> **NOT ISSUED. Do not send this to Joey yet.** Founder ruling D-A3 (2026-09-29,
> `docs/plans/android-assessment.md` §6): *"don't have joey test until the native
> engine is fully operational."* This pass runs **once, on the first Play build that
> carries A-42** (native Forays on Android). Until then, CI emulator scenarios are the
> only Android testing. The session that issues it edits HUMAN-ACTIONS #127 (which
> already names this file) and fills in "Filled in when issued" below. No agent
> asks Joey for anything before that.

This is the Android device check for Track A0 of `docs/plans/android-assessment.md`,
plus the native-mode checks of A-27, A-40 and A-41, and (Part I, card A-67) the M3-parity
checks of Track A4: route resume, a rendered Foray with the screen off, airplane mode during a
line, and an hour of battery in each lane. It is written for **Joey's Pixel
10 Pro**. Every step says what should happen, so the tester only writes **pass** or
**fail** and pastes the evidence. The record goes in a copy of
`docs/field-records/android-device-pass-TEMPLATE.md`.

**Time.** About 30 minutes of doing, plus two waits in Part E (2 and 10 minutes),
which the script uses to fill in the record. The optional PC block (Part H) adds about
10 minutes at the end. Part I (M3 parity) adds about 20 minutes of doing, a 10-minute wait
and two hours of battery playback, and can run on another day with the same build.

## Filled in when issued

The issuing session writes these in before it asks anyone to run the pass. If any is
blank, stop: the pass is not issued yet.

| | Value |
|---|---|
| Play build under test (versionCode, e.g. `2026110301`) | |
| It carries A-42 (merge commit on `main`) | |
| Native by default on that build, or forced? (see the note below) | |
| Debug APK for Part H: the `android-build` run id on the same commit (artifact `android-shell-evidence` → `app-debug.apk`) | |
| Three short episodes to queue in Up Next (Part C, step 8) | |
| **Foray 1**, which opens with a narrator line and has rendered narration (Parts C, F, H) | |
| **Foray 2**, a different narrated Foray, not yet played on this phone (step 19) | |
| **Foray 3**, a third narrated Foray, not yet played on this phone (step 20) | |
| The row the Android engine writes when a narration file fails and the phone's voice takes over (step 19) | |
| **Foray 4** for Part I: at least two rendered narrator lines BETWEEN clips (clip, line, clip, line, clip); may be Foray 1 if it has them | |
| Part I is issued with this pass (A-60..A-67 on the build under test), or held for a later build | |

Notes for the issuing session:

- **The debug APK does not build itself.** `android-build.yml` has no `push` trigger, so
  a release commit on `main` usually has no run. Dispatch one on a branch whose head is
  that commit (`gh workflow run android-build.yml --ref <branch>`), and issue the pass
  within the artifact's 14-day retention. If the run is gone, Part H cannot run; say so
  here rather than let the tester find out.
- **Native by default, or forced.** `docs/plans/android-assessment.md` lists "a device
  pass" among A-42's own dependencies, while ruling D-A3 says no pass before A-42. If
  the Forays default has not flipped yet because the flip waits on this record, write
  "forced" above: the tester then sets ☰ → Developer → **Playback engine** to
  **Native**, swipes 4a away and reopens it, before step 3. Which reading holds is the
  orchestrator's call, not the tester's.

## What you need

- The Pixel 10 Pro, charged above 50%, on Wi-Fi.
- A **Bluetooth car or a Bluetooth headset**. If you only have a headset, read "car"
  below as "headset", and "steering-wheel buttons" as the headset's buttons.
- **Headphones you can unplug or switch off** (wired, or the same Bluetooth headset).
- **A second phone** that can call the Pixel, and a person or a hand to answer it.
- **Spotify** installed on the Pixel and signed in (free is fine).
- **A stopwatch that is not the Pixel** (a watch, or the second phone).
- Optional: **a PC with `adb`** and a USB cable. On the Pixel: Settings →
  About phone → tap **Build number** seven times, then Settings → System → Developer
  options → **USB debugging** on. Accept the "Allow USB debugging?" prompt when you
  plug in. On the founder's PC, `adb` is at
  `%LOCALAPPDATA%\android-build\sdk\platform-tools\adb.exe`.

## Rules for every step

- **Write pass or fail** for each numbered step, and a short note if something looked
  odd even on a pass. "n/a" is allowed only where a step says so.
- **C = one Copy.** Menu (☰) → **Developer** (at the bottom, above Delete my data) →
  **Playback diagnostics** → **Copy**. Paste it into the record under the step's
  number. Take the Copy after the step, not during it.
- **Every Copy starts with the engine header.** For this pass it must read
  `engine=native … strikes=0 … build=<the build under test>`, and `caps=` must include
  `episode`, `foray` and `restore`. If a Copy says `engine=js`, `strikes=` above 0 or
  another build, **stop and send that Copy**: nothing after it measures the native
  engine. (Part H is the one exception: it switches to the web player on purpose.)
- **Every stop must be explained.** No `stop` row in a Copy may read `cause=unknown`
  (the engine prints it as `stop … src=engine cause=unknown`). If one does, mark the
  step fail even if you heard nothing wrong. The causes an Android Copy can show (A-67's
  audit): `pause`, `close`, `data-deletion`, `relinquish` (the engine handed playback back,
  or its service ended while playing, right after a `service kind=destroy` row), `ended`,
  `final-end`, `system-pause`, `route-change`, `interruption` (a call, another app, a
  navigation prompt), `load-deadline` and `error`. `grace-expired`, `media-services-reset`,
  `seam-timeout` and `unknown` never happen on Android; any of them is a fail.
- **D = the two `adb` reads (PC only).** With the phone on USB, run both and paste the
  output under the step's number. If no PC is at hand, write "no PC" and move on.

  ```
  adb shell dumpsys media_session
  adb shell dumpsys activity services ai.jwlabs.foura
  ```

  What D should show while 4a plays: in `media_session`, a session for package
  `ai.jwlabs.foura` with `active=true`, a playback state of `state=3` (playing; `2` is
  paused), and metadata naming the episode or clip and the show; the line containing
  `Media button session` names `ai.jwlabs.foura`. In `activity services`, a service
  record for `ai.jwlabs.foura` with `isForeground=true` and the `mediaPlayback` type
  (Android prints it as `0x00000002`).
- **S = a screenshot** (Power + Volume down). Attach it to the record.
- **Never "4a", "Playback active" or "Unknown"** as the title anywhere (lock screen,
  notification, car). That is a fail wherever it appears.

## Part A: install and first launch (3 min)

1. **Install from the Play opt-in link.** If 4a is already on the phone, uninstall it
   first (long-press the icon → Uninstall). Open the opt-in link (HUMAN-ACTIONS #44) on
   the Pixel while signed in with the tester Google account, accept the invite, and
   install 4a from Google Play. In the Play Store, open 4a → ⋮ → untick **Enable auto
   update**, so the build cannot change mid-pass.
   *Expected:* Play installs 4a. Play Store → 4a → **About this app** shows the build
   under test.
2. **First-launch screenshot.** Open 4a and take **S** before tapping anything.
   *Expected:* nothing is drawn under the status bar (clock, battery) or under the
   gesture bar at the bottom; no text is cut off at the edges. (A-11)
3. **Header check.** If "Filled in when issued" says **forced**, first set ☰ →
   Developer → **Playback engine** to **Native**, swipe 4a away in Recents and reopen
   it. Take **C**.
   *Expected:* the header rule above holds. If it does not, stop here.

## Part B: speaker, notification, lock screen (6 min)

4. **Deny the notification permission.** Play any episode on the phone speaker. When
   Android asks whether 4a may send notifications, tap **Don't allow**.
   *Expected:* the episode keeps playing. Pull down the shade: the media controls for
   the episode are still there (media controls are exempt from the permission). Lock
   the phone: the lock screen shows them too. If the prompt never appeared, write n/a
   and say so. Then turn notifications back on (Settings → Apps → 4a → Notifications →
   on), so the rest of the pass is not about this. **C**, **D**.
5. **Lock screen and notification buttons.** With one episode playing and **nothing
   in Up Next**, lock the phone.
   *Expected:* the lock screen shows the episode title, the show and the artwork; the
   skip buttons read **15** and **30**; the progress bar moves. Press, in order:
   pause (sound stops), play (sound resumes), back 15 (you hear the last 15 seconds
   again), forward 30 (it jumps ahead). Unlock, pull down the shade, and repeat pause
   and play from the notification: same results, same title. (native-7) **C**.
6. **A dismissed notification stays dismissed.** Pause from the notification, then
   swipe the notification away.
   *Expected:* it stays gone. It does not pop back by itself within 30 seconds. Open
   4a and press play: it comes back. (native-8)
7. **Back on Home while playing.** With the episode playing, go to the Home tab in 4a
   and press Back (the back gesture or button).
   *Expected:* 4a goes to the background, **the audio keeps playing**, and the
   notification stays. (A-07) **C**, **D** (the service is still `isForeground=true`).

## Part C: locked seams, timed (8 min)

8. **Two cross-episode seams, locked.** Add the three named episodes to **Up Next** in
   order. Play the first. In the player, drag the scrubber to about 20 seconds before
   its end. Lock the phone and start the stopwatch at the last word of episode 1; stop
   it at the first sound of episode 2. Unlock, scrub episode 2 to about 20 seconds
   before its end, lock, and time the seam into episode 3 the same way. Write both
   stopwatch times.
   *Expected:* both episodes start by themselves with the screen off. In **C**, each
   of the two seams has a `seam … src=engine` row (the native engine's) reading `gap`
   **4.0 s or less**, and none reads `NEVER AUDIBLE` or `NEVER STARTED`. If a seam has
   only a web-player `seam` row (no `src=engine`; it ends in `hidden=…`), the web player
   played it: that is a fail, whatever its gap. (Pass line: D-A4's 4 s.) **C**.
9. **A locked Foray seam, and a Foray that opens with narration.** Open **Foray 1**,
   press play, and **lock the phone within 2 seconds**. Leave it locked through the
   narrator's opening line and the next two seams (narrator → first clip, first clip →
   next item). Time both seams with the stopwatch.
   *Expected:* the lock screen shows controls from the first line (unlock and relock
   briefly to look if you need to); the first clip starts with the screen off. In
   **C**, the two Foray `seam … src=engine` rows each read `gap` **1.0 s or less** (A-40's line),
   and what you heard was about half a second of silence each time. (native-2, A-40,
   A-15) **C**, **D**.

## Part D: interruptions (5 min)

10. **Headphones unplugged.** Play an episode through the wired or Bluetooth
    headphones. Unplug them, or switch the headset off.
    *Expected:* 4a **pauses within a second**; nothing comes out of the phone's
    speaker. Press play in the app: it plays on the speaker. The Copy shows a route
    row at the moment of the unplug. (A-08, A-09) **C**.
11. **An incoming call.** Play an episode on the speaker or headset. Have the second
    phone call the Pixel. Let it ring 5 seconds, answer, talk about 10 seconds, hang up.
    *Expected:* 4a **pauses when the phone rings**, stays paused during the call, and
    **resumes by itself** within about 3 seconds of hanging up. It never plays over the
    call. (A-12, H-3) **C**.
12. **Spotify takes over.** Play an episode in 4a. Open Spotify and play anything.
    *Expected:* 4a **pauses** as Spotify starts, and does not come back by itself while
    Spotify plays. 4a's notification shows it paused. Pause Spotify. (A-12) **C**.

## Part E: the car or a Bluetooth headset (10 min plus two waits)

13. **Metadata and steering-wheel buttons.** Connect the car (or headset). Play an
    episode from 4a.
    *Expected:* the car's screen shows the episode title and the show (never "4a" or
    "Unknown"), and its progress bar moves. From the steering wheel: pause (stops),
    play (resumes), next (the next item in Up Next, or nothing if it is empty),
    previous mid-episode (the episode **restarts** from its start; p-car-5). If the car
    has a stop control, stop **only pauses**, and play resumes (#742). Write down what
    each button did. **C**, **D**.
14. **Play after a 2-minute pause.** Pause from the steering wheel. Lock the phone.
    Wait **2 minutes**. Press play on the steering wheel.
    *Expected:* **4a** resumes where it paused, not Spotify, within about 3 seconds.
    (H-1)
15. **Play after a 10-minute pause.** Pause from the steering wheel again. Lock the
    phone. Wait **10 minutes** (fill in the record so far meanwhile; do not open 4a).
    Press play on the steering wheel.
    *Expected:* **4a** resumes where it paused, not Spotify, within about 5 seconds.
    (H-1) **C** (one Copy covers 14 and 15).
16. **Play after 4a was swiped away.** Play an episode, pause it, then open Recents and
    swipe 4a away. Lock the phone. Press play on the steering wheel.
    *Expected:* **4a** resumes the same episode, at most 15 seconds before where it
    paused, and its title shows on the car's screen. Not Spotify, and not silence.
    (A-27) Then open 4a and take **C**; **D**.
17. **Negative control.** Play 4a, pause it, play **Spotify** for 10 seconds, pause
    Spotify, then press play on the steering wheel.
    *Expected:* **Spotify** plays. That is correct: the car goes to the app that played
    last. If 4a plays instead, write fail; it means the car's play is not being decided
    by "last played". **C**.

## Part F: narration, voice and the fallback (5 min)

18. **Voice preview during a narration line** (HUMAN-ACTIONS #117 step 2). Play
    **Foray 1** and, while the narrator is speaking a line, open ☰ → **Narration
    voice** and tap **Preview** on any voice.
    *Expected:* the picker says **"Pause playback to preview"** (the native engine's
    answer), and the narrator's line keeps playing to its end; nothing is cut off or
    skipped. "Preview is unavailable while the narrator is on a line." is the web
    player's answer (the one #117 step 2 was written for): write **fail** and send the
    Copy, because it means the web player was playing the Foray, which this build
    must not be doing. **C**.
19. **Airplane-mode narration fallback** (A-41, A-10). Open **Foray 2**'s page while
    online, then turn **airplane mode on**, then press play.
    *Expected:* the narrator's opening line is **spoken by the phone's own voice**
    (it sounds different from the usual narrator) within about 3 seconds; not
    silence, not a stuck spinner. The Copy has the fallback row named in "Filled in
    when issued". If the **usual narrator's** voice speaks the line instead, the file
    was fetched before airplane mode went on, so nothing was tested: write n/a with
    that note. The clip after it cannot load offline; turn airplane mode off and it
    plays within about 30 seconds, or after one press of play (write which). No crash.
    **C**.
20. **A network-only voice offline** (HUMAN-ACTIONS #117 step 3). In **Narration
    voice**, pick a voice whose name ends in `-network`. If there is none, write n/a.
    Open **Foray 3**'s page while online, turn airplane mode on, and press play.
    *Expected:* the narration **moves on at once** (within about 2 seconds) rather than
    after a long silence. If the usual narrator's voice plays the opening line instead
    (the file was fetched after all), write n/a with that note. Put the voice back to
    what it was, and turn airplane mode off. **C**.

## Part G: font size, then Delete my data (4 min)

21. **The "Largest" font size.** Android Settings → Display → **Display size and
    text** → drag **Font size** all the way to the largest. Open 4a: Home, Foray 1's
    page, the player, and the ☰ menu. Take **S** of each. Double-tap some text.
    *Expected:* nothing overlaps, nothing is cut off, no page scrolls sideways, and a
    double-tap does not zoom. Put the font size back.
22. **Delete my data, then relaunch** (the vault). ☰ → **Delete my data** → confirm.
    Then open Recents and swipe 4a away, and open it again.
    *Expected:* 4a opens without an error, with nothing in Up Next and no listening
    history; it does not say "Close 4a fully and try again". Play any episode: it
    plays. In **C**, there is no error row mentioning `sync`, `session` or `vault`.
    **C**.

## Part H: the console reads over USB (optional, PC only, about 10 min)

The Play build's web view cannot be inspected: Capacitor turns WebView debugging on
only for a debuggable build. So this part uses the **debug APK** named in "Filled in
when issued", built from the same commit, and it runs the reads of
`docs/android-lock-screen.md` §8.1, which describe the **web-player lane** (the
fallback the native engine hands back to if it fails). Do it last, because it
replaces the Play install.

23. **Swap in the debug build.** Uninstall 4a. Download the artifact, unzip it, and
    run `adb install app-debug.apk`. Open 4a, then ☰ → Developer → **Playback engine**
    until it reads **Web (applies after restart)**; swipe 4a away and reopen it. Play
    **Foray 1**, and tap **Allow** if Android asks about notifications (this is a fresh
    install).
    *Expected:* it installs and plays; the Copy header now reads `engine=js`. **C**.
24. **The §8.1 reads.** On the PC, open Chrome at `chrome://inspect`, find
    `ai.jwlabs.foura`, click **inspect**, open the Console, and paste each line; copy
    each answer into the record.

    ```
    navigator.mediaSession.forayPolyfill
    window.ForayMediaSession.peek()
    window.ForayMediaSession.inspect()
    await Capacitor.nativePromise("ForayAudio", "state", {})
    await window.ForayAudioShell.refresh(); window.ForayAudioShell.inspect()
    ```

    Run `window.ForayMediaSession.inspect()` a second time a minute later.
    *Expected:* (1) `true`. `undefined` while `navigator.mediaSession` exists means the
    WebView now ships the real API; write that down prominently, it is the most useful
    finding this part can make. (2) the title, show and artwork of what is playing,
    matching the lock screen. (3) `sends` grows between the two reads, by far less than
    four a second and by more than zero. (4) `running: true`, `sessionActive: true`,
    `notificationsEnabled: true`, `notificationPermission: "granted"`. (5)
    `sawServiceRunning: true` and `startAccepted: true`. Then **D**. Last (§8.1 read
    6): lock the phone and press pause, then play, on the lock screen.
    *Expected:* the Foray pauses and plays, and the lock screen shows what read (2)
    showed.
25. **Put the Play build back.** Uninstall the debug build (its settings go with it),
    and reinstall 4a from Google Play. If "Filled in when issued" says **forced**, set
    **Playback engine** to **Native** again and restart 4a; otherwise leave it on
    **Automatic**. Play any episode.
    *Expected:* the Play build is back, and its Copy header reads `engine=native`
    again. **C**.

## Part I: M3 parity on Android (card A-67; about 20 min, a 10-minute wait, two battery hours)

Run Part I on the **Play build** (after step 22 if you skipped Part H, or after step 25),
and only if "Filled in when issued" says it is issued with this pass. It checks what Track
A4 of `docs/plans/android-assessment.md` added to the Android engine: route resume
(A-61), prepared rendered lines (A-62), Next over narration and the fallback's cause
(A-64), and what an hour of native playback costs (iOS's DV-11). Take each **C** with the
phone still, after the step. Write the route (car or headset, and whether Android Auto was
running) next to every Part I result.

26. **A lost route, and its return after 10 minutes.** Play an episode through the car
    or the Bluetooth headset for at least 10 seconds (4a learns a route only after it has
    played through it for a second). With it playing, switch the car or headset **off**.
    *Expected:* 4a pauses within a second; nothing comes out of the phone's speaker. Wait
    **at least 10 minutes** with the phone locked. Switch the car or headset back **on**,
    and do not touch the phone.
    *Expected, with Android Auto running on the car's screen:* 4a resumes by itself within
    about 5 seconds, and its notification is back. *Expected without Android Auto (a
    Bluetooth car or a headset):* 4a does **not** resume by itself, because Android's
    Bluetooth arm is off (D-A9). If the car sends its own play when it connects, 4a plays
    then: write how many seconds after connecting. In **C**: the loss is
    `route kind=lost port=… class=… key=<8 hex> known=true` with a `stop … cause=route-change`
    row; the return is `route kind=back … pausedBy=route` with `decision=resume
    why=route-back` (Android Auto) or `decision=no why=bluetooth-off` (Bluetooth), then the
    car's own `remote … cmd=play` row if it sent one. No address and no device name appear
    in any row. **C**.
27. **A listener's pause stays paused.** Play through the car or headset again for 10
    seconds, then pause **in the app**. Switch the car or headset off, wait 30 seconds, and
    switch it on.
    *Expected:* 4a **stays paused**, whatever the car is (with or without Android Auto).
    The return row reads `route kind=back … pausedBy=listener decision=no
    why=listener-paused`. If the car sent its own play when it connected and 4a played,
    write fail only if no `remote … cmd=play` row came before the audio. **C**.
28. **A rendered Foray, screen off, through two line seams.** Open **Foray 4**, press
    play, and **lock the phone within 2 seconds**. Listen, locked, through at least two
    clip → narrator line → clip seams. During one narrator line, press **Next** on the car
    or headset.
    *Expected:* every seam is about half a second of silence; no line is skipped or cut
    short; after Next the next clip starts at its own beginning (A-64). In **C**: each
    seam with a line in it has a `seam … from=clip to=line` or `from=line to=clip` row
    reading `prepare=hit` and `gap` **1.0 s or less** (A-62), and no `stop` row until you
    stop. **C**.
29. **Airplane mode during a line.** Play **Foray 4** again (or carry on), and while the
    narrator is speaking a line, turn **airplane mode on**. Leave it on through the next
    seam and the next narrator line, then turn it off.
    *Expected:* the line playing finishes (its file is usually already on the phone); the
    next narrator line is read by **the phone's own voice** within about 3 seconds instead
    of silence; the clip after it plays within about 30 seconds of airplane mode going off,
    or after one press of play (write which). In **C**: a `narration kind=fallback …
    cause=offline` row (A-64; `cause=timeout` if the phone was still looking for the
    network), and any `stop` row reads `load-deadline` or `error`, never `unknown`. **C**.
30. **One hour of battery, native.** Charge above 80% and unplug. Settings → Battery →
    Battery usage: note 4a's share and the battery %. Play a long queue (several episodes
    in Up Next, or Forays one after another) for **60 minutes**, screen off, on the phone
    speaker or the headset, the same one you will use in step 31.
    *Expected:* it plays the whole hour. Write the battery % drop and 4a's share of it.
    **C** (its header must read `engine=native`).
31. **One hour of battery, the web player.** ☰ → Developer → **Playback engine** until it
    reads **Web (applies after restart)**; swipe 4a away in Recents and reopen it (the
    Copy header now reads `engine=js`). Repeat step 30 for **60 minutes** with the same
    queue, route and volume. Then set **Playback engine** back to **Automatic**, swipe 4a
    away and reopen it.
    *Expected:* write the battery % drop and 4a's share; the last Copy's header reads
    `engine=native` again. **C** after the hour, and **C** after switching back.

## When you are done

Copy `docs/field-records/android-device-pass-TEMPLATE.md` to
`docs/field-records/<date>-android-device-pass-<build>.md` (or send the filled-in text
to whoever issued the pass; they commit it). HUMAN-ACTIONS #127 is done when that file
is on `main` for a build that carries A-42.

The reviewing session, not the tester, reads the Copies. It may run
`node tools/mobile/engine-report.mjs` over them for the seam distribution, noting that
the report was written for iOS pastes and saying so if it cannot read an Android one.

## Coverage: why this is the whole A0 device check

The A-14 acceptance is "reviewed against the scenario list in §3–§4, with every
'Device check' line in A0 covered". This table is that review.

| Source (`docs/plans/android-assessment.md`) | What it asks a device to show | Step |
|---|---|---|
| §3 "4a / unknown / unknown" | `forayPolyfill === true`; real metadata, never "4a" / "Playback active" | 5, 13, 24 |
| §3 15/30 skips | 15 and 30 on the lock screen and notification | 5 |
| §3 one-button toggle | play/pause from a single headset or wheel button | 13 |
| §3 Now Playing rate 0 / progress bar | the car's progress bar advances | 13 |
| §3 stuck loading on resume | play after a long pause resumes | 14, 15 |
| §3 menu, focus ring | shared JS; seen in passing | 3, 21, 22 |
| §3 double-tap / pinch zoom | no zoom at the Largest font size | 21 |
| §3 finished-episode / stop only pauses / previous restarts (p-car-5, p-car-6, #742) | wheel previous restarts; stop only pauses; seams continue | 8, 13 |
| §3 previous past narration (player-4), restored Foray metadata (player-10) | the Foray's lock-screen metadata and wheel buttons | 9, 13 |
| §3 native-2 / native-7 / native-8 | narration-first Foray has controls; 15/30 with nothing queued; dismissed stays dismissed | 9, 5, 6 |
| §3 car play after a pause, app alive | 2 and 10 min locked pauses | 14, 15 |
| §3 car play after the app died or was swiped away | A-27 | 16 |
| §3 resume after a phone call | A-12, H-3 | 11 |
| §3 long pause, locked | the 10 min pause | 15 |
| §3 screen-off Foray seams | A-15, A-40 | 9 |
| §3 TTS narration quirks (#117 steps 2–3) | preview refused mid-line; network voice offline | 18, 20 |
| §4 Back on Home | A-07 | 7 |
| §4 headphone unplug / Bluetooth drop | A-08 | 10 |
| §4 diagnostics explain a stop | A-09: no `stop cause=unknown`; route rows | every C, 10 |
| §4 audio focus under Android 15+ | calls and Spotify, on a phone under the Android 15+ focus rule | 11, 12 |
| §4 Doze / OEM battery killers | a 10-minute locked pause (a Pixel; not an OEM killer) | 15 |
| §4 edge-to-edge at target 36 | first-launch screenshot | 2, 21 |
| §4 notification permission denied | Don't allow, controls still shown | 4 |
| §4 JS player loses its tester | the web-player lane on hardware | 23, 24 |
| A-07 device check | Back on Home, audio continues | 7 |
| A-08 device check | unplug pauses | 10 |
| A-09 device check | the Copy explains every stop | every C |
| A-10 device check | airplane-mode fallback still speaks | 19, 20 |
| A-11 device check | a screenshot on the Pixel | 2, 21 |
| A-12 device check | a call pauses and resumes; Spotify pauses 4a | 11, 12 |
| A-15 device check | a locked Foray seam, timed | 9 |
| A-27 device check (native) | car play after a swipe-away | 16 |
| A-40 device check (native) | a locked Foray with timed seams | 9 |
| A-41 device check (native) | airplane-mode narration fallback | 19 |
| `docs/android-lock-screen.md` §8.1 | reads 1–6 over `chrome://inspect`, `adb` and the lock screen | 24 |
| Delete my data (the vault) | clean relaunch, no vault or sync errors | 22 |
| A-61 device check (Track A4) | route lost and back: the rows, the car-mode resume, the Bluetooth arm off; a listener's pause stays paused; a resume from the background after a long loss (Android 12+) | 26, 27 |
| A-62 device check (Track A4) | a rendered Foray, screen off, prepared across line seams | 28 |
| A-64 device check (Track A4) | Next over a narrator line; the fallback's cause | 28, 29 |
| A-67 device check (Track A4) | every stop explained with Android's causes; airplane mode during a line; an hour of battery in each lane (DV-11) | every C, 29, 30, 31 |

The emulator twins of iOS's DV-7a and DV-7b (a play after the system ended 4a resumes it;
after a force-stop who plays is recorded) are A-67's, run in CI on both API levels
(`android-playback`, native (j)); step 16 is their device half.

Not covered, on purpose: Android Auto (A3, deferred by D-A7; step 26 records it only if the
car runs it anyway), navigation prompts and a full drive (the founder's car drive under D-A5, not approved), and OEM battery managers
(a Pixel has none of Samsung's; D-A5).
