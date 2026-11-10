import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §19: error / refusal codes on the wire, their user-facing words, the forced whole-file reject and
/// the plan answer as request/reply.
@Suite @MainActor struct EngineMessagesTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "EngineMessagesTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .reviewing, files: [ChangedFile] = [], starting: Bool = false,
                          plan: PendingPlan? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: starting, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        s.session.pendingPlan = plan
        s.gate = GateInfo(phase: phase, canSend: phase == .reviewing || phase == .idle, canRequestChanges: false, blockedReason: nil,
                          collectError: nil, pendingCount: files.count, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: files.isEmpty ? nil : "B1", lastReviewSummary: nil,
                          changedOutside: [], ignoredTouched: [], filteredByPattern: [], restored: false)
        s.changedFiles = files
        return s
    }

    private func file(_ path: String) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending)
    }

    // MARK: - Decoding (§19.1, §19.6)

    @Test func decodesResultCodeAndPaths() throws {
        let refused = try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"r","ok":false,"error":"file_changed_since_review:a.txt, b c.txt","code":"file_changed_since_review","paths":["a.txt","b c.txt"]}"#)
        #expect(refused == .result(id: "r", ok: false, error: "file_changed_since_review:a.txt, b c.txt",
                                   code: "file_changed_since_review", paths: ["a.txt", "b c.txt"]))
        #expect(refused.replyId == "r")
        // Older engines: no code / paths; a malformed paths value is ignored instead of failing the line.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"o","ok":false,"error":"gate_closed:running"}"#)
                == .result(id: "o", ok: false, error: "gate_closed:running", code: nil, paths: nil))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"m","ok":false,"error":"x","code":"brand_new","paths":"nope"}"#)
                == .result(id: "m", ok: false, error: "x", code: "brand_new", paths: nil))
    }

    @Test func decodesErrorDetailTolerantly() throws {
        let retry = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"API retry 2/10","fatal":false,"scope":"session","code":"api_retrying","attempt":2,"maxRetries":10,"retryDelayMs":1500,"status":null}"#)
        #expect(retry == .error(message: "API retry 2/10", fatal: false, scope: .session,
                                detail: EngineErrorDetail(code: "api_retrying", attempt: 2, maxRetries: 10, retryDelayMs: 1500, status: nil)))
        let limit = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"Usage limit","fatal":false,"scope":"session","code":"usage_limit","resetAt":"2026-10-20T15:30:00.000Z"}"#)
        guard case let .error(_, _, _, detail) = limit else { Issue.record("not an error"); return }
        #expect(detail.code == "usage_limit" && detail.resetDate == Date(timeIntervalSince1970: 1_792_510_200))
        // Unknown code, wrong-typed fields and an unknown scope still decode.
        let odd = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"m","fatal":true,"scope":"cosmic","code":"from_the_future","status":"500","attempt":"x"}"#)
        #expect(odd == .error(message: "m", fatal: true, scope: .engine, detail: EngineErrorDetail(code: "from_the_future")))
        #expect(odd.isFatalError)
    }

    @Test func clientErrorCarriesCodeAndPaths() {
        let modern = EngineClientError.refused("file_changed_since_review:a", code: "file_changed_since_review", paths: ["a"])
        #expect(modern.refusalCode == "file_changed_since_review")
        #expect(modern.userMessage == EngineMessages.refusal(code: "file_changed_since_review", error: "x", paths: ["a"]))
        #expect(modern.errorDescription == "file_changed_since_review:a")   // the raw text stays for logs / older parsers
        #expect(EngineClientError.refused("empty message").refusalCode == "empty_message")
        #expect(EngineClientError.refused("session_busy").userMessage == AppState.sessionRefusalText("session_busy"))
        #expect(EngineClientError.exited.refusalCode == nil)
    }

    // MARK: - Words

    nonisolated static let refusalCodes = [
        "binary_file", "branch_in_use:/w", "cannot_remove_current", "cannot_remove_main", "collect_failed", "commit_failed",
        "detached_head", "diff_mismatch", "empty_base", "empty_message", "empty_note", "empty_title", "engine_disposed",
        "file_changed_since_review", "gate_closed:running", "git_identity_missing", "git_init_not_needed", "history_trees_gone",
        "invalid_branch_name:x y", "invalid_mode", "locked_by_other_session:12", "no_hunks", "no_plan", "no_project", "no_remote",
        "no_review", "no_session", "not_a_changed_file", "not_in_history_entry", "not_pending", "notes_pending", "nothing_to_commit",
        "nothing_to_push", "nothing_to_retry", "partial_reject_unsupported:A", "path_exists:/p", "plan_followup_failed:snapshot",
        "push_failed", "request_changes_unavailable:no_notes", "refresh_failed", "revert_failed", "branch_failed", "workbench_failed",
        "reverting", "review_pending", "session_busy", "session_current", "session_running", "stale_diff", "starting",
        "switch_blocked:pending", "unknown_command", "unknown_history_entry", "unknown_hunk", "unknown_pr_file", "unknown_worktree",
        "unsupported_remote:x", "worktree_dirty", "worktree_locked:3", "command_failed",
        // §21
        "empty_question", "question_too_long", "unknown_side_thread:abc", "side_busy", "side_limit", "side_no_answer",
        "side_no_anchor", "side_draft_failed:empty answer", "invalid_promote", "send_failed", "cli_not_found", "cli_not_executable",
        // §35.1: a send whose snapshot A failed for want of git-lfs
        "lfs_missing:git-lfs filter is missing",
        // §22
        "invalid_mcp_name:-x", "invalid_mcp_scope", "invalid_mcp_config:env key", "unknown_mcp_server:x", "mcp_unsupported",
        "mcp_failed:boom", "mcp_cli_failed:boom", "terminal_failed:no terminal",
        // The note edit and the project search (code browser)
        "note_not_editable", "invalid_query", "search_failed:fatal: bad pattern", "search_failed",
    ]

    /// §35.1: the refused send says what the error banner said (the install command).
    @Test func lfsMissingRefusalReadsLikeItsBanner() {
        #expect(EngineMessages.refusal(code: "lfs_missing", error: "lfs_missing:git-lfs filter is missing") == SessionNotices.lfsMissingText)
    }

    @Test(arguments: refusalCodes)
    func everyRefusalCodeHasWords(_ raw: String) {
        let code = EngineMessages.codeWord(raw)
        let text = EngineMessages.refusal(code: code, error: raw)
        #expect(!text.isEmpty)
        #expect(text != raw && !text.hasPrefix(code), "\(raw) is shown as its code")
    }

    @Test func refusalWordsUseTheCodeAndItsDetail() {
        #expect(EngineMessages.refusal(error: "empty message") == EngineMessages.refusal(code: "empty_message", error: "x"))
        #expect(EngineMessages.refusal(error: "unknown command: zap") == EngineMessages.refusal(code: "unknown_command", error: ""))
        #expect(EngineMessages.refusal(error: "branch_in_use:/w/feat").contains("/w/feat"))
        #expect(EngineMessages.refusal(code: "commit_failed", error: "fatal: bad object").contains("fatal: bad object"))
        #expect(EngineMessages.refusal(code: "search_failed", error: "search_failed:fatal: bad pattern").hasSuffix("fatal: bad pattern"))
        #expect(EngineMessages.refusal(code: "file_changed_since_review", error: "file_changed_since_review:a, b", paths: ["a", "b"])
                .hasSuffix("a, b"))
        #expect(EngineMessages.refusal(error: "gate_closed:awaiting_permission") != EngineMessages.refusal(error: "gate_closed:running"))
        // Bare `collect_failed` (send blocked) vs a failed collection with its git text.
        #expect(EngineMessages.refusal(error: "collect_failed") == AppState.sessionRefusalText("collect_failed"))
        #expect(EngineMessages.refusal(code: "collect_failed", error: "git exploded").contains("git exploded"))
        // Unknown codes, and `refused` without a code word, show the engine's text.
        #expect(EngineMessages.refusal(code: "brand_new", error: "Something new happened") == "Something new happened")
        #expect(EngineMessages.refusal(code: "refused", error: "nope") == "nope")
        // The other mappers fall back to the same words.
        #expect(HunkRefusal.from("no_session").message == EngineMessages.refusal(error: "no_session"))
        #expect(ReviewHistoryText.refusal("engine disposed") == EngineMessages.refusal(error: "engine_disposed"))
    }

    nonisolated static let errorCodes = [
        "auth_required", "usage_limit", "rate_limited", "api_error", "api_retrying", "cli_start_slow", "session_crashed",
        "cli_not_found", "cli_not_executable", "session_start_failed", "send_failed", "plan_followup_failed", "extensions_init_timeout",
        "unprompted_blocked", "project_open_failed", "git_init_failed", "collect_failed", "refresh_failed", "revert_failed",
        "branch_failed", "workbench_failed", "commit_failed", "command_failed", "side_failed", "mcp_auth_required", "mcp_failed",
    ]

    @Test(arguments: errorCodes)
    func everyErrorCodeHasWords(_ code: String) {
        let message = "Failed to do it: the CLI said no"
        let text = EngineMessages.error(message: message, detail: EngineErrorDetail(code: code))
        #expect(!text.isEmpty && text != message, "\(code) shows the engine's English text")
    }

    /// A project folder whose `.git` is gone (macOS sweeps /tmp) is said in words, not as git's `add -A` command line.
    @Test func noLongerARepositoryInWords() {
        let git = "snapshot A failed: git -c core.excludesFile=/var/folders/x/rg-excludes-1 add -A failed (exit 128): "
            + "fatal: not a git repository (or any of the parent directories): .git"
        let sent = EngineMessages.error(message: git, detail: EngineErrorDetail(code: "send_failed"))
        #expect(sent.hasPrefix("Could not send the message to Claude: this folder is no longer a Git repository"))
        #expect(!sent.contains("add -A") && sent.contains("/tmp"))
        #expect(EngineMessages.refusal(error: "send_failed:\(git)").contains("no longer a Git repository"))
        #expect(EngineMessages.error(message: "Failed to collect changes: \(git)", detail: EngineErrorDetail(code: "collect_failed"))
                .hasPrefix("Could not collect the changes: this folder is no longer a Git repository"))
        #expect(EngineMessages.refusal(error: "send_failed:boom") == "Could not send the message to Claude: boom")
    }

    @Test func errorWordsCarryTheirDetail() {
        let utc = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_792_490_000)   // 2026-10-20 09:53 UTC
        let reset = EngineErrorDetail(code: "usage_limit", resetAt: "2026-10-20T15:30:00Z")
        let text = EngineMessages.error(message: "m", detail: reset, timeZone: utc, locale: Locale(identifier: "en_US"), now: now)
        #expect(text.hasPrefix("Usage limit reached — resets at ") && text.contains("3:30"))
        #expect(!text.contains("2026"))   // today: the time alone
        let tomorrow = EngineMessages.resetTime(reset, timeZone: utc, locale: Locale(identifier: "en_US"), now: now.addingTimeInterval(-86_400))
        #expect(tomorrow?.contains("2026") == true)
        #expect(EngineMessages.error(message: "m", detail: EngineErrorDetail(code: "usage_limit")) == "Usage limit reached")
        #expect(EngineMessages.error(message: "m", detail: EngineErrorDetail(code: "usage_limit", resetAt: "soon")) == "Usage limit reached")
        #expect(EngineMessages.error(message: "m", detail: EngineErrorDetail(code: "api_error", status: 529)).contains("529"))
        #expect(EngineMessages.error(message: "m", detail: EngineErrorDetail(code: "api_retrying", attempt: 2, maxRetries: 10)) == "Retrying (2/10)…")
        #expect(EngineMessages.retryText(EngineErrorDetail(code: "api_retrying")) == "Retrying…")
        #expect(EngineMessages.error(message: "Failed to collect changes: fatal: x", detail: EngineErrorDetail(code: "collect_failed"))
                == "Could not collect the changes: fatal: x")
        // Unknown / absent code → the engine's message.
        #expect(EngineMessages.error(message: "Weird thing", detail: EngineErrorDetail(code: "from_the_future")) == "Weird thing")
        #expect(EngineMessages.error(message: "Plain", detail: EngineErrorDetail()) == "Plain")
        #expect(EngineMessages.actions(for: "auth_required") == [.login])
        #expect(EngineMessages.actions(for: "session_crashed") == [.restartSession])
        #expect(EngineMessages.actions(for: "cli_not_found").contains(.openSettings))
        #expect(EngineMessages.actions(for: "usage_limit").isEmpty)
        #expect(EngineMessages.actions(for: "cli_not_executable") == [.openSettings])
    }

    @Test func claudeLoginCommandIsQuoted() {
        #expect(TerminalLauncher.claudeLoginCommand(claudePath: nil) == "'claude' /login")
        #expect(TerminalLauncher.claudeLoginCommand(claudePath: "/Users/me/it's/claude") == "'/Users/me/it'\\''s/claude' /login")
        let script = TerminalLauncher.script(for: "'claude' /login", path: "/opt/bin:/usr/bin")
        #expect(script.hasPrefix("#!/bin/zsh -l\nexport PATH='/opt/bin:/usr/bin'\n'claude' /login\n"))
    }

    // MARK: - AppState presentation

    @Test func retryAndSlowStartAreTransientNotBanners() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.handle(.error(message: "retry", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "api_retrying", attempt: 2, maxRetries: 10, retryDelayMs: 500)))
        #expect(app.transientNotice == TransientNotice(kind: .retrying, text: "Retrying (2/10)…"))
        #expect(app.errorBanner == nil && app.transcript.isEmpty && app.lastError == nil)
        app.handle(.error(message: "retry", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "api_retrying", attempt: 3, maxRetries: 10)))
        #expect(app.transientNotice?.text == "Retrying (3/10)…")
        app.handle(.textDelta(text: "ok"))   // the retry worked
        #expect(app.transientNotice == nil)

        app.handle(.error(message: "retry", fatal: false, scope: .session, detail: EngineErrorDetail(code: "api_retrying", attempt: 1)))
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))   // the turn ended
        #expect(app.transientNotice == nil)

        app.handle(.state(snapshot(seq: 3, phase: .starting, starting: true)))
        app.handle(.error(message: "slow", fatal: false, scope: .session, detail: EngineErrorDetail(code: "cli_start_slow")))
        #expect(app.transientNotice?.kind == .slowStart && app.errorBanner == nil)
        app.handle(.state(snapshot(seq: 4, phase: .idle)))   // started
        #expect(app.transientNotice == nil)
    }

    @Test func bannersAreLocalizedWithActions() {
        let app = makeState()
        app.handle(.error(message: "Not logged in (Invalid API key · Please run /login)", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "auth_required", status: 401)))
        #expect(app.errorBanner?.message == "Claude login is required")
        #expect(app.errorBanner?.actions == [.login] && app.errorBanner?.code == "auth_required")
        #expect(app.lastError == "Claude login is required")
        #expect(app.logs.contains { $0.contains("Invalid API key") })   // the engine's text stays in the log

        app.handle(.error(message: "query loop threw", fatal: true, scope: .session, detail: EngineErrorDetail(code: "session_crashed")))
        // §30 (wave1 mac-session): a crash reconnects first and offers a new chat next to it.
        #expect(app.errorBanner?.fatal == true && app.errorBanner?.actions == [.restartSession, .newChat])

        app.handle(.error(message: "Something new", fatal: false, scope: .git, detail: EngineErrorDetail(code: "from_the_future")))
        #expect(app.errorBanner == ErrorBanner(message: "Something new", scope: .git, fatal: false, code: "from_the_future"))
    }

    // MARK: - §19.1 forced whole-file reject

    @Test func refusedRejectAsksThenForces() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt")])))
        // The snapshot selects a.txt and starts loading its diff from the (absent) engine; that load fails later
        // with its own error row, at a time that depends on the machine. Serve both diffs from the cache instead
        // (re-selecting cancels the load) so the only errors here are the ones the test provokes.
        for path in ["b.txt", "a.txt"] {
            app.showDiff(FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: []), truncated: false, endTree: "B1", for: path)
        }
        app.selectFile(file("a.txt"))
        var sent: [EngineCommand] = []
        app.requestSink = { command in
            sent.append(command)
            if case .reject(_, false) = command {
                throw EngineClientError.refused("file_changed_since_review:a.txt", code: "file_changed_since_review", paths: ["a.txt"])
            }
            if case .rejectAll(false, _) = command {
                throw EngineClientError.refused("file_changed_since_review:a.txt, b.txt") // an engine without code / paths
            }
        }
        app.reject(file("a.txt"))
        await eventually { app.forceRejectRequest != nil }
        #expect(app.forceRejectRequest == ForceRejectRequest(command: .reject(paths: ["a.txt"]), paths: ["a.txt"]))
        #expect(app.transcript.isEmpty)   // a question, not an error row

        // Cancel keeps everything: nothing else is sent.
        app.cancelForceReject()
        #expect(app.forceRejectRequest == nil && sent == [.reject(paths: ["a.txt"])])

        app.reject(file("a.txt"))
        await eventually { app.forceRejectRequest != nil }
        app.confirmForceReject()
        await eventually { sent.count == 3 }
        #expect(sent.last == .reject(paths: ["a.txt"], force: true))
        #expect(app.forceRejectRequest == nil)

        // reject_all, older engine: the paths come from the text.
        app.rejectAll()
        await eventually { app.forceRejectRequest != nil }
        #expect(app.forceRejectRequest?.paths == ["a.txt", "b.txt"])
        app.confirmForceReject()
        await eventually { sent.count == 5 }
        #expect(sent.last == .rejectAll(force: true))

        // Another refusal is an error row in the user's words.
        app.requestSink = { _ in throw EngineClientError.refused("session_running", code: "session_running") }
        app.reject(file("b.txt"))
        await eventually { app.lastError == AppState.sessionRefusalText("session_running") }
        #expect(app.lastError == AppState.sessionRefusalText("session_running") && app.forceRejectRequest == nil)
        #expect(app.transcript.count == 1)   // just that row: nothing else failed along the way
    }

    @Test func forceFlagIsOnTheWireOnlyWhenSet() throws {
        func json(_ c: EngineCommand) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommandEnvelope(command: c))) as! [String: Any]
        }
        #expect(try json(.reject(paths: ["a"])).keys.sorted() == ["paths", "type"])
        #expect(try json(.reject(paths: ["a"], force: true))["force"] as? Bool == true)
        #expect(try json(.rejectAll()).keys.sorted() == ["type"])
        #expect(try json(.rejectAll(force: true))["force"] as? Bool == true)
    }

    // MARK: - §19.5 plan answers

    @Test func planAnswerWaitsForTheTurnAndShowsRefusals() async {
        let app = makeState()
        let plan = PendingPlan(path: nil, plan: "# Plan")
        var sent: [EngineCommand] = []
        var refusal: EngineClientError? = .refused("gate_closed:collecting", code: "gate_closed")
        app.requestSink = { command in
            sent.append(command)
            if let refusal { throw refusal }
        }

        // Locked while the turn is collecting: nothing is sent, the card stays and says why.
        app.handle(.state(snapshot(seq: 1, phase: .collecting, plan: plan)))
        #expect(app.isPlanLocked)
        app.approvePlan()
        #expect(sent.isEmpty && app.pendingPlan == plan && app.planRefusal != nil)

        // Idle: a refused answer brings the card back with the engine's reason.
        app.handle(.state(snapshot(seq: 2, phase: .reviewing, plan: plan)))
        #expect(!app.isPlanLocked)
        app.approvePlan()
        await eventually { !app.isAnsweringPlan }
        #expect(sent == [.planResponse(approve: true, mode: .default, message: nil)])
        #expect(app.pendingPlan == plan)
        #expect(app.planRefusal == EngineMessages.refusal(error: "gate_closed:collecting"))

        // plan_followup_failed: the error event and the engine's restored plan keep the card with the reason.
        refusal = .refused("plan_followup_failed:snapshot failed", code: "plan_followup_failed")
        app.keepPlanning(message: "more detail")
        app.handle(.error(message: "The plan answer could not be sent to Claude (x); the plan is still pending.", fatal: false,
                          scope: .session, detail: EngineErrorDetail(code: "plan_followup_failed")))
        await eventually { !app.isAnsweringPlan }
        app.handle(.state(snapshot(seq: 3, plan: plan)))
        #expect(app.pendingPlan == plan && app.planRefusal?.contains("snapshot failed") == true)

        // Success clears the reason; the engine's snapshot without a plan closes the card.
        refusal = nil
        app.approvePlan(mode: .acceptEdits)
        #expect(app.isAnsweringPlan && app.isPlanLocked)
        await eventually { !app.isAnsweringPlan }
        app.handle(.state(snapshot(seq: 4)))
        #expect(app.pendingPlan == nil && app.planRefusal == nil)
    }

    @Test func aNormalSendDropsARefusedPlan() async {
        let app = makeState()
        let plan = PendingPlan(path: nil, plan: "p")
        app.requestSink = { _ in throw EngineClientError.refused("no_plan", code: "no_plan") }
        app.handle(.state(snapshot(seq: 1, plan: plan)))
        app.keepPlanning()
        await eventually { !app.isAnsweringPlan }
        app.handle(.state(snapshot(seq: 2)))
        #expect(app.pendingPlan == plan)   // shown again with the reason
        app.commandSink = { _ in }
        app.send("do something else")
        #expect(app.pendingPlan == nil && app.planRefusal == nil)
    }
}
