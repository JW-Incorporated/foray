# Third-party notices

Software and data distributed inside the 4a app (`mobile/`), and the licence
each one is distributed under.

**Why this file exists.** Apache-2.0 §4(d) requires that a distributed work
carry the notices of the Apache-licensed material it includes. Until the
bundled-voice deck, everything in the app was either first-party or a platform
framework, so there was nothing to reproduce. `docs/bundled-voice-plan.md`
changed that for a while: the on-device voice probe put somebody else's weights
and somebody else's inference runtime inside our binary.

**Scope.** This file covers what is DISTRIBUTED, not what is used to build.
Build-time tooling (Capacitor's CLI, Node, Gradle, Xcode) is not listed; a
library or a data file that ends up inside the `.ipa` or the `.aab` is.

**Status since CH-20 (founder ruling on issue #1076, 2026-10-05, "Remove it
all").** Neither app distributes any of the third-party material below. No
Kokoro weights, voice data or Core ML stages are bundled into the `.ipa` or the
`.aab`, ONNX Runtime is linked by neither shell, and the vendored Core ML
inference code was deleted with the probe. The entries are kept as history,
because central narration renders the Forays' spoken parts on a server with the
same pinned Kokoro weights (`tools/mobile/fetch-models.mjs`, read by
`render-narration.yml`), and so that a revived on-device probe starts from
notices that were already written. If anything below is ever bundled again,
its entry goes back to the present tense in the same diff.

**The pin table is the machine-readable source.** Every pin in
`tools/mobile/fetch-models.mjs` carries a `licence` and an https `source`, and
`test/release-gates.test.js` fails the build if a pin records a licence that is
not Apache-2.0 or MIT, the deck's §11 non-goal ("any voice whose licence is
not Apache/MIT") as a check rather than a sentence. The same suite holds every
pin's bundle list empty.

---

## Kokoro-82M — the narration voice model

- **What:** an 82-million-parameter neural text-to-speech model.
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
- **Status:** not distributed in either app since CH-20. Central narration
  renders with the ONNX fp32 export on a server. History: the probe builds
  bundled the ONNX `q8f16` quantization on Android (~86 MB) and the ONNX fp32
  export on iOS (~326 MB, deck D13), and the iOS probe v3 build also carried the
  Core ML conversion below.

## Kokoro voice data

- **What:** twelve per-voice style matrices (~510 KB each), distributed from
  the same repository as the ONNX weights.
- **Licence:** Apache-2.0
- **Source:** https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- **Notice:** as for the model above.
- **Not a person's voice:** the deck's §11 non-goals forbid cloning any real
  person. These are the publisher's own preset voices.
- **Status:** not distributed in either app since CH-20; pinned in
  `tools/mobile/fetch-models.mjs` for central narration's server-side renders.
  History: the probe builds bundled the voices the founders selected.

## ONNX Runtime — the inference engine

- **What:** Microsoft's ONNX inference runtime, mobile builds
  (`onnxruntime-swift-package-manager` on iOS,
  `com.microsoft.onnxruntime:onnxruntime-android` on Android). ~10–20 MB.
- **Licence:** MIT
- **Source:** https://github.com/microsoft/onnxruntime
- **Notice:** Copyright (c) Microsoft Corporation. Licensed under the MIT
  License.
- **Status:** not linked by either app since CH-20; the dependency left
  `mobile/plugins/foray-tts/Package.swift` and
  `mobile/plugins/foray-tts/android/build.gradle`, and both files now say so.
  History: from 2026-09-12 it was linked, pinned at 1.20.0 on both platforms,
  and its only caller was K-01's measurement engine (`KokoroOrtProbeEngine`,
  Swift and Java, both deleted by CH-20), constructed on demand when a founder
  tapped the probe button and never reached from the narration path.

## Kokoro-82M as seven Core ML models (iOS probe build, retired)

- **What:** the same Kokoro-82M weights converted to seven compiled Core ML
  models (`KokoroAlbert`, `KokoroPostAlbert`, `KokoroAlignment`,
  `KokoroProsody_v2`, `KokoroNoise_v2`, `KokoroVocoder`, `KokoroTail_v2`;
  34 files, ~78.5 MiB) so most of the model runs on the Apple Neural Engine.
- **Licence:** Apache-2.0 (the weights are Kokoro's; the conversion is
  laishere/kokoro-coreml's, Apache-2.0; the repository's own LICENSE file is
  the Apache-2.0 text. Its model card also says MIT; both are permissive).
- **Source:** https://huggingface.co/FluidInference/kokoro-82m-coreml
  (folder `ANE/`), converted by https://github.com/laishere/kokoro-coreml
- **Notice:** Kokoro-82M, copyright the Kokoro authors; Core ML conversion,
  Copyright 2026 laishere; repackaging, FluidInference. Licensed under the
  Apache License, Version 2.0.
- **Status:** not distributed in either app, and no longer pinned. History:
  the iOS probe v3 build (card KV-R3) bundled them, pinned file by file by
  sha256 at a fixed commit of the repository above; the pins and the bundle
  list are gone.

## laishere/kokoro-coreml and FluidAudio — the Core ML inference chain (retired)

- **What:** Swift code that ran the seven Core ML stages in order
  (`KokoroCoreMLEngine.swift` in the ForayTts iOS plugin, deleted by CH-20),
  adapted from laishere/kokoro-coreml's iOS demo (`KokoroEngine.swift`,
  `MLHelpers.swift`, commit 484907db) and following FluidInference/FluidAudio's
  productized copy (`Sources/FluidAudio/TTS/KokoroAne/Pipeline/`, commit
  20d4f0bd) for its stage-boundary conversions and input-buffer slack. It was
  vendored, not a package dependency.
- **Licence:** Apache-2.0 (both).
- **Source:** https://github.com/laishere/kokoro-coreml ·
  https://github.com/FluidInference/FluidAudio
- **Notice:** Copyright 2026 laishere; Copyright FluidInference. Licensed
  under the Apache License, Version 2.0. Both licence texts, and the NOTICE
  that listed what was changed, are kept in `docs/legal/licenses/`.
- **Status:** not distributed in either app since CH-20. History: it was
  constructed on demand when a founder tapped the voice probe (iOS 17 and
  later), and never reached from the narration path, exactly like the ONNX
  Runtime engine above.

## What is deliberately NOT here

- **`espeak-ng` (GPL-3).** Every off-the-shelf Kokoro runtime reaches for it as
  a text front-end, and it is the reason this deck computes phonemes on the
  server and ships ids to the phone (`docs/bundled-voice-plan.md` §4;
  `docs/curation/generation-architecture.md` §1.2.1 had already confined it to
  the server for the fallback path). `test/release-gates.test.js` asserts no
  native build input in this repository names it.
- **Platform speech engines.** `AVSpeechSynthesizer` and Android's
  `TextToSpeech` are OS frameworks, not distributed code.
