import Foundation
import Testing
@testable import ReviewGateCore

/// polish p-foundation — P3-transcript-25: a chat row's time lives in a side table by row id (`RowClock`) — stamped when a
/// row arrives live, and with the record's `at` when it comes back from the chat's record or is viewed read-only.
@Suite(.serialized) @MainActor struct RowClockTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "RowClockTests.\(UUID().uuidString)")!)
    }

    private let usage = Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10)

    @Test func liveRowsAreStampedWhenTheyArrive() {
        let app = makeState()
        let before = Date()
        app.handle(.userMessage(text: "fix the mapper", turn: 1))
        app.handle(.textDelta(text: "Done."))
        app.handle(.turnEnd(stopReason: "end_turn", usage: usage, files: 1, added: 2, deleted: 0))
        let after = Date()
        #expect(app.transcript.count == 3)
        for row in app.transcript {
            guard let at = RowClock.time(of: row.id) else { Issue.record("row without a time: \(row)"); continue }
            #expect(at >= before && at <= after)
        }
    }

    @Test func restoredRowsKeepTheRecordsTime() throws {
        let app = makeState()
        app.handle(.transcriptRestore(items: [
            TranscriptItem(at: "2026-11-05T06:42:10.500Z", turn: 1, kind: .userMessage(text: "yesterday's question")),
            TranscriptItem(at: "2026-11-05T06:43:00Z", turn: 1, kind: .assistantText(text: "the answer")),
            TranscriptItem(at: "not a time", turn: 1, kind: .turnEnd(stopReason: "end_turn", usage: usage, files: 0, added: 0, deleted: 0,
                                                                    changedOutside: [])),
        ]))
        #expect(app.transcript.count == 3)
        let asked = try #require(RowClock.time(of: app.transcript[0].id))
        #expect(abs(asked.timeIntervalSince1970 - 1_793_860_930.5) < 0.001)
        let answered = try #require(RowClock.time(of: app.transcript[1].id))
        #expect(answered.timeIntervalSince1970 == 1_793_860_980)
        // A time that does not read leaves the row without one.
        #expect(RowClock.time(of: app.transcript[2].id) == nil)
    }

    @Test func aChatViewedReadOnlyHasItsRecordsTimes() throws {
        let app = makeState()
        let rows = app.viewedChatRows([TranscriptItem(at: "2026-11-04T23:59:59Z", turn: 3, kind: .userMessage(text: "what changed?"))])
        let row = try #require(rows.first)
        #expect(RowClock.time(of: row.id)?.timeIntervalSince1970 == 1_793_836_799)
    }

    @Test func aRowMadeElsewhereHasNoTime() {
        #expect(RowClock.time(of: UUID()) == nil)
    }

    @Test func theTableKeepsTheNewestTwoGenerations() {
        let size = RowClock.generationSize
        defer { RowClock.generationSize = size }
        RowClock.reset()
        RowClock.generationSize = 2
        let ids = (0..<5).map { RowClock.newID(at: Date(timeIntervalSince1970: TimeInterval($0))) }
        // [0, 1] went first, [2, 3] is the previous generation, [4] the current one.
        #expect(RowClock.time(of: ids[0]) == nil && RowClock.time(of: ids[1]) == nil)
        #expect(RowClock.time(of: ids[2])?.timeIntervalSince1970 == 2)
        #expect(RowClock.time(of: ids[4])?.timeIntervalSince1970 == 4)
        // Stamping a row again keeps one entry.
        RowClock.stamp(ids[4], at: Date(timeIntervalSince1970: 40))
        #expect(RowClock.time(of: ids[4])?.timeIntervalSince1970 == 40)
    }
}
