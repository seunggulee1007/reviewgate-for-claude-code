import Foundation

/// What a `rewind` came to (§26), for the sheet / the edit-and-retry editor.
public enum RewindOutcome: Sendable, Equatable {
    case rewound(restoredFiles: [String])
    /// `file_changed_since_review`: the window's force-confirm alert asks (`forceRejectRequest`).
    case needsConfirmation
    case refused(String)
}

// §23–27 actions: @-mention search, image thumbnails, model / effort, rewind, compact.
public extension AppState {
    // MARK: §23 mentions

    /// `list_files {query}`; [] when it fails (the popover then shows nothing rather than an error).
    func listFiles(query: String, limit: Int? = nil) async -> [FileItem] {
        guard projectInfo != nil else { return [] }
        guard case let .files(_, _, items)? = try? await reply(.listFiles(query: query, limit: limit)) else { return [] }
        return items
    }

    // MARK: §24 images

    /// The bytes of an image a transcript row references: the cache, else one `attachment_get` (shared by all rows).
    func attachment(hash: String) async -> Data? {
        if let data = attachmentData[hash] { return data }
        guard !missingAttachments.contains(hash) else { return nil }
        if let running = attachmentLoads[hash] { return await running.value }
        let task = Task<Data?, Never> { @MainActor [weak self] in
            guard let self else { return nil }
            defer { self.attachmentLoads[hash] = nil }
            do {
                guard case let .attachment(_, _, _, base64) = try await self.reply(.attachmentGet(hash: hash)),
                      let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
                self.attachmentData[hash] = data
                return data
            } catch let error as EngineClientError where error.refusalCode == "unknown_attachment" {
                self.missingAttachments.insert(hash)
                return nil
            } catch {
                return nil
            }
        }
        attachmentLoads[hash] = task
        return await task.value
    }

    /// What this client sends is known without a round trip: its thumbnails show at once.
    func seedAttachments(_ images: [ComposerImage]) {
        for image in images { attachmentData[image.hash] = image.data }
    }

    /// The images of a transcript row as composer images (edit & retry); refs whose bytes cannot be loaded are skipped.
    func composerImages(for refs: [AttachmentRef]) async -> [ComposerImage] {
        var out: [ComposerImage] = []
        for (i, ref) in refs.enumerated() {
            guard let data = await attachment(hash: ref.hash), let type = ImageMediaType(magic: data) else { continue }
            out.append(ComposerImage(mediaType: type, data: data, name: "image-\(i + 1).\(type.fileExtension)"))
        }
        return out
    }

    // MARK: §25 model and effort

    var availableModels: [ModelOption] { sessionInfo.availableModels }
    var selectedModel: String? { sessionInfo.selectedModel }
    var effort: EffortLevel? { sessionInfo.effort }

    /// The option the session runs with: the chosen value, else the one whose id / resolved id the CLI reports.
    var currentModelOption: ModelOption? {
        let models = availableModels
        if let chosen = selectedModel, let hit = models.first(where: { $0.value == chosen }) { return hit }
        guard let live = model else { return nil }
        return models.first { $0.value == live || $0.resolvedModel == live }
    }

    /// The HUD chip's text: the option's display name (else the CLI's id, else "Default model") plus the effort.
    var modelChipText: String {
        let name = currentModelOption?.displayName ?? model ?? selectedModel ?? String(localized: "Default model", bundle: .module)
        guard let effort else { return name }
        return "\(name) · \(effort.displayName)"
    }

    /// `set_model` right away — the CLI applies it from its next request ("다음 요청부터 적용"). The snapshot mirrors it;
    /// the choice is shown optimistically meanwhile. Returns the refusal text, nil on success.
    @discardableResult
    func setModel(_ value: String, effort update: EffortUpdate = .unchanged) async -> String? {
        let before = state.session
        state.session.selectedModel = value == "default" ? nil : value
        switch update {
        case .unchanged: break
        case .modelDefault: state.session.effort = nil
        case let .level(level): state.session.effort = level
        }
        do {
            try await request(.setModel(model: value, effort: update))
            return nil
        } catch {
            state.session.selectedModel = before.selectedModel
            state.session.effort = before.effort
            let text = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
            fail(text, fatal: false)
            return text
        }
    }

    /// Effort only: the current model again with the new level.
    @discardableResult
    func setEffort(_ level: EffortLevel?) async -> String? {
        let value = selectedModel ?? currentModelOption?.value ?? "default"
        return await setModel(value, effort: level.map(EffortUpdate.level) ?? .modelDefault)
    }

    // MARK: §26 checkpoints and rewind

    var checkpoints: [TurnCheckpoint] { sessionInfo.checkpoints }

    func checkpoint(forTurn turn: Int) -> TurnCheckpoint? {
        guard turn > 0 else { return nil }
        return sessionInfo.checkpoints.first { $0.turn == turn }
    }

    /// Why a rewind cannot start right now (busy, or a review that has to be finished first for the conversation);
    /// nil = go. Mirrors the engine's `session_busy` / `review_pending` / `notes_pending` guards.
    func rewindBlocker(mode: RewindMode) -> String? {
        switch gatePhase {
        case .starting, .running, .collecting, .reverting:
            return EngineMessages.refusal(error: "session_busy")
        case .idle, .reviewing, .collectFailed:
            break
        }
        if mode != .files, !changesRequestedFiles.isEmpty || !unsentNotes.isEmpty {   // wave2 mac-flow (§34.4): sent notes never block
            return Self.finishReviewFirstText
        }
        return nil
    }

    /// §35.11: the toast after a file rewind that left files nothing of Claude's changed as they were (both clients' key).
    nonisolated static func keptOutsideText(_ count: Int) -> String {
        String(localized: "\(count) file(s) changed outside the app stay as they are", bundle: .module)
    }

    nonisolated static var finishReviewFirstText: String {
        String(localized: "Finish the review first", bundle: .module)
    }

    /// "이 시점으로 되돌리기" / "수정해서 다시 보내기": `rewind`; with `editText` the edited message goes out as the new turn.
    @discardableResult
    func rewind(toTurn turn: Int, mode: RewindMode, editText: String? = nil, mentions: [String] = [],
                images: [ComposerImage] = []) async -> RewindOutcome {
        let text = editText?.trimmingCharacters(in: .whitespacesAndNewlines)
        let edit = (text?.isEmpty ?? true) ? nil : text
        if edit != nil { seedAttachments(images) }
        return await sendRewind(.rewind(toTurn: turn, mode: mode, editText: edit, mentions: edit == nil ? [] : mentions,
                                        attachments: edit == nil ? [] : images.map(\.sendAttachment)))
    }

    internal func sendRewind(_ command: EngineCommand) async -> RewindOutcome {
        guard case let .rewind(_, mode, editText, _, _, _) = command else { return .refused("") }
        isRewinding = true
        defer { isRewinding = false }
        // A conversation rewind switches chats: the engine's `transcript_restore` then replaces the rows.
        if mode != .files { replaceTranscriptOnRestore = true }
        do {
            let event = try await reply(command)
            if let editText { recordPrompt(editText) }
            reloadReviewAfterRewind()
            await settle()
            guard case let .rewound(_, _, _, restored, _, kept) = event else { return .rewound(restoredFiles: []) }
            // §35.11: what nothing of Claude's changed in those turns (an IntelliJ save, another session) stayed as it is.
            if !kept.isEmpty { permissionNotice = PermissionNotice(text: Self.keptOutsideText(kept.count)) }
            return .rewound(restoredFiles: restored)
        } catch let error as EngineClientError {
            replaceTranscriptOnRestore = false
            guard case let .refused(message, code, paths) = error else { return .refused(error.userMessage) }
            switch code ?? EngineMessages.codeWord(message) {
            case "file_changed_since_review":
                forceRejectRequest = ForceRejectRequest(command: command, paths: paths.isEmpty ? Self.pathsOfRefusal(message) : paths)
                return .needsConfirmation
            case "review_pending", "notes_pending":
                return .refused(Self.finishReviewFirstText)
            default:
                return .refused(error.userMessage)
            }
        } catch {
            replaceTranscriptOnRestore = false
            return .refused(error.localizedDescription)
        }
    }

    // MARK: §27 context

    /// `compact {focus}` — the CLI's `/compact` as a turn. Returns the refusal text, nil when it went out.
    @discardableResult
    func compact(focus: String?) async -> String? {
        let trimmed = focus?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await request(.compact(focus: (trimmed?.isEmpty ?? true) ? nil : trimmed))
            contextWarning = nil
            return nil
        } catch {
            return (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    func dismissContextWarning() {
        contextWarning = nil
    }

    /// The context use as a fraction of the window; nil when the window is unknown.
    var contextFraction: Double? {
        guard let window = hud.contextWindow, window > 0 else { return nil }
        return min(Double(hud.contextTokens) / Double(window), 1)
    }
}

public extension EngineMessages {
    /// "컨텍스트 82.3% 사용 중".
    static func contextWarningText(_ warning: ContextWarning) -> String {
        let percent = String(format: "%.1f", warning.percent)
        return String(localized: "The context is \(percent)% full", bundle: .module)
    }
}

/// §27 thresholds of the HUD's context meter.
public enum ContextMeter {
    public enum Level: Sendable, Equatable { case normal, warning, critical }

    public static func level(_ fraction: Double) -> Level {
        if fraction >= 0.95 { return .critical }
        if fraction >= 0.80 { return .warning }
        return .normal
    }
}
