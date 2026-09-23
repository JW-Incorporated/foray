import SwiftUI
import ForayKit

// MARK: - NowPlayingView (skeleton)
//
// Per the task brief this is explicitly a skeleton: it lays out the
// required surface (why-card, big transport controls, hold-to-talk
// affordance, speed) and wires the transport buttons through to
// `PlayerQueueManager`, but does NOT yet build a real `PlayableItem` queue
// from downloaded audio — there is no DownloadManager in this scaffold, so
// there is no local file to actually play yet. See ios/README.md
// "What's implemented vs. stubbed."
//
// Design follows 04_VOICE_AUDIO_SPEC.md "Safety framing": every action here
// must also be reachable eyes-free. The hold-to-talk button is the
// eyes-free entry point for everything else on this screen (skip,
// more-like-this, save, etc. — see ForayKit's `IntentGrammar`); it
// is rendered here as a large, unmissable affordance even though the
// speech pipeline behind it (`VoiceController`) isn't implemented yet.
struct NowPlayingView: View {
    let card: SessionCard

    @EnvironmentObject private var sessionStore: SessionStore
    @Environment(\.playerQueueManager) private var playerQueueManager

    /// Optimistic local UI state. A fuller implementation would observe
    /// `PlayerQueueManager`'s state via an `AsyncStream`/polling bridge
    /// exposed by the actor and publish it to a `@MainActor` view model;
    /// not built in this scaffold (see README) since it requires a real
    /// queue to observe anything meaningful.
    @State private var isPlaying = false
    @State private var isHoldingToTalk = false

    private var episode: Episode? {
        sessionStore.episode(for: card.episodeID)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(card.archetypeLabel.uppercased())
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    Text(episode?.title ?? card.episodeID)
                        .font(.title2.weight(.bold))
                    if let show = episode?.show {
                        Text(show)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // The "why" card — always visible, never requires a tap to
                // reveal, per 03_CURATION_SPEC.md ("the one-line 'why'
                // shown on each card") and the no-glancing-required safety
                // framing (it's fine to read while parked; it must never be
                // the ONLY way to know what's playing while driving — that's
                // what the spoken intro is for).
                VStack(alignment: .leading, spacing: 6) {
                    Text(card.whyLine)
                        .font(.body)
                    Text(card.fitLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.thinMaterial))

                progressPlaceholder

                transportControls

                holdToTalkButton

                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .navigationTitle("Now Playing")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Progress

    private var progressPlaceholder: some View {
        VStack(spacing: 6) {
            ProgressView(value: 0)
                .tint(.accentColor)
            HStack {
                Text("0:00")
                Spacer()
                if let minutes = episode?.durationMin {
                    Text("\(minutes) min")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: Transport
    //
    // Every button here is oversized (≥64pt) per 01_PROMPT.md hard
    // constraint #6 and mirrors what MPRemoteCommandCenter exposes
    // (PlayerQueueManager.configureRemoteCommands()) — the on-screen and
    // lock-screen/steering-wheel controls are two skins on the same set of
    // manager methods, never divergent behavior.
    private var transportControls: some View {
        HStack(spacing: 32) {
            transportButton(systemName: "gobackward.15") {
                // AUDIT: MPRemoteCommandCenter uses ±30/15s
                // (skipForward/skipBackward); this on-screen control isn't
                // wired to PlayerQueueManager.seekRelative (private to the
                // actor) — expose a public seek entry point if on-screen
                // scrubbing ships before the remote-command path is fully
                // validated.
            }

            transportButton(systemName: "backward.end.fill") {
                Task { await playerQueueManager?.skipToPrevious() }
            }

            transportButton(systemName: isPlaying ? "pause.circle.fill" : "play.circle.fill", size: 64) {
                Task {
                    if isPlaying {
                        await playerQueueManager?.pause()
                    } else {
                        await playerQueueManager?.resume()
                    }
                    isPlaying.toggle()
                }
            }

            transportButton(systemName: "forward.end.fill") {
                Task { await playerQueueManager?.skipToNext() }
            }

            transportButton(systemName: "goforward.30") {
                // See AUDIT above on gobackward.15.
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func transportButton(systemName: String, size: CGFloat = 44, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size))
                .frame(minWidth: 64, minHeight: 64)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Hold-to-talk
    //
    // Path A from 04_VOICE_AUDIO_SPEC.md. This scaffold renders the
    // affordance and the press/release state transition but does NOT
    // implement the actual duck+record+SFSpeechRecognizer pipeline
    // (VoiceController — not part of this deliverable; see README). The
    // button is deliberately huge and sits at the bottom of the screen,
    // the single most one-hand-reachable spot, matching its role as the
    // primary in-app voice entry point while driving.
    private var holdToTalkButton: some View {
        VStack(spacing: 8) {
            Circle()
                .fill(isHoldingToTalk ? Color.accentColor : Color.accentColor.opacity(0.15))
                .frame(width: 96, height: 96)
                .overlay(
                    Image(systemName: "mic.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(isHoldingToTalk ? Color.white : Color.accentColor)
                )
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in isHoldingToTalk = true }
                        .onEnded { _ in isHoldingToTalk = false }
                )
            Text(isHoldingToTalk ? "Listening…" : "Hold to talk")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    NavigationStack {
        NowPlayingView(card: SessionCard(
            slot: 1,
            archetype: .deepLearn,
            archetypeLabel: "Go deep",
            episodeID: "lex-353-whyte",
            whyLine: "Your fusion-reactor tour opens with SPARC's co-founder.",
            fitLine: "194 min (≈ 129 at 1.5×).",
            alternates: []
        ))
    }
    .environmentObject({
        let store = SessionStore()
        store.loadSampleSession()
        return store
    }())
}
