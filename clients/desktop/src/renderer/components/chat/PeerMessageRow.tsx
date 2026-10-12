/**
 * A message from another of the user's Claude sessions in the transcript (docs/PROTOCOL.md §29): delivered — the turn's
 * first row, in place of the user message: the sender as it names itself, the body (Markdown) and the kernel-verified
 * pid —, dropped (declined / expired / the session ended) as one line, and the fallback of a CLI that ran it without
 * holding it: the body with "이 메시지 처리하기", which sends it as an ordinary message of the user's.
 */
import { t } from "../../i18n";
import { droppedText, peerSenderName, type PeerRow } from "../../peer";
import { useStore } from "../../store";
import { Markdown } from "./Markdown";
import "../session.css";

export function PeerMessageRow({ item }: { item: PeerRow }) {
  const handle = useStore((s) => s.handleUnpromptedPeer);
  const canSend = useStore((s) => s.state.gate.canSend);
  const name = peerSenderName(item);
  if (item.state === "dropped") {
    return (
      <div className="peer-dropped" data-testid="Peer dropped" data-outcome={item.outcome ?? ""}>
        <span aria-hidden="true">✉</span>
        <span>{droppedText(item)}</span>
      </div>
    );
  }
  const pid = item.verifiedPeerPid !== null ? <span className="peer-pid" title={t("The process id the operating system confirmed for the sender")}>{t("verified pid {0}", item.verifiedPeerPid)}</span> : null;
  if (item.unprompted) {
    return (
      <div className="peer-row unprompted" data-testid="Peer unprompted">
        <div className="peer-head">
          <span aria-hidden="true">✉</span>
          <span className="bold">{t("Message from another session — Claude read it without a request (changes were blocked)")}</span>
        </div>
        <div className="peer-head">
          <span>{t("Another Claude session · {0}", name)}</span>
          {pid}
        </div>
        {item.body && (
          <div className="peer-body">
            <Markdown text={item.body} />
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            className="small"
            disabled={item.handled === true || !item.body}
            title={canSend ? t("Sends it to Claude as your own message — the review applies as usual") : t("Queued: it goes out as your own message once Claude can take one")}
            onClick={() => handle(item.id)}
            data-testid="Peer handle message"
          >
            {item.handled ? t("Sent as your message") : t("Handle this message")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="peer-row" data-testid="Peer message" data-turn={item.turn ?? ""}>
      <div className="peer-head">
        <span aria-hidden="true">✉</span>
        <span className="bold">{t("Another Claude session · {0}", name)}</span>
      </div>
      {item.body && (
        <div className="peer-body">
          <Markdown text={item.body} />
        </div>
      )}
      {pid}
    </div>
  );
}
