// MARK: wave4d w4d-agents2 — §42.4: "이전 턴" agents rebuilt from the chat's rows after an engine restart.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../src/protocol.js";
import { agentHistoryFromRows } from "../src/session/agentHistoryRows.js";
import { AgentTracker, AGENT_HISTORY_MAX } from "../src/session/agents.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("engine: the earlier turns' agents come back after a restart (§42.4)", () => {
  it("a fresh engine opening the chat lists its finished agents in hud.agentHistory", async () => {
    const dir = realpathSync(makeRepo());
    dirs.push(dir);
    const a = makeHarness();
    harnesses.push(a);
    await a.hello();
    await a.open(dir);
    await a.engine.handle({ type: "send", text: "go" });
    const s = a.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { subagent_type: "oh-my-claudecode:executor", description: "필터 순서 수정" } });
    s.emit({ type: "tool_use", id: "e1", name: "Write", input: { file_path: join(dir, "src/x.ts") }, file: join(dir, "src/x.ts"), parentToolUseId: "ag1" });
    write(dir, "src/x.ts", "x\n");
    s.emit({ type: "tool_result", toolUseId: "ag1", isError: false, preview: "done", agentUsage: { tokens: 900, toolUses: 3, durationMs: 4_000 } });
    s.emitTurnEnd({ sessionId: s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId! });
    await a.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    await a.settle();
    await a.engine.dispose();

    const b = makeHarness();
    harnesses.push(b);
    await b.hello();
    const opened = await b.open(dir);
    expect(opened.hud.agents).toEqual([]);
    expect(opened.hud.agentHistory?.map((n) => [n.toolUseId, n.type, n.status, n.turn, n.tokens, n.files])).toEqual([["ag1", "oh-my-claudecode:executor", "completed", 1, 900, ["src/x.ts"]]]);
  });
});

const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 1, 0, s)).toISOString();
const rows: TranscriptItem[] = [
  { at: at(0), turn: 1, kind: "user_message", text: "go" },
  { at: at(1), turn: 1, kind: "tool_use", id: "ag1", name: "Agent", input: { subagent_type: "oh-my-claudecode:executor", description: "필터 순서 수정", prompt: "p", model: "sonnet" } },
  { at: at(2), turn: 1, kind: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/src/A.java" }, file: "/repo/src/A.java", parentToolUseId: "ag1" },
  { at: at(3), turn: 1, kind: "tool_use", id: "ag2", name: "Task", input: { description: "nested" }, parentToolUseId: "ag1" },
  { at: at(4), turn: 1, kind: "tool_use", id: "e2", name: "Write", input: { file_path: "/repo/src/B.java" }, file: "/repo/src/B.java", parentToolUseId: "ag2" },
  { at: at(5), turn: 1, kind: "tool_result", toolUseId: "ag2", isError: true, preview: "API Error: 529", parentToolUseId: "ag1" },
  { at: at(9), turn: 1, kind: "tool_result", toolUseId: "ag1", isError: false, preview: "## 결과\n필터 순서를 고쳤어요", agentUsage: { tokens: 35_000, toolUses: 12, durationMs: 8_000 }, cliAgentId: "a1b2" },
  { at: at(10), turn: 2, kind: "user_message", text: "next" },
  { at: at(11), turn: 2, kind: "tool_use", id: "ag3", name: "Agent", input: { subagent_type: "Explore", description: "bg", run_in_background: true } },
  { at: at(12), turn: 2, kind: "tool_result", toolUseId: "ag3", isError: false, preview: "Async agent launched" },
  { at: at(13), turn: 2, kind: "tool_use", id: "ag4", name: "Agent", input: { subagent_type: "architect", description: "검토" } },
  { at: at(14), turn: 2, kind: "tool_result", toolUseId: "ag4", isError: true, preview: "[Request interrupted by user for tool use]", stoppedBy: "user" },
  { at: at(15), turn: 2, kind: "tool_use", id: "ag5", name: "Agent", input: { description: "no result (the engine stopped)" } },
];

describe("agentHistoryFromRows (§42.4)", () => {
  it("rebuilds finished agents from the Agent / Task rows, newest first, as hud.agentHistory keeps them", () => {
    const got = agentHistoryFromRows(rows, (p) => p.replace("/repo/", ""));
    // Newest start first, as the live tracker moves a turn's agents (start order, reversed).
    expect(got.map((n) => [n.toolUseId, n.status, n.turn, n.depth])).toEqual([
      ["ag5", "stopped", 2, 1],
      ["ag4", "stopped", 2, 1],
      ["ag2", "failed", 1, 2],
      ["ag1", "completed", 1, 1],
    ]);
    const ag1 = got.find((n) => n.toolUseId === "ag1")!;
    expect(ag1).toMatchObject({
      type: "oh-my-claudecode:executor",
      description: "필터 순서 수정",
      model: "sonnet",
      tokens: 35_000,
      toolUses: 12,
      durationMs: 8_000,
      cliAgentId: "a1b2",
      files: ["src/A.java", "src/B.java"],
      startedAt: Date.parse(at(1)),
      endedAt: Date.parse(at(9)),
      reportPreview: "## 결과\n필터 순서를 고쳤어요",
      isBackground: false,
    });
    expect(ag1).not.toHaveProperty("prompt");
    expect(got.find((n) => n.toolUseId === "ag2")).toMatchObject({ parentToolUseId: "ag1", error: "API Error: 529", files: ["src/B.java"] });
    expect(got.find((n) => n.toolUseId === "ag4")).toMatchObject({ stoppedBy: "user" });
    // A background agent's result is only the launch: its end is not in the rows, so it is left out.
    expect(got.some((n) => n.toolUseId === "ag3")).toBe(false);
  });

  it("§52.2: a background agent whose end is in the rows (agentEnded, its call's last result) comes back as one", () => {
    const withEnd: TranscriptItem[] = [
      ...rows.slice(0, 9),
      { at: at(12), turn: 2, kind: "tool_result", toolUseId: "ag3", isError: false, preview: "Async agent launched", agentLaunched: true },
      { at: at(16), turn: 2, kind: "tool_use", id: "e3", name: "Write", input: { file_path: "/repo/src/C.java" }, file: "/repo/src/C.java", parentToolUseId: "ag3" },
      { at: at(20), turn: 2, kind: "tool_result", toolUseId: "ag3", isError: false, preview: "C.java를 만들었어요", agentEnded: true, agentUsage: { tokens: 1_200, toolUses: 2, durationMs: 9_000 } },
    ];
    const got = agentHistoryFromRows(withEnd, (p) => p.replace("/repo/", ""));
    expect(got.find((n) => n.toolUseId === "ag3")).toMatchObject({
      status: "completed", isBackground: true, files: ["src/C.java"], reportPreview: "C.java를 만들었어요", tokens: 1_200, endedAt: Date.parse(at(20)),
    });
    // Launched only (no end in the rows): left out, as before.
    expect(agentHistoryFromRows(withEnd.slice(0, 10), (p) => p).some((n) => n.toolUseId === "ag3")).toBe(false);
  });

  it("the tracker takes them once, only while it knows no history of its own", () => {
    const t = new AgentTracker(() => 1_000);
    const nodes = agentHistoryFromRows(rows, (p) => p);
    expect(t.restoreHistory(nodes)).toBe(true);
    expect(t.history.map((n) => n.toolUseId)).toEqual(["ag5", "ag4", "ag2", "ag1"]);
    expect(t.restoreHistory([])).toBe(false);
    t.reset();
    const many = Array.from({ length: 80 }, (_, i) => ({ ...nodes[0]!, id: `x${i}`, toolUseId: `x${i}` }));
    t.restoreHistory(many);
    expect(t.history).toHaveLength(AGENT_HISTORY_MAX);
  });
});
