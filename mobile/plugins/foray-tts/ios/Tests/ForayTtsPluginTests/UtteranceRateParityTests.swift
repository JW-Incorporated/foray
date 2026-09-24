import XCTest
@testable import ForayTtsPlugin

/// The shipping plugin's `utteranceRate(playbackMultiplier:)` against the
/// `rate` family's utterance-rate cases (native engine plan, card NE-09).
///
/// WHY THIS PLUGIN READS A PARITY FIXTURE. In native mode the engine narrates
/// (its core's `PlaybackRate.utteranceRate`); in legacy mode this plugin does.
/// Both must turn the listener's 1.5x into the SAME `AVSpeechUtterance.rate`,
/// or switching engines changes how fast the narration sounds. The curve is
/// written down once, in `player/playback-rate.js`, and recorded into
/// `player/parity/fixtures/rate/utterance-rate.json`; the core's parity runner
/// holds the engine to that file, and this test holds the plugin to it. This
/// package cannot link the core (it is a separate SwiftPM package with its own
/// graph in the app), so it reads the JSON itself, in place, like the parity
/// wrappers do: a Simulator test process reads the host's filesystem.
///
/// TO SEE IT FAIL: change `calibrationPerceivedMultiple` to 2.0 in
/// ForayTtsPlugin.swift (every stop but 1x moves), or re-record the fixture
/// from a changed JS curve without touching the plugin.
final class UtteranceRateParityTests: XCTestCase {
    /// `player/parity/fixtures/rate/`, found by walking up from this file.
    private func rateFixtureDir() -> URL? {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<16 {
            let candidate = dir.appendingPathComponent("player/parity/fixtures/rate")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    private func load(_ name: String) throws -> [[String: Any]] {
        // Never a skip: a test that silently stopped finding its fixture would
        // read as green forever.
        let dir = try XCTUnwrap(rateFixtureDir(), "no player/parity/fixtures/rate above \(#filePath)")
        let data = try Data(contentsOf: dir.appendingPathComponent(name))
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(doc["cases"] as? [[String: Any]])
    }

    /// A fixture number: plain, or the codec's `{"$num": "NaN" | "Infinity" | ...}`.
    private func number(_ value: Any?) -> Double? {
        if let tagged = value as? [String: Any], let tag = tagged["$num"] as? String {
            switch tag {
            case "NaN": return .nan
            case "Infinity": return .infinity
            case "-Infinity": return -.infinity
            case "-0": return -0.0
            default: return nil
            }
        }
        return (value as? NSNumber)?.doubleValue
    }

    func testThePluginNarratesAtTheFixtureRateForEveryLadderStop() throws {
        let cases = try load("utterance-rate.json").filter { $0["call"] as? String == "utteranceRate" }
        let ladderCase = try load("rate.json").first { $0["id"] as? String == "rate/ladder" }
        let ladder = try XCTUnwrap((ladderCase?["expect"] as? [String: Any])?["value"] as? [Double],
                                   "rate/ladder has no recorded value")
        XCTAssertFalse(ladder.isEmpty)

        var checked: [Double] = []
        for testCase in cases {
            let id = testCase["id"] as? String ?? "?"
            // Only numeric multipliers: the plugin reads `call.getDouble("rate")`,
            // so a string or null never reaches this function as itself.
            guard let args = testCase["args"] as? [Any], let multiplier = number(args.first) else { continue }
            let expect = try XCTUnwrap((testCase["expect"] as? [String: Any])?["return"], "\(id) is unrecorded")
            let want = try XCTUnwrap(number(expect), "\(id): expect is not a number")
            let got = Double(ForayTtsPlugin.utteranceRate(playbackMultiplier: multiplier))
            // The plugin answers a Float (AVSpeechUtterance.rate is one); a
            // Float's step near 0.5 is 6e-8, so 1e-6 is "the same number".
            XCTAssertEqual(got, want, accuracy: 1e-6, "\(id): utteranceRate(\(multiplier))")
            checked.append(multiplier)
        }
        for stop in ladder {
            XCTAssertTrue(checked.contains(stop), "no utteranceRate case for the \(stop)x ladder stop")
        }
    }
}
