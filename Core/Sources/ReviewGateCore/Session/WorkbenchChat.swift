import Foundation

// docs/PROTOCOL.md §9 "New Chat in a Workbench" (워크벤치에서 새 채팅). One folder is one review gate, so turns go one at a
// time per worktree and a new chat asked for while Claude works waits (§9 "Held switches"). The way out that does not wait
// is a workbench (docs/M10-WORKBENCHES.md): a worktree of its own with its own branch, window and Claude. This makes one
// from HEAD in one step — a branch name ready to accept, `workbench_create`, its window — and a message held for the
// switch moves into that window's composer (never sent). Client-only: no engine command. Electron: renderer/workbenchChat.ts.

/// The branch "New Chat in a Workbench" suggests.
public enum WorkbenchChatBranch {
    public static let prefix = "wb/"

    /// `wb/<yyMMdd-HHmm>` in local time; `-2`, `-3`… after it when a branch of that name exists already.
    public static func suggest(now: Date = Date(), calendar: Calendar = .current, existing: [String]) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        let base = prefix + String(format: "%02d%02d%02d-%02d%02d", (c.year ?? 0) % 100, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
        let taken = Set(existing)
        guard taken.contains(base) else { return base }
        var n = 2
        while taken.contains("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }
}

/// A held message on its way to a new workbench's window: kept for that folder until the window that opens it takes it
/// (once). Process-wide — every window's `AppState` lives in this app. At most `maxWaiting` wait, each for `lifetime`.
@MainActor
public final class WorkbenchComposerHandoff {
    public static let shared = WorkbenchComposerHandoff()
    /// As a task's handoff (§49): a window that never opened that folder must not get the text much later.
    public static let lifetime: TimeInterval = 15 * 60
    static let maxWaiting = 20

    private var waiting: [(key: String, text: TaskComposerText, at: Date)] = []

    public init() {}

    public func remember(_ text: TaskComposerText, for folder: URL, now: Date = Date()) {
        let key = AppSettings.projectKey(folder)
        waiting.removeAll { $0.key == key || !Self.fresh($0.at, now: now) }
        waiting.append((key, text, now))
        if waiting.count > Self.maxWaiting { waiting.removeFirst(waiting.count - Self.maxWaiting) }
    }

    /// A message waits for `folder` (its window's first chat must then be a chat: a terminal chat has no composer).
    public func waits(for folder: URL, now: Date = Date()) -> Bool {
        let key = AppSettings.projectKey(folder)
        return waiting.contains { $0.key == key && Self.fresh($0.at, now: now) }
    }

    /// The message waiting for `folder`, forgotten here; nil when none (or it waited too long).
    public func take(for folder: URL, now: Date = Date()) -> TaskComposerText? {
        let key = AppSettings.projectKey(folder)
        guard let index = waiting.firstIndex(where: { $0.key == key }) else { return nil }
        let entry = waiting.remove(at: index)
        return Self.fresh(entry.at, now: now) ? entry.text : nil
    }

    private static func fresh(_ at: Date, now: Date) -> Bool {
        abs(now.timeIntervalSince(at)) <= lifetime
    }
}

extension AppState {
    /// Why "New Chat in a Workbench" cannot run here (nil: it can): no project, or a folder tracked without git (§59).
    public var workbenchChatBlocker: String? {
        guard projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        if isShadowProject {
            return String(localized: "Workbenches need a git repository — this folder is tracked without git", bundle: .module)
        }
        return nil
    }

    /// The branch the sheet starts with: `wb/<yyMMdd-HHmm>`, unused by any branch or workbench here.
    public func suggestedWorkbenchChatBranch(now: Date = Date(), calendar: Calendar = .current) -> String {
        WorkbenchChatBranch.suggest(now: now, calendar: calendar,
                                    existing: branches.map(\.name) + workbenches.list.compactMap(\.branch))
    }

    /// What the held switch would hand to the workbench: the messages held with it, as one composer text (nil: none).
    public var heldMessagesForWorkbench: TaskComposerText? {
        guard case let .openChat(_, messages)? = pendingChatSwitch else { return nil }
        return Self.composerText(of: messages)
    }

    /// The workbench at `folder` was made instead of waiting: the held switch is called off here, and the messages held
    /// with it wait for that workbench's window, which puts them into its composer (`takeWorkbenchHandoff`). Returns
    /// whether a message was handed over.
    @discardableResult
    public func handHeldSwitchToWorkbench(_ folder: URL, handoff: WorkbenchComposerHandoff = .shared, now: Date = Date()) -> Bool {
        guard let pending = pendingChatSwitch else { return false }
        pendingChatSwitch = nil
        guard case let .openChat(_, messages) = pending, let text = Self.composerText(of: messages) else { return false }
        handoff.remember(text, for: folder, now: now)
        return true
    }

    /// Once `url` is open here: a message handed to this workbench goes into the composer (taken once). Returns whether one
    /// came.
    @discardableResult
    func takeWorkbenchHandoff(for url: URL, handoff: WorkbenchComposerHandoff = .shared, now: Date = Date()) -> Bool {
        guard let text = handoff.take(for: url, now: now) else { return false }
        taskForComposer = text
        return true
    }
}
