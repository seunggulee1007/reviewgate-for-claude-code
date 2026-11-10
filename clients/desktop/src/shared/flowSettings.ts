/**
 * MARK: wave3 desktop-flow
 * The daily-flow settings of docs/PROTOCOL.md §36.11 / §36.12 / §36.14, shared by main and the renderer (pure, no
 * `electron`): the commit message template, the workbench setup and the command PR comments start with belong to the
 * REPOSITORY — they are kept under the hash of its main worktree's folder (`flowRepoRoot`), so every workbench of it drafts
 * commits in the same format, prepares new workbenches the same way and hands PR comments over with the same command (as
 * on the Mac). The engine gets `commitTemplate` / `workbenchSetup` (always explicit values: a project switch replaces the
 * previous project's); `prRespondCommand` never leaves the client.
 */
import type { PreReviewEffort, WorkbenchLocation, WorkbenchSetup } from "@reviewgate/engine";
import { projectRootHash } from "./hash.js";

/** What `flowRepoRoot` reads of a snapshot. */
export type FlowStateLike = {
  project: { path: string; root: string } | null;
  workbenches?: { list: { path: string; isMain: boolean }[] } | null;
};

/** Where the flow settings are kept: the repository's main worktree (every workbench shares it), else the open folder. */
export function flowRepoRoot(state: FlowStateLike | null | undefined): string | null {
  if (!state?.project) return null;
  const main = state.workbenches?.list.find((w) => w.isMain)?.path;
  return main || state.project.root || state.project.path || null;
}

/** The setup a repository has until the user changes it: no copies, `.worktreeinclude` read, fetch first, managed folder. */
export const DEFAULT_WORKBENCH_SETUP: Required<WorkbenchSetup> = { copy: [], useWorktreeInclude: true, setupCommand: "", fetchBase: true, location: "managed" };

/** A stored setup with every field filled (an absent / older entry gets the defaults). */
export function workbenchSetupOf(stored: WorkbenchSetup | null | undefined): Required<WorkbenchSetup> {
  const s = stored ?? {};
  return {
    copy: Array.isArray(s.copy) ? s.copy.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()) : [],
    useWorktreeInclude: s.useWorktreeInclude !== false,
    setupCommand: typeof s.setupCommand === "string" ? s.setupCommand.trim() : "",
    fetchBase: s.fetchBase !== false,
    location: s.location === "sibling" ? "sibling" : "managed",
  };
}

/** Two setups say the same (the defaults filled in). */
export function sameWorkbenchSetup(a: WorkbenchSetup | null | undefined, b: WorkbenchSetup | null | undefined): boolean {
  return JSON.stringify(workbenchSetupOf(a)) === JSON.stringify(workbenchSetupOf(b));
}

/** The per-repository maps and the effort, as `AppSettings` keeps them (src/shared/ipc.ts). */
export type FlowSettingsMaps = {
  projectCommitTemplate?: Record<string, string>;
  projectWorkbenchSetup?: Record<string, WorkbenchSetup>;
  projectPrRespondCommand?: Record<string, string>;
  preReviewEffort?: PreReviewEffort;
};

const entry = <T>(map: Record<string, T> | undefined, root: string | null): T | undefined =>
  root && map && typeof map === "object" ? map[projectRootHash(root)] : undefined;

/** The repository's commit message template ("" = none). */
export function commitTemplateFor(s: FlowSettingsMaps | null | undefined, root: string | null): string {
  const v = entry(s?.projectCommitTemplate, root);
  return typeof v === "string" ? v : "";
}

/** The repository's workbench setup, defaults filled in. */
export function workbenchSetupFor(s: FlowSettingsMaps | null | undefined, root: string | null): Required<WorkbenchSetup> {
  return workbenchSetupOf(entry(s?.projectWorkbenchSetup, root));
}

/** The repository's command for PR comments ("" = none). */
export function prRespondCommandFor(s: FlowSettingsMaps | null | undefined, root: string | null): string {
  const v = entry(s?.projectPrRespondCommand, root);
  return typeof v === "string" ? v.trim() : "";
}

/** The remembered pre-review effort (default medium). */
export function preReviewEffortOf(s: FlowSettingsMaps | null | undefined): PreReviewEffort {
  const v = s?.preReviewEffort;
  return v === "low" || v === "high" ? v : "medium";
}

/**
 * `map` with the repository's entry set to `value` — or removed when `value` is null (an empty template, the default setup):
 * the settings file keeps only what the user changed.
 */
export function withRepoEntry<T>(map: Record<string, T> | undefined, root: string, value: T | null): Record<string, T> {
  const next = { ...(map ?? {}) };
  const key = projectRootHash(root);
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

/** The `set_settings` part for the window's repository (null without a project): always explicit values. */
export function flowEngineSettings(s: FlowSettingsMaps | null | undefined, root: string | null): { commitTemplate: string; workbenchSetup: Required<WorkbenchSetup> } | null {
  if (!root) return null;
  return { commitTemplate: commitTemplateFor(s, root), workbenchSetup: workbenchSetupFor(s, root) };
}

// ---------------------------------------------------------------- renderer → main checks (src/main/settingsGuard.ts)

const PROJECT_HASH = /^[0-9a-f]{8}$/;
const plainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const cleanText = (v: unknown, max: number, singleLine: boolean): v is string =>
  typeof v === "string" && v.length <= max && !v.includes("\0") && (!singleLine || !/[\r\n]/.test(v));

/** `{ <8-hex repository hash>: value }` whose every value passes `check` (at most 500 repositories). */
export function isProjectMap(v: unknown, check: (value: unknown) => boolean): boolean {
  if (!plainObject(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 500 && entries.every(([k, value]) => PROJECT_HASH.test(k) && check(value));
}

const SETUP_KEYS = new Set(["copy", "useWorktreeInclude", "setupCommand", "fetchBase", "location"]);
const LOCATIONS: readonly WorkbenchLocation[] = ["managed", "sibling"];

/** A `WorkbenchSetup` as the renderer may store it: known keys only, ≤ 200 single-line patterns, a command ≤ 4 000 chars. */
export function isWorkbenchSetup(v: unknown): v is WorkbenchSetup {
  if (!plainObject(v)) return false;
  if (!Object.keys(v).every((k) => SETUP_KEYS.has(k))) return false;
  if (v.copy !== undefined && !(Array.isArray(v.copy) && v.copy.length <= 200 && v.copy.every((p) => cleanText(p, 500, true)))) return false;
  if (v.useWorktreeInclude !== undefined && typeof v.useWorktreeInclude !== "boolean") return false;
  if (v.fetchBase !== undefined && typeof v.fetchBase !== "boolean") return false;
  if (v.setupCommand !== undefined && !cleanText(v.setupCommand, 4000, false)) return false;
  if (v.location !== undefined && !LOCATIONS.includes(v.location as WorkbenchLocation)) return false;
  return true;
}

// ---------------------------------------------------------------- window → window (src/main/flowWindows.ts)

/** §36.12: a new workbench's failed setup, handed to the window that opens it (its banner shows the exit and the log). */
export type WorkbenchSetupReport = { branch: string; exitCode: number | null; log: string };

export function isWorkbenchSetupReport(v: unknown): v is WorkbenchSetupReport {
  return (
    plainObject(v) &&
    cleanText(v.branch, 300, true) &&
    (v.exitCode === null || (typeof v.exitCode === "number" && Number.isInteger(v.exitCode))) &&
    cleanText(v.log, 8000, false)
  );
}

/** §36.14: text handed to another window's composer ("Send to Claude" on PR comments) — never sent by itself. */
export const isComposerDraft = (v: unknown): v is string => cleanText(v, 200_000, false) && (v as string).trim().length > 0;

/** The commit template (multi-line, ≤ 5 000 chars). */
export const isCommitTemplate = (v: unknown): boolean => cleanText(v, 5000, false);
/** The PR command (one line, ≤ 500 chars). */
export const isPrRespondCommand = (v: unknown): boolean => cleanText(v, 500, true);
