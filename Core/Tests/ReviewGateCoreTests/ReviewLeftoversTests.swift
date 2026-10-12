import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 on the Mac: the wire (`file_lines`, `file_image`, `select_file
/// {ignoreWhitespace}`, `transcript_search {perChat}` with `more` / `total`) and the client rules — the same cases as
/// Electron's `reviewLeftovers.test.ts` — plus where the review diff's in-line marks land in the full-file view.
@Suite struct ReviewLeftoversTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(command)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func encodesTheCommands() throws {
        let lines = try json(.historyFileLines(entryId: "e1", path: "a.java"))
        #expect(lines["type"] as? String == "history_file_lines" && lines["entryId"] as? String == "e1" && lines["path"] as? String == "a.java")
        let pr = try json(.prFileLines(filename: "src/A.java"))
        #expect(pr["type"] as? String == "pr_file_lines" && pr["filename"] as? String == "src/A.java")
        let image = try json(.fileImage(path: "logo.png"))
        #expect(image["type"] as? String == "file_image" && image["path"] as? String == "logo.png")
        let ws = try json(.selectFileIgnoringWhitespace(path: "a.java", since: .turn))
        #expect(ws["type"] as? String == "select_file" && ws["ignoreWhitespace"] as? Bool == true && ws["since"] as? String == "turn")
        let search = try json(.transcriptSearchPerChat(query: "sql", perChat: 3))
        #expect(search["type"] as? String == "transcript_search" && search["perChat"] as? Int == 3 && search["query"] as? String == "sql")
    }

    @Test func decodesTheReplies() throws {
        let lines = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_lines","id":"r1","scope":"history","path":"a.java","entryId":"e1","lines":["a","b"],"isBinary":false,"isTooLarge":false}"#)
        #expect(lines.replyId == "r1")
        guard case let .fileLines(reply) = lines else { Issue.record("not file_lines: \(lines)"); return }
        #expect(reply == FileLinesReply(id: "r1", scope: "history", path: "a.java", entryId: "e1", lines: ["a", "b"]))
        #expect(ReviewLeftovers.unavailable(reply) == nil)
        #expect(ReviewLeftovers.unavailable(FileLinesReply(scope: "pr", path: "x", lines: [], isTooLarge: true)) != nil)

        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        let image = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_image","id":"i1","path":"logo.png","oldPath":null,"mediaType":"image/png","old":{"size":4,"dataBase64":"\#(png)"},"new":{"size":3000000,"tooLarge":true},"endTree":"b"}"#)
        #expect(image.replyId == "i1")
        guard case let .fileImage(img) = image else { Issue.record("not file_image: \(image)"); return }
        #expect(img.old == FileImageSide(size: 4, data: Data([0x89, 0x50, 0x4E, 0x47])))
        #expect(img.new == FileImageSide(size: 3_000_000, data: nil, tooLarge: true))
        let added = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_image","path":"n.gif","oldPath":null,"mediaType":"image/gif","old":null,"new":{"size":1,"dataBase64":"AA=="}}"#)
        guard case let .fileImage(addedImg) = added else { Issue.record("not file_image"); return }
        #expect(addedImg.old == nil && addedImg.new?.data == Data([0]))

        let diff = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_diff","scope":"turn","path":"ws.java","truncated":false,"endTree":"b","baseTree":"a","ignoreWhitespace":true,"diff":{"oldPath":"ws.java","newPath":"ws.java","isBinary":false,"hunks":[]}}"#)
        guard case let .fileDiff(_, _, _, _, _, _, info) = diff else { Issue.record("not file_diff"); return }
        #expect(info.ignoreWhitespace)
        let plain = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_diff","scope":"turn","path":"ws.java","truncated":false,"diff":{"oldPath":"ws.java","newPath":"ws.java","isBinary":false,"hunks":[]}}"#)
        guard case let .fileDiff(_, _, _, _, _, _, plainInfo) = plain else { Issue.record("not file_diff"); return }
        #expect(!plainInfo.ignoreWhitespace)
    }

    @Test func chatSearchShowsThreeLinesAndCountsTheRest() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_search","query":"sql","matches":[{"sessionId":"s","title":"chat","row":9,"turn":5,"at":"t9","kind":"assistant_text","line":"newest","total":7,"more":[{"row":7,"turn":4,"at":"t7","kind":"user_message","line":"older"},{"bad":true},{"row":3,"turn":2,"at":"t3","kind":"assistant_text","line":"oldest shown"}]}]}"#)
        guard case let .transcriptSearch(reply) = event, let match = reply.matches.first else { Issue.record("not a search"); return }
        let (hits, more) = ReviewLeftovers.matchHits(match)
        #expect(hits.map(\.line) == ["newest", "older", "oldest shown"])
        #expect(hits[1].isUser && hits[1].row == 7)
        #expect(more == 4)
        // An engine before §41.3: one line, nothing counted.
        let old = TranscriptSearchMatch(sessionId: "s", row: 9, turn: 5, at: "t9", line: "newest")
        #expect(ReviewLeftovers.matchHits(old).hits.count == 1 && ReviewLeftovers.matchHits(old).more == 0)
        var small = match
        small.total = 1
        #expect(ReviewLeftovers.matchHits(small).more == 0)
    }

    @Test func clientRules() {
        #expect([ReviewLeftovers.historyOffersContext(status: .modified, isBinary: false), ReviewLeftovers.historyOffersContext(status: .renamed, isBinary: false),
                 ReviewLeftovers.historyOffersContext(status: .added, isBinary: false), ReviewLeftovers.historyOffersContext(status: .deleted, isBinary: false),
                 ReviewLeftovers.historyOffersContext(status: .modified, isBinary: true)] == [true, true, false, false, false])
        #expect(["modified", "renamed", "changed", "added", "removed"].map { ReviewLeftovers.prOffersContext(status: $0, isBinary: false) } == [true, true, true, false, false])
        #expect(!ReviewLeftovers.prOffersContext(status: "modified", isBinary: true))
        #expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg", "f.webp"].map(ReviewLeftovers.isPreviewImage) == [true, true, true, true, false, false])
        #expect(ReviewLeftovers.whitespaceEmptyText(whitespaceOnly: true) != ReviewLeftovers.whitespaceEmptyText(whitespaceOnly: false))
    }

    @Test func groupsByCause() throws {
        let index = TranscriptIndex([
            .toolUse(id: UUID(), toolUseId: "b1", name: "Bash", file: nil, input: .object(["command": .string("./gradlew spotlessApply\n  --info")])),
            .toolUse(id: UUID(), toolUseId: "a1", name: "Agent", file: nil, input: .object(["subagent_type": .string("executor"), "description": .string("fix")])),
            .toolUse(id: UUID(), toolUseId: "e2", name: "Edit", file: nil, input: .object([:]), info: ToolUseInfo(parentToolUseId: "a1")),
        ])
        func file(_ path: String, origin: FileOrigin, ids: [String], turn: Int? = nil) throws -> ChangedFile {
            let why = turn.map { #","why":{"text":"x","source":"same_message","turn":\#($0)}"# } ?? ""
            let json = #"{"path":"\#(path)","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"tools":[],"toolUseIds":\#(ids),"state":"pending","noteCount":0,"origin":"\#(origin.rawValue)"\#(why)}"#
            return try JSONDecoder().decode(ChangedFile.self, from: Data(json.utf8))
        }
        let byAgent = try file("a.java", origin: .tool, ids: ["e2"])
        let byBash = try file("b.java", origin: .bash, ids: ["b1"])
        let byTurn = try file("c.java", origin: .tool, ids: ["e9"], turn: 3)
        let unknownBash = try file("d.java", origin: .bash, ids: ["gone"])
        #expect(ReviewLeftovers.fileCause(byAgent, index: index).hasPrefix("◆ "))
        #expect(ReviewLeftovers.fileCause(byBash, index: index) == "Bash · ./gradlew spotlessApply")
        #expect(ReviewLeftovers.fileCause(unknownBash, index: index) == "Bash")
        #expect(ReviewLeftovers.fileCause(byTurn, index: index) != ReviewLeftovers.fileCause(try file("e.java", origin: .tool, ids: []), index: index))
        #expect(ReviewLeftovers.shortCommand("echo \(String(repeating: "x", count: 80))") == "echo \(String(repeating: "x", count: 55))…")
        let causes = ["a": "Turn 2", "b": "◆ executor", "c": "Turn 2"]
        let sections = FileGroups.group(["a", "b", "c"], by: .cause, path: { $0 }, cause: { causes[$0] ?? "" })
        #expect(sections.map(\.key) == ["Turn 2", "◆ executor"])
        #expect(sections.map(\.files) == [["a", "c"], ["b"]])
        #expect(FileGroups.group(["a", "b"], by: .cause, path: { $0 }).count == 1)   // no causes known: one section
        #expect(FileGroupBy.allCases.contains(.cause))
    }

    @Test func fullFileMarksFollowTheDiffsSegments() {
        // Line 2 replaced (segments on both sides), a deletion after line 4, an insertion at 6 without a pair.
        let hunk = DiffHunk(id: 0, header: "@@ -1,6 +1,6 @@", lines: [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1,6 +1,6 @@"),
            DiffLine(id: 1, kind: .context, oldNo: 1, newNo: 1, text: "a"),
            DiffLine(id: 2, kind: .del, oldNo: 2, newNo: nil, text: "int b = 1;", segments: [DiffSegment(start: 8, end: 9)]),
            DiffLine(id: 3, kind: .add, oldNo: nil, newNo: 2, text: "int b = 2;", segments: [DiffSegment(start: 8, end: 9)]),
            DiffLine(id: 4, kind: .context, oldNo: 3, newNo: 3, text: "c"),
            DiffLine(id: 5, kind: .context, oldNo: 4, newNo: 4, text: "d"),
            DiffLine(id: 6, kind: .del, oldNo: 5, newNo: nil, text: "gone"),
            DiffLine(id: 7, kind: .context, oldNo: 6, newNo: 5, text: "e"),
            DiffLine(id: 8, kind: .add, oldNo: nil, newNo: 6, text: "new"),
        ])
        let marks = FullFileEmphasis(diff: FileDiff(oldPath: "a", newPath: "a", isBinary: false, hunks: [hunk]))
        #expect(marks.added[2]?.segments == [DiffSegment(start: 8, end: 9)])
        #expect(marks.added[6] == nil)   // an unpaired line: the row's tint says it all
        #expect(marks.deletedLine(anchor: 1, offset: 0)?.text == "int b = 1;")
        #expect(marks.deletedLine(anchor: 4, offset: 0) == nil)   // deleted without segments
        #expect(marks.deleted[4]?.first?.text == "gone")
        // A row whose text is no longer the diff's (an edit on disk) is drawn plain.
        let line = marks.added[2]!.line(id: 2, kind: .add, newNo: 2, text: "int b = 3;")
        #expect(line.segments.isEmpty)
        #expect(marks.added[2]!.line(id: 2, kind: .add, newNo: 2, text: "int b = 2;").segments == [DiffSegment(start: 8, end: 9)])
    }
}
