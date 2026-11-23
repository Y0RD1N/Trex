import SwiftUI
import TrexRemoteCore

/// B · Proyectos y sus chats, como la barra lateral del PC. Lo que te necesita va primero y
/// se puede permitir o rechazar sin entrar. Con un trex que manda el catálogo se ven todos
/// los proyectos (según el filtro de este iPhone) y se abren chats nuevos.
struct SessionListView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    /// La pestaña «Esperan»: solo lo que te necesita, sin plegar ni filtrar.
    let onlyWaiting: Bool
    var showWaiting: () -> Void = {}

    @State private var choosingProjects = false

    private var groups: [ProjectGroup] {
        ProjectListing.groups(catalog: model.catalog, sessions: model.sessions, filter: model.projectFilter, onlyWaiting: onlyWaiting)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(palette.app.ignoresSafeArea())
        .refreshable { if model.link != .online { model.connect() } }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Wordmark() }
            ToolbarItem(placement: .topBarTrailing) { LinkChip() }
            if model.catalog != nil, !onlyWaiting {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.newChat = NewChatRequest()
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("Nuevo chat")
                }
            }
        }
        .toolbarBackground(palette.app, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .sheet(isPresented: $choosingProjects) {
            ProjectChooser()
                .environment(model)
                .environment(\.palette, palette)
                .presentationDetents([.medium, .large])
                .presentationBackground(palette.elevated)
        }
    }

    @ViewBuilder
    private var content: some View {
        let groups = self.groups
        if model.link == .connecting && model.sessions.isEmpty && model.catalog == nil {
            VStack(spacing: 12) {
                ProgressView().tint(palette.accent)
                Text("Conectando con tu PC…").foregroundStyle(palette.muted)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else {
            header(count: groups.count)
            if !onlyWaiting, model.waitingCount > 0 || model.workingCount > 0 {
                summary
            }
            if model.link == .offline {
                offlineCard
            }
            if groups.isEmpty {
                emptyState
            }
            ForEach(groups) { group in
                ProjectSection(group: group, onlyWaiting: onlyWaiting)
            }
        }
    }

    /// «PROYECTOS ─── Todos ▾ 12»: el filtro de este iPhone.
    private func header(count: Int) -> some View {
        HStack(spacing: 10) {
            Text((onlyWaiting ? "Te esperan" : "Proyectos").uppercased()).font(TrexFont.mono(11, weight: .medium)).tracking(0.6)
            Rectangle().fill(palette.border).frame(height: 1)
            if !onlyWaiting, model.catalog != nil {
                Menu {
                    Picker("Mostrar", selection: filterMode) {
                        Label("Todos", systemImage: "square.stack").tag(ProjectFilter.Mode.all)
                        Label("Favoritos", systemImage: "star").tag(ProjectFilter.Mode.favorites)
                        Label("Mi selección", systemImage: "checklist").tag(ProjectFilter.Mode.selected)
                    }
                    Button {
                        choosingProjects = true
                    } label: {
                        Label("Elegir proyectos…", systemImage: "slider.horizontal.3")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "line.3.horizontal.decrease").font(.system(size: 10, weight: .bold))
                        Text(filterLabel)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                    }
                    .font(TrexFont.mono(11, weight: .medium))
                    .foregroundStyle(model.projectFilter.mode == .all ? palette.muted : palette.accentText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(palette.surface, in: Capsule())
                }
                .accessibilityLabel("Filtrar proyectos: \(filterLabel)")
            }
            Text("\(count)").font(TrexFont.mono(11))
        }
        .foregroundStyle(palette.dim)
        .padding(.top, 6)
    }

    private var filterLabel: String {
        switch model.projectFilter.mode {
        case .all: "Todos"
        case .favorites: "Favoritos"
        case .selected: "Mi selección"
        }
    }

    private var filterMode: Binding<ProjectFilter.Mode> {
        Binding {
            model.projectFilter.mode
        } set: { mode in
            // «Mi selección» vacía empezaría sin nada: se parte de lo que se ve ahora.
            if mode == .selected, model.projectFilter.selected.isEmpty, let catalog = model.catalog {
                model.projectFilter = ProjectFilter(mode: .selected, selected: Set(catalog.projects.filter(model.projectFilter.shows).map(\.id)))
            } else {
                model.projectFilter.mode = mode
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 12) {
            Text(onlyWaiting ? "Nada te espera."
                 : model.catalog == nil ? "Sin chats abiertos."
                 : model.projectFilter.mode == .favorites ? "Sin favoritos."
                 : "Nada en esta vista.")
                .foregroundStyle(palette.dim)
                .multilineTextAlignment(.center)
            if !onlyWaiting, model.catalog != nil, model.projectFilter.mode != .all {
                Button("Ver todos") { model.projectFilter.mode = .all }
                    .foregroundStyle(palette.accentText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 50)
    }

    private var summary: some View {
        HStack(spacing: 14) {
            if model.waitingCount > 0 {
                Button(action: showWaiting) {
                    Label("\(model.waitingCount) \(model.waitingCount == 1 ? "te espera" : "te esperan")", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(palette.warn)
                }
            }
            if model.workingCount > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("\(model.workingCount) trabajando")
                }
                .foregroundStyle(palette.muted)
            }
        }
        .font(.subheadline.weight(.medium))
    }

    private var offlineCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark").foregroundStyle(palette.warn)
            Text("Sin conexión · reintentando").font(.subheadline.weight(.medium)).foregroundStyle(palette.text)
            Spacer(minLength: 0)
            ProgressView().controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Un proyecto: cabecera plegable con su estado, su estrella y sus chats.
private struct ProjectSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let group: ProjectGroup
    let onlyWaiting: Bool

    /// Plegado por defecto salvo que algo te espere o esté trabajando.
    private var open: Bool {
        onlyWaiting || (model.projectExpanded[group.id] ?? (group.needs > 0 || group.busy))
    }

    private var canAct: Bool { model.catalog != nil && !onlyWaiting }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Button {
                    guard !onlyWaiting else { return }
                    withAnimation(.snappy(duration: 0.2)) { model.projectExpanded[group.id] = !open }
                } label: {
                    HStack(spacing: 10) {
                        if !onlyWaiting {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .bold))
                                .rotationEffect(.degrees(open ? 90 : 0))
                                .foregroundStyle(palette.dim)
                        }
                        ProjectIcon(project: group.project, size: 22)
                        Text(group.project.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(palette.text).lineLimit(1)
                        if group.favorite {
                            Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(palette.warn)
                        }
                        Spacer(minLength: 4)
                        if group.needs > 0 {
                            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13)).foregroundStyle(palette.warn)
                        } else if group.busy {
                            ProgressView().controlSize(.mini)
                        }
                        Text("\(group.sessions.count)").font(TrexFont.mono(12)).foregroundStyle(palette.dim)
                    }
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(open ? "Plegar" : "Desplegar")

                if canAct {
                    Button {
                        model.newChat = NewChatRequest(project: group.id)
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(palette.muted)
                            .frame(width: 34, height: 34)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Nuevo chat en \(group.project.name)")
                }
            }
            .contextMenu { if canAct { projectMenu } }

            if open {
                if group.sessions.isEmpty {
                    Button {
                        model.newChat = NewChatRequest(project: group.id)
                    } label: {
                        Label("Nuevo chat", systemImage: "plus.bubble")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(palette.border, style: StrokeStyle(lineWidth: 1, dash: [4])))
                    }
                    .buttonStyle(.plain)
                } else {
                    ForEach(group.sessions) { session in
                        SessionRow(session: session)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var projectMenu: some View {
        Button {
            model.newChat = NewChatRequest(project: group.id)
        } label: {
            Label("Nuevo chat", systemImage: "plus.bubble")
        }
        Button {
            Task { await model.setFavorite(group.id, !group.favorite) }
        } label: {
            Label(group.favorite ? "Quitar de favoritos" : "Marcar como favorito", systemImage: group.favorite ? "star.slash" : "star")
        }
        if let catalog = model.catalog {
            Button {
                withAnimation { model.projectFilter = model.projectFilter.hiding(group.id, among: catalog.projects) }
            } label: {
                Label("Ocultar en este iPhone", systemImage: "eye.slash")
            }
        }
    }
}

/// Elegir qué proyectos se ven en este iPhone (como «Elegir» del filtro del PC).
private struct ProjectChooser: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var projects: [RemoteCatalog.Project] {
        let all = model.catalog?.projects ?? []
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? all : all.filter { $0.name.lowercased().contains(needle) || $0.path.lowercased().contains(needle) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Proyectos").font(.headline).foregroundStyle(palette.text)
                    }
                Spacer()
                Button("Listo") { dismiss() }.font(.headline).foregroundStyle(palette.accentText)
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(palette.dim)
                TextField("Buscar", text: $search).foregroundStyle(palette.text)
            }
            .padding(10)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            HStack {
                Button("Todos") { model.projectFilter = ProjectFilter(mode: .selected, selected: Set(model.catalog?.projects.map(\.id) ?? [])) }
                Spacer()
                Button("Ninguno") { model.projectFilter = ProjectFilter(mode: .selected, selected: []) }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(palette.accentText)
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(projects) { project in
                        let shown = model.projectFilter.shows(project)
                        Button {
                            if model.projectFilter.mode == .selected {
                                model.projectFilter = model.projectFilter.toggling(project.id)
                            } else {
                                // Desde «Todos» o «Favoritos», tocar uno parte de lo que se ve ahora.
                                let visible = Set((model.catalog?.projects ?? []).filter(model.projectFilter.shows).map(\.id))
                                model.projectFilter = ProjectFilter(mode: .selected, selected: visible).toggling(project.id)
                            }
                            Haptics.tap()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: shown ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(shown ? palette.accent : palette.dim)
                                ProjectIcon(project: project.asProject, size: 22)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(project.name).foregroundStyle(palette.text).lineLimit(1)
                                    if !project.path.isEmpty {
                                        Text(project.path).font(TrexFont.mono(10.5)).foregroundStyle(palette.dim).lineLimit(1).truncationMode(.middle)
                                    }
                                }
                                Spacer()
                                if project.favorite { Image(systemName: "star.fill").font(.caption).foregroundStyle(palette.warn) }
                            }
                            .padding(10)
                            .background(palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(20)
    }
}

/// Tarjeta de una sesión. Si pide permiso, con «Rechazar» y «Permitir» a mano.
struct SessionRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let session: RemoteSession

    var body: some View {
        let need = session.need
        VStack(alignment: .leading, spacing: 10) {
            NavigationLink(value: session.id) {
                HStack(alignment: .top, spacing: 10) {
                    StatusGlyph(session: session).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(session.title)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(session.status == .exited ? palette.muted : palette.text)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 6)
                            TimelineView(.periodic(from: .now, by: 30)) { context in
                                Text(session.status == .exited ? "cerrada"
                                     : RemoteFormat.timeAgo(session.updatedAt, now: context.date.timeIntervalSince1970 * 1000))
                                    .font(TrexFont.mono(11.5))
                                    .foregroundStyle(palette.dim)
                            }
                        }
                        if !session.agentLine.isEmpty {
                            Text(session.agentLine).font(TrexFont.mono(12)).foregroundStyle(palette.dim).lineLimit(1)
                        }
                        if let line = statusLine {
                            Text(line)
                                .font(TrexFont.mono(12.5))
                                .foregroundStyle(need != nil ? palette.warn : palette.muted)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if need?.kind == .permission {
                HStack(spacing: 8) {
                    AsyncButton(kind: .normal) { await model.quickAnswer(session, allowed: false) } label: { Text("Rechazar") }
                    AsyncButton(kind: .warn) { await model.quickAnswer(session, allowed: true) } label: { Text("Permitir") }
                }
            }
        }
        .padding(14)
        .background(need != nil ? palette.elevated : palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .leading) {
            if need != nil {
                UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14)
                    .fill(palette.warn)
                    .frame(width: 3)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(need != nil ? palette.warn.opacity(0.35) : palette.border))
    }

    private var statusLine: String? {
        if let need = session.need {
            switch need.kind {
            case .permission: return "▲ pide permiso · \(need.label)"
            case .question: return "? pregunta · \(need.label)"
            case .plan: return "◆ \(need.label)"
            }
        }
        if session.status == .working { return session.activity ?? "trabajando" }
        return nil
    }
}
