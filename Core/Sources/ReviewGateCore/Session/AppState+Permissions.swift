import Foundation

/// A short notice about a permission card, shown as a toast that goes away by itself (a new `id` shows it again).
public struct PermissionNotice: Sendable, Equatable, Identifiable {
    public var id = UUID()
    public var text: String

    public init(text: String) {
        self.text = text
    }

    /// `unknown_permission_request`, or a card whose request left the queue before the answer: "이미 처리된 권한 요청입니다".
    public static var alreadyHandled: PermissionNotice {
        PermissionNotice(text: String(localized: "This permission request was already handled", bundle: .module))
    }
}

// wave1 mac-perms — docs/PROTOCOL.md §33 on the Mac client: permission requests are a queue (parallel subagents ask at
// the same time), every card answers its own `requestId`, the shortcuts answer the oldest open card, a card whose request
// left the queue without this client's answer reads "처리됨"; "이 프로젝트에서 항상 허용" beyond Bash (§33.6),
// `permission_rules` and its import (§33.8), the §33.4 / §33.5 / §33.7 switches and the terminal's default mode.
extension AppState {
    // MARK: The queue (§33.1)

    /// Every open request, oldest first: the engine's queue minus what this client already answered.
    public var openPermissions: [PermissionRequest] { sessionInfo.permissionQueue }

    /// The card of `requestId` can still be answered.
    public func isPermissionOpen(_ requestId: String) -> Bool {
        openPermissions.contains { $0.requestId == requestId }
    }

    /// What ⌘↩ / ⌥⌘↩ / ⌘⌫ answer from the composer: the oldest open request that is not a question (a question card has
    /// its own keys). Its card draws the shortcut ring.
    public var shortcutPermission: PermissionRequest? {
        openPermissions.first { $0.toolName != AskUserQuestions.toolName }
    }

    /// The oldest open request the subagent spawned by `agentToolUseId` (`hud.agents[].toolUseId`) is waiting on.
    public func pendingPermission(forAgent agentToolUseId: String) -> PermissionRequest? {
        openPermissions.first { $0.agent?.agentToolUseId == agentToolUseId }
    }

    /// §29: "{fromNames} 요청" while the running turn is accepted peer messages.
    public var peerTurnBadge: String? { sessionInfo.peerTurn.map(PeerTurnText.badge) }

    /// The workbench (another worktree of this repository) a reason's `path` names, to open it in its own window.
    public func workbench(forPath path: String?) -> WorkbenchInfo? {
        guard let path, !path.isEmpty else { return nil }
        let target = URL(fileURLWithPath: path).standardizedFileURL.path
        return workbenches.list.first { !$0.isCurrent && URL(fileURLWithPath: $0.path).standardizedFileURL.path == target }
    }

    // MARK: r2-peers — M26: several waiting cards at once

    /// "대기 중 N개 모두 허용": the open requests it answers, oldest first (`PermissionCardOptions.bundle`) — empty unless two or
    /// more wait that may be answered together.
    public var permissionBundle: [PermissionRequest] { PermissionCardOptions.bundle(openPermissions) }

    /// Answers every request of `permissionBundle` with allow, each with its own `permission_response` (no engine change).
    public func allowWaitingPermissions() {
        for request in permissionBundle { respondPermission(requestId: request.requestId, allow: true) }
    }

    /// "이 에이전트의 요청은 이번 턴 동안 허용": the subagent's open requests are allowed now, and the ones it raises later are
    /// answered as they come until the turn ends — never a question, a SendMessage or a red card (`bundles`).
    public func allowAgentForTurn(_ agentId: String) {
        turnAllowedAgents.insert(agentId)
        for request in PermissionCardOptions.agentBundle(openPermissions, agentId: agentId) {
            respondPermission(requestId: request.requestId, allow: true)
        }
    }

    /// Whether the subagent's requests are answered by "이번 턴 동안 허용".
    public func isAgentAllowedForTurn(_ agentId: String?) -> Bool { agentId.map(turnAllowedAgents.contains) ?? false }

    /// `permission_request`: appended (the snapshot right behind it lists it too); a request already queued is refreshed.
    /// r2-peers (M26): one that "이번 턴 동안 허용" covers is answered at once — true: no one needs to be told.
    @discardableResult
    func enqueuePermission(_ request: PermissionRequest) -> Bool {
        var queue = openPermissions
        if let index = queue.firstIndex(where: { $0.requestId == request.requestId }) {
            queue[index] = request
        } else {
            queue.append(request)
        }
        answeredPermissionIds.remove(request.requestId)
        state.session.setPermissionQueue(queue)
        if undecidedPermissionRow(request.requestId) == nil {
            transcript.append(.permission(id: UUID(), request: request, allowed: nil))
        }
        if isAgentAllowedForTurn(request.agent?.agentId), PermissionCardOptions.bundles(request) {
            respondPermission(requestId: request.requestId, allow: true)
            return true
        }
        return false
    }

    /// After every snapshot: a request this client answered stays answered even when the snapshot was taken before the
    /// engine saw the answer; answers the engine confirmed (gone from its queue) are forgotten; a queued request whose
    /// event this client missed still gets its card.
    func reconcilePermissionQueue() {
        let queue = state.session.permissionQueue
        answeredPermissionIds.formIntersection(queue.map(\.requestId))
        let open = answeredPermissionIds.isEmpty ? queue : queue.filter { !answeredPermissionIds.contains($0.requestId) }
        state.session.setPermissionQueue(open)
        for request in open where permissionRow(request.requestId) == nil {
            transcript.append(.permission(id: UUID(), request: request, allowed: nil))
        }
    }

    /// §28: `interrupt` answers every open request (deny): every open card turns denied.
    func markOpenPermissionsDenied() {
        let open = openPermissions
        guard !open.isEmpty else { return }
        for request in open {
            setPermissionRow(request.requestId, allowed: false)
            answeredPermissionIds.insert(request.requestId)
        }
        state.session.setPermissionQueue([])
    }

    func resetPermissionView() {
        answeredPermissionIds = []
        turnAllowedAgents = []   // r2-peers (M26)
        permissionNotice = nil
        permissionRules = nil
        permissionRulesError = nil
        isLoadingPermissionRules = false
        defaultModeOffer = nil
    }

    // MARK: Answers

    /// Answers the card of `requestId` — exactly that request, wherever it sits in the queue. A request that is no longer
    /// open (answered, auto-answered, withdrawn, the turn ended) sends nothing and says so.
    /// `remember` ("세션 동안 허용") is dropped for a card that does not offer it (a `reason`, SendMessage).
    public func respondPermission(requestId: String, allow: Bool, message: String? = nil, remember: Bool = false) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        let remembers = allow && remember && PermissionCardOptions(request: request).allowsRemember
        answerPermission(request, allow: allow, updatedInput: nil,
                         command: .permissionResponse(requestId: requestId, allow: allow, message: message, remember: remembers))
    }

    /// M14: answers the `AskUserQuestion` card of `requestId` (`allow` + `updatedInput.answers`).
    public func answerQuestions(requestId: String, answers: [String: String]) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        guard request.toolName == AskUserQuestions.toolName else { return }
        let updated = AskUserQuestions.updatedInput(for: request, answers: answers)
        answerPermission(request, allow: true, updatedInput: updated,
                         command: .permissionResponse(requestId: requestId, allow: true, updatedInput: updated))
    }

    /// M14: declines the `AskUserQuestion` card of `requestId`; Claude is told the user skipped it.
    public func skipQuestions(requestId: String) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        guard request.toolName == AskUserQuestions.toolName else { return }
        answerPermission(request, allow: false, updatedInput: nil,
                         command: .permissionResponse(requestId: requestId, allow: false, message: "User skipped the questions"))
    }

    /// §33.6 "이 프로젝트에서 항상 허용": the pattern is saved for this project, the merged list goes to the engine
    /// (`set_settings{bashAllowPatterns}`) and then the card is allowed. Queued requests the pattern covers are answered
    /// by the engine itself; a late answer to one of those is a no-op there.
    public func alwaysAllowInProject(requestId: String, pattern: String) {
        guard isPermissionOpen(requestId) else {
            permissionNotice = .alreadyHandled
            return
        }
        addProjectAllowPattern(pattern)
        respondPermission(requestId: requestId, allow: true)
    }

    /// MARK: r2-skills-side — §33.6 (M21) "모든 프로젝트에서 허용": the pattern joins the global allow list (every window's engine
    /// gets it — the App fans `pushPermissionSettings` out to the other windows), then the card is allowed.
    public func alwaysAllowEverywhere(requestId: String, pattern: String) {
        guard isPermissionOpen(requestId) else {
            permissionNotice = .alreadyHandled
            return
        }
        AppSettings.appendBashAllowPatterns([pattern], defaults: permsDefaults)
        pushPermissionSettings()
        respondPermission(requestId: requestId, allow: true)
    }

    public func dismissPermissionNotice() {
        permissionNotice = nil
    }

    /// The card turns decided right away and leaves the queue; the answer goes out as a request so a refusal is seen:
    /// `unknown_permission_request` ("이미 처리된 권한 요청입니다") leaves the card handled, any other refusal puts it back.
    func answerPermission(_ request: PermissionRequest, allow: Bool, updatedInput: JSONValue?, command: EngineCommand) {
        let queue = openPermissions
        let position = queue.firstIndex { $0.requestId == request.requestId } ?? queue.count
        setPermissionRow(request.requestId, allowed: allow, input: updatedInput)
        answeredPermissionIds.insert(request.requestId)
        state.session.setPermissionQueue(queue.filter { $0.requestId != request.requestId })
        if requestSink == nil, let commandSink {
            commandSink(command)
            return
        }
        Task { await sendPermissionAnswer(command, request: request, position: position) }
    }

    func sendPermissionAnswer(_ command: EngineCommand, request: PermissionRequest, position: Int) async {
        do {
            try await self.request(command)
        } catch let error as EngineClientError {
            answeredPermissionIds.remove(request.requestId)
            setPermissionRow(request.requestId, allowed: nil, input: request.input)
            if error.refusalCode == "unknown_permission_request" {
                // Not open in the engine (answered elsewhere, withdrawn, the turn ended): the card reads "처리됨".
                permissionNotice = .alreadyHandled
            } else if case .refused = error {
                // Still open in the engine: the card can be answered again.
                var queue = openPermissions
                if !queue.contains(where: { $0.requestId == request.requestId }) {
                    queue.insert(request, at: min(position, queue.count))
                    state.session.setPermissionQueue(queue)
                }
                permissionNotice = PermissionNotice(text: error.userMessage)
            } else {
                fail(error.userMessage, fatal: false)
            }
        } catch {
            answeredPermissionIds.remove(request.requestId)
            setPermissionRow(request.requestId, allowed: nil, input: request.input)
            fail(error.localizedDescription, fatal: false)
        }
    }

    // MARK: Transcript rows

    private func permissionRow(_ requestId: String) -> Int? {
        transcript.lastIndex {
            if case let .permission(_, request, _) = $0 { return request.requestId == requestId }
            return false
        }
    }

    private func undecidedPermissionRow(_ requestId: String) -> Int? {
        transcript.lastIndex {
            if case let .permission(_, request, nil) = $0 { return request.requestId == requestId }
            return false
        }
    }

    /// The card's decision (`nil` = no decision from this client: open, or "처리됨" once it left the queue).
    func setPermissionRow(_ requestId: String, allowed: Bool?, input: JSONValue? = nil) {
        guard let index = permissionRow(requestId), case .permission(let id, var request, _) = transcript[index] else { return }
        if let input { request.input = input }
        transcript[index] = .permission(id: id, request: request, allowed: allowed)
    }

    // MARK: Settings (§33.4 / §33.5 / §33.7)

    /// `set_settings{allowWorktreeIsolation, applyUserAllowRules, applyUserBashRules, persistSessionAllows}` on a running engine.
    public func pushWorktreePermissionSettings() {
        guard isEngineRunning || commandSink != nil else { return }
        fire(.setSettings(AppSettings.worktreePermissionSettings(defaults: permsDefaults)))
    }

    /// §33.8 import: `patterns` (the rules' `importAs`) are appended to this project's list or the global one and the
    /// merged list goes to this window's engine. Nothing is written to Claude Code's settings files. Returns what was new.
    @discardableResult
    public func importAllowPatterns(_ patterns: [String], toProject: Bool) -> [String] {
        let added: [String]
        if toProject {
            guard let url = projectURL else { return [] }
            // MARK: r2-skills-side — §33.6 (M21): into the repository's list (every worktree of it), not new to the project.
            let fresh = patterns.filter { !projectAllowPatterns.contains($0) }
            added = AppSettings.appendProjectAllowPatterns(fresh, root: allowPatternsRepositoryKey ?? AppSettings.projectKey(url), defaults: permsDefaults)
        } else {
            added = AppSettings.appendBashAllowPatterns(patterns, defaults: permsDefaults)
        }
        if !added.isEmpty { pushPermissionSettings() }
        return added
    }

    // MARK: permission_rules (§33.8)

    /// `permission_rules` (query lane) → `permissionRules`, or `permissionRulesError` with the refusal in words.
    public func loadPermissionRules() async {
        guard projectInfo != nil else {
            permissionRules = nil
            permissionRulesError = EngineMessages.refusal(error: "no_project")
            return
        }
        isLoadingPermissionRules = true
        defer { isLoadingPermissionRules = false }
        do {
            let event = try await reply(.permissionRules)
            guard case let .permissionRules(rules) = event else { throw EngineClientError.unexpectedReply(String(describing: event)) }
            permissionRules = rules
            permissionRulesError = nil
        } catch let error as EngineClientError {
            permissionRulesError = error.userMessage
        } catch {
            permissionRulesError = error.localizedDescription
        }
    }

    // MARK: The terminal's default mode (§2.8)

    /// The first time a project is opened: when the terminal starts in a mode ReviewGate offers and this session runs in
    /// another one, `defaultModeOffer` asks "터미널처럼 {mode} 모드로 시작할까요?". Answered once per project.
    public func checkDefaultModeOffer() async {
        guard let url = projectURL, projectInfo != nil else {
            defaultModeOffer = nil
            return
        }
        guard !AppSettings.defaultModeOffered(root: AppSettings.projectKey(url), defaults: permsDefaults) else {
            defaultModeOffer = nil
            return
        }
        await loadPermissionRules()
        guard projectURL == url else { return }
        defaultModeOffer = Self.defaultModeToOffer(permissionRules, current: permissionMode)
    }

    /// The mode worth offering: the terminal's `defaultMode` when ReviewGate supports it and the session is not in it.
    nonisolated public static func defaultModeToOffer(_ rules: PermissionRulesReply?, current: PermissionMode) -> PermissionMode? {
        guard let mode = rules?.supportedDefaultMode, mode != current else { return nil }
        return mode
    }

    /// [예]: the mode is remembered for this project (and the next sessions) and the live session switches to it.
    public func acceptDefaultModeOffer() {
        guard let mode = defaultModeOffer, canSetPermissionMode else { return }
        markDefaultModeOffered()
        defaultModeOffer = nil
        requestPermissionMode(mode)   // wave4b w4b-auto (§39.5): a refusal (auto mode unavailable) says why
    }

    /// [아니요]: not asked again for this project.
    public func declineDefaultModeOffer() {
        markDefaultModeOffered()
        defaultModeOffer = nil
    }

    private func markDefaultModeOffered() {
        guard let url = projectURL else { return }
        AppSettings.markDefaultModeOffered(root: AppSettings.projectKey(url), defaults: permsDefaults)
    }
}
