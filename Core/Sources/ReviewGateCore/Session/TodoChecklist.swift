import Foundation

// MARK: §71.2 — docs/PROTOCOL.md §71.2: ⌃T (and `/todos`) shows or hides Claude's to-do checklist over the message box, as
// Ctrl+T in Claude Code; it follows the turn live. The wire (`state.session.todos`), which items show, the words and the
// choice kept with the app. App `ComposerTodos.swift` draws it.

/// §71.2 one item of `state.session.todos`.
public struct TodoItem: Sendable, Equatable, Hashable, Decodable {
    public enum Status: String, Sendable, Equatable, Hashable { case pending, inProgress = "in_progress", completed }

    public var text: String
    public var status: Status
    /// The words the terminal shows while the item runs; nil when Claude gave none.
    public var activeForm: String?

    public init(text: String, status: Status, activeForm: String? = nil) {
        self.text = text
        self.status = status
        self.activeForm = activeForm
    }

    private enum CodingKeys: String, CodingKey { case text, status, activeForm }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let text = lenientValue(String.self, c, .text), !text.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .text, in: c, debugDescription: "to-do without text")
        }
        self.text = text
        status = lenientValue(String.self, c, .status).flatMap(Status.init(rawValue:)) ?? .pending
        activeForm = lenientValue(String.self, c, .activeForm).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// What the row says: the running words while it runs, else its text.
    public var shownText: String { status == .inProgress ? activeForm ?? text : text }
}

/// `state.session.todos` (lenient, element by element; nil when absent — an engine without §71.2).
enum TodoWire {
    private enum SessionKeys: String, CodingKey { case todos }

    static func session(from decoder: Decoder) -> [TodoItem]? {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self), c.contains(.todos),
              (try? c.decodeNil(forKey: .todos)) != true else { return nil }
        return lenientElements(TodoItem.self, c, .todos)
    }
}

/// §71.2: which items the checklist shows — at most five at a time, as the terminal, around the first one not done.
public struct TodoWindow: Equatable, Sendable {
    public var items: [TodoItem]
    /// Items left out before / after the shown ones.
    public var before: Int
    public var after: Int

    public static let limit = 5

    /// Starts one item before the first open one (so the last finished step shows), within the list.
    public init(_ all: [TodoItem], limit: Int = TodoWindow.limit) {
        guard all.count > limit else {
            items = all
            before = 0
            after = 0
            return
        }
        let firstOpen = all.firstIndex { $0.status != .completed } ?? all.count
        let start = max(0, min(firstOpen - 1, all.count - limit))
        items = Array(all[start..<(start + limit)])
        before = start
        after = all.count - start - limit
    }
}

/// §71.2: the checklist's words.
public enum TodoText {
    public static var title: String { String(localized: "To-dos", bundle: .module) }

    /// "2 of 5 done".
    public static func progress(_ items: [TodoItem]) -> String {
        String(localized: "\(items.filter { $0.status == .completed }.count) of \(items.count) done", bundle: .module)
    }

    public static func moreBefore(_ n: Int) -> String { String(localized: "\(n) done above", bundle: .module) }
    public static func moreAfter(_ n: Int) -> String { String(localized: "+\(n) more", bundle: .module) }

    /// The palette's line for `/todos`.
    public static var description: String { String(localized: "Show Claude's to-do checklist for this chat (⌃T)", bundle: .module) }

    public static var hideHelp: String { String(localized: "Hide the checklist (⌃T or /todos shows it again)", bundle: .module) }
    public static var panelHelp: String {
        String(localized: "Claude's to-do checklist for this chat — it follows the work live, as Ctrl+T in Claude Code", bundle: .module)
    }
    public static var none: String {
        String(localized: "Claude has no to-do list in this chat yet — it makes one for work in several steps (on models with the to-do tools)", bundle: .module)
    }
    public static var shown: String { String(localized: "To-do checklist shown — ⌃T hides it", bundle: .module) }
    public static var hidden: String { String(localized: "To-do checklist hidden — ⌃T shows it", bundle: .module) }
    public static var olderEngine: String { String(localized: "This engine has no to-do checklist — update ReviewGate", bundle: .module) }

    public static func statusLabel(_ s: TodoItem.Status) -> String {
        switch s {
        case .pending: String(localized: "Pending", bundle: .module)
        case .inProgress: String(localized: "In progress", bundle: .module)
        case .completed: String(localized: "Done", bundle: .module)
        }
    }
}

public extension AppSettings {
    /// §71.2: the checklist over the message box is shown (⌃T / `/todos`); on until the user hides it, as the terminal
    /// restores the view it was left in.
    static let todoListShownKey = "todoListShown"
    static func todoListShown(defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: todoListShownKey) as? Bool ?? true }
    static func setTodoListShown(_ on: Bool, defaults: UserDefaults = .standard) { defaults.set(on, forKey: todoListShownKey) }
}

public extension AppState {
    /// §71.2: Claude's checklist in the current chat; nil from an engine without it.
    var todos: [TodoItem]? { sessionInfo.todos }

    /// Why ⌃T / `/todos` show nothing now; nil: they can.
    var todoBlocker: String? {
        guard todos != nil else { return TodoText.olderEngine }
        if isTerminalChat { return String(localized: "A terminal chat has its own Ctrl+T", bundle: .module) }
        if viewingChat != nil { return String(localized: "Go back to the running chat to see Claude's checklist", bundle: .module) }
        return nil
    }
}
