/**
 * Store slice (docs/M15-POLISH.md): chat tabs / history (`session_*`, `tabs_set`), `refresh`, and
 * the per-project UI preferences (`settings.ui[<hash>]`). Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { ProjectUI } from "../shared/ipc";
import type { RefreshScope } from "@reviewgate/engine";
import { newChatRefusal, projectRootHash, sessionsOf, sessionSwitchRefusal } from "./sessions";
import { holdSwitch, switchWaits } from "./pendingSwitch"; // r2-chats-cards M31 (§9)
import type { Store } from "./store";
import { sideSwitchWarning } from "./sideTrust"; // MARK: wave4b w4b-side
import type { SessionKind } from "@reviewgate/engine";
import { continueAsTerminalBlocker, continueRefusalText, defaultChatKind } from "./continueTerminal"; // §57.7 / §57.9 / §57.10
import { ptyAvailable } from "./terminal/ptyInfo"; // §57.10
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";

export type SessionSlice = {
  isRefreshing: boolean;
  /** Set before `session_new` / `session_open`: the next `transcript_restore` REPLACES the transcript instead of prepending. */
  replaceTranscript: boolean;
  /** UI preferences of the open project (pane widths, sidebar tab, last file). */
  ui: ProjectUI;
  /** `ui.selectedPath` of the project being opened — consumed by the first review snapshot that lists it. */
  wantedPath: string | null;

  /** [+] / Ctrl+T: a new chat of the default kind (§57.7 / §57.10: a terminal chat only while the preview offers it). */
  newChat(): Promise<boolean>;
  /** §57.5: Ctrl+Alt+T / "New Terminal Chat" — held like Ctrl+T while Claude works. */
  newTerminalChat(): Promise<boolean>;
  /** §57.7: Ctrl+Alt+Shift+T / "New Chat (Classic)" — the app's chat UI, whatever the default kind. */
  newClassicChat(): Promise<boolean>;
  /** §57.9: chat `id`'s conversation goes on in a new terminal chat (it becomes the live chat; `id` stays as a record). */
  continueAsTerminalChat(id: string): Promise<boolean>;
  openChat(id: string): Promise<boolean>;
  /** Adds `id` to the open tabs (`tabs_set`) unless it is already one; `apply` calls it for a new `currentId`. */
  ensureTab(id: string | null): void;
  closeTab(id: string): Promise<void>;
  renameChat(id: string, title: string): Promise<boolean>;
  archiveChat(id: string, archived: boolean): Promise<boolean>;
  /** Refused for the current session (`session_delete` guard); resolves false then. */
  deleteChat(id: string): Promise<boolean>;
  refresh(scope?: RefreshScope[]): Promise<boolean>;
  /** Merges into `ui`, persists it for the open project (`window.rg.setUI`) — call with `persist: false` for live drag frames. */
  setUI(patch: ProjectUI, persist?: boolean): void;
};

export const createSessionSlice: StateCreator<Store, [], [], SessionSlice> = (set, get) => {
  /** The client owns `openTabIds` (spec: `tabs_set` on every change); the engine echoes it in `state.sessions`. */
  const setTabs = (openTabIds: string[]) => {
    set((s) => ({ state: { ...s.state, sessions: { ...sessionsOf(s.state), openTabIds } } }));
    get().fire({ type: "tabs_set", openTabIds });
  };
  const ensureTab = (id: string | null) => {
    if (!id) return;
    const tabs = sessionsOf(get().state).openTabIds;
    if (!tabs.includes(id)) setTabs([...tabs, id]);
  };
  const swap = async (cmd: { type: "session_new"; kind?: SessionKind } | { type: "session_open"; sessionId: string }) => {
    if (sessionSwitchRefusal(get().state)) return false;
    // MARK: wave4b w4b-side — §40.3: a running side answer ends with the switch — ask first.
    const sideWarning = sideSwitchWarning(get().side);
    if (sideWarning && typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(sideWarning)) return false;
    set({ replaceTranscript: true });
    const ok = await get().run(cmd, { reportFailure: false });
    if (!ok) set({ replaceTranscript: false });
    else ensureTab(sessionsOf(get().state).currentId);
    return ok;
  };

  return {
    isRefreshing: false,
    replaceTranscript: false,
    ui: {},
    wantedPath: null,

    ensureTab,

    // r2-chats-cards M31 (§9): while Claude works (or the queue still holds messages) the new chat waits for the turn.
    newChat: () => (defaultChatKind(get().settings, ptyAvailable()) === "terminal" ? get().newTerminalChat() : get().newClassicChat()),

    newClassicChat: () => {
      const s = get();
      if (newChatRefusal(s.state) === null && switchWaits(s.state, s.queue.items.length > 0 || s.queue.inflight)) {
        holdSwitch({ kind: "new" });
        return Promise.resolve(true);
      }
      return swap({ type: "session_new" });
    },

    newTerminalChat: () => {
      const s = get();
      if (!s.state.project) return Promise.resolve(false);
      if (newChatRefusal(s.state) === null && switchWaits(s.state, s.queue.items.length > 0 || s.queue.inflight)) {
        holdSwitch({ kind: "newTerminal" });
        return Promise.resolve(true);
      }
      return swap({ type: "session_new", kind: "terminal" });
    },

    async continueAsTerminalChat(id) {
      const s = get();
      const meta = sessionsOf(s.state).list.find((m) => m.id === id);
      const why = meta ? continueAsTerminalBlocker(s.state, meta, switchWaits(s.state, s.queue.items.length > 0 || s.queue.inflight)) : null;
      if (why !== null) {
        set({ lastError: why, errorBanner: { message: why, scope: "session", fatal: false } });
        return false;
      }
      set({ replaceTranscript: true });
      try {
        await engineRequest({ type: "session_continue_terminal", sessionId: id });
        await get().settle();
        ensureTab(sessionsOf(get().state).currentId);
        return true;
      } catch (e) {
        set({ replaceTranscript: false });
        const r = refusalOf(e);
        const message = continueRefusalText(r.code) ?? refusalMessage(r);
        set({ lastError: message, errorBanner: { message, scope: "session", fatal: false } });
        return false;
      }
    },

    async openChat(id) {
      if (sessionsOf(get().state).currentId === id) {
        ensureTab(id);
        return true;
      }
      return swap({ type: "session_open", sessionId: id });
    },

    async closeTab(id) {
      const sessions = sessionsOf(get().state);
      const rest = sessions.openTabIds.filter((x) => x !== id);
      if (sessions.currentId === id) {
        // The current chat keeps its tab while the engine would refuse leaving it (see `sessionSwitchRefusal`).
        if (sessionSwitchRefusal(get().state)) return;
        const idx = sessions.openTabIds.indexOf(id);
        const neighbor = rest[Math.min(idx, rest.length - 1)];
        const ok = neighbor ? await get().openChat(neighbor) : await get().newChat();
        if (!ok) return;
      }
      setTabs(sessionsOf(get().state).openTabIds.filter((x) => x !== id));
    },

    renameChat: (id, title) => get().run({ type: "session_rename", sessionId: id, title: title.trim() }, { reportFailure: false }),

    archiveChat: (id, archived) => get().run({ type: "session_archive", sessionId: id, archived }, { reportFailure: false }),

    async deleteChat(id) {
      if (sessionsOf(get().state).currentId === id) return false;
      const ok = await get().run({ type: "session_delete", sessionId: id }, { reportFailure: false });
      if (ok) setTabs(sessionsOf(get().state).openTabIds.filter((x) => x !== id));
      return ok;
    },

    async refresh(scope) {
      if (!get().state.project || get().isRefreshing) return false;
      set({ isRefreshing: true });
      try {
        return await get().run({ type: "refresh", scope }, { reportFailure: false });
      } finally {
        set({ isRefreshing: false });
      }
    },

    setUI(patch, persist = true) {
      const root = get().state.project?.root;
      const hash = root ? projectRootHash(root) : null;
      set((s) => {
        const ui = { ...s.ui, ...patch };
        // Keep the cached settings in step so re-opening the project in this window sees the latest prefs.
        const settings = persist && hash && s.settings ? { ...s.settings, ui: { ...s.settings.ui, [hash]: ui } } : s.settings;
        return { ui, settings };
      });
      if (persist && hash) void window.rg.setUI(hash, patch);
    },
  };
};
