import Foundation
import Testing
@testable import ReviewGateCore

/// Daily-use UX logic: the composer queue and prompt history, attention events / notifications / dock badge, the
/// transcript search and render revisions, and the permission card's risk summary + "always allow" pattern.
@Suite @MainActor struct DailyUXTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "DailyUXTests.\(UUID().uuidString)")! }

    private func makeState(_ d: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults())
    }

    private func snapshot(seq: Int, phase: GatePhase, pending: Int = 0, plan: PendingPlan? = nil,
                          permission: PermissionRequest? = nil, path: String = "/repo") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: path, root: path, name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: permission, canRestart: true)
        s.session.pendingPlan = plan
        let canSend = (phase == .reviewing || phase == .idle) && permission == nil
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: pending, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: pending > 0 ? "B\(seq)" : nil, lastReviewSummary: nil)
        s.changedFiles = (0..<pending).map {
            ChangedFile(path: "f\($0).txt", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending)
        }
        return s
    }

    private func sends(_ commands: [EngineCommand]) -> [String] {
        commands.compactMap { if case let .send(text, _, _, _) = $0 { return text }; return nil }
    }

    // MARK: - Queue

    @Test func queuedMessagesWaitForTheTurnAndGoOutInOrder() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("first")
        app.enqueue("  second ")
        app.enqueue("   ")
        #expect(app.queuedMessages.map(\.text) == ["first", "second"])
        #expect(sent.isEmpty)
        // The turn ends with files pending: a pending review does not hold the queue (a send is a question).
        app.handle(.state(snapshot(seq: 2, phase: .reviewing, pending: 2)))
        #expect(sends(sent) == ["first"])
        // Another snapshot before the queued turn starts must not send the second message too.
        app.handle(.state(snapshot(seq: 3, phase: .reviewing, pending: 2)))
        #expect(sends(sent) == ["first"])
        app.handle(.state(snapshot(seq: 4, phase: .running)))
        app.handle(.state(snapshot(seq: 5, phase: .collecting)))
        #expect(sends(sent) == ["first"])
        app.handle(.state(snapshot(seq: 6, phase: .reviewing, pending: 1)))
        #expect(sends(sent) == ["first", "second"])
        #expect(app.queuedMessages.isEmpty)
    }

    @Test func queueEditsAndReorders() {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        for t in ["a", "b", "c"] { app.enqueue(t) }
        let ids = app.queuedMessages.map(\.id)
        app.moveQueued(id: ids[2], by: -5)
        #expect(app.queuedMessages.map(\.text) == ["c", "a", "b"])
        app.moveQueued(id: ids[2], by: 1)
        #expect(app.queuedMessages.map(\.text) == ["a", "c", "b"])
        app.updateQueued(id: ids[0], text: "A!")
        app.updateQueued(id: ids[1], text: "  ")   // emptied → removed
        app.removeQueued(id: ids[2])
        #expect(app.queuedMessages.map(\.text) == ["A!"])
    }

    @Test func errorStopsTheQueueUntilResumed() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("next")
        app.handle(.error(message: "Not logged in", fatal: false, scope: .session, detail: EngineErrorDetail(code: "auth_required")))
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sends(sent).isEmpty)
        #expect(app.queuePausedReason != nil)
        app.resumeQueue()
        #expect(sends(sent) == ["next"])
        #expect(app.queuePausedReason == nil)
    }

    @Test func planOrPermissionHoldsTheQueue() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("later")
        app.handle(.state(snapshot(seq: 2, phase: .reviewing, plan: PendingPlan(path: nil, plan: "# Plan"))))
        #expect(sends(sent).isEmpty)
        #expect(app.queueHoldReason != nil)
        app.handle(.state(snapshot(seq: 3, phase: .reviewing)))
        #expect(sends(sent) == ["later"])
    }

    @Test func stopAndSendInterruptsThenSendsFirst() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("queued")
        app.interruptAndSend("urgent")
        // §28: the send goes out right behind the interrupt (the engine's main lane holds it until the turn ended).
        #expect(sent == [.interrupt, .send(text: "urgent")])
        app.handle(.userMessage(text: "urgent", turn: 2))
        #expect(app.sendAfterInterrupt == nil)
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sends(sent) == ["urgent", "queued"])   // the queue continues after it
    }

    @Test func switchingProjectDropsTheQueue() {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("for repo")
        app.handle(.state(snapshot(seq: 2, phase: .running, path: "/other")))
        #expect(app.queuedMessages.isEmpty)
    }

    // MARK: - Prompt history

    @Test func historyIsPerProjectDedupedAndCapped() {
        let d = defaults()
        for i in 0..<(AppSettings.maxPromptHistory + 5) { AppSettings.appendPromptHistory("p\(i)", root: "/a", defaults: d) }
        AppSettings.appendPromptHistory("p10", root: "/a", defaults: d)
        let list = AppSettings.promptHistory(root: "/a", defaults: d)
        #expect(list.count == AppSettings.maxPromptHistory)
        #expect(list.last == "p10")
        #expect(list.filter { $0 == "p10" }.count == 1)
        #expect(AppSettings.promptHistory(root: "/b", defaults: d).isEmpty)

        let app = makeState(d)
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .idle, path: "/b")))
        app.send("hello b")
        #expect(app.promptHistory == ["hello b"])
    }

    @Test func navigatorWalksAndRestores() {
        var nav = PromptHistoryNavigator(entries: ["one", "two", "three"])
        var r: String?
        r = nav.up(draft: "typed\nsecond line", caretOnFirstLine: false)
        #expect(r == nil)          // the caret is below the first line: it moves up instead
        r = nav.up(draft: "", caretOnFirstLine: true)
        #expect(r == "three")
        r = nav.up(draft: "three", caretOnFirstLine: true)
        #expect(r == "two")
        r = nav.up(draft: "two", caretOnFirstLine: true)
        #expect(r == "one")
        r = nav.up(draft: "one", caretOnFirstLine: true)
        #expect(r == nil)            // oldest
        r = nav.down(draft: "one", caretOnLastLine: true)
        #expect(r == "two")
        r = nav.cancel()
        #expect(r == "")
        #expect(!nav.isBrowsing)
        r = nav.up(draft: "", caretOnFirstLine: true)
        #expect(r == "three")
        r = nav.down(draft: "three", caretOnLastLine: true)
        #expect(r == "")         // past the newest: back to the draft
        r = nav.up(draft: "", caretOnFirstLine: true)
        #expect(r == "three")
        r = nav.up(draft: "three edited", caretOnFirstLine: true)
        #expect(r == "two")   // wave6 w6-terminal: an edited prompt is kept for the walk, browsing goes on
        #expect(nav.isBrowsing)
        r = nav.down(draft: "two", caretOnLastLine: true)
        #expect(r == "three edited")
    }

    /// MARK: wave6 w6-terminal — §44.1 (architect review): the draft typed before ↑ is never lost — not by editing a recalled
    /// prompt, not by walking past it; ↓ past the newest prompt and Esc bring it back, Esc before anything else (a second Esc
    /// finds nothing to restore and may stop the turn); a sent prompt or a chat switch (`parkedDraft`) are the only other ends.
    @Test func navigatorNeverLosesTheTypedDraft() {
        var nav = PromptHistoryNavigator(entries: ["one", "two"])
        #expect(nav.parkedDraft == nil)
        #expect(nav.up(draft: "my draft", caretOnFirstLine: true) == "two")
        #expect(nav.parkedDraft == "my draft")
        // Typing into the recalled prompt, then walking on and back: the edit and the draft both stay.
        #expect(nav.up(draft: "two, edited", caretOnFirstLine: true) == "one")
        #expect(nav.down(draft: "one", caretOnLastLine: true) == "two, edited")
        #expect(nav.down(draft: "two, edited more", caretOnLastLine: true) == "my draft")
        #expect(!nav.isBrowsing)
        // Back in: the edited prompt is still there while the list is the same (`refresh` keeps it).
        nav.refresh(entries: ["one", "two"])
        #expect(nav.up(draft: "my draft", caretOnFirstLine: true) == "two, edited more")
        // Esc after an edit: the typed draft comes back (the edits of recalled prompts go); a second Esc has nothing to restore.
        #expect(nav.cancel() == "my draft")
        #expect(nav.cancel() == nil)
        #expect(nav.up(draft: "my draft", caretOnFirstLine: true) == "two")
        // A sent prompt starts over.
        nav.reset(entries: ["one", "two", "my draft"])
        #expect(!nav.isBrowsing)
        #expect(nav.parkedDraft == nil)
        #expect(nav.up(draft: "", caretOnFirstLine: true) == "my draft")
        // Another list (a prompt sent elsewhere) drops the edits, never the browsing state's own draft.
        var other = PromptHistoryNavigator(entries: ["a"])
        #expect(other.up(draft: "x", caretOnFirstLine: true) == "a")
        #expect(other.down(draft: "a!", caretOnLastLine: true) == "x")
        other.refresh(entries: ["a", "b"])
        #expect(other.up(draft: "x", caretOnFirstLine: true) == "b")
        #expect(other.up(draft: "b", caretOnFirstLine: true) == "a")
    }

    /// MARK: wave6 w6-terminal — §44.1: like the terminal, ↑ on the first line also leaves a typed draft for the history and
    /// gives it back past the newest prompt (or with Esc); inside a recalled multi-line prompt the caret moves first.
    @Test func navigatorKeepsWhatWasTypedLikeTheTerminal() {
        var nav = PromptHistoryNavigator(entries: ["fix the build", "plan it\nthen implement"])
        #expect(nav.up(draft: "half typed", caretOnFirstLine: true) == "plan it\nthen implement")
        #expect(nav.up(draft: "plan it\nthen implement", caretOnFirstLine: false) == nil)   // caret on its second line
        #expect(nav.isBrowsing)
        #expect(nav.up(draft: "plan it\nthen implement", caretOnFirstLine: true) == "fix the build")
        #expect(nav.down(draft: "fix the build", caretOnLastLine: true) == "plan it\nthen implement")
        #expect(nav.down(draft: "plan it\nthen implement", caretOnLastLine: false) == nil)  // caret on its first line
        #expect(nav.down(draft: "plan it\nthen implement", caretOnLastLine: true) == "half typed")
        #expect(!nav.isBrowsing)
        #expect(nav.up(draft: "half typed", caretOnFirstLine: true) == "plan it\nthen implement")
        #expect(nav.cancel() == "half typed")
    }

    // MARK: - Attention

    @Test func attentionEventsFromTheSession() {
        let app = makeState()
        app.commandSink = { _ in }
        var events: [AttentionEvent] = []
        app.onAttention = { events.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        let req = PermissionRequest(requestId: "r1", toolName: "Bash", input: .object(["command": .string("npm install\nmore")]))
        app.handle(.permissionRequest(req))
        app.handle(.planProposed(path: "/p.md", plan: "# Do it\nsteps"))
        app.handle(.state(snapshot(seq: 3, phase: .collecting)))
        app.handle(.state(snapshot(seq: 4, phase: .reviewing, pending: 3)))
        app.handle(.state(snapshot(seq: 5, phase: .reviewing, pending: 3)))   // no second "finished"
        app.handle(.error(message: "x", fatal: false, scope: .session, detail: EngineErrorDetail(code: "auth_required")))
        app.handle(.error(message: "y", fatal: false, scope: .git))           // nothing to do → no notification
        #expect(events.map(\.kind) == [.permission, .plan, .turnFinished, .actionNeeded])
        #expect(events[0].body == "Bash: npm install")   // wave4b w4-notify: the tool, then the command's first line
        #expect(events[1].body == "Do it")
        #expect(events[2].body.contains("3"))
    }

    @Test func sendMessageNotificationNamesTheReceivingSession() {
        // §33.2: "Claude wants to send a message to another session" + who receives it, never the bare tool name.
        let request = PermissionRequest(requestId: "m1", toolName: "SendMessage",
                                        input: .object(["to": .string("team-lead"), "message": .string("done")]))
        let event = AttentionEvent.permission(request)
        #expect(event.kind == .permission)
        #expect(event.key == "perm:m1")
        #expect(!event.title.contains("SendMessage"))
        #expect(event.body == "team-lead")
    }

    @Test func coalescerPostsOnceAndThrottles() {
        var c = AttentionCoalescer(minimumInterval: 3)
        var ok: Bool
        let t0 = Date(timeIntervalSince1970: 1000)
        let a = AttentionEvent(kind: .permission, title: "t", body: "b", key: "perm:1")
        let b = AttentionEvent(kind: .permission, title: "t", body: "b", key: "perm:2")
        ok = c.shouldPost(a, scope: "/w", now: t0)
        #expect(ok)
        ok = c.shouldPost(a, scope: "/w", now: t0.addingTimeInterval(60))
        #expect(!ok)   // same key
        ok = c.shouldPost(b, scope: "/w", now: t0.addingTimeInterval(1))
        #expect(!ok)    // burst of one kind
        ok = c.shouldPost(b, scope: "/other", now: t0.addingTimeInterval(1))
        #expect(ok) // another window
        let d = AttentionEvent(kind: .permission, title: "t", body: "b", key: "perm:3")
        ok = c.shouldPost(d, scope: "/w", now: t0.addingTimeInterval(5))
        #expect(ok)
    }

    @Test func dockBadge() {
        #expect(DockBadge.label(pendingCounts: [], anyWaiting: false) == nil)
        #expect(DockBadge.label(pendingCounts: [0, 0], anyWaiting: false) == nil)
        #expect(DockBadge.label(pendingCounts: [2, 3], anyWaiting: false) == "5")
        #expect(DockBadge.label(pendingCounts: [2], anyWaiting: true) == "!")
    }

    // MARK: - Transcript

    @Test func streamingDeltasKeepTheStructureRevision() {
        let app = makeState()
        app.handle(.userMessage(text: "hi", turn: 1))
        let structure = app.transcriptStructureRevision
        let any = app.transcriptRevision
        app.handle(.textDelta(text: "a"))
        let afterFirst = app.transcriptStructureRevision
        #expect(afterFirst == structure + 1)            // the assistant row was appended
        app.handle(.textDelta(text: "b"))
        app.handle(.textDelta(text: "c"))
        #expect(app.transcriptStructureRevision == afterFirst)
        // MARK: wave7 w7-chat — §45.1: the deltas after the first land in `liveText` and are told once per burst.
        app.publishLiveText()
        #expect(app.transcriptRevision == any + 2)
        #expect(app.liveText.text == "abc")
    }

    @Test func searchFindsTextToolsAndOutputsInDisplayOrder() {
        let user = ChatItem.user(id: UUID(), text: "Fix the Login bug")
        let agent = ChatItem.toolUse(id: UUID(), toolUseId: "ag", name: "Agent", file: nil, input: .object(["description": .string("look")]))
        let inner = ChatItem.toolUse(id: UUID(), toolUseId: "b1", name: "Bash", file: nil, input: .object(["command": .string("grep -r login src")]),
                                     info: ToolUseInfo(parentToolUseId: "ag"))
        let innerResult = ChatItem.toolResult(id: UUID(), toolUseId: "b1", isError: false, preview: "src/a.ts: LOGIN()",
                                              info: ToolResultInfo(parentToolUseId: "ag"))
        let agentResult = ChatItem.toolResult(id: UUID(), toolUseId: "ag", isError: false, preview: "found login")
        let reply = ChatItem.assistant(id: UUID(), text: "Done.", streaming: false)
        let nodes = TranscriptNode.build([user, agent, inner, innerResult, agentResult, reply])
        let hits = TranscriptSearch.matches("login", in: nodes)
        #expect(hits == [user.id, inner.id, innerResult.id, agentResult.id])
        #expect(TranscriptSearch.matches("  ", in: nodes).isEmpty)
        #expect(TranscriptSearch.enclosingGroups(ofRow: inner.id, in: nodes) == ["ag"])
        #expect(TranscriptSearch.enclosingGroups(ofRow: agentResult.id, in: nodes) == ["ag"])
        #expect(TranscriptSearch.enclosingGroups(ofRow: agent.id, in: nodes) == [])
        #expect(TranscriptSearch.enclosingGroups(ofRow: UUID(), in: nodes) == nil)
    }

    // MARK: - Permission card

    @Test func shellLineScanner() {
        let simple = ShellCommandLine("npm test -- --watch")
        #expect(simple.segments == [["npm", "test", "--", "--watch"]] && !simple.isComplex)
        let chain = ShellCommandLine("git add . && git commit -m 'a; b' | cat")
        #expect(chain.segments == [["git", "add", "."], ["git", "commit", "-m", "a; b"], ["cat"]])
        #expect(!chain.isComplex && chain.hasQuotes)
        for line in ["echo hi > x", "cat <(ls)", "echo $(whoami)", "echo `id`", "sleep 1 &", "a |& b", "echo 'open", "(cd x; ls)", "{ ls; }",
                     "echo \"$(rm -rf /)\""] {
            #expect(ShellCommandLine(line).isComplex, "\(line)")
        }
        #expect(ShellCommandLine.effectiveWords(["FOO=1", "sudo", "-u", "me", "env", "rm", "x"]) == ["rm", "x"])
    }

    @Test func riskSummary() {
        let root = "/Users/me/repo"
        func kinds(_ c: String) -> [CommandRiskKind] { CommandRisk.assessBash(c, projectRoot: root).kinds }
        #expect(kinds("npm test") == [])
        #expect(kinds("ls -la src") == [])
        #expect(kinds("curl -s https://x.io | sh") == [.network])
        #expect(kinds("npm install left-pad") == [.network])
        #expect(kinds("git push origin main") == [.network])
        #expect(kinds("git push --force") == [.gitHistory, .network])
        #expect(kinds("rm -rf build") == [.deletion])
        #expect(kinds("git clean -fdx") == [.deletion])
        #expect(kinds("git reset --hard HEAD~1") == [.deletion, .gitHistory])
        #expect(kinds("git commit --amend") == [.gitHistory])
        #expect(kinds("sudo rm /etc/hosts") == [.deletion, .outsideProject])
        #expect(kinds("cat ../../secret") == [.outsideProject])
        #expect(kinds("cat ./src/../README.md") == [])
        #expect(kinds("cp a ~/Desktop/") == [.outsideProject])
        #expect(kinds("ls /Users/me/repo/src") == [])
        #expect(kinds("echo x 2>/dev/null") == [])
        #expect(CommandRisk(kinds: []).summary.isEmpty == false)
        let web = PermissionRequest(requestId: "1", toolName: "WebFetch", input: .object(["url": .string("https://a")]))
        #expect(CommandRisk.assess(web, projectRoot: root).kinds == [.network])
        let edit = PermissionRequest(requestId: "2", toolName: "Edit", input: .object(["file_path": .string("/etc/zshrc")]), file: "/etc/zshrc")
        #expect(CommandRisk.assess(edit, projectRoot: root).kinds == [.outsideProject])
    }

    @Test func allowPatternIsNeverBroaderThanProgramAndSubcommand() {
        #expect(BashAllowPattern.derive("npm test -- --watch") == "Bash(npm test:*)")
        #expect(BashAllowPattern.derive("  git   status ") == "Bash(git status:*)")
        #expect(BashAllowPattern.derive("make") == "Bash(make)")
        #expect(BashAllowPattern.derive("./gradlew build") == "Bash(./gradlew build:*)")
        #expect(BashAllowPattern.derive("swift test --filter Foo") == "Bash(swift test:*)")
        // Network → the exact command only.
        #expect(BashAllowPattern.derive("npm install") == "Bash(npm install)")
        // MARK: r2-skills-side (§33.6, M21): any branch's push; a force / delete push stays a card no pattern answers.
        #expect(BashAllowPattern.derive("git push origin main") == "Bash(git push:*)")
        #expect(BashAllowPattern.derive("git push -u origin feature/acme-42") == "Bash(git push:*)")
        #expect(BashAllowPattern.derive("git push --force origin main") == nil)
        #expect(BashAllowPattern.derive("git push origin --delete feature/x") == nil)
        // Second word is not a subcommand → exact.
        #expect(BashAllowPattern.derive("ls -la") == "Bash(ls -la)")
        // Not a simple command, a wrapper, or not reproducible → nothing.
        for c in ["npm test && rm -rf x", "npm test > out", "sudo make", "sh -c 'ls'", "xargs rm", "FOO=1 npm test", "bash x.sh",
                  "echo 'a b'", "rm *.log", "node script.js", "rm build/out.txt", "git reset --hard", "git commit -m x",
                  "cat ../secret", "ls /etc", "cp a ~/x", "python3 -m pytest", "", "find . -name x"] {
            #expect(BashAllowPattern.derive(c) == nil, "\(c)")
        }
    }

    /// MARK: r2-skills-side — §33.6 (M21): "always allow" is kept per repository (every worktree of it) or for all projects.
    @Test func alwaysAllowIsKeptPerRepositoryOrForAllProjects() {
        let d = defaults()
        // A list kept by the main worktree's folder before still applies there.
        AppSettings.setProjectBashAllowPatterns(["Bash(make build:*)"], root: "/work/acme", defaults: d)
        let app = makeState(d)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var s = snapshot(seq: 1, phase: .idle, path: "/work/acme")
        s.project?.commonDir = "/work/acme/.git"
        app.handle(.state(s))
        #expect(app.projectAllowPatterns == ["Bash(make build:*)"])
        app.addProjectAllowPattern("Bash(./mvnw test:*)")
        #expect(AppSettings.projectBashAllowPatterns(root: AppSettings.repositoryKey(commonDir: "/work/acme/.git"), defaults: d) == ["Bash(./mvnw test:*)"])
        #expect(app.projectAllowPatterns == ["Bash(./mvnw test:*)", "Bash(make build:*)"])

        // Another worktree of the same repository (a workbench) has it; its own older list stays its own.
        let other = makeState(d)
        var wt = snapshot(seq: 1, phase: .idle, path: "/work/acme-42")
        wt.project?.commonDir = "/work/acme/.git"
        other.handle(.state(wt))
        #expect(other.projectAllowPatterns == ["Bash(./mvnw test:*)"])
        #expect(AppSettings.effectiveBashAllowPatterns(root: "/work/acme-42", repository: AppSettings.repositoryKey(commonDir: "/work/acme/.git"), defaults: d) == ["Bash(./mvnw test:*)"])
        other.removeProjectAllowPattern("Bash(./mvnw test:*)")
        #expect(app.projectAllowPatterns == ["Bash(make build:*)"])

        // "모든 프로젝트에서 허용": the global list, then the card is allowed.
        let request = PermissionRequest(requestId: "G1", toolName: "Bash", input: .object(["command": .string("git push origin main")]))
        app.handle(.permissionRequest(request))
        var running = snapshot(seq: 2, phase: .running, permission: request, path: "/work/acme")
        running.project?.commonDir = "/work/acme/.git"
        running.session.pendingPermissions = [request]
        app.handle(.state(running))
        sent = []
        app.alwaysAllowEverywhere(requestId: "G1", pattern: "Bash(git push:*)")
        #expect(AppSettings.bashAllowPatterns(defaults: d) == ["Bash(git push:*)"])
        #expect(app.projectAllowPatterns == ["Bash(make build:*)"])
        guard case let .setSettings(settings)? = sent.first else { Issue.record("no set_settings first: \(sent)"); return }
        #expect(settings.bashAllowPatterns == ["Bash(git push:*)", "Bash(make build:*)"])
        #expect(sent.contains(.permissionResponse(requestId: "G1", allow: true, remember: false)))
    }

    @Test func projectPatternsMergeAfterTheGlobalList() {
        let d = defaults()
        d.set("Bash(git *)\n", forKey: AppSettings.Key.bashAllowPatterns)
        AppSettings.setProjectBashAllowPatterns(["Bash(npm test:*)", "Bash(git *)", "Bash(npm test:*)"], root: "/a", defaults: d)
        #expect(AppSettings.projectBashAllowPatterns(root: "/a", defaults: d) == ["Bash(npm test:*)", "Bash(git *)"])
        #expect(AppSettings.effectiveBashAllowPatterns(root: "/a", defaults: d) == ["Bash(git *)", "Bash(npm test:*)"])
        #expect(AppSettings.effectiveBashAllowPatterns(root: "/b", defaults: d) == ["Bash(git *)"])

        let app = makeState(d)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .idle, path: "/a")))
        app.addProjectAllowPattern("Bash(make)")
        #expect(app.projectAllowPatterns == ["Bash(npm test:*)", "Bash(git *)", "Bash(make)"])
        guard case let .setSettings(settings)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(settings.bashAllowPatterns == ["Bash(git *)", "Bash(npm test:*)", "Bash(make)"])
        app.removeProjectAllowPattern("Bash(git *)")
        #expect(app.projectAllowPatterns == ["Bash(npm test:*)", "Bash(make)"])
    }
}
