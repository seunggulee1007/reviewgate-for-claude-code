/**
 * MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: '왜?' on plan steps and agent cards (the Mac's Core `WhyQuestions`, same
 * words). A side question (§21) about a plan step quotes the step (§40.3 `quote` anchor); one about an agent anchors at
 * its Agent call (`toolUseId`: the call and Claude's words before it). The question names the step itself, so an engine
 * that does not read the anchor still knows what is asked.
 */
import type { SideAnchor } from "@reviewgate/engine";
import { t } from "./i18n";

/** Longest step text the question repeats (the quote keeps the whole step). */
const QUESTION_LIMIT = 120;

export type WhyQuestion = { anchor: SideAnchor; question: string };

/** Step `number` (1-based, as shown) of a plan. */
export function planStepWhy(number: number, text: string): WhyQuestion {
  const step = text.trim();
  const shown = step.length > QUESTION_LIMIT ? `${step.slice(0, QUESTION_LIMIT - 1)}…` : step;
  return {
    anchor: { quote: { text: `${number}. ${step}`, turn: null } },
    question: t("Step {0} of the plan, “{1}” — why is it needed, and which changes so far belong to it?", number, shown),
  };
}

/** An agent, by its Agent / Task call. */
export function agentWhy(toolUseId: string): WhyQuestion {
  return { anchor: { toolUseId }, question: t("Why was this agent started, and what did it find or change?") };
}
