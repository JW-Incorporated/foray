# CarPlay: what it actually requires of 4a

**Status: research input, not a decision.** This document deliberately is **not** an ADR. It
does not decide anything and it does not record a decision. Ratifying a CarPlay direction is
the founder's call; this is the material that call should be made on. If a decision follows,
it belongs in `docs/DECISIONS.md` and/or `docs/adr/`, written by whoever makes it.

Scope: what Apple requires of a CarPlay **audio** app, whether the architecture recorded in
`docs/DECISIONS.md` (2026-08-17) — a Capacitor shell playing an HTML `<audio>` element — can
host it, and what it costs. No code was written. Nothing under `ios/`, `mobile/` or `player/`
was touched.

---

## 0. How every claim here was obtained

Labelled the way `docs/research/mp1-background-audio.md` §1 and
`docs/android-lock-screen.md` §0 label things, because *"a document that reports 'measured'
when it means 'read' is the failure mode this repo keeps paying for"*
(`docs/android-lock-screen.md:14-18`).

| Label | Meaning |
|---|---|
| **Read from Apple** | Quoted from a current Apple document, URL given. The strongest basis in this doc. |
| **Read from source** | Read out of a source tree at a named path (this repo, or a third-party repo at a pinned tag). |
| **Measured (prior)** | A measurement this repo already holds; cited, not re-run. |
| **INFERRED** | A consequence I derived from labelled facts. Flagged inline, every time. Not a measurement. |
| **UNVERIFIED** | Neither documented by Apple nor measured by anyone here. Named in §8. |

**Nothing in this document was measured by me.** No iOS device, Mac, or CarPlay head unit was
involved — none is available (`docs/mobile-shell.md:618-626`: nothing in this repo has ever
run on real iOS hardware). Every Apple claim is *read*, and every claim about how our code
would behave under CarPlay is either **INFERRED** or **UNVERIFIED**.

**Research-tool note, stated plainly per the brief:** the `WebSearch` budget for this session
was exhausted before I began, so **no keyword searching was performed at all**. Everything
below came from direct fetches of URLs I could name in advance — Apple's DocC JSON endpoints,
Apple's *CarPlay Developer Guide* PDF (dated **2026-06-08**, downloaded and text-extracted
locally because it exceeds the fetch size limit), the App Store Review Guidelines, and the
GitHub API for third-party source. Two consequences: **(a)** I could not survey non-Apple
experience reports, so every "how long does approval take" style question is unanswered rather
than approximated; **(b)** the entitlement request form itself is behind an Apple ID sign-in
wall and I could not read it (see §2). Where that leaves a hole, §8 names the hole.

Primary Apple sources:

- CarPlay Developer Guide, 2026-06-08 — <https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf> (cited below as **Guide**, with its own page numbers)
- CarPlay framework — <https://developer.apple.com/documentation/carplay>
- Displaying content in CarPlay — <https://developer.apple.com/documentation/carplay/displaying-content-in-carplay>
- Requesting CarPlay entitlements — <https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements>
- `CPNowPlayingTemplate` — <https://developer.apple.com/documentation/carplay/cpnowplayingtemplate>
- `CPListTemplate` — <https://developer.apple.com/documentation/carplay/cplisttemplate>
- `CPListItem` — <https://developer.apple.com/documentation/carplay/cplistitem>
- `CPTemplateApplicationScene` — <https://developer.apple.com/documentation/carplay/cptemplateapplicationscene>
- `MPNowPlayingSession` — <https://developer.apple.com/documentation/mediaplayer/mpnowplayingsession>
- `MPNowPlayingInfoCenter` — <https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter>
- `MPPlayableContentManager` — <https://developer.apple.com/documentation/mediaplayer/mpplayablecontentmanager>
- Human Interface Guidelines: CarPlay — <https://developer.apple.com/design/human-interface-guidelines/carplay>
- App Store Review Guidelines — <https://developer.apple.com/app-store/review/guidelines/>

---

## 1. The answer to the question that decides this

### 1.1 First, separate two things that are both called "CarPlay support"

The founder's sentence "CarPlay is happening" resolves to one of two very different asks, and
the whole cost estimate turns on which one it is.

**(a) "4a's audio comes out of my car speakers."** This needs no entitlement, no native code,
and no CarPlay framework. CarPlay is an audio *output route*; an app that plays audio plays
into it the same way it plays into Bluetooth.

- **Read from source** — `docs/research/mp1-background-audio.md` §7.3, quoted in
  `mobile/plugins/foray-audio/package.json:7` (the key literally named `"//no-ios"`): *"on iOS
  WebKit sets the AVAudioSession category itself for an audible `<audio>` element, so the
  entire iOS requirement is the UIBackgroundModes key."* That key is already injected by
  `tools/mobile/inject-background-audio.mjs`.
- **Read from Apple** (Guide p.29, "Audio handling"): *"Only activate your audio session the
  moment you are ready to play audio. When you activate your audio session, other audio
  sources in the car will stop."* Apple's model here is simply an app with an audio session,
  with no mention of entitlements or the CarPlay framework.
- **INFERRED** from those two: the shell as designed should already be audible over CarPlay,
  with zero new work. **UNVERIFIED** — nothing in this repo has run on real iOS hardware, so
  this is untested, like everything else on iOS.
- Latent hook worth knowing about: `player/queue-manager.js:561` already accepts
  `routeChanged({..., isCarRoute})` and only auto-resumes for a previously-seen car route. In
  production **nothing calls it with `isCarRoute: true`** (**Read from source** — grep finds
  only the manager, a reducer comment, and tests).

**(b) "4a has an icon on the CarPlay home screen, and I browse and start a foray from the car
display."** This is the CarPlay framework, it is entitlement-gated, and it is the subject of
the rest of this document.

If the founder's actual want is (a), most of what follows is not needed. **This distinction
should be settled before anything else in this document is acted on**, because (a) is
approximately free and (b) is the largest single piece of iOS work this product has ever
contemplated.

### 1.2 Is a native playback stack mandatory?

Answering the question as literally asked — *can a CarPlay audio app play through a
`WKWebView`'s `<audio>` element, or does CarPlay require AVFoundation/AVPlayer?* — the honest
answer has two halves, and the first half matters more than the question does.

#### A native **UI** layer in Swift is mandatory. Unconditionally. This is not in doubt.

CarPlay never renders your views. It renders *its* templates from data you supply. There is no
template that hosts web content, and web content is not one of the things a template accepts.

- **Read from Apple** (*Displaying content in CarPlay*): *"Use only the templates that the
  framework provides to create your app's CarPlay user interface."* Custom view drawing via
  `CPWindow` is available to **navigation apps only**; audio apps *"use the scene's interface
  controller exclusively for constructing their user interfaces"*
  (**Read from Apple**, `CPTemplateApplicationScene`).
- **Read from Apple** (Guide p.14, "Templates"): *"CarPlay apps are built from a fixed set of
  UI templates that iOS renders on the CarPlay screen… Each CarPlay app category supports
  specific templates and this is governed by the app entitlement. **Attempting to use an
  unsupported template triggers an exception at runtime.**"*
- **Read from Apple** (Guide p.30, "Startup"): *"All CarPlay apps must adopt scenes and declare
  a CarPlay scene to use the CarPlay framework."*
- **Read from Apple** (Guide, "Guidelines" p.4, guideline 7): *"Use templates for their
  intended purpose, and only populate templates with the specified information types."*

**So the browse UI and the now-playing UI must be Swift, using `CPListTemplate` /
`CPTabBarTemplate` / `CPNowPlayingTemplate`. No quantity of web code changes this, and it is
true regardless of what plays the audio.** This — not the player — is the fact that makes
CarPlay a project rather than a checkbox.

#### A native **player** is not *documented* as mandatory. But the path that avoids it rests on one undocumented behaviour.

What CarPlay actually reads for the now-playing screen is documented precisely:

- **Read from Apple** (`CPNowPlayingTemplate`): *"The Now Playing template displays information
  from `MPNowPlayingInfoCenter` and `MPNowPlayingSession`."* Also: it is a **shared singleton**
  (*"Instead of instantiating your own Now Playing template, CarPlay provides a shared instance
  that you configure"*, `CPNowPlayingTemplate.shared`), and it *"is only available in apps with
  the audio entitlement."*
- **Read from Apple** (Guide p.21): *"**You must be prepared to populate the now playing
  template at all times**"* — because the user can reach it from the CarPlay home screen
  directly, without going through your app.

Taking those two data sources in turn:

**`MPNowPlayingSession` is structurally closed to us.** Its only initializer is
`init(players: [AVPlayer])`, and **Read from Apple**: *"An `AVPlayer` object can have only one
Now Playing session."* Each session owns its own `nowPlayingInfoCenter` and
`remoteCommandCenter`. There is no way to construct one around a `WKWebView`, an `<audio>`
element, or anything that is not an `AVPlayer`. This door is closed by the type signature.

**`MPNowPlayingInfoCenter` is, on its face, open.** `MPNowPlayingInfoCenter.default()` is a
process-wide singleton holding a plain `nowPlayingInfo` dictionary. **Read from Apple**: *"An
object for setting the Now Playing information for media that your app plays."* Nothing in its
documentation restricts it to AVFoundation clients, and nothing says the app must be the thing
producing the audio. A Capacitor plugin could write it from Swift on every `timeupdate` the web
player already emits.

So a hybrid is *not documented as forbidden*: **Swift CarPlay templates + `<audio>` playback
inside the WKWebView + the host app writing `MPNowPlayingInfoCenter.default()` itself.**

**But that hybrid depends on something Apple does not document, and the reason to doubt it is
concrete.** WebKit *already* publishes now-playing information for an audible `<audio>` element
— that is the mechanism by which web audio gets lock-screen controls at all, and it is what
`navigator.mediaSession` feeds into (`player/media-session.js:1-4`, **Read from source**:
*"`navigator.mediaSession` is the browser's half of MPNowPlayingInfoCenter +
MPRemoteCommandCenter"*). In a Capacitor app, WebKit's publisher and our Swift publisher are
**two writers to the same process-wide now-playing state**. Which one `CPNowPlayingTemplate`
displays, whether the second write wins or is overwritten on the next `timeupdate`, and — the
harder half — whether `MPRemoteCommandCenter` transport targets registered by our Swift code
are invoked or are pre-empted by WebKit's, is **UNVERIFIED**. Apple documents neither
behaviour. I found no Apple document that mentions WKWebView in connection with
`MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`, or CarPlay, in either direction.

That single unknown is the fork in the road, and it is cheap to resolve (§7, step 3).

#### The second risk is bigger than the first, and it is architectural rather than documentary.

Two sentences from Apple, read together, describe a launch condition this architecture has
never faced:

- **Read from Apple** (Guide p.31): *"**Your app may be launched only on the CarPlay screen** so
  be sure to handle this use case."*
- **Read from Apple** (Guide p.29, "Accessing data while iPhone is locked"): *"CarPlay is
  frequently used while iPhone is in a locked state. Test your app thoroughly to ensure it
  works as expected when iPhone is locked."*
- **Read from Apple** (Guide, Guidelines p.4, guideline 3): *"**All CarPlay flows must be
  possible without interacting with iPhone.**"*

**INFERRED** (flagged: this is a reasoned consequence, not a measurement): on CarPlay connect,
4a can be cold-launched with *no iPhone-screen scene at all*, on a locked phone, and must
immediately return a populated root template. Every input needed to build that root list — the
three-document join of `forays.json` + `segments.json` + `segment-sources.json`, performed by
`player/foray-resolve.js` — lives in JavaScript inside a WKWebView that, in this launch, has
no reason to exist and no window to live in. The Swift layer must therefore either boot a
headless WKWebView and wait for the JS bundle to hydrate before it can draw a list, or read
that data natively.

This is worth stating flatly because it inverts the intuitive cost model: **the browse
hierarchy, not the player, is where the WKWebView architecture is most exposed.** And it points
at the cheap decomposition in §7 — `foray-resolve.js`'s job for *listing purposes* is a JSON
join producing titles, runtimes and artwork, which is small in Swift. The expensive port is
everything about *playback*.

#### Verdict on question 1

> **A native CarPlay UI layer in Swift is mandatory and non-negotiable — templates only, scene-based, entitlement-gated. That is settled by Apple's documentation and is not a judgement call.**
>
> **A native AVPlayer *playback engine* is not proven mandatory. One hybrid survives on paper (Swift templates driving `<audio>` over the Capacitor bridge, with Swift owning `MPNowPlayingInfoCenter`), and it hangs on one undocumented behaviour that a day behind a Mac would settle.**
>
> **Confidence: high on the first sentence, moderate on the second.** The first rests on four direct Apple quotations. The second rests on an absence of prohibition plus a named, testable unknown — and absence of prohibition is a weaker thing than permission.

Which means: **this is neither "a feature" nor definitively "a rewrite" yet.** It is a project
with a known, cheap, single experiment standing between those two answers. Running that
experiment before committing is the highest-value action available.

---

## 2. The entitlement process, and the sequencing question

**Read from Apple** (*Requesting CarPlay entitlements*): *"To integrate with CarPlay, you must
request the appropriate entitlement for your app's category at
https://developer.apple.com/contact/carplay and agree to the CarPlay Entitlement Addendum.
Apple reviews each application using predefined criteria. If your request meets the criteria,
Apple adds the entitlement to your developer account using managed capabilities."*

**Read from Apple** (Guide p.12, "Entitlements"): *"All CarPlay apps require a CarPlay app
entitlement specific to your app category… Apple will review your request. If your app meets
the criteria for the CarPlay app category, Apple will assign a CarPlay app entitlement to your
Apple Developer account and notify you."*

The entitlement we would want, **Read from Apple** (Guide p.13, table):

| Entitlement | Key | Minimum iOS |
|---|---|---|
| CarPlay audio app (CarPlay framework) | `com.apple.developer.carplay-audio` | iOS 14 |

Steps after a grant, **Read from Apple** (Guide p.12), verbatim in substance:

1. Apple Developer Account → Certificates, IDs & Profiles → Identifiers → the App ID (`ai.jwlabs.foura`), enable the CarPlay entitlement, Save.
2. Create a new provisioning profile for that App ID. *"Xcode and Simulator require a Provisioning Profile that supports CarPlay."*
3. Add an `Entitlements.plist` with `<key>com.apple.developer.carplay-audio</key><true/>`.
4. *"under **Signing & Capabilities** turn off **Automatically manage signing**, and under **Build Settings** ensure that **Code Signing Entitlements** is set to the path of your `Entitlements.plist` file."*

Also gated behind the entitlement, and easy to miss: the audio entitlement is what *unlocks the
templates*. `CPNowPlayingTemplate` *"is only available in apps with the audio entitlement"*
(**Read from Apple**), and an unsupported template *"triggers an exception at runtime"* (Guide
p.14). **INFERRED**: you cannot build and run a meaningful CarPlay audio prototype before the
grant. This is a genuine serialisation point, not a formality.

And a category test we must actually satisfy, **Read from Apple** (Guide, Guidelines p.4,
guideline 1): *"Your CarPlay app must be designed primarily to provide the specified feature
(for example, CarPlay audio apps must be designed primarily to provide audio playback
services…)."* **INFERRED**: 4a passes this comfortably — it is an audio playback product.

The App Store Review Guidelines confirm the gating in one line, **Read from Apple**: *"Some
features and technologies that are not generally available to developers may be offered as an
entitlement for limited use cases. For example, we offer entitlements for CarPlay Audio,
HyperVisor, and Privileged File Operations."*

### 2.1 Must the app be published first? — No documented requirement, and one repo claim that says otherwise

This was the question flagged as potentially reordering the roadmap, so it gets a precise
answer, including the shape of what I could not establish.

**Apple's documentation contains no statement that an app must already be published, or
available on the App Store, before a CarPlay entitlement request will be considered.** I
checked the *Requesting CarPlay entitlements* article, the CarPlay Developer Guide (2026-06-08)
in full, the CarPlay framework overview, the CarPlay landing page, and the App Store Review
Guidelines. Nothing states or implies it. This is a **negative finding from a complete read of
the documents named in §0** — it is not an inference, and it is not proof that no such
criterion exists privately (see the caveat two paragraphs down).

The one sequencing rule Apple *does* state runs in the other direction and is about rollout,
not prerequisites. **Read from Apple** (Guide p.12): *"Once a CarPlay app entitlement is added
to your app, your app icon will appear on the CarPlay home screen. **You cannot selectively
show or hide CarPlay for certain people. Only publish your app with CarPlay support when you
are ready for everyone to see it.**"* That forbids a staged rollout or a feature-flagged beta —
CarPlay is all-or-nothing per release — but it says nothing about needing a prior release.

Publishing is described as ordinary and *subsequent*. **Read from Apple** (Guide p.66, "Publish
your CarPlay app"): *"When you are ready to publish your CarPlay app on the App Store, follow
the same process as for any iOS app and use App Store Connect to submit your app."*

**However — and this contradiction should not be smoothed over — this repo already asserts the
opposite.** **Read from source**, `docs/marketing/05-legal-risk-memo.md:44`: *"Apple assigns
the entitlement **account-wide**, locks the app to **one CarPlay category** (audio fits),
**wants to see a substantive working iPhone app before granting it**, and review timelines run
from days to several weeks with no published SLA. None of this blocks other milestones; just
start the request **once there's a real app to point to**."*

Note the memo's own closing clause: *"a real app to point to"* — **not** a *published* app.
Even our own more-cautious source is not asserting a publish-first rule; it is asserting a
demo-ability rule. That is a materially weaker and much cheaper condition, and the shell would
satisfy it long before a store release.

Three things about that memo line:

- The **account-wide** and **one-category** parts are corroborated by Apple. "Adds the
  entitlement to your developer account using managed capabilities" is account-scoped, and the
  entitlement table is per-category (audio and video may be combined; nothing else pairs with
  audio).
- The ***"wants to see a substantive working iPhone app"*** part **I could not source to any
  Apple document.** It is plausible — Apple reviews requests "using predefined criteria" that
  are not published, and the request form asks for "information about your app" — but as
  written it is an unsourced claim inside our own docs, and under this repo's own standard it
  should carry a label. **It is neither Read-from-Apple nor measured. Treat it as UNVERIFIED.**
- The **"days to several weeks with no published SLA"** part: I can confirm the *absence* of a
  published SLA (**Read from Apple** — no Apple source I read states any review duration). The
  "days to several weeks" figure is **UNVERIFIED**; it would have come from practitioner
  reports, which I could not search this session.

**The blocking caveat on all of the above:** the request form itself is at
`https://developer.apple.com/contact/carplay/`, which redirects to
`/contact/request/carplay/` and then to `idmsa.apple.com` — **an Apple ID sign-in wall I could
not pass.** I therefore **do not know what the form asks for**: whether it requires an App
Store URL, a bundle ID for an existing app, a demo video, or a description of an app still in
development. That is the single highest-value unknown in this section and it is resolvable in
five minutes by a human who signs in and reads the form without submitting it (§8).

**Practical read on sequencing, offered as judgement and labelled as such — INFERRED, not
established:** the roadmap does not need reordering on the strength of a publish-first rule,
because no such rule is documented. But the request should be filed *early* regardless, for
three independent reasons that hold whichever way the form's contents fall: the queue length is
unknown and unbounded by any SLA; the grant serialises all CarPlay development because the
templates are entitlement-gated; and if a reviewer *does* want to see a substantive app, an
early filing surfaces that fact early rather than after CarPlay work has been scheduled. This
is also, precisely, what the original brief said in July.

**Read from source** — the brief has been giving this instruction for over a month and it has
never been actioned:

- `docs/brief/01_PROMPT.md:36` — *"**CarPlay**: apply for the CarPlay audio entitlement early (approval takes weeks), but do **not** block any milestone on it. Lock screen + Bluetooth AVRCP controls work in every car and ship first."*
- `docs/brief/02_ARCHITECTURE.md:83` — *"Apply for CarPlay audio entitlement at project start; integrate only in a later milestone."*
- `docs/brief/README.md:26` — *"**apply for the CarPlay audio entitlement now** — approval takes weeks and M6 wants it."*
- `docs/NEXT-MORNING.md:33` — *"CarPlay entitlement application this week."*
- `docs/marketing/05-legal-risk-memo.md:136` — still an open checklist item.

There is no evidence in the repo that the application was ever filed, and there is no GitHub
issue for CarPlay at all (**Read from source**: a search across all issues finds CarPlay only
in the *out-of-scope* sections of epics #20 and #34).

---

## 3. Which API generation applies

Unambiguous, and current as of the 2026-06-08 Guide.

**Use the CarPlay framework: `CPTemplateApplicationScene` + templates.**

- `MPPlayableContentManager` is **deprecated in iOS 14.0** with the replacement message *"Use
  CarPlay framework"* (**Read from Apple**).
- **Read from Apple** (Guide p.67, "Appendix: Deprecated entitlements"): *"Audio apps support
  CarPlay by using the CarPlay framework, but can also use the Media Player framework
  (deprecated for CarPlay)… On iOS 14 and later, the CarPlay framework will be used if your app
  supports both frameworks. If your app needs to work on iOS 13 and earlier, support the Media
  Player framework and include the `com.apple.developer.playable-content` entitlement. Apps
  that only support the Media Player framework will work on later versions of iOS, **but your
  user interface is not customizable**."*

**INFERRED**: `MPPlayableContentManager` and `com.apple.developer.playable-content` are
irrelevant to us. They exist to keep iOS 13 alive; a new app in 2026 has no iOS 13 story.

### 3.1 Templates available to an audio app, and the minimum viable set

**Read from Apple** (Guide p.14 table). Audio apps may use: **Action sheet, Alert, Grid, List,
Tab bar, Now playing**, and **Voice control** (iOS 27+) and **Search** (iOS 27+). Audio apps
may **not** use: Contact, Information, Map, Point of interest.

Hierarchy depth, **Read from Apple** (Guide p.14): *"Audio, communication, EV charging,
parking, public safety, and navigation apps are limited to a depth of 5 templates… These
include the root template."* `CPListTemplate` corroborates: *"The framework restricts all other
categories of apps to five levels."*

**Minimum viable set for 4a — three templates.** This is my judgement from the constraints
above plus the product's shape (**INFERRED**, though the ingredients are all Read-from-Apple):

1. **`CPListTemplate` as root** — the list of forays. Apple's own startup example uses exactly this (Guide p.31). Adequate on its own; `CPTabBarTemplate` is only needed once there is more than one way to browse.
2. **`CPNowPlayingTemplate.shared`** — mandatory in practice, not optional. It is reachable from the CarPlay home screen without passing through your app, so *"you must be prepared to populate [it] at all times"* (Guide p.21).
3. **`CPListTemplate` again, pushed on top of Now Playing** — the up-next list. **Read from Apple** (Guide p.21): *"Only the list template may be pushed on top of the now playing template. For example, if your app enables the 'Playing Next' button in the now playing template, you can respond by showing a list template containing the upcoming playback queue."*

That is two template classes and one shared singleton. **The template code is genuinely not the
expensive part.** Everything expensive is behind it.

Corroborating our existing corner-case note, **Read from source**,
`docs/brief/05_CORNER_CASES.md:23` (case #14): *"When CarPlay ships: session picker must be a
CPListTemplate reachable in ≤2 taps; obey CarPlay driver-distraction constraints."* Note that
this predates forays and presumes the older `data/session.json` card model — it needs
rewriting against the foray model whenever CarPlay is actually scheduled.

---

## 4. What CarPlay demands that we do not currently have

Everything in the "what exists" column is **Read from source** at worktree HEAD `ee7fd18`.

| CarPlay demands | Basis | What exists in 4a today |
|---|---|---|
| A `CPTemplateApplicationScene` + `CPTemplateApplicationSceneDelegate` | Guide p.30-31 | Nothing. Zero `import CarPlay`, `CPListTemplate`, `CPNowPlayingTemplate`, `CPInterfaceController` anywhere in the repo. The only occurrence of the word is `ios/README.md:171` — a bullet under "Not implemented" reading simply `- CarPlay.` |
| Scene adoption in `Info.plist` | Guide p.30 | **Already satisfied by Capacitor, unexpectedly.** See §4.1. |
| `com.apple.developer.carplay-audio` in an `Entitlements.plist`, manual code signing | Guide p.12 | No `*.entitlements` file exists in the tree; `ios/project.yml` has no `entitlements:` key. CI builds are unsigned. See §4.2. |
| A browse hierarchy expressible as list sections and items | `CPListTemplate` | The data exists but only as a JS-side join (`player/foray-resolve.js`, 497 lines, three JSON documents). No Swift type models a foray, a segment, or a span. `ios/ForayKit/.../SessionModels.swift` models the *older* whole-episode card model from `data/session.json`. |
| Somebody owning `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` in the app process | `CPNowPlayingTemplate` | Nothing that ships. Lock-screen metadata comes from `player/media-session.js` (599 lines) via `navigator.mediaSession`, wired at `player/client.js:900`. Whether that even reaches the iOS lock screen inside WKWebView-in-Capacitor is labelled **untested** by our own research (`mp1-background-audio.md:27`). The AVPlayer/`MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` code at `ios/App/Player/PlayerQueueManager.swift:711-818` exists but is **not compiled by CI and has never been run**. |
| Native code that survives `cap sync` | **INFERRED** | `mobile/ios/` is gitignored in full and regenerated. See §4.3 — this is the sharpest practical finding in this section. |
| Artwork at CarPlay sizes, @2x and @3x, light and dark | Guide p.28 | See §4.4. |
| Tolerating 12-item lists | Guide p.32 | See §4.5. |
| Offline/queue semantics | — | See §4.6. |
| A test rig | Guide p.8 | Nothing. See §4.7. |

### 4.1 Scene adoption — already satisfied, and this is good news

I expected this to be a cost and it is not. **Read from source**, `ionic-team/capacitor` at
tag **`8.5.0`** (the repo depends on `^8.0.0`, `mobile/package.json:18-27`), both
`ios-spm-template/App/App/` and `ios-pods-template/App/App/`:

- `AppDelegate.swift` already implements `application(_:configurationForConnecting:options:)`
  and returns a `UISceneConfiguration` with `config.delegateClass = SceneDelegate.self`.
- `Info.plist` already declares a `UIApplicationSceneManifest` with a
  `UIWindowSceneSessionRoleApplication` entry.

So the Capacitor shell is already a scene-based app. Adding CarPlay means **adding a second
scene role** (`CPTemplateApplicationSceneSessionRoleApplication`) alongside the existing one —
which is exactly the two-scene shape of Apple's own example (Guide p.30).

**One discrepancy I must flag rather than resolve.** Capacitor's template sets
`UIApplicationSupportsMultipleScenes` to `<false/>`. Apple's two examples disagree with each
other: the *Displaying content in CarPlay* article's snippet sets it `<true/>`, while the
2026-06-08 Guide's Startup snippet (p.30) **omits the key entirely**. Whether CarPlay requires
it to be `true` is **UNVERIFIED** — I found no sentence stating a requirement either way. If it
must be `true`, that flips a Capacitor default and its effect on the shell's own window
lifecycle is unknown. Cheap to settle by test; named in §8.

### 4.2 Code signing — the current CI path cannot produce a CarPlay build

**Read from Apple** (Guide p.12): CarPlay requires turning *off* "Automatically manage signing"
and pointing Code Signing Entitlements at an `Entitlements.plist`. A provisioning profile that
includes the CarPlay capability is required by both Xcode and Simulator.

**Read from source**: `ios/project.yml` has `DEVELOPMENT_TEAM: ""` and
`CODE_SIGN_STYLE: Automatic`, no `entitlements:` key, and a bundle id
(`com.wjduvall.foray`) that is not even the shipping one (`ai.jwlabs.foura`). The shipping
iOS CI job produces an **unsigned** arm64/Release compile that is never installed or launched
(`docs/mobile-shell.md:618-626`).

**INFERRED**: a CarPlay-entitled build cannot be produced by the current unsigned CI path at
all. Signing identity + provisioning profile management in CI is a prerequisite task nobody has
scoped, and it is a *secrets-handling* task in a public repo. Flagging it because it is the kind
of item that gets discovered late.

### 4.3 Native code must survive `cap sync` — and that reverses a written decision

This is the finding I would most want a founder to see, because it is specific to *our*
architecture rather than to CarPlay in general.

**Read from source**: `mobile/ios/` and `mobile/android/` are gitignored in full
(`docs/mobile-shell.md:29`) and regenerated by `cap sync`. So a CarPlay scene delegate class,
the `CPTemplateApplicationSceneSessionRoleApplication` manifest entry, and the
`Entitlements.plist` **cannot simply be edited into the generated project** — the next sync
discards them.

This repo has already solved that problem twice, and both mechanisms are documented:

- For Java: a local Capacitor plugin declared in `mobile/package.json`, so `cap sync` re-injects
  it on every run — *"that is what makes the native code survive a platform regeneration with
  nothing for a human to run"* (`mobile/package.json:15`).
- For a single plist key: `tools/mobile/inject-background-audio.mjs`.

**INFERRED**: CarPlay on iOS needs the same treatment, which means an `ios/` half of the
`foray-audio` plugin. And that **directly reverses a written decision.** **Read from source**,
`mobile/plugins/foray-audio/package.json:7`, the key named `"//no-ios"`: *"Deliberately
Android-only… **Adding an ios/ src here would be native code with nothing to do.**"*

That reasoning was sound when the only iOS requirement was a background-audio plist key. Under
CarPlay it stops being true: there would be a great deal for native iOS code to do. Worth
saying out loud now, in the house style of `DECISIONS.md`, because it is the kind of reversal
that is cheap today and expensive to notice later — and because the *stated premise* of the
`"//no-ios"` decision, not merely its conclusion, is what CarPlay invalidates.

### 4.4 Artwork

**Read from Apple** (Guide p.28, "Assets"): *"CarPlay supports multiple scales and both light
and dark interfaces… Create versions that are suitable for 2x and 3x scale factors, and for
light and dark styles."* Sizes are given as maxima:

| Element | Points | 3x pixels | 2x pixels |
|---|---|---|---|
| Contact action button | 50×50 | 150×150 | 100×100 |
| Grid icon | 40×40 | 120×120 | 80×80 |
| Now playing action button | 20×20 | 60×60 | 40×40 |
| Tab bar icon | 24×24 | 72×72 | 48×48 |
| Voice control image | 150×150 | 450×450 | 300×300 |

List images are **not** a fixed size: *"To determine the sizes of images used in lists, use
`maximumImageSize` in `CPListItem` and `CPListImageRowItem`"* — a class property read at
runtime. Same pattern for list capacity (`maximumItemCount`, `maximumSectionCount`).
CarPlay app icon: **@2x 120×120, @3x 180×180** (**Read from Apple**, HIG: CarPlay). Apple also
encourages SF Symbols for tab bar icons.

Two gaps I will not paper over. First, **the now-playing album artwork size is not in this
table** — that artwork arrives via `MPMediaItemArtwork` in the now-playing info dictionary, and
I did not find a documented CarPlay-specific dimension for it. Second, our current app-artwork
story is one 512px PNG (`player/media-session.js:181`, `APP_ARTWORK_URL = "icon-512.png"`) plus
per-show artwork from `player/foray-sources.js`; whether per-show podcast artwork is available
at the resolutions and in the light/dark pairs CarPlay wants is **unexamined**.

### 4.5 List length — the 12-item floor is a real product constraint

**Read from Apple** (Guide p.32): *"**Some cars dynamically limit lists to 12 list items.** You
can check for the maximum number of list items, but you always need to be prepared to handle
the case where only 12 list items are shown."*

**INFERRED**: this binds 4a twice. A foray is 22–32 segments drawn from up to nine episodes
(`player/media-session.js:17-18`), so the "Playing Next" up-next list **will** be truncated in
some cars. And the root foray list needs a design that survives at 12 rows. Neither is hard;
both are decisions someone has to make, and the second one interacts with the product's
"splatter, not a directory" discovery principle (`DECISIONS.md`, 2026-07-08).

Useful on the other side of the ledger: `CPListItem` already offers `playbackProgress`,
`isPlaying`, `playingIndicatorLocation` and `isExplicitContent` (**Read from Apple**). Those
map cleanly onto `player/foray-progress.js` and the per-episode explicit flags the catalogue
already carries. Also `userInfo`, since *"CarPlay doesn't support custom list item types."*

### 4.6 Offline, queue semantics, and responsiveness

**Responsiveness has a documented contract, and it is forgiving.** **Read from Apple** (Guide
p.32): *"If you initiate asynchronous work and don't immediately call the completion block,
CarPlay will display a spinner to indicate that your app is busy. When you're ready to
continue, call the completion block to tell CarPlay to remove the spinner."* The HIG says the
same thing in product language: *"After people make a selection, it may take several seconds
for audio to begin playing, depending on buffering and network conditions. The system keeps the
selection highlighted and displays a spinning activity indicator until your app signals that
the audio is ready to play."* And: *"Display the Now Playing screen when audio is ready to
play. Don't delay playback until descriptive information completes loading."*

**I found no numeric latency requirement for audio apps anywhere in Apple's documentation.**
Stated as a negative finding, not an absence of looking. There *is* a 10-second refresh limit
— *"Do not periodically refresh data items in the CarPlay UI more than once every 10
seconds"* — but it appears under **"Additional guidelines for CarPlay driving task apps"**
(Guide, guideline 4), **not** under the audio app guidelines. I am explicitly **not** claiming
it binds us; I note it only because it is the kind of line that gets mis-cited as a general
rule.

**Offline: not a CarPlay requirement, but a CarPlay-shaped risk.** No Apple document I read
imposes an offline requirement on audio apps. But 4a streams segments from publishers' own
enclosure URLs (`data/segment-sources.json`, `audio_url` — the publisher's unmodified
enclosure), which means car listening is at the mercy of cell coverage exactly where podcast
listening happens. This is a pre-existing product risk that CarPlay makes more visible rather
than a new requirement, and it is out of scope here.

**Queue semantics fit better than expected**, and this is worth saying because it is the good
news in this section: `CPNowPlayingTemplate` has `isUpNextButtonEnabled` and `upNextTitle`, and
the up-next surface is a `CPListTemplate` you supply. Our player already produces exactly that
shape — `player/foray-queue.js:buildForayQueue()` emits a flat ordered typed queue, and
`player/foray-resolve.js:groupBySlot()` / `segmentStarts()` / `segmentAtElapsed()` already
compute everything a "playing next" list needs.

### 4.7 Testing requires hardware we do not have

**Read from Apple** (Guide p.8): *"CarPlay Simulator is a **Mac app** that simulates a CarPlay
environment and connects to iPhone, just like a car… run it, and **connect iPhone using a USB
cable**."* Alternatively *"an actual vehicle or an aftermarket head unit"* — and Apple
recommends a *wireless* head unit so the phone can be attached to Xcode simultaneously.

**INFERRED**: CarPlay cannot be developed or tested at all in the current setup. It needs a
**Mac** and a **physical iPhone** at minimum. This repo has never run on real iOS hardware
(`docs/mobile-shell.md:618-626`), and the iOS spike has been waiting on a Mac since
2026-07-09 (`DECISIONS.md`). This is a hard, unavoidable prerequisite, and it also gates the
one experiment in §1.2 that decides the architecture. **It should be treated as the first line
item, not an implementation detail.**

---

## 5. Does CarPlay constrain the product?

Question 5 asked whether CarPlay's model — tracks, lists, now-playing — accommodates segments
stitched from multiple episodes with narration at the seams, or assumes conventional episode
playback. This was the most likely place to find a structural mismatch. **The good news is
real: there is no fundamental mismatch. The bad news is elsewhere, and it is worse.**

### 5.1 The now-playing model fits. Genuinely.

CarPlay does not impose a "track". `CPNowPlayingTemplate` renders whatever the app puts in the
now-playing info, and the app decides what title/artist/album *mean*. We have already chosen a
mapping that works, and it was chosen for the lock screen, not for CarPlay — **Read from
source**, `player/media-session.js:20-24`:

- `title` = the source **episode** title
- `artist` = the source **show** name (the publisher credit)
- `album` = the **foray** title + `part N of M`

And critically, **Read from source**, `media-session.js:73-79`: the position state reported is
**the foray's clock, not the episode's**, and prev/next are wired to **segment** boundaries,
reusing the same `forayNext`/`forayPrevious` callbacks the in-page buttons use
(`media-session.js:63-72`).

That is exactly the right shape for `CPNowPlayingTemplate`, and it means the hardest conceptual
question — *how does a stitched foray present itself as one thing?* — is already answered and
already shipping on the web. A foray reads as an album; a segment reads as a track. Apple's
own model even helps: the up-next list is a `CPListTemplate` of segments, which is what a
foray's remaining items already are.

Two documented rules to design within, neither of them fatal (**Read from Apple**, Guide
Guidelines p.4 and the audio addendum p.4): *"only populate templates with the specified
information types (for example… album artwork in the now playing screen must be used to show an
album cover)"*, and *"Never show song lyrics on the CarPlay screen."* **INFERRED**: a
segment's `why` rationale text — the editorial line that explains why this span was chosen —
probably cannot be splashed across the now-playing surface, and transcript text certainly
cannot. That is a real constraint on the part of 4a that is most distinctive, and it deserves
a design pass rather than a shrug.

One more, and it is a product requirement rather than a technical one — **Read from Apple**
(Guidelines p.4, guideline 3): *"All CarPlay flows must be possible without interacting with
iPhone."* **INFERRED**: a user must be able to browse and start a foray entirely from the car.
That is satisfiable, but it means CarPlay cannot depend on a foray having been picked on the
phone first, which is a live question given that the product's discovery model is a
phone-screen "splatter" and all three forays in `data/forays.json` are currently
`"status": "draft"`.

### 5.2 The real mismatch is the seam, and CarPlay is the worst possible place to meet it

The structural problem is not how a foray *presents*. It is what happens 22 to 32 times per
foray, at every seam — and the car is where that lands hardest.

**Measured (prior)**, cited not re-run — `player/seam-gap.js:20-25` and
`player/queue-manager.js:86-88`: an asked seam gap of `2000 ms` was observed as **`9153 ms`**
on a backgrounded iOS Simulator, run 32036295743 — **for a file bundled inside the app.** Total
silence at a seam is `max(gap, load)`, not `gap + load` (`queue-manager.js:65-71`). And seam
prefetch, which was built to fix this, is **parked and default-off**: measured on iOS Simulator
run 32057395270 making the seam *worse* — the segment was dropped rather than delayed
(`queue-manager.js:74-83`).

Now the thing that would make a seam legible as an edit rather than as a fault: narration. It
does not exist. **Read from source**, `docs/narrator-pipeline.md:64-66`: *"**Zero narration
exists.** `data/forays.json` contains no narration items at all across all three Forays. Every
path above is exercised only by fixtures."* Also `:87-91`: *"The device-TTS fallback does not
exist. There is no `speechSynthesis`, no `AVSpeechSynthesizer` and no utterance code anywhere
in the repo — zero matches."* The plumbing is real and tested — `foray-queue.js` emits
`kind: "tts"` items, `queue-state.js` models the bridge, narration is forced to 1.0× — but no
asset has ever been produced.

**INFERRED**, and this is the sharpest product argument in this document: a car is the one
context where the listener **cannot look at the screen to find out why the audio stopped.**
Nine seconds of unexplained silence on a phone is a glance; in a driver's seat it is
indistinguishable from a crash, and the driver's only available response is to reach for the
phone — which is precisely what CarPlay's guidelines exist to prevent. **Shipping CarPlay
before narration exists would deliver the product's weakest moment into its least forgiving
context, roughly 30 times per foray.**

This is not a CarPlay blocker in Apple's sense. Apple would approve it. It is a reason to
sequence CarPlay *after* narration regardless of what Apple requires, and it is an argument
that stands on this repo's own measurements rather than on taste.

### 5.3 And the machinery has no Swift counterpart — quantified

If the §1.2 experiment forces a native player, this is the bill. Every line **Read from
source**.

`docs/mobile-shell.md:71-74`, the sentence the brief called decisive: *"The machinery the
product actually runs on — `foray-resolve`, `foray-queue`, `seam-gap`, `seek-policy`,
`html-audio-backend`, `durable-store` — has no Swift counterpart at all, and sits under twelve
CI-gated suites."*

There *is* a `PlayerBackend` protocol and an `AVPlayerBackend` at
`ios/App/Player/PlayerBackend.swift` — but CI does not compile it, it has never run, and
`player/queue-state.js:59-67` says what that is worth: *"This one is JS-only and the Swift has
NOT been updated (#111). Neither `PlayerQueueState.swift` nor `PlayerQueueManager.swift` knows
about bounds, `setOutPoint`, or the in-point override, **so a Foray cannot play on the native
backend yet.**"*

The web backend is 1,935 lines and its HTML-audio-specific behaviours are load-bearing, not
incidental (`player/html-audio-backend.js:24-56`): a two-element invariant; deliberately **no
`crossorigin` attribute**, because podcast CDNs send no `Access-Control-Allow-Origin` — which
is *why* ducking is `.volume` and why Web Audio can never touch that element; `currentTime`
deferred until `loadedmetadata`; autoplay-rejection handling; and a two-stage out-point watcher
(coarse `timeupdate`, then fine `setTimeout`, `ARM_LEAD_SEC = 2.0`). A native backend must
reproduce the *behaviour*, and some of those constraints simply do not exist in AVFoundation —
which cuts both ways, and is not automatically easier.

One structural mercy worth recording: the contract is already dependency-injected.
`player/queue-manager.js:195` takes `opts.backend` and never imports a backend, and the
contract is written out in prose in two places, explicitly mirroring
`ios/App/Player/PlayerBackend.swift`. There is no `player/player-backend.js` interface file —
it is an informal duck type pinned by tests — but the seam a native backend would plug into
does exist and is tested against a fake. That is the one part of this that was designed for
this possibility.

---

## 6. What CarPlay does *not* require

Recording the negatives, because half the cost of a project like this is work nobody needed.

- **No published app is required before requesting the entitlement** — no Apple document says so (§2.1).
- **No `MPPlayableContentManager`** — deprecated since iOS 14; irrelevant unless you support iOS 13 (§3).
- **No custom view rendering, no layout work, no resolution handling.** **Read from Apple**: *"Your app does not need to manage the layout of UI elements for different screen resolutions, or support different input hardware such as touchscreens, knobs, or touch pads."* (Guide p.11.) This is a genuine saving.
- **No separate app.** **Read from Apple** (Guide p.11): *"CarPlay apps are not separate apps — you add CarPlay support to your existing app."*
- **No scene-adoption migration** — Capacitor 8.5.0 already ships a scene-based template (§4.1).
- **No `MPNowPlayingSession`** — it is one of two sources `CPNowPlayingTemplate` reads, not a requirement. `MPNowPlayingInfoCenter` alone is a documented source. (Which is exactly why the §1.2 experiment is worth running.)
- **No numeric latency target.** The contract is a completion block and a spinner (§4.6).
- **No CarPlay-specific App Store review process** — *"follow the same process as for any iOS app"* (Guide p.66), subject to the CarPlay Guidelines.

---

## 7. Recommendation

**Not a decision. Input to one.** Ordered by what unblocks the most and costs the least.

### Do now

**1. Settle which thing the founder is asking for (§1.1).** One conversation. If the want is
"my audio comes out of the car speakers," that is approximately free and arrives with the shell
— and this document's remaining nine items are not needed. If the want is an icon on the
CarPlay home screen, continue. **Doing this first is worth more than anything else here**,
because it is the difference between a free outcome and the largest iOS project this product
has considered.

**2. File the CarPlay audio entitlement request.** Free, reversible, no code, unknown queue
length, and it serialises everything downstream because the templates are entitlement-gated
(§2). The brief has asked for this five times since 2026-07-07 and it has never been done.
Whoever files it should **read the form and write down what it asks for** — that closes the
largest gap in §2.1 as a side effect.

**3. Acquire the test rig: a Mac and a physical iPhone** (plus CarPlay Simulator from Additional
Tools for Xcode, or an aftermarket wireless head unit). Not CarPlay-specific — it also unblocks
the iOS audio spike that has been waiting since 2026-07-09 — but CarPlay is unreachable without
it (§4.7).

### Do next, and stop

**4. Run exactly one experiment, and let it decide the architecture.** Behind the Mac, in a
throwaway branch, with the entitlement in hand:

> With a Capacitor shell playing an `<audio>` element in a WKWebView, can a native Swift layer
> in the same app process own `MPNowPlayingInfoCenter.default()` and `MPRemoteCommandCenter`
> such that `CPNowPlayingTemplate` shows *our* metadata and *our* transport handlers fire —
> reliably, across seams, with the phone locked, and surviving WebKit's own now-playing writes?

- **Yes** → CarPlay is a native *UI* project over the existing JS player. Real work, bounded, no rewrite.
- **No** → CarPlay requires a native playback engine, which means the port in §5.3, which is a rewrite and should be costed and scheduled as one rather than discovered.

This is the whole decision. It is days of work, not weeks, and everything expensive sits
downstream of it. **Nothing else in the CarPlay column should be built until it is answered.**

**5. Ship the app, and ship narration, before shipping CarPlay.** Not because Apple requires it
(it does not), but because of §5.2: nine seconds of unexplained silence, thirty times per drive,
is a worse first impression than no CarPlay app. And because of Apple's own all-or-nothing rule
— *"You cannot selectively show or hide CarPlay for certain people"* — there is no quiet beta
in which to find that out.

### Explicitly do NOT build yet

- **Do not port the player to Swift.** `foray-resolve`, `foray-queue`, `seam-gap`, `seek-policy`, `html-audio-backend`, `durable-store`, plus the bounds/out-point/in-point work `player/queue-state.js:59-67` says the Swift lacks. This is the rewrite. It must not start before step 4 says it is necessary. **This is the specific mistake this document exists to prevent.**
- **Do not write CarPlay templates.** They cannot be exercised without the entitlement, and an unsupported template throws at runtime (§2).
- **Do not add an `ios/` half to the `foray-audio` plugin yet** — but know that CarPlay will require it, and that doing so reverses the `"//no-ios"` decision at `mobile/plugins/foray-audio/package.json:7` by invalidating its premise, not just its conclusion (§4.3). Worth a `DECISIONS.md` line when it happens.
- **Do not retire the `ios/` Swift tree on the grounds that CarPlay might need it.** It does not help: `SessionModels.swift` models the *superseded* card model, and the state machines do not know what a segment is. Its fate belongs to #28, unchanged by anything here.
- **Do not rewrite `docs/brief/05_CORNER_CASES.md:23`** (corner case #14) yet, but note it presumes the pre-foray card model and will need rewriting when CarPlay is scheduled (§3.1).
- **Do not treat the 10-second refresh limit as binding on us.** It is a driving-task-app guideline (§4.6).

### Roadmap position

CarPlay currently sits at **M6, "Stretch (only after I'm happily using it daily)"**
(`docs/brief/06_ROADMAP.md:30`). **Nothing found in this research argues for moving it
earlier.** Steps 2 and 3 above are not CarPlay implementation — they are a free option and a
prerequisite that pays for itself elsewhere. The marketing corpus's framing still holds and is
worth repeating to a founder who has decided CarPlay is happening:
`docs/marketing/08-REQUIREMENTS-DELTA.md:23` — *"Only ~11% of listening minutes are in-car
(67% home)… CarPlay stays the wedge, drops out of the identity."*

---

## 8. What this document does not know

Every unresolved question, and who could resolve it. Nothing here is filled with a plausible
inference.

### Blocking the architecture decision

| # | Unknown | Who resolves it, how |
|---|---|---|
| 1 | **Can the host app own `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` while WebKit plays the `<audio>` element, and does `CPNowPlayingTemplate` then show our data?** Apple documents neither side. This decides feature-vs-rewrite. | An engineer with a Mac, an iPhone, and the entitlement. Days. §7 step 4. |
| 2 | **Does `navigator.mediaSession` reach the iOS lock screen from WKWebView-in-Capacitor at all?** Our own record labels this **untested** (`mp1-background-audio.md:27`); #27's acceptance criterion was widened to ask exactly this and never answered. Upstream of #1. | Same rig. Hours. |
| 3 | **Must `UIApplicationSupportsMultipleScenes` be `true` for CarPlay?** Apple's two examples disagree; Capacitor ships `false` (§4.1). If `true`, unknown effect on the shell's own window lifecycle. | Same rig, or an Apple DTS ticket. |

### Blocking the entitlement

| # | Unknown | Who resolves it, how |
|---|---|---|
| 4 | **What does the entitlement request form actually ask for?** Behind an Apple ID sign-in I could not pass. Whether it wants an App Store URL, a bundle ID for a shipping app, or a demo video is unknown. | The founder, signed in, five minutes, reading without submitting. **Cheapest high-value item in this document.** |
| 5 | **Is a "substantive working iPhone app" really a grant criterion?** Asserted at `docs/marketing/05-legal-risk-memo.md:44`; **I could not source it to Apple.** Apple's criteria are explicitly unpublished (*"predefined criteria"*). | Partly #4. Otherwise only Apple. |
| 6 | **How long does review take?** Apple publishes no SLA — that absence I did confirm. The brief's "weeks" and the memo's "days to several weeks" are **UNVERIFIED**; I could not search practitioner reports (no `WebSearch` budget). | Filing it (#2 in §7) and recording the actual date. |
| 7 | **What is in the CarPlay Entitlement Addendum?** A required agreement I never saw. The Guide says apps *"must meet the basic requirements defined in the CarPlay Entitlement Addendum"* — so it may contain binding requirements absent from the public Guide. | The founder or a lawyer, at request time. Flagged for `docs/legal/`. |

### Would refine, not change, the recommendation

| # | Unknown | Who resolves it, how |
|---|---|---|
| 8 | **Now-playing album artwork dimensions for CarPlay.** Not in the Guide's asset table; arrives via `MPMediaItemArtwork` with no CarPlay-specific size documented (§4.4). Also unknown whether per-show podcast artwork exists at CarPlay resolutions in light/dark pairs. | Reading `MPMediaItemArtwork` docs plus an audit of `player/foray-sources.js` artwork URLs. |
| 9 | **Actual `maximumItemCount` / `maximumSectionCount` / `CPListItem.maximumImageSize` values.** Runtime class properties by design; they vary by car. Only the 12-item floor is documented. | Reading them at runtime on real hardware. |
| 10 | **What CI signing for a CarPlay-entitled build costs** (§4.2), including secrets handling in a public repo. | An engineer scoping `ios-build.yml`; unscoped today. |
| 11 | **Whether seam silence is better or worse over CarPlay than the measured 9,153 ms.** The measurement is Simulator, backgrounded, bundled file. Car conditions — cell network, remote CDN, locked phone, possibly wireless CarPlay — are all untested and all plausibly worse. | Same rig, once §7 step 3 exists. |
| 12 | **Whether Siri / App Intents change the picture.** `docs/brief/04_VOICE_AUDIO_SPEC.md:32` calls *"Hey Siri, skip this"* the only true hands-free path on iOS. Audio apps get `CPAssistantCellConfiguration` and, from iOS 27, the voice control and search templates. I did not research App Intents or SiriKit media intents. **Genuine scope gap in this document.** Note `ios/ForayKit/.../IntentGrammar.swift` (383 lines, CI-tested) has no JS equivalent and might matter here. |
| 13 | **CarPlay Ultra, widgets, Live Activities.** The Guide covers all three; I did not read those sections. Notably *"Your app does not need to be a CarPlay app to support widgets and Live Activities in CarPlay"* — possibly a cheaper partial win, unexamined. | A follow-up read of the same PDF. |

---

## 9. What would change the recommendation

Stated as falsifiers, so the recommendation can be checked rather than trusted.

1. **If §8 #1 comes back "no" — WebKit's now-playing cannot be overridden — then CarPlay is a rewrite, not a feature**, and the honest recommendation becomes *don't, until the native player is wanted for its own reasons*. The §5.3 port would need costing as a project with a macOS CI story, not a work package.

2. **If §8 #4 reveals the form requires a live App Store URL, the roadmap does reorder**: ship first, CarPlay second, and step 2 of §7 moves behind the store release. My reading of Apple's documentation says this is not so, but I could not read the form, and the form is the operative document.

3. **If the founder's actual want is §1.1(a) — audio in the car — the entire project dissolves** into verifying something we believe already works. This is the single most valuable thing to check and the cheapest, which is why it is step 1.

4. **If narration ships and seams measure well in a car**, §5.2's objection evaporates and CarPlay becomes a straightforward native-UI project — assuming §8 #1 also came back "yes". The two unknowns are independent and both must be favourable.

5. **If Apple grants the entitlement quickly and unconditionally**, the "file early because the queue is long" argument weakens — but the "templates are entitlement-gated" argument does not, so step 2 stands either way.

6. **If a Mac is not going to be acquired**, then CarPlay is not merely unscheduled, it is *unreachable*, and saying so plainly is more useful than a plan. Every remaining unknown in §8 requires one.

7. **If `MPNowPlayingSession` gains a non-`AVPlayer` initializer in some future iOS**, the §1.2 analysis needs redoing. Recorded because it is the specific type signature the argument turns on, and API surfaces move.

---

## 10. Provenance

Prepared 2026-08-26 in an isolated worktree off `origin/main` at `ee7fd18`. No code was written;
no test was added (and so none required mutation-testing); nothing under `ios/`, `mobile/` or
`player/` was modified. Apple's CarPlay Developer Guide was read at revision **2026-06-08** —
if that date has moved, re-check §2, §3.1 and §4.4 first, since entitlement tables, per-category
template availability, and asset sizes are the parts Apple revises.

`docs/brief/05_CORNER_CASES.md:23` (corner case #14) is the only pre-existing design-level
CarPlay requirement in the repo, and it predates the foray model. It should be rewritten
against forays when — and only when — CarPlay is actually scheduled.
