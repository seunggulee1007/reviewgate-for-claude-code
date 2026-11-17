import SwiftUI
import ReviewGateCore

// MARK: terminal-chat (§57.5)
/// The chat column of a terminal chat: the real Claude Code in a terminal under a thin strip — whether ReviewGate hears its
/// hooks, "Review now" when a turn Esc stopped stays open, Restart — and an overlay once Claude Code exited. A terminal
/// chat shown read-only (another chat is the live one) has no terminal: it offers to continue in it.
struct TerminalChatView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        let hub = model.terminals
        let live = store.currentSessionId
        if store.viewingChat != nil {
            ViewedTerminalChatPlaceholder()
        } else if let id = live, let host = hub.host(for: id) {
            VStack(spacing: 0) {
                TerminalStatusStrip(chatId: id, host: host)
                Divider()
                TerminalContainer(host: host)
                    .overlay { TerminalEndedOverlay(chatId: id, host: host) }
                    .accessibilityIdentifier("Terminal chat terminal")
            }
        } else if let id = live, let error = hub.specErrors[id] {
            TerminalStartProblem(chatId: id, message: error)
        } else {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Starting Claude Code…").font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Terminal chat starting")
        }
    }
}

/// The strip over the terminal: the hook link in a word, then "Review now" and Restart.
private struct TerminalStatusStrip: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let chatId: String
    let host: TerminalHost

    var body: some View {
        let info = store.terminalInfo
        HStack(spacing: 8) {
            let (text, symbol, tint, help) = status(info)
            // §57.5: beside the review panel the strip is the terminal's width — the words that fit, the shortest cut.
            ViewThatFits(in: .horizontal) {
                Label(text, systemImage: symbol)
                if text == Self.reviewedText {
                    Label(String(localized: "Reviewed by ReviewGate"), systemImage: symbol)
                }
            }
            .font(.caption)
            .foregroundStyle(tint)
            .lineLimit(1)
            .truncationMode(.tail)
            .help(help)
            .accessibilityIdentifier("Terminal chat status")
            Spacer(minLength: 4)
            TimelineView(.periodic(from: .now, by: 5)) { context in
                if showsReviewNow(info, now: context.date) {
                    Button("Review now") { Task { await store.endTerminalTurn() } }
                        .controlSize(.small)
                        .help(String(localized: "End this turn and review its changes now — after Esc Claude Code sends no end of turn, so the turn stays open until the next prompt"))
                        .accessibilityIdentifier("Terminal chat review now")
                }
            }
            Button {
                Task { await model.terminals.restart(chatId: chatId) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.icon)
            .controlSize(.small)
            .disabled(model.terminals.spawning.contains(chatId))
            .help(model.terminals.spawning.contains(chatId)
                  ? String(localized: "Claude Code is starting")
                  : String(localized: "Restart Claude Code in this terminal — the conversation is resumed; text typed and not sent is lost"))
            .accessibilityLabel(Text("Restart Claude Code"))
            .accessibilityIdentifier("Terminal chat restart")
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(host.disconnected ? Color.orange.opacity(0.12) : Color.clear)
    }

    /// "Review now": a tool call ended by Esc, or the turn has run 60 s with nothing from Claude Code.
    private func showsReviewNow(_ info: TerminalSessionInfo?, now: Date) -> Bool {
        guard store.isRunning, let info, info.running else { return false }
        return info.interruptSuspected || now.timeIntervalSince(model.terminals.lastActivity) >= 60
    }

    private static var reviewedText: String { String(localized: "Reviewed by ReviewGate — changes show on the right") }

    private func status(_ info: TerminalSessionInfo?) -> (String, String, Color, String) {
        if host.disconnected {
            return (String(localized: "ReviewGate restarted — this terminal is no longer reviewed. Restart it"), "bolt.horizontal.circle",
                    .orange, String(localized: "The engine that reviews this terminal restarted, so Claude Code's prompts and edits are refused until you restart the terminal (the conversation is resumed)"))
        }
        if let waiting = info?.waiting {
            let text = waiting.kind == .permission ? String(localized: "Claude Code waits for your permission in the terminal")
                                                   : String(localized: "Claude Code asked you a question in the terminal")
            return (text, "bell.badge", .orange, waiting.message)
        }
        if store.isRunning {
            return (String(localized: "Claude is working — the review opens when it stops"), "circle.dotted", .secondary,
                    String(localized: "ReviewGate takes a snapshot when you send a prompt and shows the turn's changes once Claude stops"))
        }
        if info?.hooksSeen == true {
            return (Self.reviewedText, "checkmark.shield", .secondary,
                    String(localized: "Claude Code reports each prompt and edit to ReviewGate; accept or reject the changes as in a chat"))
        }
        return (String(localized: "Waiting for the first prompt"), "hourglass", .secondary,
                String(localized: "ReviewGate has heard nothing from Claude Code yet — it starts reviewing with your first prompt"))
    }
}

/// Over the terminal once Claude Code exited (or could not start): why, and Restart.
private struct TerminalEndedOverlay: View {
    @Environment(WindowModel.self) private var model
    let chatId: String
    let host: TerminalHost

    var body: some View {
        switch host.state {
        case let .exited(code, quickNoHooks):
            panel(title: code.map { String(localized: "Claude Code exited (\(Int($0)))") } ?? String(localized: "Claude Code was stopped"),
                  hint: quickNoHooks ? String(localized: "If it asked whether to trust this folder, choose Yes after restarting — ReviewGate cannot review a folder Claude Code does not trust") : nil)
        case let .failed(message):
            panel(title: message, hint: nil)
        case .idle, .starting, .running:
            EmptyView()
        }
    }

    private func panel(title: String, hint: String?) -> some View {
        VStack(spacing: 10) {
            Label(title, systemImage: "terminal")
                .font(.headline)
                .accessibilityIdentifier("Terminal chat exited")
            if let hint {
                Text(hint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .accessibilityIdentifier("Terminal chat trust hint")
            }
            Button("Restart") { Task { await model.terminals.restart(chatId: chatId) } }
                .help(String(localized: "Start Claude Code again in this terminal — the conversation is resumed"))
                .accessibilityIdentifier("Terminal chat restart after exit")
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35))
    }
}

/// The engine refused to start the terminal (an old CLI, hooks turned off, no CLI): why, and Try Again.
private struct TerminalStartProblem: View {
    @Environment(WindowModel.self) private var model
    let chatId: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Label("Claude Code could not start here", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .frame(maxWidth: 420)
                .accessibilityIdentifier("Terminal chat start problem")
            Button("Try Again") { Task { await model.terminals.restart(chatId: chatId) } }
                .help(String(localized: "Ask ReviewGate's engine again how to start Claude Code for this chat"))
                .accessibilityIdentifier("Terminal chat try again")
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A terminal chat shown read-only: its terminal runs only while it is the live chat.
private struct ViewedTerminalChatPlaceholder: View {
    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Image(systemName: "terminal").font(.largeTitle).foregroundStyle(.secondary)
                Text("This chat runs Claude Code in a terminal")
                    .font(.headline)
                Text("Its terminal runs while it is the live chat. Continue in it to start Claude Code again — the conversation is resumed.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Viewed terminal chat")
            Divider()
            ViewingChatBar()
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
    }
}
