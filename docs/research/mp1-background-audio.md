# MP1 — does `<audio>` survive backgrounding in a Capacitor WebView?

Issue #35, the spike that gates #34's whole approach. Research, not a decision
record: it reports what was measured, what was only read, and what follows. The
decisions it recommends belong in `docs/DECISIONS.md` / an ADR, which a founder
merges — this file deliberately is not one.

**Date:** 2026-08-16/17. **Author:** a Claude Code session on Windows.

---

## 0. The answer

**Yes on iOS. Yes-but-unprotected on Android. And on both, "the audio keeps
playing" is the easy half of the question — the half that decides the
architecture is whether our *timers* keep running, because a Foray is 32
segments joined by 31 JavaScript-driven transitions, not one file playing.**

| | iOS | Android |
|---|---|---|
| `<audio>` keeps playing, backgrounded | **Yes**, with `UIBackgroundModes: audio` | **Yes**, while audible |
| `<audio>` keeps playing, screen locked | **Yes**, same condition | **Yes**, while audible |
| Survives 10 min backgrounded | Yes (no documented time limit) | **Only with a `mediaPlayback` foreground service** |
| JS timers keep running while audio plays | Yes, but **aligned to ~1 s** (§7.5 — **now measured**, median 1000 ms, §0b) | Yes, **at full rate** (measured, §4) |
| JS timers when audio is *paused* and hidden | throttled | throttled to 1 Hz, then 1/min |
| What native support is required | **one Info.plist key**, no plugin, no Swift | **a foreground service** — native code or a plugin |
| `navigator.mediaSession` → lock-screen controls | untested (see §10, #27) | **Impossible.** Disabled in WebView by a Chromium switch |
| Basis | **documentation-derived** | **source-derived, plus engine-level measurements in Chromium.** An emulator run was attempted and did **not** produce data — see §6 |

**The verdict for #35's own decision table: "works on one".** iOS needs one
plist key and genuinely works. Android needs native code that does not exist
yet, and its lock-screen controls are impossible from JS at any price.

**One gate on the iOS column, before anyone spends a week on it.** "Yes" there
means *the audio* keeps playing. Whether our **out-point** still fires depends on
the `timeupdate` media event surviving backgrounding — an inference (§8), and the
most load-bearing untested claim in this document. If it is wrong, iOS needs a
native backend too. One device and ten minutes settles it — `HUMAN-ACTIONS.md`
item #11.

> **UPDATE, 2026-08-17 — that gate has been executed in the iOS Simulator and it
> PASSED.** Out-point overshoot **0.0045 s** over a **15.056 s** hidden window,
> app never resumed (run 32026332637; full numbers and the retraction of an
> earlier wrong reading in **§0b**). So iOS does not need a native out-point.
> What is NOT settled by that result is the **transition** between segments —
> a `setTimeout` beat plus a cross-episode load, on the clock the same run
> measured at 1 s alignment. See §0b and §8's last paragraph.

---

## 0b. MEASURED SINCE — 2026-08-17, iOS Simulator in CI. Read before quoting §7 or §8.

`.github/workflows/ios-build.yml` (#38) now builds this shell on a macOS runner
and runs the real player inside it. **Two of this document's inferences have been
executed, and one intermediate reading of them was wrong and is retracted here.**

**Run [32026332637](https://github.com/JW-Incorporated/foray/actions/runs/32026332637),
verdict `fires-in-background`:**

| §8's inference | What ran | Result |
|---|---|---|
| `timeupdate` survives backgrounding, so the coarse stage keeps its ~4 Hz | The real `HtmlAudioBackend`, out-point armed 15 s after the page went hidden | **HELD.** 61 hidden `timeupdate` samples, **median 252 ms** |
| Overshoot ~0.25 s if it holds, ~1 s if only the aligned timer does | Stopped at 45.469 s against `end_sec` 45.460 s | **0.0045 s** — better than either prediction |
| §7.5: hidden-page DOM timers are aligned to ~1 s (documented, unverified) | A 250 ms `setInterval` sampled while hidden | **CONFIRMED. Median 1000 ms** (253, 925, 1000, 1000, 1001, 998, …, n=25) |

The hidden window was **15.056 s** and `resumedAtWall` was **null** — the app was
never brought back to the foreground, so no resume can have caused the stop. §1's
"everything about iOS is documented only" no longer covers §7.5 or §8's first
claim; both rows are updated below.

**RETRACTED: the `fired-on-resume` reading of run 32023924627.** An earlier run
reported that verdict, and it was quoted onward as "the out-point only fires when
the app returns to the foreground — MP1 §8's predicted failure mode". **It was a
harness artifact, not a finding.** `xcrun simctl launch com.apple.Preferences`
returns as soon as the launch is *accepted*, and Settings took tens of seconds to
actually reach the foreground, so a fixed `end_sec` was crossed while the page was
still visible. The overshoot in that run was **3 milliseconds**, which is the tell:
an out-point that had genuinely stopped firing in the background would overshoot by
however long the app stayed backgrounded, not by milliseconds. Three fixes landed in
`tools/mobile/ios-ci.mjs` and `probe-outpoint.js` — arm relative to going hidden, a
5 s hidden-window floor, and an explicit refusal of the incoherent
low-overshoot/`fired-on-resume` combination — and the corrected run is the one
tabled above. **Do not cite 32023924627 for anything.**

**THE TRANSITION IS NOW PARTLY MEASURED, AND §8's LAST PARAGRAPH WAS RIGHT TO
WORRY.** The out-point result above is about the **stop**; the transition is a
different mechanism — a `setTimeout` beat on the very clock measured at 1000 ms
alignment, with a fresh cross-episode load inside it. Phase C
(`tools/mobile/probe/probe-seam.js`, #28's iOS half) drives three bounded segments
over three files through the real `PlayerQueueManager`.

**Run [32036295743](https://github.com/JW-Incorporated/foray/actions/runs/32036295743),
verdict `too-few-transitions` — encouraging, and NOT a pass:**

| | |
|---|---|
| transitions completed while hidden | **1**, against this workflow's floor of **2** (`MIN_HIDDEN_TRANSITIONS`) |
| the one that completed | beat → cross-episode load → seek → play, `hiddenAtBoundary` and `hiddenAtNextPlaying` both true, `resumedAtWall` **null** |
| **the 2.0 s beat** | **9,153 ms observed against 2,000 ms asked** |
| where the time went | `beat-armed` +2 ms (the timer is fine), `stalled` **+3,173 ms**, `canplay` +9,142 ms, `beat-ended` **+9,142 ms** — the same millisecond |
| the audio being loaded | a **local bundled file**, not a CDN fetch |

Two things follow, and the second one supersedes a "SAFE" reading in `STATE.md`.

1. **The chain does run backgrounded on iOS.** One complete transition with the app
   never resumed. Nothing native is needed for the mechanism to work, which is why
   the `fired-on-resume` retraction above stands.
2. **§8's specific fear was very nearly realised, on the easiest possible input.**
   §8 names a slow cross-episode advance pushing the silent window past WebKit's
   audibility grace. **That grace is 5 s, not the 10 s §7.4 states** — the run's own
   log carries `Starting timer to clear audible activity in 5 seconds`, and
   `clearAudibleActivity` firing 5.006 s later. The 10 s constant belongs to a
   different mechanism (`WebPageProxy::updateThrottleState` releasing the foreground
   assertion); **§7.4's `audibleActivityClearDelay = 10_s` is mislabelled and is
   corrected below.**

   So the 9,153 ms silence **exceeded** the audible-activity clear outright — the
   assertion was dropped mid-beat — **and the transition completed anyway**, which is
   a stronger result than a near-miss would have been. The cliff that remains is the
   **10 s** foreground-assertion release, and the measured beat came within **847
   ms** of it, on a *local* file. The beat is `max(gap, load)`
   (`player/queue-manager.js` §10) and the load dominated by seven seconds, so a real
   cross-origin fetch had under a second of headroom before crossing that threshold.

   **A real phone then crossed it, which settles the direction of this risk.**
   Issue **#224**: a founder heard `grilling-history-1` *pause* at a seam with the
   screen off. The cause given there is **our own** deadline, not WebKit's — the
   load exceeding `LOAD_SETTLE_TIMEOUT_MS` (10 s, `html-audio-backend.js`), which
   throws into `_loadItem`'s catch, dispatches `E.error`, and leaves the player
   idle and paused.

   **Three separate 10,000 ms deadlines are in play and they must not be merged:**
   WebKit's audible-activity clear (**5 s**, measured above), WebKit's
   foreground-assertion release (**10 s**), and our `LOAD_SETTLE_TIMEOUT_MS`
   (**10 s**). The measured 9,153 ms is 92% of the last of those. It is also 847 ms
   short of the second — the same number, because the constants match, which is
   what makes the conflation easy and why it is spelled out here.

   **As of 2026-08-17 the coincidence is gone, and only ours moved:** our deadline
   is visibility-aware — 10 s visible, **20 s hidden** — so the 9,153 ms seam now
   sits at 46% of its budget instead of 92%, while WebKit's two are unchanged and
   not ours to move. One consequence worth keeping in view: at 20 s a hidden load
   can now outlive WebKit's 10 s foreground-assertion release, which is the point
   (a load that slow needs the extra time) but also means a slow seam and a lapsed
   assertion can coincide. §4.1b's suspension ceiling is the real bound there.

   ~~**#227** moves the load off the boundary (prefetch on a second element, 12 s
   ahead, while the current segment is still audible) so the silent window is no
   longer where the fetch happens — which relieves all three.~~
   **RETRACTED, and see §4.1a.** Measured on run 32057395270: the load takes ~11 s
   whether the page is audible or silent, because media-element load tasks are
   throttled by VISIBILITY rather than audibility. #227 relieved none of the three
   and made the third one certain (the segment was dropped), so it is parked
   default-off. **WebKit's two remain open and are not ours to move. OURS moved:**
   `LOAD_SETTLE_TIMEOUT_MS` is visibility-aware as of 2026-08-17 — 10 s visible,
   **20 s hidden** — which converts a dropped segment into a slow seam.

**And the second transition — the one that would have tested whether audibility
lapses after that silence — is exactly the one this run did not get.** The record
stops at +25.2 s of a 90 s hidden window. Whether the page stopped being scheduled
or its writes stopped reaching disk is **genuinely open**; `docs/ios-ci.md` §4c
states both branches and what will separate them. Under the first branch a hidden
page can be descheduled mid-Foray, which would be a bigger problem than the gap.

**The cross-origin fetch is not merely unmeasured, it is unmeasurable in CI** — a
runner is a datacenter link, so a green number there is a floor against a
slow-fetch risk. `docs/ios-ci.md` §4d gives the full argument and what would
actually settle it (instrument the shipped seam path, not the probe).

**A Simulator is not a device.** It models neither power management nor true
suspension, so a pass there is weaker evidence than a failure would be. That
asymmetry is why these runs are worth having and why `HUMAN-ACTIONS.md` #11 stays
open.

---

## 1. Measured versus documented — read this before quoting anything below

This repo has been burned by estimates presented as measurements, so the basis
for every claim is labelled inline and summarised here.

| Claim | Basis |
|---|---|
| Overrun cost if an out-point never fires (§3) | **Measured** — computed over the real `data/forays.json` + `data/segments.json` |
| Blink timer behaviour, hidden page, audible vs paused (§4) | **Measured** — desktop Chromium on this machine |
| Real `HtmlAudioBackend` out-point overshoot, hidden page (§4) | **Measured** — the shipped module, in a browser |
| Android WebView behaviour under HOME + screen lock (§6) | **Attempted, not obtained.** The toolchain and app were built; the emulator never became usable. §6 says exactly how far it got |
| Android's OS-level process rules — freezer, audio focus, FGS (§5) | **Documented** — Android + AOSP docs. One step is **inferred, flagged inline**: that a `mediaPlayback` FGS prevents freezing (§5.3) |
| MediaSession unavailable in Android WebView (§5) | **Documented** — Chromium source |
| iOS hidden-page DOM timer alignment (§7.5) | **MEASURED in the iOS Simulator**, 2026-08-17, run 32026332637 — median **1000 ms**. Was documented-only when §7.5 was written; see §0b |
| iOS `timeupdate` survives backgrounding, and the real out-point's overshoot (§8) | **MEASURED in the iOS Simulator**, same run — 61 hidden samples at a 252 ms median, overshoot **0.0045 s**, app never resumed. Was the most load-bearing untested claim here; it HELD. See §0b |
| The iOS SEAM TRANSITION while backgrounded — the beat's `setTimeout`, the cross-episode load (§8, last paragraph) | **Being measured** by probe phase C (#28's iOS half). Read the run linked in that PR; do not read §8's out-point result as covering it |
| Everything else about iOS (§7) | **Documented only.** Never executed — iOS cannot be built from Windows. One step remains **inferred, flagged inline**: that a foreground process assertion keeps JS timers running (§7.4) |

**Nothing in this document was tested on a PHONE, on either platform** — and as
of 2026-08-17 some of the iOS column *was* executed, in the **iOS Simulator on a
CI runner** (§0b). A Simulator models neither power management nor true
suspension, so a pass there is weaker evidence than a failure would be; it is
emphatically not a device measurement, and `HUMAN-ACTIONS.md` #11 stays open.

The Android toolchain was installed and a Capacitor app around our real player
was built and pushed to the emulator — but it never finished booting well enough
to install it (§6.2). So the Android answer still rests on Chromium's source plus
measurements of the same engine on the desktop, and **no part of the Android
column has been executed anywhere.**

---

## 2. Why "does `<audio>` survive?" is the wrong question on its own

The web app plays a Foray end to end today (`player/queue-manager.js`,
`player/foray-queue.js`, `player/html-audio-backend.js`). It is not an
`<audio>` element with a src. Playing Foray #1 requires, **inside the hour**:

- **32 out-points.** Each segment stops at its own `end_sec`.
  `player/html-audio-backend.js` does this in two stages: a coarse stage on
  `timeupdate` (~4 Hz, a *media event*) and a fine stage that is a one-shot
  `setTimeout` armed inside the last 0.5 s. The fine stage is what buys the
  ~14 ms precision; `timeupdate` alone overshoots by up to a quarter-second.
- **31 advances**, of which **16 are a different episode** (a full
  `load()` — network, metadata, seek) and **15 are the same episode**
  (an in-place seek, deliberately, so back-to-back segments stay gapless).
  Measured over `data/forays.json`; Foray #2 is 21 seams, 11 same-episode.
- **31 seam beats of 2.0 s.** `player/seam-gap.js` + `queue-manager.js`
  `_awaitSeamGap()`. And this one matters more than its size suggests: the beat
  is armed **at the moment the out-point pauses the element**, and its end is a
  timer for whatever of the 2.0 s is still owed — `_awaitSeamGap()` schedules
  `seamGapRemainingMs` through an injectable scheduler, so the next item's load
  happens *inside* the beat rather than after it. For those two seconds the page
  is producing **no
  audio at all** — which, on both engines, is the condition under which the
  keep-alive is withdrawn (§4, §5, §7). We voluntarily go silent 31 times an
  hour.
- **A 15 s position-persistence interval** (`queue-manager.js` `_startTimer`).

So there are three failure modes, not one, and only the first is the one #35
asked about:

1. **Audio stops.** Obvious, recoverable, the listener knows.
2. **Audio continues but the out-point does not fire.** The segment runs on into
   the rest of the source episode. **This is the dangerous one** — it is not
   obviously broken, it is silent editorial failure, and §3 measures what it
   costs.
3. **Audio stops at the out-point and the beat never ends.** The Foray stalls in
   silence mid-hour with a UI that says it is playing.

Mode 2 is a defect the shell would *introduce*. The web app does not have it,
because a browser tab playing audio is not subject to app-level backgrounding.

---

## 3. Measured — what mode 2 actually costs

If an out-point does not fire, playback continues to the end of the source
episode. Computed over the real data with the repo's own resolver
(`player/foray-resolve.js`), `overrun = reference_duration_sec − end_sec`:

| | Foray #1 `grilling-history-1` | Foray #2 `capital-types-1` |
|---|---|---|
| Playable items / authored runtime | 32 / 61.2 min | 22 / 51.4 min |
| Overrun per segment — min | 299 s | 159 s |
| Overrun per segment — **median** | **936.5 s (15.6 min)** | **918.7 s (15.3 min)** |
| Overrun per segment — max | 2504 s (42 min) | 3053 s (51 min) |
| Sum of all overruns | 9.55 h | 7.34 h |
| Leaked : authored ratio | **9.4×** | 8.6× |
| Segments whose out-point is within 30 s of the file end | **0 / 32** | **0 / 22** |
| Segments with > 60 s of episode left after the out-point | **32 / 32** | **22 / 22** |

Read the last two rows first. There is **no benign case**. Every single segment
in both Forays sits in the middle of its source episode, so a missed out-point
never merely runs a few seconds long — the smallest overrun anywhere in either
Foray is 2.6 minutes, and the median is about a quarter of an hour.

Concretely: **miss only the first out-point of Foray #1 and the listener gets
2.5 minutes of authored Foray followed by 20.4 minutes of one Origin Stories
episode** — with the running-order UI still highlighting segment 1, and the
Foray's own clock still counting. The worst single case is segment 30, where a
151-second segment is followed by 42 minutes of a Traeger-history episode.

So the question "how far past `end_sec` does playback get — seconds or minutes?"
has an answer: **minutes. A median of 15.6 of them, per missed boundary.** A shell
that loses timer precision in the background is not shippable with a caveat; a
shell that loses timers *entirely* in the background is not shippable at all.

---

## 4. Measured — Blink timers in a hidden page, audible versus silent

Android WebView is Chromium, and the page scheduler that decides throttling is
the same `PageSchedulerImpl` in both (source-traced in §5.2). So desktop
Chromium is a legitimate probe of the *engine's* rule, though **not** of
Android's OS-level rules, which are the part that actually bites (§5.3).

Harness: a local Node server, a generated tone, a page that reports each timer
tick with `sendBeacon`; the probe tab is hidden by opening a second tab in the
same window. Scripts are throwaway and live in the session scratchpad, not the
repo. The page reports its own numbers over HTTP, so no browser-automation
channel sits between the measurement and the record.

**4.1 — A 100 ms `setTimeout`, repeated (418 samples):**

| phase | n | median | p90 | max | audio advanced |
|---|---|---|---|---|---|
| visible, playing | 60 | 111 ms | 147 ms | 270 ms | — |
| **hidden, playing** | 243 | **111 ms** | 118 ms | 3050 ms | 28.1 s in ~30 s |
| **hidden, paused** | 10 | **2387 ms** | 4842 ms | 4842 ms | 0 s |
| hidden, playing again | 105 | 111 ms | 117 ms | 4813 ms | 11.6 s |

At the median, a hidden page that is producing audio is **not throttled** — 111 ms
for a requested 100 ms, identical to visible, and its p90 is tighter than the
visible p90. Pause the element and the same timer collapses by **~21×** against
that 111 ms baseline. Resume and it recovers immediately.

**Read the `max` column too, because it is the one that could hurt us.** Even
while audible the worst tick was **3050 ms**, and 4813 ms just after the paused
phase. Those are not throttling — a throttled timer does not also deliver 111 ms
medians — they are ordinary scheduler starvation on a busy desktop. But a late
fine-timer wake *is* overshoot, so the exemption protects the **median**, not the
tail, and §8's argument rests on the median.

> **4.1a — THIS SECTION IS ABOUT TIMERS. DO NOT GENERALISE IT TO MEDIA LOADS.**
> Added 2026-08-17, after the generalisation was made and shipped and cost a
> regression (PR #227, parked default-off by the PR that added this note; the machinery and its tests remain).
>
> The measurement above says a hidden page **that is producing audio** is not
> throttled — for `setTimeout`. It says nothing about the HTML **media load
> algorithm**, whose steps are queued tasks on a different path, and those ARE
> throttled while hidden *regardless of audibility*.
>
> Measured on a device-class run — **32057395270**, iOS Simulator, app genuinely
> backgrounded — from `WebKit:Media` element lifecycle in that run's
> `simulator-log-seam.txt` (times are seconds since the probe page started; the
> out-point pause is at 32.49 s, so the audible row is BEFORE the boundary):
>
> | phase | between load-algorithm steps | total to `canplay` |
> |---|---|---|
> | **visible** | 0.20 s, 0.24 s, 0.13 s | **~570-590 ms** |
> | **hidden, audio PLAYING** | **+3.47 s, +3.90 s**, then 5.0 s with no data | never finished (11.8 s) |
> | hidden, audio paused | +2.4 s, +3.5 s, +5.1 s | **11.14 s** |
>
> **The middle row is the point.** Those multi-second gaps happened while a
> segment was playing audibly — in the same window the real `HtmlAudioBackend`
> out-point fired **1 ms** late, so JS timers were demonstrably fine at that
> moment. One page, one run, two schedulers:
>
> - **DOM timers → throttled by AUDIBILITY** (§4.1, §5.2, §7.4).
> - **Media-element load tasks → throttled by VISIBILITY.** A ~15-20x collapse in
>   step delivery. **N=1 per phase, one run, one engine, a Simulator** — enough to
>   refute a design built on the opposite assumption, not enough to quote as a
>   WebKit invariant. §4.4 holds itself to the same standard.
>
> Two consequences that outlive the reverted feature, both worth more than it
> was:
>
> 1. **You cannot hide a media load in the audible window.** Any design that
>    depends on "audio is playing, so this load will be quick" is unsound. The
>    file in the measured run was a small asset **bundled inside the app** — this
>    is not network latency and no cache warms it away.
> 2. **A hidden-page load takes 5-11 s, against `LOAD_SETTLE_TIMEOUT_MS` of
>    10,000 ms in `player/html-audio-backend.js`.** So a segment DROPPED at a
>    seam on a locked phone is structural rather than unlucky, and it predates
>    #227. §4.4 below — 3 of 5 hidden Chromium loads failing that same deadline —
>    is the same finding on the other engine, and its "cause is unknown" note can
>    now be read as this. **The deadline is visibility-aware as of 2026-08-17**
>    (10 s visible, 20 s hidden), which converts those drops into slow seams.
>
>    **And the range is the finding, not the 11 s.** Three runs on the identical
>    file: **5,114 ms** (32064639785), **9,153 ms** (32036295743) and 11,140 ms
>    (32057395270, which had a second element's teardown sharing the task queue).
>    The first two are the SAME code path at the SAME 15.0 s of hidden playback —
>    a **1.8x** spread with nothing varied — and the whole difference sits in one
>    phase, `stalled` → `loadedmetadata`, at 1,902 ms against 5,954 ms. Treat a
>    hidden chain as a distribution with three samples, and beware of reading any
>    cross-run delta under ~2x as an effect: two of these runs differ by that much
>    for no reason we can name.

> **4.1b — THE HIDDEN WINDOW HAS A CEILING: THE PAGE IS SUSPENDED ~26 s IN.**
> Added 2026-08-17. This bounds every hidden measurement in this document and it
> was not known when §4.1a was written.
>
> **READ §4.1b-ii BEFORE QUOTING THIS SECTION.** The three record-end times below are
> right; calling the cause "~26 s of hidden time" is not established. The probe stopped
> its OWN audio 15 s into each of those windows, and 15 s + WebKit's ~12 s
> assertion-release lands on the same number — so this section's reading and a
> silence-driven one fit every run here equally. §4.1b-ii has the log lines, the
> arithmetic, and what happened in the 35 s AFTER the record stops, which is not what
> this section assumes.
>
> Across the three seam runs the durable `foray_probe_seam` record simply stops:
> the last write lands **25.2 s, 26.8 s and 27.9 s** after the app went hidden
> (runs 32036295743, 32057395270, 32064639785). `simulator-log-seam.txt` says it
> is a real suspension rather than WebKit declining to flush:
>
> ```
> WebProcessProxy::didChangeThrottleState(Suspended)
> ProcessThrottler::uiAssertionWillExpireImminently
> WebProcessPool::applicationIsAboutToSuspend: Terminating non-critical processes
> WebProcessPool::setProcessesShouldSuspend: Processes should suspend 1
> ```
>
> Consequences:
>
> - **No hidden number here describes a phone locked for more than ~26 s.** Any
>   "does throttling deepen with time hidden?" question is currently
>   unanswerable with this instrument: moving the probe's first boundary to 45-60 s
>   of hidden time puts it *past the suspension*, so it would measure nothing.
>   **THAT PREDICTION IS NOW THE EXPERIMENT, not a reason not to run it** — the arm is
>   60 s as of 2026-08-17. If the record covers 60 s of hidden time, this bullet is
>   wrong; if it stops at ~28 s with `seg-a` still playing, it is right and the answer
>   is the bad one. Either way the run decides it, which is more than either of us can.
> - **`MIN_HIDDEN_TRANSITIONS = 2` has never been met.** All three runs contain
>   ONE transition and two audible items. `seg-b`'s out-point is armed
>   (`outPoint.set 20.00s`) and the last durable write lands ~0.3 s before that
>   boundary was due. The workflow's own 90 s derivation reaches transition 2 at
>   ~41 s; the app is not alive to get there. **Correction, §4.1b-ii: in run
>   32064639785 the app WAS alive to get there — the log shows the second transition
>   completing at +56 s, hidden, never resumed. What was never met is the RECORD, which
>   stops at the suspension's last flush. "Never met" is a fact about the artifact.**
> - **Whether this happens on a REAL PHONE is the open question, and it dwarfs
>   everything else in this area.** `UIBackgroundModes: audio` is supposed to keep
>   an app alive exactly while audio plays — §1's central finding — and the
>   harness backgrounds the app by launching Settings on a Simulator with no real
>   audio route, which is a plausible reason for a Simulator to suspend an app the
>   OS hears nothing from. **If it reproduces on a device, a Foray stops advancing
>   ~26 s after the screen locks and every seam refinement is moot.**
>   `HUMAN-ACTIONS.md` #11 answers it in twenty minutes with no build: screen off,
>   does the running order keep advancing?

> **4.1b-ii — THE CEILING ABOVE IS CONFOUNDED WITH THE PROBE'S OWN SILENCE, AND THE
> ARITHMETIC IS EXACT.** Added 2026-08-17, from run **32064639785**'s
> `simulator-log-seam.txt` — the same artifact §4.1b cites, read further down. Nothing
> in §4.1b is deleted: its three record-end times are right and its warning is worth
> keeping. What is wrong is treating "~26 s of hidden time" as the cause.
>
> **The confound.** `probe-seam.js` armed its first boundary at
> `ARM_AFTER_HIDDEN_SEC = 15`, so **the probe's own audio stopped 15 s into every one
> of those hidden windows** — that is what a boundary is. WebKit then starts two
> timers, and this log carries both, verbatim, for our process:
>
> ```
> +15.73  updateAudibleMediaAssertions: Starting timer to clear audible activity in
>         5 seconds because we are no longer playing audio
> +16.30  updateThrottleState: UIProcess starting timer to release a foreground
>         assertion in 10 seconds if audio doesn't start to play
> +27.86  clearAudibleActivity: UIProcess is releasing a foreground assertion because
>         we are no longer playing audio        <- the last durable write is +27.86
> +27.87  didChangeThrottleState(Background) / uiAssertionWillExpireImminently
> +27.99  didChangeThrottleState(Suspended)
> +28.99  applicationIsAboutToSuspend: Terminating non-critical processes
> ```
>
> (Offsets are seconds after the page recorded `document.hidden` — the same zero
> §4.1b's 25.2/26.8/27.9 s are measured from; `applicationDidEnterBackground` is 0.88 s
> earlier in this run.) **15 s of hidden playback plus a ~12 s assertion release lands
> on ~28 s.** So does "the platform suspends a hidden WebView ~28 s in regardless of
> audio". Every run we have fits both, and they have opposite consequences.
>
> *Which of the two timers fired at +27.86 is an **inference**, flagged because the
> label does not settle it: the line is `WebPageProxy::clearAudibleActivity`, which
> names the 5 s mechanism, but the 5 s timer was armed at +15.73 and due at +20.73 — by
> which time `seg-b` was audible (+20.16) — while the 10 s one armed at +16.30 is due at
> +26.30, ~1.6 s before it fired. The arithmetic fits the 10 s timer and not the 5 s
> one. Nothing below depends on which.*
>
> **AND IT IS THE SAME ARITHMETIC IN ALL THREE RUNS**, which is what turns this from a
> story about one artifact into a mechanism. `suspensionVerdict` was run over all three
> uploaded artifacts; the first boundary is at ~15.0 s in every one because that is what
> `ARM_AFTER_HIDDEN_SEC` was:
>
> | run | first boundary (probe's audio stops) | record ends | **lead** | log says |
> |---|---|---|---|---|
> | 32036295743 | +15.03 s | +25.16 s | **10.1 s** | nothing — that run's seam pass had no log coverage at all |
> | 32057395270 | +15.02 s | +26.77 s | **11.8 s** | `suspended` at +26.84 s, audio had stopped (the segment was dropped) |
> | 32064639785 | +15.05 s | +27.86 s | **12.8 s** | `suspended` at +27.99 s, audio playing since +20.16 s |
>
> **Measured.** 25.2, 26.8 and 27.9 s are not three samples of a ceiling on hidden time;
> they are 15 s of arm plus a 10-13 s assertion release, three times. The spread tracks
> the *silence*, not the clock: the run with the shortest lead is the one whose next
> segment came back soonest.
>
> **Why the audio restarting did not cancel it, and this is the Simulator-specific
> part.** `seg-b` became audible at **+20.16 s**, well before the release fired, and
> WebKit noticed (`updateAudibleMediaAssertions: Taking MediaPlayback assertion`,
> +21.56). The RBS acquire that would have re-established the assertion then **failed**:
>
> ```
> ProcessAssertion::acquireSync Failed to acquire RBS assertion 'WebKit Media Playback'
>   error: (originator doesn't have entitlement com.apple.runningboard.assertions.webkit
>           AND originator doesn't have entitlement com.apple.multitasking.systemappassertions)
> ```
>
> This is the entitlement gate §7.4 documents as the reason a real app must carry the
> background mode, and a `simctl`-launched Simulator app does not hold it (already
> noted in `docs/ios-ci.md` §4c). **So on this instrument, audio resuming cannot cancel
> a pending assertion release.** On a device it is supposed to. That is a mechanism, not
> a measurement of a phone — labelled accordingly.
>
> **AND THE PART NOBODY HAD READ: THE FORAY KEPT GOING.** The log runs 35 s past the
> last durable write, and in it (times still relative to going hidden):
>
> | | what the log shows | basis |
> |---|---|---|
> | +27.9 → +42.5 | the media element's own position advances **12→25.8 s** with `isPlaying = true` | **Measured** — `updateNowPlayingInfo` |
> | +40.7 | `observedProcessStatesDidChange`; by +42.5 the WebContent process is executing again | **Measured** |
> | +47.1 | `HTMLMediaElement::pause` at position **31.08** — `seg-b`'s out-point, armed at 20 s, fires **11.1 s late in media time** | **Measured** |
> | +50.4 | `prepareForLoad` + `createMediaPlayer` — a fresh media load, hidden | **Measured** |
> | +55.2 | position **20.0**, then playing at +56.2 → a third segment audible, stopping at **26.2** at +63.4 | **Measured**; that it is `seg-c` is **inferred** from bounds (`start_sec: 20`, `end_sec: 26`) plus the fresh load — the log carries no filename |
>
> **Both transitions completed, with the app hidden throughout and never foregrounded
> by the harness.** `MIN_HIDDEN_TRANSITIONS = 2` was physically satisfied in run
> 32064639785 and the *record* could not show it, because nothing after the
> suspension's flush ever reached disk (`NetworkStorageManager::suspend()`, +28.0).
> Every `too-few-transitions` verdict this project has printed is a statement about the
> **record**, not about the app.
>
> **So what survives, and what does not.**
>
> - **Refuted for this run:** "a Foray stops advancing ~26 s after the screen locks."
>   It advanced — late — and the queue ran to completion while hidden. Do **not**
>   upgrade that to "audio never stopped": the element's position moved **19.1 s across
>   the 26.9 s** from `seg-b` becoming audible to its late pause, so ~8 s of that window
>   was not audio. Whether that is a genuine stall through the suspension or the
>   coarseness of `updateNowPlayingInfo`'s position reports is **unresolved** — those
>   reports arrive in bursts and one of them was 5.5 s late elsewhere in the same run.
> - **Still open, and now the narrow question:** whether a hidden page is suspended at
>   ~28 s of hidden time *when its audio never stops at all*. Nothing measured so far
>   can say, because the probe has always stopped its own audio at 15 s.
> - **The instrument for it** is `ARM_AFTER_HIDDEN_SEC = 60` (2026-08-17) with the
>   seam window at 175 s, so the first silence falls at 60 s of hidden time. A record
>   that stops at ~28 s with `seg-a` still audibly playing is the ceiling; a record
>   that runs to 60 s is not. `tools/mobile/ios-ci.mjs`'s `suspensionVerdict` decides
>   it from the artifact rather than from a human reading a log, and reports it as
>   section 3b of the job summary.
> - **`HUMAN-ACTIONS.md` #11 is unchanged and still worth more than any of this.** A
>   Simulator that cannot hold the media-playback assertion is not a phone that can.


**4.2 — The seam beat specifically.** One `setTimeout(2000)` — the real
`SEAM_GAP_SEC` — armed in a hidden page, 4 reps each:

| condition | median | raw |
|---|---|---|
| hidden, audio playing | 2008.5 ms | 2007, 2007, 2010, 2016 |
| **hidden, audio paused (the real seam)** | **2916 ms** | 2770, 2852, 2980, **4614** |

So on this engine the 2.0 s beat becomes **2.8–4.6 s** when it runs in a hidden
page — a 1.4–2.3× stretch. Audible, and it reads as a stall rather than as an
edit, but it is not fatal: the beat still ends and the Foray still advances.

**4.3 — The real out-point, in the real module.** The shipped
`player/html-audio-backend.js` imported unmodified, out-point armed 6 s ahead,
reporting the backend's own `lastOutPointOvershootSec`:

| phase | n | overshoot |
|---|---|---|
| visible | 3 | 0.012, 0.015, 0.016 s |
| hidden, audible | 2 | **0.010, 0.031 s** |

**The out-point keeps its ~14 ms-class precision in a hidden page as long as
audio is playing** — a measurement of our own shipped code rather than of a toy.
It is the most reassuring number here, and the honest caveat is that **n = 2**:
this is the same run §4.4 describes, in which three of five reps failed to load
at all. Two clean samples show the mechanism survives page-hiding; they do not
establish a distribution.

> **4.4 IS EXPLAINED NOW — see §4.1a.** The cause it says is unknown is
> visibility-throttled media load tasks: a hidden-page load takes ~11 s on iOS
> against this same 10 s deadline, measured in run 32057395270. The paragraph
> below is left exactly as written, because its reasoning about what it could and
> could not conclude was correct and is worth keeping.

**4.4 — One thing this pass could not explain, recorded so nobody builds on it.** In the
same run, 3 of 5 hidden reps failed with `load ... did not settle within
10000ms` — the backend's own `LOAD_SETTLE_TIMEOUT_MS` rejecting, which in the
real player routes to the manager's degrade path and drops the segment. The
failures were the *last* three reps, in order. The obvious hypothesis was
Chromium's documented 30-second post-audio grace window expiring (§5.2), but
that does not survive arithmetic: each rep played ~6 s of audio with only ~2 s
of silence between, so 30 s of continuous silence never accumulated. **The cause
is unknown.** It may be an artifact of the probe reusing one element across
fresh URLs against a server with no range support. **It is not evidence about
the player and nothing in this document's conclusions rests on it.** If someone
wants it settled, the honest next step is a fresh probe that varies one thing.

---

## 5. Android — the documented mechanism

Two layers must both cooperate. Chromium's is on our side; Android's is not.

### 5.1 The WebView is not paused for us, and Capacitor does not pause it

`WebView.onPause()` — "Does a best-effort attempt to pause any processing that
can be paused safely... **Note that this call does not pause JavaScript.** To
pause JavaScript globally, use `pauseTimers`."
`pauseTimers()` — "Pauses all layout, parsing, and JavaScript timers for all
WebViews. **This is a global requests, not restricted to just this WebView.**"
([WebView reference](https://developer.android.com/reference/android/webkit/WebView))

Neither is called by the framework on your behalf. **Capacitor does not call
either one by default — but it ships a code path that does, and it is one config
key away.** Read off the installed `@capacitor/android` **8.5.0** source, not
GitHub's `main`:

- `Bridge.onPause()` (`Bridge.java:1358`) notifies plugins, then — if a Cordova
  compat web view exists — calls
  `cordovaWebView.handlePause(shouldKeepRunning() || ...)`.
- `shouldKeepRunning()` (`Bridge.java:457`) is
  `preferences.getBoolean("KeepRunning", true)` — **default `true`**.
- `MockCordovaWebViewImpl.handlePause()` (line 124): *"If app doesn't want to run
  in background"* → `if (!keepRunning) this.setPaused(true);`, whose comment
  reads **"Pause JavaScript timers. This affects all webviews within the app!"**
- `setPaused(true)` (line 271) is exactly `webView.onPause(); webView.pauseTimers();`

So the default is safe, and the failure mode is precise: **setting the Cordova
preference `KeepRunning` to `false` calls `pauseTimers()` on every
backgrounding, process-wide, and every out-point in the app stops firing.** That
is a one-line config change with a plausible-sounding name — someone reading
"keep running" as "keep polling in the background, which we don't need" would
turn it off to save battery and silently break segment playback. Write it down
in #36 rather than discovering it.

(Also verified in the same source, and it is why the spike needed no synthetic
tap: `Bridge.java:586` sets `settings.setMediaPlaybackRequiresUserGesture(false)`,
so audio autoplays in the Android shell.)

### 5.2 Blink exempts an audible page from throttling *and* from freezing

This is why §4's measurements come out the way they do, and it is in source, not
in a blog post.
[`frame_scheduler_impl.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/scheduler/main_thread/frame_scheduler_impl.cc):

```cpp
const bool page_can_be_throttled_intensively =
    !parent_page_scheduler_->IsAudioPlaying() &&
    !parent_page_scheduler_->IsPageVisible();
const bool frame_can_be_throttled_background =
    !AreFrameAndPageVisible() && !parent_page_scheduler_->IsAudioPlaying() && ...
```

`IsAudioPlaying()` gates both. And
[`page_scheduler_impl.h`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.h)
carries the grace window verbatim:

```cpp
// A page cannot be throttled or frozen 30 seconds after playing audio.
static constexpr base::TimeDelta kRecentAudioDelay = base::Seconds(30);
```

**Our 2.0 s seam beat therefore sits inside a 30-second grace window with 15×
headroom.** The beat does not cost us the keep-alive. That is the answer to the
most specific worry about the shell, and it is a documented constant rather than an
inference.

Throttle levels when the exemption *is* lost
([Chrome 88 post](https://developer.chrome.com/blog/timer-throttling-in-chrome-88),
[background tabs](https://developer.chrome.com/blog/background_tabs)): once per
**second** for a hidden page; once per **minute** ("intensive") after 5 minutes
hidden *and* 30 s silent *and* a timer chain ≥ 5. Also: *"Applications playing
audio are considered foreground and aren't throttled"* — and **"a silent audio
track doesn't count"**, which kills the classic silent-WAV keep-alive hack
before anyone proposes it.

A backgrounded WebView reports `hidden`, and it is the same scheduler: traced
`AwContents.onWindowVisibilityChanged` → `updateWebContentsVisibility` →
`Visibility.HIDDEN`, with `BrowserViewRenderer::IsClientVisible()` returning
false once the window is not visible. **No WebView-specific bypass exists**, so
§4's numbers are the right engine.

### 5.3 Android's OS rules are where the shell actually fails

- **Foreground service type is mandatory from Android 14.** *"Beginning with
  Android 14 (API level 34), you must declare an appropriate service type for
  each foreground service."* For us that is `mediaPlayback` +
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, which has **no runtime prerequisites**
  and — unlike `dataSync`/`mediaProcessing` — **no runtime timeout**
  ([fgs](https://developer.android.com/develop/background-work/services/fgs),
  [types](https://developer.android.com/develop/background-work/services/fgs/service-types),
  [timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)).
- **Android 15 makes it hard, not just advisable.**
  [Audio focus](https://developer.android.com/media/optimize/audio-focus): *"If
  an app targets Android 15 (API level 35) or higher, it cannot request audio
  focus unless it's the top app or running a foreground service."* Capacitor 8
  generates `targetSdkVersion = 36`, so **we are squarely inside this rule from
  the first build.**
- **A cached process is frozen, and audio is not on the list of things that
  saves you.** The [cached apps freezer](https://source.android.com/docs/core/perf/cached-apps-freezer)
  migrates cached processes into a frozen cgroup where *"all of its threads are
  suspended and can't perform CPU work until unfrozen."* The documented
  [importance ladder](https://developer.android.com/guide/components/activities/process-lifecycle)
  is foreground → visible → service → cached, and a `startForeground()` service
  confers **visible**. **Playing audio appears nowhere in that ladder.** That a
  `mediaPlayback` FGS prevents freezing is an *inference* from those two facts —
  well-founded, but AOSP does not say it in one sentence.

### 5.4 `navigator.mediaSession` is disabled in Android WebView, by design

Not missing, not buggy — switched off.
[`aw_main_delegate.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/lib/aw_main_delegate.cc):

```cpp
// WebView does not support MediaSession API since there's no UI for media
// metadata and controls.
cl->AppendSwitch(switches::kDisableMediaSessionAPI);
```

Corroborated by WebView's own web-exposure expectations
(`not-webview-exposed.txt`: *"Media Session API is not enabled in Android
WebView"*, `getter mediaSession`, `interface MediaSession`).

**NOT confirmed live, and this sentence used to say it was.** It read *"Confirmed
live: the spike logs `mediaSession present=` on startup — see §6"* — but §6 records
that the spike **never ran** and that not one line was ever logged, so the
instrument existed and no reading was ever taken. Corrected by #37 (the Android
build), which looked for a way to settle it and could not: the switch is appended by
the WebView provider's own main delegate, so **no Capacitor config,
`gradle.properties` line or manifest flag can turn it back on**, and confirming its
absence still needs execution in the shipped WebView. **This claim remains
source-derived** — strong, and not a measurement. `HUMAN-ACTIONS.md`'s Android
device pass is what would close it.

**This is the finding with the biggest scope consequence in the document**, and
it has nothing to do with backgrounding. #27 (lock-screen and steering-wheel
controls) **cannot be delivered in the Android shell from JS at all.**
`04_VOICE_AUDIO_SPEC.md` calls those controls *"the baseline hands-free
interface"* that *"must be flawless before any voice work"*, so this is not a
nice-to-have that can wait for #28 as an optimisation.

### 5.5 Is there a maintained plugin?

Short answer: **not for keeping WebView `<audio>` alive.**

| Package | Latest | Published | Peer `@capacitor/core` | Fit |
|---|---|---|---|---|
| `@jofr/capacitor-media-session` | 4.0.0 | 2024-08-08 | `^6.0.0` | Exactly our problem — polyfills `mediaSession`, runs an FGS for WebView audio. **Stale: Capacitor 6 only.** Needs a fork |
| `@capawesome-team/capacitor-android-foreground-service` | 8.1.0 | 2026-03-17 | `>=8.0.0` | Current. Generic FGS, no media controls |
| `@mediagrid/capacitor-native-audio` | 3.0.0 | 2026-01-23 | `>=8.0.0` | Current, and declares `mediaPlayback` itself — but it plays **natively**, i.e. it is #28, not a shell fix |

So the honest options are: fork a two-year-old plugin forward, bolt a generic
FGS onto WebView playback and still write native code for the notification, or
do #28's Android half properly.

---

## 6. Android — the emulator attempt, and why it produced nothing

**Read this before treating any Android number in this document as a device
measurement. There is no device measurement.** The plan was to answer the Android
half empirically rather than from documentation, the whole toolchain was
installed and the app was built, and the emulator then failed to boot into a
usable state. That is recorded here in full rather than quietly dropped, because
a spike that reports "measured" when it means "intended to measure" is exactly
the failure mode this repo keeps paying for.

### 6.1 What was built, and what it cost

No Android Studio, no admin rights, nothing outside the user profile, and no
system or security settings changed — WHPX was already available
(`emulator -accel-check`: *"WHPX(10.0.26200) is installed and usable"*), so the
emulator needed no Windows-features change.

| | |
|---|---|
| Toolchain | Android command-line tools `11076708`, platform-tools, build-tools 36.0.0, platform android-36, emulator + `system-images;android-36;google_apis;x86_64` |
| JDKs | Microsoft OpenJDK **17.0.13** *and* **21.0.12** |
| Capacitor | **8.5.0** (`@capacitor/core`, `cli`, `android`), Gradle 8.14.3, AGP 8.13.0 |
| Emulator | AVD `mp1avd`, Pixel 6 profile, **API 36 (Android 16)**, 3 GB RAM, audio output on, cold boot |
| App under test | throwaway Capacitor app importing the **real** `player/html-audio-backend.js`, `player/queue-state.js` and `player/seam-gap.js`, unmodified |
| Audio | two locally generated 15-minute WAV tones bundled in the app — no network, because every podcast CDN in the source registry is unreachable from this machine |
| Disk | **15.5 GB measured** (11.31 GB SDK+JDKs, 3.09 GB AVD images, 0.92 GB Gradle cache, 0.18 GB project) |

Two traps worth recording so the next person does not pay for them twice:

- **Capacitor 8 requires JDK 21.** Building with JDK 17 fails at
  `:capacitor-android:compileDebugJavaWithJavac` with `invalid source release:
  21`.
- **Capacitor 8 generates `compileSdkVersion = targetSdkVersion = 36`.** The API
  34 platform and system image downloaded first were wasted. Go straight to 36 —
  and note this means **an app built from Capacitor's own template is inside
  Android 15's audio-focus restriction from the very first build** (§5.3), which
  is why the emulator was API 36 rather than something older and more permissive.
- A third, unrelated to Android: `local.properties` is a Java properties file, so
  `sdk.dir=C:\Users\...` silently loses its backslashes and produces
  *"The filename, directory name, or volume label syntax is incorrect"*. Use
  forward slashes.

The intended method — worth writing down, because it is what `HUMAN-ACTIONS.md`
item #11 or a future
session should run rather than re-derive: launch, then `adb shell input keyevent
KEYCODE_HOME` to background the app, then `KEYCODE_SLEEP` to lock the screen,
then an 11-minute soak with the screen off, reading every `MP1|` line out of
`adb logcat`. The page logs its own timings — the real backend's
`lastOutPointOvershootSec` per out-point, the real seam beat's true length, a
1 Hz heartbeat reporting both its own interval and how far the playhead moved, so
"JS is throttled" and "audio stopped" stay distinguishable. **No foreground
service, no plugin, no `UIBackgroundModes` equivalent** — a stock Capacitor
shell, which is the configuration #34 proposes.

### 6.2 How far it got, and where it stopped

Everything up to the device worked:

- ✅ SDK, JDKs, emulator and both system images installed; `emulator -accel-check`
  reports WHPX usable.
- ✅ Capacitor 8.5.0 project scaffolded, `npx cap add android` clean.
- ✅ **APK built** — 32.9 MB, containing our real `html-audio-backend.js`,
  `queue-state.js` and `seam-gap.js` plus the two tone files.
- ✅ AVD created (API 36, Pixel 6 profile, 3 GB RAM, audio on); `adb` sees the
  device and it reaches `state: device` with `ro.build.version.sdk=36`,
  `ro.build.version.release=16`.
- ✅ APK **pushed** to `/data/local/tmp` (32,942,642 bytes at 14.6 MB/s).
- ❌ **`pm install` never succeeded.** The framework answers
  `cmd: Can't find service: package`, then `Error: device is still booting`,
  and does not progress. `sys.boot_completed` never becomes `1`. Attempts:
  windowed with `-gpu swiftshader_indirect` (~20 min), headless with `-gpu off`
  and `-wipe-data` (~20 min), and a third window of waiting on the first AVD —
  during which qemu accumulated **~15 minutes of CPU time**, so it was working,
  just not arriving. An API 34 image was created as a fallback and abandoned when
  the API 36 device finally reached `state: device` after roughly 35 minutes,
  still without a usable framework.

So the app never ran, no `MP1|` line was ever logged, and **every checkbox in
of #35's report template that needed a running Android app is unanswered by
measurement.** The cause looks like the API 36 (Android 16) x86_64 image being
pathologically slow under WHPX on this host; it is not a defect in the app, which
was never given the chance to fail.

### 6.3 What this does and does not change

**It does not change the Android conclusions**, because none of them rested on
the emulator:

- The Blink half — timers unthrottled while audible, collapsing when silent, and
  the real out-point holding 0.010–0.031 s — is **measured** in §4, on Chromium.
  §5.2 traces in source that Android WebView uses the *same* `PageSchedulerImpl`
  and `FrameSchedulerImpl` with no WebView bypass, and that a backgrounded
  WebView reports `hidden`.
- The OS half — foreground-service requirement, the Android 15 audio-focus rule,
  the cached-app freezer — is **documented** (§5.3), and an emulator would have
  been poor evidence about it anyway (§6.4).
- MediaSession being unavailable is **source-verified** (§5.4). The spike would
  have confirmed it with one log line; it does not depend on that.

**What is genuinely still open** is the one thing only a real Android app can
show: whether *app-level* backgrounding and screen lock behave like *tab*
hiding. Blink's audibility exemption is about page visibility; HOME and a locked
screen additionally involve the Activity lifecycle and the OS. §4's evidence is
about the engine, and the engine is only one of the two layers. **That is the
gap, and it is named in `HUMAN-ACTIONS.md` #11.** Be precise about what closes
it: that item's five-minute version is a *browser tab* on a phone, which is
informative about the engine but **cannot** settle app-level backgrounding — §2
says outright that a browser tab is not subject to it. Only the build version of
that item closes this.

**Practical note for #38 (the CI-runner work), which is the useful residue:** a
cold API 36 emulator boot did not complete in ~35 minutes on a 13th-gen i7 with
WHPX. If any CI job is ever expected to boot an Android emulator, budget for
that, pin an older API level, or use a snapshot — and do not assume a laptop can
do it interactively.

### 6.4 An emulator is not a phone, and here is exactly where that bites

Stated plainly because the whole Android conclusion depends on it. The emulator
runs a full Android build, so the **Chromium** layer (§5.2) is faithful: same
WebView, same page scheduler, same audibility rule. What it does **not**
faithfully reproduce is the layer that actually decides the Android answer:

- **Power management.** The emulator is effectively always on external power and
  never stationary, so **Doze never engages**. A real phone in a pocket, off
  charger, is the case that matters and it was not tested.
- **The cached-app freezer.** Whether the OS actually SIGSTOPs our process
  depends on memory pressure and OEM policy. A 3 GB emulator with one app
  running has no reason to reclaim anything, so a pass here says very little
  about a phone with 40 apps installed.
- **OEM battery managers.** Samsung, Xiaomi and others kill background audio far
  more aggressively than AOSP. This is untestable on any emulator by
  construction.
- **Audio focus in practice** — ducking for a call, a notification, another
  media app — needs real audio routing and a real telephony stack.
- **Bluetooth and car head units.** Not testable at all here. #28 says it
  outright — *"a simulator will not surface the route-change and HFP/A2DP
  behaviour that matters"* — and `docs/brief/01_PROMPT.md` calls audio-session
  choreography including *"Bluetooth route changes (car off/on)"* **"the
  highest-polish-risk area"**, to be prototyped *"before building UI around it"*.
  `05_CORNER_CASES.md` #24 asks to *"verify per-car behavior"*. None of that is
  satisfiable without hardware.

So an emulator pass would have been **necessary but not sufficient**: it can show
a mechanism works, and it cannot show the OS will leave us alone. Since this one
never ran (§6.2), even the necessary half is outstanding. That is
`HUMAN-ACTIONS.md` #11.

---

## 7. iOS — the documented mechanism. **Never executed.**

Windows cannot build or run an iOS app, so **every claim in this section is read
off Apple's documentation and WebKit's source. None of it is measured** — treat
every sentence below as documentation-derived until someone runs it on a device
(`HUMAN-ACTIONS.md` #11).

### 7.1 Apple: `.playback` survives the lock screen; backgrounding needs the key

[`AVAudioSession.Category.playback`](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback),
verbatim:

> "When using this category, your app audio continues with the Silent switch set
> to silent or when the screen locks. ... To continue playing audio when your app
> transitions to the background (for example, when the screen locks), add the
> `audio` value to the UIBackgroundModes key in your information property list
> file."

And the default, if nobody configures a session
([Audio Session Programming Guide](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/AudioSessionBasics/AudioSessionBasics.html)):
*"In iOS, when the device is locked, the app's audio is silenced."* So the
category is not optional — it is just not ours to set (§7.3).

### 7.2 WebKit: a plain `<audio>` element is deliberately exempt

[`MediaSessionManagerIOS.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/MediaSessionManagerIOS.mm),
`resetRestrictions()`:

```cpp
addRestriction(MediaType::Video,      BackgroundProcessPlaybackRestricted);
addRestriction(MediaType::WebAudio,   BackgroundProcessPlaybackRestricted);
addRestriction(MediaType::VideoAudio, { ConcurrentPlaybackNotPermitted, BackgroundProcessPlaybackRestricted, SuspendedUnderLockPlaybackRestricted });
```

`MediaType::Audio` is **absent** — no background restriction, no
under-lock restriction. And `HTMLMediaElement::mediaType()` resolves a plain
`<audio>` element to exactly `MediaType::Audio`. This is the clean answer to the
`<audio>`-versus-`AudioContext` confusion that fills the forums: **`<audio>` is
allowed to continue; Web Audio is deliberately killed.** We use `<audio>`, and
`html-audio-backend.js` already documents (for CORS reasons) that Web Audio
cannot touch our element — which turns out to be a second, unrelated reason that
choice was right.

### 7.3 WebKit sets the audio session category itself

[`MediaSessionManagerCocoa.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm),
`updateSessionState()`: an audible audio element ⇒
`AudioSession::CategoryType::MediaPlayback` (= `AVAudioSessionCategoryPlayback`);
Web Audio ⇒ `AmbientSound` (silenced in background).

**So #35's own method section was wrong on one point, and it is the point that
saves the most work.** It says the `.playback` category must be *"activated
natively (this cannot be reached from page JS — a small plugin or AppDelegate
edit is needed)"*. WebKit already does it. No plugin, no `AppDelegate` edit, no
Swift. **The only missing piece is the `UIBackgroundModes: audio` key** — which
is a one-line Info.plist edit in the generated project, and Capacitor has no
config option for it (their docs say nothing about background audio at all).

Capacitor also already sets the media flags favourably —
`CAPBridgeViewController.swift` sets `allowsInlineMediaPlayback = true` and
`mediaTypesRequiringUserActionForPlayback = []` — so autoplay gating is not a
problem either.

### 7.4 Why the app must hold the background mode: the assertion is Safari-only

[`WebPageProxy::updateThrottleState()`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)
takes a **foreground** assertion on the WebContent process whenever the page is
audible — *"UIProcess is taking a foreground assertion because we are playing
audio"* — on a branch independent of view visibility, released only after a
10-second grace (`audibleActivityClearDelay = 10_s`).
**CORRECTION, 2026-08-17, measured — this constant is wrong.** Run 32036295743's
simulator log shows WebKit starting the clear timer at **5 seconds** ("Starting timer
to clear audible activity in 5 seconds because we are no longer playing audio") and
`clearAudibleActivity` firing 5.006 s later. The 10 s figure in this paragraph is a
*different* timer — `WebPageProxy::updateThrottleState` releasing the foreground
assertion. Both appear in that log, seconds apart, and conflating them made a 9.15 s
measured silence look like a near-miss when it had already crossed the real
threshold. §0b carries the corrected reading. `takeAudibleActivity()`
is literally `throttler()->foregroundActivity("View is playing audio")`, and
`ProcessThrottler` only suspends a process with no activities. **So the web
process is not suspended while audio plays, and JS keeps running.** (That last
step — foreground throttle state ⇒ timers keep firing — is a short inference,
not an Apple sentence.)

But the assertion WebKit takes on **the host app's own process** is gated:

```cpp
bool shouldTakeUIProcessAssertion = WTF::processHasEntitlement("com.apple.runningboard.assertions.webkit"_s);
```

Safari has that private entitlement. **A Capacitor app cannot get it.** So
WebKit will keep its own child process alive but will not keep *our app* alive —
and that is exactly the gap `UIBackgroundModes: audio` fills.

Also worth recording because it makes most of the internet obsolete:
[WebKit bug 232909](https://bugs.webkit.org/show_bug.cgi?id=232909) (fixed,
shipped ~iOS 15.4) is what made cross-process audio assertions work for
WKWebView. **Pre-iOS-15.4 reports that "WKWebView audio dies in the background"
predate the fix and should be discarded** — including the Apple Developer Forums
threads that dominate search results.

### 7.5 The iOS-specific catch: hidden-page timers are aligned to 1 second

[`Page.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Page.cpp)
`updateTimerThrottlingState()` sets `m_domTimerAlignmentInterval =
DOMTimer::hiddenPageAlignmentInterval()`, and
[`DOMTimer.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/DOMTimer.h):

```cpp
static constexpr Seconds defaultAlignmentInterval() { return 0_s; }
static constexpr Seconds hiddenPageAlignmentInterval() { return 1_s; }
```

(`DOMTimer.cpp` also carries `minIntervalForNonUserObservableChangeTimers = 1_s`,
*"Empirically determined to maximize battery life."*)

**This is the concrete, iOS-only defect the shell would introduce, and §8 works
out what it does to us.** Whether `hiddenPageDOMTimerThrottlingEnabled` defaults
on in WKWebView could not be verified — WebKit's preference YAMLs have moved —
so the 1 s figure is "the value used when throttling is enabled", not
"guaranteed to apply". Unverified, and the reason §8 gives a range.

---

## 8. What §4–§7 do to *our* out-point and *our* seam beat

This is the part that is specific to Foray and the reason the spike could not
have been a bare `<audio>` element.

**Android: the out-point should be fine while audio plays.** The engine-level
evidence is measured (§4.1, §4.3 — timers unthrottled while audible, real
overshoot 0.010–0.031 s), and Blink's exemption is not "roughly": it is
`IsAudioPlaying()` gating the throttle decision outright, in the same scheduler
Android WebView uses (§5.2). **But that was measured on desktop Chromium with a
hidden tab, not on Android with a backgrounded app** — the engine is one of two
layers, and §6.2 is why the second one is untested. On the engine's behaviour,
mode 2 — the 15.6-minute-median disaster of §3 — should not occur on Android
while the app is alive. What kills Android is the OS layer (§5.3): frozen, or
denied audio focus. That is mode 1, which at least fails honestly.

**iOS: the out-point degrades but does not collapse.** Two stages, and they fail
differently:

- The **fine** stage is a DOM timer, so under §7.5 it is aligned to ~1 s. Its
  contribution to precision is gone in the background.
- The **coarse** stage runs on `timeupdate`, which is a **media event driven by
  WebCore's own playback-progress timer, not a `DOMTimer`** — so DOM-timer
  alignment should not apply to it, and it should keep firing at its usual
  ~4 Hz. ~~**This is inference, and it is the single most load-bearing untested
  claim in this document.**~~ **MEASURED AND HELD** — 61 hidden samples at a
  **252 ms** median in the iOS Simulator, run 32026332637 (§0b). The fine stage's
  1 s alignment was confirmed in the same run, so both halves of this paragraph
  are now measurements rather than predictions.
- And the design helps: `html-audio-backend.js`'s stop is *"never early, at any
  rate, under any stall"* — the fine timer re-reads `currentTime` and
  reschedules rather than trusting its own prediction. A late wake overshoots; it
  never cuts short.

So the expected iOS overshoot is **one `timeupdate` interval (~0.25 s) if that
event survives, up to ~1 s if only the aligned timer does** — against 14 ms
today. That is a real regression, and it is one sentence of the next speaker
bleeding into a transition, not 15.6 minutes of the wrong episode. **Tolerable
with a caveat; nothing like the failure §3 measures.**

> **MEASURED, 2026-08-17 (§0b): 0.0045 s.** Better than both predictions above,
> because `timeupdate` kept its 252 ms rate AND the fine stage's re-read-and-stop
> design did the rest. The paragraph below this one — the load inside the beat —
> is now the open question, not this one.

**The seam beat is safe on both engines, and this was the specific worry.** The
beat pauses the element for 2.0 s, which withdraws the audibility that everything
above depends on — but both engines carry a grace window far longer than the
beat: **30 s** on Chromium (`kRecentAudioDelay`, §5.2) and **10 s** on WebKit
(`audibleActivityClearDelay`, §7.4 — **but see §7.4's correction: the measured
value is 5 s, not 10 s**). 2.0 s against the smaller of those is **2.5×** headroom,
not the 5× this paragraph originally claimed. Measured on Chromium (§4.2) the beat stretches to 2.8–4.6 s in a
hidden page; on iOS, 1 s alignment predicts 2–3 s. **Longer than authored,
audible as a slightly baggy pause, not a stall and not a stop.** Nobody needs to
redesign the beat for backgrounding.

One genuine risk remains and it is worth naming: the beat's 2.0 s is *silence
plus the next item's load*. `LOAD_SETTLE_TIMEOUT_MS` is 10 s VISIBLE and **20 s HIDDEN** as of 2026-08-17 (§4.1a) — so the window below is ~22 s in the hidden case this section is about, which makes the risk it describes WORSE, deliberately: a slow seam beats a dropped segment. A slow
cross-episode advance (16 of Foray #1's 31 seams) can extend the silent window to
~12 s. That is still inside Chromium's 30 s but **outside WebKit's 10 s
audible-activity grace** — so on iOS a slow advance could drop the foreground
assertion mid-transition. Unmeasured. Worth a device check, and cheap to
mitigate if real (start the load before pausing, or hold a short silent
keep-alive during a load — noting that a *silent* track buys nothing on
Chromium).

> **THIS IS THE PARAGRAPH THE SEAM PROBE WAS BUILT FOR** (#28's iOS half,
> `tools/mobile/probe/probe-seam.js`). It drives three bounded segments across three
> files through the real `PlayerQueueManager` and reports, per transition, whether
> the beat fired, whether the next file loaded, and whether it became audible —
> all with the app backgrounded and never resumed. Two completed hidden
> transitions are required before it will call the seam sound, because one can
> succeed inside the 10 s grace window and the next still fail once the page has
> been silent through a beat.
>
> Its limit, stated with every verdict: the next segment is a **local bundled
> file**. Product principle #3 forbids reusing episode audio and the probe page's
> CSP is `media-src 'self'`, so the *cold cross-origin fetch* half of this
> paragraph's risk is still unmeasured. What the probe settles is the beat's timer
> and a fresh media load; what it cannot settle is DNS + TLS + a range request
> into someone's CDN while hidden.

---

## 9. Recommendation

**Build the Capacitor shell and keep the web player. Do not treat #28 as a
deferred optimisation, and do not put it on the critical path before the shell.**
Concretely:

1. **#36 (MP2 scaffold) is unblocked and should proceed.** Nothing found here
   changes its shape. It gains two small, concrete requirements (§10).
2. **iOS background audio costs one Info.plist key.** Not a plugin, not Swift,
   not #28. That is the biggest single saving in this document, and it is why the
   epic's premise — "wrap the web app" — survives.
3. **Android background audio needs native code that does not exist.** A
   `mediaPlayback` foreground service is mandatory in principle (§5.3) and no
   maintained plugin supplies it for WebView playback (§5.5).
4. **Android lock-screen controls are impossible from JS at any price** (§5.4).
   This, not backgrounding, is what forces native work on Android.

Points 3 and 4 together are the strategic finding: **once you are writing a
Media3 `MediaSessionService` for Android — which #27 forces you to do regardless
— you have built most of #28's Android half.** A foreground service that exists
only to keep *WebView* audio alive, while a separate native MediaSession
round-trips notification taps back into JS, is the worst of both worlds: two
sources of truth for transport state, and a known-fragile shape (the stale
`@jofr` plugin exists precisely because this is hard).

There is also a second, independent argument for #28 that has nothing to do with
backgrounding, and it deserves to be on the record because it did not appear
in #28's own justification: **a native player enforces an out-point in the media
pipeline rather than on a JS timer.** `AVPlayer` boundary time observers and
Media3's `ClippingMediaSource` / `MediaItem.ClippingConfiguration` remove the
entire class of defect that `html-audio-backend.js`'s careful two-stage watch
exists to work around. Our product is *segments*, so this is not a detail.

**So: "works on one", and the split is platform-specific.**

- **iOS** — shell + `HtmlAudioBackend` is genuinely viable. ~~Gate: measure the
  `timeupdate` claim in §8 on a device before believing it.~~ **Gate cleared in
  the iOS Simulator, 2026-08-17 (§0b): 0.0045 s overshoot over a 15.056 s hidden
  window, app never resumed. The remaining gate is the TRANSITION, not the stop
  — probe phase C, #28's iOS half.** A device measurement is still wanted
  (`HUMAN-ACTIONS.md` #11); a Simulator pass is weaker evidence than a Simulator
  failure would have been.
- **Android** — shell + `HtmlAudioBackend` is viable for an *internal* build and
  for validating everything else in #36/#40, but **not for a Play release**.
  Android's `NativeAudioBackend` should land before any store submission.

That inverts #34's stated sequencing ("Google Play first, iOS submission gates
on #20"). On background audio alone, **iOS is the easier platform and Android is
the harder one.** #34's Play-first argument rests on 4.2 review leniency and on
Android building on Windows, both still true — so this does not overturn it, but
whoever owns that decision should know the audio picture points the other way.

**A web-first app that is honest about backgrounding is shippable in the
meantime, and is what exists today.** The browser has no app-level backgrounding
problem: a tab playing audio keeps its timers (§4). The web app is therefore not
blocked by any of this, and nothing here argues for slowing it down.

---

## 10. Consequences for the other MP issues

| Issue | Status change |
|---|---|
| **#35** (this spike) | **Answered from source and documentation, not from a device** — the emulator attempt is reported in §6.2. **Left open rather than closed** — this file is the verdict, and closing the issue is a founder's call |
| **#36** MP2 scaffold | **Unblocked, proceed.** Two additions: (a) add `UIBackgroundModes: audio` to `ios/App/App/Info.plist` — one line, no plugin; (b) do **not** let anything call `WebView.pauseTimers()`, which is process-global and would kill every out-point. Also note Capacitor 8 generates `targetSdkVersion = 36`, which puts the app inside Android 15's audio-focus rule from the first build |
| **#28** WP8 `NativeAudioBackend` | **Re-scoped, and split by platform. iOS half further narrowed by measurement, 2026-08-17 (§0b): the out-point fires backgrounded at 0.0045 s overshoot with the app never resumed, so a native stop-owner for iOS is NOT justified — the only iOS question left open is the seam TRANSITION, which probe phase C measures.** No longer justified by *background audio on iOS* — that costs one plist key. Still mandatory for **Android**, now for three converging reasons: the foreground service (§5.3), MediaSession being impossible in WebView (§5.4), and downloads (#29). **Android half moves onto the critical path for a Play release; iOS half can lag.** Add the out-point argument above to its rationale, and note the ADR it must write is already named ADR-0007 in the issue but that number is taken (segment anchoring) — it needs a new number |
| **#27** WP7 MediaSession | **Materially changed, and it is the biggest surprise.** The plan is "wire the MediaSession API in the web client". That works on the **web** and is **impossible in the Android shell** (§5.4). So #27 splits: the web implementation stays as specified; lock-screen/steering-wheel controls *in the app* become native work owned by #28's Android half. #27's existing acceptance criterion "iOS Safari behaviour is **tested and documented in a comment on this issue**" should be widened to "and WKWebView-in-Capacitor, and Android WebView", because those are three different answers |
| **#29** WP9 downloads | **Unchanged.** Still native-only, still blocked on #28, still for the CORS reason already recorded. This spike adds a mild reinforcement: on Android the download must survive backgrounding, which is the same foreground-service machinery #28 introduces |
| **#40** MP6 data freshness + durable storage | **Its web half landed in #204 while this spike ran** (`player/durable-store.js`, `player/idb-tier.js`, `docs/durable-storage.md`), and that document already names the remainder as *"iOS `WKWebView` storage is not durable by default, which is the 'app tomorrow' half of #40"* — nothing here changes that design. Two additions to its test matrix from this spike: a **force-stop and a storage-pressure simulation while backgrounded**, since §5.3's freezer/kill path is a way to lose in-flight state the issue does not consider; and note that a **frozen process cannot flush a pending write at all**, which is a different failure from eviction and is not covered by the localStorage mirror |

**Nothing here is a founder decision that this document can make.** The two that
need one are recorded in `HUMAN-ACTIONS.md` (#11: run the device tests; #12: the
Android-native-before-Play-release sequencing call).

---

## 11. What would change this document's mind

Ranked by how cheaply each could overturn a conclusion:

1. **`timeupdate` on a backgrounded iOS WKWebView.** If it is throttled, §8's
   "tolerable regression" becomes §3's disaster and iOS needs `NativeAudioBackend`
   too. One device, ten minutes, one log line.
2. **A real Android phone under Doze with the screen off for an hour.** No
   emulator can answer whether the process survives (§6.4), and ours never even
   booted (§6.2) — so both halves of the Android question are open on hardware.
3. **Whether a `mediaPlayback` FGS actually prevents the freezer** — inferred in
   §5.3, not documented in one sentence.
4. **A slow cross-episode advance against WebKit's 10 s grace** (§8's last
   paragraph).
5. **Bluetooth and car transport buttons**, on both platforms. Completely
   untested here; #35's report template asks for it and this document cannot
   answer it. #28's acceptance criteria demand testing *"in an actual car over
   Bluetooth"*, on the grounds that *"a simulator will not surface"* it.

---

## Appendix — reproducing the measurements

The probe scripts are **deliberately not committed**: #35 says the spike's code
is expected to be deleted, and a throwaway harness in `tools/` would need a
floor in `test/suite-integrity.test.js` and would then be maintained forever.
They lived in the session scratchpad. What is committed is this document and the
numbers in it. To rebuild them:

- **§3 (overrun)** is pure repo data and needs no harness: resolve each Foray
  with `player/foray-resolve.js` and take `reference_duration_sec − end_sec` over
  `resolveForay().playable`.
- **§4 (Blink timers)** needs a local HTTP server, a generated tone, a page that
  reports timer intervals via `sendBeacon`, and a second tab to hide the first.
  Chromium flags used: `--autoplay-policy=no-user-gesture-required`,
  `--user-data-dir=<throwaway>`, `--disable-features=CalculateNativeWinOcclusion`.
- **§6 (Android)** is described in §6.1, including the exact toolchain versions
  and disk cost.
