/**
 * docs/PROTOCOL.md §64 — review first: Claude's next work waits until the user reviewed its last changes. The engine
 * denies the edits; the client's part is the setting (Settings › Review), the quiet row when a call was denied (with
 * [이번 턴만 허용]), the terminal strip's chip and — with `prompts` — the composer holding a message until the review is
 * done (the Mac's Core ReviewFirst.swift, with its words).
 */
import type { ReviewFirstState, ReviewState } from "@reviewgate/engine";
import type { RGBridge } from "../shared/ipc";
import { engineRequest, refusalOf } from "./engineRequest";
import { t } from "./i18n";

export type ReviewFirstMode = "edits" | "prompts" | "off";
export const REVIEW_FIRST_MODES: readonly ReviewFirstMode[] = ["edits", "prompts", "off"];

/** The stored setting (absent / unknown: `edits`, the default). */
export function reviewFirstModeOf(v: unknown): ReviewFirstMode {
  return v === "prompts" || v === "off" ? v : "edits";
}

export function reviewFirstModeLabel(m: ReviewFirstMode): string {
  return m === "edits" ? t("Only files under review (default)") : m === "prompts" ? t("Block prompts too") : t("Turn off");
}

/** The engine's row when a call was denied (a gray row; no banner, the queue goes on). */
export const REVIEW_FIRST_ROW = "review_first_blocked";

export const reviewFirstBlockedText = (): string => t("Claude's edits are blocked while files wait for your review");
/** The chip's tooltip — what the rule lets through in `mode` (absent: the default). */
export const reviewFirstBlockedHelp = (mode?: ReviewFirstMode): string =>
  mode === "prompts"
    ? t("Claude can answer questions, read and plan, but it may not change files until you accept or reject the files waiting for review. Settings › Review changes this.")
    : t("While files wait for your review, Claude may fix them but not change other files. Accept or reject them, allow this turn, or change this in Settings › Review.");
export const allowTurnTitle = (): string => t("Allow for this turn");
export const allowTurnHelp = (): string => t("Lets Claude change any file until this turn ends — the next turn waits for the review again");
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

/** Why [이번 턴만 허용] is off (null: it can go). */
export function reviewFirstAllowTurnBlocker(s: { gate: Pick<ReviewState["gate"], "phase"> & { reviewFirst?: ReviewFirstState | null } }): string | null {
  if (s.gate.reviewFirst?.allowedThisTurn) return t("This turn is already allowed");
  if (s.gate.phase !== "running") return t("Claude isn't working on a turn right now");
  return null;
}

/**
 * [이번 턴만 허용]: `review_first_allow_turn` — the rule lets Claude through until the running turn ends. The refusal to
 * show, or null (done, or `no_turn`: the turn ended meanwhile — nothing to say).
 */
export async function allowReviewFirstTurn(bridge?: Pick<RGBridge, "request"> & Partial<Pick<RGBridge, "requestDetailed">>): Promise<string | null> {
  try {
    await engineRequest({ type: "review_first_allow_turn" }, bridge);
    return null;
  } catch (e) {
    const r = refusalOf(e);
    return r.code === "no_turn" ? null : r.error;
  }
}

/** [리뷰 열기]: the first file waiting for the review (null: none waits). */
export function firstWaitingPath(s: Pick<ReviewState, "changedFiles">): string | null {
  return s.changedFiles.find((f) => f.state === "pending" || f.state === "changesRequested")?.path ?? null;
}
