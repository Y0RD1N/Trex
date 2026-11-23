import Foundation

/// Bloques de Markdown que pinta la app (lo que suelen escribir los agentes).
///
/// Se separa en bloques aquí; el formato dentro de cada línea (negrita, `código`, enlaces)
/// lo resuelve la interfaz con `AttributedString(markdown:)`. Así no hace falta ninguna
/// dependencia externa y lo que no se reconoce se muestra como texto normal.
public enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(ordered: Bool, items: [ListItem])
    case code(language: String?, code: String)
    case quote(String)
    case table(header: [String], rows: [[String]])
    case rule

    public struct ListItem: Hashable, Sendable {
        public var level: Int
        /// Número de la lista ordenada, o nil.
        public var number: Int?
        /// `[ ]` / `[x]` de las listas de tareas, o nil.
        public var checked: Bool?
        public var text: String
    }
}

public enum MarkdownParser {
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { blocks.append(.paragraph(text)) }
            paragraph = []
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Bloque de código con ``` o ~~~ (si no se cierra, llega hasta el final).
            if let fence = fenceMarker(trimmed) {
                flushParagraph()
                let language = trimmed.dropFirst(fence.count).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[index])
                    index += 1
                }
                index += 1
                blocks.append(.code(language: language.isEmpty ? nil : language, code: code.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                index += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quote: [String] = []
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    guard current.hasPrefix(">") else { break }
                    quote.append(String(current.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }

            if trimmed.hasPrefix("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                flushParagraph()
                let header = cells(trimmed)
                var rows: [[String]] = []
                index += 2
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    guard current.hasPrefix("|") else { break }
                    rows.append(cells(current))
                    index += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }

            if let first = listItem(line) {
                flushParagraph()
                let ordered = first.number != nil
                var items = [first]
                index += 1
                while index < lines.count {
                    let current = lines[index]
                    if let item = listItem(current), (item.number != nil) == ordered || item.level > 0 {
                        items.append(item)
                        index += 1
                    } else if !current.trimmingCharacters(in: .whitespaces).isEmpty, current.hasPrefix("  ") || current.hasPrefix("\t"),
                              var last = items.popLast() {
                        // Continuación de la línea anterior del elemento.
                        last.text += "\n" + current.trimmingCharacters(in: .whitespaces)
                        items.append(last)
                        index += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(ordered: ordered, items: items))
                continue
            }

            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    private static func fenceMarker(_ trimmed: String) -> String? {
        if trimmed.hasPrefix("```") { return "```" }
        if trimmed.hasPrefix("~~~") { return "~~~" }
        return nil
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#")).trimmingCharacters(in: .whitespaces)
        return .heading(level: hashes, text: text)
    }

    private static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.hasPrefix("|") || trimmed.hasPrefix(":") || trimmed.hasPrefix("-") else { return false }
        return trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ row: String) -> [String] {
        var value = row.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func listItem(_ line: String) -> MarkdownBlock.ListItem? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let body = line.drop { $0 == " " || $0 == "\t" }
        var text: Substring
        var number: Int?
        if let marker = body.first, "-*+".contains(marker), body.dropFirst().first == " " {
            text = body.dropFirst(2)
        } else {
            let digits = body.prefix { $0.isNumber }
            guard !digits.isEmpty, digits.count <= 9 else { return nil }
            let after = body.dropFirst(digits.count)
            guard let punctuation = after.first, punctuation == "." || punctuation == ")", after.dropFirst().first == " " else { return nil }
            number = Int(digits)
            text = after.dropFirst(2)
        }
        var checked: Bool?
        if text.hasPrefix("[ ] ") { checked = false; text = text.dropFirst(4) }
        else if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") { checked = true; text = text.dropFirst(4) }
        return .init(level: min(indent / 2, 4), number: number, checked: checked, text: String(text).trimmingCharacters(in: .whitespaces))
    }
}
