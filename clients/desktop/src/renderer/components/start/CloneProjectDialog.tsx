/**
 * docs/PROTOCOL.md §74.4 on Windows (the Mac's `CloneProjectSheet`): 4 Clone from Git with no project open. A repository link
 * (https, ssh, `owner/repo`), what it clones and where (`project_clone_preview` 0.3 s after typing stops; the folder name
 * editable) and — when a recent project already has that repository — "Open it instead", preselected, with "Clone a fresh
 * copy anyway" beside it. The clone runs with the user's own git sign-in: a bar with the step while it runs, Cancel stops it
 * and removes the folder. Once cloned the project opens and its start screen shows as after any open — from "Start from a
 * task" (`taskRef`), with the task dialog and the task filled in.
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectClonePreviewEvent } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { clonePhaseLabel, previewClone, useCloneProgress } from "../../cloneProject";
import { useRecentEntries } from "../../recentProjects";
import { useStartScreen } from "../../startScreen";
import { lastComponent, useStore } from "../../store";
import { displayPath } from "../Sidebar";
import { Modal } from "../Menu";
import "../dialogs/dialogs.css";
import "./start.css";

export function CloneProjectDialog({ onClose, initialURL = "", taskRef }: { onClose: () => void; initialURL?: string; taskRef?: string }) {
  const parent = useStore((s) => s.settings?.newProjectParent);
  const cloneProject = useStore((s) => s.cloneProject);
  const cancelClone = useStore((s) => s.cancelClone);
  const openProject = useStore((s) => s.openProject);
  const openDialog = useStore((s) => s.openDialog);
  const progress = useCloneProgress((s) => s.progress);
  const entries = useRecentEntries();
  const recent = entries.filter((e) => e.exists).map((e) => e.path);
  const [url, setUrl] = useState(initialURL);
  const [name, setName] = useState("");
  const [nameTyped, setNameTyped] = useState(false);
  const [branch, setBranch] = useState("");
  const [preview, setPreview] = useState<ProjectClonePreviewEvent | null>(null);
  /** Why the engine gives no preview (not a link, credentials in it, an engine before §74): the status line and Clone's reason. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [openInstead, setOpenInstead] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const trimmed = url.trim();
  const existing = preview?.matches[0] ?? null;
  const opensExisting = existing !== null && openInstead;

  // What the link clones and where, and which recent project already has it.
  const refresh = () => {
    const mine = ++seq.current;
    if (!trimmed) {
      setPreview(null);
      setUnavailable(null);
      setReading(false);
      return () => undefined;
    }
    const timer = setTimeout(() => {
      setReading(true);
      void previewClone(trimmed, nameTyped ? name : null, parent, recent).then((reply) => {
        if (mine !== seq.current) return;
        setReading(false);
        if ("unavailable" in reply) {
          setPreview(null);
          setUnavailable(reply.unavailable);
          return;
        }
        setPreview((old) => {
          if ((old?.matches[0] ?? null) !== (reply.matches[0] ?? null)) setOpenInstead(true);
          return reply;
        });
        setUnavailable(null);
        if (!nameTyped) setName(reply.name);
      });
    }, 300);
    return () => clearTimeout(timer);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [trimmed, nameTyped ? name : "", parent, recent.length]);

  const blocker = !trimmed ? t("Paste a repository link first") : unavailable ?? (preview === null ? t("Reading the link…") : null);

  const primary = async () => {
    if (cloning || blocker !== null || !preview) return;
    setError(null);
    if (opensExisting && existing) {
      if (taskRef) useStartScreen.setState({ pendingTask: { path: existing, ref: taskRef } });
      onClose();
      void openProject(existing);
      return;
    }
    setCloning(true);
    if (taskRef) useStartScreen.setState({ pendingTask: { path: preview.path, ref: taskRef } });
    const result = await cloneProject({ url: trimmed, ...(nameTyped && name.trim() ? { name: name.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}), parent, expected: preview.path });
    setCloning(false);
    if ("path" in result) {
      if (taskRef && result.path !== preview.path) useStartScreen.setState({ pendingTask: { path: result.path, ref: taskRef } });
      onClose();
      return;
    }
    if (taskRef) useStartScreen.setState({ pendingTask: null });
    if ("error" in result) {
      setError(result.error);
      refresh();
    }
  };

  const status = unavailable ?? (reading ? t("Reading the link…") : preview ? [preview.repo, preview.host, preview.branch ? t("branch {0}", preview.branch) : null].filter(Boolean).join(" · ") : "");

  return (
    <Modal title={t("Clone from Git")} onClose={cloning ? undefined : onClose} wide testId="Clone project dialog" dismissOnBackdrop={false}>
      <div className="col task-start" style={{ gap: 10 }}>
        <div className="caption muted">{t("git clone runs with your own sign-in (keychain, SSH key, gh), then the project opens.")}</div>
        <label className="field">
          <span>{t("Repository")}</span>
          <input
            type="text"
            className="mono"
            autoFocus
            value={url}
            disabled={cloning}
            placeholder="https://github.com/acme/widgets.git · git@github.com:acme/widgets.git · acme/widgets"
            title={t("An https or SSH link, or owner/repo for GitHub — never a password or token")}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e)) {
                e.preventDefault();
                void primary();
              }
            }}
            data-testid="Clone project url"
          />
        </label>
        <div className={unavailable ? "task-status warn" : "task-status muted"} role={unavailable ? "alert" : "status"} data-testid="Clone project status">
          {reading && !unavailable && <span className="spinner" aria-hidden="true" />}
          {status}
        </div>
        {existing && preview && !cloning && (
          <fieldset className="clone-existing" aria-label={t("You already have {0}", preview.repo)} data-testid="Clone project already have">
            <legend className="bold green">{t("You already have {0}", preview.repo)}</legend>
            <label className="row" style={{ gap: 6, alignItems: "flex-start" }} title={displayPath(existing)}>
              <input type="radio" name="clone-existing" checked={openInstead} onChange={() => setOpenInstead(true)} />
              <span className="col" style={{ gap: 1, minWidth: 0 }}>
                <span>{t("Open {0}", lastComponent(existing))}</span>
                <span className="caption muted truncate">{displayPath(existing)}</span>
              </span>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <input type="radio" name="clone-existing" checked={!openInstead} onChange={() => setOpenInstead(false)} />
              <span>{t("Clone a fresh copy anyway")}</span>
            </label>
          </fieldset>
        )}
        {!opensExisting && (
          <>
            <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
              <label className="field grow">
                <span>{t("Folder name")}</span>
                <input
                  type="text"
                  className="mono"
                  value={name}
                  disabled={cloning}
                  title={t("The repository's name until you edit it; a name already taken gets -2, -3")}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTyped(true);
                  }}
                  data-testid="Clone project name"
                />
              </label>
              <label className="field" style={{ width: 180 }}>
                <span>{t("Branch (optional)")}</span>
                <input
                  type="text"
                  className="mono"
                  value={branch}
                  disabled={cloning}
                  placeholder={preview?.branch ?? t("Default branch")}
                  title={t("Empty: the repository's default branch (or the one the link names)")}
                  onChange={(e) => setBranch(e.target.value)}
                  data-testid="Clone project branch"
                />
              </label>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className="caption muted truncate grow" title={preview?.path ?? ""} data-testid="Clone project path">
                {preview ? t("Clones into {0}", preview.path) : t("Clones into {0}", parent?.trim() || (window.rg.platform === "win32" ? "%USERPROFILE%\\ReviewGate" : "~/ReviewGate"))}
              </span>
              <button
                type="button"
                className="plain"
                disabled={cloning}
                title={cloning ? t("Cloning…") : t("Settings › General › Folder for new projects")}
                onClick={() => openDialog({ kind: "settings", highlight: "newProjectParent" })}
                data-testid="Clone project parent"
              >
                {t("Change…")}
              </button>
            </div>
          </>
        )}
        {cloning && (
          <div className="col clone-progress" style={{ gap: 4 }} data-testid="Clone project progress">
            <div className="bar" role="progressbar" aria-label={t("Clone progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.percent ?? 0}>
              <div style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <div className="row caption muted" style={{ gap: 6 }}>
              <span>{clonePhaseLabel(progress?.phase ?? "connecting")}</span>
              {progress?.detail && <span className="mono">· {progress.detail}</span>}
              <span className="spacer" />
              <span className="mono">{progress?.percent ?? 0}%</span>
            </div>
          </div>
        )}
        {error && <div className="hint error" role="alert" data-testid="Clone project error">{error}</div>}
      </div>
      <div className="actions">
        {!cloning && <span className="caption muted">{t("Uses your git sign-in — nothing is pushed")}</span>}
        <span className="spacer" />
        {cloning ? (
          <button type="button" title={t("Stops git clone and removes the folder it was cloning into")} onClick={() => void cancelClone()} data-testid="Clone project stop">
            {t("Cancel")}
          </button>
        ) : (
          <button type="button" onClick={onClose} data-testid="Clone project cancel">{t("Cancel")}</button>
        )}
        <button
          type="button"
          className="primary"
          disabled={cloning || blocker !== null}
          title={cloning ? t("Cloning…") : blocker ?? (opensExisting ? t("Opens the project you already have") : t("Clones the repository, then opens it"))}
          onClick={() => void primary()}
          data-testid="Clone project clone"
        >
          {opensExisting ? t("Open") : t("Clone and Open")}
        </button>
      </div>
    </Modal>
  );
}
