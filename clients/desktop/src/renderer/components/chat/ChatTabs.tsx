/**
 * Tab strip above the transcript (docs/M15-POLISH.md): one tab per `state.sessions.openTabIds`
 * (title, running dot, close ×), `+` = new chat, "History…" opens the sessions dialog. `+` is disabled, with the reason
 * as tooltip, while the engine would refuse a switch (busy, or a review bound to this chat — see `sessionSwitchRefusal`).
 * MARK: wave4b w4b-tabs — §39.2: a tab click (or ⌘1…9) only shows that chat's saved rows (read-only, viewedChat.ts); the
 * Claude session stays where it is (a dot on its tab) until a send or [이 채팅으로 이어가기] moves it — tabs are never disabled.
 */
import { useEffect } from "react";
import { t } from "../../i18n";
import { chatTabKey } from "../../keymap";
import { sessionsOf, sessionSwitchRefusal, sessionTitle } from "../../sessions";
import { isRunning, useStore } from "../../store";
import { stopViewing, useViewedChat, useViewing, viewChat, viewingOf } from "../../viewedChat";
import { RecordOnlyBadge } from "./RecordOnly";
import { MovedChatBadge } from "./ChatMoveViews"; // MARK: wave4b w4b-follow

/** A blocked shortcut says why on the banner, like the disabled button's tooltip (never a silent no-op). */
const sayWhy = (message: string) => useStore.setState({ lastError: message, errorBanner: { message, scope: "session", fatal: false } });

export function ChatTabs() {
  const state = useStore((s) => s.state);
  const closeTab = useStore((s) => s.closeTab);
  const newChat = useStore((s) => s.newChat);
  const openDialog = useStore((s) => s.openDialog);
  const sessions = sessionsOf(state);
  const refusal = sessionSwitchRefusal(state);
  const running = isRunning(state) || state.session.starting;
  const viewing = useViewing();
  const shown = viewing?.id ?? sessions.currentId;
  const ids = sessions.openTabIds;
  // wave4 w4-input (polish-06): ⌘T (Ctrl+T) a new chat, ⌘1…⌘9 (Ctrl+1…9) the tab at that place (shown read-only),
  // ⌘⇧W (Ctrl+Shift+W) closes the tab on screen as its × does.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const key = chatTabKey(e);
      const s = useStore.getState();
      if (!key || s.dialog) return;
      const list = sessionsOf(s.state);
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
        if (viewingNow?.id === shownId) stopViewing(); // wave4b w4b-tabs
        void s.closeTab(shownId);
        return;
      }
      const id = key.kind === "new" ? null : list.openTabIds[key.index];
      if (key.kind === "tab" && !id) return;
      e.preventDefault();
      if (id) void viewChat(id);
      else {
        const why = sessionSwitchRefusal(s.state);
        if (why !== null) sayWhy(why);
        else void s.newChat();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="chat-tabs" role="tablist" data-testid="Chat tabs">
      {ids.length === 0 && <h3 className="chat-tabs-title">{t("Chat")}</h3>}
      {ids.map((id, index) => {
        const current = id === sessions.currentId;
        const selected = id === shown;
        const title = sessionTitle(sessions, id);
        const recordOnly = sessions.list.find((m) => m.id === id)?.resumeFailed === true;
        const live = current && viewing !== null;
        const moved = sessions.list.find((m) => m.id === id)?.movedTo; // MARK: wave4b w4b-follow (§39.4)
        return (
          <div
            key={id}
            role="tab"
            aria-selected={selected}
            className={`chat-tab ${selected ? "active" : ""}`}
            title={current && (running || live) ? t("Claude's session is on this chat") : index < 9 ? t("{0} ({1})", title, `⌘${index + 1}`) : title}
            data-testid={`Chat tab ${id}`}
            onClick={() => {
              if (!selected) void viewChat(id);
            }}
          >
            {current && running && <span className="dot green" data-testid="Chat running" aria-label={t("Claude's session is on this chat")} />}
            {live && !running && <span className="dot hollow" data-testid="Chat live" aria-label={t("Claude's session is on this chat")} />}
            <span className="truncate">{title}</span>
            {recordOnly && !selected && <RecordOnlyBadge className="record-only" />}
            {moved && <MovedChatBadge moved={moved} />}
            <button
              type="button"
              className="plain small close"
              title={t("Close tab")}
              disabled={current && refusal !== null}
              onClick={(e) => {
                e.stopPropagation();
                if (viewing?.id === id) stopViewing(); // wave4b w4b-tabs
                void closeTab(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="plain small" title={refusal ?? t("{0} ({1})", t("New chat"), "⌘T")} disabled={refusal !== null} onClick={() => void newChat()} data-testid="New chat">
        +
      </button>
      <span className="spacer" />
      <button type="button" className="plain small" disabled={!state.project} onClick={() => openDialog({ kind: "history" })} data-testid="History…">
        {t("History…")}
      </button>
    </div>
  );
}
