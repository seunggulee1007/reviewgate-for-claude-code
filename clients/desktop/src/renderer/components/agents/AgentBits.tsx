/**
 * MARK: wave3 desktop-agents — the small pieces the agent card, the chat's agent group, the HUD and the details sheet share
 * (docs/PROTOCOL.md §36.1–36.4): the model chip (opus purple, sonnet blue, haiku green, else gray), "재개됨(N회차)", the ■
 * that stops one agent (off with its reason when it cannot), the agent menu (⋯ and right-click: 에이전트 상세 · 대화에서
 * 보기 · 이 에이전트 중지 — no confirmation), the SendMessage row of a continuation, the §36 report row of a group and the
 * composer's "메인은 서브에이전트 N개를 기다리는 중" line.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentNode, AgentStatus, AgentStoppedBy } from "@reviewgate/engine";
import { continueText, firstLine, modelLabel, modelTone, resumedLabel, statusText, stopBlockedReason, waitingOf, waitingText, type AgentView } from "../../agentDetails";
import { agentTypeLabel, formatDuration, isLive, statusTone, useNow, type ToolResultItem, type ToolUseItem } from "../../agents";
import { openAgentDetail, revealAgentGroup, stopAgent, useAgentUi } from "../../agentUi";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { agentWhy } from "../../whyQuestions"; // MARK: wave5 w5-fixes (§43.5)
import { FindContext } from "../chat/findContext";
import { Markdown } from "../chat/Markdown";
import { AnchoredPopover } from "../chat/HudPopovers";
import { prettyInput } from "../chat/PermissionCard";
import "./agentDetail.css";
import { agentModel } from "../../agentCost"; // MARK: wave4d w4d-agents2 (§42.4)

/** The status chip; an agent the user stopped (§36.2) reads "사용자가 중지". */
export function AgentChip({ status, stoppedBy }: { status: AgentStatus; stoppedBy?: AgentStoppedBy | undefined }) {
  return (
    <span className={`agent-chip ${statusTone(status)} ${isLive(status) && status !== "paused" ? "live" : ""}`} data-testid={`Agent status ${status}`}>
      <span className="pulse" aria-hidden="true" />
      {statusText({ status, stoppedByUser: stoppedBy === "user" })}
    </span>
  );
}

/** opus / sonnet / haiku / other — nothing for an agent that named no model (it runs the default). */
export function ModelChip({ model }: { model: string | null | undefined }) {
  if (!model) return null;
  return (
    <span className={`model-chip ${modelTone(model)}`} title={`${t("Model")}: ${model}`} data-testid="Agent model">
      {modelLabel(model)}
    </span>
  );
}

/** §36.3 "↻ 재개됨(2회차)". */
export function ResumedBadge({ count }: { count: number }) {
  const label = resumedLabel(count);
  if (!label) return null;
  return (
    <span className="pill resumed-badge" title={label} data-testid="Agent resumed">
      ↻ {label}
    </span>
  );
}

/** Why ■ is off for `node` (null = it can be stopped now). */
export function useStopBlocked(node: AgentNode | undefined): string | null {
  const unsupported = useAgentUi((s) => s.stopUnsupported);
  const refused = useAgentUi((s) => (node ? s.stopRefused[node.toolUseId] : undefined));
  return refused ?? stopBlockedReason(node, unsupported);
}

/** ■ on a running agent: stops that one agent (§36.2) — the turn and the other agents go on. No confirmation. */
export function StopAgentButton({ node, className = "", label = false }: { node: AgentNode | undefined; className?: string; label?: boolean }) {
  const blocked = useStopBlocked(node);
  const stopping = useAgentUi((s) => (node ? s.stopping[node.toolUseId] === true : false));
  if (!node || !isLive(node.status)) return null;
  const title = blocked ?? t("Stop this agent");
  return (
    <button
      type="button"
      className={`agent-stop ${label ? "small" : "plain"} ${className}`}
      disabled={blocked !== null || stopping}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        void stopAgent(node.toolUseId);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid={`Stop agent ${node.toolUseId}`}
    >
      {stopping ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">■</span>}
      {label && <span>{t("Stop this agent")}</span>}
    </button>
  );
}

export type AgentMenuItem = { label: string; onClick: () => void; disabled?: string | null; /** the tooltip of an item that can be chosen */ hint?: string; danger?: boolean; testId: string };

/** MARK: wave5 w5-fixes — §43.5: the side panel opens on "why was this agent started" at its call. */
function askWhyAgent(toolUseId: string): void {
  const why = agentWhy(toolUseId);
  useStore.getState().askAbout(why.anchor, { question: why.question });
}

/**
 * The agent menu's items: details, the conversation, stop (while it runs). MARK: wave4d w4d-agents2 — `card`: the agent
 * card's menu as the Mac's — 대화에서 보기 / 보고서 보기 / 지시 보기 / 이 에이전트 중지 (the card's ⓘ is the details).
 */
export function useAgentMenuItems(toolUseId: string, node: AgentNode | undefined, opts: { reveal?: boolean; card?: boolean } = {}): AgentMenuItem[] {
  const blocked = useStopBlocked(node);
  if (opts.card) {
    const card: AgentMenuItem[] = [
      { label: t("Show in chat"), onClick: () => revealAgentGroup(toolUseId), testId: "Agent menu reveal" },
      { label: t("View report"), onClick: () => openAgentDetail(toolUseId, "report"), testId: "Agent menu report" },
      { label: t("View instructions"), onClick: () => openAgentDetail(toolUseId, "instructions"), testId: "Agent menu instructions" },
      // MARK: wave5 w5-fixes — §43.5: '왜?' — a side question at the agent's call
      { label: t("Ask why it was started (side question)"), onClick: () => askWhyAgent(toolUseId), testId: "Agent menu why" },
    ];
    if (node && isLive(node.status)) card.push({ label: t("Stop this agent"), onClick: () => void stopAgent(toolUseId), disabled: blocked, danger: true, testId: "Agent menu stop" });
    return card;
  }
  const items: AgentMenuItem[] = [{ label: t("Agent details"), onClick: () => openAgentDetail(toolUseId), testId: "Agent menu details" }];
  if (opts.reveal) items.push({ label: t("Show in the conversation"), onClick: () => revealAgentGroup(toolUseId), testId: "Agent menu reveal" });
  if (node && isLive(node.status)) items.push({ label: t("Stop this agent"), onClick: () => void stopAgent(toolUseId), disabled: blocked, danger: true, testId: "Agent menu stop" });
  return items;
}

/**
 * A menu at the pointer (right-click) or under a button; Esc, a click elsewhere or the window losing focus closes it.
 * Portalled to <body> (the agent panel is a size container, which would hold a fixed box); its clicks stay its own.
 */
export function PointerMenu({ at, items, onClose }: { at: { x: number; y: number }; items: AgentMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Not on scroll: the transcript scrolls by itself while Claude streams, and the menu would vanish under the pointer.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  const own = (e: ReactMouseEvent) => e.stopPropagation();
  return createPortal(
    <div
      ref={ref}
      className="menu agent-menu"
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onClick={own}
      onMouseDown={own}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      data-testid="Agent menu"
    >
      {items.map((it) => (
        <div
          key={it.testId}
          role="menuitem"
          aria-disabled={it.disabled ? true : undefined}
          className={`item ${it.disabled ? "disabled" : ""} ${it.danger ? "danger" : ""}`}
          title={it.disabled ?? it.hint ?? undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (it.disabled) return;
            onClose();
            it.onClick();
          }}
          data-testid={it.testId}
        >
          <span className="truncate">{it.label}</span>
          {it.disabled && <span className="tiny faint truncate agent-menu-why">{it.disabled}</span>}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Right-click → the agent menu at the pointer. Returns the handler and the menu element to render. */
export function useAgentContextMenu(items: AgentMenuItem[]): { onContextMenu: (e: ReactMouseEvent) => void; menu: ReactNode } {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useRef(() => setAt(null)).current;
  return {
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAt({ x: e.clientX, y: e.clientY });
    },
    menu: at ? <PointerMenu at={at} items={items} onClose={close} /> : null,
  };
}

/** "⋯" on a group head / card: the same menu under the button. */
export function AgentMenuButton({ items, testId }: { items: AgentMenuItem[]; testId?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useRef(() => setAt(null)).current;
  return (
    <>
      <button
        type="button"
        className="plain agent-more"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={t("More")}
        title={t("More")}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 2 });
        }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid={testId ?? "Agent more"}
      >
        ⋯
      </button>
      {at && <PointerMenu at={at} items={items} onClose={close} />}
    </>
  );
}

/** §36.3 the SendMessage call that continues a subagent: "↻ executor에게 이어서: …" — opens the agent's own group. */
export function ContinueRow({ item }: { item: ToolUseItem }) {
  const c = item.continues;
  if (!c) return null;
  const text = continueText(c, item.input);
  return (
    <div className="tool-block" data-tool-use-id={item.toolUseId}>
      <div
        className="tool-row linked continue-row"
        role="button"
        tabIndex={0}
        onClick={() => revealAgentGroup(c.agentToolUseId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            revealAgentGroup(c.agentToolUseId);
          }
        }}
        title={`${prettyInput(item.input)}\n\n${t("Show in the conversation")}`}
        data-testid="Continue row"
      >
        <span className="icon" aria-hidden="true">↻</span>
        <span className="detail">{text}</span>
        <span className="diff-link" aria-hidden="true">{agentTypeLabel(c.agentType)} ↗</span>
      </div>
    </div>
  );
}

/**
 * §36.1 the report row of a group whose result an engine with §36 cleaned (hand-back preamble, indentation, agentId and
 * <usage> gone): the start of the report as markdown, "보고서 전체 보기" for the whole one in the details sheet. An older
 * engine's raw result keeps the plain tool-result row.
 */
export function AgentReportRow({ result, view }: { result: ToolResultItem; view: AgentView }) {
  const [open, setOpen] = useState(true);
  const reveal = useContext(FindContext).openResults.has(result.toolUseId);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  const text = result.preview;
  return (
    <details className="tool-result agent-report-row" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="Agent report row">
      <summary className={result.isError ? "error" : ""}>
        {result.isError ? "✕ " + t("Agent failed") : "✓ " + t("Agent report")}
        <button
          type="button"
          className="plain tiny full-output"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openAgentDetail(view.toolUseId);
          }}
          data-testid="View full report"
        >
          {t("View full report")}
        </button>
      </summary>
      {open && (
        <div className="agent-report-preview">
          {text.length === 0 ? <span className="faint caption">{t("(empty)")}</span> : <Markdown text={result.truncated ? `${text}…` : text} />}
        </div>
      )}
    </details>
  );
}

/** The first line of a finished agent's report, under its collapsed group (the progress summary while it runs). */
export function collapsedLine(view: AgentView): string | null {
  if (view.live) return view.summary;
  if (view.reportKept) return firstLine(view.reportPreview, 200) || view.summary;
  return view.summary;
}

/** §36.4 "메인은 서브에이전트 2개를 기다리는 중 · executor 4m 12s" while the main turn waits (ticks every second), else null. */
export function useWaitingLine(): string | null {
  // The raw field (a stable reference between snapshots), read leniently outside the selector.
  const raw = useStore((s) => s.state.hud.waitingOnAgents);
  const waiting = waitingOf({ waitingOnAgents: raw });
  const now = useNow(waiting !== null, 1000);
  return waiting ? waitingText(waiting, now) : null;
}

/** §36.4 the composer's status line (its own row: the footer's hint is cut on a narrow chat); nothing from an older engine. */
export function WaitingLine() {
  const text = useWaitingLine();
  if (!text) return null;
  return (
    <div className="composer-waiting" role="status" title={text} data-testid="Composer waiting">
      <span className="spinner" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </div>
  );
}

/** HUD "▾" next to the agents chip: every agent of the session, each opening its details sheet. */
export function AgentListButton() {
  const agents = useStore((s) => s.state.hud.agents);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const live = (agents ?? []).some((a) => isLive(a.status));
  const now = useNow(open && live, 1000);
  if (!agents || agents.length === 0) return null;
  const sorted = [...agents].sort((a, b) => Number(isLive(b.status)) - Number(isLive(a.status)) || b.startedAt - a.startedAt);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="agents-list-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Agent details")}
        title={t("Agent details")}
        onClick={() => setOpen((o) => !o)}
        data-testid="HUD agent list"
      >
        ▾
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} className="hud-menu agent-list" testId="HUD agent list popover" width={320}>
          <div className="hp-head tiny muted bold">{t("Agent details")}</div>
          {sorted.map((a) => (
            <button
              key={a.toolUseId}
              type="button"
              className="hm-item agent-list-item"
              onClick={() => {
                setOpen(false);
                openAgentDetail(a.toolUseId);
              }}
              title={a.description}
              data-testid={`HUD agent ${a.toolUseId}`}
            >
              <AgentChip status={a.status} stoppedBy={a.stoppedBy} />
              <span className="agent-type truncate">{agentTypeLabel(a.type)}</span>
              <ModelChip model={agentModel(a)} />{/* MARK: wave4d w4d-agents2 (§42.4) */}
              <span className="spacer" />
              <span className="tiny muted num">{formatDuration(a.endedAt ? a.endedAt - a.startedAt : isLive(a.status) ? now - a.startedAt : (a.durationMs ?? 0))}</span>
            </button>
          ))}
        </AnchoredPopover>
      )}
    </>
  );
}
