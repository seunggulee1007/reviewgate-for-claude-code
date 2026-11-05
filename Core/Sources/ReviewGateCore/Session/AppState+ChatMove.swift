import Foundation

// MARK: wave4b w4b-follow
// docs/PROTOCOL.md §39.4: when Claude works in another worktree of the repository, the chat follows it there — the review
// goes with it. The words and decisions live here; the windows (App/) open the target and show the buttons.

/// §39.4: the worktree a chat was handed to / came from.
public struct ChatMoveRef: Codable, Sendable, Hashable {
    public var path: String
    public var name: String
    public var at: String

    public init(path: String, name: String, at: String = "") {
        self.path = path
        self.name = name
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        let name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        self.name = name.flatMap { $0.isEmpty ? nil : $0 } ?? URL(fileURLWithPath: path).lastPathComponent
        at = (try? c.decodeIfPresent(String.self, forKey: .at)) ?? nil ?? ""
    }
}

/// §39.4 `chat_moved`: this window handed its chat over; the app opens or fronts the target's window.
public struct ChatMovedEvent: Decodable, Sendable, Equatable {
    public var sessionId: String
    public var path: String
    public var name: String
    /// The first review there starts at the worktree's HEAD commit (this chat made it) — else at the disk as it was.
    public var reviewsFromHead: Bool
    public var interrupted: Bool

    public init(sessionId: String, path: String, name: String, reviewsFromHead: Bool = false, interrupted: Bool = false) {
        self.sessionId = sessionId
        self.path = path
        self.name = name
        self.reviewsFromHead = reviewsFromHead
        self.interrupted = interrupted
    }

    private enum CodingKeys: String, CodingKey { case sessionId, path, name, baseline, interrupted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil ?? ""
        let name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        self.name = name.flatMap { $0.isEmpty ? nil : $0 } ?? URL(fileURLWithPath: path).lastPathComponent
        reviewsFromHead = ((try? c.decodeIfPresent(String.self, forKey: .baseline)) ?? nil) == "head"
        interrupted = (try? c.decodeIfPresent(Bool.self, forKey: .interrupted)) ?? nil ?? false
    }
}

/// The app's hook: open or front the window of a worktree a chat moved to (`ChatMovedEvent.path`) and let it take the chat.
@MainActor
public enum ChatMoveRouter {
    public static var route: (@MainActor (ChatMovedEvent, AppState) -> Void)?
}

/// §39.4 words (Mac and Electron share the keys).
public enum ChatMoveText {
    public static var moveTitle: String { String(localized: "Move This Chat There", bundle: .module) }
    public static var moveHelp: String {
        String(localized: "This chat continues in that worktree's window, and its changes there are reviewed", bundle: .module)
    }
    public static var allowAndFollowTitle: String { String(localized: "Allow and Follow", bundle: .module) }
    public static var allowAndFollowHelp: String {
        String(localized: "Runs the command; once the worktree exists, this chat moves there and is reviewed there", bundle: .module)
    }
    public static var confirmTitle: String { String(localized: "Claude is working — stop it and move the chat?", bundle: .module) }
    public static func confirmBody(name: String) -> String {
        String(localized: "The turn stops here and this chat continues in \(name). The review of this folder stays here.", bundle: .module)
    }
    public static var confirmStopAndMove: String { String(localized: "Stop and Move", bundle: .module) }
    public static var continueThere: String { String(localized: "Ask Claude to continue there", bundle: .module) }
    /// The message sent once in the target after a stopped turn (a normal send there).
    public static func followUp(name: String) -> String {
        String(localized: "The working folder moved to \(name). Please continue what you were doing.", bundle: .module)
    }
    public static func movedBanner(name: String) -> String {
        String(localized: "Moved → \(name). This chat continues in that window; here it is read-only.", bundle: .module)
    }
    public static func movedBadge(name: String) -> String { String(localized: "Moved → \(name)", bundle: .module) }
    public static var openThatWindow: String { String(localized: "Open That Window", bundle: .module) }

    /// The notices of §39.4 (`error` codes); nil for any other code.
    public static func noticeText(code: String?, path: String?, message: String, detail: String? = nil) -> String? {
        let from = path.map { SessionNotices.abbreviatingHome($0) } ?? ""
        switch code {
        case "chat_moved_in":
            return String(localized: "This chat moved here from \(from). It is reviewed from here on, with what it changed here before the move.", bundle: .module)
        case "chat_moved_in_disk":
            return String(localized: "This chat moved here from \(from). It is reviewed from here on; changes made here before the move are not in the review.", bundle: .module)
        case "chat_move_failed":
            let name = path.map { URL(fileURLWithPath: $0).lastPathComponent } ?? ""
            let line = String(localized: "This chat could not move to \(name), so it stays here.", bundle: .module)
            // Why, in words (the engine's code stays the row's second line).
            return detail.map { "\(line) \(refusal($0))" } ?? line
        default:
            return nil
        }
    }

    /// Codes that only inform (blue, never an "action needed" notification, never a stopped queue).
    public static let infoCodes: Set<String> = ["chat_moved_in", "chat_moved_in_disk"]
    public static let noticeCodes: Set<String> = ["chat_moved_in", "chat_moved_in_disk", "chat_move_failed"]

    /// One line on why a move was refused (the engine's code), for the banner / the card.
    public static func refusal(_ code: String?) -> String {
        switch code {
        case "session_busy": String(localized: "Claude is still working. Try again once the turn has ended.", bundle: .module)
        case "not_a_worktree": String(localized: "That folder is not a worktree of this repository.", bundle: .module)
        case "same_worktree": String(localized: "This chat already works in that folder.", bundle: .module)
        case "path_not_found": String(localized: "That folder does not exist.", bundle: .module)
        case "other_repository": String(localized: "That folder belongs to another repository, so this chat cannot move there. Open it in ReviewGate and go on in a new chat.", bundle: .module)
        case "notes_pending": String(localized: "Send or remove the review notes first: they belong to this chat.", bundle: .module)
        case "review_pending": String(localized: "Changes are being requested in this chat. Finish that round first.", bundle: .module)
        case "collect_failed": String(localized: "Collecting this turn's changes failed. Retry it first.", bundle: .module)
        case "chat_is_record": String(localized: "This chat is read-only here, so it cannot be moved.", bundle: .module)
        case "cli_still_running": String(localized: "Claude Code did not stop in time, so the chat stays here. Try again.", bundle: .module)
        case "nothing_to_receive": String(localized: "No chat is waiting for this window.", bundle: .module)
        default: String(localized: "The chat could not be moved (\(code ?? "?")).", bundle: .module)
        }
    }

    /// The engine's refusal code from `result.error` (`"session_busy"`, `"not_a_worktree"` …).
    public static func refusalCode(_ error: Error) -> String? {
        if let e = error as? EngineClientError, let code = e.refusalCode { return code }
        return nil
    }
}

extension AppState {
    /// The current chat was handed to another worktree (a record here).
    public var currentChatMovedTo: ChatMoveRef? {
        guard let id = sessionsInfo?.currentId else { return nil }
        return sessions.first { $0.id == id }?.movedTo
    }

    /// wave4b integration (§39.4 × §39.2): the chat the chat view shows (`shownChatId` — one shown read-only, else the
    /// current one) was handed to another worktree. The bar above the composer ("옮김 → <worktree>") says it for the chat
    /// on screen: not while another chat is shown read-only over the moved record, and also for a moved chat shown that way.
    public var shownChatMovedTo: ChatMoveRef? {
        guard let id = shownChatId else { return nil }
        return sessions.first { $0.id == id }?.movedTo
    }

    /// A move now stops a running turn (or answers an open card / plan): the window asks first.
    public var chatMoveNeedsStop: Bool { closeGuardReason != nil || sessionInfo.starting }

    /// Why the banner's "Move This Chat There" is off right now (nil = it can be pressed).
    public var chatMoveBlocker: String? {
        if projectInfo == nil { return String(localized: "No project is open.", bundle: .module) }
        if currentChatMovedTo != nil { return ChatMoveText.refusal("chat_is_record") }
        if isMovingChat { return String(localized: "Moving the chat…", bundle: .module) }
        return nil
    }

    /// §39.4 `chat_move`: hands this chat to the worktree at `path`. `stop` = the user confirmed stopping the running turn;
    /// `continueThere` sends "하던 일을 이어서 해 줘" there once (only when a turn was stopped). Nil on success, else one line.
    @discardableResult
    public func moveChat(to path: String, stop: Bool, continueThere: Bool) async -> String? {
        guard !isMovingChat else { return nil }
        isMovingChat = true
        defer { isMovingChat = false }
        let name = URL(fileURLWithPath: path).lastPathComponent
        let followUp = stop && continueThere ? ChatMoveText.followUp(name: name) : nil
        do {
            try await request(.chatMove(path: path, interrupt: stop, followUp: followUp))
            chatMoveNotice = nil
            return nil
        } catch {
            let text = ChatMoveText.refusal(ChatMoveText.refusalCode(error))
            chatMoveNotice = text
            return text
        }
    }

    /// §39.4 "허용하고 따라가기" on a `git worktree add` card: allowed now, and the chat moves once the command ran (the
    /// running turn stops; "하던 일을 이어서 해 줘" goes there once).
    public func allowAndFollow(requestId: String) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        let name = request.reason?.path.map { URL(fileURLWithPath: $0).lastPathComponent }
        answerPermission(request, allow: true, updatedInput: nil,
                         command: .permissionFollow(requestId: requestId, followUp: name.map { ChatMoveText.followUp(name: $0) }))
    }

    /// A card that can follow: a worktree-creating command whose target the engine named.
    public func canFollow(_ request: PermissionRequest) -> Bool {
        // §39.4: never into another repository's worktree (a chat moves only between worktrees of one repository).
        request.reason?.code == .worktreeCommand && request.reason?.otherRepository != true && !(request.reason?.path ?? "").isEmpty && request.toolUseId != nil
    }

    /// §39.4 `chat_receive`: this window takes the chat handed to it (a window that already had the worktree open).
    public func receiveMovedChat() async {
        do {
            try await request(.chatReceive)
        } catch {
            let code = ChatMoveText.refusalCode(error)
            if code == "nothing_to_receive" { return }
            chatMoveNotice = ChatMoveText.refusal(code)
        }
    }

    public func dismissChatMoveNotice() { chatMoveNotice = nil }

    func handleChatMoved(_ moved: ChatMovedEvent) {
        ChatMoveRouter.route?(moved, self)
    }
}
