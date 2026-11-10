import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import { AgentTracker } from "../src/session/agents.js";
import type { SessionEvent } from "../src/session/events.js";
import { relativeInside } from "../src/platform/paths.js";
import { resolve } from "node:path";

/**
 * Synthetic SDK streams through the real SDK → event translation (claude.ts) into `AgentTracker`,
 * the way the engine wires them (tool_use / tool_result / tool_files / agent_signal).
 */
function harness() {
  let clock = 1_000;
  const events: SessionEvent[] = [];
  // As the engine does it (repoRelative): `/repo` is `D:\\repo` on a Windows runner.
  const tracker = new AgentTracker(() => clock, (p) => relativeInside(p, resolve("/repo")) ?? p);
  const session = new ClaudeSession({
    cwd: "/repo",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => {
      events.push(e);
      if (e.type === "tool_use") tracker.onToolUse(e);
      else if (e.type === "tool_result") tracker.onToolResult(e.toolUseId, e.isError);
      else if (e.type === "tool_files") tracker.onToolFiles(e.toolUseId, e.files);
      else if (e.type === "agent_signal") tracker.onSignal(e.signal);
    },
    log: () => {},
  });
  const feed = (m: Record<string, unknown>) =>
    (session as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ uuid: "u", session_id: "s", ...m } as unknown as SDKMessage);
  const bashFiles = (id: string, files: string[]) =>
    (session as unknown as { hookCtx: { onBashFiles: (id: string, f: string[]) => void } }).hookCtx.onBashFiles(id, files);
  const tick = (ms: number) => (clock += ms);
  const node = (toolUseId: string) => tracker.list.find((n) => n.toolUseId === toolUseId)!;
  return { feed, bashFiles, tick, tracker, events, node };
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
const sys = (subtype: string, fields: Record<string, unknown>) => ({ type: "system", subtype, ...fields });
const usage = (total_tokens: number, tool_uses: number, duration_ms: number) => ({ total_tokens, tool_uses, duration_ms });

describe("AgentTracker: SDK task messages", () => {
  it("builds a node from task_started / task_progress / tool_progress / task_notification and attributes its edits", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "Explore auth", subagent_type: "Explore", prompt: "look" }));
    expect(h.node("ag1")).toMatchObject({ id: "ag1", status: "running", type: "Explore", depth: 1, isBackground: false });
    h.feed(sys("task_started", { task_id: "task-1", tool_use_id: "ag1", description: "Explore auth", subagent_type: "Explore", task_type: "local_agent", is_backgrounded: false, spawn_depth: 1 }));
    h.feed(call("e1", "Edit", { file_path: "/repo/src/a.ts" }, "ag1"));
    h.feed(call("r1", "Read", { file_path: "/repo/src/b.ts" }, "ag1"));
    h.feed(sys("task_progress", { task_id: "task-1", tool_use_id: "ag1", description: "Explore auth", usage: usage(1200, 3, 4000), last_tool_name: "Grep", summary: "Reading the auth module" }));
    h.feed({ type: "tool_progress", tool_use_id: "b1", tool_name: "Bash", parent_tool_use_id: "ag1", elapsed_time_seconds: 2, task_id: "task-1" });
    expect(h.node("ag1")).toMatchObject({ id: "task-1", lastTool: "Bash", summary: "Reading the auth module", tokens: 1200, toolUses: 3, durationMs: 4000, files: ["src/a.ts"] });
    expect(h.tracker.foregroundRunning).toBe(1);
    h.tick(5000);
    h.feed(sys("task_notification", { task_id: "task-1", tool_use_id: "ag1", status: "completed", output_file: "", summary: "Found it", usage: usage(2000, 5, 5000) }));
    h.feed(done("ag1"));
    expect(h.tracker.list).toEqual([{
      id: "task-1", toolUseId: "ag1", type: "Explore", description: "Explore auth", status: "completed", isBackground: false, depth: 1,
      lastTool: "Bash", summary: "Found it", tokens: 2000, toolUses: 5, durationMs: 5000, startedAt: 1000, endedAt: 6000, files: ["src/a.ts"],
      prompt: "look", model: null, // §36.1
    }]);
    expect(h.tracker.foregroundRunning).toBe(0);
  });

  it("nested agents get depth N+1 and their files count for every ancestor; Bash files reach the agent that ran it", () => {
    const h = harness();
    h.feed(call("outer", "Agent", { description: "outer" }));
    h.feed(call("inner", "Task", { description: "inner", subagent_type: "general-purpose" }, "outer"));
    h.feed(sys("task_started", { task_id: "t-in", tool_use_id: "inner", description: "inner", task_type: "local_agent", spawn_depth: 2 }));
    h.feed(call("w1", "Write", { file_path: "/repo/x.ts" }, "inner"));
    h.feed(call("b1", "Bash", { command: "touch y.ts" }, "inner"));
    h.bashFiles("b1", [resolve("/repo/y.ts")]); // post-Bash files arrive absolute (native)
    expect(h.node("inner")).toMatchObject({ parentToolUseId: "outer", depth: 2, files: ["x.ts", "y.ts"] });
    expect(h.node("outer")).toMatchObject({ depth: 1, files: ["x.ts", "y.ts"] });
    expect(h.node("outer")).not.toHaveProperty("parentToolUseId");
  });

  it("background agents survive turn end and the next beginTurn; finished ones are dropped at the next turn", () => {
    const h = harness();
    h.feed(call("bg", "Agent", { description: "bg", run_in_background: true }));
    h.feed(sys("task_started", { task_id: "t-bg", tool_use_id: "bg", description: "bg", task_type: "local_agent", is_backgrounded: true }));
    h.feed(done("bg")); // "Async agent launched" placeholder
    h.feed(call("fg", "Agent", { description: "fg" }));
    h.feed(sys("task_started", { task_id: "t-fg", tool_use_id: "fg", description: "fg", task_type: "local_agent", is_backgrounded: false }));
    expect(h.node("bg").status).toBe("running");
    expect(h.tracker.foregroundRunning).toBe(1);
    h.tracker.endTurn(); // interrupted: the foreground one never reported back
    expect([h.node("bg").status, h.node("fg").status]).toEqual(["running", "stopped"]);
    h.tracker.beginTurn();
    expect(h.tracker.list.map((n) => n.toolUseId)).toEqual(["bg"]);
    h.feed(sys("task_updated", { task_id: "t-bg", patch: { status: "failed", error: "boom", end_time: 9999 } }));
    expect(h.node("bg")).toMatchObject({ status: "failed", error: "boom", endedAt: 9999 });
    h.tracker.beginTurn();
    expect(h.tracker.list).toEqual([]);
  });

  it("a foreground agent moved to the background keeps running past its placeholder tool_result; killed reads as stopped", () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "long" }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "ag", description: "long", task_type: "local_agent", is_backgrounded: false }));
    h.feed(sys("task_updated", { task_id: "t", patch: { is_backgrounded: true } }));
    h.feed(done("ag"));
    expect(h.node("ag")).toMatchObject({ status: "running", isBackground: true });
    h.feed(sys("task_updated", { task_id: "t", patch: { status: "killed" } }));
    expect(h.node("ag").status).toBe("stopped");
    expect(h.node("ag").endedAt).toBe(1000);
  });

  it("ignores non-agent and ambient tasks", () => {
    const h = harness();
    h.feed(sys("task_started", { task_id: "sh", tool_use_id: "b9", description: "npm run dev", task_type: "local_bash", is_backgrounded: true }));
    h.feed(sys("task_started", { task_id: "amb", description: "watcher", task_type: "local_agent", subagent_type: "x", ambient: true }));
    h.feed(sys("task_progress", { task_id: "sh", description: "npm run dev", usage: usage(0, 0, 10) }));
    expect(h.tracker.list).toEqual([]);
  });
});

describe("AgentTracker: fallback without task messages (older CLI)", () => {
  it("creates nodes from Agent/Task tool_use and closes them from the tool_result", () => {
    const h = harness();
    h.feed(call("a1", "Task", { description: "one" }));
    h.feed(call("a2", "Agent", { description: "two", subagent_type: "Plan", run_in_background: true }));
    h.feed(call("e", "MultiEdit", { file_path: "/repo/m.ts" }, "a1"));
    expect(h.tracker.foregroundRunning).toBe(1);
    h.tick(10);
    h.feed(done("a1"));
    h.feed(done("a2", true));
    expect(h.tracker.list.map((n) => [n.id, n.type, n.status, n.lastTool, n.files, n.endedAt])).toEqual([
      ["a1", "general-purpose", "completed", "MultiEdit", ["m.ts"], 1010],
      ["a2", "Plan", "failed", undefined, [], 1010],
    ]);
    // The HUD activity events are unchanged.
    expect(h.events.filter((e) => e.type === "activity" && e.kind.startsWith("subagent")).map((e) => (e as { kind: string }).kind))
      .toEqual(["subagent_start", "subagent_start", "subagent_end", "subagent_end"]);
  });

  it("stopAll ends everything when the CLI is gone", () => {
    const h = harness();
    h.feed(call("a1", "Agent", { description: "x", run_in_background: true }));
    expect(h.tracker.stopAll()).toBe(true);
    expect(h.node("a1").status).toBe("stopped");
    expect(h.tracker.stopAll()).toBe(false);
  });
});
