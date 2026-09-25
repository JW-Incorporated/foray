# M2 drive test — the script (G-4)

The founder's test of milestone M2 of `docs/native-engine-plan.md` (§7 M2, §10;
card NE-37): **Forays play natively on iOS**. The clips, the narration between
them and the seam jingle all come from the app's own player, so a Foray keeps
playing with the screen off and the car shows what is playing.

It is judged against the same **before** record as M1,
`docs/field-records/2026-09-24-car-baseline.md`: a session that is merely held
is not enough. The car goes back to the app whose audio last *played*, so the
session the Foray played through must be the one that is held.

This file is the script. HUMAN-ACTIONS #119 (filed by NE-37) asks for the drive
and links here. It names **the next TestFlight build after `engine/m2` merges**
into `main`, and that build's number is added to the card once the build exists.

## Before it can be run

These are preconditions, not steps for the founder.

1. **The flip (met, NE-37).** `mobile/ENGINE_DEFAULT.json` says
   `{"mode":"native","capabilities":["episode","continuation","restore","foray"]}`,
   and the Swift `EngineBridgeRules.advertisedCapabilities` lists the same four.
   `player/parity/coverage.test.js` refuses both while any family mapped to
   `foray` owes work. NE-37 cleared the last 20 `transport-reconcile` tests
   that `manager-foray` still owed. The shipping boot (`EngineBoot.swift`) turns on the Foray tape
   and the two-deck pair. It leaves the silence node, the direct synthesizer
   and narration at the listener's speed off.
2. **Narration and the jingle are part of `foray`**, not capabilities of their
   own: their families (`speech-rate`, `lexicon`, `default-voice`,
   `interlude`, `manager-foray`'s narration and jingle cases) are charged to
   it in `player/parity/capabilities.json`.
3. A TestFlight build **from `main`** whose `ios-archive --check` log shows
   `ForayEngineDefault=native ForayEngineCapabilities=["episode","continuation","restore","foray"]`.
   Its build number is the one the HUMAN-ACTIONS item names.
4. **For any external TestFlight or App Store submission** of that build, the
   App Review note in `docs/store/app-review-background-audio.md` (written by
   NE-34) goes into App Store Connect → the build → **Test Information** (external
   TestFlight) or **App Review Information → Notes** (App Store). The founder's
   own internal TestFlight install needs no review note.

## Rules for every block

- **Record the route in every block**: CarPlay, the car's Bluetooth, AirPods or
  the speaker.
- **One Copy per block.** At the end of each block, while parked: menu →
  **Developer** → **Playback diagnostics** → **Copy**. Paste every Copy into the
  M2 issue (or HUMAN-ACTIONS #119's thread), one comment per block, each
  headed with the block's number and the route.
- **Every Copy starts with the engine header**:
  `engine=native v<ver> proto=1 caps=episode,continuation,restore,foray reason=<r> strikes=0 hold=<policy> build=<number> | web=<stamp>`.
  If `caps=` has no `foray`, or it says `engine=legacy`, `strikes=` above 0 or
  another build number, stop and send that Copy. Nothing after it measures
  the M2 engine.
- **The escape hatch**: TestFlight → 4a → **Previous Builds** installs the last
  build, and Developer → **Playback engine: Web** puts Forays back on the old
  player. You do not need Claude for either.

## Step 0 — at home, 2 minutes

1. TestFlight → 4a → turn **Automatic Updates off**.
2. Open 4a, then **Developer** → **Playback diagnostics** → **Copy**. Check the
   header against the rule above. Paste it as the header block.

## Desk pre-flight — 10 minutes, before the car

1. Open a Foray whose first item is **narration**, and press Play. The line is
   spoken, then the first clip plays. Lock the phone. The lock screen shows the
   Foray's title and the clip or the line, **never "4a" or "Unknown"**, both
   while the line is spoken and while a clip plays.
2. **DV-9 re-check.** Still locked, let one line finish into a clip. The clip is
   heard (the session is still usable after the synthesizer). The Copy shows a
   narration row followed by the clip's `seam` row.
3. **H5 at the desk.** Pause from the lock screen in the middle of a spoken
   sentence. Wait 10 seconds. Play. The sentence continues from where it
   stopped. It does not start again or skip to the next clip.
4. Pause during a clip, then play again: the clip continues. Press the lock
   screen's next: the next clip starts at its own beginning.
5. Copy. Paste it as the pre-flight block.

## In the car (G-4)

Each block ends with one Copy, taken while parked.

0. **Connect (the baseline's test 1, with a Foray).** Before you get in, play a
   Foray on the phone, pause it **in the app**, and lock the phone. Start the
   car. When it connects, press the car's play if nothing starts by itself.
   Expected: **the Foray**, in 4a, where you paused it. Copy.
1. **H-2, the long screen-off Foray drive.** Start a Foray of **about 50
   minutes or more** (the longest one in the app) through the car. Lock the
   phone and do not touch it for **51 minutes**, or until the Foray ends. Every
   seam is heard: a short gap, or the jingle between two shows, then the next
   clip. Note any seam that stalled or went silent, with the rough time. Copy.
2. **H5 locked, in the car.** During a spoken line, pause **from the car's
   controls** in the middle of a sentence. Wait 30 seconds. Press play: the
   sentence continues mid-sentence. Do the same during a clip. Copy.
3. **H6, what the car shows.** Through one clip, then one narration line, then
   a pause: the car's screen and the lock screen show the Foray and the clip or
   line, **never "4a" or "Unknown"**. At the seam from a narration line into a
   clip, the title and artwork stay filled in. They never go blank. Copy.
4. **Paused for a long time.** Pause the Foray from the car. Wait **10
   minutes**. Press the car's play: 4a resumes the Foray and keeps playing
   through the next seam. Copy.
5. **Negative control.** Pause the Foray, play **Spotify for 10 seconds**,
   pause Spotify, press the car's play. Expected: **Spotify**. This is correct:
   the car goes to the app that played last. Copy.

## How it is judged

`node tools/mobile/engine-report.mjs <paste> --build <number>` over each Copy.
M2 exits (G-4) when the report shows:

- **H-2 complete**: no `stop cause=unknown`; seam 1 through the last seam
  present, not `incomplete`, so the ring kept them all; and the seam
  distribution (p50/p95 gap, prepared rate, grace coverage) on the LTE route of
  the drive;
- **DV-4**: out-points never stopped early;
- **DV-5**: precise loads beat the deadline on real CDNs;
- **DV-9**: the re-check rows from the desk pre-flight;
- **DV-10 / H6**: no Now Playing row with `4a` or `Unknown`;
- narration resumed mid-sentence (blocks 2 and pre-flight 3), and block 0
  played the Foray, not Spotify.

The seam numbers feed NE-38 (the load deadline, stall display and precise
timing from the field). The silence node stays off unless the H-2 rows show a
suspension during a seam (plan §14 NE-34).
