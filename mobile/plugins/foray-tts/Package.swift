// swift-tools-version: 5.9
import PackageDescription

/* `foray-tts`'s iOS half: a Swift Package, same shape Capacitor 8's own
 * generated plugins use (verified directly against @capacitor/app@8.1.1's
 * own Package.swift -- `docs/ios-ci.md` §"the other thing it found" already
 * established that Capacitor 8's iOS template is Swift Package Manager, with
 * no `.xcworkspace` and no CocoaPods, so this plugin follows that shape
 * rather than inventing a podspec nobody would consume).
 *
 * DISCOVERY: Capacitor's CLI reads `../package.json`'s `capacitor.ios.src`
 * (`ios`, this directory), finds this Package.swift, and folds it into the
 * generated project's own root `Package.swift` on every `cap add ios` /
 * `cap sync` -- the iOS-side equivalent of what `foray-audio/android/build.gradle`'s
 * own header documents for Gradle. Nothing here is committed to `mobile/ios/`,
 * which stays gitignored in full per `docs/android-shell-build.md` §1.5.
 */
let package = Package(
    name: "ForayTts",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayTts",
            targets: ["ForayTtsPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        /* ONNX Runtime, for K-01's measurement engine
           (`ios/Sources/ForayTtsPlugin/KokoroOrtProbeEngine.swift`).
           MIT-licensed, and already carried in
           `docs/legal/third-party-notices.md`.

           WHY AN EXACT PIN AND NOT `from:`. SPM's `from:` resolves to the
           newest compatible release at build time, so two runs of the same
           commit could link two different runtimes — and the number this whole
           card exists to produce is a TIMING. A measurement whose runtime
           version is not in the diff is not a measurement.

           WHY THIS PACKAGE AND NOT sherpa-onnx: sherpa's TTS API takes TEXT
           and runs a GPL-3 text front end on it internally, which is the one
           dependency deck §4 is built to keep off the phone. ORT takes tensors
           and has no opinion about text.

           THE FRONT END IS NOT NAMED IN THIS FILE ON PURPOSE.
           `test/release-gates.test.js` greps every native build input for the
           three names a GPL text front end travels under, comments included,
           because the only way one reaches an App Store binary is by first
           appearing in a manifest like this one. A gate that a comment can
           satisfy is not a gate; a gate a comment can BREAK is working, and
           the cost of that is exactly this paragraph. The names are spelled
           out in `docs/legal/third-party-notices.md` under "What is
           deliberately NOT here". */
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager",
                 exact: "1.20.0")
    ],
    targets: [
        .target(
            name: "ForayTtsPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")
            ],
            path: "ios/Sources/ForayTtsPlugin"),
        .testTarget(
            name: "ForayTtsPluginTests",
            dependencies: ["ForayTtsPlugin"],
            path: "ios/Tests/ForayTtsPluginTests")
    ]
)
