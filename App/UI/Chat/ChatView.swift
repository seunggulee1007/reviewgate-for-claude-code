import SwiftUI
import ReviewGateCore

/// The chat column: tabs, the transcript, the HUD, the plan card and banners, and the composer.
/// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: a shell that reads nothing per keystroke or per streamed delta — the
/// transcript (`TranscriptPane`), the composer (`ChatComposer`) and the palettes over the transcript (`ComposerPalettes`)
/// each observe what they draw; the rows act through `ChatActions`.
struct ChatView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @State private var actions = ChatActions()
    /// r1-composer M12: the window keeps them — the PRs tab and an engine that stopped make this view again (§38.1).
    private var composer: ComposerModel { model.chatComposer }
    private var transcript: TranscriptViewState { model.chatTranscript }

    var body: some View {
        // §49.2: a short window (a new workbench's, or one with the mode offer up) never pushes the HUD or the composer out
        // of sight — the transcript gives way first, then the cards above the composer scroll.
        ChatColumnLayout {
            VStack(spacing: 0) {
                ChatHeader()
                Divider()
            }
            TranscriptPane(view: transcript, composer: composer)
                .overlay(alignment: .bottomLeading) { ComposerPalettes(composer: composer) }
                .overlay(alignment: .top) { PermissionToast() }   // wave1 mac-perms: "이미 처리된 권한 요청입니다"
            VStack(spacing: 0) {
                Divider()
                HUDStrip()
                Divider()
            }
            ScrollView {
                VStack(spacing: 0) {
                    ChatQuestionSlot(composer: composer)   // r1-composer M08: the question the message box answers
                    ChatPlanSlot(composer: composer)
                    DefaultModeOfferBanner()   // wave1 mac-perms: "터미널처럼 auto 모드로 시작할까요?" (§2.8)
                    ChatPeerInboxSlot()   // §2.7: the inbox card sits right above the composer
                    ChatMoveBar()   // wave4b w4b-follow (§39.4): "옮김 → <worktree>" / why a move was refused
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            #if DEBUG
            // r1-composer: the layout check says when a card above the composer (Claude's question) is cut.
            .onScrollGeometryChange(for: CGSize.self) { CGSize(width: $0.containerSize.height, height: $0.contentSize.height) } action: { _, size in
                model.debugCardsHeights = size
            }
            #endif
            ChatComposer(composer: composer, transcript: transcript)
        }
        .clipped()
        .environment(transcript)
        .environment(\.chatActions, actions)
        .onAppear { actions.attach(store: store, window: model, composer: composer, transcript: transcript, openWindow: openWindow) }
        // MARK: wave3 mac-agents — "Agent details" (§36.1), its "Send to main chat"
        .modifier(AgentDetailSheetHost())
    }
}

/// M15: a tab strip once the engine reports chat sessions; the plain "Chat" title on older engines.
private struct ChatHeader: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    /// M15: the "History…" sheet of the chat tab strip.
    @State private var showHistory = false

    var body: some View {
        if store.hasChatSessions {
            ChatTabStrip(showHistory: $showHistory)
                .sheet(isPresented: $showHistory, onDismiss: { model.highlightChatId = nil }) {
                    ChatHistorySheet(highlightId: model.highlightChatId)
                }
                .onChange(of: model.showChatHistoryTick) { _, _ in showHistory = true }   // wave1 mac-session (§30)
        } else {
            HStack {
                Text("Chat").font(.headline)
                if store.isRunning {
                    ProgressView().controlSize(.small)
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }
}

/// M20: the plan card — sticky until answered; a normal send supersedes it (the engine clears `pendingPlan`).
private struct ChatPlanSlot: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(TranscriptViewState.self) private var transcript
    let composer: ComposerModel

    var body: some View {
        if let plan = store.pendingPlan, store.viewingChat == nil {   // wave4b w4b-tabs: the running chat's plan
            let key = plan.at.isEmpty ? (plan.path ?? "") : plan.at
            PlanCard(plan: plan,
                     isLocked: store.isPlanLocked,
                     refusal: store.planRefusal,
                     onApprove: { store.approvePlan(mode: $0) },
                     onKeepPlanning: { store.keepPlanning(message: $0) },
                     onFocusComposer: { composer.inputFocused = true },   // wave1 mac-perms: the keyboard back after an answer
                     // MARK: wave4d w4d-plan — §42.1: implement in a new chat / a new workbench
                     handoffBlocker: store.planHandoffBlocker,
                     onApproveNewChat: { store.approvePlanInNewChat(mode: $0) },
                     onApproveWorkbench: { mode in
                         model.newWorkbenchPlanMode = mode
                         model.newWorkbenchBranch = PlanBranchName.suggest(planPath: plan.path)
                         model.showNewWorkbench = true
                     },
                     // what is typed survives a look at another chat tab; a new proposal (another key) starts empty
                     stepNotes: transcript.planDraftBinding(key, \.stepNotes),
                     note: transcript.planDraftBinding(key, \.note))
                .padding(.horizontal, 12).padding(.top, 10)
        }
    }
}

/// r1-composer M08: Claude's open question above the composer — the card the message box answers (a typed answer, 1…N,
/// ↩). The question a typed answer goes to scrolls into view when it changes (several questions, a small window).
private struct ChatQuestionSlot: View {
    @Environment(AppState.self) private var store
    @Environment(TranscriptViewState.self) private var transcript
    let composer: ComposerModel

    var body: some View {
        if let open = store.openQuestion {
            let id = open.requestId
            let current = (transcript.questionDrafts[id] ?? QuestionDraft()).current(in: open.questions)
            ScrollViewReader { proxy in
                QuestionCard(
                    questions: open.questions,
                    decision: nil,
                    requestId: id,
                    isOpen: true,
                    onAnswer: { store.answerQuestions(requestId: id, answers: $0); transcript.questionDrafts[id] = nil },
                    onSkip: { store.skipQuestions(requestId: id); transcript.questionDrafts[id] = nil },
                    onFocusComposer: { composer.inputFocused = true },
                    answeredFromComposer: true,
                    draft: Binding(get: { transcript.questionDrafts[id] ?? QuestionDraft() }, set: { transcript.questionDrafts[id] = $0 }))
                .onChange(of: current) { _, index in
                    guard let index, open.questions.questions.count > 1 else { return }
                    withAnimation(.easeInOut(duration: 0.15)) { proxy.scrollTo(QuestionCard.questionAnchor(index), anchor: .top) }
                }
            }
            .padding(.horizontal, 12).padding(.top, 10)
        }
    }
}

/// wave1 mac-session (§29): the peer inbox card.
private struct ChatPeerInboxSlot: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if !store.peerInbox.isEmpty {
            PeerInboxCard()
                .padding(.horizontal, 12).padding(.top, 10)
        }
    }
}

/// §49.2: the chat column, bottom up — the composer and the HUD at their own height, the cards above the composer (plan,
/// mode offer, peer inbox, move bar) at theirs as long as the transcript keeps `minTranscript` (else they scroll), the
/// transcript the rest, down to nothing; the header on top. Its minimum height is header + HUD + composer, so a short window
/// (or a card that appears) never pushes the composer below the window's edge. Subviews: header, transcript, HUD, cards,
/// composer — in that order.
struct ChatColumnLayout: Layout {
    struct Heights: Equatable {
        var header: CGFloat = 0
        var hud: CGFloat = 0
        var cards: CGFloat = 0
        var composer: CGFloat = 0
        var fixed: CGFloat { header + hud + composer }
    }

    /// Each part's own height at `width` (the transcript has none: it takes what is left).
    static func heights(width: CGFloat, subviews: Subviews) -> Heights {
        guard subviews.count == 5 else { return Heights() }
        let p = ProposedViewSize(width: width, height: nil)
        return Heights(header: subviews[0].sizeThatFits(p).height, hud: subviews[2].sizeThatFits(p).height,
                       cards: subviews[3].sizeThatFits(p).height, composer: subviews[4].sizeThatFits(p).height)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let h = Self.heights(width: width, subviews: subviews)
        guard let height = proposal.height else { return CGSize(width: width, height: h.fixed + h.cards + ChatColumnSplit.minTranscript) }
        return CGSize(width: width, height: height.isFinite ? max(height, h.fixed) : height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 5 else { return }
        let w = bounds.width
        let h = Self.heights(width: w, subviews: subviews)
        let (transcript, cards) = ChatColumnSplit.split(room: bounds.height - h.fixed, cards: h.cards)
        func place(_ index: Int, y: CGFloat, height: CGFloat) {
            subviews[index].place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: w, height: height))
        }
        let composerY = bounds.maxY - h.composer
        let cardsY = composerY - cards
        let hudY = cardsY - h.hud
        place(4, y: composerY, height: h.composer)
        place(3, y: cardsY, height: cards)
        place(2, y: hudY, height: h.hud)
        place(1, y: bounds.minY + h.header, height: transcript)
        place(0, y: bounds.minY, height: h.header)
    }
}
