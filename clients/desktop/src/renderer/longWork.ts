/**
 * MARK: wave4 w4-longwork
 * docs/PROTOCOL.md §38.2 in Electron (as on the Mac, LongWork.swift) — pure, unit-tested: the words of the tool-call limit's
 * notice and the hook / CLI notices, which of them stay chat rows only, "풀리면 이어서 하기" (when to send, wait or give up),
 * the HUD's usage limit and the five-hour / weekly use.
 */
import type { RateLimitWindow } from "@reviewgate/engine";
import { t } from "./i18n";

/** The §38.2 notice codes (never a red failure, never a stopped queue). */
export const LONG_WORK_CODES: ReadonlySet<string> = new Set(["max_turns", "hook_failed", "hook_blocked", "cli_warning", "cli_notice"]);

/** The notices that stay chat rows only (no banner); `max_turns` keeps its banner with [이어서 계속]. */
export const ROW_ONLY_CODES: ReadonlySet<string> = new Set(["hook_failed", "hook_blocked", "cli_warning", "cli_notice"]);

/** Row-only notices drawn orange (the CLI's gray `cli_notice` is the info tone). */
export function isWarningRow(code: string | undefined): boolean {
  return code === "hook_failed" || code === "hook_blocked" || code === "cli_warning";
}

/** Rows whose second line would repeat the row: the CLI's own words are the row. */
export function hidesSubline(code: string | undefined): boolean {
  return code === "cli_warning" || code === "cli_notice";
}

/** The row / banner text of a §38.2 code; null for any other code (errorCodes.ts falls back to its own). */
export function longWorkErrorText(ev: { code?: string; message: string; detail?: string; maxTurns?: number; hookName?: string }): string | null {
  switch (ev.code) {
    case "max_turns":
      return typeof ev.maxTurns === "number" && ev.maxTurns > 0 ? t("Claude stopped at the tool-call limit ({0} calls)", ev.maxTurns) : t("Claude stopped at the tool-call limit");
    case "hook_failed": {
      const name = (ev.hookName ?? "").trim();
      return name ? t("A hook failed: {0}", name) : t("A hook failed");
    }
    case "hook_blocked": {
      // MARK: wave4b w4b-check4 — §40.1: a hook that blocked on purpose says which one and why (an older engine: no name).
      const name = (ev.hookName ?? "").trim();
      const why = (ev.detail ?? "").trim();
      if (name) return why ? t("Blocked by a hook: {0} — {1}", name, why) : t("Blocked by a hook: {0}", name);
      return t("A hook stopped this turn");
    }
    case "cli_warning":
    case "cli_notice": {
      const words = (ev.detail ?? ev.message).trim();
      return words || ev.message;
    }
    default:
      return null;
  }
}

/** The §38.2 facts a restored `kind: "error"` row keeps (`maxTurns`, `hookName`). */
export function longWorkRowFacts(item: object): { maxTurns?: number; hookName?: string } {
  const r = item as { maxTurns?: unknown; hookName?: unknown };
  return {
    ...(typeof r.maxTurns === "number" ? { maxTurns: r.maxTurns } : {}),
    ...(typeof r.hookName === "string" && r.hookName ? { hookName: r.hookName } : {}),
  };
}

/** What [이어서 계속] / "풀리면 이어서 하기" send to Claude. */
export const continueMessage = (): string => t("Please continue.");

// ---------------------------------------------------------------- usage limit

/** The send waits this long after the reset. */
export const RESUME_DELAY_MS = 60_000;

export type LimitResumeState = {
  /** When the last `usage_limit` lifts (epoch ms); null = unknown. */
  limitResetAt: number | null;
  armed: boolean;
  /** The session was idle once since it was armed: a turn that starts after that disarms it. */
  idleSinceArmed: boolean;
  /** MARK: wave4b w4b-check4 — §40.1: the chat it was armed in (`state.sessions.currentId`); another chat disarms it. */
  chatId?: string | null;
};

/** MARK: wave4b w4b-check4 — §40.1: the window shows another chat than the one the resume was armed in; armed without one: never. */
export function leftChat(armed: string | null | undefined, current: string | null | undefined): boolean {
  if (armed === null || armed === undefined) return false;
  return current !== armed;
}

export const NO_LIMIT_RESUME: LimitResumeState = { limitResetAt: null, armed: false, idleSinceArmed: false };

export type LimitResumeStep = "wait" | "fire" | "cancel";

/** `running`: a turn runs now; `idle`: a message can go out now. */
export function limitResumeStep(s: LimitResumeState, o: { running: boolean; idle: boolean; now: number }): LimitResumeStep {
  if (!s.armed) return "wait";
  if (o.running) return s.idleSinceArmed ? "cancel" : "wait";
  if (s.limitResetAt === null) return "cancel";
  return o.idle && o.now >= s.limitResetAt + RESUME_DELAY_MS ? "fire" : "wait";
}

const resetMs = (w: RateLimitWindow): number | null => {
  if (!w.resetsAt) return null;
  const ms = Date.parse(w.resetsAt);
  return Number.isFinite(ms) ? ms : null;
};

/** The reset of the limit in force (the latest of the rejected windows' and the last `usage_limit`'s, in the future); null = none. */
export function activeLimitReset(windows: readonly RateLimitWindow[] | undefined, lastResetAt: number | null, now: number): number | null {
  const dates = (windows ?? []).filter((w) => w.status === "rejected").map(resetMs).filter((d): d is number => d !== null);
  if (lastResetAt !== null) dates.push(lastResetAt);
  const future = dates.filter((d) => d > now);
  return future.length > 0 ? Math.max(...future) : null;
}

/** A usage limit is in force: a known future reset, or a rejected window without one. */
export function isUsageLimited(windows: readonly RateLimitWindow[] | undefined, lastResetAt: number | null, now: number): boolean {
  if (activeLimitReset(windows, lastResetAt, now) !== null) return true;
  return (windows ?? []).some((w) => w.status === "rejected" && resetMs(w) === null);
}

export const USAGE_WARN_PERCENT = 80;

export function fiveHourPercent(windows: readonly RateLimitWindow[] | undefined): number | undefined {
  return (windows ?? []).find((w) => w.kind === "five_hour")?.percent;
}

/** `seven_day`, else the highest of the other weekly windows. */
export function weeklyPercent(windows: readonly RateLimitWindow[] | undefined): number | undefined {
  const list = windows ?? [];
  const week = list.find((w) => w.kind === "seven_day")?.percent;
  if (week !== undefined) return week;
  const others = list.filter((w) => w.kind.startsWith("seven_day") && typeof w.percent === "number").map((w) => w.percent!);
  return others.length > 0 ? Math.max(...others) : undefined;
}

/** "5시간 72% · 주간 41%" and whether either is at 80 % or more; null when the CLI reported no use. */
export function usageMeter(windows: readonly RateLimitWindow[] | undefined): { text: string; high: boolean } | null {
  const five = fiveHourPercent(windows);
  const week = weeklyPercent(windows);
  const parts = [five !== undefined ? t("5h {0}", `${five}%`) : null, week !== undefined ? t("Week {0}", `${week}%`) : null].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return { text: parts.join(" · "), high: (five ?? 0) >= USAGE_WARN_PERCENT || (week ?? 0) >= USAGE_WARN_PERCENT };
}

/** The HUD chip while the limit is on: "사용량 한도 — 오후 3:00에 풀려요" (+ "· 풀리면 이어서 해요" when armed). */
export function limitChipText(resetTime: string | null, armed: boolean): string {
  const base = resetTime ? t("Usage limit — resets at {0}", resetTime) : t("Usage limit");
  return armed ? `${base} · ${t("continues after")}` : base;
}

// ---------------------------------------------------------------- settings

export const DEFAULT_MAX_TURNS = 200;
export const MIN_MAX_TURNS = 10;
export const MAX_MAX_TURNS = 1000;

/** A stored value → the number of the tool-call limit Settings shows: a whole number in 10–1000, else 200 (main sends it only while the limit is on, §38.2). */
export function maxTurnsOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(v)));
}
