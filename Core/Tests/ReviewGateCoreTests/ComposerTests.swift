import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §23–28 on the client: wire types, the composer's mention / image helpers and the AppState actions.
@Suite @MainActor struct ComposerTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(command: command))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func event(_ line: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: line) }

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ComposerTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .reviewing, permission: PermissionRequest? = nil,
                          tokens: Int = 0, window: Int? = nil, chat: String = "c1",
                          checkpoints: [TurnCheckpoint] = [], notes: [ReviewNote] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: chat, model: "claude-opus-5-5", capabilities: nil,
                                pendingPermission: permission, canRestart: true, checkpoints: checkpoints)
        s.session.availableModels = [ModelOption(value: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true),
                                     ModelOption(value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5")]
        s.sessions = SessionsInfo(list: [], currentId: chat, openTabIds: [chat])
        let canSend = (phase == .reviewing || phase == .idle) && permission == nil
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A", turnEndTree: nil, lastReviewSummary: nil)
        s.hud.contextTokens = tokens
        s.hud.contextWindow = window
        s.reviewNotes = notes
        return s
    }

    // MARK: - Wire

    @Test func decodesModelsAndCheckpointsFromTheGoldenStates() throws {
        let initial = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(initial.session.selectedModel == nil && initial.session.effort == nil && initial.session.checkpoints.isEmpty)
        #expect(initial.session.availableModels.map(\.value) == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"])
        let opus = try #require(initial.session.availableModels.first)
        #expect(opus.displayName == "Opus 5.5" && opus.supportsEffort && opus.effortLevels == EffortLevel.allCases)

        let reviewing = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        // §35.11: filesSince counts what a file rewind restores — new.txt came from outside (origin external), it stays.
        #expect(reviewing.session.checkpoints == [TurnCheckpoint(turn: 1, prompt: "Change README", startedAt: "2026-01-02T03:04:05Z",
                                                                  endedAt: "2026-01-02T03:04:05Z", filesChanged: 2, filesSince: 1,
                                                                  canRewindFiles: true, canRewindConversation: true)])
    }

    @Test func decodesSessionFieldsLeniently() throws {
        let s = try NDJSON.decode(SessionInfo.self, from: #"""
        {"open":true,"effort":"turbo","selectedModel":"sonnet","availableModels":[{"value":"a","supportedEffortLevels":["low","warp"],"supportsEffort":true},{"nope":1}],
         "checkpoints":[{"turn":2},{"turn":"x"}]}
        """#)
        #expect(s.effort == nil && s.selectedModel == "sonnet")
        #expect(s.availableModels == [ModelOption(value: "a", displayName: "a", supportsEffort: true, supportedEffortLevels: [.low])])
        #expect(s.checkpoints.map(\.turn) == [2] && !s.checkpoints[0].allows(.files))
    }

    @Test func decodesTheNewEvents() throws {
        #expect(try event(#"{"type":"files","id":"q","query":"rd","items":[{"path":"README.md","kind":"file","changed":true},{"path":"docs","kind":"dir"},{"bad":1}]}"#)
                == .files(id: "q", query: "rd", items: [FileItem(path: "README.md", changed: true), FileItem(path: "docs", kind: .dir)]))
        #expect(try event(#"{"type":"attachment","id":"a","hash":"ab","mediaType":"image/png","dataBase64":"AAEC"}"#)
                == .attachment(id: "a", hash: "ab", mediaType: "image/png", dataBase64: "AAEC"))
        #expect(try event(#"{"type":"rewound","id":"r","toTurn":2,"mode":"both","restoredFiles":["a.txt"],"sessionId":null}"#)
                == .rewound(id: "r", toTurn: 2, mode: .both, restoredFiles: ["a.txt"], sessionId: nil))
        #expect(try event(#"{"type":"context_warning","percent":82.5,"contextTokens":165000,"contextWindow":200000}"#)
                == .contextWarning(ContextWarning(percent: 82.5, contextTokens: 165_000, contextWindow: 200_000)))
        let ref = AttachmentRef(hash: "h1", mediaType: "image/png", bytes: 10)
        #expect(try event(#"{"type":"user_message","text":"hi","turn":3,"mentions":["src/a.ts"],"attachments":[{"kind":"image","hash":"h1","mediaType":"image/png","bytes":10}]}"#)
                == .userMessage(text: "hi", turn: 3, mentions: ["src/a.ts"], attachments: [ref]))
        #expect(try event(#"{"type":"user_message","text":"hi","turn":1}"#) == .userMessage(text: "hi", turn: 1))
        #expect(EngineEvent.files(id: "q", query: "", items: []).replyId == "q")
        #expect(EngineEvent.rewound(id: "r", toTurn: 1, mode: .files, restoredFiles: [], sessionId: nil).replyId == "r")

        let row = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":4,"kind":"user_message","text":"x","mentions":["a"],"attachments":[{"hash":"h1","mediaType":"image/png","bytes":10}]}"#)
        #expect(row.kind == .userMessage(text: "x", mentions: ["a"], attachments: [ref]) && row.turn == 4)
    }

    @Test func encodesTheNewCommands() throws {
        let send = try json(.send(text: "hi", mentions: ["src/a.ts", "docs"], attachments: [SendAttachment(mediaType: .png, dataBase64: "AA==")]))
        #expect(send["mentions"] as? [String] == ["src/a.ts", "docs"])
        let attachment = try #require((send["attachments"] as? [[String: Any]])?.first)
        #expect(attachment["kind"] as? String == "image" && attachment["mediaType"] as? String == "image/png" && attachment["dataBase64"] as? String == "AA==")
        #expect(Set(try json(.send(text: "hi")).keys) == ["type", "text"])

        #expect(try json(.listFiles(query: "rd")) as NSDictionary == ["type": "list_files", "query": "rd"])
        #expect(try json(.attachmentGet(hash: "ab")) as NSDictionary == ["type": "attachment_get", "hash": "ab"])
        #expect(try json(.setModel(model: "sonnet")) as NSDictionary == ["type": "set_model", "model": "sonnet"])
        #expect(try json(.setModel(model: "sonnet", effort: .level(.high))) as NSDictionary == ["type": "set_model", "model": "sonnet", "effort": "high"])
        let reset = try json(.setModel(model: "sonnet", effort: .modelDefault))
        #expect(reset["effort"] is NSNull)
        #expect(try json(.rewind(toTurn: 2, mode: .both)) as NSDictionary == ["type": "rewind", "toTurn": 2, "mode": "both"])
        let edit = try json(.rewind(toTurn: 2, mode: .conversation, editText: "again", mentions: ["a"], force: true))
        #expect(edit["editText"] as? String == "again" && edit["mentions"] as? [String] == ["a"] && edit["force"] as? Bool == true)
        // Mentions / images only travel with an edited text.
        #expect(try json(.rewind(toTurn: 2, mode: .files, mentions: ["a"]))["mentions"] == nil)
        #expect(try json(.compact()) as NSDictionary == ["type": "compact"])
        #expect(try json(.compact(focus: "the API")) as NSDictionary == ["type": "compact", "focus": "the API"])
    }

    // MARK: - Images

    private static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])

    @Test func detectsImageTypesByMagic() {
        #expect(ImageMediaType(magic: Self.png) == .png)
        #expect(ImageMediaType(magic: Data([0xFF, 0xD8, 0xFF, 0xE0])) == .jpeg)
        #expect(ImageMediaType(magic: Data("GIF89a".utf8)) == .gif)
        #expect(ImageMediaType(magic: Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBP".utf8)) == .webp)
        #expect(ImageMediaType(magic: Data("%PDF-1.7".utf8)) == nil)
        #expect(ImageMediaType(fileExtension: "JPEG") == .jpeg && ImageMediaType(fileExtension: "tiff") == nil)
    }

    @Test func validatesImagesLikeTheEngine() {
        #expect(throws: Never.self) { try ComposerImage.validated(Self.png, name: "a.png", existing: 0).get() }
        #expect(ComposerImage.validated(Self.png, name: "a.png", existing: 5) == .failure(.tooMany))
        #expect(ComposerImage.validated(Data(), name: "a.png", existing: 0) == .failure(.invalid))
        #expect(ComposerImage.validated(Data("hello".utf8), name: "a.txt", existing: 0) == .failure(.unsupportedType))
        var big = Self.png
        big.append(Data(count: ComposerImage.maxBytes))
        #expect(ComposerImage.validated(big, name: "big.png", existing: 0) == .failure(.tooLarge))
        #expect(AttachmentProblem.tooLarge.code == "attachment_too_large")
        #expect(EngineMessages.refusal(code: "attachment_too_large", error: "attachment_too_large:#0 6000000 bytes") == AttachmentProblem.tooLarge.message)
    }

    @Test func hashesLikeTheEngineStore() {
        let image = ComposerImage(mediaType: .png, data: Data("abc".utf8), name: "x")
        #expect(image.hash == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(image.sendAttachment == SendAttachment(mediaType: .png, dataBase64: "YWJj"))
    }

    // MARK: - Mentions

    @Test func findsTheMentionBeingTyped() throws {
        let text = "look at @src/ma"
        let hit = try #require(ComposerMentions.activeQuery(in: text, caret: (text as NSString).length))
        #expect(hit.query == "src/ma" && hit.range == NSRange(location: 8, length: 7))
        #expect(ComposerMentions.activeQuery(in: "@", caret: 1)?.query == "")
        #expect(ComposerMentions.activeQuery(in: "mail me@host", caret: 12) == nil)   // not after whitespace
        #expect(ComposerMentions.activeQuery(in: "@a b", caret: 4) == nil)            // a space ends the token
        #expect(ComposerMentions.activeQuery(in: "@한글", caret: 3)?.query == "한글")
        let removed = ComposerMentions.removing(hit.range, from: text)
        #expect(removed.text == "look at " && removed.caret == 8)
    }

    @Test func addsMentionsWithoutDuplicatesUpToTheCap() {
        #expect(ComposerMentions.adding(["a", "./a", "docs/", "docs"], to: []) == ["a", "docs/"])
        let many = (0..<30).map { "f\($0)" }
        #expect(ComposerMentions.adding(many, to: ["x"]).count == ComposerMentions.maxMentions)
        #expect(ComposerMentions.displayName("src/app/main.ts") == "main.ts" && ComposerMentions.displayName("docs/") == "docs")
        let files = [ChangedFile(path: "a.ts", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: [], state: .pending),
                     ChangedFile(path: "gone.ts", oldPath: nil, status: .deleted, added: 0, deleted: 3, isBinary: false, tools: [], state: .pending)]
        #expect(ComposerMentions.changedFileMentions(files) == ["a.ts"])
    }

    @Test func mentionsOnlyPathsInsideTheRepository() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("composer-\(UUID().uuidString)")
        try fm.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        #expect(ComposerMentions.repoRelativePath(of: root.appendingPathComponent("src/a.ts"), root: root) == "src/a.ts")
        #expect(ComposerMentions.repoRelativePath(of: root.appendingPathComponent("src"), root: root) == "src")
        #expect(ComposerMentions.repoRelativePath(of: root.appendingPathComponent(".git/config"), root: root) == nil)
        #expect(ComposerMentions.repoRelativePath(of: root, root: root) == nil)
        #expect(ComposerMentions.repoRelativePath(of: URL(fileURLWithPath: "/etc/hosts"), root: root) == nil)
        #expect(ComposerMentions.repoRelativePath(of: root.appendingPathComponent("../x"), root: root) == nil)
    }

    // MARK: - AppState

    @Test func userRowsKeepTurnMentionsAndImages() {
        let app = makeState()
        let ref = AttachmentRef(hash: "h", mediaType: "image/png", bytes: 1)
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "old", mentions: ["a"], attachments: [ref]))]))
        app.handle(.userMessage(text: "new", turn: 2, mentions: ["b"]))
        guard case let .user(_, _, first) = app.transcript[0], case let .user(_, _, second) = app.transcript[1] else {
            Issue.record("user rows missing"); return
        }
        #expect(first == UserMessageMeta(turn: 1, mentions: ["a"], attachments: [ref]))
        #expect(second == UserMessageMeta(turn: 2, mentions: ["b"]))
    }

    @Test func sendCarriesMentionsAndImagesAndSeedsThumbnails() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        let image = ComposerImage(mediaType: .png, data: Self.png, name: "a.png")
        app.send("look", mentions: ["src/a.ts"], images: [image])
        #expect(sent == [.send(text: "look", mentions: ["src/a.ts"], attachments: [image.sendAttachment])])
        #expect(app.attachmentData[image.hash] == Self.png)
    }

    @Test func queuedMessagesKeepTheirMentions() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("later", mentions: ["a"])
        app.handle(.state(snapshot(seq: 2)))
        #expect(sent == [.send(text: "later", mentions: ["a"])])
    }

    @Test func stopMarksTheOpenPermissionCardDenied() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let request = PermissionRequest(requestId: "p1", toolName: "Bash", input: .object([:]), file: nil)
        app.handle(.state(snapshot(seq: 1, phase: .running, permission: request)))
        app.handle(.permissionRequest(request))
        app.interrupt()
        #expect(sent == [.interrupt])
        guard case let .permission(_, _, allowed)? = app.transcript.last else { Issue.record("no card"); return }
        #expect(allowed == false && app.pendingPermission == nil)
    }

    @Test func stopAndSendFallsBackWhenAnOlderEngineRefusesTheSend() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { if $0 != .sideList { sent.append($0) } }
        app.requestSink = { command in
            sent.append(command)
            if case .send = command { throw EngineClientError.refused("gate_closed:running", code: "gate_closed") }
        }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.interruptAndSend("urgent", mentions: ["a"])
        for _ in 0..<50 where sent.count < 2 { try? await Task.sleep(for: .milliseconds(10)) }
        try? await Task.sleep(for: .milliseconds(20))
        #expect(sent == [.interrupt, .send(text: "urgent", mentions: ["a"])])
        #expect(app.sendAfterInterrupt == "urgent")
        app.handle(.state(snapshot(seq: 2)))
        // M7 (wave1 mac-session): `send` is request/reply, so the resend lands on the request seam a moment later.
        for _ in 0..<50 where sent.count < 3 { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.last == .send(text: "urgent", mentions: ["a"]) && sent.count == 3)
    }

    @Test func contextWarningStaysUntilTheContextDropsOrTheChatChanges() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, tokens: 170_000, window: 200_000)))
        app.handle(.contextWarning(ContextWarning(percent: 85, contextTokens: 170_000, contextWindow: 200_000)))
        app.handle(.state(snapshot(seq: 2, tokens: 171_000, window: 200_000)))
        #expect(app.contextWarning?.percent == 85)
        app.handle(.state(snapshot(seq: 3, tokens: 20_000, window: 200_000)))
        #expect(app.contextWarning == nil)
        app.handle(.contextWarning(ContextWarning(percent: 90, contextTokens: 180_000, contextWindow: 200_000)))
        app.handle(.state(snapshot(seq: 4, tokens: 180_000, window: 200_000, chat: "c2")))
        #expect(app.contextWarning == nil)
        #expect(ContextMeter.level(0.5) == .normal && ContextMeter.level(0.8) == .warning && ContextMeter.level(0.95) == .critical)
        #expect(EngineMessages.contextWarningText(ContextWarning(percent: 82.34, contextTokens: 1, contextWindow: 2)).contains("82.3"))
    }

    @Test func compactSendsTheFocusAndClearsTheWarning() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        app.handle(.contextWarning(ContextWarning(percent: 85, contextTokens: 1, contextWindow: 2)))
        #expect(await app.compact(focus: "  the API  ") == nil)
        #expect(sent == [.compact(focus: "the API")] && app.contextWarning == nil)
        app.requestSink = { _ in throw EngineClientError.refused("focus_too_long", code: "focus_too_long") }
        #expect(await app.compact(focus: "x") == EngineMessages.refusal(error: "focus_too_long"))
    }

    @Test func setModelIsOptimisticAndRevertsOnRefusal() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.currentModelOption?.value == "claude-opus-5-5")   // matched on the CLI's model id
        await app.setModel("sonnet")
        #expect(sent == [.setModel(model: "sonnet")] && app.selectedModel == "sonnet" && app.currentModelOption?.displayName == "Sonnet")
        await app.setEffort(.high)
        #expect(sent.last == .setModel(model: "sonnet", effort: .level(.high)) && app.effort == .high)
        #expect(app.modelChipText == "Sonnet · \(EffortLevel.high.displayName)")
        await app.setEffort(nil)
        #expect(sent.last == .setModel(model: "sonnet", effort: .modelDefault) && app.effort == nil)
        app.requestSink = { _ in throw EngineClientError.refused("invalid_model:x", code: "invalid_model") }
        let refusal = await app.setModel("x")
        #expect(refusal == EngineMessages.refusal(error: "invalid_model") && app.selectedModel == "sonnet")
    }

    @Test func attachmentsAreFetchedOnceAndCached() async {
        let app = makeState()
        var asked = 0
        app.replySink = { command in
            guard case let .attachmentGet(hash) = command else { throw EngineClientError.stopped }
            asked += 1
            if hash == "gone" { throw EngineClientError.refused("unknown_attachment:gone", code: "unknown_attachment") }
            try await Task.sleep(for: .milliseconds(20))
            return .attachment(id: "x", hash: hash, mediaType: "image/png", dataBase64: Self.png.base64EncodedString())
        }
        async let a = app.attachment(hash: "h")
        async let b = app.attachment(hash: "h")
        let (first, second) = await (a, b)
        #expect(first == Self.png && second == Self.png && asked == 1)
        #expect(await app.attachment(hash: "h") == Self.png && asked == 1)
        #expect(await app.attachment(hash: "gone") == nil && app.missingAttachments.contains("gone"))
        #expect(await app.attachment(hash: "gone") == nil && asked == 2)
        let images = await app.composerImages(for: [AttachmentRef(hash: "h", mediaType: "image/png", bytes: 12)])
        #expect(images.map(\.mediaType) == [.png] && images.first?.data == Self.png)
    }

    @Test func rewindReplacesTheTranscriptAndRefusalsAreExplained() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        let checkpoint = TurnCheckpoint(turn: 2, prompt: "p", filesSince: 3, canRewindFiles: true, canRewindConversation: true)
        app.handle(.state(snapshot(seq: 1, checkpoints: [checkpoint])))
        #expect(app.checkpoint(forTurn: 2) == checkpoint && app.checkpoint(forTurn: 9) == nil)
        app.handle(.userMessage(text: "old", turn: 2))
        app.replySink = { command in
            if command == .sideList { throw EngineClientError.stopped }
            sent.append(command)
            return .rewound(id: "r", toTurn: 2, mode: .both, restoredFiles: ["a.txt"], sessionId: "c2")
        }
        let outcome = await app.rewind(toTurn: 2, mode: .both, editText: " again ", mentions: ["a"])
        #expect(outcome == .rewound(restoredFiles: ["a.txt"]))
        #expect(sent == [.rewind(toTurn: 2, mode: .both, editText: "again", mentions: ["a"])])
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "kept"))]))
        #expect(app.transcript.count == 1)   // the forked chat's rows replaced the old ones

        // The user edited a file since: the force-confirm alert, then the same rewind with `force`.
        app.replySink = { command in
            if command == .sideList { throw EngineClientError.stopped }
            sent.append(command)
            if case .rewind(_, _, _, _, _, false) = command {
                throw EngineClientError.refused("file_changed_since_review:a.txt", code: "file_changed_since_review", paths: ["a.txt"])
            }
            return .rewound(id: "r", toTurn: 2, mode: .files, restoredFiles: ["a.txt"], sessionId: nil)
        }
        #expect(await app.rewind(toTurn: 2, mode: .files) == .needsConfirmation)
        #expect(app.forceRejectRequest?.paths == ["a.txt"])
        app.confirmForceReject()
        for _ in 0..<100 where sent.last != .rewind(toTurn: 2, mode: .files, force: true) { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.last == .rewind(toTurn: 2, mode: .files, force: true))

        // §35.11: a file rewind that left an outside change as it was says so (the toast).
        app.dismissPermissionNotice()
        app.replySink = { command in
            if command == .sideList { throw EngineClientError.stopped }
            return .rewound(id: "r", toTurn: 2, mode: .files, restoredFiles: ["a.txt"], sessionId: nil, keptFiles: ["ide.txt", "b.txt"])
        }
        #expect(await app.rewind(toTurn: 2, mode: .files) == .rewound(restoredFiles: ["a.txt"]))
        #expect(app.permissionNotice?.text == AppState.keptOutsideText(2))
        let kept = try? NDJSON.decode(EngineEvent.self, from: #"{"type":"rewound","id":"r","toTurn":2,"mode":"files","restoredFiles":["a.txt"],"sessionId":null,"keptFiles":["ide.txt"]}"#)
        #expect(kept == .rewound(id: "r", toTurn: 2, mode: .files, restoredFiles: ["a.txt"], sessionId: nil, keptFiles: ["ide.txt"]))

        app.replySink = { _ in throw EngineClientError.refused("notes_pending", code: "notes_pending") }
        #expect(await app.rewind(toTurn: 2, mode: .conversation) == .refused(AppState.finishReviewFirstText))
        app.replySink = { _ in throw EngineClientError.refused("session_busy", code: "session_busy") }
        #expect(await app.rewind(toTurn: 2, mode: .conversation) == .refused(EngineMessages.refusal(error: "session_busy")))
    }

    @Test func rewindBlockersMirrorTheEngineGuards() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(app.rewindBlocker(mode: .files) == EngineMessages.refusal(error: "session_busy"))
        let note = ReviewNote(id: "n", path: "a", line: 1, side: .new, excerpt: "", body: "b")
        app.handle(.state(snapshot(seq: 2, notes: [note])))
        #expect(app.rewindBlocker(mode: .both) == AppState.finishReviewFirstText)
        #expect(app.rewindBlocker(mode: .files) == nil)
    }

    @Test func localizesTheNewRefusalsAndActivity() {
        #expect(EngineMessages.refusal(error: "rewind_unavailable:files") != "rewind_unavailable:files")
        #expect(EngineMessages.refusal(error: "invalid_mention:../x").contains("../x"))
        for code in ["too_many_mentions", "list_files_failed", "unknown_attachment", "invalid_effort", "set_model_failed",
                     "invalid_rewind_mode", "unknown_turn", "focus_too_long", "too_many_attachments", "attachment_type", "attachment_invalid"] {
            #expect(EngineMessages.refusal(error: code) != code, "\(code) is not localized")
        }
        #expect(HUDState.localizedActivity(HUDActivity(kind: .thinking, toolName: nil, detail: "compacting"), subagentDepth: 0)
                != HUDState.localizedActivity(HUDActivity(kind: .thinking, toolName: nil, detail: nil), subagentDepth: 0))
    }
}
