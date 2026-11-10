/** Chat sessions (docs/M15-POLISH.md): helpers over `state.sessions` and the per-project UI-preference key. */
import type { ReviewState, SessionsState } from "@reviewgate/engine";
import { t } from "./i18n";

export const EMPTY_SESSIONS: SessionsState = { list: [], currentId: null, openTabIds: [] };

/** Tolerates a snapshot from an engine build without the slice (empty list, no tabs). */
export const sessionsOf = (s: ReviewState): SessionsState => (s as Partial<ReviewState>).sessions ?? EMPTY_SESSIONS;

/**
 * Why the engine would refuse `session_new` / `session_open` right now (null = allowed) — mirrors its
 * `guardSessionSwitch()`: busy, then a failed collection (its retry belongs to this chat). r2-chats-cards M31 (§9): the
 * review never holds a switch — pending files, notes and a change request are worktree state that survives it — and a new
 * chat or a switch asked for while busy waits for the turn (`pendingSwitch.ts`) instead; see `newChatRefusal`.
 */
export function sessionSwitchRefusal(s: ReviewState): string | null {
  if (!s.project) return t("Open a project first (⌘O)");
  if (s.session.starting) return t("Starting session…");
  if (["running", "collecting", "reverting"].includes(s.gate.phase)) return t("Claude is working…");
  if (s.gate.collectError !== null) return t("Retry collecting the changes first");
  return null;
}

/** r2-chats-cards M31 (§9): why [+] / Ctrl+T / 새 채팅 cannot open a chat at all — a failed collection; while Claude works it waits. */
export function newChatRefusal(s: ReviewState): string | null {
  if (!s.project) return t("Open a project first (⌘O)");
  if (s.gate.collectError !== null) return t("Retry collecting the changes first");
  return null;
}

export const sessionTitle = (sessions: SessionsState, id: string): string => sessions.list.find((m) => m.id === id)?.title ?? id.slice(0, 8);

export { projectRootHash } from "../shared/hash";

/**
 * §35.4: the first message sent from a record (a chat Claude Code could not resume, `resumeFailed`) made its new chat —
 * the chat the queue was typed in, so the queue goes on there (another chat becoming current still stops it).
 */
export function adoptsRecord(previous: ReviewState, snapshot: ReviewState): boolean {
  const before = (previous as Partial<ReviewState>).sessions;
  const after = (snapshot as Partial<ReviewState>).sessions;
  if (!before?.currentId || !after?.currentId || after.currentId === before.currentId) return false;
  const record = before.list.find((m) => m.id === before.currentId)?.resumeFailed === true;
  const fresh = !before.list.some((m) => m.id === after.currentId);
  return record && fresh && snapshot.gate.phase === "running";
}
