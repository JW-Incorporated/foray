import Foundation
import ForayEngineCore

/// Where an episode's audio was last redirected to, so a RESUME of that
/// episode can attach to it directly (the founder's car report, 2026-10-14).
///
/// ── WHY ───────────────────────────────────────────────────────────────────
///
/// The car's play cold-launched 4a in the background to resume an episode at
/// 3839 s. Its `audio_url` is a measurement prefix (`dts.podtrac.com`) that
/// redirects to the publisher's CDN (`delivery-edge.libsyn.com`). AVFoundation
/// makes several byte-range requests for one load (the probe, the header,
/// the range at the resume point), each against the URL it was given, so
/// each can walk the redirect chain again (download-measurement guidance
/// exists precisely because AppleCoreMedia's repeated range requests reach
/// the prefix), and on a car's cellular link a cold hop is a DNS lookup and
/// a TLS handshake. The load took 6.4 s to its duration; the car gave the
/// route to Spotify at 6.7 s. A resume that attaches to the address the
/// chain ended at last time skips those hops. How much of the 6.4 s that was
/// is NOT measured: the `deck kind=attach resolved=` row and the ready row's
/// `marks` on the next drive say.
///
/// ── WHEN, AND WHY ONLY THEN (docs/brief/05_CORNER_CASES.md #1) ────────────
///
/// "The app downloads via the original URL (publishers count downloads there;
/// we don't cheat their stats)". So the original is ALWAYS what a fresh play
/// fetches, and the resolved address is used only when all of these hold:
///   - the load is a RESUME of a whole episode: unbounded, clip class, and a
///     start past 0 (`eligible`). A play from the top, a Foray clip and a
///     narration line attach their own URL as before;
///   - THIS DEVICE fetched the original within `maxAgeSec` (24 h): the entry
///     is written only by a load that went through the prefix chain, and its
///     age is measured from that load. 24 h is the window download measurement
///     de-duplicates a listener's requests in, so the prefix already counted
///     the listen the resume continues; past it the resume goes through the
///     prefix again, and that load refreshes the entry.
/// A resolved attach that fails before it is ready falls back to the original
/// on the same token (AVDeck's `fail`), and its entry is forgotten; so is the
/// entry of one that passes its deadline or fails mid-play. A signed CDN
/// address that expired costs one fast 403, never a lost play.
///
/// ── WHERE IT IS KEPT ──────────────────────────────────────────────────────
///
/// In memory here, and on disk INSIDE the restore record's key
/// (`ForayEngine.restore`, member `sources`), written by `EngineStore`: a cold
/// launch is a new process, and the restore record is what a car's play reads.
/// The privacy policy's row for that key already names "audio addresses" of
/// the episodes it was playing, "so a car's play button still works"; a new
/// key would be a new disclosure. `RestoreRecord.parse` reads the members it
/// knows and ignores this one, and Delete my data removes the key with it
/// (`EngineStore.purge` also clears this object). Addresses never reach a
/// diagnostics row: the rows carry the host only.
///
/// Main-confined, like the decks that read it.
final class ResolvedSources {
    struct Entry: Equatable {
        /// The load's own `audio_url`, as the core sent it.
        let from: String
        /// The https address the redirect chain ended at.
        let to: String
        /// Wall-clock ms when a load through `from` revealed `to`.
        let atMs: Double
    }

    /// The window in which a resume may skip the prefix chain (see WHEN).
    static let maxAgeSec: Double = 24 * 60 * 60

    /// A queue's current episode and the few around it; a resume needs one.
    static let capacity = 4

    /// The member of the stored restore record that holds the entries.
    static let recordKey = "sources"

    /// Oldest first.
    private(set) var entries: [Entry]
    /// Called after `remember` or `forget` changed the entries (the store
    /// writes them into the restore record). `clear()` does not call it.
    var onChange: (() -> Void)?
    private let wallMs: () -> Double

    init(entries: [Entry] = [], wallMs: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.entries = Array(entries.suffix(Self.capacity))
        self.wallMs = wallMs
    }

    /// A RESUME of a whole episode (see WHEN): the only load that may use a
    /// resolved address.
    static func eligible(startSec: Double, bounded: Bool, deadlineClass: DeckDeadlineClass) -> Bool {
        !bounded && deadlineClass == .clip && startSec.isFinite && startSec > 0
    }

    /// The address to attach for this load instead of `url`, or nil to attach
    /// `url` itself: an eligible load, an entry for `url`, and that entry
    /// younger than `maxAgeSec` (a clock that went backwards reads as stale).
    func target(for url: String, startSec: Double, bounded: Bool, deadlineClass: DeckDeadlineClass) -> String? {
        guard Self.eligible(startSec: startSec, bounded: bounded, deadlineClass: deadlineClass),
              let entry = entries.last(where: { $0.from == url }) else { return nil }
        let ageMs = wallMs() - entry.atMs
        guard ageMs >= 0, ageMs <= Self.maxAgeSec * 1000 else { return nil }
        return entry.to
    }

    /// The address worth keeping from an item's access log: an absolute https
    /// URL with a host, that is not the load's own URL (no redirect, nothing
    /// to keep). A local file is never a source.
    static func candidate(from original: String, accessURI: String?) -> String? {
        guard let accessURI, accessURI != original,
              let url = URL(string: accessURI), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty,
              let source = URL(string: original), source.scheme?.lowercased() != "file" else { return nil }
        return accessURI
    }

    /// A load through `from` ended at `to`, now.
    func remember(from: String, to: String) {
        entries.removeAll { $0.from == from }
        entries.append(Entry(from: from, to: to, atMs: wallMs()))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
        onChange?()
    }

    /// `from`'s resolved address failed or hung: the next load uses `from`.
    func forget(from: String) {
        let before = entries.count
        entries.removeAll { $0.from == from }
        if entries.count != before { onChange?() }
    }

    /// Delete my data: nothing kept, nothing written.
    func clear() {
        entries = []
    }

    // MARK: - The stored form

    /// `[{from, to, at}]`, or nil when there is nothing to keep.
    var node: JSONNode? {
        guard !entries.isEmpty else { return nil }
        return .array(entries.map { entry in
            .object([JSONMember("from", .string(entry.from)), JSONMember("to", .string(entry.to)),
                     JSONMember("at", .number(entry.atMs))])
        })
    }

    /// The entries in a stored restore record's text; anything malformed is
    /// skipped, never guessed at.
    static func entries(inRecord raw: String?) -> [Entry] {
        guard let raw, let row = try? JSONNode.parse(raw), let items = row[recordKey]?.arrayValue else { return [] }
        return items.compactMap { item in
            guard let from = item["from"]?.stringValue, let to = item["to"]?.stringValue,
                  let at = item["at"]?.numberValue, at.isFinite,
                  candidate(from: from, accessURI: to) != nil else { return nil }
            return Entry(from: from, to: to, atMs: at)
        }
    }
}
