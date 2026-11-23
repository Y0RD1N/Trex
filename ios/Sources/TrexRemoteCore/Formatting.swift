import Foundation

// Los mismos textos cortos que la PWA (`timeAgo` y `duration` en remoteProtocol.ts y RemoteApp.tsx).

public enum RemoteFormat {
    /// «ahora», «3 min», «2 h», «ayer», «5 d». Ambos en milisegundos desde 1970.
    public static func timeAgo(_ at: Double, now: Double) -> String {
        guard at > 0 else { return "" }
        let seconds = max(0, ((now - at) / 1000).rounded())
        if seconds < 45 { return "ahora" }
        let minutes = (seconds / 60).rounded()
        if minutes < 60 { return "\(Int(minutes)) min" }
        let hours = (minutes / 60).rounded()
        if hours < 24 { return "\(Int(hours)) h" }
        let days = (hours / 24).rounded()
        return days == 1 ? "ayer" : "\(Int(days)) d"
    }

    /// «42 s», «1 m 12 s», «2 h 5 m».
    public static func duration(_ milliseconds: Double) -> String {
        let seconds = Int(max(0, (milliseconds / 1000).rounded()))
        if seconds < 60 { return "\(seconds) s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) m \(seconds % 60) s" }
        return "\(minutes / 60) h \(minutes % 60) m"
    }

    /// «340 KB», «1.2 MB».
    public static func size(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }

    public static func nowMilliseconds() -> Double {
        Date().timeIntervalSince1970 * 1000
    }
}

/// Las citas de adjuntos que entiende el PC: «[Imagen 1]», «[Archivo 2]».
public enum AttachmentReference: String, Sendable {
    case image = "Imagen"
    case file = "Archivo"

    public func token(_ number: Int) -> String { "[\(rawValue) \(number)]" }

    /// Añade las citas `first+1 … first+count` al final del borrador, separadas por espacios.
    public func append(to text: String, first: Int, count: Int) -> String {
        guard count > 0 else { return text }
        let references = (1...count).map { token(first + $0) }.joined(separator: " ")
        let separator = text.isEmpty || text.last?.isWhitespace == true ? "" : " "
        return "\(text)\(separator)\(references) "
    }

    /// Quita la cita número `number` (desde 1) y renumera las siguientes.
    public func remove(_ number: Int, from text: String, total: Int) -> String {
        var result = text.replacingOccurrences(of: "\(token(number)) ", with: "")
        result = result.replacingOccurrences(of: token(number), with: "")
        if number < total {
            for index in (number + 1)...total {
                result = result.replacingOccurrences(of: token(index), with: token(index - 1))
            }
        }
        return result
    }
}
