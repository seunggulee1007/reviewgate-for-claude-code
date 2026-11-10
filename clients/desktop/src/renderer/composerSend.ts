/**
 * MARK: r2-review-flow — M30 (§3): a failed collection no longer closes the input; Enter / ⌘↩ with text always does something — it sends,
 * puts it into the turn, queues it, or restarts an ended session and sends (the Mac's Core ReviewFlow+Composer.swift).
 */
import { t } from "./i18n";

// ---------------------------------------------------------------- M30 the composer's Enter / ⌘↩

export type ComposerSendAction = "send" | "steer" | "queue" | "restartAndSend" | "nothing";

/** The action of Enter / ⌘↩ with a typed message (the Mac's `ComposerSendRules.returnAction`). */
export function returnAction(o: { hasText: boolean; canSend: boolean; queueMode: boolean; canSteer: boolean; sessionEnded: boolean; canRestart: boolean }): ComposerSendAction {
  if (!o.hasText) return "nothing";
  if (o.canSend) return "send";
  if (o.sessionEnded) return o.canRestart ? "restartAndSend" : o.queueMode ? "queue" : "nothing";
  if (o.canSteer) return "steer";
  if (o.queueMode) return "queue";
  return "nothing";
}

/** The composer's notice line while a collection failed: the input is open, the next message folds the failed turn in. */
export function collectFailedNotice(detail: string): string {
  const reason = detail.split(/\r?\n/)[0] ?? detail;
  return t("Could not collect the last turn's changes ({0}) — your next message collects them with its own", reason);
}
