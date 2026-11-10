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
        ShortcutSection("View", rows: [
            ShortcutRow("Refresh", mac: "⌘R", windows: "Ctrl+R"),
            ShortcutRow("Toggle Sidebar", mac: "⌃⌘S", windows: "Ctrl+B"),
            ShortcutRow("Toggle Diff Pane", mac: "⌘⇧D", windows: "Ctrl+Shift+D"),
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
        ShortcutSection("Review", rows: [
            ShortcutRow("Accept", mac: "⌘⇧A", windows: "Ctrl+Shift+A"),
            ShortcutRow("Accept All…", mac: "⌥⌘⇧A", windows: "Ctrl+Alt+Shift+A", note: "Asks first only when a file was not looked at or is sensitive"),   // r2-review-flow M28
            ShortcutRow("Reject", mac: "⌘⇧R", windows: "Ctrl+Shift+R", note: "Asks first"),
            ShortcutRow("Undo Accept", mac: "⌘⇧U", windows: "—", note: "Mac app only"),   // MARK: polish p-lifecycle (P1-chrome-10)
            ShortcutRow("Next Pending File", mac: "⌘]", windows: "Ctrl+]"),
            ShortcutRow("Previous Pending File", mac: "⌘[", windows: "Ctrl+["),
            ShortcutRow("Next Change", mac: "⌥⌘]", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
            ShortcutRow("Previous Change", mac: "⌥⌘[", windows: "—", note: "Mac app only"),   // r2-review-flow (polish)
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
            ShortcutRow("Stop", mac: "Esc", windows: "Esc", note: "In the message box, while Claude works"),
            ShortcutRow("Commands", mac: "⌘/", windows: "Ctrl+/"),
            ShortcutRow("Previous / next prompt", mac: "↑ / ↓", windows: "↑ / ↓", note: "On the first / last line of the message box"),
            ShortcutRow("Switch the permission mode", mac: "⇧⇥", windows: "Shift+Tab", note: "In the message box: default → accept edits → plan → auto"),
            ShortcutRow("Run the command in the background", mac: "⌃B", windows: "Ctrl+B", note: "In an empty message box, while a command runs"),   // §52
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
