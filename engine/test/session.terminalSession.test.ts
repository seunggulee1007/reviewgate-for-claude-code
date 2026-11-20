import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import type { SessionEvent } from "../src/session/events.js";
import { RETIRED_REASON } from "../src/session/hookServer.js";
import { UNPROMPTED_REASON } from "../src/session/hooks.js";
import { ADOPT_BUSY_REASON, BACKGROUND_PROMPT_REASON, BACKGROUND_TOOL_REASON, configDirOfTranscript, STOP_FEEDBACK_PREFIX, PROMPT_TIMEOUT_REASON, TerminalSession, type PromptAnswer } from "../src/session/terminalSession.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

// docs/PROTOCOL.md §57.4: how a terminal chat's hooks become review-turn events.

const dirs: string[] = [];
const sessions: TerminalSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-term"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

type Rig = { ts: TerminalSession; events: SessionEvent[]; dir: string; of: <T extends SessionEvent["type"]>(t: T) => Extract<SessionEvent, { type: T }>[]; hook: (input: Record<string, unknown>) => Promise<Record<string, unknown>>; tree: () => Promise<string> };

/** `answer`: how the fake engine answers `terminal_prompt` (null: it does not — the test answers). */
function rig(opts: { answer?: ((ev: Extract<SessionEvent, { type: "terminal_prompt" }>, tree: string) => PromptAnswer) | null; promptWaitMs?: number; adoptWaitMs?: number } = {}): Rig {
  const dir = makeRepo();
  const events: SessionEvent[] = [];
  let ts!: TerminalSession;
  const tree = async (): Promise<string> => (await openCheckpoint(dir)).snapshot();
  const answer = opts.answer === undefined ? (_ev: unknown, t: string): PromptAnswer => ({ ok: true, additionalContext: null, checkpointTree: t }) : opts.answer;
  ts = new TerminalSession({
    chatId: "chat-1",
    cliSessionId: "chat-1",
    cwd: dir,
    ignorePatterns: [],
    promptWaitMs: opts.promptWaitMs ?? 5000,
    adoptWaitMs: opts.adoptWaitMs ?? 5000,
    plansDir: join(dir, ".no-plans"),
    windowMarginMs: 60_000,
    emit: (ev) => {
      events.push(ev);
      if (ev.type === "terminal_prompt" && answer) void tree().then((t) => ts.answerPrompt(ev.seq, answer(ev, t)));
    },
    log: () => undefined,
  });
  sessions.push(ts);
  const of = <T extends SessionEvent["type"]>(t: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === t);
  const base = { session_id: "chat-1", cwd: dir, permission_mode: "default", transcript_path: "/dev/null" };
  return { ts, events, dir, of, tree, hook: (input) => ts.handleHook({ ...base, ...input }) };
}

const ups = (promptId: string, prompt = "do it") => ({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId });
const pre = (tool: string, input: Record<string, unknown>, id: string, promptId = "p1") => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id, prompt_id: promptId });
const post = (tool: string, input: Record<string, unknown>, id: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { ok: true }, ...extra });

describe("TerminalSession", () => {
  it("start() reports ready; the TUI's own commands are no-ops; sendUser is refused", async () => {
    const r = rig();
    await r.ts.start();
    expect(r.of("session_ready")).toHaveLength(1);
    expect(() => r.ts.sendUser("x")).toThrow(/terminal_chat/);
    await r.ts.interrupt();
    expect(r.ts.state).toEqual({ running: false, hooksSeen: false, promptId: null, waiting: null, interruptSuspected: false });
    r.ts.started(4242);
    expect(r.ts.pid).toBe(4242);
    expect(r.ts.state.running).toBe(true);
  });

  it("UserPromptSubmit waits for the engine's answer: context, block, timeout", async () => {
    const r = rig({ answer: (ev, t) => (ev.prompt === "no" ? { ok: false, reason: "busy" } : { ok: true, additionalContext: ev.prompt === "ctx" ? "[Review gate] Accepted: a." : null, checkpointTree: t }) });
    expect(await r.hook(ups("p1", "ctx"))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "[Review gate] Accepted: a." } });
    expect(r.of("terminal_prompt")).toEqual([{ type: "terminal_prompt", prompt: "ctx", promptId: "p1", seq: 1 }]);
    expect(r.ts.state).toMatchObject({ hooksSeen: true, promptId: "p1" });
    expect(r.ts.isTurnActive).toBe(true);
    await r.hook({ hook_event_name: "Stop" });
    expect(r.ts.isTurnActive).toBe(false);
    expect(await r.hook(ups("p2", "plain"))).toEqual({});
    await r.hook({ hook_event_name: "Stop" });
    expect(await r.hook(ups("p3", "no"))).toEqual({ decision: "block", reason: "busy" });
    expect(r.ts.isTurnActive).toBe(false);

    const slow = rig({ answer: null, promptWaitMs: 50 });
    expect(await slow.hook(ups("p1"))).toEqual({ decision: "block", reason: PROMPT_TIMEOUT_REASON });
    expect(slow.ts.isTurnActive).toBe(false);
    // The engine opened the turn after all: it ends at once (the prompt never ran).
    expect(slow.ts.answerPrompt(1, { ok: true, additionalContext: null, checkpointTree: await slow.tree() })).toBe(false);
    expect(slow.of("turn_end").map((e) => e.stopReason)).toEqual(["prompt_timeout"]);
  });

  it("the CLI giving up on a prompt's hook (abort) blocks its wait at once; the engine's late answer ends the turn it opened", async () => {
    const r = rig({ answer: null });
    const cancelled = new AbortController();
    const pending = r.ts.handleHook({ session_id: "chat-1", cwd: r.dir, ...ups("p1") }, cancelled.signal);
    await new Promise((res) => setTimeout(res, 10));
    cancelled.abort();
    // At once, not after the 5 s wait.
    expect(await Promise.race([pending, new Promise((res) => setTimeout(() => res("still waiting"), 1000))])).toMatchObject({ decision: "block" });
    expect(r.ts.answerPrompt(r.of("terminal_prompt")[0]!.seq, { ok: true, additionalContext: null, checkpointTree: await r.tree() })).toBe(false);
    expect(r.of("turn_end").map((e) => e.stopReason)).toEqual(["prompt_timeout"]);
    expect(r.ts.isTurnActive).toBe(false);
  });

  it("an answer reaches only its own prompt: a stale one (an earlier seq) never settles the prompt waiting now", async () => {
    const r = rig({ answer: null });
    const first = r.hook(ups("p1", "first"));
    await new Promise((res) => setTimeout(res, 10));
    // The CLI gave up on p1 and sent p2 (or a forged hook did): p1 is blocked, p2 waits for its own answer.
    const second = r.hook(ups("p2", "second"));
    await new Promise((res) => setTimeout(res, 10));
    expect(await first).toEqual({ decision: "block", reason: PROMPT_TIMEOUT_REASON });
    const [e1, e2] = r.of("terminal_prompt");
    expect([e1!.seq, e2!.seq]).toEqual([1, 2]);
    // p1's late answer: not p2's — the turn it opened ends at once.
    expect(r.ts.answerPrompt(e1!.seq, { ok: true, additionalContext: "for p1", checkpointTree: await r.tree() })).toBe(false);
    expect(r.of("turn_end").map((e) => e.stopReason)).toEqual(["prompt_timeout"]);
    expect(r.ts.answerPrompt(e2!.seq, { ok: true, additionalContext: "for p2", checkpointTree: await r.tree() })).toBe(true);
    expect(await second).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "for p2" } });
    expect(r.ts.state.promptId).toBe("p2");
  });

  it("a write tool with no turn open starts one through auto_turn_start; refused → deny", async () => {
    const r = rig();
    const pending = r.hook(pre("Write", { file_path: "x.txt", content: "x" }, "t1"));
    // §57.8: the guard reads the repository's root once before the turn is asked for.
    await vi.waitFor(() => expect(r.of("auto_turn_start")).toHaveLength(1));
    expect(r.of("auto_turn_start")).toEqual([{ type: "auto_turn_start", trigger: "continue", commandUuid: "p1" }]);
    // A second call meanwhile waits on the same answer.
    const second = r.hook(pre("Edit", { file_path: "y.txt" }, "t2"));
    await new Promise((res) => setTimeout(res, 10));
    expect(r.of("auto_turn_start")).toHaveLength(1);
    r.ts.autoTurnReady(false);
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: UNPROMPTED_REASON } };
    expect(await pending).toEqual(deny);
    expect(await second).toEqual(deny);
    expect(r.ts.isTurnActive).toBe(false);

    const again = r.hook(pre("Write", { file_path: "x.txt", content: "x" }, "t3"));
    await new Promise((res) => setTimeout(res, 10));
    r.ts.autoTurnReady(true, await r.tree());
    expect(await again).toEqual({});
    expect(r.ts.isTurnActive).toBe(true);
    expect(r.ts.state.promptId).toBeNull(); // a turn Claude started itself
  });

  it("a write tool whose turn could not start in time (the wait ran out, the engine still busy) is denied as busy, not unprompted", async () => {
    const busy = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    const slow = rig({ adoptWaitMs: 50 });
    expect(await slow.hook(pre("Write", { file_path: "x.txt", content: "x" }, "t1"))).toEqual(busy(ADOPT_BUSY_REASON));
    const r = rig();
    const pending = r.hook(pre("Write", { file_path: "x.txt", content: "x" }, "t2"));
    await new Promise((res) => setTimeout(res, 10));
    r.ts.autoTurnReady(false, undefined, true);
    expect(await pending).toEqual(busy(ADOPT_BUSY_REASON));
    expect(r.ts.isTurnActive).toBe(false);
  });

  it("the engine taking the turn after the calls were denied (their wait ran out) ends it at once", async () => {
    const r = rig();
    r.ts.autoTurnReady(true, await r.tree());
    expect(r.of("turn_end").map((e) => e.stopReason)).toEqual(["adopt_timeout"]);
    expect(r.ts.isTurnActive).toBe(false);
    r.ts.autoTurnReady(false);
    expect(r.of("turn_end")).toHaveLength(1);
  });

  it("an edit tool's PostToolUse gives the touched file and its rows; Stop gives turn_end with it", async () => {
    const r = rig();
    await r.hook(ups("p1"));
    write(r.dir, "notes.txt", "n\n");
    await r.hook(pre("Write", { file_path: "notes.txt", content: "n\n" }, "w1"));
    await r.hook(post("Write", { file_path: "notes.txt", content: "n\n" }, "w1", { tool_response: "File created successfully at: notes.txt" }));
    expect(r.of("tool_use")).toEqual([{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "notes.txt", content: "n\n" }, file: join(r.dir, "notes.txt") }]);
    expect(r.of("tool_result")).toEqual([{ type: "tool_result", toolUseId: "w1", isError: false, preview: "File created successfully at: notes.txt" }]);
    expect(await r.hook({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({});
    const end = r.of("turn_end");
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ stopReason: "end_turn", sessionId: "chat-1", toolFiles: [{ path: join(r.dir, "notes.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }], changedOutside: [], planFiles: [], budget: { files: 0, lines: 0, denied: false } });
    expect(end[0]!.usage).toMatchObject({ costUsd: 0, inputTokens: 0 });
    // Stop with no turn open: nothing.
    await r.hook({ hook_event_name: "Stop" });
    expect(r.of("turn_end")).toHaveLength(1);
  });

  it("an edit outside the project goes to changedOutside", async () => {
    const r = rig();
    const outside = realpathSync(makeTempDir("rg-term-out"));
    dirs.push(outside);
    await r.hook(ups("p1"));
    await r.hook(post("Write", { file_path: join(outside, "o.txt") }, "w1"));
    await r.hook({ hook_event_name: "Stop" });
    expect(r.of("turn_end")[0]!.changedOutside).toEqual([join(outside, "o.txt")]);
  });

  it("a Bash call that writes gives tool_files; a read-only one takes no snapshot", async () => {
    const r = rig();
    await r.hook(ups("p1"));
    await r.hook(pre("Bash", { command: "ls" }, "b1"));
    await r.hook(post("Bash", { command: "ls" }, "b1", { tool_response: { stdout: "README.md" } }));
    expect(r.of("bash_snapshot")).toEqual([]);
    expect(r.of("tool_use").map((e) => e.id)).toEqual(["b1"]);

    await r.hook(pre("Bash", { command: "echo hi > made.txt" }, "b2"));
    write(r.dir, "made.txt", "hi\n");
    await r.hook(post("Bash", { command: "echo hi > made.txt" }, "b2"));
    expect(r.of("tool_files")).toEqual([{ type: "tool_files", toolUseId: "b2", files: [join(r.dir, "made.txt")] }]);
    expect(r.of("bash_snapshot")).toHaveLength(1);
    // Rows in order: the call, its files, its result.
    const order = r.events.filter((e) => ["tool_use", "tool_files", "bash_snapshot", "tool_result"].includes(e.type)).slice(-4).map((e) => e.type);
    expect(order).toEqual(["tool_use", "tool_files", "bash_snapshot", "tool_result"]);
    await r.hook({ hook_event_name: "Stop" });
    expect(r.of("turn_end")[0]!.toolFiles).toEqual([{ path: join(r.dir, "made.txt"), tools: ["Bash"], count: 1, toolUseIds: ["b2"] }]);
  });

  it("the Esc rule: a new prompt_id while open ends the turn first (interrupted); is_interrupt is noted", async () => {
    const r = rig();
    await r.hook(ups("p1"));
    await r.hook(pre("Bash", { command: "sleep 100" }, "b1"));
    await r.hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "sleep 100" }, tool_use_id: "b1", error: "Interrupted", is_interrupt: true });
    expect(r.ts.state.interruptSuspected).toBe(true);
    expect(r.of("tool_result").at(-1)).toMatchObject({ toolUseId: "b1", isError: true, preview: "Interrupted" });
    await r.hook(ups("p2"));
    const kinds = r.events.filter((e) => e.type === "turn_end" || e.type === "terminal_prompt").map((e) => (e.type === "turn_end" ? `end:${e.stopReason}` : `prompt:${e.promptId}`));
    expect(kinds).toEqual(["prompt:p1", "end:interrupted", "prompt:p2"]);
    expect(r.ts.state).toMatchObject({ promptId: "p2", interruptSuspected: false });
  });

  for (const [name, close, reason] of [
    ["idle_prompt", (r: Rig) => r.hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }), "interrupted"],
    ["SessionEnd", (r: Rig) => r.hook({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }), "session_end"],
    ["ptyExited", async (r: Rig) => r.ts.ptyExited(), "terminal_exited"],
    ["endTurnByUser", async (r: Rig) => expect(r.ts.endTurnByUser()).toBe(true), "ended_by_user"],
  ] as const) {
    it(`${name} closes an open turn (${reason})`, async () => {
      const r = rig();
      await r.hook(ups("p1"));
      await close(r);
      expect(r.of("turn_end").map((e) => e.stopReason)).toEqual([reason]);
      expect(r.ts.isTurnActive).toBe(false);
      expect(r.ts.endTurnByUser()).toBe(false);
    });
  }

  it("StopFailure ends the turn with its error and a non-fatal api_error", async () => {
    const r = rig();
    await r.hook(ups("p1"));
    await r.hook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "429" });
    expect(r.of("error")).toEqual([{ type: "error", message: "Claude Code stopped on an API error: rate_limit (429)", fatal: false, code: "api_error" }]);
    expect(r.of("turn_end").map((e) => e.stopReason)).toEqual(["stop_failure:rate_limit"]);
  });

  it("Stop's background tasks go out before turn_end; a later Stop without any clears them", async () => {
    const r = rig();
    await r.hook(ups("p1"));
    await r.hook({ hook_event_name: "Stop", background_tasks: [{ id: "bg1", type: "local_bash", description: "npm run dev" }] });
    const kinds = r.events.filter((e) => e.type === "background_tasks" || e.type === "turn_end").map((e) => e.type);
    expect(kinds).toEqual(["background_tasks", "turn_end"]);
    expect(r.of("background_tasks")[0]!.tasks).toMatchObject([{ taskId: "bg1", kind: "bash", description: "npm run dev" }]);
    await r.hook(ups("p2"));
    await r.hook({ hook_event_name: "Stop" });
    expect(r.of("background_tasks").map((e) => e.tasks.length)).toEqual([1, 0]);
  });

  it("Notification permission_prompt / elicitation_dialog set waiting; the next hook clears it", async () => {
    const r = rig();
    await r.hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash", title: "Permission" });
    expect(r.ts.state.waiting).toMatchObject({ kind: "permission", message: "Claude needs your permission to use Bash" });
    expect(r.of("terminal_attention")).toEqual([{ type: "terminal_attention", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash", title: "Permission" }]);
    await r.hook(ups("p1"));
    expect(r.ts.state.waiting).toBeNull();
    await r.hook({ hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "Pick one" });
    expect(r.ts.state.waiting?.kind).toBe("question");
    await r.hook({ hook_event_name: "Stop" });
    expect(r.ts.state.waiting).toBeNull();
    expect(r.of("terminal_state").length).toBeGreaterThan(0);
  });

  it("a session_id change (/clear, /resume in the TUI) on a prompt emits terminal_session_id once; turn_end keeps the chat id", async () => {
    const r = rig();
    const cli2 = "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a";
    await r.hook(ups("p1"));
    await r.hook({ hook_event_name: "Stop" });
    await r.hook({ ...ups("p2"), session_id: cli2 });
    await r.hook({ hook_event_name: "SessionEnd", reason: "clear", session_id: cli2 });
    expect(r.of("terminal_session_id")).toEqual([{ type: "terminal_session_id", sessionId: cli2 }]);
    expect(r.ts.cliSession).toBe(cli2);
    expect(r.of("turn_end")[0]!.sessionId).toBe("chat-1");
    const cli3 = "1c8f4d2b-6e3a-4f9c-8b7d-2a3b4c5d6e7f";
    await r.hook({ hook_event_name: "SessionEnd", reason: "resume", session_id: cli3 });
    expect(r.ts.cliSession).toBe(cli3);
  });

  it("a forged session_id never becomes the chat's: not a UUID, or on another event than UserPromptSubmit / SessionEnd", async () => {
    const r = rig();
    await r.hook({ ...ups("p1"), session_id: "--dangerously-skip-permissions" });
    await r.hook({ hook_event_name: "Stop", session_id: "--dangerously-skip-permissions" });
    await r.hook({ hook_event_name: "SessionEnd", session_id: "cli-2 --x" });
    for (const event of ["Stop", "Notification", "PostToolUse", "StopFailure"]) {
      await r.hook({ hook_event_name: event, session_id: "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a" });
    }
    expect(r.of("terminal_session_id")).toEqual([]);
    expect(r.ts.cliSession).toBe("chat-1");
  });

  it("dispose answers every pending wait with block / deny, retires the token and emits nothing", async () => {
    const r = rig({ answer: null });
    const retired: string[] = [];
    r.ts.setToken("tok-1", (t) => retired.push(t));
    const prompt = r.hook(ups("p1"));
    const adopt = r.hook(pre("Write", { file_path: "a" }, "t1"));
    await vi.waitFor(() => expect(r.of("auto_turn_start")).toHaveLength(1)); // §57.8: past the guard
    const n = r.events.length;
    await r.ts.dispose();
    expect(await prompt).toEqual({ decision: "block", reason: RETIRED_REASON });
    expect((await adopt).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(retired).toEqual(["tok-1"]);
    expect(r.events.length).toBe(n);
    expect(await r.hook(ups("p2"))).toEqual({ decision: "block", reason: RETIRED_REASON });
  });

  it("a new spawn's token retires the previous one and resets running / hooksSeen", async () => {
    const r = rig();
    const retired: string[] = [];
    r.ts.setToken("a", (t) => retired.push(t));
    r.ts.started(1);
    await r.hook({ hook_event_name: "Notification", notification_type: "other" });
    expect(r.ts.state).toMatchObject({ running: true, hooksSeen: true });
    r.ts.setToken("b");
    expect(retired).toEqual(["a"]);
    expect(r.ts.state).toMatchObject({ running: false, hooksSeen: false });
  });

  it("§57.16 any tool's PostToolUse clears waiting (a WebFetch dialog); PermissionRequest waits at once; CwdChanged → terminal_cwd", async () => {
    const r = rig();
    expect(await r.hook({ hook_event_name: "PermissionRequest", tool_name: "WebFetch", tool_input: { url: "https://example.com" } })).toEqual({});
    expect(r.ts.state.waiting).toMatchObject({ kind: "permission", message: "Claude needs your permission to use WebFetch" });
    expect(r.of("terminal_attention").at(-1)).toMatchObject({ notificationType: "permission_request" });
    await r.hook({ hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_use_id: "f1", tool_response: "ok" });
    expect(r.ts.state.waiting).toBeNull();
    expect(r.of("tool_use")).toHaveLength(0); // neither an edit tool nor Bash: nothing of the turn
    await r.hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use mcp__acme__fetch" });
    expect(r.ts.state.waiting?.kind).toBe("permission");
    await r.hook({ hook_event_name: "PostToolUseFailure", tool_name: "mcp__acme__fetch", tool_input: {}, tool_use_id: "m1", error: "denied" });
    expect(r.ts.state.waiting).toBeNull();
    expect(await r.hook({ hook_event_name: "CwdChanged", old_cwd: r.dir, new_cwd: "/work/acme/feature" })).toEqual({});
    await r.hook({ hook_event_name: "CwdChanged", old_cwd: r.dir, new_cwd: "relative/dir" });
    expect(r.of("terminal_cwd")).toEqual([{ type: "terminal_cwd", cwd: "/work/acme/feature" }]);
  });

  it("§57.16 transcript_path → terminal_config_dir (once per dir); a malformed path is ignored", async () => {
    const r = rig();
    const config = realpathSync(makeTempDir("rg-term-cfg"));
    dirs.push(config);
    mkdirSync(join(config, "projects", "-work-acme"), { recursive: true });
    const file = join(config, "projects", "-work-acme", "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a.jsonl");
    for (const bad of ["/dev/null", "relative/projects/x/0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a.jsonl", join(config, "other", "-work-acme", "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a.jsonl"), join(config, "projects", "-work-acme", "notes.jsonl"), join("/nonexistent", "projects", "k", "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a.jsonl")]) {
      expect(configDirOfTranscript(bad), bad).toBeNull();
      await r.hook({ hook_event_name: "Notification", notification_type: "auth_success", message: "", transcript_path: bad });
    }
    expect(r.of("terminal_config_dir")).toHaveLength(0);
    await r.hook({ hook_event_name: "Notification", notification_type: "auth_success", message: "", transcript_path: file });
    await r.hook({ hook_event_name: "Notification", notification_type: "auth_success", message: "", transcript_path: file });
    expect(r.of("terminal_config_dir")).toEqual([{ type: "terminal_config_dir", dir: config }]);
  });

  it("§57.10 background: prompts blocked, write tools denied (the guard's deny first), waits still raised; back again keeps the token", async () => {
    const r = rig();
    const retired: string[] = [];
    r.ts.setToken("tok-1", (t) => retired.push(t));
    r.ts.started(77);
    r.ts.setBackground(true);
    expect(r.ts.isBackground).toBe(true);
    expect(await r.hook(ups("p1"))).toEqual({ decision: "block", reason: BACKGROUND_PROMPT_REASON });
    expect(r.of("terminal_prompt")).toHaveLength(0);
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    expect(await r.hook(pre("Write", { file_path: join(r.dir, "a.txt"), content: "x" }, "w1"))).toEqual(deny(BACKGROUND_TOOL_REASON));
    write(r.dir, "README.md", "dirty\n");
    const reset = await r.hook(pre("Bash", { command: "git reset --hard" }, "b1"));
    expect((reset.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason).not.toBe(BACKGROUND_TOOL_REASON);
    expect(reset).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(r.of("auto_turn_start")).toHaveLength(0);
    expect(await r.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({});
    expect(r.ts.state.waiting?.kind).toBe("permission");
    await r.hook({ hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "Which one?" });
    expect(r.ts.state.waiting?.kind).toBe("question");
    expect(r.of("terminal_attention").length).toBeGreaterThanOrEqual(2);
    await r.hook({ ...ups("p2"), session_id: "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a" });
    expect(r.of("terminal_session_id")).toEqual([{ type: "terminal_session_id", sessionId: "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a" }]);
    expect(await r.hook({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({});
    expect(r.of("turn_end")).toHaveLength(0);
    // Foreground again: the same token (never retired), prompts reviewed as before.
    r.ts.setBackground(false);
    expect(retired).toEqual([]);
    expect(r.ts.state.running).toBe(true);
    expect(await r.hook(ups("p3"))).toEqual({});
    expect(r.ts.state.promptId).toBe("p3");
  });

  it("§57.13 status: the first sample is the baseline, growth goes into the next turn_end, a drop is a new baseline", async () => {
    const r = rig();
    const status = (cost: number, ctx = 1000) => r.ts.handleStatus({ cost: { total_cost_usd: cost }, model: { id: "claude-acme-test", display_name: "Acme" }, context_window: { context_window_size: 200_000, current_usage: { input_tokens: ctx, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } } });
    r.ts.setToken("t1");
    status(0.5); // a resumed conversation's earlier cost: not this chat's new spend
    expect(r.ts.state.status).toMatchObject({ costUsd: 0.5, model: "claude-acme-test", modelName: "Acme", contextTokens: 1015, contextWindow: 200_000 });
    expect(r.of("terminal_status")).toHaveLength(1);
    await r.hook(ups("p1"));
    status(0.75, 2000);
    await r.hook({ hook_event_name: "Stop", stop_hook_active: false });
    let end = r.of("turn_end").at(-1)!;
    expect(end.usage.costUsd).toBeCloseTo(0.25);
    expect(end.usage).toMatchObject({ contextTokens: 2015, contextWindow: 200_000 });
    status(0.1); // /clear: the total starts again — a new baseline, nothing negative
    status(0.3);
    await r.hook(ups("p2"));
    await r.hook({ hook_event_name: "Stop", stop_hook_active: false });
    end = r.of("turn_end").at(-1)!;
    expect(end.usage.costUsd).toBeCloseTo(0.2);
    // A new spawn: its first sample is a baseline again.
    r.ts.setToken("t2");
    status(5);
    await r.hook(ups("p3"));
    await r.hook({ hook_event_name: "Stop", stop_hook_active: false });
    expect(r.of("turn_end").at(-1)!.usage.costUsd).toBe(0);
    r.ts.handleStatus({ nonsense: true });
    expect(r.ts.state.status).toMatchObject({ costUsd: null, model: null, contextTokens: null });
  });

  it("§57.14 Stop feedback: one block per staged request, never on stop_hook_active; an aborted Stop puts the notes back", async () => {
    const lost: string[][] = [];
    let takes = 0;
    const r = rig();
    const opts = (r.ts as unknown as { opts: { stopFeedback?: unknown; stopFeedbackLost?: unknown } }).opts;
    opts.stopFeedback = () => (++takes, { message: "[Review gate] Requested changes on this turn's diff.", noteIds: ["n1"] });
    opts.stopFeedbackLost = (ids: string[]) => void lost.push(ids);
    await r.hook(ups("p1"));
    expect(await r.hook({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({}); // nothing staged
    await r.hook(ups("p2"));
    r.ts.stageRequest({ via: "stop", noteIds: null, extra: null, at: "2026-01-01T00:00:00Z" });
    expect(r.ts.state.requestQueued?.via).toBe("stop");
    const blocked = await r.hook({ hook_event_name: "Stop", stop_hook_active: false });
    expect(blocked).toEqual({ decision: "block", reason: STOP_FEEDBACK_PREFIX + "[Review gate] Requested changes on this turn's diff." });
    expect(r.ts.isTurnActive).toBe(true);
    expect(r.ts.state.requestQueued).toBeUndefined();
    r.ts.stageRequest({ via: "stop", noteIds: null, extra: null, at: "2026-01-01T00:00:00Z" });
    expect(await r.hook({ hook_event_name: "Stop", stop_hook_active: true })).toEqual({}); // a continued Stop: no second block
    expect(r.ts.isTurnActive).toBe(false);
    expect(r.ts.state.requestQueued?.via).toBe("next_prompt"); // its turn ended without it: it goes with the next prompt
    expect(takes).toBe(1);
    // Aborted after the answer was made: the notes come back.
    await r.hook(ups("p3"));
    r.ts.stageRequest({ via: "stop", noteIds: null, extra: null, at: "2026-01-01T00:00:00Z" });
    const ac = new AbortController();
    await r.ts.handleHook({ hook_event_name: "Stop", stop_hook_active: false, session_id: "chat-1", cwd: r.dir }, ac.signal);
    ac.abort();
    expect(lost).toEqual([["n1"]]);
  });
});
