# `tts-locked-screen-check` — the instrument Foray

This is not curated content and it is not meant to be listened to. It is the
measuring device for `HUMAN-ACTIONS.md` #29: *does on-device narration survive a
locked screen on a real iPhone?* `docs/curation/generation-architecture.md` §9.1
calls that "the single highest-priority open question in the whole
generation-architecture spec", and `docs/research/on-device-tts.md` §9.3 concluded
it cannot be settled from documentation — only by holding a phone.

**Delete it once the question is answered.** This document, the Foray in
`data/forays.json`, `DIAGNOSTIC_FORAY_ID` / `withDiagnosticUnlock()` in
`player/foray-resolve.js` and their call sites in `player/client.js` go in one
commit. #29's own steps say so too.

## 1. What it does, and why it is shaped like this

**Item 1 is the whole instrument: one narration line, script only, no asset.**
About 99 seconds at `narration-craft.md` §0's 17 characters per second. It names a
marker every ten seconds — "Marker one, ten seconds", through to "Marker nine,
ninety seconds" — so **the last marker the founder hears IS the measurement**. He
does not have to time anything, and "it stopped somewhere" cannot be the answer.

**It runs first, and nothing runs after it.** `ForayTtsPlugin.swift` resolves
`speak()` on ACCEPT, not on completion (generation-architecture §7 item 3), so the
queue does not yet learn when an utterance ends and does not advance past a spoken
item. That is a real gap and it is not fixed here. It is worked WITH: the line is
item 1, so the phone speaks exactly one thing while the screen is locked and
nothing starts on top of it. `player/foray-playback.test.js` pins that, and the
test's own comment says to delete it when a completion signal lands.

**The seven clips below are ballast, and they are honest about it.**
`tools/foray/check-forays.mjs` will not pass a Foray with no resolvable segment
(and should not — a Foray is tape plus narration, not narration alone), and D5's
interquartile floor and M4's 25 % per-source cap mean the ballast has to be several
sources with real spread. They are seven segments already referenced by
`geology-plates-1`, chosen so that no new segment enters the mobile bundle's slice
(`tools/mobile/prepare-webdir.mjs` slices `data/segments.json` against the Forays
that reference it, so reusing referenced ids costs the bundle nothing). Under the
gap above, none of them will play during the test.

**It is a `draft`, and it stays one.** Publishing it would put a diagnostic on the
home screen of the live website. It reaches the phone instead through
`withDiagnosticUnlock()`, which unlocks this one id when `window.Capacitor` exists —
because `?foray=<id>`, the only unlock the app has, reads `location.search`, and
inside the Capacitor shell (`capacitor://localhost/`, no address bar, no
`server.url`, no registered URL scheme) that string is permanently empty.

## 2. The running order

Times are cumulative tape positions — the narration line is not counted in them,
the same convention every other Foray's §2 table uses. Tape runtime 808.4 s
(13 min 28 s); with the narration line the Foray runs about 907 s.

| # | at | label | duration | role | episode |
|---|---|---|---|---|---|
| 1 | 0:00 | MCN-3 | 199.1 s | explanation | Allen McNamara on the Deep Mantle Structure of the Earth |
| 2 | 3:19 | VH-3 | 69.5 s | explanation | Douwe van Hinsbergen on What Drives the Motions of Tectonic Plates |
| 3 | 4:29 | NANC-1 | 152.0 s | explanation | Damian Nance on What Drives the Supercontinent Cycle |
| 4 | 7:01 | BERC-1 | 78.5 s | explanation | David Bercovici on How Plate Subduction Starts |
| 5 | 8:19 | ROM-1 | 123.2 s | explanation | Barbara Romanowicz on Seeing Deep into the Earth |
| 6 | 10:22 | EVAN-2 | 62.5 s | explanation | David Evans on Supercontinents |
| 7 | 11:25 | FACC-1 | 123.6 s | explanation | Claudio Faccenna on the Dynamics of Subduction Zones |

Every row is from *Geology Bites*, and the order is deliberately not the one
`geology-plates-1` plays: this is ballast that has to satisfy D5's spread and M4's
source cap, not an argument anybody is making about plate tectonics. Read
`docs/curation/geology-foray-assembly.md` for the assembly that IS an argument.

## 3. What the test result changes

- **Continued through the locked screen** → `generation-architecture.md` §1.2's
  narration-only Foray is viable on iOS, and `on-device-tts.md` §6's "no
  server-side render" economics hold. The next question becomes §7 item 3: knowing
  when an utterance finishes, so the queue can advance.
- **Stopped partway** → the marker names the cutoff, which is the number
  `mp1-background-audio.md` §4.1b's 5 s / 10 s windows would be compared against.
  A voice that RESUMES on unlock was suspended; one that never returns was killed,
  and those are different fixes. #29's step 7 asks for both.

Neither outcome is knowable from this repo, and nothing in it should be written as
though it were.
