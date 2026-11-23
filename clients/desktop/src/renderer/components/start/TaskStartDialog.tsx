/**
 * MARK: task-start — docs/PROTOCOL.md §63.3 on Windows (the Mac's `TaskStartSheet`): "Start from a task". The user names the
 * task (an id or a link); a GitHub issue is read by the engine (`task_fetch`) 0.5 s after typing stops (at once for a link)
 * — its title shows, or why it could not be read, and the task then starts with its id and link. The branch
 * `<prefix><id>-<slug>` and the first prompt follow the task until edited. Start makes the branch here (`create_branch`) or a
 * workbench (`workbench_create` with the draft task, its window opened as after Run as Task) — or, in a folder tracked
 * without git, starts here — and puts the prompt into the message box (a terminal chat: its prompt). Nothing is sent.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { flowRepoRoot } from "../../../shared/flowSettings";
import { taskPlatformTitle, taskStartSettingsFor, type TaskStartLocation } from "../../../shared/taskStartSettings";
import { t, usesMacKeys } from "../../i18n";
import { Icon } from "../../icons";
import { isEnter } from "../../ime";
import { isShadowProject } from "../../noGit";
import { hideStartScreen } from "../../startScreen";
import { branchNameHint, useStore } from "../../store";
import { fetchesFromGitHub, parseTaskReference, taskDraft, taskPlatformLine, taskStartBlocker, type FetchedTask } from "../../taskStart";
import { fetchTask, startTaskHere } from "../../taskStartFlow";
import { blockerReason } from "../BranchSwitcher";
import { Modal } from "../Menu";
import { WorkbenchProgressView } from "../flow/WorkbenchSetup";
import "../dialogs/dialogs.css";
import "./start.css";

export function TaskStartDialog({ onClose }: { onClose: () => void }) {
  const state = useStore((s) => s.state);
  const createWith = useStore((s) => s.createWorkbenchWith);
  const create = useStore((s) => s.flow.create);
  const openDialog = useStore((s) => s.openDialog);
  const [settings] = useState(() => taskStartSettingsFor(useStore.getState().settings, flowRepoRoot(useStore.getState().state)));
  const [refText, setRefText] = useState("");
  const [fetched, setFetched] = useState<FetchedTask | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [branchTyped, setBranchTyped] = useState(false);
  const [location, setLocation] = useState<TaskStartLocation>(settings.location);
  const [prompt, setPrompt] = useState("");
  const [promptTyped, setPromptTyped] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const shadow = isShadowProject(state);
  const ref = parseTaskReference(refText);
  const github = ref ? fetchesFromGitHub(ref, settings.platform) : false;
  const branchHint = shadow ? null : branchNameHint(branch, state.branches.list);
  const createBlocker = !shadow && location === "branch" && state.branches.createBlocker ? blockerReason(state.branches.createBlocker) : null;
  const blocker = taskStartBlocker({ ref, fetching, prompt, branchHint, createBlocker });

  // The branch and the prompt follow the task (the issue read, else its id and link) until the user edits them.
  useEffect(() => {
    const draft = ref ? taskDraft(settings, ref, fetched) : null;
    if (!branchTyped) setBranch(draft?.branch ?? "");
    if (!promptTyped) setPrompt(draft?.prompt ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refText, fetched]);

  // A GitHub issue is read as soon as the field holds one: a link at once, typing after it stops for a moment.
  useEffect(() => {
    setFetched(null);
    setFetchError(null);
    const seq = ++fetchSeq.current;
    if (!ref || !github || !ref.issueRef) {
      setFetching(false);
      return;
    }
    const issueRef = ref.issueRef;
    const timer = setTimeout(() => {
      setFetching(true);
      fetchTask(issueRef)
        .then((task) => {
          if (seq === fetchSeq.current) setFetched(task);
        })
        .catch((e: unknown) => {
          if (seq === fetchSeq.current) setFetchError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq === fetchSeq.current) setFetching(false);
        });
    }, ref.url ? 50 : 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refText, github]);

  const start = async () => {
    if (blocker !== null || starting) return;
    const text = prompt.trim();
    const name = branch.trim();
    setStarting(true);
    setStartError(null);
    try {
      if (!shadow && location === "workbench") {
        const path = await createWith({ branch: name, task: { text, draft: true } });
        if (!path) {
          setStartError(useStore.getState().flow.create?.error ?? t("Could not create the workbench"));
          return;
        }
        hideStartScreen();
        onClose();
        return;
      }
      const why = await startTaskHere(shadow ? null : name, text);
      if (why !== null) {
        setStartError(why);
        return;
      }
      onClose();
    } finally {
      setStarting(false);
    }
  };

  const startLabel = shadow ? t("Start in This Folder") : location === "workbench" ? t("Create Workbench") : t("Create Branch and Start");
  const startHelp = usesMacKeys()
    ? t("The prompt goes into the message box; nothing is sent until you press Return")
    : t("The prompt goes into the message box; nothing is sent until you press Enter");
  const enterStarts = (e: KeyboardEvent) => {
    if (isEnter(e)) {
      e.preventDefault();
      void start();
    }
  };

  return (
    <Modal title={t("Start from a task")} onClose={starting ? undefined : onClose} wide testId="Task start dialog">
      <div className="col task-start" style={{ gap: 10 }}>
        <div className="caption muted" data-testid="Task platform line">{taskPlatformLine(settings.platform, settings.mcpServer, taskPlatformTitle(settings.platform))}</div>
        <label className="field">
          <span>{t("Task id or link")}</span>
          <input
            type="text"
            autoFocus
            value={refText}
            disabled={starting}
            placeholder="ACME-123 · #42 · https://tracker.example.com/task/123"
            onChange={(e) => setRefText(e.target.value)}
            onKeyDown={enterStarts}
            data-testid="Task reference"
          />
        </label>
        <TaskStatus refText={refText} id={ref?.id ?? null} fetching={fetching} fetched={fetched} fetchError={fetchError} />
        {!shadow ? (
          <>
            <label className="field">
              <span>{t("Branch")}</span>
              <input
                type="text"
                className="mono"
                value={branch}
                disabled={starting}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setBranchTyped(true);
                }}
                onKeyDown={enterStarts}
                data-testid="Task branch"
              />
            </label>
            {branchHint && branch && <div className="hint error" data-testid="Task branch hint">{branchHint}</div>}
            <fieldset disabled={starting} aria-label={t("Start in")} data-testid="Task start location">
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" name="task-location" checked={location === "branch"} onChange={() => { setLocation("branch"); setStartError(null); }} />
                {t("A new branch in this window")}
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" name="task-location" checked={location === "workbench"} onChange={() => { setLocation("workbench"); setStartError(null); }} />
                {t("A new workbench")}
              </label>
            </fieldset>
          </>
        ) : (
          <div className="hint" data-testid="Task start here">{t("This folder is not a git repository — the task starts in this folder, without a branch.")}</div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <span className="bold">{t("First prompt")}</span>
          <span className="spacer" />
          <span className="caption muted">{t("Goes into the message box — you send it")}</span>
        </div>
        <textarea
          className="task-prompt"
          value={prompt}
          disabled={starting}
          aria-label={t("First prompt")}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPromptTyped(true);
          }}
          data-testid="Task first prompt"
        />
        {starting && create?.running && create.progress.length > 0 && <WorkbenchProgressView progress={create.progress} running />}
        {startError && <div className="hint error" role="alert" data-testid="Task start error">{startError}</div>}
      </div>
      <div className="actions">
        <button
          type="button"
          className="plain"
          disabled={starting}
          title={starting ? t("The task is starting") : t("Settings › Tasks: platform, branch prefix, MCP server, first prompt")}
          onClick={() => openDialog({ kind: "settings", highlight: "taskPlatform" })}
          data-testid="Task settings"
        >
          {t("Task Settings…")}
        </button>
        <span className="spacer" />
        {starting && <span className="spinner" />}
        <button type="button" onClick={onClose} disabled={starting} title={starting ? t("The task is starting") : undefined} data-testid="Task start cancel">
          {t("Cancel")}
        </button>
        <button type="button" className="primary" disabled={starting || blocker !== null} title={blocker ?? (starting ? t("The task is starting") : startHelp)} onClick={() => void start()} data-testid="Task start">
          {startLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Under the field: reading the issue, its title, why it could not be read, the task's id, or why the text names none. */
function TaskStatus(p: { refText: string; id: string | null; fetching: boolean; fetched: FetchedTask | null; fetchError: string | null }) {
  if (p.fetching) {
    return (
      <div className="task-status" role="status">
        <span className="spinner" aria-hidden="true" />
        {t("Reading the issue…")}
      </div>
    );
  }
  if (p.fetched) return <div className="task-status ok truncate" title={p.fetched.url} data-testid="Task title"><Icon name="check" size={13} />{p.fetched.title}</div>;
  if (p.fetchError) return <div className="task-status warn" title={t("The task starts without its title — Claude reads it")} data-testid="Task fetch error"><Icon name="warning" size={13} />{p.fetchError}</div>;
  if (p.id) return <div className="task-status muted">{t("Task {0}", p.id)}</div>;
  if (p.refText.trim()) return <div className="task-status muted">{t("No task id in this — use a key (ACME-123), a number or a link")}</div>;
  return <div className="task-status" />;
}
