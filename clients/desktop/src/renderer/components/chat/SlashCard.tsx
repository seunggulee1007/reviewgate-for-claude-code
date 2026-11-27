/**
 * MARK: b-slash — docs/PROTOCOL.md §56.5: the card over the composer for a typed `/status` (model, effort, mode, chat,
 * session, MCP servers) or a built-in only the terminal has ("이 명령은 터미널 채팅에서 써요" with Continue as Terminal
 * Chat — or New Terminal Chat when the chat has nothing to continue). As on the Mac (ComposerSlashSlot).
 */
import { continueAsTerminalBlocker, continueRefusalText, terminalChatsOffered } from "../../continueTerminal";
import { currentModelOption } from "../../hudModel";
import { t } from "../../i18n";
import { switchWaits } from "../../pendingSwitch";
import { displayChatTitle, newChatRefusal, sessionsOf } from "../../sessions";
import { shownChatId } from "../../slashAppRun";
import { terminalOnlyNotice } from "../../slashAppCommands";
import { capabilitiesOf, permissionMode, useStore } from "../../store";
import { usePtyInfo } from "../../terminal/ptyInfo";
import { effortLabel } from "./HudPopovers";
import { modeLabel } from "./ModeMenu";
import { styleDisplayName } from "../../outputStyles"; // §72.2

export type SlashCardKind = "status" | { terminalOnly: string };

export function SlashCard({ card, onClose }: { card: SlashCardKind; onClose: () => void }) {
  return (
    <div className="slash-card" role="status" data-testid="Composer slash card">
      <span className="grow">{card === "status" ? <StatusLines /> : <TerminalOnly name={card.terminalOnly} onDone={onClose} />}</span>
      <button type="button" className="plain tiny" onClick={onClose} aria-label={t("Close")} title={t("Close")}>×</button>
    </div>
  );
}

function StatusLines() {
  const state = useStore((s) => s.state);
  const mcp = useStore((s) => s.mcp);
  const caps = useStore((s) => capabilitiesOf(s).caps);
  const session = state.session;
  const option = currentModelOption(session.availableModels ?? [], session.selectedModel, session.model);
  const list = sessionsOf(state);
  const chat = list.list.find((m) => m.id === list.currentId);
  const servers = mcp.servers.length > 0 ? mcp.servers.length : (caps?.mcpServers?.length ?? 0);
  const attention = mcp.servers.filter((x) => x.status === "failed" || x.status === "needs-auth").length;
  const rows: [string, string][] = [
    [t("Model"), option?.displayName ?? session.model ?? t("Model default")],
    [t("Effort"), effortLabel(session.effort ?? null)],
    [t("Mode"), modeLabel(permissionMode(state))],
    ...(session.outputStyle ? [[t("Output style"), styleDisplayName(session.outputStyle)] as [string, string]] : []), // §72.2
    [t("Chat"), chat ? displayChatTitle(chat.title) : t("New chat")],
    ...(list.currentId ? [[t("Session"), list.currentId.slice(0, 8)] as [string, string]] : []),
    ["MCP", attention > 0 ? t("{0} servers · {1} need attention", servers, attention) : t("{0} servers", servers)],
  ];
  return (
    <span className="slash-status" data-testid="Slash status">
      {rows.map(([label, value]) => (
        <span key={label} className="slash-status-row">
          <span className="muted">{label}</span>
          <span className="truncate" title={value}>{value}</span>
        </span>
      ))}
    </span>
  );
}

function TerminalOnly({ name, onDone }: { name: string; onDone: () => void }) {
  const state = useStore((s) => s.state);
  const settings = useStore((s) => s.settings);
  const pty = usePtyInfo((s) => s.info?.available === true);
  const id = shownChatId();
  const meta = id ? sessionsOf(state).list.find((m) => m.id === id) : undefined;
  const blocker = meta ? continueAsTerminalBlocker(state, meta, switchWaits(state, false)) : null;
  const fresh = !meta || blocker === continueRefusalText("nothing_to_continue");
  const newWhy = newChatRefusal(state);
  return (
    <span className="slash-terminal-only">
      <span className="mono">/{name}</span> — {terminalOnlyNotice()}
      {terminalChatsOffered(settings, pty) &&
        (fresh ? (
          <button type="button" className="tiny" disabled={newWhy !== null} title={newWhy ?? t("Opens a terminal chat, where every / command works")}
            onClick={() => { onDone(); void useStore.getState().newTerminalChat(); }} data-testid="Slash new terminal chat">
            {t("New Terminal Chat")}
          </button>
        ) : (
          <button type="button" className="tiny" disabled={blocker !== null} title={blocker ?? t("This chat's conversation goes on in a terminal chat, where every / command works")}
            onClick={() => { onDone(); void useStore.getState().continueAsTerminalChat(meta!.id); }} data-testid="Slash continue as terminal chat">
            {t("Continue as Terminal Chat")}
          </button>
        ))}
    </span>
  );
}
