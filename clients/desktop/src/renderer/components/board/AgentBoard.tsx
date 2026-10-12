/**
 * MARK: wave5 w5-board — §43.1: the agent board's first tab (the Mac's `AgentBoardView`): who works on what, as round faces.
 * The main agent (Claude's star) on top, its subagents under it (agents that ran at the same time side by side, nested ones
 * under their parent), each with what it runs now in words ("MySQL 쿼리 실행 · SELECT 1"), its tool calls, time, tokens and model;
 * the summary line ("지금 3명 일하는 중 · 1명 권한 대기 · 오늘 12명 다녀감") and the earlier turns' faces. A click shows the
 * agent's group in the chat (§39.3), the right-click menu is the card's (§42.4).
 */
import type { AgentNode } from "@reviewgate/engine";
import { agentElapsed, formatDuration, isLive, useNow } from "../../agents";
import { historyByTurn, historyLine, historyOf, stepOf } from "../../agentGlance";
import { agentModel } from "../../agentCost";
import { revealAgentGroup } from "../../agentUi";
import {
  MAIN_AVATAR,
  avatarOf,
  boardSummary,
  mainMood,
  moodOf,
  parallelBatches,
  rowDetail,
  summaryParts,
  toolIconOf,
  toolText,
  type AgentMood,
} from "../../agentAvatar";
import { formatElapsed } from "../../elapsed";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { pendingPermissionsOf, requestWaitingFor } from "../../permissionQueue";
import { isRunning, useStore } from "../../store";
import { activityText, formatTokens } from "../chat/HUDStrip";
import { AwaitingPermissionBadge } from "../chat/PermissionBits";
import { ViewingAgentsNote } from "../chat/ViewingChat";
import { ModelChip, useAgentContextMenu, useAgentMenuItems } from "../agents/AgentBits";
import { Avatar } from "./Avatar";
import { BoardGlyph, ToolGlyph } from "./AvatarGlyphs";
import "./board.css";

const EMPTY: AgentNode[] = [];

export default function AgentBoard() {
  const agents = useStore((s) => s.state.hud.agents ?? EMPTY);
  const rawHistory = useStore((s) => s.state.hud.agentHistory);
  const history = historyOf(rawHistory);
  const running = useStore((s) => isRunning(s.state));
  const now = useNow(running || agents.some((a) => isLive(a.status)), 1000);
  const sorted = [...agents].sort((a, b) => a.startedAt - b.startedAt);
  const ids = new Set(agents.map((a) => a.toolUseId));
  const childrenOf = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const a of sorted) {
    if (a.parentToolUseId && ids.has(a.parentToolUseId) && a.parentToolUseId !== a.toolUseId) {
      childrenOf.set(a.parentToolUseId, [...(childrenOf.get(a.parentToolUseId) ?? []), a]);
    } else roots.push(a);
  }
  return (
    <div className="agent-board" data-testid="Agent board">
      <SummaryLine agents={agents} history={history} />
      <ViewingAgentsNote />{/* §39.2: the running chat's agents while another chat is shown */}
      <MainTile now={now} />
      {roots.length === 0 ? (
        <div className="board-empty">
          <Avatar avatar={avatarOf("general-purpose")} mood="idle" size={40} label={false} />
          <div>{t("No subagents in this turn")}</div>
          <div className="caption">{t("Agents Claude delegates to appear here while they work.")}</div>
        </div>
      ) : (
        <>
          <div className="board-connector" aria-hidden="true" />
          <Level nodes={roots} childrenOf={childrenOf} now={now} depth={0} seen={new Set()} />
        </>
      )}
      <EarlierTurns history={history} />
    </div>
  );
}

function SummaryLine({ agents, history }: { agents: AgentNode[]; history: AgentNode[] }) {
  const session = useStore((s) => s.state.session);
  const pending = pendingPermissionsOf({ session });
  const s = boardSummary(agents, history, (a) => requestWaitingFor(pending, a.toolUseId) !== null, pending.some((p) => !p.agent));
  return (
    <div className={`board-summary ${s.waiting > 0 ? "waiting" : ""}`} role="status" data-testid="Agent board summary">
      <BoardGlyph kind={s.waiting > 0 ? "hand" : s.working > 0 ? "sparkles" : "moon"} />
      <span>{summaryParts(s).join(" · ")}</span>
    </div>
  );
}

function MainTile({ now }: { now: number }) {
  const hud = useStore((s) => s.state.hud);
  const running = useStore((s) => isRunning(s.state));
  const model = useStore((s) => s.state.session.model);
  const waiting = useStore((s) => pendingPermissionsOf(s.state).some((p) => !p.agent));
  const mood = mainMood(running, waiting);
  const elapsed = running && hud.turnStartedAt ? now - hud.turnStartedAt : hud.lastTurnMs;
  return (
    <div className={`board-main ${running ? "running" : ""}`} data-testid="Agent board main">
      <Avatar avatar={MAIN_AVATAR} mood={mood} size={60} />
      <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
        <span className="name">{t("Main agent")}</span>
        {model && <span className="model">{model}</span>}
      </div>
      {waiting ? (
        <AwaitingPermissionBadge agentToolUseId={null} />
      ) : running ? (
        <div className="board-doing">
          <ToolGlyph icon={hud.activity.toolName ? toolIconOf(hud.activity.toolName) : "agent"} />
          <span className="text">{activityText(hud.activity, running, hud.agents)}</span>
          <span className="time">· {formatDuration(elapsed)}</span>
        </div>
      ) : (
        <div className="board-left">{hud.turnCount > 0 ? t("Last turn {0}", formatDuration(hud.lastTurnMs)) : t("No turn yet")}</div>
      )}
    </div>
  );
}

function Level({ nodes, childrenOf, now, depth, seen }: { nodes: AgentNode[]; childrenOf: Map<string, AgentNode[]>; now: number; depth: number; seen: Set<string> }) {
  return (
    <div className="board-level">
      {parallelBatches(nodes, now).map((batch, i) => (
        <div className="board-batch" key={i}>
          {batch.length > 1 && <span className="parallel">⑂ {t("{0} in parallel", batch.length)}</span>}
          <div className="board-flow">
            {batch.map((a) => {
              const kids = seen.has(a.toolUseId) ? [] : (childrenOf.get(a.toolUseId) ?? []);
              const next = new Set(seen).add(a.toolUseId);
              return (
                <div className="board-subtree" key={a.toolUseId}>
                  <Tile agent={a} now={now} small={depth > 0} />
                  {kids.length > 0 && (
                    <>
                      <div className="board-connector" aria-hidden="true" />
                      <div className="board-children">
                        <Level nodes={kids} childrenOf={childrenOf} now={now} depth={depth + 1} seen={next} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ agent: a, now, small }: { agent: AgentNode; now: number; small: boolean }) {
  const waiting = useStore((s) => requestWaitingFor(pendingPermissionsOf(s.state), a.toolUseId) !== null);
  const menu = useAgentContextMenu(useAgentMenuItems(a.toolUseId, a, { reveal: true, card: true }));
  const avatar = avatarOf(a.type);
  const mood = moodOf(a, waiting);
  const live = mood === "working" || mood === "retrying";
  return (
    <div
      role="button"
      tabIndex={0}
      className={`board-tile tone-av-${avatar.tone} ${small ? "small" : ""} ${live ? "live" : ""} ${mood}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        revealAgentGroup(a.toolUseId);
      }}
      onKeyDown={(e) => {
        if (isEnter(e) || e.key === " ") {
          e.preventDefault();
          revealAgentGroup(a.toolUseId);
        }
      }}
      onContextMenu={menu.onContextMenu}
      title={t("Show in chat")}
      aria-label={`${avatar.name || a.type}${a.description ? ` — ${a.description}` : ""}`}
      data-testid={`Agent board tile ${a.toolUseId}`}
    >
      <Avatar avatar={avatar} mood={mood} size={small ? 38 : 48} />
      <span className="name" title={a.type}>
        <span>{avatar.name || a.type}</span>
        {avatar.badge && <span className="plugin">{avatar.badge}</span>}
      </span>
      {a.description && <span className="desc" title={a.description}>{a.description}</span>}
      {waiting ? <AwaitingPermissionBadge agentToolUseId={a.toolUseId} /> : <Doing agent={a} mood={mood} now={now} />}
      <Numbers agent={a} now={now} />
      {menu.menu}
    </div>
  );
}

/** What the agent runs now (its call's icon and words and how long it has run), or what it left. */
function Doing({ agent: a, mood, now }: { agent: AgentNode; mood: AgentMood; now: number }) {
  if (mood === "working" || mood === "retrying") {
    const step = stepOf(a);
    const tool = step?.tool ?? a.lastTool;
    if (!tool) return <span className="board-left">{t("Working…")}</span>;
    const ms = step ? Math.max(0, (step.endedAt ?? now) - step.since) : null;
    return (
      <span className={`board-doing ${step?.endedAt ? "ended" : ""}`} data-testid="Agent board doing">
        <ToolGlyph icon={toolIconOf(tool)} />
        <span className="text" title={toolText(tool, step?.detail ?? null)}>{toolText(tool, step?.detail ?? null)}</span>
        {ms !== null && <span className="time">{formatElapsed(ms / 1000)}</span>}
      </span>
    );
  }
  const left = rowDetail(a, now);
  return left ? <span className={`board-left ${mood === "failed" ? "failed" : ""}`} title={left}>{left}</span> : null;
}

/** Tool calls · time · tokens · model (what the engine sent). */
function Numbers({ agent: a, now }: { agent: AgentNode; now: number }) {
  const elapsed = agentElapsed(a, now);
  const model = agentModel(a);
  return (
    <span className="board-numbers">
      {a.toolUses !== undefined && (
        <span title={t("Tool calls")}>
          <BoardGlyph kind="tools" />
          {t("{0} tools", a.toolUses)}
        </span>
      )}
      {elapsed > 0 && (
        <span title={t("Elapsed")}>
          <BoardGlyph kind="clock" />
          {formatDuration(elapsed)}
        </span>
      )}
      {a.tokens !== undefined && (
        <span title={t("Tokens")}>
          <BoardGlyph kind="gauge" />
          {formatTokens(a.tokens)}
        </span>
      )}
      {model && <ModelChip model={model} />}
    </span>
  );
}

/** "이전 턴": the chat's finished agents, a row of small faces per turn (newest first). */
function EarlierTurns({ history }: { history: AgentNode[] }) {
  const groups = historyByTurn(history);
  if (groups.length === 0) return null;
  return (
    <section className="board-earlier" aria-label={t("Earlier turns")} data-testid="Agent board earlier turns">
      <h4 title={t("Finished subagents of this chat's earlier turns")}>
        {t("Earlier turns")} <span className="caption muted num">{history.length}</span>
      </h4>
      {groups.slice(0, 12).map((g, i) => (
        <div className="board-earlier-row" key={g.turn ?? `none-${i}`}>
          <span className="turn">{g.turn !== null ? t("Turn {0}", g.turn) : "—"}</span>
          <span className="faces">
            {g.agents.map((a) => (
              <EarlierFace key={a.toolUseId} agent={a} />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}

function EarlierFace({ agent: a }: { agent: AgentNode }) {
  const menu = useAgentContextMenu(useAgentMenuItems(a.toolUseId, a, { reveal: true, card: true }));
  const line = historyLine(a);
  return (
    <button type="button" className="face" title={line} aria-label={line} onClick={() => revealAgentGroup(a.toolUseId)} onContextMenu={menu.onContextMenu}>
      <Avatar avatar={avatarOf(a.type)} mood={moodOf(a, false)} size={26} label={false} />
      {menu.menu}
    </button>
  );
}
