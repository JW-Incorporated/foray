// GENERATED FILE - DO NOT EDIT.
// The engine's constants, from the JS reference (docs/native-engine-plan.md §6.7, NE-04).
// Regenerate with `node tools/parity/gen-constants.mjs --write`; tools/parity/gen-constants.test.mjs
// (in npm test) is red while this file disagrees with the JS it comes from.
//
// Namespaced by source module, as EngineConstants.<Module>.<name>, because the
// JS modules reuse names for different rules. Exported by more than one module:
//   DRIFT_TOLERANCE_SEC: ForayProgress, SeekPolicy
//   MAX_AGE_H: EpisodeProgress, ForayProgress
//   MIN_RESUME_SEC: ForayProgress, PositionStore
//   NEAR_END_SEC: ForayProgress, PositionStore
//
// Every JS number is a Double (JavaScript has no other number type). Policy
// ports are separate types (SeamGap, PlaybackRate, ...) that READ these; they
// never redeclare a value here.

import Foundation

public enum EngineConstants {
    /// `player/default-voice.js`
    public enum DefaultVoice {
        /// `DEFAULT_VOICE_NAME`
        public static let defaultVoiceName: String = "Samantha"
        /// `VOICE_LIST_LANG`
        public static let voiceListLang: String = "en"
    }

    /// `player/engine-contract.js`
    public enum EngineContract {
        /// `OWNED_PREFIXES`
        public static let ownedPrefixes: [String] = ["cp_pos:", "cp_foray:", "cp_last_episode"]
    }

    /// `player/episode-progress.js`
    public enum EpisodeProgress {
        /// `KEY`
        public static let key: String = "cp_last_episode"
        /// `MAX_AGE_H`
        public static let maxAgeH: Double = 720
    }

    /// `player/foray-progress.js`
    public enum ForayProgress {
        /// `DRIFT_DROPPED`
        public static let driftDropped: String = "dropped"
        /// `DRIFT_EXACT`
        public static let driftExact: String = "exact"
        /// `DRIFT_MOVED`
        public static let driftMoved: String = "moved"
        /// `DRIFT_TOLERANCE_SEC`
        public static let driftToleranceSec: Double = 1
        /// `DRIFT_UNANCHORED`
        public static let driftUnanchored: String = "unanchored"
        /// `DRIFT_UNVERIFIED`
        public static let driftUnverified: String = "unverified"
        /// `KEY_PREFIX`
        public static let keyPrefix: String = "cp_foray:"
        /// `MAX_AGE_H`
        public static let maxAgeH: Double = 720
        /// `MIN_RESUME_SEC`
        public static let minResumeSec: Double = 20
        /// `NEAR_END_SEC`
        public static let nearEndSec: Double = 45
        /// `SAVE_EVERY_SEC`
        public static let saveEverySec: Double = 5
    }

    /// `player/foray-queue.js`
    public enum ForayQueue {
        /// `DURATION_ESTIMATED`
        public static let durationEstimated: String = "estimated"
        /// `DURATION_FALLBACK`
        public static let durationFallback: String = "fallback"
        /// `DURATION_MEASURED`
        public static let durationMeasured: String = "measured"
        /// `JINGLE`
        public static let jingle: String = "jingle"
        /// `JINGLE_ASSET_URL`
        public static let jingleAssetUrl: String = "https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav"
        /// `JINGLE_DURATION_SEC`
        public static let jingleDurationSec: Double = 1.5
        /// `NARRATION`
        public static let narration: String = "narration"
        /// `NARRATION_CHARS_PER_SEC`
        public static let narrationCharsPerSec: Double = 17
        /// `NARRATION_FALLBACK_SEC`
        public static let narrationFallbackSec: Double = 8
        /// `SEGMENT`
        public static let segment: String = "segment"
    }

    /// `player/html-audio-backend.js`
    public enum HtmlAudioBackend {
        /// `PREFETCH_LEAD_SEC`
        public static let prefetchLeadSec: Double = 12
    }

    /// `player/interlude.js`
    public enum Interlude {
        /// `INTERLUDE_ASSET_PATH`
        public static let interludeAssetPath: String = "player/assets/interlude-placeholder.wav"
        /// `INTERLUDE_ASSET_URL`
        public static let interludeAssetUrl: String = "https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav"
        /// `INTERLUDE_CEILING_SEC`
        public static let interludeCeilingSec: Double = 4.5
        /// `INTERLUDE_DURATION_SEC`
        public static let interludeDurationSec: Double = 3
        /// `INTERLUDE_KEY`
        public static let interludeKey: String = "cp_interlude"
        /// `INTERLUDE_RATE`
        public static let interludeRate: Double = 1
        /// `SITE_ROOT`
        public static let siteRoot: String = "https://jw-incorporated.github.io/foray/"
    }

    /// `player/media-session.js`
    public enum MediaSession {
        /// `APP_ARTWORK_URL`
        public static let appArtworkUrl: String = "icon-512.png"
        /// `APP_NAME`
        public static let appName: String = "4a"
        /// `MEDIA_ACTIONS`
        public static let mediaActions: [String] = ["play", "pause", "stop", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"]
        /// `NONE`
        public static let none: String = "none"
        /// `PAUSED`
        public static let paused: String = "paused"
        /// `PLAYING`
        public static let playing: String = "playing"
        /// `SEEK_BACKWARD_SEC`
        public static let seekBackwardSec: Double = 15
        /// `SEEK_FORWARD_SEC`
        public static let seekForwardSec: Double = 30
    }

    /// `player/playback-rate.js`
    public enum PlaybackRate {
        /// `DEFAULT_RATE`
        public static let defaultRate: Double = 1
        /// `MAX_RATE`
        public static let maxRate: Double = 2
        /// `MIN_RATE`
        public static let minRate: Double = 0.75
        /// `RATES`
        public static let rates: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
        /// `RATE_KEY`
        public static let rateKey: String = "cp_rate"
    }

    /// `player/position-store.js`
    public enum PositionStore {
        /// `MIN_RESUME_SEC`
        public static let minResumeSec: Double = 10
        /// `NEAR_END_SEC`
        public static let nearEndSec: Double = 30
        /// `POSITION_EVENT_EVERY_SEC`
        public static let positionEventEverySec: Double = 60
    }

    /// `player/queue-manager.js`
    public enum QueueManager {
        /// `POSITION_INTERVAL_MS`
        public static let positionIntervalMs: Double = 15000
    }

    /// `player/queue-state.js`
    public enum QueueState {
        /// `END_NATURAL`
        public static let endNatural: String = "natural"
        /// `END_OUT_POINT`
        public static let endOutPoint: String = "outPoint"
        /// `EPISODE`
        public static let episode: String = "episode"
        /// `TTS`
        public static let tts: String = "tts"
    }

    /// `player/seam-gap.js`
    public enum SeamGap {
        /// `AUTO_ADVANCE`
        public static let autoAdvance: String = "auto"
        /// `SEAM_GAP_SEC`
        public static let seamGapSec: Double = 2
        /// `USER_ACTION`
        public static let userAction: String = "user"
    }

    /// `player/seek-policy.js`
    public enum SeekPolicy {
        /// `AD_PAD_CEILING_SEC`
        public static let adPadCeilingSec: Double = 120
        /// `APPROXIMATE`
        public static let approximate: String = "approximate"
        /// `DRIFT_TOLERANCE_SEC`
        public static let driftToleranceSec: Double = 30
        /// `EXACT`
        public static let exact: String = "exact"
        /// `FOREIGN`
        public static let foreign: String = "foreign"
        /// `OWN`
        public static let own: String = "own"
        /// `PADDED`
        public static let padded: String = "padded"
    }

    /// `player/transport-policy.js`
    public enum Transport {
        /// `PREVIOUS`
        public enum Previous {
            /// `PREVIOUS.ITEM_BEFORE`
            public static let itemBefore: String = "item-before"
            /// `PREVIOUS.MANAGER`
            public static let manager: String = "skip-to-previous"
        }
        /// `REMOTE_STOP`
        public enum RemoteStop {
            /// `REMOTE_STOP.CLOSE`
            public static let close: String = "close"
            /// `REMOTE_STOP.PAUSE`
            public static let pause: String = "pause"
        }
        /// `RESTART_WINDOW_SEC`
        public static let restartWindowSec: Double = 4
        /// `SEEK`
        public enum Seek {
            /// `SEEK.PEND`
            public static let pend: String = "pend"
            /// `SEEK.SEEK`
            public static let seek: String = "seek"
        }
        /// `SEEK_END_GUARD_SEC`
        public static let seekEndGuardSec: Double = 1
        /// `SEEK_INSIDE_END_SEC`
        public static let seekInsideEndSec: Double = 0.25
        /// `TOGGLE`
        public enum Toggle {
            /// `TOGGLE.PLAY_RESTORED`
            public static let playRestored: String = "play-restored"
            /// `TOGGLE.START_OVER`
            public static let startOver: String = "start-over"
            /// `TOGGLE.NONE`
            public static let none: String = "none"
            /// `TOGGLE.LOAD`
            public static let load: String = "load"
            /// `TOGGLE.RESUME`
            public static let resume: String = "resume"
            /// `TOGGLE.PAUSE`
            public static let pause: String = "pause"
        }
    }
}
