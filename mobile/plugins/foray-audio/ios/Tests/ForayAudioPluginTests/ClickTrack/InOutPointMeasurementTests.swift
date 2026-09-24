import AVFoundation
import XCTest

/// NE-25a (docs/native-engine-plan.md §4.3 and card NE-25a): measure, on the
/// Simulator, where AVFoundation really lands an in-point and how far past an
/// out-point it really stops, against click tracks whose content is a ruler
/// (`tools/audio/make-click-tracks.py`).
///
/// THESE TESTS MEASURE; THEY ASSERT ONLY ONE-SIDED RULES. A Simulator is not a
/// phone and a local file is not a CDN, so no number here is a pass mark
/// (DV-5 repeats the measurement on real CDNs in M2). What IS asserted:
///   - every trial produced a measurement (a silent rig is a failure, not a
///     skip: it would otherwise publish an empty table as a result);
///   - NEVER EARLY: no out-point layer fires, and the player never settles,
///     before the out-point. An early stop cuts content the listener was
///     promised; a late one plays a little of the next thing. The plan's
///     out-point is "never early" (P-2), and this is where that is first
///     checked against the real AVFoundation.
/// Everything else is reported to the job summary and `NE-25a-json` log lines
/// (`MeasurementReport`), and copied into docs/ios-native-engine-measurements.md
/// with the run id.
final class InOutPointMeasurementTests: XCTestCase {
    /// Each is 0.35 s before a double click, so a landing within [-9.65, +0.35] s
    /// of the request hears that double click within a second. WAV (60 s) uses
    /// the ones that fit.
    static let inPointsSec = [9.65, 19.65, 49.65, 79.65]
    /// Where the per-file reference offset is read (see `referenceOffset`).
    static let referenceInPointSec = 9.65
    /// 5 ms after a whole-second click, inside the WAV's 60 s too.
    static let outPointSec = 55.005
    /// Playback starts this long before the out-point: past the watchdog's 1.5 s
    /// lead at both rates, so its one-shot timer is armed for real.
    static let leadInSec = 4.0
    static let rates: [Float] = [1.0, 2.0]

    /// The pad NE-32 adds to `forwardPlaybackEndTime` (`end + stopPad`). Zero
    /// until a measured early stop says otherwise; card NE-25a: "if an early stop
    /// is measured, the doc records it and NE-32's stopPad is set from it".
    static let stopPadSec = 0.0
    /// One millisecond of slack for CMTime rounding on top of the pad, and no
    /// more: `tools/audio/click-tracks.test.mjs` pins both numbers, so loosening
    /// the rule is an edit somebody has to make in two places, on purpose.
    static let neverEarlyToleranceSec = 0.001 + stopPadSec

    enum Layer: String, CaseIterable, Encodable {
        case forwardEnd = "forwardPlaybackEndTime"
        case boundary = "boundaryObserver"
        case watchdog = "windowedWatchdog"
    }

    static let layerSets: [[Layer]] = [[.forwardEnd], [.boundary], [.watchdog], Layer.allCases]

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    // MARK: - (1) in-point landing error and time to ready

    struct InPointTrial: Encodable {
        let fixture: String
        let mode: String
        let requestedSec: Double
        let timing: MeasuredDeck.LoadTiming
        let believedLandingSec: Double
        let contentOffsetSec: Double?
        /// believed - true, from the ruler; nil when no double click was heard.
        let beliefErrorSec: Double?
        /// true landing - requested: positive means the listener starts LATE.
        let landingErrorSec: Double?
        let ambiguous: Bool
        let residualSec: Double?
        let clicksHeard: Int
        let minPeak: Float?
        /// The first onsets after the landing, [believed s, peak], so a weak or
        /// missing click after a seek (an MP3 decoder that was not primed) can
        /// be read back from the log.
        let firstEvents: [[Double]]
        let discontinuities: Int
        let invalidRanges: Int
        let tapFormat: String
        let labelRuns: Int
        let maxLabelDriftSec: Double
        let state: String
    }

    func testInPointLandingErrorAndTimeToReadyPreciseVsApproximate() throws {
        let descriptor = try ClickTrackDescriptor.load()
        var rows: [[String]] = []
        var offsets: [String] = []
        var tapFormats: Set<String> = []
        var worstDriftSec = 0.0
        for fixture in descriptor.fixtures {
            let url = try descriptor.url(of: fixture)
            /* THE REFERENCE (d0). Where this file's content sits on the tap's
               timeline, read after a PRECISE seek to 9.65 s: the double click
               authored at 10 s is labelled 10 + d0. For the WAV that is the
               rig's own bias (detector + resampler); for an MP3 it adds the
               encoder delay as AVFoundation presents it. Every landing below is
               measured against it, so "landing error" means "where this seek
               put the listener, relative to where a precise seek puts them".

               Why not from zero, the obvious choice: the first run (35962279894)
               measured it both ways, and from zero the WAV (sample-exact PCM)
               read 11.1 ms against 0.9 ms after any seek. The labels on the
               first buffers of a stream are not comparable with the labels after
               a seek, so a from-zero reference would put a ~10 ms error into
               every row. The from-zero offset is still reported, as a note. */
            let reference = try measureInPoint(
                url, fixture: fixture.file, precise: true, requestedSec: Self.referenceInPointSec,
                contentOffsetSec: 0, descriptor: descriptor)
            let d0 = reference.beliefErrorSec
            let fromZero = try contentOffset(url, precise: true, descriptor: descriptor)
            let refNote: String = d0 == nil ? " (NOT HEARD: \(reference.state))" : ""
            offsets.append("\(fixture.file): d0 \(ms(d0)) ms after a precise seek to \(Self.referenceInPointSec) s; "
                + "\(ms(fromZero.value)) ms playing from zero\(refNote)")
            XCTAssertNotNil(d0, "\(fixture.file): no double click heard after the reference seek: \(reference.state)")

            for precise in [true, false] {
                for requested in Self.inPointsSec where requested + 2 < fixture.durationSec {
                    let trial = try measureInPoint(
                        url, fixture: fixture.file, precise: precise, requestedSec: requested,
                        contentOffsetSec: d0, descriptor: descriptor)
                    MeasurementReport.json(trial)
                    tapFormats.insert(trial.tapFormat)
                    worstDriftSec = max(worstDriftSec, trial.maxLabelDriftSec)
                    XCTAssertNotNil(trial.landingErrorSec,
                        "\(fixture.file) \(trial.mode) @\(requested): no landing measured: \(trial.state)")
                    let landing: String = ms(trial.landingErrorSec) + (trial.ambiguous ? " (ambiguous)" : "")
                    let finished: String = "\(trial.timing.seekFinished)/\(trial.timing.prerollFinished)"
                    var row: [String] = [fixture.file, trial.mode, String(format: "%.2f", requested), landing]
                    row.append(ms(trial.beliefErrorSec))
                    row.append(ms(trial.believedLandingSec - requested))
                    row.append(msValue(trial.timing.totalMs))
                    row.append(msValue(trial.timing.assetMs))
                    row.append(msValue(trial.timing.readyMs))
                    row.append(msValue(trial.timing.seekMs))
                    row.append(msValue(trial.timing.prerollMs))
                    row.append(finished)
                    row.append(ms(trial.residualSec))
                    rows.append(row)
                }
            }
        }
        MeasurementReport.table(
            title: "NE-25a (1): in-point landing error and time to ready",
            columns: ["fixture", "timing", "in-point s", "landing error ms (true - requested)",
                      "belief error ms (believed - true)", "currentTime - requested ms",
                      "ready total ms", "asset ms", "ready ms", "seek ms", "preroll ms",
                      "seek/preroll finished", "ruler residual ms"],
            rows: rows,
            notes: offsets + [
                "Seeks are zero-tolerance; 'precise' is AVURLAssetPreferPreciseDurationAndTimingKey=true.",
                "Landing error is read from the click track's content, not from currentTime, relative to d0 (where a precise seek to \(Self.referenceInPointSec) s puts that file's content): positive = the listener starts late, negative = early (they hear audio from before the in-point).",
                "The precise \(Self.referenceInPointSec) s row is an independent repeat of the reference, so it reads the repeatability, not 0 by construction.",
                "Tap format: \(tapFormats.sorted().joined(separator: "; ")). Times inside a run are COUNTED from the run's first buffer label (BufferTimeline); the worst label-vs-count drift in any trial was \(ms(worstDriftSec)) ms.",
                "Local files on a Simulator: DV-5 repeats this on real CDNs in M2.",
            ])
    }

    /// Plays from zero and reports where the first click lands relative to where
    /// it was authored. Reported only (see the reference note above).
    private func contentOffset(_ url: URL, precise: Bool, descriptor: ClickTrackDescriptor) throws -> (value: Double?, state: String) {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        _ = try deck.load(url, precise: precise, seekToSec: nil, rate: 1)
        deck.player.playImmediately(atRate: 1)
        let first: () -> ClickEvent? = {
            deck.recorder.snapshot().events.first { $0.believedSec >= descriptor.firstClickSec - 0.5 }
        }
        spin(timeoutSec: descriptor.firstClickSec + 3) { first() != nil }
        deck.player.pause()
        guard let event = first() else { return (nil, deck.stateDescription()) }
        let offset = event.believedSec - descriptor.firstClickSec
        return (abs(offset) < 0.5 ? offset : nil, deck.stateDescription())
    }

    private func measureInPoint(
        _ url: URL, fixture: String, precise: Bool, requestedSec: Double,
        contentOffsetSec: Double?, descriptor: ClickTrackDescriptor
    ) throws -> InPointTrial {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        let timing = try deck.load(url, precise: precise, seekToSec: requestedSec, rate: 1)
        let believedLanding = deck.currentSec
        /* Only what was rendered at or after the landing is evidence about it:
           a buffer pulled from 0 before the seek has a believed time near 0. */
        let from = believedLanding - 0.01
        let d0 = contentOffsetSec ?? 0
        let reading: () -> (errorSec: Double, doubleBelievedSec: Double, ambiguous: Bool)? = {
            let clicks = ClickRuler.group(deck.recorder.snapshot().events, doubleGapSec: descriptor.doubleGapSec)
            return ClickRuler.beliefError(clicks, fromBelievedSec: from, contentOffsetSec: d0,
                                          doubleEverySec: descriptor.doubleEverySec)
        }
        deck.player.playImmediately(atRate: 1)
        spin(timeoutSec: descriptor.doubleEverySec + 2) { reading() != nil }
        /* A little more, so the residual has single clicks after the double. */
        spin(timeoutSec: 1.2) { false }
        deck.player.pause()

        let snapshot = deck.recorder.snapshot()
        let heard = snapshot.events.filter { $0.believedSec >= from }
        let result: (errorSec: Double, doubleBelievedSec: Double, ambiguous: Bool)? =
            contentOffsetSec == nil ? nil : reading()
        let clicks = ClickRuler.group(snapshot.events, doubleGapSec: descriptor.doubleGapSec)
        return InPointTrial(
            fixture: fixture,
            mode: precise ? "precise" : "approximate",
            requestedSec: requestedSec,
            timing: timing,
            believedLandingSec: believedLanding,
            contentOffsetSec: contentOffsetSec,
            beliefErrorSec: result?.errorSec,
            landingErrorSec: result.map { (believedLanding - $0.errorSec) - requestedSec },
            ambiguous: result?.ambiguous ?? false,
            residualSec: result.map {
                ClickRuler.residualSec(clicks, fromBelievedSec: from, errorSec: $0.errorSec, contentOffsetSec: d0)
            },
            clicksHeard: heard.count,
            minPeak: heard.map(\.peak).min(),
            firstEvents: heard.prefix(8).map { [$0.believedSec, Double($0.peak)] },
            discontinuities: snapshot.discontinuities,
            invalidRanges: snapshot.invalidRanges,
            tapFormat: snapshot.format,
            labelRuns: snapshot.runs,
            maxLabelDriftSec: snapshot.maxLabelDriftSec,
            state: deck.stateDescription())
    }

    // MARK: - (2) out-point overshoot, three layers, 1x and 2x, never early

    struct OutPointTrial: Encodable {
        let fixture: String
        let rate: Float
        let layers: [Layer]
        let endSec: Double
        let startBelievedSec: Double
        let fires: [FireLog.Fire]
        let firstLayer: String?
        let settledSec: Double
        let pulledEndSec: Double?
        let watchdogArmDelaySec: Double?
        let watchdogTicks: Int?
        let maxLabelDriftSec: Double
        let state: String
    }

    func testOutPointOvershootAtOneAndTwoTimesAndNeverEarly() throws {
        let descriptor = try ClickTrackDescriptor.load()
        let end = Self.outPointSec
        var rows: [[String]] = []
        var early: [String] = []
        for fixture in descriptor.fixtures where end + 1 < fixture.durationSec {
            let url = try descriptor.url(of: fixture)
            for rate in Self.rates {
                for layers in Self.layerSets {
                    let trial = try measureOutPoint(url, fixture: fixture.file, rate: rate, layers: layers, endSec: end)
                    MeasurementReport.json(trial)
                    let label = "\(fixture.file) \(rate)x [\(layers.map(\.rawValue).joined(separator: "+"))]"

                    XCTAssertFalse(trial.fires.isEmpty, "\(label): no out-point layer fired: \(trial.state)")
                    for fire in trial.fires where fire.mediaSec < end - Self.neverEarlyToleranceSec {
                        early.append("\(label): \(fire.layer) fired at \(fire.mediaSec) s, \(ms(end - fire.mediaSec)) ms EARLY")
                    }
                    if !trial.fires.isEmpty, trial.settledSec < end - Self.neverEarlyToleranceSec {
                        early.append("\(label): settled at \(trial.settledSec) s, \(ms(end - trial.settledSec)) ms EARLY")
                    }

                    func overshoot(_ layer: Layer) -> String {
                        guard layers.contains(layer) else { return "" }
                        guard let fire = trial.fires.first(where: { $0.layer == layer.rawValue }) else { return "did not fire" }
                        return ms(fire.mediaSec - end)
                    }
                    let armed: String = layers.count == Layer.allCases.count ? "all three" : layers[0].rawValue
                    let pulled: Double? = trial.pulledEndSec.map { $0 - end }
                    var row: [String] = [fixture.file, String(format: "%.0fx", Double(rate)), armed, trial.firstLayer ?? "none"]
                    row.append(overshoot(.forwardEnd))
                    row.append(overshoot(.boundary))
                    row.append(overshoot(.watchdog))
                    row.append(ms(trial.settledSec - end))
                    row.append(ms(pulled))
                    row.append(ms(trial.watchdogArmDelaySec))
                    row.append(laterFires(trial))
                    rows.append(row)
                }
            }
        }
        MeasurementReport.table(
            title: "NE-25a (2): out-point overshoot (ms past the out-point; negative = EARLY)",
            columns: ["fixture", "rate", "layers armed", "fired first",
                      "forwardPlaybackEndTime ms", "boundary observer ms", "windowed watchdog ms",
                      "settled currentTime ms", "tap pulled-to ms (upper bound)", "watchdog one-shot delay ms",
                      "later fires (host ms after the first)"],
            rows: rows,
            notes: [
                "Out-point \(end) s, playback started \(Self.leadInSec) s before it, precise timing, zero-tolerance seek.",
                "A layer's number is the player's currentTime when it fired, minus the out-point. The first layer to fire stops playback (forwardPlaybackEndTime by itself; the others by pause()).",
                "The watchdog is armed at play: one timer at (end - t)/rate - 1.5 s, then a 250 ms poll.",
                "'tap pulled-to' is where the render pipeline had PULLED audio to, which is ahead of the speaker: an upper bound on audible overshoot, not the overshoot itself.",
                "Never-early tolerance: \(ms(Self.neverEarlyToleranceSec)) ms (stopPad \(ms(Self.stopPadSec)) ms).",
                early.isEmpty ? "No early stop was measured." : "EARLY STOPS MEASURED: " + early.joined(separator: "; "),
            ])
        XCTAssertEqual(early, [], "an out-point layer stopped EARLY (never-early, plan §4.3 P-2): record it and set NE-32's stopPad from it")
    }

    /// "boundaryObserver +3.1, windowedWatchdog +120.4": how long after the
    /// first layer each other layer reported, on the host clock. It is what
    /// says whether a slower layer is a backstop or merely a duplicate.
    private func laterFires(_ trial: OutPointTrial) -> String {
        guard let first = trial.fires.first else { return "-" }
        let later = trial.fires.dropFirst().map { "\($0.layer) +\(msValue($0.hostMs - first.hostMs))" }
        return later.isEmpty ? "-" : later.joined(separator: ", ")
    }

    private func measureOutPoint(_ url: URL, fixture: String, rate: Float, layers: [Layer], endSec: Double) throws -> OutPointTrial {
        let deck = MeasuredDeck()
        let log = FireLog()
        let watchdog = WindowedWatchdog()
        var boundaryToken: Any?
        var endObserver: NSObjectProtocol?
        defer {
            watchdog.cancel()
            if let boundaryToken { deck.player.removeTimeObserver(boundaryToken) }
            if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
            deck.tearDown()
        }
        _ = try deck.load(url, precise: true, seekToSec: endSec - Self.leadInSec, rate: rate)
        guard let item = deck.item else { throw MeasuredDeck.LoadError.noAudioTrack }
        let player = deck.player
        let startBelieved = deck.currentSec

        /* The first layer to fire wins, as it will per load token in NE-32:
           forwardPlaybackEndTime pauses by itself (actionAtItemEnd = .pause);
           the other two pause the player. Later fires are still recorded. */
        let fired: (Layer, Double) -> Void = { layer, mediaSec in
            if log.record(layer.rawValue, mediaSec: mediaSec), layer != .forwardEnd {
                player.pause()
            }
        }
        if layers.contains(.forwardEnd) {
            item.forwardPlaybackEndTime = cmTime(endSec)
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { _ in
                fired(.forwardEnd, item.currentTime().seconds)
            }
        }
        if layers.contains(.boundary) {
            boundaryToken = player.addBoundaryTimeObserver(forTimes: [NSValue(time: cmTime(endSec))], queue: .main) {
                fired(.boundary, player.currentTime().seconds)
            }
        }

        player.playImmediately(atRate: rate)
        if layers.contains(.watchdog) {
            watchdog.arm(player: player, endSec: endSec, rate: Double(rate)) { mediaSec in
                fired(.watchdog, mediaSec)
            }
        }
        spin(timeoutSec: Self.leadInSec / Double(rate) + 3) { !log.fires.isEmpty }
        /* Let the stop settle, and give the layers that lost a chance to report. */
        spin(timeoutSec: 1.0) { false }
        let settled = deck.currentSec
        let snapshot = deck.recorder.snapshot()
        return OutPointTrial(
            fixture: fixture,
            rate: rate,
            layers: layers,
            endSec: endSec,
            startBelievedSec: startBelieved,
            fires: log.fires,
            firstLayer: log.fires.first?.layer,
            settledSec: settled,
            pulledEndSec: snapshot.pulledEndSec,
            watchdogArmDelaySec: layers.contains(.watchdog) ? watchdog.armDelaySec : nil,
            watchdogTicks: layers.contains(.watchdog) ? watchdog.ticks : nil,
            maxLabelDriftSec: snapshot.maxLabelDriftSec,
            state: deck.stateDescription())
    }
}
