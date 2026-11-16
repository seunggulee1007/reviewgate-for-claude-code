import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.2: the PTY's shell, argv and environment for a terminal chat and the bottom shell panel.
@Suite struct TerminalLaunchTests {
    private let parent = [
        "HOME": "/Users/dev", "USER": "dev", "LOGNAME": "dev", "SHELL": "/bin/zsh", "TMPDIR": "/tmp/dev",
        "PATH": "/opt/acme/bin:/usr/bin:/bin",
        "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CONFIG_DIR": "/Users/dev/.acme", "EDITOR": "vim",
        "TERM": "dumb",
    ]

    private func spec(argv: [String] = ["/usr/local/bin/claude", "--session-id", "s1", "--settings", #"{"hooks":{"H":"${RG_HOOK_TOKEN}"}}"#],
                      env: [String: String] = ["RG_HOOK_TOKEN": "abc123", "CLAUDE_CODE_X": "1", "PATH": "/evil", "NODE_OPTIONS": "x"]) -> TerminalSpec {
        TerminalSpec(sessionId: "s1", argv: argv, env: env, cwd: "/work/acme", resume: false)
    }

    private func env(_ launch: TerminalLaunch) -> [String: String] {
        Dictionary(uniqueKeysWithValues: launch.env.map { line in
            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            return (String(parts[0]), String(parts[1]))
        })
    }

    /// What `/bin/sh` makes of `exec`-less words: each quoted word comes back as itself.
    private func shellWords(_ words: [String]) throws -> [String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "for a in " + words.map(TerminalLaunch.posixQuote).joined(separator: " ") + #"; do printf '%s\0' "$a"; done"#]
        p.environment = ["RG_HOOK_TOKEN": "SECRET", "HOME": "/nonexistent", "PATH": "/usr/bin:/bin"]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: "\0", omittingEmptySubsequences: false).dropLast().map(String.init)
    }

    @Test func quoting() throws {
        #expect(TerminalLaunch.posixQuote("/usr/local/bin/claude") == "/usr/local/bin/claude")
        #expect(TerminalLaunch.posixQuote("--session-id") == "--session-id")
        #expect(TerminalLaunch.posixQuote("") == "''")
        #expect(TerminalLaunch.posixQuote("a b") == "'a b'")
        #expect(TerminalLaunch.posixQuote("it's") == #"'it'\''s'"#)
        #expect(TerminalLaunch.posixQuote("${RG_HOOK_TOKEN}") == "'${RG_HOOK_TOKEN}'")
        let words = ["plain", "a b", "it's", "$HOME", "${RG_HOOK_TOKEN}", "`id`", "한글 폴더", "\"q\"", "back\\slash", "", "*", "a\nb"]
        #expect(try shellWords(words) == words)
    }

    @Test func theClaudeLaunch() {
        let launch = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "0.5.15")
        #expect(launch.executable == "/bin/zsh")
        #expect(launch.execName == "-zsh")
        #expect(launch.cwd == "/work/acme")
        #expect(launch.args.count == 4)
        #expect(Array(launch.args.prefix(3)) == ["-l", "-i", "-c"])
        #expect(launch.args[3] == #"exec /usr/local/bin/claude --session-id s1 --settings '{"hooks":{"H":"${RG_HOOK_TOKEN}"}}'"#)
        // The token is only in the env, never on the command line.
        #expect(!launch.args.joined().contains("abc123"))
        #expect(TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/usr/local/bin/fish", appVersion: "1").execName == "-fish")
    }

    @Test func theEnvironmentIsLayered() {
        let e = env(TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "0.5.15"))
        #expect(e["HOME"] == "/Users/dev")
        #expect(e["PATH"] == "/opt/acme/bin:/usr/bin:/bin")   // the spec's PATH is not one of its keys
        #expect(e["TMPDIR"] == "/tmp/dev")
        #expect(e["TERM"] == "xterm-256color")
        #expect(e["COLORTERM"] == "truecolor")
        #expect(e["TERM_PROGRAM"] == "ReviewGate")
        #expect(e["TERM_PROGRAM_VERSION"] == "0.5.15")
        #expect(e["LANG"] == "en_US.UTF-8")
        #expect(e["LC_CTYPE"] == "en_US.UTF-8")
        #expect(e["CLAUDE_CODE_NATIVE_CURSOR"] == "1")
        #expect(e["RG_HOOK_TOKEN"] == "abc123")
        #expect(e["CLAUDE_CODE_X"] == "1")
        #expect(e["CLAUDECODE"] == nil)
        #expect(e["CLAUDE_CODE_ENTRYPOINT"] == nil)
        #expect(e["CLAUDE_CONFIG_DIR"] == nil)
        #expect(e["EDITOR"] == nil)
        #expect(e["NODE_OPTIONS"] == nil)
        let sorted = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "1").env
        #expect(sorted == sorted.sorted())
        // The spec's CLAUDE_CODE_ keys win over the app's own.
        let off = env(TerminalLaunch.claude(spec: spec(env: ["CLAUDE_CODE_NATIVE_CURSOR": "0"]), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "1"))
        #expect(off["CLAUDE_CODE_NATIVE_CURSOR"] == "0")
        let bare = env(TerminalLaunch.claude(spec: spec(), parentEnv: [:], loginShell: "/bin/zsh", appVersion: "1"))
        #expect(bare["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin")
    }

    @Test func theShellPanelHasNoHookToken() {
        let launch = TerminalLaunch.shell(cwd: "/work/acme", parentEnv: parent.merging(["RG_HOOK_TOKEN": "leak"]) { $1 },
                                          loginShell: "/bin/bash", appVersion: "0.5.15")
        #expect(launch.executable == "/bin/bash")
        #expect(launch.args == ["-l"])
        #expect(launch.execName == "-bash")
        #expect(launch.cwd == "/work/acme")
        let e = env(launch)
        #expect(e.keys.allSatisfy { !$0.hasPrefix("RG_") && !$0.hasPrefix("CLAUDE") })
        #expect(e["TERM_PROGRAM"] == "ReviewGate")
        #expect(e["HOME"] == "/Users/dev")
    }

    @Test func theDebugShellRunsNoDotfiles() {
        let claude = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "1", debugShell: "/bin/sh")
        #expect(claude.executable == "/bin/sh")
        #expect(claude.args.count == 2)
        #expect(claude.args[0] == "-c")
        #expect(claude.args[1].hasPrefix("exec /usr/local/bin/claude "))
        #expect(claude.execName == nil)
        let shell = TerminalLaunch.shell(cwd: "/work/acme", parentEnv: parent, loginShell: "/bin/zsh", appVersion: "1", debugShell: "/bin/sh")
        #expect(shell.executable == "/bin/sh")
        #expect(shell.args.isEmpty)
        #expect(shell.execName == nil)

        let env = ["REVIEWGATE_TERMINAL_SHELL": "/bin/sh"]
        #expect(TerminalLaunch.debugShell(environment: env, bundleIdentifier: "io.example.reviewgate.screenshots") == "/bin/sh")
        #expect(TerminalLaunch.debugShell(environment: env, bundleIdentifier: "io.example.reviewgate") == nil)
        #expect(TerminalLaunch.debugShell(environment: env, bundleIdentifier: nil) == nil)
        #expect(TerminalLaunch.debugShell(environment: [:], bundleIdentifier: "io.example.reviewgate.screenshots") == nil)
        #expect(TerminalLaunch.debugShell(environment: ["REVIEWGATE_TERMINAL_SHELL": ""], bundleIdentifier: "x.screenshots") == nil)
    }

    @Test func theLoginShellIsAnAbsolutePath() {
        #expect(TerminalLaunch.userLoginShell().hasPrefix("/"))
    }
}
