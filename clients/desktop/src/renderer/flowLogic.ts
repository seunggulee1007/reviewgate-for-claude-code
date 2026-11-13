/**
 * MARK: wave3 desktop-flow
 * The decisions behind the commit sheet's draft and the New Workbench sheet (docs/PROTOCOL.md §36.11 / §36.12), kept free
 * of React so they are tested — the same rules as the Mac's `WorkflowLogic`: the template preview, the base the sheet starts
 * from, the sibling folder, the create's steps and their log, and the flow refusals in the user's words.
 */
import type { WorkbenchProgressEvent, WorkbenchStep } from "@reviewgate/engine";
import { refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import type { WorkbenchSetupReport } from "../shared/flowSettings";

export type { WorkbenchSetupReport };

// ---------------------------------------------------------------- §36.11 commit message template

/**
 * `{issue}`: the branch name's longest run of digits, the first of equals (`feature/PAY-1800-2` → `1800`; "" without
 * one) — the engine's rule without the subjects (§41.1; §36.11 took the last run). MARK: wave4c w4c-commit
 */
export function commitIssue(branch: string | null | undefined): string {
  let best = "";
  for (const r of (branch ?? "").match(/[0-9]+/g) ?? []) if (r.length > best.length) best = r;
  return best;
}

/** The template as the engine renders it for the draft: `{issue}` and `{branch}` substituted. */
export function renderCommitTemplate(template: string, branch: string | null | undefined): string {
  return template.replaceAll("{issue}", commitIssue(branch)).replaceAll("{branch}", branch ?? "");
}

export function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i);
}

// ---------------------------------------------------------------- §51 the PR sheet's title / description

/** The PR sheet's title and description. */
export type PRSheetText = { title: string; body: string };

/**
 * The PR sheet's text: what is in the fields, whether the user changed each one (then a later `pr_draft` — another base —
 * leaves it alone) and what Claude's fill replaced (for "Restore what I had", until the user edits a field).
 */
export type PRSheetState = PRSheetText & { typedTitle: boolean; typedBody: boolean; replaced: PRSheetText | null };

export const EMPTY_PR_SHEET: PRSheetState = { title: "", body: "", typedTitle: false, typedBody: false, replaced: null };

export type PRSheetAction =
  /** The field's input: only a change of its text is the user's typing (the Mac's field wrote the same text back on focus). */
  | { kind: "edit"; field: "title" | "body"; value: string }
  /** `pr_draft` (from the branch's commits): fills each field the user has not changed. */
  | { kind: "commits"; title: string; body: string }
  /** `pr_ai_draft`: Claude's text replaces the fields (an empty title / body keeps the sheet's); a base picked later keeps it. */
  | { kind: "claude"; title: string; body: string }
  /** "Restore what I had". */
  | { kind: "restore" };

export function prSheetReduce(s: PRSheetState, a: PRSheetAction): PRSheetState {
  switch (a.kind) {
    case "edit":
      if (a.value === s[a.field]) return s;
      return a.field === "title" ? { ...s, title: a.value, typedTitle: true, replaced: null } : { ...s, body: a.value, typedBody: true, replaced: null };
    case "commits": {
      const title = s.typedTitle ? s.title : a.title;
      const body = s.typedBody ? s.body : a.body;
      return title === s.title && body === s.body ? s : { ...s, title, body };
    }
    case "claude": {
      const current: PRSheetText = { title: s.title, body: s.body };
      const filled: PRSheetText = { title: a.title.trim() ? a.title : s.title, body: a.body.trim() ? a.body : s.body };
      const changed = filled.title !== current.title || filled.body !== current.body;
      const hadText = current.title.trim() !== "" || current.body.trim() !== "";
      return { ...filled, typedTitle: true, typedBody: true, replaced: changed && hadText ? current : null };
    }
    case "restore":
      return s.replaced ? { ...s, ...s.replaced, replaced: null } : s;
  }
}

/** The `pr_ai_draft` for the sheet: its title / description only when they hold something (trimmed). */
export function prAiDraftCommand(base: string, sheet: PRSheetText): { type: "pr_ai_draft"; base: string; title?: string; body?: string } {
  const title = sheet.title.trim();
  const body = sheet.body.trim();
  return { type: "pr_ai_draft", base: base.trim(), ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

/** Why "Fill with Claude" cannot run now (null: it can) — no base, `gh` not ready (what turns Create PR off), no commits. */
export function prFillBlocker(o: { base: string; ghReason: string | null; unsupported: boolean; baseRef?: string | null; commits?: number | null }): string | null {
  if (o.unsupported) return updateReason();
  if (!o.base.trim()) return t("Choose a base branch first");
  if (o.ghReason) return o.ghReason;
  if (o.baseRef && o.commits === 0) return t("This branch has no commits since {0}", o.baseRef);
  return null;
}

// ---------------------------------------------------------------- §36.12 workbench setup

/**
 * The base the New Workbench sheet starts with. Fetching by default (an engine that knows §36.12): the remote twin of the
 * main worktree's branch (`origin/develop` — where new work starts), else of the current branch; otherwise the current
 * branch as before. `origin` wins over another remote with the same branch.
 */
export function defaultWorkbenchBase(current: string, mainBranch: string | null | undefined, remotes: readonly string[], fetchBase: boolean, supportsSetup: boolean): string {
  if (!supportsSetup || !fetchBase) return current;
  const twin = (branch: string | null | undefined): string | null => {
    if (!branch) return null;
    const depth = branch.split("/").length + 1;
    const matches = remotes.filter((r) => r.endsWith(`/${branch}`) && r.split("/").length === depth);
    return matches.find((r) => r.startsWith("origin/")) ?? matches[0] ?? null;
  };
  return twin(mainBranch) ?? twin(current) ?? current;
}

/** The engine's `sibling` folder: `<parent of the main worktree>/<repo>-<branch tail>` (`feature/PAY-1600` → `acme-PAY-1600`). */
export function siblingWorkbenchPath(mainWorktree: string, branch: string): string {
  const trimmed = mainWorktree.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut >= 0 ? trimmed.slice(0, cut) : "";
  const repo = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  const sep = cut >= 0 ? trimmed[cut]! : "/";
  const tail = branch.trim().split("/").filter(Boolean).pop() ?? branch.trim();
  return `${parent}${sep}${repo}-${slug(tail)}`;
}

/** The folder-safe name the engine derives from a branch (store.ts `workbenchSlug`; this module stays free of the store). */
const slug = (branch: string): string => branch.trim().replace(/[^A-Za-z0-9._-]/g, "-") || "workbench";

export const WORKBENCH_STEPS: readonly WorkbenchStep[] = ["fetch", "create", "copy", "setup", "done"];
const stepIndex = (s: WorkbenchStep) => WORKBENCH_STEPS.indexOf(s);

/** A step's exit: none (absent), the process's code, or killed / timed out (`exitCode: null`). */
export type StepExit = { kind: "none" } | { kind: "code"; code: number } | { kind: "killed" };

export function stepExit(ev: Pick<WorkbenchProgressEvent, "exitCode"> | undefined): StepExit {
  if (!ev || ev.exitCode === undefined) return { kind: "none" };
  if (ev.exitCode === null) return { kind: "killed" };
  return typeof ev.exitCode === "number" ? { kind: "code", code: ev.exitCode } : { kind: "none" };
}

export const exitFailed = (e: StepExit): boolean => e.kind === "killed" || (e.kind === "code" && e.code !== 0);

/** One entry per step (the latest event), in step order. */
export function applyProgress(list: readonly WorkbenchProgressEvent[], ev: WorkbenchProgressEvent): WorkbenchProgressEvent[] {
  const rest = list.filter((p) => p.step !== ev.step);
  return [...rest, ev].sort((a, b) => stepIndex(a.step) - stepIndex(b.step));
}

/** The steps to draw: those that happened, and while running the ones still ahead (a skipped fetch / copy / setup is left out). */
export function shownSteps(progress: readonly WorkbenchProgressEvent[], running: boolean): WorkbenchStep[] {
  const latest = progress[progress.length - 1]?.step;
  if (!latest) return running ? ["create"] : [];
  const happened = new Set(progress.map((p) => p.step));
  return WORKBENCH_STEPS.filter((s) => happened.has(s) || (running && stepIndex(s) > stepIndex(latest)));
}

export type StepState = "pending" | "running" | "done" | "warning" | "failed";

/** How a step is drawn: a failed fetch is a warning (the create may go on from the local ref), any other failure an error. */
export function stepState(progress: readonly WorkbenchProgressEvent[], step: WorkbenchStep, running: boolean): StepState {
  const ev = progress.find((p) => p.step === step);
  if (!ev) return "pending";
  const exit = stepExit(ev);
  if (exitFailed(exit)) return step === "fetch" ? "warning" : "failed";
  if (running && step === progress[progress.length - 1]?.step && step !== "done" && exit.kind === "none") return "running";
  return "done";
}

/** The newest non-empty log (the step that printed last). */
export function latestLog(progress: readonly WorkbenchProgressEvent[]): string | null {
  for (let i = progress.length - 1; i >= 0; i--) {
    const log = progress[i]!.logTail?.replace(/^\n+|\n+$/g, "");
    if (log) return log;
  }
  return null;
}

/** The setup step ran and failed (its own event, else `done` repeating its exit). */
export function setupFailedOf(progress: readonly WorkbenchProgressEvent[]): boolean {
  const setup = progress.find((p) => p.step === "setup") ?? progress.find((p) => p.step === "done");
  return exitFailed(stepExit(setup));
}

/** The new worktree's folder as the steps named it. */
export function createdPathOf(progress: readonly WorkbenchProgressEvent[]): string | null {
  for (let i = progress.length - 1; i >= 0; i--) if (progress[i]!.path) return progress[i]!.path;
  return null;
}

/** A failed setup's report for the new window's banner (null when the setup did not fail). */
export function setupReportOf(progress: readonly WorkbenchProgressEvent[]): WorkbenchSetupReport | null {
  if (!setupFailedOf(progress)) return null;
  const setup = progress.find((p) => p.step === "setup") ?? progress.find((p) => p.step === "done")!;
  const exit = stepExit(setup);
  return { branch: setup.branch, exitCode: exit.kind === "code" ? exit.code : null, log: latestLog(progress) ?? "" };
}

export function stepTitle(step: WorkbenchStep): string {
  switch (step) {
    case "fetch":
      return t("Fetch the base");
    case "create":
      return t("Create the worktree");
    case "copy":
      return t("Copy the files");
    case "setup":
      return t("Setup command");
    case "done":
      return t("Ready");
  }
}

/** "exit 1" / "stopped (10 min limit)" / "" */
export function exitWords(e: StepExit): string {
  if (e.kind === "code") return t("exit {0}", e.code);
  if (e.kind === "killed") return t("stopped (10 min limit)");
  return "";
}

/** The new window's banner headline for a failed setup. */
export function setupReportHeadline(r: WorkbenchSetupReport): string {
  if (r.exitCode === null) return t("The setup command of this workbench was stopped after 10 minutes. The workbench is ready otherwise.");
  return t("The setup command of this workbench failed (exit {0}). The workbench is ready otherwise — fix it in a terminal.", r.exitCode);
}

/** `12.3 KB` */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------- words

/** The one-line reason a §36.11–36.14 control is off with an engine before §36. */
export const updateReason = (): string => t("This engine does not support it yet — update ReviewGate");

/** The flow commands' refusals in the user's words; null = a code these screens do not word themselves. */
export function flowRefusalText(code: string, detail: string): string | null {
  const d = detail.trim();
  switch (code) {
    case "unknown_command":
      return updateReason();
    case "nothing_to_commit":
      return t("Select accepted files first — only accepted files can be committed");
    case "side_limit":
      return t("Too many side sessions are running — wait for one to finish");
    case "commit_draft_failed":
      return d ? t("Claude could not write a message: {0}", d) : t("Claude could not write a message");
    case "pr_ai_draft_failed": // §51
      return d ? t("Claude could not fill in the PR: {0}", d) : t("Claude could not fill in the PR");
    case "empty_base": // §51 (the PR sheet's Fill with Claude; the app's own words elsewhere)
      return t("Choose a base branch first");
    case "btw_failed": // §56.1
      return d ? t("Claude could not answer the side question: {0}", d) : t("Claude could not answer the side question");
    case "fetch_failed":
      return d ? t("Could not fetch from the remote: {0}", d) : t("Could not fetch from the remote");
    case "no_review":
      return t("There is no review to pre-review yet");
    case "prereview_running":
      return t("A pre-review is already running");
    case "not_a_changed_file":
      return t("Not a changed file of this review: {0}", d);
    case "invalid_prereview":
      return t("That pre-review request is not valid");
    case "unknown_prereview":
      return t("That pre-review is gone");
    case "unknown_finding":
      return t("That finding is gone");
    case "not_running":
      return t("The pre-review has already ended");
    default:
      return null;
  }
}

/** A rejected flow request in words (the flow wording first, then the app's usual one). */
export function flowRefusal(e: unknown): string {
  const r = refusalOf(e);
  // An engine before §36 answers a command it does not know with "unknown command: <type>" (leading word `unknown`).
  if (r.code === "unknown_command" || /^unknown command\b/.test(r.error)) return updateReason();
  return flowRefusalText(r.code, r.detail) ?? refusalMessage(r);
}

/** True when `e` is the refusal of an engine that does not know the command. */
export function isUnknownCommand(e: unknown): boolean {
  const r = refusalOf(e);
  return r.code === "unknown_command" || /^unknown command\b/.test(r.error);
}

/** A failed pre-review's `error` (English code words like refusals) in the user's words. */
export function preReviewFailure(error: string | null | undefined): string {
  if (!error) return t("The pre-review failed");
  // The engine stopped it (the app closed, the chat changed): "interrupted (ReviewGate was closed)".
  if (error.startsWith("interrupted")) return t("Interrupted — ReviewGate was closed or the chat changed");
  const r = refusalOf(error);
  return flowRefusalText(r.code, r.detail) ?? error;
}
