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
        #expect(launch.args[3] == "exec /bin/sh -c " + TerminalLaunch.posixQuote(TerminalLaunch.noProxyWrapper)
            + #" rg-claude /usr/local/bin/claude --session-id s1 --settings '{"hooks":{"H":"${RG_HOOK_TOKEN}"}}'"#)
        // The token is only in the env, never on the command line.
        #expect(!launch.args.joined().contains("abc123"))
        #expect(TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/usr/local/bin/fish", appVersion: "1").execName == "-fish")
    }

    /// Runs `line` the way `shell` would after the user's rc (no rc here), with the rc's `NO_PROXY` already exported.
    private func run(_ shell: [String], _ line: String, noProxy: String?) throws -> [String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell[0])
        p.arguments = Array(shell.dropFirst()) + ["-c", line]
        var env = ["RG_HOOK_TOKEN": "SECRET", "HOME": "/nonexistent", "PATH": "/usr/bin:/bin"]
        if let noProxy { env["NO_PROXY"] = noProxy; env["no_proxy"] = noProxy }
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: "\0", omittingEmptySubsequences: false).dropLast().map(String.init)
    }

    /// §57.16: after the rc, `NO_PROXY` / `no_proxy` gain 127.0.0.1 (appended to the rc's value) and claude gets its argv
    /// word for word — through POSIX shells and csh/tcsh.
    @Test func theNoProxyWrapperKeepsTheArgv() throws {
        let words = ["a b", "it's", "$HOME", "${RG_HOOK_TOKEN}", "`id`", "한글 폴더", "\"q\"", #"back\slash"#, #"{"a":"x\"y\\n"}"#,
                     "", "*", "line one\n\nline two"]
        let probe = ["/bin/sh", "-c", #"printf '%s\0' "$NO_PROXY" "$no_proxy" "$@""#, "probe"] + words
        let local = "127.0.0.1,localhost,::1"
        for (login, runner) in [("/bin/zsh", ["/bin/zsh", "-f"]), ("/bin/bash", ["/bin/bash", "--norc", "--noprofile"]),
                                ("/bin/tcsh", ["/bin/tcsh", "-f"]), ("/bin/csh", ["/bin/csh", "-f"])] {
            let launch = TerminalLaunch.claude(spec: spec(argv: probe), parentEnv: parent, loginShell: login, appVersion: "1")
            #expect(launch.executable == login)
            let line = try #require(launch.args.last)
            #expect(try run(runner, line, noProxy: "example.com") == ["example.com,\(local)", "example.com,\(local)"] + words,
                    "\(login)")
            #expect(try run(runner, line, noProxy: nil) == [local, local] + words, "\(login)")
        }
        // The debug shell (the quiet tour) gets the same wrapper.
        let debug = TerminalLaunch.claude(spec: spec(argv: probe), parentEnv: parent, loginShell: "/bin/zsh", appVersion: "1",
                                          debugShell: "/bin/sh")
        #expect(try run(["/bin/sh"], debug.args[1], noProxy: nil) == [local, local] + words)
    }

    @Test func shellFamilies() {
        #expect(TerminalLaunch.shellFamily("/bin/zsh") == .posix)
        #expect(TerminalLaunch.shellFamily("/bin/bash") == .posix)
        #expect(TerminalLaunch.shellFamily("/opt/acme/bin/fish") == .fish)
        #expect(TerminalLaunch.shellFamily("/bin/tcsh") == .csh)
        #expect(TerminalLaunch.shellFamily("/opt/acme/bin/nu") == .other)
        // The wrapper word reads the same in every family: no backslash, `!`, `'` or newline.
        #expect(!TerminalLaunch.noProxyWrapper.contains { "\\!'\n".contains($0) })

        let fish = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/opt/acme/bin/fish", appVersion: "1")
        #expect(fish.executable == "/opt/acme/bin/fish")
        #expect(Array(fish.args.prefix(3)) == ["-l", "-i", "-c"])
        #expect(TerminalLaunch.fishQuote(#"a\b'c"#) == #"'a\\b\'c'"#)
        #expect(TerminalLaunch.fishQuote("plain") == "plain")

        // csh takes -l only alone; argv[0]'s dash makes the login shell.
        let csh = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/bin/tcsh", appVersion: "1")
        #expect(csh.executable == "/bin/tcsh")
        #expect(csh.execName == "-tcsh")
        #expect(Array(csh.args.prefix(2)) == ["-i", "-c"])

        // nu and friends cannot read POSIX quoting: zsh runs the line.
        let nu = TerminalLaunch.claude(spec: spec(), parentEnv: parent, loginShell: "/opt/acme/bin/nu", appVersion: "1")
        #expect(nu.executable == "/bin/zsh")
        #expect(nu.execName == "-zsh")
        #expect(Array(nu.args.prefix(3)) == ["-l", "-i", "-c"])

        // csh history expands `!` even inside quotes: such an argv falls back to zsh.
        let bang = TerminalLaunch.claude(spec: spec(argv: ["/usr/local/bin/claude", "hi!"]), parentEnv: parent,
                                         loginShell: "/bin/tcsh", appVersion: "1")
        #expect(bang.executable == "/bin/zsh")
    }

    /// The engine's real argv (§57.3) never holds a `!`, so csh users keep their own login shell.
    @Test func noBangInTheEngineArgv() throws {
        let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../engine/src/session/terminalSpec.ts")
        guard let text = try? String(contentsOf: src, encoding: .utf8) else { return }
        let start = try #require(text.range(of: "export const TERMINAL_GIT_INSTRUCTION"))
        let end = try #require(text.range(of: "export const TERMINAL_WRITE_TOOLS_MATCHER"))
        #expect(!text[start.upperBound..<end.lowerBound].contains("!"))
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
        #expect(claude.args[1].hasPrefix("exec /bin/sh -c "))
        #expect(claude.args[1].contains(" rg-claude /usr/local/bin/claude "))
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
