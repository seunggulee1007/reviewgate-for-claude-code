// MARK: wave4d w4d-agents2 — §42.4: the per-model cost rule, the same cases as Core ModelCostTests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelCost } from "@reviewgate/engine";
import { agentModel, costUsd, modelCostLine, modelCostsOf, modelShares } from "./agentCost";
import { modelLabel } from "./agentDetails";

type Case = {
  models: ModelCost[];
  shares: { key: string; label: string; family: string; costUsd: number; percent: number; models: string[] }[];
  line: string;
};

describe("per-model cost (§42.4)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/modelCosts.json", import.meta.url), "utf8")) as { cases: Case[] };

  it("groups by family, most expensive first, as the engine's fixture says", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of fixture.cases) {
      const got = modelShares(c.models);
      expect(got.map((s) => [s.key, s.label, s.family, Math.round(s.fraction * 100), s.models])).toEqual(c.shares.map((s) => [s.key, s.label, s.family, s.percent, s.models]));
      got.forEach((s, i) => expect(s.costUsd).toBeCloseTo(c.shares[i]!.costUsd, 9));
      expect(modelCostLine(got)).toBe(c.line);
    }
  });

  it("reads the lists leniently (an older engine sends none)", () => {
    expect(modelShares(undefined)).toEqual([]);
    expect(modelCostsOf("x")).toEqual([]);
    expect(modelCostsOf([{ model: "claude-opus-4-1", costUsd: 0.38, inputTokens: "x" }, { costUsd: 1 }, 7, { model: "", costUsd: 1 }])).toEqual([
      { model: "claude-opus-4-1", costUsd: 0.38, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
  });

  it("formats dollars as the Mac does", () => {
    expect(costUsd(0.38)).toBe("$0.38");
    expect(costUsd(0.004)).toBe("<$0.01");
    expect(costUsd(0)).toBe("$0.00");
    expect(costUsd(1.234)).toBe("$1.23");
  });

  it("an agent names the model it ran on, else the one its call named", () => {
    expect(agentModel({ model: "opus" })).toBe("opus");
    expect(agentModel({ model: null, apiModel: "claude-sonnet-4-5-20250929" })).toBe("claude-sonnet-4-5-20250929");
    expect(agentModel({ model: null })).toBeNull();
    expect(agentModel(undefined)).toBeNull();
  });

  it("the model chip reads like the Mac's (`opus 4.1`, `sonnet 4.5`)", () => {
    expect(modelLabel("opus")).toBe("opus");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("opus 4.1");
    expect(modelLabel("claude-3-5-haiku-20241022")).toBe("haiku 3.5");
    expect(modelLabel("claude-sonnet-4-5[1m]")).toBe("sonnet 4.5");
    expect(modelLabel("fable")).toBe("fable");
  });
});
