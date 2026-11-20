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
    /// Bumped whenever the current match — or the change Review › Next / Previous Change went to — should be scrolled into view.
    private(set) var scrollTick = 0
    /// The row the list scrolls to on `scrollTick` and its column (`DiffLinesList`): the current match, or a change block.
    private(set) var scrollKey: String?
    private(set) var scrollColumn: Int?
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
            self.scrollToMatch()
        }
    }

    func next() {
        state.next()
        scrollToMatch()
    }

    func previous() {
        state.previous()
        scrollToMatch()
    }

    func isCurrent(_ key: String) -> Bool { visible && state.currentKey == key }

    /// Scrolls to the current match again (its row was folded until now).
    func rescroll() { scrollToMatch() }

    private func scrollToMatch() {
        scrollKey = state.currentKey
        scrollColumn = currentColumn
        scrollTick += 1
    }

    // MARK: Review › Next Change / Previous Change (⌥⌘] / ⌥⌘[) — `DiffChangeNavigation` over the rows of the list on screen

    /// The change rows of the list on screen (the diff, its full file, its -w view), registered by its `diffFind`.
    @ObservationIgnored private var changeRows: (() -> [DiffChangeNavigation.Row])?
    @ObservationIgnored private var changeRowsOwner: UUID?
    /// Bumped when a list registers its rows: a file just entered from the one before / after it lands on its block.
    private(set) var changeRowsRevision = 0
    /// The block last gone to, and the file it is in (a cursor of another file is none).
    @ObservationIgnored private var changeCursor: (file: String, key: String)?
    /// The file just entered past the ends of the one before it, and the way it was entered.
    @ObservationIgnored private var changeLanding: (file: String, direction: DiffChangeNavigation.Direction)?

    func registerChangeRows(_ rows: @escaping () -> [DiffChangeNavigation.Row], owner: UUID) {
        changeRows = rows
        changeRowsOwner = owner
        changeRowsRevision += 1
    }

    func unregisterChangeRows(owner: UUID) {
        guard changeRowsOwner == owner else { return }   // another list of the pane registered since
        changeRows = nil
        changeRowsOwner = nil
    }

    /// Goes to the next / previous change block of `file`; false past its last / first one (or with no rows on screen).
    func stepChange(_ direction: DiffChangeNavigation.Direction, file: String) -> Bool {
        let cursor = changeCursor?.file == file ? changeCursor?.key : nil
        guard let key = DiffChangeNavigation.target(direction, from: cursor, in: changeRows?() ?? []) else { return false }
        scrollToChange(key, file: file)
        return true
    }

    /// `file` is about to be entered from the one before it (`.next`) or after it: its first / last block once its rows show.
    func landOnChange(in file: String, direction: DiffChangeNavigation.Direction) {
        changeLanding = (file, direction)
        changeCursor = nil
    }

    /// The rows of `file` registered: the landing waiting for it goes to its block. Another file drops it.
    func rowsShown(file: String?) {
        guard let landing = changeLanding else { return }
        guard landing.file == file, let file else {
            changeLanding = nil
            return
        }
        guard let rows = changeRows?() else { return }   // its rows are not on screen yet
        changeLanding = nil
        guard let key = DiffChangeNavigation.entry(landing.direction, in: rows) else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(100))   // the list has just been made: its rows first
            scrollToChange(key, file: file)
        }
    }

    private func scrollToChange(_ key: String, file: String) {
        changeCursor = (file, key)
        scrollKey = key
        scrollColumn = nil
        scrollTick += 1
    }
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
    /// `changes`: the list's rows for Review › Next / Previous Change (`diffChangeNavigation` on the pane steps through them).
    func diffFind<Key: Equatable>(_ model: DiffFindModel, rows: @escaping () -> [DiffFind.Row], rowsKey: Key, tick: Int,
                                  changes: (() -> [DiffChangeNavigation.Row])? = nil) -> some View {
        self
            .overlay(alignment: .topTrailing) {
                if model.visible { DiffFindBar(model: model) }
            }
            .onChange(of: tick) { _, _ in model.open() }
            .onChange(of: model.query) { _, _ in model.search(rows()) }
            .onChange(of: rowsKey, initial: true) { _, _ in if model.visible { model.search(rows()) } }
            .modifier(DiffChangeRowsRegistration(model: model, rows: changes, rowsKey: rowsKey))
    }

    /// Review › Next Change / Previous Change (⌥⌘] / ⌥⌘[) on this diff pane: the next / previous change block of the list on
    /// screen (registered by its `diffFind`), past its ends the first / last block of the next / previous file of `files` —
    /// `open` shows a file (its rows register when they show). At the list's ends it beeps. While it is on screen with a file
    /// the menu items are on (`WindowModel.changeNavigationPanes`).
    func diffChangeNavigation(_ find: DiffFindModel, file: String?, files: @escaping () -> [String],
                              open: @escaping (String) -> Void) -> some View {
        modifier(DiffChangeNavigator(find: find, file: file, files: files, open: open))
    }
}

/// A diff list's change rows, kept by the pane's find model while the list is on screen.
private struct DiffChangeRowsRegistration<Key: Equatable>: ViewModifier {
    let model: DiffFindModel
    /// nil: not a diff (the code browser's file).
    let rows: (() -> [DiffChangeNavigation.Row])?
    let rowsKey: Key
    @State private var owner = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: rowsKey, initial: true) { _, _ in if let rows { model.registerChangeRows(rows, owner: owner) } }
            .onDisappear { model.unregisterChangeRows(owner: owner) }
    }
}

private struct DiffChangeNavigator: ViewModifier {
    @Environment(WindowModel.self) private var model
    let find: DiffFindModel
    let file: String?
    let files: () -> [String]
    let open: (String) -> Void
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: model.nextChangeTick) { _, _ in go(.next) }
            .onChange(of: model.previousChangeTick) { _, _ in go(.previous) }
            .onChange(of: find.changeRowsRevision) { _, _ in find.rowsShown(file: file) }
            .onChange(of: file, initial: true) { _, file in
                if file == nil { model.changeNavigationPanes.remove(id) } else { model.changeNavigationPanes.insert(id) }
            }
            .onDisappear { model.changeNavigationPanes.remove(id) }
    }

    private func go(_ direction: DiffChangeNavigation.Direction) {
        guard let file else { return }
        if find.stepChange(direction, file: file) { return }
        guard let other = DiffChangeNavigation.neighbour(direction, of: file, in: files()) else {
            NSSound.beep()   // the last change of the last file (the first of the first)
            return
        }
        find.landOnChange(in: other, direction: direction)
        open(other)
    }
}
