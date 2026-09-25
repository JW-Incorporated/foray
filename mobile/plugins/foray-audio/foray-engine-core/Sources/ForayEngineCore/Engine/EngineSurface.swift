import Foundation

// ── WHAT THE LOCK SCREEN AND THE CAR ARE TOLD (card NE-18; plan §4.5) ──────
//
// The two readings the host's surface needs from the core after every turn:
// which remote commands work (`commandSnapshot`, fed to
// `MediaMapping.commandAvailability`) and what Now Playing says
// (`mediaView`, fed to `MediaMapping.sessionView`). Both are READ from the
// state; neither decides anything `MediaMapping` does not already decide, so
// there is one enablement rule and one metadata rule, fixture-pinned by the
// `media-episode` family, and the host's NowPlayingPublisher and RemoteSurface
// only carry the answers to MediaPlayer.
//
// Here and not in the host because NE-20's snapshot needs the same `mode`
// (`none` after a close is the snapshot's word too), and a pure reading runs
// in the host `swift test`.
extension EngineCore {

    /// The Snapshot v1 fields (plan §5.3) that decide which remote commands
    /// work. `mode` is `none` when nothing is current or the listener closed
    /// the player; a Foray reads as `foray` (M2), anything else `episode`.
    public var commandSnapshot: MediaMapping.CommandSnapshot {
        let mode: MediaMapping.CommandSnapshot.Mode
        if state.closed || state.currentItem == nil {
            mode = .unloaded
        } else if state.forayId != nil {
            mode = .foray
        } else {
            mode = .episode
        }
        return MediaMapping.CommandSnapshot(mode: mode, ended: state.stateType == "ended", canNext: canNext,
                                            canPrevious: canPrevious, autoAdvance: state.autoAdvance)
    }

    /// `mediaSessionView`'s input for the current item, as the page's
    /// `episodeMediaView` gathers it (player/client.js), or nil when there is
    /// nothing to show (nothing current, or the player was closed).
    ///
    /// - The playhead and duration are the DECK's while it holds this item,
    ///   else the position the next play will start from (a seek written
    ///   down, the stored position, the item's own start), so a restored
    ///   entry says where play will resume, not 0:00 (qa row 161).
    /// - `playing` is the transport running (`transportIsRunning()`), and a
    ///   load in flight is `buffering`: the OS clock stands still until the
    ///   deck has sound, instead of counting over silence (p-car-8).
    /// - The rate is the listener's; the publisher writes 0 whenever the
    ///   state is not playing (plan §4.5: `playbackState` is never used).
    public func mediaView(deck: DeckReading) -> MediaMapping.View? {
        guard !state.closed, let item = state.currentItem else { return nil }
        let node = item.node
        let loaded = state.loadedId == item.id
        let stored = state.positions[item.id]
        let position = (loaded ? deck.positionSec : nil) ?? state.pendingStartSec ?? stored?.seconds ?? item.startSec ?? 0
        let duration = (loaded ? deck.durationSec : nil) ?? item.durationSec ?? stored?.duration
        let loading: Bool
        switch state.player {
        case .loadingItem, .transitioning: loading = true
        case .idle, .playing, .interrupted, .ended: loading = false
        }
        return MediaMapping.View(
            item: MediaMapping.Item(kind: node["kind"]?.stringValue, title: node["title"]?.stringValue,
                                    show: node["show"]?.stringValue),
            forayTitle: "", index: 0, total: 0,
            showArtworkUrl: node["artwork_url"]?.stringValue,
            durationSec: duration, positionSec: position, playbackRate: state.rate,
            buffering: state.buffering || loading, playing: state.isRunning, inSeamGap: false,
            ended: state.stateType == "ended", foray: state.forayId != nil)
    }
}
