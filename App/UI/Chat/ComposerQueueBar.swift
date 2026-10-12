import SwiftUI
import ReviewGateCore

/// Messages queued while Claude is busy, as chips above the composer: click to edit, move earlier / later, remove.
/// A status line says when they go out — or why they stopped (an error; "Resume" restarts).
struct ComposerQueueBar: View {
    @Environment(\.colorScheme) private var colorScheme
    let messages: [QueuedMessage]
    let stopAndSend: String?
    let pausedReason: String?
    let holdReason: String?
    /// wave3 mac-agents (§36.4): the main turn waits on subagents — the messages go once they (and the turn) finish.
    var waitingOnAgents = false
    var onUpdate: (UUID, String) -> Void = { _, _ in }
    var onRemove: (UUID) -> Void = { _ in }
    var onMove: (UUID, Int) -> Void = { _, _ in }
    var onResume: () -> Void = {}
    var onClear: () -> Void = {}

    @State private var editing: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let pausedReason {
                    Label {
                        Text("Queue stopped: \(pausedReason)").lineLimit(1).truncationMode(.tail)
                    } icon: {
                        Image(systemName: "pause.circle.fill")
                    }
                    .foregroundStyle(.red)
                    Button("Resume", action: onResume)
                        .controlSize(.small)
                        .accessibilityIdentifier("Resume queue")
                } else if let holdReason {
                    Label(holdReason, systemImage: "hourglass").foregroundStyle(.orange).lineLimit(1)
                } else if waitingOnAgents {
                    Label("Sends when the agents finish", systemImage: "person.2.wave.2")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(Text(verbatim: statusText))
                        .accessibilityIdentifier("Queue waits for agents")
                } else {
                    Label(statusText, systemImage: "tray.full").foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if !messages.isEmpty {
                    Button("Clear", action: onClear)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .accessibilityIdentifier("Clear queue")
                }
            }
            .font(.caption)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if let stopAndSend {
                        chip(index: nil, text: stopAndSend, id: nil)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        chip(index: index, text: message.text, id: message.id)
                    }
                }
                .padding(.vertical, 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Message queue")
    }

    private var statusText: String {
        String(localized: "\(messages.count) queued — sent in order when Claude is free")
    }

    @ViewBuilder
    private func chip(index: Int?, text: String, id: UUID?) -> some View {
        let isNext = index == 0 && stopAndSend == nil
        HStack(spacing: 5) {
            if let index {
                Text(verbatim: "\(index + 1)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .frame(minWidth: 14, minHeight: 14)
                    .background(Color.accentColor.opacity(isNext ? 0.9 : 0.35), in: Circle())
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "stop.circle.fill").font(.caption).foregroundStyle(.orange)
                    .help("Sent as soon as the stopped turn has ended")
            }
            Text(verbatim: text.replacingOccurrences(of: "\n", with: " "))
                .font(.callout)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 220, alignment: .leading)
            if let id {
                Button { onRemove(id) } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help("Remove from the queue")
                .accessibilityLabel("Remove queued message \(index.map { $0 + 1 } ?? 0)")
            }
        }
        .padding(.leading, 6).padding(.trailing, 8).padding(.vertical, 4)
        .background(Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.20), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.accentColor.wash(colorScheme, light: isNext ? 0.55 : 0.25, dark: isNext ? 0.65 : 0.30)))
        .contentShape(Capsule())
        .onTapGesture { if let id { editing = id } }
        .help(Text(verbatim: text))
        .popover(isPresented: Binding(get: { id != nil && editing == id }, set: { if !$0 { editing = nil } }), arrowEdge: .top) {
            if let id, let index {
                QueuedMessageEditor(text: text, index: index, count: messages.count,
                                    onSave: { onUpdate(id, $0); editing = nil },
                                    onMove: { onMove(id, $0) },
                                    onRemove: { onRemove(id); editing = nil })
            }
        }
        .contextMenu {
            if let id, let index {
                Button("Edit…") { editing = id }
                Button("Move Earlier") { onMove(id, -1) }.disabled(index == 0)
                Button("Move Later") { onMove(id, 1) }.disabled(index == messages.count - 1)
                Divider()
                Button("Remove", role: .destructive) { onRemove(id) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Queued message")
    }
}

/// The popover behind a queue chip.
private struct QueuedMessageEditor: View {
    @State var text: String
    let index: Int
    let count: Int
    var onSave: (String) -> Void
    var onMove: (Int) -> Void
    var onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Queued message \(index + 1) of \(count)").font(.headline)
            TextEditor(text: $text)
                .font(.body)
                .frame(width: 340, height: 110)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            HStack {
                Button { onMove(-1) } label: { Image(systemName: "arrow.left") }
                    .disabled(index == 0)
                    .help("Move earlier")
                    .accessibilityLabel("Move earlier")   // MARK: wave4d w4d-speed — polish-10 (read as "left arrow" before)
                Button { onMove(1) } label: { Image(systemName: "arrow.right") }
                    .disabled(index >= count - 1)
                    .help("Move later")
                    .accessibilityLabel("Move later")   // MARK: wave4d w4d-speed — polish-10
                Button("Remove", role: .destructive, action: onRemove)
                Spacer()
                Button("Save") { onSave(text) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
    }
}
