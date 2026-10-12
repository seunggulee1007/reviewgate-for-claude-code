/** Chat sessions (docs/M15-POLISH.md): helpers over `state.sessions` and the per-project UI-preference key. */
import type { ReviewState, SessionsState } from "@reviewgate/engine";
import { t } from "./i18n";

export const EMPTY_SESSIONS: SessionsState = { list: [], currentId: null, openTabIds: [] };

/** Tolerates a snapshot from an engine build without the slice (empty list, no tabs). */
export const sessionsOf = (s: ReviewState): SessionsState => (s as Partial<ReviewState>).sessions ?? EMPTY_SESSIONS;

/**
 * Why the engine would refuse `session_new` / `session_open` right now (null = allowed) — mirrors its
 * `guardSessionSwitch()`: busy, then the cases where the review belongs to *this* chat (a failed
 * collection, a change request in flight, unsent notes). Plainly pending files do not block — the
 * review is worktree state that survives the switch.
 */
export function sessionSwitchRefusal(s: ReviewState): string | null {
  if (!s.project) return t("Open a project first (⌘O)");
  if (s.session.starting) return t("Starting session…");
  if (["running", "collecting", "reverting"].includes(s.gate.phase)) return t("Claude is working…");
  if (s.gate.collectError !== null) return t("Retry collecting the changes first");
  if (s.changedFiles.some((f) => f.state === "changesRequested")) return t("Review pending files first");
  // wave2 desktop-flow — §34.4: only notes not sent yet hold the chat (the engine's `notes_pending` counts those).
  if (s.reviewNotes.some((n) => !n.sent)) return t("Send or delete your review notes first");
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
