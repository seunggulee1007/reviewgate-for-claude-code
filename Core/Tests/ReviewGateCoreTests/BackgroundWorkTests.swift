import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §52 on the Swift side: `state.session.backgroundTasks`, `task_stop` / `task_background` / `task_output`
/// on the wire and their refusals in the user's words, the `auto_turn` event and row (live and restored), the setting.
@MainActor
@Suite struct BackgroundWorkTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeStore(_ defaults: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults ?? UserDefaults(suiteName: "BackgroundWorkTests.\(UUID().uuidString)")!)
    }

    @Test func theSessionsBackgroundTasksDecodeLeniently() throws {
        let line = #"{"open":true,"starting":false,"backgroundTasks":[{"taskId":"b1","kind":"bash","description":"npm run dev","toolUseId":"toolu_1","turn":3,"startedAt":"2026-11-05T04:00:00.000Z","hasOutput":true},{"taskId":"m1","kind":"stream","description":"watch"},{"kind":"bash"}]}"#
        let session = try NDJSON.decode(SessionInfo.self, from: line)
        #expect(session.backgroundTasks == [
            BackgroundTaskInfo(taskId: "b1", kind: .bash, description: "npm run dev", toolUseId: "toolu_1", turn: 3, startedAt: "2026-11-05T04:00:00.000Z", hasOutput: true),
            BackgroundTaskInfo(taskId: "m1", kind: .other, description: "watch"),
        ])
        #expect(session.backgroundTasks.first?.startedDate != nil)
        #expect(try NDJSON.decode(SessionInfo.self, from: #"{"open":true,"starting":false}"#).backgroundTasks.isEmpty)
    }

    @Test func theCommandsOnTheWire() throws {
        #expect(try json(.taskStop(taskId: "b1")) as NSDictionary == ["type": "task_stop", "taskId": "b1"] as NSDictionary)
        #expect(try json(.taskOutput(taskId: "b1")) as NSDictionary == ["type": "task_output", "taskId": "b1"] as NSDictionary)
        #expect(try json(.taskBackground(toolUseId: "toolu_9")) as NSDictionary == ["type": "task_background", "toolUseId": "toolu_9"] as NSDictionary)
        #expect(try json(.taskBackground(toolUseId: nil)) as NSDictionary == ["type": "task_background"] as NSDictionary)
    }

    @Test func repliesAndRefusals() async {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            if case .taskOutput = command { return .taskOutput(TaskOutputReply(taskId: "b1", text: "ready on :3000\n", truncated: false, running: true)) }
            return .taskBackground(TaskBackgroundReply(moved: true))
        }
        #expect(await store.backgroundTaskOutput("b1") == .success(TaskOutputReply(taskId: "b1", text: "ready on :3000\n", truncated: false, running: true)))
        #expect(await store.moveToBackground(toolUseId: "toolu_9") == .success(true))
        store.replySink = { _ in throw EngineClientError.refused("background_off", code: "background_off") }
        guard case let .failure(off) = await store.moveToBackground() else { Issue.record("not a failure"); return }
        #expect(off.text == BackgroundText.refusal(EngineClientError.refused("background_off", code: "background_off")))
        #expect(!off.text.contains("background_off"))
        store.replySink = { _ in throw EngineClientError.refused("no_output", code: "no_output") }
        guard case let .failure(none) = await store.backgroundTaskOutput("b1") else { Issue.record("not a failure"); return }
        #expect(!none.text.contains("no_output"))
        #expect(sent.count == 2)
    }

    @Test func theAutoTurnEventAndRowLiveAndRestored() throws {
        guard case let .autoTurn(turn, info) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"auto_turn","turn":4,"trigger":"background","task":{"taskId":"b1","description":"npm run build","status":"completed","summary":"done"}}"#) else {
            Issue.record("not autoTurn"); return
        }
        #expect(turn == 4)
        #expect(info == AutoTurnInfo(trigger: .background, task: .init(taskId: "b1", description: "npm run build", status: "completed", summary: "done")))
        guard case let .autoTurn(_, odd) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"auto_turn","turn":5,"trigger":"cron-v2"}"#) else {
            Issue.record("not autoTurn"); return
        }
        #expect(odd.trigger == .continue)

        let store = makeStore()
        store.handle(.autoTurn(turn: 4, info: info))
        store.handle(.autoTurn(turn: 4, info: info))   // once per turn
        let rows = store.transcript.compactMap { if case let .autoTurn(_, t, i) = $0 { return (t, i) }; return nil }
        #expect(rows.count == 1 && rows.first?.0 == 4)

        let item = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"2026-11-05T04:00:00Z","turn":2,"kind":"auto_turn","trigger":"schedule","wakeupSource":"schedule_wakeup"}"#)
        #expect(item.kind == .autoTurn(AutoTurnInfo(trigger: .schedule, wakeupSource: "schedule_wakeup")))
        let restored = makeStore()
        restored.handle(.transcriptRestore(items: [item]))
        #expect(restored.transcript.contains { if case let .autoTurn(_, 2, i) = $0 { return i.trigger == .schedule }; return false })
    }

    @Test func textsSayWhatHappened() {
        let done = AutoTurnInfo(trigger: .background, task: .init(taskId: "b1", description: "npm run build", status: "completed"))
        let failed = AutoTurnInfo(trigger: .background, task: .init(taskId: "b1", description: "npm test", status: "failed"))
        #expect(BackgroundText.autoTurnTitle(done) != BackgroundText.autoTurnTitle(failed))
        #expect(BackgroundText.autoTurnDetail(done) == "npm run build")
        #expect(BackgroundText.autoTurnDetail(AutoTurnInfo(trigger: .continue)) == nil)
        #expect(BackgroundText.autoTurnDetail(AutoTurnInfo(trigger: .schedule)) != nil)
    }

    @Test func theSettingDefaultsOnAndGoesOutWithHello() {
        let defaults = UserDefaults(suiteName: "BackgroundWorkTests.\(UUID().uuidString)")!
        #expect(AppSettings.backgroundWork(defaults: defaults))
        #expect(AppSettings.engineSettings(defaults: defaults).backgroundWork == true)
        defaults.set(false, forKey: AppSettings.backgroundWorkKey)
        #expect(AppSettings.engineSettings(defaults: defaults).backgroundWork == false)
    }
}
