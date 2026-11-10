import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, PermissionRequest, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { canRemember, remembersSession } from "./permissionQueue";

/**
 * MARK: r2-peers — docs/PROTOCOL.md §33.2 in the Windows client: a SendMessage card to a live session's known conversation
 * ("이 세션으로 보내는 메시지는 세션 동안 허용") answers `remember: true`; any other SendMessage card never does.
 */

const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: `touch ${requestId}.txt` }, ...extra });
const git = { code: "git_command" as const, message: "reset --hard" };
const outside = { code: "outside_project" as const, message: "outside", path: "/elsewhere" };
const b4 = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: "idle" as const, entrypoint: "cli", sessionId: "s-b4" };

describe("§33.2 remember (pure)", () => {
  it("a SendMessage card is remembered only for a live session's known conversation", () => {
    const send = (extra: Partial<PermissionRequest>) => req("s", { toolName: "SendMessage", input: { to: b4.address, message: "x" }, ...extra });
    expect(remembersSession(send({}))).toBe(false);
    expect(remembersSession(send({ toSession: { ...b4, sessionId: undefined } }))).toBe(false);
    expect(remembersSession(send({ toSession: b4 }))).toBe(true);
    expect(remembersSession(send({ toSession: b4, reason: outside }))).toBe(false);
    expect(canRemember(send({ toSession: b4 })) && canRemember(req("a"))).toBe(true);
    expect(canRemember(req("g", { reason: git }))).toBe(false);
  });
});

// ---------------------------------------------------------------- the store (engine bridge mocked, as permissionStore.test.ts)

const calls: EngineCommand[] = [];

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

describe("§33.2 remember in the store", () => {
  beforeAll(() => initI18n("en", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    calls.length = 0;
  });

  const open = (useStore: UseStore) => {
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      state: {
        ...s,
        project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
        session: { ...s.session, open: true, pendingPermission: null, pendingPermissions: [] },
        gate: { ...s.gate, phase: "running", canSend: false },
      } as ReviewState,
    });
  };
  const ask = (useStore: UseStore, r: PermissionRequest) => useStore.getState().handleEvent({ type: "permission_request", ...r });

  it("remember rides on a SendMessage allow only when its receiving session's conversation is known", async () => {
    const useStore = await loadStore();
    open(useStore);
    ask(useStore, req("S1", { toolName: "SendMessage", input: { to: b4.address, message: "#42 done" }, toSession: b4 }));
    ask(useStore, req("S2", { toolName: "SendMessage", input: { to: "acme-b4", message: "a name" } }));
    useStore.getState().respondPermission("S1", true, undefined, undefined, true);
    useStore.getState().respondPermission("S2", true, undefined, undefined, true);
    expect(responses()).toEqual([
      { type: "permission_response", requestId: "S1", allow: true, remember: true },
      { type: "permission_response", requestId: "S2", allow: true },
    ]);
  });
});
