import Foundation

// Tipos del control remoto de trex. Son el espejo de `src/remoteProtocol.ts` (lo que
// publica el escritorio) y de `src-tauri/src/remote.rs` (cómo lo envuelve el servidor).
//
// Se decodifica con tolerancia: un campo nuevo o un elemento desconocido nunca deben
// dejar la app en blanco. Lo que falta toma un valor por defecto y lo que no se entiende
// se omite.

// MARK: - Sesiones (lista)

public enum SessionStatus: String, Codable, Sendable, CaseIterable {
    case needs, working, idle, exited

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .idle
    }

    /// Orden de la lista: lo que te espera primero.
    public var rank: Int {
        switch self {
        case .needs: 0
        case .working: 1
        case .idle: 2
        case .exited: 3
        }
    }
}

public struct RemoteProject: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    /// Lugar en la barra lateral del PC.
    public var order: Double?

    public init(id: String, name: String, path: String = "", order: Double? = nil) {
        self.id = id
        self.name = name
        self.path = path
        self.order = order
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.value(.name, default: id)
        path = c.value(.path, default: "")
        order = try? c.decodeIfPresent(Double.self, forKey: .order)
    }
}

public struct RemoteNeed: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case permission, question, plan

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .permission
        }
    }

    public var kind: Kind
    public var item: String
    public var label: String

    public init(kind: Kind, item: String, label: String) {
        self.kind = kind
        self.item = item
        self.label = label
    }
}

public struct RemoteSession: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var project: RemoteProject
    public var provider: String
    /// Perfil del asistente («Claude Code»).
    public var agent: String
    public var model: String?
    public var status: SessionStatus
    public var need: RemoteNeed?
    /// Qué hace ahora mismo («Editando remote.rs»).
    public var activity: String?
    /// Último cambio visible, en milisegundos desde 1970.
    public var updatedAt: Double

    public init(
        id: String, title: String, project: RemoteProject, provider: String = "claude", agent: String = "",
        model: String? = nil, status: SessionStatus = .idle, need: RemoteNeed? = nil, activity: String? = nil, updatedAt: Double = 0
    ) {
        self.id = id
        self.title = title
        self.project = project
        self.provider = provider
        self.agent = agent
        self.model = model
        self.status = status
        self.need = need
        self.activity = activity
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.value(.title, default: "Sesión")
        project = (try? c.decode(RemoteProject.self, forKey: .project)) ?? RemoteProject(id: "?", name: "Proyecto")
        provider = c.value(.provider, default: "")
        agent = c.value(.agent, default: "")
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        status = c.value(.status, default: .idle)
        need = try? c.decodeIfPresent(RemoteNeed.self, forKey: .need)
        activity = try? c.decodeIfPresent(String.self, forKey: .activity)
        updatedAt = c.value(.updatedAt, default: 0)
    }

    /// «Claude Code · Opus»
    public var agentLine: String {
        [agent, model ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Nombre corto del asistente para los títulos de las hojas («Claude pide permiso»).
    public var providerName: String {
        switch provider {
        case "claude": "Claude"
        case "codex": "Codex"
        case "antigravity": "Antigravity"
        case "trex": "Trex"
        default: agent.isEmpty ? "El agente" : agent
        }
    }
}

// MARK: - Detalle de una sesión (chat)

public enum ToolStatus: String, Codable, Sendable {
    case running, done, error

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ToolStatus(rawValue: raw) ?? .done
    }
}

public enum NoticeTone: String, Codable, Sendable {
    case info, warn, error

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NoticeTone(rawValue: raw) ?? .info
    }
}

public enum RemoteItem: Hashable, Sendable, Identifiable, Decodable {
    case user(id: String, text: String, images: Int, files: [String])
    case text(id: String, text: String, final: Bool)
    case tool(id: String, verb: String, target: String, status: ToolStatus, added: Int, removed: Int)
    case notice(id: String, tone: NoticeTone, text: String)
    case turn(id: String, durationMs: Double)
    /// Un tipo que esta versión de la app no sabe pintar.
    case unknown(id: String)

    public var id: String {
        switch self {
        case .user(let id, _, _, _), .text(let id, _, _), .tool(let id, _, _, _, _, _),
             .notice(let id, _, _), .turn(let id, _), .unknown(let id):
            id
        }
    }

    private enum Keys: String, CodingKey {
        case kind, id, text, images, files, final, verb, target, status, added, removed, tone, durationMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id: String = c.value(.id, default: UUID().uuidString)
        switch c.value(.kind, default: "") {
        case "user":
            self = .user(id: id, text: c.value(.text, default: ""), images: c.value(.images, default: 0), files: c.value(.files, default: []))
        case "text":
            self = .text(id: id, text: c.value(.text, default: ""), final: c.value(.final, default: true))
        case "tool":
            self = .tool(id: id, verb: c.value(.verb, default: ""), target: c.value(.target, default: ""),
                         status: c.value(.status, default: .done), added: c.value(.added, default: 0), removed: c.value(.removed, default: 0))
        case "notice":
            self = .notice(id: id, tone: c.value(.tone, default: .info), text: c.value(.text, default: ""))
        case "turn":
            self = .turn(id: id, durationMs: c.value(.durationMs, default: 0))
        default:
            self = .unknown(id: id)
        }
    }
}

public struct QuestionOption: Codable, Hashable, Sendable {
    public var label: String
    public var title: String
    public var description: String
    public var recommended: Bool

    public init(label: String, title: String, description: String = "", recommended: Bool = false) {
        self.label = label
        self.title = title
        self.description = description
        self.recommended = recommended
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        title = c.value(.title, default: label)
        description = c.value(.description, default: "")
        recommended = c.value(.recommended, default: false)
    }
}

public struct RemoteQuestion: Codable, Hashable, Sendable {
    public var question: String
    public var header: String
    public var multiSelect: Bool
    /// Admite una respuesta escrita además de las opciones.
    public var other: Bool
    public var secret: Bool
    public var options: [QuestionOption]

    public init(question: String, header: String = "", multiSelect: Bool = false, other: Bool = true, secret: Bool = false, options: [QuestionOption]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.other = other
        self.secret = secret
        self.options = options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = c.value(.question, default: "")
        header = c.value(.header, default: "")
        multiSelect = c.value(.multiSelect, default: false)
        other = c.value(.other, default: false)
        secret = c.value(.secret, default: false)
        options = c.lossy(.options)
    }
}

public struct PermissionRequest: Hashable, Sendable {
    public var item: String
    public var tool: String
    public var verb: String
    public var target: String
    public var command: String?
    public var cwd: String
    public var description: String
    public var added: Int
    public var removed: Int
    /// Texto del botón «permitir siempre» que propone el asistente; nil si no lo ofrece.
    public var remember: String?
    /// Lo que pide cuando no es un comando (rutas, URL, permisos extra).
    public var detail: String?

    /// «ejecutar un comando», «editar main.rs»…
    public var what: String {
        if command != nil { return "ejecutar un comando" }
        if added > 0 || removed > 0 { return "editar \(target)" }
        return "\(verb.lowercased()) \(target)".trimmingCharacters(in: .whitespaces)
    }
}

public enum RemotePending: Hashable, Sendable, Identifiable, Decodable {
    case permission(PermissionRequest)
    case question(item: String, title: String, questions: [RemoteQuestion])
    case plan(item: String, plan: String)

    public var id: String { item }

    public var item: String {
        switch self {
        case .permission(let request): request.item
        case .question(let item, _, _), .plan(let item, _): item
        }
    }

    private enum Keys: String, CodingKey {
        case kind, item, tool, verb, target, command, cwd, description, added, removed, remember, detail, title, questions, plan
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let item = try c.decode(String.self, forKey: .item)
        switch c.value(.kind, default: "permission") {
        case "question":
            self = .question(item: item, title: c.value(.title, default: ""), questions: c.lossy(.questions))
        case "plan":
            self = .plan(item: item, plan: c.value(.plan, default: ""))
        default:
            self = .permission(PermissionRequest(
                item: item, tool: c.value(.tool, default: ""), verb: c.value(.verb, default: ""), target: c.value(.target, default: ""),
                command: try? c.decodeIfPresent(String.self, forKey: .command), cwd: c.value(.cwd, default: ""),
                description: c.value(.description, default: ""), added: c.value(.added, default: 0), removed: c.value(.removed, default: 0),
                remember: try? c.decodeIfPresent(String.self, forKey: .remember), detail: try? c.decodeIfPresent(String.self, forKey: .detail)
            ))
        }
    }
}

public struct TaskProgress: Codable, Hashable, Sendable {
    public var done: Int
    public var total: Int
    public var current: String?

    public init(done: Int = 0, total: Int = 0, current: String? = nil) {
        self.done = done
        self.total = total
        self.current = current
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        done = c.value(.done, default: 0)
        total = c.value(.total, default: 0)
        current = try? c.decodeIfPresent(String.self, forKey: .current)
    }
}

public struct RemoteDetail: Decodable, Hashable, Sendable {
    public var id: String
    public var items: [RemoteItem]
    /// Elementos más antiguos que el PC no manda.
    public var hidden: Int
    public var tasks: TaskProgress
    public var pending: RemotePending?
    public var running: Bool
    public var turnStartedAt: Double?
    /// Lo que se escriba ahora irá a la cola (el agente está trabajando).
    public var queues: Bool
    public var queued: Int
    /// La sesión aún no se abrió en el PC: no hay historial cargado.
    public var dormant: Bool
    /// No se puede escribir (motivo).
    public var locked: String?

    private enum Keys: String, CodingKey {
        case id, items, hidden, tasks, pending, running, turnStartedAt, queues, queued, dormant, locked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = c.value(.id, default: "")
        items = c.lossy(.items)
        hidden = c.value(.hidden, default: 0)
        tasks = c.value(.tasks, default: TaskProgress())
        pending = try? c.decodeIfPresent(RemotePending.self, forKey: .pending)
        running = c.value(.running, default: false)
        turnStartedAt = try? c.decodeIfPresent(Double.self, forKey: .turnStartedAt)
        queues = c.value(.queues, default: false)
        queued = c.value(.queued, default: 0)
        dormant = c.value(.dormant, default: false)
        locked = try? c.decodeIfPresent(String.self, forKey: .locked)
    }
}

// MARK: - Tema del escritorio

public struct RemoteTheme: Codable, Hashable, Sendable {
    public var mode: String
    /// Claves de `BROWSER_THEME_TOKENS` (app, sidebar, surface, accent…) en `#rrggbb`.
    public var colors: [String: String]

    public init(mode: String, colors: [String: String]) {
        self.mode = mode
        self.colors = colors
    }

    public var isDark: Bool { mode != "light" }
}

// MARK: - Utilidades de decodificación

extension KeyedDecodingContainer {
    /// El valor de la clave, o `fallback` si falta o tiene otro tipo.
    func value<T: Decodable>(_ key: Key, default fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// Un array en el que los elementos que no se entienden se omiten.
    func lossy<T: Decodable>(_ key: Key) -> [T] {
        ((try? decodeIfPresent(LossyArray<T>.self, forKey: key)) ?? nil)?.values ?? []
    }
}

struct LossyArray<T: Decodable>: Decodable {
    var values: [T]

    /// Acepta cualquier valor JSON sin leerlo: así el contenedor avanza al siguiente elemento.
    private struct Skip: Decodable {
        init(from decoder: Decoder) {}
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var values: [T] = []
        while !container.isAtEnd {
            if let value = try? container.decode(T.self) {
                values.append(value)
            } else {
                _ = try? container.decode(Skip.self)
            }
        }
        self.values = values
    }
}
