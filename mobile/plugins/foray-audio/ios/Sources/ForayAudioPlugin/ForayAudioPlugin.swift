import Foundation
import AVFAudio
import MediaPlayer
import UIKit
import Capacitor
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
/// ── L-01's DESIGN COMMENT (kanban card t_44e5da2a), SETTLED BEFORE THIS FILE ──
///
/// 1. **Who owns Now Playing when an `<audio>` element is playing -- the
///    plugin or WebKit?** The plugin, by construction: WebKit publishes
///    synchronously off the `<audio>` element's own events, on the same JS
///    tick; `player/client.js`'s `syncMediaSession()` runs from that SAME
///    event and calls `setNowPlaying`, which crosses the Capacitor bridge --
///    an inherently async hop that lands on a later runloop turn than
///    WebKit's same-tick write. So our write is structurally the later one on
///    every seam, with no need to suppress WebKit (there is no public API to
///    do that anyway). During narration there is no `<audio>` element, so
///    there is no second writer at all.
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
///    (nothing is sounding, so nothing can be interrupted by it) and keeps it
///    until the transport is playing again (`releaseSession`, quietly) or
///    closed/finished (with `.notifyOthersOnDeactivation`, so the app that was
///    interrupted may resume -- Apple's own guidance). The playing path still
///    calls `setActive` NEVER: an earlier version re-asserted activation from
///    `setNowPlaying` on `render()`'s 4 Hz hot path and interrupted WebKit's
///    audible element every write -- the F11/F13 pause loop (founder device
///    diagnostics, 2026-09-08/09). `sessionMove(from:to:holding:)` is the
///    whole rule, pure, so the XCTests pin it and `shell-invariants.test.mjs`
///    pins that `setActive` is reachable from nowhere but `holdSession` /
///    `releaseSession`.
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
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise)
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

    /// Bumped on every payload, so a re-assert armed for an older pause does
    /// not fire after the transport has moved on.
    private var reassertGeneration: UInt64 = 0

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
            self.emitSession(
                kind: began ? "interruptionBegan" : "interruptionEnded",
                reason: began
                    ? (held ? "began-while-held" : "began")
                    : (shouldResume ? "should-resume" : "no-resume")
            )
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
                self.reassertNowPlaying(reason: "route")
            }
        }
    }

    @objc private func handleServicesReset(_ note: Notification) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            /* The media server restarted: every session is gone, ours included. */
            self.holdsSession = false
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
    /// `platform`, `reason`), the apply runs on `stateQueue` in the order the
    /// payloads arrived, and a page waiting a bridge round-trip for a lock
    /// screen write would be a page waiting on a network artwork load
    /// (`artworkItem(for:)` fetches synchronously).
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
        reassertGeneration &+= 1
        if lastLoggedState != payload.state {
            lastLoggedState = payload.state
            Self.logger.notice("ForayAudio.setNowPlaying reached state=\(payload.state.rawValue, privacy: .public)")
        }
        applyNowPlayingInfo(payload)
        applyCommandAvailability(payload)
        applySessionMove(Self.sessionMove(from: previous.state, to: payload.state, holding: holdsSession))
    }

    // MARK: - the app's own audio session (design comment §2)

    /// What the session does on a transport transition. Pure, so the XCTests
    /// can table it; the ONLY caller of `holdSession`/`releaseSession` below is
    /// `applySessionMove`, and `shell-invariants.test.mjs` pins that.
    enum SessionMove: Equatable {
        /// Nothing: a position write, a seam, a state we do not act on.
        case none
        /// The transport just PAUSED: take the app's `.playback` session so the
        /// OS keeps 4a as the Now Playing app while nothing is sounding.
        case hold
        /// The transport is PLAYING again: let go quietly. WebKit's element has
        /// its own session; ours would be a second one for the same app, and a
        /// release with `notifyOthers` here would tell the app WE interrupted
        /// to resume over our own audio.
        case releaseQuietly
        /// The player closed or the Foray finished: let go and tell whoever we
        /// interrupted -- Apple's guidance for the end of playback, and the one
        /// moment "Spotify resumed" is the correct outcome.
        case releaseAndNotify
    }

    /// The rule. `holding` is whether this plugin's own activation is still
    /// standing (an interruption or a media-services reset takes it away
    /// without a payload); a release is only ever attempted for one we made.
    static func sessionMove(
        from previous: NowPlayingPayload.State, to next: NowPlayingPayload.State, holding: Bool
    ) -> SessionMove {
        switch (previous, next) {
        /* PLAYING -> PAUSED ONLY. Not `anything -> paused`: the restored mini bar
           writes `paused` at launch with nothing loaded, and taking a
           non-mixable session then would silence whatever the listener was
           playing in another app for opening ours. A pause of our OWN audio is
           the only pause that has an audio session to keep. */
        case (.playing, .paused):
            return .hold
        case (_, .playing):
            return holding ? .releaseQuietly : .none
        case (_, .none), (_, .ended):
            return holding ? .releaseAndNotify : .none
        default:
            return .none
        }
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
        case .releaseQuietly:
            releaseSession(reason: "playing", notifyOthers: false)
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

    /// Let go of an activation WE made. `notifyOthersOnDeactivation` only at
    /// the end of playback -- see `SessionMove`.
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
    /// Loading is SYNCHRONOUS-ISH here (best-effort, cache-friendly) rather
    /// than a fully async fetch-then-repost: this runs on `stateQueue`, never
    /// the main thread, and a missing or slow artwork must never block or
    /// crash the metadata write that always matters more
    /// (title/position/transport). A failed load simply omits the key, which
    /// is the same "no artwork, never a guess" rule `media-session.js`'s
    /// `artworkUrl()` already enforces upstream.
    private func artworkItem(for uri: String) -> MPMediaItemArtwork? {
        guard !uri.isEmpty else { return nil }
        let image: UIImage?
        if let bundlePath = Self.bundlePath(for: uri) {
            // `Bundle.main`, not `URL(string:)` -- `bundle://` is not a real
            // URL scheme any loader below this line understands, so the path
            // component is resolved by hand and everything else about the
            // string is discarded.
            image = UIImage(contentsOfFile: bundlePath)
        } else if let url = URL(string: uri) {
            if url.isFileURL {
                image = UIImage(contentsOfFile: url.path)
            } else if let data = try? Data(contentsOf: url) {
                image = UIImage(data: data)
            } else {
                image = nil
            }
        } else {
            image = nil
        }
        guard let image = image else { return nil }
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
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
