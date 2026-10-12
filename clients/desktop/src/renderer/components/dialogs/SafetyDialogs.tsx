/**
 * MARK: wave4 w4-safety — audit daily-11: the reject shortcut (⌘⇧R / Ctrl+Shift+R, next to the reload / refresh key) asks
 * first, in one line on what happens to the file — the Mac's Review → Reject alert (RejectConfirm.swift, same keys).
 * The other Reject buttons stay one click (they name the file on screen).
 */
import { t } from "../../i18n";
import { useStore } from "../../store";
import { rejectConfirmMessage } from "../../workSafety";
import { ConfirmDialog } from "./ConfirmDialog";

export function RejectOneDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const file = useStore((s) => s.state.changedFiles.find((f) => f.path === path && f.state === "pending"));
  const reject = useStore((s) => s.reject);
  if (!file) return null;
  return (
    <ConfirmDialog
      title={t("Reject this file?")}
      message={rejectConfirmMessage(file)}
      confirmLabel={t("Reject")}
      danger
      onCancel={onClose}
      onConfirm={() => {
        // Close first: a §19.1 / §31.2 follow-up confirm opens in the same dialog slot.
        onClose();
        reject(path);
      }}
      testId="Reject file dialog"
    />
  );
}
