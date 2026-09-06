# A voice of our own, inside the app: research and a Hermes deck

**Status:** research + card deck for Hermes. Written 2026-09-06 by the founder's
Claude session at Wyatt's request. Companion to `docs/ios-controls-and-voice-plan.md`
(whose V-01 voice picker this deck **re-scopes**, see §8) and to the ruling in
`docs/curation/generation-architecture.md` §1.2 ("narration is spoken on-device"),
which this deck keeps and sharpens: on-device, but with **our** voice, not the
phone's.

Labels as in the research docs: **Measured** (we ran it), **Documented** (a primary
source says so, linked), **Inferred** (reasoned, not verified — every one of these is
assigned to a card that measures it).

---

## 0. The brief, verbatim

Wyatt, 2026-09-06:

> "can we just include a voice in the 4a app and then it is used to read things
> aloud? Are we really limited to just using the Apple voices?"

> "#2 seems great, and also avoids making the user go poke around in settings + the
> initial shock of a shitty voice. Can you do some research as to what it would take
> to do that, potential downsides, etc, and then make a detailed plan for Hermes to
> implement? Bit more memory is fine"

> "for the voices, the founders should try out a dozen first and choose our 3
> favorites, which are then selectable from within the app"

## 1. The short answer

**Yes.** An 82-million-parameter neural voice (Kokoro, the same model whose voice Wyatt
heard in the original narration test) can be shipped inside the app and run on the
phone, offline, with no download step and no Settings visit. Weights are Apache-2.0.
The 8-bit model is **86–92 MB**; three voices add ~1.5 MB. Recent phones synthesize
faster than real time; a 2018-class device does not, and that is why the first card is
a measurement on real phones, not a build.

**The recommendation is Kokoro-82M, run through ONNX Runtime in our own plugin, with
one architectural twist that removes the two biggest risks at once: the text is turned
into phonemes on our servers when the Foray is generated, and the phone receives
phonemes, not text.** The engine on the phone then needs no dictionary, no
grapheme-to-phoneme code and none of the GPL-licensed `espeak-ng` that every Kokoro
runtime otherwise drags in. It also makes every render deterministic across every
device, which brings back the review gate `on-device-tts.md` §5 said on-device
narration had lost.

The rest of this document is the evidence, the downsides, and the cards.

## 2. What was already established in this repo (Measured / Documented)

- **The ruling.** `generation-architecture.md` §1.2: narration items carry a `script`
  and are spoken on-device; the decisive axis is cost at unlimited user-created volume
  ($0 synthesis and $0 hosting only on-device). §1.2.1 pre-answered the Kokoro GPL
  question **for the server-side fallback**: `espeak-ng` is GPL, so keep it on the
  server. This deck honours exactly that line, on the on-device path.
- **The voice Wyatt liked** was the Kokoro acceptance fixture (`self-hosted-tts.md`
  §2, voice `af_heart`). The 2026-09-05 verdict "much worse than the original test"
  was Apple's compact system voice, not a verdict on on-device synthesis
  (HUMAN-ACTIONS #29 RESULT, `on-device-tts.md` §9.7).
- **The pronunciation lexicon exists**: 83 IPA entries in
  `mobile/plugins/foray-tts/lexicon/hard-terms.json`, hand-audited from the two spines
  (`narrator-voice.md` Appendix). Kokoro is a phoneme-input model, so this lexicon
  applies losslessly; system voices honour it only where the OS chooses to.
- **The plugin shape exists**: `mobile/plugins/foray-tts` (Swift package + Android
  library + web half), `speak`/`state`/`listVoices`, audio-session handling, the
  rate mapping calibrated from one device reading (#490). The queue calls
  `this._tts.speak(item.script, { rate })` at `player/queue-manager.js:984` and cannot
  yet tell when an utterance finishes (`ForayTtsPlugin.swift:465`; L-03 in the iOS
  controls deck owns that).
- **Sizes today**: Android release `.aab` **5.46 MB**; the simulator `App.app`
  **8.3 MB**; the web bundle inside it 2.46 MB of a 3.00 MB budget
  (`prepare-webdir.mjs`). So the app is currently tiny and a 90 MB model is the whole
  size story.
- **Speaking rate for planning**: 170 wpm ≈ 17 characters/second
  (`narration-craft.md` §2a). A 20-second narration line is ~340 characters.

## 3. The candidates (Documented, sources linked)

| Engine | Params | On-device model | Licence: weights / code / text front-end | English voices | Pronunciation control | Mobile evidence |
|---|---|---|---|---|---|---|
| **Kokoro-82M** | 82M | 92 MB int8, 86 MB q8f16, 163 MB fp16, 326 MB fp32 ([onnx-community card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) | Apache-2.0 / Apache-2.0 / **misaki (Apache) with `espeak-ng` (GPL-3) fallback** ([hexgrad/kokoro](https://github.com/hexgrad/kokoro), [issue #247](https://github.com/hexgrad/kokoro/issues/247)) | 20 (11 US-f, 9 US-m, 4 GB-f, 4 GB-m); only `af_heart` (A) and `af_bella` (A-) grade above B ([VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)) | **Phoneme input** (IPA via misaki); a `speed` input 0.5–2.0 | iPhone 13 Pro, MLX Swift: **3.3× faster than real time** after warm-up ([kokoro-ios](https://github.com/mlalma/kokoro-ios)); iPad Pro 2018 A12X, ONNX fp32: **RTF 0.62, 833 MB peak**; int8 variants **slower** there, RTF > 1.5 ([VoicePing eval](https://voiceping.net/en/blog/research-offline-tts-eval/)); NimbleEdge ships it int8 < 80 MB on phones with a misaki reimplementation ([blog](https://www.nimbleedge.com/blog/how-to-run-kokoro-tts-model-on-device/)) |
| Pocket TTS (Kyutai) | 100M | ~242 MB, 610 MB peak ([Picovoice bench](https://picovoice.ai/blog/on-device-tts/)) | MIT / MIT / text tokens, no phonemizer ([repo](https://github.com/kyutai-labs/pocket-tts)) | 26 presets + cloning from any clip | none documented; "does not support adding silence" | RTF ~0.17 on an M4 laptop CPU; CoreML port exists; phone numbers unpublished |
| Supertonic 3 (Supertone) | 99M | not stated; "450 MB class" per one survey | **OpenRAIL-M** weights / MIT code / built-in normaliser, **text only** ([repo](https://github.com/supertone-inc/supertonic)) | presets only; cloning is a paid service | none | very fast (RTF 0.006 on M4 Pro); Android review: "short pieces of text can sometimes be spoken incompletely" ([Speech Central](https://speechcentral.net/2026/05/23/supertonic-tts-android-another-offline-ai-voice-engine-joins-the-open-source-tts-wave/)); **repo to be archived after 2026-08-31** |
| Kitten TTS Nano | 15M | 24–42 MB, 320 MB peak | Apache-2.0 / uses espeak-ng | 8 | phonemes via espeak | fast; quality a tier below the others in every survey |
| Piper | ~20M | 20–60 MB per voice | **GPL-3** (piper-phonemize/espeak) — store-distribution concern named by Picovoice | many, single-speaker each | phonemes via espeak | fastest of the neural set (RTF 0.077 on a 2019 Galaxy S10) |
| Matcha + Vocos (sherpa) | small | 211 MB peak | Apache / espeak-ng | 1 (LJSpeech) | via espeak | RTF 0.084 on the 2018 iPad |
| Picovoice Orca | — | 7 MB | commercial licence | few | custom dictionary | 106 ms first audio; paid per-device |
| System voices (today) | — | 0 | — | whatever is downloaded | iOS IPA attribute; Android unverifiable | HUMAN-ACTIONS #40: stock phones ship only the compact tier |

**Why Kokoro wins for this product, in order:** it is the voice already judged good
in the acceptance test; it is the only permissively-licensed candidate with phoneme
input, which is what makes the 83-entry lexicon and any future one reliable; it has
20 English voices to audition rather than 8 or a single speaker; its quantized weights
fit under 100 MB; and it has three independent on-device ports on Apple hardware
(MLX Swift, CoreML via FluidAudio, ONNX) plus sherpa-onnx on Android. Pocket TTS is
the runner-up (MIT, streaming, cloning) and would win on speed if Kokoro fails K-01 on
old phones, at the cost of pronunciation control. Supertonic is out on the archive
notice and the text-omission bug. Piper is out on licence.

## 4. The design: phonemes travel, the phone only sings

**Documented.** The Kokoro ONNX graph has three inputs — `input_ids` (phoneme token
ids, ≤ 512), `style` (a 256-float vector chosen by token length from a per-voice
file), `speed` (float) — and emits 24 kHz audio ([onnx-community card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)).
Everything before `input_ids` is text processing: misaki's dictionaries, with
`espeak-ng` for out-of-vocabulary words. Everything after is arithmetic.

**Inferred, and it is the load-bearing idea of this deck.** Our narration scripts are
authored by our pipeline, on our machines, at generation time (`generation-architecture.md`
§4.7). So the pipeline can phonemize there — misaki plus `espeak-ng`, GPL confined to
the server exactly as §1.2.1 already planned for the fallback path — apply the IPA
lexicon deterministically, and store the phoneme string next to the script. The app
receives `phonemes` and maps them to ids with a 200-line vocabulary table. Consequences:

- **No `espeak-ng` in the app binary**, so no GPL question at the App Store. A CI gate
  (K-06) proves it stays out.
- **No misaki port to maintain on two platforms.** (MisakiSwift exists for iOS; nothing
  equivalent is known for Android. We need neither.)
- **Bit-for-bit the same phonemes on every phone**, and the model is deterministic, so
  a curator's render on a laptop is what every listener hears. The review gate is back.
- **Duration becomes known before speaking**: the server can also record the rendered
  length per line, which fixes `generation-architecture.md` §7 item 3 (runtime is an
  estimate today) for free.
- **The one thing it costs:** any text that is *not* authored server-side — an
  audition line, a UI string, a user-typed subject — has no phonemes. Rule: such text
  ships pre-phonemized (audition line, disclosure line), or falls back to the system
  voice (K-05 keeps today's path alive for exactly this).

**Runtime choice.** ONNX Runtime on both platforms, driven directly (three tensors in,
one out), inside our existing `foray-tts` plugin as a second engine. Not sherpa-onnx:
its TTS API takes *text* and phonemizes internally with espeak-ng, which is the thing
we are avoiding. Not MLX Swift: iOS 18+ only, and the plugin's floor is iOS 15
(`Package.swift`). CoreML through ORT's CoreML execution provider is an optimisation
K-01 measures, not a dependency (ANE behaviour changed across iOS 17 per Apple's
forums; do not assume it).

## 5. Downsides, stated plainly

1. **App size: roughly +100 MB per platform.** Model 86–92 MB, ORT library ~10–20 MB
   (Inferred; K-06 measures), three voice files 1.5 MB. Apple's cellular download cap is
   200 MB ([AppleInsider](https://appleinsider.com/articles/19/05/31/apple-bumps-up-4g-app-store-download-limit-for-iphones-ipads-to-200mb)),
   so a ~110 MB app still installs over cellular; Play's install-time asset packs allow
   1 GB ([Android docs](https://developer.android.com/guide/playcore/asset-delivery)).
   Every app update re-ships the model unless it moves to on-demand resources / Play
   Asset Delivery — deferred with a written trigger (K-06). Wyatt: "bit more memory is
   fine."
2. **Speed on older phones is not guaranteed.** The evidence spans 3.3× faster than
   real time (iPhone 13 Pro, MLX) to slower than real time (2018 iPad, ONNX int8). Our
   need is *not* interactive: a narration line can be synthesized while the previous
   segment plays (the generation-lead idea in §6.3 applied to synthesis), so RTF ≤ 0.8
   on the oldest supported phone is enough. K-01 measures on Wyatt's iPhone and Joey's
   Pixel 10 Pro, and on one deliberately old device.
3. **Memory.** 833 MB peak was measured for fp32 on iPad; fp16/q8 should roughly halve
   it (Inferred). iOS gives a *backgrounded* app far less headroom than a foregrounded
   one, and narration must synthesize with the screen locked. If K-01 finds jetsam
   kills, the mitigation is synthesizing the next line *before* backgrounding and
   keeping ≤ 2 lines of audio buffered — a design change in K-04, not a blocker.
4. **Battery and heat.** Unmeasured anywhere for our regime (hours of intermittent
   synthesis). K-01 records mAh per 10 minutes of narration-heavy Foray against tape-only.
5. **Quantization quality.** "Resilient to quantization" per the model card; nobody
   here has listened. K-03's audition renders with the *exact* q8f16 weights the app will
   ship, so the founders judge what listeners get, not the fp32 demo.
6. **Cold start.** Model load is 1–3 s on first use (Documented for CoreML compile;
   Inferred for ORT). Load at app start, off the main thread, and keep the session warm.
7. **Only English.** Kokoro v1.0's English voices are the mature set. Fine for now; a
   second language is a second model and a second audition.
8. **Version coupling.** Phonemes in the data must match the phoneme vocabulary of the
   model in the app. Every narration item carries `tts: { engine, model, vocab }` and
   the player refuses (falls back) on mismatch (K-02/K-05). Model files are pinned by
   sha256 and fetched at build time, never committed (K-06).
9. **Loss of per-device G2P.** Ad-hoc on-device text cannot use the good voice
   (§4's last bullet). Acceptable today because nothing in the app speaks ad-hoc text
   except the audition line, which is authored.
10. **Training-data provenance.** Kokoro states it was trained on permissive and
    synthetic data ([model card](https://huggingface.co/hexgrad/Kokoro-82M)). Not
    independently verified; recorded so the legal docs can cite the claim as a claim.

## 6. The founder audition: a dozen in, three out

Wyatt's rule, made concrete. K-03 renders **one passage** (≈90 s: the disclosure line,
two narration beats from the grilling spine, and the pronunciation fixture sentences
carrying six lexicon terms) in **twelve Kokoro voices**, at the shipping quantization,
at 1.0×, blind-labelled A–L. Starting slate, chosen by grade and variety:
`af_heart` (A), `af_bella` (A-), `af_nicole` (B-), `bf_emma` (B-), `af_sarah`,
`af_kore`, `af_aoede` (C+), `am_michael`, `am_fenrir`, `am_puck` (C+), `bm_george`,
`bm_fable` (C). Kokoro can also average two style vectors into a blend; K-03 may add
up to two blends if a founder asks, but the slate ships as twelve. Founders each rank
their top five; the three with the best combined rank ship, and the winner is the
default. Then a second, short listen of the three at 1.5× and 2.0×, because the
`speed` input's quality at the fast end is the thing long-form listeners will actually
live with. The pick is recorded in `docs/DECISIONS.md`.

## 7. Human gates

| # | Who | What | Blocks |
|---|---|---|---|
| H1 | Wyatt + Joey | **Run K-01's measurement build** on Wyatt's iPhone and Joey's Pixel 10 Pro (both already on the tailnet), plus one old phone if either has one: play the diagnostic passage locked and unlocked; the build writes RTF, peak memory, cold start and battery into the Playback-diagnostics drawer; copy it out (the HUMAN-ACTIONS #21 routine) | K-04 |
| H2 | Wyatt + Joey | **The audition** (§6): rank the twelve, then confirm the three at speed | K-04 (which voices to bundle), DECISIONS |
| H3 | Wyatt | `founder-approved` for the `.github/` changes (model fetch step, size gate) — one sitting | K-06 |
| H4 | Wyatt | App Store / Play: nothing new, but the next TestFlight after K-04 is ~100 MB larger; expect the processing time to change | — |

## 8. Coordination with the other decks

- **V-01 (voice picker) is re-scoped**, not deleted: the picker lists **the three
  bundled voices** (audition each, persist `cp_voice`), and the "download an Apple voice
  in Settings" flow disappears. Keep V-01's `cp_voice` key, drawer entry and Audition
  button; drop its greyed-out-missing-voices rows and Open Settings button. If V-01 has
  already shipped, K-05 amends it.
- **HUMAN-ACTIONS #40** (download an Enhanced Apple voice) becomes moot once K-04
  ships; K-07 closes it with a pointer here rather than asking Wyatt to do it.
- **L-03** (utterance-finished event, iOS controls deck) is needed by this engine too;
  K-04 implements `finished` for the Kokoro path and L-03 keeps owning the system-voice
  path. Same event name, one consumer in `queue-manager.js`.
- **D-01** (delete the diagnostic Foray) is unaffected. K-01 ships its own instrument
  and deletes it in the same way.
- **The generation pipeline (#487)** gains a phonemize step (K-02). It runs where the
  pipeline already runs; nothing in the app changes until K-05.
- `generation-architecture.md` §1.2 says "the platform's own voice engine". K-07
  amends it to "the bundled voice, with the platform's engine as fallback", citing this
  document, and adds a DECISIONS entry. `on-device-tts.md` gets an addendum §10.

## 9. The card deck

Conventions as in the sibling decks: ask; owned files; dependencies; **measured**
acceptance; sizing (S ≤ ½ day, M ≤ 2 days, L ≤ 5); governance; design comment first
where marked. Branch `t_<card>/<slug>`, STATE.md entry per PR. `mobile/` and
`player/` auto-merge; `.github/` and `tools/ci/` need `founder-approved`; `data/`
auto-merges. Large binaries are **never committed**: model and voice files are fetched
at build time from a pinned URL with a sha256 check (the Shows-index release pattern,
S-04b). Read first: `CLAUDE.md`; this file; `generation-architecture.md` §1.2, §4.7,
§7; `on-device-tts.md` §3–§6, §9; `narrator-voice.md` Appendix (the lexicon);
`mobile/plugins/foray-tts/README.md` and both native sources; the onnx-community model
card linked above; HUMAN-ACTIONS #21 (copying diagnostics out) and #29.

#### K-01 · Measure Kokoro on real phones before anything is built on it — **L** — *design comment first*
- **Ask:** a throwaway measurement path, not a product feature. Add an `engine: "kokoro-probe"`
  branch to `foray-tts` on both platforms that loads a bundled q8f16 model and one
  voice, synthesizes a pre-phonemized 90 s passage (ids computed offline and shipped as
  JSON; **no text front-end on device**), plays it through the existing audio path, and
  writes to the Playback-diagnostics record: model load ms (cold and warm), RTF per
  line, peak resident memory (`os_proc_available_memory` / `Debug.getNativeHeapSize`
  plus the OS's own figure), whether synthesis completed **with the screen locked** for
  the whole passage, and battery delta over a 10-minute loop. Try ORT's default CPU
  provider first; on iOS also record the CoreML EP if it loads. Ship it as a hidden
  drawer button behind the same `withDiagnosticUnlock` discipline #29 used, and delete
  it in K-04's cutover.
- **Owned:** `mobile/plugins/foray-tts/**` (probe branch; ORT dependency added: iOS via
  the `onnxruntime` Swift package / pod, Android via `com.microsoft.onnxruntime:onnxruntime-android`),
  `tools/mobile/fetch-models.mjs` (new: download model + voice by pinned sha256 into
  `mobile/models/`, gitignored; runs in `prepare-webdir`'s place in the shell build),
  `tools/mobile/kokoro-probe-passage.json` (ids + expected durations), `app.js`
  (drawer button), `HUMAN-ACTIONS.md` (H1 item, with the copy-out steps).
- **Acceptance:** a TestFlight and a Play-internal build exist that produce the record;
  the record's numbers appear in `docs/research/on-device-tts.md` §10 with device
  names and OS versions. **Go/no-go rule, written before the run:** RTF ≤ 0.8 warm on
  the newest phone and ≤ 1.5 on the oldest tried, peak memory ≤ 400 MB, and locked-screen
  synthesis completes. Miss any and K-04 waits for a design change (fp16 vs q8, EP,
  chunking) or the runner-up engine.
- **Governance:** `mobile/` auto-merges; the model-fetch step touches the build
  workflows → `founder-approved` (H3; batch with K-06).

#### K-02 · Phonemes are authored with the script — **M**
- **Ask:** the generation pipeline (#487's driver) gains a `phonemize` stage after §4.7
  "Write the narration": apply `hard-terms.json` first (exact IPA for the 83 terms, word
  boundary, case-insensitive), then misaki (`en-us`) with `espeak-ng` fallback for the
  rest, on the server. Store on the narration item: `phonemes` (misaki's IPA string),
  `tts: { engine: "kokoro", model: "1.0", vocab: "<sha of the id table>" }`, and
  `est_sec` from characters/17 until K-04 can record real rendered length. Extend
  `check-forays.mjs`: when `tts.engine` is `kokoro`, `phonemes` is non-empty and every
  lexicon term in `script` is reflected in `phonemes` (MUTATION: drop one override →
  red). Python is fine for the stage (misaki is Python); pin versions; the stage's
  container never ships to a phone.
- **Owned:** `tools/narration/phonemize.py` (+ `requirements.txt`), the pipeline driver,
  `tools/check-forays.mjs` (+ test, floored), the four committed Forays in
  `data/forays.json` re-authored with phonemes, `docs/curation/generation-architecture.md`
  (§4.7 gains the step).
- **Dependencies:** none; day 0.
- **Acceptance:** `node tools/check-forays.mjs` green with every narration item
  phonemized; the fixture's six lexicon terms come out as their IPA verbatim; running
  the stage twice on the same script is byte-identical.

#### K-03 · The audition kit — **S** (+ H2)
- **Ask:** render §6's passage in the twelve voices with the **same** ONNX graph and
  q8f16 weights K-01 bundles, from K-02's phonemes, at 1.0×; then the top three at
  1.5× and 2.0×. Publish as one private page (blind labels, one player per clip, a
  ranking form that produces a pasteable result), plus the clips in a release asset.
  Record the founders' pick in `docs/DECISIONS.md` and the shipped voice ids in
  `mobile/plugins/foray-tts/voices.json`.
- **Owned:** `tools/narration/render-audition.py`, `docs/research/voice-audition-2026-09.md`
  (the slate, the labels-to-voices key sealed until ranking is in, the result),
  `docs/DECISIONS.md`.
- **Dependencies:** K-02's phonemizer (the passage). Independent of K-01.
- **Acceptance:** twelve clips exist and are bit-identical on re-render; the decision
  entry names three voice ids and a default.

#### K-04 · The engine: Kokoro inside `foray-tts`, both platforms — **L** — *design comment first*
- **Ask:** promote K-01's probe into a real engine. Native API on both platforms:
  `speak({ phonemes | ids, voice, speed, utteranceId })` → resolves on accept (as today),
  emits `progress` (seconds synthesized) and **`finished`** (the L-03 contract) ;
  `stop()`; `state()` reports `{ engine: "kokoro", model, voices, warm }`; `listVoices()`
  returns the three bundled voices with the audition's names. Synthesis is **chunked by
  sentence** into a ring buffer feeding `AVAudioEngine` / `AudioTrack`, so first audio
  is under ~1 s and memory stays flat; the next chunk synthesizes while the current one
  plays. Audio session policy unchanged from today (`.playback`, `.spokenAudio`).
  Speed is Kokoro's own `speed` input — retire the AVSpeech rate curve for this
  engine (keep it for the fallback). Phoneme→id table is a generated Swift/Kotlin
  constant with the vocab sha from K-02; a mismatch refuses with `reason: "vocab"`.
  **Design comment must settle:** chunk boundaries (sentence vs. fixed token count),
  the buffer depth for locked-screen operation (per K-01's memory reading), the CoreML
  EP decision, and how the model is loaded (app start vs first use) with the measured
  cold-start figure.
- **Owned:** `mobile/plugins/foray-tts/ios/**`, `android/**`, `web/foray-tts.js`
  (engine selection; `speak` accepts `phonemes`), `tools/mobile/foray-tts.test.mjs`
  (floor 38 → raise), XCTest + JUnit for the id table, chunking and the refuse-on-vocab
  rule (MUTATION: change one id → the vocab check goes red), `mobile/plugins/foray-tts/README.md`.
- **Dependencies:** K-01 passed its go rule; K-03 named the voices.
- **Acceptance:** on the two H1 phones, a full narration-heavy Foray plays locked with
  no gap over ~1 s at any line boundary; `finished` fires once per line; peak memory
  within K-01's ceiling; the CI shell builds green on both platforms with the model
  fetched, not committed.
- **Governance:** `mobile/` auto-merges. Brief: do not self-apply `founder-approved`.

#### K-05 · The player speaks phonemes, and falls back honestly — **M**
- **Ask:** `queue-manager.js` passes `phonemes`, `voice` (from `cp_voice`, default =
  the audition winner) and `speed` when an item carries `tts.engine === "kokoro"` and
  the plugin reports that engine ready; otherwise today's `script` path with the system
  voice, unchanged. One non-blocking notice the first time a Foray falls back ("Using
  your phone's voice for this one"). `est_sec` feeds the seam and generation-lead maths
  until real durations arrive from `progress`. Re-scope V-01 per §8: the picker shows the
  three bundled voices with Audition (pre-phonemized line), persists `cp_voice`.
- **Owned:** `player/queue-manager.js` (+ test), `player/client.js`, `player/foray-queue.js`
  (an item with `phonemes` and no asset is playable — §7 item 1), `app.js` (voice
  settings), `test/voice-settings.test.js`, `docs/legal/privacy-policy.md` (`cp_voice`).
- **Dependencies:** K-02 (data), K-04 (engine).
- **Acceptance:** with a fake plugin in Node, a kokoro item speaks with `phonemes` and
  the chosen voice (MUTATION: drop `voice` → red); a legacy item still speaks `script`;
  vocab mismatch → fallback, not silence.

#### K-06 · Size, provenance and licence gates — **S**
- **Ask:** (1) `tools/mobile/fetch-models.mjs` pins `{url, sha256, bytes}` for the model
  and each voice; CI fails on a mismatch. (2) A gate test asserts **no `espeak`
  symbol, file or licence text** is present in the built app (`strings` on the binary
  and a file walk of the bundle) — the GPL stays on the server. (3) An app-size test:
  the `.ipa` and `.aab` sizes are recorded per build and a ceiling of **150 MB** fails
  the build, with the cellular-cap reasoning in the message; a second line says when to
  move to ODR/Play Asset Delivery (ceiling reached, or a second language). (4) A
  `THIRD_PARTY_NOTICES` entry for Kokoro (Apache-2.0), ORT (MIT) and the voice data.
- **Owned:** `tools/mobile/fetch-models.mjs` (+ test), `test/release-gates.test.js`
  (floor → raise), the build workflows (one step each), `docs/legal/*` (the notice).
- **Governance:** `.github/` → `founder-approved` (H3). Batch with K-01's workflow step.

#### K-07 · Records — **S**
- **Ask:** `generation-architecture.md` §1.2 amended ("the bundled voice; the platform's
  engine is the fallback"); `on-device-tts.md` §10 with K-01's measurements;
  DECISIONS entries (engine choice; the three voices); HUMAN-ACTIONS #40 closed with a
  pointer here; STATE.md; `docs/research/self-hosted-tts.md` gains a note that the
  server-side Kokoro fallback and the on-device engine now share one phonemizer.
- **Governance:** `docs/DECISIONS.md` → `founder-approved`; the rest auto-merges.

## 10. Sequencing

```
Day 0 (parallel):  K-01 measurement build     K-02 phonemize stage
Then:              K-03 audition ← K-02        H1 (phones) after K-01's build lands
Then:              K-04 engine ← K-01 go, K-03 pick (H2)
Then:              K-05 player ← K-02, K-04     K-06 gates ← K-04 (label sitting with K-01's step)
Last:              K-07 records
```

If K-01 fails its go rule on the oldest phone but passes on current ones, the decision
is a founder's: ship with a minimum-device line, or take Pocket TTS as the engine and
give up phoneme control. That question is pre-answered here as "ship with a minimum
device", because pronunciation control is the product's stated bar
(`narrator-voice.md` §5), but it is recorded as a gate, not assumed.

## 11. Non-goals

- Voice cloning of any real person, and any voice whose licence is not Apache/MIT.
- Languages other than English.
- On-device grapheme-to-phoneme for arbitrary user text. If that is ever wanted, the
  path is a MisakiSwift-style port on both platforms, weighed against a server call;
  not this deck.
- Replacing the server-side Kokoro fallback for curated Forays (`generation-architecture.md`
  §1.2's backdoor). It stays, and now shares K-02's phonemizer.
- CarPlay, lock-screen controls, or anything in the iOS-controls deck.

Sources consulted, beyond this repo: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
[hexgrad/Kokoro-82M VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md),
[hexgrad/kokoro issue #247](https://github.com/hexgrad/kokoro/issues/247),
[VoicePing offline TTS eval](https://voiceping.net/en/blog/research-offline-tts-eval/),
[NimbleEdge: Kokoro on-device](https://www.nimbleedge.com/blog/how-to-run-kokoro-tts-model-on-device/),
[mlalma/kokoro-ios](https://github.com/mlalma/kokoro-ios), [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio),
[Picovoice on-device TTS benchmark](https://picovoice.ai/blog/on-device-tts/) (vendor-biased; used for sizes and licences only),
[kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts), [supertone-inc/supertonic](https://github.com/supertone-inc/supertonic),
[Speech Central on Supertonic for Android](https://speechcentral.net/2026/05/23/supertonic-tts-android-another-offline-ai-voice-engine-joins-the-open-source-tts-wave/),
[sherpa-onnx Kokoro docs](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html),
[Apple ODR size limits](https://developer.apple.com/help/app-store-connect/reference/on-demand-resources-size-limits/),
[Play Asset Delivery](https://developer.android.com/guide/playcore/asset-delivery).
