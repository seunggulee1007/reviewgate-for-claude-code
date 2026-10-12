/**
 * MARK: wave5 w5-model — docs/PROTOCOL.md §43.4 auto model, Electron side: the words for a turn's model (the chat's faint
 * switch line, the turn summary, the HUD chip and its hover, the cost popover's counts) and the composer's one-message
 * models. Same English keys as the Mac's Core `AutoModelText` (one translation, gen-i18n.mjs).
 */
import type { AutoModelChoice, AutoModelCount, AutoModelPolicy, ModelOption } from "@reviewgate/engine";
import { modelLabel } from "./agentDetails";
import { modelFamily } from "./agentCost";
import { t } from "./i18n";

const REASONS: Record<string, string> = {
  plan_mode: "planning",
  plan_implementation: "implementing the approved plan",
  after_failure: "retry after a failed turn",
  after_revert: "retry after a revert",
  changes_requested: "changes requested",
  design: "design decision",
  debug: "root-cause analysis",
  refactor: "refactoring",
  why: "a “why” question",
  wide_scope: "wide scope",
  long_message: "long request",
  attachments: "many attachments",
  quality_policy: "quality first",
  trivial_edit: "small fix",
  quick_question: "short question",
  short_message: "short request",
  standard: "everyday work",
  cost_policy: "cost first",
  simple_task: "simple request",
  continuation: "continuing",
  user_choice: "your pick for this message",
  manual: "back to your model",
};

/** The reason in words ("설계 판단"); an unknown code reads as itself. */
export function autoModelReason(code: string): string {
  const key = REASONS[code];
  return key ? t(key) : code;
}

/** "비용 우선" / "균형" / "품질 우선". */
export function autoModelPolicyName(policy: AutoModelPolicy): string {
  return policy === "cost" ? t("Cost first") : policy === "quality" ? t("Quality first") : t("Balanced");
}

/** The policy's one line under the picker. */
export function autoModelPolicyDetail(policy: AutoModelPolicy): string {
  if (policy === "cost") return t("haiku for simple requests, opus only for plans and the hardest work");
  if (policy === "quality") return t("opus for everything but the simplest requests");
  return t("opus for design, debugging and big changes, haiku for tiny fixes");
}

/** The model's short name: the family ("opus"), else the id as the HUD shows it, else "기본 모델". */
export function autoModelName(choice: AutoModelChoice): string {
  if (choice.family) return choice.family;
  if (!choice.model) return t("Default model");
  const family = modelFamily(choice.model);
  return family === "other" ? modelLabel(choice.model) : family;
}

/** The chat's faint line when the model changed before a message; null otherwise. */
export function autoModelSwitchLine(choice: AutoModelChoice | null | undefined): string | null {
  if (!choice || choice.switched !== true) return null;
  return t("Switched the model to {0} — {1}", autoModelName(choice), autoModelReason(choice.reason));
}

/** The turn summary's line: "모델: opus (자동 · 설계 판단)". */
export function autoModelSummaryLine(choice: AutoModelChoice): string {
  const why = choice.by === "auto" ? t("Auto · {0}", autoModelReason(choice.reason)) : autoModelReason(choice.reason);
  return t("Model: {0} ({1})", autoModelName(choice), why);
}

/** The chip in auto mode: "자동 · sonnet", "자동" before the first message. */
export function autoModelChipText(choice: AutoModelChoice | null | undefined): string {
  if (!choice || choice.by !== "auto") return t("Auto");
  return t("Auto · {0}", autoModelName(choice));
}

/** The chip's hover in auto mode. */
export function autoModelChipHelp(choice: AutoModelChoice | null | undefined, policy: AutoModelPolicy): string {
  if (!choice || choice.by !== "auto") return t("Auto picks the model for each message ({0})", autoModelPolicyName(policy));
  return t("Auto picked {0} — {1} ({2})", autoModelName(choice), autoModelReason(choice.reason), autoModelPolicyName(policy));
}

/** The cost popover's line: "opus 3 · sonnet 5 · haiku 2" (null without counts). */
export function autoModelCountsLine(counts: AutoModelCount[] | null | undefined): string | null {
  const parts = (counts ?? []).filter((c) => c && typeof c.family === "string" && c.count > 0).map((c) => `${c.family} ${c.count}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The composer's one-message pick: "이번엔 opus". */
export function nextMessageLabel(model: string): string {
  const family = modelFamily(model);
  return t("This time {0}", family === "other" ? modelLabel(model) : family);
}

/** major * 1000 + minor of an option (a bare alias without a resolved id counts as the newest). */
function versionOf(o: ModelOption): number {
  if (!o.resolvedModel && ["opus", "sonnet", "haiku"].includes(o.value.toLowerCase())) return Number.MAX_SAFE_INTEGER;
  const nums = (o.resolvedModel ?? o.value).replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").match(/\d+/g);
  if (!nums || nums.length === 0) return -1;
  return Number(nums[0]) * 1000 + Number(nums[1] ?? 0);
}

/** The families the composer offers for one message: the newest option of each (as the engine picks), opus / sonnet / haiku. */
export function oneMessageOptions(models: ModelOption[]): { family: "opus" | "sonnet" | "haiku"; value: string }[] {
  const out: { family: "opus" | "sonnet" | "haiku"; value: string }[] = [];
  for (const family of ["opus", "sonnet", "haiku"] as const) {
    const of = models.filter((m) => m.value !== "default" && (modelFamily(m.value) === family || modelFamily(m.resolvedModel ?? "") === family));
    const plain = of.filter((m) => !m.value.includes("["));
    const pool = plain.length > 0 ? plain : of;
    let best: ModelOption | null = null;
    for (const m of pool) if (!best || versionOf(m) > versionOf(best)) best = m;
    if (best) out.push({ family, value: best.value });
  }
  return out;
}
