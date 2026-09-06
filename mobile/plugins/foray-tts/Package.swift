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
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ForayTtsPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ForayTtsPlugin"),
        .testTarget(
            name: "ForayTtsPluginTests",
            dependencies: ["ForayTtsPlugin"],
            path: "ios/Tests/ForayTtsPluginTests")
    ]
)
