import SwiftUI
import AppKit
import ReviewGateCore

/// wave2 mac-diff — find in diff (⌥⌘F; audit comp-19) for one diff / full-file list: the query, the rows that match it
/// and the current one. ⌘F stays the chat's find (`TranscriptFindBar`); this bar has no ⌘G of its own so the two never
/// fight over it — ↩ / ⇧↩ step through the matches.
@MainActor @Observable
final class DiffFindModel {
    var visible = false
    var query = ""
    private(set) var state = DiffFindState()
    /// Bumped to focus the field again (⌥⌘F while it is open).
    private(set) var focusTick = 0
    /// Bumped whenever the current match should be scrolled into view.
    private(set) var scrollTick = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    /// The text of each matching row (the current match's column for a list that does not wrap).
    @ObservationIgnored private var matchTexts: [String: String] = [:]

    /// The query the rows mark (empty while the bar is closed).
    var activeQuery: String { visible ? DiffFind.normalized(query) : "" }

    /// Where the current match starts in its row, in display columns.
    var currentColumn: Int? {
        guard let key = state.currentKey, let text = matchTexts[key] else { return nil }
        return DiffFind.column(of: query, in: text)
    }

    func open() {
        if visible { focusTick += 1 } else { visible = true }
    }

    func close() {
        task?.cancel()
        visible = false
        query = ""
        matchTexts = [:]
        state.update(matches: [])
    }

    /// Searches `rows` off the main thread (tens of ms for a 20 000-line diff), a moment after the typing stops, then
    /// brings the current match into view.
    func search(_ rows: [DiffFind.Row]) {
        task?.cancel()
        let q = query
        guard visible, !DiffFind.normalized(q).isEmpty else {
            state.update(matches: [])
            return
        }
        task = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            let found = await Task.detached(priority: .userInitiated) { () -> (keys: [String], texts: [String: String]) in
                let keys = DiffFind.matches(query: q, in: rows)
                let wanted = Set(keys)
                var texts: [String: String] = [:]
                for row in rows where wanted.contains(row.key) { texts[row.key] = row.text }
                return (keys, texts)
            }.value
            guard !Task.isCancelled, let self, self.query == q else { return }
            self.matchTexts = found.texts
            self.state.update(matches: found.keys)
            self.scrollTick += 1
        }
    }

    func next() {
        state.next()
        scrollTick += 1
    }

    func previous() {
        state.previous()
        scrollTick += 1
    }

    func isCurrent(_ key: String) -> Bool { visible && state.currentKey == key }

    /// Scrolls to the current match again (its row was folded until now).
    func rescroll() { scrollTick += 1 }
}

/// The find bar over a diff list: query, "3 / 17", previous / next (also ⇧↩ / ↩), close (Esc).
struct DiffFindBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var model: DiffFindModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find in diff", text: $model.query)
                .textFieldStyle(.plain)
                .focused($focused)
                .frame(minWidth: 120)
                .onSubmit {
                    if NSEvent.modifierFlags.contains(.shift) { model.previous() } else { model.next() }
                }
                .onExitCommand { model.close() }
                .accessibilityIdentifier("Find in diff field")
            Text(countText)
                .font(.caption.monospacedDigit())
                .foregroundStyle(model.state.total == 0 && !model.activeQuery.isEmpty ? Color.red : Color.secondary)
                .fixedSize()
                .accessibilityIdentifier("Find in diff count")
            Divider().frame(height: 14)
            Button { model.previous() } label: { Image(systemName: "chevron.up") }
                .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` made only the glyph a target
                .disabled(model.state.total == 0)
                .help("Previous match")
                .accessibilityLabel("Previous match")
            Button { model.next() } label: { Image(systemName: "chevron.down") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .disabled(model.state.total == 0)
                .help("Next match")
                .accessibilityLabel("Next match")
            Button { model.close() } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .foregroundStyle(.secondary)
                .help("Close (Esc)")
                .accessibilityLabel("Close find")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: 380)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.45 : 0.15), radius: 6, y: 2)
        .padding(8)
        .onAppear { focused = true }
        .onChange(of: model.focusTick) { _, _ in focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Diff find bar")
    }

    private var countText: String {
        if model.activeQuery.isEmpty { return "" }
        if model.state.total == 0 { return String(localized: "No matches") }
        return String(localized: "\((model.state.current ?? 0) + 1) of \(model.state.total)")
    }
}

extension View {
    /// The pane's find in diff: ⌥⌘F (`WindowModel.diffFindTick`) opens the bar over it, a changed query or changed rows
    /// (`rowsKey`) search again. Only the pane on screen has this modifier in the hierarchy, so only it answers the menu.
    /// A view that shares an open model with the one before it (the diff, its full file, its -w view) searches its rows as
    /// it appears.
    func diffFind(_ model: DiffFindModel, rows: @escaping () -> [DiffFind.Row], rowsKey: some Equatable, tick: Int) -> some View {
        self
            .overlay(alignment: .topTrailing) {
                if model.visible { DiffFindBar(model: model) }
            }
            .onChange(of: tick) { _, _ in model.open() }
            .onChange(of: model.query) { _, _ in model.search(rows()) }
            .onChange(of: rowsKey, initial: true) { _, _ in if model.visible { model.search(rows()) } }
    }
}
