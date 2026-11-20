import Foundation
import Testing
@testable import ReviewGateCore

/// The split diff layout (docs/PROTOCOL.md §34.11): removed lines on the left beside the added lines they pair with,
/// unchanged lines on both sides, hunk headers and folds full width.
@Suite struct DiffSplitTests {
    private func items(_ diff: FileDiff) -> [DiffDisplayItem] {
        DiffDisplayPlan.make(diff: diff, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: false).items
    }

    /// Each row as text: "H" a full-width row, "a|b" a pair (a side's text, "_" when padded).
    private func shape(_ layout: DiffSplitLayout) -> [String] {
        layout.rows.map { row in
            switch row.kind {
            case let .pair(left, right): "\(left?.text ?? "_")|\(right?.text ?? "_")"
            case let .item(item): "H:\(item.id)"
            }
        }
    }

    @Test func pairsRemovedWithAddedLinesAndPadsTheShorterSide() {
        let diff = DiffDisplayTests.diff("""
        @@ -1,6 +1,5 @@
         a
        -b
        -c
        -d
        +B
        +C
         e
        +f
        """)
        let layout = DiffSplit.layout(items(diff))
        #expect(shape(layout) == ["H:L0", "a|a", "b|B", "c|C", "d|_", "e|e", "_|f"])
    }

    @Test func aChangeNeverCrossesAHunkHeader() {
        let diff = DiffDisplayTests.diff("""
        @@ -1,2 +1,1 @@
        -x
        -y
        +X
        @@ -10,1 +9,2 @@
        +n1
        +n2
        """)
        let layout = DiffSplit.layout(items(diff))
        #expect(shape(layout) == ["H:L0", "x|X", "y|_", "H:L4", "_|n1", "_|n2"])
    }

    @Test func aRemovalAfterAdditionsStartsAnotherChange() {
        let diff = DiffDisplayTests.diff("""
        @@ -1,2 +1,2 @@
        -a
        +A
        -b
        +B
        """)
        #expect(shape(DiffSplit.layout(items(diff))) == ["H:L0", "a|A", "b|B"])
    }

    @Test func everyLineKeyFindsItsRow() {
        let diff = DiffDisplayTests.diff("""
        @@ -1,3 +1,3 @@
         a
        -b
        +B
         c
        """)
        let layout = DiffSplit.layout(items(diff))
        // The pair of b (L2) and B (L3) is one row, named by its left line.
        #expect(layout.rowId(forLineKey: "L2") == "L2")
        #expect(layout.rowId(forLineKey: "L3") == "L2")
        #expect(layout.rowId(forLineKey: "L1") == "L1")
        #expect(layout.rowId(forLineKey: "L0") == "L0")   // the hunk header is its own row
        #expect(layout.rowId(forLineKey: nil) == nil)
        #expect(Set(layout.rows.map(\.id)).count == layout.rows.count)
    }

    @Test func notesAnchorOnTheirSide() {
        let diff = DiffDisplayTests.diff("""
        @@ -1,3 +1,3 @@
         a
        -b
        +B
        +C
        """)
        let rows = DiffSplit.layout(items(diff)).rows
        // An unchanged line shows on both sides and anchors once, on the right (its new number).
        #expect(rows[1].anchors.left == nil)
        #expect(rows[1].anchors.right?.text == "a")
        // A removed line anchors on the left (old number), the added line beside it on the right.
        #expect(rows[2].anchors.left?.text == "b")
        #expect(rows[2].anchors.right?.text == "B")
        // A padded side has nothing.
        #expect(rows[3].anchors.left == nil)
        #expect(rows[3].anchors.right?.text == "C")
        // A full-width row anchors nothing.
        #expect(rows[0].anchors.left == nil && rows[0].anchors.right == nil)
        #expect(DiffSplit.anchorSide(of: DiffLine(id: 1, kind: .del, oldNo: 2, newNo: nil, text: "")) == .old)
        #expect(DiffSplit.anchorSide(of: DiffLine(id: 1, kind: .context, oldNo: 2, newNo: 2, text: "")) == .new)
    }

    @Test func revealedLinesAndExpandersKeepTheirPlace() {
        // "Show 20 more lines" above the second hunk: the expander stays full width, revealed lines are on both sides.
        var fold = DiffFoldState()
        fold.reveal(gap: 1, direction: .up)
        let plan = DiffDisplayPlan.make(diff: DiffDisplayTests.twoHunks, generated: nil, fold: fold,
                                        fullFile: DiffDisplayTests.twoHunksFile, truncated: false, contextEnabled: true)
        let layout = DiffSplit.layout(plan.items)
        for (item, row) in zip(plan.items.filter { if case .context = $0.kind { true } else { false } },
                               layout.rows.filter { $0.id.hasPrefix("C") }) {
            guard case let .context(line) = item.kind, case let .pair(left, right) = row.kind else {
                Issue.record("not a revealed pair")
                continue
            }
            #expect(left == line && right == line)
        }
        #expect(layout.rows.contains { $0.id.hasPrefix("X") })
        #expect(layout.rows.contains { $0.id.hasPrefix("C") })
        // Every unified line is in exactly one split row.
        let lineKeys = plan.items.compactMap { item -> String? in
            switch item.kind {
            case let .line(line), let .context(line): DiffDisplayItem.key(line)
            default: nil
            }
        }
        #expect(Set(lineKeys) == Set(layout.rowByLineKey.keys))
    }

    @Test func foldedLargeDiffKeepsItsFoldRows() {
        let body = (0..<3_100).map { "+n\($0)" }.joined(separator: "\n")
        let diff = DiffDisplayTests.diff("@@ -0,0 +1,3100 @@\n" + body)
        let layout = DiffSplit.layout(items(diff))
        #expect(shape(layout) == ["H:N", "H:L0", "H:F0"])
    }

    @Test func whitespaceOnlyPairsKeepTheirFlag() {
        // The -w view and a whitespace-only pair: lines are paired the same way, each keeps `wsOnly` for its faint text.
        let lines = [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1 +1 @@"),
            DiffLine(id: 1, kind: .del, oldNo: 1, newNo: nil, text: "a  b", wsOnly: true),
            DiffLine(id: 2, kind: .add, oldNo: nil, newNo: 1, text: "a b", wsOnly: true),
        ]
        let layout = DiffSplit.layout(lines: lines)
        #expect(layout.rows.count == 2)
        guard case let .pair(left, right) = layout.rows[1].kind else {
            Issue.record("not a pair")
            return
        }
        #expect(left?.wsOnly == true && right?.wsOnly == true)
    }

    @Test func splitNeedsTheWidthOfTwoReadableColumns() {
        let minimum = DiffSplit.minimumWidth(columnWidth: 7.8, gutter: 66)
        #expect(minimum > 700 && minimum < 760)
        #expect(DiffSplit.effective(.split, width: minimum, minimumWidth: minimum) == .split)
        #expect(DiffSplit.effective(.split, width: minimum - 1, minimumWidth: minimum) == .unified)
        #expect(DiffSplit.effective(.unified, width: 4_000, minimumWidth: minimum) == .unified)
    }

    /// A 20 000-line rewrite splits in one pass (the review diff builds it only while split is shown).
    @Test func largeDiffSplitsQuickly() {
        var lines = [DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1,10000 +1,10000 @@")]
        for i in 0..<10_000 { lines.append(DiffLine(id: lines.count, kind: .del, oldNo: i + 1, newNo: nil, text: "old \(i)")) }
        for i in 0..<10_000 { lines.append(DiffLine(id: lines.count, kind: .add, oldNo: nil, newNo: i + 1, text: "new \(i)")) }
        let start = Date()
        let layout = DiffSplit.layout(lines: lines)
        #expect(Date().timeIntervalSince(start) < 1.0)
        #expect(layout.rows.count == 10_001)
    }
}
