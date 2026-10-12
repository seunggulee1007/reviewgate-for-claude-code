import AppKit
import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the user's Claude Code mods in Settings › Extensions (read only). Their panes
// draw only in the terminal, so the section says so and opens the board, which shows the same things in the app.

/// "Mods": each mod's name, description, folder and whether this session loaded it.
struct ModsSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let mods: [UserMod]
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Mods").font(.subheadline.weight(.semibold))
                Text(verbatim: "\(mods.count)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 5).padding(.vertical, 0.5)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "rectangle.on.rectangle.slash").foregroundStyle(.secondary).accessibilityHidden(true)
                Text(CodeGraphText.modsNote)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                // This project window's board (§43.1), opened (or brought forward) — never closed, as its menu item would.
                let entry = WorkbenchRegistry.shared.entry(for: store)
                let canOpen = entry != nil && store.projectInfo != nil
                Button(String(localized: "Open the board")) { if let entry { BoardWindows.shared.show(entry, activate: true) } }
                    .controlSize(.small)
                    .disabled(!canOpen)
                    .help(canOpen ? String(localized: "Window › Board (⌥⌘B)") : String(localized: "No project open"))
                    .accessibilityIdentifier("Open the board from mods")
            }
            .padding(8)
            .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
            ForEach(mods.prefix(compact ? 5 : 50)) { mod in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: mod.loaded ? "puzzlepiece.extension.fill" : "puzzlepiece.extension")
                        .foregroundStyle(mod.loaded ? Color.green : Color.secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(verbatim: mod.name).font(.callout.weight(.medium))
                            if let version = mod.version { Text(verbatim: "v\(version)").font(.caption).foregroundStyle(.secondary) }
                        }
                        if !mod.description.isEmpty {
                            Text(verbatim: mod.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Text(verbatim: abbreviate(mod.path))
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                            .help(mod.path)
                        Text(CodeGraphText.modState(mod)).font(.caption).foregroundStyle(mod.loaded ? Color.green : Color.secondary)
                    }
                    Spacer(minLength: 4)
                    Button {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: mod.path)])
                    } label: {
                        Image(systemName: "folder")
                    }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .help(String(localized: "Show in Finder"))
                    .accessibilityLabel(Text("Show in Finder"))
                }
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Mods")
    }

    private func abbreviate(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
}
