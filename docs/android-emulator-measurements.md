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
