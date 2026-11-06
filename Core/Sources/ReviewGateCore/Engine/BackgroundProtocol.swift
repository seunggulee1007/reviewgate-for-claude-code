import Foundation

// MARK: - §52 background work (docs/PROTOCOL.md §52)

/// §52 `state.session.backgroundTasks[]`: a background task of the session (Bash `run_in_background`, Monitor, …).
public struct BackgroundTaskInfo: Decodable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable, Equatable { case bash, monitor, agent, other }

    public var taskId: String
    public var kind: Kind
    public var description: String
    /// The tool call that started it; nil when the CLI did not say.
    public var toolUseId: String?
    /// The transcript turn of that call.
    public var turn: Int?
    /// ISO-8601.
    public var startedAt: String
    /// Its output can be read (`task_output`).
    public var hasOutput: Bool

    public var id: String { taskId }

    public init(taskId: String, kind: Kind = .bash, description: String = "", toolUseId: String? = nil, turn: Int? = nil,
                startedAt: String = "", hasOutput: Bool = false) {
        self.taskId = taskId
        self.kind = kind
        self.description = description
        self.toolUseId = toolUseId
        self.turn = turn
        self.startedAt = startedAt
        self.hasOutput = hasOutput
    }

    private enum CodingKeys: String, CodingKey { case taskId, kind, description, toolUseId, turn, startedAt, hasOutput }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        kind = Kind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "") ?? .other
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        toolUseId = (try? c.decodeIfPresent(String.self, forKey: .toolUseId)) ?? nil
        turn = (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? nil
        startedAt = (try? c.decodeIfPresent(String.self, forKey: .startedAt)) ?? ""
        hasOutput = (try? c.decodeIfPresent(Bool.self, forKey: .hasOutput)) ?? false
    }

    /// When it started (nil for a value that does not parse).
    public var startedDate: Date? { ISO8601.date(from: startedAt) }
}

/// §52.1 why Claude started a turn itself.
public enum AutoTurnTrigger: String, Sendable, Equatable {
    /// A background task ended.
    case background
    /// A scheduled job ran (`/loop`, cron).
    case schedule
    /// Anything else (`/goal`, …).
    case `continue`
}

/// §52.1 `auto_turn {turn, trigger, task?, wakeupSource?}` (event and transcript row).
public struct AutoTurnInfo: Decodable, Sendable, Equatable {
    public struct Task: Decodable, Sendable, Equatable {
        public var taskId: String
        public var description: String
        /// `completed` / `failed` / `stopped`.
        public var status: String
        /// §52.2: for a subagent, its report.
        public var summary: String?
        /// §52.2: what ended (`agent`: a subagent); nil from an older engine.
        public var kind: BackgroundTaskInfo.Kind?
        /// §52.2: the call that started it.
        public var toolUseId: String?

        public init(taskId: String, description: String, status: String, summary: String? = nil, kind: BackgroundTaskInfo.Kind? = nil,
                    toolUseId: String? = nil) {
            self.taskId = taskId
            self.description = description
            self.status = status
            self.summary = summary
            self.kind = kind
            self.toolUseId = toolUseId
        }

        private enum CodingKeys: String, CodingKey { case taskId, description, status, summary, kind, toolUseId }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            taskId = try c.decode(String.self, forKey: .taskId)
            description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "completed"
            summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? nil
            // An odd kind reads as `other` (as in the task list); none (an older engine) stays nil.
            kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil).map { BackgroundTaskInfo.Kind(rawValue: $0) ?? .other }
            toolUseId = (try? c.decodeIfPresent(String.self, forKey: .toolUseId)) ?? nil
        }
    }

    public var trigger: AutoTurnTrigger
    public var task: Task?
    public var wakeupSource: String?

    public init(trigger: AutoTurnTrigger, task: Task? = nil, wakeupSource: String? = nil) {
        self.trigger = trigger
        self.task = task
        self.wakeupSource = wakeupSource
    }

    private enum CodingKeys: String, CodingKey { case trigger, task, wakeupSource }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        trigger = AutoTurnTrigger(rawValue: (try? c.decodeIfPresent(String.self, forKey: .trigger)) ?? "") ?? .continue
        task = (try? c.decodeIfPresent(Task.self, forKey: .task)) ?? nil
        wakeupSource = (try? c.decodeIfPresent(String.self, forKey: .wakeupSource)) ?? nil
    }
}

/// §52 reply to `task_output`: the end of the task's output (`truncated` when cut); `running` false once it ended.
public struct TaskOutputReply: Decodable, Sendable, Equatable {
    public var id: String?
    public var taskId: String
    public var text: String
    public var truncated: Bool
    public var running: Bool

    public init(id: String? = nil, taskId: String, text: String, truncated: Bool = false, running: Bool = false) {
        self.id = id
        self.taskId = taskId
        self.text = text
        self.truncated = truncated
        self.running = running
    }

    private enum CodingKeys: String, CodingKey { case id, taskId, text, truncated, running }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
        taskId = (try? c.decodeIfPresent(String.self, forKey: .taskId)) ?? ""
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
    }
}

/// §52 reply to `task_background` (Ctrl+B): whether a running call moved to the background.
public struct TaskBackgroundReply: Decodable, Sendable, Equatable {
    public var id: String?
    public var moved: Bool

    public init(id: String? = nil, moved: Bool) {
        self.id = id
        self.moved = moved
    }

    private enum CodingKeys: String, CodingKey { case id, moved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
        moved = (try? c.decodeIfPresent(Bool.self, forKey: .moved)) ?? false
    }
}

enum BackgroundWire {
    private enum SessionKeys: String, CodingKey { case backgroundTasks }

    /// `state.session.backgroundTasks`, element by element (a malformed entry is skipped); empty on older engines.
    static func tasks(from decoder: Decoder) -> [BackgroundTaskInfo] {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self),
              var list = try? c.nestedUnkeyedContainer(forKey: .backgroundTasks) else { return [] }
        var out: [BackgroundTaskInfo] = []
        while !list.isAtEnd {
            if let t = try? list.decode(BackgroundTaskInfo.self) { out.append(t) } else if (try? list.decode(JSONValue.self)) == nil { break }
        }
        return out
    }
}

private enum ISO8601 {
    nonisolated(unsafe) static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) static let plain = ISO8601DateFormatter()

    static func date(from s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
}

extension EngineCommand {
    private enum BackgroundKeys: String, CodingKey { case taskId, toolUseId }

    /// The §52 commands' fields (`type` is written by the caller).
    func encodeBackgroundFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: BackgroundKeys.self)
        switch self {
        case let .taskStop(taskId), let .taskOutput(taskId):
            try c.encode(taskId, forKey: .taskId)
        case let .taskBackground(toolUseId):
            try c.encodeIfPresent(toolUseId, forKey: .toolUseId)
        default:
            break
        }
    }
}
