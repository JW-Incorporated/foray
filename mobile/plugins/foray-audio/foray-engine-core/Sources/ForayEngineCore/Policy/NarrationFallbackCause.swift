import Foundation

// ── WHY A RENDERED LINE FELL BACK TO THE PHONE'S VOICE (NE-39n) ─────────────
//
// A `narration kind=fallback` row says a rendered narration FILE failed and the
// script was spoken instead. `reason=` only says whether the load ran out of
// time or failed; `cause=` says why, as one of the closed
// `narrationFallbackCause` tokens (player/engine-vocabulary.js
// NARRATION_FALLBACK_CAUSES, the JS vocabulary first):
//
//   timeout   the load passed its deadline (P-13), or the URL loader timed out
//   http-4xx  the server answered 4xx (a missing or refused file)
//   http-5xx  the server answered 5xx
//   offline   no network (airplane mode, no signal, cellular data refused)
//   decode    the bytes arrived and are not playable audio
//   other     none of the above
//
// The reading is made from what AVDeck's `failed` and `deadline` rows already
// carry, never from free text: the error's domain and code and its underlying
// one (`errDomain`/`errCode`, `underDomain`/`underCode`) and the item's last
// error-log event (`logStatus`, `logDomain`). It is pure, so the core's tests
// can map every cause from a synthetic failure; AVDeck hands it plain values
// (AVDeck.fallbackCause).
//
// PRECEDENCE, when more than one applies: a server's status first (it
// answered, so the network was up), then offline, then timeout, then decode.
// A deadline is `timeout` unless the error log says the server answered or
// the network was gone by then.
//
// The code tables are the documented URL-loading and AVFoundation codes; the
// CoreMedia HTTP codes are the ones seen in the field's pastes. Anything else
// is `other`, and the deck row it came from is still in the paste to extend
// the table from. // MEASURE: the first drives with rendered narration say
// which `other`s are common (NE-40's rendered-Foray block).
public enum NarrationFallbackCauseReading {

    /// One error as the deck's rows print it: its domain and code.
    public struct Code: Equatable, Sendable {
        public let domain: String
        public let code: Int

        public init(domain: String, code: Int) {
            self.domain = domain
            self.code = code
        }
    }

    /// `NSURLErrorDomain`, and CFNetwork's spelling of the same codes.
    static let urlDomains: Set<String> = ["NSURLErrorDomain", "kCFErrorDomainCFNetwork"]
    /// CoreMedia's HTTP codes arrive under either domain.
    static let coreMediaDomains: Set<String> = ["CoreMediaErrorDomain", "NSOSStatusErrorDomain"]
    static let avFoundationDomain = "AVFoundationErrorDomain"

    /// No network: `notConnectedToInternet` (-1009), `dataNotAllowed`
    /// (-1020), `internationalRoamingOff` (-1018), `networkConnectionLost`
    /// (-1005, the radio going away mid-transfer, which is airplane mode
    /// during a line). `cannotFindHost` and `cannotConnectToHost` are NOT
    /// here: they are as often the host as the network, and stay `other`.
    static let offlineURLCodes: Set<Int> = [-1009, -1020, -1018, -1005]
    /// `timedOut` (-1001).
    static let timeoutURLCodes: Set<Int> = [-1001]
    /// `cannotDecodeRawData` (-1015), `cannotDecodeContentData` (-1016).
    static let decodeURLCodes: Set<Int> = [-1015, -1016]
    /// `decodeFailed` (-11821), `fileFormatNotRecognized` (-11828),
    /// `fileFailedToParse` (-11829), `decoderNotFound` (-11833).
    static let decodeAVCodes: Set<Int> = [-11821, -11828, -11829, -11833]
    /// CoreMedia's "HTTP 404: File Not Found" (-12938) and "HTTP 403:
    /// Forbidden" (-12660), for a failure whose error log is empty.
    static let http4xxCoreMediaCodes: Set<Int> = [-12938, -12660]

    /// The cause of a rendered line's fallback.
    ///
    /// - `errors`: the failure's error and its underlying one, outermost
    ///   first (empty for a deadline, which has no error).
    /// - `logStatus` / `logDomain`: the item's last error-log event, if any.
    ///   Its status is the HTTP status for an HTTP failure and the URL error's
    ///   code for a URL-loading one (then `logDomain` is the URL domain).
    /// - `deadline`: the deck's P-13 deadline fired (the `deadline` row).
    public static func cause(errors: [Code], logStatus: Int?, logDomain: String?,
                             deadline: Bool) -> Vocabulary.NarrationFallbackCause {
        var codes = errors
        var httpStatus: Int?
        if let logStatus {
            if let logDomain, urlDomains.contains(logDomain) {
                codes.append(Code(domain: logDomain, code: logStatus))
            } else if (100...599).contains(logStatus) {
                httpStatus = logStatus
            } else if let logDomain {
                codes.append(Code(domain: logDomain, code: logStatus))
            }
        }
        if let httpStatus {
            if (400...499).contains(httpStatus) { return .http4xx }
            if (500...599).contains(httpStatus) { return .http5xx }
        }
        if codes.contains(where: { coreMediaDomains.contains($0.domain) && http4xxCoreMediaCodes.contains($0.code) }) {
            return .http4xx
        }
        if codes.contains(where: { urlDomains.contains($0.domain) && offlineURLCodes.contains($0.code) }) {
            return .offline
        }
        if deadline || codes.contains(where: { urlDomains.contains($0.domain) && timeoutURLCodes.contains($0.code) }) {
            return .timeout
        }
        if codes.contains(where: {
            (urlDomains.contains($0.domain) && decodeURLCodes.contains($0.code))
                || ($0.domain == avFoundationDomain && decodeAVCodes.contains($0.code))
        }) {
            return .decode
        }
        return .other
    }
}
