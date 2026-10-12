import Foundation

// MARK: wave3 check-clients
// Settings › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9), as in Electron
// (clients/desktop/src/shared/testCommands.ts): the user's own test commands, one glob per line, added to the runners the
// engine recognizes by itself; in `hello` and live through `set_settings` when the box loses the focus.

public extension AppSettings.Key {
    /// One glob per line (`*` any run, `?` one character), matched against each simple command of a Bash call.
    static let testCommandPatterns = "testCommandPatterns"
}

public extension AppSettings {
    /// What the engine recognizes without a pattern (§34.9 / §12) — Maven and Gradle first; shown under the box.
    static let builtInTestCommands =
        "mvn · mvnw · *mvn*.sh · gradle · gradlew · npm / pnpm / yarn / bun test · vitest · jest · pytest · go test · cargo test · swift test · xcodebuild test · make test / check · node --test · mocha · phpunit · dotnet test · bazel test · ctest"

    /// The stored text → the patterns: trimmed lines, blank lines and `#` comments dropped, each once (order kept).
    static func testCommandPatterns(defaults: UserDefaults = .standard) -> [String] {
        var seen = Set<String>()
        return (defaults.string(forKey: Key.testCommandPatterns) ?? "").split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") && seen.insert($0).inserted }
    }
}

extension AppState {
    /// `set_settings{testCommandPatterns}` with the stored list (the engine reads it for every Bash result).
    public func pushTestCommandPatterns() {
        guard isEngineRunning || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.testCommandPatterns = AppSettings.testCommandPatterns(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }
}
