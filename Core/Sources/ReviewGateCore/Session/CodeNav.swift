import Foundation
import Observation

// MARK: code-nav — docs/PROTOCOL.md §62 (Mac): ⌘-click / Go to Definition and Find References on a name in any diff or
// project file, the place opened in the review's diff or the code browser (§47), and Back / Forward over the jumps.
// Pure parts here (the name under the pointer, the history, the IDE links, what a reply leads to); the window opens what
// `CodeNavStore.openRequest` names.

/// The name a click lands on: what `find_definition` / `find_references` get, and the part of the line to underline.
public struct CodeNavSymbol: Sendable, Equatable {
    public var symbol: String
    /// UTF-16 offsets into the line.
    public var range: Range<Int>
    /// §65.6: the identifier the name is a member of on that line — `user` of `user.save()`, `this` of `this.total`,
    /// `Repo` of `Repo::find` (`x.`, `x?.`, `x!!.`, `x::`, `x->`); nil when unqualified or after `)` / `]`.
    public var receiver: String?

    public init(symbol: String, range: Range<Int>, receiver: String? = nil) {
        self.symbol = symbol
        self.range = range
        self.receiver = receiver
    }

    /// §65.6: the 1-based UTF-16 column `find_definition` takes (the name's first character).
    public var column: Int { range.lowerBound + 1 }
}

/// Where the user is or was: which view, the file (repo-relative) and the line (1-based).
public struct CodeNavLocation: Sendable, Equatable, Hashable {
    public enum View: String, Sendable, Hashable {
        /// The review's diff of a changed file (its full file too).
        case review
        /// The code browser's read-only file (§47).
        case projectFile
        /// A past round's, a PR's or the live diff: going back there closes the project file in front of it.
        case other
    }

    public var view: View
    public var path: String
    public var line: Int?
    /// 1-based UTF-16 column of the line (the symbol's first character).
    public var column: Int?

    public init(view: View, path: String, line: Int? = nil, column: Int? = nil) {
        self.view = view
        self.path = path
        self.line = line
        self.column = column
    }
}

/// Back / Forward over the jumps (client-side, §62 "History"). A jump pushes where the user was; Back pops it and keeps
/// where the user is for Forward.
public struct CodeNavHistory: Sendable, Equatable {
    public static let limit = 50
    public private(set) var back: [CodeNavLocation] = []
    public private(set) var forward: [CodeNavLocation] = []

    public init() {}

    public var canGoBack: Bool { !back.isEmpty }
    public var canGoForward: Bool { !forward.isEmpty }

    /// A jump away from `from`: Forward is forgotten; the same place twice in a row is kept once.
    public mutating func push(_ from: CodeNavLocation) {
        if back.last != from { back.append(from) }
        if back.count > Self.limit { back.removeFirst(back.count - Self.limit) }
        forward = []
    }

    /// The place to go back to; `current` (where the user is) becomes Forward's.
    public mutating func goBack(from current: CodeNavLocation?) -> CodeNavLocation? {
        guard let target = back.popLast() else { return nil }
        if let current, forward.last != current { forward.append(current) }
        return target
    }

    /// The place to go forward to; `current` goes back on Back's.
    public mutating func goForward(from current: CodeNavLocation?) -> CodeNavLocation? {
        guard let target = forward.popLast() else { return nil }
        if let current, back.last != current { back.append(current) }
        return target
    }

    public mutating func clear() {
        back = []
        forward = []
    }
}

/// What a `definitions` reply leads to.
public enum CodeNavOutcome: Sendable, Equatable {
    /// One candidate: open it.
    case open(DefinitionCandidate)
    /// Several: the peek list, best first.
    case peek([DefinitionCandidate])
    /// None: the "not found" note.
    case notFound
}

/// A Find References request of the window (the References tab's history runs one again).
public struct ReferenceSearch: Sendable, Equatable, Identifiable {
    public var symbol: String
    public var from: CodeNavLocation?
    public var id: String { "\(symbol)@\(from?.path ?? ""):\(from?.line ?? 0)" }

    public init(symbol: String, from: CodeNavLocation?) {
        self.symbol = symbol
        self.from = from
    }
}

/// References of one file, in the order received.
public struct ReferenceGroup: Sendable, Equatable, Identifiable {
    public var path: String
    public var hits: [ReferenceHit]
    public var id: String { path }

    public init(path: String, hits: [ReferenceHit]) {
        self.path = path
        self.hits = hits
    }
}

public enum CodeNavText {
    /// Longest symbol the engine takes (§62).
    public static let symbolLimit = 200

    /// What `find_definition` / `find_references` lead to.
    public static func outcome(_ reply: DefinitionsReply) -> CodeNavOutcome {
        switch reply.candidates.count {
        case 0: .notFound
        case 1: .open(reply.candidates[0])
        default: .peek(reply.candidates)
        }
    }

    /// §65.8 F4 / ⇧F4: the hit after (or before) `current` among `count`, round the ends; the first (or last) when none
    /// is picked yet; nil when there are none.
    public static func step(from current: Int?, by delta: Int, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let current, (0..<count).contains(current) else { return delta >= 0 ? 0 : count - 1 }
        return ((current + delta) % count + count) % count
    }

    /// The hits grouped by file, in the order received.
    public static func groups(_ hits: [ReferenceHit]) -> [ReferenceGroup] {
        var out: [ReferenceGroup] = []
        var index: [String: Int] = [:]
        for hit in hits {
            if let i = index[hit.path] {
                out[i].hits.append(hit)
            } else {
                index[hit.path] = out.count
                out.append(ReferenceGroup(path: hit.path, hits: [hit]))
            }
        }
        return out
    }

    /// One line under a peek list: what was left out (§62: "showing the best 50", "search stopped after 10 s").
    public static func limits(_ reply: DefinitionsReply) -> [String] {
        var out: [String] = []
        if reply.truncated { out.append(String(localized: "Showing the best \(reply.candidates.count)", bundle: .module)) }
        if reply.timedOut { out.append(String(localized: "Search stopped after 10 s", bundle: .module)) }
        return out
    }

    /// "12 references in 3 files", with what was left out.
    public static func summary(_ reply: ReferencesReply) -> String {
        if reply.hits.isEmpty { return String(localized: "No references", bundle: .module) }
        var text = String(localized: "\(reply.hits.count) references in \(reply.files) files", bundle: .module)
        if reply.truncated { text += " · " + String(localized: "only the first \(reply.hits.count)", bundle: .module) }
        if reply.timedOut { text += " · " + String(localized: "stopped after 15 s", bundle: .module) }
        return text
    }

    /// A refusal of `find_definition` / `find_references` in the user's words.
    public static func refusal(code: String?, fallback: String) -> String {
        switch code {
        case "bad_symbol": String(localized: "This is not a name that can be looked up", bundle: .module)
        default: CodeBrowserText.refusal(code: code, fallback: fallback)
        }
    }

    static func message(_ error: Error) -> String {
        let client = error as? EngineClientError
        return refusal(code: client?.refusalCode, fallback: client?.userMessage ?? error.localizedDescription)
    }

    // MARK: The name under the pointer

    /// Files whose tags are names: `<my-widget>`, `<c:out>`, `<MyWidget>`.
    private static let markupExtensions: Set<String> = ["vue", "jsp", "jspf", "jspx", "tag", "tagx", "html", "htm"]
    /// A quoted string ending in one of these is a path (§62: an include / import target).
    private static let pathExtensions: Set<String> = [
        "jsp", "jspf", "jspx", "tag", "tagx", "vue", "js", "jsx", "ts", "tsx", "mjs", "cjs", "html", "css", "scss", "less",
        "xml", "json", "properties", "yml", "yaml",
    ]
    /// Words no definition is looked up for.
    static let keywords: Set<String> = [
        "abstract", "as", "assert", "async", "await", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "export", "extends", "false", "final", "finally", "float",
        "for", "fun", "function", "if", "implements", "import", "instanceof", "int", "interface", "is", "let", "long", "new",
        "null", "package", "private", "protected", "public", "return", "short", "static", "super", "switch",
        "synchronized", "this", "throw", "throws", "true", "try", "typeof", "undefined", "val", "var", "void", "volatile",
        "while", "yield",
    ]

    private static func isWordUnit(_ u: UInt16) -> Bool {
        (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || u == 0x5F || u == 0x24
    }

    private static func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    private static func isUpper(_ u: UInt16) -> Bool { u >= 0x41 && u <= 0x5A }
    private static func isLower(_ u: UInt16) -> Bool { u >= 0x61 && u <= 0x7A }

    private static func string(_ units: ArraySlice<UInt16>) -> String { String(decoding: units, as: UTF16.self) }

    /// The name at UTF-16 `offset` of `line` in the file `path` (its extension says how tags read), or nil when the click is
    /// not on one: an identifier (`total`, `$store`); `a.b.C` for a capitalised name after lower-case package parts; a tag
    /// name in markup (`<my-widget>` → `my-widget`, `<c:out>` → `c:out`); a quoted path (`"/WEB-INF/x.jsp"`, `'./Row.vue'`)
    /// or a quoted kebab-case name. Keywords, numbers and anything non-ASCII are not names.
    public static func symbol(in line: String, at offset: Int, path: String) -> CodeNavSymbol? {
        let u = Array(line.utf16)
        guard offset >= 0, offset < u.count else { return nil }
        let ext = (path as NSString).pathExtension.lowercased()
        let markup = markupExtensions.contains(ext)

        if let quoted = quotedSymbol(u, offset) { return quoted }

        // A tag name: the run of word characters, '-' and ':' after '<' or '</'.
        if markup {
            var lo = offset, hi = offset
            let isTagUnit = { (c: UInt16) in isWordUnit(c) || c == 0x2D || c == 0x3A }
            if isTagUnit(u[offset]) {
                while lo > 0, isTagUnit(u[lo - 1]) { lo -= 1 }
                while hi + 1 < u.count, isTagUnit(u[hi + 1]) { hi += 1 }
                let afterOpen = lo > 0 && (u[lo - 1] == 0x3C || (u[lo - 1] == 0x2F && lo > 1 && u[lo - 2] == 0x3C))
                let name = string(u[lo...hi])
                if afterOpen, isTagName(name) { return CodeNavSymbol(symbol: name, range: lo..<(hi + 1)) }
            }
        }

        guard isWordUnit(u[offset]) else { return nil }
        var lo = offset, hi = offset
        while lo > 0, isWordUnit(u[lo - 1]) { lo -= 1 }
        while hi + 1 < u.count, isWordUnit(u[hi + 1]) { hi += 1 }
        guard !isDigit(u[lo]) else { return nil }
        let word = string(u[lo...hi])
        guard !keywords.contains(word), word.utf16.count <= symbolLimit else { return nil }

        // `a.b.C`: lower-case package parts before a capitalised name (an import, a fully qualified type).
        if isUpper(u[lo]) {
            var parts: [String] = []
            var i = lo
            while i >= 2, u[i - 1] == 0x2E, isWordUnit(u[i - 2]) {
                var start = i - 2
                while start > 0, isWordUnit(u[start - 1]) { start -= 1 }
                guard isLower(u[start]) else { break }
                parts.insert(string(u[start..<(i - 1)]), at: 0)
                i = start
            }
            let qualified = (parts + [word]).joined(separator: ".")
            if !parts.isEmpty, qualified.utf16.count <= symbolLimit { return CodeNavSymbol(symbol: qualified, range: lo..<(hi + 1)) }
        }
        return CodeNavSymbol(symbol: word, range: lo..<(hi + 1), receiver: receiver(u, before: lo))
    }

    /// §65.6: the identifier before `x.` / `x?.` / `x!!.` / `x::` / `x->` that ends right before UTF-16 offset `start`.
    static func receiver(_ u: [UInt16], before start: Int) -> String? {
        var i = start
        // The separator, read backwards.
        if i >= 1, u[i - 1] == 0x2E {   // .
            i -= 1
            if i >= 1, u[i - 1] == 0x3F { i -= 1 }   // ?.
            else if i >= 2, u[i - 1] == 0x21, u[i - 2] == 0x21 { i -= 2 }   // !!.
        } else if i >= 2, u[i - 1] == 0x3A, u[i - 2] == 0x3A {   // ::
            i -= 2
        } else if i >= 2, u[i - 1] == 0x3E, u[i - 2] == 0x2D {   // ->
            i -= 2
        } else {
            return nil
        }
        guard i >= 1, isWordUnit(u[i - 1]) else { return nil }   // `foo().bar`, `a[0].b`: nothing known
        var lo = i - 1
        while lo > 0, isWordUnit(u[lo - 1]) { lo -= 1 }
        guard !isDigit(u[lo]) else { return nil }
        let name = string(u[lo..<i])
        return name.utf16.count <= symbolLimit ? name : nil
    }

    /// `c:out`, `my-widget`, `MyWidget`: word parts joined by at most one ':' and any '-', nothing empty.
    private static func isTagName(_ name: String) -> Bool {
        guard name.utf16.count <= symbolLimit, let first = name.utf16.first, !isDigit(first) else { return false }
        let colon = name.split(separator: ":", omittingEmptySubsequences: false)
        guard colon.count <= 2 else { return false }
        for part in colon {
            let dashes = part.split(separator: "-", omittingEmptySubsequences: false)
            guard dashes.allSatisfy({ !$0.isEmpty && $0.utf16.allSatisfy(isWordUnit) }) else { return false }
        }
        return true
    }

    /// The contents of the quoted string the offset is inside, when it is a path or a kebab-case name.
    private static func quotedSymbol(_ u: [UInt16], _ offset: Int) -> CodeNavSymbol? {
        var i = 0
        while i < u.count {
            let q = u[i]
            guard q == 0x22 || q == 0x27 else { i += 1; continue }
            var j = i + 1
            while j < u.count, u[j] != q {
                j += u[j] == 0x5C ? 2 : 1
            }
            guard j < u.count else { return nil }   // unclosed: the rest of the line is not a string we can read
            if offset > i, offset < j {
                let text = string(u[(i + 1)..<j])
                guard isQuotedName(text) else { return nil }
                return CodeNavSymbol(symbol: text, range: (i + 1)..<j)
            }
            if offset <= j { return nil }
            i = j + 1
        }
        return nil
    }

    private static func isQuotedName(_ text: String) -> Bool {
        guard !text.isEmpty, text.utf16.count <= symbolLimit, !text.contains("://"),
              text.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "_$-./@~+".unicodeScalars.contains($0)) })
        else { return false }
        if text.contains("/") { return text.contains(where: { $0.isLetter || $0.isNumber }) }
        let ext = (text as NSString).pathExtension.lowercased()
        if pathExtensions.contains(ext), (text as NSString).deletingPathExtension.count > 0 { return true }
        // A kebab-case component name ('my-widget'), not a word or a sentence.
        return text.contains("-") && !text.contains(".") && text.utf16.first.map(isLower) == true && isTagName(text)
    }
}

/// Links that open a file at a line in an IDE (§62 "Open in IDE").
public enum IDELink {
    private static let queryAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
    private static let pathAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "?#%;"))

    /// `vscode://file/<abs path>:<line>:<col>` — the path percent-encoded (spaces, Hangul), `/` and `:` kept.
    public static func vscode(path: String, line: Int, column: Int = 1) -> URL? {
        guard path.hasPrefix("/"), let encoded = path.addingPercentEncoding(withAllowedCharacters: pathAllowed) else { return nil }
        return URL(string: "vscode://file\(encoded):\(max(1, line)):\(max(1, column))")
    }

    /// `idea://open?file=<abs path>&line=<line>` — the path percent-encoded as a query value (`&`, `+`, spaces).
    public static func intellij(path: String, line: Int) -> URL? {
        guard path.hasPrefix("/"), let encoded = path.addingPercentEncoding(withAllowedCharacters: queryAllowed) else { return nil }
        return URL(string: "idea://open?file=\(encoded)&line=\(max(1, line))")
    }

    /// `xed`'s arguments (no shell): `--line N <path>`.
    public static func xedArguments(path: String, line: Int) -> [String] {
        ["--line", String(max(1, line)), path]
    }

    /// The file's absolute path: the project's root (the shadow folder's own root too, §59) and the repo-relative path.
    public static func absolutePath(root: String, relative: String) -> String {
        relative.hasPrefix("/") ? relative : (root as NSString).appendingPathComponent(relative)
    }

    /// Whether a JetBrains IDE suits the project better than VS Code: a Maven / Gradle build file at its root, or Java,
    /// Kotlin or JSP files among `paths` (the review's, the open file's).
    public static func prefersJetBrains(rootEntries: [String], paths: [String]) -> Bool {
        let builds: Set<String> = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]
        if rootEntries.contains(where: builds.contains) { return true }
        let jvm: Set<String> = ["java", "kt", "kts", "jsp", "jspf", "jspx", "tag", "tagx"]
        return paths.contains { jvm.contains(($0 as NSString).pathExtension.lowercased()) }
    }
}

/// The window's code navigation: the request running, what it found (the peek list or a note, anchored at the click),
/// Find References' results, Back / Forward, and the place the window should open next.
@MainActor
@Observable
public final class CodeNavStore {
    /// A popover anchored at the clicked name (`anchor`: the view that asked).
    public struct Popup: Equatable {
        public enum Content: Equatable {
            /// Still looking (after a moment, so a quick answer does not flash).
            case looking
            case peek(DefinitionsReply)
            case notFound
            case failed(String)
        }
        public var symbol: String
        public var from: CodeNavLocation
        public var anchor: Int
        public var content: Content
    }

    /// What the window opens (`tick` new for every request).
    public struct OpenRequest: Equatable {
        public var location: CodeNavLocation
        public var tick: Int
    }

    public private(set) var popup: Popup?
    /// §65.8: the peek band under a clicked row (ide-nav, IdeNav.swift).
    public let peek = CodeNavPeekStore()
    /// §65.8: the hover card (⌘ held over a name, IdeNavHover.swift).
    public let hover = CodeNavHoverStore()
    /// §65.8: Symbols in File (⌘F12) / Symbols in Project (⌘⇧P) shown.
    public var palette: NavPalette?
    public private(set) var openRequest: OpenRequest?
    public private(set) var history = CodeNavHistory()
    /// Where the user is: the place last opened or clicked (Back's Forward, Open in IDE's line).
    public var caret: CodeNavLocation?
    // Find References
    /// The fallback sheet is shown (§65.8: only where the window has no bottom panel — the PRs tab).
    public var referencesShown = false
    /// Bumped by every Find References: the window shows the References tab (or the sheet).
    public private(set) var referencesTick = 0
    /// §65.8: the hit picked in the References tab (an index of `referenceHits`) and its lines around it.
    public private(set) var referenceSelection: Int?
    public private(set) var referencePreview: SymbolPreviewReply?
    public private(set) var referencePreviewError: String?
    /// The window's searches, newest first (at most `searchesLimit`).
    public private(set) var referenceSearches: [ReferenceSearch] = []
    public static let searchesLimit = 8
    /// Lines before / after a reference its preview shows.
    public static let referenceContext = (before: 6, after: 10)
    @ObservationIgnored private var referencePreviewSeq = 0
    /// F4 has jumped since the search: the next steps do not push Back again (one Back returns to where you read).
    @ObservationIgnored private var steppedSinceSearch = false
    public private(set) var referencesSymbol = ""
    public private(set) var referencesFrom: CodeNavLocation?
    public private(set) var references: ReferencesReply?
    public private(set) var referenceGroups: [ReferenceGroup] = []
    public private(set) var referencesLoading = false
    public private(set) var referencesError: String?
    @ObservationIgnored private var definitionSeq = 0
    @ObservationIgnored private var referencesSeq = 0
    @ObservationIgnored private var tick = 0

    /// How long a lookup runs before the popover says it is looking.
    public static let lookingDelay: Duration = .milliseconds(350)

    public init() {}

    /// Looks up `symbol` clicked at `from`; one candidate opens, several peek, none says so (`anchor`: the clicked view).
    func goToDefinition(_ symbol: String, from: CodeNavLocation, anchor: Int, receiver: String? = nil, sameReviewFile: (String) -> Bool,
                        using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        definitionSeq += 1
        let seq = definitionSeq
        popup = nil
        let looking = Task { [weak self] in
            try? await Task.sleep(for: Self.lookingDelay)
            guard let self, !Task.isCancelled, seq == self.definitionSeq, self.popup == nil else { return }
            self.popup = Popup(symbol: symbol, from: from, anchor: anchor, content: .looking)
        }
        defer { looking.cancel() }
        do {
            let reply = try await request(.findDefinition(symbol: symbol, fromPath: from.path, line: from.line, column: from.column,
                                                          receiver: receiver))
            guard seq == definitionSeq else { return }
            guard case let .definitions(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            switch CodeNavText.outcome(r) {
            case let .open(candidate):
                popup = nil
                open(candidate, from: from, sameReviewFile: sameReviewFile)
            case .peek:
                popup = Popup(symbol: symbol, from: from, anchor: anchor, content: .peek(r))
            case .notFound:
                popup = Popup(symbol: symbol, from: from, anchor: anchor, content: .notFound)
            }
        } catch {
            guard seq == definitionSeq else { return }
            popup = Popup(symbol: symbol, from: from, anchor: anchor, content: .failed(CodeNavText.message(error)))
        }
    }

    /// Opens a candidate (or a reference) — in the review's diff when it is a changed file and the jump started in the
    /// review or the code browser, else read-only — and remembers `from` for Back.
    func open(_ place: DefinitionCandidate, from: CodeNavLocation?, sameReviewFile: (String) -> Bool) {
        let inReview = from?.view != .other && sameReviewFile(place.path)
        let target = CodeNavLocation(view: inReview ? .review : .projectFile, path: place.path, line: place.line, column: place.column)
        if let from, from != target { history.push(from) }
        go(to: target)
    }

    /// §65.8: Go to File / a palette's pick — a changed file of the review in its diff (`line` nil: as the review shows
    /// it), any other file read-only; Back returns to where the user was (`caret`).
    func openFile(_ path: String, line: Int?, column: Int? = nil, sameReviewFile: (String) -> Bool) {
        let target = CodeNavLocation(view: sameReviewFile(path) ? .review : .projectFile, path: path, line: line, column: column)
        if let caret, caret != target { history.push(caret) }
        go(to: target)
    }

    private func go(to location: CodeNavLocation) {
        caret = location
        tick += 1
        openRequest = OpenRequest(location: location, tick: tick)
    }

    public func dismissPopup() {
        definitionSeq += 1
        popup = nil
    }

    /// Back: the place before the last jump (nil when there is none).
    @discardableResult
    public func goBack() -> CodeNavLocation? {
        guard let target = history.goBack(from: caret) else { return nil }
        go(to: target)
        return target
    }

    /// Forward: the place Back left.
    @discardableResult
    public func goForward() -> CodeNavLocation? {
        guard let target = history.goForward(from: caret) else { return nil }
        go(to: target)
        return target
    }

    /// Lists the references of `symbol` (the panel opens at once and fills in).
    func findReferences(_ symbol: String, from: CodeNavLocation?, using request: (EngineCommand) async throws -> EngineEvent) async {
        referencesSeq += 1
        let seq = referencesSeq
        popup = nil
        referencesTick += 1
        referencesSymbol = symbol
        referencesFrom = from
        references = nil
        referenceGroups = []
        referencesError = nil
        referencesLoading = true
        referenceSelection = nil
        referencePreview = nil
        referencePreviewError = nil
        referencePreviewSeq += 1
        steppedSinceSearch = false
        let search = ReferenceSearch(symbol: symbol, from: from)
        referenceSearches.removeAll { $0.id == search.id }
        referenceSearches.insert(search, at: 0)
        if referenceSearches.count > Self.searchesLimit { referenceSearches.removeLast(referenceSearches.count - Self.searchesLimit) }
        defer { if seq == referencesSeq { referencesLoading = false } }
        do {
            let reply = try await request(.findReferences(symbol: symbol, fromPath: from?.path, line: from?.line, column: from?.column))   // line / column: §73
            guard seq == referencesSeq else { return }
            guard case let .references(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            references = r
            referenceGroups = CodeNavText.groups(r.hits)
            if !r.hits.isEmpty {
                referencesLoading = false
                await selectReference(0, using: request)
            }
        } catch {
            guard seq == referencesSeq else { return }
            referencesError = CodeNavText.message(error)
        }
    }

    /// Every hit in the order the References tab lists them (file by file).
    public var referenceHits: [ReferenceHit] { referenceGroups.flatMap(\.hits) }

    /// Picks hit `index` of `referenceHits` and reads its lines around it (the tab's preview).
    func selectReference(_ index: Int, using request: (EngineCommand) async throws -> EngineEvent) async {
        let hits = referenceHits
        guard hits.indices.contains(index) else { return }
        referenceSelection = index
        let hit = hits[index]
        if let p = referencePreview, p.path == hit.path, p.line == hit.line { return }
        referencePreviewSeq += 1
        let seq = referencePreviewSeq
        referencePreviewError = nil
        do {
            let reply = try await request(.definitionPreview(path: hit.path, line: hit.line, before: Self.referenceContext.before,
                                                             after: Self.referenceContext.after))
            guard seq == referencePreviewSeq else { return }
            guard case let .definitionPreview(p) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            referencePreview = p
        } catch {
            guard seq == referencePreviewSeq else { return }
            referencePreview = nil
            referencePreviewError = CodeNavText.message(error)
        }
    }

    /// F4 / ⇧F4: the next / previous hit picked and opened in the diff or the code browser. The first step since the
    /// search remembers where the user was (`caret`) for Back; the next ones do not, so one Back returns there.
    @discardableResult
    func stepReference(_ delta: Int, sameReviewFile: (String) -> Bool,
                       using request: (EngineCommand) async throws -> EngineEvent) async -> ReferenceHit? {
        let hits = referenceHits
        guard let index = CodeNavText.step(from: referenceSelection, by: delta, count: hits.count) else { return nil }
        let hit = hits[index]
        let from = steppedSinceSearch ? nil : (caret ?? referencesFrom)
        steppedSinceSearch = true
        open(DefinitionCandidate(path: hit.path, line: hit.line, column: hit.column, kind: hit.kind ?? .file, preview: hit.preview),
             from: from, sameReviewFile: sameReviewFile)
        await selectReference(index, using: request)
        return hit
    }

    /// ↩ / a double-click in the References tab: the hit opened, Back returning to where the user was.
    func openReference(_ index: Int, sameReviewFile: (String) -> Bool) {
        let hits = referenceHits
        guard hits.indices.contains(index) else { return }
        let hit = hits[index]
        referenceSelection = index
        open(DefinitionCandidate(path: hit.path, line: hit.line, column: hit.column, kind: hit.kind ?? .file, preview: hit.preview),
             from: caret ?? referencesFrom, sameReviewFile: sameReviewFile)
    }

    /// The project changed or closed.
    public func reset() {
        definitionSeq += 1
        referencesSeq += 1
        popup = nil
        peek.reset()
        referenceSelection = nil
        referencePreview = nil
        referencePreviewError = nil
        referencePreviewSeq += 1
        referenceSearches = []
        hover.dismiss()
        palette = nil
        openRequest = nil
        history.clear()
        caret = nil
        referencesShown = false
        references = nil
        referenceGroups = []
        referencesError = nil
        referencesLoading = false
    }
}

extension AppState {
    /// ⌘-click / Go to Definition on `symbol` at `from` (its `column` and `receiver` when the click gave them, §65.6);
    /// `anchor` names the view the popover hangs from.
    public func goToDefinition(_ symbol: String, from: CodeNavLocation, anchor: Int, receiver: String? = nil) async {
        guard projectInfo != nil else { return }
        await codeNav.goToDefinition(symbol, from: from, anchor: anchor, receiver: receiver,
                                     sameReviewFile: { [weak self] in self?.changedFile(path: $0) != nil }) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// Find References on `symbol` at `from`.
    public func findReferences(_ symbol: String, from: CodeNavLocation?) async {
        guard projectInfo != nil else { return }
        await codeNav.findReferences(symbol, from: from) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// The References tab: pick hit `index` (its preview), open it (↩), or step to the next / previous one (F4 / ⇧F4).
    public func selectReference(_ index: Int) async {
        await codeNav.selectReference(index) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    public func openReference(_ index: Int) {
        codeNav.openReference(index, sameReviewFile: { [weak self] in self?.changedFile(path: $0) != nil })
    }

    @discardableResult
    public func stepReference(_ delta: Int) async -> ReferenceHit? {
        await codeNav.stepReference(delta, sameReviewFile: { [weak self] in self?.changedFile(path: $0) != nil }) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// Go to File / Symbols in File / Symbols in Project: open `path` at `line` (a changed file in its diff).
    public func goToFile(path: String, line: Int? = nil, column: Int? = nil) {
        codeNav.dismissPopup()
        codeNav.openFile(path, line: line, column: column, sameReviewFile: { [weak self] in self?.changedFile(path: $0) != nil })
    }

    /// Opens a peek row or a reference: the popover / panel closes, the place opens, Back returns to where it started.
    public func openNavPlace(path: String, line: Int, column: Int = 1, kind: DefinitionKind? = nil, from: CodeNavLocation?) {
        codeNav.dismissPopup()
        let place = DefinitionCandidate(path: path, line: line, column: column, kind: kind ?? .file, preview: "")
        codeNav.open(place, from: from, sameReviewFile: { [weak self] in self?.changedFile(path: $0) != nil })
    }
}
