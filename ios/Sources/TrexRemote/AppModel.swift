import Foundation
import Observation
import SwiftUI
import TrexRemoteCore
import UIKit
import UserNotifications

/// Estado de la app y conexión con trex (lo mismo que `RemoteClient` de la PWA).
///
/// El PC es la fuente de verdad: aquí solo se guarda lo último que publicó y se le mandan
/// órdenes. El WebSocket se reconecta solo con espera creciente (0,8 s … 15 s).
@MainActor
@Observable
final class AppModel {
    enum Link: Equatable {
        case connecting, online, offline, denied
    }

    struct ClientError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    // MARK: Estado publicado

    private(set) var link: Link
    /// Por qué se volvió a la pantalla de emparejar (el PC revocó este iPhone, etc.).
    private(set) var deniedReason: String?
    /// Los trex emparejados (oficina, casa…) y el que se usa ahora. Solo hay una conexión
    /// abierta a la vez: al cambiar se cierra la anterior.
    private(set) var servers: [ServerProfile]
    private(set) var activeID: String?
    /// La hoja «Conectar otro trex».
    var showPairing = false
    private(set) var host = ""
    private(set) var version: String?
    private(set) var latency: Int?
    private(set) var sessions: [RemoteSession] = []
    /// La sesión abierta en el chat y su detalle.
    private(set) var watching: String?
    private(set) var detail: RemoteDetail?
    /// Todos los proyectos y los perfiles para abrir chats (nil con un trex que aún no lo manda).
    private(set) var catalog: RemoteCatalog?
    /// Qué proyectos se ven en este iPhone (propio de cada trex; no cambia la barra lateral del PC).
    var projectFilter = ProjectFilter.all {
        didSet { if let activeID { Self.saveFilter(projectFilter, for: activeID) } }
    }
    /// La hoja «Nuevo chat» (con el proyecto ya elegido, si viene de uno).
    var newChat: NewChatRequest?
    /// Chat recién abierto desde el iPhone: la navegación lo muestra y lo vacía.
    var openedSession: String?
    private(set) var palette = Palette.dark
    var toast: String?
    /// Proyectos plegados o desplegados a mano (los demás siguen la regla por defecto).
    var projectExpanded: [String: Bool] = [:]
    private(set) var notificationsAllowed = false

    // MARK: Conexión

    @ObservationIgnored private let urlSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 20
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retry = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var pingSentAt: Date?
    @ObservationIgnored private var nextRequest = 1
    @ObservationIgnored private var requests: [Int: CheckedContinuation<Void, Error>] = [:]
    /// Peticiones sin sesión: su respuesta trae datos (el chat abierto, las conversaciones…).
    @ObservationIgnored private var dataRequests: [Int: CheckedContinuation<RequestData?, Error>] = [:]
    @ObservationIgnored private var seenNeeds = Set<String>()
    @ObservationIgnored private var icons: [String: UIImage?] = [:]
    @ObservationIgnored private var iconTasks: [String: Task<UIImage?, Never>] = [:]
    @ObservationIgnored private var inForeground = true
    /// Trex que ya dijeron «denied» una vez (ver `handle(.denied)`).
    @ObservationIgnored private var deniedOnce = Set<String>()

    init() {
        let stored = CredentialStore.loadServers()
        servers = stored
        let remembered = CredentialStore.activeServerID
        let selected = stored.contains { $0.id == remembered } ? remembered : stored.first?.id
        activeID = selected
        link = selected == nil ? .denied : .connecting
        if let selected { projectFilter = Self.loadFilter(for: selected) }
        if selected != nil { connect() }
        Task { await refreshNotificationPermission() }
    }

    /// El trex al que está conectada la app.
    var active: ServerProfile? { servers.first { $0.id == activeID } }

    var waitingCount: Int { sessions.filter { $0.status == .needs }.count }
    var workingCount: Int { sessions.filter { $0.status == .working }.count }

    func session(_ id: String) -> RemoteSession? { sessions.first { $0.id == id } }

    /// El detalle solo si es de esa sesión (al abrir otra, el anterior no se muestra).
    func detail(for id: String) -> RemoteDetail? {
        guard watching == id, let detail, detail.id.isEmpty || detail.id == id else { return nil }
        return detail
    }

    // MARK: Emparejar

    func pair(server: ServerAddress, code: String, name: String) async throws {
        var request = URLRequest(url: server.pairURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": PairingCode.normalize(code), "name": name])
        let (data, response) = try await send(request, failure: "No se llega a \(server.display).")
        let body = try? JSONDecoder().decode(PairResponse.self, from: data)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let token = body?.token else {
            throw ClientError(body?.error ?? "No se pudo emparejar.")
        }
        var paired = ServerProfile(server: server, token: token, device: body?.device ?? PairedDevice(id: "", name: name))
        var list = servers
        // Volver a emparejar el mismo PC renueva su token y conserva su nombre.
        if let index = list.firstIndex(where: { $0.server == server }) {
            paired.id = list[index].id
            paired.label = list[index].label
            paired.host = list[index].host
            list[index] = paired
        } else {
            list.append(paired)
        }
        guard CredentialStore.saveServers(list) else { throw ClientError("No se pudo guardar en el Llavero.") }
        CredentialStore.lastServer = server
        servers = list
        deniedReason = nil
        showPairing = false
        activate(paired.id)
    }

    /// Cambia al trex `id` (cierra la conexión con el anterior).
    func switchTo(_ id: String) {
        guard servers.contains(where: { $0.id == id }) else { return }
        guard id != activeID || link == .offline else { return }
        activate(id)
        Haptics.tap()
    }

    private func activate(_ id: String) {
        closeSocket()
        resetData()
        activeID = id
        projectFilter = Self.loadFilter(for: id)
        CredentialStore.activeServerID = id
        retry = 0
        connect()
    }

    /// Nombre puesto a mano para un trex («Oficina»). Vacío vuelve al nombre del PC.
    func rename(_ id: String, to label: String) {
        guard let index = servers.firstIndex(where: { $0.id == id }) else { return }
        let clean = label.trimmingCharacters(in: .whitespacesAndNewlines)
        servers[index].label = clean.isEmpty ? nil : String(clean.prefix(40))
        CredentialStore.saveServers(servers)
    }

    /// Olvida un trex en este iPhone (para quitarle también el acceso, desvincúlalo en ese PC).
    func forget(_ id: String) {
        servers.removeAll { $0.id == id }
        CredentialStore.saveServers(servers)
        guard id == activeID else { return }
        closeSocket()
        resetData()
        if let next = servers.first {
            activate(next.id)
        } else {
            activeID = nil
            CredentialStore.activeServerID = nil
            link = .denied
            deniedReason = nil
        }
    }

    // MARK: WebSocket

    func connect() {
        guard let credentials = active else {
            link = .denied
            return
        }
        retryTask?.cancel()
        retryTask = nil
        closeSocket()
        generation += 1
        let current = generation
        link = .connecting

        var request = URLRequest(url: credentials.server.webSocketURL)
        request.timeoutInterval = 15
        let task = urlSession.webSocketTask(with: request)
        task.maximumMessageSize = 4 * 1024 * 1024
        socket = task
        task.resume()
        let hello = ClientMessage.hello(token: credentials.token)
        Task {
            do {
                try await task.send(.string(hello))
            } catch {
                self.socketClosed(current)
                return
            }
            await self.receiveLoop(task, generation: current)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, generation current: Int) async {
        while current == generation {
            do {
                let message = try await task.receive()
                guard current == generation else { return }
                switch message {
                case .string(let text): handle(ServerMessage.decode(text))
                case .data(let data): handle(ServerMessage.decode(data))
                @unknown default: break
                }
            } catch {
                socketClosed(current)
                return
            }
        }
    }

    private func handle(_ message: ServerMessage?) {
        guard let message else { return }
        switch message {
        case .ready(let host, let device, let version):
            retry = 0
            if let activeID { deniedOnce.remove(activeID) }
            self.host = host
            self.version = version
            // Se recuerda el nombre del PC (para la lista de trex) y cómo conoce a este iPhone.
            if let index = servers.firstIndex(where: { $0.id == activeID }) {
                var profile = servers[index]
                if !host.isEmpty { profile.host = host }
                if !device.id.isEmpty { profile.device = device }
                if profile != servers[index] {
                    servers[index] = profile
                    CredentialStore.saveServers(servers)
                }
            }
            link = .online
            if let watching { sendText(ClientMessage.watch(watching)) }
            startPing()
        case .denied(let reason):
            guard let id = activeID else { return }
            // trex avisa «desvinculado» a todos los móviles también cuando reinicia su servidor
            // (al cambiar un ajuste): antes de olvidar este PC se comprueba una vez más.
            if !deniedOnce.contains(id) {
                deniedOnce.insert(id)
                closeSocket()
                link = .offline
                retryTask?.cancel()
                retryTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled, self?.activeID == id else { return }
                    self?.connect()
                }
                return
            }
            // Rechazado otra vez al saludar: el token se revocó. Se olvida solo este PC.
            deniedOnce.remove(id)
            let revoked = active
            closeSocket()
            resetData()
            servers.removeAll { $0.id == activeID }
            CredentialStore.saveServers(servers)
            if let next = servers.first {
                activate(next.id)
                toast = "\(revoked?.name ?? "Un trex") desvinculó este iPhone. \(reason ?? "")".trimmingCharacters(in: .whitespaces)
            } else {
                activeID = nil
                CredentialStore.activeServerID = nil
                deniedReason = reason
                link = .denied
            }
        case .sessions(let list):
            sessions = list
            notifyNewNeeds(list)
        case .detail(let session, let value):
            if session == watching { detail = value }
        case .theme(let theme):
            palette = Palette(theme: theme)
        case .catalog(let value):
            catalog = value
        case .pong:
            if let sent = pingSentAt { latency = Int(Date().timeIntervalSince(sent) * 1000) }
        case .result(let request, let ok, let error, let data):
            let failure = ok ? nil : ClientError(error ?? "El PC no pudo hacerlo.")
            if let waiter = dataRequests.removeValue(forKey: request) {
                if let failure { waiter.resume(throwing: failure) } else { waiter.resume(returning: data) }
            } else {
                finish(request, error: failure)
            }
        case .unknown:
            break
        }
    }

    private func socketClosed(_ current: Int) {
        guard current == generation else { return }
        socket = nil
        stopPing()
        failRequests("Se perdió la conexión con el PC.")
        guard link != .denied, active != nil else { return }
        link = .offline
        // En segundo plano iOS congela la app: se reconecta al volver.
        guard inForeground else { return }
        let delay = min(15, 0.8 * pow(2, Double(retry)))
        retry += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func closeSocket() {
        generation += 1
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        stopPing()
        failRequests("Se perdió la conexión con el PC.")
    }

    private func resetData() {
        sessions = []
        detail = nil
        watching = nil
        catalog = nil
        newChat = nil
        openedSession = nil
        host = ""
        version = nil
        latency = nil
        icons = [:]
        iconTasks = [:]
        seenNeeds = []
        projectExpanded = [:]
        palette = .dark
    }

    private func sendText(_ text: String) {
        guard let socket else { return }
        Task { try? await socket.send(.string(text)) }
    }

    private func startPing() {
        stopPing()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.pingSentAt = Date()
                self.sendText(ClientMessage.ping())
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func stopPing() {
        pingTask?.cancel()
        pingTask = nil
    }

    /// Al volver a primer plano se reconecta sin esperar al siguiente reintento.
    func scenePhaseChanged(_ phase: ScenePhase) {
        inForeground = phase == .active
        guard phase == .active, active != nil else { return }
        if link == .offline || socket == nil {
            retry = 0
            connect()
        } else if link == .online {
            // Puede que el socket muriera mientras la app estaba congelada: el ping lo destapa.
            pingSentAt = Date()
            sendText(ClientMessage.ping())
        }
    }

    // MARK: Sesiones y órdenes

    func watch(_ session: String?) {
        guard watching != session else { return }
        watching = session
        detail = nil
        sendText(ClientMessage.watch(session))
    }

    /// Una orden para una sesión. Termina cuando el PC la ejecutó o falla con su motivo.
    func command(_ session: String, _ action: PhoneAction) async throws {
        guard link == .online, let socket else { throw ClientError("Sin conexión con el PC.") }
        let request = nextRequest
        nextRequest += 1
        let text = ClientMessage.command(request: request, session: session, action: action)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            requests[request] = continuation
            Task {
                do { try await socket.send(.string(text)) } catch { self.finish(request, error: ClientError("No se pudo enviar al PC.")) }
            }
            Task {
                try? await Task.sleep(for: .seconds(25))
                self.finish(request, error: ClientError("El PC no respondió a tiempo."))
            }
        }
    }

    private func finish(_ request: Int, error: Error?) {
        guard let continuation = requests.removeValue(forKey: request) else { return }
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    private func failRequests(_ reason: String) {
        let pending = requests
        requests = [:]
        for continuation in pending.values { continuation.resume(throwing: ClientError(reason)) }
        let waiting = dataRequests
        dataRequests = [:]
        for continuation in waiting.values { continuation.resume(throwing: ClientError(reason)) }
    }

    // MARK: Peticiones sin sesión (abrir y cerrar chats, favoritos, conversaciones, modelos)

    /// Una petición a la app del PC. Necesita un trex con catálogo (las versiones anteriores no las entienden).
    func request(_ action: PhoneRequest) async throws -> RequestData? {
        guard catalog != nil else { throw ClientError("Actualiza trex en el PC.") }
        guard link == .online, let socket else { throw ClientError("Sin conexión con el PC.") }
        let request = nextRequest
        nextRequest += 1
        let text = ClientMessage.request(request, action)
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RequestData?, Error>) in
            dataRequests[request] = continuation
            Task {
                do { try await socket.send(.string(text)) } catch { self.failRequest(request, ClientError("No se pudo enviar al PC.")) }
            }
            Task {
                // El servidor espera hasta 35 s (cargar los modelos de un perfil puede tardar).
                try? await Task.sleep(for: .seconds(40))
                self.failRequest(request, ClientError("El PC no respondió a tiempo."))
            }
        }
    }

    private func failRequest(_ request: Int, _ error: Error) {
        dataRequests.removeValue(forKey: request)?.resume(throwing: error)
    }

    /// Abre un chat (o retoma una conversación) en el PC y lo muestra en el iPhone.
    func openChat(project: String, profile: String, model: String?, effort: String?, fast: Bool?, mode: String?,
                  conversation: SavedConversation?, text: String) async throws {
        let data = try await request(.open(project: project, profile: profile, model: model, effort: effort, fast: fast,
                                           mode: mode, conversation: conversation, text: text))
        guard let session = data?.session else { throw ClientError("El PC no devolvió el chat abierto.") }
        if let warning = data?.warning { toast = warning }
        newChat = nil
        openedSession = session
        Haptics.success()
    }

    /// Cierra la pestaña del chat en el PC (la conversación queda guardada para retomarla).
    func closeChat(_ session: String) async throws {
        _ = try await request(.close(session: session))
        if watching == session { watch(nil) }
        sessions.removeAll { $0.id == session }
        Haptics.success()
    }

    /// Estrella del proyecto en el PC (se ve también en su barra lateral).
    func setFavorite(_ project: String, _ favorite: Bool) async {
        // Se pinta al momento; el PC confirma con un catálogo nuevo.
        if var current = catalog, let index = current.projects.firstIndex(where: { $0.id == project }) {
            current.projects[index].favorite = favorite
            catalog = current
        }
        do {
            _ = try await request(.favorite(project: project, favorite: favorite))
            Haptics.tap()
        } catch {
            show(error)
        }
    }

    func conversations(project: String, profile: String) async throws -> [SavedConversation] {
        try await request(.conversations(project: project, profile: profile))?.conversations ?? []
    }

    func models(project: String, profile: String) async throws -> [ModelOption] {
        try await request(.models(project: project, profile: profile))?.models ?? []
    }

    // MARK: Filtro de proyectos (propio del iPhone, por cada trex)

    private static func filterKey(_ server: String) -> String { "projectFilter.\(server)" }

    private static func loadFilter(for server: String) -> ProjectFilter {
        guard let data = UserDefaults.standard.data(forKey: filterKey(server)),
              let filter = try? JSONDecoder().decode(ProjectFilter.self, from: data) else { return .all }
        return filter
    }

    private static func saveFilter(_ filter: ProjectFilter, for server: String) {
        if let data = try? JSONEncoder().encode(filter) { UserDefaults.standard.set(data, forKey: filterKey(server)) }
    }

    /// Permitir o rechazar desde la lista, sin abrir el chat.
    func quickAnswer(_ session: RemoteSession, allowed: Bool) async {
        guard let need = session.need else { return }
        do {
            try await command(session.id, .answer(item: need.item, allowed: allowed, remember: false, choices: nil))
            Haptics.success()
        } catch {
            show(error)
        }
    }

    func show(_ error: Error) {
        toast = error.localizedDescription
        Haptics.error()
    }

    // MARK: Adjuntos e iconos

    struct Uploaded {
        var id: String
        var name: String
        var size: Int
        var image: Bool
    }

    /// Sube un archivo al PC (queda con los adjuntos del escritorio) y devuelve su id.
    func upload(_ data: Data, name: String) async throws -> Uploaded {
        guard let credentials = active else { throw ClientError("Este iPhone no está emparejado.") }
        var request = URLRequest(url: credentials.server.uploadURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 300
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.setValue(encodeURIComponent(name.isEmpty ? "archivo" : name), forHTTPHeaderField: "x-file-name")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (body, response) = try await send(request, upload: data, failure: "Se cortó la subida.")
        let decoded = try? JSONDecoder().decode(UploadResponse.self, from: body)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let id = decoded?.id else {
            throw ClientError(decoded?.error ?? (status == 413 ? "El archivo pesa más de 100 MB." : "No se pudo subir el archivo al PC."))
        }
        return Uploaded(id: id, name: decoded?.name ?? name, size: decoded?.size ?? data.count, image: decoded?.image ?? false)
    }

    /// El logo del proyecto (el de la barra lateral del PC); se pide una sola vez.
    func icon(for project: String) async -> UIImage? {
        if let cached = icons[project] { return cached }
        if let running = iconTasks[project] { return await running.value }
        guard let credentials = active else { return nil }
        let url = credentials.server.iconURL(project: project)
        let token = credentials.token
        let session = urlSession
        let task = Task<UIImage?, Never> {
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            guard let (data, response) = try? await session.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let body = try? JSONDecoder().decode(IconResponse.self, from: data),
                  let bytes = body.imageData else { return nil }
            return UIImage(data: bytes)
        }
        iconTasks[project] = task
        let image = await task.value
        icons[project] = image
        iconTasks[project] = nil
        return image
    }

    private func send(_ request: URLRequest, upload data: Data? = nil, failure: String) async throws -> (Data, URLResponse) {
        do {
            if let data { return try await urlSession.upload(for: request, from: data) }
            return try await urlSession.data(for: request)
        } catch {
            throw ClientError(failure)
        }
    }

    // MARK: Avisos

    func requestNotifications() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        notificationsAllowed = granted
    }

    func refreshNotificationPermission() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationsAllowed = settings.authorizationStatus == .authorized
    }

    /// Aviso solo para lo nuevo que te necesita y solo si la app no está a la vista (mientras
    /// iOS la mantenga viva: sin push de Apple no llega nada con la app cerrada).
    private func notifyNewNeeds(_ list: [RemoteSession]) {
        for session in list {
            guard let need = session.need, !seenNeeds.contains(need.item) else { continue }
            seenNeeds.insert(need.item)
            guard !inForeground, notificationsAllowed else { continue }
            let content = UNMutableNotificationContent()
            content.title = session.title
            content.body = need.label
            content.sound = .default
            content.threadIdentifier = session.id
            let request = UNNotificationRequest(identifier: need.item, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }
    }
}

/// Abrir la hoja «Nuevo chat», con el proyecto elegido si viene de uno.
struct NewChatRequest: Identifiable, Equatable {
    let id = UUID()
    var project: String?
}

enum Haptics {
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
