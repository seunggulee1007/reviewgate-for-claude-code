/**
 * "This folder is not a git repository" (the Mac app's `gitInitSheet`): the candidate repositories
 * inside the folder (click → open that one), Initialize git here (extra confirm when `looksUnsafe`),
 * Choose another folder…, Cancel. Driven by `state.gitInit`.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { lastComponent, useStore } from "../../store";
import { Modal } from "../Menu";
import { displayPath } from "../Sidebar";
import { ConfirmDialog } from "./ConfirmDialog";
import "./dialogs.css";

export function GitInitDialog() {
  const gitInit = useStore((s) => s.state.gitInit);
  const initRepository = useStore((s) => s.initRepository);
  const cancelGitInit = useStore((s) => s.cancelGitInit);
  const openProject = useStore((s) => s.openProject);
  const chooseAndOpen = useStore((s) => s.chooseAndOpen);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!gitInit) return null;

  const init = () => {
    setConfirmUnsafe(false);
    setBusy(true);
    void initRepository().finally(() => setBusy(false));
  };

  if (confirmUnsafe) {
    return (
      <ConfirmDialog
        title={t("Initialize git in this folder?")}
        message={t("This looks like a large or personal folder ({0}). Initializing git here is probably a mistake.", displayPath(gitInit.path))}
        confirmLabel={t("Initialize anyway")}
        danger
        onConfirm={init}
        onCancel={() => setConfirmUnsafe(false)}
        testId="Confirm unsafe init"
      />
    );
  }

  return (
    <Modal title={`⚠ ${t("This folder is not a git repository")}`} onClose={busy ? undefined : cancelGitInit} testId="Git init dialog">
      <div className="path" title={displayPath(gitInit.path)}>{displayPath(gitInit.path)}</div>
      <div className="message">{t("ReviewGate uses git snapshots to show and revert each turn's changes, so it needs a repository to work in.")}</div>
      {gitInit.candidates.length > 0 && (
        <>
          <div className="bold">{t("Git repositories inside this folder:")}</div>
          <ul className="candidates" data-testid="Git candidates">
            {gitInit.candidates.map((p) => (
              <li key={p} title={displayPath(p)} onClick={() => void openProject(p)} data-testid={`Git candidate ${lastComponent(p)}`}>
                <span>▣</span>
                <span className="truncate">{lastComponent(p)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button type="button" className="danger" disabled={busy} onClick={() => (gitInit.looksUnsafe ? setConfirmUnsafe(true) : init())} data-testid="Initialize git">
          {t("Initialize git here")}
        </button>
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            cancelGitInit();
            void chooseAndOpen("open");
          }}
          data-testid="Choose another folder"
        >
          {t("Choose another folder…")}
        </button>
        <button type="button" disabled={busy} onClick={cancelGitInit} data-testid="Cancel">{t("Cancel")}</button>
      </div>
    </Modal>
  );
}
