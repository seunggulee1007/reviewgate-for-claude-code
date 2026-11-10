import SwiftUI
import AppKit
import ReviewGateCore

// wave2 mac-diff — how the code column of every diff / full-file row lays out its line (audit comp-07, market-06): wrapped
// ("줄바꿈", the default, remembered in the settings), or on one line with every row of the list sharing one horizontal
// offset — trackpad / Shift + wheel sideways over the list, or the bar along its bottom — so a long line is read
// whole instead of ending in "…". A line still cut (past `DiffLineText.renderLimit`) or wider than the pane gets its
// text as a tooltip. Used by the review diff, the full file, PR and history diffs.

/// The diff lists' line layout, read by each row's code column.
struct DiffCodeLayout: Equatable {
    var wrap = true
    /// Not wrapping: how far the code columns are scrolled right (points).
    var offset: CGFloat = 0
    /// Not wrapping: the visible width of the code column (points); a wider line gets a tooltip.
    var viewport: CGFloat = .infinity
}

private struct DiffCodeLayoutKey: EnvironmentKey {
    static let defaultValue = DiffCodeLayout()
}

extension EnvironmentValues {
    var diffCodeLayout: DiffCodeLayout {
        get { self[DiffCodeLayoutKey.self] }
        set { self[DiffCodeLayoutKey.self] = newValue }
    }
}

enum DiffCodeMetrics {
    /// `UserDefaults` key of "Wrap lines" (Bool, unset → on).
    static let wrapLinesKey = "diffWrapLines"
    /// One column of `DiffRow.font` (body, monospaced), for the horizontal scroll extent.
    @MainActor static let columnWidth: CGFloat = {
        let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        return max(1, ("0" as NSString).size(withAttributes: [.font: font]).width)
    }()
    /// Line number gutters + the +/− marker of a diff row (`DiffRow`).
    @MainActor static let diffGutter: CGFloat = (DiffRow.gutterWidth + 6) * 2 + 16
    /// One gutter + the marker (the full-file view).
    @MainActor static let fileGutter: CGFloat = DiffRow.gutterWidth + 6 + 16
}

// MARK: - The list

/// A diff / full-file list. Wrapping, rows grow to fit their line; not wrapping, the code column of every row scrolls
/// sideways together by `DiffCodeLayout.offset`, the line numbers staying put.
struct DiffLinesList<Content: View>: View {
    let wrap: Bool
    /// The widest line in columns (`DiffLineText.maxColumns`); 0 while unknown (no sideways scroll yet).
    let maxColumns: Int
    /// What sits left of the code column (points).
    let gutter: CGFloat
    /// A new value (another file / diff) scrolls back to the start of the lines.
    let resetKey: AnyHashable
    /// Find in diff: the row to bring into view, and a tick so the same row can be asked for again.
    var scrollTarget: String? = nil
    var scrollTick = 0
    /// Not wrapping: the column the target's match starts at, scrolled into view sideways too.
    var scrollColumn: Int? = nil
    @ViewBuilder let content: () -> Content

    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 0

    private var viewport: CGFloat { max(0, width - gutter) }
    private var extent: CGFloat { CGFloat(maxColumns) * DiffCodeMetrics.columnWidth + 24 }
    private var maxOffset: CGFloat { wrap ? 0 : max(0, extent - viewport) }
    private var shownOffset: CGFloat { min(offset, maxOffset) }

    var body: some View {
        ScrollViewReader { proxy in
            List { content() }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, 1)
                .environment(\.diffCodeLayout, DiffCodeLayout(wrap: wrap, offset: shownOffset, viewport: wrap ? .infinity : viewport))
                .onChange(of: scrollTick) { _, _ in
                    guard let scrollTarget else { return }
                    proxy.scrollTo(scrollTarget, anchor: .center)
                    revealColumn()
                }
        }
        .background {
            HorizontalScrollCatcher(enabled: maxOffset > 0) { dx in offset = min(max(0, shownOffset - dx), maxOffset) }
        }
        .overlay(alignment: .bottom) {
            if maxOffset > 0 {
                HorizontalScrollBar(offset: Binding(get: { shownOffset }, set: { offset = $0 }), maxOffset: maxOffset,
                                    viewport: viewport, extent: extent)
                    .padding(.leading, gutter).padding(.trailing, 16).padding(.bottom, 3)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: resetKey) { _, _ in offset = 0 }
        .onChange(of: wrap) { _, _ in offset = 0 }
    }

    /// The match's column outside the visible part of the lines: scroll sideways so it sits a third into the pane.
    private func revealColumn() {
        guard !wrap, maxOffset > 0, let scrollColumn else { return }
        let x = CGFloat(scrollColumn) * DiffCodeMetrics.columnWidth
        guard x < shownOffset || x > shownOffset + viewport - 48 else { return }
        offset = min(max(0, x - viewport / 3), maxOffset)
    }
}

/// Sideways scrolls over the list (trackpad, Shift + wheel) move the shared code offset; vertical ones go to the List.
private struct HorizontalScrollCatcher: NSViewRepresentable {
    var enabled: Bool
    var onScroll: (CGFloat) -> Void

    func makeNSView(context: Context) -> CatcherView { CatcherView() }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.enabled = enabled
        view.onScroll = onScroll
    }

    final class CatcherView: NSView {
        var enabled = false
        var onScroll: (CGFloat) -> Void = { _ in }
        private var monitor: Any?

        /// Never takes a click: the rows above it keep every mouse event but the sideways scroll.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                MainActor.assumeIsolated { self?.consume(event) == true } ? nil : event
            }
        }

        /// The event is a sideways scroll over this view (more horizontal than vertical): it moves the code instead.
        private func consume(_ event: NSEvent) -> Bool {
            guard enabled, let window, event.window === window, !isHiddenOrHasHiddenAncestor,
                  bounds.contains(convert(event.locationInWindow, from: nil)) else { return false }
            let dx = event.scrollingDeltaX, dy = event.scrollingDeltaY
            guard dx != 0, abs(dx) > abs(dy) else { return false }
            onScroll(event.hasPreciseScrollingDeltas ? dx : dx * 8)
            return true
        }
    }
}

/// The thumb of the shared sideways scroll, draggable.
private struct HorizontalScrollBar: View {
    @Binding var offset: CGFloat
    let maxOffset: CGFloat
    let viewport: CGFloat
    let extent: CGFloat
    @State private var dragStart: CGFloat?

    var body: some View {
        GeometryReader { geo in
            let track = geo.size.width
            let thumb = min(track, max(28, track * viewport / max(extent, 1)))
            let x = maxOffset > 0 ? (track - thumb) * offset / maxOffset : 0
            Capsule()
                .fill(Color.secondary.opacity(0.45))
                .frame(width: thumb, height: 6)
                .offset(x: x)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        let start = dragStart ?? offset
                        if dragStart == nil { dragStart = offset }
                        let perPoint = maxOffset / max(1, track - thumb)
                        offset = min(max(0, start + drag.translation.width * perPoint), maxOffset)
                    }
                    .onEnded { _ in dragStart = nil })
        }
        .frame(height: 8)
        .accessibilityHidden(true)   // a mouse affordance; "Wrap lines" shows every line without it
    }
}

// MARK: - The code column

/// The code column of a diff / full-file row: `styled` wrapped, or on one line at the list's shared offset; "…" after a
/// line cut at the render limit, and a tooltip when the line is cut or wider than the pane.
struct DiffCodeText: View {
    @Environment(\.diffCodeLayout) private var layout
    /// The whole line (the tooltip's text).
    let text: String
    /// The drawn part, styled (`DiffLineText.styled`).
    let styled: AttributedString
    /// Whitespace-only change (`DiffLine.wsOnly`): drawn faint.
    var faint = false

    var body: some View {
        let cut = DiffLineText.shown(text).cut
        Group {
            if layout.wrap {
                Text(display(cut: cut))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // minWidth 0: without it the frame never gets narrower than the one-line text, and a long line would
                // widen its whole row (and in a stack every row) instead of being clipped to the pane.
                Text(display(cut: cut))
                    .lineLimit(1)
                    .fixedSize()
                    .offset(x: -layout.offset)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .clipped()
            }
        }
        .opacity(faint ? 0.55 : 1)
        .helpIfPresent(tooltip(cut: cut))
    }

    private func display(cut: Bool) -> AttributedString {
        guard cut else { return styled }
        var out = styled
        var ellipsis = AttributedString("…")
        ellipsis.swiftUI.foregroundColor = .secondary
        out.append(ellipsis)
        return out
    }

    private func tooltip(cut: Bool) -> String? {
        if cut { return DiffLineText.tooltip(text) }
        guard !layout.wrap, layout.viewport.isFinite else { return nil }
        let width = CGFloat(DiffLineText.columns(text)) * DiffCodeMetrics.columnWidth
        return width > layout.viewport ? DiffLineText.tooltip(text) : nil
    }
}

extension View {
    /// `.help(text)` only when there is one (no empty tooltip).
    @ViewBuilder
    func helpIfPresent(_ text: String?) -> some View {
        if let text { help(text) } else { self }
    }
}

// MARK: - Header controls

/// "Wrap lines" (remembered) and "Find in diff" (⌥⌘F) for a diff header.
struct DiffLineOptions: View {
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    let onFind: () -> Void

    var body: some View {
        Toggle("Wrap lines", systemImage: "arrow.turn.down.left", isOn: $wrapLines)
            .toggleStyle(.button)
            .labelStyle(.iconOnly)
            .fixedSize()
            .help("Wrap long lines — turn off to keep each on one line and scroll sideways")
            .accessibilityLabel("Wrap lines")
            .accessibilityIdentifier("Wrap lines")
        Button("Find in diff", systemImage: "magnifyingglass", action: onFind)
            .labelStyle(.iconOnly)
            .fixedSize()
            .help("Find in diff (⌥⌘F)")
            .accessibilityLabel("Find in diff")
            .accessibilityIdentifier("Find in diff")
    }
}

/// Settings › General: the same "Wrap lines" as the diff headers.
struct DiffSettingsSection: View {
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true

    var body: some View {
        Section("Diff") {
            Toggle("Wrap lines", isOn: $wrapLines)
                .accessibilityIdentifier("Settings wrap lines")
            Text("Off: each line stays on one line and all lines of a diff scroll sideways together (trackpad, or Shift + scroll wheel).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Copy (comp-19)

/// "Copy line" / "Copy path:line" for a row's context menu, after "Copy selected lines" on a row of a several-line pick.
struct DiffLineCopyMenuItems: View {
    let line: DiffLine
    /// The file's repo-relative path; nil: no "path:line" (a deleted row of the full file).
    let path: String?
    /// The row is part of a pick of several lines (`DiffLineSelection`): copies them all.
    var copySelected: (() -> Void)? = nil

    var body: some View {
        if let copySelected {
            Button("Copy selected lines", systemImage: "doc.on.doc.fill") { copySelected() }
        }
        Button("Copy line", systemImage: "doc.on.doc") { Self.copy(DiffLineText.copyLine(line)) }
        if let path, let location = DiffLineText.copyLocation(line, path: path) {
            Button("Copy path:line", systemImage: "link") { Self.copy(location) }
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - Picking lines (user report: "복붙도 안되고")

// A diff's rows are List rows, so their text cannot be selected across lines; instead a click picks a line, ⇧-click or a
// drag over the rows picks the lines between (`DiffLineSelection`), drawn tinted, and ⌘C or "Copy selected lines" copies
// their code. Used by the review diff, its full file, history and live diffs.

extension View {
    /// Click (⇧-click extends) and drag pick lines: `select(extend)` for this row on the mouse-down, `dragTo(row)` with the
    /// index of the List row under the pointer as a drag moves to another row.
    func diffLinePicking(select: @escaping (Bool) -> Void, dragTo: @escaping (Int) -> Void) -> some View {
        modifier(DiffLinePicking(select: select, dragTo: dragTo))
    }

    /// ⌘C copies the picked lines (`copy()`, nil when there are none) while the last click in the window was on them
    /// (`revision` changes with each, `DiffLineSelection.revision`); any other click or key hands ⌘C back to the focused
    /// control (a note's text, the composer, the find field).
    func diffLineCopying(revision: Int, copy: @escaping () -> String?) -> some View {
        background { DiffLinesCopyCatcher(revision: revision, copy: copy) }
    }
}

/// One gesture for the click and the drag, so the pick lands on the mouse-down (as a list's selection does) and a drag
/// never ends in a click that would undo it.
private struct DiffLinePicking: ViewModifier {
    let select: (Bool) -> Void
    let dragTo: (Int) -> Void
    @State private var dragging = false
    @State private var lastRow: Int?

    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    if !dragging {
                        dragging = true
                        lastRow = nil
                        DiffRowDrag.begin()
                        select((NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags).contains(.shift))
                    } else if abs(drag.translation.height) > 2, let row = DiffRowDrag.rowUnderPointer(), row != lastRow {
                        lastRow = row   // one pick per row reached, not one per mouse move
                        dragTo(row)
                    }
                }
                .onEnded { _ in
                    dragging = false
                    DiffRowDrag.end()
                })
    }
}

/// The List row under the pointer during a drag. SwiftUI's List on macOS is an `NSTableView` with one row per item of
/// these lists (the plan's items, the full file's rows), so its row index is the item's. The table is the one under the
/// pointer when the drag starts; past its top or bottom the edge row is meant, and the list scrolls on. Nil without a
/// table (another List implementation): the drag then picks nothing more than its first row.
@MainActor
enum DiffRowDrag {
    private static weak var table: NSTableView?

    static func begin() {
        table = nil
        guard let window = NSApp.currentEvent?.window ?? NSApp.keyWindow else { return }
        var view = window.contentView?.hitTest(pointer(in: window))
        while let current = view, table == nil {
            table = current as? NSTableView
            view = current.superview
        }
    }

    static func rowUnderPointer() -> Int? {
        guard let table, let window = table.window else { return nil }
        if let event = NSApp.currentEvent, event.type == .leftMouseDragged, event.window === window { table.autoscroll(with: event) }
        let visible = table.visibleRect
        guard visible.height > 2 else { return nil }
        var point = table.convert(pointer(in: window), from: nil)
        point.y = min(max(point.y, visible.minY + 1), visible.maxY - 1)
        let row = table.row(at: point)
        return row >= 0 ? row : nil
    }

    static func end() { table = nil }

    /// The pointer in `window`: where the mouse event being handled happened, else where the mouse is now.
    private static func pointer(in window: NSWindow) -> NSPoint {
        if let event = NSApp.currentEvent, event.window === window,
           [.leftMouseDown, .leftMouseDragged, .leftMouseUp].contains(event.type) {
            return event.locationInWindow
        }
        return window.mouseLocationOutsideOfEventStream
    }
}

/// See `diffLineCopying`. It watches the window's clicks and keys (never taking a click itself); a new `revision` arms it.
private struct DiffLinesCopyCatcher: NSViewRepresentable {
    var revision: Int
    var copy: () -> String?

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.revision = revision   // a list drawn again with an older pick is not armed by it
        return view
    }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.copy = copy
        if view.revision != revision {
            view.revision = revision
            view.armed = true
        }
    }

    final class CatcherView: NSView {
        var revision = 0
        var armed = false
        var copy: () -> String? = { nil }
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            armed = false
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
                MainActor.assumeIsolated { self?.consume(event) == true } ? nil : event
            }
        }

        /// A click anywhere disarms (a click on the rows arms again through `revision`); ⌘C while armed copies the lines.
        private func consume(_ event: NSEvent) -> Bool {
            guard let window, event.window === window else { return false }
            guard event.type == .keyDown, Self.isCopy(event) else {
                armed = false
                return false
            }
            guard armed, !isHiddenOrHasHiddenAncestor, let text = copy(), !text.isEmpty else { return false }
            DiffLineCopyMenuItems.copy(text)
            return true
        }

        /// ⌘C — also with a Korean input source, where the key reads "ㅊ".
        private static func isCopy(_ event: NSEvent) -> Bool {
            guard event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command else { return false }
            let chars = (event.charactersIgnoringModifiers ?? "").lowercased()   // caps lock
            return chars == "c" || (event.keyCode == 8 && !(chars.first?.isASCII ?? false))
        }
    }
}
