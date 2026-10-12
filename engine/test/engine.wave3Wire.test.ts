import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

/**
 * MARK: wave4 w4-check3 — golden wire JSON of the §36 agent / pre-review shapes as this engine sends them (not as the
 * §36 examples say), consumed by the Swift `Wave3WireGoldenTests` and the Electron `wave3Wire.test.ts`: the screen lanes
 * of 0.2.3 were built against the examples only. Regenerate with `UPDATE_WIRE_FIXTURES=1`.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wire", "wave3.agents.json");
const PINNED_TIME = "2026-01-02T03:04:05.000Z";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/**
 * Wall-clock ISO times (a run's `startedAt` / `endedAt`), tree hashes and the temp repository vary per machine: pinned
 * (`root` → `/repo`, as engine.protocol.test.ts does; on Windows the native `C:\…\repo\x` tail also gets `/`).
 */
function pin<T>(value: T, root: string): T {
  let json = JSON.stringify(value, (key, v: unknown) => {
    if ((key === "startedAt" || key === "endedAt") && typeof v === "string") return PINNED_TIME;
    if (key === "endTree" && typeof v === "string") return "<tree B>";
    return v;
  });
  for (const form of new Set([root, JSON.stringify(root).slice(1, -1)])) json = json.split(form).join("/repo");
  json = json.replace(/\/repo((?:\\\\[^"\\]*)+)/g, (_m, tail: string) => "/repo" + tail.replace(/\\\\/g, "/"));
  return JSON.parse(json) as T;
}

describe("§36 wire goldens (wave4 w4-check3)", () => {
  it("an agent with its instructions and report, its continuation, the turn waiting on it, and the main chat's ReportFindings", async () => {
    const dir = realpathSync(makeRepo());
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "Find the coupon codes, then review" });
    const s = h.session();
    s.emitSessionInfo();

    // §36.1 / §36.4: a foreground agent with its instructions and model; the main turn waits on it.
    s.emit({ type: "tool_use", id: "toolu_ag", name: "Agent", input: { description: "coupon codes", subagent_type: "Explore", prompt: "find couponCode", model: "opus" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a1b2c3", toolUseId: "toolu_ag", description: "coupon codes", subagentType: "Explore", taskType: "local_agent", isBackground: false, depth: 1 } });
    await h.waitFor((x) => x.hud.waitingOnAgents !== null && x.hud.waitingOnAgents !== undefined, "waiting on the agent");
    const waitingHud = h.engine.state.hud;

    // §36.1: its result — usage and the CLI's agent id parsed off, the cleaned report kept.
    const usage = { tokens: 14794, toolUses: 12, durationMs: 491500 };
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a1b2c3", toolUseId: "toolu_ag", status: "completed", summary: "14 places" } });
    s.emit({ type: "tool_result", toolUseId: "toolu_ag", isError: false, preview: "## 사용처 14곳", agentUsage: usage, cliAgentId: "a1b2c3", keptReport: { text: "## 사용처 14곳\n- api/a.ts", truncated: false } });
    // §36.3: Claude continues it.
    s.emit({ type: "tool_use", id: "toolu_sm", name: "SendMessage", input: { to: "a1b2c3", message: "gradle 테스트도 돌려줘" } });
    s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "a1b2c3", toolUseId: "toolu_sm", description: "coupon codes", taskType: "local_agent", isBackground: true } });
    await h.settle();
    const resumedHud = h.engine.state.hud;
    s.emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "a1b2c3", toolUseId: "toolu_sm", status: "completed", summary: "tests pass" } });
    s.emit({ type: "tool_result", toolUseId: "toolu_sm", isError: false, preview: "42 tests pass", keptReport: { text: "42 tests pass", truncated: false } });

    // §36.13: the main chat's /code-review reports through ReportFindings in the turn that makes the review.
    s.emit({
      type: "tool_use",
      id: "toolu_rf",
      name: "ReportFindings",
      input: {
        level: "low",
        findings: [
          { file: join(dir, "README.md"), line: 2, summary: "line2 changed without a test", short_summary: "no test", failure_scenario: "a reader of line 2 breaks", category: "test-coverage" },
          { file: "other.txt", line: null, summary: "whole file", short_summary: "file", failure_scenario: "x" },
        ],
      },
    });
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    write(dir, "other.txt", "other changed\n");
    s.emitTurnEnd({ toolFiles: [] });
    await h.waitFor((x) => x.gate.phase === "reviewing" && (x.gate.prereviews ?? []).length === 1, "the review with the main chat's run");
    const report = await h.engine.request({ type: "agent_report", toolUseId: "toolu_ag" });

    const pick = (type: EngineEvent["type"], pred: (e: Record<string, unknown>) => boolean = () => true) =>
      h.events.filter((e) => e.type === type && pred(e as unknown as Record<string, unknown>));
    const golden = pin({
      events: [
        ...pick("tool_use", (e) => ["toolu_ag", "toolu_sm", "toolu_rf"].includes(e.id as string)),
        ...pick("tool_result", (e) => ["toolu_ag", "toolu_sm"].includes(e.toolUseId as string)),
        { ...report, id: "req-1" },
        pick("prereview").at(-1)!,
      ],
      waitingHud: { agents: waitingHud.agents, waitingOnAgents: waitingHud.waitingOnAgents, subagentDepth: waitingHud.subagentDepth },
      resumedHud: { agents: resumedHud.agents, waitingOnAgents: resumedHud.waitingOnAgents },
      prereviews: h.engine.state.gate.prereviews,
    }, dir);

    // What the clients rely on, said here so a change to the engine's shapes fails before the goldens are rewritten.
    expect(golden.waitingHud.waitingOnAgents).toEqual({ count: 1, longest: { toolUseId: "toolu_ag", type: "Explore", startedAt: 1_700_000_000_000 } });
    expect(golden.waitingHud.agents[0]).toMatchObject({ toolUseId: "toolu_ag", prompt: "find couponCode", model: "opus", status: "running" });
    expect(golden.resumedHud.agents[0]).toMatchObject({ toolUseId: "toolu_ag", cliAgentId: "a1b2c3", reportPreview: "## 사용처 14곳\n- api/a.ts", resumeCount: 1, resumedBy: "toolu_sm" });
    expect(golden.events.find((e) => e.type === "tool_use" && e.id === "toolu_sm")).toMatchObject({ continues: { agentToolUseId: "toolu_ag", agentType: "Explore" } });
    expect(golden.events.find((e) => e.type === "tool_result" && e.toolUseId === "toolu_ag")).toMatchObject({ agentUsage: usage, cliAgentId: "a1b2c3" });
    expect(report).toMatchObject({ type: "agent_report", toolUseId: "toolu_ag", text: "## 사용처 14곳\n- api/a.ts", truncated: false, usage, model: "opus", prompt: "find couponCode" });
    expect(golden.prereviews).toEqual([expect.objectContaining({ prereviewId: "toolu_rf", source: "main", status: "done", endTree: "<tree B>" })]);
    expect(golden.prereviews![0]!.findings.map((f) => [f.id, f.file, f.line])).toEqual([["f1", "README.md", 2], ["f2", "other.txt", null]]);

    const text = JSON.stringify(golden, null, 2) + "\n";
    if (process.env.UPDATE_WIRE_FIXTURES || !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(text));
  });
});
