# The locate step: on-device windowed ASR and the native out-point (G-41)

**Status:** design draft, internal. Sections 1-8 are written. Section 9, the
feasibility numbers, is **pending DAI-12**. Nothing here is built, nothing is
flipped, and no founder question is answered by this doc. Card:
`docs/roadmap/dai.md` §DAI-13. Parent card: G-41 in
`docs/curation/foray-to-spec-roadmap.md` ("After D5": write its own deck and
cut from that).

**What the locate step is.** ADR-0007 rung 4, which ADR-0008 calls the locate
step. A Foray segment authored against a publisher's transcript is a *foreign*
timestamp. On a show that stitches ads into each request, the listener's copy
carries a different ad load, so the authored second is wrong by `cum(t)`, the
ad time inserted before `t`. Today such a segment is skipped (rung 5), or, once
`AD_PAD_SHIPPED` flips, played with a padded stop when the pad is no more than
120 s. The locate step finds the segment's two ADR-0007 anchors (8-12 verbatim
words each) in the listener's own copy and plays the segment at the times where
it actually is. It is the only route to the LOCATE-REQUIRED tier: every show
whose pad is over 120 s, which ADR-0008 says includes Stuff You Should Know,
Odd Lots and This Podcast Will Kill You.

**What already exists (merged, pure, JS, wired to nothing).**
- `player/locate-window.js` (DAI-10, #1013): `locateWindow()` (the fetch span
  and the two search ranges, each `delta_max + margin` wide), `windowBytes()`,
  and `locatedBounds()` (the located start and end, or a refusal).
- `tools/transcribe/anchor-match.mjs` (DAI-11, #992): `anchorMatch()`, a
  fuzzy whole-word match over ASR cues by word edit distance, with
  `MIN_MATCH_SCORE` 0.75. Its header states the rule precisely enough for a
  bit-for-bit native port.
- `player/seek-policy.js` `locateStep()` returns `{ implemented: false }`, so
  every caller that reaches rung 4 lands on rung 5.

**Code this design touches (cited by name, because line numbers drift).**
- `docs/native-engine-plan.md` §4.3 is the three-layer out-point:
  `forwardPlaybackEndTime = end (+ stopPad)`, then a boundary observer, then the
  windowed watchdog. Its cards are NE-25a, NE-28j, NE-28s and NE-32 (§14).
- `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/AVDeck.swift`:
  `setOutPoint` hands the boundary to the out-point watch. The `.endTime` op
  writes `item.forwardPlaybackEndTime = end + config.stopPadSec`, and
  `defaultStopPadSec = 0`. The load pipeline reports the duration, then waits
  for readiness, then does a zero-tolerance seek and a preroll. A seek issued
  while the deck is still `.loading` or `.gating` moves the target start
  without a second seek.
- `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Engine/EngineCore.swift`:
  `playForay` is refused `capability-off` while `config.forayTapeEnabled` is
  off. Otherwise it re-validates the structure (J-4). The gate runs in `landed`
  through `SeekPolicy.segmentLoadGate`, and `load` and the standby `prepare`
  both read `item.bounds`.
- `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Contract/ContractDecoding.swift`:
  `PlayForay.allowAdPad` is a **required** bool.
- `player/seek-policy.js` holds the ADR-0007 ladder in the header,
  `seekPrecision`, `locateStep`, `segmentLoadGate`, `AD_PAD_SHIPPED = false`
  and `DRIFT_TOLERANCE_SEC = 30`.
- `player/foray-queue.js` `buildForayQueue` writes
  `end_sec: authoredEnd + appliedPad`, `authored_end_sec` and
  `ad_pad_applied_sec`. It drops a LOCATE-REQUIRED item when `allowAdPad` is
  on. `itemRuntimeSec` (the Foray clock) reads `authored_end_sec`.
- `player/queue-manager.js` keeps `_forayOptions.allowAdPad` and passes it to
  `segmentLoadGate` at the load gate.
- `tools/transcribe/ad-inflation.mjs` holds `RANGED_GET_UNTRUSTED_HOSTS` and
  `rangedGetTrusted()`. ADR-0008's amendment of 2026-09-30 (#947) says a ranged
  GET's `Content-Range` total is a declaration, not a measurement, and distrust
  is per `resolved_host`.
- `tools/foray/check-forays.mjs` (DAI-06) refuses a published Foray that draws
  on a LOCATE-REQUIRED source.
- `docs/curation/dai-playback-brief-2026-09-10.md` §3, option D.

---

## 1. Where the locate result lives

**The record.** Each locatable item gets one record, computed natively when its
Foray is opened:

```
located: {
  start_sec,          // located start, seconds into the COPY IN HAND
  end_sec,            // located end, same timeline
  method: "asr-window",
  score,              // min(start-anchor score, end-anchor score), 0..1
  copy_duration_sec,  // the copy's duration as the deck will see it (§3)
  located_at          // wall-clock ms when the result was written
}
```

`start_sec` and `end_sec` are what `locatedBounds()` returns from the two
`anchorMatch()` hits. `score` is the weaker anchor's score, because one bad end
is enough to cut a segment badly. `method` is a closed token. Chromaprint, if
it is ever funded, would be a second value and needs no new shape.

**Where it is stored.** The record lives in the native engine's locate cache
(§3), and nowhere else:
- not in the page;
- not in the Foray JSON;
- not under `data/`;
- not in `localStorage`;
- never on a server.

The page never sends a `located` value, and the engine never trusts one from
the page. It is a property of one device's copy of one episode, so no other
device or listener could use it.

**The item is never rewritten.** `start_sec`, `end_sec`, `authored_end_sec` and
`ad_pad_applied_sec` stay exactly as `buildForayQueue` wrote them. The core
derives the bounds it plays from one function, proposed as `deckBounds(item,
located)`. Its JS reference sits beside `segmentLoadGate` in
`player/seek-policy.js`, and its Swift port sits beside the core's
`SeekPolicy`:

| case | deck start | deck out-point | `ad_pad_applied_sec` reported |
|---|---|---|---|
| `located` applies (§2) | `located.start_sec` | `located.end_sec` | **0** |
| any other playable rung | `item.start_sec` | `item.end_sec` (authored + pad) | `item.ad_pad_applied_sec` |

**Loading a located item.**
- The deck seeks to `located.start_sec`. This is the same zero-tolerance seek in
  the same readiness-gated pipeline, so the located start is simply the target
  start.
- The core arms `setOutPoint(located.end_sec)`.
- Every reader of `item.bounds` in `EngineCore.swift` reads `deckBounds`
  instead. That covers `load`, the in-place re-entry test, the standby deck's
  `prepare` and `sourceOffset` for a scrub.

**Why the pad is 0 on a located item.** The pad bounds a displacement we could
not see. The end anchor was found in this copy, so the displacement is now
known. Adding the pad would play up to `ad_pad_sec` of whatever follows the
segment, which is the run-on ADR-0008 accepts only because it has nothing
better.

**`stopPad` stays additive and orthogonal.** Layer 1 is still
`forwardPlaybackEndTime = end + stopPad`, with `end = located.end_sec`.
`stopPad` (NE-25a; 0 since §7.5 of `docs/ios-native-engine-measurements.md`)
corrects AVFoundation's stopping behaviour, and that does not depend on where
`end` came from. It must not absorb ASR timing error: that error belongs to the
locate rule, and §8 measures it.

**The end word must not be clipped.** `anchorMatch` sets `end_sec` to the end of
the last cue token. On-device ASR can end a word early, and the out-point is
never early (P-2). The JS reference therefore adds a provisional
`LOCATED_END_GUARD_SEC` (proposal: 0.3 s, `// MEASURE`) to the end hit before
the result is stored. That value is part of the locate rule and is
fixture-pinned. It is not a deck setting. The `outpoint-guard` device check in
§8 settles it.

**`authored_end_sec` still drives the Foray clock.**
- `itemRuntimeSec` and its Swift twin `ForayClock` keep measuring the authored
  span: `authored_end_sec - start_sec`, both unrewritten.
- A located span can be longer than the authored one. `locatedBounds` admits a
  mid-roll that falls inside the segment, which plays and is never cut. During
  that extra time the elapsed time within the item is clamped at the authored
  runtime, so the Foray clock holds. It never runs past the item's share of the
  total.
- A scrub into a located item maps the authored offset `into` to
  `located.start_sec + into`, clamped below `located.end_sec`. After an
  in-segment mid-roll this is off by the length of the mid-roll. That is
  accepted and documented: the window transcript could map it exactly, but
  that is not v1.

---

## 2. Precedence at load

**The new ladder.** One ordered list. The first rung that answers wins:

| # | rung | precision | bounds |
|---|---|---|---|
| 1 | local downloaded file (#29) | `exact` | authored |
| 2 | not DAI (static enclosure) | `exact` | authored |
| 3 | DAI, `\|observed - reference_duration_sec\| <= DRIFT_TOLERANCE_SEC` | `exact` | authored |
| 4 | DAI, a `located` record whose `copy_duration_sec` is within `DRIFT_TOLERANCE_SEC` of `observed` | **`located`** (new) | `located` |
| 5 | DAI, `allowAdPad`, pad no more than `AD_PAD_CEILING_SEC`, this copy's load no more than the pad | `padded` | authored + pad |
| 6 | anything else | `approximate` → **skip** | — |

**`seekPrecision` gains a `located` input.**
- `seekPrecision(item, ctx)` gets an optional `ctx.located`, and
  `segmentLoadGate(item, ctx)` passes it through.
- On rung 4 the result is `{ precision: "located", located, reason }`.
- `LOCATED` joins `EXACT`, `PADDED` and `APPROXIMATE` as an exported constant.
- `canPlaySegment` already admits everything except `approximate`.
- `canSeekExactly` stays `exact`-only. A located time is a measurement on this
  copy, not an authored second. The honesty rule (corner case #2c, "roughly
  minute 70") still applies to any located time shown to the listener.
- `locateStep()` keeps its name. It returns `implemented: true` only behind the
  switch in §7 (NE-43h).

**Why located comes before padded.** This reverses the order in today's code.
`seekPrecision` places the pad "between rungs 3 and 4". With rung 4
unimplemented the order never mattered, but now it does:
- A located bound is measured on this copy.
- A pad is an upper bound on what we could not measure. It opens early by this
  copy's own ad load and closes on up to `ad_pad_sec` of extra tail.
- When both exist, the measurement wins.

**Why rung 3 still comes before located.**
- When the durations agree, the authored seconds are exact on this copy, and no
  ASR error enters.
- Rung 3 also costs nothing. A Foray that reaches its item on rung 3 never needs
  the locate result, so the result may still be in flight.

**Order of events at load (native).**
1. Before the load, the core looks up the most recent cache entry for the
   item's segment key (§3) and predicts the located bounds. The deck loads at
   the predicted start with the predicted out-point. The standby deck's
   `prepare` uses the same prediction.
2. AVDeck reports the duration while the load is still gating (pipeline step 2).
   The core runs the ladder above with `observed` and the cache entries.
3. If the answer is not the prediction, the core re-targets the start with a
   seek during gating (free; no second seek) and re-arms `setOutPoint`. The
   answer can differ in three ways: rung 3, a different entry, or the pad.
   - On the standby deck, a re-target is not free once the deck is prerolled.
     A miss there degrades to an ordinary load, which is NE-32's existing rule.
4. If the answer is skip, the existing `refuseAtLoad` path runs. The
   `skipped` event and row carry the reason.

**Rung 4 entries are checked against the same `observed` duration as rung 3.**
- A cache entry whose `copy_duration_sec` misses `observed` by more than 30 s
  belongs to another stitch. It is invalidated (§3), and rung 4 does not
  answer.
- The same `DRIFT_TOLERANCE_SEC` is used deliberately, for the reason
  `seek-policy.js` gives against widening it. It guards one listener's
  timestamp against one listener's copy, and that is exactly the question here.

**Build time.**
- `buildForayQueue` gets an `allowLocate` option, default false. With it on, a
  LOCATE-REQUIRED item is **kept** rather than dropped. It is marked
  `needs_drift_check` (it already is) and `locate_required: true`.
- With `allowLocate` off, today's behaviour is unchanged byte for byte.
- `allowLocate` comes from one constant, `LOCATE_SHIPPED = false`, in
  `player/seek-policy.js`. It follows the same discipline as `AD_PAD_SHIPPED`:
  one switch, read on every path, sent to the native `playForay` from the same
  constant.

**The web stays skip.**
- The web player has no locate source. It never passes `located`, so
  `segmentLoadGate` on the web returns exactly what it returns today.
- `LOCATE_SHIPPED` only lets the build keep the item. At load, the web's gate
  still skips it.
- This is founder question Q5 (§9). The proposed default is "DAI shows play in
  the app, skip on the web".

**Untrusted hosts are not located.**
- An item whose `audio_url` resolves to a host in `RANGED_GET_UNTRUSTED_HOSTS`
  (`tools/transcribe/ad-inflation.mjs`) is refused with the outcome
  `untrusted-host`. The reason: on those origins a ranged request is served a
  different resource (the master) from the one an unranged request receives,
  so a window fetched by ranged GET is not proof of what the deck plays. This
  follows the ADR-0008 amendment (#947), rule 2: distrust is per
  `resolved_host`.
- The engine reads the same list, through a generated constant (NE-43b). It
  never keeps a hand-copied list.

**Observation, not changed here.** Rung 1 treats a downloaded DAI copy as exact
for a *foreign* timestamp. ADR-0008's geometry says a downloaded copy carries
its own ad load, just as a streamed one does. Forays stream today
(`player/client.js` sends `isLocalFile: false`), so the rung decides nothing
yet. Before Foray downloads exist, someone should decide whether rung 1 should
apply only to OWN timestamps. That is an engineering question for the #29
owner, not a founder question.

---

## 3. Cache

**Key.** `(segment_key, round(copy_duration_sec))`, with
`segment_key = source_item_id + "@" + start_sec + "-" + authored_end_sec`.
- The built queue item's `id` (`${forayId}#n`) is per-Foray. It would miss the
  same segment in a second Foray, which is the common case for a popular
  SYSK clip.
- The duration is rounded to 1 s because `AVURLAsset` durations differ in the
  sub-second digits between loads of the same file.

**Value.** The `located` record of §1. A miss is cached too, as
`{ missed: outcome, located_at, copy_duration_sec }`, so a copy that has
already failed is not transcribed again on every Foray open. A miss is retried
after `LOCATE_MISS_RETRY_HOURS` (proposal: 24, `// MEASURE`). The only
exception is `asr-denied`, which is retried when the authorization status
changes.

**Invalidation.**
- **Drift.** At load, an entry whose `copy_duration_sec` is more than
  `DRIFT_TOLERANCE_SEC` from `observed` is deleted, and the gate falls through
  (§2). A copy whose ad load changed is a different copy.
- **Age.** An entry older than `LOCATE_MAX_AGE_HOURS` (proposal: 72,
  `// MEASURE`) is not used. A restitch can keep the total duration and still
  move the breaks; the Gastropod counter-example (dai-playback-brief §3,
  option D) was hours apart. Age is the only guard against that, because a
  duration match cannot see it. A device row that re-locates a cached item and
  compares the two results settles the value (§8, `relocate-drift`).
- **Data deletion.** The engine's `purge` command and `stop {persist: false}`
  (data deletion, plan §5.2) clear the cache.
- **Size.** The cache is bounded (proposal: 500 entries, LRU). An entry is about
  200 bytes.

**Never across devices.**
- The cache lives under an engine-owned key prefix in native storage (plan
  §4.6, DurableStore and `ownedKeyPrefixes`).
- It is excluded from any backup or sync and is never sent to the backend.
- A located time is only true of the bytes this device was served.

**No audio is kept.** The window's temporary file is deleted as soon as the
recogniser returns (§6). The cache holds two numbers and a score, never audio
and never a transcript. This matches the project's existing rule: keep
fingerprints, not audio.

---

## 4. When

**At Foray open, never at tap.**
- Tap-to-audio has a budget under 1.5 s. Recognising a window of 8-14 minutes
  takes tens of seconds (inferred; DAI-12 measures it), so the locate step can
  never sit between a tap and sound.
- It starts when the Foray page opens: the `renderForay(id)` route in `app.js`,
  in the native shell, when the engine advertises `locate`.
- It runs in queue order, so the items the listener reaches first are located
  first.

**Playback never waits.** If the listener taps Play while items are still
locating, the Foray starts at once:
- An item whose locate result is not ready when its load reaches the gate is
  judged without one. It falls to the pad or to skip, with the outcome
  `locate-pending` on the `skipped` row.
- Locating continues during playback, starting with the next unlocated item
  after the playhead.
- There is no reordering and no waiting at a seam. A seam is a promise of
  0.5 s (`SEAM_GAP_SEC`), not a place to hide a recogniser.

**A `locating…` state.** The Foray page reads the snapshot's `locate` field
(§5).
- While an item is `pending`, its row says **"Finding this clip in your
  copy…"** (copy proposed, not final) with a small spinner. The row is not
  disabled.
- An item that is `located` looks like any other.
- An item that is `missed` reads like today's skipped row, with the same honest
  wording.
- The Play button is never disabled by locating.
- A summary line appears only while something is pending. It reads "Finding 3
  of 7 clips in your copy of the episode" (proposed).
- The listener needs no settings to understand any of this.

**Network: Wi-Fi only by default, pending Q6.**
- The shell checks `NWPathMonitor`. A path that is `isExpensive` (cellular or a
  personal hotspot) or `isConstrained` (Low Data Mode) does not start a fetch.
  The item stays `pending` with the outcome `cellular`, and it resumes when the
  path changes.
- A window can be about 14 min of audio, which is several MB at podcast
  bitrates. `windowBytes()` gives the exact number per item. DAI-12 measures
  it, and §9 records it.
- Q6 is the founder's call. The default proposed in `docs/roadmap/dai.md` and
  `docs/roadmap/README.md` is Wi-Fi only, and it is a **proposal** (§9).

**One at a time.**
- At most one window is fetched and one recognition task runs at any moment.
- Opening a second Foray cancels the first one's remaining work. Results
  already cached stay.
- Backgrounding the app does not cancel work in flight. Whether on-device
  recognition keeps running in the background while audio plays is a device
  check (§8, `asr-background`). Until it is measured, the shell treats a
  background cancellation as `cancelled` and retries on the next foreground.

---

## 5. Protocol

Protocol v1 (plan §5) grows by one command, one optional argument, one snapshot
field, one event and one diagnostics row. The changes are additive: an old
page against a new engine and a new page against an old engine both still
work.

**Command `locateForay`.**

| `cmd` | `args` | Notes |
|---|---|---|
| `locateForay` | `{forayId, items[]}` | `items` are the built queue items, the same objects `playForay` sends. |

How the engine handles it:
- The engine selects the locatable items: `dai_suspected`, `needs_drift_check`,
  both anchors present, `ad_pad_sec` present (it sets the window's reach, §6),
  and not already cached for a duration it could match.
- It answers `{ok: true, snapshot}` at once. The work is asynchronous.
- Refusals use the existing reason tokens. `capability-off` means
  `EngineConfig.locateEnabled` is off; this mirrors `playForay`'s
  `forayTapeEnabled` guard in `EngineCore.swift`. `refused-structure` means an
  item fails J-4.
- Re-sending the same `forayId` is a no-op. A different `forayId` cancels the
  previous run (§4).

**`playForay` gains `allowLocate`.** It is optional and defaults to false, so an
older page still decodes. `allowAdPad` stays required, as
`ContractDecoding.swift` has it. The page sends `allowLocate` from
`LOCATE_SHIPPED` through the same `forayQueueOptions()` helper that carries
`allowAdPad`, and the core honours rung 4 only when it is true.

**Snapshot field `locate`.**

```
locate?: { forayId, state: "idle"|"locating"|"waiting-network"|"done",
           items: { [itemId]: "pending"|"located"|"missed" },
           located, missed, pending }
```

The field is absent when nothing was asked. It is coalesced with the 1 Hz
snapshot like everything else, and it is the only thing the page's
`locating…` UI reads.

**Event `locate`.** `{itemId, outcome}`, sent when an item finishes. It is best
effort, like every event (plan §5.4). The snapshot is the truth.

**Diagnostics row `locate`.** One row per attempt:

```
locate item=<itemId> bytes=<n> ms=<n> hit=<0|1> score=<0..1> outcome=<token>
```

- `bytes` counts what was fetched, not what was asked for.
- `ms` runs from the start of the fetch to the result.
- `outcome` comes from a new closed set, `locateOutcome`, added to
  `player/engine-vocabulary.js`. `node tools/parity/gen-constants.mjs --write`
  regenerates `player/parity/vocabulary.json` and the Swift `Vocabulary.swift`.
  `vocabulary.json` is generated and never hand-edited.
- Proposed tokens: `located`, `no-hit`, `span-refused`, `untrusted-host`,
  `vbr-origin`, `copy-mismatch`, `no-window`, `fetch-failed`,
  `asr-unavailable`, `asr-denied`, `cellular`, `timeout`, `cancelled`,
  `locate-pending`.
- The existing `gate` row gains `kind=located` beside `noted`.
- No row carries a URL, a host, a transcript word or an anchor. The vocabulary's
  closed-token rule exists so that the founder's pasted diagnostics cannot leak
  any of that.

**Where each piece goes.**
- `player/engine-contract.js` `COMMAND_ARGS` and
  `player/parity/schema/engine-contract.schema.json`: the `contract` family.
- `ContractDecoding.swift`: decoding of `locateForay` and the optional
  `allowLocate`.
- `tools/mobile/engine-report.mjs`: a locate verdict (NE-43g).

**Capability.**
- The engine advertises `locate`, through the `advertisedCapabilities` literal
  and `mobile/ENGINE_DEFAULT.json`, only when the `locate` parity family runs
  whole in Swift (plan §6.6; `player/parity/capabilities.json`).
- The page sends `locateForay` only when `engineHello` lists it.

---

## 6. ASR on the device

**The recogniser.**
- `SFSpeechRecognizer(locale: en-US)`. The catalogue is English. A nil
  recogniser, or `isAvailable == false`, gives the outcome `asr-unavailable`.
- `supportsOnDeviceRecognition` is checked before every attempt. If it is false,
  the outcome is `asr-unavailable`.
- The request **always** sets `requiresOnDeviceRecognition = true`. There is
  never a fallback to server recognition: it would send the listener's audio
  to Apple, and Apple documents roughly a one-minute cap on server requests.
  Whether on-device recognition has a practical length limit on a 14-minute
  file is a device check (§8, `asr-length`).
- Authorization uses `SFSpeechRecognizer.requestAuthorization`, which needs
  `NSSpeechRecognitionUsageDescription` in the app's Info.plist.
  - That file is under `ios/App/**`, which is unlisted, so it needs a human
    merge.
  - The prompt is asked the first time a Foray with locatable items opens,
    never at launch.
  - If it is denied, the outcome is `asr-denied`. The items fall down the
    ladder, and nothing asks again until the system setting changes.
  - Whether the permission needs new privacy-policy or data-safety wording is
    the founder's call. `docs/legal/` is governed. This doc proposes no
    sentence; the card that adds the permission (NE-43d) routes it.
- The request is `SFSpeechURLRecognitionRequest(url:)` on a **file URL**,
  with `shouldReportPartialResults = false`. The anchor words could be passed
  as `contextualStrings`, which may raise hits but may also raise false hits at
  the 0.75 threshold. It stays off until a device row compares the two.

**The window, as a file.** All locate-window maths uses the item's own fields:
- Reach is `ad_pad_sec`, which is `delta_max + margin` as stamped by
  `tools/segments/stamp-ad-pad.mjs`. For a LOCATE-REQUIRED source that is more
  than 120 s, and that is fine. In `locateWindow()` terms this is
  `delta_max_sec = ad_pad_sec, spread_sec = 0`, which gives the same reach.
- An item with no `ad_pad_sec` has no window. Its outcome is `no-window`, and it
  is never guessed.

**Fetch ranges.** `locateWindow()` returns one contiguous fetch span. For a long
segment the two search ranges do not meet, and fetching the middle wastes bytes
and recogniser time. A small JS addition, proposed as
`locateFetchRanges(window, { end_lead_sec })` in `player/locate-window.js`,
returns one range when the search ranges overlap and two when they do not.
Each range is fetched by its own ranged GET into its own temporary file.

**The end anchor needs a lead.**
- `anchorMatch` filters candidate windows on the **first** token's start time.
- An end anchor is the segment's last 8-12 words. Its first word is spoken
  *before* the authored end, so a search from `search_end.from_sec` misses the
  anchor whenever the shift is near zero.
- The end anchor is therefore matched with
  `from_sec = search_end.from_sec - END_ANCHOR_LEAD_SEC` (proposal: 15 s:
  12 words at a slow 1 word/s, plus slack). `locatedBounds` then checks the hit's
  **end** against `search_end`, as it does today.
- The fetch for the end range starts at the same lead. DAI-12's harness should
  apply the same lead, or its end-anchor hit rate will understate the method.

**Time zero of a slice.** This is the part that decides correctness. A located
time is `slice_origin_sec + cue_time`, and any error in `slice_origin_sec`
lands directly on the seek.
- **CBR (`seek_map: "cbr"`, `tools/audio/mp3-probe.mjs`).**
  `slice_origin_sec = (range_start_byte - audio_data_offset) * 8 / bitrate`,
  snapped to the first whole frame the parser reports. `audio_data_offset` is
  the ID3v2 tag size plus 10, read from a 10-byte ranged GET of the file head.
  This is accurate to one frame, 26 ms at 44.1 kHz.
- **VBR, with or without a TOC.** The byte-to-time map is up to 1/256 of the
  file off with a TOC (10.6 s at 45 minutes, plan §4.3) and unbounded without
  one. v1 **refuses** with the outcome `vbr-origin`, and the item falls down the
  ladder. A later card can lift this if a device row shows an exact origin for
  VBR. One candidate is `AVAssetReader` with a `timeRange` on the remote
  asset, but plan §4.3 records precise MP3 timing reading the whole file
  (43,855,107 bytes for one 2,725 s source), so it is not assumed.

**Copy consistency (per host, without trusting the host).** The ranged GET's
`Content-Range` total is a declaration (ADR-0008 amendment). The shell checks
it against the copy's duration as the deck sees it:
- `copy_duration_sec` comes from `AVURLAsset.load(.duration)` with the same
  `EngineItem.preciseTiming` choice the deck makes, so the durations compare
  like with like.
- If `total_bytes * 8 / bitrate` disagrees with `copy_duration_sec` by more
  than `DRIFT_TOLERANCE_SEC`, the outcome is `copy-mismatch`. The window cannot
  be shown to come from the copy the deck will play.
- This catches the flightcast-style lie on hosts the probe grid has not caught
  yet, without condemning hosts that have not been caught (the amendment's
  rule 4).

**Is a mid-stream slice decodable?**
- An MP3 frame stream resynchronises at the next frame header, so a slice cut at
  an arbitrary byte normally decodes after one frame. The bit reservoir can
  corrupt the first frame.
- Whether `SFSpeechURLRecognitionRequest` accepts a headerless MP3 slice is a
  **device check** (§8, `slice-decode`). It is not assumed.
- The fallback, if it does not: parse the slice with `AudioFileStream`, which
  is built for mid-stream data, decode it to PCM buffers, and feed
  `SFSpeechAudioBufferRecognitionRequest`. The origin arithmetic is unchanged.

**Cues.**
- Each `SFTranscriptionSegment` becomes one cue:
  `{ text: substring, start_sec: slice_origin_sec + timestamp, end_sec: + duration }`.
- That is the `{ text, start_sec, end_sec }` shape `anchorMatch` documents. It
  is passed to the Swift port of `anchorMatch` and `locatedBounds`, and the
  result goes to the core as an input event.
- On-device segments are per word, which is finer than a publisher transcript's
  cue. That is good for the out-point.

**Split between core and shell.**
- The arithmetic is pure and lives in the core: `locateWindow`,
  `locateFetchRanges`, `anchorMatch`, `locatedBounds`, the precedence and the
  cache rules. It is parity-pinned (§8).
- The I/O lives in the shell: the ranged GET, the temporary file, the
  recogniser, the network path, authorization and the deadline. It reports
  results to the core as inputs (`EngineInput`), the same way the deck
  reports.
- The core stays main-confined. The recogniser's callbacks hop to main before
  they enter it.

**Deadlines and cleanup.**
- Each item has a deadline, `LOCATE_ITEM_DEADLINE_SEC` (proposal: 120 s,
  `// MEASURE`, set from DAI-12's wall time). Missing it gives the outcome
  `timeout`.
- Temporary files go in `NSTemporaryDirectory()`. They are deleted on every exit
  path and do not count against the download cap (`docs/roadmap/README.md`
  question 17's proposed 2 GB).

**Android: deferred.**
- Android's `SpeechRecognizer` takes microphone input, not a file. The
  candidate is whisper.cpp `tiny` through JNI, which is a separate decision
  about package size and CPU.
- Android advertises no `locate` capability, and the `locate` family is booked
  for the JVM the way every unported family is
  (`player/parity/jvm-pending.json`, retired by A-63).
- The PWA stays skip (Q5).

---

## 7. Cards proposed for the native deck

These are **proposals**. This doc does not edit `docs/native-engine-plan.md`.
Whoever adds them to §14 there assigns the final ids.

- **Ids.** In the NE-4x range, NE-43 is the only number not taken (§14 uses
  NE-40, 40d, 41, 42, 44, 45j/s, 46, 47 and 48), so the cards are proposed as
  NE-43a-h.
- **Sizes** follow plan §12: S ≤ ½ day, M ≤ 2 days, L ≤ 5 days.
- **`hold` label.** Every card that touches `mobile/plugins/*/ios/**` or
  `foray-engine-core/**` opens with the `hold` label.
- **One change per behaviour.** Since NE-39s nothing can be owed. A behaviour
  change ships its JS, its re-record and its Swift port together, which is why
  the JS reference and its Swift port are one card here.

| id | title | size | depends on | gate |
|---|---|---|---|---|
| NE-43a | The `locate` family: JS reference and Swift port of the pure half | L | DAI-10, DAI-11, NE-28s | — |
| NE-43b | Contract and vocabulary: `locateForay`, `allowLocate`, snapshot `locate`, `locate` event, `locateOutcome` tokens, untrusted-host constant | M | NE-43a | — |
| NE-43c | Core: LocateCache, load-time lookup and re-target, `deckBounds` everywhere, clamped Foray clock, `locateEnabled` flag (off) | L | NE-43a, NE-43b, NE-32 | — |
| NE-43d | Shell Locator: ranged GETs to a temp file, CBR origin, copy-consistency check, on-device recognition, network gate, deadline, rows | L | NE-43c | Info.plist key (human merge); privacy wording routed to the founder |
| NE-43e | Page: `locateForay` at Foray open, the `locating…` rows, facade | M | NE-43b | — |
| NE-43f | `check-forays.mjs`: a published Foray may draw on a LOCATE-REQUIRED source | S | NE-43h | Q5 |
| NE-43g | `engine-report.mjs` locate verdicts and the device-check rows | M | NE-43d | — |
| NE-43h | The flip: `LOCATE_SHIPPED = true`, advertise `locate`, `EngineConfig.locateEnabled` on in EngineBoot; DECISIONS entry in its own PR (G-7) | S | NE-43c, NE-43d, NE-43e, NE-43g green on device | Q2, Q5, Q6 |

**NE-43a · The `locate` family — L.**
- **JS reference.** `LOCATED` and the `located` input to `seekPrecision` and
  `segmentLoadGate`. `deckBounds()`. `locateFetchRanges()` and
  `END_ANCHOR_LEAD_SEC` in `player/locate-window.js`. `LOCATED_END_GUARD_SEC`.
  The `allowLocate` build option in `player/foray-queue.js` (it keeps
  LOCATE-REQUIRED items) and `LOCATE_SHIPPED = false`.
- **Fixtures.** A `locate` fixture family whose cases are recorded from DAI-10,
  DAI-11 and the precedence rule (§8). New `seek-policy` cases for rung 4.
- **Swift.** `LocateWindow.swift` and `AnchorMatch.swift` in
  `foray-engine-core`. Rung 4 in `SeekPolicy.swift`.
- **Owned files.** `player/seek-policy.js`, `player/foray-queue.js`,
  `player/locate-window.js`, their tests, `player/parity/fixtures/locate/**`
  (recorded, never hand-edited), and `foray-engine-core/Sources/ForayEngineCore/Policy/**`.
- **Acceptance.** `node tools/parity/record.mjs --check` is green. `engine-parity`
  runs every `locate` and `seek-policy` case in Swift with equal counts, and
  the run id is quoted. With `allowLocate` off, every existing
  `foray-playback` and `seek-policy` case is unchanged.
- **Device check.** None.

**NE-43b · Contract and vocabulary — M.**
- **Contract.** The §5 command, argument, snapshot field and event, in
  `player/engine-contract.js`, the schema, and `ContractDecoding.swift`.
- **Vocabulary.** `locateOutcome` in `player/engine-vocabulary.js`, then
  `gen-constants.mjs --write`.
- **Untrusted hosts.** `RANGED_GET_UNTRUSTED_HOSTS` moves to one player-side
  module that `tools/transcribe/ad-inflation.mjs` re-exports. Every caller keeps
  its behaviour, there is one list, and the Swift copy is generated.
- **Acceptance.** The `contract` and `diag-tokens` families are green in both
  languages. An old page's `playForay` with no `allowLocate` still decodes.

**NE-43c · Core — L.**
- **Cache.** LocateCache, with the key, invalidation, age, LRU and purge rules
  of §3, under an engine-owned prefix.
- **Load.** The prediction before load, re-targeting during gating, and the
  standby `prepare` using `deckBounds` (§2).
- **Clock.** The Foray clock clamps over a located span (§1).
- **Gating.** `locateForay` is refused `capability-off` while
  `EngineConfig.locateEnabled` is off (default off, plan §12).
- **Acceptance.** XCTests for each §2 rung against a fake deck. The
  `seek-policy` and `outpoint` families are unchanged. A located item's
  `outPoint` row shows `end = located.end_sec + stopPad`.

**NE-43d · Shell Locator — L.** Everything in §6 that does I/O. It includes the
`NSSpeechRecognitionUsageDescription` key (human merge on `ios/App/**`) and the
`locate` rows.
- **Acceptance.** A Simulator XCTest over a bundled CBR click-and-speech fixture
  (under 1 MB) locates two anchors within one frame of their known times. A
  VBR fixture is refused `vbr-origin`. A `Content-Range` total that disagrees
  is refused `copy-mismatch`. The temporary files are gone after every path.
- **Device check.** The §8 rows.

**NE-43e · Page — M.**
- `renderForay(id)` sends `locateForay` when `engineHello` lists `locate`.
- The `locating…` row state and summary line come from the snapshot.
- The `NativeManagerFacade` gets a passthrough.
- `allowLocate` goes through `forayQueueOptions()`.
- **Acceptance.** A page test drives a fake snapshot through
  `pending → located` and `pending → missed`. The web build sends nothing and
  renders nothing new.
- **Note.** It touches `app.js` and `player/client.js`, so it waits for a free
  slot in each.

**NE-43f · Publishing LOCATE-REQUIRED Forays — S.**
- Relax DAI-06's refusal in `tools/foray/check-forays.mjs`, only after Q5 is
  answered and NE-43h has landed. Until then a published Foray that draws on
  such a source is a Foray whose web listeners see skipped segments.
- **Acceptance.** The existing DAI-06 cases are flipped explicitly, with the
  ruling cited from `docs/DECISIONS.md`.

**NE-43g · Report and rows — M.** `engine-report.mjs` turns `locate` rows into
verdicts: hit rate per show, median and p90 `ms`, `bytes` per item and the
`outcome` mix. It also adds the §8 device-check rows to
`docs/ios-native-engine-measurements.md`.

**NE-43h · The flip — S.**
- Set `LOCATE_SHIPPED = true`, advertise `locate`, and turn
  `EngineConfig.locateEnabled` on in EngineBoot.
- The DECISIONS entry goes in its own PR (G-7).
- **Gate.** Founder Q2, Q5 and Q6, and the device rows of §8 read green.

**Not carded here.** Android (§6). Chromaprint (Q2's alternative). Exact
scrubbing across an in-segment mid-roll (§1).

---

## 8. Acceptance

**A `locate` parity family.** JS is the reference, as everywhere in the deck.
The family's JS reference is exactly three things:
1. **DAI-10:** `locateWindow`, `windowBytes`, `locatedBounds`, plus the
   proposed `locateFetchRanges`, in `player/locate-window.js`.
2. **DAI-11:** `anchorMatch` and `wordEditDistance` in
   `tools/transcribe/anchor-match.mjs`. Ties, the `L-1, L, L+1` window order and
   the divisor rule are pinned by fixtures, because they are where a port
   drifts.
3. **The precedence rule of §2:** `seekPrecision` and `segmentLoadGate` with a
   `located` input, and `deckBounds`.

**Case groups the family records.** Each group has the shortest cases that pin
it:
- **window:** reach from `ad_pad_sec`, the zero clamp on the lead, the margin
  refusal, one range versus two, and the end-anchor lead.
- **match:** exact, one slip, two slips at 0.75, below the threshold, a tie
  broken by the earliest start, the length order, an empty or too-short anchor,
  and out of range.
- **bounds:** a shift of 0, a forward shift, a span longer than authored (an
  in-segment mid-roll), a span shorter than authored, an end before the start,
  and each hit outside its range.
- **precedence:** each rung of §2 winning over the ones below it; located versus
  padded with both present; rung 3 versus located with both present; a cache
  entry outside drift tolerance, which falls through and invalidates;
  `allowLocate` off; and the web shape (no `located`), which is identical to
  today.
- **bounds-at-load:** `deckBounds` for located and unlocated items,
  `ad_pad_applied_sec` reported as 0, the out-point with `stopPad`, the clamped
  Foray clock, and scrub mapping.

**Fixture handling.** Fixtures are recorded with `tools/parity/record.mjs` and
never hand-edited. The family appears under the `locate` capability in
`player/parity/capabilities.json`.

**The capability gate.** The engine may advertise `locate` only when Swift runs
the whole family green. Since NE-39s nothing can be owed, so this is the same
condition as "NE-43a is merged".

**Device checks.** These are rows, not assertions. Each one names the question
it settles:

| row | question | settles |
|---|---|---|
| `slice-decode` | Does `SFSpeechURLRecognitionRequest` accept a headerless mid-stream MP3 slice? | §6 path or the `AudioFileStream` fallback |
| `asr-length` | Does on-device recognition finish a 14-minute file, and in how long? | `LOCATE_ITEM_DEADLINE_SEC` |
| `asr-background` | Does recognition continue while the app is backgrounded and audio plays? | §4 retry rule |
| `outpoint-guard` | How early does the recogniser end the last anchor word? | `LOCATED_END_GUARD_SEC` |
| `relocate-drift` | Does a second locate of the same item a day later agree? | `LOCATE_MAX_AGE_HOURS` |
| `battery` | What share of battery does a 7-item SYSK Foray's locating cost? | Q6 and whether locating needs a power gate |

**Product acceptance for the flip (NE-43h).**
- On one real SYSK Foray, on device and on Wi-Fi, the located segments start
  within one spoken word of their authored text and never cut the end word
  (listened, and logged by the `outPoint` rows).
- A segment that is not located plays padded or is skipped, never at the stale
  offset.
- Tap-to-audio stays inside its budget with locating in flight.

---

## 9. Feasibility numbers and founder questions

### Feasibility numbers: pending DAI-12

**Not measured.** DAI-12 needs `whisper-cli` and `ffmpeg`, and neither is on
the PC (checked 2026-10-06).

DAI-12 will publish `docs/curation/locate-step-feasibility-2026-09.md` with
three numbers per anchor and model, with the device and model named:
- time-to-locate;
- hit or miss per anchor, with its score;
- bytes fetched.

When it lands, this section quotes those numbers and sets the provisional
values above that wait on them: `LOCATE_ITEM_DEADLINE_SEC`, the Wi-Fi/cellular
cost per item for Q6, and the `asr-length` expectation. whisper.cpp `tiny.en`
on a PC is a stand-in for `SFSpeechRecognizer` on a phone. Its timing bounds
nothing on the device; its hit rate is the useful half.

Until then, the only figures available are inferred:
- the window is about 13.6 min of audio for a 2-minute SYSK segment (ADR-0008,
  windowed ASR, "~13.6 min … instead of 47");
- recognition is "tens of seconds on-device" (dai-playback-brief §3 option D,
  marked inferred there).

### Founder questions

The defaults below come from `docs/roadmap/dai.md` (open founder questions 2, 5
and 6) and `docs/roadmap/README.md` question 15. **They are PROPOSALS, not
rulings.** Nothing in this doc records any of them as decided.
`player/seek-policy.js`'s `AD_PAD_SHIPPED` comment reads README question 15 as
a ruling. This doc does not take that reading, and it needs nothing from it.

| # | question | default (PROPOSAL, not a ruling) | what in this design waits on it |
|---|---|---|---|
| Q2 | D5/OQ1: on-device windowed ASR or Chromaprint first? | ASR first (option D). The timed-transcript supply is publisher-transcript, and fingerprinting cannot serve it. | NE-43h, and the funding of NE-43a-g after this doc (D5 gates the funding, not the writing). |
| Q5 | Native-only acceptance: "DAI shows play in the app, skip on the web"? | Yes; the PWA stays skip. | NE-43f (publishing LOCATE-REQUIRED Forays) and NE-43h. |
| Q6 | Cellular budget for the locate prefetch (up to ~14 min of audio per SYSK segment)? | Wi-Fi only until DAI-12 measures bytes. | §4's network gate. NE-43d builds it Wi-Fi-only either way; Q6 decides whether a cellular arm exists. |
