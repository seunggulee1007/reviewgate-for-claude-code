import { describe, expect, it } from "vitest";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PeerSessionInfo } from "../src/protocol.js";
import { ClaudeSession, type ClaudeSessionOptions } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/**
 * docs/PROTOCOL.md §42.2 at the session level (audit peer-07, peer-08): every message the app writes for the user carries
 * `origin {kind: "human"}` (the SDK: absent origin is unattributed and fails closed at the CLI's strict trust gates), and a
 * SendMessage card names the live session its address reaches (`toSession`, the engine's registry lookup).
 */

function scriptedSdk(): { queryFn: (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query; sent: SDKUserMessage[]; options: () => Options } {
  const sent: SDKUserMessage[] = [];
  let options: Options | undefined;
  const queryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    options = args.options;
    void (async () => {
      for await (const m of args.prompt) sent.push(m);
    })();
    let wake: (() => void) | undefined;
    let ended = false;
    const q = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        while (!ended) await new Promise<void>((r) => (wake = r));
        return { done: true, value: undefined };
      },
      async return() {
        ended = true;
        wake?.();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => undefined,
      initializationResult: () => Promise.resolve({}),
      applyFlagSettings: async () => undefined,
    };
    return q as unknown as Query;
  };
  return { queryFn, sent, options: () => options! };
}

function session(over: Partial<ClaudeSessionOptions> = {}) {
  const sdk = scriptedSdk();
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", crossSessionInbound: "hold", sessionName: "ReviewGate · acme" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: sdk.queryFn as never,
    ...over,
  });
  return { s, events, sdk };
}

const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

const B4: PeerSessionInfo = { address: "uds:/tmp/cc-socks/76616.sock", pid: 76616, name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli" };
const requestsOf = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");

describe("our messages say they are the user's (§42.2, peer-08)", () => {
  it("sendUser stamps origin human next to the uuid; text and images alike", async () => {
    const { s, sdk } = session();
    await s.start();
    s.sendUser("UserService 수정해줘", "tree-A");
    s.sendUser("그림 봐줘", "tree-B", [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }]);
    await until(() => sdk.sent.length === 2, "sent");
    for (const m of sdk.sent) {
      expect(m.origin).toEqual({ kind: "human" });
      expect(m.uuid).toMatch(/^[0-9a-f-]{36}$/);
    }
    await s.dispose();
  });
});

describe("the SendMessage card names whom it reaches (§42.2, peer-07)", () => {
  it("a session address resolved through the registry lookup goes out as toSession; a name, an unknown address or a failing lookup leave it out", async () => {
    const asked: string[] = [];
    const { s, events, sdk } = session({
      resolvePeer: async (address) => {
        asked.push(address);
        if (address === "uds:/tmp/cc-socks/boom.sock") throw new Error("EACCES");
        return address === B4.address ? B4 : null;
      },
    });
    await s.start();
    s.sendUser("acme-b4 한테 끝났다고 알려줘", "tree-A");
    const canUseTool = sdk.options().canUseTool as CanUseTool;
    const ask = (tool: string, input: Record<string, unknown>, id: string) =>
      void canUseTool(tool, input, { signal: new AbortController().signal, suggestions: [], toolUseID: id } as never);
    ask("SendMessage", { to: B4.address, message: "#514 끝났어", summary: "done" }, "t1");
    ask("SendMessage", { to: "a1b2c3d4", message: "gradle 도 돌려줘" }, "t2");
    ask("SendMessage", { to: "uds:/tmp/cc-socks/31337.sock", message: "x" }, "t3");
    ask("SendMessage", { to: "uds:/tmp/cc-socks/boom.sock", message: "y" }, "t4");
    await until(() => requestsOf(events).length === 4, "four cards");
    const byCall = new Map(requestsOf(events).map((r) => [r.toolUseId, r]));
    expect(byCall.get("t1")!.toSession).toEqual(B4);
    for (const id of ["t2", "t3", "t4"]) expect(byCall.get(id)).not.toHaveProperty("toSession");
    expect(asked).toEqual([B4.address, "a1b2c3d4", "uds:/tmp/cc-socks/31337.sock", "uds:/tmp/cc-socks/boom.sock"]);
    // Other tools never ask the registry.
    ask("Bash", { command: "rm -rf build" }, "t5");
    await until(() => requestsOf(events).length === 5, "bash card");
    expect(asked).toHaveLength(4);
    await s.dispose();
  });

  it("a call withdrawn while the lookup ran never shows a card", async () => {
    let release: () => void = () => {};
    const { s, events, sdk } = session({ resolvePeer: () => new Promise<PeerSessionInfo | null>((r) => (release = () => r(B4))) });
    await s.start();
    s.sendUser("보내줘", "tree-A");
    const ac = new AbortController();
    const answer = (sdk.options().canUseTool as CanUseTool)("SendMessage", { to: B4.address, message: "m" }, { signal: ac.signal, suggestions: [], toolUseID: "t1" } as never);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    release();
    expect(await answer).toEqual({ behavior: "deny", message: "aborted" });
    expect(requestsOf(events)).toEqual([]);
    await s.dispose();
  });
});
