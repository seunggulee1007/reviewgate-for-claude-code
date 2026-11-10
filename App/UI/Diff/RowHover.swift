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

// MARK: polish p-foundation — P1-chrome-15 / P3-transcript-19: a clickable row, strip or chip (a plain button that is not an
// icon) answers the pointer with a faint wash, like the icon buttons (`IconButtonStyle`).
//
//   Button { open(row) } label: { RowLabel(row) }.buttonStyle(.plain).hoverHighlight()
//   chip.hoverHighlight(cornerRadius: 8)

extension View {
    /// A faint rounded wash while the pointer is over this view (none while disabled). The hover flag is the view's own.
    func hoverHighlight(cornerRadius: CGFloat = 5) -> some View {
        modifier(HoverHighlight(cornerRadius: cornerRadius))
    }
}

private struct HoverHighlight: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    let cornerRadius: CGFloat
    @State private var hovered = false

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: cornerRadius).fill(Color.primary.opacity(isEnabled && hovered ? 0.06 : 0)))
            .onHover { inside in
                if hovered != inside { hovered = inside }
            }
    }
}
