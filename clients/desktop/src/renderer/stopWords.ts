/**
 * MARK: wave4b w4b-check4
 * docs/PROTOCOL.md §40.1: the turn-end line says why the turn ended in words — the stop reasons of §38.1's list — instead of
 * the CLI's raw `stopReason` (`error_max_turns`, `success`, …). Mac: Core TurnEndStopWords.swift (same keys).
 */
import { t } from "./i18n";

/** `turn_end.stopReason` in words; an unknown value is shown as it came (a newer CLI / engine). */
export function stopReasonWords(raw: string): string {
  switch (raw.trim()) {
    case "success":
    case "ended":
    case "end_turn":
      return t("Finished");
    case "interrupted":
      return t("Stopped by you");
    case "error_max_turns":
      return t("Stopped at the tool-call limit");
    case "error_max_budget_usd":
      return t("Stopped at the cost limit");
    case "error":
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return t("Stopped by an error");
    case "session restarted":
      return t("Stopped — the session restarted");
    case "session closed":
      return t("Stopped — the session closed");
    case "chat moved":
      return t("Stopped — the chat moved to another worktree");
    default:
      return raw;
  }
}
