/**
 * MARK: wave4b w4b-bigturn
 * Settings › General › "디스크 공간" (docs/PROTOCOL.md §39.1, as on the Mac: StorageSettingsSection): the large-file limit
 * (untracked files from this size are stubs in snapshots; live) and [오래된 리뷰 기록 정리] — counts first, then says how
 * many rounds / checkpoints go and about how much space comes back, and removes only after [정리]. The open review and the
 * newest 20 stay; only the app's own refs go (never a branch, tag or stash).
 */
import { useState } from "react";
import type { HistoryCleanupEvent } from "@reviewgate/engine";
import type { AppSettings } from "../../../shared/ipc";
import { cleanupConfirmText, cleanupDoneText, cleanupNothing, cleanupNothingText, DEFAULT_CLEANUP_KEEP, largeFileMBOf, MAX_LARGE_FILE_MB, MIN_LARGE_FILE_MB } from "../../bigTurn";
import { engineRequest, refusalOf } from "../../engineRequest";
import { t } from "../../i18n";
import { isRunning, useStore } from "../../store";

export function StorageSettingsSection({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const hasProject = useStore((s) => s.state.project !== null);
  const running = useStore((s) => isRunning(s.state));
  const value = largeFileMBOf(settings.largeFileMB);
  const [plan, setPlan] = useState<HistoryCleanupEvent | null>(null);
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const set = (v: number) => {
    const n = Math.min(MAX_LARGE_FILE_MB, Math.max(MIN_LARGE_FILE_MB, Math.round(v)));
    if (Number.isFinite(n) && n !== value) void save({ largeFileMB: n });
  };
  const run = async (apply: boolean) => {
    setWorking(true);
    setOutcome(null);
    try {
      const reply = await engineRequest({ type: "history_cleanup", keep: DEFAULT_CLEANUP_KEEP, apply });
      if (apply) {
        setPlan(null);
        setOutcome(cleanupDoneText(reply));
      } else if (cleanupNothing(reply)) setOutcome(cleanupNothingText(reply));
      else setPlan(reply);
    } catch (e) {
      setPlan(null);
      setOutcome(refusalOf(e).error);
    } finally {
      setWorking(false);
    }
  };
  return (
    <section data-testid="Disk space section">
      <h4>{t("Disk space")}</h4>
      <div className="stepper">
        <span style={{ width: 260 }}>{t("Leave untracked files out of snapshots from")}</span>
        <input type="number" value={value} min={MIN_LARGE_FILE_MB} max={MAX_LARGE_FILE_MB} step={10} aria-label={t("Leave untracked files out of snapshots from")}
          onChange={(e) => set(Number(e.target.value))} data-testid="Large file limit" />
        <span>MB</span>
      </div>
      <div className="note">{t("Such a file (a heap dump, an archive) stays in the review list but its content is not stored: it cannot be reverted and the app does not commit it. Files git tracks are always stored.")}</div>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="small" disabled={!hasProject || working || running} onClick={() => void run(false)} data-testid="Clean up review history">
          {t("Clean Up Old Review History…")}
        </button>
      </div>
      <div className="note">
        {!hasProject
          ? t("Open a project to clean up its review history.")
          : running
            ? t("Claude is working — clean up after the turn ends.")
            : t("Keeps the open review and the newest {0} review rounds and checkpoints per chat of this project; removes only what the app pinned (never your branches, tags or stash).", DEFAULT_CLEANUP_KEEP)}
      </div>
      {plan && (
        <div className="banner orange row" style={{ gap: 6 }} role="alertdialog" aria-label={t("Clean up old review history?")} data-testid="Clean up confirm box">
          <span className="grow">{cleanupConfirmText(plan)}</span>
          <button type="button" className="small danger" disabled={working} onClick={() => void run(true)} data-testid="Clean up confirm">{t("Clean Up")}</button>
          <button type="button" className="small" disabled={working} onClick={() => setPlan(null)}>{t("Cancel")}</button>
        </div>
      )}
      {outcome && <div className="note" data-testid="Clean up outcome">{outcome}</div>}
    </section>
  );
}
