import Foundation
import Testing
@testable import ReviewGateCore

// MARK: notification-sounds (§39.7)

/// A sound per kind of notification: which event sounds as which category, the distinct defaults, "None" / "Default",
/// the switches above them, and one sound per category every 2 s.
@Suite struct NotificationSoundsTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "NotificationSoundsTests.\(UUID().uuidString)")! }

    private func event(_ kind: AttentionEvent.Kind) -> AttentionEvent {
        AttentionEvent(kind: kind, title: "t", body: "b", key: "k")
    }

    @Test func everyEventSoundsAsOneCategory() {
        #expect(NotificationSoundCategory(event: event(.permission)) == .permission)
        #expect(NotificationSoundCategory(event: event(.plan)) == .permission)
        #expect(NotificationSoundCategory(event: event(.question)) == .question)
        #expect(NotificationSoundCategory(event: event(.peerMessage)) == .question)
        #expect(NotificationSoundCategory(event: event(.turnFinished)) == .turnFinished)
        #expect(NotificationSoundCategory(event: event(.sideAnswer)) == .turnFinished)
        #expect(NotificationSoundCategory(event: event(.agentsFinished)) == .turnFinished)
        #expect(NotificationSoundCategory(event: event(.actionNeeded)) == .error)
        // The terminal chat's waits are permission / question events too.
        let ask = AttentionEvent.terminalWaiting(TerminalWaiting(kind: .question, message: "Which?", since: "2026-01-01T00:00:00Z"), chatId: "c")
        #expect(NotificationSoundCategory(event: ask) == .question)
    }

    @Test func aTurnThatStoppedOnAProblemSoundsAsAnError() {
        let done = AttentionEvent.turnFinished(pending: 2, key: "k", stopped: nil)
        #expect(done.stopReason == nil)
        #expect(NotificationSoundCategory(event: done) == .turnFinished)
        for kind: TurnStopReason.Kind in [.usageLimit, .rateLimited, .loginRequired, .apiError, .crashed, .maxTurns] {
            let stopped = AttentionEvent.turnFinished(pending: 0, key: "k", stopped: TurnStopReason(kind: kind, text: "x"))
            #expect(stopped.stopReason == kind)
            #expect(NotificationSoundCategory(event: stopped) == .error)
        }
    }

    @Test func defaultsDifferPerCategory() {
        let d = defaults()
        let sounds = NotificationSoundCategory.allCases.map { AppSettings.soundChoice(for: $0, defaults: d) }
        #expect(Set(sounds).count == NotificationSoundCategory.allCases.count)
        #expect(AppSettings.soundChoice(for: .permission, defaults: d) == .named("Glass"))
        #expect(AppSettings.soundChoice(for: .question, defaults: d) == .named("Purr"))
        #expect(AppSettings.soundChoice(for: .turnFinished, defaults: d) == .named("Hero"))
        #expect(AppSettings.soundChoice(for: .error, defaults: d) == .named("Basso"))
        #expect(AppSettings.soundChoice(for: .appUpdate, defaults: d) == .named("Pop"))
        // Every default is a sound macOS ships.
        for sound in sounds {
            guard case .named(let name) = sound else { Issue.record("not a named sound"); continue }
            #expect(NotificationSound.knownSystemSounds.contains(name))
        }
        // Each category has its own key.
        #expect(Set(NotificationSoundCategory.allCases.map(\.defaultsKey)).count == NotificationSoundCategory.allCases.count)
    }

    @Test func aPickedSoundIsKept() {
        let d = defaults()
        d.set(NotificationSound.named("Submarine").stored, forKey: NotificationSoundCategory.error.defaultsKey)
        d.set(NotificationSound.systemDefault.stored, forKey: NotificationSoundCategory.question.defaultsKey)
        #expect(AppSettings.soundChoice(for: .error, defaults: d) == .named("Submarine"))
        #expect(AppSettings.soundToPlay(.error, d) == .named("Submarine"))
        #expect(AppSettings.soundChoice(for: .question, defaults: d) == .systemDefault)
        #expect(AppSettings.soundToPlay(.question, d) == .systemDefault)
        #expect(AppSettings.soundChoice(for: .permission, defaults: d) == .named("Glass"))   // the others keep theirs
        // Stored values round-trip; nothing / empty → the default.
        for sound: NotificationSound in [.systemDefault, .none, .named("Tink")] {
            #expect(NotificationSound(stored: sound.stored) == sound)
        }
        #expect(NotificationSound(stored: nil) == nil)
        #expect(NotificationSound(stored: "") == nil)
    }

    @Test func noneAndTheSwitchesAboveSilenceIt() {
        let d = defaults()
        #expect(AppSettings.soundToPlay(.turnFinished, d) == .named("Hero"))
        d.set(NotificationSound.none.stored, forKey: NotificationSoundCategory.turnFinished.defaultsKey)
        #expect(AppSettings.soundChoice(for: .turnFinished, defaults: d) == NotificationSound.none)
        #expect(AppSettings.soundToPlay(.turnFinished, d) == nil)
        #expect(AppSettings.soundToPlay(.permission, d) == .named("Glass"))
        // "Play a sound" off: every category is silent.
        d.set(false, forKey: AppSettings.Key.notificationSound)
        for category in NotificationSoundCategory.allCases { #expect(AppSettings.soundToPlay(category, d) == nil) }
        // Notifications off altogether: silent too.
        d.set(true, forKey: AppSettings.Key.notificationSound)
        d.set(false, forKey: AppSettings.Key.notificationsEnabled)
        for category in NotificationSoundCategory.allCases { #expect(AppSettings.soundToPlay(category, d) == nil) }
    }

    @Test func oneSoundPerCategoryEveryTwoSeconds() {
        var gate = NotificationSoundGate()
        let t0 = Date(timeIntervalSince1970: 1000)
        let admitted = [
            gate.admits(.turnFinished, now: t0),
            gate.admits(.turnFinished, now: t0.addingTimeInterval(0.5)),   // another window finished too
            gate.admits(.permission, now: t0.addingTimeInterval(0.5)),     // another category sounds
            gate.admits(.turnFinished, now: t0.addingTimeInterval(1.9)),
            gate.admits(.turnFinished, now: t0.addingTimeInterval(2.0)),
            gate.admits(.permission, now: t0.addingTimeInterval(1.0)),
        ]
        #expect(admitted == [true, false, true, false, true, false])
    }

    @Test func theListIsWhatMacOSShips() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sounds-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for file in ["Tink.aiff", "Basso.aiff", "Glass.caf", "readme.txt", ".hidden.aiff"] {
            FileManager.default.createFile(atPath: dir.appendingPathComponent(file).path, contents: Data())
        }
        #expect(NotificationSound.systemSoundNames(in: dir) == ["Basso", "Glass", "Tink"])
        // Nothing there (or no folder): the list macOS ships.
        #expect(NotificationSound.systemSoundNames(in: dir.appendingPathComponent("missing")) == NotificationSound.knownSystemSounds)
    }
}

private extension AppSettings {
    static func soundToPlay(_ category: NotificationSoundCategory, _ defaults: UserDefaults) -> NotificationSound? {
        notificationSoundToPlay(for: category, defaults: defaults)
    }
}
