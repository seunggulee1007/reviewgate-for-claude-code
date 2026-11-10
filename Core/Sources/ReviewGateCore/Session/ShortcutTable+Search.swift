import Foundation

// MARK: polish p-lifecycle — P1-chrome-10: Help › Keyboard Shortcuts narrows the table as the user types (the Windows
// client's `filterShortcuts` in ShortcutsDialog.tsx is the same rule). docs/PROTOCOL.md §55.8.

extension ShortcutTable {
    /// The sections and rows `query` finds: every word, in any order and any case, against the action and remark — their
    /// English keys and `localize`d words — and the keys; a section's own title keeps the whole section. An empty query
    /// keeps everything.
    public static func filtered(_ query: String, sections: [ShortcutSection] = sections,
                                localize: (String) -> String = { $0 }) -> [ShortcutSection] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return sections }
        func hits(_ texts: [String?]) -> Bool {
            let hay = texts.compactMap { $0 }.flatMap { [$0, localize($0)] }.joined(separator: "\n").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
        return sections.compactMap { section in
            if hits([section.title]) { return section }
            let rows = section.rows.filter { hits([section.title, $0.action, $0.note, $0.mac, $0.windows]) }
            return rows.isEmpty ? nil : ShortcutSection(section.title, note: section.note, rows: rows)
        }
    }
}
