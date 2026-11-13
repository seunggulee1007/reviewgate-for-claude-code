import Foundation

// MARK: composer — docs/PROTOCOL.md §50.2: the queue as the terminal shows it — what waits in Claude's turn until it reads
// it, and "Send now" on each queued message.

/// `state.session.steering[]`: a message put into the running turn (§50 `steer`) that Claude has not read yet.
public struct SteeringMessage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public var mentions: [String]

    public init(id: String, text: String, mentions: [String] = []) {
        self.id = id
        self.text = text
        self.mentions = mentions
    }

    private enum CodingKeys: String, CodingKey { case id, text, mentions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        mentions = (try? c.decodeIfPresent([String].self, forKey: .mentions)) ?? []
    }
}

enum SteeringWire {
    private enum SessionKeys: String, CodingKey { case steering }

    /// `state.session.steering`, element by element (a malformed entry is skipped); empty on older engines.
    static func messages(from decoder: Decoder) -> [SteeringMessage] {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self),
              var list = try? c.nestedUnkeyedContainer(forKey: .steering) else { return [] }
        var out: [SteeringMessage] = []
        while !list.isAtEnd {
            if let m = try? list.decode(SteeringMessage.self) { out.append(m) } else if (try? list.decode(JSONValue.self)) == nil { break }
        }
        return out
    }
}

/// What a queued message's "Send now" does, as the terminal lets a queued message go at once.
public enum QueuedSendNow: Sendable, Equatable {
    /// Into the running turn (§50): Claude reads it after the current step.
    case steer
    /// Stop the turn and send it right after (§28): a message with images, or a turn that cannot take it.
    case stopAndSend
    /// It goes first and the queue goes on now (a pause, a hold).
    case first

    public static func action(for message: QueuedMessage, canSteer: Bool, running: Bool) -> QueuedSendNow {
        if canSteer, message.images.isEmpty { return .steer }
        return running ? .stopAndSend : .first
    }
}

public extension AppState {
    /// §50.2: what waits in Claude's turn, oldest first.
    var steeringMessages: [SteeringMessage] { sessionInfo.steering }

    /// What "Send now" on the queued message `id` would do now; nil when it is no longer queued.
    func queuedSendNowAction(id: UUID) -> QueuedSendNow? {
        guard let message = queuedMessages.first(where: { $0.id == id }) else { return nil }
        return QueuedSendNow.action(for: message, canSteer: canSteer, running: isRunning)
    }

    /// §50.2 "바로 보내기" on a queued message: into the running turn, else stop the turn and send it, else it goes first
    /// and the queue goes on now. The others keep their order.
    func sendQueuedNow(id: UUID) {
        guard let action = queuedSendNowAction(id: id), let message = queuedMessages.first(where: { $0.id == id }) else { return }
        switch action {
        case .steer:
            queuedMessages.removeAll { $0.id == id }
            Task { await steer(message.text, mentions: message.mentions) }
        case .stopAndSend:
            queuedMessages.removeAll { $0.id == id }
            interruptAndSend(message.text, mentions: message.mentions, images: message.images)
        case .first:
            queuedMessages.removeAll { $0.id == id }
            queuedMessages.insert(message, at: 0)
            resumeQueue()
        }
    }
}

// MARK: §50.3 Taking a message back from Claude's turn

/// Why a take-back did not happen, for the message box (`AppState.steerTakeBackNotice`); `id` tells two alike apart.
public struct SteerTakeBackNotice: Sendable, Equatable {
    public let id: UUID
    public let text: String

    public init(id: UUID = UUID(), text: String) {
        self.id = id
        self.text = text
    }

    /// `steer_already_read`: Claude has it — its row is in the chat (or comes with the turn's end).
    public static var alreadyRead: String {
        String(localized: "Claude already read this message — it stays in the chat", bundle: .module)
    }

    /// `steer_take_back_failed`, or any other failure: it still goes to Claude.
    public static var failed: String {
        String(localized: "Couldn't take the message back — Claude still reads it", bundle: .module)
    }
}

/// What became of a take-back.
public enum SteerTakeBackOutcome: Sendable, Equatable {
    case taken
    case alreadyRead
    case failed
}

extension EngineCommand {
    private enum SteerTakeBackKeys: String, CodingKey { case messageId }

    /// `steer_take_back {messageId}` (`type` is written by the caller).
    func encodeSteerTakeBackFields(to encoder: Encoder) throws {
        guard case let .steerTakeBack(messageId) = self else { return }
        var c = encoder.container(keyedBy: SteerTakeBackKeys.self)
        try c.encode(messageId, forKey: .messageId)
    }
}

public extension AppState {
    /// §50.3: the message `id` in Claude's turn comes back before Claude reads it, as the terminal lets a queued message be
    /// pulled back or dropped. `toComposer`: its text and mentions go into the message box (Edit; ↩ sends it again). Too
    /// late — Claude read it — says so (`steerTakeBackNotice`) and its row stays in the chat; nothing is lost or sent twice.
    /// `quiet` (§56.2, several at once): the caller says it once for all of them.
    @discardableResult
    func takeBackSteering(id: String, toComposer: Bool, quiet: Bool = false) async -> SteerTakeBackOutcome {
        guard let message = steeringMessages.first(where: { $0.id == id }) else {
            if !quiet { steerTakeBackNotice = SteerTakeBackNotice(text: SteerTakeBackNotice.alreadyRead) }
            return .alreadyRead
        }
        guard !steeringTakingBack.contains(id) else { return .failed }
        steeringTakingBack.insert(id)
        defer { steeringTakingBack.remove(id) }
        do {
            try await request(.steerTakeBack(messageId: id))
        } catch let error as EngineClientError where error.refusalCode == "steer_already_read" {
            appendLog("[info] take-back too late: Claude already read the message")
            if !quiet { steerTakeBackNotice = SteerTakeBackNotice(text: SteerTakeBackNotice.alreadyRead) }
            return .alreadyRead
        } catch {
            appendLog("[warn] take-back failed: \(error.localizedDescription)")
            if !quiet { steerTakeBackNotice = SteerTakeBackNotice(text: SteerTakeBackNotice.failed) }
            return .failed
        }
        if toComposer { taskForComposer = TaskComposerText(text: message.text, mentions: message.mentions) }
        return .taken
    }

    /// §50.3: the queued message `id` leaves the queue for the message box (with its mentions and images): edit, then ↩.
    func editQueuedInComposer(id: UUID) {
        guard let message = queuedMessages.first(where: { $0.id == id }) else { return }
        removeQueued(id: id)
        taskForComposer = TaskComposerText(text: message.text, mentions: message.mentions, images: message.images)
    }

    /// §50.3: something waits that ↑ in an empty message box would bring back (§56.2 `pullBackWaiting`).
    var canPullBackWaiting: Bool {
        !queuedMessages.isEmpty || steeringMessages.contains { !steeringTakingBack.contains($0.id) }
    }


}
