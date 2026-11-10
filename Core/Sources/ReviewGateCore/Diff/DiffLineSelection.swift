import Foundation

// Several lines of a diff picked with the mouse — a click, ⇧-click or a drag over the rows — and copied as code (user
// report: "복붙도 안되고"): the review diff, its full file, history and live diffs. A row is named by its key
// (`DiffDisplayItem.key`, the full file's "F<n>" / "D<a>-<o>"), so lines revealed or unfolded between the two ends join
// the selection, and a row that left the list (another range, a new diff) ends it.

public struct DiffLineSelection: Equatable, Sendable {
    /// Where the selection started (a plain click) and where it ends now (⇧-click, drag).
    public private(set) var anchor: String?
    public private(set) var focus: String?
    /// Bumped by every click and drag step, also one that leaves the rows as they were: the list's ⌘C reads it as "the
    /// last click in the window was on these lines".
    public private(set) var revision = 0

    public init() {}

    public var isEmpty: Bool { anchor == nil }

    /// A click on the row `key`: that row alone, or (`extend`: ⇧-click, a drag) from the anchor to it.
    public mutating func select(_ key: String, extend: Bool) {
        if !extend || anchor == nil { anchor = key }
        focus = key
        revision &+= 1
    }

    public mutating func clear() {
        guard anchor != nil else { return }
        anchor = nil
        focus = nil
        revision &+= 1
    }

    /// The selected rows' positions in `order` (the list's row keys in display order): anchor through focus, either way
    /// round; the anchor alone when the focus is no longer a row, nil when the anchor is not.
    public func range(in order: [String]) -> ClosedRange<Int>? {
        guard let anchor, let a = order.firstIndex(of: anchor) else { return nil }
        guard let focus, let f = order.firstIndex(of: focus) else { return a...a }
        return min(a, f)...max(a, f)
    }

    /// The keys of the selected rows (what the rows look themselves up in to draw as selected).
    public func keys(in order: [String]) -> Set<String> {
        guard let range = range(in: order) else { return [] }
        return Set(order[range])
    }

    /// The copied text: each line's code in order, without its +/− marker or line numbers; hunk headers are left out.
    public static func copyText(_ lines: some Sequence<DiffLine>) -> String {
        lines.lazy.filter { $0.kind != .hunkHeader }.map(\.text).joined(separator: "\n")
    }
}
