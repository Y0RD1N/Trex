import SwiftUI
import TrexRemoteCore

/// Este iPhone: tus trex (cambiar, renombrar, olvidar, conectar otro), avisos y diagnóstico.
struct DeviceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @AppStorage("keyboardDiagnostics") private var keyboardDiagnostics = false

    @State private var renaming: ServerProfile?
    @State private var newName = ""
    @State private var forgetting: ServerProfile?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                SectionRule(title: "Tus trex", count: model.servers.count)
                VStack(spacing: 8) {
                    ForEach(model.servers) { server in
                        ServerRow(server: server, onRename: {
                            newName = server.label ?? ""
                            renaming = server
                        }, onForget: {
                            forgetting = server
                        })
                    }
                    Button {
                        model.showPairing = true
                    } label: {
                        Label("Conectar otro trex", systemImage: "plus")
                    }
                    .buttonStyle(.trex(.ghost, tall: true))
                }

                SectionRule(title: "Ajustes")
                card {
                    HStack {
                        Text("Avisos").foregroundStyle(palette.text)
                        Spacer()
                        if model.notificationsAllowed {
                            Text("activados").font(TrexFont.mono(12)).foregroundStyle(palette.dim)
                        } else {
                            Button("Activar") { Task { await model.requestNotifications() } }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(palette.accentText)
                        }
                    }
                    Toggle(isOn: $keyboardDiagnostics) {
                        Text("Medidas del teclado").foregroundStyle(palette.text)
                    }
                    .tint(palette.accent)
                    if let version = model.version {
                        HStack {
                            Text("trex en el PC").foregroundStyle(palette.text)
                            Spacer()
                            Text(version).font(TrexFont.mono(12)).foregroundStyle(palette.dim)
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(palette.app.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Wordmark() }
            ToolbarItem(placement: .topBarTrailing) { LinkChip() }
        }
        .toolbarBackground(palette.app, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .alert("Nombre", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(renaming?.host ?? "Oficina", text: $newName)
            Button("Guardar") {
                if let renaming { model.rename(renaming.id, to: newName) }
                renaming = nil
            }
            Button("Cancelar", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(
            "¿Olvidar \(forgetting?.name ?? "este trex")?",
            isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Olvidar", role: .destructive) {
                if let forgetting { model.forget(forgetting.id) }
                forgetting = nil
            }
        } message: {
            Text("Desvincúlalo también en el PC para quitarle el acceso.")
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.border))
    }


}

/// Un trex de la lista: tocarlo cambia a él; el menú permite renombrarlo u olvidarlo.
private struct ServerRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let server: ServerProfile
    let onRename: () -> Void
    let onForget: () -> Void

    private var isActive: Bool { server.id == model.activeID }

    var body: some View {
        HStack(spacing: 12) {
            Button {
                model.switchTo(server.id)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 18))
                        .foregroundStyle(isActive ? palette.accentText : palette.dim)
                        .frame(width: 36, height: 36)
                        .background(isActive ? palette.accent.opacity(0.14) : palette.inset, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(server.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(palette.text).lineLimit(1)
                        Text(details).font(TrexFont.mono(11.5)).foregroundStyle(palette.dim).lineLimit(1)
                        if isActive {
                            HStack(spacing: 5) {
                                Circle().fill(statusColor).frame(width: 7, height: 7)
                                Text(statusText).font(TrexFont.mono(11.5)).foregroundStyle(statusColor)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    if isActive {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(palette.accent)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(isActive ? "Conectado ahora" : "Cambiar a este trex")

            Menu {
                if !isActive {
                    Button { model.switchTo(server.id) } label: { Label("Usar", systemImage: "arrow.left.arrow.right") }
                }
                Button(action: onRename) { Label("Renombrar…", systemImage: "pencil") }
                Button(role: .destructive, action: onForget) { Label("Olvidar", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(palette.muted)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Opciones de \(server.name)")
        }
        .padding(12)
        .background(isActive ? palette.elevated : palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(isActive ? palette.accent.opacity(0.5) : palette.border))
    }

    /// «10.8.0.2:7340» (y el nombre del PC si se renombró).
    private var details: String {
        var parts = [server.server.display]
        if server.label != nil, let host = server.host, !host.isEmpty { parts.insert(host, at: 0) }
        return parts.joined(separator: " · ")
    }

    private var statusText: String {
        switch model.link {
        case .online: model.latency.map { "en línea · \($0) ms" } ?? "en línea"
        case .connecting: "conectando…"
        case .offline: "sin conexión · reintentando"
        case .denied: "sin emparejar"
        }
    }

    private var statusColor: Color {
        switch model.link {
        case .online: palette.ok
        case .connecting: palette.muted
        case .offline, .denied: palette.warn
        }
    }
}
