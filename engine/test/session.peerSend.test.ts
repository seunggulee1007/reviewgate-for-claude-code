import { describe, expect, it } from "vitest";
import type { HookCallback, HookInput, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PeerSessionInfo } from "../src/protocol.js";
import { ClaudeSession, type SessionSettings } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { ASK_REASON } from "../src/session/hooks.js";

/**
 * MARK: r2-peers — docs/PROTOCOL.md §33.2 at the session level: whom a SendMessage reaches, as the session verifies it — a
 * subagent this process started (its task id is the agent id `to` names, CLI 2.1.318) or a live session of the user's
 * registry (`resolvePeer`, §42.2) — and what the PreToolUse hook makes of it in auto mode.
 */

const SID = "s1";
const opts = { signal: new AbortController().signal };
const AGENT = "a065d9d8a270268c5";
const PEER: PeerSessionInfo = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: "idle", entrypoint: "cli" };

type Script = { options: Options | undefined; push: (m: unknown) => void };

function scriptedSdk(): { queryFn: (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query; script: Script } {
  const script: Script = { options: undefined, push: () => {} };
  const queryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    script.options = args.options;
    void (async () => {
      for await (const _m of args.prompt) void _m;
    })();
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    script.push = (m) => {
      queue.push(m);
      wake?.();
    };
    const q = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        while (queue.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
        const m = queue.shift();
        return m ? { done: false, value: m as SDKMessage } : { done: true, value: undefined };
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
    };
    return q as unknown as Query;
  };
  return { queryFn, script };
}

function session(over: Partial<SessionSettings> = {}, resolvePeer?: (address: string) => Promise<PeerSessionInfo | null>) {
  const { queryFn, script } = scriptedSdk();
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", ...over },
    claudePath: "/nonexistent/claude",
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined },
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
    ...(resolvePeer ? { resolvePeer } : {}),
  });
  return { s, events, script };
}

const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

type PreOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
/** The PreToolUse hooks' answer for a main-thread call in `cliMode`: the first decision, else "pass" (the CLI decides). */
async function pre(script: Script, toolName: string, input: Record<string, unknown>, cliMode = "auto"): Promise<PreOut["hookSpecificOutput"] | "pass"> {
  for (const m of script.options!.hooks!.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const hookInput = { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1", permission_mode: cliMode } as unknown as HookInput;
      const out = (await (h as HookCallback)(hookInput, "t1", opts)) as PreOut;
      if (out.hookSpecificOutput?.permissionDecision) return out.hookSpecificOutput;
    }
  }
  return "pass";
}

const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype, uuid: `u-${subtype}-${Math.random()}`, session_id: SID, ...extra });

describe("SendMessage to a verified recipient (§33.2)", () => {
  it("auto mode: this session's own subagent and a live session of the user's get no card; a bare name or an unknown address does", async () => {
    const looked: string[] = [];
    const t = session({ permissionMode: "auto" }, async (address) => {
      looked.push(address);
      return address === PEER.address ? PEER : null;
    });
    await t.s.start();
    await until(() => t.events.some((e) => e.type === "session_ready"), "ready");
    t.s.sendUser("ask the other session", "tree-0"); // a turn of ours runs (the §18 guard comes first otherwise)
    // A subagent this process started (CLI 2.1.318: its task id is the agent id SendMessage names).
    t.script.push(sys("task_started", { task_id: AGENT, tool_use_id: "toolu_agent", description: "helper", task_type: "local_agent", is_backgrounded: true }));
    await until(() => t.events.some((e) => e.type === "agent_signal"), "task_started seen");
    expect(await pre(t.script, "SendMessage", { to: AGENT, message: "now run the tests" })).toBe("pass");
    expect(looked).toEqual([]); // an own subagent needs no registry lookup
    expect(await pre(t.script, "SendMessage", { to: PEER.address, message: "#42 done" })).toBe("pass");
    expect(await pre(t.script, "SendMessage", { to: "acme-b4", message: "done" })).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: ASK_REASON });
    expect(await pre(t.script, "SendMessage", { to: "uds:/tmp/cc-socks/1.sock", message: "x" })).toMatchObject({ permissionDecision: "ask" });
    expect(looked).toEqual([PEER.address, "acme-b4", "uds:/tmp/cc-socks/1.sock"]);
    await t.s.dispose();
  });

  it("a lookup that fails or hangs is an unverified recipient: the card", async () => {
    const t = session({ permissionMode: "auto" }, async (address) => {
      if (address.endsWith("1.sock")) throw new Error("EACCES");
      return new Promise<PeerSessionInfo | null>(() => {}); // never answers: the 400 ms bound
    });
    await t.s.start();
    await until(() => t.events.some((e) => e.type === "session_ready"), "ready");
    t.s.sendUser("ask the other session", "tree-0"); // a turn of ours runs (the §18 guard comes first otherwise)
    expect(await pre(t.script, "SendMessage", { to: "uds:/tmp/cc-socks/1.sock", message: "x" })).toMatchObject({ permissionDecision: "ask" });
    const at = Date.now();
    expect(await pre(t.script, "SendMessage", { to: PEER.address, message: "x" })).toMatchObject({ permissionDecision: "ask" });
    expect(Date.now() - at).toBeLessThan(2000);
    await t.s.dispose();
  });

  it("the default mode keeps the card for every recipient", async () => {
    const t = session({ permissionMode: "default" }, async () => PEER);
    await t.s.start();
    await until(() => t.events.some((e) => e.type === "session_ready"), "ready");
    t.s.sendUser("ask the other session", "tree-0"); // a turn of ours runs (the §18 guard comes first otherwise)
    expect(await pre(t.script, "SendMessage", { to: PEER.address, message: "x" }, "default")).toMatchObject({ permissionDecision: "ask" });
    await t.s.dispose();
  });

  it("\"이 세션으로 보내는 메시지는 세션 동안 허용\": a remembered SendMessage:<session id> allows messages to that conversation in any mode — not to another, not by name", async () => {
    const remembered = new Set<string>();
    const looked: string[] = [];
    const { queryFn, script } = scriptedSdk();
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", permissionMode: "default" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      rememberedAllows: remembered,
      emit: (e) => events.push(e),
      log: () => {},
      queryFn: queryFn as never,
      resolvePeer: async (address) => {
        looked.push(address);
        if (address === PEER.address) return { ...PEER, sessionId: "s-b4" };
        if (address.endsWith("4343.sock")) return { ...PEER, address, pid: 4343, sessionId: "s-c7" };
        return null;
      },
    });
    await s.start();
    await until(() => events.some((e) => e.type === "session_ready"), "ready");
    s.sendUser("tell the other session", "tree-0");
    // Nothing remembered for any session: no lookup, the card.
    expect(await pre(script, "SendMessage", { to: PEER.address, message: "x" }, "default")).toMatchObject({ permissionDecision: "ask" });
    expect(looked).toEqual([]);
    remembered.add("SendMessage:s-b4");
    expect(await pre(script, "SendMessage", { to: PEER.address, message: "x" }, "default")).toMatchObject({ permissionDecision: "allow", permissionDecisionReason: "ReviewGate: allowed for this session" });
    expect(await pre(script, "SendMessage", { to: "uds:/tmp/cc-socks/4343.sock", message: "x" }, "acceptEdits")).toMatchObject({ permissionDecision: "ask" });
    expect(await pre(script, "SendMessage", { to: "acme-b4", message: "x" }, "default")).toMatchObject({ permissionDecision: "ask" });
    // The key an older client stored for every message ("SendMessage:SendMessage") answers nothing and needs no lookup.
    remembered.clear();
    remembered.add("SendMessage:SendMessage");
    looked.length = 0;
    expect(await pre(script, "SendMessage", { to: PEER.address, message: "x" }, "default")).toMatchObject({ permissionDecision: "ask" });
    expect(looked).toEqual([]);
    await s.dispose();
  });
});
