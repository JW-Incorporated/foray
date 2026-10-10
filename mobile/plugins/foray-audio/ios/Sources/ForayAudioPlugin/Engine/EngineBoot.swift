import Foundation
import ForayEngineCore

// ── THE BOOT: THE REAL SEAMS, ONCE (card NE-24; docs/native-engine-plan.md
// §4.5 and §4.6) ──────────────────────────────────────────────────────────
//
// Until this card `EngineOwnership.shared` had no engine factory, so every
// launch decided `legacy reason=not-built`. This file is the factory: the
// real conformers of every seam, wired to the ONE store and ring the owner
// and the bridge already use, then the cold path (`ForayEngine.coldBoot`).
//
// WHO CALLS IT. Whichever of the two entry points runs first:
//   - the AppDelegate (`ForayEngineColdPath.bootIfNeeded()`, patched into
//     `didFinishLaunching` by tools/mobile/inject-background-audio.mjs), which
//     is the ONLY entry point on a background launch: iOS relaunching a
//     terminated 4a for a car's play loads no WebView, so without it there
//     would be no remote target to receive the play (A-8, M-9);
//   - the plugin's `load()`, on a launch where the AppDelegate line is absent.
// The other finds the same engine (`EngineOwnership.bootEngine`), and the
// bridge's later `load()` attaches to it and never re-registers.
//
// NOTHING HERE IS AUDIBLE. The session owner sets the category at
// construction and activates nothing; the cold boot paints Now Playing at
// rate 0 (S-3). The first activation is a play's, inside the turn that asked.
enum EngineBoot {

    /// NE-47: how long the voice preview's load may take before the audition
    /// is spoken instead. PROVISIONAL: a listener tapped "preview" and is
    /// waiting, so this is well under the main deck's 20 s (P-13), and above
    /// the few seconds a cold 64 kbps `.m4a` of a sentence takes on a slow
    /// cellular link. The `deck` rows with `lane=preview` carry the load's
    /// time to ready (`elapsedMs`) and any `deadlineExceeded`; the first
    /// week of rendered-voice previews settles it.
    /// Both deadline classes (NE-38) get it on the preview deck: a preview
    /// is a preview whatever class its load names. Table: measurements §12.
    static let previewLoadDeadlineSec: Double = 6 // MEASURE: verdict=preview-load (NE-47). Rows: deck kind=ready elapsedMs lane=preview, deck kind=deadline lane=preview, audition kind=fallback reason=timeout.

    /// The plist key the injector writes from `mobile/ENGINE_DEFAULT.json`'s
    /// `ios.routeResumeBluetooth` (NE-38rs).
    static let routeResumeBluetoothKey = "ForayEngineRouteResumeBluetooth"

    /// The Bluetooth arm as the plist says it; a missing or non-boolean value
    /// is the core's default (OFF).
    static func routeResumeBluetooth(_ info: [String: Any]?) -> Bool {
        (info?[routeResumeBluetoothKey] as? Bool) ?? RouteResume.bluetoothDefault
    }

    /// NE-40, DV-8: the `.longFormAudio` route-sharing trial, from the
    /// Developer row's stored choice ONLY. Nothing stored, or `default`, is
    /// OFF: M1's car win happened on the default route sharing, so no build,
    /// plist or ENGINE_DEFAULT value turns it on; only a Developer tap does,
    /// and only from the next launch.
    static func routeSharingLongForm(_ stored: EngineContract.RouteSharingPolicy?) -> Bool {
        stored == .longFormAudio
    }

    /// Build the process's engine in native mode. The `build` row is written
    /// FIRST, before any seam writes its own (BuildRow's rule), so every
    /// paste says which engine and which launch produced the rows under it.
    @MainActor
    static func makeEngine(store: EngineStore, timing: MainQueueTiming, bundleVersion: String) -> ForayEngine {
        let holdPolicy = HoldPolicyStore()
        // NE-40: the route-sharing trial is read BEFORE the build row, which
        // says which policy this launch runs (`routeSharing=`), and before the
        // session owner, which sets its category at construction.
        let longForm = EngineBoot.routeSharingLongForm(store.loadRouteSharing())
        store.diagnostics.build(BuildRow(
            engineVersion: EngineBridgeRules.engineVersion, bundleVersion: bundleVersion,
            launch: UIKitOwnershipLifecycle.launchedInBackground ? .background : .foreground,
            holdPolicy: holdPolicy.load() ?? .default,
            routeSharing: longForm ? EngineContract.RouteSharingPolicy.longFormAudio : .standard,
            // L09/L28: which phone, which iOS, and how it was at boot
            // (DeviceFacts, ForayAudioPlugin.swift: the platform reads).
            hw: DeviceFacts.machine(),
            os: DeviceFacts.osVersion(),
            lowPower: DeviceFacts.lowPowerMode(),
            thermal: DeviceFacts.thermalToken(ProcessInfo.processInfo.thermalState),
            availMb: DeviceFacts.availableMemoryMb()))

        let session = AudioSessionOwner(config: AudioSessionOwner.Config(longFormAudio: longForm,
                                                                         diag: { store.diag($0) }))
        var config = EngineConfig(build: bundleVersion)
        // NE-40: OFF unless the Developer row stored the trial (above).
        config.routeSharingLongForm = longForm
        // NE-37, THE M2 FLIP: the app's engine plays Forays. The core's own
        // defaults stay OFF (every headless test and the parity driver build
        // one without them); the shipping boot turns on the Foray tape
        // (NE-30s) and the two-deck pair with its prepared standby (NE-32).
        // The rest stay off on purpose: the silence node until a drive paste
        // shows a `grace kind=late inSeam=y` row (NE-46's rule; SilenceNode.swift's
        // header), the direct synthesizer until DV-9 answers
        // (NE-33), and SPOKEN narration at the listener's speed until the
        // founder changes his 1x ruling (OQ-3; a RENDERED line, one with an
        // `audio_url`, follows the listener's speed since D2, 2026-09-28, with
        // no flag). The page only sends `playForay` when
        // the hello grants `foray` (mobile/ENGINE_DEFAULT.json ∩
        // EngineBridgeRules.advertisedCapabilities).
        config.forayTapeEnabled = true
        config.deckPairEnabled = true
        // NE-38rs: route resume's Bluetooth arm, from mobile/ENGINE_DEFAULT.json
        // by way of the plist (tools/mobile/inject-background-audio.mjs). OFF
        // (provisional, measurements §12, verdict route-back); absent reads as
        // the core's default.
        config.routeResumeBluetooth = EngineBoot.routeResumeBluetooth(Bundle.main.infoDictionary)
        // P-7's CBR exemption: ON. docs/ios-native-engine-measurements.md §13's
        // Simulator row (ios-kit run 36903416379, 2026-10-01) put an approximate
        // seek into the Info-TOC-skewed+7 file 0 ms off at 19.65 / 49.65 /
        // 69.65 s, where following the TOC would land it +2.2 to +2.3 s late:
        // AVFoundation does CBR byte arithmetic and ignores the Info TOC. So a
        // clip on a measured-CBR source (`seek_map: "cbr"`) loads approximate
        // and no longer downloads its whole MP3 first (M2 drive: 43,855,107 B
        // for one clip). VBR and unmeasured sources stay precise.
        config.approximateCBRClips = true
        // NE-46: the deck's own P-13 deadlines, so a load deadline that fires
        // late while grace is held writes `grace kind=late timer=load-deadline`.
        config.loadDeadlineMs = [.clip: AVDeck.defaultLoadDeadlineSec * 1000,
                                 .line: AVDeck.defaultLineLoadDeadlineSec * 1000]
        // CH3-19 (R2-08): ONE session phase gates every audible start, the
        // core's. The gate is made before the engine it reads (every adapter
        // below takes it at construction) and attached to it right after;
        // before that nothing is audible, and it answers false.
        let gate = EngineSessionGate()
        let sessionIsActive = { gate.isActive }
        // NE-34: the seam's jingle on the bundled asset (nil, and no jingle,
        // if the asset did not ship), and the silence node only behind its
        // flag (OFF). The jingle sounds at a Foray's seams now the tape is on.
        let interlude = InterludePlayer.make(sessionIsActive: sessionIsActive, diag: { store.diag($0) },
                                             timing: timing)
        config.interludeAvailable = interlude != nil
        let silence: SilenceRendering? = config.silenceNodeEnabled
            ? SilenceNode(config: SilenceNode.Config(sessionIsActive: sessionIsActive, diag: { store.diag($0) },
                                                     timing: timing))
            : nil
        // NE-32: two decks with a prepared standby, behind `deckPairEnabled`
        // (on since NE-37, above); off, M1's one deck. Either way the deck's
        // `outPoint` rows go into the ring.
        let deck: DeckDriving = config.deckPairEnabled
            ? DeckPair.make(sessionIsActive: sessionIsActive, diag: { store.diag($0) })
            : AVDeck(config: AVDeck.Config(sessionIsActive: sessionIsActive, diag: { store.diag($0) }))
        // NE-47: the voice picker's rendered preview plays on a deck of its
        // own (the page sends a `url` only once the picker offers rendered
        // voices, so until then this deck never loads anything). Its rows
        // say `lane=preview`, so a Copy never mistakes them for the main
        // deck's. A preview is a few seconds of a voice: a load that has not
        // answered inside `previewLoadDeadlineSec` is spoken instead.
        let preview = AVDeck(config: AVDeck.Config(
            loadDeadlineSec: EngineBoot.previewLoadDeadlineSec, lineLoadDeadlineSec: EngineBoot.previewLoadDeadlineSec,
            sessionIsActive: sessionIsActive,
            diag: { store.diag(DiagEntry(kind: $0.kind, fields: $0.fields + [JSONMember("lane", .string("preview"))])) },
            reusesSameSource: false))
        let seams = EngineSeams(
            session: session,
            background: BackgroundGrace(),
            remote: RemoteSurface(),
            nowPlaying: NowPlayingPublisher(),
            deck: deck,
            // NE-33: the one synthesizer, for the audition and the narration,
            // on the path DV-9 chose (PCM while DV-9 has no row; direct
            // behind `speechDirect`, off).
            speaker: SpeechNarrator(config: SpeechNarrator.Config(path: config.speechDirect ? .direct : .pcm,
                                                                  sessionIsActive: sessionIsActive,
                                                                  diag: { store.diag($0) })),
            timing: timing,
            output: store,
            holdPolicy: holdPolicy,
            knownRoutes: store,
            routeSharing: store,
            interlude: interlude,
            silence: silence,
            preview: preview,
            // Developer "Simulate system termination" only (DV-7a).
            terminate: { exit(0) })
        let engine = ForayEngine(seams: seams, config: config)
        gate.attach(engine, owner: session)
        engine.start()
        engine.coldBoot(from: store.restoreRecord())
        return engine
    }
}

/// THE ONE SESSION PHASE (CH3-19, R2-08; plan §4.3, §4.4). Every audible
/// start in the shell (a deck's play, the jingle, the silence node, a spoken
/// line) asks `isActive` first and writes `fault kind=implicit-activation`
/// when it is false. It answers the CORE's phase, `state.session == .active`:
/// the core decides every activation and every interruption, including the
/// one it rules late because the narrator is still speaking (R2-05), so a
/// start it commands is a start on the session it holds. Until this card the
/// adapters read `AudioSessionOwner.phase`, which moved on every `began`
/// whatever the core made of it: once the core heard the narrator, a late
/// `began` would have left the core active and the owner lost, and every
/// jingle after it refused.
///
/// The gate holds the engine weakly (the ownership record holds the engine;
/// a relinquished one is the legacy lane's process) and reads it on main
/// only, where every audible start runs; off main, or with no engine, it
/// answers false, which is the fault row, never a silent start.
final class EngineSessionGate {
    private weak var engine: ForayEngine?

    var isActive: Bool {
        guard Thread.isMainThread else { return false }
        return MainActor.assumeIsolated { engine?.state.session == .active }
    }

    /// The boot's one call, between building the engine and starting it:
    /// the gate reads that engine, and the session owner asks the gate after
    /// every `began` it forwards, so its own phase (rows only) stays with a
    /// `began` the core ruled late.
    @MainActor
    func attach(_ engine: ForayEngine, owner: AudioSessionOwner) {
        self.engine = engine
        owner.engineHoldsSession = { [weak self] in self?.isActive ?? false }
    }
}

/// THE APPDELEGATE'S ONE LINE (NE-24). Public because the app target calls
/// it: `ForayEngineColdPath.bootIfNeeded()` first thing in
/// `application(_:didFinishLaunchingWithOptions:)`, written there by
/// tools/mobile/inject-background-audio.mjs and read back by its `--check`.
///
/// It decides the process's lane (`EngineOwnership.decideOnce`) and, in
/// native mode only, boots the engine: remote targets registered, Now Playing
/// painted from the restore record at rate 0, nothing activated. In the
/// legacy lane it boots nothing, and the plugin's `load()` runs today's
/// registration exactly as before.
public enum ForayEngineColdPath {
    public static func bootIfNeeded() {
        let boot = { MainActor.assumeIsolated { _ = EngineOwnership.shared.bootIfNeeded() } }
        if Thread.isMainThread { boot() } else { DispatchQueue.main.sync(execute: boot) }
    }
}
