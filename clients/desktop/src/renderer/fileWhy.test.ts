import { describe, expect, it } from "vitest";
import type { TurnSummaryFile } from "@reviewgate/engine";
import { planCardWhy, rationaleMetaOf, readFileWhy, summaryWhy, testVerdict } from "./fileWhy";

const file = (path: string, more: Partial<TurnSummaryFile> = {}): TurnSummaryFile => ({
  path,
  status: "M",
  state: "pending",
  adds: 1,
  dels: 0,
  why: null,
  whyToolUseId: null,
  tools: ["Edit"],
  toolUseIds: ["t1"],
  ...more,
});

describe("readFileWhy (§34.8 FileWhy, lenient)", () => {
  it("keeps the four sources with their age, call, subagent and delegation", () => {
    expect(readFileWhy({ text: "  tenantId 를 시그니처에 추가 ", source: "reported" })).toEqual({ text: "tenantId 를 시그니처에 추가", source: "reported", age: null, toolUseId: null, agent: null, delegation: null });
    expect(readFileWhy({ text: "Let me fix the repo", source: "earlier", age: 5, toolUseId: "t9" })).toMatchObject({ source: "earlier", age: 5, toolUseId: "t9" });
    expect(readFileWhy({ text: "I'll update the DTO", source: "same_message", toolUseId: "t2", agent: { toolUseId: "a1", subagentType: "oh-my-claudecode:executor" }, delegation: "executor에게 맡깁니다" })).toMatchObject({
      agent: { toolUseId: "a1", type: "oh-my-claudecode:executor" },
      delegation: "executor에게 맡깁니다",
    });
    expect(readFileWhy({ text: null, source: "none" })).toMatchObject({ text: null, source: "none" });
  });

  it("anything it cannot read is absent; a text without a usable source still shows; no text means no recorded reason", () => {
    expect(readFileWhy(undefined)).toBeNull();
    expect(readFileWhy("why")).toBeNull();
    expect(readFileWhy({ source: 3 })).toBeNull();
    // a source this client does not know (a newer engine): the text is shown plainly
    expect(readFileWhy({ text: "because", source: "inferred" })).toMatchObject({ text: "because", source: "same_message" });
    expect(readFileWhy({ text: "   ", source: "reported" })).toMatchObject({ text: null, source: "none" });
    expect(readFileWhy({ text: "x", source: "earlier", age: -2, agent: { subagentType: "x" }, delegation: "" })).toMatchObject({ age: null, agent: null, delegation: null });
  });
});

describe("rationaleMetaOf (§34.8 tool_use.rationaleSource / rationaleAge)", () => {
  it("keeps the two known sources and a sane age; an engine before §34 adds nothing", () => {
    expect(rationaleMetaOf({ rationaleSource: "earlier", rationaleAge: 3 })).toEqual({ rationaleSource: "earlier", rationaleAge: 3 });
    expect(rationaleMetaOf({ rationaleSource: "same_message", rationaleAge: 0 })).toEqual({ rationaleSource: "same_message", rationaleAge: 0 });
    expect(rationaleMetaOf({})).toEqual({});
    expect(rationaleMetaOf({ rationaleSource: "guess", rationaleAge: -1 })).toEqual({});
  });
});

describe("summaryWhy", () => {
  it("prefers whyDetail; an engine before §34 keeps its plain `why` (legacy)", () => {
    expect(summaryWhy(file("a", { why: "old text", whyToolUseId: "t1", whyDetail: { text: "Claude's report", source: "reported" } }))).toMatchObject({ text: "Claude's report", source: "reported" });
    expect(summaryWhy(file("a", { why: "old text", whyToolUseId: "t1" }))).toMatchObject({ text: "old text", source: "legacy", toolUseId: "t1" });
    expect(summaryWhy(file("a"))).toMatchObject({ text: null, source: "legacy" });
  });
});

describe("planCardWhy (one sentence once per card)", () => {
  const shared = "로컬 Redis·MySQL 컨테이너가 떠 있는 것까지 확인했다";
  it("a sentence two or more files carry goes to the top once, numbered in file order; the files point at it", () => {
    const plan = planCardWhy([
      file("a.java", { whyDetail: { text: shared, source: "earlier", age: 4 } }),
      file("b.java", { whyDetail: { text: "own reason", source: "same_message" } }),
      file("c.java", { whyDetail: { text: `  ${shared} `, source: "earlier", age: 9 } }),
      file("d.java", { whyDetail: { text: null, source: "none" } }),
    ]);
    expect(plan.shared).toEqual([{ n: 1, kind: "why", view: expect.objectContaining({ text: shared, source: "earlier", age: 4 }), paths: ["a.java", "c.java"] }]);
    expect(plan.files.get("a.java")).toEqual({ why: 1, delegation: null });
    expect(plan.files.get("b.java")?.why).toMatchObject({ text: "own reason" });
    expect(plan.files.get("c.java")?.why).toBe(1);
    // "원인 기록 없음" is never a shared sentence
    expect(plan.files.get("d.java")?.why).toMatchObject({ source: "none" });
  });

  it("a delegation sentence shared by a subagent's files is hoisted too, apart from their own reasons", () => {
    const agent = { toolUseId: "a1", subagentType: "executor" };
    const plan = planCardWhy([
      file("x.java", { whyDetail: { text: "x reason", source: "same_message", agent, delegation: "executor에게 맡깁니다" } }),
      file("y.java", { whyDetail: { text: "y reason", source: "same_message", agent, delegation: "executor에게 맡깁니다" } }),
      file("z.java", { whyDetail: { text: "z reason", source: "same_message", delegation: "다른 위임" } }),
    ]);
    expect(plan.shared).toEqual([{ n: 1, kind: "delegation", view: expect.objectContaining({ text: "executor에게 맡깁니다" }), paths: ["x.java", "y.java"] }]);
    expect(plan.files.get("x.java")).toEqual({ why: expect.objectContaining({ text: "x reason" }), delegation: 1 });
    expect(plan.files.get("z.java")?.delegation).toBe("다른 위임");
  });

  it("legacy summaries (an engine before §34) dedupe their plain `why` the same way", () => {
    const plan = planCardWhy([file("a", { why: "same" }), file("b", { why: "same" }), file("c")]);
    expect(plan.shared.map((s) => s.paths)).toEqual([["a", "b"]]);
    expect(plan.files.get("c")?.why).toMatchObject({ text: null, source: "legacy" });
  });
});

describe("testVerdict (§34.9 turn_summary.lastTest)", () => {
  const run = { command: "./mvn25.sh -q -o test", toolUseId: "b7", at: "2026-10-23T01:00:00.000Z", runs: 2 };
  it("passed after the last edit / failed / no test after the last edit", () => {
    expect(testVerdict({ ...run, verdict: "pass", afterLastEdit: true })).toMatchObject({ tone: "green", text: "✓ Tests passed · ran after the last edit", toolUseId: "b7" });
    expect(testVerdict({ ...run, verdict: "fail", afterLastEdit: true })).toMatchObject({ tone: "red", text: "✕ Tests failed" });
    // wave3 check-clients — the Mac's rule: a run an edit came after covers nothing, whatever it said (the failure may be
    // fixed); orange, and the tooltip keeps what it said
    expect(testVerdict({ ...run, verdict: "fail", afterLastEdit: false })).toMatchObject({ tone: "orange", text: "No tests after the last edit", toolUseId: "b7" });
    expect(testVerdict({ ...run, verdict: "fail", afterLastEdit: false })?.title).toBe("The last test failed before a later edit\n$ ./mvn25.sh -q -o test · ×2");
    // a pass that an edit came after no longer covers the change
    expect(testVerdict({ ...run, verdict: "pass", afterLastEdit: false })).toMatchObject({ tone: "orange", text: "No tests after the last edit", toolUseId: "b7" });
    // a verdict this client does not know says nothing either way (the Mac's TestVerdictLine too)
    expect(testVerdict({ ...run, verdict: "flaky", afterLastEdit: true })).toBeNull();
    expect(testVerdict({ ...run, verdict: "flaky", afterLastEdit: false })).toBeNull();
    expect(testVerdict(null)).toMatchObject({ tone: "gray", text: "No tests after the last edit", toolUseId: null });
    expect(testVerdict({ ...run, verdict: "pass", afterLastEdit: true })?.title).toContain("./mvn25.sh -q -o test");
  });

  it("no field (an engine before §34) or an unreadable one → null: the card keeps its old count-based badge", () => {
    expect(testVerdict(undefined)).toBeNull();
    expect(testVerdict({ verdict: "flaky" })).toBeNull();
    expect(testVerdict("pass")).toBeNull();
  });
});
