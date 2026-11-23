import SwiftUI
import TrexRemoteCore

/// La paleta «sedimento» de trex (src/tokens.css). El PC manda su tono y su acento con el
/// mensaje `theme` y se escriben encima, como hace la PWA con las variables CSS.
struct Palette: Equatable {
    var isDark: Bool
    var app: Color
    var sidebar: Color
    var surface: Color
    var elevated: Color
    var inset: Color
    var selected: Color
    var border: Color
    var borderStrong: Color
    var text: Color
    var muted: Color
    var dim: Color
    var accent: Color
    var accentText: Color
    var accentInk: Color
    var ok: Color
    var warn: Color
    var danger: Color

    static let dark = Palette(
        isDark: true,
        app: Color(hex: 0x16130E), sidebar: Color(hex: 0x110F0B), surface: Color(hex: 0x1C1913), elevated: Color(hex: 0x221E17),
        inset: Color(hex: 0x29241B), selected: Color(hex: 0x2A251C), border: Color(hex: 0x342F24), borderStrong: Color(hex: 0x4B4434),
        text: Color(hex: 0xE8E0CC), muted: Color(hex: 0xB0A791), dim: Color(hex: 0x968E7A),
        accent: Color(hex: 0xF06A8D), accentText: Color(hex: 0xF47F9D), accentInk: Color(hex: 0x16130E),
        ok: Color(hex: 0x7DB58F), warn: Color(hex: 0xD9A23F), danger: Color(hex: 0xE0674F)
    )

    static let light = Palette(
        isDark: false,
        app: Color(hex: 0xF2EDE0), sidebar: Color(hex: 0xEAE4D2), surface: Color(hex: 0xF7F3E8), elevated: Color(hex: 0xFAF7EE),
        inset: Color(hex: 0xE5DECB), selected: Color(hex: 0xDDD5BF), border: Color(hex: 0xD4CCB5), borderStrong: Color(hex: 0xB4AA8F),
        text: Color(hex: 0x1E1A13), muted: Color(hex: 0x5A5345), dim: Color(hex: 0x615948),
        accent: Color(hex: 0xF06A8D), accentText: Color(hex: 0xA8305A), accentInk: Color(hex: 0x16130E),
        ok: Color(hex: 0x2C6C45), warn: Color(hex: 0x8A6208), danger: Color(hex: 0xA8402C)
    )

    /// La paleta base del modo del PC con sus colores encima.
    init(theme: RemoteTheme) {
        self = theme.isDark ? .dark : .light
        let mapping: [(String, WritableKeyPath<Palette, Color>)] = [
            ("app", \.app), ("sidebar", \.sidebar), ("surface", \.surface), ("elevated", \.elevated), ("inset", \.inset),
            ("selected", \.selected), ("border", \.border), ("borderStrong", \.borderStrong), ("text", \.text),
            ("muted", \.muted), ("dim", \.dim), ("accent", \.accent), ("accentText", \.accentText), ("accentInk", \.accentInk),
        ]
        for (key, path) in mapping {
            if let value = theme.colors[key], let color = Color(hexString: value) { self[keyPath: path] = color }
        }
    }

    private init(
        isDark: Bool, app: Color, sidebar: Color, surface: Color, elevated: Color, inset: Color, selected: Color, border: Color,
        borderStrong: Color, text: Color, muted: Color, dim: Color, accent: Color, accentText: Color, accentInk: Color,
        ok: Color, warn: Color, danger: Color
    ) {
        self.isDark = isDark
        self.app = app
        self.sidebar = sidebar
        self.surface = surface
        self.elevated = elevated
        self.inset = inset
        self.selected = selected
        self.border = border
        self.borderStrong = borderStrong
        self.text = text
        self.muted = muted
        self.dim = dim
        self.accent = accent
        self.accentText = accentText
        self.accentInk = accentInk
        self.ok = ok
        self.warn = warn
        self.danger = danger
    }

    /// Color de un proyecto sin icono (estable por id), del mismo tono que el acento.
    func projectColor(_ id: String) -> Color {
        let hues: [Double] = [0.95, 0.08, 0.13, 0.45, 0.58, 0.75]
        var hash: UInt32 = 2166136261
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
        return Color(hue: hues[Int(hash % UInt32(hues.count))], saturation: 0.45, brightness: isDark ? 0.78 : 0.55)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }

    /// `#rrggbb`; nil si no tiene esa forma.
    init?(hexString: String) {
        var text = hexString.trimmingCharacters(in: .whitespaces)
        guard text.hasPrefix("#") else { return nil }
        text.removeFirst()
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(hex: value)
    }
}

/// Tipografías: el sistema para leer y monoespaciada para los metadatos, como el cuaderno de la PWA.
enum TrexFont {
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// La paleta viaja por el entorno para que cualquier vista la lea sin depender del modelo.
private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.dark
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
