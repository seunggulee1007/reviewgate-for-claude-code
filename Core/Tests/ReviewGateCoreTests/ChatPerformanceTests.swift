import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: what a streamed delta, an appended row and a ⌘F keystroke cost the chat's
/// model on a transcript of 200 and of 2 000 rows with large tool inputs (40 KB Writes, 3 KB Edits, agent groups). Thread
/// CPU time, best of three. The same scenario on the base (0.4.1, debug, M-series, the Mac busy): a delta 15.4 µs at 200
/// rows and 115.4 µs at 2 000 (the transcript copied per delta), an appended row 1 086 / 8 552 µs (tree, fold, index and
/// positions rebuilt), a ⌘F keystroke 271 570 µs (every tool input encoded again). The bounds are generous (a loaded
/// machine must not fail them); a per-row term in the delta path, or a rebuild per appended row, still does.
@Suite @MainActor struct ChatPerformanceTests {
    static func threadCPU() -> Double {
        var ts = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts)
        return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9
    }

    /// The best (lowest) thread-CPU seconds of three runs of `body` (each on a fresh state from `make`).
    static func best<T>(_ make: () -> T, _ body: (T) -> Void) -> Double {
        var best = Double.infinity
        for _ in 0..<3 {
            let state = make()
            let start = threadCPU()
            body(state)
            best = min(best, threadCPU() - start)
        }
        return best
    }

    private static func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ChatPerf.\(UUID().uuidString)")!)
    }

    static let bigContent = String(repeating: "final List<SettlementSummaryDto> summaries = repository.findAll(); // 주문\n", count: 500)
    static let editOld = String(repeating: "    int count = service.countByCart(cartId);\n", count: 60)
    static let editNew = String(repeating: "    long count = service.countByCartId(cartId);\n", count: 60)

    /// About `rows` transcript rows: turns of a prompt, an answer, explore calls, edits with large inputs, a Write of 40 KB,
    /// an agent group with nested calls, and a turn end.
    static func filled(rows: Int) -> AppState {
        let app = makeState()
        var turn = 0
        var call = 0
        func use(_ name: String, _ input: JSONValue, file: String? = nil, parent: String? = nil, explore: Bool = false) {
            call += 1
            var info = ToolUseInfo(parentToolUseId: parent)
            info.explore = explore
            let id = "t\(call)"
            app.handle(.toolUse(id: id, name: name, input: input, file: file, info: info))
            app.handle(.toolResult(toolUseId: id, isError: false, preview: "ok \(call)", info: ToolResultInfo(parentToolUseId: parent)))
        }
        while app.transcript.count < rows {
            turn += 1
            app.handle(.userMessage(text: "Fix the settlement summary, step \(turn)", turn: turn))
            app.handle(.textDelta(text: "I will read the files first and then change the service."))
            use("Read", .object(["file_path": .string("/repo/src/A\(turn).java")]), file: "/repo/src/A\(turn).java", explore: true)
            use("Grep", .object(["pattern": .string("countByCart")]), explore: true)
            use("Edit", .object(["file_path": .string("/repo/src/S\(turn).java"), "old_string": .string(editOld), "new_string": .string(editNew)]),
                file: "/repo/src/S\(turn).java")
            use("Write", .object(["file_path": .string("/repo/src/W\(turn).java"), "content": .string(bigContent)]), file: "/repo/src/W\(turn).java")
            use("Bash", .object(["command": .string("./gradlew test --tests SettlementTest")]))
            if turn % 3 == 0 {
                call += 1
                let agent = "t\(call)"
                app.handle(.toolUse(id: agent, name: "Agent", input: .object(["subagent_type": .string("executor"), "description": .string("check"),
                                                                              "prompt": .string(editOld)]), file: nil))
                for _ in 0..<6 { use("Read", .object(["file_path": .string("/repo/src/B\(call).java")]), file: "/repo/src/B\(call).java", parent: agent) }
                app.handle(.toolResult(toolUseId: agent, isError: false, preview: "## Result\nAll good.", info: ToolResultInfo()))
            }
            app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 10, outputTokens: 10, costUsd: 0.01, durationMs: 1000),
                                files: 2, added: 10, deleted: 4))
        }
        _ = app.transcriptModel   // the chat has drawn it once
        return app
    }

    /// 500 deltas, µs each: the event, the view's hold on the transcript (as the chat's context had), and every 8 deltas
    /// (a frame) the burst told and the streaming row's text read.
    private func perDelta(rows: Int) -> Double {
        Self.best({ () -> AppState in
            let app = Self.filled(rows: rows)
            app.handle(.userMessage(text: "go", turn: 999))
            app.handle(.textDelta(text: "Start. "))
            return app
        }) { app in
            var held = app.transcript
            var shown = 0
            for i in 0..<500 {
                app.handle(.textDelta(text: "token \(i) of the answer, "))
                held = app.transcript
                if i % 8 == 7 {
                    app.publishLiveText()
                    shown += app.liveText.text.count
                }
            }
            #expect(held.count == app.transcript.count && shown > 0)
        } / 500 * 1e6
    }

    /// 100 appended rows, µs each: the event and the shared model brought up to date (the chat's tree, runs, index and
    /// positions), the view holding the entries it drew (as `ForEach` does).
    private func perAppendedRow(rows: Int) -> Double {
        Self.best({ Self.filled(rows: rows) }) { app in
            var held = app.transcriptModel.entries
            for i in 0..<50 {
                let id = "late\(i)"
                app.handle(.toolUse(id: id, name: "Edit", input: .object(["file_path": .string("/repo/x.java"), "old_string": .string(Self.editOld),
                                                                           "new_string": .string(Self.editNew)]), file: "/repo/x.java"))
                held = app.transcriptModel.entries
                app.handle(.toolResult(toolUseId: id, isError: false, preview: "ok"))
                held = app.transcriptModel.entries
            }
            #expect(!held.isEmpty && app.transcriptModel.rebuilds == 1)
        } / 100 * 1e6
    }

    /// One ⌘F keystroke over the rows (as the chat searches them: the row as it is now, a tool call's JSON kept), µs.
    private func perFindKeystroke(rows: Int) -> Double {
        Self.best({ Self.filled(rows: rows) }) { app in
            let lookups = app.liveLookups
            let nodes = lookups.model.nodes
            var hits = 0
            for q in ["c", "co", "cou", "coun", "count"] { hits += TranscriptSearch.matches(q, in: nodes) { lookups.searchText($0) }.count }
            #expect(hits > 0)
        } / 5 * 1e6
    }

    @Test func aDeltaDoesNotGrowWithTheRows() {
        let small = perDelta(rows: 200)
        let large = perDelta(rows: 2_000)
        print("BENCH wave7: per delta \(String(format: "%.1f", small)) µs at 200 rows, \(String(format: "%.1f", large)) µs at 2000 rows")
        #expect(large < max(small * 3, 15), "per delta: \(small) µs at 200 rows, \(large) µs at 2000 rows")
    }

    @Test func anAppendedRowIsPlacedNotRebuilt() {
        let small = perAppendedRow(rows: 200)
        let large = perAppendedRow(rows: 2_000)
        print("BENCH wave7: per appended row \(String(format: "%.1f", small)) µs at 200 rows, \(String(format: "%.1f", large)) µs at 2000 rows")
        #expect(large < 1_000, "per appended row: \(small) µs at 200 rows, \(large) µs at 2000 rows")
    }

    /// The JSON of each call is worked out on the first keystroke and kept: a later one only searches. (Searching itself —
    /// case- and diacritic-insensitive, as before — still reads every row's text: a query absent from a 40 KB Write scans
    /// all of it, which is most of the 5-keystroke figure.)
    @Test func findKeepsEachCallsText() {
        let find = perFindKeystroke(rows: 2_000)
        let app = Self.filled(rows: 2_000)
        let lookups = app.liveLookups
        let nodes = lookups.model.nodes
        var hits: [[UUID]] = []
        let first = Self.best({ () }) { _ in
            lookups.dropSearchTexts()
            hits.append(TranscriptSearch.matches("co", in: nodes) { lookups.searchText($0) })
        }
        let next = Self.best({ () }) { _ in hits.append(TranscriptSearch.matches("co", in: nodes) { lookups.searchText($0) }) }
        let before = Self.best({ () }) { _ in hits.append(TranscriptSearch.matches("co", in: nodes)) }
        print("BENCH wave7: find per keystroke \(String(format: "%.0f", find)) µs at 2000 rows (5 keystrokes); \"co\": "
              + "first \(String(format: "%.0f", first * 1e6)) µs, next \(String(format: "%.0f", next * 1e6)) µs, "
              + "JSON encoded per keystroke as before \(String(format: "%.0f", before * 1e6)) µs")
        #expect(Set(hits.map { $0 }).count == 1, "the same matches either way")
        #expect(next < before, "a kept call's JSON is not encoded again: next \(next) s, before \(before) s")
    }
}
