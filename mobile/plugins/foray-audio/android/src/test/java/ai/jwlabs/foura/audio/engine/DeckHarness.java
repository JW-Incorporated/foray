package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import android.content.Context;
import androidx.annotation.OptIn;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.test.utils.FakeClock;
import androidx.media3.test.utils.TestExoPlayerBuilder;
import androidx.media3.test.utils.robolectric.RobolectricUtil;
import androidx.test.core.app.ApplicationProvider;
import org.robolectric.shadows.ShadowLooper;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * One ExoPlayer and one {@link ExoDeck} over it, built the media3-test-utils way: a
 * {@link TestExoPlayerBuilder} on an auto-advancing {@link FakeClock} (so playback, the
 * deck's deadline, its settle and its watchdog all run in virtual time), with a
 * {@link CapturingAudioRenderer} as the only renderer. Every event the deck emits and every
 * row it writes is kept, in order.
 *
 * <p>The one thing in the rig that is NOT virtual is the loader thread reading the fixture, and
 * {@link RealIoHold} keeps virtual time still while it does: without that, how far the deck's
 * deadline and the player's buffer got during a load depended on how fast the runner read a file
 * (the android-shell flake; the class's header has the evidence). Every data source the deck
 * builds goes through {@link #ioHold}.
 */
@OptIn(markerClass = UnstableApi.class)
final class DeckHarness implements AutoCloseable {
    final Context context = ApplicationProvider.getApplicationContext();
    final FakeClock clock = new FakeClock(/* isAutoAdvancing= */ true);
    final CapturingAudioRenderer renderer = new CapturingAudioRenderer();
    final ExoPlayer player;
    final RealIoHold ioHold;
    final ExoDeck deck;
    final List<DeckEvent> events = new ArrayList<>();
    /** The player's position (seconds) at the moment each event was delivered, index for index. */
    final List<Double> positionsAtEvent = new ArrayList<>();
    final List<EngineCommand.DiagEntry> rows = new ArrayList<>();
    final List<String> logRows = new ArrayList<>();
    final List<String> faults = new ArrayList<>();
    boolean sessionActive = true;

    DeckHarness() {
        this(null, config -> {});
    }

    DeckHarness(Consumer<ExoDeck.Config> tweak) {
        this(null, tweak);
    }

    /** {@code dataSources} null: the default source (file URIs). */
    DeckHarness(DataSource.Factory dataSources, Consumer<ExoDeck.Config> tweak) {
        player = new TestExoPlayerBuilder(context).setClock(clock).setRenderers(renderer).build();
        ioHold = new RealIoHold(player.getPlaybackLooper());
        ExoDeck.Config config = new ExoDeck.Config();
        config.mediaSources = ExoDeck.progressive(ioHold.wrap(dataSources != null ? dataSources : new DefaultDataSource.Factory(context)));
        config.diag = rows::add;
        config.writeRow = logRows::add;
        config.debugFault = faults::add;
        config.sessionIsActive = () -> sessionActive;
        // The production gate lock (Media3's wake and Wi-Fi lock managers) unless a test injects a recorder.
        config.context = context;
        tweak.accept(config);
        deck = new ExoDeck(player, config);
        deck.setListener(event -> {
            events.add(event);
            positionsAtEvent.add(player.getCurrentPosition() / 1000.0);
        });
    }

    /**
     * The wall-time bound on a wait: a backstop against a condition that can never hold, not a
     * tuning knob. The clock the player runs on is fake, but the bound is real. It was raised from
     * RobolectricUtil's 10 s default when the first android-shell timeouts appeared (run
     * 36650414482); those were the {@link RealIoHold} race, which no bound fixes, and a minute
     * only costs anything when the condition never holds.
     */
    static final long WAIT_MS = 60_000;

    /** Run the main looper (and so the auto-advancing fake clock) until the condition holds. */
    void runUntil(BooleanSupplier condition) throws TimeoutException {
        RobolectricUtil.runMainLooperUntil(condition::getAsBoolean, WAIT_MS, Clock.DEFAULT);
    }

    /**
     * Move the fake clock by hand, {@code ms} in 10 ms steps, running the main looper after
     * each. For a player with nothing to do: an auto-advancing FakeClock only jumps to a message
     * at most a second away, and only messages keep it moving, so an idle player (one a deadline
     * cleared) would otherwise never let seconds pass.
     */
    void advanceIdle(long ms) {
        for (long done = 0; done < ms; done += 10) {
            clock.advanceTime(10);
            ShadowLooper.idleMainLooper();
        }
    }

    /** Let {@code ms} of virtual time pass. */
    void runFor(long ms) throws TimeoutException {
        long until = clock.elapsedRealtime() + ms;
        runUntil(() -> clock.elapsedRealtime() >= until);
    }

    /** The first event of this type (and token, when the type has one) at or after {@code from}, or null. */
    <T extends DeckEvent> T find(Class<T> type, int from) {
        for (int i = from; i < events.size(); i++) if (type.isInstance(events.get(i))) return type.cast(events.get(i));
        return null;
    }

    <T extends DeckEvent> T find(Class<T> type) {
        return find(type, 0);
    }

    <T extends DeckEvent> T await(Class<T> type) throws TimeoutException {
        return await(type, 0);
    }

    <T extends DeckEvent> T await(Class<T> type, int from) throws TimeoutException {
        runUntil(() -> find(type, from) != null);
        return find(type, from);
    }

    <T extends DeckEvent> int count(Class<T> type) {
        int n = 0;
        for (DeckEvent e : events) if (type.isInstance(e)) n++;
        return n;
    }

    /** The {@code deck} rows of this kind, in order. */
    List<EngineCommand.DiagEntry> deckRows(String kind) {
        return rows(("deck"), kind);
    }

    List<EngineCommand.DiagEntry> rows(String rowKind, String kind) {
        List<EngineCommand.DiagEntry> out = new ArrayList<>();
        for (EngineCommand.DiagEntry row : rows) {
            JsonNode k = row.field("kind");
            if (row.kind().equals(rowKind) && k instanceof JsonNode.Str s && s.value().equals(kind)) out.add(row);
        }
        return out;
    }

    static String str(EngineCommand.DiagEntry row, String key) {
        JsonNode node = row.field(key);
        return node instanceof JsonNode.Str s ? s.value() : null;
    }

    static Double num(EngineCommand.DiagEntry row, String key) {
        JsonNode node = row.field(key);
        return node instanceof JsonNode.Num n ? n.value() : null;
    }

    @Override
    public void close() {
        deck.invalidate();
        // The hold first: a release must never wait on a loader thread, and nothing is measured now.
        ioHold.close();
        player.release();
    }
}
