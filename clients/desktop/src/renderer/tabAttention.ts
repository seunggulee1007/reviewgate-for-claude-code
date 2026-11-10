/**
 * Audit daily-03: while the user is on another sidebar tab (PRs, History), the Changes tab still says what Claude is
 * doing — a status dot (working, waiting for you, files to review) — and the PRs tab gets a thin "Claude가 확인을
 * 기다려요 — 돌아가기" bar when Claude is blocked on the user. Pure, unit-tested.
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";
import { visiblePeerInbox } from "./peer";

export type WaitingReason = "permission" | "question" | "plan" | "peer";

export type ChangesStatus =
  /** Claude is blocked on the user (a card, a question, a plan, a held peer message). */
  | { kind: "waiting"; reason: WaitingReason }
  /** A turn (ours or another session's) is running. */
  | { kind: "running" }
  /** The turn ended with files to review. */
  | { kind: "review"; count: number }
  | null;

/** What the Changes tab would show right now (null: nothing worth a dot). */
export function changesStatus(s: Pick<ReviewState, "session" | "gate">): ChangesStatus {
  const perms = s.session.pendingPermissions ?? (s.session.pendingPermission ? [s.session.pendingPermission] : []);
  if (perms.some((p) => p.toolName === "AskUserQuestion")) return { kind: "waiting", reason: "question" };
  if (perms.length > 0) return { kind: "waiting", reason: "permission" };
  if (s.session.pendingPlan) return { kind: "waiting", reason: "plan" };
  // r2-peers: `auto` runs a message from a live session of the user's by itself; one the registry does not vouch for waits.
  const held = visiblePeerInbox(s.session).filter((m) => m.state === "held");
  if (held.length > 0 && (s.session.peerInbound !== "auto" || held.some((m) => !m.sender))) return { kind: "waiting", reason: "peer" };
  if (s.gate.phase === "running" || s.gate.phase === "collecting" || s.session.externalTurn) return { kind: "running" };
  if (s.gate.pendingCount > 0) return { kind: "review", count: s.gate.pendingCount };
  return null;
}

/** The dot's tooltip / accessible label. */
export function changesStatusLabel(st: Exclude<ChangesStatus, null>): string {
  switch (st.kind) {
    case "waiting":
      return waitingText(st.reason);
    case "running":
      return t("Claude is working…");
    case "review":
      return t("{0} file(s) awaiting review", st.count);
  }
}

/** The bar's sentence: what Claude waits for. */
export function waitingText(reason: WaitingReason): string {
  switch (reason) {
    case "permission":
      return t("Claude is waiting for your permission");
    case "question":
      return t("Claude is waiting for your answer");
    case "plan":
      return t("Claude is waiting for you to approve the plan");
    case "peer":
      return t("A message from another session is waiting for you");
  }
}
