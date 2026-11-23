import Foundation
import Testing
@testable import ReviewGateCore

/// c-panel (§57.18): the bottom panel's 출력 — a line limit (oldest dropped), the source filter and search, the Bash
/// commands Claude ran, and the window's log lines.
@Suite @MainActor struct OutputLogTests {
    @Test func theLimitDropsTheOldestLines() {
        var log = OutputLog(limit: 3)
        log.append(.reviewGate, "one\ntwo")
        log.append(.claude, "three\r\nfour\n")
        #expect(log.lines.map(\.text) == ["two", "three", "four"])
        log.append(.reviewGate, (1...10).map(String.init).joined(separator: "\n"))
        #expect(log.lines.map(\.text) == ["8", "9", "10"])
        #expect(Set(log.lines.map(\.id)).count == 3)
        #expect(OutputLog().limit == 5_000)
    }

    @Test func theFilterKeepsTheChosenSourcesAndTheSearch() {
        var log = OutputLog()
        log.append(.reviewGate, "[info] engine started")
        log.append(.claude, "$ ./gradlew test\nBUILD SUCCESSFUL")
        log.append(.reviewGate, "[warn] Build cache is cold")
        #expect(log.filtered(sources: [.claude], query: "").map(\.text) == ["$ ./gradlew test", "BUILD SUCCESSFUL"])
        #expect(log.filtered(sources: [.reviewGate, .claude], query: " build ").map(\.text) == ["BUILD SUCCESSFUL", "[warn] Build cache is cold"])
        #expect(log.filtered(sources: [], query: "").isEmpty)
        #expect(OutputLog.text(log.filtered(sources: [.reviewGate], query: "")) == "[info] engine started\n[warn] Build cache is cold")
        log.clear()
        #expect(log.lines.isEmpty)
    }

    @Test func aBashBlockHasItsCommandOutputAndEnding() {
        var log = OutputLog()
        log.appendBash(command: "npm test", output: "1 passed\n", isError: false, truncated: false)
        #expect(log.lines.map(\.text) == ["$ npm test", "1 passed"])
        log.clear()
        log.appendBash(command: "make\nmake install", output: "", isError: true, truncated: true)
        #expect(log.lines.count == 4)
        #expect(log.lines[0].text == "$ make")
        #expect(log.lines[1].text == "  make install")
        #expect(log.lines.allSatisfy { $0.source == .claude })
    }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "OutputLogTests.\(UUID().uuidString)")!)
    }

    @Test func claudesBashCallsAndTheLogReachTheOutput() {
        let app = makeStore()
        app.handle(.toolUse(id: "t1", name: "Bash", input: .object(["command": .string("./mvnw test")]), file: nil))
        app.handle(.toolUse(id: "t2", name: "Read", input: .object(["file_path": .string("/work/acme/a.txt")]), file: "/work/acme/a.txt"))
        app.handle(.toolResult(toolUseId: "t2", isError: false, preview: "file text"))
        app.handle(.toolResult(toolUseId: "t1", isError: false, preview: "Tests run: 3, Failures: 0"))
        // A result whose call this window never saw (a restored row) adds nothing.
        app.handle(.toolResult(toolUseId: "t9", isError: false, preview: "old"))
        app.handle(.log(level: .warn, message: "acme warning"))
        let claude = app.output.filtered(sources: [.claude], query: "").map(\.text)
        #expect(claude == ["$ ./mvnw test", "Tests run: 3, Failures: 0"])
        #expect(app.output.filtered(sources: [.reviewGate], query: "acme warning").count == 1)
        app.clearOutput()
        #expect(app.output.lines.isEmpty)
    }
}
