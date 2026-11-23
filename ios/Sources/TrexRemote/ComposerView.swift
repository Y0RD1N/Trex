import PhotosUI
import SwiftUI
import TrexRemoteCore
import UIKit
import UniformTypeIdentifiers

/// Escribir a la sesión. Los adjuntos se suben al PC al elegirlos y el mensaje solo lleva
/// sus ids; en el texto quedan sus citas «[Imagen 1]», como en el escritorio.
struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let sessionID: String
    let detail: RemoteDetail

    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var busy = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingFiles = false
    @FocusState private var focused: Bool

    private static let maxImages = 10
    private static let maxFiles = 10

    struct Attachment: Identifiable {
        let id = UUID()
        var kind: AttachmentReference
        var name: String
        var size: Int
        var preview: UIImage?
        var uploadedID: String?
        var error: String?
        var uploading: Bool { uploadedID == nil && error == nil }
    }

    private var uploading: Bool { attachments.contains { $0.uploading } }
    private var failed: Bool { attachments.contains { $0.error != nil } }
    private var ready: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) && !uploading && !failed && !busy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let locked = detail.locked {
                Label(locked, systemImage: "lock.fill")
                    .font(.subheadline)
                    .foregroundStyle(palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            } else {
                if detail.queues {
                    Text("en cola\(detail.queued > 0 ? " · \(detail.queued)" : "")")
                        .font(TrexFont.mono(11.5))
                        .foregroundStyle(palette.dim)
                        .padding(.horizontal, 4)
                }
                if !attachments.isEmpty { attachmentStrip }
                inputBox
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(palette.sidebar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(palette.border).frame(height: 1) }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: Self.maxImages, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            addPhotos(items)
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { addFiles(urls) }
        }
    }

    private var inputBox: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button { pickingPhotos = true } label: { Label("Fotos", systemImage: "photo.on.rectangle") }
                Button { pickingFiles = true } label: { Label("Archivos", systemImage: "doc") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(palette.muted)
                    .frame(width: 38, height: 38)
            }
            .accessibilityLabel("Adjuntar fotos o archivos")

            TextField(detail.queues ? "Encolar…" : "Mensaje…", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .foregroundStyle(palette.text)
                .padding(.vertical, 9)

            Button {
                Task { await send() }
            } label: {
                Group {
                    if busy || uploading {
                        ProgressView().controlSize(.small).tint(palette.accentInk)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                    }
                }
                .foregroundStyle(palette.accentInk)
                .frame(width: 38, height: 38)
                .background(ready ? palette.accent : palette.border, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .disabled(!ready)
            .accessibilityLabel(detail.queues ? "Añadir a la cola" : "Enviar")
        }
        .padding(4)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(focused ? palette.accent.opacity(0.6) : palette.border))
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { item in
                    AttachmentChip(item: item, number: number(of: item)) { remove(item) }
                }
            }
        }
    }

    private func number(of item: Attachment) -> Int {
        (attachments.filter { $0.kind == item.kind }.firstIndex { $0.id == item.id } ?? 0) + 1
    }

    // MARK: Adjuntar

    private func addPhotos(_ items: [PhotosPickerItem]) {
        let room = Self.maxImages - attachments.filter { $0.kind == .image }.count
        if items.count > room { model.toast = "Máximo \(Self.maxImages) imágenes." }
        let accepted = Array(items.prefix(max(0, room)))
        guard !accepted.isEmpty else { return }
        let first = attachments.filter { $0.kind == .image }.count
        text = AttachmentReference.image.append(to: text, first: first, count: accepted.count)
        for (offset, item) in accepted.enumerated() {
            let attachment = Attachment(kind: .image, name: "foto-\(first + offset + 1).jpg", size: 0)
            insert(attachment)
            let id = attachment.id
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self),
                      let prepared = await Self.shrink(data) else {
                    update(id) { $0.error = "Foto ilegible." }
                    return
                }
                update(id) {
                    $0.preview = prepared.preview
                    $0.size = prepared.data.count
                }
                await upload(id, data: prepared.data)
            }
        }
    }

    private func addFiles(_ urls: [URL]) {
        let room = Self.maxFiles - attachments.filter { $0.kind == .file }.count
        if urls.count > room { model.toast = "Máximo \(Self.maxFiles) archivos." }
        let accepted = Array(urls.prefix(max(0, room)))
        guard !accepted.isEmpty else { return }
        let first = attachments.filter { $0.kind == .file }.count
        text = AttachmentReference.file.append(to: text, first: first, count: accepted.count)
        for url in accepted {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let data = try? Data(contentsOf: url)
            var attachment = Attachment(kind: .file, name: url.lastPathComponent, size: data?.count ?? 0)
            if data == nil { attachment.error = "Archivo ilegible." }
            insert(attachment)
            if let data {
                let id = attachment.id
                Task { await upload(id, data: data) }
            }
        }
    }

    /// Primero las imágenes y después los archivos: así se numeran en el PC.
    private func insert(_ attachment: Attachment) {
        let images = attachments.filter { $0.kind == .image }
        let files = attachments.filter { $0.kind == .file }
        attachments = attachment.kind == .image ? images + [attachment] + files : images + files + [attachment]
    }

    private func upload(_ id: UUID, data: Data) async {
        guard let name = attachments.first(where: { $0.id == id })?.name else { return }
        do {
            let uploaded = try await model.upload(data, name: name)
            update(id) {
                $0.uploadedID = uploaded.id
                $0.size = uploaded.size
            }
        } catch {
            update(id) { $0.error = error.localizedDescription }
            model.toast = "\(name): \(error.localizedDescription)"
        }
    }

    private func update(_ id: UUID, _ change: (inout Attachment) -> Void) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        change(&attachments[index])
    }

    private func remove(_ item: Attachment) {
        let total = attachments.filter { $0.kind == item.kind }.count
        text = item.kind.remove(number(of: item), from: text, total: total)
        attachments.removeAll { $0.id == item.id }
    }

    /// Reduce la foto a 1920 px y la pasa a JPEG, como el escritorio: sube antes y gasta menos contexto.
    private static func shrink(_ data: Data) async -> (data: Data, preview: UIImage)? {
        await Task.detached(priority: .userInitiated) {
            guard let image = UIImage(data: data) else { return nil }
            let longest = max(image.size.width, image.size.height)
            let scale = min(1, 1920 / max(longest, 1))
            let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            guard let jpeg = resized.jpegData(compressionQuality: 0.86) else { return nil }
            let preview = resized.preparingThumbnail(of: CGSize(width: 120, height: 120)) ?? resized
            return (jpeg, preview)
        }.value
    }

    // MARK: Enviar

    private func send() async {
        guard ready else { return }
        busy = true
        defer { busy = false }
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let ids = attachments.compactMap(\.uploadedID)
        // Se vacía al instante (el PC suele publicar el mensaje antes de confirmar la orden);
        // si falla, el borrador vuelve a su sitio.
        let draft = (text: text, attachments: attachments)
        text = ""
        attachments = []
        do {
            try await model.command(sessionID, .send(text: message, attachments: ids))
            Haptics.tap()
        } catch {
            if text.isEmpty && attachments.isEmpty {
                text = draft.text
                attachments = draft.attachments
            }
            model.show(error)
        }
    }
}

private struct AttachmentChip: View {
    @Environment(\.palette) private var palette
    let item: ComposerView.Attachment
    let number: Int
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let preview = item.preview {
                    Image(uiImage: preview).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: item.kind == .image ? "photo" : "doc").foregroundStyle(palette.muted)
                }
            }
            .frame(width: 34, height: 34)
            .background(palette.inset)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))

            VStack(alignment: .leading, spacing: 1) {
                Text(item.kind.token(number)).font(TrexFont.mono(11, weight: .semibold)).foregroundStyle(palette.accentText)
                Group {
                    if let error = item.error {
                        Text(error).foregroundStyle(palette.danger)
                    } else if item.uploading {
                        Text("subiendo…").foregroundStyle(palette.dim)
                    } else {
                        Text(RemoteFormat.size(item.size)).foregroundStyle(palette.dim)
                    }
                }
                .font(.caption2)
                .lineLimit(1)
            }
            .frame(maxWidth: 110, alignment: .leading)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(palette.dim)
            }
            .accessibilityLabel("Quitar \(item.name)")
        }
        .padding(6)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(item.error != nil ? palette.danger.opacity(0.5) : palette.border))
    }
}
