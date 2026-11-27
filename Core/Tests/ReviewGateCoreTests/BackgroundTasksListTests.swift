import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §71.3 on the Mac: `/tasks` (`/bashes`) — the background work with the end of each task's output.
@Suite struct BackgroundTasksListTests {
    @Test func theOutputsTail() {
        #expect(BackgroundText.tail("one\ntwo\n\nthree\nfour\n") == ["two", "three", "four"])
        #expect(BackgroundText.tail("\u{1B}[32mready\u{1B}[0m in 120 ms\n") == ["ready in 120 ms"])
        #expect(BackgroundText.tail("progress 10%\rprogress 50%\rprogress 100%\n") == ["progress 100%"])
        #expect(BackgroundText.tail("a\r\nb\r\n") == ["a", "b"])
        #expect(BackgroundText.tail("   \n\n") == [])
        #expect(BackgroundText.tail(String(repeating: "x", count: 500)).first?.count == 240)
        #expect(BackgroundText.tail("1\n2\n3\n4\n5", lines: 2) == ["4", "5"])
    }

    @Test func theCommand() {
        #expect(SlashAppCommand.parse("/tasks", entries: []) == .tasks)
        #expect(SlashAppCommand.parse("/bashes", entries: []) == .tasks)
        #expect(SlashAppCommand.description("bashes") == BackgroundText.tasksDescription)
        #expect(!SlashAppCommand.terminalOnly.contains("tasks"))
    }
}
