/**
 * docs/PROTOCOL.md §55.11 — what every Settings tab shares (the Mac's SettingsSupport.swift): the "when it applies" badge
 * of a row and the one "다음 세션부터 적용돼요 — [지금 재시작]" banner.
 */
import { t } from "../../i18n";
import { appliesBadge, appliesHelp, settingApplies, settingEntry, type SettingApplies } from "../../settingsIndex";
import { useSettingsWaitingForRestart } from "../../settingsRestart";
import { isRunning, useStore } from "../../store";

/** "다음 세션부터" / "새 프로젝트부터" next to a row's label; nothing for a setting that applies at once. */
export function AppliesBadge({ id, applies }: { id?: string; applies?: SettingApplies }) {
  const kind = applies ?? (id ? settingApplies(id) : "immediately");
  const badge = appliesBadge(kind);
  if (!badge) return null;
  const help = appliesHelp(kind);
  return (
    <span className="applies-badge" title={help ? t(help) : undefined} data-testid="Applies badge">
      <span aria-hidden="true">↻</span> {t(badge)}
    </span>
  );
}

/** Why "Restart now" is off; null = it can restart. */
export function restartUnavailableReason(s: ReturnType<typeof useStore.getState>): string | null {
  if (isRunning(s.state)) return t("Claude is working — wait for the turn to finish");
  if (!s.state.session.canRestart || s.state.session.starting) return t("This window's session cannot restart right now");
  return null;
}

/** On every tab while a setting this window's session read at its start changed; names them, with [지금 재시작]. */
export function SettingsRestartBanner() {
  const waiting = useSettingsWaitingForRestart();
  const reason = useStore(restartUnavailableReason);
  const restartSession = useStore((s) => s.restartSession);
  if (waiting.length === 0) return null;
  const names = waiting.map((id) => t(settingEntry(id)?.title ?? id));
  return (
    <div className="banner orange row settings-restart" role="status" data-testid="Settings restart banner">
      <span aria-hidden="true" className="settings-restart-icon">↻</span>
      <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <strong>{t("Changes apply from the next session")}</strong>
        <span className="caption muted clamp-2" title={names.join("\n")}>{t("Changed: {0}", names.join(" · "))}</span>
      </div>
      <button
        type="button"
        className="small primary"
        disabled={reason !== null}
        onClick={() => void restartSession()}
        title={reason ?? t("Restarting resumes this chat with the new settings; the review list is kept.")}
        data-testid="Settings restart now"
      >
        {t("Restart now")}
      </button>
    </div>
  );
}
