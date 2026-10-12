import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import { AgentTracker } from "../src/session/agents.js";
import type { SessionEvent } from "../src/session/events.js";

/**
 * docs/PROTOCOL.md §36.1–36.4 at the session layer: synthetic SDK streams through the real SDK → event translation
 * (claude.ts) into `AgentTracker`, wired the way the engine does it.
 */
function harness() {
  let clock = 1_000;
  const events: SessionEvent[] = [];
  const tracker = new AgentTracker(() => clock);
  const session = new ClaudeSession({
    cwd: "/repo",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => {
      events.push(e);
      if (e.type === "tool_use") tracker.onToolUse(e);
      else if (e.type === "tool_result") {
        tracker.onToolResult(e.toolUseId, e.isError);
        tracker.onAgentResult({ toolUseId: e.toolUseId, isError: e.isError, ...(e.keptReport ? { report: e.keptReport } : {}), ...(e.agentUsage ? { usage: e.agentUsage } : {}), ...(e.cliAgentId ? { cliAgentId: e.cliAgentId } : {}) });
      } else if (e.type === "agent_signal") tracker.onSignal(e.signal);
    },
    log: () => {},
  });
  const feed = (m: Record<string, unknown>) =>
    (session as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ uuid: "u", session_id: "s", ...m } as unknown as SDKMessage);
  const results = () => events.filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");
  const node = (toolUseId: string) => tracker.list.find((n) => n.toolUseId === toolUseId)!;
  const tick = (ms: number) => (clock += ms);
  return { session, feed, events, results, tracker, node, tick };
}

const sys = (subtype: string, fields: Record<string, unknown>) => ({ type: "system", subtype, ...fields });

const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: `m-${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 0, output_tokens: 0 } },
});
const result = (id: string, content: unknown, isError = false, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});

const PREAMBLE = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:";
const handBack = (report: string, agentId = "a336931a321e346be") =>
  `${PREAMBLE}\n${report.split("\n").map((l) => `  ${l}`).join("\n")}\nagentId: ${agentId} (use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 14794\ntool_uses: 12\nduration_ms: 491500</usage>`;

describe("Agent / Task results (§36.1)", () => {
  it("the event shows the cleaned report: preview / truncated about it, agentUsage, cliAgentId, the kept report and the why report", () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "coupon codes", subagent_type: "Explore", prompt: "find every couponCode use", model: "opus" }));
    const report = "## 쿠폰 코드 사용처 14곳\n" + "- api/src/main/Coupon.java: 키 검증\n".repeat(30);
    h.feed(result("ag", [{ type: "text", text: handBack(report.trimEnd()) }]));
    const [ev] = h.results();
    expect(ev!.preview).toBe(report.slice(0, 500));
    expect(ev!.truncated).toBe(true);
    expect(ev!.agentUsage).toEqual({ tokens: 14794, toolUses: 12, durationMs: 491500 });
    expect(ev!.cliAgentId).toBe("a336931a321e346be");
    expect(ev!.keptReport).toEqual({ text: report.trimEnd(), truncated: false });
    expect(ev!.agentReport!.startsWith("## 쿠폰 코드 사용처 14곳")).toBe(true);
  });

  it("another CLI's result is kept as it came; a report over 50 000 chars is kept cut and marked", () => {
    const h = harness();
    h.feed(call("a1", "Task", { description: "x", prompt: "p" }));
    h.feed(result("a1", "plain report"));
    h.feed(call("a2", "Agent", { description: "y", prompt: "p" }));
    h.feed(result("a2", handBack("z".repeat(60_000))));
    const [one, two] = h.results();
    expect(one).toMatchObject({ preview: "plain report", keptReport: { text: "plain report", truncated: false } });
    expect(one).not.toHaveProperty("agentUsage");
    expect(one).not.toHaveProperty("cliAgentId");
    expect(two!.keptReport!.text.length).toBe(50_000);
    expect(two!.keptReport!.truncated).toBe(true);
    expect(two!.preview).toBe("z".repeat(500));
  });

  it("an error result (stopped, failed) is no report: nothing kept, the preview is its text", () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "slow", prompt: "sleep" }));
    h.feed(result("ag", [{ type: "text", text: "[Request interrupted by user for tool use]" }], true));
    const [ev] = h.results();
    expect(ev).toMatchObject({ isError: true, preview: "[Request interrupted by user for tool use]" });
    expect(ev).not.toHaveProperty("keptReport");
  });

  it("other tools are untouched, even with frame-like text", () => {
    const h = harness();
    h.feed(call("r1", "Read", { file_path: "/repo/a.md" }));
    h.feed(result("r1", handBack("text")));
    const [ev] = h.results();
    expect(ev!.preview.startsWith("[Subagent hand-back]")).toBe(true);
    expect(ev).not.toHaveProperty("keptReport");
    expect(ev).not.toHaveProperty("cliAgentId");
  });
});

describe("AgentNode details and the kept report (§36.1)", () => {
  it("prompt (first 8 000 chars) and model come from the Agent call; null when it named no model", () => {
    const h = harness();
    const prompt = "couponCode 가 쓰이는 곳을 모두 찾아.\n" + "p".repeat(9_000);
    h.feed(call("ag1", "Agent", { description: "keys", subagent_type: "Explore", prompt, model: "opus" }));
    h.feed(call("ag2", "Task", { description: "other", prompt: "short" }));
    expect(h.node("ag1").prompt).toBe(prompt.slice(0, 8_000));
    expect(h.node("ag1").model).toBe("opus");
    expect(h.node("ag2")).toMatchObject({ prompt: "short", model: null });
  });

  it("task_started.prompt fills a node whose call carried none; the call's prompt wins otherwise", () => {
    const h = harness();
    h.feed(call("ag1", "Agent", { description: "d" }));
    h.feed(sys("task_started", { task_id: "t1", tool_use_id: "ag1", description: "d", task_type: "local_agent", prompt: "from the task" }));
    h.feed(call("ag2", "Agent", { description: "e", prompt: "from the call" }));
    h.feed(sys("task_started", { task_id: "t2", tool_use_id: "ag2", description: "e", task_type: "local_agent", prompt: "from the task" }));
    expect([h.node("ag1").prompt, h.node("ag2").prompt]).toEqual(["from the task", "from the call"]);
  });

  it("the result sets reportPreview (600 chars), cliAgentId and the final usage over the task messages'; report() answers from memory", () => {
    const h = harness();
    const prompt = "x".repeat(60_000);
    h.feed(call("ag", "Agent", { description: "d", subagent_type: "executor", prompt, model: "sonnet" }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "ag", description: "d", task_type: "local_agent" }));
    h.feed(sys("task_progress", { task_id: "t", tool_use_id: "ag", description: "d", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }));
    expect(h.tracker.report("ag")).toBe("no_report"); // still running
    h.feed(sys("task_notification", { task_id: "t", tool_use_id: "ag", status: "completed", output_file: "", summary: "s", usage: { total_tokens: 2, tool_uses: 2, duration_ms: 2 } }));
    const report = "보고서 ".repeat(200).trim();
    h.feed(result("ag", handBack(report, "a77")));
    expect(h.node("ag")).toMatchObject({ status: "completed", reportPreview: report.slice(0, 600), cliAgentId: "a77", tokens: 14794, toolUses: 12, durationMs: 491500 });
    expect(h.tracker.report("ag")).toEqual({
      type: "agent_report", toolUseId: "ag", text: report, truncated: false,
      usage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, model: "sonnet", prompt: prompt.slice(0, 50_000),
    });
    expect(h.tracker.report("nope")).toBeUndefined();
  });

  it("an error result keeps no report (no_report); without a <usage> block the task messages' numbers are the usage", () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "d", prompt: "p" }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "ag", description: "d", task_type: "local_agent" }));
    h.feed(result("ag", "[Request interrupted by user for tool use]", true));
    expect(h.node("ag")).not.toHaveProperty("reportPreview");
    expect(h.tracker.report("ag")).toBe("no_report");
    h.feed(call("ag2", "Agent", { description: "e", prompt: "q" }));
    h.feed(sys("task_notification", { task_id: "t2", tool_use_id: "ag2", status: "completed", output_file: "", summary: "s", usage: { total_tokens: 5, tool_uses: 6, duration_ms: 7 } }));
    h.feed(result("ag2", "plain report"));
    expect(h.tracker.report("ag2")).toMatchObject({ text: "plain report", usage: { tokens: 5, toolUses: 6, durationMs: 7 }, model: null, prompt: "q" });
  });

  it("a background agent's placeholder result is no report", () => {
    const h = harness();
    h.feed(call("bg", "Agent", { description: "d", prompt: "p", run_in_background: true }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "bg", description: "d", task_type: "local_agent", is_backgrounded: true }));
    h.feed(result("bg", "Async agent launched successfully."));
    expect(h.node("bg")).toMatchObject({ status: "running" });
    expect(h.node("bg")).not.toHaveProperty("reportPreview");
    expect(h.tracker.report("bg")).toBe("no_report");
  });
});

describe("stopping one agent (§36.2)", () => {
  const twoAgents = () => {
    const h = harness();
    h.feed(call("slow", "Agent", { description: "slow", prompt: "sleep 40" }));
    h.feed(sys("task_started", { task_id: "t-slow", tool_use_id: "slow", description: "slow", task_type: "local_agent", is_backgrounded: false }));
    h.feed(call("fast", "Agent", { description: "fast", prompt: "sleep 12" }));
    h.feed(sys("task_started", { task_id: "t-fast", tool_use_id: "fast", description: "fast", task_type: "local_agent", is_backgrounded: false }));
    return h;
  };

  it("stopTarget names the task id, or why not: unknown_agent / not_running / not_supported (no task id)", () => {
    const h = twoAgents();
    h.feed(call("old", "Agent", { description: "fallback only" })); // no task message for it
    expect(h.tracker.stopTarget("slow")).toEqual({ taskId: "t-slow" });
    expect(h.tracker.stopTarget("nope")).toBe("unknown_agent");
    expect(h.tracker.stopTarget("old")).toBe("not_supported");
    h.feed(sys("task_notification", { task_id: "t-fast", tool_use_id: "fast", status: "completed", output_file: "", summary: "fast done" }));
    expect(h.tracker.stopTarget("fast")).toBe("not_running");
  });

  it("the CLI's order (notification, then the interrupted result, then stopTask returns): stopped by the user; the other agent runs on", () => {
    const h = twoAgents();
    h.tracker.requestStop("slow");
    h.tick(6_000);
    h.feed(sys("task_notification", { task_id: "t-slow", tool_use_id: "slow", status: "stopped", output_file: "", summary: "slow" }));
    expect(h.node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user", endedAt: 7_000 });
    expect(h.tracker.stoppedByUser("slow", true)).toBe(true);
    h.feed(result("slow", "[Request interrupted by user for tool use]", true));
    expect(h.tracker.confirmStop("slow")).toBe(false);
    expect(h.node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(h.node("fast")).toMatchObject({ status: "running" });
    expect(h.tracker.foregroundRunning).toBe(1);
  });

  it("the interrupted result first: stopped by the user, not failed; stopTask returning first: stopped by the user at once", () => {
    const h = twoAgents();
    h.tracker.requestStop("slow");
    expect(h.tracker.stoppedByUser("slow", true)).toBe(true);
    expect(h.tracker.stoppedByUser("slow", false)).toBe(false);
    h.feed(result("slow", "[Request interrupted by user for tool use]", true));
    expect(h.node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    h.feed(sys("task_notification", { task_id: "t-slow", tool_use_id: "slow", status: "stopped", output_file: "", summary: "slow" }));
    expect(h.node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    h.tracker.requestStop("fast");
    expect(h.tracker.confirmStop("fast")).toBe(true);
    expect(h.node("fast")).toMatchObject({ status: "stopped", stoppedBy: "user" });
  });

  it("an agent that completed on its own before the stop landed is not the user's; a failed stopTask leaves no trace", () => {
    const h = twoAgents();
    h.tracker.requestStop("slow");
    h.feed(sys("task_notification", { task_id: "t-slow", tool_use_id: "slow", status: "completed", output_file: "", summary: "done" }));
    h.feed(result("slow", "report"));
    expect(h.tracker.confirmStop("slow")).toBe(false);
    expect(h.node("slow").status).toBe("completed");
    expect(h.node("slow")).not.toHaveProperty("stoppedBy");
    expect(h.tracker.stoppedByUser("slow", false)).toBe(false);
    h.tracker.requestStop("fast");
    h.tracker.cancelStop("fast");
    h.tracker.endTurn(); // an interrupt: stopped, but not by `stop_agent`
    expect(h.node("fast")).toMatchObject({ status: "stopped" });
    expect(h.node("fast")).not.toHaveProperty("stoppedBy");
  });
});

describe("agents continued with SendMessage (§36.3)", () => {
  const RESUMED = '{"success":true,"message":"Resumed agent. Its final report follows this JSON, framed by the harness."}';
  /** CLI 2.1.307 as observed (audit agents-15, perm-exp/resume3.log): the agent finished, then SendMessage continues it. */
  const finishedAgent = () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "helper", subagent_type: "executor", prompt: "Reply with the word ready.", model: "haiku" }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "ag", description: "helper", task_type: "local_agent", is_backgrounded: false }));
    h.feed(sys("task_updated", { task_id: "a336931a321e346be", patch: { status: "completed", end_time: 1_500 } }));
    h.feed(sys("task_notification", { task_id: "a336931a321e346be", tool_use_id: "ag", status: "completed", output_file: "", summary: "ready" }));
    h.feed(result("ag", handBack("ready", "a336931a321e346be")));
    return h;
  };

  it("continuationOf names the agent a SendMessage `to` addresses — by the CLI's agent id or the task id — and nothing else", () => {
    const h = finishedAgent();
    const cont = { agentToolUseId: "ag", agentType: "executor" };
    expect(h.tracker.continuationOf("SendMessage", { to: "a336931a321e346be", message: "m" })).toEqual(cont);
    expect(h.tracker.continuationOf("SendMessage", { to: "other-session", message: "m" })).toBeUndefined();
    expect(h.tracker.continuationOf("Agent", { to: "a336931a321e346be" })).toBeUndefined();
    expect(h.tracker.continuationOf("SendMessage", {})).toBeUndefined();
  });

  it("the continued run: running again (no endedAt), resumeCount 1, resumedBy, in the foreground while SendMessage blocks; its inner calls update it; its report is the SendMessage's", () => {
    const h = finishedAgent();
    expect(h.node("ag")).toMatchObject({ status: "completed", endedAt: 1_500, cliAgentId: "a336931a321e346be" });
    h.tick(5_000);
    h.feed(call("sm", "SendMessage", { to: "a336931a321e346be", summary: "run tests", message: "Now run `sleep 8 && touch c.txt` and reply done." }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.node("ag")).toMatchObject({ status: "running", resumeCount: 1, resumedBy: "sm", isBackground: false, startedAt: 1_000 });
    expect(h.node("ag")).not.toHaveProperty("endedAt");
    expect(h.tracker.foregroundRunning).toBe(1);
    h.feed(sys("task_updated", { task_id: "a336931a321e346be", patch: { is_backgrounded: true } }));
    expect(h.node("ag").isBackground).toBe(false);
    h.feed(call("b1", "Bash", { command: "sleep 8 && touch c.txt" }, "ag"));
    h.feed(sys("task_progress", { task_id: "a336931a321e346be", tool_use_id: "sm", description: "helper", usage: { total_tokens: 9, tool_uses: 1, duration_ms: 900 }, last_tool_name: "Bash" }));
    expect(h.node("ag")).toMatchObject({ lastTool: "Bash", tokens: 9 });
    h.tick(10_000);
    h.feed(sys("task_updated", { task_id: "a336931a321e346be", patch: { status: "completed", end_time: 16_000 } }));
    h.feed(sys("task_notification", { task_id: "a336931a321e346be", tool_use_id: "sm", status: "completed", output_file: "", summary: "done" }));
    h.feed(result("sm", `${RESUMED}\n${handBack("done", "a336931a321e346be")}`));
    expect(h.node("ag")).toMatchObject({ status: "completed", endedAt: 16_000, isBackground: false, resumeCount: 1, reportPreview: "ready" });
    expect(h.tracker.report("sm")).toEqual({
      type: "agent_report", toolUseId: "sm", text: "done", truncated: false, usage: { tokens: 14794, toolUses: 12, durationMs: 491500 },
      model: "haiku", prompt: "Now run `sleep 8 && touch c.txt` and reply done.",
    });
    expect(h.tracker.report("ag")).toMatchObject({ text: "ready", prompt: "Reply with the word ready." });
    // A second continuation counts on.
    h.feed(call("sm2", "SendMessage", { to: "a336931a321e346be", message: "once more" }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm2", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.node("ag")).toMatchObject({ status: "running", resumeCount: 2, resumedBy: "sm2" });
  });

  it("a SendMessage that returns before the agent finished leaves it in the background; one returned before the run started never blocked", () => {
    const h = finishedAgent();
    h.feed(call("sm", "SendMessage", { to: "a336931a321e346be", message: "go on" }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.node("ag").isBackground).toBe(false);
    h.feed(result("sm", '{"success":true,"message":"Agent resumed in the background."}'));
    expect(h.node("ag")).toMatchObject({ status: "running", isBackground: true });
    expect(h.tracker.foregroundRunning).toBe(0);
    h.feed(sys("task_notification", { task_id: "a336931a321e346be", tool_use_id: "sm", status: "completed", output_file: "", summary: "done" }));
    h.feed(call("sm2", "SendMessage", { to: "a336931a321e346be", message: "again" }));
    h.feed(result("sm2", '{"success":true,"message":"queued"}'));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm2", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.node("ag")).toMatchObject({ status: "running", resumeCount: 2, isBackground: true });
  });

  it("stopping a continued agent: the interrupted SendMessage says so and does not read as a move to the background", () => {
    const h = finishedAgent();
    h.feed(call("sm", "SendMessage", { to: "a336931a321e346be", message: "go on" }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.tracker.stopTarget("ag")).toEqual({ taskId: "a336931a321e346be" });
    h.tracker.requestStop("ag");
    expect(h.tracker.stoppedByUser("sm", true)).toBe(true);
    h.feed(result("sm", "[Request interrupted by user for tool use]", true));
    expect(h.node("ag")).toMatchObject({ status: "running", isBackground: false });
    h.feed(sys("task_notification", { task_id: "a336931a321e346be", tool_use_id: "sm", status: "stopped", output_file: "", summary: "s" }));
    expect(h.node("ag")).toMatchObject({ status: "stopped", stoppedBy: "user", isBackground: false });
    expect(h.tracker.stoppedByUser("sm", true)).toBe(true);
    expect(h.tracker.stoppedByUser("sm", false)).toBe(false);
  });

  it("after the next turn dropped it, a continuation brings it back under its original toolUseId as a card of this turn", () => {
    const h = finishedAgent();
    h.feed(call("w", "Write", { file_path: "/repo/a.ts" }, "ag"));
    h.tracker.beginTurn();
    expect(h.tracker.list).toEqual([]);
    h.tick(60_000);
    expect(h.tracker.continuationOf("SendMessage", { to: "a336931a321e346be" })).toEqual({ agentToolUseId: "ag", agentType: "executor" });
    h.feed(call("sm", "SendMessage", { to: "a336931a321e346be", message: "gradle 테스트도 돌려줘" }));
    h.feed(sys("task_started", { task_id: "a336931a321e346be", tool_use_id: "sm", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.tracker.list.map((n) => n.toolUseId)).toEqual(["ag"]);
    expect(h.node("ag")).toMatchObject({
      id: "a336931a321e346be", type: "executor", status: "running", resumeCount: 1, resumedBy: "sm", isBackground: false,
      startedAt: 61_000, files: [], prompt: "Reply with the word ready.", model: "haiku", cliAgentId: "a336931a321e346be", depth: 1,
    });
    h.feed(call("e", "Edit", { file_path: "/repo/b.ts" }, "ag"));
    expect(h.node("ag")).toMatchObject({ files: [resolve("/repo/b.ts")], lastTool: "Edit" }); // the session's absolute path (D:\\repo\\b.ts on Windows)
    h.tracker.reset();
    expect(h.tracker.continuationOf("SendMessage", { to: "a336931a321e346be" })).toBeUndefined();
  });
});

describe("waiting on subagents (§36.4)", () => {
  it("counts the live foreground top-level agents and names the one running longest; background and nested ones do not count", () => {
    const h = harness();
    expect(h.tracker.waitingOn()).toBeNull();
    h.feed(call("a1", "Agent", { description: "one", subagent_type: "executor", prompt: "p" }));
    h.feed(sys("task_started", { task_id: "t1", tool_use_id: "a1", description: "one", subagent_type: "executor", task_type: "local_agent", is_backgrounded: false, spawn_depth: 1 }));
    h.tick(1_000);
    h.feed(call("a2", "Agent", { description: "two", subagent_type: "architect", prompt: "p" }));
    h.feed(sys("task_started", { task_id: "t2", tool_use_id: "a2", description: "two", subagent_type: "architect", task_type: "local_agent", is_backgrounded: false, spawn_depth: 1 }));
    h.feed(call("in", "Agent", { description: "nested", prompt: "p" }, "a2"));
    h.feed(sys("task_started", { task_id: "t3", tool_use_id: "in", description: "nested", task_type: "local_agent", is_backgrounded: false, spawn_depth: 2 }));
    h.feed(call("bg", "Agent", { description: "bg", prompt: "p", run_in_background: true }));
    h.feed(sys("task_started", { task_id: "t4", tool_use_id: "bg", description: "bg", task_type: "local_agent", is_backgrounded: true }));
    expect(h.tracker.waitingOn()).toEqual({ count: 2, longest: { toolUseId: "a1", type: "executor", startedAt: 1_000 } });
    h.feed(sys("task_notification", { task_id: "t1", tool_use_id: "a1", status: "completed", output_file: "", summary: "s" }));
    expect(h.tracker.waitingOn()).toEqual({ count: 1, longest: { toolUseId: "a2", type: "architect", startedAt: 2_000 } });
    h.feed(sys("task_notification", { task_id: "t2", tool_use_id: "a2", status: "completed", output_file: "", summary: "s" }));
    expect(h.tracker.waitingOn()).toBeNull();
  });

  it("a blocking continuation counts, from its current run's start", () => {
    const h = harness();
    h.feed(call("ag", "Agent", { description: "helper", subagent_type: "executor", prompt: "p" }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "ag", description: "helper", task_type: "local_agent", is_backgrounded: false }));
    h.feed(sys("task_notification", { task_id: "t", tool_use_id: "ag", status: "completed", output_file: "", summary: "s" }));
    h.tick(30_000);
    h.feed(call("sm", "SendMessage", { to: "t", message: "go on" }));
    h.feed(sys("task_started", { task_id: "t", tool_use_id: "sm", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    expect(h.tracker.waitingOn()).toEqual({ count: 1, longest: { toolUseId: "ag", type: "executor", startedAt: 31_000 } });
    h.feed(result("sm", '{"success":true,"message":"in the background now"}'));
    expect(h.tracker.waitingOn()).toBeNull();
  });
});

describe("SendMessage results (§36.3)", () => {
  it("a continuation's JSON status line and frame go; a message to a session stays as it came", () => {
    const h = harness();
    h.feed(call("sm1", "SendMessage", { to: "a336931a321e346be", message: "gradle 테스트도 돌려줘" }));
    h.feed(result("sm1", `{"success":true,"message":"Resumed agent. Its final report follows this JSON, framed by the harness."}\n${handBack("테스트 42개 통과")}`));
    h.feed(call("sm2", "SendMessage", { to: "other-session", message: "hi" }));
    h.feed(result("sm2", '{"success":true,"message":"Message sent"}'));
    const [resumed, peer] = h.results();
    expect(resumed).toMatchObject({ preview: "테스트 42개 통과", cliAgentId: "a336931a321e346be", keptReport: { text: "테스트 42개 통과", truncated: false } });
    expect(resumed!.agentUsage).toEqual({ tokens: 14794, toolUses: 12, durationMs: 491500 });
    expect(resumed).not.toHaveProperty("agentReport");
    expect(peer).toMatchObject({ preview: '{"success":true,"message":"Message sent"}' });
    expect(peer).not.toHaveProperty("keptReport");
  });
});
