import SwiftUI

/// `full` while its ideal width fits the width offered, else `compact` — what `ViewThatFits` did for two variants, minus
/// its rebuilding.
///
/// `ViewThatFits` builds the candidate it does not show again on every layout pass. With AppKit-backed controls inside
/// (a `Menu`'s NSPopUpButton, bordered buttons, a linear or spinning `ProgressView`) each pass made new NSViews whose
/// setup asked for another pass: the main thread spun at 100 % and memory grew by gigabytes until Force Quit (0.4.1–0.4.9,
/// the HUD with the permission-mode chip). Here each view is built once and keeps its identity: a hidden, disabled copy of
/// `full` (`measuring` true — drop popovers, keyboard shortcuts and anything else that must exist once: SwiftUI takes the
/// first shortcut it finds, and that can be this copy's, disabled) gives its ideal width, and the frame takes its width from
/// the parent only (minimum 0), so what is shown never changes what is measured.
struct FullOrCompact<Full: View, Compact: View>: View {
    @ViewBuilder var full: (_ measuring: Bool) -> Full
    @ViewBuilder var compact: () -> Compact
    @State private var fullWidth: CGFloat?
    @State private var width: CGFloat?

    var body: some View {
        Group {
            if let fullWidth, let width, fullWidth > width + 0.5 { compact() } else { full(false) }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(alignment: .topLeading) {
            full(true)
                .fixedSize()
                .hidden()
                .disabled(true)
                .allowsHitTesting(false)
                // No `.focusable(false)` here: on the permission card's copy it fought the card's own focus (`cardFocused`)
                // and the main thread spun at 100 % as soon as a card showed (found on the probe before a release).
                .accessibilityHidden(true)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { fullWidth = $0 }
        }
    }
}
