import Foundation

// MARK: wave4 w4-check3
// Two 0.2.3 follow-ups the Electron client shares word for word (clients/desktop/src/renderer/chatFollowups.ts):
// - a side question about a subagent's call (the Agent details sheet's "Ask in a side thread") offers questions about the
//   agent's work, not the tool-call ones ("Is this safe to allow?" is about a permission card);
// - the main chat's ReportFindings call (§36.13, `/code-review` reporting through the tool) reads as its findings in one
//   line instead of an empty row whose only detail is the raw input in a tooltip.

extension SideQuestionText {
    /// A subagent's call: `Agent`, or `Task` from older CLIs.
    public static func isAgentTool(_ name: String?) -> Bool { name == "Agent" || name == "Task" }

    /// `suggestions(for:)` that knows the anchored call's tool: an agent's call gets questions about what it did.
    public static func suggestions(for anchor: SideAnchor?, toolName: String?) -> [String] {
        guard let anchor, anchor.toolUseId != nil, anchor.path == nil, anchor.pr == nil, isAgentTool(toolName) else {
            return suggestions(for: anchor)
        }
        return agentSuggestions
    }

    /// The questions about a subagent's work (the same keys as Electron's `agentQuestions()`).
    public static var agentSuggestions: [String] {
        [String(localized: "What did this agent change?", bundle: .module),
         String(localized: "Did this agent do what it was asked?", bundle: .module),
         String(localized: "What are the key points of this report, and what should I check?", bundle: .module)]
    }
}

/// §36.13: a `ReportFindings` call's input (`{level, findings: [{file, line, summary, …}]}`) in one line.
public enum ReportFindingsLine {
    public static let toolName = "ReportFindings"

    /// "3 findings · Svc.java:42, Repo.java" (each file's last path component and its first finding's line; up to three, then
    /// "+N"); "No findings" for an empty list; nil when the input has no findings list (another tool's shape).
    public static func detail(input: JSONValue) -> String? {
        guard case let .array(items)? = input["findings"] else { return nil }
        let findings = items.compactMap(\.objectValue)
        guard !findings.isEmpty else { return String(localized: "No findings", bundle: .module) }
        var places: [String] = []
        var seen = Set<String>()
        for finding in findings {
            guard let file = finding["file"]?.stringValue?.trimmingCharacters(in: .whitespaces), !file.isEmpty,
                  seen.insert(file).inserted else { continue }
            let name = (file.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
            if case let .number(line)? = finding["line"], line.isFinite, line >= 1 {
                places.append("\(name):\(Int(line))")
            } else {
                places.append(name)
            }
        }
        let count = String(localized: "\(findings.count) findings", bundle: .module)
        guard !places.isEmpty else { return count }
        let shown = places.prefix(3).joined(separator: ", ")
        return places.count > 3 ? "\(count) · \(shown) +\(places.count - 3)" : "\(count) · \(shown)"
    }
}
