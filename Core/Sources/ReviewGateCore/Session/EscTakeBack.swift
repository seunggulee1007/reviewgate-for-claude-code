import Foundation

// MARK: composer parity — docs/PROTOCOL.md §56.2: Esc gives back what Claude has not read, as in the terminal — the messages
// put into the turn and the whole queue come back into the message box, in front of what is typed; ↑ in an empty box does
// the same without stopping the turn.

/// Reply to `interrupt {takeBack: true}`.
public struct InterruptedReply: Sendable, Equatable {
    public var id: String?
    /// The messages of `state.session.steering` Claude will never read, in the order they were put in.
    public var takenBack: [SteeringMessage]
    /// The ids that waited but Claude has (their rows come with the turn's end).
    public var read: [String]

    public init(id: String? = nil, takenBack: [SteeringMessage] = [], read: [String] = []) {
        self.id = id
        self.takenBack = takenBack
        self.read = read
    }
}

extension InterruptedReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, takenBack, read }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        takenBack = (try? c.decodeIfPresent([SteeringMessage].self, forKey: .takenBack)) ?? []
        read = (try? c.decodeIfPresent([String].self, forKey: .read)) ?? []
    }
}

extension EngineCommand {
    private enum TakeBackKeys: String, CodingKey { case takeBack }

    /// `interrupt {takeBack: true}` (`type` is written by the caller).
    func encodeInterruptTakeBackFields(to encoder: Encoder) throws {
        guard case .interruptTakeBack = self else { return }
        var c = encoder.container(keyedBy: TakeBackKeys.self)
        try c.encode(true, forKey: .takeBack)
    }
}

/// What comes back into the message box: the messages' text one per paragraph, their mentions and images.
enum GivenBack {
    static func composerText(steered: [SteeringMessage], queued: [QueuedMessage]) -> TaskComposerText? {
        let texts = steered.map(\.text) + queued.map(\.text)
        guard !texts.isEmpty else { return nil }
        return TaskComposerText(text: texts.joined(separator: "\n\n"),
                                mentions: steered.flatMap(\.mentions) + queued.flatMap(\.mentions),
                                images: queued.flatMap(\.images), atFront: true)
    }

    /// Why some stayed: Claude read them already (their rows are in the chat, or come with the turn's end).
    static func readNotice(_ count: Int) -> SteerTakeBackNotice? {
        guard count > 0 else { return nil }
        return SteerTakeBackNotice(text: count == 1 ? SteerTakeBackNotice.alreadyRead
                                   : String(localized: "Claude already read \(count) of the waiting messages — they stay in the chat", bundle: .module))
    }
}

public extension AppState {
    /// §56.2: something waits that Esc would give back (the queue, or a message in Claude's turn not being taken back).
    var hasUnsentWaiting: Bool { canPullBackWaiting }

    /// §56.2 Esc while Claude works with messages waiting: the turn stops, and every message Claude has not read — the ones
    /// put into the turn (taken back with the interrupt) and the whole queue (it does not go on) — comes back into the
    /// message box in front of what is typed, in order. Those Claude already read stay in the chat; the notice says so.
    func interruptGivingBack() async {
        guard isRunning else { return }
        let queued = queuedMessages
        clearQueue()
        let waiting = steeringMessages.count
        markOpenPermissionsDenied()
        armInterruptWatch()
        var reply = InterruptedReply()
        do {
            let event = try await self.reply(.interruptTakeBack)
            if case let .interrupted(r) = event { reply = r }
        } catch {
            appendLog("[warn] interrupt (take back): \(error.localizedDescription)")
        }
        appendLog("[info] Esc: \(reply.takenBack.count) of \(waiting) waiting in the turn and \(queued.count) queued given back")
        if let back = GivenBack.composerText(steered: reply.takenBack, queued: queued) { taskForComposer = back }
        if let notice = GivenBack.readNotice(reply.read.count) { steerTakeBackNotice = notice }
    }

    /// §56.2, as ↑ in the terminal's empty input: every message waiting comes back into the message box — the ones in
    /// Claude's turn (taken back first; the turn goes on) and the whole queue, in order, with their mentions and images.
    /// False when nothing waits (↑ then walks the prompt history as before).
    @discardableResult
    func pullBackWaiting() -> Bool {
        guard canPullBackWaiting else { return false }
        let queued = queuedMessages
        clearQueue()
        let steering = steeringMessages.filter { !steeringTakingBack.contains($0.id) }
        steeringTakingBack.formUnion(steering.map(\.id))   // their chips wait at once
        Task {
            var taken: [SteeringMessage] = []
            var read = 0
            for message in steering {
                steeringTakingBack.remove(message.id)
                switch await takeBackSteering(id: message.id, toComposer: false, quiet: true) {
                case .taken: taken.append(message)
                case .alreadyRead, .failed: read += 1
                }
            }
            if let back = GivenBack.composerText(steered: taken, queued: queued) { taskForComposer = back }
            if let notice = GivenBack.readNotice(read) { steerTakeBackNotice = notice }
        }
        return true
    }
}
