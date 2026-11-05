/**
 * MARK: wave4b w4b-follow — docs/PROTOCOL.md §39.4 in Electron (as the Mac's AppState+ChatMove.swift, same i18n keys): the
 * chat follows Claude into another worktree of the repository. The main process opens / fronts the target's window on
 * `chat_moved` (src/main/chatMove.ts); this module holds the words, the decisions and the requests.
 */
import { create } from "zustand";
import type { ChatMoveRef, PermissionRequest, ReviewState, SessionMeta } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { t } from "./i18n";

/** The last folder name of a path (`/w/acme-4176-17` → `acme-4176-17`; Windows separators too). */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The message sent once in the target after a stopped turn (a normal send there). */
export const followUpText = (name: string) => t("The working folder moved to {0}. Please continue what you were doing.", name);

/** A move now stops a running turn (or an open card / question / plan, or a start): the window asks first. */
export function chatMoveNeedsStop(s: ReviewState): boolean {
  const session = s.session;
  const waits = (session.pendingPermissions?.length ?? 0) > 0 || session.pendingPermission != null || session.pendingPlan != null;
  return s.gate.phase === "running" || s.gate.phase === "collecting" || waits || session.starting;
}

/** The current chat was handed to another worktree (a record here). */
export function movedChat(s: ReviewState): ChatMoveRef | null {
  const ss = (s as { sessions?: { list: SessionMeta[]; currentId: string | null } }).sessions;
  if (!ss) return null;
  return movedChatOf(s, ss.currentId);
}

/**
 * wave4b integration (§39.4 × §39.2, as Core `shownChatMovedTo`): chat `id` was handed to another worktree. The bar above
 * the composer asks it of the chat on screen — the one shown read-only (`useViewing`), else the current one.
 */
export function movedChatOf(s: ReviewState, id: string | null | undefined): ChatMoveRef | null {
  const ss = (s as { sessions?: { list: SessionMeta[] } }).sessions;
  if (!ss || !id) return null;
  return ss.list.find((m) => m.id === id)?.movedTo ?? null;
}

/** A card that can follow: a worktree-creating command whose target the engine named. */
export function canFollow(req: PermissionRequest): boolean {
  return req.reason?.code === "worktree_command" && typeof req.reason.path === "string" && req.reason.path.length > 0 && typeof req.toolUseId === "string";
}

/** One line on why a move was refused (the engine's code). */
export function moveRefusalText(code: string): string {
  switch (code) {
    case "session_busy":
      return t("Claude is still working. Try again once the turn has ended.");
    case "not_a_worktree":
      return t("That folder is not a worktree of this repository.");
    case "same_worktree":
      return t("This chat already works in that folder.");
    case "path_not_found":
      return t("That folder does not exist.");
    case "notes_pending":
      return t("Send or remove the review notes first: they belong to this chat.");
    case "review_pending":
      return t("Changes are being requested in this chat. Finish that round first.");
    case "collect_failed":
      return t("Collecting this turn's changes failed. Retry it first.");
    case "chat_is_record":
      return t("This chat is read-only here, so it cannot be moved.");
    case "cli_still_running":
      return t("Claude Code did not stop in time, so the chat stays here. Try again.");
    case "nothing_to_receive":
      return t("No chat is waiting for this window.");
    default:
      return t("The chat could not be moved ({0}).", code);
  }
}

/** The §39.4 notices (`error` codes) in the user's words; null for any other code. */
export function chatMoveNoticeText(code: string | undefined, path: string | undefined, detail?: string): string | null {
  switch (code) {
    case "chat_moved_in":
      return t("This chat moved here from {0}. It is reviewed from here on, with what it changed here before the move.", path ?? "");
    case "chat_moved_in_disk":
      return t("This chat moved here from {0}. It is reviewed from here on; changes made here before the move are not in the review.", path ?? "");
    case "chat_move_failed": {
      const line = t("This chat could not move to {0}, so it stays here.", path ? folderName(path) : "");
      // Why, in words (the engine's code stays the row's second line).
      return detail ? `${line} ${moveRefusalText(detail)}` : line;
    }
    default:
      return null;
  }
}

/** Why the last move was refused (shown above the composer until dismissed or the next move). */
export const useChatMoveNotice = create<{ text: string | null; set: (text: string | null) => void }>((set) => ({
  text: null,
  set: (text) => set({ text }),
}));

/**
 * `chat_receive` (the main process asks when another window handed its chat to this worktree): this window takes it. A
 * refusal (e.g. unsent review notes here) is said above the composer; the chat waits and comes in on the next open.
 */
export async function receiveMovedChat(): Promise<void> {
  try {
    await engineRequest({ type: "chat_receive" });
  } catch (e) {
    const code = refusalOf(e).code;
    if (code !== "nothing_to_receive") useChatMoveNotice.getState().set(moveRefusalText(code));
  }
}

/** `chat_move`: null on success, else the refusal in one line (also kept in `useChatMoveNotice`). */
export async function moveChat(path: string, stop: boolean, continueThere: boolean): Promise<string | null> {
  const followUp = stop && continueThere ? followUpText(folderName(path)) : undefined;
  try {
    await engineRequest({ type: "chat_move", path, ...(stop ? { interrupt: true } : {}), ...(followUp ? { followUp } : {}) });
    useChatMoveNotice.getState().set(null);
    return null;
  } catch (e) {
    const text = moveRefusalText(refusalOf(e).code);
    useChatMoveNotice.getState().set(text);
    return text;
  }
}
