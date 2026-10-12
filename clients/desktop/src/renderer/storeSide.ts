/**
 * Store slice: side questions (docs/PROTOCOL.md §21 — the side panel, its threads, promote to the main
 * conversation) and MCP server management (§22 — the list in "Applied extensions", reconnect / toggle /
 * add / remove / sign-in). Spread into `useStore` (store.ts); the pure parts live in sideThreads.ts / mcp.ts.
 */
import type { StateCreator } from "zustand";
import type { EngineEvent, McpAddConfig, McpScope, McpToggleScope, SideAnchor } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { errorEventText, refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { EMPTY_MCP, type McpState } from "./mcp";
import {
  applyClosed,
  applyTextDelta,
  applyThread,
  applyThreadError,
  applyThreads,
  applyToolResult,
  applyToolUse,
  applyTurnEnd,
  EMPTY_SIDE,
  lastAnswer,
  PROMOTE_SUFFIX,
  promoteRecovery,
  sideNotification,
  type PromoteAs,
  type PromoteRecovery,
  type SideState,
} from "./sideThreads";
import type { Store } from "./store";

/** What the side panel shows: the thread list, one thread, or a new question about `anchor`. */
export type SideView =
  | { kind: "list" }
  | { kind: "thread"; threadId: string }
  | { kind: "new"; anchor: SideAnchor | null; question: string; context?: string; nonce: number };

/** The promote dialog: the drafted (then user-edited) text and where it goes. */
export type PromoteDraft = {
  threadId: string;
  as: PromoteAs;
  text: string;
  loading: boolean;
  sending: boolean;
  /** The refusal in words (draft or send); `recovery` = what the dialog can offer instead. */
  error: string | null;
  recovery: PromoteRecovery;
};

export type SideSlice = {
  side: SideState;
  sidePanelOpen: boolean;
  sideView: SideView;
  /** A `side_ask` that starts a new thread is waiting for its reply. */
  sideAsking: boolean;
  /** Why the last side command was refused (shown in the panel). */
  sideNotice: string | null;
  promoteDraft: PromoteDraft | null;
  /** Threads whose conclusion went to the composer queue instead (the gate was closed). */
  sideQueued: Record<string, true>;
  mcp: McpState;
  /** Why the last MCP command failed (shown in the extensions dialog). */
  mcpNotice: string | null;

  /** §21 events → `side`; true when the event was one of them. */
  applySideEvent(ev: EngineEvent): boolean;
  resetSide(): void;
  /** Opens the panel on a new question about `anchor` (prefilled `question`, `context` = what the anchor shows). */
  askAbout(anchor: SideAnchor | null, opts?: { question?: string; context?: string }): void;
  openSideThread(threadId: string): void;
  showSideList(): void;
  toggleSidePanel(open?: boolean): void;
  /** `side_ask` → null, or the refusal in words (also `sideNotice`). */
  sideAsk(question: string, opts?: { threadId?: string; anchor?: SideAnchor | null; /** §40.3 [최신 대화로 다시 묻기] */ refork?: boolean }): Promise<string | null>;
  sideCancel(threadId: string): void;
  sideClose(threadId: string): Promise<void>;
  sideList(): Promise<void>;
  startPromote(threadId: string, as: PromoteAs): Promise<void>;
  editPromote(patch: Partial<Pick<PromoteDraft, "text" | "as">>): void;
  submitPromote(): Promise<boolean>;
  /** The gate is closed (`gate_closed:running`): the text waits in the composer queue instead. */
  queuePromote(): void;
  cancelPromote(): void;

  mcpRefresh(): Promise<void>;
  mcpReconnect(name: string): Promise<void>;
  /** MARK: wave4d w4d-config — §42.3: `repository` keeps the choice for every workbench of the repository. */
  mcpToggle(name: string, enabled: boolean, scope?: McpToggleScope): Promise<void>;
  /** `mcp_add` → null, or the refusal in words. */
  mcpAdd(name: string, scope: McpScope, config: McpAddConfig): Promise<string | null>;
  /** §42.3 `file`: the origin file the user confirmed (a parent folder's .mcp.json). */
  mcpRemove(name: string, scope: McpScope, file?: string): Promise<string | null>;
  mcpAuth(name: string): Promise<void>;
  dismissMcpNotice(): void;
};

const LAST = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
let viewNonce = 1;

export const createSideSlice: StateCreator<Store, [], [], SideSlice> = (set, get) => {
  const setSide = (f: (s: SideState) => SideState) => set((st) => ({ side: f(st.side) }));
  const words = (e: unknown) => refusalMessage(refusalOf(e));
  const log = (line: string) => {
    const logs = [...get().logs, line];
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    set({ logs });
  };

  const mcpCommand = async (name: string | null, busy: McpState["busy"][string] | null, cmd: Parameters<typeof engineRequest>[0]): Promise<string | null> => {
    if (name && busy) set((s) => ({ mcp: { ...s.mcp, busy: { ...s.mcp.busy, [name]: busy } } }));
    try {
      const reply = await engineRequest(cmd);
      if (reply && typeof reply === "object" && "type" in reply && reply.type === "mcp_status") {
        set((s) => ({ mcp: { ...s.mcp, servers: reply.servers, restartRequired: reply.restartRequired, loaded: true, repositoryToggle: reply.repositoryToggle === true } }));
      }
      set({ mcpNotice: null });
      return null;
    } catch (e) {
      const r = refusalOf(e);
      log(`[warn] ${cmd.type}: ${r.error}`);
      const text = refusalMessage(r);
      set({ mcpNotice: text });
      return text;
    } finally {
      if (name && busy)
        set((s) => {
          const { [name]: _gone, ...rest } = s.mcp.busy;
          return { mcp: { ...s.mcp, busy: rest } };
        });
    }
  };

  return {
    side: EMPTY_SIDE,
    sidePanelOpen: false,
    sideView: { kind: "list" },
    sideAsking: false,
    sideNotice: null,
    promoteDraft: null,
    sideQueued: {},
    mcp: EMPTY_MCP,
    mcpNotice: null,

    applySideEvent(ev) {
      switch (ev.type) {
        case "side_thread":
          setSide((s) => applyThread(s, ev.thread));
          return true;
        case "side_threads":
          setSide((s) => applyThreads(s, ev.mainSessionId, ev.threads));
          // An open thread that is gone (another chat) falls back to the list.
          {
            const v = get().sideView;
            if (v.kind === "thread" && !get().side.threads[v.threadId]) set({ sideView: { kind: "list" } });
          }
          return true;
        case "side_text_delta":
          setSide((s) => applyTextDelta(s, ev.threadId, ev.text));
          return true;
        case "side_tool_use":
          setSide((s) => applyToolUse(s, ev.threadId, ev));
          return true;
        case "side_tool_result":
          setSide((s) => applyToolResult(s, ev.threadId, ev));
          return true;
        case "side_turn_end": {
          const before = get().side;
          const th = before.threads[ev.threadId];
          const answer = lastAnswer(th, before.live[ev.threadId]);
          setSide((s) => applyTurnEnd(s, ev.threadId));
          if (typeof document !== "undefined" && !document.hasFocus()) {
            const root = get().state.project?.root ?? null;
            const n = sideNotification(th, answer, ev.stopReason, { project: root ? LAST(root) : null });
            if (n) void window.rg.notify?.(n).catch(() => undefined);
          }
          return true;
        }
        case "side_thread_closed": {
          setSide((s) => applyClosed(s, ev.threadId));
          const v = get().sideView;
          if (v.kind === "thread" && v.threadId === ev.threadId) set({ sideView: { kind: "list" } });
          if (get().promoteDraft?.threadId === ev.threadId) set({ promoteDraft: null });
          return true;
        }
        case "side_promote_draft": {
          const d = get().promoteDraft;
          if (d && d.threadId === ev.threadId && d.loading) set({ promoteDraft: { ...d, text: ev.text, loading: false } });
          return true;
        }
        case "mcp_status":
          set((s) => ({ mcp: { ...s.mcp, servers: ev.servers, restartRequired: ev.restartRequired, loaded: true, repositoryToggle: ev.repositoryToggle === true } }));
          return true;
        case "error":
          if (ev.code === "side_failed" && ev.threadId) {
            setSide((s) => applyThreadError(s, ev.threadId!, errorEventText(ev)));
            return true;
          }
          return false;
        default:
          return false;
      }
    },

    resetSide() {
      set({ side: EMPTY_SIDE, sideView: { kind: "list" }, sideAsking: false, sideNotice: null, promoteDraft: null, sideQueued: {}, mcp: EMPTY_MCP, mcpNotice: null });
    },

    askAbout(anchor, opts = {}) {
      set({
        sidePanelOpen: true,
        sideNotice: null,
        sideView: { kind: "new", anchor, question: opts.question ?? "", ...(opts.context ? { context: opts.context } : {}), nonce: viewNonce++ },
      });
    },

    openSideThread(threadId) {
      set({ sidePanelOpen: true, sideNotice: null, sideView: { kind: "thread", threadId } });
    },

    showSideList() {
      set({ sideNotice: null, sideView: { kind: "list" } });
    },

    toggleSidePanel(open) {
      const next = open ?? !get().sidePanelOpen;
      set({ sidePanelOpen: next });
      if (next && get().state.project && get().side.mainSessionId === null && Object.keys(get().side.threads).length === 0) void get().sideList();
    },

    async sideAsk(question, opts = {}) {
      const q = question.trim();
      if (!q) return t("Type a question first.");
      const isNew = !opts.threadId;
      if (isNew) set({ sideAsking: true });
      set({ sideNotice: null });
      try {
        const reply = await engineRequest({
          type: "side_ask",
          question: q,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
          ...(isNew && opts.anchor ? { anchor: opts.anchor } : {}),
          ...(opts.threadId && opts.refork ? { refork: true } : {}), // MARK: wave4b w4b-side — §40.3
        });
        setSide((s) => applyThread(s, reply.thread));
        if (isNew) set({ sideView: { kind: "thread", threadId: reply.thread.id } });
        return null;
      } catch (e) {
        const text = words(e);
        log(`[warn] side_ask: ${refusalOf(e).error}`);
        set({ sideNotice: text });
        return text;
      } finally {
        if (isNew) set({ sideAsking: false });
      }
    },

    sideCancel(threadId) {
      void engineRequest({ type: "side_cancel", threadId }).catch((e: unknown) => {
        log(`[warn] side_cancel: ${refusalOf(e).error}`);
        set({ sideNotice: words(e) });
      });
    },

    async sideClose(threadId) {
      try {
        await engineRequest({ type: "side_close", threadId });
        setSide((s) => applyClosed(s, threadId));
        const v = get().sideView;
        if (v.kind === "thread" && v.threadId === threadId) set({ sideView: { kind: "list" } });
      } catch (e) {
        log(`[warn] side_close: ${refusalOf(e).error}`);
        set({ sideNotice: words(e) });
      }
    },

    async sideList() {
      if (!get().state.project) return;
      try {
        const reply = await engineRequest({ type: "side_list" });
        setSide((s) => applyThreads(s, reply.mainSessionId, reply.threads));
      } catch (e) {
        // An engine without §21 (or no session yet): the panel simply stays empty.
        log(`[info] side_list: ${refusalOf(e).error}`);
      }
    },

    async startPromote(threadId, as) {
      set({ promoteDraft: { threadId, as, text: "", loading: true, sending: false, error: null, recovery: null } });
      try {
        const reply = await engineRequest({ type: "side_promote_draft", threadId });
        const d = get().promoteDraft;
        if (d && d.threadId === threadId) set({ promoteDraft: { ...d, text: d.loading ? reply.text : d.text, loading: false } });
      } catch (e) {
        const d = get().promoteDraft;
        log(`[warn] side_promote_draft: ${refusalOf(e).error}`);
        // The draft failed: the user can still write the text by hand.
        if (d && d.threadId === threadId) set({ promoteDraft: { ...d, loading: false, error: words(e) } });
      }
    },

    editPromote(patch) {
      const d = get().promoteDraft;
      if (!d) return;
      set({ promoteDraft: { ...d, ...patch, ...(patch.as && patch.as !== d.as ? { error: null, recovery: null } : {}), ...(patch.text !== undefined ? { loading: false } : {}) } });
    },

    async submitPromote() {
      const d = get().promoteDraft;
      if (!d || d.sending || d.loading) return false;
      const text = d.text.trim();
      if (!text) {
        set({ promoteDraft: { ...d, error: t("Write what should be sent first.") } });
        return false;
      }
      set({ promoteDraft: { ...d, sending: true, error: null, recovery: null } });
      try {
        await engineRequest({ type: "side_promote", threadId: d.threadId, as: d.as, text });
        set((s) => {
          const { [d.threadId]: _q, ...sideQueued } = s.sideQueued;
          return { promoteDraft: null, sideQueued };
        });
        return true;
      } catch (e) {
        const r = refusalOf(e);
        log(`[warn] side_promote: ${r.error}`);
        const text2 =
          d.as === "note" && r.code === "session_running"
            ? t("Notes can be added once Claude has finished this turn.")
            : d.as === "message" && r.code === "gate_closed"
              ? r.detail === "running"
                ? t("Claude is still working on the main conversation.")
                : refusalMessage(r)
              : refusalMessage(r);
        const cur = get().promoteDraft;
        if (cur && cur.threadId === d.threadId) set({ promoteDraft: { ...cur, sending: false, error: text2, recovery: promoteRecovery(d.as, r.code) } });
        return false;
      }
    },

    queuePromote() {
      const d = get().promoteDraft;
      if (!d || !d.text.trim()) return;
      get().enqueueMessage(d.text.trim() + PROMOTE_SUFFIX);
      set((s) => ({ promoteDraft: null, sideQueued: { ...s.sideQueued, [d.threadId]: true } }));
      // MARK: wave4b w4b-side — §40.3: the engine keeps the record ("대기열에 넣음"), so it outlives a chat switch.
      void engineRequest({ type: "side_promote", threadId: d.threadId, as: "message", text: d.text.trim(), queued: true }).catch((e: unknown) => log(`[info] side_promote queued: ${refusalOf(e).error}`));
    },

    cancelPromote() {
      set({ promoteDraft: null });
    },

    // ------------------------------------------------------------ MCP (§22)

    async mcpRefresh() {
      if (!get().state.project) return;
      await mcpCommand(null, null, { type: "mcp_status" });
    },
    async mcpReconnect(name) {
      await mcpCommand(name, "reconnect", { type: "mcp_reconnect", name });
    },
    async mcpToggle(name, enabled, scope) {
      await mcpCommand(name, "toggle", { type: "mcp_toggle", name, enabled, ...(scope === "repository" ? { scope } : {}) });
    },
    mcpAdd(name, scope, config) {
      return mcpCommand(null, null, { type: "mcp_add", name, scope, config });
    },
    mcpRemove(name, scope, file) {
      return mcpCommand(name, "remove", { type: "mcp_remove", name, scope, ...(file ? { file } : {}) });
    },
    async mcpAuth(name) {
      await mcpCommand(name, "auth", { type: "mcp_auth", name });
    },
    dismissMcpNotice() {
      set({ mcpNotice: null });
    },
  };
};
