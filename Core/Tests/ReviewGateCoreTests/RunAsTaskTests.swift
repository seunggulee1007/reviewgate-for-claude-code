import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §49 on the Swift side: `workbench_create {task}` on the wire, `task_started`, the branch "Run as Task"
/// suggests, and how the chat column shares a short window (§49.2).
@MainActor
@Suite struct RunAsTaskTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func event(_ json: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: json) }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "RunAsTaskTests.\(UUID().uuidString)")!)
    }

    @Test func workbenchCreateCarriesTheTaskOnlyWhenSet() throws {
        let plain = try json(.workbenchCreate(branch: "b"))
        #expect(plain["task"] == nil)
        let withMode = try json(.workbenchCreate(branch: "task/42", options: WorkbenchCreateOptions(task: WorkbenchTask(text: "Fix the cart", mode: .plan))))
        let task = try #require(withMode["task"] as? [String: Any])
        #expect(task["text"] as? String == "Fix the cart")
        #expect(task["mode"] as? String == "plan")
        let noMode = try json(.workbenchCreate(branch: "task/43", options: WorkbenchCreateOptions(task: WorkbenchTask(text: "x"))))
        #expect((noMode["task"] as? [String: Any])?["mode"] == nil)
    }

    @Test func taskStartedDecodesAndFallsBackOnOddValues() throws {
        guard case let .taskStarted(info) = try event(#"{"type":"task_started","text":"Fix it","mode":"auto","from":"/work/acme","sent":true}"#) else {
            Issue.record("not taskStarted"); return
        }
        #expect(info == TaskStartedInfo(text: "Fix it", mode: .auto, from: "/work/acme", sent: true))
        guard case let .taskStarted(odd) = try event(#"{"type":"task_started","text":"Fix it","mode":"yolo"}"#) else {
            Issue.record("not taskStarted"); return
        }
        #expect(odd == TaskStartedInfo(text: "Fix it", mode: .default, from: "", sent: false))
    }

    @Test func aTaskTheSessionCouldNotTakeGoesToTheComposerOnce() {
        let store = makeStore()
        store.handle(.taskStarted(TaskStartedInfo(text: "Fix it", mode: .plan, from: "/work/acme", sent: true)))
        #expect(store.taskForComposer == nil)
        store.handle(.taskStarted(TaskStartedInfo(text: "Fix it", mode: .plan, from: "/work/acme", sent: false)))
        let handed = try? #require(store.taskForComposer)
        #expect(handed?.text == "Fix it")
        store.takeTaskForComposer(UUID())
        #expect(store.taskForComposer != nil)   // another id: not this one
        if let handed { store.takeTaskForComposer(handed.id) }
        #expect(store.taskForComposer == nil)
    }

    @Test func branchFromALinkKeyOrWords() {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        // A link: its path's last number.
        #expect(TaskBranchName.suggest(text: "이 업무 진행해줘 https://acme.example.com/project/tasks/3901234567", now: at) == "task/3901234567")
        #expect(TaskBranchName.suggest(text: "see https://github.com/acme/app/issues/42 please", prefix: "fix/") == "fix/42")
        // A key.
        #expect(TaskBranchName.suggest(text: "#shop/1234 장바구니 합계 오류") == "task/shop-1234")
        #expect(TaskBranchName.suggest(text: "ABC-123: cart total is wrong") == "task/ABC-123")
        #expect(TaskBranchName.suggest(text: "issue #77 again") == "task/77")
        // Words of the first line (ASCII, five at most), URLs without a number skipped.
        #expect(TaskBranchName.suggest(text: "Add discount codes to the cart page today\nmore", prefix: "feature/") == "feature/add-discount-codes-to-the")
        #expect(TaskBranchName.suggest(text: "  \nFix README typo") == "task/fix-readme-typo")
        // Nothing usable: the date and time.
        #expect(TaskBranchName.suggest(text: "장바구니 합계가 틀려요", now: at, calendar: utc) == "task/20270115-0800")
        #expect(TaskBranchName.suggest(text: "", prefix: "", now: at, calendar: utc) == "20270115-0800")
    }

    @Test func prefixIsWhatTheLastBranchStartedWith() {
        #expect(TaskBranchName.prefix(of: "feature/acme/42") == "feature/acme/")
        #expect(TaskBranchName.prefix(of: "hotfix-42") == "")
        // A prefix that would make the name invalid is cleaned: odd characters out, `..` and `.lock` parts dropped.
        #expect(TaskBranchName.suggest(text: "ABC-1", prefix: "bad prefix:/") == "badprefix/ABC-1")
        #expect(TaskBranchName.suggest(text: "ABC-1", prefix: "../x.lock/") == "ABC-1")
    }

    @Test func aShortColumnKeepsTheCardsThenTheTranscriptGivesWay() {
        // Room to spare: the cards at their height, the transcript the rest.
        #expect(ChatColumnSplit.split(room: 500, cards: 120) == (380, 120))
        // Tight: the transcript keeps 80 while the cards scroll…
        #expect(ChatColumnSplit.split(room: 300, cards: 260) == (80, 220))
        // …but the cards keep 60% of a very short room.
        #expect(ChatColumnSplit.split(room: 100, cards: 260) == (40, 60))
        // No room: nothing for either (the composer and the HUD keep theirs).
        #expect(ChatColumnSplit.split(room: -40, cards: 120) == (0, 0))
        #expect(ChatColumnSplit.split(room: 200, cards: 0) == (200, 0))
    }

    // MARK: §50 Send now

    @Test func steerEncodesTextAndMentions() throws {
        let sent = try json(.steer(text: "Also check README", mentions: ["README.md"]))
        #expect(sent["type"] as? String == "steer")
        #expect(sent["text"] as? String == "Also check README")
        #expect(sent["mentions"] as? [String] == ["README.md"])
        #expect(try json(.steer(text: "x"))["mentions"] == nil)
    }

    @Test func steerGoesToTheEngineAndARefusalQueuesIt() async {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.requestSink = { sent.append($0) }
        await store.steer("  Also check README  ", mentions: ["README.md"])
        #expect(sent.count == 1)
        if case let .steer(text, mentions) = sent.first { #expect(text == "Also check README" && mentions == ["README.md"]) } else { Issue.record("not steer") }
        #expect(store.queuedMessages.isEmpty)
        store.requestSink = { _ in throw EngineClientError.refused("steer_unavailable:collecting", code: "steer_unavailable") }
        await store.steer("Then run the tests")
        #expect(store.queuedMessages.map(\.text) == ["Then run the tests"])
    }
}

