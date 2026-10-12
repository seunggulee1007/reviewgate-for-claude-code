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
    @State private var composer = ComposerModel()
    @State private var transcript = TranscriptViewState()
    @State private var actions = ChatActions()

    var body: some View {
        VStack(spacing: 0) {
            ChatHeader()
            Divider()
            TranscriptPane(view: transcript, composer: composer)
                .overlay(alignment: .bottomLeading) { ComposerPalettes(composer: composer) }
                .overlay(alignment: .top) { PermissionToast() }   // wave1 mac-perms: "이미 처리된 권한 요청입니다"
            Divider()
            HUDStrip()
            Divider()
            ChatPlanSlot(composer: composer)
            DefaultModeOfferBanner()   // wave1 mac-perms: "터미널처럼 auto 모드로 시작할까요?" (§2.8)
            ChatPeerInboxSlot()   // §2.7: the inbox card sits right above the composer
            ChatMoveBar()   // wave4b w4b-follow (§39.4): "옮김 → <worktree>" / why a move was refused
            ChatComposer(composer: composer, transcript: transcript)
        }
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
