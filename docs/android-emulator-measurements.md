# Android emulator: measurements

The running record of what the CI Android emulator has measured for the JS player lane
(`docs/plans/android-assessment.md` §5.3, Track A0). Every line here is **CI-executed**, with
its run and job ids, or is marked **not executed**. Nothing in this file was measured on a
phone. The PC this repo is written on runs no emulator and no Gradle build, so every number
comes from a GitHub Actions runner.

Cards add their own section. A-03 (can the emulator play audio at all?) wrote §1–§4. A-05
records its seam, focus, call and kill values here, and A-06 records its API 36 differences.

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

The same as §5: nothing audible, no Doze or standby bucket, no call, no OEM battery manager, and
no current phone's WebView (the API 36 image ships 133). The device pass after A-42 settles those.
