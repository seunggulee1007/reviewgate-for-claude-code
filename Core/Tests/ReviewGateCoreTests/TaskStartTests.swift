import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: task-start — docs/PROTOCOL.md §63: the start screen and "Start from a task" — the reference, the branch name, the
/// first prompt, the settings and what the window does.
@Suite @MainActor struct TaskStartTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "TaskStartTests.\(UUID().uuidString)")! }

    // MARK: The reference

    @Test func referencesFromKeysNumbersAndLinks() {
        let key = TaskReference.parse("  ACME-123 ")
        #expect(key?.id == "ACME-123" && key?.url == nil && key?.issueRef == nil)
        #expect(TaskReference.parse("#42")?.issueRef == "42")
        #expect(TaskReference.parse("42")?.id == "42")
        #expect(TaskReference.parse("acme/widgets#7")?.issueRef == "acme/widgets#7")
        let gh = TaskReference.parse("https://github.com/acme/widgets/issues/42")
        #expect(gh?.id == "42" && gh?.isGitHubLink == true && gh?.issueRef == "https://github.com/acme/widgets/issues/42")
        let tracker = TaskReference.parse("https://tracker.example.com/task/123")
        #expect(tracker?.id == "123" && tracker?.url == "https://tracker.example.com/task/123" && tracker?.issueRef == nil)
        #expect(TaskReference.parse("https://acme.example.com/browse/ACME-77?focus=1")?.id == "ACME-77")
        #expect(TaskReference.parse("see https://tracker.example.com/task/9 please")?.id == "9")   // the link in a sentence
        #expect(TaskReference.parse("") == nil)
        #expect(TaskReference.parse("장바구니") == nil)   // nothing ASCII to name a branch with
    }

    @Test func githubIsReadOnlyForItsIssues() {
        #expect(TaskReference.parse("https://github.com/acme/widgets/issues/42")!.fetchesFromGitHub(platform: .jira))   // a GitHub link always
        #expect(TaskReference.parse("#42")!.fetchesFromGitHub(platform: .github))
        #expect(!TaskReference.parse("#42")!.fetchesFromGitHub(platform: .linear))   // a number of another tracker
        #expect(!TaskReference.parse("ACME-1")!.fetchesFromGitHub(platform: .github))
        #expect(!TaskReference.parse("https://tracker.example.com/task/123")!.fetchesFromGitHub(platform: .github))
    }

    // MARK: The branch

    @Test func branchNamesFromPrefixIdAndTitle() {
        #expect(TaskBranch.name(prefix: "feature/", id: "ACME-123", title: "Fix the cart total") == "feature/ACME-123-fix-the-cart-total")
        #expect(TaskBranch.name(prefix: "{type}/", id: "42", title: "Crash on save", labels: ["bug"]) == "fix/42-crash-on-save")
        #expect(TaskBranch.name(prefix: "{type}/", id: "42", title: "Write docs", labels: ["documentation"]) == "docs/42-write-docs")
        #expect(TaskBranch.name(prefix: "{type}/", id: "42") == "feature/42")
        #expect(TaskBranch.name(prefix: "", id: "7", title: "Café résumé") == "7-cafe-resume")   // accents folded
        #expect(TaskBranch.name(prefix: "feature/", id: "ACME-9", title: "ACME-9 Add login") == "feature/ACME-9-add-login")   // no id twice
        #expect(TaskBranch.name(prefix: "bad prefix~/", id: "1") == "badprefix/1")   // the prefix kept valid
    }

    @Test func aKoreanTitleLeavesOnlyTheIdAndLongTitlesStopAtAWord() {
        #expect(TaskBranch.name(prefix: "feature/", id: "ACME-5", title: "장바구니 합계 오류 수정") == "feature/ACME-5")
        #expect(TaskBranch.name(prefix: "feature/", id: "5", title: "장바구니 total 오류") == "feature/5-total")   // its ASCII words
        let slug = TaskBranch.slug("Refactor the checkout service so that every payment provider shares one retry policy")
        #expect(slug.count <= TaskBranch.maxSlug)
        #expect(slug == "refactor-the-checkout-service-so-that-every")
        #expect(!slug.hasSuffix("-"))
    }

    // MARK: The prompt

    @Test func templateRenderingDropsEmptyLinesAndKeepsTheHint() {
        let template = "Work on task {id}: {title}\n{url}\n\n{mcp}\n\n{body}\n\nPlan first."
        let full = FetchedTask(id: "42", title: "Cart total", body: "Steps\n1. add", url: "https://github.com/acme/widgets/issues/42")
        #expect(TaskPrompt.render(template: template, task: full, hint: "") ==
                "Work on task 42: Cart total\nhttps://github.com/acme/widgets/issues/42\n\nSteps\n1. add\n\nPlan first.")
        let bare = FetchedTask(id: "ACME-1")
        #expect(TaskPrompt.render(template: template, task: bare, hint: "Read it with acme.") == "Work on task ACME-1\n\nRead it with acme.\n\nPlan first.")
        // No {mcp} in the template: the hint goes first.
        #expect(TaskPrompt.render(template: "Do {id}.", task: bare, hint: "Read it.") == "Read it.\n\nDo ACME-1.")
    }

    @Test func theHintNamesTheMcpServerAndItsTools() {
        let task = FetchedTask(id: "ACME-1", url: "https://tracker.example.com/task/1")
        let hint = TaskPrompt.hint(platform: .jira, mcpServer: "acme tracker", task: task, github: false)
        #expect(hint.contains("acme tracker") && hint.contains("mcp__acme_tracker__*"))
        #expect(!TaskPrompt.hint(platform: .linear, mcpServer: "", task: task, github: false).isEmpty)   // read it somehow
        #expect(TaskPrompt.hint(platform: .none, mcpServer: "x", task: task, github: false).isEmpty)
        #expect(TaskPrompt.hint(platform: .github, mcpServer: "", task: FetchedTask(id: "4", title: "T", body: "B"), github: true).isEmpty)
        #expect(TaskPrompt.hint(platform: .github, mcpServer: "", task: FetchedTask(id: "4"), github: true).contains("gh issue view 4"))
    }

    // MARK: Settings

    @Test func aProjectKeepsItsOwnSettingsElseTheDefault() {
        let d = defaults()
        #expect(AppSettings.taskStartSettings(root: "/work/acme", defaults: d) == .default)
        var global = TaskStartSettings.default
        global.platform = .linear
        global.mcpServer = "linear"
        AppSettings.setTaskStartSettings(global, root: nil, defaults: d)
        #expect(AppSettings.taskStartSettings(root: "/work/acme", defaults: d).platform == .linear)
        var own = global
        own.platform = .github
        own.location = .workbench
        AppSettings.setTaskStartSettings(own, root: "/work/acme", defaults: d)
        #expect(AppSettings.taskStartSettings(root: "/work/acme", defaults: d) == own)
        #expect(AppSettings.taskStartSettings(root: "/work/other", defaults: d) == global)
        #expect(AppSettings.hasProjectTaskStartSettings(root: "/work/acme", defaults: d))
        AppSettings.clearProjectTaskStartSettings(root: "/work/acme", defaults: d)
        #expect(AppSettings.taskStartSettings(root: "/work/acme", defaults: d) == global)
        // Lenient: an unknown platform from a newer app falls back field by field.
        d.set(Data(#"{"platform":"someday","branchPrefix":"fix/"}"#.utf8), forKey: AppSettings.Key.taskStartSettings)
        #expect(AppSettings.globalTaskStartSettings(defaults: d) == TaskStartSettings(branchPrefix: "fix/"))
        #expect(TaskStartSettings.default.template == TaskPrompt.defaultTemplate)
    }

    @Test func theTasksPaneIsInTheSearch() {
        let ids = SettingsCatalog.search("MCP").map(\.id)
        #expect(ids.contains("taskMcpServer"))
        #expect(SettingsCatalog.search("branch prefix").map(\.id).contains("taskBranchPrefix"))
        #expect(SettingsCatalog.entry("skipStartScreen")?.pane == .tasks)
    }

    // MARK: The start screen

    @Test func whenTheStartScreenShows() {
        #expect(StartScreen.shouldShow(skip: false, suppressed: false, phase: .idle, reviewPending: false, composerTask: false))
        #expect(!StartScreen.shouldShow(skip: true, suppressed: false, phase: .idle, reviewPending: false, composerTask: false))
        #expect(!StartScreen.shouldShow(skip: false, suppressed: true, phase: .idle, reviewPending: false, composerTask: false))
        #expect(!StartScreen.shouldShow(skip: false, suppressed: false, phase: .running, reviewPending: false, composerTask: false))
        #expect(!StartScreen.shouldShow(skip: false, suppressed: false, phase: .reviewing, reviewPending: true, composerTask: false))
        #expect(!StartScreen.shouldShow(skip: false, suppressed: false, phase: .idle, reviewPending: false, composerTask: true))
    }

    @Test func recentChatsAreTheFiveNewestWithAConversation() {
        func meta(_ id: String, _ at: String, turns: Int = 1) -> SessionMeta { SessionMeta(id: id, title: id, updatedAt: at, turns: turns) }
        var archived = meta("archived", "2026-01-09")
        archived.archived = true
        var moved = meta("moved", "2026-01-08")
        moved.movedTo = ChatMoveRef(path: "/work/acme-wb", name: "acme-wb", at: "2026-01-08")
        let list = [meta("a", "2026-01-01"), meta("b", "2026-01-02"), meta("empty", "2026-01-10", turns: 0), archived, moved,
                    meta("c", "2026-01-03"), meta("d", "2026-01-04"), meta("e", "2026-01-05"), meta("f", "2026-01-06")]
        #expect(StartScreen.recentChats(list).map(\.id) == ["f", "e", "d", "c", "b"])
        #expect(!StartScreen.needsNewChat(current: meta("empty", "", turns: 0)))
        #expect(StartScreen.needsNewChat(current: meta("a", "")))
        #expect(!StartScreen.needsNewChat(current: nil))
    }

    @Test func theKeyboard() {
        var cursor = StartScreenCursor()
        let chats = ["c1", "c2"]
        #expect(cursor.activate(chats: chats) == .start)   // ↩ on the first choice
        #expect(cursor.press(2, chats: chats) == .task)
        #expect(cursor.press(3, chats: chats) == nil)   // 3 marks the first chat …
        #expect(cursor.mark == .chat(0))
        cursor.move(1, chats: chats)
        #expect(cursor.activate(chats: chats) == .openChat("c2"))   // … ↓ ↩ opens the next one
        cursor.move(9, chats: chats)
        #expect(cursor.mark == .chat(1))   // stops at the end
        cursor.move(-9, chats: chats)
        #expect(cursor.mark == .choice(.start))
        cursor.move(2, chats: [])
        #expect(cursor.mark == .choice(.task))   // without chats 대화로 열기 is skipped
        #expect(cursor.press(3, chats: []) == nil && cursor.mark == .choice(.task))
        #expect(cursor.press(7, chats: chats) == nil)
    }

    // MARK: AppState

    private func snapshot(turns: Int, kind: SessionKind = .chat) -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .idle, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil,
                          changedOutside: [], ignoredTouched: [], filteredByPattern: [], restored: false)
        var meta = SessionMeta(id: "s1", title: "Earlier", turns: turns)
        meta.kind = kind
        s.sessions = SessionsInfo(list: [meta], currentId: "s1", openTabIds: ["s1"])
        return s
    }

    private func settle() async { for _ in 0..<40 { await Task.yield() } }

    @Test func startingHereMakesTheBranchANewChatAndFillsTheComposer() async {
        let d = defaults()
        AppSettings.setNewChatKind(.chat, defaults: d)
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d)
        store.handle(.state(snapshot(turns: 3)))
        var asked: [EngineCommand] = []
        var fired: [EngineCommand] = []
        store.replySink = { command in
            asked.append(command)
            return .result(id: "r", ok: true, error: nil)
        }
        store.commandSink = { fired.append($0) }
        let error = await store.startTaskHere(.branch("feature/ACME-1-cart"), prompt: "Work on task ACME-1")
        await settle()
        #expect(error == nil)
        #expect(asked.first == .createBranch(name: "feature/ACME-1-cart"))
        #expect(fired.contains(.sessionNew))   // the chat held a conversation: a fresh one
        #expect(store.taskForComposer?.text == "Work on task ACME-1")
        #expect(!fired.contains { if case .send = $0 { return true }; return false })   // never sent
    }

    @Test func anEmptyChatIsUsedAsItIsAndARefusalSaysWhy() async {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        store.handle(.state(snapshot(turns: 0)))
        var fired: [EngineCommand] = []
        store.commandSink = { fired.append($0) }
        store.replySink = { _ in throw EngineClientError.refused("invalid_branch_name:bad..name", code: "invalid_branch_name") }
        let refused = await store.startTaskHere(.branch("bad..name"), prompt: "x")
        #expect(refused?.contains("bad..name") == true)
        #expect(store.taskForComposer == nil)
        let here = await store.startTaskHere(.here, prompt: "Work on task 9")
        await settle()
        #expect(here == nil)
        #expect(!fired.contains(.sessionNew))
        #expect(store.taskForComposer?.text == "Work on task 9")
    }

    @Test func aTerminalChatGetsThePromptAsAPasteNeverEnter() async {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        store.handle(.state(snapshot(turns: 0, kind: .terminal)))
        store.commandSink = { _ in }
        var pasted: [String] = []
        var ready = false
        store.onTerminalPaste = { text in
            guard ready else { return "not yet" }   // its Claude Code is still starting
            pasted.append(text)
            return nil
        }
        _ = await store.startTaskHere(.here, prompt: "Work on task 9")
        await settle()
        #expect(pasted.isEmpty)
        ready = true
        for _ in 0..<20 where pasted.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
        #expect(pasted == ["Work on task 9"])
        #expect(store.taskForComposer == nil)
    }

    @Test func aDraftWaitsForItsChatsKindBeforeItGoesAnywhere() async {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var pasted: [String] = []
        store.onTerminalPaste = { pasted.append($0); return nil }
        store.handle(.taskStarted(TaskStartedInfo(text: "Work on task 7", mode: .default, from: "/work/acme", sent: false, draft: true)))
        await settle()
        #expect(store.taskForComposer == nil && pasted.isEmpty)   // no chat known yet
        store.handle(.state(snapshot(turns: 0, kind: .terminal)))
        for _ in 0..<20 where pasted.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
        #expect(pasted == ["Work on task 7"])
        #expect(store.taskForComposer == nil)
    }

    @Test func fetchTaskReadsTheReplyAndWordsTheRefusals() async throws {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        store.handle(.state(snapshot(turns: 0)))
        let task = FetchedTask(id: "42", number: 42, title: "Cart", body: "b", url: "u", labels: ["bug"])
        store.replySink = { command in
            #expect(command == .taskFetch(ref: "#42"))
            return .taskFetched(TaskFetchedReply(task: task))
        }
        #expect(try await store.fetchTask(ref: "#42") == task)
        store.replySink = { _ in throw EngineClientError.refused("not_found", code: "not_found") }
        await #expect(throws: TaskStartError(message: TaskStartText.refusal(code: "not_found", detail: "")!)) {
            _ = try await store.fetchTask(ref: "#404")
        }
    }

    @Test func theWireShapes() throws {
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.taskFetch(ref: "#42"))) as? [String: Any])
        #expect(json["type"] as? String == "task_fetch" && json["ref"] as? String == "#42")
        let reply = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"task_fetched","id":"1","task":{"id":"42","number":42,"title":"T","body":"","url":"u","labels":["bug",3]}}"#.utf8))
        guard case let .taskFetched(r) = reply else { Issue.record("not task_fetched"); return }
        #expect(r.id == "1" && r.task.title == "T" && r.task.labels == [])   // an odd element: the list read leniently as none
        let started = try JSONDecoder().decode(TaskStartedInfo.self, from: Data(#"{"text":"t","mode":"default","from":"/a","sent":false,"draft":true}"#.utf8))
        #expect(started.draft && !started.sent)
        let task = try JSONEncoder().encode(WorkbenchTask(text: "t", draft: true))
        #expect(String(decoding: task, as: UTF8.self).contains(#""draft":true"#))
    }
}
