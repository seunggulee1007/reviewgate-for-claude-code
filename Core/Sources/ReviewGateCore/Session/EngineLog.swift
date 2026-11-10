import Foundation

// MARK: wave1 mac-session
// Audit robustness-03 ①② / crash-6: the engine's `log` events, the sidecar's stderr and the errors the user saw go to a
// daily file under ~/Library/Logs/ReviewGate (kept 7 days, secrets masked), the stderr copy of a `log` event is dropped,
// and "Copy Diagnostics" collects versions, the state, the last error and the recent lines for a bug report.

/// Masks what must not leave the machine in a log or a diagnostics paste — the same rules as the engine's `redactDetail`
/// (docs/PROTOCOL.md §30): the home folder as `~`, `sk-ant-…` keys, `Bearer …`, `…TOKEN=` / `password:` / `api_key=`
/// values and long opaque runs (UUIDs, paths and git SHAs stay readable).
public enum LogRedactor {
    // Compiled once: every log line goes through these.
    private static let anthropicKey = try? NSRegularExpression(pattern: #"sk-ant-[A-Za-z0-9_-]+"#)
    private static let bearer = try? NSRegularExpression(pattern: #"\b(Bearer)\s+[^\s"',;]+"#, options: [.caseInsensitive])
    private static let secretValue = try? NSRegularExpression(
        pattern: #"\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*["']?)(?!\*\*\*)[^\s"',;]+"#,
        options: [.caseInsensitive])
    private static let opaqueRun = try? NSRegularExpression(pattern: #"[A-Za-z0-9+/_=-]{32,}"#)

    public static func redact(_ text: String, home: String = NSHomeDirectory()) -> String {
        var out = text
        if !home.isEmpty, home != "/" {
            // The home folder itself, not a longer name that starts with it (`/Users/me` must not turn `/Users/meme` into `~me`).
            let pattern = NSRegularExpression.escapedPattern(for: home) + #"(?![A-Za-z0-9._-])"#
            out = replace(try? NSRegularExpression(pattern: pattern), in: out, with: "~")
        }
        out = replace(anthropicKey, in: out, with: "sk-ant-***")
        out = replace(bearer, in: out, with: "$1 ***")
        out = replace(secretValue, in: out, with: "$1$2***")
        return maskOpaqueRuns(out)
    }

    private static func replace(_ regex: NSRegularExpression?, in text: String, with template: String) -> String {
        guard let regex else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// Runs of 32+ token characters become `***` unless they are a UUID, a path, a git SHA or start / end with `-`.
    private static func maskOpaqueRuns(_ text: String) -> String {
        guard let regex = opaqueRun else { return text }
        let ns = text as NSString
        var result = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let run = ns.substring(with: match.range)
            result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += keepsRun(run) ? run : "***"
            cursor = match.range.location + match.range.length
        }
        result += ns.substring(from: cursor)
        return result
    }

    private static func keepsRun(_ run: String) -> Bool {
        if run.contains("/") || run.hasPrefix("-") || run.hasSuffix("-") { return true }
        if UUID(uuidString: run) != nil { return true }
        let hex = run.allSatisfy { $0.isHexDigit }
        return hex && (run.count == 40 || run.count == 64)   // git object ids (sha-1 / sha-256)
    }
}

/// Robustness-03 ②: the engine logs every line twice — its `log` event (stdout) and `[sidecar:<level>] <line>` on stderr,
/// which the transport turns into a `.debug` log — and the two pipes arrive in either order. A stderr line waits up to
/// `window` for its event; the twin is dropped, a line that never gets one (the sidecar's own words) is kept.
public struct SidecarLogDeduper: Sendable {
    public var window: TimeInterval
    private var recent: [(key: String, at: Date)] = []
    private var pending: [(key: String, line: String, at: Date)] = []

    public init(window: TimeInterval = 1.5) {
        self.window = window
    }

    public var hasPending: Bool { !pending.isEmpty }

    /// One `log` event / stderr line in; the lines to log now out (`[level] message`, the format the in-app log always had).
    public mutating func ingest(level: LogLevel, message: String, now: Date) -> [String] {
        var out = flush(now: now)
        if case let (lineLevel, text)? = Self.sidecarLine(level: level, message: message) {
            let key = lineLevel + "|" + text
            if let i = recent.firstIndex(where: { $0.key == key }) {
                recent.remove(at: i)
            } else {
                pending.append((key, "[\(level.rawValue)] \(message)", now))
            }
            return out
        }
        // A plain stderr line that continues a multi-line event already logged.
        if level == .debug, let i = recent.firstIndex(where: { $0.key == "|" + message }) {
            recent.remove(at: i)
            return out
        }
        let lines = message.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for (n, line) in lines.enumerated() {
            let key = n == 0 ? level.rawValue + "|" + line : "|" + line
            if let i = pending.firstIndex(where: { $0.key == key }) { pending.remove(at: i) } else { recent.append((key, now)) }
        }
        if recent.count > 512 { recent.removeFirst(recent.count - 512) }
        out.append("[\(level.rawValue)] \(message)")
        return out
    }

    /// The stderr lines whose twin did not come within `window` (kept, in arrival order).
    public mutating func flush(now: Date) -> [String] {
        recent.removeAll { now.timeIntervalSince($0.at) > 30 }
        guard !pending.isEmpty else { return [] }
        let due = pending.filter { now.timeIntervalSince($0.at) >= window }
        pending.removeAll { now.timeIntervalSince($0.at) >= window }
        return due.map(\.line)
    }

    /// `[sidecar:warn] text` (a stderr line, `.debug`) → ("warn", "text").
    static func sidecarLine(level: LogLevel, message: String) -> (String, String)? {
        guard level == .debug, message.hasPrefix("[sidecar:"), let close = message.firstIndex(of: "]") else { return nil }
        let lineLevel = String(message[message.index(message.startIndex, offsetBy: "[sidecar:".count)..<close])
        var text = message[message.index(after: close)...]
        if text.first == " " { text = text.dropFirst() }
        return (lineLevel, String(text))
    }
}

/// The daily log files: `~/Library/Logs/ReviewGate/engine-YYYY-MM-DD.log` (local date), one line per entry with a timestamp
/// and the window's tag, masked by `LogRedactor`; files older than `retentionDays` are deleted. Writes are serialized on a
/// queue of their own and never throw (logging must not break the app).
public final class EngineLogFile: @unchecked Sendable {
    public static let shared = EngineLogFile(directory: defaultDirectory)

    public static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ReviewGate", isDirectory: true)
    }

    public let directory: URL
    public let retentionDays: Int
    private let home: String
    private let queue = DispatchQueue(label: "io.github.seunggulee1007.reviewgate.enginelog")
    private var prunedDay: String?

    public init(directory: URL, retentionDays: Int = 7, home: String = NSHomeDirectory()) {
        self.directory = directory
        self.retentionDays = retentionDays
        self.home = home
    }

    /// `engine-YYYY-MM-DD.log` of `date` (local calendar day).
    public func file(for date: Date = Date()) -> URL {
        directory.appendingPathComponent("engine-\(Self.day(date)).log")
    }

    public func write(_ line: String, tag: String, at date: Date = Date()) {
        let entry = "\(Self.timestamp(date)) [\(tag)] \(LogRedactor.redact(line, home: home))\n"
        queue.async { [self] in
            let day = Self.day(date)
            if prunedDay != day {
                prunedDay = day
                prune(now: date)
            }
            append(entry, to: file(for: date))
        }
    }

    /// Waits until every pending write landed (tests, diagnostics).
    public func flush() { queue.sync {} }

    /// The last `count` lines of today's file (diagnostics when no window has a log of its own).
    public func tail(_ count: Int, at date: Date = Date()) -> [String] {
        flush()
        guard let text = try? String(contentsOf: file(for: date), encoding: .utf8) else { return [] }
        return Array(text.split(separator: "\n").suffix(count).map(String.init))
    }

    /// Deletes `engine-*.log` files whose day is `retentionDays` or more before `now`'s day.
    public func prune(now: Date = Date()) {
        let calendar = Calendar.current
        guard let oldestKept = calendar.date(byAdding: .day, value: -(retentionDays - 1), to: calendar.startOfDay(for: now)),
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        let cutoff = Self.day(oldestKept)
        for name in names where name.hasPrefix("engine-") && name.hasSuffix(".log") {
            let day = String(name.dropFirst("engine-".count).dropLast(".log".count))
            if day.count == 10, day < cutoff { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        }
    }

    private func append(_ entry: String, to url: URL) {
        let fm = FileManager.default
        do {
            if !fm.fileExists(atPath: url.path) {
                try fm.createDirectory(at: directory, withIntermediateDirectories: true)
                fm.createFile(atPath: url.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(entry.utf8))
        } catch {
            // Logging never breaks the app.
        }
    }

    static func day(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func timestamp(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .current))
    }
}

/// "Copy Diagnostics": what a bug report needs, masked like the log file.
public struct EngineDiagnostics: Sendable {
    public var app: String
    public var engine: String?
    public var claude: String?
    public var node: String?
    public var os: String
    public var logFolder: String
    /// Lines describing the window's state.
    public var state: [String]
    /// `code` / `detail` / exit code of the last error, when there was one.
    public var lastError: [String]
    public var recentLog: [String]

    public init(app: String, engine: String?, claude: String?, node: String?, os: String, logFolder: String, state: [String],
                lastError: [String], recentLog: [String]) {
        self.app = app
        self.engine = engine
        self.claude = claude
        self.node = node
        self.os = os
        self.logFolder = logFolder
        self.state = state
        self.lastError = lastError
        self.recentLog = recentLog
    }

    public func text(home: String = NSHomeDirectory()) -> String {
        var lines = [
            "ReviewGate diagnostics",
            "app: \(app)",
            "engine: \(engine ?? "-")",
            "claude: \(claude ?? "-")",
            "node: \(node ?? "-")",
            "os: \(os)",
            "logs: \(logFolder)",
            "",
            "## state",
        ]
        lines += state
        lines += ["", "## last error"]
        lines += lastError.isEmpty ? ["-"] : lastError
        lines += ["", "## recent log (\(recentLog.count) lines)"]
        lines += recentLog
        return lines.map { LogRedactor.redact($0, home: home) }.joined(separator: "\n") + "\n"
    }
}
