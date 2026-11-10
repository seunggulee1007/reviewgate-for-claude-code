import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { gitWorktreeAddTarget } from "../src/session/reviewScope.js";
import { GIT_ASK_REASON } from "../src/session/hooks.js";
import { bashPath, makeRepo, removeDir, sh } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.4 (audit market-01): Claude Code's own worktree isolation (EnterWorktree, Agent `isolation:
 * "worktree"`, a Workflow whose agents use it) and a `git worktree add` / `cd` into another worktree put Claude's edits where
 * this window's review never sees them. M05b: EnterWorktree runs and the chat follows it (§39.4: a card that can follow in
 * the default mode, the CLI's call in auto mode); isolated agents run (a card outside auto mode) unless the user turned them
 * off, and keep a warning; a Workflow runs in this folder like an Agent.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function repo(): string {
  const root = realpathSync(makeRepo());
  dirs.push(root);
  return root;
}

function ctx(root: string, over: Partial<HookContext> = {}): HookContext & { notices: unknown[] } {
  const notices: unknown[] = [];
  return {
    budget: new BudgetState({ maxFiles: 10, maxLines: 400 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    emit: () => {},
    log: () => {},
    onScopeNotice: (n) => notices.push(n),
    notices,
    ...over,
  };
}

function hookInput(event: "PreToolUse" | "PostToolUse", toolName: string, toolInput: Record<string, unknown>, cwd: string, toolUseId = "t1", extra: Record<string, unknown> = {}): HookInput {
  return { hook_event_name: event, tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId, ...extra } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

/** Every PreToolUse hook whose matcher takes the tool, in order; the first deny wins, else the last decision. */
async function pre(c: HookContext, toolName: string, input: Record<string, unknown>, cwd: string, toolUseId = "t1"): Promise<{ decision?: string; reason?: string }> {
  let out: { decision?: string; reason?: string } = {};
  for (const m of buildHooks(c).PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const d = decision(await (h as HookCallback)(hookInput("PreToolUse", toolName, input, cwd, toolUseId), toolUseId, opts));
      if (d.decision === "deny") return d;
      if (d.decision) out = d;
    }
  }
  return out;
}

/** The PreToolUse hook that takes the tool, its raw answer (`updatedInput`, `additionalContext`). */
async function preRaw(c: HookContext, toolName: string, input: Record<string, unknown>, cwd: string, toolUseId: string): Promise<unknown> {
  const m = buildHooks(c).PreToolUse!.find((x) => !x.matcher || new RegExp(`^(${x.matcher})$`).test(toolName))!;
  return (m.hooks[0] as HookCallback)(hookInput("PreToolUse", toolName, input, cwd, toolUseId), toolUseId, opts);
}

async function post(c: HookContext, toolName: string, input: Record<string, unknown>, cwd: string, toolUseId: string, response: unknown = {}): Promise<void> {
  for (const m of buildHooks(c).PostToolUse ?? []) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) await (h as HookCallback)(hookInput("PostToolUse", toolName, input, cwd, toolUseId, { tool_response: response }), toolUseId, opts);
  }
}

describe("worktree tools (§33.4, audit market-01)", () => {
  it("M05b: EnterWorktree is never denied — a card that can follow in the default mode, the CLI's call in auto mode; once it ran the engine hears where it went", async () => {
    const root = repo();
    const target = join(root, ".claude", "worktrees", "feature-x");
    const c = ctx(root);
    expect(await pre(c, "EnterWorktree", { name: "feature-x" }, root, "e1")).toEqual({ decision: "ask", reason: "ReviewGate: works outside this window's review — needs approval" });
    // §39.4: `worktree_command` with the path where it goes — the card offers "허용하고 따라가기".
    expect(c.scopeReasons?.get("e1")).toMatchObject({ code: "worktree_command", path: target });
    expect(c.scopeWatches?.get("e1")?.worktree).toMatchObject({ path: target, before: [expect.objectContaining({ path: root })] });
    // An existing worktree by its path; a random name names none (the result says where).
    await pre(c, "EnterWorktree", { path: "../acme-wt" }, root, "e2");
    expect(c.scopeReasons?.get("e2")).toMatchObject({ code: "worktree_command", path: join(dirname(root), "acme-wt") });
    await pre(c, "EnterWorktree", {}, root, "e3");
    expect(c.scopeReasons?.get("e3")).toEqual({ code: "worktree_command", message: expect.stringMatching(/moves into a git worktree/) });
    // It ran (the CLI made the worktree): the notice carries the result's path and branch and the worktrees before it.
    sh(root, "worktree", "add", "-q", "-b", "worktree-feature-x", target);
    await post(c, "EnterWorktree", { name: "feature-x" }, root, "e1", { worktreePath: target, worktreeBranch: "worktree-feature-x", message: "ok" });
    expect(c.notices).toEqual([
      { code: "worktree_outside_review", toolName: "EnterWorktree", toolUseId: "e1", path: target, branch: "worktree-feature-x", reasonCode: "worktree_command", worktreesBefore: [expect.objectContaining({ path: root })] },
    ]);
    expect(c.scopeWatches?.has("e1")).toBe(false);
    // Auto mode: no card (the engine moves the chat once it ran); no notice of a block either.
    const auto = ctx(root, { permissionMode: "auto" });
    expect(await pre(auto, "EnterWorktree", { name: "feature-y" }, root, "e4")).toEqual({});
    expect(auto.scopeReasons?.has("e4") ?? false).toBe(false);
    expect(auto.scopeWatches?.get("e4")?.worktree?.path).toBe(join(root, ".claude", "worktrees", "feature-y"));
    expect(auto.notices).toEqual([]);
  });

  it("M05b: a subagent's EnterWorktree moves only that agent — an isolated agent's card and row, never the chat's follow", async () => {
    const root = repo();
    const target = join(root, ".claude", "worktrees", "agent-wt");
    const sub = (c: HookContext, event: "PreToolUse" | "PostToolUse", id: string, response?: unknown) =>
      buildHooks(c)[event]!.filter((m) => !m.matcher || new RegExp(`^(${m.matcher})$`).test("EnterWorktree")).map((m) => m.hooks[0] as HookCallback).map((h) =>
        h(hookInput(event, "EnterWorktree", { name: "agent-wt" }, root, id, { agent_id: "a1", ...(response ? { tool_response: response } : {}) }), id, opts));
    const c = ctx(root);
    const [out] = await Promise.all(sub(c, "PreToolUse", "s1"));
    expect(decision(out).decision).toBe("ask");
    expect(c.scopeReasons?.get("s1")).toMatchObject({ code: "worktree_isolation", path: target });
    expect(c.scopeWatches?.has("s1") ?? false).toBe(false);
    await Promise.all(sub(c, "PostToolUse", "s1", { worktreePath: target, worktreeBranch: "worktree-agent-wt" }));
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Agent", toolUseId: "s1", path: target, branch: "worktree-agent-wt", reasonCode: "worktree_isolation" }]);
    const auto = ctx(root, { permissionMode: "auto" });
    const [autoOut] = await Promise.all(sub(auto, "PreToolUse", "s2"));
    expect(autoOut).toEqual({});
    // The user turned isolated agents off: a subagent moving itself into a worktree is one — denied in every mode, with the
    // isolated agent's notice; the chat's own EnterWorktree is not an isolated agent and still reaches its card.
    for (const mode of ["default", "auto"] as const) {
      const off = ctx(root, { allowWorktreeIsolation: false, ...(mode === "auto" ? { permissionMode: "auto" as const } : {}) });
      const [denied] = await Promise.all(sub(off, "PreToolUse", "s3"));
      expect(decision(denied).decision, mode).toBe("deny");
      expect(decision(denied).reason, mode).toMatch(/turned off agents that run outside this folder/);
      expect(off.notices, mode).toEqual([{ code: "worktree_blocked", toolName: "Agent", toolUseId: "s3", path: target }]);
      expect(off.scopeReasons?.has("s3") ?? false, mode).toBe(false);
    }
    const chatOff = ctx(root, { allowWorktreeIsolation: false });
    expect((await pre(chatOff, "EnterWorktree", { name: "feature-z" }, root, "s4")).decision).toBe("ask");
    expect(chatOff.scopeReasons?.get("s4")?.code).toBe("worktree_command");
  });

  it("M05b: ExitWorktree — after it ran the engine hears where the CLI went back; remove keeps the worktree this window reviews; discarding another's work asks", async () => {
    const root = repo();
    const wt = join(root, ".claude", "worktrees", "feature-x");
    sh(root, "worktree", "add", "-q", "-b", "feature-x", wt);
    // In the window on the worktree (the chat followed Claude here): `remove` becomes `keep`, and Claude is told why.
    const here = ctx(realpathSync(wt), { permissionMode: "auto" });
    const out = await preRaw(here, "ExitWorktree", { action: "remove", discard_changes: true }, realpathSync(wt), "x1");
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { action: "keep" }, additionalContext: expect.stringMatching(/kept this worktree/) } });
    expect((out as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput.updatedInput).not.toHaveProperty("discard_changes");
    expect(await preRaw(here, "ExitWorktree", { action: "keep" }, realpathSync(wt), "x2")).toEqual({});
    await post(here, "ExitWorktree", { action: "keep" }, realpathSync(wt), "x2", { action: "keep", originalCwd: root, worktreePath: wt, message: "ok" });
    expect(here.notices).toEqual([{ code: "worktree_exited", toolName: "ExitWorktree", toolUseId: "x2", path: root }]);
    // In the main checkout (the chat never followed): removing a worktree with its uncommitted work thrown away is the §46 card.
    const main = ctx(root, { permissionMode: "auto" });
    expect(await pre(main, "ExitWorktree", { action: "remove", discard_changes: true }, root, "x3")).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(main.scopeReasons?.get("x3")?.code).toBe("git_command");
    expect(await pre(main, "ExitWorktree", { action: "remove" }, root, "x4")).toEqual({});
  });

  it("isolated agents: a card by default, the CLI's call in auto mode, denied when the user turned them off; a Workflow runs like an Agent", async () => {
    const root = repo();
    const off = ctx(root, { allowWorktreeIsolation: false, autoAllowTools: new Set(["Agent", "Workflow"]) });
    expect((await pre(off, "Workflow", { script: "agent('x', { isolation: 'worktree' })" }, root)).decision).toBe("deny");
    expect((await pre(off, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a1")).decision).toBe("deny");
    expect((await pre(off, "Task", { description: "d", prompt: "p", isolation: "remote" }, root, "a2")).decision).toBe("deny");
    expect((await pre(off, "Agent", { description: "d", prompt: "p", cwd: join(root, "..") }, root, "a3")).decision).toBe("deny");
    expect(off.notices.map((n) => (n as { code: string; toolName: string }).toolName)).toEqual(["Workflow", "Agent", "Task", "Agent"]);
    // A plain subagent (also one pinned to a folder of the project) and a Workflow in this folder are unaffected.
    expect((await pre(off, "Agent", { description: "d", prompt: "p" }, root, "a4")).decision).toBeUndefined();
    expect((await pre(off, "Agent", { description: "d", prompt: "p", cwd: join(root, "src") }, root, "a5")).decision).toBeUndefined();
    expect((await pre(off, "Workflow", { script: "export const meta = {}; await agent('review the diff')" }, root, "w0")).decision).toBeUndefined();
    expect((await pre(off, "Workflow", { script: "const r = await agent('review'); return ok ? r[0] : null" }, root, "w01")).decision).toBeUndefined();
    // Release-2 review: unless the script provably says nothing of isolation — a quoted key, a variable, spread options, its
    // args, a script built at run time, a named or file workflow (not read) all count.
    for (const [id, input] of [
      ["w2", { script: `await agent('x', { "isolation": "worktree" })` }],
      ["w3", { script: `const iso = "worktree"; await agent('x', { isolation: iso })` }],
      ["w4", { script: `const opts = { isolation: 'remote' }; await agent('x', { ...opts })` }],
      ["w5", { script: "await agent('x', args.opts)", args: { opts: { isolation: "worktree" } } }],
      ["w6", { script: `await agent('x', { ["iso" + "lation"]: "worktree" })` }],
      ["w7", { script: `await agent('x', { "\u0069solation": "worktree" })` }],
      ["w8", { script: "await agent('x', eval(src))" }],
      ["w9", { name: "fanout" }],
      ["w10", { file: ".claude/workflows/fanout.js" }],
    ] as const) {
      expect((await pre(off, "Workflow", input, root, id)).decision, id).toBe("deny");
    }

    // The default (allowWorktreeIsolation absent = on): the card with the reason.
    const on = ctx(root, { autoAllowTools: new Set(["Agent", "Workflow"]) });
    expect((await pre(on, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a6")).decision).toBe("ask");
    expect((await pre(on, "Workflow", { script: "await agent('x', { isolation: \"worktree\" })" }, root, "w1")).decision).toBe("ask");
    expect(on.notices).toEqual([]);
    // When it ran: the warning stays (its changes are outside this window's review).
    await post(on, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a6", { worktreePath: join(root, ".claude", "worktrees", "agent-1"), worktreeBranch: "worktree-agent-1" });
    expect(on.notices).toEqual([{ code: "worktree_outside_review", toolName: "Agent", toolUseId: "a6", path: join(root, ".claude", "worktrees", "agent-1"), branch: "worktree-agent-1", reasonCode: "worktree_isolation" }]);
    // Auto mode: no card — the same row once it ran (§39.3's agent card says where it worked).
    const auto = ctx(root, { permissionMode: "auto" });
    expect(await pre(auto, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a7")).toEqual({});
    await post(auto, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a7", { worktreePath: join(root, ".claude", "worktrees", "agent-2"), worktreeBranch: "worktree-agent-2" });
    expect(auto.notices).toEqual([{ code: "worktree_outside_review", toolName: "Agent", toolUseId: "a7", path: join(root, ".claude", "worktrees", "agent-2"), branch: "worktree-agent-2", reasonCode: "worktree_isolation" }]);
  });

  it("gitWorktreeAddTarget parses the new worktree's path (global options, -b / --reason values, --)", () => {
    // The target is absolute for the host (`D:\\wt2` on Windows), like every path the guard compares.
    const cwd = resolve("/repo");
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "../wt2", "-b", "x"], cwd)).toBe(resolve("/wt2"));
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "-b", "feat", ".claude/worktrees/a"], cwd)).toBe(resolve("/repo/.claude/worktrees/a"));
    expect(gitWorktreeAddTarget(["git", "-C", "/other", "worktree", "add", "--lock", "--reason", "why", "wt"], cwd)).toBe(resolve("/other/wt"));
    expect(gitWorktreeAddTarget(["git", "--no-pager", "worktree", "add", "--", "-odd"], cwd)).toBe(resolve("/repo/-odd"));
    expect(gitWorktreeAddTarget(["git", "worktree", "list"], cwd)).toBeUndefined();
    // `$HOME` / `${HOME}` and other variables the environment defines are expanded; an unknown one stays as written.
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "$HOME/worktrees/acme-42"], cwd)).toBe(join(homedir(), "worktrees/acme-42"));
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "${HOME}/wt"], cwd)).toBe(join(homedir(), "wt"));
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "$RG_SURELY_UNSET_VAR/wt"], cwd)).toBe(resolve("/repo/$RG_SURELY_UNSET_VAR/wt"));
    expect(gitWorktreeAddTarget(["git", "status"], cwd)).toBeUndefined();
    expect(gitWorktreeAddTarget(["git", "worktree", "add"], cwd)).toBeNull();
    // git by its name (§20 programName): Git Bash's git.exe, any case, a full path in either spelling
    expect(gitWorktreeAddTarget(["git.exe", "worktree", "add", "../wt2"], cwd)).toBe(resolve("/wt2"));
    expect(gitWorktreeAddTarget(["GIT", "worktree", "add", "-b", "x", "../wt3"], cwd)).toBe(resolve("/wt3"));
    expect(gitWorktreeAddTarget(["C:\\Program Files\\Git\\cmd\\git.exe", "-C", "/other", "worktree", "add", "wt"], cwd)).toBe(resolve("/other/wt"));
    expect(gitWorktreeAddTarget(["/c/Program Files/Git/cmd/git.exe", "worktree", "add", "../wt4"], cwd)).toBe(resolve("/wt4"));
    expect(gitWorktreeAddTarget(["gitk", "worktree", "add", "../wt2"], cwd)).toBeUndefined();
  });

  it("`git worktree add` always reaches a card with a reason (allow patterns do not apply) and warns once it ran", async () => {
    const root = repo();
    const c = ctx(root, { bashAllowPatterns: ["Bash(git *)"] });
    const command = "git worktree add -b feat ../feat-wt";
    expect((await pre(c, "Bash", { command }, root, "b1")).decision).toBe("ask");
    expect(c.scopeReasons?.get("b1")).toMatchObject({ code: "worktree_command", path: join(dirname(root), "feat-wt") });
    // Other git commands still ride on the pattern.
    expect((await pre(c, "Bash", { command: "git fetch origin" }, root, "b2")).decision).toBe("allow");
    await post(c, "Bash", { command }, root, "b1");
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: join(dirname(root), "feat-wt"), reasonCode: "worktree_command" }]);
    // Git Bash's git.exe is git (§20 programName): before, `git.exe worktree add` reached no worktree card.
    expect((await pre(c, "Bash", { command: "git.exe worktree add -b feat2 ../feat2-wt" }, root, "b3")).decision).toBe("ask");
    expect(c.scopeReasons?.get("b3")).toMatchObject({ code: "worktree_command", path: join(dirname(root), "feat2-wt") });
  });

  it("§39.4: a worktree of another repository (the command cds there) is marked otherRepository — no chat can follow it", async () => {
    const root = repo();
    const other = repo();
    const c = ctx(root);
    const target = join(dirname(other), "other-42");
    const command = `cd ${bashPath(other)} && git fetch origin develop 2>&1 | tail -2 && git worktree add --no-track -b feature/PAY-42 ${bashPath(target)} origin/develop 2>&1 | tail -3`;
    expect((await pre(c, "Bash", { command }, root, "b1")).decision).toBe("ask");
    expect(c.scopeReasons?.get("b1")).toMatchObject({ code: "worktree_command", path: target, otherRepository: true });
    // The same command in this repository is followable.
    const own = `cd ${bashPath(root)} && git worktree add -b feature/PAY-43 ${bashPath(join(dirname(root), "own-43"))}`;
    await pre(c, "Bash", { command: own }, root, "b2");
    expect(c.scopeReasons?.get("b2")).toMatchObject({ code: "worktree_command" });
    expect(c.scopeReasons?.get("b2")).not.toHaveProperty("otherRepository");
  });

  it("a command that cds into a nested worktree, or runs while the shell sits in one, gets a card with the reason", async () => {
    const root = repo();
    const wt = join(root, ".claude", "worktrees", "wt1");
    sh(root, "worktree", "add", "-q", "-b", "wt1", wt);
    const c = ctx(root, { bashAllowPatterns: ["Bash(sed:*)", "Bash(cd:*)", "Bash(npm test:*)"] });
    expect((await pre(c, "Bash", { command: "cd .claude/worktrees/wt1 && sed -i '' s/a/b/ README.md" }, root, "c1")).decision).toBe("ask");
    expect(c.scopeReasons?.get("c1")).toMatchObject({ code: "nested_repository", path: wt });
    expect((await pre(c, "Bash", { command: "npm test" }, wt, "c2")).decision).toBe("ask");
    expect(c.scopeReasons?.get("c2")).toMatchObject({ code: "nested_repository", path: wt });
    // Reading there is harmless: the read-only rule still applies.
    expect((await pre(c, "Bash", { command: "git status" }, wt, "c3")).decision).toBe("allow");
    // Elsewhere nothing changes: the pattern allows it.
    expect((await pre(c, "Bash", { command: "npm test" }, root, "c5")).decision).toBe("allow");
    // A sibling worktree outside the root is "another worktree" — also one Claude just created this turn.
    const sibling = join(dirname(root), `${basename(root)}-sib`);
    dirs.push(sibling);
    // Quoted as a Windows path is written in Git Bash (`"C:\…"`; unquoted, the shell would eat its backslashes).
    const add = `git worktree add -b sib "${sibling}"`;
    expect((await pre(c, "Bash", { command: add }, root, "c6")).decision).toBe("ask");
    sh(root, "worktree", "add", "-q", "-b", "sib", sibling); // what the approved command did
    await post(c, "Bash", { command: add }, root, "c6");
    expect((await pre(c, "Bash", { command: `cd "${sibling}" && npm test` }, root, "c4")).decision).toBe("ask");
    expect(c.scopeReasons?.get("c4")).toMatchObject({ code: "other_worktree", path: sibling });
  });
});

// ------------------------------------------------------------------ ClaudeSession

function capturingQuery(): { queryFn: (args: { options?: Options }) => Query; captured: { options?: Options } } {
  const captured: { options?: Options } = {};
  const queryFn = (args: { options?: Options }): Query => {
    captured.options = args.options;
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
    };
    return q as unknown as Query;
  };
  return { queryFn, captured };
}

function session(root: string, extra: Record<string, unknown> = {}, queryFn?: unknown): { s: ClaudeSession; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: root,
    settings: { budget: { maxFiles: 10, maxLines: 400 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "Budget: 10 files.", ...extra },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    ...(queryFn ? { queryFn: queryFn as never } : {}),
  });
  return { s, events };
}

describe("ClaudeSession worktree guard (§33.4)", () => {
  it("the engine's system instruction keeps Claude in this folder (the client's append is kept)", async () => {
    const root = repo();
    for (const allowWorktreeIsolation of [false, true]) {
      const { queryFn, captured } = capturingQuery();
      const { s } = session(root, { allowWorktreeIsolation }, queryFn);
      await s.start();
      const sp = captured.options!.systemPrompt as { type: string; append: string };
      expect(sp.append.startsWith("Budget: 10 files.")).toBe(true);
      expect(sp.append).toContain(root);
      // §39.4 / M05b: EnterWorktree works and the chat follows; `git worktree add` too — and a worktree-first skill must not
      // switch this checkout's branch instead.
      expect(sp.append).not.toMatch(/EnterWorktree is not available|never use EnterWorktree/i);
      expect(sp.append).toMatch(/use EnterWorktree, or run `git worktree add \.\.\/<repo>-<name> -b <branch>` \(never under \/tmp\)/);
      expect(sp.append).toMatch(/moves this chat into that worktree's window/);
      expect(sp.append).toMatch(/Do not switch this checkout's branch to start new work unless the user asked/);
      expect(sp.append).toMatch(/lists what they changed after the call/);
      if (allowWorktreeIsolation) expect(sp.append).toMatch(/Agents with `isolation` and the Workflow tool may run/);
      else expect(sp.append).toMatch(/turned off by the user/i);
      await s.dispose();
    }
  });

  it("canUseTool: the card carries the hook's reason and is never auto-allowed; an edit in a sibling worktree says other_worktree", async () => {
    const root = repo();
    const sibling = join(dirname(root), `${basename(root)}-sib2`);
    sh(root, "worktree", "add", "-q", "-b", "sib2", sibling);
    dirs.push(sibling);
    mkdirSync(join(sibling, "src"), { recursive: true });
    const { s, events } = session(root, { allowWorktreeIsolation: true, autoAllowTools: ["Agent"] });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const hooks = (s as unknown as { hookCtx: HookContext }).hookCtx;
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    const input = { description: "d", prompt: "p", isolation: "worktree" };
    expect((await pre(hooks, "Agent", input, root, "ag1")).decision).toBe("ask");
    void canUseTool("Agent", input, { ...opts, toolUseID: "ag1" } as never);
    void canUseTool("Write", { file_path: join(sibling, "src", "x.ts"), content: "x" }, { ...opts, toolUseID: "w1" } as never);
    for (let i = 0; i < 500 && events.filter((e) => e.type === "permission_request").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const reqs = events.filter((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(reqs.map((r) => [r.toolName, r.reason?.code, r.reason?.path]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["Agent", "worktree_isolation", undefined],
      ["Write", "other_worktree", sibling],
    ]);
  });

  it("canUseTool, isolated agents turned off (M05b): a subagent's EnterWorktree is denied; the chat's own reaches the card that can follow", async () => {
    const root = repo();
    const { s, events } = session(root, { allowWorktreeIsolation: false });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const hooks = (s as unknown as { hookCtx: HookContext }).hookCtx;
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    // (A card would leave the call pending: the race says so instead of waiting for an answer that never comes.)
    const subagent = canUseTool("EnterWorktree", { name: "agent-wt" }, { ...opts, toolUseID: "s1", agentID: "a1" } as never);
    expect(await Promise.race([subagent, new Promise((r) => setTimeout(() => r("a card is pending"), 3000))])).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/turned off agents that run outside this folder/),
    });
    expect((await pre(hooks, "EnterWorktree", { name: "feature-x" }, root, "e1")).decision).toBe("ask");
    void canUseTool("EnterWorktree", { name: "feature-x" }, { ...opts, toolUseID: "e1" } as never);
    for (let i = 0; i < 500 && !events.some((e) => e.type === "permission_request"); i++) await new Promise((r) => setTimeout(r, 10));
    const req = events.find((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(req?.toolName).toBe("EnterWorktree");
    expect(req?.reason).toMatchObject({ code: "worktree_command", path: join(root, ".claude", "worktrees", "feature-x") });
  });
});
