/**
 * Agent activity panel (⌥⌘A — the Mac's key since wave4d w4d-windows, remembered): the main agent as the root of an org-chart tree of its
 * subagents (`state.hud.agents`, nested by `parentToolUseId`; agents spawned side by side sit next to
 * each other), one card per agent with live status, timer, usage, summary and the files it changed
 * (click → diff), and a gantt-like timeline of the agents over the turn at the bottom.
 * MARK: wave3 desktop-agents — §36: the card's type opens the agent details sheet (지시 · 보고서 · 도구 호출 · 파일 · 사용량),
 * a model chip, "재개됨(N회차)", hover ■ / right-click "이 에이전트 중지" on a running card (no confirmation; a stopped card
 * reads "사용자가 중지"), and a finished card shows the start of its cleaned report with "보고서 전체 보기".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentNode, AgentStatus } from "@reviewgate/engine";
import { agentElapsed, agentTypeLabel, formatDuration, isLive, statusLabel, statusTone, useNow } from "../../agents";
import { t } from "../../i18n";
import { isRunning, readBool, useStore, writeBool } from "../../store";
import { activityText, formatTokens } from "../chat/HUDStrip";
import { AwaitingPermissionBadge } from "../chat/PermissionBits";
import "./agents.css";
// MARK: wave3 desktop-agents
import { openAgentDetail } from "../../agentUi";
import { plainPreview } from "../../agentDetails";
import { AgentChip, ModelChip, ResumedBadge, StopAgentButton, useAgentContextMenu, useAgentMenuItems } from "./AgentBits";
// MARK: wave4b w4b-agents
import { revealAgentGroup } from "../../agentUi";
import { EarlierAgents, GlanceBadges, IsolationBadge, StepLine } from "./AgentGlanceBits";
import { ViewingAgentsNote } from "../chat/ViewingChat"; // wave4b integration (§39.2)
// MARK: wave4d w4d-agents2
import { agentModel } from "../../agentCost";
import { GaugeIcon } from "./AgentPanelBits";
// MARK: wave5 w5-board — §43.1: the avatar rule here too (the Mac's §42.4 panel: identity color, plugin badge, compact rows)
import { AgentRows, BoardButton, PluginBadge } from "./AgentRows";
import { avatarOf, COMPACT_FROM, parallelBatches } from "../../agentAvatar";

export { AgentChip } from "./AgentBits";

const EMPTY_AGENTS: AgentNode[] = [];
const HEIGHT_KEY = "rg.agentPanel.h2";
const TIMELINE_KEY = "rg.agentPanel.timeline";
const MIN_H = 150;

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_H ? v : 400;
  } catch {
    return 400;
  }
}

/** Children per parent tool_use id; roots are agents whose spawner is not a listed agent (the main agent). */
function buildTree(agents: AgentNode[]): { roots: AgentNode[]; children: Map<string, AgentNode[]> } {
  const ids = new Set(agents.map((a) => a.toolUseId));
  const sorted = [...agents].sort((a, b) => a.startedAt - b.startedAt);
  const children = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const a of sorted) {
    if (a.parentToolUseId && ids.has(a.parentToolUseId)) {
      const list = children.get(a.parentToolUseId);
      if (list) list.push(a);
      else children.set(a.parentToolUseId, [a]);
    } else roots.push(a);
  }
  return { roots, children };
}

export function AgentPanel() {
  const agents = useStore((s) => s.state.hud.agents ?? EMPTY_AGENTS);
  const toggle = useStore((s) => s.toggleAgentPanel);
  const [height, setHeight] = useState(readHeight);
  const [showTimeline, setShowTimeline] = useState(() => readBool(TIMELINE_KEY, true));
  const live = agents.filter((a) => isLive(a.status)).length;
  const done = agents.filter((a) => a.status === "completed").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const running = useStore((s) => isRunning(s.state));
  const now = useNow(live > 0 || running, 1000);
  const tree = useMemo(() => buildTree(agents), [agents]);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
    } catch {
      /* ignore */
    }
  }, [height]);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { y: e.clientY, h: height };
    document.body.classList.add("resizing-row");
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      const max = Math.max(MIN_H, window.innerHeight * 0.75);
      setHeight(Math.min(max, Math.max(MIN_H, drag.current.h + (drag.current.y - ev.clientY))));
    };
    const up = () => {
      drag.current = null;
      document.body.classList.remove("resizing-row");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <section className="agent-panel" style={{ height }} data-testid="Agent panel">
      <div className="agent-resize" onMouseDown={onResizeStart} title={t("Drag to resize")} />
      <header className="agent-panel-head">
        <span className="agent-icon" aria-hidden="true">◆</span>
        <span className="bold">{t("Agent activity")}</span>
        <BoardButton />{/* MARK: wave5 w5-board */}
        {agents.length > 0 && (
          <span className="caption muted num">
            {[live > 0 ? t("{0} running", live) : null, done > 0 ? t("{0} done", done) : null, failed > 0 ? t("{0} failed", failed) : null].filter(Boolean).join(" · ")}
          </span>
        )}
        <span className="spacer" />
        {agents.length > 0 && (
          <button
            type="button"
            className={`plain tiny timeline-toggle ${showTimeline ? "active" : ""}`}
            aria-pressed={showTimeline}
            onClick={() => {
              writeBool(TIMELINE_KEY, !showTimeline);
              setShowTimeline(!showTimeline);
            }}
            data-testid="Toggle timeline"
          >
            ▤ {t("Timeline")}
          </button>
        )}
        <span className="tiny faint">{t("Toggle ⌥⌘A")}</span>
        <button type="button" className="plain small" onClick={() => toggle(false)} title={t("Close")} aria-label={t("Close")} data-testid="Close agent panel">✕</button>
      </header>
      <ViewingAgentsNote />
      <div className="agent-panel-main">
      <div className="agent-panel-body">
        <div className="agent-tree">
          <div className="agent-branch root">
            <MainAgentCard now={now} />
            {tree.roots.length > 0 && (
              <div className="agent-children">
                <AgentLevel nodes={tree.roots} childrenOf={tree.children} now={now} />
              </div>
            )}
          </div>
        </div>
        {agents.length === 0 && <div className="agent-empty caption muted">{t("No subagents yet — when Claude delegates work (Agent / Task), each subagent appears here live.")}</div>}
        <EarlierAgents />{/* MARK: wave4b w4b-agents — §39.3 */}
      </div>
      {agents.length > 0 && showTimeline && <Timeline agents={agents} roots={tree.roots} childrenOf={tree.children} now={now} />}
      </div>
    </section>
  );
}

function AgentLevel({ nodes, childrenOf, now }: { nodes: AgentNode[]; childrenOf: Map<string, AgentNode[]>; now: number }) {
  // MARK: wave5 w5-board — three or more agents that ran at the same time are compact rows (the Mac's §42.4 panel).
  const children = (a: AgentNode) => {
    const kids = childrenOf.get(a.toolUseId) ?? [];
    return kids.length > 0 ? (
      <div className="agent-children">
        <AgentLevel nodes={kids} childrenOf={childrenOf} now={now} />
      </div>
    ) : null;
  };
  return (
    <div className="agent-level">
      {parallelBatches(nodes, now).flatMap((batch, i) =>
        batch.length >= COMPACT_FROM
          ? [
              <div key={`rows-${i}`} className="agent-branch">
                <AgentRows batch={batch} now={now} card={(a) => <AgentCard agent={a} now={now} />} childrenOf={children} />
              </div>,
            ]
          : batch.map((a) => (
              <div key={a.toolUseId} className="agent-branch">
                <AgentCard agent={a} now={now} />
                {children(a)}
              </div>
            )),
      )}
    </div>
  );
}

function MainAgentCard({ now }: { now: number }) {
  const hud = useStore((s) => s.state.hud);
  const running = useStore((s) => isRunning(s.state));
  const model = useStore((s) => s.state.session.model);
  const status: AgentStatus = running ? "running" : "completed";
  const elapsed = running && hud.turnStartedAt ? now - hud.turnStartedAt : hud.lastTurnMs;
  return (
    <div className={`agent-card main tone-${running ? "blue" : "gray"}`} data-testid="Main agent card">
      <div className="agent-card-top">
        {running ? <AgentChip status={status} /> : <span className="agent-chip gray"><span className="pulse" aria-hidden="true" />{t("Idle")}</span>}
        <AwaitingPermissionBadge agentToolUseId={null} />
        <span className="spacer" />
        <span className="mono tiny muted num" title={running ? t("This turn so far") : t("Last turn")}>{formatDuration(elapsed)}</span>
      </div>
      <div className="agent-title">
        <span className="agent-type">{t("Main agent")}</span>
        {model && <span className="tiny faint truncate">{model}</span>}
      </div>
      <div className="agent-desc">{activityText(hud.activity, running, hud.agents)}</div>
      <div className="agent-stats tiny muted num">
        <span title={t("Context tokens")}>▤ {formatTokens(hud.contextTokens)}</span>
        <span title={t("Turns")}>↻ {hud.turnCount}</span>
      </div>
    </div>
  );
}

function AgentCard({ agent: a, now }: { agent: AgentNode; now: number }) {
  const changedFiles = useStore((s) => s.state.changedFiles);
  const selectedPath = useStore((s) => s.selectedPath);
  const revealFile = useStore((s) => s.revealFile);
  const tone = statusTone(a.status);
  // MARK: wave3 desktop-agents — §36.1–36.3
  const menu = useAgentContextMenu(useAgentMenuItems(a.toolUseId, a, { reveal: true, card: true })); // wave4d: the Mac's card menu
  const report = !isLive(a.status) && a.reportPreview ? plainPreview(a.reportPreview) || null : null;
  return (
    <div
      className={`agent-card tone-${tone} ident tone-av-${avatarOf(a.type).tone}`}
      onContextMenu={menu.onContextMenu}
      // MARK: wave4b w4b-agents — agents-11: the card opens its group in the chat (its buttons keep their own action).
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        revealAgentGroup(a.toolUseId);
      }}
      title={t("Show in chat")}
      data-testid={`Agent card ${a.toolUseId}`}
    >
      <div className="agent-card-top">
        <AgentChip status={a.status} stoppedBy={a.stoppedBy} />
        <AwaitingPermissionBadge agentToolUseId={a.toolUseId} />
        <ResumedBadge count={a.resumeCount ?? 0} />
        {a.isBackground && <span className="pill gray" title={t("Runs in the background")}>{t("background")}</span>}
        <GlanceBadges agent={a} now={now} />
        <span className="spacer" />
        <span className="mono tiny muted num" title={t("Elapsed")}>{formatDuration(agentElapsed(a, now))}</span>
        <StopAgentButton node={a} className="hover" />
      </div>
      <button type="button" className="agent-title plain" onClick={() => openAgentDetail(a.toolUseId)} title={t("Agent details")} data-testid={`Agent details ${a.toolUseId}`}>
        <span className="agent-type">{agentTypeLabel(a.type)}</span>
        <PluginBadge type={a.type} />
        <ModelChip model={agentModel(a)} />{/* MARK: wave4d w4d-agents2 — §42.4: the model it ran on */}
      </button>
      {a.description && <div className="agent-desc clamp2" title={a.description}>{a.description}</div>}
      <StepLine agent={a} now={now} />{/* MARK: wave4b w4b-agents — §39.3 (was "▸ lastTool") */}
      <IsolationBadge agent={a} />
      {report ? (
        <div className="agent-summary-text clamp3 agent-report-plain" title={report} data-testid="Agent report preview">{report}</div>
      ) : (
        a.summary && <div className="agent-summary-text clamp3" title={a.summary}>{a.summary}</div>
      )}
      {report && (
        <button type="button" className="plain tiny agent-full-report" onClick={() => openAgentDetail(a.toolUseId)} data-testid="Agent full report link">
          {t("View full report")}
        </button>
      )}
      {a.error && <div className="agent-error clamp3" title={a.error}>✕ {a.error}</div>}
      {(a.tokens !== undefined || a.toolUses !== undefined) && (
        <div className="agent-stats tiny muted num">
          {a.tokens !== undefined && <span title={t("Tokens")}><GaugeIcon /> {formatTokens(a.tokens)}</span>}
          {a.toolUses !== undefined && <span title={t("Tool calls")}>⚒ {a.toolUses}</span>}
        </div>
      )}
      {a.files.length > 0 && (
        <div className="agent-files">
          {a.files.slice(0, 6).map((p) => {
            const inReview = changedFiles.some((f) => f.path === p);
            return (
              <button
                key={p}
                type="button"
                className={`file-link ${p === selectedPath ? "current" : ""}`}
                disabled={!inReview}
                title={inReview ? p : t("{0} — not in the current review", p)}
                onClick={() => revealFile(p)}
              >
                {p.split(/[\\/]/).pop()}
              </button>
            );
          })}
          {a.files.length > 6 && <span className="tiny faint" title={a.files.slice(6).join("\n")}>+{a.files.length - 6}</span>}
        </div>
      )}
      {menu.menu}
    </div>
  );
}

/** Gantt-like bars per agent (tree order, indented by depth) over the span from the first start to now / the last end. */
function Timeline({ agents, roots, childrenOf, now }: { agents: AgentNode[]; roots: AgentNode[]; childrenOf: Map<string, AgentNode[]>; now: number }) {
  const turnStartedAt = useStore((s) => s.state.hud.turnStartedAt);
  const running = useStore((s) => isRunning(s.state));
  const revealToolUse = useStore((s) => s.revealToolUse);
  const ordered: AgentNode[] = [];
  const walk = (list: AgentNode[]) => {
    for (const a of list) {
      ordered.push(a);
      walk(childrenOf.get(a.toolUseId) ?? []);
    }
  };
  walk(roots);
  const endOf = (a: AgentNode) => a.endedAt ?? (isLive(a.status) ? now : a.startedAt + (a.durationMs ?? 0));
  const starts = agents.map((a) => a.startedAt);
  if (running && turnStartedAt) starts.push(turnStartedAt);
  const t0 = Math.min(...starts);
  const t1 = Math.max(t0 + 1000, ...agents.map(endOf), running ? now : 0);
  const span = t1 - t0;
  const pct = (v: number) => `${((v - t0) / span) * 100}%`;
  const width = (a: number, b: number) => `max(3px, ${((b - a) / span) * 100}%)`;
  return (
    <div className="agent-timeline" data-testid="Agent timeline">
      {running && turnStartedAt && (
        <div className="tl-row">
          <span className="tl-label bold">{t("Main agent")}</span>
          <span className="tl-track">
            <span className="tl-bar blue main live" style={{ left: pct(turnStartedAt), width: width(turnStartedAt, now) }} />
          </span>
        </div>
      )}
      {ordered.map((a) => {
        const end = endOf(a);
        return (
          <div className="tl-row" key={a.toolUseId}>
            <span className="tl-label truncate" style={{ paddingLeft: (a.depth - 1) * 10 }} title={a.description}>
              <AwaitingPermissionBadge agentToolUseId={a.toolUseId} compact />
              {agentTypeLabel(a.type)}
            </span>
            <span className="tl-track">
              <span
                className={`tl-bar ${statusTone(a.status)} ${isLive(a.status) ? "live" : ""}`}
                style={{ left: pct(a.startedAt), width: width(a.startedAt, end) }}
                title={`${agentTypeLabel(a.type)} · ${statusLabel(a.status)} · ${formatDuration(end - a.startedAt)}\n${a.description}`}
                onClick={() => revealToolUse(a.toolUseId)}
              />
            </span>
          </div>
        );
      })}
      <div className="tl-axis tiny faint num">
        <span>0s</span>
        <span>{formatDuration(span / 2)}</span>
        <span>{formatDuration(span)}</span>
      </div>
    </div>
  );
}
