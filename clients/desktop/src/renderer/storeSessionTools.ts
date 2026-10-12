/**
 * MARK: wave3 desktop-session
 * Store slice for docs/PROTOCOL.md §36.6–36.9 — the client state that is not in the engine's snapshot: the per-project
 * "Load local settings" choice (kept in the app settings, sent before `open_project` by main), `retry_extensions` in
 * flight and its refusal, the fallback banner closed for this project, the installed CLI versions (`cli_versions`), the
 * pin and the CLI banners closed. Spread into `useStore` (store.ts); `resetSessionTools` runs with every project switch.
 */
import type { StateCreator } from "zustand";
import type { CliVersionsEvent } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { cliSessionsOf, loadDismissedCliVersions, saveDismissedCliVersions, type CliSessionsView } from "./sessionTools";
import { sessionsOf, sessionSwitchRefusal } from "./sessions";
import type { Store } from "./store";

/** What `retry_extensions` did. */
export type ExtensionsRetryOutcome =
  /** The session restarts with the user's extensions. */
  | "started"
  /** Nothing to retry: the fallback was already over (`extensions_on`). */
  | "alreadyOn"
  /** Refused (busy, …): `extensionsRetryError` says why. */
  | "refused"
  /** An engine before §36 (or no session): the project was reopened instead, as before. */
  | "unsupported";

export type SessionToolsSlice = {
  // §36.7
  /** A `retry_extensions` is in flight. */
  extensionsRetrying: boolean;
  /** Why the last `retry_extensions` was refused, in words; null after a success. */
  extensionsRetryError: string | null;
  /** The user closed the fallback banner: later fallbacks of this project (the engine's own retry) keep it closed — the HUD's "Extensions off" chip stays. */
  fallbackBannerSilenced: boolean;
  // §36.8
  /** The last `cli_versions` reply (app-wide: kept across project switches). */
  cliVersions: CliVersionsEvent | null;
  cliVersionsLoading: boolean;
  cliVersionsError: string | null;
  /** False once the engine answered `unknown_command` (the list is off with the reason). */
  cliVersionsSupported: boolean;
  /** The CLI banners the user closed (versions; `pin:<version>` for the restart hint) — app-wide, so each is shown once. */
  cliBannerDismissed: string[];
  /** Why the last pin / unpin did not go through. */
  cliPinError: string | null;
  // §36.9
  /** This project's other Claude sessions (`cli_sessions`); null until the first reply. */
  cliSessions: CliSessionsView | null;
  cliSessionsLoading: boolean;
  cliSessionsError: string | null;
  /** False once the engine answered `unknown_command`: no sidebar section, no import sheet. */
  cliSessionsSupported: boolean;
  /** The "Import a CLI session" sheet is open. */
  cliImportOpen: boolean;
  /** The terminal session an import is running for. */
  importingSessionId: string | null;
  /** Why the last import was refused, in words. */
  cliImportError: string | null;

  /** §36.6: stores this project's "Load local settings (settings.local.json)" (main sends it to the engine; next session start). */
  setLoadLocalSettings(on: boolean): Promise<void>;
  /** §36.7 `retry_extensions`: restarts the session with the user's extensions (resumed, the review kept); an older engine reopens the project. */
  retryExtensions(): Promise<ExtensionsRetryOutcome>;
  /** The fallback banner's ✕ (the chip keeps saying it). */
  silenceFallbackBanner(): void;
  /** §36.8 `cli_versions`: the installed versions (Settings "Pin CLI version"). */
  loadCliVersions(): Promise<void>;
  /** §36.8: pins `~/.local/share/claude/versions/<version>` as `claudePath` (main builds and checks the path); null unpins → null, or the reason. */
  pinCliVersion(version: string | null): Promise<string | null>;
  /** Closes the CLI banner `key` for good (a version, or `pin:<version>`). */
  dismissCliBanner(key: string): void;
  /** §36.9 `cli_sessions` (query lane; never waits behind a turn). */
  loadCliSessions(): Promise<void>;
  /** Opens / closes the import sheet (opening asks for a fresh list). */
  setCliImportOpen(open: boolean): void;
  /** §36.9 `cli_session_import`: a new chat of this window resumes that terminal conversation → null, or the refusal in words. */
  importCliSession(sessionId: string): Promise<string | null>;
  /** What the window forgets when it opens / closes a project. */
  resetSessionTools(): void;
};

/** An Error from the bridge in words (Electron prefixes errors thrown across `invoke`). */
const bridgeError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method \S+ (Error: )?/, "");

export const createSessionToolsSlice: StateCreator<Store, [], [], SessionToolsSlice> = (set, get) => ({
  extensionsRetrying: false,
  extensionsRetryError: null,
  fallbackBannerSilenced: false,
  cliVersions: null,
  cliVersionsLoading: false,
  cliVersionsError: null,
  cliVersionsSupported: true,
  cliBannerDismissed: loadDismissedCliVersions(),
  cliPinError: null,
  cliSessions: null,
  cliSessionsLoading: false,
  cliSessionsError: null,
  cliSessionsSupported: true,
  cliImportOpen: false,
  importingSessionId: null,
  cliImportError: null,

  async setLoadLocalSettings(on) {
    const root = get().state.project?.root;
    if (!root) return;
    const flags = { ...(get().settings?.projectLoadLocalSettings ?? {}) };
    const key = projectRootHash(root);
    // Absent = on: only "off" needs an entry.
    if (on) delete flags[key];
    else flags[key] = false;
    await get().saveSettings({ projectLoadLocalSettings: flags });
  },

  async retryExtensions() {
    if (get().extensionsRetrying) return "refused";
    set({ extensionsRetrying: true, extensionsRetryError: null });
    try {
      await engineRequest({ type: "retry_extensions" });
      await get().settle();
      return "started";
    } catch (e) {
      const r = refusalOf(e);
      if (r.code === "unknown_command" || r.code === "no_session") {
        // An engine before §36.7, or no session to restart: reopen the project, as before.
        await get().retryWithExtensions();
        return "unsupported";
      }
      if (r.code === "extensions_on") return "alreadyOn";
      set({ extensionsRetryError: refusalMessage(r) });
      return "refused";
    } finally {
      set({ extensionsRetrying: false });
    }
  },

  silenceFallbackBanner() {
    set({ fallbackBannerSilenced: true, dismissedFallbackAt: get().state.session.extensions?.fallback?.at ?? null });
  },

  async loadCliVersions() {
    if (get().cliVersionsLoading) return;
    set({ cliVersionsLoading: true });
    try {
      const reply = await engineRequest({ type: "cli_versions" });
      set({ cliVersions: reply, cliVersionsError: null, cliVersionsSupported: true });
    } catch (e) {
      const r = refusalOf(e);
      if (r.code === "unknown_command") set({ cliVersionsSupported: false, cliVersionsError: null });
      else set({ cliVersionsError: refusalMessage(r) });
    } finally {
      set({ cliVersionsLoading: false });
    }
  },

  async pinCliVersion(version) {
    try {
      const settings = version ? await window.rg.pinClaudeVersion(version) : await window.rg.clearExecutable("claude");
      set({ settings, cliPinError: null });
      void get().loadCliVersions();
      return null;
    } catch (e) {
      const why = bridgeError(e);
      set({ cliPinError: why });
      return why;
    }
  },

  dismissCliBanner(key) {
    const next = [...get().cliBannerDismissed.filter((k) => k !== key), key];
    saveDismissedCliVersions(next);
    set({ cliBannerDismissed: next });
  },

  async loadCliSessions() {
    const root = get().state.project?.root;
    if (!root || get().cliSessionsLoading || !get().cliSessionsSupported) return;
    set({ cliSessionsLoading: true });
    try {
      const reply = await engineRequest({ type: "cli_sessions" });
      // A reply for a project this window has left since is dropped.
      if (get().state.project?.root === root) set({ cliSessions: cliSessionsOf(reply), cliSessionsError: null });
    } catch (e) {
      const r = refusalOf(e);
      if (r.code === "unknown_command") set({ cliSessionsSupported: false, cliSessions: null, cliSessionsError: null, cliImportOpen: false });
      else if (r.code !== "no_project") set({ cliSessionsError: refusalMessage(r) });
    } finally {
      set({ cliSessionsLoading: false });
    }
  },

  setCliImportOpen(open) {
    set({ cliImportOpen: open, cliImportError: null });
    if (open) void get().loadCliSessions();
  },

  async importCliSession(sessionId) {
    if (get().importingSessionId) return null;
    const blocked = sessionSwitchRefusal(get().state);
    if (blocked) return blocked;
    // Like session_open: the chat becomes current and `transcript_restore {items: []}` REPLACES the rows.
    set({ importingSessionId: sessionId, cliImportError: null, replaceTranscript: true });
    try {
      await engineRequest({ type: "cli_session_import", sessionId });
      await get().settle();
      get().ensureTab(sessionsOf(get().state).currentId);
      set({ cliImportOpen: false });
      void get().loadCliSessions();
      return null;
    } catch (e) {
      const words = refusalMessage(refusalOf(e));
      set({ replaceTranscript: false, cliImportError: words });
      return words;
    } finally {
      set({ importingSessionId: null });
    }
  },

  resetSessionTools() {
    set({
      extensionsRetrying: false,
      extensionsRetryError: null,
      fallbackBannerSilenced: false,
      cliPinError: null,
      cliSessions: null,
      cliSessionsError: null,
      cliSessionsLoading: false,
      cliImportOpen: false,
      importingSessionId: null,
      cliImportError: null,
    });
  },
});
