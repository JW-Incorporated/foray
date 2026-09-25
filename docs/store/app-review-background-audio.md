# App Review note: what 4a's background audio mode plays

**For NE-37** (docs/native-engine-plan.md §14): paste the note below into the App Review Information "Notes" field of any external TestFlight or App Store submission once the native engine plays Forays (the M2 flip). Written by NE-34, which added the last two sounds the engine can make with the screen locked: the seam jingle and the capped silence node.

Keep it true. If the engine gains a sound, or the silence node's flag or cap changes, change this note in the same PR; `tools/audio/interlude-asset.test.mjs` pins the facts it states against the code.

---

## The note

> 4a is a podcast player. It declares the `audio` background mode (`UIBackgroundModes: audio`) so that a listener can lock the phone, or listen through a car's audio, and keep listening.
>
> With the app in the background it plays only audio the listener started:
>
> 1. **Podcast episodes**, streamed from the publisher's own feed URL, and **Forays**: listener-chosen playlists of clips from those same episodes, played back to back.
> 2. **Spoken narration** between clips of a Foray, synthesized on the device with the system speech synthesizer, or streamed as a recording of the same text.
> 3. **A 3-second interlude jingle** bundled with the app, played between two clips of different podcasts inside a Foray. It is never looped and is always stopped within 4.5 seconds.
>
> Between two clips there can be a short silence while the next clip loads. The app keeps a background task open for that gap and ends it as soon as the next clip is audible. An optional silence renderer (off in this build) can fill that gap with digital silence for at most 4.5 seconds from the end of the previous clip; it never runs unless the listener's playback is running, and it never extends playback on its own. When the listener pauses, nothing plays.
>
> Apart from that optional, capped silence inside a running Foray, the app never plays audio just to keep itself running. It does not play when the listener has not started playback, and it does not record audio.
>
> To try it: open any show, tap an episode's play button, lock the phone. Or open a Foray and tap Play; clips, narration and the jingle continue with the phone locked, and the lock screen shows what is playing.

---

## The facts behind each sentence

| Sentence | Where it is true |
|---|---|
| Jingle is 3 seconds, bundled, never looped | `INTERLUDE_DURATION_SEC` = 3 (`player/interlude.js`); `AVJingle` sets `numberOfLoops = 0` on the bundled copy of `player/assets/interlude-placeholder.wav` (SHA-256 pinned). |
| Jingle stopped within 4.5 s | `INTERLUDE_CEILING_SEC` = 4.5; InterludePlayer's ceiling timer stops it at that span from its start. |
| Between two clips of different podcasts | `Interlude.eligible` (`player/interlude.js`'s rule, ported in NE-28s). |
| Background task during the gap, ended when audible | BackgroundGrace (NE-16g), `seam` / `prepare-miss` spans (NE-30s, NE-34). |
| Silence renderer off, capped at 4.5 s, never without running playback | `EngineConfig.silenceNodeEnabled = false`; SilenceNode clamps to `INTERLUDE_CEILING_SEC`; the core's `Interlude.silenceNodeSec` answers 0 when not running or the session is not active, and the host refuses too. |
| Nothing plays while paused | The audible-start invariant (plan §4.4): every audible command follows an activation for a listener's play. |
