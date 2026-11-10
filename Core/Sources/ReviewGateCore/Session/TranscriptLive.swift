import Foundation
import Observation

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the answer that is still streaming keeps its text here, not in
// `AppState.transcript`: a delta is appended to a list of pieces (nothing that came before is copied), only the open row
// and the follow scroll are told — once per burst of deltas already queued — and the transcript row gets the whole text
// once, when the row finishes.

/// The open assistant row's text while it streams.
@MainActor
@Observable
public final class LiveAssistantText {
    /// The streaming row (nil: nothing streams).
    public private(set) var rowID: UUID?
    /// Bumped when the text grew (once per burst of queued deltas, `AppState.publishLiveText`).
    public private(set) var revision = 0
    /// §18: the row is of a turn Claude Code ran by itself.
    @ObservationIgnored public private(set) var unprompted = false
    /// The deltas as they came. A piece is never changed, so a reader holding the joined text never makes the next
    /// append copy it.
    @ObservationIgnored private var pieces: [String] = []

    public init() {}

    /// The text so far (observes `revision`).
    public var text: String {
        _ = revision
        return pieces.joined()
    }

    /// Whether `id` is the streaming row (observes `rowID`).
    public func isLive(_ id: UUID) -> Bool { rowID == id }

    func start(rowID: UUID, text: String, unprompted: Bool) {
        pieces = [text]
        self.unprompted = unprompted
        self.rowID = rowID
    }

    /// Amortized O(delta): the pieces are joined only when read; past 512 pieces they are joined once, into a new piece.
    func append(_ delta: String) {
        pieces.append(delta)
        if pieces.count > 512 { pieces = [pieces.joined()] }
    }

    /// Tells the readers the text grew.
    func publish() { revision &+= 1 }

    /// The whole text, and nothing streams any more.
    func take() -> String {
        let text = pieces.joined()
        reset()
        return text
    }

    func reset() {
        pieces = []
        unprompted = false
        if rowID != nil { rowID = nil }
    }
}

/// What the chat's row tree depends on: how many rows, the first and the last (a delta or a decision changes none of them).
struct TranscriptShape: Equatable {
    var count = 0
    var first: UUID?
    var last: UUID?

    init() {}

    init(_ items: [ChatItem]) {
        count = items.count
        first = items.first?.id
        last = items.last?.id
    }
}
