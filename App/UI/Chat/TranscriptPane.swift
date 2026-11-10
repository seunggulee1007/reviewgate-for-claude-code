import SwiftUI
import ReviewGateCore

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the transcript as its own view. It is drawn from the shared model
// (`AppState.liveLookups`, updated once per row change) and redrawn when rows come or change in place — never per streamed
// delta (the streaming row and `TranscriptFollower` observe that) and never per keystroke (the composer is apart).

/// The transcript's own state: folds, flashes, ⌘F and scroll following. The rows read what they need from it.
@MainActor
@Observable
final class TranscriptViewState {
    /// Agent groups the user expanded / collapsed (by Agent tool_use id); others follow their status.
    var groupExpansion: [String: Bool] = [:]
    /// §39.2 (market-12): exploration runs the user opened / closed (by the run's first row); others stay folded.
    var exploreExpansion: [UUID: Bool] = [:]
    /// Rows the user opened / closed (by row id), kept across a look at another chat tab like the groups and runs above:
    /// tool results, turn summaries, Edit / Write mini diffs and proposed plans. Apart, so a click redraws one kind of row.
    var resultExpansion: [UUID: Bool] = [:]
    var summaryExpansion: [UUID: Bool] = [:]
    var editPreviewExpansion: [UUID: Bool] = [:]
    var planRowExpansion: [UUID: Bool] = [:]
    /// r2-review-flow M27: decided permission cards the user opened from their one-line row (by request id).
    var permissionExpansion: [String: Bool] = [:]
    /// The tool row "Why it changed" just revealed; highlighted briefly.
    var flashToolUseId: String?
    /// MARK: wave7 w7-chat — §45.1: the agent groups around the row the last reveal / ⌘F jump went to. Their rows are drawn
    /// all at once (not lazily) so the row exists when the view scrolls to it.
    var eagerGroups: Set<String> = []
    /// wave1 mac-perms: the permission card "카드로 이동" just revealed; highlighted briefly.
    var flashPermissionId: String?
    // Answers being written in cards that leave the view while another chat tab is shown — kept here (the chat column's
    // own state) so they are still there on return, as the composer's draft is.
    /// The plan card's step notes and note, for the proposal they were written on.
    var planDraft: PlanCardDraft?
    /// A question card's choices and "Other…" text, by request id — r1-composer M08: the message box fills it too.
    var questionDrafts: [String: QuestionDraft] = [:]
    /// A permission card's "Deny with instruction…" text, by request id.
    var denyInstructions: [String: String] = [:]
    // ⌘F
    var findVisible = false
    var findQuery = ""
    var findIndex = 0
    var findMatches: [UUID] = [] {
        didSet { matchSet = Set(findMatches) }
    }
    private(set) var matchSet: Set<UUID> = []
    var findFocusTick = 0
    // Scroll following: the transcript sticks to the bottom only while the user is there.
    var follow = true
    /// Rows that arrived while the user was reading further up (the "↓ Latest (N)" pill).
    var unseen = 0
    @ObservationIgnored var nearBottom = true
    @ObservationIgnored var userScrolling = false
    @ObservationIgnored var seenCount = 0
    /// While an answer streams the view follows at most every `TranscriptFollower.streamGap`.
    @ObservationIgnored var lastStreamFollow: ContinuousClock.Instant?
    /// r1x — §45.1: when the view last followed a new row (rows in quick succession are not animated one by one).
    @ObservationIgnored var lastRowFollow: ContinuousClock.Instant?
    @ObservationIgnored var pendingStreamFollow: Task<Void, Never>?

    /// §45.1: where the rows made at once begin (`TranscriptPane.tailStart`). Rows crossing into the lazy stack get estimated
    /// heights there, which moves what is shown: it moves on only while following, when a turn begins (the message glides in)
    /// or once more than `TranscriptPane.tailCap` rows are made at once — never under a reader scrolled up, never mid-turn.
    @ObservationIgnored private var tailStartKept = 0

    func tailStart(for entries: [ExploreFold.Entry]) -> Int {
        let wanted = TranscriptPane.tailStart(entries.count)
        var turnBegins = false
        if case let .node(.row(item))? = entries.last, case .user = item { turnBegins = true }
        if wanted < tailStartKept || (follow && (turnBegins || entries.count - tailStartKept > TranscriptPane.tailCap)) {
            tailStartKept = wanted
        }
        return tailStartKept
    }

    func isMatch(_ id: UUID) -> Bool { findVisible && matchSet.contains(id) }

    var currentMatch: UUID? { findVisible && findMatches.indices.contains(findIndex) ? findMatches[findIndex] : nil }

    /// A field of the plan card's draft for the proposal `key`; another proposal's draft reads as empty and is replaced
    /// by the first edit.
    func planDraftBinding<Value>(_ key: String, _ field: WritableKeyPath<PlanCardDraft, Value>) -> Binding<Value> {
        Binding(get: { (self.planDraft?.plan == key ? self.planDraft : nil)?[keyPath: field] ?? PlanCardDraft(plan: key)[keyPath: field] },
                set: { value in
                    var draft = self.planDraft?.plan == key ? self.planDraft ?? PlanCardDraft(plan: key) : PlanCardDraft(plan: key)
                    draft[keyPath: field] = value
                    self.planDraft = draft
                })
    }
}

/// What is typed on the plan card (`TranscriptViewState.planDraft`); a new proposal starts empty.
struct PlanCardDraft: Equatable {
    /// The proposal the notes are for (`PendingPlan.at`, else its path).
    var plan: String
    var stepNotes: [Int: String] = [:]
    var note = ""
}

struct TranscriptPane: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    /// Settings › General "탐색 행 자세히 보기": every row as before.
    @AppStorage(ExploreFold.detailDefaultsKey) private var showExploreDetail = false
    @Bindable var view: TranscriptViewState
    /// Closing ⌘F hands the keyboard back to it.
    let composer: ComposerModel
    /// The rows' lookups, rebuilt only when rows are added / removed (not per streaming delta).
    @State private var cache = TranscriptRenderCache()

    static let bottomID = "bottom"

    /// §45.1: the newest rows are made at once, below the lazy stack — at least this many, the boundary moving `tailStep` rows at a
    /// time (a row crosses it rarely).
    static let tailRows = 30
    static let tailStep = 10
    /// More rows than this made at once (a turn that keeps adding them) and the boundary moves on anyway.
    static let tailCap = 120

    /// Where the rows made at once begin: everything before it is lazy.
    static func tailStart(_ count: Int) -> Int {
        count > tailRows ? (count - tailRows) / tailStep * tailStep : 0
    }

    var body: some View {
        let shown = cache.shown(store)
        let context = cache.context(store, shown: shown)
        let restored = store.restoredTranscriptIDs
        // MARK: wave4b w4b-tabs — §39.2 (market-12): a run of reads / searches is one "탐색: …" row
        let entries = showExploreDetail ? shown.model.nodes.map(ExploreFold.Entry.node) : shown.model.entries
        let split = view.tailStart(for: entries)
        ScrollViewReader { proxy in
            ScrollView {
                // §45.1: the newest rows and the bottom marker are not lazy. A card above the composer leaves the transcript
                // ~100 pt; the lazy stack, making a row or two, re-estimated the rows it had not made (13 220 → 157 724 →
                // 13 817 pt in 30 ms) and following them the view ended where no row was made — blank — or far above the
                // newest row. The rows at the bottom now have their real heights, whatever the stack above estimates.
                VStack(alignment: .leading, spacing: 10) {
                    if split > 0 {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            header(restored: restored, proxy: proxy)
                            ForEach(entries[..<split]) { entry in
                                TranscriptEntryView(entry: shown.live(entry), context: context, restored: restored.contains(entry.id)).equatable()
                            }
                        }
                    } else {
                        header(restored: restored, proxy: proxy)
                    }
                    ForEach(entries[split...]) { entry in
                        TranscriptEntryView(entry: shown.live(entry), context: context, restored: restored.contains(entry.id)).equatable()
                    }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .padding(12)
            }
            // r1x — §45.1: while following, the newest row stays in view whenever the content's height changes — rows coming
            // into a group above the bottom (a subagent's calls), a row finishing in place, a group folding — at once, not
            // only when a row is appended (its height can still change after that scroll).
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                guard abs(new - old) > 0.5, view.follow, !view.userScrolling, view.flashToolUseId == nil, store.viewingChat == nil else { return }
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 32
            } action: { _, near in
                view.nearBottom = near
                if near {
                    if !view.follow { view.follow = true }
                    if view.unseen != 0 { view.unseen = 0 }
                }
            }
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .interacting, .decelerating:
                    view.userScrolling = true
                case .idle:
                    // Only a scroll the user made decides whether to keep following (content growth does not).
                    if view.userScrolling {
                        view.userScrolling = false
                        view.follow = view.nearBottom
                        if view.follow, view.unseen != 0 { view.unseen = 0 }
                    }
                default:
                    break
                }
            }
            // It opens at the newest row, and a short chat sits at the bottom. A change of size keeps the offset; while
            // following, `TranscriptFollower` brings the newest row back. Anchored to the bottom for size changes too, the
            // lazy stack re-estimated the height of the rows it had not made and moved to a bottom where it made none — a
            // blank transcript after ⇧⇥ (the HUD's mode badge is 2 pt taller) or when a review began (§45.1).
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .onAppear {
                // A window that opens on an existing transcript starts at its end — also a chat made again over the state
                // the window kept (r1-composer M12: back from the PRs tab), whose last scroll may have been cut off.
                view.userScrolling = false
                view.seenCount = store.transcript.count
                DispatchQueue.main.async { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
            .background { TranscriptFollower(view: view, proxy: proxy) }
            .background { AgentResumeWatcher(view: view) }
            .overlay(alignment: .bottom) { LatestPill(view: view, proxy: proxy) }
            .safeAreaInset(edge: .top, spacing: 0) {
                if view.findVisible {
                    TranscriptFindBar(query: $view.findQuery,
                                      current: view.findMatches.isEmpty ? nil : view.findIndex,
                                      total: view.findMatches.count,
                                      focusTick: view.findFocusTick,
                                      onNext: { jumpToMatch(view.findIndex + 1, proxy: proxy) },
                                      onPrevious: { jumpToMatch(view.findIndex - 1, proxy: proxy) },
                                      onClose: closeFind)
                        .padding(.top, 8).padding(.horizontal, 12)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .onChange(of: model.revealTick) { _, _ in
                guard let id = model.revealToolUseId else { return }
                // wave4b integration: a call in the shown chat's own rows (a link on a turn summary card of a chat shown
                // read-only, §39.2 × §39.3) is revealed there; any other call is the running chat's.
                if store.revealStaysInViewedChat(toolUseId: id) {
                    openRuns { $0.contains(toolUseId: id) }
                    reveal(id, proxy: proxy)
                    return
                }
                afterLiveChat {   // wave4b w4b-tabs: the row is the running chat's; a folded run around it stays open
                    openRuns { $0.contains(toolUseId: id) }
                    reveal(id, proxy: proxy)
                }
            }
            .onChange(of: model.revealPermissionTick) { _, _ in   // wave1 mac-perms: "카드로 이동"
                guard let id = model.revealPermissionRequestId else { return }
                afterLiveChat { revealPermission(id, proxy: proxy) }   // wave4b w4b-tabs: the card is the running chat's
            }
            // MARK: wave4b w4b-tabs — §39.2: another chat (or the live one again) is shown: start at its end.
            .onChange(of: store.viewingChat.map { "\($0.id)|\($0.rows.isEmpty)" }) { _, _ in
                view.follow = true
                view.unseen = 0
                view.seenCount = store.transcript.count - store.transcriptPaging.prepended
                DispatchQueue.main.async { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
            // MARK: wave4b w4-notify — a clicked notification's card / summary (also when the chat appears after it)
            .onChange(of: model.notificationRevealTick) { _, _ in revealNotified(proxy) }
            .onAppear { revealNotified(proxy) }
            .onChange(of: model.findTick) { _, _ in openFind() }
            // MARK: wave4 w4-history — §38.3: a chat-history search match, once its row is shown.
            .onChange(of: store.transcriptJumpItem) { _, item in
                guard let item else { return }
                view.follow = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(item.id, anchor: .center) }
                }
            }
            .onChange(of: view.findQuery) { _, _ in
                recomputeMatches()
                jumpToMatch(0, proxy: proxy)
            }
            .onChange(of: store.transcriptStructureRevision) { _, _ in
                if view.findVisible { recomputeMatches() }
            }
        }
    }

    /// What sits above the rows: the imported-session note, the shown chat's bar, [이전 대화 더 보기], the empty state and the
    /// restored divider.
    @ViewBuilder
    private func header(restored: Set<UUID>, proxy: ScrollViewProxy) -> some View {
        ImportedChatNote()   // wave3 mac-session (§36.9): a terminal session imported here — the gate applies from now on
        // MARK: wave4b w4b-tabs — §39.2 another chat's saved rows, read-only: loading / [이전 대화 더 보기]
        if let viewed = store.viewingChat {
            ViewedChatHeader(viewed: viewed)
        }
        // MARK: wave4 w4-history — §38.3 [이전 대화 더 보기]: the rows before the oldest shown one, the view kept on it
        if store.viewingChat == nil, store.transcriptPaging.canLoadEarlier, !store.transcript.isEmpty {
            EarlierMessagesButton { first in DispatchQueue.main.async { proxy.scrollTo(first, anchor: .top) } }
        }
        if store.viewingChat == nil, store.transcript.isEmpty {
            emptyState
        }
        if store.viewingChat == nil, !restored.isEmpty {
            restoredDivider
        }
    }

    // MARK: wave4b w4b-tabs

    /// §39.2: a reveal of the running chat's row / card shows the running chat first.
    private func afterLiveChat(_ action: @escaping () -> Void) {
        guard store.viewingChat != nil else { action(); return }
        store.stopViewing()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { action() }
    }

    /// market-12: opens (and keeps open) the folded runs `matching` picks.
    private func openRuns(_ matching: (ExploreRun) -> Bool) {
        for case let .run(run) in cache.shown(store).model.entries where matching(run) { view.exploreExpansion[run.id] = true }
    }

    // MARK: Find (⌘F)

    private func openFind() {
        if view.findVisible { view.findFocusTick += 1; return }
        withAnimation(.easeOut(duration: 0.12)) { view.findVisible = true }
        recomputeMatches()
    }

    private func closeFind() {
        withAnimation(.easeOut(duration: 0.12)) { view.findVisible = false }
        view.findMatches = []
        cache.shown(store).lookups.dropSearchTexts()   // MARK: wave7 w7-chat — §45.1: the tool rows' texts are kept while searching only
        composer.inputFocused = true
    }

    /// MARK: wave7 w7-chat — §45.1: the rows as they are now; a tool call's JSON is worked out once per search, not per keystroke.
    private func recomputeMatches() {
        let shown = cache.shown(store)
        view.findMatches = TranscriptSearch.matches(view.findQuery, in: shown.model.nodes) { shown.lookups.searchText(shown.liveItem($0)) }
        if view.findIndex >= view.findMatches.count { view.findIndex = max(0, view.findMatches.count - 1) }
    }

    /// Selects match `index` (wrapping), expands the agent groups around it and scrolls it to the middle.
    private func jumpToMatch(_ index: Int, proxy: ScrollViewProxy) {
        let n = view.findMatches.count
        guard n > 0 else { return }
        view.findIndex = ((index % n) + n) % n
        let id = view.findMatches[view.findIndex]
        let model = cache.shown(store).model
        let groups = TranscriptSearch.enclosingGroups(ofRow: id, in: model.nodes) ?? []
        view.eagerGroups = Set(groups)
        for g in groups { view.groupExpansion[g] = true }
        openRuns { $0.contains(row: id) }   // wave4b w4b-tabs (market-12): a folded run around the match opens
        view.follow = false
        // The outermost group's head first (the transcript's stack is lazy), then the row inside it.
        let outer = groups.first.flatMap { model.index.calls[$0]?.rowID }
        Task { @MainActor in
            if let outer { proxy.scrollTo(outer, anchor: .top) }
            try? await Task.sleep(for: .milliseconds(outer == nil ? 60 : 120))   // let an expanded group lay out its rows first
            withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) }
        }
    }

    // MARK: Reveal (chat → diff, cards, notifications)

    /// Scrolls the chat to a tool call (expanding the agent groups around it) and flashes it.
    private func reveal(_ toolUseId: String, proxy: ScrollViewProxy) {
        let model = cache.shown(store).model
        guard let rowID = model.index.calls[toolUseId]?.rowID,
              let groups = TranscriptNode.enclosingGroups(of: toolUseId, in: model.nodes) else { return }
        view.eagerGroups = Set(groups)
        withAnimation(.easeInOut(duration: 0.15)) {
            for g in groups { view.groupExpansion[g] = true }
            // MARK: wave4b w4b-agents — agents-11: revealing an agent (its card, its timeline bar) opens its own group too.
            if model.index.calls[toolUseId]?.spawnsAgent == true { view.groupExpansion[toolUseId] = true }
        }
        view.flashToolUseId = toolUseId
        let outer = groups.first.flatMap { model.index.calls[$0]?.rowID }
        Task { @MainActor in
            if let outer { proxy.scrollTo(outer, anchor: .top) }
            try? await Task.sleep(for: .milliseconds(120))
            withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(rowID, anchor: .center) }
            try? await Task.sleep(for: .milliseconds(1600))
            if view.flashToolUseId == toolUseId { view.flashToolUseId = nil }
        }
    }

    /// wave1 mac-perms: scrolls to the permission card of `requestId` (a top-level row) and flashes it.
    private func revealPermission(_ requestId: String, proxy: ScrollViewProxy) {
        guard let row = store.transcript.last(where: {
            if case let .permission(_, request, _) = $0 { return request.requestId == requestId }
            return false
        }) else { return }
        view.follow = false
        view.flashPermissionId = requestId
        withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(row.id, anchor: .center) }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1600))
            if view.flashPermissionId == requestId { view.flashPermissionId = nil }
        }
    }

    // MARK: wave4b w4-notify
    /// A clicked notification (`WindowModel.openFromNotification`): its permission / question card (flashed), the plan
    /// still waiting, or the finished turn's summary card — after the window and tab have settled.
    private func revealNotified(_ proxy: ScrollViewProxy) {
        guard let target = model.notificationReveal else { return }
        model.notificationReveal = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            // wave4b integration (§39.2): only in the notification's own chat (a closed tab's chat is not shown).
            if let chat = target.chatId, chat != store.shownChatId { return }
            if let requestId = target.requestId, target.kind == .permission || target.kind == .question {
                revealPermission(requestId, proxy: proxy)
                return
            }
            guard let row = AttentionReveal.row(for: target, in: store.viewingChat?.rows ?? store.transcript) else { return }
            view.follow = false
            withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(row, anchor: .top) }
        }
    }

    // MARK: Fixed rows

    /// Above the rows replayed by `transcript_restore` (audit 3.1); those rows render dimmed.
    private var restoredDivider: some View {
        HStack {
            Rectangle().fill(.quaternary).frame(height: 1)
            Label("Restored from a previous session", systemImage: "clock.arrow.circlepath")
                .font(.caption).foregroundStyle(.secondary).fixedSize()
            Rectangle().fill(.quaternary).frame(height: 1)
        }
        .accessibilityIdentifier("Transcript restored marker")
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Ask Claude to make a change.", systemImage: "sparkles")
                .font(.callout.weight(.medium))
            Group {
                if store.budget.isOn {
                    Text("Each reply is limited to \(store.budget.maxFiles) files / \(store.budget.maxLines) lines; you'll review the diff before continuing.")
                } else {
                    Text("You'll review what Claude changed before you continue.")   // §54: no limit to name
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("Chat empty state")
    }
}

/// Keeps the newest row in view while following; otherwise counts what arrived for the pill.
/// MARK: wave7 w7-chat — §45.1: its own view, so a streamed delta does not redraw the transcript; while an answer streams it
/// follows the bottom at most every `streamGap` (and once more after the last burst), without animation as before.
private struct TranscriptFollower: View {
    @Environment(AppState.self) private var store
    let view: TranscriptViewState
    let proxy: ScrollViewProxy

    static let streamGap: Duration = .milliseconds(80)

    var body: some View {
        Color.clear
            .onChange(of: store.transcriptRevision) { _, _ in follow() }
            // The transcript's room changed (the HUD's mode badge, a card, the review notice, the diff pane): the newest row
            // stays in view while following — scrolled to that row, which the lazy stack makes, not to an estimated bottom.
            .onGeometryChange(for: CGSize.self) { $0.size } action: { _ in keepBottom() }
    }

    private func keepBottom() {
        guard view.follow, !view.userScrolling, view.flashToolUseId == nil else { return }
        proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom)
        settleAtBottom()   // r1x: once more after the rows are laid out at the new width (the kept row is re-placed meanwhile)
    }

    private func follow() {
        let count = store.transcript.count - store.transcriptPaging.prepended   // wave4 w4-history: earlier rows are not new
        defer { view.seenCount = count }
        if store.viewingChat != nil { return }   // wave4b w4b-tabs: the live chat's rows are not on screen
        if count < view.seenCount {
            // Chat switched / cleared: start at the bottom again.
            view.follow = true
            view.unseen = 0
        }
        guard view.flashToolUseId == nil else { return }   // don't yank the view away from a revealed row
        if view.follow, !view.userScrolling {
            if count > view.seenCount {
                // r1x — §45.1: a row that comes alone glides in; rows that keep coming (subagents at work) do not restart an
                // animation each — that bounced the view — and one more pin after their layout keeps the newest in view.
                let now = ContinuousClock.now
                var alone = true
                if let last = view.lastRowFollow, now - last < Self.rowGap { alone = false }
                view.lastRowFollow = now
                if alone {
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom) }
                } else {
                    proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom)
                }
                settleAtBottom()
            } else {
                followStream()   // a streaming delta: no animation per token
            }
        } else if count > view.seenCount {
            view.unseen += count - view.seenCount
        }
    }

    /// r1x — §45.1: rows that keep coming less than this apart are followed without an animation each.
    static let rowGap: Duration = .milliseconds(400)

    /// One more pin to the bottom once the rows just followed are laid out (the lazy stack sizes them after the scroll).
    private func settleAtBottom() {
        let state = view, scroller = proxy, app = store
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(200))
            guard state.follow, !state.userScrolling, state.flashToolUseId == nil, app.viewingChat == nil else { return }
            scroller.scrollTo(TranscriptPane.bottomID, anchor: .bottom)
        }
    }

    private func followStream() {
        let now = ContinuousClock.now
        guard let last = view.lastStreamFollow, now - last < Self.streamGap else {
            view.lastStreamFollow = now
            proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom)
            return
        }
        guard view.pendingStreamFollow == nil else { return }
        let view = view, proxy = proxy, store = store
        view.pendingStreamFollow = Task { @MainActor in
            try? await Task.sleep(until: last + Self.streamGap, clock: .continuous)
            view.pendingStreamFollow = nil
            guard view.follow, !view.userScrolling, view.flashToolUseId == nil, store.viewingChat == nil else { return }
            view.lastStreamFollow = .now
            proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom)
        }
    }
}

/// "↓ Latest (N)": scroll to the newest message and keep following.
private struct LatestPill: View {
    @Environment(\.colorScheme) private var colorScheme
    let view: TranscriptViewState
    let proxy: ScrollViewProxy

    var body: some View {
        if !view.follow {
            Button {
                view.follow = true
                view.unseen = 0
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(TranscriptPane.bottomID, anchor: .bottom) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.down")
                    Text(view.unseen > 0 ? String(localized: "Latest (\(view.unseen))") : String(localized: "Latest"))
                }
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.accentColor.opacity(view.unseen > 0 ? 0.7 : 0.3)))
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.5 : 0.18), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 10)
            .help("Scroll to the newest message and keep following")
            .accessibilityIdentifier("Jump to latest")
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}

/// MARK: wave3 mac-agents — §36.3: the group of an agent a SendMessage continued opens. Its own view: it reads the agents.
private struct AgentResumeWatcher: View {
    @Environment(AppState.self) private var store
    let view: TranscriptViewState

    /// Agent tool_use id → how many times SendMessage continued it.
    private var resumeCounts: [String: Int] {
        Dictionary(store.agents.map { ($0.toolUseId, $0.resumeCount) }, uniquingKeysWith: { _, b in b })
    }

    var body: some View {
        Color.clear
            .onChange(of: resumeCounts) { previous, _ in
                for id in AgentContinuationText.newlyResumed(previous: previous, agents: store.agents) { view.groupExpansion[id] = true }
            }
    }
}

/// What the pane's rows are drawn from: the running chat's lookups (`AppState.liveLookups`) or those of another chat shown
/// read-only, the review's links (rebuilt when the changed files change) and the root's URL (one value, not one per row).
/// Not observable on purpose: it is read and refreshed while the pane's body is evaluated.
@MainActor
final class TranscriptRenderCache {
    /// §39.2: another chat's saved rows, read-only; let go once the pane shows the running chat again.
    private var viewedLookups: TranscriptLookups?
    private var files: [ChangedFile]?
    private var links = TranscriptLinks(files: [])
    private var rootURL: URL?

    /// The shown chat's lookups and rows.
    func shown(_ store: AppState) -> ShownRows {
        if let viewed = store.viewingChat {
            let lookups = viewedLookups ?? TranscriptLookups()
            viewedLookups = lookups
            lookups.update(viewed.rows, key: "\(viewed.id)#\(viewed.rows.count)")
            return ShownRows(lookups: lookups, viewedRows: viewed.rows, store: store)
        }
        viewedLookups = nil
        return ShownRows(lookups: store.liveLookups, viewedRows: nil, store: store)
    }

    func context(_ store: AppState, shown: ShownRows) -> TranscriptRowContext {
        let current = store.changedFiles
        if files != current {
            files = current
            links = TranscriptLinks(files: current)
        }
        let url = store.projectURL
        if rootURL != url { rootURL = url }
        let viewing = store.viewingChat != nil
        return TranscriptRowContext(lookups: shown.lookups, links: links, root: store.projectInfo?.root ?? url?.path, rootURL: rootURL,
                                    running: store.isRunning && !viewing,   // wave4b w4b-tabs: a saved chat runs nothing
                                    viewing: viewing, latestSummaryId: shown.model.lastSummaryID, rebuilds: shown.model.rebuilds)
    }
}

/// The shown chat's rows and their model. It keeps neither the transcript nor a copy of the model: the rows' closures keep
/// this, and a view that kept them would make the next appended row copy the whole array.
@MainActor
struct ShownRows {
    let lookups: TranscriptLookups
    /// Another chat's saved rows (they do not change); nil: the running chat's, read from the store when needed.
    let viewedRows: [ChatItem]?
    let store: AppState

    var model: TranscriptModel { lookups.model }

    /// The row as it is now: a node holds the row as it was placed (a decision or a finished answer changes a top-level
    /// row in place).
    func liveItem(_ item: ChatItem) -> ChatItem {
        guard let i = lookups.position(of: item.id) else { return item }
        let rows = viewedRows ?? store.transcript
        guard rows.indices.contains(i), rows[i].id == item.id else { return item }
        return rows[i]
    }

    func live(_ entry: ExploreFold.Entry) -> ExploreFold.Entry {
        guard case let .node(.row(item)) = entry else { return entry }
        return .node(.row(liveItem(item)))
    }
}
