import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: the basis menu of "plan vs actual" (Electron planBasis.test.ts).
@MainActor @Suite struct PlanBasisTests {
    private let home = "/Users/dev"
    private let candidates = [".omc/plans/db-migration.md", "docs/plans/batch-plan.md", "/Users/dev/.claude/plans/quiet-otter.md"]

    @Test func anOlderEngineHasNoMenu() {
        #expect(PlanBasis.menu(nil, home: home) == nil)
    }

    @Test func automaticIsCheckedAndSaysWhatItFollows() throws {
        let named = try #require(PlanBasis.menu(PlanSourceState(kind: .file, path: ".omc/plans/db-migration.md", candidates: candidates), home: home))
        #expect(named.label == "Basis: Automatic · db-migration.md")
        #expect(named.items.map(\.path) == [nil] + candidates)
        #expect(named.items.map(\.checked) == [true, false, false, false])
        #expect(named.chosenPath == nil)
        #expect(named.blocker == nil)
        #expect(named.note == "The next turn summary compares against it")
        #expect(named.items.map(\.title) == ["Choose automatically", "db-migration.md  ·  .omc/plans", "batch-plan.md  ·  docs/plans", "quiet-otter.md  ·  ~/.claude/plans"])
        #expect(named.items[3].help == "/Users/dev/.claude/plans/quiet-otter.md")

        #expect(PlanBasis.menu(PlanSourceState(kind: .todos, candidates: candidates), home: home)?.label == "Basis: Automatic · Claude's to-do list")
        #expect(PlanBasis.menu(PlanSourceState(kind: .message, candidates: candidates), home: home)?.label == "Basis: Automatic · Your first message's list")
        #expect(PlanBasis.menu(PlanSourceState(kind: .request, candidates: candidates), home: home)?.label == "Basis: Automatic · Request scope")
        #expect(PlanBasis.menu(PlanSourceState(kind: nil, candidates: candidates), home: home)?.label == "Basis: Automatic")
    }

    @Test func aChosenFileIsCheckedEvenWhenItIsNoCandidate() throws {
        let chosen = try #require(PlanBasis.menu(PlanSourceState(kind: .file, path: "docs/plans/batch-plan.md", chosen: true, candidates: candidates), home: home))
        #expect(chosen.label == "Basis: batch-plan.md")
        #expect(chosen.items.map(\.checked) == [false, false, true, false])
        #expect(chosen.chosenPath == "docs/plans/batch-plan.md")

        let outside = try #require(PlanBasis.menu(PlanSourceState(kind: .file, path: "/work/notes/plan.md", chosen: true, candidates: candidates), home: home))
        #expect(outside.items.map(\.path) == [nil, "/work/notes/plan.md"] + candidates)
        #expect(outside.items[1].checked && outside.items[1].title == "plan.md  ·  /work/notes")
    }

    @Test func anApprovedPlanDecidesSoNothingCanBeChosen() throws {
        let menu = try #require(PlanBasis.menu(PlanSourceState(kind: .approved, path: "/Users/dev/.claude/plans/quiet-otter.md", candidates: candidates), home: home))
        #expect(menu.label == "Basis: Approved plan")
        #expect(menu.blocker == "This chat follows the plan you approved in ReviewGate")
        #expect(menu.items.allSatisfy { !$0.checked })
    }

    @Test func withoutPlanFilesTheMenuSaysWhereTheyComeFrom() throws {
        let menu = try #require(PlanBasis.menu(PlanSourceState(kind: .todos, candidates: []), home: home))
        #expect(menu.items.count == 1 && menu.items[0].checked)
        #expect(menu.note == "No plan files yet — .omc/plans, .claude/plans and plan files under docs/ show up here")
        #expect(PlanBasis.fileTitle("plan.md", home: home) == "plan.md")
    }

    @Test func choosingSendsPlanFollowOnlyForAnotherBasis() async {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PlanBasisTests.\(UUID().uuidString)")!)
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        await app.choosePlanBasis(path: ".omc/plans/db-migration.md")
        #expect(sent.isEmpty)   // no planSource: an older engine
        app.state.session.planSource = PlanSourceState(kind: .todos, candidates: candidates)
        await app.choosePlanBasis(path: nil)   // already automatic
        await app.choosePlanBasis(path: ".omc/plans/db-migration.md")
        #expect(sent == [.planFollow(path: ".omc/plans/db-migration.md")])
        app.state.session.planSource = PlanSourceState(kind: .file, path: ".omc/plans/db-migration.md", chosen: true, candidates: candidates)
        await app.choosePlanBasis(path: nil)
        #expect(sent.last == .planFollow(path: nil))
        app.state.session.planSource = PlanSourceState(kind: .approved, candidates: candidates)
        await app.choosePlanBasis(path: "docs/plans/batch-plan.md")
        #expect(sent.count == 2)   // an approved plan decides
    }

    @Test func aRefusalSaysWhyOnce() async {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PlanBasisTests.\(UUID().uuidString)")!)
        app.state.session.planSource = PlanSourceState(kind: nil, candidates: candidates)
        app.requestSink = { _ in throw EngineClientError.refused("invalid_plan_file:docs/plans/batch-plan.md", code: "invalid_plan_file") }
        await app.choosePlanBasis(path: "docs/plans/batch-plan.md")
        #expect(app.lastError == "That plan file cannot be read any more — choose another one")
    }
}
