/**
 * MARK: task-start — docs/PROTOCOL.md §63.3: Settings › Tasks, as Core `TaskStart.swift` keeps them on the Mac — the task
 * platform, the branch prefix, where a task starts, the MCP server Claude reads it with and the first prompt's template —
 * per repository (the hash of its main worktree's folder, `flowRepoRoot`) with a default every project without its own
 * uses. Shared by main (settingsGuard) and the renderer; pure. Read leniently field by field: a value an older or newer
 * app wrote that this one does not know falls back to its default.
 */
import { projectRootHash } from "./hash.js";

/** Where a project's tasks live: none, GitHub Issues (read with `gh`), or a tracker Claude reads through an MCP server. */
export type TaskPlatform = "none" | "github" | "jira" | "linear" | "mcp";
export const TASK_PLATFORMS: readonly TaskPlatform[] = ["none", "github", "jira", "linear", "mcp"];

/** Where "Start from a task" starts: a new branch in this window, or a new workbench. */
export type TaskStartLocation = "branch" | "workbench";

export type TaskStartSettings = {
  platform: TaskPlatform;
  /** What the branch starts with (`feature/`; `{type}` becomes `fix` / `docs` / `chore` / `feature` from the labels). */
  branchPrefix: string;
  location: TaskStartLocation;
  /** The MCP server Claude reads Jira / Linear / other tasks with ("" = none chosen). */
  mcpServer: string;
  /** The first prompt; absent = the built-in one. */
  promptTemplate?: string;
};

export const DEFAULT_TASK_PREFIX = "feature/";
export const DEFAULT_TASK_START: TaskStartSettings = { platform: "none", branchPrefix: DEFAULT_TASK_PREFIX, location: "branch", mcpServer: "" };

/** The English key of a platform's name (the Mac's). */
export function taskPlatformTitle(p: TaskPlatform): string {
  switch (p) {
    case "none":
      return "None";
    case "github":
      return "GitHub Issues";
    case "jira":
      return "Jira";
    case "linear":
      return "Linear";
    case "mcp":
      return "Other (MCP server)";
  }
}

/** Claude reads the task through an MCP server (the app does not). */
export const readsThroughMcp = (p: TaskPlatform): boolean => p === "jira" || p === "linear" || p === "mcp";

const plainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A stored entry with every field filled (field by field: an odd value gets its default). */
export function taskStartSettingsOf(raw: unknown): TaskStartSettings {
  const v = plainObject(raw) ? raw : {};
  const platform = TASK_PLATFORMS.includes(v.platform as TaskPlatform) ? (v.platform as TaskPlatform) : "none";
  const out: TaskStartSettings = {
    platform,
    branchPrefix: typeof v.branchPrefix === "string" ? v.branchPrefix : DEFAULT_TASK_PREFIX,
    location: v.location === "workbench" ? "workbench" : "branch",
    mcpServer: typeof v.mcpServer === "string" ? v.mcpServer : "",
  };
  if (typeof v.promptTemplate === "string") out.promptTemplate = v.promptTemplate;
  return out;
}

/** What `AppSettings` keeps (src/shared/ipc.ts). */
export type TaskStartMaps = {
  taskStartSettings?: TaskStartSettings;
  projectTaskStartSettings?: Record<string, TaskStartSettings>;
};

const ownEntry = (s: TaskStartMaps | null | undefined, root: string | null): unknown => {
  const map = s?.projectTaskStartSettings;
  return root && plainObject(map) ? map[projectRootHash(root)] : undefined;
};

/** The default every project without its own uses. */
export const globalTaskStartSettings = (s: TaskStartMaps | null | undefined): TaskStartSettings => taskStartSettingsOf(s?.taskStartSettings);

/** The repository's own settings, else the default. */
export function taskStartSettingsFor(s: TaskStartMaps | null | undefined, root: string | null): TaskStartSettings {
  const own = ownEntry(s, root);
  return own !== undefined ? taskStartSettingsOf(own) : globalTaskStartSettings(s);
}

/** The repository has settings of its own. */
export const hasProjectTaskStartSettings = (s: TaskStartMaps | null | undefined, root: string | null): boolean => ownEntry(s, root) !== undefined;

/** The settings patch that stores `value` as the repository's own (`root`) or as the default (`root` null); null clears the repository's. */
export function taskStartPatch(s: TaskStartMaps | null | undefined, root: string | null, value: TaskStartSettings | null): TaskStartMaps {
  if (!root) return value ? { taskStartSettings: value } : {};
  const next = { ...(plainObject(s?.projectTaskStartSettings) ? s!.projectTaskStartSettings : {}) };
  const key = projectRootHash(root);
  if (value) next[key] = value;
  else delete next[key];
  return { projectTaskStartSettings: next };
}

// ---------------------------------------------------------------- renderer → main checks (src/main/settingsGuard.ts)

const KEYS = new Set(["platform", "branchPrefix", "location", "mcpServer", "promptTemplate"]);
const line = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !v.includes("\0") && !/[\r\n]/.test(v);

/** A `TaskStartSettings` as the renderer may store it: known keys and values, single-line prefix and server, a template ≤ 20 000. */
export function isTaskStartSettings(v: unknown): v is TaskStartSettings {
  if (!plainObject(v) || !Object.keys(v).every((k) => KEYS.has(k))) return false;
  if (!TASK_PLATFORMS.includes(v.platform as TaskPlatform)) return false;
  if (!line(v.branchPrefix, 200) || !line(v.mcpServer, 200)) return false;
  if (v.location !== "branch" && v.location !== "workbench") return false;
  if (v.promptTemplate !== undefined && !(typeof v.promptTemplate === "string" && v.promptTemplate.length <= 20_000 && !v.promptTemplate.includes("\0"))) return false;
  return true;
}
