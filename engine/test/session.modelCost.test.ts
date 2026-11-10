// MARK: wave4d w4d-agents2 — §42.4 subagent cost: per-model usage of a turn, the model each subagent ran on.
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { AgentTracker } from "../src/session/agents.js";
import { addModelCosts, modelCostDelta } from "../src/session/modelCost.js";
import type { ModelCost } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const SID = "s1";

function fakeSession(): { feed: (m: SDKMessage) => void; events: SessionEvent[]; begin: () => void } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
  });
  const begin = () => (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  begin();
  const feed = (m: SDKMessage) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m);
  return { feed, events, begin };
}

const usageOf = (cost: number, input = 0, output = 0, cacheRead = 0, cacheCreation = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreation,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
});

function result(total: number, modelUsage: Record<string, unknown> | undefined): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: SID,
    usage: { input_tokens: 1, output_tokens: 1 },
    duration_ms: 5,
    total_cost_usd: total,
    ...(modelUsage ? { modelUsage } : {}),
  } as unknown as SDKMessage;
}

function subagentMessage(parent: string, model: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    uuid: "u",
    session_id: SID,
    message: { id: `m-${parent}-${model}`, model, type: "message", role: "assistant", content: [{ type: "text", text: "working" }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  } as unknown as SDKMessage;
}

const turnEnds = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "turn_end" }> => e.type === "turn_end");
const cost = (model: string, costUsd: number, extra: Partial<ModelCost> = {}): ModelCost => ({
  model,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...extra,
});

describe("modelCostDelta (§42.4)", () => {
  it("differences the SDK's cumulative modelUsage per model, most expensive first, and drops models that did nothing", () => {
    const first = modelCostDelta(new Map(), { "claude-opus-4-1": usageOf(0.3, 100, 10, 1000, 50), "claude-haiku-4-5": usageOf(0.01, 5, 1) }, false);
    expect(first.models).toEqual([
      cost("claude-opus-4-1", 0.3, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 50 }),
      cost("claude-haiku-4-5", 0.01, { inputTokens: 5, outputTokens: 1 }),
    ]);
    const second = modelCostDelta(first.next, { "claude-opus-4-1": usageOf(0.3, 100, 10, 1000, 50), "claude-haiku-4-5": usageOf(0.03, 9, 2), "claude-sonnet-4-5": usageOf(0.06, 40, 4) }, false);
    expect(second.models.map((m) => [m.model, Number(m.costUsd.toFixed(6)), m.inputTokens, m.outputTokens])).toEqual([
      ["claude-sonnet-4-5", 0.06, 40, 4],
      ["claude-haiku-4-5", 0.02, 4, 1],
    ]);
  });

  it("takes the numbers as they are after a reset (a /clear, a fresh process) and keeps the baseline when no modelUsage came", () => {
    const base = modelCostDelta(new Map(), { "claude-opus-4-1": usageOf(1, 500) }, false).next;
    expect(modelCostDelta(base, { "claude-opus-4-1": usageOf(0.2, 50) }, true).models).toEqual([cost("claude-opus-4-1", 0.2, { inputTokens: 50 })]);
    // One model's numbers going down is a reset of that model too.
    expect(modelCostDelta(base, { "claude-opus-4-1": usageOf(0.4, 60) }, false).models).toEqual([cost("claude-opus-4-1", 0.4, { inputTokens: 60 })]);
    const none = modelCostDelta(base, undefined, false);
    expect(none.models).toEqual([]);
    expect(none.next).toBe(base);
    // Values of the wrong type read as 0; an entry that is no object is skipped.
    expect(modelCostDelta(new Map(), { a: "x", b: { costUSD: "1", inputTokens: 3 } } as never, false).models).toEqual([cost("b", 0, { inputTokens: 3 })]);
  });

  it("addModelCosts sums per model (the HUD's session list)", () => {
    expect(addModelCosts([cost("o", 0.1, { inputTokens: 1 })], [cost("o", 0.2, { inputTokens: 2 }), cost("h", 0.01)])).toEqual([
      cost("o", 0.30000000000000004, { inputTokens: 3 }),
      cost("h", 0.01),
    ]);
  });
});

describe("ClaudeSession → turn_end.usage.models (§42.4)", () => {
  it("each turn carries its own share of the cumulative modelUsage; a turn without modelUsage carries none", () => {
    const s = fakeSession();
    s.feed(result(0.31, { "claude-opus-4-1": usageOf(0.3, 100, 10), "claude-haiku-4-5": usageOf(0.01, 5, 1) }));
    s.begin();
    s.feed(result(0.4, { "claude-opus-4-1": usageOf(0.36, 120, 12), "claude-haiku-4-5": usageOf(0.01, 5, 1), "claude-sonnet-4-5": usageOf(0.03, 30, 3) }));
    s.begin();
    s.feed(result(0.4, undefined));
    const [t1, t2, t3] = turnEnds(s.events);
    expect(t1!.usage.models?.map((m) => [m.model, m.costUsd])).toEqual([["claude-opus-4-1", 0.3], ["claude-haiku-4-5", 0.01]]);
    expect(t2!.usage.models?.map((m) => m.model)).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);
    expect(t2!.usage.models?.[0]?.costUsd).toBeCloseTo(0.06, 6);
    expect(t2!.usage.models?.[0]?.inputTokens).toBe(20);
    expect(t3!.usage).not.toHaveProperty("models");
  });

  it("an unprompted turn's usage lands in the next turn, as its cost does", () => {
    const s = fakeSession();
    s.feed(result(0.1, { "claude-opus-4-1": usageOf(0.1) }));
    // No turn of ours runs: the CLI ran this one on its own.
    s.feed(result(0.15, { "claude-opus-4-1": usageOf(0.15) }));
    s.begin();
    s.feed(result(0.2, { "claude-opus-4-1": usageOf(0.2) }));
    const ends = turnEnds(s.events);
    expect(ends).toHaveLength(2);
    expect(ends[1]!.usage.models?.[0]?.costUsd).toBeCloseTo(0.1, 6);
  });

  it("names the model a subagent's API answers came from, once per agent and model (agent_model)", () => {
    const s = fakeSession();
    s.feed(subagentMessage("ag1", "claude-sonnet-4-5-20250929"));
    s.feed(subagentMessage("ag1", "claude-sonnet-4-5-20250929"));
    s.feed(subagentMessage("ag2", "<synthetic>"));
    s.feed(subagentMessage("ag2", "claude-haiku-4-5"));
    const signals = s.events.flatMap((e) => (e.type === "agent_signal" && e.signal.kind === "agent_model" ? [e.signal] : []));
    expect(signals).toEqual([
      { kind: "agent_model", toolUseId: "ag1", model: "claude-sonnet-4-5-20250929" },
      { kind: "agent_model", toolUseId: "ag2", model: "claude-haiku-4-5" },
    ]);
  });
});

describe("AgentTracker apiModel (§42.4)", () => {
  it("keeps the model an agent ran on, into the earlier turns' history", () => {
    const t = new AgentTracker(() => 1_000);
    t.onToolUse({ id: "ag1", name: "Agent", input: { description: "d", subagent_type: "oh-my-claudecode:executor" } });
    expect(t.onSignal({ kind: "agent_model", toolUseId: "ag1", model: "claude-sonnet-4-5" })).toBe(true);
    expect(t.onSignal({ kind: "agent_model", toolUseId: "ag1", model: "claude-sonnet-4-5" })).toBe(false);
    expect(t.onSignal({ kind: "agent_model", toolUseId: "nobody", model: "claude-sonnet-4-5" })).toBe(false);
    expect(t.list[0]).toMatchObject({ model: null, apiModel: "claude-sonnet-4-5" });
    t.onToolResult("ag1", false);
    t.beginTurn();
    expect(t.history[0]).toMatchObject({ toolUseId: "ag1", apiModel: "claude-sonnet-4-5" });
  });
});

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("engine: hud.turnModels / sessionModels, turn_summary.models (§42.4)", () => {
  it("the HUD keeps the last turn's models and the chat's sum; the turn's summary and its row carry them", async () => {
    const dir = realpathSync(makeRepo());
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "go" });
    const s = h.session();
    write(dir, "a.txt", "changed\n");
    s.emitTurnEnd({ usage: { costUsd: 0.4, models: [cost("claude-opus-4-1", 0.38), cost("claude-haiku-4-5", 0.02)] } });
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    await h.settle();
    expect(h.engine.state.hud.turnModels?.map((m) => m.model)).toEqual(["claude-opus-4-1", "claude-haiku-4-5"]);
    expect(h.engine.state.hud.sessionModels?.map((m) => [m.model, m.costUsd])).toEqual([["claude-opus-4-1", 0.38], ["claude-haiku-4-5", 0.02]]);
    const summary = h.events.find((e) => e.type === "turn_summary");
    expect(summary).toMatchObject({ models: [{ model: "claude-opus-4-1", costUsd: 0.38 }, { model: "claude-haiku-4-5", costUsd: 0.02 }] });
    const end = h.events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ usage: { models: [{ model: "claude-opus-4-1" }, { model: "claude-haiku-4-5" }] } });

    await h.engine.handle({ type: "accept_all" });
    await h.engine.handle({ type: "send", text: "more" });
    s.emitTurnEnd({ usage: { costUsd: 0.05 } });
    await h.waitFor((x) => x.hud.turnCount === 2, "second turn");
    // A turn without models (an older CLI) clears "the last turn" and adds nothing.
    expect(h.engine.state.hud.turnModels).toBeUndefined();
    expect(h.engine.state.hud.sessionModels?.map((m) => m.costUsd)).toEqual([0.38, 0.02]);
  });
});
