/**
 * §57.5 / §57.17 (plan §4.2): the live terminal chat's PTY as the renderer sees it. Main owns the PTY (it asks the engine
 * for `terminal_spec`, spawns `claude`, reports start and exit, ends it when the chat stops being the live one); this
 * side opens it when a terminal chat becomes the live chat, shows why it could not start, restarts it, and raises the
 * TUI's waits (a permission prompt, a question) as attention — once per wait.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { ReviewState, SessionKind, TerminalWaiting } from "@reviewgate/engine";
import type { PtyOpenResult } from "../../shared/ipc";
import { t } from "../i18n";
import { sessionsOf } from "../sessions";
import { lastComponent, useStore } from "../store";
import { measureCellWidth } from "../terminalLayout";
import { terminalStartRefusal } from "../terminalStrip";
import { adoptTerminal, chatTerminalOf, disposeTerminal, estimateSize, focusTerminal, hasTerminal, markRestarted, subscribeTerminals, terminalConfig, terminalStatus } from "./termHost";
import { TERMINAL_FONT_FAMILY } from "./termHostOptions";
import { reviewPanelCollapsed } from "../friction";
import { pastedText, pasteRefusal } from "../terminalPaste";
import { showToast } from "../toast";
import { insertIntoComposer } from "../composerBridge";
import { acceptsPaste, pasteIntoTerminal, sendToTerminal } from "./termHost";
import { useViewedChat, viewingOf } from "../viewedChat";

/** One terminal chat's PTY: its id once open, a start on its way, or why it could not start. */
export type ChatPty = { ptyId: string | null; opening: boolean; failed: string | null; startedAt: number };

export const useTerminalChats = create<{ bySession: Record<string, ChatPty> }>(() => ({ bySession: {} }));

const EMPTY: ChatPty = { ptyId: null, opening: false, failed: null, startedAt: 0 };

export function chatPtyOf(sessionId: string | null | undefined): ChatPty {
  return (sessionId && useTerminalChats.getState().bySession[sessionId]) || EMPTY;
}

function setChat(sessionId: string, patch: Partial<ChatPty>): void {
  useTerminalChats.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: { ...(s.bySession[sessionId] ?? EMPTY), ...patch } } }));
}

// ---------------------------------------------------------------- pure

/** What chat `id` runs ("chat" for an unknown id). */
export function chatKindOf(state: ReviewState, id: string | null | undefined): SessionKind {
  if (!id) return "chat";
  return sessionsOf(state).list.find((m) => m.id === id)?.kind ?? "chat";
}

/** The live chat when it is a terminal chat. */
export function liveTerminalChatId(state: ReviewState): string | null {
  const id = sessionsOf(state).currentId;
  return id && chatKindOf(state, id) === "terminal" ? id : null;
}

/** The chat on screen (the live one, or one shown read-only) is a terminal chat: the window lays out terminal-first. */
export function shownChatIsTerminal(state: ReviewState, viewingId: string | null | undefined): boolean {
  return chatKindOf(state, viewingId ?? sessionsOf(state).currentId) === "terminal";
}

/** Claude Code waits in the live terminal chat's TUI. */
export function terminalWaitingOf(state: ReviewState): TerminalWaiting | null {
  return liveTerminalChatId(state) ? (state.session.terminal?.waiting ?? null) : null;
}

/** The attention a wait raises (the Mac's `AttentionEvent.terminalWaiting`): its kind, headline and the key that makes it once per wait. */
export function terminalWaitingAttention(waiting: TerminalWaiting, chatId: string): { kind: "permission" | "question"; headline: string; body: string; key: string } {
  const headline = waiting.kind === "permission" ? t("Permission needed in the terminal") : t("Claude asked a question in the terminal");
  const message = waiting.message.trim();
  const clipped = message.length > 160 ? `${message.slice(0, 159)}…` : message;
  return { kind: waiting.kind, headline, body: clipped ? `${headline} — ${clipped}` : headline, key: `term:${chatId}:${waiting.since}` };
}

// ---------------------------------------------------------------- PTY

function cellWidth(): number {
  return measureCellWidth(`${terminalConfig().fontSize}px ${TERMINAL_FONT_FAMILY}`);
}

function refusalText(r: Extract<PtyOpenResult, { ok: false }>): string {
  return terminalStartRefusal(r.code, r.error) ?? (r.error || r.code);
}

/** Opens the live terminal chat's PTY (main answers with the running one when it has it — a remount, a reload). */
export async function openChatPty(sessionId: string): Promise<void> {
  const pty = window.rg?.pty;
  const cur = chatPtyOf(sessionId);
  if (!pty || cur.opening) return;
  setChat(sessionId, { opening: true, failed: null });
  try {
    // After a reload main still runs it: take its screen back first (the replay), then the open is a no-op.
    const known = (await pty.list().catch(() => [])).find((p) => p.kind === "chat" && p.sessionId === sessionId && p.running);
    if (known && !hasTerminal(known.ptyId)) {
      const a = await pty.attach(known.ptyId).catch(() => null);
      if (a) adoptTerminal(known.ptyId, "chat", { sessionId, replay: a.replay, status: { running: a.running, exit: a.exit } });
    }
    const size = estimateSize(document.querySelector<HTMLElement>(".terminal-chat .terminal-body") ?? document.querySelector<HTMLElement>(".pane.chat"), cellWidth());
    const r = await pty.open({ kind: "chat", sessionId, ...size });
    if (!r.ok) {
      setChat(sessionId, { opening: false, failed: refusalText(r) });
      return;
    }
    const before = chatPtyOf(sessionId).ptyId;
    if (before && before !== r.ptyId) disposeTerminal(before);
    adoptTerminal(r.ptyId, "chat", { sessionId });
    setChat(sessionId, { ptyId: r.ptyId, opening: false, failed: null, startedAt: Date.now() });
  } catch (e) {
    setChat(sessionId, { opening: false, failed: terminalStartRefusal("spawn_failed", e instanceof Error ? e.message : String(e)) });
  }
}

/** Restart / Try Again: the PTY ends, the engine hears it, a fresh spec (a new hook token, `--resume`) starts it again. */
export async function restartChatPty(sessionId: string): Promise<void> {
  const pty = window.rg?.pty;
  const cur = chatPtyOf(sessionId);
  if (!pty || cur.opening) return;
  if (!cur.ptyId) return openChatPty(sessionId);
  setChat(sessionId, { opening: true, failed: null });
  try {
    const r = await pty.restart(cur.ptyId);
    if (!r.ok) {
      setChat(sessionId, { opening: false, failed: refusalText(r) });
      return;
    }
    if (r.ptyId !== cur.ptyId) {
      disposeTerminal(cur.ptyId);
      adoptTerminal(r.ptyId, "chat", { sessionId });
    } else {
      markRestarted(r.ptyId);
    }
    setChat(sessionId, { ptyId: r.ptyId, opening: false, failed: null, startedAt: Date.now() });
    focusTerminal(r.ptyId);
  } catch (e) {
    setChat(sessionId, { opening: false, failed: terminalStartRefusal("spawn_failed", e instanceof Error ? e.message : String(e)) });
  }
}

/** The live terminal chat's terminal takes the keyboard (a notification click, the chat shown again). */
export function focusLiveTerminal(): boolean {
  const id = liveTerminalChatId(useStore.getState().state);
  return id ? focusTerminal(chatPtyOf(id).ptyId ?? chatTerminalOf(id)) : false;
}

/** Whether the review panel / diff pane is collapsed on screen now (⌘⇧D toggles what the user sees). */
export function diffCollapsedNow(): boolean {
  const s = useStore.getState();
  const viewing = viewingOf(useViewedChat.getState().chat, s.state);
  return reviewPanelCollapsed(s.state, s.ui, s.selectedPath, shownChatIsTerminal(s.state, viewing?.id));
}

/**
 * §57.7 "Paste into the terminal" (an explicit click only): `text` goes into the live terminal chat's Claude Code as one
 * bracketed paste — never an Enter — and its terminal takes the keyboard. Returns why it could not (null: pasted).
 */
export function pasteIntoLiveTerminal(text: string): string | null {
  const s = useStore.getState();
  const live = liveTerminalChatId(s.state);
  const shown = live !== null && viewingOf(useViewedChat.getState().chat, s.state) === null;
  const ptyId = live ? (chatPtyOf(live).ptyId ?? chatTerminalOf(live)) : null;
  const why = pasteRefusal({ liveTerminalChat: shown, running: terminalStatus(ptyId).running, bracketed: acceptsPaste(ptyId) }, text);
  if (why !== null || !pasteIntoTerminal(ptyId, text)) return why ?? pasteRefusal({ liveTerminalChat: true, running: true, bracketed: false }, text);
  focusTerminal(ptyId);
  // From the PRs tab the terminal is not on screen yet: the keyboard goes to it once it is.
  setTimeout(() => focusTerminal(ptyId), 300);
  return null;
}

/** The paste with its toast — "Pasted … press Enter there", or why not. True when it was pasted. */
export function pasteWithToast(text: string): boolean {
  const why = pasteIntoLiveTerminal(text);
  showToast(why ?? pastedText());
  return why === null;
}

/**
 * A draft a flow hands to "the chat" (PR comments' Send to Claude, from this window or another): the composer of a chat,
 * or — the live chat being a terminal chat — a paste into its Claude Code (this click is the explicit one).
 */
export function draftToLiveChat(text: string): void {
  if (liveTerminalChatId(useStore.getState().state)) pasteWithToast(text);
  else insertIntoComposer(text);
}

/** Stop (Ctrl+.) in a terminal chat: Esc to its Claude Code, as pressing Esc in the TUI does. False: not a running terminal chat. */
export function stopLiveTerminal(): boolean {
  const ptyId = liveTerminalPty();
  if (!ptyId) return false;
  sendToTerminal(ptyId, "\x1b");
  return true;
}

/** The live terminal chat's PTY id when its Claude Code runs. */
export function liveTerminalPty(): string | null {
  const id = liveTerminalChatId(useStore.getState().state);
  const ptyId = id ? (chatPtyOf(id).ptyId ?? chatTerminalOf(id)) : null;
  return ptyId && terminalStatus(ptyId).running ? ptyId : null;
}

/**
 * App-wide (mounted once): opens the PTY when a terminal chat becomes the live chat, forgets the ones main ended when the
 * chat stopped being live (they reopen when it is live again), and posts a notification for each new wait in the TUI.
 */
export function useTerminalChatPty(): void {
  useEffect(() => {
    if (!window.rg?.pty) return;
    let lastWait: string | null = null;
    let checking = false;
    const forget = (sessionId: string) =>
      useTerminalChats.setState((s) => {
        const next = { ...s.bySession };
        delete next[sessionId];
        return { bySession: next };
      });
    const check = () => {
      if (checking) return;
      checking = true;
      try {
        sweep();
      } finally {
        checking = false;
      }
    };
    const sweep = () => {
      const state = useStore.getState().state;
      const live = liveTerminalChatId(state);
      // Ended because the chat stopped being the live one (or the project closed): the next time it is, a new PTY.
      for (const [sessionId, c] of Object.entries(useTerminalChats.getState().bySession)) {
        if (sessionId === live || c.opening) continue;
        if (!c.ptyId) {
          forget(sessionId); // a refusal of a chat that is not live any more: it tries again when it is
          continue;
        }
        const reason = terminalStatus(c.ptyId).exit?.reason;
        if (reason === "switched" || reason === "closed" || !hasTerminal(c.ptyId)) {
          disposeTerminal(c.ptyId);
          forget(sessionId);
        }
      }
      if (live && state.project) {
        const c = chatPtyOf(live);
        if (!c.ptyId && !c.opening && !c.failed) void openChatPty(live);
      }
      const waiting = terminalWaitingOf(state);
      const key = waiting && live ? `term:${live}:${waiting.since}` : null;
      if (key && key !== lastWait && waiting && live) {
        const a = terminalWaitingAttention(waiting, live);
        const root = state.project?.root;
        const title = root ? `ReviewGate — ${lastComponent(root)}` : "ReviewGate";
        void window.rg.notify?.({ kind: a.kind, title, body: a.body, key: a.key, target: { chatId: live } })?.catch(() => undefined);
      }
      lastWait = key;
    };
    check();
    const offStore = useStore.subscribe((s, prev) => {
      if (s.state !== prev.state) check();
    });
    const offTerms = subscribeTerminals(check);
    return () => {
      offStore();
      offTerms();
    };
  }, []);
}
