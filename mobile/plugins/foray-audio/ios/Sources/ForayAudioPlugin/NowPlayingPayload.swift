import Foundation

/// Everything the lock screen / Control Center should say, as one immutable
/// value -- the iOS mirror of `NowPlaying.java`.
///
/// **This type holds no opinions.** Every field arrives from
/// `mobile/plugins/foray-audio/web/foray-media-session.js`'s
/// `nowPlayingPayload()`, which gets it from `player/media-session.js` -- the
/// module that decides what the three strings say, that previous/next are
/// segments, and which clock the position is on. Nothing here re-decides any
/// of that: iOS, Android and mobile Chrome must not disagree about what a
/// Foray is.
///
/// So the only judgement in this file is defensive: what to do with a payload
/// missing a field, or carrying a value the web half should never send. The
/// answer is always the honest empty/default value, never a guess and never a
/// crash -- `from(_:)` is TOTAL over `[String: Any]`, same as `NowPlaying.from`
/// is total over a nullable `JSObject` on Android.
struct NowPlayingPayload: Equatable {
    enum State: String {
        case playing, paused, ended
        /// Anything the web half did not send, or an unrecognised string.
        /// Mirrors Android's `NowPlaying.IDLE` -- the state that shows
        /// nothing, which is the right answer to a word we do not
        /// understand.
        case none
    }

    let state: State
    let title: String
    let artist: String
    let album: String
    /// A URI this process can load, or `""`. `foray-media-session.js`'s
    /// `artworkUrl()` has already refused everything except `https:`,
    /// `data:` and same-origin bundle URLs before this ever arrives.
    let artworkUri: String
    /// The whole FORAY's duration in ms, not the segment's --
    /// `media-session.js` §3's decision, unexamined here.
    let durationMs: Int64
    let positionMs: Int64
    let playbackRate: Double

    let canPlay: Bool
    let canPause: Bool
    let canStop: Bool
    let hasNext: Bool
    let hasPrevious: Bool
    let canSeekBack: Bool
    let canSeekForward: Bool
    let canSeekTo: Bool

    static let empty = NowPlayingPayload(
        state: .none, title: "", artist: "", album: "", artworkUri: "",
        durationMs: 0, positionMs: 0, playbackRate: 1,
        canPlay: false, canPause: false, canStop: false,
        hasNext: false, hasPrevious: false,
        canSeekBack: false, canSeekForward: false, canSeekTo: false
    )

    /// The longest duration/position this will believe: 24 hours in ms.
    /// A Foray is 45-90 minutes, so anything past a day is a caller bug
    /// rather than a long Foray -- same clamp and same reasoning as
    /// `NowPlaying.java`'s `MAX_MS` / `clampMs`.
    private static let maxMs: Int64 = 24 * 60 * 60 * 1000

    /// Parse one `setNowPlaying` payload. TOTAL: every branch has a defined
    /// answer for a missing key or a wrong type.
    static func from(_ data: [String: Any]) -> NowPlayingPayload {
        let stateName = data["state"] as? String ?? ""
        guard let state = State(rawValue: stateName) else {
            // An unrecognised or absent state carries nothing else --
            // mirrors `NowPlaying.from`'s early return on `IDLE`: a title
            // alongside "nothing is playing" could only ever be a
            // contradiction for something to read.
            return .empty
        }

        return NowPlayingPayload(
            state: state,
            title: string(data, "title"),
            artist: string(data, "artist"),
            album: string(data, "album"),
            artworkUri: string(data, "artworkUri"),
            durationMs: clampMs(longValue(data, "durationMs")),
            positionMs: clampMs(longValue(data, "positionMs")),
            playbackRate: rateValue(data),
            canPlay: boolValue(data, "canPlay"),
            canPause: boolValue(data, "canPause"),
            canStop: boolValue(data, "canStop"),
            hasNext: boolValue(data, "hasNext"),
            hasPrevious: boolValue(data, "hasPrevious"),
            canSeekBack: boolValue(data, "canSeekBack"),
            canSeekForward: boolValue(data, "canSeekForward"),
            canSeekTo: boolValue(data, "canSeekTo")
        )
    }

    private static func string(_ data: [String: Any], _ key: String) -> String {
        (data[key] as? String) ?? ""
    }

    private static func boolValue(_ data: [String: Any], _ key: String) -> Bool {
        (data[key] as? Bool) ?? false
    }

    /// A number off the payload, coerced from whatever JSON decoding
    /// produced. `NSNumber` covers Int, Double and everything JSON parsing
    /// hands back, which is the Swift analogue of `NowPlaying.java`'s own
    /// `number()` trap comment about `org.json` producing types
    /// `getLong`/`getDouble` miss.
    private static func numberValue(_ data: [String: Any], _ key: String) -> Double {
        (data[key] as? NSNumber)?.doubleValue ?? 0
    }

    /// Converts a payload number to `Int64`, TOTAL over every `Double`
    /// `numberValue` can hand back -- including NaN, infinity, and anything
    /// outside `Int64`'s range. `Int64(aHugeDouble)` traps at runtime, so the
    /// clamp to `Int64`'s representable range has to happen here, before the
    /// conversion, not after it in `clampMs` (which only clamps to the much
    /// smaller `maxMs`, but assumes the `Int64` it receives already exists).
    private static func longValue(_ data: [String: Any], _ key: String) -> Int64 {
        let value = numberValue(data, key)
        guard value.isFinite else { return 0 }
        if value <= Double(Int64.min) { return Int64.min }
        if value >= Double(Int64.max) { return Int64.max }
        return Int64(value)
    }

    private static func rateValue(_ data: [String: Any]) -> Double {
        let rate = (data["playbackRate"] as? NSNumber)?.doubleValue ?? 1
        // We never play backwards, and a zero/negative/non-finite rate is the
        // same nonsense on iOS it is on Android's `rateOf` -- 1x is the only
        // sane substitute.
        guard rate > 0, rate.isFinite else { return 1 }
        return rate
    }

    private static func clampMs(_ ms: Int64) -> Int64 {
        if ms < 0 { return 0 }
        return min(ms, maxMs)
    }
}
