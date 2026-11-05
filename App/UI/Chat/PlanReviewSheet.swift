import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 (market-08)

/// The proposed plan at full size: the plan on the left, its steps with a note each on the right, and the same answers as the
/// card — [계속 계획] sends the notes as "단계 N (…): …" lines, the approve menu also implements in a new chat or workbench.
struct PlanReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    let plan: PendingPlan
    var isLocked: Bool
    var refusal: String?
    /// Why the new chat / workbench items cannot be used (nil: they can).
    var handoffBlocker: String?
    @Binding var notes: [Int: String]
    @Binding var general: String
    var onApprove: (PermissionMode) -> Void
    var onApproveNewChat: (PermissionMode) -> Void
    var onApproveWorkbench: (PermissionMode) -> Void
    var onKeepPlanning: () -> Void
    /// MARK: wave5 w5-fixes — §43.5: '왜?' on a step (a side question quoting it); nil without side questions.
    var onAskWhy: ((PlanStepBrief) -> Void)? = nil
    /// MARK: wave6 w6-terminal — §44.1: the mode "Approve & run" goes to (`AppState.planApproveMode`).
    var runMode: PermissionMode = .default

    private var steps: [PlanStepBrief] { plan.steps ?? [] }
    private var noteCount: Int { PlanReviewNotes.noteCount(notes) + (general.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    MarkdownText(text: plan.plan)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .textSelection(.enabled)
                }
                .frame(minWidth: 380, maxWidth: .infinity)
                .background(Color(nsColor: .textBackgroundColor))
                .accessibilityIdentifier("Plan review text")
                Divider()
                notesColumn
                    .frame(minWidth: 320, idealWidth: 380, maxWidth: 460)
            }
            Divider()
            footer
        }
        .frame(minWidth: 860, idealWidth: 1040, minHeight: 600, idealHeight: 760)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Plan review")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "list.bullet.clipboard").foregroundStyle(.blue)
            Text("Review the plan").font(.title3.weight(.semibold))
            if let path = plan.path {
                Text(verbatim: (path as NSString).lastPathComponent)
                    .font(.callout.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .help(path)
            }
            Spacer()
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .help("Close — your notes stay on the card until you answer")
        }
        .padding(12)
    }

    private var notesColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Notes per step").font(.headline)
            Text("A note goes back with “Keep planning” as “Step N (…): …”. Steps without a note are left as they are.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if steps.isEmpty {
                        Text("This plan has no numbered steps — write your note below.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(steps) { step in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(verbatim: "\(step.index + 1). \(step.text)")
                                    .font(.callout.weight(.medium))
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 4)
                                // MARK: wave5 w5-fixes — §43.5: the side panel is the window's, so the sheet closes first
                                // (the notes stay on the card).
                                if let onAskWhy {
                                    Button("Why?") {
                                        dismiss()
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { onAskWhy(step) }
                                    }
                                    .buttonStyle(.link)
                                    .font(.caption)
                                    .help("Ask Claude why this step is in the plan (side question) — your notes stay on the card")
                                    .accessibilityLabel(Text("Ask why step \(step.index + 1) is in the plan"))
                                    .accessibilityIdentifier("Plan step why \(step.index + 1)")
                                }
                            }
                            TextField("Note for this step (optional)", text: binding(step.index), axis: .vertical)
                                .lineLimit(1...4)
                                .textFieldStyle(.roundedBorder)
                                .disabled(isLocked)
                                .accessibilityLabel(Text("Note for step \(step.index + 1)"))
                                .accessibilityIdentifier("Plan step note \(step.index + 1)")
                        }
                        .padding(8)
                        .background((notes[step.index]?.isEmpty == false ? Color.orange : Color.secondary).wash(colorScheme, light: 0.07, dark: 0.14),
                                    in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                .padding(.vertical, 2)
            }
            Text("Note for the whole plan").font(.subheadline.weight(.semibold))
            TextField("Note for the next revision (optional)", text: $general, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.roundedBorder)
                .disabled(isLocked)
                .accessibilityIdentifier("Plan review note")
        }
        .padding(12)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.orange)
                    .lineLimit(2)
                    .accessibilityIdentifier("Plan review refusal")
            } else {
                Text("Approving runs the plan as normal turns — every file it changes still goes through the review.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(noteCount > 0 ? String(localized: "Keep planning (\(noteCount) notes)") : String(localized: "Keep planning")) {
                onKeepPlanning()
                dismiss()
            }
            .disabled(isLocked)
            .help("Stay in plan mode and send your notes back for a revision")
            .accessibilityIdentifier("Plan review keep planning")
            PlanApproveMenu(isLocked: isLocked, handoffBlocker: handoffBlocker, runMode: runMode,   // wave6 w6-terminal (§44.1)
                            onApprove: { onApprove($0); dismiss() },
                            onApproveNewChat: { onApproveNewChat($0); dismiss() },
                            onApproveWorkbench: { mode in
                                // The New Workbench sheet is the window's: it can only come up once this one is gone.
                                dismiss()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { onApproveWorkbench(mode) }
                            })
        }
        .padding(12)
    }

    private func binding(_ index: Int) -> Binding<String> {
        Binding(get: { notes[index] ?? "" }, set: { notes[index] = $0 })
    }
}

/// "Approve & run" with its menu: auto-accept edits, implement in a new chat, implement in a new workbench (§42.1).
/// MARK: wave6 w6-terminal — §44.1: `runMode` is where "Approve & run" (and the new chat / workbench) go — auto when the
/// chat came from auto mode (`AppState.planApproveMode`), else default as before.
struct PlanApproveMenu: View {
    var isLocked: Bool
    var handoffBlocker: String?
    var runMode: PermissionMode = .default
    var onApprove: (PermissionMode) -> Void
    var onApproveNewChat: (PermissionMode) -> Void
    var onApproveWorkbench: (PermissionMode) -> Void

    var body: some View {
        Menu {
            Button("Approve & auto-accept edits") { onApprove(.acceptEdits) }
                .help("Leaves plan mode into Accept edits: edit tools are approved automatically")
                .accessibilityIdentifier("Approve plan accept edits")
            Divider()
            // wave6 w6-terminal (§44.1): the new chat / workbench starts in `runMode` too — the label says when it is auto.
            Button(runMode == .auto ? String(localized: "Implement in a new chat (auto mode)") : String(localized: "Implement in a new chat")) {
                onApproveNewChat(runMode)
            }
                .disabled(handoffBlocker != nil)
                .help(handoffBlocker ?? String(localized: "A fresh chat in this workbench gets only the plan file — the long research conversation is not carried on"))
                .accessibilityIdentifier("Approve plan new chat")
            Button(runMode == .auto ? String(localized: "Implement in a new workbench… (auto mode)") : String(localized: "Implement in a new workbench…")) {
                onApproveWorkbench(runMode)
            }
                .disabled(handoffBlocker != nil)
                .help(handoffBlocker ?? String(localized: "Create a workbench (branch + folder); its window implements the plan in a fresh chat"))
                .accessibilityIdentifier("Approve plan new workbench")
            if let handoffBlocker {
                Text(verbatim: handoffBlocker)
            }
        } label: {
            if runMode == .auto {
                Text("Approve & run in auto mode")
            } else {
                Text("Approve & run")
            }
        } primaryAction: {
            onApprove(runMode)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(isLocked)
        .help(runMode == .auto ? String(localized: "Leaves plan mode back into auto mode and asks Claude to implement the plan")
              : String(localized: "Leaves plan mode and asks Claude to implement the plan"))
        .accessibilityLabel("Approve plan")
        .accessibilityIdentifier("Approve plan")
    }
}
