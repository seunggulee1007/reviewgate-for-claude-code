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
    /// Slash palette: opened by ⌘/ over a typed draft (until the draft changes), closed by Esc until the draft changes.
    var paletteForced = false
    var paletteDismissed = false
    var paletteIndex = 0
    /// A refused paste / drop / attachment, shown above the composer for a few seconds.
    var notice: String?
    var dropHover = false
    /// ↑ / ↓ in an empty composer: this project's previous prompts.
    @ObservationIgnored var history = PromptHistoryNavigator(entries: [])

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
        return true
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
    let composer: ComposerModel

    var body: some View {
        let projectOpen = store.projectInfo != nil
        if let query = composer.mentionQuery(projectOpen: projectOpen), !composer.mentionDismissed {
            MentionPalette(query: query.query, entries: composer.mentionEntries(changedFiles: store.changedFiles, projectOpen: projectOpen),
                           selection: composer.mentionIndex, isLoading: composer.mentionLoading,
                           onPick: { composer.pickMention($0, store: store) })
        } else if composer.paletteVisible(available: store.canUseSlashPalette) {   // r1-composer M14: while Claude works too
            // wave3 mac-session (§36.5): descriptions, hints, groups, recently used first, "Starting session…".
            let sections = composer.paletteSections(store)
            SlashCommandPalette(sections: sections, selection: composer.paletteIndex,
                                emptyState: store.slashPaletteEmptyState(shown: SlashCommandCatalog.flatten(sections)),
                                cached: store.capabilitiesAreCached, starting: store.isSessionStarting,
                                onPick: { composer.pick($0, store: store) })
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
    /// "Accept N & Send" asks first when it would accept more than three files.
    @State private var confirmAcceptAndSend = false
    /// ↩ sends, ⇧↩ is a new line (Settings › General); off: ↩ is a new line and ⌘↩ sends.
    @AppStorage(AppSettings.Key.returnSends) private var returnSends = true
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewingChatBar()   // MARK: wave4b w4b-tabs — §39.2 "이 채팅을 보는 중이에요 — 보내면 이 채팅으로 이어가요"
            if pendingReviewCount > 0 {
                // Sending answers a question; it never accepts. Say so, so nobody sends to "get past" the review — and
                // (wave2 mac-flow, comp-04) that Claude's next changes join this review rather than a review of their own.
                VStack(alignment: .leading, spacing: 3) {
                    Label("\(pendingReviewCount) files pending review — you can ask questions without accepting",
                          systemImage: "checklist")
                        .font(.callout)
                        .foregroundStyle(.orange)
                    Text("Sending now adds Claude's new changes to this review (same starting point). To review them separately, accept or reject first.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 22)
                        .accessibilityIdentifier("Pending banner merge note")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("Pending banner")
            }
            if !store.queuedMessages.isEmpty || store.sendAfterInterrupt != nil {
                ComposerQueueBar(messages: store.queuedMessages,
                                 stopAndSend: store.sendAfterInterrupt,
                                 pausedReason: store.queuePausedReason,
                                 holdReason: store.queueHoldReason,
                                 waitingOnAgents: store.waitingOnAgents != nil,   // wave3 mac-agents (§36.4)
                                 onUpdate: { store.updateQueued(id: $0, text: $1) },
                                 onRemove: { store.removeQueued(id: $0) },
                                 onMove: { store.moveQueued(id: $0, by: $1) },
                                 onResume: { store.resumeQueue() },
                                 onClear: { store.clearQueue() })
            }
            if let warning = store.contextWarning {
                ContextWarningBanner(warning: warning)
            }
            if let notice = composer.notice {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                    .accessibilityIdentifier("Composer notice")
            }
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
                        .help("Reconnects this chat")
                        .accessibilityLabel("Restart session")
                        .accessibilityIdentifier("Restart session")
                    if store.hasChatSessions {
                        Button("New chat", systemImage: "plus.bubble") { store.startNewChat() }
                            .controlSize(.small)
                            .disabled(store.chatSwitchBlocker != nil)
                            .help(store.chatSwitchBlocker ?? String(localized: "Continue in a fresh chat; this one stays in the history"))
                            .accessibilityIdentifier("New chat from ended session")
                    }
                } else if let waiting = store.waitingOnAgents, pendingToolPermission == nil, store.state.gate.blockedReason == .running,
                          !store.isExternalTurn {
                    AgentWaitStatusLine(waiting: waiting, queueHint: canQueue)   // wave3 mac-agents (§36.4)
                } else if store.viewingChat != nil {
                    // MARK: wave4b w4b-tabs — §39.2: why a send from this chat waits, else the plain hint
                    Text(store.viewingSendBlocker ?? sendHint)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("Viewing chat hint")
                } else if question != nil {
                    // r1-composer M08: ↩ answers Claude's open question (the card above); ⌥↩ sends the text apart from it.
                    Text(verbatim: questionHint)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("Question hint")
                } else if let reason = store.cannotSendReason {
                    Text(pendingToolPermission != nil && trimmedDraft.isEmpty
                         ? String(localized: "\(reason) — ⌘↩ allow · ⌘⌫ deny")
                         : canSteer ? (returnSends ? String(localized: "\(reason) — ↩ sends it to Claude now") : String(localized: "\(reason) — ⌘↩ sends it to Claude now"))
                         : canQueue ? (returnSends ? String(localized: "\(reason) — ↩ queues your message") : String(localized: "\(reason) — ⌘↩ queues your message")) : reason)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    // A narrow chat pane drops the hint instead of stacking it letter by letter.
                    ViewThatFits(in: .horizontal) {
                        Text(verbatim: sendHint).font(.caption).foregroundStyle(.secondary).fixedSize()
                        Color.clear.frame(width: 0, height: 0)
                    }
                }
                CapabilitiesCaption()
                Spacer()
                if store.isRunning {
                    // MARK: wave4 w4-safety — robustness-07: the stop did not stop within 10 s.
                    if store.showsForceRestart {
                        Button("Force restart", systemImage: "arrow.clockwise.circle") { store.forceRestartStuckTurn() }
                            .help("The turn did not stop. Ends the Claude process and continues the same conversation — the queue and the review stay.")
                            .accessibilityLabel("Force restart")
                            .accessibilityIdentifier("Force restart")
                    }
                    Button("Stop", systemImage: "stop.fill") { store.interrupt() }
                        .keyboardShortcut(".", modifiers: .command)
                        .accessibilityLabel("Stop")
                        .accessibilityIdentifier("Stop")
                }
                // wave4b w4b-tabs (§39.2): the review is the running chat's — its buttons wait for it to be shown.
                if store.viewingChat == nil, store.hasPendingReview || !store.reviewNotes.isEmpty {
                    // wave2 mac-flow (§34.4): the count is what goes out — sent notes are never sent again.
                    Button("Request changes (\(store.unsentNotes.count))", systemImage: "exclamationmark.bubble") { requestChanges() }
                        .disabled(!store.canRequestChanges)
                        .help("Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)")
                        .accessibilityLabel("Request changes")
                        .accessibilityIdentifier("Request changes")
                }
                if acceptAndSend, store.viewingChat == nil {   // wave4b w4b-tabs
                    // A separate, explicitly labelled action: accepting is never a side effect of Send.
                    Menu {
                        Button("Accept \(store.pendingFiles.count) & Send") { acceptAndSendTapped() }
                            .keyboardShortcut(.return, modifiers: [.command, .shift])
                            .disabled(composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("Accept and send")
                    } label: {
                        Text("Accept \(store.pendingFiles.count) & Send")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Accepts the \(store.pendingFiles.count) pending file(s), then sends this message (⌘⇧↩)")
                    .accessibilityLabel("Accept and send")
                }
                NextMessageModelMenu()   // wave5 w5-model (§43.4): "이번엔 opus"
                PermissionModePicker()
                if let question {
                    // r1-composer M08: the message answers Claude's open question (↩); the menu sends it apart from it (⌥↩) —
                    // into the turn, where it is read once the question is answered — or queues it, or stops the turn first.
                    Menu {
                        Button("Send apart from the question", systemImage: "paperplane") { sendWhileWorking() }
                            .disabled(trimmedDraft.isEmpty || !canQueue)
                            .accessibilityIdentifier("Send apart from the question")
                        Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                            .disabled(trimmedDraft.isEmpty || !canQueue)
                        Button("Stop and send", systemImage: "stop.circle") { stopAndSend() }
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
                    .help("Answers Claude's question with your message (↩) — with an empty box, sends the card as it is. The menu sends the message apart from the question (⌥↩).")
                    .accessibilityLabel("Send answer")
                    .accessibilityIdentifier("Send answer")
                } else if canSteer {
                    // §50: while Claude works the message goes into the turn (primary, ↩ / ⌘↩) — as in the terminal; the menu
                    // queues it for after the turn or stops the turn and sends it right after.
                    Menu {
                        Button("Add to queue", systemImage: "text.badge.plus") { queueDraft() }
                            .disabled(trimmedDraft.isEmpty)
                            .accessibilityIdentifier("Add to queue")
                        Button("Stop and send", systemImage: "stop.circle") { stopAndSend() }
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
                    .help("Sends your message to Claude now: it reads it as soon as the current step is done, and its changes join this turn's review (↩). The menu queues it for after the turn or stops the turn first.")
                    .accessibilityLabel("Send now")
                    .accessibilityIdentifier("Send now")
                } else if canQueue {
                    // While Claude works: queue (primary, ⌘↩) or stop the turn and send this right after it.
                    Menu {
                        Button("Stop and send", systemImage: "stop.circle") { stopAndSend() }
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
                    .help("Queues your message; it is sent when Claude is free. The menu has “Stop and send”. (⌘↩)")
                    .accessibilityLabel("Add to queue")
                    .accessibilityIdentifier("Add to queue")
                } else {
                    Button("Send", systemImage: "paperplane.fill") { send() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!sendEnabled || trimmedDraft.isEmpty)   // wave4b w4b-tabs
                        .help(store.viewingSendBlocker ?? String(localized: "Sends your message. The review list is left exactly as it is (⌘↩)"))
                        .accessibilityLabel("Send")
                        .accessibilityIdentifier("Send")
                }
            }
            .background { StatusLineMeter() }   // MARK: wave6 w6-statusline — §44.2: the width the status line has
            StatusLineSlot()   // MARK: wave6 w6-statusline — §44.2: under the input, as in the terminal (only when it has lines)
            SidecarLogDisclosure()   // MARK: wave7 w7-chat — §45.1: a log line redraws only this disclosure
        }
        .padding(12)
        .alert("Accept \(store.pendingFiles.count) files and send?", isPresented: $confirmAcceptAndSend) {
            Button("Accept and send") { sendAccepting() }
            Button("Cancel", role: .cancel) { confirmAcceptAndSend = false }
        } message: {
            Text("Every pending file is accepted, then your message is sent. Sending on its own never accepts anything.")
        }
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
        .task(id: mentionVisible ? mentionQuery?.query : nil) {
            // §23: debounced `list_files`; a newer query cancels this one.
            guard mentionVisible, let query = mentionQuery?.query else { composer.mentionResults = []; return }
            composer.mentionLoading = true
            try? await Task.sleep(for: .milliseconds(110))
            guard !Task.isCancelled else { return }
            let items = await store.listFiles(query: query)
            guard !Task.isCancelled else { return }
            composer.mentionResults = items
            composer.mentionLoading = false
            composer.mentionIndex = min(composer.mentionIndex, max(mentionEntries.count - 1, 0))
        }
        .onChange(of: model.mentionTick) { _, _ in
            // The changed-files list's "Mention in Chat".
            composer.addMentions(model.mentionPaths)
            composer.inputFocused = true
        }
        // wave3 mac-flow (§36.14): "Send to Claude" from the PR tab — also when the chat was not on screen yet.
        .onChange(of: model.composerDraftTick) { _, _ in composer.takeComposerDraft(model) }
        .onAppear { composer.takeComposerDraft(model) }
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
        .onChange(of: store.taskForComposer?.id, initial: true) { _, _ in
            guard let handed = store.taskForComposer else { return }
            store.takeTaskForComposer(handed.id)
            model.insertIntoComposer(handed.text)
        }
        // MARK: wave4 w4-safety — polish-12: each chat tab keeps its own draft (text, mentions, images).
        .onChange(of: store.draftChatId) { previous, current in
            guard let previous, let current, previous != current else { return }
            // wave6 w6-terminal (§44.1): a recalled prompt on screen is not the draft — the one typed before ↑ is kept.
            store.stashDraft(ChatDraft(text: composer.history.parkedDraft ?? composer.draft, mentions: composer.mentions, images: composer.images),
                             for: previous)
            composer.history.reset(entries: store.promptHistory)
            let kept = store.takeDraft(for: current)
            composer.draft = kept.text
            composer.mentions = kept.mentions
            composer.images = kept.images
        }
        .task(id: composer.notice) {
            guard composer.notice != nil else { return }
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { composer.notice = nil }
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

    /// The plain hint under the composer, after the send key in use.
    private var sendHint: String {
        returnSends ? String(localized: "↩ to send · ⇧↩ new line · ⌘/ commands") : String(localized: "⌘↩ to send · ⌘/ commands")
    }
    /// Busy in a way that ends by itself: a draft can be queued and goes out once the session takes it.
    /// §50: the draft can go into the running turn (images wait for the turn: the CLI takes them only with a new message).
    private var canSteer: Bool { canQueue && store.canSteer && composer.images.isEmpty }

    private var canQueue: Bool {
        // wave4b w4b-tabs: from another chat shown read-only a message never joins the running chat's queue
        store.viewingChat == nil
            && !store.canSend && (store.isRunning || store.isSnapshotting || store.isReverting || store.isStarting || store.isExternalTurn)
    }
    /// wave4b w4b-tabs (§39.2): Send is possible — from another chat shown read-only, when the session can move to it.
    private var sendEnabled: Bool { store.viewingChat == nil ? store.canSend : store.viewingSendBlocker == nil }
    /// The permission the composer's ⌘↩ / ⌥⌘↩ / ⌘⌫ answer: the oldest open request that is not an AskUserQuestion (its
    /// card has its own keys) — §33.1, wave1 mac-perms.
    private var pendingToolPermission: PermissionRequest? { store.shortcutPermission }
    /// r1-composer M08: Claude's open question — ↩ answers it instead of putting the text into the turn.
    private var question: OpenQuestion? { store.openQuestion }

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
        guard !trimmedDraft.isEmpty else { return }
        let (queuedMentions, queuedImages) = composer.takeInputs(history: store.promptHistory)
        store.enqueue(composer.draft, mentions: queuedMentions, images: queuedImages)
        composer.draft = ""
        composer.closePalette()
        composer.inputFocused = true
    }

    /// "중단하고 보내기" (§28): interrupt, then this message right behind it.
    private func stopAndSend() {
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
            if store.canSend { send() } else if canQueue { sendWhileWorking() } else { return false }
        // MARK: wave4d w4d-windows (polish-08): ⌥⌘↩ with text — stop and send while Claude works (Windows' Ctrl+Alt+Enter).
        case .stopAndSendDraft:
            if store.canSend { send() } else if store.isRunning { stopAndSend() } else if canQueue { queueDraft() } else { return false }
        case let .allowOnce(id):
            store.respondPermission(requestId: id, allow: true)
        case let .allowForSession(id):
            store.respondPermission(requestId: id, allow: true, remember: true)
        case let .deny(id):
            store.respondPermission(requestId: id, allow: false, message: String(localized: "Denied by user"))
        default:
            return false
        }
        return true
    }

    /// ↩ with "Return sends" on: the draft goes as ⌘↩ with text does (sent, or queued while Claude works). It never answers a
    /// permission card — a stray Return must not allow a command — and an empty or blocked draft stays as it is.
    private func sendFromReturn() -> Bool {
        // r1-composer M08: ↩ answers Claude's open question (with an empty box: sends its card as it is).
        if let question {
            answerQuestion(question)
            return true
        }
        guard !trimmedDraft.isEmpty else { return true }
        if store.viewingChat != nil {
            if store.viewingSendBlocker == nil { send() }
        } else if store.canSend {
            send()
        } else if canQueue {
            sendWhileWorking()
        }
        return true
    }

    /// "Accept N & Send" (⌘⇧↩): confirmed first when it would accept more than three files.
    private func acceptAndSendTapped() {
        guard acceptAndSend, !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if store.pendingFiles.count > 3 { confirmAcceptAndSend = true } else { sendAccepting() }
    }

    private func sendAccepting() {
        let text = composer.draft
        guard acceptAndSend, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        confirmAcceptAndSend = false
        let (sentMentions, sentImages) = composer.takeInputs(history: store.promptHistory)
        composer.draft = ""
        composer.closePalette()
        store.send(text, acceptPending: true, mentions: sentMentions, images: sentImages)
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
                                 onKey: handleKey, onDrop: { composer.takeDrop($0, root: store.projectURL) },
                                 onDragHover: { composer.dropHover = $0 })
                    .frame(height: min(max(composer.height, 30), 128))
                composerTools.padding(.bottom, 4)
            }
        }
        .padding(6)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(composer.dropHover ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary),
                              style: StrokeStyle(lineWidth: composer.dropHover ? 2 : 1, dash: composer.dropHover ? [5, 3] : []))
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
            .help("Attach images (PNG, JPEG, GIF, WebP · up to 5, 5 MB each) — or paste with ⌘V / drop them here")
            .accessibilityLabel("Attach images")
            .accessibilityIdentifier("Attach images")
            Button {
                composer.insertAtSign()
            } label: {
                Image(systemName: "at")
            }
            .disabled(store.projectInfo == nil)
            .help("Mention a file or folder (@) — or drag files from Changes or Finder here")
            .accessibilityLabel("Mention a file")
            .accessibilityIdentifier("Mention a file")
            if runAsTaskEnabled {   // §49
                Button {
                    model.runAsTask(Self.taskText(draft: composer.draft, mentions: composer.mentions))
                } label: {
                    Image(systemName: "arrow.triangle.branch")
                }
                .disabled(store.projectInfo == nil || store.viewingChat != nil)
                .help("Run as Task — start this message in a new workbench (its own branch, window and chat); this chat is left as it is")
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
                 .optionEnter, .digit:
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
            guard paletteVisible else { return key == .enter && returnSends ? sendFromReturn() : false }
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
            // MARK: wave6 w6-terminal — §44.1: Esc stops Claude's running turn, as in the terminal (⌘. does too).
            if store.isRunning, store.viewingChat == nil { store.interrupt(); return true }
            return false
        }
    }
}

/// Last 500 sidecar `log` events, so IPC problems are diagnosable without a terminal.
/// MARK: wave7 w7-chat — §45.1: its own view — a log line redraws this line, not the chat.
private struct SidecarLogDisclosure: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        @Bindable var model = model
        DisclosureGroup(isExpanded: $model.showSidecarLog) {
            ScrollView {
                Text(store.logs.isEmpty ? String(localized: "(no sidecar log yet)") : store.logs.joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
            }
            .frame(height: 140)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        } label: {
            Text("Sidecar log (\(store.logs.count))").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("Sidecar log")
    }
}

// MARK: Capabilities caption

private struct CapabilitiesCaption: View {
    @Environment(AppState.self) private var store
    @State private var showCapabilities = false

    var body: some View {
        Button {
            showCapabilities.toggle()
        } label: {
            if let caps = store.capabilities {
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
                    Text("\(caps.skills.count) skills · \(caps.slashCommands.count) commands · \(store.mcp.loaded ? store.mcp.servers.count : caps.mcpServers.count) MCP servers")
                    if store.capabilitiesAreCached { Text("(cached)") }   // wave3 mac-session: the engine's cache too
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
        .help("Skills, slash commands, plugins and MCP servers available in this session")
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
