/**
 * §33 permission UI pieces shared by the permission / SendMessage / question cards, the HUD, the agent panel and the
 * transcript's agent groups: the card state + shortcut hooks (the card that has waited longest owns ⌘↩ / ⌥⌘↩ / ⌘⌫,
 * Ctrl elsewhere), the agent chip, the §29 peer badge, the §33.3 reason line, the HUD count, the "권한 대기" badge
 * that jumps to its card, and the toast for an already-handled request.
 */
import { useEffect, useRef } from "react";
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "../../i18n";
import { cardShortcut, denyKeyHint, type PermissionAnswer } from "../../permissionKeys";
import {
  agentChipText,
  hudPermissionText,
  isPermissionPending,
  oldestRequestId,
  peerTurnText,
  pendingPermissionsOf,
  permissionCardStatus,
  requestWaitingFor,
  shortcutTargetId,
  workbenchAt,
  type PermissionCardStatus,
  type ReasonView,
} from "../../permissionQueue";
import { useStore } from "../../store";
import { stopViewing, useViewedChat } from "../../viewedChat"; // MARK: wave4b w4b-tabs (§39.2)
import { ModeSuggestion } from "./ModeSuggestion";
import "./permissions.css";

export const MAC = typeof window !== "undefined" && window.rg?.platform === "darwin";
export const MOD = MAC ? "⌘" : "Ctrl+";
export const ALT = MAC ? "⌥" : "Alt+";
/** wave3 check-clients: "⌘⌫" on a Mac, "Ctrl+Backspace" elsewhere. */
export const DENY_KEY = denyKeyHint(MAC);

/**
 * A card's state: `active` while its request is open, `isTarget` when it is the one the shortcuts answer, `several` while
 * more than one request waits (only then does the target card say so).
 */
export function usePermissionCardState(requestId: string, decision: boolean | null): { status: PermissionCardStatus; active: boolean; isTarget: boolean; several: boolean } {
  const pending = useStore((s) => isPermissionPending(s.state, requestId));
  const oldest = useStore((s) => shortcutTargetId(s.state) === requestId);
  const several = useStore((s) => pendingPermissionsOf(s.state).length > 1);
  const status = permissionCardStatus(decision, pending);
  return { status, active: status === "active", isTarget: status === "active" && oldest, several };
}

/**
 * The card shortcuts, registered by the target card only (capture phase, so they win over the composer's ⌘↩ while it is
 * empty). Never while a text field owns the key, a dialog is open or another card has focus (permissionKeys.ts).
 */
export function useCardShortcuts(enabled: boolean, requestId: string, allowSession: boolean, handlers: Record<PermissionAnswer, () => void>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const answer = cardShortcut(e, { mac: MAC, focus: document.activeElement, requestId, allowSession, dialogOpen: useStore.getState().dialog !== null });
      if (!answer) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current[answer]();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [enabled, requestId, allowSession]);
}

/** Scrolls the transcript to the card of `requestId` and flashes it ("카드로 이동"). */
export function revealPermissionCard(requestId: string): void {
  // MARK: wave4b w4b-tabs — §39.2: the card is the running chat's; another chat shown read-only gives way first.
  if (useViewedChat.getState().chat) {
    stopViewing();
    requestAnimationFrame(() => requestAnimationFrame(() => revealPermissionCard(requestId)));
    return;
  }
  const el = document.querySelector<HTMLElement>(`[data-permission-id="${CSS.escape(requestId)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

/** The head caption of a card that is no longer open: its answer here, or "처리됨" (grey) when it left the queue otherwise. */
export function DecisionCaption({ status, decision, labels }: { status: "decided" | "handled"; decision: boolean | null; labels?: { yes: string; no: string } }) {
  if (status === "handled") {
    return (
      <span className="caption bold muted" title={t("Answered elsewhere, withdrawn, or ended with the turn — nothing left to do here.")} data-testid="Permission decision">
        {t("Handled")}
      </span>
    );
  }
  return (
    <span className={`caption bold ${decision ? "green" : "red"}`} data-testid="Permission decision">
      {decision ? (labels?.yes ?? t("Allowed")) : (labels?.no ?? t("Denied"))}
    </span>
  );
}

/** Head chip: "🧩 executor · 컴파일" for a subagent, "메인 에이전트" otherwise. */
export function AgentTag({ request }: { request: Pick<PermissionRequest, "agent"> }) {
  const text = agentChipText(request);
  return (
    <span className={`agent-tag truncate ${request.agent ? "sub" : ""}`} title={request.agent?.agentId ? `${text} (${request.agent.agentId})` : text} data-testid="Permission agent">
      {text}
    </span>
  );
}

/** §29: "{senders} 요청" while the running review turn is accepted peer messages. */
export function PeerTurnBadge() {
  const text = useStore((s) => peerTurnText(s.state.session));
  if (!text) return null;
  return (
    <span className="peer-badge truncate" title={text} data-testid="Peer turn badge">
      {text}
    </span>
  );
}

/** §33.3 warning line: where the call works is outside this window's review; another worktree opens as a workbench. */
export function ReasonLine({ view }: { view: ReasonView }) {
  const workbenches = useStore((s) => s.state.workbenches.list);
  const wb = workbenchAt(workbenches, view.path);
  return (
    <div className={`reason-line ${view.tone}`} role="note" title={view.path ?? undefined} data-testid="Permission reason" data-reason={view.code}>
      <span className="reason-icon" aria-hidden="true">⚠</span>
      <span className="grow">{view.text}</span>
      {wb && (
        <button type="button" className="small" onClick={() => void window.rg.openWorkbenchWindow(wb.path)} title={t("Opens that worktree in its own ReviewGate window, where its changes are reviewed")} data-testid="Open as workbench">
          {t("Open as workbench")}
        </button>
      )}
    </div>
  );
}

/** HUD: "권한 대기 중" / "권한 요청 n개 대기" — jumps to the card that has waited longest. */
export function PermissionHudChip() {
  const count = useStore((s) => pendingPermissionsOf(s.state).length);
  const oldest = useStore((s) => oldestRequestId(s.state));
  const text = hudPermissionText(count);
  if (!text || !oldest) return null;
  return (
    <button type="button" className="permission plain" onClick={() => revealPermissionCard(oldest)} title={t("Show the permission request that has waited longest")} data-testid="HUD permission">
      ✋ {text}
    </button>
  );
}

/**
 * Agent panel / timeline / transcript group: "권한 대기" when this agent's call waits on a card (`agentToolUseId` null =
 * the main agent), with "카드로 이동" (`compact`: the badge itself jumps).
 */
export function AwaitingPermissionBadge({ agentToolUseId, compact = false }: { agentToolUseId: string | null; compact?: boolean }) {
  const requestId = useStore((s) => {
    const pending = pendingPermissionsOf(s.state);
    const hit = agentToolUseId === null ? pending.find((p) => !p.agent) : requestWaitingFor(pending, agentToolUseId);
    return hit?.requestId ?? null;
  });
  if (!requestId) return null;
  const go = (e: React.MouseEvent) => {
    e.stopPropagation();
    revealPermissionCard(requestId);
  };
  if (compact) {
    // The timeline row is one 14px line: just the hand, which jumps to the card.
    const label = `${t("Awaiting permission")} — ${t("Go to card")}`;
    return (
      <button type="button" className="perm-waiting compact" onClick={go} title={label} aria-label={label} data-testid="Agent awaiting permission">
        ✋
      </button>
    );
  }
  return (
    <span className="perm-waiting" title={t("This agent waits for your answer on a permission card")} data-testid="Agent awaiting permission">
      ✋ {t("Awaiting permission")}
      <button type="button" className="plain" onClick={go} data-testid="Go to permission card">
        {t("Go to card")}
      </button>
    </span>
  );
}

/**
 * Permission notices above the composer (ChatPane): the first-open "start in the terminal's mode?" question. "이미 처리된
 * 권한 요청입니다" is the window's one toast (toast.ts, components/Toast.tsx), shared with the other short notices.
 */
export function PermissionNotices() {
  return <ModeSuggestion />;
}
