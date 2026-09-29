# Android emulator: measurements

The running record of what the CI Android emulator has measured for the JS player lane
(`docs/plans/android-assessment.md` §5.3, Track A0). Every line here is **CI-executed**, with
its run and job ids, or is marked **not executed**. Nothing in this file was measured on a
phone. The PC this repo is written on runs no emulator and no Gradle build, so every number
comes from a GitHub Actions runner.

Cards add their own section. A-03 (can the emulator play audio at all?) wrote §1–§4. A-05
records its seam, focus, call and kill values in §6, and A-06 records its API 36 differences.

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
| (e) first launch | pass | The screenshot is 1080×2400. The page reads every `env(safe-area-inset-*)` as `0px`, with `innerHeight` 891 against a `screen.height` of 915 (CSS px). So on API 34 the WebView is laid out inside the system bars, not edge to edge. Enforcement starts at API 35 (A-06, A-11). |
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

## 6. A-05: the playback scenarios, part 2

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

All twelve scenarios were green on both runs.

The fixtures:
- **Rendered narration.** Three `.m4a` lines of 5, 6 and 7 s, made in the job by ffmpeg at
  `tools/narration/render-profile.json`'s encode: AAC, 64 kbps, mono, 24 kHz, faststart
  (`a05-narration-ffprobe.txt`). They are bundled at `a05/` beside A-04's click tracks, and no
  audio is committed.
- **Clips.** The NE-25a click tracks, as in §5.
- **The "other app" in (h).** `tools/mobile/a05-focus-helper/`, built in the job with javac, d8
  and aapt2 from the SDK the job already installs.

### (f) Hidden seam timing, recorded

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

This settles the §6.2 question on the emulator. While we play, the focus stack holds one entry:
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
