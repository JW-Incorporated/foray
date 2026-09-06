import Foundation
import AVFAudio
import MediaPlayer
import Capacitor

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
/// 2. **Audio-session policy.** This plugin calls ONLY
///    `AVAudioSession.setActive(true)`, never `setCategory`. WebKit and
///    `ForayTtsPlugin` both already set `.playback`/`.spokenAudio` before this
///    plugin ever runs; re-asserting a category risks interrupting an
///    already-correctly-configured, possibly-rendering session.
///    `setActive(true)` on an already-active session is a documented no-op.
///    This plugin never calls `setActive(false)`.
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
        applyNowPlayingInfo(payload)
        applyCommandAvailability(payload)

        // See design comment §2: ensure the session is ACTIVE so remote
        // commands are delivered, but never re-assert a category WebKit or
        // ForayTts may already have set for a session that is actively
        // rendering. `setActive(true)` on an already-active session with
        // default options is a documented no-op.
        try? AVAudioSession.sharedInstance().setActive(true)

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
    /// Android's `assetUri()` rewrite sits behind.
    ///
    /// Loading is SYNCHRONOUS-ISH here (best-effort, cache-friendly) rather
    /// than a fully async fetch-then-repost: `setNowPlaying` already runs off
    /// the bridge's own call queue, not the main thread, and a missing or
    /// slow artwork must never block or crash the metadata write that always
    /// matters more (title/position/transport). A failed load simply omits
    /// the key, which is the same "no artwork, never a guess" rule
    /// `media-session.js`'s `artworkUrl()` already enforces upstream.
    private func artworkItem(for uri: String) -> MPMediaItemArtwork? {
        guard !uri.isEmpty, let url = URL(string: uri) else { return nil }
        let image: UIImage?
        if url.isFileURL {
            image = UIImage(contentsOfFile: url.path)
        } else if let data = try? Data(contentsOf: url) {
            image = UIImage(data: data)
        } else {
            image = nil
        }
        guard let image = image else { return nil }
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
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
            // {action:"seekto", positionMs}` on the FORAY's clock -- the same
            // clock `positionMs` was reported on, per L-01's acceptance. The
            // wire shape is `{action, positionMs?, offsetMs?}` in
            // MILLISECONDS (`foray-media-session.js`'s own doc comment on
            // `TRANSPORT_EVENT`), which the web half itself converts to
            // seconds before handing it to `media-session.js`'s spec-shaped
            // handlers.
            let positionMs = Int64((event.positionTime * 1000).rounded())
            self?.emitTransport(action: "seekto", positionMs: positionMs)
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
    /// (`state == .none`) disables every transport command, mirroring
    /// `NowPlaying.acceptsTransport()`.
    private func applyCommandAvailability(_ payload: NowPlayingPayload) {
        let transportable = payload.state != .none

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
        var event = JSObject()
        event["action"] = action
        if let positionMs = positionMs {
            event["positionMs"] = Int(positionMs)
        }
        if let offsetMs = offsetMs {
            event["offsetMs"] = Int(offsetMs)
        }
        notifyListeners(Self.TRANSPORT_EVENT, data: event)
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
