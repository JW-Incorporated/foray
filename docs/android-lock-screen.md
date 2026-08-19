# The Android lock screen: implementing the `mediaSession` the WebView switched off

Issue **#27**'s Android half, on **#244** (a home for native code, and the
`mediaPlayback` foreground service) and **#37** (the build). Reads on from
`docs/android-native-code.md` and `docs/research/mp1-background-audio.md` §5.

Android had **no transport controls at all** — no lock screen, no notification with
a title, no Bluetooth or steering-wheel buttons. Not because #27 was unfinished:
`player/media-session.js` has shipped since #27's web half and it is 600 lines of
argued decisions. It buys the Android *app* nothing, because
`navigator.mediaSession` **is switched off in Android WebView at the engine level**.

## 0. How every claim here was obtained

The table to read before quoting anything. `docs/android-native-code.md` §1 and
`docs/android-shell-build.md` §0 keep the same table for the same reason: a document
that reports "measured" when it means "read" is the failure mode this repo keeps
paying for.

| Claim | How |
|---|---|
| Both APKs build, with sizes and wall clock | **Executed on this machine.** §6 |
| The `MediaSession`, both `<service>` attributes and all three permissions reach the app's **merged** manifest | **Executed** — read out of `app/build/intermediates/merged_manifest/…` after `assembleDebug`. §6.2 |
| Media3 1.11.0 is the current release, and what it drags in | **Executed** — `maven-metadata.xml` and the resolved POM/module metadata, plus the dependency report from the build. §3 |
| The state machine: what the lock screen is told, when, and what a press does to the page | **Executed, against fakes.** 376 tests in `tools/mobile/`, 25 mutations, 25 caught. §7. **No WebView ran.** |
| `SimpleBasePlayer` upgrades a `long` position into an extrapolating supplier | **Read from source** — `SimpleBasePlayer.java`'s `State` constructor, from the 1.11.0 sources jar. §4.3 |
| `MediaStyle.setShowCancelButton` and `setCancelButtonIntent` are no-ops | **Read from source**, and found because the compiler emitted a deprecation note. §5.2 |
| `navigator.mediaSession` is absent in Android WebView | **INFERRED** (source-derived), unchanged from MP1 §5.4 and `docs/android-shell-build.md` §4. **Nothing was executed in a WebView.** This is the premise of the whole change and it is still not measured |
| That anything renders on a lock screen, that a Bluetooth button reaches the page, that the notification appears at all | **NEITHER MEASURED NOR INFERRED — UNVERIFIED.** §8 |
| Whether the system media panel needs `POST_NOTIFICATIONS` granted | **INFERRED**, and weakly. §5.3 |

**No emulator was attempted.** MP1 §6.2 spent ~75 minutes across three cold boots
and reached nothing usable; §6.4 explains why an emulator would have been necessary
but not sufficient anyway. Nothing here re-litigates that.

## 1. The decision: supply the missing API, and let native be the browser

**`navigator.mediaSession` is polyfilled** by
`mobile/plugins/foray-audio/web/foray-media-session.js`, and the native side plays
the part of the browser behind it. `player/client.js` finds an object where the spec
says one should be, writes metadata, position and playback state to it exactly as it
does in mobile Chrome, and registers the same action handlers. Those writes are
forwarded to a Media3 `MediaSession`; the OS's transport presses come back as calls
to the handlers the page registered.

**Nothing under `player/` is modified.** It does not know this file exists.

### 1.1 The two obvious answers, and why both are wrong

**(a) Decide the metadata natively.** Rejected, and this is the important one. The
lock screen would then say one thing in the Android app and another in mobile
Chrome, and `player/media-session.js`'s header — which argues *why* `artist` is the
source show and not our name, why `album` carries "part 12 of 32", why the position
is the Foray's clock and not the episode's — would govern one of them. Two opinions
about what a Foray is, diverging at the first edit to either.

**(b) Change `player/` to call native.** Rejected on two counts. It is not this
change's to touch, and it would put a platform branch inside the one module whose
entire design is that it is pure, platform-free and testable under `node --test`.

**What the polyfill costs, stated because it is not free.** It is an intrusive thing
to do to somebody else's `navigator`, and it is the second such patch in this plugin
— `foray-audio-shell.js` already wraps `HTMLMediaElement.prototype.play`. Both obey
the same rules: **if the platform already has the thing, leave it alone**
(`install()` returns false when `navigator.mediaSession` is truthy, because MP1
§5.4's premise is source-derived and a WebView that ships the API must win), restore
only what we installed, and never let a failure here cost the page.

### 1.2 What this buys that a bespoke bridge would not

The whole of `player/media-session.js` runs unmodified, which means every decision it
argues arrives on Android for free and **stays** correct: the seam beat reporting
`playing`, a finished Foray reporting `none`, artwork degrading to the app's icon,
`previoustrack` inheriting `forayPrevious`'s restart-vs-previous window, `seekto`
landing in the timeline we reported. `tools/mobile/foray-media-session.test.mjs` §7
drives the real module against the polyfill so the contract is a test rather than a
hope.

## 2. What the lock screen says, and the argument for it

**The mapping is `player/media-session.js` §1's, unexamined and unimproved:**

| Field | What it carries |
|---|---|
| title | the **source episode**'s title — the thing sounding right now |
| artist | the **source show**'s name — the publisher credit |
| album | the **Foray**'s title, plus `part N of M` |

**The argument for it is that it is already made, and re-making it would be the
defect.** The three reasons in that header are the reasons: `title`/`artist` are
rendered by every platform that renders anything while `album` is what a narrow
notification drops first, so the two facts a listener cannot do without go in the two
fields that always survive; publishers get the credit in the field the OS labels
"artist", because every second of this is a download against their own feed;
and it has to **change at every seam** — a car display whose text does not move for
51 minutes reads as frozen, and because `title`/`artist` are the segment's, it
refreshes 31 times at exactly the moments the audio changes.

**Both, then — not one.** The question "the Foray's title, the current segment's
show, or both" has a third answer, and it is the one the data supports: a Foray is
cut from up to nine shows, so three fields have to carry three *different* facts
rather than one fact spelled three ways.

### 2.1 What IS decided here, because it is Android-only

Two things, and they are the reason this section exists at all rather than a pointer.

**Which Media3 fields carry those three strings, and how many of them.** `title` and
`artist` are the platform metadata keys the system media panel reads;
`displayTitle` and `subtitle` are what Media3's own notification providers read
*first*. Writing both pairs costs two setter calls and is why one mapping renders the
same in the shade, on the lock screen and on a head unit rather than correctly on one
of the three. `album` goes to `albumTitle`, and to the notification's `subText`.

**Artwork: the URI is set, the bitmap is not loaded — and that is a decision.**

- The session's metadata carries `artworkUri`, so any surface that loads art from the
  session itself gets the publisher's square for free.
- The notification carries **no large icon**, so the shade falls back to the app's own
  icon.
- What that costs is **one show in twelve**. `player/media-session.js` §5 records that
  `data/segment-sources.json` has no artwork field at all and joining our shows
  against `data/discover.json` by name covers **1 of the 12 shows** the two shipped
  Forays draw on — so eleven times in twelve the two-tier fallback resolves to
  `icon-512.png`, which is what the notification shows anyway. Buying the twelfth
  means a native HTTP fetch, a bitmap decode, a cache and a re-post, on a path no
  device has run. It is named as follow-up work rather than done badly.

**And one thing that would have silently never worked.** The artwork URL the page
hands over is correct **inside the WebView**: for the app's own icon it resolves to
`https://localhost/icon-512.png`, an origin served by Capacitor's
`WebViewLocalServer` inside the WebView and by nothing else in the process. A native
bitmap loader asked for that gets a refused connection. `assetUri()` rewrites a
same-origin URL to `file:///android_asset/public/…`, which is where `cap copy` puts
the same bytes; `https:` passes through untouched, a `data:image/` URI likewise, and
everything else becomes `""` — no artwork, never a guess. `media-session.js`'s own
`artworkUrl()` has already refused `http:`, protocol-relative and control-character
URLs, so this is the second gate rather than the first.

## 3. The Gradle dependencies, named, with what each is for

Two new Maven artefacts, and they are the **first** this plugin has added — #244's
two were both already in every generated Capacitor project, so it could truthfully
say the native half cost no new artefact. #27 spends that, and here is the bill.

| Coordinate | Why |
|---|---|
| `androidx.media3:media3-session:1.11.0` | `MediaSession` — the object that publishes a platform media session for the lock screen and the media panel to read — and `MediaStyleNotificationHelper`, which stamps that session's token onto our notification so the system pairs the two. **This is the artefact #27 cannot be built without.** |
| `androidx.media3:media3-common:1.11.0` | `SimpleBasePlayer`, the documented base class for "a player that only supports a subset of commands", plus `Player`, `MediaMetadata` and `PlaybackParameters`. Arrives transitively through `media3-session` and is **declared anyway**, because `WebViewPlayer.java` imports it directly and a module should ask for what it compiles against |

**1.11.0 read from Google's Maven `maven-metadata.xml` as the current `<release>` on
2026-08-18**, not from memory — the wrong Media3 version is a resolution failure
rather than anything about media. It is pinned as an exact version in one `ext`
property, and a test asserts it is not a range: `1.+` would make the lock screen's
behaviour a function of the day the APK was built.

**What comes in behind them, stated because a transitive dependency is still a
dependency.** `media3-common` exposes **`com.google.guava:guava:33.3.1-android`** as
an `api` dependency, and it is unavoidable rather than chosen —
`SimpleBasePlayer`'s own abstract methods return `ListenableFuture`, so the type is
in the contract we implement. `media3-session` also brings `media3-datasource` and
`media3-container`, where its default `BitmapLoader` lives. Guava is the large one;
§6.1 has the measured APK cost of all of it.

**Not `media3-exoplayer` and not `media3-ui`**, and a test fails if either appears.
There is no player to build and no view to inflate: `media3-ui` would be ~1 MB of
`PlayerView` for a notification built with `NotificationCompat`, and
`media3-exoplayer` would put a second, real audio pipeline in a process whose whole
design is that the page owns the only one.

## 4. The controls: what is exposed, what is declined, and the timeline question

### 4.1 Exposed

| Control | Routes to | Note |
|---|---|---|
| play / pause | the page's `play`/`pause` handlers → `setRunning(true/false)` | one Media3 command, `COMMAND_PLAY_PAUSE`, governs both |
| **next / previous** | `nexttrack`/`previoustrack` → `ForayPlayer.forayNext()`/`forayPrevious()` | **the next and previous SEGMENT.** §4.2 |
| seek −15 / +30 | `seekbackward`/`seekforward` with a `seekOffset`, → `foraySeek(position + offset)` | sent as an **offset**, not the absolute target Media3 computed, so the page's own handler runs |
| scrub (`seekto`) | `seekto` with a `seekTime` → `foraySeek` | on the **Foray's** clock |
| stop | `stop` → `stopAndClose()` | load-bearing, not decorative — §5.1 |

### 4.2 Next and previous are segments, and that is the real question

**Argued, not assumed.** A Foray is an authored running order, so "next" could
reasonably have been a 30-second nudge, a chapter, or nothing at all. It is the next
**segment**, for four reasons:

1. **`04_VOICE_AUDIO_SPEC.md` says so**: *"nextTrack = next queue item, prevTrack =
   restart item / previous"*. The queue item **is** the segment.
2. **The segment is the only boundary a Foray has**, and it is track-sized: 22–32 of
   them across 51–61 minutes, averaging under two minutes. There is no other unit to
   skip to.
3. **The alternative duplicates something we already have and drops something we do
   not.** Mapping next to ±30 s would be `seekforward` twice over, and would leave
   "leave this one" — the one thing a driver actually needs, hands on the wheel —
   unreachable.
4. **It is what the in-page ‹‹/›› buttons do.** They call the same two functions, so
   there is one definition of what next means rather than two.

**And previous is always available**, because `forayPrevious` is always meaningful:
it restarts the current segment or goes back, on its own window. Media3's
`seekToPrevious()` has an opinion about that — it restarts the item when the playhead
is past `maxSeekToPreviousPositionMs` — and `maxSeekToPreviousPositionMs` is set to
**0** to switch that opinion off, because `player/media-session.js` §2 is explicit
that the window is the page's and not a second implementation's.

### 4.3 Declined, each for a reason

- **Shuffle.** A Foray is an authored running order. Shuffling it is a category
  error, not a missing feature.
- **Repeat.** Nothing repeats a 51-minute Foray, and a toggle the page cannot honour
  renders as ON or OFF, either of which is a claim.
- **Speed.** The rate is a durable preference (#242) the page owns and re-applies at
  every seam. It is **reported** — Media3 extrapolates the playhead with it — and not
  accepted.
- **Jump to an arbitrary item.** The Foray page does that with 32 real titles in
  front of the listener. A lock screen offering it against a three-window timeline
  (§4.4) would jump somewhere neither of us meant.
- **Volume.** The element's volume is not a transport control, and the media stream's
  volume is the OS's own slider, which appears whether we claim it or not.
- **A `MediaSessionService`.** Media3's own service subclass handles the
  foreground/notification lifecycle correctly and would **own** it — keyed to
  `player.isPlaying`. That is exactly the lifetime #244 argued out between a 20 s
  floor and a 30 s ceiling and that §5.1 extends. Handing a reviewed mechanism to a
  library nothing here can execute is the wrong trade with no device.
- **Audio focus.** Unchanged from MP1 §5.2, which is open in both directions. If
  WebView requests focus for a plain `<audio>` element, a second requester in the
  same process fighting it is worse than either alone; if it does not, adding one
  here makes this class the owner of ducking and interruption behaviour for audio it
  cannot pause. A device is the only thing that says which.
- **A `MediaButtonReceiver`.** Media3's is written to forward to a
  `MediaSessionService`, which we are not, so declaring it would fail at runtime.
  The consequence is that media buttons are **not** routed after the process has
  died — which is media resumption, and there is nothing to resume without the
  WebView.

### 4.4 The timeline is three windows, and it is the least obvious thing here

Media3 answers "is there a next track?" from the **timeline**, not from a capability
flag: `BasePlayer.seekToNext()` checks `hasNextMediaItem()` and does nothing when the
playlist holds one item. So the obvious modelling — one window, one Foray — makes
`KEYCODE_MEDIA_NEXT` from a steering wheel a **no-op**, which is the one control #27
exists for.

The real running order cannot be the timeline either: the page publishes the
**current** item's metadata and nothing else, so this process does not know the other
31 titles, and reaching into `player/` for a queue listing is not this change's to do
(§9 names it as the one thing this would want from `player/`).

So the timeline is a **neighbourhood**: one window for "something before", one for
now, one for "something after" — each present only when the page installed the
matching handler. It says exactly what is known, and holds no second opinion about
the running order.

**Every window carries the same metadata and the same duration, and that is not
laziness.** Media3 shows a placeholder state between a press and our answer; with
empty neighbours, pressing next at a cross-episode seam would **blank the
notification's title for the 5–11 s the load takes** (MP1 §4.4). Repeating the
current metadata holds the display still until the truth arrives — which is also what
is actually true during a seam, since the outgoing segment is what was last sounding.

**The cost, named:** a controller that renders queue position would show "2 of 3". No
Android media surface does, and the alternative was a dead next button.

**One thing read from source rather than assumed:** `SimpleBasePlayer`'s `State`
constructor upgrades a plain `long` content position into
`PositionSupplier.getExtrapolating(position, speed)` by itself when the state is
`READY` and `playWhenReady`. That is why the page can report the playhead once a
second (§5.4) instead of four times.

### 4.5 The clock is the Foray's

`durationMs` and `positionMs` span the whole Foray, not the current segment —
`player/media-session.js` §3's decision, and its sharpest reason carries over
verbatim: **a `seekto` from a head unit arrives in the timeline we reported.** Report
the segment and a car scrub can only ever move inside 110 seconds; report the Foray
and a scrub to 30:00 lands at 30:00 of the Foray, routed through `foraySeek`, which
is the in-page scrubber's own path.

## 5. What changed in #244's service, and why

### 5.1 The service's lifetime is now "a Foray is loaded", not "audio is sounding"

**This is the one behavioural change to #244 and the one to review hardest.**

#244 stops the service 25 s after the last element goes silent. That is correct for a
keep-alive and **wrong for a session**, because the `MediaSession` and the
notification live in the service: pause from the lock screen, wait 25 seconds, and
the buttons you paused with are gone, with no way to resume without unlocking the
phone and finding the app.

So the rule becomes:

| The page says | What happens |
|---|---|
| loaded and silent — paused, or mid-seam | the settle window fires and **does nothing**. Session, notification and controls stay up |
| **not** loaded | stop **at once**, no window |

**The signal is not a guess.** `player/client.js` calls `media.release()` from
`stopAndClose` and nowhere else, and `release()` nulls the session's metadata. The
polyfill reports that as "not loaded", and `foray-audio-shell.js`'s new
`setMediaLoaded(false)` stops the service immediately. That is precisely the payoff
#244's own header predicted: *"once a pause can come from a transport control, a
pause the app ISSUED is attributable and can stop the service at once."*

**It is FEWER `startForegroundService` calls than #244 made, not more.** Under #244
every seam and every pause armed a stop; a Foray that stays loaded now arms none, and
every stop avoided is a start avoided — including the background ones Android 12+
refuses.

**What it costs, stated plainly:** an ongoing notification can outlive interest. A
listener who pauses mid-Foray and walks away keeps it until they stop the player.
That is why `stop` is exposed as a transport control **and** wired to the
notification's swipe (`setDeleteIntent`), and why `setOngoing` tracks whether audio is
actually sounding: a paused Foray's notification is dismissible, and dismissing it
closes the player rather than orphaning a service.

**The fallback is the old behaviour.** `mediaLoaded` starts false and only
`setMediaLoaded` moves it, so if the polyfill never installs — a WebView that ships
`mediaSession` after all, a `client.js` that threw — every path in the shell is
#244's, unchanged. A test asserts exactly that.

**One pre-existing hole closed on the way, because this widens it.** A page *reload*
mid-playback left #244's service running with a page that no longer existed; the new
page starts with `wanted: false` and so cannot stop it, and now the service no longer
times out either. `ForayAudioPlugin` registers a Capacitor `WebViewListener` and stops
the service on `onPageLoaded`: a fresh page has nothing playing by definition and
will re-ask on its first `play()`, from the foreground, which Android cannot refuse.

### 5.2 The notification is now built from what the page reported

It says the source episode, the source show and the Foray plus "part N of M", and
carries previous, play/pause, next and stop — each declared only when the page
installed the matching handler, so a single episode gets no dead skip buttons. It is
`VISIBILITY_PUBLIC`, which is load-bearing rather than cosmetic: with the default
`PRIVATE` and a lock screen set to hide sensitive content, the whole point of this
notification is replaced by "Contents hidden".

**Hand-built rather than `DefaultMediaNotificationProvider`,** because that provider
is driven by `MediaSessionService`'s lifecycle through a
`MediaNotification.ActionFactory` only Media3's own `MediaNotificationManager`
implements. Keeping #244's lifecycle means keeping the notification, and it is ~40
lines of explicit actions rather than an adapter around a provider built for a service
we deliberately are not.

**Two things the compiler and the type system caught, both worth recording:**

- **`MediaStyle.setShowCancelButton` and `setCancelButtonIntent` were in the first
  draft.** A deprecation note in the build sent me to the Media3 source, which says
  both are *"a no-op and usages can be safely removed… previously only operational on
  API < 21"* — and minSdk here is 24. They would have read as the dismissal mechanism
  and been nothing. The real one is `setDeleteIntent` plus `setOngoing`.
- **Each notification button needs its own `PendingIntent` request code.**
  `PendingIntent` equality **ignores extras**, so two of them differing only in an
  extra with the same request code are the *same* `PendingIntent`, and
  `FLAG_UPDATE_CURRENT` rewrites the first one's extras. Share a code and every
  control performs whichever action was built last — press previous, get stop.
  Nothing about that fails a build or a lint, and on a device it looks like a
  mis-wired remote rather than a bug in a number. A test in
  `shell-invariants.test.mjs` asserts the codes are distinct, and a mutation that
  makes two of them collide fails it.

### 5.3 `POST_NOTIFICATIONS`, which #244 was right to leave out

#244's argument was that a foreground service runs whether or not its notification is
shown, so the process-importance and audio-focus properties it existed for did not
depend on the permission — and that *"the notification is only worth showing once it
carries metadata and transport controls, which is #27's Android half."*

This is that half, so the permission is now declared and asked for. **From Android 13
a notification the user has not permitted is not shown**, and the transport controls
*are* the notification — so a denied permission is the difference between a lock
screen with controls and one without.

**When it is asked, and why then.** Once per session, on the **first accepted
start** — which is the first `play()`: a user gesture, with the app in the foreground,
one press after the reason for it. Nothing prompts on launch. Below API 33 native
answers "not required" with no dialog, and Android's own limit stops re-prompting
after two denials. **A denial costs only the notification**: the service still runs
and the audio still plays, and the shell logs a line saying exactly that.

**Two honest limits on this.** First, **that the system media panel specifically
needs the permission is an inference** — SystemUI pairs an active `MediaSession` with
its `MediaStyle` notification, so suppressing the notification should suppress the
panel, but nothing here has observed it. Second, **the prompt is the one
user-visible product change in this branch**, and a founder may want it moved: it is
one call in `foray-audio-shell.js`'s `askForNotifications`, and the shell already
takes `askNotifications: false` to turn it off.

### 5.4 One write a second, not four

`client.js` calls `syncMediaSession()` from `render()`, which runs on `timeupdate` —
4 Hz. `media-session.js` already dedupes to 0.1 s granularity, so ~4 position writes a
second arrive at the polyfill, and a naive bridge would make **~12,000 round trips
per Foray** for a number Media3 extrapolates on its own.

Two mechanisms, and the **order** between them is the interesting part:

- **Coalescing per microtask turn.** One `update()` is three property writes and
  becomes one native call. `release()` is ten and becomes one.
- **A 1 s floor on position-only writes**, checked **after** an identity comparison —
  so anything a listener can *see* (title, show, album, artwork, transport state,
  duration, rate, which actions exist) is sent immediately, and only the playhead
  waits. Rate-limiting the identity too would leave a car display showing the
  previous publisher's name for up to a second at the one moment it changed, which is
  a seam.

## 6. Both APKs still build

### 6.1 The numbers

JDK **21.0.12+8**, SDK platform **android-36**, build tools **36.0.0**, Gradle
**8.14.3**, AGP **8.13.0**, minSdk **24**, compileSdk/targetSdk **36**,
cordova-android **14.0.1**, `androidx.webkit` **1.14.0** — unchanged from
`docs/android-shell-build.md` §1.2, and **no version pin, no `gradle.properties` line
and no `variables.gradle` edit was needed**. The toolchain is the durable copy from
`docs/android-shell-build.md` §1.2a, not `%TEMP%`.

<!-- BUILD-NUMBERS -->

### 6.2 The part a build alone does prove

Read out of build output rather than assumed:

- **The manifest merge landed**, including the new permission. See §6.1's table.
- **Media3 is in the APK**, and only the parts asked for.
- **Both halves of the web side are in the bundle**:
  `assets/public/foray-audio-shell.js` and `assets/public/foray-media-session.js`,
  with both `<script type="module">` tags in the bundle's `index.html`.
- **`lintVitalRelease` passed**, including `:foray-audio:lintVitalAnalyzeRelease`, so
  the new module's sources were analysed rather than skipped — which matters more than
  usual here, because `SimpleBasePlayer` and `MediaStyleNotificationHelper` are
  `@UnstableApi` and the `UnsafeOptInUsageError` lint is an error by default. The
  `@OptIn(markerClass = UnstableApi.class)` annotations on `WebViewPlayer` and
  `PlaybackKeepAliveService` are what satisfy it.

### 6.3 A build I threw away, recorded because it was my mistake

The first `assembleDebug assembleRelease` pair was launched in the background and
then, while it ran, **the mutation harness rewrote four of its input files 25 times**
— `PlaybackKeepAliveService.java`, `WebViewPlayer.java`, the manifest and
`build.gradle` — restoring each one immediately, but with no way to know what Gradle
had read and when. **It was killed and rerun with nothing else touching the tree**,
and only the clean run's numbers are above.

This is #37's own lesson in a new costume: it recorded *"do not run `cap sync` while
Gradle is running"* after a concurrent `cap update` produced a
`NoSuchFileException` that looked like a Gradle state-tracking bug. The general form
is **do not mutate a build's inputs while it reads them**, and a mutation harness is
the most obvious way to do that by accident. Cost: one wasted build.

## 7. The tests, and which suite covers which mechanism

**376 tests in `tools/mobile/`, all green. 25 mutations attempted, 25 caught.** Three
suites, and the point of this table is that a reviewer who wants to check my tests are
not vacuous knows exactly where to look.

| Mechanism | Suite | A mutation that kills it | Tests that fail |
|---|---|---|---|
| Coalescing (one `update()` is one native call) | `foray-media-session.test.mjs` §4 | flush synchronously per write instead of scheduling | 8 |
| The position rate limit | same, §4 | delete the `minInterval` check | 1 |
| Identity checked **before** the rate limit | same, §4 | rate-limit everything | 9 |
| "Loaded" read from `metadata`, not `playbackState` | same, §6 | key idle on `playbackState === "none"` | 4 |
| `onLoadedChange` (the seam with the service) | same, §6 | never call it | 3 |
| Artwork address-space rewrite | same, §3 | drop the same-origin branch | 2 |
| `assetUri` refuses a non-string | same, §3 | `String(url)` instead | 1 |
| ms → s on the way back | same, §8 | forward milliseconds | 2 |
| A `seekto` with no position is refused | same, §8 | treat it as 0 | 1 |
| `setActionHandler` throws on an unroutable action | same, §2 | return instead of throwing | 1 |
| Metadata snapshotting | same, §2 | hold the caller's object | 1 |
| The seek increments match `player/media-session.js` | same, §2 | change one of them | 1 |
| The settle window ignores a loaded Foray | `foray-audio-shell.test.mjs` §10 | drop `!mediaLoaded` from the timer | 1 |
| …and so does the visibility net | same, §10 | drop `!mediaLoaded` from that guard | 1 |
| Closing the player stops the service at once | same, §10 | delete the `requestStop()` | 3 |
| `mediaLoaded` is cleared by `uninstall` | same, §10 | keep it | 1 |
| The permission is asked once, and only after an accepted start | same, §11 | ask on every play / ask after a refusal | 1 each |
| Only `start`/`stop` clear the start gate | same, §11 | the old `method !== "state"` blacklist | 1 |
| Distinct `PendingIntent` request codes | `shell-invariants.test.mjs` | make two collide | 1 |
| Every native transport action is routable | same | `"nextTrack"` for `"nexttrack"` | 1 |
| `POST_NOTIFICATIONS` declared and aliased | same | delete the declaration | 1 |
| Media3 pinned exactly, and to the right artefacts | same | `1.+`, or add `media3-exoplayer` | 1 each |

**Two mutations survived a first pass, and both were real test gaps rather than dead
code.** They are named because "a surviving mutant is not always a missing test" cuts
both ways, and this time it was:

1. **"Ask for notifications on every play" survived.** The `notificationsAsked` flag
   looked redundant because a second `play()` short-circuits in `ensureStarted`'s own
   `wanted && startAccepted` guard — so nothing asked twice anyway. The flag earns its
   keep across a **stop**: after one, `startAccepted` is false, the next play really
   does re-issue a start, and its callback really would prompt again. A test for that
   sequence now exists.
2. **`"nextTrack"` for `"nexttrack"` survived** the invariant written to catch exactly
   it, because the scanner matched `"[a-z]+"` and a camelCase action simply did not
   match the pattern — so it was never checked against the routable set. It is
   `[A-Za-z]+` now.

**And one test in the new suite was vacuous in the classic way**, found while fixing
an unrelated failure: "a loaded Foray survives the settle window" asserted that no
stop was dispatched against a fake timer that had **never been fired** — the clock's
`advance()` moves `now` and `fireAll()` runs callbacks, and only the first was
called. It would have passed with `mediaLoaded` deleted from the codebase entirely.

## 8. What is NOT known, stated as plainly as possible

**Nothing in this change has been executed on a device or an emulator.** In
particular, all of the following are **unverified**, not inferred:

- that anything at all renders on a lock screen;
- that the notification appears, or that the system promotes it into the media control
  panel;
- that a Bluetooth or steering-wheel button reaches the session;
- that a press on any of it reaches the page;
- that the `MediaSession` is created successfully at runtime (it is built inside a
  `try`, and a failure degrades to #244's behaviour — which means a device pass has to
  read `sessionActive` rather than assume);
- that `navigator.mediaSession` is in fact absent, which is this whole change's
  **premise** and is still source-derived (MP1 §5.4).

What *is* established is that both APKs build, that the session, the service and both
web halves reach the merged manifest and the APK, and that the state machine behaves
against fakes. #244 set that standard and it is the right one.

### 8.1 What a device pass should read, in order

`chrome://inspect`, with a phone over USB and the app playing a Foray:

1. `navigator.mediaSession.forayPolyfill` → `true` means the polyfill installed;
   `undefined` with a `mediaSession` present means **the WebView shipped the real API
   and MP1 §5.4 is wrong** — which would be the single most valuable finding available
   here.
2. `window.ForayMediaSession.peek()` → the payload the lock screen was last told,
   without waiting for a write. Compare it to what the screen actually shows.
3. `window.ForayMediaSession.inspect()` → `sends` twice, a minute apart. Four a second
   means the rate limit is not working; zero while audio plays means this file is not
   reaching native at all.
4. `await Capacitor.nativePromise("ForayAudio", "state", {})` → `running`,
   `sessionActive`, `notificationsEnabled`, `notificationPermission`. **"The lock
   screen is blank" has at least three causes and only one of them is a bug in this
   code**, and those four fields tell them apart.
5. `adb shell dumpsys media_session` → whether the platform sees our session at all,
   and `adb shell dumpsys activity services com.jwincorporated.foray` → whether the
   service is `foregroundServiceType=mediaPlayback`.
6. Then the part no console answers: lock the phone, and press each button.

## 9. The one thing this would want from `player/`

Nothing under `player/` is modified and nothing needs to be for this to work. But one
thing would make §4.4 better rather than merely honest:

**a listing of the queue's titles.** `player/media-session.js` publishes the current
item's metadata; if it also published `{ index, total }` and the neighbouring items'
titles — or if `mediaSessionView` grew an optional `queue: [{ title, show }]` — the
timeline could be the real running order instead of a three-window neighbourhood, a
head unit could show "12 of 32" truthfully, and a controller with a queue view would
have one. It is not required for any of #27's acceptance criteria, and it is a change
to a module with an open issue on it (#224), so it is named here rather than done.

## 10. Status after this change

| | State |
|---|---|
| Lock-screen metadata | **Built**, from `player/media-session.js`'s own mapping. §2. **Never rendered** |
| Play / pause / next / previous / ±seek / scrub / stop | **Built** and routed to the page. §4. **Never pressed** |
| Artwork | URI on the session; **no bitmap loaded** for the notification, by decision. §2.1 |
| `navigator.mediaSession` polyfill | **Built**, and inert if the engine ever ships the real one |
| Media3 | `media3-session` + `media3-common` **1.11.0**, in both APKs. §3 |
| The foreground service's lifetime | **Changed**: "a Foray is loaded", not "audio is sounding". §5.1 |
| `POST_NOTIFICATIONS` | **Declared, and asked for once** on the first accepted start. §5.3 |
| Audio focus | **Still not requested**, deliberately. §4.3 |
| Both APKs | **Built.** §6 |
| Anything observed on a device or an emulator | **No.** §8 |
| An Android CI job | **Not added** — `.github/` is governed. The shape is in `docs/android-shell-build.md` §3.3 |
