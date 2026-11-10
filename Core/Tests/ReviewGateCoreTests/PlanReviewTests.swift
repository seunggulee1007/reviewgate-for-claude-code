import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1: plans you can review and follow (wire + client rules).
@Suite struct PlanReviewTests {
    private func event(_ json: String) throws -> EngineEvent { try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8)) }

    @Test func keepPlanningCollectsTheStepNotesThenTheGeneralNote() {
        let steps = [PlanStepBrief(index: 0, text: "Update FooService.java"), PlanStepBrief(index: 1, text: "Add the mapper"),
                     PlanStepBrief(index: 2, text: String(repeating: "x", count: 80))]
        #expect(PlanReviewNotes.message(steps: steps, notes: [2: "  drop it ", 1: "also FooMapper.xml", 0: "  "], general: "and the tests")
            == "Step 2 (Add the mapper): also FooMapper.xml\nStep 3 (\(String(repeating: "x", count: 59))…): drop it\nand the tests")
        #expect(PlanReviewNotes.message(steps: steps, notes: [:], general: " only this ") == "only this")
        #expect(PlanReviewNotes.message(steps: steps, notes: [0: " "], general: "") == nil)
        #expect(PlanReviewNotes.noteCount([0: "a", 1: " ", 2: "b"]) == 2)
    }

    @Test func pendingPlanStepsAndPlanSourceDecodeLeniently() throws {
        let plan = try JSONDecoder().decode(PendingPlan.self, from: Data(#"{"path":null,"plan":"1. a","at":"x","steps":[{"index":0,"text":"a"},{"bad":1}]}"#.utf8))
        #expect(plan.steps == [PlanStepBrief(index: 0, text: "a"), PlanStepBrief(index: 0, text: "")])
        let old = try JSONDecoder().decode(PendingPlan.self, from: Data(#"{"path":"/p.md","plan":"x","at":"y"}"#.utf8))
        #expect(old.steps == nil)
        let src = try JSONDecoder().decode(PlanSourceState.self, from: Data(#"{"kind":"file","path":".omc/plans/a.md","chosen":true,"candidates":[".omc/plans/a.md"]}"#.utf8))
        #expect(src == PlanSourceState(kind: .file, path: ".omc/plans/a.md", chosen: true, candidates: [".omc/plans/a.md"]))
        let unknown = try JSONDecoder().decode(PlanSourceState.self, from: Data(#"{"kind":"someday"}"#.utf8))
        #expect(unknown.kind == nil && unknown.candidates.isEmpty)
    }

    @Test func turnSummaryPlanSourceAndItsWords() throws {
        let plan = try JSONDecoder().decode(TurnSummary.Plan.self, from: Data(#"{"path":null,"steps":[{"index":0,"text":"Fix it","files":["a.ts"]}],"unplannedFiles":["b.ts"],"source":"request","title":"Fix it."}"#.utf8))
        #expect(plan.source == .request && plan.title == "Fix it.")
        #expect(PlanSourceText.title(plan) == "Request scope")
        #expect(PlanSourceText.unplannedTitle(plan) == "Outside the request")
        #expect(PlanSourceText.unplannedChip(1, plan) == "1 outside the request")
        let approved = TurnSummary.Plan(path: "/p.md", steps: [], unplannedFiles: [])
        #expect(PlanSourceText.title(approved) == "Plan vs actual")
        #expect(PlanSourceText.unplannedTitle(approved) == "Unplanned changes")
        #expect(PlanSourceText.title(TurnSummary.Plan(source: .todos)) == "Against Claude's to-do list")
    }

    @Test func planApprovedWithIntoIsItsOwnEventAndWithoutIsAsBefore() throws {
        guard case let .planApprovedInto(info) = try event(#"{"type":"plan_approved","mode":"plan","path":"/p.md","into":"workbench","target":"/wt/feat-db"}"#) else {
            Issue.record("not planApprovedInto"); return
        }
        #expect(info == PlanApprovedInfo(mode: .plan, path: "/p.md", into: .workbench, target: "/wt/feat-db"))
        #expect(PlanHandoffText.line(info) == "Plan approved — sent to the workbench feat-db to implement there")
        guard case .planApproved(.default, "/p.md") = try event(#"{"type":"plan_approved","mode":"default","path":"/p.md","into":"later"}"#) else {
            Issue.record("an unknown into is the plain event"); return
        }
        guard case .planApproved(.acceptEdits, nil) = try event(#"{"type":"plan_approved","mode":"acceptEdits","path":null}"#) else {
            Issue.record("not planApproved"); return
        }
    }

    @Test func commandsEncodeIntoAndFollow() throws {
        func json(_ c: EngineCommand) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any])
        }
        let wb = try json(.planImplement(mode: .acceptEdits, into: .workbench, path: "/wt/x"))
        #expect(wb["type"] as? String == "plan_response" && wb["approve"] as? Bool == true)
        #expect(wb["mode"] as? String == "acceptEdits" && wb["into"] as? String == "workbench" && wb["path"] as? String == "/wt/x")
        let chat = try json(.planImplement(mode: .default, into: .newChat, path: nil))
        #expect(chat["into"] as? String == "new_chat" && chat["path"] == nil)
        let clear = try json(.planFollow(path: nil))
        #expect(clear["type"] as? String == "plan_follow" && clear["path"] is NSNull)
        #expect(try json(.planFollow(path: "docs/a-plan.md"))["path"] as? String == "docs/a-plan.md")
    }

    @Test func aPlanWorkbenchBranchIsNamedAfterItsFile() {
        #expect(PlanBranchName.suggest(planPath: "/Users/a/.claude/plans/DB Migration_plan.md") == "plan/db-migration_plan")
        #expect(PlanBranchName.suggest(planPath: "/x/계획.md") == "")
        #expect(PlanBranchName.suggest(planPath: nil) == "")
    }
}
