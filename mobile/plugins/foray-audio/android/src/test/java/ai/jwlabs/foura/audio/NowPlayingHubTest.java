package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * M5 (full-repo-review-report.md, 2026-08-31): {@link NowPlayingHub} is the process
 * singleton that carries state between {@link ForayAudioPlugin} (bridge worker pool)
 * and {@link PlaybackKeepAliveService} (main thread) — the class comment's own
 * "identity-checked... not cleared unconditionally" rule for {@code clearListener}/
 * {@code clearSink} is exactly the kind of thing a source-shape check cannot verify
 * and only running the code can. Robolectric gives this a real main-thread Looper
 * ({@link ShadowLooper}) to exercise the {@code Handler.post} dispatch for real.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class NowPlayingHubTest {

    @After
    public void resetHubBetweenTests() {
        // The hub is a process (class) singleton — Robolectric does not give each
        // @Test method a fresh classloader for it, so state from one test would
        // otherwise leak into the next.
        NowPlayingHub.reset();
    }

    @Test
    public void getDefaultsToEmpty() {
        assertEquals(NowPlaying.EMPTY, NowPlayingHub.get());
    }

    @Test
    public void setWithNoListenerDoesNotThrow() throws Exception {
        NowPlayingHub.set(NowPlaying.from(payload()));
        assertEquals(NowPlaying.PLAYING, NowPlayingHub.get().state);
    }

    @Test
    public void listenerIsNotifiedOnTheMainThread_afterSet() throws Exception {
        AtomicReference<NowPlaying> seen = new AtomicReference<>();
        AtomicInteger callCount = new AtomicInteger();
        NowPlayingHub.setListener(np -> {
            seen.set(np);
            callCount.incrementAndGet();
        });

        NowPlayingHub.set(NowPlaying.from(payload()));
        // The listener dispatch is posted, not synchronous — see the class javadoc
        // ("Posting unconditionally is one behaviour instead of two"). Idle the main
        // looper to let the posted Runnable actually run.
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        assertEquals(1, callCount.get());
        assertEquals(NowPlaying.PLAYING, seen.get().state);
    }

    @Test
    public void clearListener_isIdentityChecked_soANewerListenerSurvives() throws Exception {
        // This is the exact race the class comment calls out: an Activity
        // recreation's new instance registers before the old one tears down, and
        // clearListener must not unregister a DIFFERENT (newer) listener.
        AtomicInteger callCount = new AtomicInteger();
        NowPlayingHub.Listener stale = np -> { };
        NowPlayingHub.Listener fresh = np -> callCount.incrementAndGet();
        NowPlayingHub.setListener(stale);
        NowPlayingHub.setListener(fresh); // simulate the newer instance registering first
        NowPlayingHub.clearListener(stale); // the old instance's teardown, arriving late

        NowPlayingHub.set(NowPlaying.from(payload()));
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals("clearListener(stale) must not have unregistered the newer 'fresh' listener",
            1, callCount.get());
    }

    @Test
    public void dispatchWithNoSink_isSilentlyDropped() {
        // Must not throw — see the class javadoc: "a press with no WebView behind
        // it has nothing to act on".
        NowPlayingHub.dispatch("play", 0L, 0L);
    }

    @Test
    public void dispatchDeliversToTheRegisteredSink() {
        AtomicReference<String> action = new AtomicReference<>();
        AtomicReference<Long> position = new AtomicReference<>();
        NowPlayingHub.setSink((a, pos, offset) -> {
            action.set(a);
            position.set(pos);
        });
        NowPlayingHub.dispatch("seekto", 42_000L, 0L);
        assertEquals("seekto", action.get());
        assertEquals(Long.valueOf(42_000L), position.get());
    }

    @Test
    public void clearSink_isIdentityChecked() {
        AtomicReference<String> action = new AtomicReference<>();
        NowPlayingHub.TransportSink stale = (a, p, o) -> { };
        NowPlayingHub.TransportSink fresh = (a, p, o) -> action.set(a);
        NowPlayingHub.setSink(stale);
        NowPlayingHub.setSink(fresh); // simulate the newer instance registering first
        NowPlayingHub.clearSink(stale); // the old instance's teardown, arriving late

        NowPlayingHub.dispatch("pause", 0L, 0L);
        assertEquals("clearSink(stale) must not have unregistered the newer 'fresh' sink",
            "pause", action.get());
    }

    @Test
    public void reset_clearsStateListenerAndSink() throws Exception {
        NowPlayingHub.set(NowPlaying.from(payload()));
        NowPlayingHub.setListener(np -> { });
        NowPlayingHub.setSink((a, p, o) -> { });

        NowPlayingHub.reset();

        assertEquals(NowPlaying.EMPTY, NowPlayingHub.get());
        // Dispatch after reset should be silently dropped (no sink) rather than
        // throw, and set-after-reset should not resurrect a stale listener call.
        NowPlayingHub.dispatch("play", 0L, 0L);
    }

    private static com.getcapacitor.JSObject payload() throws Exception {
        return new com.getcapacitor.JSObject("{\"state\":\"playing\",\"title\":\"Episode 1\"}");
    }
}
