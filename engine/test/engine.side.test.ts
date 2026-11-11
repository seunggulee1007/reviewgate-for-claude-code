import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineEvent, SideThread } from "../src/protocol.js";
import { PROMOTE_DRAFT_PROMPT, PROMOTE_PROVENANCE, SIDE_PROMPT_HEADER } from "../src/side/context.js";
import { SIDE_READ_ONLY_REASON, SIDE_SKILL_REASON, SIDE_WEB_OFF_REASON, SideQuery, sideToolDenyReason, type SideQueryEvent, type SideQueryOptions, type SideQueryResult } from "../src/side/sideQuery.js";
import { sideFilePath, type SideQueryLike } from "../src/side/threads.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { readOnlyContext } from "../src/session/reviewScope.js";
import { bashPath, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/** docs/PROTOCOL.md §21: side questions fork the main session read-only and never touch it. */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-side"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A scripted side CLI: records its options; `answer` decides what it streams; `hold` keeps it running until released. */
class FakeSide implements SideQueryLike {
  readonly opts: SideQueryOptions;
  private release: (() => void) | null = null;
  interrupted = false;
  constructor(opts: SideQueryOptions, private readonly script: Script) {
    this.opts = opts;
  }
  async run(): Promise<SideQueryResult> {
    const s = this.script(this.opts);
    if (s.hold) await new Promise<void>((r) => (this.release = r));
    if (this.interrupted) return { sessionId: s.sessionId ?? this.opts.sessionId ?? this.opts.resume ?? null, text: "", costUSD: 0, durationMs: 5, stopReason: "interrupted", error: null, sawOutput: true };
    if (s.error) return { sessionId: null, text: "", costUSD: 0, durationMs: 1, stopReason: "error", error: s.error, sawOutput: false };
    const sid = s.sessionId ?? this.opts.sessionId ?? this.opts.resume ?? "side-x";
    this.opts.emit({ type: "session", sessionId: sid });
    for (const ev of s.events ?? []) this.opts.emit(ev);
    this.opts.emit({ type: "text_delta", text: s.text });
    return { sessionId: sid, text: s.text, costUSD: s.cost ?? 0.002, durationMs: 42, stopReason: "success", error: null, sawOutput: true };
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.release?.();
  }
  async dispose(): Promise<void> {}
  finish(): void {
    this.release?.();
  }
}
type Script = (o: SideQueryOptions) => { text: string; hold?: boolean; error?: string; sessionId?: string; cost?: number; events?: SideQueryEvent[] };

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: Script = () => ({ text: "Because the README needed a 4th line." })) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

async function reviewedTurn(h: Harness, dir: string, lastUuid = "uuid-turn-1"): Promise<void> {
  await h.engine.handle({ type: "send", text: "Change README" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\nline4\n");
  h.session().emit({ type: "tool_use", id: "toolu_edit1", name: "Edit", input: { file_path: join(dir, "README.md"), old_string: "line2", new_string: "line2 changed" }, file: join(dir, "README.md"), rationale: "Let me update line 2 as asked." });
  h.session().turnActive = false;
  h.session().emit({
    type: "turn_end", stopReason: "end_turn", sessionId: "sess-1",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 5 },
    toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1, toolUseIds: ["toolu_edit1"] }],
    budget: { files: 1, lines: 2, denied: false }, changedOutside: [], planFiles: [], lastUuid,
  });
  await h.waitFor((s) => s.gate.phase === "reviewing", "review");
  await h.settle();
}

async function waitEvent<T extends EngineEvent["type"]>(h: Harness, type: T, pred: (e: Extract<EngineEvent, { type: T }>) => boolean = () => true): Promise<Extract<EngineEvent, { type: T }>> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const hit = h.ofType(type).find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const idle = (t: SideThread) => t.status !== "running";

describe("side read-only policy (§21)", () => {
  it("allows reading tools, read-only Bash and (by default) the web; refuses edits, agents, MCP, mutating Bash", () => {
    for (const t of ["Read", "Grep", "Glob", "LS", "TodoWrite"]) expect(sideToolDenyReason(t, {}, { allowWeb: true }), t).toBeUndefined();
    expect(sideToolDenyReason("WebFetch", {}, { allowWeb: true })).toBeUndefined();
    expect(sideToolDenyReason("WebFetch", {}, { allowWeb: false })).toBe(SIDE_WEB_OFF_REASON); // §40.3: the web's own reason
    expect(sideToolDenyReason("Bash", { command: "git log -3" }, { allowWeb: true })).toBeUndefined();
    for (const cmd of ["rm -rf x", "echo a > b", "npm test", "git commit -m x"]) expect(sideToolDenyReason("Bash", { command: cmd }, { allowWeb: true }), cmd).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("Bash", { command: "ls", run_in_background: true }, { allowWeb: true })).toBe(SIDE_READ_ONLY_REASON);
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "mcp__fs__write", "ExitPlanMode", "KillShell"]) {
      expect(sideToolDenyReason(t, { file_path: "/x" }, { allowWeb: true }), t).toBe(SIDE_READ_ONLY_REASON);
    }
  });

  it("MARK: r2-skills-side (M18): MCP reads with the user's servers attached, Explore agents, never a skill", () => {
    const mcp = {
      allowWeb: false,
      mcp: true,
      mcpToolHints: new Map([
        ["mcp__db__run_query", { readOnly: true }],
        ["mcp__tracker__get_issue", { readOnly: true }],
        ["mcp__wiki__search_pages", { readOnly: true }],
        ["mcp__wiki__get_page", { readOnly: true, destructive: true }],
      ]),
    };
    for (const t of ["mcp__tracker__get_issue", "mcp__wiki__search_pages", "mcp__db__run_query", "ListMcpResourcesTool", "ReadMcpResourceTool"]) expect(sideToolDenyReason(t, {}, mcp), t).toBeUndefined();
    for (const t of ["mcp__tracker__create_issue", "mcp__fs__write_file", "mcp__db__execute", "mcp__wiki__get_page"]) expect(sideToolDenyReason(t, {}, mcp), t).toBe(SIDE_READ_ONLY_REASON);
    // Release-2 review: a read by its name alone never runs — a SQL server's `query` may be `DELETE FROM orders`; the user's
    // allow rule (or the app's pattern) for a tool that reads lets it, never one that writes.
    for (const t of ["mcp__db__query", "mcp__web__fetch", "mcp__ci__check", "mcp__tracker__list_issues"]) expect(sideToolDenyReason(t, { sql: "DELETE FROM orders" }, mcp), t).toBe(SIDE_READ_ONLY_REASON);
    const allowed = { ...mcp, mcpAllowed: (t: string) => t === "mcp__tracker__list_issues" || t === "mcp__tracker__create_issue" };
    expect(sideToolDenyReason("mcp__tracker__list_issues", {}, allowed)).toBeUndefined();
    expect(sideToolDenyReason("mcp__tracker__create_issue", {}, allowed)).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("mcp__db__query", {}, allowed)).toBe(SIDE_READ_ONLY_REASON);
    // Without the servers (a one-shot fork) no MCP tool runs.
    expect(sideToolDenyReason("mcp__tracker__get_issue", {}, { allowWeb: false })).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("Agent", { subagent_type: "Explore", prompt: "find X" }, mcp)).toBeUndefined();
    expect(sideToolDenyReason("Task", { subagent_type: "Explore", prompt: "find X" }, mcp)).toBeUndefined();
    expect(sideToolDenyReason("Agent", { subagent_type: "Explore", isolation: "worktree" }, mcp)).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("Agent", { subagent_type: "general-purpose" }, mcp)).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("Skill", { skill: "acme-verify" }, mcp)).toBe(SIDE_SKILL_REASON);
    // Both refusals start alike: the thread marks the call denied by that prefix.
    expect(SIDE_SKILL_REASON.slice(0, 40)).toBe(SIDE_READ_ONLY_REASON.slice(0, 40));
    // The reads the plan saw refused (r2 M18): a PR lookup, a log with its errors dropped, a `cd` into the project first —
    // judged where they run, as the main session's read-only commands (§19.3).
    const root = makeRepo();
    try {
      write(root, "api/a.txt", "x\n");
      const ro = { allowWeb: false, readOnly: readOnlyContext(root, root, []) };
      for (const command of ["gh pr view 42", "git log -3 2>/dev/null", "cd api && git log --oneline -5", `cd ${bashPath(root)} && git status`]) {
        expect(sideToolDenyReason("Bash", { command }, ro), command).toBeUndefined();
      }
      for (const command of ["cd api && npm test", "gh pr merge 42", "cd /work/acme && git log"]) expect(sideToolDenyReason("Bash", { command }, ro), command).toBe(SIDE_READ_ONLY_REASON);
    } finally {
      removeDir(root);
    }
  });
});

describe("SideQuery against a scripted SDK", () => {
  const base = (over: Partial<SideQueryOptions> = {}): SideQueryOptions => ({
    cwd: "/tmp/p", claudePath: "/nonexistent/claude", env: {}, platform: { killTree: async () => undefined, isWindows: false },
    settingSources: ["user", "project"], skills: "all", flagSettings: { disableAllHooks: true }, prompt: "Q?", allowWeb: true,
    emit: () => {}, log: () => {}, ...over,
  });

  it("first question: forks the main session at the given uuid with a pre-chosen id; follow-up resumes the side session", () => {
    const fork = new SideQuery(base({ forkFrom: "main-1", forkAt: "uuid-9", sessionId: "side-1" })).queryOptions();
    expect(fork.resume).toBe("main-1");
    expect(fork.forkSession).toBe(true);
    expect(fork.resumeSessionAt).toBe("uuid-9");
    expect(fork.sessionId).toBe("side-1");
    expect(fork.strictMcpConfig).toBe(true);
    expect(fork.mcpServers).toEqual({});
    expect(fork.settings).toEqual({ disableAllHooks: true, crossSessionInbound: "refuse" }); // §29: no peer messages
    expect(fork.permissionMode).toBe("default");
    expect((fork.env as Record<string, string>).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    const full = new SideQuery(base({ forkFrom: "main-1", sessionId: "side-2" })).queryOptions();
    expect(full.resumeSessionAt).toBeUndefined();
    expect(full.forkSession).toBe(true);
    const follow = new SideQuery(base({ resume: "side-1" })).queryOptions();
    expect(follow.resume).toBe("side-1");
    expect(follow.forkSession).toBeUndefined();
    expect(follow.sessionId).toBeUndefined();
    const fresh = new SideQuery(base({ sessionId: "side-3" })).queryOptions();
    expect(fresh.resume).toBeUndefined();
    expect(fresh.sessionId).toBe("side-3");
  });

  it("MARK: r2-skills-side (M18): with `mcp` the user's servers start (session-added ones passed, turned-off ones denied)", () => {
    const servers = { acme: { type: "http" as const, url: "https://tasks.example.com/mcp" } };
    const q = new SideQuery(base({ mcp: { servers, denied: ["wiki"] } })).queryOptions();
    expect(q.strictMcpConfig).toBeUndefined();
    expect(q.mcpServers).toEqual(servers);
    expect(q.settings).toEqual({ disableAllHooks: true, crossSessionInbound: "refuse", deniedMcpServers: [{ serverName: "wiki" }] });
    const none = new SideQuery(base({ mcp: { servers: {}, denied: [] } })).queryOptions();
    expect(none.settings).toEqual({ disableAllHooks: true, crossSessionInbound: "refuse" });
  });

  it("the PreToolUse hook and canUseTool deny edits with the side reason and allow reads", async () => {
    const opts = new SideQuery(base()).queryOptions();
    const hook = opts.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const call = async (tool: string, input: Record<string, unknown>) => {
      const out = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    };
    expect((await call("Edit", { file_path: "/tmp/a" }))?.permissionDecision).toBe("deny");
    expect((await call("Edit", { file_path: "/tmp/a" }))?.permissionDecisionReason).toBe(SIDE_READ_ONLY_REASON);
    expect((await call("Read", { file_path: "/tmp/a" }))?.permissionDecision).toBe("allow");
    expect((await call("Bash", { command: "touch x" }))?.permissionDecision).toBe("deny");
    const r = await opts.canUseTool!("Write", { file_path: "/tmp/a" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
    expect(r).toEqual({ behavior: "deny", message: SIDE_READ_ONLY_REASON });
    expect(await opts.canUseTool!("Grep", { pattern: "x" }, { signal: new AbortController().signal, toolUseID: "t" } as never)).toEqual({ behavior: "allow", updatedInput: { pattern: "x" } });
  });

  it("run(): streams text and tool calls, ends after the result, reports cost and session id", async () => {
    let seenOptions: Options | undefined;
    const messages: SDKMessage[] = [
      { type: "system", subtype: "init", session_id: "side-9" } as never,
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } } as never,
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me look." } } } as never,
      { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] } } as never,
      { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file text" }] } } as never,
      { type: "assistant", parent_tool_use_id: null, message: { id: "m2", content: [{ type: "text", text: "It adds line 4." }] } } as never,
      { type: "result", subtype: "success", is_error: false, session_id: "side-9", total_cost_usd: 0.0123, duration_ms: 777, result: "It adds line 4." } as never,
    ];
    const queryFn = (args: { prompt: AsyncIterable<unknown>; options?: Options }): Query => {
      seenOptions = args.options;
      let i = 0;
      const q = {
        async next() {
          if (i < messages.length) return { done: false, value: messages[i++] };
          return { done: true, value: undefined };
        },
        async return() {
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        interrupt: async () => undefined,
      };
      return q as unknown as Query;
    };
    const events: SideQueryEvent[] = [];
    const r = await new SideQuery(base({ forkFrom: "main", sessionId: "side-9", emit: (e) => events.push(e), queryFn: queryFn as never })).run();
    expect(seenOptions?.forkSession).toBe(true);
    expect(r).toMatchObject({ sessionId: "side-9", costUSD: 0.0123, durationMs: 777, stopReason: "success", error: null, sawOutput: true });
    expect(r.text).toBe("Let me look.\n\nIt adds line 4.");
    expect(events.map((e) => e.type)).toEqual(["session", "text_delta", "tool_use", "tool_result", "text_delta"]);
  });
});

describe("side threads in the engine (§21)", () => {
  it("MARK: r2-skills-side (M18): a known /command is refused side_command (it runs in the main chat); the MCP servers ride along", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    h.session().emitSessionInfo({ slashCommands: ["compact", "acme-verify"], skills: ["acme-plugin:release-notes"] });
    await h.settle();
    await expect(h.engine.request({ type: "side_ask", question: "/acme-verify --fast" })).rejects.toThrow(/side_command:acme-verify/);
    await expect(h.engine.request({ type: "side_ask", question: "/acme-plugin:release-notes 12" })).rejects.toThrow(/side_command/);
    expect(sides).toHaveLength(0);
    expect(h.engine.state.session.open).toBe(true);
    // A path or an unknown word is a question.
    const t = await h.engine.request({ type: "side_ask", question: "/tmp 지워도 돼?" });
    expect(t.thread.status).toBe("running");
    await waitEvent(h, "side_turn_end");
    expect(sides[0]!.opts.mcp).toMatchObject({ servers: {}, denied: [] });
  });

  it("side_ask while idle forks the whole main session with the anchor context; the main conversation is untouched", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const main = h.session();
    const transcriptBefore = readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8");
    const before = h.engine.state;
    const reply = await h.engine.request({ type: "side_ask", anchor: { path: "README.md", line: 2, side: "new" }, question: "왜 이 줄을 바꿨어?" });
    expect(reply.type).toBe("side_thread");
    expect(reply.thread.status).toBe("running");
    const end = await waitEvent(h, "side_turn_end");
    expect(end.threadId).toBe(reply.thread.id);
    const o = sides[0]!.opts;
    expect(o.forkFrom).toBe("sess-1");
    expect(o.forkAt).toBeUndefined();
    expect(o.resume).toBeUndefined();
    expect(o.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.cwd).toBe(dir);
    expect(o.prompt).toContain(SIDE_PROMPT_HEADER);
    expect(o.prompt).toContain("File: README.md (M, +2 −1, pending)");
    expect(o.prompt).toContain("+line2 changed");
    expect(o.prompt).toContain("Edit (toolu_edit1)");
    expect(o.prompt).toContain("Let me update line 2 as asked.");
    expect(o.prompt).toContain("Question: 왜 이 줄을 바꿨어?");
    expect(o.flagSettings).toMatchObject({ disableAllHooks: true });
    await h.settle();
    const after = h.engine.state;
    // The main session got nothing, the review / HUD turn count / transcript are unchanged.
    expect(main.sends).toHaveLength(1);
    expect(after.hud.turnCount).toBe(before.hud.turnCount);
    expect(after.hud.sessionCostUSD).toBe(before.hud.sessionCostUSD);
    expect(after.hud.sideCostUSD).toBeCloseTo(0.002);
    expect(after.changedFiles).toEqual(before.changedFiles);
    expect(after.sessions.list[0]!.costUSD).toBe(before.sessions.list[0]!.costUSD);
    expect(readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8")).toBe(transcriptBefore);
    expect(h.ofType("user_message")).toHaveLength(1);
    const deltas = h.ofType("side_text_delta").map((e) => e.text).join("");
    expect(deltas).toContain("Because the README needed a 4th line.");
    const list = await h.engine.request({ type: "side_list" });
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(list.threads[0]!.sessionId).toBe(o.sessionId);
    expect(list.threads[0]!.fork).toEqual({ mode: "fork_full", fromSessionId: "sess-1", at: null, atTurn: 1, runningTurn: null }); // §36.10
    expect(list.threads[0]!.title).toBe("왜 이 줄을 바꿨어?");

    // Follow-up resumes the side session, not the main one, and carries only the question.
    await h.engine.request({ type: "side_ask", threadId: reply.thread.id, question: "다른 방법은?" });
    await waitEvent(h, "side_turn_end", (e) => e.threadId === reply.thread.id && sides.length === 2);
    expect(sides[1]!.opts.resume).toBe(o.sessionId);
    expect(sides[1]!.opts.forkFrom).toBeUndefined();
    expect(sides[1]!.opts.prompt).toBe("다른 방법은?");
    expect(main.sends).toHaveLength(1);
  });

  it("works while the main turn runs: forks at the last completed turn's uuid; promote as message is refused until the turn ends", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, sides } = setup((o) => ({ text: o.prompt === PROMOTE_DRAFT_PROMPT ? "In README.md line 2, revert the wording." : "answer", hold: o.prompt.includes("hold me") }));
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir, "uuid-A");
    await h.engine.handle({ type: "send", text: "keep going" });
    expect(h.engine.state.gate.phase).toBe("running");
    const t = (await h.engine.request({ type: "side_ask", anchor: { path: "README.md" }, question: "hold me: what is going on?" })).thread;
    expect(sides[0]!.opts.forkAt).toBe("uuid-A");
    expect(sides[0]!.opts.forkFrom).toBe("sess-1");
    // Another question on the same thread while it runs: side_busy.
    await expect(h.engine.request({ type: "side_ask", threadId: t.id, question: "again" })).rejects.toThrow(/side_busy/);
    sides[0]!.finish();
    await waitEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    // The main turn is still running: a promoted message is refused like a send.
    await expect(h.engine.request({ type: "side_promote", threadId: t.id, as: "message", text: "Do X" })).rejects.toThrow(/gate_closed:running/);
    const draft = await h.engine.request({ type: "side_promote_draft", threadId: t.id });
    expect(draft).toMatchObject({ type: "side_promote_draft", threadId: t.id, text: "In README.md line 2, revert the wording." });
    expect(sides.at(-1)!.opts.resume).toBe(t.sessionId ?? sides[0]!.opts.sessionId);
    // Main turn ends; the promoted message goes through the normal send path with the provenance line.
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.canSend, "turn 2 collected");
    await h.engine.request({ type: "side_promote", threadId: t.id, as: "message", text: draft.text });
    const last = h.session().sends.at(-1)!.text;
    expect(last).toContain("In README.md line 2, revert the wording.");
    expect(last).toContain(PROMOTE_PROVENANCE);
    expect(h.ofType("user_message").at(-1)!.text).toBe(`In README.md line 2, revert the wording.\n\n${PROMOTE_PROVENANCE}`);
    const thread = (await h.engine.request({ type: "side_list" })).threads[0]!;
    expect(thread.promotions?.map((p) => p.as)).toEqual(["message"]);
    // side_promote without text answers with a draft instead of sending.
    const d2 = await h.engine.request({ type: "side_promote", threadId: t.id, as: "note" });
    expect(d2.type).toBe("side_promote_draft");
  });

  it("promote as note adds a review note on the anchor; threads persist across an engine restart", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const t = (await h.engine.request({ type: "side_ask", anchor: { path: "README.md", line: 2, side: "new" }, question: "ok?" })).thread;
    await waitEvent(h, "side_turn_end");
    await h.engine.request({ type: "side_promote", threadId: t.id, as: "note", text: "Use a clearer wording here." });
    await h.settle();
    const notes = h.engine.state.reviewNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: `Use a clearer wording here.\n${PROMOTE_PROVENANCE}` });
    expect(h.engine.state.gate.canRequestChanges).toBe(true);
    // A thread without an anchor cannot become a note.
    const bare = (await h.engine.request({ type: "side_ask", question: "general?" })).thread;
    await waitEvent(h, "side_turn_end", (e) => e.threadId === bare.id);
    await expect(h.engine.request({ type: "side_promote", threadId: bare.id, as: "note", text: "x" })).rejects.toThrow(/side_no_anchor/);
    await expect(h.engine.request({ type: "side_ask", question: "   " })).rejects.toThrow(/empty_question/);
    await expect(h.engine.request({ type: "side_ask", threadId: "nope", question: "x" })).rejects.toThrow(/unknown_side_thread/);

    const mainId = h.engine.state.sessions.currentId!;
    await h.engine.dispose();
    expect(existsSync(sideFilePath(join(dir, ".git"), mainId))).toBe(true);
    const { h: h2 } = setup();
    await h2.hello();
    await h2.open(dir);
    const list = await h2.engine.request({ type: "side_list" });
    expect(list.mainSessionId).toBe(mainId);
    expect(list.threads.map((x) => x.id).sort()).toEqual([t.id, bare.id].sort());
    expect(list.threads.every(idle)).toBe(true);
    await h2.engine.request({ type: "side_close", threadId: t.id });
    expect((await h2.engine.request({ type: "side_list" })).threads.map((x) => x.id)).toEqual([bare.id]);
    expect(h2.ofType("side_thread_closed")[0]?.threadId).toBe(t.id);
  });

  it("a failed fork at the uuid falls back to the whole session; side_cancel interrupts; a brand-new chat starts fresh", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, sides } = setup((o) => (o.forkAt ? { text: "", error: "No message found with message.uuid of: bad" } : { text: "ok", hold: o.prompt.includes("slow") }));
    await h.hello();
    await h.open(dir);
    // No main turn yet: fresh side session.
    const fresh = (await h.engine.request({ type: "side_ask", question: "slow: what is this repo?" })).thread;
    expect(sides[0]!.opts.forkFrom).toBeUndefined();
    expect(sides[0]!.opts.resume).toBeUndefined();
    await h.engine.request({ type: "side_cancel", threadId: fresh.id });
    const end = await waitEvent(h, "side_turn_end", (e) => e.threadId === fresh.id);
    expect(end.stopReason).toBe("interrupted");
    await reviewedTurn(h, dir, "uuid-bad");
    await h.engine.handle({ type: "send", text: "more" });
    const t = (await h.engine.request({ type: "side_ask", question: "now?" })).thread;
    await waitEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    const forks = sides.slice(1);
    expect(forks.map((f) => [f.opts.forkFrom, f.opts.forkAt])).toEqual([["sess-1", "uuid-bad"], ["sess-1", undefined]]);
    const thread = (await h.engine.request({ type: "side_list" })).threads.find((x) => x.id === t.id)!;
    expect(thread.status).toBe("idle");
    expect(thread.fork?.mode).toBe("fork_full");
    expect(h.ofType("error").some((e) => e.code === "side_failed")).toBe(false);
  });
});
