import SwiftUI
import ReviewGateCore

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the composer is its own view with its own state (`ComposerModel`): a
// keystroke redraws the composer and the palettes over the transcript, never the chat around them, its rows or their
// lookups. Everything else as before (§44.1: ⇧⇥ modes, Esc, ↑ / ↓ history that keeps the draft, the mode line, the
// mention popover, chips, send).

/// What the composer holds; the palettes over the transcript (`ComposerPalettes`) read it too.
@MainActor
@Observable
final class ComposerModel {
    var draft = ""
    /// UTF-16 caret offset (the @-mention popover).
    var caret = 0
    var caretRequest: Int?
    var height: CGFloat = 22
    var inputFocused = false
    // §23 / §24: what goes out with the text, and the @-mention popover.
    var mentions: [String] = []
    var images: [ComposerImage] = []
    var mentionDismissed = false
    var mentionIndex = 0
    var mentionResults: [FileItem] = []
    var mentionLoading = false
    /// polish P4-composer-22: why the last `list_files` failed (nil: it answered); its retry bumps `mentionRetry`.
    var mentionError: String?
    var mentionRetry = 0
    /// Slash palette: opened by ⌘/ over a typed draft (until the draft changes), closed by Esc until the draft changes.
    var paletteForced = false
    var paletteDismissed = false
    var paletteIndex = 0
    /// A refused paste / drop / attachment, shown above the composer for a few seconds.
    var notice: String?
    var dropHover = false
    /// ↑ / ↓ in an empty composer: this project's previous prompts.
    @ObservationIgnored var history = PromptHistoryNavigator(entries: [])
    /// §56.3: ⌃G — the draft out in an external editor.
    let externalEditor = ComposerExternalEditor()
    // MARK: r1-composer M12 — the window keeps this composer (§38.1)
    /// The chat the draft belongs to (`AppState.draftChatId` when the composer last followed it): the chat may have changed
    /// while the chat column was away (the PRs tab, an engine that stopped).
    @ObservationIgnored var draftChatId: String?
    /// False until the composer first followed a chat (its window opened): an empty box then gets the chat's saved draft.
    @ObservationIgnored var draftChatBound = false

    // MARK: Mentions (§23)

    /// The `@token` at the caret (only with a project open).
    func mentionQuery(projectOpen: Bool) -> (range: NSRange, query: String)? {
        guard projectOpen else { return nil }
        return ComposerMentions.activeQuery(in: draft, caret: caret)
    }

    func mentionVisible(projectOpen: Bool) -> Bool { mentionQuery(projectOpen: projectOpen) != nil && !mentionDismissed }

    /// "@변경된 파일" first (when the review has files and the query fits it), then the engine's matches.
    func mentionEntries(changedFiles: [ChangedFile], projectOpen: Bool) -> [MentionEntry] {
        let changed = ComposerMentions.changedFileMentions(changedFiles)
        let q = (mentionQuery(projectOpen: projectOpen)?.query ?? "").lowercased()
        let offersChanged = !changed.isEmpty && (q.isEmpty || "changed".hasPrefix(q) || String(localized: "Changed files").lowercased().hasPrefix(q))
        return (offersChanged ? [.changedFiles(count: changed.count)] : []) + mentionResults.map(MentionEntry.item)
    }

    func pickMention(_ entry: MentionEntry, store: AppState) {
        if let query = mentionQuery(projectOpen: store.projectInfo != nil) {
            let removed = ComposerMentions.removing(query.range, from: draft)
            draft = removed.text
            caretRequest = removed.caret
        }
        switch entry {
        case .changedFiles: addMentions(ComposerMentions.changedFileMentions(store.changedFiles))
        case let .item(item): addMentions([item.path + (item.isDirectory ? "/" : "")])
        }
        mentionResults = []
        inputFocused = true
    }

    func addMentions(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        mentions = ComposerMentions.adding(paths, to: mentions)
        let kept = Set(mentions.map(ComposerMentions.normalized))
        if paths.contains(where: { !kept.contains(ComposerMentions.normalized($0)) }) {
            notice = EngineMessages.refusal(error: "too_many_mentions")
        }
    }

    // MARK: Slash palette

    /// The `/token` being typed at the start of the draft; nil once a space follows it (or there is no slash).
    var slashToken: String? {
        guard draft.hasPrefix("/") else { return nil }
        let rest = draft.dropFirst()
        guard rest.firstIndex(where: \.isWhitespace) == nil else { return nil }
        return String(rest)
    }

    /// r1-composer M14: `available` is an open project (`AppState.canUseSlashPalette`) — the palette works while Claude
    /// works or the session starts too; a pick goes into the draft, ↩ then sends, steers or queues it as any message.
    func paletteVisible(available: Bool) -> Bool {
        available && !paletteDismissed && (paletteForced || slashToken != nil)
    }

    /// wave3 mac-session (§36.5): the session's commands grouped by source with this project's recently used first; one
    /// ranked list while a `/token` is typed.
    func paletteSections(_ store: AppState) -> [SlashCommandSection] {
        SlashCommandCatalog.sections(entries: store.slashEntries, query: slashToken ?? "", recents: store.slashRecents)
    }

    /// The palette's rows in display order (what ↑ / ↓ walk through).
    func paletteEntries(_ store: AppState) -> [SlashCommandEntry] { SlashCommandCatalog.flatten(paletteSections(store)) }

    /// ⌘/: an empty draft becomes "/" — what is typed next filters the commands and deleting the "/" closes the palette;
    /// over a typed draft the palette opens as it is and a pick goes in front of the text.
    func openPalette(available: Bool) {
        guard available else { return }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draft = "/"
            caretRequest = 1
        } else {
            paletteForced = true
        }
        paletteDismissed = false
        paletteIndex = 0
        inputFocused = true
    }

    func closePalette() {
        paletteForced = false
        paletteDismissed = true
    }

    /// Replaces the typed `/token` (or prepends when the draft has none) with `/name `.
    func pick(_ entry: SlashCommandEntry, store: AppState) {
        store.recordSlashCommand(entry.name)   // wave3 mac-session: recently used first next time
        let inserted = "/\(entry.name) "
        if draft.hasPrefix("/") {
            let rest = draft.dropFirst()
            let end = rest.firstIndex(where: \.isWhitespace) ?? rest.endIndex
            draft = inserted + rest[end...].drop(while: \.isWhitespace)
        } else {
            draft = inserted + draft
        }
        closePalette()
        inputFocused = true
    }

    // MARK: Draft

    /// The chips' mentions (normalized for the wire) and images; the composer is emptied of them.
    func takeInputs(history entries: [String]) -> ([String], [ComposerImage]) {
        defer { mentions = []; images = [] }
        history.reset(entries: entries)   // wave6 w6-terminal (§44.1): a prompt goes out — the parked draft with it
        return (mentions.map(ComposerMentions.normalized), images)
    }

    func setDraftFromHistory(_ text: String) {
        draft = text
        // The palette would open on a recalled "/command"; it stays closed until the user types.
        DispatchQueue.main.async { self.paletteDismissed = true }
    }

    func insertAtSign() {
        let ns = draft as NSString
        let at = min(caret, ns.length)
        let needsSpace = at > 0 && !(ns.substring(with: NSRange(location: at - 1, length: 1)).first?.isWhitespace ?? true)
        let insert = needsSpace ? " @" : "@"
        draft = ns.replacingCharacters(in: NSRange(location: at, length: 0), with: insert)
        caretRequest = at + (insert as NSString).length
        inputFocused = true
    }

    /// Paste / drop / attach: images become chips, repository files mentions; the rest is explained.
    func takeDrop(_ drop: ComposerDrop, root: URL?) -> Bool {
        let result = ComposerIntake.take(drop, root: root, existingImages: images.count)
        images += result.images
        addMentions(result.mentions)
        notice = result.problems.isEmpty ? nil : result.problems.joined(separator: "\n")
        // r2-chats-cards M34 (§24): a big screenshot is attached scaled down — said once, not refused.
        if let first = result.resized.first, let from = first.resizedFrom {
            Toast.show(String(localized: "Scaled down to fit: \(ByteCountFormatter.string(fromByteCount: Int64(from), countStyle: .file)) → \(ByteCountFormatter.string(fromByteCount: Int64(first.data.count), countStyle: .file))"),
                       systemImage: "arrow.down.right.and.arrow.up.left")
        }
        return true
    }

    /// §56.2: messages Esc or ↑ gave back go in front of what is typed (one per paragraph), the caret after them.
    func takeGivenBack(_ text: String) {
        let base = history.cancel() ?? draft
        draft = base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : text + "\n\n" + base
        caretRequest = (text as NSString).length
        inputFocused = true
    }

    /// wave3 mac-flow / mac-agents: a draft handed over by another view (PR comments §36.14, an agent's report §36.1 —
    /// `WindowModel.insertIntoComposer`) joins what is typed — never sent by itself.
    func takeComposerDraft(_ model: WindowModel) {
        guard let text = model.composerDraft else { return }
        model.composerDraft = nil
        // wave6 w6-terminal (§44.1): while a recalled prompt is shown, the text joins the draft typed before ↑.
        let base = history.cancel() ?? draft
        draft = base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : base + "\n\n" + text
        caretRequest = (draft as NSString).length
        inputFocused = true
    }
}

/// The mention popover and the slash palette, over the transcript's bottom edge (they follow the draft and the caret).
struct ComposerPalettes: View {
    @Environment(AppState.self) private var store
    #if DEBUG
    @Environment(WindowModel.self) private var model
    #endif
    let composer: ComposerModel

    var body: some View {
        let projectOpen = store.projectInfo != nil
        if let query = composer.mentionQuery(projectOpen: projectOpen), !composer.mentionDismissed {
            MentionPalette(query: query.query, entries: composer.mentionEntries(changedFiles: store.changedFiles, projectOpen: projectOpen),
                           selection: composer.mentionIndex, isLoading: composer.mentionLoading, error: composer.mentionError,
                           onPick: { composer.pickMention($0, store: store) },
                           onHover: { composer.mentionIndex = $0 },
                           onRetry: { composer.mentionRetry &+= 1 })
        } else if composer.paletteVisible(available: store.canUseSlashPalette) {   // r1-composer M14: while Claude works too
            // wave3 mac-session (§36.5): descriptions, hints, groups, recently used first, "Starting session…".
            let sections = composer.paletteSections(store)
            SlashCommandPalette(sections: sections, selection: composer.paletteIndex,
                                emptyState: store.slashPaletteEmptyState(shown: SlashCommandCatalog.flatten(sections)),
                                cached: store.capabilitiesAreCached, starting: store.isSessionStarting,
                                onPick: { composer.pick($0, store: store) },
                                onHover: { composer.paletteIndex = $0 })   // polish P4-composer-23
            #if DEBUG
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.debugPaletteFrame = $0 }   // the composer check
                .onAppear { model.debugPaletteRows = SlashCommandCatalog.flatten(sections).map(\.name) }
                .onChange(of: SlashCommandCatalog.flatten(sections).map(\.name)) { _, rows in model.debugPaletteRows = rows }
                .onDisappear { model.debugPaletteFrame = .zero; model.debugPaletteRows = [] }
            #endif
        }
    }
}

struct ChatComposer: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Bindable var composer: ComposerModel
    /// The transcript's scroll state: a sent message follows the bottom again.
    let transcript: TranscriptViewState
    // r1-composer M11: the row under the box, measured — its width, the secondary controls at their own width, Stop and the
    // send button (`barCompact`).
    @State private var barWidth: CGFloat = 0
    @State private var barSecondaryWidth: CGFloat = 0
    @State private var barStopWidth: CGFloat = 0
    @State private var barPrimaryWidth: CGFloat = 0
    @AppStorage(TextScale.key) private var textScale = TextScale.standard   // polish PX-12: the message box's font follows it
    /// ↩ sends, ⇧↩ is a new line (Settings › General); off: ↩ is a new line and ⌘↩ sends.
    @AppStorage(AppSettings.Key.returnSends) private var returnSends = true
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49
    /// polish P4-composer-16: the height the box's top edge was dragged to (0: never) — the box is at least that tall, and grows
    /// with its text up to 40 % of the window (at least 128 pt), more when dragged higher, never past 60 %.
    @AppStorage("composerDraggedHeight") private var draggedHeight: Double = 0
    /// The window's height, for those limits.
    @State private var windowHeight: CGFloat = 637
    private var inputHeightLimits: (min: CGFloat, max: CGFloat) {
        InputHeightHandle.limits(dragged: draggedHeight, window: windowHeight)
    }

    /// The queue bar, apart from `body`: inline, its closures made the Release build's type checker give up (0.5.14).
    /// Its tools' frames go to the composer check in DEBUG builds only, where `debugQueueTools` exists.
    private var queueBar: ComposerQueueBar {
        var bar = ComposerQueueBar(messages: store.queuedMessages,
                         steering: store.steeringMessages,   // MARK: composer (§50.2)
                         takingBack: store.steeringTakingBack,   // §50.3
                         onTakeBack: { id, edit in Task { await store.takeBackSteering(id: id, toComposer: edit) } },
                         onEditInComposer: { store.editQueuedInComposer(id: $0) },
                         stopAndSend: store.sendAfterInterrupt,
                         pausedReason: store.queuePausedReason,
                         holdReason: store.queueHoldReason,
                         waitingOnAgents: store.waitingOnAgents != nil,   // wave3 mac-agents (§36.4)
                         onUpdate: { store.updateQueued(id: $0, text: $1) },
                         onRemove: { store.removeQueued(id: $0) },
                         onSendNow: { store.sendQueuedNow(id: $0) },   // MARK: composer (§50.2)
                         sendNowAction: { store.queuedSendNowAction(id: $0) },
                         onMove: { store.moveQueued(id: $0, by: $1) },
                         onResume: { store.resumeQueue() },
                         onClear: { store.clearQueue() })
        #if DEBUG
        bar.debugToolFrame = { model.debugQueueTools[$0] = $1 }   // the composer check (§50.3)
        #endif
        return bar
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewingChatBar()   // MARK: wave4b w4b-tabs — §39.2 "이 채팅을 보는 중이에요 — 보내면 이 채팅으로 이어가요"
            if pendingReviewCount > 0 {
                PendingReviewNotice(count: pendingReviewCount)   // r1-composer M11: one line, the why in its ⓘ
            }
            if let failure = store.reviewCollectFailed, store.viewingChat == nil {
                CollectFailedNotice(detail: failure)   // r2-review-flow M30: the input stays open; Retry right here
            }
            if !store.queuedMessages.isEmpty || store.sendAfterInterrupt != nil || !store.steeringMessages.isEmpty {
                queueBar
                #if DEBUG
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.debugQueueBarFrame = $0 }   // the composer check
                    .onDisappear { model.debugQueueBarFrame = .zero }
                #endif
            }
            if let warning = store.contextWarning {
                ContextWarningBanner(warning: warning)
            }
            if let notice = composer.notice {
                HStack(alignment: .top, spacing: 6) {
                    Label(notice, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    // polish P4-composer-17: closed by hand; a notice of several lines stays until then.
                    Button { composer.notice = nil } label: { Image(systemName: "xmark").font(.caption2.weight(.semibold)) }
                        .buttonStyle(.icon)
                        .help("Close")
                        .accessibilityLabel(Text("Close the notice"))
                }
                .transition(.opacity)
                .accessibilityIdentifier("Composer notice")
            }
            ComposerBtwSlot()   // §56.1: the /btw answer, over the box
            ComposerExternalEditorBar(editor: composer.externalEditor)   // §56.3: "Editing in …" while the draft is out
            inputBox
            if store.canPickPermissionMode {
                ComposerModeLineView()   // MARK: wave6 w6-terminal — §44.1: "⏵⏵ 자동 모드 (shift+tab 전환)"
            }
            HStack {
                if store.isSessionEnded {
                    Label("Session ended", systemImage: "bolt.slash")
                        .font(.caption).foregroundStyle(.orange)
                        .accessibilityIdentifier("Session ended")
                    Button("Restart", systemImage: "arrow.clockwise") { store.reconnectSession() }
                        .controlSize(.small)
                        .disabled(!store.canRestartSession)
                        .help(store.canRestartSession ? String(localized: "Reconnects this chat") : (store.cannotSendReason ?? String(localized: "Reconnects this chat")))
                        .accessibilityLabel("Restart session")
                        .accessibilityIdentifier("Restart session")
                    if store.hasChatSessions {
                        Button("New chat", systemImage: "plus.bubble") { store.startNewChat() }
                            .controlSize(.small)
                            .disabled(store.newChatBlocker != nil)   // r2-chats-cards M31 (§9)
                            .help(store.newChatBlocker ?? String(localized: "Continue in a fresh chat; this one stays in the history"))
                            .accessibilityIdentifier("New chat from ended session")
                    }
                } else if let waiting = store.waitingOnAgents, pendingToolPermission == nil, store.state.gate.blockedReason == .running,
                          !store.isExternalTurn {
                    AgentWaitStatusLine(waiting: waiting, queueHint: canQueue)   // wave3 mac-agents (§36.4)
                } else if store.viewingChat != nil {
                    // MARK: wave4b w4b-tabs — §39.2: why a send from this chat waits, else the plain hint
                    // r2-chats-cards M33 (§9): while Claude works in the live chat a send waits for it, it is not refused.
                    let viewingHint = store.viewingSendBlocker ?? (store.viewingSendWait != nil ? viewingWaitHint : sendHint)
                    Text(viewingHint)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .help(viewingHint)
                        .accessibilityIdentifier("Viewing chat hint")
                } else if question != nil {
                    // r1-composer M08: ↩ answers Claude's open question (the card above); ⌥↩ sends the text apart from it.
                    Text(verbatim: questionHint)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .help(questionHint)   // polish P4-composer-14: the whole line on hover
                        .accessibilityIdentifier("Question hint")
                } else if cardForDraft != nil {
                    // r2-chats-cards M24 (§33.10): a card waits and text is typed — the send key denies it with this text.
                    Text(verbatim: denyDraftHint)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .help(denyDraftHint)
                        .accessibilityIdentifier("Deny with text hint")
                } else if let reason = store.cannotSendReason {
                    let line = pendingToolPermission != nil && trimmedDraft.isEmpty
                         ? String(localized: "\(reason) — ⌘↩ allow · ⌘⌫ deny")
                         : canSteer ? (returnSends ? String(localized: "\(reason) — ↩ sends it to Claude now") : String(localized: "\(reason) — ⌘↩ sends it to Claude now"))
                         // r2-review-flow M30: ↩ restarts an ended session and sends the message once it is up.
                         : store.isSessionEnded && store.canRestartSession ? String(localized: "Session ended — \(KeyHint.sendKey) restarts it and sends your message")
                         : canQueue ? (returnSends ? String(localized: "\(reason) — ↩ queues your message") : String(localized: "\(reason) — ⌘↩ queues your message")) : reason
                    Text(line)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .help(line)   // polish P4-composer-14: the whole line on hover
                } else {
                    // A narrow chat pane drops the hint instead of stacking it letter by letter.
                    ViewThatFits(in: .horizontal) {
                        Text(verbatim: sendHint).font(.caption).foregroundStyle(.secondary).fixedSize()
                        Color.clear.frame(width: 0, height: 0)
                    }
                }
                CapabilitiesCaption(compact: barCompact)   // r1-composer M11: an icon when the row folds
                Spacer(minLength: 0)
                stopButtons
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barStopWidth = $0 }
                // r1-composer M11: at a narrow width these fold into "⋯" (the model and the mode as icons) — the send button
                // never leaves the window.
                secondaryControls(compact: barCompact, measuring: false)
                primaryButton
                    .fixedSize()
                    .layoutPriority(1)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barPrimaryWidth = $0 }
                    #if DEBUG
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.debugSendFrame = $0 }   // the layout check
                    #endif
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
            .background(alignment: .topLeading) {
                // r1-composer M11: the secondary controls at their own width — hidden, never answering a key or a click. One
                // stack: a modifier on the bare views would measure each of them apart.
                HStack(spacing: ComposerBarFit.spacing) { secondaryControls(compact: false, measuring: true) }
                    .fixedSize()
                    .hidden()
                    .disabled(true)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barSecondaryWidth = $0 }
            }
            .background { StatusLineMeter() }   // MARK: wave6 w6-statusline — §44.2: the width the status line has
            StatusLineSlot()   // MARK: wave6 w6-statusline — §44.2: under the input, as in the terminal (only when it has lines)
            // r2-review-flow M27: the engine log is no line under every composer — the error banner's "Show log" and Help ›
            // Show Engine Log open it here; its × closes it again.
            if model.showSidecarLog {
                SidecarLogDisclosure()   // MARK: wave7 w7-chat — §45.1: a log line redraws only this disclosure
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { windowHeight = max($0, 300) }   // P4-composer-16
        .padding(12)
        // polish P4-composer-07: what closing the window would lose here — the attached images (never saved; the text is).
        .registersUnsavedWork("composerImages") {
            composer.images.isEmpty ? nil : String(localized: "\(composer.images.count) attached images will be lost.")
        }
        .modifier(ComposerBtwHooks(composer: composer))   // §56.1
        .onChange(of: composer.draft) { _, _ in
            composer.paletteDismissed = false
            composer.paletteForced = false   // ⌘/ over a typed draft: typing on is a message, not a filter — ↩ stays a newline
            composer.paletteIndex = 0
        }
        .onChange(of: model.requestChangesTick) { _, _ in
            // ⌘⇧C (audit 1.11): with notes, send them; otherwise just land in the composer.
            // wave4b w4b-tabs: the notes are the running chat's review — not sent from another chat shown read-only.
            if store.viewingChat == nil, !store.unsentNotes.isEmpty, store.canRequestChanges { requestChanges() } else { composer.inputFocused = true }
        }
        .onChange(of: mentionQuery?.query) { _, _ in
            composer.mentionDismissed = false
            composer.mentionIndex = 0
        }
        .task(id: mentionVisible ? "\(mentionQuery?.query ?? "")#\(composer.mentionRetry)" : nil) {
            // §23: debounced `list_files`; a newer query (or polish P4-composer-22's retry) cancels this one.
            guard mentionVisible, let query = mentionQuery?.query else { composer.mentionResults = []; composer.mentionError = nil; return }
            composer.mentionLoading = true
            try? await Task.sleep(for: .milliseconds(110))
            guard !Task.isCancelled else { return }
            let (items, error) = await store.listFilesResult(query: query)
            guard !Task.isCancelled else { return }
            composer.mentionResults = items
            composer.mentionError = error
            composer.mentionLoading = false
            composer.mentionIndex = min(composer.mentionIndex, max(mentionEntries.count - 1, 0))
        }
        .onChange(of: model.mentionTick) { _, _ in
            // The changed-files list's "Mention in Chat".
            composer.addMentions(model.mentionPaths)
            composer.inputFocused = true
        }
        // polish P4-composer-05: Chat › Commands… (⌘/) — the menu has the key now; it does what ⌘/ in the box did.
        .onChange(of: model.commandsTick) { _, _ in
            if paletteVisible {
                if composer.draft == "/" { composer.draft = "" }
                composer.closePalette()
            } else {
                composer.openPalette(available: store.canUseSlashPalette)
            }
        }
        // polish P4-composer-05: Chat › Attach Images…
        .onChange(of: model.attachImagesTick) { _, _ in
            let picked = ComposerIntake.pickImages()
            if !picked.isEmpty { _ = composer.takeDrop(.files(picked), root: store.projectURL) }
            composer.inputFocused = true
        }
        // wave3 mac-flow (§36.14): "Send to Claude" from the PR tab — also when the chat was not on screen yet.
        .onChange(of: model.composerDraftTick) { _, _ in composer.takeComposerDraft(model) }
        .onAppear {
            followDraftChat(store.draftChatId)   // r1-composer M12: first, so a PR's text joins the draft that comes back
            composer.takeComposerDraft(model)
        }
        // r1-composer M12 (§38.1): saved as it is typed (an emptied box at once), and when the chat column goes away.
        .task(id: savedDraft) { await saveDraftSoon() }
        .onDisappear { saveDraftNow() }
        // MARK: §49 Run as Task — the task started in its workbench: its text leaves this composer (unless edited since);
        // a task handed here that the session could not take comes into it.
        .onChange(of: model.startedTaskTick) { _, _ in
            guard let started = model.startedTaskText else { return }
            model.startedTaskText = nil
            if Self.taskText(draft: composer.draft, mentions: composer.mentions) == started {
                composer.draft = ""
                composer.mentions = []
                composer.closePalette()
            }
        }
        // §50.3: a take-back that came too late (or failed) says so where the user typed.
        .onChange(of: store.steerTakeBackNotice?.id) { _, _ in
            if let notice = store.steerTakeBackNotice { composer.notice = notice.text }
        }
        .onChange(of: store.taskForComposer?.id, initial: true) { _, _ in
            guard let handed = store.taskForComposer else { return }
            store.takeTaskForComposer(handed.id)
            if handed.atFront { composer.takeGivenBack(handed.text) } else { model.insertIntoComposer(handed.text) }   // §56.2
            // r2-chats-cards M31 / M33 (§9): a held message called off comes back with its mentions and images.
            composer.addMentions(handed.mentions)
            let room = max(0, ComposerImage.maxCount - composer.images.count)
            composer.images += handed.images.prefix(room)
            if handed.images.count > room { composer.notice = AttachmentProblem.tooMany.message }
        }
        // MARK: wave4 w4-safety — polish-12: each chat tab keeps its own draft (text, mentions, images).
        .onChange(of: store.draftChatId) { _, current in followDraftChat(current) }
        .task(id: composer.notice) {
            guard let notice = composer.notice, !notice.contains("\n") else { return }   // polish P4-composer-17: several lines stay
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { composer.notice = nil }
        }
    }

    // MARK: The row under the box (r1-composer M11)

    /// Stop — and "Force restart" after a stop that did not stop — while Claude works.
    @ViewBuilder
    private var stopButtons: some View {
        if store.isRunning {
            HStack(spacing: 8) {
                // MARK: wave4 w4-safety — robustness-07: the stop did not stop within 10 s.
                if store.showsForceRestart {
                    Button("Force restart", systemImage: "arrow.clockwise.circle") { store.forceRestartStuckTurn() }
                        .help("The turn did not stop. Ends the Claude process and continues the same conversation — the queue and the review stay.")
                        .accessibilityLabel("Force restart")
                        .accessibilityIdentifier("Force restart")
                }
                Button("Stop", systemImage: "stop.fill") { store.interrupt() }
                    // polish P4-composer-01; ⌘. itself lives in Chat › Stop Claude (polish P4-composer-05), esc in the message box
                    .help("Stop Claude's turn (⌘. · esc)")
                    .accessibilityLabel("Stop")
                    .accessibilityIdentifier("Stop")
            }
            .fixedSize()
        }
    }

    /// The row folds its secondary controls before the send button would be pushed out of the window (Core `ComposerBarFit`).
    private var barCompact: Bool {
        ComposerBarFit.compact(rowWidth: barWidth, secondary: barSecondaryWidth,
                               trailing: barPrimaryWidth + (store.isRunning ? barStopWidth + ComposerBarFit.spacing : 0))
    }

    /// 변경 요청 (N), Accept N & Send, the next message's model and the mode: at their own width, or (`compact`) the first two
    /// in one "⋯" menu and the model and the mode as icons. `measuring`: the hidden copy the row is sized by — it registers
    /// no shortcut (SwiftUI would take the first one it finds).
    @ViewBuilder
    private func secondaryControls(compact: Bool, measuring: Bool) -> some View {
        // wave4b w4b-tabs (§39.2): the review is the running chat's — its buttons wait for it to be shown.
        let request = store.showsRequestChanges
        let accept = acceptAndSend && store.viewingChat == nil
        if compact {
            if request || accept {
                Menu {
                    if request {
                        Button("Request changes (\(store.unsentNotes.count))", systemImage: "exclamationmark.bubble") { requestChanges() }
                            .disabled(!store.canRequestChanges)
                            .accessibilityIdentifier("Request changes")
                    }
                    if accept {
                        Button("Accept \(store.pendingFiles.count) & Send") { acceptAndSendTapped() }
                            .keyboardShortcut(.return, modifiers: [.command, .shift])
                            .disabled(trimmedDraft.isEmpty)
                            .accessibilityIdentifier("Accept and send")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(request && accept ? String(localized: "Request changes (\(store.unsentNotes.count)) · Accept \(store.pendingFiles.count) & Send")
                      : request ? String(localized: "Request changes (\(store.unsentNotes.count))") : String(localized: "Accept \(store.pendingFiles.count) & Send"))
                .accessibilityLabel("More send options")
                .accessibilityIdentifier("Composer more")
            }
            NextMessageModelMenu().labelStyle(.iconOnly)   // wave5 w5-model (§43.4)
            PermissionModePicker().labelStyle(.iconOnly)
        } else {
            if request {
                // wave2 mac-flow (§34.4): the count is what goes out — sent notes are never sent again.
                Button("Request changes (\(store.unsentNotes.count))", systemImage: "exclamationmark.bubble") { requestChanges() }
                    .disabled(!store.canRequestChanges)
                    .fixedSize()
                    // polish P4-composer-02: why it is off
                    .help(store.canRequestChanges ? String(localized: "Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)")
                          : store.unsentNotes.isEmpty ? String(localized: "No review notes to send yet — add a note in the diff first")
                          : (store.cannotSendReason ?? String(localized: "Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)")))
                    .accessibilityLabel("Request changes")
                    .accessibilityIdentifier("Request changes")
            }
            if accept {
                // A separate, explicitly labelled action: accepting is never a side effect of Send.
                Menu {
                    Button("Accept \(store.pendingFiles.count) & Send") { acceptAndSendTapped() }
                        .keyboardShortcut(measuring ? nil : KeyboardShortcut(.return, modifiers: [.command, .shift]))
                        .disabled(trimmedDraft.isEmpty)
                        .accessibilityIdentifier("Accept and send")
                } label: {
                    Text("Accept \(store.pendingFiles.count) & Send")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(trimmedDraft.isEmpty)   // polish P4-composer-02: with nothing typed it says why
                .help(trimmedDraft.isEmpty ? String(localized: "Type a message first")
                      : String(localized: "Accepts the \(store.pendingFiles.count) pending file(s), then sends this message (⌘⇧↩)"))
                .accessibilityLabel("Accept and send")
            }
            NextMessageModelMenu()   // wave5 w5-model (§43.4): "이번엔 opus"
            PermissionModePicker()
        }
    }

    /// The send button: 답하기 while Claude's question is open (M08), 바로 보내기 while the turn can take the message (§50),
    /// 대기열에 추가 while it cannot, else Send.
    @ViewBuilder
    private var primaryButton: some View {
        if let card = cardForDraft {
            // r2-chats-cards M24 (§33.10): the text answers the waiting card — denied with it as the instruction, Claude follows
            // it in the same turn. The menu sends it apart from the card (it waits behind it), queues it or stops the turn.
            Menu {
                Button("Send now", systemImage: "paperplane") { sendWhileWorking() }
                    .disabled(!canQueue)
                    .accessibilityIdentifier("Send apart from the card")
                Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                    .disabled(!canQueue)
                Button("Stop and send", systemImage: "stop.circle") { stopAndSend() }
                    .disabled(!store.isRunning)
            } label: {
                Label("Deny with this", systemImage: "hand.raised.fill")
            } primaryAction: {
                denyWithDraft(card)
            }
            .menuStyle(.button)
            .buttonStyle(.borderedProminent)
            .fixedSize()
            .help(String.withKey(String(localized: "Deny the waiting card with your message as the instruction — Claude follows it in this turn"), key: KeyHint.sendKey))
            .accessibilityLabel("Deny with this")
            .accessibilityIdentifier("Deny with this")
        } else if let question {
            // r1-composer M08: the message answers Claude's open question (↩); the menu sends it apart from it (⌥↩) —
            // into the turn, where it is read once the question is answered — or queues it, or stops the turn first.
            Menu {
                // polish P4-composer-01: the menu's own keys in the label (a .keyboardShortcut would fight the text view's)
                Button(String(localized: "Send apart from the question") + "  ⌥↩", systemImage: "paperplane") { sendWhileWorking() }
                    .disabled(trimmedDraft.isEmpty || !canQueue)
                    .accessibilityIdentifier("Send apart from the question")
                Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                    .disabled(trimmedDraft.isEmpty || !canQueue)
                Button(String(localized: "Stop and send") + "  ⌥⌘↩", systemImage: "stop.circle") { stopAndSend() }
                    .disabled(!store.isRunning || trimmedDraft.isEmpty)
            } label: {
                Label("Send answer", systemImage: "arrowshape.turn.up.left.fill")
            } primaryAction: {
                answerQuestion(question)
            }
            .menuStyle(.button)
            .buttonStyle(.borderedProminent)
            .fixedSize()
            .disabled(trimmedDraft.isEmpty && !questionComplete(question))
            .help(trimmedDraft.isEmpty && !questionComplete(question) ? String(localized: "Type an answer or pick an option on the card")
                  : String(localized: "Answers Claude's question with your message (\(KeyHint.sendKey)) — with an empty box, sends the card as it is. The menu sends the message apart from the question (⌥↩)."))
            .accessibilityLabel("Send answer")
            .accessibilityIdentifier("Send answer")
        } else if canSteer {
            // §50: while Claude works the message goes into the turn (primary, ↩ / ⌘↩) — as in the terminal; the menu
            // queues it for after the turn or stops the turn and sends it right after.
            Menu {
                Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                    .disabled(trimmedDraft.isEmpty)
                    .accessibilityIdentifier("Add to queue")
                Button(String(localized: "Stop and send") + "  ⌥⌘↩", systemImage: "stop.circle") { stopAndSend() }
                    .disabled(trimmedDraft.isEmpty)
                    .accessibilityIdentifier("Stop and send")
            } label: {
                Label("Send now", systemImage: "paperplane.fill")
            } primaryAction: {
                steerDraft()
            }
            .menuStyle(.button)
            .buttonStyle(.borderedProminent)
            .fixedSize()
            .disabled(trimmedDraft.isEmpty)
            .help(String(localized: "Sends your message to Claude now: it reads it as soon as the current step is done, and its changes join this turn's review (\(KeyHint.sendKey)). The menu queues it for after the turn or stops the turn first."))
            .accessibilityLabel("Send now")
            .accessibilityIdentifier("Send now")
        } else if canQueue {
            // While Claude works: queue (primary, ⌘↩) or stop the turn and send this right after it.
            Menu {
                Button(String(localized: "Stop and send") + "  ⌥⌘↩", systemImage: "stop.circle") { stopAndSend() }
                    .disabled(!store.isRunning || trimmedDraft.isEmpty)
                    .accessibilityIdentifier("Stop and send")
                Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                    .disabled(trimmedDraft.isEmpty)
            } label: {
                Label("Add to queue", systemImage: "text.badge.plus")
            } primaryAction: {
                queueDraft()
            }
            .menuStyle(.button)
            .buttonStyle(.borderedProminent)
            .fixedSize()
            .disabled(trimmedDraft.isEmpty)
            .help(String(localized: "Queues your message; it is sent when Claude is free. The menu has “Stop and send” (⌥⌘↩). (\(KeyHint.sendKey))"))
            .accessibilityLabel("Add to queue")
            .accessibilityIdentifier("Add to queue")
        } else {
            Button("Send", systemImage: "paperplane.fill") { send() }
                .buttonStyle(.borderedProminent)
                .disabled(!sendEnabled || trimmedDraft.isEmpty)   // wave4b w4b-tabs
                // polish P4-composer-01 / -02: the key in use, and why it is off; r2-chats-cards M31: a held send says it waits
                .help(store.viewingSendBlocker
                      ?? (store.viewingSendWait != nil ? viewingWaitHint : nil)
                      ?? (sendEnabled ? nil : store.cannotSendReason)
                      ?? (trimmedDraft.isEmpty ? String(localized: "Type a message first")
                          : String(localized: "Sends your message. The review list is left exactly as it is (\(KeyHint.sendKey))")))
                .accessibilityLabel("Send")
                .accessibilityIdentifier("Send")
        }
    }

    // MARK: State

    private var projectOpen: Bool { store.projectInfo != nil }
    private var mentionQuery: (range: NSRange, query: String)? { composer.mentionQuery(projectOpen: projectOpen) }
    private var mentionVisible: Bool { composer.mentionVisible(projectOpen: projectOpen) }
    private var mentionEntries: [MentionEntry] { composer.mentionEntries(changedFiles: store.changedFiles, projectOpen: projectOpen) }
    private var paletteVisible: Bool { composer.paletteVisible(available: store.canUseSlashPalette) }

    /// "Accept N & Send" is a separate, explicit action next to Send; plain Send never accepts anything.
    private var acceptAndSend: Bool { store.canAcceptAndSend }
    private var trimmedDraft: String { composer.draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// r2-chats-cards M33 (§9): from a chat shown read-only while Claude works in the live one — the send waits for it.
    private var viewingWaitHint: String {
        returnSends ? String(localized: "↩ sends it here once Claude is done in the running chat")
            : String(localized: "⌘↩ sends it here once Claude is done in the running chat")
    }

    /// The plain hint under the composer, after the send key in use.
    private var sendHint: String {
        returnSends ? String(localized: "↩ to send · ⇧↩ new line · ⌘/ commands") : String(localized: "⌘↩ to send · ⌘/ commands")
    }
    /// Busy in a way that ends by itself: a draft can be queued and goes out once the session takes it.
    /// §50: the draft can go into the running turn (images wait for the turn: the CLI takes them only with a new message).
    private var canSteer: Bool { canQueue && store.canSteer && composer.images.isEmpty }

    /// r2-review-flow M30: as Electron — any closed gate of an open project (Claude working, a collection, a revert, a start, an
    /// ended session); wave4b w4b-tabs: never from another chat shown read-only.
    private var canQueue: Bool {
        ComposerSendRules.canQueue(projectOpen: store.projectInfo != nil, canSend: store.canSend, viewing: store.viewingChat != nil)
    }

    /// r2-review-flow M30: what ↩ / ⌘↩ do with the typed message (never a silent no-op).
    private var sendAction: ComposerSendAction {
        ComposerSendRules.returnAction(hasText: !trimmedDraft.isEmpty, canSend: store.canSend, canQueue: canQueue, canSteer: canSteer,
                                       sessionEnded: store.isSessionEnded, canRestart: store.canRestartSession)
    }
    /// wave4b w4b-tabs (§39.2): Send is possible — from another chat shown read-only, when the session can move to it.
    private var sendEnabled: Bool { store.viewingChat == nil ? store.canSend : store.viewingSendBlocker == nil }
    /// The permission the composer's ⌘↩ / ⌥⌘↩ / ⌘⌫ answer: the oldest open request that is not an AskUserQuestion (its
    /// card has its own keys) — §33.1, wave1 mac-perms.
    private var pendingToolPermission: PermissionRequest? { store.shortcutPermission }
    /// r1-composer M08: Claude's open question — ↩ answers it instead of putting the text into the turn.
    private var question: OpenQuestion? { store.openQuestion }

    /// r2-chats-cards M24 (§33.10): the card the typed text answers — the shortcut target while text is typed in the running
    /// chat (never a question: the message box answers that one by M08).
    private var cardForDraft: PermissionRequest? {
        guard !trimmedDraft.isEmpty, question == nil else { return nil }
        return store.cardAnsweredByDraft
    }

    /// r2-chats-cards M24: the hint while a card waits and text is typed, after the send key in use.
    private var denyDraftHint: String {
        returnSends ? String(localized: "↩ denies the card with this instruction · ⌥⌘↩ stops and sends")
            : String(localized: "⌘↩ denies the card with this instruction · ⌥⌘↩ stops and sends")
    }

    /// r2-chats-cards M24 (§33.10): the waiting card is denied with the typed text as the instruction (no interrupt: Claude
    /// follows it in the same turn); the text leaves the box like a sent message.
    private func denyWithDraft(_ card: PermissionRequest) {
        if takeBtw() { return }   // §56.1
        let text = trimmedDraft
        guard !text.isEmpty else { return }
        store.denyPermission(requestId: card.requestId, .instruction(text))
        composer.draft = ""
        composer.history.reset(entries: store.promptHistory)
        composer.closePalette()
        transcript.follow = true
        composer.inputFocused = true
    }

    /// r1-composer M08: the hint while Claude's question is open, after the send key in use.
    private var questionHint: String {
        returnSends ? String(localized: "Claude asked a question — ↩ to answer · ⌥↩ to send separately")
            : String(localized: "Claude asked a question — ⌘↩ to answer · ⌥↩ to send separately")
    }

    /// r1-composer M08: the placeholder while Claude's question is open (1…N pick an option of the question it answers).
    private func questionPlaceholder(_ open: OpenQuestion) -> String {
        let draft = transcript.questionDrafts[open.requestId] ?? QuestionDraft()
        let count = draft.current(in: open.questions).map { open.questions.questions[$0].options.count } ?? 0
        return count > 0 ? String(localized: "Answer Claude's question — or press 1–\(count) to pick an option")
            : String(localized: "Answer Claude's question")
    }

    private func questionComplete(_ open: OpenQuestion) -> Bool {
        (transcript.questionDrafts[open.requestId] ?? QuestionDraft()).isComplete(open.questions)
    }
    private var pendingReviewCount: Int { store.pendingFiles.count + store.changesRequestedFiles.count }

    // MARK: Send

    /// Plain Send: the message goes out and the review list stays exactly as it is.
    private func send() {
        if takeBtw() { return }   // §56.1
        let text = composer.draft
        if store.viewingChat != nil { sendInViewedChat(text); return }   // wave4b w4b-tabs (§39.2)
        guard store.canSend, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let (sentMentions, sentImages) = composer.takeInputs(history: store.promptHistory)
        composer.draft = ""
        composer.closePalette()
        transcript.follow = true
        store.send(text, mentions: sentMentions, images: sentImages)
        composer.inputFocused = true
    }

    /// wave4b w4b-tabs (§39.2): a send from another chat shown read-only moves the session there first (the old switch),
    /// then the message goes out by the queue's rules; a refused switch gives the text back.
    private func sendInViewedChat(_ text: String) {
        guard store.viewingSendBlocker == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let keptMentions = composer.mentions, keptImages = composer.images
        let (sentMentions, sentImages) = composer.takeInputs(history: store.promptHistory)
        composer.draft = ""
        composer.closePalette()
        transcript.follow = true
        Task {
            guard !(await store.sendInViewedChat(text, mentions: sentMentions, images: sentImages)) else { return }
            if composer.draft.isEmpty { composer.draft = text; composer.mentions = keptMentions; composer.images = keptImages }
        }
        composer.inputFocused = true
    }

    /// §50 "바로 보내기": the draft goes into the running turn (refused by the engine, it waits in the queue).
    private func steerDraft() {
        if takeBtw() { return }   // §56.1
        guard !trimmedDraft.isEmpty else { return }
        let text = composer.draft
        let (mentions, _) = composer.takeInputs(history: store.promptHistory)
        composer.draft = ""
        composer.closePalette()
        transcript.follow = true
        composer.inputFocused = true
        Task { await store.steer(text, mentions: mentions) }
    }

    /// r1-composer M08: the message box answers Claude's open question — the text answers the question it answers now (the
    /// card goes out once every question has an answer), or with an empty box the card goes as it is. Never steered: a
    /// message in the turn would only wait behind the open question. Mentions and images stay for the next message.
    private func answerQuestion(_ open: OpenQuestion) {
        if takeBtw() { return }   // §56.1
        let id = open.requestId
        var draft = transcript.questionDrafts[id] ?? QuestionDraft()
        guard !trimmedDraft.isEmpty else {
            if store.submitOpenQuestion(draft) { transcript.questionDrafts[id] = nil }
            return
        }
        let sent = store.answerOpenQuestion(composer.draft, draft: &draft)
        transcript.questionDrafts[id] = sent ? nil : draft
        composer.draft = ""
        composer.history.reset(entries: store.promptHistory)
        composer.closePalette()
        composer.inputFocused = true
    }

    /// r1-composer M08: 1…9 in an empty box — that option of the question the box answers (nothing is sent).
    private func pickQuestionOption(_ number: Int) -> Bool {
        guard let open = question, composer.draft.isEmpty else { return false }
        var draft = transcript.questionDrafts[open.requestId] ?? QuestionDraft()
        guard store.pickOpenQuestionOption(number, draft: &draft) else { return false }
        transcript.questionDrafts[open.requestId] = draft
        return true
    }

    /// While Claude works: into the turn when it can take it (§50), else the queue.
    private func sendWhileWorking() {
        if canSteer { steerDraft() } else { queueDraft() }
    }

    private func queueDraft() {
        if takeBtw() { return }   // §56.1
        guard !trimmedDraft.isEmpty else { return }
        let (queuedMentions, queuedImages) = composer.takeInputs(history: store.promptHistory)
        store.enqueue(composer.draft, mentions: queuedMentions, images: queuedImages)
        composer.draft = ""
        composer.closePalette()
        composer.inputFocused = true
    }

    /// "중단하고 보내기" (§28): interrupt, then this message right behind it.
    private func stopAndSend() {
        if takeBtw() { return }   // §56.1
        guard store.isRunning, !trimmedDraft.isEmpty else { return }
        let (sentMentions, sentImages) = composer.takeInputs(history: store.promptHistory)
        store.interruptAndSend(composer.draft, mentions: sentMentions, images: sentImages)
        composer.draft = ""
        composer.closePalette()
        transcript.follow = true
        composer.inputFocused = true
    }

    /// ⌘↩ / ⌥⌘↩ / ⌘⌫ from the composer (polish-01: only while it has the focus — the side-question field, the find bar
    /// and note editors never reach the cards). With text ⌘↩ sends (or queues while Claude works); with an empty composer
    /// the keys answer the oldest open permission card (⌘↩ allow once, ⌥⌘↩ for the session, ⌘⌫ deny), so they never
    /// delete text you are typing. A focused card handles its own keys.
    private func handleCardShortcut(_ key: ComposerKey) -> Bool {
        let shortcut: CardShortcutKey
        switch key {
        case .commandEnter: shortcut = .commandReturn
        case .optionCommandEnter: shortcut = .optionCommandReturn
        case .commandDelete: shortcut = .commandDelete
        default: return false
        }
        // wave4b w4b-tabs (§39.2): another chat shown read-only — ⌘↩ sends there; the running chat's cards are not on
        // screen, so the keys never answer them from here.
        if store.viewingChat != nil {
            guard shortcut == .commandReturn, !trimmedDraft.isEmpty, store.viewingSendBlocker == nil else { return false }
            send()
            return true
        }
        // r1-composer M08: ⌘↩ answers Claude's open question (with an empty box: sends its card as it is).
        if shortcut == .commandReturn, let question {
            answerQuestion(question)
            return true
        }
        switch CardShortcuts.action(for: shortcut, focus: .composer(draft: composer.draft), target: pendingToolPermission) {
        case .sendDraft:
            guard perform(sendAction) else { return explainUnsent() }
        // MARK: wave4d w4d-windows (polish-08): ⌥⌘↩ with text — stop and send while Claude works (Windows' Ctrl+Alt+Enter).
        case .stopAndSendDraft:
            if store.canSend { send() } else if store.isRunning { stopAndSend() } else if canQueue { queueDraft() } else { return false }
        case let .allowOnce(id):
            store.respondPermission(requestId: id, allow: true)
        case let .allowForSession(id):
            store.respondPermission(requestId: id, allow: true, remember: true)
        case let .deny(id):
            store.denyPermission(requestId: id)   // r2-chats-cards M25 (§33.10): the CLI's own "No"
        case let .denyWithDraft(id):   // r2-chats-cards M24
            guard let card = store.openPermissions.first(where: { $0.requestId == id }) else { return false }
            denyWithDraft(card)
        default:
            return false
        }
        return true
    }

    /// ↩ with "Return sends" on: the draft goes as ⌘↩ with text does (sent, put into the turn, queued, or — the session ended —
    /// queued while it restarts). It never answers a permission card — a stray Return must not allow a command — and an empty
    /// draft stays as it is. r2-review-flow M30: false when nothing could take the text (the caller says why).
    private func sendFromReturn() -> Bool {
        if takeBtw() { return true }   // §56.1: before a question or a card takes the text
        // r1-composer M08: ↩ answers Claude's open question (with an empty box: sends its card as it is).
        if let question {
            answerQuestion(question)
            return true
        }
        if let card = cardForDraft { denyWithDraft(card); return true }   // r2-chats-cards M24 (§33.10)
        guard !trimmedDraft.isEmpty else { return true }
        if store.viewingChat != nil {
            guard store.viewingSendBlocker == nil else { return false }
            send()
            return true
        }
        return perform(sendAction)
    }

    /// §56.1: `/btw <question>` is the app's command, whatever the turn does: asked on the side (the answer opens over the
    /// box), never sent, queued or put into the turn; `/btw` alone shows the last answer again. False for any other text.
    private func takeBtw() -> Bool {
        guard let question = BtwCommand.question(in: composer.draft) else { return false }
        guard store.projectInfo != nil else {
            composer.notice = String(localized: "Open a project first (⌘O)")
            return true
        }
        composer.draft = ""
        composer.closePalette()
        composer.inputFocused = true
        if question.isEmpty {
            if !store.showLastBtw() { composer.notice = BtwCommand.nothingYet }
        } else {
            Task { await store.askBtw(question) }
        }
        return true
    }

    /// §56.3: ⌃G, as Ctrl+G in the terminal — the draft goes out to an external editor and each save comes back here.
    private func startExternalEdit() {
        let editor = composer.externalEditor
        guard !editor.isEditing else { return }
        let started = editor.start(draft: composer.draft) { [composer] text in
            composer.draft = text
            composer.caretRequest = (text as NSString).length
        }
        if !started { composer.notice = editor.failure }
    }

    /// §56.1: the /btw answer is shown and the box is empty — ↩ and Space close it (Esc always does).
    private var closesBtwAnswer: Bool {
        guard composer.draft.isEmpty, case .answered = store.btwOverlay else { return false }
        return true
    }

    /// r2-review-flow M30: does what ↩ / ⌘↩ decided; false for `.nothing`.
    private func perform(_ action: ComposerSendAction) -> Bool {
        switch action {
        case .send: send()
        case .steer: steerDraft()
        case .queue: queueDraft()
        case .restartAndSend:
            queueDraft()   // sent by the queue once the session is up
            store.reconnectSession()
        case .nothing: return false
        }
        return true
    }

    /// r2-review-flow M30: ↩ with text that nothing can take — a beep and why in the composer's notice line, never silence.
    private func explainUnsent() -> Bool {
        guard !trimmedDraft.isEmpty else { return false }
        NSSound.beep()
        composer.notice = store.viewingChat != nil ? (store.viewingSendBlocker ?? store.cannotSendReason) : store.cannotSendReason
        return true
    }

    // MARK: r1-composer M12 — a draft that lasts (§38.1)

    /// What is saved for the chat: the draft typed before ↑ while a recalled prompt is shown, and the mentions.
    private var savedDraft: ChatDraft {
        ChatDraft(text: composer.history.parkedDraft ?? composer.draft, mentions: composer.mentions)
    }

    /// The box follows the chat its draft belongs to (polish-12). Another chat: what is typed is kept for the chat left (in
    /// memory with its images, and on disk) and the other chat's draft comes in. The first chat a window — or an engine
    /// after none — reports into an empty box brings back its saved draft; a chat that went away keeps what is typed.
    private func followDraftChat(_ current: String?) {
        // wave6 w6-terminal (§44.1): a recalled prompt on screen is not the draft — the one typed before ↑ is kept.
        let typed = ChatDraft(text: composer.history.parkedDraft ?? composer.draft, mentions: composer.mentions, images: composer.images)
        let first = !composer.draftChatBound
        let previous = composer.draftChatId
        composer.draftChatBound = true
        if current != nil || first { composer.draftChatId = current }
        let shown = first ? (typed.isEmpty ? store.savedDraft(for: current) : nil) : store.moveDraft(typed, from: previous, to: current)
        guard let shown else { return }
        composer.history.reset(entries: store.promptHistory)
        composer.draft = shown.text
        composer.mentions = shown.mentions
        composer.images = shown.images
    }

    private func saveDraftNow() {
        guard composer.draftChatBound else { return }
        store.saveDraft(savedDraft, for: composer.draftChatId)
    }

    /// A moment after the last keystroke; an emptied box (sent, cleared) at once, so a quit right after a send never brings
    /// the message back.
    private func saveDraftSoon() async {
        guard composer.draftChatBound else { return }
        if !savedDraft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !savedDraft.mentions.isEmpty {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
        }
        saveDraftNow()
    }

    /// "Accept N & Send" (⌘⇧↩). r2-review-flow M28: at once, never behind an alert — a toast says what was accepted.
    private func acceptAndSendTapped() {
        guard acceptAndSend, !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sendAccepting()
    }

    private func sendAccepting() {
        let text = composer.draft
        guard acceptAndSend, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let count = store.pendingFiles.count
        let (sentMentions, sentImages) = composer.takeInputs(history: store.promptHistory)
        composer.draft = ""
        composer.closePalette()
        transcript.follow = true
        store.send(text, acceptPending: true, mentions: sentMentions, images: sentImages)
        Toast.show(String(localized: "Accepted \(count) files and sent your message"))
        composer.inputFocused = true
    }

    /// Sends the review notes (plus the composer text, if any) as the next turn; bypasses `canSend` by design.
    private func requestChanges() {
        guard store.canRequestChanges else { return }
        let extra = composer.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        composer.draft = ""
        composer.history.reset(entries: store.promptHistory)   // wave6 w6-terminal (§44.1)
        composer.closePalette()
        store.requestChanges(extraMessage: extra.isEmpty ? nil : extra)
        composer.inputFocused = true
    }

    // MARK: Input box (§23 mentions, §24 images)

    private var inputBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !composer.mentions.isEmpty || !composer.images.isEmpty {
                ComposerChipsRow(mentions: $composer.mentions, images: $composer.images)
            }
            HStack(alignment: .bottom, spacing: 4) {
                ComposerTextView(text: $composer.draft, isFocused: $composer.inputFocused, caret: $composer.caret,
                                 caretRequest: $composer.caretRequest, contentHeight: $composer.height,
                                 placeholder: question.map(questionPlaceholder) ?? String(localized: "Message Claude — @ mentions a file, ⌘V pastes an image"),
                                 onKey: handleKey, textScale: TextScale.clamped(textScale), onDrop: { composer.takeDrop($0, root: store.projectURL) },
                                 onDragHover: { composer.dropHover = $0 })
                    // polish P4-composer-16: at least the dragged height, growing with the text up to the limit
                    .frame(height: min(max(composer.height, inputHeightLimits.min), inputHeightLimits.max))
                composerTools.padding(.bottom, 4)
            }
        }
        .padding(6)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            // polish P4-composer-15: where typing goes — an accent border while the box has the focus (the drop's dashes win).
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(composer.dropHover ? AnyShapeStyle(Color.accentColor)
                                : composer.inputFocused ? AnyShapeStyle(Color.accentColor.opacity(0.6)) : AnyShapeStyle(.quaternary),
                              style: StrokeStyle(lineWidth: composer.dropHover || composer.inputFocused ? 1.5 : 1, dash: composer.dropHover ? [5, 3] : []))
        }
        .overlay(alignment: .top) {
            InputHeightHandle(shown: min(max(composer.height, inputHeightLimits.min), inputHeightLimits.max), window: windowHeight,
                              dragged: $draggedHeight)
        }
        .dropDestination(for: URL.self) { urls, _ in
            composer.takeDrop(.files(urls), root: store.projectURL)
        } isTargeted: { composer.dropHover = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Composer box")
    }

    /// §49: what "Run as Task" takes from the composer — the draft, then its @ mentions (images stay here).
    static func taskText(draft: String, mentions: [String]) -> String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mentions.isEmpty else { return text }
        let tags = mentions.map { "@\($0)" }.joined(separator: " ")
        return text.isEmpty ? tags : text + "\n\n" + tags
    }

    /// Attach (images), @ (opens the mention popover at the caret) and §49 Run as Task.
    private var composerTools: some View {
        HStack(spacing: 2) {
            Button {
                let picked = ComposerIntake.pickImages()
                if !picked.isEmpty { _ = composer.takeDrop(.files(picked), root: store.projectURL) }
                composer.inputFocused = true
            } label: {
                Image(systemName: "paperclip")
            }
            .help("Attach images (PNG, JPEG, GIF, WebP · up to 5; a larger one is scaled down to fit) — or paste with ⌘V / drop them here")
            .accessibilityLabel("Attach images")
            .accessibilityIdentifier("Attach images")
            Button {
                composer.insertAtSign()
            } label: {
                Image(systemName: "at")
            }
            .disabled(store.projectInfo == nil)
            .help(store.projectInfo == nil ? String(localized: "Open a project to mention files")
                  : String(localized: "Mention a file or folder (@) — or drag files from Changes or Finder here"))
            .accessibilityLabel("Mention a file")
            .accessibilityIdentifier("Mention a file")
            Button {
                startExternalEdit()
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .disabled(store.viewingChat != nil || composer.externalEditor.isEditing)
            .help(store.viewingChat != nil ? String(localized: "Go back to the running chat to edit its message")
                  : composer.externalEditor.isEditing ? String(localized: "The message is open in an editor — Done or Cancel above the box")
                  : String(localized: "Edit the message in an external editor (⌃G) — each save comes back here"))
            .accessibilityLabel("Edit in an external editor")
            .accessibilityIdentifier("Edit in an external editor")
            if runAsTaskEnabled {   // §49
                Button {
                    model.runAsTask(Self.taskText(draft: composer.draft, mentions: composer.mentions))
                } label: {
                    Image(systemName: "arrow.triangle.branch")
                }
                .disabled(store.projectInfo == nil || store.viewingChat != nil)
                .help(store.projectInfo == nil ? String(localized: "Open a project first (⌘O)")
                      : store.viewingChat != nil ? String(localized: "Go back to the running chat to run this as a task")
                      : String(localized: "Run as Task — start this message in a new workbench (its own branch, window and chat); this chat is left as it is"))
                .accessibilityLabel("Run as Task")
                .accessibilityIdentifier("Run as Task")
            }
        }
        .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left an 11 pt target
        .foregroundStyle(.secondary)
        .controlSize(.small)
    }

    /// ↑ ↓ ↩ ⇥ ⎋ from the text view: the mention popover first, then the slash palette, then the prompt history.
    private func handleKey(_ key: ComposerKey) -> Bool {
        if mentionVisible {
            let entries = mentionEntries
            switch key {
            case .up:
                if !entries.isEmpty { composer.mentionIndex = (composer.mentionIndex - 1 + entries.count) % entries.count }
                return true
            case .down:
                if !entries.isEmpty { composer.mentionIndex = (composer.mentionIndex + 1) % entries.count }
                return true
            case .enter, .tab:
                guard !entries.isEmpty else {
                    composer.mentionDismissed = true
                    if key == .tab { return true }
                    break   // ↩ goes on as without the popover (a new line, or the send with "Return sends")
                }
                composer.pickMention(entries[min(composer.mentionIndex, entries.count - 1)], store: store)
                return true
            case .escape:
                composer.mentionDismissed = true
                return true
            case .commandSlash, .commandShiftEnter, .commandEnter, .optionCommandEnter, .commandDelete, .backtab, .controlB,
                 .optionEnter, .digit, .pageUp, .pageDown, .space, .controlG:
                break
            }
        }
        switch key {
        case .optionEnter:
            // r1-composer M08: ⌥↩ while Claude's question is open — the text goes to Claude apart from the question (into
            // the turn, read once the question is answered; else queued). Otherwise a new line, as before.
            guard question != nil, !trimmedDraft.isEmpty, canQueue else { return false }
            sendWhileWorking()
            return true
        case let .digit(number):
            return pickQuestionOption(number)   // r1-composer M08
        case .space:
            guard closesBtwAnswer else { return false }   // §56.1
            store.dismissBtw()
            return true
        case .controlG:
            guard store.viewingChat == nil else { return false }   // §56.3
            startExternalEdit()
            return true
        case .pageUp, .pageDown:
            // polish P3-transcript-17: a page of the conversation from the message box (the transcript scrolls by the tick).
            guard !paletteVisible else { return false }
            if key == .pageUp { model.transcriptPageUpTick &+= 1 } else { model.transcriptPageDownTick &+= 1 }
            return true
        case .controlB:
            // §52: as in the terminal — while Claude works, the running command goes on in the background.
            guard store.isRunning, store.backgroundWorkEnabled else { return false }
            Task { _ = await store.moveToBackground() }
            return true
        case .backtab:
            // MARK: wave6 w6-terminal — §44.1: ⇧⇥ cycles the mode like the terminal (default → accept edits → plan → auto).
            store.cyclePermissionMode()
            return true
        case .commandEnter, .optionCommandEnter, .commandDelete:
            return handleCardShortcut(key)   // wave1 mac-perms (polish-01)
        case .commandShiftEnter:
            // ⌘⇧↩ is the explicit "Accept N & Send"; plain ⌘↩ never accepts (`handleCardShortcut`).
            acceptAndSendTapped()
            return true
        case .commandSlash:
            // ⌘/ again closes it (the "/" it put in an empty draft goes with it).
            if paletteVisible {
                if composer.draft == "/" { composer.draft = "" }
                composer.closePalette()
            } else {
                composer.openPalette(available: store.canUseSlashPalette)
            }
            return true
        case .enter, .tab:
            // §56.1: ↩ in an empty box closes the /btw answer; `/btw` typed out runs at once instead of the palette's pick.
            if key == .enter, closesBtwAnswer { store.dismissBtw(); return true }
            if key == .enter, paletteVisible, composer.slashToken?.lowercased() == BtwCommand.name { return takeBtw() }
            guard paletteVisible else { return key == .enter && returnSends ? (sendFromReturn() || explainUnsent()) : false }
            let entries = composer.paletteEntries(store)
            guard !entries.isEmpty else { composer.closePalette(); return true }
            composer.pick(entries[min(composer.paletteIndex, entries.count - 1)], store: store)
            return true
        case let .up(onFirstLine):
            if paletteVisible {
                let entries = composer.paletteEntries(store)
                if !entries.isEmpty {
                    composer.paletteIndex = (composer.paletteIndex - 1 + entries.count) % entries.count
                    return true
                }
            }
            // ↑ on the first line (wave6 w6-terminal, §44.1: as in the terminal, with text typed too — ↓ past the newest
            // prompt or Esc gives it back), or in a recalled prompt: the previous prompt.
            // MARK: wave7 w7-chat — §45.1: elsewhere the caret just moves; the history is not even read.
            guard onFirstLine || composer.draft.isEmpty else { return false }
            // §56.2: as in the terminal, ↑ in an empty box first brings back every message waiting (in Claude's turn, then
            // the queue) to edit; with nothing waiting it walks the prompt history.
            if composer.draft.isEmpty, !composer.history.isBrowsing, store.viewingChat == nil, store.canPullBackWaiting {
                return store.pullBackWaiting()
            }
            if !composer.history.isBrowsing { composer.history.refresh(entries: store.promptHistory) }
            guard let recalled = composer.history.up(draft: composer.draft, caretOnFirstLine: onFirstLine) else { return false }
            composer.setDraftFromHistory(recalled)
            return true
        case let .down(onLastLine):
            if paletteVisible {
                let entries = composer.paletteEntries(store)
                if !entries.isEmpty {
                    composer.paletteIndex = (composer.paletteIndex + 1) % entries.count
                    return true
                }
            }
            guard let recalled = composer.history.down(draft: composer.draft, caretOnLastLine: onLastLine) else { return false }
            composer.setDraftFromHistory(recalled)
            return true
        case .escape:
            if paletteVisible { composer.closePalette(); return true }
            if let restored = composer.history.cancel() { composer.setDraftFromHistory(restored); return true }
            if store.btwOverlay != nil { store.dismissBtw(); return true }   // §56.1: the side answer first, then the turn
            // MARK: wave6 w6-terminal — §44.1: Esc stops Claude's running turn, as in the terminal (⌘. does too).
            // §56.2: with messages waiting, what Claude has not read comes back into the box with the stop.
            if store.isRunning, store.viewingChat == nil {
                if store.hasUnsentWaiting { Task { await store.interruptGivingBack() } } else { store.interrupt() }
                return true
            }
            return false
        }
    }
}

/// Sending answers a question; it never accepts. Say so, so nobody sends to "get past" the review — and (wave2 mac-flow,
/// comp-04) that Claude's next changes join this review rather than a review of their own. r1-composer M11: one line
/// ("검토 대기 N개 · 질문은 수락 없이 가능") with the explanation in its ⓘ popover — it took five lines of a narrow chat.
private struct PendingReviewNotice: View {
    @Environment(\.colorScheme) private var colorScheme
    let count: Int
    @State private var showsWhy = false

    var body: some View {
        HStack(spacing: 6) {
            Label("\(count) pending review · you can ask without accepting", systemImage: "checklist")
                .font(.callout)
                .foregroundStyle(.orange)
                .lineLimit(1)
                .truncationMode(.tail)
                // polish P4-composer-37: the review's keys (Electron's words)
                .help("Next pending file ⌘] · previous ⌘[ · Accept ⌘⇧A · Reject ⌘⇧R · Request changes ⌘⇧C")
            Spacer(minLength: 0)
            Button {
                showsWhy.toggle()
            } label: {
                Image(systemName: "info.circle")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("What sending does to this review")
            .accessibilityLabel("What sending does to this review")
            .accessibilityIdentifier("Pending banner why")
            .popover(isPresented: $showsWhy, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("You can ask questions without accepting: sending never accepts or rejects a file.")
                    Text("Sending now adds Claude's new changes to this review (same starting point). To review them separately, accept or reject first.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("Pending banner merge note")
                }
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 300, alignment: .leading)
                .padding(12)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Pending banner")
    }
}

/// Last 500 sidecar `log` events, so IPC problems are diagnosable without a terminal.
/// MARK: wave7 w7-chat — §45.1: its own view — a log line redraws this line, not the chat.
/// r2-review-flow M27 / polish P4-composer-39: shown only once opened (the error banner's "Show log", Help › Show Engine Log),
/// with Copy Log ("복사됨"), the log folder and × to put it away again — it no longer takes a line of every composer.
private struct SidecarLogDisclosure: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Sidecar log (\(store.logs.count))").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Button("Copy Log", systemImage: "doc.on.doc") { Clipboard.copy(store.logs.joined(separator: "\n"), toast: String(localized: "Copied")) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.icon)
                    .disabled(store.logs.isEmpty)
                    .help("Copy the engine log")
                    .accessibilityIdentifier("Copy sidecar log")
                Button("Open Log Folder", systemImage: "folder") { LogActions.openLogFolder() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.icon)
                    .help(LogActions.folderHelp)
                    .accessibilityIdentifier("Open log folder from composer")
                Button("Hide the engine log", systemImage: "xmark") { model.showSidecarLog = false }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.icon)
                    .help("Hide the engine log — the error banner's Show log or Help › Show Engine Log brings it back")
                    .accessibilityIdentifier("Hide sidecar log")
            }
            ScrollView {
                Text(store.logs.isEmpty ? String(localized: "(no sidecar log yet)") : store.logs.joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
            }
            .frame(height: 140)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Sidecar log")
    }
}

/// r2-review-flow M30: the turn's changes could not be collected — the input stays open (the next message collects them with
/// its own, §3) and the retry is right here, not only in the sidebar a narrow window hides. Polish P2-review-41: the error's
/// own words can be copied.
private struct CollectFailedNotice: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let detail: String

    var body: some View {
        HStack(spacing: 6) {
            Label(ComposerSendRules.collectFailedNotice(detail), systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.orange)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(detail)
            Spacer(minLength: 4)
            Button("Copy Error", systemImage: "doc.on.doc") { Clipboard.copy(detail, toast: String(localized: "Copied")) }
                .labelStyle(.iconOnly)
                .buttonStyle(.icon)
                .help("Copy the error")
                .accessibilityIdentifier("Copy collect error from composer")
            Button("Retry") { store.retryCollectReview() }
                .controlSize(.small)
                .disabled(store.isSnapshotting)
                .help("Collect the turn's changes again")
                .accessibilityIdentifier("Retry collect from composer")
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Collect failed notice")
    }
}

// MARK: Capabilities caption

private struct CapabilitiesCaption: View {
    @Environment(AppState.self) private var store
    @State private var showCapabilities = false
    /// r1-composer M11: the row under the box folded — the counts go into the icon's tooltip (a narrow row cut them to "0 s…"
    /// next to a hint cut the same way); the warnings stay.
    var compact = false

    private var compactHelp: String {
        guard let caps = store.capabilities else {
            return store.slashPaletteEmptyState(shown: [])?.text ?? SlashPaletteEmptyState.userSettingsOff.text
        }
        let servers = store.mcp.loaded ? store.mcp.servers.count : caps.mcpServers.count
        return String(localized: "\(caps.skills.count) skills · \(caps.slashCommands.count) commands · \(servers) MCP servers")
    }

    var body: some View {
        Button {
            showCapabilities.toggle()
        } label: {
            if compact {
                HStack(spacing: 3) {
                    if let ext = store.extensions, !ext.loadsUserSettings, ext.fallback != nil {
                        Image(systemName: "puzzlepiece.extension.fill").foregroundStyle(.orange)
                    }
                    let failing = store.mcp.attentionServers
                    if !failing.isEmpty {
                        Circle().fill(failing.contains { $0.status == .failed } ? Color.red : Color.yellow)
                            .frame(width: 6, height: 6)
                            .accessibilityLabel("MCP servers need attention")
                            .accessibilityIdentifier("MCP warning dot")
                    }
                    Image(systemName: "puzzlepiece.extension")
                }
            } else if let caps = store.capabilities {
                HStack(spacing: 4) {
                    if let ext = store.extensions, !ext.loadsUserSettings, ext.fallback != nil {
                        Image(systemName: "puzzlepiece.extension.fill").foregroundStyle(.orange)
                            .help("Started without your user settings — click for details")
                    }
                    let failing = store.mcp.attentionServers
                    if !failing.isEmpty {
                        // §22: a failed / needs-login MCP server — the popover has the fix.
                        Circle().fill(failing.contains { $0.status == .failed } ? Color.red : Color.yellow)
                            .frame(width: 6, height: 6)
                            .help("\(failing.count) MCP servers need attention — click for details")
                            .accessibilityLabel("MCP servers need attention")
                            .accessibilityIdentifier("MCP warning dot")
                    }
                    // polish PX-02: the caption's own tooltip (the button's hid the two dots' warnings)
                    Text("\(caps.skills.count) skills · \(caps.slashCommands.count) commands · \(store.mcp.loaded ? store.mcp.servers.count : caps.mcpServers.count) MCP servers")
                        .help("Skills, slash commands, plugins and MCP servers available in this session")
                    if store.capabilitiesAreCached {   // wave3 mac-session: the engine's cache too
                        Text("(cached)")
                            .help("From an earlier session — replaced once this session reports")   // polish P4-composer-38
                    }
                }
            } else {
                // wave3 mac-session (§36.5): "Starting session…" while the CLI starts — never "enable" when user settings are on.
                Text(verbatim: store.slashPaletteEmptyState(shown: [])?.text ?? SlashPaletteEmptyState.userSettingsOff.text)
            }
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .fixedSize(horizontal: compact, vertical: false)
        // polish PX-02: no tooltip on the whole caption (an outer .help, even an empty one, hides the dots' own); folded, the icon's.
        .modifier(OptionalHelp(text: compact ? compactHelp : nil))
        .accessibilityLabel(compact ? Text(verbatim: compactHelp) : Text("Skills, slash commands, plugins and MCP servers available in this session"))   // polish P4-composer-38
        .accessibilityIdentifier("Capabilities")
        .popover(isPresented: $showCapabilities, arrowEdge: .top) {
            if store.extensions != nil {
                // §16: what the session applied, with the plugin / hook switches.
                ScrollView {
                    AppliedExtensionsView(compact: true)
                        .padding(14)
                        .frame(width: 380, alignment: .leading)
                }
                .frame(maxHeight: 520)
            } else {
                CapabilitiesPopover(capabilities: store.capabilities,
                                    emptyText: store.slashPaletteEmptyState(shown: [])?.text ?? SlashPaletteEmptyState.userSettingsOff.text)
            }
        }
    }
}

/// A `.help` only when there is text — an outer `.help("")` would still hide the tooltips of the views inside (polish PX-01/02).
private struct OptionalHelp: ViewModifier {
    let text: String?
    func body(content: Content) -> some View {
        if let text { content.help(text) } else { content }
    }
}

/// Everything the session loaded, grouped, so the user knows what `/name` can reach.
private struct CapabilitiesPopover: View {
    let capabilities: SessionCapabilities?
    /// wave3 mac-session (§36.5): what to say without capabilities ("Starting session…" while the CLI starts).
    let emptyText: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let caps = capabilities {
                    group("Skills", caps.skills)
                    group("Commands", caps.slashCommands)
                    group("Plugins", caps.plugins)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("MCP servers").font(.subheadline.weight(.semibold))
                        if caps.mcpServers.isEmpty {
                            Text("none").font(.callout).foregroundStyle(.secondary)
                        }
                        ForEach(Array(caps.mcpServers.enumerated()), id: \.offset) { _, server in
                            HStack(spacing: 6) {
                                Circle().fill(server.status == "connected" ? Color.green : Color.orange).frame(width: 7, height: 7)
                                Text(verbatim: server.name).font(.callout.monospaced())
                                Text(verbatim: server.status).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Text(verbatim: emptyText)
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(width: 320, alignment: .leading)
        }
        .frame(maxHeight: 420)
        .accessibilityIdentifier("Capabilities popover")
    }

    private func group(_ title: LocalizedStringKey, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.subheadline.weight(.semibold))
            if items.isEmpty {
                Text("none").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(items, id: \.self) { Text(verbatim: $0).font(.callout.monospaced()) }
        }
    }
}


/// polish P4-composer-16: the message box's top edge — drag it to make the box taller (kept across launches); a double-click
/// gives it back its own height.
private struct InputHeightHandle: View {
    /// The box's height now (where a drag starts).
    let shown: CGFloat
    let window: CGFloat
    @Binding var dragged: Double
    @State private var start: CGFloat?

    /// The box's least and greatest height: the dragged one (or one line) and 40 % of the window (at least 128 pt) — more
    /// when dragged higher, never past 60 %.
    static func limits(dragged: Double, window: CGFloat) -> (min: CGFloat, max: CGFloat) {
        let ceiling = max(128, window * 0.6)
        let least = dragged > 0 ? min(max(30, CGFloat(dragged)), ceiling) : 30
        return (least, min(ceiling, max(least, max(128, window * 0.4))))
    }

    var body: some View {
        Color.clear
            .frame(height: 6)
            .contentShape(Rectangle())
            .offset(y: -3)
            .pointerStyle(.rowResize)
            .gesture(DragGesture(minimumDistance: 1)
                .onChanged { value in
                    let base = start ?? shown
                    if start == nil { start = shown }
                    dragged = Double(min(max(128, window * 0.6), max(30, base - value.translation.height)))
                }
                .onEnded { _ in start = nil })
            .onTapGesture(count: 2) { dragged = 0 }
            .help("Drag to make the message box taller — double-click for its own height")
            .accessibilityHidden(true)
    }
}
