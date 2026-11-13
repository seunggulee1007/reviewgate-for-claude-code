import Foundation

// docs/PROTOCOL.md §49: "Run as Task" — a task starts in a workbench of its own (a new branch and folder, its own window and
// a fresh chat), so the chat it was typed in never sees it. The sheet creates the workbench with `workbench_create {task}`;
// the new window's engine sends the task as its first message (`task_started`).

/// `task_started` (§49): a task handed to this worktree was sent in a fresh chat, or (`sent` false) comes back for the
/// composer because the session could not take a message.
public struct TaskStartedInfo: Decodable, Sendable, Equatable {
    public var text: String
    public var mode: PermissionMode
    public var from: String
    public var sent: Bool

    public init(text: String, mode: PermissionMode, from: String, sent: Bool) {
        self.text = text
        self.mode = mode
        self.from = from
        self.sent = sent
    }

    private enum CodingKeys: String, CodingKey { case text, mode, from, sent }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        mode = (try? c.decode(PermissionMode.self, forKey: .mode)) ?? .default
        from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
        sent = try c.decodeIfPresent(Bool.self, forKey: .sent) ?? false
    }
}

/// A task's text for the composer (`AppState.taskForComposer`): taken once — `id` tells two equal texts apart.
public struct TaskComposerText: Sendable, Equatable {
    public let id: UUID
    public let text: String
    /// r2-chats-cards M31 / M33 (§9): a held message handed back brings its chips with it (a task's text has none).
    public let mentions: [String]
    public let images: [ComposerImage]
    /// §56.2: messages given back go in front of what is typed (a task's text and the rest join after it).
    public let atFront: Bool

    public init(id: UUID = UUID(), text: String, mentions: [String] = [], images: [ComposerImage] = [], atFront: Bool = false) {
        self.id = id
        self.text = text
        self.mentions = mentions
        self.images = images
        self.atFront = atFront
    }
}

extension AppState {
    /// §49: the fresh chat runs in the task's mode (remembered for this workbench, as a mode picked here would be); a task
    /// the session could not take goes into the composer.
    func applyTaskStarted(_ info: TaskStartedInfo) {
        rememberPermissionMode(info.mode)
        appendLog("[info] task from \(info.from): \(info.sent ? "sent in a fresh chat" : "waiting in the composer") (\(info.mode.rawValue))")
        if !info.sent, !info.text.isEmpty { taskForComposer = TaskComposerText(text: info.text) }
    }

    #if DEBUG
    /// The screenshot tour's layout check (App/Debug/ScreenshotTour.swift): the mode offer card as a first open shows it.
    public func debugShowDefaultModeOffer(_ mode: PermissionMode?) { defaultModeOffer = mode }

    /// The composer check (§50.2): messages put into the running turn that Claude has not read yet.
    public func debugShowSteering(_ messages: [SteeringMessage]) {
        var snapshot = state
        snapshot.session.steering = messages
        state = snapshot
    }

    /// The composer check: the slash palette's commands as a session with plugins, skills and MCP prompts lists them.
    public func debugShowCommands(_ commands: [SlashCommandInfo]) {
        var snapshot = state
        var caps = snapshot.session.capabilities ?? .empty
        caps.commands = commands
        caps.state = .ready
        snapshot.session.capabilities = caps
        state = snapshot
    }

    /// The layout check (r1-composer): a review with `files` pending, or (`working`) a turn that runs beside it — the gate
    /// closed as the engine closes it then, so the composer shows Stop and 바로 보내기. The engine's next snapshot puts its
    /// own back.
    public func debugShowComposerState(working: Bool, files: [ChangedFile]) {
        var snapshot = state
        snapshot.gate.phase = working ? .running : .reviewing
        snapshot.gate.canSend = !working
        snapshot.gate.blockedReason = working ? .running : nil
        snapshot.gate.pendingCount = files.count
        snapshot.changedFiles = files
        state = snapshot
    }
    #endif

    /// The chat took `taskForComposer` (it is never put there twice).
    public func takeTaskForComposer(_ id: UUID) {
        if taskForComposer?.id == id { taskForComposer = nil }
    }
}

// MARK: §50 Send now — a message into the turn that runs

extension AppState {
    /// §50: a turn of ours runs, so a message can go into it now (as typing while Claude works does in the terminal).
    /// The engine has the last word: a refusal (the turn ended meanwhile, its review is being collected) queues it.
    public var canSteer: Bool { isRunning && !isExternalTurn && viewingChat == nil }

    /// §50 "바로 보내기": the message goes into the running turn — Claude reads it once the current tool call is done; its
    /// changes join this turn's review. Refused, it waits in the queue instead (never lost).
    public func steer(_ text: String, mentions: [String] = []) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        recordPrompt(trimmed)
        do {
            try await request(.steer(text: trimmed, mentions: mentions))
        } catch {
            appendLog("[info] steer refused (\(error.localizedDescription)) — queued instead")
            enqueue(trimmed, mentions: mentions)
        }
    }
}

// MARK: r1-composer M08 — Claude's question answered from the message box

/// What is picked and typed for a question card, per question (keyed by its text): the options chosen, whether "Other…"
/// is, and its text. The chat column keeps it; the card above the composer and the composer itself (a typed answer, the
/// number keys) fill the same one.
public struct QuestionDraft: Sendable, Equatable {
    public var selected: [String: Set<String>]
    public var otherChosen: Set<String>
    public var otherText: [String: String]
    /// r2-chats-cards M08b: the user's notes per question (keyed by its text) — `updatedInput.annotations[q].notes`.
    public var notes: [String: String]

    public init(selected: [String: Set<String>] = [:], otherChosen: Set<String> = [], otherText: [String: String] = [:], notes: [String: String] = [:]) {
        self.selected = selected
        self.otherChosen = otherChosen
        self.otherText = otherText
        self.notes = notes
    }

    /// The answer to `question`: its chosen options in their order, then the "Other…" text; nil while it has none (an
    /// "Other…" chosen without text has none).
    public func answer(for question: AskUserQuestions.Question) -> String? {
        let key = question.question
        let labels = question.options.map(\.label).filter { selected[key, default: []].contains($0) }
        let other = otherChosen.contains(key) ? otherText[key]?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if otherChosen.contains(key), (other ?? "").isEmpty { return nil }
        guard !labels.isEmpty || other != nil else { return nil }
        return AskUserQuestions.answerText(selectedLabels: labels, other: other)
    }

    /// One answer per answered question, keyed by its text (the `updatedInput.answers` of the reply).
    public func answers(_ questions: AskUserQuestions) -> [String: String] {
        var out: [String: String] = [:]
        for question in questions.questions { if let answer = answer(for: question) { out[question.question] = answer } }
        return out
    }

    public func isComplete(_ questions: AskUserQuestions) -> Bool {
        questions.questions.allSatisfy { answer(for: $0) != nil }
    }

    /// The question the message box answers: the first one without an answer, else the last one.
    public func current(in questions: AskUserQuestions) -> Int? {
        guard !questions.questions.isEmpty else { return nil }
        return questions.questions.firstIndex { answer(for: $0) == nil } ?? questions.questions.count - 1
    }

    /// `text` answers the current question: the option whose label it is (letter case aside) is chosen, any other text
    /// becomes its "Other…" answer next to what was picked ("Option A, with tests"). Returns that question's index; nil
    /// for an empty text.
    @discardableResult
    public mutating func fill(_ text: String, in questions: AskUserQuestions) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = current(in: questions) else { return nil }
        let question = questions.questions[index]
        let key = question.question
        if let option = question.options.first(where: { $0.label.compare(trimmed, options: [.caseInsensitive]) == .orderedSame }) {
            if question.multiSelect {
                selected[key, default: []].insert(option.label)
            } else {
                selected[key] = [option.label]
                otherChosen.remove(key)
            }
        } else {
            otherChosen.insert(key)
            otherText[key] = trimmed
        }
        return index
    }

    /// Option `number` (1 = the first) of the current question: chosen (one answer), or turned on / off (several).
    /// False when the current question has no such option.
    @discardableResult
    public mutating func pick(_ number: Int, in questions: AskUserQuestions) -> Bool {
        guard let index = current(in: questions) else { return false }
        let question = questions.questions[index]
        guard question.options.indices.contains(number - 1) else { return false }
        let label = question.options[number - 1].label
        let key = question.question
        if question.multiSelect {
            if selected[key, default: []].contains(label) { selected[key, default: []].remove(label) } else { selected[key, default: []].insert(label) }
        } else {
            selected[key] = [label]
            otherChosen.remove(key)
        }
        return true
    }
}

/// The question the message box answers (`AppState.openQuestion`).
public struct OpenQuestion: Sendable, Equatable {
    public let request: PermissionRequest
    public let questions: AskUserQuestions

    public var requestId: String { request.requestId }
}

extension AppState {
    /// M08: the oldest open `AskUserQuestion` while no other card is open (the composer's ⌘↩ / ⌘⌫ answer that one first)
    /// and the running chat is shown. The card sits above the composer; ↩ answers it instead of putting the text into the
    /// turn — a steered message would only wait behind the open question.
    public var openQuestion: OpenQuestion? {
        guard viewingChat == nil, shortcutPermission == nil else { return nil }
        for request in openPermissions where request.toolName == AskUserQuestions.toolName {
            if let questions = AskUserQuestions(request: request) { return OpenQuestion(request: request, questions: questions) }
        }
        return nil
    }

    /// M08: `text` answers the open question's current question (`QuestionDraft.fill`); the card goes out once every
    /// question has an answer (`answerQuestions`). False when nothing went out: no open question, an empty text, or
    /// questions left — `draft` then holds the answer and the card shows it.
    @discardableResult
    public func answerOpenQuestion(_ text: String, draft: inout QuestionDraft) -> Bool {
        guard let open = openQuestion, draft.fill(text, in: open.questions) != nil else { return false }
        return submitOpenQuestion(draft)
    }

    /// `answerOpenQuestion(_:draft:)` on a card nothing was picked on yet.
    @discardableResult
    public func answerOpenQuestion(_ text: String) -> Bool {
        var draft = QuestionDraft()
        return answerOpenQuestion(text, draft: &draft)
    }

    /// M08: ↩ with an empty message box — the open question's card as `draft` has it, sent when every question has an
    /// answer. False otherwise.
    @discardableResult
    public func submitOpenQuestion(_ draft: QuestionDraft) -> Bool {
        guard let open = openQuestion, draft.isComplete(open.questions) else { return false }
        answerQuestions(requestId: open.requestId, draft: draft)   // r2-chats-cards M08b: with the question's notes
        return true
    }

    /// M08: 1…N with an empty message box — option `number` of the open question's current question (nothing is sent:
    /// ↩ sends the card).
    @discardableResult
    public func pickOpenQuestionOption(_ number: Int, draft: inout QuestionDraft) -> Bool {
        guard let open = openQuestion else { return false }
        return draft.pick(number, in: open.questions)
    }
}

// MARK: r1-composer M14 — the slash palette while Claude works

extension AppState {
    /// M14: the composer's `/` palette (and ⌘/) works whenever a project is open — while Claude works or the session starts
    /// too (the cached list, or "Starting session…"), as in the terminal. A pick only goes into the draft; ↩ then sends,
    /// steers (§50) or queues it like any message.
    public var canUseSlashPalette: Bool { projectInfo != nil }
}

/// §49: the branch "Run as Task" suggests for a task — `<prefix><id>` from a task link or key in the text (the last number
/// of a URL's path, `#project/123`, `ABC-123`, `#123`), else up to five ASCII words of its first line, else the date and time.
/// The prefix is the one the user used last (Settings remember it), `task/` at first.
public enum TaskBranchName {
    public static let defaultPrefix = "task/"

    public static func suggest(text: String, prefix: String = defaultPrefix, now: Date = Date(), calendar: Calendar = .current) -> String {
        let p = cleanPrefix(prefix)
        if let id = taskID(in: text) { return p + id }
        let words = firstLineWords(text)
        if !words.isEmpty { return p + words.joined(separator: "-") }
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        return p + String(format: "%04d%02d%02d-%02d%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    /// The part of `branch` before its last `/` (with the slash), "" without one: what the next suggestion starts with.
    public static func prefix(of branch: String) -> String {
        let trimmed = branch.trimmingCharacters(in: .whitespaces)
        guard let slash = trimmed.lastIndex(of: "/") else { return "" }
        return cleanPrefix(String(trimmed[...slash]))
    }

    /// A prefix that keeps the branch name valid: path parts of `[A-Za-z0-9._-]` ending in `/`, "" otherwise.
    static func cleanPrefix(_ raw: String) -> String {
        let parts = raw.split(separator: "/").map { part in
            String(part.filter { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) })
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }.filter { !$0.isEmpty && !$0.hasSuffix(".lock") }
        return parts.isEmpty ? "" : parts.joined(separator: "/") + "/"
    }

    /// The task's id in `text`: a URL's last numeric path part, `#project/123` → `project-123`, `ABC-123`, `#123` → `123`.
    static func taskID(in text: String) -> String? {
        if let url = firstURL(in: text) {
            let numbers = url.pathComponents.filter { !$0.isEmpty && $0.allSatisfy(\.isASCIINumber) }
            if let last = numbers.last { return last }
        }
        if let m = text.firstMatch(of: /#([A-Za-z][A-Za-z0-9_-]*)\/(\d+)/) { return "\(m.1)-\(m.2)" }
        if let m = text.firstMatch(of: /\b([A-Z][A-Z0-9]+-\d+)\b/) { return String(m.1) }
        if let m = text.firstMatch(of: /(?:^|\s)#(\d+)\b/) { return String(m.1) }
        return nil
    }

    private static func firstURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: range).lazy.compactMap(\.url).first { $0.scheme == "http" || $0.scheme == "https" }
    }

    /// Lower-cased ASCII words of the first non-empty line (URLs skipped), at most five and 40 characters.
    static func firstLineWords(_ text: String) -> [String] {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        var words: [String] = []
        var length = 0
        for token in line.split(whereSeparator: \.isWhitespace) where !token.contains("://") {
            let word = String(token.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
            guard !word.isEmpty else { continue }
            if words.count == 5 || length + word.count > 40 { break }
            words.append(word)
            length += word.count + 1
        }
        return words
    }
}

/// §49.2: how the chat column shares what the header, the HUD and the composer leave (`room`) between the transcript and
/// the cards above the composer: the cards at their own height while the transcript keeps `minTranscript`, never less than
/// `cardShare` of the room (then they scroll), the transcript the rest.
public enum ChatColumnSplit {
    public static let minTranscript: Double = 80
    public static let cardShare: Double = 0.6

    public static func split(room: Double, cards: Double) -> (transcript: Double, cards: Double) {
        let room = max(0, room)
        let shown = max(0, min(cards, max(room - minTranscript, room * cardShare)))
        return (room - shown, shown)
    }
}

private extension Character {
    var isASCIINumber: Bool { isASCII && isNumber }
}
