import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 on the Mac: the wire (restore with start, page, search, a summary row,
/// history why / commit), restored summary cards, [이전 대화 더 보기] (rows above, ids per row), the search jump and the
/// review history filter.
@Suite @MainActor struct TranscriptHistoryTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "TranscriptHistoryTests.\(UUID().uuidString)")! }
    private func makeState() -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults()) }

    private let summaryRow = #"{"at":"2026-10-22T10:00:02.000Z","turn":2,"kind":"turn_summary","files":[{"path":"a.ts","status":"M","state":"pending","adds":2,"dels":1,"why":"Fix the parser.","whyToolUseId":"e1","tools":["Edit"],"toolUseIds":["e1"]}],"commands":[],"plan":null,"review":{"files":1,"added":2,"deleted":1}}"#

    @Test func decodesTheWire() throws {
        let restore = try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_restore","start":40,"sessionId":"chat-1","items":[{"at":"t1","turn":1,"kind":"user_message","text":"hi"},\#(summaryRow),{"at":"t3","turn":2,"kind":"turn_summary","files":"junk"}]}"#)
        guard case let .transcriptRestorePaged(items, paging) = restore else { Issue.record("not a paged restore: \(restore)"); return }
        #expect(paging == TranscriptRestorePaging(start: 40, sessionId: "chat-1"))
        #expect(items.count == 3)
        guard case let .turnSummary(summary) = items[1].kind else { Issue.record("not a summary row"); return }
        #expect(summary.turn == 2 && summary.files.map(\.path) == ["a.ts"] && summary.files[0].why == "Fix the parser.")
        #expect(items[2].kind == .other(kind: "turn_summary"))   // a row that does not read stays a row nobody shows
        // An older engine (no start) and an empty chat: the event as before.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_restore","items":[{"at":"t","turn":1,"kind":"user_message","text":"x"}]}"#)
            == .transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "x"))]))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_restore","items":[]}"#) == .transcriptRestore(items: []))

        let page = try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_page","id":"p1","sessionId":"chat-1","start":0,"before":40,"items":[{"at":"t0","turn":1,"kind":"assistant_text","text":"older"}]}"#)
        #expect(page.replyId == "p1")
        guard case let .transcriptPage(reply) = page else { Issue.record("not a page"); return }
        #expect(reply.sessionId == "chat-1" && reply.start == 0 && reply.before == 40 && reply.items.count == 1)

        let search = try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_search","id":"s1","query":"sql","matches":[{"sessionId":"a","title":"T","row":7,"turn":3,"at":"t","kind":"user_message","line":"the SQL"},{"bad":1}]}"#)
        #expect(search.replyId == "s1")
        guard case let .transcriptSearch(found) = search else { Issue.record("not a search"); return }
        #expect(found.matches == [TranscriptSearchMatch(sessionId: "a", title: "T", row: 7, turn: 3, at: "t", isUser: true, line: "the SQL")])

        let diff = try NDJSON.decode(EngineEvent.self, from: #"{"type":"history_diff","id":"d1","entryId":"e","path":"a.ts","truncated":false,"diff":{"oldPath":"a.ts","newPath":"a.ts","isBinary":false,"hunks":[]},"why":{"text":"Fix the parser.","source":"same_message","toolUseId":"e1","turn":2}}"#)
        guard case let .historyDiff(_, _, _, _, _, why) = diff else { Issue.record("not history_diff"); return }
        #expect(why?.text == "Fix the parser." && why?.toolUseId == "e1")

        let file = try JSONDecoder().decode(ReviewHistoryFile.self, from: Data(#"{"path":"b.ts","verdict":"accepted","committed":true,"commit":{"sha":"abc","subject":"fix: tenant key"}}"#.utf8))
        #expect(file.commit == HistoryCommit(sha: "abc", subject: "fix: tenant key"))
        #expect(try JSONDecoder().decode(ReviewHistoryFile.self, from: Data(#"{"path":"b.ts","verdict":"accepted"}"#.utf8)).commit == nil)

        let cmd = String(decoding: try JSONEncoder().encode(EngineCommandEnvelope(id: "c", command: .transcriptPage(sessionId: "chat-1", before: 40, beforeAt: "t1", limit: 200))), as: UTF8.self)
        #expect(cmd.contains(#""type":"transcript_page""#) && cmd.contains(#""before":40"#) && cmd.contains(#""beforeAt":"t1""#) && cmd.contains(#""limit":200"#))
        let q = String(decoding: try JSONEncoder().encode(EngineCommandEnvelope(id: "c", command: .transcriptSearch(query: "sql"))), as: UTF8.self)
        #expect(q.contains(#""type":"transcript_search""#) && q.contains(#""query":"sql""#))
    }

    @Test func restoredSummaryRowIsTheCardAgain() throws {
        let app = makeState()
        let row = try JSONDecoder().decode(TranscriptItem.self, from: Data(summaryRow.utf8))
        let empty = TranscriptItem(at: "t", turn: 3, kind: .turnSummary(TurnSummary(turn: 3, files: [], commands: [], plan: nil)))
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 2, kind: .userMessage(text: "fix")), row, empty]))
        #expect(app.transcript.count == 2)
        guard case let .turnSummary(_, summary) = app.transcript[1] else { Issue.record("no card"); return }
        #expect(summary.files.first?.why == "Fix the parser.")
        #expect(app.transcriptPaging == TranscriptPaging())   // an older engine: nothing to page
    }

    @Test func earlierMessagesGoAboveAndKeepTheirRows() async {
        let app = makeState()
        app.handle(.transcriptRestorePaged(items: [TranscriptItem(at: "t10", turn: 5, kind: .userMessage(text: "ten")),
                                                  TranscriptItem(at: "t11", turn: 5, kind: .assistantText(text: "eleven"))],
                                          paging: TranscriptRestorePaging(start: 10, sessionId: "chat-1")))
        #expect(app.transcriptPaging.canLoadEarlier && app.transcriptPaging.oldestAt == "t10")
        #expect(app.transcriptPaging.rowIDs[11] == app.transcript[1].id)
        var sent: [EngineCommand] = []
        app.replySink = { command in
            sent.append(command)
            return .transcriptPage(TranscriptPageReply(sessionId: "chat-1", items: [TranscriptItem(at: "t8", turn: 4, kind: .userMessage(text: "eight")),
                                                                                    TranscriptItem(at: "t9", turn: 4, kind: .assistantText(text: "nine"))],
                                                       start: 8, before: 10))
        }
        #expect(await app.loadEarlierMessages())
        #expect(sent == [.transcriptPage(sessionId: "chat-1", before: 10, beforeAt: "t10", limit: 200)])
        let texts = app.transcript.map { item -> String in
            switch item {
            case let .user(_, text, _), let .assistant(_, text, _, _): text
            default: "?"
            }
        }
        #expect(texts == ["eight", "nine", "ten", "eleven"])
        #expect(app.restoredTranscriptIDs.contains(app.transcript[0].id))   // dimmed like the restored rows
        #expect(app.transcriptPaging.start == 8 && app.transcriptPaging.oldestAt == "t8" && app.transcriptPaging.prepended == 2)
        #expect(app.transcriptPaging.rowIDs[8] == app.transcript[0].id && app.transcriptPaging.rowIDs[11] == app.transcript[3].id)

        // A refusal says so on one line; an engine before §38.3 says it cannot.
        app.replySink = { _ in throw EngineClientError.refused("unknown command: transcript_page", code: "unknown_command") }
        #expect(!(await app.loadEarlierMessages()))
        #expect(app.transcriptPaging.error == String(localized: "This engine cannot load earlier messages", bundle: .module))
    }

    @Test func aJumpLandsOnItsRowOrLoadsTheRowsAboveFirst() async throws {
        let app = makeState()
        app.jumpToMessage(sessionId: "chat-2", row: 1)
        #expect(app.transcriptJump != nil)   // the other chat is not shown yet: wait for its rows
        app.handle(.transcriptRestorePaged(items: [TranscriptItem(at: "a", turn: 1, kind: .userMessage(text: "a")),
                                                  TranscriptItem(at: "b", turn: 1, kind: .assistantText(text: "b"))],
                                          paging: TranscriptRestorePaging(start: 0, sessionId: "chat-2")))
        #expect(app.transcriptJump == nil && app.transcriptJumpItem?.id == app.transcript[1].id)

        var paging = TranscriptPaging(sessionId: "c", start: 300)
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "c", row: 40), paging: paging) == .load(261))
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "c", row: 299), paging: paging) == .load(200))
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "other", row: 1), paging: paging) == .wait)
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "c", row: 350), paging: paging) == .done)
        paging.sessionId = nil   // a chat with nothing to page is shown: wait (the jump's chat may come next) …
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "c", row: 1), paging: paging) == .wait)
        // … but not for ever.
        #expect(TranscriptHistory.step(TranscriptJump(sessionId: "c", row: 1, at: Date(timeIntervalSinceNow: -60)), paging: paging) == .done)
    }

    @Test func reviewHistoryFilter() {
        func file(_ path: String, commit: HistoryCommit? = nil) -> ReviewHistoryFile {
            var f = ReviewHistoryFile(path: path, verdict: .accepted, committed: commit != nil)
            f.commit = commit
            return f
        }
        let entries = [
            ReviewHistoryEntry(id: "1", prompt: "invoiceMapper.xml 고쳐줘", files: [file("api/invoiceMapper.xml")]),
            ReviewHistoryEntry(id: "2", files: [file("b.ts", commit: HistoryCommit(sha: "abc", subject: "fix: tenant key"))]),
            ReviewHistoryEntry(id: "3", files: [file("c.ts")], notes: [ReviewHistoryNote(path: "c.ts", line: 3, body: "null 체크 빠짐")]),
        ]
        #expect(TranscriptHistory.filter(entries, query: "MAPPER").map(\.id) == ["1"])
        #expect(TranscriptHistory.filter(entries, query: "tenant").map(\.id) == ["2"])
        #expect(TranscriptHistory.filter(entries, query: " null 체크 ").map(\.id) == ["3"])
        #expect(TranscriptHistory.filter(entries, query: "").map(\.id) == ["1", "2", "3"])
    }
}
