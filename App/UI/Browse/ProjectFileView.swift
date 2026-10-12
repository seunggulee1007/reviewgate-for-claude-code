import SwiftUI
import AppKit
import ReviewGateCore

// MARK: code-browser — docs/PROTOCOL.md §47: any file of the project, read-only in the diff pane (Go to File ⌘P, a Find in
// Project result, a link to a file). The full file's rows (`FullFilePane`) without the review's marks: line numbers, syntax
// colours as one document, wrap or one shared sideways scroll (`DiffLinesList`), find (⌘F / ⌥⌘F, `DiffFindBar`), a row's
// copy items, "Open in Editor" at the clicked line and "Find in Project" for the line's identifiers.

/// The project file `store.codeBrowser` holds, scrolled to the line it was opened at.
struct ProjectFileView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true

    @State private var find = DiffFindModel()
    @State private var highlighted: [AttributedString]?
    @State private var maxColumns = 0
    /// The row last clicked (Open in Editor goes there); nil = the line the file was opened at.
    @State private var clickedLine: Int?
    /// What the list scrolls to on `scrollTick`: the opened line, or find's current match.
    @State private var scrollKey: String?
    @State private var scrollColumn: Int?
    @State private var scrollTick = 0
    @State private var keysCache = ProjectFileKeysCache()

    var body: some View {
        let browser = store.codeBrowser
        VStack(spacing: 0) {
            if let selection = browser.selection {
                header(selection.path, file: browser.file)
                Divider()
                if let file = browser.file, file.truncated, !file.isBinary {
                    truncatedBanner(file)
                    Divider()
                }
                content(selection, file: browser.file, error: browser.loadError)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("Project file view")
        .onChange(of: browser.selection?.path) { _, _ in
            clickedLine = nil
            find.close()
        }
        // The opened line comes into view once its rows exist (the List needs a moment after the lines arrive).
        .task(id: RevealKey(tick: browser.selection?.tick ?? 0, loaded: browser.file?.path != nil && browser.file?.path == browser.selection?.path)) {
            guard let selection = browser.selection, let file = browser.file, file.path == selection.path,
                  let line = selection.line, !file.lines.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            scrollKey = Self.lineKey(min(line, file.lines.count))
            scrollColumn = nil
            scrollTick += 1
        }
        .onChange(of: find.scrollTick) { _, _ in
            scrollKey = find.state.currentKey
            scrollColumn = find.currentColumn
            scrollTick += 1
        }
        .task(id: HighlightKey(path: browser.file?.path, lineCount: browser.file?.lines.count ?? -1, size: browser.file?.size ?? -1,
                               dark: colorScheme == .dark)) {
            highlighted = nil
            guard let file = browser.file, !file.isBinary, !file.lines.isEmpty else { return }
            let language = await SyntaxHighlighter.shared.language(forPath: file.path)
            let result = await SyntaxHighlighter.shared.highlightDocument(file.lines.joined(separator: "\n"), language: language,
                                                                          dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        .task(id: ColumnsKey(path: browser.file?.path, lines: browser.file?.lines.count ?? -1, wrap: wrapLines)) {
            guard !wrapLines, let lines = browser.file?.lines else { return }
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(lines) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
        // A turn's end may have changed the file on disk: read it again (the lines on screen stay until it answers).
        .onChange(of: store.hudTurnCount) { _, _ in Task { await store.reloadProjectFile() } }
    }

    private struct RevealKey: Equatable {
        let tick: Int
        let loaded: Bool
    }

    private struct HighlightKey: Equatable {
        let path: String?
        let lineCount: Int
        let size: Int
        let dark: Bool
    }

    private struct ColumnsKey: Equatable {
        let path: String?
        let lines: Int
        let wrap: Bool
    }

    // MARK: Header

    private func header(_ path: String, file: ProjectFileReply?) -> some View {
        let name = (path as NSString).lastPathComponent
        let folder = (path as NSString).deletingLastPathComponent
        return HStack(spacing: 8) {
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: name).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                if !folder.isEmpty {
                    Text(verbatim: folder).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
            }
            .help(path)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let file, !file.isBinary {
                Text("\(file.lines.count) lines")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            Text("Read-only")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(.quaternary, in: Capsule())
                .foregroundStyle(.secondary)
                .fixedSize()
            Button("Copy path", systemImage: "doc.on.doc") { DiffLineCopyMenuItems.copy(path) }
                .labelStyle(.iconOnly)
                .fixedSize()
                .help("Copy path")
                .accessibilityIdentifier("Copy project file path")
            Button("Reload", systemImage: "arrow.clockwise") { Task { await store.reloadProjectFile() } }
                .labelStyle(.iconOnly)
                .fixedSize()
                .disabled(store.codeBrowser.isLoading)
                .help("Read the file again")
                .accessibilityIdentifier("Reload project file")
            Toggle("Wrap lines", systemImage: "arrow.turn.down.left", isOn: $wrapLines)
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
                .fixedSize()
                .help("Wrap long lines — turn off to keep each on one line and scroll sideways")
                .accessibilityIdentifier("Wrap lines")
            Button("Find in file", systemImage: "magnifyingglass") { find.open() }
                .labelStyle(.iconOnly)
                .fixedSize()
                .disabled(file == nil || file?.isBinary == true)
                .help("Find in file (⌘F)")
                .accessibilityIdentifier("Find in project file")
            openInEditor(path)
            Button("Back to review", systemImage: "arrow.uturn.left") { store.closeProjectFile() }
                .fixedSize()
                .help("Close the file and show the review again")
                .accessibilityIdentifier("Back from project file")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func truncatedBanner(_ file: ProjectFileReply) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text("Only the first \(file.lines.count) lines are shown (\(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))) — open it in the editor for the rest")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            openInEditor(file.path)
                .controlSize(.small)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Project file truncated banner")
    }

    // MARK: Open in Editor

    /// Split button: the remembered editor as the primary action, every installed editor in the menu (as the diff's).
    private func openInEditor(_ path: String) -> some View {
        let editors = ExternalEditor.installed
        let preferred = ExternalEditor.preferred ?? editors.first ?? .finder
        return Menu {
            ForEach(editors) { editor in
                Button(editor.title, systemImage: editor.systemImage) { open(path, line: editorLine, in: editor) }
            }
        } label: {
            Label(preferred == .finder ? String(localized: "Open in Editor") : preferred.title, systemImage: "arrow.up.forward.app")
        } primaryAction: {
            open(path, line: editorLine, in: preferred)
        }
        .menuStyle(.button)
        .fixedSize()
        .help("Open in Editor")
        .accessibilityIdentifier("Open project file in editor")
    }

    private var editorLine: Int { clickedLine ?? store.codeBrowser.selection?.line ?? 1 }

    private func open(_ path: String, line: Int, in editor: ExternalEditor) {
        guard let root = store.projectInfo?.root else { return }
        editor.open((root as NSString).appendingPathComponent(path), line: line)
    }

    // MARK: Body

    @ViewBuilder
    private func content(_ selection: CodeBrowserSelection, file: ProjectFileReply?, error: String?) -> some View {
        if let error {
            ContentUnavailableView("Could not load file", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
                .frame(maxHeight: .infinity)
        } else if let file, file.path == selection.path {
            if file.isBinary {
                ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                       description: Text("No textual view is available for this file."))
                    .frame(maxHeight: .infinity)
            } else if file.lines.isEmpty {
                ContentUnavailableView("Empty file", systemImage: "doc")
                    .frame(maxHeight: .infinity)
            } else {
                lines(file, target: clickedLine ?? selection.line)
                    .diffFind(find, rows: { Self.findRows(file) }, rowsKey: AnyHashable(FindRowsKey(path: file.path, count: file.lines.count, size: file.size)),
                              tick: model.diffFindTick)
            }
        } else {
            VStack(spacing: 8) {
                ProgressView()
                Text("Loading file…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private struct FindRowsKey: Hashable {
        let path: String
        let count: Int
        let size: Int
    }

    private func lines(_ file: ProjectFileReply, target: Int?) -> some View {
        // Looked up once here, not per row (each asks Launch Services).
        let editor = ExternalEditor.preferred ?? ExternalEditor.installed.first ?? .finder
        return DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: DiffCodeMetrics.fileGutter, resetKey: AnyHashable(file.path),
                             scrollTarget: scrollKey, scrollTick: scrollTick, scrollColumn: scrollColumn) {
            // The rows' ids are the ForEach's own (the line keys find and the scroll go to): a `.id()` on each row would make
            // the List build all 20 000 rows to learn their ids — only the rows on screen are built this way.
            ForEach(keysCache.keys(count: file.lines.count), id: \.self) { key in
                let number = Self.number(key)
                row(number, text: file.lines[number - 1], path: file.path, target: number == target, editor: editor)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
        }
    }

    private func row(_ number: Int, text: String, path: String, target: Bool, editor: ExternalEditor) -> some View {
        let key = Self.lineKey(number)
        let line = DiffLine(id: number, kind: .context, oldNo: nil, newNo: number, text: text)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: String(number))
                .font(DiffRow.font)
                .foregroundStyle(target ? Color.primary : Color.secondary)
                .frame(width: DiffRow.gutterWidth, alignment: .trailing)
                .padding(.trailing, 6)
            Text(verbatim: target ? "›" : " ")
                .font(DiffRow.font)
                .foregroundStyle(Color.accentColor)
                .frame(width: 16)
            DiffCodeText(text: text, styled: styled(line, base: highlight(number - 1), key: key))
                .font(DiffRow.font)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(target ? Color.accentColor.wash(colorScheme, light: 0.10, dark: 0.18) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { clickedLine = number }
        .contextMenu { rowMenu(line, path: path, editor: editor) }
    }

    @ViewBuilder
    private func rowMenu(_ line: DiffLine, path: String, editor: ExternalEditor) -> some View {
        DiffLineCopyMenuItems(line: line, path: path)
        Divider()
        Button(editor == .finder ? String(localized: "Reveal in Finder") : String(localized: "Open in \(editor.title) at This Line"),
               systemImage: editor.systemImage) {
            clickedLine = line.newNo
            open(path, line: line.newNo ?? 1, in: editor)
        }
        let words = CodeBrowserText.identifiers(in: line.text)
        if !words.isEmpty {
            Menu("Find in Project") {
                ForEach(words, id: \.self) { word in
                    Button(word) { Task { await store.searchProject(word: word) } }
                }
            }
        }
    }

    private func highlight(_ index: Int) -> AttributedString? {
        guard let highlighted, highlighted.indices.contains(index) else { return nil }
        return highlighted[index]
    }

    /// The row's text with find matches marked (as the full file's rows).
    private func styled(_ line: DiffLine, base: AttributedString?, key: String) -> AttributedString {
        let query = find.activeQuery
        let ranges = query.isEmpty ? [] : DiffFind.ranges(of: query, in: DiffLineText.shown(line.text).text)
        return DiffLineText.styled(line, base: base, emphasis: nil, find: ranges,
                                   findColor: Color.yellow.opacity(find.isCurrent(key) ? 0.85 : 0.45))
    }

    // MARK: Keys

    static func lineKey(_ number: Int) -> String { "P\(number)" }

    /// The line number of a `lineKey`.
    static func number(_ key: String) -> Int { Int(key.dropFirst()) ?? 1 }

    static func findRows(_ file: ProjectFileReply) -> [DiffFind.Row] {
        file.lines.enumerated().map { DiffFind.Row(key: lineKey($0.offset + 1), text: $0.element) }
    }
}

/// The line keys of a file of `count` lines, built once per line count instead of per body.
@MainActor
final class ProjectFileKeysCache {
    private var cached: [String] = []

    func keys(count: Int) -> [String] {
        if cached.count != count { cached = count > 0 ? (1...count).map(ProjectFileView.lineKey) : [] }
        return cached
    }
}
