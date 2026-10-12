import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 mac-diff — the diff pane's layout plan (docs/PROTOCOL.md §34.7, audit comp-18 / comp-19): big diffs fold hunk by
/// hunk, generated files and lockfiles fold whole, and "Show 20 more lines" reveals the full file around a hunk.
@Suite struct DiffDisplayTests {
    /// A FileDiff from unified hunks (header lines included), numbered like the engine's parser.
    static func diff(_ patch: String) -> FileDiff {
        var hunks: [DiffHunk] = []
        var lines: [DiffLine] = []
        var header = ""
        var id = 0, oldNo = 0, newNo = 0
        func close() {
            if !header.isEmpty { hunks.append(DiffHunk(id: hunks.count, header: header, lines: lines)) }
            lines = []
        }
        for line in patch.components(separatedBy: "\n") {   // code units, as the engine: "\r\n" is one Swift Character
            if line.hasPrefix("@@") {
                close()
                header = line
                let range = HunkRange(header: line)!
                oldNo = range.oldStart
                newNo = range.newStart
                lines.append(DiffLine(id: id, kind: .hunkHeader, oldNo: nil, newNo: nil, text: line))
            } else if line.hasPrefix("+") {
                lines.append(DiffLine(id: id, kind: .add, oldNo: nil, newNo: newNo, text: String(line.dropFirst())))
                newNo += 1
            } else if line.hasPrefix("-") {
                lines.append(DiffLine(id: id, kind: .del, oldNo: oldNo, newNo: nil, text: String(line.dropFirst())))
                oldNo += 1
            } else if line.hasPrefix(" ") {
                lines.append(DiffLine(id: id, kind: .context, oldNo: oldNo, newNo: newNo, text: String(line.dropFirst())))
                oldNo += 1
                newNo += 1
            } else {
                continue
            }
            id += 1
        }
        close()
        return FileDiff(oldPath: "a.txt", newPath: "a.txt", isBinary: false, hunks: hunks)
    }

    /// `n` numbered lines "l1" … "ln" (the full file).
    static func file(_ n: Int) -> [String] { (1...n).map { "l\($0)" } }

    /// The new side of `twoHunks`: old l1…l31 with line 11 rewritten and l25 deleted, so new 25… read l26….
    static let twoHunksFile = (1...24).map { "l\($0)" } + (26...31).map { "l\($0)" }

    /// Line 11 changed, old line 25 deleted (two hunks with 3 lines of context).
    static let twoHunks = diff("""
    @@ -8,7 +8,7 @@ func a()
     l8
     l9
     l10
    -old11
    +l11
     l12
     l13
     l14
    @@ -22,7 +22,6 @@ func b()
     l22
     l23
     l24
    -l25
     l26
     l27
     l28
    """)

    private func kinds(_ plan: DiffDisplayPlan) -> [String] {
        plan.items.map { item in
            switch item.kind {
            case let .line(line): line.kind == .hunkHeader ? "@\(line.text.prefix(10))" : "\(line.kind.rawValue.prefix(1)):\(line.text)"
            case let .context(line): "c\(line.newNo ?? -1)/\(line.oldNo ?? -1):\(line.text)"
            case let .expander(gap, hidden, up, down, revealed):
                "x\(gap):\(hidden.map(String.init) ?? "?"):\(up ? "u" : "")\(down ? "d" : "")" + (revealed > 0 ? ":r\(revealed)" : "")
            case let .foldedHunk(hunk, count, open): "f\(hunk):\(count):\(open)"
            case let .foldedFile(count, open): "g:\(count):\(open)"
            case let .largeDiff(count, open): "big:\(count):\(open)"
            }
        }
    }

    // MARK: Hunk ranges

    @Test func parsesHunkHeaders() {
        #expect(HunkRange(header: "@@ -8,7 +8,7 @@ func a()") == HunkRange(oldStart: 8, oldCount: 7, newStart: 8, newCount: 7))
        #expect(HunkRange(header: "@@ -1 +1,2 @@") == HunkRange(oldStart: 1, oldCount: 1, newStart: 1, newCount: 2))
        #expect(HunkRange(header: "@@ -0,0 +1,3 @@") == HunkRange(oldStart: 0, oldCount: 0, newStart: 1, newCount: 3))
        #expect(HunkRange(header: "@@ -5,3 +4,0 @@") == HunkRange(oldStart: 5, oldCount: 3, newStart: 4, newCount: 0))
        #expect(HunkRange(header: "@@") == nil)
        #expect(HunkRange(header: "@@ -a,1 +1 @@") == nil)
        #expect(HunkRange(header: "diff --git a/x b/x") == nil)
        // A pure deletion sits after its newStart; a pure insertion after its oldStart.
        let deletion = HunkRange(oldStart: 5, oldCount: 3, newStart: 4, newCount: 0)
        #expect(deletion.newFirst == 5 && deletion.newAfter == 5 && deletion.oldFirst == 5 && deletion.oldAfter == 8)
        let insertion = HunkRange(oldStart: 4, oldCount: 0, newStart: 5, newCount: 2)
        #expect(insertion.oldFirst == 5 && insertion.oldAfter == 5 && insertion.newFirst == 5 && insertion.newAfter == 7)
    }

    @Test func gapsCoverTheUnchangedLinesAroundHunks() throws {
        let gaps = try #require(DiffDisplay.gaps(of: Self.twoHunks))
        #expect(gaps.count == 3)
        #expect(gaps[0] == DiffGap(index: 0, newStart: 1, newEnd: 7, oldOffset: 0))
        #expect(gaps[1] == DiffGap(index: 1, newStart: 15, newEnd: 21, oldOffset: 0))
        #expect(gaps[2] == DiffGap(index: 2, newStart: 28, newEnd: nil, oldOffset: 1))   // after the deletion: old = new + 1
        #expect(gaps[2].size(fileLines: 30) == 3 && gaps[0].size(fileLines: nil) == 7 && gaps[2].size(fileLines: nil) == nil)
        // One header that does not parse: no context expansion at all.
        var broken = Self.twoHunks
        broken = FileDiff(oldPath: "a", newPath: "a", isBinary: false, hunks: [DiffHunk(id: 0, header: "@@", lines: broken.hunks[0].lines)])
        #expect(DiffDisplay.gaps(of: broken) == nil)
    }

    // MARK: Plain diffs and context

    @Test func smallDiffListsEveryLineWithExpandersAroundTheHunks() {
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: DiffFoldState(), fullFile: nil,
                                        truncated: false, contextEnabled: true)
        #expect(!plan.isLarge && !plan.foldsFile && plan.highlights)
        let k = kinds(plan)
        #expect(k.first == "x0:7:u")                        // above the first hunk: up only, 7 lines known from the header
        #expect(k.contains("x1:7:u"))                       // between the hunks: 7 hidden, one button shows them all
        #expect(k.last == "x2:?:d")                         // after the last hunk: size unknown until the file is loaded
        #expect(!plan.items.contains { if case .context = $0.kind { true } else { false } })   // nothing revealed yet
        #expect(plan.items.filter { if case .line = $0.kind { true } else { false } }.count == Self.twoHunks.allLines.count)
        // Without context (history / PR diffs, a deleted file): exactly the diff's lines.
        let bare = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: false)
        #expect(bare.items.map(\.id) == Self.twoHunks.allLines.map { "L\($0.id)" })
    }

    @Test func revealsContextFromTheFullFileWithOldNumbersShifted() {
        var fold = DiffFoldState()
        fold.reveal(gap: 0, direction: .up)
        fold.reveal(gap: 1, direction: .down)
        fold.reveal(gap: 2, direction: .down)
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: fold, fullFile: Self.twoHunksFile, truncated: false, contextEnabled: true)
        let k = kinds(plan)
        // Gap 0 (7 lines) fully revealed by one step: only "Collapse 7 lines" left where the expander was, then lines 1…7
        // before the first header.
        #expect(Array(k.prefix(9)) == ["x0:0::r7", "c1/1:l1", "c2/2:l2", "c3/3:l3", "c4/4:l4", "c5/5:l5", "c6/6:l6", "c7/7:l7",
                                       "@@@ -8,7 +8"])
        // Gap 1: the 7 lines below the first hunk (opened downward, so the collapse row follows them), then the second header.
        let afterFirst = k.firstIndex(of: "c:l14")!
        #expect(Array(k[(afterFirst + 1)...(afterFirst + 9)]) == ["c15/15:l15", "c16/16:l16", "c17/17:l17", "c18/18:l18", "c19/19:l19",
                                                                   "c20/20:l20", "c21/21:l21", "x1:0::r7", "@@@ -22,7 +"])
        // Gap 2: new lines 28… after the deletion are old 29…; the file ends at new line 30.
        #expect(Array(k.suffix(4)) == ["c28/29:l29", "c29/30:l30", "c30/31:l31", "x2:0::r3"])
        #expect(plan.items.contains { $0.id == "C28" })
    }

    /// The List carries no `.id()` per row (it would build every row): find in diff scrolls to a line by the item's own id.
    @Test func aLineItemsIdIsItsKey() {
        var fold = DiffFoldState()
        fold.reveal(gap: 0, direction: .up)
        fold.reveal(gap: 1, direction: .down)
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: fold, fullFile: Self.twoHunksFile, truncated: false, contextEnabled: true)
        let lines = plan.items.compactMap { item -> (id: String, line: DiffLine)? in
            switch item.kind {
            case let .line(line), let .context(line): (item.id, line)
            default: nil
            }
        }
        #expect(lines.contains { $0.line.id < 0 } && lines.contains { $0.line.id >= 0 })   // revealed context and diff lines both
        #expect(lines.allSatisfy { $0.id == DiffDisplayItem.key($0.line) })
    }

    @Test func revealGrowsTwentyLinesAtATimeAndStopsAtTheHunks() {
        let big = Self.diff("""
        @@ -60,5 +60,5 @@
         l60
        -x
        +l61
         l62
         l63
         l64
        """)
        var fold = DiffFoldState()
        fold.reveal(gap: 0, direction: .up)
        var plan = DiffDisplayPlan.make(diff: big, generated: nil, fold: fold, fullFile: Self.file(100), truncated: false, contextEnabled: true)
        var k = kinds(plan)
        #expect(k.first == "x0:39:u:r20")                   // 59 lines above, 20 shown right above the hunk
        #expect(k[1] == "c40/40:l40" && k[20] == "c59/59:l59")
        fold.reveal(gap: 0, direction: .up)
        fold.reveal(gap: 0, direction: .up)
        plan = DiffDisplayPlan.make(diff: big, generated: nil, fold: fold, fullFile: Self.file(100), truncated: false, contextEnabled: true)
        k = kinds(plan)
        #expect(k.first == "x0:0::r59" && k[1] == "c1/1:l1")   // 60 requested, 59 there: nothing left to show, all to collapse
        // The trailing gap: 36 lines after the hunk.
        fold.reveal(gap: 1, direction: .down)
        plan = DiffDisplayPlan.make(diff: big, generated: nil, fold: fold, fullFile: Self.file(100), truncated: false, contextEnabled: true)
        k = kinds(plan)
        #expect(k.last == "x1:16:d:r20" && k.contains("c84/84:l84") && !k.contains("c85/85:l85"))
    }

    @Test func aLastHunkAtTheEndOfTheFileHasNoTrailingExpander() throws {
        // Diffs keep 3 unchanged lines after a change; fewer means the file ended there.
        let atEnd = Self.diff("""
        @@ -10,4 +10,4 @@
         l10
         l11
        -x
        +l12
         l13
        """)
        #expect(try #require(DiffDisplay.gaps(of: atEnd)).last?.size(fileLines: nil) == 0)
        let k = kinds(DiffDisplayPlan.make(diff: atEnd, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: true))
        #expect(k.first == "x0:9:u" && !k.contains { $0.hasPrefix("x1") })
    }

    @Test func middleGapRevealsFromBothEndsAndMergesWhenSmall() {
        let far = Self.diff("""
        @@ -1,2 +1,2 @@
        -a
        +l1
         l2
        @@ -60,2 +60,2 @@
         l60
        -b
        +l61
        """)
        var fold = DiffFoldState()
        fold.reveal(gap: 1, direction: .down)   // l3…l22 under the first hunk
        fold.reveal(gap: 1, direction: .up)     // l40…l59 above the second
        let plan = DiffDisplayPlan.make(diff: far, generated: nil, fold: fold, fullFile: Self.file(61), truncated: false, contextEnabled: true)
        let k = kinds(plan)
        let x = k.firstIndex(of: "x1:17:u:r40")!   // 17 hidden: one button
        #expect(k[x - 1] == "c22/22:l22" && k[x + 1] == "c40/40:l40")
        // ≤ 20 hidden: one button that shows the rest.
        var more = fold
        more.reveal(gap: 1, direction: .down)
        let merged = kinds(DiffDisplayPlan.make(diff: far, generated: nil, fold: more, fullFile: Self.file(61), truncated: false, contextEnabled: true))
        // 17 left, 20 asked: the gap is all shown — only its collapse row is left, between the two ends.
        let y = merged.firstIndex(of: "x1:0::r57")!
        #expect(merged[y - 1] == "c42/42:l42" && merged[y + 1] == "c43/43:l43")
        #expect(merged.filter { $0.hasPrefix("x1") }.count == 1)
        let small = Self.diff("""
        @@ -1,2 +1,2 @@
        -a
        +l1
         l2
        @@ -12,2 +12,2 @@
         l12
        -b
        +l13
        """)
        #expect(kinds(DiffDisplayPlan.make(diff: small, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: true))
            .contains("x1:9:u"))   // 9 hidden: a single "show" (up) button
    }

    // MARK: Collapsing what "Show 20 more lines" revealed

    private func plan(_ diff: FileDiff, _ fold: DiffFoldState, file: [String], generated: GeneratedKind? = nil) -> DiffDisplayPlan {
        DiffDisplayPlan.make(diff: diff, generated: generated, fold: fold, fullFile: file, truncated: false, contextEnabled: true)
    }

    @Test func collapseHidesOneGapAgainAndLeavesTheOthersShown() {
        var fold = DiffFoldState()
        #expect(!fold.hasRevealed)
        fold.reveal(gap: 0, direction: .up)
        fold.reveal(gap: 1, direction: .down)
        fold.reveal(gap: 2, direction: .down)
        #expect(fold.hasRevealed)
        fold.collapse(gap: 1)
        let k = kinds(plan(Self.twoHunks, fold, file: Self.twoHunksFile))
        #expect(k.contains("x1:7:u"))   // back to its first expander: 7 hidden, nothing to collapse
        #expect(!k.contains { $0.hasPrefix("c15/") || $0.hasPrefix("c21/") })
        #expect(k.first == "x0:0::r7" && k.last == "x2:0::r3")   // the other gaps stay shown
        // Collapsing a gap that shows nothing changes nothing.
        let before = fold
        fold.collapse(gap: 1)
        fold.collapse(gap: 7)
        #expect(fold == before)
    }

    @Test func collapseWorksPartWayAndOnBothEndsAndTheNextRevealStartsOver() {
        let far = Self.diff("""
        @@ -1,2 +1,2 @@
        -a
        +l1
         l2
        @@ -60,2 +60,2 @@
         l60
        -b
        +l61
        """)
        let file = Self.file(61)
        let untouched = plan(far, DiffFoldState(), file: file)
        #expect(kinds(untouched).contains("x1:57:ud"))
        var fold = DiffFoldState()
        fold.reveal(gap: 1, direction: .down)   // l3…l22 under the first hunk
        #expect(kinds(plan(far, fold, file: file)).contains("x1:37:ud:r20"))   // part way: show more or collapse
        fold.reveal(gap: 1, direction: .up)     // l40…l59 above the second
        #expect(kinds(plan(far, fold, file: file)).contains("x1:17:u:r40"))
        fold.collapse(gap: 1)                   // both ends hidden at once
        #expect(fold == DiffFoldState())        // as if never opened: the pane's plan cache matches the untouched plan
        #expect(plan(far, fold, file: file) == untouched)
        fold.reveal(gap: 1, direction: .down)   // 20 again, not 60
        let k = kinds(plan(far, fold, file: file))
        #expect(k.contains("x1:37:ud:r20") && k.contains("c22/22:l22") && !k.contains("c23/23:l23"))
    }

    @Test func collapseAllHidesEveryGapAndKeepsTheFolds() {
        var fold = DiffFoldState()
        fold.fileOpen = true
        fold.reveal(gap: 0, direction: .up)
        fold.reveal(gap: 1, direction: .up)
        fold.reveal(gap: 2, direction: .down)
        fold.collapseAllRevealed()
        #expect(!fold.hasRevealed && fold.fileOpen)   // the generated file stays open
        var fresh = DiffFoldState()
        fresh.fileOpen = true
        let collapsed = plan(Self.twoHunks, fold, file: Self.twoHunksFile, generated: .lockfile)
        #expect(collapsed == plan(Self.twoHunks, fresh, file: Self.twoHunksFile, generated: .lockfile))
        #expect(!collapsed.items.contains { if case .context = $0.kind { true } else { false } })
        #expect(Array(kinds(collapsed).prefix(2)) == ["g:15:true", "x0:7:u"])
    }

    @Test func truncatedDiffHasNoTrailingExpanderAndRevealIgnoresAMissingFile() {
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: true, contextEnabled: true)
        #expect(!kinds(plan).contains { $0.hasPrefix("x2") })
        var fold = DiffFoldState()
        fold.reveal(gap: 0, direction: .up)
        let unloaded = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: fold, fullFile: nil, truncated: false, contextEnabled: true)
        #expect(kinds(unloaded).first == "x0:7:u")   // nothing to show the lines from yet
    }

    @Test func fullFileMustMatchTheDiffToRevealFromIt() {
        #expect(DiffDisplay.fullFileMatches(Self.twoHunks, lines: Self.twoHunksFile))
        var edited = Self.twoHunksFile
        edited[10] = "edited after the diff"   // line 11 (an added line)
        #expect(!DiffDisplay.fullFileMatches(Self.twoHunks, lines: edited))
        #expect(!DiffDisplay.fullFileMatches(Self.twoHunks, lines: Array(Self.twoHunksFile.prefix(20))))   // shorter than the diff
        // A CRLF file: the diff keeps the \r, the full file does not.
        let crlf = Self.diff("@@ -1,2 +1,2 @@\n l1\r\n-x\r\n+l2\r")
        #expect(DiffDisplay.fullFileMatches(crlf, lines: ["l1", "l2"]))
    }

    // MARK: Folding (comp-18)

    @Test func largeDiffFoldsEveryHunkUnderItsHeaderAndSkipsHighlighting() {
        var patch = "@@ -1,1600 +1,1600 @@\n"
        for i in 1...1600 { patch += "-o\(i)\n+n\(i)\n" }
        patch += "@@ -2000,2 +2000,2 @@\n l1999\n-x\n+y\n"
        let large = Self.diff(patch)
        #expect(large.allLines.count > DiffDisplay.foldLineThreshold)
        let plan = DiffDisplayPlan.make(diff: large, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: true)
        #expect(plan.isLarge && !plan.highlights)
        #expect(kinds(plan) == ["big:\(large.allLines.count):false", "@@@ -1,1600", "f0:3200:false", "@@@ -2000,2", "f1:3:false"])
        var fold = DiffFoldState()
        fold.openHunks = [1]
        let one = kinds(DiffDisplayPlan.make(diff: large, generated: nil, fold: fold, fullFile: nil, truncated: false, contextEnabled: true))
        #expect(one.suffix(5) == ["@@@ -2000,2", "f1:3:true", "c:l1999", "d:x", "a:y"])
        fold.allOpen = true
        let all = DiffDisplayPlan.make(diff: large, generated: nil, fold: fold, fullFile: nil, truncated: false, contextEnabled: true)
        #expect(kinds(all).first == "big:\(large.allLines.count):true")
        #expect(all.items.filter { if case .line = $0.kind { true } else { false } }.count == large.allLines.count)
        #expect(!all.highlights)   // still too big to highlight
        #expect(!kinds(all).contains { $0.hasPrefix("x") })   // no context expansion on a large diff
    }

    @Test func generatedFileFoldsWholeUntilOpened() {
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: .lockfile, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: true)
        #expect(plan.foldsFile && !plan.highlights)
        #expect(kinds(plan) == ["g:15:false"])   // every +/-/context line, headers not counted
        var fold = DiffFoldState()
        fold.fileOpen = true
        let open = DiffDisplayPlan.make(diff: Self.twoHunks, generated: .other("future"), fold: fold, fullFile: nil, truncated: false, contextEnabled: true)
        #expect(!open.foldsFile && open.highlights && kinds(open).first == "g:15:true")
    }

    @Test func lineIdsResolveToTheirHunk() {
        let plan = DiffDisplayPlan.make(diff: Self.twoHunks, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: false, contextEnabled: false)
        #expect(plan.items.count == 17)
        #expect(DiffDisplay.hunkId(containingLine: 0, in: Self.twoHunks) == 0)
        #expect(DiffDisplay.hunkId(containingLine: 12, in: Self.twoHunks) == 1)
        #expect(DiffDisplay.hunkId(containingLine: 99, in: Self.twoHunks) == nil)
    }
}
