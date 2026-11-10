import Foundation

// MARK: r2-chats-cards M31 / M33 — docs/PROTOCOL.md §9: a new chat or a chat switch is never refused because Claude works.
// The engine still refuses a switch while a turn, start, collection or revert runs (`session_busy`); the client holds such
// a switch — [+], ⌘T, [이 채팅으로 이어가기], a message sent from another chat shown read-only — and sends it once the live
// chat is done: its turn ended and its queue went out (turns stay one at a time per worktree, and a queued message stays
// with the chat it was typed in). Only a failed collection refuses (its retry belongs to the live chat). Electron:
// renderer/pendingSwitch.ts.

/// A switch asked for while the live chat works.
public enum PendingChatSwitch: Equatable, Sendable {
    /// [+] / ⌘T / 새 채팅: a fresh chat once the turn is over.
    case newChat
    /// [이 채팅으로 이어가기], or messages sent from that chat (`messages`, in order — they go out right after the switch;
    /// none: only the switch).
    case openChat(id: String, messages: [QueuedMessage])

    /// The chat it goes to (nil: a new one).
    public var chatId: String? {
        if case let .openChat(id, _) = self { return id }
        return nil
    }
}

extension AppState {
    /// Why [+] / ⌘T / 새 채팅 cannot open a chat at all (nil: they can — at once, or once Claude is done).
    public var newChatBlocker: String? {
        guard projectInfo != nil else { return nil }
        if gate.collectError != nil { return Self.sessionRefusalText("collect_failed") }
        return nil
    }

    /// A switch now would wait for the live chat: a start, a turn, its collection or a revert, or messages still in its queue.
    public var chatSwitchWaits: Bool {
        switch gatePhase {
        case .starting, .running, .collecting, .reverting: return true
        case .idle, .reviewing, .collectFailed: break
        }
        return sessionInfo.starting || !queuedMessages.isEmpty || sendAfterInterrupt != nil || queuedSendInFlight
    }

    /// What a held switch waits for, in one line ("Claude가 '<제목>'에서 작업 중이에요 — 끝나면 새 채팅을 열어요").
    public var pendingChatSwitchText: String? {
        guard let pending = pendingChatSwitch else { return nil }
        let live = chatTitle(id: currentSessionId)
        switch pending {
        case .newChat:
            return String(localized: "A new chat opens once Claude is done in '\(live)'", bundle: .module)
        case let .openChat(id, messages):
            let target = chatTitle(id: id)
            return messages.isEmpty
                ? String(localized: "Continues in '\(target)' once Claude is done in '\(live)'", bundle: .module)
                : String(localized: "Your message goes to '\(target)' once Claude is done in '\(live)'", bundle: .module)
        }
    }

    /// Holds `pending` (the last one wins); it goes out as soon as the live chat is done (`drainPendingChatSwitch`). Nothing
    /// held is lost: a message sent from the same chat again (or its [이 채팅으로 이어가기]) keeps the ones held for it, in
    /// order; a switch elsewhere gives them back to the composer.
    func holdChatSwitch(_ pending: PendingChatSwitch) {
        var next = pending
        if case let .openChat(heldId, held) = pendingChatSwitch, !held.isEmpty {
            if case let .openChat(id, more) = pending, id == heldId {
                next = .openChat(id: id, messages: held + more)
            } else {
                handBackHeldMessages(held)
            }
        }
        pendingChatSwitch = next
        drainPendingChatSwitch()
    }

    /// The held switch is called off; the messages held with it go back to the composer, whole.
    public func cancelPendingChatSwitch() {
        guard let pending = pendingChatSwitch else { return }
        pendingChatSwitch = nil
        if case let .openChat(_, messages) = pending { handBackHeldMessages(messages) }
    }

    /// After every snapshot: the held switch goes out once the live chat is done — or is dropped, with its reason, when the
    /// engine would refuse it for good (a failed collection, the chat it goes to is gone).
    func drainPendingChatSwitch() {
        guard let pending = pendingChatSwitch, projectInfo != nil, !chatSwitchWaits, !switchingChat else { return }
        if let blocker = newChatBlocker {
            cancelPendingChatSwitch()
            fail(blocker, fatal: false)
            return
        }
        if case let .openChat(id, messages) = pending, id == currentSessionId || !sessions.contains(where: { $0.id == id }) {
            pendingChatSwitch = nil
            // Already there (or the chat went): the messages go out here only when this is their chat.
            if id == currentSessionId { queueHeldMessages(messages) } else { handBackHeldMessages(messages) }
            return
        }
        pendingChatSwitch = nil
        switchingChat = true
        Task {
            defer { self.switchingChat = false }
            switch pending {
            case .newChat:
                _ = await self.switchSession(.sessionNew)
            case let .openChat(id, messages):
                let switched = await self.switchSession(.sessionOpen(id: id))
                if switched { self.queueHeldMessages(messages) } else { self.handBackHeldMessages(messages) }
            }
        }
    }

    /// The held messages join the queue of the chat they were written in, which is now the live one — in order.
    private func queueHeldMessages(_ messages: [QueuedMessage]) {
        guard !messages.isEmpty else { return }
        queuedMessages.append(contentsOf: messages)
        drainQueue()
    }

    /// Held messages that will not go out: back into the composer as a task's text is (`taskForComposer`) — their text
    /// (several one after another), mentions and images, nothing of them lost.
    private func handBackHeldMessages(_ messages: [QueuedMessage]) {
        guard !messages.isEmpty else { return }
        taskForComposer = TaskComposerText(text: messages.map(\.text).joined(separator: "\n\n"),
                                           mentions: messages.flatMap(\.mentions), images: messages.flatMap(\.images))
    }
}

// MARK: r2-chats-cards — polish P4-composer-08: which tabs hold an unsent draft

extension AppState {
    /// The draft kept for chat `id` — in memory (with its images) or saved on disk; nil when there is none. The composer's
    /// own draft (the chat on screen) is the caller's to read.
    public func keptDraft(for id: String) -> ChatDraft? {
        if let kept = chatDrafts[id], !kept.isEmpty { return kept }
        guard let saved = savedDraft(for: id), !saved.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !saved.mentions.isEmpty else { return nil }
        return saved
    }
}
