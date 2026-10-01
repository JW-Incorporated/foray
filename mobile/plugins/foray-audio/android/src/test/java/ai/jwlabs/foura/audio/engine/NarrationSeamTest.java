package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import android.content.Context;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.test.utils.FakeClock;
import androidx.media3.test.utils.TestExoPlayerBuilder;
import androidx.media3.test.utils.robolectric.RobolectricUtil;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-62 (mirrors NE-45s's NarrationSeamTests): the REAL JVM core, through the Android host, over
 * the Foray tape's deck pair of two REAL ExoDecks (two media3-test-utils players on one
 * auto-advancing {@link FakeClock}), on local files: a clip of NE-25a's CBR click track, a RENDERED
 * narration line (a short WAV this test writes), and a clip of the WAV click track.
 *
 * <p>clip, rendered line, clip: the clip's window prepares the line on the standby deck, the
 * line's own window (from its duration: it has no out-point, and it is shorter than the lead, so it
 * opens at the line's first play) prepares the clip after it on the deck the handover demoted, and
 * BOTH seams are handovers: the second clip has no cold load. Each seam packs one row,
 * {@code from=clip to=line prepare=hit} and {@code from=line to=clip prepare=hit}, and at most one
 * player sounds at any time.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class NarrationSeamTest {
    private static ClickTracks.Fixture fixture(String file) {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals(file)) return f;
        throw new AssertionError("no click track " + file);
    }

    private static final ClickTracks.Fixture CBR = fixture("click-cbr.mp3");

    private static ClickTracks.Fixture firstWav() {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.isWav()) return f;
        throw new AssertionError("no WAV click track");
    }

    private static final ClickTracks.Fixture WAV = firstWav();
    /** The rendered line's length: shorter than {@code PREFETCH_LEAD_SEC}, so its window opens at its first play. */
    private static final double LINE_SEC = 8;

    private final Context context = ApplicationProvider.getApplicationContext();
    private final FakeClock clock = new FakeClock(/* isAutoAdvancing= */ true);
    private final List<ExoPlayer> players = new ArrayList<>();
    private final List<EngineCommand.DiagEntry> deckRows = new ArrayList<>();
    private final List<String> lines = new ArrayList<>();
    private DeckPair pair;
    private ForayEngineHost host;
    private File line;
    private int maxPlaying;

    private ExoDeck deck() {
        ExoPlayer player = new TestExoPlayerBuilder(context).setClock(clock).setRenderers(new CapturingAudioRenderer()).build();
        players.add(player);
        ExoDeck.Config config = new ExoDeck.Config();
        config.mediaSources = ExoDeck.progressive(new DefaultDataSource.Factory(context));
        config.diag = deckRows::add;
        config.context = context;
        return new ExoDeck(player, config);
    }

    /** A rendered line: {@code sec} seconds of a 440 Hz tone, 16-bit mono PCM at 16 kHz, in a WAV. */
    private static File writeLine(File dir, double sec) throws IOException {
        int rate = 16_000;
        int samples = (int) Math.round(sec * rate);
        ByteBuffer data = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        data.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(36 + samples * 2)
                .put("WAVE".getBytes(java.nio.charset.StandardCharsets.US_ASCII))
                .put("fmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int i = 0; i < samples; i++) data.putShort((short) Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000));
        File file = new File(dir, "a62-line.wav");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data.array());
        }
        return file;
    }

    @Before
    public void setUp() throws IOException {
        line = writeLine(context.getCacheDir(), LINE_SEC);
        DeckPair.Config config = new DeckPair.Config();
        config.diag = deckRows::add;
        pair = new DeckPair(deck(), deck(), config);
        EngineLog log = new EngineLog(System::currentTimeMillis, lines::add);
        EngineConfig engine = new EngineConfig("test").withForayTape(true, true);
        host = new ForayEngineHost(new EngineSeams(pair, new ForayEngineHostTest.FakeSession(), new HandlerTiming(Looper.getMainLooper()), log),
                engine);
        host.start();
    }

    @After
    public void tearDown() {
        host.teardown();
        pair.invalidate();
        for (ExoPlayer p : players) p.release();
        if (line != null) line.delete();
    }

    private int playing() {
        int n = 0;
        for (ExoPlayer p : players) if (p.isPlaying()) n++;
        return n;
    }

    private void runUntil(BooleanSupplier condition) throws TimeoutException {
        RobolectricUtil.runMainLooperUntil(() -> {
            maxPlaying = Math.max(maxPlaying, playing());
            return condition.getAsBoolean();
        }, 4 * DeckHarness.WAIT_MS, Clock.DEFAULT);
    }

    private static JsonNode clip(int index, String url, double start, double end) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("audio_url", JsonNode.str(url)), JsonNode.member("start_sec", JsonNode.num(start)),
                JsonNode.member("end_sec", JsonNode.num(end)), JsonNode.member("duration_sec", JsonNode.num(90))));
    }

    private static JsonNode renderedLine(int index, String url, double sec) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("tts")),
                JsonNode.member("type", JsonNode.str("narration")), JsonNode.member("audio_url", JsonNode.str(url)),
                JsonNode.member("script", JsonNode.str("A line, rendered.")), JsonNode.member("duration_sec", JsonNode.num(sec)),
                JsonNode.member("duration_source", JsonNode.str("rendered"))));
    }

    /** The core's packed {@code seam} rows, from the engine log's text ring ({@code seq iso kind body}). */
    private List<JsonNode> seamRows() {
        List<JsonNode> seams = new ArrayList<>();
        for (String text : lines) {
            String[] parts = text.split(" ", 4);
            if (parts.length == 4 && parts[2].equals("seam")) seams.add(JsonNode.parse(parts[3]));
        }
        return seams;
    }

    /** The decks' {@code attach} rows (a cold fetch), by token: a standby's warm load has a negative one. */
    private List<Integer> coldAttachTokens() {
        List<Integer> tokens = new ArrayList<>();
        for (EngineCommand.DiagEntry row : deckRows) {
            if (!row.kind().equals("deck")) continue;
            JsonNode kind = row.field("kind");
            JsonNode token = row.field("token");
            if (kind != null && "attach".equals(kind.stringValue()) && token != null && token.numberValue() != null
                    && token.numberValue() > 0) {
                tokens.add(token.numberValue().intValue());
            }
        }
        return tokens;
    }

    private static String text(JsonNode row, String key) {
        JsonNode value = row.get(key);
        return value == null ? null : value.stringValue();
    }

    /**
     * THE CARD'S ROBOLECTRIC CASE: clip, rendered line, clip has no cold load on the second clip.
     * Both seams are deck-pair handovers (two swaps), the only cold attach is the first clip's, each
     * seam's row says {@code prepare=hit} with its kinds, the Foray reaches its last clip, and never
     * two players sound. TO SEE IT FAIL: put the beat's rule ({@code SeamGap.gapSec(...) > 0}) back
     * in {@code EngineCore.warmNextSegment} (neither the line nor the clip after it is prepared, and
     * both load cold), or drop {@code durationSec()} from ExoDeck's window (the line never opens one,
     * so the second clip loads cold).
     */
    @Test
    public void clipRenderedLineClipHasNoColdLoadOnTheSecondClip() throws Exception {
        ForayEngineHost.Verdict verdict = host.handle(new EngineInput.Command(new EngineContract.Command.PlayForay("f1", "A Foray",
                List.of(clip(0, CBR.uri().toString(), 10, 22), renderedLine(1, android.net.Uri.fromFile(line).toString(), LINE_SEC),
                        clip(2, WAV.uri().toString(), 5, 9)),
                new JsonNode.Obj(List.of()), null, false, false, null), Vocabulary.Source.TAP));
        assertTrue(verdict.failures().toString(), verdict.failures().isEmpty());

        runUntil(() -> host.state().currentIndex == 2 && players.stream().anyMatch(ExoPlayer::isPlaying));
        assertEquals("both seams were handovers: " + pair.handoverLog(), 2, pair.swaps());
        assertEquals("the only cold attach is the first clip's: " + deckRows, 1, coldAttachTokens().size());

        List<JsonNode> seams = seamRows();
        assertEquals("one row per seam: " + lines, 2, seams.size());
        JsonNode intoLine = seams.get(0);
        assertEquals("clip", text(intoLine, "from"));
        assertEquals("line", text(intoLine, "to"));
        assertEquals("the line was prepared and promoted", "hit", text(intoLine, "prepare"));
        JsonNode outOfLine = seams.get(1);
        assertEquals("line", text(outOfLine, "from"));
        assertEquals("clip", text(outOfLine, "to"));
        assertEquals("the clip after the line was prepared while the line played", "hit", text(outOfLine, "prepare"));
        assertNotNull(outOfLine.get("observedGapMs"));
        assertTrue("at most one player sounds at any time (" + maxPlaying + ")", maxPlaying <= 1);

        runUntil(() -> !host.state().isRunning());
        assertEquals("the Foray ends on its last clip", 2, host.state().currentIndex);
        assertTrue("at most one player sounds at any time (" + maxPlaying + ")", maxPlaying <= 1);
    }
}
