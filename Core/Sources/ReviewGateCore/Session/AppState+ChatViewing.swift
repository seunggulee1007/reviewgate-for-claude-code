import Foundation

// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 "Chats you can read without switching" (daily-13): a click on another
// chat tab (or ⌘1…9) shows that chat's saved rows read-only — `transcript_page` of that chat (§38.3) — and leaves the
// running Claude session where it is. Sending from it, or [이 채팅으로 이어가기], switches for real by the old path
// (`session_open`); the message then goes out by the queue's rules. The review, permission cards and the HUD stay the
// running chat's. Electron: renderer/viewedChat.ts.

/// Another chat shown read-only while the live session stays on its own chat.
public struct ViewedChat: Equatable, Sendable {
    /// The chat shown.
    public let id: String
    /// The live chat when this view began; once the live chat changes (a switch, a new chat) the view is over.
    public let liveId: String?
    /// Its rows as chat items, oldest first (empty while loading).
    public internal(set) var rows: [ChatItem] = []
    /// The row index of `rows[0]` (§38.3); > 0: older rows exist.
    public internal(set) var start: Int?
    /// `at` of the oldest shown row (`transcript_page.beforeAt`).
    public internal(set) var oldestAt: String?
    public internal(set) var loading = true
    /// The rows could not be read (one line).
    public internal(set) var error: String?

    public init(id: String, liveId: String?) {
        self.id = id
        self.liveId = liveId
    }

    public var canLoadEarlier: Bool { (start ?? 0) > 0 && !loading }
}

public enum ChatViewing {
    /// `transcript_page.before` for "the end of the chat" (the engine clamps it to the chat's row count).
    public static let end = 1_000_000_000
    public static let pageRows = 200

    /// Why a send from a viewed chat cannot switch to it now (nil: it can): the live chat is busy, its queue still holds
    /// messages, or — as the engine's `guardSessionSwitch` — its review or notes hold it (`switchBlocker`).
    public static func sendBlocker(phase: GatePhase, liveTitle: String, queued: Bool, switchBlocker: String?) -> String? {
        switch phase {
        case .starting, .running, .collecting, .reverting:
            return String(localized: "Claude is working in '\(liveTitle)'", bundle: .module)
        case .idle, .reviewing, .collectFailed:
            break
        }
        if queued { return String(localized: "Messages are waiting in the queue of '\(liveTitle)'", bundle: .module) }
        return switchBlocker
    }
}

extension AppState {
    /// The chat shown read-only; nil while the chat view shows the live chat (as before).
    public var viewingChat: ViewedChat? {
        guard let v = viewedChat, v.id != currentSessionId, v.liveId == currentSessionId else { return nil }
        return v
    }

    /// The chat the chat view shows: the viewed one, else the live one.
    public var shownChatId: String? { viewingChat?.id ?? currentSessionId }

    /// wave4b integration (§39.2 × §39.3): a reveal of `toolUseId` stays in the chat shown read-only when that call is one
    /// of its own rows (a link on its turn summary card, "에이전트별 변경"); any other reveal is the running chat's and
    /// shows it first (`stopViewing`).
    public func revealStaysInViewedChat(toolUseId: String) -> Bool {
        guard let rows = viewingChat?.rows else { return false }
        return TranscriptIndex(rows).calls[toolUseId] != nil
    }

    /// A chat's title for these lines ("New chat" when it has none).
    public func chatTitle(id: String?) -> String {
        let title = sessions.first { $0.id == id }?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? String(localized: "New chat", bundle: .module) : title
    }

    /// Why sending from the viewed chat cannot go there now; nil when it can, or when no other chat is shown.
    public var viewingSendBlocker: String? {
        guard viewingChat != nil else { return nil }
        return ChatViewing.sendBlocker(phase: gatePhase, liveTitle: chatTitle(id: currentSessionId),
                                       queued: !queuedMessages.isEmpty || sendAfterInterrupt != nil, switchBlocker: chatSwitchBlocker)
    }

    /// The live chat waits for the user (a permission, a question, a plan) while another chat is shown.
    public var liveChatWaits: Bool {
        viewingChat != nil && (pendingPermission != nil || !openPermissions.isEmpty || pendingPlan != nil)
    }

    /// A chat tab click / ⌘1…9: the live chat → back to it; another → its saved rows, read-only. Nothing switches.
    public func viewChat(id: String) async {
        guard id != currentSessionId else {
            viewedChat = nil
            return
        }
        if let shown = viewingChat, shown.id == id { return }
        viewedChat = ViewedChat(id: id, liveId: currentSessionId)
        await loadViewedRows(id: id, before: ChatViewing.end, beforeAt: nil)
    }

    /// Back to the live chat.
    public func stopViewing() {
        viewedChat = nil
    }

    /// [이전 대화 더 보기] in a viewed chat: the rows before the oldest shown one.
    public func loadEarlierInViewedChat() async {
        guard let v = viewingChat, v.canLoadEarlier, let start = v.start else { return }
        viewedChat?.loading = true
        await loadViewedRows(id: v.id, before: start, beforeAt: v.oldestAt)
    }

    private func loadViewedRows(id: String, before: Int, beforeAt: String?) async {
        do {
            let reply = try await reply(.transcriptPage(sessionId: id, before: before, beforeAt: beforeAt, limit: ChatViewing.pageRows))
            guard case let .transcriptPage(page) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            // Another chat (or the live one) is shown meanwhile: these rows are not its.
            guard viewedChat?.id == id, page.sessionId == id else { return }
            viewedChat?.rows.insert(contentsOf: viewedChatRows(page.items), at: 0)
            viewedChat?.start = page.start
            if let first = page.items.first?.at { viewedChat?.oldestAt = first }
            viewedChat?.loading = false
            viewedChat?.error = nil
        } catch EngineClientError.refused(let message, let code, _) where code == "unknown_command" || message.hasPrefix("unknown command") {
            // An engine before §38.3 cannot read another chat: the tab switches as it always did.
            guard viewedChat?.id == id else { return }
            viewedChat = nil
            await openChat(id: id)
        } catch {
            guard viewedChat?.id == id else { return }
            viewedChat?.loading = false
            viewedChat?.error = String(localized: "Could not load this chat", bundle: .module)
        }
    }

    /// [이 채팅으로 이어가기]: the live session moves to the viewed chat by the old path (`session_open`).
    @discardableResult
    public func continueInViewedChat() async -> Bool {
        guard let v = viewingChat, viewingSendBlocker == nil else { return false }
        return await openChat(id: v.id)
    }

    // MARK: Closing and adding tabs — the tab's × and context menu, Chat › Close Chat Tab (⌘⇧W), the history's Open

    /// The tab can be closed now: any open chat but the live one; the live chat's only while a switch is allowed (closing
    /// it moves the session to its neighbour) and another tab stays open.
    public func canCloseTab(id: String) -> Bool {
        openTabs.contains { $0.id == id } && (id != currentSessionId || (chatSwitchBlocker == nil && openTabs.count > 1))
    }

    /// Closes the tab; a chat shown read-only hands the view back to the live chat first. false: it could not be closed.
    @discardableResult
    public func closeChatTab(id: String) async -> Bool {
        guard canCloseTab(id: id) else { return false }
        if viewingChat?.id == id { stopViewing() }
        return await closeTab(id: id)
    }

    /// "Close Other Tabs": every tab but `id` and the live chat's — closing that one would move Claude's session.
    public func closeOtherTabs(keeping id: String) {
        let kept = openTabs.map(\.id).filter { $0 == id || $0 == currentSessionId }
        if let shown = viewingChat?.id, !kept.contains(shown) { stopViewing() }
        setTabs(kept)
    }

    /// The history's Open while a switch is refused (Claude works, the review or unsent notes belong to the live chat): the
    /// chat joins the tabs and is shown read-only, as a tab click shows it; nothing switches.
    public func openTabReadOnly(id: String) async {
        let ids = openTabs.map(\.id)
        if !ids.contains(id) { setTabs(ids + [id]) }
        await viewChat(id: id)
    }

    /// Send from a viewed chat: switch to it first; the message then goes out by the queue's rules (at once, or as soon as
    /// the resumed session takes it). false: nothing was switched or sent (the composer keeps the text).
    @discardableResult
    public func sendInViewedChat(_ text: String, mentions: [String] = [], images: [ComposerImage] = []) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, await continueInViewedChat() else { return false }
        enqueue(text, mentions: mentions, images: images)
        return true
    }

    /// Saved rows as chat items, the way `transcript_restore` shows them (§38.3 rows).
    func viewedChatRows(_ items: [TranscriptItem]) -> [ChatItem] {
        var rows: [ChatItem] = []
        for item in items {
            let id = UUID()
            switch item.kind {
            case let .userMessage(text, mentions, attachments, autoModel):   // wave5 w5-model (§43.4)
                rows.append(.user(id: id, text: text, meta: UserMessageMeta(turn: item.turn, mentions: mentions, attachments: attachments, autoModel: autoModel)))
            case let .assistantText(text, unprompted):
                rows.append(.assistant(id: id, text: text, streaming: false, unprompted: unprompted))
            case let .toolUse(toolUseId, name, input, file, info):
                rows.append(.toolUse(id: id, toolUseId: toolUseId, name: name, file: file, input: input, info: info))
            case let .toolResult(toolUseId, isError, preview, info):
                rows.append(.toolResult(id: id, toolUseId: toolUseId, isError: isError, preview: preview, info: info))
            case let .permission(requestId, toolName, allow, file):
                let request = PermissionRequest(requestId: requestId, toolName: toolName, input: .object([:]), file: file)
                rows.append(.permission(id: id, request: request, allowed: allow))
            case let .budgetEvent(kind, toolName, file, files, lines):
                rows.append(.budgetEvent(id: id, kind: kind, toolName: toolName, file: file, files: files, lines: lines, budget: state.budget))
            case let .turnEnd(stopReason, usage, files, added, deleted, _, external, review):
                rows.append(.turnEnd(id: id, summary: TurnEndText.row(stopReason: stopReason, usage: usage, files: files, added: added,
                                                                      deleted: deleted, external: external, review: review)))
            case let .error(message, fatal, scope, code, detail, facts):
                let restored = restoredError(message: message, scope: scope, code: code, detail: detail, at: item.at, facts: facts)
                SessionNotices.appendError(to: &rows, id: id, message: restored.text, fatal: fatal, info: restored.info)
            case let .peerMessage(message):
                rows.append(.peerMessage(id: id, message: message))
            case let .autoTurn(info):   // §52.1
                rows.append(.autoTurn(id: id, turn: item.turn, info: info))
            case let .turnSummary(summary):
                if !summary.files.isEmpty { rows.append(.turnSummary(id: id, summary: summary)) }
            case .other:
                continue
            }
        }
        return rows
    }
}
