import Foundation
import Security
import TrexRemoteCore

/// Un trex emparejado (el PC de la oficina, el de casa…). El token vive en el Llavero
/// (nunca en UserDefaults); cada PC solo guarda su SHA-256 y puede revocarlo cuando quiera.
struct ServerProfile: Codable, Equatable, Identifiable {
    var id: String
    var server: ServerAddress
    var token: String
    /// Cómo conoce ese PC a este iPhone.
    var device: PairedDevice
    /// Nombre del PC que manda trex al conectar (COMPUTERNAME).
    var host: String?
    /// Nombre puesto a mano («Oficina», «Casa»); manda sobre `host`.
    var label: String?
    var pairedAt: Date

    init(server: ServerAddress, token: String, device: PairedDevice) {
        self.id = UUID().uuidString
        self.server = server
        self.token = token
        self.device = device
        self.pairedAt = Date()
    }

    var name: String {
        if let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        if let host, !host.isEmpty { return host }
        return server.display
    }
}

enum CredentialStore {
    private static let service = "app.trex.remote"
    private static let serversAccount = "servers"
    /// Versión 0.1: un solo emparejado. Se migra a la lista la primera vez.
    private static let legacyAccount = "pairing"
    private static let activeKey = "activeServer"
    /// La última dirección usada: así, tras desvincular, no hay que volver a escribirla.
    private static let lastServerKey = "lastServer"

    private struct LegacyCredentials: Codable {
        var server: ServerAddress
        var token: String
        var device: PairedDevice
    }

    static func loadServers() -> [ServerProfile] {
        if let data = read(serversAccount), let list = try? JSONDecoder().decode([ServerProfile].self, from: data) {
            return list
        }
        guard let data = read(legacyAccount), let legacy = try? JSONDecoder().decode(LegacyCredentials.self, from: data) else { return [] }
        let migrated = [ServerProfile(server: legacy.server, token: legacy.token, device: legacy.device)]
        if saveServers(migrated) { delete(legacyAccount) }
        return migrated
    }

    @discardableResult
    static func saveServers(_ servers: [ServerProfile]) -> Bool {
        guard let data = try? JSONEncoder().encode(servers) else { return false }
        delete(serversAccount)
        guard !servers.isEmpty else { return true }
        return write(serversAccount, data)
    }

    static var activeServerID: String? {
        get { UserDefaults.standard.string(forKey: activeKey) }
        set { UserDefaults.standard.set(newValue, forKey: activeKey) }
    }

    static var lastServer: ServerAddress? {
        get {
            guard let data = UserDefaults.standard.data(forKey: lastServerKey) else { return nil }
            return try? JSONDecoder().decode(ServerAddress.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: lastServerKey)
            }
        }
    }

    // MARK: Llavero

    private static func read(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private static func write(_ account: String, _ data: Data) -> Bool {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            // Solo en este iPhone y con él desbloqueado al menos una vez desde que arrancó.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
