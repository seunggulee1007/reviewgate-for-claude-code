import SwiftUI
import ReviewGateCore

/// M14: shown instead of `PermissionCard` when Claude calls `AskUserQuestion`. Each question is a radio group
/// (checkboxes when `multiSelect`) plus an "Other…" free-text row; Answer replies `allow` with
/// `updatedInput.answers` (see `AppState.answerQuestions`), Skip denies. Once decided the card is read-only and
/// lists the chosen answers. §33.1: the card answers its own request; once that request left the queue without an
/// answer from here it reads "처리됨". polish-01: ⌘↩ (answer) and Esc (skip) act only while the card itself holds the
/// keyboard focus — never from the composer, the side-question field or the find bar.
struct QuestionCard: View {
    @Environment(\.colorScheme) private var colorScheme
    let questions: AskUserQuestions
    /// `nil` while pending; `true` answered (answers in `questions.answers`), `false` skipped.
    let decision: Bool?
    /// The request this card answers.
    var requestId = ""
    /// The request is still in the engine's queue.
    var isOpen = true
    var onAnswer: ([String: String]) -> Void = { _ in }
    var onSkip: () -> Void = {}
    /// Hands the keyboard back to the composer after an answer given while the card held it.
    var onFocusComposer: () -> Void = {}

    private var isPending: Bool { decision == nil && isOpen }
    @FocusState private var cardFocused: Bool
    /// The "Other…" field being typed in (its key = the question); the card's keys stay out of it.
    @FocusState private var otherFocused: String?

    /// Per question (keyed by text): selected option labels, whether "Other…" is chosen and its text — kept in the chat
    /// column (`TranscriptViewState.questionDrafts`), so a look at another chat tab does not lose them.
    @Binding var draft: QuestionCardDraft
    /// The option whose `preview` is shown (last hovered/selected), per question.
    @State private var previewed: [String: String] = [:]

    private var selected: [String: Set<String>] {
        get { draft.selected }
        nonmutating set { draft.selected = newValue }
    }
    private var otherChosen: Set<String> {
        get { draft.otherChosen }
        nonmutating set { draft.otherChosen = newValue }
    }
    private var otherText: [String: String] {
        get { draft.otherText }
        nonmutating set { draft.otherText = newValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(isPending ? Color.accentColor : Color.secondary)
                Text("Claude has a question").font(.headline)
                Spacer()
                if let decision {
                    Text(decision ? "Answered" : "Skipped")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(decision ? Color.green : Color.secondary)
                } else if !isOpen {
                    Text("Handled")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            // polish-01: the title row is the card's focus handle (no button in it): click it (or Tab to it) and ⌘↩ answers,
            // Esc skips — never from the composer, the side-question field or the find bar.
            .contentShape(Rectangle())
            .focusable(isPending, interactions: .edit)
            .focused($cardFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { handleKey($0) }
            .help(isPending ? String(localized: "Click here to answer from the keyboard: ⌘↩ answer · esc skip") : "")
            ForEach(Array(questions.questions.enumerated()), id: \.element.id) { index, question in
                if isPending {
                    questionEditor(index + 1, question)
                } else {
                    questionSummary(question)
                }
            }
            if isPending {
                HStack {
                    if cardFocused {
                        Text("⌘↩ answers · esc skips").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Skip") { answer(onSkip) }
                        .help("Tell Claude you skipped the questions (esc while this card is focused)")
                        .accessibilityLabel("Skip questions")
                        .accessibilityIdentifier("Skip questions")
                    Button("Answer") { answer { onAnswer(answers) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isComplete)
                        .help("Send your answers (⌘↩ while this card is focused)")
                        .accessibilityLabel("Answer questions")
                        .accessibilityIdentifier("Answer questions")
                }
            }
        }
        .padding(12)
        .background(Color.accentColor.wash(colorScheme, light: isPending ? 0.10 : 0.04, dark: isPending ? 0.20 : 0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.wash(colorScheme, light: isPending ? (cardFocused ? 0.95 : 0.50) : 0.15,
                                                                                         dark: isPending ? (cardFocused ? 0.95 : 0.60) : 0.25),
                                                             lineWidth: isPending && cardFocused ? 2.5 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(isPending ? "Question card" : (decision == nil ? "Question card handled" : "Question card answered"))
    }

    /// An answer by click; when the card held the keyboard (its title was clicked), it goes back to the composer.
    private func answer(_ action: () -> Void) {
        let hadFocus = cardFocused
        action()
        if hadFocus { onFocusComposer() }
    }

    /// ⌘↩ answers (when every question has an answer), Esc skips — only with the focus on the card, not in "Other…".
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        guard isPending, otherFocused == nil, let key = CardShortcutKey(press) else { return .ignored }
        switch CardShortcuts.action(for: key, focus: .questionCard(requestId: requestId), target: nil) {
        case .answerQuestions:
            guard isComplete else { return .handled }
            onAnswer(answers)
        case .skipQuestions:
            onSkip()
        default:
            return .ignored
        }
        onFocusComposer()
        return .handled
    }

    // MARK: Editing

    private func questionEditor(_ number: Int, _ question: AskUserQuestions.Question) -> some View {
        let key = question.question
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                chip(question.header)
                if question.multiSelect {
                    Text("Select all that apply").font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(question.question).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            ForEach(question.options) { option in
                optionRow(number: number, question: question, option: option)
            }
            otherRow(number: number, question: question)
            if let label = previewed[key], let preview = question.options.first(where: { $0.label == label })?.preview {
                ScrollView(.horizontal) {
                    Text(preview)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .frame(maxHeight: 200)
                .accessibilityIdentifier("Question \(number) preview")
            }
        }
    }

    private func optionRow(number: Int, question: AskUserQuestions.Question, option: AskUserQuestions.Option) -> some View {
        let key = question.question
        let isOn = selected[key, default: []].contains(option.label)
        return Button {
            if question.multiSelect {
                if isOn { selected[key, default: []].remove(option.label) } else { selected[key, default: []].insert(option.label) }
            } else {
                selected[key] = [option.label]
                otherChosen.remove(key)
            }
            previewed[key] = option.label
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: glyph(multi: question.multiSelect, on: isOn))
                    .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).fontWeight(.bold)
                    if !option.description.isEmpty {
                        Text(option.description).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in if inside, option.preview != nil { previewed[key] = option.label } }
        .accessibilityLabel(option.label)
        .accessibilityValue(isOn ? String(localized: "selected") : String(localized: "not selected"))
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityIdentifier("Question \(number) option \(option.label)")
    }

    private func otherRow(number: Int, question: AskUserQuestions.Question) -> some View {
        let key = question.question
        let isOn = otherChosen.contains(key)
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                if isOn {
                    otherChosen.remove(key)
                } else {
                    otherChosen.insert(key)
                    if !question.multiSelect { selected[key] = [] }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: glyph(multi: question.multiSelect, on: isOn))
                        .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                    Text("Other…").fontWeight(.bold)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Other")
            .accessibilityAddTraits(isOn ? .isSelected : [])
            .accessibilityIdentifier("Question \(number) other")
            if isOn {
                TextField("Type your answer", text: Binding(get: { otherText[key] ?? "" }, set: { otherText[key] = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .focused($otherFocused, equals: key)
                    .padding(.leading, 24)
                    .accessibilityLabel("Other answer")
                    .accessibilityIdentifier("Question \(number) other text")
            }
        }
    }

    private func glyph(multi: Bool, on: Bool) -> String {
        multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle")
    }

    /// One answer per question, in option order then the free text; nil while any question is unanswered.
    private func answer(for question: AskUserQuestions.Question) -> String? {
        let key = question.question
        let labels = question.options.map(\.label).filter { selected[key, default: []].contains($0) }
        let other = otherChosen.contains(key) ? otherText[key]?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if otherChosen.contains(key), (other ?? "").isEmpty { return nil }
        guard !labels.isEmpty || other != nil else { return nil }
        return AskUserQuestions.answerText(selectedLabels: labels, other: other)
    }

    private var answers: [String: String] {
        var out: [String: String] = [:]
        for q in questions.questions { if let a = answer(for: q) { out[q.question] = a } }
        return out
    }

    private var isComplete: Bool { answers.count == questions.questions.count }

    // MARK: Read-only

    private func questionSummary(_ question: AskUserQuestions.Question) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            chip(question.header)
            Text(question.question).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            if let answer = questions.answers[question.question] {
                Label { Text(answer).fontWeight(.semibold).textSelection(.enabled) } icon: {
                    Image(systemName: "arrow.turn.down.right").foregroundStyle(.secondary)
                }
                .font(.callout)
                .accessibilityIdentifier("Question answer")
            } else {
                Text("No answer").font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func chip(_ header: String) -> some View {
        Group {
            if !header.isEmpty {
                Text(header)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28), in: Capsule())
            }
        }
    }
}
