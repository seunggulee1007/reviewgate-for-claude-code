/**
 * MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 "Chats you can read without switching" (daily-13), as on the Mac
 * (Core AppState+ChatViewing.swift): a click on another chat tab (or ⌘1…9) shows that chat's saved rows read-only —
 * `transcript_page` of that chat (§38.3) — and leaves the running Claude session where it is. Sending from it, or
 * [이 채팅으로 이어가기], switches for real by the old path (`openChat` → `session_open`); the message then goes out by the
 * queue's rules. The review, permission cards and the HUD stay the running chat's.
 */
import { create } from "zustand";
import type { ReviewState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { t } from "./i18n";
import { newChatRefusal, sessionsOf } from "./sessions";
import { holdSwitch, switchWaits } from "./pendingSwitch"; // r2-chats-cards M31 / M33 (§9)
import { chatItemsOfRows, useStore, type ChatItem } from "./store";
import type { QueuedExtras } from "./sendQueue";
import type { ComposerChips } from "./composerBridge";

/** `transcript_page.before` for "the end of the chat" (the engine clamps it to the chat's row count). */
export const CHAT_END = 1_000_000_000;
export const VIEW_PAGE_ROWS = 200;

export type ViewedChat = {
  /** The chat shown. */
  id: string;
  /** The live chat when this view began; once the live chat changes (a switch, a new chat) the view is over. */
  liveId: string | null;
  /** Its rows as chat items, oldest first (empty while loading). */
  items: ChatItem[];
  /** Row index of `items[0]`; > 0: older rows exist. */
  start: number | null;
  oldestAt: string | null;
  loading: boolean;
  error: string | null;
};

export const useViewedChat = create<{ chat: ViewedChat | null }>(() => ({ chat: null }));

/** wave4b integration (§39.2 × §39.3, as Core `revealStaysInViewedChat`): a reveal of `toolUseId` stays in the chat shown
 *  read-only when that call is one of its own rows (a link on its turn summary card, "에이전트별 변경"); any other reveal is
 *  the running chat's and shows it first (`stopViewing`). */
export function revealStaysInViewedChat(viewing: ViewedChat | null, toolUseId: string): boolean {
  return viewing !== null && viewing.items.some((it) => it.kind === "toolUse" && it.toolUseId === toolUseId);
}

// ---------------------------------------------------------------- pure

/** The chat shown read-only, or null while the chat view shows the live chat (as before). */
export function viewingOf(chat: ViewedChat | null, state: ReviewState): ViewedChat | null {
  const current = sessionsOf(state).currentId;
  if (!chat || chat.id === current || chat.liveId !== current) return null;
  return chat;
}

/** A chat's title for these lines ("New chat" when it has none). */
export function chatTitleOf(state: ReviewState, id: string | null): string {
  const title = sessionsOf(state).list.find((m) => m.id === id)?.title.trim() ?? "";
  return title.length > 0 ? title : t("New chat");
}

/**
 * Why a send from a viewed chat cannot go there at all (null: it can — at once, or once the live chat is done): only a
 * failed collection since r2-chats-cards M33 (§9 "Held switches"); a busy live chat or its queue only make it wait
 * (`viewingSendWait`).
 */
export function viewingSendBlocker(state: ReviewState, _queued: boolean): string | null {
  return newChatRefusal(state);
}

/** r2-chats-cards M33 (§9): why a send from a viewed chat waits for the live chat (null: it goes at once). */
export function viewingSendWait(state: ReviewState, queued: boolean): string | null {
  const live = chatTitleOf(state, sessionsOf(state).currentId);
  if (state.session.starting || ["starting", "running", "collecting", "reverting"].includes(state.gate.phase)) return t("Claude is working in '{0}'", live);
  if (queued) return t("Messages are waiting in the queue of '{0}'", live);
  return null;
}

/** The live chat waits for the user (a permission, a question, a plan). */
export function liveChatWaits(state: ReviewState): boolean {
  const s = state.session as Partial<ReviewState["session"]>;
  return Boolean(s.pendingPermission) || (s.pendingPermissions?.length ?? 0) > 0 || Boolean(s.pendingPlan);
}

// ---------------------------------------------------------------- store glue

const current = () => viewingOf(useViewedChat.getState().chat, useStore.getState().state);
const queued = () => useStore.getState().queue.items.length > 0 || useStore.getState().queue.inflight;

/** A chat tab click / ⌘1…9: the live chat → back to it; another → its saved rows, read-only. Nothing switches. */
export async function viewChat(id: string, request: typeof engineRequest = engineRequest): Promise<void> {
  const state = useStore.getState().state;
  const live = sessionsOf(state).currentId;
  if (id === live) {
    useViewedChat.setState({ chat: null });
    return;
  }
  if (current()?.id === id) return;
  useViewedChat.setState({ chat: { id, liveId: live, items: [], start: null, oldestAt: null, loading: true, error: null } });
  await loadRows(id, CHAT_END, null, request);
}

/** Back to the live chat. */
export function stopViewing(): void {
  useViewedChat.setState({ chat: null });
}

/** [이전 대화 더 보기] in a viewed chat. */
export async function loadEarlierInViewedChat(request: typeof engineRequest = engineRequest): Promise<void> {
  const v = current();
  if (!v || v.loading || v.start === null || v.start <= 0) return;
  useViewedChat.setState({ chat: { ...v, loading: true } });
  await loadRows(v.id, v.start, v.oldestAt, request);
}

async function loadRows(id: string, before: number, beforeAt: string | null, request: typeof engineRequest): Promise<void> {
  try {
    const reply = await request({ type: "transcript_page", sessionId: id, before, ...(beforeAt ? { beforeAt } : {}), limit: VIEW_PAGE_ROWS });
    const chat = useViewedChat.getState().chat;
    // Another chat (or the live one) is shown meanwhile: these rows are not its.
    if (!chat || chat.id !== id || reply.sessionId !== id) return;
    const older = chatItemsOfRows(reply.items, useStore.getState().state.budget);
    useViewedChat.setState({
      chat: { ...chat, items: [...older, ...chat.items], start: reply.start, oldestAt: reply.items[0]?.at ?? chat.oldestAt, loading: false, error: null },
    });
  } catch (e) {
    const chat = useViewedChat.getState().chat;
    if (!chat || chat.id !== id) return;
    if (refusalOf(e).code === "unknown_command") {
      // An engine before §38.3 cannot read another chat: the tab switches as it always did.
      useViewedChat.setState({ chat: null });
      await useStore.getState().openChat(id);
      return;
    }
    useViewedChat.setState({ chat: { ...chat, loading: false, error: t("Could not load this chat") } });
  }
}

/**
 * [이 채팅으로 이어가기]: the live session moves to the viewed chat by the old path (`session_open`) — r2-chats-cards M31:
 * while Claude works, once the live chat is done (pendingSwitch.ts).
 */
export async function continueInViewedChat(): Promise<boolean> {
  const v = current();
  const state = useStore.getState().state;
  if (!v || viewingSendBlocker(state, queued()) !== null) return false;
  if (switchWaits(state, queued())) {
    holdSwitch({ kind: "open", id: v.id, messages: [] });
    return true;
  }
  return useStore.getState().openChat(v.id);
}

/** Resolves once `id` is the live chat (the snapshot after the switch), or after `ms`. */
export function untilLive(id: string, ms = 3000): Promise<boolean> {
  if (sessionsOf(useStore.getState().state).currentId === id) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, ms);
    const stop = useStore.subscribe((s) => {
      if (sessionsOf(s.state).currentId !== id) return;
      clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}

/**
 * Send from a viewed chat: switch to it first; the message then goes out by the queue's rules (at once, or as soon as
 * the resumed session takes it). false: nothing was sent — the switch was refused, or it did not show up within `waitMs`
 * (the composer keeps the text; it never joins the old chat's queue). `chips`: the composer's own, given back with the
 * text when a held message will not go out.
 */
export async function sendInViewedChat(text: string, extras: QueuedExtras = {}, waitMs = 3000, chips?: ComposerChips): Promise<boolean> {
  const v = current();
  if (!v || text.trim().length === 0 || viewingSendBlocker(useStore.getState().state, queued()) !== null) return false;
  // r2-chats-cards M33 (§9): Claude works in the live chat — the switch and the message wait until it is done.
  if (switchWaits(useStore.getState().state, queued())) {
    holdSwitch({ kind: "open", id: v.id, messages: [{ text, extras, ...(chips ? { chips } : {}) }] });
    return true;
  }
  if (!(await continueInViewedChat())) return false;
  // The queue stops when the chat changes under it: queue only once the switch has landed.
  if (!(await untilLive(v.id, waitMs))) return false;
  useStore.getState().enqueueMessage(text, false, extras);
  return true;
}

/** Hook: the chat shown read-only (null: the live chat). Subscribes to the live chat's id only, not every snapshot. */
export function useViewing(): ViewedChat | null {
  const chat = useViewedChat((s) => s.chat);
  const currentId = useStore((s) => sessionsOf(s.state).currentId);
  return chat && chat.id !== currentId && chat.liveId === currentId ? chat : null;
}
