/**
 * docs/PROTOCOL.md §70.4 on Windows: Alt+T in the message box turns extended thinking on or off for the chat, as in Claude
 * Code (`set_thinking {enabled}`; `state.session.thinking`). The composer bar's chip shows it and toggles on a click; a
 * model that always thinks (Opus / Sonnet / Haiku 5.5, Fable) keeps the choice — the toggle has no effect there, as in the
 * terminal. As on the Mac (Core ExtendedThinking.swift, App ComposerThinking.swift).
 */
import type { SessionState, ThinkingState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

/** The chat's thinking; null from an engine without §70.4. */
export const thinkingOf = (session: Pick<SessionState, "thinking">): ThinkingState | null => session.thinking ?? null;

/** Claude thinks for the next answer (the choice, or the model's own). */
export const thinks = (s: ThinkingState): boolean => s.enabled || s.alwaysOn;

export const thinkingChipText = (s: ThinkingState): string => (thinks(s) ? t("Thinking on") : t("Thinking off"));

/** The chip's tooltip: the key, and what it does for this model. */
export function thinkingHelp(s: ThinkingState): string {
  if (s.alwaysOn) return t("This model always uses extended thinking — Alt+T has no effect on it");
  return s.enabled
    ? t("Extended thinking is on for this chat — click or press Alt+T to turn it off")
    : t("Extended thinking is off for this chat — click or press Alt+T to turn it on");
}

export const thinkingToggled = (on: boolean): string => (on ? t("Thinking on — from Claude's next request") : t("Thinking off — from Claude's next request"));

/** Why Alt+T and the chip do nothing now; null: they work. */
export function thinkingBlocker(p: { projectOpen: boolean; thinking: ThinkingState | null; terminalChat: boolean; viewing: boolean }): string | null {
  if (!p.projectOpen) return t("Open a project first (⌘O)");
  if (p.thinking === null) return t("This engine cannot change thinking — update ReviewGate");
  if (p.terminalChat) return t("A terminal chat has its own Alt+T");
  if (p.viewing) return t("Go back to the running chat to change thinking");
  return null;
}

/** Alt+T (the physical T: macOS types "†", a Korean layout "ㅅ"); never mid-composition. */
export const isThinkingKey = (e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }): boolean =>
  !e.isComposing && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === "KeyT" || e.key.toLowerCase() === "t");

/** What Alt+T / the chip did: the composer's line (`warning`: a refusal). */
export type ThinkingOutcome = { notice: string; warning: boolean };

/** The other state; a model that always thinks keeps the choice as it is. */
export async function toggleThinking(state: ThinkingState | null, blocker: string | null): Promise<ThinkingOutcome> {
  if (blocker !== null || state === null) return { notice: blocker ?? "", warning: true };
  if (state.alwaysOn) return { notice: thinkingHelp(state), warning: false };
  try {
    await engineRequest({ type: "set_thinking", enabled: !state.enabled });
    return { notice: thinkingToggled(!state.enabled), warning: false };
  } catch (e: unknown) {
    return { notice: refusalMessage(refusalOf(e)), warning: true };
  }
}
