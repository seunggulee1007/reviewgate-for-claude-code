import Foundation

// MARK: wave4d w4d-windows — audit polish-08: the keyboard shortcuts of both apps, one table. docs/SHORTCUTS.md is its text;
// the Windows client has the same rows (clients/desktop/src/renderer/shortcutTable.ts). `ShortcutTableTests` and the
// client's `shortcutTable.test.ts` hold both to the document. Help › Keyboard Shortcuts shows it (App `ShortcutsView`).
// `title`, `note` and `action` are English keys of App/Localizable.xcstrings (the view localizes them).

public struct ShortcutRow: Sendable, Equatable, Identifiable {
    public let action: String
    public let mac: String
    public let windows: String
    public let note: String?
    public var id: String { action + mac }

    public init(_ action: String, mac: String, windows: String, note: String? = nil) {
        self.action = action
        self.mac = mac
        self.windows = windows
        self.note = note
    }
}

public struct ShortcutSection: Sendable, Equatable, Identifiable {
    public let title: String
    public let note: String?
    public let rows: [ShortcutRow]
    public var id: String { title }

    public init(_ title: String, note: String? = nil, rows: [ShortcutRow]) {
        self.title = title
        self.note = note
        self.rows = rows
    }
}

public enum ShortcutTable {
    public static let sections: [ShortcutSection] = [
        ShortcutSection("Project and window", rows: [
            ShortcutRow("Open Project…", mac: "⌘O", windows: "Ctrl+O"),
            ShortcutRow("Switch Project…", mac: "⌘⇧O", windows: "Ctrl+Shift+O"),
            ShortcutRow("Open in New Window…", mac: "⌘⇧N", windows: "Ctrl+Shift+N"),
            ShortcutRow("New Window", mac: "⌘N", windows: "Ctrl+N"),   // MARK: polish p-lifecycle (P1-chrome-06)
            ShortcutRow("Settings…", mac: "⌘,", windows: "Ctrl+,"),
        ]),
        // §69.4 / §74.4: the window with no project open — its four cards (both apps).
        ShortcutSection("Window with no project", note: "When a window has no project open", rows: [
            ShortcutRow("New Project · Start from a task · Open a folder… · Clone from Git", mac: "1 / 2 / 3 / 4", windows: "1 / 2 / 3 / 4", note: "Each key opens it at once"),
            ShortcutRow("Move between the cards, then take the marked one", mac: "← → ↑ ↓ ↩", windows: "← → ↑ ↓ Enter"),
        ]),
        // MARK: task-start (§63.4): the start screen of a project window (both apps).
        ShortcutSection("Start screen", note: "When a project window opens", rows: [
            ShortcutRow("Start now · Start from a task · Open a chat", mac: "1 / 2 / 3", windows: "1 / 2 / 3"),
            ShortcutRow("Move through the choices and the recent chats, then open the marked one", mac: "↑ ↓ ↩", windows: "↑ ↓ Enter"),
            ShortcutRow("Start now", mac: "Esc", windows: "Esc"),
        ]),
        ShortcutSection("View", rows: [
            ShortcutRow("Refresh", mac: "⌘R", windows: "Ctrl+R"),
            ShortcutRow("Toggle Sidebar", mac: "⌃⌘S", windows: "Ctrl+B"),
            ShortcutRow("Toggle Diff Pane", mac: "⌘⇧D", windows: "Ctrl+Shift+D",
                        note: "In a terminal chat: the review panel beside the terminal"),   // MARK: terminal-chat (§57.5)
            ShortcutRow("Split Diff", mac: "⌥⌘L", windows: "Ctrl+Alt+L", note: "A diff pane too narrow for two columns stays unified"),   // §34.11
            ShortcutRow("Toggle Agent Panel", mac: "⌥⌘A", windows: "Ctrl+Alt+A"),
            ShortcutRow("Toggle Side Questions", mac: "⌥⌘S", windows: "Ctrl+Alt+S"),
            ShortcutRow("Agent Board", mac: "⌥⌘B", windows: "Ctrl+Alt+B"),   // MARK: wave5 w5-board (§43.1)
            ShortcutRow("Changes Tab", mac: "⌥⌘1", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("History Tab", mac: "⌥⌘2", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("PRs Tab", mac: "⌥⌘3", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Search Tab", mac: "⌥⌘4", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Jump to Latest", mac: "⌥⌘↓", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Zoom In", mac: "⌘+", windows: "Ctrl+="),   // r2-review-flow (polish)
            ShortcutRow("Zoom Out", mac: "⌘-", windows: "Ctrl+-"),   // r2-review-flow (polish)
            ShortcutRow("Actual Size", mac: "⌘0", windows: "Ctrl+0"),   // r2-review-flow (polish)
            ShortcutRow("Toggle Terminal Panel", mac: "⌃`", windows: "Ctrl+`"),   // MARK: terminal-chat (§57.6) · terminal-win (§57.17)
        ]),
        ShortcutSection("Find", rows: [
            ShortcutRow("Find in Chat…", mac: "⌘F", windows: "Ctrl+F"),
            ShortcutRow("Find in Diff…", mac: "⌥⌘F", windows: "Ctrl+Alt+F"),
            ShortcutRow("Find Next", mac: "⌘G", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Find Previous", mac: "⌘⇧G", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            // MARK: polish p-lifecycle (P1-chrome-10): the keys the menus had and the table did not
            ShortcutRow("Go to File…", mac: "⌘P", windows: "Ctrl+P"),
            ShortcutRow("Find in Project…", mac: "⌘⇧F", windows: "Ctrl+Shift+F"),
        ]),
        // MARK: code-nav (§62)
        ShortcutSection("Code navigation", rows: [
            ShortcutRow("Go to Definition", mac: "F12", windows: "F12", note: "Or ⌘-click a name (Ctrl+click on Windows) — on the Mac when Settings › Review › Diff › ⌘-click on a name is Go to Definition"),
            // MARK: ide-nav (§65.8)
            ShortcutRow("Peek Definition", mac: "⌥F12", windows: "Alt+F12", note: "The definition in a band under the line — the place you read stays. Mac: ⌘-click a name too (the default)"),
            ShortcutRow("Find References", mac: "⇧F12", windows: "Shift+F12", note: "The results fill the bottom panel's References tab"),
            ShortcutRow("Next Reference", mac: "F4", windows: "F4", note: "Opens it in the diff or the file view — one Back returns to where you were reading"),   // ide-nav (§65.8)
            ShortcutRow("Previous Reference", mac: "⇧F4", windows: "Shift+F4"),
            ShortcutRow("Symbols in This File", mac: "⌘F12", windows: "Ctrl+F12", note: "Symbols in this file, filtered as you type — the outline indented"),   // ide-nav (§65.8)
            ShortcutRow("Symbols in Project", mac: "⌥⌘⇧N", windows: "Ctrl+Alt+Shift+N", note: "Finds a class, method or field by name or its camel humps (UsrSvc → UserService)"),
            ShortcutRow("Back", mac: "⌃-", windows: "Alt+←"),
            ShortcutRow("Forward", mac: "⌃⇧-", windows: "Alt+→"),
            ShortcutRow("Open in IDE", mac: "⌥⌘O", windows: "Ctrl+Alt+O"),
        ]),
        ShortcutSection("Review", rows: [
            ShortcutRow("Accept", mac: "⌘⇧A", windows: "Ctrl+Shift+A"),
            ShortcutRow("Accept All…", mac: "⌥⌘⇧A", windows: "Ctrl+Alt+Shift+A", note: "Asks first only when a file was not looked at or is sensitive"),   // r2-review-flow M28
            ShortcutRow("Reject", mac: "⌘⇧R", windows: "Ctrl+Shift+R", note: "Asks first"),
            ShortcutRow("Undo Accept", mac: "⌘⇧U", windows: "—", note: "Mac app only"),   // MARK: polish p-lifecycle (P1-chrome-10)
            ShortcutRow("Next Pending File", mac: "⌘]", windows: "Ctrl+]"),
            ShortcutRow("Previous Pending File", mac: "⌘[", windows: "Ctrl+["),
            ShortcutRow("Next Change", mac: "⌥⌘]", windows: "—", note: "Mac app only · after a file’s last change, the next file"),   // r2-review-flow (polish)
            ShortcutRow("Previous Change", mac: "⌥⌘[", windows: "—", note: "Mac app only · before a file’s first change, the previous file"),   // r2-review-flow (polish)
            ShortcutRow("Add a review note on the selected line", mac: "⌥⌘N", windows: "Ctrl+Alt+N"),
            ShortcutRow("Ask About Selection…", mac: "⌥⌘/", windows: "Ctrl+Alt+/"),
            ShortcutRow("Open in Editor", mac: "⌘⇧E", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Copy Path", mac: "⌥⌘C", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Request Changes", mac: "⌘⇧C", windows: "Ctrl+Shift+C"),
            ShortcutRow("Commit Accepted…", mac: "⌘⇧K", windows: "Ctrl+Shift+K"),
            ShortcutRow("Create PR from this branch…", mac: "⌥⌘K", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
        ]),
        ShortcutSection("Chat", rows: [
            ShortcutRow("New chat", mac: "⌘T", windows: "Ctrl+T"),
            ShortcutRow("New Terminal Chat", mac: "⌃⌘T", windows: "Ctrl+Alt+T"),   // MARK: terminal-chat (§57.5) · terminal-win (§57.17)
            ShortcutRow("New Chat (Classic)", mac: "⌃⌥⌘T", windows: "Ctrl+Alt+Shift+T"),   // MARK: terminal-default (§57.7) · terminal-win (§57.17)
            ShortcutRow("New Chat in a Workbench…", mac: "⌥⌘T", windows: "Ctrl+Alt+W", note: "Windows uses W: Ctrl+Alt+T is New Terminal Chat"),   // §9 New Chat in a Workbench
            ShortcutRow("Close Chat Tab", mac: "⌘⇧W", windows: "Ctrl+Shift+W"),
            ShortcutRow("Chat tabs 1–9", mac: "⌘1…⌘9", windows: "Ctrl+1…Ctrl+9"),
            // MARK: r2-chats-cards — polish PX-19 / P4-composer-05
            ShortcutRow("Reopen Closed Chat Tab", mac: "⌘⇧T", windows: "Ctrl+Shift+T"),
            ShortcutRow("Show Next Chat Tab", mac: "⌃⇥", windows: "Ctrl+Tab", note: "On Windows Ctrl+PgDn too"),
            ShortcutRow("Show Previous Chat Tab", mac: "⌃⇧⇥", windows: "Ctrl+Shift+Tab", note: "On Windows Ctrl+PgUp too"),
            ShortcutRow("Chat History…", mac: "⌘Y", windows: "Ctrl+H"),
            ShortcutRow("Send — while Claude works, add to the queue", mac: "⌘↩", windows: "Ctrl+Enter"),
            ShortcutRow("Stop and send", mac: "⌥⌘↩", windows: "Ctrl+Alt+Enter", note: "While Claude works, with a message typed"),
            ShortcutRow("Accept the pending files and send", mac: "⌘⇧↩", windows: "Ctrl+Shift+Enter"),
            ShortcutRow("Stop", mac: "⌘.", windows: "Ctrl+."),
            // MARK: wave6 w6-terminal — §44.1: the terminal's keys in the message box
            ShortcutRow("Stop", mac: "Esc", windows: "Esc", note: "In the message box, while Claude works — messages Claude has not read come back into the box"),   // §56.2
            ShortcutRow("Commands", mac: "⌘/", windows: "Ctrl+/"),
            ShortcutRow("Previous / next prompt", mac: "↑ / ↓", windows: "↑ / ↓", note: "On the first / last line of the message box"),
            ShortcutRow("Switch the permission mode", mac: "⇧⇥", windows: "Shift+Tab", note: "In the message box: default → accept edits → plan → auto"),
            ShortcutRow("Run the command in the background", mac: "⌃B", windows: "Ctrl+B", note: "In an empty message box, while a command runs"),   // §52
            ShortcutRow("Edit the message in an external editor", mac: "⌃G", windows: "Ctrl+G", note: "In the message box — each save comes back into it"),   // §56.3
            ShortcutRow("Search the prompt history", mac: "⌃R", windows: "Ctrl+R", note: "In the message box — press it again for an older match"),   // §70.1
            ShortcutRow("Turn extended thinking on or off", mac: "⌥T", windows: "Alt+T", note: "In the message box, for this chat — no effect on a model that always thinks"),   // §70.4
            ShortcutRow("Show or hide Claude's to-do checklist", mac: "⌃T", windows: "Ctrl+Shift+L", note: "In the message box — /todos shows it too. On Windows Ctrl+T is New Chat"),   // §71.2
        ]),
        ShortcutSection("Permission and plan cards", note: "From an empty message box, or with the card focused — never while you type", rows: [
            ShortcutRow("Allow once", mac: "⌘↩", windows: "Ctrl+Enter"),
            ShortcutRow("Allow for session", mac: "⌥⌘↩", windows: "Ctrl+Alt+Enter"),
            ShortcutRow("Deny", mac: "⌘⌫", windows: "Ctrl+Backspace"),
            ShortcutRow("Keep planning", mac: "Esc", windows: "Esc", note: "Plan card"),
            // MARK: r2-chats-cards M24 (§33.10)
            ShortcutRow("Deny with the typed text as the instruction", mac: "↩", windows: "Ctrl+Enter",
                        note: "While a card waits, with a message typed — the send key"),
            ShortcutRow("Allow once · allow for session · deny with an instruction", mac: "1 / 2 / 3", windows: "1 / 2 / 3",
                        note: "With the card focused — a red card is never allowed by a digit"),
        ]),
        ShortcutSection("Side questions", note: "In a side thread's follow-up field", rows: [
            ShortcutRow("Send the conclusion to the main conversation", mac: "⌘↩", windows: "Ctrl+Enter"),
            ShortcutRow("Add the conclusion as a review note", mac: "⌥⌘↩", windows: "Ctrl+Alt+Enter"),
        ]),
    ]
}
