/**
 * "This workbench is already open" (the Mac app's lock alert): another session holds the worktree's
 * `reviewgate.lock` — show pid / since / client and offer Take over (`open_project{takeover:true}`).
 */
import { useState } from "react";
import { formatDate, t } from "../../i18n";
import { useStore } from "../../store";
import { displayPath } from "../Sidebar";
import { ConfirmDialog } from "./ConfirmDialog";

export function LockConflictDialog() {
  const lock = useStore((s) => s.state.lockConflict);
  const lockedPath = useStore((s) => s.lockedProjectPath);
  const refusedPid = useStore((s) => s.refusedLockPid);
  const takeOver = useStore((s) => s.takeOver);
  const cancelTakeover = useStore((s) => s.cancelTakeover);
  const [busy, setBusy] = useState(false);
  const path = lock?.path ?? lockedPath ?? "";
  const pid = lock?.pid ?? refusedPid ?? 0;
  return (
    <ConfirmDialog
      title={t("This workbench is already open")}
      message={
        <div className="col" style={{ gap: 6 }}>
          <div>{t("This workbench is already open in another window or session (pid {0}, since {1}). Take over?", pid, lock ? formatDate(lock.since) : "?")}</div>
          <div className="caption muted">
            {path && <div className="path" title={displayPath(path)}>{displayPath(path)}</div>}
            {lock?.client && <div>{t("Client: {0}", lock.client)}</div>}
          </div>
        </div>
      }
      confirmLabel={t("Take over")}
      busy={busy}
      onConfirm={() => {
        setBusy(true);
        void takeOver().finally(() => setBusy(false));
      }}
      onCancel={cancelTakeover}
      testId="Lock conflict dialog"
    />
  );
}
