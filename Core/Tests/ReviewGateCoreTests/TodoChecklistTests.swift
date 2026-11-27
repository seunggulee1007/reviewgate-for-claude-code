import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §71.2 on the Mac: ⌃T / `/todos` — Claude's to-do checklist over the message box.
@Suite @MainActor struct TodoChecklistTests {
    private func session(_ extra: String) throws -> SessionInfo {
        try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false"#.utf8) + Data(extra.utf8) + Data("}".utf8))
    }

    @Test func theSessionState() throws {
        let s = try session(#","todos":[{"text":"Read the code","status":"completed"},{"text":"Fix it","status":"in_progress","activeForm":"Fixing it"},{"text":"Ship","status":"odd"},{"status":"pending"},3]"#)
        #expect(s.todos == [TodoItem(text: "Read the code", status: .completed),
                            TodoItem(text: "Fix it", status: .inProgress, activeForm: "Fixing it"),
                            TodoItem(text: "Ship", status: .pending)])
        #expect(s.todos?[1].shownText == "Fixing it")
        #expect(s.todos?[0].shownText == "Read the code")
        #expect(try session(#","todos":[]"#).todos == [])
        // An older engine sends none: nil (⌃T keeps AppKit's transpose).
        #expect(try session("").todos == nil)
        #expect(try session(#","todos":null"#).todos == nil)
    }

    @Test func fiveAtATimeAroundTheWork() {
        let items = (1...8).map { TodoItem(text: "step \($0)", status: $0 <= 4 ? .completed : $0 == 5 ? .inProgress : .pending) }
        let w = TodoWindow(items)
        #expect(w.items.map(\.text) == ["step 4", "step 5", "step 6", "step 7", "step 8"])
        #expect(w.before == 3 && w.after == 0)
        let start = TodoWindow(items.map { TodoItem(text: $0.text, status: .pending) })
        #expect(start.items.first?.text == "step 1" && start.before == 0 && start.after == 3)
        let done = TodoWindow(items.map { TodoItem(text: $0.text, status: .completed) })
        #expect(done.items.last?.text == "step 8" && done.before == 3)
        let short = TodoWindow(Array(items.prefix(3)))
        #expect(short.items.count == 3 && short.before == 0 && short.after == 0)
    }

    @Test func theWordsAndTheChoice() {
        let items = [TodoItem(text: "a", status: .completed), TodoItem(text: "b", status: .pending)]
        #expect(TodoText.progress(items) == String(localized: "\(1) of \(2) done", bundle: .module))
        #expect(SlashAppCommand.description("todos") == TodoText.description)
        let defaults = UserDefaults(suiteName: "TodoChecklistTests.\(UUID().uuidString)")!
        #expect(AppSettings.todoListShown(defaults: defaults))   // shown until hidden
        AppSettings.setTodoListShown(false, defaults: defaults)
        #expect(!AppSettings.todoListShown(defaults: defaults))
    }

    @Test func theBlockers() {
        let state = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TodoChecklistTests.\(UUID().uuidString)")!)
        #expect(state.todoBlocker == TodoText.olderEngine)   // no state from an engine yet
    }
}
