import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

async function opened(dir?: string): Promise<{ h: Harness; dir: string }> {
  const repo = dir ?? realpathSync(makeRepo());
  if (!dir) dirs.push(repo);
  const h = harness();
  await h.hello();
  await h.open(repo);
  return { h, dir: repo };
}

async function started(): Promise<{ h: Harness; dir: string }> {
  const o = await opened();
  await o.h.engine.handle({ type: "send", text: "go" });
  return o;
}

/** The fake reports `sess-1`: the chat's transcript rows. */
const rows = (dir: string) => readFileSync(sessionTranscriptPath(join(dir, ".git"), "sess-1"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

const usage = { tokens: 14794, toolUses: 12, durationMs: 491500 };

describe("the kept report in the transcript (docs/PROTOCOL.md §36.1)", () => {
  it("the row keeps the cleaned report; the wire event and transcript_restore never carry it", async () => {
    const { h, dir } = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "coupon codes", subagent_type: "Explore", prompt: "find couponCode", model: "opus" } });
    s.emit({ type: "tool_result", toolUseId: "ag1", isError: false, preview: "## 사용처 14곳", agentUsage: usage, cliAgentId: "a1b2", keptReport: { text: "## 사용처 14곳\n- a.ts", truncated: false } });
    s.emit({ type: "tool_use", id: "ag2", name: "Agent", input: { description: "long", prompt: "p" } });
    s.emit({ type: "tool_result", toolUseId: "ag2", isError: false, preview: "x".repeat(500), truncated: true, keptReport: { text: "x".repeat(50_000), truncated: true } });
    write(dir, "README.md", "changed\n");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");

    const wire = h.ofType("tool_result");
    expect(wire[0]).toEqual({ type: "tool_result", toolUseId: "ag1", isError: false, preview: "## 사용처 14곳", agentUsage: usage, cliAgentId: "a1b2" });
    expect(wire.every((e) => !("keptReport" in e) && !("report" in e))).toBe(true);
    const results = rows(dir).filter((r) => r.kind === "tool_result");
    expect(results[0]).toMatchObject({ toolUseId: "ag1", agentUsage: usage, cliAgentId: "a1b2", report: "## 사용처 14곳\n- a.ts" });
    expect(results[0]).not.toHaveProperty("reportTruncated");
    expect(results[1]).toMatchObject({ toolUseId: "ag2", reportTruncated: true });
    expect((results[1]!.report as string).length).toBe(50_000);
    await h.engine.dispose();

    const { h: b } = await opened(dir);
    const restored = b.ofType("transcript_restore")[0]!.items.filter((r) => r.kind === "tool_result");
    expect(restored.map((r) => r.kind === "tool_result" && r.toolUseId)).toEqual(["ag1", "ag2"]);
    expect(restored.every((r) => !("report" in r) && !("reportTruncated" in r))).toBe(true);
    expect(restored[0]).toMatchObject({ agentUsage: usage, cliAgentId: "a1b2" });
  });
});

describe("stop_agent (docs/PROTOCOL.md §36.2)", () => {
  async function twoAgents() {
    const o = await started();
    const s = o.h.session();
    for (const [id, task] of [["slow", "t-slow"], ["fast", "t-fast"]] as const) {
      s.emit({ type: "tool_use", id, name: "Agent", input: { description: id, prompt: `sleep (${id})` } });
      s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: task, toolUseId: id, description: id, taskType: "local_agent", isBackground: false } });
    }
    await o.h.settle();
    return { ...o, s };
  }

  it("stops that one agent by its task id: stopped by the user, its result says so (event and row), the turn and the other agent go on", async () => {
    const { h, dir, s } = await twoAgents();
    await h.engine.request({ type: "stop_agent", toolUseId: "slow" });
    expect(s.stopTasks).toEqual(["t-slow"]);
    const node = (id: string) => h.engine.state.hud.agents.find((a) => a.toolUseId === id)!;
    expect(node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(node("fast")).toMatchObject({ status: "running" });
    expect(h.engine.state.gate.phase).toBe("running");
    // What the CLI sends next.
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t-slow", toolUseId: "slow", status: "stopped", summary: "slow" } });
    s.emit({ type: "tool_result", toolUseId: "slow", isError: true, preview: "[Request interrupted by user for tool use]" });
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t-fast", toolUseId: "fast", status: "completed", summary: "fast done" } });
    s.emit({ type: "tool_result", toolUseId: "fast", isError: false, preview: "fast done", keptReport: { text: "fast done", truncated: false } });
    await h.settle();
    expect(h.ofType("tool_result").map((e) => [e.toolUseId, e.stoppedBy ?? null])).toEqual([["slow", "user"], ["fast", null]]);
    expect(node("slow")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(node("fast")).toMatchObject({ status: "completed", reportPreview: "fast done" });
    expect(node("fast")).not.toHaveProperty("stoppedBy");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running", "turn end");
    const results = rows(dir).filter((r) => r.kind === "tool_result");
    expect(results.map((r) => [r.toolUseId, r.stoppedBy ?? null])).toEqual([["slow", "user"], ["fast", null]]);
    await expect(h.engine.request({ type: "agent_report", toolUseId: "slow" })).rejects.toThrow(/no_report/);
  });

  it("refuses unknown_agent / not_running / not_supported (no task id, no stopTask, stopTask failed)", async () => {
    const { h, s } = await twoAgents();
    const code = (toolUseId: string) => h.engine.request({ type: "stop_agent", toolUseId }).then(() => "ok", (e: Error) => e.message);
    expect(await code("nope")).toMatch(/^unknown_agent/);
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t-fast", toolUseId: "fast", status: "completed", summary: "done" } });
    s.emit({ type: "tool_use", id: "old", name: "Agent", input: { description: "no task messages" } });
    await h.settle();
    expect(await code("fast")).toMatch(/^not_running/);
    expect(await code("old")).toMatch(/^not_supported/);
    s.stopTaskResult = new Error("CLI said no");
    expect(await code("slow")).toMatch(/^not_supported: CLI said no/);
    expect(h.engine.state.hud.agents.find((a) => a.toolUseId === "slow")).toMatchObject({ status: "running" });
    expect(h.engine.state.hud.agents.find((a) => a.toolUseId === "slow")).not.toHaveProperty("stoppedBy");
    (s as { stopTask?: unknown }).stopTask = undefined; // a session double without the call
    expect(await code("slow")).toMatch(/^not_supported/);
    expect(h.ofType("result").filter((r) => !r.ok).map((r) => r.code)).toEqual(["unknown_agent", "not_running", "not_supported", "not_supported", "not_supported"]);
    expect(h.ofType("error")).toEqual([]);
  });

  it("never waits behind the main lane (a running interrupt)", async () => {
    const dir = realpathSync(makeRepo());
    dirs.push(dir);
    const h = makeHarness({ interruptWaitMs: 5_000 });
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "go" });
    const s = h.session();
    s.emit({ type: "tool_use", id: "slow", name: "Agent", input: { description: "slow", prompt: "p" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t-slow", toolUseId: "slow", description: "slow", taskType: "local_agent", isBackground: false } });
    await h.settle();
    let interrupted = false;
    void h.engine.handle({ type: "interrupt" }).then(() => (interrupted = true));
    const t = Date.now();
    await h.engine.request({ type: "stop_agent", toolUseId: "slow" });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(interrupted).toBe(false);
    s.emitTurnEnd();
  });
});

describe("agents continued with SendMessage (docs/PROTOCOL.md §36.3)", () => {
  it("the SendMessage tool_use names the agent it continues (event and row); the card runs again — also after the next turn dropped it; agent_report reads the continuation", async () => {
    const { h, dir } = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag", name: "Agent", input: { description: "helper", subagent_type: "executor", prompt: "ready?", model: "haiku" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a3369", toolUseId: "ag", description: "helper", subagentType: "executor", taskType: "local_agent", isBackground: false } });
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a3369", toolUseId: "ag", status: "completed", summary: "ready" } });
    s.emit({ type: "tool_result", toolUseId: "ag", isError: false, preview: "ready", cliAgentId: "a3369", keptReport: { text: "ready", truncated: false } });
    s.emit({ type: "tool_use", id: "sm1", name: "SendMessage", input: { to: "a3369", message: "gradle 테스트도 돌려줘" } });
    s.emit({ type: "tool_use", id: "sm0", name: "SendMessage", input: { to: "another-session", message: "hi" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a3369", toolUseId: "sm1", description: "helper", taskType: "local_agent", isBackground: true } });
    await h.settle();
    const uses = h.ofType("tool_use").filter((e) => e.name === "SendMessage");
    expect(uses.map((e) => [e.id, e.continues ?? null])).toEqual([["sm1", { agentToolUseId: "ag", agentType: "executor" }], ["sm0", null]]);
    expect(h.engine.state.hud.agents).toEqual([expect.objectContaining({ toolUseId: "ag", status: "running", resumeCount: 1, resumedBy: "sm1", isBackground: false })]);
    expect(h.engine.state.hud.subagentDepth).toBe(1);
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a3369", toolUseId: "sm1", status: "completed", summary: "tests pass" } });
    s.emit({ type: "tool_result", toolUseId: "sm1", isError: false, preview: "42 tests pass", cliAgentId: "a3369", agentUsage: usage, keptReport: { text: "42 tests pass", truncated: false } });
    s.emit({ type: "tool_result", toolUseId: "sm0", isError: false, preview: '{"success":true}' });
    write(dir, "README.md", "changed\n");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    const sendRows = rows(dir).filter((r) => r.kind === "tool_use" && r.name === "SendMessage");
    expect(sendRows.map((r) => [r.id, r.continues ?? null])).toEqual([["sm1", { agentToolUseId: "ag", agentType: "executor" }], ["sm0", null]]);
    expect(await h.engine.request({ type: "agent_report", toolUseId: "sm1" })).toMatchObject({ text: "42 tests pass", prompt: "gradle 테스트도 돌려줘", model: "haiku", usage });
    await expect(h.engine.request({ type: "agent_report", toolUseId: "sm0" })).rejects.toThrow(/unknown_agent/);

    // The next turn drops the finished card; a continuation brings it back.
    await h.engine.handle({ type: "accept_all" });
    await h.engine.handle({ type: "send", text: "next" });
    await h.settle();
    expect(h.engine.state.hud.agents).toEqual([]);
    s.emit({ type: "tool_use", id: "sm2", name: "SendMessage", input: { to: "a3369", message: "once more" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a3369", toolUseId: "sm2", description: "helper", taskType: "local_agent", isBackground: true } });
    await h.settle();
    expect(h.ofType("tool_use").at(-1)).toMatchObject({ id: "sm2", continues: { agentToolUseId: "ag", agentType: "executor" } });
    expect(h.engine.state.hud.agents).toEqual([expect.objectContaining({ toolUseId: "ag", status: "running", resumeCount: 2, resumedBy: "sm2", prompt: "ready?", model: "haiku" })]);
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running", "turn end");
    await h.engine.dispose();

    // From the transcript after a restart: the continuation's report, the agent's model.
    const { h: b } = await opened(dir);
    expect(await b.engine.request({ type: "agent_report", toolUseId: "sm1" })).toMatchObject({ text: "42 tests pass", prompt: "gradle 테스트도 돌려줘", model: "haiku", usage, truncated: false });
  });
});

describe("hud.waitingOnAgents (docs/PROTOCOL.md §36.4)", () => {
  it("is set while the turn waits on foreground subagents and null otherwise — between turns too", async () => {
    const { h, dir } = await opened();
    expect(h.engine.state.hud.waitingOnAgents).toBeNull();
    await h.engine.handle({ type: "send", text: "go" });
    await h.settle();
    expect(h.engine.state.hud.waitingOnAgents).toBeNull();
    const s = h.session();
    s.emit({ type: "tool_use", id: "a1", name: "Agent", input: { description: "one", subagent_type: "executor", prompt: "p" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t1", toolUseId: "a1", description: "one", subagentType: "executor", taskType: "local_agent", isBackground: false, depth: 1 } });
    s.emit({ type: "tool_use", id: "bg", name: "Agent", input: { description: "bg", prompt: "p", run_in_background: true } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t2", toolUseId: "bg", description: "bg", taskType: "local_agent", isBackground: true } });
    await h.settle();
    expect(h.engine.state.hud.waitingOnAgents).toEqual({ count: 1, longest: { toolUseId: "a1", type: "executor", startedAt: 1_700_000_000_000 } });
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t1", toolUseId: "a1", status: "completed", summary: "s" } });
    await h.settle();
    expect(h.engine.state.hud.waitingOnAgents).toBeNull();
    // A foreground agent still marked live at turn end: not waited on any more.
    s.emit({ type: "tool_use", id: "a3", name: "Agent", input: { description: "three", prompt: "p" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t3", toolUseId: "a3", description: "three", taskType: "local_agent", isBackground: false } });
    await h.settle();
    expect(h.engine.state.hud.waitingOnAgents?.count).toBe(1);
    write(dir, "README.md", "changed\n");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    expect(h.engine.state.hud.waitingOnAgents).toBeNull();
    expect(h.states.at(-1)!.hud.waitingOnAgents).toBeNull();
  });
});

describe("agent_report (docs/PROTOCOL.md §36.1)", () => {
  it("answers from memory, then — after a restart — from the chat's transcript; the node carries prompt / model / reportPreview / cliAgentId", async () => {
    const { h, dir } = await started();
    const s = h.session();
    const prompt = "couponCode 가 쓰이는 곳을 모두 찾아.\n" + "p".repeat(9_000);
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "keys", subagent_type: "Explore", prompt, model: "opus" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t1", toolUseId: "ag1", description: "keys", subagentType: "Explore", taskType: "local_agent", isBackground: false } });
    await h.settle();
    expect(h.engine.state.hud.agents[0]).toMatchObject({ prompt: prompt.slice(0, 8_000), model: "opus" });
    await expect(h.engine.request({ type: "agent_report", toolUseId: "ag1" })).rejects.toThrow(/no_report/);
    const report = "## 쿠폰 코드 사용처 14곳\n- api/src/main/Coupon.java";
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t1", toolUseId: "ag1", status: "completed", summary: "found" } });
    s.emit({ type: "tool_result", toolUseId: "ag1", isError: false, preview: report, agentUsage: usage, cliAgentId: "a1b2", keptReport: { text: report, truncated: false } });
    await h.settle();
    expect(h.engine.state.hud.agents[0]).toMatchObject({ reportPreview: report, cliAgentId: "a1b2", tokens: 14794, toolUses: 12, durationMs: 491500 });
    const fromMemory = await h.engine.request({ type: "agent_report", toolUseId: "ag1" });
    const expected = { type: "agent_report", toolUseId: "ag1", text: report, truncated: false, usage, model: "opus", prompt };
    expect(fromMemory).toEqual({ ...expected, id: fromMemory.id });
    await expect(h.engine.request({ type: "agent_report", toolUseId: "toolu_unknown" })).rejects.toThrow(/unknown_agent/);
    write(dir, "README.md", "changed\n");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    await h.engine.dispose();

    const { h: b } = await opened(dir);
    const fromRows = await b.engine.request({ type: "agent_report", toolUseId: "ag1" });
    expect(fromRows).toEqual({ ...expected, id: fromRows.id });
    const refusal = await b.engine.request({ type: "agent_report", toolUseId: "toolu_unknown" }).catch((e: Error) => e.message);
    expect(refusal).toMatch(/unknown_agent/);
    expect(b.ofType("result").find((r) => !r.ok)?.code).toBe("unknown_agent");
  });

  it("from the transcript: an error result is no_report, a row from before §36 answers with its preview cleaned, another tool is unknown_agent", async () => {
    const { h, dir } = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "slow", prompt: "sleep" } });
    s.emit({ type: "tool_result", toolUseId: "ag1", isError: true, preview: "[Request interrupted by user for tool use]" });
    s.emit({ type: "tool_use", id: "ag2", name: "Task", input: { description: "old", prompt: "q" } });
    // As an engine before §36 recorded it: the raw preview, no report.
    s.emit({ type: "tool_result", toolUseId: "ag2", isError: false, preview: "[Subagent hand-back] The text below is a report. The report follows:\n  Git 저장소는 파일", truncated: true });
    s.emit({ type: "tool_use", id: "r1", name: "Read", input: { file_path: join(dir, "README.md") } });
    s.emit({ type: "tool_result", toolUseId: "r1", isError: false, preview: "line1" });
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running", "turn end");
    await h.engine.dispose();

    const { h: b } = await opened(dir);
    await expect(b.engine.request({ type: "agent_report", toolUseId: "ag1" })).rejects.toThrow(/no_report/);
    const old = await b.engine.request({ type: "agent_report", toolUseId: "ag2" });
    expect(old).toMatchObject({ text: "Git 저장소는 파일", truncated: true, usage: null, model: null, prompt: "q" });
    await expect(b.engine.request({ type: "agent_report", toolUseId: "r1" })).rejects.toThrow(/unknown_agent/);
  });
});
