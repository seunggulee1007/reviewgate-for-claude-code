import Foundation

// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts": the wire types. Every field is read leniently;
// an engine before §38.3 sends none of them (no paging, the chat search stays on titles, no reason in a past diff).

/// §38.3: reply to `transcript_page` — rows `start`…`before - 1` of a chat (oldest first); `start > 0`: older ones exist.
public struct TranscriptPageReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var sessionId: String
    public var items: [TranscriptItem]
    public var start: Int
    public var before: Int

    public init(id: String? = nil, sessionId: String, items: [TranscriptItem], start: Int, before: Int) {
        self.id = id
        self.sessionId = sessionId
        self.items = items
        self.start = start
        self.before = before
    }

    private enum CodingKeys: String, CodingKey { case id, sessionId, items, start, before }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try? c.decodeIfPresent(String.self, forKey: .id),
                  sessionId: (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? "",
                  items: (try? c.decodeIfPresent([TranscriptItem].self, forKey: .items)) ?? [],
                  start: (try? c.decodeIfPresent(Int.self, forKey: .start)) ?? 0,
                  before: (try? c.decodeIfPresent(Int.self, forKey: .before)) ?? 0)
    }
}

/// §38.3: one chat whose messages contain the query — its newest matching user message or Claude answer.
public struct TranscriptSearchMatch: Sendable, Equatable, Hashable, Decodable {
    public var sessionId: String
    public var title: String
    /// Row index of the match in the chat's file (as `transcript_restore.start`).
    public var row: Int
    public var turn: Int
    public var at: String
    /// true: the user's message; false: Claude's answer.
    public var isUser: Bool
    /// The line that matched (≤ 160 chars).
    public var line: String
    // MARK: wave4c w4c-review
    /// §41.3 (`perChat` > 1): the chat's next older matches, newest first (empty from an older engine).
    public var more: [TranscriptSearchHit] = []
    /// §41.3: every matching row of the chat; nil from an older engine.
    public var total: Int?

    public init(sessionId: String, title: String = "", row: Int, turn: Int = 0, at: String = "", isUser: Bool = false, line: String) {
        self.sessionId = sessionId
        self.title = title
        self.row = row
        self.turn = turn
        self.at = at
        self.isUser = isUser
        self.line = line
    }

    private enum CodingKeys: String, CodingKey { case sessionId, title, row, turn, at, kind, line, more, total }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(sessionId: try c.decode(String.self, forKey: .sessionId),
                  title: (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "",
                  row: (try? c.decodeIfPresent(Int.self, forKey: .row)) ?? 0,
                  turn: (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? 0,
                  at: (try? c.decodeIfPresent(String.self, forKey: .at)) ?? "",
                  isUser: ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) == "user_message",
                  line: (try? c.decodeIfPresent(String.self, forKey: .line)) ?? "")
        more = ((try? c.decodeIfPresent([TranscriptSearchHit.Lenient].self, forKey: .more)) ?? nil)?.compactMap(\.value) ?? []   // wave4c w4c-review
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? nil
    }
}

/// §38.3: reply to `transcript_search` — at most one match per chat, newest chat first.
public struct TranscriptSearchReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var query: String
    public var matches: [TranscriptSearchMatch]

    public init(id: String? = nil, query: String, matches: [TranscriptSearchMatch]) {
        self.id = id
        self.query = query
        self.matches = matches
    }

    private enum CodingKeys: String, CodingKey { case id, query, matches }
    private struct Lenient: Decodable {
        let value: TranscriptSearchMatch?
        init(from decoder: Decoder) throws { value = try? TranscriptSearchMatch(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try? c.decodeIfPresent(String.self, forKey: .id),
                  query: (try? c.decodeIfPresent(String.self, forKey: .query)) ?? "",
                  matches: ((try? c.decodeIfPresent([Lenient].self, forKey: .matches)) ?? nil)?.compactMap(\.value) ?? [])
    }
}

/// §38.3 `ReviewHistoryFile.commit`: the commit a file left the review with.
public struct HistoryCommit: Codable, Sendable, Hashable {
    public var sha: String
    public var subject: String

    public init(sha: String, subject: String) {
        self.sha = sha
        self.subject = subject
    }
}

/// §38.3: where `transcript_restore.items` start in the chat's file (`start > 0`: older rows exist).
public struct TranscriptRestorePaging: Sendable, Equatable {
    public var start: Int
    public var sessionId: String

    public init(start: Int, sessionId: String) {
        self.start = start
        self.sessionId = sessionId
    }
}
