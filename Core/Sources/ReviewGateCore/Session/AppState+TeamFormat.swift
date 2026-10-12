import Foundation

// MARK: wave4c w4c-commit
// docs/PROTOCOL.md §41.1: the requests behind the commit sheet's "팀 형식" line and the PR sheet's draft / metadata.

public extension AppState {
    /// `commit_format`; nil without a project, on an older engine (`unknown_command`) or a failure — the sheet then shows
    /// what it showed before.
    func loadCommitFormat() async -> CommitFormatReply? {
        guard projectInfo != nil else { return nil }
        do {
            let reply = try await client.request(.commitFormat)
            guard case let .commitFormat(format) = reply else { return nil }
            return format
        } catch {
            appendLog("[debug] commit_format: \(error.localizedDescription)")
            return nil
        }
    }

    /// `pr_draft {base}`; nil as `loadCommitFormat`.
    func loadPRDraft(base: String) async -> PRDraftReply? {
        guard projectInfo != nil, !base.isEmpty else { return nil }
        do {
            let reply = try await client.request(.prDraft(base: base))
            guard case let .prDraft(draft) = reply else { return nil }
            return draft
        } catch {
            appendLog("[debug] pr_draft: \(error.localizedDescription)")
            return nil
        }
    }

    /// `pr_create` with the metadata (an engine before §41.1 ignores it); the URL, or nil with the code in `lastError`.
    func createPR(base: String, title: String?, body: String?, draft: Bool, meta: PRCreateMeta) async -> String? {
        guard projectInfo != nil else { return nil }
        do {
            let reply = try await client.request(.prCreateMeta(base: base, title: title, body: body, draft: draft ? true : nil, meta: meta))
            guard case let .prCreated(_, url, _) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            await settle()
            return url
        } catch {
            appendLog("[warn] createPR: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return nil
        }
    }

    /// The repository's PR metadata (the last PR's; `@me` for the first).
    var prMeta: PRMetaText {
        guard let root = flowSettingsRoot else { return .default }
        return AppSettings.prMeta(root: root, defaults: settingsDefaults)
    }

    func setPRMeta(_ meta: PRMetaText) {
        guard let root = flowSettingsRoot else { return }
        AppSettings.setPRMeta(meta, root: root, defaults: settingsDefaults)
    }
}
