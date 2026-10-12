import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, PermissionRequest, ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";
import { permissionCardStatus, pendingPermissionsOf, shortcutTargetId } from "./permissionQueue";
import { useToast } from "./toast";

// ---------------------------------------------------------------- engine bridge mocked (as in composer.test.ts)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
type Call = EngineCommand | { type: "__setSettings"; patch: Partial<AppSettings> };
const calls: Call[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });
let settings: Partial<AppSettings> = {};

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => calls.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        calls.push(c);
        return respond(c);
      },
      setSettings: async (patch: Partial<AppSettings>) => {
        calls.push({ type: "__setSettings", patch });
        settings = { ...settings, ...patch };
        return settings;
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: `make ${requestId}` }, ...extra });
const responses = () => calls.filter((c): c is Extract<EngineCommand, { type: "permission_response" }> => c.type === "permission_response");

type UseStore = Awaited<ReturnType<typeof loadStore>>;

describe("§33.1 permission queue in the store (M1)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    calls.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    settings = { bashAllowPatterns: "", projectBashAllowPatterns: {} };
  });

  /** A fresh project view with an open session and the given open requests (oldest first) in the snapshot. */
  const open = (useStore: UseStore, pending: PermissionRequest[] = [], extra: Partial<ReviewState["session"]> = {}) => {
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      errorBanner: null,
      lastError: null,
      settings: settings as AppSettings,
      state: {
        ...s,
        seq: 0,
        project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
        session: { ...s.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending, ...extra },
        gate: { ...s.gate, phase: "running", canSend: false },
      } as ReviewState,
      queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
    });
  };
  /** Engine snapshot with `pending` as the queue (a newer seq each time). */
  const snapshot = (useStore: UseStore, pending: PermissionRequest[] | undefined, single: PermissionRequest | null = pending?.[0] ?? null) => {
    const s = useStore.getState().state;
    const session = { ...s.session, pendingPermission: single } as ReviewState["session"];
    if (pending) session.pendingPermissions = pending;
    else delete session.pendingPermissions;
    useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, session } });
  };
  const rowOf = (useStore: UseStore, requestId: string) => {
    const row = useStore.getState().transcript.find((i) => i.kind === "permission" && i.request.requestId === requestId);
    return row && row.kind === "permission" ? row : undefined;
  };
  const statusOf = (useStore: UseStore, requestId: string) => {
    const row = rowOf(useStore, requestId);
    const pending = pendingPermissionsOf(useStore.getState().state).some((p) => p.requestId === requestId);
    return row ? permissionCardStatus(row.allowed, pending) : "none";
  };

  it("two requests at once: each gets a card, the slot is never replaced by the newer one", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("a", { agent: { agentId: "t1", agentToolUseId: "tu1" } }) });
    useStore.getState().handleEvent({ type: "permission_request", ...req("b", { agent: { agentId: "t2", agentToolUseId: "tu2" } }) });
    const st = useStore.getState().state;
    expect(pendingPermissionsOf(st).map((p) => p.requestId)).toEqual(["a", "b"]);
    expect(st.session.pendingPermission?.requestId).toBe("a");
    expect(useStore.getState().transcript.filter((i) => i.kind === "permission")).toHaveLength(2);
    snapshot(useStore, [req("a"), req("b")]);
    expect(useStore.getState().transcript.filter((i) => i.kind === "permission")).toHaveLength(2);
  });

  it("test 1: answering the newer card first answers only it; the older one stays answerable", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("a") });
    useStore.getState().handleEvent({ type: "permission_request", ...req("b") });
    useStore.getState().respondPermission("b", true);
    expect(responses()).toEqual([{ type: "permission_response", requestId: "b", allow: true }]);
    expect(statusOf(useStore, "b")).toBe("decided");
    expect(statusOf(useStore, "a")).toBe("active");
    await flush();
    // a snapshot computed before the engine saw the answer must not bring the decided card back
    snapshot(useStore, [req("a"), req("b")]);
    expect(statusOf(useStore, "b")).toBe("decided");
    useStore.getState().respondPermission("a", false, "Denied by user");
    expect(responses().at(-1)).toEqual({ type: "permission_response", requestId: "a", allow: false, message: "Denied by user" });
  });

  it("test 2: the shortcut target is the request that has waited longest", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("old") });
    useStore.getState().handleEvent({ type: "permission_request", ...req("new") });
    expect(shortcutTargetId(useStore.getState().state)).toBe("old");
    useStore.getState().respondPermission("old", true);
    expect(shortcutTargetId(useStore.getState().state)).toBe("new");
  });

  it("test 3: an interrupt (the queue emptied) turns every open card into 'handled'", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("a") });
    useStore.getState().handleEvent({ type: "permission_request", ...req("b") });
    snapshot(useStore, []);
    expect(statusOf(useStore, "a")).toBe("handled");
    expect(statusOf(useStore, "b")).toBe("handled");
    expect(shortcutTargetId(useStore.getState().state)).toBeNull();
  });

  it("unknown_permission_request: a toast, the card goes to 'handled', no error banner, the queue keeps going", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.setState((s) => ({ queue: { ...s.queue, items: [{ id: 1, text: "next" }] } }));
    useStore.getState().handleEvent({ type: "permission_request", ...req("a") });
    respond = () => ({ ok: false, error: "unknown_permission_request", code: "unknown_permission_request" });
    useStore.getState().respondPermission("a", true);
    await flush();
    await flush();
    // The window's one toast (toast.ts) — the same one the other short notices use, not a second permission toast.
    expect(useToast.getState().text).toBe("이미 처리된 권한 요청입니다");
    expect(statusOf(useStore, "a")).toBe("handled");
    expect(useStore.getState().errorBanner).toBeNull();
    expect(useStore.getState().queue.paused).toBeNull();
    useToast.getState().hide();
    expect(useToast.getState().text).toBeNull();
  });

  it("a reason card or SendMessage never sends remember (no session allow behind the user's back)", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("r", { reason: { code: "nested_repository", message: "m", path: "/repo/.claude/worktrees/x" } }) });
    useStore.getState().handleEvent({ type: "permission_request", requestId: "s", toolName: "SendMessage", input: { to: "docs", message: "hi", summary: "s" } });
    useStore.getState().handleEvent({ type: "permission_request", ...req("p") });
    useStore.getState().respondPermission("r", true, undefined, undefined, true);
    useStore.getState().respondPermission("s", true, undefined, undefined, true);
    useStore.getState().respondPermission("p", true, undefined, undefined, true);
    expect(responses()).toEqual([
      { type: "permission_response", requestId: "r", allow: true },
      { type: "permission_response", requestId: "s", allow: true },
      { type: "permission_response", requestId: "p", allow: true, remember: true },
    ]);
  });

  it("test 5: 'always allow' saves the pattern for this project first, then answers that card", async () => {
    const useStore = await loadStore();
    open(useStore);
    const mcp = { requestId: "m", toolName: "mcp__github__get_issue", input: { id: 1 }, allowPatterns: ["mcp__github__get_issue", "mcp__github__*"] };
    useStore.getState().handleEvent({ type: "permission_request", ...mcp });
    await useStore.getState().allowAlwaysInProject("m", "mcp__github__*");
    await flush();
    const order = calls.map((c) => c.type);
    expect(order.indexOf("__setSettings")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("__setSettings")).toBeLessThan(order.indexOf("permission_response"));
    const saved = calls.find((c): c is { type: "__setSettings"; patch: Partial<AppSettings> } => c.type === "__setSettings")!;
    expect(Object.values(saved.patch.projectBashAllowPatterns ?? {})).toEqual(["mcp__github__*"]);
    expect(responses()).toEqual([{ type: "permission_response", requestId: "m", allow: true }]);
    expect(statusOf(useStore, "m")).toBe("decided");
  });

  it("'always allow' refuses a pattern for a reason card (nothing saved, nothing answered)", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("r", { reason: { code: "other_worktree", message: "m" } }) });
    await useStore.getState().allowAlwaysInProject("r", "Bash(make:*)");
    expect(calls).toEqual([]);
    expect(statusOf(useStore, "r")).toBe("active");
  });

  it("test 31: a path that only looks at pendingPermission answers the queue FIFO to the end", async () => {
    const useStore = await loadStore();
    open(useStore);
    for (const id of ["a", "b", "c"]) useStore.getState().handleEvent({ type: "permission_request", ...req(id) });
    for (let guard = 0; guard < 10 && useStore.getState().state.session.pendingPermission; guard++) {
      useStore.getState().respondPermission(useStore.getState().state.session.pendingPermission!.requestId, true);
    }
    expect(responses().map((r) => r.requestId)).toEqual(["a", "b", "c"]);
    expect(useStore.getState().state.session.pendingPermission).toBeNull();
  });

  it("an engine without the queue (only pendingPermission) still shows and answers its card", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("solo") });
    snapshot(useStore, undefined, req("solo"));
    expect(statusOf(useStore, "solo")).toBe("active");
    useStore.getState().respondPermission("solo", true);
    expect(responses()).toEqual([{ type: "permission_response", requestId: "solo", allow: true }]);
  });

  it("an open request whose event this view missed (reload) gets its card from the snapshot, once", async () => {
    const useStore = await loadStore();
    open(useStore);
    snapshot(useStore, [req("x")]);
    expect(statusOf(useStore, "x")).toBe("active");
    useStore.getState().handleEvent({ type: "permission_request", ...req("x") });
    expect(useStore.getState().transcript.filter((i) => i.kind === "permission")).toHaveLength(1);
  });

  it("answers a queued AskUserQuestion that is not the oldest request", async () => {
    const useStore = await loadStore();
    open(useStore);
    useStore.getState().handleEvent({ type: "permission_request", ...req("a") });
    const questions = [{ question: "Color?", header: "c", multiSelect: false, options: [] }];
    useStore.getState().handleEvent({ type: "permission_request", requestId: "q", toolName: "AskUserQuestion", input: { questions } });
    useStore.getState().answerQuestions("q", { "Color?": "green" });
    expect(responses()).toEqual([{ type: "permission_response", requestId: "q", allow: true, updatedInput: { questions, answers: { "Color?": "green" } } }]);
    expect(rowOf(useStore, "q")).toMatchObject({ allowed: true, answers: { "Color?": "green" } });
    expect(statusOf(useStore, "a")).toBe("active");
  });

  it("imports terminal rules into this project's allow patterns (test 6, client part)", async () => {
    const useStore = await loadStore();
    open(useStore);
    expect(await useStore.getState().importAllowPatterns(["mcp__github__*", "WebFetch(domain:docs.spring.io)"], "project")).toBe(2);
    const saved = calls.find((c): c is { type: "__setSettings"; patch: Partial<AppSettings> } => c.type === "__setSettings")!;
    expect(Object.values(saved.patch.projectBashAllowPatterns ?? {})).toEqual(["mcp__github__*\nWebFetch(domain:docs.spring.io)"]);
    expect(await useStore.getState().importAllowPatterns(["mcp__github__*"], "project")).toBe(0);
    expect(await useStore.getState().importAllowPatterns(["WebSearch"], "global")).toBe(1);
    expect(useStore.getState().settings?.bashAllowPatterns).toBe("WebSearch");
  });

  it("asks permission_rules on the query lane and words a refusal", async () => {
    const useStore = await loadStore();
    open(useStore);
    const reply = { type: "permission_rules", sources: [], rules: [], defaultMode: "acceptEdits", defaultModeSupported: true, applyUserAllowRules: true, loadUserSettings: true };
    respond = (c) => (c.type === "permission_rules" ? { ok: true, reply } : { ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().fetchPermissionRules()).toEqual({ ok: true, rules: reply });
    respond = () => ({ ok: false, error: "no_project", code: "no_project" });
    const refused = await useStore.getState().fetchPermissionRules();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/[가-힣]/);
  });
});
