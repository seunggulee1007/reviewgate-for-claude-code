/**
 * §52 background work, free of React so it is tested (the same rules as the Mac's `BackgroundSupport`): the tasks Claude
 * started (`state.session.backgroundTasks`), the HUD chip, the rows of a turn Claude started itself (`auto_turn`), the
 * "백그라운드로" rule, Ctrl+B, and the refusals in the user's words.
 */
import type { AutoTurnInfo, AutoTurnTrigger, BackgroundTask } from "@reviewgate/engine";
import { refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { relativeTime, t } from "./i18n";

export type { AutoTurnInfo, AutoTurnTrigger, BackgroundTask };

// ---------------------------------------------------------------- the list

const KINDS = new Set(["bash", "monitor", "agent", "other"]);

/** `state.session.backgroundTasks`, leniently: an engine before §52 sends none; an odd entry is skipped, odd fields fall back. */
export function backgroundTasksOf(session: { backgroundTasks?: unknown } | null | undefined): BackgroundTask[] {
  const raw = session?.backgroundTasks;
  if (!Array.isArray(raw)) return [];
  const out: BackgroundTask[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.taskId !== "string" || o.taskId === "") continue;
    out.push({
      taskId: o.taskId,
      kind: typeof o.kind === "string" && KINDS.has(o.kind) ? (o.kind as BackgroundTask["kind"]) : "other",
      description: typeof o.description === "string" ? o.description : "",
      toolUseId: typeof o.toolUseId === "string" ? o.toolUseId : null,
      turn: typeof o.turn === "number" && Number.isFinite(o.turn) ? o.turn : null,
      startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
      hasOutput: o.hasOutput === true,
    });
  }
  return out;
}

/** The HUD chip: "백그라운드 2"; null while nothing runs in the background. */
export function backgroundChipText(tasks: readonly BackgroundTask[]): string | null {
  return tasks.length > 0 ? t("Background {0}", tasks.length) : null;
}

export function taskKindLabel(kind: BackgroundTask["kind"]): string {
  switch (kind) {
    case "bash":
      return t("Command");
    case "monitor":
      return t("Monitor");
    case "agent":
      return t("Agent");
    default:
      return t("Job");
  }
}

/** The task's name in the list: its description, else its id. */
export function taskTitle(task: Pick<BackgroundTask, "description" | "taskId">): string {
  return task.description.trim() !== "" ? task.description.trim() : task.taskId;
}

/** "Command · turn 3 · 5 minutes ago" (the turn only when known). */
export function taskMetaLine(task: BackgroundTask): string {
  const parts = [taskKindLabel(task.kind)];
  if (task.turn !== null) parts.push(t("Turn {0} of the chat", task.turn));
  const when = relativeTime(task.startedAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- turns Claude started itself

/** A transcript row of such a turn. */
export type AutoTurnRow = { kind: "autoTurn"; id: number; turn: number } & AutoTurnInfo;

const TRIGGERS = new Set(["background", "schedule", "continue"]);

/** The `auto_turn` event / restored row → the transcript row; an odd trigger reads as `continue`. */
export function autoTurnRowOf(
  info: { turn: number; trigger?: unknown; task?: unknown; wakeupSource?: unknown },
  id: number,
): AutoTurnRow | null {
  if (typeof info.turn !== "number" || !Number.isFinite(info.turn)) return null;
  const trigger = typeof info.trigger === "string" && TRIGGERS.has(info.trigger) ? (info.trigger as AutoTurnTrigger) : "continue";
  const rawTask = info.task as Record<string, unknown> | null | undefined;
  const task =
    rawTask && typeof rawTask === "object" && typeof rawTask.taskId === "string"
      ? {
          taskId: rawTask.taskId,
          description: typeof rawTask.description === "string" ? rawTask.description : "",
          status: typeof rawTask.status === "string" ? rawTask.status : "completed",
          ...(typeof rawTask.summary === "string" && rawTask.summary !== "" ? { summary: rawTask.summary } : {}),
        }
      : undefined;
  return {
    kind: "autoTurn",
    id,
    turn: info.turn,
    trigger,
    ...(task ? { task } : {}),
    ...(typeof info.wakeupSource === "string" ? { wakeupSource: info.wakeupSource } : {}),
  };
}

/** The row's title by trigger (and the finished task's status). */
export function autoTurnTitle(row: Pick<AutoTurnInfo, "trigger" | "task">): string {
  switch (row.trigger) {
    case "background":
      if (row.task?.status === "failed") return t("A background task failed, so Claude went on");
      if (row.task?.status === "stopped") return t("A background task stopped, so Claude went on");
      return t("A background task finished, so Claude went on");
    case "schedule":
      return t("A scheduled task ran (/loop)");
    default:
      return t("Claude went on by itself");
  }
}

/** The second line, and a muted third (the CLI's summary when it says more than the description). */
export function autoTurnLines(row: Pick<AutoTurnInfo, "trigger" | "task">): { detail: string | null; summary: string | null } {
  const description = row.task?.description.trim() ?? "";
  const summary = row.task?.summary?.trim() ?? "";
  const detail = description !== "" ? description : row.trigger === "schedule" ? t("This turn's changes are reviewed like any other turn's.") : null;
  return { detail, summary: summary !== "" && summary !== description ? summary : null };
}

/** True when an `auto_turn` of this turn is already in the rows (the engine may say it twice: a reconnect, a restore). */
export function hasAutoTurnRow(rows: readonly { kind: string; turn?: number }[], turn: number): boolean {
  return rows.some((r) => r.kind === "autoTurn" && r.turn === turn);
}

// ---------------------------------------------------------------- 백그라운드로 / Ctrl+B

/** Is the background work setting on (default true)? */
export const backgroundWorkOn = (settings: { backgroundWork?: boolean | undefined } | null | undefined): boolean => settings?.backgroundWork !== false;

/**
 * [백그라운드로] on a Bash row: the main thread's call, still running (the turn runs, no result yet), not in another
 * session's turn, and the setting on.
 */
export function canMoveToBackground(p: {
  name: string;
  parentToolUseId?: string | undefined;
  hasResult: boolean;
  turnRunning: boolean;
  externalTurn: boolean;
  enabled: boolean;
}): boolean {
  return p.name === "Bash" && !p.parentToolUseId && !p.hasResult && p.turnRunning && !p.externalTurn && p.enabled;
}

/** The key event's shape that matters here. */
export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** Ctrl+B in the message box moves the running command to the background — only with an empty box, a running turn, the setting on. */
export function isBackgroundKey(e: KeyLike, p: { draftEmpty: boolean; turnRunning: boolean; enabled: boolean; viewing?: boolean }): boolean {
  if (e.key.toLowerCase() !== "b" || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  return p.draftEmpty && p.turnRunning && p.enabled && !p.viewing;
}

// ---------------------------------------------------------------- commands and replies

export const taskStopCommand = (taskId: string) => ({ type: "task_stop" as const, taskId });
export const taskOutputCommand = (taskId: string) => ({ type: "task_output" as const, taskId });
/** Ctrl+B has no id (all foreground tasks); a row's button names its call. */
export const taskBackgroundCommand = (toolUseId?: string) => ({ type: "task_background" as const, ...(toolUseId ? { toolUseId } : {}) });

/** What the output dialog shows: the text, whether the last 64 KB were cut, whether the task still runs. */
export type TaskOutput = { text: string; truncated: boolean; running: boolean };

/** The `task_output` reply, leniently. */
export function taskOutputOf(reply: { text?: unknown; truncated?: unknown; running?: unknown } | null | undefined): TaskOutput {
  return { text: typeof reply?.text === "string" ? reply.text : "", truncated: reply?.truncated === true, running: reply?.running === true };
}

/** The `task_background` reply's `moved`; anything else is "not moved". */
export const movedOf = (reply: { moved?: unknown } | null | undefined): boolean => reply?.moved === true;

export const CANNOT_MOVE_TEXT = (): string => t("Could not move it to the background");

// ---------------------------------------------------------------- refusals in the user's words

/** `task_unknown` / `no_output` / `background_off` / `no_session` / `*_failed:<why>`; null = a code these controls do not word themselves. */
export function backgroundRefusalText(code: string, detail: string): string | null {
  const d = detail.trim();
  switch (code) {
    case "task_unknown":
      return t("That task has already ended.");
    case "no_output":
      return t("This task has no output to show yet.");
    case "background_off":
      return t("Background tasks are off (Settings › Session, or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).");
    case "no_session":
      return t("There is no running Claude session.");
    case "task_stop_failed":
      return d ? t("Could not stop the task: {0}", d) : t("Could not stop the task");
    case "task_background_failed":
      return d ? t("Could not move it to the background: {0}", d) : t("Could not move it to the background");
    default:
      return null;
  }
}

/** A rejected request in words (this feature's wording first, then the app's usual one). */
export function backgroundRefusal(e: unknown): string {
  const r = refusalOf(e);
  return backgroundRefusalText(r.code, r.detail) ?? refusalMessage(r);
}
