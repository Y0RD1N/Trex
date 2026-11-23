import SwiftUI
import TrexRemoteCore

/// Abrir un chat en el PC desde el iPhone: proyecto, asistente, permisos y, o bien modelo,
/// esfuerzo, velocidad y primer mensaje, o bien una conversación guardada para retomarla.
/// Lo resuelve la app del PC por los mismos caminos que «Nueva sesión» y «Recuperar conversación».
struct NewChatSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    private enum Mode: Hashable { case new, resume }
    private enum Loading: Equatable { case idle, loading, failed(String) }

    let catalog: RemoteCatalog

    @State private var projectID: String
    @State private var profileID: String
    @State private var mode = Mode.new
    @State private var chosenModel = ""
    /// "" deja el esfuerzo predeterminado del modelo.
    @State private var chosenEffort = ""
    @State private var fast = false
    /// "" deja el modo de permisos que heredaría el chat en el PC.
    @State private var chosenPermission = ""
    @State private var models: [ModelOption] = []
    @State private var modelsState = Loading.idle
    @State private var conversations: [SavedConversation] = []
    @State private var conversationsState = Loading.idle
    @State private var conversation: SavedConversation?
    @State private var search = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    init(request: NewChatRequest, catalog: RemoteCatalog, visibleProjects: [String]) {
        self.catalog = catalog
        let project = request.project ?? visibleProjects.first ?? catalog.projects.first?.id ?? ""
        _projectID = State(initialValue: project)
        _profileID = State(initialValue: catalog.defaultProfile?.id ?? "")
    }

    private var project: RemoteCatalog.Project? { catalog.projects.first { $0.id == projectID } }
    private var profile: RemoteCatalog.Profile? { catalog.profiles.first { $0.id == profileID } }
    private var choiceKey: String { "\(projectID)|\(profileID)" }

    /// El modelo cuyas opciones se ofrecen: el elegido o, con «Predeterminado», el que el
    /// asistente recomienda («default»), si lo anuncia.
    private var effectiveModel: ModelOption? {
        chosenModel.isEmpty ? models.first { $0.value == "default" } : models.first { $0.value == chosenModel }
    }

    private var ready: Bool {
        guard !busy, project != nil, profile != nil else { return false }
        return mode == .new || conversation != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Nuevo chat").font(.system(size: 22, weight: .bold)).foregroundStyle(palette.text)
                    Spacer()
                    Button("Cancelar") { model.newChat = nil }.foregroundStyle(palette.accentText)
                }

                section("proyecto") { projectPicker }
                section("asistente") {
                    chips(catalog.profiles.map { ($0.id, $0.name) }, selection: $profileID)
                }

                Picker("Modo", selection: $mode) {
                    Text("Nuevo").tag(Mode.new)
                    Text("Retomar").tag(Mode.resume)
                }
                .pickerStyle(.segmented)

                if mode == .new {
                    section("modelo") { modelPicker }
                    if let options = effectiveModel {
                        if !options.efforts.isEmpty { section("esfuerzo") { effortPicker(options) } }
                        if let hint = options.fastHint { speedToggle(hint) }
                    }
                }

                if let profile, !profile.modes.isEmpty {
                    section("permisos") { permissionPicker(profile) }
                }

                if mode == .new {
                    TextField("Mensaje (opcional)", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                        .foregroundStyle(palette.text)
                        .padding(12)
                        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border))
                } else {
                    conversationList
                }

                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Task { await open() }
                } label: {
                    if busy { ProgressView().controlSize(.small) } else { Text(mode == .new ? "Abrir" : "Retomar") }
                }
                .buttonStyle(.trex(.primary, tall: true))
                .disabled(!ready)
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.elevated.ignoresSafeArea())
        // Al cambiar proyecto o asistente, lo cargado deja de valer.
        .task(id: choiceKey) {
            chosenModel = ""
            chosenPermission = ""
            conversation = nil
            conversations = []
            conversationsState = .idle
            await loadModels()
            if mode == .resume { await loadConversations() }
        }
        .onChange(of: mode) { _, value in
            error = nil
            if value == .resume, conversationsState == .idle { Task { await loadConversations() } }
        }
        // Cada modelo tiene sus niveles y su velocidad: al cambiarlo se vuelve a lo predeterminado.
        .onChange(of: chosenModel) { _, _ in
            chosenEffort = ""
            fast = false
        }
    }

    // MARK: Piezas

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
            content()
        }
    }

    /// Opciones en píldoras (asistente, esfuerzo, permisos).
    private func chips(_ items: [(value: String, title: String)], selection: Binding<String>) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items, id: \.value) { item in
                    let isSelected = selection.wrappedValue == item.value
                    Button {
                        selection.wrappedValue = item.value
                        Haptics.tap()
                    } label: {
                        Text(item.title)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(isSelected ? palette.accentInk : palette.text)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(isSelected ? palette.accent : palette.surface, in: Capsule())
                            .overlay(Capsule().strokeBorder(isSelected ? .clear : palette.border))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(palette.dim).fixedSize(horizontal: false, vertical: true)
    }

    private var projectPicker: some View {
        Menu {
            ForEach(catalog.projects) { item in
                Button {
                    projectID = item.id
                } label: {
                    if item.id == projectID { Label(item.name, systemImage: "checkmark") } else { Text(item.name) }
                }
            }
        } label: {
            pickerLabel {
                if let project { ProjectIcon(project: project.asProject, size: 22) }
                Text(project?.name ?? "Proyecto").foregroundStyle(palette.text)
            }
        }
    }

    private var modelPicker: some View {
        Menu {
            Button {
                chosenModel = ""
            } label: {
                if chosenModel.isEmpty { Label("Predeterminado", systemImage: "checkmark") } else { Text("Predeterminado") }
            }
            let featured = models.filter(\.featured)
            let others = models.filter { !$0.featured }
            if !featured.isEmpty {
                Section("Modelos") { ForEach(featured) { modelButton($0) } }
            }
            if !others.isEmpty {
                Section("Otras versiones") { ForEach(others) { modelButton($0) } }
            }
        } label: {
            pickerLabel(loading: modelsState == .loading) {
                Text(models.first { $0.value == chosenModel }?.label ?? "Predeterminado").foregroundStyle(palette.text)
                if case .failed = modelsState {
                    Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(palette.warn)
                }
            }
        }
    }

    private func pickerLabel<Content: View>(loading: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 10) {
            content()
            Spacer()
            if loading { ProgressView().controlSize(.small) } else {
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(palette.dim)
            }
        }
        .padding(12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border))
    }

    private func modelButton(_ option: ModelOption) -> some View {
        Button {
            chosenModel = option.value
        } label: {
            if option.value == chosenModel { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
        }
    }

    private func effortPicker(_ options: ModelOption) -> some View {
        let defaultLabel = options.efforts.first { $0.value == options.defaultEffort }?.label
        let items: [(value: String, title: String)] = [("", defaultLabel.map { "Predeterminado · \($0)" } ?? "Predeterminado")]
            + options.efforts.map { ($0.value, $0.label) }
        return VStack(alignment: .leading, spacing: 8) {
            chips(items, selection: $chosenEffort)
            if let hint = options.efforts.first(where: { $0.value == chosenEffort })?.hint, !hint.isEmpty { caption(hint) }
        }
    }

    private func speedToggle(_ hint: String) -> some View {
        Toggle(isOn: $fast) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Velocidad rápida").foregroundStyle(palette.text)
                caption(hint)
            }
        }
        .tint(palette.accent)
        .padding(12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border))
    }

    /// Los modos del asistente; sin tocar, el que heredaría el chat en el PC.
    private func permissionPicker(_ profile: RemoteCatalog.Profile) -> some View {
        let selection = Binding<String>(
            get: { chosenPermission.isEmpty ? (profile.mode ?? "") : chosenPermission },
            set: { chosenPermission = $0 }
        )
        let current = profile.modes.first { $0.value == selection.wrappedValue }
        return VStack(alignment: .leading, spacing: 8) {
            chips(profile.modes.map { ($0.value, $0.label) }, selection: selection)
            if let description = current?.description, !description.isEmpty { caption(description) }
        }
    }

    @ViewBuilder
    private var conversationList: some View {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = needle.isEmpty ? conversations : conversations.filter { $0.title.lowercased().contains(needle) }
        VStack(alignment: .leading, spacing: 8) {
            switch conversationsState {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 16)
            case .failed(let reason):
                HStack {
                    caption(reason)
                    Spacer()
                    Button("Reintentar") { Task { await loadConversations() } }.font(.subheadline).foregroundStyle(palette.accentText)
                }
            case .idle:
                if conversations.isEmpty {
                    caption("Sin conversaciones guardadas.")
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(palette.dim)
                        TextField("Buscar", text: $search).foregroundStyle(palette.text)
                    }
                    .padding(10)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    ForEach(shown) { item in
                        let selected = conversation?.id == item.id
                        Button {
                            conversation = item
                            Haptics.tap()
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(item.title).foregroundStyle(palette.text).lineLimit(2).multilineTextAlignment(.leading)
                                Spacer(minLength: 8)
                                Text(RemoteFormat.timeAgo(item.updatedAt, now: RemoteFormat.nowMilliseconds()))
                                    .font(TrexFont.mono(11)).foregroundStyle(palette.dim)
                            }
                            .padding(12)
                            .background(selected ? palette.accent.opacity(0.12) : palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? palette.accent : palette.border))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Acciones

    private func loadModels() async {
        guard project != nil, profile != nil else { return }
        let key = choiceKey
        modelsState = .loading
        models = []
        do {
            let list = try await model.models(project: projectID, profile: profileID)
            guard key == choiceKey else { return }
            models = list
            modelsState = .idle
        } catch {
            guard key == choiceKey else { return }
            modelsState = .failed(error.localizedDescription)
        }
    }

    private func loadConversations() async {
        guard project != nil, profile != nil else { return }
        let key = choiceKey
        conversationsState = .loading
        do {
            let list = try await model.conversations(project: projectID, profile: profileID)
            guard key == choiceKey else { return }
            conversations = list
            conversationsState = .idle
        } catch {
            guard key == choiceKey else { return }
            conversationsState = .failed(error.localizedDescription)
        }
    }

    private func open() async {
        guard ready else { return }
        busy = true
        error = nil
        let options = mode == .new ? effectiveModel : nil
        // Solo se manda el modo si se cambió y es uno de los del asistente.
        let permission = profile?.modes.contains { $0.value == chosenPermission } == true ? chosenPermission : nil
        do {
            try await model.openChat(
                project: projectID,
                profile: profileID,
                model: mode == .new && !chosenModel.isEmpty ? chosenModel : nil,
                // Solo lo que el modelo admite; lo demás queda como lo tenga el asistente.
                effort: options?.efforts.contains { $0.value == chosenEffort } == true ? chosenEffort : nil,
                fast: options?.supportsFast == true && fast ? true : nil,
                mode: permission,
                conversation: mode == .resume ? conversation : nil,
                text: mode == .new ? text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            )
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
        busy = false
    }
}
