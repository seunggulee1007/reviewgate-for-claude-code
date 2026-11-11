import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { changeTimeOf, inWindow, originOf } from "../src/session/provenance.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opts = { signal: new AbortController().signal };

function ctxFor(root: string): HookContext & { events: SessionEvent[]; reported: [string, string[]][] } {
  const events: SessionEvent[] = [];
  const reported: [string, string[]][] = [];
  return {
    budget: new BudgetState({ maxFiles: 50, maxLines: 5000 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    toolWindows: new Map(),
    // File timestamps vs this test's clock: no slack needed, the test sleeps between the steps.
    windowMarginMs: 0,
    onBashFiles: (id, files) => reported.push([id, files.map((f) => basename(f))]),
    emit: (e) => events.push(e),
    log: () => {},
    events,
    reported,
  };
}

const pre = (tool: string, input: Record<string, unknown>, cwd: string, id: string): HookInput =>
  ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd, tool_use_id: id }) as unknown as HookInput;
const post = (tool: string, input: Record<string, unknown>, cwd: string, id: string, extra: Record<string, unknown> = {}): HookInput =>
  ({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: {}, session_id: "s", transcript_path: "", cwd, tool_use_id: id, ...extra }) as unknown as HookInput;
const failure = (tool: string, input: Record<string, unknown>, cwd: string, id: string, extra: Record<string, unknown> = {}): HookInput =>
  ({ hook_event_name: "PostToolUseFailure", tool_name: tool, tool_input: input, error: "Exit code 1", session_id: "s", transcript_path: "", cwd, tool_use_id: id, ...extra }) as unknown as HookInput;

type Hooks = ReturnType<typeof buildHooks>;
const hook = (hooks: Hooks, event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", tool: string) => {
  const matchers = hooks[event] ?? [];
  const m = matchers.find((x) => x.matcher !== undefined && new RegExp(`^(${x.matcher})$`).test(tool)) ?? matchers.find((x) => x.matcher === undefined);
  if (!m) throw new Error(`no ${event} hook for ${tool}`);
  return m.hooks[0]!;
};

describe("Bash attribution is narrowed to the call's execution window (§31)", () => {
  it("a change made between two Bash calls (IDE, another session) is not the next call's, and is not charged to the budget", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = ctxFor(root);
    ctx.checkpointTree = await cp.snapshot();
    const hooks = buildHooks(ctx);

    await hook(hooks, "PreToolUse", "Bash")(pre("Bash", { command: "echo x > other.txt" }, root, "b1"), "b1", opts);
    await sleep(20);
    write(root, "other.txt", "changed by bash\n");
    await hook(hooks, "PostToolUse", "Bash")(post("Bash", { command: "x" }, root, "b1"), "b1", opts);

    // Someone else saves a file while Claude is between calls.
    await sleep(20);
    write(root, "ide.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    await sleep(40);

    await hook(hooks, "PreToolUse", "Bash")(pre("Bash", { command: "touch new.txt" }, root, "b2"), "b2", opts);
    await sleep(20);
    write(root, "new.txt", "x\n");
    await hook(hooks, "PostToolUse", "Bash")(post("Bash", { command: "x" }, root, "b2"), "b2", opts);

    expect(ctx.reported).toEqual([["b1", ["other.txt"]], ["b2", ["new.txt"]]]);
    expect([...ctx.budget.files].map((f) => basename(f)).sort()).toEqual(["new.txt", "other.txt"]);
    // other.txt: -1 +1, new.txt: +1 — the 10 lines of ide.txt are not Claude's.
    expect(ctx.budget.lines).toBe(3);
  });

  it("a failing command (PostToolUseFailure, CLI 2.1.308) is attributed like a successful one", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = ctxFor(root);
    ctx.checkpointTree = await cp.snapshot();
    const hooks = buildHooks(ctx);
    await hook(hooks, "PreToolUse", "Bash")(pre("Bash", { command: "make" }, root, "b1"), "b1", opts);
    await sleep(20);
    write(root, "build.log", "half-written\n");
    await hook(hooks, "PostToolUseFailure", "Bash")(failure("Bash", { command: "make" }, root, "b1"), "b1", opts);
    expect(ctx.reported).toEqual([["b1", ["build.log"]]]);
    expect([...ctx.budget.files].map((f) => basename(f))).toEqual(["build.log"]);
  });

  it("duration_ms moves the window start past a permission card: an edit made while the card was open is not the command's", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = ctxFor(root);
    ctx.checkpointTree = await cp.snapshot();
    const hooks = buildHooks(ctx);
    await hook(hooks, "PreToolUse", "Bash")(pre("Bash", { command: "rm -rf dist" }, root, "b1"), "b1", opts);
    // The card is open; meanwhile the user edits a file in the IDE.
    await sleep(20);
    write(root, "mine.txt", "mine\n");
    await sleep(300); // far beyond the file clock's tick (Windows ~15.6 ms): mine.txt is surely before the window start
    const ran = Date.now();
    write(root, "out.txt", "out\n");
    await sleep(10);
    await hook(hooks, "PostToolUse", "Bash")(post("Bash", { command: "x" }, root, "b1", { duration_ms: Date.now() - ran + 50 }), "b1", opts);
    expect(ctx.reported).toEqual([["b1", ["out.txt"]]]);
  });

  it("MCP calls get a finished execution window with the hook's cwd; Bash windows keep the command", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = ctxFor(root);
    ctx.checkpointTree = await cp.snapshot();
    const hooks = buildHooks(ctx);
    const sub = join(root, "sub");
    await hook(hooks, "PreToolUse", "mcp__idea__replace_text_in_file")(pre("mcp__idea__replace_text_in_file", { pathInProject: "a.txt" }, sub, "m1"), "m1", opts);
    await hook(hooks, "PostToolUse", "mcp__idea__replace_text_in_file")(post("mcp__idea__replace_text_in_file", {}, sub, "m1"), "m1", opts);
    await hook(hooks, "PreToolUse", "mcp__idea__get_file_text")(pre("mcp__idea__get_file_text", {}, root, "m2"), "m2", opts); // never finished (denied / interrupted)
    // `cd sub && …`: the PostToolUse hook reports the new cwd (CLI 2.1.308).
    await hook(hooks, "PreToolUse", "Bash")(pre("Bash", { command: "cd sub && ls" }, root, "b1"), "b1", opts);
    await hook(hooks, "PostToolUse", "Bash")(post("Bash", { command: "cd sub && ls" }, sub, "b1"), "b1", opts);
    const windows = [...ctx.toolWindows!.values()];
    expect(windows.map((w) => [w.toolUseId, w.name, w.cwd, w.cwdAfter, w.command, w.end !== null])).toEqual([
      ["m1", "mcp__idea__replace_text_in_file", sub, undefined, undefined, true],
      ["m2", "mcp__idea__get_file_text", root, undefined, undefined, false],
      ["b1", "Bash", root, sub, "cd sub && ls", true],
    ]);
    for (const w of windows.filter((x) => x.end !== null)) expect(w.end!).toBeGreaterThanOrEqual(w.start);
  });
});

describe("ClaudeSession: failed edits are no cause; turn_end carries the finished windows (§31)", () => {
  type Block = Record<string, unknown>;
  const SID = "s1";
  const assistantBlocks = (id: string, content: Block[]): SDKMessage =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "u",
      session_id: SID,
      message: { id, model: "claude-x", type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }) as unknown as SDKMessage;
  const toolResult = (toolUseId: string, isError: boolean): SDKMessage =>
    ({ type: "user", parent_tool_use_id: null, uuid: "u", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "x", is_error: isError }] } }) as unknown as SDKMessage;
  const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
  const result = { type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage;

  it("an edit whose tool_result is an error (denied, old_string not found) keeps its tool name but not its tool_use id", () => {
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
    });
    const internals = s as unknown as { setTurnActive(a: boolean): void; handleSdkMessage(m: SDKMessage): void; hookCtx: HookContext };
    internals.setTurnActive(true);
    internals.hookCtx.toolWindows!.set("b1", { toolUseId: "b1", name: "Bash", start: 10, end: 20, command: "ls" });
    internals.hookCtx.toolWindows!.set("m1", { toolUseId: "m1", name: "mcp__x__y", start: 30, end: null });
    const [a, b] = [resolve("/tmp/a.ts"), resolve("/tmp/b.ts")];
    internals.handleSdkMessage(assistantBlocks("m1", [toolUse("e1", "Edit", { file_path: "/tmp/a.ts" }), toolUse("e2", "Write", { file_path: "/tmp/b.ts" })]));
    internals.handleSdkMessage(toolResult("e1", true));
    internals.handleSdkMessage(toolResult("e2", false));
    internals.handleSdkMessage(result);
    const end = events.find((e) => e.type === "turn_end") as Extract<SessionEvent, { type: "turn_end" }>;
    const byPath = Object.fromEntries(end.toolFiles.map((f) => [f.path, f]));
    expect(byPath[a]).toEqual({ path: a, tools: ["Edit"], count: 1, toolUseIds: [] });
    expect(byPath[b]).toEqual({ path: b, tools: ["Write"], count: 1, toolUseIds: ["e2"] });
    expect(end.toolWindows).toEqual([{ toolUseId: "b1", name: "Bash", start: 10, end: 20, command: "ls" }]);
    // The windows are per turn.
    expect(internals.hookCtx.toolWindows!.size).toBe(0);
  });
});

describe("provenance helpers", () => {
  it("originOf: a successful edit / MCP call → tool, Bash → bash, no tool_use id (Read, failed edit) → external", () => {
    expect(originOf({ tools: ["Edit", "Read"], toolUseIds: ["e1"] })).toBe("tool");
    expect(originOf({ tools: ["mcp__idea__replace_text_in_file"], toolUseIds: ["m1"] })).toBe("tool");
    expect(originOf({ tools: ["Bash"], toolUseIds: ["b1"] })).toBe("bash");
    expect(originOf({ tools: ["Read"], toolUseIds: [] })).toBe("external");
    expect(originOf({ tools: ["Edit"], toolUseIds: [] })).toBe("external");
    expect(originOf({ tools: [], toolUseIds: [] })).toBe("external");
    // Reviews persisted before toolUseIds existed (§12): the tool names decide.
    expect(originOf({ tools: ["Write"] })).toBe("tool");
    expect(originOf({ tools: [] })).toBe("external");
  });

  it("changeTimeOf: a file's ctime; a deleted file → its nearest existing directory; inWindow honours the margin", async () => {
    const root = track(makeRepo());
    const before = Date.now();
    await sleep(5);
    write(root, "d/x.txt", "x\n");
    const t = await changeTimeOf(join(root, "d/x.txt"), root);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(before - 50);
    expect(await changeTimeOf(resolve(root, "d/gone/deeper.txt"), root)).toBeGreaterThanOrEqual(before - 50);
    expect(inWindow(1000, { start: 1200, end: 2000 }, 0)).toBe(false);
    expect(inWindow(1000, { start: 1200, end: 2000 }, 500)).toBe(true);
    expect(inWindow(2050, { start: 1200, end: 2000 }, 0)).toBe(true); // end slack
    expect(inWindow(2500, { start: 1200, end: 2000 }, 0)).toBe(false);
    expect(inWindow(1500, { start: 1200, end: null }, 0)).toBe(false);
  });
});
