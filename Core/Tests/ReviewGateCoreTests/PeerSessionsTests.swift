import Foundation
import Testing
@testable import ReviewGateCore

/// wave4d w4d-peers: docs/PROTOCOL.md §42.2 on the Mac — the SendMessage card names the session it reaches
/// (`permission_request.toSession`), and the sidebar says how the user's other sessions see this window (`cli_sessions.self`).
/// Older engines send neither: the card shows `input.to` as before, the line is not shown.
@Suite struct PeerSessionsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func sendMessageCardNamesTheSessionItReaches() throws {
        let request = try decode(PermissionRequest.self, """
        {"requestId":"r1","toolName":"SendMessage","input":{"to":"uds:/tmp/cc-socks/76616.sock","message":"#514 끝났어","summary":"done"},
         "toSession":{"address":"uds:/tmp/cc-socks/76616.sock","pid":76616,"name":"acme-b4","cwd":"/Users/me/acme","status":"waiting","entrypoint":"cli"}}
        """)
        #expect(request.toSession == PeerSessionInfo(address: "uds:/tmp/cc-socks/76616.sock", pid: 76616, name: "acme-b4", cwd: "/Users/me/acme",
                                                     status: .waiting, entrypoint: "cli"))
        let content = SendMessageCardContent(request: request)
        #expect(PeerSessionText.recipientTitle(content) == "acme-b4")
        #expect(PeerSessionText.recipientAddress(content) == "uds:/tmp/cc-socks/76616.sock")
        #expect(content.message == "#514 끝났어")
        let detail = PeerSessionText.recipientDetail(content.toSession, home: "/Users/me")
        #expect(detail.contains("~/acme"))
        #expect(detail.split(separator: "·").count == 3)   // kind · folder · state
        // Round trip (the transcript keeps the request).
        let again = try JSONDecoder().decode(PermissionRequest.self, from: JSONEncoder().encode(request))
        #expect(again.toSession == request.toSession)
    }

    @Test func anOlderEngineOrAnAgentNameKeepsTheAddressAsBefore() throws {
        let plain = try decode(PermissionRequest.self, #"{"requestId":"r2","toolName":"SendMessage","input":{"to":"uds:/tmp/cc-socks/1.sock","message":"m"}}"#)
        #expect(plain.toSession == nil)
        let content = SendMessageCardContent(request: plain)
        #expect(PeerSessionText.recipientTitle(content) == "uds:/tmp/cc-socks/1.sock")
        #expect(PeerSessionText.recipientAddress(content) == nil)
        #expect(PeerSessionText.recipientDetail(nil) == "")
        // A malformed toSession is dropped, the request still decodes.
        let bad = try decode(PermissionRequest.self, #"{"requestId":"r3","toolName":"SendMessage","input":{"to":"a1b2"},"toSession":{"name":"x"}}"#)
        #expect(bad.toSession == nil)
        #expect(PeerSessionText.recipientTitle(SendMessageCardContent(request: bad)) == "a1b2")
        // A session without a registry name: its address is the title, not repeated below.
        let unnamed = try decode(PermissionRequest.self, """
        {"requestId":"r4","toolName":"SendMessage","input":{"to":"uds:/tmp/cc-socks/9.sock"},"toSession":{"address":"uds:/tmp/cc-socks/9.sock","pid":9,"status":"busy","entrypoint":"sdk-ts"}}
        """)
        let c = SendMessageCardContent(request: unnamed)
        #expect(PeerSessionText.recipientTitle(c) == "uds:/tmp/cc-socks/9.sock")
        #expect(PeerSessionText.recipientAddress(c) == nil)
        #expect(c.toSession?.isTerminal == false)
    }

    @Test func cliSessionsSaysHowOtherSessionsSeeThisWindow() throws {
        let reply = try decode(CliSessionsReply.self, """
        {"type":"cli_sessions","running":[],"resumable":[],"self":{"pid":4321,"name":"ReviewGate · acme","address":"uds:/tmp/cc-socks/4321.sock"}}
        """)
        #expect(reply.selfSession == PeerSelf(pid: 4321, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/4321.sock"))
        #expect(PeerSessionText.selfCopyText(reply.selfSession!) == "ReviewGate · acme (uds:/tmp/cc-socks/4321.sock)")
        #expect(PeerSessionText.selfCopyText(PeerSelf(pid: 1, name: "ReviewGate · x")) == "ReviewGate · x")
        #expect(PeerSessionText.selfCopyText(PeerSelf(pid: 1, address: "uds:/s.sock")) == "uds:/s.sock")
        #expect(PeerSessionText.selfCopyText(PeerSelf(pid: 1)) == nil)
        let old = try decode(CliSessionsReply.self, #"{"type":"cli_sessions","running":[],"resumable":[]}"#)
        #expect(old.selfSession == nil)
    }

    @Test @MainActor func theStoreKeepsSelfUntilTheProjectCloses() {
        let store = SessionToolsStore()
        var reply = CliSessionsReply(running: [], resumable: [])
        reply.selfSession = PeerSelf(pid: 7, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/7.sock")
        store.apply(sessions: reply)
        #expect(store.selfSession?.name == "ReviewGate · acme")
        store.reset()
        #expect(store.selfSession == nil)
    }

    @Test func homeIsWrittenAsTilde() {
        #expect(PeerSessionText.abbreviated("/Users/me/acme", home: "/Users/me") == "~/acme")
        #expect(PeerSessionText.abbreviated("/Users/me", home: "/Users/me/") == "~")
        #expect(PeerSessionText.abbreviated("/Users/meme/x", home: "/Users/me") == "/Users/meme/x")
    }
}
