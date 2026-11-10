import Foundation
import SwiftUI
import Testing
@testable import ReviewGateCore

/// wave2 mac-diff — one diff line on screen (docs/PROTOCOL.md §34.7, audit comp-07 / market-06 / comp-19): the changed
/// parts of a pair marked inside the line, the render cap with its tooltip, display columns for the shared horizontal
/// scroll, find-in-diff matches and the copy texts.
@Suite struct DiffLineTextTests {
    private func backgrounds(_ s: AttributedString) -> [(String, Color?)] {
        s.runs.map { (String(s[$0.range].characters), $0.swiftUI.backgroundColor) }
    }

    private func marked(_ s: AttributedString) -> [String] {
        backgrounds(s).filter { $0.1 != nil }.map(\.0)
    }

    // MARK: Segments (§34.7)

    @Test func segmentsOfTheProtocolExampleMarkTheChangedTokens() throws {
        // §34.7's example pair, as the engine would send it.
        let del = try NDJSON.decode(DiffLine.self, from: #"{"id":7,"kind":"del","oldNo":12,"newNo":null,"text":"    return repo.find(id).orElseThrow();","segments":[[36,38]]}"#)
        let add = try NDJSON.decode(DiffLine.self, from: #"{"id":8,"kind":"add","oldNo":null,"newNo":12,"text":"    return repo.find(id).orElseThrow(NotFound::new);","segments":[[37,50]]}"#)
        #expect(DiffLineText.segmentRanges(add, in: add.text).map { String(add.text[$0]) } == ["NotFound::new"])
        let styled = DiffLineText.styled(add, base: nil, emphasis: .green, find: [], findColor: .yellow)
        #expect(marked(styled) == ["NotFound::new"])
        #expect(String(styled.characters) == add.text)
        #expect(marked(DiffLineText.styled(del, base: nil, emphasis: .red, find: [], findColor: .yellow)) == ["()"])
        // No segments (an unpaired line, an older engine): nothing marked inside the line — the row tint says it all.
        let plain = DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 1, text: "let x = 1")
        #expect(marked(DiffLineText.styled(plain, base: nil, emphasis: .green, find: [], findColor: .yellow)).isEmpty)
    }

    @Test func segmentsUseUTF16OffsetsAndSkipRangesOfAnotherText() {
        // "한글 e\u{301} 👩‍👩‍👧": Hangul (1 unit each), a combining accent, a ZWJ emoji (8 units).
        let text = "x = \"한글 e\u{301} 👩‍👩‍👧\""
        let line = DiffLine(id: 0, kind: .add, oldNo: nil, newNo: 1, text: text,
                            segments: [DiffSegment(start: 5, end: 7), DiffSegment(start: 8, end: 10), DiffSegment(start: 11, end: 19),
                                       DiffSegment(start: 30, end: 40)])   // the last one is past the end: dropped
        #expect(DiffLineText.segmentRanges(line, in: text).map { String(text[$0]) } == ["한글", "e\u{301}", "👩‍👩‍👧"])
        // A range that ends inside a surrogate pair (never sent by the engine) is dropped rather than split.
        let split = DiffLine(id: 0, kind: .add, oldNo: nil, newNo: 1, text: text, segments: [DiffSegment(start: 11, end: 12)])
        #expect(DiffLineText.segmentRanges(split, in: text).isEmpty)
    }

    @Test func styledKeepsTheHighlightersColoursUnderTheMarks() {
        let text = "let total = price * count"
        var base = AttributedString("let ")
        base.swiftUI.foregroundColor = .purple
        base.append(AttributedString("total = price * count"))
        let line = DiffLine(id: 0, kind: .add, oldNo: nil, newNo: 1, text: text, segments: [DiffSegment(start: 4, end: 9)])
        let styled = DiffLineText.styled(line, base: base, emphasis: .green, find: [], findColor: .yellow)
        #expect(String(styled.characters) == text)
        #expect(marked(styled) == ["total"])
        #expect(styled.runs.first?.swiftUI.foregroundColor == .purple)
        // A base for another text (stale highlight) is ignored instead of mis-marking.
        let stale = DiffLineText.styled(line, base: AttributedString("something else"), emphasis: .green, find: [], findColor: .yellow)
        #expect(String(stale.characters) == text && marked(stale) == ["total"])
    }

    // MARK: Render cap (comp-07)

    @Test func longLinesAreCutOnACharacterBoundary() {
        let short = "a + b"
        #expect(DiffLineText.shown(short) == DiffLineText.Shown(text: short, cut: false))
        let long = String(repeating: "x", count: DiffLineText.renderLimit - 1) + "한글" + String(repeating: "y", count: 50)
        let shown = DiffLineText.shown(long)
        #expect(shown.cut)
        #expect(shown.text.utf16.count == DiffLineText.renderLimit)            // ends on "한", inside the limit
        #expect(shown.text.hasSuffix("한") && long.hasPrefix(shown.text))
        let emoji = String(repeating: "x", count: DiffLineText.renderLimit - 1) + "👩‍👩‍👧"   // the cluster would cross the limit
        #expect(DiffLineText.shown(emoji).text == String(repeating: "x", count: DiffLineText.renderLimit - 1))
        // The marks stop at the cut; the tooltip keeps the start of the full line.
        let line = DiffLine(id: 0, kind: .add, oldNo: nil, newNo: 1, text: long,
                            segments: [DiffSegment(start: 10, end: 12), DiffSegment(start: DiffLineText.renderLimit + 2, end: DiffLineText.renderLimit + 4)])
        let styled = DiffLineText.styled(line, base: nil, emphasis: .green, find: [], findColor: .yellow)
        #expect(String(styled.characters) == shown.text && marked(styled) == ["xx"])
        let huge = String(repeating: "z", count: DiffLineText.tooltipLimit + 500)
        #expect(DiffLineText.tooltip(huge).count == DiffLineText.tooltipLimit + 1 && DiffLineText.tooltip(huge).hasSuffix("…"))
        #expect(DiffLineText.tooltip(long) == long && DiffLineText.tooltip("short") == "short")
    }

    // MARK: Columns (shared horizontal scroll)

    @Test func columnsCountTabsAndWideCharacters() {
        #expect(DiffLineText.columns("abc") == 3)
        #expect(DiffLineText.columns("\tx") == 5)            // a tab counts as 4
        #expect(DiffLineText.columns("한글") >= 4)            // East Asian wide: at least two columns each
        #expect(DiffLineText.columns("") == 0)
        #expect(DiffLineText.maxColumns(["a", "abcd", "ab"]) == 4)
        #expect(DiffLineText.maxColumns([]) == 0)
        // Never under the real width (an upper bound is what the scroll extent needs).
        for s in ["return x;", "// 주문 요약 조회", "naïve café", "emoji 👍 ok"] {
            #expect(DiffLineText.columns(s) >= s.count, "\(s)")
        }
        // Lines past the render cap count only what is drawn.
        #expect(DiffLineText.maxColumns([String(repeating: "z", count: 50_000)]) == DiffLineText.renderLimit)
    }

    // MARK: Find in diff (comp-19)

    @Test func findMatchesIgnoringCase() {
        let text = "User user USER usér"
        #expect(DiffFind.ranges(of: "user", in: text).count == 3)   // code as written: "usér" is another word
        #expect(DiffFind.matches(query: "USER", in: [.init(key: "a", text: "usér"), .init(key: "b", text: "x.User")]) == ["b"])
        #expect(DiffFind.matches(query: "주문", in: [.init(key: "a", text: "// 주문 요약"), .init(key: "b", text: "주소")]) == ["a"])
        #expect(DiffFind.ranges(of: "주문", in: "// 주문 요약").count == 1)
        #expect(DiffFind.matches(query: "ab", in: [.init(key: "a", text: "a"), .init(key: "b", text: "xAB"), .init(key: "c", text: "aab")]) == ["b", "c"])
        #expect(DiffFind.ranges(of: "  ", in: text).isEmpty)       // whitespace-only queries find nothing
        #expect(DiffFind.ranges(of: "", in: text).isEmpty)
        #expect(DiffFind.ranges(of: " userId ", in: "a.userId = b").map { String("a.userId = b"[$0]) } == ["userId"])   // trimmed
        let rows: [DiffFind.Row] = [.init(key: "L0", text: "@@ -1 +1 @@"), .init(key: "L1", text: "userId = 1"),
                                    .init(key: "L2", text: "nothing"), .init(key: "C9", text: "getUserId()")]
        #expect(DiffFind.matches(query: "userid", in: rows) == ["L1", "C9"])
        #expect(DiffFind.matches(query: "zzz", in: rows).isEmpty)
        let line = DiffLine(id: 1, kind: .context, oldNo: 1, newNo: 1, text: "userId = userId")
        let styled = DiffLineText.styled(line, base: nil, emphasis: nil, find: DiffFind.ranges(of: "userid", in: line.text), findColor: .yellow)
        #expect(marked(styled) == ["userId", "userId"])
    }

    @Test func findGivesTheMatchColumnForTheSidewaysScroll() {
        #expect(DiffFind.column(of: "userId", in: "\tfoo(a.userId)") == 4 + 6)
        #expect(DiffFind.column(of: "userid", in: "// 주문 userId") == 3 + 4 + 1)   // two wide characters
        #expect(DiffFind.column(of: "x", in: "abc") == nil)
        #expect(DiffFind.column(of: "a", in: "abc") == 0)
    }

    @Test func findStepsThroughMatchesAndWraps() {
        var find = DiffFindState()
        #expect(find.currentKey == nil)
        find.update(matches: ["L1", "L5", "C9"])
        #expect(find.currentKey == "L1" && find.current == 0 && find.total == 3)
        find.next(); find.next()
        #expect(find.currentKey == "C9")
        find.next()
        #expect(find.currentKey == "L1")
        find.previous()
        #expect(find.currentKey == "C9")
        // New matches keep the current one when it is still there.
        find.update(matches: ["L0", "C9"])
        #expect(find.currentKey == "C9" && find.current == 1)
        find.update(matches: [])
        #expect(find.currentKey == nil && find.current == nil)
    }

    // MARK: Copy (comp-19)

    @Test func copyTextsNameThePathAndTheLine() {
        let add = DiffLine(id: 2, kind: .add, oldNo: nil, newNo: 42, text: "    int b = 2;")
        let del = DiffLine(id: 3, kind: .del, oldNo: 40, newNo: nil, text: "    int b = 1;")
        let header = DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -40 +42 @@")
        #expect(DiffLineText.copyLine(add) == "    int b = 2;")
        #expect(DiffLineText.copyLocation(add, path: "api/Svc.java") == "api/Svc.java:42")
        #expect(DiffLineText.copyLocation(del, path: "api/Svc.java") == "api/Svc.java:40")   // a deleted line: its old number
        #expect(DiffLineText.copyLocation(header, path: "api/Svc.java") == nil)
    }
}
