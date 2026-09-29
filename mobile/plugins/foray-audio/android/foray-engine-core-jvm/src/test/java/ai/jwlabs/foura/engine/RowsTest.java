package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * What the {@code rows} fixtures do not reach (A-23; the Swift RowsTests, ported): a row
 * the engine writes is one the page's reader accepts, the last-episode row comes out in
 * SNAPSHOT_FIELDS order whatever order it arrives in, {@code isNewer} orders engine rows by
 * their stamp, and the restore record round-trips and refuses what it cannot trust. The
 * byte-for-byte comparison against the JS writers is the {@code rows} family itself.
 */
public class RowsTest {
    static final double T0 = 1_790_000_000_123.0;

    static String stamp(double ms) {
        return Rows.timestamp(ms);
    }

    @Test
    public void positionRowsReadBack() {
        Rows.StoredRow row = Rows.position("ep-1", 1234.5, 3600.0, stamp(T0));
        assertEquals("cp_pos:ep-1", row.key());
        assertEquals("{\"seconds\":1234.5,\"duration\":3600,\"updated_at\":\"2026-09-21T14:13:20.123Z\",\"source\":\"local\"}", row.value());
        assertEquals(new Rows.PositionRecord(1234.5, 3600.0, "2026-09-21T14:13:20.123Z"), Rows.readPosition(row.value()));
        Rows.StoredRow unknownLength = Rows.position("ep-1", 0.0, Double.NaN, stamp(0));
        assertNull("a NaN duration is stored as null", Rows.readPosition(unknownLength.value()).duration());
        assertTrue("-0 passes the gate and prints as 0", Rows.position("e", -0.0, null, stamp(0)).value().startsWith("{\"seconds\":0,"));
        assertNull(Rows.position("", 1.0, null, stamp(0)));
        assertNull(Rows.position("e", -1.0, null, stamp(0)));
        assertNull(Rows.position("e", null, null, stamp(0)));
        assertNull("load refuses a non-number", Rows.readPosition("{\"seconds\":\"12\"}"));
        assertNull("and a torn write", Rows.readPosition("{\"seconds\":1"));
        assertNull(Rows.readPosition(""));
    }

    @Test
    public void forayRowsReadBack() {
        Rows.ForayProgressInput input = new Rows.ForayProgressInput("f-1", "Morning run", 1394.2, 3673.5, 7.0, "seg-8", 12.25);
        Rows.StoredRow row = Rows.forayProgress(input, stamp(T0));
        assertEquals("cp_foray:f-1", row.key());
        Rows.ForayProgressRecord read = Rows.readForayProgress(row.value());
        assertEquals("f-1", read.forayId());
        assertEquals(1394.2, read.elapsedSec(), 0);
        assertEquals((Double) 7.0, read.index());
        assertEquals("seg-8", read.segmentId());
        assertEquals((Double) 12.25, read.intoSec());
        // Rows written before segment_id/into_sec existed still resume.
        assertNotNull(Rows.readForayProgress("{\"foray_id\":\"f\",\"elapsed_sec\":0,\"total_sec\":1}"));
        assertNull(Rows.readForayProgress("{\"foray_id\":\" \",\"elapsed_sec\":0,\"total_sec\":1}"));
        assertNull(Rows.readForayProgress("{\"foray_id\":\"f\",\"elapsed_sec\":0,\"total_sec\":0}"));
        // The clamps are makeProgress's: a blank title is "", a bad index -1, a blank segment null.
        String clamped = Rows.forayProgress(new Rows.ForayProgressInput("f", " ", 1.0, 2.0, 1.5, "  ", -3.0), stamp(0)).value();
        assertEquals("{\"foray_id\":\"f\",\"title\":\"\",\"elapsed_sec\":1,\"total_sec\":2,\"index\":-1,\"segment_id\":null,"
                + "\"into_sec\":0,\"updated_at\":\"1970-01-01T00:00:00.000Z\"}", clamped);
    }

    /**
     * The engine stores the page's lastEpisodeRow "verbatim plus updated_at": the page's
     * row, in ANY member order (a bridge map is unordered), comes out in SNAPSHOT_FIELDS
     * order and otherwise unchanged; an older {@code updated_at} in it is replaced.
     */
    @Test
    public void theLastEpisodeRowIsTheSnapshotInOrderWhateverOrderItArrivesIn() {
        JsonNode page = new JsonNode.Obj(Arrays.asList(
                JsonNode.member("duration_sec", JsonNode.num(2550)),
                JsonNode.member("updated_at", JsonNode.str("2020-01-01T00:00:00.000Z")),
                JsonNode.member("audio_url", JsonNode.str("https://cdn.example.com/a/ep-1.mp3?x=1&y=2")),
                JsonNode.member("title", JsonNode.str("Episode One")),
                JsonNode.member("id", JsonNode.str("ep-1")),
                JsonNode.member("show", JsonNode.NULL),
                JsonNode.member("topics", new JsonNode.Arr(Collections.singletonList(JsonNode.str("ai"))))));
        Rows.StoredRow row = Rows.lastEpisode(page, stamp(T0));
        assertEquals("cp_last_episode", row.key());
        assertEquals("{\"id\":\"ep-1\",\"title\":\"Episode One\",\"audio_url\":\"https://cdn.example.com/a/ep-1.mp3?x=1&y=2\","
                + "\"duration_sec\":2550,\"updated_at\":\"2026-09-21T14:13:20.123Z\"}", row.value());
        JsonNode back = Rows.readLastEpisode(row.value());
        // Idempotent: the stored row, sent back as a lastEpisodeRow, stores the same bytes.
        assertEquals(row.value(), Rows.lastEpisode(back, stamp(T0)).value());
        JsonNode falsyId = new JsonNode.Obj(Collections.singletonList(JsonNode.member("id", JsonNode.num(0))));
        assertNull("a falsy id writes nothing", Rows.lastEpisode(falsyId, stamp(0)));
        assertNull(Rows.readLastEpisode("[]"));
    }

    /**
     * DurableStore hydration adopts the NEWER copy of a row by {@code isNewer}, so an engine
     * row stamped later must win over an earlier one, of every kind, and an unstamped or
     * unreadable row never wins or loses by accident.
     */
    @Test
    public void isNewerOrdersEngineWrittenRowsByTheirStamp() {
        String early = stamp(T0);
        String late = stamp(T0 + 1);
        JsonNode item = new JsonNode.Obj(Collections.singletonList(JsonNode.member("id", JsonNode.str("e"))));
        Rows.ForayProgressInput f = new Rows.ForayProgressInput("f", null, 1.0, 9.0, null, null, null);
        List<Rows.StoredRow[]> pairs = Arrays.asList(
                new Rows.StoredRow[] {Rows.position("e", 1.0, null, early), Rows.position("e", 1.0, null, late)},
                new Rows.StoredRow[] {Rows.forayProgress(f, early), Rows.forayProgress(f, late)},
                new Rows.StoredRow[] {Rows.lastEpisode(item, early), Rows.lastEpisode(item, late)});
        for (Rows.StoredRow[] pair : pairs) {
            String older = pair[0].value();
            String newer = pair[1].value();
            assertTrue(newer, Rows.isNewer(newer, older));
            assertFalse(older, Rows.isNewer(older, newer));
            assertFalse("equal stamps are not newer", Rows.isNewer(newer, newer));
            assertFalse("an unstamped row is not older", Rows.isNewer(newer, "{\"seconds\":1}"));
            assertFalse(Rows.isNewer("not json", older));
        }
        // stampOf reads updated_at first, then updatedAt, then ts.
        assertEquals((Double) 1.0, Rows.stamp("{\"ts\":\"1970-01-01T00:00:00.002Z\",\"updated_at\":\"1970-01-01T00:00:00.001Z\"}"));
        assertEquals((Double) 3.0, Rows.stamp("{\"updated_at\":\"junk\",\"updatedAt\":\"1970-01-01T00:00:00.003Z\"}"));
    }

    @Test
    public void ownedPrefixesNameEveryRowTheBuildersWrite() {
        assertEquals(Arrays.asList("cp_pos:", "cp_foray:", "cp_last_episode"), Rows.OWNED_PREFIXES);
        JsonNode item = new JsonNode.Obj(Collections.singletonList(JsonNode.member("id", JsonNode.str("x"))));
        for (String key : new String[] {
            Rows.position("x", 1.0, null, stamp(0)).key(),
            Rows.forayProgress(new Rows.ForayProgressInput("x", null, 1.0, 2.0, null, null, null), stamp(0)).key(),
            Rows.lastEpisode(item, stamp(0)).key()}) {
            boolean owned = false;
            for (String prefix : Rows.OWNED_PREFIXES) owned |= key.startsWith(prefix);
            assertTrue(key, owned);
        }
    }

    /** The engine-private restore record keeps what the cold path needs and reads back equal; a record it cannot trust is none. */
    @Test
    public void theRestoreRecordRoundTripsAndRefusesWhatItCannotTrust() {
        JsonNode event = new JsonNode.Obj(Arrays.asList(
                JsonNode.member("kind", JsonNode.str("position")), JsonNode.member("episode_id", JsonNode.str("ep-1")),
                JsonNode.member("seconds", JsonNode.num(60)), JsonNode.member("duration", JsonNode.num(3600)),
                JsonNode.member("at", JsonNode.str("2026-09-21T14:13:20.123Z"))));
        List<JsonNode> queue = Arrays.asList(
                new JsonNode.Obj(Collections.singletonList(JsonNode.member("id", JsonNode.str("s1")))),
                new JsonNode.Obj(Collections.singletonList(JsonNode.member("id", JsonNode.str("s2")))));
        RestoreRecord record = new RestoreRecord(RestoreRecord.Mode.FORAY, queue, 1, 12.5, "f-1", 1.25, "com.apple.voice.Samantha",
                Collections.emptyList(), Collections.singletonList(event), stamp(T0), "2026092401");
        String text = record.serialized();
        assertTrue(text, text.startsWith("{\"v\":1,\"mode\":\"foray\",\"queue\":["));
        assertEquals(record, RestoreRecord.parse(text));

        RestoreRecord gone = RestoreRecord.relinquished(stamp(0), "1");
        assertEquals("{\"v\":1,\"mode\":\"relinquished\",\"updated_at\":\"1970-01-01T00:00:00.000Z\",\"build\":\"1\"}", gone.serialized());
        assertEquals(gone, RestoreRecord.parse(gone.serialized()));

        for (String bad : new String[] {
            text.replace("\"v\":1", "\"v\":2"),
            text.replace("\"index\":1", "\"index\":2"),
            text.replace("\"rate\":1.25", "\"rate\":0"),
            text.replace("\"forayId\":\"f-1\",", ""),
            text.replace("\"mode\":\"foray\"", "\"mode\":\"tape\""),
            text.substring(0, text.length() - 1)}) {
            assertNull(bad, RestoreRecord.parse(bad));
        }
    }
}
