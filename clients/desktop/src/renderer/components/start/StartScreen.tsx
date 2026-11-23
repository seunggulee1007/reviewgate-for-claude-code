/**
 * MARK: task-start — docs/PROTOCOL.md §63.4 on Windows (the Mac's `StartScreenView`): over a project window's diff and chat
 * area (the sidebar, menus and the bottom panel stay usable) — 1 바로 시작 (a new chat), 2 업무로 시작 (the task dialog,
 * TaskStartDialog.tsx; Cancel comes back here), 3 대화로 열기 (a recent chat) — with ↑ / ↓ / Enter, and Esc = 바로 시작, so
 * it never blocks. When it shows is `useStartScreenWatch` (startScreen.ts decides; taskStart.ts holds the rules).
 */
import { useEffect, useRef } from "react";
import type { SessionMeta } from "@reviewgate/engine";
import { flowRepoRoot } from "../../../shared/flowSettings";
import { composerTextWaiting } from "../../composerBridge";
import { Icon, type IconName } from "../../icons";
import { relativeTime, t } from "../../i18n";
import { isShadowProject } from "../../noGit";
import { displayChatTitle, sessionsOf } from "../../sessions";
import { hideStartScreen, stepStartScreen, useStartScreen, type StartScreenWatch } from "../../startScreen";
import { lastComponent, useStore } from "../../store";
import { recentStartChats, startScreenKey, type StartAction, type StartChoice, type StartMark } from "../../taskStart";
import { startStraight } from "../../taskStartFlow";
import { chatPtyOf, liveTerminalChatId } from "../../terminal/terminalChat";
import { chatTerminalOf, focusTerminal } from "../../terminal/termHost";
import "./start.css";

/** App-wide (mounted once): decides on every snapshot whether the start screen shows (stepStartScreen). */
export function useStartScreenWatch(): void {
  useEffect(() => {
    const watch: { current: StartScreenWatch } = { current: { checkedPath: null, suppressNext: window.rgNoStartScreen === true } };
    const step = (s: ReturnType<typeof useStore.getState>) => {
      const next = stepStartScreen(watch.current, { state: s.state, settings: s.settings, composerWaiting: composerTextWaiting() }, useStartScreen.getState().shown);
      watch.current = next.watch;
      if (next.show === true) useStartScreen.setState({ shown: true, mark: { choice: 1 } });
      else if (next.show === false) hideStartScreen();
    };
    step(useStore.getState());
    return useStore.subscribe(step);
  }, []);
}

/** The screen goes away; the chat (its composer, or the terminal of a terminal chat) takes the keyboard. */
function finish(): void {
  hideStartScreen();
  setTimeout(() => {
    const live = liveTerminalChatId(useStore.getState().state);
    if (live) focusTerminal(chatPtyOf(live).ptyId ?? chatTerminalOf(live));
    else document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
  }, 50);
}

export function StartScreen() {
  const shown = useStartScreen((s) => s.shown);
  const mark = useStartScreen((s) => s.mark);
  const state = useStore((s) => s.state);
  const dialogOpen = useStore((s) => s.dialog !== null);
  const openDialog = useStore((s) => s.openDialog);
  const skip = useStore((s) => s.settings?.skipStartScreen === true);
  const saveSettings = useStore((s) => s.saveSettings);
  const root = useRef<HTMLDivElement>(null);
  const sessions = sessionsOf(state);
  const chats = recentStartChats(sessions.list);
  const chatIds = chats.map((c) => c.id);

  // It takes the keyboard as it appears (the chat behind takes it first), and again when the task dialog closes.
  useEffect(() => {
    if (!shown || dialogOpen) return;
    root.current?.focus({ preventScroll: true });
    const again = setTimeout(() => root.current?.focus({ preventScroll: true }), 150);
    return () => clearTimeout(again);
  }, [shown, dialogOpen]);

  if (!shown || !state.project) return null;

  const setMark = (m: StartMark) => useStartScreen.setState({ mark: m });
  const perform = (action: StartAction | null) => {
    if (!action) return;
    if (action.kind === "start") {
      finish();
      void startStraight();
    } else if (action.kind === "task") {
      openDialog({ kind: "taskStart" });
    } else {
      finish();
      if (action.id !== sessions.currentId) void useStore.getState().openChat(action.id);
    }
  };
  const marked = (m: StartMark) => ("choice" in m && "choice" in mark ? m.choice === mark.choice : "chat" in m && "chat" in mark && m.chat === mark.chat);
  const name = state.project.name || lastComponent(state.project.path);
  const shadow = isShadowProject(state);
  const repo = flowRepoRoot(state);

  return (
    <div
      ref={root}
      className="start-screen"
      tabIndex={-1}
      role="dialog"
      aria-label={t("Start now · Start from a task · Open a chat")}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return; // the checkbox keeps Space / Enter
        if (e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
        const r = startScreenKey(e.key, mark, chatIds);
        if (!r.handled) return;
        e.preventDefault();
        e.stopPropagation();
        setMark(r.mark);
        perform(r.action);
      }}
      data-testid="Start screen"
    >
      <div className="start-inner">
        <div className="col" style={{ gap: 4 }}>
          <h2 className="start-title" title={repo ?? state.project.path}>{name}</h2>
          <div className="muted">{t("How do you want to start?")}</div>
        </div>
        <div className="start-cards">
          <ChoiceCard choice={1} marked={marked({ choice: 1 })} icon="plus" title={t("Start now")} detail={t("Open a new chat")} onPick={() => { setMark({ choice: 1 }); perform({ kind: "start" }); }} />
          <ChoiceCard
            choice={2}
            marked={marked({ choice: 2 })}
            icon="branch"
            title={t("Start from a task")}
            detail={shadow ? t("From a task, in this folder") : t("A task's branch and first prompt")}
            onPick={() => { setMark({ choice: 2 }); perform({ kind: "task" }); }}
          />
          <ChoiceCard
            choice={3}
            marked={marked({ choice: 3 })}
            icon="refresh"
            title={t("Open a chat")}
            detail={t("Continue a recent chat")}
            disabled={chats.length === 0}
            help={chats.length === 0 ? t("This project has no earlier chats") : t("Continue a recent chat (3)")}
            onPick={() => setMark({ chat: 0 })}
            onFocus={() => setMark({ choice: 3 })}
          />
        </div>
        {chats.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <div className="caption muted bold">{t("Recent chats")}</div>
            <div className="start-recent" role="list">
              {chats.map((chat, i) => (
                <RecentRow key={chat.id} chat={chat} current={chat.id === sessions.currentId} marked={marked({ chat: i })} onOpen={() => { setMark({ chat: i }); perform({ kind: "openChat", id: chat.id }); }} onFocus={() => setMark({ chat: i })} />
              ))}
            </div>
          </div>
        )}
        <div className="row start-foot">
          <label className="row" style={{ gap: 6 }} title={t("Skips this screen when a project opens — Settings › Tasks › Start screen turns it back on")}>
            <input type="checkbox" checked={skip} onChange={(e) => void saveSettings({ skipStartScreen: e.target.checked })} data-testid="Skip the start screen" />
            {t("Start straight away next time")}
          </label>
          <span className="spacer" />
          <span className="caption muted">{t("1 · 2 · 3, ↑ ↓ ↩ — Esc starts now")}</span>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard(props: { choice: StartChoice; marked: boolean; icon: IconName; title: string; detail: string; disabled?: boolean; help?: string; onPick: () => void; onFocus?: () => void }) {
  return (
    <button
      type="button"
      className={props.marked ? "start-card marked" : "start-card"}
      disabled={props.disabled}
      title={props.help ?? `${props.title} (${props.choice})`}
      aria-label={`${props.title} — ${props.detail}`}
      onClick={props.onPick}
      // Tab moves the mark with the focus, so Enter takes what has the focus.
      onFocus={props.onFocus ?? (() => useStartScreen.setState({ mark: { choice: props.choice } }))}
      data-testid={`Start choice ${props.choice}`}
    >
      <span className="row" style={{ justifyContent: "space-between" }}>
        <span className="start-card-icon" aria-hidden="true"><Icon name={props.icon} size={20} /></span>
        <span className="start-badge" aria-hidden="true">{props.choice}</span>
      </span>
      <span className="start-card-title">{props.title}</span>
      <span className="caption muted">{props.detail}</span>
    </button>
  );
}

function RecentRow({ chat, current, marked, onOpen, onFocus }: { chat: SessionMeta; current: boolean; marked: boolean; onOpen: () => void; onFocus: () => void }) {
  const terminal = chat.kind === "terminal";
  const title = displayChatTitle(chat.title);
  return (
    <button
      type="button"
      role="listitem"
      className={marked ? "start-recent-row marked" : "start-recent-row"}
      title={chat.lastUserText?.trim() ? chat.lastUserText : title}
      onClick={onOpen}
      onFocus={onFocus}
      data-testid="Start recent chat"
    >
      <span className="start-kind" aria-hidden="true"><Icon name={terminal ? "terminal" : "lines"} size={14} /></span>
      <span className="col grow" style={{ gap: 1, minWidth: 0, alignItems: "flex-start" }}>
        <span className="truncate" style={{ maxWidth: "100%" }}>{title}</span>
        <span className="caption muted">{terminal ? t("Terminal chat") : t("Chat")}</span>
      </span>
      {current && <span className="caption muted">{t("Open now")}</span>}
      <span className="caption muted" title={chat.updatedAt}>{relativeTime(chat.updatedAt)}</span>
    </button>
  );
}
