import SwiftUI
import AppKit
import ReviewGateCore

/// Unified diff of one PR file (same `DiffRow` as the checkpoint DiffView) with existing review
/// comments and pending drafts rendered beneath the line they belong to. Hovering a line shows a
/// gutter "+" that opens an inline `CommentComposer`; "Reply" on an existing comment does the same.
///
/// Line matching follows GitHub's `line`/`side`: add/context lines match `newNo` on RIGHT,
/// deleted lines match `oldNo` on LEFT. Hunk headers cannot be commented.
struct PRDiffPane: View {
    @Environment(PRStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let file: PRFile?
    let diff: FileDiff?
    /// The engine cut `diff` at its line cap (audit 1.10).
    var truncated: Bool = false
    /// Comments already filtered to `file.filename`.
    let comments: [PRComment]

    @State private var composer: Composer?
    /// Comments on lines that changed since (GitHub's "outdated", `line == nil`), shown above the diff on request, and the
    /// one of them being replied to.
    @State private var showOutdated = false
    @State private var outdatedReplyTo: PRComment?
    /// Per-line syntax highlight indexed by `DiffLine.id`; nil until the highlighter returns.
    @State private var highlighted: [AttributedString]?
    // MARK: wave2 mac-diff
    @Environment(WindowModel.self) private var model
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    @State private var find = DiffFindModel()
    @State private var maxColumns = 0
    // MARK: wave4c w4c-review — §41.3 "Show 20 more lines" from the PR's head commit
    @State private var more = DiffMoreLines()

    private struct HighlightKey: Equatable {
        let path: String?
        let lineCount: Int
        let dark: Bool
    }

    /// wave2 mac-diff: the widest line is measured again for another diff, or when wrapping is turned off.
    private struct ColumnsKey: Equatable {
        let path: String?
        let lineCount: Int
        let wrap: Bool
    }

    /// Where the composer is open: a new draft on a line, a reply to an existing comment, or a draft being edited.
    private struct Composer: Equatable {
        let key: LineKey
        var replyTo: PRComment?
        var editing: DraftComment?
    }

    var body: some View {
        VStack(spacing: 0) {
            if let file {
                header(file)
                Divider()
                if truncated {
                    truncatedBanner(file)
                    Divider()
                }
                if showOutdated {
                    outdatedSection
                    Divider()
                }
                content(file)
            } else {
                ContentUnavailableView("Select a file", systemImage: "doc.text.magnifyingglass",
                                       description: Text("Pick a changed file to see its diff."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: file?.id) { _, _ in
            composer = nil
            more = DiffMoreLines()
            showOutdated = false
            outdatedReplyTo = nil
        }
        .onChange(of: diff) { _, _ in more = DiffMoreLines() }   // wave4c w4c-review
        .task(id: HighlightKey(path: file?.filename, lineCount: diff?.allLines.count ?? -1, dark: colorScheme == .dark)) {
            highlighted = nil
            guard let file, let diff, !diff.isBinary else { return }
            let lines = diff.allLines
            guard !lines.isEmpty, lines.count <= DiffDisplay.foldLineThreshold else { return }   // wave2 mac-diff: as the review diff
            let result = await DiffRow.highlight(lines, path: file.filename, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        // MARK: wave2 mac-diff
        .task(id: ColumnsKey(path: file?.filename, lineCount: diff?.allLines.count ?? -1, wrap: wrapLines)) {
            maxColumns = 0
            guard !wrapLines, let diff else { return }
            let texts = diff.allLines.map(\.text)
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
    }

    private func header(_ file: PRFile) -> some View {
        let outdated = comments.filter { $0.line == nil }.count
        return HStack(spacing: 8) {
            Text(file.filename).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
            Text("+\(file.additions)").font(.caption.monospacedDigit()).foregroundStyle(.green)
            Text("−\(file.deletions)").font(.caption.monospacedDigit()).foregroundStyle(.red)
            Spacer()
            if outdated > 0 {
                Button { showOutdated.toggle() } label: {
                    if showOutdated { Text("Hide \(outdated) outdated comment(s)") } else { Text("Show \(outdated) outdated comment(s)") }
                }
                .buttonStyle(.link)
                .font(.caption)
                .help("Comments on lines that changed since they were written — shown above the diff with the lines they were on")
                .accessibilityIdentifier("Toggle outdated comments")
            }
            DiffLineOptions { model.diffFindTick += 1 }   // wave2 mac-diff: 줄바꿈, diff에서 찾기
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    /// The outdated comments, oldest first, each thread start with the last lines of the hunk it was written on; Reply and
    /// "Send to Claude" work as on a line.
    private var outdatedSection: some View {
        let outdated = comments.filter { $0.line == nil }.sorted { $0.createdAt < $1.createdAt }
        return ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(outdated) { comment in
                    if comment.inReplyTo == nil, let context = Self.hunkTail(comment.diffHunk) {
                        Text(verbatim: context)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    CommentBubble(comment: comment) { outdatedReplyTo = comment }
                    if outdatedReplyTo?.id == comment.id {
                        CommentComposer(submitTitle: String(localized: "Reply"), submitID: "Reply", isBusy: store.isSubmitting,
                                        onSubmit: { body in
                                            guard !body.isEmpty else { return }
                                            Task {
                                                await store.reply(to: comment, body: body)
                                                if store.errorText == nil { outdatedReplyTo = nil }
                                            }
                                        },
                                        onCancel: { outdatedReplyTo = nil })
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .frame(maxHeight: 260)
        .accessibilityIdentifier("Outdated comments")
    }

    /// The last three lines of a comment's `diff_hunk` — the line it was written on is the last one.
    private static func hunkTail(_ hunk: String) -> String? {
        let lines = hunk.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.hasPrefix("@@") }
        let tail = lines.suffix(3).joined(separator: "\n")
        return tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : tail
    }

    /// Audit 1.10: only the first lines of a huge patch arrived; GitHub's file view has the whole change.
    private func truncatedBanner(_ file: PRFile) -> some View {
        let filesURL = store.selected.flatMap { URL(string: $0.url + "/files") }
        return HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text("Diff truncated at \(DiffView.collapseThreshold.formatted()) lines — open on GitHub to see the whole change")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let filesURL {
                Button("Open on GitHub", systemImage: "arrow.up.forward.app") { NSWorkspace.shared.open(filesURL) }
                    .controlSize(.small)
                    .accessibilityIdentifier("Open PR files on GitHub")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("PR diff truncated banner")
    }

    @ViewBuilder
    private func content(_ file: PRFile) -> some View {
        if let diff {
            if diff.isBinary {
                ContentUnavailableView("No textual diff", systemImage: "doc.zipper",
                                       description: Text("GitHub returned no patch for this file (binary or too large)."))
            } else if diff.hunks.isEmpty {
                ContentUnavailableView("No changes", systemImage: "doc.text",
                                       description: Text("The patch for this file is empty."))
            } else {
                let byLine = Self.index(comments)
                let draftsByLine = Self.indexDrafts(store.draftComments.filter { $0.path == file.filename })
                // MARK: wave4c w4c-review — the rows with "Show 20 more lines" between the hunks (a modified / renamed file)
                let items = more.items(diff, truncated: truncated, offersContext: ReviewLeftovers.prOffersContext(status: file.status, isBinary: diff.isBinary))
                // wave2 mac-diff: wrapped or scrolled sideways together (DiffLinesList), find in diff, copy.
                DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: DiffCodeMetrics.diffGutter, resetKey: AnyHashable(file.filename),
                              scrollTarget: find.state.currentKey, scrollTick: find.scrollTick, scrollColumn: find.currentColumn) {
                    ForEach(items) { item in
                      switch item.kind {
                      case .line(let line), .context(let line):
                        let key = Self.key(for: line)
                        diffRow(line, key: key)
                            .id(DiffDisplayItem.key(line))
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                        if let key {
                            ForEach(byLine[key] ?? []) { comment in
                                CommentBubble(comment: comment) { composer = Composer(key: key, replyTo: comment) }
                                    .listRowInsets(Self.bubbleInsets)
                                    .listRowSeparator(.hidden)
                            }
                            ForEach(draftsByLine[key] ?? []) { draft in
                                Group {
                                    if composer?.editing?.id == draft.id {
                                        CommentComposer(submitTitle: String(localized: "Save"), submitID: "Save draft",
                                                        initialText: draft.body,
                                                        onSubmit: { body in saveEdit(draft, body: body) },
                                                        onCancel: { composer = nil })
                                    } else {
                                        DraftBubble(draft: draft, onEdit: { composer = Composer(key: key, editing: draft) }) {
                                            store.removeDraft(id: draft.id)
                                        }
                                    }
                                }
                                .listRowInsets(Self.bubbleInsets)
                                .listRowSeparator(.hidden)
                            }
                            if let composer, composer.key == key, composer.editing == nil {
                                // What is typed is the store's (`commentDrafts`): another file or another line's + closes
                                // the composer, and this line's + opens it again with the text.
                                let draftKey = Self.draftKey(file, composer)
                                CommentComposer(
                                    submitTitle: composer.replyTo == nil ? String(localized: "Add to review") : String(localized: "Reply"),
                                    submitID: composer.replyTo == nil ? "Add to review" : "Reply",
                                    isBusy: store.isSubmitting,
                                    initialText: store.commentDrafts[draftKey] ?? "",
                                    onTextChange: { store.commentDrafts[draftKey] = $0.isEmpty ? nil : $0 },
                                    onSubmit: { body in submit(body, for: file, composer: composer) },
                                    onCancel: {
                                        store.commentDrafts[draftKey] = nil
                                        self.composer = nil
                                    })
                                    .listRowInsets(Self.bubbleInsets)
                                    .listRowSeparator(.hidden)
                            }
                        }
                      default:
                        // MARK: wave4c w4c-review — §41.3
                        MoreLinesExpanderRow(item: item, more: $more) { gap, direction in
                            revealMoreLines($more, gap: gap, direction: direction, diff: diff) {
                                try await store.fileLines(filename: file.filename)
                            }
                        }
                      }
                    }
                }
                .diffFind(find, rows: { DiffMoreLines.findRows(items) },
                          rowsKey: AnyHashable([AnyHashable(file.filename), AnyHashable(diff.hunks.count), AnyHashable(diff.hunks.last?.lines.last?.id), AnyHashable(items.count)]),
                          tick: model.diffFindTick)
            }
        } else {
            VStack(spacing: 8) {
                ProgressView()
                Text("Loading diff…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private static let bubbleInsets = EdgeInsets(top: 2, leading: DiffRow.gutterWidth * 2 + 20, bottom: 2, trailing: 12)

    /// A diff line with the hover-only "+" gutter button (hidden on hunk headers). wave4d w4d-speed (polish-09): the hover is
    /// the row's own (`HoverRow`), so a pointer move redraws one row, not the pane; VoiceOver gets "Add comment" as an action.
    private func diffRow(_ line: DiffLine, key: LineKey?) -> some View {
        let highlight = highlighted.flatMap { $0.indices.contains(line.id) ? $0[line.id] : nil }
        return HoverRow { hovered in
            DiffRow(line: line, highlighted: highlight, findQuery: find.activeQuery, isCurrentMatch: find.isCurrent(DiffDisplayItem.key(line)))
                .accessibilityActions {
                    if let key { Button("Add comment") { composer = Composer(key: key, replyTo: nil) } }
                }
                .overlay(alignment: .leading) {
                    if let key, hovered {
                        Button {
                            composer = Composer(key: key, replyTo: nil)
                        } label: {
                            Image(systemName: "plus")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 16, height: 16)
                                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 3))
                        }
                        .buttonStyle(.plain)
                        .padding(.leading, 2)
                        .help("Add comment")
                        .accessibilityLabel("Add comment")
                        .accessibilityIdentifier("Add comment")
                    }
                }
                .contextMenu {
                    // wave3 mac-flow (§36.14): a side question on this PR line with its hunk.
                    if line.kind != .hunkHeader, line.id >= 0, let path = file?.filename, let diff {   // wave4c w4c-review: not a revealed line
                        PRSideQuestionMenuItem(line: line, path: path, diff: diff)
                        Divider()
                    }
                    if line.kind != .hunkHeader, let path = file?.filename { DiffLineCopyMenuItems(line: line, path: path) }   // wave2 mac-diff
                }
        }
    }

    private func submit(_ body: String, for file: PRFile, composer: Composer) {
        guard !body.isEmpty else { return }
        let draftKey = Self.draftKey(file, composer)
        if let target = composer.replyTo {
            Task {
                await store.reply(to: target, body: body)
                if store.errorText == nil {
                    store.commentDrafts[draftKey] = nil
                    self.composer = nil
                }
            }
        } else {
            store.addDraft(DraftComment(path: file.filename, line: composer.key.number, side: composer.key.side, body: body))
            store.commentDrafts[draftKey] = nil
            self.composer = nil
        }
    }

    /// An edited draft: the engine has no "update draft", so the old one goes and the new text is added on the same
    /// line(s) — it moves to the end of the list, which nothing depends on.
    private func saveEdit(_ draft: DraftComment, body: String) {
        composer = nil
        guard !body.isEmpty, body != draft.body else { return }
        store.removeDraft(id: draft.id)
        store.addDraft(DraftComment(path: draft.path, line: draft.line, side: draft.side, startLine: draft.startLine, body: body))
    }

    private static func draftKey(_ file: PRFile, _ composer: Composer) -> String {
        PRStore.commentDraftKey(path: file.filename, side: composer.key.side, line: composer.key.number, replyTo: composer.replyTo?.id)
    }

    // MARK: Line ↔ comment matching

    struct LineKey: Hashable {
        let side: String
        let number: Int
    }

    static func key(for line: DiffLine) -> LineKey? {
        // wave4c w4c-review — §41.3: a line shown by "Show 20 more lines" is outside the PR's diff: GitHub takes no comment there.
        guard line.id >= 0 else { return nil }
        switch line.kind {
        case .add, .context: return line.newNo.map { LineKey(side: "RIGHT", number: $0) }
        case .del: return line.oldNo.map { LineKey(side: "LEFT", number: $0) }
        case .hunkHeader: return nil
        }
    }

    static func index(_ comments: [PRComment]) -> [LineKey: [PRComment]] {
        var map: [LineKey: [PRComment]] = [:]
        for c in comments {
            guard let line = c.line else { continue }
            map[LineKey(side: c.side ?? "RIGHT", number: line), default: []].append(c)
        }
        for k in map.keys { map[k]?.sort { $0.createdAt < $1.createdAt } }
        return map
    }

    static func indexDrafts(_ drafts: [DraftComment]) -> [LineKey: [DraftComment]] {
        var map: [LineKey: [DraftComment]] = [:]
        for d in drafts { map[LineKey(side: d.side, number: d.line), default: []].append(d) }
        return map
    }
}

/// One existing review comment (author · time · body) with a "Reply" action.
/// The body is shown as plain text (no markdown) with newlines preserved.
struct CommentBubble: View {
    @Environment(\.colorScheme) private var colorScheme
    let comment: PRComment
    var onReply: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if comment.inReplyTo != nil {
                    Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.secondary)
                }
                Text(comment.author).font(.caption.weight(.semibold))
                Text(comment.createdAt, format: .relative(presentation: .named))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                PRSendCommentButton(comment: comment)   // wave3 mac-flow (§36.14): the thread to Claude's composer
                if let onReply {
                    Button("Reply", systemImage: "arrowshape.turn.up.left", action: onReply)
                        .labelStyle(.titleAndIcon)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .accessibilityIdentifier("Reply")
                }
            }
            Text(verbatim: comment.body)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(Color.accentColor.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.accentColor.wash(colorScheme, light: 0.25, dark: 0.40)))
    }
}

/// A pending (not yet submitted) comment, visually distinct from posted ones; the pencil edits it in place.
struct DraftBubble: View {
    @Environment(\.colorScheme) private var colorScheme
    let draft: DraftComment
    var onEdit: (() -> Void)?
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Draft")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.orange.wash(colorScheme, light: 0.20, dark: 0.28), in: Capsule())
                    .foregroundStyle(.orange)
                Text("pending review").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let onEdit {
                    Button("Edit draft", systemImage: "pencil", action: onEdit)
                        .labelStyle(.iconOnly)
                        .buttonStyle(IconButtonStyle(padding: 2))
                        .padding(.vertical, -2)   // a 20 pt target in the caption row, which keeps its height
                        .controlSize(.small)
                        .help("Edit draft")
                        .accessibilityIdentifier("Edit draft")
                }
                Button("Delete", systemImage: "trash", action: onDelete)
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                    .padding(.vertical, -2)
                    .controlSize(.small)
                    .help("Delete draft")
                    .accessibilityIdentifier("Delete draft")
            }
            Text(verbatim: draft.body)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.wash(colorScheme, light: 0.50, dark: 0.65), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}
