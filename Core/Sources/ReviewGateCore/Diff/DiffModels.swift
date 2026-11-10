import Foundation

public enum DiffLineKind: String, Codable, Sendable { case context, add, del, hunkHeader }

public struct DiffLine: Codable, Identifiable, Sendable, Hashable {
    public let id: Int              // index within FileDiff.allLines
    public let kind: DiffLineKind
    public let oldNo: Int?          // nil for add / hunkHeader
    public let newNo: Int?          // nil for del / hunkHeader
    public let text: String         // without leading +/-/space
    // MARK: wave2 contract — docs/PROTOCOL.md §34.7
    /// The changed parts of `text` (add / del lines paired with a line of the other side); empty = the whole line.
    /// `DiffSegment.range(in: text)` turns one into a `String` range (UTF-16 offsets, as the engine computes them).
    public var segments: [DiffSegment] = []
    /// This line and its pair differ only in whitespace ("공백만 바뀐 줄 숨기기").
    public var wsOnly = false

    public init(id: Int, kind: DiffLineKind, oldNo: Int?, newNo: Int?, text: String, segments: [DiffSegment] = [], wsOnly: Bool = false) {
        self.id = id
        self.kind = kind
        self.oldNo = oldNo
        self.newNo = newNo
        self.text = text
        self.segments = segments
        self.wsOnly = wsOnly
    }

    private enum CodingKeys: String, CodingKey { case id, kind, oldNo, newNo, text, segments, wsOnly }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(Int.self, forKey: .id),
                  kind: try c.decode(DiffLineKind.self, forKey: .kind),
                  oldNo: try c.decodeIfPresent(Int.self, forKey: .oldNo),
                  newNo: try c.decodeIfPresent(Int.self, forKey: .newNo),
                  text: try c.decode(String.self, forKey: .text),
                  // A malformed list (not pairs of ints) reads as "the whole line changed".
                  segments: DiffSegment.list((try? c.decodeIfPresent([[Int]].self, forKey: .segments)) ?? nil),
                  wsOnly: ((try? c.decodeIfPresent(Bool.self, forKey: .wsOnly)) ?? nil) ?? false)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(oldNo, forKey: .oldNo)
        try c.encodeIfPresent(newNo, forKey: .newNo)
        try c.encode(text, forKey: .text)
        if !segments.isEmpty { try c.encode(segments.map { [$0.start, $0.end] }, forKey: .segments) }
        if wsOnly { try c.encode(true, forKey: .wsOnly) }
    }
}

public struct DiffHunk: Codable, Identifiable, Sendable, Equatable {
    public let id: Int
    public let header: String
    public let lines: [DiffLine]

    public init(id: Int, header: String, lines: [DiffLine]) {
        self.id = id
        self.header = header
        self.lines = lines
    }
}

public struct FileDiff: Codable, Sendable, Equatable {
    public let oldPath: String?
    public let newPath: String?
    public let isBinary: Bool
    public let hunks: [DiffHunk]
    public var allLines: [DiffLine] { hunks.flatMap(\.lines) }   // hunkHeader lines included
    /// §34.7 (wave2 contract): `segments` cover only part of the diff (a size limit was hit).
    public var segmentsLimited = false
    // MARK: wave4b w4b-files — §40.2 (nil on older engines): what a diff without lines is (`FileMetaText`).
    public var meta = FileDiffMeta()

    private enum CodingKeys: String, CodingKey { case oldPath, newPath, isBinary, hunks, segmentsLimited }

    public init(oldPath: String?, newPath: String?, isBinary: Bool, hunks: [DiffHunk], segmentsLimited: Bool = false) {
        self.oldPath = oldPath
        self.newPath = newPath
        self.isBinary = isBinary
        self.hunks = hunks
        self.segmentsLimited = segmentsLimited
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(oldPath: try c.decodeIfPresent(String.self, forKey: .oldPath),
                  newPath: try c.decodeIfPresent(String.self, forKey: .newPath),
                  isBinary: try c.decodeIfPresent(Bool.self, forKey: .isBinary) ?? false,
                  hunks: try c.decodeIfPresent([DiffHunk].self, forKey: .hunks) ?? [],
                  segmentsLimited: ((try? c.decodeIfPresent(Bool.self, forKey: .segmentsLimited)) ?? nil) ?? false)
        meta = FileDiffMeta.lenient(from: decoder)   // MARK: wave4b w4b-files
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(oldPath, forKey: .oldPath)
        try c.encodeIfPresent(newPath, forKey: .newPath)
        try c.encode(isBinary, forKey: .isBinary)
        try c.encode(hunks, forKey: .hunks)
        if segmentsLimited { try c.encode(true, forKey: .segmentsLimited) }
        try meta.encode(to: encoder)   // MARK: wave4b w4b-files
    }
}
