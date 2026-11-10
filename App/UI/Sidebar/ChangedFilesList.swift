import SwiftUI
import AppKit
import ReviewGateCore

/// Files changed on disk during the last turn (git checkpoint diff), with review state and Accept / Reject.
struct ChangedFilesList: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    /// Riskiest files first (sensitive, deleted, large, via Bash, config, tests); off = git order. ⌘] / ⌘[ and the move
    /// after a verdict read the same key (wave2 mac-flow, comp-10).
    @AppStorage(AppSettings.Key.changedFilesRiskOrder) private var riskOrder = true
    // MARK: wave4b w4b-bigturn — §39.1: the folders of a bulk list the user opened (folded by default) are
    // `model.changesExpandedFolders`, and agents-13's author filter `model.changesAuthorFilter` (kept across the tabs).
    // MARK: wave4b w4b-agents
    /// agents-13: the authors per path.
    @State private var authorsCache = FileAuthorsCache()
    // MARK: wave4b w4b-files
    /// §40.2: bumped when "묶기" changes (the choice lives in UserDefaults per project, `AppState.fileGroupBy`).
    @State private var groupByTick = 0

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            Divider()
            ViewingReviewNote()   // MARK: wave4b w4b-tabs — §39.2 "실행 중인 채팅('…')의 리뷰예요" while another chat is shown
            if let failure = store.reviewCollectFailed {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Could not collect the turn's changes", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.orange)
                    Text(verbatim: failure)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(6)
                    HStack(spacing: 6) {
                        Button("Retry") { store.retryCollectReview() }
                            .controlSize(.small)
                            .help("Collect the turn's changes again")   // polish P2-review-01
                            .accessibilityIdentifier("Retry collect")
                        // polish P2-review-41: the error's own words, to report or search them.
                        Button("Copy Error", systemImage: "doc.on.doc") { Clipboard.copy(failure, toast: String(localized: "Copied")) }
                            .controlSize(.small)
                            .help("Copy the error")
                            .accessibilityIdentifier("Copy collect error")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
                .accessibilityIdentifier("Collect error")
                Divider()
            }
            ReviewListNotices()   // MARK: wave4b w4b-bigturn (§39.1): large files left out, "대량 변경: 파일 N개"
            if store.changedFiles.isEmpty {
                List {
                    LiveChangesSection()   // wave2 mac-flow (§34.6): the running turn's changes so far
                    Section("Changes") {
                        // polish P2-review-04: what this list is for, and the way to the reviews done before.
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Nothing to review yet").font(.callout.weight(.medium))
                            Text("When Claude changes files, you accept or reject them here one by one")
                                .font(.caption).foregroundStyle(.secondary)
                                .lineLimit(3)   // the sidebar list keeps a row to one line unless told
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Show past reviews") { model.tab = .history }
                                .controlSize(.small)
                                .help("Open the History tab — the reviews of this worktree")
                                .accessibilityIdentifier("Empty changes show history")
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("Empty changes")
                    }
                }
                .listStyle(.sidebar)
            } else {
                // §31–32: the mods files first ("설정·훅"), then Claude's changes, then the changes from outside the app.
                // MARK: wave4b w4b-agents — agents-13: who changed each file; the filter with two or more authors.
                let authors = authorsCache.authors(store, files: store.changedFiles.map { ($0.path, $0.toolUseIds) })
                let offered = AgentGlance.authorFilters(store.changedFiles.map { authors[$0.path] ?? [] })
                let shownAuthor = offered.contains { $0.key == model.changesAuthorFilter } ? model.changesAuthorFilter : nil
                let keep: (ChangedFile) -> Bool = { f in shownAuthor == nil || (authors[f.path] ?? []).contains { $0.key == shownAuthor } }
                // wave4b w4b-bigturn: a bulk list by folder (§39.1) — folded from the files the author filter keeps, so a
                // folder's "<folder>/ N" counts what it opens to and a folder with none of them is not listed.
                // MARK: wave4b w4b-files — §40.2: + the "묶기" sections inside each group (`groupByTick`: a new choice redraws).
                let _ = groupByTick
                let sections = store.groupedListSections(riskOrder: riskOrder, keep: shownAuthor == nil ? nil : keep)
                AuthorFilterBar(offered: offered, selection: $model.changesAuthorFilter)
                List(selection: listSelection) {
                    LiveChangesSection()   // wave2 mac-flow (§34.6): read-only, above the review
                    if store.isReviewListStale {
                        // polish PX-17: the previous round's decided files are said, not dimmed to 2.5:1 contrast.
                        Label("Previous round — the new turn's changes are being collected", systemImage: "clock.arrow.circlepath")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)   // whole at the sidebar's width, not cut after "are bei…"
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("Previous round header")
                    }
                    ForEach(sections) { section in
                        Section {
                            ForEach((section.folder == nil || model.changesExpandedFolders.contains(section.id) ? section.files : []).filter(keep)) { file in
                                // MARK: wave4d w4d-speed — polish-09: the row under the pointer shows "Why?" (§21) from its
                                // own hover, so a move over the list no longer re-runs this body (sections, risk order, authors).
                                HoverRow { hovered in row(file, authors: authors[file.path] ?? [], hovered: hovered) }
                                    .tag(file.path)
                                    .contextMenu {
                                        // polish P2-review-03: the keys the menu bar has, shown in the row's menu too.
                                        if file.state == .accepted {
                                            Button("Undo Accept", systemImage: "arrow.uturn.left") { store.unaccept(file) }
                                                .keyboardShortcut("u", modifiers: [.command, .shift])
                                                .disabled(store.isReviewLocked)
                                        } else {
                                            // polish P2-review-23: Edit › Undo (⌘Z) takes it back.
                                            Button("Accept", systemImage: "checkmark") { ReviewUndo.accept(file, store: store) }
                                                .keyboardShortcut("a", modifiers: [.command, .shift])
                                                .disabled(file.state != .pending || store.isAcceptLocked)
                                        }
                                        // r2-review-flow M32: while Claude works the reject waits for the turn's end.
                                        Button(file.rejectScheduled ? ReviewFlowText.scheduledBadge : String(localized: "Reject"), systemImage: "arrow.uturn.backward") { ReviewUndo.reject(file, store: store) }
                                            .keyboardShortcut("r", modifiers: [.command, .shift])
                                            .disabled(file.state != .pending || store.isRejectLocked || file.uncaptured || file.rejectScheduled)
                                        Divider()
                                        Button("Mention in Chat", systemImage: "at") {
                                            model.mentionPaths = [file.path]
                                            model.mentionTick &+= 1
                                        }
                                        .disabled(file.status == .deleted)
                                        SideQuestionMenuItems(anchor: SideAnchor(path: file.path))
                                        Divider()
                                        // The file itself, without opening its diff first (a deleted one is not on disk).
                                        Button("Open in Editor", systemImage: "arrow.up.forward.app") { openInEditor(file) }
                                            .disabled(file.status == .deleted)
                                        Button("Reveal in Finder", systemImage: "folder") { revealInFinder(file) }
                                            .disabled(file.status == .deleted)
                                        // polish P2-review-03 / P2-review-08: the relative and the full path, each said copied.
                                        Button("Copy Path", systemImage: "doc.on.doc") { Clipboard.copy(file.path, toast: String(localized: "Path copied")) }
                                        Button("Copy Full Path", systemImage: "doc.on.doc") {
                                            if let path = absolutePath(file) { Clipboard.copy(path, toast: String(localized: "Path copied")) }
                                        }
                                    }
                                    .onDrag {
                                        // §23: dropped on the composer it becomes a mention (a file URL inside the repository).
                                        guard file.status != .deleted, let root = store.projectURL else { return NSItemProvider() }
                                        return NSItemProvider(object: root.appendingPathComponent(file.path) as NSURL)
                                    }
                                    // No tap gesture on the row: with one (even simultaneous, 0.5.2) the row's clicks stopped reaching
                                    // the List and only its very edges selected. The way back from the code browser is `listSelection`.
                            }
                        } header: {
                            sectionHeader(section, showsOrder: section.id == sections.first?.id)
                        }
                    }
                }
                .listStyle(.sidebar)
                // polish PX-08: ⌘C (Edit › Copy) with a row selected copies its path, as a Finder list does.
                .onCopyCommand {
                    guard let path = store.selectedPath else { return [] }
                    DispatchQueue.main.async { Toast.show(Clipboard.confirmation(for: path)) }
                    return [NSItemProvider(object: path as NSString)]
                }
                // MARK: wave4b w4b-bigturn — §39.1: a file selected by a shortcut / the diff opens its folder.
                .onChange(of: store.selectedPath) { _, path in
                    guard let path, let s = sections.first(where: { $0.folder != nil && $0.files.contains { $0.path == path } }) else { return }
                    model.changesExpandedFolders.insert(s.id)
                }
            }
        }
        // §31 (M3): Claude's changes are reverted; the ones from outside the app stay unless the user adds them after a
        // second confirmation with their list (`ReviewProvenanceModals`); uncaptured files are never sent (§32).
        .confirmationDialog("Reject all pending files?", isPresented: $model.showRejectAll, titleVisibility: .visible) {
            let plan = store.rejectAllPlan
            if !plan.claude.isEmpty {
                Button(String(localized: "Revert \(plan.claude.count) Claude change(s)"), role: .destructive) { store.rejectAll() }
                    .accessibilityIdentifier("Reject all confirm")
            }
            if plan.externalCount > 0 {
                // The dialog closes first; the second confirmation (with the files) opens right after it.
                Button("Revert changes from outside the app too…") { DispatchQueue.main.async { store.requestRejectAllIncludingExternal() } }
                    .accessibilityIdentifier("Reject all including external")
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(verbatim: store.rejectAllPlan.message)
        }
        .sheet(isPresented: $model.showAcceptAll) { AcceptAllSheet() }
        .sheet(isPresented: $model.showCommit) { CommitSheet() }
    }

    // M16: the review-integrity chips and the restored banner moved to `ReviewNoticesBar` (banner stack above the split).

    /// The list's selection: none while the code browser (§47) covers the diff, so a click on any row — the file selected
    /// before too — is a new selection, and `selectedPath`'s setter closes the browser and shows that file's diff.
    private var listSelection: Binding<String?> {
        let shown = store.codeBrowser.isOpen ? nil : store.selectedPath
        return Binding(get: { shown }, set: { store.selectedPath = $0 })
    }

    private var header: some View {
        let pending = store.pendingFiles.count
        let accepted = store.acceptedPaths.count
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("\(store.changedFiles.count) changed · \(pending) pending")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help("Next pending file ⌘] · previous ⌘[")   // polish P2-review-01 (Electron's words)
                Spacer()
                // wave2 mac-flow (§34.2): accept all also applies while a turn runs; reject all waits and says why.
                // r2-review-flow M28: at once with an undo toast; the summary sheet only when a file still needs a look.
                Button("Accept all") { AcceptAllAction.run(store: store, model: model) }
                    .controlSize(.small)
                    .disabled(pending == 0 || store.isAcceptLocked)
                    .help(pending == 0 ? String(localized: "No pending files") : (store.acceptLockReason ?? String.withKey(
                        store.acceptAllNeedsSheet ? String(localized: "Review a summary, then accept every pending file")
                            : String(localized: "Accept every pending file — the notice that follows can undo it"), action: "Accept All…")))
                    .accessibilityLabel("Accept all")
                    .accessibilityIdentifier("Accept all")
                Button("Reject all") { model.showRejectAll = true }
                    .controlSize(.small)
                    .disabled(pending == 0 || store.isRejectLocked)
                    .help(pending == 0 ? String(localized: "No pending files") : (store.rejectLockReason ?? String(localized: "Revert Claude's pending changes to the start of the turn; changes from outside the app stay unless you add them")))
                    .accessibilityLabel("Reject all")
                    .accessibilityIdentifier("Reject all")
            }
            if pending > 0, store.isRunning, !store.isShowingStaleDiff, let reason = store.rejectLockReason {
                // A blocked action is never only greyed out: one line says why — here unless the diff's banner says it.
                Text(verbatim: reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("Reject waits for the turn")
            }
            reviewProgress
            if !store.changedFiles.isEmpty || !store.flow.runs.isEmpty {
                PreReviewHeadControl()   // wave3 mac-flow (§36.13): AI 사전 리뷰 — status, cancel
            }
            // M12: commits the accepted files (docs/M12-COMMIT.md); enabled by the engine's `state.commit.canCommit`.
            HStack {
                // §31.5: always here — empties the list (and its notes) without touching a file.
                Button("Finish review…") { model.showFinishReview = true }
                    .controlSize(.small)
                    .disabled(!store.canFinishReview)
                    .help(store.finishReviewBlocker ?? String(localized: "Empty the review list without touching any file — what is still pending stays on disk as it is and becomes the baseline of the next message"))
                    .accessibilityLabel("Finish review")
                    .accessibilityIdentifier("Finish review")
                Spacer()
                // r2-review-flow M28: the sheet takes pending files too ("검토 완료로 표시하고 커밋").
                Button(accepted > 0 ? String(localized: "Commit accepted (\(accepted))…") : String(localized: "Commit…"), systemImage: "checkmark.seal") { model.showCommit = true }
                    .labelStyle(.titleOnly)
                    .controlSize(.small)
                    .disabled(!store.canOpenCommitSheet)
                    // A blocked action is never only greyed out (§37.1 and a turn, its collection, a revert).
                    .help(store.commitLockReason ?? (accepted > 0 ? String(localized: "Commit the accepted files (⌘⇧K)")
                        : String(localized: "Commit — the files you tick are marked reviewed as they are committed (⌘⇧K)")))
                    .accessibilityLabel("Commit accepted")
                    .accessibilityIdentifier("Commit accepted")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    /// "3/7 viewed": how much of the review the user has actually looked at (diffs shown this review).
    @ViewBuilder
    private var reviewProgress: some View {
        let total = store.changedFiles.count
        if total > 0 {
            let viewed = store.viewedChangedCount
            HStack(spacing: 8) {
                ProgressView(value: Double(viewed), total: Double(total))
                    .progressViewStyle(.linear)
                    .tint(viewed == total ? .green : .accentColor)
                    .controlSize(.small)
                Text("\(viewed)/\(total) viewed")
                    .font(.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(viewed == total ? Color.green : Color.secondary)
                    .fixedSize()
                // wave2 mac-flow (§34.5): viewed is per content — files that changed after you looked are counted apart.
                // wave3 check-clients: pending ones only, as the rows and Electron (a decided file has nothing left to look at).
                let changed = store.changedSinceViewedPendingFiles.count
                if changed > 0 {
                    Text("\(changed) changed since viewed")
                        .font(.caption.weight(.medium).monospacedDigit())
                        .foregroundStyle(.blue)
                        .fixedSize()
                        .accessibilityIdentifier("Changed since viewed count")
                }
            }
            .help("Files whose diff you have opened in this review")
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("Review progress")
        }
    }

    private func row(_ file: ChangedFile, authors: [AgentGlance.FileAuthor] = [], hovered: Bool = false) -> some View {
        let viewed = store.isViewed(file)   // wave2 mac-flow (§34.5): this content was shown
        let risks = FileRisk.risks(for: file)
        return HStack(alignment: .top, spacing: 6) {
            Circle()
                .fill(viewed ? Color.clear : Color.accentColor)
                .frame(width: 6, height: 6)
                .padding(.top, 6)
                .help(viewed ? String(localized: "Viewed") : String(localized: "Not viewed yet"))
                .accessibilityLabel(viewed ? String(localized: "Viewed") : String(localized: "Not viewed yet"))
            Text(file.status.rawValue)
                .font(.caption.weight(.bold).monospaced())
                .foregroundStyle(statusColor(file.status))
                .frame(width: 14, alignment: .center)
                .padding(.top, 2)
                .help(ReviewSpeech.status(file.status))   // polish P2-review-01: "수정됨", not a bare letter
                .accessibilityLabel(ReviewSpeech.status(file.status))   // MARK: wave4d w4d-speed — polish-10: "Modified", not "M"
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    pathText(FileGroups.compactPath(file.path))   // MARK: wave4b w4b-files — §40.2: the module kept
                        // polish PX-01: the full path (and a rename's old one) here — no longer a .help on the whole row,
                        // which hid every tooltip inside it.
                        .help(file.oldPath.map { String(localized: "\(file.path) (from \($0))") } ?? file.path)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    // polish P2-review-02: always laid out (the counts never jump under the pointer); shown on hover and on the
                    // selected row.
                    let showsWhy = hovered || store.selectedPath == file.path
                    AskWhyButton(anchor: SideAnchor(path: file.path), iconOnly: true)
                        .opacity(showsWhy ? 1 : 0)
                        .allowsHitTesting(showsWhy)
                        .accessibilityHidden(!showsWhy)
                    // wave4d w4d-speed (polish-10): read as one "12 lines added, 3 removed".
                    Text("+\(file.added)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                        .help(ReviewSpeech.counts(added: file.added, deleted: file.deleted))   // polish P2-review-01
                        .accessibilityLabel(ReviewSpeech.counts(added: file.added, deleted: file.deleted))
                    Text("−\(file.deleted)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
                        .help(ReviewSpeech.counts(added: file.added, deleted: file.deleted))
                        .accessibilityHidden(true)
                    // wave2 mac-flow (§34.4): unsent notes (what Request changes sends) apart from the sent ones awaiting 반영 확인.
                    let notes = store.unsentNotes.filter { $0.path == file.path }.count
                    if notes > 0 {
                        Label("\(notes)", systemImage: "text.bubble.fill")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.orange)
                            .labelStyle(.titleAndIcon)
                            .help(String(localized: "\(notes) notes"))
                            .accessibilityLabel(String(localized: "\(notes) notes"))
                            .accessibilityIdentifier("Note badge \(file.path)")
                    }
                    let requested = store.reviewNotes.filter { $0.path == file.path && $0.sent != nil }.count
                    if requested > 0 {
                        let text = String(localized: "Requested: \(String(requested))")
                        Label(String(requested), systemImage: "paperplane")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .labelStyle(.titleAndIcon)
                            .help(text)
                            .accessibilityLabel(text)
                            .accessibilityIdentifier("Sent note badge \(file.path)")
                    }
                    stateIndicator(file.state)
                }
                // Wraps: the mods risk badges (§32) are sentences, not words.
                FlowLayout(spacing: 4) {
                    SideBadge(threads: store.side.threads(onPath: file.path))
                    PreReviewFileBadge(path: file.path)   // wave3 mac-flow (§36.13)
                    // wave2 mac-flow: accepted, then changed again (opens "수락 이후"); changed after you viewed it.
                    if file.rejectScheduled, file.state == .pending {   // r2-review-flow M32 (§34.2)
                        TagChip(Text(verbatim: ReviewFlowText.scheduledBadge), systemImage: "clock.arrow.circlepath", tint: .red)
                            .help(ReviewFlowText.scheduledHelp)
                            .accessibilityIdentifier("Reject scheduled \(file.path)")
                    }
                    if file.changedSinceAccepted, file.state == .pending { ChangedAfterAcceptChip() }
                    if store.showsChangedSinceViewed(file) { ChangedSinceViewedChip() }   // wave3 check-clients: pending only
                    if store.unchangedSinceRequest(file) { UnchangedSinceRequestChip() }   // wave3 check-clients (as Electron)
                    if file.state == .accepted { AutoAcceptedChip(rule: file.autoAccepted, path: file.path) }   // MARK: wave4c w4c-trust (§41.2)
                    if file.partial {
                        TagChip(Text("Partial revert \(file.rejectedHunks)"), systemImage: "scissors", tint: .purple)
                            .help("Some parts were reverted on disk; the rest is still under review")
                            .accessibilityIdentifier("Partial badge \(file.path)")
                    }
                    ForEach(risks.filter { $0 != .viaBash }, id: \.self) { riskChip($0) }
                    ProvenanceChips(file: file)
                    FileAuthorChips(authors: authors)   // wave4b w4b-agents — agents-13
                    if risks.contains(.viaBash) {
                        riskChip(.viaBash)
                    } else {
                        ForEach(file.tools, id: \.self) { tool in
                            Text(tool)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Color.accentColor.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                                .help(String(localized: "Changed with Claude's \(tool) tool"))   // polish P2-review-01
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
        // MARK: wave4d w4d-speed — polish-10: one VoiceOver stop per file — status, path, counts, review state and badges.
        .accessibilityElement(children: .combine)
    }

    private func riskChip(_ risk: FileRisk) -> some View { RiskChip(risk: risk) }

    /// `file` in the worktree (nil without a project).
    private func absolutePath(_ file: ChangedFile) -> String? {
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return nil }
        return (root as NSString).appendingPathComponent(file.path)
    }

    /// The row menu's "Open in Editor": the editor the diff header's button would use (`DiffEditorButton`), at line 1.
    private func openInEditor(_ file: ChangedFile) {
        guard let path = absolutePath(file) else { return }
        (ExternalEditor.preferred ?? ExternalEditor.installed.first ?? .finder).open(path, line: 1)
    }

    /// "Reveal in Finder" straight from AppKit — `ExternalEditor.finder.open` would make Finder the remembered editor.
    private func revealInFinder(_ file: ChangedFile) {
        guard let path = absolutePath(file) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// "설정·훅 (Claude 동작 변경) N" / "Claude 변경 N" / "앱 밖 변경 M"; the first group carries the order picker.
    private func sectionHeader(_ section: ChangedFileSection, showsOrder: Bool) -> some View {
        HStack(spacing: 4) {
            if section.folder != nil {   // MARK: wave4b w4b-bigturn — §39.1: a bulk list's folder opens / folds
                let open = model.changesExpandedFolders.contains(section.id)
                Button {
                    if open { model.changesExpandedFolders.remove(section.id) } else { model.changesExpandedFolders.insert(section.id) }
                } label: {
                    Image(systemName: open ? "chevron.down" : "chevron.right").frame(width: 12)
                }
                .buttonStyle(.borderless)
                .help(open ? Text("Fold folder") : Text("Open folder"))   // polish P2-review-01
                .accessibilityLabel(open ? Text("Fold folder") : Text("Open folder"))
                .accessibilityIdentifier("Bulk folder toggle")
            }
            switch section.kind {
            case .mods: Image(systemName: "gearshape.2.fill").foregroundStyle(.red)
            case .external: Image(systemName: "tray.and.arrow.down.fill").foregroundStyle(.secondary)
            case .claude: EmptyView()
            }
            Text(verbatim: section.title)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(section.help)
            Spacer()
            if showsOrder {
                Picker("Order", selection: $riskOrder) {
                    Text("Risk first").tag(true)
                    Text("Git order").tag(false)
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .controlSize(.mini)
                .help("Order: riskiest files first, or the order git lists them")
                .accessibilityIdentifier("Changed files order")
                // MARK: wave4b w4b-files — §40.2 (comp-14): "묶기", kept per project; a bulk change folds by folder itself.
                Picker("Group the list", selection: Binding(get: { store.fileGroupBy }, set: { store.setFileGroupBy($0); groupByTick &+= 1 })) {
                    ForEach(FileGroupBy.allCases, id: \.self) { by in
                        Text(verbatim: by.label).tag(by)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .controlSize(.mini)
                .disabled(store.isBulkChange)
                .help(store.isBulkChange ? String(localized: "A bulk change is folded by folder") : String(localized: "Group the list"))
                .accessibilityIdentifier("Group by")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Changes section \(section.kind.rawValue)")
    }

    /// Directory in secondary color, last path component bold.
    private func pathText(_ path: String) -> Text {
        guard let slash = path.lastIndex(of: "/") else { return Text(path).bold() }
        let dir = String(path[...slash])
        let name = String(path[path.index(after: slash)...])
        return Text(dir).foregroundStyle(.secondary) + Text(name).bold()
    }

    @ViewBuilder
    private func stateIndicator(_ state: FileReviewState) -> some View {
        switch state {
        case .pending:
            // MARK: wave4d w4d-speed — polish-10: the dot and the marks have names, not only tooltips.
            Circle().fill(Color.orange).frame(width: 7, height: 7).help("Pending review")
                .accessibilityLabel(ReviewSpeech.state(.pending))
        case .accepted:
            Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.green).help("Accepted")
                .accessibilityLabel(ReviewSpeech.state(.accepted))
        case .rejected:
            Image(systemName: "arrow.uturn.backward").font(.caption2.weight(.bold)).foregroundStyle(.orange).help("Rejected")
                .accessibilityLabel(ReviewSpeech.state(.rejected))
        case .changesRequested:
            Label("Changes requested", systemImage: "exclamationmark.bubble.fill")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.orange)
                .labelStyle(.iconOnly)
                .help("Changes requested")
                .accessibilityLabel("Changes requested")
        }
    }

    private func statusColor(_ status: ChangeStatus) -> Color {
        switch status {
        case .added: .green
        case .modified: .orange
        case .deleted: .red
        case .renamed: .blue
        case .other: .secondary
        }
    }
}
