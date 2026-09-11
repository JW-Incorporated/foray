import Foundation
import AVFAudio
import MediaPlayer
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
/// Foray reports `"none"`. `NowPlaying.java` / `NowPlayingParsingTest.java` /
/// `NowPlayingHubTest.java` on the Android side are this file's mirror --
/// `ForayAudioPluginTests.swift` is written to test the same properties against
/// the same payload shape.
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
/// 2. **Audio-session policy: this plugin NEVER touches the session.** It sets
///    no category and does not change the session's active state — not
///    `setActive(true)`, not `setActive(false)`. WebKit activates the shared
///    `.playback` session for the audible `<audio>` element, and
///    `ForayTtsPlugin` activates `.spokenAudio` for narration; each of the two
///    real audio producers owns its own activation. An earlier version called
///    `setActive(true)` from `setNowPlaying` "to ensure commands are delivered,"
///    believing it a no-op on an already-active session. It is not harmless on
///    the 4 Hz hot path: re-asserting activation on the session WebKit holds
///    interrupts WebKit's element, which pauses; the player reconciles and
///    resumes; the next position write repeats it — the F11/F13 pause loop
///    (founder device diagnostics, 2026-09-08/09, loop period == the position
///    write cadence). `MPRemoteCommandCenter` handlers are process-level and are
///    delivered whichever producer activated the session, so this plugin needs
///    no activation of its own. `shell-invariants.test.mjs` pins that
///    `setNowPlaying` contains no `setActive` call so this cannot regress.
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

    private let commandCenter = MPRemoteCommandCenter.shared()
    private var commandsRegistered = false

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

    override public func load() {
        registerCommandHandlers()
    }

    // MARK: - setNowPlaying

    /// Everything the lock screen / Control Center should say, from the
    /// page's own `navigator.mediaSession` writes (via the `foray-audio`
    /// polyfill's `nowPlayingPayload()`).
    ///
    /// RESOLVES ALWAYS -- see class header. Payload parsing degrades a
    /// missing/garbage field to the honest empty value rather than throwing,
    /// the same rule `NowPlaying.java` states for Android.
    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let payload = NowPlayingPayload.from(call.options as? [String: Any] ?? [:])
        if lastLoggedState != payload.state {
            lastLoggedState = payload.state
            Self.logger.notice("ForayAudio.setNowPlaying reached state=\(payload.state.rawValue, privacy: .public)")
        }
        applyNowPlayingInfo(payload)
        applyCommandAvailability(payload)

        // This plugin does NOT touch the audio session's active state. See
        // design comment §2: `setNowPlaying` runs on `render()`'s hot path up to
        // 4 Hz, and calling `AVAudioSession.setActive(true)` there — even though
        // it reads as a no-op — repeatedly re-asserts activation on the SHARED
        // session that WebKit is holding for the audible `<audio>` element. On a
        // real device that reactivation interrupts WebKit's element, which fires
        // an unheard `pause`; the player reconciles it, resumes, and the next
        // ~1 s position write does it again — the F11/F13 pause loop, whose
        // period matched this write cadence exactly (founder diagnostics,
        // 2026-09-08/09). The two real audio producers each own activation:
        // WebKit activates for the `<audio>` element, `ForayTtsPlugin` for
        // narration. `MPRemoteCommandCenter` handlers are process-level and are
        // delivered regardless of which of them activated the session, so
        // nothing here needs to activate it.

        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["reason"] = ""
        call.resolve(result)
    }

    // MARK: - MPNowPlayingInfoCenter

    private func applyNowPlayingInfo(_ payload: NowPlayingPayload) {
        guard payload.state != .none else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
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
        // below).
        info[MPNowPlayingInfoPropertyPlaybackRate] = Double(
            payload.state == .playing ? payload.playbackRate : 0
        )
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = Double(payload.playbackRate)

        if let artwork = artworkItem(for: payload.artworkUri) {
            info[MPMediaItemPropertyArtwork] = artwork
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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
    /// than a fully async fetch-then-repost: `setNowPlaying` already runs off
    /// the bridge's own call queue, not the main thread, and a missing or
    /// slow artwork must never block or crash the metadata write that always
    /// matters more (title/position/transport). A failed load simply omits
    /// the key, which is the same "no artwork, never a guess" rule
    /// `media-session.js`'s `artworkUrl()` already enforces upstream.
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
    /// report is which commands are ENABLED (`applyCommandAvailability`) --
    /// mirroring Android's `WebViewPlayer` command-set-from-flags mapping,
    /// which is also built once and toggled by availableCommands.
    private func registerCommandHandlers() {
        guard !commandsRegistered else { return }
        commandsRegistered = true

        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "play")
            return .success
        }
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "pause")
            return .success
        }
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "play")
            return .success
        }
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "nexttrack")
            return .success
        }
        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "previoustrack")
            return .success
        }
        commandCenter.skipBackwardCommand.preferredIntervals = [15]
        commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "seekbackward", offsetMs: Self.seekBackwardMs)
            return .success
        }
        commandCenter.skipForwardCommand.preferredIntervals = [30]
        commandCenter.skipForwardCommand.addTarget { [weak self] _ in
            self?.emitTransport(action: "seekforward", offsetMs: Self.seekForwardMs)
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
            self?.notifyListeners(
                Self.TRANSPORT_EVENT,
                data: Self.seekToTransportEvent(positionTime: event.positionTime)
            )
            return .success
        }

        // `stop`: registered but PERMANENTLY DISABLED. See design comment §3
        // -- iOS has no ongoing notification needing a one-press exit, so
        // `stop` is declined outright rather than gated on `state != none`
        // like the other commands.
        commandCenter.stopCommand.addTarget { _ in .success }
        commandCenter.stopCommand.isEnabled = false
    }

    /// Enable/disable each command from the `can*`/`has*` flags -- exactly
    /// `nowPlayingPayload()`'s contract, and exactly what `WebViewPlayer`
    /// does with the same flags on Android. A finished Foray
    /// (`state == .none` OR `state == .ended`) disables every transport
    /// command, mirroring `NowPlaying.acceptsTransport()`, which declines
    /// transport for both IDLE and ENDED.
    private func applyCommandAvailability(_ payload: NowPlayingPayload) {
        let transportable = payload.state != .none && payload.state != .ended

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

    private func emitTransport(action: String, positionMs: Int64? = nil, offsetMs: Int64? = nil) {
        notifyListeners(
            Self.TRANSPORT_EVENT,
            data: Self.transportEvent(action: action, positionMs: positionMs, offsetMs: offsetMs)
        )
    }

    /// The wire shape of a `transport` event: `{action, positionMs?, offsetMs?}`
    /// in MILLISECONDS (`foray-media-session.js`'s own doc comment on
    /// `TRANSPORT_EVENT`), which the web half converts to seconds before
    /// handing it to `media-session.js`'s spec-shaped handlers. Pure and
    /// `internal` (not `private`) so `ForayAudioPluginTests` can pin it.
    static func transportEvent(action: String, positionMs: Int64? = nil, offsetMs: Int64? = nil) -> JSObject {
        var event = JSObject()
        event["action"] = action
        if let positionMs = positionMs {
            event["positionMs"] = Int(positionMs)
        }
        if let offsetMs = offsetMs {
            event["offsetMs"] = Int(offsetMs)
        }
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
        return transportEvent(action: "seekto", positionMs: positionMs)
    }

    /// `04_VOICE_AUDIO_SPEC.md`'s ±30/15 s, mirroring the constants
    /// `foray-media-session.js` exports as `SEEK_BACKWARD_SEC`/
    /// `SEEK_FORWARD_SEC`. Duplicated here rather than read from the web
    /// file, same reason Android's plugin duplicates them: this file has no
    /// access to `player/`'s module graph, and `foray-media-session.test.mjs`
    /// already asserts the web constants match `player/media-session.js`.
    private static let seekBackwardMs: Int64 = 15_000
    private static let seekForwardMs: Int64 = 30_000
}
