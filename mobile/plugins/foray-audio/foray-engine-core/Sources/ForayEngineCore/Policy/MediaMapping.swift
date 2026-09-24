import Foundation

/// What the lock screen, the car and the headphones are told, and which of
/// their buttons work: the Swift port of `player/media-session.js`, which is
/// the reference (docs/native-engine-plan.md §4.5, card NE-12s).
///
/// THE RULES ARE THE JS FILE'S, AND SO ARE THEIR REASONS. Its header is where
/// each one is argued (title = the episode, artist = the SHOW, album = the
/// Foray plus "clip N of M"; "4a" never credits anything a listener hears; a
/// finished Foray shows no transport; the seek pair is the founder's 15/30 and
/// never the platform's offset; a car scrub with no time is not a seek to
/// zero). This file restates none of them. The `media-episode` parity family
/// (`player/parity/fixtures/media-episode`) is the contract between the two,
/// and `MediaEpisodeFamily` runs it: a rule changed here and not in JS, or in
/// JS and not here, turns a case red.
///
/// WHY EVERY STRING OPERATION WORKS ON UTF-16. A fixture's URL or title is
/// compared as JavaScript compares it, code unit by code unit. Swift's
/// `String` compares by grapheme and canonical equivalence, so `hasPrefix("//")`
/// is FALSE for `"//\u{301}x"` where JavaScript's `startsWith("//")` is true,
/// and `trimmingCharacters(in: .whitespaces)` does not trim U+FEFF where
/// `String.prototype.trim` does. The helpers at the bottom are the JS
/// semantics, spelled once.
///
/// NO NUMBER HERE IS RETYPED. The seek pair, the state names, the app's name
/// and icon come from `EngineConstants.MediaSession` (generated from the JS by
/// NE-04), and `shell-invariants.test.mjs` fails on a literal 15 or 30
/// anywhere in the core's sources: the founder's "Both should be 15/30"
/// (2026-09-23) was a bug caused by a second copy of that pair.
///
/// Pure: Foundation only, no MediaPlayer. `NowPlayingPublisher` and
/// `RemoteSurface` (NE-18) turn these values into `MPNowPlayingInfoCenter`
/// writes and `MPRemoteCommand` enablement through their seams.
public enum MediaMapping {
    // MARK: - Constants, read from the generated file

    /// `NONE` / `PAUSED` / `PLAYING`: the web's `playbackState` values. The
    /// native publisher never writes `playbackState` (plan §4.5, OQ-8: it is
    /// macOS-only); it writes rate 0 or the true rate. The string is still the
    /// port's answer, because "a finished Foray reports none" is a rule the
    /// native side obeys by clearing Now Playing (`commandAvailability`).
    public static let none = EngineConstants.MediaSession.none
    public static let paused = EngineConstants.MediaSession.paused
    public static let playing = EngineConstants.MediaSession.playing

    /// `SEEK_BACKWARD_SEC` / `SEEK_FORWARD_SEC`: the founder's pair.
    public static let seekBackwardSec = EngineConstants.MediaSession.seekBackwardSec
    public static let seekForwardSec = EngineConstants.MediaSession.seekForwardSec

    /// `APP_ARTWORK_URL` / `APP_NAME`.
    public static let appArtworkUrl = EngineConstants.MediaSession.appArtworkUrl
    public static let appName = EngineConstants.MediaSession.appName

    /// What `mediaArtworkList` tells the OS about our own icon, whose size is
    /// not in its file name (media-session.js passes these as the override).
    static let appArtworkSizes = "512x512"
    static let appArtworkType = "image/png"

    // MARK: - Artwork

    /// One `MediaImage`: `{src, sizes?, type?}`. A missing size or type is
    /// ABSENT, never guessed (a wrong `type` is worse than none).
    public struct Artwork: Equatable {
        public let src: String
        public let sizes: String?
        public let type: String?

        public init(src: String, sizes: String? = nil, type: String? = nil) {
            self.src = src
            self.sizes = sizes
            self.type = type
        }
    }

    /// `artworkUrl(url)`: the one URL gate. `https:`, a `data:image/` URI, or a
    /// relative path; everything else (http, javascript:, protocol-relative,
    /// anything with a control character or a space inside) is nil.
    public static func artworkUrl(_ url: String?) -> String? {
        guard let s = nonEmptyTrimmed(url) else { return nil }
        let units = Array(s.utf16)
        // CONTROL: any code unit from U+0000 to U+0020, or U+007F. Refuse, never strip.
        if units.contains(where: { $0 <= 0x20 || $0 == 0x7F }) { return nil }
        if units.starts(with: "//".utf16) { return nil }
        guard let scheme = schemeOf(units) else { return s }
        if asciiEqualsIgnoringCase(scheme, "https") { return s }
        if asciiEqualsIgnoringCase(scheme, "data") && asciiHasPrefixIgnoringCase(units, "data:image/") { return s }
        return nil
    }

    /// `mediaArtwork(url, {sizes, type})`: nil when the URL may not be used.
    /// `sizes` / `type` are the caller's override; a blank one is no override.
    public static func artwork(_ url: String?, sizes: String? = nil, type: String? = nil) -> Artwork? {
        guard let src = artworkUrl(url) else { return nil }
        return Artwork(src: src,
                       sizes: nonEmptyTrimmed(sizes) ?? sizesOf(src),
                       type: nonEmptyTrimmed(type) ?? typeOf(src))
    }

    /// `mediaArtworkList({showArtworkUrl, appArtworkUrl})`: the publisher's
    /// square when usable, else our icon, else nothing. Never both: the OS
    /// picks by size, so offering both is a coin flip over whose mark shows.
    public static func artworkList(showArtworkUrl: String? = nil,
                                   appArtworkUrl: String? = MediaMapping.appArtworkUrl) -> [Artwork] {
        if let show = artwork(showArtworkUrl) { return [show] }
        if let app = artwork(appArtworkUrl, sizes: appArtworkSizes, type: appArtworkType) { return [app] }
        return []
    }

    /// `sizesOf(url)`: `/(?:^|[/_-])(\d{2,4})x(\d{2,4})(?:[^/]*)$/`, the
    /// `600x600` Apple already encodes in its artwork URLs, or nil.
    ///
    /// Leftmost match, as `RegExp.exec` finds it. The first digit run must be
    /// WHOLE (2-4 digits then `x`: `\d{2,4}` cannot skip a digit to reach the
    /// `x`); the second takes up to 4 digits and `[^/]*$` the rest, which
    /// therefore may hold no `/`. At index 0 the `^` branch is tried before the
    /// delimiter branch, as the alternation orders them.
    static func sizesOf(_ url: String) -> String? {
        let u = Array(url.utf16)
        let n = u.count
        func matchDigits(at p: Int) -> String? {
            var i = p
            while i < n && isDigit(u[i]) { i += 1 }
            guard (2...4).contains(i - p), i < n, u[i] == 0x78 /* x */ else { return nil }
            let start2 = i + 1
            var j = start2
            while j < n && j - start2 < 4 && isDigit(u[j]) { j += 1 }
            guard j - start2 >= 2, !u[j...].contains(0x2F /* / */) else { return nil }
            return string(u[p..<i]) + "x" + string(u[start2..<j])
        }
        for start in 0..<n {
            if start == 0, let hit = matchDigits(at: 0) { return hit }
            if [0x2F, 0x5F, 0x2D].contains(u[start]) /* / _ - */, let hit = matchDigits(at: start + 1) { return hit }
        }
        return nil
    }

    /// `typeOf(url)`: the MIME type a `data:image/...` URI names (lowercased),
    /// or the one its path's extension names, or nil. Never guessed.
    static func typeOf(_ url: String) -> String? {
        let u = Array(url.utf16)
        // /^data:(image\/[a-z0-9.+-]+)/i
        if asciiHasPrefixIgnoringCase(u, "data:image/") {
            var end = 11
            while end < u.count && isMimeChar(u[end]) { end += 1 }
            if end > 11 { return string(u[5..<end]).lowercased() }
        }
        // url.split(/[?#]/)[0]
        let path = Array(u.prefix { $0 != 0x3F && $0 != 0x23 })
        for (suffix, mime) in [(".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png"),
                               (".webp", "image/webp"), (".gif", "image/gif"), (".svg", "image/svg+xml")]
            where asciiHasSuffixIgnoringCase(path, suffix) {
            return mime
        }
        return nil
    }

    // MARK: - Metadata

    /// A queue item as the mapping reads it. `nil` fields are what JavaScript's
    /// `typeof s === "string"` check rejects (absent, null, a number).
    public struct Item: Equatable {
        public let kind: String?
        public let title: String?
        public let show: String?

        public init(kind: String? = nil, title: String? = nil, show: String? = nil) {
            self.kind = kind
            self.title = title
            self.show = show
        }
    }

    /// The three strings and the artwork list.
    public struct Metadata: Equatable {
        public let title: String
        public let artist: String
        public let album: String
        public let artwork: [Artwork]
    }

    /// `narrationCredit({forayTitle, nextItem})`: the artist for a line WE
    /// wrote (narration, a jingle). The Foray's title, then the next item's
    /// episode title, then its show, then "". NEVER `appName` (L-06 / F15:
    /// "4a" on every narration line is what the founder saw in the car).
    /// Ported whole here; the lines that reach it play in M2 (NE-29s).
    public static func narrationCredit(forayTitle: String?, nextItem: Item?) -> String {
        clean(forayTitle).orIfEmpty(clean(nextItem?.title)).orIfEmpty(clean(nextItem?.show))
    }

    /// `mediaMetadata({item, nextItem, forayTitle, index, total, showArtworkUrl,
    /// appArtworkUrl})`. Pure and total; nothing is ever fabricated (a missing
    /// show is an empty artist). `index` / `total` are nil when they are not
    /// numbers at all; JavaScript's defaults (0, 0) apply only when absent,
    /// which is what the parameter defaults here are.
    public static func metadata(item: Item? = nil, nextItem: Item? = nil, forayTitle: String? = "",
                                index: Double? = 0, total: Double? = 0, showArtworkUrl: String? = nil,
                                appArtworkUrl: String? = MediaMapping.appArtworkUrl) -> Metadata {
        let foray = clean(forayTitle)
        let jingle = item?.kind == EngineConstants.ForayQueue.jingle
        let narration = item?.kind == EngineConstants.QueueState.tts || jingle

        let title: String
        let artist: String
        if jingle {
            title = foray.orIfEmpty(appName)
            artist = narrationCredit(forayTitle: foray, nextItem: nextItem)
        } else if narration {
            let upNext = clean(nextItem?.title)
            // "Up next: <episode>", verbatim from 04_VOICE_AUDIO_SPEC.md line 11;
            // never the narration's own slug id when nothing follows.
            title = upNext.isEmpty ? foray.orIfEmpty(appName) : "Up next: " + upNext
            artist = narrationCredit(forayTitle: foray, nextItem: nextItem)
        } else {
            title = clean(item?.title).orIfEmpty(foray).orIfEmpty(appName)
            artist = clean(item?.show)
        }
        return Metadata(title: title, artist: artist, album: albumOf(foray, index: index, total: total),
                        // A narration line is ours; a publisher's square does not belong on it.
                        artwork: artworkList(showArtworkUrl: narration ? nil : showArtworkUrl,
                                             appArtworkUrl: appArtworkUrl))
    }

    /// `albumOf(forayTitle, index, total)`: "The history of grilling · clip 12
    /// of 32", worded exactly as the mini bar words it. `forayTitle` is already
    /// clean. The counter needs a non-negative integer index and a positive
    /// integer total, and an index past the end reads as the last clip.
    static func albumOf(_ forayTitle: String, index: Double?, total: Double?) -> String {
        var counter = ""
        if let index, let total, isInteger(index), index >= 0, isInteger(total), total > 0 {
            counter = "clip " + jsString(Swift.min(index, total - 1) + 1) + " of " + jsString(total)
        }
        if !forayTitle.isEmpty && !counter.isEmpty { return forayTitle + " · " + counter }
        if !forayTitle.isEmpty { return forayTitle }
        // `n.charAt(0).toUpperCase() + n.slice(1)`: the counter alone is a sentence.
        if !counter.isEmpty { return "C" + counter.dropFirst() }
        return ""
    }

    // MARK: - Position and playback state

    /// A `MediaPositionState`, in the clock the caller reports (the episode's
    /// for an episode, the whole Foray's for a Foray: media-session.js §3).
    public struct PositionState: Equatable {
        public let duration: Double
        public let position: Double
        public let playbackRate: Double
    }

    /// `mediaPositionState({durationSec, positionSec, playbackRate, buffering})`:
    /// nil when there is no finite positive duration ("do not report");
    /// otherwise the position clamped into `[0, duration]` and a rate that is a
    /// finite positive number or 1. A nil argument is "not a number", which
    /// every JavaScript branch treats as its default.
    ///
    /// A STALL STOPS THE CLOCK (audit round 2, p-car-8): while `buffering` the
    /// rate is 0, which is what Apple's `MPNowPlayingInfoPropertyPlaybackRate`
    /// means by "halted for data". Reporting the listener's rate over silence
    /// is what made the lock screen and the car count on and snap back.
    public static func positionState(durationSec: Double?, positionSec: Double? = 0,
                                     playbackRate: Double? = 1, buffering: Bool = false) -> PositionState? {
        guard let duration = finite(durationSec), duration > 0 else { return nil }
        let raw = finite(positionSec) ?? 0
        // Math.min(Math.max(0, raw), duration). Written out, not Swift.max:
        // `Swift.max(0, -0.0)` answers -0.0, where Math.max(0, -0) is +0, and a
        // -0 position is a different fixture value.
        let low = raw > 0 ? raw : 0
        let position = low < duration ? low : duration
        let rate: Double = {
            guard let r = finite(playbackRate), r > 0 else { return 1 }
            return r
        }()
        return PositionState(duration: duration, position: position, playbackRate: buffering ? 0 : rate)
    }

    /// `mediaPlaybackState({hasItem, playing, inSeamGap, ended, foray})`. A
    /// finished FORAY is `none` even while "playing" (a play button that can
    /// do nothing is worse than none); a finished ordinary EPISODE is `paused`
    /// (audit round 2, p-car-6: play from ended starts it over, and `none` at
    /// the end of the last episode took the whole transport off the car). The
    /// authored seam beat reads as playing (media-session.js §4).
    public static func playbackState(hasItem: Bool = false, playing: Bool = false,
                                     inSeamGap: Bool = false, ended: Bool = false,
                                     foray: Bool = false) -> String {
        if !hasItem { return none }
        if ended { return foray ? none : paused }
        if playing || inSeamGap { return MediaMapping.playing }
        return paused
    }

    // MARK: - The whole view

    /// `mediaSessionView(view)`'s input: every live value, gathered by the
    /// caller, decided here.
    public struct View: Equatable {
        public var item: Item?
        public var nextItem: Item?
        public var forayTitle: String?
        public var index: Double?
        public var total: Double?
        public var showArtworkUrl: String?
        public var appArtworkUrl: String?
        public var durationSec: Double?
        public var positionSec: Double?
        public var playbackRate: Double?
        /// The element is halted for data: the clock reports rate 0 (p-car-8).
        public var buffering: Bool
        public var playing: Bool
        public var inSeamGap: Bool
        public var ended: Bool
        /// The item is a Foray, whose end reports `none` (an episode's, `paused`).
        public var foray: Bool

        public init(item: Item? = nil, nextItem: Item? = nil, forayTitle: String? = "", index: Double? = 0,
                    total: Double? = 0, showArtworkUrl: String? = nil,
                    appArtworkUrl: String? = MediaMapping.appArtworkUrl, durationSec: Double? = nil,
                    positionSec: Double? = 0, playbackRate: Double? = 1, buffering: Bool = false,
                    playing: Bool = false, inSeamGap: Bool = false, ended: Bool = false, foray: Bool = false) {
            self.item = item
            self.nextItem = nextItem
            self.forayTitle = forayTitle
            self.index = index
            self.total = total
            self.showArtworkUrl = showArtworkUrl
            self.appArtworkUrl = appArtworkUrl
            self.durationSec = durationSec
            self.positionSec = positionSec
            self.playbackRate = playbackRate
            self.buffering = buffering
            self.playing = playing
            self.inSeamGap = inSeamGap
            self.ended = ended
            self.foray = foray
        }
    }

    public struct SessionView: Equatable {
        public let metadata: Metadata
        public let positionState: PositionState?
        public let playbackState: String
    }

    /// `mediaSessionView(view)`.
    public static func sessionView(_ view: View) -> SessionView {
        SessionView(
            metadata: metadata(item: view.item, nextItem: view.nextItem, forayTitle: view.forayTitle,
                               index: view.index, total: view.total, showArtworkUrl: view.showArtworkUrl,
                               appArtworkUrl: view.appArtworkUrl),
            positionState: positionState(durationSec: view.durationSec, positionSec: view.positionSec,
                                         playbackRate: view.playbackRate, buffering: view.buffering),
            playbackState: playbackState(hasItem: view.item != nil, playing: view.playing,
                                         inSeamGap: view.inSeamGap, ended: view.ended, foray: view.foray))
    }

    // MARK: - Remote commands: which exist, and what a press means

    /// Which intents the listener can reach right now: `mediaSessionActions`'s
    /// `surface`, as flags. An absent intent is a button that is NOT offered
    /// (greyed out), never one that silently does nothing.
    public struct Surface: Equatable {
        public var play: Bool
        public var pause: Bool
        public var stop: Bool
        public var next: Bool
        public var previous: Bool
        public var seekBy: Bool
        public var seekTo: Bool

        public init(play: Bool = false, pause: Bool = false, stop: Bool = false, next: Bool = false,
                    previous: Bool = false, seekBy: Bool = false, seekTo: Bool = false) {
            self.play = play
            self.pause = pause
            self.stop = stop
            self.next = next
            self.previous = previous
            self.seekBy = seekBy
            self.seekTo = seekTo
        }
    }

    /// The step a skip press takes: the founder's pair unless a surface says
    /// otherwise (`opts`). The PLATFORM's offset is never an input.
    public struct SeekSteps: Equatable {
        public var backwardSec: Double
        public var forwardSec: Double

        public init(backwardSec: Double = MediaMapping.seekBackwardSec,
                    forwardSec: Double = MediaMapping.seekForwardSec) {
            self.backwardSec = backwardSec
            self.forwardSec = forwardSec
        }
    }

    /// What a press carries that the mapping reads: `details.seekTime` (nil
    /// when it is not a number) and whether `details.close === true`.
    /// `seekOffset` is deliberately NOT a field: the head unit's step is data
    /// about the press, never an order (media-session.js, founder 2026-09-23).
    public struct PressDetails: Equatable {
        public var seekTime: Double?
        public var close: Bool

        public init(seekTime: Double? = nil, close: Bool = false) {
            self.seekTime = seekTime
            self.close = close
        }
    }

    /// What a press turns into: one call on the surface.
    public enum Intent: Equatable {
        case play
        case pause
        /// `close` is the Android notification's Stop, the one stop that may
        /// tear the player down; every other stop carries none.
        case stop(close: Bool)
        case previous
        case next
        case seekBy(Double)
        case seekTo(Double)
    }

    /// `mediaSessionActions(surface)`'s action list, in `MEDIA_ACTIONS` order:
    /// an action is installed exactly when its surface intent exists.
    public static func installedActions(_ surface: Surface) -> [MediaAction] {
        var out: [MediaAction] = []
        if surface.play { out.append(.play) }
        if surface.pause { out.append(.pause) }
        if surface.stop { out.append(.stop) }
        if surface.previous { out.append(.previousTrack) }
        if surface.next { out.append(.nextTrack) }
        if surface.seekBy {
            out.append(.seekBackward)
            out.append(.seekForward)
        }
        if surface.seekTo { out.append(.seekTo) }
        return out
    }

    /// The handler `mediaSessionActions` installs for `action`, pressed with
    /// `details`: the intent it issues, or nil when the press is ignored (a
    /// `seekto` with no usable time is not a seek to zero). Only ever asked
    /// for an INSTALLED action: the OS never delivers a press for a command
    /// nobody enabled.
    public static func intent(for action: MediaAction, details: PressDetails = PressDetails(),
                              steps: SeekSteps = SeekSteps()) -> Intent? {
        switch action {
        case .play: return .play
        case .pause: return .pause
        case .stop: return .stop(close: details.close)
        case .previousTrack: return .previous
        case .nextTrack: return .next
        case .seekBackward: return .seekBy(-steps.backwardSec)
        case .seekForward: return .seekBy(steps.forwardSec)
        case .seekTo:
            // `!isNum(t) || t < 0` ignores it; -0 is not < 0, so it seeks to 0.
            guard let t = finite(details.seekTime), !(t < 0) else { return nil }
            return .seekTo(t)
        }
    }

    // MARK: - Command enablement from the engine's snapshot (NP-5)

    /// The Snapshot v1 fields (plan §5.3) that decide which remote commands
    /// work. Read by name from the contract; NE-14s's snapshot hands its own
    /// values here, so there is one enablement rule and not one per caller.
    public struct CommandSnapshot: Equatable {
        /// Snapshot v1 `mode`. `"none"` (nothing loaded) is spelled
        /// `unloaded` here so it can never be read as `Optional.none`.
        public enum Mode: String, Equatable { case unloaded = "none", episode, foray }

        public var mode: Mode
        public var ended: Bool
        public var canNext: Bool
        public var canPrevious: Bool
        /// Carried because the snapshot carries it, and read by NOTHING below
        /// on purpose: `canNext` is the chain being non-empty REGARDLESS of
        /// autoAdvance (plan §5.5, `EPISODE_NAVIGATION.next` today). Turning
        /// continuous playback off stops the engine walking the chain at an
        /// episode's end; it does not grey out the steering wheel's skip.
        public var autoAdvance: Bool

        public init(mode: Mode, ended: Bool = false, canNext: Bool = false, canPrevious: Bool = false,
                    autoAdvance: Bool = false) {
            self.mode = mode
            self.ended = ended
            self.canNext = canNext
            self.canPrevious = canPrevious
            self.autoAdvance = autoAdvance
        }
    }

    /// The `MPRemoteCommandCenter` commands the engine registers (plan §4.5).
    public enum RemoteCommand: String, CaseIterable, Equatable {
        case play, pause, togglePlayPause, nextTrack, previousTrack
        case skipBackward, skipForward, changePlaybackPosition, stop
    }

    /// Which commands are enabled, the skip intervals to advertise, and
    /// whether Now Playing is cleared.
    public struct CommandAvailability: Equatable {
        public let enabled: Set<RemoteCommand>
        public let skipBackwardIntervalSec: Double
        public let skipForwardIntervalSec: Double
        /// True only for a finished Foray, a close or a data deletion (the
        /// snapshot's `mode: "none"`): the one case where `nowPlayingInfo`
        /// becomes nil. A pause, an interruption, an ended EPISODE keep it.
        public let clearsNowPlaying: Bool

        public func isEnabled(_ command: RemoteCommand) -> Bool { enabled.contains(command) }
    }

    /// `commandAvailability(snapshot)`: NP-5.
    ///
    /// - The episode surface is the page's `episodeMediaSurface`: play, pause,
    ///   the seek pair and a scrub always; next / previous exactly when the
    ///   engine has a neighbour (`canNext` / `canPrevious`). It goes through
    ///   `installedActions`, the SAME table the `media-episode` fixtures pin,
    ///   so a button the page would not offer is a button the engine does not
    ///   enable.
    /// - `stop` is registered and ALWAYS disabled (plan §4.5, T-7): a remote
    ///   stop is a pause, and a car's stop must never tear the player down.
    ///   It is left out of the surface, so the table cannot install it.
    /// - `togglePlayPause` exists natively (a one-button headset) and not on
    ///   the web; it works exactly when play and pause both do.
    /// - Skip intervals are the founder's pair, from `EngineConstants`.
    /// - Everything is disabled and Now Playing cleared ONLY when nothing is
    ///   loaded (close, data deletion) or a Foray has finished. A paused or
    ///   interrupted player keeps every target (NP-9), and so does an ended
    ///   episode, whose play button resumes it as the page's does.
    public static func commandAvailability(_ snapshot: CommandSnapshot,
                                           steps: SeekSteps = SeekSteps()) -> CommandAvailability {
        let finished = snapshot.mode == .unloaded || (snapshot.mode == .foray && snapshot.ended)
        guard !finished else {
            return CommandAvailability(enabled: [], skipBackwardIntervalSec: steps.backwardSec,
                                       skipForwardIntervalSec: steps.forwardSec, clearsNowPlaying: true)
        }
        let surface = Surface(play: true, pause: true, stop: false, next: snapshot.canNext,
                              previous: snapshot.canPrevious, seekBy: true, seekTo: true)
        let installed = Set(installedActions(surface))
        var enabled: Set<RemoteCommand> = []
        if installed.contains(.play) { enabled.insert(.play) }
        if installed.contains(.pause) { enabled.insert(.pause) }
        if installed.contains(.play) && installed.contains(.pause) { enabled.insert(.togglePlayPause) }
        if installed.contains(.nextTrack) { enabled.insert(.nextTrack) }
        if installed.contains(.previousTrack) { enabled.insert(.previousTrack) }
        if installed.contains(.seekBackward) { enabled.insert(.skipBackward) }
        if installed.contains(.seekForward) { enabled.insert(.skipForward) }
        if installed.contains(.seekTo) { enabled.insert(.changePlaybackPosition) }
        return CommandAvailability(enabled: enabled, skipBackwardIntervalSec: steps.backwardSec,
                                   skipForwardIntervalSec: steps.forwardSec, clearsNowPlaying: false)
    }

    // MARK: - JavaScript string and number semantics

    /// `typeof s === "string" && s.trim().length > 0 ? s.trim() : nil`.
    static func nonEmptyTrimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = jsTrim(value)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// media-session.js `clean(s)`: trimmed, or "".
    static func clean(_ value: String?) -> String { nonEmptyTrimmed(value) ?? "" }

    /// `String.prototype.trim`: strips ECMAScript WhiteSpace and
    /// LineTerminator code units from both ends, and nothing else.
    static func jsTrim(_ value: String) -> String {
        let u = Array(value.utf16)
        var start = 0
        var end = u.count
        while start < end && isJSWhitespace(u[start]) { start += 1 }
        while end > start && isJSWhitespace(u[end - 1]) { end -= 1 }
        return string(u[start..<end])
    }

    static func isJSWhitespace(_ c: UInt16) -> Bool {
        switch c {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// `/^([a-zA-Z][a-zA-Z0-9+.-]*):/`'s capture, or nil.
    static func schemeOf(_ u: [UInt16]) -> [UInt16]? {
        guard let first = u.first, isAsciiLetter(first) else { return nil }
        var i = 1
        while i < u.count && (isAsciiLetter(u[i]) || isDigit(u[i]) || u[i] == 0x2B || u[i] == 0x2E || u[i] == 0x2D) {
            i += 1
        }
        return i < u.count && u[i] == 0x3A /* : */ ? Array(u[0..<i]) : nil
    }

    static func isDigit(_ c: UInt16) -> Bool { (0x30...0x39).contains(c) }
    static func isAsciiLetter(_ c: UInt16) -> Bool { (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) }
    /// `[a-z0-9.+-]` under the `i` flag. A non-ASCII unit never matches an
    /// ASCII class member there (ECMA-262 Canonicalize), so ASCII-only is exact.
    static func isMimeChar(_ c: UInt16) -> Bool {
        isAsciiLetter(c) || isDigit(c) || c == 0x2E || c == 0x2B || c == 0x2D
    }

    static func asciiLower(_ c: UInt16) -> UInt16 { (0x41...0x5A).contains(c) ? c + 0x20 : c }

    static func asciiEqualsIgnoringCase(_ u: [UInt16], _ ascii: String) -> Bool {
        let w = Array(ascii.utf16)
        return u.count == w.count && zip(u, w).allSatisfy { asciiLower($0) == asciiLower($1) }
    }

    static func asciiHasPrefixIgnoringCase(_ u: [UInt16], _ ascii: String) -> Bool {
        let w = Array(ascii.utf16)
        return u.count >= w.count && asciiEqualsIgnoringCase(Array(u[0..<w.count]), ascii)
    }

    static func asciiHasSuffixIgnoringCase(_ u: [UInt16], _ ascii: String) -> Bool {
        let w = Array(ascii.utf16)
        return u.count >= w.count && asciiEqualsIgnoringCase(Array(u[(u.count - w.count)...]), ascii)
    }

    static func string<S: Sequence>(_ units: S) -> String where S.Element == UInt16 {
        String(decoding: Array(units), as: UTF16.self)
    }

    /// `Number.isFinite`: the value, or nil.
    static func finite(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }

    /// `Number.isInteger`.
    static func isInteger(_ value: Double) -> Bool {
        value.isFinite && value.rounded(.towardZero) == value
    }

    /// JavaScript's `String(number)` (ECMA-262 Number::toString), for the clip
    /// counter's template literal. Swift's `"\(2.0)"` is "2.0" and its `1e+16`
    /// is JavaScript's `10000000000000000`; both runtimes choose the SHORTEST
    /// round-trip digits, so only the layout differs, and this rebuilds it. The
    /// same algorithm as ForayEngineParity's `JSNumber` (which the core cannot
    /// import); NE-10s's `number-format` family is where the general rule is
    /// pinned.
    static func jsString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        let sign = value < 0 ? "-" : ""
        let parts = "\(Swift.abs(value))".split(separator: "e", maxSplits: 1).map(String.init)
        let exponent = parts.count == 2 ? Int(parts[1]) ?? 0 : 0
        let mantissa = parts[0].split(separator: ".", maxSplits: 1).map(String.init)
        var digits = Array(mantissa[0] + (mantissa.count == 2 ? mantissa[1] : ""))
        var point = mantissa[0].count + exponent
        while digits.count > 1 && digits.first == "0" {
            digits.removeFirst()
            point -= 1
        }
        while digits.count > 1 && digits.last == "0" { digits.removeLast() }
        let k = digits.count
        let n = point
        let d = String(digits)
        if k <= n && n <= 21 { return sign + d + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return sign + String(digits[0..<n]) + "." + String(digits[n...]) }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + d }
        let e = n - 1
        let expText = (e < 0 ? "-" : "+") + String(Swift.abs(e))
        if k == 1 { return sign + d + "e" + expText }
        return sign + String(digits[0]) + "." + String(digits[1...]) + "e" + expText
    }
}

/// An OS remote action, spelled as `MEDIA_ACTIONS` spells it and declared in
/// that order: `allCases` IS the install order (MediaMappingTests pins it
/// against the generated constant, and the `media-actions-vocabulary` case
/// reads it from here, not from the constant).
public enum MediaAction: String, CaseIterable, Equatable {
    case play
    case pause
    case stop
    case previousTrack = "previoustrack"
    case nextTrack = "nexttrack"
    case seekBackward = "seekbackward"
    case seekForward = "seekforward"
    case seekTo = "seekto"
}

fileprivate extension String {
    /// JavaScript's `a || b` for two strings: `b` when `a` is empty.
    func orIfEmpty(_ other: String) -> String { isEmpty ? other : self }
}
