import { CommandRefused } from "../errors.js";
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel, type ModelOption } from "../protocol.js";

/** `state.session.availableModels` until the CLI answered `supportedModels()` (§25). */
export const STATIC_MODELS: ModelOption[] = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Complex work and everyday tasks", supportsEffort: true, supportedEffortLevels: [...EFFORT_LEVELS] },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient for simpler tasks", supportsEffort: true, supportedEffortLevels: [...EFFORT_LEVELS] },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest for quick answers", supportsEffort: true, supportedEffortLevels: [...EFFORT_LEVELS] },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "For the toughest challenges", supportsEffort: true, supportedEffortLevels: [...EFFORT_LEVELS] },
];

/** The CLI's `ModelInfo[]` as `ModelOption[]` (unknown fields dropped, effort levels filtered). */
export function toModelOptions(raw: unknown): ModelOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ModelOption[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (typeof o.value !== "string" || !o.value) continue;
    const levels = Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter(isEffortLevel) : undefined;
    out.push({
      value: o.value,
      displayName: typeof o.displayName === "string" && o.displayName ? o.displayName : o.value,
      description: typeof o.description === "string" ? o.description : "",
      ...(typeof o.resolvedModel === "string" && o.resolvedModel ? { resolvedModel: o.resolvedModel } : {}),
      ...(typeof o.supportsEffort === "boolean" ? { supportsEffort: o.supportsEffort } : {}),
      ...(levels && levels.length > 0 ? { supportedEffortLevels: levels } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/** `set_model.model`: an alias or id the CLI understands; `invalid_model` otherwise. `"default"` = the CLI's default (null). */
export function validateModel(model: unknown): string | null {
  if (typeof model !== "string") throw new CommandRefused("invalid_model");
  const m = model.trim();
  if (!m || m.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]*$/.test(m)) throw new CommandRefused(`invalid_model:${model.slice(0, 100)}`, { code: "invalid_model" });
  return m === "default" ? null : m;
}

/** `set_model.effort`: one of the five levels, null (the model's default) or absent (unchanged). */
export function validateEffort(effort: unknown): EffortLevel | null | undefined {
  if (effort === undefined) return undefined;
  if (effort === null) return null;
  if (!isEffortLevel(effort)) throw new CommandRefused(`invalid_effort:${String(effort).slice(0, 40)}`, { code: "invalid_effort" });
  return effort;
}
