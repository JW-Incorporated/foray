# M1 car test — the script (G-3)

The founder's test of milestone M1 of `docs/native-engine-plan.md` (§7 M1, §10;
card NE-27). It is judged against the **before** record,
`docs/field-records/2026-09-24-car-baseline.md`: on build 2026092429 the app held
an active `.playback` session for 8 minutes and the car still chose Spotify,
because the audio that last *played* came from WebKit's process. M1 passes only
if the engine's own playback session, the one the audio played through, is the
one the car comes back to.

This file is the script. The HUMAN-ACTIONS item that asks for the drive names
**one** TestFlight build number and links here; it is filed only once that build
exists (see "Before it can be run").

## Before it can be run

Each of these is a precondition, not a step for the founder. As of 2026-09-24
none of the first three is met.

1. **The flip.** `mobile/ENGINE_DEFAULT.json` says
   `{"mode":"native","capabilities":["episode","continuation","restore"]}`, and
   the Swift `EngineBridgeRules.advertisedCapabilities` lists the same three.
   Both are refused by `player/parity/coverage.test.js` while any family mapped
   to `episode` owes work: today 42 `transport-reconcile` tests (34
   `manager-episode`, 8 `deck-episode`) are still in
   `player/parity/unported.json`. `tools/mobile/shell-invariants.test.mjs` also
   refuses a native default unless STATE.md carries the dated `OQ-9 answer` line.
2. **The Developer rows** the script uses, in the page's Developer group:
   "Playback engine: Automatic / Native / Web (applies after restart)" (NE-17),
   "Pause hold: forever / none" (NE-16), "Simulate system termination" (NE-24)
   and the session probe (NE-25c). The engine answers all four commands
   (`setModeOverride`, `setHoldPolicy`, `simulateTermination`, `probeSession`),
   and since NE-22d the page offers them, above "Playback diagnostics". Each
   shows the engine's own answer: the setting it stored ("· now" is the lane
   running), the hold policy from its snapshot, and "armed" or why it refused
   for the two one-shot rows. In the web-player lane only "Playback engine"
   is shown; the other three need the native engine running.
3. **G-1b**: `engine-parity` and `ios-gate` required on `main`, and the release
   refusing a non-green `engine-parity`/`ios-kit`.
4. A TestFlight build **from `main`** whose `ios-archive --check` log shows
   `ForayEngineDefault=native` and the patched AppDelegate. Its build number is
   the one the HUMAN-ACTIONS item names.

## Rules for every block

- **Record the route in every block**: CarPlay, the car's Bluetooth, AirPods or
  the speaker. The rows carry the port type; write it down anyway.
- **One Copy per block.** At the end of each block: menu → **Developer** →
  **Playback diagnostics** → **Copy**, then paste it somewhere safe (Notes is
  fine) while parked. Paste all of them into the M1 issue afterwards, one comment
  per block, each headed with the block's number.
- **Every Copy starts with the engine header**:
  `engine=native v<ver> proto=1 caps=episode,continuation,restore reason=<r> strikes=0 hold=<policy> build=<number> | web=<stamp>`.
  If it says `engine=legacy`, `strikes=` above 0, or another build number, stop
  and send that Copy: nothing after it measures the engine.
- **Use an episode**, not a Foray. **Forays play the old way in this build**: a
  Foray tap hands playback back to the web player until the app is next
  launched. If you play one by accident, close the app from the app switcher
  and reopen it before the next block.
- **The escape hatch**: if the build is unusable for daily listening, TestFlight
  → 4a → **Previous Builds** installs the last one. You do not need Claude for
  that.

## Step 0 — at home, 2 minutes

1. TestFlight → 4a → turn **Automatic Updates off**, so the build under test
   cannot change mid-drive.
2. Open 4a, then **Developer** → **Playback diagnostics** → **Copy**. Check the
   header against the rule above. Paste it as the header block.
3. Note where Previous Builds is (TestFlight → 4a).

## Desk pre-flight — 10 minutes, before the car

1. Play an episode on the phone speaker. Lock the phone. The lock screen shows
   the episode, the show and its artwork (not "4a" or "Unknown"); the skip
   buttons read 15 and 30. Pause and play from the lock screen.
2. AirPods in: play, pause and play from the AirPods. Take one out: playback
   pauses.
3. Control Center: the same title and controls; pause and play from there.
4. **Session probe (answers DV-9)**: play an episode and pause it, then
   Developer → **Session probe**. The row reads "armed"; lock the phone
   within 10 seconds and keep it locked for 30 seconds, then unlock. The Copy must show a
   `probe speech-then-play` row.
5. Copy. Paste as the pre-flight block.

## In the car (G-3: three drives)

Each numbered block ends with one Copy, parked. Write the route type down.

0. **Connect (the baseline's test 1).** Before you get in: play an episode on
   the phone, pause it **in the app**, lock the phone. Get in and start the car.
   When it connects, press the car's play if nothing starts by itself. Expected:
   **4a**, not Spotify. Copy.
1. **H-1, a paused session over time.** Play an episode through the car. Pause
   **from the car's controls**. Lock the phone. Wait **2 minutes**, press the
   car's play: 4a resumes. Pause again, wait **10 minutes**, play: 4a. Pause,
   wait **30 minutes** (a stop, a coffee), play: 4a. Copy.
2. **H-1b, no hold.** Developer → **Pause hold: none**. Repeat H-1 at
   **10 minutes** only. Record who plays. Set **Pause hold** back to **forever**.
   Copy.
3. **H-3, calls.** With a second person: while 4a is playing, they call you;
   answer, talk briefly, hang up. 4a resumes by itself. Then pause 4a, take a
   second call, hang up, press the car's play: 4a. Copy.
4. **Navigation.** Apple Maps navigation on, with **at least 3 spoken prompts**
   during an episode. Each prompt ducks or pauses 4a, and 4a comes back after
   it. Copy.
5. **H-6e, what the car shows, and the steering wheel.** The car's screen and
   the lock screen show the episode, the show and the artwork, never "4a" or
   "Unknown". The skip controls read 15/30. Press the **steering-wheel next**,
   then **previous**, and say out loud (or note) what each did. Copy.
6. **Status probe.** Close 4a from the app switcher, so nothing is restorable.
   Press the car's play and note who plays. Then start Spotify, then press the
   car's play and note who gets the press. Copy.
7. **Negative control.** Play 4a, pause it, play **Spotify for 10 seconds**,
   pause Spotify, press the car's play. Expected: **Spotify**. (This is correct:
   the car goes to the app that played last.) Copy.
8. **DV-12, killed mid-listen.** While an episode plays, close 4a from the app
   switcher. Reopen it: the episode is there, at most 15 seconds before where it
   was. **DV-13, headset unplugged**: with a wired or Bluetooth headset, play,
   then disconnect it: playback pauses and stays paused. Copy.
9. **DV-7a, iOS closing the app** (recorded, not yet required). Play, pause,
   then Developer → **Simulate system termination**, then lock the phone: once
   the app is in the background it saves where it was and closes itself, the
   way iOS would. Then press the car's play. Expected: 4a plays, and the Copy
   shows `launch=background`. Copy.
10. **DV-9** is the desk pre-flight's probe row; nothing to do in the car.
11. **Developer → Web.** Developer → **Playback engine: Web**, close and reopen
    4a, and play an episode: it plays with the old player (the Copy header says
    `engine=legacy`). Set it back to **Automatic**, close and reopen: the header
    says `engine=native` with `strikes=0`. Copy.

## How it is judged

`node tools/mobile/engine-report.mjs <paste> --build <number>` over each Copy.
M1 exits after **three drives** in which the report shows:

- no `sessionActivated failed`;
- no `remote play handled=y` without audio;
- no takeover **unless another app played after 4a** — the negative control
  (block 7) going to Spotify is the right answer;
- DV-12 and DV-13 pass;
- DV-7a and DV-9 recorded.

Against the baseline, the founder's two failures on 2026-09-24 are blocks 0
and 1: paused in the app, locked, the car connects and 4a resumes; and paused
from the car, a long pause, play, and 4a resumes and stays.
