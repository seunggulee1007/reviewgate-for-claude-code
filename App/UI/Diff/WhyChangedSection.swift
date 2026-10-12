import SwiftUI
import ReviewGateCore

/// Diff header "Why it changed": the tool calls that touched the file (`ChangedFile.toolUseIds`) resolved against the
/// transcript — tool + short input, the assistant's rationale, the subagent it ran in. A click scrolls the chat there.
struct WhyChangedSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @AppStorage("whyChangedExpanded") private var expanded = true
    let file: ChangedFile

    var body: some View {
        // MARK: wave7 w7-chat — §45.1: the shared index (built once per row change), not a new one per draw
        let causes = ChangeCause.causes(for: file, in: store.transcriptIndex)
        // wave2 mac-diff (§34.8): the engine's sourced reason for the file, above the calls.
        let why = WhyDisplay.line(for: file)
        if causes.isEmpty {
            if let why, why.source != .noRecord {
                whyOnlyRow(why)
            } else {
                noCauseRow
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 10)
                        Image(systemName: "questionmark.bubble")
                        Text("Why it changed").font(.caption.weight(.semibold))
                        Text(verbatim: "\(causes.count)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .padding(.horizontal, 5).padding(.vertical, 0.5)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                        Spacer()
                        if !expanded, let summary = collapsedSummary(why: why, causes: causes) {
                            Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .accessibilityIdentifier("Why changed header")
                if expanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            if let why, WhyDisplay.showsAbove(why, causes: causes) {
                                WhyLineView(line: why, lineLimit: 3)
                                    .padding(.horizontal, 6).padding(.vertical, 4)
                                    .accessibilityIdentifier("Why changed reason")
                            }
                            ForEach(Array(causes.enumerated()), id: \.element.id) { offset, cause in
                                CauseRow(cause: cause, step: offset + 1, root: store.projectInfo?.root,
                                         anchor: SideAnchor(path: file.path, toolUseId: cause.toolUseId)) {
                                    model.reveal(toolUseId: cause.toolUseId)
                                }
                            }
                        }
                        .padding(.horizontal, 8).padding(.bottom, 6)
                    }
                    .frame(maxHeight: 168)
                    .fixedSize(horizontal: false, vertical: causes.count <= 3)
                }
            }
            .background(Color.accentColor.wash(colorScheme, light: 0.04, dark: 0.07))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Why changed")
        }
    }

    // MARK: wave2 mac-diff

    /// The collapsed header's one line: the file's reason (an earlier one marked as such), else the first call's.
    private func collapsedSummary(why: WhyLine?, causes: [ChangeCause]) -> String? {
        if let why, let text = why.oneLine(limit: 200) {
            return why.source == .earlier ? WhyText.earlier(text) : text
        }
        guard let cause = causes.first(where: { $0.rationale != nil }), let rationale = cause.rationale else { return nil }
        return cause.isEarlierRationale ? WhyText.earlier(rationale) : rationale
    }

    /// No call in the list explains it, but the engine has a reason (the turn-end report, an earlier turn's sentence).
    private func whyOnlyRow(_ why: WhyLine) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "questionmark.bubble").foregroundStyle(.secondary)
            WhyLineView(line: why, lineLimit: 3)
            Spacer(minLength: 4)
            AskWhyButton(anchor: SideAnchor(path: file.path, toolUseId: why.toolUseId))
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.wash(colorScheme, light: 0.04, dark: 0.07))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Why changed reason only")
    }

    /// §31: no tool call explains the change — said in one line (with a side question for Claude's own changes)
    /// instead of hiding the section, so "no cause recorded" never looks like "nothing to explain".
    private var noCauseRow: some View {
        HStack(spacing: 6) {
            Image(systemName: file.isExternal ? "tray.and.arrow.down" : "questionmark.bubble")
            Text(verbatim: ReviewProvenanceText.noCause(external: file.isExternal))
                .font(.caption)
                .lineLimit(2)
            Spacer(minLength: 4)
            // wave4b w4b-files (comp-13): an outside change can be asked about too, as on Electron ("원인 기록 없음 — 곁질문").
            AskWhyButton(anchor: SideAnchor(path: file.path))
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.wash(colorScheme, light: 0.04, dark: 0.07))
        .help(file.isExternal ? ReviewProvenanceText.externalHelp : ReviewProvenanceText.noCause(external: false))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Why changed none")
    }
}

private struct CauseRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let cause: ChangeCause
    let step: Int
    let root: String?
    /// §21: the file + this call, for "Why?".
    let anchor: SideAnchor
    let onReveal: () -> Void
    @State private var hovering = false

    private var icon: String {
        switch cause.toolName {
        case "Write": "square.and.pencil"
        case "Edit", "MultiEdit", "NotebookEdit": "pencil.line"
        case "Bash": "terminal"
        default: "wrench"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            revealButton
            AskWhyButton(anchor: anchor)
                .opacity(hovering ? 1 : 0)
                .padding(.top, 5)
                .accessibilityHidden(!hovering)
        }
        .onHover { hovering = $0 }
        .contextMenu { SideQuestionMenuItems(anchor: anchor) }
    }

    private var revealButton: some View {
        Button(action: onReveal) {
            HStack(alignment: .top, spacing: 8) {
                Text(verbatim: "\(step)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(Color.secondary.opacity(0.12)))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Image(systemName: icon).font(.caption).foregroundStyle(.secondary)
                        Text(verbatim: cause.toolName).font(.caption.weight(.semibold))
                        if let input = cause.call?.shortInput(root: root), !input.isEmpty, cause.toolName == "Bash" {
                            Text(verbatim: input)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if let agent = cause.agentLabel {
                            TagChip(Text(verbatim: agent), systemImage: "person.2.fill", tint: .purple)
                                .help("Made by a subagent")
                        }
                        Spacer(minLength: 0)
                    }
                    if let rationale = cause.rationale {
                        // wave2 mac-diff (§34.8): an earlier sentence of the agent is not this call's own reason.
                        Text(cause.isEarlierRationale ? WhyText.earlier(rationale) : rationale)
                            .font(.caption)
                            .foregroundStyle(cause.isEarlierRationale ? Color.secondary : Color.primary.opacity(0.85))
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .helpIfPresent(cause.isEarlierRationale ? cause.rationaleAge.map(WhyText.callsEarlier) : nil)
                    } else if cause.call == nil {
                        Text("Not in this chat's transcript").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("No explanation was written before this call").font(.caption).foregroundStyle(.secondary)
                    }
                    // agents-03: why the main agent handed the change to the subagent, apart from the subagent's own reason.
                    if let delegation = cause.delegation {
                        Text(verbatim: WhyText.delegated(delegation))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("Why changed delegation")
                    }
                }
                Image(systemName: "text.bubble")
                    .font(.caption)
                    .foregroundStyle(hovering ? Color.accentColor : .clear)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovering && cause.call != nil ? Color.secondary.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(cause.call == nil)
        .help(cause.call == nil ? String(localized: "Not in this chat's transcript") : String(localized: "Show this call in the chat"))
        .accessibilityIdentifier("Why changed row")
    }
}
