import SwiftUI
import ReviewGateCore

/// §21 entry points shared by the review surfaces: the small "왜?" capsule, the "곁질문 N" badge and the context-menu
/// items. All of them hide on an engine without side questions.

/// One click: asks the default "why" question about `anchor` in the side panel (the main conversation is untouched).
struct AskWhyButton: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let anchor: SideAnchor
    /// The question to ask instead of the default one (permission card: "Why is this needed?").
    var question: String?
    var title: LocalizedStringKey = "Why?"
    /// Icon only (dense rows).
    var iconOnly = false

    var body: some View {
        if store.side.isSupported {
            Button {
                store.side.askNow(anchor: anchor, question: question)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "questionmark.bubble.fill").font(.system(size: 9, weight: .bold))
                    if !iconOnly { Text(title).font(.caption2.weight(.semibold)) }
                }
                .padding(.horizontal, iconOnly ? 4 : 6).padding(.vertical, 2)
                .foregroundStyle(Color.teal)
                .background(Color.teal.wash(colorScheme, light: 0.14, dark: 0.22), in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help(Text("Ask in a side question — the main conversation is not affected"))
            .accessibilityLabel(Text("Ask why in a side question"))
            .accessibilityIdentifier("Ask why")
        }
    }
}

/// "곁질문 2": threads anchored here; a click opens the newest one.
struct SideBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let threads: [SideThread]

    var body: some View {
        if !threads.isEmpty {
            let running = threads.contains(where: \.isRunning)
            Button {
                if let newest = threads.first { store.side.select(newest.id) }
            } label: {
                HStack(spacing: 3) {
                    if running {
                        PulseDot(color: .teal, size: 4).frame(width: 7, height: 7)
                    } else {
                        Image(systemName: "bubble.left.and.text.bubble.right.fill").font(.system(size: 8, weight: .bold))
                    }
                    Text("Side \(threads.count)").font(.caption2.weight(.semibold).monospacedDigit())
                }
                .padding(.horizontal, 5).padding(.vertical, 1)
                .foregroundStyle(Color.teal)
                .background(Color.teal.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help(Text("\(threads.count) side questions here — click to open the newest"))
            .accessibilityIdentifier("Side badge")
        }
    }
}

/// Context-menu items: ask the default question now, or open the question field on this anchor.
struct SideQuestionMenuItems: View {
    @Environment(AppState.self) private var store
    let anchor: SideAnchor
    var whyTitle: LocalizedStringKey = "Ask Why It Changed"
    var composeTitle: LocalizedStringKey = "Side Question…"

    var body: some View {
        if store.side.isSupported {
            Button(whyTitle, systemImage: "questionmark.bubble") { store.side.askNow(anchor: anchor) }
            Button(composeTitle, systemImage: "bubble.left.and.text.bubble.right") { store.side.compose(anchor: anchor) }
        }
    }
}

/// MARK: r2-skills-side — §21 (M18): [메인 대화로 보내기] — a skill or slash command asked in a side question goes to the main
/// conversation as typed (queued while a turn runs). `key`: the thread id, "" for the new-question view.
struct SideSendToMainButton: View {
    @Environment(AppState.self) private var store
    let key: String
    /// The line saying why (off where a refusal above says it already).
    var showsReason = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsReason {
                Text("Skills and slash commands run in the main conversation — send the question there as typed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                guard let queued = store.side.sendToMain(key) else { return }
                Toast.show(queued ? String(localized: "Queued for the main conversation — sent when Claude is free")
                                  : String(localized: "Sent to the main conversation"),
                           systemImage: "arrowshape.turn.up.left.fill")
            } label: {
                // Not "Send to main": that one turns the answer into an instruction first; this sends the question itself.
                Label("Send the question to the main conversation as typed", systemImage: "arrowshape.turn.up.left.fill")
                    .lineLimit(1)   // a panel dragged narrow cuts the words ("…"), never the button; the tooltip says it all
            }
            .buttonStyle(.borderedProminent)
            .tint(.teal)
            .controlSize(.small)
            .help("Sends it to the main conversation as typed; while Claude works it waits in the queue")
            .accessibilityIdentifier("Side send to main conversation")
        }
    }
}

/// The anchor as a monospaced chip (`src/a.ts:42`, "Bash call", "Past review").
struct SideAnchorChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let anchor: SideAnchor?
    var toolName: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 9, weight: .semibold))
            // MARK: r2-skills-side — P3-transcript-22: a cut chip shows all of itself on hover.
            TruncatedText(SideQuestionText.chip(anchor, toolName: toolName))
                .font(.caption2.monospaced().weight(.medium))
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .foregroundStyle(.secondary)
        .background(Color.secondary.wash(colorScheme, light: 0.10, dark: 0.16), in: RoundedRectangle(cornerRadius: 4))
    }

    private var icon: String {
        if anchor?.pr != nil { return "arrow.triangle.pull" }   // wave3 mac-flow (§36.14)
        if anchor?.entryId != nil { return "clock.arrow.circlepath" }
        if anchor?.path != nil { return anchor?.line != nil ? "text.line.first.and.arrowtriangle.forward" : "doc.text" }
        if anchor?.toolUseId != nil { return "terminal" }
        return "bubble.left"
    }
}
