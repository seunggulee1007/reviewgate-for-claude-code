/**
 * §57.5 / §57.17 (plan §4.2): the chat column of a terminal chat — the real Claude Code in a terminal under a thin strip
 * (whether ReviewGate hears its hooks, "Review now" when a turn Esc stopped stays open, find, Restart), and an overlay once
 * Claude Code exited (its last screen stays readable underneath). A terminal chat shown read-only (another chat is the
 * live one) has no terminal: it offers to continue in it. The Mac's `TerminalChatView`, with its words.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t, usesMacKeys } from "../../i18n";
import { Icon } from "../../icons";
import { isEnter } from "../../ime";
import { useStore } from "../../store";
import {
  countsReviewedHint,
  escapeMark,
  readReviewedHint,
  showsReviewedHint,
  showsReviewNow,
  stripStatus,
  terminalActivityKey,
  terminalOverlay,
  terminalStartRefusal,
  writeReviewedHint,
  type EscapeMark,
} from "../../terminalStrip";
import { chatPtyOf, restartChatPty, useTerminalChats } from "../../terminal/terminalChat";
import { acceptsPaste, clearTerminalFind, findInTerminal, focusTerminal, onTerminalEscape, pasteIntoTerminal, sendToTerminal, subscribeTerminals, terminalStatus, terminalsVersion } from "../../terminal/termHost";
import { runTerminalAcceptContinue, terminalAcceptContinueBlocker } from "../../terminalAcceptContinue";
import { firstWaitingPath, openReviewTitle, reviewFirstBlockedHelp, reviewFirstBlockedText } from "../../reviewFirst"; // §64
import { showToast } from "../../toast";
import { droppedMentionPaths, MENTION_DRAG_TYPE } from "../../mentions";
import { pasteRefusal } from "../../terminalPaste";
import { dropText, mentionText } from "../../terminalDrop";
import { useViewing } from "../../viewedChat";
import { ViewingChatBar } from "../chat/ViewingChat";
import { engineRequest, refusalOf } from "../../engineRequest";
import { TerminalView } from "./TerminalView";
import "./terminal.css";

/** A PTY that runs while the engine says its terminal does not, for this long, is no longer reviewed (the engine was reset). */
const DISCONNECT_GRACE_MS = 5000;

export function TerminalChatColumn() {
  const viewing = useViewing();
  const live = useStore((s) => s.state.sessions?.currentId ?? null);
  const chat = useTerminalChats((s) => (live ? s.bySession[live] : undefined));
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  if (viewing) return <ViewedTerminalChat />;
  if (!live) return null;
  const c = chat ?? chatPtyOf(live);
  if (c.ptyId) return <LiveTerminal chatId={live} ptyId={c.ptyId} opening={c.opening} startedAt={c.startedAt} failed={c.failed} />;
  if (c.failed) return <TerminalStartProblem chatId={live} message={c.failed} />;
  return (
    <div className="terminal-chat terminal-starting" role="status" data-testid="Terminal chat starting">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{t("Starting Claude Code…")}</span>
    </div>
  );
}

/** Ticks every `ms` while mounted (the "Review now" and disconnect rules read the clock). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function LiveTerminal(props: { chatId: string; ptyId: string; opening: boolean; startedAt: number; failed: string | null }) {
  const state = useStore((s) => s.state);
  const info = state.session.terminal ?? null;
  const working = state.gate.phase === "running";
  const status = terminalStatus(props.ptyId);
  // Each second: "Review now" shows 2 s after an Esc with no hook since (§57.4).
  const now = useNow(1000);
  // §57.4: the Esc pressed here while the turn ran (with the engine's hookCount then); the turn's end clears it.
  const [escape, setEscape] = useState<EscapeMark | null>(null);
  const latest = useRef({ working, info });
  latest.current = { working, info };
  useEffect(
    () =>
      onTerminalEscape((ptyId) => {
        if (ptyId !== props.ptyId) return;
        const mark = escapeMark({ ...latest.current, nowMs: Date.now() });
        if (mark) setEscape(mark);
      }),
    [props.ptyId],
  );
  useEffect(() => {
    if (!working) setEscape(null);
  }, [working]);
  // "Review now" after 60 s without a change in the live terminal chat (the Mac's rule: no per-hook timestamp).
  const activity = useRef({ key: "", at: Date.now() });
  const key = terminalActivityKey(state);
  if (activity.current.key !== key) activity.current = { key, at: Date.now() };
  const disconnected = status.running && info?.running !== true && props.startedAt > 0 && now - props.startedAt >= DISCONNECT_GRACE_MS;
  const strip = stripStatus({ disconnected, info, working });
  const hint = useReviewedHint(props.chatId, strip.kind === "reviewed");
  const reviewNow = showsReviewNow({ working, info, lastActivityMs: activity.current.at, nowMs: now, escape });
  const overlay = terminalOverlay({ exit: status.running ? null : status.exit, failed: props.failed, disconnected });
  const [finding, setFinding] = useState(false);
  const redraw = usesMacKeys() ? t("Stale lines on the screen? ⌃L redraws it") : t("Stale lines on the screen? Ctrl+L redraws it");
  return (
    <div className="terminal-chat" data-testid="Terminal chat">
      <div className={`terminal-strip ${disconnected ? "disconnected" : ""}`} data-testid="Terminal chat strip">
        <span
          className={`terminal-status ${strip.tone}`}
          title={`${strip.kind === "reviewed" && !hint.shows ? `${strip.text}\n` : ""}${strip.help}\n${redraw}`}
          role="status"
          aria-label={strip.kind === "reviewed" && !hint.shows ? (strip.short ?? strip.text) : undefined}
          data-testid="Terminal chat status"
        >
          <Icon name="terminal" size={13} />
          {/* §57.5: "…changes show on the left" only the first few times (or until closed): then the icon, the words in its tooltip. */}
          {(strip.kind !== "reviewed" || hint.shows) && <span className="long truncate">{strip.text}</span>}
          {strip.short && (strip.kind !== "reviewed" || hint.shows) && <span className="short truncate">{strip.short}</span>}
        </span>
        {strip.kind === "reviewed" && hint.shows && (
          <button
            type="button"
            className="plain small"
            aria-label={t("Hide this hint")}
            title={t("Don't show this again — the icon stays, with this note in its tooltip")}
            onClick={hint.dismiss}
            data-testid="Terminal chat hint close"
          >
            ×
          </button>
        )}
        <span className="grow" />
        {reviewNow && (
          <button
            type="button"
            className="small"
            title={t("End this turn and review its changes now — after Esc Claude Code sends no end of turn, so the turn stays open until the next prompt")}
            onClick={() => void endTerminalTurn(props.chatId)}
            data-testid="Terminal chat review now"
          >
            {t("Review now")}
          </button>
        )}
        {(state.gate.reviewFirst?.blocked ?? 0) > 0 && <ReviewFirstChip /> /* §64 */}
        {state.gate.pendingCount > 0 && <AcceptContinueButton ptyId={props.ptyId} running={status.running && !disconnected} />}
        <button
          type="button"
          className={`plain small ${finding ? "active" : ""}`}
          aria-pressed={finding}
          aria-label={t("Find in terminal")}
          title={t("Find in the terminal's screen and scrollback")}
          onClick={() => setFinding((f) => !f)}
          data-testid="Terminal chat find"
        >
          <Icon name="search" size={13} />
        </button>
        <button
          type="button"
          className="plain small"
          disabled={props.opening}
          aria-label={t("Restart Claude Code")}
          title={props.opening ? t("Claude Code is starting") : t("Restart Claude Code in this terminal — the conversation is resumed; text typed and not sent is lost")}
          onClick={() => void restartChatPty(props.chatId)}
          data-testid="Terminal chat restart"
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {finding && <TerminalFind ptyId={props.ptyId} onClose={() => setFinding(false)} />}
      <div className="terminal-body" onDragOver={(e) => acceptTerminalDrop(e)} onDrop={(e) => dropOnTerminal(e, props.ptyId, status.running && !disconnected)}>
        <TerminalView ptyId={props.ptyId} label={t("Terminal chat — Claude Code itself runs in this chat")} testId="Terminal chat terminal" />
        {overlay && (
          <div className="terminal-overlay" data-testid="Terminal chat overlay">
            <div className="terminal-overlay-panel">
              <div className="terminal-overlay-title row" role="status" data-testid="Terminal chat exited">
                <Icon name="terminal" size={16} />
                <span>{overlay.title}</span>
              </div>
              {overlay.hint && (
                <div className="caption muted" data-testid="Terminal chat trust hint">
                  {overlay.hint}
                </div>
              )}
              {/* No Enter shortcut and no autofocus: a key meant for the terminal must never restart it (risk 13). */}
              <button
                type="button"
                className="primary"
                disabled={props.opening}
                title={props.opening ? t("Claude Code is starting") : t("Start Claude Code again in this terminal — the conversation is resumed")}
                onClick={() => void restartChatPty(props.chatId)}
                data-testid="Terminal chat restart after exit"
              >
                {t("Restart")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * §58: "Accept N & Continue" in a terminal chat — the files accepted, then "Continue." pasted into Claude Code and Enter
 * pressed (the user's click only). Off with its reason until Claude Code is idle at its prompt.
 */
/** §64: Claude Code's edits were denied while files wait — the chat's quiet row, as a chip; a click opens the review. */
function ReviewFirstChip() {
  const path = useStore((s) => firstWaitingPath(s.state));
  const selectFile = useStore((s) => s.selectFile);
  if (!path) return null;
  return (
    <button type="button" className="small terminal-review-first" onClick={() => selectFile(path)} title={reviewFirstBlockedHelp()} aria-label={reviewFirstBlockedText()} data-testid="Terminal review-first chip">
      <span className="long truncate">{reviewFirstBlockedText()} · {openReviewTitle()}</span>
      <span className="short truncate">{openReviewTitle()}</span>
    </button>
  );
}

function AcceptContinueButton(props: { ptyId: string; running: boolean }) {
  const state = useStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const count = state.gate.pendingCount;
  const blocker = terminalAcceptContinueBlocker(state, { shown: true, running: props.running, bracketed: acceptsPaste(props.ptyId) });
  const run = async (): Promise<void> => {
    setBusy(true);
    const why = await runTerminalAcceptContinue({
      accept: async () => {
        await engineRequest({ type: "accept_all" });
      },
      paste: (text) => pasteIntoTerminal(props.ptyId, text),
      enter: () => sendToTerminal(props.ptyId, "\r"),
      refusal: (e) => refusalOf(e).error,
    });
    setBusy(false);
    focusTerminal(props.ptyId);
    showToast(why ?? t("Accepted {0} files — Claude continues", count));
  };
  return (
    <button
      type="button"
      className="small"
      disabled={blocker !== null || busy}
      title={blocker ?? t("Accepts the {0} pending file(s), then types “Continue.” into Claude Code with Enter", count)}
      aria-label={t("Accept and continue")}
      onClick={() => void run()}
      data-testid="Terminal chat accept and continue"
    >
      {t("Accept {0} & Continue", count)}
    </button>
  );
}

/** §57.5: files (Explorer / Finder) or review-list rows dragged over the terminal: taken as a copy. */
function acceptTerminalDrop(e: React.DragEvent<HTMLDivElement>): boolean {
  const types = e.dataTransfer.types;
  if (!types.includes("Files") && !types.includes(MENTION_DRAG_TYPE)) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  return true;
}

/**
 * §57.5: a drop on the terminal — review-list rows as `@path`, files as their paths (quoted as the platform's terminal
 * writes them) — one bracketed paste, never Enter; the terminal takes the keyboard. Why not, as a toast.
 */
function dropOnTerminal(e: React.DragEvent<HTMLDivElement>, ptyId: string, running: boolean): void {
  if (!acceptTerminalDrop(e)) return;
  const mentions = droppedMentionPaths(e.dataTransfer);
  const files = Array.from(e.dataTransfer.files ?? []).map((f) => window.rg.pathForFile?.(f) ?? "");
  const text = mentions.length > 0 ? mentionText(mentions) : dropText(files, window.rg.platform ?? "win32");
  if (!text) return;
  const why = pasteRefusal({ liveTerminalChat: true, running, bracketed: acceptsPaste(ptyId) }, text);
  if (why !== null || !pasteIntoTerminal(ptyId, text)) {
    showToast(why ?? pasteRefusal({ liveTerminalChat: true, running: true, bracketed: false }, text) ?? "");
    return;
  }
  focusTerminal(ptyId);
}

/** "Review now": `terminal_end_turn` — a refusal other than `no_turn` (it closed meanwhile) says why. */
async function endTerminalTurn(sessionId: string): Promise<void> {
  try {
    await engineRequest({ type: "terminal_end_turn", sessionId });
  } catch (e) {
    const r = refusalOf(e);
    useStore.setState((st) => ({ logs: [...st.logs, `[warn] terminal_end_turn: ${r.error}`].slice(-500) }));
    if (r.code === "no_turn") return;
    const message = terminalStartRefusal(r.code, r.detail) ?? r.error;
    useStore.setState({ lastError: message, errorBanner: { message, scope: "session", fatal: false } });
  }
}

/** "Find in terminal": next / previous match in the terminal's buffer; Esc closes and gives the keyboard back. */
function TerminalFind(props: { ptyId: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const close = () => {
    clearTerminalFind(props.ptyId);
    props.onClose();
    focusTerminal(props.ptyId);
  };
  const find = (backwards: boolean) => void findInTerminal(props.ptyId, query, backwards).then((found) => setMissing(query.length > 0 && !found));
  return (
    <div className="terminal-find row" role="search" data-testid="Terminal find">
      <input
        ref={input}
        value={query}
        placeholder={t("Find in terminal")}
        aria-label={t("Find in terminal")}
        aria-invalid={missing}
        onChange={(e) => {
          setQuery(e.target.value);
          setMissing(false);
        }}
        onKeyDown={(e) => {
          if (isEnter(e)) {
            e.preventDefault();
            find(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        data-testid="Terminal find input"
      />
      {missing && <span className="caption orange" role="status">{t("No matches")}</span>}
      <button type="button" className="plain small" disabled={!query} aria-label={t("Previous match")} title={t("Previous match")} onClick={() => find(true)}>
        ↑
      </button>
      <button type="button" className="plain small" disabled={!query} aria-label={t("Next match")} title={t("Next match")} onClick={() => find(false)}>
        ↓
      </button>
      <button type="button" className="plain small" aria-label={t("Close find")} title={t("Close find")} onClick={close}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** The engine refused to start the terminal (an old CLI, hooks turned off, no CLI …): why, and Try Again. */
function TerminalStartProblem(props: { chatId: string; message: string }) {
  const opening = useTerminalChats((s) => s.bySession[props.chatId]?.opening ?? false);
  return (
    <div className="terminal-chat terminal-problem" data-testid="Terminal chat start problem">
      <div className="terminal-overlay-title row">
        <Icon name="warning" size={16} />
        <span>{t("Claude Code could not start here")}</span>
      </div>
      <div className="caption muted selectable" data-testid="Terminal chat start problem message">
        {props.message}
      </div>
      <button
        type="button"
        disabled={opening}
        title={opening ? t("Claude Code is starting") : t("Ask ReviewGate's engine again how to start Claude Code for this chat")}
        onClick={() => void restartChatPty(props.chatId)}
        data-testid="Terminal chat try again"
      >
        {t("Try Again")}
      </button>
    </div>
  );
}

/** A terminal chat shown read-only: its terminal runs only while it is the live chat. */
function ViewedTerminalChat() {
  return (
    <div className="terminal-chat" data-testid="Viewed terminal chat">
      <div className="terminal-viewed grow">
        <Icon name="terminal" size={28} />
        <h3>{t("This chat runs Claude Code in a terminal")}</h3>
        <div className="caption muted">{t("Its terminal runs while it is the live chat. Continue in it to start Claude Code again — the conversation is resumed.")}</div>
      </div>
      <ViewingChatBar />
    </div>
  );
}

/** The terminal chats that showed the reviewed hint in this window (they keep it while on screen). */
const hintChats = new Set<string>();

/** §57.5: the reviewed hint shows in the first few terminal chats that reach it, or until the user closes it (per user). */
function useReviewedHint(chatId: string, reviewed: boolean): { shows: boolean; dismiss: () => void } {
  const [stored, setStored] = useState(readReviewedHint);
  useEffect(() => {
    if (!reviewed || !countsReviewedHint(stored.count, stored.dismissed, hintChats.has(chatId))) return;
    hintChats.add(chatId);
    const next = { ...stored, count: stored.count + 1 };
    writeReviewedHint({ count: next.count });
    setStored(next);
  }, [chatId, reviewed, stored]);
  return {
    shows: showsReviewedHint(stored.count, stored.dismissed, hintChats.has(chatId)),
    dismiss: () => {
      writeReviewedHint({ dismissed: true });
      setStored((v) => ({ ...v, dismissed: true }));
    },
  };
}
