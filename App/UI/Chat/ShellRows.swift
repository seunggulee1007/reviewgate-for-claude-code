import SwiftUI
import AppKit
import ReviewGateCore

// MARK: §67 — docs/PROTOCOL.md §67.3: a `!` command in the chat. While it runs, a live row at the end of the chat (`$ command`,
// a spinner, the elapsed time, its output so far, 중지); when it ends, its row (how it ended, the time, the output folded to
// its last lines, the files it changed) — restored with the chat. Its output goes to Claude with the next message.

extension Color {
    /// §67.3: the shell's accent — Claude Code's bash mode is pink.
    static let shellAccent = Color.pink
}

/// §67.2: a finished `!` command (`kind: "shell"`).
struct ShellResultRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let result: ShellResult
    @State private var showAll = false

    private var end: ShellEnd { ShellEnd(result) }
    private var endColor: Color {
        switch end {
        case .succeeded: .green
        case .failed, .notStarted: .red
        case .cancelled, .timedOut: .orange
        }
    }

    var body: some View {
        let folded = ShellMode.folded(result.output)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "terminal").foregroundStyle(Color.shellAccent)
                    .accessibilityHidden(true)
                Text(verbatim: "$ " + result.command)
                    .font(.callout.monospaced())
                    .lineLimit(4)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .help(result.command)
                Spacer(minLength: 8)
                Text(verbatim: ShellMode.summary(result))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(endColor)
                    .fixedSize()
                    .help(String(localized: "Ran in \(SessionNotices.abbreviatingHome(result.cwd)) — its output goes to Claude with your next message"))
                    .accessibilityIdentifier("Shell row status")
            }
            if result.truncated {
                Text(verbatim: ShellMode.truncatedNote).font(.caption2).foregroundStyle(.secondary)
            }
            if !folded.text.isEmpty {
                ShellOutputText(text: showAll ? fullOutput : folded.text)
                if folded.hidden > 0 {
                    Button(showAll ? String(localized: "Show less") : ShellMode.showAll(hidden: folded.hidden)) { showAll.toggle() }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help(showAll ? String(localized: "Show only the last lines of the output") : String(localized: "Show the whole output"))
                        .accessibilityIdentifier("Shell row show all")
                }
            }
            if let files = ShellMode.filesLine(result) {
                Label(files, systemImage: "doc.badge.ellipsis")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help(ShellMode.filesTooltip(result))
                    .accessibilityIdentifier("Shell row files")
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.shellAccent.wash(colorScheme, light: 0.06, dark: 0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.shellAccent.opacity(0.3)))
        .contextMenu {
            Button("Copy Command", systemImage: "doc.on.doc") { Self.copy(result.command) }
            Button("Copy Output", systemImage: "doc.on.clipboard") { Self.copy(result.output) }
                .disabled(result.output.isEmpty)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "$ " + result.command + " — " + end.text))
        .accessibilityIdentifier("Shell row")
    }

    private var fullOutput: String { result.output.hasSuffix("\n") ? String(result.output.dropLast()) : result.output }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        Toast.show(String(localized: "Copied"))
    }
}

/// The output of a `!` command: monospaced, selectable, on the text background.
private struct ShellOutputText: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// §67.2: the `!` command running now, at the end of the chat (nothing otherwise). Its own view: the output that streams in
/// redraws only this row.
struct LiveShellSlot: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if let run = store.shellRun, store.viewingChat == nil, !store.isTerminalChat {
            LiveShellRow(run: run, output: store.shellRunOutput) { store.cancelShell() }
        }
    }
}

private struct LiveShellRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let run: ShellRunInfo
    let output: String
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                ProgressView().controlSize(.small)
                    .accessibilityLabel(Text("Running"))
                Text(verbatim: "$ " + run.command)
                    .font(.callout.monospaced())
                    .lineLimit(4)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .help(run.command)
                Spacer(minLength: 8)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(verbatim: ElapsedFormat.ticking(seconds: ShellMode.elapsed(since: run.startedAt, now: context.date)))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                .help(String(localized: "Running in \(SessionNotices.abbreviatingHome(run.cwd))"))
                Button("Stop", systemImage: "stop.fill", action: onStop)
                    .controlSize(.small)
                    .help(ShellMode.stopHelp)
                    .accessibilityIdentifier("Stop shell command")
            }
            let tail = ShellMode.folded(output).text
            if !tail.isEmpty {
                ShellOutputText(text: tail)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.shellAccent.wash(colorScheme, light: 0.06, dark: 0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.shellAccent.opacity(0.5)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Shell running row")
    }
}

/// §67.2: over the message box while `!` results wait for the next message.
struct ShellPendingCaption: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.viewingChat == nil, !store.isTerminalChat, let caption = ShellMode.pendingCaption(store.shellPending) {
            Label(caption, systemImage: "terminal")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .help(String(localized: "The output of the shell commands you ran goes in front of your next message, as in Claude Code — Claude is not asked anything until then"))
                .accessibilityIdentifier("Shell pending caption")
        }
    }
}
