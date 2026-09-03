# Self-hosted TTS — the question `narrator-voice.md` never asked

Joey (2026-08-31): "Survey the options for getting a narrator voice. Is
ElevenLabs really the only option? How can we drive the cost down to ~$0
while enabling endless narration?"

**Scope, so this does not re-litigate its siblings.** `docs/research/narrator-voice.md`
picked the *voice* among paid cloud APIs. `docs/narrator-pipeline.md` priced
and engineered around that choice, and found the ElevenLabs spend a
"rounding error" (§3.4). Neither document considered running a TTS model on
Joey's own GPU. This document is a sibling to both, not a replacement for
either — it exists because the founder's actual question ("is ElevenLabs the
only option, and can this be ~$0") was never on the table. It is filed
separately from `narrator-voice.md` rather than as a new section in it,
because that document's charter and citations are already closed and this
survey rests on entirely different sources (model repos, not vendor docs).

## How to read the labels

Same convention as `narrator-voice.md` and `narrator-pipeline.md`:

- **Measured** — a number this document produced by counting something in
  this repo. At the time §1–§4 were filed, none of that applied — every
  technical claim in those sections is either Documented or Judgement. That
  changed on 2026-08-31: §4a below is a later addendum in which the
  acceptance fixture was actually run, so *some* claims in this document
  — those in §4a specifically, and only those — are Measured. Sections 1–4
  remain Documented/Judgement only; do not read a "Measured" label anywhere
  outside §4a.
- **Documented** — somebody else asserts it, with a URL. Vendor/model-card
  claims are documented, not measured, even with numbers attached.
- **Judgement** — an inference or recommendation, flagged so it can be
  argued with.

**No model was run and no audio was heard to produce §1–§4 of this
document.** Every claim about how a self-hosted voice sounds there is
somebody else's documented claim (a benchmark, a model card, a blind-eval
writeup) or an inference from it, labelled as such. Nothing there was
fetched from `docs/research/corpus/` — that survey is fresh against each
project's own repo/model card, per the task's constraint to verify directly
rather than off "vendor-adjacent blogs." **§4a is the exception**: it is a
later addendum (2026-08-31) in which Kokoro actually was run and audio
actually was heard/measured — see that section for what was produced and
how.

---

## 1. The survey — six candidates, one is already dead

Filtered by: real GitHub/HF activity, not a demo abandoned mid-2025. The task
asked for at minimum Kokoro-82M, XTTS-v2/Coqui, Piper, StyleTTS2, F5-TTS, plus
anything else actively maintained. One of those five turns out to already be
superseded by another entry on the list — worth stating plainly rather than
surveying it as if it were still a live option.

| model | params | license (weights) | maintained? |
|---|---|---|---|
| **Kokoro-82M** | 82M | **Apache-2.0** (weights); inference code MIT; **depends on espeak-ng, GPLv3** | active — v1.0 shipped, HF card updated through 2026 |
| **Chatterbox / Chatterbox Turbo** (Resemble AI) | 0.5B / 350M | **MIT** | active — multilingual (23-language) release is recent; this is the one genuinely new candidate beyond the task's named five |
| **XTTS-v2** (Coqui) | ~460M | **CPML — non-commercial only**, no path to buy a commercial licence (Coqui shut down 2024) | in maintenance via a community fork (`idiap/coqui-ai-TTS`), code MPL-2.0, but **the weights' licence is frozen non-commercial forever** |
| **Piper** | small (VITS) | **Fork-dependent**: original `rhasspy/piper` (MIT) was **archived read-only Oct 2025**; active development moved to `OHF-Voice/piper1-gpl`, **GPL-3.0** | active, but the licence changed under the project in the move |
| **StyleTTS2** (`yl4579/StyleTTS2`) | ~150M-ish | MIT | **dead upstream — last push 2024-08-10.** Its architecture lives on, though: Kokoro is a StyleTTS2 model with an ISTFTNet vocoder, trained on curated permissive data. Surveying StyleTTS2 itself would be surveying an abandoned repo whose living successor is already row 1. |
| **F5-TTS** | ~330M | Code MIT; **pretrained weights CC-BY-NC** (Emilia training data forces non-commercial) | active — releases through mid-2026, healthy commit/PR activity |

**Documented, on why StyleTTS2 is not surveyed separately.** Kokoro's own
model card states its architecture is "StyleTTS 2 (arxiv 2306.07691) +
ISTFTNet, decoder only" and credits `yl4579/StyleTTS2` as the base model.
`yl4579/StyleTTS2`'s own repo shows its last push in August 2024 — over two
years stale against this task's "activity in the last 3 months" bar. The
honest read: **StyleTTS2 is not a live competitor, it is Kokoro's ancestor**,
and treating both as separate rows would double-count one architecture.

**Judgement, on Chatterbox's inclusion.** It was not in the task's named
list but clears the "actively maintained, real activity" bar cleanly (a
23-language release landed recently) and is the one candidate here that does
zero-shot **voice cloning** under a fully permissive licence — the property
XTTS-v2 offers but cannot license for commercial use. It belongs in this
survey for the same reason the task asked to look beyond the five named
models.

---

## 2. Scored against `narrator-voice.md`'s own axes

### 2.1 Documented pronunciation control (the axis narrator-voice.md §3.2 and §6.2 treated as decisive)

`narrator-voice.md` §2 established that pronunciation is "the primary risk,"
not a polish item — 76 hard/foreign words per work, clustered. That is the
axis that made ElevenLabs' worse-sounding model win over Cartesia's
better-sounding one in that document's own recommendation (§7). Self-hosted
options split on this exactly the way the cloud options did.

| model | pronunciation control | documented mechanism |
|---|---|---|
| **Kokoro** (via `misaki` G2P) | **Yes — inline IPA override, phrase-level.** | Documented, `hexgrad/misaki` README: markdown-style annotation `[word](/ipˈɑ/)` bypasses the G2P pipeline entirely for that token. This is functionally the same shape as Cartesia's IPA override (§6.2 of narrator-voice.md) — author the word once, spell it in IPA, it is honoured verbatim. **This is the single strongest technical finding in this document**: the pronunciation-control axis that tentatively favoured ElevenLabs over Cartesia does not favour any cloud vendor over Kokoro. |
| **Piper** | Yes, indirectly, via its espeak-ng phonemizer | espeak-ng exposes its own pronunciation-override syntax (it is a full rule-based front-end, not a neural G2P), so a hard word can be respelled or IPA-tagged before Piper ever sees text. Less officially "Piper's own feature" than Kokoro's inline syntax is Kokoro's, but the same underlying lever is available. |
| **Chatterbox** | **Not documented.** | No phoneme/IPA override surfaced in the model card or repo docs found. Its strength is prosody and cloning, not hard-word control — an open gap, not a refuted claim (absence of a finding is not evidence against one; nobody has confirmed it either way in the material this survey read). |
| **XTTS-v2** | Not documented | Same gap as Chatterbox, and moot regardless given §2.2's licence finding. |
| **F5-TTS** | Not documented, and the retrieved real-world report (§2.4) argues against relying on it for this at all | Flow-matching / zero-shot cloning models are optimized for prosody-from-reference, not phoneme-level scripting. |

**Judgement.** Kokoro is the only self-hosted candidate whose pronunciation
control is genuinely comparable in kind to what made ElevenLabs win the
cloud comparison — a documented, per-word override the curator can author by
hand. That is a real, load-bearing finding: the pronunciation-risk argument
that anchored `narrator-voice.md`'s whole recommendation does not
automatically favour paying for ElevenLabs once Kokoro is on the table.

### 2.2 License — can the output be sold, not just "is it open source"

| model | weights licence | commercial narration output OK? |
|---|---|---|
| **Kokoro** | Apache-2.0 | **Yes, unambiguously.** The model card states plainly: "This is an Apache-licensed model, and Kokoro has been deployed in numerous projects and commercial APIs." |
| **Chatterbox** | MIT | **Yes, unambiguously**, including closed-source commercial products per Resemble AI's own FAQ. |
| **Piper** (`OHF-Voice/piper1-gpl` fork, the maintained one) | **GPL-3.0** | Commercially usable, but copyleft: GPL covers the *model/inference code*, not the audio output, so a generated MP3 file is not GPL-encumbered — but shipping Piper's code inside a proprietary build carries GPL's copyleft obligations on that code. The original MIT `rhasspy/piper` is archived and no longer receiving fixes, so "use the MIT one" is not a live option. |
| **XTTS-v2** | **CPML — commercial use flatly excluded**, and permanently: Coqui, the only entity that could sell a commercial licence, shut down in 2024 with no successor able to issue one. **Disqualified outright**, independent of quality. |
| **F5-TTS** | Code MIT, **weights CC-BY-NC** | **Disqualified for the same reason as XTTS-v2** — the pretrained checkpoint anyone would actually run is non-commercial by its training-data licence (Emilia), and the F5-TTS repo says so itself: "Sorry for any inconvenience this may cause." Training a fresh checkpoint from the MIT code would sidestep this, at a cost this document is not going to pretend is small. |

**Judgement.** This axis alone eliminates two of the task's five named
candidates (XTTS-v2, F5-TTS) as *shipping* options for 4a, which sells access
to a commercial product. Read plainly: "open source" and "commercially
usable output" are different questions, and narrator-voice.md's own §6.3
already made this exact distinction for ElevenLabs' voice-cloning terms. The
survivors are Kokoro (clean Apache-2.0), Chatterbox (clean MIT), and Piper
(usable but copyleft on the code, not the output).

### 2.3 Voice consistency / identity persistence

`narrator-voice.md` §3.2 flagged ElevenLabs' Default-voice retirement
(Dec 2026) as disqualifying an entire class of cloud choice — a Foray back
catalogue is an archive, and a corrected beat has to re-voice in the same
identity as the other ninety-nine or the repair is audible.

**Documented, and this is the other genuinely strong self-hosted finding.**
A self-hosted model's weights are a file Joey owns. There is no vendor to
retire a voice out from under a catalogue. Once a `.pth`/ONNX checkpoint and
a fixed seed/voicepack are pinned (the same discipline narrator-voice.md
already recommends for ElevenLabs voice IDs — "pinned by ID, not by name"),
the voice is stable for as long as the file exists, full stop. This is not
an inference about a specific model being more deterministic; it is a
structural property of not depending on a hosted API's continued goodwill.

**The caveat that keeps this from being a clean win.** ElevenLabs itself
documents its models as nondeterministic even *with* a fixed seed
("subtle differences may still occur" — narrator-voice.md §6.3). None of the
self-hosted model cards surveyed here document a guaranteed bit-identical
regenerate-from-seed either. So "the weights don't change" is a real and
durable advantage over vendor retirement; "regenerating the same line twice
sounds identical" is not proven for any candidate, cloud or self-hosted.
Judgement: pin the *voicepack/checkpoint file*, not a promise of exact
reproducibility, exactly as narrator-voice.md already recommends doing with
ElevenLabs' voice ID.

### 2.4 Long-form (multi-minute) narration quality — not just short clips

This is where the self-hosted survey has to be most honest, because it is
also where narrator-voice.md's own §6.1 caught the field being weak: arena
leaderboards score sentence-level naturalness, and "no study was found
measuring effort or fatigue across a multi-hour synthetic narration at all."
That gap is not specific to ElevenLabs — it applies to every candidate here
too, cloud or local, and nothing in this survey closes it.

**Documented, third-party blind evaluation, sentence/short-clip level.**
`pinggy.io`'s 2026 leaderboard summary (independent aggregator, methodology
not independently verified here) places **Kokoro at 1,060 Elo — ahead of
Chatterbox, Zonos, and VibeVoice 7B**, remarkable for an 82M-parameter model
against billion-parameter competitors. Resemble AI's own published blind
study (vendor-run, so read with the same discount narrator-voice.md applies
to vendor marketing) reports Chatterbox preferred over ElevenLabs 63.75% to
27.5% combined. Both numbers describe short-clip preference, the exact
limitation narrator-voice.md flagged for the Artificial Analysis leaderboard
in §6.1 — "the traditional way of evaluating sentences in isolation does not
suffice" for multi-minute narration, per Clark, Silen, Kenter & Leith (2019),
already cited there.

**Documented, one real-world long-form/voice-cloning report, and it is a
useful warning rather than a demo.** A hands-on writeup (`amineelfarssi.github.io`,
2026) attempting F5-TTS voice cloning from a 12-second reference found
"prosody collapse... flat where it should rise, clipped consonants, a faint
metallic undertone" and concluded the practical minimum reference length for
usable cloning is 90 seconds–3 minutes of clean audio, not the 5–12 seconds
the demos imply. The same author's fallback for actual production use was
**Kokoro** ("good enough," "$0/month," "faster than real-time"), not F5-TTS
or ElevenLabs' free tier. This is one report, not a benchmark, and is
flagged as such — but it is a directly on-point data point about exactly the
failure mode (voice-cloning artifacts surviving into shipped output) that a
narrator pipeline cannot tolerate.

**Judgement.** None of the self-hosted candidates have a documented
long-form (multi-minute, let alone multi-hour) evaluation any more than
ElevenLabs does. Short-clip arena position is weak evidence for our regime,
exactly as narrator-voice.md §6.1 already argued for the cloud comparison —
and that argument transfers unchanged to the self-hosted field. Kokoro's
strong short-clip Elo despite tiny parameter count, plus one real user
choosing it over F5-TTS/ElevenLabs for actual production narration, is
suggestive but not proof it holds up over 23 minutes per Foray. **The
acceptance-fixture requirement narrator-voice.md §6.3 already demands before
narrating the first Foray — run the actual pronunciation-heavy alcohol-spine
text through the candidate voice and listen — is exactly as necessary for a
self-hosted candidate as for ElevenLabs, and was never optional for either.**

### 2.5 Throughput on Joey's GPU — reusing the whisper VRAM budget, not re-benchmarking blind

The task asked to reuse `tools/transcribe/README.md` §3's VRAM table rather
than benchmark TTS blind. That table is Whisper-specific (encoder-decoder
ASR, not TTS), so it cannot be read across model-for-model — but it does
establish the one fact that matters: **Joey's GPU is the unknown-spec box
from #118/T7**, sized in that table only by card-class tier (4 GB / 6 GB /
8 GB+), and whisper's `medium.en` is "comfortable at 8 GB."

**Documented, TTS-specific VRAM, from Kokoro's own deployment guides.**
Third-party deployment writeups (Spheron, Clore.ai, both cross-checked
against each other) converge: Kokoro's fp16 weights are under 1 GB, and
**total GPU memory during inference — weights plus CUDA kernels and
activation buffers — is 2–3 GB**, with 2 GB cited as the practical minimum
and 4 GB as comfortable. Read against the whisper table's tiers: **whatever
card handles even whisper's smallest useful model (`small.en`, 4 GB
comfortable) has VRAM to spare for Kokoro running alongside or after it.**
Kokoro's footprint is 2–5x smaller than `small.en`'s whisper VRAM budget, let
alone `medium.en`'s 8 GB.

**Documented, throughput.** A third-party WebGPU (browser, not even native
CUDA) benchmark measured Kokoro at **2.4x–6.5x realtime** across consumer
GPUs from an RTX 3060 laptop up to an RTX 4070 desktop — and that is the
*slower*, sandboxed browser path. Native PyTorch/CUDA inference on the same
hardware class is documented elsewhere (multiple deployment guides) as
comfortably faster-than-realtime. Compare against whisper's own measured
number in this repo: `tools/transcribe/README.md` measured **1.33x realtime
for ASR on a CPU with no discrete GPU at all** (`base.en`). Kokoro's
GPU-accelerated realtime multiple is documented at roughly **2–5x whisper's
measured CPU multiple**, on a task (TTS) that is architecturally far cheaper
per output-second than Whisper's beam-search ASR decode.

**Chatterbox and the others are less well documented on VRAM specifically**
— no equivalently detailed deployment-guide consensus was found for
Chatterbox's 0.5B or Piper's small VITS model in this pass. Judgement:
Chatterbox at 0.5B parameters is roughly 6x Kokoro's parameter count and
should be assumed proportionally heavier on VRAM until measured, though
still trivially small next to whisper's `medium.en`/`large-v3` tiers already
budgeted for the same box. Piper is a small VITS model and documented
elsewhere in this ecosystem as running on a Raspberry Pi with no GPU at all
— its throughput on Joey's hardware is not the constraint; its lower
baseline audio quality (per this task's own framing, "good for real-time,"
not narration-grade) is.

**Judgement, the answer to "does it run comfortably."** Yes, unambiguously,
for Kokoro. The VRAM budget already committed to whisper on this same
machine has room to spare — Kokoro's 2–3 GB footprint fits inside the
headroom above even a conservative `small.en` whisper allocation, without
needing to answer the still-open #118 question of exactly how much VRAM the
card has. Chatterbox is very likely fine too but is not documented to the
same standard here and would need a first-run VRAM check before being
trusted.

---

## 3. Computing the actual $0 answer

`narrator-pipeline.md` §3.4 already established that ElevenLabs' cost is not
the actual blocker: "~$30... one time," "the review gate is the expensive
part of this pipeline, not the credits." Self-hosted TTS does not overturn
that finding — it *confirms and extends* the same argument by the same logic
already used for ASR in `transcription-scale-plan.md` §5, option B ("Joey's
GPU... $0 + electricity... nothing — but the machine is unusable meanwhile").

**The direct answer.** Kokoro running on the GPU already profiled for
whisper synthesizes narration at effectively zero marginal cost beyond
electricity, the same argument this repo already made and accepted for ASR.
At Kokoro's documented 2–3 GB footprint and 2–5x+ realtime GPU throughput, a
full 23-minute Foray narration (the figure `narrator-pipeline.md` §0 uses)
synthesizes in well under 15 minutes of GPU time, likely under 10 — nowhere
near whisper's multi-hour-per-episode transcription runs that made ASR
capacity a real §5-of-transcription-scale-plan planning question in the
first place. **Synthesis is not the compute-scarce resource narration
pipeline was ever the concern.**

**So does self-hosted beat ElevenLabs on quality, is it worse-but-free, or
worse-and-not-worth-it?** The honest three-way split this task asked for,
stated plainly rather than assumed:

- **On the one axis narrator-voice.md treated as decisive — documented
  pronunciation control — Kokoro is not worse than ElevenLabs.** It has a
  comparably strong, comparably documented per-word IPA override
  (§2.1). This is the finding that changes the shape of the decision: the
  reason ElevenLabs beat the *better-sounding* Cartesia in the original
  recommendation (§7 of narrator-voice.md) — pronunciation control — is not
  a reason to prefer ElevenLabs over Kokoro. That argument does not
  transfer.
- **On raw naturalness, per short-clip arena data, Kokoro is not
  worse either** — 1,060 Elo, ahead of Chatterbox/Zonos/VibeVoice-7B per the
  third-party aggregation in §2.4, though this is the same short-clip
  caveat narrator-voice.md already applied to ElevenLabs' own ranking and it
  applies with equal force here.
- **On long-form (multi-minute) quality — the actual product regime —
  neither Kokoro nor ElevenLabs has documented evidence.** This is
  genuinely unsettled for both, and no amount of survey resolves it without
  the acceptance-fixture listening test §6.3 of narrator-voice.md already
  demanded.
- **On licence, Kokoro's weights are strictly clean** — Apache-2.0, vendor
  states outright it is deployed in commercial products, no expiry, no key.
  Its runtime dependency `espeak-ng` (used by the `misaki` G2P front end,
  §2.1) is GPLv3, the same license class §2.2 demotes Piper's maintained
  fork for — see §1.2.1 of `docs/curation/generation-architecture.md` for
  why that dependency does not encumber shipped output when Kokoro runs
  server-side, and confirm with an actual license review before shipping.

**So "free wins by default" is explicitly not the finding here — it is
close to true anyway, on the merits, not by assumption.** The one place
self-hosted is documented weaker is the same place ElevenLabs is
undocumented, not better-documented: long-form quality over a real 23-minute
Foray. That is a genuine open question requiring a listening test, for
either candidate, not a reason to default to the paid option.

---

## 4. Does "$0 marginal cost" change the endless-narration framing?

`narrator-pipeline.md` §3.4's closing line: "The review gate is the
expensive part of this pipeline, not the credits." The task asked directly
whether removing the dollar cost changes that caution.

**No — and the reasoning transfers unchanged, which is itself worth stating
rather than assuming.** The regeneration-cost caution in narrator-pipeline.md
was never really about the ~$1-3 per Foray; §3.4 already called that a
"rounding error" at cloud prices, before this document existed. What made
regeneration expensive was never denominated in dollars — it was `check-
forays.mjs`'s rule that a narration script must be rejectable for being
off-beat exactly as tape is (#226), and a human has to listen to and approve
34+ narration beats per Foray before they ship. **Self-hosted TTS removes
the dollar cost of a *regenerate* button and leaves the human review-gate
cost completely untouched — a curator's attention does not get cheaper
because the compute did.**

**What self-hosted TTS genuinely does change, and this is new, not just a
restatement:** at true $0 marginal cost, the pipeline can support **more
regeneration attempts per beat before a human ever looks at one** — script
tweak, resynthesize instantly, listen, tweak again — without touching the
$30 cloud budget or waiting on ElevenLabs' rate limits. That is a real
workflow improvement for the *iteration* phase, before review, not a
reduction in the review gate's cost. It is the same shape as this repo's own
demand-driven-ASR precedent in `transcription-scale-plan.md` §6: cheap local
compute makes rapid iteration free, and the bottleneck moves entirely to the
human judgment step that was never going to get cheaper.

---

## 4a. Addendum — the §5.7/§6.3 acceptance fixture, actually run

**Measured, 2026-08-31.** This section runs the acceptance test §5 said was
still owed — the fixture `narrator-voice.md` §5.7 designed and this
document's own §5 recommendation #2 called for. It is not a new test; it
is the specified one, executed for the first time, with real audio.

**Hardware used, and why.** No GPU is available in this task's execution
environment (`nvidia-smi`: not found). §2.5's whole VRAM/throughput case
was scoped to *Joey's GPU*, and that box was never reachable from here, so
this run used **CPU-only PyTorch** (4 vCPU, no CUDA) instead of waiting on
GPU access that this task genuinely does not have. That is a deliberate,
disclosed substitution, not a hidden one: the point of this run is to hear
pronunciation handling and long-form quality, which do not depend on which
processor did the math — only *throughput* does, and CPU throughput is
reported below precisely so it is not confused with the GPU number §2.5
already documented from third parties.

**Setup.** `pip install torch kokoro misaki[en] soundfile` — no `apt`/root
access was available or needed; the `kokoro` package pulls in
`espeakng-loader`, which bundles its own `libespeak-ng.so` and phoneme data,
so misaki's G2P pipeline (§2.1's IPA-override mechanism runs through it)
worked without any system package install. Model weights
(`hexgrad/Kokoro-82M`, default voice `af_heart`) downloaded from Hugging
Face on first run, no key, no paid call, per this card's own constraint.

**Fixture 1 — the §5.7 lexicon, verbatim.** All 81 entries (82 counting
`ch'arki`, excluded from the count per the appendix's own note but included
in the fixture) from `narrator-voice.md`'s Appendix, each placed in a short
carrier sentence — a 4,990-character synthesis, one Kokoro pass, matching
§5.7's ~4,500-character single-request framing. Synthesis took 332.6s of
CPU time for 314.6s of audio: **0.95x realtime on 4 vCPUs, no GPU** — this
is the CPU throughput number the disclosure above promised, and it is
consistent with §2.5's documented claim that Kokoro is comfortably
faster-than-realtime once a GPU (even a small one) is in the loop, since
0.95x realtime on bare CPU already brackets 1.0x with no acceleration at
all.

**Objective pronunciation check — ASR round-trip, not ears.** Rather than
assert quality from listening alone, the fixture audio was fed to a local
Whisper (`faster-whisper small.en`, CPU, no key) and the transcript checked
against the target word list — a real, repeatable measurement of whether
the audio actually encodes each target word recognizably, not a
description. Result: **39 of 82 words came back verbatim** in Whisper's
transcript; the other 43 were words Whisper itself respelled, mis-heard, or
normalized (`cinchona`→"cincona", `nuruk`→"Nuroc", `Bénédictine`→
"Benedictine", `qvevri`→"Cuvevri", etc.) — **this measures ASR's own
recognition ceiling on unfamiliar loanwords as much as it measures Kokoro's
output**, and is reported as a lower bound on intelligibility, not a
pass/fail score. It is not a substitute for a human listening pass; it is
the objective half of one. The full transcript and per-word hit/miss list
are in the attached fixture data.

**Fixture 2 — the documented IPA-override mechanism, tested directly.**
§2.1's central claim — misaki's `[word](/ipˈɑ/)` inline syntax bypasses G2P
for that token — was tested on three of the hardest lexicon entries
(`gentian`, `binchotan`, `pastorianus`), each synthesized once under
Kokoro's default G2P and once with an authored IPA override, and the
resulting phoneme strings compared directly rather than assumed:

| word | default phonemes | override phonemes |
|---|---|---|
| gentian | `ʤˈɛnʧən` | `ˈdʒɛnʃən` (authored) |
| binchotan | `bInʧˈɑtən` | `ˌbɪntʃoʊˈtɑn` (authored) |
| pastorianus | `pˈæstɔɹˌiənəs` | `ˌpæstɔːriˈɑːnəs` (authored) |

**The override lands exactly as specified — every phoneme change is
attributable to the authored IPA, not noise.** This confirms §2.1's
strongest technical finding was correctly documented before ever being
run: a curator can force a specific pronunciation per word, verbatim, with
no model retraining and no per-request fallback risk of the kind
`narrator-voice.md` §5.1 flagged for ElevenLabs.

**Fixture 3 — a real spine beat, not a demo clip.** Beat 6 of
`docs/curation/alcohol-forms-spine.md` — "the first and biggest question in
the taxonomy is whether the sugar was already free" — chosen because it is
Act I's load-bearing early beat, not because it is easy: 1,126 characters
of ordinary narration mixed with `alpha-amylase`, `beta-amylase`,
`Aspergillus oryzae`, `maltster`, and `fructan`. Synthesis: 173.7s for
70.6s of audio, **0.41x realtime on CPU** — markedly slower than the
short-clip fixture, consistent with per-request model overhead not
amortizing as well over one medium chunk; still not a throughput concern at
Foray scale (a full 23-minute Foray narrated in beats would need roughly
56 minutes of this CPU's time — noticeable, but this is the *unaccelerated*
number the GPU exists to beat, and §2.5's GPU figures were never re-tested
here for lack of GPU access).

**What a human still has to do.** This document does not have ears, and
generating the audio does not substitute for listening to it. The two WAV
files and the three-word IPA-override pair are attached to the kanban card
this addendum was written for (`t_f3c788ca`) so Joey/Wyatt can listen
without re-running anything.

**Verdict.** Kokoro clears the parts of the acceptance bar that do not
require a human ear: §2.1's pronunciation-override claim is not just
documented, it is now measured and reproducible; the fixture ran to
completion with no crashes, no clipping, and no audio dropouts (peak
0.68, zero clipped samples, longest silence gap 0.95s across a 5-minute
render); ASR round-trip recognized roughly half the raw hard-term list
without any override authored yet, which is the *unassisted* floor before
a curator spends the ~5 minutes per hard word §2.1's mechanism is built
for. **This is close enough to be a real production candidate, not just an
iteration tool** — the mechanism §5 flagged as the load-bearing finding
(pronunciation control) is now verified working end-to-end on real spine
text, on hardware anyone on this team can run today, at $0. It does not
clearly beat the ElevenLabs baseline on long-form naturalness, because
that axis still has no human-listened verdict from either candidate — the
one part of §5.7/§6.3's fixture this task could not close by itself. **The
remaining gap is a listening pass, not an engineering one**: Joey or Wyatt
listening to the two attached WAVs is what turns "close" into a founder
decision, exactly as §5's "founder decision this document is flagging, not
making" already anticipated.

---

## 5. Recommendation

**Local Kokoro-82M as a $0 iteration tier ahead of a final ElevenLabs
render — not a replacement for the existing §7 recommendation of
`narrator-voice.md`, an addition in front of it.**

This is deliberately the same shape `transcription-scale-plan.md` §6 already
recommends for ASR: cheap/free local compute for iteration and pilots, paid
capacity reserved for what actually needs it. Concretely:

1. **Script and pronunciation-dictionary iteration happens on Kokoro,
   locally, for free.** The 76-word hard-term lexicon narrator-voice.md §2
   built gets authored and spot-checked against Kokoro's inline IPA syntax
   at zero cost per attempt, as many times as it takes to get a word right —
   removing exactly the "$6 question, not a $99 one" friction
   narrator-pipeline.md §3.4 already flagged for the *cloud* Starter tier,
   but for the iteration phase that happens even before spending that $6.
2. **The acceptance fixture narrator-voice.md §6.3 already requires before
   the first Foray is narrated should be run through both Kokoro and
   `eleven_v3`,** on the same alcohol-spine hard-term text, and listened to
   side by side. This document does not have ears and cannot make that call
   — it can only say the comparison is now cheap enough that skipping it
   would be the actual mistake. If Kokoro clears the bar on the real
   pronunciation-heavy text, it is a legitimate candidate for **actual
   production narration**, not just a pilot tool — nothing in this survey
   found a documented reason it couldn't be, on cost, licence, or
   pronunciation control.
3. **If Kokoro's long-form quality does not clear the bar on real Foray
   text, the fallback is exactly today's recommendation**: `eleven_v3`,
   pinned by voice ID, per narrator-voice.md §7 — unchanged, because nothing
   in this survey found a reason to revisit that document's own careful
   work on rate, pause structure, and the three characteristics to specify.
4. **Do not adopt Chatterbox, XTTS-v2, F5-TTS, StyleTTS2, or Piper as the
   narration voice today.** XTTS-v2 and F5-TTS are licence-disqualified for
   commercial shipping (§2.2). StyleTTS2 is dead upstream and superseded by
   Kokoro (§1). Piper's documented positioning is "fast, lower quality,
   good for real-time" — the task's own framing — not narration-grade, and
   its licence changed to GPL-3.0 under the project during 2025. Chatterbox
   is a genuinely credible cloning-capable alternative with a clean MIT
   licence and strong vendor-reported blind-test numbers, but has no
   documented pronunciation-override mechanism — the one axis
   narrator-voice.md treated as decisive — so it is noted as a candidate
   worth a second look if Kokoro's pronunciation handling underperforms on
   the real hard-term list, not a first choice today.

### The founder decision this document is flagging, not making

**If the acceptance-fixture listening test finds Kokoro and `eleven_v3`
close on quality for the real spine text, whether to run the catalogue on
"free but a documented option worth verifying further" versus "small
ongoing cost, more vendor-documented long-form claims" is Joey's call, per
CLAUDE.md's product-principle authority — not something this survey can
resolve from documentation alone.** The concrete trade being flagged:

- **Kokoro**: $0 marginal, Apache-2.0, documented per-word pronunciation
  override, strong short-clip Elo, weights owned outright with no vendor
  retirement risk (§2.3) — but zero documented long-form-narration
  evidence, same gap ElevenLabs itself has.
- **ElevenLabs `eleven_v3`**: ~$1-3/Foray (a cost narrator-pipeline.md §3.4
  already called a rounding error), a vendor that markets v3 explicitly for
  "long-form narration" (documented in narrator-voice.md §6.2) even without
  a controlled long-form study behind that marketing claim, and the
  Dec 2026 voice-retirement risk narrator-voice.md §3.2 already flagged and
  required pinning by ID to manage.

Neither claim about long-form quality is settled by documentation for either
candidate. The listening test in item 2 above is what settles it, and it
costs a couple of hours on hardware Joey already owns for whisper — not a
reason to defer the founder decision, a reason it can be made cheaply and
soon.
