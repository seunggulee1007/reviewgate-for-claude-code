/**
 * HUD chips of the session's own life (docs/PROTOCOL.md §30): "Claude Code 시작 중…" from the start until the CLI
 * answered initialize (`state.session.ready`), so a slow start never looks like a dead window. MARK: wave3 desktop-session
 * — §36.7: while it waits for a hook, an MCP server or a plugin the chip names it ("serena 기다리는 중").
 */
import { t } from "../../i18n";
import { extensionsWaitingOf, waitingDetail, waitingText } from "../../sessionTools";
import { useStore } from "../../store";
import "../session.css";

/** Shown while starting, or open but not `ready` yet (an engine without `ready` shows only the start itself). */
export function StartingChip() {
  const starting = useStore((s) => s.state.session.starting || (s.state.session.open && s.state.session.ready === false));
  // The session object is the snapshot's own (stable between snapshots); the waiting subject is read from it.
  const session = useStore((s) => s.state.session);
  if (!starting) return null;
  const waiting = extensionsWaitingOf(session);
  return (
    <span
      className="pill gray starting-chip"
      role="status"
      title={waiting ? waitingDetail(waiting) : t("Claude Code is starting; messages wait until it is ready")}
      data-testid="HUD starting"
    >
      <span className="spinner" style={{ width: 9, height: 9 }} aria-hidden="true" />
      {waiting ? <span data-testid="HUD extensions waiting">{waitingText(waiting)}</span> : t("Starting Claude Code…")}
    </span>
  );
}
