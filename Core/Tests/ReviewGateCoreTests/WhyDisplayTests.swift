import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 mac-diff — "why" on screen (docs/PROTOCOL.md §34.8–34.9, audit comp-01 / agents-03 / comp-05 / comp-09): the
/// source of every reason (reported > same message > earlier, dimmed > none), a subagent's own reason before the main
/// agent's delegation, one shared sentence per card, "Bash로 변경" only for Bash-only causes, and the test verdict line.
@Suite struct WhyDisplayTests {
    private func summaryFile(_ path: String, why: String? = nil, detail: FileWhy? = nil, tools: [String] = ["Edit"], ids: [String] = ["e1"],
                             origin: FileOrigin? = .tool) -> TurnSummary.File {
        var f = TurnSummary.File(path: path, why: why, whyToolUseId: detail?.toolUseId, tools: tools, toolUseIds: ids)
        f.whyDetail = detail
        f.origin = origin
        return f
    }

    private func changed(_ path: String, tools: [String], origin: FileOrigin?) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: tools,
                            toolUseIds: tools.isEmpty ? [] : ["t1"])
        f.origin = origin
        return f
    }

    // MARK: FileWhy → line

    @Test func mapsEverySourceOfTheEngine() throws {
        let reported = try #require(WhyDisplay.line(FileWhy(text: "Svc.java: tenant 검증 추가", source: .reported)))
        #expect(reported.source == .reported && reported.text == "Svc.java: tenant 검증 추가")
        let direct = try #require(WhyDisplay.line(FileWhy(text: "Null check", source: .sameMessage, toolUseId: "e1")))
        #expect(direct.source == .direct && direct.toolUseId == "e1")
        let earlier = try #require(WhyDisplay.line(FileWhy(text: "Docker is up", source: .earlier, age: 5)))
        #expect(earlier.source == .earlier && earlier.age == 5)
        let none = try #require(WhyDisplay.line(FileWhy(text: nil, source: .noRecord)))
        #expect(none.source == .noRecord && none.text == nil)
        // An unknown source still shows its text plainly; an empty text is "no record".
        #expect(WhyDisplay.line(FileWhy(text: "x", source: .other("future")))?.source == .direct)
        #expect(WhyDisplay.line(FileWhy(text: "  \n ", source: .sameMessage))?.source == .noRecord)
        #expect(WhyDisplay.line(nil) == nil)
    }

    @Test func subagentReasonComesFirstAndTheDelegationSeparately() throws {
        let why = FileWhy(text: "I'll add the guard because the tenant may be null", source: .sameMessage, toolUseId: "e9",
                          agent: WhyAgent(toolUseId: "ag1", subagentType: "executor"), delegation: "executor에게 맡기겠습니다")
        let line = try #require(WhyDisplay.line(why))
        #expect(line.text == "I'll add the guard because the tenant may be null")
        #expect(line.agent == "executor" && line.delegation == "executor에게 맡기겠습니다")
        // A subagent without a type reads as "Subagent".
        let anon = try #require(WhyDisplay.line(FileWhy(text: "x", source: .reported, agent: WhyAgent(toolUseId: "ag2"))))
        #expect(anon.agent == WhyText.subagent)
        // The delegation alone (no text of the subagent's own) still says why it was delegated.
        let onlyDelegated = try #require(WhyDisplay.line(FileWhy(text: nil, source: .noRecord, delegation: "리팩터링 위임")))
        #expect(onlyDelegated.source == .noRecord && onlyDelegated.delegation == "리팩터링 위임")
    }

    @Test func turnSummaryFilesFallBackToTheOlderFields() throws {
        // §34 engine: whyDetail wins over the mirrored `why`.
        let detailed = summaryFile("a", why: "mirror", detail: FileWhy(text: "Docker is up", source: .earlier, age: 3))
        #expect(WhyDisplay.line(for: detailed)?.source == .earlier && WhyDisplay.line(for: detailed)?.text == "Docker is up")
        // Older engine: the plain `why`, shown as before.
        let legacy = try #require(WhyDisplay.line(for: summaryFile("b", why: "Rename the helper")))
        #expect(legacy.source == .direct && legacy.text == "Rename the helper")
        // Older engine, a call without text: nothing (as before).
        #expect(WhyDisplay.line(for: summaryFile("c")) == nil)
        // comp-05: no cause at all — "원인 기록 없음", never "Bash로 변경".
        #expect(WhyDisplay.line(for: summaryFile("d", tools: [], ids: [], origin: nil))?.source == .noRecord)
        #expect(!summaryFile("d", tools: [], ids: [], origin: nil).risks.contains(.viaBash))
        // An external file has its own badge; no extra line.
        #expect(WhyDisplay.line(for: summaryFile("e", tools: [], ids: [], origin: .external)) == nil)
        // ChangedFile: only the engine's FileWhy (the diff header lists the calls itself).
        var file = changed("f", tools: ["Edit"], origin: .tool)
        #expect(WhyDisplay.line(for: file) == nil)
        file.why = FileWhy(text: "Reported", source: .reported)
        #expect(WhyDisplay.line(for: file)?.source == .reported)
    }

    // MARK: One shared sentence per card (§34.8)

    @Test func sharedSentencesAreGroupedOnceInFileOrder() {
        let docker = "로컬 Redis·MySQL 컨테이너가 떠 있는 것까지 확인했다."
        let files = [
            summaryFile("a.java", detail: FileWhy(text: docker, source: .earlier, age: 4)),
            summaryFile("b.java", detail: FileWhy(text: "b만의 이유", source: .sameMessage)),
            summaryFile("c.java", detail: FileWhy(text: " 로컬 Redis·MySQL  컨테이너가 떠 있는 것까지 확인했다. ", source: .sameMessage)),
            summaryFile("d.java", detail: FileWhy(text: nil, source: .noRecord)),
            summaryFile("e.java", detail: FileWhy(text: nil, source: .noRecord)),
            summaryFile("f.java", why: "legacy shared"),
            summaryFile("g.java", why: "legacy shared"),
        ]
        let shared = WhyDisplay.shared(files)
        #expect(shared.map(\.paths) == [["a.java", "c.java"], ["f.java", "g.java"]])   // "no record" is never grouped
        #expect(shared[0].line.source == .direct)   // the strongest source of the group (same message beats earlier)
        #expect(shared[0].line.text == docker)
        #expect(WhyDisplay.isShared("c.java", in: shared) && !WhyDisplay.isShared("b.java", in: shared) && !WhyDisplay.isShared("d.java", in: shared))
        #expect(WhyDisplay.shared([files[0], files[1]]).isEmpty)
    }

    @Test func causesCarryTheRationaleSourceAndTheDelegationApart() {
        let items: [ChatItem] = [
            .toolUse(id: UUID(), toolUseId: "ag1", name: "Agent", file: nil, input: .object(["subagent_type": .string("executor")]),
                     info: ToolUseInfo(rationale: "executor에게 맡기겠습니다")),
            .toolUse(id: UUID(), toolUseId: "e1", name: "Edit", file: "/repo/a.ts", input: .object([:]),
                     info: ToolUseInfo(parentToolUseId: "ag1", rationale: "I'll guard the tenant", rationaleSource: .earlier, rationaleAge: 4)),
            .toolUse(id: UUID(), toolUseId: "e2", name: "Edit", file: "/repo/a.ts", input: .object([:]),
                     info: ToolUseInfo(rationale: "Rename it", rationaleSource: .sameMessage, rationaleAge: 0)),
        ]
        let file = changed("a.ts", tools: ["Edit"], origin: .tool)
        var withIds = file
        withIds.toolUseIds = ["e1", "e2"]
        let causes = ChangeCause.causes(for: withIds, in: TranscriptIndex(items))
        #expect(causes[0].rationale == "I'll guard the tenant" && causes[0].isEarlierRationale && causes[0].rationaleAge == 4)
        #expect(causes[0].delegation == "executor에게 맡기겠습니다" && causes[0].agentLabel == "executor")
        #expect(causes[1].rationaleSource == .sameMessage && !causes[1].isEarlierRationale && causes[1].delegation == nil)
    }

    @Test func theDiffHeaderShowsTheReasonAboveTheCallsOnlyWhenNoCallShowsIt() {
        let own = ChangeCause(toolUseId: "e1", call: nil, rationale: "Rename it", agent: nil)
        let silent = ChangeCause(toolUseId: "e2", call: nil, rationale: nil, agent: nil)
        #expect(WhyDisplay.showsAbove(WhyLine(text: "a.ts: renamed", source: .reported), causes: [own]))
        #expect(!WhyDisplay.showsAbove(WhyLine(text: "Rename it", source: .direct, toolUseId: "e1"), causes: [own]))   // on its row
        #expect(WhyDisplay.showsAbove(WhyLine(text: "older", source: .earlier, toolUseId: "e9"), causes: [own]))       // an earlier turn's call
        #expect(WhyDisplay.showsAbove(WhyLine(text: "x", source: .direct, toolUseId: "e2"), causes: [silent]))
        #expect(!WhyDisplay.showsAbove(WhyLine(text: nil, source: .noRecord), causes: []))
        #expect(WhyDisplay.showsAbove(WhyLine(text: nil, source: .noRecord, delegation: "위임"), causes: []))
    }

    // MARK: "Bash로 변경" (comp-05)

    @Test func viaBashOnlyWhenBashIsTheOnlyCause() {
        #expect(FileRisk.isViaBash(changed("a", tools: ["Bash"], origin: .bash)))
        #expect(FileRisk.isViaBash(changed("b", tools: ["Read", "Bash"], origin: nil)))      // older engine: Bash is the only cause
        #expect(!FileRisk.isViaBash(changed("c", tools: [], origin: .bash)))                 // no tools: "원인 기록 없음", not Bash
        #expect(!FileRisk.isViaBash(changed("d", tools: [], origin: nil)))
        #expect(!FileRisk.isViaBash(changed("e", tools: ["Bash", "Edit"], origin: nil)))
        #expect(!FileRisk.isViaBash(changed("f", tools: ["Bash", "mcp__idea__replace"], origin: nil)))
        #expect(!FileRisk.isViaBash(changed("g", tools: ["Bash"], origin: .external)))      // the engine says nothing of Claude's did it
        #expect(!FileRisk.isViaBash(changed("h", tools: ["Bash", "Edit"], origin: .tool)))
        #expect(changed("i", tools: ["Bash"], origin: nil).isViaBash)
    }

    // MARK: Test verdict (comp-09)

    @Test func testVerdictLineFollowsTheLastRunAndTheLastEdit() {
        #expect(TestVerdictLine(nil) == nil)
        #expect(TestVerdictLine(LastTest(verdict: .pass, command: "./mvn25.sh -q -o test", afterLastEdit: true)) == .passedAfterEdit)
        #expect(TestVerdictLine(LastTest(verdict: .fail, command: "npm test", afterLastEdit: true)) == .failed)
        #expect(TestVerdictLine(LastTest(verdict: .pass, command: "npm test", afterLastEdit: false)) == .noTestAfterEdit)
        // A failure followed by an edit says the edit was not tested — the failure may be fixed.
        #expect(TestVerdictLine(LastTest(verdict: .fail, command: "npm test", afterLastEdit: false)) == .noTestAfterEdit)
        #expect(TestVerdictLine(LastTest(verdict: nil, command: "npm test", afterLastEdit: true)) == nil)
        #expect(TestVerdictLine.passedAfterEdit.text == "Tests passed · ran after the last edit")
        #expect(TestVerdictLine.failed.text == "Tests failed")
        #expect(TestVerdictLine.noTestAfterEdit.text == "No tests after the last edit")
    }

    @Test func textsUseTheSharedKeys() {
        #expect(WhyText.earlier("x") == "Earlier note: x")
        #expect(WhyText.delegated("y") == "Delegated: y")
        #expect(WhyText.noRecord == "No recorded reason")
        #expect(WhyText.reported == "Reported by Claude")
        #expect(WhyText.callsEarlier(3) == "3 calls earlier")
    }
}
