import SwiftUI
import AppKit
import ReviewGateCore

/// wave3 mac-agents: presents the "Agent details" sheet the agent card, the chat's agent group and the HUD's agents chip
/// ask for (`WindowModel.showAgentDetails`).
struct AgentDetailSheetHost: ViewModifier {
    @Environment(WindowModel.self) private var model

    func body(content: Content) -> some View {
        @Bindable var model = model
        content.sheet(item: $model.agentDetail) { request in
            AgentDetailSheet(request: request)
        }
    }
}

/// §36.1 "Agent details" (agents-02 / agents-06): what a subagent was told and what it reported — also after the next
/// turn and after a restart — its calls, the files it changed, usage and model. The report can be copied, put into the
/// main chat's composer, or asked about in a side thread; a running agent can be stopped from here (§36.2).
struct AgentDetailSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let request: AgentDetailRequest
    /// The whole report (`agent_report`) once it came.
    @State private var reply: AgentReportReply?
    /// Why only the preview shows (refused, older engine); nil when the whole report is here.
    @State private var reportNote: String?
    @State private var loading = false

    var body: some View {
        let detail = store.agentDetail(toolUseId: request.toolUseId, reply: reply)
        VStack(spacing: 0) {
            header(detail)
            Divider()
            if let detail {
                ScrollViewReader { proxy in
                    ScrollView {
                        AgentDetailSections(detail: detail, loading: loading, reportNote: reportNote)
                    }
                    .onAppear {
                        guard request.focusReport else { return }
                        DispatchQueue.main.async { proxy.scrollTo(AgentDetailSections.reportID, anchor: .top) }
                    }
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "person.2.slash").font(.title).foregroundStyle(.tertiary)
                    Text("This agent is no longer in this chat").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            footer
        }
        .frame(minWidth: 560, idealWidth: 720, minHeight: 460, idealHeight: 660)
        .task(id: loadKey(detail)) { await loadReport(detail) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent details sheet")
    }

    // MARK: Header / footer

    private func header(_ detail: AgentDetail?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.2.wave.2")
                .font(.title2)
                .foregroundStyle((detail?.status ?? .completed).tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text("Agent details").font(.headline)
                    if let detail {
                        AgentStatusChip(status: detail.status, stoppedByUser: detail.stoppedByUser)
                        AgentResumedBadge(resumeCount: detail.resumeCount)
                        if detail.isBackground {
                            Image(systemName: "moon.zzz.fill").font(.caption2).foregroundStyle(.indigo)
                                .help("Runs in the background").accessibilityLabel("Background")
                        }
                    }
                }
                if let detail {
                    HStack(spacing: 6) {
                        Text(verbatim: detail.type).font(.callout.weight(.semibold)).textSelection(.enabled)
                        if let model = detail.model { AgentModelChip(model: model) }
                    }
                    if !detail.description.isEmpty {
                        Text(verbatim: detail.description).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    if let error = detail.error, !error.isEmpty {
                        Label { Text(verbatim: error).lineLimit(3) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                            .font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let node = store.agentNode(toolUseId: request.toolUseId), node.status.isLive {
                stopButton(node)
                AgentStopRefusalLine(toolUseId: request.toolUseId)
            }
            Spacer()
            Button("Done") { dismiss() }
                .keyboardShortcut(.defaultAction)
        }
        .padding(12)
    }

    @ViewBuilder
    private func stopButton(_ node: AgentNode) -> some View {
        let state = store.agentStopState(node)
        switch state {
        case .hidden:
            EmptyView()
        case .available, .stopping, .unavailable:
            Button(role: .destructive) {
                Task { await store.stopAgent(toolUseId: node.toolUseId) }
            } label: {
                if state == .stopping {
                    HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("Stopping this agent…") }
                } else {
                    Label("Stop this agent", systemImage: "stop.fill")
                }
            }
            .disabled(state != .available)
            .help(stopHelp(state))
            .accessibilityIdentifier("Agent details stop")
        }
    }

    private func stopHelp(_ state: AgentStopState) -> String {
        if case let .unavailable(reason) = state { return reason }
        return String(localized: "Stop this agent — the turn and the other agents go on")
    }

    // MARK: The whole report

    /// Asked again when the agent finishes or is continued (a new run reports anew).
    private func loadKey(_ detail: AgentDetail?) -> String {
        "\(detail?.status.rawValue ?? "-")#\(detail?.resumeCount ?? 0)"
    }

    private func loadReport(_ detail: AgentDetail?) async {
        guard let detail, !detail.status.isLive, !store.agentReportUnsupported else { return }
        loading = true
        defer { loading = false }
        switch await store.loadAgentReport(toolUseId: request.toolUseId) {
        case let .loaded(report):
            reply = report
            reportNote = nil
        case let .unavailable(reason):
            reportNote = reason
        case .unsupported:
            reportNote = String(localized: "Preview only — this engine does not keep the whole report")
        }
    }
}

/// The sheet's sections: Instructions, Report (copy / send to the main chat / ask in a side thread), tool calls, files,
/// usage and model.
struct AgentDetailSections: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let detail: AgentDetail
    /// `agent_report` is on its way.
    var loading = false
    /// Why only the preview shows; nil when the whole report is here (or not asked yet).
    var reportNote: String?
    @State private var instructionsExpanded = false
    @State private var copied: String?

    static let reportID = "agent-detail-report"

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            instructions
            report.id(Self.reportID)
            calls
            if !detail.files.isEmpty { files }
            usage
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Sections

    private var instructions: some View {
        section("Instructions", systemImage: "text.quote", copyText: detail.instructions, copyID: "instructions") {
            if let text = detail.instructions {
                let excerpt = AgentReportText.excerpt(text)
                MarkdownText(text: instructionsExpanded || !excerpt.more ? text : excerpt.text)
                    .font(.callout)
                if excerpt.more {
                    Button(instructionsExpanded ? "Show fewer" : "Show all") {
                        withAnimation(.easeInOut(duration: 0.15)) { instructionsExpanded.toggle() }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    .accessibilityIdentifier("Agent instructions toggle")
                }
            } else {
                Text("Not known — the call is no longer in this chat").font(.callout).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("Agent instructions")
    }

    private var report: some View {
        VStack(alignment: .leading, spacing: 8) {
            FullOrCompact { _ in   // not ViewThatFits: the action buttons are AppKit views it rebuilt every pass
                HStack(spacing: 8) {
                    reportTitle
                    Spacer(minLength: 4)
                    reportActions
                }
            } compact: {
                VStack(alignment: .leading, spacing: 6) {
                    reportTitle
                    HStack(spacing: 8) { reportActions }
                }
            }
            .controlSize(.small)
            VStack(alignment: .leading, spacing: 6) {
                if let text = detail.report {
                    MarkdownText(text: text).font(.callout)
                } else {
                    Text(detail.status.isLive ? "The report comes when the agent finishes" : "No report")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if detail.reportIsPreview, detail.report != nil, let why = reportNote ?? previewNote {
                    note(why)
                }
                if detail.reportTruncated {
                    note(String(localized: "The engine keeps the first 50,000 characters of a report."))
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent report")
    }

    private var reportTitle: some View {
        HStack(spacing: 8) {
            Label("Report", systemImage: "text.bubble").font(.subheadline.weight(.semibold))
            if loading { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder
    private var reportActions: some View {
        copyButton(detail.report, id: "report")
        Button("Send to main chat", systemImage: "arrowshape.turn.up.left") { sendToMain() }
            .disabled(detail.report == nil)
            .help("Puts the report into the composer — add what Claude should do with it, then send")
            .accessibilityIdentifier("Agent report send to main")
        Button("Ask in a side thread", systemImage: "bubble.left.and.text.bubble.right") { askInSideThread() }
            .disabled(!store.side.isSupported)
            .help(store.side.isSupported ? String(localized: "Ask about this agent in a side question — the main conversation is not affected")
                                         : String(localized: "This engine has no side questions"))
            .accessibilityIdentifier("Agent report ask in side thread")
    }

    private var calls: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Tool calls (\(detail.calls.count))", systemImage: "wrench.and.screwdriver").font(.subheadline.weight(.semibold))
            if detail.calls.isEmpty {
                Text("No tool calls of this agent in this chat").font(.callout).foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(detail.calls) { call in callRow(call) }
                }
                .padding(6)
                .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent tool calls")
    }

    private func callRow(_ call: AgentCallSummary) -> some View {
        Button {
            dismiss()
            model.reveal(toolUseId: call.id)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: call.isAgent ? "person.2.wave.2" : "wrench")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(width: 14)
                Text(verbatim: call.name).font(.caption.weight(.semibold))
                Text(verbatim: call.detail).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                switch call.isError {
                case true?: Image(systemName: "xmark.circle.fill").font(.caption2).foregroundStyle(.red).accessibilityLabel("Tool error")
                case false?: Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.green.opacity(0.8))
                case nil: EmptyView()
                }
            }
            .padding(.leading, CGFloat(min(call.depth, 4)) * 14)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text("Show in the chat"))
    }

    private var files: some View {
        let root = store.projectInfo?.root ?? store.projectURL?.path
        return VStack(alignment: .leading, spacing: 6) {
            Label("Files (\(detail.files.count))", systemImage: "doc.on.doc").font(.subheadline.weight(.semibold))
            FlowLayout(spacing: 4) {
                ForEach(detail.files, id: \.self) { path in
                    let rel = RepoPath.relative(path, root: root)
                    let inReview = store.changedFiles.contains { $0.path == rel }
                    Button {
                        dismiss()
                        store.selectFile(path: rel)
                    } label: {
                        TagChip(Text(verbatim: rel), systemImage: "doc", tint: inReview ? .accentColor : .secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(!inReview)
                    .help(inReview ? String(localized: "Show the diff of \(rel)") : rel)
                }
            }
        }
        .accessibilityIdentifier("Agent files")
    }

    private var usage: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Usage", systemImage: "gauge.with.dots.needle.33percent").font(.subheadline.weight(.semibold))
            FlowLayout(spacing: 14) {
                if let usage = detail.usage {
                    Label(HUDStrip.tokens(usage.tokens), systemImage: "number").help("\(usage.tokens) tokens")
                    Label("\(usage.toolUses) tools", systemImage: "hammer")
                }
                duration
                if let model = detail.model {
                    AgentModelChip(model: model)
                } else {
                    Text("Model not named — the agent's own or the session's").foregroundStyle(.secondary)
                }
            }
            .font(.callout.monospacedDigit())
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent usage")
    }

    @ViewBuilder
    private var duration: some View {
        if detail.status.isLive, let started = detail.startedAt, started > 0 {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Label(AgentFormat.duration(ms: max(0, AgentFormat.nowMs(ctx.date) - started)), systemImage: "clock")
            }
        } else if let ms = detail.usage?.durationMs, ms > 0 {
            Label(AgentFormat.duration(ms: Double(ms)), systemImage: "clock")
        } else if let started = detail.startedAt, let ended = detail.endedAt, ended > started {
            Label(AgentFormat.duration(ms: ended - started), systemImage: "clock")
        }
    }

    // MARK: Pieces

    private func section<Content: View>(_ title: LocalizedStringKey, systemImage: String, copyText: String?, copyID: String,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(title, systemImage: systemImage).font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                copyButton(copyText, id: copyID).controlSize(.small)
            }
            VStack(alignment: .leading, spacing: 6) { content() }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func copyButton(_ text: String?, id: String) -> some View {
        Button(copied == id ? "Copied" : "Copy", systemImage: copied == id ? "checkmark" : "doc.on.doc") {
            guard let text else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = id
        }
        .disabled(text == nil)
        .accessibilityIdentifier("Agent copy \(id)")
    }

    private func note(_ text: String) -> some View {
        Label(text, systemImage: "info.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Why the report is a preview when nothing was asked: the agent still runs, or the engine keeps no report.
    private var previewNote: String? {
        if loading { return nil }
        if detail.status.isLive { return String(localized: "The report comes when the agent finishes") }
        if store.agentReportUnsupported { return String(localized: "Preview only — this engine does not keep the whole report") }
        return nil
    }

    // MARK: Actions

    /// Puts the report into the composer (nothing is sent): the user adds what Claude should do with it.
    private func sendToMain() {
        guard let text = detail.report else { return }
        model.insertIntoComposer(String(localized: "\(detail.type) report:") + "\n\n" + text + "\n\n")
        dismiss()
    }

    /// A side question anchored on the Agent call (the side session forks the conversation, so it has the report).
    private func askInSideThread() {
        store.side.compose(anchor: SideAnchor(toolUseId: detail.toolUseId))
        dismiss()
    }
}
