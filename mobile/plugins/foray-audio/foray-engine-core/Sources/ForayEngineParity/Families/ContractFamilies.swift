import Foundation
import ForayEngineCore

/// The `contract`, `snapshot` and `handshake` families against
/// `EngineContract` (ForayEngineCore/Contract), recorded by NE-11j from
/// `player/engine-contract.js` and ported by NE-11s.
///
/// `contractAccepts(kind, payload)` is answered by DECODING the payload as the
/// engine will (NE-20), not by a second schema interpreter: the families exist
/// so the engine's decoding and the page's validator give the same
/// accept / refuse answer to every example in the schema. The payload reaches
/// the decoder as the ordered `JSONNode` the bridge will hand it
/// (`RowsFamily.node`: an `undefined` member is absent, as JSON has it).
public enum ContractFamily {
    public static let runner = PureFamilyRunner(
        family: "contract",
        module: SessionFamily.module,
        reads: [
            "BRIDGE_METHODS": ContractFamily.names(EngineContract.BridgeMethod.allCases),
            "COMMANDS": ContractFamily.names(EngineContract.CommandName.allCases),
            "EVENTS": ContractFamily.names(EngineContract.EventType.allCases),
            "REFUSALS": ContractFamily.names(EngineContract.Refusal.allCases),
            "READ_KINDS": ContractFamily.names(EngineContract.ReadKind.allCases),
            "CAPABILITIES": ContractFamily.names(EngineContract.Capability.allCases),
            "RELINQUISH_CAPS": ContractFamily.names(EngineContract.RelinquishCap.allCases),
            "OWNED_PREFIXES": SessionFamily.strings(EngineContract.ownedPrefixes),
            "CONTRACT_KINDS": ContractFamily.names(EngineContract.Kind.allCases)
        ],
        calls: ["contractAccepts": ContractFamily.contractAccepts])

    /// `contractAccepts(kind, payload)`: a kind outside CONTRACT_KINDS is a
    /// RangeError (a bug in the caller, not a bad payload).
    static func contractAccepts(_ args: [JSValue]) throws -> CallOutcome {
        guard let kind = ArgReading.arg(args, 0).stringValue.flatMap(EngineContract.Kind.init(rawValue:)) else {
            return .threw("RangeError")
        }
        return .returned(.bool(EngineContract.accepts(kind, RowsFamily.node(ArgReading.arg(args, 1)))))
    }

    static func names<T: RawRepresentable>(_ cases: [T]) -> JSValue where T.RawValue == String {
        SessionFamily.strings(cases.map(\.rawValue))
    }
}

/// The `snapshot` family: the schema's snapshot examples as `contractAccepts`,
/// and `extrapolate` against `EngineContract.extrapolate`.
public enum SnapshotFamily {
    public static let runner = PureFamilyRunner(
        family: "snapshot",
        module: SessionFamily.module,
        reads: [
            "SNAPSHOT_MODES": ContractFamily.names(EngineContract.SnapshotMode.allCases),
            "PLAYER_STATES": ContractFamily.names(EngineContract.PlayerState.allCases),
            "SESSION_PHASES": ContractFamily.names(SessionPolicy.Phase.allCases)
        ],
        calls: [
            "contractAccepts": ContractFamily.contractAccepts,
            "extrapolate": { args in
                // `snapshot?.<field>`: every read of a non-object is undefined.
                // Numbers by `typeof` (the port checks finiteness), flags by `=== true`.
                let s = ArgReading.arg(args, 0)
                return .returned(.number(EngineContract.extrapolate(
                    positionSec: s["positionSec"].numberValue,
                    durationSec: s["durationSec"].numberValue,
                    inSeamGap: s["inSeamGap"] == .bool(true),
                    buffering: s["buffering"] == .bool(true),
                    running: s["running"] == .bool(true),
                    effectiveRate: s["effectiveRate"].numberValue,
                    receivedAtMs: ArgReading.arg(args, 1).numberValue,
                    nowMs: ArgReading.arg(args, 2).numberValue)))
            }
        ])
}

/// The `handshake` family: `helloRequest` and the page's `decideMode` against
/// `EngineContract.helloRequest` and `EngineContract.decidePageMode`.
public enum HandshakeFamily {
    public static let runner = PureFamilyRunner(
        family: "handshake",
        module: SessionFamily.module,
        reads: [
            "PROTOCOL": .number(Double(EngineContract.protocolVersion)),
            "PAGE_MODES": ContractFamily.names(EngineContract.PageMode.allCases),
            "ENGINE_MODES": ContractFamily.names(EngineMode.Mode.allCases),
            "HANDSHAKE_REASONS": ContractFamily.names(EngineContract.HandshakeReason.allCases)
        ],
        calls: [
            "helloRequest": { args in
                // `typeof pageBuild === "string" ? pageBuild : ""`.
                let request = EngineContract.helloRequest(pageBuild: ArgReading.arg(args, 0).stringValue)
                return .returned(.object([
                    "pageBuild": .string(request.pageBuild),
                    "protocol": .number(Double(request.protocolVersion))
                ]))
            },
            "decideMode": { args in
                // `input?.platform !== "ios"`, `input.methodPresent !== true`,
                // and a hello of null or undefined is no answer at all.
                let input = ArgReading.arg(args, 0)
                let hello = input["hello"]
                let decision = EngineContract.decidePageMode(
                    platform: input["platform"].stringValue,
                    methodPresent: input["methodPresent"] == .bool(true),
                    hello: hello.isNullish ? nil : RowsFamily.node(hello))
                return .returned(.object([
                    "mode": .string(decision.mode.rawValue),
                    "reason": .string(decision.reason.rawValue),
                    "relinquish": .bool(decision.relinquish)
                ]))
            }
        ])
}
