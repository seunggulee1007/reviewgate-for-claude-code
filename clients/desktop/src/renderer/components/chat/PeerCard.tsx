/**
 * Messages another of the user's Claude sessions sent, held for the user (docs/PROTOCOL.md §29, `state.session.peerInbox`):
 * one card above the composer — "acme-b4 세션이 메시지를 보냈어요", or "다른 세션 메시지 3개" with the senders. The
 * body is unknown until Claude takes it. [Claude가 처리] runs every held message as one reviewed turn (`peer_accept` with
 * the ids on the card), [거절] declines them all, ⋯ stops this project from accepting any. While they are handed over
 * the card shows a spinner; a refusal (the list changed, the gate closed) is said on the card.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { peerCardModel, peerRunsByItself, peerSenderNames } from "../../peer";
import { cannotSendReason, useStore } from "../../store";
import { Menu } from "../Menu";
import "../session.css";

/** `template` with its "{0}" replaced by `node` (a bold sender name inside the localized sentence). */
function withNode(template: string, node: ReactNode): ReactNode {
  const at = template.indexOf("{0}");
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      {node}
      {template.slice(at + 3)}
    </>
  );
}

export function PeerCard() {
  const session = useStore((s) => s.state.session);
  const gate = useStore((s) => s.state.gate);
  const hidden = useStore((s) => s.peerHidden);
  const notice = useStore((s) => s.peerNotice);
  const busy = useStore((s) => s.peerBusy);
  const otherReason = useStore((s) => cannotSendReason(s.state));
  const accept = useStore((s) => s.acceptPeers);
  const dismiss = useStore((s) => s.dismissPeers);
  const setPeerMode = useStore((s) => s.setPeerMode);
  const card = peerCardModel(session, gate, hidden, otherReason);
  if (!card) return null;

  const locked = card.delivering || busy !== null;
  // r2-peers: ⋯ and [Decline] on the card and on the one line alike — polish P4-composer-36: ⋯ says what it holds, and
  // while the messages are handed over both say why they are off.
  const more = (
    <Menu
      label="⋯"
      ariaLabel={t("Options for messages from other sessions")}
      title={locked ? t("The messages are being handed over") : t("Options for messages from other sessions — don't accept them in this project")}
      align="right"
      disabled={locked}
      testId="Peer more"
      items={[
        {
          kind: "item",
          label: t("Don't accept them in this project"),
          title: t("Messages from other sessions are declined in this project from now on (Settings → messages from other sessions for every project)"),
          onClick: () => void setPeerMode("off"),
          testId: "Peer off for project",
        },
      ]}
    />
  );
  const declineTitle = locked ? t("The messages are being handed over") : t("Declines every waiting message; the senders are told it was not delivered");

  // MARK: r2-peers — auto (the default) runs a message from a live session of the user's by itself: one line, no card.
  if (peerRunsByItself(session, notice, hidden)) {
    const line = t("Message from {0} — Claude handles it once the current work is done", peerSenderNames(card.messages).join(", "));
    return (
      <div className="peer-card compact" role="region" aria-label={t("Messages from other sessions")} data-testid="Peer runs by itself">
        <div className="head">
          <span aria-hidden="true">✉</span>
          {locked ? (
            <span className="caption muted row grow" style={{ gap: 5 }} data-testid="Peer delivering">
              <span className="spinner" style={{ width: 10, height: 10 }} aria-hidden="true" />
              {t("Handing over…")}
            </span>
          ) : (
            <span className="caption grow truncate" title={line}>{line}</span>
          )}
          <button type="button" className="small" disabled={locked || card.heldIds.length === 0} onClick={() => void dismiss()} title={declineTitle} data-testid="Peer dismiss">
            {t("Decline")}
          </button>
          {more}
        </div>
      </div>
    );
  }

  const one = card.messages.length === 1;
  const title = one
    ? withNode(t("{0} session sent a message"), <b>{card.senders[0]}</b>)
    : withNode(t("{0} messages from other sessions"), <b>{card.messages.length}</b>);

  return (
    <div className="peer-card" role="region" aria-label={t("Messages from other sessions")} data-testid="Peer card">
      <div className="head">
        <span aria-hidden="true">✉</span>
        <span className="title" data-testid="Peer card title">{title}</span>
        {(card.delivering || busy === "accept") && (
          <span className="caption muted row" style={{ gap: 5, flex: "none" }} data-testid="Peer delivering">
            <span className="spinner" style={{ width: 10, height: 10 }} aria-hidden="true" />
            {t("Handing over…")}
          </span>
        )}
      </div>
      {!one && <div className="senders">{t("From: {0}", card.senders.join(", "))}</div>}
      <div className="sub">
        {t("The content shows once Claude takes it · the name is what the sender says")}
        {card.modeMismatch ? ` ${t("(held because the sending session's permission mode differs)")}` : ""}
      </div>
      {notice && (
        <div className="notice" role="alert" data-testid="Peer notice">⚠ {notice}</div>
      )}
      {card.joinsReview && !locked && <div className="hint" data-testid="Peer joins review">{t("The result joins the current review")}</div>}
      <div className="actions">
        {more}
        <span className="spacer" />
        {/* wave2 check-clients: a blocked "Claude가 처리" says why in one line, not only in its tooltip (as on the Mac). */}
        {card.acceptBlocked !== null && !locked && (
          <span className="caption muted truncate" title={card.acceptBlocked} data-testid="Peer accept waits">
            {card.acceptBlocked}
          </span>
        )}
        <button type="button" disabled={locked || card.heldIds.length === 0} onClick={() => void dismiss()} title={declineTitle} data-testid="Peer dismiss">
          {t("Decline")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={locked || card.heldIds.length === 0 || card.acceptBlocked !== null}
          onClick={() => void accept()}
          title={card.acceptBlocked ?? t("Runs every waiting message as one reviewed turn")}
          data-testid="Peer accept"
        >
          {t("Let Claude handle it")}
        </button>
      </div>
    </div>
  );
}
