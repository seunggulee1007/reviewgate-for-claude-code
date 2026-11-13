/**
 * MARK: wave4d w4d-windows — audit polish-08: the keyboard shortcuts of both apps, one table (docs/SHORTCUTS.md is its
 * text; the Mac's Core `ShortcutTable.swift` is the same rows — `shortcutTable.test.ts` and Core's `ShortcutTableTests`
 * hold all three to the same keys). Help › Keyboard Shortcuts shows it (components/dialogs/ShortcutsDialog.tsx).
 * `action` / `title` / `note` are the Mac's English keys (App/Localizable.xcstrings → ko.json).
 */
export type ShortcutRow = { action: string; mac: string; win: string; note?: string };
export type ShortcutSection = { title: string; note?: string; rows: ShortcutRow[] };

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Project and window",
    rows: [
      { action: "Open Project…", mac: "⌘O", win: "Ctrl+O" },
      { action: "Switch Project…", mac: "⌘⇧O", win: "Ctrl+Shift+O" },
      { action: "Open in New Window…", mac: "⌘⇧N", win: "Ctrl+Shift+N" },
      { action: "New Window", mac: "⌘N", win: "Ctrl+N" }, // MARK: polish p-lifecycle (P1-chrome-06)
      { action: "Settings…", mac: "⌘,", win: "Ctrl+," },
    ],
  },
  {
    title: "View",
    rows: [
      { action: "Refresh", mac: "⌘R", win: "Ctrl+R" },
      { action: "Toggle Sidebar", mac: "⌃⌘S", win: "Ctrl+B" },
      { action: "Toggle Diff Pane", mac: "⌘⇧D", win: "Ctrl+Shift+D" },
      { action: "Toggle Agent Panel", mac: "⌥⌘A", win: "Ctrl+Alt+A" },
      { action: "Toggle Side Questions", mac: "⌥⌘S", win: "Ctrl+Alt+S" },
      { action: "Agent Board", mac: "⌥⌘B", win: "Ctrl+Alt+B" }, // MARK: wave5 w5-board (§43.1)
      { action: "Changes Tab", mac: "⌥⌘1", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "History Tab", mac: "⌥⌘2", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "PRs Tab", mac: "⌥⌘3", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Search Tab", mac: "⌥⌘4", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Jump to Latest", mac: "⌥⌘↓", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Zoom In", mac: "⌘+", win: "Ctrl+=" }, // r2-review-flow (polish)
      { action: "Zoom Out", mac: "⌘-", win: "Ctrl+-" }, // r2-review-flow (polish)
      { action: "Actual Size", mac: "⌘0", win: "Ctrl+0" }, // r2-review-flow (polish)
    ],
  },
  {
    title: "Find",
    rows: [
      { action: "Find in Chat…", mac: "⌘F", win: "Ctrl+F" },
      { action: "Find in Diff…", mac: "⌥⌘F", win: "Ctrl+Alt+F" },
      { action: "Find Next", mac: "⌘G", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Find Previous", mac: "⌘⇧G", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      // MARK: polish p-lifecycle (P1-chrome-10): the keys the menus had and the table did not
      { action: "Go to File…", mac: "⌘P", win: "Ctrl+P" },
      { action: "Find in Project…", mac: "⌘⇧F", win: "Ctrl+Shift+F" },
    ],
  },
  {
    title: "Review",
    rows: [
      { action: "Accept", mac: "⌘⇧A", win: "Ctrl+Shift+A" },
      { action: "Accept All…", mac: "⌥⌘⇧A", win: "Ctrl+Alt+Shift+A", note: "Asks first only when a file was not looked at or is sensitive" }, // r2-review-flow M28
      { action: "Reject", mac: "⌘⇧R", win: "Ctrl+Shift+R", note: "Asks first" },
      { action: "Undo Accept", mac: "⌘⇧U", win: "—", note: "Mac app only" }, // MARK: polish p-lifecycle (P1-chrome-10)
      { action: "Next Pending File", mac: "⌘]", win: "Ctrl+]" },
      { action: "Previous Pending File", mac: "⌘[", win: "Ctrl+[" },
      { action: "Next Change", mac: "⌥⌘]", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Previous Change", mac: "⌥⌘[", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Add a review note on the selected line", mac: "⌥⌘N", win: "Ctrl+Alt+N" },
      { action: "Ask About Selection…", mac: "⌥⌘/", win: "Ctrl+Alt+/" },
      { action: "Open in Editor", mac: "⌘⇧E", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Copy Path", mac: "⌥⌘C", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
      { action: "Request Changes", mac: "⌘⇧C", win: "Ctrl+Shift+C" },
      { action: "Commit Accepted…", mac: "⌘⇧K", win: "Ctrl+Shift+K" },
      { action: "Create PR from this branch…", mac: "⌥⌘K", win: "—", note: "Mac app only" }, // r2-review-flow (polish)
    ],
  },
  {
    title: "Chat",
    rows: [
      { action: "New chat", mac: "⌘T", win: "Ctrl+T" },
      { action: "Close Chat Tab", mac: "⌘⇧W", win: "Ctrl+Shift+W" },
      { action: "Chat tabs 1–9", mac: "⌘1…⌘9", win: "Ctrl+1…Ctrl+9" },
      // MARK: r2-chats-cards — polish PX-19 / P4-composer-05
      { action: "Reopen Closed Chat Tab", mac: "⌘⇧T", win: "Ctrl+Shift+T" },
      { action: "Show Next Chat Tab", mac: "⌃⇥", win: "Ctrl+Tab", note: "On Windows Ctrl+PgDn too" },
      { action: "Show Previous Chat Tab", mac: "⌃⇧⇥", win: "Ctrl+Shift+Tab", note: "On Windows Ctrl+PgUp too" },
      { action: "Chat History…", mac: "⌘Y", win: "Ctrl+H" },
      { action: "Send — while Claude works, add to the queue", mac: "⌘↩", win: "Ctrl+Enter" },
      { action: "Stop and send", mac: "⌥⌘↩", win: "Ctrl+Alt+Enter", note: "While Claude works, with a message typed" },
      { action: "Accept the pending files and send", mac: "⌘⇧↩", win: "Ctrl+Shift+Enter" },
      { action: "Stop", mac: "⌘.", win: "Ctrl+." },
      // MARK: wave6 w6-terminal — §44.1: the terminal's keys in the message box
      { action: "Stop", mac: "Esc", win: "Esc", note: "In the message box, while Claude works — messages Claude has not read come back into the box" }, // §56.2
      { action: "Commands", mac: "⌘/", win: "Ctrl+/" },
      { action: "Previous / next prompt", mac: "↑ / ↓", win: "↑ / ↓", note: "On the first / last line of the message box" },
      { action: "Switch the permission mode", mac: "⇧⇥", win: "Shift+Tab", note: "In the message box: default → accept edits → plan → auto" },
      { action: "Run the command in the background", mac: "⌃B", win: "Ctrl+B", note: "In an empty message box, while a command runs" }, // §52
    ],
  },
  {
    title: "Permission and plan cards",
    note: "From an empty message box, or with the card focused — never while you type",
    rows: [
      { action: "Allow once", mac: "⌘↩", win: "Ctrl+Enter" },
      { action: "Allow for session", mac: "⌥⌘↩", win: "Ctrl+Alt+Enter" },
      { action: "Deny", mac: "⌘⌫", win: "Ctrl+Backspace" },
      { action: "Keep planning", mac: "Esc", win: "Esc", note: "Plan card" },
      // MARK: r2-chats-cards M24 (§33.10)
      { action: "Deny with the typed text as the instruction", mac: "↩", win: "Ctrl+Enter", note: "While a card waits, with a message typed — the send key" },
      { action: "Allow once · allow for session · deny with an instruction", mac: "1 / 2 / 3", win: "1 / 2 / 3", note: "With the card focused — a red card is never allowed by a digit" },
    ],
  },
  {
    title: "Side questions",
    note: "In a side thread's follow-up field",
    rows: [
      { action: "Send the conclusion to the main conversation", mac: "⌘↩", win: "Ctrl+Enter" },
      { action: "Add the conclusion as a review note", mac: "⌥⌘↩", win: "Ctrl+Alt+Enter" },
    ],
  },
];

/** The keys of a row on this platform. */
export const shortcutKeys = (row: ShortcutRow, platform: string): string => (platform === "darwin" ? row.mac : row.win);
