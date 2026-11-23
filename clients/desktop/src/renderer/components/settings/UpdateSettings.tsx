/**
 * §48 Windows: Settings › General › Updates (the Mac's `UpdateSettingsSection`) — automatic checks (default on), the install
 * under way or why it failed as the banner says it (with its bar), [Install and Restart] / [Cancel] / [Restart Now],
 * [Check Now] with the last result, and the download page.
 */
import type { AppSettings, UpdateStatus } from "../../../shared/ipc";
import { t } from "../../i18n";
import { downloadPageHelp, installDetail, installHelp, installTitle } from "../../updateWords";
import { updateActions, UpdateProgress, useUpdateStatus, type UpdateActions } from "../UpdateBanner";

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The status part (props only — tested with react-dom/server). */
export function UpdateSettingsView({ status, actions, checkNow }: { status: UpdateStatus; actions: UpdateActions; checkNow: () => void }) {
  const { install, release } = status;
  const busy = install !== null && install.kind !== "failed";
  return (
    <>
      <div className="field-row" data-testid="Update install status">
        {install ? (
          <>
            <UpdateProgress install={install} />
            <span className="grow" title={installDetail(install)}>
              <strong>{installTitle(install)}</strong> · {installDetail(install)}
            </span>
          </>
        ) : (
          <span className="grow">{release ? t("ReviewGate {0} is available", release.version) : t("This is ReviewGate {0}.", status.current)}</span>
        )}
      </div>
      <div className="field-row">
        {release && !busy && (
          <button type="button" className="small primary" onClick={actions.install} disabled={release.why !== null} title={installHelp(release.why)} data-testid="Settings install update">
            {install?.kind === "failed" ? t("Try Again") : t("Install and Restart")}
          </button>
        )}
        {install?.kind === "waiting" && (
          <button type="button" className="small primary" onClick={actions.restartNow} title={t("The turns that run are stopped.")} data-testid="Settings restart now for update">
            {t("Restart Now")}
          </button>
        )}
        {(install?.kind === "downloading" || install?.kind === "verifying" || install?.kind === "waiting") && (
          <button type="button" className="small" onClick={actions.cancel} title={t("Stops the update — the download is removed")} data-testid="Settings cancel update">
            {t("Cancel")}
          </button>
        )}
        <button type="button" className="small" onClick={checkNow} disabled={status.checking || busy} title={busy ? t("The update is being installed — the banner at the top of the window shows its progress.") : t("Asks GitHub for the latest release now")} data-testid="Check for updates now">
          {t("Check Now")}
        </button>
        <button type="button" className="small" onClick={actions.openPage} title={downloadPageHelp()} data-testid="Settings open release page">
          {t("Download Page")}
        </button>
        {status.checking ? (
          <span className="note" role="status">
            <span className="spinner" aria-hidden="true" /> {t("Checking for updates…")}
          </span>
        ) : (
          status.lastCheck && (
            <span className="note" role="status" title={status.lastCheck.text} data-testid="Last update check">
              {t("Last checked {0} — {1}", time(status.lastCheck.at), status.lastCheck.text)}
            </span>
          )
        )}
      </div>
    </>
  );
}

export function UpdateSettingsSection({ settings, patch }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const status = useUpdateStatus();
  return (
    <section data-testid="Updates settings" data-setting="autoCheckUpdates">
      <h4>{t("Updates")}</h4>
      <label className="check">
        <input type="checkbox" checked={settings.autoCheckUpdates !== false} onChange={(e) => patch({ autoCheckUpdates: e.target.checked })} data-testid="Check for updates automatically" />
        {t("Check for updates automatically")}
      </label>
      <div className="note">{t("At launch and every 6 hours ReviewGate asks GitHub for the latest release. Nothing is installed until you click Install and Restart.")}</div>
      {status && <UpdateSettingsView status={status} actions={updateActions(() => void window.rg.openUpdate?.())} checkNow={() => void window.rg.checkUpdatesNow?.()} />}
    </section>
  );
}
