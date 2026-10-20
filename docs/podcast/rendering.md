# Rendering a podcast episode

Status: tool landed 2026-10-20 (#1457, part of #1425). It turns a Foray into the
two files the feed serves (`.mp3`, `.m4a`) with chapters, and records them in
`data/podcast/episodes.json`. The flagship (`asteroids-flagship-1`) was first built
by hand in about six hours; this is that pipeline as commands. Hosting and the
feed itself are in `docs/podcast/hosting.md`.

## The commands

```
# 0. Dependencies (Python 3.12, ffmpeg + ffprobe on PATH or --ffmpeg DIR)
pip install -r tools/podcast/requirements.txt
python tools/podcast/render-episode.py --check

# 1. Plan: Foray id -> plan.json (committed data only, no audio, no network)
node tools/podcast/render-plan.mjs asteroids-flagship-1 --out data-local/podcast/plan.json

# 2. Fetch: download each enclosure once, verify delivered duration vs the feed
python tools/podcast/render-episode.py fetch data-local/podcast/plan.json

# 3. Narration must already be rendered (tools/narration/render-foray.py), see below.
#    Bake: per-item mastering -> master.wav + bake.json
python tools/podcast/render-episode.py bake data-local/podcast/plan.json \
    --out data-local/podcast/render --narr-dir PATH_TO_RENDERED_NARRATION

# 4. Finish: chapters into both containers, encode, measure, report.json
python tools/podcast/render-episode.py finish --out data-local/podcast/render

# 5. Record the result in the episode manifest, then check it
node tools/podcast/update-episode.mjs asteroids-flagship-1 --dir data-local/podcast/render
node tools/podcast/build-feed.mjs --check
```

`render-episode.py all plan.json --out DIR --narr-dir DIR` runs fetch, bake and
finish. `bake --dry-run` prints every ffmpeg argv, the limiter filter graph, the
target loudness and the seam gaps as JSON, and needs no audio. `data-local/` is
never committed; neither is any audio.

To render from audio you already hold, skip the download: `--src-map map.json`
(`{source_id: path}`) makes `fetch` verify those files instead of downloading, and
`bake` reads them. `--narr-dir` takes either the layout `render-foray.py` writes (an
audio file with a sidecar `.json` carrying `foray_id` and `item_id`) or flat
`<item id>.wav|m4a|mp3|flac` files.

## Inputs

| input | where | used for |
|---|---|---|
| item order, narration scripts, slot titles | `data/forays.json` | the plan's items |
| cut points (`start_sec`, `end_sec`) | `data/segments.json` | each clip's in/out; the committed boundaries are honoured as they stand |
| enclosure URL, feed duration | `data/segment-sources.json` | `fetch`, and the duration check |
| title, album, artist, comment, file basename, **chapter titles** | `data/podcast/episodes.json`, the entry's `render` block | tags and chapters |
| rendered narration audio | `--narr-dir` | one file per narration item |

Chapter titles are not derivable from the other data (the flagship's were written
by hand), so they are stored as `render.chapter_titles` (`{narration id: title}`) in
the episode entry. One chapter per narration item, starting at the narration. A
narration with no stored title falls back to its slot title and the plan prints a
warning; write a real title before shipping.

## What each step refuses

| step | refuses | why |
|---|---|---|
| `render-plan` | a segment missing from `segments.json`, a source missing from `segment-sources.json` or without an `audio_url`, `end <= start`, a narration with no script | the plan must come from committed data |
| `fetch` | a delivered duration more than 1.5 s from the feed's, naming the clips and pointing at the locate step (#1428) | a mismatch means dynamic ad insertion or a re-encode; the committed cut points are wrong on that audio (#1441) |
| `bake` | a missing source file (says to run `fetch`) or a missing narration render, before any ffmpeg runs; an unknown seam type or channel layout | no half-baked master |
| `finish` | a master that measures more than 0.5 LU from the target (#1453); a loudnorm that fell back to dynamic mode (`--loudnorm` only, #1451); an encoded true peak over -1 dBTP after three tries | a loud or clipped file does not ship; `report.json` is still written |
| `update-episode` | a report whose true-peak check failed, a missing or empty encode, a Foray with no episode entry | the manifest only records a render that passed |

## What bake does (and where each number came from)

Every tuned constant is at the top of `render-episode.py` with the lesson issue it
came from (#1451 compression, limiter and true-peak loop; #1452 seam gaps, pad trim
and fades; #1453 channel-layout loudness). In short, per item on a 44.1 kHz float
mono working signal:

1. Tape clips are decoded through a gentle speech compressor (-20 dBFS, 3:1, 10/150
   ms). Narration has its 0.5 s edge pad trimmed to 0.12 s.
2. Level-match to the target for the **output** layout, measured on that layout:
   **-16 LUFS for a stereo build, -19 for a mono build** (#1453). The flagship
   matched a mono signal to -16 and wrote it as dual-mono stereo, which measured
   -13.1 and needed a hand-applied -2.9 dB; that constant is gone.
3. A 4x-oversampled limiter at -2 dBFS bounds each item's true peak.
4. Fades: tape 25 ms in / 80 ms out, narration 15 ms.
5. Items are joined with shared pink room tone at -66 dBFS, never digital black. The
   gap depends on the seam type: tape to narration, narration to tape and narration
   to narration 0.45 s; tape to tape 0.6 s.

No loudness processing runs on the master. `finish` applies a pure gain only if the
encoded true peak is over -1 dBTP. Output layout is the plan's `channels`
(`render-plan --channels`, default stereo) or `bake --channels`.

## Optional checks (need faster-whisper, both slow)

`align` transcribes +-14 s around every clip edge with word timestamps (decoded by
ffmpeg to PCM, no PyAV) and writes the words as evidence for choosing cut points
(#1442). It ran at 0.17x realtime on a contended laptop (#1446): run it on the Spark
or GPU box, not casually. `seamcheck` transcribes from 0.3 s before each tape edge
of the encoded file to prove no word was clipped (#1458).

## Not yet automated

- **Narration rendering.** Still `tools/narration/render-foray.py` on the Spark or
  locally; this tool reads its output and does not call it.
- **The ASR round trip** on rendered narration (L18, L20), and sending flagged lines
  back to the writer.
- **Edge alignment to cut points.** `align` produces words; turning them into
  committed `start_sec`/`end_sec` (snap in to the first word of the run-up sentence
  minus 0.25 s, out to the last word plus 0.35 s) is still a curation step.
- **Locating clips by ASR** when `fetch` refuses (#1428).
- **Show notes** (`show-notes.md`: per-show blocks, links table, dated facts, call to
  listen, #1455). The episode manifest already carries the show data; no generator yet.
- **Seam gaps computed from measured edge silence** (#1452 wants this; the gaps are
  still the flagship's fixed values per seam type).
- **A human listen.** Nothing here replaces it; the flagship was never heard by its builder.
- **Upload and publish** (`docs/podcast/hosting.md`).
