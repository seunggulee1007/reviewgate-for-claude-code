import Foundation
import Observation

// MARK: ide-nav — docs/PROTOCOL.md §65.8 on the Mac: the hover card — ⌘ held over a name for 600 ms shows its definition's
// signature and first lines (App `IdeNavViews.swift`). Tested in `IdeNavTests`.

/// §65.8 "Hover preview": the pointer resting on a name with ⌘ held for `CodeNavHoverStore.delay` shows its definition's
/// signature and first lines. The waiting is this pure state: a new key restarts it, nil stops it; only the newest
/// wait's answer is shown.
public struct CodeNavHoverDebounce: Sendable, Equatable {
    /// What the pointer rests on: the name and where it is (row, column).
    public struct Key: Sendable, Equatable {
        public var symbol: String
        public var at: CodeNavLocation
        /// The row (`CodeNavPointer`'s token) the card hangs from.
        public var anchor: Int

        public init(symbol: String, at: CodeNavLocation, anchor: Int) {
            self.symbol = symbol
            self.at = at
            self.anchor = anchor
        }
    }

    public private(set) var key: Key?
    public private(set) var seq = 0

    public init() {}

    /// The pointer is over `key` now (nil: over no name, or ⌘ released). A different key returns the number of the wait
    /// to start (nil for nil); the same key again changes nothing (nil).
    public mutating func update(_ next: Key?) -> Int? {
        guard next != key else { return nil }
        key = next
        seq += 1
        return next == nil ? nil : seq
    }

    /// Whether wait `n` is still the one that counts.
    public func isCurrent(_ n: Int) -> Bool { n == seq && key != nil }
}

/// The hover card's store: one wait at a time, at most one request in flight (a newer pointer position cancels the older
/// one's task, and a reply for an older wait is dropped).
@MainActor
@Observable
public final class CodeNavHoverStore {
    public struct Card: Equatable {
        public var key: CodeNavHoverDebounce.Key
        public var candidate: DefinitionCandidate
        public var preview: SymbolPreviewReply
        /// How many other candidates there are (the card says "+N more").
        public var others: Int
    }

    /// How long the pointer rests before the card is asked for.
    public static let delay: Duration = .milliseconds(600)
    /// Lines after the definition line the card shows.
    public static let lines = 8

    public private(set) var card: Card?
    @ObservationIgnored public private(set) var debounce = CodeNavHoverDebounce()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored var wait: Duration = CodeNavHoverStore.delay

    public init() {}

    /// The pointer moved: over `key` with ⌘ held, or not (nil). `receiver` as for Go to Definition.
    func pointer(_ key: CodeNavHoverDebounce.Key?, receiver: String?,
                 using request: @escaping @MainActor (EngineCommand) async throws -> EngineEvent) {
        guard let n = debounce.update(key) else {
            if key == nil {
                task?.cancel()
                task = nil
                if card != nil { card = nil }   // never written when unchanged: every row's popover reads it
            }
            return
        }
        task?.cancel()
        if card != nil, card?.key != key { card = nil }
        guard let key else { return }
        let wait = wait
        task = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard let self, !Task.isCancelled, self.debounce.isCurrent(n) else { return }
            await self.load(key, n: n, receiver: receiver, using: request)
        }
    }

    private func load(_ key: CodeNavHoverDebounce.Key, n: Int, receiver: String?,
                      using request: @MainActor (EngineCommand) async throws -> EngineEvent) async {
        guard case let .definitions(defs)? = try? await request(.findDefinition(symbol: key.symbol, fromPath: key.at.path, line: key.at.line,
                                                                                column: key.at.column, receiver: receiver)),
              !Task.isCancelled, debounce.isCurrent(n), let first = defs.candidates.first
        else { return }
        guard case let .definitionPreview(p)? = try? await request(.definitionPreview(path: first.path, line: first.line, after: Self.lines)),
              !Task.isCancelled, debounce.isCurrent(n)
        else { return }
        card = Card(key: key, candidate: first, preview: p, others: defs.candidates.count - 1)
    }

    /// The card goes (a click, Esc, the window losing the pointer).
    public func dismiss() {
        _ = debounce.update(nil)
        task?.cancel()
        task = nil
        if card != nil { card = nil }
    }
}

extension AppState {
    /// The pointer over a name with ⌘ held (`key`), or not (nil): the hover card after a rest.
    public func hoverDefinition(_ key: CodeNavHoverDebounce.Key?, receiver: String?) {
        guard projectInfo != nil || key == nil else { return }
        codeNav.hover.pointer(key, receiver: receiver) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }
}
