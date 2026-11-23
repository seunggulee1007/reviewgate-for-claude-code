import Foundation

// docs/PROTOCOL.md §56.6: permission cards and Claude's questions that are decided — allowed, denied, answered, skipped or
// handled elsewhere — and come one after another in the transcript fold into one quiet line, "권한 3건 처리됨 ▸", that opens
// to the lines it holds. A card still waiting is never folded; any other row ends a run; fewer than `minCards` stay as
// they are. Decisions change a row in place (`TranscriptModel` keeps the row as it was placed), so the fold runs over the
// rows as they are now, where they are drawn. Electron: renderer/handledCards.ts.

/// What a decided card came to.
public enum HandledOutcome: Sendable, Equatable {
    case allowed, denied, handled, answered, skipped
}

/// A decided card: a permission or Claude's question, and its outcome.
public struct HandledCard: Sendable, Equatable {
    public var question: Bool
    public var outcome: HandledOutcome

    public init(question: Bool, outcome: HandledOutcome) {
        self.question = question
        self.outcome = outcome
    }
}

/// What a run holds.
public struct HandledCounts: Sendable, Equatable {
    public var permissions = 0
    public var questions = 0
    public var allowed = 0
    public var denied = 0
    public var handled = 0
    public var answered = 0
    public var skipped = 0

    public init() {}

    mutating func add(_ card: HandledCard) {
        if card.question { questions += 1 } else { permissions += 1 }
        switch card.outcome {
        case .allowed: allowed += 1
        case .denied: denied += 1
        case .handled: handled += 1
        case .answered: answered += 1
        case .skipped: skipped += 1
        }
    }

    /// "권한 3건 처리됨", "권한 2건 · 질문 1건 처리됨", "질문 2건 처리됨".
    public var summary: String {
        if permissions > 0, questions > 0 {
            return String(localized: "\(permissions) permission(s) · \(questions) question(s) handled", bundle: .module)
        }
        if questions > 0 { return String(localized: "\(questions) question(s) handled", bundle: .module) }
        return String(localized: "\(permissions) permission(s) handled", bundle: .module)
    }

    /// "허용 2 · 거부 1 · 건너뜀 1" — the outcomes that are not zero.
    public var detail: String {
        var parts: [String] = []
        if allowed > 0 { parts.append(String(localized: "Allowed \(allowed)", bundle: .module)) }
        if denied > 0 { parts.append(String(localized: "Denied \(denied)", bundle: .module)) }
        if answered > 0 { parts.append(String(localized: "Answered \(answered)", bundle: .module)) }
        if skipped > 0 { parts.append(String(localized: "Skipped \(skipped)", bundle: .module)) }
        if handled > 0 { parts.append(String(localized: "Handled elsewhere \(handled)", bundle: .module)) }
        return parts.joined(separator: " · ")
    }
}

public enum HandledCardFold {
    /// Fewer decided cards in a row than this stay as they are.
    public static let minCards = 2

    /// A run of decided cards shown as one line; `id` is its first entry's.
    public struct Run<Element>: Identifiable {
        public let id: UUID
        public let elements: [Element]
        public let counts: HandledCounts
    }

    /// One piece of the folded rows.
    public enum Piece<Element>: Identifiable {
        case single(id: UUID, Element)
        case run(Run<Element>)

        public var id: UUID {
            switch self {
            case let .single(id, _): id
            case let .run(run): run.id
            }
        }
    }

    /// A permission row's card: nil while it still waits for an answer (`isOpen`), and for every other row.
    public static func card(_ item: ChatItem, isOpen: Bool) -> HandledCard? {
        guard case let .permission(_, request, allowed) = item else { return nil }
        let question = request.toolName == AskUserQuestions.toolName
        switch allowed {
        case true?: return HandledCard(question: question, outcome: question ? .answered : .allowed)
        case false?: return HandledCard(question: question, outcome: question ? .skipped : .denied)
        case nil: return isOpen ? nil : HandledCard(question: question, outcome: .handled)
        }
    }

    /// `elements` with every run of at least `minCards` decided cards folded; `card` says what an element is (nil: not a
    /// decided card).
    public static func fold<Element>(_ elements: [Element], id: (Element) -> UUID, card: (Element) -> HandledCard?) -> [Piece<Element>] {
        var pieces: [Piece<Element>] = []
        var run: [Element] = []
        var counts = HandledCounts()
        func flush() {
            if run.count >= minCards, let first = run.first {
                pieces.append(.run(Run(id: id(first), elements: run, counts: counts)))
            } else {
                pieces.append(contentsOf: run.map { .single(id: id($0), $0) })
            }
            run = []
            counts = HandledCounts()
        }
        for element in elements {
            guard let c = card(element) else {
                flush()
                pieces.append(.single(id: id(element), element))
                continue
            }
            run.append(element)
            counts.add(c)
        }
        flush()
        return pieces
    }
}
