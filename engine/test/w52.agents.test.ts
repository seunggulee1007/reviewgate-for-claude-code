import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, handbackOf, ownSubagentOrigin, peerOriginOf, type SessionSettings } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { UNPROMPTED_REASON } from "../src/session/hooks.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §52.2 at the session level — subagents run as in the terminal: in the background, the main agent free to
 * answer. With the frames CLI 2.1.318 sends (verified over stream-json, sonnet, auto mode): the Agent call answered at once
 * ("Async agent launched …", `task_started {is_backgrounded: true, task_type: local_agent}`), the subagent's calls with
 * `agent_id` in their hook input (`agentID` in canUseTool), `task_notification {handback: "send", handback_report}` when it
 * ends, then the turn the CLI runs itself with the hand-back replayed as a peer-like message (`origin {kind: "peer",
 * senderTaskId, handback: true, handbackReportText}`) and a `result` with that origin.
 */

const SID = "s1";
const opts = { signal: new AbortController().signal };
const AGENT = "a065d9d8a270268c5";
const CALL = "toolu_agent";
const REPORT = "big.txt 전체 읽기는 거부되어 offset 0, limit 5로 읽었고, sub.txt를 만들었습니다.";

type Script = { options: Options | undefined; push: (m: unknown) => void; sent: SDKUserMessage[] };

function scriptedSdk(): { queryFn: (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query; script: Script } {
  const script: Script = { options: undefined, push: () => {}, sent: [] };
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

function session(over: Partial<SessionSettings> = {}): { s: ClaudeSession; events: SessionEvent[]; script: Script } {
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
const ofType = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype, uuid: `u-${subtype}-${Math.random()}`, session_id: SID, ...extra });
const init = () => sys("init", { model: "claude-sonnet", permissionMode: "auto", cwd: "/tmp", tools: [], mcp_servers: [], slash_commands: [], skills: [], plugins: [] });
const lifecycle = (id: string, state: string) => ({ type: "command_lifecycle", command_uuid: id, state, uuid: `l-${state}-${id}`, session_id: SID });
const toolUse = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: "assistant", parent_tool_use_id: parent, uuid: `a-${id}`, session_id: SID,
  message: { id: `m-${id}`, model: "claude-x", type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
});
const toolResult = (id: string, text: string, parent: string | null = null, isError = false) => ({
  type: "user", parent_tool_use_id: parent, session_id: SID, uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
});
const result = (cost: number, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 2, output_tokens: 3 }, duration_ms: 7, total_cost_usd: cost, is_error: false, result: "", ...extra });
const LAUNCHED = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${AGENT} (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
const handbackOrigin = { kind: "peer", from: AGENT, senderTaskId: AGENT, name: "general-purpose", body: `[Subagent hand-back] … The report follows:\n  ${REPORT}`, handback: true, handbackReportText: REPORT };

function hookInput(toolName: string, toolInput: Record<string, unknown>, agentId?: string): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1", ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}) } as unknown as HookInput;
}
type PreOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
/** The first PreToolUse answer with a decision or an input change (deny wins), like the CLI folds them. */
async function pre(script: Script, toolName: string, input: Record<string, unknown>, agentId?: string): Promise<PreOut["hookSpecificOutput"] | "pass"> {
  for (const m of script.options!.hooks!.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const out = (await (h as HookCallback)(hookInput(toolName, input, agentId), "t1", opts)) as PreOut;
      if (out.hookSpecificOutput?.permissionDecision === "deny" || out.hookSpecificOutput?.updatedInput) return out.hookSpecificOutput;
    }
  }
  return "pass";
}

/** `sendUser`, and the uuid it stamped on the message. */
async function send(t: { s: ClaudeSession; script: Script }, text: string, tree: string): Promise<string> {
  const n = t.script.sent.length;
  t.s.sendUser(text, tree);
  await until(() => t.script.sent.length > n, "sent");
  return t.script.sent.at(-1)!.uuid!;
}

/** Started, one turn of ours sent (its command started): Claude starts a subagent in the background and answers. */
async function withBackgroundAgent(over: Partial<SessionSettings> = {}) {
  const t = session(over);
  await t.s.start();
  await until(() => ofType(t.events, "session_ready").length === 1, "ready");
  const own = await send(t, "서브에이전트로 sub.txt 만들어줘", "tree-0");
  t.script.push(lifecycle(own, "started"));
  t.script.push(init());
  t.script.push(toolUse(CALL, "Agent", { description: "Make sub.txt", subagent_type: "general-purpose", prompt: "…", run_in_background: true }));
  t.script.push(sys("background_tasks_changed", { tasks: [{ task_id: AGENT, task_type: "local_agent", subagent_type: "general-purpose", description: "Make sub.txt" }] }));
  t.script.push(sys("task_started", { task_id: AGENT, tool_use_id: CALL, description: "Make sub.txt", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", prompt: "…" }));
  t.script.push(toolResult(CALL, LAUNCHED));
  return { ...t, own };
}

/** The first turn's own end (its answer "STARTED"). */
async function endFirstTurn(t: { script: Script; events: SessionEvent[]; own: string }) {
  t.script.push(result(0.01, { user_message_uuid: t.own, user_message_uuids: [t.own] }));
  t.script.push(lifecycle(t.own, "completed"));
  await until(() => ofType(t.events, "turn_end").length === 1, "turn 1 ends");
}

describe("§52.2 subagents run as in the terminal", () => {
  it("Agent calls keep their input by default; subagentsInTurn keeps them in the turn (run_in_background: false); background work off leaves them alone", async () => {
    const def = session();
    await def.s.start();
    await until(() => ofType(def.events, "session_ready").length === 1, "ready");
    def.s.sendUser("x", "tree-0");
    expect(await pre(def.script, "Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" })).toBe("pass");
    expect(await pre(def.script, "Agent", { description: "d", prompt: "p", run_in_background: true })).toBe("pass");
    await def.s.dispose();

    const inTurn = session({ subagentsInTurn: true });
    await inTurn.s.start();
    await until(() => ofType(inTurn.events, "session_ready").length === 1, "ready");
    inTurn.s.sendUser("x", "tree-0");
    expect(await pre(inTurn.script, "Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" })).toMatchObject({
      updatedInput: { description: "d", prompt: "p", subagent_type: "general-purpose", run_in_background: false },
    });
    expect(await pre(inTurn.script, "Agent", { description: "d", prompt: "p", run_in_background: false })).toBe("pass");
    await inTurn.s.dispose();

    const off = session({ backgroundWork: false, subagentsInTurn: true });
    await off.s.start();
    await until(() => ofType(off.events, "session_ready").length === 1, "ready");
    off.s.sendUser("x", "tree-0");
    expect(await pre(off.script, "Agent", { description: "d", prompt: "p", run_in_background: true })).toBe("pass");
    await off.s.dispose();
  });

  it("the launch is no report (agentLaunched); a background subagent's calls pass the §18 guard between turns — the main thread's do not", async () => {
    const t = await withBackgroundAgent();
    await until(() => ofType(t.events, "tool_result").length === 1, "launch result");
    expect(ofType(t.events, "tool_result")[0]).toMatchObject({ toolUseId: CALL, isError: false, agentLaunched: true });
    expect(ofType(t.events, "tool_result")[0]).not.toHaveProperty("keptReport");
    expect(ofType(t.events, "tool_result")[0]).not.toHaveProperty("agentReport");
    await endFirstTurn(t);
    expect(t.s.isTurnActive).toBe(false);
    // The subagent writes while no turn of ours runs: its hooks carry agent_id.
    expect(await pre(t.script, "Write", { file_path: "/tmp/sub.txt", content: "sub" }, AGENT)).toBe("pass");
    expect(await pre(t.script, "Bash", { command: "npm run build" }, AGENT)).toBe("pass");
    expect(await pre(t.script, "SubagentHandback", { message: "done" }, AGENT)).toBe("pass");
    // canUseTool repeats the guard with the asking agent.
    const canUse = t.script.options!.canUseTool as CanUseTool;
    const asked = canUse("Write", { file_path: "/tmp/sub.txt", content: "sub" }, { ...opts, toolUseID: "toolu_w", agentID: AGENT } as never);
    const main = await canUse("Write", { file_path: "/tmp/x.txt", content: "x" }, { ...opts, toolUseID: "toolu_m" } as never);
    expect(main).toMatchObject({ behavior: "deny", message: UNPROMPTED_REASON });
    // An edit may wait on a card for the user: what matters is that the guard did not deny it.
    expect(await Promise.race([asked.then((r) => r?.behavior), new Promise((r) => setTimeout(() => r("waiting"), 30))])).not.toBe("deny");
    // The main thread (no agent_id) is still guarded.
    expect(await pre(t.script, "Write", { file_path: "/tmp/x.txt", content: "x" })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: UNPROMPTED_REASON });
    await t.s.dispose();
  });

  it("after the subagent ended its calls are guarded again; an agent no frame named is guarded while none works in the background", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(sys("task_updated", { task_id: AGENT, patch: { status: "completed", end_time: 1 } }));
    t.script.push(sys("task_notification", { task_id: AGENT, tool_use_id: CALL, status: "completed", summary: "DONE" }));
    await until(() => ofType(t.events, "agent_signal").some((e) => e.signal.kind === "task_notification"), "notified");
    expect(await pre(t.script, "Write", { file_path: "/tmp/late.txt", content: "x" }, AGENT)).toMatchObject({ permissionDecision: "deny" });
    expect(await pre(t.script, "Write", { file_path: "/tmp/late.txt", content: "x" }, "a-unknown")).toMatchObject({ permissionDecision: "deny" });
    await t.s.dispose();
  });

  it("an agent the background subagent starts (parent_task_id, else the call it made) works in the background too", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(toolUse("toolu_nested", "Agent", { description: "Look around", subagent_type: "Explore", prompt: "…" }, CALL));
    t.script.push(sys("task_started", { task_id: "a-nested", tool_use_id: "toolu_nested", description: "Look around", subagent_type: "Explore", is_backgrounded: false, spawn_depth: 2, task_type: "local_agent" }));
    await until(() => ofType(t.events, "agent_signal").filter((e) => e.signal.kind === "task_started").length === 2, "nested");
    expect(await pre(t.script, "Bash", { command: "touch n.txt" }, "a-nested")).toBe("pass");
    await t.s.dispose();
  });

  it("what it changes while no turn runs is the next turn's, with its calls as the cause", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(toolUse("toolu_w", "Write", { file_path: "/tmp/sub.txt", content: "sub" }, CALL));
    t.script.push(toolResult("toolu_w", "File created successfully at: /tmp/sub.txt", CALL));
    // A failed edit is no cause.
    t.script.push(toolUse("toolu_bad", "Edit", { file_path: "/tmp/bad.txt", old_string: "a", new_string: "b" }, CALL));
    t.script.push(toolResult("toolu_bad", "String to replace not found", CALL, true));
    await until(() => ofType(t.events, "tool_result").length === 3, "results");
    const second = await send(t, "2+2는?", "tree-1");
    t.script.push(lifecycle(second, "started"));
    t.script.push(result(0.02, { user_message_uuid: second }));
    await until(() => ofType(t.events, "turn_end").length === 2, "turn 2 ends");
    // An absolute path on the wire is the host's native form (§20): `D:\tmp\sub.txt` on Windows.
    expect(ofType(t.events, "turn_end")[1]!.toolFiles).toEqual([{ path: resolve("/tmp/sub.txt"), tools: ["Write"], count: 1, toolUseIds: ["toolu_w"] }]);
    await t.s.dispose();
  });

  it("an edit outside the project it makes while no turn runs is listed with the next turn (changedOutside)", async () => {
    const t = await withBackgroundAgent({ permissionMode: "auto" });
    await endFirstTurn(t);
    // The subagent writes a note outside the project (auto mode: no card); PostToolUse lists it.
    const outside = "/opt/acme-notes/todo.md";
    const post = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: outside, content: "x" }, tool_response: {}, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "toolu_o", agent_id: AGENT, agent_type: "general-purpose" } as unknown as HookInput;
    for (const m of t.script.options!.hooks!.PostToolUse!) {
      if (m.matcher && !new RegExp(`^(${m.matcher})$`).test("Write")) continue;
      for (const h of m.hooks) await (h as HookCallback)(post, "toolu_o", opts);
    }
    const second = await send(t, "2+2는?", "tree-1");
    t.script.push(lifecycle(second, "started"));
    t.script.push(result(0.02, { user_message_uuid: second }));
    await until(() => ofType(t.events, "turn_end").length === 2, "turn 2 ends");
    expect(ofType(t.events, "turn_end")[0]!.changedOutside ?? []).toEqual([]);
    expect(ofType(t.events, "turn_end")[1]!.changedOutside).toEqual([resolve(outside)]); // native (§20)
    await t.s.dispose();
  });

  it("its end: the call's own result is its report (once); the hand-back is no peer message; the turn the CLI runs is ours, with the agent named", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(sys("task_updated", { task_id: AGENT, patch: { status: "completed", end_time: 1 } }));
    t.script.push(sys("task_notification", {
      task_id: AGENT, tool_use_id: CALL, status: "completed", output_file: "/tmp/a.output",
      summary: `This agent's report was delivered to you as a message from "${AGENT}" (its SubagentHandback call). Read it there; it is not repeated here.\n`,
      usage: { total_tokens: 18514, tool_uses: 5, duration_ms: 24943 }, handback: "send", handback_report: { text: REPORT },
    }));
    t.script.push(sys("background_tasks_changed", { tasks: [] }));
    t.script.push(init());
    await until(() => ofType(t.events, "auto_turn_start").length === 1, "auto turn");
    const ended = ofType(t.events, "tool_result").filter((e) => e.agentEnded);
    expect(ended).toEqual([{
      type: "tool_result", toolUseId: CALL, isError: false, preview: REPORT, agentEnded: true, agentReport: REPORT,
      agentUsage: { tokens: 18514, toolUses: 5, durationMs: 24943 }, keptReport: { text: REPORT, truncated: false },
    }]);
    expect(ofType(t.events, "agent_signal").find((e) => e.signal.kind === "task_notification")!.signal).toMatchObject({ summary: REPORT });
    expect(ofType(t.events, "auto_turn_start")[0]).toEqual({
      type: "auto_turn_start", trigger: "background",
      task: { taskId: AGENT, description: "Make sub.txt", status: "completed", summary: REPORT, kind: "agent", toolUseId: CALL },
    });
    t.s.autoTurnReady(true, "tree-A");
    // The CLI replays the hand-back as a message "from another session": it is the agent's — no peer card, no second result.
    t.script.push({ type: "user", isReplay: true, isSynthetic: true, uuid: "hb-1", session_id: SID, parent_tool_use_id: null, origin: handbackOrigin, message: { role: "user", content: "Another Claude session sent a message: …" } });
    t.script.push(result(0.03, { origin: handbackOrigin }));
    await until(() => ofType(t.events, "turn_end").length === 2, "the hand-back turn ends");
    expect(ofType(t.events, "peer_delivered")).toEqual([]);
    expect(ofType(t.events, "unprompted_turn_end")).toEqual([]);
    expect(ofType(t.events, "tool_result").filter((e) => e.agentEnded)).toHaveLength(1);
    await t.s.dispose();
  });

  it("a hand-back without a notification first still closes the call (completed, its report)", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push({ type: "user", isReplay: true, uuid: "hb-2", session_id: SID, parent_tool_use_id: null, origin: handbackOrigin, message: { role: "user", content: "…" } });
    await until(() => ofType(t.events, "tool_result").some((e) => e.agentEnded), "ended");
    expect(ofType(t.events, "tool_result").find((e) => e.agentEnded)).toMatchObject({ toolUseId: CALL, isError: false, preview: REPORT });
    expect(ofType(t.events, "peer_delivered")).toEqual([]);
    await t.s.dispose();
  });

  it("a stopped subagent's call ends as an error", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(sys("task_notification", { task_id: AGENT, tool_use_id: CALL, status: "stopped", summary: "Task stopped" }));
    await until(() => ofType(t.events, "tool_result").some((e) => e.agentEnded), "ended");
    expect(ofType(t.events, "tool_result").find((e) => e.agentEnded)).toMatchObject({ toolUseId: CALL, isError: true, preview: "Task stopped" });
    expect(ofType(t.events, "tool_result").find((e) => e.agentEnded)).not.toHaveProperty("keptReport");
    await t.s.dispose();
  });

  it("a turn the CLI runs itself while our message waits in its queue does not end our turn: our command's result does", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    const second = await send(t, "다른 질문", "tree-1");
    t.script.push(lifecycle(second, "queued"));
    // The subagent ends; the CLI runs its hand-back turn before our message.
    t.script.push(sys("task_notification", { task_id: AGENT, tool_use_id: CALL, status: "completed", summary: "x", handback: "send", handback_report: { text: REPORT } }));
    t.script.push(init());
    t.script.push({ type: "user", isReplay: true, uuid: "hb-3", session_id: SID, parent_tool_use_id: null, origin: handbackOrigin, message: { role: "user", content: "…" } });
    t.script.push(result(0.02, { origin: handbackOrigin }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ofType(t.events, "turn_end")).toHaveLength(1);
    expect(ofType(t.events, "auto_turn_start")).toEqual([]);
    expect(t.s.isTurnActive).toBe(true);
    // Then our message runs: its result ends the turn (both results' usage).
    t.script.push(lifecycle(second, "started"));
    t.script.push(init());
    t.script.push(result(0.05, { user_message_uuid: second, user_message_uuids: [second] }));
    t.script.push(lifecycle(second, "completed"));
    await until(() => ofType(t.events, "turn_end").length === 2, "turn 2 ends");
    expect(ofType(t.events, "turn_end")[1]!.usage).toMatchObject({ inputTokens: 4, outputTokens: 6 });
    expect(ofType(t.events, "unprompted_turn_end")).toEqual([]);
    await t.s.dispose();
  });
});

describe("§52.2 the hand-back origin", () => {
  it("is no peer origin; handbackOf reads the agent and its report", () => {
    expect(peerOriginOf(handbackOrigin)).toBeNull();
    expect(handbackOf(handbackOrigin)).toEqual({ taskId: AGENT, name: "general-purpose", report: REPORT });
    expect(handbackOf({ kind: "peer", from: "uds:/tmp/x.sock", name: "acme" })).toBeNull();
    expect(peerOriginOf({ kind: "peer", from: "uds:/tmp/x.sock", name: "acme" })).toEqual({ from: "uds:/tmp/x.sock", name: "acme" });
    expect(handbackOf({ kind: "peer", from: AGENT, handback: true, body: "frame" })).toEqual({ taskId: AGENT, report: "frame" });
  });

  // MARK: r2-peers — the user's 0.5.9 records held a "message from another session" from general-purpose with the frame.
  it("the frame without the mark is a hand-back too: no peer origin, the report without the frame", () => {
    const unmarked = { kind: "peer", from: AGENT, senderTaskId: AGENT, name: "general-purpose", body: `[Subagent hand-back] The text below is the final report of a subagent … The report follows:\n  ${REPORT}` };
    expect(peerOriginOf(unmarked)).toBeNull();
    expect(handbackOf(unmarked)).toEqual({ taskId: AGENT, name: "general-purpose", report: REPORT });
    expect(ownSubagentOrigin(unmarked, new Set([AGENT]))).toBe(true);
    expect(ownSubagentOrigin({ kind: "peer", from: "uds:/tmp/cc-socks/1.sock", name: "acme-b4" }, new Set([AGENT]))).toBe(false);
    expect(ownSubagentOrigin({ kind: "peer", from: "general-purpose", senderTaskId: AGENT }, new Set())).toBe(false);
  });
});

// MARK: r2-peers — a subagent's own message to the agent that started it (SendMessage to its parent) is no peer message.
describe("§52.2 a message of the session's own subagent", () => {
  const fromAgent = { kind: "peer", from: "general-purpose", senderTaskId: AGENT, name: "general-purpose", body: "중간 보고: sub.txt 절반 만들었어요" };

  it("after our turn: no 'message from another session' — the turn the CLI runs for it is ours, its result ends it", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    t.script.push(init());
    await until(() => ofType(t.events, "auto_turn_start").length === 1, "auto turn");
    expect(ofType(t.events, "auto_turn_start")[0]).toMatchObject({ trigger: "continue" });
    t.s.autoTurnReady(true, "tree-A");
    t.script.push({ type: "user", isReplay: true, uuid: "sm-1", session_id: SID, parent_tool_use_id: null, origin: fromAgent, message: { role: "user", content: "…" } });
    t.script.push(result(0.02, { origin: fromAgent }));
    await until(() => ofType(t.events, "turn_end").length === 2, "its turn ends");
    expect(ofType(t.events, "peer_delivered")).toEqual([]);
    expect(ofType(t.events, "unprompted_turn_end")).toEqual([]);
    // Not the agent's end: its call has no result of its own yet.
    expect(ofType(t.events, "tool_result").filter((e) => e.agentEnded)).toEqual([]);
    await t.s.dispose();
  });

  it("an unmarked hand-back frame closes the call with its report, once — no peer card", async () => {
    const t = await withBackgroundAgent();
    await endFirstTurn(t);
    const unmarked = { kind: "peer", from: AGENT, senderTaskId: AGENT, name: "general-purpose", body: `[Subagent hand-back] … The report follows:\n  ${REPORT}` };
    t.script.push({ type: "user", isReplay: true, uuid: "hb-9", session_id: SID, parent_tool_use_id: null, origin: unmarked, message: { role: "user", content: "…" } });
    await until(() => ofType(t.events, "tool_result").some((e) => e.agentEnded), "ended");
    expect(ofType(t.events, "tool_result").filter((e) => e.agentEnded)).toEqual([expect.objectContaining({ toolUseId: CALL, isError: false, preview: REPORT })]);
    expect(ofType(t.events, "peer_delivered")).toEqual([]);
    await t.s.dispose();
  });
});
