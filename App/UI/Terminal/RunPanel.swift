import AppKit
import Observation
import ReviewGateCore
import SwiftUI

// MARK: c-panel (§57.18)
/// The bottom panel's 실행 tab: the project's named commands (kept per project, plus what its files offer), each run in
/// its own PTY — the user's login shell `-c <command>` in the project root — with Run / Stop / Restart and its exit code.
/// Nothing runs without a click; a detected command asks once ("이 명령을 실행할까요?"). Its output stays until it is
/// restarted (a restart is a fresh terminal).
@MainActor @Observable
final class RunPanelModel {
    struct Run {
        var config: RunConfig
        let host: TerminalHost
        /// The folder it started in.
        let cwd: String
        /// Stopped with ■ (its exit code is the signal's, not the program's).
        var stoppedByUser = false
    }

    /// What the tab lists: the kept commands, then the detected ones not kept or removed.
    private(set) var configs: [RunConfig] = []
    /// The PTY of each command started in this window, by config id.
    private(set) var started: [String: Run] = [:]
    var selectedId: String?
    /// The detected command waiting for "실행" in the confirmation.
    var confirming: RunConfig?
    @ObservationIgnored weak var store: AppState?

    var selected: RunConfig? { configs.first { $0.id == selectedId } ?? configs.first }

    /// The commands running now (the tab's and the status bar's count).
    var runningCount: Int { started.values.filter { $0.host.state.isRunning }.count }

    func run(of id: String) -> Run? { started[id] }

    /// Reads the kept commands and the project's files again (on showing the tab, after a change).
    func reload() {
        guard let store, let url = store.projectURL else { configs = []; return }
        var listed = store.projectRuns.listed(detected: RunCandidates.detect(folder: url))
        // A command still running stays listed even when it was removed meanwhile.
        for run in started.values where !listed.contains(where: { $0.id == run.config.id }) { listed.append(run.config) }
        configs = listed
    }

    /// ▶: a detected command asks first, once; any other runs (again, in a fresh terminal).
    func run(_ config: RunConfig) {
        selectedId = config.id
        if config.needsConfirmation {
            confirming = config
            return
        }
        start(config)
    }

    /// "실행" in the confirmation: the command is kept as confirmed and runs.
    func confirm() {
        guard var config = confirming else { return }
        confirming = nil
        config.confirmed = true
        update { $0.keep(config) }
        start(config)
    }

    /// ■: SIGTERM to its process group, SIGKILL after 3 s.
    func stop(_ id: String) {
        guard var run = started[id], run.host.state.isRunning else { return }
        run.stoppedByUser = true
        started[id] = run
        Task { await run.host.stop() }
    }

    /// "명령 추가…": the user's own command — theirs, so it never asks.
    @discardableResult
    func add(name: String, command: String) -> RunConfig? {
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { return nil }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let config = RunConfig(id: UUID().uuidString, name: name.isEmpty ? command : name, command: command, confirmed: true)
        update { $0.keep(config) }
        selectedId = config.id
        return config
    }

    /// "삭제": a kept command goes; a detected one stays away until "다시 찾기". A running one is stopped first.
    func remove(_ config: RunConfig) {
        if let run = started.removeValue(forKey: config.id) { Task { await run.host.stop() } }
        update { $0.remove(config) }
    }

    /// "다시 찾기": the project's files are read again and removed detected commands come back.
    func findAgain() { update { $0.restoreDetected() } }

    /// The window closes: every run ends (the caller stops the hosts).
    func takeAll() -> [TerminalHost] {
        let hosts = started.values.map(\.host)
        started = [:]
        return hosts
    }

    /// Quit: SIGTERM to every run without waiting.
    func terminateAll() {
        for run in started.values where run.host.view.process.running { run.host.terminate() }
    }

    private func update(_ change: (inout ProjectRuns) -> Void) {
        guard let store else { return }
        var runs = store.projectRuns
        change(&runs)
        store.saveProjectRuns(runs)
        reload()
    }

    private func start(_ config: RunConfig) {
        guard let folder = store?.projectURL?.path else { return }
        let launch = TerminalLaunch.run(command: config.command, cwd: folder, parentEnv: ProcessInfo.processInfo.environment,
                                        loginShell: TerminalLaunch.userLoginShell(), appVersion: TerminalHub.appVersion,
                                        debugShell: TerminalHub.debugShell)
        if var run = started[config.id], run.cwd == folder {
            run.stoppedByUser = false
            run.config = config
            started[config.id] = run
            Task { await run.host.restart(launch: launch) }
            return
        }
        if let old = started[config.id] { Task { await old.host.stop() } }
        let height = UserDefaults.standard.object(forKey: "terminalPanelHeight") as? Double ?? 220
        let host = TerminalHost(size: NSSize(width: 700, height: max(80, height - 80)))
        started[config.id] = Run(config: config, host: host, cwd: folder)
        host.start(launch: launch)
    }

    /// "실행 중" / "끝남 (n)" / "중지됨" / why it could not start; nil before its first run.
    static func status(_ run: Run?) -> (text: String, failed: Bool)? {
        guard let run else { return nil }
        switch run.host.state {
        case .idle, .starting, .running: return (String(localized: "Running"), false)
        case let .exited(code, _):
            if run.stoppedByUser { return (String(localized: "Stopped"), false) }
            guard let code else { return (String(localized: "Stopped"), false) }
            return (String(localized: "Exited (\(Int(code)))"), code != 0)
        case let .failed(message): return (message, true)
        }
    }
}

/// The 실행 tab: the commands on the left, the selected one's terminal (or how to start it) on the right.
struct RunPanelView: View {
    @Environment(WindowModel.self) private var model
    @Environment(AppState.self) private var store
    @State private var adding = false

    var body: some View {
        let runs = model.shell.runs
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if runs.configs.isEmpty {
                    Text("No run commands found in this project — add one.")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(8)
                } else {
                    ScrollView {
                        VStack(spacing: 1) {
                            ForEach(runs.configs) { config in RunConfigRow(config: config) }
                        }
                        .padding(4)
                    }
                }
                Divider()
                HStack(spacing: 4) {
                    Button { adding = true } label: { Label("Add Command…", systemImage: "plus").font(.caption) }
                        .buttonStyle(.borderless)
                        .help(String(localized: "Add a command to run in the project folder"))
                        .accessibilityIdentifier("Run add command")
                        .popover(isPresented: $adding, arrowEdge: .top) { AddRunCommandForm(isPresented: $adding) }
                    Spacer()
                    Button { runs.findAgain() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.icon)
                        .controlSize(.small)
                        .help(String(localized: "Find again — read package.json, the Gradle and Maven wrappers again and bring back removed ones"))
                        .accessibilityLabel(Text("Find run commands again"))
                        .accessibilityIdentifier("Run find again")
                }
                .padding(.horizontal, 6).padding(.vertical, 3)
            }
            .frame(width: 240)
            Divider()
            RunDetailView()
        }
        .onAppear {
            runs.store = store
            runs.reload()
        }
        .onChange(of: store.projectURL) { _, _ in runs.reload() }
        .alert(String(localized: "Run this command?"), isPresented: Binding(get: { runs.confirming != nil }, set: { if !$0 { runs.confirming = nil } })) {
            Button("Run") { runs.confirm() }
                .accessibilityIdentifier("Run confirm")
            Button("Cancel", role: .cancel) { runs.confirming = nil }
        } message: {
            if let config = runs.confirming {
                Text("\(config.command)\n\nIt runs in \(store.projectURL?.path ?? "") as you, with your permissions — ReviewGate does not sandbox it. It asks only before this command's first run.")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Run panel")
    }
}

/// One command in the list: its state, name and command; ▶ or ■; a context menu.
private struct RunConfigRow: View {
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    let config: RunConfig
    @State private var hovering = false

    var body: some View {
        let runs = model.shell.runs
        let run = runs.run(of: config.id)
        let running = run?.host.state.isRunning == true
        let isSelected = runs.selected?.id == config.id
        HStack(spacing: 6) {
            Image(systemName: running ? "circle.fill" : "circle")
                .font(.system(size: 7))
                .foregroundStyle(running ? Color.green : Color.secondary)
                .help(running ? String(localized: "Running") : String(localized: "Not running"))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(verbatim: config.name).font(.caption).lineLimit(1).truncationMode(.middle)
                    if config.needsConfirmation {
                        Text("found").font(.caption2).foregroundStyle(.secondary)
                            .help(String(localized: "Found in the project's files — it asks before its first run"))
                    }
                }
                Text(verbatim: config.command).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 2)
            if running {
                Button { runs.stop(config.id) } label: { Image(systemName: "stop.fill").font(.caption) }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .help(String(localized: "Stop — ends the command and what it started"))
                    .accessibilityLabel(Text("Stop ‘\(config.name)’"))
                    .accessibilityIdentifier("Run stop \(config.id)")
            } else {
                Button { runs.run(config) } label: { Image(systemName: "play.fill").font(.caption) }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .help(String(localized: "Run \(config.command) in the project folder"))
                    .accessibilityLabel(Text("Run ‘\(config.name)’"))
                    .accessibilityIdentifier("Run start \(config.id)")
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(isSelected ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : (hovering ? Color.primary.opacity(0.08) : .clear),
                    in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { runs.selectedId = config.id }
        .onHover { hovering = $0 }
        .help(String(localized: "\(config.name) — \(config.command)"))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier("Run config \(config.id)")
        .contextMenu {
            Button("Run") { runs.run(config) }.disabled(running)
            Button("Stop") { runs.stop(config.id) }.disabled(!running)
            Divider()
            Button("Copy Command") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(config.command, forType: .string)
            }
            Button("Remove", role: .destructive) { runs.remove(config) }
        }
    }
}

/// The selected command: its bar (state, Run / Stop / Restart) over its terminal, or how to start it.
private struct RunDetailView: View {
    @Environment(WindowModel.self) private var model
    @Environment(AppState.self) private var store

    var body: some View {
        let runs = model.shell.runs
        if let config = runs.selected {
            let run = runs.run(of: config.id)
            let running = run?.host.state.isRunning == true
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(verbatim: config.name).font(.caption.weight(.semibold)).lineLimit(1)
                    if let status = RunPanelModel.status(run) {
                        Text(verbatim: status.text).font(.caption2).foregroundStyle(status.failed ? .orange : .secondary).lineLimit(1)
                    }
                    Spacer()
                    Button { runs.run(config) } label: { Image(systemName: "play.fill") }
                        .buttonStyle(.icon).controlSize(.small)
                        .disabled(running)
                        .help(running ? String(localized: "It is running — Stop it or Restart") : String(localized: "Run \(config.command) in the project folder"))
                        .accessibilityLabel(Text("Run"))
                        .accessibilityIdentifier("Run detail start")
                    Button { runs.stop(config.id) } label: { Image(systemName: "stop.fill") }
                        .buttonStyle(.icon).controlSize(.small)
                        .disabled(!running)
                        .help(running ? String(localized: "Stop — ends the command and what it started") : String(localized: "Not running"))
                        .accessibilityLabel(Text("Stop"))
                        .accessibilityIdentifier("Run detail stop")
                    Button { runs.run(config) } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.icon).controlSize(.small)
                        .disabled(run == nil)
                        .help(run == nil ? String(localized: "It has not run yet — Run starts it") : String(localized: "Restart — stops it and runs it again in a fresh terminal"))
                        .accessibilityLabel(Text("Restart"))
                        .accessibilityIdentifier("Run detail restart")
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                Divider()
                if let run {
                    TerminalContainer(host: run.host)
                        .id(ObjectIdentifier(run.host))
                        .accessibilityIdentifier("Run terminal")
                } else {
                    VStack(spacing: 8) {
                        Text(verbatim: config.command).font(.callout.monospaced()).textSelection(.enabled)
                        Button { runs.run(config) } label: { Label("Run", systemImage: "play.fill") }
                            .controlSize(.small)
                            .help(String(localized: "Run \(config.command) in the project folder"))
                        Text("It runs in \(store.projectURL?.lastPathComponent ?? "") through your login shell, as you — ReviewGate does not sandbox it.")
                            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        } else {
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// "명령 추가…": a name (optional) and the command line.
private struct AddRunCommandForm: View {
    @Environment(WindowModel.self) private var model
    @Binding var isPresented: Bool
    @State private var name = ""
    @State private var command = ""

    var body: some View {
        let blank = command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 8) {
            Text("Add Command").font(.headline)
            TextField("Name (optional)", text: $name)
                .accessibilityIdentifier("Run add name")
            TextField("Command, e.g. ./gradlew bootRun", text: $command)
                .font(.body.monospaced())
                .accessibilityIdentifier("Run add command line")
                .onSubmit { save() }
            Text("It runs in the project folder through your login shell — only when you press Run.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }.keyboardShortcut(.cancelAction)
                Button("Add") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(blank)
                    .help(blank ? String(localized: "Type the command first") : String(localized: "Add it to this project's run commands"))
            }
        }
        .padding(14)
        .frame(width: 360)
    }

    private func save() {
        guard model.shell.runs.add(name: name, command: command) != nil else { return }
        isPresented = false
    }
}
