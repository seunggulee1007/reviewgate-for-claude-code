/**
 * The side panel (docs/PROTOCOL.md §21): a drawer right of the chat — docked on wide windows, over the chat on
 * narrow ones. Three views: the current chat's threads (anchor chip, title, status, cost), a new question about an
 * anchor (prefilled "왜 이렇게 바꿨어?", Enter asks it), and one thread (anchor context, streaming markdown answer,
 * compact tool calls, follow-up input, cancel, close, and promote to the main conversation / a review note).
 * MARK: wave3 desktop-agents — §36.10: a thread asked while a turn ran says "턴 N 진행 중 — 요약만 전달됨" in its head (the
 * tooltip says what it got), and the new-question view says what a question asked now would know — never the review list.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DiffHunk, DiffLine, SideAnchor, SideThread, SideToolCall } from "@reviewgate/engine";
import { relativeTime, t } from "../../i18n";
import { formatUSD } from "../chat/HUDStrip";
import { Markdown } from "../chat/Markdown";
import { toolDetail, toolIcon } from "../chat/ToolRows";
import { isRunning, useStore, type ChatItem } from "../../store";
import { anchorLabel, anchorTitle, lastPromotion, quickQuestions, runningCount, sameAnchor, totalCost, type SideLive } from "../../sideThreads";
import { anchorToolName, newQuestionChips } from "../../chatFollowups"; // MARK: wave4 w4-check3
import { PromoteDialog } from "./PromoteDialog";
import { prHunkPreview } from "../../prClaude"; // MARK: wave3 desktop-flow
import { useSideThreads } from "./SideAsk";
import "../chat/chat.css";
import "./side.css";
// MARK: wave3 desktop-agents — §36.10
import { newQuestionHint, runningTurnChip, runningTurnHelp } from "../../agentDetails";
import { forkIsBehind, forkPointLabel, reforkQuestion } from "../../sideTrust"; // MARK: wave4b w4b-side
import "../agents/agentDetail.css";
import { isEnter } from "../../ime";
import { sideThreadKey } from "../../keymap";
import { transcriptShape } from "../../transcriptShape"; // MARK: wave4d w4d-speed

export function SidePanel() {
  const view = useStore((s) => s.sideView);
  const toggle = useStore((s) => s.toggleSidePanel);
  const showList = useStore((s) => s.showSideList);
  const askAbout = useStore((s) => s.askAbout);
  const side = useStore((s) => s.side);
  const hudCost = useStore((s) => s.state.hud.sideCostUSD);
  const draft = useStore((s) => s.promoteDraft);
  const threads = useSideThreads();
  const running = runningCount(side);
  const cost = hudCost ?? totalCost(side);

  // Esc closes the panel when nothing inside it has focus-specific Esc handling.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || useStore.getState().dialog || useStore.getState().promoteDraft) return;
      const el = document.activeElement;
      if (el && el.closest(".side-panel") && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      if (el && el.closest(".side-panel")) toggle(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <aside className="side-panel" data-testid="Side panel" aria-label={t("Side questions")}>
      <header className="side-head">
        {view.kind !== "list" ? (
          <button type="button" className="plain small side-back" onClick={showList} title={t("All side questions")} data-testid="Side back">
            ‹ {t("List")}
          </button>
        ) : (
          <span className="side-title">
            <span className="side-glyph" aria-hidden="true">?</span>
            {t("Side questions")}
          </span>
        )}
        <span className="spacer" />
        {running > 0 && (
          <span className="pill side-running" title={t("{0} answering", running)}>
            <span className="spinner" aria-hidden="true" /> {running}
          </span>
        )}
        {cost > 0 && <span className="pill gray num" title={t("Side questions cost so far — not part of the session cost")} data-testid="Side cost">{formatUSD(cost)}</span>}
        {view.kind !== "new" && (
          <button type="button" className="small" onClick={() => askAbout(null)} title={t("Ask about the conversation in general")} data-testid="Side new">
            + {t("New question")}
          </button>
        )}
        <button type="button" className="plain small" onClick={() => toggle(false)} title={t("Close the panel (threads are kept)")} aria-label={t("Close")} data-testid="Side close panel">
          ✕
        </button>
      </header>
      {view.kind === "list" && <ThreadList threads={threads} />}
      {view.kind === "new" && <NewQuestion key={view.nonce} anchor={view.anchor} question={view.question} context={view.context} />}
      {view.kind === "thread" && <ThreadView key={view.threadId} threadId={view.threadId} />}
      {draft && <PromoteDialog />}
    </aside>
  );
}

// ---------------------------------------------------------------- list

function ThreadList({ threads }: { threads: SideThread[] }) {
  const open = useStore((s) => s.openSideThread);
  const notice = useStore((s) => s.sideNotice);
  if (threads.length === 0) {
    return (
      <div className="side-empty" data-testid="Side empty">
        <div className="side-empty-glyph" aria-hidden="true">?</div>
        <div className="bold">{t("Ask “why?” without interrupting Claude")}</div>
        <div className="caption muted">
          {t("Use the ? buttons on a file, a part of the diff, a line or a tool call — or select lines and press ⌥⌘/. The answer comes from a read-only copy of the conversation; send the conclusion to Claude when you are ready.")}
        </div>
        {notice && <div className="side-notice">{notice}</div>}
      </div>
    );
  }
  return (
    <ul className="side-list scroll" data-testid="Side threads">
      {threads.map((th) => {
        const label = anchorLabel(th.anchor);
        const promoted = lastPromotion(th);
        return (
          <li key={th.id}>
            <button type="button" className="side-row" onClick={() => open(th.id)} title={`${th.title}\n${anchorTitle(th.anchor)}`} data-testid={`Side thread ${th.title}`}>
              <StatusDot status={th.status} />
              <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
                <span className="side-row-title truncate">{th.title || t("(untitled)")}</span>
                <span className="row" style={{ gap: 5 }}>
                  {label && <span className="anchor-chip truncate">{label}</span>}
                  <span className="tiny faint">{relativeTime(th.updatedAt)}</span>
                  {promoted && <span className="pill green">{promoted.as === "note" ? t("Note added ✓") : t("Sent to main ✓")}</span>}
                </span>
              </span>
              {th.costUSD > 0 && <span className="tiny faint num">{formatUSD(th.costUSD)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StatusDot({ status }: { status: SideThread["status"] }) {
  if (status === "running") return <span className="spinner side-dot" title={t("Answering…")} />;
  return <span className={`status-dot side-dot ${status === "error" ? "red" : "green"}`} title={status === "error" ? t("Failed") : t("Answered")} />;
}

// ---------------------------------------------------------------- anchor context

/** The anchor's place: chip + full title + the diff lines / tool call it points at (collapsed by default). */
function AnchorContext({ anchor, context, defaultOpen = false }: { anchor: SideAnchor | null; context?: string; defaultOpen?: boolean }) {
  const preview = useAnchorPreview(anchor);
  const label = anchorLabel(anchor);
  const [open, setOpen] = useState(defaultOpen);
  const reveal = useStore((s) => s.revealFile);
  const revealToolUse = useStore((s) => s.revealToolUse);
  const live = useStore((s) => (anchor?.path ? s.state.changedFiles.some((f) => f.path === anchor.path) : false));
  // MARK: wave3 desktop-flow — §36.14: a PR hunk without a header to number from is shown as it came.
  const text = context ?? anchor?.pr?.hunk;
  const has = preview.lines.length > 0 || preview.tool !== null || !!text;
  return (
    <div className="side-anchor" data-testid="Side anchor">
      <div className="row" style={{ gap: 6 }}>
        <span className={`anchor-chip ${label ? "" : "none"}`}>{label ?? t("General")}</span>
        <span className="caption muted truncate grow" title={anchorTitle(anchor)}>{anchorTitle(anchor)}</span>
        {anchor?.path && live && !anchor.entryId && (
          <button type="button" className="plain tiny" onClick={() => reveal(anchor.path!)} title={t("Show the diff")}>{t("diff")} ↗</button>
        )}
        {anchor?.toolUseId && (
          <button type="button" className="plain tiny" onClick={() => revealToolUse(anchor.toolUseId!)} title={t("Show in the conversation")}>{t("call")} ↗</button>
        )}
        {has && (
          <button type="button" className="plain tiny" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="Side anchor toggle">
            {open ? "▾" : "▸"} {t("Context")}
          </button>
        )}
      </div>
      {open && has && (
        <div className="side-anchor-body">
          {preview.tool && (
            <div className="side-anchor-tool">
              <span aria-hidden="true">{toolIcon(preview.tool.name)}</span>
              <span className="bold">{preview.tool.name}</span>
              <span className="mono truncate grow">{preview.tool.detail}</span>
            </div>
          )}
          {preview.tool?.rationale && <div className="side-anchor-why">“{preview.tool.rationale}”</div>}
          {preview.lines.length > 0 && (
            <div className="side-anchor-diff mono">
              {preview.lines.map((l) => (
                <div key={l.id} className={`l ${l.kind} ${preview.focus === l.id ? "focus" : ""}`}>
                  <span className="no">{l.kind === "del" ? (l.oldNo ?? "") : (l.newNo ?? "")}</span>
                  <span className="s">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunkHeader" ? "" : " "}</span>
                  <span className="x">{l.text}</span>
                </div>
              ))}
            </div>
          )}
          {text && preview.lines.length === 0 && !preview.tool && <pre className="side-anchor-text mono">{text}</pre>}
        </div>
      )}
    </div>
  );
}

type Preview = { lines: DiffLine[]; focus: number | null; tool: { name: string; detail: string; rationale?: string } | null };

const MAX_PREVIEW = 14;

/** The diff lines around the anchor (from the loaded diff of the file / history view) and its tool call. */
function useAnchorPreview(anchor: SideAnchor | null): Preview {
  const diff = useStore((s) => {
    if (!anchor?.path) return null;
    if (anchor.entryId) return s.historyView?.entry.id === anchor.entryId && s.historyView.path === anchor.path ? s.historyView.diff : null;
    return s.diffCache[anchor.path] ?? (s.selectedPath === anchor.path ? s.selectedDiff : null);
  });
  const transcript = useStore((s) => transcriptShape(s.transcript)); // MARK: wave4d w4d-speed — tool rows only: not per delta
  const root = useStore((s) => s.state.project?.root ?? null);
  return useMemo(() => {
    let tool: Preview["tool"] = null;
    if (anchor?.toolUseId) {
      const use = transcript.find((i): i is Extract<ChatItem, { kind: "toolUse" }> => i.kind === "toolUse" && i.toolUseId === anchor.toolUseId);
      if (use) tool = { name: use.name, detail: toolDetail(use.name, use.file, use.input, root), ...(use.rationale ? { rationale: use.rationale } : {}) };
    }
    // MARK: wave3 desktop-flow — §36.14: a PR anchor carries its hunk; it is read back like a review anchor's lines.
    if (anchor?.pr) {
      const pr = prHunkPreview(anchor.pr);
      if (pr) return { lines: pr.lines, focus: pr.focus, tool };
    }
    if (!diff || !anchor?.path || diff.isBinary) return { lines: [], focus: null, tool };
    const hunk: DiffHunk | undefined =
      anchor.hunkId !== undefined
        ? diff.hunks.find((h) => h.id === anchor.hunkId)
        : anchor.line !== undefined
          ? diff.hunks.find((h) => h.lines.some((l) => (anchor.side === "old" ? l.oldNo === anchor.line : l.newNo === anchor.line)))
          : undefined;
    if (!hunk) return { lines: [], focus: null, tool };
    const body = hunk.lines.filter((l) => l.kind !== "hunkHeader");
    if (anchor.line === undefined) return { lines: body.slice(0, MAX_PREVIEW), focus: null, tool };
    const at = body.findIndex((l) => (anchor.side === "old" ? l.kind !== "add" && l.oldNo === anchor.line : l.kind !== "del" && l.newNo === anchor.line));
    const from = Math.max(0, at - 4);
    return { lines: body.slice(from, from + 9), focus: at >= 0 ? body[at]!.id : null, tool };
  }, [diff, anchor, transcript, root]);
}

// ---------------------------------------------------------------- new question

function NewQuestion({ anchor, question, context }: { anchor: SideAnchor | null; question: string; context?: string }) {
  const sideAsk = useStore((s) => s.sideAsk);
  const asking = useStore((s) => s.sideAsking);
  const notice = useStore((s) => s.sideNotice);
  const open = useStore((s) => s.openSideThread);
  const threads = useSideThreads();
  const [text, setText] = useState(question || (anchor ? t("Why did you change it like this?") : ""));
  const ref = useRef<HTMLTextAreaElement>(null);
  const related = anchor ? threads.filter((th) => sameAnchor(th.anchor, anchor)) : [];
  // MARK: wave3 desktop-agents — §36.10: what a question asked now would know (only said while a turn runs).
  const forkHint = useStore((s) => newQuestionHint(isRunning(s.state)));
  // MARK: wave4 w4-check3 — a subagent's call gets questions about its work (the prefilled one is not repeated).
  const toolName = useStore((s) => anchorToolName(anchor, s.transcript, s.state.hud.agents ?? []));
  const chips = newQuestionChips(anchor, toolName).filter((q) => q !== question);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const ask = (q = text) => {
    if (!q.trim() || asking) return;
    void sideAsk(q, { anchor });
  };
  return (
    <div className="side-body scroll" data-testid="Side new question">
      <AnchorContext anchor={anchor} context={context} defaultOpen />
      {related.length > 0 && (
        <div className="side-related">
          <span className="caption muted">{t("Already asked here:")}</span>
          {related.slice(0, 3).map((th) => (
            <button key={th.id} type="button" className="plain tiny truncate" onClick={() => open(th.id)} title={th.title}>
              ↪ {th.title}
            </button>
          ))}
        </div>
      )}
      <div className="side-compose">
        <textarea
          ref={ref}
          value={text}
          placeholder={t("Ask about this change — Claude answers next to the main conversation, without changing anything.")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          rows={3}
          data-testid="Side question input"
        />
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {chips.map((q) => (
            <button key={q} type="button" className="side-chip" disabled={asking} onClick={() => ask(q)}>
              {q}
            </button>
          ))}
          <span className="spacer" />
          <button type="button" className="primary small" disabled={!text.trim() || asking} onClick={() => ask()} data-testid="Side ask">
            {asking ? <span className="spinner" aria-hidden="true" /> : null} {t("Ask")} <kbd>↩</kbd>
          </button>
        </div>
        <div className="tiny faint">{t("Read-only: the side question can look at files but never change them. The main conversation does not see it unless you send it.")}</div>
        {forkHint && <div className="tiny muted side-fork-hint" data-testid="Side fork hint">{forkHint}</div>}
      </div>
      {notice && <div className="side-notice" data-testid="Side notice">{notice}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- thread

function ThreadView({ threadId }: { threadId: string }) {
  const th = useStore((s) => s.side.threads[threadId]);
  const live = useStore((s) => s.side.live[threadId]);
  const notice = useStore((s) => s.sideNotice);
  const sideAsk = useStore((s) => s.sideAsk);
  const cancel = useStore((s) => s.sideCancel);
  const close = useStore((s) => s.sideClose);
  const startPromote = useStore((s) => s.startPromote);
  const queued = useStore((s) => s.sideQueued[threadId] === true);
  const noteable = useStore((s) => (th?.anchor?.path && !th.anchor.entryId ? s.state.changedFiles.some((f) => f.path === th.anchor!.path) : false));
  // MARK: wave4b w4b-side — §40.3: the chat's finished turns (its record's `turns` outlives a session switch; else the HUD's), as the Mac
  const mainTurn = useStore((s) => {
    const meta = s.state.sessions?.list.find((m) => m.id === s.state.sessions?.currentId);
    return Math.max(meta?.turns ?? 0, s.state.hud?.turnCount ?? 0);
  });
  const [text, setText] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [th?.messages.length, live?.text, live?.toolCalls.length]);

  if (!th) return <div className="side-empty caption muted">{t("This side thread no longer exists.")}</div>;
  const running = th.status === "running";
  const hasAnswer = th.messages.some((m) => m.role === "assistant" && m.text.trim().length > 0);
  const promoted = lastPromotion(th);
  const runningChip = runningTurnChip(th.fork); // MARK: wave3 desktop-agents — §36.10
  // MARK: wave4b w4b-side — §40.3 the fork point and [최신 대화로 다시 묻기]
  const forkLabel = forkPointLabel(th);
  const behind = forkIsBehind(th, mainTurn);
  const reforkQ = reforkQuestion(th, text);
  const refork = () => {
    if (running || reforkQ === null) return;
    void sideAsk(reforkQ, { threadId, refork: true }).then((err) => err === null && setText(""));
  };

  const send = (q = text) => {
    if (!q.trim() || running) return;
    void sideAsk(q, { threadId }).then((err) => err === null && setText(""));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // wave4 w4-input (polish-06): ⌘↩ (Ctrl+Enter) sends the conclusion to the main conversation, ⌥⌘↩ adds it as a review note.
    const promote = sideThreadKey(e);
    if (promote) {
      e.preventDefault();
      if (!hasAnswer || running) return;
      if (promote === "message" || noteable) void startPromote(threadId, promote);
      return;
    }
    if (isEnter(e) && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="side-thread" data-testid="Side thread view">
      <div className="side-thread-head">
        <div className="row" style={{ gap: 6 }}>
          <StatusDot status={th.status} />
          <span className="bold truncate grow" title={th.title}>{th.title || t("(untitled)")}</span>
          {th.costUSD > 0 && <span className="tiny faint num" title={t("Cost of this thread")}>{formatUSD(th.costUSD)}</span>}
          {confirmClose ? (
            <span className="row" style={{ gap: 4 }}>
              <button type="button" className="small danger" onClick={() => void close(threadId)} data-testid="Side confirm close">{t("Delete")}</button>
              <button type="button" className="plain small" onClick={() => setConfirmClose(false)}>{t("Cancel")}</button>
            </span>
          ) : (
            <button type="button" className="plain small" onClick={() => setConfirmClose(true)} title={t("Close this thread (deletes it)")} aria-label={t("Close this thread (deletes it)")} data-testid="Side close thread">🗑</button>
          )}
        </div>
        {/* MARK: wave3 desktop-agents — §36.10 */}
        {runningChip && (
          <div className="row" style={{ gap: 6 }}>
            <span className="pill side-running-turn" title={runningTurnHelp(th.fork)} data-testid="Side running turn">{runningChip}</span>
          </div>
        )}
        {/* MARK: wave4b w4b-side — §40.3 */}
        {th.messages.length > 0 && (
          <div className="row side-fork-point" style={{ gap: 6 }}>
            {forkLabel && (
              <span className={`pill${behind ? " orange" : ""}`} title={behind ? t("The main conversation went on since — this thread does not know the later turns.") : t("This thread knows the main conversation up to this turn.")} data-testid="Side fork point">
                {forkLabel}
              </span>
            )}
            <button
              type="button"
              className="plain small"
              disabled={running || reforkQ === null}
              onClick={refork}
              title={running ? t("Wait for the answer first.") : t("Asks again with the main conversation as it is now (the earlier questions and answers go along).")}
              data-testid="Side refork"
            >
              ↻ {t("Ask again with the latest conversation")}
            </button>
          </div>
        )}
        <AnchorContext anchor={th.anchor} />
      </div>
      <div
        className="side-messages scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        data-testid="Side messages"
      >
        {th.fork?.mode === "fresh" && !runningChip && <div className="tiny faint side-fork">{t("Started without the main conversation (no finished turn yet) — the anchor context is all it knows.")}</div>}
        {th.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="side-msg user">{m.text}</div>
          ) : (
            <div key={i} className="side-msg assistant">
              {m.toolCalls && m.toolCalls.length > 0 && <ToolCalls calls={m.toolCalls} />}
              {m.text ? <Markdown text={m.text} /> : m.stopReason === "interrupted" ? <span className="caption faint">{t("(stopped)")}</span> : null}
              {m.stopReason === "interrupted" && m.text && <div className="tiny faint">{t("(stopped)")}</div>}
            </div>
          ),
        )}
        {running && <LiveAnswer live={live} />}
        {th.status === "error" && (
          <div className="side-error" data-testid="Side error">
            <span className="bold">{t("The side question failed")}</span>
            {th.error && <span className="caption mono">{th.error}</span>}
            <span className="caption">{t("The thread is still usable — ask again below.")}</span>
          </div>
        )}
        {(promoted || queued) && (
          <div className="side-promoted" data-testid="Side promoted">
            {(queued && !promoted) || promoted?.queued /* MARK: wave4b w4b-side — §40.3 the engine's record */
              ? "⏳ " + t("Queued for the main conversation")
              : promoted?.as === "note"
                ? "✓ " + t("Added as a review note")
                : "✓ " + t("Sent to the main conversation")}
            {promoted && <span className="tiny faint"> · {relativeTime(promoted.at)}</span>}
          </div>
        )}
      </div>
      {notice && <div className="side-notice" data-testid="Side notice">{notice}</div>}
      <div className="side-footer">
        {hasAnswer && !running && (
          <div className="side-promote-row">
            <button type="button" className="primary small" onClick={() => void startPromote(threadId, "message")} title={t("{0} ({1})", t("Turn the conclusion into an instruction for Claude (you edit it first)"), "⌘↩")} data-testid="Promote message">
              ↗ {t("Send to the main conversation")}
            </button>
            <button
              type="button"
              className="small"
              disabled={!noteable}
              onClick={() => void startPromote(threadId, "note")}
              title={noteable ? t("{0} ({1})", t("Add the conclusion as a review note on the anchored line (sent with Request changes)"), "⌥⌘↩") : t("Only for a thread about a file of the current review")}
              data-testid="Promote note"
            >
              ✎ {t("Add as a review note")}
            </button>
          </div>
        )}
        <div className="side-compose follow">
          <textarea
            value={text}
            placeholder={running ? t("Answering… you can type the next question") : t("Ask a follow-up…")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            data-testid="Side follow-up input"
          />
          <div className="row" style={{ gap: 6 }}>
            {!running && hasAnswer && (
              <span className="row wrap" style={{ gap: 4, minWidth: 0 }}>
                {quickQuestions().slice(1).map((q) => (
                  <button key={q} type="button" className="side-chip" onClick={() => send(q)}>{q}</button>
                ))}
              </span>
            )}
            <span className="spacer" />
            {running ? (
              <button type="button" className="small" onClick={() => cancel(threadId)} data-testid="Side cancel">■ {t("Stop")}</button>
            ) : (
              <button type="button" className="primary small" disabled={!text.trim()} onClick={() => send()} data-testid="Side send follow-up">
                {t("Ask")} <kbd>↩</kbd>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveAnswer({ live }: { live: SideLive | undefined }) {
  const text = live?.text ?? "";
  return (
    <div className="side-msg assistant streaming" data-testid="Side streaming">
      {live && live.toolCalls.length > 0 && <ToolCalls calls={live.toolCalls} />}
      {text ? <Markdown text={text} /> : <span className="caption faint">{t("Thinking…")}</span>}
      <span className="cursor" aria-hidden="true" />
    </div>
  );
}

function ToolCalls({ calls }: { calls: SideToolCall[] }) {
  const root = useStore((s) => s.state.project?.root ?? null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="side-tools">
      {calls.map((c) => {
        const detail = toolDetail(c.name, typeof c.input["file_path"] === "string" ? (c.input["file_path"] as string) : undefined, c.input, root);
        return (
          <div key={c.id} className="side-tool">
            <button type="button" className={`side-tool-row ${c.isError ? "error" : ""}`} onClick={() => setOpen(open === c.id ? null : c.id)} title={c.preview ?? ""}>
              <span className="icon" aria-hidden="true">{toolIcon(c.name)}</span>
              <span className="name">{c.name}</span>
              <span className="mono detail truncate">{detail}</span>
              {c.denied ? (
                <span className="pill orange" title={t("Side questions are read-only — this tool was refused")}>{t("read-only")}</span>
              ) : c.preview === undefined ? (
                <span className="spinner" aria-hidden="true" />
              ) : c.isError ? (
                <span className="red tiny">✕</span>
              ) : (
                <span className="green tiny">✓</span>
              )}
            </button>
            {open === c.id && c.preview && <pre className="side-tool-out mono">{c.preview}</pre>}
          </div>
        );
      })}
    </div>
  );
}
