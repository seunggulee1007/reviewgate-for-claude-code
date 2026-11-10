import Foundation
import Testing
@testable import ReviewGateCore

/// §54: no change budget by default — Settings' change limit is a switch, off until the user turns it on; the default
/// append says nothing about small units, stopping or waiting; a stored copy of an earlier built-in append is the default.
@Suite @MainActor struct ChangeLimitTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "ChangeLimitTests.\(UUID().uuidString)")! }

    @Test func offByDefaultAndTheDefaultAppendNeverAsksClaudeToStop() {
        let d = defaults()
        #expect(AppSettings.budgetEnabled(defaults: d) == false)
        #expect(AppSettings.budget(defaults: d) == .off)
        #expect(Budget.off.isOn == false)
        #expect(AppSettings.budgetLimits(defaults: d) == Budget(maxFiles: 10, maxLines: 400, hardMultiplier: 2.0))
        let prompt = AppSettings.engineSettings(defaults: d).systemPromptAppend ?? ""
        #expect(prompt == AppSettings.defaultSystemPromptAppend)
        for word in ["small units", "STOP", "wait for the user", "REVIEW GATE", "{maxFiles}"] {
            #expect(!prompt.contains(word), "\(word)")
        }
        #expect(prompt.contains("only when the user or a skill they ran asks"))   // the git sentence stays
        #expect(!prompt.contains("approval card"))   // r1-git (§46): no card for every git command any more
    }

    @Test func turnedOnTheNumbersGoOutAndTheDefaultAppendNamesThemWithoutStopping() {
        let d = defaults()
        d.set(true, forKey: AppSettings.Key.budgetEnabled)
        d.set(25, forKey: AppSettings.Key.budgetMaxFiles)
        let s = AppSettings.engineSettings(defaults: d)
        #expect(s.budget == Budget(maxFiles: 25, maxLines: 400, hardMultiplier: 2.0))
        #expect(s.budget?.isOn == true)
        let prompt = s.systemPromptAppend ?? ""
        #expect(prompt.hasPrefix(AppSettings.defaultSystemPromptAppend + " The user set a change limit of 25 files and about 400 changed lines per reply"))
        #expect(!prompt.contains("STOP") && !prompt.contains("wait for the user") && !prompt.contains("small units"))
        // Turned off again: the numbers stay stored for next time, the engine gets no budget.
        d.set(false, forKey: AppSettings.Key.budgetEnabled)
        #expect(AppSettings.budget(defaults: d) == .off)
        #expect(AppSettings.budgetLimits(defaults: d).maxFiles == 25)
    }

    @Test func aStoredEarlierDefaultIsTheNewDefaultAndIsDroppedAtLaunch() {
        for legacy in AppSettings.legacySystemPromptAppends {
            let d = defaults()
            d.set(legacy + "\n", forKey: AppSettings.Key.systemPromptAppend)   // as Settings' TextEditor may have stored it
            #expect(AppSettings.systemPromptAppend(defaults: d) == AppSettings.defaultSystemPromptAppend)
            #expect(AppSettings.engineSettings(defaults: d).systemPromptAppend == AppSettings.defaultSystemPromptAppend)
            AppSettings.forgetLegacySystemPromptAppend(defaults: d)
            #expect(d.object(forKey: AppSettings.Key.systemPromptAppend) == nil)
        }
    }

    @Test func aTextOfTheUsersOwnStaysWithPlaceholdersAndGetsNoLimitSentence() {
        let d = defaults()
        d.set("Keep replies within {maxFiles} files / {maxLines} lines.", forKey: AppSettings.Key.systemPromptAppend)
        AppSettings.forgetLegacySystemPromptAppend(defaults: d)
        #expect(d.string(forKey: AppSettings.Key.systemPromptAppend) != nil)
        #expect(AppSettings.engineSettings(defaults: d).systemPromptAppend == "Keep replies within 10 files / 400 lines.")
        d.set(true, forKey: AppSettings.Key.budgetEnabled)
        #expect(AppSettings.engineSettings(defaults: d).systemPromptAppend == "Keep replies within 10 files / 400 lines.")
    }

    @Test func theStoreStartsWithTheSettingsBudget() {
        let d = defaults()
        #expect(AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d).budget == .off)
        d.set(true, forKey: AppSettings.Key.budgetEnabled)
        #expect(AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d).budget == Budget(maxFiles: 10, maxLines: 400, hardMultiplier: 2.0))
    }
}
