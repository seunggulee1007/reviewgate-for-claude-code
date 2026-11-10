/**
 * "New Workbench…" (the Mac app's `NewWorkbenchSheet`): branch name + live hint, base picker, path
 * preview → `workbench_create`, then the new worktree opens in its own window. `NewBranchDialog` is
 * the in-place sibling ("New Branch…" → `create_branch`).
 * MARK: wave3 desktop-flow (docs/PROTOCOL.md §36.12 / §36.14, as on the Mac): with an engine that knows §36.12 the base can be
 * a remote branch (origin/develop — the remote twin of the main worktree's branch by default) with "Fetch before creating",
 * the folder rule is "Managed folder" / "Next to the repository" with the path `workbench_preview` names, the files it copies
 * ("%d files will be copied", the list) and the setup command are shown before it runs (with a switch to skip them) and
 * "Edit…" opens the repository's Workbench setup; while it creates, the steps (fetch → create → copy → setup → done) and the
 * latest log — "Close" leaves it running and its window opens when it is ready (a failed setup still opens it, with the log).
 * `fromPr` ("Open as workbench" in the PR tab) checks out the PR's head instead of branching from a base. An engine before
 * §36.12 gets the old sheet.
 * MARK: §49 Run as Task (업무로 실행, as on the Mac): `task` (the composer's text, "" from the menus) adds the task and the mode
 * of the new workbench's fresh chat (this chat's mode at first); the branch is suggested from the task until the user types
 * one, with the prefix the last task branch used. The new window's engine sends the task as its first message.
 */
import { useEffect, useMemo, useState } from "react";
import type { PermissionMode, WorkbenchLocation } from "@reviewgate/engine";
import { t } from "../../i18n";
import { branchNameHint, permissionMode, useStore, workbenchSlug } from "../../store";
import { Modal } from "../Menu";
import { displayPath } from "../Sidebar";
// MARK: wave3 desktop-flow
import { defaultWorkbenchBase, siblingWorkbenchPath } from "../../flowLogic";
import { prWorkbenchBranch } from "../../prClaude";
import { previewKeyOf, supportsWorkbenchSetup, type PRWorkbenchRequest } from "../../storeFlow";
import { flowRepoRoot, workbenchSetupFor } from "../../../shared/flowSettings";
import { WorkbenchProgressView, WorkbenchSetupSection } from "../flow/WorkbenchSetup";
import "./dialogs.css";
import { isEnter } from "../../ime";
// MARK: §49 Run as Task
import { suggestTaskBranch, taskPrefixOf } from "../../runAsTask";
import { MODES, modeHelp, modeLabel } from "../chat/ModeMenu";

const DEFAULT_WORKTREE_ROOT = "~/.reviewgate/worktrees";

/** `branch`: prefilled (§33.4 — the worktree Claude wanted, from the `worktree_blocked` banner); `fromPr`: §36.14. */
export function NewWorkbenchDialog({ onClose, branch: initialBranch, fromPr, planMode, task: handedTask }: { onClose: () => void; branch?: string; fromPr?: PRWorkbenchRequest; planMode?: PermissionMode /* MARK: wave4d w4d-plan */; task?: string /* MARK: §49 */ }) {
  const state = useStore((s) => s.state);
  const settings = useStore((s) => s.settings);
  const flow = useStore((s) => s.flow);
  const createWith = useStore((s) => s.createWorkbenchWith);
  const requestPreview = useStore((s) => s.requestWorkbenchPreview);
  const supportsSetup = supportsWorkbenchSetup(state, flow);
  const setup = workbenchSetupFor(settings, flowRepoRoot(state));
  const remotes = state.branches.remotes ?? [];
  const main = state.workbenches.list.find((w) => w.isMain);
  const current = state.project?.branch ?? state.branches.list.find((b) => b.isCurrent)?.name ?? "";
  /** A create of this window still running (the sheet was closed and opened again): its branch and steps. */
  const runningCreate = flow.create?.running ? flow.create : null;
  // MARK: §49 Run as Task — the task, the mode of its fresh chat, the branch suggested from it until the user types one.
  const runsTask = handedTask !== undefined && !fromPr;
  const [task, setTask] = useState(handedTask ?? "");
  const [taskMode, setTaskMode] = useState<PermissionMode>(() => permissionMode(state));
  const [branchTyped, setBranchTyped] = useState(false);
  const taskPrefix = taskPrefixOf(settings);
  const [branch, setBranch] = useState(
    () => runningCreate?.branch ?? initialBranch ?? (fromPr ? prWorkbenchBranch(fromPr.number, fromPr.headRef, fromPr.baseRef) : runsTask ? suggestTaskBranch(handedTask ?? "", taskPrefix) : ""),
  );
  const editTask = (text: string) => {
    setTask(text);
    if (!branchTyped && !initialBranch) setBranch(suggestTaskBranch(text, taskPrefix));
  };
  const [base, setBase] = useState(() => defaultWorkbenchBase(current, main?.branch, remotes.map((r) => r.name), setup.fetchBase, supportsSetup));
  const [fetch, setFetch] = useState(setup.fetchBase);
  const [runSetup, setRunSetup] = useState(true);
  const [location, setLocation] = useState<WorkbenchLocation>(setup.location);
  /** The create this sheet started (its steps and refusal stay on screen). */
  const [startedHere, setStartedHere] = useState(false);

  const creating = runningCreate !== null;
  const trimmed = branch.trim();
  // An existing local branch is fine for a PR (the engine checks it out as it is). §49: a task needs its text.
  const hint = runsTask && task.trim().length === 0 ? t("Describe the task") : branchNameHint(branch, fromPr ? [] : state.branches.list);
  const isRemoteBase = !fromPr && remotes.some((r) => r.name === base);
  const baseRef = !fromPr && base ? base : undefined;
  const request = useMemo(() => ({ branch: trimmed, ...(baseRef ? { from: baseRef } : {}), ...(supportsSetup ? { location } : {}) }), [trimmed, baseRef, supportsSetup, location]);
  const key = previewKeyOf(request);
  const preview = flow.previewKey === key ? flow.preview : null;
  const setupKey = JSON.stringify(setup);

  // §36.12: where it would go and what it would copy — asked as the user types (debounced), and again when the setup changes.
  const [asked, setAsked] = useState(false);
  const valid = hint === null;
  useEffect(() => {
    if (!supportsSetup || !valid || creating) return;
    requestPreview(request, asked ? undefined : 0);
    setAsked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setupKey, supportsSetup, valid, creating]);

  const root = state.workbenches.managedRoot || settings?.worktreeRoot || DEFAULT_WORKTREE_ROOT;
  const managedPath = `${root.replace(/[\\/]+$/, "")}/${workbenchSlug(branch)}`;
  const createdPath = runningCreate?.progress.find((p) => p.path)?.path ?? null;
  const shownPath =
    createdPath ??
    (supportsSetup && preview?.path ? preview.path : supportsSetup && location === "sibling" && main ? siblingWorkbenchPath(main.path, trimmed || "workbench") : managedPath);
  const pathPreview = displayPath(shownPath);
  const create = flow.create;
  const showSteps = creating || (startedHere && create !== null && create.progress.length > 0);
  const error = startedHere && create && !create.running ? create.error : null;
  const inUsePath = startedHere && create && !create.running ? create.inUsePath : null;

  const start = () => {
    if (hint !== null || creating) return;
    setStartedHere(true);
    void createWith({
      branch: trimmed,
      ...(baseRef ? { from: baseRef } : {}),
      ...(supportsSetup && isRemoteBase ? { fetch } : {}),
      ...(supportsSetup ? { setup: runSetup, location } : {}),
      ...(fromPr ? { fromPr: { number: fromPr.number, headRef: fromPr.headRef } } : {}),
      ...(planMode ? { planMode } : {}), // MARK: wave4d w4d-plan — §42.1: the pending plan goes to it before its window opens
      ...(runsTask ? { task: { text: task, mode: taskMode }, ...(handedTask ? { handedTask } : {}) } : {}), // MARK: §49
    });
  };

  return (
    <Modal title={fromPr ? t("Open PR #{0} as a workbench", fromPr.number) : runsTask ? t("Run as Task") : t("New Workbench")} onClose={onClose} wide={supportsSetup} testId="New workbench dialog">
      {runsTask ? (
        <>
          <div className="muted">{t("Starts the task in a workbench of its own — a new branch and folder, its own window and a fresh chat — so this chat is left as it is.")}</div>
          {/* MARK: §49: the first message of the new workbench's fresh chat, and the mode that chat starts in */}
          <label className="field">
            <span>{t("Task")}</span>
            <textarea
              rows={4}
              className="wb-task"
              autoFocus
              value={task}
              disabled={creating}
              onChange={(e) => editTask(e.target.value)}
              data-testid="Run as Task text"
            />
          </label>
          <div className="muted caption">{t("A task link, a key such as ABC-123, or what to do — sent as the first message there.")}</div>
          <label className="field">
            <span>{t("Mode")}</span>
            <select value={taskMode} disabled={creating} onChange={(e) => setTaskMode(e.target.value as PermissionMode)} data-testid="Run as Task mode">
              {MODES.map((m) => (
                <option key={m} value={m}>{`${modeLabel(m)} — ${modeHelp(m)}`}</option>
              ))}
            </select>
          </label>
        </>
      ) : fromPr ? (
        <>
          <div className="bold truncate" title={fromPr.title}>{fromPr.title}</div>
          <div className="muted">{t("Checks out the PR's head in a worktree and opens it in its own window with its own Claude session — to build, test or fix it locally.")}</div>
        </>
      ) : (
        <div className="muted">{t("Creates a git worktree on a new branch and opens it in its own window with its own Claude session.")}</div>
      )}
      <label className="field">
        <span>{t("Branch name")}</span>
        <input
          type="text"
          className="mono"
          autoFocus={!runsTask}
          value={branch}
          disabled={creating}
          onChange={(e) => {
            setBranch(e.target.value);
            setBranchTyped(true); // §49: no more suggestions from the task
          }}
          onKeyDown={(e) => isEnter(e) && start()}
          data-testid="New workbench branch"
        />
      </label>
      {fromPr ? (
        <div className="field-row" data-testid="Workbench PR head">
          <span>{t("From")}</span>
          <span className="mono truncate" title={fromPr.headRef}>PR #{fromPr.number} · {fromPr.headRef}</span>
        </div>
      ) : (
        <>
          <label className="field">
            <span>{t("Base branch")}</span>
            <select value={base} disabled={creating} onChange={(e) => setBase(e.target.value)} data-testid="Workbench base">
              {state.branches.list.length === 0 && <option value="">HEAD</option>}
              {supportsSetup && remotes.length > 0 ? (
                <>
                  <optgroup label={t("Local")}>
                    {state.branches.list.map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </optgroup>
                  <optgroup label={t("Remote")}>
                    {remotes.map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </optgroup>
                </>
              ) : (
                state.branches.list.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))
              )}
            </select>
          </label>
          {supportsSetup && isRemoteBase && (
            <label className="check" title={t("Runs git fetch for this branch first, so the workbench starts from the remote's latest commit")}>
              <input type="checkbox" checked={fetch} disabled={creating} onChange={(e) => setFetch(e.target.checked)} data-testid="Workbench fetch" />
              {t("Fetch before creating")}
            </label>
          )}
        </>
      )}
      <div className="field-row">
        <span>{t("Folder")}</span>
        <div className="wb-folder">
          {supportsSetup && (
            <div className="wb-location" role="radiogroup" aria-label={t("Folder")} data-testid="Workbench location">
              {(["managed", "sibling"] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={location === l} className={location === l ? "active" : ""} disabled={creating} onClick={() => setLocation(l)} data-testid={`Workbench location ${l}`}>
                  {l === "managed" ? t("Managed folder") : t("Next to the repository")}
                </button>
              ))}
            </div>
          )}
          {/* <bdi>: the path stays left-to-right inside the right-to-left box that cuts it from the left */}
          <span className="path" title={pathPreview} data-testid="Workbench path preview"><bdi>{pathPreview}</bdi></span>
        </div>
      </div>
      {supportsSetup && (
        <WorkbenchSetupSection setup={setup} preview={preview} loading={flow.previewLoading} error={flow.previewKey === key ? flow.previewError : null} runSetup={runSetup} onRunSetup={setRunSetup} disabled={creating} />
      )}
      {showSteps && create && <WorkbenchProgressView progress={create.progress} running={creating} />}
      {error ? (
        <div className="col" style={{ gap: 6, alignItems: "flex-start" }}>
          <div className="hint error" data-testid="New workbench error">{error}</div>
          {inUsePath && (
            <button
              type="button"
              className="small"
              onClick={() => {
                onClose();
                void window.rg.openWorkbenchWindow(inUsePath);
              }}
              data-testid="Open the workbench that has the branch"
            >
              {t("Open that workbench")}
            </button>
          )}
        </div>
      ) : hint && !creating ? (
        <div className="hint" data-testid="New workbench hint">{hint}</div>
      ) : fromPr ? (
        <div className="hint">{t("Checks out PR #{0}'s head into a new worktree.", fromPr.number)}</div>
      ) : runsTask ? (
        <div className="hint">{t("Branches from {0} into a new worktree; its window sends the task in a fresh chat.", base || "HEAD")}</div>
      ) : (
        <div className="hint">{t("Branches from {0} into a new worktree.", base || "HEAD")}</div>
      )}
      <div className="actions">
        {creating && <span className="spinner" />}
        <span className="spacer" />
        {/* A create cannot be stopped: closing the sheet leaves it running, and its window opens when it is ready. */}
        <button type="button" onClick={onClose} title={creating ? t("The workbench is still being prepared; its window opens when it is ready") : undefined} data-testid="Close workbench sheet">
          {creating ? t("Close") : t("Cancel")}
        </button>
        <button type="button" className="primary" disabled={hint !== null || creating} onClick={start} data-testid="Create workbench">
          {fromPr ? t("Open as workbench") : runsTask ? t("Run as Task") : t("Create workbench")}
        </button>
      </div>
    </Modal>
  );
}

/** "New Branch…": `create_branch` in this worktree (allowed only while `switchBlocker` is null). */
export function NewBranchDialog({ onClose }: { onClose: () => void }) {
  const branches = useStore((s) => s.state.branches);
  const createBranch = useStore((s) => s.createBranch);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const hint = branchNameHint(name, branches.list);

  const create = async () => {
    if (hint !== null || creating || branches.switchBlocker) return;
    setCreating(true);
    await createBranch(name.trim());
    setCreating(false);
    onClose();
  };

  return (
    <Modal title={t("New Branch")} onClose={creating ? undefined : onClose} testId="New branch dialog">
      <div className="muted">{t("Creates a branch from the current HEAD and checks it out.")}</div>
      <label className="field">
        <span>{t("Branch name")}</span>
        <input type="text" className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => isEnter(e) && void create()} data-testid="New branch name" />
      </label>
      <div className="hint" data-testid="New branch hint">{hint ?? ""}</div>
      <div className="actions">
        {creating && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={creating} onClick={onClose}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={hint !== null || creating} onClick={() => void create()} data-testid="Create branch">
          {t("Create branch")}
        </button>
      </div>
    </Modal>
  );
}
