/**
 * docs/PROTOCOL.md §69.4 on Windows (the Mac's `NewProjectSheet`): 1 New with no project open. What the user wants to make
 * (the first prompt), the folder name it gives (`project_name` 0.3 s after typing stops, until edited) and where it goes;
 * Create makes the folder, `git init`s and opens it (`project_create`) with no start screen, and puts the words where the new
 * chat takes text — never sent (as §63.3 hands a task's first prompt).
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectNameEvent } from "@reviewgate/engine";
import { t, usesMacKeys } from "../../i18n";
import { isEnter } from "../../ime";
import { previewProjectName } from "../../newProject";
import { useStartScreen } from "../../startScreen";
import { useStore } from "../../store";
import { deliverFirstPrompt } from "../../taskStartFlow";
import { Modal } from "../Menu";
import "../dialogs/dialogs.css";
import "./start.css";

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const parent = useStore((s) => s.settings?.newProjectParent);
  const createProject = useStore((s) => s.createProject);
  const openDialog = useStore((s) => s.openDialog);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [nameTyped, setNameTyped] = useState(false);
  const [preview, setPreview] = useState<ProjectNameEvent | null>(null);
  /** Why the engine gives no name (too old, the parent setting refused): on the path line and as Create's reason. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // The name follows the prompt until edited; the engine says what it becomes and where.
  const source = nameTyped ? name : prompt;
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void previewProjectName(source, parent).then((reply) => {
        if (mine !== seq.current) return;
        if ("unavailable" in reply) {
          setPreview(null);
          setUnavailable(reply.unavailable);
          return;
        }
        setPreview(reply);
        setUnavailable(null);
        if (!nameTyped) setName(reply.name);
      });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, parent, nameTyped]);

  const blocker = !prompt.trim() ? t("Say what you want to make first") : unavailable ?? (preview === null ? t("Working out the folder name…") : null);

  const create = async () => {
    if (blocker !== null || creating || !preview) return;
    setCreating(true);
    setError(null);
    useStartScreen.setState({ suppressNext: true }); // §69.4: the new project opens into its chat, the prompt waiting there
    const result = await createProject(nameTyped ? name : preview.name, parent, preview.path);
    setCreating(false);
    if ("error" in result) {
      useStartScreen.setState({ suppressNext: false });
      setError(result.error);
      return;
    }
    onClose();
    deliverFirstPrompt(prompt.trim());
  };

  const createHelp = usesMacKeys()
    ? t("Makes the folder, opens it and puts your words into the message box; nothing is sent until you press Return")
    : t("Makes the folder, opens it and puts your words into the message box; nothing is sent until you press Enter");

  return (
    <Modal title={t("New project")} onClose={creating ? undefined : onClose} wide testId="New project dialog" dismissOnBackdrop={false}>
      <div className="col task-start" style={{ gap: 10 }}>
        <div className="caption muted">{t("ReviewGate makes the folder and a git repository; your words go into the message box.")}</div>
        <label className="field">
          <span>{t("What do you want to make?")}</span>
          <textarea className="task-prompt" autoFocus value={prompt} disabled={creating} onChange={(e) => setPrompt(e.target.value)} data-testid="New project prompt" />
        </label>
        <label className="field">
          <span>{t("Folder name")}</span>
          <input
            type="text"
            className="mono"
            value={name}
            disabled={creating}
            title={t("Follows what you type above until you edit it; a name already taken gets -2, -3")}
            onChange={(e) => {
              setName(e.target.value);
              setNameTyped(true);
            }}
            onKeyDown={(e) => {
              // Enter in the name creates, as Return does on the Mac (the prompt above keeps Enter for its new lines).
              if (isEnter(e)) {
                e.preventDefault();
                void create();
              }
            }}
            data-testid="New project name"
          />
        </label>
        <div className="row" style={{ gap: 8 }}>
          <span className={unavailable ? "caption orange grow" : "caption muted truncate grow"} title={unavailable ?? preview?.path ?? ""} role={unavailable ? "alert" : undefined} data-testid="New project path">
            {unavailable ?? (preview ? t("Creates {0}", preview.path) : t("Working out the folder name…"))}
          </span>
          <button
            type="button"
            className="plain"
            disabled={creating}
            title={creating ? t("The project is being made") : t("Settings › General › Folder for new projects")}
            onClick={() => openDialog({ kind: "settings", highlight: "newProjectParent" })}
            data-testid="New project parent"
          >
            {t("Change…")}
          </button>
        </div>
        {error && <div className="hint error" role="alert" data-testid="New project error">{error}</div>}
      </div>
      <div className="actions">
        <span className="caption muted">{t("Goes into the message box — you send it")}</span>
        <span className="spacer" />
        {creating && <span className="spinner" />}
        <button type="button" onClick={onClose} disabled={creating} title={creating ? t("The project is being made") : undefined} data-testid="New project cancel">
          {t("Cancel")}
        </button>
        <button type="button" className="primary" disabled={creating || blocker !== null} title={blocker ?? (creating ? t("The project is being made") : createHelp)} onClick={() => void create()} data-testid="New project create">
          {t("Create and Open")}
        </button>
      </div>
    </Modal>
  );
}
