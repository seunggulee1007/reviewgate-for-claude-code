import SwiftUI
import AppKit
import ReviewGateCore

/// M16 banner tidy: the review-integrity signals (audit 1.1 / 1.2 / 1.3) and the "Review restored" banner live in
/// the one banner stack above the diff/chat split. Several integrity kinds merge into a single "N notices" chip
/// whose popover lists them all; the restored banner hides itself after 8 s — unless the review is stale or changes
/// from outside the app slipped in (§31). Above them, the §31–32 banners: nested repositories and settings.local.json
/// (red), HEAD moved and skipped files (orange), other Claude sessions in this worktree (yellow) — each says what
/// happened, offers what to do, and stays closed once closed (per turn; per process for other sessions).
struct ReviewNoticesBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    /// Which chip's popover is open.
    @State private var openChip: IntegrityChip?
    @State private var showMerged = false
    /// Nested-repository banners showing their touched files.
    @State private var expandedNested: Set<String> = []

    enum IntegrityChip: String, Identifiable, CaseIterable {
        case outside, ignored, filtered
        var id: String { rawValue }
    }

    /// True when anything is showing (the caller adds the divider).
    var isVisible: Bool { !store.reviewNotices.isEmpty || store.restoredBanner != nil || !activeKinds.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            // wave1 mac-review — §31–32 (each with its own divider; the caller's divider follows the legacy rows)
            ForEach(store.reviewNotices) { notice in
                noticeBanner(notice)
                Divider()
            }
            if let restored = store.restoredBanner {
                restoredBanner(restored)
                if !activeKinds.isEmpty { Divider() }
            }
            if !activeKinds.isEmpty {
                integrityChips
            }
        }
        .task(id: store.restoredBanner) {
            // Auto-hide 8 s after the restored review appears — only when nothing in it needs a look.
            guard let banner = store.restoredBanner, banner.autoHides else { return }
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled, store.restoredBanner?.autoHides == true { store.dismissRestoredBanner() }
        }
    }

    private var activeKinds: [IntegrityChip] { IntegrityChip.allCases.filter { !paths($0).isEmpty } }

    /// Blue: the pending review came back from `<gitdir>/reviewgate-review.json`. Orange, and it stays, when the review
    /// is stale or changes from outside the app slipped in meanwhile ("새로 끼어든 변경 N개").
    /// r2-review-flow M29 (§31.5): a stale review says so here with the sheet's two buttons — 정리… (finish_review, asked
    /// first) and 이어서 리뷰 (keep_review); the next message goes on with it too. It never blocks the window.
    private func restoredBanner(_ banner: RestoredReviewBanner) -> some View {
        let tint: Color = banner.autoHides ? .blue : .orange
        let stale = store.staleReview
        let text = stale.map(StaleReviewBannerText.message) ?? banner.message
        return HStack(spacing: 6) {
            Image(systemName: stale != nil ? "clock.badge.exclamationmark" : "clock.arrow.circlepath").foregroundStyle(tint)
            Text(verbatim: text)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .help(stale.map { ([banner.message] + $0.lines()).joined(separator: "\n") + "\n\n" + StaleReviewBannerText.help } ?? banner.message)
                .accessibilityIdentifier(stale != nil ? "Stale review text" : "Review restored text")
            Spacer(minLength: 4)
            if banner.externalCount > 0 {
                Button("Show changes from outside the app") { showExternalChanges() }
                    .controlSize(.small)
                    .help(ReviewProvenanceText.externalHelp)
                    .accessibilityIdentifier("Restored show external")
            }
            if stale != nil {
                Button("Clean up…") { model.showFinishReview = true }
                    .controlSize(.small)
                    .disabled(!store.canFinishReview)
                    .help(store.finishReviewBlocker ?? FinishReviewRules.confirmation(notes: store.unsentNotes.count))
                    .accessibilityIdentifier("Stale review clean up")
                Button("Keep reviewing") { store.keepReview() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .help("Keep this review as it is — sending a message keeps it too")
                    .accessibilityIdentifier("Stale review keep")
            } else if !banner.autoHides {
                Button("Finish review…") { model.showFinishReview = true }
                    .controlSize(.small)
                    .disabled(!store.canFinishReview)
                    .help(store.finishReviewBlocker ?? FinishReviewRules.confirmation(notes: store.unsentNotes.count))
                    .accessibilityIdentifier("Restored finish review")
            }
            if stale == nil {
                Button { store.dismissRestoredBanner() } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .help("Hide — it shows again when a review is restored")   // polish P1-chrome-18
                    .accessibilityLabel("Dismiss")
                    .accessibilityIdentifier("Dismiss restored banner")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.wash(colorScheme, light: 0.10, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Review restored banner")
    }

    // MARK: §31–32 banners (wave1 mac-review)

    private func severityTint(_ severity: ReviewNotice.Severity) -> Color {
        switch severity {
        case .critical: .red
        case .warning: .orange
        case .caution: .yellow
        }
    }

    private func icon(_ notice: ReviewNotice) -> String {
        switch notice.kind {
        case .nested: "arrow.triangle.branch"
        case .localSettings: "gearshape.2.fill"
        case .headMoved: "arrow.triangle.swap"
        case .concurrent: "person.2.fill"
        case .skipped: "eye.slash"
        }
    }

    private func isConcurrent(_ notice: ReviewNotice) -> Bool {
        if case .concurrent = notice.kind { return true }
        return false
    }

    private func noticeID(_ notice: ReviewNotice) -> String {
        switch notice.kind {
        case .nested: "Nested changes banner"
        case .localSettings: "Local settings banner"
        case .headMoved: "Head moved banner"
        case .concurrent: "Concurrent Claude banner"
        case .skipped: "Snapshot skipped banner"
        }
    }

    private func noticeBanner(_ notice: ReviewNotice) -> some View {
        let tint = severityTint(notice.severity)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon(notice)).foregroundStyle(tint)
                Text(verbatim: notice.message)
                    .font(.caption.weight(.medium))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("\(noticeID(notice)) text")
                Spacer(minLength: 4)
                noticeActions(notice)
                Button { store.dismissReviewNotice(notice) } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    // polish P1-chrome-18: when it comes back — other sessions once the app opens again, the rest next turn.
                    .help(isConcurrent(notice) ? String(localized: "Hide until the app restarts") : String(localized: "Hide for this turn"))
                    .accessibilityLabel("Dismiss")
                    .accessibilityIdentifier("Dismiss \(noticeID(notice))")
            }
            ForEach(notice.details, id: \.self) { line in
                Text(verbatim: line)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case let .nested(repo) = notice.kind, expandedNested.contains(notice.id) {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(repo.touchedFiles, id: \.self) { path in
                        Text(verbatim: path)
                            .font(.caption2.monospaced())
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                            .help(path)
                            // polish P1-chrome-35: the nested repository's file — Finder and its path.
                            .contextMenu { pathMenu(nestedPath(repo.path, path), outside: false) }
                    }
                }
                .padding(.leading, 20)
                .accessibilityIdentifier("Nested touched files")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.wash(colorScheme, light: 0.10, dark: 0.18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(noticeID(notice))
    }

    @ViewBuilder
    private func noticeActions(_ notice: ReviewNotice) -> some View {
        switch notice.kind {
        case let .nested(repo):
            if !repo.touchedFiles.isEmpty {
                let expanded = expandedNested.contains(notice.id)
                Button(expanded ? String(localized: "Hide files") : String(localized: "Files (\(repo.touchedFiles.count))")) {
                    if expanded { expandedNested.remove(notice.id) } else { expandedNested.insert(notice.id) }
                }
                .controlSize(.small)
                .accessibilityIdentifier("Nested toggle files")
            }
            if repo.kind == .worktree, let url = absoluteURL(repo.path) {
                Button("Open as workbench") { ProjectOpener.openInNewWindow(url, openWindow: openWindow) }
                    .controlSize(.small)
                    .help("Open this worktree in its own window, with its own review")
                    .accessibilityIdentifier("Nested open workbench")
            } else if let url = absoluteURL(repo.path) {
                Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    .controlSize(.small)
                    .accessibilityIdentifier("Nested reveal")
            }
        case let .localSettings(change):
            Button("Open file") { openSettingsFile(change.path) }
                .controlSize(.small)
                .accessibilityIdentifier("Local settings open file")
        case .headMoved:
            if store.externalPendingCount > 0 {
                Button("Show changes from outside the app") { showExternalChanges() }
                    .controlSize(.small)
                    .help(ReviewProvenanceText.externalHelp)
                    .accessibilityIdentifier("Head moved show external")
            }
        case .concurrent:
            Button("Create workbench") { model.showNewWorkbench = true }
                .controlSize(.small)
                .disabled(store.projectInfo == nil)
                .help("A git worktree on a new branch with its own window and Claude session — its changes stay out of this review")
                .accessibilityIdentifier("Concurrent create workbench")
        case let .skipped(files):
            Button("Add to ignore patterns") { ignore(files.map(\.path), notice: notice) }
                .controlSize(.small)
                .help("Adds these paths to Settings › Checkpoint ignore patterns, so the next snapshots stop trying them")
                .accessibilityIdentifier("Snapshot skipped ignore")
        }
    }

    /// A repo-relative path inside this worktree, absolute.
    private func absoluteURL(_ relative: String) -> URL? {
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return nil }
        return URL(fileURLWithPath: (root as NSString).appendingPathComponent(relative))
    }

    /// The preferred editor when one was picked, else the system's app for the file; a deleted file reveals its folder.
    private func openSettingsFile(_ relative: String) {
        guard let url = absoluteURL(relative) else { return }
        guard FileManager.default.fileExists(atPath: url.path) else {
            NSWorkspace.shared.activateFileViewerSelecting([url.deletingLastPathComponent()])
            return
        }
        if let editor = ExternalEditor.preferred, editor != .finder {
            editor.open(url.path, line: 1)
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// The first external file in the diff pane (back from a history view, on the Changes tab).
    private func showExternalChanges() {
        guard let file = store.pendingFiles.first(where: \.isExternal) ?? store.changedFiles.first(where: \.isExternal) else { return }
        store.closeHistoryDiff()
        if model.tab != .changes { model.tab = .changes }
        store.selectFile(file)
    }

    /// The patterns are global: every open window's engine gets them.
    private func ignore(_ paths: [String], notice: ReviewNotice) {
        store.addIgnorePatterns(paths)
        for other in WorkbenchRegistry.shared.allStores where other !== store { other.pushIgnorePatterns() }
        store.dismissReviewNotice(notice)
    }

    /// One amber chip per kind — or a single "N notices" chip when more than one kind is active.
    private var integrityChips: some View {
        HStack(spacing: 6) {
            let kinds = activeKinds
            if kinds.count > 1 {
                let total = kinds.reduce(0) { $0 + paths($1).count }
                chipButton(String(localized: "\(total) notices"), isOn: $showMerged, id: "Notices chip",
                           help: String(localized: "Edits outside the project, gitignored writes and pattern-filtered paths this turn")) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(kinds) { kind in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(chipTitle(kind)).font(.subheadline.weight(.semibold))
                                    chipList(kind)
                                }
                            }
                        }
                        .padding(12)
                        .frame(width: 380, alignment: .leading)
                    }
                    .frame(maxHeight: 360)
                    .accessibilityIdentifier("Integrity list merged")
                }
            } else if let kind = kinds.first {
                chipButton(chipTitle(kind),
                           isOn: Binding(get: { openChip == kind }, set: { openChip = $0 ? kind : nil }),
                           id: chipID(kind), help: chipHelp(kind)) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(chipHelp(kind)).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Divider()
                            chipList(kind)
                        }
                        .padding(12)
                        .frame(width: 380, alignment: .leading)
                    }
                    .frame(maxHeight: 320)
                    .accessibilityIdentifier("Integrity list \(kind.rawValue)")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(Color.orange.wash(colorScheme, light: 0.06, dark: 0.14))
    }

    private func chipButton<Content: View>(_ title: String, isOn: Binding<Bool>, id: String, help: String,
                                           @ViewBuilder popover: @escaping () -> Content) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Color.orange.wash(colorScheme, light: 0.18, dark: 0.26), in: Capsule())
                .foregroundStyle(.orange)
        }
        .buttonStyle(.plain)
        .hoverHighlight(cornerRadius: 9)   // polish P1-chrome-15: a chip that opens something answers the pointer
        .help(help)
        .accessibilityIdentifier(id)
        .popover(isPresented: isOn, arrowEdge: .bottom, content: popover)
    }

    private func paths(_ kind: IntegrityChip) -> [String] {
        switch kind {
        case .outside: store.changedOutside
        case .ignored: store.ignoredTouched
        case .filtered: store.filteredByPattern
        }
    }

    private func chipID(_ kind: IntegrityChip) -> String {
        switch kind {
        case .outside: "Changed outside chip"
        case .ignored: "Ignored touched chip"
        case .filtered: "Filtered by pattern chip"
        }
    }

    private func chipTitle(_ kind: IntegrityChip) -> String {
        switch kind {
        case .outside: String(localized: "\(store.changedOutside.count) edits outside the project")
        case .ignored: String(localized: "\(store.ignoredTouched.count) ignored files touched")
        case .filtered: String(localized: "\(store.filteredByPattern.count) filtered by pattern")
        }
    }

    private func chipHelp(_ kind: IntegrityChip) -> String {
        switch kind {
        case .outside: String(localized: "Files outside the project Claude edited this turn — not part of the review and not reverted by Reject")
        case .ignored: String(localized: "Gitignored files Claude wrote this turn — invisible to the review list")
        case .filtered: String(localized: "Changed files hidden by the checkpoint ignore patterns (Settings)")
        }
    }

    private func chipList(_ kind: IntegrityChip) -> some View {
        ForEach(paths(kind), id: \.self) { path in
            // r1-scope (§8): a note Claude wrote into its own memory says so, with [열기]; other paths reveal in Finder.
            if kind == .outside, let memory = ScopeText.memoryFile(path) {
                HStack(spacing: 6) {
                    Label(ScopeText.memoryLabel(memory), systemImage: "brain")
                        .font(.callout)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Open") { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                        .controlSize(.small)
                        .help(path)
                        .accessibilityIdentifier("Open memory note \(memory)")
                }
                .help(path)
                .accessibilityIdentifier("Integrity path \(path)")
            } else {
                Button {
                    reveal(path, kind: kind)
                } label: {
                    Label(path, systemImage: kind == .outside ? "arrow.up.forward.app" : "doc")
                        .font(.callout.monospaced())
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverHighlight(cornerRadius: 5)   // polish P1-chrome-15
                // polish P1-chrome-35: what a click does, and the row's menu (Finder, its path, open an outside file).
                .help(String(localized: "Show in Finder — \(path)"))
                .contextMenu { pathMenu(absolutePath(path, kind: kind), outside: kind == .outside) }
                .accessibilityIdentifier("Integrity path \(path)")
            }
        }
    }

    /// Outside paths are absolute; the others are repo-relative.
    private func reveal(_ path: String, kind: IntegrityChip) {
        guard let absolute = absolutePath(path, kind: kind) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: absolute)])
    }

    /// A chip's path as an absolute one (outside paths already are; nil without a project).
    private func absolutePath(_ path: String, kind: IntegrityChip) -> String? {
        if kind == .outside || path.hasPrefix("/") { return path }
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return nil }
        return (root as NSString).appendingPathComponent(path)
    }

    /// A file a nested repository's banner lists (relative to that repository, which is relative to this worktree).
    private func nestedPath(_ repo: String, _ file: String) -> String? {
        absoluteURL(repo).map { $0.appendingPathComponent(file).path }
    }

    /// polish P1-chrome-35: a listed path's menu — Finder, its path (said copied), and an outside file opened.
    @ViewBuilder
    private func pathMenu(_ absolute: String?, outside: Bool) -> some View {
        if let absolute {
            Button("Reveal in Finder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: absolute)]) }
            Button("Copy Path", systemImage: "doc.on.doc") { Clipboard.copy(absolute, toast: String(localized: "Path copied")) }
            if outside {
                Button("Open", systemImage: "arrow.up.forward.app") { NSWorkspace.shared.open(URL(fileURLWithPath: absolute)) }
            }
        }
    }
}
