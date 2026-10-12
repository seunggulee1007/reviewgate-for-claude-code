/**
 * MARK: wave4d w4d-agents2 — docs/PROTOCOL.md §42.4: what each model cost, as both clients show it (Core `ModelCostText` is
 * the same rule; both are checked against engine/test/fixtures/modelCosts.json): the HUD's cost popover and the turn
 * summary's bar "opus $0.38 · sonnet $0.06 · haiku $0.01", and the model an agent card names.
 */
import type { AgentNode, ModelCost } from "@reviewgate/engine";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "other";

/** One bar segment: a model family's (or an unknown model's) cost in a turn. */
export type ModelCostShare = {
  /** "opus" / "sonnet" / "haiku", else the model's own label. */
  key: string;
  label: string;
  family: ModelFamily;
  costUsd: number;
  /** Its share of the turn's cost (0…1). */
  fraction: number;
  /** The model ids folded into it, in the order they came. */
  models: string[];
  tokens: number;
};

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

/** A model outside the three families: its id without `claude-` and the date (`claude-fable-1-20260101` → `fable-1`). */
export function otherModelLabel(model: string): string {
  return model.trim().replace(/^claude-/i, "").replace(/-\d{8}(?=$|\[)/, "");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The entries of a `models` list that read as one (an older engine sends none: []). */
export function modelCostsOf(raw: unknown): ModelCost[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelCost[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (typeof o.model !== "string" || !o.model) continue;
    out.push({ model: o.model, costUsd: num(o.costUsd), inputTokens: num(o.inputTokens), outputTokens: num(o.outputTokens), cacheReadTokens: num(o.cacheReadTokens), cacheCreationTokens: num(o.cacheCreationTokens) });
  }
  return out;
}

/** The models of a turn grouped by family, most expensive first; what cost nothing is left out. */
export function modelShares(models: readonly ModelCost[] | undefined | null): ModelCostShare[] {
  const byKey = new Map<string, ModelCostShare>();
  for (const m of modelCostsOf(models)) {
    if (m.costUsd <= 0) continue;
    const family = modelFamily(m.model);
    const label = family === "other" ? otherModelLabel(m.model) : family;
    const tokens = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
    const had = byKey.get(label);
    if (had) {
      had.costUsd += m.costUsd;
      had.tokens += tokens;
      if (!had.models.includes(m.model)) had.models.push(m.model);
    } else byKey.set(label, { key: label, label, family, costUsd: m.costUsd, fraction: 0, models: [m.model], tokens });
  }
  const shares = [...byKey.values()];
  const total = shares.reduce((n, s) => n + s.costUsd, 0);
  for (const s of shares) s.fraction = total > 0 ? s.costUsd / total : 0;
  return shares.sort((a, b) => b.costUsd - a.costUsd || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** "$0.38"; under half a cent "<$0.01". */
export function costUsd(v: number): string {
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

/** "opus $0.38 · sonnet $0.06 · haiku $0.01" ("" for none). */
export function modelCostLine(shares: readonly ModelCostShare[]): string {
  return shares.map((s) => `${s.label} ${costUsd(s.costUsd)}`).join(" · ");
}

/** The model an agent card names: the one its answers came from (§42.4), else the one its call named (§36.1). */
export function agentModel(node: Pick<AgentNode, "model" | "apiModel"> | undefined | null): string | null {
  if (!node) return null;
  const ran = typeof node.apiModel === "string" && node.apiModel ? node.apiModel : null;
  return ran ?? node.model ?? null;
}
