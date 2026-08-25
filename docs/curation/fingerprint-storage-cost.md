# What an acoustic fingerprint costs to keep, per episode

**Status:** measurement, 2026-08-24. Written to price **one option** ahead of the
dedicated-GPU transcription run: while an episode's audio is on that box's disk
for a few minutes, do we also emit a Chromaprint fingerprint and keep it?

This does **not** design or implement the fingerprint route.
`docs/adr/0008-ad-tolerance-and-timestamp-precision.md` §4 still marks it "not
designed", and nothing here changes that. The only question answered is
**storage cost**, because that is the part of the decision with a one-way door in
it: the audio is deleted minutes after transcription, and re-downloading
thousands of episodes later costs another month — against episodes whose ad load
may have rotated in the meantime.

---

## 1. The answer

Per **episode-hour**, all measured (§3, §4):

| what you keep | bytes / episode-hour | × gzipped transcript |
|---|---:|---:|
| Chromaprint full res, packed `uint32`, gzipped | 111,066 | 3.92× |
| **Chromaprint full res, fpcalc base64, gzipped** | **88,421** | **3.12×** |
| Chromaprint decimated to 1 Hz, 32-bit, gzipped | 14,339 | 0.51× |
| Chromaprint decimated to 1 Hz, top 16 bits, gzipped | 7,149 | 0.25× |
| Chromaprint decimated to 0.5 Hz, top 16 bits, gzipped | 3,623 | 0.13× |
| **normalized transcript JSON, gzipped** | **28,332** | 1.00× |
| normalized transcript JSON, raw | 129,154 | 4.56× |
| *(the mp3 itself, for scale)* | *41,490,773* | *1,464×* |

**A full-resolution fingerprint costs about three gzipped transcripts. A coarse
one costs a quarter of one.** Both are rounding error against the audio: the
full-res fingerprint is **0.28 %** of the mp3 it was computed from.

---

## 2. Method, and what is measured vs estimated

Everything in §3 and §4 is **measured** on real files on 2026-08-24. §5 is the
only extrapolation and is labelled as such, in the style of
`data/breadth-transcript-yield.json`.

**Audio.** Six real episodes, 31–121 min, three publishers (Libsyn, Transistor,
Buzzsprout), fetched with `node tools/transcribe/fetch-audio.mjs --ids …` so
every request went through `tools/segments/politeness.mjs` — its host gate, its
`UA`, its `ACCEPT_LANGUAGE`. No new fetcher was written and no User-Agent was
spelled out anywhere. All six files were deleted after measurement
(`--cleanup`); nothing was archived.

**Fingerprint.** `fpcalc` 1.5.1 (Chromaprint), the official
`chromaprint-fpcalc-1.5.1-windows-x86_64` build, run as an external binary from
a scratch directory. **No npm dependency was added and none is needed.**
Invocation, both forms, per file:

```
fpcalc -length 36000 -raw <file>     # comma-separated int32 hashes
fpcalc -length 36000      <file>     # Chromaprint's own codec, base64
```

`-length` matters: fpcalc's default is **120 s**, so a bare `fpcalc file.mp3`
silently fingerprints the first two minutes. `-length 36000` covers a 10 h
episode. Confirmed processed-to-end by the hash count (§3): the emitted rate is
8.07 Hz at every duration, so a truncated run would show up immediately as a
short count.

**The stored forms measured.**

- *full res, packed `uint32`* — the raw hash array, little-endian, 4 bytes each.
- *full res, fpcalc base64* — Chromaprint's own delta+Huffman codec, the form
  AcoustID exchanges. This is the sensible "full resolution" storage form; it
  beats gzip-on-raw because it understands the data.
- *decimated* — every 8th hash (≈1 Hz) or every 16th (≈0.5 Hz), optionally
  keeping only the top 16 bits of each hash. Derived from the measured full-res
  array in post; the byte counts are measured, the **retrieval behaviour of a
  decimated fingerprint is not** (see §7).

gzip is level 9 on each artifact individually, which is how they would be
stored — no cross-episode shared dictionary.

**Transcripts.** `data-local/transcripts/normalized/*.json`, the repo's canonical
stored transcript shape. Measured two ways: (a) the five episodes above that
carry a transcript, (b) the whole local corpus, 1,618 transcripts over 856.7
episode-hours, as the broader base.

**Episode matching.** Four of the six audio files were matched to a transcript by
show slug plus duration agreement within 6 s, requiring the match to be unique
within the show; a fifth matched at 2 s. `tuned-in-hpa--167` has no transcript in
the corpus and contributes to the fingerprint rows only — it is there to test
whether the fingerprint rate holds at 2 h. It does.

---

## 3. MEASURED — fingerprint, six real episodes

| episode | dur | mp3 bytes | hashes | rate | full raw | full b64 | b64 gz | 1 Hz/32 gz | 1 Hz/16 gz | 0.5 Hz/16 gz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `cider-chat--how-cider-is-made-lessons-from` | 31.5 m | 15,919,985 | 15,248 | 8.0677 Hz | 60,992 | 61,818 | 45,814 | 7,464 | 3,766 | 1,929 |
| `practical-ai--surviving-the-new-economics-of-a` | 35.6 m | 34,217,114 | 17,228 | 8.0693 Hz | 68,912 | 71,495 | 53,186 | 8,508 | 4,243 | 2,160 |
| `being-an-engineer--rittenhouse-engineering-school` | 49.8 m | 35,894,220 | 24,120 | 8.0723 Hz | 96,480 | 99,575 | 73,932 | 11,905 | 5,963 | 3,024 |
| `being-an-engineer--s7e33-sam-thomason-the-black-magic` | 60.6 m | 43,693,919 | 29,370 | 8.0731 Hz | 117,480 | 120,034 | 88,855 | 14,488 | 7,183 | 3,638 |
| `cider-chat--497-beginner-cider-makers-q-a` | 62.8 m | 32,647,737 | 30,394 | 8.0728 Hz | 121,576 | 123,712 | 91,619 | 15,034 | 7,476 | 3,761 |
| `tuned-in-hpa--167-from-turbo-hondas-to-holley` | 121.2 m | 87,348,547 | 58,741 | 8.0744 Hz | 234,964 | 243,444 | 179,806 | 29,132 | 14,403 | 7,241 |

Normalised to bytes per episode-hour, mean over the six, with the observed
spread:

| form | mean B/h | min | max | spread |
|---|---:|---:|---:|---:|
| full res, packed `uint32` | 116,231 | 116,175 | 116,271 | **0.08 %** |
| full res, `uint32`, gzipped | 111,066 | 109,103 | 112,234 | 2.8 % |
| full res, fpcalc base64 | 119,302 | 117,749 | 120,554 | 2.4 % |
| full res, fpcalc base64, gzipped | 88,421 | 87,265 | 89,681 | 2.7 % |
| 1 Hz, 32-bit, gzipped | 14,339 | 14,217 | 14,416 | 1.4 % |
| 1 Hz, 16-bit, gzipped | 7,149 | 7,108 | 7,184 | 1.1 % |
| 0.5 Hz, 16-bit, gzipped | 3,623 | 3,583 | 3,674 | 2.5 % |

**Fingerprint size is a clock, not a property of the content.** Chromaprint emits
one 32-bit hash every ~0.1239 s regardless of what is in the audio, so the raw
size varies by 0.08 % across a 3.85× duration range — the residual is rounding on
the final frame. This is why six episodes is enough: there is nothing left to
sample. Only the *compressed* forms vary at all, and only by ~3 %.

**gzip is nearly useless on the raw array (4.4 %) and worth 26 % on the base64.**
Chroma hashes are close to incompressible byte-wise; Chromaprint's own codec is
the only thing that meaningfully shrinks them. Anyone storing these should store
the base64 and gzip that, not gzip the raw array.

---

## 4. MEASURED — transcript, same episodes and the whole corpus

| episode | dur | cues | JSON raw | JSON gz | raw B/h | gz B/h |
|---|---:|---:|---:|---:|---:|---:|
| `cider-chat--how-cider-is-made-lessons-from` | 31.5 m | 457 | 73,281 | 15,857 | 139,583 | 30,204 |
| `practical-ai--surviving-the-new-economics-of-a` | 35.6 m | 63 | 38,596 | 12,791 | 65,080 | 21,568 |
| `being-an-engineer--rittenhouse-engineering-school` | 49.8 m | 140 | 60,143 | 18,222 | 72,461 | 21,954 |
| `being-an-engineer--s7e33-sam-thomason-the-black-magic` | 60.6 m | 164 | 79,172 | 23,931 | 78,345 | 23,681 |
| `cider-chat--497-beginner-cider-makers-q-a` | 62.8 m | 1,285 | 199,377 | 39,927 | 190,639 | 38,177 |

Five-episode mean: **109,222 B/h raw, 27,117 B/h gzipped.**

Whole local corpus — 1,618 normalized transcripts, 856.7 episode-hours, every
show in `data-local/transcripts/normalized/`, transcripts under 5 min excluded:

- raw: **129,154 B/h**
- gzipped: **28,332 B/h**
- gzip ratio: **4.56×**

The five-episode figure and the 1,618-transcript figure agree to within 4.3 %,
which is the corroboration that matters. **§1 uses the corpus number** because it
has the larger `n`.

**Transcript size, unlike fingerprint size, is not a clock.** The measured spread
is 2.9× between the sparsest (`practical-ai`, 63 paragraph-level cues in 36 min)
and the densest (`cider-chat`, 1,285 cues in 63 min). That is a cue-granularity
difference, not a speech-rate difference, and it is the dominant term.

**This matters for the decision, in the direction that favours the fingerprint.**
The transcripts measured here are *publisher* transcripts. Self-transcribed
episodes — the ones this GPU box produces, and the only ones the fingerprint
route serves at all per ADR-0008 §4 — come out of ASR at segment granularity,
roughly 500–700 cues/hour, i.e. the **dense** end of the range measured above,
and larger still if word-level timestamps are kept. If every self-transcribed
episode looks like `cider-chat--497` (38,177 B/h gz, the worst case measured),
the full-res fingerprint ratio improves from 3.12× to 2.32×.

---

## 5. ESTIMATED — extrapolation to 9,000 episodes

**This section is arithmetic, not measurement.** Only the per-hour rates above
are measured.

Duration basis: **59.0 min = 0.983 h** mean, over the 1,691 episodes in
`data/discover.json` that declare a duration (median 53.6 min). Chosen over the
transcript corpus's 31.8 min mean, which skews short because the corpus
over-represents short-format shows.

```
episode-hours = 0.983 h/episode × 9,000 episodes = 8,847 episode-hours
```

| what you keep | B/h (measured) | × 8,847 h | total |
|---|---:|---:|---:|
| full res, `uint32`, gzipped | 111,066 | | **0.98 GB** |
| **full res, base64, gzipped** | **88,421** | 88,421 × 8,847 = 782,260,587 | **0.78 GB** |
| 1 Hz, 32-bit, gzipped | 14,339 | 14,339 × 8,847 = 126,857,133 | **0.13 GB** |
| 1 Hz, 16-bit, gzipped | 7,149 | 7,149 × 8,847 = 63,247,203 | **0.063 GB** |
| 0.5 Hz, 16-bit, gzipped | 3,623 | 3,623 × 8,847 = 32,052,681 | **0.032 GB** |
| **transcripts, gzipped** | **28,332** | 28,332 × 8,847 = 250,653,204 | **0.25 GB** |
| transcripts, raw | 129,154 | | 1.14 GB |
| *(re-downloading the audio)* | *41,490,773* | | *367 GB* |

If the self-transcribed corpus lands at the dense end (§4), transcripts rise to
38,177 × 8,847 ≈ **0.34 GB** and full-res fingerprints stay at **0.78 GB**.

---

## 6. Recommendation

**Keep the full-resolution fingerprint**, stored as Chromaprint's own base64,
gzipped. Emit it from the same disk-resident window the transcription already
owns, before `cleanup(episodeId)` runs.

The reasoning is entirely about asymmetry, not about the bytes:

**Cost of being wrong by keeping it: 0.78 GB.** That is three times the
transcript corpus and one fifth of one percent of the audio it came from. If the
fingerprint route is never designed, or is designed and rejected, 0.78 GB is
deleted with one command and nothing else was spent — the audio was already on
disk and already decoded. `fpcalc` on a 60 min episode is seconds of CPU against
minutes of GPU ASR; it is noise in the run's wall time.

**Cost of being wrong by discarding it: another month of downloads, on a corpus
that has moved.** ADR-0008 §4 is explicit that fingerprinting requires reference
audio *at the boundary*, and this run is the only time we hold that audio.
Re-acquiring it means 367 GB back through publishers' origins under the
politeness gate — and DAI hosts do not serve the same file twice, so some
fraction of the re-downloaded episodes will have a different ad load than the one
the transcript's timestamps describe. That fraction cannot be recovered at any
price.

**Do not keep coarse-only.** Coarse is cheap (0.032–0.13 GB) but it is the one
choice that carries the downside of both others: it spends storage *and* leaves
the one-way door half-shut. Nothing here measured whether a 1 Hz or 16-bit
fingerprint still aligns reliably against a shifted copy — decimation throws away
7 of every 8 frames and, in the 16-bit variants, half of every hash. If it turns
out coarse is insufficient, the audio is gone and the 0.13 GB bought nothing.
Full resolution can always be decimated later; coarse cannot be undecimated. The
0.65 GB difference is not worth foreclosing that.

**This does not commit us to the route.** It commits us to 0.78 GB and a
`fpcalc` call in the pipeline. Whether fingerprint alignment is designed, and how
it anchors, remains ADR-0008 §4's open question and is not decided here.

---

## 7. What is not measured here, and should not be read as measured

- **Whether a Chromaprint fingerprint actually recovers a shifted segment
  offset.** Not tested. This doc prices the option; it does not show the option
  works. ADR-0008 §4's "not designed" stands.
- **Retrieval quality at coarse resolution.** The decimated byte counts in §3 are
  measured; the claim in §6 that coarse *may* be insufficient is an argument from
  information discarded, not a measurement of alignment failure.
- **ASR transcript size.** §4 measures publisher transcripts. The 500–700
  cues/hour figure for ASR output is an expectation about Whisper-family
  segment granularity, not something measured in this repo.
- **Compute cost of `fpcalc` in the pipeline.** Not timed. Asserted as small
  relative to GPU ASR, which is a judgement.
- **Six episodes is enough for the fingerprint and thin for the transcript.** The
  fingerprint claim is safe because the rate is a fixed clock (0.08 % spread over
  3.85× duration). The transcript claim leans on the 1,618-transcript corpus, not
  on the five.

---

## 8. `fpcalc` as a dependency on the transcription box

**It is a realistic dependency on either OS**, and it is not an npm package.

- **Linux.** `apt install libchromaprint-tools` (Debian/Ubuntu),
  `dnf install chromaprint-tools` (Fedora), or the upstream static tarball from
  `github.com/acoustid/chromaprint/releases`. The upstream `fpcalc` build is
  statically linked against FFmpeg and needs no system FFmpeg.
- **Windows.** Verified working on this machine, 2026-08-24. Downloaded
  `chromaprint-fpcalc-1.5.1-windows-x86_64.zip` from the upstream release page,
  unzipped one file, ran it. Self-reported build:

  ```
  fpcalc version 1.5.1 (FFmpeg Lavc58.134.100 Lavf58.76.100 SwR3.9.100)
  ```

  A single 3.4 MB `fpcalc.exe` with **no install step and no separate FFmpeg** —
  the decoder is bundled. It decoded publisher mp3s from three different hosts
  without configuration.

So the box needs one binary on `PATH`, whichever OS it turns out to run. That is
about as light as an external dependency gets, and it is the reason §6 treats the
"keep it" side as cheap.

**One trap worth writing down for whoever wires this up:** `fpcalc`'s default
`-length` is **120 seconds**. A pipeline that shells out to a bare
`fpcalc episode.mp3` will emit a perfectly valid, perfectly useless fingerprint
of the first two minutes — including, on a DAI episode, a fingerprint of nothing
but the pre-roll ad. Pass an explicit `-length` larger than any episode, and
assert the returned hash count against `DURATION × 8.07` before storing.
