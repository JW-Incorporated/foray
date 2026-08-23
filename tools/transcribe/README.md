# tools/transcribe — self-hosted transcription environment

Result of the **T1 gating spike** ([#116](https://github.com/JW-Incorporated/foray/issues/116)):
can we transcribe real podcast episodes ourselves, and how fast?

**Short answer: it installs and runs cleanly — and it is too slow on this
laptop to be the default for anything larger than a pilot.**

- **Setup: no problems.** No system-wide installs, no external ffmpeg binary,
  no Python-version fallback. Word-level timestamps are exact.
- **Throughput: 1.33x realtime for `base.en`**, at 2.36 effective threads of the
  16 requested. `small.en` is ~0.5x, `medium.en` ~0.15x — both unusable here.
- **Consequence:** ~20 episodes is a weekend. The 406-episode curated non-DAI
  pool is **~308 hours** of compute, which this machine cannot deliver while
  also being used for development. Scale needs the GPU host (#118 / T7).

Everything below is measured on this hardware, not estimated.

This is rung 4 of [ADR 0004 — Transcript Acquisition Ladder](../../docs/adr/0004-transcript-acquisition-ladder.md)
("Whisper, self-hosted or API, last resort"), and specifically the
*workstation-hosted* `TranscriptionProvider` that ADR describes. Nothing here
wires into the ingest pipeline — this spike only answers "is self-hosting
fast enough to be the default, or is it the fallback?"

Two paths are documented: the **CPU path** (verified end-to-end here) and the
**CUDA path** (written for the GPU machine in
[#118 / T7](https://github.com/JW-Incorporated/foray/issues/118) — *not* verified
here, because this machine has no discrete GPU). The benchmark harness
`bench.py` takes `--device` and `--model` as arguments precisely so the two sets
of numbers are directly comparable.

---

## 1. What worked (CPU path, verified)

| | |
|---|---|
| OS | Windows 11 Home 26200 |
| CPU | Intel i7-13620H, 10 cores / 16 threads |
| RAM | 15.7 GB |
| GPU | none usable (integrated Intel only) |
| **Python** | **3.14.5** — `faster-whisper` installed on it with **zero trouble** |
| `faster-whisper` | 1.2.1 |
| `ctranslate2` | 4.8.1 (`ctranslate2-4.8.1-cp314-cp314-win_amd64.whl` — cp314 wheels exist) |
| ffmpeg | **not needed** (see below) |

### The two things worth knowing

1. **Python 3.14 is fine.** The issue anticipated CTranslate2 wheels lagging the
   new Python minor. They don't — `ctranslate2` 4.8.1 publishes a `cp314`
   Windows wheel, and `onnxruntime` 1.28.0 does too. No 3.12/3.13 fallback venv
   was needed, no source builds, no compiler.
2. **You do not need ffmpeg.** `faster-whisper` decodes audio through
   [PyAV](https://pypi.org/project/av/), which ships the FFmpeg libraries
   *inside its wheel*. `model.transcribe("episode.mp3")` reads the mp3 directly.
   Nothing was installed system-wide, no PATH was touched. If you later need
   ffmpeg for something else, download a static build into a scratch directory
   and call it by absolute path — do not install it globally.

### Setup, exactly

```powershell
# 1. contained venv (put it anywhere OUTSIDE the repo — never commit it)
python -m venv D:\scratch\foray-transcribe\venv
D:\scratch\foray-transcribe\venv\Scripts\python.exe -m pip install --upgrade pip

# 2. deps
D:\scratch\foray-transcribe\venv\Scripts\python.exe -m pip install -r tools\transcribe\requirements.txt

# 3. run — model weights download on first use to --download-root
D:\scratch\foray-transcribe\venv\Scripts\python.exe tools\transcribe\bench.py `
    D:\scratch\foray-transcribe\audio\episode.mp3 `
    --model small.en --device cpu --compute-type int8 `
    --download-root D:\scratch\foray-transcribe\models `
    --out D:\scratch\foray-transcribe\results\small.en.json
```

Bash/Linux equivalent:

```bash
python3 -m venv ~/scratch/foray-transcribe/venv
~/scratch/foray-transcribe/venv/bin/pip install -r tools/transcribe/requirements.txt
~/scratch/foray-transcribe/venv/bin/python tools/transcribe/bench.py \
    ~/scratch/foray-transcribe/audio/episode.mp3 \
    --model small.en --device cpu --compute-type int8 \
    --download-root ~/scratch/foray-transcribe/models
```

**Never commit** the venv, the model weights (`--download-root`), the downloaded
audio, or the transcripts. Keep all four outside the working tree; `tools/transcribe/.gitignore`
is a second line of defence if you put them here anyway.

### Fetching the audio

Episodes come from the original enclosure URL in `data/discover.json` —
`audio_url`, on an item with `dai_suspected: false`. Per product principle 3
("legally boring") we never rehost or transform episode audio; we fetch the
enclosure, transcribe locally, and keep the text. Use an honest User-Agent and
do not hammer a host:

```
ForayBot/0.1 (transcription spike; +https://github.com/JW-Incorporated/foray; wjduvall@gmail.com)
```

---

## 2. Measured throughput (CPU, int8, 16 threads)

Episode: **Radiolab — "Neither Confirm Nor Deny"**
(`radiolab--neither-confirm-nor-deny`, `dai_suspected: false`),
fetched from its enclosure URL. Real decoded duration **1989.4 s = 33.2 min**
(`data/discover.json` says 1745 s — 4 minutes short, which is why the harness
measures duration from the file itself rather than trusting feed metadata).

⚠️ **This episode is not typical of the pool.** Non-DAI episodes in
`data/discover.json` average **61 min** (median 55 min, n=403), so it is on the
short side. Scale any projection by the pool average, not by this run.

All runs: `beam_size=5`, `word_timestamps=True`, VAD **off** (so the timing
covers the whole audio, not a silence-trimmed subset — this is the honest,
pessimistic number). Wall clock is transcription only; model load is reported
separately because it is a one-off per batch, not per episode.

### Full-episode passes — these are the numbers to plan with

| model | machine state | model load | wall clock | realtime | eff. threads | segments | words | word times sane |
|---|---|---|---|---|---|---|---|---|
| **base.en** | **quiet** | 9.1 s | 1498.7 s (25.0 min) | **1.33x** | **2.36 / 16** | 693 | 5,376 | 5,376 / 5,376 |
| **small.en** | **quiet** | 23.9 s | 3722.2 s (62.0 min) | **0.53x** | **2.48 / 16** | 774 | 5,380 | 5,380 / 5,380 |
| base.en | ~12 agents sharing the CPU | 68.2 s | 708.9 s (11.8 min) | 2.81x ⚠️ | not recorded | 352 | 5,411 | 5,411 / 5,411 |
| small.en | ~12 agents sharing the CPU | 125.3 s | 4054.0 s (67.6 min) | 0.49x | not recorded | 1,041 | 5,278 | 5,278 / 5,278 |
| medium.en | — | — | **never completed a pass** | — | — | — | — | — |

**small.en barely noticed the contention: 0.49x busy vs 0.53x quiet.** That is
the most useful control in the table. If a loaded machine costs small.en ~8%,
then load cannot be what made base.en swing 2.81x → 1.33x, and the outlier is
something about that one run's decode path rather than the environment.

**Plan with 1.33x.** The 2.81x row is the anomaly, not the target, and the
honest position is that it is **unexplained**. It was measured on a *busier*
machine, which should have made it slower, so contention is not the story.
The one hard clue: the fast run emitted **352 segments** where the quiet run
emitted **693** for the same audio, same model, same flags — so the decoder took
a materially different path and did roughly half the decoding work. int8 GEMM
partitioned across a varying number of threads is not bit-identical, and beam
search amplifies small numeric differences into different segmentation. Treat
run-to-run throughput variance of **~2x on identical inputs** as a property of
this setup rather than something to tune away.

`effective_threads` is the more useful ceiling: **2.36 of 16 requested**. This
workload does not parallelise on this CPU, which is why more threads have not
helped and why a GPU (#118 / T7) is the only large win available.

### 300-second samples — do NOT plan with these

Kept only to show how badly short samples mislead. See "Three ways this
benchmark lies to you" below.

| model | sample kind | machine | realtime |
|---|---|---|---|
| base.en | clip of the full file (`--limit-seconds`) | quiet | 1.42x |
| base.en | genuinely trimmed file | quiet | 1.01x |
| base.en | clip of the full file | contended | 0.657x |
| small.en | clip of the full file | contended | 0.363x |
| medium.en | genuinely trimmed file | quiet | **0.15x** |
| medium.en | clip of the full file | contended | 0.205x |

medium.en is the one safe conclusion from this block: at 0.15x on a quiet
machine it is **~7x slower than base.en on identical audio**, so it is out of
reach on this CPU regardless of measurement method.

### Hours per batch, at the measured 1.33x

Scaled by the **61 min average** of non-DAI episodes in `data/discover.json`
(median 55 min, n=403) — not by the 33 min test episode.

| batch | audio | base.en @ 1.33x | small.en @ 0.53x |
|---|---|---|---|
| 1 episode | 61 min | 46 min | 1.9 h |
| 20 episodes (pilot) | 20.3 h | **15.3 h** (a weekend) | 38 h (5 nights) |
| 100 episodes | 101.7 h | **76.5 h** (3.2 days) | 192 h (8 days) |
| 300 episodes | 305 h | 229 h (9.5 days) | 576 h (24 days) |
| all 406 curated non-DAI | 409.6 h | **308 h** (12.8 days) | 773 h (32 days) |

The model choice is therefore a **2.5x time multiplier**, and T2 (#117) is what
decides whether small.en's accuracy is worth it. On this hardware the practical
answer is likely base.en by default, because 20 episodes in a weekend is a
usable pilot and 5 nights is not.

**Read this as a feasibility verdict, not a schedule.** A pilot of ~20 episodes
is realistic on this laptop. The curated non-DAI pool is not: 12.8 days of
continuous pinning, during which the machine cannot also be used for
development (measured — see hygiene note 3 below; the network began timing out
from CPU starvation while a run was in flight). Anything past a pilot wants
T7 (#118).

### Three ways this benchmark lies to you

All three were hit while producing the table above. They cost hours, so they are
written down rather than rediscovered.

**1. `--limit-seconds` is not a timing mode.** It passes `clip_timestamps` to
faster-whisper, which still pays whole-file costs — so a 300 s clip of a 33 min
episode measures *worse* than transcribing the whole episode. On the same file
and model the clip reported 1.42x against the full pass's figure in the table.
The flag is fine as a smoke test; it is invalid for throughput. **To time a
sample, trim it to its own file first.** `bench.py` now prints a warning.

**2. Never pipe `bench.py` through `grep`.** If the reader dies (a killed
wrapper script, a closed terminal), `bench.py` blocks forever on a full stdout
pipe at ~0% CPU while its wall-clock timer keeps running. One measurement was
lost this way: 2,434 s of "wall clock" containing ~500 s of actual work.
Redirect straight to a file.

**3. Anything else running on the box invalidates the number.** The same
base.en clip measured **0.657x** with a dozen agents sharing the CPU and
**1.42x** idle — a 2.2x swing from load alone. This machine cannot benchmark
itself while it is also being worked on. Treat any number taken during other
activity as a lower bound, and re-run it quiet before deciding anything.

That last point is why `effective_threads` is now reported: it is the fastest
way to tell whether a run had the machine to itself.

### Word-level timestamps

`word_timestamps=True` works and the output is sane. `bench.py` validates every
word against three conditions — `start <= end`, monotonically non-decreasing
across the file, and contained within its parent segment — and reports the
count that pass. See the table's last column.

---

## 3. CUDA path (for the GPU machine, #118 — NOT verified here)

Everything above is device-agnostic; only three things change.

**You do not install a different Python package.** The `ctranslate2` wheels on
PyPI for Windows and Linux x86_64 are built with CUDA support already. What you
must supply is the NVIDIA runtime libraries (CUDA 12 cuBLAS + cuDNN 9), which
are easiest to get as pip packages into the same venv:

```powershell
venv\Scripts\python.exe -m pip install -r tools\transcribe\requirements.txt
venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
```

(If you already have a system CUDA 12 toolkit + cuDNN 9 on the library path,
skip the second line. If CTranslate2 can't find `cudnn_ops64_9.dll` /
`libcudnn_ops.so.9`, that's the missing piece — not a bad install of
faster-whisper.)

Then run the **same script** with two flags changed:

```powershell
venv\Scripts\python.exe tools\transcribe\bench.py D:\scratch\audio\episode.mp3 `
    --model medium.en --device cuda --compute-type float16 `
    --download-root D:\scratch\models
```

Sanity check the GPU is visible before a long run:

```powershell
venv\Scripts\python.exe -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"
```

`0` means CTranslate2 cannot see a CUDA device — fix that before trusting any
`--device cuda` timing (it does **not** silently fall back to CPU; it raises).

**To make the numbers comparable**, run the GPU box on the *same episode*
(`radiolab--neither-confirm-nor-deny`) with the same defaults
(`beam_size=5`, `word_timestamps=True`, no VAD) and paste the harness's JSON
line into #116.

### `compute_type` on GPU

| compute_type | when |
|---|---|
| `float16` | the default recommendation on any RTX card; best quality/speed balance |
| `int8_float16` | if a model doesn't fit in VRAM at fp16 — roughly halves weight memory, small quality cost |
| `float32` | don't; ~2x the VRAM for no accuracy Whisper actually delivers |
| `int8` | CPU default. Works on GPU but is not the fast path there |

### VRAM per model size (rough guide)

Approximate **weight** footprint at `float16`, plus headroom for activations
and the beam search. Treat these as "what card can run this at all", not exact:

| model | fp16 weights | practical VRAM | verdict by card size |
|---|---|---|---|
| `base.en` | ~0.15 GB | ~1 GB | runs on anything |
| `small.en` | ~0.5 GB | ~2 GB | comfortable at **4 GB** |
| `medium.en` | ~1.5 GB | ~5 GB | tight at **6 GB**, comfortable at **8 GB** |
| `large-v3` | ~3.1 GB | ~10 GB | needs **8 GB minimum** (use `int8_float16` at 8 GB), comfortable at **12 GB+** |

Rule of thumb matching the guidance in #118: **4 GB → `small.en`;
6 GB → `medium.en`; 8 GB+ → `medium.en` comfortably, `large-v3` possible
(at 8 GB use `int8_float16`, at 12 GB+ use `float16`).**

Note there is **no `.en` variant of `large-v3`** — the large models are
multilingual only. For an English-only catalogue that is a small waste of
capacity, which is part of why `medium.en` is often the better pick than
`large-v3` for us even when the card can hold both.

---

## 4. Reproducing / extending

`bench.py --help` lists everything. Flags that matter:

| flag | why |
|---|---|
| `--model` | `base.en` / `small.en` / `medium.en` / `large-v3` |
| `--device` | `cpu` or `cuda` — the whole point of the harness |
| `--compute-type` | defaults to `int8` on cpu, `float16` on cuda |
| `--threads` | CPU threads; `0` = all of them (default) |
| `--no-word-timestamps` | to isolate the cost of word alignment |
| `--vad` | Silero VAD; skips silence, inflates the realtime multiple. Off by default so timings are honest |
| `--limit-seconds N` | smoke-test on the first N seconds. **Not a timing mode** — see "Three ways this benchmark lies to you" |
| `--out FILE` | dump the transcript JSON (keep it out of the repo) |

The last line of stdout is a single JSON object with every field needed for the
comparison table — pipe it straight into a results file.

---

## 5. `decode-compare.mjs` — ADR-0008's instrument of last resort

A second, much smaller thing lives in this directory and shares only its PyAV
dependency with the benchmark above: **download one episode, decode it, and
compare its true duration against the publisher transcript's last cue.**

```bash
node tools/transcribe/decode-compare.mjs --list
node tools/transcribe/decode-compare.mjs --episode art-bell --python D:\scratch\venv\Scripts\python.exe
node tools/transcribe/decode-compare.mjs --probe-grid          # 4 tiny requests per target, no audio
node tools/transcribe/decode-compare.mjs --recompare           # re-judge stored measurements, no download
node tools/transcribe/decode-compare.mjs --cleanup             # delete the audio
```

It needs only `av==18.0.0` from `requirements.txt`, not `faster-whisper`. The
decode itself is `decode-duration.py`; the verdict logic is in the `.mjs` and is
where the tests are. Results are committed to `data/decode-and-compare.json`.

### Why it exists

`ad-inflation.mjs` reads a file's length out of `Content-Range` on a 2-byte
ranged GET. That is the right screen, it costs kilobytes, and it is blind in
three places worth thousands of transcripts each — no declared length to divide
by, a constant byte offset that metadata and a pre-roll fit equally well, and a
declared length that is simply wrong. Decoding produces a length nobody has to
take on trust. The comparison is against the **transcript**, never the feed:
two of the three questions are questions about whether the feed's own numbers
are trustworthy, so answering them with the feed's numbers would be circular.

### The 2026-08-23 run

**Six full downloads, 330,150,567 bytes (314.9 MiB).** Five of them are the
target rows in `data/decode-and-compare.json`, which records
`downloads: {files: 5, bytes: 261265669}`. The sixth was a repeat of the DOAC
episode (68,884,898 bytes) run by hand to check the first was not a fluke, and
it left no artifact beyond this sentence — the probe grid below is what makes
that check unnecessary, so nothing rests on it. Also spent: a five-episode
re-probe of Art Bell (1 feed + 9 ranged GETs, recorded in
`breadth-anchorable-inflation.json`'s `source.passes`) and 20 probe-grid
requests. Zero 429s across every sweep. All audio deleted.

| target | decoded | feed says | transcript ends | verdict |
|---|---|---|---|---|
| The Diary Of A CEO (flightcast, 6 ad-tech hops) | **5740.38 s** | 5626 s | 5601.25 s | **excess-audio, +139.13 s** |
| …the same episode, prefixes stripped | **5740.38 s** | 5626 s | 5601.25 s | **excess-audio, +139.13 s** — byte-identical |
| The Secret To Success (flightcast, no prefix) | 2509.32 s | 2509 s | 2507.01 s | matches-transcript, +2.31 s |
| The Art Bell Archive | 8625.53 s | 8625 s | 8625.44 s | matches-transcript, **+0.09 s** |
| Around the House with Eric G | **2593.33 s** | 2280 s | 2279.20 s | **excess-audio, +314.13 s** |

### THE FINDING THAT MATTERS MOST — a ranged GET can lie too

ADR-0008 opens by recording that **HEAD requests lie** on ad-inserting hosts:
they return the ad-free master's `Content-Length` while a real GET delivers the
assembled file. The 2-byte ranged GET was adopted as the honest replacement.
**On `atelier.flightcast.com` it is lied to in exactly the same way.**

`--probe-grid` asks one URL how big it is four ways — ranged and unranged, under
the probe identity (`ForayBot/0.1`) and the client one (`Foray/0.1`). For the
DOAC episode:

| identity | request | reported length |
|---|---|---|
| probe | ranged | 67,510,022 |
| probe | unranged | 67,510,022 |
| client | ranged | 67,510,022 |
| **client** | **unranged** | **68,884,898** |

Three cells report the master. Only an **unranged request from a client
identity** is served the assembled file, and two independent full downloads
under that identity delivered exactly 68,884,898 bytes — 1,374,876 bytes,
**114.6 s** at the file's 96 kbps. (The decoded file separately runs 114.38 s
past the feed's declared duration; the two numbers are close because they
measure nearly the same thing, and they are not the same measurement.)

**This is a header-level finding, so every download-side explanation is excluded
by construction.** The two lengths differ in `Content-Length` before any body is
read: no `Content-Encoding`, no `Transfer-Encoding`, no resume, no append. And
the short number is not a compressed representation of the long one —
`67,510,022 × 8 ÷ 96,000 = 5,625.8 s` against a feed declaring **5,626 s**. It
is the ad-free master's length to a fraction of a second.

What it costs: `#321` probed all seven flightcast shows, 35 episodes, three
requests each, and got 105 byte-identical answers. It correctly refused to call
them clean and filed them `repeat_stable_no_denominator`. The decode shows the
refusal was righter than it knew — the repeats were stable because they were all
reading **a number the origin declares and does not deliver**. Byte-stability
across repeats measured the stability of the *declaration*, not of the file.
Every flightcast byte figure in this repo is a master length.

**It is not a platform verdict.** The bare-chain control (The Secret To Success,
same origin, no ad-tech prefix) returns one identical length in all four grid
cells and decoded to within 2.31 s of its transcript. Stripping DOAC's six
prefixes changed nothing — same bytes, same frames — so whatever the origin is
keying on, it is not a prefix rewriting a length. Two flightcast shows are now
measured and they disagree with each other.

**And the clean one did not recover, which is the counter-intuitive part worth
stating.** The Secret To Success has a probe-corroborated decode showing no
excess audio at all, and it is still `unresolved` (564 transcripts) — because
its host has been caught delivering more than it declares, so its five
ranged-GET samples are master lengths that cannot admit anything, and one clean
decode is below the two-sample floor `summariseShow` already applies to ratios.
**Six** flightcast shows are `unresolved`, 5,320 transcripts, and only more
downloads can move them.

### The other two answers

**Art Bell: the file served today is clean, and the original question is now
unanswerable.** The decode landed 0.09 s past a transcript that runs the full
declared duration, and a re-probe of all five sampled episodes through
`measure-suspects.mjs --reprobe` returned the declared length **exactly** on
every one (+0 bytes, five for five, committed with its pass record). All four
probe-grid cells agree. 1,368 transcripts move `drop` → `recover`.

Be precise about what that does **not** settle. The row was opened to decide
whether the recorded +99,345-byte constant gap was ID3 artwork or a house
pre-roll, and **that question can no longer be answered**: the enclosure now
307-redirects to an archive.org master whose ID3v2 tag is **2,048 bytes** — which
does not account for 99,345 and is evidence *against* the artwork hypothesis, not
for it — and the copy that carried those bytes is no longer served by anyone.
The 2026-08-23 row's `resolved_chain` shows `audio.artbell.am` answering
directly, with no archive.org hop. The recovery rests on today's file matching
today's transcript, which is what anchoring needs; it does not rest on an
explanation of the withdrawn one, and nothing here supplies that explanation.

Note also that the whole coverage gain below is this one show. Nothing about the
other 22 clean shows changed.

**Around the House was neither of the two hypotheses.** Its 0.758 ratio is the
product of two independent errors, and the file is not truncated — it is
**longer**. The declared `length` is `duration × exactly 192.03 kbps` on four of
five episodes, a computed placeholder in the #319 Enormocast `5242880` mould,
while the file is a real 128 kbps encode. `(2593.33 × 128) / (2280 × 192) =
0.7583`, the recorded median exactly. Underneath that junk the episode carries
**313 s more audio than the feed declares and 314 s more than its own transcript
describes** — 2.6× the ADR-0008 ceiling, which a sub-1.0 ratio had been hiding.
A ratio below the floor is not a smaller problem than one above it.

**This finding currently changes nothing anywhere**, and that is worth stating
rather than leaving to be discovered: `around-the-house-eric-g` is a curated
`data/catalog.json` show and appears in neither breadth measurement file, so the
`decodeOverride` path in `measure-suspects.mjs` never sees it. It is already
excluded from transcript selection by `dai: true` plus `verdict: unknown`, so
nothing is admitted wrongly — but the decode is a fact without a consumer. See
HUMAN-ACTIONS item 24.

### The rules in here, and which of them a measurement forced

1. **The container's duration is a CLAIM and never a reading.** For an MP3 it is
   the Xing/LAME header; where there is none, FFmpeg derives it from the byte
   count, which makes it circular for every question this tool asks. An early
   draft counted it as a third vote and flightcast's headers over-declare on
   clean and inserting files alike (+3.76 s and +8.41 s) — producing a false
   `undecidable` on a file that was in perfect order. It is reported as
   `header_claimed_sec` and gates nothing.
2. **A decode acquits only where the probe corroborated its bytes.** If the
   ranged GET and the wire disagree about the file's size in *either* direction,
   the decode measured a different object and cannot speak for the show's other
   episodes — it returns no verdict at all rather than a wrong one. On a host
   caught under-*declaring*, a show additionally needs `MIN_SAMPLES_FOR_AD_FREE`
   decoded-clean episodes, because there the byte evidence is worthless however
   clean it looks. A decode **condemns** on one observation, matching the
   asymmetry `varyingSamples` already runs on.
3. **The decode may not acquit at a delta the byte screen would condemn.**
   `TRAILING_ALLOWANCE_SEC` is 30 s and `INSERT_EVIDENCE_SEC` is 10 s, so the
   override applies the stricter of the two. An instrument that outranks another
   must not also be more permissive than it.
4. **`--recompare` exists because thresholds are wrong sometimes.** The decode's
   output is small and the download is the expensive half, so every constant is
   a pure function of numbers already committed. Re-downloading 250 MB to
   re-apply arithmetic is not politeness this repo spends.

### One thing that was built and deleted

The plan was for a single decode to calibrate a **bitrate residual screen** —
once the encode is known to be constant-bitrate, `bytes × 8 ÷ bitrate` turns
every already-collected byte count into a duration, which against
`itunes:duration` is the denominator the flightcast feeds never publish. It was
written and unit-tested. Then the first download falsified it: the screen
consumes exactly the byte counts that host reports, so it read −0.4 s to +3.3 s
across all 35 flightcast samples — including the five belonging to the episode
carrying 114.4 s of undeclared audio. It has been deleted rather than shipped
dark, because an exported, tested, unused helper is one a future reader wires up
on the strength of its tests. Nothing replaced it: five shows are `unresolved`
and only another download can move them.
