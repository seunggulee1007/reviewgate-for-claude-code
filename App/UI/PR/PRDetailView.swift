import SwiftUI
import ReviewGateCore

/// The opened PR: header, then one of three views — the Conversation (§60, where it opens), every inline comment by
/// file and line ("Code comments"), or the changed-files list with the selected file's diff ("Files").
/// Expects a `PRStore` in the environment.
struct PRDetailView: View {
    /// §60: what the PR detail shows under its header.
    enum Page: Hashable { case conversation, codeComments, files }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(PRStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var showSubmitSheet = false
    /// `submittedAt` of the banner the user dismissed; a newer submit shows a fresh banner.
    @State private var dismissedBannerAt: Date?
    @State private var page: Page = .conversation
    /// A code comment's line to show in the Files view's diff (`PRDiffPane` takes it once the file's diff is there).
    @State private var lineJump: PRLineJump?
    @State private var jumpTick = 0

    var body: some View {
        VStack(spacing: 0) {
            if let pr = store.selected {
                header(pr)
                Divider()
                if let result = store.lastSubmitResult, dismissedBannerAt != result.submittedAt {
                    submitBanner(result)
                    Divider()
                }
                switch page {
                case .conversation:
                    PRConversationView()
                case .codeComments:
                    PRCodeCommentsView { line in show(line) }
                case .files:
                    HSplitView {
                        filesList
                            .frame(minWidth: 200, idealWidth: 260, maxWidth: 420)
                        PRDiffPane(file: store.selectedFile, diff: store.selectedDiff, truncated: store.selectedDiffTruncated,
                                   comments: store.comments.filter { $0.path == store.selectedFile?.filename }, jump: $lineJump)
                            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            } else if store.isLoading, let summary = store.selectedSummary {
                VStack(spacing: 8) {
                    ProgressView()
                    Text("Loading \(summary.repo)#\(summary.number)…").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Select a pull request", systemImage: "arrow.triangle.pull",
                                       description: Text("Choose a PR from the list to see its files and diff."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showSubmitSheet) { SubmitReviewSheet() }
        .onChange(of: store.selectedSummary?.id) { _, _ in   // another PR opens on its Conversation
            page = .conversation
            lineJump = nil
        }
    }

    /// §60: Conversation | Code comments (N) | Files (N).
    private var pagePicker: some View {
        Picker("Show", selection: $page) {
            Text("Conversation").tag(Page.conversation)
            Text("Code comments (\(store.comments.count))").tag(Page.codeComments)
            Text("Files (\(store.files.count))").tag(Page.files)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .help("The PR's conversation, every comment on its code by file and line, or its files and diff")
        .accessibilityIdentifier("PR detail page")
    }

    /// A code comment's row: its file in the Files view, scrolled to its line (the outdated ones open above the diff).
    private func show(_ line: PRCodeCommentLine) {
        guard let file = store.files.first(where: { $0.filename == line.path }) else { return }
        if store.selectedFile?.id != file.id { store.selectFile(file) }
        jumpTick += 1
        lineJump = PRLineJump(path: line.path, side: line.side, line: line.line, tick: jumpTick)
        page = .files
    }

    // MARK: Header

    private func header(_ pr: PRDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(pr.title).font(.headline).lineLimit(2)
                Text("#\(pr.number)").font(.headline.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Button("Open in browser", systemImage: "safari") {
                    if let url = URL(string: pr.url) { openURL(url) }
                }
                .controlSize(.small)
                PRClaudeHeaderButtons(pr: pr)   // wave3 mac-flow (§36.14): 워크벤치로 열기, 미해결 전체 보내기
                Button("Review (\(store.draftComments.count) drafts)", systemImage: "checkmark.bubble") {
                    showSubmitSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help("Submit the drafts as one review")
                .accessibilityIdentifier("Review")
            }
            HStack(spacing: 8) {
                Text(pr.author).foregroundStyle(.secondary)
                HStack(spacing: 3) {
                    Text(pr.headRefName).font(.caption.monospaced())
                    Image(systemName: "arrow.right").font(.caption2)
                    Text(pr.baseRefName).font(.caption.monospaced())
                }
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.secondary.wash(colorScheme, light: 0.12, dark: 0.18), in: RoundedRectangle(cornerRadius: 4))
                decisionBadge(pr)
                Spacer()
                Text("+\(pr.additions)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                Text("−\(pr.deletions)").font(.caption.monospacedDigit()).foregroundStyle(.red)
                Text("\(pr.changedFiles) files").font(.caption).foregroundStyle(.secondary)
            }
            .font(.callout)
            pagePicker.padding(.top, 4)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder
    private func decisionBadge(_ pr: PRDetail) -> some View {
        let (label, color): (String, Color) = switch pr.reviewDecision {
        case "APPROVED": (String(localized: "Approved"), .green)
        case "CHANGES_REQUESTED": (String(localized: "Changes requested"), .red)
        case "REVIEW_REQUIRED": (String(localized: "Review required"), .orange)
        default: (Self.stateLabel(pr.state), .secondary)
        }
        Text(label)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    /// `gh`'s OPEN / MERGED / CLOSED in the user's words ("Open" has its own key: the catalog's "Open" is the verb).
    private static func stateLabel(_ state: String) -> String {
        switch state.uppercased() {
        case "OPEN": String(localized: "pr.state.open", defaultValue: "Open")
        case "MERGED": String(localized: "Merged")
        case "CLOSED": String(localized: "Closed")
        default: state.capitalized
        }
    }

    // MARK: Submit result

    private func submitBanner(_ result: PRStore.SubmitResult) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            let eventLabel = eventLabel(result.event)
            Text("Review submitted (\(eventLabel)) · \(result.inlineCount) inline comment(s)")
                .font(.callout)
                .lineLimit(1)
            Button("Open on GitHub", systemImage: "arrow.up.right.square") {
                if let url = URL(string: result.reviewURL) { openURL(url) }
            }
            .controlSize(.small)
            .accessibilityIdentifier("Open on GitHub")
            Spacer()
            Button("Dismiss", systemImage: "xmark") { dismissedBannerAt = result.submittedAt }
                .labelStyle(.iconOnly)
                .buttonStyle(IconButtonStyle(padding: 2))
                .foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("Dismiss submit banner")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.green.wash(colorScheme, light: 0.12, dark: 0.20))
        .accessibilityIdentifier("Submit banner")
    }

    private func eventLabel(_ event: ReviewEvent) -> String {
        switch event {
        case .comment: String(localized: "Comment")
        case .approve: String(localized: "Approve")
        case .requestChanges: String(localized: "Request changes")
        }
    }

    // MARK: Files

    private var filesList: some View {
        let selectedID = Binding<PRFile.ID?>(
            get: { store.selectedFile?.id },
            set: { id in
                if let id, let file = store.files.first(where: { $0.id == id }) { store.selectFile(file) }
            }
        )
        return List(selection: selectedID) {
            Section("Files (\(store.files.count))") {
                ForEach(store.files) { file in
                    fileRow(file).tag(file.id)
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func fileRow(_ file: PRFile) -> some View {
        let count = store.comments.filter { $0.path == file.filename && $0.line != nil }.count
        let drafts = store.draftComments.filter { $0.path == file.filename }.count
        return HStack(alignment: .top, spacing: 6) {
            Text(statusGlyph(file.status))
                .font(.caption.weight(.bold).monospaced())
                .foregroundStyle(statusColor(file.status))
                .frame(width: 14, alignment: .center)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.filename).font(.callout).lineLimit(1).truncationMode(.middle)
                if let prev = file.previousFilename {
                    Text("from \(prev)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 4)
            if count > 0 {
                Label("\(count)", systemImage: "bubble.left").font(.caption2).foregroundStyle(.secondary)
            }
            if drafts > 0 {
                Label("\(drafts)", systemImage: "pencil.line")
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Color.orange.wash(colorScheme, light: 0.18, dark: 0.26), in: Capsule())
                    .foregroundStyle(.orange)
                    .help("\(drafts) draft comment(s)")
            }
            Text("+\(file.additions)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
            Text("−\(file.deletions)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
        }
        .padding(.vertical, 1)
    }

    private func statusGlyph(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "removed": "D"
        case "modified", "changed": "M"
        case "renamed": "R"
        case "copied": "C"
        default: "?"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "added": .green
        case "removed": .red
        case "modified", "changed": .orange
        case "renamed", "copied": .blue
        default: .secondary
        }
    }
}
