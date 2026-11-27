import Foundation

// MARK: lsp — docs/PROTOCOL.md §73: the language server for JS / TS / Vue on the wire — who answered a definition or a
// references lookup, why the search answered instead, the clicked name's type, and `state.nav.lsp`. Read leniently: an
// older engine sends none of it (its answers are the search's).

/// §73: the language server (exact) or §62 / §65's search (approximate).
public enum NavSource: String, Sendable, Hashable, Codable {
    case lsp
    case grep
}

/// §73.3: why a JS / TS / Vue lookup was answered by the search.
public enum LspFallback: String, Sendable, Hashable, Codable {
    case off
    case starting
    case timeout
    case failed
    case unavailable
    case noResult = "no_result"
}

/// §73.3: tsserver's quickinfo of the clicked name (`function formatPrice(n: number): string`), its doc comment and kind.
public struct LspQuickInfo: Sendable, Hashable, Decodable {
    public var display: String
    public var documentation: String?
    public var kind: String?

    public init(display: String, documentation: String? = nil, kind: String? = nil) {
        self.display = display
        self.documentation = documentation
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey { case display, documentation, kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let display = lenientValue(String.self, c, .display), !display.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .display, in: c, debugDescription: "no display")
        }
        self.init(display: display, documentation: lenientValue(String.self, c, .documentation).flatMap { $0.isEmpty ? nil : $0 },
                  kind: lenientValue(String.self, c, .kind))
    }
}

/// §73.2: `state.nav.lsp` — absent while the server is idle (not started yet, stopped after 10 idle minutes) or off.
public struct LspState: Sendable, Equatable, Codable {
    public enum Status: String, Sendable, Codable { case starting, ready, failed, unavailable }
    public struct TypeScript: Sendable, Equatable, Codable {
        public var version: String
        /// `project` (the project's own node_modules) or `bundled`.
        public var source: String
        public init(version: String, source: String) {
            self.version = version
            self.source = source
        }
    }

    public var status: Status
    public var typescript: TypeScript?
    /// failed / unavailable: why (English).
    public var error: String?
    public var restarts: Int?

    public init(status: Status, typescript: TypeScript? = nil, error: String? = nil, restarts: Int? = nil) {
        self.status = status
        self.typescript = typescript
        self.error = error
        self.restarts = restarts
    }

    private enum CodingKeys: String, CodingKey { case status, typescript, error, restarts }

    /// An unknown status fails the decode (the field is then absent: idle).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(status: try c.decode(Status.self, forKey: .status), typescript: lenientValue(TypeScript.self, c, .typescript),
                  error: lenientValue(String.self, c, .error), restarts: lenientValue(Int.self, c, .restarts))
    }
}
