import SwiftUI
import ReviewGateCore

extension PermissionMode {
    /// SF Symbol for the mode picker and the HUD badge.
    var symbolName: String {
        switch self {
        case .default: "shield.lefthalf.filled"
        case .auto: "wand.and.stars"
        case .plan: "list.bullet.clipboard"
        case .acceptEdits: "pencil.circle"
        }
    }
}

/// M20 (docs/M20-MODES.md): the plan a plan-mode turn proposed, sticky above the composer until it is answered.
/// "Approve & run" leaves plan mode into `default` — into `auto` when the chat came from auto mode (wave6 w6-terminal,
/// §44.1) — (the menu offers `acceptEdits`); "Keep planning" — or Esc while the
/// card itself holds the focus (polish-01: never from the composer, the find bar, a side question or the note field) —
/// keeps plan mode and sends the optional note back. Typing a normal message instead supersedes the plan:
/// the engine clears `pendingPlan` and this card disappears.
struct PlanCard: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store   // MARK: wave5 w5-fixes — §43.5: '왜?' on a step
    let plan: PendingPlan
    /// §19.5: a turn runs / collects / reverts or the previous answer is on its way — the buttons wait.
    var isLocked = false
    /// Why the last answer was refused (`gate_closed:*`, `plan_followup_failed`), localized.
    var refusal: String?
    var onApprove: (PermissionMode) -> Void = { _ in }
    var onKeepPlanning: (String?) -> Void = { _ in }
    /// Hands the keyboard back to the composer after an answer given while the card held it (the card goes away).
    var onFocusComposer: () -> Void = {}
    // MARK: wave4d w4d-plan — §42.1: the plan at full size with per-step notes; implement in a new chat / workbench
    /// Why the new chat / workbench items cannot be used (nil: they can).
    var handoffBlocker: String?
    var onApproveNewChat: (PermissionMode) -> Void = { _ in }
    var onApproveWorkbench: (PermissionMode) -> Void = { _ in }
    /// The notes live in the chat column (`TranscriptViewState.planDraft`): the card leaves the view while another chat
    /// tab is shown, and what was typed is still there on return.
    @Binding var stepNotes: [Int: String]
    @Binding var note: String
    @State private var showReview = false
    // wave1 mac-perms (polish-01)
    @FocusState private var cardFocused: Bool
    @FocusState private var noteFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.clipboard").foregroundStyle(.blue)
                Text("Plan proposed").font(.headline)
                if let path = plan.path {
                    Text(verbatim: (path as NSString).lastPathComponent)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .help(path)
                }
                Spacer()
            }
            // polish-01: the title row is the card's focus handle (no button in it): click it (or Tab to it) and Esc keeps
            // planning — never from the composer, the find bar, a side question or the note field.
            .contentShape(Rectangle())
            .focusable(!isLocked, interactions: .edit)
            .focused($cardFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { press in
                guard !isLocked, !noteFocused, let key = CardShortcutKey(press),
                      CardShortcuts.action(for: key, focus: .planCard, target: nil) == .keepPlanning else { return .ignored }
                keepPlanning()
                onFocusComposer()
                return .handled
            }
            .help(isLocked ? "" : String(localized: "Click here, then esc keeps planning"))
            // wave4d w4d-plan (§42.1): a short preview; the whole plan with per-step notes opens in its own sheet.
            ScrollView {
                MarkdownText(text: plan.plan)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 150)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            HStack(spacing: 8) {
                Button {
                    showReview = true
                } label: {
                    Label("View large", systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .controlSize(.small)
                .help("Opens the whole plan with a note field for each step")
                .accessibilityIdentifier("Plan view large")
                if let steps = plan.steps, !steps.isEmpty {
                    Text("\(steps.count) steps").font(.caption).foregroundStyle(.secondary)
                }
                let noted = PlanReviewNotes.noteCount(stepNotes)
                if noted > 0 {
                    TagChip(Text("\(noted) step notes"), systemImage: "text.bubble", tint: .orange)
                }
                Spacer()
            }
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Plan refusal")
            }
            TextField("Note for the next revision (optional)", text: $note)
                .textFieldStyle(.roundedBorder)
                .focused($noteFocused)
                .accessibilityLabel("Plan note")
                .accessibilityIdentifier("Plan note")
            HStack {
                Text("Sending a normal message instead supersedes the plan.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Keep planning") { answer(keepPlanning) }
                    .disabled(isLocked)
                    .help("Stay in plan mode and send your note back for a revision (esc while this card is focused)")
                    .accessibilityLabel("Keep planning")
                    .accessibilityIdentifier("Keep planning")
                PlanApproveMenu(isLocked: isLocked, handoffBlocker: handoffBlocker,
                                runMode: store.planApproveMode,   // wave6 w6-terminal (§44.1): back to auto from an auto chat
                                onApprove: { mode in answer { onApprove(mode) } },
                                onApproveNewChat: { mode in answer { onApproveNewChat(mode) } },
                                onApproveWorkbench: { mode in onApproveWorkbench(mode) })
            }
        }
        .sheet(isPresented: $showReview) {
            PlanReviewSheet(plan: plan, isLocked: isLocked, refusal: refusal, handoffBlocker: handoffBlocker,
                            notes: $stepNotes, general: $note,
                            onApprove: { onApprove($0) },
                            onApproveNewChat: { onApproveNewChat($0) },
                            onApproveWorkbench: { onApproveWorkbench($0) },
                            onKeepPlanning: { keepPlanning() },
                            onAskWhy: store.side.isSupported ? { step in   // MARK: wave5 w5-fixes — §43.5
                                let why = WhyQuestions.planStep(number: step.index + 1, text: step.text)
                                store.side.askNow(anchor: why.anchor, question: why.question)
                            } : nil,
                            runMode: store.planApproveMode)   // wave6 w6-terminal (§44.1)
        }
        .padding(12)
        .background(Color.blue.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(cardFocused ? Color.accentColor.opacity(0.95) : Color.blue.wash(colorScheme, light: 0.55, dark: 0.65),
                                                             lineWidth: cardFocused ? 2.5 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Plan card")
    }

    /// An answer by click; when the card held the keyboard (its title was clicked), it goes back to the composer.
    private func answer(_ action: () -> Void) {
        let hadFocus = cardFocused
        action()
        if hadFocus { onFocusComposer() }
    }

    private func keepPlanning() {
        // wave4d w4d-plan (§42.1): the step notes as "단계 N (…): …" lines, then the general note.
        let text = PlanReviewNotes.message(steps: plan.steps ?? [], notes: stepNotes, general: note)
        note = ""
        stepNotes = [:]
        onKeepPlanning(text)
    }
}

/// The composer's compact mode picker: the current mode as a menu button, every mode with its one-line help.
/// wave4b w4b-auto (§39.5): while Claude works a pick waits for the turn to end (the engine refuses `set_permission_mode`
/// with `session_busy` then) and the label shows it ("기본 → 자동"); a refused switch says why in the tooltip.
struct PermissionModePicker: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Menu {
            PermissionModeMenuItems()
        } label: {
            Label(PermissionModeLabels.title(store), systemImage: (store.scheduledPermissionMode ?? store.permissionMode).symbolName)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(!store.canPickPermissionMode)
        .help(PermissionModeLabels.help(store))
        .accessibilityLabel("Permission mode")
        .accessibilityIdentifier("Permission mode")
    }
}
