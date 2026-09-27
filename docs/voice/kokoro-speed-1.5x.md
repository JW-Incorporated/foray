# Kokoro narration fast enough for 1.5x listening

**Status:** research synthesis, 2026-09-26. Four research lenses (ONNX tuning, Apple frameworks, architecture, prior art) measured on GitHub arm64 macOS VMs and surveyed what already ships on iPhones. Nothing here is built yet. Parent deck: `docs/kokoro-voices-in-app-plan.md` (D7, D8, D8a, D13, KV-R2).

**The founder's ask:** *"I'm hoping to listen to forays on 1.5x speed, we can't but taking >1x clock time to get the narration."*

**Short answer:** other apps have already solved this. Kokoro runs on iPhones at about 17–21x real time through a 7-stage **Core ML** split that puts most of the model on the Neural Engine (laishere/kokoro-coreml, productized in FluidInference/FluidAudio, both Apache-2.0). That chain takes the same token ids and `af_heart` matrix we already produce. The split also fixes our fp16 NaN problem at its root. Two cheap changes help any engine: render at Kokoro's own `speed` = the listening rate, and set the thread count explicitly. Only the founder's phone can confirm the result (probe v3, §5).

---

## 1. The goal in numbers

- **RTF** = synth seconds / audio seconds. Every figure here is on the **content basis**: synth seconds divided by the audio length **at speed 1.0** of the same text, so renders at speed 1.5 compare directly with renders at 1.0.
- To listen at 1.5x, live synthesis must run at **content RTF ≤ 0.667**, or **≤ ~0.55 with margin**, and hold that on a locked, warm phone.
- **The target is an average, not a peak.** Across our Forays, narration is 24–43% of content time; the rest is streamed clips, during which the synthesizer can work ahead. A Foray-level render-ahead simulation on `data/forays.json` (arch lens) found no stalls at 1.5x even at an effective RTF of 0.73, as long as 35 s of narration content was rendered before Play. At an effective RTF of 1.19 it needs 61 s.
- **Two limits apply while the phone is locked:**
  - *CPU monitor.* iOS kills a background app, even one playing audio, that uses more than ~80% of one core's CPU time over 60 s. That figure comes from field logs; Apple does not document it ([forum 123975](https://developer.apple.com/forums/thread/123975)).
  - *No GPU in the background.* iOS blocks Metal work from background apps ([Apple doc](https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background)).
- **Where we started:** the deck's §10 RTF of 0.78–0.98 (fp32 ORT). That reading turned out to be a **single-thread** number: ORT on Apple resolves `threads=0` to `hardware_concurrency()/2`, which is 1 thread on the 3-vCPU VM.

## 2. Adversarial check of the lens numbers (read before trusting the table)

| # | Issue | Consequence |
|---|---|---|
| 1 | **VM noise is large.** Across the three lenses, ORT fp32 at 3 threads and speed 1.0 measured anywhere from 0.37 to 0.52. The FluidAudio Core ML CPU route measured 0.155 on one run and 0.068 on its rerun. The same Core ML models through coremltools CPU_ONLY measured 0.26–0.36. | The table quotes ranges, not single values. Only interleaved A/Bs in one job, or the phone itself, can rank close options. |
| 2 | **The iPhone Neural Engine (ANE) figures are cited, and all at speed 1.0.** For example, laishere reports 16.9x on an iPhone 16 Pro (README checked 2026-09-26). The speed-1.5 ANE figures in the table are **derived**: cited value × the measured 0.57–0.72 speed factor. | Nobody has measured the ANE at speed 1.5 on a phone. |
| 3 | **Jon-Schneider/kokoro-coreml-ane** reports the same "16.9x on iPhone 16 Pro" as laishere. | It is probably a copy of laishere's result, not independent evidence. The independent confirmations are FluidAudio #844 (iPhone 17 Pro Max, 18.5–21.4x) and soniqo/speech-swift (iPhone 16 Pro, RTF 0.08). |
| 4 | **"The ANE doesn't count against the CPU monitor"** is an inference. The claim that Local Narrator *synthesizes* while locked is also unverified; its listing shows only that it *plays* in the background. | Probe v3 must run the ANE route with the screen locked. |
| 5 | **iOS floor, hidden cost.** FluidAudio as a SwiftPM dependency forces `foray-tts`'s Package.swift to iOS 17: SwiftPM refuses a dependency whose floor is above the package's, and Package.swift is a founder-gated path. The laishere mlpackages are also built for iOS 17. mattmireles, soniqo and the MLX ports need iOS 18. | Vendor the chain behind `if #available(iOS 17, *)`. The app floor stays at iOS 15, and D7 remains the fallback below 17. |
| 6 | **Licences.** Nothing in the recommended path ships GPL: laishere is Apache-2.0 (its HF card says MIT; both are permissive), FluidAudio is Apache-2.0 plus fastcluster (BSD), and the weights are Apache-2.0. Excluded: Piper's current code (OHF-Voice/piper1-gpl, GPL-3.0). Kitten TTS pulls in espeak (fine on the server only). Supertonic's model is OpenRAIL-M, which carries use restrictions. The laishere converter needs espeak/misaki, but only in CI, the same as `phonemize.py` today. | FluidAudio's "GPL dependencies: None" is the project's own statement. If we depend on it rather than vendor, audit its transitive dependencies in the PR. |
| 7 | **Memory.** The fp32 ORT peak on the VM is 1.1–1.3 GB (ORT 1.20; about 0.8–0.9 GB on 1.24+). The founder's phone diagnostics showed **1,104 MB available**. The ORT CoreML EP peaked at 2.2 GB. The VM figures include Python's overhead, but not by much. | fp32 ORT on his phone is a real jetsam risk. Probe v2/v3 must record `phys_footprint`. |
| 8 | **FluidAudio 0.17.4 crashed (SIGBUS on first synthesis) on a macOS 15.7 VM**, on every compute route. It ran cleanly on macOS 26. The same models ran fine on macOS 15 through coremltools. | The founder runs iOS 18.6.2. The crash may be in FluidAudio's Swift path rather than the models, but only a phone run can clear it. This is another reason to vendor the chain rather than take the whole package. |
| 9 | **Known Core ML runtime crashes.** libBNNS SIGSEGV on iOS 26.4–27.0 on A19-class phones, on every route including cpuOnly (FluidAudio #587, #844, #889; #889 was closed as "not planned"). **iOS 27** also requires the `com.apple.developer.background-tasks.continued-processing.inference` entitlement for *any* ANE use while backgrounded. | The founder's A16 on iOS 18.6.2 is outside the crash reports. The public app will not be, so it needs crash-arming plus a CPU-only route for the background. |
| 10 | **The existing ruling (DECISIONS 2026-09-24 #3):** "narration plays at 1×". The founder added: *"1x for now, but maybe we change later … 1x felt like 0.6x."* | Rendering at the listening rate amends that ruling. The founder decides after an ear check (card S1). |

## 3. Options, ranked

"iPhone RTF @1.5x" means the expected content-basis RTF when listening at 1.5x. For native options that means rendering at `speed=1.5`. **M** = measured on the arm64 VM, **C** = cited from a phone, **D** = derived by us.

| Rank | Option | iPhone RTF @1.5x, foreground / locked | Effort | Main risk | Quality cost | Evidence |
|---|---|---|---|---|---|---|
| **1** | **Core ML 7-stage chain (laishere), vendored as a second backend, rendering at `speed` = the listening rate.** The ANE runs it in the foreground; all stages go to `.cpuOnly` when backgrounded. | **~0.03–0.05 (D)** / **~0.04–0.25 (D)**. The locked figure is the VM's Core ML CPU range × 0.7. | M | A16 ANE compile unproven. BNNS crash class on iOS 26.4+. iOS 27 background-ANE entitlement. iOS 17 gate. | fp16 + int8 palettization; Noise and Tail stay fp32. DTW mel-corr 0.9916 vs PyTorch (ORT fp32: 0.9986). About 1% timing drift. Nobody has listened yet. | C: laishere README (iPhone 16 Pro, 0.050–0.059); FluidAudio #844 (17 Pro Max, 0.047–0.054); #587 (17e, ~0.05 on ANE). M: runs 36296161379, 36297751878, 36296250397, 36297443797 (all finite, 15/15 chunks). |
| 2 | **The same chain via the FluidAudio SwiftPM package** (`KokoroAneManager.synthesizeFromPhonemesDetailed`). | Same as 1 | S | Forces `foray-tts` to iOS 17. Large package (ASR, diarization, NeMo). SIGBUS on macOS 15. Downloads models from HF by default. | Same as 1 | FluidAudio v0.17.4 (Apache-2.0, iOS 17, 2.9k stars). Shipping apps: Local Narrator, SchriftOhr. |
| 3 | **Keep fp32 ORT on the CPU:** render at `speed` = the listening rate, set threads explicitly (2), move to ORT 1.24.2, and add a Foray-level render-ahead worker. | **~0.26–0.36 (M, 2–3 threads)** / **~0.73 effective (D)**: duty-cycled to 70% of one core, which relies on a 35 s lead. | S–M | Memory 1.1–1.3 GB vs the 1.1 GB available. Thermal load. The 325 MB bundle keeps D13 at TestFlight only. | None (fp32 reference) | M: runs 36295880639, 36297340312, 36298886440, 36296250397. Two threads cost 0.51 CPU-s per content second at speed 1.5; three or four threads burn about 40% more CPU for no gain. |
| 4 | **fp16 mixed-precision ONNX export**: SineGen and the harmonic source stay fp32 (49 nodes), and the converter's Cast pairs are stripped. | Same as 3 (not faster on the CPU) | M | Needs a reproducible export pinned in CI. Phone finiteness unproven. | About 1 dB mel vs fp32, below the 5 ms-shift floor. Nobody has listened yet. | M: run 36299741863 (0/34 non-finite, 163 MB). This is the size fix *if* we stay on ORT. |
| 5 | **Render at 1.0 and time-stretch with AVAudioUnitTimePitch** (no model change). | 0.37–0.52 at speed 1.0 (M) / ~1.19 effective (D) | S | Fails while locked unless there is a large lead (~61 s). No compute saving. | Phase-vocoder artifacts at 1.5x | M: stretching costs 0.0015 CPU-s per content second (run 36296196351). |
| 6 | Other Core ML ports: mattmireles (buckets, iOS 18) and soniqo/speech-swift (iOS 18, 128-phoneme cap). | 0.15–0.3 (D from C) / GPU route stalls when locked | L | iOS 18 floor. mattmireles runs mostly on the GPU on iPhone. The 30 s bucket OOMs on iPhone 12 Pro. | fp16 end to end | C: mattmireles HF card (15 Pro Max RTF 0.21, 12 Pro 0.42); soniqo `docs/benchmarks/ios-coreml.md` (16 Pro, 0.08). |
| 7 | MLX Swift on the GPU (mlalma/kokoro-ios, Sandbook). | ~0.2 (D) / **cannot run** | M | Metal is barred in the background, which rules this out for a locked phone. iOS 18. | Near reference | C: iPhone 13 Pro 3.3x. |
| 8 | ORT's CoreML EP on the whole graph (probe v2's second pass). | ≥ ORT CPU / ≥ ORT CPU | S | 129 partitions, 2.2 GB peak, and ORT 1.30 throws. **Dead end.** | None | M: run 36296161379 |
| — | Floors only, each needing a founder ruling: pre-render on a server (about $0.01 per Foray hosted, or free on the GPU box), or a smaller voice (Kitten nano 0.16 at speed 1.5). | n/a | S–M | Contradicts "don't render entire Forays". Gives up Heart and Echo. | High (voice change) or none (server) | M: run 36296196351 |

Measured and dropped: chunk-length tuning (RTF is flat across lengths; long chunks only add memory), graph-opt/mem-pattern/parallel knobs (within ±5%), XNNPACK (it only supports 2-D conv, and Kokoro's convs are 1-D), and int8 (RTF ~1.8).

## 4. Recommended path

Adopt the prior art (option 1) instead of building our own vocoder split. Ship the cheap ORT wins (S3, S4) now, because they are the fallback and they give the founder 1.5x soonest if the ANE route fails on his phone. The founder-gated paths (`fetch-models.mjs`, `inject-models.mjs`, `Package.swift`) need his approval wherever a card touches them.

**S1 · Founder ear check (no build; do it now, some artifacts expire).**
- Kokoro `speed=1.5` vs a 1.5x time-stretch: artifact `ab-listen-kokoro-speed1.5-vs-timepitch1.5` in [run 36296196351](https://github.com/JW-Incorporated/foray/actions/runs/36296196351).
- Core ML chain vs ORT vs PyTorch: `kokoro-l2-wavs` in run 36297751878. **It has 7-day retention.**
- fp16 mixed vs fp32: `fp16-wavs` in run 36299741863.
- *Accept:* the founder rules (a) whether narration follows the listening rate through `speed`, amending the 2026-09-24 ruling #3, and (b) whether the Core ML voice is acceptable.

**S2 · Probe v3 on the founder's phone (§5).** This decides between option 1 and option 3.
- *Accept:* one probe record per pass, with every §5 field filled, and HA #45 re-issued for the build.

**S3 · Narration follows the listening rate (engine-agnostic, S).**
- `KokoroSynth` takes `speed` = the listener's rate (clamped to 0.5–2.0).
- Cache keys include `speed`.
- On a mid-Foray rate change, cached buffers play through AVAudioUnitTimePitch at `new/cached` and later chunks re-render at the new rate.
- *Accept:* a speed-1.5 render is 0.63–0.67x the length of the speed-1.0 render. The meter logs content-basis RTF. A unit test covers the rate-change patch.

**S4 · ORT quick wins (S).**
- Set `intra_op_threads` explicitly. Default to 2 while locked; in the foreground, use whichever of 2/3/4 wins on the phone.
- Run the session from a `.userInitiated` queue.
- Bump ORT from exact 1.20.0 to exact **1.24.2**. It is still iOS 15, and peak memory drops 22–28%.
- *Accept:* the probe v3 ORT pass is finite, with content RTF ≤ 0.45 at speed 1.5 and peak `phys_footprint` below the phone's available memory.

**S5 · Core ML backend (M).**
- Vendor laishere's `iOSDemo/KokoroEngine.swift` pattern (~160–200 lines) as a `KokoroSynth` backend behind `#available(iOS 17, *)`.
- Take the stage routing and crash workarounds from FluidAudio as a reference, not as a dependency: the zero-padded input page and aneTailCpu.
- Pin the 7 FluidInference mlpackages (~82 MB) by sha256, compile them to `.mlmodelc` in CI, and inject them the way we inject the ONNX model today.
- Routing:
  - Foreground: ANE, with Noise and Tail on the CPU.
  - Backgrounded: all `.cpuOnly`, unless the iOS 27 entitlement is granted.
  - After a crash: crash-arming, the SchriftOhr pattern. Write "attempting route X" before each call, and disable that route on the next launch if the process died.
  - Final fallback: ORT, then the system voice (D7).
- If this becomes the only iOS engine, the fp32 ONNX drops out of the bundle: 325 MB → 82 MB, and D13's TestFlight-only restriction can lift.
- *Accept:* 100% of chunks finite. Locked content RTF ≤ 0.4 at speed 1.5 on the founder's phone. A 60-minute locked soak with no crash and no jetsam. First-use compile shows "preparing voice" rather than looking hung.

**S6 · Foray-level render-ahead worker (M).** Replaces the per-line `LeadPolicy` (D8).
- Starts when the Foray page opens and renders in Foray order through the clips.
- When locked, duty-cycles to a CPU budget of ≤70% of one core, measured in CPU-seconds.
- Renders ≥ 60 s of narration content before Play, or starts playback anyway and lets the clips absorb the lead.
- *Accept:* the simulation on real Forays shows zero stalls at 1.5x and 2.0x using probe v3's measured RTFs, and a 30-minute locked Foray at 1.5x on the phone has 0 underruns.

**Decision rule after S2:**
- If a **background-safe** Core ML pass (`ane-cputail` or `cml-cpu`) is finite with content RTF ≤ 0.4 at speed 1.0 on the phone and survives the soak, S5 becomes the iOS engine and ORT stays only as the fallback.
- Otherwise, ship S3 + S4 + S6 on ORT, and use option 4's 163 MB export to fix the bundle size.

## 5. What probe v3 must measure on the founder's phone (iPhone15,2 / A16, iOS 18.6.2)

It uses the same passage and token ids as `tools/mobile/kokoro-probe-passage.json`, `af_heart`, and sentence chunks. Each pass loads and releases its own models.

| Pass | What it is |
|---|---|
| `ort-cpu-t{2,3,4}` | fp32 ORT (1.24.2, if S4 has landed), interleaved |
| `ane` | laishere placement: Albert, PostAlbert, Alignment and Vocoder on `.cpuAndNeuralEngine`; Prosody, Noise and Tail on `.all` |
| `ane-cputail` | As `ane`, but Prosody, Noise and Tail on `.cpuOnly`. No GPU. |
| `cml-cpu` | All 7 stages on `.cpuOnly` |

Record for every pass:
1. Warm content-basis RTF at **speed 1.0 and 1.5**. Content seconds come from the speed-1.0 render.
2. **CPU seconds per content second.** This is what the locked-screen monitor counts.
3. Finiteness per chunk.
4. Peak `phys_footprint` and available memory.
5. Cold load (the first ANE compile, which may take ~20 s) and warm load.
6. Per-stage ms for the Core ML passes.
7. Thermal state at the start and end.
8. **Everything once in the foreground and once with the screen locked** (`bgAtFail`, `hidden`).
9. A **30–60-minute locked soak** on the fastest background-safe pass, which is how the BNNS crash class showed up (54 min into #889).
10. One WAV per pass, so the founder can play it.

Go/no-go is the decision rule in §4.

## Sources

- **Measured:** the throwaway branches `probe/kokoro-speed-{l1,l2,arch,prior-art}`, which are never to be merged. The runs cited above; job ids are in each lens's report.
- **Cited:**
  - [laishere/kokoro-coreml](https://github.com/laishere/kokoro-coreml) (Apache-2.0)
  - [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0, iOS 17), issues #587, #844 and #889, and `Documentation/TTS/KokoroAne.md`
  - [mattmireles/kokoro-coreml](https://huggingface.co/mattmireles/kokoro-coreml)
  - soniqo/speech-swift
  - [mlalma/kokoro-ios](https://github.com/mlalma/kokoro-ios) (MIT)
  - [ORT posix env.cc v1.20.0](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.20.0/onnxruntime/core/platform/posix/env.cc)
  - [onnxruntime-swift-package-manager Package.swift](https://raw.githubusercontent.com/microsoft/onnxruntime-swift-package-manager/main/Package.swift)
  - [ORT CoreML EP docs](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
  - Apple: Metal background restriction; BGProcessingTaskRequest; the continued-processing inference entitlement (iOS 27)
  - [WWDC19 session 707](https://developer.apple.com/videos/play/wwdc2019/707/)
