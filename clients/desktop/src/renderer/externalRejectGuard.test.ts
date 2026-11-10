import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChangedFileState, EngineCommand, GateState, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// wave2 check-clients — §31.2 / handoff M3 as on the Mac (77f055a): "앱 밖 변경도 되돌리기" reverts exactly the outside
// changes its second confirm listed. When a newer snapshot changed that list while the confirm was open (another IDE save,
// a pull), `reject_all {includeExternal}` would also revert a file the user never saw in it — nothing is reverted then
// and the banner says to check again. The same for one outside file that is no longer an outside change.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
const respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

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
      getSettings: async () => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400 }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const file = (path: string, p: Partial<ChangedFileState> = {}): ChangedFileState => ({
  path,
  oldPath: null,
  status: "M",
  added: 1,
  deleted: 0,
  isBinary: false,
  tools: ["Edit"],
  toolUseIds: ["toolu_" + path],
  state: "pending",
  noteCount: 0,
  origin: "tool",
  ...p,
});
const ext = (path: string, p: Partial<ChangedFileState> = {}) => file(path, { tools: [], toolUseIds: [], origin: "external", ...p });

const rejects = () => sent.filter((c) => c.type.startsWith("reject"));
const CHANGED = "그사이 파일 목록이 바뀌어 아무것도 되돌리지 않았습니다 — 목록을 다시 확인해 주세요";

describe("reverting outside changes needs the list the user confirmed", () => {
  let useStore: Awaited<ReturnType<typeof loadStore>>;
  let seq = 100;
  const snapshot = (files: ChangedFileState[]) => {
    const s = useStore.getState().state;
    const pending = files.filter((f) => f.state === "pending");
    useStore.getState().handleEvent({
      type: "state",
      state: {
        ...s,
        seq: ++seq,
        project: { path: "/p", root: "/p", name: "p" } as never,
        changedFiles: files,
        gate: { ...s.gate, phase: "reviewing", canSend: true, blockedReason: null, pendingCount: pending.length, externalPendingCount: pending.filter((f) => f.origin === "external").length } as GateState,
      } as ReviewState,
    });
  };

  beforeAll(async () => {
    initI18n("ko", "darwin");
    useStore = await loadStore();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({ dialog: null, errorBanner: null });
  });

  it("Reject all: a new outside change while the confirm was open → nothing is reverted, the banner says why", async () => {
    snapshot([file("a.ts"), ext("ide/Mine.java")]);
    useStore.getState().rejectAll(true);
    await flush();
    expect(useStore.getState().dialog).toEqual({ kind: "rejectExternal", paths: ["ide/Mine.java"], all: true });
    snapshot([file("a.ts"), ext("ide/Mine.java"), ext("ide/Other.java")]);
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(rejects()).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe(CHANGED);
  });

  it("the same list → reject_all {includeExternal} as before", async () => {
    snapshot([file("a.ts"), ext("ide/Mine.java")]);
    useStore.getState().rejectAll(true);
    await flush();
    snapshot([file("a.ts", { added: 2 }), ext("ide/Mine.java")]);
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(rejects()).toEqual([{ type: "reject_all", includeExternal: true }]);
    expect(useStore.getState().errorBanner).toBeNull();
  });

  it("an uncaptured outside file (never revertible, not on the list) does not count as a change", async () => {
    snapshot([file("a.ts"), ext("ide/Mine.java"), ext("logs/big.bin", { uncaptured: true })]);
    useStore.getState().rejectAll(true);
    await flush();
    expect(useStore.getState().dialog).toEqual({ kind: "rejectExternal", paths: ["ide/Mine.java"], all: true });
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(rejects()).toEqual([{ type: "reject", paths: ["a.ts", "ide/Mine.java"] }]);
    expect(useStore.getState().errorBanner).toBeNull();
  });

  it("one outside file that Claude has since edited (no longer outside) is not reverted", async () => {
    snapshot([ext("ide/Mine.java")]);
    useStore.getState().reject("ide/Mine.java");
    await flush();
    expect(useStore.getState().dialog).toEqual({ kind: "rejectExternal", paths: ["ide/Mine.java"], all: false });
    snapshot([file("ide/Mine.java")]);
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(rejects()).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe(CHANGED);
  });
});
