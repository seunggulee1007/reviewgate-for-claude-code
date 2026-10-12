import SwiftUI
import ReviewGateCore

// wave3 mac-agents — the chat's agent rows (docs/PROTOCOL.md §36.1, §36.3, §36.4): the report at the end of an agent's
// group, the SendMessage row that continues an agent, and the composer's "main is waiting" line.

/// §36.1: an Agent call's result at the end of its chat group — the report's first three lines as markdown and
/// "View full report" (the details sheet, scrolled to the report). A failed or stopped call shows what it returned.
/// Without the §36 fields (an older engine) the preview is all there is: it unfolds in place instead.
struct AgentReportRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let toolUseId: String
    let isError: Bool
    let preview: String
    let info: ToolResultInfo
    /// ⌘F: the current match is in this result — show all of it.
    var revealMatch = false
    @State private var expanded = false

    private var stoppedByUser: Bool { info.stoppedBy == .user }

    private var title: LocalizedStringKey {
        if stoppedByUser { return "Stopped by you" }
        return isError ? "Agent failed" : "Agent report"
    }

    var body: some View {
        let text = AgentReportText.displayText(preview)
        let excerpt = AgentReportText.excerpt(text)
        let full = store.offersFullReport(toolUseId: toolUseId, resultInfo: info)
        let canUnfold = excerpt.more || (isError && text.count > 240)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Label(title, systemImage: stoppedByUser ? "hand.raised" : isError ? "xmark.circle" : "text.bubble")
                    .font(.caption)
                    .foregroundStyle(isError && !stoppedByUser ? Color.red : Color.secondary)
                Spacer(minLength: 4)
                if full, !isError {
                    Button("View full report") { model.showAgentDetails(toolUseId: toolUseId, report: true) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .accessibilityIdentifier("View full report")
                } else if canUnfold, !stoppedByUser {
                    Button(expanded ? "Show fewer" : "Show all") { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }
                        .buttonStyle(.link)
                        .font(.caption)
                }
            }
            if stoppedByUser, text.hasPrefix("[Request interrupted") {
                EmptyView()   // the CLI's own marker of the stop; the title already says who stopped it
            } else if text.isEmpty {
                Text(preview.isEmpty ? "(empty)" : "The report starts after the preview")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if isError {
                Text(verbatim: text)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(revealMatch || expanded ? nil : 4)
            } else {
                MarkdownText(text: revealMatch || expanded ? text : excerpt.text)
                    .font(.callout)
                if excerpt.more, !(revealMatch || expanded) {
                    Text(verbatim: "…").font(.caption).foregroundStyle(.tertiary).accessibilityHidden(true)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent report row")
    }
}

/// §36.3: a SendMessage call that continues a subagent — "↻ executor에게 이어서: <first line>". The agent's new calls go
/// into its original group, which a click opens and scrolls to.
struct AgentContinuationRow: View {
    let continues: AgentContinuation
    let input: JSONValue
    let onReveal: () -> Void
    @State private var hovering = false

    private var message: String {
        input["message"]?.stringValue ?? input["summary"]?.stringValue ?? input["message"].map(\.prettyPrinted) ?? ""
    }

    var body: some View {
        Button(action: onReveal) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.clockwise").foregroundStyle(.indigo).frame(width: 16)
                Text(verbatim: AgentContinuationText.row(continues, input: input))
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.circle.fill")
                    .font(.caption)
                    .foregroundStyle(hovering ? Color.accentColor : Color.secondary.opacity(0.5))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? Color.secondary.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -6)
        .onHover { hovering = $0 }
        .help(Text(verbatim: message))
        .accessibilityHint(Text("Shows the agent's group — its new calls go there"))
        .accessibilityIdentifier("Agent continuation")
    }
}

/// §36.4: the composer's status line while the main turn is blocked on foreground subagents — "메인은 서브에이전트 2개를
/// 기다리는 중 · executor 4m 12s" (the longest running one, ticking).
struct AgentWaitStatusLine: View {
    let waiting: WaitingOnAgents
    /// "— ⌘↩ queues your message", as the plain "Claude is working…" line says.
    var queueHint = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let line = AgentWaitText.statusLine(waiting, elapsed: elapsed(at: ctx.date))
            HStack(spacing: 4) {
                Image(systemName: "person.2.wave.2").foregroundStyle(.blue).accessibilityHidden(true)
                Text(verbatim: queueHint ? String(localized: "\(line) — ⌘↩ queues your message") : line)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Agent wait status")
    }

    private func elapsed(at date: Date) -> String {
        guard let started = waiting.longest?.startedAt, started > 0 else { return "" }
        return AgentFormat.duration(ms: max(0, AgentFormat.nowMs(date) - started))
    }
}
