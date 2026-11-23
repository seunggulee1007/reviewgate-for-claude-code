/**
 * HUD pure helpers: the §25 model picker's current option and the effort to send with a model switch, and the §27
 * context meter levels (amber from 80 % — where `context_warning` fires — red from 95 %).
 */
import type { EffortLevel, ModelOption } from "@reviewgate/engine";

/** The option the session runs with: `selectedModel` by value (null = "default"), else the reported model id. */
export function currentModelOption(models: ModelOption[], selected: string | null | undefined, reported: string | null): ModelOption | null {
  const want = selected ?? "default";
  return models.find((m) => m.value === want) ?? (reported ? models.find((m) => m.value === reported || m.resolvedModel === reported) : undefined) ?? null;
}

/** The effort to send with a model switch: unchanged (undefined) when the new model takes it, else back to its default (null). */
export function effortForSwitch(next: ModelOption, effort: EffortLevel | null): EffortLevel | null | undefined {
  if (effort === null) return undefined;
  if (next.supportsEffort && (next.supportedEffortLevels ?? []).includes(effort)) return undefined;
  return null;
}

/** §27: amber from 80 % (where `context_warning` fires), red from 95 %. */
export function contextLevel(fraction: number): "ok" | "warn" | "critical" {
  if (fraction >= 0.95) return "critical";
  if (fraction >= 0.8) return "warn";
  return "ok";
}

export function contextColor(fraction: number): string {
  const level = contextLevel(fraction);
  return level === "critical" ? "var(--red)" : level === "warn" ? "var(--orange)" : "var(--green)";
}

/**
 * §56.5: what the HUD shows of its numbers — nothing that is still zero. The context meter once the session reported tokens,
 * the cost once there is one, the turn and its time once a turn ran (or while one runs); a fresh chat's HUD is the model and
 * "Idle" instead of "0 tokens · $0.00 session · turn 0 · 0.0s".
 */
export function hudShown(hud: { contextTokens: number; sessionCostUSD: number; turnCount: number }, running: boolean): { context: boolean; cost: boolean; turn: boolean } {
  return { context: hud.contextTokens > 0, cost: hud.sessionCostUSD > 0, turn: running || hud.turnCount > 0 };
}
