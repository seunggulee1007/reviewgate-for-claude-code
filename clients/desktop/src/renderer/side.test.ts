import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, McpServerInfo, SideThread } from "@reviewgate/engine";
import { initI18n, t } from "./i18n";
import { configLine, EMPTY_FORM, mcpAttention, removableScope, sortServers, splitArgs, validateForm } from "./mcp";
import {
  anchorLabel,
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
  lastPromotion,
  promoteRecovery,
  promoteTarget,
  promoteUnsavedLine,
  sameAnchor,
  sideNotification,
  sortedThreads,
  threadsOnFile,
  threadsOnHunk,
  toolUseIdForPermission,
  totalCost,
} from "./sideThreads";

const at = (n: number) => new Date(Date.UTC(2026, 9, 21, 1, 0, n)).toISOString();
function thread(p: Partial<SideThread> & { id: string }): SideThread {
  return {
    mainSessionId: "chat-1",
    anchor: null,
    createdAt: at(0),
    updatedAt: at(0),
    title: "왜 이렇게 바꿨어?",
    messages: [],
    status: "idle",
    error: null,
    sessionId: null,
    fork: null,
    costUSD: 0,
    ...p,
  };
}

describe("side thread reducers (§21)", () => {
  it("streams an answer, then the final snapshot replaces the partial one", () => {
    const q = { role: "user" as const, text: "왜?", at: at(1) };
    let s = applyThread(EMPTY_SIDE, thread({ id: "t1", status: "running", messages: [q] }));
    expect(s.live["t1"]).toEqual({ text: "", toolCalls: [] });
    s = applyTextDelta(s, "t1", "검증을 ");
    s = applyToolUse(s, "t1", { id: "u1", name: "Read", input: { file_path: "/p/a.ts" } });
    s = applyToolUse(s, "t1", { id: "u1", name: "Read", input: {} }); // duplicate ignored
    s = applyToolResult(s, "t1", { toolUseId: "u1", isError: false, preview: "line 1" });
    s = applyTextDelta(s, "t1", "앞당겼습니다.");
    expect(s.live["t1"]!.text).toBe("검증을 앞당겼습니다.");
    expect(s.live["t1"]!.toolCalls).toEqual([{ id: "u1", name: "Read", input: { file_path: "/p/a.ts" }, isError: false, preview: "line 1" }]);
    expect(lastAnswer(s.threads["t1"], s.live["t1"])).toBe("검증을 앞당겼습니다.");
    s = applyTurnEnd(s, "t1");
    expect(s.threads["t1"]!.status).toBe("idle");
    s = applyThread(s, thread({ id: "t1", status: "idle", costUSD: 0.03, messages: [q, { role: "assistant", text: "검증을 앞당겼습니다.", at: at(2), costUSD: 0.03 }] }));
    expect(s.live["t1"]).toBeUndefined();
    expect(totalCost(s)).toBeCloseTo(0.03);
    expect(lastAnswer(s.threads["t1"])).toBe("검증을 앞당겼습니다.");
  });

  it("keeps deltas that arrived before the running snapshot, marks failures, closes threads", () => {
    let s = applyTextDelta(EMPTY_SIDE, "t2", "early");
    s = applyThread(s, thread({ id: "t2", status: "running" }));
    expect(s.live["t2"]!.text).toBe("early");
    s = applyThreadError(s, "t2", "CLI crashed");
    expect(s.threads["t2"]).toMatchObject({ status: "error", error: "CLI crashed" });
    s = applyClosed(s, "t2");
    expect(s.threads["t2"]).toBeUndefined();
    expect(s.live["t2"]).toBeUndefined();
    expect(applyClosed(s, "nope")).toBe(s);
  });

  it("side_threads replaces the chat's list (newest first) and drops another chat's partial answers", () => {
    let s = applyThread(EMPTY_SIDE, thread({ id: "old", status: "running" }));
    s = applyTextDelta(s, "old", "x");
    s = applyThreads(s, "chat-2", [thread({ id: "a", updatedAt: at(5) }), thread({ id: "b", updatedAt: at(9), status: "running" })]);
    expect(s.mainSessionId).toBe("chat-2");
    expect(Object.keys(s.threads).sort()).toEqual(["a", "b"]);
    expect(s.live).toEqual({});
    expect(sortedThreads(s).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("anchors", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("labels and matches anchors", () => {
    expect(anchorLabel(null)).toBeNull();
    expect(anchorLabel({ path: "src/a/auth.ts", line: 42, side: "new" })).toBe("auth.ts:42");
    expect(anchorLabel({ path: "src/a/auth.ts", line: 7, side: "old" })).toBe("auth.ts:−7");
    expect(anchorLabel({ path: "src/a/auth.ts", hunkId: 1 })).toBe("auth.ts · 2번째 부분");
    expect(anchorLabel({ toolUseId: "toolu_1" })).toBe("도구 호출");
    expect(anchorLabel({ path: "x.ts", entryId: "e1" })).toBe("x.ts · 기록");
    expect(sameAnchor({ path: "a", line: 3 }, { path: "a", line: 3, side: "new" })).toBe(true);
    expect(sameAnchor({ path: "a", line: 3 }, { path: "a", line: 3, side: "old" })).toBe(false);
    expect(sameAnchor({ path: "a" }, { path: "a", entryId: "e" })).toBe(false);
  });

  it("counts threads per file and per hunk (hunk id or a line inside it)", () => {
    const list = [
      thread({ id: "1", anchor: { path: "a.ts", hunkId: 0 } }),
      thread({ id: "2", anchor: { path: "a.ts", line: 12, side: "new" } }),
      thread({ id: "3", anchor: { path: "a.ts", line: 99, side: "new" } }),
      thread({ id: "4", anchor: { path: "b.ts" } }),
      thread({ id: "5", anchor: { path: "a.ts", entryId: "e1", hunkId: 0 } }),
    ];
    expect(threadsOnFile(list, "a.ts").map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(threadsOnFile(list, "a.ts", "e1").map((t) => t.id)).toEqual(["5"]);
    const hunk0 = { id: 0, lines: [{ oldNo: 10, newNo: 10 }, { oldNo: null, newNo: 12 }] };
    expect(threadsOnHunk(list, "a.ts", hunk0).map((t) => t.id)).toEqual(["1", "2"]);
    expect(threadsOnHunk(list, "a.ts", hunk0, "e1").map((t) => t.id)).toEqual(["5"]);
  });

  it("finds the tool row behind a permission card", () => {
    const items = [
      { kind: "toolUse", toolUseId: "u1", name: "Bash", input: { command: "npm test" } },
      { kind: "toolUse", toolUseId: "u2", name: "Bash", input: { command: "rm -rf dist" } },
      { kind: "permission", request: { requestId: "r1" } },
      { kind: "toolUse", toolUseId: "u3", name: "Bash", input: { command: "rm -rf dist" } },
    ];
    expect(toolUseIdForPermission(items, { requestId: "r1", toolName: "Bash", input: { command: "rm -rf dist" } })).toBe("u2");
    expect(toolUseIdForPermission(items, { requestId: "r1", toolName: "Bash", input: { command: "ls" } })).toBeNull();
    const edits = [{ kind: "toolUse", toolUseId: "e1", name: "Write", input: {}, file: "/p/a.ts" }];
    expect(toolUseIdForPermission(edits, { requestId: "x", toolName: "Write", input: {}, file: "/p/a.ts" })).toBe("e1");
    expect(toolUseIdForPermission(edits, { requestId: "x", toolName: "Write", input: {}, file: "/p/b.ts" })).toBeNull();
  });

  it("promote targets, refusal recovery and the background notification", () => {
    expect(promoteTarget("note", { path: "src/a.ts", line: 4, side: "new" })).toContain("src/a.ts:+4");
    expect(promoteTarget("message", null)).toMatch(/메인 대화/);
    expect(promoteRecovery("message", "gate_closed")).toBe("queue");
    expect(promoteRecovery("note", "gate_closed")).toBeNull();
    expect(promoteRecovery("message", "send_failed")).toBeNull();
    const th = thread({ id: "t", title: "왜 캐시를 지웠어?", messages: [{ role: "user", text: "q", at: at(1) }], promotions: [{ as: "message", at: at(3) }] });
    expect(lastPromotion(th)).toEqual({ as: "message", at: at(3) });
    const n = sideNotification(th, "## 요약\n캐시가 오래돼서 지웠습니다", "end_turn", { project: "repo" })!;
    expect(n).toMatchObject({ kind: "side_answer", title: "ReviewGate — repo" });
    expect(n.body).toContain("왜 캐시를 지웠어?");
    expect(n.body).toContain("캐시가 오래돼서");
    expect(sideNotification(th, "x", "interrupted", { project: null })).toBeNull();
  });

  it("the close / quit confirmation names the promote dialog's unsent text, once it has some (P3-transcript-29)", () => {
    const line = t("A side question's instruction or note is not sent yet. Closing discards it.");
    expect(promoteUnsavedLine({ text: "a.ts:3 의 검증을 되돌려 주세요.", loading: false })).toBe(line);
    expect(promoteUnsavedLine({ text: "", loading: true })).toBeNull(); // still being drafted: nothing written yet
    expect(promoteUnsavedLine({ text: "  \n", loading: false })).toBeNull();
    expect(promoteUnsavedLine(null)).toBeNull();
  });
});

describe("MCP helpers (§22)", () => {
  it("splits arguments with quotes and escapes", () => {
    expect(splitArgs(`-y @x/server --root "a b" 'c d' e\\ f ""`)).toEqual(["-y", "@x/server", "--root", "a b", "c d", "e f", ""]);
    expect(splitArgs("   ")).toEqual([]);
  });

  it("validates the add form like the engine", () => {
    expect(validateForm({ ...EMPTY_FORM, name: "" }).ok).toBe(false);
    const bad = validateForm({ ...EMPTY_FORM, name: "-x", command: "--flag", env: [{ key: "1BAD", value: "v" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["command", "env", "name"]);
    expect(validateForm({ ...EMPTY_FORM, name: "gh", command: "npx" }, ["gh"]).ok).toBe(false);
    const ok = validateForm({ ...EMPTY_FORM, name: "github", scope: "project", command: "npx", args: "-y @mcp/github", env: [{ key: "GITHUB_TOKEN", value: "s3cret" }, { key: "", value: "" }] });
    expect(ok).toEqual({ ok: true, name: "github", scope: "project", config: { type: "stdio", command: "npx", args: ["-y", "@mcp/github"], env: { GITHUB_TOKEN: "s3cret" } } });
    const http = validateForm({ ...EMPTY_FORM, name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: [{ key: "Authorization", value: "Bearer x" }] });
    expect(http).toEqual({ ok: true, name: "remote", scope: "session", config: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } } });
    expect(validateForm({ ...EMPTY_FORM, name: "r", type: "sse", url: "file:///etc/passwd" }).ok).toBe(false);
    expect(validateForm({ ...EMPTY_FORM, name: "r", type: "http", url: "https://x", headers: [{ key: "Bad Header", value: "v" }] }).ok).toBe(false);
    expect(validateForm({ ...EMPTY_FORM, name: "r", command: "node", env: [{ key: "K", value: "a\nb" }] }).ok).toBe(false);
  });

  const server = (p: Partial<McpServerInfo>): McpServerInfo => ({
    name: "s",
    status: "connected",
    scope: null,
    source: "user",
    transport: "stdio",
    toolCount: 0,
    tools: [],
    error: null,
    serverInfo: null,
    config: null,
    disabledByUser: false,
    sessionAdded: false,
    ...p,
  });

  it("attention, removal scope, order and the redacted config line", () => {
    expect(mcpAttention([server({}), server({ status: "needs-auth" })])).toBe("orange");
    expect(mcpAttention([server({ status: "needs-auth" }), server({ status: "failed" })])).toBe("red");
    expect(mcpAttention([server({}), server({ status: "disabled" })])).toBeNull();
    expect(removableScope(server({ source: "project" }))).toBe("project");
    expect(removableScope(server({ source: "session", sessionAdded: true }))).toBe("session");
    expect(removableScope(server({ source: "plugin" }))).toBeNull();
    expect(removableScope(server({ source: "claude.ai" }))).toBeNull();
    expect(sortServers([server({ name: "b" }), server({ name: "a", status: "failed" }), server({ name: "c", status: "disabled" })]).map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(configLine(server({ config: { command: "npx", args: ["-y", "--token", "***"], envKeys: ["K"] } }))).toBe("npx -y --token ***");
    expect(configLine(server({ config: { url: "https://x/mcp" } }))).toBe("https://x/mcp");
  });
});

// ---------------------------------------------------------------- store flows (engine bridge mocked)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });
const notify = vi.fn(async () => true);

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      notify,
      matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

describe("side + MCP store flows", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("asks a question about an anchor and opens the new thread", async () => {
    const useStore = await loadStore();
    useStore.setState({ state: { ...useStore.getState().state, project: { path: "/p", root: "/p", name: "p" } as never } });
    useStore.getState().askAbout({ path: "a.ts", line: 3, side: "new" }, { context: "const x = 1" });
    expect(useStore.getState().sidePanelOpen).toBe(true);
    expect(useStore.getState().sideView).toMatchObject({ kind: "new", anchor: { path: "a.ts", line: 3 }, context: "const x = 1" });
    const th = thread({ id: "t9", status: "running", anchor: { path: "a.ts", line: 3, side: "new" }, messages: [{ role: "user", text: "왜?", at: at(1) }] });
    respond = (c) => (c.type === "side_ask" ? { ok: true, reply: { type: "side_thread", thread: th } } : { ok: true, reply: {} });
    expect(await useStore.getState().sideAsk("왜?", { anchor: { path: "a.ts", line: 3, side: "new" } })).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "side_ask", question: "왜?", anchor: { path: "a.ts", line: 3, side: "new" } });
    expect(useStore.getState().sideView).toEqual({ kind: "thread", threadId: "t9" });
    useStore.getState().handleEvent({ type: "side_text_delta", threadId: "t9", text: "이유는" });
    expect(useStore.getState().side.live["t9"]!.text).toBe("이유는");

    respond = () => ({ ok: false, error: "side_limit", code: "side_limit" });
    const refusal = await useStore.getState().sideAsk("또?", {});
    expect(refusal).toMatch(/세 개/);
    expect(useStore.getState().sideNotice).toBe(refusal);
  });

  it("MARK: r2-skills-side (M18): a skill asked here is refused side_command and offered to the main conversation as typed", async () => {
    const useStore = await loadStore();
    const gate = (g: Partial<ReturnType<typeof useStore.getState>["state"]["gate"]>) =>
      useStore.setState({ state: { ...useStore.getState().state, gate: { ...useStore.getState().state.gate, ...g } } });
    useStore.setState({ state: { ...useStore.getState().state, project: { path: "/p", root: "/p", name: "p" } as never } });
    respond = (c) => (c.type === "side_ask" ? { ok: false, error: "side_command:acme-verify", code: "side_command" } : { ok: true, reply: { type: "result", ok: true } });
    const refusal = await useStore.getState().sideAsk("/acme-verify --fast", {});
    expect(refusal).toContain("/acme-verify");
    expect(useStore.getState().sideMainOnlyFor("")).toEqual({ text: "/acme-verify --fast", name: "acme-verify" });
    gate({ phase: "idle", canSend: true });
    expect(useStore.getState().sendSideToMain("")).toBe("sent");
    expect(sent.at(-1)).toMatchObject({ type: "send", text: "/acme-verify --fast" });
    expect(useStore.getState().sideMainOnlyFor("")).toBeNull();
    expect(useStore.getState().sideNotice).toBeNull();
    // A closed gate with no turn running (a session that is starting) holds it too: "queued", never "sent".
    await useStore.getState().sideAsk("/acme-verify", {});
    useStore.setState({ queue: { ...useStore.getState().queue, items: [], inflight: false, awaitingTurn: false } });
    gate({ phase: "idle", canSend: false });
    expect(useStore.getState().sendSideToMain("")).toBe("queued");
    expect(useStore.getState().queue.items.map((m) => m.text)).toEqual(["/acme-verify"]);
    // An answer whose Skill call the side policy denied: the thread's question goes as typed (queued behind a running turn).
    useStore.getState().handleEvent({
      type: "side_thread",
      thread: thread({ id: "s1", messages: [{ role: "user", text: "PR 12 리뷰해 줘", at: at(1) }, { role: "assistant", text: "메인 대화에서 실행돼요.", at: at(2), toolCalls: [{ id: "k1", name: "Skill", input: { skill: "acme-plugin:release-notes" }, isError: true, denied: true }] }] }),
    });
    useStore.setState({ state: { ...useStore.getState().state, gate: { ...useStore.getState().state.gate, phase: "running" } } });
    expect(useStore.getState().sendSideToMain("s1")).toBe("queued");
    expect(useStore.getState().queue.items.at(-1)!.text).toBe("PR 12 리뷰해 줘");
  });

  it("MARK: r2-skills-side (P3-transcript-28): typed questions are kept per anchor / thread and per chat", async () => {
    const useStore = await loadStore();
    useStore.getState().handleEvent({ type: "side_threads", mainSessionId: "chat-7", threads: [] });
    useStore.getState().setSideComposeDraft("src/a.ts|12", "왜 이 락이?");
    useStore.getState().setSideFollowUpDraft("t1", "그럼 타임아웃은?");
    expect(useStore.getState().sideDrafts).toEqual({ chatId: "chat-7", compose: { "src/a.ts|12": "왜 이 락이?" }, followUps: { t1: "그럼 타임아웃은?" } });
    useStore.getState().handleEvent({ type: "side_threads", mainSessionId: "chat-8", threads: [] });
    expect(useStore.getState().sideDrafts).toEqual({ chatId: "chat-8", compose: {}, followUps: {} });
  });

  it("side_failed stays in its thread; mcp_auth_required raises a banner with the server", async () => {
    const useStore = await loadStore();
    useStore.getState().handleEvent({ type: "side_thread", thread: thread({ id: "f1", status: "running" }) });
    useStore.setState({ errorBanner: null });
    useStore.getState().handleEvent({ type: "error", message: "Side question failed: boom", fatal: false, scope: "session", code: "side_failed", threadId: "f1" });
    expect(useStore.getState().errorBanner).toBeNull();
    expect(useStore.getState().side.threads["f1"]!.status).toBe("error");
    useStore.getState().handleEvent({ type: "error", message: "needs auth", fatal: false, scope: "session", code: "mcp_auth_required", server: "linear" });
    expect(useStore.getState().errorBanner).toMatchObject({ code: "mcp_auth_required", server: "linear" });
    expect(useStore.getState().errorBanner!.message).toContain("linear");
  });

  it("promote: draft → edit → refused while the main turn runs → queued with the suffix", async () => {
    const useStore = await loadStore();
    useStore.getState().handleEvent({ type: "side_thread", thread: thread({ id: "p1", anchor: { path: "a.ts" }, messages: [{ role: "assistant", text: "a", at: at(1) }] }) });
    respond = (c) => (c.type === "side_promote_draft" ? { ok: true, reply: { type: "side_promote_draft", threadId: "p1", text: "a.ts:3 의 검증을 되돌려 주세요." } } : { ok: false, error: "gate_closed:running", code: "gate_closed" });
    await useStore.getState().startPromote("p1", "message");
    expect(useStore.getState().promoteDraft).toMatchObject({ threadId: "p1", as: "message", text: "a.ts:3 의 검증을 되돌려 주세요.", loading: false });
    useStore.getState().editPromote({ text: "검증을 되돌려 주세요." });
    expect(await useStore.getState().submitPromote()).toBe(false);
    expect(sent.at(-1)).toEqual({ type: "side_promote", threadId: "p1", as: "message", text: "검증을 되돌려 주세요." });
    expect(useStore.getState().promoteDraft).toMatchObject({ recovery: "queue", sending: false });
    expect(useStore.getState().promoteDraft!.error).toMatch(/작업 중/);
    useStore.setState({ state: { ...useStore.getState().state, project: { path: "/p", root: "/p", name: "p" } as never } });
    useStore.getState().queuePromote();
    expect(useStore.getState().promoteDraft).toBeNull();
    expect(useStore.getState().queue.items.at(-1)!.text).toBe("검증을 되돌려 주세요.\n\n(곁질문에서 정리됨)");
    expect(useStore.getState().sideQueued["p1"]).toBe(true);
  });

  it("promote as a note while Claude works says so; success clears the dialog", async () => {
    const useStore = await loadStore();
    useStore.getState().handleEvent({ type: "side_thread", thread: thread({ id: "n1", anchor: { path: "a.ts", line: 2 }, messages: [{ role: "assistant", text: "a", at: at(1) }] }) });
    respond = (c) => (c.type === "side_promote_draft" ? { ok: true, reply: { type: "side_promote_draft", threadId: "n1", text: "메모" } } : { ok: false, error: "session_running", code: "session_running" });
    await useStore.getState().startPromote("n1", "note");
    await useStore.getState().submitPromote();
    expect(useStore.getState().promoteDraft!.error).toMatch(/메모/);
    expect(useStore.getState().promoteDraft!.recovery).toBeNull();
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().submitPromote()).toBe(true);
    expect(useStore.getState().promoteDraft).toBeNull();
  });

  it("MCP commands update the list; a refusal is kept for the dialog", async () => {
    const useStore = await loadStore();
    useStore.setState({ state: { ...useStore.getState().state, project: { path: "/p", root: "/p", name: "p" } as never } });
    const servers = [{ name: "gh", status: "connected", scope: "user", source: "user", transport: "stdio", toolCount: 2, tools: ["a", "b"], error: null, serverInfo: null, config: null, disabledByUser: false, sessionAdded: false }];
    respond = () => ({ ok: true, reply: { type: "mcp_status", servers, restartRequired: true } });
    await useStore.getState().mcpToggle("gh", false);
    expect(sent.at(-1)).toEqual({ type: "mcp_toggle", name: "gh", enabled: false });
    expect(useStore.getState().mcp).toMatchObject({ loaded: true, restartRequired: true, busy: {} });
    expect(useStore.getState().mcp.servers).toHaveLength(1);
    respond = () => ({ ok: false, error: "invalid_mcp_name", code: "invalid_mcp_name" });
    const err = await useStore.getState().mcpAdd("bad name", "session", { command: "x" });
    expect(err).toMatch(/서버 이름/);
    expect(useStore.getState().mcpNotice).toBe(err);
    useStore.getState().handleEvent({ type: "mcp_status", servers: [], restartRequired: false });
    expect(useStore.getState().mcp.servers).toEqual([]);
  });
});
