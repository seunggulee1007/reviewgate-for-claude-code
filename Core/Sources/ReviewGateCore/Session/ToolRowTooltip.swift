import Foundation

// MARK: polish p-foundation — P3-transcript-07: a tool row's tooltip says in words what the call did and what a click
// does — "명령 실행: npm test", "파일 읽기: src/Svc.java", "src/Svc.java 편집 — 클릭하면 diff 보기" — instead of its input as
// raw JSON (that goes to the row's "입력 복사 (JSON)"). The Windows client says the same with the same keys
// (clients/desktop/src/renderer/toolRowTooltip.ts).

public enum ToolRowTooltip {
    /// A command, pattern, path or URL in the tooltip is cut past this many characters ("…").
    public static let valueLimit = 600
    /// The JSON of a call these words do not cover: at most this many characters (`TranscriptRowCache.tooltipLimit`).
    public static let jsonLimit = 4_000

    /// The tooltip of a tool call's row. `root`: the project — paths under it read relative to it. `linked`: a click on the
    /// row shows a reviewed file's diff. A call these words do not cover shows its input as JSON (as before, at most
    /// `jsonLimit` characters).
    public static func text(name: String, input: JSONValue, root: URL?, linked: Bool) -> String {
        let lines = words(name: name, input: input, root: root, linked: linked)
            ?? [input.prettyPrinted(limit: jsonLimit)]
        let isEdit = ToolCallRecord.editTools.contains(name)
        // An edit says it in its own line; any other row a click opens a diff from says it last.
        let click = linked && !isEdit ? [String(localized: "Click to show the diff of the files it changed", bundle: .module)] : []
        return (lines + click).joined(separator: "\n")
    }

    private static func words(name: String, input: JSONValue, root: URL?, linked: Bool) -> [String]? {
        if ToolCallRecord.editTools.contains(name) {
            guard let path = path(input, root: root) else { return nil }
            return [linked ? String(localized: "Edits \(path) — click to show its diff", bundle: .module)
                           : String(localized: "Edits \(path)", bundle: .module)]
        }
        switch name {
        case "Bash":
            guard let command = value(input["command"]) else { return nil }
            let description = value(input["description"])
            return [String(localized: "Runs: \(command)", bundle: .module)]
                + (description.map { [String(localized: "Description: \($0)", bundle: .module)] } ?? [])
        case "Read":
            return path(input, root: root).map { [String(localized: "Reads \($0)", bundle: .module)] }
        case "Grep":
            guard let pattern = value(input["pattern"]) else { return nil }
            if let scope = scope(input, root: root) {
                return [String(localized: "Searches for \(pattern) in \(scope)", bundle: .module)]
            }
            return [String(localized: "Searches for \(pattern)", bundle: .module)]
        case "Glob":
            guard let pattern = value(input["pattern"]) else { return nil }
            if let scope = scope(input, root: root) {
                return [String(localized: "Finds files: \(pattern) in \(scope)", bundle: .module)]
            }
            return [String(localized: "Finds files: \(pattern)", bundle: .module)]
        case "WebFetch":
            return value(input["url"]).map { [String(localized: "Reads the web page \($0)", bundle: .module)] }
        case "WebSearch":
            return value(input["query"]).map { [String(localized: "Searches the web for \($0)", bundle: .module)] }
        case "Task", "Agent":
            guard let what = value(input["description"]) ?? value(input["subagent_type"]) else { return nil }
            return [String(localized: "Starts an agent: \(what)", bundle: .module)]
        case "TodoWrite":
            return [String(localized: "Updates the to-do list", bundle: .module)]
        default:
            break
        }
        let label = ToolLabel.of(name, input: input)
        switch label.kind {
        case .skill:
            let skill = [label.name.isEmpty ? nil : label.name, label.arg].compactMap { $0 }.joined(separator: " ")
            return skill.isEmpty ? nil : [String(localized: "Skill: \(skill)", bundle: .module)]
        case .mcp:
            // "acme · list issues" and its representative argument — the words the row's label uses (§39.3).
            return ["\(label.server ?? "") · \(label.name)"] + (label.arg.map { [$0] } ?? [])
        case .tool:
            return nil
        }
    }

    /// The call's file (`file_path`, a notebook's `notebook_path`), relative to `root` when under it.
    private static func path(_ input: JSONValue, root: URL?) -> String? {
        guard let raw = value(input["file_path"]) ?? value(input["notebook_path"]) else { return nil }
        return TouchedFile(path: raw, tools: [], count: 0).relativePath(to: root)
    }

    /// Where a search looks: its `path` (relative to `root` when under it), else its `glob` filter.
    private static func scope(_ input: JSONValue, root: URL?) -> String? {
        if let raw = value(input["path"]) { return TouchedFile(path: raw, tools: [], count: 0).relativePath(to: root) }
        return value(input["glob"])
    }

    /// A string field, trimmed and at most `valueLimit` characters; nil when absent or blank.
    private static func value(_ field: JSONValue?) -> String? {
        guard let text = field?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text.count > valueLimit ? String(text.prefix(valueLimit)) + "…" : text
    }
}
