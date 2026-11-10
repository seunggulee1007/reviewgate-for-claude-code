import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave4d w4d-speed — audit polish-09 / polish-10: the diff pane's per-diff lookups and what VoiceOver reads.
@Suite struct DiffRowSupportTests {
    // MARK: polish-09 — per-diff lookups, once

    /// The pane before: every body evaluation (each pointer move over a line) built `allLines` twice (the highlight and
    /// width task keys) and, for each hunk header row it drew, the header → hunk map of the whole diff.
    private static func oldHeaderMap(_ diff: FileDiff) -> [Int: Int] {
        var map: [Int: Int] = [:]
        for hunk in diff.hunks {
            if let header = hunk.lines.first(where: { $0.kind == .hunkHeader }) { map[header.id] = hunk.id }
        }
        return map
    }

    @Test func theIndexAgreesWithTheDiff() {
        let diff = DiffPerformanceTests.acmeDiff(lines: 3_000)
        let index = FileDiffIndex(diff)
        #expect(index.lineCount == diff.allLines.count)
        #expect(index.hunkByHeader == Self.oldHeaderMap(diff))
        #expect(index.hunkByHeader.count == diff.hunks.count)
        let empty = FileDiffIndex(FileDiff(oldPath: nil, newPath: "a", isBinary: true, hunks: []))
        #expect(empty.lineCount == 0 && empty.hunkByHeader.isEmpty)
    }

    /// A pointer crossing 1 000 lines of a 3 000-line diff: what the pane derived from the diff per move before (a hover was
    /// view-level state, so every move re-ran the pane's body) against now (the hover is the row's own state; the index is
    /// built once). Printed for the record; the bound only says the index is not rebuilt per move.
    @Test func hoveringA3000LineDiff() {
        let diff = DiffPerformanceTests.acmeDiff(lines: 3_000)
        let headersOnScreen = 2
        var sink = 0
        let before = DiffPerformanceTests.bestCPU {
            for _ in 0..<1_000 {
                sink &+= diff.allLines.count   // highlightKey
                sink &+= diff.allLines.count   // ColumnsKey
                for _ in 0..<headersOnScreen { sink &+= Self.oldHeaderMap(diff).count }
            }
        }
        let after = DiffPerformanceTests.bestCPU {
            let index = FileDiffIndex(diff)
            for move in 0..<1_000 {
                sink &+= index.lineCount &+ (index.hunkByHeader[move] ?? 0)
            }
        }
        print("wave4d w4d-speed: 1 000 hovers over a 3 000-line diff — before \(before * 1_000) ms, after \(after * 1_000) ms (\(sink))")
        #expect(after < before)
        #expect(after < 0.05, "index once + 1 000 lookups: \(after)s")
    }

    // MARK: polish-10 — what VoiceOver reads

    @Test func aDiffLineIsReadAsOneSentence() {
        let add = DiffLine(id: 3, kind: .add, oldNo: nil, newNo: 42, text: "return total;")
        let del = DiffLine(id: 2, kind: .del, oldNo: 41, newNo: nil, text: "return sum;")
        let ctx = DiffLine(id: 1, kind: .context, oldNo: 40, newNo: 40, text: "}")
        let head = DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -40,2 +40,2 @@ class A")
        #expect(ReviewSpeech.line(add) == "Added line 42: return total;")
        #expect(ReviewSpeech.line(del) == "Removed line 41: return sum;")
        #expect(ReviewSpeech.line(ctx) == "Unchanged line 40: }")
        #expect(ReviewSpeech.line(head) == "Changed part: @@ -40,2 +40,2 @@ class A")
        #expect(ReviewSpeech.linePrefix(add) == "Added line 42:")
    }

    @Test func blankWhitespaceAndLongLines() {
        #expect(ReviewSpeech.line(DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 7, text: "   ")) == "Added line 7: (blank line)")
        let ws = DiffLine(id: 2, kind: .del, oldNo: 8, newNo: nil, text: "a  b", wsOnly: true)
        #expect(ReviewSpeech.line(ws) == "Removed line 8: a  b, Only whitespace changed")
        // A context line is never "whitespace only" (the flag belongs to a changed pair).
        #expect(!ReviewSpeech.line(DiffLine(id: 3, kind: .context, oldNo: 9, newNo: 9, text: "x", wsOnly: true)).contains("whitespace"))
        // A line the row cuts at the render limit is read as drawn, not the 100 000 characters of a minified file.
        let long = String(repeating: "x", count: 100_000)
        #expect(ReviewSpeech.line(DiffLine(id: 4, kind: .add, oldNo: nil, newNo: 1, text: long)).count < DiffLineText.renderLimit + 40)
        // A revealed context line without numbers still says its kind.
        #expect(ReviewSpeech.linePrefix(DiffLine(id: -5, kind: .context, oldNo: nil, newNo: nil, text: "")) == "Unchanged line:")
    }

    @Test func aChangedFileSaysItsStatusStateAndCounts() {
        #expect(ReviewSpeech.status(.modified) == "Modified")
        #expect(ReviewSpeech.status(.added) == "Added")
        #expect(ReviewSpeech.status(.deleted) == "Deleted")
        #expect(ReviewSpeech.status(.renamed) == "Renamed")
        #expect(ReviewSpeech.status(.other) == "Other change")
        #expect(ReviewSpeech.state(.pending) == "Pending review")
        #expect(ReviewSpeech.state(.accepted) == "Accepted")
        #expect(ReviewSpeech.state(.rejected) == "Rejected")
        #expect(ReviewSpeech.state(.changesRequested) == "Changes requested")
        #expect(ReviewSpeech.counts(added: 12, deleted: 3) == "12 lines added, 3 removed")
    }

    /// Every word above has its Korean in the Core catalog (Electron's ko.json is generated from it).
    @Test func theWordsAreInTheCatalog() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ReviewGateCore/Resources/Localizable.xcstrings")
        let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let strings = try #require(doc?["strings"] as? [String: Any])
        for key in ["Modified", "Added", "Deleted", "Renamed", "Other change", "Pending review", "%lld lines added, %lld removed",
                    "Added line %lld:", "Added line:", "Removed line %lld:", "Removed line:", "Unchanged line %lld:", "Unchanged line:",
                    "Changed part:", "(blank line)", "Only whitespace changed"] {
            let entry = strings[key] as? [String: Any]
            let ko = ((entry?["localizations"] as? [String: Any])?["ko"] as? [String: Any])?["stringUnit"] as? [String: Any]
            #expect((ko?["value"] as? String)?.isEmpty == false, "no Korean for \(key)")
        }
    }
}
