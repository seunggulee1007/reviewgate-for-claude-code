import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentNode } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { toolLabel } from "./toolLabel";
import { indexTranscript } from "./agents";
import type { ChatItem } from "./store";
import {
  agentBadges,
  agentsHudLine,
  authorFilters,
  changesByAgent,
  fileAuthors,
  filterByAuthor,
  finishedLine,
  groupFiles,
  historyByTurn,
  historyLine,
  historyOf,
  isolationBadge,
  stepLine,
  stepOf,
  toolTitle,
} from "./agentGlance";

/** MARK: wave4b w4b-agents — docs/PROTOCOL.md §39.3 (the Mac's AgentGlanceTests check the same cases). */
const node = (over: Partial<AgentNode> = {}): AgentNode => ({
  id: "t1",
  toolUseId: "ag1",

  type: "oh-my-claudecode:executor",
  description: "배치 모듈 영향 확인",
  status: "running",
  isBackground: false,
  depth: 1,
  startedAt: 1_000,
  files: [],
  ...over,
});

describe("§39.3 toolLabel — the rule the engine and the Mac share", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/toolLabels.json", import.meta.url), "utf8")) as {
    cases: { name: string; input: Record<string, unknown>; label: unknown }[];
  };
  for (const c of fixture.cases) {
    it(`${c.name} ${JSON.stringify(c.input).slice(0, 40)}`, () => {
      expect(toolLabel(c.name, c.input)).toEqual(c.label);
    });
  }
});

describe("§39.3 at a glance (Korean)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("names a step: plain tool, MCP server · tool · argument, skill", () => {
    expect(toolTitle("Bash", "./gradlew :acme-api:test")).toBe("Bash · ./gradlew :acme-api:test");
    expect(toolTitle("mcp__acme__acme_list_issues", "1800")).toBe("acme · list issues · 1800");
    expect(toolTitle("Skill", "acme-tools:smoke")).toBe("스킬 acme-tools:smoke");
    expect(toolTitle("Read")).toBe("Read");
    expect(stepLine({ tool: "Bash", detail: "./gradlew :acme-api:test", since: 0 }, 252_000)).toBe("Bash · ./gradlew :acme-api:test · 4분 12초");
    expect(stepLine({ tool: "Edit", detail: "A.java", since: 0, endedAt: 1_500 }, 900_000)).toBe("Edit · A.java · 1.5초");
  });

  it("reads a malformed step as none", () => {
    expect(stepOf(node())).toBeNull();
    expect(stepOf(node({ lastStep: { tool: "", since: 1 } }))).toBeNull();
    expect(stepOf(node({ lastStep: { tool: "Bash", since: 5, detail: "" } }))).toEqual({ tool: "Bash", since: 5 });
  });

  it("badges: retry, no response after 2 minutes; none while it waits for permission, is paused or finished", () => {
    const a = node({ retry: { attempt: 3, max: 10, at: 1, status: 529 }, activeAt: 0 });
    expect(agentBadges(a, 60_000).map((b) => b.text)).toEqual(["재시도 3/10"]);
    expect(agentBadges(a, 125_000).map((b) => b.text)).toEqual(["재시도 3/10", "응답 없음 2분"]);
    expect(agentBadges(a, 125_000, true)).toEqual([]);
    expect(agentBadges({ ...a, status: "paused" }, 125_000)).toEqual([]);
    expect(agentBadges({ ...a, status: "completed" }, 125_000)).toEqual([]);
    expect(agentBadges(node(), 10_000_000)).toEqual([]); // an older engine: no activeAt, no badge
  });

  it("the HUD line names the agent whose call started last, preferring one still running", () => {
    const agents = [
      node({ toolUseId: "a", type: "explore", lastStep: { tool: "Grep", detail: "CartFilter", since: 9_000, endedAt: 9_500 } }),
      node({ toolUseId: "b", type: "oh-my-claudecode:executor", lastStep: { tool: "Edit", detail: "CartService.java", since: 5_000 } }),
      node({ toolUseId: "c", type: "test-engineer" }),
      node({ toolUseId: "d", status: "completed" }),
    ];
    expect(agentsHudLine(agents)).toBe("서브에이전트 3개 실행 중 — executor: Edit CartService.java");
    expect(agentsHudLine([node()])).toBe("서브에이전트 1개 실행 중");
    expect(agentsHudLine([node({ status: "completed" })])).toBeNull();
  });

  it("a finished group's numbers", () => {
    expect(finishedLine("completed", { tokens: 35_000, toolUses: 12, durationMs: 64_000 }, 2)).toBe("✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2");
    expect(finishedLine("failed", null, 0)).toBe("✕ 실패");
    expect(finishedLine("stopped", null, 1, true)).toBe("■ 사용자가 중지 · 파일 1");
    expect(finishedLine("running", null, 3)).toBeNull();
  });

  it("isolation: badge with where it worked; none for a denied call or none at all", () => {
    expect(isolationBadge(node({ isolation: "worktree", worktreePath: "/r/.claude/worktrees/agent-a1", worktreeBranch: "worktree-agent-a1" }))?.text).toBe("격리 worktree · 리뷰 밖");
    expect(isolationBadge(node({ isolation: "worktree", status: "failed" }))).toBeNull();
    expect(isolationBadge(node({ isolation: "none" }))).toBeNull();
    expect(isolationBadge(node())).toBeNull();
  });
});

describe("§39.3 earlier turns", () => {
  it("groups the history by turn, newest first, and reads it leniently", () => {
    const h = historyOf([node({ toolUseId: "x", turn: 2, status: "completed" }), node({ toolUseId: "y", turn: 1, status: "failed" }), node({ toolUseId: "z", turn: 2 }), { bogus: true }, node({ toolUseId: "w" })]);
    expect(historyByTurn(h).map((g) => [g.turn, g.agents.map((a) => a.toolUseId)])).toEqual([[2, ["x", "z"]], [1, ["y"]], [null, ["w"]]]);
    expect(historyOf(undefined)).toEqual([]);
    expect(historyLine(node({ status: "completed", tokens: 35_000, toolUses: 3, durationMs: 64_000, files: ["a", "b"] }))).toBe("executor · 배치 모듈 영향 확인 · ✓ Completed · 1m 04s · 35k tokens · Files 2");
  });
});

describe("§39.3 who changed a file", () => {
  const items: ChatItem[] = [
    { kind: "toolUse", id: 1, toolUseId: "ag1", name: "Agent", input: { subagent_type: "oh-my-claudecode:executor" } },
    { kind: "toolUse", id: 2, toolUseId: "e1", name: "Edit", file: "/r/A.java", input: {}, parentToolUseId: "ag1" },
    { kind: "toolUse", id: 3, toolUseId: "ag2", name: "Agent", input: { subagent_type: "test-engineer" }, parentToolUseId: "ag1" },
    { kind: "toolUse", id: 4, toolUseId: "b1", name: "Bash", input: { command: "x" }, parentToolUseId: "ag2" },
    { kind: "toolUse", id: 5, toolUseId: "w1", name: "Write", file: "/r/C.java", input: {} },
  ];
  const index = indexTranscript(items);

  it("is the nearest agent above the call, else the main agent", () => {
    expect(fileAuthors(["e1"], index).map((a) => a.label)).toEqual(["executor"]);
    expect(fileAuthors(["b1"], index).map((a) => a.label)).toEqual(["test-engineer"]);
    expect(fileAuthors(["w1", "e1", "e1"], index).map((a) => a.key)).toEqual(["main", "ag1"]);
    expect(fileAuthors(undefined, index)).toEqual([]);
    expect(groupFiles(index, "ag1")).toEqual(["/r/A.java"]);
  });

  it("offers filter chips only for two or more authors and filters by one", () => {
    const files = [
      { path: "A.java", ids: ["e1"] },
      { path: "B.java", ids: ["b1"] },
      { path: "C.java", ids: ["w1"] },
    ];
    const authorsOf = (f: { ids: string[] }) => fileAuthors(f.ids, index);
    const offered = authorFilters(files.map(authorsOf));
    expect(offered.map((a) => a.label)).toEqual(["Main", "executor", "test-engineer"]);
    expect(filterByAuthor(files, authorsOf, "ag2", offered).map((f) => f.path)).toEqual(["B.java"]);
    expect(filterByAuthor(files, authorsOf, "gone", offered)).toHaveLength(3);
    expect(authorFilters([fileAuthors(["e1"], index)])).toEqual([]);
    expect(changesByAgent(files, authorsOf).map((c) => [c.author.label, c.paths])).toEqual([["executor", ["A.java"]], ["test-engineer", ["B.java"]], ["Main", ["C.java"]]]);
    expect(changesByAgent([files[2]!], authorsOf)).toEqual([]);
  });
});
