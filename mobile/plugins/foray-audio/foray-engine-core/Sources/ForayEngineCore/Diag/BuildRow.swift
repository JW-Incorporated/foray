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
///
/// And the phone it booted on (L09, L28; docs/diagnostics/log-gaps-2026-09-26.md),
/// each written only when the boot could read it:
///   hw        `utsname.machine` with `,` -> `.` (`iPhone15.2`): the MODEL,
///             never the device's name, identifierForVendor or a serial
///   os        the iOS version (`18.6.2`)
///   lowPower  Low Power Mode at boot
///   thermal   `nominal fair serious critical` at boot
///   availMb   `os_proc_available_memory()` in MB: the headroom before jetsam
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
    public var hw: String?
    public var os: String?
    public var lowPower: Bool?
    public var thermal: String?
    public var availMb: Int?

    public init(engineVersion: String, protocolVersion: Int = EngineHandshake.protocolVersion,
                bundleVersion: String, launch: Launch, pitchAlgorithm: String = "timeDomain",
                holdPolicy: SessionPolicy.HoldPolicy,
                hw: String? = nil, os: String? = nil, lowPower: Bool? = nil,
                thermal: String? = nil, availMb: Int? = nil) {
        self.engineVersion = engineVersion
        self.protocolVersion = protocolVersion
        self.bundleVersion = bundleVersion
        self.launch = launch
        self.pitchAlgorithm = pitchAlgorithm
        self.holdPolicy = holdPolicy
        self.hw = hw
        self.os = os
        self.lowPower = lowPower
        self.thermal = thermal
        self.availMb = availMb
    }

    public var entry: DiagEntry {
        var fields = [
            JSONMember("engineVersion", .string(engineVersion)),
            JSONMember("protocol", .number(Double(protocolVersion))),
            JSONMember("bundleVersion", .string(bundleVersion)),
            JSONMember("launch", .string(launch.rawValue)),
            JSONMember("pitch", .string(pitchAlgorithm)),
            JSONMember("hold", .string(holdPolicy.text))
        ]
        // Only what the boot could read: an absent key is "not measured",
        // never a guessed value.
        if let hw { fields.append(JSONMember("hw", .string(hw))) }
        if let os { fields.append(JSONMember("os", .string(os))) }
        if let lowPower { fields.append(JSONMember("lowPower", .bool(lowPower))) }
        if let thermal { fields.append(JSONMember("thermal", .string(thermal))) }
        if let availMb { fields.append(JSONMember("availMb", .number(Double(availMb)))) }
        return DiagEntry(kind: BuildRow.kind, fields: fields)
    }
}
