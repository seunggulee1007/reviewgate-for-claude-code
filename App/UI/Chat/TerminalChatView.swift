import SwiftUI
import ReviewGateCore

// MARK: terminal-chat (§57.5)
/// The chat column of a terminal chat: the real Claude Code in a terminal under a thin strip — whether ReviewGate hears its
/// hooks, "Review now" when a turn Esc stopped stays open, Restart — and an overlay once Claude Code exited. A terminal
/// chat shown read-only (another chat is the live one) has no terminal: it offers to continue in it.
struct TerminalChatView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        column
            // MARK: terminal-stage2 (§57.14): Review › Request Changes (⌘⇧C) sends the notes here too — the engine stages
            // them for this turn's end or the next prompt; nothing is typed into the TUI.
            .onChange(of: model.requestChangesTick) { _, _ in
                if store.viewingChat == nil, !store.unsentNotes.isEmpty, store.canRequestChanges {
                    store.requestChanges(extraMessage: nil)
                } else {
                    model.terminals.focus(chatId: store.currentSessionId)
                }
            }
            // MARK: terminal-friction (§57.5): "Mention in Chat" from the file lists — `@path` pasted into the TUI, no Enter.
            .onChange(of: model.mentionTick) { _, _ in
                if let why = store.mentionInTerminal(model.mentionPaths) { Toast.show(why, systemImage: "exclamationmark.triangle.fill") }
            }
            // §58: "Accept N & Continue"'s summary sheet, when a pending file still needs a look.
            .sheet(isPresented: Binding(get: { model.showAcceptAllContinue }, set: { model.showAcceptAllContinue = $0 })) {
                AcceptAllSheet(continues: true)
            }
    }

    @ViewBuilder
    private var column: some View {
        let hub = model.terminals
        let live = store.currentSessionId
        if store.viewingChat != nil {
            ViewedTerminalChatPlaceholder()
        } else if let moved = store.currentChatMovedTo {
            MovedTerminalChatPlaceholder(moved: moved)   // §57.12: a record here; it goes on in that worktree
        } else if let moving = store.terminalInfo?.moving {
            MovingTerminalChat(place: moving)
        } else if let id = live, let host = hub.host(for: id) {
            VStack(spacing: 0) {
                TerminalStatusStrip(chatId: id, host: host)
                TerminalStage2Rows()
                TerminalPermissionCards()   // §57.15
                Divider()
                TerminalContainer(host: host)
                    .overlay { TerminalEndedOverlay(chatId: id, host: host) }
                    .accessibilityIdentifier("Terminal chat terminal")
            }
        } else if let id = live, let error = hub.specErrors[id] {
            TerminalStartProblem(chatId: id, message: error)
        } else {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Starting Claude Code…").font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Terminal chat starting")
        }
    }
}

/// The strip over the terminal: the hook link in a word, then "Review now" and Restart.
private struct TerminalStatusStrip: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let chatId: String
    let host: TerminalHost
    /// §57.5 (`TerminalReviewedHint`): the terminal chats that showed "변경은 왼쪽에 나와요" so far, and whether the user closed it.
    @AppStorage(TerminalReviewedHint.countKey) private var hintCount = 0
    @AppStorage(TerminalReviewedHint.dismissedKey) private var hintDismissed = false
    /// The chats that counted in this run: the words stay in them while they are on screen.
    @MainActor private static var hintChats: Set<String> = []

    var body: some View {
        let info = store.terminalInfo
        HStack(spacing: 8) {
            let (text, symbol, tint, help) = status(info)
            let reviewed = text == Self.reviewedText
            if reviewed, !TerminalReviewedHint.shows(count: hintCount, dismissed: hintDismissed, countedHere: Self.hintChats.contains(chatId)) {
                // Said often enough: the shield alone, the same tooltip.
                Image(systemName: symbol)
                    .font(.caption)
                    .foregroundStyle(tint)
                    .help(Text(verbatim: Self.reviewedText + "\n") + Text(verbatim: help))
                    .accessibilityLabel(Text("Reviewed by ReviewGate"))
                    .accessibilityIdentifier("Terminal chat status")
            } else {
                // §57.5: beside the review panel the strip is the terminal's width — the words that fit, the shortest cut.
                ViewThatFits(in: .horizontal) {
                    Label(text, systemImage: symbol)
                    if reviewed {
                        Label(String(localized: "Reviewed by ReviewGate"), systemImage: symbol)
                    }
                    if text == Self.trustText {
                        Label(String(localized: "Trust this folder? Choose Yes"), systemImage: symbol)
                    }
                }
                .font(.caption)
                .foregroundStyle(tint)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(help)
                .accessibilityIdentifier("Terminal chat status")
                if reviewed {
                    Button {
                        hintDismissed = true
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.icon)
                    .controlSize(.mini)
                    .help(String(localized: "Don't show this again — the shield stays, with this note in its tooltip"))
                    .accessibilityLabel(Text("Hide this hint"))
                    .accessibilityIdentifier("Terminal chat hint close")
                }
            }
            Spacer(minLength: 4)
            // MARK: terminal-friction (§57.4): ticks each second, so "Review now" shows 2 s after an Esc with no hook.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if showsReviewNow(info, now: context.date) {
                    Button("Review now") { Task { await store.endTerminalTurn() } }
                        .controlSize(.small)
                        .help(String(localized: "End this turn and review its changes now — after Esc Claude Code sends no end of turn, so the turn stays open until the next prompt"))
                        .accessibilityIdentifier("Terminal chat review now")
                }
            }
            if let rule = store.reviewFirst, rule.blocked > 0, !rule.allowedThisTurn, store.hasPendingReview { ReviewFirstChip() }   // §64
            TerminalAcceptContinueButton()   // MARK: terminal-friction (§58); continue-states (§58.1): the header's primary
            if let status = info?.status { TerminalCostButton(status: status) }   // MARK: terminal-stage2 (§57.13)
            Button {
                Task { await model.terminals.restart(chatId: chatId) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.icon)
            .controlSize(.small)
            .disabled(model.terminals.spawning.contains(chatId))
            .help(model.terminals.spawning.contains(chatId)
                  ? String(localized: "Claude Code is starting")
                  : String(localized: "Restart Claude Code in this terminal — the conversation is resumed; text typed and not sent is lost"))
            .accessibilityLabel(Text("Restart Claude Code"))
            .accessibilityIdentifier("Terminal chat restart")
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(host.disconnected ? Color.orange.opacity(0.12) : Color.clear)
        .onChange(of: "\(chatId)|\(status(info).0 == Self.reviewedText)", initial: true) { _, _ in countHint(info) }
    }

    /// §57.5: a terminal chat showing "변경은 왼쪽에 나와요" for the first time counts once (`TerminalReviewedHint`).
    private func countHint(_ info: TerminalSessionInfo?) {
        guard status(info).0 == Self.reviewedText,
              TerminalReviewedHint.counts(count: hintCount, dismissed: hintDismissed, countedHere: Self.hintChats.contains(chatId)) else { return }
        Self.hintChats.insert(chatId)
        hintCount += 1
    }

    /// "Review now": a tool call ended by Esc, Esc pressed here with no hook after it for 2 s, or the turn has run 60 s with
    /// nothing from Claude Code (`TerminalReviewNowRules`).
    private func showsReviewNow(_ info: TerminalSessionInfo?, now: Date) -> Bool {
        TerminalReviewNowRules.shows(turnRunning: store.isRunning, info: info, chatId: chatId, escape: model.terminals.escape,
                                     lastActivity: model.terminals.lastActivity, now: now)
    }

    private static var reviewedText: String { String(localized: "Reviewed by ReviewGate — changes show on the left") }
    /// MARK: terminal-default (§57.7): before the first hook — Claude Code's trust question defaults to "No, exit", and a
    /// folder it does not trust cannot be reviewed, so the strip says what to pick before the user presses Return.
    private static var trustText: String { String(localized: "If Claude Code asks whether to trust this folder, choose Yes") }

    private func status(_ info: TerminalSessionInfo?) -> (String, String, Color, String) {
        if host.disconnected, model.terminals.lostInBackground.contains(chatId) {
            // MARK: terminal-stage2 (§57.10): the engine dropped this chat's terminal while another chat was live.
            return (String(localized: "ReviewGate lost this terminal while it was in the background. Restart it"), "bolt.horizontal.circle",
                    .orange, String(localized: "While another chat was the live one, ReviewGate stopped reviewing this terminal, so Claude Code's prompts and edits are refused until you restart it (the conversation is resumed; text typed and not sent is lost)"))
        }
        if host.disconnected {
            return (String(localized: "ReviewGate restarted — this terminal is no longer reviewed. Restart it"), "bolt.horizontal.circle",
                    .orange, String(localized: "The engine that reviews this terminal restarted, so Claude Code's prompts and edits are refused until you restart the terminal (the conversation is resumed)"))
        }
        if let waiting = info?.waiting {
            let text = waiting.kind == .permission ? String(localized: "Claude Code waits for your permission in the terminal")
                                                   : String(localized: "Claude Code asked you a question in the terminal")
            return (text, "bell.badge", .orange, waiting.message)
        }
        if store.isRunning {
            return (String(localized: "Claude is working — the review opens when it stops"), "circle.dotted", .secondary,
                    String(localized: "ReviewGate takes a snapshot when you send a prompt and shows the turn's changes once Claude stops"))
        }
        if info?.hooksSeen == true {
            return (Self.reviewedText, "checkmark.shield", .secondary,
                    String(localized: "Claude Code reports each prompt and edit to ReviewGate; accept or reject the changes as in a chat"))
        }
        return (Self.trustText, "questionmark.folder", .accentColor,
                String(localized: "ReviewGate has heard nothing from Claude Code yet — it starts reviewing with your first prompt. The first time Claude Code runs in a folder it asks whether to trust it, and \"No, exit\" is selected: choose \"Yes, I trust this folder\" — on No, Claude Code exits and nothing can be reviewed."))
    }
}

/// §64: Claude Code's edits were denied while files wait — the chat's quiet row, as a chip; a click opens the review.
/// [이번 턴만 허용] next to it lets the running turn through (off with the reason between turns).
private struct ReviewFirstChip: View {
    @Environment(AppState.self) private var store

    var body: some View {
        HStack(spacing: 4) {
            Button {
                store.openReviewFirstWaiting()
            } label: {
                ViewThatFits(in: .horizontal) {
                    Text(verbatim: "\(ReviewFirstText.blockedText) · \(ReviewFirstText.openReviewTitle)")
                    Text(verbatim: ReviewFirstText.openReviewTitle)
                }
                .lineLimit(1)
            }
            .help(ReviewFirstText.blockedHelp(store.reviewFirst?.mode))
            .accessibilityLabel(Text(verbatim: ReviewFirstText.blockedText))
            .accessibilityIdentifier("Terminal review-first chip")
            let blocker = store.reviewFirstAllowTurnBlocker
            Button(ReviewFirstText.allowTurnTitle) { store.allowReviewFirstThisTurn() }
                .lineLimit(1)
                .disabled(blocker != nil)
                .help(blocker ?? ReviewFirstText.allowTurnHelp)
                .accessibilityIdentifier("Terminal review-first allow turn")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .tint(.orange)
    }
}

// MARK: terminal-friction (§58)

/// "Accept N & Continue" in a terminal chat: the pending files accepted, then "Continue." pasted into Claude Code and
/// Return pressed — the user's click (or ⌘⇧↩), never by itself. On only while Claude Code is idle at its prompt.
/// MARK: continue-states (§58.1): the Changes header's primary — accept all / the rest and continue, or "Continue" once every
/// file is decided; the change request stays in its notes row under the strip.
private struct TerminalAcceptContinueButton: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        if let primary = store.continuePrimary, primary != .requestChanges(notes: store.unsentNotes.count) {
            let blocker = store.continuePrimaryBlocker
            Button(ContinueText.title(primary)) { AcceptAllAction.runPrimary(store: store, model: model) }
                .controlSize(.small)
                .keyboardShortcut(.return, modifiers: [.command, .shift])
                .disabled(blocker != nil)
                .help(blocker ?? AcceptAllAction.primaryHelp(store: store))
                .accessibilityLabel(Text(verbatim: ContinueText.title(primary)))
                .accessibilityIdentifier("Terminal chat accept and continue")
        }
    }
}

/// Over the terminal once Claude Code exited (or could not start): why, and Restart.
private struct TerminalEndedOverlay: View {
    @Environment(WindowModel.self) private var model
    let chatId: String
    let host: TerminalHost

    var body: some View {
        switch host.state {
        case let .exited(code, quickNoHooks):
            panel(title: code.map { String(localized: "Claude Code exited (\(Int($0)))") } ?? String(localized: "Claude Code was stopped"),
                  hint: quickNoHooks ? String(localized: "If it asked whether to trust this folder, choose Yes after restarting — ReviewGate cannot review a folder Claude Code does not trust") : nil)
        case let .failed(message):
            panel(title: message, hint: nil)
        case .idle, .starting, .running:
            EmptyView()
        }
    }

    private func panel(title: String, hint: String?) -> some View {
        VStack(spacing: 10) {
            Label(title, systemImage: "terminal")
                .font(.headline)
                .accessibilityIdentifier("Terminal chat exited")
            if let hint {
                Text(hint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .accessibilityIdentifier("Terminal chat trust hint")
            }
            Button("Restart") { Task { await model.terminals.restart(chatId: chatId) } }
                .help(String(localized: "Start Claude Code again in this terminal — the conversation is resumed"))
                .accessibilityIdentifier("Terminal chat restart after exit")
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35))
    }
}

/// The engine refused to start the terminal (an old CLI, hooks turned off, no CLI): why, and Try Again.
private struct TerminalStartProblem: View {
    @Environment(WindowModel.self) private var model
    let chatId: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Label("Claude Code could not start here", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .frame(maxWidth: 420)
                .accessibilityIdentifier("Terminal chat start problem")
            Button("Try Again") { Task { await model.terminals.restart(chatId: chatId) } }
                .help(String(localized: "Ask ReviewGate's engine again how to start Claude Code for this chat"))
                .accessibilityIdentifier("Terminal chat try again")
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A terminal chat shown read-only: its terminal shows only while it is the live chat — kept running in the background
/// (§57.10) or started again when the user continues in it.
private struct ViewedTerminalChatPlaceholder: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        let id = store.viewingChat?.id
        let background = id.flatMap { model.terminals.host(for: $0) }.map { $0.state.isRunning } ?? false
        let waiting = background ? store.backgroundTerminal(chatId: id)?.waiting : nil
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Image(systemName: waiting != nil ? "bell.badge" : "terminal").font(.largeTitle)
                    .foregroundStyle(waiting != nil ? Color.orange : Color.secondary)
                Text("This chat runs Claude Code in a terminal")
                    .font(.headline)
                if let waiting {
                    // MARK: terminal-stage2 (§57.10): it waits in its TUI — the user answers there once it is the live chat.
                    Text(waiting.kind == .permission ? "Its Claude Code waits for your permission — continue in this chat to answer it in the terminal."
                                                     : "Its Claude Code asked you a question — continue in this chat to answer it in the terminal.")
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 380)
                        .accessibilityIdentifier("Viewed terminal chat waiting")
                } else if background {
                    Text("Its Claude Code keeps running in the background — continue in this chat to type in it. What you typed and did not send is still there.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 380)
                        .accessibilityIdentifier("Viewed terminal chat background")
                } else {
                    Text("Its terminal runs while it is the live chat. Continue in it to start Claude Code again — the conversation is resumed.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 380)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Viewed terminal chat")
            Divider()
            ViewingChatBar()
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
    }
}

// MARK: terminal-stage2 (§57.12–57.14)

/// §57.13: the TUI's status line as ReviewGate hears it (the statusLine tee): Claude Code's cost so far in this
/// conversation and the context used; a click shows the model, the numbers and ReviewGate's own session cost.
private struct TerminalCostButton: View {
    @Environment(AppState.self) private var store
    let status: TerminalStatus
    @State private var open = false

    var body: some View {
        if status.costUsd != nil || status.contextPercent != nil {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    if let cost = status.costUsd { Text(verbatim: HUDStrip.usd(cost)) }
                    if let percent = status.contextPercent { Text(verbatim: "\(percent)%") }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help(String(localized: "Claude Code's cost so far in this conversation and how much of its context is used, from its status line — click for details"))
            .accessibilityLabel(Text(verbatim: accessibilityText))
            .accessibilityIdentifier("Terminal chat cost")
            .popover(isPresented: $open, arrowEdge: .bottom) { details }
        }
    }

    private var accessibilityText: String {
        var parts: [String] = []
        if let cost = status.costUsd { parts.append(String(localized: "Cost so far \(HUDStrip.usd(cost))")) }
        if let percent = status.contextPercent { parts.append(String(localized: "\(percent) percent of the context used")) }
        return parts.joined(separator: ", ")
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Claude Code's status line").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                if let model = status.modelName ?? status.model {
                    GridRow { Text("Model").foregroundStyle(.secondary); Text(verbatim: model) }
                }
                if let cost = status.costUsd {
                    GridRow {
                        Text("This conversation").foregroundStyle(.secondary)
                        Text(verbatim: String(format: "$%.4f", cost)).monospacedDigit()
                    }
                }
                if let used = status.contextTokens, let window = status.contextWindow {
                    GridRow {
                        Text("Context").foregroundStyle(.secondary)
                        Text("\(used.formatted()) of \(window.formatted()) tokens").monospacedDigit()
                    }
                }
                GridRow {
                    Text("Reviewed turns").foregroundStyle(.secondary)
                    Text(verbatim: String(format: "$%.4f", store.hud.sessionCostUSD)).monospacedDigit()
                }
            }
            .font(.callout)
            Text("Claude Code's own estimates, not a bill. Reviewed turns: what the turns ReviewGate reviewed in this chat cost.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 300, alignment: .leading)
        }
        .padding(14)
        .accessibilityIdentifier("Terminal chat cost details")
    }
}

/// Rows under the strip: a move's notice, a queued Request changes (§57.14) or unsent notes, another worktree Claude Code
/// works in (§57.12), and a chat that just moved here.
private struct TerminalStage2Rows: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let info = store.terminalInfo
        VStack(spacing: 0) {
            ChatMoveBar()   // §39.4: why the last move was refused
            if let queued = info?.requestQueued {
                queuedRow(queued)
            } else if !store.unsentNotes.isEmpty, store.canRequestChanges {
                notesRow(count: store.unsentNotes.count)
            }
            if let elsewhere = info?.elsewhere { elsewhereRow(elsewhere) }
            if let from = movedFrom, info?.hooksSeen != true {
                row(icon: "arrow.down.right.square", tint: .blue,
                    text: String(localized: "Moved here from \(from.name) — continue typing in the terminal"), id: "Terminal chat moved in") {}
                    .help(SessionNotices.abbreviatingHome(from.path))
            }
        }
    }

    private var movedFrom: ChatMoveRef? {
        store.sessions.first { $0.id == store.currentSessionId }?.movedFrom
    }

    private func queuedRow(_ queued: TerminalRequestQueued) -> some View {
        let text = queued.via == .stop
            ? String(localized: "Changes requested — they reach Claude before this turn ends")
            : String(localized: "Changes requested — they go to Claude with your next prompt")
        return row(icon: "exclamationmark.bubble", tint: .orange, text: text, id: "Terminal chat request queued") {
            if queued.via == .nextPrompt {
                Button("Paste a Prompt") {
                    if let why = store.pasteRequestChangesPrompt() { Toast.show(why, systemImage: "exclamationmark.triangle.fill") }
                    else { Toast.show(NewChatKindText.pasted, systemImage: "doc.on.clipboard") }
                }
                .controlSize(.small)
                .help(String(localized: "Puts “\(TerminalStage2Text.requestChangesPrompt)” into Claude Code's prompt — press Return there to send it, or type your own prompt"))
                .accessibilityIdentifier("Terminal chat request paste")
            }
            Button("Cancel") { store.terminalRequestCancel() }
                .controlSize(.small)
                .help(String(localized: "Take the request back — the review notes stay unsent"))
                .accessibilityIdentifier("Terminal chat request cancel")
        }
    }

    private func notesRow(count: Int) -> some View {
        row(icon: "text.bubble", tint: .accentColor, text: String(localized: "\(count) review note(s) not sent to Claude yet"),
            id: "Terminal chat unsent notes") {
            Button("Request changes (\(count))") { store.requestChanges(extraMessage: nil) }
                .controlSize(.small)
                .help(String(localized: "Send the review notes to Claude (⌘⇧C) — while it works they reach it before the turn ends, else with your next prompt; nothing is typed into the terminal"))
                .accessibilityIdentifier("Terminal chat request changes")
        }
    }

    private func elsewhereRow(_ elsewhere: TerminalElsewhere) -> some View {
        let text = elsewhere.toolName == "CwdChanged"
            ? String(localized: "Claude Code changed into \(elsewhere.name), another worktree of this repository — its changes there are not reviewed here")
            : String(localized: "Claude Code works in \(elsewhere.name), another worktree of this repository — its changes there are not reviewed here")
        let blocker = elsewhere.canMove ? store.chatMoveBlocker : String(localized: "That folder cannot take this chat")
        return row(icon: "arrow.triangle.branch", tint: .blue, text: text, id: "Terminal chat elsewhere") {
            Button(String(localized: "Move This Chat to \(elsewhere.name)")) { ChatMoveActions.move(store: store, to: elsewhere.path) }
                .controlSize(.small)
                .disabled(blocker != nil)
                .help(blocker ?? String(localized: "This chat continues in that worktree's window and its changes there are reviewed — Claude Code restarts there and resumes the conversation"))
                .accessibilityIdentifier("Terminal chat move")
        }
    }

    private func row(icon: String, tint: Color, text: String, id: String, @ViewBuilder actions: () -> some View) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
            Text(verbatim: text)
                .font(.caption)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("\(id) text")
            Spacer(minLength: 4)
            actions()
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(tint.wash(colorScheme, light: 0.08, dark: 0.16))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

/// §57.12: the chat is moving to another worktree — its Claude Code stops here, the review of this folder stays.
private struct MovingTerminalChat: View {
    let place: TerminalPlace

    var body: some View {
        VStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Moving this chat to \(place.name)…").font(.headline)
            Text("Claude Code stops here and continues in that worktree's window; the review of this folder stays here.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Terminal chat moving")
    }
}

/// §57.12: a terminal chat that moved to another worktree is a record here — no terminal; it goes on in that window.
private struct MovedTerminalChatPlaceholder: View {
    @Environment(\.openWindow) private var openWindow
    let moved: ChatMoveRef

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.right.square").font(.largeTitle).foregroundStyle(.blue).accessibilityHidden(true)
            Text(verbatim: ChatMoveText.movedBanner(name: moved.name))
                .font(.headline)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Text("Its Claude Code runs in that window's terminal now.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button(ChatMoveText.openThatWindow) {
                ProjectOpener.openInNewWindow(URL(fileURLWithPath: moved.path), openWindow: openWindow)
            }
            .help(SessionNotices.abbreviatingHome(moved.path))
            .accessibilityIdentifier("Open moved chat window")
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Moved terminal chat")
    }
}

// MARK: terminal-stage2 (§57.15)

/// Claude Code's permission dialogs the app may answer, over the terminal: the tool, what it would do, ReviewGate's own
/// reason when it asked first, and Allow / Deny (and Allow and Follow for EnterWorktree). The TUI's dialog stays live —
/// whichever is answered first wins; "always allow" stays in the terminal.
private struct TerminalPermissionCards: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let permissions = store.terminalPermissions
        if !permissions.isEmpty {
            VStack(spacing: 6) {
                ForEach(permissions) { card($0) }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.16))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Terminal chat permissions")
        }
    }

    private func card(_ permission: TerminalPermission) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange).accessibilityHidden(true)
                Text("Claude Code asks to use \(permission.toolName)")
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 4)
                Text("Or answer in the terminal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help(String(localized: "The terminal's own dialog is still open — whichever you answer first counts. “Always allow” is only in the terminal."))
            }
            if !permission.summary.isEmpty {
                Text(verbatim: permission.summary)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(3)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(permission.summary)
                    .accessibilityIdentifier("Terminal permission summary")
            }
            if let reason = permission.reason {
                Label(reason, systemImage: "exclamationmark.shield")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Terminal permission reason")
            }
            HStack(spacing: 8) {
                Spacer()
                Button("Deny") { store.terminalPermissionResponse(requestId: permission.requestId, allow: false) }
                    .controlSize(.small)
                    .help(String(localized: "Refuse it — Claude Code is told you denied it in ReviewGate and goes on without it"))
                    .accessibilityIdentifier("Terminal permission deny")
                if permission.canFollow {
                    Button(ChatMoveText.allowAndFollowTitle) {
                        store.terminalPermissionResponse(requestId: permission.requestId, allow: true, follow: true)
                    }
                    .controlSize(.small)
                    .help(String(localized: "Allow it; once Claude Code is in the new worktree, this chat moves to that worktree's window and is reviewed there"))
                    .accessibilityIdentifier("Terminal permission allow and follow")
                }
                Button("Allow once") { store.terminalPermissionResponse(requestId: permission.requestId, allow: true) }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .help(String(localized: "Allow this one call — to always allow it, answer in the terminal instead"))
                    .accessibilityIdentifier("Terminal permission allow")
            }
        }
        .padding(8)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Permission request from Claude Code: \(permission.toolName)"))
        .accessibilityIdentifier("Terminal permission \(permission.requestId)")
    }
}
