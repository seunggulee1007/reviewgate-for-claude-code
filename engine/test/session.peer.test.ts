import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type SessionSettings } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { UNPROMPTED_REASON } from "../src/session/hooks.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §29 at the session level (audit peer-01, peer-03, peer-04): the CLI's peer frames — verified with CLI
 * 2.1.307/2.1.308 (`system/peer_message_hold` held / released / dropped, `command_lifecycle` queued / started / completed,
 * the `--replay-user-messages` echo with `origin.kind: "peer"`, `result.origin`, `result.user_message_uuid`) — mapped to
 * session events; a release runs the peer turn as the session's own (review) turn; turn ownership follows the command
 * uuids, so an external turn neither ends ours nor gets our tool permissions.
 */

const SID = "s1";
const opts = { signal: new AbortController().signal };

type Script = {
  options: Options | undefined;
  push: (m: unknown) => void;
  end: () => void;
  flags: unknown[];
  onFlag: (f: (s: Record<string, unknown>) => void) => void;
  /** What the session wrote to the CLI's stdin. */
  sent: SDKUserMessage[];
  /** §50.3: `cancel_async_message` — the uuids asked for, and how the CLI answers (the frames it sends first). */
  cancels: string[];
  onCancel: (id: string) => Promise<boolean> | boolean;
  /** §56.1: `side_question` — what was asked (question, options), and the CLI's answer. */
  sideQuestions: { question: string; o: unknown }[];
  onSideQuestion: (question: string) => Promise<unknown> | unknown;
};

function scriptedSdk(): { queryFn: (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query; script: Script } {
  let onFlag: (s: Record<string, unknown>) => void = () => {};
  const script: Script = { options: undefined, push: () => {}, end: () => {}, flags: [], onFlag: (f) => (onFlag = f), sent: [], cancels: [], onCancel: () => false, sideQuestions: [], onSideQuestion: () => ({ response: "answer", synthetic: false }) };
  const queryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    script.options = args.options;
    void (async () => {
      for await (const m of args.prompt) script.sent.push(m);
    })();
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    script.push = (m) => {
      queue.push(m);
      wake?.();
    };
    script.end = () => {
      ended = true;
      wake?.();
    };
    const q = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        while (queue.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
        const m = queue.shift();
        return m ? { done: false, value: m as SDKMessage } : { done: true, value: undefined };
      },
      async return() {
        script.end();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => undefined,
      initializationResult: () => Promise.resolve({}),
      cancelAsyncMessage: async (id: string) => {
        script.cancels.push(id);
        return script.onCancel(id);
      },
      askSideQuestion: async (question: string, o: unknown) => {
        script.sideQuestions.push({ question, o });
        return script.onSideQuestion(question);
      },
      applyFlagSettings: async (s: Record<string, unknown>) => {
        script.flags.push(s);
        onFlag(s); // the CLI's frames for the switch arrive before the call returns (verified: released at +39 ms, reply at +43 ms)
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    return q as unknown as Query;
  };
  return { queryFn, script };
}

function session(over: Partial<SessionSettings> = {}): { s: ClaudeSession; events: SessionEvent[]; script: Script } {
  const { queryFn, script } = scriptedSdk();
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", crossSessionInbound: "hold", sessionName: "ReviewGate · acme", ...over },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
  });
  return { s, events, script };
}

const until = async (pred: () => boolean, what: string, ms = WAIT_MS): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const hold = (state: "held" | "released" | "dropped", id: string, extra: Record<string, unknown> = {}) => ({
  type: "system", subtype: "peer_message_hold", state, message_uuid: id, lane: "socket", from: "uds:/tmp/cc-socks/76616.sock", from_name: "acme-b4", uuid: `h-${state}-${id}`, session_id: SID, ...extra,
});
const lifecycle = (id: string, state: string) => ({ type: "command_lifecycle", command_uuid: id, state, uuid: `l-${state}-${id}`, session_id: SID });
const origin = (body: string) => ({ kind: "peer", from: "uds:/tmp/cc-socks/76616.sock", verifiedPeerPid: 76616, msg_id: "m-1", name: "acme-b4", fromMode: "prompting", body });
const replay = (id: string, body: string) => ({ type: "user", message: { role: "user", content: `Another Claude session sent a message:\n<cross-session-message …>\n${body}\n</cross-session-message>` }, session_id: SID, parent_tool_use_id: null, uuid: id, isReplay: true, isSynthetic: true, origin: origin(body) });
const toolUse = (msgId: string, id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant", parent_tool_use_id: null, uuid: `a-${id}`, session_id: SID,
  message: { id: msgId, model: "claude-x", type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
});
const result = (cost: number, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 2, output_tokens: 3 }, duration_ms: 7, total_cost_usd: cost, is_error: false, result: "", ...extra });

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
}
async function preDecision(script: Script, toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
  for (const m of script.options!.hooks!.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const out = (await (h as HookCallback)(preToolUse(toolName, input), "t1", opts)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      if (out.hookSpecificOutput?.permissionDecision === "deny") return `deny:${out.hookSpecificOutput.permissionDecisionReason}`;
    }
  }
  return "pass";
}

const ofType = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("peer messages: CLI options (§29)", () => {
  it("hold in the flag settings, user-message replay and the ReviewGate display name; none of it without crossSessionInbound", async () => {
    const { s, script } = session();
    await s.start();
    expect(script.options!.settings).toEqual({ crossSessionInbound: "hold" });
    expect(script.options!.extraArgs).toEqual({ "replay-user-messages": null, name: "ReviewGate · acme" });
    await s.dispose();
    const plain = session({ crossSessionInbound: undefined, sessionName: undefined });
    await plain.s.start();
    expect(plain.script.options).not.toHaveProperty("settings");
    expect(plain.script.options!.extraArgs ?? {}).toEqual({});
    await plain.s.dispose();
  });
});

describe("peer messages: hold → release → review turn (§29)", () => {
  it("held frames are reported; releasePeers accepts then holds again, the peer turn is the session's own turn (tools pass the guard, its result is a turn_end)", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(hold("held", "P1", { cause: "explicit-setting" }));
    await until(() => ofType(events, "peer_hold").length === 1, "held");
    expect(ofType(events, "peer_hold")[0]).toEqual({ type: "peer_hold", state: "held", messageUuid: "P1", from: "uds:/tmp/cc-socks/76616.sock", fromName: "acme-b4", cause: "explicit-setting" });
    // Not released yet: the CLI runs nothing, and nothing may change.
    expect(await preDecision(script, "Write", { file_path: "/tmp/x", content: "x" })).toBe(`deny:${UNPROMPTED_REASON}`);

    script.onFlag((f) => {
      if (f.crossSessionInbound === "accept") {
        script.push(hold("released", "P1"));
        script.push(lifecycle("P1", "queued"));
      }
    });
    const released = await s.releasePeers(["P1"], "tree-A");
    expect(released).toEqual(["P1"]);
    expect(script.flags).toEqual([{ crossSessionInbound: "accept" }, { crossSessionInbound: "hold" }]);
    expect(s.isTurnActive).toBe(true);
    script.push(lifecycle("P1", "started"));
    script.push(replay("P1", "PR #514 2라운드 맡은 세션이야?"));
    await until(() => ofType(events, "peer_delivered").length === 1, "delivered");
    expect(ofType(events, "peer_delivered")[0]).toEqual({
      type: "peer_delivered", messageUuid: "P1", owned: true,
      origin: { from: "uds:/tmp/cc-socks/76616.sock", name: "acme-b4", verifiedPeerPid: 76616, body: "PR #514 2라운드 맡은 세션이야?", fromMode: "prompting", msgId: "m-1" },
    });
    // The released turn is a review turn: an edit inside the project is allowed (and collected by the engine).
    expect(await preDecision(script, "Write", { file_path: "/tmp/rg-peer/a.txt", content: "a" })).toBe("pass");
    script.push(toolUse("m1", "w1", "Write", { file_path: "/tmp/rg-peer/a.txt", content: "a" }));
    script.push(result(0.02, { origin: origin("PR #514 2라운드 맡은 세션이야?") }));
    script.push(lifecycle("P1", "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "turn_end");
    // Absolute for the host (`D:\\tmp\\rg-peer\\a.txt` on Windows): the edit tools' paths are resolved.
    expect(ofType(events, "turn_end")[0]!.toolFiles.map((f) => f.path)).toEqual([resolve("/tmp/rg-peer/a.txt")]);
    expect(ofType(events, "unprompted_turn_end")).toEqual([]);
    expect(ofType(events, "peer_delivered")).toHaveLength(1); // the result's origin repeats it: not reported twice
    expect(s.isTurnActive).toBe(false);
    await s.dispose();
  });

  it("no released frame within the timeout: releasePeers rejects, the flag is back on hold and no turn is active", async () => {
    const { s, events, script } = session({ peerReleaseTimeoutMs: 60 });
    await s.start();
    script.push(hold("held", "P1", { cause: "explicit-setting" }));
    await until(() => ofType(events, "peer_hold").length === 1, "held");
    await expect(s.releasePeers(["P1"], "tree-A")).rejects.toThrow(/released/);
    expect(script.flags).toEqual([{ crossSessionInbound: "accept" }, { crossSessionInbound: "hold" }]);
    expect(s.isTurnActive).toBe(false);
    expect(await preDecision(script, "Write", { file_path: "/tmp/x", content: "x" })).toBe(`deny:${UNPROMPTED_REASON}`);
    await s.dispose();
  });

  it("dismissPeers refuses every held message (dropped / refused frames) and returns to hold; setPeerInbound switches the live value", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(hold("held", "P1", { cause: "explicit-setting" }));
    script.push(hold("held", "P2", { cause: "explicit-setting" }));
    await until(() => ofType(events, "peer_hold").length === 2, "held");
    script.onFlag((f) => {
      if (f.crossSessionInbound === "refuse") {
        script.push(hold("dropped", "P1", { outcome: "refused" }));
        script.push(hold("dropped", "P2", { outcome: "refused" }));
      }
    });
    expect(await s.dismissPeers(["P1", "P2"])).toEqual(["P1", "P2"]);
    expect(script.flags).toEqual([{ crossSessionInbound: "refuse" }, { crossSessionInbound: "hold" }]);
    expect(ofType(events, "peer_hold").slice(2).map((e) => [e.state, e.messageUuid, e.outcome])).toEqual([["dropped", "P1", "refused"], ["dropped", "P2", "refused"]]);
    script.onFlag(() => {});
    await s.setPeerInbound("refuse");
    expect(script.flags.at(-1)).toEqual({ crossSessionInbound: "refuse" });
    await s.dispose();
  });
});

describe("turn ownership by command uuid (§29, audit peer-03)", () => {
  it("our messages carry a uuid; an external turn running when the user sends neither ends the user's turn nor gets its permissions", async () => {
    const { s, events, script } = session();
    await s.start();
    const canUseTool = script.options!.canUseTool as CanUseTool;
    // A peer message the CLI delivered by itself (policy accept / an older CLI): command P starts.
    script.push(lifecycle("P", "started"));
    await until(() => ofType(events, "external_turn").length === 1, "external");
    expect(ofType(events, "external_turn")[0]).toEqual({ type: "external_turn", running: true, commandUuid: "P" });
    // The user's send lands meanwhile (the engine normally refuses it while an external turn runs).
    s.sendUser("UserService 수정해줘", "tree-A");
    await until(() => script.sent.length === 1, "sent");
    const userUuid = script.sent[0]!.uuid!;
    expect(userUuid).toMatch(/^[0-9a-f-]{36}$/);
    // P still runs: its edits stay blocked although the user's message is pending.
    expect(await preDecision(script, "Edit", { file_path: "/tmp/rg-peer/u.ts", old_string: "a", new_string: "b" })).toBe(`deny:${UNPROMPTED_REASON}`);
    expect(await canUseTool("Write", { file_path: "/tmp/rg-peer/u.ts", content: "z" }, { ...opts, suggestions: [], toolUseID: "x" } as never)).toEqual({ behavior: "deny", message: UNPROMPTED_REASON });
    script.push(result(0.01, { origin: origin("hello") }));
    script.push(lifecycle("P", "completed"));
    await until(() => ofType(events, "unprompted_turn_end").length === 1, "P's result is not ours");
    expect(ofType(events, "turn_end")).toEqual([]);
    expect(ofType(events, "external_turn").at(-1)).toEqual({ type: "external_turn", running: false, commandUuid: "P" });
    expect(s.isTurnActive).toBe(true);
    // The user's own command now starts: its edits are allowed and its result ends the turn.
    script.push(lifecycle(userUuid, "started"));
    await new Promise((r) => setTimeout(r, 20));
    expect(await preDecision(script, "Edit", { file_path: "/tmp/rg-peer/u.ts", old_string: "a", new_string: "b" })).toBe("pass");
    script.push(toolUse("m2", "e1", "Edit", { file_path: "/tmp/rg-peer/u.ts", old_string: "a", new_string: "b" }));
    script.push(result(0.05, { user_message_uuid: userUuid, user_message_uuids: [userUuid] }));
    script.push(lifecycle(userUuid, "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "user's turn_end");
    expect(ofType(events, "turn_end")[0]!.toolFiles.map((f) => f.path)).toEqual([resolve("/tmp/rg-peer/u.ts")]);
    expect(ofType(events, "unprompted_denied").map((e) => e.toolName)).toEqual(["Edit", "Write"]); // P's calls only
    await s.dispose();
  });

  it("without hold support (an older CLI) a peer turn shows up as peer_delivered{owned:false} from the replay, before its tools; its result stays unprompted", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(lifecycle("P", "started"));
    script.push(replay("P", "4113 끝냈으니 리뷰 이어가"));
    script.push(toolUse("m1", "w1", "Write", { file_path: "/tmp/x", content: "x" }));
    script.push(result(0.01, { origin: origin("4113 끝냈으니 리뷰 이어가") }));
    script.push(lifecycle("P", "completed"));
    await until(() => ofType(events, "unprompted_turn_end").length === 1, "unprompted end");
    const order = events.map((e) => e.type).filter((t) => t === "peer_delivered" || t === "tool_use" || t === "unprompted_turn_end");
    expect(order).toEqual(["peer_delivered", "tool_use", "unprompted_turn_end"]);
    expect(ofType(events, "peer_delivered")[0]).toMatchObject({ messageUuid: "P", owned: false, origin: { name: "acme-b4", body: "4113 끝냈으니 리뷰 이어가", verifiedPeerPid: 76616 } });
    await s.dispose();
  });

  it("a released message folded into the first one's CLI turn (no started of its own) ends the review turn at its completed, cost included", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(hold("held", "P1", { cause: "explicit-setting" }));
    script.push(hold("held", "P2", { cause: "explicit-setting" }));
    await until(() => ofType(events, "peer_hold").length === 2, "held");
    script.onFlag((f) => {
      if (f.crossSessionInbound === "accept") for (const id of ["P1", "P2"]) script.push(hold("released", id));
    });
    await s.releasePeers(["P1", "P2"], "tree-A");
    script.push(lifecycle("P1", "started"));
    script.push(result(0.04, { origin: origin("one") }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(events, "turn_end")).toEqual([]); // P2 has not started: the turn waits for it
    script.push(lifecycle("P1", "completed"));
    script.push(lifecycle("P2", "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "turn_end at P2's completed");
    expect(ofType(events, "turn_end")[0]!.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, costUsd: 0.04 });
    expect(s.isTurnActive).toBe(false);
    await s.dispose();
  });

  it("a CLI turn's result ends the external command even when its completed frame never comes (the input cannot stay closed)", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(lifecycle("X", "started"));
    script.push(result(0.01));
    await until(() => ofType(events, "unprompted_turn_end").length === 1, "result");
    expect(ofType(events, "external_turn")).toEqual([
      { type: "external_turn", running: true, commandUuid: "X" },
      { type: "external_turn", running: false, commandUuid: "X" },
    ]);
    script.push(lifecycle("X", "completed")); // late: no second "ended"
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(events, "external_turn")).toHaveLength(2);
    await s.dispose();
  });

  it("two released messages run as one review turn: it ends with the result after the last one started", async () => {
    const { s, events, script } = session();
    await s.start();
    script.push(hold("held", "P1", { cause: "explicit-setting" }));
    script.push(hold("held", "P2", { cause: "explicit-setting" }));
    await until(() => ofType(events, "peer_hold").length === 2, "held");
    script.onFlag((f) => {
      if (f.crossSessionInbound === "accept") for (const id of ["P1", "P2"]) script.push(hold("released", id));
    });
    expect(await s.releasePeers(["P1", "P2"], "tree-A")).toEqual(["P1", "P2"]);
    script.push(lifecycle("P1", "started"));
    script.push(replay("P1", "one"));
    script.push(result(0.01, { origin: origin("one") }));
    script.push(lifecycle("P1", "completed"));
    script.push(lifecycle("P2", "started"));
    script.push(replay("P2", "two"));
    await until(() => ofType(events, "peer_delivered").length === 2, "both delivered");
    expect(ofType(events, "turn_end")).toEqual([]);
    script.push(result(0.03, { origin: origin("two") }));
    script.push(lifecycle("P2", "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "one turn_end");
    expect(ofType(events, "turn_end")[0]!.usage).toMatchObject({ inputTokens: 4, outputTokens: 6, costUsd: 0.03 });
    await s.dispose();
  });
});

describe("§50 a message put into the running turn (steerUser)", () => {
  it("folded into the turn (started after the tool call, completed before the result): one turn_end", async () => {
    const { s, events, script } = session();
    await s.start();
    s.sendUser("Run the tests", "tree-A");
    await until(() => script.sent.length === 1, "first message");
    const first = script.sent[0]!.uuid!;
    script.push(lifecycle(first, "queued"));
    script.push(lifecycle(first, "started"));
    const id = s.steerUser("Also check the README");
    await until(() => script.sent.length === 2, "the message put in");
    const steered = script.sent[1]!;
    expect(steered.message.content).toBe("Also check the README");
    expect(steered.priority).toBe("next");
    expect(steered.uuid).not.toBe(first);
    expect(id).toBe(steered.uuid); // composer (§50.2): the engine knows it by this id
    script.push(lifecycle(steered.uuid!, "queued"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(events, "steer_read")).toEqual([]); // queued: Claude has not read it yet
    script.push(lifecycle(steered.uuid!, "started"));
    await until(() => ofType(events, "steer_read").length === 1, "steer_read");
    expect(ofType(events, "steer_read")[0]).toEqual({ type: "steer_read", uuid: steered.uuid });
    script.push(lifecycle(steered.uuid!, "completed"));
    script.push(result(0.02, { user_message_uuids: [first, steered.uuid] }));
    script.push(lifecycle(first, "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "turn_end");
    expect(s.isTurnActive).toBe(false);
    expect(() => s.steerUser("too late")).toThrow(/no turn/);
    await s.dispose();
  });

  it("a turn that ended before the CLI took it runs it as its own command — still one review turn, usage summed", async () => {
    const { s, events, script } = session();
    await s.start();
    s.sendUser("Run the tests", "tree-A");
    await until(() => script.sent.length === 1, "first message");
    const first = script.sent[0]!.uuid!;
    script.push(lifecycle(first, "started"));
    s.steerUser("Also check the README");
    await until(() => script.sent.length === 2, "the message put in");
    const second = script.sent[1]!.uuid!;
    script.push(lifecycle(second, "queued"));
    script.push(result(0.02));
    script.push(lifecycle(first, "completed"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(events, "turn_end")).toEqual([]);   // the message put in has not run yet: the turn waits for it
    expect(s.isTurnActive).toBe(true);
    script.push(lifecycle(second, "started"));
    script.push(result(0.05));
    script.push(lifecycle(second, "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "turn_end after the second command");
    expect(ofType(events, "turn_end")[0]!.usage).toMatchObject({ inputTokens: 4, outputTokens: 6, costUsd: 0.05 });
    expect(ofType(events, "unprompted_turn_end")).toEqual([]);
    await s.dispose();
  });

  it("without a turn it throws (the engine refuses before)", async () => {
    const { s } = session();
    await s.start();
    expect(() => s.steerUser("hello")).toThrow(/no turn/);
    await s.dispose();
  });
});

describe("§50.3 taking back a message put into the turn (takeBackSteer)", () => {
  /** A turn running with one steered message the CLI has queued. */
  async function steered(): Promise<{ s: ClaudeSession; events: SessionEvent[]; script: Script; first: string; id: string }> {
    const { s, events, script } = session();
    await s.start();
    s.sendUser("Run the tests", "tree-A");
    await until(() => script.sent.length === 1, "first message");
    const first = script.sent[0]!.uuid!;
    script.push(lifecycle(first, "queued"));
    script.push(lifecycle(first, "started"));
    const id = s.steerUser("Also check the README");
    await until(() => script.sent.length === 2, "the message put in");
    script.push(lifecycle(id, "queued"));
    return { s, events, script, first, id };
  }

  it("in time: the CLI drops it (its cancelled frame before the reply) — taken, no steer_read, the turn ends without it", async () => {
    const { s, events, script, first, id } = await steered();
    script.onCancel = async (uuid) => {
      script.push(lifecycle(uuid, "cancelled")); // the CLI writes the frame, then the control response
      await new Promise((r) => setTimeout(r, 10));
      return true;
    };
    await expect(s.takeBackSteer(id)).resolves.toBe("taken");
    expect(script.cancels).toEqual([id]);
    await until(() => ofType(events, "steer_withdrawn").length === 1, "steer_withdrawn");
    expect(ofType(events, "steer_withdrawn")[0]).toEqual({ type: "steer_withdrawn", uuid: id });
    expect(ofType(events, "steer_read")).toEqual([]);
    // The turn no longer waits for it: its result ends the turn at once.
    script.push(result(0.02));
    script.push(lifecycle(first, "completed"));
    await until(() => ofType(events, "turn_end").length === 1, "turn_end");
    expect(ofType(events, "unprompted_turn_end")).toEqual([]);
    // Asking again is too late: it is no longer waiting.
    await expect(s.takeBackSteer(id)).resolves.toBe("read");
    expect(script.cancels).toEqual([id]);
    await s.dispose();
  });

  it("in time, the reply before the frame: taken once (one steer_withdrawn)", async () => {
    const { s, events, script, id } = await steered();
    script.onCancel = (uuid) => {
      setTimeout(() => script.push(lifecycle(uuid, "cancelled")), 10);
      return true;
    };
    await expect(s.takeBackSteer(id)).resolves.toBe("taken");
    await new Promise((r) => setTimeout(r, 40));
    expect(ofType(events, "steer_withdrawn")).toHaveLength(1);
    expect(ofType(events, "steer_read")).toEqual([]);
    await s.dispose();
  });

  it("too late: Claude started it — read, without asking the CLI", async () => {
    const { s, events, script, id } = await steered();
    script.push(lifecycle(id, "started"));
    await until(() => ofType(events, "steer_read").length === 1, "steer_read");
    await expect(s.takeBackSteer(id)).resolves.toBe("read");
    expect(script.cancels).toEqual([]);
    expect(ofType(events, "steer_withdrawn")).toEqual([]);
    await s.dispose();
  });

  it("too late while it is being folded in (cancelled: false): its started frame settles it — read, its steer_read once", async () => {
    const { s, events, script, id } = await steered();
    script.onCancel = (uuid) => {
      setTimeout(() => script.push(lifecycle(uuid, "started")), 15);
      return false;
    };
    await expect(s.takeBackSteer(id)).resolves.toBe("read");
    expect(ofType(events, "steer_read")).toEqual([{ type: "steer_read", uuid: id }]);
    expect(ofType(events, "steer_withdrawn")).toEqual([]);
    await s.dispose();
  });

  it("cancelled: false and no frame before the turn ends: read with the turn's end (the engine shows it as sent)", async () => {
    const { s, events, script, first, id } = await steered();
    script.onCancel = () => false;
    const outcome = s.takeBackSteer(id);
    await until(() => script.cancels.length === 1, "the cancel asked");
    script.push(lifecycle(id, "completed")); // folded into the turn's last step
    script.push(result(0.02));
    script.push(lifecycle(first, "completed"));
    await expect(outcome).resolves.toBe("read");
    await until(() => ofType(events, "turn_end").length === 1, "turn_end");
    await s.dispose();
  });

  it("the session closes while it waits for the CLI's word: read", async () => {
    const { s, script, id } = await steered();
    script.onCancel = () => false;
    const outcome = s.takeBackSteer(id);
    await until(() => script.cancels.length === 1, "the cancel asked");
    await s.dispose();
    await expect(outcome).resolves.toBe("read");
  });

  it("the CLI fails the request: kept (it still goes to Claude)", async () => {
    const { s, events, script, id } = await steered();
    script.onCancel = () => {
      throw new Error("unsupported control request");
    };
    await expect(s.takeBackSteer(id)).resolves.toBe("kept");
    expect(ofType(events, "steer_withdrawn")).toEqual([]);
    script.push(lifecycle(id, "started"));
    await until(() => ofType(events, "steer_read").length === 1, "it is read after all");
    await s.dispose();
  });
});

describe("§56.1 /btw on the live session (askSideQuestion)", () => {
  it("asks the CLI's side_question with the earlier exchanges while the turn runs; the turn is not touched", async () => {
    const { s, events, script } = session();
    await s.start();
    s.sendUser("Run the tests", "tree-A");
    await until(() => script.sent.length === 1, "first message");
    script.onSideQuestion = () => ({ response: "It returns the total.", synthetic: false });
    const history = [{ question: "q0", response: "a0" }];
    await expect(s.askSideQuestion("what does sum() return?", history)).resolves.toEqual({ response: "It returns the total.", synthetic: false });
    expect(script.sideQuestions).toEqual([{ question: "what does sum() return?", o: { history } }]);
    expect(script.sent).toHaveLength(1);
    expect(s.isTurnActive).toBe(true);
    expect(ofType(events, "turn_end")).toEqual([]);
    await s.dispose();
  });

  it("no history: none sent; cancelled: null; a refusal rejects", async () => {
    const { s, script } = session();
    await s.start();
    script.onSideQuestion = () => null;
    await expect(s.askSideQuestion("q", [])).resolves.toBeNull();
    expect(script.sideQuestions[0]!.o).toEqual({});
    script.onSideQuestion = () => {
      throw new Error("Unsupported control request subtype: side_question");
    };
    await expect(s.askSideQuestion("q", [])).rejects.toThrow(/side_question/);
    await s.dispose();
  });

  it("not started: rejects (the engine forks instead)", async () => {
    const { s } = session();
    await expect(s.askSideQuestion("q", [])).rejects.toThrow(/not started/);
  });
});
