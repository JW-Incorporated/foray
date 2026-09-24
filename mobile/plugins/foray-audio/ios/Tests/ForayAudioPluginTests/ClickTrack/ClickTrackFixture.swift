import Foundation

/// The click tracks' descriptor, `Fixtures/ClickTracks/click-tracks.json`,
/// written by `tools/audio/make-click-tracks.py`. The ruler's numbers (double
/// period, gap, first click) are read from it rather than restated here, so the
/// generator, `tools/audio/click-tracks.test.mjs` and these tests cannot drift.
struct ClickTrackDescriptor: Decodable {
    struct Fixture: Decodable {
        let file: String
        let kind: String
        let durationSec: Double
        let sampleRate: Double
        let bytes: Int
    }

    let firstClickSec: Double
    let doubleEverySec: Double
    let doubleGapSec: Double
    let fixtures: [Fixture]

    /// The fixtures directory, copied whole into the test bundle
    /// (`resources: [.copy("Fixtures/ClickTracks")]` in foray-audio's Package.swift).
    static func directory() throws -> URL {
        guard let url = Bundle.module.url(forResource: "ClickTracks", withExtension: nil) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "ClickTracks is not in the test bundle"])
        }
        return url
    }

    static func load() throws -> ClickTrackDescriptor {
        let data = try Data(contentsOf: directory().appendingPathComponent("click-tracks.json"))
        return try JSONDecoder().decode(ClickTrackDescriptor.self, from: data)
    }

    func url(of fixture: Fixture) throws -> URL {
        try Self.directory().appendingPathComponent(fixture.file)
    }
}
