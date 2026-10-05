// swift-tools-version: 5.9
import PackageDescription

/* `foray-downloads`'s iOS half, in the exact shape `foray-vault/Package.swift`
 * and `foray-tts/Package.swift` already use (Capacitor 8's iOS template is Swift
 * Package Manager: `cap add ios` / `cap sync` fold this package into the
 * generated project, and nothing is committed to `mobile/ios/`).
 *
 * WHAT IT IS FOR (issue #29; docs/roadmap/player-features.md PQ-20): an
 * episode downloaded for offline listening, fetched by a background
 * `URLSession` into `Application Support/foray-downloads/` and kept out of
 * backups. The rules live in `DownloadPolicy.swift`, pure, so the test target
 * below checks them without a network.
 *
 * NOT YET COMPILED ANYWHERE. `mobile/package.json` does not declare this
 * plugin until PQ-21, so `ios-build.yml`'s `cap sync` does not fold it in, and
 * `ci.yml`'s `ios-kit` runs only the packages it names (foray-audio,
 * foray-tts). The test target runs once a `swift test (foray-downloads, iOS
 * Simulator)` step is added there, mirroring foray-tts's.
 *
 * No third-party dependency: `CryptoKit` and `Foundation` are part of the OS,
 * and Capacitor is the same package every plugin here links.
 */
let package = Package(
    name: "ForayDownloads",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayDownloads",
            targets: ["ForayDownloadsPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ForayDownloadsPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ForayDownloadsPlugin"),
        .testTarget(
            name: "ForayDownloadsPluginTests",
            dependencies: ["ForayDownloadsPlugin"],
            path: "ios/Tests/ForayDownloadsPluginTests")
    ]
)
