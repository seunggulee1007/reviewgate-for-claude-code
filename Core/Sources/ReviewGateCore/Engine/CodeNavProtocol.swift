// MARK: code-nav — docs/PROTOCOL.md §62: go to definition and find references on the wire. Every field is read leniently:
// an odd value never fails the whole reply, an odd element is dropped.
import Foundation

/// What a definition line declares (§62). An unknown word from a newer engine is kept as it came.
public struct DefinitionKind: RawRepresentable, Sendable, Hashable, Decodable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let `class` = DefinitionKind(rawValue: "class")
    public static let interface = DefinitionKind(rawValue: "interface")
    public static let method = DefinitionKind(rawValue: "method")
    public static let function = DefinitionKind(rawValue: "function")
    public static let component = DefinitionKind(rawValue: "component")
    public static let tag = DefinitionKind(rawValue: "tag")
    public static let file = DefinitionKind(rawValue: "file")

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One place the symbol may be declared: repo-relative path, 1-based line and column (UTF-16 units of the line), the line
/// without its indent, and a score that only orders the candidates.
public struct DefinitionCandidate: Sendable, Hashable, Decodable {
    public var path: String
    public var line: Int
    public var column: Int
    public var kind: DefinitionKind
    public var preview: String
    public var score: Double
    /// §65.6: the enclosing container (`CartService`, `Repo.Companion`), when the engine's index read it.
    public var container: String?

    public init(path: String, line: Int, column: Int = 1, kind: DefinitionKind, preview: String, score: Double = 0, container: String? = nil) {
        self.path = path
        self.line = line
        self.column = column
        self.kind = kind
        self.preview = preview
        self.score = score
        self.container = container
    }

    private enum CodingKeys: String, CodingKey { case path, line, column, kind, preview, score, container }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path), !path.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "no path")
        }
        self.init(path: path, line: max(1, lenientValue(Int.self, c, .line) ?? 1), column: max(1, lenientValue(Int.self, c, .column) ?? 1),
                  kind: lenientValue(DefinitionKind.self, c, .kind) ?? DefinitionKind(rawValue: ""),
                  preview: lenientValue(String.self, c, .preview) ?? "", score: lenientValue(Double.self, c, .score) ?? 0,
                  container: lenientValue(String.self, c, .container).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// Reply to `find_definition`: the candidates best first (≤ 50); `truncated` when there were more, `timedOut` when the search
/// was stopped after 10 s.
public struct DefinitionsReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var symbol: String
    public var candidates: [DefinitionCandidate]
    public var truncated: Bool
    public var timedOut: Bool
    /// MARK: lsp — §73: who answered (nil: an older engine — the search).
    public var source: NavSource?
    /// §73: the search answered a JS / TS / Vue lookup — why.
    public var fallback: LspFallback?
    /// §73: the clicked name's type / signature (the language server's answers only).
    public var quickInfo: LspQuickInfo?

    public init(id: String? = nil, symbol: String, candidates: [DefinitionCandidate], truncated: Bool = false, timedOut: Bool = false,
                source: NavSource? = nil, fallback: LspFallback? = nil, quickInfo: LspQuickInfo? = nil) {
        self.id = id
        self.symbol = symbol
        self.candidates = candidates
        self.truncated = truncated
        self.timedOut = timedOut
        self.source = source
        self.fallback = fallback
        self.quickInfo = quickInfo
    }

    private enum CodingKeys: String, CodingKey { case id, symbol, candidates, truncated, timedOut, source, fallback, quickInfo }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), symbol: lenientValue(String.self, c, .symbol) ?? "",
                  candidates: lenientElements(DefinitionCandidate.self, c, .candidates),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, timedOut: lenientValue(Bool.self, c, .timedOut) ?? false,
                  source: lenientValue(NavSource.self, c, .source), fallback: lenientValue(LspFallback.self, c, .fallback),
                  quickInfo: lenientValue(LspQuickInfo.self, c, .quickInfo))
    }
}

/// One line holding the symbol as a whole word; `kind` when the line is a definition.
public struct ReferenceHit: Sendable, Hashable, Decodable {
    public var path: String
    public var line: Int
    public var column: Int
    public var preview: String
    public var kind: DefinitionKind?

    public init(path: String, line: Int, column: Int = 1, preview: String, kind: DefinitionKind? = nil) {
        self.path = path
        self.line = line
        self.column = column
        self.preview = preview
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey { case path, line, column, preview, kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path), !path.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "no path")
        }
        self.init(path: path, line: max(1, lenientValue(Int.self, c, .line) ?? 1), column: max(1, lenientValue(Int.self, c, .column) ?? 1),
                  preview: lenientValue(String.self, c, .preview) ?? "", kind: lenientValue(DefinitionKind.self, c, .kind))
    }
}

/// Reply to `find_references`: the clicked file's lines first, then its folder's, then the rest by path; `files` counts the
/// files; `truncated` past the limit, `timedOut` when the search was stopped after 15 s.
public struct ReferencesReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var symbol: String
    public var hits: [ReferenceHit]
    public var files: Int
    public var truncated: Bool
    public var timedOut: Bool
    /// MARK: lsp — §73 (as `DefinitionsReply`).
    public var source: NavSource?
    public var fallback: LspFallback?

    public init(id: String? = nil, symbol: String, hits: [ReferenceHit], files: Int? = nil, truncated: Bool = false, timedOut: Bool = false,
                source: NavSource? = nil, fallback: LspFallback? = nil) {
        self.id = id
        self.symbol = symbol
        self.hits = hits
        self.files = files ?? Set(hits.map(\.path)).count
        self.truncated = truncated
        self.timedOut = timedOut
        self.source = source
        self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, symbol, hits, files, truncated, timedOut, source, fallback }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), symbol: lenientValue(String.self, c, .symbol) ?? "",
                  hits: lenientElements(ReferenceHit.self, c, .hits), files: lenientValue(Int.self, c, .files),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, timedOut: lenientValue(Bool.self, c, .timedOut) ?? false,
                  source: lenientValue(NavSource.self, c, .source), fallback: lenientValue(LspFallback.self, c, .fallback))
    }
}

// MARK: ide-nav — docs/PROTOCOL.md §65: the symbol index on the wire (outline, symbols in the project, the peek / hover
// body, the index's state). Read leniently as §62's replies.

/// One declaration (§65): its name, kind, place (repo-relative, 1-based line and UTF-16 column), the enclosing container
/// (`Outer.Inner`), its line trimmed (`signature`) and — for a container — the last line of its body.
public struct NavSymbol: Sendable, Hashable, Decodable {
    public var name: String
    public var kind: DefinitionKind
    public var path: String
    public var line: Int
    public var column: Int
    public var container: String?
    public var signature: String?
    public var endLine: Int?

    public init(name: String, kind: DefinitionKind, path: String, line: Int, column: Int = 1, container: String? = nil,
                signature: String? = nil, endLine: Int? = nil) {
        self.name = name
        self.kind = kind
        self.path = path
        self.line = line
        self.column = column
        self.container = container
        self.signature = signature
        self.endLine = endLine
    }

    fileprivate enum CodingKeys: String, CodingKey { case name, kind, path, line, column, container, signature, endLine }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let name = lenientValue(String.self, c, .name), !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "no name")
        }
        self.init(name: name, kind: lenientValue(DefinitionKind.self, c, .kind) ?? DefinitionKind(rawValue: ""),
                  path: lenientValue(String.self, c, .path) ?? "", line: max(1, lenientValue(Int.self, c, .line) ?? 1),
                  column: max(1, lenientValue(Int.self, c, .column) ?? 1),
                  container: lenientValue(String.self, c, .container).flatMap { $0.isEmpty ? nil : $0 },
                  signature: lenientValue(String.self, c, .signature).flatMap { $0.isEmpty ? nil : $0 },
                  endLine: lenientValue(Int.self, c, .endLine))
    }

    /// `Container.name`, or the name alone.
    public var qualifiedName: String { container.map { "\($0).\(name)" } ?? name }
}

/// §65.2: a symbol of the outline — `depth` containers of the file around it (0 = top level).
public struct DocumentSymbol: Sendable, Hashable, Decodable {
    public var symbol: NavSymbol
    public var depth: Int

    public init(_ symbol: NavSymbol, depth: Int = 0) {
        self.symbol = symbol
        self.depth = depth
    }

    private enum CodingKeys: String, CodingKey { case depth }

    public init(from decoder: Decoder) throws {
        let symbol = try NavSymbol(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(symbol, depth: max(0, lenientValue(Int.self, c, .depth) ?? 0))
    }
}

/// §65.3: a symbol of the project — `matches` are the 0-based UTF-16 offsets of the query's characters in `name`.
public struct WorkspaceSymbol: Sendable, Hashable, Decodable {
    public var symbol: NavSymbol
    public var matches: [Int]

    public init(_ symbol: NavSymbol, matches: [Int] = []) {
        self.symbol = symbol
        self.matches = matches
    }

    private enum CodingKeys: String, CodingKey { case matches }

    public init(from decoder: Decoder) throws {
        let symbol = try NavSymbol(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(symbol, matches: lenientValue([Int].self, c, .matches) ?? [])
    }
}

/// §65.1: `state.nav.index` — the symbol index of the open worktree.
public struct NavIndexState: Sendable, Equatable, Codable {
    public enum Status: String, Sendable, Codable { case idle, building, ready, failed }

    public var status: Status
    public var files: Int
    public var symbols: Int
    /// The symbol cap or the time budget cut the last build short.
    public var truncated: Bool
    /// ISO-8601 of the last finished build.
    public var builtAt: String?
    /// While building: the files to read.
    public var filesTotal: Int?
    public var durationMs: Int?
    /// `failed`: git's first line.
    public var error: String?

    public init(status: Status, files: Int = 0, symbols: Int = 0, truncated: Bool = false, builtAt: String? = nil,
                filesTotal: Int? = nil, durationMs: Int? = nil, error: String? = nil) {
        self.status = status
        self.files = files
        self.symbols = symbols
        self.truncated = truncated
        self.builtAt = builtAt
        self.filesTotal = filesTotal
        self.durationMs = durationMs
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case status, files, symbols, truncated, builtAt, filesTotal, durationMs, error }

    /// Never fails: an unknown status reads as `idle`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(status: lenientValue(Status.self, c, .status) ?? .idle, files: lenientValue(Int.self, c, .files) ?? 0,
                  symbols: lenientValue(Int.self, c, .symbols) ?? 0, truncated: lenientValue(Bool.self, c, .truncated) ?? false,
                  builtAt: lenientValue(String.self, c, .builtAt), filesTotal: lenientValue(Int.self, c, .filesTotal),
                  durationMs: lenientValue(Int.self, c, .durationMs), error: lenientValue(String.self, c, .error))
    }

    public var isBuilding: Bool { status == .building }
}

/// §65: `state.nav`.
public struct NavState: Sendable, Equatable, Codable {
    public var index: NavIndexState
    /// MARK: lsp — §73.2: the language server (nil: idle, off, or an older engine).
    public var lsp: LspState?

    public init(index: NavIndexState, lsp: LspState? = nil) {
        self.index = index
        self.lsp = lsp
    }

    private enum CodingKeys: String, CodingKey { case index, lsp }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(index: lenientValue(NavIndexState.self, c, .index) ?? NavIndexState(status: .idle), lsp: lenientValue(LspState.self, c, .lsp))
    }
}

/// §65.2: reply to `document_symbols` — every symbol of the file in file order.
public struct DocumentSymbolsReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String
    public var language: String
    public var symbols: [DocumentSymbol]
    public var truncated: Bool

    public init(id: String? = nil, path: String, language: String = "plaintext", symbols: [DocumentSymbol], truncated: Bool = false) {
        self.id = id
        self.path = path
        self.language = language
        self.symbols = symbols
        self.truncated = truncated
    }

    private enum CodingKeys: String, CodingKey { case id, path, language, symbols, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), path: lenientValue(String.self, c, .path) ?? "",
                  language: lenientValue(String.self, c, .language) ?? "plaintext",
                  symbols: lenientElements(DocumentSymbol.self, c, .symbols), truncated: lenientValue(Bool.self, c, .truncated) ?? false)
    }
}

/// §65.3: reply to `workspace_symbols` — best first; `index` as it was when the engine answered.
public struct WorkspaceSymbolsReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var query: String
    public var symbols: [WorkspaceSymbol]
    public var truncated: Bool
    public var index: NavIndexState

    public init(id: String? = nil, query: String, symbols: [WorkspaceSymbol], truncated: Bool = false, index: NavIndexState = NavIndexState(status: .ready)) {
        self.id = id
        self.query = query
        self.symbols = symbols
        self.truncated = truncated
        self.index = index
    }

    private enum CodingKeys: String, CodingKey { case id, query, symbols, truncated, index }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), query: lenientValue(String.self, c, .query) ?? "",
                  symbols: lenientElements(WorkspaceSymbol.self, c, .symbols), truncated: lenientValue(Bool.self, c, .truncated) ?? false,
                  index: lenientValue(NavIndexState.self, c, .index) ?? NavIndexState(status: .ready))
    }
}

/// §65.5: reply to `definition_preview` — lines `startLine…` of the file around `line`; `symbol` the declaration on `line`.
public struct SymbolPreviewReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String
    public var line: Int
    public var startLine: Int
    public var lines: [String]
    public var totalLines: Int
    public var language: String
    public var truncated: Bool
    public var symbol: NavSymbol?

    public init(id: String? = nil, path: String, line: Int, startLine: Int, lines: [String], totalLines: Int? = nil,
                language: String = "plaintext", truncated: Bool = false, symbol: NavSymbol? = nil) {
        self.id = id
        self.path = path
        self.line = line
        self.startLine = startLine
        self.lines = lines
        self.totalLines = totalLines ?? (startLine + lines.count - 1)
        self.language = language
        self.truncated = truncated
        self.symbol = symbol
    }

    private enum CodingKeys: String, CodingKey { case id, path, line, startLine, lines, totalLines, language, truncated, symbol }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let line = max(1, lenientValue(Int.self, c, .line) ?? 1)
        self.init(id: lenientValue(String.self, c, .id), path: lenientValue(String.self, c, .path) ?? "", line: line,
                  startLine: max(1, lenientValue(Int.self, c, .startLine) ?? line), lines: lenientValue([String].self, c, .lines) ?? [],
                  totalLines: lenientValue(Int.self, c, .totalLines), language: lenientValue(String.self, c, .language) ?? "plaintext",
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, symbol: lenientValue(NavSymbol.self, c, .symbol))
    }

    /// The index into `lines` of `line` (nil when the slice does not hold it).
    public var focusIndex: Int? {
        let i = line - startLine
        return lines.indices.contains(i) ? i : nil
    }
}

/// §65.1: reply to `nav_index_build` — the index's state at once (the build runs on in the background).
public struct NavIndexReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var index: NavIndexState

    public init(id: String? = nil, index: NavIndexState) {
        self.id = id
        self.index = index
    }

    private enum CodingKeys: String, CodingKey { case id, index }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), index: lenientValue(NavIndexState.self, c, .index) ?? NavIndexState(status: .idle))
    }
}
