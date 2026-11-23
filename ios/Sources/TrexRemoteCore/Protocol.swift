import Foundation

// Mensajes del WebSocket `/api/ws` (ver `connection` y `handle_client` en remote.rs).

/// Lo que manda el PC.
public enum ServerMessage: Sendable {
    case ready(host: String, device: PairedDevice, version: String?)
    case denied(reason: String?)
    case sessions([RemoteSession])
    case detail(session: String, RemoteDetail)
    case theme(RemoteTheme)
    /// Todos los proyectos y los perfiles para abrir chats (trex con peticiones; los anteriores no lo mandan).
    case catalog(RemoteCatalog)
    case pong
    case result(request: Int, ok: Bool, error: String?, data: RequestData?)
    case unknown

    private enum Keys: String, CodingKey {
        case type, host, device, version, error, sessions, session, detail, theme, catalog, req, ok, data
    }

    private struct Envelope: Decodable {
        let message: ServerMessage

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch c.value(.type, default: "") {
            case "ready":
                message = .ready(host: c.value(.host, default: ""),
                                 device: c.value(.device, default: PairedDevice(id: "", name: "")),
                                 version: try? c.decodeIfPresent(String.self, forKey: .version))
            case "denied":
                message = .denied(reason: try? c.decodeIfPresent(String.self, forKey: .error))
            case "sessions":
                message = .sessions(c.lossy(.sessions))
            case "detail":
                guard let session = try? c.decode(String.self, forKey: .session),
                      let detail = try? c.decode(RemoteDetail.self, forKey: .detail) else { message = .unknown; return }
                message = .detail(session: session, detail)
            case "theme":
                guard let theme = try? c.decode(RemoteTheme.self, forKey: .theme) else { message = .unknown; return }
                message = .theme(theme)
            case "catalog":
                guard let catalog = try? c.decode(RemoteCatalog.self, forKey: .catalog) else { message = .unknown; return }
                message = .catalog(catalog)
            case "pong":
                message = .pong
            case "result":
                message = .result(request: c.value(.req, default: -1), ok: c.value(.ok, default: false),
                                  error: try? c.decodeIfPresent(String.self, forKey: .error),
                                  data: try? c.decodeIfPresent(RequestData.self, forKey: .data))
            default:
                message = .unknown
            }
        }
    }

    /// nil si el texto no es JSON.
    public static func decode(_ data: Data) -> ServerMessage? {
        try? JSONDecoder().decode(Envelope.self, from: data).message
    }

    public static func decode(_ text: String) -> ServerMessage? {
        decode(Data(text.utf8))
    }
}

public struct PairedDevice: Codable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Una respuesta a una pregunta del agente (`RemoteChoice`).
public struct RemoteChoice: Codable, Hashable, Sendable {
    public var question: String
    public var selected: [String]
    public var other: String

    public init(question: String, selected: [String] = [], other: String = "") {
        self.question = question
        self.selected = selected
        self.other = other
    }

    public var isAnswered: Bool {
        !selected.isEmpty || !other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Órdenes para una sesión (`PhoneAction` de la PWA).
public enum PhoneAction: Sendable, Hashable {
    /// Los adjuntos van como ids de lo ya subido con `/api/upload`.
    case send(text: String, attachments: [String])
    case answer(item: String, allowed: Bool, remember: Bool, choices: [RemoteChoice]?)
    case interrupt

    var json: [String: Any] {
        switch self {
        case .send(let text, let attachments):
            return ["kind": "send", "text": text, "attachments": attachments]
        case .answer(let item, let allowed, let remember, let choices):
            let encoded: Any = choices.map { list in
                list.map { ["question": $0.question, "selected": $0.selected, "other": $0.other] as [String: Any] }
            } ?? NSNull()
            return ["kind": "answer", "item": item, "allowed": allowed, "remember": remember, "choices": encoded]
        case .interrupt:
            return ["kind": "interrupt"]
        }
    }
}

/// Lo que manda el móvil, ya como texto JSON.
public enum ClientMessage {
    public static func hello(token: String) -> String {
        encode(["type": "hello", "token": token])
    }

    public static func ping() -> String {
        encode(["type": "ping"])
    }

    /// `nil` deja de mirar cualquier sesión.
    public static func watch(_ session: String?) -> String {
        encode(["type": "watch", "session": session.map { $0 as Any } ?? NSNull()])
    }

    public static func command(request: Int, session: String, action: PhoneAction) -> String {
        encode(["type": "command", "req": request, "session": session, "action": action.json])
    }

    public static func request(_ request: Int, _ action: PhoneRequest) -> String {
        encode(["type": "request", "req": request, "action": action.json])
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Catálogo y peticiones sin sesión

/// Todos los proyectos del PC (con su favorito y su orden) y los perfiles con los que se abre un chat.
public struct RemoteCatalog: Decodable, Hashable, Sendable {
    public struct Project: Decodable, Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var path: String
        public var favorite: Bool
        public var order: Double

        public init(id: String, name: String, path: String = "", favorite: Bool = false, order: Double = 0) {
            self.id = id
            self.name = name
            self.path = path
            self.favorite = favorite
            self.order = order
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.value(.name, default: id)
            path = c.value(.path, default: "")
            favorite = c.value(.favorite, default: false)
            order = c.value(.order, default: .greatestFiniteMagnitude)
        }

        private enum CodingKeys: String, CodingKey { case id, name, path, favorite, order }

        public var asProject: RemoteProject { RemoteProject(id: id, name: name, path: path, order: order) }
    }

    public struct Profile: Decodable, Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var provider: String
        public var isDefault: Bool
        /// Modos de permisos del asistente («Solo lectura», «Preguntar»…).
        public var modes: [PermissionMode]
        /// El que heredaría un chat nuevo en el PC ahora mismo.
        public var mode: String?

        public init(id: String, name: String, provider: String, isDefault: Bool = false, modes: [PermissionMode] = [], mode: String? = nil) {
            self.id = id
            self.name = name
            self.provider = provider
            self.isDefault = isDefault
            self.modes = modes
            self.mode = mode
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.value(.name, default: id)
            provider = c.value(.provider, default: "")
            isDefault = c.value(.isDefault, default: false)
            modes = c.lossy(.modes)
            mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        }

        private enum CodingKeys: String, CodingKey { case id, name, provider, isDefault, modes, mode }
    }

    public struct PermissionMode: Decodable, Hashable, Sendable, Identifiable {
        public var value: String
        public var label: String
        public var description: String
        public var id: String { value }

        public init(value: String, label: String, description: String = "") {
            self.value = value
            self.label = label
            self.description = description
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            value = try c.decode(String.self, forKey: .value)
            label = c.value(.label, default: value)
            description = c.value(.description, default: "")
        }

        private enum CodingKeys: String, CodingKey { case value, label, description }
    }

    public var projects: [Project]
    public var profiles: [Profile]

    public init(projects: [Project], profiles: [Profile]) {
        self.projects = projects
        self.profiles = profiles
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = c.lossy(.projects)
        profiles = c.lossy(.profiles)
    }

    private enum CodingKeys: String, CodingKey { case projects, profiles }

    /// El perfil predeterminado del PC (o el primero).
    public var defaultProfile: Profile? { profiles.first(where: \.isDefault) ?? profiles.first }
}

/// Una conversación guardada que se puede retomar.
public struct SavedConversation: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    /// Milisegundos desde 1970.
    public var updatedAt: Double

    public init(id: String, title: String, updatedAt: Double) {
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.value(.title, default: "Conversación")
        updatedAt = c.value(.updatedAt, default: 0)
    }

    private enum CodingKeys: String, CodingKey { case id, title, updatedAt }
}

/// Un nivel de esfuerzo de razonamiento («Alto: Razona a fondo antes de actuar.»).
public struct EffortOption: Decodable, Hashable, Sendable, Identifiable {
    public var value: String
    public var label: String
    public var hint: String
    public var id: String { value }

    public init(value: String, label: String, hint: String = "") {
        self.value = value
        self.label = label
        self.hint = hint
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decode(String.self, forKey: .value)
        label = c.value(.label, default: value)
        hint = c.value(.hint, default: "")
    }

    private enum CodingKeys: String, CodingKey { case value, label, hint }
}

/// Un modelo que ofrece un perfil (el mismo catálogo que «Continuar con otro asistente»),
/// con los niveles de esfuerzo que admite y su velocidad rápida, si la tiene.
public struct ModelOption: Decodable, Hashable, Sendable, Identifiable {
    public var value: String
    public var label: String
    public var description: String
    public var featured: Bool
    public var efforts: [EffortOption]
    /// Esfuerzo que usa el modelo si no se elige otro.
    public var defaultEffort: String?
    /// Qué supone la velocidad rápida («2× más rápido; gasta más uso del plan.»); nil si no la admite.
    public var fastHint: String?
    public var id: String { value }

    public init(value: String, label: String, description: String = "", featured: Bool = false,
                efforts: [EffortOption] = [], defaultEffort: String? = nil, fastHint: String? = nil) {
        self.value = value
        self.label = label
        self.description = description
        self.featured = featured
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.fastHint = fastHint
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decode(String.self, forKey: .value)
        label = c.value(.label, default: value)
        description = c.value(.description, default: "")
        featured = c.value(.featured, default: false)
        efforts = c.lossy(.efforts)
        defaultEffort = try? c.decodeIfPresent(String.self, forKey: .defaultEffort)
        fastHint = (try? c.decodeIfPresent(FastInfo.self, forKey: .fast))?.hint
    }

    private struct FastInfo: Decodable {
        var hint: String
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hint = c.value(.hint, default: "Respuestas más rápidas.")
        }
        private enum CodingKeys: String, CodingKey { case hint }
    }

    private enum CodingKeys: String, CodingKey { case value, label, description, featured, efforts, defaultEffort, fast }

    public var supportsFast: Bool { fastHint != nil }
}

/// Los datos de la respuesta a una petición (cada una rellena lo suyo).
public struct RequestData: Decodable, Hashable, Sendable {
    /// El chat abierto (petición `open`).
    public var session: String?
    /// El chat se abrió pero el primer mensaje no se pudo enviar.
    public var warning: String?
    public var conversations: [SavedConversation]?
    public var models: [ModelOption]?

    public init(session: String? = nil, warning: String? = nil, conversations: [SavedConversation]? = nil, models: [ModelOption]? = nil) {
        self.session = session
        self.warning = warning
        self.conversations = conversations
        self.models = models
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try? c.decodeIfPresent(String.self, forKey: .session)
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
        conversations = (try? c.decodeIfPresent(LossyArray<SavedConversation>.self, forKey: .conversations))?.values
        models = (try? c.decodeIfPresent(LossyArray<ModelOption>.self, forKey: .models))?.values
    }

    private enum CodingKeys: String, CodingKey { case session, warning, conversations, models }
}

/// Lo que el móvil pide fuera de un chat abierto.
public enum PhoneRequest: Sendable, Hashable {
    /// Un chat nuevo o una conversación retomada; `text` es el primer mensaje (puede ir vacío).
    /// `effort`, `fast` y `mode` (permisos) nil dejan los del asistente.
    case open(project: String, profile: String, model: String?, effort: String?, fast: Bool?, mode: String?,
              conversation: SavedConversation?, text: String)
    case close(session: String)
    case favorite(project: String, favorite: Bool)
    case conversations(project: String, profile: String)
    case models(project: String, profile: String)

    var json: [String: Any] {
        switch self {
        case .open(let project, let profile, let model, let effort, let fast, let mode, let conversation, let text):
            return [
                "kind": "open", "project": project, "profile": profile,
                "model": model.map { $0 as Any } ?? NSNull(),
                "effort": effort.map { $0 as Any } ?? NSNull(),
                "fast": fast.map { $0 as Any } ?? NSNull(),
                "mode": mode.map { $0 as Any } ?? NSNull(),
                "conversation": conversation.map { ["id": $0.id, "title": $0.title] as Any } ?? NSNull(),
                "text": text,
            ]
        case .close(let session):
            return ["kind": "close", "session": session]
        case .favorite(let project, let favorite):
            return ["kind": "favorite", "project": project, "favorite": favorite]
        case .conversations(let project, let profile):
            return ["kind": "conversations", "project": project, "profile": profile]
        case .models(let project, let profile):
            return ["kind": "models", "project": project, "profile": profile]
        }
    }
}

/// Respuestas HTTP (`/api/pair`, `/api/upload`, `/api/icon`).
public struct PairResponse: Decodable, Sendable {
    public var token: String?
    public var device: PairedDevice?
    public var error: String?
}

public struct UploadResponse: Decodable, Sendable {
    public var id: String?
    public var name: String?
    public var size: Int?
    public var image: Bool?
    public var error: String?
}

public struct IconResponse: Decodable, Sendable {
    public var url: String?
    public var error: String?

    /// Los bytes de la imagen si la URL es `data:image/…;base64,…`.
    public var imageData: Data? {
        guard let url, url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
              url[..<comma].hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(url[url.index(after: comma)...]))
    }
}
