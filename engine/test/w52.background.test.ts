import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import type { BackgroundTask } from "../src/protocol.js";
import type { ReviewGate } from "../src/review/gate.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §52 — background work at the engine level: the live task list (`state.session.backgroundTasks`),
 * `task_stop` / `task_background` / `task_output`, a turn Claude starts itself taken as a review turn (its events held
 * until snapshot A), and A kept across turns while a background process may write (§52.1).
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-bg"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(): Promise<{ h: Harness; dir: string; id: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  const id = (await h.open(dir)).sessions.currentId!;
  return { h, dir, id };
}

const rowsOf = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: "b1", kind: "bash", description: "npm run build", toolUseId: "toolu_bg", turn: null, startedAt: "2026-11-05T04:00:00.000Z", hasOutput: true, ...over,
});

/** Turn 1: Claude starts `npm run build` in the background and edits a.txt; the build is still running at the end. */
async function turnWithBackgroundTask(h: Harness, dir: string, id: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "빌드 돌려 놓고 a.txt 고쳐줘" });
  h.session().emitSessionInfo();
  h.session().emit({ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "npm run build", run_in_background: true } });
  h.session().emit({ type: "background_tasks", tasks: [task()] });
  write(dir, "a.txt", "a\n");
  h.session().emitTurnEnd({ sessionId: id, toolFiles: [{ path: join(dir, "a.txt"), tools: ["Write"], count: 1, toolUseIds: ["toolu_w"] }] });
  await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
}

describe("§52 background tasks", () => {
  it("the live list carries the turn of the call that started it and empties with the session", async () => {
    const { h, dir, id } = await opened();
    await turnWithBackgroundTask(h, dir, id);
    expect(h.engine.state.session.backgroundTasks).toEqual([task({ turn: 1 })]);
    h.session().emit({ type: "background_tasks", tasks: [] });
    await h.settle();
    expect(h.engine.state.session.backgroundTasks).toEqual([]);
    h.session().emit({ type: "background_tasks", tasks: [task()] });
    await h.settle();
    expect(h.engine.state.session.backgroundTasks).toHaveLength(1);
    h.session().emit({ type: "closed", code: 0 });
    await h.settle();
    expect(h.engine.state.session.backgroundTasks).toEqual([]);
  });

  it("task_stop, task_background (Ctrl+B) and task_output, with their refusals", async () => {
    const { h, dir, id } = await opened();
    await turnWithBackgroundTask(h, dir, id);
    const fake = h.session();
    await expect(h.engine.request({ type: "task_stop", taskId: "nope" })).rejects.toThrow(/task_unknown/);
    await h.engine.request({ type: "task_stop", taskId: "b1" });
    expect(fake.stopTasks).toEqual(["b1"]);
    fake.stopTaskResult = new Error("no such task");
    await expect(h.engine.request({ type: "task_stop", taskId: "b1" })).rejects.toThrow(/^task_stop_failed:no such task$/);

    expect(await h.engine.request({ type: "task_background", toolUseId: "toolu_run" })).toMatchObject({ type: "task_background", moved: true });
    fake.backgroundResult = false;
    expect(await h.engine.request({ type: "task_background" })).toMatchObject({ moved: false });
    expect(fake.backgroundCalls).toEqual(["toolu_run", undefined]);
    fake.backgroundResult = new Error("background tasks are disabled");
    await expect(h.engine.request({ type: "task_background" })).rejects.toThrow(/^task_background_failed:background tasks are disabled$/);
    fake.backgroundWorkOn = false;
    await expect(h.engine.request({ type: "task_background" })).rejects.toThrow(/^background_off$/);

    await expect(h.engine.request({ type: "task_output", taskId: "b1" })).rejects.toThrow(/^no_output$/);
    const out = join(makeTempDir("rg-bg-out"), "b1.output");
    dirs.push(join(out, ".."));
    write(join(out, ".."), "b1.output", `${"x".repeat(70 * 1024)}\nbuild ok\n`);
    fake.taskFiles.set("b1", out);
    fake.liveTasks.add("b1");
    const reply = await h.engine.request({ type: "task_output", taskId: "b1" });
    expect(reply).toMatchObject({ type: "task_output", taskId: "b1", truncated: true, running: true });
    expect((reply as { text: string }).text.endsWith("build ok\n")).toBe(true);
    expect((reply as { text: string }).text.length).toBe(64 * 1024);
  });
});

describe("§52.1 a turn Claude starts itself", () => {
  it("is a review turn: its events wait for snapshot A, an auto_turn row opens it, and what the build wrote after B is in its review", async () => {
    const { h, dir, id } = await opened();
    await turnWithBackgroundTask(h, dir, id);
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    // The build ends after the review: it wrote b.txt; then Claude goes on by itself.
    write(dir, "b.txt", "built\n");
    h.session().emit({ type: "background_tasks", tasks: [] });
    const t = { taskId: "b1", description: "npm run build", status: "completed", summary: "Background command \"npm run build\" completed (exit code 0)" };
    h.session().emitAutoTurnStart({ trigger: "background", task: t });
    // The CLI's text before the engine is ready belongs to the turn it opens (never an unprompted row).
    h.session().emit({ type: "text_delta", text: "빌드가 끝났어요. " });
    await h.waitFor(() => h.session().autoTurnAnswers.length === 1, "auto turn taken");
    const running = h.engine.state;
    expect(running.gate.phase).toBe("running");
    // §54: the session's hooks count the turn from its own start (the review keeps A: a.txt is still in it).
    const own = (h.engine as unknown as { gate: ReviewGate }).gate.runningTurnStart;
    expect(own).not.toBe(running.gate.turnStartTree);
    expect(h.session().autoTurnAnswers).toEqual([{ ok: true, tree: own }]);
    expect(h.ofType("auto_turn")).toEqual([{ type: "auto_turn", turn: 2, trigger: "background", task: t }]);
    expect(running.session.externalTurn).toBeNull();
    write(dir, "c.txt", "fix\n");
    h.session().emitTurnEnd({ sessionId: id, toolFiles: [{ path: join(dir, "c.txt"), tools: ["Write"], count: 1, toolUseIds: ["toolu_c"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.some((f) => f.path === "c.txt"), "auto turn collected");
    // A was kept (a background task ran since the last B): b.txt is in the review (nothing of Claude's explains it), a.txt
    // stays accepted, c.txt is the turn's own edit.
    expect(s.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([["a.txt", "accepted", "tool"], ["b.txt", "pending", "external"], ["c.txt", "pending", "tool"]]);
    const rows = rowsOf(dir, id).map((r) => [r.kind, r.turn]);
    expect(rows).toContainEqual(["auto_turn", 2]);
    expect(rowsOf(dir, id).find((r) => r.kind === "assistant_text" && r.turn === 2)).toMatchObject({ text: "빌드가 끝났어요." });
    expect(rowsOf(dir, id).some((r) => r.unprompted === true)).toBe(false);
    expect(h.engine.state.session.checkpoints!.map((c) => [c.turn, c.prompt])).toContainEqual([2, "[auto] background task ended: npm run build"]);
  });

  it("a scheduled run (/loop) waits for the collection in flight; the input is closed meanwhile", async () => {
    const { h, dir, id } = await opened();
    await h.engine.handle({ type: "send", text: "/loop 1m 상태 확인" });
    h.session().emitSessionInfo();
    h.session().emitTurnEnd({ sessionId: id });
    h.session().emitAutoTurnStart({ trigger: "schedule", commandUuid: "cron-1", wakeupSource: "schedule_wakeup" });
    await h.waitFor(() => h.session().autoTurnAnswers.length === 1, "scheduled turn taken");
    const s = h.engine.state;
    expect(h.session().autoTurnAnswers[0]!.ok).toBe(true);
    expect(h.ofType("auto_turn").at(-1)).toEqual({ type: "auto_turn", turn: 2, trigger: "schedule", wakeupSource: "schedule_wakeup" });
    expect(s.gate.canSend).toBe(false);
    write(dir, "status.md", "ok\n");
    h.session().emitTurnEnd({ sessionId: id });
    const done = await h.waitFor((x) => x.gate.phase === "reviewing", "scheduled turn collected");
    expect(done.changedFiles.map((f) => f.path)).toEqual(["status.md"]);
    expect(h.ofType("turn_end")).toHaveLength(2);
  });

  it("refused while the gate cannot take a turn (a failed collection): §18 applies, the input opens again", async () => {
    const { h, dir, id } = await opened();
    await h.engine.handle({ type: "send", text: "hi" });
    h.session().emitSessionInfo();
    write(dir, "x.txt", "x\n");
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((x) => x.gate.phase === "reviewing", "collected");
    // Forced: the gate reports a failed collection (canSend false with `collect_failed`).
    (h.engine as unknown as { gate: { collectError: string | null } }).gate.collectError = "boom";
    h.session().emitAutoTurnStart({ trigger: "continue" });
    h.session().emit({ type: "text_delta", text: "계속할게요" });
    await h.waitFor(() => h.session().autoTurnAnswers.length === 1, "answered");
    expect(h.session().autoTurnAnswers).toEqual([{ ok: false }]);
    await h.settle();
    expect(h.engine.state.session.externalTurn).toBeNull();
    expect(h.ofType("auto_turn")).toEqual([]);
    expect(h.ofType("text_delta").at(-1)).toMatchObject({ text: "계속할게요", unprompted: true });
  });

  it("without background work since the last B, a send takes a fresh A (an edit made between turns is not reviewed)", async () => {
    const { h, dir, id } = await opened();
    await h.engine.handle({ type: "send", text: "a" });
    h.session().emitSessionInfo();
    write(dir, "a.txt", "a\n");
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((x) => x.gate.phase === "reviewing", "collected");
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    write(dir, "ide.txt", "saved in the IDE\n");
    await h.engine.handle({ type: "send", text: "b" });
    write(dir, "b.txt", "b\n");
    h.session().emitTurnEnd({ sessionId: id });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.some((f) => f.path === "b.txt"), "collected 2");
    expect(s.changedFiles.map((f) => f.path)).toEqual(["b.txt"]);
  });
});

describe("§52.2 a subagent working in the background", () => {
  const agentTask = task({ taskId: "a1", kind: "agent", description: "Make sub.txt", toolUseId: "toolu_agent", hasOutput: false });

  /** Turn 1: Claude starts a subagent in the background (its call answered at once) and edits a.txt; the agent works on. */
  async function turnWithAgent(h: Harness, dir: string, id: string): Promise<void> {
    await h.engine.handle({ type: "send", text: "서브에이전트로 sub.txt 만들고 a.txt 고쳐줘" });
    h.session().emitSessionInfo();
    h.session().emit({ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Make sub.txt", subagent_type: "general-purpose", prompt: "…", run_in_background: true } });
    h.session().emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a1", toolUseId: "toolu_agent", description: "Make sub.txt", subagentType: "general-purpose", taskType: "local_agent", isBackground: true, depth: 1 } });
    h.session().emit({ type: "tool_result", toolUseId: "toolu_agent", isError: false, preview: "Async agent launched successfully.", agentLaunched: true });
    h.session().emit({ type: "background_tasks", tasks: [agentTask] });
    write(dir, "a.txt", "a\n");
    h.session().emitTurnEnd({ sessionId: id, toolFiles: [{ path: join(dir, "a.txt"), tools: ["Write"], count: 1, toolUseIds: ["toolu_w"] }] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
  }

  it("a review finished while it works: the next turn starts from that B, so what it wrote after B is reviewed (with its call as the cause)", async () => {
    const { h, dir, id } = await opened();
    await turnWithAgent(h, dir, id);
    // The subagent writes sub.txt after B; the user finishes the review meanwhile.
    h.session().emit({ type: "tool_use", id: "toolu_sub", name: "Write", input: { file_path: join(dir, "sub.txt"), content: "sub\n" }, file: join(dir, "sub.txt"), parentToolUseId: "toolu_agent" });
    write(dir, "sub.txt", "sub\n");
    await h.engine.request({ type: "finish_review" });
    expect(h.engine.state.changedFiles).toEqual([]);
    // The user asks something; the session says what the agent changed since (the idle calls are this turn's).
    await h.engine.handle({ type: "send", text: "2+2는?" });
    h.session().emitTurnEnd({ sessionId: id, toolFiles: [{ path: join(dir, "sub.txt"), tools: ["Write"], count: 1, toolUseIds: ["toolu_sub"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.length > 0, "turn 2 collected");
    // a.txt stayed as the finished review left it (in A); sub.txt is new since B — the agent's.
    expect(s.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([["sub.txt", "pending", "tool"]]);
  });

  it("without background work a finished review lets the next turn take a fresh A (as before)", async () => {
    const { h, dir, id } = await opened();
    await h.engine.handle({ type: "send", text: "a" });
    h.session().emitSessionInfo();
    write(dir, "a.txt", "a\n");
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((x) => x.gate.phase === "reviewing", "collected");
    await h.engine.request({ type: "finish_review" });
    write(dir, "ide.txt", "saved in the IDE\n");
    await h.engine.handle({ type: "send", text: "b" });
    write(dir, "b.txt", "b\n");
    h.session().emitTurnEnd({ sessionId: id });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.some((f) => f.path === "b.txt"), "collected 2");
    expect(s.changedFiles.map((f) => f.path)).toEqual(["b.txt"]);
  });

  it("stopped from the background list, it is stopped by the user (its result says so, as with its own ■)", async () => {
    const { h, dir, id } = await opened();
    await turnWithAgent(h, dir, id);
    await h.engine.request({ type: "task_stop", taskId: "a1" });
    expect(h.session().stopTasks).toEqual(["a1"]);
    expect(h.engine.state.hud.agents.find((a) => a.toolUseId === "toolu_agent")).toMatchObject({ status: "stopped", stoppedBy: "user" });
    h.session().emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a1", toolUseId: "toolu_agent", status: "stopped", summary: "Task stopped" } });
    h.session().emit({ type: "tool_result", toolUseId: "toolu_agent", isError: true, preview: "Task stopped", agentEnded: true });
    await h.settle();
    expect(h.ofType("tool_result").at(-1)).toMatchObject({ toolUseId: "toolu_agent", agentEnded: true, stoppedBy: "user" });
  });

  it("its end is its call's result row (the report); the turn Claude runs after it names the agent; the agent comes back with the chat", async () => {
    const { h, dir, id } = await opened();
    await turnWithAgent(h, dir, id);
    h.session().emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a1", toolUseId: "toolu_agent", status: "completed", summary: "sub.txt를 만들었어요." } });
    h.session().emit({ type: "tool_result", toolUseId: "toolu_agent", isError: false, preview: "sub.txt를 만들었어요.", agentEnded: true, agentReport: "sub.txt를 만들었어요.", keptReport: { text: "sub.txt를 만들었어요.", truncated: false } });
    h.session().emit({ type: "background_tasks", tasks: [] });
    const t = { taskId: "a1", description: "Make sub.txt", status: "completed", summary: "sub.txt를 만들었어요.", kind: "agent" as const, toolUseId: "toolu_agent" };
    h.session().emitAutoTurnStart({ trigger: "background", task: t });
    await h.waitFor(() => h.session().autoTurnAnswers.length === 1, "auto turn taken");
    expect(h.ofType("auto_turn")).toEqual([{ type: "auto_turn", turn: 2, trigger: "background", task: t }]);
    expect(h.ofType("tool_result").filter((e) => e.toolUseId === "toolu_agent").map((e) => [e.agentLaunched ?? false, e.agentEnded ?? false, e.preview])).toEqual([
      [true, false, "Async agent launched successfully."],
      [false, true, "sub.txt를 만들었어요."],
    ]);
    // The auto turn's start moved the finished agent to the history (§39.3).
    const node = [...h.engine.state.hud.agents, ...(h.engine.state.hud.agentHistory ?? [])].find((a) => a.toolUseId === "toolu_agent");
    expect(node).toMatchObject({ status: "completed", isBackground: true, reportPreview: "sub.txt를 만들었어요." });
    expect(await h.engine.request({ type: "agent_report", toolUseId: "toolu_agent" })).toMatchObject({ type: "agent_report", text: "sub.txt를 만들었어요." });
    const rows = rowsOf(dir, id).filter((r) => r.kind === "tool_result" && r.toolUseId === "toolu_agent");
    expect(rows.map((r) => [r.agentLaunched ?? false, r.agentEnded ?? false])).toEqual([[true, false], [false, true]]);
  });
});
