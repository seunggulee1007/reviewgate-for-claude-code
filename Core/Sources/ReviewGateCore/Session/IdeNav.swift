import Foundation
import Observation

// MARK: ide-nav — docs/PROTOCOL.md §65.8 on the Mac: reading code without leaving the place. The peek band under a clicked
// row (⌥F12, ⌘-click when Settings says 미리 보기). Pure rules and the store here (tested in `IdeNavTests`); the views are
// App `IdeNavViews.swift`.

/// What ⌘-click on a name does (Settings › Review › Diff; user defaults `codeNavCommandClick`). F12 always jumps, ⌥F12 always
/// peeks.
public enum CodeNavCommandClick: String, Sendable, CaseIterable, Identifiable {
    /// The definition in a band under the line — the default: a review tool is read in place.
    case peek
    /// Jump to it, as before (§62).
    case open

    public var id: String { rawValue }
    public static let defaultsKey = "codeNavCommandClick"

    public static func current(_ defaults: UserDefaults = .standard) -> CodeNavCommandClick {
        CodeNavCommandClick(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .peek
    }
}

public enum IdeNavText {
    /// "CartService.kt:42 — CartService.total": the band's and the card's title.
    public static func title(_ candidate: DefinitionCandidate, symbol: NavSymbol? = nil, fallback: String) -> String {
        let file = (candidate.path as NSString).lastPathComponent
        let name = symbol?.qualifiedName ?? candidate.container.map { "\($0).\(fallback)" } ?? fallback
        return "\(file):\(candidate.line) — \(name)"
    }

    /// The bare word of a symbol the preview names (`C` of `a.b.C`, `out` of `c:out`, a path's file name).
    public static func bare(_ symbol: String) -> String {
        if symbol.contains("/") { return (symbol as NSString).lastPathComponent }
        if let colon = symbol.lastIndex(of: ":") { return String(symbol[symbol.index(after: colon)...]) }
        let ext = (symbol as NSString).pathExtension.lowercased()
        if let dot = symbol.lastIndex(of: "."), !["jsp", "jspf", "jspx", "vue", "js", "ts", "tag", "tagx", "html"].contains(ext) {
            return String(symbol[symbol.index(after: dot)...])
        }
        return symbol
    }
}

// MARK: - The peek band

/// §65.8 "Peek definition": the definition shown inline under the clicked row — the candidates, the one picked and its
/// lines. One band per window; a new peek replaces it, Esc / × closes it, 열기 jumps (Back returns).
@MainActor
@Observable
public final class CodeNavPeekStore {
    public enum Status: Equatable, Sendable {
        case looking
        case found
        case notFound
        case failed(String)
    }

    public enum Preview: Equatable, Sendable {
        case loading
        case loaded(SymbolPreviewReply)
        case failed(String)
    }

    public struct Band: Equatable {
        public var symbol: String
        /// The row it hangs under: view, file and line (no column) — and its text, to tell rows of one line apart.
        public var row: CodeNavLocation
        public var rowText: String
        /// Where the click was (with its column): what Back returns to after 열기.
        public var from: CodeNavLocation
        public var status: Status
        public var reply: DefinitionsReply?
        public var selected: Int
        public var preview: Preview?
        /// Bumped by every new peek (the band takes the keyboard again).
        public var tick: Int

        public var candidates: [DefinitionCandidate] { reply?.candidates ?? [] }
        public var current: DefinitionCandidate? { candidates.indices.contains(selected) ? candidates[selected] : nil }
    }

    public private(set) var band: Band?
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var previewSeq = 0
    @ObservationIgnored private var tick = 0
    /// Previews already read, by `path:line` (switching back and forth asks once).
    @ObservationIgnored private var cache: [String: SymbolPreviewReply] = [:]

    public init() {}

    /// Whether the band hangs under the row at `row` drawing `text`.
    public func shows(row: CodeNavLocation, text: String) -> Bool {
        guard let band else { return false }
        return band.row.view == row.view && band.row.path == row.path && band.row.line == row.line && band.rowText == text
    }

    /// Looks `symbol` up from the row and shows what it finds: the first candidate's lines, the others to switch to.
    func peek(_ symbol: String, row: CodeNavLocation, rowText: String, from: CodeNavLocation, receiver: String?,
              using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        seq += 1
        tick += 1
        let mine = seq
        var at = row
        at.column = nil
        band = Band(symbol: symbol, row: at, rowText: rowText, from: from, status: .looking, reply: nil, selected: 0, preview: nil, tick: tick)
        do {
            let reply = try await request(.findDefinition(symbol: symbol, fromPath: from.path, line: from.line, column: from.column, receiver: receiver))
            guard mine == seq, band != nil else { return }
            guard case let .definitions(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            band?.reply = r
            band?.status = r.candidates.isEmpty ? .notFound : .found
            if !r.candidates.isEmpty { await loadPreview(using: request) }
        } catch {
            guard mine == seq, band != nil else { return }
            band?.status = .failed(CodeNavText.message(error))
        }
    }

    /// Picks candidate `index` and shows its lines.
    func select(_ index: Int, using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        guard let band, band.candidates.indices.contains(index), index != band.selected || band.preview == nil else { return }
        self.band?.selected = index
        await loadPreview(using: request)
    }

    /// ↑ / ↓ in the band: the previous / next candidate (stops at the ends).
    func move(_ delta: Int, using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        guard let band, !band.candidates.isEmpty else { return }
        let next = min(max(0, band.selected + delta), band.candidates.count - 1)
        await select(next, using: request)
    }

    private func loadPreview(using request: (EngineCommand) async throws -> EngineEvent) async {
        guard let candidate = band?.current else { return }
        previewSeq += 1
        let mine = previewSeq
        let key = "\(candidate.path):\(candidate.line)"
        if let hit = cache[key] {
            band?.preview = .loaded(hit)
            return
        }
        band?.preview = .loading
        do {
            let reply = try await request(.definitionPreview(path: candidate.path, line: candidate.line))
            guard mine == previewSeq, band?.current == candidate else { return }
            guard case let .definitionPreview(p) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            cache[key] = p
            band?.preview = .loaded(p)
        } catch {
            guard mine == previewSeq, band?.current == candidate else { return }
            band?.preview = .failed(CodeNavText.message(error))
        }
    }

    public func close() {
        seq += 1
        previewSeq += 1
        band = nil
    }

    /// The project changed or closed (or a turn changed the files: what was read may be old).
    public func reset() {
        close()
        cache = [:]
    }

    /// Forgets the lines read (the files may have changed); the band on screen keeps what it shows.
    public func forgetPreviews() {
        cache = [:]
    }
}

extension AppState {
    /// ⌥F12 / ⌘-click (미리 보기): the definition of `symbol` in a band under the row at `row` (its text `rowText`), the
    /// click at `from` (with its column).
    public func peekDefinition(_ symbol: String, row: CodeNavLocation, rowText: String, from: CodeNavLocation, receiver: String?) async {
        guard projectInfo != nil else { return }
        codeNav.dismissPopup()
        codeNav.caret = row
        await codeNav.peek.peek(symbol, row: row, rowText: rowText, from: from, receiver: receiver) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// The band's candidate list: show candidate `index` (or move by `delta`).
    public func peekSelect(_ index: Int) async {
        await codeNav.peek.select(index) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    public func peekMove(_ delta: Int) async {
        await codeNav.peek.move(delta) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// 열기 / ↩ in the band: jump to the picked candidate (Back returns to the click); the band closes.
    public func openPeekSelection() {
        guard let band = codeNav.peek.band, let c = band.current else { return }
        codeNav.peek.close()
        openNavPlace(path: c.path, line: c.line, column: c.column, kind: c.kind, from: band.from)
    }
}
