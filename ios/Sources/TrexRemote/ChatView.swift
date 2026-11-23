import SwiftUI
import TrexRemoteCore
import UIKit

/// C · El chat de una sesión, en vivo. Lo que publica el PC se pinta tal cual; las
/// peticiones (permiso, plan, pregunta) se abren en una hoja inferior.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    let sessionID: String

    /// La hoja de la petición que ocultaste a mano (no se vuelve a abrir sola).
    @State private var hiddenSheet: String?
    @State private var confirmClose = false
    /// Cuánto tapa el teclado al chat (ver KeyboardGuide.swift).
    @State private var keyboard = KeyboardMetrics()
    /// Medidas del teclado en pantalla (Este iPhone › Diagnóstico), para ajustar en un móvil concreto.
    @AppStorage("keyboardDiagnostics") private var showDiagnostics = false

    /// Margen extra sobre el teclado: su cristal empieza unos puntos por encima del borde que
    /// informa iOS (medido en un iPhone con iOS 27), así el cuadro nunca queda debajo.
    private let keyboardGap: CGFloat = 12

    private var session: RemoteSession? { model.session(sessionID) }
    private var detail: RemoteDetail? { model.detail(for: sessionID) }

    var body: some View {
        // El hueco del teclado lo pone el chat con su propia medida (no SwiftUI): el contenido
        // ignora el área segura del teclado y se le añade lo que este tapa más el margen.
        VStack(spacing: 0) {
            if let detail, detail.tasks.total > 0 {
                TasksBar(tasks: detail.tasks)
            }
            thread
            if let detail {
                ComposerView(sessionID: sessionID, detail: detail)
            }
        }
        .padding(.bottom, keyboard.visible ? keyboard.overlap + keyboardGap : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            KeyboardReader { metrics in
                guard metrics != keyboard else { return }
                withAnimation(.easeOut(duration: 0.25)) { keyboard = metrics }
            }
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .overlay(alignment: .topLeading) {
            if showDiagnostics { KeyboardDiagnostics(metrics: keyboard, gap: keyboardGap) }
        }
        .background(palette.app.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(session?.title ?? "Sesión").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text).lineLimit(1)
                    Text(subtitle).font(TrexFont.mono(11)).foregroundStyle(palette.dim).lineLimit(1)
                }
            }
            if detail?.running == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            do {
                                try await model.command(sessionID, .interrupt)
                                Haptics.tap()
                            } catch {
                                model.show(error)
                            }
                        }
                    } label: {
                        // Texto y no solo icono: en la barra de iOS 26 un Label se queda en un cuadrado sin rótulo.
                        Text("\(Image(systemName: "stop.fill")) Detener")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .tint(palette.danger)
                    .accessibilityLabel("Detener al agente")
                }
            }
            if model.catalog != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let session {
                            Button {
                                model.newChat = NewChatRequest(project: session.project.id)
                            } label: {
                                Label("Nuevo chat", systemImage: "plus.bubble")
                            }
                        }
                        Button(role: .destructive) {
                            confirmClose = true
                        } label: {
                            Label("Cerrar chat", systemImage: "xmark.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Más opciones del chat")
                }
            }
        }
        .confirmationDialog("¿Cerrar el chat?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Cerrar chat", role: .destructive) {
                Task {
                    do {
                        try await model.closeChat(sessionID)
                        dismiss()
                    } catch {
                        model.show(error)
                    }
                }
            }
        } message: {
            Text("La conversación queda guardada.")
        }
        .toolbarBackground(palette.app, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .onAppear { model.watch(sessionID) }
        .onDisappear { if model.watching == sessionID { model.watch(nil) } }
        .sheet(item: sheetBinding) { pending in
            PendingSheet(sessionID: sessionID, agent: session?.providerName ?? "El agente", pending: pending)
                .environment(model)
                .environment(\.palette, palette)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(palette.elevated)
        }
        .overlay(alignment: .top) {
            if model.link != .online {
                Text("Reconectando…")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(palette.accentInk)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(palette.warn, in: Capsule())
                    .padding(.top, 6)
            }
        }
    }

    private var subtitle: String {
        guard let session else { return "cargando…" }
        return ([session.project.name] + [session.agentLine].filter { !$0.isEmpty }).joined(separator: " · ")
    }

    private var sheetBinding: Binding<RemotePending?> {
        Binding {
            guard let pending = detail?.pending, hiddenSheet != pending.item else { return nil }
            return pending
        } set: { value in
            if value == nil, let pending = detail?.pending { hiddenSheet = pending.item }
        }
    }

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // VStack y no LazyVStack: con el ancla abajo, la lista perezosa colocaba la vista
                // con alturas estimadas y no pintaba los mensajes hasta deslizar. El PC solo manda
                // los últimos 60 elementos, así que medirlos todos no cuesta nada.
                VStack(alignment: .leading, spacing: 14) {
                    if let detail {
                        if detail.dormant {
                            NoticeView(tone: .info, text: "Historial no cargado en el PC.")
                        }
                        if detail.hidden > 0 {
                            Text("+\(detail.hidden) anteriores")
                                .font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
                                .frame(maxWidth: .infinity)
                        }
                        ThreadView(items: detail.items)
                        if detail.running {
                            WorkingLine(since: detail.turnStartedAt)
                        }
                        if let pending = detail.pending, hiddenSheet == pending.item {
                            Button {
                                hiddenSheet = nil
                            } label: {
                                Label(pendingLabel(pending), systemImage: pendingIcon(pending))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.accentInk)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(palette.warn, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        ProgressView().tint(palette.accent).frame(maxWidth: .infinity).padding(.top, 60)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            // Al arrastrar el hilo el teclado se cierra de una vez (el hueco sigue al marco final del teclado).
            .scrollDismissesKeyboard(.immediately)
            .onChange(of: detail?.items.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: detail == nil) { _, empty in
                // Llega el primer detalle de la sesión: directo al final, sin animación.
                guard !empty else { return }
                DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: keyboard.visible) { _, _ in
                // Al abrir el teclado el final del hilo sigue a la vista.
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: detail?.running) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    private func pendingLabel(_ pending: RemotePending) -> String {
        switch pending {
        case .question: "Te hace una pregunta · ver"
        case .plan: "Propone un plan · ver"
        case .permission: "Pide permiso · ver"
        }
    }

    private func pendingIcon(_ pending: RemotePending) -> String {
        switch pending {
        case .question: "questionmark.circle.fill"
        case .plan: "map.fill"
        case .permission: "exclamationmark.triangle.fill"
        }
    }
}

/// Las medidas del teclado sobre el chat (Este iPhone › Diagnóstico del teclado).
private struct KeyboardDiagnostics: View {
    let metrics: KeyboardMetrics
    let gap: CGFloat

    var body: some View {
        let lines = [
            "teclado tapa: \(Int(metrics.overlap)) pt",
            "borde guía: \(Int(metrics.guideTop)) / alto vista \(Int(metrics.height))",
            "vista acaba en \(Int(metrics.bottomInWindow)) de \(Int(metrics.windowHeight))",
            "área segura abajo: \(Int(metrics.safeBottom)) · margen \(Int(gap))",
        ]
        Text(lines.joined(separator: "\n"))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.white)
            .padding(6)
            .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 6))
            .padding(8)
            .allowsHitTesting(false)
    }
}

/// Progreso de la lista de tareas del agente: «Conectar el WebSocket · 2/5».
private struct TasksBar: View {
    @Environment(\.palette) private var palette
    let tasks: TaskProgress

    var body: some View {
        let segments = min(tasks.total, 24)
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(tasks.current ?? (tasks.done == tasks.total ? "Tareas completadas" : "Tareas"))
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(palette.text).lineLimit(1)
                Spacer()
                Text("tareas \(tasks.done)/\(tasks.total)").font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
            }
            HStack(spacing: 3) {
                ForEach(0..<segments, id: \.self) { index in
                    let scaled = index * tasks.total / max(segments, 1)
                    Capsule()
                        .fill(scaled < tasks.done ? palette.ok : scaled == tasks.done && tasks.current != nil ? palette.accent : palette.border)
                        .frame(height: 4)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(palette.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.border).frame(height: 1) }
    }
}

/// Los elementos del hilo; las herramientas seguidas se juntan en un árbol.
private struct ThreadView: View {
    let items: [RemoteItem]

    private enum Block: Identifiable {
        case item(RemoteItem)
        case tools([RemoteItem])

        var id: String {
            switch self {
            case .item(let item): item.id
            case .tools(let tools): "tree-\(tools.first?.id ?? "")"
            }
        }
    }

    private var blocks: [Block] {
        var blocks: [Block] = []
        var tools: [RemoteItem] = []
        for item in items {
            if case .tool = item {
                tools.append(item)
                continue
            }
            if !tools.isEmpty { blocks.append(.tools(tools)); tools = [] }
            if case .unknown = item { continue }
            blocks.append(.item(item))
        }
        if !tools.isEmpty { blocks.append(.tools(tools)) }
        return blocks
    }

    var body: some View {
        ForEach(blocks) { block in
            switch block {
            case .item(let item): ItemView(item: item)
            case .tools(let tools): ToolTree(tools: tools)
            }
        }
    }
}

private struct ItemView: View {
    @Environment(\.palette) private var palette
    let item: RemoteItem

    var body: some View {
        switch item {
        case .user(_, let text, let images, let files):
            VStack(alignment: .leading, spacing: 8) {
                if !text.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("›").font(.system(size: 16, weight: .bold)).foregroundStyle(palette.accentText)
                        Text(text).foregroundStyle(palette.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if images > 0 || !files.isEmpty {
                    FlowTags(images: images, files: files)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .text(_, let text, _):
            MarkdownView(text)
        case .notice(_, let tone, let text):
            NoticeView(tone: tone, text: text)
        case .turn(_, let durationMs):
            Text("respuesta en \(RemoteFormat.duration(durationMs))")
                .font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
        case .tool, .unknown:
            EmptyView()
        }
    }
}

private struct FlowTags: View {
    @Environment(\.palette) private var palette
    let images: Int
    let files: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if images > 0 { tag("photo", "\(images) imagen\(images == 1 ? "" : "es")") }
                ForEach(Array(files.enumerated()), id: \.offset) { _, name in tag("doc", name) }
            }
        }
    }

    private func tag(_ icon: String, _ text: String) -> some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .foregroundStyle(palette.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(palette.surface, in: Capsule())
    }
}

/// «├─ ✓ Leer agent.rs», con +/− cuando cambia archivos.
private struct ToolTree: View {
    @Environment(\.palette) private var palette
    let tools: [RemoteItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(tools.enumerated()), id: \.element.id) { index, item in
                if case .tool(_, let verb, let target, let status, let added, let removed) = item {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(index == tools.count - 1 ? "└─" : "├─").foregroundStyle(palette.border)
                        Group {
                            switch status {
                            case .running: ProgressView().controlSize(.mini)
                            case .error: Image(systemName: "xmark").foregroundStyle(palette.danger)
                            case .done: Image(systemName: "checkmark").foregroundStyle(palette.ok)
                            }
                        }
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 14)
                        Text("\(verb) \(target)").foregroundStyle(status == .running ? palette.text : palette.muted).lineLimit(2)
                        if added > 0 || removed > 0 { DiffStat(added: added, removed: removed) }
                    }
                    .font(TrexFont.mono(12.5))
                }
            }
        }
    }
}

struct NoticeView: View {
    @Environment(\.palette) private var palette
    let tone: NoticeTone
    let text: String

    var body: some View {
        let color = tone == .error ? palette.danger : tone == .warn ? palette.warn : palette.muted
        Text(text)
            .font(.subheadline)
            .foregroundStyle(tone == .info ? palette.muted : color)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(color.opacity(0.3)))
    }
}

/// «trabajando · 1 m 12 s», con el reloj en marcha.
private struct WorkingLine: View {
    @Environment(\.palette) private var palette
    let since: Double?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(palette.accent)
                Text(label(now: context.date)).font(TrexFont.mono(12.5)).foregroundStyle(palette.muted)
            }
        }
    }

    private func label(now: Date) -> String {
        guard let since else { return "trabajando" }
        return "trabajando · \(RemoteFormat.duration(now.timeIntervalSince1970 * 1000 - since))"
    }
}
