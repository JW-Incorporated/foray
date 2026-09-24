# Car baseline, 2026-09-24 — the web-audio player cannot keep the car

HUMAN-ACTIONS #108's "one more car trip", taken on **build 2026092429** (web
`67dbe3ce9009ef58`). This is the **before** record that `docs/native-engine-plan.md`
NE-27's car test is compared against. Connection type (CarPlay vs Bluetooth) was not
stated.

> **FOUNDER, 2026-09-24:** "Car test failed twice. 4a was the last thing I played
> before getting in but it played Spotify, and a long pause also kicked over to
> Spotify"

Episode titles are replaced with `<episode>` here; the rows are otherwise verbatim
from the pasted Playback diagnostics record.

## Test 1 — a HELD session is not enough

```
15:09:28.711 transport  pause from tap  hidden=n
15:09:28.888 session    audio sessionActivated (paused)  lag 0ms  hidden=n      <- the app-process hold SUCCEEDED
15:09:31.052 session    audio background (did-enter)
15:09:31.052 session    audio nowPlayingReasserted (background)
15:09:32.037 session    audio nowPlayingReasserted (pause-settled)  hidden=y
15:09:32.669 media      stalled  hidden=y
15:17:47.096 session    audio routeChange (unknown)  hidden=y  hiddenFor 496043ms   <- the car connects
   (no remote command follows: the car's play went to Spotify)
15:17:51.547 transport  play from tap  hidden=n                                 <- the founder opened 4a by hand
15:17:52.335 session    audio sessionReleased (superseded)
```

The plugin held an ACTIVE `.playback` session in the app process for 8 minutes,
with `nowPlayingInfo` written and re-asserted, and the car still chose Spotify.
Every earlier record had the hold FAIL in the background, so this is the first
record that tests the hold itself — and it refutes "hold the session while paused"
as sufficient when the audio that last PLAYED came from WebKit's process, not the
app's. iOS returns the car to the app whose audio actually played last; for 4a that
was always WebKit's media process, whose registration lapses after a pause.

## Test 2 — a long pause, then play

```
15:23:22.134 remote     pause -> pause from webkit  handled=y  hidden=y
15:23:22.755 session    audio sessionActivated (failed)  hidden=y              <- background hold refused, as in every record
15:23:25.864 session    audio nowPlayingReasserted (pause-settled)  hidden=y
15:24:04.942 remote     play -> play from webkit  handled=y  hidden=n
15:24:04.965 remote     pause -> pause from webkit  handled=y  hidden=n         <- 23 ms later
15:24:04.989 stop       element pausedUnexpectedly  hidden=n  at 494.4s rs=4 ns=2
```

The play reached the page and was undone within 23 ms, and a healthy element
(`rs=4`) was paused from outside — consistent with Spotify having already taken
the route.

## What it decides

1. Nothing more at the web layer fixes the car. The tee (#746), the paused hold,
   re-assertion and remote de-dup all worked as designed in this record.
2. `docs/native-engine-plan.md`'s premise is the right one, with one sharpening:
   **the session that is held while paused must be the session the audio PLAYED
   through** — the engine's own AVPlayer in the app process — and the hold alone is
   not the mechanism; last-played audio plus a live Now Playing registration is.
   NE-16 (AudioSessionOwner) and NE-27 (the car test) are judged against this.
3. Background media `stalled` rows (15:09:32, 15:17:56 ×5 over 283 s) show WebKit's
   loading is throttled while hidden — one more reason the engine loads natively.
