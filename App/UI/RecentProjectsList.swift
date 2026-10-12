import SwiftUI
import ReviewGateCore

// MARK: wave4 w4-install
/// Audit daily-17: the empty window's "Recent" list. A folder that is gone is dimmed with "Not found" and never opened
/// (clicking it says why); every row has "Remove from Recent". Temporary / test folders never show (`RecentProjects`).
struct RecentProjectsList: View {
    @Environment(AppState.self) private var store
    @State private var entries: [RecentProjects.Entry] = []
    @State private var selected: URL?
    /// "<name> was not found …" after clicking a missing row.
    @State private var notice: String?

    var body: some View {
        Group {
            if !entries.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Recent").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    List(entries, id: \.url, selection: $selected) { entry in
                        row(entry)
                            .tag(entry.url)
                    }
                    .listStyle(.bordered)
                    .frame(width: 460, height: min(CGFloat(entries.count) * 44 + 8, 260))
                    .onDeleteCommand { if let selected { remove(selected) } }
                    .accessibilityIdentifier("Recent projects")
                    if let notice {
                        Label { Text(verbatim: notice) } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange) }
                            .font(.caption)
                            .frame(width: 460, alignment: .leading)
                            .accessibilityIdentifier("Recent not found notice")
                    }
                }
            }
        }
        .onAppear(perform: reload)
    }

    private func row(_ entry: RecentProjects.Entry) -> some View {
        let url = entry.url
        return HStack(spacing: 8) {
            Button {
                if entry.exists {
                    notice = nil
                    ProjectOpener.open(url, store: store)
                } else {
                    notice = String(localized: "\(url.lastPathComponent) was not found at \(url.path). Moved or deleted? Remove it from the list.")
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: entry.exists ? "folder" : "questionmark.folder").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(url.lastPathComponent).font(.callout)
                        Group {
                            if entry.exists {
                                Text(verbatim: url.path)
                            } else {
                                Text("Not found · \(url.path)")
                            }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
                .opacity(entry.exists ? 1 : 0.55)
            }
            .buttonStyle(.plain)
            .help(entry.exists ? url.path : String(localized: "Not found: \(url.path)"))
            .accessibilityLabel(entry.exists ? Text(verbatim: url.lastPathComponent) : Text("\(url.lastPathComponent), not found"))
            Button { remove(url) } label: { Image(systemName: "xmark.circle") }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("Remove from Recent")
                .accessibilityLabel(Text("Remove \(url.lastPathComponent) from Recent"))
                .accessibilityIdentifier("Remove recent \(url.lastPathComponent)")
        }
        .contextMenu {
            Button("Remove from Recent", role: .destructive) { remove(url) }
        }
        .accessibilityIdentifier("Recent \(url.lastPathComponent)")
    }

    private func reload() { entries = RecentProjects.entries() }

    private func remove(_ url: URL) {
        AppSettings.removeRecentProject(url)
        if selected == url { selected = nil }
        notice = nil
        reload()
    }
}

/// The project switcher's and File › Open Recent's rows for folders that are gone: a submenu that says so and removes them.
struct MissingRecentMenu: View {
    let url: URL
    var onRemove: () -> Void = {}

    var body: some View {
        Menu {
            Text("Not found: \(url.path)")
            Button("Remove from Recent") {
                AppSettings.removeRecentProject(url)
                onRemove()
            }
        } label: {
            Text("\(url.lastPathComponent) — not found")
        }
        .accessibilityIdentifier("Missing recent \(url.lastPathComponent)")
    }
}
