import Foundation

// MARK: terminal-chat (§57)
// docs/PROTOCOL.md §57.2: how the app starts a PTY — the terminal chat's `claude` (a login shell that `exec`s the engine's
// `terminal_spec` argv) and the bottom panel's shell. Pure: the App's TerminalHost hands it to SwiftTerm's `startProcess`.

/// One PTY child: what SwiftTerm's `LocalProcess.startProcess` takes.
public struct TerminalLaunch: Sendable, Equatable {
    public let executable: String
    public let args: [String]
    /// `KEY=value`, sorted. Built from scratch: nothing else of the app's environment reaches the child.
    public let env: [String]
    /// argv[0] the child sees (`-zsh` makes a login shell); nil → the executable.
    public let execName: String?
    public let cwd: String

    public init(executable: String, args: [String], env: [String], execName: String?, cwd: String) {
        self.executable = executable
        self.args = args
        self.env = env
        self.execName = execName
        self.cwd = cwd
    }

    /// The debug-tour override: the shell to use instead of a login shell (no `-l` / `-i`, so no dotfiles run).
    public static let debugShellKey = "REVIEWGATE_TERMINAL_SHELL"

    /// The parent's keys a child keeps; every other one (any `CLAUDE*` among them) is dropped.
    static let inheritedKeys = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PATH"]

    /// The terminal chat: `<shell> -l -i -c 'exec <argv…>'`, so the user's login PATH finds node and the CLI's own needs.
    public static func claude(spec: TerminalSpec, parentEnv: [String: String], loginShell: String, appVersion: String,
                              debugShell: String? = nil) -> TerminalLaunch {
        let line = "exec " + spec.argv.map(posixQuote).joined(separator: " ")
        var env = baseEnv(parentEnv: parentEnv, appVersion: appVersion)
        // The IME overlay and the candidate window anchor to the terminal cursor; Claude Code keeps a native cursor at its
        // input caret only with this.
        env["CLAUDE_CODE_NATIVE_CURSOR"] = "1"
        for (key, value) in spec.env where key.hasPrefix("RG_") || key.hasPrefix("CLAUDE_CODE_") { env[key] = value }
        if let debugShell {
            return TerminalLaunch(executable: debugShell, args: ["-c", line], env: flatten(env), execName: nil, cwd: spec.cwd)
        }
        return TerminalLaunch(executable: loginShell, args: ["-l", "-i", "-c", line], env: flatten(env),
                              execName: "-" + (loginShell as NSString).lastPathComponent, cwd: spec.cwd)
    }

    /// The bottom panel's shell: the user's login shell in `cwd`, without any hook token.
    public static func shell(cwd: String, parentEnv: [String: String], loginShell: String, appVersion: String,
                             debugShell: String? = nil) -> TerminalLaunch {
        let env = flatten(baseEnv(parentEnv: parentEnv, appVersion: appVersion))
        if let debugShell {
            return TerminalLaunch(executable: debugShell, args: [], env: env, execName: nil, cwd: cwd)
        }
        return TerminalLaunch(executable: loginShell, args: ["-l"], env: env,
                              execName: "-" + (loginShell as NSString).lastPathComponent, cwd: cwd)
    }

    /// `s` as one POSIX shell word: bare when it is only safe characters, else in single quotes (`$`, `${…}`, spaces and
    /// quotes stay literal; a `'` becomes `'\''`).
    public static func posixQuote(_ s: String) -> String {
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")
        if !s.isEmpty, s.unicodeScalars.allSatisfy(safe.contains) { return s }
        return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The user's login shell (the account's, not `$SHELL` of whatever launched the app), else `/bin/zsh`.
    public static func userLoginShell() -> String {
        if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell {
            let shell = String(cString: sh)
            if !shell.isEmpty { return shell }
        }
        return "/bin/zsh"
    }

    /// `REVIEWGATE_TERMINAL_SHELL`, honoured only by the screenshot build (its bundle id ends in `.screenshots`).
    public static func debugShell(environment: [String: String], bundleIdentifier: String?) -> String? {
        guard bundleIdentifier?.hasSuffix(".screenshots") == true,
              let shell = environment[debugShellKey], !shell.isEmpty else { return nil }
        return shell
    }

    private static func baseEnv(parentEnv: [String: String], appVersion: String) -> [String: String] {
        var env: [String: String] = [:]
        for key in inheritedKeys { if let v = parentEnv[key] { env[key] = v } }
        if env["PATH"] == nil { env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        // Honest identity: Claude Code enables Shift+Enter by probing the kitty keyboard protocol, not by TERM_PROGRAM.
        env["TERM_PROGRAM"] = "ReviewGate"
        env["TERM_PROGRAM_VERSION"] = appVersion
        env["LANG"] = "en_US.UTF-8"
        env["LC_CTYPE"] = "en_US.UTF-8"
        return env
    }

    private static func flatten(_ env: [String: String]) -> [String] {
        env.map { "\($0.key)=\($0.value)" }.sorted()
    }
}
