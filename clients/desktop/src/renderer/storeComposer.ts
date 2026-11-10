/**
 * Store slice for the composer's daily-use commands (docs/PROTOCOL.md §23–27): `list_files` for @-mentions,
 * `attachment_get` thumbnails (cached), `set_model`, `compact` and the `context_warning` banner, and `rewind`
 * (edit & retry / "이 시점으로 되돌리기") with its follow-up — the new chat becomes the current tab and the
 * transcript is replaced by the engine's `transcript_restore`. Spread into `useStore` (store.ts).
 */
import { create, type StateCreator } from "zustand";
import type { EffortLevel, EngineEvent, FileItem, ImageMediaType, RewindMode, RewoundKeptEvent, SendAttachment } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { showToast } from "./toast";
import { sessionsOf } from "./sessions";
import type { Store } from "./store";

/** §27 `context_warning` as the banner keeps it (`at`: when it arrived). */
export type ContextWarning = { percent: number; contextTokens: number; contextWindow: number; at: number };

export type RewindRequest = { toTurn: number; mode: RewindMode; editText?: string; mentions?: string[]; attachments?: SendAttachment[]; force?: boolean };
export type RewindOutcome =
  | { ok: true; restoredFiles: string[]; sessionId: string | null }
  | { ok: false; code: string; message: string; paths?: string[] };

export type ComposerSlice = {
  contextWarning: ContextWarning | null;
  /** A `rewind` is waiting for its reply (the dialogs / inline editor are locked meanwhile). */
  rewinding: boolean;

  /** §27 events → the slice; true when the event was one of them. */
  applyComposerEvent(ev: EngineEvent): boolean;
  resetComposer(): void;
  dismissContextWarning(): void;
  /** §23 `list_files` → the matches ([] without a project). Rejects with the refusal (`list_files_failed`). */
  listFiles(query: string, limit?: number): Promise<FileItem[]>;
  /** §25 `set_model` → null, or the refusal in words. */
  setModel(model: string, effort?: EffortLevel | null): Promise<string | null>;
  /** §27 `compact { focus? }` → null, or the refusal in words. */
  compact(focus?: string): Promise<string | null>;
  /** §26 `rewind` — on success the new chat is current, its tab replaces the old one and the review is re-read. */
  rewind(req: RewindRequest): Promise<RewindOutcome>;
  /** "먼저 리뷰를 마무리하세요" → the Changes tab with the first pending file selected. */
  jumpToReview(): void;
};

// ---------------------------------------------------------------- attachment cache (§24 attachment_get)

type ImageData = { mediaType: ImageMediaType; dataBase64: string };
const attachmentCache = new Map<string, Promise<ImageData>>();

/** The image a transcript row references, fetched once per hash (failures are retried next time). */
export function attachmentData(hash: string, request: typeof engineRequest = engineRequest): Promise<ImageData> {
  const hit = attachmentCache.get(hash);
  if (hit) return hit;
  const p = request({ type: "attachment_get", hash }).then((r) => ({ mediaType: r.mediaType, dataBase64: r.dataBase64 }));
  attachmentCache.set(hash, p);
  p.catch(() => attachmentCache.delete(hash));
  return p;
}

/** Puts an image we just sent into the cache under its sha-256 (what the engine names it), so its thumbnail needs no fetch. */
export async function seedAttachment(a: SendAttachment): Promise<void> {
  try {
    const bin = atob(a.dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!attachmentCache.has(hash)) attachmentCache.set(hash, Promise.resolve({ mediaType: a.mediaType, dataBase64: a.dataBase64 }));
  } catch {
    /* no WebCrypto: the thumbnail is fetched with attachment_get instead */
  }
}

export const dataURL = (d: ImageData): string => `data:${d.mediaType};base64,${d.dataBase64}`;

// ---------------------------------------------------------------- slice

export const createComposerSlice: StateCreator<Store, [], [], ComposerSlice> = (set, get) => {
  const words = (e: unknown) => refusalMessage(refusalOf(e));

  return {
    contextWarning: null,
    rewinding: false,

    applyComposerEvent(ev) {
      if (ev.type === "context_warning") {
        set({ contextWarning: { percent: ev.percent, contextTokens: ev.contextTokens, contextWindow: ev.contextWindow, at: Date.now() } });
        return true;
      }
      return false;
    },

    resetComposer() {
      set({ contextWarning: null, rewinding: false });
    },

    dismissContextWarning() {
      set({ contextWarning: null });
    },

    async listFiles(query, limit) {
      if (!get().state.project) return [];
      const r = await engineRequest({ type: "list_files", query, ...(limit ? { limit } : {}) });
      return r.items;
    },

    async setModel(model, effort) {
      try {
        await engineRequest({ type: "set_model", model, ...(effort !== undefined ? { effort } : {}) });
        await get().settle();
        return null;
      } catch (e) {
        return words(e);
      }
    },

    async compact(focus) {
      const f = focus?.trim();
      try {
        await engineRequest({ type: "compact", ...(f ? { focus: f } : {}) });
        set({ contextWarning: null });
        return null;
      } catch (e) {
        return words(e);
      }
    },

    async rewind(req) {
      if (get().rewinding) return { ok: false, code: "session_busy", message: refusalMessage({ code: "session_busy", error: "session_busy", detail: "" }) };
      const conversation = req.mode !== "files";
      const before = sessionsOf(get().state);
      const oldId = before.currentId;
      // A conversation rewind switches chats: the engine's next `transcript_restore` holds the kept rows of the new one.
      set({ rewinding: true, ...(conversation ? { replaceTranscript: true } : {}) });
      try {
        const r = await engineRequest({
          type: "rewind",
          toTurn: req.toTurn,
          mode: req.mode,
          ...(req.editText !== undefined && req.editText.trim().length > 0 ? { editText: req.editText.trim() } : {}),
          ...(req.mentions && req.mentions.length > 0 ? { mentions: req.mentions } : {}),
          ...(req.attachments && req.attachments.length > 0 ? { attachments: req.attachments } : {}),
          ...(req.force ? { force: true } : {}),
        });
        await get().settle();
        const newId = r.sessionId ?? sessionsOf(get().state).currentId;
        if (conversation && newId && oldId && newId !== oldId) {
          // The fork takes the old chat's tab (the old one stays in the history as "(되돌리기 전)").
          const tabs = sessionsOf(get().state).openTabIds;
          const next = [...new Set(tabs.map((id) => (id === oldId ? newId : id)))];
          if (!next.includes(newId)) next.push(newId);
          if (next.join("\n") !== tabs.join("\n")) {
            set((s) => ({ state: { ...s.state, sessions: { ...sessionsOf(s.state), openTabIds: next } } }));
            get().fire({ type: "tabs_set", openTabIds: next });
          }
        }
        if (conversation) set({ contextWarning: null });
        // The review follows the worktree: re-read the selected diff (the snapshot's new B clears the cache too).
        set({ diffCache: {}, fullFileCache: {} });
        const sel = get().selectedPath;
        if (sel && get().state.changedFiles.some((f) => f.path === sel)) get().selectFile(sel);
        set({ rewinding: false });
        // §35.11: what nothing of Claude's changed in those turns (an IntelliJ save, another session) stayed as it is.
        const kept = (r as RewoundKeptEvent).keptFiles ?? [];
        if (kept.length > 0) showToast(t("{0} file(s) changed outside the app stay as they are", kept.length));
        return { ok: true, restoredFiles: r.restoredFiles, sessionId: r.sessionId };
      } catch (e) {
        const rf = refusalOf(e);
        set({ rewinding: false, ...(conversation ? { replaceTranscript: false } : {}) });
        return { ok: false, code: rf.code, message: refusalMessage(rf), ...(rf.paths ? { paths: rf.paths } : {}) };
      }
    },

    jumpToReview() {
      const files = get().state.changedFiles;
      const first = files.find((f) => f.state === "pending" || f.state === "changesRequested") ?? files[0];
      get().openDialog(null);
      get().setTab("changes");
      if (!get().sidebarVisible) get().toggleSidebar();
      if (first) get().revealFile(first.path);
    },
  };
};

// ---------------------------------------------------------------- MARK: r2-review-flow — polish P4-composer-08

/** What each chat's composer holds that a tab's × would lose or keep: images attached (never saved), a typed draft (kept). */
export type ComposerPresence = { images: number; draft: boolean };

/**
 * The composer reports, per chat id, whether it holds a draft or images; the chat tabs read it (a pencil dot on a tab with an
 * unsent draft, a question before closing one with images). Its own tiny store — never part of the project state.
 */
export const useComposerPresence = create<{ byChat: Record<string, ComposerPresence>; report(chatId: string, p: ComposerPresence): void; clear(): void }>((set, get) => ({
  byChat: {},
  report(chatId, p) {
    const had = get().byChat[chatId];
    const empty = p.images === 0 && !p.draft;
    if (had ? had.images === p.images && had.draft === p.draft : empty) return; // nothing changed: no redraw of the tabs
    const byChat = { ...get().byChat };
    if (empty) delete byChat[chatId];
    else byChat[chatId] = p;
    set({ byChat });
  },
  clear() {
    set({ byChat: {} });
  },
}));
