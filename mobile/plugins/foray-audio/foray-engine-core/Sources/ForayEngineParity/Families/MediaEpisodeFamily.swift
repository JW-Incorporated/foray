import Foundation
import ForayEngineCore

/// The `media-episode` family against `MediaMapping` (ForayEngineCore/Policy),
/// card NE-12s: the lock-screen mapping and the remote-command table that
/// NE-12j recorded from `player/media-session.js`.
///
/// TWO FIXTURE FILES, TWO JS MODULES, ONE FAMILY. `media-mapping.json` calls
/// media-session.js directly. `media-actions.json` goes through the harness
/// adapter `player/parity/media-actions.js`, because `mediaSessionActions`
/// answers with FUNCTIONS no fixture can hold: the adapter installs a
/// recording surface, presses buttons, and returns `{installed, calls}`. This
/// runner is that adapter's Swift half: it builds a `MediaMapping.Surface`,
/// asks `installedActions`, presses through `intent(for:)`, and writes down the
/// same `{installed, calls}`. A file naming any other module is refused.
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (SeamGapFamily's rule).
/// Every mapping below is one line of JS read literally:
///
///   `{...} = {}`        an absent argument is `{}`; `null` THROWS a TypeError
///                       (destructuring null), and so does it here
///   `x = default`       the default applies to `undefined` ONLY: an explicit
///                       `null` index is "not a number", not 0
///   `typeof s === "string"` / `isNum`
///                       a value of any other type is nil in the typed port
///   `Boolean(view.x)`   JavaScript truthiness (`JSValue.isTruthy`)
///
/// If a mapping here ever has to DECIDE something the JS does not, the port
/// is wrong, not the runner.
public enum MediaEpisodeFamily {
    public static let family = "media-episode"
    public static let mappingModule = "player/media-session.js"
    public static let actionsModule = "player/parity/media-actions.js"

    /// `media-actions.js`'s `SURFACE_METHODS`: the closed set a case may name.
    static let surfaceMethods = ["play", "pause", "stop", "next", "previous", "seekBy", "seekTo"]

    public static let runner: FamilyRunner = makeRunner()

    /// `installedActions` is injectable for ONE reason: so an XCTest can hand
    /// the fixtures a mutant enablement table ("next is offered with no next")
    /// and prove a case goes red (the card's mutation), without a mutant ever
    /// reaching a source file.
    public static func makeRunner(
        installedActions: @escaping (MediaMapping.Surface) -> [MediaAction] = MediaMapping.installedActions
    ) -> FamilyRunner {
        Runner(parts: [mappingRunner, actionsRunner(installedActions)])
    }

    /// Picks the part that ports the file's module. (NE-09 adds a general
    /// multi-module runner; this family keeps its own so the two cards do not
    /// both declare one.)
    struct Runner: FamilyRunner {
        let family = MediaEpisodeFamily.family
        let parts: [PureFamilyRunner]

        func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
            guard let part = parts.first(where: { $0.module == file.module }) else {
                throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift \(family) runner ports "
                    + parts.map(\.module).joined(separator: ", "))
            }
            return try part.run(testCase, in: file, context: context)
        }
    }

    // MARK: - media-session.js

    static let mappingRunner = PureFamilyRunner(
        family: family,
        module: mappingModule,
        reads: [
            "NONE": .string(MediaMapping.none),
            "PAUSED": .string(MediaMapping.paused),
            "PLAYING": .string(MediaMapping.playing),
            "SEEK_BACKWARD_SEC": .number(MediaMapping.seekBackwardSec),
            "SEEK_FORWARD_SEC": .number(MediaMapping.seekForwardSec),
            "APP_ARTWORK_URL": .string(MediaMapping.appArtworkUrl),
            "APP_NAME": .string(MediaMapping.appName),
            // From the port's own enum, not the generated constant: the case
            // pins the order the port INSTALLS in.
            "MEDIA_ACTIONS": .array(MediaAction.allCases.map { .string($0.rawValue) })
        ],
        calls: [
            "artworkUrl": { args in
                .returned(MediaEpisodeFamily.optional(MediaMapping.artworkUrl(MediaEpisodeFamily.arg(args, 0).stringValue)))
            },
            "mediaArtwork": { args in
                // `artworkUrl(url)` runs first and a refused URL returns before
                // `over` is touched, so `over = null` only throws for a good URL.
                let url = MediaEpisodeFamily.arg(args, 0).stringValue
                guard MediaMapping.artworkUrl(url) != nil else { return .returned(.null) }
                let over = MediaEpisodeFamily.arg(args, 1)
                if over == .null { return .threw("TypeError") }
                return .returned(MediaEpisodeFamily.optional(MediaMapping.artwork(url, sizes: over["sizes"].stringValue,
                                                               type: over["type"].stringValue).map(MediaEpisodeFamily.encode)))
            },
            "mediaArtworkList": { args in
                let options = MediaEpisodeFamily.arg(args, 0)
                if options == .null { return .threw("TypeError") }
                let list = MediaMapping.artworkList(showArtworkUrl: options["showArtworkUrl"].stringValue,
                                                    appArtworkUrl: MediaEpisodeFamily.appArtwork(options))
                return .returned(.array(list.map(MediaEpisodeFamily.encode)))
            },
            "mediaMetadata": { args in
                let view = MediaEpisodeFamily.arg(args, 0)
                if view == .null { return .threw("TypeError") }
                let v = MediaEpisodeFamily.decodeView(view)
                return .returned(MediaEpisodeFamily.encode(MediaMapping.metadata(
                    item: v.item, nextItem: v.nextItem, forayTitle: v.forayTitle, index: v.index, total: v.total,
                    showArtworkUrl: v.showArtworkUrl, appArtworkUrl: v.appArtworkUrl)))
            },
            "mediaPositionState": { args in
                let view = MediaEpisodeFamily.arg(args, 0)
                if view == .null { return .threw("TypeError") }
                let v = MediaEpisodeFamily.decodeView(view)
                return .returned(MediaEpisodeFamily.encode(MediaMapping.positionState(
                    durationSec: v.durationSec, positionSec: v.positionSec, playbackRate: v.playbackRate)))
            },
            "mediaPlaybackState": { args in
                let view = MediaEpisodeFamily.arg(args, 0)
                if view == .null { return .threw("TypeError") }
                return .returned(.string(MediaMapping.playbackState(
                    hasItem: view["hasItem"].isTruthy, playing: view["playing"].isTruthy,
                    inSeamGap: view["inSeamGap"].isTruthy, ended: view["ended"].isTruthy)))
            },
            "mediaSessionView": { args in
                // `view = {}`, then `mediaMetadata(view)` destructures it: null throws.
                let view = MediaEpisodeFamily.arg(args, 0)
                if view == .null { return .threw("TypeError") }
                let session = MediaMapping.sessionView(MediaEpisodeFamily.decodeView(view))
                return .returned(.object([
                    "metadata": MediaEpisodeFamily.encode(session.metadata),
                    "positionState": MediaEpisodeFamily.encode(session.positionState),
                    "playbackState": .string(session.playbackState)
                ]))
            }
        ])

    /// A `view` object as media-session.js destructures it. Only an ABSENT
    /// member takes the JS default; anything present that is not the right
    /// type becomes nil, which every function treats as its "not a number" /
    /// "not a string" branch.
    static func decodeView(_ view: JSValue) -> MediaMapping.View {
        func numberOrDefault(_ key: String, _ fallback: Double?) -> Double? {
            view[key] == .undefined ? fallback : view[key].numberValue
        }
        return MediaMapping.View(
            item: MediaEpisodeFamily.item(view["item"]),
            nextItem: MediaEpisodeFamily.item(view["nextItem"]),
            forayTitle: view["forayTitle"] == .undefined ? Optional("") : view["forayTitle"].stringValue,
            index: numberOrDefault("index", 0),
            total: numberOrDefault("total", 0),
            showArtworkUrl: view["showArtworkUrl"].stringValue,
            appArtworkUrl: MediaEpisodeFamily.appArtwork(view),
            durationSec: view["durationSec"].numberValue,
            positionSec: numberOrDefault("positionSec", 0),
            playbackRate: numberOrDefault("playbackRate", 1),
            playing: view["playing"].isTruthy,
            inSeamGap: view["inSeamGap"].isTruthy,
            ended: view["ended"].isTruthy)
    }

    /// `appArtworkUrl = APP_ARTWORK_URL`: absent is our icon, an explicit
    /// null (or any non-string) is no icon at all.
    static func appArtwork(_ view: JSValue) -> String? {
        view["appArtworkUrl"] == .undefined ? Optional(MediaMapping.appArtworkUrl) : view["appArtworkUrl"].stringValue
    }

    /// An item is read only through `item?.kind` / `.title` / `.show`, and its
    /// presence only through `Boolean(view.item)`: a falsy value is no item,
    /// and a truthy non-object is an item with no fields.
    static func item(_ value: JSValue) -> MediaMapping.Item? {
        guard value.isTruthy else { return nil }
        return MediaMapping.Item(kind: value["kind"].stringValue, title: value["title"].stringValue,
                                 show: value["show"].stringValue)
    }

    // MARK: - media-actions.js (the adapter over mediaSessionActions)

    static func actionsRunner(_ installedActions: @escaping (MediaMapping.Surface) -> [MediaAction]) -> PureFamilyRunner {
        PureFamilyRunner(
            family: family,
            module: actionsModule,
            reads: [:],
            calls: [
                "mediaActions": { args in
                    let request = MediaEpisodeFamily.arg(args, 0)
                    if request == .null { return .threw("TypeError") }
                    let surface = try MediaEpisodeFamily.decodeSurface(request["surface"])
                    // `mediaSessionActions(surface, opts)` destructures opts at the
                    // call, after the adapter built its surface.
                    let opts = request["opts"]
                    if opts == .null { return .threw("TypeError") }
                    let steps = MediaMapping.SeekSteps(
                        backwardSec: try MediaEpisodeFamily.step(opts, "seekBackwardSec", MediaMapping.seekBackwardSec),
                        forwardSec: try MediaEpisodeFamily.step(opts, "seekForwardSec", MediaMapping.seekForwardSec))
                    let installed = installedActions(surface)

                    let presses: [JSValue]
                    switch request["presses"] {
                    case .undefined: presses = []
                    case let .array(items): presses = items
                    // `for (const press of presses)`: a string iterates its
                    // characters (none of which is an array), anything else
                    // that is not iterable is a TypeError.
                    case let .string(text) where text.isEmpty: presses = []
                    case .string: throw HarnessError("E_BAD_CASE", "a press is [action] or [action, details], got a string")
                    default: return .threw("TypeError")
                    }

                    var calls: [JSValue] = []
                    for press in presses {
                        guard case let .array(parts) = press, (1...2).contains(parts.count) else {
                            throw HarnessError("E_BAD_CASE", "a press is [action] or [action, details], got \(Codec.encode(press))")
                        }
                        guard let name = parts[0].stringValue, let action = MediaAction(rawValue: name),
                              installed.contains(action) else {
                            throw HarnessError("E_BAD_CASE", "\(Codec.encode(parts[0])) is not installed for this surface; the OS never delivers a press for it")
                        }
                        let details = parts.count == 2 ? parts[1] : .undefined
                        let pressed = MediaMapping.PressDetails(seekTime: details["seekTime"].numberValue,
                                                                close: details["close"] == .bool(true))
                        if let intent = MediaMapping.intent(for: action, details: pressed, steps: steps) {
                            calls.append(MediaEpisodeFamily.encode(intent))
                        }
                    }
                    return .returned(.object([
                        "installed": .array(installed.map { .string($0.rawValue) }),
                        "calls": .array(calls)
                    ]))
                }
            ])
    }

    /// The adapter's `recordingSurface(names)`: an ARRAY names the methods that
    /// exist; anything else is handed to `mediaSessionActions` as is, where
    /// `surface?.[name]` finds no function in any JSON value, so nothing is
    /// installed. An unknown name is a malformed case.
    static func decodeSurface(_ value: JSValue) throws -> MediaMapping.Surface {
        var surface = MediaMapping.Surface()
        guard case let .array(names) = value else { return surface }
        for name in names {
            guard let method = name.stringValue, surfaceMethods.contains(method) else {
                throw HarnessError("E_BAD_CASE", "surface method \(Codec.encode(name)) is not one of \(surfaceMethods.joined(separator: ", "))")
            }
            switch method {
            case "play": surface.play = true
            case "pause": surface.pause = true
            case "stop": surface.stop = true
            case "next": surface.next = true
            case "previous": surface.previous = true
            case "seekBy": surface.seekBy = true
            default: surface.seekTo = true
            }
        }
        return surface
    }

    /// One `opts` step: absent is the default. A present non-number is
    /// refused as a malformed case rather than coerced: JavaScript would run
    /// `-"5"` through ToNumber, and the typed port's steps are Doubles from
    /// `EngineConstants`, so no native caller can ever pass one.
    static func step(_ opts: JSValue, _ key: String, _ fallback: Double) throws -> Double {
        switch opts[key] {
        case .undefined: return fallback
        case let .number(value): return value
        default: throw HarnessError("E_BAD_CASE", "opts.\(key) is not a number; the Swift port's seek steps are typed")
        }
    }

    // MARK: - encoding

    /// `calls.push([name, ...args])`: the surface call an intent is.
    static func encode(_ intent: MediaMapping.Intent) -> JSValue {
        switch intent {
        case .play: return .array([.string("play")])
        case .pause: return .array([.string("pause")])
        // `stop(details?.close === true ? {close: true} : undefined)`: the
        // explicit undefined is an argument, and the fixture records it.
        case let .stop(close): return .array([.string("stop"), close ? .object(["close": .bool(true)]) : .undefined])
        case .previous: return .array([.string("previous")])
        case .next: return .array([.string("next")])
        case let .seekBy(offset): return .array([.string("seekBy"), .number(offset)])
        case let .seekTo(position): return .array([.string("seekTo"), .number(position)])
        }
    }

    /// `{src, sizes?, type?}`: an absent member is absent, not null.
    static func encode(_ artwork: MediaMapping.Artwork) -> JSValue {
        var fields: [String: JSValue] = ["src": .string(artwork.src)]
        if let sizes = artwork.sizes { fields["sizes"] = .string(sizes) }
        if let type = artwork.type { fields["type"] = .string(type) }
        return .object(fields)
    }

    static func encode(_ metadata: MediaMapping.Metadata) -> JSValue {
        .object([
            "title": .string(metadata.title),
            "artist": .string(metadata.artist),
            "album": .string(metadata.album),
            "artwork": .array(metadata.artwork.map(MediaEpisodeFamily.encode))
        ])
    }

    static func encode(_ state: MediaMapping.PositionState?) -> JSValue {
        guard let state else { return .null }
        return .object([
            "duration": .number(state.duration),
            "position": .number(state.position),
            "playbackRate": .number(state.playbackRate)
        ])
    }

    static func optional(_ value: String?) -> JSValue { value.map { .string($0) } ?? .null }
    static func optional(_ value: JSValue?) -> JSValue { value ?? .null }

    /// `args[i]`, where a missing argument is `undefined`.
    static func arg(_ args: [JSValue], _ index: Int) -> JSValue {
        index < args.count ? args[index] : .undefined
    }
}
