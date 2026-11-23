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

    public init(path: String, line: Int, column: Int = 1, kind: DefinitionKind, preview: String, score: Double = 0) {
        self.path = path
        self.line = line
        self.column = column
        self.kind = kind
        self.preview = preview
        self.score = score
    }

    private enum CodingKeys: String, CodingKey { case path, line, column, kind, preview, score }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path), !path.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "no path")
        }
        self.init(path: path, line: max(1, lenientValue(Int.self, c, .line) ?? 1), column: max(1, lenientValue(Int.self, c, .column) ?? 1),
                  kind: lenientValue(DefinitionKind.self, c, .kind) ?? DefinitionKind(rawValue: ""),
                  preview: lenientValue(String.self, c, .preview) ?? "", score: lenientValue(Double.self, c, .score) ?? 0)
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

    public init(id: String? = nil, symbol: String, candidates: [DefinitionCandidate], truncated: Bool = false, timedOut: Bool = false) {
        self.id = id
        self.symbol = symbol
        self.candidates = candidates
        self.truncated = truncated
        self.timedOut = timedOut
    }

    private enum CodingKeys: String, CodingKey { case id, symbol, candidates, truncated, timedOut }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), symbol: lenientValue(String.self, c, .symbol) ?? "",
                  candidates: lenientElements(DefinitionCandidate.self, c, .candidates),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, timedOut: lenientValue(Bool.self, c, .timedOut) ?? false)
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

    public init(id: String? = nil, symbol: String, hits: [ReferenceHit], files: Int? = nil, truncated: Bool = false, timedOut: Bool = false) {
        self.id = id
        self.symbol = symbol
        self.hits = hits
        self.files = files ?? Set(hits.map(\.path)).count
        self.truncated = truncated
        self.timedOut = timedOut
    }

    private enum CodingKeys: String, CodingKey { case id, symbol, hits, files, truncated, timedOut }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), symbol: lenientValue(String.self, c, .symbol) ?? "",
                  hits: lenientElements(ReferenceHit.self, c, .hits), files: lenientValue(Int.self, c, .files),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, timedOut: lenientValue(Bool.self, c, .timedOut) ?? false)
    }
}
