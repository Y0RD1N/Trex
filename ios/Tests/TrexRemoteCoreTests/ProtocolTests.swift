import Foundation
import Testing
@testable import TrexRemoteCore

// Mensajes con la forma exacta que publica el escritorio (remoteProtocol.ts) y envuelve
// el servidor (remote.rs): si trex cambia el protocolo, estas pruebas lo dirán.

@Suite struct ServerMessageTests {
    @Test func ready() throws {
        let message = ServerMessage.decode(#"{"type":"ready","host":"ESCRITORIO","device":{"id":"ab12","name":"iPhone"},"version":"0.9.0"}"#)
        guard case .ready(let host, let device, let version) = message else { Issue.record("no es ready"); return }
        #expect(host == "ESCRITORIO")
        #expect(device == PairedDevice(id: "ab12", name: "iPhone"))
        #expect(version == "0.9.0")
    }

    @Test func denied() {
        guard case .denied(let reason) = ServerMessage.decode(#"{"type":"denied","error":"Este móvil se desvinculó desde el PC."}"#) else {
            Issue.record("no es denied"); return
        }
        #expect(reason == "Este móvil se desvinculó desde el PC.")
    }

    @Test func sessionsSkipBrokenEntries() {
        let json = #"""
        {"type":"sessions","sessions":[
          {"id":"tab-1","title":"Puente remoto: servidor axum","project":{"id":"p1","name":"trex","path":"D:\\projects\\trex","order":0},
           "provider":"claude","agent":"Claude Code","model":"Opus","status":"needs",
           "need":{"kind":"permission","item":"perm-7","label":"Bash cargo test"},"activity":null,"updatedAt":1795451262622},
          {"id":"tab-2","title":"Checkout","project":{"id":"p2","name":"web-ventas","path":"","order":1},
           "provider":"codex","agent":"Codex","model":null,"status":"working","need":null,"activity":"Editando main.rs","updatedAt":1795451000000},
          {"title":"sin id: se omite"},
          {"id":"tab-3","title":"Futuro","project":{"id":"p1","name":"trex","path":""},"provider":"nuevo","agent":"X","status":"estado-nuevo","updatedAt":5}
        ]}
        """#
        guard case .sessions(let list) = ServerMessage.decode(json) else { Issue.record("no es sessions"); return }
        #expect(list.map(\.id) == ["tab-1", "tab-2", "tab-3"])
        #expect(list[0].status == .needs)
        #expect(list[0].need == RemoteNeed(kind: .permission, item: "perm-7", label: "Bash cargo test"))
        #expect(list[0].agentLine == "Claude Code · Opus")
        #expect(list[0].providerName == "Claude")
        #expect(list[1].model == nil)
        #expect(list[1].activity == "Editando main.rs")
        #expect(list[2].status == .idle)
        #expect(list[2].project.order == nil)
    }

    @Test func detailWithEveryItemKind() {
        let json = #"""
        {"type":"detail","session":"tab-1","detail":{
          "id":"tab-1","hidden":3,
          "items":[
            {"kind":"user","id":"u1","text":"Añade el endpoint /ws","images":1,"files":["notas.md"]},
            {"kind":"text","id":"t1","text":"Lo **monto** sobre el router","final":false},
            {"kind":"tool","id":"k1","verb":"Leer","target":"agent.rs","status":"done","added":0,"removed":0},
            {"kind":"tool","id":"k2","verb":"Editar","target":"remote.rs","status":"running","added":48,"removed":3},
            {"kind":"notice","id":"n1","tone":"warn","text":"Cuota baja"},
            {"kind":"turn","id":"r1","durationMs":72000},
            {"kind":"pensamiento","id":"x1"}
          ],
          "tasks":{"done":2,"total":5,"current":"Conectar el WebSocket"},
          "pending":{"kind":"permission","item":"perm-7","tool":"Bash","verb":"Ejecutar","target":"cargo test","command":"cargo test --lib remote::pairing",
            "cwd":"D:\\projects\\trex\\src-tauri","description":"Para comprobar el código caducado","added":0,"removed":0,"remember":"Permitir siempre","detail":null},
          "running":true,"turnStartedAt":1795451262000,"queues":true,"queued":1,"dormant":false,"locked":null}}
        """#
        guard case .detail(let session, let detail) = ServerMessage.decode(json) else { Issue.record("no es detail"); return }
        #expect(session == "tab-1")
        #expect(detail.items.count == 7)
        #expect(detail.items[0] == .user(id: "u1", text: "Añade el endpoint /ws", images: 1, files: ["notas.md"]))
        #expect(detail.items[3] == .tool(id: "k2", verb: "Editar", target: "remote.rs", status: .running, added: 48, removed: 3))
        #expect(detail.items[5] == .turn(id: "r1", durationMs: 72000))
        #expect(detail.items[6] == .unknown(id: "x1"))
        #expect(detail.tasks == TaskProgress(done: 2, total: 5, current: "Conectar el WebSocket"))
        #expect(detail.running && detail.queues && detail.queued == 1)
        #expect(detail.locked == nil)
        guard case .permission(let request) = detail.pending else { Issue.record("sin permiso"); return }
        #expect(request.command == "cargo test --lib remote::pairing")
        #expect(request.remember == "Permitir siempre")
        #expect(request.detail == nil)
        #expect(request.what == "ejecutar un comando")
    }

    @Test func questionAndPlan() {
        let question = #"""
        {"type":"detail","session":"s","detail":{"id":"s","items":[],"hidden":0,"tasks":{"done":0,"total":0,"current":null},
          "pending":{"kind":"question","item":"q1","title":"Codex pregunta","questions":[
            {"question":"¿Dónde guardo el carrito?","header":"Carrito","multiSelect":false,"other":true,"secret":false,
             "options":[{"label":"server","title":"Sesión del servidor","description":"No se pierde","recommended":true},
                        {"label":"local","title":"localStorage","description":"Más simple","recommended":false}]}]},
          "running":false,"turnStartedAt":null,"queues":false,"queued":0,"dormant":true,"locked":"Un workflow la bloquea"}}
        """#
        guard case .detail(_, let detail) = ServerMessage.decode(question),
              case .question(let item, let title, let questions) = detail.pending else { Issue.record("sin pregunta"); return }
        #expect(item == "q1")
        #expect(title == "Codex pregunta")
        #expect(questions.first?.options.map(\.label) == ["server", "local"])
        #expect(questions.first?.options.first?.recommended == true)
        #expect(detail.dormant)
        #expect(detail.locked == "Un workflow la bloquea")

        let plan = #"{"type":"detail","session":"s","detail":{"id":"s","items":[],"pending":{"kind":"plan","item":"p1","plan":"1. Hacer X"}}}"#
        guard case .detail(_, let planned) = ServerMessage.decode(plan), case .plan(let planItem, let text) = planned.pending else {
            Issue.record("sin plan"); return
        }
        #expect(planItem == "p1")
        #expect(text == "1. Hacer X")
        #expect(planned.tasks.total == 0)
    }

    @Test func themeResultPongAndUnknown() {
        guard case .theme(let theme) = ServerMessage.decode(##"{"type":"theme","theme":{"mode":"light","colors":{"accent":"#f06a8d","app":"#f2ede0"}}}"##) else {
            Issue.record("sin tema"); return
        }
        #expect(!theme.isDark)
        #expect(theme.colors["accent"] == "#f06a8d")
        guard case .result(let request, let ok, let error, let data) = ServerMessage.decode(#"{"type":"result","req":4,"ok":false,"error":"Sesión no válida."}"#) else {
            Issue.record("sin resultado"); return
        }
        #expect(request == 4 && !ok && error == "Sesión no válida.")
        #expect(data == nil)
        guard case .pong = ServerMessage.decode(#"{"type":"pong"}"#) else { Issue.record("sin pong"); return }
        guard case .unknown = ServerMessage.decode(#"{"type":"algo-nuevo"}"#) else { Issue.record("debería ser unknown"); return }
        #expect(ServerMessage.decode("no es json") == nil)
    }
}

@Suite struct ClientMessageTests {
    private func object(_ text: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    @Test func helloAndWatch() throws {
        let hello = try object(ClientMessage.hello(token: "abc"))
        #expect(hello["type"] as? String == "hello")
        #expect(hello["token"] as? String == "abc")
        let watch = try object(ClientMessage.watch("tab-1"))
        #expect(watch["session"] as? String == "tab-1")
        let stop = try object(ClientMessage.watch(nil))
        #expect(stop["session"] is NSNull)
    }

    @Test func commands() throws {
        let send = try object(ClientMessage.command(request: 3, session: "tab-1", action: .send(text: "hola [Imagen 1]", attachments: ["0123456789abcdef0123456789abcdef"])))
        #expect(send["type"] as? String == "command")
        #expect((send["req"] as? NSNumber)?.intValue == 3)
        let action = try #require(send["action"] as? [String: Any])
        #expect(action["kind"] as? String == "send")
        #expect(action["attachments"] as? [String] == ["0123456789abcdef0123456789abcdef"])

        let quick = try object(ClientMessage.command(request: 4, session: "s", action: .answer(item: "perm-7", allowed: true, remember: false, choices: nil)))
        let answer = try #require(quick["action"] as? [String: Any])
        #expect(answer["choices"] is NSNull)
        #expect((answer["allowed"] as? NSNumber)?.boolValue == true)

        let chosen = try object(ClientMessage.command(request: 5, session: "s", action: .answer(
            item: "q1", allowed: true, remember: false, choices: [RemoteChoice(question: "¿Dónde?", selected: ["server"], other: "")]
        )))
        let choices = try #require((chosen["action"] as? [String: Any])?["choices"] as? [[String: Any]])
        #expect(choices.first?["selected"] as? [String] == ["server"])

        let interrupt = try object(ClientMessage.command(request: 6, session: "s", action: .interrupt))
        #expect((interrupt["action"] as? [String: Any])?["kind"] as? String == "interrupt")
    }
}

@Suite struct ServerAddressTests {
    @Test func typedAddresses() {
        #expect(ServerAddress(typed: "10.8.0.2")?.base.absoluteString == "http://10.8.0.2:7340/")
        #expect(ServerAddress(typed: " 10.8.0.2:9000 ")?.base.absoluteString == "http://10.8.0.2:9000/")
        #expect(ServerAddress(typed: "https://pc.tail1234.ts.net")?.base.absoluteString == "https://pc.tail1234.ts.net/")
        #expect(ServerAddress(typed: "ftp://x") == nil)
        #expect(ServerAddress(typed: "") == nil)
    }

    @Test func endpoints() throws {
        let server = try #require(ServerAddress(typed: "10.8.0.2:7340"))
        #expect(server.display == "10.8.0.2:7340")
        #expect(server.webSocketURL.absoluteString == "ws://10.8.0.2:7340/api/ws")
        #expect(server.pairURL.absoluteString == "http://10.8.0.2:7340/api/pair")
        #expect(server.uploadURL.absoluteString == "http://10.8.0.2:7340/api/upload")
        #expect(server.iconURL(project: "p 1").absoluteString == "http://10.8.0.2:7340/api/icon?project=p%201")
        let secure = try #require(ServerAddress(typed: "https://pc.tail1234.ts.net"))
        #expect(secure.webSocketURL.absoluteString == "wss://pc.tail1234.ts.net/api/ws")
    }

    @Test func scannedQR() throws {
        let link = try #require(PairingLink(scanned: "http://10.8.0.2:7340/#pair=k7q4mx"))
        #expect(link.server.base.absoluteString == "http://10.8.0.2:7340/")
        #expect(link.code == "K7Q4MX")
        #expect(PairingLink(scanned: "https://pc.tail1234.ts.net/")?.code == nil)
        #expect(PairingLink(scanned: "hola") == nil)
        #expect(PairingCode.normalize("k7q-4m x") == "K7Q4MX")
    }

    @Test func fileNameEncoding() {
        #expect(encodeURIComponent("foto 1.jpg") == "foto%201.jpg")
        #expect(encodeURIComponent("año/ñ.txt") == "a%C3%B1o%2F%C3%B1.txt")
    }
}

@Suite struct FormattingTests {
    @Test func timeAgo() {
        let now = 10_000_000_000.0
        #expect(RemoteFormat.timeAgo(0, now: now) == "")
        #expect(RemoteFormat.timeAgo(now - 10_000, now: now) == "ahora")
        #expect(RemoteFormat.timeAgo(now - 3 * 60_000, now: now) == "3 min")
        #expect(RemoteFormat.timeAgo(now - 2 * 3_600_000, now: now) == "2 h")
        #expect(RemoteFormat.timeAgo(now - 30 * 3_600_000, now: now) == "ayer")
        #expect(RemoteFormat.timeAgo(now - 5 * 86_400_000, now: now) == "5 d")
    }

    @Test func durations() {
        #expect(RemoteFormat.duration(42_000) == "42 s")
        #expect(RemoteFormat.duration(72_000) == "1 m 12 s")
        #expect(RemoteFormat.duration(7_500_000) == "2 h 5 m")
    }

    @Test func references() {
        let text = AttachmentReference.image.append(to: "mira", first: 0, count: 2)
        #expect(text == "mira [Imagen 1] [Imagen 2] ")
        #expect(AttachmentReference.image.remove(1, from: text, total: 2) == "mira [Imagen 1] ")
        #expect(AttachmentReference.file.append(to: "", first: 1, count: 1) == "[Archivo 2] ")
    }
}

@Suite struct MarkdownTests {
    @Test func blocks() {
        let source = """
        # Título

        Primer párrafo con **negrita**.
        Sigue aquí.

        - uno
        - dos
          - anidado
        1. primero
        2. segundo

        ```swift
        let x = 1
        ```

        > cita

        | a | b |
        |---|---|
        | 1 | 2 |

        ---
        - [x] hecho
        """
        let blocks = MarkdownParser.blocks(source)
        #expect(blocks.count == 9)
        #expect(blocks[0] == .heading(level: 1, text: "Título"))
        #expect(blocks[1] == .paragraph("Primer párrafo con **negrita**.\nSigue aquí."))
        guard case .list(false, let bullets) = blocks[2] else { Issue.record("sin viñetas"); return }
        #expect(bullets.map(\.text) == ["uno", "dos", "anidado"])
        #expect(bullets[2].level == 1)
        guard case .list(true, let numbered) = blocks[3] else { Issue.record("sin numerada"); return }
        #expect(numbered.map(\.number) == [1, 2])
        #expect(blocks[4] == .code(language: "swift", code: "let x = 1"))
        #expect(blocks[5] == .quote("cita"))
        #expect(blocks[6] == .table(header: ["a", "b"], rows: [["1", "2"]]))
        #expect(blocks[7] == .rule)
        guard case .list(false, let tasks) = blocks[8] else { Issue.record("sin tareas"); return }
        #expect(tasks.first?.checked == true)
    }

    @Test func unclosedFenceKeepsTheRest() {
        #expect(MarkdownParser.blocks("```\nsin cerrar") == [.code(language: nil, code: "sin cerrar")])
    }
}

@Suite struct CatalogAndRequestTests {
    private func object(_ text: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    @Test func catalogDecodes() throws {
        let json = #"""
        {"type":"catalog","catalog":{
          "projects":[{"id":"p1","name":"trex","path":"D:\projects\trex","favorite":true,"order":0},
                      {"id":"p2","name":"casa","path":"","favorite":false,"order":1},
                      {"name":"sin id"}],
          "profiles":[{"id":"claude","name":"Claude Code","provider":"claude","isDefault":false,
                      "modes":[{"value":"plan","label":"Solo lectura","description":"Investiga"},{"value":"default","label":"Preguntar"},{"label":"sin valor"}],"mode":"default"},
                      {"id":"codex","name":"Codex","provider":"codex","isDefault":true}]}}
        """#
        guard case .catalog(let catalog) = ServerMessage.decode(json) else { Issue.record("sin catálogo"); return }
        #expect(catalog.projects.map(\.id) == ["p1", "p2"])
        #expect(catalog.projects[0].favorite)
        #expect(catalog.defaultProfile?.id == "codex")
        #expect(catalog.profiles[0].modes.map(\.value) == ["plan", "default"])
        #expect(catalog.profiles[0].mode == "default")
        #expect(catalog.profiles[1].modes.isEmpty && catalog.profiles[1].mode == nil)
    }

    @Test func resultsCarryTheirData() throws {
        guard case .result(_, true, nil, let opened) = ServerMessage.decode(#"{"type":"result","req":1,"ok":true,"error":null,"data":{"session":"t-9","warning":"sin primer mensaje"}}"#) else {
            Issue.record("sin resultado"); return
        }
        #expect(opened?.session == "t-9")
        #expect(opened?.warning == "sin primer mensaje")
        let listed = #"{"type":"result","req":2,"ok":true,"data":{"conversations":[{"id":"c1","title":"Arreglar login","updatedAt":1795451262622},{"title":"rota"}],"models":[{"value":"opus","label":"Opus","description":"El más capaz","featured":true,"efforts":[{"value":"medium","label":"Medio","hint":"Equilibrio"},{"value":"high","label":"Alto","hint":"A fondo"},{"label":"sin valor"}],"defaultEffort":"medium","fast":{"hint":"2× más rápido"}},{"value":"haiku","label":"Haiku","fast":null}]}}"#
        guard case .result(_, _, _, let data) = ServerMessage.decode(listed) else { Issue.record("sin datos"); return }
        #expect(data?.conversations?.map(\.id) == ["c1"])
        let opus = try #require(data?.models?.first)
        #expect(opus.efforts.map(\.value) == ["medium", "high"])
        #expect(opus.defaultEffort == "medium")
        #expect(opus.fastHint == "2× más rápido" && opus.supportsFast)
        #expect(data?.models?.last?.supportsFast == false)
        #expect(data?.models?.last?.efforts.isEmpty == true)
    }

    @Test func requestsEncode() throws {
        let open = try object(ClientMessage.request(3, .open(project: "p1", profile: "claude", model: nil, effort: nil, fast: nil, mode: nil, conversation: nil, text: "hola")))
        #expect(open["type"] as? String == "request")
        let action = try #require(open["action"] as? [String: Any])
        #expect(action["kind"] as? String == "open")
        #expect(action["model"] is NSNull)
        #expect(action["conversation"] is NSNull)
        #expect(action["effort"] is NSNull && action["fast"] is NSNull && action["mode"] is NSNull)
        #expect(action["text"] as? String == "hola")

        let resumed = try object(ClientMessage.request(4, .open(project: "p1", profile: "claude", model: "opus", effort: "high", fast: true, mode: "acceptEdits",
            conversation: SavedConversation(id: "c1", title: "Login", updatedAt: 0), text: "")))
        let resumedAction = try #require(resumed["action"] as? [String: Any])
        #expect(resumedAction["effort"] as? String == "high")
        #expect((resumedAction["fast"] as? NSNumber)?.boolValue == true)
        #expect(resumedAction["mode"] as? String == "acceptEdits")
        let conversation = try #require(resumedAction["conversation"] as? [String: Any])
        #expect(conversation["id"] as? String == "c1")

        let favorite = try object(ClientMessage.request(5, .favorite(project: "p1", favorite: false)))
        #expect(((favorite["action"] as? [String: Any])?["favorite"] as? NSNumber)?.boolValue == false)
        let close = try object(ClientMessage.request(6, .close(session: "t-1")))
        #expect((close["action"] as? [String: Any])?["session"] as? String == "t-1")
    }
}

@Suite struct ProjectListingTests {
    private let catalog = RemoteCatalog(
        projects: [
            .init(id: "a", name: "Alfa", favorite: true, order: 0),
            .init(id: "b", name: "Beta", favorite: false, order: 1),
            .init(id: "c", name: "Gamma", favorite: false, order: 2),
        ],
        profiles: [.init(id: "claude", name: "Claude Code", provider: "claude", isDefault: true)]
    )

    private func session(_ id: String, project: String, _ status: SessionStatus, at: Double = 0) -> RemoteSession {
        RemoteSession(id: id, title: id, project: RemoteProject(id: project, name: project.uppercased(), order: 0), status: status,
                      need: status == .needs ? RemoteNeed(kind: .permission, item: "i-\(id)", label: "x") : nil, updatedAt: at)
    }

    @Test func everyProjectShowsEvenWithoutChats() {
        let groups = ProjectListing.groups(catalog: catalog, sessions: [session("s1", project: "b", .idle)], filter: .all)
        #expect(groups.map(\.id) == ["a", "b", "c"])
        #expect(groups[0].favorite)
        #expect(groups[1].sessions.map(\.id) == ["s1"])
        #expect(groups[1].project.name == "Beta")
    }

    @Test func filtersHideProjectsButNeverWhatWaitsForYou() {
        let sessions = [session("s1", project: "c", .needs), session("s2", project: "b", .idle)]
        #expect(ProjectListing.groups(catalog: catalog, sessions: sessions, filter: ProjectFilter(mode: .favorites)).map(\.id) == ["a", "c"])
        let mine = ProjectFilter(mode: .selected, selected: ["b"])
        #expect(ProjectListing.groups(catalog: catalog, sessions: sessions, filter: mine).map(\.id) == ["b", "c"])
        #expect(ProjectListing.groups(catalog: catalog, sessions: sessions, filter: .all, onlyWaiting: true).map(\.id) == ["c"])
    }

    @Test func withoutCatalogOnlyProjectsWithChats() {
        let groups = ProjectListing.groups(catalog: nil, sessions: [session("s1", project: "x", .working)], filter: ProjectFilter(mode: .favorites))
        #expect(groups.map(\.id) == ["x"])
    }

    @Test func hidingAndTogglingProjects() {
        let hidden = ProjectFilter.all.hiding("b", among: catalog.projects)
        #expect(hidden == ProjectFilter(mode: .selected, selected: ["a", "c"]))
        #expect(hidden.toggling("b").selected == ["a", "b", "c"])
        #expect(hidden.toggling("a").selected == ["c"])
    }

    @Test func sessionsSortByWhatNeedsYouFirst() {
        let sessions = [session("old", project: "a", .idle, at: 1), session("new", project: "a", .idle, at: 5), session("wait", project: "a", .needs)]
        #expect(ProjectListing.groups(catalog: catalog, sessions: sessions, filter: .all)[0].sessions.map(\.id) == ["wait", "new", "old"])
    }
}
