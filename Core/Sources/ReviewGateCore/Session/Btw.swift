import Foundation

// MARK: composer parity — docs/PROTOCOL.md §56.1: `/btw <question>`, as in the terminal — a quick side question answered
// apart (no tools, never in the chat) while Claude works or not.

/// Reply to `btw_ask`.
public struct BtwAnswer: Sendable, Equatable {
    /// The correlation id of the reply.
    public var id: String?
    public let question: String
    public let answer: String
    /// A copy of the conversation answered (the live session could not); false: the live session did.
    public let viaFork: Bool
    /// A note of the CLI's own (the model tried to call a tool, an API error), not the model's answer.
    public let synthetic: Bool

    public init(id: String? = nil, question: String, answer: String, viaFork: Bool = false, synthetic: Bool = false) {
        self.id = id
        self.question = question
        self.answer = answer
        self.viaFork = viaFork
        self.synthetic = synthetic
    }
}

extension BtwAnswer: Decodable {
    private enum CodingKeys: String, CodingKey { case id, question, answer, via, synthetic }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        question = try c.decodeIfPresent(String.self, forKey: .question) ?? ""
        answer = try c.decode(String.self, forKey: .answer)
        viaFork = (try? c.decodeIfPresent(String.self, forKey: .via)) == "fork"
        synthetic = (try? c.decodeIfPresent(Bool.self, forKey: .synthetic)) == true
    }
}

/// What the overlay over the message box shows.
public enum BtwOverlay: Sendable, Equatable {
    /// The question is on its way (Cancel drops the answer when it comes).
    case asking(question: String)
    case answered(BtwAnswer)
}

/// A side question that got no answer: why, in the user's words, and the question (it goes back into the box).
public struct BtwFailure: Sendable, Equatable {
    public let id: UUID
    public let question: String
    public let text: String

    public init(id: UUID = UUID(), question: String, text: String) {
        self.id = id
        self.question = question
        self.text = text
    }
}

public enum BtwCommand {
    /// The palette's entry (Built-in), as the CLI's own /btw.
    public static let name = "btw"

    /// `text` is the app's `/btw` command → its question ("" for `/btw` alone); nil for anything else (`/btwx`, a message).
    public static func question(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("/btw") else { return nil }
        let rest = trimmed.dropFirst(4)
        guard rest.isEmpty || rest.first?.isWhitespace == true else { return nil }
        return rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The palette's line for it.
    public static var description: String {
        String(localized: "Ask a quick side question — Claude keeps working; the answer stays out of the chat", bundle: .module)
    }

    /// The notice for `/btw` alone with no answer yet.
    public static var nothingYet: String {
        String(localized: "No side answer yet — type /btw and your question", bundle: .module)
    }
}

extension EngineCommand {
    private enum BtwKeys: String, CodingKey { case question }

    /// `btw_ask {question}` (`type` is written by the caller).
    func encodeBtwFields(to encoder: Encoder) throws {
        guard case let .btwAsk(question) = self else { return }
        var c = encoder.container(keyedBy: BtwKeys.self)
        try c.encode(question, forKey: .question)
    }
}

public extension AppState {
    /// §56.1: asks `question` on the side. The overlay shows it waiting, then the answer (also kept for `/btw` alone in this
    /// chat). A refusal closes the overlay and sets `btwFailure` (the composer says why and gives the question back).
    func askBtw(_ question: String) async {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        let token = UUID()
        btwAsking = token
        btwOverlay = .asking(question: q)
        let chat = currentSessionId
        do {
            let reply = try await reply(.btwAsk(question: q))
            guard case let .btwAnswer(answer) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            guard btwAsking == token else { return }   // cancelled meanwhile: the answer is dropped
            btwAsking = nil
            lastBtw = (chat, answer)
            btwOverlay = .answered(answer)
        } catch {
            guard btwAsking == token else { return }
            appendLog("[warn] btw_ask: \(error.localizedDescription)")
            btwAsking = nil
            btwOverlay = nil
            btwFailure = BtwFailure(question: q, text: FlowText.refusal(error))
        }
    }

    /// `/btw` alone: the last answer of this chat again; false when there is none (the composer says how to ask).
    @discardableResult
    func showLastBtw() -> Bool {
        guard let last = lastBtw, last.chat == currentSessionId else { return false }
        btwOverlay = .answered(last.answer)
        return true
    }

    /// Esc / ↩ / Space / Close on the answer; Cancel while it waits (the answer is dropped when it comes).
    func dismissBtw() {
        btwAsking = nil
        btwOverlay = nil
    }

    #if DEBUG
    /// The screenshot tour's composer check (App/Debug/ScreenshotTour.swift): the overlay as an answer shows it.
    func debugShowBtw(_ answer: BtwAnswer) {
        lastBtw = (currentSessionId, answer)
        btwOverlay = .answered(answer)
    }
    #endif
}
