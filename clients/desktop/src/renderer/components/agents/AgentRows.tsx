/**
 * MARK: wave5 w5-board — §43.1: the Windows agent panel takes the Mac's §42.4 layout with the avatar rule: three or more
 * agents that ran at the same time are compact rows (status, a small face, type, description, time, ■; the second line what
 * a live agent does now or what a finished one left) that open into the full card; every agent has its type's color on its
 * left edge; the type reads without its plugin ("executor" + a small "OMC"); and the header opens the agent board.
 */
import { useState, type ReactNode } from "react";
import type { AgentNode } from "@reviewgate/engine";
import { agentElapsed, formatDuration, isLive } from "../../agents";
import { avatarOf, moodOf, pluginBadge, rowDetail } from "../../agentAvatar";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { pendingPermissionsOf, requestWaitingFor } from "../../permissionQueue";
import { useStore } from "../../store";
import { Avatar } from "../board/Avatar";
import { BoardGlyph } from "../board/AvatarGlyphs";
import { AgentChip, StopAgentButton, useAgentContextMenu, useAgentMenuItems } from "./AgentBits";

/** "OMC" after the type (nothing without a plugin prefix). */
export function PluginBadge({ type }: { type: string }) {
  const badge = pluginBadge(type);
  return badge ? (
    <span className="plugin-badge tiny" title={type}>
      {badge}
    </span>
  ) : null;
}

/** The panel header's way to the agent board. */
export function BoardButton() {
  const label = t("Open the agent board (⌥⌘B)");
  return (
    <button type="button" className="plain tiny board-open" onClick={() => useStore.getState().toggleBoard(true)} title={label} aria-label={label} data-testid="Open agent board">
      <BoardGlyph kind="agents" />
    </button>
  );
}

export function AgentRows({ batch, now, card, childrenOf }: { batch: AgentNode[]; now: number; card: (a: AgentNode) => ReactNode; childrenOf: (a: AgentNode) => ReactNode }) {
  return (
    <div className="agent-rows" data-testid="Agent rows">
      <span className="parallel">⑂ {t("{0} in parallel", batch.length)}</span>
      {batch.map((a) => (
        <AgentRow key={a.toolUseId} agent={a} now={now} card={card} more={childrenOf(a)} />
      ))}
    </div>
  );
}

function AgentRow({ agent: a, now, card, more }: { agent: AgentNode; now: number; card: (a: AgentNode) => ReactNode; more: ReactNode }) {
  const [open, setOpen] = useState(false);
  const waiting = useStore((s) => requestWaitingFor(pendingPermissionsOf(s.state), a.toolUseId) !== null);
  const menu = useAgentContextMenu(useAgentMenuItems(a.toolUseId, a, { reveal: true, card: true }));
  const avatar = avatarOf(a.type);
  const detail = rowDetail(a, now);
  const live = isLive(a.status);
  const toggle = () => setOpen((o) => !o);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className={`agent-row tone-av-${avatar.tone} ${a.status === "failed" ? "failed" : ""} ${waiting ? "waiting" : ""} ${open ? "open" : ""}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, input")) return;
          toggle();
        }}
        onKeyDown={(e) => {
          if (isEnter(e) || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        onContextMenu={menu.onContextMenu}
        title={a.description ? `${a.type} — ${a.description}` : a.type}
        data-testid={`Agent row ${a.toolUseId}`}
      >
        <div className="line1">
          <AgentChip status={a.status} stoppedBy={a.stoppedBy} />
          <Avatar avatar={avatar} mood={moodOf(a, waiting)} size={18} label={false} />
          <span className="agent-type">{avatar.name}</span>
          <PluginBadge type={a.type} />
          <span className="desc">{a.description}</span>
          <span className="mono tiny muted num">{formatDuration(agentElapsed(a, now))}</span>
          <StopAgentButton node={a} />
          <span className="chev" aria-hidden="true">▸</span>
        </div>
        {detail && <div className={`line2 ${live ? "live" : a.status === "failed" ? "failed" : ""}`}>{detail}</div>}
        {menu.menu}
      </div>
      {open && card(a)}
      {more}
    </>
  );
}
