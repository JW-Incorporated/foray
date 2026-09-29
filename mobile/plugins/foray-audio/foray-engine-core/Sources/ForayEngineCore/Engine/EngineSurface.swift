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
    public func mediaView(deck: DeckReading, monoMs: Double? = nil) -> MediaMapping.View? {
        guard !state.closed, let item = state.currentItem else { return nil }
        if state.forayId != nil { return forayMediaView(item, deck: deck, monoMs: monoMs) }
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
            buffering: state.buffering || loading, playing: state.isRunning, inSeamGap: state.inSeamGap,
            ended: state.stateType == "ended", foray: state.forayId != nil)
    }

    /// client.js `mediaViewFields`'s FORAY branch (NE-37c: M2 had been
    /// describing a Foray to the lock screen and the car as an episode, so a
    /// spoken line read "4a" with no artist, no line carried the Foray's title,
    /// and the progress bar was the clip's, not the Foray's):
    ///
    /// - the item and the one after it (a line's "Up next:"), the Foray's
    ///   title, and "clip n of N";
    /// - the FORAY's clock: its runtime as the duration, and the playhead on
    ///   it (a spoken line's wall clock, the deck's while it holds the item,
    ///   else the item's own start), as the page reports it;
    /// - `buffering` is the deck's stall latch, plus a clip load in flight
    ///   (silence), and a bridge only while it is still loading or its speak()
    ///   is unanswered. A line that is SOUNDING in `transitioning` counts on:
    ///   treating every bridge as a load published rate 0 for the whole line,
    ///   and the car stopped its clock through every narration seam.
    func forayMediaView(_ item: EngineItem, deck: DeckReading, monoMs: Double?) -> MediaMapping.View {
        func mediaItem(_ engineItem: EngineItem) -> MediaMapping.Item {
            MediaMapping.Item(kind: engineItem.node["kind"]?.stringValue, title: engineItem.node["title"]?.stringValue,
                              show: engineItem.node["show"]?.stringValue)
        }
        let index = Swift.max(0, state.currentIndex)
        let next = state.queue.indices.contains(index + 1) ? state.queue[index + 1] : nil
        let items = state.queue.map { Optional($0.forayItem) }
        let starts = ForayClock.segmentStarts(items)
        let playhead: Double?
        let speaking = state.narration.map { $0.itemId == item.id && state.loadedId == item.id } ?? false
        if speaking, let line = state.narration {
            playhead = monoMs.map { line.elapsedSec(atMono: $0) }
        } else if state.loadedId == item.id {
            playhead = deck.positionSec
        } else if let pending = state.pendingLoad, pending.itemId == item.id {
            playhead = pending.startSec
        } else {
            playhead = nil
        }
        let position: Double
        if let playhead, playhead.isFinite {
            position = ForayClock.forayElapsed(items, index: Double(index), playheadSec: playhead)
        } else {
            position = starts.indices.contains(index) ? starts[index] : 0
        }
        let loading: Bool
        switch state.player {
        case .loadingItem: loading = true
        case .transitioning: loading = state.pendingLoad != nil
        case .idle, .playing, .interrupted, .ended: loading = false
        }
        return MediaMapping.View(
            item: mediaItem(item), nextItem: next.map(mediaItem), forayTitle: state.forayTitle ?? "",
            index: Double(index), total: Double(state.queue.count),
            showArtworkUrl: item.node["artwork_url"]?.stringValue,
            durationSec: ForayClock.forayRuntimeSec(items), positionSec: position,
            // THE RATE THE PLAYHEAD REALLY MOVES AT (client.js: "the element's
            // real rate, not the chosen one"): the OS extrapolates position +
            // rate x wall between writes. A SPOKEN line runs at 1x on the wall
            // clock (corner case #18, D2 keeps it), whatever the listener's
            // speed, so it says 1; a clip and a rendered line say the listener's.
            playbackRate: speaking ? 1 : state.rate,
            buffering: state.buffering || loading, playing: state.isRunning, inSeamGap: state.inSeamGap,
            ended: state.stateType == "ended", foray: true)
    }
}
