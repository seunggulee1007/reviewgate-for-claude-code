import Foundation

// MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 plans you can review and follow

extension AppState {
    /// The engine sends the plan's steps (§42.1): per-step notes, [새 채팅에서 구현] and [새 워크벤치에서 구현] work. An older
    /// engine would read `into` as a plain approve (implementing here), so those stay off with their reason.
    public var planReviewSupported: Bool { pendingPlan?.steps != nil }

    /// Why [새 채팅에서 구현] / [새 워크벤치에서 구현] cannot be used; nil = they can.
    public var planHandoffBlocker: String? {
        if !planReviewSupported { return String(localized: "Needs the engine of this app version — reopen the project", bundle: .module) }
        if isPlanLocked { return String(localized: "Claude is working — the plan waits until the turn ends", bundle: .module) }
        return nil
    }

    /// [계속 계획] with per-step notes: one message ("단계 N (…): …" lines, then the general note), else the engine's own text.
    public func keepPlanning(steps: [PlanStepBrief], notes: [Int: String], general: String) {
        keepPlanning(message: PlanReviewNotes.message(steps: steps, notes: notes, general: general))
    }

    /// [새 채팅에서 구현]: `plan_response {approve, mode, into: "new_chat"}` — the card's lock and refusal rules as `approvePlan`.
    public func approvePlanInNewChat(mode: PermissionMode = .default) {
        guard planReviewSupported else { return }
        answerPlan(.planImplement(mode: mode, into: .newChat, path: nil))
    }

    /// [새 워크벤치에서 구현], once the workbench exists: the plan goes there (its window implements it when it opens). nil when it
    /// went, else the refusal in words (the card stays).
    public func handPlanToWorkbench(mode: PermissionMode = .default, path: String) async -> String? {
        guard planReviewSupported else { return planHandoffBlocker }
        do {
            try await request(.planImplement(mode: mode, into: .workbench, path: path))
            await settle()
            return nil
        } catch let error as EngineClientError {
            appendLog("[warn] plan_response(workbench): \(error.localizedDescription)")
            return error.userMessage
        } catch {
            return error.localizedDescription
        }
    }

    /// What the next turn summary's "plan vs actual" follows (nil on older engines / without a chat).
    public var planSource: PlanSourceState? { sessionInfo.planSource }

    /// `plan_follow {path}`: the plan file this chat follows (nil: the automatic sources).
    public func followPlan(path: String?) { fire(.planFollow(path: path)) }

    /// `plan_approved {into}`: the card is answered; the chat that implements takes the mode, the plan row says where it went.
    func applyPlanApproved(_ info: PlanApprovedInfo) {
        state.session.pendingPlan = nil
        dismissPlanRefusal()
        if info.target == nil { state.session.permissionMode = info.mode }
        transcript.append(.plan(id: UUID(), path: info.path, plan: PlanHandoffText.line(info), approvedMode: info.mode))
    }
}
