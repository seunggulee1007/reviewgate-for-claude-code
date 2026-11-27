import SwiftUI
import ReviewGateCore

// MARK: §72.2 — docs/PROTOCOL.md §72.2: `/output-style` in a classic chat — the styles the session offers (built-in and
// custom), the current one marked, and Use Style, which switches it the terminal's way: the CLI writes `outputStyle` to
// `.claude/settings.local.json` and uses it from the next message.

struct OutputStyleSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// The composer's line after a switch (or a refusal).
    let done: (String, Bool) -> Void
    @State private var reply: OutputStylesReply?
    @State private var failure: String?
    @State private var selection: String?
    @State private var switching = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: OutputStyleText.title).font(.headline)
            Text(verbatim: OutputStyleText.subtitle).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            content
                .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 360, alignment: .topLeading)
            if let line = OutputStyleText.setIn(reply?.setIn) {
                Text(verbatim: line).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("outputStyle.setIn")
            }
            if let reply, !reply.canSet {
                Text(verbatim: OutputStyleText.why(reply.why)).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("outputStyle.why")
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                let blocker = useBlocker
                Button(OutputStyleText.useButton) { use() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(blocker != nil)
                    .help(blocker ?? String(localized: "Switch to this style — Claude uses it from your next message"))
                    .accessibilityIdentifier("outputStyle.use")
            }
        }
        .padding(16)
        .frame(width: 520)
        .task { await load() }
        .accessibilityIdentifier("Output style sheet")
    }

    @ViewBuilder private var content: some View {
        if let failure {
            Text(verbatim: failure).font(.callout).foregroundStyle(.red).textSelection(.enabled)
        } else if let reply {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(reply.styles) { style in
                        StyleRow(style: style, isCurrent: isCurrent(style.name, reply), isSelected: selection == style.name)
                            .contentShape(Rectangle())
                            .onTapGesture { selection = style.name }
                            .simultaneousGesture(TapGesture(count: 2).onEnded {
                                selection = style.name
                                if useBlocker == nil { use() }
                            })
                    }
                }
            }
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(verbatim: OutputStyleText.loading).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func isCurrent(_ name: String, _ reply: OutputStylesReply) -> Bool {
        reply.current?.caseInsensitiveCompare(name) == .orderedSame
    }

    private var useBlocker: String? {
        if switching { return String(localized: "Switching…") }
        guard let reply else { return OutputStyleText.loading }
        guard let selection else { return String(localized: "Pick a style first") }
        return reply.blocker(for: selection)
    }

    private func load() async {
        do {
            let r = try await store.outputStyles()
            reply = r
            selection = r.styles.first { isCurrent($0.name, r) }?.name ?? r.styles.first?.name
            failure = nil
        } catch {
            failure = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    private func use() {
        guard let selection else { return }
        switching = true
        Task {
            defer { switching = false }
            do {
                let r = try await store.setOutputStyle(selection)
                reply = r
                done(OutputStyleText.switched(r.current ?? selection), false)
                dismiss()
            } catch {
                done((error as? EngineClientError)?.userMessage ?? error.localizedDescription, true)
            }
        }
    }
}

/// One style: its name, where it comes from, its line; the current one checked, the picked one highlighted.
private struct StyleRow: View {
    let style: OutputStyleInfo
    let isCurrent: Bool
    let isSelected: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isCurrent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: OutputStyleText.displayName(style.name)).font(.callout.weight(.medium))
                    if style.source != .builtin {   // five times "기본 제공" says nothing; a custom style's origin does
                        Text(verbatim: OutputStyleText.source(style)).font(.caption).foregroundStyle(.secondary)
                    }
                    if isCurrent {
                        Text(verbatim: OutputStyleText.current).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                    }
                }
                if let line = OutputStyleText.description(of: style) {
                    Text(verbatim: line).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5).padding(.horizontal, 8)
        .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .help(style.path.map { SessionNotices.abbreviatingHome($0) } ?? OutputStyleText.source(style))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("outputStyle.row.\(style.name)")
    }
}
