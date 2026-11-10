import Foundation

// MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers": the wire types (engine `protocol.ts`
// `FileLinesEvent`, `FileImageEvent`, `TranscriptSearchHit`). Every field is read leniently: a missing or odd one falls back.

/// §41.3: reply to `history_file_lines` / `pr_file_lines` — the diff's new side for "Show 20 more lines" (empty when
/// `isBinary` / `isTooLarge`).
public struct FileLinesReply: Sendable, Equatable, Decodable {
    public var id: String?
    /// `history` or `pr`.
    public var scope: String
    public var path: String
    public var entryId: String?
    /// The PR's head commit.
    public var sha: String?
    public var lines: [String]
    public var isBinary: Bool
    public var isTooLarge: Bool

    public init(id: String? = nil, scope: String, path: String, entryId: String? = nil, sha: String? = nil, lines: [String],
                isBinary: Bool = false, isTooLarge: Bool = false) {
        self.id = id
        self.scope = scope
        self.path = path
        self.entryId = entryId
        self.sha = sha
        self.lines = lines
        self.isBinary = isBinary
        self.isTooLarge = isTooLarge
    }

    private enum CodingKeys: String, CodingKey { case id, scope, path, entryId, sha, lines, isBinary, isTooLarge }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  scope: lenientValue(String.self, c, .scope) ?? "",
                  path: lenientValue(String.self, c, .path) ?? "",
                  entryId: lenientValue(String.self, c, .entryId),
                  sha: lenientValue(String.self, c, .sha),
                  lines: lenientValue([String].self, c, .lines) ?? [],
                  isBinary: lenientValue(Bool.self, c, .isBinary) ?? false,
                  isTooLarge: lenientValue(Bool.self, c, .isTooLarge) ?? false)
    }
}

/// §41.3: one side of an image (`file_image`); `data` nil when it is over 2 MB (`tooLarge`).
public struct FileImageSide: Sendable, Equatable {
    public var size: Int
    public var data: Data?
    public var tooLarge: Bool

    public init(size: Int, data: Data?, tooLarge: Bool = false) {
        self.size = size
        self.data = data
        self.tooLarge = tooLarge
    }
}

/// §41.3: reply to `file_image` — before (A) and after (the review's B); `old` nil for an added image, `new` for a deleted one.
public struct FileImageReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String
    public var oldPath: String?
    public var mediaType: String
    public var old: FileImageSide?
    public var new: FileImageSide?
    public var endTree: String?

    public init(id: String? = nil, path: String, oldPath: String? = nil, mediaType: String, old: FileImageSide?, new: FileImageSide?, endTree: String? = nil) {
        self.id = id
        self.path = path
        self.oldPath = oldPath
        self.mediaType = mediaType
        self.old = old
        self.new = new
        self.endTree = endTree
    }

    private enum CodingKeys: String, CodingKey { case id, path, oldPath, mediaType, old, new, endTree }
    private enum SideKeys: String, CodingKey { case size, dataBase64, tooLarge }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func side(_ key: CodingKeys) -> FileImageSide? {
            guard let s = try? c.nestedContainer(keyedBy: SideKeys.self, forKey: key) else { return nil }
            let base64 = lenientValue(String.self, s, .dataBase64)
            let data = base64.flatMap { Data(base64Encoded: $0, options: .ignoreUnknownCharacters) }
            return FileImageSide(size: lenientValue(Int.self, s, .size) ?? data?.count ?? 0, data: data,
                                 tooLarge: lenientValue(Bool.self, s, .tooLarge) ?? false)
        }
        self.init(id: lenientValue(String.self, c, .id),
                  path: lenientValue(String.self, c, .path) ?? "",
                  oldPath: lenientValue(String.self, c, .oldPath),
                  mediaType: lenientValue(String.self, c, .mediaType) ?? "image/png",
                  old: side(.old),
                  new: side(.new),
                  endTree: lenientValue(String.self, c, .endTree))
    }
}

/// §41.3: one more matching row of a chat (`TranscriptSearchMatch.more`).
public struct TranscriptSearchHit: Sendable, Equatable, Hashable, Decodable {
    public var row: Int
    public var turn: Int
    public var at: String
    public var isUser: Bool
    public var line: String

    public init(row: Int, turn: Int = 0, at: String = "", isUser: Bool = false, line: String) {
        self.row = row
        self.turn = turn
        self.at = at
        self.isUser = isUser
        self.line = line
    }

    private enum CodingKeys: String, CodingKey { case row, turn, at, kind, line }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(row: try c.decode(Int.self, forKey: .row),
                  turn: lenientValue(Int.self, c, .turn) ?? 0,
                  at: lenientValue(String.self, c, .at) ?? "",
                  isUser: lenientValue(String.self, c, .kind) == "user_message",
                  line: lenientValue(String.self, c, .line) ?? "")
    }

    /// An element that does not decode is dropped (the list stays).
    struct Lenient: Decodable {
        let value: TranscriptSearchHit?
        init(from decoder: Decoder) throws { value = try? TranscriptSearchHit(from: decoder) }
    }
}
