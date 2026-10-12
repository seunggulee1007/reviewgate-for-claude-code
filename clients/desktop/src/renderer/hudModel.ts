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
