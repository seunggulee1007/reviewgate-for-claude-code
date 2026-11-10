import { describe, expect, it } from "vitest";
import { fileWhy, reportedFor, reportItems } from "../src/review/why.js";
import { buildTurnSummary, type ToolCallInfo } from "../src/review/summary.js";

const SVC = "api/src/main/java/com/x/settlement/SettlementService.java";
const TEST = "api/src/test/java/com/x/settlement/SettlementServiceTest.java";
const REPO = "api/src/main/java/com/x/settlement/SettlementRepository.java";

describe("reportItems / reportedFor (§34.8 reported)", () => {
  it("a `- path: reason` item first, without its path; sentences and list items that mention the file otherwise", () => {
    const items = reportItems(
      [
        "변경을 마쳤습니다. SettlementService.java 의 마감 로직을 고쳤고 테스트도 추가했습니다.",
        "",
        "- `SettlementService.java`: 마감일에 cartId 를 확인합니다.",
        "- SettlementServiceTest.java — 마감 케이스 2개",
        "",
        "```java",
        "// SettlementRepository.java is not changed here",
        "```",
      ].join("\n"),
    );
    expect(reportedFor(SVC, null, items)).toBe("마감일에 cartId 를 확인합니다. SettlementService.java 의 마감 로직을 고쳤고 테스트도 추가했습니다.");
    expect(reportedFor(TEST, null, items)).toBe("마감 케이스 2개");
    // A fenced block is code, not a report.
    expect(reportedFor(REPO, null, items)).toBeNull();
  });

  it("a heading or label naming the file explains it with the items under it", () => {
    const items = reportItems(["## 변경 사항", "### SettlementService.java", "- 마감일 검증 추가", "- 로그 정리", "- 세 번째는 넘침", "### SettlementRepository.java", "- 쿼리 수정"].join("\n"));
    expect(reportedFor(SVC, null, items)).toBe("마감일 검증 추가 로그 정리");
    expect(reportedFor(REPO, null, items)).toBe("쿼리 수정");
    const labels = reportItems(["**SettlementService.java**:", "  - null guard for the cart", "Done."].join("\n"));
    expect(reportedFor(SVC, null, labels)).toBe("null guard for the cart");
  });

  it("a `path: reason` head must be a list of paths — a sentence before a colon stays whole", () => {
    const items = reportItems(["- SettlementService.java, SettlementRepository.java: cartId 전달", "- Fixed the bug in SettlementService.java: the guard was missing"].join("\n"));
    expect(reportedFor(REPO, null, items)).toBe("cartId 전달");
    expect(reportedFor(SVC, null, items)).toBe("cartId 전달 Fixed the bug in SettlementService.java: the guard was missing");
  });

  it("table rows whose first cell is the file", () => {
    const items = reportItems(["| 파일 | 변경 |", "| --- | --- |", "| SettlementService.java | cart 확인 |", "| SettlementRepository.java | 쿼리 |"].join("\n"));
    expect(reportedFor(SVC, null, items)).toBe("cart 확인");
  });

  it("≤ 2 items and ≤ 300 chars; a renamed file is found by its old path too", () => {
    const long = "SettlementService.java " + "가".repeat(400) + ".";
    const items = reportItems([long, "Second about SettlementService.java.", "Third about SettlementService.java."].join("\n"));
    const r = reportedFor(SVC, null, items)!;
    expect(r.length).toBeLessThanOrEqual(300);
    expect(r.endsWith("…")).toBe(true);
    const renamed = reportItems("Moved OldService.java into the settlement package.");
    expect(reportedFor(SVC, "api/src/main/java/com/x/OldService.java", renamed)).toBe("Moved OldService.java into the settlement package.");
  });
});

/** Calls in tool_use order (seq), turn 4 unless given. */
function calls(rows: [string, Partial<ToolCallInfo>][]): Map<string, ToolCallInfo> {
  return new Map(rows.map(([id, c], i) => [id, { name: "Edit", turn: 4, seq: i, ...c } as ToolCallInfo]));
}
const file = (path: string, toolUseIds: string[]) => ({ path, oldPath: null, toolUseIds });

describe("fileWhy (§34.8)", () => {
  it("reported first: the main report when the main agent changed the file", () => {
    const c = calls([["e1", { rationale: "Now the guard.", rationaleSource: "same_message", rationaleAge: 0 }]]);
    const w = fileWhy(file(SVC, ["e1"]), { calls: c, turn: 4, mainReport: "- SettlementService.java: cart 확인" }, true);
    expect(w).toEqual({ text: "cart 확인", source: "reported", turn: 4 });
  });

  it("this turn's calls: same_message before earlier, then the smallest age, then the latest call", () => {
    const c = calls([
      ["e1", { rationale: "Looked around; editing now.", rationaleSource: "earlier", rationaleAge: 0 }],
      ["e2", { rationale: "Fix the closing day.", rationaleSource: "same_message", rationaleAge: 2 }],
      ["e3", { rationale: "Also the log line.", rationaleSource: "same_message", rationaleAge: 1 }],
      ["e4", { rationale: "And one more.", rationaleSource: "same_message", rationaleAge: 1 }],
    ]);
    expect(fileWhy(file(SVC, ["e1", "e2", "e3", "e4"]), { calls: c, turn: 4, mainReport: "" }, true)).toEqual({
      text: "And one more.",
      source: "same_message",
      toolUseId: "e4",
      turn: 4,
    });
    const earlierOnly = calls([["e1", { rationale: "Plan: guard first.", rationaleSource: "earlier", rationaleAge: 5 }]]);
    expect(fileWhy(file(SVC, ["e1"]), { calls: earlierOnly, turn: 4, mainReport: "" }, true)).toEqual({ text: "Plan: guard first.", source: "earlier", age: 5, toolUseId: "e1", turn: 4 });
  });

  it("a file changed inside a subagent: its report first (agent + delegation), else its own text, delegation apart", () => {
    const c = calls([
      ["ag", { name: "Agent", subagentType: "executor", rationale: "executor에게 맡기겠습니다.", rationaleSource: "same_message", rationaleAge: 0, parentToolUseId: undefined, report: "- SettlementService.java: 마감 검증을 추가했습니다." }],
      ["s1", { parentToolUseId: "ag", rationale: "The cart is never checked.", rationaleSource: "same_message", rationaleAge: 0 }],
    ]);
    const ctx = { calls: c, turn: 4, mainReport: "Done — SettlementService.java was handled by the executor." };
    expect(fileWhy(file(SVC, ["s1"]), ctx, true)).toEqual({
      text: "마감 검증을 추가했습니다.",
      source: "reported",
      agent: { toolUseId: "ag", subagentType: "executor" },
      delegation: "executor에게 맡기겠습니다.",
      turn: 4,
    });
    // The report does not name the file: the main report next.
    c.get("ag")!.report = "All done.";
    expect(fileWhy(file(SVC, ["s1"]), ctx, true)).toEqual({ text: "Done — SettlementService.java was handled by the executor.", source: "reported", turn: 4 });
    // No report names it: the subagent's own text, the main agent's words as the delegation.
    expect(fileWhy(file(SVC, ["s1"]), { ...ctx, mainReport: "" }, true)).toEqual({
      text: "The cart is never checked.",
      source: "same_message",
      toolUseId: "s1",
      agent: { toolUseId: "ag", subagentType: "executor" },
      delegation: "executor에게 맡기겠습니다.",
      turn: 4,
    });
    // A subagent call without text of its own (an older CLI): no record, but the delegation is known.
    c.get("s1")!.rationale = undefined;
    expect(fileWhy(file(SVC, ["s1"]), { ...ctx, mainReport: "" }, true)).toEqual({ text: null, source: "none", delegation: "executor에게 맡기겠습니다.", turn: 4 });
  });

  it("a file this turn did not change: the earlier turns' calls of the review; none at all → none", () => {
    const c = calls([
      ["old", { rationale: "Turn 2 reason.", rationaleSource: "same_message", rationaleAge: 0, turn: 2 }],
      ["new", { rationale: "Turn 4 reason.", rationaleSource: "same_message", rationaleAge: 0 }],
    ]);
    expect(fileWhy(file(SVC, ["old"]), { calls: c, turn: 4, mainReport: "SettlementService.java is fine as is." }, false)).toEqual({ text: "Turn 2 reason.", source: "same_message", toolUseId: "old", turn: 2 });
    // Changed this turn without a rationale of this turn: the spec's order stops at none (the earlier reason is not this change's).
    expect(fileWhy(file(SVC, ["old"]), { calls: c, turn: 4, mainReport: "" }, true)).toEqual({ text: null, source: "none", turn: 4 });
    expect(fileWhy(file(REPO, []), { calls: c, turn: 4, mainReport: "" }, true)).toEqual({ text: null, source: "none", turn: 4 });
    // A refresh / restore collects no turn: the last turn's calls count as earlier ones too.
    expect(fileWhy(file(SVC, ["new"]), { calls: c, turn: 4, mainReport: "", noTurn: true }, false)).toEqual({ text: "Turn 4 reason.", source: "same_message", toolUseId: "new", turn: 4 });
    expect(fileWhy(file(SVC, ["new"]), { calls: c, turn: 4, mainReport: "" }, false)).toEqual({ text: null, source: "none", turn: 4 });
  });

  it("turn_summary: whyDetail is the file's FileWhy, why / whyToolUseId mirror it", () => {
    const why = { text: "마감 검증", source: "reported" as const, agent: { toolUseId: "ag" }, turn: 4 };
    const f = { path: SVC, oldPath: null, status: "M" as const, added: 2, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: ["s1"], state: "pending" as const, why };
    const s = buildTurnSummary({ turn: 4, files: [f], calls: new Map(), commandIds: [], plan: null });
    expect(s.files[0]).toMatchObject({ why: "마감 검증", whyToolUseId: null, whyDetail: why });
    const c = calls([["e1", { rationale: "Now the guard.", rationaleSource: "earlier", rationaleAge: 3, turn: undefined }]]);
    const { why: _why, ...plain } = f;
    const old = buildTurnSummary({ turn: 4, files: [{ ...plain, toolUseIds: ["e1"] }], calls: c, commandIds: [], plan: null });
    expect(old.files[0]).toMatchObject({ why: "Now the guard.", whyToolUseId: "e1", whyDetail: { text: "Now the guard.", source: "earlier", age: 3, toolUseId: "e1" } });
  });

  it("calls of an older engine (no source / age / turn) count as this turn's own-message rationale", () => {
    const c = new Map<string, ToolCallInfo>([["t1", { name: "Write", rationale: "Add the guide." }]]);
    expect(fileWhy(file("CONTRIBUTING.md", ["t1"]), { calls: c, turn: 2, mainReport: "" }, true)).toEqual({ text: "Add the guide.", source: "same_message", toolUseId: "t1", turn: 2 });
  });
});
