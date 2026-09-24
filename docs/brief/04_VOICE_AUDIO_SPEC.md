# VOICE & AUDIO SPEC (iOS)

Audio correctness is the product. A janky transition or a lost playback position after a phone call will make me stop using it faster than a bad recommendation will. Prototype the audio session choreography (a bare screen with two buttons) **before** building real UI.

## Audio engine

- **Custom PlayerQueueManager over AVPlayer.** Not AVQueuePlayer: we need per-item start offsets (resume mid-episode), per-show playback rate, dynamic queue mutation (voice command inserts/skips), and TTS items interleaved with episodes. Formal state machine: `idle → loadingItem → playing → transitioning → interrupted → ended`, with unit tests for every edge (see corner cases).
- AVAudioSession: category `.playback`, mode `.spokenAudio` (enables OS-level smart handling for speech content), activate on play. Handle `AVAudioSession.interruptionNotification` (save position on `.began`; on `.ended` resume only if `shouldResume` option present) and `routeChangeNotification` (old-device-unavailable → pause immediately: Bluetooth drop = I turned the car off; on reconnect within N minutes, auto-resume is desirable — make it a setting, default on for car BT routes only).
- **Everything local before play**: session assets pre-downloaded; the player should essentially never stream. If a file is missing (eviction bug, partial download), degrade: stream if network exists, else drop the item with an earcon and advance.
- Position persistence: every 15 s and on every pause/interruption/route-change/skip, write position locally; sync to backend in the event batch. Restore exactly on relaunch.
- Lock screen / control center: MPNowPlayingInfoCenter fully populated per item (including TTS items: title = "Up next: <episode>"); MPRemoteCommandCenter: play/pause, ±30/15 s seek, **nextTrack = next queue item**, **prevTrack = restart item / previous**. These map to steering-wheel and headphone controls in every car — this is the baseline hands-free interface and must be flawless before any voice work.
- Transitions: hard cuts are fine; add ~0.5 s of silence padding around TTS items. An unbridged seam (two segments with no narration between them) gets the same 0.5 s of silence — one number for the silence at a seam, founder ruling 2026-09-24 (`docs/DECISIONS.md`; `player/seam-gap.js` `SEAM_GAP_SEC`; `docs/curation/segment-length-rules.md` §6b). Normalize TTS loudness server-side; additionally apply a per-episode playback gain nudge if an episode is obviously quiet (nice-to-have; note in backlog).

## Spoken intros/transitions

- Session start (first pick): intro TTS plays before episode audio: why picked + what it is + duration ("Forty minutes, so it'll just about fill the drive"). ≤ 15 s.
- Between items: transition TTS ≤ 8 s: close the last item, bridge to the next.
- **Verbosity control**: settings = full / brief / off. Auto-brief rule: after I've heard N intros for the same show, drop the show-explainer part. Never intro the Continue card with more than "picking back up where you left off."
- No spoilers: narrative-format episodes get topic-shaped intros, not content summaries.
- Missing TTS asset fallback: AVSpeechSynthesizer reads the why-line. Must sound obviously OK, not obviously broken.

## Voice input

Two paths, both mandatory:

### Path A — Hold-to-talk (primary in-app)
- One giant button on Now Playing (and the session picker). Press: duck playback to ~15% (don't pause — pausing/resuming the session for a 2-word command feels heavy), switch session to `.playAndRecord` with `.duckOthers` + `.defaultToSpeaker`/current route, run on-device `SFSpeechRecognizer` (requiresOnDeviceRecognition = true; we need it offline and low-latency). Release: finalize, restore `.playback`, act.
- **Category switching is the #1 glitch risk** (audible pops, route flaps to earpiece, breaking BT audio profiles — HFP vs A2DP: activating record over Bluetooth can degrade *playback* quality to phone-call quality while recording). Prototype and test in the actual car early. If BT record quality is unusable, fall back to the iPhone's mic while keeping playback on BT — verify this specific combination works.
- Feed `contextualStrings` to the recognizer: show names, host names, taxonomy terms ("fusion," "Rogan") — dramatically improves recognition of the words that matter.

### Path B — Siri App Intents (primary while driving)
- Expose App Intents: skip / pause / resume / something different / more like this / save this / what is this / play option N. "Hey Siri, skip this" is the only true hands-free path on iOS — treat it as first-class, not a bonus. Test with Siri over CarPlay/BT.

### Intent handling (both paths converge)
- **Tier 1 — local grammar** (regex/keyword, offline, <300 ms): skip, pause/resume, next/back, option 1–4 by ordinal or by keyword from card titles ("play the fusion one" → fuzzy match card titles/topics), more-like-this, something-different, save, what-is-this (answers by playing/speaking the why-line + episode title), thumbs up/down, faster/slower.
- **Tier 2 — backend LLM**: anything Tier 1 can't parse posts the transcript to `/voice/intent` → Claude → structured intent JSON (validate against schema; unknown → spoken "didn't catch that" + earcon). Free-text taste feedback ("less election stuff, more materials science") lands here and mutates the taxonomy per the curation spec.
- **Confirmations are earcons, not sentences.** One short sound = understood/done; a different one = not understood. Spoken responses only when the command asks a question ("what is this?") or the action is destructive ("never play this show again — say yes to confirm").
- Offline + Tier-2-needed utterance: store it, earcon "saved," process on reconnect.

## Latency budgets (hold yourself to these)
- Tier-1 voice command → audible effect: **< 1.0 s** end-to-end.
- Tap card → audio starts: **< 1.5 s** (asset is local; this is achievable).
- Skip → next item audible: **< 1.0 s**.

## Safety framing
Every playing-state action available by voice or steering wheel. The screen is for parked moments: picking with taps, browsing history, editing interests. If a feature can't be made eyes-free, it doesn't run while playback is active in a moving context — don't build interaction patterns that tempt glancing.
