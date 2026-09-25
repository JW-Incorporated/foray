// GENERATED FILE - DO NOT EDIT.
// The engine's closed vocabularies, from player/engine-vocabulary.js (NE-04).
// Regenerate with `node tools/parity/gen-constants.mjs --write`; tools/parity/gen-constants.test.mjs
// (in npm test) is red while this file disagrees with the JS it comes from.
//
// A diagnostics row admits a token only through these sets; the reasons for
// each set, and for keeping them closed, are in the JS module. The data only:
// admission itself is ported by hand and pinned by the diag-tokens family.

import Foundation

public enum Vocabulary {
    /// `stage`
    public enum Stage: String, CaseIterable, Sendable {
        case attach = "attach"
        case duration = "duration"
        case gate = "gate"
        case readiness = "readiness"
        case seek = "seek"
        case preroll = "preroll"
        case ready = "ready"
        case play = "play"
        case playing = "playing"
        case skip = "skip"
        case notReady = "not-ready"
        case retry = "retry"
        case ordinaryLoad = "ordinary-load"
        case deadline = "deadline"
    }

    /// `sessionError`
    public enum SessionError: String, CaseIterable, Sendable {
        case cannotInterruptOthers = "cannot-interrupt-others"
        case cannotStartPlaying = "cannot-start-playing"
        case other = "other"
    }

    /// `interruptionReason`
    public enum InterruptionReason: String, CaseIterable, Sendable {
        case `default` = "default"
        case appWasSuspended = "appWasSuspended"
        case builtInMicMuted = "builtInMicMuted"
        case unknown = "unknown"
    }

    /// `stopCause`
    public enum StopCause: String, CaseIterable, Sendable {
        case pause = "pause"
        case ended = "ended"
        case finalEnd = "final-end"
        case systemPause = "system-pause"
        case routeChange = "route-change"
        case interruption = "interruption"
        case graceExpired = "grace-expired"
        case seamTimeout = "seam-timeout"
        case loadDeadline = "load-deadline"
        case error = "error"
        case relinquish = "relinquish"
        case dataDeletion = "data-deletion"
        case close = "close"
        case mediaServicesReset = "media-services-reset"
        case unknown = "unknown"
    }

    /// `source`
    public enum Source: String, CaseIterable, Sendable {
        case tap = "tap"
        case remote = "remote"
        case reconcile = "reconcile"
        case session = "session"
        case restore = "restore"
        case autoadvance = "autoadvance"
        case autoresume = "autoresume"
        case audition = "audition"
    }

    /// `modeReason`
    public enum ModeReason: String, CaseIterable, Sendable {
        case buildDefault = "build-default"
        case `override` = "override"
        case noPlistKey = "no-plist-key"
        case notBuilt = "not-built"
        case crashLoop = "crash-loop"
        case pageHealth = "page-health"
        case downgrade = "downgrade"
    }

    /// `faultKind`
    public enum FaultKind: String, CaseIterable, Sendable {
        case implicitActivation = "implicit-activation"
        case externallyOwned = "externally-owned"
    }

    /// Every set's name, in the JS declaration order.
    public static let setNames: [String] = ["stage", "sessionError", "interruptionReason", "stopCause", "source", "modeReason", "faultKind"]

    /// Every set's tokens, by set name, in the JS declaration order.
    public static let sets: [String: [String]] = [
        "stage": Stage.allCases.map(\.rawValue),
        "sessionError": SessionError.allCases.map(\.rawValue),
        "interruptionReason": InterruptionReason.allCases.map(\.rawValue),
        "stopCause": StopCause.allCases.map(\.rawValue),
        "source": Source.allCases.map(\.rawValue),
        "modeReason": ModeReason.allCases.map(\.rawValue),
        "faultKind": FaultKind.allCases.map(\.rawValue),
    ]
}
