import Foundation

// MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 plans you can review and follow (client rules; Electron planReview.ts)

/// The plan card's per-step notes: "계속 계획" sends them as one message, a line per noted step, then the general note.
public enum PlanReviewNotes {
    /// Longest step text quoted in a note line.
    static let quoteLimit = 60

    /// The keep-planning message ("단계 3 (Spring 설정): 빼 주세요" per noted step, then the general note); nil when nothing
    /// was written (the engine's own "keep planning" text goes).
    public static func message(steps: [PlanStepBrief], notes: [Int: String], general: String) -> String? {
        var lines: [String] = []
        for step in steps.sorted(by: { $0.index < $1.index }) {
            guard let note = notes[step.index]?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { continue }
            lines.append(String(localized: "Step \(step.index + 1) (\(quote(step.text))): \(note)", bundle: .module))
        }
        let rest = general.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { lines.append(rest) }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// How many steps carry a note.
    public static func noteCount(_ notes: [Int: String]) -> Int {
        notes.values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
    }

    static func quote(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > quoteLimit ? String(t.prefix(quoteLimit - 1)) + "…" : t
    }
}

/// The plan section's words by where its plan came from (`turn_summary.plan.source`).
public enum PlanSourceText {
    public static func title(_ plan: TurnSummary.Plan) -> String {
        switch plan.source {
        case .file?: String(localized: "Against the plan file", bundle: .module)
        case .todos?: String(localized: "Against Claude's to-do list", bundle: .module)
        case .message?: String(localized: "Against your first message's list", bundle: .module)
        case .request?: String(localized: "Request scope", bundle: .module)
        case .approved?, nil: String(localized: "Plan vs actual", bundle: .module)
        }
    }

    public static func isRequest(_ plan: TurnSummary.Plan) -> Bool { plan.source == .request }

    /// The orange box's title.
    public static func unplannedTitle(_ plan: TurnSummary.Plan) -> String {
        isRequest(plan) ? String(localized: "Outside the request", bundle: .module) : String(localized: "Unplanned changes", bundle: .module)
    }

    public static func unplannedHelp(_ plan: TurnSummary.Plan) -> String {
        isRequest(plan)
            ? String(localized: "Your first request and the files it @-mentions do not name these files — check they belong in this change.", bundle: .module)
            : String(localized: "No plan step mentions these files — check they belong in this change.", bundle: .module)
    }

    /// The header chip / a file row's badge.
    public static func unplannedChip(_ count: Int, _ plan: TurnSummary.Plan) -> String {
        isRequest(plan) ? String(localized: "\(count) outside the request", bundle: .module) : String(localized: "\(count) unplanned", bundle: .module)
    }

    public static func unplannedBadge(_ plan: TurnSummary.Plan) -> String {
        isRequest(plan) ? String(localized: "Outside the request", bundle: .module) : String(localized: "Unplanned", bundle: .module)
    }
}

/// Where an approved plan went (`plan_approved.into`) — the plan row's line in the chat.
public enum PlanHandoffText {
    public static func line(_ info: PlanApprovedInfo) -> String {
        switch info.into {
        case .newChat: return String(localized: "Plan approved — implementing it in this new chat", bundle: .module)
        case .workbench:
            if let target = info.target {
                return String(localized: "Plan approved — sent to the workbench \((target as NSString).lastPathComponent) to implement there", bundle: .module)
            }
            let from = info.from.map { ($0 as NSString).lastPathComponent } ?? "?"
            return String(localized: "Implementing the plan approved in \(from)", bundle: .module)
        }
    }
}

/// The branch the New Workbench sheet suggests for a plan: `plan/<file name>` ("db-migration.md" → "plan/db-migration").
public enum PlanBranchName {
    public static func suggest(planPath: String?) -> String {
        guard let path = planPath else { return "" }
        let stem = ((path as NSString).lastPathComponent as NSString).deletingPathExtension.lowercased()
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-_.")
        var slug = String(stem.map { allowed.contains($0) ? $0 : "-" })
        while slug.contains("--") { slug = slug.replacingOccurrences(of: "--", with: "-") }
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-."))
        return slug.isEmpty ? "" : "plan/\(slug)"
    }
}
