import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 check-clients — Settings › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9) on the Mac,
/// as in Electron: one glob per line, in `hello` and live through `set_settings` when the box loses the focus.
@Suite @MainActor struct TestCommandSettingsTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "TestCommandSettingsTests.\(UUID().uuidString)")! }

    @Test func onePatternPerLineTrimmedWithoutBlanksCommentsOrRepeats() {
        let d = defaults()
        #expect(AppSettings.testCommandPatterns(defaults: d) == [])
        d.set("./run-tests.sh*\n\n  # ours\n *integrationTest* \r\n./run-tests.sh*", forKey: AppSettings.Key.testCommandPatterns)
        #expect(AppSettings.testCommandPatterns(defaults: d) == ["./run-tests.sh*", "*integrationTest*"])
    }

    @Test func helloCarriesThemAndAnEmptyBoxClearsThem() {
        let d = defaults()
        #expect(AppSettings.engineSettings(defaults: d).testCommandPatterns == [])
        d.set("./mvn25.sh*test*", forKey: AppSettings.Key.testCommandPatterns)
        #expect(AppSettings.engineSettings(defaults: d).testCommandPatterns == ["./mvn25.sh*test*"])
    }

    @Test func leavingTheBoxSendsOnlyThePatterns() throws {
        let d = defaults()
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        d.set("gradle*itest*", forKey: AppSettings.Key.testCommandPatterns)
        app.pushTestCommandPatterns()
        var expected = EngineSettings()
        expected.testCommandPatterns = ["gradle*itest*"]
        #expect(sent == [.setSettings(expected)])
        let wire = try #require(try JSONSerialization.jsonObject(with: NDJSON.encodeLine(EngineCommandEnvelope(command: sent[0]))) as? [String: Any])
        #expect((wire["settings"] as? [String: Any])?["testCommandPatterns"] as? [String] == ["gradle*itest*"])
        #expect((wire["settings"] as? [String: Any]).map { Set($0.keys) } == ["testCommandPatterns"])
    }

    @Test func theBuiltInListNamesMavenAndGradleFirst() {
        #expect(AppSettings.builtInTestCommands.hasPrefix("mvn"))
        for command in ["*mvn*.sh", "gradlew", "vitest", "pytest", "make test", "node --test", "dotnet test"] {
            #expect(AppSettings.builtInTestCommands.contains(command))
        }
    }
}
