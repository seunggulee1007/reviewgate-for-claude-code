import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave3 mac-flow
// docs/PROTOCOL.md §36.14 on the Mac: PR comments to Claude ("Claude에게 보내기" per comment, "미해결 전체 보내기") as a composer
// draft — in the window of the PR head branch's workbench when one is open, else this window; starting with the repository's
// PR command (e.g. /acme-tools:review-reply {pr}) when one is set. Nothing goes out without the user's send. Also
// "워크벤치로 열기" for the PR's head and the PR diff line's "곁질문".

@MainActor
enum PRClaudeRouting {
    /// The workbench of the PR's head branch — only for a PR of the open project's repository.
    static func workbench(headRef: String, store: AppState) -> WorkbenchInfo? {
        guard PRClaude.isProjectRepo(prRepo: store.pr.selectedSummary?.repo, remote: store.projectInfo?.remoteURL) else { return nil }
        return store.workbenches.list.first { $0.branch == headRef }
    }

    /// The window the draft goes to: the one whose project is the PR head branch's workbench, else `store`'s own.
    static func target(headRef: String, store: AppState) -> WorkbenchWindowEntry? {
        let registry = WorkbenchRegistry.shared
        if let workbench = workbench(headRef: headRef, store: store),
           let entry = registry.entry(for: URL(fileURLWithPath: workbench.path)), entry.store.projectURL != nil {
            return entry
        }
        return registry.entry(for: store)
    }

    /// Why "Send to Claude" cannot work from `store`'s window; nil = it can.
    static func blocker(headRef: String, store: AppState) -> String? {
        guard let entry = target(headRef: headRef, store: store), entry.store.projectURL != nil else {
            return String(localized: "Open the project in this window first (⌘O) — the comments go to its Claude")
        }
        return nil
    }

    /// Puts `threads` into the target window's composer (the chat comes forward) and returns where it went.
    @discardableResult
    static func send(threads: [PRCommentThread], pr: PRDetail, store: AppState) -> WorkbenchWindowEntry? {
        guard !threads.isEmpty, let entry = target(headRef: pr.headRefName, store: store), entry.store.projectURL != nil else { return nil }
        let command = PRClaude.respondCommand(entry.store.prRespondCommand, number: pr.number)
        entry.model.insertIntoComposer(PRClaude.draft(prNumber: pr.number, prTitle: pr.title, threads: threads, command: command))
        entry.model.tab = .changes
        if entry.store !== store { entry.focus() }
        return entry
    }

    /// Where the draft lands, for the buttons' help: the workbench's branch, or "this window".
    static func destination(headRef: String, store: AppState) -> String {
        guard let entry = target(headRef: headRef, store: store) else { return String(localized: "this window") }
        if entry.store === store { return String(localized: "this window") }
        return String(localized: "the \(headRef) workbench window")
    }
}

/// The PR head's Claude actions: "Open as workbench" (or the workbench that has the head already) and "Send all unresolved".
struct PRClaudeHeaderButtons: View {
    @Environment(AppState.self) private var app
    @Environment(PRStore.self) private var prs
    @Environment(WindowModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    let pr: PRDetail

    private var me: String? {
        let host = prs.selectedSummary?.host ?? prs.host
        return prs.accounts.first { $0.host == host }?.login
    }

    private var unresolved: [PRCommentThread] { PRClaude.unresolved(PRClaude.threads(prs.comments), me: me) }
    private var existingWorkbench: WorkbenchInfo? { PRClaudeRouting.workbench(headRef: pr.headRefName, store: app) }

    var body: some View {
        HStack(spacing: 6) {
            workbenchButton
            sendAllButton
        }
    }

    @ViewBuilder
    private var workbenchButton: some View {
        if let existing = existingWorkbench {
            Button("Open workbench", systemImage: "macwindow") { open(URL(fileURLWithPath: existing.path)) }
                .controlSize(.small)
                .disabled(existing.isCurrent)
                .help(existing.isCurrent ? String(localized: "This window is the PR head's workbench") : existing.path)
                .accessibilityIdentifier("Open PR workbench")
        } else {
            Button("Open as workbench", systemImage: "macwindow.badge.plus") {
                model.newWorkbenchFromPr = PRWorkbenchRequest(number: pr.number, headRef: pr.headRefName, baseRef: pr.baseRefName, title: pr.title)
                model.showNewWorkbench = true
            }
            .controlSize(.small)
            .disabled(workbenchBlocker != nil)
            .help(workbenchBlocker ?? String(localized: "Checks out the PR's head in a workbench of its own (with the repository's Workbench setup)"))
            .accessibilityIdentifier("Open PR as workbench")
        }
    }

    private var sendAllButton: some View {
        let threads = unresolved
        let blocker = threads.isEmpty ? String(localized: "No unresolved comments — every thread's last word is yours")
            : PRClaudeRouting.blocker(headRef: pr.headRefName, store: app)
        return Button {
            PRClaudeRouting.send(threads: threads, pr: pr, store: app)
        } label: {
            HStack(spacing: 4) {
                Label("Send all unresolved", systemImage: "paperplane")
                if !threads.isEmpty {
                    Text(verbatim: String(threads.count))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 4)
                        .background(Color.accentColor.opacity(0.18), in: Capsule())
                }
            }
        }
        .controlSize(.small)
        .disabled(blocker != nil)
        .help(blocker ?? String(localized: "Puts the threads you have not answered yet into Claude's message box in \(PRClaudeRouting.destination(headRef: pr.headRefName, store: app)) — you read it and send it"))
        .accessibilityIdentifier("Send all unresolved")
    }

    /// Why "Open as workbench" cannot work here; nil = it can.
    private var workbenchBlocker: String? {
        guard app.projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        let repo = prs.selectedSummary?.repo
        if !PRClaude.isProjectRepo(prRepo: repo, remote: app.projectInfo?.remoteURL) {
            return String(localized: "This PR is not of the open project's repository (\(repo ?? "?"))")
        }
        if !app.supportsWorkbenchSetup { return FlowText.updateReason }
        return nil
    }

    private func open(_ url: URL) {
        if WorkbenchRegistry.shared.focusWindow(for: url) { return }
        openWindow(id: "workbench", value: url.standardizedFileURL)
    }
}

/// "Send to Claude" on one comment: its whole thread goes into the composer.
struct PRSendCommentButton: View {
    @Environment(AppState.self) private var app
    @Environment(PRStore.self) private var prs
    let comment: PRComment

    var body: some View {
        if let pr = prs.selected {
            let blocker = PRClaudeRouting.blocker(headRef: pr.headRefName, store: app)
            Button("Send to Claude", systemImage: "paperplane") {
                guard let thread = PRClaude.thread(of: comment, in: prs.comments) else { return }
                PRClaudeRouting.send(threads: [thread], pr: pr, store: app)
            }
            .labelStyle(.titleAndIcon)
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(blocker != nil)
            .help(blocker ?? String(localized: "Puts this thread into Claude's message box in \(PRClaudeRouting.destination(headRef: pr.headRefName, store: app)) — you read it and send it"))
            .accessibilityIdentifier("Send comment to Claude")
        }
    }
}

/// The PR diff line's context-menu item: a side question on this line and its hunk (this window's read-only side session).
struct PRSideQuestionMenuItem: View {
    @Environment(AppState.self) private var app
    @Environment(PRStore.self) private var prs
    let line: DiffLine
    let path: String
    let diff: FileDiff

    var body: some View {
        if let pr = prs.selected, let anchor = PRClaude.anchor(number: pr.number, path: path, line: line, diff: diff, commitId: pr.headRefOid.isEmpty ? nil : pr.headRefOid) {
            Button("Ask in a side thread", systemImage: "bubble.left.and.text.bubble.right") {
                app.side.compose(anchor: SideAnchor(pr: anchor))
            }
            .disabled(app.projectInfo == nil || !app.side.isSupported)
            .help(app.projectInfo == nil ? EngineMessages.refusal(error: "no_project")
                  : String(localized: "Ask about this line in a side question — the hunk goes along as data; nothing changes"))
        }
    }
}
