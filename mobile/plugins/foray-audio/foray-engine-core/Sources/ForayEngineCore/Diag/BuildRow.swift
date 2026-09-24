import Foundation

/// The `build` row (card NE-19; plan §4.4, §4.6, §10): written once per engine
/// boot, first, so every paste says which engine produced the rows under it.
///
///   engineVersion  the engine's own version (the Copy header's `v<ver>`)
///   protocol       the web <-> native contract version (§5)
///   bundleVersion  CFBundleVersion: which TestFlight build this is
///   launch         `background` (a car's play woke a terminated app, the
///                  cold path) or `foreground` (DV-7a/DV-7b)
///   pitch          the decks' `audioTimePitchAlgorithm` (§4.3)
///   hold           `pauseHoldPolicy` (§4.4), the setting OQ-12 decides from
public struct BuildRow: Equatable {
    public static let kind = "build"

    public enum Launch: String, Equatable, Sendable, CaseIterable {
        case background
        case foreground
    }

    public var engineVersion: String
    public var protocolVersion: Int
    public var bundleVersion: String
    public var launch: Launch
    public var pitchAlgorithm: String
    public var holdPolicy: SessionPolicy.HoldPolicy

    public init(engineVersion: String, protocolVersion: Int = EngineHandshake.protocolVersion,
                bundleVersion: String, launch: Launch, pitchAlgorithm: String = "timeDomain",
                holdPolicy: SessionPolicy.HoldPolicy) {
        self.engineVersion = engineVersion
        self.protocolVersion = protocolVersion
        self.bundleVersion = bundleVersion
        self.launch = launch
        self.pitchAlgorithm = pitchAlgorithm
        self.holdPolicy = holdPolicy
    }

    public var entry: DiagEntry {
        DiagEntry(kind: BuildRow.kind, fields: [
            JSONMember("engineVersion", .string(engineVersion)),
            JSONMember("protocol", .number(Double(protocolVersion))),
            JSONMember("bundleVersion", .string(bundleVersion)),
            JSONMember("launch", .string(launch.rawValue)),
            JSONMember("pitch", .string(pitchAlgorithm)),
            JSONMember("hold", .string(holdPolicy.text))
        ])
    }
}
