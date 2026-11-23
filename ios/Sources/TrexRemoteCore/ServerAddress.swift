import Foundation

/// La dirección del servidor de trex en tu PC (`http://10.8.0.2:7340/` o el `https://` de Tailscale).
public struct ServerAddress: Codable, Hashable, Sendable {
    public static let defaultPort = 7340

    /// Siempre con esquema y terminada en «/».
    public let base: URL

    public init?(base: URL) {
        guard let scheme = base.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = base.host, !host.isEmpty,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = scheme
        components.path = "/"
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        guard let url = components.url else { return nil }
        self.base = url
    }

    /// Lo que escribe la persona: «10.8.0.2», «10.8.0.2:7340», «http://…» o «https://pc.tailnet.ts.net».
    public init?(typed text: String) {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains(" ") else { return nil }
        if !value.contains("://") {
            // Sin esquema: http y el puerto por defecto si no se indica.
            let hostPart = value.split(separator: "/", maxSplits: 1).first.map(String.init) ?? value
            let hasPort = hostPart.range(of: #":\d+$"#, options: .regularExpression) != nil
            value = "http://\(hostPart)\(hasPort ? "" : ":\(Self.defaultPort)")/"
        }
        guard let url = URL(string: value) else { return nil }
        self.init(base: url)
    }

    public var isSecure: Bool { base.scheme == "https" }

    /// «10.8.0.2:7340» para mostrar.
    public var display: String {
        let host = base.host ?? base.absoluteString
        if let port = base.port { return "\(host):\(port)" }
        return host
    }

    public var webSocketURL: URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.scheme = isSecure ? "wss" : "ws"
        components.path = "/api/ws"
        return components.url!
    }

    public var pairURL: URL { endpoint("api/pair") }
    public var uploadURL: URL { endpoint("api/upload") }

    public func iconURL(project: String) -> URL {
        var components = URLComponents(url: endpoint("api/icon"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "project", value: project)]
        return components.url!
    }

    private func endpoint(_ path: String) -> URL {
        URL(string: path, relativeTo: base)!.absoluteURL
    }
}

/// El contenido del QR de emparejado: `http://10.8.0.2:7340/#pair=K7Q4MX`.
public struct PairingLink: Hashable, Sendable {
    public var server: ServerAddress
    public var code: String?

    public init(server: ServerAddress, code: String?) {
        self.server = server
        self.code = code
    }

    public init?(scanned text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), let server = ServerAddress(base: url) else { return nil }
        self.server = server
        let fragment = url.fragment ?? ""
        let code = fragment.split(separator: "&").lazy
            .compactMap { part -> String? in part.hasPrefix("pair=") ? String(part.dropFirst(5)) : nil }
            .first
        self.code = code.map(PairingCode.normalize).flatMap { $0.isEmpty ? nil : $0 }
    }
}

public enum PairingCode {
    public static let length = 6

    /// Como `normalize_code` del servidor: solo letras y números, en mayúsculas.
    public static func normalize(_ value: String) -> String {
        String(value.uppercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }.map(Character.init))
    }
}

/// Como `encodeURIComponent` de JavaScript (para la cabecera `x-file-name`).
public func encodeURIComponent(_ value: String) -> String {
    // Solo ASCII: las letras con tilde y los emojis viajan codificados, como en el navegador.
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}
