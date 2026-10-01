# Android emulator: measurements

The running record of what the CI Android emulator has measured for the JS player lane
(`docs/plans/android-assessment.md` §5.3, Track A0). Every line here is **CI-executed**, with
its run and job ids, or is marked **not executed**. Nothing in this file was measured on a
phone. The PC this repo is written on runs no emulator and no Gradle build, so every number
comes from a GitHub Actions runner.

Cards add their own section. A-03 (can the emulator play audio at all?) wrote §1–§4. A-06
records its API 36 differences in §6, and A-05 records its seam, focus, call and kill values in §7.
A-25 (the native engine's ExoPlayer deck) records its in-point and out-point error in §8; those
numbers come from Robolectric on the same runner, not from the emulator, and §8 says what that means.
A-26, A-27 and A-30 record the native engine's leg in §9, §10 and §11. §11 has the one run with every native-mode
verdict green, and the episode seam numbers.

## 1. A-03: the answer

**Yes. The CI emulator plays audio under all three flags, and they are indistinguishable.**
A bundled clip's `<audio>.currentTime` advanced about 10 s in about 10 s of wall time.
`dumpsys media_session` reported our Media3 session `PLAYING`. `dumpsys audio` showed our
package on top of the focus stack with `AUDIOFOCUS_GAIN`. The guest's speaker mixer thread
was out of standby and had written about 10 s of frames. This held on every leg of two
attempts.

**Chosen flag: `-no-audio`, which is what `android-smoke.yml` already passes.** A-04 needs
no flag change.

Why `-no-audio` is the cheapest:
- **It costs nothing to adopt.** It is the flag the smoke job already boots with.
- **`-audio none` is the same flag.** Emulator 37.1.11 translates it to QEMU `-no-audio`
  (`argv[03] = "-no-audio"` in the `-audio none` legs' `emulator.log`, both attempts). It is
  only a longer spelling.
- **The default backend adds a failure and nothing else.** With neither flag, QEMU tries
  PulseAudio on the runner, logs ``Could not init `pa' audio driver`` (every default leg),
  and carries on. Its results matched the other two legs. It adds a dependency on the
  runner image's sound stack and gains nothing.

Why the host flag does not matter (inferred from the QEMU command line, and consistent with
the table). Every leg boots the guest with
`-soundhw virtio-snd-pci`, so Android's audioserver always has a speaker device
(`AUDIO_DEVICE_OUT_SPEAKER`, device 2). The host flag decides only whether the guest's
samples then reach a sound device on the runner, and nobody listens to those.
Everything the app and the OS can see sits inside the guest: the decoder, `AAudio`,
the AudioFlinger mixer, the focus stack and the media session. That is also where every
A-04/A-05 assertion reads.

## 2. The table

The same job ran three times per attempt: the debug APK built by the smoke job's steps, plus
one committed file, `click-cbr.mp3` (NE-25a's 90 s, 16 kHz CBR click track). It was copied
into the APK's web assets at `/a03/`, where Capacitor serves it as
`https://localhost/a03/click-cbr.mp3` (the page's CSP `media-src https:` admits it). Over
DevTools, the job created an `<audio>` element and called `play()` (`Runtime.evaluate`,
`userGesture: true`). It set `navigator.mediaSession` metadata and `playbackState =
'playing'` through the app's own polyfill, sampled `currentTime` once a second for 11 samples,
and then read `dumpsys media_session`, `dumpsys audio` and `dumpsys media.audio_flinger`
while the clip was still playing.

Run **36539778610** on throwaway PR #880 (head `198522d4`, closed unmerged). API 34
`google_apis` x86_64, emulator 37.1.11, WebView 113.0.5672.136, KVM on `ubuntu-latest`.

| Flag | Attempt / job | `currentTime` advanced (wall) | `media_session` state | Focus stack entry | Our player (`dumpsys audio`) | Mixer frames written |
|---|---|---|---|---|---|---|
| `-no-audio` | 1 / 109312165214 | **yes**: 9.933 s in 10.109 s | **PLAYING** (3) | **yes**: `pack: ai.jwlabs.foura`, `gain: GAIN`, `USAGE_MEDIA`, client `org.chromium.content.browser.AudioFocusDelegate` | `AAudio`, `state:started` | 487,424 |
| `-no-audio` | 2 / 109314016610 | **yes**: 10.016 s in 10.088 s | **PLAYING** | **yes**, same | `AAudio`, `state:started` | 491,776 |
| `-audio none` | 1 / 109312164934 | **yes**: 10.149 s in 10.355 s | **PLAYING** | **yes**, same | `AAudio`, `state:started` | 504,832 |
| `-audio none` | 2 / 109314016204 | **yes**: 9.747 s in 10.194 s | **PLAYING** | **yes**, same | `AAudio`, `state:started` | 510,272 |
| default (neither) | 1 / 109312165181 | **yes**: 9.910 s in 10.076 s | **PLAYING** | **yes**, same | `AAudio`, `state:started` | 502,656 |
| default (neither) | 2 / 109314016594 | **yes**: 10.014 s in 10.152 s | **PLAYING** | **yes**, same | `AAudio`, `state:started` | 499,392 |

How to read the columns:
- **`currentTime` advanced** is the last sample minus the first, over the same interval's wall
  clock. Every sample had `paused: false`, `readyState: 4`, `error: null`, and
  `duration: 90.072`.
- **`media_session` state** is the `PlaybackState` of `ai.jwlabs.foura/androidx.media3.session.id.foray`,
  which is our Media3 session over `WebViewPlayer`, with `metadata: description=A-03 spike, 4a CI`
  taken from the page's payload. In every leg, `dumpsys media_session` also named it
  **the media button session**. The idle dump taken before `play()` held no session of ours.
- **Focus stack entry**: before `play()`, the stack was empty on every leg. During play, it
  held exactly one entry, ours.
- **Mixer frames written** is the `AudioOut_D` thread (48 kHz, `AUDIO_DEVICE_OUT_SPEAKER`),
  which reported `Standby: no` on every leg. About 490k–510k frames is about 10.2–10.6 s at
  48 kHz, which matches the play time. The guest really rendered the clip, and the element
  did not just advance its own clock.
- The foreground service was up on every leg: `PlaybackKeepAliveService`,
  `isForeground=true`, `types=00000002` (mediaPlayback), notification channel
  `foray-playback`, category `transport`.

Raw evidence is in the run's artifacts `a03-audio-spike-<flag>` (30-day retention): idle and
playing `dumpsys` outputs, `emulator.log`, `logcat.txt` and `audio-spike.json`. The run holds
one artifact per flag, and it is **attempt 2's**: the re-run replaced attempt 1's uploads. Attempt
1's numbers survive in its job logs (the step that prints `audio-spike.json`), under the attempt-1
job ids above.

## 3. What this settles beyond the flag

- **WebView requests audio focus for a plain `<audio>` element.** Chromium's
  `AudioFocusDelegate` takes `AUDIOFOCUS_GAIN` with `USAGE_MEDIA` for the app's uid as soon
  as the element plays. The assessment's §2 row "Whether WebView requests focus for
  `<audio>` is unestablished" is now answered, **on WebView 113 in an emulator**. A current
  WebView on a Pixel may differ; A-05 (h) and the device pass (after A-42) confirm it there.
  The open question is what happens when *another* app takes focus. That is A-05 (h) and (i).
- **The foreground-only path works end to end in CI.** In one pass with the screen on, the
  shell started the mediaPlayback service, the polyfill fed Media3, and
  Media3 published PLAYING with our metadata. A-04 (a) can assert all of that. None of it
  says anything about the screen off, which is A-04 (b).

## 4. What A-03 did not measure

- **Nothing backgrounded.** The app was in the foreground with the screen on for all 10
  seconds. A-04 (b) covers Home plus sleep, and A-05 covers Doze, calls and kills.
- **Nothing audible.** No leg sent samples to a host device a human could hear, and no
  test needs one. Audible quality is for the device pass.
- **`media_session` PLAYING is not evidence of audio.** The page set `playbackState = 'playing'`
  itself, and the polyfill forwards that to Media3 whether or not a sample was rendered. The
  column shows that the session plumbing works under each flag. The evidence that the clip
  actually played is the `currentTime` and mixer-frames columns. A-04 must not assert
  "audio plays" from the media session alone.
- **The app's own player.** The clip was played by a bare `<audio>` element created in the
  page, not by `queue-manager.js`. The system-side facts above should not depend on which
  code calls `play()`, but that is not measured here. A-04 plays through the real player.
- **One noisy field, recorded so nobody chases it.** In two of the six legs, `-no-audio`
  attempt 1 and `-audio none` attempt 2 (so not tied to a flag), `dumpsys audio` printed
  our player's `FormatInfo` as `channelMask=0x0, sampleRate=0`. The other four printed
  `0x1, 16000`. The player was `state:started` either way, and the
  mixer was writing either way. It looks like the format being filled in lazily after the
  stream starts, not an audio difference.

The spike's code (a matrix workflow and a DevTools script) lives only on throwaway PR #880
(head `198522d4`: `.github/workflows/android-audio-spike.yml` and
`.github/a03-spike/emulator-audio-spike.mjs`). The PR was closed unmerged and its branch
deleted, and the PR still holds the commit. It was never merged because A-04 builds the real
scenario runner by extending `tools/mobile/webview-probe.mjs`.

## 5. A-04: the playback scenarios, part 1

`.github/workflows/android-playback.yml` runs `tools/mobile/android-playback.mjs` on the smoke's
boot. It plays a three-clip Foray made of the NE-25a click tracks, bundled into the debug APK at
`a04/`, through `ForayPlayer.playForay`, and then works through scenarios (a)–(e). Everything in
this section is **CI-executed**. The green run is **36551857323** on PR #885 (head `105e8995`),
with the same image and WebView as §2. The job took **8 min 08 s**, against the card's 12-minute
budget.

| Scenario | Verdict | Measured |
|---|---|---|
| (e) first launch | pass | The screenshot is 1080×2400. The page reads every `env(safe-area-inset-*)` as `0px`, with `innerHeight` 891 against a `screen.height` of 915 (CSS px). Read at the time as "laid out inside the system bars". **Corrected by A-06 (§6):** the screenshot shows the header drawn under the status bar. |
| (a) play | pass | `currentTime` advanced 5.02 s in 5.02 s. `PlaybackKeepAliveService` showed `isForeground=true types=00000002` (the mediaPlayback bit). Our session was the media button session, `PLAYING`, `description=A-04 click one, 4a CI fixtures`, which matches the payload. `forayPolyfill` was `true`. |
| (b) Home, then sleep | pass | `mWakefulness=Asleep`. The Foray clock advanced 60.02 s in 60.02 s of wall time, and the pid was unchanged. |
| (c) transport | pass, with **A04-F1** expected-fail | Every press arrived as a handled `foray:remote` row. With the app on screen, pause then play resumed at once. In the background, see A04-F1. |
| (d) shade | pass, with **A04-F2** expected-fail | The shade showed our title and show. A tap on its pause button paused the page (a handled `pause` row). The shade had no 15/30 buttons (A04-F2). |

**Mutation (the card's acceptance).** Throwaway PR #886 removed
`ContextCompat.startForegroundService` from `ForayAudioPlugin.start`. Run **36551980831** turned
(a) red with two failures: "no PlaybackKeepAliveService in dumpsys activity services" and
"dumpsys media_session lists no session for ai.jwlabs.foura". The PR was closed unmerged and the
branch deleted. On the same run, **(b) still passed**: with no foreground service, an emulator
kept a backgrounded, screen-off WebView playing for 60 s. So (b) is evidence that playback
survives Home plus sleep on an emulator. It is not evidence that the service is what keeps it
alive. Doze and the standby buckets (A-05 (g)) are where the service has to matter.

### Two product defects this job found

These are reported by the runner's `KNOWN_FAILURES` as expected-fail. Each one excuses exactly one
failure sentence and nothing else in its scenario, and the fix for each should be its own card.

- **A04-F1: with the app in the background, a remote play or previous never plays.**
  - The failing sequence: the app is on the Home screen with the screen on. A pause from
    `cmd media_session dispatch` or `KEYCODE_MEDIA_PAUSE` works. The play that follows reaches
    the page (handled `play` row, `transport play from remote` in the diagnostics record), but
    the element falls to `readyState` 1 and the queue manager sits in `loadingItem`. There is no
    audio-focus request and no audio.
  - A `previous` that restarts the clip ends the same way. The clock moves back, then silence.
  - What still works: a `next`, which loads a different file, plays at once. The same pause then
    play with the app on screen also resumes at once (the foreground control, gated).
  - Reproduced on runs 36549143331, 36550714726 and 36551857323.
  - Impact: on this emulator, a lock screen, a headset or a car cannot resume the JS player once
    it is paused in the background. That is the Android form of founder report F5.
  - Not established: whether a current WebView on a phone does the same. This is WebView 113, and
    Chromium suspends a paused player's pipeline in a hidden page. The device pass after A-42 is
    where that gets settled.
- **A04-F2: the system media controls show no ↺15 / 30↻.**
  - Our Media3 session publishes `custom actions=[]` for a Foray and for a single episode alike
    (`dumpsys media_session`, every run).
  - So on API 33+ the shade and lock screen draw play/pause and previous track, and nothing else
    (screenshot `d-shade-expand-settings.png` and the dump committed at
    `tools/mobile/fixtures/android-playback/run36551857323-shade-expand-settings-paused.xml`).
  - The media button preferences set in `PlaybackKeepAliveService` (audit round 2, native-7)
    never reach the platform session.
  - A likely cause, not verified: Media3 grants those buttons to its media-notification
    controller, and a service that is not a `MediaSessionService` has no such controller.

### What the first runs taught the job

- **Play services restarts itself about 55–65 s after a cold boot.**
  - `com.google.android.gms.persistent` "has died" with no crash, to apply new flags.
  - ActivityManager then kills every process holding one of its providers. The WebView holds the
    FontsProvider, so on run 36547348476 the app died 30 s into (b):
    `Killing …:ai.jwlabs.foura (adj 200): depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent`.
  - The job now waits for that restart before installing (62–70 s measured). (b) also reports
    ActivityManager's own kill line if the app dies.
  - The kill is also a real-phone risk: a foreground service does not protect an app from its
    provider's process dying, for example on a Play services update. Worth a line in A-05's
    process-kill work.
- **`uiautomator dump` cannot read a playing media panel.** It fails with "could not get idle
  state" every time, because the progress bar animates. (d) therefore reads the panel paused,
  resumes, and taps the same place, where pause now is.
- **The card's `adb reverse` is not reachable from this page.**
  - The CSP allows only `media-src https:`.
  - The WebView refuses cleartext at targetSdk 36.
  - `https://localhost` is Capacitor's own origin.
  - So the click tracks ship inside the CI-built debug APK, the way A-03 did it. No shipped bundle
    carries them.

## 6. A-06: the API 36 leg, and how it differs from API 34

`android-playback.yml` is now a two-leg matrix on the same boot, the same debug APK and the same runner
class. **API 34** is the fast leg: the smoke's image, with a 30-minute ceiling. **API 36** is
`system-images;android-36;google_apis;x86_64`, the platform the app targets, with a 45-minute ceiling.
Each leg checks that its device reports its own API level before installing, records its WebView
version, and uploads its own artifact (`foray-android-playback-api34` / `-api36`). Everything in this
section is **CI-executed**. The run is **36559231419** on PR #887 (head `c4de3fb3`), and **both legs
were green on that one run**: API 34 job 109375789832, API 36 job 109375789606.

MP1 §6.2's worry did not hold on a KVM runner: the cold API 36 image booted in 57 s.

### The legs side by side

| | API 34 | API 36 |
|---|---|---|
| Android release / WebView | 14 / 113.0.5672.136 | 16 / 133.0.6943.137 |
| Job wall time | 8 min 14 s | 9 min 34 s |
| Boot (`sys.boot_completed`) | 41 s | 57 s |
| Play services first-boot restart wait | restarted after 66 s (71 s step) | **did not restart** within the 120 s bound (warning, not a failure) |
| (e) `env(safe-area-inset-*)` | all `0px` | all `0px` |
| (e) `innerHeight` / `screen.height` (CSS px) | 891 / 915 | **842** / 915 |
| (e) the screenshot | **The page's header is drawn under the status bar.** The clock and the signal icons sit on top of the ☰ button and the refresh button. | **No overlap.** The page sits between an opaque light status bar and an opaque light navigation bar. |
| (a) `currentTime` advanced | 5.025 s in 5.025 s | 5.006 s in 5.006 s |
| (a) foreground service | `isForeground=true`, `types=0x2` | same |
| (a) media button session | `ai.jwlabs.foura/androidx.media3.session.id.foray` | same, with a `/6` suffix (the parser takes either) |
| (a) our session | `PLAYING`, `custom actions=[]` | same |
| (b) screen off, Foray clock | `Asleep`, 60.03 s in 60.03 s, same pid | `Asleep`, 60.02 s in 60.02 s, same pid |
| (c) foreground control (pause, play) | pass | pass |
| (c) background presses | pause and next pass. **A04-F1** on play and previous (element at `readyState` 1, queue `loading`) | **identical**: pause and next pass, A04-F1 on the same four presses |
| (d) shade | title and show present, **A04-F2** (no 15/30). A playing panel cannot be dumped ("could not get idle state"), so the paused fallback ran. | identical |
| Audio focus | 11 `requestAudioFocus()` lines from Chromium's `AudioFocusDelegate`, none refused. Our package is on top of the stack at the end with `GAIN`. | same: 11 requests, none refused. The app targets 36, so this is the Android 15+ rule in force. |

### What the API 36 leg settles

- **The Android 15+ audio-focus rule does not refuse us here.** On API 36 the WebView's focus
  requests were all granted. That includes the ones made with the app hidden after Home in (c): the
  `next` presses at 11:09:32 and 11:10:02 each abandoned and re-requested focus, and the new clip
  played. No refusal was logged. The `mediaPlayback` service is up whenever the page plays, which is the
  exemption the rule allows. This is on an emulator, with no competing app. Focus *loss* (a call,
  another player) is A-05 (h)/(i).
- **A04-F1 is not an old-WebView artefact.** A-04 established it only on WebView 113. It reproduces
  exactly on WebView 133 / Android 16, so its fix card should not wait for a phone to confirm it.
  It is not the focus rule either. The failing background `play` (11:09:20.8 on API 36) produced no
  `requestAudioFocus()` at all, so nothing was refused. The element never got as far as asking.
- **A04-F2 is the same on both.** The session publishes `custom actions=[]` on both platforms.

### Edge to edge: a correction to §5, and what triggers A-11

§5's (e) row read `innerHeight` 891 against 915 as "laid out inside the system bars, not edge to
edge" on API 34. **The screenshots say otherwise.** On API 34 the WebView is drawn *under the status
bar*, and the missing 24 CSS px is the navigation bar at the bottom. The status bar's clock and
icons are drawn over the page's header: the ☰ and refresh buttons. The page cannot pad for this,
because `env(safe-area-inset-top)` reads `0px`. The same overlap is in A-04's own run: `first-launch.png`
in run 36551857323's artifact.

On API 36 the WebView is inset from both bars (842 = 915 − 49 status − 24 navigation). The insets
correctly read `0px` there, because nothing overlaps. The bars are opaque and light above and below
a dark app. That is a cosmetic mismatch, not an overlap.

So **A-11 is triggered, by the API 34 screenshot, not by API 36's.** A-11's acceptance ("API 36
screenshot with no overlap") already holds. The fix it needs is for Android 14 and below, where
the status bar is transparent over the WebView. A-11 should add "API 34 screenshot with no overlap"
to its acceptance, and consider the light bars on 36 at the same time. Both `first-launch.png` files
are in run 36559231419's artifacts.

### What neither leg proves

The same as §5: nothing audible, no OEM battery manager, and no current phone's WebView (the API 36
image ships 133). Doze, the standby bucket, audio focus and a call came with A-05 (§7), forced or
simulated on both legs. The device pass after A-42 settles the rest.

## 7. A-05: the playback scenarios, part 2

A-05 adds seven scenarios to the same job, (f) to (l), one step each. The card's rule is to
record first and gate only where it says so:
- **Gated:** (g) Doze, (k) the airplane-mode narration fallback, and (l) Back on Home. A-07 is
  merged (PR #874), so (l) is gated rather than expected-fail.
- **Recorded:** (f) hidden seams, (h) audio focus, (i) a phone call and (j) a process kill. Each
  of these fails only when there was nothing to record: the screen stayed on, the helper app got no
  focus, the call never rang, or the force-stop control did not hold.

Everything in this section is **CI-executed**, on the same image and WebView as §2 and §5. Two
runs on PR #888:
- Run **36562447644** (head `43ffaac2`) took 19 min 02 s for the whole job, A-04's scenarios
  included.
- Run **36565163853** (head `d3aafcfd`, job 109395193688) took 19 min 02 s. It adds the interlude
  split in (f), the out-point clock in (k) and the bucket samples in (g).

All twelve scenarios were green on both runs. Those runs predate A-06's matrix (§6), so they are
API 34 only. Since the merge of #887, (f) to (l) run on both legs: see "On both legs, and the
ceilings" below.

The fixtures:
- **Rendered narration.** Three `.m4a` lines of 5, 6 and 7 s, made in the job by ffmpeg at
  `tools/narration/render-profile.json`'s encode: AAC, 64 kbps, mono, 24 kHz, faststart
  (`a05-narration-ffprobe.txt`). They are bundled at `a05/` beside A-04's click tracks, and no
  audio is committed.
- **Clips.** The NE-25a click tracks, as in §5.
- **The "other app" in (h).** `tools/mobile/a05-focus-helper/`, built in the job with javac, d8
  and aapt2 from the SDK the job already installs.

### On both legs, and the ceilings

A-06 gave each leg its own `timeout-minutes`: 30 for API 34 and 45 for API 36. The question after
the merge was whether A-05's longer scenario set still fits, above all on the slower API 36 leg.

What the measurements before the merge say:
- **API 34 with A-05, one leg:** 19 min 54 s on run **36573733303** (PR #888). (f) to (l) took
  10 min 12 s of that, 5 min 08 s of it (g)'s Doze. The two A-05 build steps (the narration
  fixtures and the focus helper) took 26 s.
- **API 36 against API 34, A-04's scenarios only:** 9 min 35 s against 7 min 09 s on run
  **36570855587** (PR #887). The whole difference is before the first scenario: the SDK install
  (+16 s), the build (+19 s), the boot (52 s against 31 s) and the Play services wait (122 s
  against 39 s). Scenarios (e) to (d) took 3 min 34 s on API 36 and 3 min 32 s on API 34.

So the API 36 leg was expected at about 22 min 30 s: API 34's 19 min 54 s plus about 2 min 30 s
of setup.

What the first two-leg run measured: run **36579295565** on PR #888 (the merge, head `f7d658a1`).
All twelve scenarios were green on both legs.

| | API 34 (job 109442936065) | API 36 (job 109442936168) |
|---|---|---|
| Job wall time | **19 min 29 s** of 30 | **20 min 36 s** of 45 |
| Before the first scenario | 5 min 31 s | 6 min 44 s |
| SDK install / boot / Play services wait | 50 s / 46 s / 67 s | 85 s / 57 s / 120 s (did not restart) |
| Scenarios (e) to (l) | 13 min 49 s | 13 min 46 s |
| (g) Doze step | 5 min 08 s | 5 min 07 s |
| (f) p95 seam gap / p95 silence | 3,374 ms / 85 ms | 3,342 ms / 42 ms |

The API 36 leg came in under the projection. Its whole extra 1 min 07 s is setup, and its
scenarios ran as fast as API 34's. D-A4's line holds on both legs.

**Neither ceiling moved.** Each is a ceiling for a hung boot or a hung scenario, not a budget:
- A hung boot fails the boot step's own 15-minute deadline at about 19 minutes on either leg
  (about 4 minutes of setup first), which is inside both ceilings.
- A normal run fills about two-thirds of API 34's 30 (19 min 29 s) and under half of API 36's
  45 (20 min 36 s).

Raising either would only let a hung run cost more.

### (f) Hidden seams, recorded

The Foray runs clip, line, clip, line, clip, line, clip. Each clip is 22 s, over the 20 s floor
of the narration warm (PR #867). It plays to its end with the app on Home and the screen off
(`mWakefulness=Asleep`, all six seams `hiddenAtBoundary`). The gaps are the diagnostics ring's
own `observedGapMs`: the time from the boundary (an out-point, or a line's `ended`) to the next
`playing`.

| Seam | Run 36562447644 gap | Run 36565163853 gap | Of which interlude jingle | Silence |
|---|---|---|---|---|
| clip 1 → line 1 | 35 ms | 25 ms | none | 25 ms |
| line 1 → clip 2 | 3,366 ms | 3,129 ms | 3,097 ms | 32 ms |
| clip 2 → line 2 | 36 ms | 33 ms | none | 33 ms |
| line 2 → clip 3 | 3,345 ms | 3,119 ms | 3,097 ms | 22 ms |
| clip 3 → line 3 | 33 ms | 52 ms | none | 52 ms |
| line 3 → clip 4 | 3,350 ms | 3,110 ms | 3,080 ms | 30 ms |
| **p50 / p95** | 36 / 3,366 ms | 52 / 3,129 ms | | **30 / 52 ms** |

The jingle and silence columns are run 36565163853's. The first run had no element log, so its
jingle cannot be separated.

**D-A4: A-15 is not triggered.** The emulator's p95 hidden seam is 3.1–3.4 s even when the whole
gap is counted, and 52 ms of silence. Both are under the 4 s line. None of the six seams failed to
become audible, and none came near the 20 s hidden deadline.

**Every seam into a clip is the interlude jingle, not dead air.**
- Advancing into a clip from anything but the same episode plays the 3.0 s interlude jingle
  (`queue-manager.js` §13, on by default). The seam lasts as long as the jingle does: the ring
  shows a `seam.gap.hold` of about 4.47 s, which is the jingle's ceiling.
- The ring does not record whether a jingle played. So the runner logs every element's `playing`
  and `ended` and takes the jingle's span out of the gap. `seamStats` reports both numbers, and the
  A-15 line is decided on the silence.
- The reason for deciding on the silence: A-15's own acceptance, "p50 ≤ 2 s", could never be met
  by a number that includes a 3 s jingle on every seam into a clip. The gap is printed beside the
  silence, so the orchestrator can decide on it instead.

**What this does not settle.** The files are served from the APK (`https://localhost`), so a load
costs no network time. What (f) measures is the WebView's own hidden-page timing: every file
started within about 50 ms of its boundary with the screen off, which is far from the 9–11 s
hidden-page loads MP1 §4.1a measured. The network cost of a CDN line or episode belongs to the
device pass. The jingle itself is
fetched from `jw-incorporated.github.io`, over the network, on every run.

**Two gaps in the diagnostics ring, found here:**
- A seam opened by a rendered line's `ended` has no `fromId`, `toId` or deadline. Nothing the ring
  keeps names either side. A likely cause, not verified: the element's `ended` reaches the ring
  after the clip's load has already announced its deadline, while no seam was open.
- The ring never records that the interlude jingle played.

On a phone, a founder's paste therefore shows a line → clip seam as a bare "gap 3,1xx ms" with no
ids. This is worth a small diagnostics card.

### (g) Doze, gated

The sequence is `dumpsys battery unplug`, Home, sleep, `dumpsys deviceidle force-idle` ("Now forced
in to deep idle mode"), then `am set-standby-bucket ai.jwlabs.foura rare`. The deep state read
`IDLE` at the start and at every 20 s sample, on both runs.

| Run | Foray clock | Wall clock | pid | Service after |
|---|---|---|---|---|
| 36562447644 | 288.3 s | 300.0 s | unchanged | foreground, mediaPlayback |
| 36565163853 | 288.6 s | 300.0 s | unchanged | foreground, mediaPlayback |

The clock is short of the wall by the Foray's own seams (the jingle at each clip change).

**The rare bucket does not hold while a Foray plays.** On run 36565163853 the bucket read back 40
(rare) at 20, 40 and 60 s. It read 10 (ACTIVE) from the 80 s sample to the end, and the first
clip change came at about 84 s. Run 36562447644 also ended at 10. The system promotes the app out
of rare on its own, most likely because of the media notification update at a clip change. That
promotion is not verified.

So (g) proves:
- five minutes of forced deep Doze;
- the first minute or so of that in the rare bucket.

It does not prove five minutes in rare. That is Android's behaviour and not something the job
should fight, but a follow-up gate should not claim more.

### (h) Audio focus, recorded

This settles the `docs/android-native-code.md` §6.2 question on the emulator. While we play, the
focus stack holds one entry:
`pack: ai.jwlabs.foura`, client `…org.chromium.content.browser.AudioFocusDelegate`,
`gain: GAIN`, `USAGE_MEDIA`. WebView requests and holds `AUDIOFOCUS_GAIN` for the page's
`<audio>`, as A-03 found with a bare element. The same result held on both runs.

| Helper asks for | Our stack entry while held | Our audio while held | After the helper abandons |
|---|---|---|---|
| `AUDIOFOCUS_GAIN_TRANSIENT` | `GAIN/LOSS_TRANSIENT`, helper on top | **paused** (0 s over 4 s; page `running: false`) | **resumed**: our entry back on top with `GAIN`, and 4.0 s over 4 s |
| `AUDIOFOCUS_GAIN` | removed from the stack | **paused** (0 s over 4 s) | **not resumed**, and the stack is empty. This is Android's rule: a permanent loss is not given back. |

The helper's own log reads `mode=transient result=1`, `mode=gain result=1` and
`mode=abandon result=1` (tag `A05Focus`). Our app was in the background (the helper's activity on
top) throughout.

### (i) A phone call, recorded

The app is on Home and playing. The sequence is `adb emu gsm call 5550105`, then `accept`, then
`cancel`, and each answered `OK`. The same result held on both runs.

| Phase | `mCallState` | Focus stack top | Our entry | Our audio |
|---|---|---|---|---|
| before | IDLE | ai.jwlabs.foura | `GAIN/none` | playing (4.0 s over 4 s) |
| ringing | RINGING | com.android.server.telecom | `GAIN/LOSS_TRANSIENT` | **paused** (0 s) |
| in call | OFFHOOK | com.android.server.telecom | `GAIN/LOSS_TRANSIENT` | **paused** (0 s) |
| 3 s after hang-up | IDLE | ai.jwlabs.foura | `GAIN/none` | **resumed** (4.0 s over 4 s) |
| +10 s | IDLE | ai.jwlabs.foura | `GAIN/none` | still playing |

**A-12 is not triggered by the emulator.** A-12's condition is (h)/(i) "showing that we play over
a call or over another app". We do neither:
- WebView's own focus handling pauses on every loss;
- it resumes on a transient regain, with the app in the background.

That background resume works, unlike A04-F1's remote play: a focus regain resumes the paused
element in place.

**What is left for the device pass:**
- a real call;
- Spotify, which takes focus and also plays;
- a current WebView, where A-06's API 36 leg is the emulator half.

### (j) Process kill, recorded

Each leg starts from a paused Foray with the app on Home. Our Media3 session holds the media
button (`Media button session is ai.jwlabs.foura/androidx.media3.session.id.foray`). Then the
process is ended, and `cmd media_session dispatch play` is pressed.

| Leg | Did the process die? | Media button session after | Who got the play |
|---|---|---|---|
| `am kill ai.jwlabs.foura` | **no**: same pid on both runs. `am kill` only kills a process the system considers cached, and the paused Foray keeps the `mediaPlayback` service up. | ours, `PAUSED` | **us**, and it did not play: a handled `play` row reached the page, which sat `loading` at `readyState` 1. That is A04-F1, reproduced by a third route. |
| SIGKILL from the app's uid (`run-as … kill -9`), what the low-memory killer does | **yes**: "Process ai.jwlabs.foura (pid …) has died: fg +50 FGS". No restart. | `null` ("Media button session is changed to null") | **nobody**: `Last MediaButtonReceiver: null`, no session playing, and our process did not come back |
| `am force-stop` (the negative control) | yes | `null` | nobody, and our process stayed gone (gated) |

On this image, then, a play after 4a's process dies goes nowhere. No other app is started, even
though YouTube and YouTube Music have media sessions with receivers. Two consequences:
- "The car hands play to Spotify" needs a phone where another app was the last receiver. That is
  the device pass.
- Nothing brought 4a back after a death. No media button receiver of ours was on record, so a
  media key cannot restart the app. Restarting it is A-27's job in native mode.

The SIGKILL leg is an addition to the card, because `am kill` could not end the process.

### (k) Airplane mode narration fallback, gated

The sequence is `cmd connectivity airplane-mode enable` (`airplane_mode_on=1`), with the app on
screen. The Foray is a 6 s clip, then a rendered line at
`https://audio.jwlabs.ai/n/a05-ci/unreachable.m4a`, then a clip.

| Run | File failed | Spoken after the clip's out-point | Next clip playing after the speech started |
|---|---|---|---|
| 36562447644 | `narration` row: `reason=unsupported at=bridge host=audio.jwlabs.ai` | about 6 ms after the fallback row. That run timed the deadline from a poll, fixed on the next. | 7.2 s |
| 36565163853 | the same row, 39 ms after the out-point | **42 ms** (`ForayTts.speak`, answered ok) | 6.9 s |

The gate is 15 s: the visible load deadline of 10 s, plus 5 s. Offline, WebView fails the load at
once, with `MEDIA_ERR_SRC_NOT_SUPPORTED`, which reads as `unsupported`. It does not wait out the
deadline. The engine that spoke is `com.google.android.tts`.

### (l) Back on Home while playing, gated

On both runs, the first Back was consumed inside the app, and the second moved the focused window
to the launcher. After that:
- the pid was unchanged;
- the clock advanced 4.0 s over 4 s (3.98 s on the second run);
- `PlaybackKeepAliveService` was still a foreground service with the mediaPlayback type;
- the page read `visibility: hidden`.

A-07's acceptance holds: Back minimizes while something is loaded.

### What a follow-up PR can turn into gates

Each of these has a clear pass line and held on both runs:
- **(h) transient focus.** Paused while held, and resumed after the abandon.
- **(h) permanent focus.** Paused, with our entry removed from the stack.
- **(i) the call.** Paused while ringing and in the call, and resumed within 3 s of hang-up.
- **(f) silence.** p95 at or under 4 s (D-A4's line), with no never-audible seam.
- **(j) a SIGKILL.** It leaves the media button with nobody.

Only the force-stop control is gated today.

## 8. A-25: the ExoPlayer deck's in-point and out-point (Robolectric, not the emulator)

**Run:** `android-build` run 36633382530, job 109627870662 (`android-shell`), head `e05fb324`,
PR #898. The raw trials are the run's `android-shell-evidence` artefact,
`a25-deck-measurements.json`; `ExoDeckMeasurementTest` writes it.

**What was measured, and what was not.** `ExoDeck` (`mobile/plugins/foray-audio/android/.../engine/`)
drove a media3-test-utils player: `TestExoPlayerBuilder` on an auto-advancing `FakeClock`, with a
renderer that consumes samples by timestamp and keeps their bytes. The clips were the NE-25a click
tracks, read in place from the iOS fixtures. The iOS in-points, out-point, lead-in and rates were
used (docs/ios-native-engine-measurements.md), so the two platforms can be compared.

The numbers are therefore Media3 1.11.0's own logic: the extractors and their seek maps, the
playback loop's 10 ms work cadence, positioned-message delivery, and the deck's timers. They are
in VIRTUAL time, over a local file. They are not a device's audio latency and not a CDN's. The
emulator's native leg (A-26, A-30) and the device pass after A-42 measure those.

**How an in-point is judged.** Media3 labels every sample with a media time; after a seek, that
label comes from the file's seek map. The first sample the listener hears is located IN THE FILE by
its bytes: an MP3 sample is one frame, and a WAV sample is a run of PCM. A 12 s heard window
always holds a double click, so the match is unique for MP3 and nearest-the-label for WAV. So:
- `err` = where the first heard sample really is, minus the request;
- `offset` = its real place minus Media3's label (the seek map's error);
- `late` = the label minus the request (whole-sample quantization).

### In-points (ms; negative = the listener hears content from BEFORE the in-point)

| Fixture | Request (s) | approximate: err / offset / late | precise: err / offset / late |
|---|---|---|---|
| click-cbr.mp3 (no header) | 9.65 | +34 / 0 / 34 | +34 / 0 / 34 |
| | 19.65 | +6 / 0 / 6 | +6 / 0 / 6 |
| | 49.65 | +30 / 0 / 30 | +30 / 0 / 30 |
| click-vbr-xing.mp3 (Xing TOC) | 9.65 | −578 / −629 / 51 | −578 / −629 / 51 |
| | 19.65 | −390 / −404 / 14 | −390 / −404 / 14 |
| | 49.65 | −186 / −196 / 10 | −186 / −196 / 10 |
| click-vbr-notoc.mp3 (no table) | 9.65 | +34 / 0 / 34 | −3566 / −3636 / 70 |
| | 19.65 | −7662 / −7668 / 6 | −7662 / −7668 / 6 |
| | 49.65 | −19986 / −20016 / 30 | −19986 / −20016 / 30 |
| click.wav (PCM) | 9.65 | 0 / 0 / 0 | 0 / 0 / 0 |
| | 19.65 | 0 / 0 / 0 | 0 / 0 / 0 |

What this settles:
- **An exact seek map is exact, then late by less than one sample.** On constant-bitrate MP3 and
  PCM WAV the label is the truth (offset 0 in every trial). Media3 drops the whole sample the
  request falls inside, because every audio sample is a sync sample. The listener therefore starts
  0 to 1 sample late: up to 36 ms for a 16 kHz MP3 frame (26 ms at 44.1 kHz). This is asserted
  (never early, at most one sample). iOS measured 0 to −4.9 ms on the same files (§7.3 of
  docs/ios-native-engine-measurements.md): AVFoundation lands within a few samples, Media3 on the
  next whole frame.
- **A VBR seek table is early by up to about 0.6 s.** The Xing TOC's 100 points put the landing
  186 to 629 ms BEFORE the request. The listener hears the tail of the previous content. iOS's
  approximate seek on the same file was −221 ms at 49.65 s; its precise seek was within 7 ms.
- **A VBR file with no table is wrong by seconds.** The constant-bitrate estimate from the first
  frame put the landing 7.7 s early at 19.65 s and 20 s early at 49.65 s.
- **`preciseTiming` changes nothing here.** In Media3 1.11, `Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING`
  is a fallback for an unseekable map, not an override (the bytecode shows it). It never applies to
  these files, so both columns match wherever the seek map was used.
- **Near the start, the result depends on the race.** At 9.65 s the landing sometimes falls inside
  what the loader has already read from byte 0: exact labels, `+34`. Sometimes it goes through the
  seek map: `−3566` on the no-table file. Which one happens depends on real I/O against virtual
  time, and three runs saw both outcomes on both VBR files. On a phone over a network, the seek map
  is the usual path.

For A-40 (Foray in-points, bounded segments): on Android, a VBR source's in-point is not trustworthy
from Media3's seek map. Before a Foray segment on a VBR MP3 can be cut on Android, A-40 needs an
index of its own (read to the in-point, or a server-side frame index), or a rendered clip. iOS got
this from `AVURLAssetPreferPreciseDurationAndTimingKey`. The episode path (`preciseTiming` false)
has the same errors for a resume position on a VBR podcast. That is within the core's resume rewind
for the Xing case. It is not within it for a no-table file, and NE-38's field rows should count how
many feeds that is.

### Out-points (55.005 s, 4 s lead-in, played to the stop; ms)

| Layers armed | Rate | Stopped by | Overshoot (row) | Position at the stop | Settled after 0.5 s | Early reports |
|---|---|---|---|---|---|---|
| boundary | 1x, 2x | boundary | 0 | +0 | +0 | 0 |
| watchdog | 1x | watchdog | 0 | +0 | +2 | 0 |
| watchdog | 2x | watchdog | 0 | +0 | +4 | 0 |
| boundary + watchdog | 1x, 2x | boundary | 0 | +0 | +0 | 0 |

The table is identical for all four fixtures, because an out-point is a position, not a seek. That
makes 24 trials, and none of them was early. **Never early is asserted.**

The boundary layer (a `PlayerMessage` at the out-point, rounded up to the millisecond) fires in
the playback loop at the boundary itself. The watchdog alone reads the boundary on the app thread
and pauses one work-loop tick later: +2 ms of content at 1x, +4 ms at 2x. `endTime`, the third iOS
layer, has no Media3 counterpart on a live source, so the deck runs its ops as no-ops (ExoDeck's
header says why).

Compared with iOS (§7.5 of docs/ios-native-engine-measurements.md): the boundary layer matches
AVFoundation's boundary observer, which fired 0.1 to 0.6 ms past the boundary and settled 0.8 to
2.9 ms past it. The watchdog does not compare. On iOS its poll ran on a real clock and overshot by
14 to 236 ms. Here the virtual clock fires every timer exactly on time, so the watchdog's real
overshoot, its timer jitter, is not measured on Android until the emulator leg runs it.


## 9. A-26: the native engine's leg of `android-playback`

**Run:** `android-playback` run 36647752638, job 109674560375, `android-playback (API 34, native engine)`, PR #900.
The leg took 14 min 7 s, against 20 min 1 s and 19 min 4 s for the two JS legs in the same run. The evidence is the
run's `foray-android-playback-api34-native` artefact: the `verdict-native-*.json` files, `native-engine-dump.txt`
(the service's own dump, with the engine's last rows) and `logcat-ForayEngine.txt`.

**What drove what.** `ForayPlaybackService` hosted the engine: the A-24 core, the A-25 `ExoDeck` and the
`EnginePlayer` session facade. The DEBUG build's `EngineDriveReceiver` handed it a queue of the click tracks, as
`asset:///public/a04/…`, and a TAP play over `adb shell am broadcast`. Everything after that was the system acting
on the engine's Media3 session: media keys, the shade, the focus helper, the modem and Doze. The runner is
`tools/mobile/android-native-playback.mjs`, and it reads the engine from `dumpsys activity service …/ForayPlaybackService`.

Every scenario is **gated** in native mode (the card).

| Scenario | Result | Measured |
|---|---|---|
| (a) play | pass | The playhead moved 5.00 s in 5 s. `ForayPlaybackService` was a foreground service with `types=2` (mediaPlayback). Our session was PLAYING, described as `A-04 click one, 4a CI fixtures`. The legacy service was not running. |
| (b) Home, then screen off | pass | 60.13 s of the queue in about 60 s, `mWakefulness=Asleep`, same pid (5334). |
| (c) presses | pass, 10 of 10 | A foreground control (pause, then play) and, with the app on Home, `cmd media_session dispatch` and `KEYCODE_MEDIA_*`, each of pause, play, next and previous. Next moved to the next item. Previous restarted the item, and the deck was ready again in 53–63 ms (same-source reuse). |
| (d) system controls | pass | Title `A-04 single episode`, show `4a CI fixtures`, **Back 15 seconds** and **Forward 30 seconds**. The platform session's custom actions carried both, which is A04-F2's gap closed for this lane. A tap on the shade's pause paused the engine. |
| (g) Doze | pass | 299.05 s of the queue in 300 s: deep IDLE, bucket 40 (rare), screen asleep, same pid. Three item seams crossed while dozing. |
| (h) focus, transient | pass | We held AUDIOFOCUS while playing. We lost it transiently and paused while the helper held it (`LOSS_TRANSIENT`), and resumed after it abandoned. |
| (h) focus, permanent | pass | Paused while the helper held AUDIOFOCUS_GAIN. Media3 abandoned our request, so there was no stack entry, and no resume followed (none is owed). |
| (i) call | pass | Before the call: playing. Ringing: paused (`LOSS_TRANSIENT`). In the call: paused. Within 3 s of hang-up: playing. |

**Against the JS lane (§7).** (h) and (i) behave the same way on the two lanes. The difference is where the decision
is made. On the JS lane, WebView's own focus handling pauses and resumes the element. In native mode, Media3 reports
the loss through `FocusMapping`, the core rules on it (a transient loss is an interruption, and its gain resumes
with the 1.5 s rewind), and the deck carries it out. So the pause, the resume and their reasons are rows in the
engine's ring (`session kind=interruption`, `stop cause=interruption`). They are not inferred.

**What this leg does not prove.** Anything a phone adds (§6.4 of `docs/research/mp1-background-audio.md`). It also
does not prove the page's path into the engine, which is A-28's. The driver is a debug-only stand-in for that path.

## 10. A-27: (j) in native mode, a play after the process ended

**Run:** `android-playback` run 36665544656, job 109729315165, `android-playback (API 34, native engine)`, PR #905,
head `e9dd10df`. The leg took 15 min 55 s, all nine native steps green. The evidence is the run's
`foray-android-playback-api34-native` artefact: `verdict-native-kill.json`, the `j-*` media-session dumps and each
leg's `j-<leg>-3-engine-dump.txt` (the engine's dump and rows just after the play), and `logcat.txt`.

**The scenario.** Each leg plays its own two-episode queue (the CBR click track first; no in- or out-point, because
the engine keeps no resume point for a segment) for 18 s. Then `cmd media_session dispatch pause`, Home, the process
ended one way, and `cmd media_session dispatch play`. Before every play, `Last MediaButtonReceiver` was ours:
`ForayMediaButtonReceiver`, switched on by the service.

| Leg | Gated | Did the process die? | Way back | Saved → resumed | Play to audible |
|---|---|---|---|---|---|
| `am kill` (the card's) | yes | **no**, same pid. The paused Media3 service stays in the foreground for ten minutes (`DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`), and `am kill` ends only a killable background process: what §7 found for the JS lane. | the live session (warm) | 18.307 s → 18.497 s | 87 ms |
| swipe (the service's `onTaskRemoved`, Media3's default stops a paused service), then `am kill` | yes | **yes**, "kill background" (adj 700). Nothing restarted it. | **the media button receiver**: one `media-button receiver start restorable=true` line, the service started for the key, the empty session's `onPlaybackResumption` (`resumption kind=answer forPlayback=true`), `restore kind=cold-boot record=painted` | 18.321 s → 18.324 s | 612 ms (grace 204 ms) |
| SIGKILL from the app's uid (what the low-memory killer does) | yes | **yes**, "has died: fg +50 FGS". The system restarted the sticky service a second later ("Scheduling restart of crashed service … in 1000ms"). | the restarted service's empty session, directly: the same resumption answer and cold boot, with no receiver | 18.450 s → 18.785 s | 636 ms |
| `am force-stop` (the negative control) | no, recorded | yes, and nothing restarted it | **the media button receiver, again** | 18.405 s → 18.445 s | 594 ms |

"Play to audible" is from the press to the first dump that showed the engine playing, so it includes up to one
500 ms poll.

**What this settles:**
- A car's PLAY after the native engine's process died resumes 4a at the saved position on this image, whether the
  death left a restarting service (SIGKILL) or nothing at all (the swipe). The swipe leg is the emulator's twin of
  the card's device check, "Bluetooth car play after swiping the app away". The device check is **not executed**
  (D-A3).
- **The negative control does not hold.** After `am force-stop`, the play still reached our receiver, which started
  the service, and 4a played. A-67 wrote this step as "`am force-stop`, then play → not 4a. **Recorded only.**" On
  API 34, a force-stopped app's media button receiver is still sent the key (the system's `PendingIntentHolder`
  sent it, and `ActivityManager` started the process "for broadcast"). This is recorded for A-67, which owns the
  force-stop value. Nothing here gates on it.
- A04-F1 (a remote play in the background never plays) does not occur in native mode on any of these paths.

**Run before it.** Run 36663599593 (head `ec471191`) had three legs, and the verdict was green. Its evidence is why
the swipe leg exists. `am kill` left the process alive. The SIGKILL leg came back through the sticky restart's
session. Only the force-stop leg went through the receiver. That run's legs also shared item ids: the SIGKILL leg
paused at 39.8 s, and the force-stop leg paused at 64.3 s, inside the near-end window, and resumed at 0. Each leg now
has its own ids.

## 11. A-30: the native leg in the native lane, every verdict green

**Run:** `android-playback` run **36693793704**, job 109816863446, `android-playback (API 34, native engine)`,
PR #914, head `1108710e`. All thirteen native steps are green, each gated, in one run. The leg took 21 min 42 s. The
two JS legs in the same run took 19 min 23 s (API 34) and 20 min 32 s (API 36), and were also green. The evidence is
the run's `foray-android-playback-api34-native` artefact: the `verdict-native-*.json` files, `f-engine-rows.txt`,
`k-engine-rows.txt`, `k-diagnostics-copy.txt`, `e-engine-dump.txt` and `first-launch.png`.

**What changed in how the leg runs.** Until A-30, the adb-driven scenarios drove `ForayPlaybackService` from a
process whose page was in the stock JS lane. Now:
- every engine scenario stores the Developer engine setting Native first (the driver's `override`, through the owner,
  which also clears the strikes);
- the app starts in a fresh process if the running one is not native;
- the service's dump says `nativeLane` (`EngineOwnership.engineLane`), and every dump a scenario reads must say
  `true`. 158 dumps across the eleven lane scenarios did.

So the page, the owner, the media button receiver and the service are the ones A-31's flip ships. The page's own
native lane does not play an episode yet: the binary advertises `episode`, but nothing declares it until A-31. The
episodes are therefore still handed to the engine by the debug driver.

| Scenario | Result | Measured |
|---|---|---|
| (e) first launch | pass | From stopped, in the native lane. The page was usable. The screenshot was 1080×2400, and the insets were `0px` on all four sides (API 34, as in §6). The page's lane was `native` (override), and the service was already hosting the engine (`idle`, `nativeLane: true`). |
| (a) play | pass | 5.00 s in 5 s, in a mediaPlayback foreground service, and our session was PLAYING. |
| (b) Home, then screen off | pass | 60.00 s of the queue in 60 s, `Asleep`, same pid. |
| (c) presses | pass, 10 of 10 | The foreground control, then `cmd media_session dispatch` and `KEYCODE_MEDIA_*`, each of pause, play, next and previous. |
| (d) system controls | pass | `A-04 single episode`, `4a CI fixtures`, **Back 15 seconds**, **Forward 30 seconds**. The shade's control paused the engine. |
| (f) episode seams | pass (recorded) | See below. |
| (g) Doze | pass | 298.98 s of the queue in 300 s, in deep IDLE, in the rare bucket, same pid. |
| (h) focus | pass | A transient loss paused us (`LOSS_TRANSIENT`) and its end resumed us. A permanent loss paused us, and we stayed paused. |
| (i) call | pass | Ringing and in the call: paused (`LOSS_TRANSIENT`). Within 3 s of hang-up: playing. |
| (j) process ended, then play | pass | Saved → resumed: `am kill` 18.896 → 18.986 s (the process lived, the warm path). Swipe then `am kill` 18.561 → 18.561 s, through the receiver, 654 ms. SIGKILL 18.596 → 18.899 s, 631 ms. `am force-stop` (recorded only): 18.644 → 18.959 s, through the receiver again (A-67's finding stands). |
| (k) airplane mode | pass | See below. |
| (A-28) the page's door | pass | The stock launch is legacy / Automatic. The override gives `engine=native … reason=override` in the Copy. It now starts from Automatic itself, whatever ran before. |
| (A-29) fallback | pass | Three faulted native launches fall back to `js`, and the fourth is pinned to the JS lane (crash-loop). |

### (f) Episode seams with the screen off, recorded

**The queue.** One process, the app on Home, `mWakefulness=Asleep`. There are eight items and seven seams:
- six 12 s segments over the three click tracks: CBR, VBR-Xing, VBR-Xing again at 30 s, VBR with no seek table, then
  CBR at 20 s and at 50 s;
- the VBR-Xing track whole, played to its file's end;
- a 10 s segment of the no-TOC track.

The queue crossed every seam and ended (`state: ended`) on its last item.

**How a gap is measured.** Each gap is read from the engine's own rows, all on the device's clock. It starts at the
outgoing load's first `deck time-control` away from playing (the out-point's pause) and ends at the incoming load's
first `deck time-control playing` (Media3's `isPlaying`).

**The natural end.** A natural end writes no row of its own. The deck's `Ended` and the engine's next `attach` happen
in one turn on the player's looper, so the attach stands for the end. The whole episode's last 15 s position write
said 89.94 s at 09:15:46.526. The file is 90.07 s long, which puts the end at about 09:15:46.656, within 8 ms of the
attach at 09:15:46.648.

| # | Seam | Load | Gap (ms) | Attach → playing (ms) | Ready (ms) | Out-point overshoot (ms) |
|---|---|---|---|---|---|---|
| 1 | CBR 0–12 → Xing 0–12 | cross-source | 82 | 69 | 46 | 135 |
| 2 | Xing 0–12 → Xing 30–42 | same-source (reuse) | 111 | 97 | 71 | 2 |
| 3 | Xing 30–42 → no-TOC 0–12 | cross-source | 95 | 82 | 62 | 37 |
| 4 | no-TOC 0–12 → CBR 20–32 | cross-source | 126 | 114 | 82 | 5 |
| 5 | CBR 20–32 → CBR 50–62 | same-source (reuse) | 80 | 67 | 48 | 4 |
| 6 | CBR 50–62 → Xing whole | cross-source | 117 | 104 | 76 | 2 |
| 7 | Xing whole (natural end) → no-TOC 0–10 | cross-source | 97 | 97 | 67 | none (natural end) |

**All seven:** min 80, median 97, p95 126 and max 126 ms. By kind:
- same-source (2 seams): 80 and 111 ms;
- cross-source (5 seams): median 97 ms, p95 126 ms.

**What this settles:** a native episode queue moves from item to item with the screen off in about a tenth of a
second of silence, whatever the source. That is well under A-40's 1 s bar, though that bar is the Foray tape's and is
not gated here. On the JS lane, by contrast, Foray seams ran 3.1–3.4 s p95, most of it the interlude jingle (§7 (f)).
These are local assets. A network episode adds its fetch, which the device pass measures (D-A3, not executed).

### (k) Airplane mode, both halves gated

- **The engine's half.** In airplane mode, the driver loaded one episode at
  `https://audio.jwlabs.ai/e/a30-ci/unreachable.mp3`:
  - The deck attached at 09:24:55.568 (host `audio.jwlabs.ai`).
  - Media3 failed it with `ERROR_CODE_IO_NETWORK_CONNECTION_FAILED` (2001) at 09:24:58.867.
  - The engine wrote `stop cause=error` 3303 ms after the attach, and emitted `Error[code=load]`. The gate is 25 s:
    the deck's 20 s load deadline plus 5 s.
  - Nothing sounded. The engine went to `idle` (not running), and our session said PAUSED, not PLAYING.
  - Still in airplane mode, a bundled episode then played.
- **The page's half.** A fresh native-lane process. The page's lane was `native` (override). A Foray tap went
  through the relinquish, because the binary advertises no `foray` until A-40/A-41: the Copy logs `engineMode js
  (relinquished)` after the six `engineMode native (override)` rows. The JS leg's own (k) then passed on the page's
  player:
  - the rendered line that could not load was **spoken** from its script, 42 ms after the first clip's out-point;
  - the Foray landed on the next clip 3.9 s after that.

  A-41 moves the narration fallback into the engine, and its acceptance runs (k) through the engine instead.

## 12. A-31: the A1 flip, a stock launch in the native lane

Run 36706526452 (attempt 2). Card A-31 of `docs/plans/android-assessment.md` sets `mobile/ENGINE_DEFAULT.json`
android to `native` with `episode` and `continuation`, and `EngineLane` to match. So a stock launch, with the
Developer engine setting on Automatic, is the native lane. All three legs are green.

- **The native leg** (job 109866270019, 21 min 49 s). Every step is green. The eleven lane scenarios now store the
  Developer setting Automatic (`{"ok":true,"override":"auto"}` each), not Native. Every dump they read said
  `nativeLane: true`, so the stock lane is the one they measured.
  - (e): the page's lane was `native` and the Developer row read Automatic.
  - `bridge`, stock launch: the Copy header was `engine=native v1.0.0 proto=1 caps=episode,continuation
    reason=build-default strikes=0 hold=forever`, with `engineMode native (build-default)` rows and the engine's ring
    read (4 rows).
  - `bridge`, the flip end to end: the page's own `ForayPlayer.play` answered `true`, and the engine's dump then held
    `a31-page-episode`, `playing`, at 0.30 s, in `ForayPlaybackService`, with no legacy service.
  - `bridge`, the way back: the Developer setting Web, stored through the page, gave a relaunched page the `js` lane
    with the row on Web. The setting was then put back to Automatic.
- **The JS legs** (API 34, job 109866271533, 18 min 55 s; API 36, job 109866270354, 21 min 1 s). Their first step
  now stores Web through the debug driver and relaunches. It read the page's lane as `js` with the row on Web on both
  legs, and every scenario after ran on the page's player, as before the flip.
- **One flake, rerun.** On attempt 1 the API 36 JS leg's (c) failed: `input keyevent KEYCODE_MEDIA_PAUSE` and `PLAY`
  reached the page as no `foray:remote` row. The system's media button session was still our legacy one
  (`androidx.media3.session.id.foray`). NEXT and PREVIOUS did reach it. The rerun passed (c) and every other step.
  The same leg passed (c) on run 36699722800 before this card. The native leg's attempt 1 never ran: Maven Central
  answered 403 to the Gradle build.

## 13. A-40: the Foray tape on the deck pair, `foray-seams`

Run 36731336922 (attempt 2), head `29e81477`. Card A-40 of `docs/plans/android-assessment.md` puts the Swift core's
Foray tape on the JVM core and plays it on a deck pair: two `ExoDeck`s in `DeckPair`, the iOS NE-32 shape. The native
leg gains the `foray-seams` step, which is A-05 (f) for a Foray: `playForay` through the debug driver's `foray`, 8
segments of 8 s over the bundled clips, on Home with the screen off. The gate is p95 seam ≤ 1 s (`NATIVE_GATES.foraySeamP95Ms`),
with every seam crossed and the pair swapping at least once. All three legs are green.

- **`foray-seams`** (native leg, job 109959958541, 23 min 10 s for the leg).
  - 7 seams crossed out of 7. Every one was **prepared**: the standby deck had the next segment ready at the
    out-point, and the pair promoted it. None was unprepared.
  - The gap from the out-point to the incoming deck playing: min 504, median 507, p95 **513**, max 513 ms. The
    core's asked gap is the 0.5 s seam beat. Its `seam` rows read `observedGapMs` 500–501 on every seam, so the
    audible gap over the beat is about 4–13 ms.
  - The pair's dump at the end: `{active: 0, swaps: 10, available: true}`. The device was `Asleep` (screen off)
    throughout.
  - Out-point overshoot: 9 ms on the first seam, then 84–201 ms with the screen off. The overshoot is how late the
    stop landed past the out-point. It is never early, which is the contract A-25 set. The later overshoots are
    the screen-off delivery of the out-point message. The gap above is measured from the out-point's row. A-62
    (warm seams) is the card that tightens it.
- **The episode `seams` step, with the tape on.** Segment queues now play on the pair, so a handed-over segment has
  no `attach` row. The runner reads the pair's `prepare kind=promote` row as the incoming load (`via: handover`).
  Without that, the first run read only 4 of 7 seams.
  - This run: 7 of 7. Three handovers (516, 520 and 519 ms), two same-source reuses (520 ms each), two cold
    attaches (108 and 110 ms, no beat: they are episode boundaries).
  - p95 520 ms.
- **The earlier attempt** (run 36731336922 attempt 1 was cancelled at 40 min: "Render the A-05 narration fixtures"
  hung, which is infra). The run before it, on `e61ff54f` (job 109934107177), passed `foray-seams` with 7 of 7
  prepared: min 503, median 505, p95 507 ms, 10 swaps.
- **The JS legs** (API 34, job 109960002603; API 36, job 109959960746) are unchanged and green.
- **The JVM side** (android-build run 36731336880, android-shell): the JVM parity run passed 1714, 0 pending, 0
  failed. foray-audio ran 167 test cases, 0 skipped, including `DeckPairTest`, `ForayEngineHostForayTest` and the
  Robolectric `ExoDeckPairTest`.
- **Not measured here.**
  - VBR in-points. A-25 measured Media3's VBR seek maps as early, and the pair does not change that.
  - A spoken bridge. The host has no synthesiser until A-41, so it answers a spoken line `failed` and the core steps
    over it.
  - The device check, a locked Foray on the Pixel (D-A3). No device passes happen until A-42.

## 14. A-41: rendered narration, the TTS fallback and the jingle, in the engine

Run 36754688003, head `ca843873`. All three legs are green. The native leg (job 110021817120) took 23 min 50 s.

Card A-41 of `docs/plans/android-assessment.md` gives the native engine two things:
- its own synthesiser: `SpeechNarrator` over Android `TextToSpeech`;
- its own jingle player: `InterludePlayer` over a `MediaPlayer` on the bundled, SHA-256-pinned jingle.

The APK carries both bundled files at the assets root: `interlude-placeholder.wav` (529,244 bytes) and
`hard-terms.json`.

- **`foray-seams`, now with the jingle.** It is the same 8-segment Foray as §13, on Home with the screen off.
  - Six of the seven seams cross sources, so each carries the jingle. Each jingle sounded for 3072–3091 ms and ended
    on its own (`interlude kind=ended why=ended`). No jingle hit the 4.5 s ceiling.
  - The seam inside one source was `skipped`, as the rule says.
  - The raw gap from the out-point to the next segment playing: median 3084 ms, p95 3101 ms. That is the jingle.
  - The **silence**, which is the gap less the jingle's span: min 9, median 10, p95 **507** ms. The p95 is the
    no-jingle seam, whose 0.5 s beat is its whole gap. The gate is on the silence, and it is still ≤ 1 s.
  - With the jingle, a seam's silence is about 10 ms. The standby deck is warm long before the jingle ends, so
    the jingle's end starts the segment at once.
  - All 7 seams were prepared. The pair ended at `{active: 0, swaps: 10}`, and the device was `Asleep` throughout.
- **(k) through the engine.** This is the third half of the airplane scenario, still in airplane mode. The debug
  driver's `foray` hands the engine five items: a 6 s clip, a rendered line on a bundled `.m4a` (`public/a05/`), a
  6 s clip, a rendered line on the network, and a clip to land on.
  - The bundled rendered line attached at the clip's out-point and was playing 146 ms later. It played its 5 s
    as the deck's audible item: **a file**, not speech.
  - The line to the next clip carried the jingle (3.17 s).
  - The network line failed at the deck (`ERROR_CODE_IO_NETWORK_CONNECTION_FAILED`). The core wrote
    `narration kind=fallback reason=failed at=bridge` **3057 ms** after the clip before it ran out. The gate is
    25 s.
  - The engine's synthesiser started speaking the script 1.8 s later (`speaker kind=line-started`,
    `com.google.android.tts`), 4.9 s after the out-point. The line finished (`narration kind=ended
    why=finished`), and the jingle played.
  - The Foray landed on its last clip, playing, in the same process.
  - The service's dump said `speaker: {ready: true, engine: com.google.android.tts}`.
- **(k)'s other halves are unchanged.** The engine stopped the unreachable episode 3094 ms after its attach. On
  the page's half, the page's player spoke its line 36 ms after the out-point.
- **The JS legs** (API 34, job 110021816658; API 36, job 110021817001) are green.
- **Repeated** on head `df182eaf` (run 36758069597, native job 110033292766), with all three legs green.
  - `foray-seams`: silence median 7 ms, p95 503 ms; raw gap p95 3098 ms; six jingles of 3077–3092 ms.
  - (k): the fallback 3043 ms after the out-point, spoken 4394 ms after it; the bundled line heard as a file; the
    Foray landed.
- **Not measured here:** the device check (the airplane-mode fallback on the Pixel, D-A3), and whether Android's
  engine honours the lexicon's `<phoneme>` markup. Android documents no phoneme attribute. The only authored IPA
  is `sake`.
- **A-41 review** (follow-up to #921). (k)'s engine half now requires the fallen-back line to have reached the
  engine's synthesiser: a `speaker kind=line-started` row, or a refusal row after the fallback. Before, landing on
  the last clip also counted, and a host with no speaker lands too. The narrator now writes
  `speaker kind=line-refused why=no-synthesiser` at the line itself. The host's partial wake lock also covers a
  spoken line while it is the running playhead, since no deck plays then. The service feeds a lost route when
  headphones come out while no deck plays (a spoken line, or the jingle), because Media3's becoming-noisy
  receiver is on only while a deck plays.

## 15. A-42: the A2 flip, the page's own Forays on the engine

Run 36775164730, head `de4883c7`. All three legs are green on the first attempt. The native leg (job 110091117568)
took 35 min 44 s. Its scenarios took about 20 min, as before. The step that renders the A-05 narration fixtures took
11 min 24 s on this runner, against about a minute before. That step is unchanged here, so the number is the
runner's. It is still under the 40-minute ceiling, and worth watching.

Card A-42 declares `foray` (and `restore`) for Android, so a Foray the page plays is the engine's.

- **`bridge`.**
  - The stock launch's Copy says `engine=native v1.0.0 proto=1 caps=episode,continuation,restore,foray
    reason=build-default`.
  - The page's own episode play is the engine's, as in §12.
  - The page then played `a42-page-foray` through its own `ForayPlayer.playForay`. Its build was three click-track
    clips over the APK's assets, and `ForayPlayer.resolve` found 3 of 3 playable.
  - The engine held `a42-page-foray`, playing clip 0 on ExoPlayer. It crossed into clip 1 (`a42-page-foray#1`,
    index 1, playing) about 11 s later.
  - The page's lane afterwards was still `native`: nothing was relinquished.
- **(k), the page's half.** The page built A-41's airplane Foray (clip, bundled rendered line, clip, network line,
  clip) as `a42-page-air` and played it with airplane mode on (`airplane_mode_on` 1).
  - The bundled line played as a file on the deck.
  - The network line fell back: `narration kind=fallback reason=failed at=bridge`, 3068 ms after the clip before it
    ran out.
  - The engine's synthesiser spoke its script 4832 ms after the out-point (`speaker kind=line-started`,
    `com.google.android.tts`).
  - The Foray landed on its last clip, playing, in one process.
  - The Copy afterwards is `engine=native`. It holds six `engineMode native (build-default)` rows and no
    `engineMode js (relinquished)`.
  - Until A-42 this half was the JS leg's (k), run on a Foray relinquished to the page's player.
- **(k)'s other halves.** The engine's own Foray (the debug driver's) fell back in 3038 ms and was spoken 4886 ms
  after the out-point.
- **`foray-seams`.** Silence p95 506 ms. Every other native verdict is green.
- **The JS legs** (API 34, job 110091118025; API 36, job 110091117947) are green. They pin Web in their first step,
  so the flip does not reach them.

## 16. A-60: provisional field values, their rows, and the Android paste

Card A-60 mirrors iOS NE-38 and NE-38e on the Media3 deck. Every value M3 ships before Joey's pastes exist is
provisional: it is a named constant tagged `// MEASURE: verdict=<id>`, and it names the NE-38e verdict and the rows
that settle it. Android uses iOS's values, because no emulator measurement argues against them. A-68 settles them.

| Value | Android constant | Android | iOS | Verdict | Rows that settle it |
|---|---|---|---|---|---|
| P-13, clip or episode | `ExoDeck.DEFAULT_LOAD_DEADLINE_SEC` | 20 s | 20 s | `P13-clip` | `deck ready elapsedMs marks` of cold loads; `deck deadline step= class=clip` |
| P-13, rendered line | `ExoDeck.DEFAULT_LINE_LOAD_DEADLINE_SEC` | 8 s | 8 s | `P13-line` | the same rows with `class=line` |
| Same-source reuse limit | `ExoDeck.DEFAULT_REUSE_MAX_IDLE_SEC` | 600 s | 600 s | `reuse-idle` | `deck reuse idleSec=`, then `failed`/`deadline`/`stalled` on its token within 30 s; `deck attach cold=stale idleSec=` |
| P-14 stall display | `EngineCore.BUFFERING_WHILE_WAITING` | on | on | `rate-latch` | `deck time-control status=waiting reason=` |
| Voice preview load deadline (A-66, NE-47) | `ForayPlaybackService.PREVIEW_LOAD_DEADLINE_SEC`, on the preview deck for both classes | 6 s | 6 s | `preview-load` | `deck ready elapsedMs lane=preview`, `deck deadline lane=preview`, `audition fallback reason=timeout` |

- **Which deadline a load gets.** The JVM core names a class on every `Load` and `Prepare` (`DeckDeadlineClass.of`): a
  `tts` item is a `line`, and everything else is a `clip`. The deck maps the class to seconds. `DeckPair`'s warm load
  runs under the item's own class. A line whose deadline passes is read aloud by `TextToSpeech` on a fresh token
  (`narration kind=fallback reason=timeout`).
- **The published speed.** Media3's session derives its speed from the facade: the platform `PlaybackState` speed is
  `isPlaying ? speed : 0` (media3 1.11.0 `MediaSessionLegacyStub`). So iOS's latch, where the rate stuck at 0 while the
  clock ran, cannot happen here in the same form.
  - The facade now carries the listening speed at all times. Before A-60, a stall published 1x.
  - It is READY while playing, so the session publishes the listening speed.
  - It is BUFFERING through a stall, so the session publishes 0.
- **The ring's gate.** `DiagGate` is ported to the JVM core, and `EngineLog` applies it to the DiagRow ring that the
  page's Copy prints. Before A-60 the Android ring dropped every row's sub-kind as a header shadow. A Copy printed
  `deck src=engine token=1 …` with nothing saying which deck row it was, so no NE-38e verdict could read an Android
  Copy.

**Robolectric** (android-build run 36786830308, android-shell green: foray-audio 198 cases, +9; the JVM core 124, +6;
JVM parity 1778 passed, 0 pending):
- `ExoDeckFieldValuesTest`:
  - a line whose file never arrives is given up at exactly 8000 ms, and its row says `class=line`;
  - a clip whose file arrives at 19 s is ready, with no deadline through 21 s. This test uses a manual FakeClock,
    stepped by hand;
  - a reuse after 590 s idle is a seek (`idleSec=590`), and after 610 s it is cold (`cold=stale idleSec=610`);
  - every deck row passes the gate whole, including through `EngineLog`.
- `ForayEngineHostNarrationTest.aRenderedLinesEightSecondDeadlineIsReadAloud`: the loads name their classes, and a
  line's 8 s deadline is spoken with `reason=timeout`.
- `EnginePlayerTest`: the published speed is 1.5 while playing, 0 while buffering, and 1.5 again afterwards.
- `DiagGateTest`.

**The emulator** (android-playback run 36786830313, head `22ecce6e`): all three legs are green. The native leg (job
110130136766) took 24 min 22 s.
- **The rows.** The Android Copy now prints the sub-kind with iOS's tokens:
  - `deck src=engine attach token=1 … cold=no-item idleSec=— class=clip`;
  - `ready … elapsedMs=202ms … class=clip`.

  Rendered lines load as `class=line` (`k-foray-engine-rows.txt` #31, #34: ready in 85 ms).
- **`engine-report.mjs` over the paste.** It now reads the text ring as the scenarios save it (`*-engine-rows.txt`), as
  the service's dump prints it (`ForayEngine.row …`) and as logcat carries it. The Copy was already in the iOS format.
  NE-38e's M3 verdicts are on `engine/m3`, not yet on this branch. The tool merged with A-60's reader has no conflicts
  (`git merge-file`), and it gives:

  | Paste | P13-clip | P13-line | reuse-idle | narration-fallback |
  |---|---|---|---|---|
  | `k-diagnostics-copy.txt` (the page's Copy) | pass, cold n 3, p95 202 ms | pass, n 1, 84 ms | no-coverage | pass, 2 line loads; 1 fallback without `cause=` (A-64) |
  | `k-foray-engine-rows.txt` | pass, n 2, p95 94 ms | pass, n 1, 85 ms | pass, 1 reuse | pass |
  | `f-foray-engine-rows.txt` | pass, n 7, p95 89 ms | no-coverage | pass, 1 reuse | no-coverage |
  | `f-engine-rows.txt` | pass, n 5, p95 89 ms | no-coverage | pass, 3 reuses, idle max 3.2 s | no-coverage |

  - `rate-latch`, `seam-kinds` and `suspension-in-seam` are no-coverage on every paste. Android writes no `nowplaying`
    rows (the session is Media3's; see above), and the seam `from=`/`to=` and late-timer rows are A-62's and A-65's.
  - The same Copy from A-42's run 36779471865 is no-coverage on all four verdicts, because the sub-kind was missing.
- **What these numbers are not.** Cold loads of files bundled in the APK take 70-200 ms. They say nothing about a
  podcast CDN on a phone, so the tool's printed proposals (1 s) settle nothing. A-68 settles each value from Joey's
  pastes (D-A3).
- **What the gate now names.** The gate withholds a field it cannot carry, and each one is now named in the row
  instead of vanishing:
  - `narration fallback` and an injected `mode` fault carry `at`, the DiagRow's wall-clock key (`withheld=at`).
    NE-39n renames it `where` on iOS; the JVM port of that rename is A-64's.
  - One `stop` row withheld `item`, a Foray item id with `#`, which is not a token. It is the same on iOS; A-67's
    stop-cause audit is where that is decided.

## 17. A-62: prepare across narration seams, `foray-seams` with rendered lines

Card A-62 mirrors iOS NE-45s on the Media3 deck pair. Warming follows the FILE, not the beat: a rendered line is
prepared on the standby deck and handed over like a clip, and so is the clip after it. The line's own prefetch window
opens from its duration (it has no out-point). Every seam writes one `seam` row naming its kind and whether the
standby had the item.

**The scenario.** The native `foray-seams` Foray (A-40's eight 8 s click-track segments) now carries the three
rendered `a05/` lines (5, 6 and 7 s, AAC). It has ten seams: four clip->clip, three clip->line and three
line->clip. A line has no out-point, so its seam opens at the core's first row after the deck's `ended`
(`beat begin`, `interlude started|skipped`, `prepare promote`), or at the player's pause, whichever comes first.
Media3 reports the end before the is-playing change. Run 36796964815 opened at the pause and so counted the jingle
after each line as 3 s of silence.

**Gated:** p95 silence ≤ 1 s (the A-40 bar; a jingle's span is sound), every kind crossed as often as the Foray has
it, and every seam with a line in it `prepare=hit`.

**Run 36799524357** (head `ad3746e6`, native job 110170503663), screen off, one process:

| Seam kind | n | Silence p50 | Silence p95 | prepare |
|---|---|---|---|---|
| clip->line | 3 | 7 ms | 9 ms | hit 3 |
| line->clip | 3 | 5 ms | 8 ms | hit 3 |
| clip->clip | 4 | 10 ms | 507 ms | hit 3, none 1 |
| all | 10 | | 507 ms (max 507) | |

- The 507 ms seam is the same-source seek (items 5 to 6): no warm (`prefetch decision=same-episode`), the 0.5 s beat
  and a reuse.
- Six seams carried the jingle (each line->clip, and the cross-source clip->clip seams). The raw gaps, with the
  jingle in them, are p95 3095 ms.
- Each line was prepared in the clip window before it (`prefetch ... class=line`, ready in 70-80 ms), and the clip
  after each line was prepared at the line's first play (`class=clip`). No `prefetch` row said `reuse=true` here:
  the clip after each line comes from another source.
- `engine-report.mjs` over `f-foray-engine-rows.txt`: `seam-kinds` reads clip->clip 4 (hit 3, none 1), clip->line 3
  (hit 3) and line->clip 3 (hit 3), `incomplete` only because the saved rows start mid-ring. `P13-line` passes (cold
  time-to-ready p95 85 ms) and `narration-fallback` passes (3 rendered-line loads, 0 fallbacks).

**Robolectric** (android-build run 36799524361): `NarrationSeamTest` runs the real JVM core through `ForayEngineHost`
over a `DeckPair` of two ExoDecks on local files: clip, an 8 s rendered WAV line, clip. Two handovers, one cold attach
(the first clip's), both seam rows `prepare=hit`, never two players sounding.
