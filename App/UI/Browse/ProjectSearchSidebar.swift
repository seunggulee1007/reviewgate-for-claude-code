import SwiftUI
import ReviewGateCore

// MARK: code-browser — docs/PROTOCOL.md §47: the sidebar's Search tab (Find in Project ⇧⌘F). `project_search` (git grep over
// the project's files, a fixed string, case ignored unless asked) a moment after the typing stops or on ↩; the matches by
// file, each opening the file read-only in the diff pane at its line.

struct ProjectSearchSidebar: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var focused: Bool

    /// Typing searches once the query is this long (↩ searches any).
    private static let autoSearchMinLength = 2

    var body: some View {
        @Bindable var browser = store.codeBrowser
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Find in project", text: $browser.searchQuery)
                        .textFieldStyle(.plain)
                        .focused($focused)
                        .onSubmit { Task { await store.searchProject() } }
                        .accessibilityIdentifier("Find in project field")
                    if browser.isSearching {
                        ProgressView().controlSize(.small)
                    } else if !browser.searchQuery.isEmpty {
                        Button("Clear", systemImage: "xmark.circle.fill") { browser.searchQuery = "" }
                            .labelStyle(.iconOnly)
                            .buttonStyle(IconButtonStyle(padding: 2))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                HStack(spacing: 6) {
                    Toggle(isOn: $browser.caseSensitive) { Text(verbatim: "Aa") }
                        .toggleStyle(.button)
                        .controlSize(.small)
                        .help("Match case")
                        .accessibilityLabel("Match case")
                        .accessibilityIdentifier("Find in project match case")
                    Toggle(isOn: $browser.wholeWord) { Text(verbatim: "W").underline() }
                        .toggleStyle(.button)
                        .controlSize(.small)
                        .help("Whole word")
                        .accessibilityLabel("Whole word")
                        .accessibilityIdentifier("Find in project whole word")
                    Spacer(minLength: 4)
                    statusText(browser)
                }
            }
            .padding(10)
            Divider()
            results(browser)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
        .onChange(of: browser.searchPresentTick) { _, _ in focused = true }
        .task(id: SearchKey(query: browser.searchQuery, caseSensitive: browser.caseSensitive, wholeWord: browser.wholeWord)) {
            let query = browser.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard query.isEmpty || query.count >= Self.autoSearchMinLength else { return }
            // This key was searched already, or is being searched (the tab shown again, a row's "Find in Project").
            if browser.searchedKey == currentKey(browser) { return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await store.searchProject()
        }
        .accessibilityIdentifier("Find in project")
    }

    private struct SearchKey: Equatable {
        let query: String
        let caseSensitive: Bool
        let wholeWord: Bool
    }

    private func currentKey(_ browser: CodeBrowserStore) -> String {
        CodeBrowserStore.searchKey(query: browser.searchQuery, caseSensitive: browser.caseSensitive, wholeWord: browser.wholeWord)
    }

    @ViewBuilder
    private func statusText(_ browser: CodeBrowserStore) -> some View {
        if let error = browser.searchError {
            Text(verbatim: error).font(.caption).foregroundStyle(.red).lineLimit(2)
        } else if let reply = browser.searchReply {
            Text(verbatim: CodeBrowserText.summary(reply, files: browser.searchGroups.count))
                .font(.caption)
                .foregroundStyle(reply.truncated || reply.timedOut ? Color.orange : Color.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("Find in project summary")
        }
    }

    @ViewBuilder
    private func results(_ browser: CodeBrowserStore) -> some View {
        if browser.searchGroups.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "text.magnifyingglass").font(.title2).foregroundStyle(.tertiary)
                if browser.searchQuery.isEmpty {
                    Text("Search every file of the project — the results open the file at their line")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let query = browser.searchReply?.query ?? ""
            let current = browser.selection
            List {
                ForEach(browser.searchGroups) { group in
                    Section {
                        ForEach(group.matches, id: \.self) { match in
                            Button { store.openProjectFile(path: match.path, line: match.line) } label: {
                                matchRow(match, query: query, isCurrent: current?.path == match.path && current?.line == match.line)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 8))
                        }
                    } header: {
                        groupHeader(group)
                    }
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 1)
        }
    }

    private func groupHeader(_ group: ProjectSearchGroup) -> some View {
        let name = (group.path as NSString).lastPathComponent
        let folder = (group.path as NSString).deletingLastPathComponent
        return Button { store.openProjectFile(path: group.path, line: group.matches.first?.line) } label: {
            HStack(spacing: 6) {
                Image(systemName: "doc.text").foregroundStyle(.secondary)
                Text(verbatim: name).font(.callout.weight(.semibold)).lineLimit(1)
                Text(verbatim: folder).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                Text(verbatim: String(group.matches.count))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(group.path)
    }

    private func matchRow(_ match: ProjectSearchMatch, query: String, isCurrent: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: String(match.line))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 34, alignment: .trailing)
            Text(marked(match.text, query: query))
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2).padding(.horizontal, 4)
        .background(isCurrent ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 4))
        .help(match.text)
    }

    /// The line without its indent, the query's occurrences marked.
    private func marked(_ text: String, query: String) -> AttributedString {
        let shown = String(text.drop { $0 == " " || $0 == "\t" })
        var out = AttributedString(shown)
        for range in DiffFind.ranges(of: query, in: shown) {
            if let r = Range<AttributedString.Index>(range, in: out) {
                out[r].swiftUI.backgroundColor = Color.yellow.opacity(0.55)
                out[r].swiftUI.foregroundColor = .black
            }
        }
        return out
    }
}
