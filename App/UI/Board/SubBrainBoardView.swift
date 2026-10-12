import AppKit
import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the board's "서브브레인" tab. What Claude's auto memory holds (cards per
// kind), how the memories link (a graph: MEMORY.md in the middle, this session's memories shimmering), a memory's text on the
// right (read only), and below it this session's timeline, the latest edits and the index's gaps. The engine re-reads the
// folder every 4 s while the tab is shown (`brain {watch: true}`); nothing here writes a memory.

/// The tab's content (the board gives it no arguments: the state comes from the environment).
struct SubBrainBoardView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let brain = store.subBrain
        Group {
            if store.state.project == nil {
                SubBrainNotice(symbol: "folder", title: Text("Open a project to see what Claude remembers about it"),
                               detail: Text("Each repository has its own auto memory; every workbench of it shares one."))
            } else if brain.unsupported {
                SubBrainNotice(symbol: "exclamationmark.triangle", title: Text("Needs the engine of this app version — reopen the project"),
                               detail: Text("This engine does not read Claude's auto memory yet."))
            } else if let snap = brain.snapshot {
                if snap.memories.isEmpty {
                    SubBrainNotice(symbol: "brain", title: Text("This project has no auto memory yet"),
                                   detail: Text("Claude keeps what it learns in your chats here — your preferences, feedback, facts about the project. Once it does, they show up as a graph."),
                                   path: snap.dir, error: snap.error)
                } else {
                    SubBrainContent(snapshot: snap)
                }
            } else if let error = brain.errorText {
                SubBrainNotice(symbol: "exclamationmark.triangle", title: Text("The sub-brain could not be read"), detail: Text(error))
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: store.state.project?.path) {
            guard store.state.project != nil else {
                brain.reset()
                return
            }
            await brain.start(store)
        }
        .onDisappear { Task { await brain.stop() } }
        .accessibilityIdentifier("Sub-brain")
    }
}

// ---------------------------------------------------------------- colors

/// One color per kind, readable on both appearances (light: darker, dark: lighter).
enum SubBrainPalette {
    static func color(_ type: BrainMemoryType?, dark: Bool) -> Color {
        guard let type else { return dark ? Color(red: 0.98, green: 0.83, blue: 0.45) : Color(red: 0.70, green: 0.50, blue: 0.05) }
        switch type {
        case .user: return dark ? Color(red: 0.96, green: 0.60, blue: 0.86) : Color(red: 0.70, green: 0.24, blue: 0.58)
        case .feedback: return dark ? Color(red: 1.00, green: 0.70, blue: 0.40) : Color(red: 0.74, green: 0.40, blue: 0.00)
        case .project: return dark ? Color(red: 0.52, green: 0.72, blue: 1.00) : Color(red: 0.16, green: 0.42, blue: 0.84)
        case .reference: return dark ? Color(red: 0.45, green: 0.84, blue: 0.62) : Color(red: 0.13, green: 0.52, blue: 0.32)
        case .other: return dark ? Color(white: 0.68) : Color(white: 0.42)
        }
    }
}

// ---------------------------------------------------------------- empty / older engine

private struct SubBrainNotice: View {
    let symbol: String
    let title: Text
    let detail: Text
    var path: String?
    var error: String?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundStyle(.tertiary).accessibilityHidden(true)
            title.font(.headline)
            detail.font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
            if let path {
                Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// ---------------------------------------------------------------- the tab

private struct SubBrainContent: View {
    let snapshot: BrainSnapshot

    var body: some View {
        VStack(spacing: 0) {
            SubBrainHeader(snapshot: snapshot)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            Divider()
            HSplitView {
                SubBrainGraphView(snapshot: snapshot)
                    .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                SubBrainMemoryPanel()
                    .frame(minWidth: 240, idealWidth: 300, maxWidth: 420, maxHeight: .infinity)
            }
            .frame(minHeight: 280)
            Divider()
            SubBrainLists(snapshot: snapshot)
                .frame(height: 210)
        }
    }
}

/// Cards per kind, "이번 세션에 쌓인 것 N개", where the folder is.
private struct SubBrainHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    let snapshot: BrainSnapshot

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            ForEach(BrainMemoryType.shown, id: \.self) { type in
                KindCard(type: type, count: snapshot.count(type), dark: colorScheme == .dark)
            }
            if snapshot.count(.other) > 0 {
                KindCard(type: .other, count: snapshot.count(.other), dark: colorScheme == .dark)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: "sparkles").foregroundStyle(snapshot.sessionCount > 0 ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                    Text("Added this session: \(snapshot.sessionCount)").font(.callout.weight(.semibold))
                }
                if let dir = snapshot.dir {
                    Text(dir).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                        .frame(maxWidth: 320, alignment: .trailing).help(dir)
                }
            }
        }
    }
}

private struct KindCard: View {
    let type: BrainMemoryType
    let count: Int
    let dark: Bool

    var body: some View {
        let tint = SubBrainPalette.color(type, dark: dark)
        HStack(spacing: 7) {
            Image(systemName: SubBrainText.symbol(type))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 26, height: 26)
                .background(Circle().fill(tint.opacity(0.16)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: "\(count)").font(.title3.weight(.bold).monospacedDigit())
                Text(SubBrainText.typeName(type)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(tint.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(tint.opacity(0.28)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(SubBrainText.typeName(type)) \(count)"))
    }
}

// ---------------------------------------------------------------- the graph

private struct SubBrainGraphView: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let snapshot: BrainSnapshot

    @State private var layout: [BrainPoint] = []
    @State private var layoutKey = ""
    @State private var zoom: Double = 1
    @State private var pinch: Double = 1
    @State private var pan: CGSize = .zero
    @State private var drag: CGSize = .zero
    @State private var hovered: Int?

    private static let space = CGSize(width: 1000, height: 700)

    var body: some View {
        let brain = store.subBrain
        let graph = SubBrainGraph.build(snapshot, hiddenTypes: brain.hiddenTypes)
        let key = graph.nodes.map(\.id).joined(separator: "|") + "#\(graph.edges.count)"
        let dark = colorScheme == .dark
        // Read here, not only inside the Canvas closure: a state read there alone would not redraw the graph.
        let points = layout
        let scale = zoom * pinch
        let shift = CGSize(width: pan.width + drag.width, height: pan.height + drag.height)
        let hover = hovered
        let selected = brain.selected
        let still = reduceMotion || !graph.nodes.contains { $0.session != nil }
        VStack(alignment: .leading, spacing: 0) {
            GraphControls(graph: graph, zoom: $zoom, pan: $pan)
                .padding(.horizontal, 8)
                .padding(.top, 8)
            GeometryReader { geo in
                let fit = Self.fitting(geo.size, scale: scale, shift: shift)
                TimelineView(.animation(minimumInterval: 1 / 20, paused: still)) { timeline in
                    let phase = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                    Canvas { context, _ in
                        Self.draw(graph, points: points, in: &context, fit: fit, dark: dark, phase: phase, selected: selected, hovered: hover,
                                  labels: graph.nodes.count <= 40 || scale >= 1.8)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .local) { location in
                    let hit = Self.node(at: location, graph: graph, points: layout, fit: fit)
                    Task { await brain.select(hit.map { graph.nodes[$0].id }) }
                }
                .onContinuousHover { phase in
                    if case let .active(location) = phase {
                        hovered = Self.node(at: location, graph: graph, points: layout, fit: fit)
                    } else {
                        hovered = nil
                    }
                }
                .gesture(DragGesture(minimumDistance: 4)
                    .onChanged { drag = $0.translation }
                    .onEnded { value in
                        pan.width += value.translation.width
                        pan.height += value.translation.height
                        drag = .zero
                    })
                .simultaneousGesture(MagnifyGesture()
                    .onChanged { pinch = $0.magnification }
                    .onEnded { value in
                        zoom = min(4, max(0.4, zoom * value.magnification))
                        pinch = 1
                    })
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Memory graph: \(graph.nodes.count) memories, \(graph.edges.filter { !$0.isIndex }.count) links"))
                .accessibilityHint(Text("The lists below name the same memories."))
            }
            .clipped()
        }
        .task(id: key) {
            guard key != layoutKey else { return }
            let width = Self.space.width, height = Self.space.height
            let computed = await Task.detached(priority: .userInitiated) {
                SubBrainLayout.layout(graph, width: width, height: height)
            }.value
            layout = computed
            layoutKey = key
        }
    }

    /// Layout space → view: fit the 1000 × 700 space, then the user's zoom and pan.
    private struct Fit {
        var scale: Double
        var origin: CGPoint
        func point(_ p: BrainPoint) -> CGPoint { CGPoint(x: origin.x + p.x * scale, y: origin.y + p.y * scale) }
    }

    private static func fitting(_ size: CGSize, scale zoom: Double, shift: CGSize) -> Fit {
        let base = min(size.width / space.width, size.height / space.height)
        let scale = base * zoom
        let origin = CGPoint(x: size.width / 2 - space.width / 2 * scale + shift.width,
                             y: size.height / 2 - space.height / 2 * scale + shift.height)
        return Fit(scale: scale, origin: origin)
    }

    private static func radius(_ node: BrainGraphNode) -> Double {
        node.isHub ? 15 : 6 + Double(min(node.degree, 6))
    }

    private static func node(at location: CGPoint, graph: BrainGraph, points: [BrainPoint], fit: Fit) -> Int? {
        guard points.count == graph.nodes.count else { return nil }
        var best: (Int, Double)?
        for (i, p) in points.enumerated() {
            let c = fit.point(p)
            let d = Double(hypot(c.x - location.x, c.y - location.y))
            if d <= radius(graph.nodes[i]) + 6, d < (best?.1 ?? .infinity) { best = (i, d) }
        }
        return best?.0
    }

    private static func draw(_ graph: BrainGraph, points: [BrainPoint], in context: inout GraphicsContext, fit: Fit, dark: Bool, phase: Double,
                             selected: String?, hovered: Int?, labels showAllLabels: Bool) {
        guard points.count == graph.nodes.count else { return }
        let edgeColor = dark ? Color.white : Color.black
        for e in graph.edges {
            var path = Path()
            path.move(to: fit.point(points[e.from]))
            path.addLine(to: fit.point(points[e.to]))
            context.stroke(path, with: .color(edgeColor.opacity(e.isIndex ? 0.07 : 0.32)), lineWidth: e.isIndex ? 0.6 : 1.2)
        }
        for (i, node) in graph.nodes.enumerated() {
            let c = fit.point(points[i])
            let r = radius(node)
            let tint = SubBrainPalette.color(node.type, dark: dark)
            let rect = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
            if node.session != nil {
                // This session's memories shimmer (a still double ring with Reduce Motion).
                let pulse = phase == 0 ? 0.6 : 0.5 + 0.5 * sin(phase * 3)
                let glow = rect.insetBy(dx: -4 - 3 * pulse, dy: -4 - 3 * pulse)
                context.stroke(Path(ellipseIn: glow), with: .color(tint.opacity(0.35 + 0.45 * pulse)), lineWidth: 2)
            }
            context.fill(Path(ellipseIn: rect), with: .color(tint))
            context.stroke(Path(ellipseIn: rect), with: .color(dark ? Color.black.opacity(0.5) : Color.white), lineWidth: 1.2)
            if node.isHub {
                var brainImage = context.resolve(Image(systemName: "brain"))
                brainImage.shading = .color(dark ? .black : .white)
                context.draw(brainImage, in: rect.insetBy(dx: 4, dy: 4))
            }
            if node.id == selected {
                context.stroke(Path(ellipseIn: rect.insetBy(dx: -3, dy: -3)), with: .color(.accentColor), lineWidth: 2.5)
            }
            if showAllLabels || i == hovered || node.id == selected || node.isHub {
                let label = Text(node.label).font(.system(size: 10, weight: node.id == selected ? .semibold : .regular))
                    .foregroundStyle(dark ? Color.white.opacity(0.85) : Color.black.opacity(0.8))
                context.draw(label, at: CGPoint(x: c.x, y: c.y + r + 8), anchor: .center)
            }
        }
    }
}

/// The legend (a kind's dot turns it on / off), "N개 더", zoom buttons.
private struct GraphControls: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let graph: BrainGraph
    @Binding var zoom: Double
    @Binding var pan: CGSize

    var body: some View {
        let brain = store.subBrain
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                ForEach(BrainMemoryType.allCases, id: \.self) { type in
                    let off = brain.hiddenTypes.contains(type)
                    Button { brain.toggle(type) } label: {
                        HStack(spacing: 4) {
                            Circle().fill(SubBrainPalette.color(type, dark: colorScheme == .dark).opacity(off ? 0.25 : 1)).frame(width: 8, height: 8)
                            Text(SubBrainText.typeName(type)).font(.caption2).foregroundStyle(off ? .secondary : .primary)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(.regularMaterial))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(SubBrainText.typeName(type)))
                    .accessibilityValue(off ? Text("Hidden") : Text("Shown"))
                    .help(off ? Text("Show this kind in the graph") : Text("Hide this kind in the graph"))
                }
            }
            HStack(spacing: 4) {
                Button { zoom = min(4, zoom * 1.25) } label: { Image(systemName: "plus.magnifyingglass") }
                    .accessibilityLabel(Text("Zoom in"))
                Button { zoom = max(0.4, zoom / 1.25) } label: { Image(systemName: "minus.magnifyingglass") }
                    .accessibilityLabel(Text("Zoom out"))
                Button { zoom = 1; pan = .zero } label: { Image(systemName: "arrow.up.left.and.down.right.magnifyingglass") }
                    .accessibilityLabel(Text("Fit the graph"))
                    .help(Text("Fit the graph"))
                if graph.hidden > 0 {
                    Text("\(graph.hidden) more not drawn").font(.caption2).foregroundStyle(.secondary)
                        .help(Text("Only the memories changed this session, the most linked and the newest are drawn"))
                }
            }
            .buttonStyle(IconButtonStyle(padding: 2))   // the zoom buttons: `.borderless` left the glyphs alone as targets
            .controlSize(.small)
        }
    }
}

// ---------------------------------------------------------------- a memory's text

private struct SubBrainMemoryPanel: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let brain = store.subBrain
        Group {
            if let name = brain.selected, name == SubBrainGraph.hubId {
                VStack(alignment: .leading, spacing: 8) {
                    Label("MEMORY.md", systemImage: "brain").font(.headline)
                    Text("The index Claude reads at the start of every chat. Each line points to one memory.")
                        .font(.callout).foregroundStyle(.secondary)
                    if let dir = brain.snapshot?.dir { openButton(path: (dir as NSString).appendingPathComponent("MEMORY.md")) }
                    Spacer()
                }
                .padding(14)
            } else if let memory = brain.selectedMemory {
                memoryView(memory, brain: brain)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "hand.tap").font(.title2).foregroundStyle(.tertiary).accessibilityHidden(true)
                    Text("Click a memory in the graph to read it here.").font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    private func memoryView(_ memory: BrainMemory, brain: SubBrainStore) -> some View {
        let tint = SubBrainPalette.color(memory.type, dark: colorScheme == .dark)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: SubBrainText.symbol(memory.type)).foregroundStyle(tint).accessibilityHidden(true)
                Text(memory.label).font(.headline).lineLimit(2)
                Spacer(minLength: 4)
                Button { Task { await brain.select(nil) } } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle(padding: 2)).accessibilityLabel(Text("Close"))
            }
            HStack(spacing: 6) {
                Text(SubBrainText.typeName(memory.type)).font(.caption.weight(.semibold)).foregroundStyle(tint)
                    .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(tint.opacity(0.14)))
                if let session = memory.session {
                    Text(SubBrainText.verb(session)).font(.caption.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Color.accentColor.opacity(0.16)))
                }
                Text(relative(memory.mtime)).font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: "\(memory.name).md").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            if !memory.description.isEmpty { Text(memory.description).font(.callout).foregroundStyle(.secondary) }
            if !memory.links.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "link").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                    ForEach(memory.links.prefix(6), id: \.self) { link in
                        Button(link) { Task { await brain.select(link) } }.buttonStyle(.link).font(.caption)
                    }
                }
                .lineLimit(1)
            }
            Divider()
            ScrollView {
                Group {
                    if let text = brain.selectedText, text.name == memory.name {
                        Text(SubBrainText.readable(text.text)).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        if text.truncated { Text("Only the first 64 KB is shown.").font(.caption).foregroundStyle(.secondary) }
                    } else if let error = brain.selectedError {
                        Text(error).font(.callout).foregroundStyle(.red)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let path = brain.selectedText?.path ?? brain.snapshot?.dir.map({ ($0 as NSString).appendingPathComponent("\(memory.name).md") }) {
                openButton(path: path)
            }
        }
        .padding(14)
    }

    private func openButton(path: String) -> some View {
        let can = InstructionText.canOpen(path)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                guard InstructionText.canOpen(path) else { return }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            } label: { Label("Open in Editor", systemImage: "square.and.pencil") }
                .disabled(!can)
            if !can { Text("The file is not there anymore.").font(.caption).foregroundStyle(.secondary) }
        }
    }
}

/// "3분 전" in the user's language.
private func relative(_ ms: Double) -> String {
    guard ms > 0 else { return "" }
    return Date(timeIntervalSince1970: ms / 1000).formatted(.relative(presentation: .named))
}

// ---------------------------------------------------------------- the lists

private struct SubBrainLists: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let snapshot: BrainSnapshot

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            column(title: Text("In this session"), symbol: "sparkles") { timeline }
            Divider()
            column(title: Text("Recently changed"), symbol: "clock") { recent }
            Divider()
            column(title: Text("Index problems"), symbol: "list.bullet.rectangle") { problems }
        }
    }

    private func column<Content: View>(title: Text, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label { title } icon: { Image(systemName: symbol) }.font(.subheadline.weight(.semibold))
            ScrollView { VStack(alignment: .leading, spacing: 6) { content() }.frame(maxWidth: .infinity, alignment: .leading) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private var timeline: some View {
        if snapshot.changes.isEmpty {
            Text("Nothing yet. A memory Claude writes shows up here right away.").font(.caption).foregroundStyle(.secondary)
        } else {
            ForEach(snapshot.changes) { change in
                let tint = SubBrainPalette.color(change.type, dark: colorScheme == .dark)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: change.kind == .add ? "plus.circle.fill" : change.kind == .change ? "pencil.circle.fill" : "minus.circle.fill")
                        .foregroundStyle(change.kind == .add ? Color.green : change.kind == .change ? Color.orange : Color.red)
                        .accessibilityLabel(Text(SubBrainText.verb(change.kind)))
                    VStack(alignment: .leading, spacing: 1) {
                        Button { Task { await store.subBrain.select(change.name) } } label: {
                            Label { Text(change.label).lineLimit(1) } icon: { Image(systemName: SubBrainText.symbol(change.type)).foregroundStyle(tint) }
                        }
                        .buttonStyle(.plain)
                        .disabled(change.kind == .remove)
                        HStack(spacing: 4) {
                            // The writer's face from the agent board (§43.1): Claude's star or the subagent type's face.
                            if let face = SubBrainText.writerAvatar(change) {
                                AgentAvatarView(avatar: face, mood: .idle, size: 16, showsMood: false).accessibilityHidden(true)
                            }
                            Text(verbatim: "\(SubBrainText.writer(change)) · \(relative(change.at))").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.caption)
            }
        }
    }

    @ViewBuilder private var recent: some View {
        ForEach(Array(snapshot.memories.prefix(8))) { memory in
            let tint = SubBrainPalette.color(memory.type, dark: colorScheme == .dark)
            Button { Task { await store.subBrain.select(memory.name) } } label: {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Image(systemName: SubBrainText.symbol(memory.type)).foregroundStyle(tint).accessibilityHidden(true)
                        Text(memory.label).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(relative(memory.mtime)).foregroundStyle(.secondary)
                    }
                    if !memory.description.isEmpty {
                        Text(memory.description).lineLimit(1).foregroundStyle(.secondary).font(.caption2)
                    }
                }
                .font(.caption)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var problems: some View {
        if snapshot.unindexed.isEmpty && snapshot.missing.isEmpty && snapshot.brokenLinks.isEmpty {
            Label("No index problems", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
        }
        if !snapshot.hasIndex {
            Text("There is no MEMORY.md — Claude finds memories only through it.").font(.caption).foregroundStyle(.orange)
        }
        if !snapshot.unindexed.isEmpty {
            problem(Text("Not in MEMORY.md: \(snapshot.unindexed.count)"), snapshot.unindexed, select: true)
        }
        if !snapshot.missing.isEmpty {
            problem(Text("In MEMORY.md but no file: \(snapshot.missing.count)"), snapshot.missing, select: false)
        }
        if !snapshot.brokenLinks.isEmpty {
            problem(Text("Broken links: \(snapshot.brokenLinks.count)"), snapshot.brokenLinks.map { "\($0.from) → \($0.to)" }, select: false)
        }
    }

    private func problem(_ title: Text, _ names: [String], select: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            title.font(.caption.weight(.semibold)).foregroundStyle(.orange)
            ForEach(names.prefix(12), id: \.self) { name in
                if select {
                    Button(name) { Task { await store.subBrain.select(name) } }.buttonStyle(.link).font(.caption)
                } else {
                    Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if names.count > 12 { Text("\(names.count - 12) more").font(.caption2).foregroundStyle(.secondary) }
        }
    }
}
