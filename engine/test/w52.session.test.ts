import { describe, expect, it } from "vitest";
import type { HookCallback, HookInput, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type SessionSettings } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { UNPROMPTED_REASON } from "../src/session/hooks.js";
import { outputPathOf, taskKind } from "../src/session/background.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §52 at the session level, with the frames CLI 2.1.318 sends (verified over stream-json, haiku):
 * a background Bash call (`task_started {is_backgrounded}`, the result naming its output file, `background_tasks_changed`,
 * `task_notification`), the turn the CLI then runs itself (`system/init`, no lifecycle frame, `result.origin`), a `/loop`
 * run (`command_lifecycle started` with `wakeup_source`); Agent calls keep their input (§52.2, w52.agents.test.ts).
 */

const SID = "s1";
const opts = { signal: new AbortController().signal };

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
const init = () => sys("init", { model: "claude-haiku", permissionMode: "default", cwd: "/tmp", tools: [], mcp_servers: [], slash_commands: [], skills: [], plugins: [] });
const lifecycle = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ type: "command_lifecycle", command_uuid: id, state, uuid: `l-${state}-${id}`, session_id: SID, ...extra });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant", parent_tool_use_id: null, uuid: `a-${id}`, session_id: SID,
  message: { id: `m-${id}`, model: "claude-x", type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
});
const toolResult = (id: string, text: string) => ({ type: "user", parent_tool_use_id: null, session_id: SID, uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] } });
const result = (cost: number, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 2, output_tokens: 3 }, duration_ms: 7, total_cost_usd: cost, is_error: false, result: "", ...extra });
const OUT = "/private/tmp/claude-501/-tmp/1c65aea0/tasks/b35tmk0c1.output";

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
}
type PreOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
/** The first PreToolUse answer with a decision or an input change (deny wins), like the CLI folds them. */
async function pre(script: Script, toolName: string, input: Record<string, unknown>): Promise<PreOut["hookSpecificOutput"] | "pass"> {
  for (const m of script.options!.hooks!.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const out = (await (h as HookCallback)(preToolUse(toolName, input), "t1", opts)) as PreOut;
      if (out.hookSpecificOutput?.permissionDecision === "deny" || out.hookSpecificOutput?.updatedInput) return out.hookSpecificOutput;
    }
  }
  return "pass";
}

/** Started, initialized, one turn of ours done (a turn the CLI starts before that is never taken). */
async function afterOneTurn(over: Partial<SessionSettings> = {}) {
  const t = session(over);
  await t.s.start();
  await until(() => ofType(t.events, "session_ready").length === 1, "ready");
  t.s.sendUser("빌드 돌려줘", "tree-0");
  return t;
}

describe("§52 helpers", () => {
  it("taskKind and the output file a background Bash result names", () => {
    expect([taskKind("local_bash"), taskKind("local_agent"), taskKind("monitor_mcp"), taskKind("workflow"), taskKind(undefined)]).toEqual(["bash", "agent", "monitor", "other", "other"]);
    expect(outputPathOf(`Command running in background with ID: b35tmk0c1. Output is being written to: ${OUT}`)).toBe(OUT);
    expect(outputPathOf("hello")).toBeNull();
    // CLI 2.1.318 goes on after the path on the same line.
    expect(outputPathOf(`Command running in background with ID: bm80i4svq. Output is being written to: ${OUT}. You will be notified when it completes. To check interim output, use Read.`)).toBe(OUT);
    expect(outputPathOf("Output is being written to: /tmp/My Folder/tasks/b1.output\nmore")).toBe("/tmp/My Folder/tasks/b1.output");
  });
});

describe("§52 background Bash and the turn the CLI runs after it", () => {
  it("lists the task, then takes the notification turn: its calls wait for the engine, its result is a turn_end", async () => {
    const { s, events, script } = await afterOneTurn();
    expect(s.backgroundWorkOn).toBe(true);
    expect(script.options!.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    script.push(init());
    script.push(toolUse("toolu_bg", "Bash", { command: "sleep 10; echo done > bg.txt", run_in_background: true }));
    script.push(sys("background_tasks_changed", { tasks: [{ task_id: "b35tmk0c1", task_type: "local_bash", description: "Run sleep then write done" }] }));
    script.push(sys("task_started", { task_id: "b35tmk0c1", tool_use_id: "toolu_bg", description: "Run sleep then write done", is_backgrounded: true, task_type: "local_bash" }));
    script.push(toolResult("toolu_bg", `Command running in background with ID: b35tmk0c1. Output is being written to: ${OUT}`));
    script.push(result(0.01));
    await until(() => ofType(events, "turn_end").length === 1, "turn 1 ends");
    expect(ofType(events, "background_tasks").at(-1)!.tasks).toEqual([
      { taskId: "b35tmk0c1", kind: "bash", description: "Run sleep then write done", toolUseId: "toolu_bg", turn: null, startedAt: expect.any(String), hasOutput: true },
    ]);
    expect(s.taskOutputFile("b35tmk0c1")).toBe(OUT);
    expect(s.isTaskLive("b35tmk0c1")).toBe(true);

    // The command ends; the CLI goes on by itself (no lifecycle frame).
    script.push(sys("task_updated", { task_id: "b35tmk0c1", patch: { status: "completed", end_time: 1 } }));
    script.push(sys("task_notification", { task_id: "b35tmk0c1", tool_use_id: "toolu_bg", status: "completed", output_file: OUT, summary: "Background command \"Run sleep then write done\" completed (exit code 0)" }));
    script.push(sys("background_tasks_changed", { tasks: [] }));
    script.push(init());
    await until(() => ofType(events, "auto_turn_start").length === 1, "auto turn");
    expect(ofType(events, "auto_turn_start")[0]).toEqual({
      type: "auto_turn_start", trigger: "background",
      task: { taskId: "b35tmk0c1", description: "Run sleep then write done", status: "completed", summary: "Background command \"Run sleep then write done\" completed (exit code 0)", kind: "bash", toolUseId: "toolu_bg" },
    });
    expect(ofType(events, "background_tasks").at(-1)!.tasks).toEqual([]);
    expect(s.isTurnActive).toBe(true);
    // A call waits until the engine took the turn (snapshot A first) — then it passes.
    let decided: unknown = null;
    void pre(script, "Write", { file_path: "/tmp/fix.txt", content: "x" }).then((d) => (decided = d));
    await new Promise((r) => setTimeout(r, 30));
    expect(decided).toBeNull();
    s.autoTurnReady(true, "tree-A");
    await until(() => decided !== null, "decided");
    expect(decided).toBe("pass");
    script.push(result(0.02, { origin: { kind: "task-notification", producer: "session-task", runId: "r1" } }));
    await until(() => ofType(events, "turn_end").length === 2, "the auto turn ends");
    expect(ofType(events, "unprompted_turn_end")).toEqual([]);
    expect(s.isTurnActive).toBe(false);
    await s.dispose();
  });

  it("a /loop run (lifecycle started with wakeup_source) is offered; refused, §18 applies and it is someone else's command", async () => {
    const { s, events, script } = await afterOneTurn();
    script.push(result(0.01));
    await until(() => ofType(events, "turn_end").length === 1, "turn 1 ends");
    script.push(lifecycle("cron-1", "started", { wakeup_source: "schedule_wakeup" }));
    await until(() => ofType(events, "auto_turn_start").length === 1, "auto turn");
    expect(ofType(events, "auto_turn_start")[0]).toEqual({ type: "auto_turn_start", trigger: "schedule", commandUuid: "cron-1", wakeupSource: "schedule_wakeup" });
    script.push(init()); // the run's own init: no second offer
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(events, "auto_turn_start")).toHaveLength(1);
    s.autoTurnReady(false);
    expect(ofType(events, "external_turn").at(-1)).toEqual({ type: "external_turn", running: true, commandUuid: "cron-1" });
    expect(await pre(script, "Write", { file_path: "/tmp/x", content: "x" })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: UNPROMPTED_REASON });
    script.push(result(0.02));
    script.push(lifecycle("cron-1", "completed"));
    await until(() => ofType(events, "unprompted_turn_end").length === 1, "unprompted end");
    expect(ofType(events, "turn_end")).toHaveLength(1);
    await s.dispose();
  });

  it("a short answer that ends before the engine is ready stays ended", async () => {
    const { s, events, script } = await afterOneTurn();
    script.push(result(0.01));
    await until(() => ofType(events, "turn_end").length === 1, "turn 1 ends");
    script.push(init());
    await until(() => ofType(events, "auto_turn_start").length === 1, "auto turn");
    script.push(result(0.02));
    await until(() => ofType(events, "turn_end").length === 2, "ended");
    s.autoTurnReady(true, "tree-A");
    expect(s.isTurnActive).toBe(false);
    expect(await pre(script, "Write", { file_path: "/tmp/x", content: "x" })).toMatchObject({ permissionDecision: "deny" });
    await s.dispose();
  });

  it("never before a turn of ours, and never with background work off (§18 as before)", async () => {
    const fresh = session();
    await fresh.s.start();
    await until(() => ofType(fresh.events, "session_ready").length === 1, "ready");
    fresh.script.push(init());
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(fresh.events, "auto_turn_start")).toEqual([]);
    await fresh.s.dispose();

    const off = await afterOneTurn({ backgroundWork: false });
    expect(off.script.options!.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    off.script.push(result(0.01));
    await until(() => ofType(off.events, "turn_end").length === 1, "turn 1 ends");
    off.script.push(init());
    off.script.push(lifecycle("cron-1", "started", { wakeup_source: "schedule_wakeup" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType(off.events, "auto_turn_start")).toEqual([]);
    expect(await pre(off.script, "Write", { file_path: "/tmp/x", content: "x" })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: UNPROMPTED_REASON });
    await off.s.dispose();
  });

  // MARK: r2-peers — a turn Claude starts right after a restart or a chat switch of a chat that had turns.
  it("a resumed conversation that had turns takes a turn Claude starts at once; a resumed one without turns does not", async () => {
    const resumed = session({ resumeSessionId: "s0", resumedWithTurns: true });
    await resumed.s.start();
    await until(() => ofType(resumed.events, "session_ready").length === 1, "ready");
    resumed.script.push(init());
    await until(() => ofType(resumed.events, "auto_turn_start").length === 1, "taken");
    expect(ofType(resumed.events, "auto_turn_start")[0]).toMatchObject({ trigger: "continue" });
    await resumed.s.dispose();

    for (const over of [{ resumeSessionId: "s0" }, { resumedWithTurns: true }] as Partial<SessionSettings>[]) {
      const t = session(over);
      await t.s.start();
      await until(() => ofType(t.events, "session_ready").length === 1, "ready");
      t.script.push(init());
      await new Promise((r) => setTimeout(r, 20));
      expect(ofType(t.events, "auto_turn_start"), JSON.stringify(over)).toEqual([]);
      await t.s.dispose();
    }
  });

  it("a dispose while a turn is being taken releases the waiting calls (denied)", async () => {
    const { s, events, script } = await afterOneTurn();
    script.push(result(0.01));
    await until(() => ofType(events, "turn_end").length === 1, "turn 1 ends");
    script.push(init());
    await until(() => ofType(events, "auto_turn_start").length === 1, "auto turn");
    const waiting = pre(script, "Write", { file_path: "/tmp/x", content: "x" });
    await s.dispose();
    expect(await waiting).toMatchObject({ permissionDecision: "deny" });
  });
});

describe("§52 Agent calls", () => {
  it("keep their input by default (§52.2: subagents run as in the terminal; w52.agents.test.ts covers subagentsInTurn)", async () => {
    const on = await afterOneTurn();
    expect(await pre(on.script, "Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" })).toBe("pass");
    await on.s.dispose();
    const off = await afterOneTurn({ backgroundWork: false });
    expect(await pre(off.script, "Agent", { description: "d", prompt: "p", run_in_background: true })).toBe("pass");
    await off.s.dispose();
  });
});
