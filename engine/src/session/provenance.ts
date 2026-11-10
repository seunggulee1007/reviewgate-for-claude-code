import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { isInsidePath } from "../platform/paths.js";

/**
 * Review provenance (docs/PROTOCOL.md §31): who changed a file of the review. `tool` — an edit tool
 * (`Edit` / `Write` / `MultiEdit` / `NotebookEdit`, by its `file_path`) or an MCP tool (its execution
 * window); `bash` — a Bash call (the post-Bash snapshot, narrowed to the call's execution window);
 * `external` — nothing of Claude's explains it (the IDE, another Claude session, `git pull`, …).
 */
export type FileOrigin = "tool" | "bash" | "skill" | "external";

// MARK: r2-skills-side — §31.1 (M35): a skill's own work.
/**
 * The name a skill's window and cause carry: a `Skill` call (its tool_use id), or a slash command's turn before its first tool
 * call (`commandWindowId`) — its !`command` lines run while the CLI expands it, where no hook sees them.
 */
export const SKILL_TOOL = "Skill";
const COMMAND_WINDOW_PREFIX = "skill:";
/** The cause id of a slash command's own work (`skill:acme-verify`). */
export function commandWindowId(name: string): string {
  return COMMAND_WINDOW_PREFIX + name;
}
/** The command a cause id names (`skill:acme-verify` → `acme-verify`), else null. */
export function commandOfWindowId(id: string): string | null {
  return id.startsWith(COMMAND_WINDOW_PREFIX) && id.length > COMMAND_WINDOW_PREFIX.length ? id.slice(COMMAND_WINDOW_PREFIX.length) : null;
}
/** A window whose writes are attributed after the collection (no `file_path`, no post-call snapshot): MCP calls and skills. */
export function isWriterWindow(name: string): boolean {
  return isMcpTool(name) || name === SKILL_TOOL;
}

/**
 * When a Bash or MCP call ran (epoch ms): recorded by the PreToolUse hook, finished by PostToolUse /
 * PostToolUseFailure (`start` is then moved up to `end - duration_ms`, so a permission card the user
 * thought about for a minute is not part of it). A window whose call never finished has `end: null`.
 */
export type ToolWindow = {
  toolUseId: string;
  name: string;
  start: number;
  end: number | null;
  /** The hook's `cwd` (it follows a `cd` in Bash). */
  cwd?: string;
  /** The PostToolUse hook's `cwd` when the call moved it (`cd x && …` in Bash). */
  cwdAfter?: string;
  /** Bash only. */
  command?: string;
};

/**
 * How far before a window's start a change still counts as the call's: file timestamps vs the clock of
 * the hook, and `duration_ms` measured inside the CLI. The end gets `WINDOW_END_SLACK_MS`.
 */
export const WINDOW_MARGIN_MS = 1500;
export const WINDOW_END_SLACK_MS = 100;

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** MCP tools (`mcp__<server>__<tool>`): their writes are attributed through their execution window. */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * The origin a file's `tools` / `toolUseIds` describe. A tool name without a tool_use id (a `Read`, a
 * failed edit) is no cause. `toolUseIds` absent (reviews persisted before §12) trusts the tool names.
 */
export function originOf(f: { tools: readonly string[]; toolUseIds?: readonly string[] }): FileOrigin {
  if (f.toolUseIds !== undefined && f.toolUseIds.length === 0) return "external";
  if (f.tools.some((t) => EDIT_TOOL_NAMES.has(t) || isMcpTool(t))) return "tool";
  if (f.tools.includes("Bash")) return "bash";
  if (f.tools.includes(SKILL_TOOL)) return "skill"; // MARK: r2-skills-side (§31.1, M35)
  return "external";
}

/**
 * When `abs` last changed (its ctime: unlike mtime, `touch -t` / `cp -p` cannot set it back). A path that
 * no longer exists counts its nearest existing parent directory below `root` (a delete or rename updates
 * the directory). null when nothing could be read.
 */
export async function changeTimeOf(abs: string, root: string): Promise<number | null> {
  let p = abs;
  for (;;) {
    const st = await lstat(p).catch(() => null);
    if (st) return st.ctimeMs;
    const parent = dirname(p);
    if (parent === p || !isInsidePath(parent, root)) return null;
    p = parent;
  }
}

/** True when change time `t` falls inside the finished window `w` (start − `marginMs`, end + a slack). */
export function inWindow(t: number, w: Pick<ToolWindow, "start" | "end">, marginMs = WINDOW_MARGIN_MS): boolean {
  if (w.end === null) return false;
  return t >= w.start - marginMs && t <= w.end + WINDOW_END_SLACK_MS;
}

/** The files among `abs` whose change time falls inside `w`. */
export async function changedWithin(abs: readonly string[], w: Pick<ToolWindow, "start" | "end">, root: string, marginMs = WINDOW_MARGIN_MS): Promise<string[]> {
  const out: string[] = [];
  for (const f of abs) {
    const t = await changeTimeOf(f, root);
    if (t !== null && inWindow(t, w, marginMs)) out.push(f);
  }
  return out;
}
