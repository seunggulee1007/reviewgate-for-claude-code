import SwiftUI
import ReviewGateCore

// MARK: code-browser — docs/PROTOCOL.md §47: Go to File (⌘P). The fuzzy file search of the composer's @-mentions
// (`list_files`, §23: tracked + untracked files git does not ignore) without the folders; ↑ / ↓ move, ↩ opens the file
// read-only in the diff pane, Esc closes. `Name.java:120` opens at line 120. Empty, it lists the files opened lately and
// then the review's files.

struct QuickOpenSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var items: [FileItem] = []
    @State private var selected = 0
    @State private var loading = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Go to file", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .onSubmit { openSelected() }
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onExitCommand { dismiss() }
                    .accessibilityIdentifier("Go to file field")
                if loading { ProgressView().controlSize(.small) }
            }
            .padding(12)
            Divider()
            results
            Divider()
            Text("↑ ↓ to move · ↩ to open · Esc to close · Name.java:120 opens at a line")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .frame(width: 640, height: 440)
        .onAppear { focused = true }
        .task(id: query) {
            // A moment after the typing stops; the index is cached in the engine, so each query is one quick read.
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(60)) }
            guard !Task.isCancelled else { return }
            loading = true
            let found = await candidates(CodeBrowserText.goToFileQuery(query).name)
            guard !Task.isCancelled else { return }
            loading = false
            items = found
            selected = 0
        }
        .accessibilityIdentifier("Go to file")
    }

    @ViewBuilder
    private var results: some View {
        if items.isEmpty {
            Text(query.trimmingCharacters(in: .whitespaces).isEmpty ? "Type part of a file name" : "No matching files")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                List {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        Button { open(item) } label: {
                            row(item, isSelected: index == selected)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(index)
                        .listRowBackground(index == selected ? Color.accentColor.opacity(0.22) : Color.clear)
                    }
                }
                .listStyle(.plain)
                .onChange(of: selected) { _, index in proxy.scrollTo(index) }
            }
        }
    }

    private func row(_ item: FileItem, isSelected: Bool) -> some View {
        let name = (item.path as NSString).lastPathComponent
        let folder = (item.path as NSString).deletingLastPathComponent
        return HStack(spacing: 8) {
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            Text(verbatim: name).fontWeight(.medium).lineLimit(1)
            Text(verbatim: folder).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)
            if item.changed {
                Text("In review")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize()
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Empty: the files opened lately, then the engine's empty-query list (the review's files first); else the matches.
    private func candidates(_ name: String) async -> [FileItem] {
        let found = await store.quickOpenFiles(query: name)
        guard name.isEmpty else { return found }
        let recent = store.codeBrowser.recentPaths.map { path in FileItem(path: path, changed: found.contains { $0.path == path && $0.changed }) }
        let seen = Set(recent.map(\.path))
        return recent + found.filter { !seen.contains($0.path) }
    }

    private func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        selected = min(max(0, selected + delta), items.count - 1)
    }

    private func openSelected() {
        guard items.indices.contains(selected) else { return }
        open(items[selected])
    }

    private func open(_ item: FileItem) {
        store.openProjectFile(path: item.path, line: CodeBrowserText.goToFileQuery(query).line)
        dismiss()
    }
}
