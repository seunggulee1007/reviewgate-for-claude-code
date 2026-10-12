import AppKit
import Foundation
import Highlightr
import SwiftUI

/// Highlight.js-based syntax colouring for diff rows and the full-file view (docs/M8-API.md).
/// All Highlightr / JavaScriptCore state lives inside the actor; callers only ever receive `AttributedString`s
/// carrying SwiftUI `foregroundColor` / `font` attributes (light theme "intellij-light", dark theme "darcula" — IntelliJ's colours,
/// monospaced system font 12).
public actor SyntaxHighlighter {
    public static let shared = SyntaxHighlighter()

    public static let fontSize: CGFloat = 12
    public static let lightTheme = "intellij-light"
    public static let darkTheme = "darcula"
    /// `highlightDocument` gives up on documents longer than this and returns plain lines.
    public static let maxDocumentLines = 20_000

    private static let languageByExtension: [String: String] = [
        "swift": "swift",
        "ts": "typescript", "tsx": "typescript", "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
        "java": "java", "kt": "kotlin", "kts": "kotlin",
        "py": "python", "go": "go", "rs": "rust", "rb": "ruby", "php": "php",
        "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp",
        "m": "objectivec", "mm": "objectivec", "cs": "csharp",
        "sh": "bash", "zsh": "bash", "bash": "bash",
        "json": "json", "yaml": "yaml", "yml": "yaml", "xml": "xml", "plist": "xml",
        "html": "xml", "htm": "xml", "css": "css", "scss": "scss",
        "md": "markdown", "markdown": "markdown", "sql": "sql", "toml": "toml",
        "gradle": "gradle", "dockerfile": "dockerfile", "mk": "makefile", "properties": "properties",
        "vue": "xml", "dart": "dart",
    ]
    private static let languageByFileName: [String: String] = [
        "dockerfile": "dockerfile", "makefile": "makefile", "gnumakefile": "makefile",
    ]

    private final class Box { let value: AttributedString; init(_ v: AttributedString) { value = v } }

    private var light: Highlightr?
    private var dark: Highlightr?
    private let cache = NSCache<NSString, Box>()
    // MARK: wave7 w7-state — §45.2: the line cache is bounded by bytes, not only by count
    /// The cache's byte budget (`entryCost` per line); NSCache evicts beyond it.
    public static let cacheCostLimit = 24 * 1024 * 1024

    /// The app uses `shared`; a test makes its own so nothing else queues on it while it measures.
    init() {
        cache.countLimit = 50_000
        cache.totalCostLimit = Self.cacheCostLimit
    }

    /// About what one cached line holds: the key (UTF-16), the text and its runs' attribute containers.
    static func entryCost(line: String, runs: Int) -> Int {
        64 + line.utf16.count * 2 + line.utf8.count + runs * 96
    }

    /// Drops every cached line (a project closed, a review round ended): the next diff colours its lines anew.
    public func clear() {
        cache.removeAllObjects()
    }

    /// Test seams: the byte budget, and whether a line is cached.
    var costLimit: Int { cache.totalCostLimit }

    func isCached(_ line: String, language: String, dark: Bool) -> Bool {
        cache.object(forKey: "\(language)|\(dark ? 1 : 0)|\(line)" as NSString) != nil
    }

    // MARK: - Language

    /// Highlight.js language name for a path, by extension (or `Dockerfile` / `Makefile` by name); nil => plain.
    public func language(forPath path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        if let byName = Self.languageByFileName[name.lowercased()] { return byName }
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? nil : Self.languageByExtension[ext]
    }

    // MARK: - Highlighting

    /// Per-line highlighting (each line on its own, so multi-line tokens are not carried over). Results are
    /// cached by (language, theme, line); unknown language or a highlighter failure yields plain text.
    public func highlightLines(_ lines: [String], language: String?, dark: Bool) async -> [AttributedString] {
        highlightLinesNow(lines, language: language, dark: dark)
    }

    /// wave2 mac-diff: `highlightLines` with the CPU time this thread spent on it — not the wall clock, so a loaded machine
    /// or another caller queued on the actor does not count (SyntaxHighlighterTests' regression bound).
    func cpuTimedHighlightLines(_ lines: [String], language: String?, dark: Bool) -> (lines: [AttributedString], cpuSeconds: Double) {
        _ = highlighter(dark: dark)   // the one-time Highlightr / theme setup is not per-line cost
        let start = Self.threadCPUSeconds()
        let out = highlightLinesNow(lines, language: language, dark: dark)
        return (out, Self.threadCPUSeconds() - start)
    }

    /// CPU time of the calling thread.
    static func threadCPUSeconds() -> Double {
        var ts = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts)
        return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9
    }

    /// The body of `highlightLines`, synchronous: one actor job from the first line to the last.
    private func highlightLinesNow(_ lines: [String], language: String?, dark: Bool) -> [AttributedString] {
        guard let language, let hl = highlighter(dark: dark) else {
            return lines.map { Self.plain($0) }
        }
        var out: [AttributedString] = []
        out.reserveCapacity(lines.count)
        for (i, line) in lines.enumerated() {
            if i % 64 == 0, Task.isCancelled {
                out.append(contentsOf: lines[i...].map { Self.plain($0) })
                break
            }
            if line.isEmpty { out.append(Self.plain(line)); continue }
            let key = "\(language)|\(dark ? 1 : 0)|\(line)" as NSString
            if let hit = cache.object(forKey: key) { out.append(hit.value); continue }
            // wave2 mac-diff: each line's JavaScriptCore / AppKit temporaries go when the line is done, not at the end of a
            // 3 000-line job.
            let value = autoreleasepool { hl.highlight(line, as: language).map(Self.convert) ?? Self.plain(line) }
            cache.setObject(Box(value), forKey: key, cost: Self.entryCost(line: line, runs: value.runs.count))   // wave7: by bytes
            out.append(value)
        }
        return out
    }

    /// Whole-document highlighting split into lines, so tokens spanning lines (block comments, multi-line
    /// strings) keep their colour. Falls back to plain lines for unknown languages, huge documents, or when
    /// the highlighter's output does not line up with the input.
    public func highlightDocument(_ text: String, language: String?, dark: Bool) async -> [AttributedString] {
        let lines = Self.splitLines(text)
        guard let language, lines.count <= Self.maxDocumentLines, let hl = highlighter(dark: dark),
              let ns = hl.highlight(text, as: language) else {
            return lines.map { Self.plain($0) }
        }
        let str = ns.string as NSString
        var result: [AttributedString] = []
        result.reserveCapacity(lines.count)
        var start = 0
        let length = str.length
        while start <= length {
            let nl = str.range(of: "\n", options: [], range: NSRange(location: start, length: length - start))
            let end = nl.location == NSNotFound ? length : nl.location
            if end == length, start == length, !result.isEmpty { break }   // trailing newline: no extra empty line
            result.append(Self.convert(ns.attributedSubstring(from: NSRange(location: start, length: end - start))))
            if nl.location == NSNotFound { break }
            start = nl.location + nl.length
        }
        guard result.count == lines.count else {
            return lines.map { Self.plain($0) }
        }
        return result
    }

    // MARK: - Internals

    private func highlighter(dark: Bool) -> Highlightr? {
        if dark, let dark = self.dark { return dark }
        if !dark, let light = self.light { return light }
        guard let hl = Highlightr() else { return nil }
        hl.ignoreIllegals = true
        guard hl.setTheme(to: dark ? Self.darkTheme : Self.lightTheme) else { return nil }
        hl.theme.setCodeFont(NSFont.monospacedSystemFont(ofSize: Self.fontSize, weight: .regular))
        if dark { self.dark = hl } else { self.light = hl }
        return hl
    }

    private static let plainFont = Font.system(size: fontSize, design: .monospaced)

    static func plain(_ line: String) -> AttributedString {
        var s = AttributedString(line)
        s.swiftUI.font = plainFont
        return s
    }

    /// Rebuilds the AppKit-attributed result with SwiftUI `foregroundColor` / `font` attributes only, so
    /// `Text(AttributedString)` renders it and nothing non-Sendable is carried along.
    static func convert(_ ns: NSAttributedString) -> AttributedString {
        var attr = AttributedString()
        let text = ns.string as NSString
        ns.enumerateAttributes(in: NSRange(location: 0, length: ns.length)) { attrs, range, _ in
            var piece = AttributedString(text.substring(with: range))
            if let color = attrs[.foregroundColor] as? NSColor { piece.swiftUI.foregroundColor = Color(nsColor: color) }
            if let font = attrs[.font] as? NSFont { piece.swiftUI.font = Font(font) } else { piece.swiftUI.font = plainFont }
            attr.append(piece)
        }
        return attr
    }

    static func splitLines(_ text: String) -> [String] {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        return lines
    }
}
