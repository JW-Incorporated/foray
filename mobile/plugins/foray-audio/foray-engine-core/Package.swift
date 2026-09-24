// swift-tools-version: 5.9
import PackageDescription

/* The native playback engine's PURE core (docs/native-engine-plan.md §4.1,
 * card NE-01). Foundation only: no UIKit, no AVFoundation, no MediaPlayer, no
 * Capacitor. That one rule is what makes every playback decision the engine
 * takes testable on a host `swift test` (macOS today, Linux in `swift:5.10`
 * once G-1a's `engine-parity` job exists) instead of only inside an iOS
 * Simulator, and it is pinned by `tools/mobile/shell-invariants.test.mjs`,
 * which fails on any other `import` under `Sources/` and on any dependency
 * in this manifest.
 *
 * WHY A NESTED PACKAGE AND NOT A SECOND TARGET IN `../Package.swift`. The
 * plugin package links the Capacitor binary framework, which ships only iOS
 * slices, so nothing in it can be host-tested. A second target there would
 * inherit that. A path dependency is its own package with its own platforms.
 *
 * WHY THE DIRECTORY IS `foray-engine-core` AND NOT `core`. A path dependency
 * takes its package identity from the LAST PATH COMPONENT, and the parent
 * manifest names this package by that identity (`package: "foray-engine-core"`).
 * `core` is generic enough to collide with some future dependency's identity
 * inside the app's CapApp-SPM graph.
 *
 * TWO PRODUCTS, AND WHY THE SECOND ONE IS A LIBRARY.
 *   - `ForayEngineCore`: the reducer, the policies and (later) `EngineCore`.
 *     `ForayAudioPlugin` links it.
 *   - `ForayEngineParity`: decode a parity case, run it against the core,
 *     compare, and return the results AS DATA. It imports no XCTest, because
 *     SwiftPM test targets cannot share sources across packages: the only way
 *     one parity engine runs both here (`Tests/ForayEngineCoreTests`, host
 *     `swift test`) and in `ForayAudioPluginTests` (the existing
 *     `xcodebuild test -scheme ForayAudio` step in `ci.yml`'s `ios-kit`) is to
 *     make it a library each test target wraps thinly. That second wrapper is
 *     the zero-`.github` fallback the plan relies on before G-1a.
 */
let package = Package(
    name: "ForayEngineCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ForayEngineCore", targets: ["ForayEngineCore"]),
        .library(name: "ForayEngineParity", targets: ["ForayEngineParity"])
    ],
    targets: [
        .target(
            name: "ForayEngineCore",
            path: "Sources/ForayEngineCore"),
        .target(
            name: "ForayEngineParity",
            dependencies: ["ForayEngineCore"],
            path: "Sources/ForayEngineParity"),
        .testTarget(
            name: "ForayEngineCoreTests",
            dependencies: ["ForayEngineCore", "ForayEngineParity"],
            path: "Tests/ForayEngineCoreTests")
    ]
)
