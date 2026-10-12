/**
 * §33.2 SendMessage card: Claude wants to send a message to another Claude session — a message can make that session
 * act, so it always asks and nothing is ever remembered for it. Shows the receiving session (`input.to`), the summary
 * and the message itself (large, scrollable); the answers are only Send and Decline (Ctrl/⌘↩ / Ctrl/⌘⌫ when this card
 * has waited longest).
 */
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { AgentTag, DecisionCaption, DENY_KEY, MOD, PeerTurnBadge, useCardShortcuts, usePermissionCardState } from "./PermissionBits";
// MARK: wave3 desktop-agents
import type { AgentNode } from "@reviewgate/engine";
import { continuedAgentOf, continuesAgentText } from "../../agentDetails";
// MARK: wave4d w4d-peers
import { recipientAddress, recipientDetail, recipientTitle, toSessionOf } from "../../peerSessions";

/** §42.2: "터미널 · ~/acme · 입력 대기" and the address under the receiving session; nothing for an older engine. */
export function PeerRecipientLines({ request }: { request: PermissionRequest }) {
  const detail = recipientDetail(toSessionOf(request));
  const address = recipientAddress(request);
  if (!detail && !address) return null;
  return (
    <div className="sm-peer" data-testid="SendMessage recipient detail">
      {detail && <div className="caption faint truncate">{detail}</div>}
      {address && <div className="caption faint mono truncate" title={address}>{address}</div>}
    </div>
  );
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const NO_AGENTS: AgentNode[] = [];

/**
 * wave2 check-clients: the message as it will be sent — the CLI's SendMessage also carries protocol messages as an object
 * (a teammate's `shutdown_response` / `plan_approval_response`, …), shown as JSON instead of "(내용 없음)".
 */
export function sendMessageBody(v: unknown): { text: string; structured: boolean } {
  if (typeof v === "string") return { text: v, structured: false };
  if (v === undefined || v === null) return { text: "", structured: false };
  try {
    return { text: JSON.stringify(v, null, 2) ?? String(v), structured: true };
  } catch {
    return { text: String(v), structured: true };
  }
}

export function SendMessageCard({ request, decision }: { request: PermissionRequest; decision: boolean | null }) {
  const respondPermission = useStore((s) => s.respondPermission);
  const { status, active, isTarget, several } = usePermissionCardState(request.requestId, decision);
  const to = text(request.input["to"]);
  const summary = text(request.input["summary"]);
  const { text: message, structured } = sendMessageBody(request.input["message"]);
  // MARK: wave3 desktop-agents — §36.3: `to` names a subagent of this session (its agentId / task id) — the card says which.
  const continued = useStore((s) => continuedAgentOf(s.state.hud.agents ?? NO_AGENTS, to));

  const id = request.requestId;
  const send = () => respondPermission(id, true);
  const decline = () => respondPermission(id, false, t("Denied by user"));
  // No "for the session" here: ⌥⌘↩ is not a SendMessage key.
  useCardShortcuts(active && isTarget, id, false, { once: send, session: () => undefined, deny: decline });

  const cls = ["perm", "send-message", status === "decided" ? "decided" : "", status === "handled" ? "handled" : "", isTarget ? "target" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-permission-id={id}
      data-testid={status === "active" ? "SendMessage card" : status === "handled" ? "Permission handled" : "Permission decided"}
      role="group"
      aria-label={t("Send a message to another session")}
    >
      <div className="head">
        <span className="orange" aria-hidden="true">✉</span>
        <span className="title truncate">{t("Send a message to another session")}</span>
        <AgentTag request={request} />
        {active && <PeerTurnBadge />}
        {status !== "active" && <DecisionCaption status={status} decision={decision} labels={{ yes: t("Sent"), no: t("Declined") }} />}
      </div>
      {/* MARK: wave4d w4d-peers — §42.2: the session's registry name, not its socket path; where it runs below. */}
      <div className="sm-to" data-testid="SendMessage to">{t("To session: {0}", recipientTitle(request))}</div>
      <PeerRecipientLines request={request} />
      {continued && <div className="sm-summary" data-testid="SendMessage continues">↻ {continuesAgentText(continued)}</div>}
      {summary && (
        <div className="sm-summary" data-testid="SendMessage summary">
          {t("Summary")}: {summary}
        </div>
      )}
      <pre className={structured ? "sm-body mono" : "sm-body"} data-testid="SendMessage body">{message.length > 0 ? message : t("(no message)")}</pre>
      {active && (
        <>
          <div className="note">{t("The receiving session reads this and may act on it — check it before sending.")}</div>
          <div className="actions">
            <span className="spacer" />
            <button type="button" className="danger" onClick={decline} title={isTarget ? t("Decline ({0})", DENY_KEY) : t("Decline")} data-testid="SendMessage decline">
              {t("Decline")}
              {isTarget && <kbd>{DENY_KEY}</kbd>}
            </button>
            <button type="button" className="primary" onClick={send} title={isTarget ? t("Send ({0})", `${MOD}↩`) : t("Send")} data-testid="SendMessage send">
              {t("Send")}
              {isTarget && <kbd>{MOD}↩</kbd>}
            </button>
          </div>
        </>
      )}
      {isTarget && several && <div className="shortcut-hint" data-testid="Shortcut target hint">{t("Shortcuts answer this card — it has waited longest")}</div>}
    </div>
  );
}
