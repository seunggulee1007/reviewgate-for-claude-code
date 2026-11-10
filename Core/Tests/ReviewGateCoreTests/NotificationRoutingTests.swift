import Foundation
import Testing
@testable import ReviewGateCore

// MARK: wave4b w4-notify

/// Notifications you notice (§39.6): what each one says, the three switches of Settings › Notifications, the macOS
/// permission told in Settings and once in the window, and where a click lands (the chat, the card, the summary).
@Suite @MainActor struct NotificationRoutingTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "NotificationRoutingTests.\(UUID().uuidString)")! }

    // MARK: - Groups and switches

    @Test func everyKindBelongsToOneSwitch() {
        #expect(NotificationGroup(kind: .permission) == .waiting)
        #expect(NotificationGroup(kind: .question) == .waiting)
        #expect(NotificationGroup(kind: .plan) == .waiting)
        #expect(NotificationGroup(kind: .turnFinished) == .turnEnd)
        for kind: AttentionEvent.Kind in [.actionNeeded, .sideAnswer, .peerMessage, .agentsFinished] {
            #expect(NotificationGroup(kind: kind) == .other)
        }
    }

    @Test func switchesAreOnUntilTurnedOff() {
        let d = defaults()
        for group in NotificationGroup.allCases { #expect(AppSettings.notifies(group, defaults: d)) }
        d.set(false, forKey: NotificationGroup.turnEnd.defaultsKey)
        #expect(!AppSettings.notifies(.turnEnd, defaults: d))
        #expect(AppSettings.notifies(.waiting, defaults: d))
        #expect(AppSettings.notifies(.other, defaults: d))
        // Each switch has its own key.
        #expect(Set(NotificationGroup.allCases.map(\.defaultsKey)).count == NotificationGroup.allCases.count)
    }

    // MARK: - What a notification says

    @Test func permissionSaysWhatAndWhoAsks() {
        let bash = PermissionRequest(requestId: "r1", toolName: "Bash",
                                     input: .object(["command": .string("git worktree add ../w -b x\necho done")]))
        let event = AttentionEvent.permission(bash)
        #expect(event.kind == .permission)
        #expect(event.title == String(localized: "Permission needed", bundle: .module))
        #expect(event.body == "Bash: git worktree add ../w -b x")
        #expect(event.requestId == "r1")
        #expect(event.key == "perm:r1")

        var fromAgent = PermissionRequest(requestId: "r2", toolName: "Edit", input: .object([:]), file: "src/Svc.java")
        fromAgent.agent = PermissionAgent(agentId: "a1", subagentType: "code-reviewer")
        let agentEvent = AttentionEvent.permission(fromAgent)
        #expect(agentEvent.title.contains("code-reviewer"))
        #expect(agentEvent.body == "Edit: src/Svc.java")

        let bare = AttentionEvent.permission(PermissionRequest(requestId: "r3", toolName: "mcp__db__query", input: .object([:])))
        #expect(bare.body == "mcp__db__query")

        let long = String(repeating: "x", count: 300)
        let clipped = AttentionEvent.permission(PermissionRequest(requestId: "r4", toolName: "Bash", input: .object(["command": .string(long)])))
        #expect(clipped.body.count <= 130)
        #expect(clipped.body.hasSuffix("…"))
    }

    @Test func questionAndPlanSayWhatTheyWaitFor() {
        let ask = PermissionRequest(requestId: "q1", toolName: "AskUserQuestion", input: .object([
            "questions": .array([.object(["question": .string("Which branch?"), "header": .string("Branch"),
                                          "options": .array([.object(["label": .string("main")]), .object(["label": .string("dev")])])])]),
        ]))
        let question = AttentionEvent.permission(ask)
        #expect(question.kind == .question)
        #expect(question.title == String(localized: "Claude asked a question", bundle: .module))
        #expect(question.body == "Which branch?")
        #expect(question.requestId == "q1")

        let plan = AttentionEvent.plan(path: "/p.md", plan: "# Do it\nsteps")
        #expect(plan.title == String(localized: "Approve the plan", bundle: .module))
        #expect(plan.body == "Do it")
    }

    @Test func turnFinishedSaysWorkIsDoneOrWhyItStopped() {
        let done = AttentionEvent.turnFinished(pending: 3, key: "k")
        #expect(done.title == String(localized: "Work finished", bundle: .module))
        #expect(done.body == String(localized: "\(3) file(s) to review", bundle: .module))
        #expect(done.body.contains("3"))
        #expect(AttentionEvent.turnFinished(pending: 0, key: "k").body == String(localized: "No files to review", bundle: .module))
        let stopped = AttentionEvent.turnFinished(pending: 0, key: "k", stopped: TurnStopReason(kind: .loginRequired, text: "Login required"))
        #expect(stopped.title == "Login required")
    }

    // MARK: - The macOS permission

    @Test func systemPermissionProblems() {
        #expect(NotificationHealth.problem(appEnabled: true, system: .allowed) == nil)
        #expect(NotificationHealth.problem(appEnabled: true, system: .unknown) == nil)
        #expect(NotificationHealth.problem(appEnabled: true, system: .notDetermined) == nil)
        #expect(NotificationHealth.problem(appEnabled: true, system: .denied) == .systemOff)
        #expect(NotificationHealth.problem(appEnabled: true, system: .noBanners) == .noBanners)
        // The app's own switch is off: the user chose that — nothing to tell.
        #expect(NotificationHealth.problem(appEnabled: false, system: .denied) == nil)
        #expect(!NotificationProblem.systemOff.text.isEmpty)
        #expect(NotificationProblem.systemOff.text != NotificationProblem.noBanners.text)
    }

    @Test func theWindowTellsOnceUntilClosed() {
        #expect(NotificationHealth.showsWindowNotice(appEnabled: true, system: .denied, dismissed: false))
        #expect(!NotificationHealth.showsWindowNotice(appEnabled: true, system: .denied, dismissed: true))
        #expect(!NotificationHealth.showsWindowNotice(appEnabled: false, system: .denied, dismissed: false))
        // Banners off is a style the user picked in System Settings: Settings says it, the window does not.
        #expect(!NotificationHealth.showsWindowNotice(appEnabled: true, system: .noBanners, dismissed: false))
        #expect(!NotificationHealth.showsWindowNotice(appEnabled: true, system: .allowed, dismissed: false))
    }

    @Test func askingUpFrontOnlyWhileUndetermined() {
        #expect(NotificationHealth.asksUpFront(appEnabled: true, system: .notDetermined))
        #expect(!NotificationHealth.asksUpFront(appEnabled: false, system: .notDetermined))
        #expect(!NotificationHealth.asksUpFront(appEnabled: true, system: .denied))
        #expect(!NotificationHealth.asksUpFront(appEnabled: true, system: .allowed))
    }

    // MARK: - Where a click lands

    @Test func targetSurvivesTheNotificationsUserInfo() {
        let target = AttentionTarget(kind: .permission, chatId: "chat-1", requestId: "r1")
        var info: [AnyHashable: Any] = ["projectPath": "/repo"]
        for (k, v) in target.userInfo { info[k] = v }
        #expect(AttentionTarget(userInfo: info) == target)
        #expect(AttentionTarget(userInfo: ["projectPath": "/repo"]) == nil)   // posted by an older build
        #expect(AttentionTarget(userInfo: ["attentionKind": "somethingNew"]) == nil)
        let bare = AttentionTarget(kind: .turnFinished, chatId: nil, requestId: nil)
        #expect(AttentionTarget(userInfo: bare.userInfo) == bare)
    }

    /// wave4b integration (§39.2 × §39.6), as Electron's notifyClick.test.ts: a click shows a chat, it never switches.
    @Test func clickShowsItsChatWithoutSwitching() {
        let open = ["c1", "c2"]
        // The running chat's own notification (or one without a chat): the running chat, also while c2 is shown read-only.
        #expect(AttentionReveal.chatToShow(for: AttentionTarget(kind: .permission, chatId: "c1", requestId: "r1"), currentChatId: "c1", openTabIds: open) == "c1")
        #expect(AttentionReveal.chatToShow(for: AttentionTarget(kind: .question, chatId: nil, requestId: "q1"), currentChatId: "c1", openTabIds: open) == "c1")
        // A chat the session has left since: that chat (read-only) while its tab is open; a closed tab's chat: none.
        #expect(AttentionReveal.chatToShow(for: AttentionTarget(kind: .turnFinished, chatId: "c2", requestId: nil), currentChatId: "c1", openTabIds: open) == "c2")
        #expect(AttentionReveal.chatToShow(for: AttentionTarget(kind: .turnFinished, chatId: "gone", requestId: nil), currentChatId: "c1", openTabIds: open) == nil)
        // No session yet.
        #expect(AttentionReveal.chatToShow(for: AttentionTarget(kind: .actionNeeded, chatId: nil, requestId: nil), currentChatId: nil, openTabIds: []) == nil)
    }

    @Test func revealFindsTheCardOrTheSummary() {
        let ask = PermissionRequest(requestId: "r1", toolName: "Bash", input: .object([:]))
        let user = ChatItem.user(id: UUID(), text: "go")
        let perm = ChatItem.permission(id: UUID(), request: ask, allowed: nil)
        let oldPlan = ChatItem.plan(id: UUID(), path: nil, plan: "old", approvedMode: nil)
        let approved = ChatItem.plan(id: UUID(), path: nil, plan: "", approvedMode: .default)
        let plan = ChatItem.plan(id: UUID(), path: nil, plan: "# New", approvedMode: nil)
        let end = ChatItem.turnEnd(id: UUID(), summary: "2 files")
        let summary = ChatItem.turnSummary(id: UUID(), summary: TurnSummary(turn: 2, files: [TurnSummary.File(path: "a.ts")]))
        let items = [oldPlan, approved, user, perm, plan, end, summary]

        #expect(AttentionReveal.row(for: AttentionTarget(kind: .permission, chatId: nil, requestId: "r1"), in: items) == perm.id)
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .question, chatId: nil, requestId: "nope"), in: items) == nil)
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .plan, chatId: nil, requestId: nil), in: items) == plan.id)
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .turnFinished, chatId: nil, requestId: nil), in: items) == summary.id)
        // No summary card (nothing changed): the turn's end line.
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .turnFinished, chatId: nil, requestId: nil), in: [user, end]) == end.id)
        // A newer message started another turn: the old summary is not this turn's.
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .turnFinished, chatId: nil, requestId: nil), in: [summary, user]) == nil)
        // The plan was answered meanwhile: nothing to scroll to.
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .plan, chatId: nil, requestId: nil), in: [plan, approved]) == nil)
        #expect(AttentionReveal.row(for: AttentionTarget(kind: .peerMessage, chatId: nil, requestId: nil), in: items) == nil)
    }
}
