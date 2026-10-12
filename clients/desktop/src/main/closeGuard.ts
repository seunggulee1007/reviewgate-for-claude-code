/**
 * MARK: wave4 w4-safety — audit daily-12 / polish-12: closing a window (the close button, Ctrl+W, Alt+F4) or quitting
 * while Claude works — a turn runs, or a permission card / question / plan waits for the user — asks first, the Mac's
 * rule (Core `CloseGuard.swift`, same keys). Idle windows close without asking; "Don't ask again" turns it off
 * (Settings › General). Pure: the dialog itself is shown by src/main/windows.ts / main.ts.
 */
import type { ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { t } from "../renderer/i18n";

export type CloseGuardReason = "working" | "waiting";

/** Why closing this window now would stop Claude; null = idle. Waiting wins (the card goes away with the session). */
export function closeGuardReason(state: Pick<ReviewState, "gate" | "session">): CloseGuardReason | null {
  const s = state.session;
  const waits = s.pendingPermission !== null || (s.pendingPermissions?.length ?? 0) > 0 || s.pendingPlan !== null;
  if (waits) return "waiting";
  return state.gate.phase === "running" ? "working" : null;
}

/** The reason to ask before closing — null when idle or when the user turned the question off. */
export function closeConfirmationReason(state: Pick<ReviewState, "gate" | "session">, settings: Pick<AppSettings, "confirmCloseWhileWorking">): CloseGuardReason | null {
  if (settings.confirmCloseWhileWorking === false) return null;
  return closeGuardReason(state);
}

export type CloseDialogText = { title: string; message: string; confirm: string; cancel: string; dontAskAgain: string };

/** The dialog's words: one window being closed, or every window that would stop on quit (more than one: their count). */
export function closeDialogText(reasons: CloseGuardReason[], kind: "close" | "quit"): CloseDialogText {
  const one = (r: CloseGuardReason) => (r === "waiting" ? t("Claude is waiting for your answer. Closing stops this turn.") : t("Closing stops this turn."));
  const message = kind === "quit" && reasons.length > 1 ? t("Claude is working in {0} windows. Quitting stops those turns.", reasons.length) : one(reasons[0] ?? "working");
  return {
    title: t("Claude is working right now"),
    message,
    confirm: kind === "quit" ? t("Quit") : t("Close"),
    cancel: t("Cancel"),
    dontAskAgain: t("Don't ask again"),
  };
}
