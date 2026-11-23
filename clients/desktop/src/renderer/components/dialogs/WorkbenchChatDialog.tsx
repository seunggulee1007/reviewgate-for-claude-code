/**
 * docs/PROTOCOL.md §9 "New Chat in a Workbench" (워크벤치에서 새 대화), as on the Mac (App UI/Sidebar/WorkbenchChatSheet.swift):
 * the way out of a new chat that waits for Claude. One field — the branch, `wb/<yyMMdd-HHmm>` until edited — and [만들기]
 * (Enter): `workbench_create` from this worktree's HEAD with the repository's usual setup (§36.12), then its window opens
 * with a fresh chat of the default kind (a chat when a held message comes along: it waits in that composer, never sent).
 * The held switch here is called off.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { branchNameHint, useStore } from "../../store";
import { Modal } from "../Menu";
import { WorkbenchProgressView } from "../flow/WorkbenchSetup";
import { isEnter } from "../../ime";
import { usePendingSwitch } from "../../pendingSwitch";
import { heldForWorkbench, workbenchChatBranchFor } from "../../workbenchChat";
import "./dialogs.css";

export function WorkbenchChatDialog({ onClose }: { onClose: () => void }) {
  const state = useStore((s) => s.state);
  const flow = useStore((s) => s.flow);
  const createWith = useStore((s) => s.createWorkbenchWith);
  const held = usePendingSwitch((s) => heldForWorkbench(s.pending));
  const runningCreate = flow.create?.running ? flow.create : null;
  const [branch, setBranch] = useState(() => runningCreate?.branch ?? workbenchChatBranchFor(state));
  /** The create this dialog started (its steps and refusal stay on screen). */
  const [startedHere, setStartedHere] = useState(false);
  const creating = runningCreate !== null;
  const hint = branchNameHint(branch, state.branches.list);
  const create = flow.create;
  const error = startedHere && create && !create.running ? create.error : null;
  const inUsePath = startedHere && create && !create.running ? create.inUsePath : null;

  const start = () => {
    if (hint !== null || creating) return;
    setStartedHere(true);
    void createWith({ branch: branch.trim(), handHeldSwitch: true });
  };

  return (
    <Modal title={t("New Chat in a Workbench")} onClose={onClose} testId="Workbench chat dialog">
      <div className="muted">
        {t("Claude works in one folder one turn at a time. A workbench is a folder of its own — a new branch from HEAD, its own window and Claude — so its chat starts now.")}
      </div>
      <label className="field">
        <span>{t("Branch name")}</span>
        <input
          type="text"
          className="mono"
          autoFocus
          value={branch}
          disabled={creating}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e)) {
              e.preventDefault();
              start();
            }
          }}
          data-testid="Workbench chat branch"
        />
      </label>
      {creating && create && create.progress.length > 0 && <WorkbenchProgressView progress={create.progress} running={creating} />}
      {error ? (
        <div className="col" style={{ gap: 6, alignItems: "flex-start" }}>
          <div className="hint error" data-testid="Workbench chat error">{error}</div>
          {inUsePath && (
            <button
              type="button"
              className="small"
              onClick={() => {
                onClose();
                void window.rg.openWorkbenchWindow(inUsePath);
              }}
              data-testid="Workbench chat open existing"
            >
              {t("Open that workbench")}
            </button>
          )}
        </div>
      ) : hint && !creating ? (
        <div className="hint" data-testid="Workbench chat hint">{hint}</div>
      ) : held ? (
        <div className="hint" data-testid="Workbench chat held message">{t("Your waiting message moves to the new chat's message box there — it is not sent.")}</div>
      ) : (
        <div className="hint">{t("Branches from HEAD into a new worktree and opens it in its own window with a new chat.")}</div>
      )}
      <div className="actions">
        {creating && <span className="spinner" />}
        <span className="spacer" />
        {/* A create cannot be stopped: closing the dialog leaves it running, and its window opens when it is ready. */}
        <button type="button" onClick={onClose} title={creating ? t("The workbench is still being prepared; its window opens when it is ready") : undefined} data-testid="Workbench chat close">
          {creating ? t("Close") : t("Cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={hint !== null || creating}
          title={hint ?? (creating ? t("The workbench is being created") : undefined)}
          onClick={start}
          data-testid="Workbench chat create"
        >
          {t("Create")}
        </button>
      </div>
    </Modal>
  );
}
