import SwiftUI
import ReviewGateCore

/// Messages queued while Claude is busy, as chips above the composer: click to edit, move earlier / later, send now, remove.
/// A status line says when they go out — or why they stopped (an error; "Resume" restarts). §50.1: a stop that goes on by
/// itself (the API, the usage limit) says when, with "지금 보내기". MARK: composer — §50.2: the messages already put into
/// Claude's turn wait here too until Claude reads them, as the terminal shows them above its input. §50.3: until then
/// each can be taken back (×) or brought back into the message box to edit (✎), as ↑ does in the terminal.
struct ComposerQueueBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let messages: [QueuedMessage]
    /// MARK: composer — §50.2: put into the running turn, not read by Claude yet.
    var steering: [SteeringMessage] = []
    /// §50.3: the ones being taken back (their chips wait), and the take-back (`toComposer`: Edit).
    var takingBack: Set<String> = []
    var onTakeBack: (String, Bool) -> Void = { _, _ in }
    /// §50.3: a queued message into the message box (Edit in Message Box).
    var onEditInComposer: (UUID) -> Void = { _ in }
    let stopAndSend: String?
    let pausedReason: String?
    let holdReason: String?
    /// wave3 mac-agents (§36.4): the main turn waits on subagents — the messages go once they (and the turn) finish.
    var waitingOnAgents = false
    var onUpdate: (UUID, String) -> Void = { _, _ in }
    var onRemove: (UUID) -> Void = { _ in }
    /// MARK: composer — §50.2: "Send now" on a queued message, and what it would do (its tooltip).
    var onSendNow: (UUID) -> Void = { _ in }
    var sendNowAction: (UUID) -> QueuedSendNow? = { _ in nil }
    var onMove: (UUID, Int) -> Void = { _, _ in }
    var onResume: () -> Void = {}
    var onClear: () -> Void = {}
    /// §50.3: the screenshot tour's check that the tools are on screen (DEBUG builds report; release builds ignore it).
    var debugToolFrame: (String, CGRect) -> Void = { _, _ in }

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
                    .foregroundStyle(store.queueResumesAt == nil ? Color.red : Color.orange)
                    if let resumesAt = store.queueResumesAt {
                        Text(verbatim: QueueStop.resumesText(resumesAt))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                            .accessibilityIdentifier("Queue resumes at")
                        Button(QueueStop.sendNowTitle, action: onResume)
                            .controlSize(.small)
                            .accessibilityIdentifier("Send queue now")
                    } else {
                        Button("Resume", action: onResume)
                            .controlSize(.small)
                            .accessibilityIdentifier("Resume queue")
                    }
                } else if let holdReason {
                    Label(holdReason, systemImage: "hourglass").foregroundStyle(.orange).lineLimit(1)
                } else if waitingOnAgents {
                    Label("Sends when the agents finish", systemImage: "person.2.wave.2")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(Text(verbatim: statusText))
                        .accessibilityIdentifier("Queue waits for agents")
                } else if messages.isEmpty, stopAndSend == nil, !steering.isEmpty {
                    // MARK: composer — §50.2
                    Label(steeringText, systemImage: "arrow.turn.down.right")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(Text(verbatim: steeringText))
                        .accessibilityIdentifier("Queue steering status")
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
            // §50.3: one message a row, as the terminal lists them above its input — every message's tools stay in sight in
            // the narrow chat column (a row of chips scrolled the later ones and their tools out of the window). More than
            // `visibleRows` scroll within the bar.
            if rowCount > Self.visibleRows {
                ScrollView(.vertical) { chipRows }
                    .frame(height: CGFloat(Self.visibleRows) * Self.rowHeight + CGFloat(Self.visibleRows - 1) * Self.rowSpacing)
            } else {
                chipRows
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Message queue")
    }

    private static let visibleRows = 3
    private static let rowHeight: CGFloat = 24
    private static let rowSpacing: CGFloat = 4

    private var rowCount: Int { steering.count + messages.count + (stopAndSend == nil ? 0 : 1) }

    private var chipRows: some View {
        VStack(alignment: .leading, spacing: Self.rowSpacing) {
            ForEach(Array(steering.enumerated()), id: \.element.id) { index, message in   // MARK: composer (§50.2)
                steeringChip(message, reports: index == 0)
            }
            if let stopAndSend {
                chip(index: nil, text: stopAndSend, id: nil)
            }
            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                chip(index: index, text: message.text, id: message.id)
            }
        }
        .padding(.vertical, 1)
    }

    private var statusText: String {
        String(localized: "\(messages.count) queued — sent in order when Claude is free")
    }

    /// MARK: composer — §50.2
    private var steeringText: String {
        String(localized: "In Claude's turn — Claude reads it after the current step")
    }

    /// MARK: composer — §50.2: what "Send now" does to this message now.
    static func sendNowHelp(_ action: QueuedSendNow?) -> String {
        switch action {
        case .steer?: String(localized: "Send now — into Claude's turn: Claude reads it after the current step")
        case .stopAndSend?: String(localized: "Send now — stops Claude's turn and sends this message right after")
        case .first?, nil: String(localized: "Send now — this message goes first")
        }
    }

    /// §50.3: what a steering chip's tools say (and, while it is being taken back, why they wait).
    static let takeBackEditHelp = String(localized: "Edit — takes it back from Claude's turn into the message box (↑ in an empty box does too); ↩ sends it again")
    static let takeBackRemoveHelp = String(localized: "Take back — Claude never sees it")
    static let takingBackHelp = String(localized: "Taking it back from Claude's turn…")

    /// MARK: composer — §50.2: a message already in Claude's turn, waiting until Claude reads it. §50.3: until then ✎ brings
    /// it back into the message box and × takes it back (the CLI drops it); too late, the box says so and its row stays.
    private func steeringChip(_ message: SteeringMessage, reports: Bool) -> some View {
        let busy = takingBack.contains(message.id)
        return HStack(spacing: 5) {
            Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary)
            Text(verbatim: message.text.replacingOccurrences(of: "\n", with: " "))
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if busy {
                ProgressView().controlSize(.mini)
                    .help(Self.takingBackHelp)
                    .accessibilityLabel(Self.takingBackHelp)
            } else {
                Button { onTakeBack(message.id, true) } label: {
                    Image(systemName: "pencil").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help(Self.takeBackEditHelp)
                .accessibilityLabel("Edit the message in Claude's turn")
                .accessibilityIdentifier("Edit steering message")
                .queueToolFrame(reports ? "steer.edit" : nil, debugToolFrame)
                Button { onTakeBack(message.id, false) } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help(Self.takeBackRemoveHelp)
                .accessibilityLabel("Take back the message in Claude's turn")
                .accessibilityIdentifier("Take back steering message")
                .queueToolFrame(reports ? "steer.takeBack" : nil, debugToolFrame)
            }
        }
        .padding(.leading, 6).padding(.trailing, 8).padding(.vertical, 4)
        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
        .contentShape(Capsule())
        .onTapGesture { if !busy { onTakeBack(message.id, true) } }
        .help(Text(verbatim: message.text + "\n\n" + (busy ? Self.takingBackHelp : String(localized: "In Claude's turn — Claude reads it after the current step. Until then, click to edit it or × to take it back."))))
        .contextMenu {
            Button("Edit in Message Box") { onTakeBack(message.id, true) }
                .disabled(busy)
                .help(busy ? Self.takingBackHelp : Self.takeBackEditHelp)
            Divider()
            Button("Take Back", role: .destructive) { onTakeBack(message.id, false) }
                .disabled(busy)
                .help(busy ? Self.takingBackHelp : Self.takeBackRemoveHelp)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Steering message")
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
                .frame(maxWidth: .infinity, alignment: .leading)
            if let id {
                // §50.3: edit in sight, not only behind a click on the chip.
                Button { editing = id } label: {
                    Image(systemName: "pencil").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help("Edit this queued message")
                .accessibilityLabel("Edit queued message \(index.map { $0 + 1 } ?? 0)")
                .accessibilityIdentifier("Edit queued message")
                .queueToolFrame(index == 0 ? "queued.edit" : nil, debugToolFrame)
                // MARK: composer — §50.2: as in the terminal, a queued message can go at once.
                Button { onSendNow(id) } label: {
                    Image(systemName: "paperplane").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help(Self.sendNowHelp(sendNowAction(id)))
                .accessibilityLabel("Send queued message \(index.map { $0 + 1 } ?? 0) now")
                .accessibilityIdentifier("Send queued message now")
                Button { onRemove(id) } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                .padding(.vertical, -2)
                .foregroundStyle(.secondary)
                .help("Remove from the queue")
                .accessibilityLabel("Remove queued message \(index.map { $0 + 1 } ?? 0)")
                .accessibilityIdentifier("Remove queued message")
                .queueToolFrame(index == 0 ? "queued.remove" : nil, debugToolFrame)
            }
        }
        .padding(.leading, 6).padding(.trailing, 8).padding(.vertical, 4)
        .background(Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.20), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.accentColor.wash(colorScheme, light: isNext ? 0.55 : 0.25, dark: isNext ? 0.65 : 0.30)))
        .contentShape(Capsule())
        .onTapGesture { if let id { editing = id } }
        .help(Text(verbatim: id == nil ? text : text + "\n\n" + String(localized: "Queued — click to edit; ↑ in an empty message box (or Esc while Claude works) brings everything waiting back")))
        .popover(isPresented: Binding(get: { id != nil && editing == id }, set: { if !$0 { editing = nil } }), arrowEdge: .top) {
            if let id, let index {
                QueuedMessageEditor(text: text, index: index, count: messages.count,
                                    onSave: { onUpdate(id, $0); editing = nil },
                                    onSendNow: { onUpdate(id, $0); onSendNow(id); editing = nil },   // MARK: composer (§50.2)
                                    sendNowHelp: Self.sendNowHelp(sendNowAction(id)),
                                    onMove: { onMove(id, $0) },
                                    onRemove: { onRemove(id); editing = nil })
            }
        }
        .contextMenu {
            if let id, let index {
                Button("Edit…") { editing = id }
                Button("Edit in Message Box") { onEditInComposer(id) }   // §50.3
                    .help("Takes it out of the queue into the message box; ↩ sends it")
                Button("Send Now") { onSendNow(id) }   // MARK: composer (§50.2)
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

private extension View {
    /// §50.3: reports where a tool is (`name` nil: not this chip) to the screenshot tour; nothing in a release build.
    @ViewBuilder
    func queueToolFrame(_ name: String?, _ report: @escaping (String, CGRect) -> Void) -> some View {
        #if DEBUG
        if let name {
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { report(name, $0) }
                .onDisappear { report(name, .zero) }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// The popover behind a queue chip.
private struct QueuedMessageEditor: View {
    @State var text: String
    let index: Int
    let count: Int
    var onSave: (String) -> Void
    /// MARK: composer — §50.2: saves the text, then sends it now.
    var onSendNow: (String) -> Void
    var sendNowHelp: String
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
                Button("Send Now") { onSendNow(text) }   // MARK: composer (§50.2)
                    .help(sendNowHelp)
                Button("Save") { onSave(text) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
    }
}
