import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// wave2 check-clients — §29 external turn in the composer, as on the Mac (PeerText.externalTurnComposer): a turn the CLI
// runs that is not ours is another session's message only when `externalTurn.peer` says so; otherwise (a command of the
// CLI's own) the composer said "다른 세션의 메시지를 처리하는 중이에요" all the same.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  return await import("./store");
}

describe("the composer while another turn holds the gate", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const state = (externalTurn: ReviewState["session"]["externalTurn"]): ReviewState => {
    const s = m.useStore.getInitialState().state;
    return {
      ...s,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, externalTurn },
      gate: { ...s.gate, canSend: false, phase: "idle", blockedReason: "running" },
    } as ReviewState;
  };

  it("another session's message: says so", () => {
    expect(m.cannotSendReason(state({ commandUuid: "c", since: "t", peer: { from: "uds:/tmp/cc-socks/1.sock", fromName: "b4", verifiedPeerPid: 1 } }))).toBe("다른 세션의 메시지를 처리하는 중이에요 — 보낸 메시지는 끝나면 전송돼요");
  });

  it("a turn of the CLI's own (no peer): other work, not a message", () => {
    expect(m.cannotSendReason(state({ commandUuid: "c", since: "t", peer: null }))).toBe("Claude Code가 다른 작업을 처리하는 중이에요 — 보낸 메시지는 끝나면 전송돼요");
  });
});
