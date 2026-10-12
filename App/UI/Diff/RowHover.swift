import SwiftUI

// MARK: wave4d w4d-speed — audit polish-09: hover is the row's own state. A list that keeps "the row under the pointer" in
// its own @State re-runs its whole body on every move (a 3 000-line diff, a review of hundreds of files: the plan, the
// ForEach over every row, the risk order); a row that keeps its own flag redraws itself and the row the pointer left.

/// `content(hovered)` with the row's own hover flag (the review diff, the PR diff, the changed files list).
struct HoverRow<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovered = false

    var body: some View {
        content(hovered)
            .onHover { inside in
                if hovered != inside { hovered = inside }
            }
    }
}
