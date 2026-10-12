/**
 * Store slice (docs/M15-POLISH.md): chat tabs / history (`session_*`, `tabs_set`), `refresh`, and
 * the per-project UI preferences (`settings.ui[<hash>]`). Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { ProjectUI } from "../shared/ipc";
import type { RefreshScope } from "@reviewgate/engine";
import { projectRootHash, sessionsOf, sessionSwitchRefusal } from "./sessions";
import type { Store } from "./store";
import { sideSwitchWarning } from "./sideTrust"; // MARK: wave4b w4b-side

export type SessionSlice = {
  isRefreshing: boolean;
  /** Set before `session_new` / `session_open`: the next `transcript_restore` REPLACES the transcript instead of prepending. */
  replaceTranscript: boolean;
  /** UI preferences of the open project (pane widths, sidebar tab, last file). */
  ui: ProjectUI;
  /** `ui.selectedPath` of the project being opened — consumed by the first review snapshot that lists it. */
  wantedPath: string | null;

  newChat(): Promise<boolean>;
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
  const swap = async (cmd: { type: "session_new" } | { type: "session_open"; sessionId: string }) => {
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

    newChat: () => swap({ type: "session_new" }),

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
