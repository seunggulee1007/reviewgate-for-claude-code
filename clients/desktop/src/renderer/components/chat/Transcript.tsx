/**
 * The chat transcript: one row per `ChatItem`, the empty state with the live budget, and auto-scroll to the
 * bottom on new items unless the user has scrolled up. Assistant text streams as plain text and switches to
 * Markdown (M16) once the message is complete. A subagent's tool rows (`parentToolUseId`) nest under the
 * Agent/Task row that spawned it (`AgentGroup`, recursive); diff → cause scrolls to a row (`transcriptFocus`).
 * Scrolled up, a "↓ Latest (N)" pill jumps back; Ctrl/⌘F opens a find bar (`FindBar`) over the rows.
 * Rows are not virtualized on purpose: find, the highlight ranges and scroll-to-row need every row in the DOM.
 * MARK: wave3 desktop-agents — §36: a group head carries the model chip, "재개됨(N회차)", hover ■ and a ⋯ / right-click menu
 * (에이전트 상세 · 이 에이전트 중지); a §36 result is the cleaned report as markdown with "보고서 전체 보기"; a SendMessage
 * that continues a known agent reads "executor에게 이어서: …" and opens that agent's group, which also opens by itself while
 * the continued agent works.
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentNode } from "@reviewgate/engine";
import { descendantIds, indexTranscript, isAgentTool, isLive, nestedCallCount, statusTone, type ToolResultItem, type ToolUseItem, type TranscriptIndex } from "../../agents";
import { t } from "../../i18n";
import { isRunning, useStore, type ChatItem } from "../../store";
import { EMPTY_FIND, matchOffsets, planFind, stepIndex } from "../../transcriptFind";
import { FindContext, type FindReveal } from "./findContext";
import { AgentChip } from "../agents/AgentPanel";
import { Markdown } from "./Markdown";
import { AwaitingPermissionBadge } from "./PermissionBits";
import { PermissionLine } from "./PermissionLine"; // MARK: r2-review-flow (M27)
import { QuestionCard } from "./QuestionCard";
import { BudgetRow, ToolResultRow, ToolUseRow } from "./ToolRows";
import { budgetIsOn } from "./BudgetBadge"; // §54
import { TurnSummaryCard } from "./TurnSummaryCard";
import { UserMessage } from "./UserMessage";
import { ErrorNoticeRow } from "./ErrorNoticeRow";
import { PeerMessageRow } from "./PeerMessageRow";
import { AutoTurnRowView } from "./AutoTurnRow"; // MARK: §52
// MARK: wave3 desktop-agents
import { agentViewOf, continuationCounts } from "../../agentDetails";
import { shownAgentResult } from "../../agentMeta"; // §52.2
import { useAgentUi } from "../../agentUi";
import { AgentMenuButton, AgentReportRow, collapsedLine, ContinueRow, ModelChip, ResumedBadge, StopAgentButton, useAgentContextMenu, useAgentMenuItems } from "../agents/AgentBits";
import { OlderRowsBar } from "./OlderRows"; // MARK: wave4 w4-history (§38.3)
// MARK: wave4b w4b-tabs (§39.2)
import { foldExplore } from "../../exploreFold";
import { revealStaysInViewedChat, stopViewing, useViewedChat, useViewing } from "../../viewedChat";
import { ExploreRunRow, ViewedChatHeader } from "./ViewingChat";
import { isEnter } from "../../ime";
import { finishedLine, groupFiles } from "../../agentGlance"; // MARK: wave4b w4b-agents
import { QuotableMarkdown } from "../side/QuoteMenu"; // MARK: wave4b w4b-side
import { TurnEndRow } from "./TurnEndRow"; // MARK: wave4c w4c-commit (§41.1)
import { liveAssistant, transcriptShape, type AssistantItem } from "../../transcriptShape"; // MARK: wave4d w4d-speed

const STICKY_THRESHOLD = 24;

const IndexContext = createContext<TranscriptIndex>({ uses: new Map(), results: new Map(), children: new Map(), top: [] });
/** wave3 desktop-agents — §36.3: SendMessage continuations per Agent call (the resume count once its node is gone). */
const ContinuationContext = createContext<Map<string, number>>(new Map());
/**
 * MARK: wave4d w4d-speed — polish-09: keeps the view at the bottom while the streaming answer grows. The list does not redraw
 * on a delta (`transcriptShape`), so the answer's own row asks for it.
 */
const PinContext = createContext<() => void>(() => undefined);

/** Rows in order; an Agent/Task call becomes a group and its own result is shown inside that group. */
function Rows({ items, root, nested, fold }: { items: ChatItem[]; root: string | null | undefined; nested?: boolean; fold?: { running: boolean; focusId: string | null } }) {
  const index = useContext(IndexContext);
  // MARK: wave4b w4b-tabs — §39.2 (market-12): a run of reads / searches is one "탐색: …" row (exploreFold.ts)
  if (fold) {
    return (
      <>
        {foldExplore(items).map((e) =>
          e.kind === "run" ? (
            <ExploreRunRow key={`run-${e.id}`} run={e} running={fold.running} forceOpen={fold.focusId !== null && e.items.some((i) => i.kind === "toolUse" && i.toolUseId === fold.focusId)}>
              <Rows items={e.items} root={root} nested={nested} />
            </ExploreRunRow>
          ) : (
            <Rows key={e.item.id} items={[e.item]} root={root} nested={nested} />
          ),
        )}
      </>
    );
  }
  return (
    <>
      {items.map((item) => {
        // MARK: wave3 desktop-agents — §36.3 "executor에게 이어서: …"
        if (item.kind === "toolUse" && item.name === "SendMessage" && item.continues) return <ContinueRow key={item.id} item={item} />;
        if (item.kind === "toolUse" && isAgentTool(item.name)) return <MemoAgentGroup key={item.id} item={item} root={root} nested={nested} />;
        if (item.kind === "toolResult") {
          const use = index.uses.get(item.toolUseId);
          if (use && isAgentTool(use.name)) return null;
        }
        // MARK: wave4d w4d-speed — polish-09: a memoized row gets its call's result / its result's tool name as props, so a
        // new tool call or result redraws the rows it concerns, not every row of the chat.
        return (
          <MemoRow
            key={item.id}
            item={item}
            root={root}
            nested={nested}
            result={item.kind === "toolUse" ? index.results.get(item.toolUseId) : undefined}
            toolName={item.kind === "toolResult" ? index.uses.get(item.toolUseId)?.name : undefined}
          />
        );
      })}
    </>
  );
}

const EMPTY_AGENTS: AgentNode[] = [];

/** A subagent call: header (type, description, status, nested call count) over its collapsible tool rows. */
function AgentGroup({ item, root, nested }: { item: ToolUseItem; root: string | null | undefined; nested?: boolean }) {
  const index = useContext(IndexContext);
  const agents = useStore((s) => s.state.hud.agents ?? EMPTY_AGENTS);
  const running = useStore((s) => isRunning(s.state));
  const focus = useStore((s) => s.transcriptFocus);
  const revealed = useContext(FindContext).expand.has(item.toolUseId);
  const agent = agents.find((a) => a.toolUseId === item.toolUseId);
  const result = shownAgentResult(index.results.get(item.toolUseId)); // §52.2: the launch is no result
  // MARK: wave3 desktop-agents — one view of the agent (its node, else its rows): §36.1–36.3
  const continuations = useContext(ContinuationContext).get(item.toolUseId) ?? 0;
  const view = agentViewOf({ node: agent, use: item, result, running, continuations });
  const status = view.status;
  const live = isLive(status);
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? live;
  const children = index.children.get(item.toolUseId) ?? [];
  const count = nestedCallCount(index, item.toolUseId);
  const type = view.label;
  const description = view.description;
  const prompt = view.prompt;
  const menuItems = useAgentMenuItems(item.toolUseId, agent);
  const menu = useAgentContextMenu(menuItems);
  const summaryLine = collapsedLine(view);
  // MARK: wave4b w4b-agents — agents-08: "✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2" (files: the node's, else its edit rows')
  const statsLine = finishedLine(status, view.usage, view.files.length > 0 ? view.files.length : groupFiles(index, item.toolUseId).length, view.stoppedByUser);
  const expandNonce = useAgentUi((s) => (s.expand?.toolUseId === item.toolUseId ? s.expand.nonce : 0));

  // Find: a hit inside this group (or in its report) opens it.
  useEffect(() => {
    if (revealed) setOverride(true);
  }, [revealed]);

  // MARK: wave3 desktop-agents — §36.3: a continued agent works again → its group follows it open; its SendMessage row opens it.
  useEffect(() => {
    if (view.resumeCount > 0) setOverride(null);
  }, [view.resumeCount]);
  useEffect(() => {
    if (expandNonce > 0) setOverride(true);
  }, [expandNonce]);

  // Diff → cause: a focused row inside this group opens it.
  useEffect(() => {
    if (!focus || open) return;
    if (focus.toolUseId === item.toolUseId) return;
    if (descendantIds(index, item.toolUseId).has(focus.toolUseId)) setOverride(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <div className={`agent-group tone-${statusTone(status)} ${nested ? "nested" : ""} ${open ? "open" : ""}`} data-testid="Agent group">
      <div
        className="agent-head"
        role="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        onContextMenu={menu.onContextMenu}
        title={prompt || description}
        data-tool-use-id={item.toolUseId}
      >
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="agent-icon" aria-hidden="true">◆</span>
        <span className="agent-type">{type}</span>
        <ModelChip model={view.model} />
        <span className="agent-desc truncate">{description}</span>
        <ResumedBadge count={view.resumeCount} />
        {agent?.isBackground && <span className="pill gray" title={t("Runs in the background")}>{t("background")}</span>}
        <span className="faint tiny num" title={t("{0} tool calls inside", count)}>{t("{0} calls", count)}</span>
        <AwaitingPermissionBadge agentToolUseId={item.toolUseId} />
        <AgentChip status={status} stoppedBy={view.stoppedByUser ? "user" : undefined} />
        <StopAgentButton node={agent} className="hover" />
        <AgentMenuButton items={menuItems} testId={`Agent menu ${item.toolUseId}`} />
      </div>
      {menu.menu}
      {open && (
        <div className="agent-body">
          {item.rationale && <div className="rationale">{item.rationale}</div>}
          {children.length === 0 && !result && <div className="faint caption">{live ? t("Waiting for the first tool call…") : t("No tool calls")}</div>}
          <Rows items={children} root={root} nested />
          {result &&
            (view.reportKept ? (
              <AgentReportRow result={result} view={view} />
            ) : (
              <ToolResultRow item={result} label={result.isError ? (view.stoppedByUser ? t("Stopped by you") : t("Agent failed")) : t("Agent report")} />
            ))}
        </div>
      )}
      {!open && statsLine && <div className="agent-stats-line truncate num" data-testid="Agent group stats">{statsLine}</div>}{/* MARK: wave4b w4b-agents */}
      {!open && summaryLine && <div className="agent-summary truncate" title={summaryLine}>{summaryLine}</div>}
    </div>
  );
}

/**
 * MARK: wave4d w4d-speed — polish-09: Claude's answer. While it streams, the row reads its own live text from the store (the
 * list keeps its rows through a delta, `transcriptShape`) and keeps the view at the bottom; a finished answer is its row's.
 */
export const AssistantMessage = memo(function AssistantMessage({ item: shown }: { item: AssistantItem }) {
  const item = useStore((s) => liveAssistant(s.transcript, shown));
  const pin = useContext(PinContext);
  useLayoutEffect(() => {
    if (item.streaming) pin();
  }, [item.streaming, item.text.length, pin]);
  // §18: text from a turn Claude Code ran by itself — shown apart, muted, with a badge.
  const badge = item.unprompted ? (
    <span className="unprompted-badge" title={t("Claude Code ran this turn on its own, without a request; changes it tried were blocked.")} data-testid="Unprompted badge">
      {t("Ran without a request")}
    </span>
  ) : null;
  const cls = item.unprompted ? " unprompted" : "";
  if (!item.streaming) {
    return (
      <div className={`msg assistant md${cls}`} data-testid="Assistant message">
        {badge}
        <QuotableMarkdown itemId={item.id} text={item.text} />{/* MARK: wave4b w4b-side — §40.3 right-click → 곁질문으로 묻기 */}
      </div>
    );
  }
  return (
    <div className={`msg assistant${cls} ${item.text.length === 0 ? "pending" : ""}`} data-testid="Assistant message">
      {badge}
      {item.text.length === 0 ? "…" : item.text}
      {item.text.length > 0 && <span className="cursor" aria-hidden="true" />}
    </div>
  );
});

function Row({ item, root, nested, result, toolName }: { item: ChatItem; root: string | null | undefined; nested?: boolean; result?: ToolResultItem; toolName?: string }) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} />; // MARK: wave4d w4d-speed
    case "toolUse":
      return <ToolUseRow item={item} result={result} root={root} nested={nested} />;
    case "toolResult":
      return <ToolResultRow item={item} toolName={toolName} />;
    case "permission":
      // r2-review-flow M27: one line per card — the open one waits above the composer (PermissionSlot).
      return item.request.toolName === "AskUserQuestion" ? <QuestionCard item={item} /> : <PermissionLine item={item} />;
    case "budget":
      return <BudgetRow event={item.event} root={root} />;
    case "error":
      return <ErrorNoticeRow item={item} />;
    case "peer":
      return <PeerMessageRow item={item} />;
    case "autoTurn":
      return <AutoTurnRowView item={item} />; // MARK: §52
    case "turnEnd":
      return <TurnEndRow item={item} />; // wave4c w4c-commit: + "대화를 줄였어요" of a compacted turn (§41.1)
    case "turnSummary":
      return <TurnSummaryCard id={item.id} summary={item.summary} />;
    case "planProposed":
      return (
        <div className="plan-row" data-testid="Plan proposed row">
          <div className="head">◈ {t("Claude proposed a plan")}{item.path && <span className="tiny muted mono truncate" title={item.path}>{item.path}</span>}</div>
          <Markdown text={item.plan} />
        </div>
      );
    case "planApproved":
      return <div className="turn-end muted" data-testid="Plan approved row"><span>{item.line ?? t("Plan approved — continuing in {0} mode", item.mode)}</span></div>;
    case "restoredDivider":
      return <div className="turn-end muted" data-testid="Restored divider"><span>{t("Restored from a previous session")}</span></div>;
  }
}

// MARK: wave4d w4d-speed — polish-09: a row (or an agent group) whose props did not change is not drawn again.
const MemoRow = memo(Row);
const MemoAgentGroup = memo(AgentGroup);

export function EmptyTranscript() {
  const budget = useStore((s) => s.state.budget);
  return (
    <div className="chat-empty" data-testid="Chat empty state">
      <span className="title">✨ {t("Ask Claude to make a change.")}</span>
      <span className="muted">
        {budgetIsOn(budget)
          ? t("Each reply is limited to {0} files / {1} lines; you'll review the diff before continuing.", budget.maxFiles, budget.maxLines)
          : t("You'll review what Claude changed before you continue.")}
      </span>
    </div>
  );
}

export function Transcript() {
  // MARK: wave4d w4d-speed — polish-09: the shape, not every delta — the streaming answer's row reads its own text.
  const liveTranscript = useStore((s) => transcriptShape(s.transcript));
  // MARK: wave4b w4b-tabs — §39.2: another chat's saved rows, read-only (viewedChat.ts); every row when "자세히 보기" is on
  const viewing = useViewing();
  const transcript = viewing ? viewing.items : liveTranscript;
  const exploreDetail = useStore((s) => s.settings?.showExploreDetail === true);
  const running = useStore((s) => isRunning(s.state));
  const root = useStore((s) => s.state.project?.path ?? s.state.gitInit?.path ?? null);
  const focus = useStore((s) => s.transcriptFocus);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  /** Transcript length when the view left the bottom — the pill counts the rows since. */
  const [seenLength, setSeenLength] = useState(0);
  const index = useMemo(() => indexTranscript(transcript), [transcript]);
  const continuations = useMemo(() => continuationCounts(transcript), [transcript]); // MARK: wave3 desktop-agents
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const plan = useMemo(() => (findOpen ? planFind(transcript, query, isAgentTool) : EMPTY_FIND), [findOpen, transcript, query]);
  const reveal = useMemo<FindReveal>(() => ({ expand: new Set(plan.expand), openResults: new Set(plan.openResults) }), [plan]);

  // Diff → cause: once the agent groups above it have expanded, bring the row into view and flash it.
  useEffect(() => {
    if (!focus) return;
    // wave4b w4b-tabs (§39.2): the row is the running chat's — unless it is in the shown chat's own rows (a link on a turn
    // summary card of a chat shown read-only, wave4b integration), which is revealed there.
    if (useViewedChat.getState().chat && !revealStaysInViewedChat(viewing, focus.toolUseId)) stopViewing();
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(focus.toolUseId)}"]`);
      if (!el) {
        if (tries++ < 10) timer = setTimeout(attempt, 40);
        return;
      }
      setStuck(false);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    };
    timer = setTimeout(attempt, 30);
    return () => clearTimeout(timer);
  }, [focus]);

  const last = transcript[transcript.length - 1];
  const lastId = last?.id ?? 0;
  const lastLen = last && last.kind === "assistant" ? last.text.length : 0;

  // Keep the view pinned to the bottom while new items stream in; a manual scroll up releases it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuck) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, lastId, lastLen, stuck]);
  // MARK: wave4b w4b-tabs — another chat (or the live one again) is shown: start at its end.
  const viewKey = viewing ? `${viewing.id}|${viewing.items.length === 0}` : "live";
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStuck(true);
  }, [viewKey]);

  // MARK: wave4d w4d-speed — the streaming answer's row pins the view while it grows (the list does not redraw per delta).
  const stuckRef = useRef(stuck);
  stuckRef.current = stuck;
  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const lengthRef = useRef(transcript.length);
  lengthRef.current = transcript.length;
  // Leaving the bottom (scroll, diff → cause, find) starts the "new since" count of the pill.
  useEffect(() => {
    if (!stuck) setSeenLength(lengthRef.current);
  }, [stuck]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_THRESHOLD;
      setStuck(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const toLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStuck(true);
  };
  const unseen = Math.max(0, transcript.length - seenLength);

  // Ctrl/⌘F: the find bar (not over a dialog, not when another control — Monaco's own find — took the key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      if (e.defaultPrevented || useStore.getState().dialog) return;
      const active = document.activeElement;
      if (active?.closest(".monaco-editor")) return;
      e.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="Find input"]');
        input?.focus();
        input?.select();
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="transcript-wrap">
      {findOpen && <FindBar query={query} setQuery={setQuery} rowsRef={rowsRef} onClose={() => setFindOpen(false)} onNavigate={() => setStuck(false)} />}
      <div className="scroll" ref={scrollRef} data-testid="Transcript">
        <div className="transcript" ref={rowsRef}>
          {viewing ? <ViewedChatHeader /> : <OlderRowsBar scrollRef={scrollRef} rowsRef={rowsRef} /* MARK: wave4 w4-history — §38.3 */ />}
          {!viewing && transcript.length === 0 && <EmptyTranscript />}
          <IndexContext.Provider value={index}>
            <FindContext.Provider value={reveal}>
              <ContinuationContext.Provider value={continuations}>
                <PinContext.Provider value={pin}>{/* MARK: wave4d w4d-speed */}
                  {/* wave4b w4b-tabs — market-12: folded unless "자세히 보기" is on or the find bar looks through every row */}
                  <Rows items={index.top} root={root} fold={!exploreDetail && !findOpen ? { running: running && !viewing, focusId: focus?.toolUseId ?? null } : undefined} />
                </PinContext.Provider>
              </ContinuationContext.Provider>
            </FindContext.Provider>
          </IndexContext.Provider>
        </div>
      </div>
      {!stuck && transcript.length > 0 && (
        <button type="button" className="latest-pill" onClick={toLatest} title={t("Scroll to the newest message")} data-testid="Latest pill">
          ↓ {t("Latest")}
          {unseen > 0 && <span className="num"> ({unseen})</span>}
        </button>
      )}
    </div>
  );
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): HighlightRegistry | null => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: HighlightRegistry }).highlights : null);
const makeHighlight = (ranges: Range[]): unknown => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

/**
 * The find bar: hits are text ranges in the rendered rows (user / assistant text, tool inputs, result previews —
 * `planFind` opened the groups and results that hold them), painted with the CSS Custom Highlight API so React's
 * DOM is never touched. Enter / ⇧Enter step, Esc closes.
 */
function FindBar(props: { query: string; setQuery: (q: string) => void; rowsRef: React.RefObject<HTMLDivElement | null>; onClose: () => void; onNavigate: () => void }) {
  const { query, setQuery, rowsRef, onClose, onNavigate } = props;
  const transcript = useStore((s) => s.transcript);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(-1);

  // Collect ranges after the reveal has rendered (two frames: groups open, then their rows mount).
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const root = rowsRef.current;
      const found: Range[] = [];
      if (root && query.trim().length > 0) {
        // Row chrome (the user message's hover actions) is not message text.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        });
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.nodeValue ?? "";
          for (const off of matchOffsets(text, query)) {
            const r = document.createRange();
            r.setStart(n, off);
            r.setEnd(n, off + query.length);
            found.push(r);
          }
        }
      }
      setRanges(found);
      setCurrent((c) => (found.length === 0 ? -1 : c >= 0 && c < found.length ? c : 0));
    };
    const id = requestAnimationFrame(() => requestAnimationFrame(run));
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [query, transcript, rowsRef]);

  useEffect(() => {
    const reg = highlights();
    if (!reg) return;
    reg.set("rg-find", makeHighlight(ranges));
    const cur = ranges[current];
    if (cur) reg.set("rg-find-current", makeHighlight([cur]));
    else reg.delete("rg-find-current");
  }, [ranges, current]);
  useEffect(
    () => () => {
      highlights()?.delete("rg-find");
      highlights()?.delete("rg-find-current");
    },
    [],
  );

  const reveal = useCallback(
    (i: number) => {
      const r = ranges[i];
      const el = r?.startContainer.parentElement;
      if (!el) return;
      onNavigate();
      el.scrollIntoView({ block: "center" });
    },
    [ranges, onNavigate],
  );
  const step = (dir: 1 | -1) => {
    const next = stepIndex(current, ranges.length, dir);
    setCurrent(next);
    reveal(next);
  };
  // A new query lands on its first hit.
  const lastQuery = useRef("");
  useEffect(() => {
    if (query !== lastQuery.current && ranges.length > 0 && current >= 0) {
      lastQuery.current = query;
      reveal(current);
    }
  }, [ranges, current, query, reveal]);

  const none = query.trim().length > 0 && ranges.length === 0;
  return (
    <div className="find-bar" role="search" data-testid="Find bar">
      <input
        value={query}
        placeholder={t("Find in chat")}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e)) {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        aria-label={t("Find in chat")}
        data-testid="Find input"
      />
      <span className={`count num ${none ? "none" : ""}`} data-testid="Find count">
        {query.trim().length === 0 ? "" : ranges.length === 0 ? t("No results") : `${current + 1}/${ranges.length}`}
      </span>
      <button type="button" disabled={ranges.length === 0} onClick={() => step(-1)} title={t("Previous (⇧↩)")} aria-label={t("Previous match")}>↑</button>
      <button type="button" disabled={ranges.length === 0} onClick={() => step(1)} title={t("Next (↩)")} aria-label={t("Next match")}>↓</button>
      <button type="button" onClick={onClose} title={t("Close (Esc)")} aria-label={t("Close find")} data-testid="Find close">×</button>
    </div>
  );
}
