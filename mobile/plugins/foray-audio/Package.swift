// swift-tools-version: 5.9
import PackageDescription

/* `foray-audio`'s iOS half: a Swift Package in the exact shape
 * `foray-tts/Package.swift` already uses (see that file's own header for why
 * this shape — verified directly against @capacitor/app@8.1.1's own
 * Package.swift, no .xcworkspace, no CocoaPods, since Capacitor 8's iOS
 * template is Swift Package Manager).
 *
 * DISCOVERY: Capacitor's CLI reads `../package.json`'s `capacitor.ios.src`
 * (`ios`, this directory), finds this Package.swift, and folds it into the
 * generated project's own root `Package.swift` on every `cap add ios` /
 * `cap sync`. Nothing here is committed to `mobile/ios/`, which stays
 * gitignored in full per `docs/android-shell-build.md` §1.5.
 *
 * UNLIKE `foray-tts`, this plugin is NOT `foray-audio`'s whole iOS story:
 * the audio-keepalive half (`android/`) stays Android-only per this
 * plugin's `package.json` `"//no-ios"` note (WebKit already keeps
 * backgrounded <audio> alive on iOS by itself). This SwiftPM package is
 * ONLY the L-01 Now Playing / remote-command half: `MPNowPlayingInfoCenter`
 * + `MPRemoteCommandCenter` behind the same `setNowPlaying` contract
 * Android answers.
 *
 * ── THE NATIVE ENGINE'S CORE IS A NESTED PATH DEPENDENCY (NE-01) ───────────
 *
 * `foray-engine-core/` is a PURE SwiftPM package (Foundation only; iOS 15,
 * macOS 12, Linux) holding everything the native playback engine decides
 * (docs/native-engine-plan.md §4.1). It is a separate package, not a target
 * here, because this package links the Capacitor binary framework, which has
 * only iOS slices: nothing in it can run a host `swift test`, and the core
 * must. `ForayAudioPlugin` links `ForayEngineCore`; the plugin's test target
 * links `ForayEngineParity` so the existing `xcodebuild test -scheme
 * ForayAudio` step in `ci.yml`'s `ios-kit` runs the parity library too.
 *
 * It resolves in the APP BUILD because Capacitor's generated CapApp-SPM
 * reaches this directory through npm's `file:` symlink
 * (`mobile/node_modules/foray-audio`), and a relative `.package(path:)` is
 * resolved against the directory this manifest sits in. The first ios-build
 * run after NE-01 recorded the resolution line
 * (docs/ios-native-engine-measurements.md).
 */

/* THE PREFERENCES PIN, AND WHY IT IS BEHIND AN ENVIRONMENT VARIABLE.
 * `ForayAudioPluginTests/CapacitorStoragePrefixTests.swift` writes through
 * `@capacitor/preferences`' own native `Preferences` class and reads raw
 * `UserDefaults`, pinning the `CapacitorStorage.` prefix the engine's shared
 * rows depend on (`SharedRowStore` in the core). That needs the plugin's
 * Swift package, which exists only after `npm ci` in `mobile/`
 * (`mobile/node_modules/@capacitor/preferences`) and is not on any URL SwiftPM
 * can fetch: it lives in a subdirectory of a monorepo.
 *
 * So the test target gains that dependency ONLY when
 * `FORAY_PREFERENCES_PIN=1` is set, which `ci.yml`'s `ios-kit` foray-audio
 * step does after installing `mobile/`'s locked dependencies. Nothing else
 * sets it: the app build (`cap sync` + `xcodebuild -scheme App`) evaluates
 * this manifest with the variable absent, so the graph that ships is exactly
 * the graph without the pin. A pin that silently compiled out would be worse
 * than none, so the same step sets `TEST_RUNNER_FORAY_REQUIRE_PREFERENCES_PIN`
 * and the test FAILS when the variable reached the runner but the module did
 * not. `shell-invariants.test.mjs` pins all three halves.
 */
let preferencesPin = Context.environment["FORAY_PREFERENCES_PIN"] == "1"
var pluginTestDependencies: [Target.Dependency] = [
    "ForayAudioPlugin",
    .product(name: "ForayEngineParity", package: "foray-engine-core")
]
var packageDependencies: [Package.Dependency] = [
    .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    .package(path: "foray-engine-core")
]
if preferencesPin {
    packageDependencies.append(.package(path: "../../node_modules/@capacitor/preferences"))
    pluginTestDependencies.append(.product(name: "CapacitorPreferences", package: "preferences"))
}

let package = Package(
    name: "ForayAudio",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayAudio",
            targets: ["ForayAudioPlugin"])
    ],
    dependencies: packageDependencies,
    targets: [
        .target(
            name: "ForayAudioPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "ForayEngineCore", package: "foray-engine-core")
            ],
            path: "ios/Sources/ForayAudioPlugin"),
        .testTarget(
            name: "ForayAudioPluginTests",
            dependencies: pluginTestDependencies,
            path: "ios/Tests/ForayAudioPluginTests")
    ]
)
