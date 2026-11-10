/**
 * MARK: wave4d w4d-windows — audit polish-07: `gate_closed:<blockedReason>` (and `request_changes_unavailable:<reason>`) in
 * the Mac's words (Core `EngineMessages.gateText`, same English keys), never the engine's raw state in brackets.
 */
import { t } from "./i18n";

export function gateText(reason: string): string {
  switch (reason) {
    case "running":
      return t("Claude is working — wait for the turn to finish");
    case "awaiting_permission":
      return t("Answer the pending permission request first");
    case "collecting":
      return t("Collecting the changes — wait a moment");
    case "reverting":
      return t("Reverting…");
    case "collect_failed":
      return t("Retry collecting the changes first");
    case "pending_review":
      return t("Review the pending files first");
    case "changes_requested":
      return t("Send the requested changes first");
    case "no_session":
      return t("No Claude session is open — restart the session");
    case "starting":
      return t("Claude is still starting — wait a moment");
    case "git_init_needed":
      return t("Initialize the Git repository first");
    default:
      return t("This cannot be sent right now");
  }
}

/** `request_changes_unavailable:<reason>` — the Mac's `EngineMessages` cases. */
export function requestChangesUnavailableText(reason: string): string {
  if (reason === "no_notes") return t("Add a review note first");
  if (reason === "no_review" || reason === "") return t("There is no review to request changes on");
  return gateText(reason);
}
