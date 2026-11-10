import Foundation
import Testing
@testable import ReviewGateCore

/// polish p-foundation — PX-11: tooltips and menus name a key only from the shortcut table (docs/SHORTCUTS.md).
@Suite struct ShortcutKeyLookupTests {
    @Test func anActionNamesItsRowsKeys() {
        #expect(ShortcutTable.key("Accept") == "⌘⇧A")
        #expect(ShortcutTable.windowsKey("Accept") == "Ctrl+Shift+A")
        #expect(ShortcutTable.key("Add a review note on the selected line") == "⌥⌘N")
        #expect(ShortcutTable.key("Switch the permission mode") == "⇧⇥")
        #expect(ShortcutTable.windowsKey("Switch the permission mode") == "Shift+Tab")
    }

    @Test func twoRowsOfOneActionNameTheFirst() {
        // "Stop": ⌘. (Chat) before Esc (in the message box).
        #expect(ShortcutTable.key("Stop") == "⌘.")
        #expect(ShortcutTable.windowsKey("Stop") == "Ctrl+.")
    }

    @Test func anActionTheTableDoesNotListHasNoKey() {
        #expect(ShortcutTable.key("Make coffee") == nil)
        #expect(ShortcutTable.windowsKey("") == nil)
    }

    @Test func everyRowCanBeLookedUp() {
        for row in ShortcutTable.sections.flatMap(\.rows) {
            #expect(ShortcutTable.key(row.action) != nil)
            // r2-review-flow (polish): a key only the Mac app has ("—" on Windows) names none there.
            #expect((ShortcutTable.windowsKey(row.action) == nil) == (row.windows == "—"))
        }
    }

    /// r2-review-flow (polish): the menu keys only the Mac app has are listed with "—" for Windows and say so.
    @Test func aMacOnlyKeyHasNoWindowsKey() {
        #expect(ShortcutTable.key("Copy Path") == "⌥⌘C")
        #expect(ShortcutTable.windowsKey("Copy Path") == nil)
        #expect(ShortcutTable.key("Zoom In") == "⌘+")
        #expect(ShortcutTable.windowsKey("Zoom In") == "Ctrl+=")
        for row in ShortcutTable.sections.flatMap(\.rows) where row.windows == "—" {
            #expect(row.note == "Mac app only")
        }
    }
}
