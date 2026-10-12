/**
 * A chat Claude Code can no longer continue (`SessionMeta.resumeFailed`, docs/PROTOCOL.md §30): only its transcript is
 * left. The chat list and the tabs mark it "기록만"; opening it from the history says first that opening makes the engine
 * try to resume it again, which starts yet another new chat for whatever is sent next. wave4b w4b-tabs (§39.2): a tab
 * only shows its rows (nothing opens), so the tab's confirmation dialog is gone.
 */
import { t } from "../../i18n";
import "../session.css";

export const recordOnlyQuestion = () => t("Claude Code has no record of this chat, so it cannot be continued. View its content only?");
export const recordOnlyNote = () => t("Opening it starts one more new chat for what you send next.");

export function RecordOnlyBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`pill orange ${className}`} title={t("Claude Code has no record of this chat, so it cannot be continued — its content stays readable")} data-testid="Record only">
      {t("History only")}
    </span>
  );
}
