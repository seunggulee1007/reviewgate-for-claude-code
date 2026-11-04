import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isPermissionMode, MAX_TASK_TEXT, type PermissionMode } from "../protocol.js";
import { writeAtomicJSON } from "./persist.js";

/**
 * docs/PROTOCOL.md §49: a task started in a workbench of its own (`workbench_create {task}`). The engine that creates the
 * workbench writes the task into the new worktree's git dir; that worktree's engine takes it (once) when its window opens
 * the project and sends it as the first message of a fresh chat — the chat it was typed in never sees it. The same shape
 * and rules as the plan handoff (§42.1, `planHandoff.ts`).
 */

export const TASK_HANDOFF_FILE = "task-handoff.json";
/** A handoff older than this is dropped unread (the window that should have taken it never opened). */
export const TASK_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;

export type TaskHandoff = {
  version: 1;
  /** The worktree the task was started from. */
  from: { path: string; name: string };
  /** The first message of the fresh chat. */
  text: string;
  /** The fresh chat's mode (one of the four; never a bypass); absent: the worktree's own default. */
  mode?: PermissionMode;
  /** ISO-8601 */
  at: string;
};

const handoffPath = (gitDir: string) => join(gitDir, "reviewgate", TASK_HANDOFF_FILE);

/** The task's text as sent, or null when it is not one (empty, too long, not a string). */
export function taskText(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TASK_TEXT) return null;
  return text;
}

export async function writeTaskHandoff(gitDir: string, handoff: TaskHandoff): Promise<void> {
  mkdirSync(join(gitDir, "reviewgate"), { recursive: true });
  await writeAtomicJSON(handoffPath(gitDir), handoff);
}

/** Reads and removes the handoff waiting in `gitDir` (null: none, unreadable, malformed or stale). */
export function takeTaskHandoff(gitDir: string, now: number = Date.now()): TaskHandoff | null {
  const path = handoffPath(gitDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  let v: Partial<TaskHandoff>;
  try {
    v = JSON.parse(raw) as Partial<TaskHandoff>;
  } catch {
    return null;
  }
  const text = v ? taskText(v.text) : null;
  if (!v || v.version !== 1 || text === null || typeof v.at !== "string") return null;
  if (v.mode !== undefined && !isPermissionMode(v.mode)) return null;
  const at = Date.parse(v.at);
  if (!Number.isFinite(at) || now - at > TASK_HANDOFF_MAX_AGE_MS || at - now > TASK_HANDOFF_MAX_AGE_MS) return null;
  const fromPath = typeof v.from?.path === "string" ? v.from.path : "";
  return {
    version: 1,
    from: { path: fromPath, name: typeof v.from?.name === "string" && v.from.name ? v.from.name : basename(fromPath) },
    text,
    ...(v.mode !== undefined ? { mode: v.mode } : {}),
    at: v.at,
  };
}
