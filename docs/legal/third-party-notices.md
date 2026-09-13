# Third-party notices

Software and data distributed inside the 4a app (`mobile/`), and the licence
each one is distributed under.

**Why this file exists.** Apache-2.0 §4(d) requires that a distributed work
carry the notices of the Apache-licensed material it includes. Until this deck,
everything in the app was either first-party or a platform framework, so there
was nothing to reproduce. `docs/bundled-voice-plan.md` changes that: the
bundled narration voice is somebody else's weights and somebody else's
inference runtime, shipped inside our binary.

**Scope.** This file covers what is DISTRIBUTED, not what is used to build.
Build-time tooling (Capacitor's CLI, Node, Gradle, Xcode) is not listed; a
library or a data file that ends up inside the `.ipa` or the `.aab` is.

**The entries below are authoritative for a build that has run
`tools/mobile/fetch-models.mjs`.** That script's `PINS` table is the machine-
readable source: every pin carries a `licence` and an https `source`, and
`test/release-gates.test.js` fails the build if a pin records a licence that is
not Apache-2.0 or MIT — the deck's §11 non-goal ("any voice whose licence is
not Apache/MIT") as a check rather than a sentence.

---

## Kokoro-82M — the narration voice model

- **What:** an 82-million-parameter neural text-to-speech model. The weights
  shipped are the ONNX `q8f16` quantization, ~86 MB.
- **Licence:** Apache-2.0
- **Source:** https://huggingface.co/hexgrad/Kokoro-82M
- **ONNX conversion used:** https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- **Notice:** Copyright the Kokoro authors. Licensed under the Apache License,
  Version 2.0. A copy of the licence is available at
  http://www.apache.org/licenses/LICENSE-2.0.
- **Training data, as a claim rather than a verified fact:** the model card
  states the model was trained on permissively-licensed and synthetic audio.
  Nobody in this repository has independently verified that, and it is recorded
  here as the publisher's claim so that any downstream legal document cites it
  as one.

## Kokoro voice data

- **What:** twelve per-voice style matrices (~130 KB each), of which the three
  the founders select are bundled. Distributed from the same repository as the
  ONNX weights.
- **Licence:** Apache-2.0
- **Source:** https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- **Notice:** as for the model above.
- **Not a person's voice:** the deck's §11 non-goals forbid cloning any real
  person. These are the publisher's own preset voices.

## ONNX Runtime — the inference engine

- **What:** Microsoft's ONNX inference runtime, mobile builds
  (`onnxruntime-swift-package-manager` on iOS,
  `com.microsoft.onnxruntime:onnxruntime-android` on Android). ~10–20 MB.
- **Licence:** MIT
- **Source:** https://github.com/microsoft/onnxruntime
- **Notice:** Copyright (c) Microsoft Corporation. Licensed under the MIT
  License.
- **Status in this build:** LINKED, from 2026-09-12, pinned at **1.20.0** on
  both platforms (`mobile/plugins/foray-tts/Package.swift`,
  `mobile/plugins/foray-tts/android/build.gradle`). The only code that calls it
  is K-01's measurement engine
  (`KokoroOrtProbeEngine.swift` / `KokoroOrtProbeEngine.java`), which is
  constructed on demand when a founder taps the probe button and is never
  reached from the narration path. Exact pins rather than ranges: the number
  this card exists to produce is a timing, and a measurement whose runtime
  version is not in the diff is not a measurement.

## What is deliberately NOT here

- **`espeak-ng` (GPL-3).** Every off-the-shelf Kokoro runtime reaches for it as
  a text front-end, and it is the reason this deck computes phonemes on the
  server and ships ids to the phone (`docs/bundled-voice-plan.md` §4;
  `docs/curation/generation-architecture.md` §1.2.1 had already confined it to
  the server for the fallback path). `test/release-gates.test.js` asserts no
  native build input in this repository names it.
- **Platform speech engines.** `AVSpeechSynthesizer` and Android's
  `TextToSpeech` are OS frameworks, not distributed code.
