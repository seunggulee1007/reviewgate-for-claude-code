import Foundation

// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts": [이전 대화 더 보기] (`transcript_page`, the older
// rows go above the shown ones and stay dimmed like restored rows), the chat-history search over the messages
// (`transcript_search`) and its jump to the matched row. Pure parts: TranscriptHistory.swift.

extension AppState {
    /// `transcript_restore` was applied: where its rows start (nil: an older engine or an empty chat — nothing to page).
    func pagingRestored(_ items: [TranscriptItem], paging: TranscriptRestorePaging?) {
        guard let paging, !items.isEmpty else {
            transcriptPaging = TranscriptPaging()
            resolveJump()
            return
        }
        var next = TranscriptPaging(sessionId: paging.sessionId, start: paging.start, oldestAt: items.first?.at)
        next.rowIDs = TranscriptHistory.rowIDs(items: items, start: paging.start, chat: transcript)
        transcriptPaging = next
        resolveJump()
    }

    /// [이전 대화 더 보기]: the `limit` rows before the oldest shown one, put above it. false: nothing came (or a refusal,
    /// then `transcriptPaging.error` says so).
    @discardableResult
    public func loadEarlierMessages(limit: Int = TranscriptHistory.pageRows) async -> Bool {
        let paging = transcriptPaging
        guard !paging.loading, let sessionId = paging.sessionId, let start = paging.start, start > 0 else { return false }
        transcriptPaging.loading = true
        transcriptPaging.error = nil
        do {
            let reply = try await reply(.transcriptPage(sessionId: sessionId, before: start, beforeAt: paging.oldestAt, limit: limit))
            guard case let .transcriptPage(page) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            // Another chat came meanwhile: these rows are not its.
            // (`replaceTranscriptOnRestore`: a chat switch is on its way — its restore replaces the rows, these would go.)
            guard transcriptPaging.sessionId == sessionId, page.sessionId == sessionId, !replaceTranscriptOnRestore else {
                transcriptPaging.loading = false
                return false
            }
            let before = transcript.count
            restoreTranscript(page.items)
            let added = transcript.count - before
            transcriptPaging.rowIDs.merge(TranscriptHistory.rowIDs(items: page.items, start: page.start, chat: Array(transcript.prefix(added)))) { kept, _ in kept }
            transcriptPaging.start = page.start
            if let first = page.items.first?.at { transcriptPaging.oldestAt = first }
            transcriptPaging.prepended += added
            transcriptPaging.loading = false
            resolveJump()
            return added > 0
        } catch EngineClientError.refused(let message, let code, _) {
            transcriptPaging.loading = false
            transcriptPaging.error = code == "unknown_command" || message.hasPrefix("unknown command")
                ? String(localized: "This engine cannot load earlier messages", bundle: .module)
                : String(localized: "Could not load earlier messages", bundle: .module)
            return false
        } catch {
            transcriptPaging.loading = false
            transcriptPaging.error = String(localized: "Could not load earlier messages", bundle: .module)
            return false
        }
    }

    /// `transcript_search` → per chat its newest matching message; nil when the engine cannot search messages (before
    /// §38.3) or failed — the history then searches titles only, as before.
    public func searchMessages(_ query: String) async -> [TranscriptSearchMatch]? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        do {
            // MARK: wave4c w4c-review — §41.3: three matches per chat (an older engine ignores `perChat`: one, as before)
            guard case let .transcriptSearch(found) = try await reply(.transcriptSearchPerChat(query: q, perChat: ReviewLeftovers.searchPerChat)) else { return nil }
            return found.matches
        } catch {
            return nil
        }
    }

    /// Scroll to a search match once its chat's row is shown (opening the chat is the caller's; the rows above it are
    /// loaded first when it is further up).
    public func jumpToMessage(sessionId: String, row: Int) {
        transcriptJump = TranscriptJump(sessionId: sessionId, row: row)
        resolveJump()
    }

    func resolveJump() {
        switch TranscriptHistory.step(transcriptJump, paging: transcriptPaging) {
        case .wait:
            return
        case let .land(id):
            transcriptJump = nil
            transcriptJumpItem = TranscriptJumpItem(id: id, tick: (transcriptJumpItem?.tick ?? 0) + 1)
        case let .load(limit):
            Task { [weak self] in
                guard let self else { return }
                if !(await self.loadEarlierMessages(limit: limit)) { self.transcriptJump = nil }
            }
        case .done:
            transcriptJump = nil
        }
    }
}
