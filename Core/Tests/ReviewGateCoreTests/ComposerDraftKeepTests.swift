import Foundation
import Testing
@testable import ReviewGateCore

/// r1-composer M12 (docs/PROTOCOL.md §38.1): the message being typed survives the PRs tab, an engine that stopped and an
/// app restart — each chat's draft (text and @ mentions) is saved as it is typed and comes back when the chat is shown.
@Suite @MainActor struct ComposerDraftKeepTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "ComposerDraftKeepTests.\(UUID().uuidString)")! }

    /// A window on /work/acme whose engine runs chat `chat` (nil: an engine without chats).
    private func window(_ defaults: UserDefaults, chat: String? = "c1") -> AppState {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        if let chat { s.sessions = SessionsInfo(list: [], currentId: chat, openTabIds: [chat]) }
        app.handle(.state(s))
        return app
    }

    private let png = ComposerImage(mediaType: .png, data: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), name: "shot.png")

    @Test func aDraftSavedWhileTypingComesBackAfterARestart() {
        let disk = defaults()
        let before = window(disk)
        #expect(before.draftChatId == "c1")
        before.saveDraft(ChatDraft(text: "Keep the receipt lines aligned", mentions: ["src/cart.ts"]), for: "c1")

        // The app (or the engine) starts again: a new window state on the same settings, an empty message box.
        let after = window(disk)
        let shown = after.moveDraft(ChatDraft(), from: nil, to: "c1")
        #expect(shown == ChatDraft(text: "Keep the receipt lines aligned", mentions: ["src/cart.ts"]))

        // Sent (the box emptied): nothing comes back next time.
        after.saveDraft(ChatDraft(), for: "c1")
        #expect(window(disk).savedDraft(for: "c1") == nil)
    }

    @Test func whatIsTypedBeforeTheChatIsKnownStaysInTheBox() {
        let app = window(defaults())
        app.saveDraft(ChatDraft(text: "older"), for: "c1")
        #expect(app.moveDraft(ChatDraft(text: "typed just now"), from: nil, to: "c1") == nil)
        // The same chat, or a chat that went away (project closed, engine stopped): the box keeps what it holds.
        #expect(app.moveDraft(ChatDraft(text: "x"), from: "c1", to: "c1") == nil)
        #expect(app.moveDraft(ChatDraft(text: "x"), from: "c1", to: nil) == nil)
    }

    @Test func eachChatKeepsItsOwnDraftInMemoryWithImagesAndOnDiskWithout() {
        let disk = defaults()
        let app = window(disk)
        // c1 → c2: c1's draft is kept (images too, in memory) and saved; c2 has nothing yet.
        let typed = ChatDraft(text: "Rename the codes", mentions: ["src/pricing.ts"], images: [png])
        #expect(app.moveDraft(typed, from: "c1", to: "c2") == ChatDraft())
        #expect(app.savedDraft(for: "c1") == ChatDraft(text: "Rename the codes", mentions: ["src/pricing.ts"]))
        // c2 → c1: the draft in memory comes back whole.
        #expect(app.moveDraft(ChatDraft(text: "for c2"), from: "c2", to: "c1") == typed)
        // After a restart only the saved text and mentions are there.
        #expect(window(disk).moveDraft(ChatDraft(), from: "c1", to: "c2") == ChatDraft(text: "for c2"))
    }

    @Test func anEngineWithoutChatsKeepsOneDraftForTheProject() {
        let disk = defaults()
        let app = window(disk, chat: nil)
        #expect(app.draftChatId == nil)
        #expect(app.composerDraftKey(for: nil) == "project:/work/acme")
        app.saveDraft(ChatDraft(text: "one window draft"), for: nil)
        #expect(window(disk, chat: nil).savedDraft(for: nil) == ChatDraft(text: "one window draft"))
        // Without a project nothing is saved.
        let empty = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: disk)
        #expect(empty.composerDraftKey(for: nil) == nil)
    }

    @Test func theOldestDraftsGoAndAHugeOneIsNotSaved() {
        let disk = defaults()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<(AppSettings.maxSavedComposerDrafts + 2) {
            AppSettings.saveComposerDraft(ChatDraft(text: "draft \(i)"), key: "chat-\(i)", now: start.addingTimeInterval(Double(i)), defaults: disk)
        }
        #expect(AppSettings.savedComposerDraft(key: "chat-0", defaults: disk) == nil)
        #expect(AppSettings.savedComposerDraft(key: "chat-1", defaults: disk) == nil)
        #expect(AppSettings.savedComposerDraft(key: "chat-2", defaults: disk) == ChatDraft(text: "draft 2"))

        let huge = String(repeating: "a", count: AppSettings.maxSavedComposerDraftLength + 1)
        AppSettings.saveComposerDraft(ChatDraft(text: huge), key: "chat-2", defaults: disk)
        #expect(AppSettings.savedComposerDraft(key: "chat-2", defaults: disk) == nil)
    }
}
