import Foundation

/// Which lane a process plays through: the Swift port of `decideEngineMode`
/// and `engineModeTrace` in `player/engine-contract.js`
/// (docs/native-engine-plan.md §4.6, card NE-11s). JS is the reference; the
/// `engine-mode` parity family is the contract.
///
/// PURE, ON PURPOSE. `EngineOwnership.decideOnce()` (NE-17) is the lazy static
/// that reads Info.plist and the engine-private `UserDefaults` keys, calls
/// `decide` ONCE per process, and writes the answer back. Everything that can
/// be wrong about the decision (a strike counted per launch instead of per
/// crash, a sticky pin that outlives the build it was for, an override that
/// beats the crash-loop guard) lives here, where the fixtures can see it; the
/// wrapper only moves values in and out.
///
/// WHAT IS SAFE TO GET WRONG AND WHAT IS NOT. The founder's daily listening
/// rides on this (OQ-9): a native engine that crashes at boot must fall back
/// to today's player within three launches and STAY there until a new build
/// ships, and a background launch that went healthy must never count as a
/// crash (R18). Both are fixture cases.
public enum EngineMode {
    /// `ENGINE_MODES`: engineHello's `mode`. `legacy` is the lane iOS plays
    /// through today (the JS player plus this plugin's Now Playing half), so
    /// it is not spelled `js`.
    public enum Mode: String, CaseIterable, Sendable {
        case native
        case legacy
    }

    /// `MODE_OVERRIDES`: the Developer setting 'Playback engine: Automatic /
    /// Native / Web' (NE-17), as stored.
    public enum Override: String, CaseIterable, Sendable {
        case auto
        case native
        case web

        /// How a STORED override is read: anything outside the closed set
        /// (a missing key, a value an older build wrote) is `auto`, as the JS
        /// reads `MODE_OVERRIDES.includes(v) ? v : "auto"`.
        public static func stored(_ raw: String?) -> Override {
            raw.flatMap(Override.init(rawValue:)) ?? .auto
        }
    }

    /// Info.plist `ForayEngineDefault`, when it holds one of these. Absent or
    /// anything else is nil, which `decide` reads as `no-plist-key`: a build
    /// that forgot the key runs today's player.
    public enum BuildDefault: String, CaseIterable, Sendable {
        case native
        case js
    }

    /// `STRIKE_LIMIT`: at this many strikes the process runs legacy, sticky
    /// until CFBundleVersion changes.
    public static let strikeLimit = Int(EngineConstants.EngineContract.strikeLimit)

    /// `decideEngineMode`'s input.
    public struct Inputs: Equatable, Sendable {
        public let buildDefault: BuildDefault?
        /// The Developer setting (UserDefaults `ForayEngine.modeOverride`).
        public let modeOverride: Override
        /// The PREVIOUS launch's sentinel is still set: its native boot never
        /// reached a healthy marker.
        public let sentinelWasSet: Bool
        /// The stored strike count. A negative count reads as 0.
        public let strikes: Int
        /// The CFBundleVersion a crash loop pinned to legacy. Empty reads as none.
        public let stickyLegacyBuild: String?
        /// This launch's CFBundleVersion.
        public let currentBuild: String
        /// Whether this binary has an engine at all.
        public let built: Bool

        public init(buildDefault: BuildDefault?, modeOverride: Override, sentinelWasSet: Bool, strikes: Int,
                    stickyLegacyBuild: String?, currentBuild: String, built: Bool) {
            self.buildDefault = buildDefault
            self.modeOverride = modeOverride
            self.sentinelWasSet = sentinelWasSet
            self.strikes = strikes
            self.stickyLegacyBuild = stickyLegacyBuild
            self.currentBuild = currentBuild
            self.built = built
        }
    }

    /// The lane, its mode-reason token, and what to store back.
    public struct Decision: Equatable, Sendable {
        public let mode: Mode
        public let reason: Vocabulary.ModeReason
        public let strikes: Int
        public let stickyLegacyBuild: String?
        /// True exactly when the engine boots natively: the sentinel guards a
        /// native boot, and a legacy process has nothing to guard.
        public let writeSentinel: Bool
    }

    /// `decideEngineMode(i)`. The ORDER is the rule (engine-contract.js says
    /// why each step sits where it does):
    ///   1. not built -> legacy/not-built. Nothing else can matter.
    ///   2. a strike is added ONLY IF the previous sentinel is still set.
    ///   3. a sticky pin from ANOTHER build is dropped with its strikes: a new
    ///      CFBundleVersion is the fix a crash loop was waiting for.
    ///   4. sticky for THIS build, or strikes at the limit -> legacy/crash-loop,
    ///      the pin (re)written. Safety beats every preference below it,
    ///      including a Developer override of native.
    ///   5. the override, then 6. the plist.
    public static func decide(_ i: Inputs) -> Decision {
        let strikes0 = max(0, i.strikes)
        let sticky0 = i.stickyLegacyBuild.flatMap { $0.isEmpty ? nil : $0 }
        func out(_ mode: Mode, _ reason: Vocabulary.ModeReason, _ strikes: Int, _ sticky: String?) -> Decision {
            Decision(mode: mode, reason: reason, strikes: strikes, stickyLegacyBuild: sticky, writeSentinel: mode == .native)
        }

        guard i.built else { return out(.legacy, .notBuilt, strikes0, sticky0) }

        var strikes = i.sentinelWasSet ? strikes0 + 1 : strikes0
        var sticky = sticky0
        if let pinned = sticky, pinned != i.currentBuild {
            sticky = nil
            strikes = 0
        }
        if sticky == i.currentBuild || strikes >= strikeLimit {
            return out(.legacy, .crashLoop, strikes, i.currentBuild)
        }

        switch i.modeOverride {
        case .native: return out(.native, .`override`, strikes, nil)
        case .web: return out(.legacy, .`override`, strikes, nil)
        case .auto: break
        }
        switch i.buildDefault {
        case .native?: return out(.native, .buildDefault, strikes, nil)
        case .js?: return out(.legacy, .buildDefault, strikes, nil)
        case nil: return out(.legacy, .noPlistKey, strikes, nil)
        }
    }

    // MARK: - The strike rules across time (engineModeTrace)

    /// The engine-private `UserDefaults` state the decision reads and writes
    /// (§4.6): `ForayEngine.modeOverride`, `.strikes`, `.sentinel`,
    /// `.stickyLegacyBuild`.
    public struct Stored: Equatable, Sendable {
        public var modeOverride: Override
        public var strikes: Int
        public var sentinel: Bool
        public var stickyLegacyBuild: String?

        /// A stored state as read: a negative count is 0 and an empty pin is
        /// none, as the JS reads them.
        public init(modeOverride: Override = .auto, strikes: Int = 0, sentinel: Bool = false, stickyLegacyBuild: String? = nil) {
            self.modeOverride = modeOverride
            self.strikes = max(0, strikes)
            self.sentinel = sentinel
            self.stickyLegacyBuild = stickyLegacyBuild.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    /// `ENGINE_MODE_EVENTS`.
    public enum EventKind: String, CaseIterable, Sendable {
        case launch
        case healthy
        case pageHealth = "page-health"
        case setOverride = "set-override"
    }

    /// What moves the stored state between and within launches.
    public enum Event: Equatable, Sendable {
        /// A process starts: `decide` over the stored state; the old sentinel
        /// is consumed and a new one written only for a native boot.
        case launch(buildDefault: BuildDefault?, currentBuild: String, built: Bool)
        /// A healthy marker (first handled input, 5 s of run loop, resign
        /// active / background, first `.playing`): the sentinel clears and
        /// strikes reset to 0. Native processes only; legacy wrote no sentinel.
        case healthy
        /// No engineHello within 10 s of a foreground page load: ONE strike per
        /// process, counted from the strikes this launch STARTED with (the 5 s
        /// healthy marker has usually reset the live count by then, and a page
        /// broken on every launch must still reach legacy). After it, a later
        /// healthy marker clears the sentinel but no longer resets the strikes.
        case pageHealth
        /// The Developer setting changed: stored override, strikes 0, sticky
        /// cleared. The running process keeps its lane ("applies after restart").
        case setOverride(Override)

        public var kind: EventKind {
            switch self {
            case .launch: return .launch
            case .healthy: return .healthy
            case .pageHealth: return .pageHealth
            case .setOverride: return .setOverride
            }
        }
    }

    /// The state after one event: the current process's lane (nil before the
    /// first launch) and the stored state.
    public struct Step: Equatable, Sendable {
        public let kind: EventKind
        public let mode: Mode?
        public let reason: Vocabulary.ModeReason?
        public let stored: Stored
    }

    /// `engineModeTrace(stored, events)`: fold launches and in-process events
    /// over the stored state, which one `decide` call cannot show. NE-17's
    /// XCTests drive `EngineOwnership` through the same sequences.
    public static func trace(from initial: Stored, events: [Event]) -> [Step] {
        struct Process {
            let mode: Mode
            let reason: Vocabulary.ModeReason
            let launchStrikes: Int
            var pageHealthTaken: Bool
        }
        var s = initial
        var process: Process?
        var steps: [Step] = []
        for event in events {
            switch event {
            case let .launch(buildDefault, currentBuild, built):
                let d = decide(Inputs(buildDefault: buildDefault, modeOverride: s.modeOverride, sentinelWasSet: s.sentinel,
                                      strikes: s.strikes, stickyLegacyBuild: s.stickyLegacyBuild,
                                      currentBuild: currentBuild, built: built))
                s.strikes = d.strikes
                s.stickyLegacyBuild = d.stickyLegacyBuild
                s.sentinel = d.writeSentinel
                process = Process(mode: d.mode, reason: d.reason, launchStrikes: d.strikes, pageHealthTaken: false)
            case .healthy:
                if let p = process, p.mode == .native {
                    s.sentinel = false
                    if !p.pageHealthTaken { s.strikes = 0 }
                }
            case .pageHealth:
                if var p = process, p.mode == .native, !p.pageHealthTaken {
                    p.pageHealthTaken = true
                    process = p
                    s.strikes = p.launchStrikes + 1
                }
            case let .setOverride(mode):
                s.modeOverride = mode
                s.strikes = 0
                s.stickyLegacyBuild = nil
            }
            steps.append(Step(kind: event.kind, mode: process?.mode, reason: process?.reason, stored: s))
        }
        return steps
    }
}
