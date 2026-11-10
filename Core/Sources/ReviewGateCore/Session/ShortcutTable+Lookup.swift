import Foundation

// MARK: polish p-foundation — PX-11: the key of an action, read from the one table (docs/SHORTCUTS.md), so a tooltip or a
// menu never spells a key the table does not list. The Mac app builds "수락 (⌘⇧A)" from it (`String.withKey`,
// `.helpWithKey` in App/UI/Common/KeyHint.swift); the Windows client reads its own copy of the rows (`tKey` in
// clients/desktop/src/renderer/shortcutKeys.ts).

extension ShortcutTable {
    /// The Mac keys of `action` — a row's English `action` key ("Accept" → "⌘⇧A"); nil when no row has it. When two rows
    /// share an action ("Stop": ⌘. and Esc in the message box) the first one is the key named.
    public static func key(_ action: String) -> String? {
        lookup[action]?.mac
    }

    /// The Windows keys of `action` as the table writes them ("Accept" → "Ctrl+Shift+A"); nil when no row has it, or when
    /// the Windows app has no such key ("—", a row only the Mac app has).
    public static func windowsKey(_ action: String) -> String? {
        lookup[action].flatMap { $0.windows == "—" ? nil : $0.windows }
    }

    /// Each action's first row.
    private static let lookup: [String: ShortcutRow] = {
        var rows: [String: ShortcutRow] = [:]
        for row in sections.flatMap(\.rows) where rows[row.action] == nil {
            rows[row.action] = row
        }
        return rows
    }()
}
