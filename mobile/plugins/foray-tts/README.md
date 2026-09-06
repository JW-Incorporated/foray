# `foray-tts` — the on-device text-to-speech plugin

Built for the card that closed `docs/research/on-device-tts.md` §7 items 1-2:
"close the native-plugin gap" and "wire one real call site to prove the
plumbing end-to-end." Read `docs/research/on-device-tts.md` and
`docs/research/narrator-voice.md` §5.7 first — this file assumes both.

## What this is

A local Capacitor plugin, same pattern as `mobile/plugins/foray-audio/`
(`docs/android-native-code.md`):

```
mobile/plugins/foray-tts/
  package.json                                        capacitor.ios.src / .android.src pointers
  Package.swift                                        the iOS Swift Package (SPM, no CocoaPods — docs/ios-ci.md)
  ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift       AVSpeechSynthesizer wrapper
  ios/Tests/ForayTtsPluginTests/                        placeholder XCTest target (never run — see below)
  android/build.gradle                                  a com.android.library module
  android/src/main/AndroidManifest.xml                  empty on purpose — see the file's own comment
  android/src/main/java/…/ForayTtsPlugin.java           TextToSpeech wrapper
  web/foray-tts.js                                      the JS interface + fallback + lexicon matching
  web/package.json                                      `"type": "module"`, so Node can test it
  lexicon/hard-terms.json                                the pronunciation-override lexicon (see below)
```

`mobile/package.json` declares `"foray-tts": "file:plugins/foray-tts"` next to
`foray-audio`, so `cap sync` / `cap add ios` / `cap add android` discover it
the same way. `tools/mobile/prepare-webdir.mjs`'s `SHELL_ONLY_FILES` copies
`web/foray-tts.js` into the native bundle as `foray-tts.js` and adds its
`<script type="module">` tag, same mechanism `foray-audio-shell.js` uses.

## Why it exists — the one-paragraph version

`docs/research/on-device-tts.md` §3 found that neither the plain Web Speech
API nor either surveyed Capacitor community plugin
(`capacitor-community/text-to-speech`, Capawesome's speech-synthesis plugin)
exposes iOS's own documented `AVSpeechSynthesisIPANotationAttribute`. Reaching
it requires a native plugin. This is that plugin.

## The lexicon format

`lexicon/hard-terms.json` reuses the exact format
`docs/research/narrator-voice.md`'s pronunciation-lexicon Appendix already
implies — a flat list of terms, matched case-insensitively on word
boundaries — rather than inventing a new shape. It seeds all 81 (76 distinct)
entries from that document's own appendix, plus `ch'arki` (which that document
explicitly says to add to any fixture even though its own word-boundary count
excludes it).

**Every `ipa` field in the shipped file is `null`.** No IPA transcription has
been authored or verified for any of these terms. That is not a placeholder
bug — see the file's own `//ipa` note. `narrator-voice.md` §5.7 is explicit
that the acceptance fixture is what should *drive* authoring pronunciations,
not something authored in advance without listening; shipping a guessed IPA
string here would be exactly the kind of unlabelled claim this repo's
research docs warn against, and it would ship a wrong-and-untested
pronunciation with nobody the wiser until a real device test. A `null` ipa
produces **no override at all** — the term is spoken as plain text on both
platforms — and `foray-tts.test.mjs` asserts this directly
("a lexicon entry with ipa:null produces NO override").

## The real call sites

**Updated for HUMAN-ACTIONS.md #29.** For the plugin's first months this section
said "one call site", and it was a Node harness — the PLAYER never called this
module at all. `PlayerQueueManager` had accepted a `tts` option and
`_speakNarration` was complete, but nothing ever passed one, so on a phone the
narration path could only ever fail with "no on-device TTS plugin wired". That is
now wired:

- **`player/tts-bridge.js`** loads `web/foray-tts.js` lazily and hands
  `PlayerQueueManager` a `{ speak }` object; `player/client.js` passes it in.
  The module lives at a different URL in the shell (`foray-tts.js`, flattened
  there by `tools/mobile/prepare-webdir.mjs`) than on the website
  (`mobile/plugins/foray-tts/web/foray-tts.js`, which GitHub Pages serves
  verbatim), which is the whole reason the import is dynamic. Covered by
  `player/tts-bridge.test.js` and by the diagnostic-Foray block at the end of
  `player/foray-playback.test.js`.
- **One `rate` correction fell out of doing it.** The player sends a playback
  MULTIPLIER (`player/playback-rate.js`'s ladder, `1` = normal), which is what
  Android's `TextToSpeech.setSpeechRate()` means and is NOT what
  `AVSpeechUtterance.rate` means — there, `1.0` is
  `AVSpeechUtteranceMaximumSpeechRate`. `ForayTtsPlugin.utteranceRate(playbackMultiplier:)`
  now converts. Compiled by `ios-build`'s `ios-shell` job; never heard.
- **…and the device then said that correction was still wrong.**
  `HUMAN-ACTIONS.md` #29's RESULT (2026-09-05) measured **1.5x playing back at
  roughly 3x**: multiplying `AVSpeechUtteranceDefaultSpeechRate` by the
  multiplier asks for rate 0.75, and Apple's 0.5→1.0 band spans ordinary speech
  to unusably fast. The mapping is now **calibrated from that one reading**
  rather than derived — utterance rate is affine in `log(multiplier)`, pinned by
  two anchors (rate `D` = 1.0x, definitional; rate `1.5·D` ≈ 3.0x, measured).
  **One data point does not make a curve.** The form is an assumption chosen for
  simplicity, and the function's own doc comment names the second device reading
  that would confirm or refute it. **Android needed no change and still needs
  none** — AOSP's javadoc on `setSpeechRate` documents a true multiplier
  ("1.0 is the normal speech rate … 2.0 is twice the normal speech rate"), so
  passing the value straight through is correct there.

- **Then a voice correction fell out of the device test itself.** See the next
  section — this is the reason the on-device narration sounded worse than the
  Kokoro fixture, and it was one line.

The Node harness below is still the way to see the payload without a device.

## Which voice speaks (2026-09-05)

**The symptom.** The first real device test of on-device narration came back
"much worse than the original test" — the original being the Kokoro acceptance
fixture, a server-side neural voice.

**The cause, and it was one line.** `speak()` set a voice only when a `lang` was
passed, and it set it with `AVSpeechSynthesisVoice(language:)`. That initialiser
returns the **system default** voice for a language, which on iOS is the
compact/legacy formant tier — the robotic one. Apple's catalogue is not one
tier: `docs/research/on-device-tts.md` §1 recorded that it "spans multiple
synthesis tiers (compact/legacy formant-style voices through modern neural
'Enhanced'/'Premium' voices, downloaded per-language on demand)", and nothing in
this plugin had ever asked for one of the good ones. The comparison was never
Kokoro vs. iOS on-device; it was Kokoro vs. **the worst voice iOS has**.

**What it does now.**

1. **Best installed tier by default.** `installedVoices()` enumerates
   `AVSpeechSynthesisVoice.speechVoices()`; `bestVoice(among:language:preferringName:)`
   picks the highest `quality` available *for the requested (or system)
   language* — premium > enhanced > default. Exact locale matches win outright;
   only when the exact locale has nothing does it widen to the primary subtag
   (`en-US` → any `en-*`). Ties inside the top tier break toward the name of the
   voice the system would have used anyway, so an upgrade sounds like the
   listener's own voice getting better rather than a stranger arriving.
2. **`speak({ voice })`** takes an explicit identifier. It is honoured even when
   it is not the best available — the caller's choice outranks the ladder.
3. **A voice that is not installed never fails the call.** It degrades to (1)
   and the result says so: `voiceFallback: true` plus `voiceRequested`,
   `voiceReason`, and the identifier/name/quality of whatever actually spoke.
   That distinction is the whole point — without it "this voice sounds bad" and
   "this voice was never downloaded to this phone" are the same report.
4. **`listVoices()`** returns what a device actually has.

### Enhanced and Premium voices are free, and are NOT installed by default

This is the operationally important part. Apple ships the compact tier with the
OS; the neural Enhanced and Premium voices are per-language downloads, at no
cost, fetched on demand. **A stock iPhone that has never been to that settings
screen has only the compact tier**, so on that phone the fix above changes
nothing audible — the best installed voice *is* the robotic one.

Where a person downloads them:
**Settings → Accessibility → Spoken Content → Voices → English → [voice] →**
tap the download arrow. (Same catalogue as VoiceOver's; a voice downloaded for
VoiceOver is the same file and shows up here.)

**Identifier shapes, and an honesty note.** iOS 16 renumbered the identifiers,
so both of these spellings are in the wild:

| Tier | Shape | Present on a stock phone? |
|---|---|---|
| compact / default | `com.apple.ttsbundle.Samantha-compact`, `com.apple.voice.compact.en-US.Samantha` | **Yes** — this is what ships |
| enhanced | `com.apple.voice.enhanced.en-US.Ava` | **No** — Settings download |
| premium | `com.apple.voice.premium.en-US.Ava` | **No** — Settings download |
| Siri voices | `com.apple.ttsbundle.siri_*` | Present, but not usable by third-party apps |

**None of the identifiers in that table has been read off a device by anyone in
this repo**, and the exact set varies by iOS version, region and what the owner
has downloaded — which is exactly why `listVoices()` exists rather than a
hard-coded list. Run it on the phone and believe that instead. Same labelling
discipline `docs/research/narrator-voice.md` sets: this table is *documented*
naming convention, not a *measured* device reading.

### Android is done too, and differs in two real ways

`TextToSpeech.getVoices()` / `setVoice()` give Android the same shape, so it got
the same treatment rather than a note explaining why not. Two differences are
the platform's, not omissions:

- **Quality labels differ.** Android's `Voice.getQuality()` is a coarse int
  (`very-low` … `very-high`), not iOS's three named tiers. `listVoices()`
  reports each platform's own vocabulary and does **not** map them onto one
  scale, because they are not comparable.
- **Network voices exist.** `Voice.isNetworkConnectionRequired()` is true for
  some engine voices. Those are excluded from the *default* pick — a commute app
  that quietly chose one would go silent in a tunnel — but they are still listed
  (`networkRequired: true`) and an explicit request for one is honoured.

There is no "premium download" story to tell an Android user: the installed set
depends on the device's TTS engine and its language packs, which this plugin
cannot steer.

### The API, for anyone authoring a test Foray against it

```js
// web/foray-tts.js
await speak(text, { lang, voice, rate, pitch, volume, lexiconEntries });
//   -> { ok, path, overridesApplied, voice, voiceFallback, native }

await listVoices({ lang });
//   -> { ok, path, voices, defaultIdentifier, reason }
//      voices: [{ identifier, name, language, quality, isDefaultChoice }]
//      quality: iOS      "premium" | "enhanced" | "default" | "unknown"
//               Android  "very-high" | "high" | "normal" | "low" | "very-low"
//               web      "unknown"   (the Web Speech API exposes no quality)
```

`player/tts-bridge.js` exposes both on the object it hands the player.

`tools/mobile/tts-fixture.mjs`:

```
node tools/mobile/tts-fixture.mjs [--spine grilling|alcohol] [--beat N]
```

Extracts a `**Claim.**` paragraph from one of the two committed spines
(`docs/curation/grilling-history-spine.md`,
`docs/curation/alcohol-forms-spine.md`), runs it through the real
`web/foray-tts.js`'s `speak()`, and prints exactly what payload would be sent
to `window.Capacitor.nativePromise("ForayTts", "speak", …)` inside the
Capacitor shell — using a recording fake bridge instead of a real one, since
this is a Node process with no WebView.

This is **infrastructure verification, not a shipped feature.** There is still no
narration-AUTHORING UI and no foray-creation screen — that stays future product
work, gated on the fixture below actually passing on real devices. What changed is
narrower: a Foray whose data already carries a narration `script` is now spoken by
the player instead of failing to load.

## What was NOT verified, stated plainly

Same honesty standard `docs/mobile-shell.md`'s own "launched on Android: No"
line sets, and `docs/android-native-code.md`'s own claims table:

| Claim | How |
|---|---|
| The JS-side interface (message shape, lexicon matching, fallback behaviour, voice pass-through, `listVoices()` on every path) | **Executed**, in Node, against fakes. `tools/mobile/foray-tts.test.mjs`, 38 tests; `player/tts-bridge.test.js`, 14. Sixteen one-line mutations were applied and each turned a test red. |
| `tools/mobile/tts-fixture.mjs` produces the right payload from real spine text and the real lexicon | **Executed**, in Node. See the script's own "NOT PROVEN BY THIS RUN" footer for what this does *not* establish. |
| `AVSpeechSynthesizer` actually speaks the text, or honours an IPA override, on a real iOS device or simulator | **NEITHER MEASURED NOR INFERRED — UNVERIFIED.** No Mac, no simulator, no device ran this code. `ios/Tests/ForayTtsPluginTests/` is a placeholder XCTest target (mirrors `@capacitor/app`'s own shape) that has never been run. |
| `android.speech.tts.TextToSpeech` actually speaks the text, or that passing SSML `<phoneme>` markup into `speak()` changes anything audible | **NEITHER MEASURED NOR INFERRED — UNVERIFIED.** No emulator, no device. `docs/research/on-device-tts.md` §2 is explicit that whether Android SSML phoneme support does anything at all is unknowable from documentation and can only be settled by listening on a real device. |
| The plugin is discovered by `cap add ios` / `cap add android` the way `foray-audio` is | **NOT RUN.** `docs/android-native-code.md` §1's own table records `cap add android` finding `foray-audio` by executing it; that has not been re-run for this change, because this environment has neither an Xcode/CocoaPods toolchain nor an Android SDK. This is a real gap, not an oversight — flag it for a founder or a CI run with the right toolchain before merging with confidence, per `docs/ios-ci.md`'s own toolchain table. |
| Native (Swift/Kotlin — actually Java here, matching `foray-audio`'s own choice) code is unit-testable the way this repo's JS is | **It is not**, same as `foray-audio`. `ForayTtsPlugin.java` and `ForayTtsPlugin.swift` have no suite exercising them against a real `TextToSpeech`/`AVSpeechSynthesizer` — only the JS layer, and only against fakes, is tested here. |
| The voice-selection rules (best installed tier, exact-locale precedence, tie-break, uninstalled-voice fallback) | **NOT RUN, only authored.** `ios/Tests/ForayTtsPluginTests/` gained ten assertions over hand-built `VoiceOption` catalogues, each carrying the one-line mutation that kills it, and **nothing has executed them** — no `swift test` runs anywhere in this repo and the change was written on Windows. They compile as part of the package; that is all that is claimed. |
| That an Enhanced/Premium voice is INSTALLED on any particular phone, or what its identifier is | **NEITHER MEASURED NOR INFERRED.** They are per-language downloads. The identifier table above is documented naming convention, not a device reading — `listVoices()` on the phone is the only answer. |
| `ForayTtsPlugin.utteranceRate(playbackMultiplier:)` maps the player's speed onto AVSpeechUtterance's scale | **CALIBRATED FROM ONE READING; STILL COMPILED, NOT RUN.** `ios-build`'s `ios-shell` job builds this file (transitively, via `cap add ios`); nothing in this repo executes `swift test` on this package, so the assertions in `ios/Tests/ForayTtsPluginTests/` — and the mutations their comments name — have never run anywhere. What HAS been heard is a single point: HUMAN-ACTIONS.md #29's RESULT measured 1.5x at roughly 3x, and the mapping is fitted through that plus the definitional 1.0x anchor. **Everything between and beyond those two points is an estimate**, including the ladder's 2.0x stop. The doc comment on the function names the one device reading that would confirm the shape; nobody has taken it. |
| The player reaches this plugin at all, on a phone | **NOT RUN.** `player/tts-bridge.test.js` proves the wire against fakes in Node and `player/foray-playback.test.js` proves the committed script reaches an injected bridge. Whether `window.Capacitor.nativePromise("ForayTts", "speak", …)` resolves inside the real WKWebView has never been observed. HUMAN-ACTIONS.md #29 is the observation. |

## Preparing (not running) the §5.7 acceptance fixture

`docs/research/narrator-voice.md` §5.7 designs the fixture:
put each of the ~76 distinct lexicon terms in a short carrier sentence
(~4,500 characters total, an estimate), then have the actual on-device voice
speak it and have a human judge whether the pronunciation lands.
`docs/research/on-device-tts.md` §7 item 1 adapts that for on-device
specifically: run it on **at minimum one recent iPhone, one recent
stock-Android device, and one OEM-skinned Android device**, given §2's
finding that Android's SSML phoneme behaviour is engine-dependent and
undocumented.

**What is prepared here:**
- The lexicon (`lexicon/hard-terms.json`) — the term list the fixture needs,
  ready to have IPA authored into it once a linguist/curator pass happens.
- The call path (`web/foray-tts.js`'s `speak()`, wired through
  `ForayTtsPlugin.swift`/`.java`) that a real fixture run would use.
- `tools/mobile/tts-fixture.mjs` as a starting point for a device-side runner
  — it currently proves the JS payload is correct; extending it to actually
  call the native plugin from inside a Capacitor shell (rather than a
  recording fake) is the next step, not something this card builds.

**What is explicitly NOT run here, and needs Joey's or Wyatt's hands:**
authoring IPA transcriptions for the lexicon (a linguistic task, not an
engineering one), building the carrier-sentence fixture text, and the actual
multi-device listening test. There is no way to fake or infer the result of
a human listening to a synthesized word — see `narrator-voice.md`'s own
labelling discipline ("Measured" / "Documented" / "Judgement") for why this
document does not attempt to.

**Pass/fail bar**, per `narrator-voice.md` §5.7 as adapted here: run the
fixture against each shortlisted voice/device; the winner is **the
combination needing the fewest lexicon entries to sound right**, not the one
with the nicest timbre. If the iOS/Android asymmetry `on-device-tts.md` §2
predicts holds (iOS's documented IPA attribute working reliably, Android's
undocumented SSML passthrough being hit-or-miss per engine), that is itself a
finding worth recording rather than something to average away.
