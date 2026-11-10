import Foundation

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2: the review list's wire fields — the engine's risk badges
// (`changedFiles[].risks` / `riskScore`, also on `turn_summary.files[]`), file modes and a rename's similarity, and what a
// `file_diff` without lines is (`similarity`, `oldMode` / `newMode`, `binarySize`). Every field is optional and read
// leniently: an older engine sends none of them and the client's own rules apply.

enum FileListWire {
    struct ChangedFileFields {
        var risks: [String]?
        var riskScore: Int?
        var oldMode: String?
        var newMode: String?
        var similarity: Int?
    }

    private enum Keys: String, CodingKey { case risks, riskScore, oldMode, newMode, similarity }

    static func changedFile(from decoder: Decoder) -> ChangedFileFields {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return ChangedFileFields() }
        return ChangedFileFields(
            risks: (try? c.decodeIfPresent([String].self, forKey: .risks)) ?? nil,
            riskScore: (try? c.decodeIfPresent(Int.self, forKey: .riskScore)) ?? nil,
            oldMode: (try? c.decodeIfPresent(String.self, forKey: .oldMode)) ?? nil,
            newMode: (try? c.decodeIfPresent(String.self, forKey: .newMode)) ?? nil,
            similarity: (try? c.decodeIfPresent(Int.self, forKey: .similarity)) ?? nil)
    }
}

/// A binary file's size in bytes on each side (nil: that side has no file).
public struct FileDiffBinarySize: Sendable, Equatable, Codable {
    public var old: Int64?
    public var new: Int64?

    public init(old: Int64?, new: Int64?) {
        self.old = old
        self.new = new
    }
}

/// `FileDiff`'s §40.2 fields.
public struct FileDiffMeta: Sendable, Equatable {
    /// `old mode` / `deleted file mode` when the patch names it (`100644`, `100755`, `120000`).
    public var oldMode: String?
    /// `new mode`, or `new file mode` of a new executable file.
    public var newMode: String?
    /// A rename's similarity in percent (100: moved without a content change).
    public var similarity: Int?
    public var binarySize: FileDiffBinarySize?

    public init(oldMode: String? = nil, newMode: String? = nil, similarity: Int? = nil, binarySize: FileDiffBinarySize? = nil) {
        self.oldMode = oldMode
        self.newMode = newMode
        self.similarity = similarity
        self.binarySize = binarySize
    }

    private enum Keys: String, CodingKey { case oldMode, newMode, similarity, binarySize }

    static func lenient(from decoder: Decoder) -> FileDiffMeta {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return FileDiffMeta() }
        return FileDiffMeta(
            oldMode: (try? c.decodeIfPresent(String.self, forKey: .oldMode)) ?? nil,
            newMode: (try? c.decodeIfPresent(String.self, forKey: .newMode)) ?? nil,
            similarity: (try? c.decodeIfPresent(Int.self, forKey: .similarity)) ?? nil,
            binarySize: (try? c.decodeIfPresent(FileDiffBinarySize.self, forKey: .binarySize)) ?? nil)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(oldMode, forKey: .oldMode)
        try c.encodeIfPresent(newMode, forKey: .newMode)
        try c.encodeIfPresent(similarity, forKey: .similarity)
        try c.encodeIfPresent(binarySize, forKey: .binarySize)
    }
}
