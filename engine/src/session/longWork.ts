/**
 * MARK: wave4 w4-longwork — docs/PROTOCOL.md §38.2: long work that never stops silently.
 *
 * - the tool-call limit of one message (`settings.maxTurns`, the CLI's `maxTurns`) and the notice when a turn hits it;
 * - the subscription's usage windows (`rate_limit_event`) as `state.hud.rateLimits`;
 * - what hooks and the CLI say on the way (`system/informational`, a failed `hook_response`) as chat notices;
 * - the change budget Claude was told about, renewed in the next message when the user changes it.
 */
import type { Budget, RateLimitWindow } from "../protocol.js";
import { firstLineOf, isoFromEpoch } from "./apiErrors.js";
import { redactDetail } from "./cliRecords.js";

/** The CLI's `maxTurns` when the settings carry none: model round trips (≈ tool calls) of one message. */
export const DEFAULT_MAX_TURNS = 200;
export const MIN_MAX_TURNS = 10;
export const MAX_MAX_TURNS = 1000;

/** `settings.maxTurns` → the limit a session starts with: a whole number in [10, 1000]; anything else → 200. */
export function clampMaxTurns(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(v)));
}

/** The `error` codes of §38.2: notices (no `state.lastError`, never a stopped queue). */
export const LONG_WORK_NOTICE_CODES: ReadonlySet<string> = new Set(["max_turns", "hook_failed", "hook_blocked", "cli_warning", "cli_notice"]);

export function isLongWorkNotice(code: string | undefined): boolean {
  return code !== undefined && LONG_WORK_NOTICE_CODES.has(code);
}

/** A notice the session emits as `error{fatal: false}` (the engine records it as a row, §30). */
export type LongWorkNotice = {
  code: "max_turns" | "hook_failed" | "hook_blocked" | "cli_warning" | "cli_notice";
  message: string;
  detail?: string;
  maxTurns?: number;
  hookName?: string;
  exitCode?: number | null;
};

/** `result{subtype: "error_max_turns"}`: Claude stopped at the limit before it finished. */
export function maxTurnsNotice(limit: number): LongWorkNotice {
  return { code: "max_turns", message: `Claude stopped at the tool-call limit (${limit} calls) before it finished; send "continue" to go on.`, maxTurns: limit };
}

/**
 * `system/informational`: `prevent_continuation` (a Stop hook denied continuation, a UserPromptSubmit hook blocked the
 * prompt) → `hook_blocked`; level `warning` / `suggestion` → `cli_warning`; `notice` → `cli_notice`; `info` (transcript
 * mode only in the terminal) → nothing. `detail` = the CLI's text (first line, masked) — the merge key of repeats.
 */
export function informationalNotice(msg: { content?: unknown; level?: unknown; prevent_continuation?: unknown; tool_use_id?: unknown }): LongWorkNotice | null {
  const content = typeof msg.content === "string" ? msg.content.trim() : "";
  const detail = content ? redactDetail(content) : "";
  if (msg.prevent_continuation === true) {
    return { code: "hook_blocked", message: detail ? `A hook stopped this turn: ${detail}` : "A hook stopped this turn.", ...(detail ? { detail } : {}) };
  }
  if (!detail) return null;
  // A tool's progress line (`tool_use_id`, updated in place in the terminal) belongs to its tool row, not the chat.
  if (typeof msg.tool_use_id === "string" && msg.tool_use_id) return null;
  if (msg.level === "warning" || msg.level === "suggestion") return { code: "cli_warning", message: detail, detail };
  if (msg.level === "notice") return { code: "cli_notice", message: detail, detail };
  return null;
}

/** `system/hook_response{outcome: "error"}` → `hook_failed` (its name, exit code, stderr's first line); anything else → nothing. */
export function hookFailureNotice(msg: { outcome?: unknown; hook_name?: unknown; hook_event?: unknown; exit_code?: unknown; stderr?: unknown; stdout?: unknown; output?: unknown }): LongWorkNotice | null {
  // MARK: wave4b w4b-check4 — §40.1: a hook that blocked on purpose (exit 2, or a JSON "block" / PreToolUse "deny") is not a failure.
  const blocked = hookBlockNotice(msg);
  if (blocked) return blocked;
  if (msg.outcome !== "error") return null;
  const name = typeof msg.hook_name === "string" && msg.hook_name ? msg.hook_name : typeof msg.hook_event === "string" && msg.hook_event ? msg.hook_event : "hook";
  const words = [msg.stderr, msg.output].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? "";
  const detail = words ? redactDetail(words) : "";
  const exitCode = typeof msg.exit_code === "number" ? msg.exit_code : null;
  return {
    code: "hook_failed",
    message: `The hook ${name} failed${exitCode !== null ? ` (exit ${exitCode})` : ""}${detail ? `: ${firstLineOf(detail)}` : "."}`,
    hookName: name,
    exitCode,
    ...(detail ? { detail } : {}),
  };
}

// MARK: wave4b w4b-check4 — §40.1

/** The reason of a command hook's JSON answer when it blocks: `{"decision": "block", "reason"}` or a PreToolUse deny; else null. */
function jsonBlockReason(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as { decision?: unknown; reason?: unknown; hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } };
    if (o.decision === "block") return typeof o.reason === "string" ? o.reason : "";
    const h = o.hookSpecificOutput;
    if (h && h.permissionDecision === "deny") return typeof h.permissionDecisionReason === "string" ? h.permissionDecisionReason : "";
  } catch {
    // not JSON: a plain line
  }
  return null;
}

/**
 * `system/hook_response` of a hook that blocked on purpose → `hook_blocked` with its name and reason: exit code 2 (Claude
 * Code's blocking exit code; the reason is stderr's first line) or a JSON "block" / PreToolUse "deny" on stdout. Only a
 * command hook (it has an exit code): the app's own in-process hooks never get here. Anything else → null.
 */
function hookBlockNotice(msg: { outcome?: unknown; hook_name?: unknown; hook_event?: unknown; exit_code?: unknown; stderr?: unknown; stdout?: unknown; output?: unknown }): LongWorkNotice | null {
  if (typeof msg.exit_code !== "number" || msg.outcome === "cancelled") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  let why: string | null = null;
  if (msg.exit_code === 2) why = text(msg.stderr).trim() || text(msg.output).trim();
  else if (msg.exit_code === 0 && msg.outcome === "success") why = jsonBlockReason(text(msg.stdout)) ?? jsonBlockReason(text(msg.output));
  if (why === null) return null;
  const name = typeof msg.hook_name === "string" && msg.hook_name ? msg.hook_name : typeof msg.hook_event === "string" && msg.hook_event ? msg.hook_event : "hook";
  const detail = why ? firstLineOf(redactDetail(why)) : "";
  return {
    code: "hook_blocked",
    message: `The hook ${name} blocked this${detail ? `: ${detail}` : "."}`,
    hookName: name,
    exitCode: msg.exit_code,
    ...(detail ? { detail } : {}),
  };
}

/** `result.terminal_reason` values that mean a hook ended the turn (CLI 2.1.30x). */
const HOOK_TERMINAL = new Set(["hook_stopped", "stop_hook_prevented"]);

/** A turn a hook ended without an `informational` message saying why → `hook_blocked` with the generic text. */
export function hookTerminalNotice(terminalReason: unknown): LongWorkNotice | null {
  return typeof terminalReason === "string" && HOOK_TERMINAL.has(terminalReason) ? { code: "hook_blocked", message: "A hook stopped this turn." } : null;
}

/**
 * `rate_limit_event.rate_limit_info` → one window of `state.hud.rateLimits` (null without a usable `rateLimitType`).
 * `utilization` is a percentage (0–100): the CLI's 0–1 fraction is scaled, a value above 1 is taken as a percentage.
 */
export function rateLimitWindowOf(info: unknown, nowMs: number): RateLimitWindow | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown };
  if (typeof i.rateLimitType !== "string" || !i.rateLimitType) return null;
  const status = i.status === "allowed" || i.status === "allowed_warning" || i.status === "rejected" ? i.status : null;
  if (status === null) return null;
  const resetsAt = isoFromEpoch(typeof i.resetsAt === "number" ? i.resetsAt : undefined);
  const u = typeof i.utilization === "number" && Number.isFinite(i.utilization) && i.utilization >= 0 ? i.utilization : undefined;
  const percent = u === undefined ? undefined : Math.min(100, Math.round(u <= 1 ? u * 100 : u));
  return { kind: i.rateLimitType, status, ...(percent !== undefined ? { percent, utilization: u } : {}), ...(resetsAt ? { resetsAt } : {}), at: new Date(nowMs).toISOString() };
}

/**
 * Every window of one `rate_limit_event`: the event's own (`rateLimitType`, its `status`) and, from CLI 2.1.309 on, each
 * entry of `unifiedWindows` (`{five_hour: {utilization: 0.22, resetsAt}, seven_day: {…}}` — the only place the CLI puts the
 * utilization; not in the SDK's type). A window of `unifiedWindows` other than the event's own reads `allowed`.
 */
export function rateLimitWindowsOf(info: unknown, nowMs: number): RateLimitWindow[] {
  const top = rateLimitWindowOf(info, nowMs);
  const out = new Map<string, RateLimitWindow>();
  const unified = info && typeof info === "object" ? (info as { unifiedWindows?: unknown }).unifiedWindows : undefined;
  if (unified && typeof unified === "object") {
    for (const [kind, w] of Object.entries(unified as Record<string, unknown>)) {
      const v = w && typeof w === "object" ? (w as { utilization?: unknown; resetsAt?: unknown }) : {};
      const win = rateLimitWindowOf({ status: top?.kind === kind ? top.status : "allowed", rateLimitType: kind, utilization: v.utilization, resetsAt: v.resetsAt }, nowMs);
      if (win) out.set(kind, win);
    }
  }
  if (top) {
    const u = out.get(top.kind);
    const percent = top.percent ?? u?.percent;
    const utilization = top.utilization ?? u?.utilization;
    const resetsAt = top.resetsAt ?? u?.resetsAt;
    out.set(top.kind, { ...top, ...(percent !== undefined ? { percent } : {}), ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt ? { resetsAt } : {}) });
  }
  return [...out.values()];
}

/** The windows with `w` replacing the one of its kind; windows whose reset passed are dropped. At most 8 kinds. */
export function upsertRateLimit(list: readonly RateLimitWindow[], w: RateLimitWindow, nowMs: number): RateLimitWindow[] {
  const live = list.filter((x) => x.kind !== w.kind && !(x.resetsAt && Date.parse(x.resetsAt) <= nowMs));
  return [...live, w].slice(-8);
}

/**
 * MARK: wave7 w7-state — §45.2: whether `upsertRateLimit(list, w)` changes what the clients are shown — a new kind,
 * another status, use or reset, or another kind's window whose reset passed. Not when it arrived (`at`, shown nowhere)
 * nor the windows' order (every reader looks them up by kind).
 */
export function rateLimitChanges(list: readonly RateLimitWindow[], w: RateLimitWindow, nowMs: number): boolean {
  if (list.some((x) => x.kind !== w.kind && x.resetsAt && Date.parse(x.resetsAt) <= nowMs)) return true;
  const same = list.find((x) => x.kind === w.kind);
  return !same || same.status !== w.status || same.percent !== w.percent || same.utilization !== w.utilization || same.resetsAt !== w.resetsAt;
}

/** The numbers of a budget the instruction text names; 0 = no limit on that count (§54). */
export type BudgetNumbers = { maxFiles: number; maxLines: number };

const limitNumber = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export function budgetNumbers(b: Budget): BudgetNumbers {
  return { maxFiles: limitNumber(b.maxFiles), maxLines: limitNumber(b.maxLines) };
}

/** "at most 10 files and about 400 changed lines": the counts that have a limit. */
function limitWords(b: BudgetNumbers): string {
  const words: string[] = [];
  if (b.maxFiles > 0) words.push(`at most ${b.maxFiles} files`);
  if (b.maxLines > 0) words.push(`about ${b.maxLines} changed lines`);
  return words.join(" and ");
}

/**
 * daily-18: the line put before the next message when the budget differs from the one Claude was last told about (the
 * system prompt the session started with, or an earlier note); null when it is the same. §54: a budget turned on tells
 * Claude its numbers, one turned off tells Claude the limit is gone.
 */
export function budgetChangeNote(told: BudgetNumbers | null, now: Budget): string | null {
  if (told === null) return null;
  const n = budgetNumbers(now);
  if (told.maxFiles === n.maxFiles && told.maxLines === n.maxLines) return null;
  if (n.maxFiles === 0 && n.maxLines === 0) {
    return "[Review gate] The change budget is off: there is no limit on files or changed lines per reply (this replaces the numbers in your instructions).";
  }
  if (told.maxFiles === 0 && told.maxLines === 0) return `[Review gate] The user set a change budget: ${limitWords(n)} per reply.`;
  return `[Review gate] The change budget is now ${limitWords(n)} per reply (this replaces the numbers in your instructions).`;
}
