/**
 * MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 plans you can review and follow: the client rules the Mac keeps in
 * Core `PlanReview.swift` (same words): the keep-planning message from per-step notes, the plan section's words by where
 * its plan came from, the plan row after an approval elsewhere, and the branch suggested for a plan's workbench.
 */
import type { PendingPlan, PlanApprovedEvent, PlanStepBrief, TurnSummaryEvent } from "@reviewgate/engine";
import { t } from "./i18n";

type SummaryPlan = NonNullable<TurnSummaryEvent["plan"]>;
const QUOTE_LIMIT = 60;

const quote = (text: string): string => {
  const s = text.trim();
  return s.length > QUOTE_LIMIT ? `${s.slice(0, QUOTE_LIMIT - 1)}…` : s;
};

/** "계속 계획": one line per noted step ("단계 3 (…): …"), then the general note; null when nothing was written. */
export function planNotesMessage(steps: readonly PlanStepBrief[], notes: Readonly<Record<number, string>>, general: string): string | null {
  const lines: string[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    const note = notes[step.index]?.trim();
    if (note) lines.push(t("Step {0} ({1}): {2}", step.index + 1, quote(step.text), note));
  }
  const rest = general.trim();
  if (rest) lines.push(rest);
  return lines.length > 0 ? lines.join("\n") : null;
}

export const planNoteCount = (notes: Readonly<Record<number, string>>): number => Object.values(notes).filter((n) => n.trim().length > 0).length;

/** The engine sends the plan's steps: per-step notes and the new chat / workbench answers work (an older one would implement here). */
export const planReviewSupported = (plan: PendingPlan | null): boolean => plan !== null && Array.isArray(plan.steps);

/** Why [새 채팅에서 구현] / [새 워크벤치에서 구현] cannot be used; null = they can. */
export function planHandoffBlocker(plan: PendingPlan | null, locked: boolean): string | null {
  if (!planReviewSupported(plan)) return t("Needs the engine of this app version — reopen the project");
  if (locked) return t("Claude is working — the plan waits until the turn ends");
  return null;
}

export const isRequestScope = (plan: SummaryPlan): boolean => plan.source === "request";

export function planSourceTitle(plan: SummaryPlan): string {
  switch (plan.source) {
    case "file":
      return t("Against the plan file");
    case "todos":
      return t("Against Claude's to-do list");
    case "message":
      return t("Against your first message's list");
    case "request":
      return t("Request scope");
    default:
      return t("Against the plan");
  }
}

export const unplannedTitle = (plan: SummaryPlan): string => (isRequestScope(plan) ? t("Outside the request") : t("Changes outside the plan"));
export const unplannedHelp = (plan: SummaryPlan): string =>
  isRequestScope(plan)
    ? t("Your first request and the files it @-mentions do not name these files — check they belong in this change.")
    : t("No plan step mentions these files — check they belong in this change.");
export const unplannedChip = (count: number, plan: SummaryPlan): string => (isRequestScope(plan) ? t("{0} outside the request", count) : t("{0} unplanned", count));
export const unplannedBadge = (plan: SummaryPlan): string => (isRequestScope(plan) ? t("Outside the request") : t("Unplanned"));

const lastPart = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/** The plan row after `plan_approved {into}`. */
export function planHandoffLine(ev: Pick<PlanApprovedEvent, "into" | "target" | "from">): string {
  if (ev.into === "new_chat") return t("Plan approved — implementing it in this new chat");
  if (ev.target) return t("Plan approved — sent to the workbench {0} to implement there", lastPart(ev.target));
  return t("Implementing the plan approved in {0}", ev.from ? lastPart(ev.from) : "?");
}

/** `plan/<file name>` for the plan's workbench ("db-migration.md" → "plan/db-migration"); "" without a usable name. */
export function suggestPlanBranch(planPath: string | null): string {
  if (!planPath) return "";
  const stem = lastPart(planPath).replace(/\.[^.]*$/, "").toLowerCase();
  const slug = stem.replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug ? `plan/${slug}` : "";
}
