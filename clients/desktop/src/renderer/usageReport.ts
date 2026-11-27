/**
 * docs/PROTOCOL.md §71.1: `/usage` (and the terminal's aliases `/cost`, `/stats`) in a classic chat — the terminal's
 * Session block (cost, API and wall time, code changes, usage by model) and the plan's usage windows with their reset
 * times, in the terminal's shapes. Pure; components/dialogs/UsageDialog.tsx shows it. As the Mac's Core UsageReport.swift.
 */
import type { ModelCost, RateLimitWindow } from "@reviewgate/engine";
import { resetTimeText } from "./errorCodes";
import { t } from "./i18n";

/** "6m 20s", "6h 33m 10s", "45s" (as the terminal's `Total duration`). */
export function usageDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t("{0}h {1}m {2}s", h, m, s);
  if (m > 0) return t("{0}m {1}s", m, s);
  return t("{0}s", s);
}

/** "512", "1.2k", "940.0k", "1.5M" — the terminal's token counts. */
export function usageTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const usageCost = (usd: number): string => `$${usd.toFixed(4)}`;

/** "1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write". */
export function modelTokensLine(m: ModelCost): string {
  return t("{0} input, {1} output, {2} cache read, {3} cache write", usageTokens(m.inputTokens), usageTokens(m.outputTokens), usageTokens(m.cacheReadTokens), usageTokens(m.cacheCreationTokens));
}

/** "3 lines added, 1 line removed". */
export const codeChangesLine = (added: number, removed: number): string => t("{0} lines added, {1} lines removed", added, removed);

/** A plan window's name, as the terminal's bars say it; an unknown kind as sent. */
export function windowTitle(kind: string): string {
  switch (kind) {
    case "five_hour": return t("Current session (5 hours)");
    case "seven_day": return t("Current week (all models)");
    case "seven_day_opus": return t("Current week (Opus)");
    case "seven_day_sonnet": return t("Current week (Sonnet)");
    default: return kind.replace(/_/g, " ");
  }
}

const RANK: Record<string, number> = { five_hour: 0, seven_day: 1, seven_day_opus: 2, seven_day_sonnet: 3 };

/** The windows in the terminal's order: the five-hour one, the week, then the rest by name. */
export function orderedWindows(windows: readonly RateLimitWindow[] | undefined): RateLimitWindow[] {
  return [...(windows ?? [])].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

export const usedText = (percent: number): string => t("{0}% used", percent);

/** "Resets 15:00" (another day with its date); null without a reset time. */
export function resetsText(iso: string | undefined, opts: { now?: Date; timeZone?: string } = {}): string | null {
  const at = iso ? resetTimeText(iso, opts) : null;
  return at ? t("Resets {0}", at) : null;
}

/** The palette's line for `/usage`. */
export const usageDescription = (): string => t("Show the session cost, plan usage limits and the cost by model");
