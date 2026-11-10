/**
 * Tab strip above the transcript (docs/M15-POLISH.md): one tab per `state.sessions.openTabIds`
 * (title, running dot, close ×), `+` = new chat, "History…" opens the sessions dialog.
 * MARK: wave4b w4b-tabs — §39.2: a tab click (or ⌘1…9) only shows that chat's saved rows (read-only, viewedChat.ts); the
 * Claude session stays where it is (a dot on its tab) until a send or [이 채팅으로 이어가기] moves it — tabs are never disabled.
 * r2-chats-cards M31 / M33 (§9): `+` / Ctrl+T are never refused while Claude works — the new chat opens once the turn is
 * over (pendingSwitch.ts; a chip says what waits, × calls it off); only a failed collection disables them.
 * Polish P4-composer-33 / 34 / 08, PX-19: names and keys in the tooltips, the tabs reachable from the keyboard (←/→, Enter),
 * a right-click menu, drag to reorder, a middle click closes, the tabs scroll on their own (+ and History… stay), ✎ on a
 * tab with an unsent draft, Ctrl/⌘+Shift+T reopens the last closed tab and Ctrl+Tab / Ctrl+PgDn step through them.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t, usesMacKeys } from "../../i18n";
import { tKey } from "../../shortcutKeys";
import { chatTabKey } from "../../keymap";
import { newChatRefusal, projectRootHash, sessionsOf, sessionSwitchRefusal, sessionTitle } from "../../sessions";
import { isRunning, useStore } from "../../store";
import { stopViewing, useViewedChat, useViewing, viewChat, viewingOf } from "../../viewedChat";
import { cancelPendingSwitch, pendingSwitchLabel, pendingSwitchText, switchWaits, usePendingSwitch } from "../../pendingSwitch";
import { startPendingSwitchDrain } from "../../pendingSwitchDrain";
import { isHistoryKey, isReopenTabKey, rememberClosedTab, stepTab, tabStepKey, takeClosedTab, useClosedTabs } from "../../chatTabsState";
import { loadDraft, windowStorage } from "../../sessionKeep";
import { chatDraftKey } from "../../workSafety";
import { copyWithToast } from "../common/CopyButton";
import { showToast } from "../../toast";
import { Icon } from "../../icons";
import { isEnter } from "../../ime";
import { PointerMenu, type AgentMenuItem } from "../agents/AgentBits";
import { RecordOnlyBadge } from "./RecordOnly";
import { MovedChatBadge } from "./ChatMoveViews"; // MARK: wave4b w4b-follow

/** A blocked shortcut says why on the banner, like the disabled button's tooltip (never a silent no-op). */
const sayWhy = (message: string) => useStore.setState({ lastError: message, errorBanner: { message, scope: "session", fatal: false } });

const TAB_DRAG_TYPE = "application/x-reviewgate-chat-tab";

/** polish P4-composer-08: an unsent draft is kept for chat `id` (this window's draft store). */
function hasDraft(root: string | null, id: string): boolean {
  return loadDraft(windowStorage(), chatDraftKey(root ? projectRootHash(root) : null, id)).trim().length > 0;
}

/** Closes `id`'s tab as its × does — a shown chat hands back first; remembered for Ctrl/⌘+Shift+T (PX-19). */
async function closeChatTab(id: string): Promise<void> {
  const s = useStore.getState();
  const before = sessionsOf(s.state).openTabIds;
  const root = s.state.project?.root ?? null;
  const drafted = hasDraft(root, id);
  if (useViewedChat.getState().chat?.id === id) stopViewing(); // wave4b w4b-tabs
  await s.closeTab(id);
  if (before.includes(id) && !sessionsOf(useStore.getState().state).openTabIds.includes(id)) {
    rememberClosedTab(id);
    if (drafted) showToast(t("Draft kept — reopen the chat to get it back (⌘⇧T)"));
  }
}

/** PX-19: the last closed chat comes back as a tab, shown read-only as a tab click shows it. */
async function reopenClosedTab(id?: string): Promise<void> {
  const s = useStore.getState();
  const list = sessionsOf(s.state);
  const target = id ?? takeClosedTab((x) => list.list.some((m) => m.id === x));
  if (!target) return;
  if (id) useClosedTabs.setState((c) => ({ ids: c.ids.filter((x) => x !== id), justClosed: null }));
  s.ensureTab(target);
  await viewChat(target);
}

export function ChatTabs() {
  const state = useStore((s) => s.state);
  const newChat = useStore((s) => s.newChat);
  const openDialog = useStore((s) => s.openDialog);
  const archiveChat = useStore((s) => s.archiveChat);
  const queued = useStore((s) => s.queue.items.length > 0 || s.queue.inflight);
  const pending = usePendingSwitch((s) => s.pending);
  const justClosed = useClosedTabs((s) => s.justClosed);
  const sessions = sessionsOf(state);
  const refusal = sessionSwitchRefusal(state);
  const newRefusal = newChatRefusal(state);
  const waits = switchWaits(state, queued);
  const running = isRunning(state) || state.session.starting;
  const viewing = useViewing();
  const shown = viewing?.id ?? sessions.currentId;
  const ids = sessions.openTabIds;
  const root = state.project?.root ?? null;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; id: string } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  /** P4-composer-34: the strip fades only at an end with tabs out of sight. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  /** P4-composer-34: "이름 바꾸기…" edits the title in the tab itself (↩ keeps it, esc leaves it). */
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const renameChat = useStore((s) => s.renameChat);
  const commitRename = () => {
    const r = renaming;
    setRenaming(null);
    const title = r?.title.trim() ?? "";
    if (r && title.length > 0 && title !== sessionTitle(sessions, r.id)) void renameChat(r.id, title);
  };

  // r2-chats-cards M31 / M33 (§9): a held switch goes out once the live chat is done.
  useEffect(() => startPendingSwitchDrain(), []);
  // P4-composer-34: the tab on screen scrolls into sight (⌘1…9, Ctrl+Tab, a reopened tab), and the ends fade as they hide tabs.
  useEffect(() => {
    if (shown) tabRefs.current.get(shown)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
  }, [shown, ids.length, measure]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // PX-19: "탭을 닫았어요 · 다시 열기" for a few seconds.
  useEffect(() => {
    if (!justClosed) return;
    const timer = setTimeout(() => useClosedTabs.setState({ justClosed: null }), 3000);
    return () => clearTimeout(timer);
  }, [justClosed]);

  // wave4 w4-input (polish-06): ⌘T (Ctrl+T) a new chat, ⌘1…⌘9 (Ctrl+1…9) the tab at that place (shown read-only),
  // ⌘⇧W (Ctrl+Shift+W) closes the tab on screen as its × does. PX-19: ⌘⇧T reopens, Ctrl+Tab / Ctrl+PgDn steps.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog) return;
      const list = sessionsOf(s.state);
      const step = tabStepKey(e);
      if (step !== null) {
        const viewingNow = viewingOf(useViewedChat.getState().chat, s.state);
        const next = stepTab(list.openTabIds, viewingNow?.id ?? list.currentId, step);
        if (!next) return;
        e.preventDefault();
        void viewChat(next);
        return;
      }
      if (isReopenTabKey(e, usesMacKeys())) {
        e.preventDefault();
        void reopenClosedTab();
        return;
      }
      if (isHistoryKey(e, usesMacKeys())) {
        // ⌘Y / Ctrl+H — the Mac's Chat › 채팅 기록…; a code editor keeps its own Ctrl+H (replace).
        if (!s.state.project || (document.activeElement as HTMLElement | null)?.closest?.(".monaco-editor")) return;
        e.preventDefault();
        s.openDialog({ kind: "history" });
        return;
      }
      const key = chatTabKey(e);
      if (!key) return;
      if (key.kind === "close") {
        const viewingNow = viewingOf(useViewedChat.getState().chat, s.state);
        const shownId = viewingNow?.id ?? list.currentId;
        if (!shownId || !list.openTabIds.includes(shownId)) return;
        e.preventDefault();
        // The live chat's tab moves the session to its neighbour: only while a switch is allowed (as its × is disabled).
        const why = shownId === list.currentId ? sessionSwitchRefusal(s.state) : null;
        if (why !== null) {
          sayWhy(why);
          return;
        }
        void closeChatTab(shownId);
        return;
      }
      const id = key.kind === "new" ? null : list.openTabIds[key.index];
      if (key.kind === "tab" && !id) return;
      e.preventDefault();
      if (id) void viewChat(id);
      else {
        const why = newChatRefusal(s.state);
        if (why !== null) sayWhy(why);
        else void s.newChat();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /** P4-composer-33: ← / → move between the tabs, Enter shows the one focused. */
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const next = stepTab(ids, id, e.key === "ArrowRight" ? 1 : -1);
      if (next) {
        e.preventDefault();
        tabRefs.current.get(next)?.focus();
      }
    } else if (isEnter(e) || e.key === " ") {
      e.preventDefault();
      if (id !== shown) void viewChat(id);
    }
  };

  const menuItems = (id: string): AgentMenuItem[] => {
    const index = ids.indexOf(id);
    const meta = sessions.list.find((m) => m.id === id);
    const closeWhy = id === sessions.currentId ? sessionSwitchRefusal(state) ?? (ids.length < 2 ? t("The only open chat cannot be closed") : null) : null;
    const move = (to: number) => {
      const next = ids.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
      useStore.getState().fire({ type: "tabs_set", openTabIds: next });
      useStore.setState((st) => ({ state: { ...st.state, sessions: { ...sessionsOf(st.state), openTabIds: next } } }));
    };
    // The live chat's tab stays (closing it would move Claude's session), as on the Mac.
    const others = ids.filter((x) => x !== id && x !== sessions.currentId);
    return [
      { label: t("Rename…"), onClick: () => setRenaming({ id, title: sessionTitle(sessions, id) }), testId: "Chat tab menu rename" },
      { label: t("Close Tab"), onClick: () => void closeChatTab(id), disabled: closeWhy, testId: "Chat tab menu close" },
      ...(others.length > 0 ? [{ label: t("Close Other Tabs"), onClick: () => void (async () => { for (const x of others) await closeChatTab(x); })(), testId: "Chat tab menu close others" }] : []),
      { label: t("Move Tab Left"), onClick: () => move(index - 1), disabled: index <= 0 ? t("It is the first tab") : null, testId: "Chat tab menu left" },
      { label: t("Move Tab Right"), onClick: () => move(index + 1), disabled: index >= ids.length - 1 ? t("It is the last tab") : null, testId: "Chat tab menu right" },
      { label: t("Copy Chat ID"), onClick: () => void copyWithToast(id), testId: "Chat tab menu copy id" },
      { label: t("Show in History"), onClick: () => openDialog({ kind: "history", highlight: id }), testId: "Chat tab menu history" },
      { label: meta?.archived ? t("Unarchive") : t("Archive"), onClick: () => void archiveChat(id, !meta?.archived), testId: "Chat tab menu archive" },
    ];
  };

  const newTitle = newRefusal ?? (waits ? t("New chat (⌘T) — it opens once Claude is done") : t("{0} ({1})", t("New chat"), "⌘T"));
  return (
    <div className="chat-tabs" data-testid="Chat tabs">
      <div
        ref={scrollRef}
        className={["chat-tabs-scroll", edges.left ? "fade-left" : "", edges.right ? "fade-right" : ""].filter(Boolean).join(" ")}
        role="tablist"
        aria-label={t("Chat tabs")}
        onScroll={measure}
      >
        {ids.length === 0 && <h3 className="chat-tabs-title">{t("Chat")}</h3>}
        {ids.map((id, index) => {
          const current = id === sessions.currentId;
          const selected = id === shown;
          const title = sessionTitle(sessions, id);
          const recordOnly = sessions.list.find((m) => m.id === id)?.resumeFailed === true;
          const live = current && viewing !== null;
          const moved = sessions.list.find((m) => m.id === id)?.movedTo; // MARK: wave4b w4b-follow (§39.4)
          const closeWhy = current ? refusal ?? (ids.length < 2 ? t("The only open chat cannot be closed") : null) : null;
          const tabTitle = current && (running || live)
            ? index < 9 ? t("{0} — Claude's session is on this chat (⌘{1})", title, index + 1) : t("{0} — Claude's session is on this chat", title)
            : index < 9 ? t("{0} (⌘{1})", title, index + 1) : title;
          const drafted = hasDraft(root, id);
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) tabRefs.current.set(id, el);
                else tabRefs.current.delete(id);
              }}
              role="tab"
              tabIndex={0}
              aria-selected={selected}
              className={`chat-tab ${selected ? "active" : ""}`}
              title={tabTitle}
              data-testid={`Chat tab ${id}`}
              onClick={() => {
                if (!selected) void viewChat(id);
              }}
              onKeyDown={(e) => onTabKey(e, id)}
              onAuxClick={(e) => {
                // P4-composer-34: a middle click closes the tab, as in a browser.
                if (e.button !== 1) return;
                e.preventDefault();
                if (closeWhy === null) void closeChatTab(id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY, id });
              }}
              draggable={renaming?.id !== id}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_TYPE, id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TAB_DRAG_TYPE)) e.preventDefault();
              }}
              onDrop={(e) => {
                const moved = e.dataTransfer.getData(TAB_DRAG_TYPE);
                if (!moved || moved === id) return;
                e.preventDefault();
                const next = ids.filter((x) => x !== moved);
                next.splice(next.indexOf(id) + (ids.indexOf(moved) < index ? 1 : 0), 0, moved);
                useStore.getState().fire({ type: "tabs_set", openTabIds: next });
                useStore.setState((st) => ({ state: { ...st.state, sessions: { ...sessionsOf(st.state), openTabIds: next } } }));
              }}
            >
              {current && running && <span className="dot green" data-testid="Chat running" aria-label={t("Claude's session is on this chat")} />}
              {live && !running && <span className="dot hollow" data-testid="Chat live" aria-label={t("Claude's session is on this chat")} />}
              {renaming?.id === id ? (
                <input
                  className="tab-rename"
                  value={renaming.title}
                  autoFocus
                  aria-label={t("Rename…")}
                  onChange={(e) => setRenaming({ id, title: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (isEnter(e)) commitRename();
                    else if (e.key === "Escape") setRenaming(null);
                  }}
                  data-testid="Chat tab rename"
                />
              ) : (
                <span className="truncate">{title}</span>
              )}
              {drafted && (
                <span className="tab-draft" title={t("Unsent draft")} aria-label={t("Unsent draft")} data-testid="Chat tab draft">✎</span>
              )}
              {recordOnly && !selected && <RecordOnlyBadge className="record-only" />}
              {moved && <MovedChatBadge moved={moved} />}
              <button
                type="button"
                className="plain small close"
                title={closeWhy ?? t("Close tab (⌘⇧W) — the chat stays in History")}
                aria-label={t("Close the tab ‘{0}’", title)}
                disabled={closeWhy !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeChatTab(id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {justClosed && (
        <button type="button" className="link small" onClick={() => void reopenClosedTab(justClosed)} title={tKey("Reopen the chat you just closed", "Reopen Closed Chat Tab")} data-testid="Reopen closed chat tab">
          {t("Tab closed · Reopen")}
        </button>
      )}
      <button type="button" className="plain small" title={newTitle} aria-label={t("New chat")} disabled={newRefusal !== null} onClick={() => void newChat()} data-testid="New chat">
        <Icon name="plus" size={14} />
      </button>
      {pending && (
        <span className="pending-switch pill" title={pendingSwitchText(state, pending) ?? undefined} data-testid="Pending chat switch">
          <span className="truncate">{pendingSwitchLabel(state, pending)}</span>
          <button type="button" className="plain small" aria-label={t("Call off the waiting chat switch")} title={t("Call it off")} onClick={cancelPendingSwitch} data-testid="Cancel pending chat switch">
            <Icon name="close" size={10} />
          </button>
        </span>
      )}
      <button type="button" className="plain small" disabled={!state.project} title={tKey("Chat History…", "Chat History…")} onClick={() => openDialog({ kind: "history" })} data-testid="History…">
        {t("History…")}
      </button>
      {menuAt && <PointerMenu at={menuAt} items={menuItems(menuAt.id)} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
