/**
 * MARK: r2-review-flow — M28: "Accept all" (the Changes list's button, ⌥⌘⇧A / Ctrl+Alt+Shift+A) applies at once with an undo
 * toast — the summary dialog opens only when a pending file was never looked at, changed since, or is sensitive. Accepting
 * writes nothing on disk, so the toast's 실행 취소 (`unaccept`) puts the files back to pending — also while a turn runs on
 * the review (the engine takes it then, §34.2).
 */
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { acceptAllNeedsDialog, acceptedToast } from "./acceptCommit";
import { acceptBlockedReason, viewStateOf } from "./reviewRound";
import { isSensitivePath } from "./sensitive";
import { pendingFiles, useStore } from "./store";
import { showToast } from "./toast";

/** The list's button and the key: the dialog when a file needs a look, else at once. */
export function runAcceptAll(): void {
  const s = useStore.getState();
  const pending = pendingFiles(s.state);
  if (pending.length === 0) return;
  const views = pending.map((f) => viewStateOf(f, s.viewedPaths));
  const needs = acceptAllNeedsDialog({
    unviewed: views.filter((v) => v === "unviewed").length,
    changedSinceViewed: views.filter((v) => v === "changed").length,
    sensitive: pending.filter((f) => isSensitivePath(f.path)).length,
  });
  if (needs) s.openDialog({ kind: "acceptAll" });
  else acceptAllNow();
}

/** Accepts every pending file and offers the undo (nothing when accepting waits — the store says why, as before). */
export function acceptAllNow(): void {
  const s = useStore.getState();
  const paths = pendingFiles(s.state).map((f) => f.path);
  if (paths.length === 0 || acceptBlockedReason(s.state) !== null) {
    s.acceptAll();
    return;
  }
  s.acceptAll();
  showToast(acceptedToast(paths.length), { action: { label: t("Undo"), run: () => void undoAccept(paths) } });
}

/** The toast's 실행 취소: the files of that accept that are still accepted are pending again. */
async function undoAccept(paths: readonly string[]): Promise<void> {
  const accepted = new Set(useStore.getState().state.changedFiles.filter((f) => f.state === "accepted").map((f) => f.path));
  const targets = paths.filter((p) => accepted.has(p));
  if (targets.length === 0) return;
  try {
    await engineRequest({ type: "unaccept", paths: targets });
  } catch (e) {
    showToast(refusalMessage(refusalOf(e)));
  }
}
