import Foundation
import Testing
@testable import ReviewGateCore

/// Review › Next Change / Previous Change (⌥⌘] / ⌥⌘[): the change blocks of a diff's rows, unified or split, and the file
/// the diff goes on to past its ends.
@Suite struct DiffChangeNavigationTests {
    private typealias Nav = DiffChangeNavigation

    private func items(_ diff: FileDiff, generated: GeneratedKind? = nil, fold: DiffFoldState = DiffFoldState()) -> [DiffDisplayItem] {
        DiffDisplayPlan.make(diff: diff, generated: generated, fold: fold, fullFile: nil, truncated: false, contextEnabled: false).items
    }

    /// Two hunks: a replaced line, then (after an unchanged one) an added line; a second hunk with a removed line.
    private static let diff = DiffDisplayTests.diff("""
    @@ -1,4 +1,4 @@
     a
    -b
    -c
    +B
     d
    +e
    @@ -20,2 +20,1 @@
     x
    -y
    """)

    /// Every block start, walked with `target` from no cursor to the end and back.
    private func walk(_ rows: [Nav.Row], _ direction: Nav.Direction, from start: String?) -> [String] {
        var out: [String] = []
        var cursor = start
        while let key = Nav.target(direction, from: cursor, in: rows) {
            out.append(key)
            cursor = key
        }
        return out
    }

    @Test func aBlockIsARunOfChangedLines() {
        // L0 @@, L1 a, L2 -b, L3 -c, L4 +B, L5 d, L6 +e, L7 @@, L8 x, L9 -y
        let rows = Nav.rows(items: items(Self.diff))
        #expect(Nav.blockStarts(rows).map { rows[$0].key } == ["L2", "L6", "L9"])
        #expect(walk(rows, .next, from: nil) == ["L2", "L6", "L9"])
        #expect(walk(rows, .previous, from: "L9") == ["L6", "L2"])
    }

    @Test func pastTheEndsThereIsNoBlock() {
        let rows = Nav.rows(items: items(Self.diff))
        #expect(Nav.target(.next, from: "L9", in: rows) == nil)
        #expect(Nav.target(.previous, from: "L2", in: rows) == nil)
        // No cursor yet (the file was just opened, at its top): nothing before it.
        #expect(Nav.target(.previous, from: nil, in: rows) == nil)
        // A cursor of another diff counts as none.
        #expect(Nav.target(.next, from: "L99", in: rows) == "L2")
    }

    @Test func fromInsideABlockPreviousIsItsStart() {
        let rows = Nav.rows(items: items(Self.diff))
        #expect(Nav.target(.previous, from: "L4", in: rows) == "L2")
        #expect(Nav.target(.next, from: "L3", in: rows) == "L6")
    }

    @Test func aFileIsEnteredAtItsFirstOrLastBlock() {
        let rows = Nav.rows(items: items(Self.diff))
        #expect(Nav.entry(.next, in: rows) == "L2")
        #expect(Nav.entry(.previous, in: rows) == "L9")
        #expect(Nav.entry(.next, in: []) == nil)
    }

    @Test func splitRowsHaveTheSameBlocksAtTheRowsOfTheirFirstLines() {
        let unified = items(Self.diff)
        let layout = DiffSplit.layout(unified)
        let split = Nav.rows(split: layout)
        let unifiedStops = walk(Nav.rows(items: unified), .next, from: nil)
        #expect(walk(split, .next, from: nil) == unifiedStops.compactMap { layout.rowId(forLineKey: $0) })
        // A removal after additions starts another split pair but not another block.
        let alternating = items(DiffDisplayTests.diff("""
        @@ -1,3 +1,3 @@
        -a
        +A
        -b
        +B
         c
        """))
        #expect(Nav.blockStarts(Nav.rows(split: DiffSplit.layout(alternating))).count == 1)
        #expect(Nav.blockStarts(Nav.rows(items: alternating)).count == 1)
    }

    @Test func aPlainLineListWalksAsItsRows() {
        let lines = Self.diff.allLines
        #expect(walk(Nav.rows(lines: lines), .next, from: nil) == ["L2", "L6", "L9"])
        let layout = DiffSplit.layout(lines: lines)
        #expect(walk(Nav.rows(split: layout), .next, from: nil) == ["L2", "L6", "L9"].compactMap { layout.rowId(forLineKey: $0) })
    }

    @Test func aClosedFoldIsOneBlock() {
        let folded = items(Self.diff, generated: .lockfile)
        #expect(walk(Nav.rows(items: folded), .next, from: nil) == ["G"])
        var open = DiffFoldState()
        open.fileOpen = true
        #expect(walk(Nav.rows(items: items(Self.diff, generated: .lockfile, fold: open)), .next, from: nil) == ["L2", "L6", "L9"])
    }

    @Test func theNeighbourFileStopsAtTheListsEnds() {
        let files = ["a", "b", "c"]
        #expect(Nav.neighbour(.next, of: "a", in: files) == "b")
        #expect(Nav.neighbour(.previous, of: "b", in: files) == "a")
        #expect(Nav.neighbour(.next, of: "c", in: files) == nil)
        #expect(Nav.neighbour(.previous, of: "a", in: files) == nil)
        #expect(Nav.neighbour(.next, of: "z", in: files) == "a")
        #expect(Nav.neighbour(.previous, of: nil, in: files) == "c")
        #expect(Nav.neighbour(.next, of: "a", in: [String]()) == nil)
    }
}
