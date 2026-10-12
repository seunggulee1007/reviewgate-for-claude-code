import Foundation

/// What the Mac client knows about the local toolchain: `node` (needed to launch the engine) is located
/// here; `claude`/`gh`/`git` are located by the engine and mirrored from `state.toolchain`.
public struct Toolchain: Sendable, Equatable {
    public var nodePath: String?
    /// `claude` as located by the engine (`state.toolchain.claude`); nil until a project was opened.
    public var claudePath: String?
    /// PATH as seen by the user's login shell (falls back to the process PATH).
    public var loginPATH: String
    /// `claude --version` as reported by the engine (`state.toolchain.claudeVersion`).
    public var claudeVersion: String?

    public init(nodePath: String?, claudePath: String? = nil, loginPATH: String, claudeVersion: String? = nil) {
        self.nodePath = nodePath
        self.claudePath = claudePath
        self.loginPATH = loginPATH
        self.claudeVersion = claudeVersion
    }

    public func nodeVersion() async -> String? {
        guard let nodePath else { return nil }
        return await ToolchainLocator.version(of: nodePath, path: loginPATH)
    }
}

/// Finds `node` and the login-shell PATH the engine process inherits.
public enum ToolchainLocator {
    public static func locate(nodeOverride: String? = nil) async -> Toolchain {
        let processPATH = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var node: String? = nil
        var loginPATH = processPATH

        if let shell = await loginShellProbe() {
            node = shell.node
            if let p = shell.path, !p.isEmpty { loginPATH = p }
        }

        if let o = nodeOverride, !o.isEmpty { node = o }

        if node == nil || !isExecutable(node!) {
            node = nodeFallbacks().first(where: isExecutable)
        }
        return Toolchain(nodePath: node, loginPATH: loginPATH)
    }

    // MARK: - Login shell probe

    static func loginShellProbe() async -> (node: String?, path: String?)? {
        let script = "command -v node; printf \"%s\\n\" \"$PATH\""
        guard let out = try? await CommandRunner.run(
            "/bin/zsh", ["-lic", script],
            env: ["HOME": NSHomeDirectory(), "USER": NSUserName(), "TERM": "dumb",
                  "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"],
            timeout: .seconds(5)
        ) else { return nil }
        return parseProbeOutput(out.stdoutText)
    }

    /// Parses the probe output. Interactive shells may print noise, so the parser looks for the
    /// last absolute path ending in `/node` and takes the last non-empty line as PATH.
    static func parseProbeOutput(_ text: String) -> (node: String?, path: String?) {
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !lines.isEmpty else { return (nil, nil) }
        let path = lines.last
        var node: String? = nil
        for line in lines.dropLast() {
            let candidate = extractPath(from: line)
            guard let candidate, candidate.hasPrefix("/") else { continue }
            if (candidate as NSString).lastPathComponent == "node" { node = candidate }
        }
        return (node, path)
    }

    private static func extractPath(from line: String) -> String? {
        // `command -v` prints either a bare path or `name: aliased to /path ...`
        if let r = line.range(of: "aliased to ") {
            return String(line[r.upperBound...]).split(separator: " ").first.map(String.init)
        }
        return line
    }

    // MARK: - Fallbacks

    static func nodeFallbacks() -> [String] {
        var list: [String] = []
        let nvmDir = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            let sorted = versions.filter { $0.hasPrefix("v") }.sorted { a, b in
                compareVersions(a, b) == .orderedDescending
            }
            list += sorted.map { nvmDir + "/" + $0 + "/bin/node" }
        }
        list += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return list
    }

    static func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.dropFirst().split(separator: ".").compactMap { Int($0) }
        let pb = b.dropFirst().split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    static func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    static func version(of exe: String, path: String) async -> String? {
        guard let out = try? await CommandRunner.run(
            exe, ["--version"],
            env: ["PATH": path, "HOME": NSHomeDirectory()],
            timeout: .seconds(10)
        ), out.status == 0 else { return nil }
        return out.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
