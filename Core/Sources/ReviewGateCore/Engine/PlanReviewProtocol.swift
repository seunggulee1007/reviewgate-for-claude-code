import Foundation

// MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 plans you can review and follow (wire types)
//
// Every field is optional on the wire: an older engine sends no `steps` (the plan card keeps its one note field), no
// `source` (the summary's plan is the approved one) and no `planSource` (no basis menu); an unknown kind reads as nil.

/// `pendingPlan.steps[]`: a step of a proposed plan — 0-based `index` (shown as index + 1) and its text.
public struct PlanStepBrief: Sendable, Equatable, Identifiable, Codable {
    public var id: Int { index }
    public var index: Int
    public var text: String

    public init(index: Int, text: String) {
        self.index = index
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case index, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(index: (try? c.decodeIfPresent(Int.self, forKey: .index)) ?? 0,
                  text: (try? c.decodeIfPresent(String.self, forKey: .text)) ?? "")
    }
}

/// `plan_response.into`: implement in a fresh chat of this worktree, or in another workbench.
public enum PlanInto: String, Sendable, Codable, Equatable {
    case newChat = "new_chat"
    case workbench
}

/// Where a turn summary's plan came from (`turn_summary.plan.source`, `state.session.planSource.kind`).
public enum PlanSourceKind: String, Sendable, Codable, Equatable {
    case approved, file, todos, message, request
}

/// `state.session.planSource`: what the next summary's "plan vs actual" follows and the plan files to choose from.
public struct PlanSourceState: Sendable, Equatable, Decodable {
    /// nil: nothing yet (or a kind this client does not know).
    public var kind: PlanSourceKind?
    /// The plan file (kind `file`): repo-relative inside the worktree, else absolute.
    public var path: String?
    /// `plan_follow` chose it.
    public var chosen: Bool
    public var candidates: [String]

    public init(kind: PlanSourceKind? = nil, path: String? = nil, chosen: Bool = false, candidates: [String] = []) {
        self.kind = kind
        self.path = path
        self.chosen = chosen
        self.candidates = candidates
    }

    private enum CodingKeys: String, CodingKey { case kind, path, chosen, candidates }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(kind: (try? c.decodeIfPresent(String.self, forKey: .kind)).flatMap { $0.flatMap(PlanSourceKind.init(rawValue:)) },
                  path: try? c.decodeIfPresent(String.self, forKey: .path),
                  chosen: ((try? c.decodeIfPresent(Bool.self, forKey: .chosen)) ?? nil) ?? false,
                  candidates: ((try? c.decodeIfPresent([String].self, forKey: .candidates)) ?? nil) ?? [])
    }
}

/// `plan_approved` with `into` (§42.1): the fresh chat (`new_chat`), the plan handed to `target`, or received `from` a workbench.
public struct PlanApprovedInfo: Sendable, Equatable {
    public var mode: PermissionMode
    public var path: String?
    public var into: PlanInto
    public var target: String?
    public var from: String?

    public init(mode: PermissionMode, path: String?, into: PlanInto, target: String? = nil, from: String? = nil) {
        self.mode = mode
        self.path = path
        self.into = into
        self.target = target
        self.from = from
    }

    private enum CodingKeys: String, CodingKey { case mode, path, into, target, from }

    /// nil when the event carries no `into` this client knows (then it is the plain `.planApproved`).
    static func decode(from decoder: Decoder) -> PlanApprovedInfo? {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self),
              let raw = try? c.decodeIfPresent(String.self, forKey: .into), let into = PlanInto(rawValue: raw) else { return nil }
        return PlanApprovedInfo(mode: (try? c.decode(PermissionMode.self, forKey: .mode)) ?? .default,
                                path: try? c.decodeIfPresent(String.self, forKey: .path),
                                into: into,
                                target: try? c.decodeIfPresent(String.self, forKey: .target),
                                from: try? c.decodeIfPresent(String.self, forKey: .from))
    }
}

private enum PlanReviewSessionKeys: String, CodingKey { case planSource }

extension SessionInfo {
    /// `planSource` (nil on older engines / when malformed).
    mutating func decodePlanReviewFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: PlanReviewSessionKeys.self) else { return }
        planSource = lenientValue(PlanSourceState.self, c, .planSource)
    }
}

extension PendingPlan {
    /// `steps` (nil on older engines).
    static func decodeSteps(from decoder: Decoder) -> [PlanStepBrief]? {
        enum Keys: String, CodingKey { case steps }
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return nil }
        return lenientValue([PlanStepBrief].self, c, .steps)
    }
}
