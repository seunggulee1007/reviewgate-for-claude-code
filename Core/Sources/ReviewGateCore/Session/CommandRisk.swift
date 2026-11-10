import Foundation

// MARK: - Shell line scanner

/// A shell command line split into simple commands (`;`, `&&`, `||`, `|`, newline), quotes honoured. Anything the
/// engine treats as "not a simple command" (§19.3: redirection, `$(…)`, backticks, subshell / brace group, background
/// `&`, `|&`, an unterminated quote) sets `isComplex` — the permission card never derives an allow pattern from it.
public struct ShellCommandLine: Sendable, Equatable {
    /// Each simple command's words, quotes removed.
    public var segments: [[String]]
    public var isComplex: Bool
    /// The line contains a quote character (an exact pattern could not reproduce the quoting).
    public var hasQuotes: Bool

    public init(_ line: String) {
        var segments: [[String]] = []
        var words: [String] = []
        var word = ""
        var inWord = false
        var complex = false
        var quotes = false
        let chars = Array(line)
        var i = 0
        func endWord() {
            if inWord { words.append(word) }
            word = ""
            inWord = false
        }
        func endSegment() {
            endWord()
            if !words.isEmpty { segments.append(words) }
            words = []
        }
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            switch c {
            case "'":
                quotes = true
                inWord = true
                guard let close = chars[(i + 1)...].firstIndex(of: "'") else { complex = true; i = chars.count; continue }
                word += String(chars[(i + 1)..<close])
                i = close + 1
                continue
            case "\"":
                quotes = true
                inWord = true
                var j = i + 1
                var closed = false
                while j < chars.count {
                    let d = chars[j]
                    if d == "\\", j + 1 < chars.count { word.append(chars[j + 1]); j += 2; continue }
                    if d == "\"" { closed = true; break }
                    if d == "`" || (d == "$" && j + 1 < chars.count && chars[j + 1] == "(") { complex = true }
                    word.append(d)
                    j += 1
                }
                if !closed { complex = true }
                i = j + 1
                continue
            case "\\":
                inWord = true
                if let next { word.append(next); i += 2 } else { i += 1 }
                continue
            case " ", "\t":
                endWord()
            case "\n", ";":
                endSegment()
            case "&":
                if next == "&" { endSegment(); i += 2; continue }
                complex = true   // background job
                endSegment()
            case "|":
                if next == "|" { endSegment(); i += 2; continue }
                if next == "&" { complex = true; i += 2; endSegment(); continue }
                endSegment()
            case ">", "<", "(", ")", "`":
                complex = true
                endWord()
            case "$":
                if next == "(" { complex = true }
                inWord = true
                word.append(c)
            case "{", "}":
                if !inWord { complex = true }
                inWord = true
                word.append(c)
            default:
                inWord = true
                word.append(c)
            }
            i += 1
        }
        endSegment()
        self.segments = segments
        self.isComplex = complex
        self.hasQuotes = quotes
    }

    /// `FOO=1 sudo env BAR=2 npm test` → `npm test …`: leading assignments and pass-through wrappers dropped.
    static func effectiveWords(_ words: [String]) -> [String] {
        var rest = words[...]
        while let first = rest.first {
            if isAssignment(first) || ["sudo", "env", "command", "time", "nohup", "nice", "exec", "builtin"].contains(first) {
                rest = rest.dropFirst()
                // `sudo -u x` / `nice -n 5`: their own flags go too.
                while let flag = rest.first, flag.hasPrefix("-") {
                    rest = rest.dropFirst()
                    if ["-u", "-g", "-n", "-p", "-C", "-h", "-U"].contains(flag) { rest = rest.dropFirst() }   // the flag's value
                }
            } else {
                break
            }
        }
        return Array(rest)
    }

    static func isAssignment(_ word: String) -> Bool {
        guard let eq = word.firstIndex(of: "="), eq != word.startIndex else { return false }
        return word[..<eq].allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
    }
}

// MARK: - Risk summary

/// What a permission request may do that deserves a second look (client-side heuristics only — the engine's
/// classifier and the review gate stay the authority).
public enum CommandRiskKind: String, Sendable, CaseIterable, Hashable {
    case deletion, gitHistory, outsideProject, network

    public var title: String {
        switch self {
        case .network: String(localized: "Network access", bundle: .module)
        case .deletion: String(localized: "Deletes files", bundle: .module)
        case .outsideProject: String(localized: "Outside the project", bundle: .module)
        case .gitHistory: String(localized: "Changes git history", bundle: .module)
        }
    }

    /// SF Symbol for the kind.
    public var symbol: String {
        switch self {
        case .network: "network"
        case .deletion: "trash"
        case .outsideProject: "folder.badge.questionmark"
        case .gitHistory: "arrow.triangle.branch"
        }
    }
}

public struct CommandRisk: Sendable, Equatable {
    /// Most severe first (`CommandRiskKind.allCases` order).
    public var kinds: [CommandRiskKind]

    public var isEmpty: Bool { kinds.isEmpty }
    /// "Deletes files · Network access", or the no-risk line.
    public var summary: String {
        kinds.isEmpty ? String(localized: "No risky patterns found", bundle: .module) : kinds.map(\.title).joined(separator: " · ")
    }
    public var symbol: String { kinds.first?.symbol ?? "checkmark.shield" }

    public init(kinds: [CommandRiskKind]) {
        let set = Set(kinds)
        self.kinds = CommandRiskKind.allCases.filter(set.contains)
    }

    /// The risk of a permission request: Bash by its command, web tools as network, edits by their target path.
    public static func assess(_ request: PermissionRequest, projectRoot: String?) -> CommandRisk {
        switch request.toolName {
        case "Bash":
            return assessBash(request.input["command"]?.stringValue ?? "", projectRoot: projectRoot)
        case "WebFetch", "WebSearch":
            return CommandRisk(kinds: [.network])
        default:
            let path = request.file ?? request.input["file_path"]?.stringValue ?? request.input["notebook_path"]?.stringValue
            if let path, let root = projectRoot, isOutside(path, root: root) { return CommandRisk(kinds: [.outsideProject]) }
            return CommandRisk(kinds: [])
        }
    }

    public static func assessBash(_ command: String, projectRoot: String?) -> CommandRisk {
        let line = ShellCommandLine(command)
        var kinds: Set<CommandRiskKind> = []
        for segment in line.segments {
            let words = ShellCommandLine.effectiveWords(segment)
            guard let first = words.first else { continue }
            let program = (first as NSString).lastPathComponent
            let args = Array(words.dropFirst())
            let sub = args.first { !$0.hasPrefix("-") }
            kinds.formUnion(classify(program: program, sub: sub, args: args))
            if let root = projectRoot {
                for arg in args where pathOutside(arg, root: root) { kinds.insert(.outsideProject) }
                if pathOutside(first, root: root), first.contains("/") { kinds.insert(.outsideProject) }
            }
        }
        return CommandRisk(kinds: Array(kinds))
    }

    private static let networkPrograms: Set<String> = ["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "http", "https", "gh"]
    private static let packageManagers: Set<String> = ["npm", "pnpm", "yarn", "bun", "npx", "pip", "pip3", "pipx", "brew", "gem", "cargo", "go", "poetry", "uv", "composer", "apt", "apt-get", "dnf", "yum"]
    private static let installVerbs: Set<String> = ["install", "i", "add", "ci", "update", "upgrade", "up", "publish", "get", "fetch", "sync", "dlx", "exec", "x"]

    private static func classify(program: String, sub: String?, args: [String]) -> Set<CommandRiskKind> {
        var out: Set<CommandRiskKind> = []
        if networkPrograms.contains(program) { out.insert(.network) }
        if program == "npx" || program == "bunx" { out.insert(.network) }
        if packageManagers.contains(program), let sub, installVerbs.contains(sub) { out.insert(.network) }
        if ["docker", "podman"].contains(program), let sub, ["pull", "push", "login", "run"].contains(sub) { out.insert(.network) }
        if ["rm", "rmdir", "unlink", "shred", "truncate", "srm"].contains(program) { out.insert(.deletion) }
        if program == "find", args.contains("-delete") || args.contains("-exec") { out.insert(.deletion) }
        if program == "git", let sub {
            switch sub {
            case "push":
                out.insert(.network)
                if args.contains(where: { $0 == "-f" || $0.hasPrefix("--force") || $0 == "--delete" || $0 == "-d" || $0.hasPrefix("+") }) {
                    out.insert(.gitHistory)
                }
            case "fetch", "pull", "clone", "ls-remote", "submodule":
                out.insert(.network)
                if sub == "pull" { out.insert(.gitHistory) }
            case "clean", "rm":
                out.insert(.deletion)
            case "reset":
                out.insert(.gitHistory)
                if args.contains("--hard") || args.contains("--merge") || args.contains("--keep") { out.insert(.deletion) }
            case "checkout", "restore":
                if args.contains("--") || args.contains(".") || args.contains("-f") || args.contains("--force") { out.insert(.deletion) }
            case "commit", "rebase", "merge", "cherry-pick", "revert", "am", "filter-branch", "filter-repo", "update-ref", "replace", "reflog":
                out.insert(.gitHistory)
            case "branch":
                if args.contains(where: { ["-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force"].contains($0) }) { out.insert(.gitHistory) }
            case "tag":
                if args.contains(where: { ["-d", "--delete", "-f", "--force"].contains($0) }) { out.insert(.gitHistory) }
            case "stash":
                if args.contains("drop") || args.contains("clear") { out.insert(.deletion) }
            default:
                break
            }
        }
        return out
    }

    /// A word that names a path outside `root`: absolute, `~`, or a relative path climbing out with `..`
    /// (also the value of `--flag=/path`). `/dev/null` and friends are not outside anything.
    static func pathOutside(_ word: String, root: String) -> Bool {
        var candidate = word
        if candidate.hasPrefix("-"), let eq = candidate.firstIndex(of: "=") { candidate = String(candidate[candidate.index(after: eq)...]) }
        guard !candidate.isEmpty, !candidate.contains("://") else { return false }
        if candidate.hasPrefix("/dev/") { return false }
        if candidate.hasPrefix("~") {
            return isOutside((candidate as NSString).expandingTildeInPath, root: root)
        }
        if candidate.hasPrefix("/") { return isOutside(candidate, root: root) }
        guard candidate == ".." || candidate.hasPrefix("../") || candidate.contains("/../") else { return false }
        return isOutside((root as NSString).appendingPathComponent(candidate), root: root)
    }

    static func isOutside(_ path: String, root: String) -> Bool {
        let p = (path as NSString).standardizingPath
        let r = (root as NSString).standardizingPath
        return !(p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/"))
    }
}

// MARK: - "Always allow in this project"

/// Derives the allow pattern the permission card offers for a Bash command (docs/PROTOCOL.md §10 / §19.3 syntax).
/// Never broader than program + subcommand: `npm test -- --watch` → `Bash(npm test:*)`; a command whose second word is
/// not a plain subcommand, or one with network access, gets the exact command (`Bash(make)`, `Bash(npm install)`) — but a
/// `git push` of any branch gets `Bash(git push:*)` (r2 M21; force / delete pushes are git cards no pattern answers).
/// Lines that are not one simple command — chains, redirections, substitutions, wrappers like `sudo` / `sh -c` /
/// `xargs` — and commands that delete, rewrite git history or name paths outside the project get nothing.
public enum BashAllowPattern {
    /// Programs that run some other command (or arbitrary code from their arguments): a pattern over them would allow anything.
    static let refused: Set<String> = [
        "sudo", "su", "doas", "env", "eval", "exec", "xargs", "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
        "source", ".", "nohup", "time", "command", "builtin", "nice", "timeout", "watch", "parallel", "script", "osascript",
        "ssh", "awk", "gawk", "perl", "python", "python3", "ruby", "node", "deno", "php", "lua", "find",
    ]

    public static func derive(_ command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let line = ShellCommandLine(trimmed)
        guard !line.isComplex, line.segments.count == 1, let words = line.segments.first, let program = words.first else { return nil }
        guard !ShellCommandLine.isAssignment(program), !refused.contains((program as NSString).lastPathComponent),
              !program.contains(where: { "*?[$".contains($0) }) else { return nil }
        // Never remember a command that deletes, rewrites history or reaches outside the project — ask every time.
        let kinds = CommandRisk.assessBash(trimmed, projectRoot: nil).kinds
        guard !kinds.contains(.deletion), !kinds.contains(.gitHistory),
              !words.dropFirst().contains(where: { $0.hasPrefix("/") || $0.hasPrefix("~") || $0 == ".." || $0.contains("../") || $0.contains("=/") })
        else { return nil }
        let risky = !kinds.isEmpty
        if !risky, words.count >= 2, isSubcommand(words[1]) {
            return "Bash(\(program) \(words[1]):*)"
        }
        // MARK: r2-skills-side — §33.6 (M21): any push of any branch, not this branch's exact line — a force / delete push is
        // a git card (§46) no pattern answers, and the deletion / history guard above refused those forms already.
        if (program as NSString).lastPathComponent == "git", words.count >= 2, words[1] == "push" {
            return "Bash(git push:*)"
        }
        // Exact form: the command as typed, whitespace collapsed; quoting or glob characters could not be reproduced.
        guard !line.hasQuotes, !trimmed.contains(where: { "*?[".contains($0) }) else { return nil }
        return "Bash(\(words.joined(separator: " ")))"
    }

    /// `test`, `run`, `build:prod`, `lint-fix` — not a flag, path, file name or variable.
    static func isSubcommand(_ word: String) -> Bool {
        guard let first = word.unicodeScalars.first, CharacterSet.lowercaseLetters.contains(first) else { return false }
        return word.unicodeScalars.allSatisfy { CharacterSet.lowercaseLetters.contains($0) || CharacterSet.decimalDigits.contains($0) || ":_-".unicodeScalars.contains($0) }
    }
}
