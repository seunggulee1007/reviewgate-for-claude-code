import Foundation

// MARK: wave4c w4c-commit
// docs/PROTOCOL.md §41.1: the requests behind the commit sheet's "팀 형식" line and the PR sheet's draft / metadata.

/// §51: why Claude could not fill the PR sheet, in the user's words.
public struct PRAiDraftFailure: Error, Equatable {
    public let text: String
}

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

    /// §51 `pr_ai_draft`: Claude's title and description for the PR sheet from the branch since `base` and what the sheet
    /// holds (`title` / `body`); a failure in the user's words (`FlowText.refusal`). Nothing is pushed or created.
    func writePRDraft(base: String, title: String, body: String) async -> Result<PRAiDraftReply, PRAiDraftFailure> {
        guard !base.isEmpty else { return .failure(PRAiDraftFailure(text: FlowText.refusal(code: "empty_base", detail: "") ?? "")) }
        do {
            let reply = try await reply(.prAiDraft(base: base, title: title, body: body))
            guard case let .prAiDraft(draft) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return .success(draft)
        } catch {
            appendLog("[warn] pr_ai_draft: \(error.localizedDescription)")
            return .failure(PRAiDraftFailure(text: FlowText.refusal(error)))
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
