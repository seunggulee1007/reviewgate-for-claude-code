/**
 * The last 500 engine `log` events, so IPC problems are diagnosable without a terminal.
 * MARK: r2-review-flow — M27 / polish P4-composer-39: no longer an "Engine log (N)" line under every composer (at 637 px it
 * took a line of the conversation): it opens from the error banner's "Show log" or Help › Show Engine Log, with Copy log
 * ("복사됨"), the log folder and × to put it away again.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { t } from "../../i18n";
import { registerMenuAction } from "../../menuActions";
import { useStore } from "../../store";
import { CopyButton } from "../common/CopyButton";

/** Whether the engine log is shown in this window (its own tiny store: nothing of the project's state). */
export const useEngineLog = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

export function SidecarLog() {
  const logs = useStore((s) => s.logs);
  const open = useEngineLog((s) => s.open);
  const hide = useEngineLog((s) => s.hide);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => registerMenuAction("show_engine_log", () => useEngineLog.getState().show()), []);
  useEffect(() => {
    const el = boxRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, logs.length]);
  if (!open) return null;
  return (
    <div className="sidecar-log" style={{ padding: "0 12px 8px" }} data-testid="Sidecar log">
      <div className="row" style={{ gap: 6 }}>
        <span className="caption muted grow">{t("Engine log ({0})", logs.length)}</span>
        <CopyButton text={logs.join("\n")} iconOnly title={t("Copy the engine log")} toast={t("Copied")} />
        <button type="button" className="plain small" onClick={() => void window.rg.openLog()} title={t("Open the log folder")} data-testid="Open log folder from composer">
          {t("Open Log Folder")}
        </button>
        <button type="button" className="plain small" onClick={hide} aria-label={t("Hide the engine log")}
          title={t("Hide the engine log — the error banner's Show log or Help › Show Engine Log brings it back")} data-testid="Hide sidecar log">
          ×
        </button>
      </div>
      <div className="logbox" ref={boxRef}>
        {logs.length === 0 ? t("(no engine log yet)") : logs.join("\n")}
      </div>
    </div>
  );
}
