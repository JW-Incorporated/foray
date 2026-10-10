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
///     skip: it would otherwise publish an empty table as a result). The one
///     skip: the play-from-zero probe's TAP proved compromised twice running
///     (`delayVerdict`), which is the rig not listening, and is never a miss
///     on a clean tap;
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
        /// What AVFoundation reports after the seek (it reports the request).
        let currentTimeAfterSeekSec: Double
        let delaySec: Double
        /// The label of the landing run's first buffer: where AVFoundation said
        /// the first sample the listener hears was.
        let runLabelSec: Double?
        /// Where that first sample really was (ClickRuler.runStart).
        let runStartSec: Double?
        /// runStart - requested: positive = the listener starts LATE (misses the
        /// start of the segment), negative = EARLY (hears what precedes it).
        let landingErrorSec: Double?
        let markSec: Double?
        let ambiguous: Bool
        let residualSec: Double?
        let clicksHeard: Int
        let minPeak: Float?
        /// The landing run's first onsets, [seconds into the run, peak], so a
        /// weak or missing click after a seek can be read back from the log.
        let firstEvents: [[Double]]
        let discontinuities: Int
        let invalidRanges: Int
        let tapFormat: String
        let runAnchors: [Double]
        let maxLabelDriftSec: Double
        let state: String
    }

    func testInPointLandingErrorAndTimeToReadyPreciseVsApproximate() throws {
        let descriptor = try ClickTrackDescriptor.load()
        var rows: [[String]] = []
        var delays: [String] = []
        var tapFormats: Set<String> = []
        var worstDriftSec = 0.0
        var compromised: [String] = []
        for fixture in descriptor.fixtures {
            let url = try descriptor.url(of: fixture)
            /* THE DECODER'S DELAY, counted from the stream's first sample
               (ClickRuler.swift, step 3). For the WAV it must come out at the
               detector's one-sample bias (0.125 ms): that is the end-to-end
               check that counting frames is right. For an MP3 it is the encoder
               delay as AVFoundation's decoder presents it.
               A probe whose TAP was compromised (buffers without a source time
               beyond the routine leading one, a jump in the counted timeline,
               or a playhead that stalled) gets one retry; see `delayVerdict`. */
            let first = try streamDelay(url, descriptor: descriptor)
            var retry: StreamDelayProbe?
            var verdict = Self.delayVerdict(first)
            if verdict == .retry {
                retry = try streamDelay(url, descriptor: descriptor)
                verdict = Self.delayVerdict(first, retry: retry)
            }
            let delay = retry ?? first
            var delayNote = "\(fixture.file): delay \(ms(delay.delaySec)) ms from the stream's first sample "
                + "(that run's first label: \(ms(delay.runLabelSec)) ms)"
            if retry != nil {
                delayNote += "; retried, the first probe's tap was compromised: \(first.compromise ?? "-")"
            }
            delays.append(delayNote)
            let delaySec: Double
            switch verdict {
            case .measured(let sec):
                delaySec = sec
            case .fault(let why):
                XCTFail("\(fixture.file): \(why)")
                continue
            case .compromised(let why):
                compromised.append("\(fixture.file): \(why)")
                continue
            case .retry:
                XCTFail("\(fixture.file): a retried probe asked for a third try (delayVerdict never should)")
                continue
            }

            for precise in [true, false] {
                for requested in Self.inPointsSec where requested + 2 < fixture.durationSec {
                    let trial = try measureInPoint(
                        url, fixture: fixture.file, precise: precise, requestedSec: requested,
                        delaySec: delaySec, descriptor: descriptor)
                    MeasurementReport.json(trial)
                    tapFormats.insert(trial.tapFormat)
                    worstDriftSec = max(worstDriftSec, trial.maxLabelDriftSec)
                    XCTAssertNotNil(trial.landingErrorSec,
                        "\(fixture.file) \(trial.mode) @\(requested): no landing measured: \(trial.state)")
                    let landing: String = ms(trial.landingErrorSec) + (trial.ambiguous ? " (ambiguous)" : "")
                    let label: Double? = trial.runLabelSec.map { $0 - requested }
                    let finished: String = "\(trial.timing.seekFinished)/\(trial.timing.prerollFinished)"
                    var row: [String] = [fixture.file, trial.mode, String(format: "%.2f", requested), landing]
                    row.append(ms(label))
                    row.append(ms(trial.currentTimeAfterSeekSec - requested))
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
            columns: ["fixture", "timing", "in-point s", "landing error ms (first sample heard - in-point)",
                      "first buffer's label - in-point ms", "currentTime - in-point ms",
                      "ready total ms", "asset ms", "ready ms", "seek ms", "preroll ms",
                      "seek/preroll finished", "ruler residual ms"],
            rows: rows,
            notes: delays + compromised.map { "NOT MEASURED, the tap was compromised twice: \($0)" } + [
                "Seeks are zero-tolerance; 'precise' is AVURLAssetPreferPreciseDurationAndTimingKey=true.",
                "Landing error: where the first sample the listener hears really is, minus the in-point. It is COUNTED in frames back from the first double click after the landing (a whole ten seconds of content) and the file's decoder delay; no buffer label enters it. Positive = the listener starts late, negative = early (they hear audio from before the in-point).",
                "Tap format: \(tapFormats.sorted().joined(separator: "; ")). Worst label-vs-count drift in any trial: \(ms(worstDriftSec)) ms.",
                "Local files on a Simulator: DV-5 repeats this on real CDNs in M2.",
            ])
        /* A tap compromised on both plays from zero is the rig failing to
           listen, not AVFoundation mis-measuring: skip, with both probes'
           states. Never over a real failure: if anything above already failed,
           that failure is the result (the table notes still carry the skip). */
        if !compromised.isEmpty, testRun?.hasSucceeded ?? true {
            throw XCTSkip("the click tap was compromised twice playing from zero, so these fixtures went unmeasured: "
                + compromised.joined(separator: " | "))
        }
    }

    /// One play-from-zero probe (`streamDelay`): what it heard, and whether the
    /// tap it heard through can be trusted.
    ///
    /// WHY THIS EXISTS (release #72 refused, ios-kit run 37982836770): the
    /// probe failed with `timeControlStatus=0 waiting=- rate=0.0 t=1.879
    /// itemError=- tapBuffers=24 invalidRanges=1 unsupportedFormat=false
    /// tapRate=16000.0 events=1`. The `rate=0.0` was the probe's own pause (the
    /// state was read after it); the player did play. `invalidRanges=1` was NOT
    /// the signal: one leading buffer with no source time is what a healthy tap
    /// shows (`invalidRangesBaseline`). The table note for that probe read
    /// `click-cbr.mp3: delay - ms ... (that run's first label: -23.2 ms)`, and
    /// a label is only reported when `first()` found an onset, so an onset WAS
    /// found and lay 0.5 s or more past where the first click was authored: the
    /// first click went unheard on a tap with no gap, no jump and no stall.
    /// That stays a FAIL here (`run37982836770` in the verdict test), and its
    /// root cause is still open. What this adds: the player's state is read
    /// BEFORE the pause, the report tells "nothing heard" from "heard, out of
    /// tolerance", and only a tap that really was compromised (a gap after the
    /// run began, a jump, a stall) earns one retry and then a skip.
    struct StreamDelayProbe {
        /// The decoder delay: the first onset's delay when it lies within
        /// `delayToleranceSec` of where the first click was authored.
        let delaySec: Double?
        /// The first onset's delay, in tolerance or not; nil = nothing heard.
        let rawDelaySec: Double?
        let runLabelSec: Double?
        /// The player as it was when the spin ended, BEFORE the probe paused it.
        let played: MeasuredDeck.PlayState
        /// Where the playhead was when play was asked for.
        let startSec: Double
        /// Wall time spun with the player asked to play.
        let spunSec: Double
        let invalidRanges: Int
        let discontinuities: Int
        /// `MeasuredDeck.stateDescription()`, read after the pause.
        let state: String

        static let delayToleranceSec = 0.5
        /// "Well short": a playhead this far behind the wall clock stalled. A
        /// prerolled local file starts in tens of milliseconds.
        static let playheadShortfallSec = 1.0
        /// The invalid ranges a HEALTHY tap shows: the leading buffer arrives
        /// with no source time and `BufferTimeline.place` drops it before the
        /// run is anchored (which is why such runs anchor 23.2 ms before the
        /// request). In run 37982836770, 29 of the 34 trials that measured
        /// cleanly logged `invalidRanges:1` and the other 5 logged 0; all 34
        /// logged `discontinuities:0`. So only invalid ranges BEYOND this one
        /// are a gap in the tap. (ClickTap counts every invalid range alike; a
        /// counter of the ones after the anchor would be exact, and is not in
        /// this file's reach.)
        static let invalidRangesBaseline = 1

        var foundOnset: Bool { rawDelaySec != nil }
        var advancedSec: Double { played.currentSec - startSec }

        /// Why the tap's evidence cannot be trusted, or nil when it heard the
        /// stream whole. The player's paused state is NOT a reason: every miss
        /// ends paused.
        var compromise: String? {
            var why: [String] = []
            if invalidRanges > Self.invalidRangesBaseline {
                why.append("invalidRanges=\(invalidRanges) (tap buffers with no source time, beyond the leading one)")
            }
            if discontinuities > 0 { why.append("discontinuities=\(discontinuities) (the counted timeline jumped)") }
            if spunSec - advancedSec > Self.playheadShortfallSec {
                why.append(String(format: "the playhead advanced %.3f s in %.3f s of wall time", advancedSec, spunSec))
            }
            return why.isEmpty ? nil : why.joined(separator: ", ")
        }

        /// What was missing: nothing heard, or a first click found but out of tolerance.
        var miss: String {
            guard let raw = rawDelaySec else { return "no click heard playing from zero" }
            return "a first click was heard playing from zero, but \(ms(raw)) ms from where it was authored "
                + "(the delay must be within \(ms(Self.delayToleranceSec)) ms)"
        }

        var report: String {
            "before the pause: timeControlStatus=\(played.timeControlStatus.rawValue) rate=\(played.rate) "
                + String(format: "t=%.3f after %.3f s of wall time from t=%.3f", played.currentSec, spunSec, startSec)
                + "; after it: \(state)"
        }
    }

    enum DelayVerdict: Equatable {
        case measured(Double)
        /// The tap was clean and no in-tolerance first click was found: a real fault.
        case fault(String)
        /// The tap was compromised: probe once more.
        case retry
        /// The tap was compromised on the retry too: the rig did not listen.
        case compromised(String)
    }

    /// The probe's verdict. Only the tap's own evidence earns a retry or a
    /// skip; a clean miss fails, first time or second.
    static func delayVerdict(_ first: StreamDelayProbe, retry: StreamDelayProbe? = nil) -> DelayVerdict {
        let last = retry ?? first
        if let delaySec = last.delaySec { return .measured(delaySec) }
        let earlier: String = retry == nil ? "" : " (the retry; the first probe: \(first.miss): \(first.report))"
        guard last.compromise != nil else { return .fault("\(last.miss): \(last.report)\(earlier)") }
        guard retry != nil else { return .retry }
        return .compromised("first probe: \(first.miss): \(first.report) || retry: \(last.miss): \(last.report)")
    }

    /// Plays from zero and counts, from the stream's first sample, to the first
    /// click (authored at `firstClickSec`).
    private func streamDelay(_ url: URL, descriptor: ClickTrackDescriptor) throws -> StreamDelayProbe {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        _ = try deck.load(url, precise: true, seekToSec: nil, rate: 1)
        let startSec = deck.currentSec
        let spinStart = Date()
        deck.player.playImmediately(atRate: 1)
        let first: () -> (event: ClickEvent, anchor: Double)? = {
            let snapshot = deck.recorder.snapshot()
            for event in snapshot.events where snapshot.runAnchors.indices.contains(event.run) {
                let anchor = snapshot.runAnchors[event.run]
                if event.countedSec - anchor >= descriptor.firstClickSec - 0.5 { return (event, anchor) }
            }
            return nil
        }
        spin(timeoutSec: descriptor.firstClickSec + 3) { first() != nil }
        /* Read the player BEFORE pausing it: after, rate=0 is the pause. */
        let spunSec = Date().timeIntervalSince(spinStart)
        let played = deck.playState()
        deck.player.pause()
        let found = first()
        let snapshot = deck.recorder.snapshot()
        let raw: Double? = found.map {
            ClickRuler.delay(firstClickCountedSec: $0.event.countedSec, runAnchorSec: $0.anchor,
                             firstClickSec: descriptor.firstClickSec)
        }
        return StreamDelayProbe(
            delaySec: raw.flatMap { abs($0) < StreamDelayProbe.delayToleranceSec ? $0 : nil },
            rawDelaySec: raw,
            runLabelSec: found?.anchor,
            played: played,
            startSec: startSec,
            spunSec: spunSec,
            invalidRanges: snapshot.invalidRanges,
            discontinuities: snapshot.discontinuities,
            state: deck.stateDescription())
    }

    /// The verdict, on probes built by hand, no player. Run 37982836770's
    /// probe, rebuilt from what it logged, is the first case, and it FAILS.
    /// MUTATIONS this kills: drop any one of `compromise`'s three clauses;
    /// count the routine leading invalid range (`invalidRanges > 0`, or
    /// `invalidRangesBaseline = 0`); excuse a real gap (`invalidRanges > 2`);
    /// retry or skip on `timeControlStatus != .playing && rate == 0` (or on any
    /// miss); fail instead of retrying a compromised first probe; retry a
    /// second time; let a compromised first probe excuse a clean retry's miss;
    /// report an out-of-tolerance onset as "no click heard".
    func testDelayVerdictRetriesOnlyACompromisedTapAndFailsACleanMiss() {
        func probe(raw: Double? = nil, label: Double = 0, status: AVPlayer.TimeControlStatus = .playing,
                   rate: Float = 1, at currentSec: Double = 3.95, spun: Double = 4.0,
                   invalid: Int = 0, jumps: Int = 0, state: String = "after") -> StreamDelayProbe {
            StreamDelayProbe(
                delaySec: raw.flatMap { abs($0) < StreamDelayProbe.delayToleranceSec ? $0 : nil },
                rawDelaySec: raw, runLabelSec: raw == nil ? nil : label,
                played: MeasuredDeck.PlayState(timeControlStatus: status, rate: rate, currentSec: currentSec),
                startSec: 0, spunSec: spun, invalidRanges: invalid, discontinuities: jumps, state: state)
        }
        /* Run 37982836770 as it was logged: "first label: -23.2 ms", so an
           onset WAS found, and `first()` only returns onsets at or past
           firstClickSec - 0.5, so out of tolerance means +0.5 s or more (the
           exact value was not logged; 0.86 s stands in). The spin ends when
           that onset is found, so wall time ~ the 1.879 s playhead.
           invalidRanges=1 is the healthy baseline; the tap's discontinuities
           were not logged, and the event sat in run 0, so no jump preceded it.
           No clause catches it: a clean tap missed the first click. That is a
           real FAIL, and its root cause is still open. */
        let run37982836770 = probe(raw: 0.86, label: -0.0232, at: 1.879, spun: 1.92, invalid: 1,
                                   state: "run-37982836770")
        XCTAssertNil(run37982836770.compromise)
        guard case .fault(let logged) = Self.delayVerdict(run37982836770) else {
            return XCTFail("run 37982836770's probe was a clean tap's out-of-tolerance click: it must fail")
        }
        XCTAssertTrue(logged.hasPrefix("a first click was heard playing from zero, but 860.0 ms"), logged)
        /* The healthy baseline is no compromise; one more is a gap. */
        guard case .fault(_) = Self.delayVerdict(probe(invalid: 1)) else {
            return XCTFail("one leading invalid range is what a healthy tap shows: a miss on it must fail")
        }
        XCTAssertEqual(Self.delayVerdict(probe(invalid: 2)), .retry)
        /* Each clause alone compromises a probe. */
        XCTAssertEqual(Self.delayVerdict(probe(jumps: 1)), .retry)
        XCTAssertEqual(Self.delayVerdict(probe(at: 1.879)), .retry)
        XCTAssertNil(probe(at: 3.2).compromise, "0.8 s behind the wall clock is start-up, not a stall")
        /* A clean tap's miss fails, even though the player reads paused at rate 0. */
        let cleanSilence = probe(status: .paused, rate: 0, invalid: 1)
        guard case .fault(let silent) = Self.delayVerdict(cleanSilence) else {
            return XCTFail("a clean tap that heard nothing must fail: \(Self.delayVerdict(cleanSilence))")
        }
        XCTAssertTrue(silent.hasPrefix("no click heard playing from zero"), silent)
        XCTAssertTrue(silent.contains("timeControlStatus=0 rate=0.0"), silent)
        guard case .fault(let late) = Self.delayVerdict(probe(raw: 0.75)) else {
            return XCTFail("a clean tap's out-of-tolerance click must fail")
        }
        XCTAssertTrue(late.hasPrefix("a first click was heard playing from zero, but 750"), late)
        XCTAssertNil(probe(raw: 0.75).delaySec)
        XCTAssertTrue(probe(raw: 0.75).foundOnset)
        /* The retry decides. */
        let gapped = probe(invalid: 3, state: "gapped-first")
        XCTAssertEqual(Self.delayVerdict(gapped), .retry)
        XCTAssertEqual(Self.delayVerdict(gapped, retry: probe(raw: 0.0425, invalid: 1)), .measured(0.0425))
        guard case .fault(let afterRetry) = Self.delayVerdict(gapped, retry: probe(invalid: 1)) else {
            return XCTFail("a clean retry that heard nothing must fail")
        }
        XCTAssertTrue(afterRetry.contains("gapped-first"), afterRetry)
        guard case .compromised(let both) = Self.delayVerdict(gapped, retry: probe(jumps: 2, state: "the-retry")) else {
            return XCTFail("compromised twice must skip, not retry again or fail")
        }
        XCTAssertTrue(both.contains("gapped-first") && both.contains("the-retry"), both)
        /* A measured first probe needs no retry, compromised or not. */
        XCTAssertEqual(Self.delayVerdict(probe(raw: 0.000125, invalid: 3)), .measured(0.000125))
    }

    private func measureInPoint(
        _ url: URL, fixture: String, precise: Bool, requestedSec: Double,
        delaySec: Double, descriptor: ClickTrackDescriptor
    ) throws -> InPointTrial {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        let timing = try deck.load(url, precise: precise, seekToSec: requestedSec, rate: 1)
        let afterSeek = deck.currentSec
        /* The landing run is one that STARTED near where AVFoundation believes
           it landed; a run pulled from 0 before the seek is not evidence. */
        let landingDouble: () -> (click: RulerClick, anchor: Double)? = {
            let snapshot = deck.recorder.snapshot()
            let clicks = ClickRuler.group(snapshot.events, doubleGapSec: descriptor.doubleGapSec)
            for click in clicks where click.isDouble && snapshot.runAnchors.indices.contains(click.run) {
                let anchor = snapshot.runAnchors[click.run]
                if abs(anchor - afterSeek) < 1.0 { return (click, anchor) }
            }
            return nil
        }
        deck.player.playImmediately(atRate: 1)
        spin(timeoutSec: descriptor.doubleEverySec + 2) { landingDouble() != nil }
        /* A little more, so the residual has single clicks after the double. */
        spin(timeoutSec: 1.2) { false }
        deck.player.pause()

        let snapshot = deck.recorder.snapshot()
        let clicks = ClickRuler.group(snapshot.events, doubleGapSec: descriptor.doubleGapSec)
        let found = landingDouble()
        let start: ClickRuler.RunStart? = found.map {
            ClickRuler.runStart(doubleCountedSec: $0.click.countedSec, runAnchorSec: $0.anchor,
                                delaySec: delaySec, doubleEverySec: descriptor.doubleEverySec)
        }
        var residual: Double?
        if let found, let start {
            residual = ClickRuler.residualSec(clicks, run: found.click.run, runAnchorSec: found.anchor,
                                              start: start, delaySec: delaySec)
        }
        let run: Int? = found?.click.run
        let heard = snapshot.events.filter { $0.run == run }
        let anchor: Double = found?.anchor ?? 0
        return InPointTrial(
            fixture: fixture,
            mode: precise ? "precise" : "approximate",
            requestedSec: requestedSec,
            timing: timing,
            currentTimeAfterSeekSec: afterSeek,
            delaySec: delaySec,
            runLabelSec: found?.anchor,
            runStartSec: start?.startSec,
            landingErrorSec: start.map { $0.startSec - requestedSec },
            markSec: start?.markSec,
            ambiguous: start?.ambiguous ?? false,
            residualSec: residual,
            clicksHeard: heard.count,
            minPeak: heard.map(\.peak).min(),
            firstEvents: heard.prefix(8).map { [$0.countedSec - anchor, Double($0.peak)] },
            discontinuities: snapshot.discontinuities,
            invalidRanges: snapshot.invalidRanges,
            tapFormat: snapshot.format,
            runAnchors: snapshot.runAnchors,
            maxLabelDriftSec: snapshot.maxLabelDriftSec,
            state: deck.stateDescription())
    }

    // MARK: - (3) does an approximate seek follow an Info frame's TOC? (measurements §13)

    /// THE QUESTION P-7's CBR EXEMPTION WAITS ON (M2 drive, 2026-10-01). Every
    /// Practical AI clip source is CBR 128 kbps behind a LAME/Lavc "Info"
    /// frame, which carries a 100-entry TOC like a VBR file's Xing frame. A
    /// precise load reads the whole file (the drive: 43.9 MB, 21 s, not
    /// ready). An approximate one lands within a frame IF AVFoundation does
    /// CBR byte arithmetic, and seconds off IF it follows the Info TOC: that
    /// TOC is quantised to 1/256 of the file, 10.6 s on a 45-minute episode.
    ///
    /// click-cbr.mp3 has no header frame, so §7.3's CBR rows cannot say. Here
    /// its frames go behind an Info frame built the way LAME builds one, once
    /// with the TOC it should carry and once with every entry pushed 7/256 of
    /// the file LATER. If approximate seeks follow the TOC, the skewed file
    /// lands about +2.5 s late (7/256 of 180 KB at 2 KB/s); if they do byte
    /// arithmetic, both files land where click-cbr.mp3 does. Precise is the
    /// control. Reported, not asserted (beyond "the rig measured something"):
    /// the row decides `EngineConfig.approximateCBRClips`.
    func testWhetherAnApproximateSeekFollowsAnInfoFramesTOC() throws {
        let descriptor = try ClickTrackDescriptor.load()
        guard let fixture = descriptor.fixtures.first(where: { $0.kind == "mp3-cbr" }) else {
            return XCTFail("no mp3-cbr fixture in the descriptor")
        }
        let cbr = try Data(contentsOf: descriptor.url(of: fixture))
        var rows: [[String]] = []
        var notes: [String] = []
        var preciseLandings = 0
        for (name, skew) in [("info-toc", 0), ("info-toc-skewed+7", 7)] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("click-cbr-\(name).mp3")
            try Self.infoTagged(cbr, tocSkew: skew).write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            let delay = try streamDelay(url, descriptor: descriptor)
            guard let delaySec = delay.delaySec else {
                notes.append("\(name): \(delay.miss): \(delay.report)")
                continue
            }
            notes.append("\(name): delay \(ms(delaySec)) ms from the stream's first sample")
            for precise in [true, false] {
                for requested in [19.65, 49.65, 69.65] {
                    do {
                        let trial = try measureInPoint(url, fixture: "click-cbr-\(name).mp3", precise: precise,
                                                       requestedSec: requested, delaySec: delaySec, descriptor: descriptor)
                        MeasurementReport.json(trial, tag: "NE-25a-info")
                        if precise, trial.landingErrorSec != nil { preciseLandings += 1 }
                        rows.append([name, trial.mode, String(format: "%.2f", requested),
                                     ms(trial.landingErrorSec) + (trial.ambiguous ? " (ambiguous)" : ""),
                                     String(format: "%.3f", trial.timing.durationSec),
                                     msValue(trial.timing.totalMs), ms(trial.residualSec)])
                    } catch {
                        rows.append([name, precise ? "precise" : "approximate", String(format: "%.2f", requested),
                                     "load failed: \(error)", "-", "-", "-"])
                    }
                }
            }
        }
        MeasurementReport.table(
            title: "NE-25a (3): does an approximate seek follow an Info frame's TOC? (P-7's CBR exemption)",
            columns: ["file", "timing", "in-point s", "landing error ms", "duration s (asset)", "ready total ms",
                      "ruler residual ms"],
            rows: rows,
            notes: notes + [
                "click-cbr.mp3 (CBR 16 kbit/s, 16 kHz mono) behind a 32 kbit/s Info frame (frames, bytes, TOC), the smallest MPEG-2 frame the tag fits in, as LAME does for a low-bitrate CBR file.",
                "info-toc-skewed+7: every TOC entry after the first is 7/256 of the file later than the frame it should point at. Following the TOC lands about +2.5 s late; byte arithmetic lands as info-toc does.",
                "Reading it: approximate info-toc-skewed+7 near 0 ms => AVFoundation does CBR arithmetic, and EngineConfig.approximateCBRClips can turn on. Near +2500 ms => it follows the TOC, and the exemption must stay off (an Info TOC is up to 1/256 of the file off: 10.6 s at 45 minutes).",
            ],
            tag: "NE-25a-info")
        XCTAssertGreaterThan(preciseLandings, 0, "the precise control measured nothing: the Info-tagged file is broken, not the question answered")
    }

    /// click-cbr.mp3 (MPEG-2 Layer III, 16 kHz mono, 72-byte frames) behind a
    /// LAME-style Info frame: frame count, byte count and a 100-entry TOC,
    /// entry i = the byte of the frame at i% of the stream, in 256ths of the
    /// file, plus `tocSkew` for every entry after the first (capped at 255).
    static func infoTagged(_ cbr: Data, tocSkew: Int) -> Data {
        let frameBytes = 72
        let frames = cbr.count / frameBytes
        // 32 kbit/s at 16 kHz: 72 * 32000 / 16000 = 144 bytes, room for
        // 4 (header) + 9 (mono side info) + 120 (the tag).
        let headerSize = 144
        let total = headerSize + cbr.count
        var tag = Data(count: headerSize)
        tag[0] = cbr[0]
        tag[1] = cbr[1]
        tag[2] = (4 << 4) | (cbr[2] & 0x0C)
        tag[3] = cbr[3]
        var at = 4 + 9
        func put(_ bytes: [UInt8]) {
            for byte in bytes { tag[at] = byte; at += 1 }
        }
        func u32(_ value: Int) -> [UInt8] {
            [UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)]
        }
        put(Array("Info".utf8))
        put(u32(0x7))
        put(u32(frames))
        put(u32(total))
        for i in 0..<100 {
            let byte = headerSize + (i * frames / 100) * frameBytes
            let entry = (byte * 256) / total + (i == 0 ? 0 : tocSkew)
            put([UInt8(min(255, entry))])
        }
        return tag + cbr
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
