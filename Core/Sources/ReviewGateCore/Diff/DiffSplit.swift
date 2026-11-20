import Foundation

// The diff's two layouts (docs/PROTOCOL.md §34.11): unified (one column, the default) or split — the old side on the left,
// the new side on the right, as git tools and GitHub show it. Split rows are built from the unified rows (`DiffDisplayItem`
// of `DiffDisplayPlan`, or a plain line list), so folds, "Show 20 more lines", find and the line keys stay what they are.
// Pure, O(n) and only built while split is shown (DiffSplitTests).

/// How a diff is laid out (remembered per user: Mac `DiffPrefsKeys.diffLayout`, Windows `rg.diff.layout`).
public enum DiffLayoutMode: String, Sendable, CaseIterable, Codable {
    case unified
    case split
}

/// One row of a split diff.
public struct DiffSplitRow: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        /// A line on each side: a context line on both (the same line), a removed line on the left beside the added line it
        /// pairs with on the right; nil pads the shorter side of a change.
        case pair(left: DiffLine?, right: DiffLine?)
        /// A full-width row as in the unified layout: a hunk header, an expander, a fold.
        case item(DiffDisplayItem)
    }

    /// The key of its first line (`DiffDisplayItem.key`, the left one when there is one), or the item's id.
    public let id: String
    public let kind: Kind

    public init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    /// The lines of the row's two sides that carry notes, comments, findings and the composer — a line's anchor side
    /// (`DiffSplit.anchorSide`): a removed line on the left, an added or unchanged line on the right. An unchanged line
    /// shows on both sides but anchors once, on the right, as notes on it name its new number.
    public var anchors: (left: DiffLine?, right: DiffLine?) {
        guard case let .pair(left, right) = kind else { return (nil, nil) }
        return (left.flatMap { DiffSplit.anchorSide(of: $0) == .old ? $0 : nil }, right.flatMap { DiffSplit.anchorSide(of: $0) == .new ? $0 : nil })
    }
}

/// A split diff: its rows and where each line landed.
public struct DiffSplitLayout: Equatable, Sendable {
    public let rows: [DiffSplitRow]
    /// Line key (`DiffDisplayItem.key`) → the id of the row holding it (find in diff and chat links scroll to a line).
    public let rowByLineKey: [String: String]

    public init(rows: [DiffSplitRow], rowByLineKey: [String: String]) {
        self.rows = rows
        self.rowByLineKey = rowByLineKey
    }

    /// The row to scroll to for a line key; the key itself when it names a full-width row (or nothing here).
    public func rowId(forLineKey key: String?) -> String? {
        guard let key else { return nil }
        return rowByLineKey[key] ?? key
    }
}

public enum DiffSplit {
    /// The narrowest a side's code column may get, in characters of the diff font: below it a Java / Swift line wraps into
    /// stubs (or scrolls a few words at a time), so the pane shows unified instead.
    public static let minimumColumns = 38

    /// The pane width split needs: two sides, each a line-number gutter (and marker) plus `minimumColumns` characters, and
    /// the divider between them. Mac: body monospaced ≈ 7.8 pt a character and a 66 pt gutter → about 724 pt.
    public static func minimumWidth(columnWidth: Double, gutter: Double) -> Double {
        2 * (gutter + Double(minimumColumns) * columnWidth) + 1
    }

    /// What is shown: split only when it was chosen and the pane is wide enough for it.
    public static func effective(_ mode: DiffLayoutMode, width: Double, minimumWidth: Double) -> DiffLayoutMode {
        mode == .split && width >= minimumWidth ? .split : .unified
    }

    /// The side a line's notes, comments and findings sit on: a removed line's is the old side, any other the new side
    /// (as the unified layout anchors them: `del` by its old number, the rest by their new one).
    public static func anchorSide(of line: DiffLine) -> DiffSide { line.kind == .del ? .old : .new }

    /// The split rows of a diff's unified rows. A run of changed lines (removed and added lines with nothing between them —
    /// never across a hunk header, an unchanged line or a fold) pairs its i-th removed line with its i-th added line, the
    /// shorter side padded; an unchanged line (a revealed one too) is on both sides; every other row stays full width.
    public static func layout(_ items: [DiffDisplayItem]) -> DiffSplitLayout {
        var rows: [DiffSplitRow] = []
        rows.reserveCapacity(items.count)
        var rowByLineKey: [String: String] = [:]
        rowByLineKey.reserveCapacity(items.count)
        var dels: [DiffLine] = []
        var adds: [DiffLine] = []

        func pair(_ left: DiffLine?, _ right: DiffLine?) {
            let id = DiffDisplayItem.key((left ?? right)!)
            rows.append(DiffSplitRow(id: id, kind: .pair(left: left, right: right)))
            if let left { rowByLineKey[DiffDisplayItem.key(left)] = id }
            if let right { rowByLineKey[DiffDisplayItem.key(right)] = id }
        }

        func flush() {
            guard !dels.isEmpty || !adds.isEmpty else { return }
            for i in 0..<max(dels.count, adds.count) {
                pair(i < dels.count ? dels[i] : nil, i < adds.count ? adds[i] : nil)
            }
            dels.removeAll(keepingCapacity: true)
            adds.removeAll(keepingCapacity: true)
        }

        for item in items {
            switch item.kind {
            case let .line(line) where line.kind == .del:
                // A removed line after added ones starts another change (git writes a change's removals first).
                if !adds.isEmpty { flush() }
                dels.append(line)
            case let .line(line) where line.kind == .add:
                adds.append(line)
            case let .line(line) where line.kind == .context, let .context(line):
                flush()
                pair(line, line)
            default:
                flush()
                rows.append(DiffSplitRow(id: item.id, kind: .item(item)))
                if case let .line(line) = item.kind { rowByLineKey[DiffDisplayItem.key(line)] = item.id }
            }
        }
        flush()
        return DiffSplitLayout(rows: rows, rowByLineKey: rowByLineKey)
    }

    /// The split rows of a plain list of diff lines (the live, history-less and whitespace-ignoring diffs).
    public static func layout(lines: [DiffLine]) -> DiffSplitLayout {
        layout(lines.map { DiffDisplayItem(id: DiffDisplayItem.key($0), kind: $0.id < 0 ? .context($0) : .line($0)) })
    }
}
