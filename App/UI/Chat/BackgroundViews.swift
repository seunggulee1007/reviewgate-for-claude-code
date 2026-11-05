import SwiftUI
import ReviewGateCore

// MARK: - §52 background work (docs/PROTOCOL.md §52)

/// The HUD's "백그라운드 N" while background tasks run (a dev server, a build Claude started with run_in_background, a
/// Monitor); a click lists them with [출력 보기] and [중지].
struct BackgroundTasksChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @State private var showList = false

    var body: some View {
        let tasks = store.backgroundTasks
        if !tasks.isEmpty {
            Button {
                showList.toggle()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "gearshape.2")
                    Text(verbatim: BackgroundText.chip(tasks.count)).fixedSize()
                }
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.indigo.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
                .foregroundStyle(.indigo)
            }
            .buttonStyle(.plain)
            .fixedSize().layoutPriority(1)
            .help("Commands Claude started in the background. What they change goes into the next review.")
            .accessibilityLabel(BackgroundText.chip(tasks.count))
            .accessibilityIdentifier("HUD background tasks")
            .popover(isPresented: $showList, arrowEdge: .top) {
                BackgroundTasksPopover()
            }
        }
    }
}

/// The running background tasks, newest at the bottom; each with its output and a stop button.
struct BackgroundTasksPopover: View {
    @Environment(AppState.self) private var store
    @State private var outputOf: BackgroundTaskInfo?
    @State private var stopping: Set<String> = []
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Running in the background").font(.headline)
            Text("Claude goes on by itself when one ends. Changes they make are reviewed in the next turn.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if store.backgroundTasks.isEmpty {
                Text("Nothing is running in the background.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(store.backgroundTasks) { task in
                row(task)
            }
            if let failure {
                Text(verbatim: failure).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(width: 380)
        .sheet(item: $outputOf) { task in
            BackgroundTaskOutputSheet(task: task)
        }
    }

    private func row(_ task: BackgroundTaskInfo) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: task.kind == .agent ? "person.2" : task.kind == .monitor ? "waveform.path.ecg" : "terminal")
                .foregroundStyle(.indigo)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: task.description.isEmpty ? task.taskId : task.description)
                    .font(.callout).lineLimit(2)
                HStack(spacing: 6) {
                    Text(verbatim: BackgroundText.kindLabel(task.kind))
                    if let turn = task.turn { Text("Turn \(turn)") }
                    if let date = task.startedDate {
                        Text(date, style: .relative)
                    }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if task.hasOutput {
                Button("Output") { outputOf = task }
                    .controlSize(.small)
                    .accessibilityIdentifier("Background task output")
            }
            Button(role: .destructive) {
                stopping.insert(task.taskId)
                failure = nil
                Task {
                    let refused = await store.stopBackgroundTask(task.taskId)
                    stopping.remove(task.taskId)
                    failure = refused?.text
                }
            } label: {
                Text("Stop")
            }
            .controlSize(.small)
            .disabled(stopping.contains(task.taskId))
            .accessibilityIdentifier("Stop background task")
        }
    }
}

/// The end of a background task's output (64 KB), refreshed on demand.
struct BackgroundTaskOutputSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let task: BackgroundTaskInfo
    @State private var output: TaskOutputReply?
    @State private var failure: String?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(verbatim: task.description.isEmpty ? task.taskId : task.description)
                    .font(.headline).lineLimit(1)
                Spacer()
                if let output {
                    Text(output.running ? "Running" : "Ended")
                        .font(.caption).foregroundStyle(output.running ? Color.indigo : Color.secondary)
                }
            }
            if output?.truncated == true {
                Text("Showing the last 64 KB.").font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                Text(verbatim: output?.text.isEmpty == false ? output!.text : (failure ?? (loading ? "" : String(localized: "No output yet."))))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            HStack {
                Button("Refresh") { Task { await load() } }
                    .disabled(loading)
                Spacer()
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(16)
        .frame(minWidth: 560, minHeight: 360)
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        switch await store.backgroundTaskOutput(task.taskId) {
        case let .success(reply):
            output = reply
            failure = nil
        case let .failure(f):
            failure = f.text
        }
    }
}

/// §52.1: the first row of a turn Claude started itself — where a user message would be.
struct AutoTurnRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let info: AutoTurnInfo

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label(BackgroundText.autoTurnTitle(info), systemImage: info.trigger == .schedule ? "clock.arrow.circlepath" : "arrow.turn.down.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.indigo)
                if let detail = BackgroundText.autoTurnDetail(info) {
                    Text(verbatim: detail).font(.callout)
                }
                if let summary = info.task?.summary, !summary.isEmpty, summary != info.task?.description {
                    Text(verbatim: summary).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(Color.indigo.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 10))
            Spacer(minLength: 40)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Auto turn")
    }
}

/// [백그라운드로] on a Bash call that still runs (⌃B): it returns at once and keeps running in the background.
struct MoveToBackgroundButton: View {
    @Environment(AppState.self) private var store
    let toolUseId: String
    @State private var sending = false
    @State private var note: String?

    var body: some View {
        if store.canMoveToBackground(toolUseId: toolUseId) {
            HStack(spacing: 6) {
                Button {
                    sending = true
                    Task {
                        let r = await store.moveToBackground(toolUseId: toolUseId)
                        sending = false
                        switch r {
                        case let .success(moved): note = moved ? nil : String(localized: "It can't be moved to the background.")
                        case let .failure(f): note = f.text
                        }
                    }
                } label: {
                    Label("Run in background", systemImage: "arrow.down.right.square")
                }
                .controlSize(.small)
                .disabled(sending)
                .help("Let this command keep running in the background (⌃B) — Claude goes on now")
                .accessibilityIdentifier("Move to background")
                if let note {
                    Text(verbatim: note).font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }
}
