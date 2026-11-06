import SwiftUI
import ReviewGateCore

/// A tool waiting for the user's decision (docs/PROTOCOL.md §33): who asks (the main agent / "🧩 executor · compile"),
/// the call, why it is on a card when it works outside this window's review (`reason`, red / orange), a one-line risk
/// summary, and the answers — allow once, for the session, always in this project (Bash: a derived program+subcommand
/// pattern; MCP / WebFetch: the engine's `allowPatterns`, a menu when there are several; always shown before it is
/// saved), deny, or deny with an instruction Claude receives as the reason. SendMessage gets its own layout: the
/// receiving session, the summary and the body, with [보내기] / [거절] only.
///
/// Every card answers its own request. ⌘↩ / ⌥⌘↩ / ⌘⌫ answer the oldest open card from the composer (that card draws the
/// accent ring), or this card while it holds the keyboard focus (click its title or Tab to it) — never from another
/// input (polish-01). A card whose request left the queue without an answer from here (the engine answered it, the call was
/// withdrawn, the turn ended) reads "처리됨" and has no buttons.
struct PermissionCard: View {
    @Environment(\.colorScheme) private var colorScheme
    let request: PermissionRequest
    /// This client's decision; nil while open, and after the request left the queue without one ("처리됨").
    let decision: Bool?
    /// The request is still in the engine's queue (`AppState.isPermissionOpen`).
    var isOpen = true
    /// The composer's ⌘↩ / ⌥⌘↩ / ⌘⌫ answer this card (the oldest open one).
    var isShortcutTarget = false
    /// How many cards are open: the "단축키 대상" chip only matters with more than one.
    var openCount = 1
    var projectRoot: String?
    /// §29: "{fromNames} 요청" while the running turn is accepted peer messages.
    var peerBadge: String?
    /// The workbench a `reason.path` names: [워크벤치로 열기].
    var workbenchPath: String?
    /// Briefly highlighted after "카드로 이동".
    var flashing = false
    var onAllow: () -> Void = {}
    /// M16: allow and remember this tool + command prefix for the rest of the session.
    var onAllowForSession: () -> Void = {}
    /// Saves the pattern for this project, then allows.
    var onAlwaysAllow: (String) -> Void = { _ in }
    /// `nil` = plain deny; otherwise the instruction sent as the deny message.
    var onDeny: (String?) -> Void = { _ in }
    /// §21: "Why is this needed?" — a side question about this call (nil hides it).
    var onAskWhy: (() -> Void)?
    /// Opens the workbench of `workbenchPath` in its own window.
    var onOpenWorkbench: ((String) -> Void)?
    /// Hands the keyboard back to the composer after an answer given while the card held it, or Esc.
    var onFocusComposer: () -> Void = {}
    // MARK: wave4b w4b-follow
    /// §39.4 "허용하고 따라가기" on a worktree-creating command (nil hides it): allowed, then the chat moves there.
    var onAllowAndFollow: (() -> Void)?
    /// "Deny with instruction…" text, kept in the chat column (`TranscriptViewState.denyInstructions`): a look at another
    /// chat tab does not lose it, and the field is open again on return.
    @Binding var instruction: String

    private enum Expansion: Equatable { case none, denyWithInstruction, alwaysAllow(String) }
    @State private var expansion: Expansion = .none
    @FocusState private var instructionFocused: Bool
    @FocusState private var cardFocused: Bool

    private var options: PermissionCardOptions { PermissionCardOptions(request: request) }
    private var isSendMessage: Bool { options.layout == .sendMessage }
    private var isPending: Bool { decision == nil && isOpen }
    private var isHandled: Bool { decision == nil && !isOpen }
    private var commandText: String? { request.input["command"]?.stringValue }
    private var risk: CommandRisk { CommandRisk.assess(request, projectRoot: projectRoot) }
    /// Shortcut hints only where the keys act: the composer's target, or the card holding the focus.
    private var showsShortcuts: Bool { isPending && (isShortcutTarget || cardFocused) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerArea
            if isSendMessage { sendMessageContent } else { callContent }
            if isPending {
                if let reason = request.reason { reasonLine(reason) }
                if PermissionCardOptions.showsRiskLine(request, risk: risk) { riskLine }   // wave2 check-clients
                switch expansion {
                case .none: buttons
                case .denyWithInstruction: denyEditor
                case let .alwaysAllow(pattern): alwaysAllowConfirmation(pattern)
                }
            } else if isHandled {
                Label("Handled elsewhere — answered by a rule, withdrawn, or the turn ended", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("Permission handled")
            }
        }
        .padding(12)
        .background(fill, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(border, lineWidth: borderWidth))
        .overlay {
            if flashing {
                RoundedRectangle(cornerRadius: 10).strokeBorder(Color.yellow.opacity(0.9), lineWidth: 2).padding(-3)
            }
        }
        .onChange(of: isPending) { _, pending in if !pending { expansion = .none; instruction = "" } }
        .onAppear { if isPending, !instruction.isEmpty { expansion = .denyWithInstruction } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Permission: \(request.toolName)"))
        .accessibilityIdentifier(isPending ? "Permission card" : (isHandled ? "Permission card handled" : "Permission card decided"))
    }

    // MARK: Surface

    private var fill: Color {
        if isHandled { return Color.secondary.wash(colorScheme, light: 0.05, dark: 0.08) }
        return Color.orange.wash(colorScheme, light: isPending ? 0.12 : 0.05, dark: isPending ? 0.20 : 0.10)
    }

    private var border: Color {
        if isPending, cardFocused || isShortcutTarget { return Color.accentColor.opacity(cardFocused ? 0.95 : 0.75) }
        if isHandled { return Color.secondary.wash(colorScheme, light: 0.25, dark: 0.35) }
        return Color.orange.wash(colorScheme, light: isPending ? 0.60 : 0.20, dark: isPending ? 0.70 : 0.30)
    }

    private var borderWidth: CGFloat {
        guard isPending else { return 1 }
        return cardFocused ? 2.5 : (isShortcutTarget ? 2 : 1)
    }

    // MARK: Header

    /// The title and the chips are the card's focus handle (polish-01): click them (or Tab to them) and ⌘↩ / ⌥⌘↩ / ⌘⌫
    /// answer this card. The handle holds no button, so taking the focus never gets in the way of a click.
    private var headerArea: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 8) {
                titleRow
                chips
            }
            .contentShape(Rectangle())
            .focusable(isPending, interactions: .edit)
            .focused($cardFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { handleKey($0) }
            .help(isPending ? keyboardHelp : "")
            if isPending, !isSendMessage, let onAskWhy {
                Button(action: onAskWhy) {
                    Label("Why is this needed?", systemImage: "questionmark.bubble")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.teal)
                .help("Ask in a side question while the card waits — the main conversation is not affected")
                .accessibilityIdentifier("Permission ask why")
            }
        }
    }

    private var keyboardHelp: String {
        isSendMessage
            ? String(localized: "Click here to answer from the keyboard: ⌘↩ send · ⌘⌫ decline · esc back to the message box")
            : String(localized: "Click here to answer from the keyboard: ⌘↩ allow · ⌥⌘↩ for the session · ⌘⌫ deny · esc back to the message box")
    }

    private var titleRow: some View {
        HStack(spacing: 6) {
            Image(systemName: isSendMessage ? "paperplane.fill" : "hand.raised.fill")
                .foregroundStyle(isPending ? Color.orange : Color.secondary)
            Group {
                // wave4b w4b-agents (§39.3): an MCP / Skill call by its readable name ("github · get issue · 4821").
                if isSendMessage { Text("Send a message to another session") } else { Text("Permission: \(AgentGlance.callTitle(request.toolName, input: request.input))").help(request.toolName) }
            }
            .font(.headline)
            .foregroundStyle(isHandled ? Color.secondary : Color.primary)
            .lineLimit(1)
            .truncationMode(.middle)
            Spacer(minLength: 4)
            if let decision {
                Group {
                    if isSendMessage { Text(decision ? "Sent" : "Not sent") } else { Text(decision ? "Allowed" : "Denied") }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(decision ? Color.green : Color.red)
            } else if isHandled {
                Text("Handled")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Who asks (§33.1), the peer turn it runs in (§29), and which card the composer's keys answer.
    private var chips: some View {
        HStack(spacing: 6) {
            TagChip(Text(verbatim: PermissionAgentLabel.text(request.agent)),
                    systemImage: request.agent == nil ? "person.fill" : nil,
                    tint: request.agent == nil ? .secondary : .blue)
                .help(request.agent.map { String(localized: "A subagent asks (agent id \($0.agentId))") } ?? String(localized: "The main agent asks"))
                .accessibilityIdentifier("Permission agent chip")
            if let peerBadge {
                TagChip(Text(verbatim: peerBadge), systemImage: "bubble.left.and.bubble.right.fill", tint: .purple)
                    .help("This turn runs a message another Claude session sent — the names are what the sender claims")
                    .accessibilityIdentifier("Permission peer badge")
            }
            if isPending, isShortcutTarget, openCount > 1 {
                TagChip(Text("Shortcut target"), systemImage: "keyboard", tint: .accentColor)
                    .help("⌘↩ / ⌥⌘↩ / ⌘⌫ in the message box answer this card — the one that has waited longest")
                    .accessibilityIdentifier("Permission shortcut target")
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Content

    @ViewBuilder
    private var callContent: some View {
        if let file = request.file {
            Text(file).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        ScrollView(.horizontal) {
            Text(commandText ?? request.input.prettyPrinted)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(8)
        }
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        .frame(maxHeight: 220)
        .opacity(isHandled ? 0.7 : 1)
    }

    /// §33.2: who receives it, the summary and the body — large and scrollable, the thing actually being approved.
    private var sendMessageContent: some View {
        let content = SendMessageCardContent(request: request)
        return VStack(alignment: .leading, spacing: 6) {
            // MARK: wave4d w4d-peers — §42.2: the session's registry name, not its socket path; where it runs below.
            Text("Receiving session: \(PeerSessionText.recipientTitle(content))")
                .font(.callout.weight(.semibold))
                .textSelection(.enabled)
                .accessibilityIdentifier("SendMessage recipient")
            PeerRecipientDetail(content: content)
            if let summary = content.summary {
                Text("Summary: \(summary)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                Text(verbatim: content.message.isEmpty ? "—" : content.message)
                    .font(content.isStructured ? .system(.callout, design: .monospaced) : .body)   // wave2 check-clients: JSON
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(minHeight: 60, maxHeight: 260)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .opacity(isHandled ? 0.7 : 1)
            .accessibilityIdentifier("SendMessage body")
        }
    }

    /// §33.3 / §33.4: where the call works that this window's review does not see; with [워크벤치로 열기] when that
    /// place is a workbench of this repository.
    private func reasonLine(_ reason: PermissionReason) -> some View {
        let danger = PermissionReasonText.level(reason) == .danger
        return VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(verbatim: PermissionReasonText.line(reason)).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: danger ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(danger ? Color.red : Color.orange)
            .help(reason.path ?? reason.message)
            .accessibilityIdentifier("Permission reason")
            if let workbenchPath, let onOpenWorkbench {
                Button { onOpenWorkbench(workbenchPath) } label: {
                    Label("Open as workbench", systemImage: "macwindow.badge.plus")
                }
                .controlSize(.small)
                .help("Opens that worktree in its own ReviewGate window, where its changes are reviewed")
                .accessibilityIdentifier("Permission open workbench")
            }
        }
    }

    private var riskLine: some View {
        let risk = risk
        return Label {
            Text(verbatim: risk.summary)
        } icon: {
            Image(systemName: risk.symbol)
        }
        .font(.callout.weight(risk.isEmpty ? .regular : .semibold))
        .foregroundStyle(risk.isEmpty ? Color.secondary : (risk.kinds.contains(.deletion) || risk.kinds.contains(.gitHistory) ? Color.red : Color.orange))
        .help(Text("A quick client-side check of the command; ReviewGate's review gate still applies to every file change."))
        .accessibilityIdentifier("Permission risk")
    }

    // MARK: Answers

    /// FullOrCompact, not ViewThatFits: the buttons and the always-allow menu are AppKit views it would rebuild every pass.
    private var buttons: some View {
        FullOrCompact { _ in
            HStack(spacing: 8) {
                denyButtons
                Spacer(minLength: 8)
                allowButtons
            }
        } compact: {
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 8) { denyButtons; Spacer(minLength: 0) }
                HStack(spacing: 8) { Spacer(minLength: 0); allowButtons }
            }
        }
    }

    @ViewBuilder
    private var denyButtons: some View {
        Button(role: .destructive) { answer { onDeny(nil) } } label: {
            ShortcutLabel(title: isSendMessage ? "Decline" : "Deny", shortcut: showsShortcuts ? "⌘⌫" : nil)
        }
        .help(isSendMessage ? Text("Do not send this message (⌘⌫ with an empty message box)") : Text("Deny this call (⌘⌫ with an empty message box)"))
        .accessibilityLabel(isSendMessage ? Text("Decline") : Text("Deny"))
        .accessibilityIdentifier("Deny")
        if !isSendMessage {
            Button("Deny with instruction…") {
                expansion = .denyWithInstruction
                instructionFocused = true
            }
            .help("Deny and tell Claude what to do instead; the text is sent as the reason")
            .accessibilityIdentifier("Deny with instruction")
        }
    }

    @ViewBuilder
    private var allowButtons: some View {
        if isSendMessage {
            Button { answer(onAllow) } label: {
                ShortcutLabel(title: "Send", shortcut: showsShortcuts ? "⌘↩" : nil)
            }
            .buttonStyle(.borderedProminent)
            .help("Send this message to the other session (⌘↩ with an empty message box)")
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("Send message")
        } else {
            if options.showsAlwaysAllow { alwaysAllowControl }
            if options.allowsRemember {
                Button { answer(onAllowForSession) } label: {
                    ShortcutLabel(title: "Allow for session", shortcut: showsShortcuts ? "⌥⌘↩" : nil)
                }
                .help("Allow this and auto-allow the same tool and command prefix until the session ends (⌥⌘↩)")
                .accessibilityLabel("Allow for session")
                .accessibilityIdentifier("Allow for session")
            }
            if let onAllowAndFollow {   // wave4b w4b-follow (§39.4)
                Button { answer(onAllowAndFollow) } label: {
                    Label(ChatMoveText.allowAndFollowTitle, systemImage: "arrow.right.square")
                }
                .help(ChatMoveText.allowAndFollowHelp)
                .accessibilityIdentifier("Allow and follow")
            }
            Button { answer(onAllow) } label: {
                ShortcutLabel(title: "Allow once", shortcut: showsShortcuts ? "⌘↩" : nil)
            }
            .buttonStyle(.borderedProminent)
            // r1-git (§46): a card with a reason says why it is one call at a time (⌥⌘↩ allows nothing more there).
            .help(PermissionCardOptions.onceOnlyHelp(request).map { Text(verbatim: $0) } ?? Text("Allow this call only (⌘↩ with an empty message box)"))
            .accessibilityLabel("Allow")
            .accessibilityIdentifier("Allow")
        }
    }

    /// One candidate: a button that shows it before saving; several (an MCP tool / its whole server): a menu.
    @ViewBuilder
    private var alwaysAllowControl: some View {
        let patterns = options.alwaysAllowPatterns
        if patterns.count > 1 {
            Menu {
                ForEach(patterns, id: \.self) { pattern in
                    Button { expansion = .alwaysAllow(pattern) } label: { Text(verbatim: AllowPatternLabel.text(pattern)) }
                        .help(pattern)
                }
            } label: {
                Text("Always allow in this project")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Choose what this project allows from now on; you see it before it is saved")
            .accessibilityIdentifier("Always allow in project")
        } else {
            Button("Always allow in project…") {
                if let pattern = patterns.first { expansion = .alwaysAllow(pattern) }
            }
            .disabled(patterns.isEmpty)
            .help(patterns.isEmpty
                  ? Text("No safe pattern for this command (a chain, redirection, wrapper such as sudo / sh -c, or quoting)")
                  : Text("Save an allow pattern for this project; you see it before it is saved"))
            .accessibilityIdentifier("Always allow in project")
        }
    }

    private var denyEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("What should Claude do instead?", text: $instruction, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .focused($instructionFocused)
                .onSubmit(sendDeny)
                .onExitCommand { expansion = .none }
                .accessibilityIdentifier("Deny instruction")
            HStack {
                Text("Claude gets this as the reason the call was denied.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { expansion = .none }
                Button("Deny and send", role: .destructive, action: sendDeny)
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("Deny and send")
            }
        }
    }

    private func sendDeny() {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        answer { onDeny(text) }
    }

    /// The pattern exactly as it will be saved, with its meaning, before anything is stored.
    private func alwaysAllowConfirmation(_ pattern: String) -> some View {
        let label = AllowPatternLabel.text(pattern)
        let kind = AllowPatternLabel.kind(pattern)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Pattern").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(verbatim: pattern)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 4))
                    .accessibilityIdentifier("Allow pattern preview")
                if label != pattern {
                    Text(verbatim: label).font(.caption).foregroundStyle(.secondary)
                }
            }
            Group {
                switch kind {
                case .bash:
                    Text("Applies only to simple commands in this project — a chain, pipe, redirection or $(…) still asks. Remove it in Settings → General → Permissions.")
                case .mcpServer:
                    Text("Every tool of this MCP server runs without asking in this project — writing tools too. Remove it in Settings → General → Permissions.")
                case .mcpTool, .webFetchDomain, .other:
                    Text("Runs without asking in this project from now on. Remove it in Settings → General → Permissions.")
                }
            }
            .font(.caption).foregroundStyle(kind == .mcpServer ? Color.orange : Color.secondary)
            .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { expansion = .none }
                Button("Save and allow") { answer { onAlwaysAllow(pattern) } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("Save pattern and allow")
            }
        }
    }

    /// An answer from this card; when the card held the keyboard (its handle was clicked), it goes back to the composer.
    private func answer(_ action: () -> Void) {
        let hadFocus = cardFocused
        action()
        if hadFocus { onFocusComposer() }
    }

    // MARK: Keys (polish-01)

    /// ⌘↩ / ⌥⌘↩ / ⌘⌫ / Esc while this card holds the focus — not while its instruction field does.
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        guard isPending, !instructionFocused, let key = CardShortcutKey(press) else { return .ignored }
        switch CardShortcuts.action(for: key, focus: .permissionCard(requestId: request.requestId), target: isOpen ? request : nil) {
        case .allowOnce: onAllow()
        case .allowForSession: onAllowForSession()
        case .deny: onDeny(nil)
        case .focusComposer: break
        default: return .ignored
        }
        onFocusComposer()
        return .handled
    }
}

/// "Allow once  ⌘↩": the title plus a dimmed shortcut hint (only where the shortcut acts).
private struct ShortcutLabel: View {
    let title: LocalizedStringKey
    var shortcut: String?

    var body: some View {
        HStack(spacing: 5) {
            Text(title)
            if let shortcut {
                Text(verbatim: shortcut).font(.caption).opacity(0.65)
            }
        }
    }
}
