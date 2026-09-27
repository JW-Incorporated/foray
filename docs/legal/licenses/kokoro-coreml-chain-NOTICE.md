# Third-party code vendored into the ForayTts iOS plugin

mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroCoreMLEngine.swift
contains code adapted from:

1. laishere/kokoro-coreml (https://github.com/laishere/kokoro-coreml),
   commit 484907db6a8347a6afb6e7b86850ea2878c6a3fb,
   files iOSDemo/iOSDemo/KokoroEngine.swift and iOSDemo/iOSDemo/MLHelpers.swift.
   Copyright 2026 laishere. Licensed under the Apache License, Version 2.0;
   the full text is in laishere-kokoro-coreml-LICENSE beside this file.

2. FluidInference/FluidAudio (https://github.com/FluidInference/FluidAudio),
   commit 20d4f0bd46d11d7f50a6eb4f7835cfdbd2b4ba14,
   Sources/FluidAudio/TTS/KokoroAne/Pipeline/ (the stage boundary
   conversions, the non-finite-duration guard and the zeroed input slack).
   Copyright FluidInference. Licensed under the Apache License, Version 2.0;
   the full text is in FluidAudio-LICENSE beside this file.

Modifications (Apache-2.0 section 4(b)): the chain takes 4a's own token ids
and af_heart style row (chosen as the ONNX Runtime engine chooses it),
assigns each stage's compute units from a probe pass, reports failures as
closed tokens with the failing stage, and records per-stage timings. Neither
upstream ships a NOTICE file.

The compiled model files the engine loads are not in this repository; they are
fetched at build time by tools/mobile/fetch-models.mjs (pinned by sha256) and
listed in docs/legal/third-party-notices.md.
