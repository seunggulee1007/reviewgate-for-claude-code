import AppKit
import SwiftUI
import ReviewGateCore

/// MARK: wave6 w6-statusline — §44.2: the user's Claude Code status line (their `statusLine` command — the OMC HUD, …)
/// under the composer's buttons, drawn as the terminal draws it: monospaced, the ANSI colors and styles, OSC 8 links
/// that open in the browser, each line cut with "…" at the chat's width instead of wrapping. Shown only when there are
/// lines (`StatusLineMeter` measures and tells the engine either way). Electron's `StatusLine.tsx` sits in the same place.
struct StatusLineView: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    static let fontSize: CGFloat = 11
    /// One column of the status line's font (a terminal cell).
    @MainActor static let columnWidth: CGFloat = {
        let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        return max(1, ("0" as NSString).size(withAttributes: [.font: font]).width)
    }()

    private let font = Font.system(size: StatusLineView.fontSize, design: .monospaced)
    private let boldFont = Font.system(size: StatusLineView.fontSize, weight: .bold, design: .monospaced)

    var body: some View {
        let lines = store.statusLine.shownRuns
        let padding = store.statusLine.padding
        let columns = store.statusLine.columns
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, runs in
                Text(AnsiText.attributed(columns > 0 ? AnsiText.truncate(runs, columns: max(1, columns - 2 * padding)) : runs,
                                         dark: colorScheme == .dark, font: font, boldFont: boldFont, base: .secondary,
                                         background: Color(nsColor: .windowBackgroundColor)))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, CGFloat(padding) * Self.columnWidth)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .help(failureHelp)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "Claude Code status line"))
        .accessibilityValue(lines.map { $0.map(\.text).joined() }.joined(separator: "\n"))
        .accessibilityIdentifier("Claude Code status line")
    }

    /// A failed run keeps the last lines; the tooltip says why.
    private var failureHelp: String {
        guard let error = store.statusLine.reply?.error else { return "" }
        let why = error.code == "timeout" ? String(localized: "it did not answer in time") : error.message
        return String(localized: "The status line command failed: \(why). Showing its last output.")
    }
}

/// The chat's place for the status line: the lines when there are some, nothing otherwise (its own view, so a new line
/// redraws only this, never the whole chat).
struct StatusLineSlot: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if !store.statusLine.shownRuns.isEmpty { StatusLineView() }
    }
}

/// §44.2: measures the chat's width in terminal columns (the command's `COLUMNS`) and tells the engine with whether the
/// chat is on screen (the engine runs the command only then: not for a minimized, covered or hidden window, another
/// Space, or a chat that is gone) — an invisible background of the composer's button row, so a chat without a status
/// line keeps its layout.
struct StatusLineMeter: View {
    @Environment(AppState.self) private var store
    @State private var width: CGFloat = 0
    @State private var onScreen = false
    @State private var windowVisible = true

    private var columns: Int { width > 0 ? max(20, Int((width / StatusLineView.columnWidth).rounded(.down))) : 0 }
    private var visible: Bool { onScreen && windowVisible }

    var body: some View {
        Color.clear
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .background { WindowVisibility { windowVisible = $0 } }
            .onAppear { onScreen = true }
            .onDisappear {
                onScreen = false
                let columns = columns
                Task { await store.tellStatusLine(columns: columns, visible: false) }
            }
            // A new width settles first (a window being resized), then the engine hears it once.
            .task(id: "\(store.state.project?.path ?? "")|\(columns)|\(visible)") {
                guard columns > 0, store.state.project != nil else { return }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await store.tellStatusLine(columns: columns, visible: visible)
            }
            .accessibilityHidden(true)
    }
}

/// Reports whether the window holding it is visible on screen (`occlusionState`: not minimized, not fully covered, not
/// on another Space, the app not hidden).
private struct WindowVisibility: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> Reader {
        let view = Reader()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: Reader, context: Context) {
        nsView.onChange = onChange
    }

    final class Reader: NSView {
        var onChange: ((Bool) -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { return }
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            }
            report()
        }

        private func report() {
            let visible = window?.occlusionState.contains(.visible) ?? false
            DispatchQueue.main.async { [weak self] in self?.onChange?(visible) }   // never during a SwiftUI update
        }
    }
}
