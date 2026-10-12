import Foundation
import Testing
@testable import ReviewGateCore

/// wave4d w4d-windows — audit polish-08: Help › Keyboard Shortcuts shows the table of docs/SHORTCUTS.md, and the Windows
/// client (clients/desktop/src/renderer/shortcutTable.ts, its own test) holds its copy to the same document — so the
/// two apps cannot drift apart key by key.
@Suite struct ShortcutTableTests {
    /// The doc's tables: per `## ` section with a table, its rows' [Mac, Windows] cells, in order.
    private func docKeys() throws -> [[[String]]] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("docs/SHORTCUTS.md"), encoding: .utf8)
        var sections: [[[String]]] = []
        var inSection = false
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("## ") {
                sections.append([])
                inSection = true
            } else if inSection, line.hasPrefix("|") {
                let cells = line.split(separator: "|", omittingEmptySubsequences: false).dropFirst().dropLast()
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                guard cells.count >= 3, cells[1] != "Mac", !cells[0].allSatisfy({ $0 == "-" }) else { continue }
                sections[sections.count - 1].append([cells[1], cells[2]])
            }
        }
        return sections.filter { !$0.isEmpty }
    }

    @Test func theTableIsTheDocument() throws {
        let fromTable = ShortcutTable.sections.map { $0.rows.map { [$0.mac, $0.windows] } }
        #expect(try docKeys() == fromTable)
    }

    @Test func optionCommandReturnIsTheStrongerCommandReturn() {
        let rows = ShortcutTable.sections.flatMap(\.rows)
        #expect(rows.filter { $0.mac == "⌥⌘↩" }.map(\.action) == ["Stop and send", "Allow for session", "Add the conclusion as a review note"])
        for section in ShortcutTable.sections { #expect(Set(section.rows.map(\.mac)).count == section.rows.count) }
        for row in rows { #expect(row.windows.rangeOfCharacter(from: CharacterSet(charactersIn: "⌘⌥⇧⌃⌫")) == nil) }
    }
}
