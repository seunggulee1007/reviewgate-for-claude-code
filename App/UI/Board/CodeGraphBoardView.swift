import AppKit
import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the board's "코드 그래프" tab. graphify's report (never graph.json) as big
// numbers, a freshness badge, the most connected nodes and the community sizes as bars, the surprising connections and the
// community hubs; [다시 빌드] runs `graphify update .` in the background, [graph.html 열기] opens the full graph in the browser.
// Read while the tab is shown: every 15 s, and the build's progress as the engine sends it.

/// The board's code graph tab (no arguments: the window's `AppState` from the environment).
struct CodeGraphBoardView: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    /// How often the tab re-reads the report while it is shown (the engine re-parses only a changed file).
    static let pollSeconds: Double = 15

    private var graph: CodeGraphStore { store.codeGraph }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let reply = graph.reply, let report = reply.report {
                    header(reply, report)
                    statTiles(report)
                    controls(reply)
                    if !report.gods.isEmpty { godsSection(report) }
                    if !report.bigCommunities.isEmpty { communitiesSection(report) }
                    if !report.surprises.isEmpty { surprisesSection(report) }
                    if !report.hubs.isEmpty { hubsSection(report) }
                } else {
                    emptyState
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: store.projectURL) {
            // The tab is shown: read now, then every 15 s until it goes away (the task is cancelled with the view). Without a
            // project there is nothing to read (and no engine to start for it).
            guard store.projectURL != nil else { return }
            while !Task.isCancelled {
                await store.refreshCodeGraph()
                try? await Task.sleep(for: .seconds(Self.pollSeconds))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Code graph board")
    }

    // MARK: Header and numbers

    private func header(_ reply: CodeGraphReply, _ report: CodeGraphReport) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.title3)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: report.name ?? store.projectName)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                Text(subtitle(reply, report))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if let fresh = CodeGraphText.freshness(reply) { freshnessBadge(fresh, reply) }
        }
    }

    private func subtitle(_ reply: CodeGraphReply, _ report: CodeGraphReport) -> String {
        var parts: [String] = []
        if let files = report.files { parts.append(String(localized: "\(files) files")) }
        if let e = report.extractedPct, let i = report.inferredPct {
            parts.append(String(localized: "Extracted") + " \(e)% · " + String(localized: "Inferred") + " \(i)%")
        }
        if let ago = CodeGraphText.ago(reply.builtAt) { parts.append(String(localized: "Built \(ago)")) }
        if reply.shared { parts.append(String(localized: "The main worktree's graph")) }
        return parts.joined(separator: " · ")
    }

    private func freshnessBadge(_ fresh: CodeGraphText.Freshness, _ reply: CodeGraphReply) -> some View {
        let tint: Color = switch fresh {
        case .fresh: .green
        case .behind: .orange
        case .unknown, .noCommit: .secondary
        }
        let icon = switch fresh {
        case .fresh: "checkmark.seal.fill"
        case .behind: "clock.arrow.circlepath"
        case .unknown, .noCommit: "questionmark.circle"
        }
        return Label(CodeGraphText.freshnessLabel(fresh), systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
            .fixedSize()
            .help(freshnessHelp(reply))
            .accessibilityElement(children: .combine)
    }

    private func freshnessHelp(_ reply: CodeGraphReply) -> String {
        let commit = reply.report?.commit ?? "?"
        let head = reply.head ?? "?"
        return String(localized: "Graph built from commit \(commit) · HEAD \(head)")
    }

    private func statTiles(_ report: CodeGraphReport) -> some View {
        HStack(spacing: 10) {
            statTile(String(localized: "Nodes"), report.nodes, icon: "circle.grid.cross", tint: .blue)
            statTile(String(localized: "Edges"), report.edges, icon: "arrow.triangle.branch", tint: .purple)
            statTile(String(localized: "Communities"), report.communities, icon: "circle.hexagongrid", tint: .teal)
        }
    }

    private func statTile(_ title: String, _ value: Int, icon: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Text(value, format: .number)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.wash(colorScheme, light: 0.07, dark: 0.14), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(title) \(value.formatted())"))
    }

    // MARK: Build and graph.html

    private func controls(_ reply: CodeGraphReply) -> some View {
        let blocked = CodeGraphText.buildBlockedReason(reply, unsupported: graph.unsupported)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    Task { await store.buildCodeGraph() }
                } label: {
                    Label(reply.shared ? String(localized: "Build here") : String(localized: "Rebuild"), systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(blocked != nil)
                .help(blocked ?? String(localized: "Runs graphify update . in the project — in the background, without tokens"))
                .accessibilityIdentifier("Rebuild code graph")
                Button {
                    if let path = reply.htmlPath, CodeGraphText.canOpenHtml(path) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                } label: {
                    Label(String(localized: "Open graph.html"), systemImage: "safari")
                }
                .controlSize(.small)
                .disabled(!CodeGraphText.canOpenHtml(reply.htmlPath))
                .help(CodeGraphText.canOpenHtml(reply.htmlPath) ? String(localized: "Opens the whole graph in your browser")
                      : String(localized: "graph.html is not there — rebuild to make it"))
                if reply.build?.running == true { ProgressView().controlSize(.small).accessibilityLabel(Text("A build is running")) }
                Spacer(minLength: 0)
            }
            if let blocked, reply.build?.running != true {
                Text(blocked).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if reply.graphify == nil { Text(CodeGraphText.installHint).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            buildLine(reply)
            if let error = graph.errorText {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func buildLine(_ reply: CodeGraphReply) -> some View {
        if let build = reply.build {
            if build.running {
                // The elapsed time moves once a second only while a build runs.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(CodeGraphText.buildLine(build, now: context.date))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            } else {
                Text(CodeGraphText.buildLine(build))
                    .font(.caption)
                    .foregroundStyle(build.ok == true ? Color.secondary : Color.orange)
                    .lineLimit(2)
            }
        }
    }

    // MARK: Bars

    private func godsSection(_ report: CodeGraphReport) -> some View {
        let maxEdges = report.gods.map(\.edges).max() ?? 0
        return section(String(localized: "Most connected nodes"), icon: "star.circle.fill", tint: .yellow) {
            ForEach(Array(report.gods.enumerated()), id: \.offset) { index, node in
                BarRow(rank: index + 1, name: node.name, value: node.edges, share: CodeGraphText.share(node.edges, of: maxEdges),
                       tint: .accentColor, valueLabel: String(localized: "\(node.edges) edges"))
            }
        }
    }

    private func communitiesSection(_ report: CodeGraphReport) -> some View {
        let maxNodes = report.bigCommunities.map(\.nodes).max() ?? 0
        return section(String(localized: "Community sizes"), icon: "circle.hexagongrid.fill", tint: .teal) {
            ForEach(Array(report.bigCommunities.enumerated()), id: \.offset) { index, community in
                BarRow(rank: nil, name: community.name, value: community.nodes, share: CodeGraphText.share(community.nodes, of: maxNodes),
                       tint: Self.palette[index % Self.palette.count], valueLabel: String(localized: "\(community.nodes) nodes"),
                       detail: community.cohesion.map { String(localized: "Cohesion") + " " + String(format: "%.2f", $0) })
            }
        }
    }

    /// Community colors: none of the status colors' meanings (no red / pink / green / orange).
    static let palette: [Color] = [.teal, .indigo, .cyan, .purple, .mint, .blue, .brown]

    private func surprisesSection(_ report: CodeGraphReport) -> some View {
        section(String(localized: "Surprising connections"), icon: "sparkles", tint: .pink) {
            ForEach(report.surprises) { link in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(verbatim: link.from).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                        Text(verbatim: "─\(link.relation)→").font(.caption).foregroundStyle(.secondary).fixedSize()
                        Text(verbatim: link.to).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        GraphChip(text: link.confidence == "INFERRED" ? String(localized: "Inferred") : String(localized: "Extracted"),
                                  tint: link.confidence == "INFERRED" ? .purple : .blue)
                    }
                    if let from = CodeGraphText.fileName(link.fromFile), let to = CodeGraphText.fileName(link.toFile) {
                        Text(verbatim: "\(from) → \(to)")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                            .help("\(link.fromFile ?? "") → \(link.toFile ?? "")")
                    }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func hubsSection(_ report: CodeGraphReport) -> some View {
        section(String(localized: "Community hubs"), icon: "signpost.right.and.left", tint: .indigo) {
            HubFlow(spacing: 6) {
                ForEach(report.hubs, id: \.self) { hub in
                    GraphChip(text: hub, tint: .indigo, monospaced: true)
                }
                if report.hubCount > report.hubs.count {
                    GraphChip(text: String(localized: "and \(report.hubCount - report.hubs.count) more"), tint: .secondary)
                }
            }
        }
    }

    private func section(_ title: String, icon: String, tint: Color, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(title).font(.headline)
            } icon: {
                Image(systemName: icon).foregroundStyle(tint)
            }
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }

    // MARK: Empty state

    private var emptyState: some View {
        let reply = graph.reply
        let blocked = CodeGraphText.buildBlockedReason(reply, unsupported: graph.unsupported)
        return VStack(spacing: 12) {
            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                .font(.system(size: 40))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            if store.projectURL == nil {
                Text(CodeGraphText.refusal(code: "no_project", fallback: "")).font(.headline)
            } else if graph.unsupported {
                Text(SessionToolsSupport.updateReason).font(.headline).multilineTextAlignment(.center)
            } else if reply == nil {
                ProgressView().controlSize(.small)
                Text("Reading the code graph…").font(.callout).foregroundStyle(.secondary)
            } else if let error = reply?.reportError {
                Text(error == "too_large" ? String(localized: "The report is too large to read here — open graph.html")
                     : String(localized: "The report could not be read"))
                    .font(.headline).multilineTextAlignment(.center)
            } else {
                Text("No code graph yet").font(.headline)
                Text(CodeGraphText.buildNote).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            if let reply, !graph.unsupported {
                Button {
                    Task { await store.buildCodeGraph() }
                } label: {
                    Label(String(localized: "Build"), systemImage: "hammer")
                }
                .buttonStyle(.borderedProminent)
                .disabled(blocked != nil)
                .help(blocked ?? String(localized: "Runs graphify update . in the project — in the background, without tokens"))
                .accessibilityIdentifier("Build code graph")
                if let blocked, reply.build?.running != true {
                    Text(blocked).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    if reply.graphify == nil {
                        Text(CodeGraphText.installHint).font(.caption.monospaced()).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).textSelection(.enabled)
                    }
                }
                buildLine(reply)
            }
            if let error = graph.errorText {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }
}

/// One bar: rank, name, the bar (its share of the largest), the number.
private struct BarRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rank: Int?
    let name: String
    let value: Int
    let share: Double
    let tint: Color
    let valueLabel: String
    var detail: String?
    @State private var shown = false

    var body: some View {
        HStack(spacing: 8) {
            if let rank {
                Text(verbatim: "\(rank)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 18, alignment: .trailing)
            }
            Text(verbatim: name)
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 190, alignment: .leading)
                .help(detail.map { "\(name) · \($0)" } ?? name)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(tint.wash(colorScheme, light: 0.10, dark: 0.16))
                    Capsule()
                        .fill(LinearGradient(colors: [tint.opacity(0.75), tint], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(4, geo.size.width * (shown || reduceMotion ? share : 0)))
                }
            }
            .frame(height: 10)
            Text(value, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 46, alignment: .trailing)
        }
        .frame(height: 20)
        .onAppear {
            guard !shown else { return }
            if reduceMotion { shown = true } else { withAnimation(.easeOut(duration: 0.45)) { shown = true } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(name), \(valueLabel)" + (detail.map { ", \($0)" } ?? "")))
    }
}

/// A small capsule (confidence, hubs).
private struct GraphChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: String
    let tint: Color
    var monospaced = false

    var body: some View {
        Text(verbatim: text)
            .font(monospaced ? .caption.monospaced() : .caption2.weight(.semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tint.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
            .fixedSize()
    }
}

/// Chips that wrap onto the next line.
private struct HubFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
