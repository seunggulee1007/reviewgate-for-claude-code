import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-windows — audit polish-08: Help › Keyboard Shortcuts — the table of docs/SHORTCUTS.md (Core
// `ShortcutTable`), the Mac's keys next to Windows' so the same habit works in both apps. The Windows client's Help menu
// shows the same table. polish p-lifecycle (P1-chrome-10): a search field on top (focused when the window opens, ⌘F)
// narrows it — Core `ShortcutTable.filtered`; Esc empties the field, then closes the window.

/// The window's id (`ReviewGateApp`'s `Window` scene).
let keyboardShortcutsWindowID = "keyboard-shortcuts"

struct ShortcutsView: View {
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var query: String
    @FocusState private var searchFocused: Bool

    /// `query`: the words the search starts with (the screenshot tour's).
    init(query: String = "") {
        _query = State(initialValue: query)
    }

    var body: some View {
        let shown = ShortcutTable.filtered(query) { Bundle.main.localizedString(forKey: $0, value: $0, table: nil) }
        VStack(spacing: 0) {
            TextField("Search shortcuts", text: $query)
                .textFieldStyle(.roundedBorder)
                .focused($searchFocused)
                .help(String.withKey(String(localized: "Search shortcuts"), key: "⌘F"))
                .accessibilityIdentifier("Shortcut search")
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 8)
            // ⌘F from anywhere in the window.
            Button { searchFocused = true } label: { EmptyView() }
                .keyboardShortcut("f", modifiers: .command)
                .buttonStyle(.plain)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("The same keys do the same thing in the Mac and Windows apps — on Windows ⌘ is Ctrl and ⌥ is Alt.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if shown.isEmpty {
                        Text("No shortcuts match “\(query.trimmingCharacters(in: .whitespaces))”")
                            .font(.callout).foregroundStyle(.secondary)
                            .accessibilityIdentifier("No shortcut matches")
                    }
                    ForEach(shown) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(LocalizedStringKey(section.title)).font(.headline)
                            if let note = section.note {
                                Text(LocalizedStringKey(note)).font(.caption).foregroundStyle(.secondary)
                            }
                            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                                GridRow {
                                    Text("Action")
                                    Text(verbatim: "Mac")
                                    Text(verbatim: "Windows")
                                    Text("Remarks")
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                Divider().gridCellUnsizedAxes(.horizontal)
                                ForEach(section.rows) { row in
                                    GridRow {
                                        Text(LocalizedStringKey(row.action))
                                        Text(verbatim: row.mac).font(.body.monospaced()).fontWeight(.semibold)
                                        Text(verbatim: row.windows).font(.body.monospaced()).foregroundStyle(.secondary)
                                        Text(row.note.map { LocalizedStringKey($0) } ?? "").font(.caption).foregroundStyle(.secondary)
                                    }
                                    .accessibilityElement(children: .combine)
                                }
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(Text(LocalizedStringKey(section.title)))
                    }
                }
                .padding(.horizontal, 20).padding(.bottom, 20).padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 420, idealHeight: 640)
        .onAppear { searchFocused = true }
        // Esc: the field's words go first, then the window.
        .onExitCommand {
            if query.isEmpty { dismissWindow(id: keyboardShortcutsWindowID) } else { query = "" }
        }
        .accessibilityIdentifier("Keyboard shortcuts")
    }
}
