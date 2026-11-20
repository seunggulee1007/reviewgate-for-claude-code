import Foundation

// Review › Next Change / Previous Change (⌥⌘] / ⌥⌘[; docs/PROTOCOL.md "Review menu (Mac)"): the diff on screen goes to the
// next / previous change block of the file; past its last / first block, to the first / last block of the next / previous
// file of the list the diff came from. Pure, over the rows of the list in display order — unified rows, split rows or the full
// file's — so every diff pane walks the same blocks (DiffChangeNavigationTests).

public enum DiffChangeNavigation {
    public enum Direction: Sendable {
        case next
        case previous
    }

    /// One row of a diff list in display order: the key the list scrolls to and whether it shows a change.
    public struct Row: Equatable, Sendable {
        public let key: String
        public let isChange: Bool

        public init(key: String, isChange: Bool) {
            self.key = key
            self.isChange = isChange
        }
    }

    /// The index of the first row of each change block: a run of changed rows with no other row (an unchanged line, a hunk
    /// header, an expander) between them — a hunk's removed lines and the added lines after them are one block.
    public static func blockStarts(_ rows: [Row]) -> [Int] {
        rows.indices.filter { rows[$0].isChange && ($0 == 0 || !rows[$0 - 1].isChange) }
    }

    /// The key of the block to go to from `cursor` (the block last gone to); nil when there is none that way — the caller goes
    /// on to the next / previous file. A cursor that is not a row here (none yet, another diff) stands before the first row:
    /// the next block is the first, there is no previous one.
    public static func target(_ direction: Direction, from cursor: String?, in rows: [Row]) -> String? {
        let starts = blockStarts(rows)
        let at = cursor.flatMap { key in rows.firstIndex { $0.key == key } } ?? -1
        let index: Int? = switch direction {
        case .next: starts.first { $0 > at }
        case .previous: at < 0 ? nil : starts.last { $0 < at }
        }
        return index.map { rows[$0].key }
    }

    /// The block a file is entered at: its first coming from the file before it (`.next`), its last from the one after it.
    public static func entry(_ direction: Direction, in rows: [Row]) -> String? {
        let starts = blockStarts(rows)
        return (direction == .next ? starts.first : starts.last).map { rows[$0].key }
    }

    /// The file after / before `current` in `ids` (the list's order on screen; its ends stop, no wrap); with `current` not in
    /// the list, its first / last.
    public static func neighbour<ID: Equatable>(_ direction: Direction, of current: ID?, in ids: [ID]) -> ID? {
        guard let index = current.flatMap({ ids.firstIndex(of: $0) }) else {
            return direction == .next ? ids.first : ids.last
        }
        let other = direction == .next ? index + 1 : index - 1
        return ids.indices.contains(other) ? ids[other] : nil
    }

    // MARK: The rows of each list

    /// The unified rows (`DiffDisplayPlan.items`, `DiffMoreLines.items`): an added / removed line is a change, and so is a
    /// closed fold (a large diff's hunk, a generated file) — it holds changes, and the list scrolls to its row.
    public static func rows(items: [DiffDisplayItem]) -> [Row] {
        items.map { Row(key: $0.id, isChange: isChange($0)) }
    }

    /// A plain list of diff lines (the live and whitespace-ignoring diffs), keyed as their rows (`DiffDisplayItem.key`).
    public static func rows(lines: [DiffLine]) -> [Row] {
        lines.map { Row(key: DiffDisplayItem.key($0), isChange: $0.kind == .add || $0.kind == .del) }
    }

    /// The split rows (§34.11): a pair with a changed side is a change. Its blocks are the unified rows' — the same blocks,
    /// each at the row holding its first line (`DiffSplitLayout.rowId(forLineKey:)`).
    public static func rows(split: DiffSplitLayout) -> [Row] {
        split.rows.map { row in
            switch row.kind {
            case let .pair(left, right):
                Row(key: row.id, isChange: [left, right].contains { $0?.kind == .add || $0?.kind == .del })
            case let .item(item):
                Row(key: row.id, isChange: isChange(item))
            }
        }
    }

    private static func isChange(_ item: DiffDisplayItem) -> Bool {
        switch item.kind {
        case let .line(line): line.kind == .add || line.kind == .del
        case let .foldedHunk(_, _, open), let .foldedFile(_, open): !open
        default: false
        }
    }
}
