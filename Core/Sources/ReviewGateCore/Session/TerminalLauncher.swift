import Foundation

/// Opens Terminal.app running a command — `claude /login` for `auth_required` (§19.6). It writes a one-off `.command`
/// script to the temporary folder and hands it to Terminal (`open -a Terminal`), which needs no Apple Events permission.
public enum TerminalLauncher {
    /// `'<claude>' /login`, the executable single-quoted for the shell; a bare `claude` when the path is unknown.
    public static func claudeLoginCommand(claudePath: String?) -> String {
        let exe = claudePath.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? "claude"
        return "\(shellQuoted(exe)) /login"
    }

    /// POSIX single quoting (`'` → `'\''`).
    public static func shellQuoted(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The `.command` script: runs `command` with the login PATH, then keeps the shell open.
    public static func script(for command: String, path: String?) -> String {
        var lines = ["#!/bin/zsh -l"]
        if let path, !path.isEmpty { lines.append("export PATH=\(shellQuoted(path))") }
        lines.append(command)
        lines.append("exec $SHELL -l")
        return lines.joined(separator: "\n") + "\n"
    }

    /// Writes the script and opens it in Terminal.
    public static func open(_ command: String, path: String? = nil) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("reviewgate-\(UUID().uuidString.prefix(8)).command")
        try script(for: command, path: path).write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "Terminal", url.path]
        try process.run()
    }
}
