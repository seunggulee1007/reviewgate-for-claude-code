import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { activityDetail, ClaudeSession } from "../src/session/claude.js";
import { AgentTracker, AGENT_HISTORY_MAX } from "../src/session/agents.js";
import { toolLabel } from "../src/session/toolLabel.js";
import type { SessionEvent } from "../src/session/events.js";

/** MARK: wave4b w4b-agents — §39.3: what a subagent is doing now, what it left, where it worked. */
function harness() {
  let clock = 1_000;
  const tracker = new AgentTracker(() => clock);
  const session = new ClaudeSession({
    cwd: "/repo",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e: SessionEvent) => {
      if (e.type === "tool_use") tracker.onToolUse(e);
      else if (e.type === "tool_result") tracker.onToolResult(e.toolUseId, e.isError);
      else if (e.type === "agent_signal") tracker.onSignal(e.signal);
    },
    log: () => {},
  });
  const feed = (m: Record<string, unknown>) =>
    (session as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ uuid: "u", session_id: "s", ...m } as unknown as SDKMessage);
  const tick = (ms: number) => (clock += ms);
  const node = (toolUseId: string) => tracker.list.find((n) => n.toolUseId === toolUseId)!;
  return { feed, tick, tracker, node, now: () => clock };
}

const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: `m-${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 0, output_tokens: 0 } },
});
const done = (id: string, isError = false, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
});

describe("§39.3 lastStep", () => {
  it("is the agent's latest call with the HUD's detail, ended by its result", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "Run tests", subagent_type: "test-engineer", prompt: "go" }));
    expect(h.node("ag1").lastStep).toBeUndefined();
    h.tick(500);
    h.feed(call("b1", "Bash", { command: "./gradlew :acme-api:test" }, "ag1"));
    expect(h.node("ag1").lastStep).toEqual({ tool: "Bash", detail: "./gradlew :acme-api:test", since: 1_500 });
    expect(h.node("ag1").lastTool).toBe("Bash");
    expect(h.node("ag1").activeAt).toBe(1_500);
    h.tick(250_000);
    h.feed(done("b1", false, "ag1"));
    expect(h.node("ag1").lastStep).toEqual({ tool: "Bash", detail: "./gradlew :acme-api:test", since: 1_500, endedAt: 251_500 });
    expect(h.node("ag1").activeAt).toBe(251_500);
    h.tick(1_000);
    h.feed(call("e1", "Edit", { file_path: "/repo/src/CartService.java", old_string: "a", new_string: "b" }, "ag1"));
    expect(h.node("ag1").lastStep).toEqual({ tool: "Edit", detail: "CartService.java", since: 252_500 });
  });

  it("names an MCP call by its representative argument and a Skill by its name", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "Read the task", subagent_type: "executor", prompt: "go" }));
    h.feed(call("m1", "mcp__acme__acme_list_issues", { state: "open", issueNumber: 1800 }, "ag1"));
    expect(h.node("ag1").lastStep).toMatchObject({ tool: "mcp__acme__acme_list_issues", detail: "1800" });
    h.feed(call("s1", "Skill", { skill: "acme-tools:smoke" }, "ag1"));
    expect(h.node("ag1").lastStep).toMatchObject({ tool: "Skill", detail: "acme-tools:smoke" });
  });

  it("does not move a finished agent's step, and a nested agent's call is its own", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "outer", subagent_type: "executor", prompt: "go" }));
    h.feed(call("ag2", "Agent", { description: "inner", subagent_type: "explore", prompt: "go" }, "ag1"));
    h.feed(call("g1", "Grep", { pattern: "CartFilter" }, "ag2"));
    expect(h.node("ag2").lastStep).toMatchObject({ tool: "Grep", detail: "CartFilter" });
    expect(h.node("ag1").lastStep).toMatchObject({ tool: "Agent", detail: "inner" });
    h.feed(done("ag1"));
    expect(h.node("ag1").lastStep).toBeUndefined();
    expect(h.node("ag1").activeAt).toBeUndefined();
    h.feed(call("r1", "Read", { file_path: "/repo/A.java" }, "ag1"));
    expect(h.node("ag1").lastStep).toBeUndefined();
  });
});

describe("§39.3 retry", () => {
  it("keeps subagent_retry until the agent's next call", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "x", subagent_type: "executor", prompt: "go" }));
    h.tick(10);
    h.feed({
      type: "tool_progress",
      tool_use_id: "ag1",
      tool_name: "Agent",
      parent_tool_use_id: null,
      elapsed_time_seconds: 40,
      subagent_retry: { agent_id: "a-1", attempt: 3, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error_category: "overloaded" },
    });
    expect(h.node("ag1").retry).toEqual({ attempt: 3, max: 10, at: 1_010, status: 529 });
    expect(h.node("ag1").activeAt).toBe(1_010);
    h.feed(call("r1", "Read", { file_path: "/repo/A.java" }, "ag1"));
    expect(h.node("ag1").retry).toBeUndefined();
  });

  it("also reads a retry the CLI sends as a heartbeat, and a progress line of an inner call", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "x", subagent_type: "executor", prompt: "go" }));
    h.feed({
      type: "tool_progress",
      tool_use_id: "ag1",
      tool_name: "Agent",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3,
      heartbeat: true,
      subagent_retry: { agent_id: "a-1", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error_category: "connection" },
    });
    expect(h.node("ag1").retry).toEqual({ attempt: 1, max: 10, at: 1_000, status: null });
    h.tick(5_000);
    h.feed({ type: "tool_progress", tool_use_id: "b9", tool_name: "Bash", parent_tool_use_id: "ag1", elapsed_time_seconds: 4 });
    expect(h.node("ag1").lastStep).toEqual({ tool: "Bash", since: 2_000 });
    expect(h.node("ag1").activeAt).toBe(6_000);
  });
});

describe("§39.3 agentHistory", () => {
  it("keeps the finished agents of earlier turns, newest first, without their instructions", () => {
    const h = harness();
    h.tracker.setTurn(1);
    h.feed(call("ag1", "Agent", { description: "first", subagent_type: "executor", prompt: "long instructions" }));
    h.feed(call("ag2", "Agent", { description: "bg", subagent_type: "explore", prompt: "p", run_in_background: true }));
    h.feed(done("ag1"));
    expect(h.node("ag1").turn).toBe(1);
    expect(h.tracker.history).toEqual([]);
    h.tracker.beginTurn();
    h.tracker.setTurn(2);
    expect(h.tracker.list.map((n) => n.toolUseId)).toEqual(["ag2"]);
    expect(h.tracker.history.map((n) => [n.toolUseId, n.turn, n.status])).toEqual([["ag1", 1, "completed"]]);
    expect(h.tracker.history[0]!.prompt).toBeUndefined();
    h.feed(call("ag3", "Agent", { description: "second", subagent_type: "architect", prompt: "p" }));
    h.feed(done("ag3"));
    h.tracker.beginTurn();
    expect(h.tracker.history.map((n) => n.toolUseId)).toEqual(["ag3", "ag1"]);
    expect(h.tracker.history[0]!.turn).toBe(2);
  });

  it("is bounded and cleared with the session", () => {
    const h = harness();
    for (let i = 0; i < AGENT_HISTORY_MAX + 5; i++) {
      h.feed(call(`a${i}`, "Agent", { description: `n${i}`, subagent_type: "executor", prompt: "p" }));
      h.feed(done(`a${i}`));
      h.tracker.beginTurn();
    }
    expect(h.tracker.history).toHaveLength(AGENT_HISTORY_MAX);
    expect(h.tracker.history[0]!.toolUseId).toBe(`a${AGENT_HISTORY_MAX + 4}`);
    h.tracker.reset();
    expect(h.tracker.history).toEqual([]);
  });

  it("drops a continued agent from the history when it comes back into this turn's list", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "first", subagent_type: "executor", prompt: "p" }));
    h.feed({ type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "ag1", description: "first", subagent_type: "executor", task_type: "local_agent" });
    h.feed({ type: "system", subtype: "task_notification", task_id: "t-1", tool_use_id: "ag1", status: "completed", summary: "done" });
    h.feed(done("ag1"));
    h.tracker.beginTurn();
    expect(h.tracker.history.map((n) => n.toolUseId)).toEqual(["ag1"]);
    h.feed(call("sm1", "SendMessage", { to: "t-1", message: "again" }));
    h.feed({ type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "sm1", description: "first", subagent_type: "executor", task_type: "local_agent" });
    expect(h.tracker.list.map((n) => n.toolUseId)).toEqual(["ag1"]);
    expect(h.tracker.history).toEqual([]);
  });
});

describe("§39.3 isolation", () => {
  it("records the Agent call's isolation and the worktree it reported", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "x", subagent_type: "executor", prompt: "p", isolation: "worktree" }));
    expect(h.node("ag1").isolation).toBe("worktree");
    expect(h.tracker.noteWorktree("ag1", "/repo/.claude/worktrees/agent-a1", "worktree-agent-a1")).toBe(true);
    expect(h.node("ag1")).toMatchObject({ worktreePath: "/repo/.claude/worktrees/agent-a1", worktreeBranch: "worktree-agent-a1" });
    expect(h.tracker.noteWorktree("ag1", "/repo/.claude/worktrees/agent-a1", "worktree-agent-a1")).toBe(false);
    expect(h.tracker.noteWorktree("nope", "/x", undefined)).toBe(false);
  });
});

describe("§39.3 the HUD's detail of an MCP call", () => {
  it("is the call's representative argument", () => {
    expect(activityDetail("mcp__acme__acme_list_issues", { state: "open", issueNumber: 1800 }, undefined)).toBe("1800");
    expect(activityDetail("mcp__claude-in-chrome__tabs_context_mcp", {}, undefined)).toBeUndefined();
    expect(activityDetail("Skill", { skill: "acme-tools:smoke" }, undefined)).toBe("acme-tools:smoke");
  });
});

describe("§39.3 toolLabel (the rule both clients share)", () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/toolLabels.json"), "utf8")) as {
    cases: { name: string; input: Record<string, unknown>; label: unknown }[];
  };
  for (const c of fixture.cases) {
    it(`${c.name} ${JSON.stringify(c.input).slice(0, 40)}`, () => {
      expect(toolLabel(c.name, c.input)).toEqual(c.label);
    });
  }
});
