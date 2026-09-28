# Bundled neural voice (Kokoro): hand-off deck, revision 3 (two American voices, operational first; reviewed)

> **SUPERSEDED 2026-09-28 by central render (the Spark direction).** The founder ruled
> *"Defaults"* on D1–D11 of `docs/plans/spark-central-narration-assessment.md` (PR #860; `docs/DECISIONS.md` 2026-09-28). Narration is now
> rendered once by Kokoro off the phone (the PC, then the DGX Spark), stored in the public R2 bucket
> `foray-narration` at `audio.jwlabs.ai`, and streamed like a clip. This reverses the 2026-09-26
> *"Don't render entire Forays"* in §0. **Do not start a card from this deck without checking the map
> below.**
>
> **Still applies:** Heart (`af_heart`, default) and Echo (`am_echo`) are the voices, now rendered
> for every line (D4). The phone's speech engine (`foray-tts`) stays as the **fallback** for a line
> whose file fails to load, so the plugin and its pronunciation lexicon stay. §10's measurements
> stay as the record of why the phone path was abandoned. Rendering stays fp32 (never q8f16/fp16 on
> ARM).
>
> **Card map (assessment §4):**
> - **Parked:** KV-R2, KV-R3 (probe v3), KV-03a, KV-03b, KV-04, KV-05, KV-08, KV-09, KV-14.
> - **Replaced:** KV-07 by the render step (Phase 1) and, for on-demand, a pipeline render stage;
>   KV-13 by the model-removal step (D11, after the founder's car listen of rendered narration).
> - **Retargeted:** KV-01 (the voice catalog and Echo's pin become render-side data in the render
>   profile); KV-06 and KV-12 (the picker lists rendered voices; the Apple voice is an invisible
>   fallback). KV-12's planned "HUMAN-ACTIONS #119" is not filed under that number (#119 went to the
>   Spark items); its "listen in Heart, then Echo" check is re-filed against rendered narration when
>   Echo reaches the picker.
> - **Shrinks:** KV-02 keeps only the chunk rule, the `phonemize.py --json -` stdin fix and lexicon
>   QA. No `phonemes` go into `data/forays.json`.
> - **Done by this record:** KV-10 (the host decision is the Spark).
> - **Becomes render work:** KV-11 (British voices) is two extra renders, no app build.

**Where this lives:** revision 3 is this file, `docs/kokoro-voices-in-app-plan.md` (landed as KV-00). Revision 2 stays at `docs/roadmap/kokoro-voice.md`, marked superseded, and that file now carries the KV-11 British-voices roadmap entry.

**Supersedes** revision 2 of this file (24 cards KV-01..KV-24, stamped `ecb6bfa3`). No revision-2 card has an open or merged PR (`gh pr list --search KV-` is empty), so ids are reused from KV-00. New ids in this revision: KV-R0/KV-R1 (readings), KV-03a/KV-03b (KV-03 split), KV-12 (allowlist retirement), KV-13 (probe retirement). The amendment below adds KV-R2 (it replaces KV-R1) and KV-14 (Android model delivery, LATER). The supersession map is in §7 and the review-fix map in §9. Parent deck: `docs/bundled-voice-plan.md` (K-01..K-08). Native engine: `docs/native-engine-plan.md` (NE-33 built on `engine/m2` in #837 but not merged; NE-42 seat).

Written 2026-09-26 against `origin/main` @ `a37b3184` (#843), `origin/engine/m2` @ `3ef53186` (#842), and open PR #844 (`feat/local-voice-audition`). The facts the review added (#686 / `b669a043`, the `NATIVE_BUILD_INPUTS` list, U+0303 in the vocab, the seed-slice sizes) were checked by the reviewer and not re-run while this revision was written. The standing instruction covers them.

**Amended 2026-09-26 (rev 3.1), after this revision was written.** KV-R0 is done and could not measure (every line threw). An ARM64 sweep then showed that the q8f16 model we ship produces NaN samples on Apple silicon, and that the x86 PC runs the same lines fine, so PC sweeps do not stand for the phone. **iOS moves to the fp32 model; Android stays on q8f16 for now; KV-R2 (probe v2 on the phone) replaces KV-R1.** The measured facts, with their sources, are in §10. The body below is corrected wherever it assumed q8f16 on iOS or relied on KV-R1.

**Standing instruction (kept from rev 2):** before editing, run `git fetch origin && git -c core.autocrlf=false show origin/main:<file> | grep -n <symbol>` for every symbol a card cites. Re-anchor by symbol name. If a symbol is gone, stop and report.

## 0. The brief, verbatim

Wyatt, 2026-09-26:

> "I like 2 american and 2 british. is it possible to put all 4 in the app as selectable options, with one set to default? Heart, Echo, Isabella, and Lewis, with Heart as default. Don't render entire Forays, I'd rather try getting the voices working in the app, see if they can narrate text at a live pace, then have them read a Foray, as we'd do in the end state."

Then, the same day:

> "let's put british on the roadmap and stick with just american for the time being, I'd rather get this operational and upgrade it later instead of spinning our wheels too much."

**Scope.** Two voices: `af_heart` ("Heart", the default) and `am_echo` ("Echo"). `bf_isabella`, `bm_lewis` and the en-GB phoneme path are one later card, KV-11, which is not built now. Adding a voice later has to be a data change (a catalog entry with an accent tag, plus a pin), not a code change. The order of proof, in the founder's words:

1. The voices work in the app.
2. They narrate at a live pace (measured on his phone).
3. They read a Foray, the way the end state works.

**Measure first.** The one real risk is phone speed. On the PC the model ran 3.4–6.4× slower than real time. The no-new-code phone reading (KV-R0) ran on 2026-09-26 and could not measure (§10). The phone reading now comes from **KV-R2** (probe v2: fp32 on iOS, CPU and CoreML passes), and it still comes before the Swift work commits to a lead-buffer design, a thread count, a provider or a model.

The founder's "Don't render entire Forays" retires PR #844's "next step 2" (pre-rendered finalist audio behind a Developer switch). Nothing in this deck pre-renders audio off the phone.

## 1. What is true today (verified)

- **The model is pinned and bundled; Echo is not.** `tools/mobile/fetch-models.mjs` `PINS` has the q8f16 model (86,033,585 B, `bundle: true`, one boolean for both platforms) and twelve slate voices. **That q8f16 pin stays for Android only:** KV-R2 pins the fp32 `model.onnx` for iOS and makes `bundle` per platform (D13, §10). Only `af_heart` is bundled (`bundle: id === PROBE_VOICE`). `am_echo` has **no pin**. #844's local audition recorded its sha256 on first download (`data-local/voice-audition/voices/manifest.json`, `pinned: false`): `3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3`, 522,240 B. KV-01 re-hashes it independently from the URL, and the two observations must agree.
- **Phonemes: 0 of 157** narration items in `data/forays.json` carry `phonemes`, so K-02 is PARTIAL. `phonemize.py --json -` cannot read stdin (rev 2's latent defect: `Path("-").read_text`). The phonemizer does run on the founder's PC: #844 used `data-local/voice-audition/.venv` (Python 3.12, misaki 0.9.4, espeak-ng 1.52.0 via `espeakng_loader`) to phonemize four real lines with 0 failures.
- **The graph.** It has three inputs:
  - `input_ids`: int64 `[1,N]`, padded with `pad_id` 0 at both ends, N ≤ 512.
  - `style`: the row picked by the **unpadded** count, `padded − 2`, from a 510×256 float matrix.
  - `speed`.

  Output is 24 kHz float. `render-audition.py`'s `style_row_index(padded_len) = max(0, padded_len − 2)` agrees with both probe engines. The vocab is `tools/narration/kokoro-vocab.json`: 115 single-code-point keys, `" "` included and no newline, stamped `tts.vocab = "sha256:498414659c1db01e"`. **Some keys are combining marks and modifier letters (U+0303 COMBINING TILDE among them).** So "a character" in this deck always means a Unicode scalar (code point), never a Swift `Character` (grapheme cluster). All lengths and limits count code points, as Python's `len(str)` does.
- **Speed is the risk.** On the founder's x86 PC (ORT 1.20.1, CPU) the pinned q8f16 graph ran **3.4–6.4× slower than real time**.
  - About 84% of that time is `ConvInteger` (int8 dynamic-quantized conv), and 4 threads beat ORT's default.
  - The first phone reading (HA #45, build 2026091316) had real load and memory figures (`load 467ms/388ms peak 290.9MB`) but a faulty RTF and `locked=n`.
  - The RTF fault is fixed on main: `b669a043`, "the probe cannot report a zero real-time factor as a pass" (#686; rev 2 wrongly cited #685).
  - **The second phone reading (KV-R0, build 2026092602, 2026-09-26 23:44 UTC) could not measure:** `synthesis-failed/inference-threw` on every line, with real load and memory figures (`load 457ms/374ms peak 280.3MB`). Why it threw is not in the paste (§10).
  - **On ARM64 the q8f16 model produces NaN samples** (on CPU and on the CoreML EP), while the x86 PC renders the same passage fine. Only the fp32 export is finite and near real time on ARM (§10). ARM kernels differ from x86, so only the phone number counts, and the PC numbers above rank nothing for the phone.
- **The iOS runtime.** `KokoroOrtProbeEngine.swift` is a working ORT engine (three tensors in, one out). It counts samples and drops them, and it is CPU-only (`acceleratorWired: false`, K-08). ORT is pinned `exact: "1.20.0"` in `mobile/plugins/foray-tts/Package.swift`. Android has the mirror, `KokoroOrtProbeEngine.java`, with `onnxruntime-android:1.20.0`.
- **The engine lane (M2, built and unmerged).** `engine/m2`'s `SpeechNarrator.swift` has a `SpeechOutput` protocol.
  - Its `PcmOutput` plays `AVAudioPCMBuffer`s from `AVSpeechSynthesizer.write(_:toBufferCallback:)` on an `AVAudioPlayerNode`, and never touches the session.
  - `EngineCore` builds `.narration(.speak(seq, text: item.node["script"], voiceId, utteranceRate))`, so the item's JSON node is available to read `phonemes` from.
  - NE-42's "reuse NE-33's PCM path if it was built" applies: it was built.
- **The legacy lane (main).** `player/queue-manager.js` `_speakNarration` → `tts-bridge` → `foray-tts.js` `speak(script)` → native AVSpeech.
  - `_onTtsFinished` (the L-03 `finished` contract) exists.
  - `narrationDeadlineSec(item, rate)` exists as a **module-level pure function**.
  - On main, Forays play in this lane on every platform (M1 native mode is episodes only).
  - In native mode, `client.js` sends previews through the engine (`auditionThroughEngine` → `PreviewSpeaker`) so that foray-tts never claims the session while the engine is attached.
- **The picker.** `app.js` `VOICE_ALLOWLIST` lists 13 Apple names: the Samantha stopgap plus a trial set.
  - It has greyed "Not downloaded — Settings → Accessibility → Spoken Content…" rows.
  - Its Preview counts to ten (`AUDITION_LINE`, the founder's 2026-09-10 cut).
  - The choice persists in `cp_voice` through `ForayPlayer.setNarrationVoice` → `applyVoice` → `manager.setVoice` (and the engine's `setVoice` in native mode) → `AVSpeechSynthesisVoice(identifier:)`.
  - An unknown identifier falls back silently.
  - Samantha is the default (`player/default-voice.js`, 2026-09-10 ruling).
- **Gates this deck must not trip:**
  - `test/release-gates.test.js` greps a **fixed `NATIVE_BUILD_INPUTS` list** for the three GPL front-end needles (`espeak`, `piper-phonemize`, `phonemizer`), comments included. The list has five files: foray-tts `Package.swift`, `package.json` and `build.gradle`; foray-audio `build.gradle`; and the root `package.json`. No Swift or Java source is scanned today. KV-01 and KV-03a widen it.
  - The 150 MB ceiling: the universal APK measured 131.1 MiB (137,468,845 B, `APK_WITH_MODEL_BYTES`) with one voice and q8f16. Echo adds 0.5 MiB. The fp16 model (+~77 MB) would take it to about 208 MiB, so **fp16 cannot be bundled** (and it goes NaN on ARM anyway, §10). **Android keeps q8f16, so these numbers still hold for Android.** **iOS does not fit it:** with the fp32 model (325.5 MB) the iOS app projects to roughly 8.3 + 310 + 0.5 + ~11 ≈ 330 MiB, over the 150 MB ceiling and Apple's 200 MB cellular cap. That is accepted for **TestFlight only** (D13). KV-R2 splits the size gate per platform and records the real iOS figure; a public store launch is out of scope here and reopens it.
  - `prepare-webdir` budgets, including the capped Foray seed slice (44 KB). Both published Forays, `capital-types-1` and `how-ai-actually-gets-built-3b83e1`, are in the seed. The second one is 25.7 KB of JSON, with 18,005 B of narration script across 39 items. Its IPA would add about 25 KB, which busts the cap (planned for in KV-02).
- **DENIED paths this deck touches** (`tools/ci/path-policy.mjs`): `tools/mobile/fetch-models.mjs`, `tools/mobile/inject-models.mjs`, `test/release-gates.test.js`, any `mobile/**/Package.swift`, any `mobile/**/*.gradle`, `.github/`, `backend/src/`, `docs/DECISIONS.md`, `tools/mobile/prepare-webdir.mjs`.
  - PRs that touch them carry `needs-founder`.
  - **Agents never self-apply `founder-approved`.**
  - The overlord session verifies the diff on the DENIED path and applies the label under the founder's standing approval.

## 2. Decided (agents proceed; KV-10 records each one in DECISIONS)

- **D1. Voices.** Two voices: `af_heart` (the default, "Heart", American · female) and `am_echo` ("Echo", American · male). British voices are KV-11 on the roadmap. This retires `bundled-voice-plan.md` §6's "three voices from a ranked audition" and rev 2's H2 ranking cards (KV-17/18/19). The founder chose by ear on 2026-09-26.
- **D2. Phonemes travel; ids are made on the phone.**
  - Each narration item carries `phonemes` and `tts: {engine: "kokoro", model: "1.0", vocab: "sha256:498414659c1db01e"}`. The phonemes are en-US IPA from misaki plus the lexicon, with an espeak-ng fallback **on the PC/server only**.
  - The phone maps each **code point** to an id with a **generated** 115-entry table. That table is the ONNX export's own tokenizer, not a grapheme-to-phoneme front end, so no GPL code, dictionary or G2P reaches the phone.
  - Why not ship ids: a JSON int array is roughly 2–4× the bytes of the IPA string, and the seed slice is capped.
  - KV-01 corrects the comment in `fetch-models.mjs` that says "a table in the bundle would be the first step back towards a front end".
- **D3. Chunks are authored, not computed on the phone.** `phonemes` holds sentence chunks joined by `"\n"`. Newline is not in the vocab, so it can never be a phoneme.
  - **The rule** has one implementation, in Python (`phonemize.py` `sentence_chunks`), and lengths count code points:
    - Split after `.`, `!`, `?` or `;` followed by whitespace.
    - A sentence under 24 phonemes merges into the next.
    - A sentence over 460 phonemes splits at its last space before 460.
    - There is no other merging, which keeps time-to-first-audio low.
  - **This differs from #844's `split_phonemes`**, which greedily merged sentences up to 460. The style row depends on chunk length, so KV-02 makes the rule **unconditional**:
    - `render-audition.py` imports `sentence_chunks`, and `split_phonemes` is deleted.
    - Heart and Echo are re-rendered on the PC with this rule as the reference audio.
  - The phone only splits on `"\n"`, so there is no Swift, Java or JS chunker to keep in parity.
  - Chunks are joined with **80 ms** of silence (`render-audition.py`'s `CHUNK_GAP_SEC`). The style row is `min(padded − 2, 509)`. Speed is 1.0.
- **D4. One Swift synthesizer.** `mobile/plugins/foray-tts/kokoro-synth/` is a local SwiftPM package with two products:
  - `KokoroSynthCore` (Foundation only, host-testable): the catalog, vocab, chunk split, style row, live-pace meter and lead policy.
  - `KokoroSynth`: the ORT runtime, the renderer, and `PcmLinePlayer` over a `PcmSink` seam.

  Both lanes link the **same package and the same process-wide singleton**, so one ORT session holds the model (fp32, 325.5 MB, on iOS per D13):
  - foray-tts (legacy lane) depends on it by `path: "kokoro-synth"`.
  - foray-audio (engine lane) depends on it by `path: "../foray-tts/kokoro-synth"`.

  This is the nested-path-dependency pattern `foray-engine-core` already proved in ios-build run 35952197034. The package follows three rules:
  - The renderer emits PCM with the exact contract of `AVSpeechSynthesizer.write(_:toBufferCallback:)`: buffers, then one empty buffer.
  - The package **never touches `AVAudioSession`**; the host lane owns the session.
  - Every `Package.swift` that names onnxruntime pins `exact: "1.20.0"`. After KV-13 deletes the probe, only `kokoro-synth` names it.
- **D5. The catalog is data.** A new committed file, `mobile/plugins/foray-tts/kokoro-voices.json`, holds:
  - the voices, each with `accent` and `gender`;
  - the default voice;
  - an `accents` map from accent to the item field that carries its phonemes (`{"en-US": {"field": "phonemes"}}`);
  - the pre-phonemized Preview line and the pre-phonemized live-pace sample;
  - the model file name **per platform** (D13: fp32 on iOS, q8f16 on Android);
  - runtime knobs: speed, intra-op threads (**4**, the PC's measured winner, which does not stand for the phone; KV-R2's CPU pass and KV-05's Developer override check it there), the provider (from KV-R2's winning pass), chunk gap, `max_foray_rtf`, and the lead policy.

  `inject-models.mjs` copies the file beside the weights on both platforms, and both platforms read it. **Adding a voice later means one catalog entry plus one pin.** A test fails if a bundled voice's accent has no authored phoneme field, which stops a British voice from quietly reading en-US phonemes. **A catalog change is a data diff, but it is bundled, so it still ships as a new build** and needs another founder run to take effect.
- **D6. What `cp_voice` stores.** It holds `kokoro:<id>` for 4a's voices. Any other value is a system-voice identifier, as today.
  - When 4a's voices are available and `cp_voice` is unset or not a known `kokoro:` id, narration uses the catalog default (Heart). A stored Apple id is ignored in that case, not deleted, so the founder hears Heart after updating without touching Settings.
  - When 4a's voices cannot run, the stored Apple id speaks, or else `pickDefaultVoice` (Samantha).
  - **A `kokoro:` id never reaches `speak()` or the engine's `setVoice`.** It is translated to the fallback voice at the boundary, until KV-08 teaches the engine lane `kokoro:` ids.
- **D7. The honest fallback, per line.** The system voice speaks the item's `script` when any of these is true:
  - the model or voice file is absent;
  - ORT fails to load;
  - the item has no phonemes for the voice's accent;
  - `tts.vocab` does not equal the build's table stamp;
  - a chunk fails the id mapping;
  - **the phone is too slow for Forays (D8a)**.

  A synthesis failure **before** first audio re-speaks the line in the system voice. A failure **after** first audio stops the line, re-speaks the whole line in the system voice, and marks 4a's voices failed for Forays for the rest of the session. Words are never skipped. The first fallback in a session shows one non-blocking notice, "Using your phone's voice for this one." (K-05's copy). **Preview never ends silent:** a refused or failed Kokoro preview plays `AUDITION_LINE` in the fallback voice and shows the reason inline (KV-06).
- **D8. The lead buffer.**
  - **Within a line:** synthesis streams up to 2 chunks ahead of playback.
  - **Across lines:** when a Foray item starts, the manager asks the native side to prepare the next narration item. `LeadPolicy` (KV-03b) then decides from the warm RTF:
    - RTF ≤ 0.8: render the first chunk only.
    - RTF > 0.8, or not yet measured: render the **whole line** during the preceding clip, capped at 120 s of audio (about 11.5 MB of float PCM).
  - **The warm RTF** is an EWMA, persisted natively per (model, threads), so a second launch starts with a measurement.
  - **When nothing has been measured**, deadlines assume `runtime.lead.assume_rtf_when_unmeasured` = 1.5.
  - The thresholds live in the catalog's `runtime.lead` (data, but bundled: a build is needed to change them).
- **D8a. The per-device floor.** `runtime.max_foray_rtf` = 2.0.
  - When the warm RTF is above it, `kokoroState` reports `forays: false, reason: "too-slow"`. Forays then route to the system voice (D7 notice), while Preview and Read a sample still use 4a's voices.
  - A Foray line whose running warm RTF crosses the floor mid-line stops and re-speaks in the system voice (the D7 after-audio path). A slow phone gets an honest voice, not a stalled Foray.
- **D9. Model loading.** The model loads on first need: picker open, Read a sample, or Foray start (`kokoroState({warm: true})`). It loads on a serial background queue, never on main and never at app start, and stays warm for the process lifetime. The measured cold load was 467 ms (q8f16); fp32's load time on the phone is a KV-R2 number.
  - **Available is not loaded.** `available` means the catalog and every file are present. `loaded` means the session is up.
  - The picker and Foray routing key on `available`. `speakKokoro` and `prepareKokoro` wait for the load internally on the serial queue.
  - Native emits a `kokoroState` event when a load finishes or fails. Nothing shows "can't run" just because the model is still loading.
- **D10. The probe's last job, then retirement.**
  - The K-01 probe gave the Day-0 run (KV-R0, which could not measure). Its last job is now **KV-R2** (probe v2: fp32 on iOS, two provider passes, sentence chunks), with HA #45 re-run on that build.
  - KV-13 then deletes the probe on both platforms. It is **not** adapted onto the new runtime, because two ORT sessions of the model would double memory (the fp32 weights alone are 325.5 MB).
  - "Read a sample" (KV-05) becomes the phone measurement, and HA #45 is rewritten for it only after KV-R2's reading is in.
- **D11. Speed, accelerator, platform order.**
  - Narration speed is 1.0 (DECISIONS 2026-09-24: narration is 1x).
  - **The CoreML EP is measured, not built, in this deck.** fp32 has no `ConvInteger` (the op the EP refused in q8f16), so KV-R2 runs a CoreML pass (MLProgram, ALL compute units) beside the CPU pass on the phone. The faster **finite** pass sets KV-03a's provider (§6a). CoreML numbers from a VM mean nothing (no Neural Engine); only the phone can say. NNAPI stays out of this deck.
  - iOS comes first. Android (KV-09) starts when iOS Read a sample has a real row.
- **D13. The model, per platform (2026-09-26, orchestrator, within the founder's brief).**
  - **iOS bundles the fp32 `model.onnx`** (onnx-community/Kokoro-82M-v1.0-ONNX, `onnx/model.onnx`, 325.5 MB) from the next probe build on. KV-R2 pins url, sha256 and bytes in `fetch-models.mjs`, computed from the download. Reason: it is the only export that is finite and near real time on ARM64 (§10).
  - **Android stays on q8f16 for now.** Play's base-module size limit will not take 325 MB, so an Android fp32 voice is a later card (KV-14) that needs Play Asset Delivery or an on-demand download. **Android has the same fp16 NaN risk** as iOS: KV-09 checks finiteness on the Pixel before anything else.
  - **TestFlight only.** The iOS app goes over the 150 MB ceiling and Apple's 200 MB cellular cap (§1). A public store launch is out of scope for this deck.
- **D12. Engine-mode session ownership.** In native mode, a Kokoro preview or sample from foray-tts relinquishes the engine first (the same `relinquish{cap}` a Foray start does in M1) when the engine is attached but idle. It is refused with `engine-busy` while the engine plays. Forays stay pinned to the legacy lane on iOS until KV-08 lands.

## 3. Architecture in one picture

```
PC / generation host (GPL stays here)
  script ──phonemize.py: lexicon → misaki en-US → espeak-ng fallback → sentence_chunks──▶
  item.phonemes = "chunk1\nchunk2\n…" (each ≤460 code points)   item.tts = {engine:"kokoro", model:"1.0", vocab:"sha256:4984…"}

Phone (no text front end)
  legacy lane:  queue-manager ─speakKokoro/prepareKokoro─▶ ForayTts (iOS)        ┐
  engine lane:  EngineCore ─.speak(…, kokoro:)─▶ SpeechNarrator ─▶ KokoroOutput   ├─▶ KokoroSynth.shared (one ORT session; waits for load)
                                                                                  ┘     split "\n" → KokoroVocab ids per unicode scalar (padded)
                                                                                        → style row = min(padded−2, 509), speed 1
                                                                                        → 24 kHz float AVAudioPCMBuffer (write-callback contract)
                                                                                        → PcmLinePlayer → PcmSink (AVAudioEngine + node in the app; fake in tests)
                                                                                        → LivePaceMeter (rtf cold/warm, ttfa, underruns, gap ms)
```

**KokoroSynth surface.** KV-03a builds these signatures and KV-03b adds `prepare`/`LeadPolicy`. Names are binding; internals are free.

```swift
// KokoroSynthCore — Foundation only
public struct KokoroCatalog: Decodable { /* version, model, vocab, defaultVoice, voices, accents, preview, sample, runtime */
  public static func load(from url: URL) throws -> KokoroCatalog
  public func phonemeField(forVoice id: String) -> String?        // accents[voice.accent].field
}
public enum KokoroVocab {                                           // GENERATED by tools/mobile/gen-kokoro-vocab.mjs
  public static let sha: String; public static let padId: Int; public static let maxInputIds: Int
  static let table: [UInt32: Int]                                   // keyed by Unicode scalar value
  public static func ids(for chunk: Substring) -> [Int]?            // iterates chunk.unicodeScalars, NEVER Characters;
}                                                                   // padded; nil on unknown scalar or > maxInputIds
public enum KokoroChunks {
  public static func split(_ phonemes: String) -> Result<[[Int]], KokoroRefusal>   // on "\n" only
  public static func styleRow(paddedCount: Int, rows: Int = 510) -> Int            // min(max(padded-2,0), rows-1)
}
public struct LivePaceMeter { /* chunkRendered(synthMs:audioSec:), firstAudio(atMs:), drained(atMs:), refilled(atMs:) */
  public func summary() -> LivePace }                               // rtfCold, rtfWarm, ttfaMs, underruns, gapMs, chunks, audioSec, synthMs
public enum LeadPolicy {                                            // KV-03b
  public static func prepareMode(lastWarmRtf: Double?, _ r: KokoroCatalog.Runtime) -> PrepareMode      // .firstChunk | .fullLine
  public static func foraysAllowed(lastWarmRtf: Double?, _ r: KokoroCatalog.Runtime) -> Bool          // nil → true; > max_foray_rtf → false
}
public enum KokoroRefusal: String {                                 // THE one list; foray-tts.js mirrors it as KOKORO_REASONS (pinned equal)
  case vocab, badPhonemes = "bad-phonemes", voiceAbsent = "voice-absent", modelAbsent = "model-absent",
       engineAbsent = "engine-absent", engineBusy = "engine-busy", narrationLoaded = "narration-loaded", tooSlow = "too-slow"
}                                                                   // JS-only extra: "no-bridge" (bridge layer, never native)

// KokoroSynth — ORT + AVFoundation, never AVAudioSession
public final class KokoroSynth {
  public static let shared: KokoroSynth
  public var state: State                                            // .absent(KokoroRefusal) | .available | .loading | .ready(loadMs:)
  public func warm(threads: Int? = nil, _ done: @escaping (State) -> Void)   // a different thread count reloads the one session
  public func render(_ r: KokoroRequest, onBuffer: @escaping (AVAudioPCMBuffer?) -> Void) -> KokoroRender  // waits for load; cancellable
  public func prepare(_ r: KokoroRequest, mode: PrepareMode)         // KV-03b: one-item cache keyed by r.key
  public private(set) var lastWarmRtf: Double?                       // KV-03b: persisted per (model, threads)
}
public protocol PcmSink { func schedule(_ b: AVAudioPCMBuffer, _ played: @escaping () -> Void); func pause(); func resume(); func stop() }
public final class PcmLinePlayer { public init(sink: PcmSink); public var onEnd: ((LineEnd) -> Void)?   // .finished once | .cancelled
  public func play(_ render: KokoroRender, meter: inout LivePaceMeter); public func pause() -> Bool
  public func resume() -> Bool; public func stop() }
```

## 4. The cards

Conventions every card inherits:

- Use an LF worktree: `git -C "<repo>" -c core.autocrlf=false worktree add ../foray-<branch> -b <branch> origin/main`.
- Open PRs as **DRAFT** with the given title. Commit trailers come from the harness.
- Run one `node --test <file>` at a time. Never run repo-wide `format:write`.
- A new suite gets a floor in `test/suite-integrity.test.js` `FLOORS`. Adding tests to an existing suite raises its floor. A replaced test keeps the count; tests are never deleted to make a floor pass, except where a card deletes a whole feature and names each floor it removes.
- Tests in parity-covered suites (`queue-manager`, `tts-bridge`) get `player/parity/unported.json` entries in their section.
- Never commit weights or audio.
- No new native file or comment may contain the three GPL needles.
- Add a `STATE.md` entry per PR.
- Executor tags: **opus** means Swift, Java, DENIED paths or device work. **qwen** means JS, Python or data verifiable in Node. **founder** means a human action on the phone.

---

### KV-R0 · Day-0 phone reading on the existing probe (HA #45 exactly as written) — founder — XS — **DONE 2026-09-26: could not measure**
- **Result:** the founder ran HA #45 on build 2026092602 at 2026-09-26 23:44 UTC. The row: `voiceProbe kokoro-probe could not measure: synthesis-failed/inference-threw  load 457ms/374ms  peak 280.3MB`. Every line threw. The ORT error text goes only to `os_log` (`KokoroOrtProbeEngine.swift` ~line 261, the `catch` that returns `inference-threw`), so the paste cannot say why. The stop-if below fired; the routed fix is the `diag/` voice-probe lane (error text in the record) plus **KV-R2** (the model the phone can actually run). §10 has the full reading.
- **Why first (as written):** the PC ran 3.4–6.4× slower than real time. The phone number should confirm or cut D8's lead buffer, the thread count and the model before KV-03a/KV-04 lock them in. It needs no new code.
- **Steps (overlord):**
  1. Confirm the newest TestFlight build is numbered above 2026091316 **and** contains the RTF fix: `git merge-base --is-ancestor b669a043 <build sha>`. If not, trigger a build first.
  2. Ask the founder to run HA #45 **as currently written**, locking the phone as it says. HA #45 is not rewritten yet (KV-05 does that).
  3. Paste the `voiceProbe` row into `docs/research/on-device-tts.md` §10 (a one-line docs PR). Note the thread count if the row carries one, else "ORT default".
  4. Apply the §6a table.
- **Output:** one phone RTF, measured with the lock, before KV-04 merges.
- **Dependencies:** none. **needs_phone:** yes.
- **Stop if:** the row says `could not measure: …`. Route the fix by the named reason (a build fault), and do not start KV-13 until a measured row exists or the founder says to skip.

### KV-R1 · PC model-variant sweep — **SUPERSEDED by KV-R2 (2026-09-26); do not start**
The x86 PC (ORT 1.20.1, Python) renders the same passage ids fine on the pinned q8f16 model that goes NaN on ARM64, so a PC sweep cannot rank anything for the phone. The ARM64 sweep in §10 already did the variant survey this card asked for, on the right architecture: no small, finite, fast variant exists. KV-R1's `render-audition.py` flags (`--model`, `--threads`, `--profile`) are dropped with it.

### KV-R2 · Probe v2: fp32 on iOS, CPU vs CoreML (MLProgram, ALL units) passes, finiteness + error text, sentence-sized chunks — opus (+ founder run) — M
- **Why:** KV-R0 could not measure (every line threw, §10). The ARM64 sweep shows that the q8f16 model we ship produces NaN on Apple silicon, and that fp32 is the only export that is finite and near real time there (CPU RTF 0.78–0.98 on a 3-vCPU VM). CoreML numbers on a VM are meaningless. So the phone must run fp32, both ways, and say whether the output is finite. **This card replaces KV-R1 and gates KV-03a's model, provider, thread and lead-buffer choices** (§6a).
- **Scope:**
  1. **Pin fp32 for iOS (D13), `fetch-models.mjs`:** add onnx-community/Kokoro-82M-v1.0-ONNX `onnx/model.onnx` with `url`, `sha256` and `bytes` computed by stream-hashing the download (quote the log line in the PR body; about 325.5 MB). `bundle` becomes per platform (for example `bundle: ["ios"]`, `["android"]`, `["ios", "android"]`; the validator still refuses an implicit value): fp32 goes to iOS only, q8f16 to Android only, `af_heart` to both. Rewrite the "WHY q8f16 AND NOT int8 OR fp32" comment with §10's ARM facts. `inject-models.mjs` copies and `--check`s per platform.
  2. **The size gate, per platform (`release-gates.test.js`):** the Android assertions read Android's bundled bytes and stay as they are (q8f16; `APK_WITH_MODEL_BYTES` untouched). iOS gets its own stated budget with its reason in the comment: TestFlight only, projected about 330 MiB, over Apple's 200 MB cellular cap; a public store launch reopens it. The existing "MUTATION: … pin fp32's 326 MB model" comment is rewritten to say iOS does this on purpose.
  3. **Sentence-sized chunks:** re-cut the probe passage's four lines (`tools/mobile/kokoro-probe-passage.json`) by D3's rule, so each inference is one sentence chunk (≤ 460 code points, padded ids, its own style row and expected seconds). The rule's one implementation is `phonemize.py` `sentence_chunks`: this card adds it, and KV-02 wires it into `phonemize_script` rather than adding a second one. Regenerate the passage on the PC venv. This matters for memory as well as latency: on ARM64 fp32's peak RSS reached about 1.3–1.4 GB on the 417-token line, and activation memory scales with chunk length.
  4. **Two passes in one run (`KokoroOrtProbeEngine.swift`):**
     - **Pass A, CPU EP**, intra-op threads 4.
     - **Pass B, CoreML EP**, `ModelFormat=MLProgram`, `MLComputeUnits=ALL`. ORT stays pinned `exact: "1.20.0"`. If 1.20.0's Swift/Objective-C API cannot set these options, pass B records `coreml-unavailable` and pass A still runs; do not change the ORT version.
     - Each pass loads its own session, renders a cold chunk then the warm chunks, and **releases the session before the next pass starts**, so two fp32 sessions never coexist.
  5. **The record, per pass** (a `voiceProbe` row each, built on the `diag/` lane's fields): provider, load ms, cold RTF, **warm RTF** (synthesis ÷ audio over every chunk after the first), peak memory, **finite y/n** (with the count of chunks holding any non-finite sample), and the ORT **error text** if any chunk threw. A non-finite chunk is never counted as audio.
  6. **Android:** its probe reads the same passage and moves to the chunked shape in the same PR (a Java loop), still on q8f16, CPU only. It reports finiteness the same way, so a later Pixel row can show whether Android shares the NaN (D13).
  7. **HA #45 is re-issued (same id)** for the new build. The founder steps stay as written; the build-number floor moves to KV-R2's build.
- **Files:** `tools/mobile/fetch-models.mjs` (+ test), `tools/mobile/inject-models.mjs` (+ test), `test/release-gates.test.js`, `tools/narration/phonemize.py` (+ `phonemize.test.mjs`), `tools/mobile/kokoro-probe-passage.json`, `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroOrtProbeEngine.swift`, `KokoroOrtProbeEngine.java`, `player/kokoro-probe.js` (+ test: the per-pass row), `HUMAN-ACTIONS.md` (#45's build floor), `test/suite-integrity.test.js`.
- **Tests:**
  - fetch-models: "fp32 is bundled on iOS only and q8f16 on Android only" (mutation: bundle fp32 on Android → red); "a pin with an implicit bundle value is refused".
  - release-gates: "Android's bundled bytes are still q8f16's" and "iOS's budget is its own, with the TestFlight reason in the file".
  - phonemize: "sentence_chunks: split after . ! ? ; + space; <24 merges forward; >460 splits at the last space; a chunk with U+0303 counts it as one".
  - kokoro-probe: "one row per pass, carrying provider, warm RTF, peak, finite and error text" (mutation: drop `finite` → red); "a pass with a non-finite chunk is never a pass".
  - The passage: "every chunk is ≤ 460 code points and maps to the committed ids".
- **CI evidence:** `ios-shell` and `android-shell` green with weights fetched; the `inject-models --check` log lines per platform (fp32 in the iOS app, q8f16 in the APK); the iOS `.app` size recorded as the first iOS-with-fp32 figure.
- **Acceptance:** **one founder probe run returns, per pass (CPU, CoreML), warm RTF, peak memory, finite yes/no, and the error text if any.** The overlord applies §6a to it before KV-03a merges.
- **Governance:** `fetch-models.mjs`, `inject-models.mjs` and `release-gates.test.js` are DENIED, so `needs-founder`. The overlord verifies and labels; the agent never self-applies.
- **Dependencies:** the `diag/` voice-probe lane (in flight; it adds the error text, ORT version, provider and output finiteness to the probe record). KV-R2 builds on those fields and does not re-implement them. **needs_phone:** yes (HA #45 on the new build).
- **Stop if:** two stream-hashes of the fp32 download disagree; the app is killed during a pass (report the last logged peak); `ios-shell` cannot build with the 325.5 MB file.
- **PR:** `feat(voice-probe): probe v2 — fp32 on iOS, CPU vs CoreML passes, finiteness, sentence chunks (KV-R2)`.

### KV-00 · Land this deck (revision 3) — qwen — XS
- **Scope:**
  - Replace `docs/roadmap/kokoro-voice.md` with this revision. KV-11 (British) is listed as a roadmap item with its trigger.
  - Add a one-line pointer at the top of `docs/bundled-voice-plan.md` §9: "Execution: `docs/roadmap/kokoro-voice.md` rev 3 (2 American voices; British = KV-11)".
- **Files:** `docs/roadmap/kokoro-voice.md`, `docs/bundled-voice-plan.md` (one line).
- **Acceptance:** `node --test "test/*.test.js"` green (doc and claim invariants).
- **Dependencies:** none. **needs_phone:** no.
- **PR:** `docs(voice): kokoro deck rev 3 — Heart + Echo, British on the roadmap (KV-00)`.

### KV-01 · Bundle Echo beside Heart; the voice catalog is data — opus — S
- **Scope:**
  1. `fetch-models.mjs`:
     - Add the `am_echo` pin. Fetch it once and stream-hash it. It must equal `3968b92c…f3c3` / 522,240 B from the audition manifest; if it differs, stop.
     - Replace `bundle: id === PROBE_VOICE` with `bundle: BUNDLED_VOICES.includes(id)`. `BUNDLED_VOICES` is read from `kokoro-voices.json`'s `voices[].id`, and a catalog id with no pin is an error.
     - Keep `PROBE_VOICE = "af_heart"` until KV-13.
     - Correct the "table in the bundle" comment per D2.
  2. Create `mobile/plugins/foray-tts/kokoro-voices.json` with the D5 schema. `preview.phonemes` and `sample.lines[].phonemes` start as `null`; KV-02 fills them.
     - Header: `"version": 1`, `"model": {"ios": <KV-R2's fp32 pin name>, "android": "kokoro-v1_0-q8f16"}` (D13; if KV-R2 has not landed, `"ios"` carries the q8f16 name and KV-R2 changes it), `"vocab": "sha256:498414659c1db01e"`, `"default": "af_heart"`.
     - `voices`:
       - `{id:"af_heart", name:"Heart", accent:"en-US", gender:"female", about:"American · female"}`
       - `{id:"am_echo", name:"Echo", accent:"en-US", gender:"male", about:"American · male"}`
     - `"accents": {"en-US": {"field": "phonemes"}}`.
     - `preview: {text: <app.js AUDITION_LINE verbatim>, phonemes: null}`.
     - `sample`: foray `how-ai-actually-gets-built-3b83e1`, lines `disclosure`, `narration-act-1-5-connective`, `narration-act-1-7-beat` and `act-4-exit` (#844's four), each with `text` and `phonemes: null`.
     - `runtime: {speed:1.0, intra_op_threads:4, chunk_gap_sec:0.08, max_chunk_phonemes:460, max_foray_rtf:2.0, lead:{stream_ahead_chunks:2, prerender_full_line_above_rtf:0.8, prerender_cap_sec:120, assume_rtf_when_unmeasured:1.5}}`.
  3. `inject-models.mjs`: copy `kokoro-voices.json` next to the injected weights on iOS (`App/public`) and Android (the assets root). `--check` re-verifies it and fails when a catalog voice's `.bin` is not injected.
  4. `test/release-gates.test.js`:
     - The size budget re-derives from the pinned bytes (+522,240 B), per platform once KV-R2 has split it.
     - **`APK_WITH_MODEL_BYTES` is updated to this PR's android-shell universal-APK measurement, with the run id cited**, so the 35–55 MiB runtime-share check stays honest instead of absorbing Echo.
     - Add `kokoro-voices.json` to `NATIVE_BUILD_INPUTS`.
     - The 150 MB ceiling still holds.
- **Files:** `tools/mobile/fetch-models.mjs` (+ `.test.mjs`), `tools/mobile/inject-models.mjs` (+ test), `mobile/plugins/foray-tts/kokoro-voices.json` (new), `test/release-gates.test.js`.
- **Tests (`fetch-models.test.mjs`, floor +3):**
  - "exactly the catalog's voices are bundled" (mutation: bundle a third voice → red).
  - "the catalog default is a catalog voice".
  - "every catalog voice's accent has an `accents` entry, and every accent field is an authored field (`AUTHORED_PHONEME_FIELDS = ["phonemes"]`)" (mutation: add an `en-GB` voice → red).
  - Inject test: "the catalog is injected, and `--check` fails on a missing voice bin".
  - `release-gates`: the budget reads the new bytes, and the needle scan covers the catalog.
  - The two hash observations (the manifest, and this PR's fresh stream-hash log line) go **in the PR body**, not in a literal-pair test.
- **CI/device evidence:**
  - `ios-shell` and `android-shell` green with weights fetched.
  - The PR quotes the `inject-models --check` log lines showing both `.bin` files and `kokoro-voices.json`.
  - The new universal-APK byte count is recorded next to 137,468,845 B, with the run id.
- **Governance:** DENIED paths, so `needs-founder`. The overlord verifies and labels; the agent never self-applies.
- **Dependencies:** none (KV-00 soft). **needs_phone:** no.
- **Stop if:** the fresh hash differs from the manifest's; the universal APK exceeds 150 MB.
- **PR:** `feat(voice): bundle Echo beside Heart; kokoro-voices.json catalog (KV-01)`.

### KV-02 · Phonemes on every narration item, the Preview line and the sample; one chunk rule; seed strip — qwen (+ run on the founder PC venv) — M
- **Precondition:** #844 is merged. The overlord merges it first; it is audition tooling. KV-02 never starts while two Python chunkers could coexist.
- **Scope:**
  1. `phonemize.py`:
     - `--json -` reads stdin before `load_backend()`, as in rev 2's fix, so `backend/src/generation/phonemize.ts`'s spawn works.
     - Use `sentence_chunks(phonemes)` per D3, counting code points (KV-R2 adds it; if KV-R2 has not landed, add it here, and KV-R2 then reuses it: one implementation either way). `phonemize_script` returns `"\n"`-joined chunks.
     - `ids_for` validates each chunk separately, iterating code points.
     - New `--catalog <kokoro-voices.json> --in-place` fills `preview.phonemes` and `sample.lines[].phonemes`, reading the sample text from `data/forays.json` by id.
  2. **`render-audition.py`, unconditionally:** import `sentence_chunks` from `phonemize.py` and delete `split_phonemes`. Re-render Heart and Echo for the four sample lines on the PC with the new rule. These are the reference audio (in `data-local/`, not committed); the PR names the paths.
  3. New `tools/narration/phonemize-forays.mjs` (rev 2 KV-01's batch tool):
     - One subprocess for the whole file.
     - Stamps `phonemes`, `est_sec` and `tts` only on narration items without `tts`.
     - Dry run by default; `--write` rewrites the file.
     - Never throws; a failing backend writes nothing.
  4. **Run it for real** on this PC's proven venv (`data-local/voice-audition/.venv/Scripts/python.exe`, via `FORAY_PYTHON`) over `data/forays.json` (all 157 items), and run `--catalog` over `kokoro-voices.json`. Commit the data. The PR records the misaki and espeak-ng versions and the count of espeak-fallback words.
  5. `tools/foray/check-forays.mjs` `phonemeProblems` gains three checks when `tts.engine === "kokoro"`:
     - every `"\n"` chunk is 1..460 code points (`[...s].length`);
     - every code point is a vocab key;
     - `tts.vocab` equals the committed table's sha.

     Also fold in rev 2 KV-03's lexicon mutation test (`sake`).
  6. **Seed strip, planned rather than a stop:** `prepare-webdir.mjs`'s seed copy strips `phonemes` and `tts` from seed Foray items, so the 44 KB cap holds unchanged. A seed Foray speaks in the system voice until the boot directory fetch refreshes it.
- **Files:** `tools/narration/phonemize.py`, `tools/narration/phonemize.test.mjs`, `tools/narration/render-audition.py`, `tools/narration/phonemize-forays.mjs` (+ test, + `fixtures/fake-g2p.mjs`; the name is chosen to avoid the needle), `tools/foray/check-forays.mjs` (+ test), `tools/mobile/prepare-webdir.mjs` (+ test), `data/forays.json`, `mobile/plugins/foray-tts/kokoro-voices.json` (phonemes only), `docs/curation/generation-architecture.md` §4.7a (one line: "authored by batch 2026-09-xx; the stage is KV-07").
- **Tests:**
  - "`--json -` reads stdin" (no `FileNotFoundError`/`Traceback` in stderr).
  - "sentence_chunks: split after . ! ? ; + space; <24 merges forward; >460 splits at the last space; joining with a space restores the input; a chunk with U+0303 counts it as one" (mutations: drop the merge rule, or cut mid-word → red).
  - "render-audition has no split_phonemes and imports sentence_chunks" (source pin).
  - "batch runs ONE subprocess".
  - "a failing backend leaves the file byte-identical".
  - check-forays: "a kokoro item with a 461-code-point chunk / an out-of-vocab code point / a foreign vocab sha is a problem" (one mutation each).
  - "the committed data: every narration item has phonemes and tts". This reads the live file, not the frozen fixture: the one allowed exception, named in the test.
  - "catalog preview and sample are phonemized and vocab-valid".
  - prepare-webdir: "seed Foray items carry no phonemes/tts, and the seed stays under budget" (mutation: keep phonemes → red).
  - "the boot directory fetch replaces a seed Foray's body with the phonemized one before play". Put it in the suite that covers boot catalog loading (find it by `seed` under `player/` and `test/`).
- **CI evidence:** `node tools/foray/check-forays.mjs` green; `node --test tools/mobile/prepare-webdir.test.mjs` green; the `data-and-site` job green.
- **Governance:** `prepare-webdir.mjs` is DENIED, so `needs-founder`.
- **Dependencies:** KV-01 (the catalog file exists); #844 merged. **needs_phone:** no.
- **Stop if:**
  - No boot fetch replaces seed Foray bodies (the refresh test cannot be written against real code). Report it; do not invent the fetch.
  - Any item's phonemes contain `?` (misaki's unknown marker): espeak did not run.
  - Two runs are not byte-identical.
- **PR:** `feat(narration): Kokoro phonemes on all 157 narration items + Preview/sample; one chunk rule (K-02, KV-02)`.

### KV-03a · KokoroSynth core: ids→PCM, player, live-pace meter (what the sample needs) — opus — M
- **Scope:**
  - Create `mobile/plugins/foray-tts/kokoro-synth/` with the §3 surface **minus** `prepare`, `LeadPolicy` and RTF persistence (those are KV-03b):
    - `Package.swift`: name `KokoroSynth`, platforms iOS 15 / macOS 12, products `KokoroSynthCore` and `KokoroSynth`, dependency `onnxruntime-swift-package-manager` `exact: "1.20.0"`.
    - `KokoroSynthCore` depends on nothing. `KokoroSynth` depends on Core, onnxruntime and AVFoundation.
  - `KokoroRuntime`:
    - One `ORTEnv`/`ORTSession` per process (`KokoroSynth.shared`), loaded on a private serial queue.
    - The model file is the catalog's iOS model (fp32, D13). The provider (CPU or CoreML with MLProgram/ALL) and the intra-op threads come from the catalog, as fixed by KV-R2's reading (§6a); `warm(threads:)` reloads the one session when the count changes.
    - A rendered chunk with any non-finite sample is a synthesis failure (D7), never audio.
    - Style matrices are cached per voice. A voice file must be exactly 522,240 B, else `voice-absent`.
    - The output tensor is copied to `[Float]` and wrapped as a 24 kHz mono deinterleaved `AVAudioPCMBuffer`.
    - The file lookup (bundle root, then `public/`) is implemented here. `KokoroModelFiles` stays for the probe until KV-13.
    - `state` distinguishes `.available` (files present) from `.ready` (loaded). `render` called before the load finishes queues behind it.
  - `KokoroRender` delivers buffers through the write-callback contract, with the 80 ms gap as a silent buffer. It streams at most `stream_ahead_chunks` ahead and can be cancelled.
  - `PcmLinePlayer` works through `PcmSink`. The app sink `EnginePcmSink` owns an `AVAudioEngine` + `AVAudioPlayerNode`.
    - Its logic follows `engine/m2` `PcmOutput`'s player half: scheduled/played counters, and finished only after the empty buffer **and** full playback.
    - Stop means cancelled, with no finish. Pause and resume act on the node.
    - It handles `AVAudioEngineConfigurationChange`.
    - It feeds `LivePaceMeter`. An underrun is the sink draining while the render has not ended.
  - **Tokenization is by Unicode scalar.** `tools/mobile/gen-kokoro-vocab.mjs` generates `KokoroVocab.swift` from `kokoro-vocab.json` with `[UInt32: Int]` keys, plus `--check`. The sha is computed as in `kokoro-vocab.test.mjs`.
    - `--fixture` writes `Tests/KokoroSynthCoreTests/Fixtures/ids-oracle.json`: the passage lines from `tools/mobile/kokoro-probe-passage.json` plus a chunk containing U+0303, each mapped per code point exactly as Python's `ids_for`.
    - The oracle is copied here, so KV-13 can delete the passage file.
  - `foray-tts/Package.swift`: add `.package(path: "kokoro-synth")` and both products. **Leave the direct onnxruntime dependency and the probe untouched** (KV-13 removes both).
  - **GPL gate:** add `kokoro-synth/Package.swift` and `foray-audio/Package.swift` to `release-gates.test.js` `NATIVE_BUILD_INPUTS`. `foray-tts-native.test.mjs` walks **every file** under `kokoro-synth/` (the generated `KokoroVocab.swift` included) for the three needles.
  - `ci.yml` `ios-kit` gains `swift test --package-path mobile/plugins/foray-tts/kokoro-synth` on the macOS host.
- **Files:** `mobile/plugins/foray-tts/kokoro-synth/**` (new), `mobile/plugins/foray-tts/Package.swift`, `tools/mobile/gen-kokoro-vocab.mjs` (+ test), `tools/mobile/foray-tts-native.test.mjs` (new pin suite), `test/release-gates.test.js`, `.github/workflows/ci.yml` (one step), `test/suite-integrity.test.js`.
- **Tests:**
  - **Core (host):**
    - "split on \n maps every oracle line's chunks to `[0, …ids, 0]`".
    - "a chunk containing U+0303 maps to the oracle's ids" (mutation: iterate `Character`s → red).
    - "an unknown scalar / a chunk over 512 padded → `bad-phonemes`, never a partial array".
    - "styleRow = padded−2, clamped to 509" (mutation: row 0, #844's old bug → red).
    - "catalog decodes; phonemeField(af_heart) == "phonemes"; unknown voice → nil".
    - "LivePaceMeter: cold = the first chunk after load; an underrun counts once per drain; gapMs sums drain→refill".
  - **Renderer/player** (a fake runtime emitting a 0.2 s sine per chunk, and a **fake `PcmSink`**; no test constructs `AVAudioEngine` or calls `start()`):
    - "3 chunks → 3 audio buffers + 2 gap buffers + 1 empty, in order".
    - "finished fires once" (mutation: per chunk → red).
    - "stop before end → cancelled, never finished".
    - "never more than 2 chunks rendered ahead".
    - "render before load finishes waits, then plays".
  - **Pins (`foray-tts-native.test.mjs`):**
    - "no file under kokoro-synth references AVAudioSession".
    - "every Package.swift naming onnxruntime pins exact 1.20.0".
    - "no file under kokoro-synth contains a GPL needle" (mutation: put `espeak` in a kokoro-synth comment → red).
    - "no file under kokoro-synth/Tests constructs `AVAudioEngine(`".
  - `gen-kokoro-vocab --check` exits 0, and regenerating is byte-identical.
- **CI evidence:**
  - `ios-kit` green, including the new `swift test` step and `-scheme ForayTts`.
  - `ios-shell` green: the app links through the nested path dependency. Quote the resolved-graph line for `KokoroSynth @ local`.
  - `node --test test/release-gates.test.js` green with the two new inputs.
- **Governance:** two `Package.swift` files, `release-gates.test.js` and `ci.yml` are DENIED, so `needs-founder`.
- **Dependencies:** none hard to start (codes against the D5 schema; KV-01 soft). **It merges only after the overlord has applied §6a to KV-R2's reading**, which fixes its model, provider, thread count and lead-buffer defaults. **needs_phone:** no.
- **Stop if:**
  - Capacitor's generated CapApp-SPM fails to resolve a nested package inside foray-tts. Report the error. The fallback is moving the package to `mobile/packages/kokoro-synth` with `../../packages/…` paths, which needs a new review.
  - The ORT Swift API cannot hand out the output buffer without a second copy. Measure it and document it; do not change the ORT version.
- **PR:** `feat(kokoro): KokoroSynth package — scalar ids→PCM, style row, PcmSink player, live-pace meter (KV-03a)`.

### KV-13 · Retire the K-01 probe (after its Day-0 reading) — opus — S
- **Why:** adapting the probe onto a second, non-shared runtime would put two ORT sessions of the model in one process: 325.5 MB of fp32 weights each on iOS (D13), before activations. The q8f16 probe alone peaked at 290.9 MB, which already risked jetsam on 2–3 GB iPhones; KV-R2 reports fp32's peak. It would also be refactoring code this deck deletes.
- **Scope:** delete, on both platforms:
  - `kokoroProbe` native (`KokoroOrtProbeEngine.swift`, `KokoroModelFiles` if nothing else uses it, `KokoroOrtProbeEngine.java`, and the plugin methods);
  - the web half and the `tts-bridge` delegate;
  - `player/kokoro-probe.js` (+ test);
  - the Developer drawer switch and `cp_voice_probe`, including its privacy-policy row;
  - `tools/mobile/kokoro-probe-passage.json` and its webdir entry (DENIED `prepare-webdir.mjs`);
  - `PROBE_VOICE` in `fetch-models.mjs`, if only the probe used it;
  - foray-tts `Package.swift`'s direct onnxruntime dependency (KokoroSynth now owns it).

  HA #45 stays open; KV-05 rewrites it.
- **Files:** as listed, plus `app.js` (the switch), `player/client.js`, `player/tts-bridge.js` (+ test), `player/parity/unported.json` (`tts-bridge` section), `docs/legal/privacy-policy.md`, `test/suite-integrity.test.js`.
- **Tests:**
  - `git grep -n kokoroProbe` is empty.
  - Floors of deleted suites are removed, with a PR note naming each one.
  - The pin tightens to "onnxruntime appears in exactly one Package.swift (kokoro-synth)".
  - Android `build.gradle` is untouched: ORT stays for KV-09.
- **CI evidence:** `ios-kit`, `ios-shell`, `android-shell` green; `node --test player/parity/coverage.test.js` green.
- **Governance:** `Package.swift` and `prepare-webdir.mjs` are DENIED, so `needs-founder`.
- **Dependencies:** KV-R2 (a measured row, or the founder's skip; KV-R0 could not measure), KV-03a (serial on `foray-tts/Package.swift` and `foray-tts-native.test.mjs`). **needs_phone:** no.
- **If KV-R2 is still open when KV-04 is ready:** KV-04 refuses `kokoroProbe` with `engine-busy` while `KokoroSynth.shared` is loading or loaded, and KV-13 lands later.
- **PR:** `chore(voice): retire the K-01 probe after its Day-0 reading (K-01, KV-13)`.

### KV-04 · foray-tts (iOS) + web half: `kokoroState`, `speakKokoro`, the sample — opus — M
- **Scope:**
  - **Native (`ForayTtsPlugin.swift`; append two `CAPPluginMethod`s to `pluginMethods`):**
    - `kokoroState({warm, threads?})` returns `{ok, available, loaded, reason?, model, vocab: KokoroVocab.sha, default, voices:[{id,name,accent,gender,about}], accents, runtime:{lead, max_foray_rtf}, threads, loadMs?, lastWarmRtf?}`.
      - The catalog is read once from the bundle.
      - `available` needs the model and every catalog voice file. `loaded` needs the session.
      - `warm: true` starts `KokoroSynth.shared.warm(threads:)` in the background and never blocks.
      - A load that finishes or fails notifies a `kokoroState` event with the same payload.
    - `speakKokoro({phonemes, vocab, voice, utteranceId, audition?})` or `speakKokoro({builtin: "preview"|"sample", voice, utteranceId})`.
      - Validation order: vocab, then chunk ids, then voice file, then engine. A failure resolves `{ok:false, reason}` with a `KokoroRefusal` string; it never rejects.
      - It does **not** refuse because the model is still loading: it waits for the load on the serial queue.
      - It claims the session exactly as `speak` does today (`claimSession`: `.playback`/`.spokenAudio`), then resolves `{ok:true, engine:"kokoro", voice}` on accept.
      - `finished` is notified once with `{utteranceId, engine:"kokoro", audition, pace: LivePace}`.
      - A mid-line failure notifies `kokoroFailed {utteranceId, reason, afterAudio}`.
      - A new `speakKokoro` or `speak` stops the line in flight silently.
    - `builtin: "sample"` speaks the catalog's four sample lines back to back, purely live. It adds `peakMemoryBytes`, `lockedAtEnd` (reusing `peakResidentBytes`/`isForeground`), `threads` and `provider` (the catalog's, set from KV-R2: `"cpu"` or `"coreml"`) to its `finished` payload.
    - `pause`, `resume`, `stop` and `state` route to `PcmLinePlayer` when the Kokoro line is active (real pause on this path).
    - New `KokoroSpeaker.swift` (the plugin-side glue) owns one `PcmLinePlayer` with an `EnginePcmSink`.
  - **Web half (`foray-tts.js`):**
    - Export `kokoroState` and `speakKokoro` with the old probe's shape: `shellApplies` false → `{ok:false, path:"none", reason:"engine-absent"}`, and never Web Speech for phonemes.
    - Export `KOKORO_REASONS`, the mirror of `KokoroRefusal`.
    - `onKokoroFailed` and `onKokoroState` listeners.
    - No sibling imports.
  - **Bridge and client:**
    - `tts-bridge.js` delegates, with `no-bridge`/`engine-absent`.
    - `client.js` `ForayPlayer` gains `kokoroState(opts)`, `previewKokoro(voiceId)` and `sampleKokoro(voiceId, {threads?})`. `sampleKokoro` resolves with the `finished` pace payload for its utteranceId, or `{ok:false, reason}`.
    - **Native mode (D12):** when `engineMode === 'native'`, the engine is attached and idle, `previewKokoro`/`sampleKokoro` first send the same `relinquish{cap}` a Foray start sends in M1. While the engine plays, they refuse with `engine-busy`.
  - **Refusals:** Preview is refused with `narration-loaded` while a Foray line is loaded. The sample is refused while anything plays (`engine-busy` or `narration-loaded`).
  - **Probe guard:** if KV-13 has not landed, `kokoroProbe` refuses with `engine-busy` while `KokoroSynth.shared` is loading or loaded.
- **Files:** `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift`, new `KokoroSpeaker.swift`, XCTests, `mobile/plugins/foray-tts/web/foray-tts.js`, `player/tts-bridge.js`, `player/client.js`, `tools/mobile/foray-tts.test.mjs`, `player/tts-bridge.test.js`, `player/parity/unported.json` (the `tts-bridge` section), `tools/mobile/foray-tts-native.test.mjs`, `mobile/plugins/foray-tts/README.md` (the API section).
- **Tests:**
  - **XCTest:**
    - "foreign vocab → vocab, engine untouched" (mutation: skip the check → red).
    - "unknown voice id → voice-absent".
    - "speakKokoro during load waits and plays; it never refuses for loading".
    - "builtin sample speaks 4 lines and reports one pace record with threads".
    - "kokoroState without weights: available false, reason model-absent; with weights before warm: available true, loaded false".
    - "pluginMethods lists the two".
  - **Node:**
    - "speakKokoro passes phonemes/vocab/voice/utteranceId" (mutation: drop vocab → red).
    - "no shell → engine-absent, speechSynthesis never called".
    - "KOKORO_REASONS equals the Swift enum's raw values" (a source pin that parses `KokoroRefusal`).
    - "native `{ok:false, reason:'engine-busy'}` is passed through; an unknown reason → engine-absent".
    - bridge: "no module → no-bridge; missing fn → engine-absent".
    - client source pins: "previewKokoro refuses while narration is loaded" and "in native mode, previewKokoro/sampleKokoro relinquish the engine before calling foray-tts, and refuse while it plays" (mutation: drop the relinquish → red).
- **CI evidence:** `ios-kit` (`-scheme ForayTts`) green; `ios-shell` green; `node --test player/parity/coverage.test.js` green.
- **Dependencies:** KV-03a, KV-01 (KV-13 soft; see its guard). **needs_phone:** no; the first audible proof is KV-05's.
- **Stop if:** starting `AVAudioEngine` produces an M1 engine `fault kind=implicit-activation` row, or any session fault row, **in either lane or mode**. Log it and stop: that is the one-session-owner question and belongs to the native-engine owner.
- **PR:** `feat(foray-tts): Kokoro speak/state + live sample on iOS and the web half (K-04, KV-04)`.

### KV-05 · Developer "Read a sample" (sample only; the picker moves to KV-06) — qwen (app.js) — S
- **Scope:**
  - **Developer group (`app.js`):**
    - One button per catalog voice, "Read a sample — Heart" and "Read a sample — Echo", rendered from `kokoroState().voices`. Each runs `sampleKokoro(id, {threads})`.
    - A **Threads** control: catalog (4) / 2 / auto (0). It is session-only and not stored, and it is passed through to `warm`, which reloads the one session.
    - Each run writes a `voiceSample` row into the Playback-diagnostics record (the copy-out flow from HA #21). The row format is `voiceSample af_heart cpu t=4 load 467ms rtf cold 1.10 warm 0.62 ttfa 840ms underruns 0 (0ms) chunks 14 audio 94.2s peak 301MB locked=n → live`.
    - When `kokoroState` says not available, the buttons are disabled and show the reason.
  - **The picker is not touched here.** No `kokoro:` id is written to `cp_voice` until KV-06 ships selection and routing together.
  - **New `player/kokoro-sample.js` (pure):** `summarizeSample`, `sampleVerdict` and `formatSampleRow`. The verdict thresholds are written before any run:
    - `live`: warm RTF ≤ 0.8, 0 underruns, TTFA ≤ 1500 ms and peak ≤ 400 MB. **The 400 MB bound was written for q8f16;** fp32's weights alone are 325.5 MB. The overlord replaces it with a bound fixed from KV-R2's peak reading before KV-05 is built, and the test below pins whatever number that is.
    - `lead`: warm RTF ≤ 1.5 (Forays rely on D8's prerender).
    - `slow`: warm RTF > 1.5 (§6). Above `max_foray_rtf` (2.0), Forays go to the system voice on that phone (D8a).
    - An RTF ≤ 0.01 or 0 s of audio is a failed measurement ("could not measure"), as #686 established.
  - **HUMAN-ACTIONS #45 is rewritten in place** (same id), **only after KV-R2's reading is recorded**. The steps, verbatim for the founder:

    **"Install the first TestFlight build whose menu → Developer shows 'Read a sample — Heart'. Tap it and just listen: it reads the same four lines from 'How AI actually gets built' that you heard on your PC, but made live by the phone. Pauses or stutters are what we're measuring, not a bug. When it stops, tap 'Read a sample — Echo' and lock the phone right away; unlock when it goes quiet. Then set Threads to 2 and tap 'Read a sample — Heart' once more. Open Playback diagnostics, tap Copy, and paste the record here. If a row says 'could not measure', paste it anyway."**

    Joey's Pixel follows after KV-09.
- **Files:** `app.js` (the Developer group only), `player/kokoro-sample.js` (+ `kokoro-sample.test.js`, a new suite), `HUMAN-ACTIONS.md` (#45), `test/suite-integrity.test.js`.
- **Tests:**
  - kokoro-sample:
    - "the verdict boundaries at 0.8 / 1.5 / 1500 ms / 400 MB" (mutation: `<` for `≤` → red).
    - "RTF 0 or 0 s audio → could not measure".
    - "the row format is pinned, t= included".
  - app (source pin or vm harness; the PR names which): "sample buttons render one per catalog voice and pass the Threads choice"; "no code path in this PR writes a `kokoro:` value to cp_voice".
- **CI/device evidence:** Node suites green, `node --check app.js`, and a build number. **Device (founder, HA #45):** three `voiceSample` rows from the founder's iPhone (Heart, Echo locked, Heart at 2 threads) with real numbers. KV-10 records them in `docs/research/on-device-tts.md` §10.
- **Dependencies:** KV-04, KV-02 (the sample phonemes), KV-R2 (for the HA rewrite and the memory bound). **needs_phone:** yes (HA #45).
- **PR:** `feat(app): Developer "Read a sample" live-pace test for Heart and Echo (V-01 re-scope, KV-05)`.

### KV-03b · Lead policy, prepare cache, RTF memory and the too-slow floor (+ `prepareKokoro`) — opus — S
- **Scope:**
  - **In `KokoroSynthCore`:** `LeadPolicy.prepareMode` and `foraysAllowed`, plus an `RtfStore` protocol.
  - **In `KokoroSynth`:**
    - `prepare(_:mode:)` keeps a one-item cache, and a `render` with a matching key replays the cache first.
    - `lastWarmRtf` is an EWMA, persisted per (model, threads) in `UserDefaults`.
  - **Too slow mid-line:** a non-builtin, non-audition line whose running warm RTF crosses `max_foray_rtf` after at least 2 chunks stops and notifies `kokoroFailed {reason:"too-slow", afterAudio}`.
  - **In the plugin:**
    - A new `prepareKokoro({phonemes, vocab, voice, utteranceId})` method applies `LeadPolicy` (waiting for the load) and returns `{ok, mode}`.
    - `kokoroState` gains `forays` (from `foraysAllowed`) and `reason: "too-slow"` when it is false.
  - **Web half, bridge and `KOKORO_REASONS`** carry `prepareKokoro` as in KV-04.
- **Files:** `kokoro-synth/**`, `ForayTtsPlugin.swift`, `KokoroSpeaker.swift`, XCTests, `foray-tts.js`, `player/tts-bridge.js` (+ test), `player/parity/unported.json` (`tts-bridge`), `tools/mobile/foray-tts.test.mjs`, `README.md`.
- **Tests:**
  - "LeadPolicy: nil or >0.8 → fullLine; ≤0.8 → firstChunk".
  - "foraysAllowed: nil → true; 2.5 → false" (mutation: ignore the floor → red).
  - "a prepared key replays without calling the runtime".
  - "RTF persists per (model, threads) and a different thread count starts unmeasured".
  - "a Foray line crossing the floor mid-line → kokoroFailed too-slow afterAudio true; a builtin sample never does".
  - Node: "prepareKokoro passes through; no shell → engine-absent".
- **CI evidence:** `ios-kit` green (the kokoro-synth `swift test` and `-scheme ForayTts`); `ios-shell` green.
- **Dependencies:** KV-03a, KV-04 (serial on the plugin files). **needs_phone:** no. It runs in parallel with KV-05 and must land before KV-06.
- **PR:** `feat(kokoro): lead policy, prepare cache, persisted RTF and the too-slow floor (KV-03b)`.

### KV-06 · Forays in the chosen voice + the picker, in one PR — qwen — L
Selection and routing ship in **one PR, as two commits (routing, then picker)**, so no build shows Heart selected while Forays speak Samantha, or the reverse.
- **Scope:**
  1. **`player/foray-queue.js`:** the narration queue item carries copies of `tts` and of every phoneme field the catalog's `accents` names (`phonemes` today). `est_sec` feeds `narrationDuration` ahead of the character estimate and stays labelled estimated (rev 2 KV-07).
  2. **`player/queue-manager.js`:**
     - Add `setKokoro({available, forays, vocab, catalog, lastWarmRtf})` and `setFallbackVoice(id)`.
     - `_speakNarration(item)` calls `this._tts.speakKokoro({phonemes: item[field], vocab: item.tts.vocab, voice: id, utteranceId})` when **all** of these hold:
       - the voice is `kokoro:<id>` (the D6 default applied);
       - Kokoro is **available** (not necessarily loaded), `forays` is true, and it has not failed this session;
       - `item.tts.engine === "kokoro"`;
       - `item.tts.vocab === kokoro.vocab`;
       - the voice's accent field is non-empty.
     - Otherwise it calls `speak(script)` with the fallback voice and emits `tts.route item=<id> engine=system why=<reason>` once per item. **A `kokoro:` id never reaches `speak()`**; it is translated to the fallback voice.
     - A `{ok:false}` from `speakKokoro` gets one system attempt.
     - `kokoroFailed` follows D7: re-speak in the system voice and mark the session failed for Forays. `too-slow` is one of these reasons.
     - `lastEngine` and `lastEngineFallback` getters.
     - **The lead:** when any Foray item starts, call `prepareKokoro` for the next narration item if it will route to Kokoro. The native side picks the mode.
     - **The deadline:** change the signature to `narrationDeadlineSec(item, rate, rtf = null)`. For a Kokoro line it adds `duration_sec × max(1, rtf ?? assume_rtf_when_unmeasured)`, which is 1.5 when unmeasured, so the result is always finite.
     - The `finished` pace is appended to the existing narration diagnostics row as `engine=kokoro rtf=… ttfa=… underruns=…`.
  3. **`player/client.js`:**
     - At boot, `kokoroState()` goes to `manager.setKokoro`, and every `onKokoroState` event re-feeds it (as does `visibilitychange`).
     - Opening a Foray warms the model (`kokoroState({warm:true})`).
     - `sessionDefaultVoice` goes to `setFallbackVoice`.
     - **`applyVoice` translates a `kokoro:` id to the fallback voice before the engine's `setVoice`** (KV-08 removes this for the engine lane).
     - **Forays stay pinned to the legacy lane on iOS in native mode** (D12), with a routing test.
     - The snapshot carries `engineFallback`.
  4. **`app.js`, the notice:** the first `engineFallback` in a session paints "Using your phone's voice for this one." once, through `paintForayNotice`. The flag is session-only.
  5. **`app.js`, the picker (native path).** Opening it calls `ForayPlayer.kokoroState({warm:true})`, and the sheet re-renders on the `kokoroState` event.
     - **Available:** one enabled radio row per catalog voice (`name`, `about`), each with a Preview button that calls `previewKokoro(id)`.
       - Selection persists `cp_voice = "kokoro:<id>"`.
       - With no valid `kokoro:` value stored, the catalog default is shown selected (D6).
       - There are no Apple rows, no greyed rows, no Settings path and no `missingNote`.
       - If `forays` is false (too-slow), the rows stay enabled and one status line reads: "On this phone, Forays use your phone's own voice; 4a's voices can't keep up here yet. Preview still plays them."
     - **Preview never ends silent:** when `previewKokoro` returns `{ok:false}`, or `kokoroFailed` arrives before audio, the sheet speaks `AUDITION_LINE` via `auditionVoice` with the fallback voice and shows the reason inline in plain words.
     - **`engine-absent`** (the platform has no Kokoro methods; Android before KV-09): **today's system-voice sheet renders unchanged.** KV-12 retires it after KV-09.
     - **Any other not-available reason** (a build fault such as `model-absent`): the two rows are disabled, plus one line: "4a's voices can't run on this phone right now, so narration uses your phone's own voice."
     - **Unchanged:** the website's Web Speech path; `VOICE_SHEET_SUB` ("Tap Preview to hear it count to ten, at the speed narration uses."); the heading.
  6. **Privacy policy:** the `cp_voice` row becomes "your chosen narration voice: one of 4a's voices (`kokoro:<id>`), or an identifier the device's own voice list reported".
  7. **New HUMAN-ACTIONS #119**, "Listen to a Foray in Heart, then Echo":

     **"Open the app once while you're online, so it fetches the latest Foray. With Heart selected, play 'How AI actually gets built' for a few clips; then switch to Echo in Settings → Narration voice and play a few more. Tell us how it sounds, whether narration ever starts late or stops mid-sentence, and paste Playback diagnostics."**
- **Files:** `player/foray-queue.js` (+ test), `player/queue-manager.js` (+ test), `player/parity/unported.json` (`queue-manager` section), `player/client.js`, `app.js`, `test/voice-settings.test.js`, `docs/legal/privacy-policy.md`, `HUMAN-ACTIONS.md` (#119).
- **Tests:**
  - queue-manager (a fake tts with `speakKokoro`/`prepareKokoro`):
    - "available + kokoro item + kokoro voice → speakKokoro with phonemes, vocab, voice id and no rate" (mutation: drop voice → red).
    - "available but not loaded → still speakKokoro (never system for loading)".
    - "vocab mismatch → speak(script) with the fallback voice, lastEngineFallback true".
    - "not available → system; a system call never carries a kokoro: id" (mutation: pass the kokoro: id through → red).
    - "forays false (warm RTF 2.5) → system voice, notice once".
    - "kokoroFailed after audio (incl. too-slow) → one system re-speak; later lines system".
    - "an item start prepares the NEXT narration item once".
    - "finished advances a Kokoro line exactly once".
    - "deadline: rtf undefined → finite, using 1.5; rtf 2 → stretched".
  - foray-queue: "est_sec wins over the char estimate"; "phonemes/tts copied, not shared".
  - client source pins: "applyVoice never hands a kokoro: id to engine setVoice"; "iOS Forays route to the legacy lane in native mode".
  - voice-settings:
    - "available: exactly the catalog voices, no Settings path text anywhere in the sheet" (mutation: render the allowlist → red).
    - "cold model: rows enabled, and Preview plays after load".
    - "nothing stored → Heart selected; a stored Apple id → Heart selected; stored kokoro:am_echo → Echo".
    - "Preview calls previewKokoro(id), never speak()".
    - "Preview never ends silent: {ok:false} → auditionVoice with the fallback voice + an inline reason".
    - "engine-absent → the existing system-voice sheet renders".
    - "other not-available → rows disabled + the fallback line".
    - "Web Speech path unchanged".
    - Existing allowlist tests keep running against the engine-absent sheet; the suite count does not drop.
  - app: "one notice per session" (vm harness, or a source pin if unreachable; the PR names which).
- **CI/device evidence:** `node --test player/parity/coverage.test.js` green; build number recorded. **Device (founder, HA #119):** a pasted diagnostics record showing `engine=kokoro` lines for both voices across at least 10 minutes, with underruns reported.
- **Dependencies:** KV-05, KV-03b, KV-02. **needs_phone:** yes.
- **Stop if:**
  - A bridge (transition) item needs phonemes. Bridges stay script-only in this deck.
  - `engine/m2` has merged and moved iOS Forays to the native lane. The legacy-lane pin test goes red; route to the native-engine owner (see KV-08).
- **PR:** `feat(player): Heart/Echo picker + Forays from item phonemes, honest fallback, lead buffer (K-05, KV-06)`.

### KV-07 · New Forays arrive phonemized: wire the stage — opus — S
- **Scope:** rev 2 KV-02, unchanged:
  - `phonemizeStage` runs between the last `stitch:<n>` and `finalize` in `runPipeline.ts`, through `runPhonemizer`. The stdin fix is KV-02's.
  - An absent backend publishes unphonemized items, which the player then speaks honestly in the system voice.
  - `FORAY_PYTHON` names the interpreter. The host default is the founder PC's venv (founder question 3).
- **Files:** `backend/src/generation/runPipeline.ts`, `backend/test/runPipeline.test.ts`, `test/suite-integrity.test.js` (`BACKEND_FLOORS`).
- **Tests:**
  - "phonemize runs between stitch and finalize".
  - "a phonemizer that answers stamps every narration page reaching finalize" (mutation: pass `items` → red).
  - "a refusing phonemizer leaves items the same references".
- **CI evidence:** `backend` job green; `npm run typecheck` clean.
- **Governance:** `backend/src/` is DENIED, so `needs-founder`.
- **Dependencies:** KV-02. **needs_phone:** no. It is off the critical path to the founder's first listen.
- **PR:** `feat(pipeline): phonemize stage wired between stitch and finalize (K-02, KV-07)`.

### KV-08 · Engine lane: Kokoro lines through SpeechNarrator (NE-42's seat) — opus — M
- **Owner of the lane gate:** the native-engine lane. **M2's Foray flip (iOS Forays onto the native lane) must not ship in a build before this card**, or it ships in the same build. Until then, KV-06's legacy-lane pin holds.
- **Scope** (lands after `engine/m2` merges to main):
  - **`ForayEngineCore`:**
    - `NarrationCommand.speak` gains `kokoro: KokoroFields?`, set when `voiceId` has the `kokoro:` prefix and the item node carries `tts.engine == "kokoro"`.
    - `KokoroFields {voice, vocab, phonemes: [field: String]}` copies every `phonemes*` string from the node. The core stays Foundation-only and never decides readiness.
    - The restore record's `voiceId` accepts `kokoro:` ids.
  - **`SpeechNarrator`:**
    - A new `KokoroOutput: SpeechOutput`, built on `KokoroSynth.shared` and one `PcmLinePlayer`.
    - Per line: Kokoro available, `forays` allowed, vocab match and catalog field present mean `KokoroOutput`. Otherwise the configured AVSpeech output speaks, with `pickDefaultVoice` and `started(voiceFallback: true)`.
    - Audition of a `kokoro:` id speaks the catalog preview.
    - The core's `prepare` for the next narration line calls `KokoroSynth.shared.prepare` (the D8 policy).
    - It never touches the session: `guardSession` runs as today.
  - **Client:** remove KV-06's `kokoro:` → fallback translation in front of the engine's `setVoice`, and lift the legacy-lane pin in the same PR as the M2 Foray flip.
  - **Other:**
    - `foray-audio/Package.swift` adds `.package(path: "../foray-tts/kokoro-synth")`. It is already in `NATIVE_BUILD_INPUTS` from KV-03a.
    - The parity fixtures record the routing on both sides: JS from KV-06, Swift here.
  - This card **is** NE-42's "PcmNarrator seat, reusing NE-33's PCM path". Mark NE-42's seat done and leave its CarPlay read APIs with NE-42.
- **Files:** `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Engine/{EngineCommand,EngineCore}.swift` (+ tests), `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/SpeechNarrator.swift` (+ `KokoroOutput.swift`, tests), `mobile/plugins/foray-audio/Package.swift`, `player/client.js`, `player/parity/fixtures/manager-foray/narration.json` (+ manifest), `docs/native-engine-plan.md` (NE-42 marker).
- **Tests:**
  - "kokoro voice + kokoro item → speak carries KokoroFields; a system voice → nil" (mutation: always nil → red).
  - "KokoroOutput finishes once, a stop never finishes, and `started(voiceFallback: false)`".
  - "vocab mismatch or forays false → AVSpeech output with voiceFallback true".
  - Parity `coverage.test.js`: zero unported in the family.
- **CI/device evidence:** `ios-kit` (`-scheme ForayAudio`, and the core's `swift test` on macOS and Linux), `engine-parity` and `ios-shell` all green. **Device:** the M2 drive script (NE-37) run with Heart selected. The founder's pasted engine report shows `speaker kind=kokoro` lines and no `implicit-activation` fault.
- **Governance:** `Package.swift` is DENIED, so `needs-founder`.
- **Dependencies:** KV-06, KV-03b, and M2 merged (`engine/m2` → main after NE-37/G-4). **needs_phone:** yes.
- **PR:** `feat(engine): Kokoro narration on the native lane via the shared synth (NE-42 seat, KV-08)`.

### KV-09 · Android: the same synth, the same three methods — opus — L
- **Scope:**
  - **`KokoroSynth.java`:**
    - A per-process singleton `OrtSession`, with the catalog read from assets and the generated `KokoroVocab.java` (from `gen-kokoro-vocab.mjs`, keyed by code point and iterated with `codePoints()`).
    - It splits on `"\n"`, uses style row `min(padded−2, 509)`, speed 1 and 80 ms gaps.
    - `LivePaceMeter` and `LeadPolicy` (with `foraysAllowed`) are ported, and warm RTF persists per (model, threads) in `SharedPreferences`.
    - The load waits the way iOS's does. The constants come from the catalog and are not duplicated.
  - **`PcmLinePlayer.java`:** one `AudioTrack` (USAGE_MEDIA, CONTENT_TYPE_SPEECH, 24 kHz mono `ENCODING_PCM_FLOAT`, `MODE_STREAM`), fed by a single-thread executor that renders at most 2 chunks ahead.
    - `finished` fires once, after the last write and after `getPlaybackHeadPosition()` reaches the total frames.
    - Stop means pause, flush, stop, with no finish.
    - Pause and resume are real.
    - Audio focus is handled exactly as `speak` handles it today.
  - **`ForayTtsPlugin.java`:** `@PluginMethod` `kokoroState`, `speakKokoro` and `prepareKokoro`. Payloads, refusals (the same `KokoroRefusal` strings), events (`kokoroState`, `kokoroFailed`, `finished`) and the too-slow floor match iOS byte for byte. The JS is already shared, so nothing else changes.
  - The Android probe is already gone (KV-13).
- **Files:** `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/{KokoroSynth,PcmLinePlayer,KokoroVocab,ForayTtsPlugin}.java`, `tools/mobile/gen-kokoro-vocab.mjs` (Java output), `tools/mobile/foray-tts-native.test.mjs` (Android block). `build.gradle` is untouched: ORT is already a dependency.
- **Tests (Node pins; no JUnit exists under `android/`):**
  - "KokoroVocab.java is generated, `--check` clean, and keyed by code point".
  - "the Java tokenizer iterates codePoints()" (mutation: `charAt` → red).
  - "PcmLinePlayer uses ENCODING_PCM_FLOAT".
  - "one `notifyListeners("finished"` on the Kokoro path, none inside the chunk loop" (mutation: per chunk → red).
  - "the three `@PluginMethod`s exist with the iOS names".
  - "the refusal strings equal `KOKORO_REASONS`".
  - "no GPL needle in any Kokoro Java file" (the walk extends to them).
- **CI/device evidence:** `android-shell` green with weights injected. **Device:** Joey's Pixel 10 Pro runs HA #45's sample steps (three `voiceSample` rows) and a Foray listen.
- **Dependencies:** KV-04 and KV-03b (the contract), KV-05 (an iOS `voiceSample` row exists first: iOS first), KV-06 (Forays route through the shared JS). **needs_phone:** yes.
- **Model:** q8f16 (D13). **The fp16 NaN risk applies here:** q8f16 went non-finite on ARM64 Apple silicon (§10), and nobody has run it on an ARM Android phone. The first device step is a finiteness check on the Pixel (a chunk with any non-finite sample is a failure, as on iOS).
- **Stop if:** float `AudioTrack` construction throws on the device. Log it and do not silently switch encodings. **Also stop if q8f16 renders non-finite samples on the Pixel:** Android then needs fp32, which is KV-14 (Play Asset Delivery or an on-demand download), not a bundled swap.
- **PR:** `feat(foray-tts android): Kokoro synth + AudioTrack player, same contract as iOS (K-04, KV-09)`.

### KV-12 · Retire the native system-voice allowlist sheet (after Android) — qwen — XS
- **Scope:** once both platforms implement Kokoro, delete from the native path `VOICE_ALLOWLIST`'s trial set, `VOICE_SETTINGS_PATH`, the greyed-row code and the `engine-absent` system-voice sheet. `engine-absent` then renders like any other not-available reason (disabled rows plus the fallback line). The Web Speech path is untouched.
- **Files:** `app.js`, `test/voice-settings.test.js`.
- **Tests:** "no Settings path text in the native sheet for any state"; the allowlist tests are retargeted or replaced one for one, and the count does not drop.
- **Dependencies:** KV-09. **needs_phone:** no.
- **PR:** `chore(app): retire the Apple-voice allowlist sheet on the native path (KV-12)`.

### KV-10 · Records and notices — opus — S
- **Scope:**
  - **`docs/DECISIONS.md`** (DENIED): one entry, "2026-09-26 — bundled voices: Heart (default) and Echo; British later". It quotes both founder messages verbatim, records D1–D13 in one line each, supersedes deck §6's three-voice audition and rev 2's ranking cards, and cites the KV PRs.
  - **`docs/legal/third-party-notices.md`:**
    - Voice data: exactly two bundled voices, `af_heart` and `am_echo`, 522,240 B each. This fixes "~130 KB each" and "twelve… three".
    - ORT: measured ~11 MiB per ABI (~42.8 MiB for four). This fixes "~10–20 MB".
    - Kokoro weights stay Apache-2.0, with the NOTICE reproduced.
    - The misaki (Apache-2.0) and espeak-ng (GPL-3) lines stay under "What is deliberately NOT here": tools run on the PC or server, whose output (phonemes) is data.
  - **`docs/research/on-device-tts.md` §10:** the KV-R0 row (could not measure), the KV-R2 per-pass rows and the ARM64 sweep summary (this deck's §10), the KV-05 and KV-09 `voiceSample` rows with device and OS, the verdicts, and the thread A/B result. If the A/B favours 2 threads, open a one-line catalog data PR, which ships in the next build.
  - **Deck markers:** `bundled-voice-plan.md` K-01, K-02, K-04 and K-05 marked with PRs.
  - **HUMAN-ACTIONS:** close #45 once the samples are in. Close #40 (download an Enhanced Apple voice) as moot, with a pointer here.
  - **`STATE.md`** entry.
- **Files:** as listed.
- **Tests:** `node --test "test/*.test.js"` (legal and copy invariants).
- **Governance:** DECISIONS is DENIED, so `needs-founder`.
- **Dependencies:** KV-05, KV-06 (KV-09's rows are appended when they arrive). **needs_phone:** no.
- **PR:** `docs(voice): Heart+Echo decision, notices, §10 readings (K-07, KV-10)`.

### KV-11 · LATER (roadmap, not scheduled): British voices, Isabella and Lewis
- **Trigger:** the founder says go, after KV-06's Foray listen (his words: "put british on the roadmap… upgrade it later").
- **Scope, in one paragraph:**
  - Pin `bf_isabella` and `bm_lewis`, hashed fresh at that time.
  - Add `phonemize.py --accent en-GB` (misaki British plus the British espeak fallback, PC/server only) and an optional lexicon `ipa_gb`.
  - Stamp `phonemes_gb` on narration items with the same chunk rule and vocab sha (verify every code point), and have check-forays and `AUTHORED_PHONEME_FIELDS` cover it.
  - Add `accents["en-GB"] = {field: "phonemes_gb"}` and two catalog entries.
  - Player, synth and picker code do not change; that is D5's point.
  - The seed strip from KV-02 already absorbs the second phoneme string.

  Sized and specified when triggered. **needs_phone:** yes.

### KV-14 · LATER (not scheduled): Android on fp32 via Play Asset Delivery or an on-demand download
- **Why it exists:** D13 keeps Android on q8f16 because Play's base-module size limit will not take the 325.5 MB fp32 model, and q8f16 carries the same fp16 NaN risk on ARM that ruled it out on iOS (§10).
- **Trigger:** KV-09's Pixel finiteness check fails, or the founder asks for Android parity with iOS.
- **Scope, in one line:** deliver fp32 to Android outside the base module (an install-time or on-demand asset pack, or a pinned first-run download with the same sha256 check), with the D7 fallback while it is absent. Sized and specified when triggered. **needs_phone:** yes (Joey's Pixel).

## 5. Sequencing

```
Done:              KV-R0 (2026-09-26, build 2026092602: could not measure, inference-threw)   KV-R1 superseded
Day 0 (parallel):  diag/ voice-probe lane (error text, ORT version, provider, finiteness)
                   → KV-R2 (probe v2: fp32 on iOS, CPU vs CoreML, sentence chunks; needs-founder) → build → FOUNDER: HA #45
                   KV-00 (docs)   KV-01 (pins+catalog, needs-founder)   KV-03a (Swift package, needs-founder; starts now)
                   → overlord applies §6a to KV-R2's rows before KV-03a merges
Then:              KV-02 (after KV-01 + #844 merged; seed strip, needs-founder)
                   KV-13 (probe retired; after KV-R2 + KV-03a)    KV-04 (after KV-03a, KV-01; KV-13 soft)
Then:              KV-05 (Read a sample) → build → FOUNDER: HA #45 rewritten (three rows)   ← "can they narrate at a live pace?"
                   KV-03b (after KV-04, parallel with KV-05)
Then:              KV-06 (picker + Forays, one PR) → build → FOUNDER: HA #119 (listen)        ← "have them read a Foray"
Off-path:          KV-07 (pipeline stage, after KV-02)
When iOS has a row: KV-09 (Android, q8f16; finiteness first) → Joey: HA #45 on the Pixel → KV-12
When M2 merges:    KV-08 (engine lane). GATE: M2 must not move iOS Forays to the native lane before KV-08 (owner: native-engine lane)
Last:              KV-10 (records)          Later: KV-11 (British), KV-14 (Android fp32 delivery)
```

**The first valid phone RTF is KV-R2's** (KV-R0 could not measure). The critical path to the first live-pace reading **in 4a's own player** is **KV-01 ∥ KV-03a → KV-04 → KV-05**, with KV-02 in parallel. KV-03b and the cross-line lead are off that path.

File overlaps are serial by construction:
- `app.js`: KV-13 (switch), then KV-05, then KV-06, then KV-12.
- `client.js`: KV-13, then KV-04, then KV-06, then KV-08.
- `tts-bridge.js` / `foray-tts.js` / `ForayTtsPlugin.swift`: KV-13, then KV-04, then KV-03b.
- `foray-tts/Package.swift`: KV-03a, then KV-13.
- `foray-tts-native.test.mjs`: KV-03a, then KV-13, then KV-04, then KV-03b, then KV-09.
- `release-gates.test.js`: KV-R2 (size gate per platform), KV-01 and KV-03a edit different blocks; whichever lands later rebases.
- `prepare-webdir.mjs`: KV-02 (seed strip) and KV-13 (passage entry); the second rebases.
- `fetch-models.mjs` / `inject-models.mjs`: KV-R2 (per-platform `bundle`, fp32 pin), then KV-01 (Echo, catalog).
- `phonemize.py`: KV-R2 (`sentence_chunks`), then KV-02 (wires it in); if KV-02 goes first, KV-R2 reuses its function.
- `KokoroOrtProbeEngine.swift`: the `diag/` lane, then KV-R2, then KV-13 (deletes it).
- `kokoro-voices.json`: KV-01, then KV-02.
- `privacy-policy.md`: KV-13 (`cp_voice_probe` row), then KV-06 (`cp_voice` row).
- `unported.json`: KV-04, KV-03b and KV-13 use the `tts-bridge` section in that order; KV-06 uses `queue-manager`.

## 6. Triggers (written before the readings, so they cannot be read generously)

### 6a. Probe v2 reading (KV-R2, before KV-03a merges)

KV-R0's row (`could not measure: synthesis-failed/inference-threw`) took this table's last row: a build fault, routed to the `diag/` lane and KV-R2. The table now applies to KV-R2's rows. It was written before any KV-R2 run.

**The go rule is stated on warm RTF over sentence-sized chunks** (synthesis ÷ audio for every chunk after the first), with D8's lead buffer as designed: 2 chunks streamed ahead within a line, and the whole next line prerendered during the preceding clip when warm RTF > 0.8 (capped at 120 s of audio). **Only a finite pass counts.** Of the two passes, the faster finite one sets the catalog's provider; within 10% of each other, CPU wins (fewer moving parts).

| Best finite pass: warm RTF over sentence chunks, fp32, the founder's iPhone | What happens |
|---|---|
| ≤ 0.8 | Live. KV-03a takes that pass's provider and threads; LeadPolicy is expected to render first chunks only. |
| 0.8 – 2.0 | Go. D8's full-line prerender carries Forays; KV-05's thread A/B tunes it. |
| > 2.0 | The Swift work proceeds (it is model-agnostic), but on that phone Forays use the system voice by D8a; Preview and the sample still play Heart/Echo. There is no smaller finite variant to fall back on (§10). Anything beyond that is founder question 1 (default applied unless the founder objects). |
| No pass finite | fp32 is broken on the phone too. Stop: KV-03a does not lock a model, and the error text and finiteness counts go to the native-engine owner. |
| `could not measure: …` (either pass) | A build fault. The error text in the row routes the fix; KV-13 waits. |

**Peak memory** is recorded, not gated here: it sets KV-05's memory bound (replacing the q8f16-era 400 MB). If the app is killed during a pass, that is a stop, and `max_chunk_phonemes` is the first lever, since activation memory scales with chunk length.

### 6b. Read a sample (KV-05 `voiceSample`, warm RTF on the founder's iPhone)

| Reading | What happens |
|---|---|
| ≤ 0.8, 0 underruns, TTFA ≤ 1.5 s | Live. KV-06 ships. The lead policy renders only first chunks. |
| 0.8 – 1.5 | Forays rely on D8's full-line prerender. KV-06 ships unchanged; the founder's HA #119 listen is the check. |
| 1.5 – 2.0 | Forays still use Kokoro with prerender. The thread A/B row picks the catalog's threads (a data diff that ships in the next build). If KV-R2's other provider pass was finite and within reach, it gets a one-line catalog data PR. There is no re-pin option: no smaller finite fast variant exists (§10). |
| > 2.0 (`max_foray_rtf`), or underruns in a real Foray | Automatic: on that phone, Forays speak in the system voice (D8a) while Preview and the sample still use 4a's voices. Options: (a) stay on the system voice for Forays on that device (founder question 1's default, applied unless the founder objects); (b) the other KV-R2 provider pass, if it was finite; (c) shorter chunks via `max_chunk_phonemes`. **fp16 and q8f16 are ruled out on iOS** (non-finite on ARM64, §10), and int8 `model_quantized` is too slow (RTF ~1.8 on ARM64). The CoreML EP was already measured by KV-R2; there is no separate K-08 card in this deck. |
| `could not measure: …` | A build fault. The named reason routes the fix, as with the probe. |

## 7. Revision-2 cards, mapped

| Rev 2 | Fate in rev 3 |
|---|---|
| KV-01 stdin fix + batch tool | Folded into KV-02 |
| KV-02 pipeline wiring | KV-07 |
| KV-03 lexicon mutation test | Folded into KV-02 |
| KV-04 vocab tables (JS/Swift/Java) | Swift in KV-03a, Java in KV-09, both keyed by code point. **No JS table:** the manager compares `kokoroState().vocab` |
| KV-05 JS phoneme chunker | **Dropped:** chunks are authored (D3) |
| KV-06 web plugin + bridge | KV-04 (+ `prepareKokoro` in KV-03b) |
| KV-07 foray-queue; KV-08 manager routing; KV-09 client/notice | KV-06 |
| KV-10 picker re-scope | KV-06 (picker), KV-05 (Developer sample), KV-12 (allowlist retirement) |
| KV-11/12/13 iOS engine, narrator, methods | KV-03a + KV-03b + KV-04 (one package, one player) |
| KV-14/15/16 Android | KV-09 |
| KV-17/18/19 audition page, render, bundle three | **Dropped:** the founder picked by ear; bundling is KV-01 |
| KV-20 HA #45 → §10 | KV-R0 (done; could not measure) + KV-R2 (probe v2 reading) + KV-05 (sample reading) + KV-10 (record) |
| KV-21 K-08 accelerator | Measured as KV-R2's CoreML pass (fp32 has no `ConvInteger`); the winning provider is a catalog value |
| KV-22 NE-42 PcmNarrator seat | KV-08 (the seat is `KokoroOutput` in NE-33's SpeechNarrator, on the shared player) |
| KV-23/24 records, DECISIONS | KV-10; probe retirement is KV-13 |

## 8. Non-goals (this deck)

- Pre-rendering whole Forays off the phone (the founder: "Don't render entire Forays").
- On-device G2P for arbitrary text.
- British voices before KV-11.
- Accelerator work beyond KV-R2's CoreML measurement pass (and NNAPI on Android).
- Bundling a model that does not fit the 150 MB ceiling **on Android**. iOS bundles fp32 over the ceiling for TestFlight only (D13); a public store launch, and the size work it needs, is out of scope.
- Speaking bridges (transition items) in Kokoro. They stay script-only.
- CarPlay.
- Playback speed other than 1x.

## 9. Review changes in this revision

| Review problem | Where it is fixed |
|---|---|
| Phone RTF measured last | KV-R0 on Day 0 (HA #45 as written), §6a, citation corrected to #686 / `b669a043`; HA #45 rewritten only after the reading (KV-05). **Rev 3.1:** KV-R0 ran and could not measure; KV-R2 carries the phone reading |
| "> 1.5" row not viable | KV-R1 PC sweep; §6b lists only options that fit the ceiling; fp16 bundling ruled out; K-08 gated on the op profile. **Rev 3.1:** KV-R1 superseded by the ARM64 sweep and KV-R2 (§10); §6b's options rewritten |
| No per-device floor | D8a `max_foray_rtf` 2.0, `forays`/`too-slow` (KV-03b), mid-line abort, the queue-manager test "warm RTF 2.5 → system voice, notice once" |
| Picker/boot readiness race | D9 available vs loaded; `speakKokoro`/`prepareKokoro` wait for the load; `kokoroState` event (KV-04); routing on available (KV-06) |
| Preview can go silent; refusal names inconsistent | D7 + KV-06 Preview fallback to `auditionVoice`; one `KokoroRefusal` enum mirrored as `KOKORO_REASONS` and pinned equal |
| Two session owners in native mode | D12; KV-04 relinquishes or refuses (`engine-busy`), with a source-pin test; the stop-if covers both lanes |
| The picker lies if KV-05 ships first | KV-05 shrunk to the sample; the picker moves into KV-06 (one PR); the `kokoro:` guard before `speak()` and engine `setVoice` |
| Android regresses before KV-09 | `engine-absent` keeps today's sheet (KV-06); allowlist deleted in **KV-12** after KV-09. Moved out of KV-10 so the records do not wait on Android |
| Chunk rule differs from what the founder heard | D3 unconditional; `render-audition.py` imports `sentence_chunks`; #844 merges first; reference re-render; HA copy warns about pauses |
| Grapheme vs code point (U+0303) | §1/§3 scalar iteration, `[UInt32: Int]`, Java `codePoints()`, `[...s].length`, U+0303 oracle test |
| GPL gate misses the new package | KV-03a adds both Package.swift files to `NATIVE_BUILD_INPUTS` plus a full kokoro-synth walk; KV-01 adds the catalog; KV-09 adds the Java files |
| The probe adapter doubles memory | No adapter; **KV-13** deletes the probe after KV-R2 (a separate card, because KV-03a starts before the reading is in); KV-04 guard if KV-13 is late |
| Critical-path cards too big | KV-03 split into KV-03a (the sample needs it) and KV-03b (lead/prepare, before KV-06); `prepareKokoro` moved to KV-03b |
| Thread default unjustified | Catalog default 4 (the PC's measured winner); Developer Threads A/B in one founder session; "data diff, but ships as a build" |
| AVAudioEngine in CI tests | `PcmSink` seam, fake sink in tests, source pin against `AVAudioEngine(` in Tests |
| Seed budget stop is predictable | KV-02 plans the seed strip (needs-founder) plus a boot-refresh test; HA #119 says "open once online" |
| engine/m2 race voids KV-06 acceptance | KV-06 legacy-lane pin test; the §5 gate; KV-08 names the owner and lifts the pin with the M2 flip |
| Deadline NaN | `narrationDeadlineSec(item, rate, rtf = null)`, 1.5 when unmeasured, two tests |
| Test theater and scope creep | Literal-pair test dropped (hashes in the PR body); KV-11 cut to one paragraph with the British hashes removed; `APK_WITH_MODEL_BYTES` re-measured with a run id |

## 10. Measured after revision 3 was written (amendment, 2026-09-26)

### 10a. KV-R0: the phone could not measure

- **Run:** the founder, HA #45 as written, build 2026092602 (web `b5f3c92ba13f6984`), 2026-09-26 23:44 UTC.
- **Row:** `voiceProbe kokoro-probe could not measure: synthesis-failed/inference-threw  load 457ms/374ms  peak 280.3MB`. Every line threw.
- **What the paste cannot say:** why. The ORT error text is written only to `os_log` (`KokoroOrtProbeEngine.swift` ~line 261, the `catch` that returns `inference-threw`). A separate in-flight lane (branch prefix `diag/`) adds the error text, the ORT version, the provider and output finiteness to the probe record. This deck references that lane and does not implement it.
- **The founder's "can you run HA #45 today" question is answered:** he ran it.

### 10b. The ARM64 sweep: q8f16 is not usable on Apple silicon

- **Setup:** GitHub `macos-14` arm64 VM (3 vCPU), ORT 1.20.1 Python (1.22.0 as a cross-check), the probe's 4-line passage, `af_heart`. Branch `probe/kokoro-arm64`; runs 36280828928, 36281480135 and 36282008323.
- **The x86 PC is not representative.** The founder's x86 PC (ORT 1.20.1 Python) renders the same passage ids on the pinned q8f16 model fine. So PC sweeps rank nothing for the phone, and KV-R1 is superseded.

| Export (onnx-community Kokoro-82M-v1.0-ONNX) | Size | Finite on ARM64? | CPU RTF (synthesis ÷ audio) | Verdict |
|---|---|---|---|---|
| `model_q8f16` (the one we ship) | 86 MB | **No:** NaN samples on 1–2 of 4 lines, CPU and CoreML EP alike; which lines varies by ORT version (1.20.1 vs 1.22.0) | n/a | Unusable on Apple silicon |
| `model_fp16` | 163 MB | **No:** same pattern as q8f16 | n/a | Unusable |
| `model.onnx` (fp32) | 325.5 MB | Yes, every line | **0.78–0.98** across runs | **Chosen for iOS (D13).** Peak RSS ~1.3–1.4 GB on a 417-token line: activation memory scales with line length, so sentence chunks matter for memory too |
| `model_quantized` (int8 dynamic, fp32 activations) | 92 MB | Yes | ~1.8 (`ConvInteger` is slow on ARM) | Too slow for live pace |
| `model_q4` | 305 MB | Yes | ~1.0 | Barely smaller than fp32, and no faster |
| Home-made MatMul-only int8 of fp32 | 289 MB | Yes | 0.89–1.18 | Conv weights dominate the size; no gain |

- **No small, finite, fast variant exists.** Every finite export near real time is about 290–326 MB.
- **CoreML EP numbers on a VM mean nothing** (no Neural Engine). Only the phone can say, which is KV-R2's CoreML pass.

### 10c. What changed in the deck because of 10a and 10b

- **D13 (new):** iOS bundles fp32 `model.onnx`, pinned by KV-R2 (url, sha256 and bytes computed from the download). Android stays on q8f16 for now, with the same NaN risk noted; Android fp32 is KV-14 (LATER), because Play's base-module limit will not take 325 MB. TestFlight only; a public store launch is out of scope.
- **KV-R2 (new) replaces KV-R1** and gates KV-03a's model, provider, thread and lead-buffer choices (§6a).
- **Size arithmetic:** the Android numbers (`APK_WITH_MODEL_BYTES` = 137,468,845 B, the 150 MB ceiling) still describe Android. The iOS figure is re-measured by KV-R2, the card that pins the new model; it projects to about 330 MiB.
- **Corrected where the deck assumed q8f16 on iOS:** §1, D4, D5, D9, D10, D11, KV-01's catalog header, KV-03a, KV-04's `provider`, KV-05's memory bound, KV-13, §6a, §6b, §8.
- **Founder questions:** the HA #45 question is answered and removed. The defaults for founder question 1 (a phone too slow for live Forays uses its own voice for Forays), question 3 (new Forays are phonemized on the founder PC's venv) and question 4 (Heart takes over from a stored Apple voice) are **applied unless the founder objects**.
