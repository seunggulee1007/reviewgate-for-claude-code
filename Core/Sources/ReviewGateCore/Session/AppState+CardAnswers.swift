import Foundation

// MARK: r2-chats-cards — the answers a card gives beyond allow: how a permission card is denied (M25, docs/PROTOCOL.md
// §33.10) and a question card's notes (M08b, §36.x `annotations`). Electron: store `denyPermission`, QuestionCard.tsx.

/// How a permission card is denied (§33.10).
public enum PermissionDenial: Sendable, Equatable, Hashable {
    /// "거절": the terminal's "No" — Claude stops and waits for the user (the engine's words).
    case stop
    /// "건너뛰고 계속": this call does not run; Claude goes on with the rest of the task.
    case skip
    /// "거절하고 멈추기": the turn stops too, as Stop does — a subagent's card only denies (the others keep running).
    case interrupt
    /// "거절하고 지시…", or the send key with text while the card waits (M24): Claude follows it in the same turn.
    case instruction(String)
}

extension AppState {
    /// Denies the card of `requestId` — exactly that request, wherever it sits in the queue (§33.1). A request that is no
    /// longer open sends nothing and says so.
    public func denyPermission(requestId: String, _ denial: PermissionDenial = .stop) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        var how = denial
        if case let .instruction(text) = denial, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { how = .stop }
        answerPermission(request, allow: false, updatedInput: nil, command: .permissionDeny(requestId: requestId, denial: how))
    }

    /// M24: the card the composer's text answers while it waits — the shortcut target (the oldest open request that is not a
    /// question), only while the running chat is shown.
    public var cardAnsweredByDraft: PermissionRequest? {
        viewingChat == nil ? shortcutPermission : nil
    }

    /// M08b: answers the `AskUserQuestion` card of `requestId` with what `draft` holds — the answers and, per question, the
    /// user's notes (`updatedInput.annotations`, with the chosen option's preview when the question had previews).
    public func answerQuestions(requestId: String, draft: QuestionDraft) {
        guard let request = openPermissions.first(where: { $0.requestId == requestId }) else {
            permissionNotice = .alreadyHandled
            return
        }
        guard request.toolName == AskUserQuestions.toolName, let questions = AskUserQuestions(request: request) else { return }
        let updated = AskUserQuestions.updatedInput(for: request, answers: draft.answers(questions), annotations: draft.annotations(questions))
        answerPermission(request, allow: true, updatedInput: updated,
                         command: .permissionResponse(requestId: requestId, allow: true, updatedInput: updated))
    }
}

// MARK: M08b — a question's notes

extension AskUserQuestions {
    /// What `updatedInput.annotations` holds for one question (the CLI's schema): the user's notes on their answer, and the
    /// preview of the option chosen when the question showed previews.
    public struct Annotation: Sendable, Equatable {
        public var notes: String?
        public var preview: String?

        public init(notes: String? = nil, preview: String? = nil) {
            self.notes = notes
            self.preview = preview
        }

        var json: JSONValue {
            var o: [String: JSONValue] = [:]
            if let notes { o["notes"] = .string(notes) }
            if let preview { o["preview"] = .string(preview) }
            return .object(o)
        }
    }

    /// The `updatedInput` for the permission reply: the original `questions` passed through, `answers`, and — when there are
    /// any — `annotations` keyed by question text.
    public static func updatedInput(for request: PermissionRequest, answers: [String: String], annotations: [String: Annotation]) -> JSONValue {
        var o: [String: JSONValue] = [
            "questions": request.input["questions"] ?? .array([]),
            "answers": .object(answers.mapValues(JSONValue.string)),
        ]
        if !annotations.isEmpty { o["annotations"] = .object(annotations.mapValues(\.json)) }
        return .object(o)
    }
}

extension QuestionDraft {
    /// M08b: one annotation per answered question that has notes or a chosen option's preview (keyed by question text).
    public func annotations(_ questions: AskUserQuestions) -> [String: AskUserQuestions.Annotation] {
        var out: [String: AskUserQuestions.Annotation] = [:]
        for question in questions.questions where answer(for: question) != nil {
            let key = question.question
            let note = notes[key]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = question.options.filter { selected[key, default: []].contains($0.label) }
            let preview = chosen.count == 1 ? chosen[0].preview : nil
            guard !(note ?? "").isEmpty || preview != nil else { continue }
            out[key] = AskUserQuestions.Annotation(notes: (note ?? "").isEmpty ? nil : note, preview: preview)
        }
        return out
    }
}
