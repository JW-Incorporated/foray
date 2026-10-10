// swift-tools-version: 5.9
import PackageDescription

/* `foray-notify`'s iOS half, in the exact shape `foray-downloads/Package.swift`
 * and `foray-vault/Package.swift` already use (Capacitor 8's iOS template is
 * Swift Package Manager: `cap sync` folds a declared plugin's package into the
 * generated project, and nothing is committed to `mobile/ios/`).
 *
 * WHAT IT IS FOR (issue #761; docs/roadmap/player-features.md PQ-28): a
 * followed show's new episode becomes a local notification, found by a
 * background app refresh (`BGTaskScheduler`) that asks the same endpoint the
 * show page does, and a tap on it opens the show. The rules live in
 * `AlertsRefresh.swift` (`AlertRules`, pure), so the test target below checks
 * them, and a whole refresh pass, without a network or a phone.
 *
 * NOT DECLARED YET. `mobile/package.json` does not name this plugin (PQ-30
 * does, with the plist keys), so no shell compiles it and nothing ships. The
 * test target runs in `ci.yml`'s `ios-kit` job, in the `swift test
 * (foray-notify, iOS Simulator)` step beside foray-downloads': the package
 * links Capacitor, which ships iOS slices only, so a host `swift test`
 * cannot build it.
 *
 * NO RESOURCES. A SwiftPM resource on a shipping target makes SwiftPM emit a
 * resource bundle that cannot take the signed archive's provisioning profile
 * (shell-invariants.test.mjs, 2026-09-29); this target has none.
 *
 * No third-party dependency: `UserNotifications`, `BackgroundTasks` and
 * `Foundation` are part of the OS, and Capacitor is the same package every
 * plugin here links.
 */
let package = Package(
    name: "ForayNotify",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayNotify",
            targets: ["ForayNotifyPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ForayNotifyPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ForayNotifyPlugin"),
        .testTarget(
            name: "ForayNotifyPluginTests",
            dependencies: ["ForayNotifyPlugin"],
            path: "ios/Tests/ForayNotifyPluginTests")
    ]
)
