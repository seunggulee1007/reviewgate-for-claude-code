import SwiftUI
import AppKit
import ReviewGateCore

/// One tool call in the transcript. Edit-tool rows (and Bash rows that changed files) whose file is in the
/// current review open its diff on click; subagent calls show the subagent's rationale under the row.
struct ToolUseRow: View {
    @Environment(\.colorScheme) private var colorScheme
    /// MARK: wave7 w7-chat — §45.1: the row's tooltip and mini diff are worked out once per row (`TranscriptRowCache`).
    let rowID: UUID
    let name: String
    let file: String?
    let input: JSONValue
    let info: ToolUseInfo
    let root: URL?
    /// Changed files in the current review this call touched (edit target or Bash snapshot).
    let linkedFiles: [ChangedFile]
    /// Briefly highlighted after "Why it changed" scrolled here.
    var flashing = false
    /// §21: Edit / Write / Bash rows offer "Why?" (a side question on this call).
    var sideAnchor: SideAnchor?
    let onOpenFile: (ChangedFile) -> Void
    @State private var hovering = false

    private var icon: String {
        switch name {
        case "Read": "doc.text"
        case "Write": "square.and.pencil"
        case "Edit", "MultiEdit", "NotebookEdit": "pencil.line"
        case "Bash": "terminal"
        case "Glob", "Grep": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "TodoWrite": "checklist"
        case ReportFindingsLine.toolName: "sparkles"   // wave4 w4-check3 (§36.13): the pre-review's own mark
        case "Skill": "sparkle"   // wave4b w4b-agents (§39.3)
        default: name.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench"   // wave4b w4b-agents (§39.3): an MCP call
        }
    }

    private var detail: String {
        if let file { return TouchedFile(path: file, tools: [], count: 0).relativePath(to: root) }
        if let labelled = ToolNameText.detail(name: name, input: input) { return labelled }   // wave4b w4b-agents (§39.3)
        // wave4 w4-check3 (§36.13): the main chat's /code-review reports its findings — "3 findings · Svc.java:42, …".
        if name == ReportFindingsLine.toolName, let line = ReportFindingsLine.detail(input: input) { return line }
        if let cmd = input["command"]?.stringValue { return cmd }
        if let pattern = input["pattern"]?.stringValue { return pattern }
        if let url = input["url"]?.stringValue { return url }
        return ""
    }

    private var isEdit: Bool { ToolCallRecord.editTools.contains(name) }
    /// The edit's own file when it is in the review.
    private var primary: ChangedFile? { isEdit ? linkedFiles.first : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                if let primary {
                    Button { onOpenFile(primary) } label: { line(clickable: true) }
                        .buttonStyle(.plain)
                        .help(String(localized: "Show the diff of \(primary.path)"))
                        .accessibilityIdentifier("Tool row open diff")
                } else {
                    line(clickable: false).help(TranscriptRowCache.tooltip(row: rowID, input: input))
                }
                if let sideAnchor {
                    AskWhyButton(anchor: sideAnchor)
                        .opacity(hovering ? 1 : 0)
                        .accessibilityHidden(!hovering)
                }
            }
            if !isEdit, !linkedFiles.isEmpty {
                changedChips
            }
            // wave2 mac-diff (§34.6): what the edit changed, folded, from its input — readable while the turn runs.
            if isEdit, let preview = TranscriptRowCache.editPreview(row: rowID, name: name, input: input) {
                ToolEditPreviewView(rowID: rowID, preview: preview, openPath: primary?.path) { if let primary { onOpenFile(primary) } }
            }
            if info.parentToolUseId != nil, let rationale = info.rationale, !rationale.isEmpty {
                // §34.8: a subagent's own text (forwarded since SDK 0.3.270); an earlier sentence of it reads as such.
                let earlier = info.rationaleSource == .earlier
                Text(earlier ? WhyText.earlier(rationale) : rationale)
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.leading, 22)
                    .help(earlier ? info.rationaleAge.map { "\(rationale)\n\n\(WhyText.callsEarlier($0))" } ?? rationale : rationale)
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(flashing ? Color.accentColor.wash(colorScheme, light: 0.22, dark: 0.30)
                      : hovering && primary != nil ? Color.secondary.opacity(0.10) : .clear)
        )
        .animation(.easeOut(duration: 0.25), value: flashing)
        .onHover { hovering = $0 }
        .contextMenu {
            if let sideAnchor { SideQuestionMenuItems(anchor: sideAnchor, whyTitle: "Ask Why Claude Did This") }
        }
        .padding(.horizontal, -6)
    }

    private func line(clickable: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(.secondary).frame(width: 16)
            ToolNameText(name: name, input: input)   // wave4b w4b-agents (§39.3): "github · get issue", "스킬"
            Text(detail).font(.callout.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if clickable {
                Image(systemName: "arrow.right.circle.fill")
                    .font(.caption)
                    .foregroundStyle(hovering ? Color.accentColor : Color.secondary.opacity(0.5))
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }

    /// Bash (or another tool) changed files: one chip per file, up to three, then "+N".
    private var changedChips: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.tertiary)
            Text("Changed \(linkedFiles.count) file(s)").font(.caption).foregroundStyle(.secondary).fixedSize()
            ForEach(linkedFiles.prefix(3)) { f in
                Button { onOpenFile(f) } label: {
                    TagChip(Text(verbatim: (f.path as NSString).lastPathComponent), systemImage: "doc", tint: .accentColor)
                }
                .buttonStyle(.plain)
                .help(String(localized: "Show the diff of \(f.path)"))
            }
            if linkedFiles.count > 3 {
                Text(verbatim: "+\(linkedFiles.count - 3)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 22)
        .accessibilityIdentifier("Tool row changed files")
    }
}

/// A tool's result: collapsed preview, test verdict badge, and for truncated Bash output "Show full output".
struct ToolResultRow: View {
    @Environment(TranscriptViewState.self) private var view
    let rowID: UUID
    let toolUseId: String
    /// The call's tool name when the transcript has it.
    let toolName: String?
    let isError: Bool
    let preview: String
    let info: ToolResultInfo
    /// ⌘F: the current match is in this output — open it so the text is visible.
    var revealMatch = false
    @State private var showFull = false

    /// Open / closed is the chat column's (`TranscriptViewState.resultExpansion`): it outlasts a look at another chat tab.
    private var expanded: Binding<Bool> {
        Binding(get: { view.resultExpansion[rowID] ?? false }, set: { view.resultExpansion[rowID] = $0 })
    }

    /// An Agent / Task call's result is its group's `AgentReportRow` (wave3 mac-agents), never this row.
    private var title: LocalizedStringKey { isError ? "Tool error" : "Tool result" }

    private var canShowFull: Bool { info.truncated && (toolName == nil || toolName == "Bash") }

    var body: some View {
        DisclosureGroup(isExpanded: expanded) {
            VStack(alignment: .leading, spacing: 4) {
                Text(preview.isEmpty ? String(localized: "(empty)") : preview)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                if canShowFull {
                    Text("Preview — the output continues.").font(.caption2).foregroundStyle(.secondary)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Label(title, systemImage: isError ? "xmark.circle" : "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(isError ? Color.red : Color.secondary)
                if let outcome = info.testOutcome {
                    switch outcome {
                    case .pass:
                        TagChip("Tests passed", systemImage: "checkmark", tint: .green)
                            .accessibilityIdentifier("Test outcome pass")
                    case .fail:
                        TagChip("Tests failed", systemImage: "xmark", tint: .red)
                            .accessibilityIdentifier("Test outcome fail")
                    }
                }
                if canShowFull {
                    Button("Show full output") { showFull = true }
                        .buttonStyle(.link)
                        .font(.caption)
                        .accessibilityIdentifier("Show full output")
                }
            }
        }
        .padding(.leading, 20)
        .onChange(of: revealMatch, initial: true) { _, reveal in if reveal, !expanded.wrappedValue { expanded.wrappedValue = true } }
        .sheet(isPresented: $showFull) {
            ToolOutputSheet(toolUseId: toolUseId, preview: preview)
        }
    }
}

/// The full kept output of a Bash call (`tool_output`), monospaced and scrollable, with Copy.
struct ToolOutputSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let toolUseId: String
    let preview: String
    @State private var output: String?
    @State private var cut = false
    @State private var loading = true
    @State private var copied = false

    private var shown: String { output ?? preview }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Label("Full output", systemImage: "terminal").font(.headline)
                if loading { ProgressView().controlSize(.small) }
                Spacer()
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(shown, forType: .string)
                    copied = true
                }
                .disabled(loading)
                .accessibilityIdentifier("Copy full output")
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
            if !loading, output == nil {
                notice("The full output is no longer kept (engine restarted or evicted) — showing the preview.", tint: .orange)
            } else if cut {
                notice("The middle of very long output was omitted; the start and the end are kept.", tint: .secondary)
            }
            Divider()
            ScrollView([.vertical, .horizontal]) {
                Text(verbatim: shown)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(12)
            }
            .defaultScrollAnchor(.topLeading)
            .background(Color(nsColor: .textBackgroundColor))
        }
        .frame(minWidth: 640, idealWidth: 820, minHeight: 420, idealHeight: 620)
        .task {
            let reply = await store.fetchToolOutput(toolUseId: toolUseId)
            output = reply.output
            cut = reply.truncated
            loading = false
        }
        .accessibilityIdentifier("Full output sheet")
    }

    private func notice(_ text: LocalizedStringKey, tint: Color) -> some View {
        Label(text, systemImage: "info.circle")
            .font(.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, 12).padding(.bottom, 8)
    }
}

/// An Agent / Task call with its subagent's rows folded under it: header (type, description, status, call count),
/// expanded while the subagent runs and collapsed once it is done (the user can override either way).
struct AgentGroupRow<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let input: JSONValue
    let status: AgentStatus
    let callCount: Int
    let isBackground: Bool
    @Binding var expanded: Bool
    var flashing = false
    /// MARK: wave7 w7-chat — §45.1: the rows drawn all at once (a reveal / ⌘F jump goes to one of them), else lazily.
    var eager = false
    // MARK: wave3 mac-agents
    /// The Agent call (the head's menu: "Agent details", "Stop this agent") and its live node (model, resumes, stop).
    var toolUseId: String?
    var node: AgentNode?
    /// §36.2: the node or the call's result says the user stopped it.
    var stoppedByUser = false
    // MARK: wave4b w4b-agents
    /// agents-08: under the collapsed head of a finished agent — its numbers and the first line of its report.
    var collapsedStats: String?
    var collapsedConclusion: String?
    @ViewBuilder let content: () -> Content
    @State private var hovering = false

    private var type: String { input["subagent_type"]?.stringValue ?? "general-purpose" }
    private var description: String { input["description"]?.stringValue ?? "" }
    /// §36.1: the model the call named (the node's once the engine reports it).
    // wave4d w4d-agents2 (§42.4): the model it ran on first, then the one its call named.
    private var model: String? { node?.apiModel ?? node?.model ?? input["model"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
    /// The head's tooltip: the description and the start of the instructions (the details sheet has all of it).
    private var instructionsHelp: String {
        let prompt = input["prompt"]?.stringValue ?? node?.prompt ?? ""
        let start = prompt.count > 400 ? String(prompt.prefix(399)) + "…" : prompt
        return [description, start].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 12)
                        Image(systemName: "person.2.wave.2").foregroundStyle(status.tint)
                        Text(verbatim: type).font(.callout.weight(.semibold)).lineLimit(1)
                        if let model { AgentModelChip(model: model) }
                        Text(verbatim: description).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        AgentResumedBadge(resumeCount: node?.resumeCount ?? 0)
                        if isBackground {
                            Image(systemName: "moon.zzz").font(.caption2).foregroundStyle(.secondary).help("Runs in the background")
                        }
                        if callCount > 0 {
                            Text("\(callCount) calls").font(.caption2.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                        }
                        AgentStatusChip(status: status, stoppedByUser: stoppedByUser)
                    }
                    .padding(.leading, 8).padding(.trailing, toolUseId == nil ? 8 : 2).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(instructionsHelp)
                .accessibilityIdentifier("Agent group header")
                if let toolUseId {
                    if let node, node.status.isLive {
                        AgentStopButton(node: node)
                            .opacity(hovering ? 1 : 0)
                            .accessibilityHidden(!hovering)
                    }
                    Menu {
                        AgentMenuItems(toolUseId: toolUseId)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .padding(.trailing, 8)
                    .help("Agent details and actions")
                    .accessibilityLabel(Text("Agent actions"))
                    .accessibilityIdentifier("Agent group menu")
                }
            }
            .onHover { hovering = $0 }
            .contextMenu { if let toolUseId { AgentMenuItems(toolUseId: toolUseId) } }
            if let toolUseId {
                AgentStopRefusalLine(toolUseId: toolUseId).padding(.horizontal, 10).padding(.bottom, 4)
            }
            // MARK: wave4b w4b-agents — agents-08
            if !expanded, collapsedStats != nil || collapsedConclusion != nil {
                VStack(alignment: .leading, spacing: 1) {
                    if let collapsedStats {
                        Text(verbatim: collapsedStats).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if let collapsedConclusion {
                        Text(verbatim: collapsedConclusion).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                            .help(collapsedConclusion)
                    }
                }
                .padding(.leading, 34).padding(.trailing, 10).padding(.bottom, 6)
                .accessibilityIdentifier("Agent group stats")
            }
            if expanded {
                HStack(alignment: .top, spacing: 0) {
                    Rectangle()
                        .fill(status.tint.opacity(0.35))
                        .frame(width: 2)
                        .padding(.leading, 13)
                    // MARK: wave7 w7-chat — §45.1: lazy — a running group's rows are made as they scroll into view, not all at once.
                    Group {
                        if eager {
                            VStack(alignment: .leading, spacing: 8) { content() }
                        } else {
                            LazyVStack(alignment: .leading, spacing: 8) { content() }
                        }
                    }
                    .padding(.leading, 10).padding(.trailing, 8).padding(.vertical, 6)
                }
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(flashing ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.26) : Color.cardFill(colorScheme).opacity(0.7))
        )
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(status.tint.opacity(status.isLive ? 0.45 : 0.15)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent group")
    }
}
