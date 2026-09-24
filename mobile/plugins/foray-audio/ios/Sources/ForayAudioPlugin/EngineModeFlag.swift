import Foundation

/// Whether the native engine owns `AVAudioSession` in THIS process (card NE-16;
/// docs/native-engine-plan.md §4.4). BYTE-IDENTICAL in foray-audio and foray-tts,
/// so neither plugin depends on the other; `shell-invariants.test.mjs` compares
/// the two files. The VOLATILE domain is process-scoped and never written to
/// disk: a relaunch always starts false, the legacy lane's answer, until
/// `decideOnce()` says native. A relinquish flips it back to false, one way.
enum EngineModeFlag {
    static let domain = "ai.jwlabs.foura.engine"
    static let key = "sessionOwnedByEngine"

    static var sessionOwnedByEngine: Bool {
        get { UserDefaults.standard.volatileDomain(forName: domain)[key] as? Bool ?? false }
        set { UserDefaults.standard.setVolatileDomain([key: newValue], forName: domain) }
    }
}
