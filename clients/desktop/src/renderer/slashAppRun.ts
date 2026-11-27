/**
 * MARK: b-slash — docs/PROTOCOL.md §56.5: what a typed built-in does in a classic chat (src/renderer/slashAppCommands.ts),
 * with the window's real screens: the HUD's model picker (`useSlashUi`), §71.1 the usage dialog, the dialogs, the agent panel,
 * the chat tab's close and rename. As on the Mac (App ComposerSlashCommands.swift).
 */
import { create } from "zustand";
import { addDir } from "./addedDirs"; // §67.1
import { copyResponse, exportToFile, loadExport } from "./chatExport"; // §70.3
import { t } from "./i18n";
import { pressKey } from "./menuActions.lifecycle";
import { checkpointsOf } from "./rewind";
import { sessionsOf, sessionSwitchRefusal } from "./sessions";
import type { SlashAppCommand } from "./slashAppCommands";
import { useStore } from "./store";
import { useViewedChat, viewingOf } from "./viewedChat";

/** Requests the HUD and the tab strip take (each `seq` is a new one). */
type SlashUi = {
  hud: { kind: "model"; seq: number } | null;
  rename: number;
  requestHud(kind: "model"): void;
  requestRename(): void;
};

export const useSlashUi = create<SlashUi>((set, get) => ({
  hud: null,
  rename: 0,
  requestHud: (kind) => set({ hud: { kind, seq: (get().hud?.seq ?? 0) + 1 } }),
  requestRename: () => set({ rename: get().rename + 1 }),
}));

/** What the composer shows after a command: the card over the box, or a line in its notice. */
export type SlashOutcome = { card: "status" | { terminalOnly: string } } | { notice: string } | null;

/** The chat on screen: the one shown read-only, else the live one. */
export function shownChatId(): string | null {
  const s = useStore.getState();
  return viewingOf(useViewedChat.getState().chat, s.state)?.id ?? sessionsOf(s.state).currentId ?? null;
}

/** Runs `cmd`; `notify` gets a refusal that comes later (a model the session refused). */
export function runSlashAppCommand(cmd: SlashAppCommand, notify: (text: string) => void): SlashOutcome {
  const st = useStore.getState();
  switch (cmd.kind) {
    case "model":
      if (cmd.name === "") {
        useSlashUi.getState().requestHud("model");
        return null;
      }
      setModelNamed(cmd.name, notify);
      return null;
    case "resume":
      st.openDialog({ kind: "history" });
      return null;
    case "rewind": {
      const last = checkpointsOf(st.state).reduce<number | null>((max, c) => (max === null || c.turn > max ? c.turn : max), null);
      if (last === null) return { notice: t("Nothing to rewind yet — no message has a rewind point") };
      st.openDialog({ kind: "rewind", turn: last });
      return null;
    }
    case "context":
      st.openDialog({ kind: "compact" }); // its first line is how full the context is
      return null;
    case "usage": // §71.1 (/cost and /stats too)
      st.openDialog({ kind: "usage" });
      return null;
    case "permissions":
      st.openDialog({ kind: "settings", tab: "permissions" });
      return null;
    case "config":
      st.openDialog({ kind: "settings" });
      return null;
    case "agents":
      st.toggleAgentPanel(true);
      return null;
    case "memory":
      st.openDialog({ kind: "extensions" });
      return null;
    case "help":
      st.openDialog({ kind: "shortcuts" });
      return null;
    case "status":
      return { card: "status" };
    case "rename":
      useSlashUi.getState().requestRename();
      return null;
    case "exit": {
      const why = closeRefusal();
      if (why !== null) return { notice: why };
      pressKey({ key: "W", code: "KeyW", shift: true }); // as Chat › Close Chat Tab: the chat stays in the history
      return null;
    }
    case "terminalOnly":
      return { card: { terminalOnly: cmd.name } };
    case "addDir":
      // §67.1: the composer runs it itself (the box keeps the draft on a refusal); from elsewhere the outcome is a notice.
      void addDir(cmd.path).then((r) => r && notify(r.notice));
      return null;
    case "export": // §70.3: the file, or the dialog (copy / save)
      if (cmd.file === "") void loadExport().then((r) => ("export" in r ? st.openDialog({ kind: "chatExport", export: r.export }) : notify(r.notice)));
      else void exportToFile(cmd.file).then((r) => notify(r.notice));
      return null;
    case "copy":
      void copyResponse(cmd.arg).then((r) => notify(r.notice));
      return null;
  }
}

/** Why the chat tab on screen cannot close now (the tab strip's rule); null: it can. */
function closeRefusal(): string | null {
  const s = useStore.getState();
  const list = sessionsOf(s.state);
  const id = shownChatId();
  if (!id || !list.openTabIds.includes(id)) return t("The only open chat cannot be closed");
  if (id !== list.currentId) return null;
  return sessionSwitchRefusal(s.state) ?? (list.openTabIds.length < 2 ? t("The only open chat cannot be closed") : null);
}

/** `/model <name>`: a listed model by its value or name, else the name as typed (the CLI's aliases: opus, sonnet …). */
function setModelNamed(name: string, notify: (text: string) => void): void {
  const st = useStore.getState();
  const lower = name.toLowerCase();
  const option = (st.state.session.availableModels ?? []).find((m) => m.value.toLowerCase() === lower || m.displayName.toLowerCase() === lower);
  if (st.settings?.modelMode === "auto") void st.saveSettings({ modelMode: "manual" }); // a model is a manual pick, as in the picker
  void st.setModel(option?.value ?? name).then((err) => {
    if (err) notify(err);
  });
}
