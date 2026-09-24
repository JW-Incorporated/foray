import Foundation
import Security

/// The device-only store behind `ForayVault` on iOS (round-2 audit persist-6).
///
/// One Keychain generic-password item per key, under one service name. Two
/// attributes carry the whole promise, and `tools/mobile/foray-vault.test.mjs`
/// pins both:
///
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. "ThisDeviceOnly" items
///   are never migrated to another device: they are not in iCloud Keychain and
///   a backup restored onto another phone does not carry them. "AfterFirstUnlock"
///   keeps the token readable while the phone is locked after its first unlock
///   since boot, so a sync from a backgrounded app still works.
/// - `kSecAttrSynchronizable` false, stated rather than left to the default.
///
/// Values are UTF-8 strings (the JSON the web half writes); keys are the `cp_`
/// row names, stored as the item's account.
public struct KeychainVault {
    public static let defaultService = "ai.jwlabs.foura.vault"

    /// Set in `UserDefaults` the first time the plugin loads in an install.
    /// iOS KEEPS Keychain items when an app is deleted, which the old storage
    /// never did: deleting 4a used to mean the next install started a new
    /// anonymous account. A missing marker means a fresh install (UserDefaults
    /// goes with the app), so the vault is emptied once to keep that true.
    public static let installedMarker = "ai.jwlabs.foura.vault.installed"

    public let service: String

    public init(service: String = KeychainVault.defaultService) {
        self.service = service
    }

    public struct Failure: Error, CustomStringConvertible {
        public let status: OSStatus
        public let operation: String
        public var description: String {
            let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "unknown"
            return "Keychain \(operation) failed: \(status) (\(text))"
        }
    }

    private func baseQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
    }

    private func itemQuery(_ key: String) -> [String: Any] {
        var query = baseQuery()
        query[kSecAttrAccount as String] = key
        return query
    }

    public func set(_ key: String, _ value: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(itemQuery(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = itemQuery(key)
            add[kSecAttrSynchronizable as String] = kCFBooleanFalse
            for (name, attribute) in attributes { add[name] = attribute }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status, operation: "set") }
    }

    public func get(_ key: String) throws -> String? {
        var query = itemQuery(key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status, operation: "get") }
        guard let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func keys() throws -> [String] {
        var query = baseQuery()
        query[kSecReturnAttributes as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw Failure(status: status, operation: "keys") }
        guard let items = out as? [[String: Any]] else { return [] }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }

    public func remove(_ key: String) throws {
        let status = SecItemDelete(itemQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure(status: status, operation: "remove")
        }
    }

    public func removeAll() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure(status: status, operation: "removeAll")
        }
    }

    /// Empty the vault once per install (see `installedMarker`). The marker is
    /// set even when the wipe fails: a wipe retried on every launch would one
    /// day delete the token this install wrote.
    public func forgetIfReinstalled(defaults: UserDefaults) {
        if defaults.bool(forKey: KeychainVault.installedMarker) { return }
        try? removeAll()
        defaults.set(true, forKey: KeychainVault.installedMarker)
    }
}
