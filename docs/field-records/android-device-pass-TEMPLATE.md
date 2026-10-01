# Android device pass — <YYYY-MM-DD>, build <versionCode>

<!-- TEMPLATE. Copy this file to docs/field-records/<YYYY-MM-DD>-android-device-pass-<build>.md
     and fill it in. The script, with every step's full expected result, is
     docs/android-device-pass.md (card A-14). Do not edit this template itself.
     NOT ISSUED until the Android native engine is fully operational (after A-42,
     founder ruling D-A3); HUMAN-ACTIONS #127 says when. -->

The record of one run of `docs/android-device-pass.md`. For each step write **pass**,
**fail** or **n/a** (only where the script allows it), a note if anything looked odd,
and paste the evidence the step names: **C** is a Developer → Playback diagnostics →
Copy, **D** is the output of the two `adb shell dumpsys` reads, **S** is a screenshot.
Episode and Foray titles may stay as they are; nothing personal goes in here.

| | |
|---|---|
| Date and time | |
| Tester | |
| Phone | Pixel 10 Pro |
| Android version and security patch (Settings → About phone) | |
| Build under test (the Copy header's `build=`) | |
| Native by default, or forced (from the script's "Filled in when issued") | |
| Car (make, model, year) or headset (model) | |
| Headphones used for step 10 | |
| PC with `adb` for D and Part H? (yes / no) | |

## Summary

| Result | Count |
|---|---|
| pass | |
| fail | |
| n/a | |

Failures, one line each (step number and what happened):

-

## The engine header (step 3)

```
<paste the first line of the step-3 Copy here>
```

## Part A: Install and first launch

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 1 | Install from the Play opt-in link; auto-update off | build shown in Play → About this app | | |
| 2 | First-launch screenshot | nothing under the status or gesture bar | | |
| 3 | Header check | engine=native, strikes=0, build under test, caps include episode, foray and restore | | |

### Step 2 evidence (S)

Screenshots: commit them next to this file as `<this file's name>-step2-<n>.png`, or link them here.

-

### Step 3 evidence (C)

```
<paste here>
```

## Part B: Speaker, notification, lock screen

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 4 | Deny the notification permission | plays on; media controls still in the shade and on the lock screen | | |
| 5 | Lock screen and notification buttons, nothing queued | title/show/artwork; 15 and 30; each button does its job | | |
| 6 | A dismissed notification stays dismissed | gone for 30 s; back on play | | |
| 7 | Back on Home while playing | audio continues; notification stays | | |

### Step 4 evidence (C D)

```
<paste here>
```

### Step 5 evidence (C)

```
<paste here>
```

### Step 7 evidence (C D)

```
<paste here>
```

## Part C: Locked seams, timed

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 8 | Two cross-episode seams, locked | both start by themselves; each `seam … src=engine` row `gap` ≤ 4.0 s | | |
| 9 | Locked Foray seams; a Foray that opens with narration | controls from the first line; each Foray `seam … src=engine` `gap` ≤ 1.0 s | | |

### Step 8 evidence (C)

Stopwatch: seam 1 → 2 `____ s`, seam 2 → 3 `____ s`

```
<paste here>
```

### Step 9 evidence (C D)

Stopwatch: narrator → first clip `____ s`, first clip → next item `____ s`

```
<paste here>
```

## Part D: Interruptions

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 10 | Headphones unplugged | pauses within 1 s; nothing from the speaker; route row | | |
| 11 | An incoming call | pauses on ring; resumes by itself after hang-up | | |
| 12 | Spotify takes over | 4a pauses and stays paused | | |

### Step 10 evidence (C)

```
<paste here>
```

### Step 11 evidence (C)

```
<paste here>
```

### Step 12 evidence (C)

```
<paste here>
```

## Part E: The car or a Bluetooth headset

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 13 | Metadata and steering-wheel buttons | title and show on the car; progress moves; previous restarts; stop only pauses | | |
| 14 | Play after a 2-minute pause | 4a resumes, not Spotify | | |
| 15 | Play after a 10-minute pause | 4a resumes, not Spotify | | |
| 16 | Play after 4a was swiped away (A-27) | 4a resumes the same episode, ≤ 15 s back | | |
| 17 | Negative control | Spotify plays | | |

### Step 13 evidence (C D)

What each wheel button did: pause `____`, play `____`, next `____`, previous `____`, stop `____`

```
<paste here>
```

### Step 15 evidence (C)

```
<paste here>
```

### Step 16 evidence (C D)

```
<paste here>
```

### Step 17 evidence (C)

```
<paste here>
```

## Part F: Narration, voice and the fallback

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 18 | Voice preview during a narration line (#117 step 2) | "Pause playback to preview" (the web player's wording is a fail); the line is not cut off | | |
| 19 | Airplane-mode narration fallback (A-41), Foray 2 | the phone's voice speaks the line within ~3 s; the fallback row | | |
| 20 | A network-only voice offline (#117 step 3), Foray 3 | narration moves on within ~2 s | | |

### Step 18 evidence (C)

```
<paste here>
```

### Step 19 evidence (C)

After airplane mode off, the clip: played by itself / needed one press of play (circle one)

```
<paste here>
```

### Step 20 evidence (C)

```
<paste here>
```

## Part G: Font size, then Delete my data

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 21 | The "Largest" font size | no overlap, no clipping, no sideways scroll, no zoom | | |
| 22 | Delete my data, then relaunch | clean relaunch; plays; no sync/session/vault error rows | | |

### Step 21 evidence (S ×4)

Screenshots: commit them next to this file as `<this file's name>-step21-<n>.png`, or link them here.

-

### Step 22 evidence (C)

```
<paste here>
```

## Part H: Console reads over USB (optional, PC only)

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 23 | Swap in the debug build, web-player lane | installs and plays; header `engine=js` | | |
| 24 | The §8.1 reads | `true`; payload matches; `sends` grows; state fields; shell fields; lock-screen buttons | | |
| 25 | Put the Play build back | header `engine=native` again | | |

### Step 23 evidence (C)

```
<paste here>
```

### Step 24 evidence (console answers, D)

```
forayPolyfill:
peek():
inspect() #1:
inspect() #2 (a minute later):
ForayAudio.state:
ForayAudioShell.inspect():
```

```
<paste here>
```

### Step 25 evidence (C)

```
<paste here>
```

## Part I: M3 parity on Android (A-67; only when issued with this pass)

Route for this part (car or headset; Android Auto running? yes / no):

| Step | What | Expected (short; the script has it in full) | Result | Note |
|---|---|---|---|---|
| 26 | A lost route, back after 10+ min | pause within 1 s; Android Auto resumes by itself, Bluetooth does not (the car's own play may); the lost/back rows | | |
| 27 | A listener's pause, then the route off and on | stays paused; `pausedBy=listener decision=no` | | |
| 28 | Foray 4 locked through two line seams; Next during a line | ~0.5 s seams, `prepare=hit`, gap 1.0 s or less; Next starts the next clip at its start | | |
| 29 | Airplane mode during a line | next line in the phone's voice within ~3 s; `narration kind=fallback cause=offline` | | |
| 30 | One hour native | plays the hour; battery % drop and 4a's share | | |
| 31 | One hour web player, then back to Automatic | battery % drop and 4a's share; header native again | | |

Battery: native hour __ % (4a __ %), web hour __ % (4a __ %).

### Step 26 evidence (C)

Seconds from the car connecting to its own play, if it sent one:

```
<paste here>
```

### Step 27 evidence (C)

```
<paste here>
```

### Step 28 evidence (C)

```
<paste here>
```

### Step 29 evidence (C)

After airplane mode off, the clip: played by itself / needed one press of play (circle one)

```
<paste here>
```

### Step 30 evidence (C)

```
<paste here>
```

### Step 31 evidence (C after the hour, C after switching back)

```
<paste here>
```
