import Foundation

// wave2 mac-diff — how the diff pane lays out one file's diff (docs/PROTOCOL.md §34.7; audit comp-18, comp-19): a big diff
// folds hunk by hunk and skips syntax highlighting, a generated file or lockfile folds whole, and the unchanged lines
// around a hunk can be shown from the full file ("20줄 더 보기"). Pure and synchronous, so the pane can rebuild it on any
// change and tests can pin it down (DiffDisplayTests, DiffPerformanceTests).

/// `@@ -a[,b] +c[,d] @@`: where a hunk sits on each side (an omitted count is 1).
public struct HunkRange: Equatable, Sendable {
    public var oldStart: Int
    public var oldCount: Int
    public var newStart: Int
    public var newCount: Int

    public init(oldStart: Int, oldCount: Int, newStart: Int, newCount: Int) {
        self.oldStart = oldStart
        self.oldCount = oldCount
        self.newStart = newStart
        self.newCount = newCount
    }

    /// nil when `header` is not a unified hunk header.
    public init?(header: String) {
        guard header.hasPrefix("@@ -"), let close = header.range(of: " @@") else { return nil }
        let ranges = header[header.index(header.startIndex, offsetBy: 4)..<close.lowerBound].split(separator: " ")
        guard ranges.count == 2, ranges[1].hasPrefix("+"),
              let old = Self.range(ranges[0]), let new = Self.range(ranges[1].dropFirst()) else { return nil }
        self.init(oldStart: old.start, oldCount: old.count, newStart: new.start, newCount: new.count)
    }

    private static func range(_ s: Substring) -> (start: Int, count: Int)? {
        let parts = s.split(separator: ",", omittingEmptySubsequences: false)
        guard let start = Int(parts[0]) else { return nil }
        if parts.count == 1 { return (start, 1) }
        guard parts.count == 2, let count = Int(parts[1]) else { return nil }
        return (start, count)
    }

    /// The first new-side line at or after the hunk (a pure deletion sits after its `newStart`).
    public var newFirst: Int { newCount == 0 ? newStart + 1 : newStart }
    /// The first new-side line after the hunk.
    public var newAfter: Int { newCount == 0 ? newStart + 1 : newStart + newCount }
    public var oldFirst: Int { oldCount == 0 ? oldStart + 1 : oldStart }
    public var oldAfter: Int { oldCount == 0 ? oldStart + 1 : oldStart + oldCount }
}

/// The unchanged lines between two hunks (or before the first / after the last), on the new side.
public struct DiffGap: Equatable, Sendable {
    /// 0: before the first hunk; `hunks.count`: after the last.
    public var index: Int
    /// The first hidden new-side line (1-based).
    public var newStart: Int
    /// The last hidden new-side line; nil = up to the end of the file (known once the file is loaded).
    public var newEnd: Int?
    /// An unchanged line's old number is its new number plus this.
    public var oldOffset: Int

    public init(index: Int, newStart: Int, newEnd: Int?, oldOffset: Int) {
        self.index = index
        self.newStart = newStart
        self.newEnd = newEnd
        self.oldOffset = oldOffset
    }

    /// Hidden lines in the gap; nil when it runs to the end of a file whose length is not known yet.
    public func size(fileLines: Int?) -> Int? {
        guard let end = newEnd ?? fileLines else { return nil }
        return max(0, end - newStart + 1)
    }
}

/// "Show 20 more lines": which way a gap opens.
public enum ContextDirection: Sendable, Hashable {
    /// Lines right above the next hunk (the gap's bottom grows upward).
    case up
    /// Lines right below the previous hunk (the gap's top grows downward).
    case down
}

/// What the user unfolded in one file's diff. Reset when the diff changes (another file, another range, a new B).
public struct DiffFoldState: Equatable, Sendable {
    /// Large diff: the hunks opened one by one.
    public var openHunks: Set<Int> = []
    /// Large diff: every hunk open ("큰 diff · N줄 · 펼치기").
    public var allOpen = false
    /// A generated file / lockfile opened ("생성 파일 · +N줄 · 펼치기").
    public var fileOpen = false
    /// Per gap index: lines revealed at its top (below the previous hunk) and bottom (above the next hunk).
    public var revealed: [Int: Reveal] = [:]

    public struct Reveal: Equatable, Sendable {
        public var top = 0
        public var bottom = 0
    }

    public init() {}

    /// One "Show 20 more lines" on `gap`.
    public mutating func reveal(gap: Int, direction: ContextDirection, step: Int = DiffDisplay.contextStep) {
        var r = revealed[gap] ?? Reveal()
        switch direction {
        case .up: r.bottom += step
        case .down: r.top += step
        }
        revealed[gap] = r
    }

    /// "Collapse N lines" on `gap`: what "Show 20 more lines" revealed there (both ends) is hidden again.
    public mutating func collapse(gap: Int) {
        revealed[gap] = nil
    }

    /// Every gap hidden again ("Collapse All Shown Lines").
    public mutating func collapseAllRevealed() {
        revealed = [:]
    }

    /// Some gap was opened since the diff was shown (or since it was last collapsed).
    public var hasRevealed: Bool { !revealed.isEmpty }

    public mutating func toggleHunk(_ id: Int) {
        if openHunks.contains(id) { openHunks.remove(id) } else { openHunks.insert(id) }
    }
}

/// One row of the diff pane.
public struct DiffDisplayItem: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        /// A line of the diff (hunk headers included).
        case line(DiffLine)
        /// An unchanged line shown from the full file around a hunk (`id` < 0, never a highlight index).
        case context(DiffLine)
        /// "Show 20 more lines" for gap `gap`: `hidden` lines left (nil: unknown until the file is loaded); `up` / `down`
        /// say which ways it can open (a gap of at most 20 lines has one button that shows it all). `revealed`: the gap's
        /// lines on screen, which "Collapse N lines" hides again — a fully shown gap keeps this row for that (hidden 0,
        /// neither way open), where its expander was.
        case expander(gap: Int, hidden: Int?, up: Bool, down: Bool, revealed: Int)
        /// Large diff: a hunk's body, folded ("+N줄 · 펼치기") or open (a collapse link).
        case foldedHunk(hunkId: Int, lines: Int, open: Bool)
        /// A generated file / lockfile: the whole diff folded, or the collapse link above it once opened.
        case foldedFile(lines: Int, open: Bool)
        /// Large diff: the notice above the folded hunks ("큰 diff · N줄 · 펼치기" / collapse all).
        case largeDiff(lines: Int, open: Bool)
    }

    public let id: String
    public let kind: Kind

    public init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    /// The key a line row is found by (find in diff, scrolling): "L<id>" for a diff line, "C<newNo>" for a context line.
    public static func key(_ line: DiffLine) -> String { line.id < 0 ? "C\(-line.id)" : "L\(line.id)" }
}

public enum DiffDisplay {
    /// Above this many diff lines (hunk headers included) the hunks start folded and the highlighter is skipped. §34.7
    /// folds "any diff over 3 000 lines"; it is also what the highlighter colours in about a second (≈ 0.3–0.4 ms a line
    /// in a debug build, SyntaxHighlighterTests) and keeps a List's rows within what a scroll keeps up with.
    public static let foldLineThreshold = 3_000
    /// Lines one "Show 20 more lines" reveals.
    public static let contextStep = 20

    /// More than `foldLineThreshold` lines.
    public static func isLarge(_ diff: FileDiff) -> Bool { lineCount(diff) > foldLineThreshold }

    static func lineCount(_ diff: FileDiff) -> Int { diff.hunks.reduce(0) { $0 + $1.lines.count } }

    /// git's default context: a hunk that ends on fewer unchanged lines reached the end of the file.
    static let contextLines = 3

    /// The gaps before, between and after the hunks (`hunks.count + 1` of them); nil when a hunk header does not parse.
    /// The last gap runs to the end of the file (unknown until it is loaded) — or is empty when the last hunk ends on
    /// fewer than 3 unchanged lines, i.e. at the end of the file (no "Show 20 more lines" that would find nothing).
    public static func gaps(of diff: FileDiff) -> [DiffGap]? {
        var ranges: [HunkRange] = []
        for hunk in diff.hunks {
            guard let range = HunkRange(header: hunk.header) else { return nil }
            ranges.append(range)
        }
        guard let first = ranges.first, let last = ranges.last, let lastHunk = diff.hunks.last else { return nil }
        var gaps = [DiffGap(index: 0, newStart: 1, newEnd: first.newFirst - 1, oldOffset: first.oldFirst - first.newFirst)]
        for i in ranges.indices.dropFirst() {
            gaps.append(DiffGap(index: i, newStart: ranges[i - 1].newAfter, newEnd: ranges[i].newFirst - 1,
                                oldOffset: ranges[i].oldFirst - ranges[i].newFirst))
        }
        let trailing = lastHunk.lines.reversed().prefix { $0.kind == .context }.count
        gaps.append(DiffGap(index: ranges.count, newStart: last.newAfter, newEnd: trailing < contextLines ? last.newAfter - 1 : nil,
                            oldOffset: last.oldAfter - last.newAfter))
        return gaps
    }

    /// The full file's lines agree with the new side of the diff (every context / added line), so lines revealed from it
    /// belong to the same version. False after an edit on disk since the diff (the IDE, a running turn's newer content).
    public static func fullFileMatches(_ diff: FileDiff, lines: [String]) -> Bool {
        for hunk in diff.hunks {
            for line in hunk.lines where line.kind == .context || line.kind == .add {
                guard let n = line.newNo, n >= 1, n <= lines.count else { return false }
                if !sameText(lines[n - 1], line.text) { return false }
            }
        }
        return true
    }

    /// Equal once a trailing "\r" is dropped (the full file splits on "\r?\n", a CRLF diff keeps the "\r").
    private static func sameText(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        return (a.hasSuffix("\r") ? String(a.dropLast()) : a) == (b.hasSuffix("\r") ? String(b.dropLast()) : b)
    }

    /// The hunk holding the diff line `id`.
    public static func hunkId(containingLine id: Int, in diff: FileDiff) -> Int? {
        diff.hunks.first { hunk in
            guard let first = hunk.lines.first?.id, let last = hunk.lines.last?.id else { return false }
            return (first...last).contains(id)
        }?.id
    }
}

/// The rows of one file's diff, built from the diff, what is unfolded and (for context lines) the full file.
public struct DiffDisplayPlan: Sendable, Equatable {
    public let items: [DiffDisplayItem]
    /// More than `DiffDisplay.foldLineThreshold` lines: hunks fold, no highlighting, no context expansion.
    public let isLarge: Bool
    /// A generated file / lockfile still folded whole.
    public let foldsFile: Bool
    /// Run the syntax highlighter (neither large nor folded).
    public let highlights: Bool

    /// - Parameters:
    ///   - generated: `ChangedFile.generated` (nil for history / PR diffs and older engines).
    ///   - fullFile: the file's lines (`full_file`) once loaded and matching the diff; context lines need it.
    ///   - truncated: the engine cut the diff at its line cap — the last hunk is incomplete, nothing is offered after it.
    ///   - contextEnabled: the pane can load the full file (the review's own diff of a file that still exists).
    public static func make(diff: FileDiff, generated: GeneratedKind?, fold: DiffFoldState, fullFile: [String]?,
                            truncated: Bool, contextEnabled: Bool) -> DiffDisplayPlan {
        let total = DiffDisplay.lineCount(diff)
        let large = total > DiffDisplay.foldLineThreshold
        var items: [DiffDisplayItem] = []
        if generated != nil {
            let body = diff.hunks.reduce(0) { $0 + $1.lines.count { $0.kind != .hunkHeader } }
            items.append(DiffDisplayItem(id: "G", kind: .foldedFile(lines: body, open: fold.fileOpen)))
            if !fold.fileOpen { return DiffDisplayPlan(items: items, isLarge: large, foldsFile: true, highlights: false) }
        }
        if large {
            items.reserveCapacity(items.count + (fold.allOpen ? total : diff.hunks.count * 3) + 1)
            items.append(DiffDisplayItem(id: "N", kind: .largeDiff(lines: total, open: fold.allOpen)))
            for hunk in diff.hunks {
                let open = fold.allOpen || fold.openHunks.contains(hunk.id)
                let body = hunk.lines.count { $0.kind != .hunkHeader }
                for line in hunk.lines where line.kind == .hunkHeader { items.append(Self.line(line)) }
                items.append(DiffDisplayItem(id: "F\(hunk.id)", kind: .foldedHunk(hunkId: hunk.id, lines: body, open: open)))
                if open {
                    for line in hunk.lines where line.kind != .hunkHeader { items.append(Self.line(line)) }
                }
            }
            return DiffDisplayPlan(items: items, isLarge: true, foldsFile: false, highlights: false)
        }
        let gaps = contextEnabled && !diff.isBinary ? DiffDisplay.gaps(of: diff) : nil
        items.reserveCapacity(items.count + total + 8)
        for (i, hunk) in diff.hunks.enumerated() {
            if let gaps { appendGap(gaps[i], isFirst: i == 0, isLast: false, fold: fold, fullFile: fullFile, into: &items) }
            for line in hunk.lines { items.append(Self.line(line)) }
        }
        if let gaps, let final = gaps.last, !truncated {
            appendGap(final, isFirst: false, isLast: true, fold: fold, fullFile: fullFile, into: &items)
        }
        return DiffDisplayPlan(items: items, isLarge: false, foldsFile: false, highlights: true)
    }

    private static func line(_ line: DiffLine) -> DiffDisplayItem { DiffDisplayItem(id: "L\(line.id)", kind: .line(line)) }

    /// The revealed lines of `gap` around its expander. The gap before the first hunk only opens up, the one after the
    /// last only down; a gap between hunks opens both ways while more than one step is hidden, else one button shows it.
    /// Once lines are revealed the expander also collapses them, and stays (collapse only) when the whole gap is shown.
    private static func appendGap(_ gap: DiffGap, isFirst: Bool, isLast: Bool, fold: DiffFoldState, fullFile: [String]?,
                                  into items: inout [DiffDisplayItem]) {
        guard let size = gap.size(fileLines: fullFile?.count) else {
            // Only the last gap runs to the end of the file; its length is unknown until the file is loaded.
            items.append(DiffDisplayItem(id: "X\(gap.index)", kind: .expander(gap: gap.index, hidden: nil, up: false, down: true, revealed: 0)))
            return
        }
        guard size > 0 else { return }
        let asked = fold.revealed[gap.index] ?? DiffFoldState.Reveal()
        let lines = fullFile ?? []
        let top = fullFile != nil && !isFirst ? min(asked.top, size) : 0
        let bottom = fullFile != nil && !isLast ? min(asked.bottom, size - top) : 0
        let hidden = size - top - bottom
        for n in gap.newStart..<(gap.newStart + top) { items.append(context(n, gap: gap, lines: lines)) }
        if hidden > 0 || top + bottom > 0 {
            let up = hidden > 0 && !isLast
            let down = hidden > 0 && (isLast || (!isFirst && hidden > DiffDisplay.contextStep))
            items.append(DiffDisplayItem(id: "X\(gap.index)", kind: .expander(gap: gap.index, hidden: hidden, up: up, down: down,
                                                                                revealed: top + bottom)))
        }
        let bottomStart = gap.newStart + size - bottom
        for n in bottomStart..<(bottomStart + bottom) { items.append(context(n, gap: gap, lines: lines)) }
    }

    private static func context(_ n: Int, gap: DiffGap, lines: [String]) -> DiffDisplayItem {
        let text = lines.indices.contains(n - 1) ? lines[n - 1] : ""
        let line = DiffLine(id: -n, kind: .context, oldNo: n + gap.oldOffset, newNo: n, text: text)
        return DiffDisplayItem(id: "C\(n)", kind: .context(line))
    }
}
