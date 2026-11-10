/**
 * MARK: wave4d w4d-agents2 — docs/PROTOCOL.md §42.4: what each model cost in a turn. The SDK's `result.modelUsage` is
 * cumulative across the turns of a streaming session (like `total_cost_usd`): a turn's share is the difference from
 * the previous owned result's numbers. Main loop, subagents and compaction all land here; the numbers are the CLI's
 * estimate, not a bill.
 */
import type { ModelCost } from "../protocol.js";

/** One entry of the SDK's `modelUsage` as it may come (older CLIs omit fields; anything else reads as 0). */
type RawModelUsage = { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheCreationInputTokens?: unknown; costUSD?: unknown };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function normalized(model: string, u: RawModelUsage): ModelCost {
  return {
    model,
    costUsd: num(u.costUSD),
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadInputTokens),
    cacheCreationTokens: num(u.cacheCreationInputTokens),
  };
}

const FIELDS = ["costUsd", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

/** Most expensive first; equal costs by name (stable on both clients). */
function sorted(models: ModelCost[]): ModelCost[] {
  return models.sort((a, b) => b.costUsd - a.costUsd || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/**
 * This turn's per-model usage: `cur` (the latest cumulative `modelUsage`) minus `prev` (the numbers of the previous owned
 * result). `reset` (the session total went down — a /clear, a fresh process) or a model whose numbers went down takes
 * the numbers as they are. Models without any change are left out. `next` is the baseline for the next turn (`prev`
 * itself when no `modelUsage` came, so a later result still differences against the last one seen).
 */
export function modelCostDelta(prev: ReadonlyMap<string, ModelCost>, cur: Record<string, RawModelUsage> | undefined | null, reset: boolean): { models: ModelCost[]; next: ReadonlyMap<string, ModelCost> } {
  if (!cur || typeof cur !== "object") return { models: [], next: prev };
  const next = new Map<string, ModelCost>();
  const models: ModelCost[] = [];
  for (const [model, raw] of Object.entries(cur)) {
    if (!model || !raw || typeof raw !== "object") continue;
    const now = normalized(model, raw);
    next.set(model, now);
    const before = reset ? undefined : prev.get(model);
    const wentDown = before !== undefined && FIELDS.some((k) => now[k] < before[k]);
    const delta: ModelCost = { ...now };
    if (before && !wentDown) for (const k of FIELDS) delta[k] = now[k] - before[k];
    if (FIELDS.some((k) => delta[k] > 0)) models.push(delta);
  }
  return { models: sorted(models), next };
}

/** `a` + `b` per model (the HUD's `sessionModels`), most expensive first. */
export function addModelCosts(a: readonly ModelCost[], b: readonly ModelCost[]): ModelCost[] {
  const out = new Map<string, ModelCost>(a.map((m) => [m.model, { ...m }]));
  for (const m of b) {
    const had = out.get(m.model);
    if (!had) out.set(m.model, { ...m });
    else for (const k of FIELDS) had[k] += m[k];
  }
  return sorted([...out.values()]);
}
