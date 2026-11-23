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

    /// MARK: terminal-chat (§57.5): a terminal chat's split — the review panel leading, next to the file list, the terminal
    /// trailing — so the terminal's width in points while both are side by side (`terminalReviewLayout` is `.sideBySide`):
    /// at least `minTerminal` (80 columns — the TUI never shrinks below it) and at most what leaves the review its
    /// `reviewFloor`, where the user put the divider in between. Below that width the panel is a drawer over the terminal.
    public static func terminalWidth(_ want: Double, total: Double, minTerminal: Double, reviewFloor: Double) -> Double {
        let low = min(minTerminal, max(total, 0))
        let high = max(low, total - reviewFloor)
        return min(max(want, low), high)
    }

    /// §57.5: the review panel's width — the split's leading pane — for the width `want` the divider asks for: what is
    /// left of `total` beside the terminal's `terminalWidth`, so the terminal keeps 80 columns and the panel its floor.
    public static func reviewPanelWidth(_ want: Double, total: Double, minTerminal: Double, reviewFloor: Double) -> Double {
        total - terminalWidth(total - want, total: total, minTerminal: minTerminal, reviewFloor: reviewFloor)
    }

    /// §57.5: how a terminal chat shows its review panel in `total` points (the terminal and the panel, the edge tab aside):
    /// side by side when the terminal keeps 80 columns beside the panel's floor, else as a drawer over the terminal, which
    /// keeps its whole width (no resize, no reflow of the TUI) while the drawer opens and closes.
    public static func terminalReviewLayout(total: Double, minTerminal: Double, reviewFloor: Double) -> TerminalReviewLayout {
        total >= minTerminal + reviewFloor ? .sideBySide : .overlay
    }

    /// §57.5: the drawer's width (it lies over the terminal's left side, next to the file list) — 45 % of the area, at least the panel's floor (its Accept still shows), never so wide that
    /// less than `terminalStrip` of the terminal stays visible beside it (in a tiny window: what is there).
    public static func reviewDrawerWidth(total: Double, reviewFloor: Double, share: Double = 0.45, terminalStrip: Double = 120) -> Double {
        let want = max(reviewFloor, (total * share).rounded())
        return max(min(want, total - terminalStrip), min(reviewFloor, max(total, 0)))
    }

    /// §57.5: whether a terminal chat's open review panel moves the file list (the sidebar, `sidebar` points wide with its
    /// divider) out of the way — exactly when beside the file list the panel would be a drawer. `area` is the terminal +
    /// panel area now (`sidebarHidden`: the file list is out of the way already, so the area holds its width too). Without
    /// it the panel sits beside the terminal where that area holds both (a 1280 pt window: 956 → 1257 pt), else the drawer is
    /// 45 % of the wider area (1000 pt: 360 → 440 pt, the terminal's visible part 316 → 537 pt). The sidebar comes back once
    /// the panel fits beside the terminal with it, so a widened window shows it again.
    public static func reviewHidesSidebar(area: Double, sidebar: Double, sidebarHidden: Bool, minTerminal: Double, reviewFloor: Double) -> Bool {
        let besideSidebar = sidebarHidden ? area - sidebar : area
        return terminalReviewLayout(total: besideSidebar, minTerminal: minTerminal, reviewFloor: reviewFloor) == .overlay
    }
}

/// §57.5: the strip's "ReviewGate가 리뷰해요 — 변경은 왼쪽에 나와요" says where the review is only the first few times — in the first
/// `chats` terminal chats that reach it (per user, `countKey`) — or until the user closes it (`dismissedKey`); after that the
/// strip keeps only its shield, with the same tooltip.
public enum TerminalReviewedHint {
    public static let chats = 3
    public static let countKey = "terminalReviewedHintCount"
    public static let dismissedKey = "terminalReviewedHintDismissed"

    /// `count`: terminal chats that showed it so far; `countedHere`: this chat is one of them (it keeps the words while it
    /// is on screen, also as the last one counted).
    public static func shows(count: Int, dismissed: Bool, countedHere: Bool) -> Bool {
        !dismissed && (countedHere || count < chats)
    }

    /// The hint shows in a chat that has not counted yet: it counts now.
    public static func counts(count: Int, dismissed: Bool, countedHere: Bool) -> Bool {
        !countedHere && shows(count: count, dismissed: dismissed, countedHere: false)
    }
}

/// §57.5: a terminal chat's review panel beside the terminal, or as a drawer over it.
public enum TerminalReviewLayout: Equatable, Sendable {
    case sideBySide, overlay
}

extension AppState {
    /// M11: "Request changes (N)" shows only with notes to send (it can do nothing without), and only for the running
    /// chat's review (§39.2).
    public var showsRequestChanges: Bool { viewingChat == nil && !unsentNotes.isEmpty }
}
