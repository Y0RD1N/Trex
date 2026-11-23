import SwiftUI
import UIKit

/// Cuánto tapa el teclado a una vista, medido con el `keyboardLayoutGuide` de UIKit (la guía
/// que usan las apps del sistema; sigue al teclado en sus animaciones).
///
/// Se usa en lugar del ajuste automático de SwiftUI: en iOS 26/27 el cristal del teclado
/// empieza unos puntos por encima del borde que informa iOS y el cuadro de texto quedaba
/// metido debajo. Con la medida en la mano, el chat deja además un margen propio.
struct KeyboardMetrics: Equatable {
    /// Puntos de la vista que quedan bajo el borde del teclado (0 si está oculto).
    var overlap: CGFloat = 0
    /// Borde superior del teclado según la guía, en coordenadas de la vista.
    var guideTop: CGFloat = 0
    /// Alto de la vista y su borde inferior en coordenadas de la ventana.
    var height: CGFloat = 0
    var bottomInWindow: CGFloat = 0
    var windowHeight: CGFloat = 0
    var safeBottom: CGFloat = 0

    var visible: Bool { overlap > 0.5 }
}

struct KeyboardReader: UIViewRepresentable {
    var onChange: (KeyboardMetrics) -> Void

    func makeUIView(context: Context) -> KeyboardReaderView {
        let view = KeyboardReaderView()
        view.onChange = onChange
        return view
    }

    func updateUIView(_ view: KeyboardReaderView, context: Context) {
        view.onChange = onChange
    }
}

final class KeyboardReaderView: UIView {
    var onChange: ((KeyboardMetrics) -> Void)?
    private var last: KeyboardMetrics?
    /// Una vista mínima atada al borde del teclado: cuando la guía se mueve, UIKit vuelve a
    /// maquetar esta vista y se recalcula la medida.
    private let probe = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        // Con el teclado oculto la guía queda al borde de la pantalla, no al del área segura.
        keyboardLayoutGuide.usesBottomSafeArea = false
        probe.translatesAutoresizingMaskIntoConstraints = false
        probe.isUserInteractionEnabled = false
        addSubview(probe)
        NSLayoutConstraint.activate([
            probe.leadingAnchor.constraint(equalTo: leadingAnchor),
            probe.widthAnchor.constraint(equalToConstant: 1),
            probe.heightAnchor.constraint(equalToConstant: 1),
            probe.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) no se usa") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let window else { return }
        let top = keyboardLayoutGuide.layoutFrame.minY
        let metrics = KeyboardMetrics(
            overlap: max(0, bounds.maxY - top),
            guideTop: top,
            height: bounds.height,
            bottomInWindow: convert(bounds, to: window).maxY,
            windowHeight: window.bounds.height,
            safeBottom: window.safeAreaInsets.bottom
        )
        guard metrics != last else { return }
        last = metrics
        let callback = onChange
        // Fuera de la pasada de maquetación: SwiftUI no admite cambiar estado mientras pinta.
        DispatchQueue.main.async { callback?(metrics) }
    }
}
