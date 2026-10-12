/**
 * Settings › General › 다른 세션 메시지 (docs/PROTOCOL.md §29): what happens when another of the user's Claude sessions
 * (a terminal, an IDE) sends this app a message — ask (a card, the default), run it when idle, or decline. The default of
 * every project; a project's own choice in its project menu (`peer_set`) wins.
 */
// Types only from the engine: a value import would pull the whole engine (and the SDK) into the renderer bundle.
import type { PeerInboundMode } from "@reviewgate/engine";
import type { AppSettings } from "../../../shared/ipc";
import { t } from "../../i18n";
import { PEER_MODES, peerModeLabel } from "../../peer";
import { useStore } from "../../store";

export function PeerInboundSection({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const mode: PeerInboundMode = PEER_MODES.find((m) => m === settings.peerInbound) ?? "ask";
  return (
    <section>
      <h4>{t("Messages from other sessions")}</h4>
      <div className="field-row">
        <span>{t("When another session sends a message")}</span>
        <select value={mode} onChange={(e) => void save({ peerInbound: e.target.value as PeerInboundMode })} data-testid="Peer inbound">
          {PEER_MODES.map((m) => (
            <option key={m} value={m}>{peerModeLabel(m)}</option>
          ))}
        </select>
      </div>
      <div className="note">
        {t("Your other Claude sessions (a terminal, an IDE) can send this app a message. Ask: a card asks you first. When idle: it runs as an ordinary reviewed turn once nothing else is going on. Don't accept: it is declined. A project can choose for itself in its project menu.")}
      </div>
    </section>
  );
}
