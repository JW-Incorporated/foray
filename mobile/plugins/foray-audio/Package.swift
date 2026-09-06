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
 */
let package = Package(
    name: "ForayAudio",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayAudio",
            targets: ["ForayAudioPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ForayAudioPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ForayAudioPlugin"),
        .testTarget(
            name: "ForayAudioPluginTests",
            dependencies: ["ForayAudioPlugin"],
            path: "ios/Tests/ForayAudioPluginTests")
    ]
)
