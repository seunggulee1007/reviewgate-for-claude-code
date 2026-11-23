/**
 * docs/PROTOCOL.md §64 — review first: Claude's next work waits until the user reviewed its last changes. The engine
 * denies the edits; the client's part is the setting (Settings › Review), the quiet row when a call was denied, the
 * terminal strip's chip and — with `prompts` — the composer holding a message until the review is done (the Mac's
 * Core ReviewFirst.swift, with its words).
 */
import type { ReviewFirstState, ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

export type ReviewFirstMode = "edits" | "prompts" | "off";
export const REVIEW_FIRST_MODES: readonly ReviewFirstMode[] = ["edits", "prompts", "off"];

/** The stored setting (absent / unknown: `edits`, the default). */
export function reviewFirstModeOf(v: unknown): ReviewFirstMode {
  return v === "prompts" || v === "off" ? v : "edits";
}

export function reviewFirstModeLabel(m: ReviewFirstMode): string {
  return m === "edits" ? t("Block edits (default)") : m === "prompts" ? t("Block prompts too") : t("Turn off");
}

/** The engine's row when a call was denied (a gray row; no banner, the queue goes on). */
export const REVIEW_FIRST_ROW = "review_first_blocked";

export const reviewFirstBlockedText = (): string => t("Claude's edits are blocked while files wait for your review");
export const reviewFirstBlockedHelp = (): string =>
  t("Claude can answer questions, read and plan, but it may not change files until you accept or reject the files waiting for review. Settings › Review changes this.");
export const openReviewTitle = (): string => t("Open Review");
export const openReviewHelp = (): string => t("Shows the first file waiting for your review");
export const holdTitle = (waiting: number): string => t("Finish the review first — {0} waiting", waiting);
export const holdHelp = (): string =>
  t("Settings › Review is set to hold new messages until you accept or reject the files waiting for review. Your message is kept and goes once nothing waits.");
export const queueHoldText = (): string => t("Waits until you finish the review");
export const acceptAndSendTitle = (pending: number): string => t("Accept {0} & Send", pending);
export const acceptAndSendHelp = (): string => t("Accepts every pending file, then sends the waiting message");

/** `prompts`: a plain message waits while files do (a slash command never: it starts no work on the code). */
export function reviewFirstHolds(gate: { reviewFirst?: ReviewFirstState | null }, text: string): boolean {
  const rule = gate.reviewFirst;
  return !!rule && rule.mode === "prompts" && rule.waiting > 0 && !text.trim().startsWith("/");
}

/** Why [N개 수락 후 보내기] is off (null: it can go). */
export function reviewFirstAcceptBlocker(s: ReviewState): string | null {
  if (s.gate.changesRequestedCount > 0) return t("A file has changes requested — send them with Request changes, or accept or reject it first");
  if (!s.gate.canSend || s.gate.pendingCount === 0) return t("Claude can't take a message right now");
  return null;
}

/** [리뷰 열기]: the first file waiting for the review (null: none waits). */
export function firstWaitingPath(s: Pick<ReviewState, "changedFiles">): string | null {
  return s.changedFiles.find((f) => f.state === "pending" || f.state === "changesRequested")?.path ?? null;
}
