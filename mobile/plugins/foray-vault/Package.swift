// swift-tools-version: 5.9
import PackageDescription

/* `foray-vault`'s iOS half, in the exact shape `foray-audio/Package.swift` and
 * `foray-tts/Package.swift` already use (Capacitor 8's iOS template is Swift
 * Package Manager: `cap add ios` / `cap sync` fold this package into the
 * generated project, and nothing is committed to `mobile/ios/`).
 *
 * WHAT IT IS FOR (round-2 audit persist-6, founder ruling 2026-09-24 "Option
 * A"): the anonymous-account token `cp_sb_session` is kept on the device and
 * OUT of the phone's backups. `ForayVaultPlugin.swift` stores it as a Keychain
 * item with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Every other row
 * the app keeps stays where it was (localStorage, IndexedDB, UserDefaults) and
 * is backed up, as the privacy policy now says.
 *
 * No third-party dependency: `Security` is part of the OS, and Capacitor is the
 * same package every plugin here links.
 */
let package = Package(
    name: "ForayVault",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ForayVault",
            targets: ["ForayVaultPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ForayVaultPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ForayVaultPlugin")
    ]
)
