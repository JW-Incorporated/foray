import Foundation
import ForayEngineCore

/// The `deck` family (NE-30j's recording; card NE-30s ports it), routed by the
/// fixture FILE's module:
///
///   - `deck-readings.json` (player/deck-policy.js): the deck's guards on what
///     it is handed and what it reports (`deckRate`, `deckSeekTarget`,
///     `deckVolume`, `deckDuration`, `deckReportedRate`) and the in-place
///     seek's deadline and same-source rule (`loadDeadlineMs`,
///     `sameSourceIsSeek`, whose translations are the deck-episode family's);
///   - `deck-slices.json` (scenarios, `setup.target: "deck"`): the native
///     out-point over one deck across consecutive slices, `outPointStep` over
///     runner.js's driven clock (the outpoint family's `DeckWorld`), with the
///     reducer's `ended` event (the file ran out first: one, natural, end);
///   - `deck-pair.json` (player/deck-policy.js too): the warm handover's
///     decisions, which the native DeckPair asks (card NE-32 registered them:
///     `DeckPairFamily.calls`).
public enum DeckFamily {
    public static let module = "player/deck-policy.js"

    public static let runner: FamilyRunner = ModuleRoutedRunner(family: "deck", routes: [
        DeckFamily.module: PureFamilyRunner(
            family: "deck",
            module: DeckFamily.module,
            reads: [:],
            calls: DeckPairFamily.calls.merging([
                "deckRate": DeckFamily.deckRate,
                "deckSeekTarget": DeckFamily.deckSeekTarget,
                "deckVolume": DeckFamily.deckVolume,
                "deckDuration": DeckFamily.deckDuration,
                "deckReportedRate": DeckFamily.deckReportedRate,
                "loadDeadlineMs": DeckEpisodeFamily.loadDeadlineMs,
                "sameSourceIsSeek": DeckEpisodeFamily.sameSourceIsSeek
            ], uniquingKeysWith: { _, single in single })),
        ModuleRoutedRunner.scenarios: DeckSlicesRunner()
    ])

    /// `deckRate(playbackRate)`: `typeof x === "number" && x > 0 ? x : 1`.
    static func deckRate(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.number(DeckPolicy.deckRate(ArgReading.arg(args, 0).numberValue)))
    }

    /// `deckSeekTarget(seconds)`: `typeof` first, so a numeric string is junk.
    static func deckSeekTarget(_ args: [JSValue]) throws -> CallOutcome {
        .returned(ArgReading.numberOrNull(DeckPolicy.deckSeekTarget(ArgReading.arg(args, 0).numberValue)))
    }

    /// `deckVolume(v)`: `Number(v) || 0`, so any value is coerced first.
    static func deckVolume(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.number(DeckPolicy.deckVolume(ArgReading.arg(args, 0).toNumber)))
    }

    /// `deckDuration(d)`: `typeof d === "number" && Number.isFinite(d)`.
    static func deckDuration(_ args: [JSValue]) throws -> CallOutcome {
        .returned(ArgReading.numberOrNull(DeckPolicy.deckDuration(ArgReading.arg(args, 0).numberValue)))
    }

    /// `deckReportedRate({elementRate, pendingRate})`: no default for the
    /// object. The element's rate is taken only as a finite number above 0;
    /// otherwise `pendingRate` comes back exactly as it was handed.
    static func deckReportedRate(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false) else { return .threw("TypeError") }
        // Asked with no pending rate, the port answers only when the
        // element's own rate is usable.
        if let usable = DeckPolicy.deckReportedRate(elementRate: s["elementRate"].numberValue, pendingRate: nil) {
            return .returned(.number(usable))
        }
        return .returned(s["pendingRate"])
    }
}

/// deck-slices.json: `outPointStep` over runner.js `runDeckScenario`'s driven
/// clock, the outpoint family's driver exactly (`DeckWorld`).
struct DeckSlicesRunner: FamilyRunner {
    let family = "deck"

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .scenario else {
            throw HarnessError("E_BAD_CASE", "\(file.path) names no module, so its cases must be scenarios")
        }
        return try DeckWorld.run(testCase, context: context, family: family)
    }
}
