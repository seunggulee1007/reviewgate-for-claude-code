import Foundation

// MARK: r1-composer M12 — the message being typed survives the PRs tab and an engine restart
//
// docs/PROTOCOL.md §38.1 "A draft per chat": the window keeps the composer (the chat column is made again when the PRs tab
// or an engine that stopped took it away), and each chat's draft — its text and @ mentions — is saved on disk as it is
// typed, so an app restart finds it too. Images stay in memory.

/// A chat's draft as saved on disk (`AppSettings.Key.composerDrafts`).
public struct SavedComposerDraft: Codable, Sendable, Equatable {
    public var text: String
    public var mentions: [String]
    public var savedAt: Date

    public init(text: String, mentions: [String], savedAt: Date) {
        self.text = text
        self.mentions = mentions
        self.savedAt = savedAt
    }
}

public extension AppSettings.Key {
    /// r1-composer M12: JSON `[draft key: SavedComposerDraft]` — the key is the chat's id (chat ids are unique), or
    /// `project:<root>` for an engine without chats.
    static let composerDrafts = "composerDrafts"
}

public extension AppSettings {
    /// At most this many drafts are kept; the oldest saved go first.
    static let maxSavedComposerDrafts = 50
    /// A longer draft is not saved (it stays in the window's memory).
    static let maxSavedComposerDraftLength = 200_000

    /// The draft saved under `key` (text and mentions), nil when there is none.
    static func savedComposerDraft(key: String, defaults: UserDefaults = .standard) -> ChatDraft? {
        guard let saved = savedComposerDrafts(defaults: defaults)[key] else { return nil }
        return ChatDraft(text: saved.text, mentions: saved.mentions)
    }

    /// Saves `draft`'s text and mentions under `key`; an empty one (or one past `maxSavedComposerDraftLength`) removes it.
    static func saveComposerDraft(_ draft: ChatDraft, key: String, now: Date = Date(), defaults: UserDefaults = .standard) {
        var all = savedComposerDrafts(defaults: defaults)
        let empty = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.mentions.isEmpty
        if empty || draft.text.count > maxSavedComposerDraftLength {
            guard all.removeValue(forKey: key) != nil else { return }
        } else {
            let saved = SavedComposerDraft(text: draft.text, mentions: draft.mentions, savedAt: now)
            guard all[key].map({ $0.text != saved.text || $0.mentions != saved.mentions }) ?? true else { return }
            all[key] = saved
            if all.count > maxSavedComposerDrafts {
                for old in all.sorted(by: { $0.value.savedAt < $1.value.savedAt }).prefix(all.count - maxSavedComposerDrafts) {
                    all[old.key] = nil
                }
            }
        }
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.composerDrafts) }
    }

    private static func savedComposerDrafts(defaults: UserDefaults) -> [String: SavedComposerDraft] {
        guard let data = defaults.data(forKey: Key.composerDrafts) else { return [:] }
        return (try? JSONDecoder().decode([String: SavedComposerDraft].self, from: data)) ?? [:]
    }
}

public extension AppState {
    /// The key chat `id`'s draft is saved under: the chat's id, else this project (an engine without chats); nil without
    /// a project.
    func composerDraftKey(for id: String?) -> String? {
        if let id, !id.isEmpty { return id }
        return projectURL.map { "project:" + AppSettings.projectKey($0) }
    }

    /// M12: the draft saved on disk for chat `id` (text and mentions).
    func savedDraft(for id: String?) -> ChatDraft? {
        composerDraftKey(for: id).flatMap { AppSettings.savedComposerDraft(key: $0, defaults: settingsDefaults) }
    }

    /// M12: saves `draft` for chat `id` (an empty one removes what was saved).
    func saveDraft(_ draft: ChatDraft, for id: String?) {
        guard let key = composerDraftKey(for: id) else { return }
        AppSettings.saveComposerDraft(draft, key: key, defaults: settingsDefaults)
    }

    /// M12: the composer moves from chat `previous` to `current`. `typed` (what the box holds) is kept for `previous`, in
    /// memory with its images (polish-12) and on disk, and the draft to show for `current` comes back: the one kept in
    /// memory, else the one saved on disk, else an empty box. Nil keeps what is typed — the same chat, a chat that went
    /// away (the project closed, the engine stopped), or the first chat an engine reports (what is typed then belongs to
    /// it; an empty box gets its saved draft).
    func moveDraft(_ typed: ChatDraft, from previous: String?, to current: String?) -> ChatDraft? {
        guard previous != current, let current else { return nil }
        guard let previous else {
            guard typed.isEmpty else { return nil }
            let shown = draftToShow(for: current)
            return shown.isEmpty ? nil : shown
        }
        stashDraft(typed, for: previous)
        saveDraft(typed, for: previous)
        return draftToShow(for: current)
    }

    /// The draft for chat `id`: kept in memory (taken), else saved on disk, else empty.
    private func draftToShow(for id: String) -> ChatDraft {
        let kept = takeDraft(for: id)
        return kept.isEmpty ? (savedDraft(for: id) ?? ChatDraft()) : kept
    }
}
