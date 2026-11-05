/**
 * Store slice (wave3 desktop-flow, docs/PROTOCOL.md §36.11–36.14): the client state of the daily-flow screens that is not in
 * the engine's snapshot — a commit draft in flight, the New Workbench sheet's preview and the steps of a create (which keeps
 * running when the sheet is closed: its window opens when it is ready, with the setup's log when that failed), the AI
 * pre-review runs (`gate.prereviews` + `prereview` events, optimistic dismiss, "Add as note" = an ordinary `add_note`), the
 * repository's flow settings (src/shared/flowSettings.ts) and "Send to Claude" for PR comments (a composer draft — in the
 * window of the PR head's workbench when one is open, else here; nothing is ever sent from here). Spread into `useStore`
 * (store.ts); the members are declared in `Store` under "MARK: wave3 desktop-flow". The decisions are pure (flowLogic.ts,
 * preReview.ts, prClaude.ts).
 */
import type { StateCreator } from "zustand";
import type {
  EngineEvent,
  PermissionMode, // MARK: wave4d w4d-plan
  PreReviewEffort,
  PreReviewFinding,
  PreReviewRun,
  PreReviewScope,
  ReviewState,
  WorkbenchFromPr,
  WorkbenchLocation,
  WorkbenchPreviewEvent,
  WorkbenchProgressEvent,
  WorkbenchSetup,
  WorkbenchTask, // MARK: §49
} from "@reviewgate/engine";
import { insertIntoComposer, taskLeftComposer } from "./composerBridge";
import { taskBranchPrefixOf } from "./runAsTask"; // MARK: §49
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { applyProgress, createdPathOf, flowRefusal, flowRefusalText, isUnknownCommand, prAiDraftCommand, setupReportOf, updateReason, type PRSheetText } from "./flowLogic";
import { applyRun, findingKey, headStatus, noteBody, normalizeRun, withoutFinding } from "./preReview";
import { prCommentsDraft, respondCommand, type PRCommentThread } from "./prClaude";
import {
  DEFAULT_WORKBENCH_SETUP,
  flowRepoRoot,
  prRespondCommandFor,
  sameWorkbenchSetup,
  withRepoEntry,
  workbenchSetupOf,
  type WorkbenchSetupReport,
} from "../shared/flowSettings";
import type { AppSettings } from "../shared/ipc";
import type { Store } from "./store";

/** The `workbench_preview` a reply belongs to. */
export type WorkbenchPreviewRequest = { branch: string; from?: string; location?: WorkbenchLocation };
export const previewKeyOf = (r: WorkbenchPreviewRequest): string => JSON.stringify([r.branch, r.from ?? null, r.location ?? null]);

/** A `workbench_create` with the §36.12 / §36.14 options (only sent to an engine that knows them). */
export type WorkbenchCreateRequest = { branch: string; from?: string; fetch?: boolean; setup?: boolean; location?: WorkbenchLocation; fromPr?: WorkbenchFromPr
  /** MARK: wave4d w4d-plan — §42.1 [새 워크벤치에서 구현]: hand the pending plan to the new workbench (in this mode) before its window opens. */
  planMode?: PermissionMode;
  /** MARK: §49 "Run as Task": the first message of the new workbench's fresh chat (its window's engine sends it). */
  task?: WorkbenchTask;
  /** §49: the text the composer handed over — it leaves the composer once the task started (unless edited since). */
  handedTask?: string };

export type { PRSheetText };

/** §51 `pr_ai_draft`: Claude's text for the PR sheet, or the refusal in one line (`unsupported`: an engine before §51). */
export type PRFillResult = { ok: true; title: string; body: string } | { ok: false; error: string; unsupported: boolean };

/** §36.14: the PR the New Workbench sheet checks out ("Open as workbench"). */
export type PRWorkbenchRequest = { number: number; headRef: string; baseRef: string; title: string };

/** The create in flight (or the last one): its steps, and why it was refused. */
export type WorkbenchCreateState = {
  branch: string;
  fromPr: WorkbenchFromPr | null;
  running: boolean;
  /** One entry per step (the latest event), in step order. */
  progress: WorkbenchProgressEvent[];
  /** The refusal in words; null while running / after a success. */
  error: string | null;
  /** `branch_in_use:<path>`: the workbench that has the branch already (offered instead). */
  inUsePath: string | null;
  /** The new worktree (its window was opened). */
  createdPath: string | null;
};

export type FlowState = {
  // §36.11
  drafting: boolean;
  /** Why the last draft failed (one line); null after a success. */
  draftError: string | null;
  /** False once the engine answered `unknown_command` (the button stays off with the reason). */
  draftSupported: boolean;
  // §36.12
  preview: WorkbenchPreviewEvent | null;
  /** `previewKeyOf` of the request `preview` answers. */
  previewKey: string | null;
  previewLoading: boolean;
  previewError: string | null;
  previewSupported: boolean;
  create: WorkbenchCreateState | null;
  /** This window is a new workbench whose setup failed: the banner's exit and log. */
  setupReport: WorkbenchSetupReport | null;
  // §36.13
  /** `gate.prereviews` + `prereview` events, newest first. */
  runs: PreReviewRun[];
  starting: boolean;
  /** Why the last start / cancel / dismiss / note was refused (one line); null after a success. */
  preReviewError: string | null;
  preReviewSupported: boolean;
  /** Findings whose dismiss / note is in flight (`findingKey`). */
  busy: Record<string, true>;
};

export const EMPTY_FLOW: FlowState = {
  drafting: false,
  draftError: null,
  draftSupported: true,
  preview: null,
  previewKey: null,
  previewLoading: false,
  previewError: null,
  previewSupported: true,
  create: null,
  setupReport: null,
  runs: [],
  starting: false,
  preReviewError: null,
  preReviewSupported: true,
  busy: {},
};

/** What `saveFlowSettings` changes for the window's repository. */
export type FlowSettingsPatch = { commitTemplate?: string; workbenchSetup?: WorkbenchSetup; prRespondCommand?: string; preReviewEffort?: PreReviewEffort };

export type FlowSlice = Pick<
  Store,
  | "flow"
  | "applyFlowEvent"
  | "flowSnapshotApplied"
  | "resetFlow"
  | "draftCommitMessage"
  | "fillPRWithClaude"
  | "requestWorkbenchPreview"
  | "createWorkbenchWith"
  | "startPreReview"
  | "cancelPreReview"
  | "dismissFinding"
  | "addFindingAsNote"
  | "clearFlowError"
  | "saveFlowSettings"
  | "sendPrThreads"
  | "dismissSetupReport"
>;

// ---------------------------------------------------------------- derived (components)

/** §36.12: the engine knows the setup (it lists remote branches, even none) and did not refuse the preview. */
export const supportsWorkbenchSetup = (state: ReviewState, flow: FlowState): boolean => state.branches.remotes !== undefined && flow.previewSupported;

/** §36.13: the engine keeps pre-reviews (`gate.prereviews`, always sent by one that knows §36.13) and did not refuse them. */
export const supportsPreReview = (state: ReviewState, flow: FlowState): boolean => flow.preReviewSupported && state.gate.prereviews !== undefined;

/** Why "AI pre-review" cannot start now; null = it can. */
export function preReviewBlocker(state: ReviewState, flow: FlowState): string | null {
  if (!supportsPreReview(state, flow)) return updateReason();
  if (!state.project) return refusalMessage({ code: "no_project", error: "no_project", detail: "" });
  if (state.changedFiles.length === 0 || (!state.gate.reviewEndTree && !state.gate.turnEndTree)) return flowRefusal("no_review");
  if (flow.starting || headStatus(flow.runs, state.gate.reviewEndTree).kind === "running") return flowRefusal("prereview_running");
  return null;
}

const DEBOUNCE_MS = 250;

export const createFlowSlice: StateCreator<Store, [], [], FlowSlice> = (set, get) => {
  const setFlow = (patch: Partial<FlowState> | ((f: FlowState) => Partial<FlowState>)) =>
    set((s) => ({ flow: { ...s.flow, ...(typeof patch === "function" ? patch(s.flow) : patch) } }));
  const log = (line: string) => {
    const logs = [...get().logs, line];
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    set({ logs });
  };
  /** The snapshot's list last applied: a snapshot repeating it never overrides a newer event. */
  let lastSnapshotRuns: string | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewSeq = 0;
  const hasWindow = () => typeof window !== "undefined" && typeof window.rg === "object" && window.rg !== null;

  return {
    flow: EMPTY_FLOW,

    applyFlowEvent(ev: EngineEvent) {
      switch (ev.type) {
        case "workbench_progress": {
          const create = get().flow.create;
          // Ours: the create in flight of this window (an event without a branch is ours too).
          if (create?.running && (ev.branch === create.branch || !ev.branch)) setFlow({ create: { ...create, progress: applyProgress(create.progress, ev) } });
          return true;
        }
        case "prereview": {
          const { type: _type, id: _id, ...run } = ev;
          setFlow((f) => ({ runs: applyRun(f.runs, run) }));
          return true;
        }
        case "commit_draft":
        case "pr_ai_draft": // §51
        case "workbench_preview":
          // Replies: their request has them.
          return true;
        default:
          return false;
      }
    },

    flowSnapshotApplied(previous, snapshot) {
      const path = snapshot.project?.path ?? null;
      if (path !== (previous.project?.path ?? null)) {
        get().resetFlow();
        // §36.12: this window may be a new workbench whose setup failed — its report came with the window.
        if (path && hasWindow() && typeof window.rg.takeWorkbenchSetupReport === "function") {
          const initial = (window as { rgInitialProject?: string | null }).rgInitialProject ?? null;
          const paths = [path, snapshot.project?.root ?? null, initial].filter((p): p is string => !!p);
          void window.rg
            .takeWorkbenchSetupReport([...new Set(paths)])
            .then((report) => {
              if (report && get().state.project?.path === path) setFlow({ setupReport: report });
            })
            .catch(() => undefined);
        }
      }
      // §36.13: the engine's list wins when it changes (a finished round, a dismiss and a restart all show there).
      const list = snapshot.gate.prereviews;
      if (Array.isArray(list)) {
        const key = JSON.stringify(list);
        if (key !== lastSnapshotRuns) {
          lastSnapshotRuns = key;
          setFlow({ runs: list.map(normalizeRun) });
        }
      }
    },

    resetFlow() {
      lastSnapshotRuns = null;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = null;
      previewSeq++;
      // A create keeps going in the engine; only its steps are this project's view.
      set({ flow: EMPTY_FLOW });
    },

    // ------------------------------------------------------------ §36.11

    async draftCommitMessage(paths) {
      if (get().flow.drafting) return null;
      setFlow({ drafting: true, draftError: null });
      try {
        const reply = await engineRequest({ type: "commit_draft", ...(paths ? { paths } : {}) });
        const message = (reply.message ?? "").trim();
        if (!message) {
          setFlow({ drafting: false, draftError: flowRefusal("commit_draft_failed") });
          return null;
        }
        setFlow({ drafting: false, draftError: null, draftSupported: true });
        return message;
      } catch (e) {
        log(`[warn] commit_draft: ${refusalOf(e).error}`);
        const unsupported = isUnknownCommand(e);
        setFlow((f) => ({ drafting: false, draftError: flowRefusal(e), draftSupported: unsupported ? false : f.draftSupported }));
        return null;
      }
    },

    // ------------------------------------------------------------ §51

    async fillPRWithClaude(base, sheet) {
      const cmd = prAiDraftCommand(base, sheet);
      // The engine refuses an empty base too (`empty_base`); the sheet says it without asking.
      if (!cmd.base) return { ok: false, error: flowRefusalText("empty_base", "")!, unsupported: false };
      try {
        const reply = await engineRequest(cmd);
        const title = (reply.title ?? "").trim();
        const body = (reply.body ?? "").trim();
        if (!title && !body) return { ok: false, error: flowRefusalText("pr_ai_draft_failed", "")!, unsupported: false };
        return { ok: true, title, body };
      } catch (e) {
        log(`[warn] pr_ai_draft: ${refusalOf(e).error}`);
        return { ok: false, error: flowRefusal(e), unsupported: isUnknownCommand(e) };
      }
    },

    // ------------------------------------------------------------ §36.12

    requestWorkbenchPreview(req, delayMs = DEBOUNCE_MS) {
      if (!get().flow.previewSupported || !req.branch || !get().state.project) return;
      if (previewTimer) clearTimeout(previewTimer);
      const seq = ++previewSeq;
      setFlow({ previewLoading: true });
      const run = () => {
        previewTimer = null;
        engineRequest({ type: "workbench_preview", branch: req.branch, ...(req.from ? { from: req.from } : {}), ...(req.location ? { location: req.location } : {}) })
          .then((reply) => {
            if (seq === previewSeq) setFlow({ preview: reply, previewKey: previewKeyOf(req), previewLoading: false, previewError: null });
          })
          .catch((e: unknown) => {
            if (seq !== previewSeq) return;
            log(`[info] workbench_preview: ${refusalOf(e).error}`);
            if (isUnknownCommand(e)) setFlow({ previewSupported: false, previewLoading: false, previewError: null, preview: null, previewKey: null });
            else setFlow({ previewLoading: false, previewError: flowRefusal(e), preview: null, previewKey: previewKeyOf(req) });
          });
      };
      if (delayMs <= 0) run();
      else previewTimer = setTimeout(run, delayMs);
    },

    async createWorkbenchWith(req) {
      const s = get();
      if (!s.state.project || s.flow.create?.running) return null;
      const base: WorkbenchCreateState = { branch: req.branch, fromPr: req.fromPr ?? null, running: true, progress: [], error: null, inUsePath: null, createdPath: null };
      setFlow({ create: base });
      const mine = () => get().flow.create?.branch === req.branch;
      try {
        await engineRequest({
          type: "workbench_create",
          branch: req.branch,
          ...(req.from ? { from: req.from } : {}),
          ...(req.fetch !== undefined ? { fetch: req.fetch } : {}),
          ...(req.setup !== undefined ? { setup: req.setup } : {}),
          ...(req.location ? { location: req.location } : {}),
          ...(req.fromPr ? { fromPr: req.fromPr } : {}),
          ...(req.task ? { task: req.task } : {}), // MARK: §49
        });
        await get().settle();
      } catch (e) {
        const r = refusalOf(e);
        log(`[warn] workbench_create: ${r.error}`);
        const words = flowRefusal(e);
        if (mine()) setFlow((f) => ({ create: { ...f.create!, running: false, error: words, inUsePath: r.code === "branch_in_use" && r.detail.trim() ? r.detail.trim() : null } }));
        // The sheet was closed meanwhile: the window's banner says it instead.
        const d = get().dialog?.kind;
        if (d !== "newWorkbench" && d !== "newWorkbenchFromPr") set({ lastError: words, errorBanner: { message: words, scope: "git", fatal: false, code: r.code } });
        return null;
      }
      // MARK: §49: the next suggestion starts the way this branch did; the composer lets the task's text go.
      if (req.task) {
        const prefix = taskBranchPrefixOf(req.branch);
        if (get().settings?.taskBranchPrefix !== prefix) void get().saveSettings({ taskBranchPrefix: prefix }).catch((e) => log(`[warn] taskBranchPrefix: ${e instanceof Error ? e.message : String(e)}`));
        if (req.handedTask) taskLeftComposer(req.handedTask);
      }
      const progress = mine() ? get().flow.create!.progress : [];
      const find = () => get().state.workbenches.list.find((w) => w.branch === req.branch)?.path ?? null;
      let path = createdPathOf(progress) ?? find();
      if (!path) {
        await get().refreshWorkbenches();
        path = find();
      }
      if (mine()) setFlow((f) => ({ create: { ...f.create!, running: false, createdPath: path } }));
      if (!path) return null;
      // A failed setup does not fail the create: the window opens and shows the log (§36.12).
      const report = setupReportOf(progress);
      // MARK: wave4d w4d-plan — §42.1: the plan's handoff is written before the window opens (its engine takes it on open);
      // a refusal stays on the plan card here, the workbench opens anyway.
      if (req.planMode) await get().approvePlanInto(req.planMode, "workbench", path);
      if (hasWindow()) void window.rg.openWorkbenchWindow(path, report ?? undefined);
      const d = get().dialog?.kind;
      if (d === "newWorkbench" || d === "newWorkbenchFromPr") get().openDialog(null);
      return path;
    },

    dismissSetupReport() {
      setFlow({ setupReport: null });
    },

    // ------------------------------------------------------------ §36.13

    async startPreReview(scope: PreReviewScope, paths: string[] | undefined, effort: PreReviewEffort) {
      if (get().flow.starting) return false;
      setFlow({ starting: true, preReviewError: null });
      try {
        const reply = await engineRequest({ type: "prereview_start", scope, ...(paths && paths.length > 0 ? { paths } : {}), effort });
        const { type: _type, id: _id, ...run } = reply;
        setFlow((f) => ({ starting: false, preReviewSupported: true, runs: reply.type === "prereview" ? applyRun(f.runs, run) : f.runs }));
        return true;
      } catch (e) {
        log(`[warn] prereview_start: ${refusalOf(e).error}`);
        const unsupported = isUnknownCommand(e);
        setFlow((f) => ({ starting: false, preReviewError: flowRefusal(e), preReviewSupported: unsupported ? false : f.preReviewSupported }));
        return false;
      }
    },

    async cancelPreReview(prereviewId) {
      setFlow({ preReviewError: null });
      try {
        await engineRequest({ type: "prereview_cancel", prereviewId });
      } catch (e) {
        // Ended meanwhile: its own end arrives (or already did) — not worth a message.
        if (refusalOf(e).code !== "not_running") setFlow({ preReviewError: flowRefusal(e) });
      }
    },

    async dismissFinding(prereviewId, findingId) {
      const key = findingKey(prereviewId, findingId);
      if (get().flow.busy[key]) return;
      const before = get().flow.runs;
      setFlow((f) => ({ busy: { ...f.busy, [key]: true }, runs: withoutFinding(f.runs, prereviewId, findingId) }));
      try {
        await engineRequest({ type: "prereview_dismiss", prereviewId, findingId });
        setFlow({ preReviewError: null });
      } catch (e) {
        // Already gone in the engine: it stays gone here too.
        if (refusalOf(e).code !== "unknown_finding") setFlow({ runs: before, preReviewError: flowRefusal(e) });
      } finally {
        setFlow((f) => {
          const { [key]: _done, ...busy } = f.busy;
          return { busy };
        });
      }
    },

    async addFindingAsNote(prereviewId, finding: PreReviewFinding, excerpt) {
      const key = findingKey(prereviewId, finding.id);
      if (get().flow.busy[key]) return false;
      setFlow((f) => ({ busy: { ...f.busy, [key]: true } }));
      try {
        await engineRequest({ type: "add_note", path: finding.file, line: finding.line, side: "new", excerpt, body: noteBody(finding) });
      } catch (e) {
        log(`[warn] add_note (pre-review): ${refusalOf(e).error}`);
        setFlow((f) => {
          const { [key]: _done, ...busy } = f.busy;
          return { busy, preReviewError: refusalMessage(refusalOf(e)) };
        });
        return false;
      }
      setFlow((f) => {
        const { [key]: _done, ...busy } = f.busy;
        return { busy };
      });
      await get().dismissFinding(prereviewId, finding.id);
      return true;
    },

    clearFlowError(which) {
      setFlow(which === "draft" ? { draftError: null } : { preReviewError: null });
    },

    // ------------------------------------------------------------ settings (per repository)

    async saveFlowSettings(patch) {
      const s = get();
      const root = flowRepoRoot(s.state);
      if (!s.settings) return;
      const next: Partial<AppSettings> = {};
      if (root && patch.commitTemplate !== undefined) next.projectCommitTemplate = withRepoEntry(s.settings.projectCommitTemplate, root, patch.commitTemplate.trim() ? patch.commitTemplate : null);
      if (root && patch.workbenchSetup !== undefined) {
        const setup = workbenchSetupOf(patch.workbenchSetup);
        next.projectWorkbenchSetup = withRepoEntry(s.settings.projectWorkbenchSetup, root, sameWorkbenchSetup(setup, DEFAULT_WORKBENCH_SETUP) ? null : setup);
      }
      if (root && patch.prRespondCommand !== undefined) next.projectPrRespondCommand = withRepoEntry(s.settings.projectPrRespondCommand, root, patch.prRespondCommand.trim() ? patch.prRespondCommand.trim() : null);
      if (patch.preReviewEffort !== undefined) next.preReviewEffort = patch.preReviewEffort;
      if (Object.keys(next).length === 0) return;
      try {
        await get().saveSettings(next);
      } catch (e) {
        log(`[warn] flow settings: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    // ------------------------------------------------------------ §36.14

    async sendPrThreads(threads: PRCommentThread[]) {
      const s = get();
      const pr = s.state.pr.selected;
      if (!pr || threads.length === 0) return null;
      const command = respondCommand(prRespondCommandFor(s.settings, flowRepoRoot(s.state)), pr.number);
      const text = prCommentsDraft(pr.number, pr.title, threads, command);
      // The PR head branch's workbench, when a window has it open: the draft goes there (that window comes forward).
      const wb = s.state.workbenches.list.find((w) => w.branch === pr.headRefName && !w.isCurrent && w.path !== s.state.workbenches.current);
      if (wb && hasWindow() && typeof window.rg.composeInWindow === "function") {
        const delivered = await window.rg.composeInWindow(wb.path, text).catch(() => false);
        if (delivered) return "workbench";
      }
      if (!s.state.project) return null;
      // This window: the chat comes forward with the draft after what is typed — the user reads it and sends it.
      get().setTab("changes");
      insertIntoComposer(text);
      return "this";
    },
  };
};
