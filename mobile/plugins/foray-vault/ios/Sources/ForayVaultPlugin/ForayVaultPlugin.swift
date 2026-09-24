import Foundation
import Capacitor

/// `ForayVault` on iOS: the four calls `player/durable-store.js`'s `vaultTier()`
/// makes, answered from `KeychainVault` (round-2 audit persist-6; founder
/// ruling 2026-09-24, "Option A": the auth token stays on the device and out of
/// backups).
///
/// The method names and shapes copy `@capacitor/preferences` on purpose, so the
/// web half reads both native tiers with one adapter:
///   keys()            -> { keys: [String] }
///   get({ key })      -> { value: String | null }
///   set({ key, value })
///   remove({ key })
/// A Keychain error REJECTS the call. The store counts that as a fault of this
/// tier: a failed write leaves the old copies where they were, and a failed read
/// is "could not look", never "there is no account".
@objc(ForayVaultPlugin)
public class ForayVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForayVaultPlugin"
    public let jsName = "ForayVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let vault = KeychainVault()

    override public func load() {
        vault.forgetIfReinstalled(defaults: UserDefaults.standard)
    }

    @objc func keys(_ call: CAPPluginCall) {
        do {
            call.resolve(["keys": try vault.keys()])
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("ForayVault.get needs a key")
            return
        }
        do {
            let value = try vault.get(key)
            call.resolve(["value": value as Any])
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("ForayVault.set needs a key and a string value")
            return
        }
        do {
            try vault.set(key, value)
            call.resolve()
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("ForayVault.remove needs a key")
            return
        }
        do {
            try vault.remove(key)
            call.resolve()
        } catch {
            call.reject(String(describing: error))
        }
    }
}
