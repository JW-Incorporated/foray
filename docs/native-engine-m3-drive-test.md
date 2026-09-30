# M3 drive test — the script (G-6)

The founder's test of milestone M3 of `docs/native-engine-plan.md` (§7 M3, §9
G-6, §14 card NE-40): **the values from the field, and the car-resume rules
made final**. M3 ships every timing it could not measure yet as a provisional
value (`// MEASURE`). This drive is what settles them (NE-38f), and it is the
first drive where DV-7a is **required**: 4a must come back for the car's play
after iOS itself closed the app.

This file is the script. HUMAN-ACTIONS #129 asks for the drive and links here.
Nothing in M3's engineering waits for it (the re-plan of 2026-09-29), and it
does not wait for the M2 drive (#128) either: if both are pending, this one
covers #128's Foray blocks too.

## The build

**One build: Claude adds here.** It is the first TestFlight build from `main`
after `engine/m3` merges (PR #913). The number goes here and into
HUMAN-ACTIONS #129 once the build exists. Every Copy from the drive must name
that build.

## Before it can be run

These are preconditions, not steps for the founder.

1. **`engine/m3` is on `main`** (PR #913, CI green on ios-kit, engine-parity,
   ios-gate, ios-shell and android-shell), and the TestFlight build above is
   from `main` after it.
2. That build's `ios-archive --check` log shows
   `ForayEngineDefault=native ForayEngineCapabilities=["episode","continuation","restore","foray"]`
   and `ForayEngineRouteResumeBluetooth=false` (NE-38rs's Bluetooth arm ships
   OFF; see "The Bluetooth question" below).
3. **The `.longFormAudio` trial ships OFF** (NE-40, DV-8). The engine's `build`
   row, and so the Copy header, says `routeSharing=default` until the founder
   turns the trial on in block 7. Nothing in the build can turn it on.
4. For any external TestFlight or App Store submission, the App Review note in
   `docs/store/app-review-background-audio.md` goes into App Store Connect as
   for M2. The founder's own internal TestFlight install needs no note.

## Rules for every block

- **Record the route in every block**: CarPlay, the car's Bluetooth, AirPods or
  the speaker.
- **One Copy per block, taken parked.** Menu → **Developer** → **Playback
  diagnostics** → **Copy**. Paste each Copy into HUMAN-ACTIONS #129's thread
  (the M3 issue), one comment per block, headed with the block's number and
  the route.
- **Every Copy starts with the engine header**:
  `engine=native v<ver> proto=1 caps=episode,continuation,restore,foray reason=<r> strikes=0 hold=forever routeSharing=default build=<number> | web=<stamp>`.
  If it says `engine=legacy` or `engine=js`, `strikes=` above 0, another build
  number, or `routeSharing=longFormAudio` outside block 7, stop and send that
  Copy. Nothing after it measures the M3 engine.
- **The escape hatch**: TestFlight → 4a → **Previous Builds** installs the last
  build, and Developer → **Playback engine: Web** (then close and reopen 4a)
  puts playback back on the old player. You do not need Claude for either.

## Step 0 — at home, 2 minutes

1. TestFlight → 4a → turn **Automatic Updates off**, so the build under test
   cannot change mid-drive.
2. Open 4a, then **Developer** → **Playback diagnostics** → **Copy**. The
   header shows **the build above**, `engine=native` and `strikes=0`. Paste it
   as the header block.

## Desk pre-flight — 10 minutes, before the car

1. The Developer menu shows **Route sharing: not known (applies after
   restart)**. Leave it alone until block 7.
2. Play an episode on the phone speaker, lock the phone. The lock screen shows
   the episode and the show, never "4a" or "Unknown". Pause and play from the
   lock screen.
3. Play a Foray whose first item is narration. The line plays, then the first
   clip. Pause during the line, wait 10 seconds, play: it carries on.
4. **DV-7a rehearsal.** Play an episode, pause it, then Developer →
   **Simulate system termination**. The row reads "armed". Lock the phone: 4a
   saves its place and closes itself, the way iOS would. Unlock, open 4a: the
   episode is there, paused where it was.
5. Copy. Paste it as the pre-flight block.

## In the car (G-6)

Each block ends with one Copy, taken parked.

1. **DV-7a (REQUIRED): iOS closed the app.** Play an episode through the car,
   pause it in the app, then Developer → **Simulate system termination**, then
   lock the phone (4a goes to the background and closes itself). Press the
   **car's play**. Expected: **4a plays**, and the Copy shows
   `build launch=background`. Copy.
2. **DV-7b (recorded only): you closed the app.** Force-quit 4a from the app
   switcher (swipe it away), then press the car's play. Expected: **not 4a**
   (iOS does not relaunch an app you closed). Note who played. Copy.
3. **Route resume (NE-38r).** Play at least a few seconds in the car first: a
   car becomes "known" only after 1 second of 4a's audio through it.
   - With 4a **playing**, switch the car off. Wait **at least 10 minutes**,
     then switch it on. With **CarPlay**, 4a resumes by itself. With
     **Bluetooth**, note whether the car starts playback itself (it sends its
     own play), and how long after connecting.
   - Then pause **in the app**, switch the car off and on again. 4a must **not**
     resume.
   - Expected rows: each loss writes `route kind=lost port= key=<8 hex> known=`,
     and each return `route kind=back ... pausedBy= decision= why=`. The first
     return reads `pausedBy=route` and, on CarPlay, `decision=resume
     why=route-back` (on Bluetooth `decision=no why=bluetooth-off`, then the
     car's own `remote play`). The second reads `pausedBy=listener decision=no
     why=listener-paused`. Copy.
4. **A rendered Foray (only once one is published).** Screen off, through at
   least two clip → line → clip seams. Press the **car's Next** during a line:
   the next clip starts at its own beginning. Turn **airplane mode on for 10
   seconds** during a line: the line carries on in the phone's own voice
   (the Copy shows `narration kind=fallback ... cause=offline`). Copy. If no
   Foray with rendered narration is published yet, skip this block and say so.
5. **DV-11, battery.** An hour of native playback, then an hour with
   Developer → **Playback engine: Web** (close and reopen 4a after switching).
   After each hour, read **Settings → Battery** → 4a's percentage and paste
   both numbers. Set it back to **Automatic** and reopen 4a. Copy.
6. **The regression drive (as M1).**
   - **H-1**: pause from the car, lock the phone, press the car's play after
     **2**, **10** and **30 minutes**: 4a each time.
   - **H-1b**: Developer → **Pause hold: none**, repeat at 10 minutes, note who
     plays, set it back to **forever**.
   - **H-3**: a call placed by a second person while 4a plays; hang up; 4a
     resumes by itself.
   - **Navigation**: Apple Maps with at least 3 spoken prompts during an
     episode; 4a comes back after each.
   - **Negative control**: play 4a, pause, play **Spotify for 10 seconds**,
     pause Spotify, press the car's play. Expected: **Spotify** (the car goes
     to the app that played last). Copy.
7. **Optional: the `.longFormAudio` trial (DV-8).** Developer → **Route
   sharing** until it reads **Long-form (applies after restart)**. Close 4a
   from the app switcher and reopen it: the Copy header now says
   `routeSharing=longFormAudio`. Repeat **H-1 at 10 minutes** only. Then
   Developer → **Route sharing: Default**, close and reopen 4a (the header says
   `routeSharing=default` again). Copy.

## How it is judged

`node tools/mobile/engine-report.mjs <paste> --build <number>` over each Copy.
The report prints the header check, the DV table, and the ten M3 verdicts
(NE-38e): `P13-clip`, `P13-line`, `reuse-idle`, `rate-latch`,
`resume-latency`, `route-back`, `seam-kinds`, `suspension-in-seam`,
`narration-fallback` and `dup`. `tools/mobile/fixtures/engine-report/m3-drive-synthetic.txt`
is the sample paste: the report run on it lists every M3 verdict (all `pass`),
which `engine-report.test.mjs` pins.

M3 exits (G-6) when:

- **DV-7a passes** (block 1): a `build launch=background` row, then a heard
  play. **DV-7b is recorded** (block 2), whatever it shows.
- **The route block** reads as expected above; the `route-back` verdict says
  whether the Bluetooth arm should change (see below).
- **DV-11** has both numbers, and the **regression drive** passes as M1 did
  (H-1, H-3, navigation; the negative control going to Spotify is correct).
- **No `stop cause=unknown`** anywhere. Every stop the engine makes writes a
  named cause first (NE-40's audit, `StopCauseTests`). The causes a paste can
  show: `pause`, `close`, `data-deletion`, `relinquish`, `ended` (an episode
  ran out), `final-end` (a Foray ran out), `system-pause` (iOS stopped the deck,
  or a spoken line was cut off by a suspension), `route-change`, `interruption`,
  `media-services-reset`, `grace-expired`, `load-deadline` (including a seam
  whose next clip never loaded), and `error`. `seam-timeout` and `unknown` are
  never written; either one in a paste is a defect.
- The M3 verdicts read `pass` or say what is missing (`no-coverage`); NE-38f
  settles each provisional value from these pastes, and NE-40d records the
  decisions (G-7).

## The Bluetooth question

`routeResumeBluetooth` ships **false**: a Bluetooth car (the founder's is
`BluetoothA2DPOutput`) that comes back after it paused 4a does **not** make 4a
resume by itself; the car's own play does (7.4 s after connecting, in the
2026-09-28 paste). CarPlay resumes by itself. Block 3's `route-back` rows are
what would justify turning the Bluetooth arm on, and that change is the
founder's decision (NE-40d).
