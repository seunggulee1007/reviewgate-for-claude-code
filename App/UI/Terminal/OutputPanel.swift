import AppKit
import ReviewGateCore
import SwiftUI

// MARK: c-panel (§57.18)
/// The bottom panel's 출력 tab: the window's output (`AppState.output`, ≤ 5 000 lines) — read-only, selectable,
/// following new lines while it is scrolled to the end; the source filter, search, Copy and Clear sit in the panel's bar.
enum OutputFilter: String, CaseIterable {
    case all, reviewGate, claude

    var sources: Set<OutputSource> {
        switch self {
        case .all: [.reviewGate, .claude]
        case .reviewGate: [.reviewGate]
        case .claude: [.claude]
        }
    }

    var title: String {
        switch self {
        case .all: String(localized: "All")
        case .reviewGate: "ReviewGate"
        case .claude: String(localized: "Claude commands")
        }
    }

    var help: String {
        switch self {
        case .all: String(localized: "Every line")
        case .reviewGate: String(localized: "ReviewGate's own log — the engine, notices and errors")
        case .claude: String(localized: "The Bash commands Claude ran in this window and their output")
        }
    }
}

/// The output tab's controls in the panel's bar: source, search, Copy, Clear.
struct OutputPanelControls: View {
    @Environment(AppState.self) private var store
    @AppStorage("outputPanelFilter") private var filter = OutputFilter.all
    @Binding var query: String

    var body: some View {
        let shown = store.output.filtered(sources: filter.sources, query: query)
        HStack(spacing: 6) {
            Picker("Source", selection: $filter) {
                ForEach(OutputFilter.allCases, id: \.self) { f in Text(verbatim: f.title).help(f.help).tag(f) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .help(String(localized: "Which lines to show: \(filter.help)"))
            .accessibilityLabel(Text("Output source"))
            .accessibilityIdentifier("Output source")
            TextField("Search output", text: $query)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
                .frame(width: 160)
                .help(String(localized: "Show only the lines holding this text"))
                .accessibilityIdentifier("Output search")
            Button { copy(shown) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.icon).controlSize(.small)
                .disabled(shown.isEmpty)
                .help(shown.isEmpty ? String(localized: "Nothing to copy") : String(localized: "Copy the lines shown"))
                .accessibilityLabel(Text("Copy output"))
                .accessibilityIdentifier("Output copy")
            Button { store.clearOutput() } label: { Image(systemName: "trash") }
                .buttonStyle(.icon).controlSize(.small)
                .disabled(store.output.lines.isEmpty)
                .help(store.output.lines.isEmpty ? String(localized: "The output is empty") : String(localized: "Clear the output — the daily log file keeps its lines"))
                .accessibilityLabel(Text("Clear output"))
                .accessibilityIdentifier("Output clear")
        }
    }

    private func copy(_ lines: [OutputLine]) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(OutputLog.text(lines), forType: .string)
    }
}

/// The output lines.
struct OutputPanelView: View {
    @Environment(AppState.self) private var store
    @AppStorage("outputPanelFilter") private var filter = OutputFilter.all
    let query: String

    var body: some View {
        let shown = store.output.filtered(sources: filter.sources, query: query)
        OutputTextView(lines: shown)
            .overlay {
                if shown.isEmpty {
                    Text(store.output.lines.isEmpty ? String(localized: "No output yet — ReviewGate's log and the Bash commands Claude runs show here.")
                                                    : String(localized: "No line matches."))
                        .font(.callout).foregroundStyle(.secondary)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityIdentifier("Output panel")
    }
}

/// A read-only, selectable text view of the lines; new lines at the end are appended (not the whole text again), and it
/// follows them while it is scrolled to the bottom.
private struct OutputTextView: NSViewRepresentable {
    let lines: [OutputLine]

    final class Coordinator {
        var firstId: Int?
        var lastId: Int?
        var count = 0
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        if let text = scroll.documentView as? NSTextView {
            text.isEditable = false
            text.isSelectable = true
            text.isRichText = false
            text.drawsBackground = false
            text.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
            text.textColor = .labelColor
            text.textContainerInset = NSSize(width: 6, height: 4)
            text.setAccessibilityLabel(String(localized: "panel.output", defaultValue: "Output"))
        }
        scroll.drawsBackground = false
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let text = scroll.documentView as? NSTextView, let storage = text.textStorage else { return }
        let c = context.coordinator
        let atEnd = scroll.contentView.bounds.maxY >= (scroll.documentView?.bounds.maxY ?? 0) - 4
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ]
        // Only new lines at the end (same first line, the old last line still there): append them.
        if let first = c.firstId, let last = c.lastId, lines.first?.id == first, lines.count > c.count,
           lines[c.count - 1].id == last {
            let added = lines[c.count...].map(\.text).joined(separator: "\n")
            storage.append(NSAttributedString(string: "\n" + added, attributes: attributes))
        } else if lines.count != c.count || lines.first?.id != c.firstId || lines.last?.id != c.lastId {
            storage.setAttributedString(NSAttributedString(string: OutputLog.text(lines), attributes: attributes))
        } else {
            return
        }
        c.firstId = lines.first?.id
        c.lastId = lines.last?.id
        c.count = lines.count
        if atEnd { text.scrollToEndOfDocument(nil) }
    }
}
