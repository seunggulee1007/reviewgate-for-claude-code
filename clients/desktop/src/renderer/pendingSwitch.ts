/**
 * r2-chats-cards M31 / M33 — docs/PROTOCOL.md §9 "Held switches", as on the Mac (Core AppState+ChatSwitch.swift): a new
 * chat ([+], Ctrl/⌘T, the banners' "새 채팅") or a switch to a chat shown read-only ([이 채팅으로 이어가기], a message sent
 * from it) asked for while the engine would answer `session_busy` — a start, a turn, its collection, a revert — or while the
 * live chat's queue still holds messages is never refused: it is held here (the last one wins) and goes out once the live
 * chat is done, so turns stay one at a time per worktree and a queued message stays with the chat it was typed in. A
 * message held with a switch then joins that chat's queue. Only a failed collection refuses.
 */
import { create } from "zustand";
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";
import { newChatRefusal, sessionsOf } from "./sessions";
import type { QueuedExtras } from "./sendQueue";
import type { ComposerChips } from "./composerBridge";

/** A message sent from a chat shown read-only, held with the switch there (`chips`: what the composer gives back on ×). */
export type HeldMessage = { text: string; extras?: QueuedExtras; chips?: ComposerChips };

/** `messages`: held for that chat, in order (none: [이 채팅으로 이어가기] only). */
export type PendingSwitch = { kind: "new" } | { kind: "open"; id: string; messages: HeldMessage[] };

export const usePendingSwitch = create<{ pending: PendingSwitch | null; inflight: boolean }>(() => ({ pending: null, inflight: false }));

/** A switch now would wait for the live chat: a start, a turn, its collection or a revert, or messages in its queue. */
export function switchWaits(s: ReviewState, queued: boolean): boolean {
  if (!s.project) return false;
  return s.session.starting || ["starting", "running", "collecting", "reverting"].includes(s.gate.phase) || queued;
}

function titleOf(s: ReviewState, id: string | null): string {
  const title = sessionsOf(s).list.find((m) => m.id === id)?.title.trim() ?? "";
  return title.length > 0 ? title : t("New chat");
}

/** What a held switch waits for, in one line (the chip's tooltip, the viewing bar). */
export function pendingSwitchText(s: ReviewState, pending: PendingSwitch | null): string | null {
  if (!pending) return null;
  const live = titleOf(s, sessionsOf(s).currentId);
  if (pending.kind === "new") return t("A new chat opens once Claude is done in '{0}'", live);
  const target = titleOf(s, pending.id);
  return pending.messages.length === 0
    ? t("Continues in '{0}' once Claude is done in '{1}'", target, live)
    : t("Your message goes to '{0}' once Claude is done in '{1}'", target, live);
}

/** The chip's short label ("새 채팅 대기 중", "대기: <제목>"). */
export function pendingSwitchLabel(s: ReviewState, pending: PendingSwitch): string {
  return pending.kind === "new" ? t("New chat waits") : t("Waits: {0}", titleOf(s, pending.id));
}

/** Where a held message goes back to when it will not go out (the composer takes its text and chips). */
let handBack: (text: string, chips?: ComposerChips) => void = () => {};
export function onHeldMessageBack(fn: (text: string, chips?: ComposerChips) => void): void {
  handBack = fn;
}

/** Held messages that will not go out go back to the composer, whole and in order — nothing of them is lost. */
function giveBack(messages: HeldMessage[]): void {
  for (const m of messages) handBack(m.text, m.chips);
}

/**
 * Holds `p` (the last one wins). Nothing held is lost: another message from the same chat, or its [이 채팅으로 이어가기],
 * keeps the ones held for it (in order); a switch elsewhere gives them back to the composer.
 */
export function holdSwitch(p: PendingSwitch): void {
  const before = usePendingSwitch.getState().pending;
  if (before?.kind === "open" && before.messages.length > 0) {
    if (p.kind === "open" && p.id === before.id) {
      usePendingSwitch.setState({ pending: { ...p, messages: [...before.messages, ...p.messages] } });
      return;
    }
    giveBack(before.messages);
  }
  usePendingSwitch.setState({ pending: p });
}

/** The held switch is called off; the messages held with it go back to the composer. */
export function cancelPendingSwitch(): void {
  const before = usePendingSwitch.getState().pending;
  usePendingSwitch.setState({ pending: null });
  if (before?.kind === "open") giveBack(before.messages);
}

export type SwitchDeps = {
  state(): ReviewState;
  queued(): boolean;
  newChat(): Promise<boolean>;
  openChat(id: string): Promise<boolean>;
  /** Resolves once `id` is the live chat (the snapshot after the switch). */
  untilLive(id: string): Promise<boolean>;
  enqueue(text: string, extras: QueuedExtras | undefined): void;
  fail(message: string): void;
};

/**
 * After every snapshot: the held switch goes out once the live chat is done — or is dropped, with its reason, when the
 * engine would refuse it for good (a failed collection, the chat it goes to is gone). Pure apart from `deps`.
 */
export async function drainPendingSwitch(deps: SwitchDeps): Promise<void> {
  const { pending, inflight } = usePendingSwitch.getState();
  const s = deps.state();
  if (!pending || inflight || !s.project || switchWaits(s, deps.queued())) return;
  const refusal = newChatRefusal(s);
  if (refusal !== null) {
    cancelPendingSwitch();
    deps.fail(refusal);
    return;
  }
  const sessions = sessionsOf(s);
  if (pending.kind === "open" && (pending.id === sessions.currentId || !sessions.list.some((m) => m.id === pending.id))) {
    usePendingSwitch.setState({ pending: null });
    // Already there (or the chat went): the messages go out here only when this is their chat.
    if (pending.id === sessions.currentId) for (const m of pending.messages) deps.enqueue(m.text, m.extras);
    else giveBack(pending.messages);
    return;
  }
  usePendingSwitch.setState({ pending: null, inflight: true });
  try {
    if (pending.kind === "new") {
      await deps.newChat();
      return;
    }
    const switched = (await deps.openChat(pending.id)) && (await deps.untilLive(pending.id));
    if (switched) for (const m of pending.messages) deps.enqueue(m.text, m.extras);
    else giveBack(pending.messages);
  } finally {
    usePendingSwitch.setState({ inflight: false });
  }
}
