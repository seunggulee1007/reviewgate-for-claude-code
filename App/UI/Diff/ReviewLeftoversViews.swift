import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers" on the Mac: "Show 20 more lines" for the history and
// PR diffs (the new side from `history_file_lines` / `pr_file_lines`), the whitespace-ignoring view of the review diff
// ("공백 무시", read-only), and a changed image before / after. The rules are Core `ReviewLeftovers` (tested there).

// MARK: - "Show 20 more lines" for a diff whose new side the engine reads on demand

/// What one shown diff unfolded and the lines loaded for it; reset with the diff.
struct DiffMoreLines: Equatable {
    var fold = DiffFoldState()
    var lines: [String]?
    var loading = false
    var blocked: String?
    var token = UUID()

    /// The rows: the plan with expanders when the diff has unchanged lines to offer, else every line as before (a large
    /// diff, an added / deleted / binary file — the history and PR panes never folded).
    func items(_ diff: FileDiff, truncated: Bool, offersContext: Bool) -> [DiffDisplayItem] {
        guard offersContext, !DiffDisplay.isLarge(diff) else {
            return diff.allLines.map { DiffDisplayItem(id: DiffDisplayItem.key($0), kind: .line($0)) }
        }
        return DiffDisplayPlan.make(diff: diff, generated: nil, fold: fold, fullFile: lines, truncated: truncated, contextEnabled: true).items
    }

    /// The rows find in diff searches (the revealed lines included).
    static func findRows(_ items: [DiffDisplayItem]) -> [DiffFind.Row] {
        items.compactMap { item in
            switch item.kind {
            case let .line(line), let .context(line): DiffFind.Row(key: DiffDisplayItem.key(line), text: line.text)
            default: nil
            }
        }
    }
}

/// One "Show 20 more lines": the new side is fetched once (and used only while it matches the diff), then the gap opens.
@MainActor
func revealMoreLines(_ more: Binding<DiffMoreLines>, gap: Int, direction: ContextDirection, diff: FileDiff,
                     fetch: @escaping @MainActor () async throws -> FileLinesReply) {
    if more.wrappedValue.lines != nil {
        more.wrappedValue.fold.reveal(gap: gap, direction: direction)
        return
    }
    guard !more.wrappedValue.loading, more.wrappedValue.blocked == nil else { return }
    more.wrappedValue.loading = true
    let token = more.wrappedValue.token
    Task { @MainActor in
        let result: Result<FileLinesReply, any Error>
        do { result = .success(try await fetch()) } catch { result = .failure(error) }
        guard more.wrappedValue.token == token else { return }   // another diff since: its own state was reset
        more.wrappedValue.loading = false
        switch result {
        case let .success(reply):
            if let why = ReviewLeftovers.unavailable(reply) {
                more.wrappedValue.blocked = why
            } else if !DiffDisplay.fullFileMatches(diff, lines: reply.lines) {
                more.wrappedValue.blocked = String(localized: "The file's lines do not match this diff — more lines cannot be shown")
            } else {
                more.wrappedValue.lines = reply.lines
                more.wrappedValue.fold.reveal(gap: gap, direction: direction)
            }
        case let .failure(error):
            more.wrappedValue.blocked = error.localizedDescription
        }
    }
}

/// The expander row of a gap ("Show 20 more lines", "Collapse N lines"), for the history and PR panes.
struct MoreLinesExpanderRow: View {
    let item: DiffDisplayItem
    @Binding var more: DiffMoreLines
    let onReveal: (Int, ContextDirection) -> Void

    var body: some View {
        if case let .expander(gap, _, up, down, revealed) = item.kind {
            DiffContextExpanderRow(gap: gap, up: up, down: down, revealed: revealed, loading: more.loading, blocked: more.blocked,
                                   canCollapseAll: more.fold.hasRevealed,
                                   onReveal: { direction in onReveal(gap, direction) },
                                   onCollapse: { more.fold.collapse(gap: gap) },
                                   onCollapseAll: { more.fold.collapseAllRevealed() })
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
        }
    }
}

// MARK: - The whitespace-ignoring view ("공백 무시")

/// The header's "Ignore whitespace" switch; a binary file has none.
struct WhitespaceToggle: View {
    @Binding var isOn: Bool
    let file: ChangedFile

    var body: some View {
        if !file.isBinary {
            Toggle("Ignore whitespace", systemImage: "space", isOn: $isOn)
                .toggleStyle(.button)
                .fixedSize()
                .help(isOn ? ReviewLeftovers.whitespaceViewNote : String(localized: "Hide changes that only touch whitespace (indentation, tabs ↔ spaces)"))
                .accessibilityLabel("Ignore whitespace")
                .accessibilityIdentifier("Ignore whitespace")
        }
    }
}

/// The review diff's range with whitespace ignored (`select_file {ignoreWhitespace}`): read-only rows — copy and find stay;
/// part revert, notes and line side questions wait for the normal view (the row above the lines says so).
struct WhitespaceDiffBody: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true

    let file: ChangedFile
    @Binding var isOn: Bool
    /// Find in diff: the diff pane's, so an open bar and its query stay when the view changes.
    let find: DiffFindModel

    @State private var loaded: Loaded?
    @State private var highlighted: [AttributedString]?
    @State private var maxColumns = 0

    private struct Loaded: Equatable {
        let key: Key
        let diff: WhitespaceIgnoredDiff?
        let error: String?
    }

    private struct Key: Hashable {
        let path: String
        let since: DiffSince
        let tree: String?
    }

    private var key: Key { Key(path: file.path, since: store.diffSince(for: file), tree: store.selectedDiffEndTree) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "space").foregroundStyle(.secondary)
                Text(verbatim: ReviewLeftovers.whitespaceViewNote)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button("Show whitespace changes") { isOn = false }
                    .controlSize(.small)
                    .accessibilityIdentifier("Whitespace view off")
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Whitespace view note")
            Divider()
            content
        }
        .task(id: key) {
            let key = self.key
            loaded = nil
            highlighted = nil
            do {
                let diff = try await store.whitespaceIgnoredDiff(for: file)
                guard !Task.isCancelled else { return }
                loaded = Loaded(key: key, diff: diff, error: nil)
                let lines = diff.diff.allLines
                guard !lines.isEmpty, lines.count <= DiffDisplay.foldLineThreshold else { return }
                let colored = await DiffRow.highlight(lines, path: file.path, dark: colorScheme == .dark)
                guard !Task.isCancelled else { return }
                highlighted = colored
            } catch {
                guard !Task.isCancelled else { return }
                loaded = Loaded(key: key, diff: nil, error: error.localizedDescription)
            }
        }
        .task(id: [AnyHashable(key), AnyHashable(wrapLines), AnyHashable(loaded?.diff?.diff.allLines.count ?? -1)]) {
            maxColumns = 0
            guard !wrapLines, let diff = loaded?.diff?.diff else { return }
            let texts = diff.allLines.map(\.text)
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
    }

    @ViewBuilder
    private var content: some View {
        if let loaded, loaded.key == key {
            if let error = loaded.error {
                ContentUnavailableView("Diff unavailable", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
                    .frame(maxHeight: .infinity)
            } else if let result = loaded.diff {
                if result.diff.hunks.isEmpty {
                    ContentUnavailableView(ReviewLeftovers.whitespaceEmptyText(whitespaceOnly: file.whitespaceOnly), systemImage: "space",
                                           description: Text("Turn “Ignore whitespace” off to see the whitespace changes"))
                        .frame(maxHeight: .infinity)
                        .accessibilityIdentifier("Whitespace diff empty")
                } else {
                    rows(result)
                }
            }
        } else {
            VStack(spacing: 8) {
                ProgressView()
                Text("Loading diff…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func rows(_ result: WhitespaceIgnoredDiff) -> some View {
        let lines = result.diff.allLines
        return VStack(spacing: 0) {
            if result.truncated {
                Label("Diff truncated at \(DiffView.collapseThreshold.formatted()) lines", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(6)
            }
            DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: DiffCodeMetrics.diffGutter, resetKey: AnyHashable(key),
                          scrollTarget: find.state.currentKey, scrollTick: find.scrollTick, scrollColumn: find.currentColumn) {
                ForEach(lines) { line in
                    DiffRow(line: line, highlighted: highlighted.flatMap { $0.indices.contains(line.id) ? $0[line.id] : nil },
                            findQuery: find.activeQuery, isCurrentMatch: find.isCurrent(DiffDisplayItem.key(line)))
                        .id(DiffDisplayItem.key(line))
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .contextMenu {
                            if line.kind != .hunkHeader {
                                Button("Ask Why This Line Changed", systemImage: "questionmark.bubble") {}
                                    .disabled(true)
                                Text(verbatim: ReviewLeftovers.whitespaceViewNote)
                                Divider()
                                DiffLineCopyMenuItems(line: line, path: file.path)
                            }
                        }
                }
            }
            .diffFind(find, rows: { lines.map { DiffFind.Row(key: DiffDisplayItem.key($0), text: $0.text) } },
                      rowsKey: AnyHashable([AnyHashable(key), AnyHashable(lines.count)]), tick: model.diffFindTick)
        }
        .accessibilityIdentifier("Whitespace diff")
    }
}

// MARK: - A changed image before / after

/// png / jpg / gif of the review (`file_image`, each side ≤ 2 MB) side by side on a checkerboard, so a transparent or dark
/// image shows in the dark appearance too. An older engine (`unknown_command`) shows nothing new.
struct ImagePreviewSection: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile

    @State private var loaded: (key: String, reply: FileImageReply?, failed: Bool)?

    private var key: String { "\(store.selectedDiffEndTree ?? "")\u{0}\(file.path)" }

    var body: some View {
        Group {
            if let loaded, loaded.key == key {
                if let reply = loaded.reply {
                    HStack(alignment: .top, spacing: 12) {
                        ImageSideView(title: String(localized: "Before"), side: reply.old, empty: String(localized: "Added in this review"))
                        ImageSideView(title: String(localized: "After"), side: reply.new, empty: String(localized: "Deleted in this review"))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("Image preview")
                } else if loaded.failed {
                    Text("Could not load the image preview")
                        .font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
        }
        .task(id: key) {
            let key = self.key
            do {
                let reply = try await store.fileImage(for: file)
                guard !Task.isCancelled else { return }
                loaded = (key, reply, false)
            } catch {
                guard !Task.isCancelled else { return }
                // An engine before §41.3: no preview, nothing to say (the sizes line stays).
                if case let EngineClientError.refused(_, code, _, _) = error, code == "unknown_command" {
                    loaded = (key, nil, false)
                } else {
                    loaded = (key, nil, true)
                }
            }
        }
    }
}

private struct ImageSideView: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let side: FileImageSide?
    let empty: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ZStack {
                Checkerboard(dark: colorScheme == .dark)
                if let side, let data = side.data, let image = NSImage(data: data) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: min(image.size.width, 360), maxHeight: min(image.size.height, 280))
                        .padding(8)
                        .accessibilityLabel(Text(verbatim: title))
                } else {
                    Text(verbatim: side == nil ? empty : String(localized: "Larger than 2 MB — not previewed"))
                        .font(.caption).foregroundStyle(.secondary)
                        .padding(12)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 300)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3)))
            if let side {
                Text(ByteCountFormatter.string(fromByteCount: Int64(side.size), countStyle: .file))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Two-tone squares that read on both appearances (a transparent PNG's edges, a dark logo on the dark theme).
private struct Checkerboard: View {
    let dark: Bool

    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 8
            let a = dark ? Color(white: 0.20) : Color(white: 0.94)
            let b = dark ? Color(white: 0.28) : Color(white: 0.86)
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(a))
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = row % 2 == 0 ? 0 : cell
                while x < size.width {
                    context.fill(Path(CGRect(x: x, y: y, width: cell, height: cell)), with: .color(b))
                    x += cell * 2
                }
                y += cell
                row += 1
            }
        }
        .accessibilityHidden(true)
    }
}
