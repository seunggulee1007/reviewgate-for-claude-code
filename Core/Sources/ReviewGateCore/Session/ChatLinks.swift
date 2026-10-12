import Foundation

// Links in chat text (user report: "링크도 제대로 안 열리고"): bare http(s) URLs, the file references Claude writes —
// `src/main/java/…/Foo.java:42`, `Foo.java:42:7`, `Foo.java#L42`, often inside backticks — and markdown link destinations
// that name a file (`[Foo.java](src/Foo.java#L42)`). The scan is pure; the App resolves a reference against the project
// root (`resolve`) and links it only when the file exists there.

public enum ChatLinks {
    /// A file named in the text: the path as written (no line suffix) and the line / column after it.
    public struct FileRef: Hashable, Sendable {
        public var path: String
        public var line: Int?
        public var column: Int?

        public init(path: String, line: Int? = nil, column: Int? = nil) {
            self.path = path
            self.line = line
            self.column = column
        }
    }

    public enum Target: Hashable, Sendable {
        case web(URL)
        case file(FileRef)
    }

    public struct Match: Hashable, Sendable {
        /// UTF-16 range in the scanned text (what `NSAttributedString` ranges count).
        public var range: NSRange
        public var target: Target
    }

    /// The scheme of the in-app link to a project file (`fileURL(path:line:)`); never handed to the system.
    public static let fileScheme = "reviewgate-file"

    // MARK: Scan

    /// Every bare web URL and file reference in `text`, in order. A file reference is only a candidate: it has a file
    /// extension (or a `:line` after it), and the App links it once `resolve` finds the file.
    public static func scan(_ text: String) -> [Match] {
        let units = Array(text.utf16)
        var out: [Match] = []
        var i = 0
        while i < units.count {
            guard i == 0 || !isTokenUnit(units[i - 1]), isTokenUnit(units[i]) else {
                i += 1
                continue
            }
            if let (end, url) = webURL(units, from: i) {
                out.append(Match(range: NSRange(location: i, length: end - i), target: .web(url)))
                i = end
            } else if let (end, ref) = fileRef(units, from: i) {
                out.append(Match(range: NSRange(location: i, length: end - i), target: .file(ref)))
                i = end
            } else {
                // No token can start inside this one: skip the rest of it.
                while i < units.count, isTokenUnit(units[i]) { i += 1 }
            }
        }
        return out
    }

    /// The file a markdown link's destination names (`src/Foo.java#L42`, `./Foo.java:42`, `file:///…/Foo.java`); nil for
    /// a web link or another scheme.
    public static func fileRef(linkDestination raw: String) -> FileRef? {
        var dest = raw.removingPercentEncoding ?? raw
        if dest.lowercased().hasPrefix("file://") {
            dest = String(dest.dropFirst("file://".count))
        } else if let colon = dest.firstIndex(of: ":"), dest[dest.index(after: colon)...].hasPrefix("//") {
            return nil   // http://, https://, vscode://…
        } else if dest.lowercased().hasPrefix("mailto:") {
            return nil
        }
        var line: Int?
        var column: Int?
        if let hash = dest.lastIndex(of: "#") {
            let fragment = dest[dest.index(after: hash)...]
            if fragment.hasPrefix("L") || fragment.hasPrefix("l") {
                line = Int(fragment.dropFirst().prefix { $0.isASCII && $0.isNumber })
            }
            dest = String(dest[..<hash])
        }
        // `path:42` / `path:42:7` / `path:42-50`
        let parts = dest.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count >= 2, let n = Int(parts[1].prefix { $0.isASCII && $0.isNumber }), !parts[1].isEmpty {
            line = line ?? n
            if parts.count >= 3 { column = Int(parts[2]) }
            dest = String(parts[0])
        }
        let path = dest.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty, !path.hasSuffix("/") else { return nil }
        return FileRef(path: path, line: line, column: column)
    }

    // MARK: Resolve

    /// The repo-relative path `ref` names under `root`, when that file exists (`exists` gets absolute paths): the path as
    /// written (relative to the root, or absolute inside it), else — a bare `Foo.java` or a partial path — the one known
    /// path (`candidates`: the review's files, the files the chat touched) that ends with it. Nil outside the root, for
    /// `~/…`, a path climbing out with `..`, or when no single file matches.
    public static func resolve(_ ref: FileRef, root: String, candidates: () -> [String], exists: (String) -> Bool) -> String? {
        let base = root.hasSuffix("/") && root.count > 1 ? String(root.dropLast()) : root
        guard !base.isEmpty, !ref.path.hasPrefix("~") else { return nil }
        var path = ref.path
        if path.hasPrefix("/") {
            guard path.hasPrefix(base + "/") else { return nil }
            path = String(path.dropFirst(base.count + 1))
        }
        guard let relative = normalized(path) else { return nil }
        if exists(base + "/" + relative) { return relative }
        var found: Set<String> = []
        for candidate in candidates() where !candidate.hasPrefix("/") {
            if candidate == relative || candidate.hasSuffix("/" + relative) { found.insert(candidate) }
            if found.count > 1 { return nil }   // ambiguous: link nothing rather than the wrong file
        }
        guard let only = found.first, exists(base + "/" + only) else { return nil }
        return only
    }

    /// `a/./b/../c` → `a/c`; nil when it climbs above its start or is empty.
    static func normalized(_ path: String) -> String? {
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch part {
            case ".": continue
            case "..":
                guard !parts.isEmpty else { return nil }
                parts.removeLast()
            default: parts.append(part)
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: "/")
    }

    // MARK: In-app link

    /// The link a resolved file reference carries in the chat's text.
    public static func fileURL(path: String, line: Int?) -> URL? {
        var components = URLComponents()
        components.scheme = fileScheme
        components.path = path
        if let line { components.queryItems = [URLQueryItem(name: "line", value: String(line))] }
        return components.url
    }

    /// The path and line of an in-app file link; nil for any other URL.
    public static func fileTarget(_ url: URL) -> (path: String, line: Int?)? {
        guard url.scheme == fileScheme, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              !components.path.isEmpty else { return nil }
        let line = components.queryItems?.first { $0.name == "line" }?.value.flatMap(Int.init)
        return (components.path, line)
    }

    /// A link the markdown parser made of bare text (a GFM autolink: its text is its URL, `www.` ones get `http://`). The
    /// parser runs it on into the Korean after it (`…/pull/12에서`), so the App drops such a link and lets `scan` link the
    /// text, which ends the URL there.
    public static func isAutolink(text: String, url: URL) -> Bool {
        let target = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        func bare(_ s: String) -> Substring {
            guard let scheme = s.range(of: "://"), s[..<scheme.lowerBound].allSatisfy({ $0.isASCII && $0.isLetter }) else { return s[...] }
            return s[scheme.upperBound...]
        }
        return bare(target) == bare(text)
    }

    /// A link the system opens (the default browser, mail): http, https and mailto only.
    public static func isWeb(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https" || scheme == "mailto"
    }

    // MARK: - Scanner details

    /// Characters a URL or a path is made of (ASCII only: Korean right after `Foo.java:42에서` ends the reference).
    private static func isTokenUnit(_ u: UInt16) -> Bool {
        isAlnum(u) || u == 0x5F || u == 0x2D || u == 0x2E || u == 0x2F || u == 0x40 || u == 0x2B || u == 0x7E || u == 0x24   // _ - . / @ + ~ $
    }

    private static func isAlnum(_ u: UInt16) -> Bool { isDigit(u) || isLetter(u) }
    private static func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    private static func isLetter(_ u: UInt16) -> Bool { (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) }

    /// `http://` / `https://` at `start`, through the last URL character, without trailing punctuation or an unbalanced
    /// closing bracket (`(see https://x.y/z).`).
    private static func webURL(_ units: [UInt16], from start: Int) -> (Int, URL)? {
        let lower = { (i: Int) -> UInt16 in units[i] >= 0x41 && units[i] <= 0x5A ? units[i] | 0x20 : units[i] }
        func has(_ prefix: String, at i: Int) -> Bool {
            let p = Array(prefix.utf16)
            guard i + p.count <= units.count else { return false }
            return (0..<p.count).allSatisfy { lower(i + $0) == p[$0] }
        }
        guard has("http://", at: start) || has("https://", at: start) else { return nil }
        var end = start
        while end < units.count, isURLUnit(units[end]) { end += 1 }
        while end > start {
            let last = units[end - 1]
            if ".,:;!?'\"*".utf16.contains(last) {
                end -= 1
            } else if last == 0x29, count(0x28, units[start..<end]) < count(0x29, units[start..<end]) {   // )
                end -= 1
            } else if last == 0x5D, count(0x5B, units[start..<end]) < count(0x5D, units[start..<end]) {   // ]
                end -= 1
            } else {
                break
            }
        }
        let text = String(decoding: units[start..<end], as: UTF16.self)
        guard let schemeEnd = text.range(of: "://"), schemeEnd.upperBound < text.endIndex,
              let url = URL(string: text), let host = url.host, !host.isEmpty else { return nil }
        return (end, url)
    }

    /// Printable ASCII but space and `<>"\`{}|\^`.
    private static func isURLUnit(_ u: UInt16) -> Bool {
        guard u > 0x20, u < 0x7F else { return false }
        return !"<>\"`{}|\\^".utf16.contains(u)
    }

    private static func count(_ unit: UInt16, _ units: ArraySlice<UInt16>) -> Int { units.reduce(0) { $0 + ($1 == unit ? 1 : 0) } }

    /// A path at `start` with an extension (`Foo.java`, `.env`), or any name with a line after it (`Makefile:12`), then
    /// `:line[:column]`, `:line-line` or `#Lline`.
    private static func fileRef(_ units: [UInt16], from start: Int) -> (Int, FileRef)? {
        var end = start
        while end < units.count, isTokenUnit(units[end]) { end += 1 }
        while end > start, units[end - 1] == 0x2E || units[end - 1] == 0x2D { end -= 1 }   // a sentence's "." / a dash
        guard end > start, units[end - 1] != 0x2F else { return nil }
        let path = String(decoding: units[start..<end], as: UTF16.self)
        let name = path.split(separator: "/").last.map(String.init) ?? path
        var line: Int?
        var column: Int?
        var stop = end
        if stop + 1 < units.count, units[stop] == 0x3A, isDigit(units[stop + 1]) {   // :42
            let (n, after) = number(units, from: stop + 1)
            line = n
            stop = after
            if stop + 1 < units.count, units[stop] == 0x3A || units[stop] == 0x2D, isDigit(units[stop + 1]) {   // :7 / -50
                let (m, after2) = number(units, from: stop + 1)
                if units[stop] == 0x3A { column = m }
                stop = after2
            }
        } else if stop + 2 < units.count, units[stop] == 0x23, units[stop + 1] == 0x4C, isDigit(units[stop + 2]) {   // #L42
            let (n, after) = number(units, from: stop + 2)
            line = n
            stop = after
        }
        // A number running into letters (`Foo.java:42abc`) is not a line.
        if line != nil, stop < units.count, isLetter(units[stop]) { return nil }
        guard hasExtension(name) || (line != nil && name.utf16.contains(where: isLetter)) else { return nil }
        return (stop, FileRef(path: path, line: line, column: column))
    }

    private static func number(_ units: [UInt16], from start: Int) -> (Int?, Int) {
        var end = start
        while end < units.count, isDigit(units[end]), end - start < 7 { end += 1 }
        return (Int(String(decoding: units[start..<end], as: UTF16.self)), end)
    }

    /// `Foo.java`, `.env`: after the last dot, 1–16 letters, digits, `_ + -`, starting with a letter (not `1.5`, `v2.0`).
    private static func hasExtension(_ name: String) -> Bool {
        guard let dot = name.lastIndex(of: "."), dot < name.index(before: name.endIndex) else { return false }
        let ext = name[name.index(after: dot)...]
        guard ext.count <= 16, let first = ext.unicodeScalars.first, first.isASCII, CharacterSet.letters.contains(first) else { return false }
        return ext.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "+" || $0 == "-") }
    }
}
