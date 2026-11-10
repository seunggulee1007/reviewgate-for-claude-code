import SwiftUI

/// ⌘F over the transcript: query, "3 of 12", previous / next (⇧⌘G / ⌘G, also ⇧↩ / ↩), close (Esc).
struct TranscriptFindBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var query: String
    let current: Int?
    let total: Int
    /// Bumped by the owner to focus the field again (⌘F while the bar is open).
    let focusTick: Int
    var onNext: () -> Void = {}
    var onPrevious: () -> Void = {}
    var onClose: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find in chat", text: $query)
                .textFieldStyle(.plain)
                .focused($focused)
                .frame(minWidth: 120)
                .onSubmit {
                    if NSEvent.modifierFlags.contains(.shift) { onPrevious() } else { onNext() }
                }
                .onExitCommand(perform: onClose)
                .accessibilityIdentifier("Find in chat")
            Text(countText)
                .font(.caption.monospacedDigit())
                .foregroundStyle(total == 0 && !query.isEmpty ? Color.red : Color.secondary)
                .fixedSize()
                .accessibilityIdentifier("Find count")
            Divider().frame(height: 14)
            // The glyphs are the targets' middles, not the targets (`.borderless` left them alone).
            Button(action: onPrevious) { Image(systemName: "chevron.up") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(total == 0)
                .help("Previous match (⇧⌘G)")
                .accessibilityLabel("Previous match")
            Button(action: onNext) { Image(systemName: "chevron.down") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .keyboardShortcut("g", modifiers: .command)
                .disabled(total == 0)
                .help("Next match (⌘G)")
                .accessibilityLabel("Next match")
            Button(action: onClose) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .foregroundStyle(.secondary)
                .help("Close (Esc)")
                .accessibilityLabel("Close find")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: 420)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.45 : 0.15), radius: 6, y: 2)
        .onAppear { focused = true }
        .onChange(of: focusTick) { _, _ in focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Find bar")
    }

    private var countText: String {
        if query.trimmingCharacters(in: .whitespaces).isEmpty { return "" }
        if total == 0 { return String(localized: "No matches") }
        return String(localized: "\((current ?? 0) + 1) of \(total)")
    }
}

/// `text` with every occurrence of `query` marked (case-insensitive) — user and streaming rows of a search.
func highlighted(_ text: String, query: String, isCurrent: Bool) -> AttributedString {
    var attributed = AttributedString(text)
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return attributed }
    var searchStart = text.startIndex
    while let range = text.range(of: q, options: [.caseInsensitive, .diacriticInsensitive], range: searchStart..<text.endIndex) {
        if let lower = AttributedString.Index(range.lowerBound, within: attributed),
           let upper = AttributedString.Index(range.upperBound, within: attributed) {
            attributed[lower..<upper].backgroundColor = Color.yellow.opacity(isCurrent ? 0.85 : 0.45)
            attributed[lower..<upper].foregroundColor = Color.black
        }
        searchStart = range.upperBound
    }
    return attributed
}
