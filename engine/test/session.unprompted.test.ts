import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { UNPROMPTED_NOTICE } from "../src/engine.js";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, READ_ONLY_BASH_REASON, UNPROMPTED_AGENT_REASON, UNPROMPTED_REASON, unpromptedBlocked, type HookContext } from "../src/session/hooks.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §18: Claude Code can run a turn on its own (a background task finished, the CLI
 * continues without a user message). Nothing collects such a turn into the review, so the session
 * denies every non-read-only tool outside an engine-started turn and never reports its `result`
 * as a turn_end. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 avoids most of these turns; the guard is
 * what protects when the user's environment turns background tasks back on.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };
const SID = "s1";

function preToolUse(toolName: string, toolInput: Record<string, unknown>, cwd = "/tmp"): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: "t1" } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

/** Runs every PreToolUse hook whose matcher takes `toolName` (as the CLI does); the first deny wins. */
async function runPre(hooks: ReturnType<typeof buildHooks>, toolName: string, input: Record<string, unknown>): Promise<{ decision?: string; reason?: string }> {
  let out: { decision?: string; reason?: string } = {};
  for (const m of hooks.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const d = decision(await (h as HookCallback)(preToolUse(toolName, input), "t1", opts));
      if (d.decision === "deny") return d;
      if (d.decision) out = d;
    }
  }
  return out;
}

describe("unprompted-turn guard (hooks)", () => {
  it("outside a turn only read-only tools and auto-allowed read-only Bash pass", () => {
    const off = { turnActive: false };
    for (const t of ["Read", "Glob", "Grep", "TodoWrite", "Skill"]) expect(unpromptedBlocked(t, {}, off), t).toBe(false);
    expect(unpromptedBlocked("Bash", { command: "git status" }, off)).toBe(false);
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "WebFetch", "mcp__x__y", "ExitPlanMode"]) {
      expect(unpromptedBlocked(t, { file_path: "/tmp/a" }, off), t).toBe(true);
    }
    for (const cmd of ["rm -rf x", "npm test", "echo x > a", "git status && touch a"]) expect(unpromptedBlocked("Bash", { command: cmd }, off), cmd).toBe(true);
    // With the read-only rule off, a read-only command would need a card: blocked as well.
    expect(unpromptedBlocked("Bash", { command: "ls" }, { turnActive: false, autoAllowReadOnlyBash: false })).toBe(true);
    // In a turn (and in contexts that never set it) the guard does not apply.
    expect(unpromptedBlocked("Edit", {}, { turnActive: true })).toBe(false);
    expect(unpromptedBlocked("Edit", {}, {})).toBe(false);
  });

  it("the PreToolUse hooks deny with the reason, report it once per call and leave the budget alone", async () => {
    const blocked: string[] = [];
    const events: SessionEvent[] = [];
    const ctx: HookContext = {
      budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
      cwd: "/tmp",
      root: "/tmp",
      ignorePatterns: [],
      autoAllowTools: new Set(["WebFetch"]),
      turnActive: false,
      onUnprompted: (t) => blocked.push(t),
      emit: (e) => events.push(e),
      log: () => {},
    };
    const hooks = buildHooks(ctx);
    expect(await runPre(hooks, "Write", { file_path: "/tmp/rg-unprompted/a.txt", content: "x\n" })).toEqual({ decision: "deny", reason: UNPROMPTED_REASON });
    expect(await runPre(hooks, "Bash", { command: "rm -f a.txt" })).toEqual({ decision: "deny", reason: UNPROMPTED_REASON });
    // Even a tool the user auto-allows: nothing runs unprompted unless it is read-only.
    expect(await runPre(hooks, "WebFetch", { url: "https://example.com" })).toEqual({ decision: "deny", reason: UNPROMPTED_REASON });
    expect(await runPre(hooks, "Bash", { command: "git status" })).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    expect(await runPre(hooks, "Read", { file_path: "/tmp/a" })).toEqual({});
    expect(blocked).toEqual(["Write", "Bash", "WebFetch"]);
    expect(ctx.budget.files.size).toBe(0);
    expect(ctx.budget.lines).toBe(0);
    expect(events).toEqual([]);
  });
});

// ------------------------------------------------------------------ ClaudeSession with a scripted SDK

type Script = { options: Options | undefined; push: (m: SDKMessage) => void; end: () => void };

/** A fake `query` whose messages the test pushes one by one (the CLI's stdout). */
function scriptedSdk(): { queryFn: (args: { options?: Options }) => Query; script: Script } {
  const script: Script = { options: undefined, push: () => {}, end: () => {} };
  const queryFn = (args: { options?: Options }): Query => {
    script.options = args.options;
    const queue: SDKMessage[] = [];
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
        return m ? { done: false, value: m } : { done: true, value: undefined };
      },
      async return() {
        script.end();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => undefined,
    };
    return q as unknown as Query;
  };
  return { queryFn, script };
}

const toolUse = (msgId: string, id: string, name: string, input: Record<string, unknown>): SDKMessage =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: SID,
    message: { id: msgId, model: "claude-x", type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  }) as unknown as SDKMessage;
const resultMsg = (totalCostUsd: number): SDKMessage =>
  ({ type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: totalCostUsd }) as unknown as SDKMessage;

const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("unprompted turn with background tasks re-enabled (scripted SDK)", () => {
  it("an explicit falsy CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is kept; tools after the result are denied and the CLI's own result is no turn_end", async () => {
    const { queryFn, script } = scriptedSdk();
    const events: SessionEvent[] = [];
    const logs: string[] = [];
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" },
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: (level, m) => logs.push(`${level}: ${m}`),
      queryFn: queryFn as never,
    });
    await s.start();
    expect(script.options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("0");
    const hooks = script.options!.hooks!;
    const canUseTool = script.options!.canUseTool as CanUseTool;
    const turnEnds = () => events.filter((e): e is Extract<SessionEvent, { type: "turn_end" }> => e.type === "turn_end");

    // Before any send: nothing may change.
    expect((await runPre(hooks, "Write", { file_path: "/tmp/rg-unprompted/x.txt", content: "x" })).decision).toBe("deny");

    // 1) The user's turn: an Agent call (backgrounded by the CLI) and a regular edit are allowed.
    s.sendUser("do it", undefined);
    expect(s.isTurnActive).toBe(true);
    expect((await runPre(hooks, "Agent", { description: "helper", prompt: "p" })).reason).not.toBe(UNPROMPTED_REASON);
    expect(await canUseTool("Write", { file_path: "/tmp/rg-unprompted/a.txt", content: "a" }, { ...opts, suggestions: [], toolUseID: "w0" } as never)).toMatchObject({ behavior: "allow" });
    script.push(toolUse("m1", "w0", "Write", { file_path: "/tmp/rg-unprompted/a.txt", content: "a" }));
    script.push(resultMsg(0.01));
    await until(() => turnEnds().length === 1, "first turn_end");
    expect(turnEnds()[0]!.usage.costUsd).toBeCloseTo(0.01);
    expect(s.isTurnActive).toBe(false);

    // 2) The background subagent finishes; the CLI continues on its own and tries to edit.
    script.push(toolUse("m2", "w1", "Edit", { file_path: "/tmp/rg-unprompted/a.txt", old_string: "a", new_string: "b" }));
    expect(await runPre(hooks, "Edit", { file_path: "/tmp/rg-unprompted/a.txt", old_string: "a", new_string: "b" })).toEqual({ decision: "deny", reason: UNPROMPTED_REASON });
    expect(await runPre(hooks, "Bash", { command: "echo b > /tmp/rg-unprompted/a.txt" })).toEqual({ decision: "deny", reason: UNPROMPTED_REASON });
    expect(await runPre(hooks, "Bash", { command: "git diff --stat" })).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    // The canUseTool safety net says the same, should the CLI reach it.
    expect(await canUseTool("Write", { file_path: "/tmp/rg-unprompted/a.txt", content: "z" }, { ...opts, suggestions: [], toolUseID: "w2" } as never)).toEqual({ behavior: "deny", message: UNPROMPTED_REASON });
    script.push(resultMsg(0.03));
    await until(() => events.some((e) => e.type === "unprompted_turn_end"), "unprompted_turn_end");

    expect(turnEnds()).toHaveLength(1);
    expect(events.filter((e) => e.type === "unprompted_denied")).toEqual([
      { type: "unprompted_denied", toolName: "Write" },
      { type: "unprompted_denied", toolName: "Edit" },
      { type: "unprompted_denied", toolName: "Bash" },
      { type: "unprompted_denied", toolName: "Write" },
    ]);
    expect(events.at(-2)).toEqual({ type: "activity", kind: "idle" });
    expect(logs.some((l) => l.startsWith("warn: result (success) without a user turn ignored"))).toBe(true);

    // 3) The next send is a normal turn again; the unprompted turn's cost lands in its delta.
    s.sendUser("next", undefined);
    expect((await runPre(hooks, "Write", { file_path: "/tmp/rg-unprompted/c.txt", content: "c" })).reason).not.toBe(UNPROMPTED_REASON);
    script.push(resultMsg(0.05));
    await until(() => turnEnds().length === 2, "second turn_end");
    expect(turnEnds()[1]!.usage.costUsd).toBeCloseTo(0.04);
    // The unprompted Edit (w1) never reaches a later turn's tool files.
    expect(turnEnds()[1]!.toolFiles).toEqual([]);
    await s.dispose();
  });
});

describe("subagent call inside a CLI-initiated turn (scripted SDK)", () => {
  it("a subagent's Edit after the user's turn ended is denied by the hooks and canUseTool, like a main-agent call", async () => {
    const { queryFn, script } = scriptedSdk();
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "" },
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
      queryFn: queryFn as never,
    });
    await s.start();
    const hooks = script.options!.hooks!;
    const canUseTool = script.options!.canUseTool as CanUseTool;
    s.sendUser("delegate it", undefined);
    script.push(toolUse("m1", "agent-1", "Agent", { description: "helper", prompt: "edit a.txt", subagent_type: "general-purpose" }));
    script.push(resultMsg(0.01));
    await until(() => events.some((e) => e.type === "turn_end"), "turn_end");
    expect(s.isTurnActive).toBe(false);

    // The (backgrounded) subagent keeps going after the main turn's result: its Edit carries the Agent call as parent.
    const subEdit = { ...(toolUse("m2", "sub-w1", "Edit", { file_path: "/tmp/rg-unprompted/a.txt", old_string: "a", new_string: "b" }) as object), parent_tool_use_id: "agent-1" } as SDKMessage;
    script.push(subEdit);
    await until(() => events.some((e) => e.type === "tool_use" && e.id === "sub-w1"), "subagent tool_use");
    expect(events.find((e) => e.type === "tool_use" && e.id === "sub-w1")).toMatchObject({ parentToolUseId: "agent-1" });
    const input = { file_path: "/tmp/rg-unprompted/a.txt", old_string: "a", new_string: "b" };
    let denied: { decision?: string; reason?: string } = {};
    for (const m of hooks.PreToolUse!) {
      if (m.matcher && !new RegExp(`^(${m.matcher})$`).test("Edit")) continue;
      for (const h of m.hooks) {
        const hookInput = { ...(preToolUse("Edit", input) as object), agent_id: "sub-agent-1", agent_type: "general-purpose", tool_use_id: "sub-w1" } as unknown as HookInput;
        const d = decision(await (h as HookCallback)(hookInput, "sub-w1", opts));
        if (d.decision === "deny") {
          denied = d;
          break;
        }
      }
      if (denied.decision) break;
    }
    // r2-peers: a subagent is not told to "stop and wait" (that ended its whole run) — it reports what was left undone.
    expect(denied).toEqual({ decision: "deny", reason: UNPROMPTED_AGENT_REASON });
    expect(UNPROMPTED_AGENT_REASON).not.toMatch(/stop and wait/);
    expect(await canUseTool("Edit", input, { ...opts, suggestions: [], toolUseID: "sub-w1", agentID: "sub-agent-1" } as never)).toEqual({ behavior: "deny", message: UNPROMPTED_AGENT_REASON });
    expect(events.filter((e) => e.type === "unprompted_denied").map((e) => (e as { toolName: string }).toolName)).toEqual(["Edit", "Edit"]);
    script.push(resultMsg(0.02));
    await until(() => events.some((e) => e.type === "unprompted_turn_end"), "unprompted_turn_end");
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    await s.dispose();
  });
});

// ------------------------------------------------------------------ engine

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-unprompted"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "one\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("engine: unprompted turns (§18)", () => {
  it("one session-scoped banner per episode; a stray turn_end / the CLI's own result leave turnCount, cost and the gate alone", async () => {
    const dir = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "go" });
    write(dir, "README.md", "two\n");
    h.session().emitTurnEnd({ usage: { costUsd: 0.5 } });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.hud.turnCount === 1, "review");
    await h.settle();
    const before = h.engine.state;
    const errorsBefore = h.ofType("error").length;

    h.session().emit({ type: "unprompted_denied", toolName: "Edit" });
    h.session().emit({ type: "unprompted_denied", toolName: "Bash" });
    h.session().emit({ type: "text_delta", text: "Background task finished; updating." });
    h.session().emit({ type: "unprompted_turn_end", sessionId: before.session.sessionId ?? "" });
    // A turn_end with no running turn (e.g. from a session that did not know better) is ignored too.
    h.session().emitTurnEnd({ usage: { costUsd: 9 } });
    await h.settle();

    const banners = h.ofType("error").slice(errorsBefore);
    expect(banners).toEqual([{ type: "error", message: UNPROMPTED_NOTICE, fatal: false, scope: "session", code: "unprompted_blocked" }]);
    const after = h.engine.state;
    expect(after.hud.turnCount).toBe(1);
    expect(after.hud.sessionCostUSD).toBeCloseTo(before.hud.sessionCostUSD);
    expect(after.gate.phase).toBe("reviewing");
    expect([after.gate.turnStartTree, after.gate.turnEndTree, after.gate.pendingCount]).toEqual([before.gate.turnStartTree, before.gate.turnEndTree, before.gate.pendingCount]);
    expect(after.changedFiles.map((f) => f.path)).toEqual(before.changedFiles.map((f) => f.path));
    expect(after.hud.activity).toEqual({ kind: "idle" });
    expect(h.ofType("turn_end")).toHaveLength(1);

    // A second episode gets its own banner.
    h.session().emit({ type: "unprompted_denied", toolName: "Write" });
    await h.settle();
    expect(h.ofType("error").slice(errorsBefore)).toHaveLength(2);
  });

  it("text Claude writes in an unprompted turn is streamed and persisted as unprompted, apart from the user's turns", async () => {
    const dir = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "go" });
    h.session().emit({ type: "text_delta", text: "Done with your request." });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.hud.turnCount === 1 && s.gate.phase !== "collecting", "turn 1");
    // The CLI continues on its own.
    h.session().emit({ type: "text_delta", text: "Background task finished; " });
    h.session().emit({ type: "text_delta", text: "updating." });
    h.session().emit({ type: "unprompted_turn_end", sessionId: "" });
    // Text that arrives unprompted and is followed by a send without its own end is still its own row.
    h.session().emit({ type: "text_delta", text: "Another note." });
    await h.engine.handle({ type: "send", text: "next" });
    h.session().emit({ type: "text_delta", text: "Answer." });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.hud.turnCount === 2 && s.gate.phase !== "collecting", "turn 2");
    await h.settle();
    expect(h.ofType("text_delta").map((e) => [e.text, e.unprompted ?? false])).toEqual([
      ["Done with your request.", false],
      ["Background task finished; ", true],
      ["updating.", true],
      ["Another note.", true],
      ["Answer.", false],
    ]);
    await h.engine.dispose();
    const b = makeHarness();
    harnesses.push(b);
    await b.hello();
    await b.open(dir);
    await b.settle();
    const rows = b.ofType("transcript_restore").at(-1)!.items.filter((i) => i.kind === "assistant_text");
    expect(rows.map((r) => [r.kind === "assistant_text" ? r.text : "", "unprompted" in r ? r.unprompted : undefined])).toEqual([
      ["Done with your request.", undefined],
      ["Background task finished; updating.", true],
      ["Another note.", true],
      ["Answer.", undefined],
    ]);
  });
});
