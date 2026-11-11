import SwiftUI
import ReviewGateCore

// MARK: wave7 w7-state — §45.2: the project menus of the menu bar. Each reads the key window's `menuState` (one Equatable
// value the store writes only when what the menus show changed) and acts on the store when chosen, so a snapshot that does
// not change them re-evaluates none — and AppKit does not walk the menu bar's key equivalents again.

/// View › Refresh (⌘R) and the pane toggles.
struct ViewMenuCommands: Commands {
    let focused: WorkbenchWindowEntry?
    // polish PX-12 / P2-review-19: the app's text size and the diff's view switches, shared with the diff header.
    @AppStorage(TextScale.key) private var textScale = TextScale.standard
    @AppStorage(DiffPrefsKeys.showFullFile) private var showFullFile = false
    @AppStorage(DiffPrefsKeys.ignoreWhitespace) private var ignoreWhitespace = false
    @AppStorage(DiffPrefsKeys.wrapLines) private var wrapLines = true

    var body: some Commands {
        // M15: View → Refresh (⌘R) — the review re-diff, branches, workbenches, PRs; on the PR tab only the PR lists.
        CommandGroup(after: .sidebar) {
            let store = focused?.store
            let menu = store?.menuState ?? MenuState()
            let onPRs = focused?.model.tab == .prs
            Button("Refresh") {
                if let store { Task { await store.refresh(scope: onPRs ? [.pr] : nil) } }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(store == nil || (!menu.hasProject && !onPRs) || menu.isRefreshing)
            .accessibilityIdentifier("View menu Refresh")
            // M16: collapse / expand the diff pane (remembered per project).
            Button("Toggle Diff Pane") { focused?.model.toggleDiffTick += 1 }
                .keyboardShortcut("d", modifiers: [.command, .shift])
                .disabled(!menu.hasProject || onPRs)
                .accessibilityIdentifier("View menu Toggle diff pane")
            Button("Toggle Agent Panel") { focused?.model.toggleAgentPanelTick += 1 }
                .keyboardShortcut("a", modifiers: [.command, .option])
                .disabled(!menu.hasProject)
                .accessibilityIdentifier("View menu Toggle agent panel")
            Button("Toggle Side Questions") { focused?.model.toggleSidePanelTick += 1 }
                .keyboardShortcut("s", modifiers: [.command, .option])
                .disabled(!menu.hasProject)
                .accessibilityIdentifier("View menu Toggle side panel")
            Divider()
            // polish P1-chrome-20: the sidebar's tabs from the keyboard (⌘1…⌘9 are the chat tabs).
            ForEach(Array(MainTab.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { focused?.model.tab = tab }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .option])
                    .disabled(!menu.hasProject && tab != .prs)
                    .accessibilityIdentifier("View menu tab \(tab.rawValue)")
            }
            // polish P3-transcript-17: back to the newest message, following it again (the "↓ 최신" pill).
            Button("Jump to Latest") { focused?.model.jumpToLatestTick += 1 }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(!menu.hasProject)
                .accessibilityIdentifier("View menu Jump to latest")
            Divider()
            // polish P2-review-19: the diff's view switches.
            Toggle("Show Full File", isOn: $showFullFile)
                .accessibilityIdentifier("View menu Show full file")
            Toggle("Ignore Whitespace", isOn: $ignoreWhitespace)
                .accessibilityIdentifier("View menu Ignore whitespace")
            Toggle("Wrap Lines", isOn: $wrapLines)
                .accessibilityIdentifier("View menu Wrap lines")
            Divider()
            // polish PX-12: one text size for the app (the diff, the chat, the message box), kept across launches.
            Button("Zoom In") { textScale = TextScale.larger(textScale) }
                .keyboardShortcut("+", modifiers: .command)
                .disabled(!TextScale.canEnlarge(textScale))
                .accessibilityIdentifier("View menu Zoom in")
            Button("Zoom Out") { textScale = TextScale.smaller(textScale) }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(!TextScale.canShrink(textScale))
                .accessibilityIdentifier("View menu Zoom out")
            Button("Actual Size") { textScale = TextScale.standard }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(TextScale.clamped(textScale) == TextScale.standard)
                .accessibilityIdentifier("View menu Actual size")
        }
    }
}

/// ⌘F searches the chat transcript of the key window (its find bar has ⌘G / ⇧⌘G); ⌥⌘F the diff in front.
struct EditMenuFindCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandGroup(after: .textEditing) {
            // MARK: code-browser (§47): with a project file open in the diff pane, ⌘F finds in that file (as ⌥⌘F does);
            // Find in Chat stays in the menu without its key.
            let fileOpen = focused?.store.codeBrowser.isOpen == true
            if fileOpen {
                Button("Find in File…") { focused?.model.diffFindTick += 1 }
                    .keyboardShortcut("f", modifiers: .command)
                    .accessibilityIdentifier("Edit menu Find in file")
            }
            Button("Find in Chat…") {
                // polish P2-review-09: ⌘F finds where the user is — the History tab's search, the diff after a click in it,
                // else the chat.
                guard let model = focused?.model else { return }
                if model.tab == .history { model.historySearchFocusTick += 1 }
                else if model.lastFocusArea == .diff { model.diffFindTick += 1 }
                else { model.findTick += 1 }
            }
                .keyboardShortcut(fileOpen ? nil : KeyboardShortcut("f", modifiers: .command))
                .disabled(focused?.store.menuState.hasProject != true)
                .accessibilityIdentifier("Edit menu Find in chat")
            // polish P3-transcript-17: the next / previous match of the chat's find, with its bar closed too.
            Button("Find Next") { focused?.model.transcriptFindNextTick += 1 }
                .keyboardShortcut("g", modifiers: .command)
                .disabled(focused?.store.menuState.hasProject != true)
                .accessibilityIdentifier("Edit menu Find next")
            Button("Find Previous") { focused?.model.transcriptFindPreviousTick += 1 }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(focused?.store.menuState.hasProject != true)
                .accessibilityIdentifier("Edit menu Find previous")
            // wave2 mac-diff (comp-19): the diff in front — the review diff, its full file, a history or PR diff.
            Button("Find in Diff…") { focused?.model.diffFindTick += 1 }
                .keyboardShortcut("f", modifiers: [.command, .option])
                .disabled(focused == nil)
                .accessibilityIdentifier("Edit menu Find in diff")
        }
        // code-browser (§47): File › Go to File (⌘P), Find in Project (⇧⌘F) — here, as the app's command list is full.
        CodeBrowserCommands(focused: focused)
    }
}

/// Review menu (audit 1.11): every review action with its shortcut, on the key window's store.
struct ReviewCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandMenu("Review") {
            let store = focused?.store
            let model = focused?.model
            let menu = store?.menuState ?? MenuState()
            // wave2 mac-flow (§34.2): accept also applies while a turn runs on a standing review; reject waits for its end.
            // polish P2-review-23: Edit › Undo (⌘Z, outside a text field) takes the accept / the reject back.
            Button("Accept") { if let store, let selected = store.selectedFile { ReviewUndo.accept(selected, store: store, window: focused?.window) } }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .disabled(!menu.canAcceptSelected)
                .accessibilityIdentifier("Review menu Accept")
            // wave4 w4-safety (daily-11): ⌘⇧R sits next to ⌘R Refresh — the revert asks first.
            Button("Reject") {
                if let store, let selected = store.selectedFile {
                    let window = focused?.window
                    WorkSafetyAlerts.confirmReject(selected, window: window) { ReviewUndo.reject(selected, store: store, window: window) }
                }
            }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(!menu.canRejectSelected)   // §32: an uncaptured file cannot be reverted
                .accessibilityIdentifier("Review menu Reject")
            // ⌘⇧A has already moved the selection on: this undoes the last accept (or the selected accepted file's).
            Button("Undo Accept") { store?.undoAccept() }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                .disabled(!menu.canUndoAccept)
                .accessibilityIdentifier("Review menu Undo accept")
            // MARK: wave4c w4c-trust (§41.2): the reject banner's "거절 취소", from the menu bar too.
            Button("Undo Reject") { store?.undoLastReject() }
                .disabled(!menu.canUndoReject)
                .accessibilityIdentifier("Review menu Undo reject")
            Divider()
            // polish P2-review-20: the next / previous change inside the file's diff (⌘] / ⌘[ move between files).
            Button("Next Change") { model?.nextChangeTick += 1 }
                .keyboardShortcut("]", modifiers: [.command, .option])
                .disabled(!menu.hasProject || model?.tab.showsReview != true)
                .accessibilityIdentifier("Review menu Next change")
            Button("Previous Change") { model?.previousChangeTick += 1 }
                .keyboardShortcut("[", modifiers: [.command, .option])
                .disabled(!menu.hasProject || model?.tab.showsReview != true)
                .accessibilityIdentifier("Review menu Previous change")
            Button("Next Pending File") { store?.selectNextPending() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!menu.hasPending)
                .accessibilityIdentifier("Review menu Next pending")
            Button("Previous Pending File") { store?.selectPreviousPending() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!menu.hasPending)
                .accessibilityIdentifier("Review menu Previous pending")
            Divider()
            // r2-review-flow M28: at once with an undo toast — the summary sheet only when a file still needs a look.
            Button("Accept All…") { if let store, let model { AcceptAllAction.run(store: store, model: model) } }
                .keyboardShortcut("a", modifiers: [.command, .option, .shift])
                .disabled(!menu.canAcceptAll)
                .accessibilityIdentifier("Review menu Accept all")
            Button("Reject All…") { model?.showRejectAll = true }
                .disabled(!menu.canRejectAll)
                .accessibilityIdentifier("Review menu Reject all")
            // wave1 mac-review — §31.5: empties the list without touching a file.
            Button("Finish Review…") { model?.showFinishReview = true }
                .disabled(!menu.canFinishReview)
                .accessibilityIdentifier("Review menu Finish review")
            Divider()
            // polish P2-review-19: a note on the selected line (the diff says when it can open one), the file in the
            // editor, its path.
            Button("Add Note…") { model?.addNoteTick += 1 }
                .keyboardShortcut("n", modifiers: [.command, .option])
                .disabled(model?.canAddNote != true)
                .accessibilityIdentifier("Review menu Add note")
            Button("Open in Editor") {
                guard let store, let file = store.selectedFile, let root = store.projectInfo?.root ?? store.projectURL?.path else { return }
                (ExternalEditor.preferred ?? ExternalEditor.installed.first ?? .finder).open((root as NSString).appendingPathComponent(file.path), line: 1)
            }
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(store?.selectedFile == nil || store?.selectedFile?.status == .deleted)
                .accessibilityIdentifier("Review menu Open in editor")
            Button("Copy Path") { if let path = store?.selectedFile?.path { Clipboard.copy(path, toast: String(localized: "Path copied")) } }
                .keyboardShortcut("c", modifiers: [.command, .option])
                .disabled(store?.selectedFile == nil)
                .accessibilityIdentifier("Review menu Copy path")
            Divider()
            // §21: a side question on the clicked line / selected file, without touching the main conversation.
            // wave4 w4-input (polish-05): ⌥⌘/ — macOS keeps ⌘⇧/ for its Help menu search.
            Button("Ask About Selection…") { model?.askSelectionTick += 1 }
                .keyboardShortcut("/", modifiers: [.command, .option])
                .disabled(!menu.canAskSide)
                .accessibilityIdentifier("Review menu Ask about selection")
            Button("Request Changes") { model?.requestChangesTick += 1 }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(!menu.hasProject || model?.tab.showsReview != true)
                .accessibilityIdentifier("Review menu Request changes")
            Button("Commit Accepted…") { model?.showCommit = true }
                .keyboardShortcut("k", modifiers: [.command, .shift])
                .disabled(!menu.canCommit)
                .accessibilityIdentifier("Review menu Commit accepted")
            // polish P5-sheets-46: the PR sheet from the menu bar too (it was only in the branch menu and the commit banner).
            Button("Create PR from this branch…") { model?.createPRTick += 1 }
                .keyboardShortcut("k", modifiers: [.command, .option])
                .disabled(!menu.hasProject)
                .accessibilityIdentifier("Review menu Create PR")
        }
    }
}

/// Workbenches menu (audit 4.3): the switcher's workbench section, reachable from the menu bar.
struct WorkbenchCommands: Commands {
    let focused: WorkbenchWindowEntry?
    let openWindow: OpenWindowAction
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49

    var body: some Commands {
        CommandMenu("Workbenches") {
            let store = focused?.store
            let menu = store?.menuState ?? MenuState()
            Button("New Workbench…") { focused?.model.showNewWorkbench = true }
                .disabled(!menu.hasProject)
                .accessibilityIdentifier("Workbenches menu New Workbench…")
            if runAsTaskEnabled {   // §49
                Button("Run as Task…") { focused?.model.runAsTask("") }
                    .disabled(!menu.hasProject)
                    .accessibilityIdentifier("Workbenches menu Run as Task…")
            }
            // polish P1-chrome-36: not the same name as View › Refresh (⌘R).
            Button("Refresh Workbenches") { if let store { Task { await store.refreshWorkbenches() } } }
                .disabled(!menu.hasProject)
            Divider()
            if !menu.workbenches.isEmpty {
                ForEach(menu.workbenches) { wb in
                    Button {
                        if !wb.isCurrent { openWorkbench(URL(fileURLWithPath: wb.path)) }
                    } label: {
                        if wb.isCurrent {
                            Label(title(wb), systemImage: "checkmark")
                        } else {
                            Text(verbatim: title(wb))
                        }
                    }
                    .disabled(wb.isCurrent)
                    .accessibilityIdentifier("Workbenches menu \(wb.branch ?? wb.path)")
                }
            } else {
                Text("No workbenches")
            }
        }
    }

    private func title(_ wb: WorkbenchMenuItem) -> String {
        var parts = [wb.branch ?? String(localized: "detached")]
        if wb.isMain { parts.append(String(localized: "primary")) }
        if wb.dirty == true { parts.append("●") }
        return parts.joined(separator: " · ")
    }

    /// Opens `url` in its own window, or focuses the window that already has it open (same as the switcher).
    private func openWorkbench(_ url: URL) {
        if WorkbenchRegistry.shared.focusWindow(for: url) { return }
        openWindow(id: "workbench", value: ProjectOpener.newWindowValue(url))
    }
}
