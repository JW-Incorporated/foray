import Foundation
import ForayEngineCore

// ── WHO PLAYS THIS PROCESS (card NE-17; docs/native-engine-plan.md §4.6) ────
//
// One question, answered once per process: does the native engine own the
// audio, the remote commands and Now Playing, or does the legacy lane (the
// JS player plus this plugin's Now Playing half, exactly as build 2026092327
// plays) own them? `EngineMode.decide` (NE-11s, fixture-pinned by the
// `engine-mode` family) is the rule. This file is the only thing that moves
// values in and out of it, and the only thing that acts on the answer:
//
//   - `decideOnce()` reads Info.plist's `ForayEngineDefault`, the private
//     keys and CFBundleVersion, decides, and writes the strike state back
//     BEFORE anything native boots, so a boot that crashes has already been
//     counted against itself.
//   - legacy: today's registration runs, unchanged, inside `load()`.
//   - native: that registration is parked; the engine boots and owns the
//     session flag. A one-way relinquish (the page's, or the hello watchdog's)
//     tears the engine down and runs the parked registration, once.
//
// WHY A SENTINEL AND NOT A LAUNCH COUNTER (plan §4.6, R18). The founder's
// phone launches 4a in the background every time a car or a headset presses
// play. A counter would call three of those a crash loop and take his native
// player away for a build. A sentinel counts only a native boot that never
// reached a healthy marker: the first handled input, 5 s of the main run
// loop, a resign / background, or the first confirmed `.playing` (an input
// like any other, so the first of these covers it).
//
// WHY THE LANE NEVER CHANGES INSIDE A PROCESS. `MPRemoteCommandCenter` and
// `AVAudioSession` are process-wide. Two owners flipping between them is the
// defect this deck removes, so the only move is native -> legacy, once, and
// the Developer setting "applies after restart".

/// The engine-private `UserDefaults` keys (plan §4.6). OUTSIDE
/// `CapacitorStorage.` on purpose: DurableStore enumerates that prefix, and a
/// page that could see the strike count could also clobber it. They are
/// reachable from the page only through `engineRead` / `engineSend`.
enum EnginePrivateKey: String, CaseIterable {
    case modeOverride = "ForayEngine.modeOverride"
    case strikes = "ForayEngine.strikes"
    case sentinel = "ForayEngine.sentinel"
    case stickyLegacyBuild = "ForayEngine.stickyLegacyBuild"
    /// The cold-path restore record (EngineStore, NE-19). Named here so the
    /// whole private set lives in one list.
    case restore = "ForayEngine.restore"
    /// `pauseHoldPolicy` (AudioSessionOwner, NE-16).
    case holdPolicy = "ForayEngine.holdPolicy"
}

/// The private keys, read and written SYNCHRONOUSLY. `UserDefaults.set` is
/// in-process and immediate; there is no write-behind queue to lose a strike
/// or an override to a crash in the next millisecond.
final class EnginePrivateStore {
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func string(_ key: EnginePrivateKey) -> String? {
        defaults.string(forKey: key.rawValue).flatMap { $0.isEmpty ? nil : $0 }
    }

    func set(_ value: String?, _ key: EnginePrivateKey) {
        if let value, !value.isEmpty {
            defaults.set(value, forKey: key.rawValue)
        } else {
            defaults.removeObject(forKey: key.rawValue)
        }
    }

    var strikes: Int {
        get { max(0, defaults.integer(forKey: EnginePrivateKey.strikes.rawValue)) }
        set { defaults.set(max(0, newValue), forKey: EnginePrivateKey.strikes.rawValue) }
    }

    /// The state `EngineMode.trace` folds, as stored: the same value the
    /// XCTests compare the owner against.
    var stored: EngineMode.Stored {
        EngineMode.Stored(modeOverride: .stored(string(.modeOverride)), strikes: strikes,
                          sentinel: string(.sentinel) != nil, stickyLegacyBuild: string(.stickyLegacyBuild))
    }
}

// MARK: - The session flag both plugins read

/// `sessionOwnedByEngine` (plan §4.4): true while the engine owns the audio
/// session, so the legacy `setActive` / `setCategory` sites in both plugins
/// stand down. `decideOnce` sets it for a native boot; the relinquish clears
/// it, one way.
protocol SessionOwnershipFlag: AnyObject {
    var sessionOwnedByEngine: Bool { get set }
}

/// The flag in the `UserDefaults` VOLATILE domain `ai.jwlabs.foura.engine`:
/// process-scoped and never persisted, so a process that died owning the
/// session cannot leave the next one's legacy lane standing down. NE-16's
/// `EngineModeFlag.swift` (byte-identical in foray-tts) reads the same domain
/// and key; when it lands, this conformer delegates to it.
final class VolatileSessionOwnershipFlag: SessionOwnershipFlag {
    static let domain = "ai.jwlabs.foura.engine"
    static let key = "sessionOwnedByEngine"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var sessionOwnedByEngine: Bool {
        get {
            guard defaults.volatileDomainNames.contains(Self.domain) else { return false }
            return defaults.volatileDomain(forName: Self.domain)[Self.key] as? Bool ?? false
        }
        set {
            var domain = defaults.volatileDomainNames.contains(Self.domain)
                ? defaults.volatileDomain(forName: Self.domain) : [:]
            domain[Self.key] = newValue
            defaults.setVolatileDomain(domain, forName: Self.domain)
        }
    }
}

// MARK: - Resign and background, for the healthy marker

/// `willResignActive` and `didEnterBackground`, on main. The real conformer
/// (`UIKitOwnershipLifecycle`) is the only UIKit in this story; the owner
/// itself stays Foundation-only so it runs headless over a fake.
protocol OwnershipLifecycle: AnyObject {
    func observeResignOrBackground(_ handler: @escaping () -> Void) -> EngineObservation
}

// MARK: - The owner

@MainActor
final class EngineOwnership {

    /// What the process was launched with: the three inputs to the decision
    /// that do not live in the private keys.
    struct LaunchEnvironment: Equatable {
        /// Info.plist `ForayEngineDefault` (tools/mobile/inject-background-audio.mjs
        /// writes it from mobile/ENGINE_DEFAULT.json). Nil when absent or not
        /// one of the two words: `no-plist-key`, today's player.
        var buildDefault: EngineMode.BuildDefault?
        /// `CFBundleVersion`: what a sticky legacy pin is pinned to.
        var currentBuild: String
        /// This launch's sentinel value. Its content is only for the record;
        /// what counts is whether the PREVIOUS one is still set.
        var launchId: String

        static let buildDefaultKey = "ForayEngineDefault"

        /// Read from an Info dictionary. STRICT, like the injector: "Native"
        /// or a boolean is not a decision anybody made, so it reads as absent.
        static func from(info: [String: Any]?, launchId: String = UUID().uuidString) -> LaunchEnvironment {
            let raw = info?[buildDefaultKey] as? String
            return LaunchEnvironment(buildDefault: raw.flatMap(EngineMode.BuildDefault.init(rawValue:)),
                                     currentBuild: info?["CFBundleVersion"] as? String ?? "",
                                     launchId: launchId)
        }
    }

    /// Which marker proved the native boot healthy (the `mode kind=healthy` row).
    enum HealthyMarker: String {
        case firstInput = "first-input"
        case runLoop = "run-loop"
        case resignOrBackground = "resign-or-background"
    }

    /// Plan §4.6: the healthy marker's run-loop leg.
    static let healthyRunLoopMs: Double = 5_000
    /// No engineHello this long after a FOREGROUND page load is a page-health
    /// strike (plan §4.6).
    static let pageHealthMs: Double = 10_000
    /// No engineHello this long after a page load, with the engine idle: the
    /// engine relinquishes by itself, so a JS page never runs without the
    /// legacy remote surface. Longer than the page's own 5 s hello bound
    /// (native-engine.js HELLO_TIMEOUT_MS), so a page that gave up has always
    /// sent its own relinquish first.
    static let helloWatchdogMs: Double = 15_000

    // MARK: The process's owner

    private static var instance: EngineOwnership?

    /// Built on first use by whichever entry point runs first: the AppDelegate
    /// cold path (`bootIfNeeded`, NE-24) or the plugin's `load()`. The other
    /// reads the same object, so the strike accounting happens once.
    ///
    /// `engineFactory: nil` IS THIS BUILD'S TRUTH: the real conformers of
    /// the session, grace, remote, Now Playing and store seams land in NE-16,
    /// NE-16g, NE-18 and NE-19, and the boot that wires them (NE-24) supplies
    /// the factory. Until then `decide` sees `built: false` and every launch
    /// is `legacy reason=not-built`, whatever the plist or a Developer
    /// override says: a binary with no engine cannot be told to run one.
    static var shared: EngineOwnership {
        if let instance { return instance }
        let owner = EngineOwnership(
            store: EnginePrivateStore(),
            environment: .from(info: Bundle.main.infoDictionary),
            flag: VolatileSessionOwnershipFlag(),
            timing: MainQueueTiming(),
            lifecycle: UIKitOwnershipLifecycle(),
            diag: EngineOwnership.log,
            engineFactory: nil)
        instance = owner
        return owner
    }

    // MARK: State

    let store: EnginePrivateStore
    let environment: LaunchEnvironment
    private let flag: SessionOwnershipFlag
    private let timing: EngineTiming
    private let lifecycle: OwnershipLifecycle
    private let diag: (DiagEntry) -> Void
    private let engineFactory: (@MainActor () -> ForayEngine)?

    private var decision: EngineMode.Decision?
    private(set) var engine: ForayEngine?
    /// Today's registration, parked by a native `load()` until a relinquish.
    private var legacyRegistration: (() -> Void)?
    private(set) var legacyRegistered = false
    private(set) var relinquished = false

    private var healthyMarked = false
    private var pageHealthTaken = false
    private var healthyObservations: [EngineObservation] = []
    private var pageHealthTimer: EngineObservation?
    private var helloTimer: EngineObservation?

    init(store: EnginePrivateStore, environment: LaunchEnvironment, flag: SessionOwnershipFlag,
         timing: EngineTiming, lifecycle: OwnershipLifecycle, diag: @escaping (DiagEntry) -> Void,
         engineFactory: (@MainActor () -> ForayEngine)?) {
        self.store = store
        self.environment = environment
        self.flag = flag
        self.timing = timing
        self.lifecycle = lifecycle
        self.diag = diag
        self.engineFactory = engineFactory
    }

    /// The lane this process runs, once decided.
    var mode: EngineMode.Mode? { decision?.mode }

    // MARK: - decideOnce

    /// The process's one decision. The first call reads, decides and writes
    /// back; every later call (the other entry point, the bridge) returns the
    /// same answer and writes nothing.
    @discardableResult
    func decideOnce() -> EngineMode.Decision {
        if let decision { return decision }
        let stored = store.stored
        let decided = EngineMode.decide(EngineMode.Inputs(
            buildDefault: environment.buildDefault, modeOverride: stored.modeOverride,
            sentinelWasSet: stored.sentinel, strikes: stored.strikes,
            stickyLegacyBuild: stored.stickyLegacyBuild, currentBuild: environment.currentBuild,
            built: engineFactory != nil))
        // Written BEFORE the native boot: a boot that crashes has been
        // counted. Only what changed is written, so a build with no engine
        // (every launch `not-built`) and nothing stored writes no key at all.
        if decided.strikes != stored.strikes { store.strikes = decided.strikes }
        if decided.stickyLegacyBuild != stored.stickyLegacyBuild {
            store.set(decided.stickyLegacyBuild, .stickyLegacyBuild)
        }
        if decided.writeSentinel || stored.sentinel {
            store.set(decided.writeSentinel ? environment.launchId : nil, .sentinel)
        }
        decision = decided
        row("mode", [
            JSONMember("mode", .string(decided.mode.rawValue)),
            JSONMember("reason", .string(decided.reason.rawValue)),
            JSONMember("strikes", .number(Double(decided.strikes))),
            JSONMember("sentinelWasSet", .string(stored.sentinel ? "y" : "n")),
            JSONMember("build", .string(environment.currentBuild))
        ])
        return decided
    }

    // MARK: - The two entry points

    /// The AppDelegate cold path (NE-24): decide, and in native mode boot the
    /// engine so its remote targets exist before the bridge ever loads. Boots
    /// nothing audible (no activation: plan §4.5, S-3).
    @discardableResult
    func bootIfNeeded() -> ForayEngine? {
        guard decideOnce().mode == .native, !relinquished else { return nil }
        return bootEngine()
    }

    /// The plugin's `load()`. Legacy: today's registration runs NOW, in
    /// `load()`, exactly as before this card. Native: it is parked for a
    /// relinquish, and the engine is booted if the cold path has not already.
    func pluginDidLoad(legacyRegistration: @escaping () -> Void) {
        if decideOnce().mode == .legacy || relinquished {
            runLegacy(legacyRegistration)
            return
        }
        self.legacyRegistration = legacyRegistration
        if bootEngine() == nil {
            // Native without an engine cannot happen (`built` is the factory),
            // but if it ever did, a process with no remote surface at all is
            // the one outcome worse than the legacy lane.
            parkedLegacyTakesOver()
        }
    }

    private func bootEngine() -> ForayEngine? {
        if let engine { return engine }
        guard let engineFactory else { return nil }
        // Before the engine exists: the legacy session sites stand down first.
        flag.sessionOwnedByEngine = true
        let booted = engineFactory()
        engine = booted
        booted.onTurnCompleted = { [weak self] in
            MainActor.assumeIsolated { self?.markHealthy(.firstInput) }
        }
        booted.onTornDown = { [weak self] in
            MainActor.assumeIsolated { self?.engineDidTearDown() }
        }
        armHealthyMarkers()
        return booted
    }

    // MARK: - The healthy marker and the strikes

    private func armHealthyMarkers() {
        guard !healthyMarked else { return }
        healthyObservations.append(timing.schedule(afterMs: Self.healthyRunLoopMs, repeating: false) { [weak self] in
            MainActor.assumeIsolated { self?.markHealthy(.runLoop) }
        })
        healthyObservations.append(lifecycle.observeResignOrBackground { [weak self] in
            MainActor.assumeIsolated { self?.markHealthy(.resignOrBackground) }
        })
    }

    /// Whichever marker comes first clears the sentinel and resets the
    /// strikes (`EngineMode.trace`'s `healthy`), once. After a page-health
    /// strike the reset is withheld: a page that is broken on every launch
    /// must still reach legacy, even though its native boot was healthy.
    func markHealthy(_ marker: HealthyMarker) {
        guard decision?.mode == .native, !healthyMarked else { return }
        healthyMarked = true
        store.set(nil, .sentinel)
        if !pageHealthTaken { store.strikes = 0 }
        healthyObservations.forEach { $0.cancel() }
        healthyObservations = []
        engine?.onTurnCompleted = nil
        row("mode", [JSONMember("kind", .string("healthy")), JSONMember("marker", .string(marker.rawValue)),
                     JSONMember("strikes", .number(Double(store.strikes)))])
    }

    /// No engineHello after a foreground page load: one strike per process,
    /// counted from the strikes this launch STARTED with (the 5 s healthy
    /// marker has usually reset the live count by then).
    private func pageHealthStrike() {
        guard let decision, decision.mode == .native, !pageHealthTaken else { return }
        pageHealthTaken = true
        store.strikes = decision.strikes + 1
        row("mode", [JSONMember("reason", .string(Vocabulary.ModeReason.pageHealth.rawValue)),
                     JSONMember("strikes", .number(Double(store.strikes)))])
    }

    /// The Developer setting 'Playback engine: Automatic / Native / Web
    /// (applies after restart)', through `engineSend setModeOverride`.
    /// Written synchronously; strikes and the sticky pin are cleared, so a
    /// listener who chose again gets a fresh start. The running process keeps
    /// its lane.
    func setModeOverride(_ mode: EngineMode.Override) {
        store.set(mode.rawValue, .modeOverride)
        store.strikes = 0
        store.set(nil, .stickyLegacyBuild)
        row("mode", [JSONMember("kind", .string("set-override")), JSONMember("override", .string(mode.rawValue))])
    }

    // MARK: - The hello watchdog

    /// The WebView finished loading a page. Each load must say hello: a page
    /// that does not (an old web bundle, a page that threw at boot) would run
    /// the JS player over an engine that owns the remote surface.
    func pageDidFinishLoad(foreground: Bool) {
        guard engine != nil, !relinquished else { return }
        cancelHelloTimers()
        if foreground {
            pageHealthTimer = timing.schedule(afterMs: Self.pageHealthMs, repeating: false) { [weak self] in
                MainActor.assumeIsolated {
                    self?.pageHealthTimer?.cancel()
                    self?.pageHealthTimer = nil
                    self?.pageHealthStrike()
                }
            }
        }
        armHelloWatchdog()
    }

    /// engineHello arrived: the page has claimed the engine.
    func helloReceived() {
        cancelHelloTimers()
    }

    private func armHelloWatchdog() {
        helloTimer = timing.schedule(afterMs: Self.helloWatchdogMs, repeating: false) { [weak self] in
            MainActor.assumeIsolated { self?.helloWatchdogFired() }
        }
    }

    /// Idle: relinquish, with the strike row. Running (a car's cold play, say):
    /// never stop the listener's audio for a page's sake; look again later.
    private func helloWatchdogFired() {
        helloTimer?.cancel()
        helloTimer = nil
        guard let engine, !relinquished else { return }
        if engine.state.isRunning {
            row("mode", [JSONMember("kind", .string("hello-watchdog")), JSONMember("outcome", .string("deferred"))])
            armHelloWatchdog()
            return
        }
        pageHealthStrike()
        // `restore`: the page's boot, not a press (as the page's own
        // handshake relinquish is sourced).
        relinquish(cap: .all, source: .restore)
    }

    private func cancelHelloTimers() {
        pageHealthTimer?.cancel()
        pageHealthTimer = nil
        helloTimer?.cancel()
        helloTimer = nil
    }

    // MARK: - The one-way relinquish

    /// Plan §4.6, in order. The core does steps 1, 2, 6 and 7's row inside
    /// the turn (stop with persistence, the session KEPT with no deactivate
    /// and no notify, the `{mode:"relinquished"}` restore record, `mode
    /// reason=downgrade cap=`); the host tears every registration down when
    /// the core goes terminal; `engineDidTearDown` then flips the flag and
    /// runs the legacy registration. Now Playing is left for the legacy lane
    /// to overwrite. A second relinquish is refused.
    @discardableResult
    func relinquish(cap: EngineContract.RelinquishCap, source: EngineSource) -> EngineVerdict {
        guard let engine, !relinquished else {
            return EngineVerdict(failures: [EngineContract.Refusal.relinquished.rawValue], deferred: false)
        }
        let verdict = engine.handle(.command(.relinquish(cap: cap), source: source))
        // Queued behind a turn in progress: the host tears down when the core
        // gets to it. Tearing down now would drop the relinquish itself.
        if !verdict.deferred { engine.teardown() }
        return verdict
    }

    /// The engine is gone, whatever took it: the process belongs to the
    /// legacy lane from here to its end.
    private func engineDidTearDown() {
        guard !relinquished else { return }
        relinquished = true
        cancelHelloTimers()
        flag.sessionOwnedByEngine = false
        parkedLegacyTakesOver()
    }

    private func parkedLegacyTakesOver() {
        guard let registration = legacyRegistration else { return }
        legacyRegistration = nil
        runLegacy(registration)
    }

    private func runLegacy(_ registration: () -> Void) {
        guard !legacyRegistered else { return }
        legacyRegistered = true
        registration()
    }

    // MARK: - Rows

    private func row(_ kind: String, _ fields: [JSONMember]) {
        diag(DiagEntry(kind: kind, fields: fields))
    }

    /// Until EngineStore's ring (NE-19) exists, the owner's rows go to the
    /// unified log, which the ios-build log stream captures.
    nonisolated private static func log(_ entry: DiagEntry) {
        EngineOwnershipLog.write(entry)
    }
}
