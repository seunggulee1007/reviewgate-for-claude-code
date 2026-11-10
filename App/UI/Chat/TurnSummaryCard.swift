import SwiftUI
import ReviewGateCore

/// §15 `turn_summary` in the chat: what the turn changed (with risk badges and the one-line "why" per file), the
/// commands it ran with their test verdicts, and — after an approved plan — the plan's steps checked against the
/// changed files with the unplanned changes called out. Collapsible; a file row opens its diff, a command its row.
struct TurnSummaryCard: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(TranscriptViewState.self) private var view
    /// The row's id: open / closed is the chat column's (`TranscriptViewState.summaryExpansion`) — a look at another chat
    /// tab does not open again what was folded.
    let rowID: UUID
    let summary: TurnSummary
    // MARK: wave5 w5-fixes — §43.5: the newest summary of the live chat carries the "plan vs actual" basis menu
    var showsBasis = false
    /// §43.5: the live chat's summary (not another chat's shown read-only) offers '왜?' on its plan steps.
    var askable = false
    @State private var showAllCommands = false

    private var expanded: Bool { view.summaryExpansion[rowID] ?? true }

    private static let commandLimit = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // wave3 check-clients (§34.3): the whole review after a merged turn, on its own line under this turn's numbers.
            if let totals = summary.reviewTotalsShown { SummaryReviewTotalsLine(totals: totals) }
            AutoAcceptedSummaryLine(files: summary.autoAccepted)   // MARK: wave4c w4c-trust (§41.2)
            if let choice = summary.autoModel { TurnAutoModelLine(choice: choice) }   // MARK: wave5 w5-model (§43.4)
            if expanded {
                Divider().padding(.horizontal, 10)
                VStack(alignment: .leading, spacing: 10) {
                    filesSection
                    AgentChangesSection(files: summary.files.map { ($0.path, $0.toolUseIds) })   // wave4b w4b-agents — agents-13
                    if !summary.commands.isEmpty { commandsSection }
                    if let plan = summary.plan {
                        PlanVsActualSection(plan: plan, open: open, basis: basisMenu, askable: askable)   // wave5 w5-fixes: + the basis menu, '왜?' 
                    } else if let basisMenu {
                        PlanBasisLine(menu: basisMenu)   // MARK: wave5 w5-fixes — §43.5
                    }
                    TurnModelCostSection(models: summary.models)   // wave4d w4d-agents2 — §42.4
                }
                .padding(10)
            }
        }
        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.wash(colorScheme, light: 0.25, dark: 0.35)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Turn summary")
    }

    /// MARK: wave5 w5-fixes — §43.5: the basis menu (nil on an older engine, on an older card or another chat's).
    private var basisMenu: PlanBasisMenu? { showsBasis ? store.planBasisMenu : nil }

    // MARK: Header

    private var header: some View {
        Button {
            let open = !expanded
            withAnimation(.easeInOut(duration: 0.15)) { view.summaryExpansion[rowID] = open }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 10)
                    .foregroundStyle(.secondary)
                Image(systemName: "list.bullet.rectangle.portrait").foregroundStyle(Color.accentColor)
                Text("Turn summary").font(.callout.weight(.semibold))
                // wave3 check-clients (§34.3): after a merged turn, these numbers are named "이번 턴" and the whole review follows.
                if summary.reviewTotalsShown != nil {
                    Text("This turn").font(.caption.weight(.semibold)).foregroundStyle(.secondary).fixedSize()
                }
                Text("\(summary.files.count) files")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize()
                Text(verbatim: "+\(summary.totalAdds)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                Text(verbatim: "−\(summary.totalDels)").font(.caption.monospacedDigit()).foregroundStyle(.red)
                Spacer(minLength: 4)
                // wave2 mac-diff (§34.9): the turn's last test run against its last edit; older engines: the counts.
                // wave3 check-clients: Electron's rule — no test this turn says so in grey (summary.testVerdict).
                if let verdict = summary.testVerdict {
                    TestVerdictChip(verdict: verdict, lastTest: summary.lastTest)
                } else {
                    if summary.testsPassed > 0 {
                        TagChip(Text("Tests \(summary.testsPassed) passed"), systemImage: "checkmark", tint: .green)
                    }
                    if summary.testsFailed > 0 {
                        TagChip(Text("Tests \(summary.testsFailed) failed"), systemImage: "xmark", tint: .red)
                    }
                }
                if let plan = summary.plan, !plan.unplannedFiles.isEmpty {
                    // wave4d w4d-plan (§42.1): "요청 밖 N개" when the plan is the request's scope
                    TagChip(Text(verbatim: PlanSourceText.unplannedChip(plan.unplannedFiles.count, plan)), systemImage: "exclamationmark.triangle.fill", tint: .orange)
                }
                // §31: files nothing of Claude's explains (the IDE, another session, a git pull) are part of the list.
                if summary.externalCount > 0 {
                    TagChip(Text(verbatim: ReviewProvenanceText.externalIncluded(summary.externalCount)), systemImage: "tray.and.arrow.down.fill", tint: .secondary)
                        .help(ReviewProvenanceText.externalHelp)
                        .accessibilityIdentifier("Turn summary external")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? String(localized: "Collapse the turn summary") : String(localized: "Expand the turn summary"))
        .accessibilityIdentifier("Turn summary header")
    }

    // MARK: Files

    private var filesSection: some View {
        // wave2 mac-diff (§34.8): a reason two or more files share is shown once, above them.
        let shared = WhyDisplay.shared(summary.files)
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(shared) { group in
                SharedWhyRow(group: group, open: open)
            }
            ForEach(summary.files) { file in
                TurnSummaryFileRow(file: file, unplanned: summary.plan?.isUnplanned(file.path) == true,
                                   unplannedLabel: summary.plan.map(PlanSourceText.unplannedBadge),   // wave4d w4d-plan
                                   inReview: store.changedFiles.contains { $0.path == file.path },
                                   showsWhy: !WhyDisplay.isShared(file.path, in: shared)) { open(file.path) }
            }
        }
    }

    // MARK: Commands

    private var commandsSection: some View {
        let commands = showAllCommands ? summary.commands : Array(summary.commands.prefix(Self.commandLimit))
        return VStack(alignment: .leading, spacing: 3) {
            Text("Commands").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(commands) { command in
                Button { model.reveal(toolUseId: command.toolUseId) } label: {
                    HStack(spacing: 6) {
                        commandIcon(command)
                        Text(verbatim: command.firstLine)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(command.command)
                .accessibilityIdentifier("Turn summary command")
            }
            if summary.commands.count > Self.commandLimit {
                Button(showAllCommands ? String(localized: "Show fewer") : String(localized: "Show all \(summary.commands.count) commands")) {
                    showAllCommands.toggle()
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }

    @ViewBuilder
    private func commandIcon(_ command: TurnSummary.Command) -> some View {
        switch command.testOutcome {
        case .pass:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).help("Tests passed")
        case .fail:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red).help("Tests failed")
        case nil:
            if command.isError {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).help("The command failed")
            } else {
                Image(systemName: "terminal").foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Navigation

    /// A row → that file's diff in the current review (leaving a history view first). A file no longer in the review opens
    /// nothing, so nothing on screen changes either.
    private func open(_ path: String) {
        guard store.changedFile(path: path) != nil else { return }
        store.closeHistoryDiff()
        if model.tab != .changes { model.tab = .changes }
        store.selectFile(path: path)
    }
}

private struct TurnSummaryFileRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let file: TurnSummary.File
    let unplanned: Bool
    /// wave4d w4d-plan (§42.1): the badge's words ("요청 밖" for the request's scope).
    var unplannedLabel: String?
    /// The file is still in the review list (its diff can be shown).
    let inReview: Bool
    /// wave2 mac-diff: false when its reason is the card's shared one (shown above the files).
    var showsWhy = true
    let onOpen: () -> Void
    @State private var hovering = false

    /// §21: the file and the call that explains it.
    private var anchor: SideAnchor { SideAnchor(path: file.path, toolUseId: file.whyToolUseId) }

    // MARK: wave4b w4b-side — §40.3 (SME-12): '왜?' also after the review is done (the question gets the call that made the
    // change); not on another chat shown read-only — its question would go to the running chat.
    @Environment(AppState.self) private var store
    private var asksWhy: Bool { inReview || store.viewedChat == nil }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            openButton
            if asksWhy {
                AskWhyButton(anchor: anchor, iconOnly: true)
                    .opacity(hovering ? 1 : 0)
                    .padding(.top, 4)
                    .accessibilityHidden(!hovering)
            }
        }
        .onHover { hovering = $0 }
        .contextMenu { if asksWhy { SideQuestionMenuItems(anchor: anchor) } }
    }

    private var openButton: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 6) {
                Text(file.status.rawValue)
                    .font(.caption.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(file.status))
                    .frame(width: 12)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        pathText(file.path).font(.callout).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(verbatim: "+\(file.adds)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                        Text(verbatim: "−\(file.dels)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
                        stateMark
                    }
                    let risks = file.risks
                    let external = file.origin == .external
                    if !risks.isEmpty || unplanned || external {
                        HStack(spacing: 4) {
                            if unplanned {
                                TagChip(Text(verbatim: unplannedLabel ?? String(localized: "Unplanned")), systemImage: "exclamationmark.triangle.fill", tint: .orange)
                            }
                            ForEach(risks, id: \.self) { RiskChip(risk: $0) }
                            if external { ExternalChip() }
                        }
                    }
                    // wave2 mac-diff (§34.8): the sourced reason — reported, the call's own, an earlier one dimmed, or none.
                    if showsWhy, let why = WhyDisplay.line(for: file) {
                        WhyLineView(line: why, lineLimit: 1, oneLine: true)
                    }
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovering && inReview ? Color.secondary.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!inReview)
        .help(WhyDisplay.line(for: file)?.text.map { String(localized: "Why: \($0)") }
              ?? (inReview ? String(localized: "Show the diff") : String(localized: "No longer in the review")))
        .accessibilityIdentifier("Turn summary file \(file.path)")
    }

    @ViewBuilder
    private var stateMark: some View {
        switch file.state {
        case .pending: Circle().fill(Color.orange).frame(width: 6, height: 6).help("Pending review")
        case .accepted: Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.green).help("Accepted")
        case .rejected: Image(systemName: "arrow.uturn.backward").font(.caption2.weight(.bold)).foregroundStyle(.orange).help("Rejected")
        case .changesRequested: Image(systemName: "exclamationmark.bubble.fill").font(.caption2).foregroundStyle(.orange).help("Changes requested")
        }
    }
}

/// "Plan vs actual": each approved step with the changed files it mentions, then the changes no step mentions.
private struct PlanVsActualSection: View {
    @Environment(\.colorScheme) private var colorScheme
    let plan: TurnSummary.Plan
    let open: (String) -> Void
    /// MARK: wave5 w5-fixes — §43.5: the basis menu on the newest summary; '왜?' on a step of the live chat's summary.
    var basis: PlanBasisMenu? = nil
    var askable = false
    @Environment(AppState.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: PlanSourceText.isRequest(plan) ? "scope" : "checklist").foregroundStyle(.blue)
                // wave4d w4d-plan (§42.1): the plan file, Claude's to-do list, the first message's list or the request
                Text(verbatim: PlanSourceText.title(plan)).font(.caption.weight(.semibold))
                if !PlanSourceText.isRequest(plan) {
                    Text("\(plan.matchedStepCount)/\(plan.steps.count) steps touched")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let name = plan.fileName {
                    Text(verbatim: name).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).help(plan.path ?? name)
                }
                if let basis { PlanBasisMenuButton(menu: basis) }   // MARK: wave5 w5-fixes — §43.5
            }
            .help(String(localized: "Steps are matched to changed files by path, file name or a distinctive name — a heuristic, not a verdict"))
            if PlanSourceText.isRequest(plan) {
                Text(verbatim: plan.title ?? plan.steps.first?.text ?? "")
                    .font(.callout).foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("Plan request")
            }
            ForEach(PlanSourceText.isRequest(plan) ? [] : plan.steps) { step in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: step.files.isEmpty ? (step.done == true ? "checkmark.square" : "square") : "checkmark.square.fill")
                        .foregroundStyle(step.files.isEmpty ? Color.secondary : Color.green)
                        .font(.callout)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(step.index + 1). \(step.text)")   // wave5 w5-fixes: the wire index is 0-based
                            .font(.callout)
                            .foregroundStyle(step.files.isEmpty ? Color.secondary : Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if step.files.isEmpty {
                            Text("No changes for this step yet").font(.caption).foregroundStyle(.secondary)
                        } else {
                            FileChipFlow(paths: step.files, tint: .green, open: open)
                        }
                    }
                    // MARK: wave5 w5-fixes — §43.5: '왜?' on the step (a side question quoting it)
                    if askable, store.side.isSupported {
                        Spacer(minLength: 4)
                        Button("Why?") {
                            let why = WhyQuestions.planStep(number: step.index + 1, text: step.text)
                            store.side.askNow(anchor: why.anchor, question: why.question)
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help("Ask Claude why this step is in the plan and which changes belong to it (side question)")
                        .accessibilityLabel(Text("Ask why step \(step.index + 1) is in the plan"))
                        .accessibilityIdentifier("Plan step why")
                    }
                }
                .accessibilityIdentifier("Plan step")
            }
            if !plan.unplannedFiles.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label(PlanSourceText.unplannedTitle(plan), systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(verbatim: PlanSourceText.unplannedHelp(plan))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    FileChipFlow(paths: plan.unplannedFiles, tint: .orange, open: open)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.16), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("Unplanned changes")
            }
        }
        .padding(8)
        .background(Color.blue.wash(colorScheme, light: 0.05, dark: 0.08), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Plan vs actual")
    }
}

/// Wrapping row of clickable file-name chips (the full path in the tooltip); a file no longer in the review is dimmed and
/// says so, as the card's file rows do.
private struct FileChipFlow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let paths: [String]
    let tint: Color
    let open: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(paths, id: \.self) { path in
                let inReview = store.changedFile(path: path) != nil
                Button { open(path) } label: {
                    Text(verbatim: (path as NSString).lastPathComponent)
                        .font(.caption2.weight(.medium).monospaced())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(tint.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
                        .foregroundStyle(tint)
                        .opacity(inReview ? 1 : 0.5)
                }
                .buttonStyle(.plain)
                .disabled(!inReview)
                .help(inReview ? path : path + "\n" + String(localized: "No longer in the review"))
            }
        }
    }
}

/// The risk badge of `ChangedFilesList`, shared with the turn summary and the history.
struct RiskChip: View {
    let risk: FileRisk

    var body: some View {
        switch risk {
        case .sensitive:
            TagChip("Sensitive", systemImage: "exclamationmark.shield.fill", tint: .red)
                .help("Agent config, CI workflow or secrets — review carefully")
        case .deleted:
            TagChip("Deleted", systemImage: "trash.fill", tint: .red)
        case .large:
            TagChip("Large", systemImage: "text.alignleft", tint: .orange)
                .help("More than \(FileRisk.largeThreshold) lines changed")
        case .viaBash:
            TagChip("Changed by Bash", systemImage: "terminal.fill", tint: .orange)
                .help("A Bash command Claude ran changed this file (not an edit tool)")
        case .config:
            TagChip("Config", systemImage: "gearshape.fill", tint: .indigo)
                .help("Build, dependency or tool configuration (lockfiles included)")
        case .test:
            TagChip("Test", systemImage: "checkmark.diamond", tint: .teal)
        // MARK: wave4b w4b-files — §40.2: the engine's kinds (the same keys as Electron's risk.ts)
        case .permission:
            TagChip("Permission", systemImage: "lock.open.fill", tint: .orange)
                .help("The file's permission changed — e.g. made executable (644 → 755)")
        case .schema:
            TagChip("Schema", systemImage: "cylinder.split.1x2.fill", tint: .orange)
                .help("Database schema or migration (*.sql, db/migration, Flyway, Liquibase)")
        case .sql:
            TagChip("SQL", systemImage: "cylinder.fill", tint: .indigo)
                .help("MyBatis mapper — the SQL the app runs")
        case .settings:
            TagChip("Settings file", systemImage: "key.fill", tint: .indigo)
                .help("Settings or credentials (application*.yml, *.properties) — may hold connection details or secrets")
        case .ci:
            TagChip("CI", systemImage: "hammer.fill", tint: .indigo)
                .help("Build pipeline (Jenkinsfile, GitHub workflows, …) — runs on the build server")
        }
    }
}

// MARK: - wave2 mac-diff

/// §34.8: a reason several files of the card share, once, with the files it is for (a click opens one).
private struct SharedWhyRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let group: WhyDisplay.Shared
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "text.quote").font(.caption).foregroundStyle(.secondary)
                WhyLineView(line: group.line, lineLimit: 2)
            }
            FileChipFlow(paths: group.paths, tint: .secondary, open: open)
                .padding(.leading, 18)
        }
        .padding(.horizontal, 6).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.10), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Turn summary shared why")
    }
}

/// §34.9: "테스트 통과 · 마지막 편집 뒤 실행" / "테스트 실패" / "편집 뒤 테스트 없음", the command in its tooltip.
private struct TestVerdictChip: View {
    let verdict: TestVerdictLine
    let lastTest: LastTest?

    var body: some View {
        TagChip(Text(verbatim: verdict.text), systemImage: systemImage, tint: tint)
            .helpIfPresent(verdict.help(lastTest))   // wave3 check-clients: what an earlier run said, as Electron's tooltip
            .accessibilityIdentifier("Turn summary test verdict")
    }

    private var systemImage: String {
        switch verdict {
        case .passedAfterEdit: "checkmark"
        case .failed: "xmark"
        case .noTestAfterEdit: "exclamationmark.triangle.fill"
        case .noTestRun: "minus.circle"
        }
    }

    private var tint: Color {
        switch verdict {
        case .passedAfterEdit: .green
        case .failed: .red
        case .noTestAfterEdit: .orange
        case .noTestRun: .secondary
        }
    }
}

/// Directory in secondary color, last path component bold.
func pathText(_ path: String) -> Text {
    guard let slash = path.lastIndex(of: "/") else { return Text(verbatim: path).bold() }
    let dir = String(path[...slash])
    let name = String(path[path.index(after: slash)...])
    return Text(verbatim: dir).foregroundStyle(.secondary) + Text(verbatim: name).bold()
}

func statusColor(_ status: ChangeStatus) -> Color {
    switch status {
    case .added: .green
    case .modified: .orange
    case .deleted: .red
    case .renamed: .blue
    case .other: .secondary
    }
}
