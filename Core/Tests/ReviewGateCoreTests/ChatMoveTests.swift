import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-follow — docs/PROTOCOL.md §39.4 on the Mac: the wire (chat_move / chat_receive / follow, chat_moved,
/// SessionMeta.movedTo / movedFrom), the move's words and buttons, and what the window asks before it moves.
@Suite @MainActor struct ChatMoveTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "ChatMoveTests.\(UUID().uuidString)")! }
    private func makeState() -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults()) }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(command)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    @Test func commandsEncodeTheirFields() throws {
        let move = try json(.chatMove(path: "/w/acme-1100-2", interrupt: true, followUp: "go on"))
        #expect(move["type"] as? String == "chat_move")
        #expect(move["path"] as? String == "/w/acme-1100-2")
        #expect(move["interrupt"] as? Bool == true)
        #expect(move["followUp"] as? String == "go on")
        let idle = try json(.chatMove(path: "/w/x", interrupt: false, followUp: nil))
        #expect(idle["interrupt"] == nil && idle["followUp"] == nil)
        #expect(try json(.chatReceive)["type"] as? String == "chat_receive")
        let follow = try json(.permissionFollow(requestId: "r1", followUp: "go on"))
        #expect(follow["type"] as? String == "permission_response")
        #expect(follow["requestId"] as? String == "r1" && follow["allow"] as? Bool == true && follow["follow"] as? Bool == true)
        #expect(follow["followUp"] as? String == "go on")
    }

    /// M05b (§39.4): `hello` tells the engine what to send once it moves a chat by itself — the app's own follow-up words.
    @Test func helloCarriesTheFollowUpTheEngineSendsAfterItsOwnMoves() throws {
        let settings = AppSettings.engineSettings(defaults: defaults())
        #expect(settings.chatMoveFollowUp == ChatMoveText.followUp(name: "{name}"))
        #expect(settings.chatMoveFollowUp?.contains("{name}") == true)
        let wire = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        #expect(wire["chatMoveFollowUp"] as? String == ChatMoveText.followUpTemplate)
    }

    @Test func chatMovedAndMetaDecodeLeniently() throws {
        let ev = try JSONDecoder().decode(EngineEvent.self, from: Data("""
        {"type":"chat_moved","sessionId":"s1","path":"/w/acme-1100-2","name":"acme-1100-2","baseline":"head","interrupted":true}
        """.utf8))
        #expect(ev == .chatMoved(ChatMovedEvent(sessionId: "s1", path: "/w/acme-1100-2", name: "acme-1100-2", reviewsFromHead: true, interrupted: true)))
        let bare = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"chat_moved","path":"/w/wt2"}"#.utf8))
        #expect(bare == .chatMoved(ChatMovedEvent(sessionId: "", path: "/w/wt2", name: "wt2")))

        let meta = try JSONDecoder().decode(SessionMeta.self, from: Data("""
        {"id":"s1","title":"t","movedTo":{"path":"/w/wt2","name":"wt2","at":"2026-10-23T01:00:00Z"},"movedFrom":{"path":"/w/main","at":"x"}}
        """.utf8))
        #expect(meta.movedTo == ChatMoveRef(path: "/w/wt2", name: "wt2", at: "2026-10-23T01:00:00Z"))
        #expect(meta.movedFrom?.name == "main")
        // An older engine's meta has neither; a malformed one is dropped, the chat still loads.
        let old = try JSONDecoder().decode(SessionMeta.self, from: Data(#"{"id":"s2","title":"t","movedTo":"nope"}"#.utf8))
        #expect(old.movedTo == nil && old.movedFrom == nil)
        let back = try JSONDecoder().decode(SessionMeta.self, from: JSONEncoder().encode(meta))
        #expect(back.movedTo == meta.movedTo && back.movedFrom == meta.movedFrom)
    }

    @Test func anotherRepositorysWorktreeIsNeverFollowed() throws {
        let store = makeState()
        let own = PermissionRequest(requestId: "r1", toolName: "Bash", input: .object([:]), file: nil, toolUseId: "b1",
                                    reason: PermissionReason(code: .worktreeCommand, path: "/w/acme-42"))
        let other = PermissionRequest(requestId: "r2", toolName: "Bash", input: .object([:]), file: nil, toolUseId: "b2",
                                      reason: PermissionReason(code: .worktreeCommand, path: "/w/other-42", otherRepository: true))
        #expect(store.canFollow(own))
        #expect(!store.canFollow(other))
        #expect(PermissionReasonText.line(other.reason!) != PermissionReasonText.line(own.reason!))
        let decoded = try NDJSON.decode(PermissionReason.self, from: #"{"code":"worktree_command","message":"m","path":"/w/x","otherRepository":true}"#)
        #expect(decoded.otherRepository)
        #expect(ChatMoveText.refusal("other_repository") != ChatMoveText.refusal("not_a_worktree"))
    }

    @Test func noticesAreWordedAndStyled() {
        let detail = EngineErrorDetail(code: "chat_moved_in", detail: nil, path: "/Users/me/acme")
        let text = SessionNotices.errorText(message: "m", detail: detail)
        #expect(text?.contains("acme") == true)
        #expect(SessionNotices.style(code: "chat_moved_in", fatal: false) == .info)
        #expect(SessionNotices.style(code: "chat_moved_in_disk", fatal: false) == .info)
        #expect(SessionNotices.style(code: "chat_move_failed", fatal: false) == .warning)
        #expect(SessionNotices.isNotice(code: "chat_move_failed", fatal: false))
        let disk = SessionNotices.errorText(message: "m", detail: EngineErrorDetail(code: "chat_moved_in_disk", detail: nil, path: "/w/a"))
        #expect(disk != nil && disk != text)
        // A failed follow says why in words (a missing folder is not "not a worktree").
        let failed = SessionNotices.errorText(message: "m", detail: EngineErrorDetail(code: "chat_move_failed", detail: "path_not_found", path: "/w/acme-42"))
        #expect(failed?.contains("acme-42") == true && failed?.hasSuffix(ChatMoveText.refusal("path_not_found")) == true)
        #expect(SessionNotices.bannerActions(code: "worktree_outside_review", repeats: 1, path: "/w/wt2", pathIsWorkbench: true) == [.moveChat, .openWorkbench])
        #expect(SessionNotices.bannerActions(code: "worktree_outside_review", repeats: 1, path: "/elsewhere", pathIsWorkbench: false) == [.openFolder])
        #expect(ChatMoveText.followUp(name: "acme-1100-2").contains("acme-1100-2"))
        #expect(ChatMoveText.refusal("session_busy") != ChatMoveText.refusal("not_a_worktree"))
    }

    @Test func moveSendsChatMoveAndSaysWhyItWasRefused() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        #expect(await app.moveChat(to: "/w/acme-1100-2", stop: true, continueThere: true) == nil)
        #expect(await app.moveChat(to: "/w/wt2", stop: false, continueThere: true) == nil)
        #expect(sent == [
            .chatMove(path: "/w/acme-1100-2", interrupt: true, followUp: ChatMoveText.followUp(name: "acme-1100-2")),
            // Nothing was stopped: no follow-up.
            .chatMove(path: "/w/wt2", interrupt: false, followUp: nil),
        ])
        app.requestSink = { _ in throw EngineClientError.refused("notes_pending", code: "notes_pending") }
        let why = await app.moveChat(to: "/w/wt2", stop: false, continueThere: false)
        #expect(why == ChatMoveText.refusal("notes_pending"))
        #expect(app.chatMoveNotice == why)
        #expect(!app.isMovingChat)
    }

    @Test func theRouterGetsTheMovedChatAndTheCurrentChatReadsMoved() {
        let app = makeState()
        var routed: [ChatMovedEvent] = []
        ChatMoveRouter.route = { ev, _ in routed.append(ev) }
        defer { ChatMoveRouter.route = nil }
        let ev = ChatMovedEvent(sessionId: "s1", path: "/w/wt2", name: "wt2")
        app.handle(.chatMoved(ev))
        #expect(routed == [ev])

        var snap = app.state
        snap.seq += 1
        var meta = SessionMeta(id: "s1", title: "t")
        meta.movedTo = ChatMoveRef(path: "/w/wt2", name: "wt2")
        snap.sessions = SessionsInfo(list: [meta], currentId: "s1", openTabIds: ["s1"])
        app.handle(.state(snap))
        #expect(app.currentChatMovedTo?.name == "wt2")
        #expect(ChatMoveText.movedBadge(name: "wt2").contains("wt2"))
    }

    /// wave4b integration (§39.4 × §39.2): the bar above the composer speaks of the chat on screen — not of the moved
    /// record while another chat is shown read-only over it, and of a moved chat that is itself shown read-only.
    @Test func theMovedBarFollowsTheChatOnScreen() {
        let app = makeState()
        var snap = app.state
        snap.seq += 1
        var moved = SessionMeta(id: "s1", title: "moved")
        moved.movedTo = ChatMoveRef(path: "/w/wt2", name: "wt2")
        snap.sessions = SessionsInfo(list: [moved, SessionMeta(id: "s2", title: "other")], currentId: "s1", openTabIds: ["s1", "s2"])
        app.handle(.state(snap))
        #expect(app.shownChatMovedTo?.name == "wt2")

        app.viewedChat = ViewedChat(id: "s2", liveId: "s1")   // another tab shown read-only over the moved record
        #expect(app.shownChatId == "s2")
        #expect(app.shownChatMovedTo == nil)
        #expect(app.currentChatMovedTo?.name == "wt2")   // the banner's move button still reads the live chat

        snap.seq += 1
        snap.sessions = SessionsInfo(list: [moved, SessionMeta(id: "s2", title: "other")], currentId: "s2", openTabIds: ["s1", "s2"])
        app.handle(.state(snap))
        app.viewedChat = ViewedChat(id: "s1", liveId: "s2")   // the moved chat shown read-only from another live chat
        #expect(app.shownChatMovedTo?.name == "wt2")
        #expect(app.currentChatMovedTo == nil)
    }
}
