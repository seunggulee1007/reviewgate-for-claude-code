/**
 * docs/PROTOCOL.md §69.4 on Windows (the Mac's `TaskProjectSheet`): 2 Start from a task with no project open. The task first,
 * then the project it belongs to — the recent projects, the one whose remote is the task's repository preselected
 * (`project_match`; else the most recent), "Other folder…" too. Continue opens it; its start screen then shows with §63's task
 * dialog open and the task filled in (`useStartScreen.pendingTask`). Nothing is created here.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { matchProjects, preselectProject } from "../../newProject";
import { useRecentEntries } from "../../recentProjects";
import { displayPath } from "../Sidebar";
import { useStartScreen } from "../../startScreen";
import { lastComponent, useStore } from "../../store";
import { parseTaskReference } from "../../taskStart";
import { Modal } from "../Menu";
import "../dialogs/dialogs.css";
import "./start.css";

export function TaskProjectDialog({ onClose }: { onClose: () => void }) {
  const entries = useRecentEntries();
  const openProject = useStore((s) => s.openProject);
  const [refText, setRefText] = useState("");
  const [others, setOthers] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [match, setMatch] = useState<{ repo: string | null; matches: string[] }>({ repo: null, matches: [] });
  const [matching, setMatching] = useState(false);
  const seq = useRef(0);
  const candidates = [...others, ...entries.filter((e) => e.exists).map((e) => e.path).filter((p) => !others.includes(p))];
  const ref = parseTaskReference(refText);

  useEffect(() => {
    if (selected === null && candidates.length > 0) setSelected(candidates[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length]);

  // The recent projects whose remote is the task's repository; the guess (else the most recent) is preselected.
  useEffect(() => {
    const mine = ++seq.current;
    if (!ref) {
      setMatch({ repo: null, matches: [] });
      setMatching(false);
      return;
    }
    const timer = setTimeout(() => {
      setMatching(true);
      void matchProjects(refText.trim(), candidates).then((r) => {
        if (mine !== seq.current) return;
        setMatching(false);
        setMatch({ repo: r.repo, matches: r.matches });
        const pick = preselectProject(r.guess, candidates);
        if (pick) setSelected(pick);
      });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refText, candidates.length]);

  const blocker = !ref ? t("Enter a task id or link") : selected === null ? t("Choose the project the task belongs to") : null;

  const start = (path = selected) => {
    if (!ref || !path) return;
    useStartScreen.setState({ pendingTask: { path, ref: refText.trim() } });
    onClose();
    void openProject(path);
  };

  const chooseOther = async () => {
    const path = await window.rg.chooseDirectory();
    if (!path) return;
    setOthers((o) => [path, ...o.filter((p) => p !== path)]);
    setSelected(path);
  };

  const status = !ref
    ? refText.trim() ? t("No task id in this — use a key (ACME-123), a number or a link") : ""
    : matching ? t("Looking for its project…")
    : match.repo ? (match.matches.length === 0 ? t("Task {0} — no recent project has {1} as a remote", ref.id, match.repo) : t("Task {0} — {1}", ref.id, match.repo))
    : t("Task {0}", ref.id);

  return (
    <Modal title={t("Start from a task")} onClose={onClose} wide testId="Task project dialog">
      <div className="col task-start" style={{ gap: 10 }}>
        <div className="caption muted">{t("First the project the task belongs to — then its branch and first prompt, as in a project window.")}</div>
        <label className="field">
          <span>{t("Task id or link")}</span>
          <input
            type="text"
            autoFocus
            value={refText}
            placeholder="ACME-123 · #42 · https://github.com/acme/widgets/issues/42"
            onChange={(e) => setRefText(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e)) {
                e.preventDefault();
                if (blocker === null) start();
              }
            }}
            data-testid="Task project reference"
          />
        </label>
        <div className="task-status muted" role="status">{status}</div>
        <span className="bold">{t("Project")}</span>
        {candidates.length === 0 ? (
          <div className="caption muted">{t("No recent projects — choose its folder.")}</div>
        ) : (
          <div className="start-recent" role="listbox" aria-label={t("Project")} data-testid="Task project list">
            {candidates.map((p) => (
              <button
                key={p}
                type="button"
                role="option"
                aria-selected={p === selected}
                className={p === selected ? "start-recent-row marked" : "start-recent-row"}
                title={displayPath(p)}
                onClick={() => setSelected(p)}
                onDoubleClick={() => start(p)}
              >
                <span className="col grow" style={{ gap: 1, minWidth: 0, alignItems: "flex-start" }}>
                  <span className="truncate" style={{ maxWidth: "100%" }}>{lastComponent(p)}</span>
                  <span className="caption muted truncate" style={{ maxWidth: "100%" }}>{displayPath(p)}</span>
                </span>
                {match.repo && match.matches.includes(p) && <span className="caption green">{t("Matches {0}", match.repo)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="actions">
        <button type="button" className="plain" title={t("Choose the project's folder")} onClick={() => void chooseOther()} data-testid="Task project other folder">
          {t("Other Folder…")}
        </button>
        <span className="spacer" />
        <button type="button" onClick={onClose} data-testid="Task project cancel">{t("Cancel")}</button>
        <button type="button" className="primary" disabled={blocker !== null} title={blocker ?? t("Opens the project, then its task dialog with this task filled in")} onClick={() => start()} data-testid="Task project continue">
          {t("Open and Continue")}
        </button>
      </div>
    </Modal>
  );
}
