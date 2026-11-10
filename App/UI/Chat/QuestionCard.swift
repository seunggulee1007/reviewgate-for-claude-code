import SwiftUI
import ReviewGateCore

/// M14: shown instead of `PermissionCard` when Claude calls `AskUserQuestion`. Each question is a radio group
/// (checkboxes when `multiSelect`) plus an "Other…" free-text row; Answer replies `allow` with
/// `updatedInput.answers` (see `AppState.answerQuestions`), Skip denies. Once decided the card is read-only and
/// lists the chosen answers. §33.1: the card answers its own request; once that request left the queue without an
/// answer from here it reads "처리됨". polish-01: ⌘↩ (answer) and Esc (skip) act only while the card itself holds the
/// keyboard focus — never from the composer, the side-question field or the find bar.
/// MARK: r1-composer M08 — the card the message box answers (`AppState.openQuestion`) sits above the composer
/// (`answeredFromComposer`): the question a typed answer or 1…N goes to is marked and its options numbered.
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
    /// r1-composer M08: the message box answers this card (it sits above the composer).
    var answeredFromComposer = false

    private var isPending: Bool { decision == nil && isOpen }
    /// ↩ sends the message (Settings › General); off: ⌘↩ does.
    @AppStorage(AppSettings.Key.returnSends) private var returnSends = true
    @FocusState private var cardFocused: Bool
    /// The "Other…" field being typed in (its key = the question); the card's keys stay out of it.
    @FocusState private var otherFocused: String?

    /// Per question (keyed by text): selected option labels, whether "Other…" is chosen and its text — kept in the chat
    /// column (`TranscriptViewState.questionDrafts`), so a look at another chat tab does not lose them.
    @Binding var draft: QuestionDraft
    /// The option whose `preview` is shown (last hovered/selected), per question.
    @State private var previewed: [String: String] = [:]
    /// polish P4-composer-26: the option ↑ / ↓ move to on the focused card (question index, option index); space picks it.
    @State private var highlighted: (question: Int, option: Int)?
    /// r2-chats-cards M08b: the questions whose note field is open (a note already written keeps it open).
    @State private var notesOpen: Set<String> = []
    @FocusState private var noteFocused: String?

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
        // r1-composer M08: above the composer the card is a little tighter (the transcript keeps more of the column).
        VStack(alignment: .leading, spacing: answeredFromComposer ? 8 : 12) {
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
            .help(isPending ? String(localized: "Click here to answer from the keyboard: ↑ ↓ choose · space pick · 1–9 an option · ⌘↩ answer · esc skip") : "")
            ForEach(Array(questions.questions.enumerated()), id: \.element.id) { index, question in
                if isPending {
                    questionEditor(index + 1, question)
                        .id(Self.questionAnchor(index))
                } else {
                    questionSummary(question)
                }
            }
            if isPending {
                HStack {
                    if cardFocused {
                        Text("⌘↩ answers · esc skips").font(.caption).foregroundStyle(.secondary)
                    } else if answeredFromComposer {
                        // r1-composer M08: what the message box does for this card.
                        Text(verbatim: composerHint)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            .accessibilityIdentifier("Question card hint")
                    }
                    Spacer()
                    Button("Skip") { answer(onSkip) }
                        .help("Tell Claude you skipped the questions (esc while this card is focused)")
                        .accessibilityLabel("Skip questions")
                        .accessibilityIdentifier("Skip questions")
                    Button("Answer") { answer { onAnswer(answers) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isComplete)
                        // polish P4-composer-26: why it waits, while it does.
                        .help(isComplete ? String(localized: "Send your answers (⌘↩ while this card is focused)")
                                         : String(localized: "Answer every question first — \(unanswered) left"))
                        .accessibilityLabel("Answer questions")
                        .accessibilityIdentifier("Answer questions")
                }
            }
        }
        .padding(answeredFromComposer ? 10 : 12)
        .background(Color.accentColor.wash(colorScheme, light: isPending ? 0.10 : 0.04, dark: isPending ? 0.20 : 0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.wash(colorScheme, light: isPending ? (cardFocused ? 0.95 : 0.50) : 0.15,
                                                                                         dark: isPending ? (cardFocused ? 0.95 : 0.60) : 0.25),
                                                             lineWidth: isPending && cardFocused ? 2.5 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(isPending ? "Question card" : (decision == nil ? "Question card handled" : "Question card answered"))
        // polish P4-composer-07: closing the window would lose what was picked or typed here.
        .registersUnsavedWork("question-\(requestId)") {
            isPending && draft != QuestionDraft() ? String(localized: "Answers to Claude's question are not sent yet.") : nil
        }
    }

    /// How many questions still have no answer.
    private var unanswered: Int { questions.questions.filter { draft.answer(for: $0) == nil }.count }

    /// An answer by click; when the card held the keyboard (its title was clicked), it goes back to the composer.
    private func answer(_ action: () -> Void) {
        let hadFocus = cardFocused
        action()
        if hadFocus { onFocusComposer() }
    }

    /// ⌘↩ answers (when every question has an answer), Esc skips — only with the focus on the card, not in "Other…" or a
    /// note. polish P4-composer-26: ↑ / ↓ move between the options, space picks the one marked, 1–9 an option of the
    /// question the message box answers.
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        guard isPending, otherFocused == nil, noteFocused == nil else { return .ignored }
        if press.modifiers.isEmpty {
            switch press.key {
            case .downArrow: moveHighlight(1); return .handled
            case .upArrow: moveHighlight(-1); return .handled
            case .space:
                guard let h = highlighted else { moveHighlight(1); return .handled }
                toggle(question: h.question, option: h.option)
                return .handled
            default: break
            }
        }
        guard let key = CardShortcutKey(press) else { return .ignored }
        switch CardShortcuts.action(for: key, focus: .questionCard(requestId: requestId), target: nil) {
        case .answerQuestions:
            guard isComplete else { return .handled }
            onAnswer(answers)
        case .skipQuestions:
            onSkip()
        case let .pickQuestionOption(_, number):
            if let index = currentIndex, questions.questions[index].options.indices.contains(number - 1) {
                toggle(question: index, option: number - 1)
            }
            return .handled
        default:
            return .ignored
        }
        onFocusComposer()
        return .handled
    }

    /// Every option of every question in order, for ↑ / ↓.
    private var optionSlots: [(question: Int, option: Int)] {
        questions.questions.enumerated().flatMap { q, question in question.options.indices.map { (q, $0) } }
    }

    private func moveHighlight(_ by: Int) {
        let slots = optionSlots
        guard !slots.isEmpty else { return }
        let at = highlighted.flatMap { h in slots.firstIndex { $0.question == h.question && $0.option == h.option } }
        let next = at.map { min(max($0 + by, 0), slots.count - 1) } ?? (by > 0 ? 0 : slots.count - 1)
        highlighted = slots[next]
    }

    /// Picks (one answer) or turns on / off (several) option `option` of question `question`, as a click does.
    private func toggle(question q: Int, option o: Int) {
        let question = questions.questions[q]
        let option = question.options[o]
        let key = question.question
        if question.multiSelect {
            if selected[key, default: []].contains(option.label) { selected[key, default: []].remove(option.label) } else { selected[key, default: []].insert(option.label) }
        } else {
            selected[key] = [option.label]
            otherChosen.remove(key)
        }
        previewed[key] = option.label
        highlighted = (q, o)
    }

    // MARK: Editing

    private func questionEditor(_ number: Int, _ question: AskUserQuestions.Question) -> some View {
        let key = question.question
        let answersHere = answeredFromComposer && currentIndex == number - 1
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                chip(question.header)
                if question.multiSelect {
                    Text("Select all that apply").font(.caption).foregroundStyle(.secondary)
                }
                if answersHere, questions.questions.count > 1 {
                    // r1-composer M08: the question a typed answer or 1…N goes to.
                    Label("Answered from the message box", systemImage: "arrow.down")
                        .font(.caption).foregroundStyle(Color.accentColor)
                        .accessibilityIdentifier("Question \(number) answered from the message box")
                }
            }
            Text(question.question).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(question.options.enumerated()), id: \.element.id) { index, option in
                optionRow(number: number, question: question, option: option, key: answersHere ? index + 1 : nil)
            }
            otherRow(number: number, question: question)
            noteRow(number: number, question: question)   // r2-chats-cards M08b
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

    /// `key`: the number that picks this option from the message box (r1-composer M08), shown in front of it.
    private func optionRow(number: Int, question: AskUserQuestions.Question, option: AskUserQuestions.Option, key digit: Int? = nil) -> some View {
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
                if let digit {
                    Text(verbatim: String(digit))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 16)
                        .background(RoundedRectangle(cornerRadius: 4).strokeBorder(.quaternary))
                        .padding(.top, 1)
                        .help(String(localized: "Press \(digit) in the message box to pick this"))   // polish P4-composer-26
                        .accessibilityHidden(true)
                }
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
            .padding(.vertical, 1).padding(.horizontal, 3)
            .background(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.accentColor.opacity(isHighlighted(question, option) ? 0.8 : 0), lineWidth: 1.5))
            .hoverHighlight(cornerRadius: 5)   // polish P4-composer-26
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
            HStack(spacing: 8) {
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
                    .padding(.vertical, 1).padding(.horizontal, 3)
                    .hoverHighlight(cornerRadius: 5)
                }
                .buttonStyle(.plain)
                .help(String(localized: "Type an answer that is not in the list"))   // polish P4-composer-26
                .accessibilityLabel("Other")
                .accessibilityAddTraits(isOn ? .isSelected : [])
                .accessibilityIdentifier("Question \(number) other")
                // r2-chats-cards M08b: "메모 추가" ends this row until a note is open — no row of its own, so the card stays
                // whole above the composer in a 1000 × 637 window (the layout tour's check).
                if !noteShown(key) { addNoteButton(number: number, key: key) }
            }
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

    /// r2-chats-cards M08b: the note field is open (asked for, or it holds a note).
    private func noteShown(_ key: String) -> Bool {
        notesOpen.contains(key) || !(draft.notes[key] ?? "").isEmpty
    }

    /// r2-chats-cards M08b: a note on the answer for Claude (`updatedInput.annotations[question].notes`, as the CLI's own
    /// question prompt takes one) — behind "메모 추가" (at the end of the "기타…" row) until there is one.
    @ViewBuilder
    private func noteRow(number: Int, question: AskUserQuestions.Question) -> some View {
        let key = question.question
        if noteShown(key) {
            TextField("A note with your answer (optional)", text: Binding(get: { draft.notes[key] ?? "" }, set: { draft.notes[key] = $0.isEmpty ? nil : $0 }),
                      axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.roundedBorder)
                .focused($noteFocused, equals: key)
                .help(String(localized: "Claude reads this note together with your answer"))
                .accessibilityLabel(Text("Note with the answer"))
                .accessibilityIdentifier("Question \(number) note")
        }
    }

    /// r2-chats-cards M08b: opens the note field of the question `key`.
    private func addNoteButton(number: Int, key: String) -> some View {
        Button {
            notesOpen.insert(key)
            noteFocused = key
        } label: {
            Label("Add a note", systemImage: "note.text.badge.plus").font(.caption)
        }
        .buttonStyle(.borderless)
        .fixedSize()
        .help(String(localized: "Add a note Claude reads together with your answer"))
        .accessibilityIdentifier("Question \(number) add note")
    }

    private func isHighlighted(_ question: AskUserQuestions.Question, _ option: AskUserQuestions.Option) -> Bool {
        guard cardFocused, let h = highlighted, questions.questions.indices.contains(h.question) else { return false }
        let q = questions.questions[h.question]
        return q.question == question.question && q.options.indices.contains(h.option) && q.options[h.option].label == option.label
    }

    private func glyph(multi: Bool, on: Bool) -> String {
        multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle")
    }

    /// One answer per question, in option order then the free text (`QuestionDraft`, the rules the message box fills by).
    private var answers: [String: String] { draft.answers(questions) }

    private var isComplete: Bool { draft.isComplete(questions) }

    /// r1-composer M08: the question a typed answer or 1…N goes to.
    private var currentIndex: Int? { draft.current(in: questions) }

    /// How many options the current question has (the hint's 1–N).
    private var optionCount: Int { currentIndex.map { questions.questions[$0].options.count } ?? 0 }

    /// r1-composer M08: what the message box does for this card, after the send key in use — ⌥↩ too: in a narrow chat the
    /// row under the box has no room left for its hint.
    private var composerHint: String {
        switch (optionCount > 0, returnSends) {
        case (true, true): String(localized: "Pick 1–\(optionCount) or type below · ↩ answers · ⌥↩ sends separately")
        case (true, false): String(localized: "Pick 1–\(optionCount) or type below · ⌘↩ answers · ⌥↩ sends separately")
        case (false, true): String(localized: "Type below · ↩ answers · ⌥↩ sends separately")
        case (false, false): String(localized: "Type below · ⌘↩ answers · ⌥↩ sends separately")
        }
    }

    /// The scroll id of question `index` (the slot above the composer scrolls to the one the message box answers).
    static func questionAnchor(_ index: Int) -> String { "question-\(index)" }

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
