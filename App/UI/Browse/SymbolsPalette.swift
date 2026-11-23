import SwiftUI
import ReviewGateCore

// MARK: ide-nav — docs/PROTOCOL.md §65.8 on the Mac: Symbols in This File (⌘F12, `document_symbols` filtered as you type,
// the outline indented by depth) and Symbols in Project (⌥⌘⇧N, `workspace_symbols` per keystroke, the matched letters
// bold, "Indexing… n / N files" while the index builds and the query sent again once it is ready). ↑ / ↓ move, ↩ opens
// (a changed file in its diff, any other read-only; Back returns), Esc closes. The matching is Core `NavFuzzy`.

struct SymbolsPaletteSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let palette: NavPalette
    @State private var query = ""
    @State private var selected = 0
    @State private var loading = false
    @State private var error: String?
    // This file
    @State private var outline: DocumentSymbolsReply?
    // The project
    @State private var reply: WorkspaceSymbolsReply?
    /// Bumped to send the project query again (the index became ready).
    @State private var requery = 0
    @FocusState private var focused: Bool

    private struct Row: Identifiable {
        let id: Int
        let symbol: NavSymbol
        let depth: Int
        let offsets: [Int]
    }

    var body: some View {
        let rows = self.rows
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: palette == .project ? "text.magnifyingglass" : "list.bullet.indent").foregroundStyle(.secondary)
                TextField(palette == .project ? "Symbols in Project" : "Symbols in This File", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .onSubmit { open(rows) }
                    .onKeyPress(.downArrow) { move(1, rows.count); return .handled }
                    .onKeyPress(.upArrow) { move(-1, rows.count); return .handled }
                    .onExitCommand { dismiss() }
                    .accessibilityIdentifier("Symbols palette field")
                if loading { ProgressView().controlSize(.small) }
            }
            .padding(12)
            Divider()
            results(rows)
            Divider()
            footer
        }
        .frame(width: 640, height: 460)
        .onAppear { focused = true }
        .task { if case let .file(path) = palette { await loadOutline(path) } }
        .task(id: ProjectKey(query: query, requery: requery)) { await searchProject() }
        .onChange(of: query) { _, _ in if case .file = palette { selected = filtered.best ?? 0 } }
        .onChange(of: store.navIndex?.status) { _, status in
            // §65.3: the list was answered from a partial index — ask again once it is ready.
            if palette == .project, status == .ready, reply?.index.status == .building { requery += 1 }
        }
        .accessibilityIdentifier(palette == .project ? "Symbols in project" : "Symbols in this file")
    }

    private struct ProjectKey: Equatable {
        let query: String
        let requery: Int
    }

    // MARK: Rows

    private var filtered: (rows: [OutlineRow], best: Int?) {
        NavFuzzy.filterOutline(outline?.symbols ?? [], query: query)
    }

    private var rows: [Row] {
        switch palette {
        case .file:
            filtered.rows.enumerated().map { Row(id: $0.offset, symbol: $0.element.symbol.symbol, depth: $0.element.symbol.depth, offsets: $0.element.offsets) }
        case .project:
            (reply?.symbols ?? []).enumerated().map { Row(id: $0.offset, symbol: $0.element.symbol, depth: 0, offsets: $0.element.matches) }
        }
    }

    @ViewBuilder
    private func results(_ rows: [Row]) -> some View {
        if let error {
            ContentUnavailableView {
                Label("No symbols", systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: error)
            } actions: {
                if palette == .project, store.navIndex?.status == .failed {
                    Button("Try Again") { Task { await store.buildNavIndex(full: false); requery += 1 } }
                        .help("Read the project's files for the index again")
                }
            }
            .frame(maxHeight: .infinity)
        } else if rows.isEmpty {
            Text(emptyText)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                List {
                    ForEach(rows) { row in
                        Button { openRow(row) } label: {
                            line(row).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(row.id)
                        .listRowBackground(row.id == selected ? Color.accentColor.opacity(0.22) : Color.clear)
                    }
                }
                .listStyle(.plain)
                .onChange(of: selected) { _, index in proxy.scrollTo(index) }
            }
        }
    }

    private var emptyText: LocalizedStringKey {
        switch palette {
        case .file:
            if outline == nil { return loading ? "Reading the file…" : "" }
            return query.trimmingCharacters(in: .whitespaces).isEmpty ? "No symbols in this file" : "No matching symbols"
        case .project:
            return query.trimmingCharacters(in: .whitespaces).isEmpty ? "Type part of a name — UsrSvc finds UserService" : "No matching symbols"
        }
    }

    private func line(_ row: Row) -> some View {
        let s = row.symbol
        return HStack(spacing: 8) {
            Image(systemName: KindIcon.name(s.kind)).foregroundStyle(KindIcon.color(s.kind)).frame(width: 16)
            Text(NavFuzzy.emphasized(s.name, offsets: row.offsets)).lineLimit(1)
            if palette == .project, let container = s.container {
                Text(verbatim: container).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(verbatim: palette == .project ? "\((s.path as NSString).lastPathComponent):\(s.line)" : String(s.line))
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
        }
        .padding(.leading, CGFloat(min(row.depth, 8)) * 16)
        .padding(.vertical, 2)
        .help(s.signature ?? s.qualifiedName)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(row.id == selected ? .isSelected : [])
    }

    @ViewBuilder
    private var footer: some View {
        let notes = palette == .project ? NavFuzzy.projectNotes(reply, index: store.navIndex) : (outline?.truncated == true ? [String(localized: "Only the start of a long file")] : [])
        HStack(spacing: 10) {
            Text("↑ ↓ to move · ↩ to open · Esc to close").font(.caption).foregroundStyle(.secondary)
            Spacer()
            ForEach(notes, id: \.self) { Text(verbatim: $0).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    // MARK: Requests

    private func loadOutline(_ path: String) async {
        loading = true
        let (r, e) = await store.documentSymbols(path: path)
        loading = false
        outline = r
        error = e
        selected = filtered.best ?? 0
    }

    private func searchProject() async {
        guard palette == .project else { return }
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else {
            reply = nil
            error = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(80))   // a moment after the typing stops
        guard !Task.isCancelled else { return }
        loading = true
        let (r, e) = await store.workspaceSymbols(query: q)
        guard !Task.isCancelled else { return }
        loading = false
        reply = r
        error = e
        selected = 0
    }

    private func move(_ delta: Int, _ count: Int) {
        guard count > 0 else { return }
        selected = min(max(0, selected + delta), count - 1)
    }

    private func open(_ rows: [Row]) {
        guard rows.indices.contains(selected) else { return }
        openRow(rows[selected])
    }

    private func openRow(_ row: Row) {
        store.goToFile(path: row.symbol.path, line: row.symbol.line, column: row.symbol.column)
        dismiss()
    }
}

/// A symbol's kind as an SF Symbol and a tint (the palettes' rows).
enum KindIcon {
    static func name(_ kind: DefinitionKind) -> String {
        switch kind.rawValue {
        case "class", "object", "record": "c.square"
        case "interface", "annotation": "i.square"
        case "enum": "e.square"
        case "type", "module": "t.square"
        case "method", "function", "constructor": "f.square"
        case "field", "property", "variable", "constant": "v.square"
        case "component", "tag": "puzzlepiece"
        default: "number.square"
        }
    }

    static func color(_ kind: DefinitionKind) -> Color {
        switch kind.rawValue {
        case "class", "object", "record", "interface", "annotation", "enum", "type", "module": .orange
        case "method", "function", "constructor": .purple
        case "component", "tag": .green
        default: .blue
        }
    }
}
