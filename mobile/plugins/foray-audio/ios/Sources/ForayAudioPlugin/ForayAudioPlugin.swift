import Foundation
import AVFAudio
import MediaPlayer
import UIKit
import Capacitor
import ForayEngineCore
import os

/// The iOS half of `foray-audio`'s Now Playing / remote-command story (L-01).
///
/// UNLIKE `foray-tts`, this file is not `foray-audio`'s WHOLE iOS half -- there
/// isn't one. The audio-keepalive service (`android/`) stays Android-only, per
/// this plugin's `package.json` `"//no-ios"` note: WebKit already keeps a
/// backgrounded `<audio>` element alive on iOS by itself. This file exists to
/// answer exactly one gap `docs/ios-controls-and-voice-plan.md`'s M-01 measured
/// (`docs/ios-lock-screen.md` §0): iOS has **no lock-screen or Control Center
/// transport at all** in the shipping shell.
///
/// ── THE CONTRACT IS THE ANDROID ONE, UNCHANGED ───────────────────────────────
///
/// `mobile/plugins/foray-audio/web/foray-media-session.js` already decided
/// everything a lock screen says (via `player/media-session.js`, which this
/// plugin never sees and does not know exists): three metadata fields,
/// previous/next are SEGMENTS, the position is the FORAY's clock, a finished
/// Foray reports `"none"`, and the seek pair is ±15/30 -- carried in the payload
/// as `seekBackMs`/`seekForwardMs`, which this file READS and never restates.
/// `NowPlaying.java` / `NowPlayingParsingTest.java` / `NowPlayingHubTest.java`
/// on the Android side are this file's mirror -- `ForayAudioPluginTests.swift`
/// is written to test the same properties against the same payload shape.
///
/// ── THE DESIGN COMMENT (L-01, kanban card t_44e5da2a; §1 REWRITTEN 2026-09-23) ──
///
/// 1. **Who owns Now Playing when an `<audio>` element is playing -- the
///    plugin or WebKit?** BOTH, and the page writes to both. L-01 argued
///    that this plugin's write is "structurally the later one" because the
///    bridge hop lands after WebKit's same-tick publish, so the display would
///    always be ours. The founder's phone measured otherwise (2026-09-23,
///    build 2026092326: *"My lock screen and car still displays the song/
///    artist/ album as 4a/ unknown/ unknown"*, and the skip glyphs read
///    WebKit's interval, not ours). WebKit does not write the SAME entry
///    later or earlier -- it publishes a Now Playing entry OF ITS OWN, from
///    its own MediaRemote client, for every playing `<audio>` element,
///    titled from `document.title` ("4a") with no artist and no album, and
///    the lock screen showed that entry during tape. No public API silences
///    it, and L-02's takeover of `navigator.mediaSession` had cut WebKit's
///    real object off from the page, so that entry could never say anything
///    else. The shipped model is a TEE in `foray-media-session.js`: the page's
///    metadata (with the page's own artwork URLs), `playbackState` and action
///    handlers are written to WebKit's real `MediaSession` as well as sent
///    here, so whichever client iOS shows, the three strings are the page's
///    and a press reaches the page's handler. This plugin's `nowPlayingInfo`
///    stays the ONLY entry during narration (no element, so WebKit clears its
///    own) and while the transport is PAUSED and held (§2), which is when a
///    car reads it. Because a press can then arrive through both clients,
///    the page applies one remote action of a kind per short window across
///    origins (`REMOTE_DUPLICATE_WINDOW_MS`) -- nothing here de-duplicates,
///    and nothing here may, because only the page sees both doors.
/// 2. **Audio-session policy: this plugin holds the app's session ONLY WHILE
///    THE TRANSPORT IS PAUSED, and never touches it from the playing path.**
///    Founder, 2026-09-23: *"I started playing 4a, paused and turned off my
///    screen, got in my car, then my car resumed Spotify. This is still
///    wrong."* iOS hands a car's or a Bluetooth stack's play to the NOW
///    PLAYING app, and Apple's rule for staying that app across a pause is:
///    keep an active `.playback` session, keep `nowPlayingInfo` with
///    `playbackRate = 0`, keep the remote-command targets enabled, and clear
///    nothing. WebKit activates the session for its `<audio>` element from
///    its own media process and lets go of it once nothing is playing
///    (`MediaSessionManagerCocoa` moves the category to none two seconds after
///    the last session stops), and nothing in the APP process ever held one --
///    so a paused, backgrounded 4a had no session to be Now Playing with, and
///    the car's play went to whoever had it last. `holdSession` now activates
///    the app's own `.playback` session on the playing -> paused transition
///    -- for a pause the LISTENER made. Nothing of ours is sounding then, so
///    nothing can be interrupted by it; a pause the OS caused is the other
///    case (review, 2026-09-23): another app's non-mixable audio, Siri or a
///    call interrupts our element, the page reconciles to paused, and a hold
///    taken THEN would activate a non-mixable session while the interrupter
///    is still sounding -- 4a re-interrupting the app that just interrupted
///    it (in the foreground iOS allows that; in the background it refuses
///    and the record shows `sessionActivated failed`). So `interrupted` is
///    set from `interruptionBegan` to `interruptionEnded` and the table
///    answers `.none` for a pause inside it. The hold is kept until the
///    transport is playing again or closed/finished. PLAYING AGAIN IS NOT A
///    DEACTIVATION (review, 2026-09-23): the resumed producer's own
///    activation supersedes ours -- WebKit's element from its media process,
///    or, for narration, `ForayTtsPlugin` on the SAME app-process shared
///    instance (its synthesizer uses the application session and never
///    activates it itself; `resume()` calls `setActive(true)` one bridge hop
///    BEFORE the page's `playing` write reaches here). A `setActive(false)`
///    on that write either failed against the synthesizer's running I/O
///    (`sessionReleased failed` on every narration resume) or landed in the
///    tens of milliseconds before it started and resumed the narration into
///    an inactive session: silence. So `.supersede` only forgets the hold.
///    Only the end of playback deactivates (`releaseSession`, with
///    `.notifyOthersOnDeactivation`, so the app that was interrupted may
///    resume -- Apple's own guidance). A hold the OS took away
///    (`began-while-held`) is taken BACK when the interruption ends with
///    `shouldResume` and the transport is still paused, and when a new route
///    appears (the car connecting) -- the thesis of this whole comment is
///    that the active session is what makes iOS hand the car's play to us,
///    and a Siri press or a call between the pause and the car must not
///    quietly give that up. The playing path still calls `setActive` NEVER:
///    an earlier version re-asserted activation from `setNowPlaying` on
///    `render()`'s 4 Hz hot path and interrupted WebKit's audible element
///    every write -- the F11/F13 pause loop (founder device diagnostics,
///    2026-09-08/09). `sessionMove(from:to:holding:interrupted:)` and
///    `shouldRehold(state:holding:interrupted:)` are the whole rule, pure, so
///    the XCTests pin them and `shell-invariants.test.mjs` pins that
///    `setActive` is reachable from nowhere but `holdSession` /
///    `releaseSession`, and that the resume transition reaches neither.
/// 3. **`stop` on iOS: declined outright**, not merely on a finished Foray.
///    Android exposes it because an ongoing foreground-service notification
///    needs a one-press exit; iOS has no equivalent ongoing surface -- Now
///    Playing / Control Center commands simply disappear once we report
///    `state: "none"`. `stopCommand.isEnabled` is permanently `false`.
///
/// ── EVERY METHOD RESOLVES. NONE REJECTS. ─────────────────────────────────────
///
/// Same rule `ForayAudioPlugin.java`'s class comment states and
/// `ForayTtsPlugin.swift`'s header repeats: a rejected `PluginCall` becomes an
/// unhandled promise in a page mid-Foray. `setNowPlaying` is called from
/// `render()`'s hot path, up to 4 Hz -- a rejection there is a promise
/// rejection on a timer nobody is watching.
@objc(ForayAudioPlugin)
public class ForayAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForayAudioPlugin"
    public let jsName = "ForayAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        /* NE-01: the native engine's handshake, STUBBED. iOS only: Android's
           `ForayAudioPlugin.java` never gains it (docs/native-engine-plan.md
           §4.1, "three bridge methods on the existing plugin"). */
        CAPPluginMethod(name: "engineHello", returnType: CAPPluginReturnPromise)
    ]

    /// The event this plugin raises when the OS, a Bluetooth button or a car
    /// head unit asks for something. Mirrors `TRANSPORT_EVENT` in
    /// `foray-media-session.js` (Android's `ForayAudioPlugin.java` names the
    /// same constant) -- `shell-invariants.test.mjs` pins the string so a
    /// rename on one side does not silently drop every press.
    static let TRANSPORT_EVENT = "transport"

    /// M-03 (founder feedback F16, #548). The event this plugin raises when
    /// the SYSTEM changes something under the player: an `AVAudioSession`
    /// interruption, a route change, a media-services reset, the app moving
    /// between background and foreground -- and, since 2026-09-23, the three
    /// things this plugin DOES about them (`sessionActivated`,
    /// `sessionReleased`, `nowPlayingReasserted`), so the record can say
    /// whether 4a was holding on when the car took the audio elsewhere.
    ///
    /// ── WHY THIS IS A CARD AT ALL ────────────────────────────────────────
    /// The founder's record for the F16 drive holds exactly one finding:
    /// `stop element pausedUnexpectedly` + `reconcile unexplainedPause` at
    /// `hidden=y`, `seams 0`, about 30 s after play with the screen off. That
    /// says the element stopped and says NOTHING about why, because the page
    /// cannot see any of the four things above — `<audio>` reports a bare
    /// `pause` event for a phone call, a Bluetooth disconnect, a Siri
    /// invocation and a media-services reset alike. This plugin can see all
    /// four, and until now threw them away.
    ///
    /// REPORTED, NEVER ACTED ON as far as the TRANSPORT goes. Nothing here
    /// resumes, pauses or reconciles: `player/queue-manager.js` owns the
    /// transport, and a plugin that resumed on `shouldResume` would be a second
    /// opinion about it. What the plugin does act on is its OWN Now Playing
    /// entry: `reassertNowPlaying` re-writes it on the way into the background
    /// and when a route appears, which changes what the OS shows and never
    /// what the page plays.
    static let SESSION_EVENT = "session"

    /// Where every command this plugin forwards came from, for the record's
    /// `remote` row (`REMOTE_ORIGINS` in `player/diagnostic-log.js`). One
    /// token: `MPRemoteCommandCenter` cannot tell a lock screen from CarPlay
    /// from a headphone pinch, and inventing a distinction would be prose.
    static let REMOTE_ORIGIN = "command-center"

    private let commandCenter = MPRemoteCommandCenter.shared()
    private var commandsRegistered = false

    /// Everything after the bridge: the payload, the session, the command
    /// centre and the Now Playing centre are touched from this ONE serial
    /// queue. `setNowPlaying` arrives on Capacitor's bridge queue, the
    /// notification observers on main, the remote-command handlers on main,
    /// and the re-assert timer from wherever it was armed -- four writers of
    /// `lastPayload` and `holdsSession` otherwise.
    private let stateQueue = DispatchQueue(label: "ai.jwlabs.foura.audio.state")

    /// The last payload the page sent, so a remote command and a re-assert
    /// can read the state they are acting in without asking the page (which
    /// may be asleep). `.empty` until the first `setNowPlaying`.
    private var lastPayload: NowPlayingPayload = .empty

    /// Whether THIS plugin currently holds the app's audio session active --
    /// design comment §2. Read by the interruption observer so the record can
    /// say `began-while-held`, and by `sessionMove` so a release is only
    /// attempted for an activation we made.
    private var holdsSession = false

    /// Whether an `AVAudioSession` interruption is in progress: set on
    /// `interruptionBegan`, cleared on `interruptionEnded`, on a media-services
    /// reset, and by anything that means the listener moved on (a `playing`
    /// payload, a remote play) -- Apple does not promise an `.ended` for every
    /// `.began`, and a flag that could stick forever would refuse every later
    /// hold. Read by `sessionMove` so a pause the OS caused takes no hold
    /// (design comment §2).
    private var interrupted = false

    /// Bumped when the payload's STATE changes, so a re-assert armed for an
    /// older pause does not fire after the transport has moved on. Not on every
    /// payload (review, 2026-09-23): a lock-screen scrub while paused, or a
    /// trailing position write, is a `paused` payload inside the 3 s window,
    /// and bumping on it cancelled the pause-settled re-assert with nothing to
    /// re-arm it -- `sessionMove(.paused, .paused)` is `.none`. A position change
    /// while paused is not the transport moving on.
    private var reassertGeneration: UInt64 = 0

    /// The artwork last built, keyed by the URI it was built from, so a
    /// re-assert or a position write never loads it again -- see `artworkItem`.
    private var artworkCache: (uri: String, item: MPMediaItemArtwork?)?
    /// Remote artwork URIs with a load in flight, so one slow fetch is one fetch.
    private var artworkLoading = Set<String>()

    /// L-02's log-side needle (`FORAY_AUDIO_REACHED_NEEDLE` in
    /// `tools/mobile/ios-ci.mjs`, pinned to this string by
    /// `shell-invariants.test.mjs`). Written on the FIRST `setNowPlaying` this
    /// process handles and on every STATE change after -- never per position
    /// write, which arrives at up to 4 Hz. `os.Logger` lands in the unified
    /// log, which `ios-build.yml`'s `log stream --predicate 'process == "App"
    /// …'` captures; `print`/`CAPLog` are stdout and would not. The state word
    /// is `.public` on purpose: it is the whole point of the line, and the
    /// default `<private>` redaction would leave a needle that says nothing.
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.jwlabs.foura",
        category: "ForayAudio"
    )
    private var lastLoggedState: NowPlayingPayload.State?
    /// L-06's log-side needle, written on the same state-change cadence as
    /// `lastLoggedState` — see `logNowPlayingFields`.
    private var lastLoggedFields: String?
    /// The seek pair last handed to `MPRemoteCommandCenter`, so the two
    /// `preferredIntervals` writes happen when the numbers or the state change
    /// and not on every position report.
    private var lastIntervalsKey: String?

    override public func load() {
        registerCommandHandlers()
        // NOTHING IS PLAYING AT LOAD, so nothing is enabled -- the same answer
        // `NowPlaying.acceptsTransport()` gives for IDLE on Android. Without
        // this, every command sits at `MPRemoteCommand`'s default (enabled)
        // from launch, and a lock screen could offer a play button for a
        // player that has not loaded anything. `.empty` is the payload the
        // page has not sent yet, so the first real `setNowPlaying` is a
        // change the command centre can see.
        applyCommandAvailability(.empty)
        registerSessionObservers()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - M-03: native interruption and lifecycle events

    /// Four notification sources, one event. See `SESSION_EVENT` for why they
    /// are reported rather than handled.
    ///
    /// `UIApplication`'s two are included even though the page already sees
    /// `visibilitychange`, and the redundancy is the point: the F16 record
    /// shows `hidden=y` with no correlated cause, so the open question is
    /// whether the WebView was descheduled BEFORE or AFTER the audio stopped.
    /// The page's own `visibilitychange` cannot answer that — a page that has
    /// been suspended does not run its handler until it is resumed, which is
    /// exactly when the timestamp stops being useful. A native observer runs
    /// on the app's main queue while the WebView is already frozen.
    private func registerSessionObservers() {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleDidEnterBackground(_:)),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleWillEnterForeground(_:)),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
    }

    @objc private func handleInterruption(_ note: Notification) {
        let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
        /* Compared as RAW VALUES rather than as `InterruptionType(rawValue:) == .began`:
           that form relies on Swift promoting the implicit member on the right into an
           Optional, which compiles but reads as a nil-vs-value comparison at a glance.
           This one cannot be misread, and it has no optional to unwrap. */
        let began = raw == AVAudioSession.InterruptionType.began.rawValue
        let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            /* WHETHER WE WERE HOLDING (2026-09-23). An interruption that lands
               while this plugin holds the paused app's session is the OS taking
               that hold away -- a phone call, another app's play, or WebKit's own
               element resuming -- and the record has to tell it from an
               interruption of WebKit's audible element, which is what every
               `interruptionBegan` meant before today. The hold is gone either
               way: iOS deactivates an interrupted session. */
            let held = self.holdsSession
            if began && held { self.holdsSession = false }
            /* From here until `.ended`, a pause the page reports is the OS's
               doing and takes no hold -- `sessionMove`, design comment §2. */
            self.interrupted = began
            self.emitSession(
                kind: began ? "interruptionBegan" : "interruptionEnded",
                reason: began
                    ? (held ? "began-while-held" : "began")
                    : (shouldResume ? "should-resume" : "no-resume")
            )
            /* TAKE THE HOLD BACK (review, 2026-09-23). A call or a Siri press
               between the founder's pause and his car landed `began-while-held`
               and nothing re-activated on `.ended`, so by this file's own thesis
               4a was no longer the app the car's play would go to -- and
               `remotePlay`'s re-hold cannot help, because that press never
               arrives at `MPRemoteCommandCenter` in the first place. Only with
               `shouldResume`: without it the OS is saying the interrupter still
               owns the audio, and a non-mixable activation now would be the
               re-interruption §2 refuses. The transport is not touched -- this
               is the plugin's own session and entry, inside the "reported,
               never acted on" rule. */
            if !began && shouldResume
                && Self.shouldRehold(state: self.lastPayload.state, holding: self.holdsSession, interrupted: self.interrupted) {
                self.holdSession(reason: "interruption-ended")
                self.reassertNowPlaying(reason: "interruption-ended")
            }
        }
    }

    @objc private func handleRouteChange(_ note: Notification) {
        let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
        let reason = Self.routeChangeReason(raw)
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.emitSession(kind: "routeChange", reason: reason)
            /* A ROUTE APPEARING IS THE CAR CONNECTING (2026-09-23), and it is the
               moment just before that car sends its play. A paused transport
               re-asserts its Now Playing entry here so what the head unit reads --
               and who it reads it from -- is us. Never on `old-device-gone`: that
               is the car switching off, and `player/client.js` owns what the
               transport does about it. */
            if reason == "new-device" && Self.shouldReassert(for: self.lastPayload.state) {
                /* A hold lost without an interruption to end -- a media-services
                   reset, an `.ended` iOS never sent -- is taken back here, at the
                   moment it matters. Never during an interruption: the car
                   connecting while another app sounds is not ours to cut. */
                if Self.shouldRehold(state: self.lastPayload.state, holding: self.holdsSession, interrupted: self.interrupted) {
                    self.holdSession(reason: "route")
                }
                self.reassertNowPlaying(reason: "route")
            }
        }
    }

    @objc private func handleServicesReset(_ note: Notification) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            /* The media server restarted: every session is gone, ours included,
               and so is whatever was interrupting it. */
            self.holdsSession = false
            self.interrupted = false
            self.emitSession(kind: "mediaServicesReset", reason: "reset")
        }
    }

    @objc private func handleDidEnterBackground(_ note: Notification) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.emitSession(kind: "background", reason: "did-enter")
            /* THE SCREEN GOING OFF IS THE FOUNDER'S OWN SEQUENCE ("paused and
               turned off my screen"). The page is about to be frozen and will
               write nothing until it wakes; this is the last moment anything can
               make sure the Now Playing entry the OS holds for us says "paused,
               4a, here are the buttons" rather than whatever WebKit left. */
            if Self.shouldReassert(for: self.lastPayload.state) {
                self.reassertNowPlaying(reason: "background")
            }
        }
    }

    @objc private func handleWillEnterForeground(_ note: Notification) {
        stateQueue.async { [weak self] in
            self?.emitSession(kind: "foreground", reason: "will-enter")
        }
    }

    /// `AVAudioSession.RouteChangeReason` -> the closed vocabulary
    /// `player/diagnostic-log.js`'s `dataTokenOf()` admits. A dashed
    /// lower-case token and NEVER the route's name: a Bluetooth route is
    /// named after the person who owns the car, and this record is pasted
    /// into issues — the rule `diagnostic-log.js` already states for
    /// `route.autoResume.knownCar=`, applied at the source. `internal` so
    /// `ForayAudioPluginTests` can pin the mapping without a live session.
    static func routeChangeReason(_ raw: UInt) -> String {
        switch AVAudioSession.RouteChangeReason(rawValue: raw) {
        case .some(.newDeviceAvailable): return "new-device"
        case .some(.oldDeviceUnavailable): return "old-device-gone"
        case .some(.categoryChange): return "category-change"
        case .some(.override): return "override"
        case .some(.wakeFromSleep): return "wake"
        case .some(.noSuitableRouteForCategory): return "no-route"
        case .some(.routeConfigurationChange): return "config-change"
        case .some(.unknown): return "unknown"
        default: return "unknown"
        }
    }

    private func emitSession(kind: String, reason: String) {
        /* THE UNIFIED LOG AS WELL AS THE BRIDGE, and the duplication is the
           point. A `notifyListeners` reaches a WebView that may be suspended —
           which is precisely the case M-03 is about — and Capacitor drops an
           event with no live listener. `os.Logger` lands in the unified log,
           which `ios-build.yml`'s `log stream` already captures, so the
           simulator's screen-off pass has a channel that does not depend on
           the page being awake. `tools/mobile/ios-ci.mjs`'s
           `FORAY_SESSION_NEEDLE` reads exactly this string. Both halves carry
           only the closed vocabulary above, so `.public` is safe. */
        Self.logger.notice(
            "ForayAudio.session kind=\(kind, privacy: .public) reason=\(reason, privacy: .public)"
        )
        notifyListeners(Self.SESSION_EVENT, data: Self.sessionEvent(kind: kind, reason: reason))
    }

    /// The wire shape, pure and `internal` so a test can pin it without a
    /// notification centre. `at` is epoch MILLISECONDS — the unit
    /// `diagnostic-log.js` stamps every entry with, so a reader never has to
    /// guess which clock a native event is on.
    static func sessionEvent(kind: String, reason: String, at: Double = Date().timeIntervalSince1970 * 1000) -> JSObject {
        var event = JSObject()
        event["kind"] = kind
        event["reason"] = reason
        event["producer"] = "audio"
        event["at"] = Int(at.rounded())
        return event
    }

    // MARK: - engineHello (NE-01 stub)

    /// The page's first question to the native engine (docs/native-engine-plan.md
    /// §5.1). NE-01 builds no engine, so the answer is always
    /// `{mode: "legacy", reason: "not-built"}`: keep playing the way the app
    /// plays today. The dictionary comes from `ForayEngineCore` rather than
    /// being written here, which is also what proves the plugin links the
    /// nested core package in the app build. NE-20 replaces this body.
    ///
    /// RESOLVES ALWAYS, like every method on this plugin (class header). No
    /// page calls it yet; one that did before NE-21 would read "legacy" and
    /// carry on unchanged.
    @objc func engineHello(_ call: CAPPluginCall) {
        var result = JSObject()
        for (key, value) in EngineHandshake.notBuiltHello() {
            result[key] = value
        }
        call.resolve(result)
    }

    // MARK: - setNowPlaying

    /// Everything the lock screen / Control Center should say, from the
    /// page's own `navigator.mediaSession` writes (via the `foray-audio`
    /// polyfill's `nowPlayingPayload()`).
    ///
    /// RESOLVES ALWAYS -- see class header. Payload parsing degrades a
    /// missing/garbage field to the honest empty value rather than throwing,
    /// the same rule `NowPlaying.java` states for Android.
    ///
    /// RESOLVED BEFORE IT IS APPLIED, and that is not a race worth closing:
    /// the answer carries no field that depends on the apply (`ok`,
    /// `platform`, `reason`), and the apply runs on `stateQueue` in the order
    /// the payloads arrived. Nothing on that queue waits on the network any
    /// more (`artworkItem(for:)` caches and loads asynchronously), and the
    /// page has no use for an answer that arrives after the entry is written.
    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let payload = NowPlayingPayload.from(call.options as? [String: Any] ?? [:])
        stateQueue.async { [weak self] in
            self?.apply(payload)
        }

        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["reason"] = ""
        call.resolve(result)
    }

    /// One payload, in order: the entry the OS shows, the commands it may
    /// offer, then the session decision -- which reads the state BEFORE this
    /// payload against the state IN it, so it fires on transitions and never
    /// on the 4 Hz position write. On `stateQueue`.
    private func apply(_ payload: NowPlayingPayload) {
        let previous = lastPayload
        lastPayload = payload
        if previous.state != payload.state {
            reassertGeneration &+= 1
        }
        /* The listener is playing again, by whatever door: an interruption
           whose `.ended` never came is over as far as the next pause is concerned. */
        if payload.state == .playing { interrupted = false }
        if lastLoggedState != payload.state {
            lastLoggedState = payload.state
            Self.logger.notice("ForayAudio.setNowPlaying reached state=\(payload.state.rawValue, privacy: .public)")
        }
        applyNowPlayingInfo(payload)
        applyCommandAvailability(payload)
        applySessionMove(Self.sessionMove(
            from: previous.state, to: payload.state, holding: holdsSession, interrupted: interrupted
        ))
    }

    // MARK: - the app's own audio session (design comment §2)

    /// What the session does on a transport transition. Pure, so the XCTests
    /// can table it; the callers of `holdSession`/`releaseSession` below are
    /// `applySessionMove` (both), the interruption and route observers and
    /// `remotePlay` (the hold only), and `shell-invariants.test.mjs` pins that.
    enum SessionMove: Equatable {
        /// Nothing: a position write, a seam, a state we do not act on, or a
        /// pause the OS caused (an interruption is in progress).
        case none
        /// The transport just PAUSED, by the listener: take the app's
        /// `.playback` session so the OS keeps 4a as the Now Playing app while
        /// nothing is sounding.
        case hold
        /// The transport is PLAYING again: FORGET the hold, deactivate nothing.
        /// Whatever is playing now activated a session of its own -- WebKit's
        /// element from its media process, or `ForayTtsPlugin` on this very
        /// shared instance, for narration -- and a `setActive(false)` here
        /// fought that activation (design comment §2). A release with
        /// `notifyOthers` would be worse still: it would tell the app WE
        /// interrupted to resume over our own audio.
        case supersede
        /// The player closed or the Foray finished: let go and tell whoever we
        /// interrupted -- Apple's guidance for the end of playback, and the one
        /// moment "Spotify resumed" is the correct outcome.
        case releaseAndNotify
    }

    /// The rule. `holding` is whether this plugin's own activation is still
    /// standing (an interruption or a media-services reset takes it away
    /// without a payload); a release is only ever attempted for one we made.
    /// `interrupted` is whether an `AVAudioSession` interruption is in
    /// progress: a pause reported inside one is the OS's, and holding on it
    /// would re-interrupt the interrupter.
    static func sessionMove(
        from previous: NowPlayingPayload.State, to next: NowPlayingPayload.State,
        holding: Bool, interrupted: Bool = false
    ) -> SessionMove {
        switch (previous, next) {
        /* PLAYING -> PAUSED ONLY. Not `anything -> paused`: the restored mini bar
           writes `paused` at launch with nothing loaded, and taking a
           non-mixable session then would silence whatever the listener was
           playing in another app for opening ours. A pause of our OWN audio is
           the only pause that has an audio session to keep -- and only when the
           listener made it: an interrupted element reports the same bare pause. */
        case (.playing, .paused):
            return interrupted ? .none : .hold
        case (_, .playing):
            return holding ? .supersede : .none
        case (_, .none), (_, .ended):
            return holding ? .releaseAndNotify : .none
        default:
            return .none
        }
    }

    /// Whether a hold the OS took away should be taken BACK now: the transport
    /// is still paused, we are not holding, and no interruption is in
    /// progress. Read on `interruptionEnded` (with `shouldResume`) and on a
    /// new route; `remotePlay` has its own, looser rule, because a play press
    /// is the listener's word that the interruption is over.
    static func shouldRehold(state: NowPlayingPayload.State, holding: Bool, interrupted: Bool) -> Bool {
        state == .paused && !holding && !interrupted
    }

    /// Whether a background or a new route should re-write the entry: only a
    /// PAUSED transport. A playing one is being written every second anyway,
    /// and an ended or empty one has nothing to assert.
    static func shouldReassert(for state: NowPlayingPayload.State) -> Bool {
        state == .paused
    }

    /// On `stateQueue`.
    private func applySessionMove(_ move: SessionMove) {
        switch move {
        case .none:
            return
        case .hold:
            holdSession(reason: "paused")
            armReassert()
        case .supersede:
            supersedeSession()
        case .releaseAndNotify:
            releaseSession(reason: "closed", notifyOthers: true)
        }
    }

    /// Activate the app's own `.playback` session. `try?` throughout: a failure
    /// here costs the car's play button, not the pause -- and the record says
    /// so (`sessionActivated` with `failed`), which is the whole point of the
    /// row. `mode: .default`, not `.spokenAudio`: `ForayTtsPlugin` sets that
    /// for narration and navigation apps treat it as something to talk over
    /// and resume; a paused podcast is not that.
    private func holdSession(reason: String) {
        let session = AVAudioSession.sharedInstance()
        var ok = true
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true, options: [])
        } catch {
            ok = false
        }
        holdsSession = ok
        emitSession(kind: "sessionActivated", reason: ok ? reason : "failed")
    }

    /// Let go of an activation WE made, at the END of playback only:
    /// `notifyOthersOnDeactivation` so the interrupted app may resume -- see
    /// `SessionMove`. Never on the resume transition; that is `supersedeSession`.
    private func releaseSession(reason: String, notifyOthers: Bool) {
        let session = AVAudioSession.sharedInstance()
        var ok = true
        do {
            try session.setActive(false, options: notifyOthers ? [.notifyOthersOnDeactivation] : [])
        } catch {
            ok = false
        }
        holdsSession = false
        emitSession(kind: "sessionReleased", reason: ok ? reason : "failed")
    }

    /// The transport is playing again: the producer's own activation stands in
    /// for ours from here (one shared instance per process -- design comment
    /// §2), so the hold is forgotten and the session is NOT touched. The row
    /// says `superseded` so a record can tell this from a deactivation.
    private func supersedeSession() {
        holdsSession = false
        emitSession(kind: "sessionReleased", reason: "superseded")
    }

    // MARK: - re-asserting the entry

    /// WebKit lets go of its own Now Playing claim some time after its element
    /// stops -- its category change is delayed two seconds -- and a paused
    /// page writes nothing after that, so the entry the OS holds is whatever
    /// the LAST writer left. Three seconds after a hold, ours is written again.
    static let reassertDelaySec: Double = 3

    private func armReassert() {
        let generation = reassertGeneration
        stateQueue.asyncAfter(deadline: .now() + Self.reassertDelaySec) { [weak self] in
            guard let self = self, self.reassertGeneration == generation else { return }
            guard Self.shouldReassert(for: self.lastPayload.state) else { return }
            self.reassertNowPlaying(reason: "pause-settled")
        }
    }

    /// Re-write the last payload's entry and command set, unchanged. What
    /// changes is who wrote LAST, which on this surface is who is shown. On
    /// `stateQueue`.
    private func reassertNowPlaying(reason: String) {
        applyNowPlayingInfo(lastPayload)
        applyCommandAvailability(lastPayload, force: true)
        emitSession(kind: "nowPlayingReasserted", reason: reason)
    }

    // MARK: - MPNowPlayingInfoCenter

    private func applyNowPlayingInfo(_ payload: NowPlayingPayload) {
        let center = MPNowPlayingInfoCenter.default()
        guard payload.state != .none else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }

        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = payload.title
        info[MPMediaItemPropertyArtist] = payload.artist
        info[MPMediaItemPropertyAlbumTitle] = payload.album
        info[MPMediaItemPropertyPlaybackDuration] = Double(payload.durationMs) / 1000.0
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = Double(payload.positionMs) / 1000.0
        // Written ONCE per report -- the OS extrapolates from the rate, same
        // reasoning `foray-media-session.js` §1 gives for its own 1 s write
        // floor (see that file's header, and NowPlayingPayload's doc comment
        // below). ZERO while paused is half of Apple's "stay the Now Playing
        // app across a pause" rule; the other half is `playbackState` below.
        info[MPNowPlayingInfoPropertyPlaybackRate] = Double(
            payload.state == .playing ? payload.playbackRate : 0
        )
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = Double(payload.playbackRate)

        if let artwork = artworkItem(for: payload.artworkUri) {
            info[MPMediaItemPropertyArtwork] = artwork
        }

        center.nowPlayingInfo = info
        /* Apple's documentation for `playbackState` says "You must set this
           property every time the app begins or halts playback, otherwise
           remote control functionality may not work as expected" -- and, in the
           next sentence, that it only applies to macOS. It is available from
           iOS 13 and costs one enum write; it is set for the platform that
           honours it (Catalyst, and whatever iOS release starts to) and named
           here so nobody reads its absence as an oversight. */
        center.playbackState = Self.playbackState(for: payload.state)
        logNowPlayingFields(payload, hasArtwork: info[MPMediaItemPropertyArtwork] != nil)
    }

    /// The transport word -> `MPNowPlayingPlaybackState`. A finished Foray is
    /// `.stopped`, not `.paused`: `player/media-session.js` §4's "a play
    /// button that cannot do anything is worse than none".
    static func playbackState(for state: NowPlayingPayload.State) -> MPNowPlayingPlaybackState {
        switch state {
        case .playing: return .playing
        case .paused: return .paused
        case .ended, .none: return .stopped
        }
    }

    /// L-06's log-side needle: WHICH of the three fields were non-empty in the
    /// payload that just reached `MPNowPlayingInfoCenter`.
    ///
    /// ── PRESENCE, NEVER CONTENT, AND THAT IS NOT SQUEAMISHNESS ───────────
    /// F15 is "the lock screen showed only 4a", and there are three
    /// explanations: an empty payload, a payload we built wrong, or a payload
    /// that never arrived (WebKit's default Now Playing is the app name). Which
    /// one it is depends only on whether each field was EMPTY — the titles
    /// themselves add nothing to that question, and the unified log is uploaded
    /// as a CI artifact and pasted into issues, so a publisher's episode titles
    /// (and, through them, what the founder listens to) would ride out of the
    /// device for no diagnostic gain. `player/diagnostic-log.js`'s `nowplaying`
    /// entry carries the truncated strings themselves; that record stays on the
    /// phone and is copied by hand. Two channels, two different exposures, and
    /// the field content only crosses the lower one.
    ///
    /// Written on the SAME cadence as the state needle — only when the answer
    /// changes — because `setNowPlaying` runs at up to 4 Hz and a per-write log
    /// line would bury the log the seam parser also has to read.
    private func logNowPlayingFields(_ payload: NowPlayingPayload, hasArtwork: Bool) {
        let fields = Self.fieldPresence(
            title: payload.title, artist: payload.artist, album: payload.album, hasArtwork: hasArtwork
        )
        guard lastLoggedFields != fields else { return }
        lastLoggedFields = fields
        Self.logger.notice("ForayAudio.nowPlaying fields=\(fields, privacy: .public)")
    }

    /// `title=y artist=n album=y artwork=y`. Pure and `internal` so
    /// `ForayAudioPluginTests` can pin it without a Now Playing centre.
    static func fieldPresence(title: String, artist: String, album: String, hasArtwork: Bool) -> String {
        let flag = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "n" : "y" }
        return "title=\(flag(title)) artist=\(flag(artist)) album=\(flag(album)) artwork=\(hasArtwork ? "y" : "n")"
    }

    /// Artwork via `MPMediaItemArtwork`: loaded from the bundle's `public/`
    /// for our own icon, from the network for a publisher's. `artworkUri` has
    /// already been through `foray-media-session.js`'s `artworkUrl()` gate
    /// (only `https:`/`data:`/same-origin survive), the same trust boundary
    /// Android's `assetUri()` rewrite sits behind. On iOS the web half marks
    /// our own icon with the bare `bundle://public/…` scheme
    /// (`IOS_ASSET_BASE` in `foray-media-session.js` -- L-02, the iOS mirror
    /// of Android's `file:///android_asset/public/`); this is the one place
    /// that scheme is resolved, against `Bundle.main`.
    ///
    /// NEVER A NETWORK WAIT ON `stateQueue` (review, 2026-09-23). This used to
    /// run `Data(contentsOf:)` -- a blocking HTTP load with the default ~60 s
    /// timeout -- on every write, on the one serial queue every remote-command
    /// handler now shares. `reassertNowPlaying` fires on exactly the founder's
    /// moments (the car connecting, the screen going off), a paused tape
    /// segment carries the publisher's https artwork, and a phone switching
    /// Wi-Fi -> cellular as the car connects is a stalled fetch: the car's play
    /// returned `.success` at once and `remotePlay` sat behind it for seconds
    /// to a minute. So: the artwork is CACHED per URI (a re-assert re-writes an
    /// unchanged payload by definition), the bundle's own icon and a file URL
    /// are read from disk once, and a remote image is fetched asynchronously
    /// (`URLSession`, bounded) with the entry re-posted when it lands. Until it
    /// lands the entry goes out without artwork -- the same "no artwork, never a
    /// guess" rule `media-session.js`'s `artworkUrl()` enforces upstream -- and
    /// a failed load is cached as none, so a dead URL costs one attempt and not
    /// one per write. On `stateQueue`.
    private func artworkItem(for uri: String) -> MPMediaItemArtwork? {
        guard !uri.isEmpty else { return nil }
        if let cached = artworkCache, cached.uri == uri { return cached.item }
        if let bundlePath = Self.bundlePath(for: uri) {
            // `Bundle.main`, not `URL(string:)` -- `bundle://` is not a real
            // URL scheme any loader below this line understands, so the path
            // component is resolved by hand and everything else about the
            // string is discarded.
            return rememberArtwork(uri: uri, image: UIImage(contentsOfFile: bundlePath))
        }
        guard let url = URL(string: uri) else { return rememberArtwork(uri: uri, image: nil) }
        if url.isFileURL {
            return rememberArtwork(uri: uri, image: UIImage(contentsOfFile: url.path))
        }
        loadRemoteArtwork(uri: uri, url: url)
        return nil
    }

    /// Cache and wrap. A `nil` image is cached too -- "this URI has no artwork"
    /// is an answer, and asking again on every write is the bug above.
    private func rememberArtwork(uri: String, image: UIImage?) -> MPMediaItemArtwork? {
        let item = image.map { image in MPMediaItemArtwork(boundsSize: image.size) { _ in image } }
        artworkCache = (uri: uri, item: item)
        return item
    }

    /// One fetch per URI, off `stateQueue`, bounded. When it lands, the cache is
    /// filled and the entry is re-posted IF the page is still on that artwork --
    /// a payload that moved on in the meantime keeps its own.
    static let artworkTimeoutSec: Double = 10

    private func loadRemoteArtwork(uri: String, url: URL) {
        guard !artworkLoading.contains(uri) else { return }
        artworkLoading.insert(uri)
        let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: Self.artworkTimeoutSec)
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self = self else { return }
            self.stateQueue.async {
                self.artworkLoading.remove(uri)
                let image = data.flatMap { UIImage(data: $0) }
                _ = self.rememberArtwork(uri: uri, image: image)
                if image != nil && self.lastPayload.artworkUri == uri && self.lastPayload.state != .none {
                    self.applyNowPlayingInfo(self.lastPayload)
                }
            }
        }.resume()
    }

    /// `bundle://public/icon-512.png` -> an absolute path inside `Bundle.main`,
    /// or `nil` if `uri` does not carry the scheme `IOS_ASSET_BASE` writes, or
    /// the named resource is not actually in the bundle. TOTAL and never
    /// throws, same posture as `NowPlayingPayload.from` -- a resource that
    /// went missing from the bundle degrades to no artwork, not a crash.
    private static func bundlePath(for uri: String) -> String? {
        let prefix = "bundle://public/"
        guard uri.hasPrefix(prefix) else { return nil }
        // Query/fragment already stripped by the web half's `assetUri`
        // (`pathname` only, per its own comment) before this ever arrives, so
        // what remains is a bare relative path -- e.g. `icon-512.png`.
        let relative = String(uri.dropFirst(prefix.count))
        guard !relative.isEmpty else { return nil }
        // `cap copy`'s Android destination is `public/`; on iOS the Capacitor
        // web assets are copied into the app bundle at `public/` alongside
        // everything else `Bundle.main` already serves the WebView from --
        // the same tree, read a second way.
        return Bundle.main.path(forResource: relative, ofType: nil, inDirectory: "public")
    }

    // MARK: - MPRemoteCommandCenter

    /// Registered ONCE, in `load()`. Handlers are permanent; what changes per
    /// report is which commands are ENABLED and what the skip pair says
    /// (`applyCommandAvailability`) -- mirroring Android's `WebViewPlayer`
    /// command-set-from-flags mapping, which is also built once and toggled by
    /// availableCommands.
    ///
    /// Every handler does its work on `stateQueue`, because it reads
    /// `lastPayload` -- and returns `.success` at once: an
    /// `MPRemoteCommandHandlerStatus` is a receipt, not an outcome, and the
    /// outcome is the page's.
    private func registerCommandHandlers() {
        guard !commandsRegistered else { return }
        commandsRegistered = true

        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.stateQueue.async { self?.remotePlay(command: "play") }
            return .success
        }
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.stateQueue.async { self?.emitTransport(action: "pause", command: "pause") }
            return .success
        }
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.stateQueue.async {
                guard let self = self else { return }
                /* RESOLVED HERE, FROM THE LAST STATE THE PAGE SENT (2026-09-23).
                   This was mapped to `"play"` unconditionally, with a comment
                   that "the page's own handler resolves the actual toggle" -- it
                   does not: `setRunning(true)` on a playing transport is a no-op
                   by design (`player/client.js`: "a `play` that arrived while
                   already playing must not pause"). So a car with ONE button,
                   and a headphone pinch, could never pause. */
                let action = Self.toggleAction(forState: self.lastPayload.state)
                if action == "play" { self.remotePlay(command: "toggle-play-pause") }
                else { self.emitTransport(action: action, command: "toggle-play-pause") }
            }
            return .success
        }
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.stateQueue.async { self?.emitTransport(action: "nexttrack", command: "next-track") }
            return .success
        }
        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.stateQueue.async { self?.emitTransport(action: "previoustrack", command: "previous-track") }
            return .success
        }
        commandCenter.skipBackwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 0
            self?.stateQueue.async {
                guard let self = self else { return }
                self.emitTransport(
                    action: "seekbackward", command: "skip-backward",
                    offsetMs: Self.skipOffsetMs(payloadMs: self.lastPayload.seekBackMs, eventInterval: interval)
                )
            }
            return .success
        }
        commandCenter.skipForwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 0
            self?.stateQueue.async {
                guard let self = self else { return }
                self.emitTransport(
                    action: "seekforward", command: "skip-forward",
                    offsetMs: Self.skipOffsetMs(payloadMs: self.lastPayload.seekForwardMs, eventInterval: interval)
                )
            }
            return .success
        }
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            // A `changePlaybackPosition` event becomes `transport
            // {action:"seekto", positionMs}` on the FORAY's clock -- the
            // conversion lives in `seekToTransportEvent` so
            // `ForayAudioPluginTests` can pin it without a live command center.
            let positionTime = event.positionTime
            self?.stateQueue.async {
                self?.notifyListeners(
                    Self.TRANSPORT_EVENT,
                    data: Self.seekToTransportEvent(positionTime: positionTime)
                )
            }
            return .success
        }

        // `stop`: registered but PERMANENTLY DISABLED. See design comment §3
        // -- iOS has no ongoing notification needing a one-press exit, so
        // `stop` is declined outright rather than gated on `state != none`
        // like the other commands.
        commandCenter.stopCommand.addTarget { _ in .success }
        commandCenter.stopCommand.isEnabled = false
    }

    /// A remote PLAY, from whichever command carried it. If the transport is
    /// paused and our hold was taken away in the meantime (a call ended, a
    /// route came and went), take it again BEFORE the page is told: the page
    /// will play through WebKit's session a moment later, and until then the
    /// OS should already see an active session behind the app it just handed
    /// a play to. Once per press, never on the playing path -- the F11/F13
    /// rule. On `stateQueue`.
    private func remotePlay(command: String) {
        /* The listener's word that whatever interrupted us is over: a play
           press is the one input that may take the hold DURING an
           interruption, because it is the listener choosing 4a over it. */
        interrupted = false
        if lastPayload.state == .paused && !holdsSession {
            holdSession(reason: "remote-play")
        }
        emitTransport(action: "play", command: command)
    }

    /// What a one-button press means, from the last state the page reported.
    /// Pure, so the XCTests pin it: playing -> pause; anything else -> play,
    /// because the page's own `setRunning` declines a play it cannot honour.
    static func toggleAction(forState state: NowPlayingPayload.State) -> String {
        state == .playing ? "pause" : "play"
    }

    /// The offset a skip press carries: the PAYLOAD's number (the page's own
    /// ±15/30, `player/media-session.js`'s constants), and only when the page
    /// has never sent one, the interval the OS reports it used. Never a
    /// literal in this file.
    static func skipOffsetMs(payloadMs: Int64, eventInterval: TimeInterval) -> Int64 {
        if payloadMs > 0 { return payloadMs }
        guard eventInterval.isFinite, eventInterval > 0 else { return 0 }
        return Int64((eventInterval * 1000).rounded())
    }

    /// The `preferredIntervals` the two skip commands should advertise, in
    /// seconds, from the payload's milliseconds. Empty when the page sent
    /// nothing, which leaves the OS its default rather than inventing one.
    static func preferredIntervals(ms: Int64) -> [NSNumber] {
        ms > 0 ? [NSNumber(value: Double(ms) / 1000.0)] : []
    }

    /// Enable/disable each command from the `can*`/`has*` flags -- exactly
    /// `nowPlayingPayload()`'s contract, and exactly what `WebViewPlayer`
    /// does with the same flags on Android. A finished Foray
    /// (`state == .none` OR `state == .ended`) disables every transport
    /// command, mirroring `NowPlaying.acceptsTransport()`, which declines
    /// transport for both IDLE and ENDED.
    ///
    /// THE SKIP PAIR IS WRITTEN HERE, PER STATE CHANGE, and not once in
    /// `load()` (founder, 2026-09-23: "On the lock screen, it's 10s in both
    /// directions"). `MPRemoteCommandCenter` and WebKit's own remote-command
    /// listener register against the same media-remote surface, and WebKit
    /// re-registers its set on every play/pause -- so a pair written once at
    /// load is a pair written FIRST, and this surface shows whoever wrote
    /// last. The numbers are the payload's (`seekBackMs`/`seekForwardMs`, the
    /// page's own ±15/30); `force` is the re-assert path, which writes even
    /// when nothing changed because "who wrote last" is the whole point.
    private func applyCommandAvailability(_ payload: NowPlayingPayload, force: Bool = false) {
        let transportable = payload.state != .none && payload.state != .ended

        let intervalsKey = "\(payload.state.rawValue)/\(payload.seekBackMs)/\(payload.seekForwardMs)"
        if force || intervalsKey != lastIntervalsKey {
            lastIntervalsKey = intervalsKey
            commandCenter.skipBackwardCommand.preferredIntervals = Self.preferredIntervals(ms: payload.seekBackMs)
            commandCenter.skipForwardCommand.preferredIntervals = Self.preferredIntervals(ms: payload.seekForwardMs)
        }

        commandCenter.playCommand.isEnabled = transportable && payload.canPlay
        commandCenter.pauseCommand.isEnabled = transportable && payload.canPause
        commandCenter.togglePlayPauseCommand.isEnabled =
            transportable && (payload.canPlay || payload.canPause)
        commandCenter.nextTrackCommand.isEnabled = transportable && payload.hasNext
        commandCenter.previousTrackCommand.isEnabled = transportable && payload.hasPrevious
        commandCenter.skipBackwardCommand.isEnabled = transportable && payload.canSeekBack
        commandCenter.skipForwardCommand.isEnabled = transportable && payload.canSeekForward
        commandCenter.changePlaybackPositionCommand.isEnabled = transportable && payload.canSeekTo
        // stopCommand stays disabled always -- design comment §3.
    }

    private func emitTransport(action: String, command: String, positionMs: Int64? = nil, offsetMs: Int64? = nil) {
        /* The unified log too, for the same reason `emitSession` writes it: a
           command that reached this process while the WebView was asleep is
           exactly the one the on-device record cannot hold. */
        Self.logger.notice(
            "ForayAudio.remote command=\(command, privacy: .public) action=\(action, privacy: .public)"
        )
        notifyListeners(
            Self.TRANSPORT_EVENT,
            data: Self.transportEvent(action: action, positionMs: positionMs, offsetMs: offsetMs, command: command)
        )
    }

    /// The wire shape of a `transport` event: `{action, positionMs?, offsetMs?,
    /// command, origin, at}` in MILLISECONDS (`foray-media-session.js`'s own
    /// doc comment on `TRANSPORT_EVENT`), which the web half converts to
    /// seconds before handing it to `media-session.js`'s spec-shaped handlers.
    /// `command`/`origin`/`at` are for the record's `remote` row and nothing
    /// else reads them. Pure and `internal` (not `private`) so
    /// `ForayAudioPluginTests` can pin it.
    static func transportEvent(
        action: String, positionMs: Int64? = nil, offsetMs: Int64? = nil,
        command: String? = nil, at: Double = Date().timeIntervalSince1970 * 1000
    ) -> JSObject {
        var event = JSObject()
        event["action"] = action
        if let positionMs = positionMs {
            event["positionMs"] = Int(positionMs)
        }
        if let offsetMs = offsetMs {
            event["offsetMs"] = Int(offsetMs)
        }
        event["command"] = command ?? action
        event["origin"] = REMOTE_ORIGIN
        event["at"] = Int(at.rounded())
        return event
    }

    /// `MPChangePlaybackPositionCommandEvent.positionTime` (SECONDS, on the
    /// timeline this plugin last REPORTED) -> `transport {action: "seekto",
    /// positionMs}`. That timeline IS the Foray's clock: every report's
    /// `durationMs`/`positionMs` span the whole Foray (`media-session.js` §3,
    /// `NowPlayingPayload`'s own doc comment), so the OS's scrub target is
    /// already a Foray-clock second and needs only the unit change -- no
    /// segment offset is added or subtracted here, and none may ever be. A
    /// negative position is not a place on any Foray and clamps to 0, the same
    /// way `NowPlayingPayload` clamps a negative `positionMs` it is sent.
    static func seekToTransportEvent(positionTime: TimeInterval) -> JSObject {
        let positionMs = Int64(max(0, positionTime * 1000).rounded())
        return transportEvent(action: "seekto", positionMs: positionMs, command: "change-position")
    }
}
