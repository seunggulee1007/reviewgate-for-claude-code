/**
 * MARK: polish p-lifecycle — P5-sheets-49 / §48 Windows: the update in every window's banner stack (src/main/update.ts) —
 *   "ReviewGate 0.6.0 is available" [Install and Restart] [What's New] [Download Page] [Later]
 *   "Installing ReviewGate 0.6.0" · "Downloading 12.4 / 115.3 MB" ▬▬▭ [Cancel] [Download Page]
 *   "… is ready. Claude is working — …" · "acme-api: Claude is working" [Restart Now] [Cancel]
 *   "Ready — ReviewGate closes and reopens as 0.6.0"
 *   "Could not install ReviewGate 0.6.0" · why [Try Again] [Download Page] [×]
 * and, once after the restart, "Updated to ReviewGate 0.6.0" [What's New] [×] or "… did not install — why" [Try Again]
 * [Download Page] [×]. The Mac's AppUpdateViews.swift.
 */
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../shared/ipc";
import { t } from "../i18n";
import { downloadFraction, downloadPageHelp, installDetail, installHelp, installTitle, noticeDetail, noticeTitle } from "../updateWords";
import { Markdown } from "./chat/Markdown";
import { Modal } from "./Menu";

/** The update's state from main, kept current. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const rg = window.rg;
    let live = true;
    void rg.updateStatus?.().then((s) => live && setStatus(s));
    const off = rg.onUpdateStatus?.((s) => setStatus(s));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return status;
}

export type UpdateActions = {
  install: () => void;
  cancel: () => void;
  restartNow: () => void;
  later: () => void;
  dismiss: (which: "install" | "notice") => void;
  openPage: () => void;
  focus: (id: number) => void;
  notes: (version: string) => void;
};

export const updateActions = (showNotes: (version: string) => void): UpdateActions => ({
  install: () => void window.rg.installUpdate?.(),
  cancel: () => void window.rg.cancelUpdate?.(),
  restartNow: () => void window.rg.restartNowForUpdate?.(),
  later: () => void window.rg.dismissUpdate?.(),
  dismiss: (which) => void window.rg.dismissUpdateNotice?.(which),
  openPage: () => void window.rg.openUpdate?.(),
  focus: (id) => void window.rg.focusUpdateBlocker?.(id),
  notes: showNotes,
});

/** A bar while the download's size is known, a spinner through the checks and "Ready" (the wait has its own lines). */
export function UpdateProgress({ install }: { install: NonNullable<UpdateStatus["install"]> }) {
  const fraction = downloadFraction(install);
  const detail = installDetail(install);
  if (fraction !== null) {
    const pct = Math.round(fraction * 100);
    return (
      <div className="progress update-progress" role="progressbar" aria-label={t("Download progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={detail} title={t("How much of the update has been downloaded")} data-testid="Update progress">
        <div style={{ width: `${pct}%` }} />
      </div>
    );
  }
  if (install.kind === "downloading" || install.kind === "verifying" || install.kind === "ready") return <span className="spinner" role="img" aria-label={detail} title={detail} data-testid="Update progress" />;
  return null;
}

function DownloadPage({ actions, primary = false }: { actions: UpdateActions; primary?: boolean }) {
  return (
    <button type="button" className={primary ? "small primary" : "small"} onClick={actions.openPage} title={downloadPageHelp()} data-testid="Open release page">
      {t("Download Page")}
    </button>
  );
}

function Close({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <button type="button" className="plain small" onClick={onClick} title={t("Hide this notice")} aria-label={t("Hide this notice")} data-testid={testId}>
      ✕
    </button>
  );
}

/** The banners for a status (props only — tested with react-dom/server). */
export function UpdateBannerView({ status, actions }: { status: UpdateStatus; actions: UpdateActions }) {
  const { install, notice, release } = status;
  return (
    <>
      {notice && !(notice.kind === "failed" && install) && (
        <div className={`banner ${notice.kind === "updated" ? "green" : "orange"}`} role="status" data-testid="Update result">
          <span className="grow truncate" title={noticeDetail(notice)}>
            <strong>{noticeTitle(notice)}</strong> · {noticeDetail(notice)}
          </span>
          {notice.kind === "updated" && notice.hasNotes && (
            <button type="button" className="small" onClick={() => actions.notes(notice.version)} title={t("What changed in the version you now have")} data-testid="Installed update notes">
              {t("What's New")}
            </button>
          )}
          {notice.kind === "failed" && (
            <>
              <button type="button" className="small primary" onClick={actions.install} title={t("Looks the release up again and installs it")} data-testid="Retry update">
                {t("Try Again")}
              </button>
              <DownloadPage actions={actions} />
            </>
          )}
          <Close onClick={() => actions.dismiss("notice")} testId="Dismiss update result" />
        </div>
      )}
      {install && (
        <div className={`banner ${install.kind === "failed" ? "orange" : "blue"}`} role="status" aria-live="polite" data-testid="Update banner">
          <UpdateProgress install={install} />
          <span className="grow truncate" title={installDetail(install)}>
            <strong>{installTitle(install)}</strong> · {installDetail(install)}
          </span>
          {install.kind === "waiting" &&
            install.blockers.map((b) => (
              <button key={b.id} type="button" className="plain small" onClick={() => actions.focus(b.id)} title={t("Brings that window to the front")} data-testid="Update waits for">
                {b.line}
              </button>
            ))}
          {install.kind === "waiting" && (
            <button type="button" className="small primary" onClick={actions.restartNow} title={t("The turns that run are stopped.")} data-testid="Restart now for update">
              {t("Restart Now")}
            </button>
          )}
          {(install.kind === "downloading" || install.kind === "verifying" || install.kind === "waiting") && (
            <button type="button" className="small" onClick={actions.cancel} title={t("Stops the update — the download is removed")} data-testid="Cancel update">
              {t("Cancel")}
            </button>
          )}
          {install.kind === "failed" && (
            <button type="button" className="small primary" onClick={actions.install} title={t("Looks the release up again and installs it")} data-testid="Install update">
              {t("Try Again")}
            </button>
          )}
          {install.kind !== "ready" && <DownloadPage actions={actions} />}
          {install.kind === "failed" && <Close onClick={() => actions.dismiss("install")} testId="Dismiss update failure" />}
        </div>
      )}
      {!install && release && !(notice?.kind === "failed" && notice.version === release.version) && (
        <div className="banner blue" role="status" data-testid="Update banner">
          <span className="grow truncate" title={t("This app is {0}; the latest release is {1}.", status.current, release.version)}>
            <strong>{t("ReviewGate {0} is available", release.version)}</strong> · {t("This app is {0}; the latest release is {1}.", status.current, release.version)}
          </span>
          <button type="button" className="small primary" onClick={actions.install} disabled={release.why !== null} title={installHelp(release.why)} aria-label={`${t("Install and Restart")} — ${installHelp(release.why)}`} data-testid="Install update">
            {t("Install and Restart")}
          </button>
          {release.hasNotes && (
            <button type="button" className="small" onClick={() => actions.notes(release.version)} title={t("Release notes of ReviewGate {0}", release.version)} data-testid="Update notes">
              {t("What's New")}
            </button>
          )}
          <DownloadPage actions={actions} />
          <button type="button" className="small" onClick={actions.later} title={t("Hide this version — the next one is announced again")} data-testid="Dismiss update">
            {t("Later")}
          </button>
        </div>
      )}
    </>
  );
}

/** [What's New]: the release notes (Markdown; links open in the browser) and the release page. */
export function UpdateNotesDialog({ version, onClose, onOpenPage }: { version: string; onClose: () => void; onOpenPage: () => void }) {
  const [notes, setNotes] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void window.rg.updateNotes?.(version).then((n) => live && setNotes(n ?? null));
    return () => {
      live = false;
    };
  }, [version]);
  return (
    <Modal title={t("What's New in ReviewGate {0}", version)} onClose={onClose} wide testId="Update notes dialog">
      <div className="update-notes">{notes === undefined ? <span className="spinner" /> : notes && notes.trim() ? <Markdown text={notes} /> : <span className="note">{t("No release notes.")}</span>}</div>
      <div className="actions">
        <button type="button" onClick={onOpenPage} title={downloadPageHelp()}>
          {t("Open Release Page")}
        </button>
        <span className="spacer" />
        <button type="button" className="primary" autoFocus onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </Modal>
  );
}

export function UpdateBanner() {
  const status = useUpdateStatus();
  const [notesOf, setNotesOf] = useState<string | null>(null);
  if (!status) return null;
  const actions = updateActions(setNotesOf);
  return (
    <>
      <UpdateBannerView status={status} actions={actions} />
      {notesOf && <UpdateNotesDialog version={notesOf} onClose={() => setNotesOf(null)} onOpenPage={actions.openPage} />}
    </>
  );
}
