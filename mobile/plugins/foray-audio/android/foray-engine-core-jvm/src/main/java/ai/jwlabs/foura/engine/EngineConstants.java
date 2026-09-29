// GENERATED FILE - DO NOT EDIT.
// The Android engine's constants, from the JS reference (A-23; the Swift twin is NE-04's EngineConstants.swift).
// Regenerate with `node tools/parity/gen-constants.mjs --write`; tools/parity/gen-constants.test.mjs
// (in npm test) is red while this file disagrees with the JS it comes from.
//
// Namespaced by source module, as EngineConstants.<Module>.<JS_NAME>, because the
// JS modules reuse names for different rules. Exported by more than one module:
//   DRIFT_TOLERANCE_SEC: ForayProgress, SeekPolicy
//   MAX_AGE_H: EpisodeProgress, ForayProgress
//   MIN_RESUME_SEC: ForayProgress, PositionStore
//   NEAR_END_SEC: ForayProgress, PositionStore
//
// Every JS number is a double (JavaScript has no other number type). Policy
// ports are separate classes (PlaybackRate, TransportPolicy, ...) that READ these;
// they never redeclare a value here. API 24 library surface only (no List.of).

package ai.jwlabs.foura.engine;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class EngineConstants {
    private EngineConstants() {}

    /** {@code player/deck-policy.js} */
    public static final class DeckPolicy {
        private DeckPolicy() {}

        /** {@code FINE_WAKE} */
        public static final class FineWake {
            private FineWake() {}

            /** {@code FINE_WAKE.STOP} */
            public static final String STOP = "stop";
            /** {@code FINE_WAKE.RESCHEDULE} */
            public static final String RESCHEDULE = "reschedule";
            /** {@code FINE_WAKE.STAND_DOWN} */
            public static final String STAND_DOWN = "stand-down";
        }

        /** {@code LOAD_SETTLE_TIMEOUT_HIDDEN_MS} */
        public static final double LOAD_SETTLE_TIMEOUT_HIDDEN_MS = 20000.0;
        /** {@code LOAD_SETTLE_TIMEOUT_MS} */
        public static final double LOAD_SETTLE_TIMEOUT_MS = 10000.0;
        /** {@code OUT_POINT_ARM_LEAD_SEC} */
        public static final double OUT_POINT_ARM_LEAD_SEC = 2.0;

        /** {@code OUT_POINT_LAYER} */
        public static final class OutPointLayer {
            private OutPointLayer() {}

            /** {@code OUT_POINT_LAYER.END_TIME} */
            public static final String END_TIME = "endTime";
            /** {@code OUT_POINT_LAYER.BOUNDARY} */
            public static final String BOUNDARY = "boundary";
            /** {@code OUT_POINT_LAYER.WATCHDOG} */
            public static final String WATCHDOG = "watchdog";
        }

        /** {@code OUT_POINT_MIN_TIMER_MS} */
        public static final double OUT_POINT_MIN_TIMER_MS = 4.0;
        /** {@code OUT_POINT_WATCHDOG_POLL_MS} */
        public static final double OUT_POINT_WATCHDOG_POLL_MS = 250.0;
        /** {@code OUT_POINT_WATCHDOG_WINDOW_SEC} */
        public static final double OUT_POINT_WATCHDOG_WINDOW_SEC = 1.5;

        /** {@code RECOVERY} */
        public static final class Recovery {
            private Recovery() {}

            /** {@code RECOVERY.ARM_OUT_POINT} */
            public static final String ARM_OUT_POINT = "arm-out-point";
            /** {@code RECOVERY.PLAY} */
            public static final String PLAY = "play";
            /** {@code RECOVERY.REPORT} */
            public static final String REPORT = "report";
        }

        /** {@code SETTLE_NEAR_SEC} */
        public static final double SETTLE_NEAR_SEC = 1.0;

        /** {@code WATCHDOG_WAKE} */
        public static final class WatchdogWake {
            private WatchdogWake() {}

            /** {@code WATCHDOG_WAKE.STOP} */
            public static final String STOP = "stop";
            /** {@code WATCHDOG_WAKE.REARM} */
            public static final String REARM = "rearm";
        }
    }

    /** {@code player/default-voice.js} */
    public static final class DefaultVoice {
        private DefaultVoice() {}

        /** {@code DEFAULT_VOICE_NAME} */
        public static final String DEFAULT_VOICE_NAME = "Samantha";
        /** {@code VOICE_LIST_LANG} */
        public static final String VOICE_LIST_LANG = "en";
    }

    /** {@code player/engine-contract.js} */
    public static final class EngineContract {
        private EngineContract() {}

        /** {@code AUDIBLE_COMMANDS} */
        public static final List<String> AUDIBLE_COMMANDS = Collections.unmodifiableList(Arrays.asList("deckPlay", "speak", "interludeStart", "silenceStart"));
        /** {@code BRIDGE_METHODS} */
        public static final List<String> BRIDGE_METHODS = Collections.unmodifiableList(Arrays.asList("engineHello", "engineSend", "engineRead"));
        /** {@code CAPABILITIES} */
        public static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList("episode", "continuation", "restore", "foray"));
        /** {@code COMMANDS} */
        public static final List<String> COMMANDS = Collections.unmodifiableList(Arrays.asList("playEpisode", "playForay", "setContinuation", "play", "pause", "toggle", "next", "previous", "seekBy", "seekTo", "jump", "stop", "setRate", "setVoice", "setInterludeEnabled", "setPageVisible", "ackAdvances", "ackEvents", "restoreBar", "purge", "relinquish", "audition", "setModeOverride", "setHoldPolicy", "probeSession", "simulateTermination"));
        /** {@code CONTRACT_KINDS} */
        public static final List<String> CONTRACT_KINDS = Collections.unmodifiableList(Arrays.asList("helloRequest", "helloResponse", "sendRequest", "sendResponse", "readRequest", "rowsResponse", "diagnosticsResponse", "snapshot", "event"));
        /** {@code DEFAULT_HOLD_POLICY} */
        public static final String DEFAULT_HOLD_POLICY = "forever";
        /** {@code ENGINE_MODES} */
        public static final List<String> ENGINE_MODES = Collections.unmodifiableList(Arrays.asList("native", "legacy"));
        /** {@code ENGINE_MODE_EVENTS} */
        public static final List<String> ENGINE_MODE_EVENTS = Collections.unmodifiableList(Arrays.asList("launch", "healthy", "page-health", "set-override"));
        /** {@code ENGINE_PLATFORMS} */
        public static final List<String> ENGINE_PLATFORMS = Collections.unmodifiableList(Arrays.asList("ios", "android"));
        /** {@code EVENTS} */
        public static final List<String> EVENTS = Collections.unmodifiableList(Arrays.asList("snapshot", "advanced", "skipped", "error", "voiceFallback", "diag", "modeChanged"));
        /** {@code HANDSHAKE_REASONS} */
        public static final List<String> HANDSHAKE_REASONS = Collections.unmodifiableList(Arrays.asList("native", "not-ios", "no-method", "no-hello", "bad-hello", "engine-legacy", "protocol-mismatch"));
        /** {@code HELLO_PLATFORMS} */
        public static final List<String> HELLO_PLATFORMS = Collections.unmodifiableList(Arrays.asList("ios"));
        /** {@code HOLD_POLICY_KINDS} */
        public static final List<String> HOLD_POLICY_KINDS = Collections.unmodifiableList(Arrays.asList("forever", "none", "until"));
        /** {@code MODE_OVERRIDES} */
        public static final List<String> MODE_OVERRIDES = Collections.unmodifiableList(Arrays.asList("auto", "native", "web"));
        /** {@code OWNED_PREFIXES} */
        public static final List<String> OWNED_PREFIXES = Collections.unmodifiableList(Arrays.asList("cp_pos:", "cp_foray:", "cp_last_episode"));
        /** {@code PAGE_MODES} */
        public static final List<String> PAGE_MODES = Collections.unmodifiableList(Arrays.asList("native", "js"));
        /** {@code PLAYER_STATES} */
        public static final List<String> PLAYER_STATES = Collections.unmodifiableList(Arrays.asList("idle", "loadingItem", "playing", "transitioning", "interrupted", "ended"));
        /** {@code PLAY_VIAS} */
        public static final List<String> PLAY_VIAS = Collections.unmodifiableList(Arrays.asList("tap", "remote", "autoresume", "auditionTap"));
        /** {@code PROTOCOL} */
        public static final double PROTOCOL = 1.0;
        /** {@code READ_KINDS} */
        public static final List<String> READ_KINDS = Collections.unmodifiableList(Arrays.asList("snapshot", "rows", "diagnostics"));
        /** {@code REFUSALS} */
        public static final List<String> REFUSALS = Collections.unmodifiableList(Arrays.asList("not-loaded", "no-next", "no-previous", "ended", "refused-structure", "capability-off", "session-failed:cannot-interrupt-others", "session-failed:cannot-start-playing", "session-failed:other", "engine-busy", "relinquished", "unknown-cmd"));
        /** {@code RELINQUISH_CAPS} */
        public static final List<String> RELINQUISH_CAPS = Collections.unmodifiableList(Arrays.asList("episode", "continuation", "restore", "foray", "all"));
        /** {@code SESSION_ACTIONS} */
        public static final List<String> SESSION_ACTIONS = Collections.unmodifiableList(Arrays.asList("activate", "deactivate", "deactivate-notify", "reapply-category", "rebuild", "command-failed"));
        /** {@code SESSION_INPUTS} */
        public static final List<String> SESSION_INPUTS = Collections.unmodifiableList(Arrays.asList("userPlay", "sessionResult", "pause", "beat", "narration", "background", "holdExpired", "interruptionBegan", "interruptionEnded", "mediaServicesReset", "relinquish", "close", "finalEnd", "dataDeletion"));
        /** {@code SESSION_PHASES} */
        public static final List<String> SESSION_PHASES = Collections.unmodifiableList(Arrays.asList("inactive", "active", "lostToInterruption", "relinquished"));
        /** {@code SESSION_ROWS} */
        public static final List<String> SESSION_ROWS = Collections.unmodifiableList(Arrays.asList("stale-suspension", "mic-muted", "stale-hold", "media-services-reset"));
        /** {@code SNAPSHOT_MODES} */
        public static final List<String> SNAPSHOT_MODES = Collections.unmodifiableList(Arrays.asList("none", "episode", "foray"));
        /** {@code STRIKE_LIMIT} */
        public static final double STRIKE_LIMIT = 3.0;
    }

    /** {@code player/episode-progress.js} */
    public static final class EpisodeProgress {
        private EpisodeProgress() {}

        /** {@code KEY} */
        public static final String KEY = "cp_last_episode";
        /** {@code MAX_AGE_H} */
        public static final double MAX_AGE_H = 720.0;
    }

    /** {@code player/foray-progress.js} */
    public static final class ForayProgress {
        private ForayProgress() {}

        /** {@code DRIFT_DROPPED} */
        public static final String DRIFT_DROPPED = "dropped";
        /** {@code DRIFT_EXACT} */
        public static final String DRIFT_EXACT = "exact";
        /** {@code DRIFT_MOVED} */
        public static final String DRIFT_MOVED = "moved";
        /** {@code DRIFT_TOLERANCE_SEC} */
        public static final double DRIFT_TOLERANCE_SEC = 1.0;
        /** {@code DRIFT_UNANCHORED} */
        public static final String DRIFT_UNANCHORED = "unanchored";
        /** {@code DRIFT_UNVERIFIED} */
        public static final String DRIFT_UNVERIFIED = "unverified";
        /** {@code KEY_PREFIX} */
        public static final String KEY_PREFIX = "cp_foray:";
        /** {@code MAX_AGE_H} */
        public static final double MAX_AGE_H = 720.0;
        /** {@code MIN_RESUME_SEC} */
        public static final double MIN_RESUME_SEC = 20.0;
        /** {@code NEAR_END_SEC} */
        public static final double NEAR_END_SEC = 45.0;
        /** {@code PLAYED_LABEL} */
        public static final String PLAYED_LABEL = "Played";
        /** {@code SAVE_EVERY_SEC} */
        public static final double SAVE_EVERY_SEC = 5.0;
    }

    /** {@code player/foray-queue.js} */
    public static final class ForayQueue {
        private ForayQueue() {}

        /** {@code DURATION_ESTIMATED} */
        public static final String DURATION_ESTIMATED = "estimated";
        /** {@code DURATION_FALLBACK} */
        public static final String DURATION_FALLBACK = "fallback";
        /** {@code DURATION_MEASURED} */
        public static final String DURATION_MEASURED = "measured";
        /** {@code INTERLUDE_ASSET_DURATION_SEC} */
        public static final double INTERLUDE_ASSET_DURATION_SEC = 3.0;
        /** {@code JINGLE} */
        public static final String JINGLE = "jingle";
        /** {@code JINGLE_ASSET_URL} */
        public static final String JINGLE_ASSET_URL = "https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav";
        /** {@code JINGLE_DURATION_SEC} */
        public static final double JINGLE_DURATION_SEC = 3.0;
        /** {@code NARRATION} */
        public static final String NARRATION = "narration";
        /** {@code NARRATION_CHARS_PER_SEC} */
        public static final double NARRATION_CHARS_PER_SEC = 17.0;
        /** {@code NARRATION_FALLBACK_SEC} */
        public static final double NARRATION_FALLBACK_SEC = 8.0;
        /** {@code SEGMENT} */
        public static final String SEGMENT = "segment";
    }

    /** {@code player/foray-structure.js} */
    public static final class ForayStructure {
        private ForayStructure() {}

        /** {@code QUEUE_KINDS} */
        public static final List<String> QUEUE_KINDS = Collections.unmodifiableList(Arrays.asList("episode", "tts", "jingle"));
        /** {@code REFUSED_STRUCTURE} */
        public static final String REFUSED_STRUCTURE = "refused-structure";
        /** {@code STRUCTURE_PROBLEMS} */
        public static final List<String> STRUCTURE_PROBLEMS = Collections.unmodifiableList(Arrays.asList("empty", "not-an-object", "no-id", "duplicate-id", "unknown-kind", "no-audio", "bad-bounds", "dai-unanchored", "no-reference", "silent-narration", "no-duration"));
    }

    /** {@code player/html-audio-backend.js} */
    public static final class HtmlAudioBackend {
        private HtmlAudioBackend() {}

        /** {@code PREFETCH_LEAD_SEC} */
        public static final double PREFETCH_LEAD_SEC = 12.0;
    }

    /** {@code player/interlude.js} */
    public static final class Interlude {
        private Interlude() {}

        /** {@code INTERLUDE_ASSET_PATH} */
        public static final String INTERLUDE_ASSET_PATH = "player/assets/interlude-placeholder.wav";
        /** {@code INTERLUDE_ASSET_URL} */
        public static final String INTERLUDE_ASSET_URL = "https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav";
        /** {@code INTERLUDE_CEILING_SEC} */
        public static final double INTERLUDE_CEILING_SEC = 4.5;
        /** {@code INTERLUDE_DURATION_SEC} */
        public static final double INTERLUDE_DURATION_SEC = 3.0;
        /** {@code INTERLUDE_KEY} */
        public static final String INTERLUDE_KEY = "cp_interlude";
        /** {@code INTERLUDE_RATE} */
        public static final double INTERLUDE_RATE = 1.0;
        /** {@code SITE_ROOT} */
        public static final String SITE_ROOT = "https://jw-incorporated.github.io/foray/";
    }

    /** {@code player/media-session.js} */
    public static final class MediaSession {
        private MediaSession() {}

        /** {@code APP_ARTWORK_URL} */
        public static final String APP_ARTWORK_URL = "icon-512.png";
        /** {@code APP_NAME} */
        public static final String APP_NAME = "4a";
        /** {@code MEDIA_ACTIONS} */
        public static final List<String> MEDIA_ACTIONS = Collections.unmodifiableList(Arrays.asList("play", "pause", "stop", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"));
        /** {@code NONE} */
        public static final String NONE = "none";
        /** {@code PAUSED} */
        public static final String PAUSED = "paused";
        /** {@code PLAYING} */
        public static final String PLAYING = "playing";
        /** {@code SEEK_BACKWARD_SEC} */
        public static final double SEEK_BACKWARD_SEC = 15.0;
        /** {@code SEEK_FORWARD_SEC} */
        public static final double SEEK_FORWARD_SEC = 30.0;
    }

    /** {@code player/playback-rate.js} */
    public static final class PlaybackRate {
        private PlaybackRate() {}

        /** {@code DEFAULT_RATE} */
        public static final double DEFAULT_RATE = 1.0;
        /** {@code MAX_RATE} */
        public static final double MAX_RATE = 2.0;
        /** {@code MIN_RATE} */
        public static final double MIN_RATE = 0.75;
        /** {@code RATES} */
        public static final List<Double> RATES = Collections.unmodifiableList(Arrays.asList(0.75, 1.0, 1.25, 1.5, 1.75, 2.0));
        /** {@code RATE_KEY} */
        public static final String RATE_KEY = "cp_rate";
        /** {@code UTTERANCE_CALIBRATION_PERCEIVED} */
        public static final double UTTERANCE_CALIBRATION_PERCEIVED = 3.0;
        /** {@code UTTERANCE_CALIBRATION_REQUESTED} */
        public static final double UTTERANCE_CALIBRATION_REQUESTED = 1.5;
        /** {@code UTTERANCE_DEFAULT_RATE} */
        public static final double UTTERANCE_DEFAULT_RATE = 0.5;
        /** {@code UTTERANCE_MAX_RATE} */
        public static final double UTTERANCE_MAX_RATE = 1.0;
        /** {@code UTTERANCE_MIN_RATE} */
        public static final double UTTERANCE_MIN_RATE = 0.0;
    }

    /** {@code player/position-store.js} */
    public static final class PositionStore {
        private PositionStore() {}

        /** {@code MIN_RESUME_SEC} */
        public static final double MIN_RESUME_SEC = 10.0;
        /** {@code NEAR_END_SEC} */
        public static final double NEAR_END_SEC = 30.0;
        /** {@code POSITION_EVENT_EVERY_SEC} */
        public static final double POSITION_EVENT_EVERY_SEC = 60.0;
    }

    /** {@code player/queue-manager.js} */
    public static final class QueueManager {
        private QueueManager() {}

        /** {@code NARRATION_DEADLINE_FACTOR} */
        public static final double NARRATION_DEADLINE_FACTOR = 1.5;
        /** {@code NARRATION_DEADLINE_MARGIN_SEC} */
        public static final double NARRATION_DEADLINE_MARGIN_SEC = 10.0;
        /** {@code NARRATION_RATE} */
        public static final double NARRATION_RATE = 1.0;
        /** {@code NARRATION_SUSPEND_GAP_MS} */
        public static final double NARRATION_SUSPEND_GAP_MS = 5000.0;
        /** {@code NARRATION_TICK_MS} */
        public static final double NARRATION_TICK_MS = 250.0;
        /** {@code POSITION_INTERVAL_MS} */
        public static final double POSITION_INTERVAL_MS = 15000.0;
        /** {@code POSITION_MIN_DELTA_SEC} */
        public static final double POSITION_MIN_DELTA_SEC = 10.0;
    }

    /** {@code player/queue-state.js} */
    public static final class QueueState {
        private QueueState() {}

        /** {@code END_NATURAL} */
        public static final String END_NATURAL = "natural";
        /** {@code END_OUT_POINT} */
        public static final String END_OUT_POINT = "outPoint";
        /** {@code EPISODE} */
        public static final String EPISODE = "episode";
        /** {@code TTS} */
        public static final String TTS = "tts";
    }

    /** {@code player/seam-gap.js} */
    public static final class SeamGap {
        private SeamGap() {}

        /** {@code AUTO_ADVANCE} */
        public static final String AUTO_ADVANCE = "auto";
        /** {@code SEAM_GAP_SEC} */
        public static final double SEAM_GAP_SEC = 0.5;
        /** {@code USER_ACTION} */
        public static final String USER_ACTION = "user";
    }

    /** {@code player/seek-policy.js} */
    public static final class SeekPolicy {
        private SeekPolicy() {}

        /** {@code AD_PAD_CEILING_SEC} */
        public static final double AD_PAD_CEILING_SEC = 120.0;
        /** {@code APPROXIMATE} */
        public static final String APPROXIMATE = "approximate";
        /** {@code DRIFT_TOLERANCE_SEC} */
        public static final double DRIFT_TOLERANCE_SEC = 30.0;
        /** {@code EXACT} */
        public static final String EXACT = "exact";
        /** {@code FOREIGN} */
        public static final String FOREIGN = "foreign";
        /** {@code OWN} */
        public static final String OWN = "own";
        /** {@code PADDED} */
        public static final String PADDED = "padded";
    }

    /** {@code player/transport-policy.js} */
    public static final class Transport {
        private Transport() {}

        /** {@code INTERRUPTION_REWIND_SEC} */
        public static final double INTERRUPTION_REWIND_SEC = 1.5;

        /** {@code NUDGE} */
        public static final class Nudge {
            private Nudge() {}

            /** {@code NUDGE.SEEK} */
            public static final String SEEK = "seek";
            /** {@code NUDGE.RESTART_LINE} */
            public static final String RESTART_LINE = "restart-line";
            /** {@code NUDGE.SKIP_LINE} */
            public static final String SKIP_LINE = "skip-line";
            /** {@code NUDGE.NONE} */
            public static final String NONE = "none";
        }

        /** {@code PREVIOUS} */
        public static final class Previous {
            private Previous() {}

            /** {@code PREVIOUS.ITEM_BEFORE} */
            public static final String ITEM_BEFORE = "item-before";
            /** {@code PREVIOUS.MANAGER} */
            public static final String MANAGER = "skip-to-previous";
        }

        /** {@code REMOTE_STOP} */
        public static final class RemoteStop {
            private RemoteStop() {}

            /** {@code REMOTE_STOP.CLOSE} */
            public static final String CLOSE = "close";
            /** {@code REMOTE_STOP.PAUSE} */
            public static final String PAUSE = "pause";
        }

        /** {@code RESTART_WINDOW_SEC} */
        public static final double RESTART_WINDOW_SEC = 4.0;

        /** {@code SEEK} */
        public static final class Seek {
            private Seek() {}

            /** {@code SEEK.PEND} */
            public static final String PEND = "pend";
            /** {@code SEEK.SEEK} */
            public static final String SEEK = "seek";
        }

        /** {@code SEEK_END_GUARD_SEC} */
        public static final double SEEK_END_GUARD_SEC = 1.0;
        /** {@code SEEK_INSIDE_END_SEC} */
        public static final double SEEK_INSIDE_END_SEC = 0.25;

        /** {@code TOGGLE} */
        public static final class Toggle {
            private Toggle() {}

            /** {@code TOGGLE.PLAY_RESTORED} */
            public static final String PLAY_RESTORED = "play-restored";
            /** {@code TOGGLE.START_OVER} */
            public static final String START_OVER = "start-over";
            /** {@code TOGGLE.NONE} */
            public static final String NONE = "none";
            /** {@code TOGGLE.LOAD} */
            public static final String LOAD = "load";
            /** {@code TOGGLE.RESUME} */
            public static final String RESUME = "resume";
            /** {@code TOGGLE.PAUSE} */
            public static final String PAUSE = "pause";
        }
    }
}
