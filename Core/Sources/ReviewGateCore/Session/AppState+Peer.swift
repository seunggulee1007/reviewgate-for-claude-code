import Foundation

// MARK: wave1 mac-session
// docs/PROTOCOL.md §29 on the client: the inbox card (`state.session.peerInbox`), `peer_accept` / `peer_dismiss` /
// `peer_set` and their refusals, the transcript rows, the notification and the global setting.

public extension AppSettings.Key {
    /// §29: the global peer mode (`PeerInboundMode.rawValue`); unset → `ask`.
    static let peerInbound = "peerInbound"
}

public extension AppSettings {
    /// §29: Settings › "Messages from other sessions"; unset or unknown → `.ask`.
    static func peerInbound(defaults: UserDefaults = .standard) -> PeerInboundMode {
        PeerInboundMode(wire: defaults.string(forKey: Key.peerInbound)) ?? .ask
    }

    static func setPeerInbound(_ mode: PeerInboundMode, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: Key.peerInbound)
    }

    /// The `hello` payload: `engineSettings` plus the §29 peer mode.
    static func sessionEngineSettings(defaults: UserDefaults = .standard) -> EngineSettings {
        var settings = engineSettings(defaults: defaults)
        settings.peerInbound = peerInbound(defaults: defaults)
        return settings
    }
}

public extension AppState {
    /// Held (waiting for the user) and delivering messages, oldest first — the card above the composer.
    var peerInbox: [PeerMessage] { sessionInfo.peerInbox }
    var heldPeerMessages: [PeerMessage] { peerInbox.filter { $0.state == .held } }
    var isPeerDelivering: Bool { peerInbox.contains { $0.state == .delivering } }

    /// Why "Claude가 처리" is off right now (its tooltip); nil = it can run.
    var peerAcceptBlockedReason: String? {
        if isPeerBusy || isPeerDelivering { return PeerText.delivering }
        guard !canSend else { return nil }
        if isExternalTurn { return PeerText.waitForOtherWork }
        switch gate.blockedReason {
        case .running, .awaitingPermission, .collecting, .reverting, .starting: return PeerText.waitForWork
        default: return cannotSendReason ?? PeerText.waitForWork
        }
    }

    /// "Claude가 처리" while a review waits: allowed, but its changes join that review.
    var peerAcceptNote: String? {
        guard peerAcceptBlockedReason == nil, gatePhase == .reviewing else { return nil }
        return PeerText.reviewNote
    }

    /// `peer_accept {ids}` with every held message the card shows (the engine refuses `peer_inbox_changed` otherwise).
    func acceptPeerMessages() {
        let ids = heldPeerMessages.map(\.id)
        guard !ids.isEmpty, peerAcceptBlockedReason == nil else { return }
        runPeerCommand(.peerAccept(ids: ids))
    }

    /// `peer_dismiss {ids}`: the senders get a "not delivered" receipt; each message leaves a "declined" row.
    func dismissPeerMessages() {
        let ids = heldPeerMessages.map(\.id)
        guard !ids.isEmpty, !isPeerBusy, !isPeerDelivering else { return }
        runPeerCommand(.peerDismiss(ids: ids))
    }

    /// `peer_set {mode}`: this project's own mode (the project menu, the card's "이 프로젝트는 받지 않기").
    func setProjectPeerInbound(_ mode: PeerInboundMode) {
        guard projectInfo != nil else { return }
        runPeerCommand(.peerSet(mode: mode))
    }

    /// Settings › "다른 세션 메시지": the default of every project without its own mode, live (`set_settings`).
    func updatePeerInbound(_ mode: PeerInboundMode) {
        guard isEngineRunning || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.peerInbound = mode
        fire(.setSettings(settings))
    }

    /// "이 메시지 처리하기" on an unprompted peer row: the body as a normal message (the gate rules apply; queued while busy).
    /// wave2 check-clients: once per message — a second click neither sends nor queues it again.
    func handleUnpromptedPeerMessage(_ message: PeerMessage) {
        guard let body = message.body, !body.isEmpty, !isUnpromptedPeerMessageHandled(message) else { return }
        handledUnpromptedPeerIds.insert(message.id)
        let text = PeerText.unpromptedSendText(message)
        if canSend { send(text) } else { enqueue(text) }
    }

    /// The fallback row's "이 메시지 처리하기" was used: the button reads "내 메시지로 보냈어요" and stays off.
    func isUnpromptedPeerMessageHandled(_ message: PeerMessage) -> Bool { handledUnpromptedPeerIds.contains(message.id) }

    func dismissPeerNotice() { peerNotice = nil }

    private func runPeerCommand(_ command: EngineCommand) {
        peerNotice = nil
        if requestSink == nil, let commandSink { commandSink(command); return }
        isPeerBusy = true
        Task {
            defer { isPeerBusy = false }
            do {
                try await request(command)
                if case let .peerSet(mode) = command { state.session.peerInbound = mode }   // the next snapshot confirms it
            } catch let error as EngineClientError {
                applyPeerRefusal(error, command: command)
            } catch {
                peerNotice = error.localizedDescription
            }
        }
    }

    /// The card's answer to a refusal: `peer_inbox_changed` → refreshed card + "목록이 바뀌었어요", `peer_none` → no card,
    /// `gate_closed:*` → why it has to wait, anything else in the user's words.
    internal func applyPeerRefusal(_ error: EngineClientError, command: EngineCommand) {
        appendLog("[warn] \(command.type): \(error.localizedDescription)")
        guard case let .refused(raw, _, _, _) = error else { peerNotice = error.localizedDescription; return }
        switch error.refusalCode {
        case "peer_none":
            state.session.peerInbox = []
            peerNotice = nil
        case "gate_closed" where EngineMessages.detail(of: raw, code: "gate_closed") == "external_turn":
            peerNotice = PeerText.waitForOtherWork
        default:
            peerNotice = error.userMessage
        }
    }

    /// A `peer_message` event: held → a notification while the window is in the background (not in `auto`, where the
    /// engine runs it); delivered / dropped → its transcript row (a delivered one opens its turn, like a user message).
    internal func handlePeerMessage(_ message: PeerMessage) {
        switch message.state {
        case .held:
            if state.session.peerInbound != .auto { onAttention?(.peerMessage(message)) }
        case .delivered, .dropped:
            let known = transcript.contains {
                if case let .peerMessage(_, row) = $0 { return row.id == message.id && row.state == message.state }
                return false
            }
            if !known { transcript.append(.peerMessage(id: UUID(), message: message)) }
        case .delivering, .other:
            break
        }
    }
}
