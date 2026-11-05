import { open } from "node:fs/promises";
import type { AutoTurnInfo, BackgroundTask } from "../protocol.js";

/**
 * §52 background work: what the session keeps of the CLI's background tasks (`background_tasks_changed`, `task_started`,
 * `task_notification`) and how a task's output is read.
 */

/** `task_output` reads at most this much of the end of a task's output file. */
export const TASK_OUTPUT_MAX_BYTES = 64 * 1024;

/** `task_type` → the kind the clients show. */
export function taskKind(taskType: unknown): BackgroundTask["kind"] {
  if (taskType === "local_bash") return "bash";
  if (taskType === "local_agent") return "agent";
  if (typeof taskType === "string" && /monitor/i.test(taskType)) return "monitor";
  return "other";
}

/** A background Bash call's result names its output file: "… Output is being written to: <path>" (CLI 2.1.318). */
export function outputPathOf(resultText: string): string | null {
  const m = /Output is being written to:\s*(\S[^\n]*?)\s*(?:\n|$)/.exec(resultText);
  if (!m) return null;
  const path = m[1]!.replace(/[.,;]+$/, "");
  return path.length > 0 ? path : null;
}

/** One entry of `background_tasks_changed.tasks` (ambient ones are not activity: left out). */
export function liveTasksOf(tasks: unknown): { taskId: string; taskType: string; description: string }[] {
  if (!Array.isArray(tasks)) return [];
  const out: { taskId: string; taskType: string; description: string }[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.task_id !== "string" || !r.task_id || r.ambient === true) continue;
    out.push({ taskId: r.task_id, taskType: typeof r.task_type === "string" ? r.task_type : "", description: typeof r.description === "string" ? r.description : "" });
  }
  return out;
}

/** The last `maxBytes` of a file (UTF-8; a split character at the cut is dropped); `truncated` when the file is longer. */
export async function readTail(path: string, maxBytes = TASK_OUTPUT_MAX_BYTES): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    let text = buf.toString("utf8");
    if (size > maxBytes) text = text.replace(/^�+/, "");
    return { text, truncated: size > maxBytes };
  } finally {
    await fh.close();
  }
}

/** The display prompt of an auto turn (review history, rewind list). */
export function autoTurnPrompt(info: AutoTurnInfo): string {
  if (info.trigger === "background") return `[auto] background task ended${info.task?.description ? `: ${info.task.description}` : ""}`;
  if (info.trigger === "schedule") return "[auto] scheduled run";
  return "[auto] Claude continued";
}

/** An environment switch is on unless unset, empty, `0`, `false`, `no` or `off`. */
export function envTruthy(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== "" && !/^(0|false|no|off)$/i.test(v.trim());
}
