import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-perms (audit agents-01, P0): permission requests are a queue (docs/PROTOCOL.md §33.1). Every card answers
/// its own request, the shortcuts answer the oldest open one, a card whose request left the queue without this client's
/// answer reads "처리됨", and nothing a stale snapshot says brings an answered card back. Client handoff §6 points 1–7,
/// 29 and 31.
@Suite @MainActor struct PermissionQueueTests {
    private func makeState() -> (AppState, UserDefaults) {
        let defaults = UserDefaults(suiteName: "PermissionQueueTests.\(UUID().uuidString)")!
        return (AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults), defaults)
    }

    private func bash(_ id: String, _ command: String, agent: PermissionAgent? = nil, reason: PermissionReason? = nil) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: "Bash", input: .object(["command": .string(command)]), file: nil,
                          toolUseId: "t-\(id)", agent: agent, reason: reason)
    }

    private func question(_ id: String) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: AskUserQuestions.toolName, input: .object([
            "questions": .array([.object(["question": .string("Which?"), "header": .string("H"),
                                          "options": .array([.object(["label": .string("a")]), .object(["label": .string("b")])])])]),
        ]))
    }

    /// A running turn with `queue` open (the engine always sends both fields).
    private func running(seq: Int, queue: [PermissionRequest], peerTurn: PeerTurnInfo? = nil, phase: GatePhase = .running) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: queue.first, canRestart: true)
        s.session.pendingPermissions = queue
        s.session.peerTurn = peerTurn
        let idle = phase == .reviewing || phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle && queue.isEmpty, canRequestChanges: false,
                          blockedReason: idle ? nil : (queue.isEmpty ? .running : .awaitingPermission), collectError: nil,
                          pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "A", turnEndTree: nil,
                          lastReviewSummary: nil)
        return s
    }

    private enum Card: Equatable { case open, handled, allowed, denied, missing }

    /// How the card of `requestId` reads: buttons (open), "처리됨" (left the queue without this client's answer), decided.
    private func card(_ app: AppState, _ requestId: String) -> Card {
        for item in app.transcript.reversed() {
            guard case let .permission(_, request, allowed) = item, request.requestId == requestId else { continue }
            switch allowed {
            case true?: return .allowed
            case false?: return .denied
            case nil: return app.isPermissionOpen(requestId) ? .open : .handled
            }
        }
        return .missing
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    private let executor = PermissionAgent(agentId: "taskA", agentToolUseId: "agA", subagentType: "executor", description: "compile")
    private let tester = PermissionAgent(agentId: "taskB", agentToolUseId: "agB", subagentType: "test-engineer", description: "test")

    // MARK: §6 point 1

    @Test func answeringTheNewerCardLeavesTheOlderOneOpen() {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let r1 = bash("R1", "./gradlew :acme-api:compileJava", agent: executor)
        let r2 = bash("R2", "./gradlew test", agent: tester)
        app.handle(.permissionRequest(r1))
        app.handle(.permissionRequest(r2))
        app.handle(.state(running(seq: 1, queue: [r1, r2])))
        #expect(app.openPermissions.map(\.requestId) == ["R1", "R2"])
        #expect(card(app, "R1") == .open && card(app, "R2") == .open)

        // The card the user looked at (the newer one) is the one answered — never the slot's request.
        app.respondPermission(requestId: "R2", allow: true)
        #expect(sent == [.permissionResponse(requestId: "R2", allow: true)])
        #expect(card(app, "R2") == .allowed && card(app, "R1") == .open)
        #expect(app.pendingPermission?.requestId == "R1")

        // A snapshot taken before the engine saw the answer does not bring R2's buttons back.
        app.handle(.state(running(seq: 2, queue: [r1, r2])))
        #expect(card(app, "R2") == .allowed && app.openPermissions.map(\.requestId) == ["R1"])

        // The engine confirms; the older card is still answerable, with its own id.
        app.handle(.state(running(seq: 3, queue: [r1])))
        app.respondPermission(requestId: "R1", allow: false, message: "not now")
        #expect(sent.last == .permissionResponse(requestId: "R1", allow: false, message: "not now"))
        #expect(card(app, "R1") == .denied && app.openPermissions.isEmpty && app.pendingPermission == nil)
    }

    // MARK: §6 point 2

    @Test func theShortcutsAnswerTheOldestOpenCard() {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let q1 = question("Q1")
        let r1 = bash("R1", "make a")
        let r2 = bash("R2", "make b")
        for request in [q1, r1, r2] { app.handle(.permissionRequest(request)) }
        app.handle(.state(running(seq: 1, queue: [q1, r1, r2])))
        // A question at the head has its own card keys: the shortcuts go to the oldest tool request.
        #expect(app.shortcutPermission?.requestId == "R1")
        #expect(CardShortcuts.action(for: .commandReturn, focus: .composer(draft: ""), target: app.shortcutPermission) == .allowOnce(requestId: "R1"))

        app.respondPermission(allow: true)   // what the composer's ⌘↩ does
        #expect(sent == [.permissionResponse(requestId: "R1", allow: true)])
        #expect(app.shortcutPermission?.requestId == "R2")
        app.respondPermission(allow: false, message: "Denied by user")   // ⌘⌫
        #expect(sent.last == .permissionResponse(requestId: "R2", allow: false, message: "Denied by user"))
        #expect(app.shortcutPermission == nil && app.openPermissions.map(\.requestId) == ["Q1"])
        let count = sent.count
        app.respondPermission(allow: true)   // nothing but the question is left: the composer's keys do nothing
        #expect(sent.count == count)
    }

    // MARK: §6 point 3

    @Test func interruptTurnsEveryOpenCardDenied() {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let r1 = bash("R1", "make a", agent: executor)
        let r2 = bash("R2", "make b", agent: tester)
        app.handle(.permissionRequest(r1))
        app.handle(.permissionRequest(r2))
        app.handle(.state(running(seq: 1, queue: [r1, r2])))
        app.interrupt()
        #expect(sent == [.interrupt])
        #expect(card(app, "R1") == .denied && card(app, "R2") == .denied)
        #expect(app.openPermissions.isEmpty && app.pendingPermission == nil)
        // The engine's last snapshot from before the interrupt does not reopen them.
        app.handle(.state(running(seq: 2, queue: [r1, r2])))
        #expect(app.openPermissions.isEmpty)
        app.handle(.state(running(seq: 3, queue: [], phase: .reviewing)))
        #expect(card(app, "R1") == .denied && card(app, "R2") == .denied)
    }

    // MARK: §6 point 4

    @Test func aCardWithAReasonOffersNoStandingAllows() {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let nested = bash("N1", "cd .claude/worktrees/wt1 && make",
                          reason: PermissionReason(code: .nestedRepository, message: "nested", path: "/repo/.claude/worktrees/wt1"))
        let options = PermissionCardOptions(request: nested)
        #expect(!options.allowsRemember && !options.showsAlwaysAllow && options.alwaysAllowPatterns.isEmpty)
        // Even with patterns on the wire, a reason wins (the engine never sends both).
        var config = PermissionRequest(requestId: "C1", toolName: "Edit", input: .object([:]), file: "/repo/.claude/settings.local.json",
                                       toolUseId: "tc", reason: PermissionReason(code: .claudeConfig, message: "m", path: "/repo/.claude/settings.local.json"))
        config.allowPatterns = ["Edit"]
        #expect(PermissionCardOptions(request: config) == PermissionCardOptions(request: nested))

        app.handle(.permissionRequest(nested))
        app.handle(.state(running(seq: 1, queue: [nested])))
        // ⌥⌘↩ does nothing for it, and "remember" never rides on its allow.
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: .composer(draft: ""), target: nested) == .none)
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: .permissionCard(requestId: "N1"), target: nested) == .none)
        app.respondPermission(requestId: "N1", allow: true, remember: true)
        #expect(sent == [.permissionResponse(requestId: "N1", allow: true, remember: false)])

        // A plain Bash card offers both; SendMessage only send / deny.
        let plain = PermissionCardOptions(request: bash("P1", "npm test -- --watch"))
        #expect(plain.allowsRemember && plain.showsAlwaysAllow && plain.alwaysAllowPatterns == ["Bash(npm test:*)"])
        let chained = PermissionCardOptions(request: bash("P2", "npm test && rm -rf build"))
        #expect(chained.showsAlwaysAllow && chained.alwaysAllowPatterns.isEmpty)   // shown, disabled with the reason
        let send = PermissionRequest(requestId: "S1", toolName: "SendMessage", input: .object([
            "to": .string("acme-b4"), "summary": .string("#514 done"), "message": .string("All tests pass."),
        ]))
        let sendOptions = PermissionCardOptions(request: send)
        #expect(sendOptions.layout == .sendMessage && !sendOptions.allowsRemember && !sendOptions.showsAlwaysAllow)
        #expect(SendMessageCardContent(request: send) == SendMessageCardContent(request: PermissionRequest(
            requestId: "S2", toolName: "SendMessage", input: .object(["recipient": .string("acme-b4"), "summary": .string("#514 done"),
                                                                       "message": .string("All tests pass.")]))))
        #expect(SendMessageCardContent(request: send).to == "acme-b4" && SendMessageCardContent(request: send).message == "All tests pass.")
    }

    // MARK: §6 point 5

    @Test func alwaysAllowInProjectSavesTheMcpPatternPushesItThenAllows() throws {
        let (app, defaults) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let request = PermissionRequest(requestId: "M1", toolName: "mcp__github__get_issue", input: .object(["issue_number": .string("1")]),
                                        file: nil, toolUseId: "t1", allowPatterns: ["mcp__github__get_issue", "mcp__github__*"])
        app.handle(.permissionRequest(request))
        app.handle(.state(running(seq: 1, queue: [request])))
        let options = PermissionCardOptions(request: request)
        #expect(options.showsAlwaysAllow && options.alwaysAllowPatterns == request.allowPatterns)
        #expect(options.alwaysAllowPatterns.map(AllowPatternLabel.text) == ["Only this tool (get_issue)", "The whole github server"])

        app.alwaysAllowInProject(requestId: "M1", pattern: "mcp__github__*")
        #expect(app.projectAllowPatterns == ["mcp__github__*"])
        #expect(AppSettings.effectiveBashAllowPatterns(root: "/repo", defaults: defaults) == ["mcp__github__*"])
        // Order: the pattern reaches the engine first (it answers what the pattern covers), then this card's answer.
        #expect(sent.count == 2)
        guard case let .setSettings(settings)? = sent.first else { Issue.record("no set_settings first: \(sent)"); return }
        #expect(settings.bashAllowPatterns == ["mcp__github__*"])
        #expect(sent.last == .permissionResponse(requestId: "M1", allow: true))
        #expect(card(app, "M1") == .allowed)
        // The card is gone: a second click says so and sends nothing.
        app.alwaysAllowInProject(requestId: "M1", pattern: "mcp__github__*")
        #expect(sent.count == 2 && app.permissionNotice?.text == PermissionNotice.alreadyHandled.text)
    }

    // MARK: §6 point 6

    /// §36.6 (integration): a local rule while "Load local settings" is off reads in words, like the user-settings one.
    @Test func aLocalRuleWhileLocalSettingsAreOffHasWords() {
        #expect(UserPermissionRule.Why(rawValue: "local_settings_off") == .localSettingsOff)
        let rule = UserPermissionRule(rule: "Bash(rm:*)", source: .local, status: .ignored, why: .localSettingsOff, importAs: nil)
        #expect(rule.whyText == "Loading local settings is off")
    }

    @Test func terminalRulesLoadAndImportIntoTheAllowLists() async throws {
        let (app, defaults) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let reply = PermissionRulesReply(
            sources: [PermissionRuleSource(scope: .user, path: "~/.claude/settings.json", exists: true),
                      PermissionRuleSource(scope: .local, path: "/repo/.claude/settings.local.json", exists: false)],
            rules: [UserPermissionRule(rule: "mcp__github", source: .user, status: .applied, why: .readMcpTools, importAs: "mcp__github__*"),
                    UserPermissionRule(rule: "Bash(./gradlew:*)", source: .local, status: .ignored, why: .bash, importAs: "Bash(./gradlew:*)"),
                    UserPermissionRule(rule: "Edit", source: .project, status: .ignored, why: .editTool, importAs: nil)],
            defaultMode: "auto", defaultModeSupported: true)
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            return .permissionRules(reply)
        }
        // Without a project there is nothing to ask.
        await app.loadPermissionRules()
        #expect(asked.isEmpty && app.permissionRulesError == EngineMessages.refusal(error: "no_project"))

        app.handle(.state(running(seq: 1, queue: [], phase: .reviewing)))
        await app.loadPermissionRules()
        #expect(asked == [.permissionRules])
        #expect(app.permissionRules == reply && app.permissionRulesError == nil && !app.isLoadingPermissionRules)
        #expect(reply.sources[1].problemText == "Missing" && reply.sources[0].problemText == nil)
        #expect(reply.rules.map(\.whyText) == ["Applied to its read tools only",
                                               "Commands go through the review gate first — importing adds it as an app allow pattern",
                                               "Edits are always reviewed"])

        // Import into the global list: appended once, pushed to the engine; the settings files are never touched.
        let picked = reply.rules.compactMap(\.importAs)
        #expect(app.importAllowPatterns(picked, toProject: false) == picked)
        #expect(AppSettings.bashAllowPatterns(defaults: defaults) == picked)
        guard case let .setSettings(settings)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(settings.bashAllowPatterns == picked)
        let count = sent.count
        #expect(app.importAllowPatterns(["mcp__github__*"], toProject: false).isEmpty && sent.count == count)
        // Into this project's list.
        #expect(app.importAllowPatterns(["WebFetch(domain:docs.spring.io)"], toProject: true) == ["WebFetch(domain:docs.spring.io)"])
        #expect(app.projectAllowPatterns == ["WebFetch(domain:docs.spring.io)"])
        #expect(AppSettings.effectiveBashAllowPatterns(root: "/repo", defaults: defaults) == picked + ["WebFetch(domain:docs.spring.io)"])

        // A refusal is kept in words.
        app.replySink = { _ in throw EngineClientError.refused("no_project", code: "no_project") }
        await app.loadPermissionRules()
        #expect(app.permissionRulesError == EngineMessages.refusal(error: "no_project"))
    }

    @Test func importRiskMarksDangerousBashOnly() {
        for risky in ["Bash", "Bash(*)", "Bash(rm -rf:*)", "Bash(git push:*)", "Bash(git:*)", "Bash(sudo make)", "Bash(curl:*)", "Bash(git reset --hard)"] {
            #expect(PermissionRuleRisk.isRisky(risky), "\(risky)")
        }
        for calm in ["Bash(./gradlew:*)", "Bash(npm test:*)", "Bash(git status)", "Bash(make)", "mcp__github__*", "WebFetch(domain:docs.spring.io)"] {
            #expect(!PermissionRuleRisk.isRisky(calm), "\(calm)")
        }
        #expect(UserPermissionRule(rule: "Bash(rm:*)", source: .local, status: .ignored, why: .bash, importAs: "Bash(rm:*)").importIsRisky)
        #expect(!UserPermissionRule(rule: "Edit", source: .local, status: .ignored, why: .editTool).importIsRisky)
    }

    // MARK: §6 point 7

    @Test func worktreePermissionSwitchesReachTheEngine() throws {
        let (app, defaults) = makeState()
        // Unset: isolation off, the terminal's rules on, persistence off — and `hello` carries all three.
        var hello = AppSettings.engineSettings(defaults: defaults)
        #expect(hello.allowWorktreeIsolation == false && hello.applyUserAllowRules == true && hello.persistSessionAllows == false)
        defaults.set(true, forKey: AppSettings.Key.persistSessionAllows)
        defaults.set(false, forKey: AppSettings.Key.applyUserAllowRules)
        defaults.set(true, forKey: AppSettings.Key.allowWorktreeIsolation)
        hello = AppSettings.engineSettings(defaults: defaults)
        #expect(hello.persistSessionAllows == true && hello.applyUserAllowRules == false && hello.allowWorktreeIsolation == true)

        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.pushWorktreePermissionSettings()
        #expect(sent == [.setSettings(AppSettings.worktreePermissionSettings(defaults: defaults))])
        let wire = try #require(try JSONSerialization.jsonObject(with: NDJSON.encodeLine(EngineCommandEnvelope(command: sent[0]))) as? [String: Any])
        #expect((wire["settings"] as? [String: Any]).map { Set($0.keys) } == ["allowWorktreeIsolation", "applyUserAllowRules", "persistSessionAllows"])

        // What the engine restored from the worktree's allows.json shows as it comes; "모두 지우기" sends forget_allows.
        var restored = running(seq: 1, queue: [], phase: .reviewing)
        restored.session.rememberedAllows = ["Bash:npm test", "WebFetch:WebFetch"]
        app.handle(.state(restored))
        #expect(app.rememberedAllows.map(RememberedAllowText.text) == ["Bash · npm test", "WebFetch"])
        app.forgetAllows()
        #expect(sent.last == .forgetAllows && app.rememberedAllows.isEmpty)
    }

    // MARK: §6 point 29

    @Test func thePeerTurnBadgeNamesTheSenders() {
        let (app, _) = makeState()
        #expect(app.peerTurnBadge == nil)
        app.handle(.state(running(seq: 1, queue: [], peerTurn: PeerTurnInfo(messageIds: ["m1", "m2"], fromNames: ["acme-b4", " acme-63 "]))))
        #expect(app.peerTurnBadge == "Requested by acme-b4, acme-63")
        #expect(PeerTurnText.badge(PeerTurnInfo(messageIds: ["m"], fromNames: [""])) == "Requested by another session")
        app.handle(.state(running(seq: 2, queue: [])))
        #expect(app.peerTurnBadge == nil)
    }

    // MARK: §6 point 31

    @Test func anEngineWithOnlyTheSingleSlotStillDrainsFirstInFirstOut() throws {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let slots = PermissionWireTests.queueJSON
        for (seq, slot) in slots.enumerated() {
            var state = try PermissionWireTests.snapshot("state.reviewing.json") { session in
                session.removeValue(forKey: "pendingPermissions")
                session["pendingPermission"] = slot
            }
            state.seq = 100 + seq
            app.handle(.state(state))
            let id = try #require(slot["requestId"] as? String)
            // No event was seen for it: the snapshot alone gives it a card.
            #expect(card(app, id) == .open)
            app.respondPermission(requestId: id, allow: seq != 1)
            #expect(sent.last == .permissionResponse(requestId: id, allow: seq != 1))
        }
        var done = try PermissionWireTests.snapshot("state.reviewing.json") { session in session.removeValue(forKey: "pendingPermissions") }
        done.seq = 200
        app.handle(.state(done))
        #expect(app.openPermissions.isEmpty)
        #expect(sent.count == slots.count)
    }

    // MARK: Refusals, withdrawn requests, questions

    @Test func aRefusedAnswerSaysSoAndLeavesTheCardHandledOrOpenAgain() async {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { command in
            sent.append(command)
            throw EngineClientError.refused("unknown_permission_request", code: "unknown_permission_request")
        }
        let r1 = bash("R1", "make a")
        app.handle(.permissionRequest(r1))
        app.handle(.state(running(seq: 1, queue: [r1])))
        app.respondPermission(requestId: "R1", allow: true)
        #expect(card(app, "R1") == .allowed)   // decided at once…
        await waitUntil { app.permissionNotice != nil }
        // …and when the engine says the request was not open, the card reads "처리됨" with a toast.
        #expect(sent == [.permissionResponse(requestId: "R1", allow: true)])
        #expect(app.permissionNotice?.text == PermissionNotice.alreadyHandled.text)
        #expect(card(app, "R1") == .handled)
        #expect(EngineMessages.refusal(error: "unknown_permission_request") == PermissionNotice.alreadyHandled.text)

        // Any other refusal: the request is still open in the engine, so the card can be answered again.
        app.dismissPermissionNotice()
        let r2 = bash("R2", "make b")
        app.handle(.permissionRequest(r2))
        app.handle(.state(running(seq: 2, queue: [r2])))
        app.requestSink = { _ in throw EngineClientError.refused("gate_closed:reverting", code: "gate_closed") }
        app.respondPermission(requestId: "R2", allow: false)
        await waitUntil { app.permissionNotice != nil }
        #expect(card(app, "R2") == .open && app.shortcutPermission?.requestId == "R2")

        // A card whose request is gone sends nothing and says so.
        app.dismissPermissionNotice()
        var count = sent.count
        app.requestSink = { command in sent.append(command) }
        app.respondPermission(requestId: "R1", allow: true)
        #expect(sent.count == count && app.permissionNotice?.text == PermissionNotice.alreadyHandled.text)
        count = sent.count
        app.respondPermission(requestId: "R2", allow: true)
        await waitUntil { sent.count > count }
        #expect(sent.last == .permissionResponse(requestId: "R2", allow: true) && card(app, "R2") == .allowed)
    }

    @Test func aRequestThatLeavesTheQueueWithoutAnAnswerReadsHandled() {
        let (app, _) = makeState()
        let r1 = bash("R1", "./gradlew test --tests A", agent: executor)
        let r2 = bash("R2", "./gradlew test --tests B", agent: tester)
        // The event alone opens the card (the snapshot follows it).
        app.handle(.permissionRequest(r1))
        #expect(card(app, "R1") == .open)
        // A request whose event was missed still gets a card from the snapshot.
        app.handle(.state(running(seq: 1, queue: [r1, r2])))
        #expect(card(app, "R2") == .open)
        app.handle(.permissionRequest(r2))   // its late event adds no second card
        #expect(app.transcript.filter { if case let .permission(_, r, _) = $0 { return r.requestId == "R2" }; return false }.count == 1)
        // The engine answered R2 itself (a remembered key / a saved pattern covered it), or the CLI withdrew it.
        app.handle(.state(running(seq: 2, queue: [r1])))
        #expect(card(app, "R2") == .handled && card(app, "R1") == .open)
        // The turn's end clears what is left.
        app.handle(.state(running(seq: 3, queue: [], phase: .reviewing)))
        #expect(card(app, "R1") == .handled && app.openPermissions.isEmpty)
    }

    @Test func aQuestionCardAnswersItsOwnRequestWhereverItSits() {
        let (app, _) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let r1 = bash("R1", "make")
        let q1 = question("Q1")
        app.handle(.permissionRequest(r1))
        app.handle(.permissionRequest(q1))
        app.handle(.state(running(seq: 1, queue: [r1, q1])))
        // The old entry point only answers a question at the head of the queue.
        app.answerQuestions(answers: ["Which?": "a"])
        #expect(sent.isEmpty)
        app.answerQuestions(requestId: "Q1", answers: ["Which?": "b"])
        guard case let .permissionResponse(id, allow, _, updated, _)? = sent.last else { Issue.record("no answer"); return }
        #expect(id == "Q1" && allow && updated?["answers"] == .object(["Which?": .string("b")]))
        #expect(card(app, "Q1") == .allowed && card(app, "R1") == .open)
        let q2 = question("Q2")
        app.handle(.permissionRequest(q2))
        app.skipQuestions(requestId: "Q2")
        #expect(sent.last == .permissionResponse(requestId: "Q2", allow: false, message: "User skipped the questions"))
        // Answering a Bash request as a question does nothing.
        let count = sent.count
        app.answerQuestions(requestId: "R1", answers: [:])
        #expect(sent.count == count && app.isPermissionOpen("R1"))
    }

    // MARK: Card words, agents, workbenches

    @Test func cardWordsAgentChipReasonLinesAndShortPaths() {
        #expect(PermissionAgentLabel.text(nil) == "Main agent")
        #expect(PermissionAgentLabel.text(executor) == "🧩 executor · compile")
        #expect(PermissionAgentLabel.text(PermissionAgent(agentId: "x", subagentType: "linter")) == "🧩 linter")
        #expect(PermissionAgentLabel.text(PermissionAgent(agentId: "x")) == "🧩 Subagent")

        #expect(PermissionReasonText.shortPath("/Users/me/repo/.claude/worktrees/wt1") == "worktrees/wt1")
        #expect(PermissionReasonText.shortPath("/repo/.claude/settings.local.json") == ".claude/settings.local.json")
        #expect(PermissionReasonText.shortPath("/repo") == "repo" && PermissionReasonText.shortPath("a/b") == "a/b")

        let nested = PermissionReason(code: .nestedRepository, message: "x", path: "/Users/me/repo/.claude/worktrees/wt1")
        #expect(PermissionReasonText.line(nested).hasSuffix("(worktrees/wt1)") && PermissionReasonText.level(nested) == .caution)
        let config = PermissionReason(code: .claudeConfig, message: "x", path: "/repo/.claude/settings.local.json")
        #expect(PermissionReasonText.line(config).contains("(.claude/settings.local.json)") && PermissionReasonText.level(config) == .danger)
        #expect(!PermissionReasonText.line(PermissionReason(code: .otherWorktree)).contains("()"))
        #expect(PermissionReasonText.level(PermissionReason(code: .worktreeCommand, path: "/w")) == .danger)
        // §46: a git command that changes the repository — known on the wire, red, its own line.
        let git = PermissionReason(code: .init(rawValue: "git_command"), message: "x")
        #expect(git.code == .gitCommand && git.code.rawValue == "git_command")
        #expect(PermissionReasonText.line(git).hasPrefix("A git command that changes the repository") && PermissionReasonText.level(git) == .danger)
        #expect(PermissionReasonText.line(PermissionReason(code: .other("new"), message: " ")) == "Works somewhere this window's review does not see")
        // An unknown code (a newer engine) shows the engine's own words.
        #expect(PermissionReasonText.line(PermissionReason(code: .other("brand_new_place"), message: "Somewhere new")) == "Somewhere new")
        #expect(PermissionReasonText.level(PermissionReason(code: .other("brand_new_place"))) == .caution)

        #expect(AllowPatternLabel.text("WebFetch(domain:docs.spring.io)") == "This domain (docs.spring.io)")
        #expect(AllowPatternLabel.text("mcp__mysql") == "The whole mysql server")
        #expect(AllowPatternLabel.text("WebSearch") == "WebSearch" && AllowPatternLabel.text("Bash(make)") == "Bash(make)")
        #expect(AllowPatternLabel.kind("mcp__a__b") == .mcpTool && AllowPatternLabel.kind("mcp__a__*") == .mcpServer
                && AllowPatternLabel.kind("Bash(x)") == .bash && AllowPatternLabel.kind("WebFetch(domain:x)") == .webFetchDomain
                && AllowPatternLabel.kind("Agent") == .other)
    }

    @Test func agentsWaitingAndTheWorkbenchAReasonNames() {
        let (app, _) = makeState()
        let r1 = bash("R1", "make", agent: executor)
        let main = bash("R2", "ls -la /")
        var s = running(seq: 1, queue: [r1, main])
        s.workbenches = WorkbenchesInfo(list: [
            WorkbenchInfo(path: "/repo", branch: "main", head: "a", isMain: true, isCurrent: true, locked: nil, dirty: false),
            WorkbenchInfo(path: "/wt/acme-4821", branch: "feat", head: "b", isMain: false, isCurrent: false, locked: nil, dirty: false),
        ], current: "/repo", managedRoot: "/wt")
        app.handle(.state(s))
        #expect(app.pendingPermission(forAgent: "agA")?.requestId == "R1")
        #expect(app.pendingPermission(forAgent: "agB") == nil)
        #expect(app.workbench(forPath: "/wt/acme-4821/")?.branch == "feat")
        #expect(app.workbench(forPath: "/repo") == nil)   // this window's own worktree
        #expect(app.workbench(forPath: "/elsewhere") == nil && app.workbench(forPath: nil) == nil)
    }

    // MARK: The terminal's default mode (§2.8)

    @Test func theTerminalsDefaultModeIsOfferedOncePerProject() async {
        let (app, defaults) = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var replies = 0
        app.replySink = { _ in
            replies += 1
            return .permissionRules(PermissionRulesReply(defaultMode: "auto", defaultModeSupported: true))
        }
        app.handle(.state(running(seq: 1, queue: [], phase: .reviewing)))
        await app.checkDefaultModeOffer()
        #expect(app.defaultModeOffer == .auto && replies == 1)
        // [아니요] is remembered: never asked again for this project.
        app.declineDefaultModeOffer()
        #expect(app.defaultModeOffer == nil && AppSettings.defaultModeOffered(root: "/repo", defaults: defaults))
        await app.checkDefaultModeOffer()
        #expect(app.defaultModeOffer == nil && replies == 1)
        #expect(AppState.defaultModeToOffer(PermissionRulesReply(defaultMode: "auto", defaultModeSupported: true), current: .auto) == nil)
        #expect(AppState.defaultModeToOffer(PermissionRulesReply(defaultMode: "bypassPermissions"), current: .default) == nil)
        #expect(AppState.defaultModeToOffer(nil, current: .default) == nil)

        // [예] on another project: remembered, and the idle session switches.
        let (other, otherDefaults) = makeState()
        var otherSent: [EngineCommand] = []
        other.commandSink = { otherSent.append($0) }
        other.replySink = { _ in .permissionRules(PermissionRulesReply(defaultMode: "acceptEdits", defaultModeSupported: true)) }
        other.handle(.state(running(seq: 1, queue: [], phase: .reviewing)))
        await other.checkDefaultModeOffer()
        #expect(other.defaultModeOffer == .acceptEdits && other.canSetPermissionMode)
        other.acceptDefaultModeOffer()
        #expect(otherSent.last == .setPermissionMode(mode: .acceptEdits) && other.defaultModeOffer == nil)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: otherDefaults) == .acceptEdits)
        #expect(AppSettings.defaultModeOffered(root: "/repo", defaults: otherDefaults))
        _ = sent
    }
}
