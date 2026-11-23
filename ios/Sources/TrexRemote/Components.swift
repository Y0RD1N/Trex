import SwiftUI
import TrexRemoteCore
import UIKit

// Piezas pequeñas que comparten las pantallas («cuaderno de campo», docs/design/remoto-movil.html).

/// El cráneo de trex (el mismo icono de la app).
struct Brand: View {
    var size: CGFloat = 24

    var body: some View {
        Group {
            if let image = UIImage(named: "AppIcon") ?? Bundle.main.path(forResource: "AppIcon", ofType: "png").flatMap(UIImage.init(contentsOfFile:)) {
                Image(uiImage: image).resizable().interpolation(.none)
            } else {
                Image(systemName: "t.square.fill").resizable()
            }
        }
        .aspectRatio(contentMode: .fill)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct Wordmark: View {
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 9) {
            Brand(size: 24)
            Text("trex").font(.system(size: 19, weight: .semibold)).tracking(-0.3).foregroundStyle(palette.text)
        }
    }
}

/// Estado de la conexión: «▂▄▆ Oficina · 18 ms». Al tocarlo, cambia de trex o conecta otro.
struct LinkChip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            Section("Tus trex") {
                ForEach(model.servers) { server in
                    Button {
                        model.switchTo(server.id)
                    } label: {
                        if server.id == model.activeID {
                            Label(server.name, systemImage: "checkmark")
                        } else {
                            Text(server.name)
                        }
                    }
                }
            }
            Button {
                model.showPairing = true
            } label: {
                Label("Conectar otro trex…", systemImage: "plus")
            }
        } label: {
            chip
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Conexión: \(label). Cambiar de trex")
    }

    private var chip: some View {
        let online = model.link == .online
        return HStack(spacing: 6) {
            Image(systemName: online ? "cellularbars" : "wifi.exclamationmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(online ? palette.ok : palette.warn)
            Text(label).lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(palette.dim)
        }
        .font(TrexFont.mono(11))
        .foregroundStyle(palette.muted)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(palette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(palette.border))
    }

    private var label: String {
        let name = model.active?.name ?? (model.host.isEmpty ? "PC" : model.host)
        switch model.link {
        case .online:
            return model.latency.map { "\(name) · \($0) ms" } ?? name
        case .connecting: return "\(name) · conectando…"
        case .offline: return "\(name) · sin conexión"
        case .denied: return "sin emparejar"
        }
    }
}

/// Icono de estado de una sesión: el triángulo te espera, la rueda trabaja.
struct StatusGlyph: View {
    @Environment(\.palette) private var palette
    let session: RemoteSession

    var body: some View {
        Group {
            switch session.status {
            case .needs:
                Image(systemName: session.need?.kind == .question ? "questionmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(palette.warn)
                    .font(.system(size: 15))
            case .working:
                ProgressView().controlSize(.mini).tint(palette.accent)
            case .exited:
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(palette.dim)
            case .idle:
                Circle().fill(palette.dim).frame(width: 7, height: 7)
            }
        }
        .frame(width: 20, height: 20)
    }
}

/// Logo del proyecto que usa el PC o, si no tiene, su inicial sobre un color estable.
struct ProjectIcon: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let project: RemoteProject
    var size: CGFloat = 20
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(palette.projectColor(project.id).opacity(0.22))
                    Text(String(project.name.prefix(1)).uppercased())
                        .font(.system(size: size * 0.55, weight: .bold))
                        .foregroundStyle(palette.projectColor(project.id))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .task(id: project.id) { image = await model.icon(for: project.id) }
        .accessibilityHidden(true)
    }
}

/// Encabezado de sección en mono con su regla y contador: «TE NECESITAN ──── 2».
struct SectionRule: View {
    @Environment(\.palette) private var palette
    let title: String
    var count: Int?

    var body: some View {
        HStack(spacing: 10) {
            Text(title.uppercased()).font(TrexFont.mono(11, weight: .medium)).tracking(0.6)
            Rectangle().fill(palette.border).frame(height: 1)
            if let count { Text("\(count)").font(TrexFont.mono(11)) }
        }
        .foregroundStyle(palette.dim)
        .padding(.top, 6)
    }
}

/// Aviso breve abajo (errores de órdenes, subidas…). Se va solo.
struct ToastOverlay: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        if let text = model.toast {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(palette.text)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.danger.opacity(0.5)))
                .shadow(color: .black.opacity(0.3), radius: 12, y: 4)
                .padding(.horizontal, 16)
                .padding(.bottom, 90)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onTapGesture { model.toast = nil }
                .task(id: text) {
                    try? await Task.sleep(for: .seconds(4.2))
                    if model.toast == text { withAnimation { model.toast = nil } }
                }
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

/// Botones del cuaderno: normal, primario (acento), aviso (ámbar), peligro y fantasma.
struct TrexButtonStyle: ButtonStyle {
    enum Kind { case normal, primary, warn, danger, ghost }

    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled
    var kind: Kind = .normal
    var tall = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)
            .frame(height: tall ? 50 : 40)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(border))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary, .warn: palette.accentInk
        case .danger: palette.danger
        case .normal, .ghost: palette.text
        }
    }

    private var background: Color {
        switch kind {
        case .primary: palette.accent
        case .warn: palette.warn
        case .danger: palette.danger.opacity(0.12)
        case .normal: palette.inset
        case .ghost: .clear
        }
    }

    private var border: Color {
        switch kind {
        case .ghost: palette.border
        case .danger: palette.danger.opacity(0.4)
        default: .clear
        }
    }
}

extension ButtonStyle where Self == TrexButtonStyle {
    static func trex(_ kind: TrexButtonStyle.Kind = .normal, tall: Bool = false) -> TrexButtonStyle {
        TrexButtonStyle(kind: kind, tall: tall)
    }
}

/// Botón que muestra una rueda mientras su trabajo asíncrono no termina.
struct AsyncButton<Label: View>: View {
    var kind: TrexButtonStyle.Kind = .normal
    var tall = false
    let action: () async -> Void
    @ViewBuilder let label: () -> Label
    @State private var busy = false

    var body: some View {
        Button {
            guard !busy else { return }
            busy = true
            Task {
                await action()
                busy = false
            }
        } label: {
            if busy { ProgressView().controlSize(.small) } else { label() }
        }
        .buttonStyle(.trex(kind, tall: tall))
        .disabled(busy)
    }
}

/// «+48 −3»
struct DiffStat: View {
    @Environment(\.palette) private var palette
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(added)").foregroundStyle(palette.ok)
            Text("−\(removed)").foregroundStyle(palette.danger)
        }
        .font(TrexFont.mono(11.5))
    }
}
