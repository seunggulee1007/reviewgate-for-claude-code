/**
 * "This folder is not a git repository" (the Mac app's `gitInitSheet`): the candidate repositories
 * inside the folder (click → open that one), Track without git (§59, recommended: a hidden repository outside the folder;
 * asks first when the engine says `folder_unsafe`), Initialize git here (extra confirm when `looksUnsafe`),
 * Choose another folder…, Cancel. Driven by `state.gitInit`.
 */
import { useState } from "react";
import type { GitInitState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { trackWithoutGitHelp } from "../../noGit";
import { lastComponent, useStore } from "../../store";
import { Modal } from "../Menu";
import { displayPath } from "../Sidebar";
import { ConfirmDialog } from "./ConfirmDialog";
import "./dialogs.css";

/** Which screen: the choices, or the confirm before initializing / tracking a folder that looks large or personal. */
export type GitInitStep = "choose" | "confirmInit" | "confirmTrack";

export function GitInitDialog() {
  const gitInit = useStore((s) => s.state.gitInit);
  const initRepository = useStore((s) => s.initRepository);
  const trackWithoutGit = useStore((s) => s.trackWithoutGit);
  const cancelGitInit = useStore((s) => s.cancelGitInit);
  const openProject = useStore((s) => s.openProject);
  const chooseAndOpen = useStore((s) => s.chooseAndOpen);
  const [step, setStep] = useState<GitInitStep>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!gitInit) return null;

  const init = () => {
    setStep("choose");
    setError(null);
    setBusy(true);
    void initRepository().finally(() => setBusy(false));
  };
  // §59: the engine decides whether the folder needs a confirm (`folder_unsafe`); the answer is sent again with it.
  const track = (confirm: boolean) => {
    setStep("choose");
    setError(null);
    setBusy(true);
    void trackWithoutGit(confirm)
      .then((o) => {
        if (o.kind === "confirm") setStep("confirmTrack");
        else if (o.kind === "failed") setError(o.text);
      })
      .finally(() => setBusy(false));
  };

  return (
    <GitInitView
      gitInit={gitInit}
      step={step}
      busy={busy}
      error={error}
      onTrack={track}
      onInit={(confirmed) => (gitInit.looksUnsafe && !confirmed ? setStep("confirmInit") : init())}
      onBack={() => setStep("choose")}
      onOpenCandidate={(p) => void openProject(p)}
      onChooseAnother={() => {
        cancelGitInit();
        void chooseAndOpen("open");
      }}
      onCancel={cancelGitInit}
    />
  );
}

/** The dialog's screens (stateless, so a test can render each one). */
export function GitInitView(props: {
  gitInit: GitInitState;
  step: GitInitStep;
  busy: boolean;
  error: string | null;
  onTrack: (confirm: boolean) => void;
  onInit: (confirmed: boolean) => void;
  onBack: () => void;
  onOpenCandidate: (path: string) => void;
  onChooseAnother: () => void;
  onCancel: () => void;
}) {
  const { gitInit, busy } = props;
  const where = displayPath(gitInit.path);

  if (props.step === "confirmInit") {
    return (
      <ConfirmDialog
        title={t("Initialize git in this folder?")}
        message={t("This looks like a large or personal folder ({0}). Initializing git here is probably a mistake.", where)}
        confirmLabel={t("Initialize anyway")}
        danger
        onConfirm={() => props.onInit(true)}
        onCancel={props.onBack}
        testId="Confirm unsafe init"
      />
    );
  }
  if (props.step === "confirmTrack") {
    return (
      <ConfirmDialog
        title={t("Track this folder without git?")}
        message={t("This looks like a large or personal folder ({0}). ReviewGate would keep a hidden copy of everything in it.", where)}
        confirmLabel={t("Track anyway")}
        onConfirm={() => props.onTrack(true)}
        onCancel={props.onBack}
        testId="Confirm unsafe track"
      />
    );
  }

  return (
    <Modal title={`⚠ ${t("This folder is not a git repository")}`} onClose={busy ? undefined : props.onCancel} testId="Git init dialog">
      <div className="path" title={where}>{where}</div>
      {gitInit.candidates.length > 0 && (
        <>
          <div className="bold">{t("Git repositories inside this folder:")}</div>
          <ul className="candidates" data-testid="Git candidates">
            {gitInit.candidates.map((p) => (
              <li key={p} title={displayPath(p)} onClick={() => props.onOpenCandidate(p)} data-testid={`Git candidate ${lastComponent(p)}`}>
                <span>▣</span>
                <span className="truncate">{lastComponent(p)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="primary" disabled={busy} onClick={() => props.onTrack(false)} title={trackWithoutGitHelp()} data-testid="Track without git">
            {t("Track without git")}
          </button>
          <span className="pill green">{t("Recommended")}</span>
        </div>
        <div className="caption muted" data-testid="Track without git help">{trackWithoutGitHelp()}</div>
      </div>
      {props.error && <div className="hint error" role="alert" data-testid="Track without git error">{props.error}</div>}
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => props.onInit(false)}
          title={t("Creates a .git folder here — commit, branches, workbenches and PRs work as in any repository")}
          data-testid="Initialize git"
        >
          {t("Initialize git here")}
        </button>
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={props.onChooseAnother} data-testid="Choose another folder">
          {t("Choose another folder…")}
        </button>
        <button type="button" disabled={busy} onClick={props.onCancel} data-testid="Cancel">{t("Cancel")}</button>
      </div>
    </Modal>
  );
}
