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

    public init(id: UUID = UUID(), text: String) {
        self.id = id
        self.text = text
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
    public func debugShowDefaultModeOffer(_ mode: PermissionMode) { defaultModeOffer = mode }
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
