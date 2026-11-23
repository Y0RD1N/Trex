import SwiftUI
import TrexRemoteCore

/// D/E · Hojas inferiores: permiso, plan o preguntas del agente. Lo que se responda
/// primero (aquí o en el PC) manda.
struct PendingSheet: View {
    @Environment(\.palette) private var palette
    let sessionID: String
    let agent: String
    let pending: RemotePending

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch pending {
                case .permission(let request):
                    PermissionContent(sessionID: sessionID, agent: agent, request: request)
                case .plan(let item, let plan):
                    PlanContent(sessionID: sessionID, agent: agent, item: item, plan: plan)
                case .question(let item, let title, let questions):
                    QuestionContent(sessionID: sessionID, agent: agent, item: item, title: title, questions: questions)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

/// Responde y avisa de errores; la hoja se cierra sola cuando el PC deja de publicar la petición.
@MainActor
private func answer(_ model: AppModel, _ session: String, item: String, allowed: Bool, remember: Bool = false, choices: [RemoteChoice]? = nil) async {
    do {
        try await model.command(session, .answer(item: item, allowed: allowed, remember: remember, choices: choices))
        Haptics.success()
    } catch {
        model.show(error)
    }
}

private struct PermissionContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let sessionID: String
    let agent: String
    let request: PermissionRequest

    var body: some View {
        SectionRule(title: "\(agent) pide permiso")

        VStack(alignment: .leading, spacing: 12) {
            (Text("Quiere ") + Text(request.what).bold() + Text(" en tu PC"))
                .foregroundStyle(palette.text)
            if let command = request.command {
                VStack(alignment: .leading, spacing: 6) {
                    (Text("$ ").foregroundStyle(palette.accentText) + Text(command).foregroundStyle(palette.text))
                        .font(TrexFont.mono(13.5))
                        .textSelection(.enabled)
                    if !request.cwd.isEmpty {
                        Text(request.cwd).font(TrexFont.mono(11)).foregroundStyle(palette.dim)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.sidebar, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else if let detail = request.detail, !detail.isEmpty {
                Text(detail)
                    .font(TrexFont.mono(13))
                    .foregroundStyle(palette.text)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.sidebar, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if request.added > 0 || request.removed > 0 {
                DiffStat(added: request.added, removed: request.removed)
            }
            if !request.description.isEmpty {
                Text(request.description).font(.subheadline).foregroundStyle(palette.muted)
            }
        }
        .padding(14)
        .background(palette.warn.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.warn.opacity(0.4)))

        HStack(spacing: 10) {
            AsyncButton(kind: .normal, tall: true) {
                await answer(model, sessionID, item: request.item, allowed: false)
            } label: { Text("Rechazar") }
            AsyncButton(kind: .warn, tall: true) {
                await answer(model, sessionID, item: request.item, allowed: true)
            } label: { Text("Permitir una vez") }
        }
        if let remember = request.remember {
            AsyncButton(kind: .ghost, tall: true) {
                await answer(model, sessionID, item: request.item, allowed: true, remember: true)
            } label: { Text(remember) }
        }
    }
}

private struct PlanContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let sessionID: String
    let agent: String
    let item: String
    let plan: String

    var body: some View {
        SectionRule(title: "\(agent) terminó el plan")
        MarkdownView(plan.isEmpty ? "Sin detalles." : plan)
            .padding(14)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        HStack(spacing: 10) {
            AsyncButton(kind: .normal, tall: true) {
                await answer(model, sessionID, item: item, allowed: false)
            } label: { Text("Seguir planificando") }
            AsyncButton(kind: .primary, tall: true) {
                await answer(model, sessionID, item: item, allowed: true)
            } label: { Text("Aprobar plan") }
        }
    }
}

private struct QuestionContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let sessionID: String
    let agent: String
    let item: String
    let title: String
    let questions: [RemoteQuestion]

    @State private var step = 0
    @State private var choices: [RemoteChoice] = []
    @State private var writing = false

    var body: some View {
        if let question = questions[safe: step] {
            let choice = currentChoice
            SectionRule(title: title.isEmpty ? "\(agent) pregunta" : title, count: nil)
            HStack {
                Text(question.question).font(.system(size: 18, weight: .semibold)).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if questions.count > 1 {
                    Text("\(step + 1) de \(questions.count)").font(TrexFont.mono(11.5)).foregroundStyle(palette.dim)
                }
            }

            VStack(spacing: 8) {
                ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                    let selected = choice.selected.contains(option.label)
                    Button {
                        pick(option.label, multi: question.multiSelect)
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Text("\(index + 1)").font(TrexFont.mono(12, weight: .semibold)).foregroundStyle(selected ? palette.accentText : palette.dim)
                            VStack(alignment: .leading, spacing: 3) {
                                (Text(option.title).bold() + Text(option.recommended ? "  · recomendada" : "").font(.caption).foregroundStyle(palette.accentText))
                                    .foregroundStyle(palette.text)
                                if !option.description.isEmpty {
                                    Text(option.description).font(.subheadline).foregroundStyle(palette.muted)
                                }
                            }
                            .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            if question.multiSelect {
                                Image(systemName: selected ? "checkmark.square.fill" : "square").foregroundStyle(selected ? palette.accent : palette.dim)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(selected ? palette.accent.opacity(0.12) : palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? palette.accent : palette.border))
                    }
                    .buttonStyle(.plain)
                }

                if question.other {
                    if writing || question.options.isEmpty {
                        TextField("Tu respuesta…", text: otherBinding(multi: question.multiSelect), axis: .vertical)
                            .lineLimit(2...6)
                            .padding(12)
                            .foregroundStyle(palette.text)
                            .background(palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border))
                    } else {
                        Button {
                            writing = true
                        } label: {
                            Label("Otra respuesta…", systemImage: "pencil")
                                .foregroundStyle(palette.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.border, style: StrokeStyle(lineWidth: 1, dash: [4])))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            HStack(spacing: 10) {
                AsyncButton(kind: .ghost, tall: true) {
                    await answer(model, sessionID, item: item, allowed: false, choices: allChoices)
                } label: { Text("Omitir") }
                .frame(maxWidth: 120)
                AsyncButton(kind: .primary, tall: true) {
                    if step < questions.count - 1 {
                        step += 1
                        writing = false
                    } else {
                        await answer(model, sessionID, item: item, allowed: true, choices: allChoices)
                    }
                } label: { Text(step < questions.count - 1 ? "Siguiente" : "Responder") }
                .disabled(!choice.isAnswered)
            }
        }
    }

    private var allChoices: [RemoteChoice] {
        questions.indices.map { index in choices[safe: index] ?? RemoteChoice(question: questions[index].question) }
    }

    private var currentChoice: RemoteChoice {
        choices[safe: step] ?? RemoteChoice(question: questions[safe: step]?.question ?? "")
    }

    private func setCurrent(_ choice: RemoteChoice) {
        var list = allChoices
        list[step] = choice
        choices = list
    }

    private func pick(_ label: String, multi: Bool) {
        var choice = currentChoice
        if multi {
            if let index = choice.selected.firstIndex(of: label) { choice.selected.remove(at: index) } else { choice.selected.append(label) }
        } else {
            choice.selected = [label]
            choice.other = ""
            writing = false
        }
        setCurrent(choice)
        Haptics.tap()
    }

    private func otherBinding(multi: Bool) -> Binding<String> {
        Binding {
            currentChoice.other
        } set: { value in
            var choice = currentChoice
            choice.other = value
            if !multi { choice.selected = [] }
            setCurrent(choice)
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
