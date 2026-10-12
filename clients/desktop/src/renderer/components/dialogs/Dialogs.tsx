/**
 * Renders whichever `store.dialog` is set (the Mac app's sheets / alerts): git init, lock takeover,
 * new workbench / branch, create PR, settings, switch project, reject all, the §19.1 "revert your own edits?"
 * confirm, accept all, remove
 * workbench, submit review, commit, chat history. `App.tsx` mounts `<Dialogs />` once.
 */
import { useState } from "react";
import type { WorkbenchInfo } from "@reviewgate/engine";
import { t } from "../../i18n";
import { refusalText, useStore } from "../../store";
import { Modal } from "../Menu";
import { displayPath } from "../Sidebar";
import { SubmitReviewDialog } from "../pr/SubmitReviewDialog";
import { SettingsPanel } from "../settings/SettingsPanel";
import { AcceptAllDialog } from "./AcceptAllDialog";
import { CommitDialog } from "./CommitDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreatePRDialog } from "./CreatePRDialog";
import { GitInitDialog } from "./GitInitDialog";
import { HistoryDialog } from "./HistoryDialog";
import { ExtensionsDialog } from "../extensions/ExtensionsDialog";
import { LockConflictDialog } from "./LockConflictDialog";
import { CompactDialog, RewindDialog } from "./RewindDialog";
import { NewBranchDialog, NewWorkbenchDialog } from "./NewWorkbenchDialog";
// MARK: wave1 desktop-review
import { planRejectAll } from "../../reviewGate";
import { FinishReviewDialog, RejectExternalDialog, StaleReviewDialog } from "./ReviewGateDialogs";
// MARK: wave3 desktop-agents — §36.1 the agent details sheet
import { AgentDetailSheet } from "../agents/AgentDetailSheet";
import { RejectOneDialog } from "./SafetyDialogs"; // MARK: wave4 w4-safety
import { ShortcutsDialog } from "./ShortcutsDialog"; // MARK: wave4d w4d-windows
import "./dialogs.css";

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const openDialog = useStore((s) => s.openDialog);
  const close = () => openDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "gitInit":
      return <GitInitDialog />;
    case "lockConflict":
      return <LockConflictDialog />;
    case "newWorkbench":
      return <NewWorkbenchDialog onClose={close} branch={dialog.branch} planMode={dialog.planMode} />; // MARK: wave4d w4d-plan
    // MARK: wave3 desktop-flow — §36.14 "Open as workbench" from the PR tab: the New Workbench sheet on the PR's head
    case "newWorkbenchFromPr":
      return <NewWorkbenchDialog onClose={close} fromPr={dialog.pr} />;
    case "newBranch":
      return <NewBranchDialog onClose={close} />;
    case "createPR":
      return <CreatePRDialog onClose={close} />;
    case "submitReview":
      return <SubmitReviewDialog onClose={close} />;
    case "commit":
      return <CommitDialog onClose={close} />;
    case "history":
      return <HistoryDialog onClose={close} highlight={dialog.highlight} />;
    case "extensions":
      return <ExtensionsDialog onClose={close} />;
    case "settings":
      return (
        <Modal title={t("Settings")} onClose={close} wide testId="Settings dialog">
          <SettingsPanel initialTab={dialog.tab} />
          <div className="actions">
            <button type="button" className="primary" onClick={close} data-testid="Close settings">{t("Done")}</button>
          </div>
        </Modal>
      );
    case "switchProject":
      return <SwitchProjectDialog path={dialog.path} onClose={close} />;
    case "rejectAll":
      return <RejectAllDialog onClose={close} />;
    case "forceReject":
      return <ForceRejectDialog paths={dialog.paths} all={dialog.all} />;
    // MARK: wave1 desktop-review
    case "rejectExternal":
      return <RejectExternalDialog paths={dialog.paths} all={dialog.all} />;
    case "staleReview":
      return <StaleReviewDialog onClose={close} />;
    case "finishReview":
      return <FinishReviewDialog onClose={close} />;
    case "acceptAll":
      return <AcceptAllDialog onClose={close} />;
    case "removeWorkbench":
      return <RemoveWorkbenchDialog wb={dialog.wb} refusal={dialog.refusal} onClose={close} />;
    case "rewind":
      return <RewindDialog turn={dialog.turn} onClose={close} />;
    case "compact":
      return <CompactDialog onClose={close} />;
    // MARK: wave3 desktop-agents — §36.1
    case "agentDetail":
      return <AgentDetailSheet key={dialog.toolUseId} toolUseId={dialog.toolUseId} focus={dialog.focus} onClose={close} />;
    // MARK: wave4 w4-safety — daily-11
    case "rejectOne":
      return <RejectOneDialog path={dialog.path} onClose={close} />;
    // MARK: wave4d w4d-windows — polish-08
    case "shortcuts":
      return <ShortcutsDialog onClose={close} />;
  }
}

function SwitchProjectDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const pending = useStore((s) => s.state.changedFiles.filter((f) => f.state === "pending" || f.state === "changesRequested").length);
  const switchProject = useStore((s) => s.switchProject);
  return (
    <ConfirmDialog
      title={t("Switch project?")}
      message={
        <>
          <div>{t("{0} files pending review. The review is saved and comes back when you open this project again; the files stay on disk as they are.", pending)}</div>
          <div className="path" title={displayPath(path)}>{displayPath(path)}</div>
        </>
      }
      confirmLabel={t("Switch")}
      onConfirm={() => {
        onClose();
        void switchProject(path);
      }}
      onCancel={onClose}
      testId="Switch project dialog"
    />
  );
}

/**
 * §31.2 (M3): "Reject all" reverts Claude's changes only — the files changed outside the app stay unless the user picks
 * "앱 밖 변경도 되돌리기" (then a second confirm lists them). Files whose content was not captured (§32) stay either way.
 */
function RejectAllDialog({ onClose }: { onClose: () => void }) {
  const files = useStore((s) => s.state.changedFiles);
  const rejectAll = useStore((s) => s.rejectAll);
  const plan = planRejectAll(files, false);
  const claude = plan.revert.length;
  const outside = plan.keptExternal.length;
  // Close first: the second confirm (outside changes) opens in the same dialog slot.
  const go = (includeExternal: boolean) => {
    onClose();
    rejectAll(includeExternal);
  };
  return (
    <Modal title={t("Reject all pending files?")} onClose={onClose} testId="Reject all dialog">
      <div className="message col" style={{ gap: 6 }}>
        <div data-testid="Reject all summary">
          {outside === 0
            ? t("{0} file(s) will be reverted on disk to their state at the start of the turn.", claude)
            : claude > 0
              ? t("Claude's {0} change(s) will be reverted. The {1} outside change(s) stay as they are.", claude, outside)
              : t("There is no change of Claude's to revert — only {0} outside change(s) are pending.", outside)}
        </div>
        {plan.uncaptured.length > 0 && (
          <div className="caption orange" title={plan.uncaptured.map((f) => f.path).join("\n")} data-testid="Reject all uncaptured">
            {t("{0} file(s) whose content was not captured cannot be reverted and stay as they are.", plan.uncaptured.length)}
          </div>
        )}
      </div>
      <div className="actions">
        <span className="spacer" />
        <button type="button" onClick={onClose} data-testid="Cancel">{t("Cancel")}</button>
        {outside > 0 && (
          <button type="button" className="danger" onClick={() => go(true)} title={t("Asks once more with the list of those files")} data-testid="Reject outside too">
            {t("Revert outside changes too")}
          </button>
        )}
        <button type="button" className="danger" autoFocus={claude > 0} disabled={claude === 0} onClick={() => go(false)} data-testid={t("Reject all")}>
          {t("Reject all")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * §19.1: the reject was refused because the user edited these files after the review. Revert anyway re-sends it
 * with `force: true`; Cancel (or Esc) keeps the edits and reverts nothing.
 */
function ForceRejectDialog({ paths, all }: { paths: string[]; all: boolean }) {
  const answer = useStore((s) => s.answerForceReject);
  return (
    <ConfirmDialog
      title={t("Your own edits will be lost — revert anyway?")}
      message={
        <div className="col" style={{ gap: 8, alignItems: "stretch" }}>
          <div>{t("You edited these files after the review. Reverting puts them back to the start of the turn and discards those edits:")}</div>
          <ul className="list accept-all-list" data-testid="Force reject files">
            {paths.map((p) => (
              <li key={p} className="mono" data-testid={`Force reject row ${p}`}>{p}</li>
            ))}
          </ul>
          {all && <div className="caption muted">{t("Nothing has been reverted yet — Cancel keeps every file as it is.")}</div>}
        </div>
      }
      confirmLabel={t("Revert anyway")}
      cancelLabel={t("Keep my edits")}
      danger
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
      testId="Force reject dialog"
    />
  );
}

/**
 * "Remove workbench?" → `workbench_remove`; a refusal (dirty / locked) reopens this dialog with
 * `refusal` set and offers Force remove. Our own window on that worktree is closed first so its
 * lock is released (`window.rg.closeProjectInWindow`).
 */
function RemoveWorkbenchDialog({ wb, refusal, onClose }: { wb: WorkbenchInfo; refusal: string | null; onClose: () => void }) {
  const removeWorkbench = useStore((s) => s.removeWorkbench);
  const refreshWorkbenches = useStore((s) => s.refreshWorkbenches);
  const openDialog = useStore((s) => s.openDialog);
  const [busy, setBusy] = useState(false);

  const remove = async (force: boolean) => {
    setBusy(true);
    await window.rg.closeProjectInWindow(wb.path);
    const result = await removeWorkbench(wb.path, force);
    setBusy(false);
    if (result !== null && !force) {
      openDialog({ kind: "removeWorkbench", wb, refusal: result });
      return;
    }
    onClose();
    await refreshWorkbenches();
  };

  if (refusal !== null) {
    return (
      <ConfirmDialog
        title={t("Could not remove workbench")}
        message={`${refusalText(refusal)}\n\n${t("Force removal discards uncommitted changes and ignores another session's lock.")}`}
        confirmLabel={t("Force remove")}
        danger
        busy={busy}
        onConfirm={() => void remove(true)}
        onCancel={onClose}
        testId="Force remove workbench dialog"
      />
    );
  }
  return (
    <ConfirmDialog
      title={t("Remove workbench?")}
      message={t("Deletes the worktree folder {0}. The branch {1} is kept.", displayPath(wb.path), wb.branch ?? "")}
      confirmLabel={t("Remove")}
      danger
      busy={busy}
      onConfirm={() => void remove(false)}
      onCancel={onClose}
      testId="Remove workbench dialog"
    />
  );
}
