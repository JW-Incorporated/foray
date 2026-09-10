# DAI shows at playback: what the 4a app does today, and what "pad the timing" would take

> Companion brief to `docs/curation/foray-to-spec-roadmap.md` (the Hermes G-deck, 2026-09-10). Numbers here are the deck's sources; the deck cites this file by section.

Repo: `foray`, branch `generation-run-2026-09-09`, read-only pass 2026-09-09.
Every number below is tagged **[measured]** (read from committed data or run against it in this pass), **[derived]** (arithmetic on measured numbers), or **[inferred]** (a judgement, or an ADR's own inference).

Founder question: *"Why do we still exclude DAI-suspected shows? I thought we had a workaround there. What if we just pad the timing a little bit? Ignoring all DAI shows seems too blunt."*

Short answer: the workaround (content anchors) exists but is **authoring-side durability only** — nothing at playback reads an anchor. A DAI segment today is seeked to its authored timestamp, the copy's duration is compared to the reference, and if it has drifted more than 30 s the segment is **skipped, silently to the ear and loudly in the log**. "Pad a little" is already 90% built as ADR-0008's pad tier and is switched off by one option in `app.js`; but on the shows that hold the supply (Stuff You Should Know, Odd Lots, and nine more on Triton) the measured displacement is **5–16 minutes**, which no pad can cover. Only one injecting show with timed transcripts (5-4, 45 episodes) screens as paddable. The exclusion is not "all DAI shows" — eight DAI-flagged shows measured clean are the *largest* transcript source already in use.

---

## 1. What playback does with `start_anchor` / `end_anchor` today

### The chain, in order

1. **Join** — `player/foray-resolve.js:196-206` hydrates each foray item from `data/segments.json` and carries `start_anchor`, `end_anchor`, `reference_duration_sec`, `ad_pad_sec` onto the item. `resolveForay` (`:296-305`) forwards `isLocalFile` and `allowAdPad` to the queue builder.

2. **Build the queue** — `player/foray-queue.js:228` `buildForayQueue(foray, { resolveItem, isLocalFile=false, allowAdPad=false })`:
   - `:340-342` a `dai_suspected` episode is dropped unless BOTH anchors are non-empty (ADR-0007's rule).
   - `:352-364` ADR-0008 pad tier: only if `allowAdPad && raw.ad_pad_sec > 0 && episode.dai_suspected`; a pad over `AD_PAD_CEILING_SEC` (120) drops the item as LOCATE-REQUIRED; otherwise `end_sec = authoredEnd + pad` (`:404`). **The start is never moved.**
   - `:373-376` a provisional `seekPrecision()` call with no durations. A DAI + FOREIGN item comes back `approximate` here, which sets `needs_drift_check: true` (`:382`) and requires `reference_duration_sec` (`:383-388`) or the item is dropped.
   - `:412-413` `start_anchor` / `end_anchor` are copied onto the queue item. **This is the last place in the player that touches them.** Nothing downstream reads them.

3. **Load** — `player/queue-manager.js:1005-1007` the load's `startOffset` is `bounds.startSec` (the authored `start_sec`); `:1026` `backend.load(item, { startOffset })`. The element is positioned at the authored timestamp of the *reference* copy.

4. **The gate, after load** — `player/queue-manager.js:1030-1036`:
   ```js
   const gate = this._segmentGate(item);
   if (!gate.ok) { this._emit(`foray.segment.skipped.atLoad ...`); return this._skipUnplayableSegment(); }
   ```
   `_segmentGate` (`:1435-1459`) reads `this.backend.duration` — the duration of the copy the listener actually received — and calls `seekPrecision({dai_suspected}, { source: FOREIGN, observedDuration, recordedDuration: reference_duration_sec, adPadSec, allowAdPad })`. `APPROXIMATE` → skip (`:1457`). `_skipUnplayableSegment` (`:1472-1481`) advances without ever making audio audible.

5. **The policy** — `player/seek-policy.js:130-211` `seekPrecision`:
   - `:137` local file → EXACT (never true in production, see below).
   - `:139` not DAI → EXACT.
   - `:164-173` rung 3: DAI, `|observed − reference| ≤ DRIFT_TOLERANCE_SEC` (30 s, `:104`) → EXACT, "ad load matches the reference copy".
   - `:177-207` pad rung, only with `allowAdPad` + `adPadSec`; refuses if `adPadSec > 120` (`:109`) or if this copy's load exceeds the pad (`:192-201`).
   - `:210` everything else → `APPROXIMATE, "dynamic ad insertion; anchor resolution (ADR-0007 rung 4 / ADR-0008's locate step) is not implemented — segment skipped rather than played at a stale offset"`.
   - `:230-235` `locateStep()` returns `{ implemented: false }`. It is a named, tested absence; it is never called with an anchor because it takes no arguments.

6. **Production wiring** — `app.js:5188` `const forayOpts = { onChange, discoverDoc: state.discover };` spread into `player.playForay(...)` at `:5197-5198`. **No `allowAdPad`, no `isLocalFile`** → both default false (`queue-manager.js:292`, `:459`). The listener sees `"{n} segments can't play — listed below."` (`app.js:4642`, from `r.unplayable.length` at `:4562`).

7. **The backend seeks the same way regardless** — `player/html-audio-backend.js:1754-1762`: the `precise` flag from seek-policy is logged, not acted on; `el.currentTime = seconds`. On iOS, `ios/App/Player/PlayerBackend.swift:138,156` seeks with zero tolerance and has no DAI logic at all; the Capacitor plugin `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:72-73` exposes exactly one method, `setNowPlaying`.

### Is the locate step implemented anywhere? **No.** [measured]

Grep of `player/`, `app.js`, `mobile/plugins/`, `ios/`, `api/`, `backend/src` for `start_anchor|end_anchor|locate|fingerprint|chromaprint` finds only: the carry-through above, the `locateStep()` stub, `finalizeForay.ts:173-174` / `sourceBeats.ts:976-977` writing anchors at authoring time, and `segmentPoolLookup.ts:140` using anchor *text* as a topic-matching haystack. The player never fetches a transcript of the listener's copy, never fingerprints audio, and never runs ASR. The only `SFSpeechRecognizer` reference (`ios/App/Views/NowPlayingView.swift:162`) is a placeholder for voice *commands*, unrelated. `docs/ios-native-player-gap.md:237` records the same: "Anchor resolution (the locate step): Not implemented, and not faked."

### So what does a DAI segment do today?

Not "seek and hope" — **seek, measure, and refuse**. Sequence for a segment authored from a publisher transcript on an injecting show:

- `reference_duration_sec` is the feed-declared (ad-free) program length (`backend/src/generation/sourceBeats.ts:964` `candidate.entry.feed_duration_sec ?? span.endSec`; ADR-0008 lines 143-147 establish the feed and transcript both describe the ad-free master).
- The listener's copy is longer by that copy's total ad load. On the injecting shows below that is 5–16 min > 30 s, so rung 3 fails every time → `APPROXIMATE` → skipped at load. Expected skip rate on those shows: **100 %** [derived].
- On a DAI-flagged show that is *actually* clean (Being an Engineer, +0.3 s / +0.8 s measured, ADR-0008 lines 59-60), rung 3 passes → plays exactly. This is why 337 Being an Engineer transcripts sit in the tier-2 archive and play fine.
- A show injecting ≤ 30 s of pre-roll would also pass rung 3 and play up to 30 s early with up to 30 s of tail cut off — i.e. **`DRIFT_TOLERANCE_SEC = 30` is already a silent 30-second "pad the timing a little", start un-corrected, stop un-extended** [derived]. seek-policy `:100-103` says this constant must not be widened for ad padding; the pad rung is the sanctioned place.

**Shipped exposure is zero** [measured]: `data/segments.json` 212 rows, all `dai_suspected:false`, all anchored, 0 with `ad_pad_sec`; `data/segment-sources.json` 64 rows, all `dai_suspected:false` (8 rows carry `ad_pad_sec: 0`, inert — the player reads the pad from the *segment*, `foray-resolve.js:206`); `data/forays.json` 4 forays, 83 segment items, 0 on a DAI source. The whole runtime gate has never fired on real content.

---

## 2. Where `dai_suspected` is consulted, and which places still EXCLUDE

### Sourcing-time (what decides which transcripts/segments ever exist)

| Site | Behaviour | Exclude or annotate |
|---|---|---|
| `tools/segments/fetch-transcripts.mjs:168-172` `isAnchorableShow()` — `dai_suspected !== true \|\| AD_FREE_SHOWS.includes(title)`; `:177-181` `selectTargets` skips the rest unless `--all-timed` (`:358`) | The transcript fetch. Rationale at `:17-26`: "fetching them is bandwidth spent on transcripts we cannot anchor". | **EXCLUDES** — and this is the choke point. |
| `tools/segments/breadth-yield.mjs:116-118` `isAnchorable()` — same predicate, stricter on `null` | Yield reporting for the breadth tranches. | Reports; the fetch is what acts. |
| `backend/src/generation/transcriptArchiveLookup.ts:86` reads only `data/transcript-digests.json` + `data/breadth-transcript-digests.json` | Tier-2 sourcing sees only what the fetcher committed. | Inherits the exclusion. **[measured]** `transcript-digests.json`: 587 rows / 10 shows — 520 from DAI-flagged-but-measured-clean shows (Being an Engineer 337, Geology Bites 120, Practical AI 63), 67 non-DAI, **0 from any injecting show.** |
| `tools/foray/check-forays.mjs:924-929` (rule #65, relaxed in PR #571 / commit `2ea1315`) | A `dai_suspected` source is refused only when the segment has no anchor pair. | Annotate-with-condition. **Inert in practice**: no injecting-show transcript ever reaches the pipeline that would mint such a segment. |
| `tools/segments/merge-segments.mjs:310-313`, `:585-593` | Anchors required on a DAI item; `:335-341` anchor must resolve within `ANCHOR_TIME_TOLERANCE_SEC = 120` (`:123`) of its own `start_sec` (authoring self-consistency, not playback). | Annotate-with-condition. |
| `tools/segments/prepare-segment-batch.mjs:883-896` | Refuses to write a batch with a `null` verdict. | Requires a verdict; does not exclude `true`. |
| `backend/src/generation/audioSourceLookup.ts:28-33`, `:186`, `:201` | Never defaults the flag to `false`; returns `null` (beat gets narration) if no boolean verdict exists. `sourceBeats.ts:1447` records the refusal reason. | Requires a verdict; does not exclude `true`. |
| `tools/transcribe/build-transcription-queue.mjs:62-68` | "rides along as a LABEL and carries weight 0". | Annotate. |
| `tools/transcribe/fetch-audio.mjs:38`, `:264` | "reported, never acted on here". | Annotate. |
| `tools/segments/measure-suspects.mjs:966-969` `adrTier()` | "reported, never gated on". | Annotate. |
| `tools/refresh/dai.mjs:56-63`, `tools/refresh/classify-dai.mjs:104-110`, `tools/refresh/merge.mjs:138`, `backend/src/feeds/politeness.ts:101-109` | Where the flag is *assigned* — a host suffix list, redirect-resolved. Host says who *could* inject; `ad-inflation.mjs:5-9` says only the measurement says who *does*. | Assignment. |

### Playback-time

| Site | Behaviour |
|---|---|
| `player/seek-policy.js:139` | non-DAI short-circuits to EXACT; DAI enters the ladder. |
| `player/foray-queue.js:340`, `:354`, `:408` | anchor rule; pad tier; flag carried. |
| `player/queue-manager.js:1447` | passes the flag into the load-time gate. |
| `player/client.js:839-840` | scrub-note ("Timings on this show are approximate") — evaluated with `source: OWN`, so for the listener's own playhead it stays empty on a DAI show. Not about segments. |
| `app.js:627` | projection whitelist keeps the flag on pool items. |

**Net:** the only true *exclusion* left is the transcript fetch (`isAnchorableShow`). Everything downstream is annotate-or-verify, and the playback gate is a *skip*, not an exclusion — but since nothing upstream ever produces a DAI segment, the playback gate has never had to decide.

### What "all DAI shows" actually means in numbers [measured, this pass]

`data/transcript-availability.json`: 146 shows `dai_suspected:true` / 7,504 timed transcripts; 73 `false` / 67 timed; 1 `null`. **But only 20 of the 146 DAI shows ship any timed transcript.** Those 20, joined to `data/dai-classification.json` `ad_inflation.verdict`:

| verdict | shows | timed transcripts | status today |
|---|---|---|---|
| `ad-free` (measured, 2-byte ranged GET, 5 eps each, 2026-08-23) | 8 | 609 | **already fetched and playable** via `AD_FREE_SHOWS` (`fetch-transcripts.mjs:140-155`) |
| `injected` | 11 | 6,594 | excluded at fetch |
| `unknown` | 1 | 301 | excluded at fetch |

So the "blunt" exclusion is really **11 shows**, and the supply question is those 6,594.

---

## 3. Padding: what a fixed pad buys and where it breaks

### The geometry (ADR-0008 lines 169-192, 282-299) [inferred by the ADR, and the code implements it literally]

Content authored at program-time `t` sits at `t + cum(t)` in the listener's file, where `cum(t)` is the ad time inserted before `t` in *that* copy. An un-corrected seek lands **early by `cum(t)`**. A pad on the stop lets the segment run long enough to still contain the payload; it does nothing about the early start. Padding the *start* forward by an estimate is a different operation ("offset correction") and only works if `cum(t)` is a constant, i.e. pre-roll only; ADR-0008 lines 134-141 record SYSK as pre-roll + mid-rolls (inferred from the failure of a single calibration in `transcription-scale-plan.md` §4), which is why a per-show offset is dead on the big networks.

Two further measured facts bound any pad:

- **Per-request variance.** Gastropod, same episode, same client, hours apart: +66.1 s vs +32.7 s, a 33.4 s spread (ADR-0008 lines 71-74) [measured]. So the pad must be `delta_max + margin` over N ≥ 2 probes of the *same* episode (ADR-0008 lines 310-314). No show in the repo other than Gastropod has that measurement (`measure-suspects.mjs:920-937` says its own `maxDeltaSec` is "the screen, not its `delta_max`").
- **Ceiling.** `AD_PAD_CEILING_SEC = 120` (`seek-policy.js:109`), matching `ANCHOR_TIME_TOLERANCE_SEC` (`merge-segments.mjs:123`). Effective headroom `delta_max ≲ 60–87 s` (ADR-0008 lines 348-357).

### The deltas, by show class

| class | delta | pad verdict |
|---|---|---|
| Indie / self-hosted (Being an Engineer +0.3/+0.8 s; 41/41 episodes at ratio 1.0000 in the grilling pass) [measured] | seconds | **Needs no pad.** Already passes rung 3 (≤ 30 s) and already in `AD_FREE_SHOWS`. |
| Mid hosts (Gastropod 33–66 s; A Taste of the Past, Proof, olive, El Mundo implied 42–67 s; 5-4 below) [measured for Gastropod; implied-from-ratio for the rest] | 30–100 s, varies per download | **PADDABLE in principle** at a ~100 s stop pad. Listener hears up to ~1 min of run-up on a ~2 min segment, and can open inside an ad pod (ADR-0008 lines 262-270). None has the N ≥ 2 measurement except Gastropod; none of the food-show set is in the timed-transcript index. |
| Big networks (all Triton `mc.tritondigital.com`) | minutes | **No pad works.** |

Implied displacement for the 11 injecting timed-transcript shows — `(median_ratio − 1) × median episode duration`, from `dai-classification.json` samples and `transcript-availability.json` durations [derived; screen-grade, 5 episodes each, one probe each]:

| show | timed | median ep | ratio (median, range) | implied delta median / worst |
|---|---|---|---|---|
| Stuff You Should Know | 2,857 | 43 min | 1.178 (1.166–1.209) | **455 s / 534 s** |
| Odd Lots | 1,256 | 43 min | 1.151 (1.127–1.217) | 394 s / 566 s |
| Las Culturistas | 560 | 84 min | 1.193 (1.163–1.254) | 967 s / 1,273 s |
| Unexplained | 431 | 30 min | 1.271 (1.203–1.427) | 492 s / 775 s |
| Broken Record | 395 | 52 min | 1.132 (1.093–1.137) | 414 s / 429 s |
| This Podcast Will Kill You | 298 | 73 min | 1.105 (1.084–1.108) | 462 s / 475 s |
| Wicked Words | 292 | 42 min | 1.126 (1.119–1.159) | 319 s / 403 s |
| The Happiness Lab | 270 | 35 min | 1.298 (1.25–1.353) | 632 s / 749 s |
| Heavyweight | 125 | 36 min | 1.236 (1.221–1.364) | 514 s / 792 s |
| Bone Valley | 65 | 43 min | 1.213 (1.191–1.235) | 544 s / 600 s |
| **5-4** (RedCircle) | **45** | 47 min | 1.024 (0.875–1.059) | **68 s / 168 s** — one sample *under* 1.0, so the declared length is unreliable; needs decode-and-compare |

Cross-check against full downloads (ADR-0008 lines 51-58): SYSK +8.4 to +10.0 min, Odd Lots +8.8 to +10.7 min, TPWKY +8.0 min — the ranged-GET screen agrees with the expensive method within ~10 %.

**Conclusion:** a pad the listener would tolerate (≤ 120 s, realistically ≤ 90 s) covers **at most 45 of the 6,594 excluded timed transcripts (0.7 %)**, and even that one show needs N ≥ 2 probing first. The other 6,549 are displaced by 3–16 *segment-lengths*; "pad a little" would mean playing 5–16 minutes of the wrong part of the episode before the intended two minutes arrive. Wyatt's intuition is right for the mid-host tier and wrong for the tier that holds the supply.

### Where a fixed pad breaks even inside the paddable tier [inferred, from ADR-0008 lines 333-346]

- A copy carrying more load than the sampled max truncates the tail by the excess; the one measured spread is 33 s on a 110 s segment.
- The head is never corrected, so every padded play opens early by that copy's load; if an ad break straddles the seek point the segment opens inside an ad (product-principle 3 says we play it, never skip it).
- The pad is per-*episode*, so it needs a measurement per episode, not per show, and needs refreshing because ad campaigns change.

### Options for making DAI shows playable

| # | Option | Needs | Effort | Unlocks | ADR fit |
|---|---|---|---|---|---|
| **A** | **Ship ADR-0008's pad tier.** Wire `allowAdPad: true` into `app.js:5188`; add a writer that stamps `ad_pad_sec` (= `delta_max + spread`, N ≥ 2 same-episode ranged GETs; decode where `length="0"`) onto `data/segments.json` rows; run it on a cron (RemoteTrigger) so pads refresh. Building blocks exist: `measure-suspects.mjs --repeat N` and `maxDeliverySpread` (`:1109`), `decode-compare.mjs probeGrid` (`:465`), `ad-inflation.mjs probeEpisode` (`:221`). | Server-side cron; nothing on device; no ASR. | **Small** (≈ 1–2 days): one app.js option, one data writer, one cron, tests already exist for the player half (`seek-policy.test.js` pad block, `foray-queue.test.js`). | Gastropod-class food shows for the grilling foray; **5-4** if it probes clean; **not** SYSK/Odd Lots. | Honours ADR-0008 exactly — it *is* the ADR's PADDABLE tier. Gated on **open question 2** ("does the pad ship before the locate step?") which is addressed to Wyatt and unanswered (`seek-policy.js:71-74`). |
| **B** | **Per-show measured start offset** ("just pad the timing"): shift `start_sec` by the show's median delta. | Server cron only. | Small. | Only shows whose ads are pre-roll-only. **None measured** — every big-network show is inferred mid-rolled (ADR-0008 lines 134-141), and mid-rolls make the offset wrong by a different amount after each break. Also per-request variance (33 s) exceeds a 110 s segment's tolerance for the mid tier. | **Violates ADR-0007/0008**: plays at a position we cannot justify; ADR-0008 lines 674-677 name this exact temptation ("choosing a bad cut over a skipped one; do not"). Not recommended. |
| **C** | **Search the publisher transcript for the anchor words.** | Nothing new. | Trivial. | **Nothing.** The publisher transcript is the ad-free master's timeline (ADR-0008 lines 143-147); the anchor is already at `start_sec` there. It cannot say where the anchor is in the *listener's* copy. Dead on arrival. | — |
| **D** | **On-device windowed ASR — the locate step as ADR-0007 rung 4 / ADR-0008 option 1.** At foray open (not at tap, to protect the < 1.5 s tap-to-audio budget), the native shell ranged-GETs the listener's own copy over `[start_sec, start_sec + delta_max + margin]` (≈ 8–14 min of audio for SYSK, ADR-0008 lines 386-405), runs on-device speech recognition (Apple `SFSpeechRecognizer` with `requiresOnDeviceRecognition`, Android `SpeechRecognizer`/whisper.cpp tiny), fuzzy-matches the 8–12 anchor words, seeks to the hit; same for the end anchor. Result cached per episode per device. Falls to today's skip when no hit. | Native plugin on both platforms; a ranged-GET download path (a narrower version of #29 — the window, not the file); on-device ASR; an "approximate" search window per episode from Option A's cron. Web/PWA cannot do this (no on-device ASR on audio files) → stays skip. | **Large** (weeks, native-only): a new Capacitor plugin (`foray-audio` today has one method), a locate cache, a `locateStep()` implementation with the drift arithmetic, and a UI state for "locating…". Latency and battery for 10 min of ASR per segment are unmeasured [inferred: tens of seconds on-device; must be pre-fetched]. Per-request stitch stability between the locate fetch and the playback fetch is assumed from `dai.mjs:21-27` and has one counter-example (Gastropod hours apart). | **All 6,594** — SYSK + Odd Lots alone are 4,113, "half our free-transcript inventory" (ADR-0008 lines 622-627). | The rung ADR-0007 designed for (lines 129-130) and ADR-0008 open question 1 option 1. Also needs Option A's `delta_max` as the window parameter (ADR-0008 line 403). |
| **E** | **Acoustic fingerprint alignment** (Chromaprint; ADR-0008 lines 406-411, "not designed"). Server fetches its own copy once per segment, finds the boundary by ASR once, cuts a ~10 s reference fingerprint; the device fingerprints its window and aligns. | Server ASR budget per segment + a native fingerprint lib + the same window download as D. | Large, and it re-introduces per-segment server audio work. Cheaper per *lookup* than D, dearer per *segment*. | Same as D. | ADR-0008 OQ1 option 2. The ADR says it fits self-transcribed episodes and D fits publisher-transcript ones; the timed-transcript supply is publisher-transcript, so **D first**. |

---

## 4. Recommendation

**What to change so DAI shows are usable end-to-end without a manual step**

1. **Stop calling it an exclusion of "DAI shows" and gate on the measured tier instead.** Replace `isAnchorableShow`'s host-flag test (`fetch-transcripts.mjs:168-172`) with the tier `measure-suspects.mjs:966` already computes: `ad-free` → fetch (as now); `paddable-screened` → fetch and mark; `locate-required` → fetch only when `--all-timed` or once Option D lands. Today the flag-based test and the measured list agree on every show except the one `unknown` (301 timed) — so this is mostly honesty, not new supply, until D exists. Keep ADR-0008's "author now, play later" (decision 5) *out* of published forays: a generated foray must not place a LOCATE-REQUIRED segment while `locateStep().implemented === false`, or listeners get "N segments can't play" banners. That needs `audioSourceLookup.ts` to carry the tier and `sourceBeats.ts` to refuse or narrate instead — small.

2. **Ship Option A (the pad) — engineering-ready, decision-gated.** One option at `app.js:5188`, one `ad_pad_sec` writer with N ≥ 2 same-episode probes, one cron. It converts the mid-host tier from authorable to playable and gives Option D its search window for free. Honest cost: run-up of up to the pad, tail truncation when a copy exceeds it.

3. **Fund Option D (windowed on-device ASR) as the thing that actually unlocks the supply.** Nothing else reaches SYSK / Odd Lots. It is native-only, weeks not days, and needs the locate cache and a pre-fetch at foray open to keep tap-to-audio inside budget.

4. **Until D lands, the current behaviour is correct and cheap**: the gate never plays a bad cut, the cost is bounded to "segment skipped", and today no shipped segment is even on a DAI source.

**What remains a founder decision**

- **ADR-0008 OQ2** — does the pad ship before the locate step? Wyatt's question reads as "yes"; record it in `docs/DECISIONS.md` so `allowAdPad` can be flipped (`seek-policy.js:71-74` says explicitly it waits on this).
- **ADR-0008 OQ1** — which locate implementation is funded first: on-device ASR (D) or fingerprint (E). D covers the publisher-transcript supply; the case above is for D.
- **ADR-0008 OQ3/OQ4** — is a ~100 s pad on a ~110 s segment editorially acceptable, and does N stay at 2? Both affect only the mid-host tier.
- **Native-only acceptance** — the locate step cannot run in the PWA. Is "DAI shows play in the app, skip on the web" acceptable, or does the web need a server-assisted fallback (which the per-request stitch makes unreliable, ADR-0008 lines 177-185)?
- **Bandwidth/latency budget for the locate window** — up to ~14 min of the listener's audio per segment, fetched before they tap. On cellular this is a product call, not an engineering one.

**One correction to carry back**: "I thought we had a workaround there" — the workaround (anchors) is real and is why the authored segments will still be correct when the locate step exists; it was never a playback mechanism, and ADR-0007 lines 168-173 said so on the day it was accepted.

---

### Files read (repo-relative)

- `player/seek-policy.js`
- `player/foray-queue.js`
- `player/queue-manager.js`
- `player/foray-resolve.js`
- `player/client.js`
- `player/html-audio-backend.js`
- `player/foray-progress.js`
- `app.js`
- `ios/App/Player/PlayerBackend.swift`
- `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift`
- `tools/segments/fetch-transcripts.mjs`
- `tools/segments/breadth-yield.mjs`
- `tools/segments/merge-segments.mjs`
- `tools/segments/measure-suspects.mjs`
- `tools/segments/prepare-segment-batch.mjs`
- `tools/foray/check-forays.mjs`
- `tools/foray/verify-source-audio.mjs`
- `tools/transcribe/ad-inflation.mjs`
- `tools/transcribe/decode-compare.mjs`
- `tools/transcribe/build-transcription-queue.mjs`
- `tools/refresh/dai.mjs`
- `backend/src/generation/audioSourceLookup.ts`
- `backend/src/generation/sourceBeats.ts`
- `backend/src/generation/transcriptArchiveLookup.ts`
- `backend/src/feeds/politeness.ts`
- `docs/adr/0007-segment-anchoring.md`
- `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`
- `docs/ios-native-player-gap.md`
- `data/transcript-availability.json`, `data/dai-classification.json`, `data/transcript-digests.json`, `data/segments.json`, `data/segment-sources.json`, `data/forays.json`, `data/decode-and-compare.json`
