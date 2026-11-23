import SwiftUI
import TrexRemoteCore

/// Markdown de los agentes: bloques del núcleo y formato en línea de iOS (`AttributedString`).
struct MarkdownView: View {
    @Environment(\.palette) private var palette
    let text: String
    private let blocks: [MarkdownBlock]

    init(_ text: String) {
        self.text = text
        self.blocks = MarkdownParser.blocks(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(.system(size: level == 1 ? 21 : level == 2 ? 18 : 16, weight: .semibold))
                .foregroundStyle(palette.text)
                .padding(.top, 4)
        case .paragraph(let text):
            Text(inline(text)).font(.body).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Group {
                            if let checked = item.checked {
                                Image(systemName: checked ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(checked ? palette.ok : palette.dim)
                            } else if ordered {
                                Text("\(item.number ?? index + 1).").font(TrexFont.mono(14)).foregroundStyle(palette.muted)
                            } else {
                                Text(item.level == 0 ? "•" : "◦").foregroundStyle(palette.accentText)
                            }
                        }
                        .frame(minWidth: 16, alignment: .trailing)
                        Text(inline(item.text)).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.level) * 16)
                }
            }
        case .code(let language, let code):
            VStack(alignment: .leading, spacing: 0) {
                if let language {
                    Text(language).font(TrexFont.mono(10.5)).foregroundStyle(palette.dim)
                        .padding(.horizontal, 12).padding(.top, 8)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(TrexFont.mono(13))
                        .foregroundStyle(palette.text)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(12)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.sidebar, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(palette.border))
        case .quote(let text):
            HStack(spacing: 10) {
                Rectangle().fill(palette.accent.opacity(0.6)).frame(width: 3)
                Text(inline(text)).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            Text(inline(cell)).font(.subheadline.weight(.semibold)).foregroundStyle(palette.text)
                        }
                    }
                    Divider().gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inline(cell)).font(.subheadline).foregroundStyle(palette.text)
                            }
                        }
                    }
                }
                .padding(12)
            }
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .rule:
            Rectangle().fill(palette.border).frame(height: 1).padding(.vertical, 4)
        }
    }

    /// Negrita, cursiva, `código` y enlaces; si el texto no es Markdown válido, tal cual.
    private func inline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        guard var attributed = try? AttributedString(markdown: text, options: options) else { return AttributedString(text) }
        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                attributed[run.range].font = TrexFont.mono(14)
                attributed[run.range].foregroundColor = palette.accentText
                attributed[run.range].backgroundColor = palette.inset
            }
            if run.link != nil {
                attributed[run.range].foregroundColor = palette.accentText
                attributed[run.range].underlineStyle = Text.LineStyle.single
            }
        }
        return attributed
    }
}
