/**
 * §57.5 / §57.9 / §57.10: the menu bar's terminal-chat items (src/main/menu.ts shows them while "Terminal chat (preview)"
 * is on and a PTY can run): Chat › New Terminal Chat, New Chat (Classic), Continue as Terminal Chat; View › Toggle Terminal
 * Panel whenever the shell panel can open. The store loads on
 * first use (as menuActions.lifecycle.ts does), so this table stays importable without a window.
 */
import type { MenuActionHandlers } from "./menuActions";

async function newOfKind(kind: "terminal" | "classic"): Promise<void> {
  const [{ useStore }, { newChatRefusal }] = await Promise.all([import("./store"), import("./sessions")]);
  const s = useStore.getState();
  const why = newChatRefusal(s.state);
  // A blocked item says why on the banner (never a silent no-op).
  if (why !== null) return void useStore.setState({ lastError: why, errorBanner: { message: why, scope: "session", fatal: false } });
  await (kind === "terminal" ? s.newTerminalChat() : s.newClassicChat());
}

/** The chat on screen (the live one, or one shown read-only) goes on in a terminal chat. */
async function continueShownChat(): Promise<void> {
  const [{ useStore }, { sessionsOf }, { useViewedChat, viewingOf }] = await Promise.all([import("./store"), import("./sessions"), import("./viewedChat")]);
  const s = useStore.getState();
  const id = viewingOf(useViewedChat.getState().chat, s.state)?.id ?? sessionsOf(s.state).currentId;
  if (id) await s.continueAsTerminalChat(id);
}

export const terminalMenuActions: MenuActionHandlers = {
  new_terminal_chat: () => void newOfKind("terminal"),
  new_classic_chat: () => void newOfKind("classic"),
  continue_as_terminal: () => void continueShownChat(),
  // View › Toggle Terminal Panel (Ctrl+`, the renderer's key): the bottom shell panel.
  toggle_terminal_panel: () => void import("./components/terminal/ShellPanel").then((m) => m.toggleShellPanelFromMenu()),
};
