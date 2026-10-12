import Foundation
import Testing
@testable import ReviewGateCore

@Suite struct ToolchainLocatorTests {
    @Test func parsesProbeOutputWithNoise() {
        let out = """
        Welcome to zsh!
        /Users/x/.nvm/versions/node/v24.12.0/bin/node
        /Users/x/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/bin
        """
        let r = ToolchainLocator.parseProbeOutput(out)
        #expect(r.node == "/Users/x/.nvm/versions/node/v24.12.0/bin/node")
        #expect(r.path == "/Users/x/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/bin")
    }

    @Test func parsesAliasedProbeOutput() {
        let r = ToolchainLocator.parseProbeOutput("node: aliased to /opt/homebrew/bin/node --foo\n/opt/homebrew/bin:/usr/bin\n")
        #expect(r.node == "/opt/homebrew/bin/node")
        #expect(r.path == "/opt/homebrew/bin:/usr/bin")
    }

    @Test func parsesProbeOutputWhenNodeMissing() {
        let r = ToolchainLocator.parseProbeOutput("/opt/homebrew/bin:/usr/bin\n")
        #expect(r.node == nil)
        #expect(r.path == "/opt/homebrew/bin:/usr/bin")
    }

    @Test func versionOrdering() {
        #expect(ToolchainLocator.compareVersions("v24.12.0", "v22.17.0") == .orderedDescending)
        #expect(ToolchainLocator.compareVersions("v9.0.0", "v10.0.0") == .orderedAscending)
    }
}

@Suite struct CommandRunnerTests {
    @Test func drainsBothPipes() async throws {
        let big = String(repeating: "x", count: 200_000)
        let out = try await CommandRunner.run("/bin/sh", ["-c", "printf out; printf '%s' \"$BIG\" >&2; exit 3"],
                                              env: ["BIG": big])
        #expect(out.stdoutText == "out")
        #expect(out.stderr.count == 200_000)
        #expect(out.status == 3)
    }

    @Test func timeoutTerminates() async throws {
        let start = ContinuousClock.now
        let out = try await CommandRunner.run("/bin/sleep", ["30"], timeout: .milliseconds(300))
        #expect(out.status != 0)
        #expect(ContinuousClock.now - start < .seconds(5))
    }
}

@Suite struct AppSettingsTests {
    @Test func loadUserSettingsDefaultsToTrue() {
        let d = UserDefaults(suiteName: "AppSettingsTests.loadUserSettings")!
        d.removePersistentDomain(forName: "AppSettingsTests.loadUserSettings")
        #expect(AppSettings.loadUserSettings(defaults: d) == true)
        d.set(false, forKey: AppSettings.Key.loadUserSettings)
        #expect(AppSettings.loadUserSettings(defaults: d) == false)
        d.removePersistentDomain(forName: "AppSettingsTests.loadUserSettings")
    }

    @Test func rendersPromptPlaceholders() {
        let s = AppSettings.renderSystemPrompt(AppSettings.defaultSystemPromptAppend, budget: Budget(maxFiles: 3, maxLines: 150))
        #expect(s.contains("at most 3 files and about 150 changed lines"))
    }

    @Test func ignorePatternsSkipBlankAndCommentLines() {
        let d = UserDefaults(suiteName: "AppSettingsTests.ignore.\(UUID().uuidString)")!
        d.set(" .omc/ \n\n# comment\n*.log\n", forKey: AppSettings.Key.checkpointIgnorePatterns)
        #expect(AppSettings.ignorePatterns(defaults: d) == [".omc/", "*.log"])
    }
}
