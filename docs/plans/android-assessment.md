# Assessment: Android: where it stands, what the iPhone fixes left behind, and the smallest path to a tested Android

Status: **DRAFT for founder review, 2026-09-28.** Nothing in the app changes in this PR. It adds only this document.
Read on `origin/main` @ 02ac856c, plus `origin/engine/m2` @ 5920e0ec for the native-engine sizes. It combines
three read-only lens reviews: **inventory** (what Android is and what runs it), **parity** (every iPhone bug from
the last three weeks, checked against the Android code) and **plan** (native engine, automated testing and the
human loop). Where the lenses disagreed, this document says which reading it took and why.

What triggered it, in the founder's words (2026-09-28): *"Where is android in all this? I'm afraid that I've been
doing all the testing on iphone and there are just as many bugs we'll need to suss out later on android"*.

Constraints taken as given:
- Store launch is out of scope for now, but Android must not rot.
- Narration is moving to centrally rendered files (DECISIONS 2026-09-28; `docs/plans/spark-central-narration-assessment.md`),
  so on-device TTS on Android is only a fallback.
- The founder tests only on an iPhone 17 and in his car.
- The founder does not want spinning wheels. Every card below is chosen to produce a measurement or a fix, not a
  study.

---

## 1. Summary for the founder

**Where Android stands.** Android builds on every PR, is signed, and is uploaded to Play's internal track on every
release. Build 2026092802 went up today (run 36498488084, `android_uploaded=true`). **Nobody has ever heard it
play.** No human has installed a Play build, because the internal track has no testers (HUMAN-ACTIONS #44, open
since 2026-09-11). The only time the app has ever *run* is a CI emulator test that proves it launches and that the
native bridge answers. That test never plays audio, and it only runs when four release-pipeline files change. The
Android docs say this themselves: the lock screen, notification, Bluetooth buttons and background service are
"NEITHER MEASURED NOR INFERRED — UNVERIFIED" (`docs/android-lock-screen.md` §0, `docs/android-native-code.md` §1).
The HUMAN-ACTIONS item that was meant to cover the Android device pass (#11) was closed on 2026-09-24 using iPhone
evidence only, so Android lost its only tracking item.

**Why your worry is right.** Android still runs the design the iPhone just left: audio plays from the web page's
`<audio>` element, with a foreground service to keep the app alive and a Media3 session for the lock screen. The
iPhone moved to a native engine because that design failed in your car. Android has the same weak points, plus a
few of its own. By design, the native engine is iOS-only (`player/engine-contract.js` `decideMode` returns `js`,
`not-ios` for every other platform, and `docs/native-engine-plan.md` §11 puts Android out of scope). There is one
more problem: now that your iPhone plays episodes and Forays natively, **nobody tests the JS player that Android
depends on.**

**The good news.** Every fix made in shared JS, CSS or `app.js` already applies to Android. That covers the menu
not collapsing, double-tap zoom, the focus ring, 15/30 skips, stall shown as buffering, the car's stop only
pausing, and a finished episode staying paused. Several iPhone bugs cannot happen on Android at all: "4a / unknown
/ unknown" on the lock screen, rate 0 in Now Playing, and the native stuck-loading bug (#866).

**The biggest known or likely Android bugs** (none measured yet):
1. **Silence at every seam while the screen is off.** A hidden web page loads media slowly (9–11 s measured, MP1
   §4.1a), and a foreground service does not make the page visible. Rendered narration adds a file seam per line.
   This is the failure iOS built the native engine to remove.
2. **Car "play" goes to Spotify once the app has died, been swiped away, or been exited.** Nothing can receive
   media buttons when the process is gone.
3. **Pressing Back on Home kills the audio.** `app.js` calls `exitApp()`, the activity is destroyed, and the plugin
   stops the playback service.
4. **Unplugging headphones or losing the car's Bluetooth: audio keeps playing from the phone speaker.** There is no
   "becoming noisy" handler.
5. **Phone calls and other apps:** whether we pause, duck or resume is unknown. We never request audio focus, and
   Android sends the player none of the interruption events it listens for.
6. **Android Auto:** 4a cannot appear there at all. There is no media browser service.
7. **Diagnostics are blind.** An Android Copy paste cannot say why audio stopped, because Android emits no
   session, route or focus rows.

**What it would take.**
- **This week, about 5 minutes of your time.** Add yourself and Joey as Play internal testers (HUMAN-ACTIONS #44).
  Joey's Pixel 10 Pro then receives every build, and he runs one scripted 30-minute pass.
- **In parallel, agent work only (Track A0, about 2 weeks of agent time):**
  - Run the emulator test on every player or app PR.
  - Teach it to actually play audio, lock the screen, press media keys, fake a phone call, kill the app and time
    the seams. Android bugs then surface in CI without a human.
  - Fix the three cheap Android-only bugs: Back, headphone unplug, and diagnostics rows.
- **Then (Tracks A1–A2, roughly 3–4 weeks of agent time):** a native Android engine on Google's Media3/ExoPlayer,
  built the same way as the iPhone's and held to the same 2,900 parity fixtures. It starts once the iPhone M2 car
  test has passed, so it ports a core that has stopped moving. This is the only real fix for bugs 1, 2 and 6.
- **Android Auto (A3)** comes last, and only when store launch is back in scope, because it triggers Play's car
  review.

**What needs a human:** you add the Play testers; Joey runs a device pass per milestone; and later, if you want an
Android car loop of your own, you buy one cheap Samsung phone (about $150–250; the price is approximate and was not
checked). The decisions are in §6, each with a recommended default.

---

## 2. What Android is today (inventory)

| Area | Status | Evidence |
|---|---|---|
| Platform project | Works (generated) | `mobile/android/` is gitignored and regenerated by `cap add android` in every CI job. Capacitor 8.5.0; minSdk 24, compile/target 36; AGP 8.13.0; Gradle 8.14.3; JDK 21. App id `ai.jwlabs.foura`, name "4a". Because the tree is regenerated, a Capacitor template change silently alters the manifest, and only CI grep steps catch it. |
| Audio path | Unknown on hardware | Plain `<audio>` in the WebView through the JS player (`PlaybackKeepAliveService.java` header: "Nothing in this class touches it"). `mobile/ENGINE_DEFAULT.json` mode `native` affects only iOS. |
| Keep-alive | Unknown | `PlaybackKeepAliveService`: a `mediaPlayback` foreground service, `START_NOT_STICKY`, `stopWithTask=true`, no binder. Its lifetime is "a Foray is loaded" (`foray-audio-shell.js` `setMediaLoaded`). Robolectric has 8 tests. Never run on a device. |
| Lock screen / notification | Unknown | The `navigator.mediaSession` polyfill (`foray-media-session.js`) feeds a Media3 1.11.0 `MediaSession` over `WebViewPlayer` (a `SimpleBasePlayer` that plays nothing and relays state). A hand-built MediaStyle notification: prev/play-pause/next/stop plus 15/30, no artwork bitmap. |
| Audio focus | Unknown | Never requested natively, by design (`docs/android-native-code.md` §6.2). Whether WebView requests focus for `<audio>` is unestablished. |
| Android Auto | Absent | No `MediaLibraryService` or `MediaBrowserService`, no `automotive_app_desc.xml`, no car meta-data. `onBind` returns null. |
| foray-tts | Unknown | Android `TextToSpeech`, plus a Kokoro ONNX probe that "is NOT A NARRATION PATH". Every CI build injects the Kokoro q8f16 weights (about 86 MB) and `onnxruntime-android` 1.20.0. No Java tests. |
| foray-vault | Unknown | The token lives in a file under `getNoBackupFilesDir()`. No Java tests. |
| PR CI | Works | `android-build.yml` (about 4 min) runs on `mobile/**`, `tools/mobile/**`, `player/**`, `app.js` and `index.html`. It runs 27 Robolectric tests, a debug build, merged-manifest checks, and a release build with the lint gate. Recent runs are green (e.g. 36511470103). |
| Emulator smoke | Works, launch only | The `android-release.yml` `android-smoke` job uses an API 34 `google_apis` x86_64 image with KVM and hand-rolled SDK steps (no third-party actions). It checks that app.js rendered `#view`, the bridge is present under the real CSP, `ForayAudio.state` answers `platform: android`, the pid is stable, and there is no FATAL or ANR. It takes 3m49s (run 36203157867, last green 2026-09-26). It boots with `-no-audio`, never plays, and triggers only on 4 release-pipeline paths. |
| Release | Works | `release.yml` → `.github/actions/android-bundle`: signed `.aab`, versionCode = build number `YYYYMMDDnn` (the same integer as the iOS build), uploaded to the Play internal track. Secrets are still repo-level (HUMAN-ACTIONS #115). |
| Testers | **Broken** | HUMAN-ACTIONS #44 is open. The track has no testers, so no human has ever received a build. |
| Device evidence | **None** | `docs/field-records/` holds only the iPhone car baseline. HUMAN-ACTIONS #11 was closed on iPhone evidence, while `docs/android-release.md` still says "#11 is the device pass, and it stays open". |
| Devices available | — | Joey's Pixel 10 Pro (`docs/bundled-voice-plan.md`). A local toolchain with `adb` at `%LOCALAPPDATA%\android-build\sdk\platform-tools\adb.exe`, so a USB sideload plus `chrome://inspect` is possible today. |

---

## 3. Parity: every iPhone bug from the last three weeks, checked against Android

"Works" means the fix is in shared code, or Android reaches the right answer by a different mechanism. It is
**inferred from source** unless it says otherwise. Nothing in this table has been seen on an Android device.

| iPhone bug | Android status | Evidence | Fix on Android |
|---|---|---|---|
| Lock screen / car shows "4a / unknown / unknown" (#746 item 2) | Works, by a different mechanism | Android WebView publishes no media entry of its own. Metadata comes only from our payload (`WebViewPlayer.java` metadata; the notification in `PlaybackKeepAliveService`). **Conditional risk:** `foray-media-session.js` does `if (existing && !ios) return false;`. If a WebView ever ships `navigator.mediaSession`, the polyfill steps aside and the notification falls back to "4a" / "Playback active", which is the same symptom by a different route. | Device check 1 of the pass: `navigator.mediaSession.forayPolyfill === true`. Add a CI assertion in A-04. |
| Lock-screen skips showed 10/10 instead of 15/30 | Works | A single source, `player/media-session.js` (`SEEK_BACKWARD_SEC=15`, `SEEK_FORWARD_SEC=30`). Android reads `seekBackMs`/`seekForwardMs` into Media3 increments, with `ICON_SKIP_BACK_15`/`ICON_SKIP_FORWARD_30` on API 33+. On API 24–32 the icons are generic and unnumbered, which is cosmetic. | None. |
| One-button headset/car toggle always played (iOS toggle hard-wired) | Works | Media3 resolves `KEYCODE_MEDIA_PLAY_PAUSE` from `getPlayWhenReady`, which mirrors the page state. | None. |
| Now Playing rate 0; car progress bar shows the total, not the position | Works (n/a) | `NowPlaying.java` maps a missing or zero rate to 1. Media3 extrapolates position from the page's ~1 Hz reports. A stall is reported as `STATE_BUFFERING` only while playing. | Device check: the car's progress bar advances. |
| Stuck loading on resume (native same-source reload, PR #866) | n/a | The bug is in the iOS `AVDeck`. Android never enters native mode. The JS-lane resume fixes are shared: #698, #735, p-impatient-1, player-core-3, player-core-9. | The Android analogue is a slow hidden reload after a long pause. Covered by A-05 and the device pass. |
| Menu does not collapse on Playback diagnostics / outside tap (#746 items 5–6) | Works | Shared `app.js` `onDrawerAction`. Android also gets hardware-back ordering (drawer, then sheet, then history) via `handleBack` (round-2 nav-2, fixed). | None. |
| Double-tap / pinch zoom | Works | `index.html` viewport `user-scalable=no`; `capacitor.config.json` `zoomEnabled: false`; a `gesturestart` guard. | Device check at the "Largest" system font size (WebView `textZoom` is a separate layout risk). |
| Amber focus ring on route landings (#858) | Works | Shared CSS: `outline:none` on the three `tabindex=-1` landing targets, unconditionally. | None. |
| Stall shown as buffering; finished episode stays paused and playable (p-car-6); head-unit stop only pauses (persona 3, #742); previous restarts the episode (p-car-5); previous past narration (player-4); restored Foray metadata (player-10); notification not popping back (native-8); 15/30 in the notification (native-7) | Works (JS/Robolectric) | Pinned by Node or Robolectric tests. Round-2 `status.tsv` marks native-2/7/8 "Needs a phone (Android)". | Include them in the device pass. |
| Car hands play to Spotify after a pause (app process alive) | Unknown | Android routes car buttons to a media session, not to "whoever played last in WebKit". A paused app keeps a READY session with `playWhenReady=false`, and the service stays up while anything is loaded. Whether Android's media-button policy prefers us to Spotify is unmeasured. | Device test: play, pause, lock, wait 2 and 10 min, connect the car, press play; read `dumpsys media_session`. Emulator: A-05 `cmd media_session dispatch play`. |
| Car hands play to Spotify after the app died, was swiped away, or was exited | **Likely broken** | No `MediaButtonReceiver`, `stopWithTask="true"`, and `handleOnDestroy` stops the service. With no live session, Android sends PLAY to the last app with a media-button receiver. This is the Android equivalent of iOS before M1. | Needs a `MediaSessionService` plus Media3 playback resumption (`onPlaybackResumption`) with a native player. **A-27.** |
| Resume after a phone call / Siri (#746 step 6, p-car-3) | Unknown | Android sends no session events: the only `notifyListeners` calls are `TRANSPORT_EVENT` and TTS `FINISHED`. So `client.js` `onNativeSession` (interruptionBegan/Ended) never fires. Recovery depends on WebView's own focus handling, which is unestablished. | Emulator: `adb emu gsm call` (A-05). If audio stays silent or plays over the call: A-12 (focus) plus A-09 (session events). Native: A-26. |
| Long pause (minutes, locked), then play | Unknown | The service is kept while paused. Risks: OEM battery killers, and a slow cold resume in a hidden page against the 20 s hidden deadline. | A-05 (forced Doze, standby bucket) and the device pass (10 and 30 min pauses). |
| Screen-off Foray seams (iOS FR-7, fixed by the M2 DeckPair) | **Likely broken** | One element; the two-element handover is off (`html-audio-backend.js`: prefetch is default-off). Hidden-page loads were measured at 9–11 s (MP1 §4.1a), and 3 of 5 hidden Chromium loads missed a 10 s deadline. Rendered narration adds a file seam per line. | Measure in A-05. Stopgap if bad: A-15. Real fix: A-40. |
| TTS narration quirks (#117 steps 2–3) | Unknown, low priority | `ForayTtsPlugin` speaks with `QUEUE_FLUSH`, no `AudioAttributes` and no focus. Pause is emulated as stop-and-restart. Round-3 mobile-native-2/3/5/8 are fixed in code. Now only the fallback path. | Device pass runs #117 steps 2–3; A-05 covers the airplane-mode fallback; A-10 deletes Kokoro. |

---

## 4. Android-only risks

| Risk | Status | Evidence | Card |
|---|---|---|---|
| Hardware Back on Home exits the app and kills playback | **Likely broken** | `app.js` `bindHardwareBack` calls `app.exitApp()` whenever `handleBack()` returns `"exit"`. The activity finishes, and `ForayAudioPlugin.handleOnDestroy` calls `stopServiceQuietly()`. Podcast apps minimize instead. `@capacitor/app` `minimizeApp` is available, and nothing calls it. | A-07 (S) |
| Headphones unplugged / car Bluetooth drops: audio continues from the speaker | **Likely broken** | No `ACTION_AUDIO_BECOMING_NOISY` receiver anywhere in `mobile/plugins`. The player's route-loss pause (`queue-manager.js` `routeChanged`) is reached only from the iOS `old-device-gone` event. | A-08 (S) |
| Diagnostics cannot explain an Android stop | **Broken** | `ForayAudio.state()` returns only running/platform/session/notification fields. There are no focus, route, noisy, trim-memory or FGS-refusal rows. | A-09 (M) |
| Audio focus under the Android 15+ rule (target 36) | Unknown | An app targeting 35+ cannot take focus unless it is the top app or runs a foreground service. The service is up while a Foray is loaded, so a WebView request should be allowed. The emulator smoke uses API 34, so the rule has never run even on an emulator. | A-05, A-06, A-12 |
| Doze, cached-app freezer, OEM battery killers (Samsung, Xiaomi) | Unknown | A `mediaPlayback` FGS with no timeout should hold. That keeping the app out of the freezer holds is itself only an inference (`PlaybackKeepAliveService` header). OEM managers cannot be tested on an emulator. | A-05 (Doze), device pass, D-A5 (Samsung) |
| Edge-to-edge at targetSdk 36 (status bar / gesture bar overlap) | Unknown | The page relies on `env(safe-area-inset-*)`. `@capacitor/status-bar` is installed but unused, and there is no SystemBars config. Whether insets are non-zero depends on the WebView version. | A-04 screenshot, A-11 |
| Notification permission denied (Android 13+) | Works (inferred) | `POST_NOTIFICATIONS` is requested once after the first play. MediaStyle notifications with a session token are exempt, so controls should still appear if permission is denied. | Device pass: deny the prompt, check the controls. |
| WebView autoplay / timers | Works (inferred) | Capacitor 8.5.0 sets `setMediaPlaybackRequiresUserGesture(false)`. Nothing sets `KeepRunning=false` (which would call `pauseTimers`). | None. Keep the trap documented. |
| Capacitor template drift | Works (guarded) | The platform tree is regenerated on every build. Manifest checks in `android-build.yml` and `android-release.yml` catch service or permission loss. | None. |
| 86 MB Kokoro model in every Play upload | Known | Injected by `android-build.yml` and `android-bundle/action.yml`. Only a probe uses it. | A-10 |
| JS player loses its only real-world tester | **Structural** | iOS episodes (M1) and Forays (M2) are native, so the founder's iPhone no longer exercises `HtmlAudioBackend`/`queue-manager` on hardware. | A-04/A-05 become the JS lane's real-world proxy. Keep the JS parity suites required. |

---

## 5. The plan, as cards

### 5.1 Shape

- **Track A0: make today's Android testable and fix the cheap bugs.** No native engine. It starts now and does not
  touch iOS files, so it runs in parallel with iOS M2/M3. Its automated emulator job is the core deliverable: it
  makes Android bugs surface without a human.
- **Track A1: native episodes on Media3.** This mirrors iOS M1: a pure-JVM port of `ForayEngineCore`'s episode
  subset, held to the same parity fixtures, under a Media3 `MediaSessionService` shell. **It starts after the iOS
  M2 car test (G-4) passes**, so the port targets a core that has stopped changing shape.
- **Track A2: native Forays.** This mirrors iOS M2: tape, out-points, rendered narration files, the TTS fallback
  seam, and interludes. It starts after A1 and narration Phase 4.
- **Track A3: Android Auto.** Last, and only when store launch returns to scope.

Rough agent time at this repo's observed pace: A0 ≈ 2 weeks, A1 ≈ 2–3 weeks, A2 ≈ 1–2 weeks, A3 ≈ 1 week. iOS
M1 and M2 landed within about a week of their plan, and the fixtures make a port much cheaper than the original
design work was.

### 5.2 Card conventions

These are the same as `docs/native-engine-plan.md` §12, adapted:
- Size: **S** ≤ ½ day, **M** ≤ 2 days, **L** ≤ 5 days.
- Branch `t_<card>/<slug>`, and a `STATE.md` entry per PR.
- Every card states the ask, what it depends on, a **measured** acceptance test, and a device check.
- **Workflow cards touch `.github/`, a governed path**, so `path-policy` blocks them until the orchestrator applies
  `founder-approved` under the standing approval. Agents never self-apply it.
- The emulator jobs stay **advisory, not required**, and are named so `protect-main` cannot pick them up by
  accident. There is no `schedule` and no `push` trigger (the repo's stated infrequency rule; see the
  `android-release.yml` header). The trigger is PR paths plus `workflow_dispatch`.
- No third-party actions, including `reactivecircus/android-emulator-runner`. Reuse the hand-rolled steps.
- Every Android claim is marked **CI-executed** (job, run id, head SHA), **device-observed** (who, build, Copy
  paste), or **not executed**.
- Java/Kotlin cards are Robolectric-first. No Gradle runs on Windows unless the local toolchain is proven for that
  card.
- A1/A2 cards that touch `player/**` shared paths merge behind an off-by-default flag until the flip card.

### 5.3 Track A0: testable Android, no native engine

#### A-01 · Tracking repair: file the Android device pass, close stale items — **S**
- **Depends on:** none.
- **Ask:**
  - File a new HUMAN-ACTIONS item, "Android device pass (Joey's Pixel)", that replaces the Android half of #11.
    Link the script from A-14.
  - Close #18 (CSP vs. the bridge), citing run 36203157867 (`hasCapacitor: true`, `platform: android`).
  - Close #12 as superseded by this plan.
  - Fix the `docs/android-release.md` line that says "#11 … stays open".
  - Add an Android row to `docs/roadmap/README.md` pointing here.
  - Use the repo's HUMAN-ACTIONS tooling, not hand edits, if the file is generated.
- **Acceptance:** HUMAN-ACTIONS lints clean. `grep -n "#11" docs/android-release.md` points at the new item. #18
  and #12 are in HUMAN-ACTIONS-DONE with reasons.
- **Device check:** none.
- **Status (2026-09-29): done.** Filed as HUMAN-ACTIONS #127, marked not issued until after A-42 (D-A3). #18 closed
  (done, run 36203157867) and #12 closed (skip, superseded) in HUMAN-ACTIONS-DONE. #127 already names the A-14 script path, `docs/android-device-pass.md`.

#### A-02 · Emulator launch smoke on every player/app PR — **S**
- **Depends on:** none (governed path).
- **Ask:** Run `android-smoke` on `android-build.yml`'s path set (`mobile/**`, `tools/mobile/**`, `player/**`,
  `app.js`, `index.html`) as well as its current four paths. Either add the paths to `android-release.yml`'s
  `pull_request` filter, or extract the emulator steps into a reusable workflow or composite action under
  `.github/` that both call. Keep it advisory. Update `tools/mobile/android-workflow.test.mjs` to pin the new
  trigger set and the "never uploads" rule.
- **Acceptance:** A PR that touches only `player/` shows the smoke job running and green (run id on the head SHA).
  A deliberately broken `app.js` in a throwaway branch makes it fail on `#view` (cite the run, then delete the
  branch). The node workflow tests pass.
- **Device check:** none.

#### A-03 · Spike: can the CI emulator play audio at all? — **S**
- **Depends on:** A-02.
- **Ask:** The job boots with `-no-audio`. Measure whether `<audio>.currentTime` advances on a bundled clip with
  `-no-audio`, then with `-audio none`, then with the default backend. Record `dumpsys audio` for each. Pick the
  cheapest flag under which position advances and `dumpsys media_session` reports PLAYING. Record the results in
  `docs/android-emulator-measurements.md` (new).
- **Acceptance:** A table of the three flags × {currentTime advances, media_session state, audio focus stack
  entry}, with run ids. A chosen flag.
- **Device check:** none.
- **Status (2026-09-29): done.** All three flags play: `currentTime` advances about 10 s in 10 s, Media3 reports
  PLAYING, and WebView takes `AUDIOFOCUS_GAIN` (run 36539778610, two attempts, throwaway PR #880). **Chosen flag:
  `-no-audio`**, the one the smoke job already passes, so A-04 needs no flag change. `-audio none` is the same QEMU
  flag, and the default backend only adds a PulseAudio init failure. Table and evidence:
  `docs/android-emulator-measurements.md` §1–§4.

#### A-04 · `android-playback` scenario job, part 1: play, background, controls — **M**
- **Depends on:** A-03.
- **Ask:**
  - Add a job (in `android-release.yml`, or a new advisory `android-playback.yml`) that reuses the smoke boot and
    extends `tools/mobile/webview-probe.mjs` into a small scenario runner over CDP and adb.
  - Serve the committed click-track fixtures to the app over `adb reverse`.
  - Scenarios, each a separate named step with a JSON verdict:
    - (a) Play a bundled clip. `currentTime` advances by at least 3 s over 5 s. `dumpsys activity services
      ai.jwlabs.foura` shows `foregroundServiceType=mediaPlayback`. `dumpsys media_session` shows state PLAYING
      with title and artist from our payload. `navigator.mediaSession.forayPolyfill === true`.
    - (b) `input keyevent KEYCODE_HOME`, then `KEYCODE_SLEEP`. Position still advances 60 s later, and the pid is
      unchanged.
    - (c) `cmd media_session dispatch pause|play|next|previous` and `KEYCODE_MEDIA_*` each reach the page
      (compare page state before and after).
    - (d) `cmd statusbar expand-notifications`, then `uiautomator dump`. Assert the notification has title, show
      and the 15/30 buttons. Tap pause via `input tap` and assert the page paused.
    - (e) A first-launch screenshot, uploaded as an artifact (edge-to-edge evidence).
  - Upload `logcat -s Capacitor ForayAudio chromium`, the dumpsys outputs and the page's diagnostics Copy as
    artifacts.
- **Acceptance:** The job is green on its PR with every scenario's verdict printed. One mutation (break the
  service start in a throwaway branch) turns (a) red. The job takes ≤ 12 min.
- **Device check:** none. This is the no-human proxy.
- **Status (2026-09-29): built, PR #885.** `android-playback.yml` + `tools/mobile/android-playback.mjs`. Green
  run 36551857323 (8 min 08 s). The mutation run 36551980831 (throwaway PR #886) turned (a) red. The job found
  two product defects, now expected-fail in the runner: **A04-F1**, where a remote play or previous with the app
  in the background never plays, and **A04-F2**, where the system media controls show no 15/30. The click tracks
  ship in the CI-built debug APK, not over `adb reverse`, because the CSP and cleartext rules forbid that route.
  Evidence: `docs/android-emulator-measurements.md` §5.

#### A-05 · `android-playback`, part 2: seams, focus, calls, Doze, kill — **M**
- **Depends on:** A-04.
- **Ask:** Add these scenarios. **Record numbers first, and gate only where noted.**
  - (f) **Hidden seam timing:** a two-file Foray (clip, then rendered-narration `.m4a`, then clip) played with the
    screen off. Read the seam gaps from the diagnostics ring. Record them; do not gate yet.
  - (g) **Doze:** `dumpsys battery unplug`, `dumpsys deviceidle force-idle`, and
    `am set-standby-bucket ai.jwlabs.foura rare`. Playback continues for 5 min; gate.
  - (h) **Audio focus:** read the `dumpsys audio` focus stack while playing, which settles the §6.2 question for
    free. Install a tiny helper APK built in the same job that requests `AUDIOFOCUS_GAIN`, and record whether our
    audio pauses or keeps playing.
  - (i) **Phone call:** `adb emu gsm call`, then accept, then cancel. Record pause and resume.
  - (j) **Process kill:** pause, `KEYCODE_HOME`, `am kill ai.jwlabs.foura`, then `cmd media_session dispatch play`.
    Record which package receives it. `am force-stop` is the negative control.
  - (k) **Airplane-mode narration fallback:** `cmd connectivity airplane-mode enable`, then a rendered line that
    cannot load. Assert the TTS fallback speaks or skips within the deadline.
  - (l) **Back on Home while playing.** This starts red until A-07 merges; mark it expected-fail until then.
- Write the recorded values into `docs/android-emulator-measurements.md`.
- **Acceptance:** Every scenario prints a verdict. (g) is gated. (f), (h), (i) and (j) have recorded values with
  run ids. A follow-up PR converts each recorded value that has a clear pass line into a gate.
- **Device check:** none. The device pass confirms the values the emulator cannot give: audible quality, a real
  call, real Bluetooth.

#### A-06 · API 36 leg for the playback job — **S**
- **Depends on:** A-04.
- **Ask:** Add a matrix leg on an API 36 (or 35) `google_apis` x86_64 image, so the Android 15+ focus and
  edge-to-edge rules run at least on an emulator. It is allowed to be slower. Keep API 34 as the fast leg.
- **Acceptance:** Both legs are green on one run. The differences between them are noted in the measurements doc.
- **Device check:** none.
- **Status (2026-09-29): built, PR #887.** `android-playback.yml` is a two-leg matrix: API 34 (the fast leg,
  8 min 14 s) and API 36 `google_apis` x86_64 (9 min 34 s, a 57 s cold boot). Both legs were green on run
  36559231419. Findings:
  - On API 36 (Android 16, WebView 133), every audio-focus request was granted, including those made in the
    background.
  - A04-F1 and A04-F2 reproduce identically on API 36. A04-F1's background play never requests focus.
  - **Edge to edge:** API 36 has no overlap. **API 34 does:** the status bar is drawn over the page's header,
    with the insets at `0px`. That corrects A-04's reading, and it is what triggers A-11.
  - Evidence: `docs/android-emulator-measurements.md` §6.

#### A-07 · Back on Home minimizes instead of exiting while something is loaded — **S**
- **Depends on:** none (JS only).
- **Ask:** In `app.js` `bindHardwareBack`, when the player has a loaded item (playing or paused), call
  `app.minimizeApp()`. Otherwise keep `exitApp()`. Add cases to `drawer-ownership.test.js` (or the hardware-back
  suite) for loaded, playing and empty.
- **Acceptance:** Node tests green. A-05 scenario (l) turns green: after Back, position still advances and the
  service is still in `dumpsys`.
- **Device check:** in the device pass, press Back on Home while listening, and the audio continues.

#### A-08 · Pause on headphone unplug / Bluetooth loss — **S**
- **Depends on:** none.
- **Ask:** In `PlaybackKeepAliveService`, register an `ACTION_AUDIO_BECOMING_NOISY` receiver while running. On
  receipt, emit the existing `SESSION_EVENT` shape `{kind:"routeChange", reason:"old-device-gone"}` through
  `ForayAudioPlugin`, so the existing `client.js` → `queue-manager.js` `routeChanged` path pauses. Add a Robolectric
  test that sends the broadcast (shell cannot send this protected broadcast, so Robolectric is the only automated
  cover). Add a node test that the page pauses on that event with `platform: android`.
- **Acceptance:** Robolectric and node tests green (CI-executed, run id). The merged-manifest check still passes.
- **Device check:** unplug wired or Bluetooth headphones mid-episode, and playback pauses.

#### A-09 · Android session events for diagnostics — **M**
- **Depends on:** A-08 (the shared emitter).
- **Ask:** Emit `SESSION_EVENT` rows that `player/diagnostic-log.js` already renders:
  - route changes (`AudioDeviceCallback`);
  - becoming-noisy;
  - inferred focus loss and gain (`AudioManager.AudioPlaybackCallback`: our player config becoming inactive while
    the page thinks it plays);
  - foreground and background (`ProcessLifecycleOwner`, or activity callbacks);
  - `onTrimMemory` level;
  - FGS start refusals, with the exception class.

  Extend `state()` with `focusState` and `route`.
- **Acceptance:** Robolectric covers each emitter. A-04/A-05 artifacts show the new rows in the Copy paste for
  scenarios (b), (h), (i) and (j).
- **Device check:** the device-pass Copy paste explains every stop.

#### A-10 · Remove on-device Kokoro and ONNX Runtime from Android — **M**
- **Depends on:** narration Phase 4 of `spark-central-narration-assessment.md` (after the first car listen), as
  already ruled.
- **Ask:** Delete `KokoroOrtProbeEngine.java`, the `onnxruntime-android` dependency, the `kokoroProbe` method, and
  the model-injection steps in `android-build.yml` and `android-bundle/action.yml`. Keep `TextToSpeech` as the
  fallback. Update workflow tests.
- **Acceptance:** The `.aab` shrinks by about 86 MB (quote both sizes from CI). `android-build` is green.
  `kokoroProbe` returns unimplemented or is removed from the web half with a node test.
- **Device check:** narration fallback still speaks in airplane mode (device pass #117 step 3).

#### A-11 · Edge-to-edge inset fallback — **S** (conditional)
- **Depends on:** the A-04 (e) / A-06 screenshots, or the device pass, showing overlap.
- **Ask:** Use `max(env(safe-area-inset-*), var(--safe-area-inset-*))` with Capacitor 8's inset variables, or
  configure SystemBars.
- **Acceptance:** API 36 screenshot with no overlap. The iOS layout is unchanged (screenshot diff in the iOS
  simulator job, if available).
- **Device check:** a screenshot on the Pixel.

#### A-12 · Native audio focus for the JS lane — **M** (conditional)
- **Depends on:** A-05 (h)/(i) or the device pass showing that we play over a call or over another app.
- **Ask:** Request `AUDIOFOCUS_GAIN` with `CONTENT_TYPE_SPEECH` / `USAGE_MEDIA` in the service when the page starts
  playing. Forward loss to the page as `interruptionBegan`, and gain as `interruptionEnded` with `shouldResume`
  (`client.js` `onNativeSession` already handles these). Duck is treated as pause, matching iOS `.spokenAudio`.
- **Acceptance:** A-05 (h) and (i) are gated green. Robolectric tests cover the focus listener.
- **Device check:** a call mid-episode pauses and resumes. Spotify started mid-episode pauses 4a.

#### A-13 · Robolectric smoke tests for foray-tts and foray-vault — **S**
- **Depends on:** none.
- **Ask:**
  - foray-tts: the `onError` and finished paths carry the `utteranceId`.
  - foray-vault: a round-trip; a corrupt file recovers; the file is written to the no-backup dir.
  - Add both modules to `android-build`'s unit-test step.
- **Acceptance:** CI-executed green. Each test fails under a one-line mutation.
- **Device check:** none.

#### A-14 · The Android device-pass script — **S**
- **Depends on:** A-01.
- **Ask:** Write `docs/android-device-pass.md`: a 30-minute, numbered script for Joey's Pixel 10 Pro. It covers:
  - install from the Play opt-in link;
  - `docs/android-lock-screen.md` §8.1 reads via `chrome://inspect`;
  - locked-screen playback across 2 cross-episode seams and one Foray seam, timed;
  - notification and lock-screen buttons;
  - a Bluetooth car or headset: metadata, steering-wheel buttons, and play after a 2 min and a 10 min pause;
  - an incoming call; Spotify takeover; headphone unplug; Back on Home while playing;
  - HUMAN-ACTIONS #117 steps 2–3; deny the notification permission;
  - Delete my data, then relaunch (the vault);
  - the "Largest" font size; a first-launch screenshot.

  Evidence for each: a Developer → Playback diagnostics Copy, plus `adb shell dumpsys media_session` and
  `dumpsys activity services ai.jwlabs.foura` if a PC is at hand. Each step says the expected result, so Joey only
  writes pass or fail and pastes. Add a `docs/field-records/` template for the result.
- **Acceptance:** Reviewed against the scenario list in §3–§4, with every "Device check" line in A0 covered.
- **Device check:** this is the device check.
- **Status (2026-09-29): written, not issued.** `docs/android-device-pass.md` (25 steps, with a coverage table
  against §3–§4 and every A0 device check, plus A-27, A-40 and A-41 for the native build) and the record template
  `docs/field-records/android-device-pass-TEMPLATE.md`. Per D-A3 nobody asks Joey to run it until A-42 has landed;
  HUMAN-ACTIONS #127 is the item that issues it.

#### A-15 · JS-lane hidden-seam stopgap — **M** (conditional, founder decision D-A4)
- **Depends on:** A-05 (f) and/or the device pass measuring seams above 3 s with the screen off.
- **Ask:** Re-enable the two-element prefetch handover for Android only (`html-audio-backend.js` prefetch), or warm
  the next rendered-narration file while the page is still visible. Keep iOS unaffected (the iOS JS lane is only a
  fallback now). Re-measure (f).
- **Acceptance:** (f) seam gaps at p50 ≤ 2 s and p95 ≤ 4 s on the emulator, run ids quoted. JS parity suites
  unchanged.
- **Device check:** the Foray seam timed on the Pixel while locked.

### 5.4 Track A1: native episodes on Media3 (mirrors iOS M1)

Why native at all: bugs "silence at seams", "play goes to Spotify after the app died" and "no Android Auto" have no
fix inside a WebView page. A suspended page cannot answer a media button or pre-buffer the next file. Media3
(Apache-2.0, already a dependency at 1.11.0) gives `ExoPlayer` gapless playlists, `ClippingConfiguration`
out-points, `handleAudioFocus`, `setHandleAudioBecomingNoisy`, `MediaSessionService` with automatic foreground
lifecycle, and playback resumption.

Rejected alternatives:
- **A native deck with the JS brain.** This would be a third architecture, and the brain would still live in a
  page that can be suspended.
- **The Swift SDK for Android, to reuse the core verbatim.** It would put an unproven toolchain into CI.

#### A-20 · Contract gating for Android (JS-only, inert) — **S**
- **Depends on:** none. Can land during A0.
- **Ask:**
  - In `player/engine-contract.js` `decideMode`, allow `platform: "android"` when `engineHello` answers protocol 1.
  - Make `mobile/ENGINE_DEFAULT.json` per-platform, with `android: legacy` until A-31.
  - Add the parity cases.
  - Amend `docs/native-engine-plan.md` §4.1 ("Android never gains them") and §11, and point to this document.
- **Acceptance:** Node and parity suites are green. With no Android `engineHello`, behaviour is byte-identical
  (the existing `not-ios` path becomes `no-method` for Android, and a test pins that it still resolves to `js`).
- **Device check:** none.

#### A-21 · Spike: JVM core module in the generated Capacitor project — **S**
- **Depends on:** A-20.
- **Ask:** Decide between Kotlin and Java 21 (sealed interfaces plus records) for a pure-JVM `foray-engine-core-jvm`
  module under `mobile/plugins/foray-audio/android/`. It must be wired so `cap add android` picks it up, and so it
  unit-tests on the JVM with no Android dependencies. Choose Kotlin if adding the Kotlin Gradle plugin to the
  regenerated project is clean; otherwise Java 21. Record the choice and the loop time.
- **Acceptance:** A trivial type and one test run in `android-build` (run id). The decision and the reason are
  recorded in `STATE.md`.
- **Device check:** none.
- **Status (2026-09-29): done, Java 21.** The module is `mobile/plugins/foray-audio/android/foray-engine-core-jvm/`
  (`java-library`, wired in through its own `package.json` and a `file:` dependency). `android-build` runs
  `:foray-engine-core-jvm:test` in its own step. The run id, the loop time and the reasons Kotlin was not clean are
  in `STATE.md` (A-21 entry).

#### A-22 · JVM parity runner — **M**
- **Depends on:** A-21.
- **Ask:** Build a `ParityRunner` that reads `player/parity/fixtures/**` (the same JSON the Swift runner reads) and
  a `jvm-pending.json` burn-down list. It runs in `android-build`'s unit-test step and fails when a case listed as
  done fails, or when a pending case unexpectedly passes. `record.mjs --check` stays the JS reference.
- **Acceptance:** It runs in seconds in CI, with every case pending except one trivial family. A mutation of one
  fixture value turns it red.
- **Device check:** none.
- **Status (2026-09-29): done.** `ParitySuite` lives in `foray-engine-core-jvm`'s test sources and runs inside
  `:foray-engine-core-jvm:test`. `number-format` (`JSWriter.jsonNumber`, main code) is the one engine family it runs.
  `compare` also runs: it holds the runner's own comparator to `compare.js`. The other 30 recorded families, plus
  `manager-remainder` (named in `unported.json`), are owed whole in `player/parity/jvm-pending.json`, each to the card
  below that ports it. `compare` and `number-format` are listed in its `runs`. A-23 on move their family from
  `families` to `runs` (or split it into ids) in the same change as its runner. `record.mjs --jvm-card` keeps those
  books from the JS side, and `record.mjs --check` holds every recorded family to exactly one of `runs` and `families`. Every android-build run also flips one fixture value in a copy and requires the
  runner to go red. The run id and numbers are in `STATE.md` (A-22 entry).

#### A-23 · Port the pure policies (episode subset) — **L**
- **Depends on:** A-22.
- **Ask:** Port `PlayerQueueState`, `PlaybackRate`, `ResumeRules`, `TransportPolicy`, `SessionPolicy`, the
  `MediaMapping` episode subset, and `Rows`/`JSWriter` (byte-identical rows) from `ForayEngineCore` on
  `engine/m2`. Burn down `jvm-pending.json` for those families.
- **Acceptance:** Those families are 0 pending, with the CI run id. Byte-identical rows are checked against the JS
  writer.
- **Device check:** none.
- **Status (2026-09-29): done in its PR, CI evidence in `STATE.md` (A-23 entry).** Ported into
  `foray-engine-core-jvm` main code (Java 21, API 24 library surface): `PlayerQueueStateMachine` and its state, event
  and effect types, `ItemBounds`, `PlaybackRate`, `ResumeRules`, `TransportPolicy`, `SessionPolicy`, `MediaMapping`
  (whole: the Foray half is the same functions, and the `media` family that pins it stays A-40's), `Rows`,
  `RestoreRecord`, `JSWriter` (`stringify`, `quote`, `isoString`), `JSDate` and an ordered `JsonNode` with
  `JSON.parse`'s rules. `gen-constants.mjs` now also writes `EngineConstants.java` and `Vocabulary.java`, so no number
  is retyped. `queue-state`, `rate`, `resume-rules`, `transport`, `rows`, `session`, `session-invariant` and
  `media-episode` moved from `families` to `runs` in `jvm-pending.json` (698 cases, all passing). `session-invariant`
  was owed to A-24; its function lives beside the session table, so it came along, and A-24 no longer owes it. The
  `rows` family compares each row as a STRING, and a JUnit test proves it: the recorded row with two members swapped
  (the same JSON value in other bytes) fails.

#### A-24 · EngineCore for episodes on the JVM — **L**
- **Depends on:** A-23.
- **Ask:** Port `handle(input) -> [EngineCommand]` for the episode families, with the audible-start invariant (no
  audible start without focus and an active session), so that the `manager-episode` and `deck-episode` families
  pass.
- **Acceptance:** Those families are 0 pending, and the invariant test fails under mutation.
- **Device check:** none.

#### A-25 · ExoPlayer deck adapter behind a DeckDriving seam — **L**
- **Depends on:** A-24.
- **Ask:** Build an ExoPlayer-backed deck with readiness-gated preroll, position observation, rate, and a load
  deadline, `setWakeMode(C.WAKE_MODE_NETWORK)`. Test it with `media3-test-utils-robolectric` (`TestExoPlayerBuilder`,
  `FakeClock`, `TestPlayerRunHelper`) on the click-track fixtures: in-point accuracy, out-point never early, stall
  → buffering.
- **Acceptance:** Robolectric green in CI. In-point and out-point error are reported in the measurements doc.
- **Device check:** none.

#### A-26 · `ForayPlaybackService` (MediaSessionService) shell — **L**
- **Depends on:** A-25.
- **Ask:**
  - A `MediaSessionService` whose session player is a `SimpleBasePlayer` facade over the core snapshot. Reuse the
    `WebViewPlayer` pattern.
  - `DefaultMediaNotificationProvider` with the 15/30 custom layout.
  - `setAudioAttributes(CONTENT_TYPE_SPEECH, USAGE_MEDIA, handleAudioFocus=true)`, so a duck becomes
    pause-and-resume.
  - `setHandleAudioBecomingNoisy(true)`.
  - Media buttons delivered as `EngineInput.remote`.
  - In native mode it replaces `PlaybackKeepAliveService`. The legacy service stays for the JS lane.
- **Acceptance:** Robolectric covers the session commands and the focus mapping. A-04/A-05 scenarios run in a
  native-mode leg, which must be green on (a)–(d), (g), (h) and (i).
- **Device check:** none until A-31.

#### A-27 · Store, restore record, playback resumption, MediaButtonReceiver — **M**
- **Depends on:** A-26.
- **Ask:** Implement `EngineStore` rows (the SharedPreferences/file equivalent of iOS NE-19), a restore record,
  Media3 `onPlaybackResumption` from that record, and a `MediaButtonReceiver`, so that a head-unit PLAY after
  process death resumes 4a. This mirrors iOS NE-24's cold path.
- **Acceptance:** A-05 (j) in native mode: after `am kill`, dispatching `play` resumes 4a at the saved position.
  Gated.
- **Device check:** Bluetooth car play after swiping the app away.

#### A-28 · Android bridge and page client — **M**
- **Depends on:** A-26.
- **Ask:** Add `engineHello`, `engineSend` and `engineRead` on `ForayAudioPlugin` (Android), speaking protocol v1,
  with coalesced events. Enable the page's native branch for `platform: "android"` behind the A-20 flag, reusing
  the iOS client, facades and relinquish path.
- **Acceptance:** Node tests for the Android handshake. The emulator native leg logs `engine mode native` in the
  Copy paste.
- **Device check:** none until A-31.

#### A-29 · Ownership and fallback (a subset of NE-17) — **M**
- **Depends on:** A-28.
- **Ask:** Implement `decideOnce`, sticky legacy after sentinel strikes, the hello watchdog, and terminal
  relinquish, so that a broken native engine falls back to the JS lane rather than to silence.
- **Acceptance:** Parity families for ownership are green on the JVM. An emulator mutation (engine throws at
  hello) falls back to `js` with a diagnostics row.
- **Device check:** none.

#### A-30 · Native-mode emulator scenarios green — **S**
- **Depends on:** A-27, A-29.
- **Ask:** Make the native leg of A-04/A-05 required-green on (a)–(e) and (g)–(k). Record the seam numbers for
  episodes.
- **Acceptance:** One run id with every native-mode verdict green.
- **Device check:** none.

#### A-31 · A1 flip: native default for Android episodes — **S**
- **Depends on:** A-30, the Joey device pass on the native build, and one founder Android car drive (D-A5).
- **Ask:** `ENGINE_DEFAULT.json` `android: native` for episodes. The DECISIONS entry goes in a separate PR (the G-7
  rule).
- **Acceptance:** The device-pass record in `docs/field-records/` is green on H-1 (pause and resume from the car),
  H-3 (call), navigation prompts, and the negative control.
- **Device check:** Joey's pass plus the car drive.

### 5.5 Track A2: native Forays (mirrors iOS M2)

#### A-40 · Foray tape: deck pair or clipped playlist, out-points, background seams — **L**
- **Depends on:** A-31, and the iOS M2 families being stable.
- **Ask:** Port `EngineCore` for Forays: `playForay`, in-points, the gate, seams, and Foray transport. Play it
  through an ExoPlayer playlist of `MediaItem`s with `ClippingConfiguration` (gapless), or a two-deck pair,
  whichever passes the never-early out-point tests. Port SeamGap, Interlude, SeekPolicy and ForayClock.
- **Acceptance:** The Foray parity families are 0 pending on the JVM. A-05 (f) in native mode shows p95 seam
  ≤ 1 s with the screen off.
- **Device check:** a locked Foray on the Pixel with timed seams.

#### A-41 · Rendered narration files, TTS fallback seam, interludes — **L**
- **Depends on:** A-40, narration Phase 4.
- **Ask:** Rendered narration plays as ordinary files. `TextToSpeech` becomes a seam behind the engine, used only
  when a file is missing. Add interludes and jingles.
- **Acceptance:** The narration, interlude and tts-bridge parity families are green. A-05 (k) is green in native
  mode.
- **Device check:** airplane-mode fallback on the Pixel.

#### A-42 · A2 flip: native Forays on Android — **S**
- **Depends on:** A-41, a device pass, and a founder car drive.
- **Ask and acceptance:** The same shape as A-31, for Forays.

### 5.6 Track A3: Android Auto (only when store launch returns to scope)

#### A-50 · MediaLibraryService browse tree — **M**
- **Depends on:** A-31 (the same service).
- **Ask:**
  - Promote `ForayPlaybackService` to a `MediaLibraryService` with a small tree: Continue listening (the restore
    record), Up Next, and Forays (the bundled directory slice).
  - Add `automotive_app_desc.xml` (`<uses name="media"/>`), the `com.google.android.gms.car.application`
    meta-data, and a tintable attribution icon.
  - Add an instrumented test that walks the tree with a `MediaBrowser` on the emulator.
- **Acceptance:** The instrumented walk is green in the emulator job. The Car app quality items MA-1 (no
  autoplay) and DR-1..3 (responsiveness) are self-checked.
- **Device check:** the Media Controller Test app plus the DHU on a PC with a physical phone, then a real car.

#### A-51 · Play Android Auto review — **S** (human gate)
- **Depends on:** A-50, and store launch being in scope.
- **Ask:** Submit through Play Console. Google gives Auto apps an extra manual review.

---

## 6. Founder decisions (each has a recommended default; silence = the default)

> **RULED 2026-09-29 (founder, in his words):** "android also needs to move to native engine (or whatever is best). once the plan is done, then start work on that in parallel to bring it up to the same maturity level (sans testing) as the iphone app. joey will be the tester here, he has an android" and then "don't have joey test until the native engine is fully operational." What that settles:
> - **D-A1: yes.** A0 starts now.
> - **D-A2: yes, and NOT gated on the iOS M2 car test.** A1 and A2 start now, in parallel with iOS M2/M3, aiming at the iPhone app's maturity. Porting while the iOS core still moves is accepted; parity fixtures keep the two honest.
> - **D-A3: Joey's Pixel is the device of record, but no device passes until the Android native engine is fully operational** (after A-42). Until then A-14 is written but not issued, and H-1/H-2 wait. CI emulator scenarios are the only Android testing.
> - **D-A4:** decide on emulator measurements alone (p95 > 4 s ⇒ ship A-15), not device measurements.
> - **D-A5, D-A6: not now** (no spend approved).
> - **D-A7: defer** (A3 last). The iPhone app has no CarPlay app either, so parity does not need Android Auto.
> - **D-A8: default** (A-10 lands with narration Phase 4).

| # | Decision | Recommended default | Why |
|---|---|---|---|
| **D-A1** | Start Track A0 now, emulator tests first, in parallel with iOS M2/M3? | **Yes.** | It touches no iOS files. It is the cheapest way to make Android bugs surface without a human, and it gives the JS lane a real-world proxy now that the iPhone no longer exercises it. |
| **D-A2** | Build a native Android engine (Media3/ExoPlayer, same contract and fixtures as iOS)? | **Yes, but start A1 only after the iOS M2 car test (G-4) passes.** A0's measurements can bring it forward: if seams or car play are clearly broken on the Pixel, start A1 the day G-4 passes rather than waiting for M3. | Three of the biggest risks (screen-off seams, car play after the app dies, Android Auto) cannot be fixed inside a WebView. Waiting for the iOS core to stop moving makes the port a translation, not a chase. |
| **D-A3** | Who owns the Android device of record? | **Joey's Pixel 10 Pro, now.** He runs the device pass per milestone (A-14). Before the A1 flip, **buy one Samsung Galaxy A-series for your car** (D-A5). | You only have an iPhone. Joey already has a Pixel and is on the tailnet. |
| **D-A4** | If A0 measures bad screen-off seams on Android, ship the JS-lane stopgap (A-15) or wait for A2? | **Ship A-15 if p95 > 4 s**, because rendered narration multiplies seams. Otherwise wait for A2. | A-15 is about M effort, and it covers the gap until A2. |
| **D-A5** | Buy an Android phone for the founder's car loop? *(cost)* | **Yes, at A1 start: a Samsung Galaxy A-series, about $150–250** (approximate, not checked). | Samsung is the most common and the harshest OEM for battery killing. It gives you an Android Bluetooth and Android Auto car loop without relying on Joey's schedule. The Pixel plus the Samsung covers stock Android and the worst OEM. |
| **D-A6** | Firebase Test Lab (real OEM phones in the cloud)? *(possible cost)* | **Not now.** Revisit after A1 has instrumented tests worth running. | The free Spark plan (10 virtual / 5 physical runs a day) is enough later, but it adds a Firebase service-account secret, which adds to the exposure until HUMAN-ACTIONS #115 is done. |
| **D-A7** | Android Auto? | **Defer to store-launch scope (A3 last).** | It triggers Play's car review. Plain Bluetooth plus steering-wheel buttons covers your car use first. |
| **D-A8** | Remove on-device Kokoro from Android ahead of narration Phase 4? | **No. Keep the ruled order** (A-10 lands with Phase 4). | The narration assessment is already ruled. The 86 MB only costs download size on an internal track. |

Routed to agents, not the founder: Kotlin vs. Java (A-21 spike), emulator flags (A-03), and which A-05 values
become gates.

---

## 7. Human actions

| # | Who | What | Time | Cost | Blocks |
|---|---|---|---|---|---|
| H-1 | Founder | **HUMAN-ACTIONS #44:** Play Console → 4a → Release → Testing → Internal testing → Testers. Add your Google account and Joey's, copy the opt-in link, and send it to Joey. | ~5 min | $0 | Every device check in this plan. |
| H-2 | Joey | Install build 2026092802 (or later) from the opt-in link on the Pixel 10 Pro, and run the A-14 device pass. Paste the Copy output into the field-record template. Until A-14 lands, run `docs/android-lock-screen.md` §8.1 plus HUMAN-ACTIONS #117 steps 2–3. | ~30 min per milestone | $0 | A-11, A-12, A-15 decisions; A-31 and A-42 flips. |
| H-3 | Founder | **Cost item:** buy a Samsung Galaxy A-series and do one Android car drive per flip (A-31, A-42). | 1 drive per flip | **~$150–250** (approximate, not checked) | A-31 and A-42 flips. Not needed before A1. |
| H-4 | Founder (optional, later) | **Possible cost item:** create a Firebase project and a Test Lab service-account secret. | ~20 min | $0 within the Spark quota; Blaze is $1/h virtual, $5/h physical | Nothing in A0/A1. |
| H-5 | Founder (store scope only) | Submit to Play's Android Auto review (A-51). | — | $0 | A3 only. |
| — | Orchestrator | Apply `founder-approved` to the governed-path PRs (A-02, A-04, A-05, A-06, A-10) under the standing approval, after verifying them. Agents never self-apply it. | — | — | Those PRs' merge. |

HUMAN-ACTIONS #18 and #12 needed nothing from you. A-01 closed them, and filed the Android device pass as #127 (not issued until after A-42).

---

## 8. What only a human can test

These are out of reach of CI and the emulator:
- real Bluetooth/AVRCP and head units, including the car's "which app gets play on connect" policy;
- OEM battery managers (Samsung, Xiaomi) and an hour of real Doze;
- whether audio is audible, and whether it glitches;
- real phone calls and navigation prompts from Google Maps;
- network handoffs in a moving car;
- the Android Auto UI (the DHU needs a physical phone).

`AUDIO_BECOMING_NOISY` is a protected broadcast. Only Robolectric (A-08) and a real unplug can exercise it.

---

## 9. Sources

In the repo:
- `docs/android-native-code.md`, `docs/android-lock-screen.md`, `docs/android-release.md`, `docs/android-shell-build.md`
- `docs/native-engine-plan.md`, `docs/research/mp1-background-audio.md`, `docs/plans/spark-central-narration-assessment.md`
- `docs/audit/round-3-code/synthesis.md`, `docs/audit/qa-synthesis.md`, `docs/field-records/2026-09-24-car-baseline.md`
- `.github/workflows/android-build.yml`, `.github/workflows/android-release.yml`, `.github/workflows/release.yml`,
  `.github/actions/android-bundle/action.yml`
- `mobile/plugins/foray-audio/android/**`, `mobile/plugins/foray-tts/android/**`, `mobile/plugins/foray-vault/android/**`
- `player/engine-contract.js`, `player/html-audio-backend.js`, `app.js` (`bindHardwareBack`)
- `HUMAN-ACTIONS.md` #12, #18, #44, #115, #117; `HUMAN-ACTIONS-DONE.md` #11

CI runs: 36511470103 (android-build), 36203157867 (android-smoke), 36498488084 (release, build 2026092802).

External:
- [Media3 background playback](https://developer.android.com/media/media3/session/background-playback)
- [Media buttons](https://developer.android.com/media/media3/session/control-playback)
- [Audio focus (including the Android 15 rule)](https://developer.android.com/media/optimize/audio-focus)
- Android Auto: [overview](https://developer.android.com/training/cars/media), [Auto](https://developer.android.com/training/cars/media/auto), [manifest](https://developer.android.com/training/cars/media/configure-manifest)
- [Car app quality](https://developer.android.com/docs/quality-guidelines/car-app-quality)
- [DHU](https://developer.android.com/training/cars/testing/dhu)
- [Media Controller Test app](https://developer.android.com/media/optimize/mct)
- [media3 test-utils-robolectric](https://developer.android.com/reference/kotlin/androidx/media3/test/utils/robolectric/package-summary)
- [KVM on GitHub-hosted runners](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)
- [Firebase Test Lab pricing](https://firebase.google.com/docs/test-lab/usage-quotas-pricing)
