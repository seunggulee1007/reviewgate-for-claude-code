import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "../src/protocol.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { CommandRefused } from "../src/errors.js";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { ASK_REASON, buildHooks, CLAUDE_CONFIG_ASK_REASON, GIT_ASK_REASON, OUTSIDE_REASON, PLAN_MODE_BASH_REASON, PLAN_MODE_EDIT_REASON, READ_ONLY_BASH_REASON, type HookContext } from "../src/session/hooks.js";
import { SCOPE_ASK_REASON } from "../src/session/reviewScope.js";
import {
  autoCallText,
  autoModeDecides,
  autoModeDeniedNotice,
  autoModeRefusal,
  isAutoModeNotice,
} from "../src/session/autoMode.js";
import { makeRepo, makeTempDir, removeDir, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §39.5 (wave4b w4b-auto): auto mode leaves commands to the CLI's classifier; the review gate stays. */

const dirs: string[] = [];
const sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose().catch(() => undefined);
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function ctx(root: string, over: Partial<HookContext> = {}): HookContext & { events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return {
    budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    autoAllowReadOnlyBash: true,
    interrupted: false,
    emit: (e) => events.push(e),
    log: () => {},
    events,
    ...over,
  };
}

/** A PreToolUse input as CLI 2.1.309 sends it: `permission_mode` is the CLI's live mode. */
function pre(toolName: string, toolInput: Record<string, unknown>, cwd: string, cliMode?: string, id = "t1"): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: "s",
    transcript_path: "",
    cwd,
    tool_use_id: id,
    ...(cliMode ? { permission_mode: cliMode } : {}),
  } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

function hooksFor(c: HookContext) {
  const h = buildHooks(c);
  return { preEdit: h.PreToolUse![0]!.hooks[0]!, preBash: h.PreToolUse![1]!.hooks[0]!, preOther: h.PreToolUse![2]!.hooks[0]!, postBash: h.PostToolUse![1]!.hooks[0]! };
}

function repo(): string {
  const d = makeRepo();
  dirs.push(d);
  return d;
}

describe("autoModeDecides", () => {
  it("only in auto mode, only when the CLI is in auto mode too (or does not say), never for the tools that keep their card", () => {
    expect(autoModeDecides("Bash", "auto", "auto")).toBe(true);
    expect(autoModeDecides("Bash", "auto", undefined)).toBe(true);
    expect(autoModeDecides("WebFetch", "auto", "auto")).toBe(true);
    expect(autoModeDecides("mcp__github__create_issue", "auto", "auto")).toBe(true);
    // The CLI fell back (a model without auto mode, a policy): the cards stay.
    expect(autoModeDecides("Bash", "auto", "default")).toBe(false);
    for (const mode of ["default", "acceptEdits", "plan", undefined] as (PermissionMode | undefined)[]) expect(autoModeDecides("Bash", mode, "auto")).toBe(false);
    for (const tool of ["SendMessage", "AskUserQuestion", "ExitPlanMode"]) expect(autoModeDecides(tool, "auto", "auto")).toBe(false);
  });

  // MARK: wave6 w6-terminal — §44.1
  it("EnterPlanMode is no card in auto mode: it only restricts Claude (the CLI runs it without asking there)", () => {
    expect(autoModeDecides("EnterPlanMode", "auto", "auto")).toBe(true);
    expect(autoModeDecides("EnterPlanMode", "auto", "default")).toBe(false); // auto mode the CLI could not start: the card
    expect(autoModeDecides("EnterPlanMode", "default", "default")).toBe(false);
  });

  it("plan mode entered from auto mode leaves what cannot change anything to the CLI; writes and other tools keep the card", () => {
    const fromAuto = (tool: string, input?: Record<string, unknown>, cliMode: unknown = "plan") => autoModeDecides(tool, "plan", cliMode, input, "auto");
    expect(fromAuto("WebFetch", { url: "https://docs.spring.io/x" })).toBe(true);
    expect(fromAuto("WebSearch", { query: "spring boot 3.5" })).toBe(true);
    expect(fromAuto("Agent", { description: "explore", prompt: "find x" })).toBe(true);
    expect(fromAuto("mcp__github__get_issue", { number: 1 })).toBe(true);
    expect(fromAuto("mcp__github__create_issue", { title: "x" })).toBe(false);
    expect(autoModeDecides("mcp__x__do_it", "plan", "plan", {}, "auto", new Map([["mcp__x__do_it", { readOnly: true }]]))).toBe(true);
    // Bash only gets here read-only in plan mode (the plan rules deny the rest first); git's own commands keep the card.
    expect(fromAuto("Bash", { command: "ls -la" })).toBe(true);
    expect(fromAuto("Bash", { command: "git push origin HEAD" })).toBe(false);
    for (const tool of ["SendMessage", "AskUserQuestion", "ExitPlanMode", "PowerShell", "TaskStop", "CronCreate"]) expect(fromAuto(tool, {}), tool).toBe(false);
    // A subagent still in auto mode counts; a CLI that runs another mode does not.
    expect(fromAuto("WebFetch", { url: "https://x.example" }, "auto")).toBe(true);
    expect(fromAuto("WebFetch", { url: "https://x.example" }, "default")).toBe(false);
    expect(fromAuto("WebFetch", { url: "https://x.example" }, undefined)).toBe(true);
    // Plan mode from another mode keeps every card, as before.
    for (const pre of ["default", "acceptEdits", undefined] as (PermissionMode | undefined)[]) expect(autoModeDecides("WebFetch", "plan", "plan", {}, pre)).toBe(false);
  });
});

describe("PreToolUse hooks in auto mode", () => {
  it("a command, a fetch and an MCP call get no ask: the CLI's rules and classifier decide (no hook decision at all)", async () => {
    const root = repo();
    const { preBash, preOther } = hooksFor(ctx(root, { permissionMode: "auto" }));
    expect(await preBash(pre("Bash", { command: "mvn -v" }, root, "auto"), "t1", opts)).toEqual({});
    expect(await preBash(pre("Bash", { command: "echo hello > out.txt" }, root, "auto"), "t1", opts)).toEqual({});
    expect(await preOther(pre("WebFetch", { url: "https://docs.spring.io/x" }, root, "auto"), "t1", opts)).toEqual({});
    expect(await preOther(pre("mcp__github__create_issue", { title: "x" }, root, "auto"), "t1", opts)).toEqual({});
    // The app's own allow rules still answer `allow` (no classifier round trip).
    expect(decision(await preBash(pre("Bash", { command: "git status" }, root, "auto"), "t1", opts)).decision).toBe("allow");
  });

  it("the default mode, and auto mode the CLI could not start, still ask", async () => {
    const root = repo();
    const def = hooksFor(ctx(root, { permissionMode: "default" }));
    expect(decision(await def.preBash(pre("Bash", { command: "mvn -v" }, root, "default"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    const fellBack = hooksFor(ctx(root, { permissionMode: "auto" }));
    expect(decision(await fellBack.preBash(pre("Bash", { command: "mvn -v" }, root, "default"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    const edits = hooksFor(ctx(root, { permissionMode: "acceptEdits" }));
    expect(decision(await edits.preOther(pre("WebFetch", { url: "https://x.example" }, root, "acceptEdits"), "t1", opts)).decision).toBe("ask");
  });

  it("SendMessage and AskUserQuestion keep their card", async () => {
    const root = repo();
    const { preOther } = hooksFor(ctx(root, { permissionMode: "auto" }));
    expect(decision(await preOther(pre("SendMessage", { to: "acme-b4", message: "done" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(decision(await preOther(pre("AskUserQuestion", { questions: [] }, root, "auto"), "t1", opts)).decision).toBe("ask");
  });

  // MARK: wave6 w6-terminal — §44.1
  it("EnterPlanMode gets no card in auto mode; ExitPlanMode still goes to the engine's plan card", async () => {
    const root = repo();
    const { preOther } = hooksFor(ctx(root, { permissionMode: "auto" }));
    expect(await preOther(pre("EnterPlanMode", {}, root, "auto"), "t1", opts)).toEqual({});
    expect(decision(await preOther(pre("ExitPlanMode", { plan: "# p" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    const def = hooksFor(ctx(root, { permissionMode: "default" }));
    expect(decision(await def.preOther(pre("EnterPlanMode", {}, root, "default"), "t1", opts)).decision).toBe("ask");
  });

  it("plan mode entered from auto: a fetch / search / reading MCP call is the CLI's; edits and writing commands stay denied", async () => {
    const root = repo();
    const c = ctx(root, { permissionMode: "plan", prePlanMode: "auto" });
    const { preEdit, preBash, preOther } = hooksFor(c);
    expect(await preOther(pre("WebFetch", { url: "https://docs.spring.io/x" }, root, "plan"), "t1", opts)).toEqual({});
    expect(await preOther(pre("WebSearch", { query: "x" }, root, "plan"), "t1", opts)).toEqual({});
    expect(await preOther(pre("mcp__github__list_issues", {}, root, "plan"), "t1", opts)).toEqual({});
    expect(decision(await preOther(pre("mcp__github__create_issue", { title: "x" }, root, "plan"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(decision(await preOther(pre("ExitPlanMode", { plan: "# p" }, root, "plan"), "t1", opts)).decision).toBe("ask");
    expect(decision(await preEdit(pre("Edit", { file_path: join(root, "README.md"), old_string: "a", new_string: "b" }, root, "plan"), "t1", opts))).toEqual({ decision: "deny", reason: PLAN_MODE_EDIT_REASON });
    expect(decision(await preBash(pre("Bash", { command: "rm -rf build" }, root, "plan"), "t1", opts))).toEqual({ decision: "deny", reason: PLAN_MODE_BASH_REASON });
    expect(decision(await preBash(pre("Bash", { command: "git status" }, root, "plan"), "t1", opts))).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    expect(decision(await preBash(pre("Bash", { command: "git commit -am x" }, root, "plan"), "t1", opts)).decision).toBe("deny");
    // Plan mode the user entered from the default mode keeps the cards.
    const fromDefault = hooksFor(ctx(root, { permissionMode: "plan", prePlanMode: "default" }));
    expect(decision(await fromDefault.preOther(pre("WebFetch", { url: "https://docs.spring.io/x" }, root, "plan"), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
  });

  it("a main-thread hook input reports the CLI's mode before anything is decided; a subagent's is its own", async () => {
    const root = repo();
    const seen: unknown[] = [];
    const c = ctx(root, { permissionMode: "auto", onCliMode: (m) => seen.push(m) });
    const { preOther, preBash } = hooksFor(c);
    await preOther(pre("WebFetch", { url: "https://x.example" }, root, "plan"), "t1", opts);
    await preBash(pre("Bash", { command: "ls" }, root, "plan"), "t1", opts);
    await preOther({ ...(pre("WebFetch", { url: "https://x.example" }, root, "plan") as object), agent_id: "a1" } as unknown as HookInput, "t1", opts);
    await preOther(pre("WebFetch", { url: "https://x.example" }, root), "t1", opts);
    expect(seen).toEqual(["plan", "plan"]);
  });

  it("deny still wins: the budget, EnterWorktree, Workflow and isolated agents; a git command that changes the repository keeps its card", async () => {
    const root = repo();
    const c = ctx(root, { permissionMode: "auto" });
    const { preBash, preOther } = hooksFor(c);
    expect(decision(await preBash(pre("Bash", { command: "git commit -am wip" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(decision(await preBash(pre("Bash", { command: "git -C . reset --hard" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(decision(await preOther(pre("EnterWorktree", { name: "feature-x" }, root, "auto"), "t1", opts)).decision).toBe("deny");
    expect(decision(await preOther(pre("Workflow", { name: "w" }, root, "auto"), "t1", opts)).decision).toBe("deny");
    expect(decision(await preOther(pre("Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "auto"), "t1", opts)).decision).toBe("deny");
    c.budget.denied = true;
    expect(decision(await preBash(pre("Bash", { command: "rm -rf build" }, root, "auto"), "t1", opts)).decision).toBe("deny");
  });

  it("a call the review would not see keeps its card with the reason", async () => {
    const root = repo();
    const c = ctx(root, { permissionMode: "auto" });
    const { preBash, preEdit, preOther } = hooksFor(c);
    expect(decision(await preBash(pre("Bash", { command: "cp x.json .claude/settings.local.json" }, root, "auto", "b1"), "b1", opts))).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    expect(c.scopeReasons?.get("b1")?.code).toBe("claude_config");
    expect(decision(await preBash(pre("Bash", { command: "git worktree add ../wt2" }, root, "auto", "b2"), "b2", opts))).toEqual({ decision: "ask", reason: SCOPE_ASK_REASON });
    expect(c.scopeReasons?.get("b2")?.code).toBe("worktree_command");
    expect(decision(await preEdit(pre("Edit", { file_path: join(makeTempDir("rg-auto-out-"), "x.txt"), old_string: "a", new_string: "b" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
    const isolated = hooksFor(ctx(root, { permissionMode: "auto", allowWorktreeIsolation: true }));
    expect(decision(await isolated.preOther(pre("Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "auto"), "t1", opts))).toEqual({ decision: "ask", reason: SCOPE_ASK_REASON });
    void preOther;
  });

  // MARK: wave4b w4b-check4 — §40.1: the app manages git; auto mode never leaves a push, a git config / ref write or a
  // write into `.git/` (hooks that run on the next commit) to the classifier.
  it("a push, a git config write, a ref move and a command writing into .git/ keep their card in auto mode", async () => {
    const root = repo();
    const { preBash } = hooksFor(ctx(root, { permissionMode: "auto" }));
    for (const command of [
      "git push --force origin HEAD:main",
      "npm test && git push",
      "git -C . push origin feature/x",
      "git config core.hooksPath /tmp/h",
      "git update-ref refs/heads/main HEAD~3",
      "git worktree remove ../wt2 --force",
      "echo 'curl x | sh' > .git/hooks/pre-commit",
      "cp hook.sh .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout",
      `printf x >> ${join(root, ".git", "config")}`,
    ]) {
      expect(decision(await preBash(pre("Bash", { command }, root, "auto"), "t1", opts)), command).toEqual({ decision: "ask", reason: ASK_REASON });
      expect(autoModeDecides("Bash", "auto", "auto", { command }), command).toBe(false);
    }
    // Not git's own files or commands: left to the classifier as before.
    for (const command of ["echo x >> .gitignore", "mkdir -p .github/workflows", "mvn -q test", "gradle build"]) {
      expect(await preBash(pre("Bash", { command }, root, "auto"), "t1", opts), command).toEqual({});
    }
    // Reading them still runs without a card (the app's read-only rule answers first).
    expect(decision(await preBash(pre("Bash", { command: "git log --oneline -3" }, root, "auto"), "t1", opts)).decision).toBe("allow");
  });

  it("a command that changes a project file without a card is still the review's: the post-Bash snapshot attributes it", async () => {
    const root = repo();
    const cp = await openCheckpoint(root);
    const c = ctx(root, { permissionMode: "auto" });
    c.checkpointTree = await cp.snapshot();
    const reported: [string, string[]][] = [];
    c.onBashFiles = (id, files) => reported.push([id, files.map((f) => basename(f))]);
    const { preBash, postBash } = hooksFor(c);
    expect(await preBash(pre("Bash", { command: "echo hello > out.txt" }, root, "auto", "b1"), "b1", opts)).toEqual({});
    write(root, "out.txt", "hello\n");
    await postBash({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hello > out.txt" }, tool_response: {}, session_id: "s", transcript_path: "", cwd: root, tool_use_id: "b1" } as unknown as HookInput, "b1", opts);
    expect(reported).toEqual([["b1", ["out.txt"]]]);
    expect(c.budget.files.size).toBe(1); // and it counts against the turn's budget
  });
});

describe("auto-mode notices", () => {
  it("a classifier denial → auto_mode_denied with the call and the reason; other denials → nothing", () => {
    expect(autoModeDeniedNotice({ tool_name: "Bash", decision_reason_type: "classifier", decision_reason: "[Security Weaken]" }, { command: "mvn -v" })).toEqual({
      code: "auto_mode_denied",
      message: "Auto mode blocked: mvn -v — [Security Weaken]",
      detail: "mvn -v — [Security Weaken]",
      toolName: "Bash",
    });
    expect(autoModeDeniedNotice({ tool_name: "WebFetch", decision_reason_type: "classifier" }, { url: "https://x.example/a" })?.detail).toBe("https://x.example/a");
    expect(autoModeDeniedNotice({ tool_name: "mcp__x__y", decision_reason_type: "classifier" })?.detail).toBe("mcp__x__y");
    expect(autoModeDeniedNotice({ tool_name: "Bash", decision_reason_type: "rule", decision_reason: "deny rule" }, { command: "ls" })).toBeNull();
    expect(isAutoModeNotice("auto_mode_denied")).toBe(true);
    expect(isAutoModeNotice("cli_notice")).toBe(false);
  });

  it("the call text is one masked line", () => {
    expect(autoCallText("Bash", { command: "curl -H 'Authorization: Bearer abc.def' https://x\nsecond line" })).toBe("curl -H 'Authorization: Bearer ***' https://x");
    expect(autoCallText("Bash", { command: "echo " + "ab ".repeat(200) }).length).toBe(160);
    expect(autoCallText("Bash", undefined)).toBe("");
  });

  it("the CLI refusing auto mode for the model → the refusal auto_mode_unavailable; other errors pass", () => {
    const r = autoModeRefusal("auto", new Error("Cannot set permission mode to auto: auto mode unavailable for this model"));
    expect(r).toBeInstanceOf(CommandRefused);
    expect(r?.code).toBe("auto_mode_unavailable");
    expect(autoModeRefusal("plan", new Error("auto mode unavailable"))).toBeNull();
    expect(autoModeRefusal("auto", new Error("session closed"))).toBeNull();
  });
});

function session(mode: PermissionMode, queryOverrides: Partial<Query> = {}, extra: Record<string, unknown> = {}): { s: ClaudeSession; events: SessionEvent[]; feed: (m: unknown) => void } {
  const events: SessionEvent[] = [];
  const queryFn = (_args: { options?: Options }): Query => {
    let done: () => void = () => {};
    const ended = new Promise<void>((r) => (done = r));
    return {
      async next() {
        await ended;
        return { done: true, value: undefined };
      },
      async return() {
        done();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      initializationResult: () => new Promise(() => {}),
      ...queryOverrides,
    } as unknown as Query;
  };
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", permissionMode: mode, ...extra },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
  });
  sessions.push(s);
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: unknown) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m as SDKMessage);
  return { s, events, feed };
}

const errors = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error");
const sys = (subtype: string, extra: Record<string, unknown>) => ({ type: "system", subtype, uuid: "u", session_id: "s1", ...extra });
const init = (permissionMode: string) => sys("init", { model: "claude-haiku-4-5", cwd: "/tmp", tools: [], mcp_servers: [], slash_commands: [], permissionMode, apiKeySource: "none", output_style: "default" });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s1",
  uuid: "u",
  message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } },
});

describe("ClaudeSession in auto mode (§39.5)", () => {
  it("a classifier denial (system/permission_denied) → one auto_mode_denied notice naming the command", async () => {
    const { s, events, feed } = session("auto");
    await s.start();
    feed(toolUse("toolu_1", "Bash", { command: "mvn -v", description: "Print Maven version" }));
    feed(sys("permission_denied", { tool_name: "Bash", tool_use_id: "toolu_1", decision_reason_type: "classifier", decision_reason: "[Security Weaken]", message: "Permission for this action was denied by the Claude Code auto mode classifier." }));
    expect(errors(events)).toEqual([
      { type: "error", fatal: false, code: "auto_mode_denied", toolName: "Bash", detail: "mvn -v — [Security Weaken]", message: "Auto mode blocked: mvn -v — [Security Weaken]" },
    ]);
  });

  it("asked for auto, the CLI started in default (model / policy) → one auto_mode_unavailable notice per session", async () => {
    const a = session("auto");
    await a.s.start();
    a.feed(init("default"));
    a.feed(init("default")); // every turn's init: said once
    expect(errors(a.events).map((e) => [e.code, e.detail])).toEqual([["auto_mode_unavailable", "default"]]);
    const b = session("auto");
    await b.s.start();
    b.feed(init("auto"));
    const c = session("default");
    await c.s.start();
    c.feed(init("default"));
    expect([...errors(b.events), ...errors(c.events)]).toEqual([]);
  });

  it("setPermissionMode('auto') the CLI refuses for the model → CommandRefused auto_mode_unavailable; the hooks keep the old mode", async () => {
    const { s } = session("default", {
      setPermissionMode: async () => {
        throw new Error("Cannot set permission mode to auto: auto mode unavailable for this model");
      },
    } as Partial<Query>);
    await s.start();
    await expect(s.setPermissionMode("auto")).rejects.toMatchObject({ code: "auto_mode_unavailable" });
    expect((s as unknown as { hookCtx: HookContext }).hookCtx.permissionMode).toBe("default");
  });
});

// MARK: wave6 w6-terminal — §44.1
describe("ClaudeSession follows the CLI into plan mode (§44.1)", () => {
  const hookCtxOf = (s: ClaudeSession) => (s as unknown as { hookCtx: HookContext }).hookCtx;
  const modeEvents = (events: SessionEvent[]) => events.filter((e) => e.type === "permission_mode");

  it("system/status{permissionMode: plan} (EnterPlanMode ran) → the plan rules, the mode before kept, the engine told once", async () => {
    const { s, events, feed } = session("auto");
    await s.start();
    feed(sys("status", { status: null, permissionMode: "plan" }));
    feed(sys("status", { status: null, permissionMode: "plan" }));
    expect(modeEvents(events)).toEqual([{ type: "permission_mode", mode: "plan", prePlanMode: "auto" }]);
    expect(hookCtxOf(s).permissionMode).toBe("plan");
    expect(hookCtxOf(s).prePlanMode).toBe("auto");
    // Leaving plan mode is never followed (plan approval and the mode menu are the user's).
    feed(sys("status", { status: null, permissionMode: "auto" }));
    expect(hookCtxOf(s).permissionMode).toBe("plan");
    // The next turn's init says plan as well: no auto_mode_unavailable notice for it, no second event.
    feed(init("plan"));
    expect(errors(events)).toEqual([]);
    expect(modeEvents(events)).toHaveLength(1);
  });

  it("a turn's system/init in plan mode, or a main-thread hook input in it, is followed the same way", async () => {
    const a = session("default");
    await a.s.start();
    a.feed(init("plan"));
    expect(modeEvents(a.events)).toEqual([{ type: "permission_mode", mode: "plan", prePlanMode: "default" }]);
    const b = session("auto");
    await b.s.start();
    const preOther = buildHooks(hookCtxOf(b.s)).PreToolUse![2]!.hooks[0]!;
    // The fetch right after EnterPlanMode: plan mode from auto — the CLI judges it, no card.
    expect(await preOther(pre("WebFetch", { url: "https://docs.spring.io/x" }, "/tmp", "plan"), "t1", opts)).toEqual({});
    expect(hookCtxOf(b.s).permissionMode).toBe("plan");
    expect(modeEvents(b.events)).toEqual([{ type: "permission_mode", mode: "plan", prePlanMode: "auto" }]);
    // auto ↔ default stays the CLI's fallback (§39.5), never followed.
    const c = session("auto");
    await c.s.start();
    c.feed(sys("status", { status: null, permissionMode: "default" }));
    expect(hookCtxOf(c.s).permissionMode).toBe("auto");
    expect(modeEvents(c.events)).toEqual([]);
  });

  it("the CLI's report of the engine's own switch is no news; a switch into plan keeps the mode before, out of it forgets it", async () => {
    let echo: (m: unknown) => void = () => {};
    const { s, events, feed } = session("auto", {
      setPermissionMode: async (mode: string) => echo(sys("status", { status: null, permissionMode: mode })),
    } as unknown as Partial<Query>);
    echo = feed;
    await s.start();
    await s.setPermissionMode("plan");
    expect(modeEvents(events)).toEqual([]);
    expect(hookCtxOf(s).prePlanMode).toBe("auto");
    await s.setPermissionMode("auto");
    expect(hookCtxOf(s).prePlanMode).toBeUndefined();
    expect(hookCtxOf(s).permissionMode).toBe("auto");
  });

  it("outside a turn of ours a plan-mode report is not followed (a late report of the engine's own switch); the next turn's init is", async () => {
    const { s, events, feed } = session("auto");
    await s.start();
    const turn = (on: boolean) => (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(on);
    turn(false);
    feed(sys("status", { status: null, permissionMode: "plan" }));
    expect(hookCtxOf(s).permissionMode).toBe("auto");
    expect(modeEvents(events)).toEqual([]);
    turn(true);
    feed(init("plan"));
    expect(modeEvents(events)).toEqual([{ type: "permission_mode", mode: "plan", prePlanMode: "auto" }]);
  });

  it("in plan mode entered from auto, what the classifier blocked still names the call", async () => {
    const { s, events, feed } = session("auto");
    await s.start();
    feed(sys("status", { status: null, permissionMode: "plan" })); // Claude's EnterPlanMode
    feed(toolUse("toolu_9", "WebFetch", { url: "https://docs.spring.io/x", prompt: "read it" }));
    feed(sys("permission_denied", { tool_name: "WebFetch", tool_use_id: "toolu_9", decision_reason_type: "classifier", decision_reason: "[Exfiltration]" }));
    expect(errors(events).map((e) => [e.code, e.detail])).toEqual([["auto_mode_denied", "https://docs.spring.io/x — [Exfiltration]"]]);
  });

  it("a chat restarted in plan mode from auto keeps the plan-from-auto rules", async () => {
    const { s } = session("plan", {}, { prePlanMode: "auto" });
    expect(hookCtxOf(s).prePlanMode).toBe("auto");
    const { s: plain } = session("auto", {}, { prePlanMode: "default" });
    expect(hookCtxOf(plain).prePlanMode).toBeUndefined();
  });
});
