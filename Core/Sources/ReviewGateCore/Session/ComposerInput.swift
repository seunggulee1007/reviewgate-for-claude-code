import Foundation
import CryptoKit

// The composer's §23 / §24 inputs: @-mentions (repo-relative paths shown as chips) and image attachments.

/// What a transcript user row went out with (§23 / §24) besides its text.
public struct UserMessageMeta: Sendable, Hashable {
    /// `user_message.turn` (the rewind target, §26); 0 when unknown.
    public var turn: Int
    public var mentions: [String]
    public var attachments: [AttachmentRef]
    // MARK: wave5 w5-model
    /// §43.4: the model the turn was given — a switch shows as a faint line under the message.
    public var autoModel: AutoModelChoice?

    public init(turn: Int = 0, mentions: [String] = [], attachments: [AttachmentRef] = []) {
        self.turn = turn
        self.mentions = mentions
        self.attachments = attachments
    }
}

/// Why an image cannot be attached — the same rules (and the same words) as the engine's `attachment_*` refusals (§24).
public enum AttachmentProblem: Sendable, Hashable, Error {
    /// `too_many_attachments`
    case tooMany
    /// `attachment_type`
    case unsupportedType
    /// `attachment_too_large`
    case tooLarge
    /// `attachment_invalid`
    case invalid

    public var code: String {
        switch self {
        case .tooMany: "too_many_attachments"
        case .unsupportedType: "attachment_type"
        case .tooLarge: "attachment_too_large"
        case .invalid: "attachment_invalid"
        }
    }

    public var message: String {
        switch self {
        case .tooMany: String(localized: "At most 5 images can be attached to one message", bundle: .module)
        case .unsupportedType: String(localized: "Only PNG, JPEG, GIF and WebP images can be attached", bundle: .module)
        case .tooLarge: String(localized: "Images can be at most 5 MB", bundle: .module)
        case .invalid: String(localized: "The image could not be read", bundle: .module)
        }
    }
}

/// An image waiting in the composer (or in the edit-and-retry editor).
public struct ComposerImage: Identifiable, Sendable, Hashable {
    public let id: UUID
    public var mediaType: ImageMediaType
    public var data: Data
    /// A file name to show in the chip's help ("clipboard.png" for a paste).
    public var name: String

    public static let maxCount = 5
    public static let maxBytes = 5 * 1024 * 1024

    public init(id: UUID = UUID(), mediaType: ImageMediaType, data: Data, name: String) {
        self.id = id
        self.mediaType = mediaType
        self.data = data
        self.name = name
    }

    /// Checks the bytes like the engine does: a known magic number, ≤ 5 MiB, and room for one more.
    public static func validated(_ data: Data, name: String, existing: Int) -> Result<ComposerImage, AttachmentProblem> {
        guard existing < maxCount else { return .failure(.tooMany) }
        guard !data.isEmpty else { return .failure(.invalid) }
        guard let type = ImageMediaType(magic: data) else { return .failure(.unsupportedType) }
        guard data.count <= maxBytes else { return .failure(.tooLarge) }
        return .success(ComposerImage(mediaType: type, data: data, name: name))
    }

    public var sendAttachment: SendAttachment { SendAttachment(mediaType: mediaType, data: data) }

    /// The `AttachmentRef.hash` the engine will store these bytes under (sha-256, lowercase hex).
    public var hash: String { Self.sha256(data) }

    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// The `@query` being typed in the composer and the path helpers for mentions (§23).
public enum ComposerMentions {
    public static let maxMentions = 20

    /// The `@token` that ends at the caret (`caret` is a UTF-16 offset): it starts with `@` at the start of the text or
    /// after whitespace and has no whitespace up to the caret. `range` covers the `@` and the query (UTF-16).
    public static func activeQuery(in text: String, caret: Int) -> (range: NSRange, query: String)? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        var i = caret
        while i > 0 {
            let ch = ns.character(at: i - 1)
            if ch == 0x40 /* @ */ {
                if i - 1 > 0, let prev = Unicode.Scalar(ns.character(at: i - 2)), !CharacterSet.whitespacesAndNewlines.contains(prev) {
                    return nil   // e.g. an e-mail address
                }
                let range = NSRange(location: i - 1, length: caret - (i - 1))
                return (range, ns.substring(with: NSRange(location: i, length: caret - i)))
            }
            if let scalar = Unicode.Scalar(ch), CharacterSet.whitespacesAndNewlines.contains(scalar) { return nil }
            i -= 1
        }
        return nil
    }

    /// `text` without the `@token` at `range`; returns the new text and the caret where the token was.
    public static func removing(_ range: NSRange, from text: String) -> (text: String, caret: Int) {
        let ns = text as NSString
        guard range.location >= 0, NSMaxRange(range) <= ns.length else { return (text, ns.length) }
        return (ns.replacingCharacters(in: range, with: ""), range.location)
    }

    /// `paths` + `new` without duplicates (directory `/` ignored), capped at `maxMentions`.
    public static func adding(_ new: [String], to paths: [String]) -> [String] {
        var out = paths
        var seen = Set(paths.map(normalized))
        for path in new where out.count < maxMentions {
            let n = normalized(path)
            guard !n.isEmpty, seen.insert(n).inserted else { continue }
            out.append(path)
        }
        return out
    }

    /// The engine's form of a mention: repo-relative, no leading `./`, no trailing `/`.
    public static func normalized(_ path: String) -> String {
        var p = path
        while p.hasPrefix("./") { p.removeFirst(2) }
        while p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// `url` as a repo-relative POSIX path when it lies inside `root` (symlinks resolved) and not inside `.git`; nil
    /// otherwise — Finder drops from outside the repository are refused with a message.
    public static func repoRelativePath(of url: URL, root: URL) -> String? {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        let target = url.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        guard target.count > base.count, Array(target.prefix(base.count)) == base else { return nil }
        let rest = Array(target.dropFirst(base.count))
        guard rest.first != ".git" else { return nil }
        return rest.joined(separator: "/")
    }

    /// The changed files of the review that can be mentioned (deleted ones are gone from disk), in review order.
    public static func changedFileMentions(_ files: [ChangedFile]) -> [String] {
        files.filter { $0.status != .deleted }.map(\.path)
    }

    /// The last path component, for a chip ("src/a.ts" → "a.ts", "docs/" → "docs").
    public static func displayName(_ path: String) -> String {
        let n = normalized(path)
        return n.split(separator: "/").last.map(String.init) ?? n
    }
}
