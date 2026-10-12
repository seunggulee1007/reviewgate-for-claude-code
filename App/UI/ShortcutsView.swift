import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-windows — audit polish-08: Help › Keyboard Shortcuts — the table of docs/SHORTCUTS.md (Core
// `ShortcutTable`), the Mac's keys next to Windows' so the same habit works in both apps. The Windows client's Help menu
// shows the same table.

/// The window's id (`ReviewGateApp`'s `Window` scene).
let keyboardShortcutsWindowID = "keyboard-shortcuts"

struct ShortcutsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("The same keys do the same thing in the Mac and Windows apps — on Windows ⌘ is Ctrl and ⌥ is Alt.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(ShortcutTable.sections) { section in
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
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 420, idealHeight: 640)
        .accessibilityIdentifier("Keyboard shortcuts")
    }
}

/// Help › Keyboard Shortcuts (after the app's own help items).
struct ShortcutHelpCommands: Commands {
    let openWindow: OpenWindowAction

    var body: some Commands {
        CommandGroup(before: .help) {
            Button("Keyboard Shortcuts") { openWindow(id: keyboardShortcutsWindowID) }
                .accessibilityIdentifier("Help menu Keyboard shortcuts")
            Divider()
        }
    }
}
