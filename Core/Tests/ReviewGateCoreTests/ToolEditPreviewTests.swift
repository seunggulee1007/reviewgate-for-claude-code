import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 mac-diff — the folded mini diff under a chat Edit / MultiEdit / Write row (docs/PROTOCOL.md §34.6, audit comp-03 /
/// market-13): built on the client from `tool_use.input`, so Claude's change is visible while the turn still runs.
@Suite struct ToolEditPreviewTests {
    private func input(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }

    private func shape(_ p: ToolEditPreview) -> [String] {
        p.lines.map { line in
            switch line.kind {
            case .add: "+\(line.text)"
            case .del: "-\(line.text)"
            case .context: " \(line.text)"
            case .hunkHeader: "~"
            }
        }
    }

    @Test func editShowsOldAgainstNewWithTheChangedPartMarked() throws {
        let p = try #require(ToolEditPreview.make(name: "Edit", input: input([
            "file_path": .string("/repo/Svc.java"),
            "old_string": .string("    Foo foo = load();\n    return repo.find(id).orElseThrow();"),
            "new_string": .string("    Foo foo = load();\n    return repo.find(id).orElseThrow(NotFound::new);"),
        ])))
        #expect(shape(p) == ["     Foo foo = load();", "-    return repo.find(id).orElseThrow();", "+    return repo.find(id).orElseThrow(NotFound::new);"])
        #expect(p.added == 1 && p.removed == 1 && p.hiddenLines == 0)
        let add = p.lines[2]
        #expect(add.segments.compactMap { $0.range(in: add.text).map { String(add.text[$0]) } } == ["NotFound::new"])
        #expect(p.lines[1].segments.isEmpty)   // nothing removed inside the old line: only an insertion
        // The DiffLine form numbers the lines for the row view.
        #expect(p.diffLines.map(\.id) == [0, 1, 2] && p.diffLines[2].kind == .add && p.diffLines[2].segments == add.segments)
    }

    @Test func crlfTextSplitsIntoLines() throws {
        let p = try #require(ToolEditPreview.make(name: "Edit", input: input([
            "old_string": .string("a\r\nb\r\nc"), "new_string": .string("a\r\nB\r\nc"),
        ])))
        #expect(shape(p) == [" a", "-b", "+B", " c"])
    }

    @Test func rewrittenLinesAreNotMarkedPartByPart() throws {
        let p = try #require(ToolEditPreview.make(name: "Edit", input: input([
            "old_string": .string("alpha beta"), "new_string": .string("gamma delta epsilon"),
        ])))
        #expect(shape(p) == ["-alpha beta", "+gamma delta epsilon"])
        #expect(p.lines.allSatisfy { $0.segments.isEmpty })   // > 60 % changed: a whole-line change (as §34.7)
    }

    @Test func multiEditSeparatesItsEditsAndSumsTheCounts() throws {
        let p = try #require(ToolEditPreview.make(name: "MultiEdit", input: input([
            "file_path": .string("/repo/a.ts"),
            "edits": .array([
                .object(["old_string": .string("a\nb"), "new_string": .string("a\nB\nc")]),
                .object(["old_string": .string("x"), "new_string": .string("")]),
                .string("not an edit"),
            ]),
        ])))
        #expect(shape(p) == [" a", "-b", "+B", "+c", "~", "-x"])
        #expect(p.added == 2 && p.removed == 2)
        #expect(p.edits == 2)
    }

    @Test func writeShowsTheFirstTwentyLines() throws {
        let content = (1...25).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let p = try #require(ToolEditPreview.make(name: "Write", input: input(["file_path": .string("/repo/n.md"), "content": .string(content)])))
        #expect(p.lines.count == ToolEditPreview.writeLines && p.lines.allSatisfy { $0.kind == .add })
        #expect(p.lines.first?.text == "line 1" && p.lines.last?.text == "line 20")
        #expect(p.added == 25 && p.removed == 0 && p.hiddenLines == 5)
        #expect(ToolEditPreview.make(name: "Write", input: input(["content": .string("")])) == nil)   // an empty file: nothing to show
    }

    @Test func longEditsAreCappedAndHugeOnesSkipTheLineMatch() throws {
        let old = (1...30).map { "old \($0)" }.joined(separator: "\n")
        let new = (1...30).map { "new \($0)" }.joined(separator: "\n")
        let p = try #require(ToolEditPreview.make(name: "Edit", input: input(["old_string": .string(old), "new_string": .string(new)])))
        #expect(p.lines.count == ToolEditPreview.maxLines && p.hiddenLines == 20 && p.added == 30 && p.removed == 30)
        // Thousands of lines: removed then added, no O(n·m) match. All but one line are the same, so a line match would
        // count 1 removed and 1 added with context around them: the counts prove it was skipped, whatever the runner's
        // speed. The time bounds only catch an explosion (a slow runner is not one).
        func oneLineChanged(of n: Int) -> (old: String, new: String) {
            ((1...n).map { "l\($0)" }.joined(separator: "\n"), (1...n).map { $0 == n / 2 ? "changed" : "l\($0)" }.joined(separator: "\n"))
        }
        let small = oneLineChanged(of: 100)   // under the limit: matched
        let matched = try #require(ToolEditPreview.make(name: "Edit", input: input(["old_string": .string(small.old), "new_string": .string(small.new)])))
        #expect(matched.removed == 1 && matched.added == 1)
        let (bigOld, bigNew) = oneLineChanged(of: 3000)
        let clock = ContinuousClock()
        let start = clock.now
        let big = try #require(ToolEditPreview.make(name: "Edit", input: input(["old_string": .string(bigOld), "new_string": .string(bigNew)])))
        #expect(clock.now - start < .seconds(10))
        #expect(big.removed == 3000 && big.added == 3000 && big.lines.count == ToolEditPreview.maxLines)
        #expect(big.lines.allSatisfy { $0.kind == .del } && big.hiddenLines == 6000 - ToolEditPreview.maxLines)
        // A generated Write of 50 000 lines: counted, not split (the row's body runs on every hover).
        let hugeStart = clock.now
        let huge = try #require(ToolEditPreview.make(name: "Write", input: input(["content": .string(String(repeating: "x = 1\n", count: 50_000))])))
        #expect(clock.now - hugeStart < .seconds(10))
        #expect(huge.added == 50_000 && huge.lines.count == ToolEditPreview.writeLines && huge.hiddenLines == 50_000 - ToolEditPreview.writeLines)
    }

    @Test func otherToolsAndMalformedInputHaveNoPreview() {
        #expect(ToolEditPreview.make(name: "Read", input: input(["file_path": .string("/a")])) == nil)
        #expect(ToolEditPreview.make(name: "Bash", input: input(["command": .string("ls")])) == nil)
        #expect(ToolEditPreview.make(name: "Edit", input: input(["old_string": .string("a")])) == nil)
        #expect(ToolEditPreview.make(name: "Edit", input: .string("x")) == nil)
        #expect(ToolEditPreview.make(name: "MultiEdit", input: input(["edits": .array([])])) == nil)
        #expect(ToolEditPreview.make(name: "Write", input: input([:])) == nil)
        // Nothing changed (old == new): nothing to show.
        #expect(ToolEditPreview.make(name: "Edit", input: input(["old_string": .string("same"), "new_string": .string("same")])) == nil)
    }
}
