import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentNode, PreReviewRun } from "@reviewgate/engine";
import { agentViewOf, waitingOf } from "./agentDetails";
import { agentResultMetaOf, agentUseMetaOf } from "./agentMeta";
import { applyRun, headStatus, normalizeRun, shownFindings } from "./preReview";
import { reportFindingsLine } from "./chatFollowups";

/**
 * wave4 w4-check3: the §36 agent / pre-review shapes as the engine really sends them (engine/test/fixtures/wire/
 * wave3.agents.json, written by engine.wave3Wire.test.ts), through the helpers the store and the screens use — the
 * 0.2.3 screens were built against the §36 examples only. (The Mac's Wave3WireGoldenTests read the same file.)
 */
type Golden = {
  events: Record<string, unknown>[];
  waitingHud: { agents: AgentNode[]; waitingOnAgents: unknown };
  resumedHud: { agents: AgentNode[]; waitingOnAgents: unknown };
  prereviews: PreReviewRun[];
};
const golden = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/wire/wave3.agents.json", import.meta.url), "utf8")) as Golden;
const event = (type: string, id: string) => golden.events.find((e) => e.type === type && (e.id === id || e.toolUseId === id || e.prereviewId === id))!;

describe("the engine's §36 shapes in Electron's helpers", () => {
  it("tool rows keep continues / agentUsage / cliAgentId; a result without them gets none", () => {
    expect(agentUseMetaOf(event("tool_use", "toolu_sm"))).toEqual({ continues: { agentToolUseId: "toolu_ag", agentType: "Explore" } });
    expect(agentUseMetaOf(event("tool_use", "toolu_ag"))).toEqual({});
    expect(agentResultMetaOf(event("tool_result", "toolu_ag"))).toEqual({ agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3" });
    expect(agentResultMetaOf(event("tool_result", "toolu_sm"))).toEqual({});
    expect(reportFindingsLine(event("tool_use", "toolu_rf").input as Record<string, unknown>)).toBe("2 findings · README.md:2, other.txt");
  });

  it("the waiting line and the agent card read the hud as sent", () => {
    expect(waitingOf(golden.waitingHud)).toEqual({ count: 1, longest: { toolUseId: "toolu_ag", type: "Explore", startedAt: 1_700_000_000_000 } });
    expect(waitingOf(golden.resumedHud)?.count).toBe(1); // a blocking continuation counts
    expect(waitingOf({ waitingOnAgents: null })).toBeNull();
    const view = agentViewOf({ node: golden.resumedHud.agents[0], running: true, continuations: 1 });
    expect(view).toMatchObject({ toolUseId: "toolu_ag", prompt: "find couponCode", model: "opus" });
  });

  it("the main chat's run shows its findings on the review", () => {
    const fromEvent = normalizeRun(event("prereview", "toolu_rf") as unknown as PreReviewRun);
    const runs = applyRun(golden.prereviews.map(normalizeRun), fromEvent);
    expect(runs).toHaveLength(1);
    expect(shownFindings(runs).map((i) => [i.finding.file, i.finding.line])).toEqual([["README.md", 2], ["other.txt", null]]);
    expect(headStatus(runs, "<tree B>")).toEqual({ kind: "done", count: 2, stale: false }); // the Changes head counts the chat's too
  });
});
