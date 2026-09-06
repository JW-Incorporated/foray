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

---

## 9. Addendum, 2026-09-01 — does on-device narration survive a locked screen? (§9.1 of `docs/curation/generation-architecture.md`)

This continues the investigation above rather than opening a new one — §1–§8 established that
a native plugin is required to reach any pronunciation control at all; that plugin
(`mobile/plugins/foray-tts/`) is now built, wrapping `AVSpeechSynthesizer` on iOS and
`TextToSpeech` on Android. This section answers the question the generation-architecture
document raised against that plugin: **does the plugin, as built, survive a locked screen** —
the question `docs/research/mp1-background-audio.md` already settled for a plain `<audio>`
element (yes on iOS, with one caveat; needs native code on Android), but never asked of
speech synthesis specifically.

**No device was used and no audio was heard to produce this section**, same discipline as §0
above. Every claim is sourced to Apple's own developer documentation/WWDC session captions, or
labelled as an inference from this repo's own prior *measured* findings in
`mp1-background-audio.md`.

### 9.1 iOS: `AVSpeechSynthesizer` shares the app's `AVAudioSession` by default — this is the load-bearing documented fact

**Documented, first-party — Apple's WWDC20 session 10022, "Create a seamless speech experience
in your apps"** (`developer.apple.com/videos/play/wwdc2020/10022`), quoting the session's own
captioned transcript verbatim: *"By default, [`usesApplicationAudioSession`] is set to `true`
on your `AVSpeechSynthesizer`, and speech audio will use your application['s] shared audio
session."* Apple's reference page for `AVCaptureSession.usesApplicationAudioSession` (a sibling
property on a different class, same mechanism) confirms the default is `true` and that setting
it `false` is what opts an object *out* of the shared session, which corroborates the WWDC
reading rather than standing alone.

**What this means, and why it is the central finding of this section.** `AVSpeechSynthesizer`
is not a separate audio subsystem from `<audio>`/`AVPlayer` on iOS — by default it plays through
the *same* process-wide `AVAudioSession` singleton that `PlayerQueueManager.swift` line 555
already configures (`session.setCategory(.playback, mode: .spokenAudio, options: [])`) and that
WebKit itself configures automatically the moment a page's `<audio>` element plays
(`mobile/README.md` §"The one line iOS needs": *"WebKit sets the `AVAudioSession` category to
`MediaPlayback` itself"*). This is the same mechanism `mp1-background-audio.md` measured
surviving backgrounding with 0.0045 s overshoot — not a different, weaker one. **If the app's
shared audio session already holds an active `.playback`-family category and is active at the
moment `speak()` is called, `AVSpeechSynthesizer` inherits that same background-audio grant.**
This directly weakens the generation-architecture document's own pessimistic default reading
("very likely stops when the WebView is backgrounded") — that reading was written assuming
`speechSynthesis` (the Web Speech API), which is a genuinely different, undocumented path (§9.2
below), not assuming the native plugin that was actually built.

**What is NOT documented, and is the real gap.** Apple's reference does not state that
`AVSpeechSynthesizer.speak()` *activates* the session or sets its category itself — the WWDC
wording is "will use," not "will configure." A synthesizer instance with the default
`usesApplicationAudioSession = true` rides on whatever category is already active; it is not
shown to set one. This matters concretely for **this app's own current implementation**:

**Judgement, checked directly against `ForayTtsPlugin.swift` as built (`mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift`), not assumed.**
The plugin's `speak()` method (lines 46–117) never touches `AVAudioSession` — no
`setCategory`, no `setActive`, no read of the current route or category. It only builds an
`AVSpeechUtterance` and calls `synthesizer.speak(utterance)`. Given the WWDC finding above, this
means: **narration audio's background survival is entirely parasitic on some other code path
having already put the shared session into an active `.playback`/`.spokenAudio` state** —
either `PlayerQueueManager.swift`'s own configuration (uncompiled/unused per `mobile-shell.md`
§1 — the shell runs the JS player, not that Swift file) or WebKit's own auto-configuration when
an `<audio>` element is concurrently playing. **Neither is guaranteed to be true at the moment a
pure narration item plays with no `<audio>` tape item active alongside it** — and per
`generation-architecture.md` §1.2/§4.5, a narration-only Foray (a "Foray of Carries," fully
AI-narrated, explicitly permitted at 100% share) is exactly the case where nothing else would be
holding that session open. **This is the one concrete plugin gap this investigation surfaces**
— named here per this card's own constraint, not fixed in this card.

### 9.2 The Web Speech API (`speechSynthesis`) in a WKWebView — no documented survival mechanism, and general-purpose evidence points the other way

**Documented, WebKit/W3C.** The W3C Web Speech API spec
(`w3c.github.io/speech-api/`, already cited in §3 above) says nothing about background or
locked-screen behavior at all — the spec is silent on power/lifecycle state entirely, in either
direction. **This is a real absence, not a "no problem found."** Apple's own WebKit
documentation likewise documents no background-audio guarantee for `speechSynthesis` anywhere
in its `<audio>`/media-background-audio guidance — that guidance (§9.1 above, `mobile/README.md`)
is scoped explicitly to `<audio>`/`AVPlayer`-family media elements, which is a documented,
first-party different code path from `speechSynthesis`'s internal (undocumented) synthesis
engine inside WebKit.

**Documented, and directly relevant: WKWebView JavaScript execution itself is suspended when
the hosting app backgrounds, unless something is actively holding a background assertion.**
Multiple threads on Apple's own developer forums (`developer.apple.com/forums/thread/64150`,
`/111247`, `/671830` — cited as illustrations of a widely-reported, Apple-forum-hosted behavior,
not as the primary authority; the primary finding is `mp1-background-audio.md`'s own measured
WebKit process-lifecycle log lines, §0b/§4.1b above, showing `didChangeThrottleState(Suspended)`
and `applicationIsAboutToSuspend` firing on a real WebKit process once no assertion is held)
report that a `WKWebView`'s JS execution pauses/freezes when the app is backgrounded and resumes
only in the foreground, **by design** — one reply from the same thread states plainly: *"This is
by design, for the same reasons any app that is suspended no longer gets to execute code."*
`speechSynthesis.speak()` runs inside that same JS/WebKit execution context. Unlike a native
`AVSpeechSynthesizer` call (§9.1), there is no documented mechanism by which invoking
`speechSynthesis` from page JS causes WebKit to acquire or hold a background audio assertion —
the assertion-holding mechanism `mp1-background-audio.md` measured is tied to the `<audio>`/media
element lifecycle specifically (`WebPageProxy::clearAudibleActivity`, `updateAudibleMediaAssertions`
— both keyed to the page's *media elements*, not to arbitrary JS execution or the Web Speech
API).

**Judgement.** Nothing here proves `speechSynthesis` stops the instant the screen locks — that
claim would itself be an unlabelled inference of exactly the kind this repo's research
convention exists to flag. What the documentation supports is narrower and sufficient for a
verdict: **the Web Speech API has no first-party documented background-audio exemption of any
kind**, and the general mechanism that would be required for one to exist (an active media
assertion) is, per this repo's own prior measurement, keyed to `<audio>`/media elements rather
than arbitrary script execution. This is the opposite documentation posture from §9.1's native
path, where a first-party, session-sharing mechanism is at least named. The generation-architecture
document's instinct to prefer the native plugin over Web Speech is confirmed by this section, not
merely repeated.

### 9.3 What documentation alone settles, and what it cannot

**Settled by documentation, to the standard this repo holds itself to:**

- The native `AVSpeechSynthesizer` path and the Web Speech API path are **not symmetric risks**.
  The native path has a documented, first-party mechanism (`usesApplicationAudioSession = true`)
  by which it *can* inherit exactly the background-audio grant `mp1-background-audio.md` already
  measured working for `<audio>`. The Web Speech API path has no such mechanism documented
  anywhere, by Apple, WebKit, the W3C spec, or Capacitor.
- The currently-built `foray-tts` iOS plugin does not itself configure or activate the shared
  audio session — it depends entirely on that session already being in the right state, which is
  not guaranteed for a narration-only Foray. **This is a real, specific, checked-not-assumed gap**
  in the plugin as it stands today (§9.1), separate from and narrower than the
  generation-architecture document's original blanket "very likely stops" framing.
- Capacitor's own documentation was checked and contributes nothing beyond what `mobile/README.md`
  (this repo's own prior research, §7 of `mp1-background-audio.md`) already established: Capacitor
  does not manage `AVAudioSession` itself on iOS: the one `UIBackgroundModes: audio` Info.plist
  key plus whatever code sets the session category is the entire mechanism, with no
  Capacitor-specific TTS accommodation documented anywhere in Capacitor's docs or the two
  community TTS plugins already surveyed in §3 above.

**NOT settled by documentation, and this is the honest limit of what this section can do:**

- **Whether the native plugin, with its current implementation (no explicit session
  configuration), actually survives a locked screen in practice.** Documentation establishes the
  *possibility* via session inheritance; it does not establish that the inheritance actually
  holds at the exact moment a narration-only Foray calls `speak()` with no `<audio>` element
  concurrently active. This is exactly the class of claim `mp1-background-audio.md` §0/§4.1b
  already demonstrated cannot be trusted from documentation or even from a Simulator — measured
  Simulator behavior there was shown to differ from a real device on the identical question for
  `<audio>` (`HUMAN-ACTIONS.md` #11's own "a Simulator is not a device" caveat), and nothing
  about `AVSpeechSynthesizer` changes that limitation.
- **Whether the Web Speech API genuinely stops immediately, after some delay, or unpredictably**
  — documentation supports "no guarantee exists," not a specific failure mode or timing.

**Verdict, stated plainly per this card's instruction: this needs a real, locked, physical
device test. It cannot be settled from documentation alone.** The exact test to run is specified
in §9.4 below and is filed as `HUMAN-ACTIONS.md` item #29.

### 9.4 The exact test to run, and the plugin change to make first

**Before testing:** the plugin gap named in §9.1 should be closed first, in a follow-up
engineering card (explicitly not this one, per this card's scope constraint) — have
`ForayTtsPlugin.swift`'s `speak()` (or its `load()`) explicitly set
`AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])` and
`setActive(true)` before calling `synthesizer.speak()`, mirroring exactly what
`PlayerQueueManager.swift` line 555 already does for the (currently unused) Swift player and
what WebKit does automatically for `<audio>`. Without this, the test below may fail for a reason
that is fixable in five minutes rather than a reason that invalidates the native-plugin approach
— so running the test against the current, unmodified plugin risks a false negative that
looks like a hard blocker on §1.2 when it may only be a missing session call.

**The test, once a build exists carrying that fix (or, if run against today's code, with the
result explicitly labelled as testing the *unfixed* plugin):**

1. Build the Capacitor iOS shell (`mobile-shell.md` §0/§6 — `npm run add:ios`, build via Xcode or
   the existing CI path) with the `foray-tts` plugin wired to a single test call site that speaks
   a long (60+ second) test sentence on a button press — the existing
   `tools/mobile/tts-fixture.mjs` harness's approach, or a minimal ad hoc button, either is fine.
2. Install on a real iPhone (TestFlight or a debug build over USB — `HUMAN-ACTIONS.md` #19/#16
   cover the account/signing prerequisites if not already done).
3. Ensure `UIBackgroundModes: audio` is present in `Info.plist` (`mobile/README.md` — should
   already be true per `mobile-shell.md` §6 item 2, confirm rather than assume).
4. Trigger the test narration call so speech begins.
5. **Lock the phone immediately** (side button), and leave it locked and in your pocket.
6. Wait at least 30 seconds — long enough to exceed both the 5 s audible-activity-clear and the
   10 s foreground-assertion-release windows `mp1-background-audio.md` §4.1b measured for the
   `<audio>` path, so a pass here is evidence of the same order of magnitude as that document's
   own result, not a near-miss.
7. Unlock and check: **did the test sentence finish playing, or did it stop partway through?**
   If it stopped, note roughly how many seconds of the 60+ second sentence were heard before
   silence.
8. Report the result on the relevant GitHub issue/PR: "native TTS plugin, locked screen, N
   seconds hidden, [continued throughout / stopped after ~X seconds]."

**Worked if:** there is a written result for at least one real iPhone stating whether the test
sentence played to completion with the screen locked, matching the reporting bar
`HUMAN-ACTIONS.md` #11 already sets for the `<audio>` case.

### 9.5 Addendum, 2026-09-03 — both prerequisites landed, and one more was found

**§9.4's "before testing" fix is in.** PR #389 (2026-09-01) made `ForayTtsPlugin.swift`
call `AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])`
and `setActive(true)` immediately before `synthesizer.speak(utterance)`. §9.4's warning
about a false negative therefore no longer applies: a failure on a real device now means
something.

**A second, unrelated defect surfaced while making the test runnable, and it would have
corrupted the result.** `speak()` assigned the incoming `rate` straight onto
`AVSpeechUtterance.rate`. The value arriving is the player's playback-speed MULTIPLIER —
`player/playback-rate.js`'s ladder, where `1` is the listener's normal speed and is the
default nobody has to choose. `AVSpeechUtterance.rate` is a different scale entirely:
`AVSpeechUtteranceMinimumSpeechRate` … `AVSpeechUtteranceMaximumSpeechRate` with
`AVSpeechUtteranceDefaultSpeechRate` (0.5) as ordinary speech. So the default case mapped
onto the FASTEST rate the synthesiser has, for every listener, on every line.

Two consequences worth recording separately:

- **For the product:** every narration line would have been read at maximum speed. Not a
  subtle regression — the kind of thing one device test finds immediately, which is
  precisely why nobody found it: nothing had ever called the plugin from the player.
- **For §9.4's test:** a 99-second script read at maximum rate finishes in roughly the
  same window as the 30-second lock, and unintelligibly. The founder could not have
  reported which marker he heard, so the measurement would have come back ambiguous for
  a reason that has nothing to do with the question.

`ForayTtsPlugin.utteranceRate(playbackMultiplier:)` now converts, clamped to the
framework's own range, written against its constants rather than the literals. **Android
needed no change**: `TextToSpeech.setSpeechRate()` already takes a multiplier where 1.0 is
normal, which is why `ForayTtsPlugin.java` could pass the value through. The two platforms
disagreeing about what one JSON field means is the underlying hazard here, and it is now
stated in both plugins' comments.

> **Superseded in part by §9.6.** The conversion described in this paragraph —
> `AVSpeechUtteranceDefaultSpeechRate × multiplier` — fixed the 1.0x case and was wrong
> everywhere else; the device says 1.5x played at roughly 3x. Read §9.6 before quoting
> this paragraph. What survives it unchanged is the Android half.

**The mapping is compiled, not run.** `ios-build`'s `ios-shell` job builds this file;
nothing in this repo executes `swift test` on the package, so the assertions added to
`ios/Tests/ForayTtsPluginTests/` have never run anywhere. Whether 1.0x SOUNDS like
ordinary speech is a device observation, and it is one more thing #29 comes back with.

**How the test is reached, since it needed solving and the answer is not obvious.** The
test content is a real Foray in `data/forays.json` (`tts-locked-screen-check`) whose first
item is a script-only narration line — so the measurement runs the shipped path rather
than a synthetic harness. It is a `draft`, which made it unreachable in the native app:
`?foray=<id>` is the only unlock and it reads `location.search`, which is permanently
empty behind `capacitor://localhost/`. `withDiagnosticUnlock()` in
`player/foray-resolve.js` unlocks that one id when `window.Capacitor` exists, so the
native app lists it and the public website still does not. Steps, and the deletion that
follows the answer, are in `HUMAN-ACTIONS.md` #29.

### 9.6 Addendum, 2026-09-05 — the rate mapping is now CALIBRATED, from exactly one device reading

`HUMAN-ACTIONS.md` #29 came back (RESULT, 2026-09-05). The headline answer is §9.1's:
`AVSpeechSynthesizer` keeps speaking with the screen locked. This section is about the
first of the three things the run surfaced that it was not looking for.

**The measurement.** Requesting the player's **1.5x** stop was heard at **roughly 3x**
normal speed. Under the mapping that build shipped, 1.5x asked for utterance rate
`AVSpeechUtteranceDefaultSpeechRate × 1.5` = **0.75**. So: *rate 0.75 ≈ 3x normal*, on
one iPhone, in one session, reported by one listener to one significant figure.

**Why the old mapping was wrong in a way documentation could not have caught.** Apple
documents `AVSpeechUtteranceMinimumSpeechRate` … `AVSpeechUtteranceMaximumSpeechRate`
with `AVSpeechUtteranceDefaultSpeechRate` as ordinary speech, and documents **nothing**
about what a step on that scale is worth in multiples of speaking speed. §9.5 assumed the
only relationship available without a device — proportionality — and the function's own
comment said so, in as many words: *"NOT PERCEPTUALLY LINEAR … Measuring that needs a
device."* The assumption turns out to be badly off: the 0.5→1.0 half of Apple's scale
spans normal speech to unusably fast, so proportionality compresses the entire useful
ladder into its bottom sliver and overshoots everywhere above 1.0x.

**What replaced it, and the honest status of it.** Utterance rate is now affine in
`log(multiplier)` — equivalently, perceived speed is exponential in utterance rate:

```
perceived(r) = 3.0 ^ ((r − D) / (1.5·D − D))          D = AVSpeechUtteranceDefaultSpeechRate
rate(m)      = D + (1.5·D − D) · log(m) / log(3.0)
```

That rests on **two anchors and one assumed form**:

1. rate `D` = 1.0x. **Definitional**, from Apple's naming of the constant. Not measured.
2. rate `1.5·D` ≈ 3.0x. **The one reading above.**
3. Exponential, not linear. **Assumed.** It is the simplest one-parameter family through
   both anchors that stays sane over the whole scale — a straight line through the same
   two points reaches zero perceived speed at rate 0.375 and goes negative below it, on a
   scale whose minimum is 0.0 — and it matches how speed is heard, as ratios. Neither of
   those is evidence. With two points, infinitely many curves fit.

Resulting rates at the player's ladder (`[0.75, 1, 1.25, 1.5, 1.75, 2]`): **0.435, 0.500,
0.551, 0.592, 0.627, 0.658**. Only the second of those has anything behind it.

**The one reading that would settle the shape**, and it is cheap because the instrument
still exists: play the 99-second counting line from `tts-locked-screen-check` at the
ladder's **2.0x** stop and time it. This mapping predicts ≈2.0x wall clock, so ≈50 s. A
materially different number means the *form* is wrong and the fix is a third anchor, not
a nudge to the two constants. (§9.5's deletion note says the instrument goes when #29 is
answered; #29's RESULT deliberately keeps it alive for exactly this and for the voice
finding. It must still be gone before an App Store build.)

**Android is unaffected and was re-verified rather than assumed.** AOSP's own javadoc on
`TextToSpeech.setSpeechRate(float)` reads: *"Speech rate. 1.0 is the normal speech rate,
lower values slow down the speech (0.5 is half the normal speech rate), greater values
accelerate it (2.0 is twice the normal speech rate)."* That is a true multiplier with the
same meaning as `player/playback-rate.js`'s ladder, so `ForayTtsPlugin.java` passing the
value straight into `setSpeechRate` is correct and stays untouched. **iOS is the platform
with the mapping problem; do not make Android match it.** Note the asymmetry this leaves:
Android's speeds are exact by documentation, iOS's are an estimate off one point, so the
same Foray at 1.75x is not guaranteed to take the same wall time on the two platforms.
Nobody has measured that gap either.

**Still not run:** `swift test` on this package, anywhere. The XCTest assertions for the
new mapping — including the mutation each one names in its own comment — are compiled by
`ios-build`'s `ios-shell` job and executed by nothing. Their arithmetic was checked off
the device (each named mutation was computed and does move an asserted value); that is a
weaker claim than a red test and is written down as the weaker claim.

### 9.7 Addendum, 2026-09-05 — the device test ran, and §1's own finding had never been implemented

**#29's locked-screen question came back a pass.** Narration continued all the way through
with the screen off, which is the answer `Foray_Generation_Architecture.md` §9.1 called the
highest-priority open question in the document. That result stands.

**The same listen produced a second, unasked-for finding: the voice was "much worse than
the original test"** — the original being the Kokoro acceptance fixture, a server-side
neural voice. That comparison had been taken as "on-device TTS sounds worse than
server-side TTS", which would be a product conclusion. It was not. It was one line.

`ForayTtsPlugin.swift` set a voice only when a `lang` was passed, and set it with
`AVSpeechSynthesisVoice(language:)`. **That initialiser returns the system default voice
for a language, which is the compact/legacy formant tier.** §1 of this document had already
recorded the relevant fact, in its own words: the catalogue "spans multiple synthesis tiers
(compact/legacy formant-style voices through modern neural 'Enhanced'/'Premium' voices,
downloaded per-language on demand)", and §1 also recorded the API that reaches them —
"`AVSpeechSynthesisVoice.speechVoices()` enumerates every voice installed on the device;
voices are selected by language/locale (`voiceWithLanguage:`) or by a specific
`identifier`." The plugin used the first of those two and never the second. So the
listening test was not comparing Kokoro against iOS on-device; it was comparing Kokoro
against **the worst voice iOS has**, and the good ones were one method call away the whole
time.

**Worth recording as a research-process finding, not just a bug.** A document can state a
capability accurately, in the right section, and the implementation can still never use it,
because "the catalogue has tiers" reads as background rather than as an instruction.
Nothing in §1 said "and therefore never call `AVSpeechSynthesisVoice(language:)` on its
own." It does now, by way of this addendum.

**What changed** (`mobile/plugins/foray-tts/README.md` § "Which voice speaks" has the full
API): the plugin now enumerates `speechVoices()` and picks the highest quality tier
*actually installed* for the language, `speak()` takes an optional `voice` identifier, an
identifier that is not installed falls back and reports that it did, and a new
`listVoices()` reports the device's real catalogue with the tier of each.

**The catch, and it is the operationally important half.** Enhanced and Premium voices are
free but are **per-language downloads** — Settings → Accessibility → Spoken Content →
Voices. A stock iPhone that has never visited that screen carries only the compact tier, so
on that phone this change is inaudible: the best installed voice IS the robotic one. The
re-listen therefore needs a download first, which is `HUMAN-ACTIONS.md` #40.

**Nothing here has been heard either.** No device ran this code; `listVoices()` has never
returned a real catalogue; the identifier examples in the plugin README are documented
naming convention, not a device reading. The Swift assertions added alongside the change
have never been executed, because nothing in this repo runs `swift test` and the change was
written on a Windows machine.
