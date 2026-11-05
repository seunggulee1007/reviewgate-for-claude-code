import Foundation

// MARK: - §52 background work (docs/PROTOCOL.md §52)

/// A refused §52 command in the user's words.
public struct BackgroundTaskFailure: Error, Equatable, Sendable {
    public let text: String
}

public extension AppState {
    /// §52: the background tasks running now (oldest first).
    var backgroundTasks: [BackgroundTaskInfo] { debugBackgroundTasks ?? state.session.backgroundTasks }

    #if DEBUG
    /// The screenshot tour's layout check (App/Debug/ScreenshotTour.swift): two background tasks and the row of a turn Claude
    /// started after one ended.
    func debugShowBackgroundWork() {
        let now = Date()
        let iso = ISO8601DateFormatter()
        debugBackgroundTasks = [
            BackgroundTaskInfo(taskId: "b1", kind: .bash, description: "npm run dev (port 3000)", toolUseId: "toolu_dev", turn: 2,
                               startedAt: iso.string(from: now.addingTimeInterval(-340)), hasOutput: true),
            BackgroundTaskInfo(taskId: "b2", kind: .bash, description: "./gradlew test", toolUseId: "toolu_test", turn: 3,
                               startedAt: iso.string(from: now.addingTimeInterval(-45)), hasOutput: true),
        ]
        handleAutoTurn(turn: 4, info: AutoTurnInfo(trigger: .background, task: .init(taskId: "b0", description: "npm run build", status: "completed",
                                                                                    summary: "Background command \"npm run build\" completed (exit code 0)")))
        transcript.append(.assistant(id: UUID(), text: "빌드가 끝났어요. 타입 오류 2개를 고칠게요.", streaming: false))
    }

    func debugHideBackgroundWork() { debugBackgroundTasks = nil }
    #endif

    /// §52: Settings › Session "Allow background work and /loop" (default on).
    var backgroundWorkEnabled: Bool { AppSettings.backgroundWork(defaults: settingsDefaults) }

    /// §52 `task_stop`: nil when the engine took it (the task leaves the list with the next snapshot), else why not.
    func stopBackgroundTask(_ taskId: String) async -> BackgroundTaskFailure? {
        do {
            try await request(.taskStop(taskId: taskId))
            return nil
        } catch {
            appendLog("[warn] task_stop: \(error.localizedDescription)")
            return BackgroundTaskFailure(text: BackgroundText.refusal(error))
        }
    }

    /// §52 `task_background` (Ctrl+B): the running call (every foreground task with nil) goes on in the background.
    /// `true` when one moved, `false` when nothing could.
    func moveToBackground(toolUseId: String? = nil) async -> Result<Bool, BackgroundTaskFailure> {
        do {
            let reply = try await reply(.taskBackground(toolUseId: toolUseId))
            guard case let .taskBackground(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return .success(r.moved)
        } catch {
            appendLog("[warn] task_background: \(error.localizedDescription)")
            return .failure(BackgroundTaskFailure(text: BackgroundText.refusal(error)))
        }
    }

    /// §52 `task_output`: the end of the task's output.
    func backgroundTaskOutput(_ taskId: String) async -> Result<TaskOutputReply, BackgroundTaskFailure> {
        do {
            let reply = try await reply(.taskOutput(taskId: taskId))
            guard case let .taskOutput(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return .success(r)
        } catch {
            appendLog("[warn] task_output: \(error.localizedDescription)")
            return .failure(BackgroundTaskFailure(text: BackgroundText.refusal(error)))
        }
    }

    /// A Bash call still running in the turn that runs — what [백그라운드로] / ⌃B can move (background work on).
    func canMoveToBackground(toolUseId: String) -> Bool {
        guard isRunning, state.session.externalTurn == nil, AppSettings.backgroundWork(defaults: settingsDefaults) else { return false }
        // A running call is recent: only the end of the transcript is searched (its result would come after it).
        let recent = transcript.suffix(400)
        guard let at = recent.lastIndex(where: { if case let .toolUse(_, id, _, _, _, _) = $0 { return id == toolUseId }; return false }) else { return false }
        return !recent[at...].contains {
            if case let .toolResult(_, id, _, _, _) = $0 { return id == toolUseId }
            return false
        }
    }
}

extension AppState {
    /// §52.1 `auto_turn`: Claude started this turn itself; its row opens the turn (once per turn).
    func handleAutoTurn(turn: Int, info: AutoTurnInfo) {
        finishStreamingAssistant()
        let known = transcript.contains {
            if case let .autoTurn(_, t, _) = $0 { return t == turn && turn > 0 }
            return false
        }
        if !known { transcript.append(.autoTurn(id: UUID(), turn: turn, info: info)) }
    }
}

// MARK: - Text

public enum BackgroundText {
    /// The `auto_turn` row.
    public static func autoTurnTitle(_ info: AutoTurnInfo) -> String {
        switch info.trigger {
        case .background:
            switch info.task?.status {
            case "failed": return String(localized: "A background task failed — Claude went on", bundle: .module)
            case "stopped": return String(localized: "A background task was stopped — Claude went on", bundle: .module)
            default: return String(localized: "A background task finished — Claude went on", bundle: .module)
            }
        case .schedule: return String(localized: "A scheduled task ran (/loop)", bundle: .module)
        case .continue: return String(localized: "Claude went on by itself", bundle: .module)
        }
    }

    /// The row's second line: the task, or what a scheduled run means.
    public static func autoTurnDetail(_ info: AutoTurnInfo) -> String? {
        if let d = info.task?.description, !d.isEmpty { return d }
        if info.trigger == .schedule { return String(localized: "Its changes are reviewed like any other turn.", bundle: .module) }
        return nil
    }

    /// The chip: "백그라운드 N".
    public static func chip(_ count: Int) -> String {
        String(localized: "Background \(count)", bundle: .module)
    }

    public static func kindLabel(_ kind: BackgroundTaskInfo.Kind) -> String {
        switch kind {
        case .bash: String(localized: "Command", bundle: .module)
        case .monitor: String(localized: "Monitor", bundle: .module)
        case .agent: String(localized: "Agent", bundle: .module)
        case .other: String(localized: "Background task", bundle: .module)
        }
    }

    /// A refusal of `task_stop` / `task_background` / `task_output` in the user's words.
    public static func refusal(_ error: Error) -> String {
        let code = (error as? EngineClientError)?.refusalCode ?? ""
        switch code {
        case "task_unknown": return String(localized: "That task is no longer running.", bundle: .module)
        case "no_output": return String(localized: "This task has no output to show yet.", bundle: .module)
        case "background_off": return String(localized: "Background work is off (Settings › Session, or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).", bundle: .module)
        case "no_session": return String(localized: "No Claude session is running.", bundle: .module)
        default: return (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }
}

// MARK: - Settings

public extension AppSettings {
    /// §52: background commands and turns Claude starts itself (default on; the engine applies it at the next session start).
    static let backgroundWorkKey = "backgroundWork"

    static func backgroundWork(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: backgroundWorkKey) as? Bool ?? true
    }
}

public extension AppState {
    /// Settings › background work: `set_settings {backgroundWork}` (the engine uses it at the next session start).
    func pushBackgroundWork() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.backgroundWork = AppSettings.backgroundWork(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }
}
