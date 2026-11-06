import SwiftUI
import ReviewGateCore

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the transcript's rows as views SwiftUI can skip. A row gets values (its item,
// what was looked up for it) and compares them (`Equatable`), so a new row, a decision or a finished answer redraws that
// row only; actions go through `ChatActions` (one object for the chat) instead of closures made per draw; the find
// outline, the flash and the folds come from `TranscriptViewState`; the streaming answer reads `AppState.liveText` itself.

/// What the rows do: one object per chat, so no row is redrawn because a closure was made anew.
@MainActor
final class ChatActions {
    private weak var store: AppState?
    private weak var window: WindowModel?
    private weak var composer: ComposerModel?
    private weak var transcript: TranscriptViewState?
    private var openWindow: OpenWindowAction?

    func attach(store: AppState, window: WindowModel, composer: ComposerModel, transcript: TranscriptViewState, openWindow: OpenWindowAction) {
        self.store = store
        self.window = window
        self.composer = composer
        self.transcript = transcript
        self.openWindow = openWindow
    }

    func openDiff(_ file: ChangedFile) {
        store?.selectFile(path: file.path)
    }

    /// §36.3: opens and shows the group of the agent a SendMessage continues.
    func revealAgentGroup(_ toolUseId: String) {
        transcript?.groupExpansion[toolUseId] = true
        window?.reveal(toolUseId: toolUseId)
    }

    func focusComposer() {
        composer?.inputFocused = true
    }

    func openWorkbench(_ path: String) {
        guard let openWindow else { return }
        ProjectOpener.openInNewWindow(URL(fileURLWithPath: path), openWindow: openWindow)
    }
}

extension EnvironmentValues {
    @Entry var chatActions: ChatActions? = nil
}

/// The review's files as the rows look them up (rebuilt when the changed files change).
@MainActor
final class TranscriptLinks {
    let files: [ChangedFile]
    let byToolUse: [String: [ChangedFile]]
    let changedPaths: [String]

    init(files: [ChangedFile]) {
        self.files = files
        byToolUse = ChangeLinks.filesByToolUse(files)
        changedPaths = files.map(\.path)
    }

    func linkedFiles(toolUseId: String, name: String, file: String?, root: String?) -> [ChangedFile] {
        if let linked = byToolUse[toolUseId] { return linked }
        guard ToolCallRecord.editTools.contains(name),
              let target = ChangeLinks.targetFile(toolUseId: toolUseId, file: file, files: files, root: root, byToolUse: byToolUse)
        else { return [] }
        return [target]
    }
}

/// Everything a row's look-ups come from, as one value: the shown chat's lookups and the review's links (by identity),
/// the project root, and the few flags every row shares.
struct TranscriptRowContext: Equatable {
    let lookups: TranscriptLookups
    let links: TranscriptLinks
    var root: String?
    var rootURL: URL?
    /// The session is running (a saved chat runs nothing).
    var running: Bool
    /// §39.2: the rows are another chat's (saved, read-only).
    var viewing: Bool
    /// §43.5: the newest turn summary row (the one with the "plan vs actual" basis menu).
    var latestSummaryId: UUID?
    /// MARK: wave7 w7-chat — §45.1: the model's build (`TranscriptModel.rebuilds`). A rebuild (rows put in front, replaced or
    /// removed) can change a row's facts (its result's call, its answer's turn), so every row works them out again; an
    /// appended row changes no other row's.
    var rebuilds: Int

    static func == (a: Self, b: Self) -> Bool {
        a.lookups === b.lookups && a.rebuilds == b.rebuilds && a.links === b.links && a.root == b.root && a.rootURL == b.rootURL
            && a.running == b.running && a.viewing == b.viewing && a.latestSummaryId == b.latestSummaryId
    }

    /// §21: the transcript rows that offer "Why?".
    static func asksWhy(_ tool: String) -> Bool { ToolCallRecord.editTools.contains(tool) || tool == "Bash" }

    /// What `item`'s row shows besides the item.
    @MainActor
    func facts(for item: ChatItem) -> RowFacts {
        var facts = RowFacts(root: root, rootURL: rootURL, viewing: viewing)
        switch item {
        case let .toolUse(_, toolUseId, name, file, _, _):
            facts.linked = links.linkedFiles(toolUseId: toolUseId, name: name, file: file, root: root)
            // wave4b w4b-tabs: a saved chat's call is not the running session's to ask about
            if Self.asksWhy(name), !viewing {
                facts.sideAnchor = SideAnchors.toolAnchor(toolUseId: toolUseId, file: file, root: root, changedPaths: links.changedPaths)
            }
        case let .toolResult(_, toolUseId, _, _, _):
            facts.toolName = lookups.model.index.calls[toolUseId]?.name
        case let .assistant(id, _, _, _):
            facts.answerTurn = lookups.model.answerTurns[id]
        case let .turnSummary(id, _):
            facts.latestSummary = latestSummaryId == id
        default:
            break
        }
        return facts
    }
}

/// What a row shows besides its item, looked up where the row is made.
struct RowFacts: Equatable {
    var root: String?
    var rootURL: URL?
    var viewing = false
    /// Changed files in the current review the call touched (edit target or Bash snapshot).
    var linked: [ChangedFile] = []
    var sideAnchor: SideAnchor?
    /// A result's call.
    var toolName: String?
    /// An answer's turn (its "ask about this answer" quote).
    var answerTurn: Int?
    var latestSummary = false
}

/// ⌘F on a row that draws the matched words itself.
struct RowMatch: Equatable {
    var query: String
    var isCurrent: Bool
}

// MARK: - Entries and nodes

/// One top-level entry: a node, or a folded run of exploration calls (§39.2).
struct TranscriptEntryView: View, Equatable {
    let entry: ExploreFold.Entry
    let context: TranscriptRowContext
    let restored: Bool

    nonisolated static func == (a: Self, b: Self) -> Bool { a.entry == b.entry && a.context == b.context && a.restored == b.restored }

    var body: some View {
        switch entry {
        case let .node(node):
            TranscriptNodeView(node: node, context: context).equatable()
                .opacity(restored ? 0.6 : 1)
                .accessibilityElement(children: .contain)   // the row id must not override the children's
                .accessibilityIdentifier(restored ? "Restored transcript row" : "Transcript row")
        case let .run(run):
            ExploreRunEntryView(run: run, context: context).equatable()
                .opacity(restored ? 0.6 : 1)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(restored ? "Restored transcript row" : "Transcript row")
        }
    }
}

/// A row, or an agent group with its subagent's rows.
struct TranscriptNodeView: View, Equatable {
    let node: TranscriptNode
    let context: TranscriptRowContext

    nonisolated static func == (a: Self, b: Self) -> Bool { a.node == b.node && a.context == b.context }

    var body: some View {
        switch node {
        case let .row(item):
            TranscriptLeafRow(item: item, facts: context.facts(for: item)).equatable()
        case let .agentGroup(call, toolUseId, children, result):
            AgentGroupNodeView(call: call, toolUseId: toolUseId, children: children, result: result, callCount: node.callCount,
                               context: context).equatable()
        }
    }
}

/// §39.2 (market-12): a run of reads / searches as one "탐색: …" row; it opens when the user opened it, or when it holds
/// the current find match or the revealed call.
struct ExploreRunEntryView: View, Equatable {
    @Environment(TranscriptViewState.self) private var view
    let run: ExploreRun
    let context: TranscriptRowContext

    nonisolated static func == (a: Self, b: Self) -> Bool { a.run == b.run && a.context == b.context }

    var body: some View {
        let expanded = Binding(get: { view.exploreExpansion[run.id] ?? (run.contains(row: view.currentMatch) || run.contains(toolUseId: view.flashToolUseId)) },
                               set: { view.exploreExpansion[run.id] = $0 })
        ExploreRunRow(run: run, running: context.running, expanded: expanded) {
            ForEach(run.nodes) { node in TranscriptNodeView(node: node, context: context).equatable() }
        }
    }
}

/// A row with its find outline and its scroll id; the find state and the flash are read here.
struct TranscriptLeafRow: View, Equatable {
    @Environment(TranscriptViewState.self) private var view
    let item: ChatItem
    let facts: RowFacts

    nonisolated static func == (a: Self, b: Self) -> Bool { a.item == b.item && a.facts == b.facts }

    var body: some View {
        let isMatch = view.isMatch(item.id)
        let isCurrent = view.currentMatch == item.id
        TranscriptRowView(item: item, facts: facts,
                          match: isMatch && Self.drawsMatch(item) ? RowMatch(query: view.findQuery, isCurrent: isCurrent) : nil,
                          flashing: flashing,
                          revealMatch: isCurrent)
            .equatable()
            .modifier(MatchHighlight(isMatch: isMatch, isCurrent: isCurrent))
            .id(item.id)
    }

    /// Rows that mark the matched words in their own text.
    private static func drawsMatch(_ item: ChatItem) -> Bool {
        switch item {
        case .user, .assistant, .error: true
        default: false
        }
    }

    private var flashing: Bool {
        switch item {
        case let .toolUse(_, toolUseId, _, _, _, _): view.flashToolUseId == toolUseId
        case let .permission(_, request, _): view.flashPermissionId == request.requestId
        default: false
        }
    }
}

// MARK: - Rows

/// One transcript row by kind (the former `ChatView.row`).
struct TranscriptRowView: View, Equatable {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.chatActions) private var actions
    let item: ChatItem
    let facts: RowFacts
    let match: RowMatch?
    let flashing: Bool
    /// ⌘F: the current match is in this row (a tool result opens).
    let revealMatch: Bool

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.item == b.item && a.facts == b.facts && a.match == b.match && a.flashing == b.flashing && a.revealMatch == b.revealMatch
    }

    var body: some View {
        switch item {
        case let .user(_, text, meta):
            UserMessageRow(text: text, meta: meta,
                           highlighted: match.map { highlighted(text, query: $0.query, isCurrent: $0.isCurrent) })
        case let .assistant(id, text, streaming, unprompted):
            AssistantMessageRow(id: id, text: text, streaming: streaming, unprompted: unprompted, match: match, turn: facts.answerTurn)
        case let .toolUse(_, _, "SendMessage", _, input, info) where info.continues != nil:
            // wave3 mac-agents (§36.3): "executor에게 이어서: …" — the agent's new calls go into its original group.
            if let continues = info.continues {
                AgentContinuationRow(continues: continues, input: input) { actions?.revealAgentGroup(continues.agentToolUseId) }
            }
        case let .toolUse(rowID, toolUseId, name, file, input, info):
            ToolUseRow(rowID: rowID, name: name, file: file, input: input, info: info, root: facts.rootURL,
                       linkedFiles: facts.linked,
                       flashing: flashing,
                       sideAnchor: facts.sideAnchor,
                       // §52: a main-thread Bash call that still runs can go on in the background (⌃B).
                       backgroundToolUseId: name == "Bash" && info.parentToolUseId == nil && !facts.viewing ? toolUseId : nil,
                       onOpenFile: { actions?.openDiff($0) })
        case let .toolResult(rowID, toolUseId, isError, preview, info):
            ToolResultRow(rowID: rowID, toolUseId: toolUseId, toolName: facts.toolName,
                          isError: isError, preview: preview, info: info, revealMatch: revealMatch)
        case let .permission(_, request, allowed):
            PermissionTranscriptRow(request: request, allowed: allowed, flashing: flashing, viewing: facts.viewing, projectRoot: facts.root)
        case let .budgetEvent(_, kind, toolName, file, files, lines, budget):
            let counts = String(localized: "\(files)/\(budget.maxFiles) files · \(lines)/\(budget.maxLines) lines")
            let target = "\(toolName)\(file.map { " " + TouchedFile(path: $0, tools: [], count: 0).relativePath(to: facts.rootURL) } ?? "")"
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind == .deny
                         ? String(localized: "Change limit exceeded — edit denied (\(counts)). Claude was told to stop and report.")
                         : String(localized: "Change limit reached: \(counts)"))
                        .fontWeight(.semibold)
                    Text(target).font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: kind == .deny ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
            }
            .font(.callout)
            .foregroundStyle(kind == .deny ? Color.red : Color.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background((kind == .deny ? Color.red : Color.orange).wash(colorScheme, light: 0.12, dark: 0.20), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier(kind == .deny ? "Budget deny" : "Budget warn")
        case let .error(_, message, fatal, info):
            ErrorTranscriptRow(message: message, fatal: fatal, info: info,
                               highlighted: match.map { highlighted(message, query: $0.query, isCurrent: $0.isCurrent) },
                               actionable: !facts.viewing)   // r1-scope (§33.4): another chat's rows act on nothing
        case let .turnEnd(_, summary):
            HStack {
                Rectangle().fill(.quaternary).frame(height: 1)
                Text(summary).font(.caption).foregroundStyle(.secondary).fixedSize()
                Rectangle().fill(.quaternary).frame(height: 1)
            }
        case let .plan(rowID, path, plan, approvedMode):
            PlanTranscriptRow(rowID: rowID, path: path, plan: plan, approvedMode: approvedMode)
        case let .turnSummary(rowID, summary):
            // wave5 w5-fixes (§43.5): the newest summary of the live chat carries the "plan vs actual" basis menu
            TurnSummaryCard(rowID: rowID, summary: summary, showsBasis: !facts.viewing && facts.latestSummary, askable: !facts.viewing)
        case let .peerMessage(_, message):
            PeerMessageRow(message: message)
        case let .autoTurn(_, _, info):   // §52.1
            AutoTurnRow(info: info)
        }
    }
}

/// Claude's text. M16: markdown once the message is complete; plain text while streaming keeps deltas cheap.
/// §18: text of a turn Claude Code ran by itself — muted, outlined, with a badge.
/// The whole answer copies as its markdown from the hover button beside it and the right-click menu (also over the text).
private struct AssistantMessageRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let id: UUID
    let text: String
    let streaming: Bool
    let unprompted: Bool
    let match: RowMatch?
    let turn: Int?
    @State private var hovering = false
    @State private var copied = false

    private var copyable: Bool { !streaming && !text.isEmpty }

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                if unprompted {
                    Text("Ran without a request")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .help(Text("Claude Code ran this turn on its own, without a request; changes it tried were blocked."))
                        .accessibilityIdentifier("Unprompted badge")
                }
                Group {
                    if streaming {
                        StreamingAnswerText(id: id, text: text, match: match)
                    } else {
                        MarkdownText(text: text, secondary: unprompted)
                            .environment(\.proseMenuItems, proseMenuItems)
                    }
                }
                .foregroundStyle(unprompted ? .secondary : .primary)
            }
            .padding(10)
            .background(unprompted ? Color.clear : Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                if unprompted {
                    RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                }
            }
            // Beside the bubble's top corner, over the row's trailing space (an overlay: the bubble keeps its width).
            .overlay(alignment: .topTrailing) {
                if copyable, hovering || copied { copyButton.offset(x: 30) }
            }
            // MARK: wave4b w4b-side — §40.3 (SME-12): right-click → 곁질문으로 묻기 (the answer quoted, with its turn)
            .contextMenu {
                if copyable {
                    Button("Copy message", systemImage: "doc.on.doc") { copy() }
                    AskQuoteMenuItem(text: text, turn: turn)
                }
            }
            Spacer(minLength: 40)
        }
        // The whole row is the hover region: the button sits beyond the bubble in the Spacer, which is not hit-testable, so
        // the pointer leaving the bubble ended the hover (and removed the button) before it reached it.
        .contentShape(Rectangle())
        .onHover { inside in if hovering != inside { hovering = inside } }
    }

    private var copyButton: some View {
        Button { copy() } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11, weight: .medium)).frame(width: 22, height: 20)
        }
        .buttonStyle(.borderless)
        .padding(2)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
        .help("Copy message")
        .accessibilityLabel("Copy message")
        .accessibilityIdentifier("Copy answer")
    }

    /// The right-click menu over the answer's text (an AppKit text view: the menu above does not open over it).
    private var proseMenuItems: [ProseMenuItem] {
        guard copyable else { return [] }
        // As `AskQuoteMenuItem`: off while another chat is shown (side questions go to the running one).
        let ask = ProseMenuItem(title: String(localized: "Ask about this answer in a side question"),
                                isEnabled: { [store] in store.viewedChat == nil }) { [store, text, turn] in
            guard let anchor = SideTrust.quoteAnchor(text, turn: turn) else { return }
            store.side.compose(anchor: anchor)
        }
        return [ProseMenuItem(title: String(localized: "Copy message")) { copy() }, ask]
    }

    /// The answer's markdown, as Claude wrote it.
    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

/// The answer while it streams: plain text (no attributed string built per delta). The streaming row's text comes from
/// `AppState.liveText` — only this view redraws per burst of deltas; a row that stopped streaming in place shows its own.
private struct StreamingAnswerText: View {
    @Environment(AppState.self) private var store
    let id: UUID
    let text: String
    let match: RowMatch?

    var body: some View {
        let live = store.liveText
        let shown = live.isLive(id) ? live.text : text
        Group {
            if let match {
                Text(highlighted(shown, query: match.query, isCurrent: match.isCurrent))
            } else if shown.isEmpty {
                Text(verbatim: "…")
            } else {
                // One text per paragraph: a burst changes the last one only, the others keep their layout. One text of
                // the whole answer was typeset again per burst — a 20 KB answer kept the main thread busy while it streamed.
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(Self.paragraphs(shown).enumerated()), id: \.offset) { _, paragraph in
                        Text(verbatim: String(paragraph))
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    /// The text cut at blank lines (empty paragraphs dropped; a lone one keeps the text).
    static func paragraphs(_ text: String) -> [Substring] {
        let parts = text.split(separator: "\n\n", omittingEmptySubsequences: true)
        return parts.isEmpty ? [text[...]] : parts
    }
}

/// r1-composer M08: Claude's question in the transcript, one line — while its card waits above the composer ("answer it
/// below"), and once answered, skipped or handled (the questions and their answers; all of them in the tooltip).
private struct QuestionLineRow: View {
    let questions: AskUserQuestions
    let decision: Bool?
    let isOpen: Bool

    var body: some View {
        let waiting = decision == nil && isOpen
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: waiting ? "questionmark.bubble.fill" : "questionmark.bubble")
                .foregroundStyle(waiting ? Color.accentColor : Color.secondary)
            Text(verbatim: line(waiting: waiting))
                .foregroundStyle(waiting ? Color.primary : Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(Text(verbatim: full))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(waiting ? "Question line waiting" : "Question line")
    }

    private var asked: String { questions.questions.map(\.question).joined(separator: " · ") }

    private func line(waiting: Bool) -> String {
        if waiting { return String(localized: "Claude asked: \(asked) — answer it below") }
        switch decision {
        case true?: return String(localized: "Answered: \(pairs)")
        case false?: return String(localized: "Skipped: \(asked)")
        case nil: return String(localized: "Handled: \(asked)")
        }
    }

    /// "question → answer" per question.
    private var pairs: String {
        questions.questions.map { "\($0.question) → \(questions.answers[$0.question] ?? "—")" }.joined(separator: " · ")
    }

    private var full: String { questions.questions.map { "\($0.question)\n→ \(questions.answers[$0.question] ?? "—")" }.joined(separator: "\n\n") }
}

/// §33.1 (wave1 mac-perms): every card answers its own request; buttons only while it is still queued.
private struct PermissionTranscriptRow: View {
    @Environment(AppState.self) private var store
    @Environment(\.chatActions) private var actions
    @Environment(TranscriptViewState.self) private var view
    let request: PermissionRequest
    let allowed: Bool?
    let flashing: Bool
    let viewing: Bool
    let projectRoot: String?

    var body: some View {
        let id = request.requestId
        if let questions = AskUserQuestions(request: request) {
            let isOpen = store.isPermissionOpen(id)
            if allowed != nil || !isOpen || store.openQuestion?.requestId == id {
                // r1-composer M08: the card the message box answers sits above the composer, and an answered one is a line.
                QuestionLineRow(questions: questions, decision: allowed, isOpen: isOpen)
            } else {
                // Open while another card or an older question comes first: the card itself, as before.
                QuestionCard(
                    questions: questions,
                    decision: allowed,
                    requestId: id,
                    isOpen: isOpen,
                    onAnswer: { store.answerQuestions(requestId: id, answers: $0); view.questionDrafts[id] = nil },
                    onSkip: { store.skipQuestions(requestId: id); view.questionDrafts[id] = nil },
                    onFocusComposer: { actions?.focusComposer() },
                    draft: Binding(get: { view.questionDrafts[id] ?? QuestionDraft() }, set: { view.questionDrafts[id] = $0 }))
            }
        } else {
            PermissionCard(
                request: request,
                decision: allowed,
                isOpen: store.isPermissionOpen(id),
                isShortcutTarget: store.shortcutPermission?.requestId == id,
                openCount: store.openPermissions.count,
                projectRoot: projectRoot,
                peerBadge: store.isPermissionOpen(id) ? store.peerTurnBadge : nil,   // the running peer turn's cards only
                workbenchPath: store.workbench(forPath: request.reason?.path)?.path,
                flashing: flashing,
                onAllow: { store.respondPermission(requestId: id, allow: true) },
                onAllowForSession: { store.respondPermission(requestId: id, allow: true, remember: true) },
                onAlwaysAllow: { pattern in store.alwaysAllowInProject(requestId: id, pattern: pattern) },
                onDeny: { instruction in
                    store.respondPermission(requestId: id, allow: false, message: instruction ?? String(localized: "Denied by user"))
                },
                onAskWhy: store.side.isSupported && !viewing ? {   // wave4b w4b-tabs: not a saved chat's card
                    let anchor = SideAnchors.toolUseId(for: request, in: store.transcript).map { SideAnchor(toolUseId: $0) }
                    store.side.askNow(anchor: anchor, question: SideQuestionText.permissionQuestion(request))
                } : nil,
                onOpenWorkbench: { path in actions?.openWorkbench(path) },
                onFocusComposer: { actions?.focusComposer() },
                onAllowAndFollow: store.canFollow(request) ? { store.allowAndFollow(requestId: id) } : nil,   // wave4b w4b-follow
                instruction: Binding(get: { view.denyInstructions[id] ?? "" },
                                     set: { view.denyInstructions[id] = $0.isEmpty ? nil : $0 }))
        }
    }
}

/// An Agent / Task call with its subagent's rows (expanded while it runs, the user can override either way) and its report.
/// MARK: wave7 w7-chat — §45.1: the rows of an open group are drawn as they scroll into view (`AgentGroupRow`'s lazy stack).
private struct AgentGroupNodeView: View, Equatable {
    @Environment(AppState.self) private var store
    @Environment(TranscriptViewState.self) private var view
    let call: ChatItem
    let toolUseId: String
    let children: [TranscriptNode]
    let result: ChatItem?
    let callCount: Int
    let context: TranscriptRowContext

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.call == b.call && a.toolUseId == b.toolUseId && a.children == b.children && a.result == b.result && a.callCount == b.callCount
            && a.context == b.context
    }

    var body: some View {
        if case let .toolUse(_, _, _, _, input, _) = call {
            let agent = store.agents.last { $0.toolUseId == toolUseId }
            // §52.2: "launched in the background" is no result — the agent's own comes when it ends.
            let result: ChatItem? = if case let .toolResult(_, _, _, _, info)? = self.result, info.agentLaunched { nil } else { self.result }
            let resultInfo: ToolResultInfo? = if case let .toolResult(_, _, _, _, info)? = result { info } else { nil }
            let status: AgentStatus = if case let .toolResult(_, _, isError, _, info)? = result {
                AgentRowStatus.resolve(node: agent, result: (isError, info), running: context.running)
            } else {
                AgentRowStatus.resolve(node: agent, result: nil, running: context.running)
            }
            let expanded = Binding(get: { view.groupExpansion[toolUseId] ?? status.isLive },
                                   set: { view.groupExpansion[toolUseId] = $0 })
            // MARK: wave4b w4b-agents — the report's start (not an error / stop text) for the collapsed head.
            let resultText: String? = if case let .toolResult(_, _, false, preview, _)? = result { preview } else { nil }
            let stoppedByUser = AgentRowStatus.stoppedByUser(node: agent, resultInfo: resultInfo)
            AgentGroupRow(input: input, status: status, callCount: callCount,
                          isBackground: agent?.isBackground ?? (input["run_in_background"] == .bool(true)),
                          expanded: expanded, flashing: view.flashToolUseId == toolUseId,
                          eager: view.eagerGroups.contains(toolUseId),
                          toolUseId: toolUseId, node: agent,   // wave3 mac-agents
                          stoppedByUser: stoppedByUser,
                          // MARK: wave4b w4b-agents — agents-08: "✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2" + the report's first line
                          collapsedStats: (expanded.wrappedValue || status.isLive) ? nil
                              : AgentGlance.finishedLine(status: status, tokens: agent?.tokens ?? resultInfo?.agentUsage?.tokens,
                                                         durationMs: agent?.durationMs ?? resultInfo?.agentUsage?.durationMs,
                                                         files: (agent?.files.count).flatMap { $0 > 0 ? $0 : nil }
                                                             ?? context.lookups.groupFiles(under: toolUseId).count,
                                                         stoppedByUser: stoppedByUser),
                          collapsedConclusion: expanded.wrappedValue ? nil
                              : result.flatMap { context.lookups.conclusion(row: $0.id, text: resultText) }) {
                ForEach(children) { child in TranscriptNodeView(node: child, context: context).equatable() }
                if case let .toolResult(rowID, _, isError, preview, info)? = result {
                    // wave3 mac-agents (§36.1): the report's first lines as markdown + "View full report".
                    AgentReportRow(toolUseId: toolUseId, isError: isError, preview: preview, info: info,
                                   revealMatch: view.currentMatch == rowID)
                        .modifier(MatchHighlight(isMatch: view.isMatch(rowID), isCurrent: view.currentMatch == rowID))
                        .id(rowID)
                }
            }
            .modifier(MatchHighlight(isMatch: view.isMatch(call.id), isCurrent: view.currentMatch == call.id))
            .id(call.id)
        }
    }
}

/// M20: the plan in the history — the proposal (collapsed markdown) and, later, the approval line.
private struct PlanTranscriptRow: View {
    @Environment(TranscriptViewState.self) private var view
    let rowID: UUID
    let path: String?
    let plan: String
    /// nil for the proposal row; the mode the plan was approved into otherwise.
    let approvedMode: PermissionMode?

    private var fileName: String? { path.map { ($0 as NSString).lastPathComponent } }
    private var expanded: Binding<Bool> {
        Binding(get: { view.planRowExpansion[rowID] ?? false }, set: { view.planRowExpansion[rowID] = $0 })
    }

    var body: some View {
        if let mode = approvedMode {
            // wave4d w4d-plan (§42.1): a plan that went to a new chat / workbench says where (its row's text); else the mode.
            Label(plan.isEmpty ? String(localized: "Plan approved — continuing in \(mode.displayName)") : plan, systemImage: "checkmark.seal")
                .font(.callout)
                .foregroundStyle(.green)
                .accessibilityIdentifier("Plan approved row")
        } else {
            DisclosureGroup(isExpanded: expanded) {
                MarkdownText(text: plan)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            } label: {
                Label(fileName.map { String(localized: "Plan proposed (\($0))") } ?? String(localized: "Plan proposed"),
                      systemImage: "list.bullet.clipboard")
                    .font(.callout)
                    .foregroundStyle(.blue)
            }
            .accessibilityIdentifier("Plan proposed row")
        }
    }
}

/// ⌘F: every matching row gets an outline; the current one a stronger outline and a tint.
struct MatchHighlight: ViewModifier {
    let isMatch: Bool
    let isCurrent: Bool

    func body(content: Content) -> some View {
        if isMatch {
            content
                .background(Color.yellow.opacity(isCurrent ? 0.12 : 0), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Color.yellow.opacity(isCurrent ? 0.9 : 0.4), lineWidth: isCurrent ? 2 : 1)
                    .padding(-3))
        } else {
            content
        }
    }
}
