package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import androidx.test.core.app.ApplicationProvider;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Code-health-3 R5-04: {@link ExoDeck.Config#debugFault}'s DEFAULT is the build's. A
 * debuggable app stops on the implicit-activation fault, the way the Swift twin's
 * {@code assertionFailure} does in DEBUG; a release app writes the row and still plays; an
 * injected sink (DeckHarness's {@code faults::add}) wins over both.
 *
 * <p>The build is read from {@link ApplicationInfo#FLAG_DEBUGGABLE} on the context the deck is
 * configured with, so each test hands the deck a context whose flag it set itself, rather than
 * trusting whatever Robolectric's test application says.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ExoDeckDebugFaultTest {
    private static final String ROW = "fault implicit-activation deck token=1";

    private static DeckCommand load() {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) {
            if (f.file.equals("click-cbr.mp3")) return new DeckCommand.Load(1, "ep-1", f.uri().toString(), 5.0, false);
        }
        throw new AssertionError("no click track click-cbr.mp3");
    }

    /** The application context, answering {@code debuggable} for the app's build. */
    private static Context build(boolean debuggable) {
        Context base = ApplicationProvider.getApplicationContext();
        ApplicationInfo info = new ApplicationInfo(base.getApplicationInfo());
        if (debuggable) {
            info.flags |= ApplicationInfo.FLAG_DEBUGGABLE;
        } else {
            info.flags &= ~ApplicationInfo.FLAG_DEBUGGABLE;
        }
        return new ContextWrapper(base) {
            @Override
            public ApplicationInfo getApplicationInfo() {
                return info;
            }
        };
    }

    @Test
    public void aDebuggableBuildStopsOnTheFaultByDefault() throws Exception {
        // MUTATION: debugFaultFor returns the no-op for a debuggable build too (the old
        // `debugFault = row -> {}` in every build) -> nothing is thrown and this fails.
        try (DeckHarness h = new DeckHarness(config -> {
            config.debugFault = null;
            config.context = build(true);
        })) {
            h.sessionActive = false;
            h.deck.send(load());
            h.await(DeckEvent.Ready.class);
            AssertionError stop = assertThrows(AssertionError.class, () -> h.deck.send(DeckCommand.PLAY));
            assertEquals(ROW, stop.getMessage());
            assertEquals("the row is written before DEBUG stops", List.of(ROW), h.logRows);
        }
    }

    @Test
    public void aReleaseBuildWritesTheRowAndStillPlaysByDefault() throws Exception {
        // MUTATION: debugFaultFor throws whatever the flag says -> the play throws here.
        try (DeckHarness h = new DeckHarness(config -> {
            config.debugFault = null;
            config.context = build(false);
        })) {
            h.sessionActive = false;
            h.deck.send(load());
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            assertEquals(List.of(ROW), h.logRows);
            h.runUntil(() -> h.player.isPlaying());
        }
    }

    @Test
    public void anInjectedSinkWinsOverTheBuildDefault() throws Exception {
        // MUTATION: the constructor takes debugFaultFor(config.context) and ignores
        // Config.debugFault -> the debuggable default throws instead of recording.
        try (DeckHarness h = new DeckHarness(config -> config.context = build(true))) {
            h.sessionActive = false;
            h.deck.send(load());
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            assertEquals(List.of(ROW), h.faults);
            h.runUntil(() -> h.player.isPlaying());
        }
    }

    @Test
    public void withNoContextTheDefaultIsANoOp() {
        // A deck configured with an injected gateAwake may have no context; it cannot tell the
        // build, so it keeps release's behaviour. MUTATION: drop the null check -> NPE here.
        ExoDeck.debugFaultFor(null).accept(ROW);
    }
}
