import SwiftUI
import TrexRemoteCore
import UIKit

/// A · Emparejar: escanea el QR del PC o escribe la dirección y el código de seis caracteres.
/// Sirve para el primer trex y, en una hoja, para conectar otro (el de casa, el de la oficina…).
struct PairView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    /// En la hoja «Conectar otro trex» (con botón para cancelar).
    var adding = false

    @State private var server: String
    @State private var code = ""
    @State private var name = UIDevice.current.name
    @State private var busy = false
    @State private var error: String?
    @State private var scanning = false
    @FocusState private var focus: Field?

    private enum Field { case server, code, name }

    init(adding: Bool = false) {
        self.adding = adding
        // Al añadir otro trex la dirección será otra: el campo empieza vacío.
        _server = State(initialValue: adding ? "" : CredentialStore.lastServer?.display ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Wordmark()
                    Spacer()
                    if adding {
                        Button("Cancelar") { model.showPairing = false }
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(palette.accentText)
                    }
                }
                .padding(.top, 8)

                VStack(alignment: .leading, spacing: 6) {
                    Text(adding ? "Otro trex" : "Conecta con tu PC").font(.system(size: 28, weight: .bold)).foregroundStyle(palette.text)
                    Text("trex › Ajustes › Control remoto › Emparejar")
                        .font(TrexFont.mono(12))
                        .foregroundStyle(palette.muted)
                }

                Button {
                    focus = nil
                    scanning = true
                } label: {
                    Label("Escanear QR", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.trex(.primary, tall: true))

                SectionRule(title: "o a mano")

                field("servidor", hint: nil) {
                    TextField("10.8.0.2:7340", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .server)
                        .submitLabel(.next)
                        .onSubmit { focus = .code }
                }

                field("código", hint: nil) {
                    TextField("K7Q4MX", text: $code)
                        .font(TrexFont.mono(24, weight: .semibold))
                        .tracking(6)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                        .focused($focus, equals: .code)
                        .submitLabel(.go)
                        .onSubmit { Task { await submit() } }
                        .onChange(of: code) { _, value in
                            let clean = String(PairingCode.normalize(value).prefix(PairingCode.length))
                            if clean != value { code = clean }
                        }
                }

                field("nombre", hint: nil) {
                    TextField("iPhone", text: $name).focused($focus, equals: .name)
                }

                if let message = error ?? (adding ? nil : model.deniedReason) {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Task { await submit() }
                } label: {
                    if busy { ProgressView().controlSize(.small) } else { Text("Emparejar") }
                }
                .buttonStyle(.trex(.primary, tall: true))
                .disabled(busy || code.count < PairingCode.length || ServerAddress(typed: server) == nil)
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.app.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            ScanSheet { text in
                scanning = false
                scanned(text)
            } onCancel: {
                scanning = false
            }
        }
    }

    private func field<Content: View>(_ title: String, hint: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
            content()
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border))
                .foregroundStyle(palette.text)
            if let hint { Text(hint).font(.caption).foregroundStyle(palette.dim) }
        }
    }

    private func scanned(_ text: String) {
        guard let link = PairingLink(scanned: text) else {
            error = "Ese QR no es de trex."
            return
        }
        // Con https (Tailscale) se guarda la URL entera; con http basta «IP:puerto».
        server = link.server.isSecure ? link.server.base.absoluteString : link.server.display
        if let scannedCode = link.code {
            code = scannedCode
            // Desde el QR el código ya viene en el enlace: se empareja sin teclear nada.
            Task { await submit(server: link.server) }
        } else {
            focus = .code
        }
    }

    private func submit(server address: ServerAddress? = nil) async {
        guard !busy else { return }
        guard let target = address ?? ServerAddress(typed: server) else {
            error = "Dirección no válida."
            return
        }
        guard code.count >= PairingCode.length else { return }
        busy = true
        error = nil
        focus = nil
        do {
            let deviceName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            try await model.pair(server: target, code: code, name: deviceName.isEmpty ? "iPhone" : deviceName)
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
        busy = false
    }
}

/// Visor a pantalla completa con la cámara y un marco de enfoque.
private struct ScanSheet: View {
    let onCode: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        ZStack {
            QRScannerView(onCode: onCode).ignoresSafeArea()
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color(hex: 0xF06A8D), lineWidth: 3)
                .frame(width: 250, height: 250)
            VStack {
                HStack {
                    Spacer()
                    Button("Cancelar", action: onCancel)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.black.opacity(0.5), in: Capsule())
                }
                Spacer()
                Text("Escanea el código del PC")
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.black.opacity(0.5), in: Capsule())
            }
            .padding()
        }
    }
}
