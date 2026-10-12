import { describe, expect, it } from "vitest";
import type { AgentNode } from "@reviewgate/engine";
import { agentQuestions, anchorToolName, newQuestionChips, reportFindingsLine } from "./chatFollowups";
import { quickQuestions } from "./sideThreads";

/** ToolRows imports the store, which reads `window` / `document` when it loads. */
async function loadToolRows() {
  (globalThis as unknown as { document: unknown }).document ??= { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window ??= {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), onEvent: () => () => undefined, getSettings: async () => ({}), setSettings: async (p: unknown) => p, setUI: async () => undefined, platform: "darwin", sep: "/" },
  };
  return import("./components/chat/ToolRows");
}

// wave4 w4-check3: the 0.2.3 follow-ups, word for word as Core's ChatFollowupsTests on the Mac.
describe("a side question about a subagent", () => {
  it("offers questions about the agent's work, never the permission card's 'Is this safe to allow?'", () => {
    const chips = newQuestionChips({ toolUseId: "toolu_ag" }, "Agent");
    expect(chips).toEqual(["What did this agent change?", "Did this agent do what it was asked?", "What are the key points of this report, and what should I check?"]);
    expect(chips).toEqual(agentQuestions());
    expect(newQuestionChips({ toolUseId: "toolu_ag" }, "Task")).toEqual(chips); // older CLIs
    expect(chips).not.toContain("Is this safe to allow?");
  });

  it("keeps the usual chips for other anchors", () => {
    expect(newQuestionChips({ toolUseId: "toolu_b" }, "Bash")).toEqual(quickQuestions());
    expect(newQuestionChips({ path: "a.ts", toolUseId: "toolu_ag" }, "Agent")).toEqual(quickQuestions());
    expect(newQuestionChips(null, "Agent")).toEqual(quickQuestions());
    expect(newQuestionChips({ toolUseId: "toolu_x" }, undefined)).toEqual(quickQuestions());
  });

  it("knows the anchored call's tool from the chat, else from the HUD's agents", () => {
    const rows = [
      { kind: "toolUse", toolUseId: "toolu_b", name: "Bash" },
      { kind: "toolUse", toolUseId: "toolu_ag", name: "Agent" },
      { kind: "toolResult", toolUseId: "toolu_ag" },
    ];
    const agents = [{ toolUseId: "toolu_gone" } as AgentNode];
    expect(anchorToolName({ toolUseId: "toolu_ag" }, rows, agents)).toBe("Agent");
    expect(anchorToolName({ toolUseId: "toolu_b" }, rows, agents)).toBe("Bash");
    expect(anchorToolName({ toolUseId: "toolu_gone" }, rows, agents)).toBe("Agent"); // its row is gone (a restart), the card is not
    expect(anchorToolName({ toolUseId: "toolu_none" }, rows, agents)).toBeUndefined();
    expect(anchorToolName({ path: "a.ts" }, rows, agents)).toBeUndefined();
    expect(anchorToolName(null, rows, agents)).toBeUndefined();
  });
});

describe("the main chat's ReportFindings row (§36.13)", () => {
  it("reads as its findings: count, then each file's first line", () => {
    const input = {
      level: "medium",
      findings: [
        { file: "api/src/main/java/com/x/Svc.java", line: 42, summary: "A soft-deleted tenant now throws", short_summary: "x", failure_scenario: "y" },
        { file: "api/src/main/java/com/x/Svc.java", line: 80, summary: "second in the same file", short_summary: "x", failure_scenario: "y" },
        { file: "web/app.ts", line: null, summary: "whole file", short_summary: "x", failure_scenario: "y" },
      ],
    };
    expect(reportFindingsLine(input)).toBe("3 findings · Svc.java:42, app.ts");
    expect(reportFindingsLine({ findings: [{ file: "a.ts", line: 1 }, { file: "b.ts", line: 2 }, { file: "c.ts", line: 3 }, { file: "d\\e.ts", line: 4 }, { file: "f.ts" }] })).toBe("5 findings · a.ts:1, b.ts:2, c.ts:3 +2");
    expect(reportFindingsLine({ findings: [] })).toBe("No findings");
    expect(reportFindingsLine({ findings: [{ summary: "no file" }] })).toBe("1 findings");
    expect(reportFindingsLine({ command: "ls" })).toBeNull();
    expect(reportFindingsLine({ findings: "odd" })).toBeNull();
  });

  it("is the tool row's detail and icon; other tools keep theirs", async () => {
    const { toolDetail, toolIcon } = await loadToolRows();
    expect(toolDetail("ReportFindings", undefined, { findings: [{ file: "src/a.ts", line: 3 }] }, "/repo")).toBe("1 findings · a.ts:3");
    expect(toolIcon("ReportFindings")).toBe("✦");
    expect(toolDetail("Bash", undefined, { command: "ls  -la" }, "/repo")).toBe("ls -la");
    expect(toolDetail("Other", undefined, { findings: [] }, "/repo")).toBe("");
  }, 60_000); // loading the store and the chat components is slow on a busy machine
});
