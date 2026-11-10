import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, PermissionRequest, ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";
import { agentBundle, bundles, pendingPermissionsOf, permissionBundle } from "./permissionQueue";

/**
 * MARK: r2-peers — docs/PROTOCOL.md §33.1 in the Windows client: several waiting cards answered at once (M26: "대기 중 N개 모두
 * 허용", "이 에이전트의 요청은 이번 턴 동안 허용" — each its own permission_response).
 */

const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: `touch ${requestId}.txt` }, ...extra });
const git = { code: "git_command" as const, message: "reset --hard" };
const outside = { code: "outside_project" as const, message: "outside", path: "/elsewhere" };
const b4 = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: "idle" as const, entrypoint: "cli", sessionId: "s-b4" };
const executor = { agentId: "taskA", agentToolUseId: "agA", subagentType: "executor", description: "compile" };
const tester = { agentId: "taskB", agentToolUseId: "agB", subagentType: "test-engineer", description: "test" };

describe("M26 rules (pure)", () => {
  it("what may be answered together: not a question, a plan, a SendMessage or a red card; two or more, oldest first", () => {
    expect(bundles(req("a")) && bundles(req("o", { reason: outside }))).toBe(true);
    expect(bundles(req("n", { reason: { code: "nested_repository", message: "nested" } })) && bundles(req("w", { reason: { code: "other_worktree", message: "wt" } }))).toBe(true);
    expect(bundles(req("g", { reason: git }))).toBe(false);
    expect(bundles(req("t", { reason: { code: "worktree_command", message: "worktree add" } }))).toBe(false);
    expect(bundles(req("c", { reason: { code: "claude_config", message: "settings" } as unknown as PermissionRequest["reason"] }))).toBe(false);
    // A reason a newer engine sends and this client does not know: its own answer, as a red one.
    expect(bundles(req("u", { reason: { code: "future_code", message: "new" } as unknown as PermissionRequest["reason"] }))).toBe(false);
    expect(bundles(req("q", { toolName: "AskUserQuestion" }))).toBe(false);
    expect(bundles(req("p", { toolName: "ExitPlanMode" }))).toBe(false);
    expect(bundles(req("s", { toolName: "SendMessage", toSession: b4 }))).toBe(false);
    expect(permissionBundle([req("a"), req("g", { reason: git }), req("b")]).map((p) => p.requestId)).toEqual(["a", "b"]);
    expect(permissionBundle([req("a"), req("g", { reason: git })])).toEqual([]);
    expect(agentBundle([req("a", { agent: executor }), req("b", { agent: tester }), req("c", { agent: executor, reason: git })], "taskA").map((p) => p.requestId)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------- the store (engine bridge mocked, as permissionStore.test.ts)

type Call = EngineCommand | { type: "__setSettings"; patch: Partial<AppSettings> };
const calls: Call[] = [];

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => calls.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        calls.push(c);
        return { ok: true, reply: { type: "result", ok: true } };
      },
      setSettings: async () => ({}),
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;
const responses = () => calls.filter((c): c is Extract<EngineCommand, { type: "permission_response" }> => c.type === "permission_response");

describe("M26 in the store", () => {
  beforeAll(() => initI18n("en", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    calls.length = 0;
  });

  const open = (useStore: UseStore) => {
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      turnAllowedAgents: [],
      state: {
        ...s,
        project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
        session: { ...s.session, open: true, pendingPermission: null, pendingPermissions: [] },
        gate: { ...s.gate, phase: "running", canSend: false },
      } as ReviewState,
    });
  };
  const ask = (useStore: UseStore, r: PermissionRequest) => useStore.getState().handleEvent({ type: "permission_request", ...r });

  it("\"대기 중 N개 모두 허용\" answers each request that may go together; the red card keeps waiting", async () => {
    const useStore = await loadStore();
    open(useStore);
    ask(useStore, req("R1", { agent: executor }));
    ask(useStore, req("R2", { agent: tester }));
    ask(useStore, req("R3", { reason: git }));
    useStore.getState().allowWaitingPermissions();
    expect(responses()).toEqual([
      { type: "permission_response", requestId: "R1", allow: true },
      { type: "permission_response", requestId: "R2", allow: true },
    ]);
    expect(pendingPermissionsOf(useStore.getState().state).map((p) => p.requestId)).toEqual(["R3"]);
  });

  it("\"이 에이전트의 요청은 이번 턴 동안 허용\" answers its requests as they come until the turn ends — red cards and other agents still ask", async () => {
    const useStore = await loadStore();
    open(useStore);
    ask(useStore, req("R1", { agent: executor }));
    useStore.getState().allowAgentForTurn("taskA");
    ask(useStore, req("R2", { agent: executor }));
    ask(useStore, req("R3", { agent: tester }));
    ask(useStore, req("R4", { agent: executor, reason: git }));
    expect(responses().map((r) => r.requestId)).toEqual(["R1", "R2"]);
    useStore.getState().handleEvent({ type: "turn_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }, files: 0, added: 0, deleted: 0, changedOutside: [] } as never);
    expect(useStore.getState().turnAllowedAgents).toEqual([]);
    ask(useStore, req("R5", { agent: executor }));
    expect(responses().map((r) => r.requestId)).toEqual(["R1", "R2"]);
  });
});
