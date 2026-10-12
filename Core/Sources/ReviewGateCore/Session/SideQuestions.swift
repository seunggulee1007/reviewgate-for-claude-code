import Foundation
import Observation

// docs/PROTOCOL.md §21: side questions ("곁질문") — a read-only Q&A next to the main conversation, about a change,
// whose conclusion can be sent to the main conversation or added as a review note.

/// The answer of a running question as it streams (`side_text_delta` / `side_tool_use` / `side_tool_result`); dropped once
/// the thread's final snapshot carries the assistant message.
public struct SideLiveAnswer: Sendable, Equatable {
    public var text: String = ""
    public var toolCalls: [SideToolCall] = []
    /// `side_turn_end` arrived; the final `side_thread` follows.
    public var ended = false

    public init(text: String = "", toolCalls: [SideToolCall] = [], ended: Bool = false) {
        self.text = text
        self.toolCalls = toolCalls
        self.ended = ended
    }
}

/// One message of a thread as the side panel renders it: the persisted ones plus the live answer.
public struct SideDisplayMessage: Sendable, Equatable, Identifiable {
    public var id: Int
    public var message: SideMessage
    public var streaming: Bool
}

/// The editable "send to the main conversation / add as a review note" draft (`side_promote_draft` → `side_promote`).
public struct SidePromoteDraft: Sendable, Equatable, Identifiable {
    public var id: String { threadId + "#" + target.rawValue }
    public var threadId: String
    public var target: SidePromoteTarget
    public var text: String
    public var anchor: SideAnchor?
    /// `side_promote` is in flight.
    public var isSending = false
    /// The last refusal, in the user's words.
    public var refusal: String?
    /// `gate_closed:running` on a message: it can go to the composer queue instead.
    public var canQueue = false

    public init(threadId: String, target: SidePromoteTarget, text: String, anchor: SideAnchor?) {
        self.threadId = threadId
        self.target = target
        self.text = text
        self.anchor = anchor
    }
}

/// Words for anchors and the one-click questions.
public enum SideQuestionText {
    /// What every promoted message ends with (the engine appends the same marker).
    public static let promotedMarker = "(곁질문에서 정리됨)"

    /// The one-click "왜?" question for an anchor.
    public static func defaultQuestion(for anchor: SideAnchor?) -> String {
        guard let anchor else { return String(localized: "Why was this changed this way?", bundle: .module) }
        if anchor.line != nil { return String(localized: "Why was this line changed this way?", bundle: .module) }
        if anchor.hunkId != nil { return String(localized: "Why was this part changed this way?", bundle: .module) }
        if anchor.path != nil { return String(localized: "Why was this file changed this way?", bundle: .module) }
        if anchor.toolUseId != nil { return String(localized: "Why did Claude run this?", bundle: .module) }
        return String(localized: "Why was this changed this way?", bundle: .module)
    }

    /// "Why is this needed?" for a permission card: names the tool and its command / file.
    public static func permissionQuestion(_ request: PermissionRequest) -> String {
        let detail = request.input["command"]?.stringValue ?? request.file ?? request.input["url"]?.stringValue ?? ""
        let line = detail.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let clipped = line.count > 160 ? String(line.prefix(159)) + "…" : line
        if clipped.isEmpty { return String(localized: "Why does Claude need \(request.toolName) here?", bundle: .module) }
        return String(localized: "Why does Claude need \(request.toolName) here? (\(clipped))", bundle: .module)
    }

    /// Suggestions under the question field of a new thread.
    public static func suggestions(for anchor: SideAnchor?) -> [String] {
        var out = [defaultQuestion(for: anchor)]
        if anchor?.toolUseId != nil, anchor?.path == nil {
            out.append(String(localized: "Is this safe to allow?", bundle: .module))
        } else {
            out.append(String(localized: "Is there a simpler way?", bundle: .module))
            out.append(String(localized: "What could break because of this?", bundle: .module))
        }
        return out
    }

    /// `src/a.ts:42`, `src/a.ts · part 2`, `src/a.ts`; nil without a path.
    public static func location(_ anchor: SideAnchor?) -> String? {
        if let pr = anchor?.pr { return prLocation(pr) }   // wave3 mac-flow (§36.14)
        if let quote = anchor?.quote { return SideTrust.quoteLabel(quote) }   // wave4b w4b-side (§40.3)
        guard let anchor, let path = anchor.path else { return nil }
        if let line = anchor.line { return "\(path):\(line)" }
        if let hunk = anchor.hunkId { return String(localized: "\(path) · part \(hunk + 1)", bundle: .module) }
        return path
    }

    /// The anchor chip: the location, else "Tool call" / "Past review" / "General".
    public static func chip(_ anchor: SideAnchor?, toolName: String? = nil) -> String {
        if let location = location(anchor) { return location }
        if anchor?.toolUseId != nil { return toolName.map { String(localized: "\($0) call", bundle: .module) } ?? String(localized: "Tool call", bundle: .module) }
        if anchor?.entryId != nil { return String(localized: "Past review", bundle: .module) }
        return String(localized: "General", bundle: .module)
    }

    /// Where a promotion lands, shown in the draft sheet.
    public static func destination(_ target: SidePromoteTarget, anchor: SideAnchor?, chatTitle: String?) -> String {
        switch target {
        case .message:
            if let chatTitle, !chatTitle.isEmpty { return String(localized: "Main conversation · \(chatTitle)", bundle: .module) }
            return String(localized: "Main conversation", bundle: .module)
        case .note:
            if let location = location(anchor) { return String(localized: "Review note · \(location)", bundle: .module) }
            return String(localized: "Review note", bundle: .module)
        }
    }

    /// The thread's last promotion, for "Sent to the main conversation ✓".
    public static func promotionLabel(_ promotion: SidePromotion) -> String {
        if promotion.queued { return "⏳ " + String(localized: "Queued for the main conversation", bundle: .module) }   // wave4b w4b-side (§40.3)
        return switch promotion.target {
        case .message: String(localized: "Sent to the main conversation ✓", bundle: .module)
        case .note: String(localized: "Added as a review note ✓", bundle: .module)
        }
    }

    /// `$0.0123` → "$0.01"; below a cent "<$0.01"; 0 → "$0.00".
    public static func cost(_ usd: Double) -> String {
        if usd > 0, usd < 0.005 { return "<$0.01" }
        return String(format: "$%.2f", usd)
    }
}

/// The side threads of the current chat, the streaming answers and the promote flow. Owned by `AppState` (`store.side`);
/// `AppState.handle` forwards the §21 events.
@MainActor
@Observable
public final class SideThreadStore {
    /// The current chat's threads, newest first.
    public private(set) var threads: [SideThread] = []
    public private(set) var mainSessionId: String?
    /// Answers streaming right now, by thread id.
    public private(set) var live: [String: SideLiveAnswer] = [:]
    /// The thread the panel shows; nil = the list (or the new-question view while `isComposing`).
    public var selectedThreadId: String?
    /// The new-question view is open (with `composeAnchor`).
    public private(set) var isComposing = false
    public private(set) var composeAnchor: SideAnchor?
    /// What is typed in the new-question field and in each thread's follow-up field (by thread id): kept while the panel
    /// shows the list, another thread or the agent panel; cleared once asked, for another anchor, or on a chat switch.
    public var composeDraft = ""
    public var followUpDrafts: [String: String] = [:]
    /// Bumped when an entry point asks the window to show the panel.
    public private(set) var presentTick = 0
    /// Bumped to focus the question / follow-up field.
    public private(set) var focusTick = 0
    /// A new thread's `side_ask` is in flight.
    public private(set) var isAskingNew = false
    /// Follow-ups / cancels in flight.
    public private(set) var busyThreadIds: Set<String> = []
    /// The last failure per thread (refusal, `side_failed`), in the user's words; "" = the new-question view.
    public private(set) var errors: [String: String] = [:]
    /// `side_promote_draft` in flight for this thread.
    public private(set) var draftingThreadId: String?
    /// The draft sheet.
    public private(set) var draft: SidePromoteDraft?
    /// Threads whose conclusion went to the composer queue (the main turn was running).
    public private(set) var queuedThreadIds: Set<String> = []
    /// The diff's current selection (clicked line), for ⌥⌘/.
    public var selectionAnchor: SideAnchor?
    /// False once the engine answered `unknown_command` (an engine without §21): entry points hide.
    public private(set) var isSupported = true
    /// Called when an answer finished (notification while the window is in the background).
    @ObservationIgnored var onAnswerFinished: ((SideThread) -> Void)?
    @ObservationIgnored weak var app: AppState?

    public init() {}

    func attach(_ app: AppState) { self.app = app }

    // MARK: Queries

    public func thread(_ id: String?) -> SideThread? {
        guard let id else { return nil }
        return threads.first { $0.id == id }
    }

    public var selectedThread: SideThread? { thread(selectedThreadId) }
    public var runningCount: Int { threads.filter(\.isRunning).count }

    /// Persisted messages plus the live answer of a running question.
    public func displayMessages(_ thread: SideThread) -> [SideDisplayMessage] {
        var out = thread.messages.enumerated().map { SideDisplayMessage(id: $0.offset, message: $0.element, streaming: false) }
        guard thread.isRunning else { return out }
        if let answer = live[thread.id] {
            let message = SideMessage(role: .assistant, text: answer.text, toolCalls: answer.toolCalls)
            out.append(SideDisplayMessage(id: out.count, message: message, streaming: true))
        } else if draftingThreadId != thread.id {
            out.append(SideDisplayMessage(id: out.count, message: SideMessage(role: .assistant, text: ""), streaming: true))
        }
        return out
    }

    /// Threads anchored on `path` in the current review (history anchors excluded).
    public func threads(onPath path: String) -> [SideThread] {
        threads.filter { $0.anchor?.path == path && $0.anchor?.entryId == nil }
    }

    public func count(onPath path: String) -> Int { threads(onPath: path).count }

    /// Threads on one hunk of `path`: its `hunkId`, or a line inside the hunk on that side.
    public func count(onPath path: String, hunk: DiffHunk) -> Int {
        threads(onPath: path).filter { Self.anchor($0.anchor, isIn: hunk) }.count
    }

    public nonisolated static func anchor(_ anchor: SideAnchor?, isIn hunk: DiffHunk) -> Bool {
        guard let anchor else { return false }
        if let hunkId = anchor.hunkId { return hunkId == hunk.id }
        guard let line = anchor.line else { return false }
        let side = anchor.side ?? .new
        return hunk.lines.contains { ($0.kind != .hunkHeader) && (side == .old ? $0.oldNo : $0.newNo) == line }
    }

    /// The last promotion of a thread (engine-recorded).
    public func lastPromotion(_ thread: SideThread) -> SidePromotion? { thread.promotions.last }

    // MARK: Entry points

    /// Opens the new-question view for `anchor` (the panel comes forward and the field gets focus).
    public func compose(anchor: SideAnchor?) {
        let anchor = anchor.flatMap { $0.isEmpty ? nil : $0 }
        if anchor != nil, anchor != composeAnchor, !composeDraft.isEmpty { composeDraft = "" }   // a question about something else
        composeAnchor = anchor
        isComposing = true
        selectedThreadId = nil
        errors[""] = nil
        presentTick &+= 1
        focusTick &+= 1
    }

    /// One click: asks `question` (default: "Why was this changed this way?") about `anchor` right away.
    public func askNow(anchor: SideAnchor?, question: String? = nil) {
        let q = question ?? SideQuestionText.defaultQuestion(for: anchor)
        composeAnchor = anchor.flatMap { $0.isEmpty ? nil : $0 }
        isComposing = true
        selectedThreadId = nil
        presentTick &+= 1
        Task { await ask(q, anchor: composeAnchor) }
    }

    /// Brings the panel forward without changing what it shows.
    public func present() { presentTick &+= 1 }

    public func showList() {
        isComposing = false
        selectedThreadId = nil
    }

    public func select(_ threadId: String) {
        isComposing = false
        selectedThreadId = threadId
        presentTick &+= 1
    }

    /// The panel's toggle opened it: nothing selected and nothing to list → the new-question view.
    public func panelOpened() {
        if selectedThreadId == nil, !isComposing, threads.isEmpty { compose(anchor: nil) }
    }

    // MARK: Commands

    /// A new thread (`threadId` nil) or a follow-up. Returns false when the engine refused (the reason is in `errors`).
    @discardableResult
    public func ask(_ question: String, threadId: String? = nil, anchor: SideAnchor? = nil) async -> Bool {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = threadId ?? ""
        guard !trimmed.isEmpty else {
            errors[key] = EngineMessages.refusal(code: "empty_question", error: "empty_question")
            return false
        }
        guard let app else { return false }
        errors[key] = nil
        if let threadId { busyThreadIds.insert(threadId) } else { isAskingNew = true }
        defer { if let threadId { busyThreadIds.remove(threadId) } else { isAskingNew = false } }
        do {
            let reply = try await app.reply(.sideAsk(threadId: threadId, anchor: threadId == nil ? anchor : nil, question: trimmed))
            guard case let .sideThread(_, thread) = reply else { return false }
            if live[thread.id] == nil { live[thread.id] = SideLiveAnswer() }
            upsert(thread)
            if threadId == nil {
                isComposing = false
                composeAnchor = nil
                composeDraft = ""
                selectedThreadId = thread.id
            }
            focusTick &+= 1
            return true
        } catch {
            errors[key] = refusalText(error)
            return false
        }
    }

    public func cancel(_ threadId: String) async {
        guard let app else { return }
        do { _ = try await app.reply(.sideCancel(threadId: threadId)) } catch { errors[threadId] = refusalText(error) }
    }

    /// Removes the thread (interrupting it); the engine confirms with `side_thread_closed`.
    public func close(_ threadId: String) async {
        guard let app else { return }
        do {
            _ = try await app.reply(.sideClose(threadId: threadId))
            remove(threadId)
        } catch {
            errors[threadId] = refusalText(error)
        }
    }

    /// `side_list` for the current chat (after a project open / chat switch).
    public func reload() async {
        guard let app else { return }
        do {
            let reply = try await app.reply(.sideList)
            if case let .sideThreads(_, main, list) = reply { replace(mainSessionId: main, threads: list) }
        } catch let error as EngineClientError {
            if error.refusalCode == "unknown_command" { isSupported = false }
        } catch {}
    }

    // MARK: Promote

    /// Asks the side session for an instruction to the main agent and opens the draft sheet with it.
    public func preparePromotion(_ threadId: String, target: SidePromoteTarget) async {
        guard let app, draftingThreadId == nil else { return }
        draftingThreadId = threadId
        errors[threadId] = nil
        defer { draftingThreadId = nil }
        do {
            let reply = try await app.reply(.sidePromoteDraft(threadId: threadId))
            guard case let .sidePromoteDraft(_, id, text) = reply else { return }
            draft = SidePromoteDraft(threadId: id, target: target, text: text, anchor: thread(id)?.anchor)
        } catch {
            errors[threadId] = refusalText(error)
            // MARK: wave4b w4b-side — §40.3 (SME-13): the summary failed — the sheet still opens to write the conclusion by hand.
            var manual = SidePromoteDraft(threadId: threadId, target: target, text: "", anchor: thread(threadId)?.anchor)
            manual.refusal = SideTrust.draftFailedText(refusalText(error))
            draft = manual
        }
    }

    // MARK: wave4b w4b-side — §40.3

    /// [최신 대화로 다시 묻기]: asks `typed` (else the thread's last question) against the main conversation as it is now.
    @discardableResult
    public func refork(_ threadId: String, typed: String = "") async -> Bool {
        guard let app, let question = SideTrust.reforkQuestion(thread(threadId), typed: typed) else { return false }
        errors[threadId] = nil
        busyThreadIds.insert(threadId)
        defer { busyThreadIds.remove(threadId) }
        do {
            let reply = try await app.reply(.sideRefork(threadId: threadId, question: question))
            guard case let .sideThread(_, thread) = reply else { return false }
            if live[thread.id] == nil { live[thread.id] = SideLiveAnswer() }
            upsert(thread)
            focusTick &+= 1
            return true
        } catch {
            errors[threadId] = refusalText(error)
            return false
        }
    }

    public func dismissDraft() { draft = nil }

    /// `side_promote` with the edited text. Returns true when it went out (the sheet closes).
    @discardableResult
    public func sendDraft(text: String, acceptPending: Bool = false) async -> Bool {
        guard let app, var current = draft else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            current.refusal = EngineMessages.refusal(code: current.target == .note ? "empty_note" : "empty_message", error: "empty")
            draft = current
            return false
        }
        current.text = text
        current.isSending = true
        current.refusal = nil
        current.canQueue = false
        draft = current
        do {
            _ = try await app.reply(.sidePromote(threadId: current.threadId, target: current.target, text: trimmed,
                                                 acceptPending: acceptPending && current.target == .message))
            draft = nil
            return true
        } catch {
            current.isSending = false
            current.refusal = refusalText(error)
            if let code = (error as? EngineClientError)?.refusalCode, code == "gate_closed" || code == "session_busy" || code == "session_running",
               current.target == .message {
                current.canQueue = true
            }
            draft = current
            return false
        }
    }

    /// The main turn is running: the conclusion goes to the composer queue instead (sent when Claude is free).
    public func queueDraft(text: String) {
        guard let app, let current = draft else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        app.enqueue(trimmed + "\n\n" + SideQuestionText.promotedMarker)
        queuedThreadIds.insert(current.threadId)
        draft = nil
        // MARK: wave4b w4b-side — §40.3: the engine keeps the record ("대기열에 넣음"), so it outlives a chat switch.
        app.fire(.sidePromoteQueued(threadId: current.threadId, text: trimmed))
    }

    // MARK: Events (from AppState.handle)

    func reset(mainSessionId: String?) {
        threads = []
        live = [:]
        errors = [:]
        busyThreadIds = []
        queuedThreadIds = []
        draft = nil
        draftingThreadId = nil
        selectedThreadId = nil
        isComposing = false
        composeAnchor = nil
        composeDraft = ""
        followUpDrafts = [:]
        selectionAnchor = nil
        self.mainSessionId = mainSessionId
    }

    func replace(mainSessionId: String?, threads list: [SideThread]) {
        self.mainSessionId = mainSessionId
        threads = Self.sorted(list)
        if let sel = selectedThreadId, !threads.contains(where: { $0.id == sel }) { selectedThreadId = nil }
        live = live.filter { id, _ in threads.contains { $0.id == id && $0.isRunning } }
    }

    func upsert(_ thread: SideThread) {
        // A snapshot of another chat (the engine switched meanwhile) is not ours.
        if let main = mainSessionId, let theirs = thread.mainSessionId, main != theirs { return }
        let previous = self.thread(thread.id)
        if let i = threads.firstIndex(where: { $0.id == thread.id }) { threads[i] = thread } else { threads.append(thread) }
        threads = Self.sorted(threads)
        if thread.status == .error, let message = thread.error, errors[thread.id] == nil {
            errors[thread.id] = EngineMessages.error(message: "Side question failed: \(message)", detail: EngineErrorDetail(code: "side_failed"))
        }
        guard !thread.isRunning else { return }
        let answered = live[thread.id] != nil && previous?.isRunning == true && draftingThreadId != thread.id
        live[thread.id] = nil
        if answered { onAnswerFinished?(thread) }
    }

    func remove(_ threadId: String) {
        threads.removeAll { $0.id == threadId }
        live[threadId] = nil
        errors[threadId] = nil
        followUpDrafts[threadId] = nil
        if selectedThreadId == threadId { selectedThreadId = nil }
        if draft?.threadId == threadId { draft = nil }
    }

    func appendDelta(_ threadId: String, text: String) {
        live[threadId, default: SideLiveAnswer()].text += text
    }

    func toolUse(_ threadId: String, id: String, name: String, input: JSONValue) {
        live[threadId, default: SideLiveAnswer()].toolCalls.append(SideToolCall(id: id, name: name, input: input))
    }

    func toolResult(_ threadId: String, toolUseId: String, isError: Bool, preview: String, denied: Bool) {
        guard var answer = live[threadId], let i = answer.toolCalls.firstIndex(where: { $0.id == toolUseId }) else { return }
        answer.toolCalls[i].isError = isError
        answer.toolCalls[i].preview = preview
        answer.toolCalls[i].denied = denied
        live[threadId] = answer
    }

    func turnEnded(_ threadId: String) {
        live[threadId]?.ended = true
    }

    func failed(_ threadId: String?, message: String) {
        errors[threadId ?? ""] = message
    }

    func unsolicitedDraft(threadId: String, text: String) {
        guard draft == nil else { return }
        draft = SidePromoteDraft(threadId: threadId, target: .message, text: text, anchor: thread(threadId)?.anchor)
    }

    // MARK: Helpers

    private func refusalText(_ error: Error) -> String {
        if let error = error as? EngineClientError {
            if error.refusalCode == "unknown_command" { isSupported = false }
            return error.userMessage
        }
        return error.localizedDescription
    }

    nonisolated static func sorted(_ list: [SideThread]) -> [SideThread] {
        list.sorted { $0.updatedAt > $1.updatedAt }
    }
}

extension AttentionEvent {
    /// A side question answered while its window was in the background.
    public static func sideAnswer(_ thread: SideThread) -> AttentionEvent {
        let failed = thread.status == .error
        return AttentionEvent(kind: .sideAnswer,
                              title: failed ? String(localized: "Side question failed", bundle: .module)
                                            : String(localized: "Side question answered", bundle: .module),
                              body: thread.title,
                              key: "side:\(thread.id)#\(thread.messages.count)")
    }
}

/// Finding what an anchor points at in the client's own data.
public enum SideAnchors {
    /// The lines of `diff` the anchor is about, for the thread header's preview: the hunk `hunkId`, else the hunk holding
    /// `line` (cut to `context` lines around it), else the first hunk; at most `limit` lines, hunk headers dropped.
    public static func previewLines(_ anchor: SideAnchor?, in diff: FileDiff?, context: Int = 4, limit: Int = 14) -> [DiffLine] {
        guard let diff, !diff.isBinary, !diff.hunks.isEmpty else { return [] }
        let hunk: DiffHunk
        var focus: Int?
        if let id = anchor?.hunkId, let h = diff.hunks.first(where: { $0.id == id }) {
            hunk = h
        } else if let a = anchor, a.line != nil, let h = diff.hunks.first(where: { SideThreadStore.anchor(a, isIn: $0) }) {
            hunk = h
            let side = a.side ?? .new
            focus = h.lines.firstIndex { $0.kind != .hunkHeader && (side == .old ? $0.oldNo : $0.newNo) == a.line }
        } else {
            hunk = diff.hunks[0]
        }
        let body = Array(hunk.lines.filter { $0.kind != .hunkHeader })
        guard body.count > limit else { return body }
        if let focus, let index = body.firstIndex(where: { $0.id == hunk.lines[focus].id }) {
            let start = max(0, min(index - context, body.count - limit))
            return Array(body[start..<min(body.count, start + limit)])
        }
        // A whole hunk: start at its first change.
        let first = body.firstIndex { $0.kind != .context } ?? 0
        let start = max(0, min(first - 1, body.count - limit))
        return Array(body[start..<min(body.count, start + limit)])
    }

    /// The tool call a permission card is asking about: the newest `tool_use` row before the card with the same tool (and,
    /// for Bash, the same command). nil when the transcript has none (older engines).
    public static func toolUseId(for request: PermissionRequest, in transcript: [ChatItem]) -> String? {
        let end = transcript.firstIndex { if case let .permission(_, r, _) = $0 { return r.requestId == request.requestId }; return false }
            ?? transcript.endIndex
        let command = request.input["command"]?.stringValue
        for item in transcript[..<end].reversed() {
            guard case let .toolUse(_, toolUseId, name, _, input, _) = item, name == request.toolName else { continue }
            if let command, input["command"]?.stringValue != command { continue }
            return toolUseId
        }
        return nil
    }

    /// The anchor of a transcript tool row: the call, plus its file when it is in the current review.
    public static func toolAnchor(toolUseId: String, file: String?, root: String?, changedPaths: [String]) -> SideAnchor {
        let relative = file.map { RepoPath.relative($0, root: root) }
        let path = relative.flatMap { changedPaths.contains($0) ? $0 : nil }
        return SideAnchor(path: path, toolUseId: toolUseId)
    }
}
