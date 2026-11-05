import Foundation

// MARK: wave3 mac-flow
// The decisions behind the daily-flow screens of docs/PROTOCOL.md §36.11–36.14, kept free of SwiftUI so they are tested:
// the commit template preview, which pre-review findings show where, what "Send to Claude" puts in the composer and where
// a PR workbench / side question starts from.

// MARK: - §36.11 Commit message template

public enum CommitTemplate {
    /// `{issue}`: the branch name's longest run of digits, the first of equals (`feature/acme/4821-17` → `4821`; "" without
    /// one) — the engine's rule without the subjects (§41.1; §36.11 took the last run). MARK: wave4c w4c-commit
    public static func issue(fromBranch branch: String?) -> String {
        guard let branch else { return "" }
        var runs: [String] = []
        var current = ""
        for ch in branch {
            if ch.isASCII, ch.isNumber {
                current.append(ch)
            } else if !current.isEmpty {
                runs.append(current)
                current = ""
            }
        }
        if !current.isEmpty { runs.append(current) }
        return runs.reduce("") { $1.count > $0.count ? $1 : $0 }
    }

    /// The template as the engine renders it for the draft: `{issue}` and `{branch}` substituted.
    public static func render(_ template: String, branch: String?) -> String {
        template.replacingOccurrences(of: "{issue}", with: issue(fromBranch: branch))
            .replacingOccurrences(of: "{branch}", with: branch ?? "")
    }
}

// MARK: - §36.12 Workbench defaults

public enum WorkbenchDefaults {
    /// The base the New Workbench sheet starts with. Fetching by default (an engine that knows §36.12): the remote twin of the
    /// main worktree's branch (`origin/develop` — where new work starts), else of the current branch; otherwise the current
    /// branch as before. `origin` wins over another remote with the same branch.
    public static func base(current: String, mainBranch: String?, remotes: [String], fetchBase: Bool, supportsSetup: Bool) -> String {
        guard supportsSetup, fetchBase else { return current }
        func twin(_ branch: String?) -> String? {
            guard let branch, !branch.isEmpty else { return nil }
            let matches = remotes.filter { $0.hasSuffix("/" + branch) && $0.split(separator: "/").count == branch.split(separator: "/").count + 1 }
            return matches.first { $0.hasPrefix("origin/") } ?? matches.first
        }
        return twin(mainBranch) ?? twin(current) ?? current
    }
}

// MARK: - §36.13 AI pre-review display

/// What the Changes head says about the AI pre-review.
public enum PreReviewHeadStatus: Sendable, Equatable {
    /// No round run (or the last one was cancelled without findings).
    case idle
    case running(prereviewId: String)
    /// `count` visible findings (round + main chat); `stale`: the round run looked at an earlier B.
    case done(count: Int, stale: Bool)
    case failed(reason: String)
}

/// A shown finding with the run it came from (its id, its B, its source).
public struct PreReviewItem: Sendable, Equatable, Identifiable {
    public var run: PreReviewRun
    public var finding: PreReviewFinding

    public var id: String { "\(run.prereviewId)#\(finding.id)" }

    public init(run: PreReviewRun, finding: PreReviewFinding) {
        self.run = run
        self.finding = finding
    }
}

public enum PreReviewDisplay {
    /// The runs whose findings are shown: the newest round run (an older one is replaced by it) and the main chat's
    /// ReportFindings runs. Newest first, as the engine keeps them.
    public static func shownRuns(_ runs: [PreReviewRun]) -> [PreReviewRun] {
        var out: [PreReviewRun] = []
        var roundSeen = false
        for run in runs {
            switch run.source {
            case .main:
                out.append(run)
            case .round:
                if !roundSeen { out.append(run); roundSeen = true }
            }
        }
        return out
    }

    /// The newest round run (what the head button reports on).
    public static func latestRound(_ runs: [PreReviewRun]) -> PreReviewRun? { runs.first { $0.source == .round } }

    /// A run looked at another B than the review shows now: its lines may have moved (findings are dimmed).
    public static func isStale(_ run: PreReviewRun, reviewEndTree: String?) -> Bool {
        guard let endTree = run.endTree, let reviewEndTree else { return false }
        return endTree != reviewEndTree
    }

    /// Every shown finding with its run.
    public static func shownFindings(_ runs: [PreReviewRun]) -> [PreReviewItem] {
        shownRuns(runs).flatMap { run in run.findings.map { PreReviewItem(run: run, finding: $0) } }
    }

    public static func findings(_ runs: [PreReviewRun], path: String) -> [PreReviewItem] {
        shownFindings(runs).filter { $0.finding.file == path }
    }

    /// Findings of `path` on the new-side line `line`.
    public static func findings(_ runs: [PreReviewRun], path: String, line: Int) -> [PreReviewItem] {
        findings(runs, path: path).filter { $0.finding.line == line }
    }

    /// MARK: wave7 w7-state — §45.2: `findings(runs, path:, line:)` of every new-side line of `path`, in one pass.
    public static func findingsByLine(_ runs: [PreReviewRun], path: String) -> [Int: [PreReviewItem]] {
        var out: [Int: [PreReviewItem]] = [:]
        for item in findings(runs, path: path) {
            if let line = item.finding.line { out[line, default: []].append(item) }
        }
        return out
    }

    /// Findings of `path` that no shown diff line carries: the whole file (no line) or a line outside the hunks.
    public static func unplacedFindings(_ runs: [PreReviewRun], path: String, newLines: Set<Int>) -> [PreReviewItem] {
        findings(runs, path: path).filter { item in item.finding.line.map { !newLines.contains($0) } ?? true }
    }

    /// Files with findings and how many, for the changed-files list.
    public static func counts(_ runs: [PreReviewRun]) -> [String: Int] {
        var out: [String: Int] = [:]
        for item in shownFindings(runs) { out[item.finding.file, default: 0] += 1 }
        return out
    }

    public static func headStatus(_ runs: [PreReviewRun], reviewEndTree: String?) -> PreReviewHeadStatus {
        let count = shownFindings(runs).count
        guard let round = latestRound(runs) else { return count > 0 ? .done(count: count, stale: false) : .idle }
        switch round.status {
        case .running: return .running(prereviewId: round.prereviewId)
        case .failed: return .failed(reason: FlowText.preReviewFailure(round.error))
        case .cancelled: return count > 0 ? .done(count: count, stale: isStale(round, reviewEndTree: reviewEndTree)) : .idle
        case .done: return .done(count: count, stale: isStale(round, reviewEndTree: reviewEndTree))
        }
    }

    /// The text of a review note made from a finding ("Add as note").
    public static func noteBody(_ finding: PreReviewFinding) -> String {
        let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let scenario = finding.failureScenario.trimmingCharacters(in: .whitespacesAndNewlines)
        let head = summary.isEmpty ? finding.shortSummary : summary
        return scenario.isEmpty ? head : "\(head)\n\(scenario)"
    }

    /// The side question asked about a finding ("Ask in a side thread").
    public static func sideQuestion(_ finding: PreReviewFinding) -> String {
        let summary = finding.summary.isEmpty ? finding.shortSummary : finding.summary
        return String(localized: "The AI pre-review flagged this: “\(summary)” — is it right, and what would you change?", bundle: .module)
    }
}

// MARK: - §36.14 PRs and Claude

/// A review comment and its replies (GitHub replies always name the thread's first comment).
public struct PRCommentThread: Sendable, Equatable, Identifiable {
    public var root: PRComment
    public var replies: [PRComment]

    public var id: Int { root.id }
    public var comments: [PRComment] { [root] + replies }
    public var last: PRComment { replies.last ?? root }
}

public enum PRClaude {
    /// The comments grouped in threads (oldest first; replies in order).
    public static func threads(_ comments: [PRComment]) -> [PRCommentThread] {
        let roots = comments.filter { $0.inReplyTo == nil }.sorted { $0.createdAt < $1.createdAt }
        var replies: [Int: [PRComment]] = [:]
        let rootIds = Set(roots.map(\.id))
        var orphans: [PRComment] = []
        for comment in comments where comment.inReplyTo != nil {
            if let parent = comment.inReplyTo, rootIds.contains(parent) {
                replies[parent, default: []].append(comment)
            } else {
                orphans.append(comment)   // its first comment was deleted: a thread of its own
            }
        }
        var out = roots.map { PRCommentThread(root: $0, replies: (replies[$0.id] ?? []).sorted { $0.createdAt < $1.createdAt }) }
        out += orphans.sorted { $0.createdAt < $1.createdAt }.map { PRCommentThread(root: $0, replies: []) }
        return out
    }

    /// The thread a comment belongs to.
    public static func thread(of comment: PRComment, in comments: [PRComment]) -> PRCommentThread? {
        let rootId = comment.inReplyTo ?? comment.id
        return threads(comments).first { $0.id == rootId || $0.comments.contains { $0.id == comment.id } }
    }

    /// Threads still waiting for the PR author's answer: the last word is someone else's. GitHub's REST comments carry no
    /// "resolved" flag, so a thread the user already answered (the pr-review-respond skill replies to each) counts as
    /// handled. Without the user's login every thread counts.
    public static func unresolved(_ threads: [PRCommentThread], me: String?) -> [PRCommentThread] {
        guard let me, !me.isEmpty else { return threads }
        return threads.filter { $0.last.author.caseInsensitiveCompare(me) != .orderedSame }
    }

    /// `prRespondCommand` with `{pr}` = the PR number; nil when the setting is empty.
    public static func respondCommand(_ template: String?, number: Int) -> String? {
        let trimmed = (template ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "{pr}", with: String(number))
    }

    /// The composer draft for review comments: the respond command first (when set), then what to handle — file, line,
    /// author and body of each thread, the bodies quoted (a PR's text is the reviewers', not the user's instruction).
    public static func draft(prNumber: Int, prTitle: String, threads: [PRCommentThread], command: String?) -> String {
        var lines: [String] = []
        if let command { lines.append(command); lines.append("") }
        if threads.count == 1 {
            lines.append(String(localized: "Handle this review comment on PR #\(prNumber) (\(prTitle)):", bundle: .module))
        } else {
            lines.append(String(localized: "Handle these \(threads.count) review comments on PR #\(prNumber) (\(prTitle)):", bundle: .module))
        }
        for thread in threads {
            lines.append("")
            let location = thread.root.line.map { "\(thread.root.path):\($0)" } ?? thread.root.path
            for (index, comment) in thread.comments.enumerated() {
                let head = index == 0 ? "- \(location) — @\(comment.author):" : "  ↳ @\(comment.author):"
                lines.append(head)
                for bodyLine in comment.body.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false) {
                    lines.append("  > \(bodyLine)")
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    /// The branch a PR workbench is created on: the head branch, or `pr-<number>` when the head name cannot be told apart
    /// from the base (a fork's `main` / `develop`, an empty name).
    public static func workbenchBranch(number: Int, headRef: String, baseRef: String) -> String {
        let head = headRef.trimmingCharacters(in: .whitespaces)
        if head.isEmpty || head == baseRef { return "pr-\(number)" }
        return head
    }

    /// `owner/name` of a GitHub-style remote (`git@host:o/r.git`, `https://host/o/r(.git)`, `ssh://git@host/o/r`), lowercased.
    public static func repoSlug(remote: String?) -> String? {
        guard let remote = remote?.trimmingCharacters(in: .whitespacesAndNewlines), !remote.isEmpty else { return nil }
        var path: String
        if remote.hasPrefix("git@"), let colon = remote.firstIndex(of: ":") {
            path = String(remote[remote.index(after: colon)...])
        } else if let url = URL(string: remote), url.host != nil {
            path = url.path
        } else {
            return nil
        }
        path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path.hasSuffix(".git") { path.removeLast(4) }
        let parts = path.split(separator: "/")
        guard parts.count >= 2 else { return nil }
        return parts.suffix(2).joined(separator: "/").lowercased()
    }

    /// The PR is of the open project's repository (`PRSummary.repo` = `owner/name`); false when either is unknown.
    public static func isProjectRepo(prRepo: String?, remote: String?) -> Bool {
        guard let prRepo, let slug = repoSlug(remote: remote) else { return false }
        return prRepo.lowercased() == slug
    }

    /// The hunk around `line` as unified text (`@@ … @@`, then ` `/`+`/`-` lines), cut at `SidePrAnchor.maxHunkChars`.
    public static func hunkText(_ diff: FileDiff, around line: DiffLine) -> String {
        guard let hunk = diff.hunks.first(where: { $0.lines.contains { $0.id == line.id } }) else { return line.text }
        var out = ""
        for l in hunk.lines {
            let prefix: String
            switch l.kind {
            case .hunkHeader: prefix = ""
            case .add: prefix = "+"
            case .del: prefix = "-"
            case .context: prefix = " "
            }
            let row = prefix + l.text + "\n"
            if out.count + row.count > SidePrAnchor.maxHunkChars { break }
            out += row
        }
        return out
    }

    /// A side-question anchor on a PR diff line: its number on the side it lives on (`LEFT` for a deleted line).
    public static func anchor(number: Int, path: String, line: DiffLine, diff: FileDiff, commitId: String?) -> SidePrAnchor? {
        guard line.kind != .hunkHeader else { return nil }
        let side = line.kind == .del ? "LEFT" : "RIGHT"
        let no = line.kind == .del ? line.oldNo : line.newNo
        return SidePrAnchor(number: number, path: path, line: no, side: side, hunk: hunkText(diff, around: line), commitId: commitId)
    }
}

public extension PRClaude {
    /// The anchor's hunk text read back as a diff (numbered from its `@@ -a,b +c,d @@` header), for the side question's
    /// preview; nil without a header.
    static func previewDiff(_ pr: SidePrAnchor) -> FileDiff? {
        var lines: [DiffLine] = []
        var oldNo = 0, newNo = 0, started = false
        for raw in pr.hunk.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if raw.hasPrefix("@@") {
                guard let header = hunkStarts(raw) else { continue }
                (oldNo, newNo) = header
                started = true
                lines.append(DiffLine(id: lines.count, kind: .hunkHeader, oldNo: nil, newNo: nil, text: raw))
                continue
            }
            guard started, let first = raw.first else { continue }
            let text = String(raw.dropFirst())
            switch first {
            case "+":
                lines.append(DiffLine(id: lines.count, kind: .add, oldNo: nil, newNo: newNo, text: text))
                newNo += 1
            case "-":
                lines.append(DiffLine(id: lines.count, kind: .del, oldNo: oldNo, newNo: nil, text: text))
                oldNo += 1
            case " ":
                lines.append(DiffLine(id: lines.count, kind: .context, oldNo: oldNo, newNo: newNo, text: text))
                oldNo += 1
                newNo += 1
            default:
                continue   // "\ No newline at end of file"
            }
        }
        guard started else { return nil }
        return FileDiff(oldPath: pr.path, newPath: pr.path, isBinary: false, hunks: [DiffHunk(id: 0, header: lines.first?.text ?? "", lines: lines)])
    }

    /// The preview's anchor inside `previewDiff` (the line on its side).
    static func previewAnchor(_ pr: SidePrAnchor) -> SideAnchor {
        SideAnchor(line: pr.line, side: pr.side == "LEFT" ? .old : .new)
    }

    /// `@@ -10,3 +12,4 @@` → (10, 12).
    private static func hunkStarts(_ header: String) -> (Int, Int)? {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func start(_ part: Substring) -> Int? { Int(part.dropFirst().split(separator: ",").first ?? "") }
        guard let old = start(parts[1]), let new = start(parts[2]) else { return nil }
        return (old, new)
    }
}

public extension SideQuestionText {
    /// `PR #512 · api/Svc.java:42` (the side question's anchor chip and header).
    static func prLocation(_ pr: SidePrAnchor) -> String {
        let place = pr.line.map { "\(pr.path):\($0)" } ?? pr.path
        return "PR #\(pr.number) · \(place)"
    }
}

// MARK: - Words

/// The refusals and failures of the flow commands in the user's words (everything else: `EngineMessages.refusal`).
public enum FlowText {
    public static func refusal(_ error: Error) -> String {
        guard let error = error as? EngineClientError else { return error.localizedDescription }
        guard case let .refused(message, code, _, _) = error else { return error.userMessage }
        let word = code ?? EngineMessages.codeWord(message)
        return refusal(code: word, detail: EngineMessages.detail(of: message, code: word)) ?? error.userMessage
    }

    /// nil = a code these screens do not word themselves.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "unknown_command": return updateReason
        case "nothing_to_commit": return String(localized: "Select accepted files first — only accepted files can be committed", bundle: .module)
        case "side_limit": return String(localized: "Too many side sessions are running — wait for one to finish", bundle: .module)
        case "commit_draft_failed":
            return detail.isEmpty ? String(localized: "Claude could not write a message", bundle: .module)
                : String(localized: "Claude could not write a message: \(detail)", bundle: .module)
        case "pr_ai_draft_failed":   // §51
            return detail.isEmpty ? String(localized: "Claude could not fill in the PR", bundle: .module)
                : String(localized: "Claude could not fill in the PR: \(detail)", bundle: .module)
        case "empty_base": return String(localized: "Choose a base branch first", bundle: .module)
        case "fetch_failed":
            return detail.isEmpty ? String(localized: "Could not fetch from the remote", bundle: .module)
                : String(localized: "Could not fetch from the remote: \(detail)", bundle: .module)
        case "no_review": return String(localized: "There is no review to pre-review yet", bundle: .module)
        case "prereview_running": return String(localized: "A pre-review is already running", bundle: .module)
        case "not_a_changed_file":
            return String(localized: "Not a changed file of this review: \(detail)", bundle: .module)
        case "invalid_prereview": return String(localized: "That pre-review request is not valid", bundle: .module)
        case "unknown_prereview": return String(localized: "That pre-review is gone", bundle: .module)
        case "unknown_finding": return String(localized: "That finding is gone", bundle: .module)
        case "not_running": return String(localized: "The pre-review has already ended", bundle: .module)
        default: return nil
        }
    }

    /// A failed run's `error` (English code words like refusals) in the user's words.
    public static func preReviewFailure(_ error: String?) -> String {
        guard let error, !error.isEmpty else { return String(localized: "The pre-review failed", bundle: .module) }
        // The engine stopped it (the app closed, the chat changed): "interrupted (ReviewGate was closed)".
        if error.hasPrefix("interrupted") { return String(localized: "Interrupted — ReviewGate was closed or the chat changed", bundle: .module) }
        let word = EngineMessages.codeWord(error)
        return refusal(code: word, detail: EngineMessages.detail(of: error, code: word)) ?? error
    }

    /// The one-line reason a §36.11–36.14 control is off with an engine before §36.
    public static var updateReason: String {
        String(localized: "This engine does not support it yet — update ReviewGate", bundle: .module)
    }

    /// `12.3 KB`
    public static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
