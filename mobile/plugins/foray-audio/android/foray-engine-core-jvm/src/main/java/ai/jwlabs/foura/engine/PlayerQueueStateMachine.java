package ai.jwlabs.foura.engine;

import ai.jwlabs.foura.engine.PlayerEffect.EmitTelemetry;
import ai.jwlabs.foura.engine.PlayerEffect.LoadItem;
import ai.jwlabs.foura.engine.PlayerEffect.SeekRejected;
import ai.jwlabs.foura.engine.PlayerEffect.SeekTo;
import ai.jwlabs.foura.engine.PlayerEffect.SetOutPoint;
import ai.jwlabs.foura.engine.PlayerQueueState.Ended;
import ai.jwlabs.foura.engine.PlayerQueueState.Idle;
import ai.jwlabs.foura.engine.PlayerQueueState.Interrupted;
import ai.jwlabs.foura.engine.PlayerQueueState.LoadingItem;
import ai.jwlabs.foura.engine.PlayerQueueState.Playing;
import ai.jwlabs.foura.engine.PlayerQueueState.Transitioning;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The player queue's pure transition function: {@code reduce(state, event) -> (state,
 * effects)}, the port of {@code player/queue-state.js} (the REFERENCE) and the JVM twin of
 * {@code PlayerQueueStateMachine} in ForayEngineCore (Reducer/PlayerQueueState.swift,
 * NE-07s). The {@code queue-state} parity family is the contract: a rule change lands in
 * JS first, is re-recorded, and only then is ported here. Every telemetry string is
 * BYTE-IDENTICAL to the JS one ({@link #describe}).
 *
 * <p>Any (state, event) pair not handled below is a no-op that still surfaces through
 * telemetry, so a stray player callback can never crash the app or corrupt state.
 */
public final class PlayerQueueStateMachine {
    private PlayerQueueStateMachine() {}

    /** One transition: the next state and the effects to perform, in order. */
    public record Transition(PlayerQueueState state, List<PlayerEffect> effects) {
        public Transition {
            effects = Collections.unmodifiableList(new ArrayList<>(effects));
        }
    }

    private static Transition to(PlayerQueueState state, PlayerEffect... effects) {
        return new Transition(state, Arrays.asList(effects));
    }

    private static PlayerEffect telemetry(String message) {
        return new EmitTelemetry(message);
    }

    public static Transition reduce(PlayerQueueState state, PlayerEvent event) {
        return switch (event) {
            case PlayerEvent.Play e -> handlePlay(state, e.item());
            case PlayerEvent.ItemLoaded e -> handleItemLoaded(state);
            case PlayerEvent.ItemEnded e -> handleItemEnded(state, e.next(), e.bridged());
            case PlayerEvent.InterruptionBegan e -> handleInterruptionBegan(state);
            case PlayerEvent.InterruptionEnded e -> handleInterruptionEnded(state, e.shouldResume());
            case PlayerEvent.RouteChanged e -> handleRouteChanged(state, e.oldDeviceUnavailable());
            case PlayerEvent.SkipToNext e -> handleSkip(state, e.item(), "next");
            case PlayerEvent.SkipToPrevious e -> handleSkip(state, e.item(), "previous");
            case PlayerEvent.Stop e -> handleStop(state);
            case PlayerEvent.Error e -> to(PlayerQueueState.IDLE, PlayerEffect.PAUSE_PLAYBACK, telemetry("player.error: " + e.message()));
            case PlayerEvent.Seek e -> handleSeek(state, e.seconds(), e.precise());
            case PlayerEvent.ElementResumed e -> handleElementResumed(state);
        };
    }

    // ---- play

    private static Transition handlePlay(PlayerQueueState state, QueueItemRef target) {
        return switch (state) {
            case Idle s -> to(new LoadingItem(target, null), new LoadItem(target));
            case Ended s -> to(new LoadingItem(target, null), new LoadItem(target));
            // Manual resume: re-prime the load rather than assume the backend kept it warm.
            case Interrupted s -> to(new LoadingItem(target, s.item()), new LoadItem(target));
            case LoadingItem s -> QueueItemRef.sameRef(s.target(), target)
                    ? to(state)
                    : to(new LoadingItem(target, s.previous()), new LoadItem(target), telemetry("play.replacedInFlightLoad"));
            // The single-player invariant: never a second startPlayback while one item is audible.
            case Playing s -> QueueItemRef.sameRef(s.item(), target)
                    ? to(state)
                    : to(new LoadingItem(target, s.item()), PlayerEffect.PAUSE_PLAYBACK, new LoadItem(target),
                            telemetry("player.doubleEntryGuard: play(" + target.id() + ") while playing " + s.item().id()));
            case Transitioning s -> to(new LoadingItem(target, s.to()), PlayerEffect.PAUSE_PLAYBACK, new LoadItem(target),
                    telemetry("player.doubleEntryGuard: play(" + target.id() + ") while transitioning to " + s.to().id()));
        };
    }

    // ---- itemLoaded

    private static Transition handleItemLoaded(PlayerQueueState state) {
        switch (state) {
            case LoadingItem s -> {
                List<PlayerEffect> effects = new ArrayList<>();
                effects.add(s.target().kind() == PlayerItemKind.TTS ? PlayerEffect.RESET_RATE_FOR_TTS : PlayerEffect.RESTORE_RATE);
                // A seek queued while loading lands here: after the rate, before anything is audible.
                if (s.pendingSeek() != null) effects.add(new SeekTo(s.pendingSeek().seconds(), s.pendingSeek().precise()));
                // Arm the out-point here and nowhere else: the in-point has landed, so the
                // backend decides from a settled playhead whether the boundary is ahead.
                if (s.target().bounds() != null) effects.add(new SetOutPoint(s.target().bounds().endSec()));
                effects.add(PlayerEffect.START_PLAYBACK);
                return new Transition(new Playing(s.target()), effects);
            }
            // The bridge asset finished loading; the state is unchanged (still the bridge phase).
            case Transitioning s -> {
                return to(state, PlayerEffect.RESET_RATE_FOR_TTS, PlayerEffect.START_PLAYBACK);
            }
            default -> {
                return to(state, telemetry("itemLoaded.ignored: unexpected in state " + describe(state)));
            }
        }
    }

    // ---- itemEnded

    private static Transition handleItemEnded(PlayerQueueState state, QueueItemRef next, boolean bridged) {
        switch (state) {
            case Playing s -> {
                if (next == null) return to(PlayerQueueState.ENDED, telemetry("queue.ended"));
                if (bridged) return to(new Transitioning(s.item(), next), PlayerEffect.RESET_RATE_FOR_TTS, PlayerEffect.PLAY_TRANSITION_TTS);
                return to(new LoadingItem(next, s.item()), new LoadItem(next));
            }
            // The bridge itself finished: the caller's (possibly re-resolved) next, else the queued `to`.
            case Transitioning s -> {
                QueueItemRef target = next != null ? next : s.to();
                return to(new LoadingItem(target, s.to()), PlayerEffect.RESTORE_RATE, new LoadItem(target));
            }
            default -> {
                return to(state, telemetry("itemEnded.ignored: unexpected in state " + describe(state)));
            }
        }
    }

    // ---- interruption began

    private static Transition handleInterruptionBegan(PlayerQueueState state) {
        return switch (state) {
            case Playing s -> to(new Interrupted(s.item(), true), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                    telemetry("interruption.began"));
            // Never resume a half-played bridge: land back on the upcoming item.
            case Transitioning s -> to(new Interrupted(s.to(), true), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                    telemetry("interruption.began.duringTransition"));
            // Nothing audible yet; recorded so a stray itemLoaded cannot start playback into a call.
            // It counts as playing (CH3-01): a prompt during a load that ends with shouldResume resumes
            // the load. A route lost during a load (below) stays false.
            case LoadingItem s -> to(new Interrupted(s.target(), true), telemetry("interruption.began.duringLoad"));
            case Idle s -> to(state);
            case Ended s -> to(state);
            case Interrupted s -> to(state);
        };
    }

    // ---- interruption ended

    private static Transition handleInterruptionEnded(PlayerQueueState state, boolean shouldResume) {
        if (state instanceof Interrupted s) {
            if (shouldResume && s.wasPlaying()) {
                // Through loadingItem, not straight to playing: after a bridge the player's
                // asset is the half-played TTS, and itemLoaded re-applies the right rate.
                return to(new LoadingItem(s.item(), s.item()), new LoadItem(s.item()), telemetry("interruption.ended.resumed"));
            }
            return to(new Interrupted(s.item(), false), telemetry("interruption.ended.staysPaused"));
        }
        return to(state, telemetry("interruptionEnded.ignored: unexpected in state " + describe(state)));
    }

    // ---- route changed

    private static Transition handleRouteChanged(PlayerQueueState state, boolean oldDeviceUnavailable) {
        // A route became available: the reducer never auto-resumes (that policy is the manager's).
        if (!oldDeviceUnavailable) return to(state, telemetry("route.changed.available"));
        return switch (state) {
            case Playing s -> to(new Interrupted(s.item(), true), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                    telemetry("route.oldDeviceUnavailable.paused"));
            case Transitioning s -> to(new Interrupted(s.to(), true), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                    telemetry("route.oldDeviceUnavailable.pausedDuringTransition"));
            case LoadingItem s -> to(new Interrupted(s.target(), false), telemetry("route.oldDeviceUnavailable.duringLoad"));
            case Idle s -> to(state);
            case Ended s -> to(state);
            case Interrupted s -> to(state);
        };
    }

    // ---- skip

    private static QueueItemRef currentItem(PlayerQueueState state) {
        return switch (state) {
            case Playing s -> s.item();
            case Transitioning s -> s.to();
            case Interrupted s -> s.item();
            case LoadingItem s -> s.target();
            case Idle s -> null;
            case Ended s -> null;
        };
    }

    private static Transition handleSkip(PlayerQueueState state, QueueItemRef target, String direction) {
        if (target == null) {
            QueueItemRef restart = currentItem(state);
            if (direction.equals("previous") && restart != null) {
                return to(new LoadingItem(restart, restart), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                        new LoadItem(restart), telemetry("skip.previous.restartInPlace"));
            }
            // The queue is exhausted: STOP WHAT IS AUDIBLE (#111), not only the state.
            PlayerEffect done = telemetry("skip." + direction + ".queueExhausted");
            if (state instanceof Playing || state instanceof Transitioning) {
                return to(PlayerQueueState.ENDED, PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK, done);
            }
            return to(PlayerQueueState.ENDED, done);
        }
        return switch (state) {
            // A second skip before the first finished loading replaces the in-flight target
            // (exactly one loadItem), and drops a pendingSeek that belonged to the old one.
            case LoadingItem s -> QueueItemRef.sameRef(s.target(), target)
                    ? to(state)
                    : to(new LoadingItem(target, s.previous()), new LoadItem(target),
                            telemetry("skip." + direction + ".debounced.replacedInFlightLoad"));
            case Playing s -> skipFrom(state, target, direction);
            case Transitioning s -> skipFrom(state, target, direction);
            case Interrupted s -> skipFrom(state, target, direction);
            // Nothing playing to skip from: a fresh play.
            case Idle s -> to(new LoadingItem(target, null), new LoadItem(target));
            case Ended s -> to(new LoadingItem(target, null), new LoadItem(target));
        };
    }

    private static Transition skipFrom(PlayerQueueState state, QueueItemRef target, String direction) {
        return to(new LoadingItem(target, currentItem(state)), PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                new LoadItem(target), telemetry("skip." + direction));
    }

    // ---- seek (the reducer does not decide precision: that is seek-policy's)

    private static Transition handleSeek(PlayerQueueState state, double seconds, boolean precise) {
        return switch (state) {
            // Save first: the old position is about to be lost.
            case Playing s -> to(state, PlayerEffect.SAVE_POSITION, new SeekTo(seconds, precise));
            case Interrupted s -> to(state, PlayerEffect.SAVE_POSITION, new SeekTo(seconds, precise));
            // Queued, applied on itemLoaded before playback starts; a later seek replaces it.
            case LoadingItem s -> to(new LoadingItem(s.target(), s.previous(), new PendingSeek(seconds, precise)));
            case Idle s -> rejectSeek(state);
            case Ended s -> rejectSeek(state);
            case Transitioning s -> rejectSeek(state);
        };
    }

    private static Transition rejectSeek(PlayerQueueState state) {
        return to(state, new SeekRejected("cannot seek in state " + describe(state)));
    }

    // ---- elementResumed: interrupted -> playing with NO audio effect (the sound is already coming out)

    private static Transition handleElementResumed(PlayerQueueState state) {
        if (!(state instanceof Interrupted s)) return to(state);
        return to(new Playing(s.item()), telemetry("reconcile.elementResumed"));
    }

    // ---- stop

    private static Transition handleStop(PlayerQueueState state) {
        return switch (state) {
            case Idle s -> to(PlayerQueueState.IDLE);
            case Ended s -> to(PlayerQueueState.IDLE);
            case Playing s -> to(PlayerQueueState.IDLE, PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK, telemetry("player.stopped"));
            case Transitioning s -> to(PlayerQueueState.IDLE, PlayerEffect.SAVE_POSITION, PlayerEffect.PAUSE_PLAYBACK,
                    telemetry("player.stopped"));
            case LoadingItem s -> to(PlayerQueueState.IDLE, telemetry("player.stopped"));
            case Interrupted s -> to(PlayerQueueState.IDLE, telemetry("player.stopped"));
        };
    }

    // ---- telemetry labels

    /** queue-state.js {@code describe(state)}: the state as telemetry spells it, byte for byte. */
    public static String describe(PlayerQueueState state) {
        return switch (state) {
            case Idle s -> "idle";
            case Ended s -> "ended";
            case LoadingItem s -> "loadingItem(" + name(s.target()) + ")";
            case Playing s -> "playing(" + name(s.item()) + ")";
            case Transitioning s -> "transitioning(" + name(s.from()) + " -> " + name(s.to()) + ")";
            case Interrupted s -> "interrupted(" + name(s.item()) + ", wasPlaying: " + s.wasPlaying() + ")";
        };
    }

    /**
     * queue-state.js {@code name(ref)}: an unbounded item reads as its bare id; a segment
     * says which slice ({@code id[start-end]}, each {@code Math.round}ed and printed as
     * JavaScript's {@code String(number)} prints it).
     */
    static String name(QueueItemRef ref) {
        if (ref.bounds() == null) return ref.id();
        return ref.id() + "[" + JSWriter.numberToString(JSMath.round(ref.bounds().startSec())) + "-"
                + JSWriter.numberToString(JSMath.round(ref.bounds().endSec())) + "]";
    }
}
