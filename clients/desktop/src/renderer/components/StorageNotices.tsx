/**
 * MARK: wave4b w4b-bigturn
 * docs/PROTOCOL.md §39.1 on screen (as on the Mac, StorageBanners.swift / ReviewListNotices.swift): the save-failure banner
 * ("디스크가 가득 차서 리뷰를 저장하지 못했어요 — …" with [다시 시도], one per run of failures), one banner below 1 GB free,
 * the HUD's "디스크 여유 1.2 GB" below 2 GB, and above the review list the large files left out of it and "대량 변경".
 */
import { useState } from "react";
import { engineRequest } from "../engineRequest";
import { t } from "../i18n";
import {
  bulkText,
  diskChip,
  diskChipText,
  diskCritical,
  diskCriticalText,
  isBulk,
  largeFileRow,
  largeFilesOf,
  largeFilesText,
  saveFailedText,
  saveFailureNotice,
  BULK_THRESHOLD,
} from "../bigTurn";
import { useStore } from "../store";

/** What this window closed: the failure run (`since`) and the critical-disk banner (once per window). */
let dismissedSince: string | null = null;
let criticalDismissed = false;

export function StorageBanners() {
  const storage = useStore((s) => s.state.storage);
  const [, setTick] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const failure = saveFailureNotice(storage, dismissedSince);
  if (failure) {
    const retry = async () => {
      setRetrying(true);
      try {
        await engineRequest({ type: "retry_save" });
      } catch {
        // still failing: the banner stays (state.storage says so)
      } finally {
        setRetrying(false);
      }
    };
    return (
      <div className="banner red" role="alert" data-testid="Save failed banner">
        <span className="grow col" style={{ alignItems: "flex-start", gap: 2 }}>
          <span>{saveFailedText(failure)}</span>
          {!failure.diskFull && failure.detail && <span className="mono caption truncate" style={{ color: "var(--fg-muted, inherit)" }}>{failure.detail}</span>}
        </span>
        <button type="button" className="small" disabled={retrying} onClick={() => void retry()} title={t("Saves the review, its history and the checkpoints again")} data-testid="Retry save">
          {t("Retry")}
        </button>
        <button type="button" className="small" onClick={() => { dismissedSince = failure.since; setTick((n) => n + 1); }} data-testid="Close save failed banner">
          {t("Close")}
        </button>
      </div>
    );
  }
  const disk = diskCritical(storage, criticalDismissed);
  if (!disk) return null;
  return (
    <div className="banner red" role="alert" data-testid="Disk full banner">
      <span className="grow">{diskCriticalText(disk)}</span>
      <button type="button" className="small" onClick={() => { criticalDismissed = true; setTick((n) => n + 1); }} data-testid="Close disk full banner">
        {t("Close")}
      </button>
    </div>
  );
}

/** HUD: the project disk's free space, only below 2 GB (orange; red below 1 GB). */
export function DiskSpaceChip() {
  const disk = diskChip(useStore((s) => s.state.storage));
  if (!disk) return null;
  const text = diskChipText(disk);
  return (
    <span
      className="item num"
      style={{ color: disk.level === "critical" ? "var(--red)" : "var(--orange)" }}
      title={t("Free space on the project's disk. Settings › General › Clean Up Old Review History frees what the app keeps.")}
      aria-label={text}
      data-testid="HUD disk space"
    >
      {text}
    </span>
  );
}

const SHOWN_PATHS = 5;

/** Above the review list: the large files left out of it (still listed, pending) and the bulk-change line. */
export function ReviewListNotices() {
  const files = useStore((s) => s.state.changedFiles);
  const large = largeFilesOf(files);
  const bulk = isBulk(files.length);
  if (large.length === 0 && !bulk) return null;
  return (
    <div className="banner orange col" style={{ alignItems: "flex-start", gap: 2 }} data-testid="Review list notices">
      {bulk && (
        <span className="bold" title={t("Over {0} files: the list is folded by folder — open a folder to review its files", BULK_THRESHOLD)} data-testid="Bulk change">
          {bulkText(files.length)}
        </span>
      )}
      {large.length > 0 && (
        <>
          <span title={t("Untracked files over the large-file limit (Settings › General) are not stored in snapshots: they cannot be reverted and the app does not commit them")}>
            {largeFilesText(large.length)}
          </span>
          {large.slice(0, SHOWN_PATHS).map((f) => (
            <span key={f.path} className="mono caption truncate" style={{ maxWidth: "100%" }} title={f.path}>
              {largeFileRow(f)}
            </span>
          ))}
          {large.length > SHOWN_PATHS && <span className="caption">{t("+{0} more", large.length - SHOWN_PATHS)}</span>}
        </>
      )}
    </div>
  );
}
