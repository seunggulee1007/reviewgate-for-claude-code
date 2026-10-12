import SwiftUI
import ReviewGateCore

/// One-line status bar between the transcript and the composer: model, context usage, session cost,
/// turn timing, current activity, change budget and a pending-permission flag (docs/M7-API.md `HUDState`).
struct HUDStrip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// M16: the "N auto-allowed" chip's popover (list + Forget).
    @State private var showRemembered = false
    /// §27: the context meter's popover (details + compact).
    @State private var showContext = false
    @Environment(WindowModel.self) private var model

    private var hud: HUDState { store.hud }

    var body: some View {
        // A narrow chat pane (agent panel open, small window) drops the model, cost and turn items rather than
        // pushing the agents chip and the budget off the edge. Not ViewThatFits: it rebuilt the mode chip's NSPopUpButton
        // on every layout pass and the app hung (FullOrCompact).
        FullOrCompact { measuring in
            strip(compact: false, measuring: measuring)
        } compact: {
            strip(compact: true, measuring: false)
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("HUD")
    }

    /// `measuring`: the hidden copy FullOrCompact sizes — its popovers never open (they belong to the strip on screen).
    private func strip(compact: Bool, measuring: Bool) -> some View {
        // Numbers keep their full width (priority 1); the model name and activity text truncate first.
        HStack(spacing: 8) {
            if store.projectInfo != nil {
                ModelChip().layoutPriority(compact ? 0 : 1)
            }
            contextItem(compact: compact, measuring: measuring).fixedSize().layoutPriority(1)
            Text(verbatim: "·").foregroundStyle(.quaternary)
            if !compact {
                // MARK: wave4d w4d-agents2 — §42.4: the cost opens the split by model (was a plain text).
                HUDCostButton()
                    .fixedSize().layoutPriority(1)
                if hud.sideCostUSD > 0 {
                    // §21: side questions are billed on their own, never inside the session cost.
                    Button {
                        store.side.present()
                    } label: {
                        Text("Side \(SideQuestionText.cost(hud.sideCostUSD))")
                            .foregroundStyle(Color.teal)
                    }
                    .buttonStyle(.plain)
                    .fixedSize().layoutPriority(1)
                    .help("Side questions in this session: \(String(format: "$%.4f", hud.sideCostUSD)) — not part of the session cost")
                    .accessibilityIdentifier("HUD side cost")
                }
                Text(verbatim: "·").foregroundStyle(.quaternary)
                turnItem.fixedSize().layoutPriority(1)
                Text(verbatim: "·").foregroundStyle(.quaternary)
            }
            activityItem(measuring: measuring)
            LiveChangesChip()   // wave2 mac-flow (§34.6): "진행 중: 파일 N개 · +A −D" → the list
            if let notice = store.transientNotice {
                transientChip(notice)
            }
            SessionStartingChip()   // wave1 mac-session (§30: "Claude Code 시작 중…")
            ExtensionsWaitingChip()   // wave3 mac-session (§36.7): "serena 기다리는 중" while the CLI starts
            Spacer(minLength: 4)
            ExtensionsOffChip()   // wave3 mac-session (§36.7): "확장 꺼짐" after the init-timeout fallback
            UsageLimitChip()   // wave4 w4-longwork (§38.2): "사용량 한도 — 15:00에 풀려요" / "5시간 72% · 주간 41%"
            DiskSpaceChip()   // wave4b w4b-bigturn (§39.1): "디스크 여유 1.2 GB" below 2 GB free
            if !store.agents.isEmpty {
                agentsChip
            }
            if store.pendingPermission != nil {
                PermissionPendingChip()   // wave1 mac-perms: "권한 요청 N개 대기" from two on; click → the oldest card
            }
            PeerTurnChip()   // wave1 mac-perms: "{fromNames} 요청" (§29)
            if store.permissionMode != .default || store.scheduledPermissionMode != nil {   // wave4b w4b-auto: a pick waiting too
                modeBadge
            }
            if !store.rememberedAllows.isEmpty {
                rememberedChip(measuring: measuring)
            }
            BudgetBadge(usage: store.budgetUsage, budget: store.budget)
                .fixedSize().layoutPriority(1)
        }
    }

    // MARK: Items

    /// Subagents: "N agents running" (pulsing) while any is live, else the finished count; shows or hides the agent panel
    /// as View › Toggle Agent Panel (⌥⌘A) does.
    private var agentsChip: some View {
        let live = store.liveAgentCount
        let total = store.agents.count
        let tint: Color = live > 0 ? .blue : .secondary
        return Button {
            model.toggleAgentPanelTick += 1
        } label: {
            HStack(spacing: 3) {
                if live > 0 {
                    PulseDot(color: .blue, size: 5).frame(width: 9, height: 9)
                } else {
                    Image(systemName: "person.2")
                }
                ViewThatFits(in: .horizontal) {
                    Group {
                        if live > 0 { Text("\(live) agents running") } else { Text("\(total) agents") }
                    }
                    .fixedSize()
                    Text(verbatim: String(live > 0 ? live : total)).fixedSize()
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(tint.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .fixedSize().layoutPriority(1)
        .help("Show or hide the agent activity panel (⌥⌘A)")
        .contextMenu { HUDAgentDetailItems() }   // wave3 mac-agents (§36.1): each agent's "Agent details"
        .accessibilityLabel(live > 0 ? String(localized: "\(live) agents running") : String(localized: "\(total) agents"))
        .accessibilityIdentifier("HUD agents")
    }

    /// §19.6: "재시도 중 (2/10)…" while the CLI retries the API by itself, or the slow-start hint — goes away on its own.
    private func transientChip(_ notice: TransientNotice) -> some View {
        HStack(spacing: 4) {
            if notice.kind == .retrying {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "hourglass")
            }
            Text(verbatim: notice.text).lineLimit(1).truncationMode(.tail)
        }
        .padding(.horizontal, 6).padding(.vertical, 1)
        .background(Color.orange.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
        .foregroundStyle(.orange)
        .help(notice.text)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(notice.text)
        .accessibilityIdentifier(notice.kind == .retrying ? "HUD retrying" : "HUD slow start")
    }

    /// M20: the session's permission mode, shown only while it is not `default` (docs/M20-MODES.md).
    /// wave4b w4b-auto (§39.5): the chip is the mode menu — a click picks another mode (after the turn while Claude works).
    private var modeBadge: some View { HUDModeChip() }

    /// M16: what "Allow for session" remembered; the popover lists the prefixes and offers Forget (`forget_allows`).
    private func rememberedChip(measuring: Bool) -> some View {
        Button {
            showRemembered.toggle()
        } label: {
            // Narrow panes get the icon + count; the full label needs ~100 pt.
            ViewThatFits(in: .horizontal) {
                Label("\(store.rememberedAllows.count) auto-allowed", systemImage: "checkmark.shield").fixedSize()
                Label("\(store.rememberedAllows.count)", systemImage: "checkmark.shield").fixedSize()
            }
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Color.green.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
            .foregroundStyle(.green)
        }
        .buttonStyle(.plain)
        .help("Tools and command prefixes allowed for this session without asking")
        .accessibilityLabel("\(store.rememberedAllows.count) auto-allowed")
        .accessibilityIdentifier("HUD remembered")
        .popover(isPresented: measuring ? .constant(false) : $showRemembered, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Allowed for this session").font(.subheadline.weight(.semibold))
                ForEach(store.rememberedAllows, id: \.self) { entry in
                    Text(verbatim: entry).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                }
                Button("Forget") { store.forgetAllows(); showRemembered = false }
                    .controlSize(.small)
                    .help("Ask again for these tools and commands")
                    .accessibilityIdentifier("Forget allows")
            }
            .padding(12)
            .frame(width: 300, alignment: .leading)
            .accessibilityIdentifier("Remembered allows popover")
        }
    }

    private func contextItem(compact: Bool, measuring: Bool) -> some View {
        Button { showContext.toggle() } label: { contextLabel(compact: compact) }
            .buttonStyle(.plain)
            .disabled(store.projectInfo == nil)
            .help(contextHelp)
            .accessibilityIdentifier("HUD context")
            .popover(isPresented: measuring ? .constant(false) : $showContext, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Context").font(.headline)
                    Text(contextHelp).font(.callout).foregroundStyle(.secondary)
                    if let fraction = store.contextFraction {
                        ProgressView(value: fraction).tint(Self.contextColor(fraction))
                    }
                    Divider()
                    Text("Compact the conversation").font(.subheadline.weight(.semibold))
                    Text("Claude summarizes the conversation so far (/compact); the summary replaces the earlier messages in its context.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    CompactForm(onDone: { showContext = false })
                }
                .padding(14)
                .frame(width: 380)
                .accessibilityIdentifier("Context popover")
            }
    }

    private func contextLabel(compact: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "rectangle.stack").foregroundStyle(.tertiary)
            if let window = hud.contextWindow, window > 0 {
                let fraction = min(Double(hud.contextTokens) / Double(window), 1)
                if compact {
                    Text(verbatim: "\(Int((fraction * 100).rounded()))%")
                } else {
                    Text(verbatim: "\(Self.tokens(hud.contextTokens)) / \(Self.tokens(window)) (\(Int((fraction * 100).rounded()))%)")
                }
                ProgressView(value: fraction)
                    .progressViewStyle(.linear)
                    .tint(Self.contextColor(fraction))
                    .frame(width: 44)
                    .controlSize(.mini)
            } else {
                Text("\(Self.tokens(hud.contextTokens)) tokens")
            }
        }
        .foregroundStyle(store.contextFraction.map { ContextMeter.level($0) == .normal ? Color.secondary : Self.contextColor($0) } ?? .secondary)
    }

    private var contextHelp: String {
        if let window = hud.contextWindow {
            return String(localized: "Context: \(hud.contextTokens) of \(window) tokens")
        }
        return String(localized: "Context: \(hud.contextTokens) tokens (window unknown)")
    }

    @ViewBuilder
    private var turnItem: some View {
        if store.isRunning, let started = hud.turnStartedAt {
            TimelineView(.periodic(from: started, by: 1)) { context in
                let seconds = max(0, context.date.timeIntervalSince(started))
                Text("turn \(hud.turnCount + 1) · \(Self.seconds(seconds))")
            }
            .help("Turn \(hud.turnCount + 1) running for \(Int(Date().timeIntervalSince(started))) s")
            .accessibilityIdentifier("HUD turn")
        } else {
            Text("turn \(hud.turnCount) · \(Self.seconds(Double(hud.lastTurnMs) / 1000))")
                .help("\(hud.turnCount) turns; last turn took \(hud.lastTurnMs) ms")
                .accessibilityIdentifier("HUD turn")
        }
    }

    /// The activity's share of the full strip's measured width. Fixed: the measuring copy is `.fixedSize()`, so the running
    /// tool's text (and the spinner) would decide full vs compact, flip it with every change and rebuild the popovers and the
    /// mode menu. The strip on screen truncates the text to the room the chips leave (at least this much).
    private static let measuredActivityWidth: CGFloat = 120

    private func activityItem(measuring: Bool) -> some View {
        HStack(spacing: 5) {
            if store.isRunning {
                ProgressView().controlSize(.mini)
            }
            Text(activityText)
                .foregroundStyle(store.isRunning ? Color.primary : Color.secondary)
                .truncationMode(.middle)
        }
        .frame(width: measuring ? Self.measuredActivityWidth : nil, alignment: .leading)
        .help(activityText)
        .accessibilityIdentifier("HUD activity")
    }

    private var activityText: String {
        if !hud.activity.isEmpty { return hud.activity }
        return store.isRunning ? String(localized: "Working…") : String(localized: "Idle")
    }

    // MARK: Formatting

    /// §27: amber from 80 %, red from 95 % (where `context_warning` fires and compaction is due).
    static func contextColor(_ fraction: Double) -> Color {
        switch ContextMeter.level(fraction) {
        case .critical: .red
        case .warning: .orange
        case .normal: .green
        }
    }

    /// `950` → `950`, `12_345` → `12.3k`, `1_000_000` → `1M`, `1_500_000` → `1.5M`.
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return trim(Double(n) / 1_000_000) + "M" }
        if n >= 1_000 { return trim(Double(n) / 1_000) + "k" }
        return String(n)
    }

    private static func trim(_ v: Double) -> String {
        let s = String(format: "%.1f", v)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }

    static func usd(_ v: Double) -> String { String(format: "$%.2f", v) }

    static func seconds(_ s: Double) -> String {
        ElapsedFormat.text(seconds: s) // wave4 w4-input (polish-14): "3분 20초" in Korean
    }
}
