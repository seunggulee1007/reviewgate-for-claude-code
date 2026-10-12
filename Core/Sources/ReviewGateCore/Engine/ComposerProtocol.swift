import Foundation

// docs/PROTOCOL.md §23–28: file mentions, image attachments, model / effort, turn checkpoints + rewind, compact and
// context_warning. Every field decodes leniently — older engines omit them, newer ones may add values.

/// One `list_files` match (§23): repo-relative POSIX path; `changed` = in the current review.
public struct FileItem: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable { case file, dir }
    public var path: String
    public var kind: Kind
    public var changed: Bool

    public var id: String { path }
    public var isDirectory: Bool { kind == .dir }

    public init(path: String, kind: Kind = .file, changed: Bool = false) {
        self.path = path
        self.kind = kind
        self.changed = changed
    }

    private enum CodingKeys: String, CodingKey { case path, kind, changed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .file
        changed = (try? c.decodeIfPresent(Bool.self, forKey: .changed)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encode(kind, forKey: .kind)
        if changed { try c.encode(true, forKey: .changed) }
    }
}

/// The image types `send.attachments` accepts (§24).
public enum ImageMediaType: String, Codable, Sendable, CaseIterable {
    case png = "image/png"
    case jpeg = "image/jpeg"
    case gif = "image/gif"
    case webp = "image/webp"

    public var fileExtension: String {
        switch self {
        case .png: "png"
        case .jpeg: "jpg"
        case .gif: "gif"
        case .webp: "webp"
        }
    }

    /// The type a file extension names (`jpeg` / `jpg` both JPEG); nil for anything else.
    public init?(fileExtension ext: String) {
        switch ext.lowercased() {
        case "png": self = .png
        case "jpg", "jpeg": self = .jpeg
        case "gif": self = .gif
        case "webp": self = .webp
        default: return nil
        }
    }

    /// The type the bytes' magic number says (what the engine checks against the declared type).
    public init?(magic data: Data) {
        let b = [UInt8](data.prefix(12))
        if b.count >= 8, b[0..<8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] { self = .png; return }
        if b.count >= 3, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { self = .jpeg; return }
        if b.count >= 6, b[0..<4] == [0x47, 0x49, 0x46, 0x38], b[4] == 0x37 || b[4] == 0x39, b[5] == 0x61 { self = .gif; return }
        if b.count >= 12, b[0..<4] == [0x52, 0x49, 0x46, 0x46], b[8..<12] == [0x57, 0x45, 0x42, 0x50] { self = .webp; return }
        return nil
    }
}

/// An image sent with `send` / `rewind` (§24): plain base64, no `data:` prefix.
public struct SendAttachment: Encodable, Sendable, Hashable {
    public var mediaType: ImageMediaType
    public var dataBase64: String

    public init(mediaType: ImageMediaType, dataBase64: String) {
        self.mediaType = mediaType
        self.dataBase64 = dataBase64
    }

    public init(mediaType: ImageMediaType, data: Data) {
        self.init(mediaType: mediaType, dataBase64: data.base64EncodedString())
    }

    private enum CodingKeys: String, CodingKey { case kind, mediaType, dataBase64 }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("image", forKey: .kind)
        try c.encode(mediaType, forKey: .mediaType)
        try c.encode(dataBase64, forKey: .dataBase64)
    }
}

/// What a `user_message` / transcript row keeps of an image: its sha-256 (`attachment_get` fetches the bytes).
public struct AttachmentRef: Codable, Sendable, Hashable, Identifiable {
    public var hash: String
    /// The wire's media type; an unknown one stays as text (the thumbnail decodes whatever comes back).
    public var mediaType: String
    public var bytes: Int

    public var id: String { hash }

    public init(hash: String, mediaType: String, bytes: Int) {
        self.hash = hash
        self.mediaType = mediaType
        self.bytes = bytes
    }

    private enum CodingKeys: String, CodingKey { case kind, hash, mediaType, bytes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decode(String.self, forKey: .hash)
        mediaType = (try? c.decodeIfPresent(String.self, forKey: .mediaType)) ?? "image/png"
        bytes = (try? c.decodeIfPresent(Int.self, forKey: .bytes)) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("image", forKey: .kind)
        try c.encode(hash, forKey: .hash)
        try c.encode(mediaType, forKey: .mediaType)
        try c.encode(bytes, forKey: .bytes)
    }
}

/// §25 effort levels.
public enum EffortLevel: String, Codable, Sendable, CaseIterable, Identifiable {
    case low, medium, high, xhigh, max

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .low: String(localized: "Low", bundle: .module)
        case .medium: String(localized: "Medium", bundle: .module)
        case .high: String(localized: "High", bundle: .module)
        case .xhigh: String(localized: "Extra high", bundle: .module)
        case .max: String(localized: "Max", bundle: .module)
        }
    }
}

/// `set_model.effort`: absent = unchanged, `null` = the model's default, else a level.
public enum EffortUpdate: Sendable, Hashable {
    case unchanged
    case modelDefault
    case level(EffortLevel)
}

/// One entry of `state.session.availableModels` (§25); `value` goes back as `set_model.model`.
public struct ModelOption: Codable, Sendable, Hashable, Identifiable {
    public var value: String
    public var displayName: String
    public var description: String
    public var resolvedModel: String?
    public var supportsEffort: Bool
    public var supportedEffortLevels: [EffortLevel]

    public var id: String { value }

    public init(value: String, displayName: String, description: String = "", resolvedModel: String? = nil,
                supportsEffort: Bool = false, supportedEffortLevels: [EffortLevel] = []) {
        self.value = value
        self.displayName = displayName
        self.description = description
        self.resolvedModel = resolvedModel
        self.supportsEffort = supportsEffort
        self.supportedEffortLevels = supportedEffortLevels
    }

    private enum CodingKeys: String, CodingKey { case value, displayName, description, resolvedModel, supportsEffort, supportedEffortLevels }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decode(String.self, forKey: .value)
        displayName = (try? c.decodeIfPresent(String.self, forKey: .displayName)) ?? value
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        resolvedModel = try? c.decodeIfPresent(String.self, forKey: .resolvedModel)
        supportsEffort = (try? c.decodeIfPresent(Bool.self, forKey: .supportsEffort)) ?? false
        // An unknown level (a newer CLI) is dropped rather than hiding the whole option.
        let raw = (try? c.decodeIfPresent([String].self, forKey: .supportedEffortLevels)) ?? []
        supportedEffortLevels = raw.compactMap(EffortLevel.init(rawValue:))
    }

    /// The levels the picker offers: the model's own list, else every level when it supports effort.
    public var effortLevels: [EffortLevel] {
        guard supportsEffort else { return [] }
        return supportedEffortLevels.isEmpty ? EffortLevel.allCases : supportedEffortLevels
    }
}

/// `rewind.mode` (§26).
public enum RewindMode: String, Codable, Sendable, CaseIterable, Identifiable {
    case conversation, files, both
    public var id: String { rawValue }
}

/// One user turn of the current chat that can be rewound to (`state.session.checkpoints`, §26).
public struct TurnCheckpoint: Codable, Sendable, Hashable, Identifiable {
    public var turn: Int
    public var prompt: String
    public var startedAt: String
    public var endedAt: String?
    public var filesChanged: Int
    public var filesSince: Int
    public var canRewindFiles: Bool
    public var canRewindConversation: Bool

    public var id: Int { turn }

    public init(turn: Int, prompt: String = "", startedAt: String = "", endedAt: String? = nil, filesChanged: Int = 0,
                filesSince: Int = 0, canRewindFiles: Bool = false, canRewindConversation: Bool = false) {
        self.turn = turn
        self.prompt = prompt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.filesChanged = filesChanged
        self.filesSince = filesSince
        self.canRewindFiles = canRewindFiles
        self.canRewindConversation = canRewindConversation
    }

    private enum CodingKeys: String, CodingKey {
        case turn, prompt, startedAt, endedAt, filesChanged, filesSince, canRewindFiles, canRewindConversation
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turn = try c.decode(Int.self, forKey: .turn)
        prompt = (try? c.decodeIfPresent(String.self, forKey: .prompt)) ?? ""
        startedAt = (try? c.decodeIfPresent(String.self, forKey: .startedAt)) ?? ""
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        filesChanged = (try? c.decodeIfPresent(Int.self, forKey: .filesChanged)) ?? 0
        filesSince = (try? c.decodeIfPresent(Int.self, forKey: .filesSince)) ?? 0
        canRewindFiles = (try? c.decodeIfPresent(Bool.self, forKey: .canRewindFiles)) ?? false
        canRewindConversation = (try? c.decodeIfPresent(Bool.self, forKey: .canRewindConversation)) ?? false
    }

    /// Whether `mode` is possible for this turn.
    public func allows(_ mode: RewindMode) -> Bool {
        switch mode {
        case .conversation: canRewindConversation
        case .files: canRewindFiles
        case .both: canRewindConversation && canRewindFiles
        }
    }
}

/// `context_warning` (§27): the context use crossed 80 % at a turn end.
public struct ContextWarning: Sendable, Hashable {
    public var percent: Double
    public var contextTokens: Int
    public var contextWindow: Int

    public init(percent: Double, contextTokens: Int, contextWindow: Int) {
        self.percent = percent
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
    }
}
