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

    /// Build the process's engine in native mode. The `build` row is written
    /// FIRST, before any seam writes its own (BuildRow's rule), so every
    /// paste says which engine and which launch produced the rows under it.
    @MainActor
    static func makeEngine(store: EngineStore, timing: MainQueueTiming, bundleVersion: String) -> ForayEngine {
        let holdPolicy = HoldPolicyStore()
        store.diagnostics.build(BuildRow(
            engineVersion: EngineBridgeRules.engineVersion, bundleVersion: bundleVersion,
            launch: UIKitOwnershipLifecycle.launchedInBackground ? .background : .foreground,
            holdPolicy: holdPolicy.load() ?? .default))

        let session = AudioSessionOwner(config: AudioSessionOwner.Config(diag: { store.diag($0) }))
        let config = EngineConfig(build: bundleVersion)
        let sessionIsActive = { session.phase == .active }
        // NE-32: two decks with a prepared standby, behind `deckPairEnabled`
        // (off until NE-37); otherwise M1's one deck. Either way the deck's
        // `outPoint` rows go into the ring.
        let deck: DeckDriving = config.deckPairEnabled
            ? DeckPair.make(sessionIsActive: sessionIsActive, diag: { store.diag($0) })
            : AVDeck(config: AVDeck.Config(sessionIsActive: sessionIsActive, diag: { store.diag($0) }))
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
            // Developer "Simulate system termination" only (DV-7a).
            terminate: { exit(0) })
        let engine = ForayEngine(seams: seams, config: config)
        engine.start()
        engine.coldBoot(from: store.restoreRecord())
        return engine
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
