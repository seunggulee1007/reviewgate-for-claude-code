import AppKit
import SwiftUI
import ReviewGateCore

// MARK: §70.1 — docs/PROTOCOL.md §70.1: ⌃R in the message box searches this project's prompts, as Ctrl+R in Claude Code.
// The bar over the box: a field (focused; an input method's composition keeps its own keys), the match with the typed text
// highlighted, "2 / 5" and the keys. ⌃R / ↑ older, ↓ newer, ↩ / ⇥ into the box, esc / ⌫ in an empty field / ⌃C cancel.

extension ComposerModel {
    /// ⌃R: the search starts over the draft (what esc gives back).
    func startHistorySearch(entries: [String]) {
        historySearch = PromptHistorySearch(entries: entries, original: draft)
    }

    /// ↩ / ⇥: the match goes into the box (the draft stays when nothing matched); the box gets the focus back.
    func acceptHistorySearch() {
        guard let search = historySearch else { return }
        historySearch = nil
        let text = search.accepted
        if text != draft {
            draft = text
            history.reset(entries: search.entries)   // a recalled prompt starts a fresh ↑ walk
        }
        caretRequest = (text as NSString).length
        inputFocused = true
    }

    /// esc: the draft as it was.
    func cancelHistorySearch() {
        guard historySearch != nil else { return }
        historySearch = nil
        inputFocused = true
    }
}

/// The search bar (only while `composer.historySearch` is set).
struct ComposerHistorySearchBar: View {
    let composer: ComposerModel

    var body: some View {
        if let search = composer.historySearch {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary).font(.caption)
                        .accessibilityHidden(true)
                    HistorySearchField(composer: composer)
                        .frame(height: 20)
                        .accessibilityLabel(Text(PromptHistorySearchText.label))
                        .accessibilityIdentifier("Prompt history search field")
                    if let position = search.position {
                        Text(verbatim: PromptHistorySearchText.position(position.index, of: position.count))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            .accessibilityIdentifier("Prompt history search position")
                    }
                    Button { composer.cancelHistorySearch() } label: { Image(systemName: "xmark").font(.caption2.weight(.semibold)) }
                        .buttonStyle(.icon)
                        .help(String(localized: "Close the search — your draft stays (esc)"))
                        .accessibilityLabel(Text("Close the search"))
                }
                matchLine(search)
                Text(verbatim: PromptHistorySearchText.hint)
                    .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor.opacity(0.5)))
            .help(PromptHistorySearchText.help)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Prompt history search")
        }
    }

    @ViewBuilder
    private func matchLine(_ search: PromptHistorySearch) -> some View {
        if let match = search.match {
            Text(highlighted(match, query: search.query))
                .font(.callout)
                .lineLimit(3)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("Prompt history search match")
        } else {
            Text(search.entries.isEmpty ? PromptHistorySearchText.empty
                 : search.failing ? PromptHistorySearchText.noMatch : PromptHistorySearchText.typeToSearch)
                .font(.callout)
                .foregroundStyle(search.failing ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .accessibilityIdentifier("Prompt history search status")
        }
    }

    /// The match with the typed part in bold on the accent tint.
    private func highlighted(_ text: String, query: String) -> AttributedString {
        var out = AttributedString(text)
        guard let range = PromptHistorySearch.highlight(in: text, query: query),
              let lower = AttributedString.Index(range.lowerBound, within: out),
              let upper = AttributedString.Index(range.upperBound, within: out) else { return out }
        out[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        out[lower..<upper].backgroundColor = Color.accentColor.opacity(0.25)
        return out
    }
}

/// The search field: an `NSTextField` so ↑ ↓ ↩ ⇥ esc ⌫ reach the search through the field editor's commands (an input
/// method's composition keeps them), and ⌃R / ⌃C through a key monitor while the field edits.
private struct HistorySearchField: NSViewRepresentable {
    let composer: ComposerModel

    func makeCoordinator() -> Coordinator { Coordinator(composer: composer) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: NSFont.systemFontSize)
        field.placeholderString = PromptHistorySearchText.placeholder
        field.delegate = context.coordinator
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.setAccessibilityLabel(PromptHistorySearchText.label)
        context.coordinator.field = field
        context.coordinator.installMonitor()
        DispatchQueue.main.async { field.window?.makeFirstResponder(field) }
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        let query = composer.historySearch?.query ?? ""
        guard field.stringValue != query, field.currentEditor()?.hasMarkedTextSafely != true else { return }
        field.stringValue = query
        // A text set from outside (a search started over) leaves the caret at its end, not the whole text selected.
        field.currentEditor()?.selectedRange = NSRange(location: (query as NSString).length, length: 0)
    }

    static func dismantleNSView(_ field: NSTextField, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        let composer: ComposerModel
        weak var field: NSTextField?
        private var monitor: Any?

        init(composer: ComposerModel) { self.composer = composer }

        func controlTextDidChange(_ note: Notification) {
            guard let field else { return }
            composer.historySearch?.setQuery(field.stringValue)
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveUp(_:)): composer.historySearch?.older(); return true
            case #selector(NSResponder.moveDown(_:)): composer.historySearch?.newer(); return true
            case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertTab(_:)):
                composer.acceptHistorySearch(); return true
            case #selector(NSResponder.cancelOperation(_:)): composer.cancelHistorySearch(); return true
            case #selector(NSResponder.deleteBackward(_:)):
                guard textView.string.isEmpty else { return false }
                composer.cancelHistorySearch(); return true   // ⌫ in an empty search, as in the terminal
            default: return false
            }
        }

        /// ⌃R (older) and ⌃C (cancel) while this field edits — the field editor has no command for either.
        func installMonitor() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                MainActor.assumeIsolated { self?.consume(event) == true } ? nil : event
            }
        }

        private func consume(_ event: NSEvent) -> Bool {
            guard let field, let editor = field.currentEditor(), field.window?.firstResponder === editor,
                  event.modifierFlags.intersection([.command, .control, .option, .shift]) == .control,
                  !editor.hasMarkedTextSafely else { return false }
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "r": composer.historySearch?.older(); return true
            case "c": composer.cancelHistorySearch(); return true
            default: return false
            }
        }

        func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}

private extension NSText {
    /// The field editor is a text view; anything else has no composition.
    var hasMarkedTextSafely: Bool { (self as? NSTextView)?.hasMarkedText() ?? false }
}
