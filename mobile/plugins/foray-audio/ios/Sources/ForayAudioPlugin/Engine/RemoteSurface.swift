import Foundation
import AVFAudio
import MediaPlayer
import ForayEngineCore

/// The real `RemoteCommandRegistering` (card NE-18; docs/native-engine-plan.md
/// §4.2, §4.5): `MPRemoteCommandCenter`, with the engine as its only
/// registrant in native mode (the legacy lane's registration is deferred by
/// EngineOwnership, NE-17).
///
/// It decides NOTHING. Which commands are enabled is
/// `MediaMapping.commandAvailability` of the core's snapshot, applied by the
/// host after every turn; what a press does is the core's; what the system is
/// told is the core's verdict for that press, returned before the handler
/// returns. What lives here is only MediaPlayer:
///
///   - ONE TARGET PER COMMAND: play, pause, togglePlayPause, next, previous,
///     skipBackward, skipForward, changePlaybackPosition and stop. `stop` is
///     registered and never enabled (T-7: a remote stop is a pause, and a
///     car's stop must never tear the player down).
///   - THE SKIP PAIR IS THE FOUNDER'S, FROM `EngineConstants`, AND THE OS'S
///     INTERVAL IS IGNORED. The advertised `preferredIntervals` are
///     `MediaMapping.seekBackwardSec` / `seekForwardSec`; a press carries no
///     value, so the core steps by the same pair whatever interval the head
///     unit put in the event ("Both should be 15/30", 2026-09-23, was a
///     second copy of the pair drifting from the first). No literal step
///     appears in this file, and `shell-invariants.test.mjs` pins that.
///   - MAIN, WITHOUT A HOP WHEN ALREADY ON IT. Apple does not document the
///     thread a handler runs on. On main the press is handled in place; off
///     main it is marked (`onMain: false`, which the core writes as `remote
///     thread=bg`) and run through `DispatchQueue.main.sync`, which cannot
///     deadlock because the caller is not main. Either way the engine hears
///     it inside the host's own turn discipline and the status is the
///     verdict, not a receipt.
///   - THE ROUTE AT THE MOMENT OF THE PRESS. `route=` in the `remote` row is
///     the current output's port type (`carAudio`, `bluetoothA2DP`, ...): the
///     steering-wheel question in NE-27's car script is answered by it.
///
/// ── THE DOCUMENTED STATUS OF A PRESS (RemoteSurfaceTests' truth table) ──────
///
///   pause, stop                      success, always (a stop is a pause)
///   next                             success with a next; else commandFailed (no-next)
///   previous                         success with a current item (it restarts it);
///                                    else commandFailed (no-previous)
///   play, toggle, skip x2, scrub     success with a current item; else
///                                    noActionableNowPlayingItem (not-loaded: the
///                                    cold path with no restore record, plan §4.5)
///
/// A refused activation is commandFailed for any of them (`session-failed:`).
/// The host writes the status as `remote event=status`, after the core's
/// own `remote` row for the press.
final class RemoteSurface: RemoteCommandRegistering {
    private let center: MPRemoteCommandCenter
    private let routePort: () -> String?

    init(center: MPRemoteCommandCenter = .shared(), routePort: @escaping () -> String? = RemoteSurface.currentRoutePort) {
        self.center = center
        self.routePort = routePort
    }

    /// The current route's first output port type. A read of the route, not
    /// a session call: AudioSessionOwner stays the only code that activates.
    static func currentRoutePort() -> String? {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue
    }

    func mpCommand(_ command: MediaMapping.RemoteCommand) -> MPRemoteCommand {
        switch command {
        case .play: return center.playCommand
        case .pause: return center.pauseCommand
        case .togglePlayPause: return center.togglePlayPauseCommand
        case .nextTrack: return center.nextTrackCommand
        case .previousTrack: return center.previousTrackCommand
        case .skipBackward: return center.skipBackwardCommand
        case .skipForward: return center.skipForwardCommand
        case .changePlaybackPosition: return center.changePlaybackPositionCommand
        case .stop: return center.stopCommand
        }
    }

    func addTarget(_ command: MediaMapping.RemoteCommand,
                   handler: @escaping (RemotePress) -> RemoteVerdict) -> EngineObservation {
        switch command {
        case .skipBackward:
            center.skipBackwardCommand.preferredIntervals = [NSNumber(value: MediaMapping.seekBackwardSec)]
        case .skipForward:
            center.skipForwardCommand.preferredIntervals = [NSNumber(value: MediaMapping.seekForwardSec)]
        case .play, .pause, .togglePlayPause, .nextTrack, .previousTrack, .changePlaybackPosition, .stop:
            break
        }
        let target = mpCommand(command)
        let routePort = self.routePort
        let token = target.addTarget { event in
            let verdict = RemoteSurface.deliver(command, value: RemoteSurface.value(of: event, for: command),
                                                routePort: routePort, handler: handler)
            return RemoteSurface.status(verdict)
        }
        return RemoteTarget(command: target, token: token)
    }

    /// `stop` is never enabled, whatever it is asked (T-7). The host never
    /// asks, because `commandAvailability` never offers it.
    func setEnabled(_ enabled: Bool, for command: MediaMapping.RemoteCommand) {
        mpCommand(command).isEnabled = command == .stop ? false : enabled
    }

    // MARK: - The press

    /// What a press carries into the core: `changePlaybackPosition`'s target,
    /// and nothing for any other command. A skip event's `interval` is the
    /// head unit's, and the step is ours (`EngineConstants`).
    static func value(of event: MPRemoteCommandEvent, for command: MediaMapping.RemoteCommand) -> Double? {
        guard command == .changePlaybackPosition else { return nil }
        return (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
    }

    /// Run the handler on main and return its verdict. On main: in place.
    /// Off main: `DispatchQueue.main.sync`, with the press marked `onMain:
    /// false` so the `remote` row says `thread=bg`. The route is read on
    /// main in both cases.
    static func deliver(_ command: MediaMapping.RemoteCommand, value: Double?, routePort: @escaping () -> String?,
                        handler: @escaping (RemotePress) -> RemoteVerdict) -> RemoteVerdict {
        if Thread.isMainThread {
            return MainActor.assumeIsolated {
                handler(RemotePress(command, value: value, routePort: routePort(), onMain: true))
            }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                handler(RemotePress(command, value: value, routePort: routePort(), onMain: false))
            }
        }
    }

    /// The verdict as MediaPlayer's status.
    static func status(_ verdict: RemoteVerdict) -> MPRemoteCommandHandlerStatus {
        switch verdict {
        case .success: return .success
        case .noActionableNowPlayingItem: return .noActionableNowPlayingItem
        case .commandFailed: return .commandFailed
        }
    }
}

/// One `addTarget` registration; cancelling it removes the target.
final class RemoteTarget: EngineObservation {
    private weak var command: MPRemoteCommand?
    private var token: Any?

    init(command: MPRemoteCommand, token: Any) {
        self.command = command
        self.token = token
    }

    var isLive: Bool { token != nil }

    func cancel() {
        guard let token else { return }
        self.token = nil
        command?.removeTarget(token)
    }
}
