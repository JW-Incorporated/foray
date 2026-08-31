# On-device TTS — and the unlimited-creation / profitable question

Joey (2026-08-31), same message as the self-hosted-TTS follow-up: "What about
on-device narration? Like whatever reads my text messages out loud." — i.e.
the phone's own built-in system TTS (iOS's `AVSpeechSynthesizer` / Android's
`TextToSpeech`), as opposed to server-side Kokoro or ElevenLabs. Stated in the
same message as the hard framing for both documents: **"we want users to be
able to create forays, ideally without monthly limits, and we also want to be
profitable."**

**Scope, so this does not re-litigate its siblings.** `docs/research/narrator-voice.md`
picked the paid-cloud voice. `docs/research/self-hosted-tts.md` surveyed running a
model on Joey's own GPU. Neither considered synthesis that costs 4a nothing
because it never runs on 4a's infrastructure at all — it runs on hardware the
*listener* already owns, at the moment of playback. That is a different shape
of answer, not a third point on the same axis, and it is filed as a sibling
document for the same reason self-hosted-tts.md was: the founder's actual
question was never on the table until asked directly.

## How to read the labels

Same convention as the other two narrator documents:

- **Measured** — a number this document produced by counting something in this
  repo.
- **Documented** — somebody else asserts it, with a URL. First-party API
  reference is documented, not measured, even when it reads like ground truth.
- **Judgement** — an inference or recommendation, flagged so it can be argued
  with.

**No device was used and no audio was heard to produce this document.** Every
claim about what `AVSpeechSynthesizer` or Android's `TextToSpeech` can do is
sourced directly from Apple's and Google's own developer documentation
(fetched directly for this document, not from a blog or a Stack Overflow
answer, except where explicitly labelled as a secondary source used only to
illustrate a documented API in use). Nothing here was fetched from
`docs/research/corpus/`.

---

## 1. iOS: `AVSpeechSynthesizer` — and the pronunciation answer is a genuine surprise

**Documented, verified directly against Apple's own reference**
(`https://developer.apple.com/documentation/avfaudio/avspeechutterance`,
`https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice`,
`https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer`).

- `AVSpeechSynthesizer` is a first-party, on-device framework available since
  iOS 7.0, running with no network call and no API key.
- `AVSpeechSynthesisVoice.speechVoices()` enumerates every voice installed on
  the device; voices are selected by language/locale (`voiceWithLanguage:`) or
  by a specific `identifier`.
- **Apple documents a first-party IPA override mechanism, and it is not
  buried.** `AVSpeechUtterance` exposes
  `AVSpeechSynthesisIPANotationAttribute` — quoting Apple's reference
  verbatim: *"A string that contains International Phonetic Alphabet (IPA)
  symbols the speech synthesizer uses to control pronunciation of certain
  words or phrases."* It is applied via `attributedSpeechString`
  (`NSAttributedString`), not a markdown-style inline tag the way Kokoro's
  `misaki` G2P or Cartesia's `pronunciation_dict_id` work — the caller wraps
  the target substring in an attributed range carrying that attribute, with
  the IPA string as its value.
- `AVSpeechUtterance` also accepts a full SSML document via
  `init?(SSMLRepresentation:)`, which is a second, independent path to the
  same control surface for callers who would rather author markup than build
  an `NSAttributedString` programmatically.

**Judgement, and this is the single most consequential finding in this
document.** The premise stated in this card's own scope section — "this
repo's whole ElevenLabs preference hinges on exactly this capability
existing" — turns out to be **true of iOS's on-device engine too, and
documented at the same first-party level of confidence as Cartesia's
IPA override**, which `docs/research/narrator-voice.md` §6.2 already treated as
the strongest documented mechanism among the paid vendors surveyed. This is
not a community workaround: `AVSpeechSynthesisIPANotationAttribute` is
Apple's own constant, in Apple's own framework, with no vendor account, no
per-character billing and no rate limit. A working community example exists
independently (`ryanlintott`'s gist, cited here only as a working-code
illustration of an already-documented attribute, not as the source of the
claim) and shows the mechanism used exactly as the reference describes it.

**What is not documented, and matters.** Apple's reference does not state a
per-token success rate for IPA-attributed pronunciation the way ElevenLabs
states "80–90% consistency" for its dictionary feature — there is no
published accuracy figure to compare against `narrator-voice.md` §5.1's
number. And critically, **which system voices honour the IPA attribute is not
documented per-voice.** Apple's on-device voice catalogue spans multiple
synthesis tiers (compact/legacy formant-style voices through modern neural
"Enhanced"/"Premium" voices, downloaded per-language on demand), and nothing
in the reference states that every tier respects
`AVSpeechSynthesisIPANotationAttribute` equally. Section 5.7's
acceptance-fixture discipline applies here exactly as it does to every other
candidate in this narrator investigation, and arguably more so, because the
voice a fixture is run against on one iPhone is not guaranteed to be the voice
every listener's own device will actually use (§4).

---

## 2. Android: `TextToSpeech` — no documented first-party pronunciation override

**Documented, verified directly against Android's own reference**
(`https://developer.android.com/reference/android/speech/tts/TextToSpeech`,
`https://developer.android.com/reference/android/speech/tts/Voice`).

- `TextToSpeech` is a first-party, on-device (or engine-dependent,
  network-backed) framework. `speak(CharSequence text, int queueMode, Bundle
  params, String utteranceId)` is the entry point; `Voice` objects (with a
  documented `Locale`, `quality`, `latency`, and feature set) come from
  `getVoices()` / `getDefaultVoice()`.
- **The official Android reference documents no phoneme, IPA, or SSML
  attribute anywhere in the `TextToSpeech` or `Voice` API surface.** `speak()`
  takes a `CharSequence`; there is no `AVSpeechSynthesisIPANotationAttribute`
  equivalent, no `pronunciation_dict_id`, no documented markup dialect.
- **SSML `<phoneme>` tags work on Android only as an undocumented,
  engine-dependent side effect of passing markup text into `speak()`, not as
  a supported feature of the `TextToSpeech` class itself.** This is the
  clearest asymmetry with iOS in the whole survey, and it is worth stating
  precisely rather than by inference: a widely-cited Stack Overflow report
  (`stackoverflow.com/questions/3525424`, secondary source, cited only to
  illustrate the undocumented behaviour, not as the finding itself) found
  **no apparent SSML control from the `<phoneme>` element** on the
  then-shipping `com.svox.pico` engine, while `TomTom`'s navigation SDK
  documentation and a Chinese-language deployment writeup both show
  developers successfully passing `<speak><phoneme alphabet="ipa"
  ph="...">` strings straight into `tts.speak()` against Google's own TTS
  engine on more recent Android versions. **Both things can be true at once,
  and that is the finding**: whether a phoneme tag does anything at all
  depends on which of the several third-party TTS *engines* a given Android
  device has installed and selected as default (`com.google.android.tts`
  being the common one, but not the only one, and not guaranteed present on
  every OEM skin) — a variable `AVSpeechSynthesizer` does not have, because
  Apple ships exactly one first-party synthesis engine.
- **Reachability of Google's own neural on-device voices is confirmed, but
  their pronunciation-control surface is not.** Android's on-device TTS
  voices — the ones that already read notifications and text messages aloud,
  per the founder's own framing — are exposed through the same
  `TextToSpeech.getVoices()` call as every other installed voice; there is no
  separate "notification-reader" API. Google's server-side Cloud
  Text-to-Speech product (a different, paid product, not the on-device
  `TextToSpeech` class) documents first-party `<phoneme alphabet="ipa">`
  support with syllable stress markers — which confirms Google's synthesis
  stack is *capable* of honouring IPA markup, but that capability is
  documented for the cloud API, not for what ships inside the on-device
  `com.google.android.tts` engine's public interface.

**Judgement.** Android's on-device pronunciation-control story is the
opposite of iOS's: plausible and reportedly workable in practice on the
majority engine, but with **zero first-party documentation guaranteeing it**,
versus a device population that is not uniform in which engine is even
installed. Treat Android SSML phoneme support as **unverifiable from
documentation alone** — the only way to know whether it holds on a specific
device is the acceptance-fixture listening test, run on that device, with
whatever engine that device actually has selected. This is a materially
weaker starting position than iOS, self-hosted Kokoro, or Cartesia, all three
of which have an unambiguous first-party statement that the capability
exists.

---

## 3. The architecture question the card raised, and it resolves in one direction

**Documented, from `docs/mobile-shell.md` §0 and §1.** 4a ships as **a
Capacitor shell around the real web player**, not a native Swift/Kotlin app.
The shell loads the same `index.html`/`app.js`/`player/` the website serves,
copied at build time; `ios/` (SwiftUI + ForayKit) sits side by side with the
shell and is explicitly **not** the host for the web player — `mobile-shell.md`
§1 settles this as a "resolved before anything was scaffolded" question, not
an open one. So "on-device TTS" for 4a is reached, if at all, through
JavaScript inside the WKWebView (iOS) / WebView (Android) the shell already
runs, not through a hand-written native call into `AVSpeechSynthesizer` or
`android.speech.tts.TextToSpeech` directly.

**Documented, on what that JavaScript path actually is: the standard Web
Speech API, and it is a materially worse surface than either native API.**
The W3C Web Speech API spec (`https://w3c.github.io/speech-api/`, fetched
directly) exposes `speechSynthesis.speak(new SpeechSynthesisUtterance(text))`,
with `text`, `lang`, `voice`, `volume`, `rate`, `pitch` — **no phoneme, no IPA
attribute, no dictionary field of any kind.** The `text` attribute *may* be a
"complete, well-formed SSML document," but the spec's own wording is the
finding: *"For speech synthesis engines that do not support SSML, or only
support certain tags, the user agent or speech engine must strip away the
tags they do not support and speak the text."* That is a documented
**license to silently discard `<phoneme>` markup**, not a guarantee it is
honoured — the same "silent failure" shape `narrator-voice.md` §5.1 already
flagged as the worst kind of pronunciation-control failure for ElevenLabs'
model-dependent dictionary support, except here it is the spec itself saying
so, for every browser engine, on every platform.

**Documented, and the practical cross-browser experience matches the spec's
caveat rather than its optimistic reading.** A cross-browser survey of the
Web Speech API (`dev.to/jankapunkt`, secondary source, cited for its
enumeration of quirks rather than as an authority) catalogues iOS-required
`lang` fallbacks, Android-Chrome-required `voiceURI` workarounds, and voice
lists that differ by platform and browser — none of it about pronunciation
control, all of it about the API's general reliability. No source found in
this survey documents SSML phoneme tags actually being honoured inside
`speechSynthesis.speak()` on either mobile WebView.

**Two real paths exist, and they trade capability for engineering cost —
verified rather than assumed, per this task's own instruction:**

1. **Plain Web Speech API inside the Capacitor WebView (`speechSynthesis`).**
   Zero native code, zero new dependency. **No documented pronunciation
   control on any platform** — this is the path that inherits the spec's
   "may silently strip tags" caveat with nothing to fall back on.
2. **A native Capacitor plugin bridging to `AVSpeechSynthesizer` /
   `android.speech.tts.TextToSpeech` directly.** Two real options exist and
   were checked directly rather than assumed:
   - `capacitor-community/text-to-speech` (MIT, GitHub, checked directly) —
     wraps both native APIs behind `speak({ text, lang, rate, pitch, volume,
     voice, category })`. **No phoneme/IPA parameter in its documented
     options.** It calls the native engines with plain text; it does not
     expose iOS's `AVSpeechSynthesisIPANotationAttribute` or forward SSML.
   - Capawesome's `@capawesome-team/capacitor-speech-synthesis` (checked
     directly) — a broader API surface (`synthesizeToFile`, `boundary`
     events, per-voice availability checks), but its documented option list
     is the same shape: pitch, rate, volume, voice — **still no
     phoneme/IPA passthrough documented.**
   - So even the "build a native bridge" path, at the *plugin* layer 4a
     would realistically adopt rather than hand-roll, **does not currently
     expose iOS's own IPA attribute to JavaScript.** Reaching it for real
     would mean either a genuinely custom Capacitor plugin (the mechanical
     work `mobile-shell.md` §2.4 already describes for `foray-audio`, a
     precedent that this is buildable, not a hypothetical) written against
     `AVSpeechSynthesisIPANotationAttribute` directly, or upstreaming that
     capability into one of the community plugins.

**Judgement, and it is the second load-bearing finding of this document.**
The build-complexity question this card asked to resolve rather than assume
resolves cleanly: **native plugin work is required either way to reach any
pronunciation control at all**, because neither the standard Web Speech API
nor the two existing community Capacitor plugins expose one, even though iOS
itself documents one at the OS level. The "ideally without monthly limits"
framing is not blocked by a $0-vs-$0.05 cost question here — it is blocked by
**an engineering gap between what the OS provides and what the app's current
architecture can reach without new native code.**

---

## 4. Consistency / identity — the tradeoff `narrator-voice.md` §4 already named, sharpened

`narrator-voice.md` §4.4 recommends **one voice, catalogue-wide**, on grounds
that a single recognisable narrator identity compounds in the listener's
favour and a Foray back catalogue is an archive that should not fracture
across voice changes. On-device TTS cannot deliver that, structurally, not as
an engineering gap that could be closed later.

**Documented, and this is a matter of API design, not a missing feature.**
Both `AVSpeechSynthesisVoice.speechVoices()` and Android's
`TextToSpeech.getVoices()` return **whatever voices are installed on that
specific device**, which varies by OS version, by manufacturer (Android OEM
skins ship different default engines and voice packs), by which optional
voice packs the user has downloaded, and by the user's own system TTS/voice
settings — a `System Settings > Accessibility > Spoken Content` choice the
app does not control and, on iOS, is not even guaranteed to be a *stable*
setting: Apple ships "Personal Voice" and periodically updates its neural
voice roster.

**What this delivers instead, stated plainly per the card's instruction:**
every listener hears their *own* device's default (or chosen) system voice —
not a 4a-selected voice, not a pinned identity, not necessarily even the same
gender or accent from one listener to the next. This is the polar opposite
of `narrator-voice.md` §3.2's Default-voice-retirement concern (a vendor
retiring one shared voice ID) — here there is no shared voice ID to retire,
because there was never one voice to begin with.

**Judgement.** Whether that is acceptable depends entirely on *which* forays
this is being considered for, and the card's own framing supplies the
answer: this document is about **user-created forays**, not the founder-curated
barbecue/alcohol spines `narrator-voice.md` was scoped to. A catalogue-wide
single narrator identity is a coherent goal for 4a's own curated flagship
content; it is not a coherent goal for content a given *user* generated for
themselves, where "the narrator sounds like my phone" is arguably the
expected and even desirable behaviour — the same way a text-message
read-aloud voice is expected to be *your* phone's voice, not a shared brand
identity. **Read narrowly, on-device TTS does not fail the consistency bar —
it is simply answering a different consistency question than the one
`narrator-voice.md` was asked.** It would be a dealbreaker only if 4a wants
every listener of a given user-created foray to hear an identical voice
regardless of device — nothing in the card's framing asks for that, and this
document does not assume it.

---

## 5. The finding this card did not ask for directly, and it changes the economics section: no server-side render means no review gate and no hosting cost, in either direction

**Documented, and it follows mechanically from §3's architecture finding.**
Kokoro and ElevenLabs both synthesize **once, on 4a's infrastructure, at
Foray-creation time**, producing an audio file 4a stores and serves —
that is what `narrator-pipeline.md`'s entire cost model (§3, §4, the egress
table below) is pricing. On-device TTS synthesizes **live, on the listener's
own device, at playback time**, from the narration *script* (plain text)
shipped as part of the Foray's data, not from a rendered audio file at all.

Two consequences follow, one favourable and one that is a genuine cost this
document has to name rather than gloss over:

**Favourable: the hosting/egress cost `narrator-pipeline.md` computed
disappears entirely, not just shrinks.** That document's own numbers:
19,712 characters per Foray, 110.9 MB of rendered audio for ten Forays, and
an egress ceiling of **450 Foray *plays* a month on Supabase's free 5 GB
tier** (22,546/month on the $25/mo Pro tier, 9,018/month on GitHub Pages'
soft 100 GB limit) — because every *play*, not just every *creation*, re-serves
audio bytes unless caching saves it. On-device narration ships **~20 KB of
text** per Foray inside the same JSON payload `mobile-shell.md` §3 already
bundles narration-adjacent data in, and every playback is a local computation
with zero bytes served. **The egress ceiling that `narrator-pipeline.md`
treated as a real future constraint for cloud/self-hosted narration does not
exist for on-device narration at any play volume.**

**Unfavourable, and this is the finding this document has to be honest
about: 4a loses the ability to pre-listen to what ships.** `narrator-pipeline.md`
§"How far the player's narration support goes" and the #226 review-gate
discipline both assume a human curator listens to and approves each rendered
narration beat before it goes live — that is only possible when 4a controls
the render. When the render happens live on each listener's own device, in
whatever voice that device has selected, **there is no single rendered
artifact for anyone at 4a to review**, and no way to guarantee the render a
curator hears on their own test device matches what any given listener's
device will actually produce.

**Judgement, and it is the honest resolution of that tension, not a dodge.**
This is not actually a new problem specific to narration cost — it is the
same scaling problem `self-hosted-tts.md` §4 already named for cheap
regeneration: *"a curator's attention does not get cheaper because the
compute did."* Per-beat human review was never going to be the operating
model for **user-created, unlimited-volume forays** in the first place —
the founder's own framing ("users able to create forays... without monthly
limits") describes a scale at which a human reviewing every beat is not
viable regardless of which narration engine renders it. Read that way,
on-device TTS is not introducing a review gap that didn't already exist for
this specific product surface; it is removing a review step that the
"unlimited creation" goal already implied 4a could not staff at scale. The
acceptance-fixture discipline `narrator-voice.md` §5.7 and `self-hosted-tts.md`
§5 both demand before *any* voice choice ships narration still applies here —
it just validates the mechanism (does the IPA attribute work on a
representative device sample) once, rather than validating every rendered
beat forever after.

---

## 6. The business question, answered directly

### 6.1 What each path actually costs per Foray, restated at scale

`narrator-pipeline.md` §0/§3.4 established the pilot-scale numbers this
section extends: **19,712 characters per Foray**, ElevenLabs' API-line
pricing at **$0.05–$0.10 per 1,000 characters** (`narrator-voice.md` §1,
verified against `elevenlabs.io/pricing/api` directly), and a **3× regeneration
factor** the original cost sketch used for iteration before a beat ships.

| | on-device | self-hosted Kokoro | cloud ElevenLabs |
|---|---|---|---|
| marginal cost / Foray, synthesis | **$0**, always | **$0** (electricity only; `self-hosted-tts.md` §3), always | **~$0.99–$1.97** at $0.05–$0.10/1K chars, before regeneration; **~$3–$6** with the 3× iteration factor |
| marginal cost / Foray, hosting | **$0** — ~20 KB of text ships inside data already bundled | audio file, same hosting cost column as ElevenLabs (§5 above) | audio file: ~11.1 MB/Foray at `narrator-pipeline.md`'s own figure |
| cost driver that actually scales | **none** — flat $0 regardless of creation or play volume | GPU time at creation (cheap; `self-hosted-tts.md` §2.5: well under 15 min GPU time per Foray) + storage/egress at play volume | API spend at creation + storage/egress at play volume |
| 1,000 user-created Forays | **$0 synthesis, $0 hosting** | ~$0 synthesis (GPU electricity, negligible); storage/egress identical to ElevenLabs column | **~$990–$1,970** synthesis (one-time, at creation), **before** iteration/regeneration; **~$3,000–$5,910** with the 3× factor. Hosting: 110.9 MB × 100 ≈ **11.1 GB** stored; egress at Supabase Pro's 250 GB/month ceiling supports **~22,546 plays/month total across the whole catalogue**, shared across however many Forays exist |
| 10,000 user-created Forays | **$0 synthesis, $0 hosting** | ~$0 synthesis; storage 111 GB (exceeds Supabase Pro's tier, next tier needed); egress ceiling unchanged in kind | **~$9,900–$19,700** synthesis before regeneration, **~$30,000–$59,100** with the 3× factor — a one-time cost per Foray at creation, recurring only if forays are re-narrated. Storage: 1.1 TB |

**Judgement, on why the egress row does not simply scale by Foray count for
the two server-rendered paths.** `narrator-pipeline.md`'s egress ceiling
(450 / 22,546 / 9,018 plays a month) is a function of **plays**, not Forays
created — one popular Foray narrated once can burn through that budget by
itself. That is a genuinely different scaling axis from the per-Foray
synthesis cost above it, and it is the sharper constraint at real user
volume: a catalogue of 10,000 user-created forays, if even a fraction of them
get replayed regularly, hits the plays-based egress ceiling long before the
one-time synthesis spend becomes the binding cost. **On-device TTS is the
only one of the three paths where neither axis — creation count nor play
count — costs 4a anything at all.**

### 6.2 Does "unlimited + profitable" require on-device TTS clearing the pronunciation bar?

Answered directly, per the card's explicit request, with the product-call
boundary flagged where the evidence runs out:

- **If on-device TTS clears the pronunciation bar (the acceptance fixture,
  run per-platform, per §7 below): unlimited user-created foray narration is
  not merely profitable, it is free — $0 marginal cost at any volume, on
  either creation or replay, with no tier, no cap, and no engineering ceiling
  to plan around.** This is the strongest form of the answer the founder's
  framing was reaching for.
- **If it does not clear the bar** (either because the pronunciation control
  genuinely fails on real hard-term text, or because reaching it costs more
  native-plugin engineering than 4a wants to spend right now, per §3's
  finding that neither existing Capacitor plugin exposes it today): the
  fallback is **self-hosted Kokoro**, not cloud ElevenLabs, for exactly the
  reason `self-hosted-tts.md` §2.1 already established — Kokoro's documented
  per-word IPA override is comparable in kind to Cartesia's and to iOS's own
  `AVSpeechSynthesisIPANotationAttribute`, at genuinely $0 marginal synthesis
  cost regardless of scale. §6.1's arithmetic shows why this matters at real
  volume: cloud ElevenLabs at 10,000 forays is a **$10,000–$59,000** line
  item depending on regeneration discipline, where self-hosted Kokoro is
  electricity plus GPU-queue engineering — the same "rounding error at pilot
  scale, real number at product scale" shape `self-hosted-tts.md` §4 already
  flagged for the iteration-vs-review-gate distinction, now applied to the
  volume this card actually asked about.
- **State plainly which of the card's four framings this resolves to:**
  **(c), a hybrid — but not the hybrid the card's own draft phrasing
  anticipated.** The card offered "on-device for casual browsing, paid cloud
  tier for a premium voice option" as one shape of hybrid. The evidence in
  this document points at a different hybrid: **on-device TTS (once the
  native-plugin gap in §3 is closed) as the default, $0-cost narration path
  for unlimited user-created forays, with self-hosted Kokoro as the
  quality/consistency fallback for 4a's own curated flagship content** —
  where `narrator-voice.md`'s single-pinned-voice, catalogue-wide identity
  argument actually applies and where 4a can staff the review gate. Cloud
  ElevenLabs, per both sibling documents' own conclusions, was never the
  cost-driven choice to begin with (`narrator-pipeline.md` §3.4 called its
  pilot-scale cost "a rounding error"); it remains available as a
  premium/founder-content option but the arithmetic in §6.1 is the
  documented reason it does not have to be the *default* path for
  volume-unbounded user creation.
- **The one part of this that is a product call, not a technical one, flagged
  explicitly per the card's instruction:** whether "every listener hears
  their own device's voice" (§4) is an acceptable brand experience for
  user-created forays is Joey's call, the same way `self-hosted-tts.md`'s
  closing section flagged the Kokoro-vs-ElevenLabs quality tradeoff as the
  founder's to make. This document's contribution is narrower and load-bearing:
  **the cost case for on-device TTS does not depend on that product
  question being resolved in its favour** — it is $0 either way, at any
  scale, and the identity tradeoff is a separate axis from the
  unlimited-and-profitable question the card asked to have answered directly.

---

## 7. What has to happen before any of this ships

1. **Run the same acceptance fixture `narrator-voice.md` §5.7 designed**,
   against on-device voices specifically, on a representative device sample
   (at minimum: one recent iPhone, one recent stock-Android device, one
   OEM-skinned Android device given §2's engine-variability finding) — before
   choosing this path the same way §5.7 already gates ElevenLabs, Cartesia
   and Kokoro. This is the single highest-leverage next step named in this
   document, because §1 and §2's asymmetry (iOS documented, Android
   undocumented) is exactly the kind of claim §5.1 of `narrator-voice.md`
   already warned cannot be trusted without listening.
2. **Close the native-plugin gap identified in §3** — neither the plain Web
   Speech API path nor either surveyed Capacitor community plugin exposes
   iOS's own documented `AVSpeechSynthesisIPANotationAttribute` to the
   Capacitor shell today. This is buildable (precedent: `foray-audio`,
   `mobile-shell.md` §2.4), not a research question, and belongs to a future
   implementation card, not this one.
3. **A founder decision on the voice-identity tradeoff in §4**, scoped
   explicitly to user-created forays rather than to `narrator-voice.md`'s
   founder-curated catalogue, which this document does not have standing to
   resolve.

---

## 8. What this document could not establish

- **Whether Android's SSML phoneme behaviour holds on any specific device.**
  §2 found conflicting secondary reports and no first-party documentation
  either way; this is unresolved without the fixture in §7.1.
- **Whether iOS's own on-device voices differ in how faithfully they honour
  `AVSpeechSynthesisIPANotationAttribute`** — Apple's reference documents the
  attribute exists, not a per-voice compliance guarantee.
- **Long-form (multi-minute) on-device narration quality** — exactly the gap
  `narrator-voice.md` §6.1 and `self-hosted-tts.md` §2.4 both already flagged
  as unstudied for their own candidates; nothing in this survey closes it for
  on-device voices either, and if anything the gap is wider, since on-device
  voices are optimized by both vendors primarily for short utterances
  (notifications, directions, text messages) rather than narration.
- **Whether shipping narration scripts as bundled text, rather than as
  server-controlled audio, raises any content-moderation or quality-drift
  risk specific to user-created forays at scale** — a real question given
  #226's off-beat-narration concern in `narrator-pipeline.md`, but outside
  this document's remit, which was cost and technical capability, not
  content policy.
