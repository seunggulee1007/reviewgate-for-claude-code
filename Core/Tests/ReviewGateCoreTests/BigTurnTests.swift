import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-bigturn: big turns and a full disk on the Mac (docs/PROTOCOL.md §39.1) — `state.storage` and the large-file
/// marks read leniently, one save-failure banner per run of failures, the disk chip / critical banner thresholds, the
/// bulk list folded by folder, the cleanup's reply, retry_save and settings.largeFileMB.
@Suite @MainActor struct BigTurnTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "BigTurnTests.\(UUID().uuidString)")! }

    private func storage(_ json: String) throws -> StorageState {
        try JSONDecoder().decode(StorageState.self, from: Data(json.utf8))
    }

    // MARK: - Wire

    @Test func storageDecodesLenientlyAndOlderEnginesSendNone() throws {
        let s = try storage(#"{"saveFailed":{"what":["history","review"],"code":"ENOSPC","diskFull":true,"detail":"no space","since":"2026-10-23T10:00:00.000Z","at":"2026-10-23T10:02:00.000Z"},"disk":{"freeBytes":400000000,"totalBytes":500000000000,"level":"critical","at":"x"}}"#)
        #expect(s.saveFailed == SaveFailure(what: ["history", "review"], code: "ENOSPC", diskFull: true, detail: "no space",
                                            since: "2026-10-23T10:00:00.000Z", at: "2026-10-23T10:02:00.000Z"))
        #expect(s.disk == DiskSpace(freeBytes: 400_000_000, totalBytes: 500_000_000_000, level: .critical))
        // Malformed parts are nil instead of failing the snapshot; an unknown level reads as ok.
        let odd = try storage(#"{"saveFailed":"x","disk":{"freeBytes":1.5e9,"level":"weird"}}"#)
        #expect(odd.saveFailed == nil)
        #expect(odd.disk == DiskSpace(freeBytes: 1_500_000_000, level: .ok))
        #expect(try storage(#""text""#) == StorageState())
        // A state without `storage` (an older engine) decodes as before.
        let file = #"{"path":"heap.hprof","oldPath":null,"status":"A","added":1,"deleted":0,"isBinary":false,"tools":[],"toolUseIds":[],"state":"pending","noteCount":0,"uncaptured":true,"tooLarge":true,"largeBytes":2147483648}"#
        let f = try JSONDecoder().decode(ChangedFile.self, from: Data(file.utf8))
        #expect(f.tooLarge && f.uncaptured && f.largeBytes == 2_147_483_648)
        let plain = try JSONDecoder().decode(ChangedFile.self, from: Data(#"{"path":"a.txt","status":"M"}"#.utf8))
        #expect(!plain.tooLarge && plain.largeBytes == nil)
    }

    @Test func historyCleanupReplyAndCommandsOnTheWire() throws {
        let reply = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"history_cleanup","id":"7","keep":20,"rounds":30,"checkpoints":40,"refs":140,"bytes":2048,"kept":20,"applied":false}"#.utf8))
        guard case let .historyCleanup(r) = reply else { Issue.record("not decoded: \(reply)"); return }
        #expect(r == HistoryCleanupReply(id: "7", keep: 20, rounds: 30, checkpoints: 40, refs: 140, bytes: 2048, kept: 20, applied: false))
        #expect(reply.replyId == "7")
        let unmeasured = try JSONDecoder().decode(HistoryCleanupReply.self, from: Data(#"{"keep":5,"rounds":0,"checkpoints":0,"refs":0,"bytes":null,"kept":3,"applied":true}"#.utf8))
        #expect(unmeasured.bytes == nil && unmeasured.isEmpty)
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        #expect(String(decoding: try enc.encode(EngineCommand.historyCleanup(keep: 20, apply: true)), as: UTF8.self) == #"{"apply":true,"keep":20,"type":"history_cleanup"}"#)
        #expect(String(decoding: try enc.encode(EngineCommand.retrySave), as: UTF8.self) == #"{"type":"retry_save"}"#)
    }

    // MARK: - Notices

    @Test func oneSaveFailureBannerPerRunOfFailures() {
        let failing = StorageState(saveFailed: SaveFailure(what: ["review"], code: "ENOSPC", diskFull: true, since: "t1"))
        #expect(StorageNotices.saveFailure(failing, dismissedSince: nil)?.since == "t1")
        #expect(StorageNotices.saveFailure(failing, dismissedSince: "t1") == nil)   // closed: the same run never comes back
        let again = StorageState(saveFailed: SaveFailure(what: ["review"], code: "ENOSPC", diskFull: true, since: "t2"))
        #expect(StorageNotices.saveFailure(again, dismissedSince: "t1")?.since == "t2")   // a new run is a new banner
        #expect(StorageNotices.saveFailure(StorageState(), dismissedSince: nil) == nil)
        #expect(StorageText.saveFailed(failing.saveFailed!).contains("review"))
        #expect(StorageText.saveFailed(SaveFailure(what: ["history"], code: "EACCES", since: "t")).contains("EACCES"))
    }

    @Test func diskChipOnlyBelowTheLowMarkAndOneCriticalBanner() {
        let ok = StorageState(disk: DiskSpace(freeBytes: 3_500_000_000, level: .ok))
        let low = StorageState(disk: DiskSpace(freeBytes: 1_500_000_000, level: .low))
        let critical = StorageState(disk: DiskSpace(freeBytes: 400_000_000, level: .critical))
        #expect(StorageNotices.diskChip(ok) == nil)   // a few GB to spare: nothing
        #expect(StorageNotices.diskChip(low)?.level == .low)
        #expect(StorageNotices.diskChip(critical)?.level == .critical)
        #expect(StorageNotices.diskCritical(low, dismissed: false) == nil)
        #expect(StorageNotices.diskCritical(critical, dismissed: false) != nil)
        #expect(StorageNotices.diskCritical(critical, dismissed: true) == nil)
    }

    @Test func storeDismissesAndRetries() async throws {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var sent: [EngineCommand] = []
        store.requestSink = { sent.append($0) }
        var s = ReviewState.empty
        s.seq = 1
        s.storage = StorageState(saveFailed: SaveFailure(what: ["review"], code: "ENOSPC", diskFull: true, since: "t1"),
                                 disk: DiskSpace(freeBytes: 300_000_000, level: .critical))
        store.state = s
        #expect(store.saveFailureNotice?.since == "t1")
        store.dismissSaveFailure()
        #expect(store.saveFailureNotice == nil)
        #expect(store.diskCriticalNotice != nil)
        store.dismissDiskCritical()
        #expect(store.diskCriticalNotice == nil)
        #expect(store.diskChip != nil)   // the chip stays while the disk is low
        store.retrySave()
        await eventually { !sent.isEmpty }
        #expect(sent == [.retrySave])
    }

    @Test func largeFileSettingIsClampedAndSentWithHello() {
        let d = defaults()
        #expect(AppSettings.largeFileMB(defaults: d) == 50)
        AppSettings.setLargeFileMB(0, defaults: d)
        #expect(AppSettings.largeFileMB(defaults: d) == 1)
        AppSettings.setLargeFileMB(200, defaults: d)
        #expect(AppSettings.engineSettings(defaults: d).largeFileMB == 200)
    }

    // MARK: - Folder fold (robustness-10 ②)

    @Test func bulkListFoldsByFolder() {
        #expect(!FolderFold.isBulk(300) && FolderFold.isBulk(301))
        let paths = ["README.md", "src/a/A.java", "src/a/B.java", "src/b/C.java", "gen/x/1.ts", "gen/x/2.ts", "gen/y/3.ts"]
        let deep = FolderFold.fold(paths)
        #expect(deep.map(\.folder) == ["", "gen/x", "gen/y", "src/a", "src/b"])
        #expect(deep.flatMap(\.paths).sorted() == paths.sorted())   // every path once
        let shallow = FolderFold.fold(paths, maxGroups: 3)
        #expect(shallow.map(\.folder) == ["", "gen", "src"])
        #expect(shallow.first { $0.folder == "src" }?.paths == ["src/a/A.java", "src/a/B.java", "src/b/C.java"])
        #expect(FolderFold.byParent(["a/b/c.txt", "a/d.txt"]).map(\.folder) == ["a", "a/b"])
        // 2,000 generated files under one tree stay at most `maxGroups` folders.
        let many = (0..<2000).map { "target/generated/p\($0 % 97)/F\($0).java" }
        let g = FolderFold.fold(many)
        #expect(g.count <= FolderFold.maxGroups)
        #expect(g.reduce(0) { $0 + $1.paths.count } == 2000)
    }

    @Test func storeFoldsABulkListIntoFolderSections() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var s = ReviewState.empty
        s.seq = 1
        s.changedFiles = (0..<10).map { ChangedFile(path: "src/F\($0).java", oldPath: nil, status: .modified, added: 1, deleted: 1, isBinary: false) }
        store.state = s
        #expect(!store.isBulkChange)
        #expect(store.listSections(riskOrder: false).allSatisfy { $0.folder == nil })
        s.seq = 2
        s.changedFiles = (0..<301).map { ChangedFile(path: "gen/p\($0 % 3)/F\($0).ts", oldPath: nil, status: .added, added: 1, deleted: 0, isBinary: false) }
        store.state = s
        #expect(store.isBulkChange)
        let sections = store.listSections(riskOrder: false)
        #expect(sections.map(\.folder) == ["gen/p0", "gen/p1", "gen/p2"])
        #expect(sections.map(\.id) == ["claude|gen/p0", "claude|gen/p1", "claude|gen/p2"])
        #expect(sections.reduce(0) { $0 + $1.files.count } == 301)
        #expect(sections[0].title == "gen/p0/ 101")
    }

    /// wave4b integration (§39.1 × §39.3): the author filter narrows a bulk list before it folds — a folder counts the
    /// files it opens to, and a folder with none of the kept files is not listed.
    @Test func bulkListFoldsTheFilesTheAuthorFilterKeeps() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var s = ReviewState.empty
        s.seq = 1
        s.changedFiles = (0..<301).map { ChangedFile(path: "gen/p\($0 % 3)/F\($0).ts", oldPath: nil, status: .added, added: 1, deleted: 0, isBinary: false) }
        store.state = s
        let kept = store.listSections(riskOrder: false, keep: { !$0.path.hasPrefix("gen/p2/") && $0.path.hasSuffix("0.ts") })
        #expect(kept.map(\.folder) == ["gen/p0", "gen/p1"])
        #expect(kept.allSatisfy { sec in sec.files.allSatisfy { $0.path.hasSuffix("0.ts") } })
        #expect(kept.map(\.title) == kept.map { "\($0.folder ?? "")/ \($0.files.count)" })
        #expect(store.listSections(riskOrder: false, keep: { _ in false }).isEmpty)
        // An ordinary list stays whole: its rows are filtered by the view, its header keeps the group's count.
        s.seq = 2
        s.changedFiles = Array(s.changedFiles.prefix(10))
        store.state = s
        #expect(store.listSections(riskOrder: false, keep: { _ in false }).map(\.files.count) == [10])
    }
}
