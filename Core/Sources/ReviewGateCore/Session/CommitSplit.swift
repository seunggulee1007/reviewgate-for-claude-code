import Foundation

// MARK: §53 commits in meaningful units
// docs/PROTOCOL.md §53 in the commit sheet's "나눠서 커밋" mode — the pure logic: the cards (the commits, in order) and
// "커밋하지 않음" as one state, moved part by part. A part is one hunk of a file that has hunks, or a whole-only file (`hunk`
// nil). The `commit_series` commits, the button's reason and the refusals in words live here too (the Electron client's
// commitSplit.ts).

/// One movable part: a hunk of a file that has hunks, or a whole-only file (`hunk` nil).
public struct SplitPart: Hashable, Sendable {
    public var path: String
    public var hunk: Int?

    public init(path: String, hunk: Int? = nil) {
        self.path = path
        self.hunk = hunk
    }

    /// `src/a.ts#2`, `logo.png#whole`.
    public var key: String { "\(path)#\(hunk.map(String.init) ?? "whole")" }
}

/// One commit of the series: its message, Claude's reason (from "AI로 나누기") and its parts in file order.
public struct SplitCard: Identifiable, Equatable, Sendable {
    public let id: Int
    public var message: String
    public var why: String?
    public var parts: [SplitPart]

    public init(id: Int, message: String = "", why: String? = nil, parts: [SplitPart] = []) {
        self.id = id
        self.message = message
        self.why = why
        self.parts = parts
    }
}

/// Where a part is or goes: a card (by id) or "커밋하지 않음".
public enum SplitTarget: Hashable, Sendable {
    case card(Int)
    case notCommitted
}

/// The cards and "커밋하지 않음". Every mutation keeps each part in exactly one place and every list in file order.
public struct CommitSplitState: Equatable, Sendable {
    public struct Snapshot: Equatable, Sendable {
        public var cards: [SplitCard]
        public var unassigned: [SplitPart]
        public var nextId: Int
    }

    public private(set) var cards: [SplitCard]
    /// "커밋하지 않음": these stay uncommitted and in the review.
    public private(set) var unassigned: [SplitPart]
    public private(set) var nextId: Int
    /// The arrangement before the last "AI로 나누기" (nil: none to restore).
    public private(set) var before: Snapshot?

    /// One card with everything (the mode works without Claude).
    public init(files: [CommitFile] = [], message: String = "") {
        cards = [SplitCard(id: 1, message: message, parts: Self.allParts(files))]
        unassigned = []
        nextId = 2
        before = nil
    }

    /// Every part the files can be split into, in file order.
    public static func allParts(_ files: [CommitFile]) -> [SplitPart] {
        files.flatMap { file in file.wholeOnly ? [SplitPart(path: file.path)] : file.hunks.map { SplitPart(path: file.path, hunk: $0.id) } }
    }

    /// Parts in file order, then hunk id (a card lists its files the way the diff does).
    static func sorted(_ parts: [SplitPart], files: [CommitFile]) -> [SplitPart] {
        let order = Dictionary(files.enumerated().map { ($1.path, $0) }, uniquingKeysWith: { first, _ in first })
        return parts.enumerated().sorted { a, b in
            let (fa, fb) = (order[a.element.path] ?? Int.max, order[b.element.path] ?? Int.max)
            if fa != fb { return fa < fb }
            let (ha, hb) = (a.element.hunk ?? -1, b.element.hunk ?? -1)
            return ha != hb ? ha < hb : a.offset < b.offset
        }.map(\.element)
    }

    public var canRestore: Bool { before != nil }

    /// The parts in `target` (none for an unknown card).
    public func parts(in target: SplitTarget) -> [SplitPart] {
        switch target {
        case .notCommitted: unassigned
        case let .card(id): cards.first { $0.id == id }?.parts ?? []
        }
    }

    /// The card's place, 1-based ("커밋 2").
    public func number(of card: Int) -> Int? {
        cards.firstIndex { $0.id == card }.map { $0 + 1 }
    }

    /// Where a part in `from` can go: the other cards in order, then "커밋하지 않음" (not from there).
    public func targets(from: SplitTarget) -> [SplitTarget] {
        cards.map { SplitTarget.card($0.id) }.filter { $0 != from } + (from == .notCommitted ? [] : [.notCommitted])
    }

    public mutating func setMessage(_ message: String, card: Int) {
        guard let i = cards.firstIndex(where: { $0.id == card }) else { return }
        cards[i].message = message
    }

    /// Every part of `path` in `from` (the whole file as this place holds it) to `to`. False when nothing moved.
    @discardableResult
    public mutating func moveFile(_ path: String, from: SplitTarget, to: SplitTarget, files: [CommitFile]) -> Bool {
        move(from: from, to: to, files: files) { $0.path == path }
    }

    /// One part (a hunk, or a whole-only file) from `from` to `to`. False when nothing moved.
    @discardableResult
    public mutating func movePart(_ part: SplitPart, from: SplitTarget, to: SplitTarget, files: [CommitFile]) -> Bool {
        move(from: from, to: to, files: files) { $0 == part }
    }

    private mutating func move(from: SplitTarget, to: SplitTarget, files: [CommitFile], where matches: (SplitPart) -> Bool) -> Bool {
        guard from != to else { return false }
        if case let .card(id) = to, !cards.contains(where: { $0.id == id }) { return false }
        let moving = parts(in: from).filter(matches)
        guard !moving.isEmpty else { return false }
        for i in cards.indices {
            if .card(cards[i].id) == from { cards[i].parts.removeAll(where: matches) }
            if .card(cards[i].id) == to { cards[i].parts = Self.sorted(cards[i].parts + moving, files: files) }
        }
        if from == .notCommitted { unassigned.removeAll(where: matches) }
        if to == .notCommitted { unassigned = Self.sorted(unassigned + moving, files: files) }
        return true
    }

    /// A new empty card at the end; its id.
    @discardableResult
    public mutating func addCard() -> Int {
        let id = nextId
        cards.append(SplitCard(id: id))
        nextId += 1
        return id
    }

    /// The card goes; its parts go to "커밋하지 않음".
    public mutating func deleteCard(_ id: Int, files: [CommitFile]) {
        guard let i = cards.firstIndex(where: { $0.id == id }) else { return }
        let card = cards.remove(at: i)
        unassigned = Self.sorted(unassigned + card.parts, files: files)
    }

    /// One place up (`by` -1) or down (+1); never past the ends.
    public mutating func reorder(_ id: Int, by offset: Int) {
        guard let i = cards.firstIndex(where: { $0.id == id }), cards.indices.contains(i + offset), offset != 0 else { return }
        cards.swapAt(i, i + offset)
    }

    /// Claude's proposal replaces the cards (kept for "원래대로 되돌리기"): only known paths and hunk ids, no part twice (a
    /// later repeat is dropped), a part without hunks = every hunk of its file; whatever no card took stays uncommitted.
    public mutating func propose(files: [CommitFile], commits: [CommitPlan], unassigned _: [CommitPart] = []) {
        let snapshot = Snapshot(cards: cards, unassigned: unassigned, nextId: nextId)
        let known = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        var used = Set<SplitPart>()
        func expand(_ part: CommitPart) -> [SplitPart] {
            guard let file = known[part.path] else { return [] }
            let ids: [Int?] = file.wholeOnly ? [nil]
                : (part.hunks.map { ids in ids.filter { id in file.hunks.contains { $0.id == id } } } ?? file.hunks.map(\.id))
            return ids.map { SplitPart(path: part.path, hunk: $0) }.filter { used.insert($0).inserted }
        }
        var id = nextId
        cards = commits.map { plan in
            defer { id += 1 }
            return SplitCard(id: id, message: plan.message, why: plan.why, parts: Self.sorted(plan.parts.flatMap(expand), files: files))
        }
        nextId = id
        // What the proposal left out (and anything the engine named in `unassigned`) stays uncommitted.
        unassigned = Self.allParts(files).filter { !used.contains($0) }
        before = snapshot
    }

    /// Back to the arrangement before the last "AI로 나누기".
    public mutating func restore() {
        guard let before else { return }
        cards = before.cards
        unassigned = before.unassigned
        nextId = before.nextId
        self.before = nil
    }

    /// The `commit_series` commits: a file that has hunks always goes as `hunks` (even all of them), a whole-only file
    /// whole; messages trimmed.
    public func series() -> [CommitPlan] {
        cards.map { card in
            var order: [String] = []
            var hunks: [String: [Int]] = [:]
            var whole = Set<String>()
            for part in card.parts {
                if !order.contains(part.path) { order.append(part.path) }
                if let hunk = part.hunk { hunks[part.path, default: []].append(hunk) } else { whole.insert(part.path) }
            }
            let parts = order.map { CommitPart(path: $0, hunks: whole.contains($0) ? nil : hunks[$0]?.sorted()) }
            return CommitPlan(message: card.message.trimmingCharacters(in: .whitespacesAndNewlines), parts: parts)
        }
    }

    /// Why "커밋 N개 만들기" is off; nil = it can run.
    public func blocker(splitting: Bool = false, committing: Bool = false) -> String? {
        if splitting { return CommitSplitText.splitting }
        if committing { return CommitSplitText.committing }
        if cards.isEmpty { return String(localized: "Add a commit first", bundle: .module) }
        if let i = cards.firstIndex(where: { $0.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return String(localized: "Commit \(i + 1) has no message", bundle: .module)
        }
        if let i = cards.firstIndex(where: { $0.parts.isEmpty }) {
            return String(localized: "Commit \(i + 1) has no changes", bundle: .module)
        }
        return nil
    }
}

// MARK: - Words

/// The split sheet's words that depend on the engine: its progress, the result, and the refusals of the three §53 commands.
public enum CommitSplitText {
    public static var splitting: String { String(localized: "Splitting…", bundle: .module) }
    public static var committing: String { String(localized: "Committing…", bundle: .module) }
    public static var loading: String { String(localized: "Loading…", bundle: .module) }
    /// "커밋 N개 만들기" after a series stopped in the middle: making it again would repeat the commits.
    public static var stopped: String { String(localized: "Close this sheet — some commits were already made", bundle: .module) }

    /// "커밋 3개를 만들었어요 (a1b2c3d, …)", then "· 푸시함" when pushed.
    public static func done(_ made: [SeriesCommit], pushed: Bool) -> String {
        let line = String(localized: "Made \(made.count) commit(s): \(made.map(\.shortSha).joined(separator: ", "))", bundle: .module)
        return pushed ? "\(line) · \(String(localized: "pushed", bundle: .module))" : line
    }

    /// A refusal of `commit_hunks` / `commit_split_draft` / `commit_series` in the user's words.
    public static func refusal(_ error: Error) -> String {
        guard let error = error as? EngineClientError, case let .refused(message, code, paths, _) = error else {
            return FlowText.refusal(error)
        }
        let word = code ?? EngineMessages.codeWord(message)
        return refusal(code: word, detail: EngineMessages.detail(of: message, code: word))
            ?? FlowText.refusal(code: word, detail: EngineMessages.detail(of: message, code: word))
            ?? EngineMessages.refusal(code: code, error: message, paths: paths)
    }

    /// nil = a code the flow screens' words (`FlowText`, then `EngineMessages`) cover.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "commit_split_failed":
            return detail.isEmpty ? String(localized: "Claude could not split the changes", bundle: .module)
                : String(localized: "Claude could not split the changes: \(detail)", bundle: .module)
        case "invalid_part":
            return String(localized: "\(detail) cannot be committed this way — it is not an accepted file, or the part is gone", bundle: .module)
        case "hunk_twice": return String(localized: "\(detail) is in two commits — a part can only be in one", bundle: .module)
        case "empty_message": return String(localized: "A commit has no message", bundle: .module)
        case "merge_unresolved": return String(localized: "There are unresolved merge conflicts — resolve them first", bundle: .module)
        case "commit_failed":
            return detail.isEmpty ? String(localized: "git could not commit", bundle: .module)
                : String(localized: "git could not commit: \(detail)", bundle: .module)
        default: return nil
        }
    }

    /// A series that stopped: what was made, then why.
    public static func failure(_ error: Error, made: [SeriesCommit]) -> String {
        let why = refusal(error)
        guard !made.isEmpty else { return why }
        let line = String(localized: "Made \(made.count) commit(s): \(made.map(\.shortSha).joined(separator: ", "))", bundle: .module)
        return "\(line) — \(String(localized: "then it stopped", bundle: .module)): \(why)"
    }
}
