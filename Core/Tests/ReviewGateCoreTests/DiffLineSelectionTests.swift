import Foundation
import Testing
@testable import ReviewGateCore

/// Diff lines picked with the mouse (click, ⇧-click, drag) and copied as code.
@Suite struct DiffLineSelectionTests {
    private let order = ["L0", "L1", "L2", "C5", "L3", "L4"]

    @Test func aClickSelectsOneRowAndShiftClickExtendsFromTheAnchor() {
        var selection = DiffLineSelection()
        #expect(selection.isEmpty && selection.range(in: order) == nil)
        selection.select("L1", extend: false)
        #expect(selection.range(in: order) == 1...1)
        selection.select("L4", extend: true)
        #expect(selection.range(in: order) == 1...5)
        selection.select("L0", extend: true)   // back past the anchor
        #expect(selection.range(in: order) == 0...1)
        #expect(selection.keys(in: order) == ["L0", "L1"])
        selection.select("L3", extend: false)   // a plain click starts again
        #expect(selection.range(in: order) == 4...4)
    }

    @Test func shiftClickWithoutAnAnchorStartsOne() {
        var selection = DiffLineSelection()
        selection.select("L2", extend: true)
        #expect(selection.anchor == "L2" && selection.range(in: order) == 2...2)
    }

    @Test func everyClickBumpsTheRevision() {
        var selection = DiffLineSelection()
        selection.select("L1", extend: false)
        let first = selection.revision
        selection.select("L1", extend: false)   // the same row again: still a click on the lines
        #expect(selection.revision == first + 1)
        selection.clear()
        #expect(selection.isEmpty && selection.revision == first + 2)
        selection.clear()   // nothing left to clear
        #expect(selection.revision == first + 2)
    }

    @Test func rowsThatLeftTheListShrinkOrEndTheSelection() {
        var selection = DiffLineSelection()
        selection.select("L1", extend: false)
        selection.select("L3", extend: true)
        #expect(selection.range(in: ["L1", "L2"]) == 0...0)   // the focus is gone: the anchor alone
        #expect(selection.range(in: ["L2", "L3"]) == nil)   // the anchor is gone
        #expect(selection.keys(in: ["L2", "L3"]).isEmpty)
    }

    @Test func theCopiedTextIsTheCodeWithoutMarkersOrHeaders() {
        let lines = [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1,3 +1,3 @@"),
            DiffLine(id: 1, kind: .context, oldNo: 1, newNo: 1, text: "func a() {"),
            DiffLine(id: 2, kind: .del, oldNo: 2, newNo: nil, text: "    return 1"),
            DiffLine(id: 3, kind: .add, oldNo: nil, newNo: 2, text: "    return 2"),
            DiffLine(id: 4, kind: .context, oldNo: 3, newNo: 3, text: "}"),
        ]
        #expect(DiffLineSelection.copyText(lines) == "func a() {\n    return 1\n    return 2\n}")
        #expect(DiffLineSelection.copyText(lines.prefix(1)) == "")
    }
}
