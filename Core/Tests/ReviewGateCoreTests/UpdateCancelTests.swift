import Foundation
import Testing
@testable import ReviewGateCore

/// polish P5-sheets-47 (docs/PROTOCOL.md §55.9): an update's download can be stopped from its banner, and says how much came.
@Suite struct UpdateCancelTests {
    /// A 60 s sleep that ends long before 60 s was stopped: the bound leaves a slow runner half a minute (GitHub's macOS
    /// runner took 3.2 s where 3 s was allowed), and a cancel that did nothing still fails it.
    @Test func aCancelledTaskTerminatesItsProcess() async throws {
        let started = ContinuousClock.now
        let task = Task { try await CommandRunner.run("/bin/sleep", ["60"]) }
        try await Task.sleep(for: .milliseconds(200))
        task.cancel()
        let output = try await task.value
        #expect(output.status != 0)
        #expect(ContinuousClock.now - started < .seconds(30))
    }

    @Test func aTaskCancelledBeforeTheProcessStartsStopsItToo() async throws {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await CommandRunner.run("/bin/sleep", ["60"])
        }
        let started = ContinuousClock.now
        _ = try await task.value
        #expect(ContinuousClock.now - started < .seconds(30))
    }

    @Test func howMuchHasCome() throws {
        #expect(AppUpdateText.received(12_400_000, of: 48_000_000) == "12.4 / 48.0 MB")
        #expect(AppUpdateText.received(60_000_000, of: 48_000_000) == "48.0 / 48.0 MB")
        #expect(AppUpdateText.received(3_000_000, of: nil) == "3.0 MB")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("UpdateCancelTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data(count: 1500).write(to: folder.appendingPathComponent("ReviewGate-0.6.0.dmg"))
        try Data(count: 64).write(to: folder.appendingPathComponent("ReviewGate-0.6.0.dmg.sha256"))
        #expect(AppUpdateInstaller.bytes(in: folder) == 1564)
        #expect(AppUpdateInstaller.bytes(in: folder.appendingPathComponent("missing")) == 0)
    }
}
