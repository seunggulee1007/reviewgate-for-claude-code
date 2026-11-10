import Foundation

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: what a chat row works out from its content — a tool call's tooltip (capped)
// and its mini diff, a message's markdown blocks — once per row and content instead of on every draw (a row the list
// draws again after scrolling back gets them from here). NSCache: entries go under memory pressure and are worked out
// again when needed.

final class CacheBox<Value>: NSObject {
    let value: Value
    init(_ value: Value) { self.value = value }
}

@MainActor
public enum TranscriptRowCache {
    /// A tool row's tooltip shows at most this many characters of its input.
    public static let tooltipLimit = 4_000

    private static let tooltips: NSCache<NSUUID, NSString> = cache(limit: 1_000)
    private static let previews: NSCache<NSUUID, CacheBox<ToolEditPreview?>> = cache(limit: 500)
    private static let markdown: NSCache<NSString, CacheBox<[MarkdownBlocks.Block]>> = cache(limit: 300)

    private static func cache<K: AnyObject, V: AnyObject>(limit: Int) -> NSCache<K, V> {
        let cache = NSCache<K, V>()
        cache.countLimit = limit
        return cache
    }

    /// The tool row's tooltip: its input as JSON (`JSONValue.prettyPrinted(limit:)`). A call's input never changes, so
    /// the row id is the key.
    public static func tooltip(row: UUID, input: JSONValue) -> String {
        let key = row as NSUUID
        if let text = tooltips.object(forKey: key) { return text as String }
        let text = input.prettyPrinted(limit: tooltipLimit)
        tooltips.setObject(text as NSString, forKey: key)
        return text
    }

    /// `ToolEditPreview.make(name:input:)` of the row (its line match runs once).
    public static func editPreview(row: UUID, name: String, input: JSONValue) -> ToolEditPreview? {
        let key = row as NSUUID
        if let box = previews.object(forKey: key) { return box.value }
        let preview = ToolEditPreview.make(name: name, input: input)
        previews.setObject(CacheBox(preview), forKey: key)
        return preview
    }

    /// `MarkdownBlocks.parse(text)`, kept per text.
    public static func markdownBlocks(_ text: String) -> [MarkdownBlocks.Block] {
        let key = text as NSString
        if let box = markdown.object(forKey: key) { return box.value }
        let blocks = MarkdownBlocks.parse(text)
        markdown.setObject(CacheBox(blocks), forKey: key)
        return blocks
    }
}

public extension JSONValue {
    /// MARK: wave7 w7-chat — §45.1: `prettyPrinted`, at most `limit` characters ("…" marks the cut). An input whose text is
    /// shorter reads exactly as before; a longer one has each long string cut to a quarter of the limit before it is
    /// encoded (a 1 MB Write is not encoded to show its start, and its path still shows).
    func prettyPrinted(limit: Int) -> String {
        var budget = limit
        let text = fits(&budget) ? prettyPrinted : cut(max(200, limit / 4)).prettyPrinted
        return text.count > limit ? String(text.prefix(limit)) + "…" : text
    }

    /// Whether the strings and keys stay within `budget` UTF-16 units (stops counting once they do not).
    private func fits(_ budget: inout Int) -> Bool {
        switch self {
        case let .string(s): budget -= s.utf16.count
        case let .array(items): for item in items where budget >= 0 { _ = item.fits(&budget) }
        case let .object(fields):
            for (key, value) in fields where budget >= 0 {
                budget -= key.utf16.count
                _ = value.fits(&budget)
            }
        case .number, .bool, .null: budget -= 8
        }
        return budget >= 0
    }

    private func cut(_ limit: Int) -> JSONValue {
        switch self {
        case let .string(s) where s.utf16.count > limit: .string(String(s.prefix(limit)) + "…")
        case let .array(items) where !items.isEmpty: .array(items.prefix(limit).map { $0.cut(limit) })
        case let .object(fields) where !fields.isEmpty: .object(fields.mapValues { $0.cut(limit) })
        default: self
        }
    }
}
