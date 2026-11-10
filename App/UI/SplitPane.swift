import SwiftUI
import AppKit
import ReviewGateCore

/// A horizontal two-pane split whose divider position is plain state (`fraction` = leading pane width / total), so it
/// can be persisted per project and restored (M15). `HSplitView` ignores ideal widths, hence this.
struct SplitPane<Leading: View, Trailing: View>: View {
    @Binding var fraction: Double
    var minLeading: CGFloat = 200
    var minTrailing: CGFloat = 200
    /// r1-composer M11: when the panes cannot both keep their minimum, the trailing one still keeps its own as long as the
    /// leading one keeps this much (nil: they share in proportion, as before) — the chat beside the diff in a laptop window.
    var leadingFloor: CGFloat? = nil
    /// The leading pane is gone and the trailing one takes the width — the trailing view stays the same view (its state,
    /// scroll position and focus survive opening and closing the leading pane).
    var collapsed = false
    /// Called when a drag ends with the settled fraction.
    var onCommit: (Double) -> Void = { _ in }
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    @State private var dragStartWidth: CGFloat?

    var body: some View {
        GeometryReader { geo in
            let total = geo.size.width
            let width = clampedWidth(fraction * total, total: total)
            HStack(spacing: 0) {
                if !collapsed {
                    leading()
                        .frame(width: width)
                        .clipped()
                }
                trailing()
                    .frame(width: collapsed ? total : max(total - width, 0))
                    .clipped()
            }
            .overlay(alignment: .leading) {
                if !collapsed {
                    divider(total: total)
                        .offset(x: width - 4)
                }
            }
        }
    }

    private func divider(total: CGFloat) -> some View {
        ZStack {
            Color.clear
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1)
        }
        .frame(width: 9)
        .contentShape(Rectangle())
        .onHover { inside in
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    let start = dragStartWidth ?? clampedWidth(fraction * total, total: total)
                    dragStartWidth = start
                    fraction = Double(clampedWidth(start + value.translation.width, total: total) / max(total, 1))
                }
                .onEnded { _ in
                    dragStartWidth = nil
                    onCommit(fraction)
                }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Split divider")
        .accessibilityIdentifier("Split divider")
    }

    /// Within the minimums; when the pane is narrower than both minimums together (agent panel open in a small
    /// window) the trailing one keeps its minimum while the leading one keeps `leadingFloor`, else the panes share it in
    /// proportion to their minimums instead of the trailing one being pushed out (Core `PaneSplit`).
    private func clampedWidth(_ width: CGFloat, total: CGFloat) -> CGFloat {
        CGFloat(PaneSplit.leadingWidth(Double(width), total: Double(total), minLeading: Double(minLeading),
                                       minTrailing: Double(minTrailing), leadingFloor: leadingFloor.map(Double.init)))
    }
}
