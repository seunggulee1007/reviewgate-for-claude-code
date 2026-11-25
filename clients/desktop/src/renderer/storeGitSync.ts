/**
 * MARK: git-sync — docs/PROTOCOL.md §68 on Windows (as the Mac's `AppState+GitSync`, Core `GitSync.swift`): Fetch and Pull
 * from the branch menu, their outcome — or refusal, with the files a pull would have replaced — as `gitSyncNotice` under
 * the branch line, and the quiet automatic fetch on project open / window focus (`settings.autoFetch`, the engine throttles
 * it to every 5 minutes; nothing is shown either way). Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { fetchDisabledReason, fetchedText, pulledText, pullDisabledReason, refusalNotice, syncOf, type GitSyncNotice } from "./gitSync";
import type { Store } from "./store";

export type GitSyncSlice = {
  /** What the last Fetch / Pull the user asked for came to (null: nothing to show). */
  gitSyncNotice: GitSyncNotice | null;
  /** §68.1 Fetch (every remote with `all`). */
  gitFetch(all?: boolean): Promise<void>;
  /** §68.2 Pull, fast-forward only; §68.3 with `rebase`. */
  gitPull(rebase?: boolean): Promise<void>;
  /** §68.4: the quiet fetch — only with `settings.autoFetch` on; never shows anything. */
  autoFetch(): Promise<void>;
  dismissGitSyncNotice(): void;
};

export const createGitSyncSlice: StateCreator<Store, [], [], GitSyncSlice> = (set, get) => ({
  gitSyncNotice: null,

  async gitFetch(all = false) {
    const sync = syncOf(get().state);
    if (!sync || fetchDisabledReason(sync) !== null) return;
    set({ gitSyncNotice: null });
    try {
      const reply = await engineRequest({ type: "git_fetch", ...(all ? { all: true } : {}) });
      await get().settle();
      set({ gitSyncNotice: { kind: "info", text: fetchedText(reply), paths: [] } });
    } catch (e) {
      await get().settle();
      set({ gitSyncNotice: { kind: "error", text: refusalMessage(refusalOf(e)), paths: [] } });
    }
  },

  async gitPull(rebase = false) {
    const sync = syncOf(get().state);
    if (!sync || pullDisabledReason(sync) !== null) return;
    set({ gitSyncNotice: null });
    try {
      const reply = await engineRequest({ type: "git_pull", ...(rebase ? { rebase: true } : {}) });
      await get().settle();
      set({ gitSyncNotice: { kind: reply.mode === "up_to_date" ? "info" : "success", text: pulledText(reply), paths: reply.files } });
    } catch (e) {
      await get().settle();
      const r = refusalOf(e);
      set({ gitSyncNotice: refusalNotice(r.code, refusalMessage(r), r.paths ?? []) });
    }
  },

  async autoFetch() {
    if (!syncOf(get().state) || get().settings?.autoFetch === false) return;
    try {
      await engineRequest({ type: "git_fetch", auto: true });
    } catch {
      // quiet: the branch menu shows the last fetch error (`sync.lastFetchError`)
    }
  },

  dismissGitSyncNotice() {
    set({ gitSyncNotice: null });
  },
});
