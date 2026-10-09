package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointLayer;
import ai.jwlabs.foura.engine.EngineCommand;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.AfterClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-25's measurements: where the ExoPlayer deck really lands an IN-POINT, and how far
 * past an OUT-POINT it really stops, on NE-25a's click tracks, the files the iOS
 * InOutPointMeasurementTests measure (same in-points, same out-point, same lead-in, same rates).
 *
 * <p>WHAT THIS MEASURES, AND WHAT IT DOES NOT. The player is media3-test-utils' on a
 * {@code FakeClock}, with a renderer that consumes samples by timestamp instead of an audio
 * track. So the numbers are Media3's own logic, exactly as it runs on a phone (the extractors,
 * their seek maps, the playback loop's 10 ms work cadence, positioned-message delivery, the
 * deck's timers), in VIRTUAL time, over a local file. They are not a device's audio latency
 * or a CDN's; the emulator legs (A-26/A-30) and the device pass after A-42 are.
 *
 * <p>ASSERTED, one-sided, as on iOS: every trial produced a measurement (a silent rig is a
 * failure, not an empty table), and NEVER EARLY: no out-point stop, and no settled playhead,
 * before the out-point (1 ms of slack for millisecond positions). Where the file has an EXACT
 * seek map (constant-bitrate MP3, PCM WAV) the in-point is also held to [0, one sample] late. The
 * rest is reported: printed as {@code A25-json} lines, and written to
 * {@code $ART/a25-deck-measurements.json} (android-build's evidence artefact) or, without
 * {@code ART}, to {@code build/a25-deck-measurements.json}. docs/android-emulator-measurements.md
 * §8 carries the numbers with the run id.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ExoDeckMeasurementTest {
    /** Each is 0.35 s before a double click (iOS's in-points). */
    static final double[] IN_POINTS_SEC = {9.65, 19.65, 49.65, 79.65};
    /** 5 ms after a whole-second click, inside the WAV's 60 s too. */
    static final double OUT_POINT_SEC = 55.005;
    /** Playback starts this long before the out-point: past the watchdog's window at both rates. */
    static final double LEAD_IN_SEC = 4.0;
    static final double[] RATES = {1.0, 2.0};
    static final double NEVER_EARLY_TOLERANCE_SEC = 0.001;
    /** How much of the landing is heard and matched: long enough to hold a double click. */
    static final double HEARD_WINDOW_SEC = 12.0;
    /** One MPEG-2 layer III frame at 16 kHz (576 samples): one MP3 sample. */
    static final double MP3_FRAME_SEC = 576.0 / 16000;
    /** One WAV sample: WavExtractor writes PCM in tenth-of-a-second runs. */
    static final double WAV_CHUNK_SEC = 0.1;

    private static final List<JSONObject> IN_TRIALS = new ArrayList<>();
    private static final List<JSONObject> OUT_TRIALS = new ArrayList<>();

    private static List<Set<OutPointLayer>> layerSets() {
        List<Set<OutPointLayer>> sets = new ArrayList<>();
        sets.add(EnumSet.of(OutPointLayer.BOUNDARY));
        sets.add(EnumSet.of(OutPointLayer.WATCHDOG));
        sets.add(EnumSet.of(OutPointLayer.BOUNDARY, OutPointLayer.WATCHDOG));
        return sets;
    }

    private static boolean exactSeekMap(ClickTracks.Fixture f) {
        return f.kind.equals("mp3-cbr") || f.isWav();
    }

    @Test
    public void inPointLanding() throws Exception {
        int trials = 0;
        for (ClickTracks.Fixture fixture : ClickTracks.fixtures()) {
            for (boolean precise : new boolean[] {false, true}) {
                for (double requested : IN_POINTS_SEC) {
                    double window = Math.min(HEARD_WINDOW_SEC, fixture.durationSec - requested - 0.5);
                    if (window < 10.5) continue;
                    trials++;
                    measureInPoint(fixture, precise, requested, window);
                }
            }
        }
        assertTrue("the in-point rig ran no trial", trials > 0);
    }

    private void measureInPoint(ClickTracks.Fixture fixture, boolean precise, double requested, double window) throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            // 2x halves the virtual playback the heard window takes; where a load lands does not depend on the rate.
            h.deck.send(new DeckCommand.SetRate(2.0));
            h.deck.send(new DeckCommand.Load(1, "ep-1", fixture.uri().toString(), requested, precise));
            DeckEvent.Ready ready = h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.deck.reading().positionSec >= requested + window || h.find(DeckEvent.Ended.class) != null);
            h.deck.send(DeckCommand.PAUSE);

            List<byte[]> heard = new ArrayList<>();
            long firstLabelUs = Long.MIN_VALUE;
            int decodeOnly = 0;
            for (CapturingAudioRenderer.Sample s : h.renderer.samples()) {
                if (s.decodeOnly) {
                    decodeOnly++;
                    continue;
                }
                if (firstLabelUs == Long.MIN_VALUE) firstLabelUs = s.timeUs;
                if (s.timeUs - firstLabelUs > window * 1_000_000) break;
                heard.add(s.data);
            }
            assertTrue(fixture + " at " + requested + ": nothing was heard", !heard.isEmpty());
            double labelSec = firstLabelUs / 1_000_000.0;
            ClickTracks.Location where = ClickTracks.locate(fixture, heard, labelSec);
            assertNotNull(fixture + (precise ? " precise" : " approximate") + " at " + requested
                    + ": the heard run is nowhere in the file", where);

            double quantizationMs = (labelSec - requested) * 1000;
            double seekMapOffsetMs = (where.trueSec - labelSec) * 1000;
            double errorMs = (where.trueSec - requested) * 1000;
            JSONObject trial = new JSONObject()
                    .put("fixture", fixture.file)
                    .put("kind", fixture.kind)
                    .put("mode", precise ? "precise" : "approximate")
                    .put("requestedSec", requested)
                    .put("landedSec", ready.landedSec())
                    .put("readyVirtualMs", ready.elapsedMs())
                    .put("decodeOnlySamples", decodeOnly)
                    .put("firstHeardLabelSec", round3(labelSec))
                    .put("firstHeardTrueSec", round3(where.trueSec))
                    .put("labelQuantizationMs", round1(quantizationMs))
                    .put("seekMapOffsetMs", round1(seekMapOffsetMs))
                    .put("inPointErrorMs", round1(errorMs))
                    .put("candidates", where.candidates);
            // Recorded before it is judged, so a failing trial is in the report too.
            IN_TRIALS.add(trial);
            System.out.println("A25-json in " + trial);
            assertEquals("the deck reports the start it was asked for", requested, ready.landedSec(), 0.0005);
            if (exactSeekMap(fixture)) {
                // An exact seek map labels every sample with its real place, and the first
                // sample heard is the first WHOLE sample at or after the request: Media3 drops
                // the one the request falls inside (every audio sample is a sync sample), so
                // the in-point is never early and at most one sample late.
                double sampleSec = fixture.isWav() ? WAV_CHUNK_SEC : MP3_FRAME_SEC;
                assertEquals(fixture + " " + trial, 0, seekMapOffsetMs, 0.5);
                assertTrue(fixture + " " + trial, errorMs >= -0.5 && errorMs <= sampleSec * 1000 + 0.5);
            }
        }
    }

    @Test
    public void outPointNeverEarly() throws Exception {
        int trials = 0;
        for (ClickTracks.Fixture fixture : ClickTracks.fixtures()) {
            for (double rate : RATES) {
                for (Set<OutPointLayer> layers : layerSets()) {
                    trials++;
                    measureOutPoint(fixture, rate, layers);
                }
            }
        }
        assertTrue("the out-point rig ran no trial", trials > 0);
    }

    private void measureOutPoint(ClickTracks.Fixture fixture, double rate, Set<OutPointLayer> layers) throws Exception {
        try (DeckHarness h = new DeckHarness(c -> c.outPointLayers = EnumSet.copyOf(layers))) {
            h.deck.send(new DeckCommand.SetRate(rate));
            h.deck.send(new DeckCommand.Load(1, "seg-1", fixture.uri().toString(), OUT_POINT_SEC - LEAD_IN_SEC, true));
            h.await(DeckEvent.Ready.class);
            h.deck.send(new DeckCommand.SetOutPoint(OUT_POINT_SEC));
            h.deck.send(DeckCommand.PLAY);
            DeckEvent.Ended ended = h.await(DeckEvent.Ended.class);
            double atStopSec = h.positionsAtEvent.get(h.events.indexOf(ended));
            h.runFor(500);
            double settledSec = h.deck.reading().positionSec;
            List<EngineCommand.DiagEntry> stops = h.rows("outPoint", "stop");
            int early = h.rows("outPoint", "early").size();
            String what = fixture + " rate " + rate + " layers " + layers;
            assertEquals(what + ": one stop row", 1, stops.size());
            EngineCommand.DiagEntry stop = stops.get(0);
            JSONObject trial = new JSONObject()
                    .put("fixture", fixture.file)
                    .put("kind", fixture.kind)
                    .put("rate", rate)
                    .put("layers", layerNames(layers))
                    .put("outPointSec", OUT_POINT_SEC)
                    .put("stoppedBy", DeckHarness.str(stop, "layer"))
                    .put("overshootMs", DeckHarness.num(stop, "overshootMs"))
                    .put("positionAtStopSec", round3(atStopSec))
                    .put("positionErrorMs", round1((atStopSec - OUT_POINT_SEC) * 1000))
                    .put("settledSec", round3(settledSec))
                    .put("earlyReports", early);
            OUT_TRIALS.add(trial);
            System.out.println("A25-json out " + trial);
            // NEVER EARLY (plan §4.3 P-2): not at the stop, and not once the player settles.
            assertTrue(what + ": stopped early " + trial, atStopSec >= OUT_POINT_SEC - NEVER_EARLY_TOLERANCE_SEC);
            assertTrue(what + ": settled early " + trial, settledSec >= OUT_POINT_SEC - NEVER_EARLY_TOLERANCE_SEC);
            assertTrue(what + ": the overshoot row is never negative", DeckHarness.num(stop, "overshootMs") >= 0);
            assertTrue(what + ": a layer that is off stopped it", layers.contains(layerOf(DeckHarness.str(stop, "layer"))));
        }
    }

    private static OutPointLayer layerOf(String token) {
        for (OutPointLayer layer : OutPointLayer.values()) if (layer.token.equals(token)) return layer;
        throw new AssertionError("no layer " + token);
    }

    private static JSONArray layerNames(Set<OutPointLayer> layers) {
        JSONArray names = new JSONArray();
        for (OutPointLayer layer : layers) names.put(layer.token);
        return names;
    }

    private static double round1(double value) {
        return Math.round(value * 10) / 10.0;
    }

    private static double round3(double value) {
        return Math.round(value * 1000) / 1000.0;
    }

    /** The whole report, once both tests have run (either order; a lone test writes what it has). */
    @AfterClass
    public static void writeReport() throws IOException, JSONException {
        JSONObject report = new JSONObject()
                .put("card", "A-25")
                .put("clock", "media3-test-utils FakeClock (virtual time), Robolectric, local files; "
                        + "the file reads are held out of virtual time (RealIoHold)")
                .put("inPoint", new JSONArray(IN_TRIALS))
                .put("outPoint", new JSONArray(OUT_TRIALS));
        String art = System.getenv("ART");
        File out = art != null && !art.isEmpty() ? new File(art, "a25-deck-measurements.json") : new File("build/a25-deck-measurements.json");
        File parent = out.getAbsoluteFile().getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        Files.write(out.toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8));
        System.out.println(String.format(Locale.ROOT, "A25 measurements: %d in-point and %d out-point trials -> %s",
                IN_TRIALS.size(), OUT_TRIALS.size(), out.getAbsolutePath()));
    }
}
