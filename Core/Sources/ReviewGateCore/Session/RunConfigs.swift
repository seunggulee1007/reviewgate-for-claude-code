import Foundation

// MARK: c-panel (§57.18)
// docs/PROTOCOL.md §57.18: the bottom panel's 실행 tab — named commands per project, each run in its own PTY tab. The
// project's build files offer candidates (never run by themselves); a detected command asks once before its first run.

/// One named command of a project: `command` runs in the project root through the user's login shell.
public struct RunConfig: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var command: String
    /// Offered by the project's files (package.json, a Gradle / Maven wrapper) rather than typed by the user.
    public var detected: Bool
    /// The user answered "실행" to "이 명령을 실행할까요?" — a detected command asks only once.
    public var confirmed: Bool

    public init(id: String, name: String, command: String, detected: Bool = false, confirmed: Bool = false) {
        self.id = id
        self.name = name
        self.command = command
        self.detected = detected
        self.confirmed = confirmed
    }

    /// A command the user typed is theirs; one the files offered asks before it first runs.
    public var needsConfirmation: Bool { detected && !confirmed }
}

/// A project's run tab: the commands it keeps (in order) and the detected ones the user removed (by command).
public struct ProjectRuns: Codable, Sendable, Equatable {
    public var configs: [RunConfig]
    public var dismissed: [String]

    public init(configs: [RunConfig] = [], dismissed: [String] = []) {
        self.configs = configs
        self.dismissed = dismissed
    }

    /// What the tab lists: the kept commands, then each detected one neither kept (same command) nor removed.
    public func listed(detected: [RunConfig]) -> [RunConfig] {
        let kept = Set(configs.map(\.command))
        let gone = Set(dismissed)
        return configs + detected.filter { !kept.contains($0.command) && !gone.contains($0.command) }
    }

    /// Keeps `config` (replacing the one with its id, else appended); its command is no longer dismissed.
    public mutating func keep(_ config: RunConfig) {
        if let i = configs.firstIndex(where: { $0.id == config.id }) { configs[i] = config } else { configs.append(config) }
        dismissed.removeAll { $0 == config.command }
    }

    /// Removes `config`: a kept one goes; a detected one stays away until "다시 찾기" is asked for (`restoreDetected`).
    public mutating func remove(_ config: RunConfig) {
        configs.removeAll { $0.id == config.id }
        if config.detected, !dismissed.contains(config.command) { dismissed.append(config.command) }
    }

    /// "다시 찾기": the detected commands removed before are offered again.
    public mutating func restoreDetected() { dismissed = [] }
}

/// The candidates a project's files offer — read only, nothing runs.
public enum RunCandidates {
    /// The scripts of package.json offered, in this order.
    static let npmScripts = ["dev", "start", "serve", "test", "build"]

    /// `exists` / `read` take a path relative to the project root.
    public static func detect(exists: (String) -> Bool, read: (String) -> String?) -> [RunConfig] {
        gradle(exists: exists, read: read) + maven(exists: exists, read: read) + npm(exists: exists, read: read)
    }

    /// The candidates of the folder on disk (files over 1 MB are not read).
    public static func detect(folder: URL) -> [RunConfig] {
        let fm = FileManager.default
        func path(_ relative: String) -> String { folder.appendingPathComponent(relative).path }
        return detect(exists: { fm.fileExists(atPath: path($0)) }, read: { relative in
            let p = path(relative)
            guard let size = (try? fm.attributesOfItem(atPath: p))?[.size] as? NSNumber, size.intValue <= 1_000_000 else { return nil }
            return try? String(contentsOfFile: p, encoding: .utf8)
        })
    }

    /// `./gradlew` with a build file: bootRun (Spring Boot's plugin), run (the application plugin), test.
    static func gradle(exists: (String) -> Bool, read: (String) -> String?) -> [RunConfig] {
        guard exists("gradlew") else { return [] }
        let files = ["build.gradle", "build.gradle.kts"].filter(exists)
        guard !files.isEmpty || exists("settings.gradle") || exists("settings.gradle.kts") else { return [] }
        let text = files.compactMap(read).joined(separator: "\n")
        var tasks: [String] = []
        if text.contains("org.springframework.boot") { tasks.append("bootRun") }
        if appliesApplicationPlugin(text) { tasks.append("run") }
        tasks.append("test")
        return tasks.map { RunConfig(id: "gradle:\($0)", name: "Gradle: \($0)", command: "./gradlew \($0)", detected: true) }
    }

    /// `id 'application'`, `id("application")`, `` `application` ``, `apply plugin: 'application'`, or an `application {` block.
    static func appliesApplicationPlugin(_ text: String) -> Bool {
        let pattern = #"(?m)(id\s*\(?\s*["']application["']|`application`|apply\s+plugin\s*:\s*["']application["']|^\s*application\s*\{)"#
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    /// `./mvnw` with a pom.xml: spring-boot:run (Spring Boot's plugin or parent), test.
    static func maven(exists: (String) -> Bool, read: (String) -> String?) -> [RunConfig] {
        guard exists("mvnw"), exists("pom.xml") else { return [] }
        let pom = read("pom.xml") ?? ""
        var goals: [String] = []
        if pom.contains("spring-boot-maven-plugin") || pom.contains("spring-boot-starter-parent") { goals.append("spring-boot:run") }
        goals.append("test")
        return goals.map { RunConfig(id: "maven:\($0)", name: "Maven: \($0)", command: "./mvnw \($0)", detected: true) }
    }

    /// package.json's dev / start / serve / test / build scripts, with the project's package manager.
    static func npm(exists: (String) -> Bool, read: (String) -> String?) -> [RunConfig] {
        guard let text = read("package.json"), let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scripts = json["scripts"] as? [String: Any] else { return [] }
        let manager = packageManager(declared: json["packageManager"] as? String, exists: exists)
        return npmScripts.filter { scripts[$0] is String }.map { script in
            RunConfig(id: "npm:\(script)", name: "\(manager): \(script)", command: scriptCommand(manager, script), detected: true)
        }
    }

    /// `packageManager` ("pnpm@9…") first, then the lockfile; npm when there is neither.
    static func packageManager(declared: String?, exists: (String) -> Bool) -> String {
        if let name = declared?.split(separator: "@").first.map(String.init), ["npm", "pnpm", "yarn", "bun"].contains(name) { return name }
        if exists("pnpm-lock.yaml") { return "pnpm" }
        if exists("yarn.lock") { return "yarn" }
        if exists("bun.lockb") || exists("bun.lock") { return "bun" }
        return "npm"
    }

    /// `npm test` / `npm start` / `npm run dev`; yarn runs a script by name; bun's `test` is its own runner, so `bun run`.
    static func scriptCommand(_ manager: String, _ script: String) -> String {
        switch manager {
        case "yarn": return "yarn \(script)"
        case "bun": return "bun run \(script)"
        default: return script == "test" || script == "start" ? "\(manager) \(script)" : "\(manager) run \(script)"
        }
    }
}

// MARK: - Per project (the app's UserDefaults)

public extension AppSettings.Key {
    /// c-panel (§57.18): JSON `[projectKey: ProjectRuns]` — the run tab's commands per repository (else folder).
    static let projectRuns = "projectRuns"
}

public extension AppSettings {
    static func projectRuns(root: String, defaults: UserDefaults = .standard) -> ProjectRuns {
        allProjectRuns(defaults: defaults)[root] ?? ProjectRuns()
    }

    static func setProjectRuns(_ runs: ProjectRuns, root: String, defaults: UserDefaults = .standard) {
        var all = allProjectRuns(defaults: defaults)
        all[root] = runs.configs.isEmpty && runs.dismissed.isEmpty ? nil : runs
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.projectRuns) }
    }

    private static func allProjectRuns(defaults: UserDefaults) -> [String: ProjectRuns] {
        guard let data = defaults.data(forKey: Key.projectRuns) else { return [:] }
        return (try? JSONDecoder().decode([String: ProjectRuns].self, from: data)) ?? [:]
    }
}

public extension AppState {
    /// The key the run tab keeps its commands under: the repository (every worktree and workbench of it), else the folder.
    private var projectRunsKey: String? {
        guard let url = projectURL else { return nil }
        return allowPatternsRepositoryKey ?? AppSettings.projectKey(url)
    }

    /// This project's run tab as kept.
    var projectRuns: ProjectRuns {
        guard let key = projectRunsKey else { return ProjectRuns() }
        return AppSettings.projectRuns(root: key, defaults: settingsDefaults)
    }

    func saveProjectRuns(_ runs: ProjectRuns) {
        guard let key = projectRunsKey else { return }
        AppSettings.setProjectRuns(runs, root: key, defaults: settingsDefaults)
    }
}
