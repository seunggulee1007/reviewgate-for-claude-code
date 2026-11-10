import Foundation

// MARK: r1-composer M11 — Send is always visible at the user's 1000 × 637 window
//
// docs/PROTOCOL.md §49.2: with files pending (almost always in auto mode) the diff pane opens beside the chat; in a laptop
// window the chat was ~311 pt wide and the composer's bottom row ([!] · Accept N & Send · model · mode) pushed Send, Send
// now and Stop out of the window. The row now keeps the send button whole and folds the rest, and the split keeps the chat
// wide enough.

/// The composer's bottom row: the send button (and Stop) keep their size; the secondary controls — Request changes, Accept
/// N & Send, the next message's model and the mode — fold into one "⋯" menu (the mode stays, as an icon) when at their own
/// width they would leave the status hint less than `minStatus`.
public enum ComposerBarFit {
    public static let minStatus: Double = 60
    public static let spacing: Double = 8

    /// `rowWidth`: the row's width (0 before it was measured: never folded); `secondary`: the secondary controls at their
    /// own width; `trailing`: Stop and the send button.
    public static func compact(rowWidth: Double, secondary: Double, trailing: Double) -> Bool {
        guard rowWidth > 0, secondary > 0 else { return false }
        return secondary + trailing + minStatus + 3 * spacing > rowWidth
    }
}

/// The diff and chat split beside each other (`SplitPane`): the diff pane's width.
public enum PaneSplit {
    /// `want` within the minimums. When `total` cannot hold both minimums, the trailing pane (the chat) still keeps its
    /// minimum as long as the leading one keeps `leadingFloor`; below that (or without a floor) they share `total` in
    /// proportion to their minimums.
    public static func leadingWidth(_ want: Double, total: Double, minLeading: Double, minTrailing: Double, leadingFloor: Double? = nil) -> Double {
        guard total >= minLeading + minTrailing else {
            if let leadingFloor, total - minTrailing >= leadingFloor { return total - minTrailing }
            return (total * minLeading / max(minLeading + minTrailing, 1)).rounded()
        }
        return min(max(want, minLeading), total - minTrailing)
    }
}

extension AppState {
    /// M11: "Request changes (N)" shows only with notes to send (it can do nothing without), and only for the running
    /// chat's review (§39.2).
    public var showsRequestChanges: Bool { viewingChat == nil && !unsentNotes.isEmpty }
}
