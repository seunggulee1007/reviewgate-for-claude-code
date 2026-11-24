import Foundation
import Testing
@testable import ReviewGateCore

/// accept-baseline — docs/PROTOCOL.md §66 on the Mac: `acceptedBase` decodes leniently; a file with one shows the
/// since-accepted status letter, "수락 이후 / 라운드 전체" (수락 이후 first and by default), reject's words say the accepted
/// content comes back, "라운드 시작으로 되돌리기" sends `reject {to: "round"}`, parts are reverted in the since-accepted view
/// against the accepted tree, and the folded group counts the engine's `acceptedUncommitted`.
@Suite @MainActor struct SinceAcceptedTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "SinceAcceptedTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, status: ChangeStatus = .added, base: ChangeStatus? = .modified,
                      _ change: (inout ChangedFile) -> Void = { _ in }) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: status, added: 2, deleted: 1, isBinary: false, tools: ["Edit"])
        f.blob = "blob-\(path)"
        if let base {
            f.changedSinceAccepted = true
            f.acceptedBase = AcceptedBase(blob: "acc-\(path)", tree: "ACC1", status: base, roundAdded: 12, roundDeleted: 0)
        }
        change(&f)
        return f
    }

    private func snapshot(seq: Int, files: [ChangedFile], phase: GatePhase = .reviewing) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: phase == .reviewing, canRequestChanges: true, blockedReason: phase == .running ? .running : nil,
                          collectError: nil, pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0,
                          isRequestingChanges: false, turnStartTree: "A1", turnEndTree: phase == .running ? nil : "B1", lastReviewSummary: nil)
        s.gate.reviewEndTree = "B1"
        s.changedFiles = files
        return s
    }

    private func decodeFile(_ json: String) throws -> ChangedFile {
        try JSONDecoder().decode(ChangedFile.self, from: Data(json.utf8))
    }

    // MARK: Wire

    @Test func acceptedBaseDecodesAndAMalformedOneIsNone() throws {
        let created = try decodeFile(#"""
        {"path":"new.ts","status":"A","added":3,"deleted":1,"isBinary":false,"state":"pending","changedSinceAccepted":true,
         "acceptedBase":{"blob":"b0","tree":"T0","at":"2026-01-02T03:04:05Z","turn":2,"status":"M","roundAdded":40,"roundDeleted":0}}
        """#)
        #expect(created.acceptedBase == AcceptedBase(blob: "b0", tree: "T0", at: "2026-01-02T03:04:05Z", turn: 2, status: .modified,
                                                    roundAdded: 40, roundDeleted: 0))
        // Deleted when accepted (a tombstone), here again; a review saved before §66 (no at / turn).
        let tombstone = try decodeFile(#"{"path":"x","status":"M","state":"pending","acceptedBase":{"blob":null,"tree":"T1","at":null,"turn":null,"status":"A"}}"#)
        #expect(tombstone.acceptedBase == AcceptedBase(blob: nil, tree: "T1", status: .added))
        // Malformed / absent: no base (the file shows the whole round, as before §66), the snapshot still decodes.
        #expect(try decodeFile(#"{"path":"x","status":"M","state":"pending","acceptedBase":{"status":"M"}}"#).acceptedBase == nil)
        #expect(try decodeFile(#"{"path":"x","status":"M","state":"pending","acceptedBase":7}"#).acceptedBase == nil)
        #expect(try decodeFile(#"{"path":"x","status":"M","state":"pending"}"#).acceptedBase == nil)
    }

    @Test func rejectToTheRoundIsOnTheWireOnlyWhenAsked() throws {
        func json(_ c: EngineCommand) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommandEnvelope(command: c))) as! [String: Any]
        }
        #expect(try json(.reject(paths: ["a"])).keys.sorted() == ["paths", "type"])
        #expect(try json(.reject(paths: ["a"], to: .round))["to"] as? String == "round")
        let forced = try json(.reject(paths: ["a"], force: true, to: .round))
        #expect(forced["force"] as? Bool == true && forced["to"] as? String == "round")
    }

    // MARK: Label, status letter, ranges

    @Test func aFileReviewedSinceItsAcceptShowsTheChangeSinceTheAccept() {
        let created = file("new.ts")
        #expect(created.badgeStatus == .modified && created.status == .added)
        #expect(file("gone.ts", status: .modified, base: .deleted).badgeStatus == .deleted)
        // Without a base (an older engine, or never accepted): the round's letter.
        #expect(file("old.ts", base: nil).badgeStatus == .added)
        #expect(SinceAcceptedText.label == String(localized: "Changed since accepted", bundle: .module))
        #expect(!SinceAcceptedText.labelHelp.isEmpty)
    }

    @Test func theDiffOffersSinceAcceptedFirstThenTheWholeRound() {
        let gate = snapshot(seq: 1, files: []).gate
        let reopened = file("a.ts")
        #expect(ReviewRange.available(for: reopened, gate: gate) == [.accepted, .review])
        #expect(ReviewRange.defaultRange(for: reopened, gate: gate) == .accepted)
        #expect(DiffSince.review.label(for: reopened) == SinceAcceptedText.wholeRound)
        #expect(DiffSince.accepted.label(for: reopened) == DiffSince.accepted.label)
        // The whole review is asked for by name (the engine's default for such a file is since accepted).
        #expect(DiffSince.review.wire(for: reopened) == .review)
        // An older engine (changedSinceAccepted, no base): as before — 전체 first, labelled 전체.
        let older = file("b.ts", base: nil) { $0.changedSinceAccepted = true }
        #expect(ReviewRange.available(for: older, gate: gate) == [.review, .accepted])
        #expect(DiffSince.review.label(for: older) == DiffSince.review.label)
    }

    @Test func partsAreRevertedInTheSinceAcceptedViewByTheChangeSinceTheAccept() {
        // Claude created it, the user accepted it, a later turn edited it: the round says A, the accept says M.
        let created = file("new.ts")
        #expect(!created.allowsHunkReject(in: .review))
        #expect(created.allowsHunkReject(in: .accepted))
        // Deleted / re-created since the accept: the whole-file reject only.
        #expect(!file("x.ts", status: .modified, base: .deleted).allowsHunkReject(in: .accepted))
        #expect(!file("y.ts", status: .modified, base: .added).allowsHunkReject(in: .accepted))
        // Other ranges never; a file without a base only in the whole review.
        #expect(!created.allowsHunkReject(in: .turn) && !created.allowsHunkReject(in: .request))
        let plain = file("p.ts", status: .modified, base: nil)
        #expect(plain.allowsHunkReject(in: .review) && !plain.allowsHunkReject(in: .accepted))
    }

    @Test func hunkRejectInTheSinceAcceptedViewNamesTheAcceptedTree() async {
        let app = makeState()
        let created = file("new.ts")
        app.replySink = { command in
            guard case let .selectFile(path, since) = command else { throw EngineClientError.refused("unknown") }
            let diff = FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: [
                DiffHunk(id: 0, header: "@@ -1 +1 @@", lines: [DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1 +1 @@")]),
                DiffHunk(id: 1, header: "@@ -5 +5 @@", lines: [DiffLine(id: 1, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -5 +5 @@")]),
            ])
            return .fileDiff(id: nil, scope: .turn, path: path, diff: diff, truncated: false, endTree: "B1",
                             info: FileDiffInfo(since: since, baseTree: since == .accepted ? "ACC1" : "A1"))
        }
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, files: [created])))
        await app.diffLoadTask?.value
        #expect(app.selectedDiffSince == .accepted && app.showsHunkRejectRange(for: created))
        #expect(await app.rejectHunks(created, hunks: [1]))
        #expect(sent.last == .rejectHunks(path: "new.ts", hunks: [1], expectedEndTree: "B1", expectedBaseTree: "ACC1"))
        // The whole round of a created file: no parts (its round status is A), nothing sent.
        app.setDiffRange(.review, for: created)
        await app.diffLoadTask?.value
        #expect(!app.showsHunkRejectRange(for: created))
    }

    // MARK: Reject's words and the way back to the round's start

    @Test func revertingToTheRoundStartIsItsOwnConfirmedReject() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let created = file("src/new.ts"), edited = file("b.ts", status: .modified)
        app.handle(.state(snapshot(seq: 1, files: [created, edited])))
        #expect(SinceAcceptedText.rejectHelp == String(localized: "Revert to the content you accepted (⌘⇧R)", bundle: .module))
        #expect(SinceAcceptedText.roundRejectQuestion("src/new.ts").contains("new.ts"))
        #expect(!SinceAcceptedText.roundRejectQuestion("src/new.ts").contains("src/"))
        // A file this round created is deleted by the way back; another goes back to the round's start.
        #expect(SinceAcceptedText.roundRejectMessage(created) != SinceAcceptedText.roundRejectMessage(edited))

        // The plain reject leaves `to` to the engine (the accepted content).
        app.reject(edited)
        #expect(sent.last == .reject(paths: ["b.ts"]))
        #expect(app.roundRejectBlocker(created) == nil)
        app.rejectToRoundStart(created)
        #expect(sent.last == .reject(paths: ["src/new.ts"], to: .round))
        // Not for a file without a base.
        let count = sent.count
        app.rejectToRoundStart(file("c.ts", base: nil))
        #expect(sent.count == count)

        // While a turn runs it waits (a reject scheduled during a turn always restores the accepted content).
        app.handle(.state(snapshot(seq: 2, files: [created], phase: .running)))
        #expect(app.roundRejectBlocker(created) != nil)
        app.rejectToRoundStart(created)
        #expect(sent.count == count)
    }

    // MARK: The folded group's count

    @Test func theAcceptedGroupCountsTheEnginesNumber() {
        let summary = ReviewSummary(files: 4, added: 9, deleted: 2, acceptedUncommitted: 3)
        #expect(AcceptedGroup.count(summary: summary, shown: 2, filtered: false) == 3)
        // The author filter hides rows the engine counts: the rows shown, then.
        #expect(AcceptedGroup.count(summary: summary, shown: 2, filtered: true) == 2)
        // An older engine: the client's own count.
        #expect(AcceptedGroup.count(summary: ReviewSummary(files: 4, added: 9, deleted: 2), shown: 2, filtered: false) == 2)
        #expect(AcceptedGroup.count(summary: nil, shown: 1, filtered: false) == 1)
    }
}
