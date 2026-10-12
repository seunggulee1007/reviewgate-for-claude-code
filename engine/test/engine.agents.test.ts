import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function started(): Promise<{ h: Harness; dir: string }> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "go" });
  return { h, dir };
}

const progress = (n: number) => ({ type: "agent_signal" as const, signal: { kind: "task_progress" as const, taskId: "t1", toolUseId: "ag1", usage: { tokens: n, toolUses: n, durationMs: n } } });

describe("state.hud.agents (docs/PROTOCOL.md §13)", () => {
  it("mirrors agents into the HUD, derives subagentDepth, keeps background agents across turns and drops finished ones at the next send", async () => {
    const { h, dir } = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "bg work", run_in_background: true } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "t1", toolUseId: "ag1", description: "bg work", taskType: "local_agent", isBackground: true } });
    s.emit({ type: "tool_result", toolUseId: "ag1", isError: false, preview: "launched" });
    s.emit({ type: "tool_use", id: "ag2", name: "Agent", input: { description: "fg work", subagent_type: "Explore" } });
    s.emit({ type: "tool_use", id: "e1", name: "Write", input: { file_path: join(dir, "src/x.ts") }, file: join(dir, "src/x.ts"), parentToolUseId: "ag2" });
    await h.settle();
    expect(h.engine.state.hud.subagentDepth).toBe(1); // the background agent does not count
    expect(h.engine.state.hud.agents.map((a) => [a.id, a.status, a.isBackground, a.files])).toEqual([
      ["t1", "running", true, []],
      ["ag2", "running", false, ["src/x.ts"]],
    ]);
    s.emit({ type: "tool_result", toolUseId: "ag2", isError: false, preview: "done" });
    write(dir, "src/x.ts", "x\n");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    // Turn end does not clear them: the background agent is still running, the finished one stays visible.
    expect(h.engine.state.hud.agents.map((a) => [a.toolUseId, a.status])).toEqual([["ag1", "running"], ["ag2", "completed"]]);
    expect(h.engine.state.hud.subagentDepth).toBe(0);

    await h.engine.handle({ type: "send", text: "next" });
    await h.settle();
    expect(h.engine.state.hud.agents.map((a) => a.toolUseId)).toEqual(["ag1"]);
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "t1", toolUseId: "ag1", status: "completed", summary: "all done" } });
    await h.settle();
    expect(h.engine.state.hud.agents[0]).toMatchObject({ status: "completed", summary: "all done", endedAt: 1_700_000_000_000 });
  });

  it("progress updates reach the snapshot at most every 250 ms, the last one included", async () => {
    const { h } = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "d" } });
    await h.settle();
    const before = h.states.length;
    for (let i = 1; i <= 10; i++) {
      s.emit(progress(i));
      await h.settle();
    }
    const burst = h.states.length - before;
    expect(burst).toBeLessThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 300));
    const last = h.states[h.states.length - 1]!;
    expect(last.hud.agents[0]).toMatchObject({ tokens: 10, toolUses: 10 });
  });

  it("restart_session stops what the old CLI was running", async () => {
    const { h } = await started();
    h.session().emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "d", run_in_background: true } });
    await h.engine.handle({ type: "restart_session" });
    await h.waitFor((x) => x.session.open, "restarted");
    expect(h.engine.state.hud.agents.map((a) => a.status)).toEqual(["stopped"]);
  });
});
