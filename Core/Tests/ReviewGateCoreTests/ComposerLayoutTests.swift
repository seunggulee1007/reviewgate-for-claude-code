import Foundation
import Testing
@testable import ReviewGateCore

/// r1-composer M11 (docs/PROTOCOL.md §49.2): Send stays in the window at the user's 1000 × 637 — the composer's secondary
/// controls fold before the send button is pushed out, the split keeps the chat 380 pt wide, and "Request changes (N)"
/// shows only with notes to send.
@Suite @MainActor struct ComposerLayoutTests {
    @Test func theSecondaryControlsFoldBeforeTheSendButtonIsPushedOut() {
        // The report: a 311 pt chat (287 pt for the row) with Accept 2 & Send, the model and the mode (~260 pt) and Send.
        #expect(ComposerBarFit.compact(rowWidth: 287, secondary: 260, trailing: 70))
        // While Claude works Stop sits there too.
        #expect(ComposerBarFit.compact(rowWidth: 356, secondary: 260, trailing: 70 + 64))
        // The chat beside a closed diff pane has room for all of it.
        #expect(!ComposerBarFit.compact(rowWidth: 952, secondary: 380, trailing: 70 + 64))
        // At the edge: the hint keeps its 60 pt.
        let edge = 260.0 + 70 + ComposerBarFit.minStatus + 3 * ComposerBarFit.spacing
        #expect(!ComposerBarFit.compact(rowWidth: edge, secondary: 260, trailing: 70))
        #expect(ComposerBarFit.compact(rowWidth: edge - 1, secondary: 260, trailing: 70))
        // Not measured yet: drawn as it is.
        #expect(!ComposerBarFit.compact(rowWidth: 0, secondary: 260, trailing: 70))
        #expect(!ComposerBarFit.compact(rowWidth: 287, secondary: 0, trailing: 70))
    }

    @Test func theChatKeepsItsMinimumBesideTheDiffInALaptopWindow() {
        // 1000 pt window, 300 pt sidebar: 677 pt for the diff and the chat. The chat keeps 380, the diff gets the rest.
        let diff = PaneSplit.leadingWidth(338, total: 677, minLeading: 420, minTrailing: 380, leadingFloor: 240)
        #expect(diff == 297 && 677 - diff == 380)
        // Without a floor (or below it) the two share the room in proportion, as before.
        #expect(PaneSplit.leadingWidth(338, total: 677, minLeading: 420, minTrailing: 360) == 365)
        #expect(PaneSplit.leadingWidth(278, total: 557, minLeading: 420, minTrailing: 380, leadingFloor: 240) == 292)
        // A wide window: the divider where the user put it, within the minimums.
        #expect(PaneSplit.leadingWidth(558, total: 1117, minLeading: 420, minTrailing: 380, leadingFloor: 240) == 558)
        #expect(PaneSplit.leadingWidth(900, total: 1117, minLeading: 420, minTrailing: 380, leadingFloor: 240) == 737)
        #expect(PaneSplit.leadingWidth(100, total: 1117, minLeading: 420, minTrailing: 380, leadingFloor: 240) == 420)
    }

    @Test func requestChangesShowsOnlyWithNotesToSend() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ComposerLayoutTests.\(UUID().uuidString)")!)
        func review(_ notes: [ReviewNote]) -> ReviewState {
            var s = ReviewState.empty
            s.seq = notes.count + 1
            s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
            s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
            s.gate = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: notes.contains { $0.sent == nil }, blockedReason: nil,
                              collectError: nil, pendingCount: 2, changesRequestedCount: 0, isRequestingChanges: false,
                              turnStartTree: "A", turnEndTree: "B", lastReviewSummary: nil)
            s.reviewNotes = notes
            return s
        }
        let sent = ReviewNote(id: "n1", path: "src/cart.ts", line: 3, side: .new, excerpt: "x", body: "rename",
                              sent: NoteSent(at: "2026-11-06T00:00:00Z", turn: 1))
        app.handle(.state(review([])))
        #expect(!app.showsRequestChanges)   // files pending, no note: nothing to send
        app.handle(.state(review([sent])))
        #expect(!app.showsRequestChanges)   // a note already sent is never sent again
        app.handle(.state(review([sent, ReviewNote(id: "n2", path: "src/cart.ts", line: 9, side: .new, excerpt: "y", body: "a test")])))
        #expect(app.showsRequestChanges && app.unsentNotes.count == 1)
    }
}
