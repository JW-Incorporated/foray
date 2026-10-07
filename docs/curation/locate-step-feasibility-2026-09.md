# Locate-step feasibility on one SYSK episode (G-41 first step) — harness, anchors and window plan; ASR numbers PENDING

**Card:** DAI-12 (`docs/roadmap/dai.md` §DAI-12), the "measurable first step"
of G-41 (`docs/curation/foray-to-spec-roadmap.md`, G-41). **Date:** 2026-10-06.
**Status:** part done. The episode, the three anchors, the harness and the
window/bytes plan are here and checked. **Time-to-locate and hit/miss are NOT
measured** (§6 says why and how to finish). Nothing in this doc is a founder
ruling; the Q6 reading in §5 is a **proposal**.

What D5 / ADR-0008 OQ1 needs from this card is three numbers per anchor and
model: bytes fetched, time-to-locate, hit/miss with its score. This doc
delivers the first one as arithmetic at **assumed** bitrates, and the tool
that delivers the other two on a machine with `whisper-cli` and `ffmpeg`.

## 1. The method in one paragraph

Each anchor is treated as the start anchor of a 2-minute authored segment. Its
window is `locateWindow({ start_sec, end_sec: start_sec + 120, delta_max_sec: 534, spread_sec: 80 })`
from `player/locate-window.js` (DAI-10): fetch from the authored start to
`end + delta_max + margin`, and search for the start anchor in
`[start_sec, start_sec + delta_max + margin]`. 534 s is SYSK's worst implied
delta (`docs/curation/dai-playback-brief-2026-09-10.md` §3 table, "455 s /
534 s"); 80 s is the margin of the brief's SYSK example (DAI-10's first test,
`player/locate-window.test.js`). The bytes are `windowBytes(span, bitrate)`.
The match is `anchorMatch(cues, anchor, search_start)` from
`tools/transcribe/anchor-match.mjs` (DAI-11, `MIN_MATCH_SCORE` 0.75). The
harness `tools/transcribe/locate-feasibility.mjs` reimplements none of it.

## 2. The episode

| field | value |
|---|---|
| show | Stuff You Should Know (`stuff-you-should-know`) |
| episode | "Rope, yeah ROPE!" |
| guid | `7ed1fbda-af64-402d-b3a6-b4ab014226d7` |
| published | Thu, 20 Aug 2026 |
| feed `duration_sec` | 2,611 (`data/transcript-availability.json`) |
| program time (last cue end) | 2,604.72 s |
| transcript | Omny WebVTT, normalized on the PC at `data-local/transcripts/normalized/stuff-you-should-know-35351a45dc/7ed1fbda-af64-402d-b3a6-b4ab014226d7-1edd6a07f5.json` (817 cues; normalizer warnings: 1 rolling-caption tail trimmed, 9 cues overlap their predecessor) |
| DAI screen | `dai_suspected: true`, `dai_reason: host:26833.mc.tritondigital.com` (the availability row) |

**Why this one.** It is the newest regular episode (not a "Selects" rerun,
not Short Stuff) whose normalized publisher transcript is on the PC.
`data-local/` is gitignored, so the transcript is read from the main
checkout, not the worktree. **No SYSK audio is on the PC and none was
downloaded** (orchestrator instruction for this run).

## 3. The anchors

Three verbatim anchors of 10-11 words (ADR-0007 asks for 8-12), each starting
on a cue boundary so its authored time is the cue's start. Program time is the
publisher transcript's timeline.

| id | at | authored start_sec | anchor (verbatim) |
|---|---|---|---|
| a10 | 10.4 % | 269.80 | "you're actually storing somehow some energy or force in the rope" (11 words) |
| a50 | 50.1 % | 1,304.20 | "and then you have these gears moving in different directions" (10 words) |
| a90 | 90.0 % | 2,345.12 | "then you need to go to a nylon rope because" (10 words) |

The harness reads the block below directly (`--anchors-json` on this file);
it is the single copy.

<!-- locate-anchors:begin -->
```json
{
  "episode": {
    "show_id": "stuff-you-should-know",
    "title": "Rope, yeah ROPE!",
    "guid": "7ed1fbda-af64-402d-b3a6-b4ab014226d7",
    "pub_date": "Thu, 20 Aug 2026 09:00:00 +0000",
    "feed_duration_sec": 2611,
    "program_end_sec": 2604.72,
    "transcript": "data-local/transcripts/normalized/stuff-you-should-know-35351a45dc/7ed1fbda-af64-402d-b3a6-b4ab014226d7-1edd6a07f5.json"
  },
  "window": { "segment_sec": 120, "delta_max_sec": 534, "spread_sec": 80 },
  "anchors": [
    { "id": "a10", "at_pct": 10.4, "start_sec": 269.8, "text": "you're actually storing somehow some energy or force in the rope" },
    { "id": "a50", "at_pct": 50.1, "start_sec": 1304.2, "text": "and then you have these gears moving in different directions" },
    { "id": "a90", "at_pct": 90.0, "start_sec": 2345.12, "text": "then you need to go to a nylon rope because" }
  ]
}
```
<!-- locate-anchors:end -->

**Checked against the publisher transcript** (`--check`, run 2026-10-06):
each anchor occurs exactly once verbatim in the whole episode
(`findAnchorOccurrences`), at its recorded start, and `anchorMatch` finds it
with score 1 inside its own search range.

```
ok   a10: 11 words, 1 occurrence(s), score 1
ok   a50: 10 words, 1 occurrence(s), score 1
ok   a90: 10 words, 1 occurrence(s), score 1
```

**Plumbing check** (`--check --simulate-shift-sec N`): the publisher cues that
would lie inside each window of a copy running N s late are written out as
whisper-cli `-oj` JSON (millisecond offsets relative to the cut), then go
through the same normalise-and-match code the `--audio` path uses. This tests
the cut origin, the offset units and the search range. It says **nothing**
about recognition, because the words are the publisher's.

| simulated shift | a10 | a50 | a90 |
|---|---|---|---|
| 0 s | hit, shift 0 | hit, shift 0 | hit, shift 0 |
| 300 s | hit, shift 300 | hit, shift 300 | hit, shift 300 |
| 534 s (`delta_max`) | hit, shift 534 | hit, shift 534 | hit, shift 534 |
| 700 s (beyond the 614 s reach; negative control) | miss | miss | miss |

## 4. The window and bytes plan (arithmetic; the bitrates are ASSUMPTIONS)

`node tools/transcribe/locate-feasibility.mjs --plan --anchors-json docs/curation/locate-step-feasibility-2026-09.md --bitrate-bps 64000 --bitrate-bps 128000`:

| anchor | at | start s | fetch window s | span s | bytes @ 64 kbps (ASSUMED) | bytes @ 128 kbps (ASSUMED) |
|---|---|---|---|---|---|---|
| a10 | 10.4 % | 269.8 | 269.8–1,003.8 | 734 | 5,872,000 (5.87 MB) | 11,744,000 (11.74 MB) |
| a50 | 50.1 % | 1,304.2 | 1,304.2–2,038.2 | 734 | 5,872,000 (5.87 MB) | 11,744,000 (11.74 MB) |
| a90 | 90.0 % | 2,345.12 | 2,345.12–3,079.12 (past program end) | 734 | 5,872,000 (5.87 MB) | 11,744,000 (11.74 MB) |

- **The span is 734 s (12.2 min) for every anchor**: 120 s of segment plus
  534 s `delta_max` plus 80 s margin. It does not depend on where the anchor
  sits. The start-anchor search range is the first 614 s of it.
- **Sensitivity: ADR-0008's own sizing.** ADR-0008 sizes the SYSK window on
  `delta_max` 10.0 min plus its 1.6 min cross-episode spread ("~13.6 min",
  `docs/adr/0008-ad-tolerance-and-timestamp-precision.md` around line 432). The
  same command with `--delta-max-sec 600 --spread-sec 96` gives a span of
  816 s: 6,528,000 bytes at 64 kbps and 13,056,000 at 128 kbps. The brief's
  534 s comes from the ranged-GET screen; ADR-0008's 600 s from full downloads
  (+8.4 to +10.0 min). Which one the product uses is the pad tier's
  `delta_max`, not this card's choice.
- **a90 runs past the end of the program timeline.** 3,079 s is beyond the
  2,604.72 s program. In an ad-loaded copy the file is longer: SYSK's median
  inflation of 1.178 (brief §3) puts it near 3,068 s, and the 1.209 worst case
  near 3,149 s. A ranged GET past end of file returns what exists, so for a90 the
  byte figure is an **upper bound**. The native fetch must clamp to the copy's
  length, not treat a short response as an error.
- **Why the bitrate is assumed, not read.** The availability row has no byte
  length. Learning it takes a ranged GET to the host, and DAI-08's pad probes
  (#1150, round 1 of 2) are in flight against the same hosts. The politeness rule
  is one request at a time per host, so this card issued none. 64,000 and 128,000
  bps are the low and middle of `PLACEHOLDER_BITRATES_BPS`
  (`tools/transcribe/ad-inflation.mjs`, the round bitrates publishers' tooling
  multiplies by). DAI-10's test uses 96 kbps (734 s → 8,808,000 bytes), between
  the two. Anyone with a real copy can replace the assumption:
  `windowBytes(734, bytes * 8 / decoded_duration)`.

## 5. Cellular-budget reading for Q6 — PROPOSAL, not a ruling

Q6 (`docs/roadmap/dai.md` open founder question 6; `docs/curation/locate-step-design.md`
§9) asks what cellular budget the locate prefetch may spend. Its proposed
default, "Wi-Fi only until DAI-12 measures bytes", is a proposal too. These
are the numbers it was waiting for, read at the two assumed bitrates.

| | @ 64 kbps | @ 128 kbps |
|---|---|---|
| one located SYSK segment (734 s window) | 5.9 MB | 11.7 MB |
| the segment's own 120 s of audio | 0.96 MB | 1.92 MB |
| overhead factor (window ÷ segment) | 6.1× | 6.1× |
| a 7-item all-SYSK Foray (7 windows) | 41 MB | 82 MB |
| the same if each window is kept and plays the segment (net extra = 614 s per item) | 34 MB extra | 69 MB extra |

**PROPOSAL (for the founder, not decided):** keep Wi-Fi only as the default.
Locating costs about six times the audio it unlocks. Locating a 7-item SYSK
Foray costs about two whole-episode downloads at the same bitrate: 41 MB
against 20.9 MB for the 2,611 s episode at 64 kbps, and 82 MB against 41.8 MB
at 128 kbps. If a cellular arm is wanted later, it would be an explicit
opt-in that shows the per-Foray estimate (`windowBytes` × items) before it
starts. It would not be a silent default. The question stays open in the
founder queue (#1163). §6's measurement does not change these bytes. It
changes only whether the 6× buys a hit.

## 6. Not measured: time-to-locate and hit/miss per anchor

| anchor | model | cut bytes | time-to-locate | hit / miss | score |
|---|---|---|---|---|---|
| a10 | tiny.en | pending | pending | pending | pending |
| a10 | base.en | pending | pending | pending | pending |
| a50 | tiny.en | pending | pending | pending | pending |
| a50 | base.en | pending | pending | pending | pending |
| a90 | tiny.en | pending | pending | pending | pending |
| a90 | base.en | pending | pending | pending | pending |

**Why not.**
- There is no `whisper-cli` and no `ffmpeg` on this PC (`which` found neither,
  2026-10-06), and no Mac for `SFSpeechRecognizer`. `docs/roadmap/dai.md` names
  exactly this case as a stop: "the doc records 'not measured' and why".
- There is no SYSK audio on the PC. The orchestrator's instruction for this
  run was to download none, so none was fetched.

**What will not change.** The bytes in §4 are arithmetic and stand. The anchors
in §3 are checked. Only the ASR column is open. whisper.cpp on a PC stands in
for the device. Its wall time bounds nothing on a phone. Its hit rate is the
useful half (`locate-step-design.md` §9).

**To finish (one machine, nothing else running: whisper.cpp is the heaviest
process in the DAI package):**
1. Get one copy of this episode (guid above) with
   `tools/transcribe/fetch-audio.mjs` into `data-local/`. Do it only when no
   DAI-08 probe round is running against the same host.
2. `node tools/transcribe/locate-feasibility.mjs --check --anchors-json docs/curation/locate-step-feasibility-2026-09.md --cues <transcript above> --simulate-shift-sec 300`
   must print three `ok`.
3. `node tools/transcribe/locate-feasibility.mjs --audio data-local/<file>.mp3 --cues <transcript> --anchors-json docs/curation/locate-step-feasibility-2026-09.md --model models/ggml-tiny.en.bin --model models/ggml-base.en.bin --json`.
   The models run one after the other, never at once. Per anchor the harness
   cuts with `ffmpeg -ss <fetch_start_sec> -to <fetch_end_sec> -i AUDIO -c copy cut.mp3`.
   Both are input options, so `-to` is absolute. It records the cut's size on
   disk as the measured bytes, decodes to 16 kHz mono WAV, runs
   `whisper-cli -m MODEL -f cut.wav -l en -oj`, and shifts the cues by
   `fetch_start_sec`. It then matches within the start search range and records
   the cut, decode, ASR and match wall time with the CPU model.
4. Fill the table above, plus the device, the model files (name and size), the
   `whisper-cli` build and the `ffmpeg -version` line. Add a one-paragraph
   reading. Then delete the audio (the harness deletes its own cuts; the source
   file is yours to delete).

**What the run should watch for.** These are inferred, not measured.
- A cut taken with `-c copy` starts on an MP3 frame boundary, not at exactly
  `fetch_start_sec`. The error is one frame (about 26 ms). It is below cue
  resolution, but the device check of slice time zero
  (`locate-step-design.md`, "Time zero of a slice") is the real answer.
- These are start anchors. The end-anchor lead (`END_ANCHOR_LEAD_SEC`,
  `locate-step-design.md`) is not exercised here.
- Expect the located start to land 0 to 534 s late. Each anchor's shift is the
  ad time inserted before it in that copy, so a10 < a50 < a90 if the copy has
  mid-rolls.

## 7. The harness's own checks (mutations run 2026-10-06)

`tools/transcribe/locate-feasibility.mjs` is a throwaway tool, not a suite.
Its name matches no pattern `tools/ci/run-suites.mjs` discovers, and it adds no
floor. Its `--check` mode is what guards the anchors, and each guard was
checked by breaking it:

| mutation | how it shows | result |
|---|---|---|
| one anchor word altered (`rope` → `rop`) | 0 verbatim occurrences; anchorMatch 0.9 | `--check` exit 1 |
| a90 recorded at 2345 instead of 2345.12 | "occurs at 2345.12 s, recorded 2345 s" | exit 1 |
| a 6-word anchor | "6 words, ADR-0007 asks for 8-12" | exit 1 |
| code: drop the 8-12 word bound | the 6-word anchor passes | exit 0 (mutation caught by the 6-word case) |
| code: `whisperJsonToCues` ignores the cut origin | simulated +300 s cut locates at +30.2 s | exit 1 |
| code: drop the recorded-start check | still exit 1, via the anchorMatch start check | survives alone (the two guards overlap; kept both) |
| simulated shift 700 s > 614 s reach (negative control) | all three miss | exit 1 |
