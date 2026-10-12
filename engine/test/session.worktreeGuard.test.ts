import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { gitWorktreeAddTarget } from "../src/session/reviewScope.js";
import { makeRepo, removeDir, sh } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.4 (audit market-01): Claude Code's own worktree isolation (EnterWorktree, the Workflow tool,
 * Agent `isolation: "worktree"`) and a `git worktree add` / `cd` into another worktree put Claude's edits where this
 * window's review never sees them. EnterWorktree is denied; Workflow / isolated agents are denied unless
 * `allowWorktreeIsolation`, and then keep a warning; worktree commands in Bash always reach a card with a reason.
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
    interrupted: false,
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

async function post(c: HookContext, toolName: string, input: Record<string, unknown>, cwd: string, toolUseId: string, response: unknown = {}): Promise<void> {
  for (const m of buildHooks(c).PostToolUse ?? []) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) await (h as HookCallback)(hookInput("PostToolUse", toolName, input, cwd, toolUseId, { tool_response: response }), toolUseId, opts);
  }
}

describe("worktree tools (§33.4, audit market-01)", () => {
  it("EnterWorktree is always denied, with a notice the client can turn into 'open a workbench'", async () => {
    const root = repo();
    for (const allowWorktreeIsolation of [false, true]) {
      const c = ctx(root, { allowWorktreeIsolation });
      const d = await pre(c, "EnterWorktree", { name: "feature-x" }, root);
      expect(d.decision).toBe("deny");
      expect(d.reason).toMatch(/workbench/i);
      expect(c.notices).toEqual([{ code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t1", branch: "feature-x" }]);
    }
  });

  it("Workflow and Agent isolation are denied by default; allowWorktreeIsolation turns them into a card with a warning", async () => {
    const root = repo();
    const off = ctx(root, { autoAllowTools: new Set(["Agent", "Workflow"]) });
    expect((await pre(off, "Workflow", { script: "x" }, root)).decision).toBe("deny");
    expect((await pre(off, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a1")).decision).toBe("deny");
    expect((await pre(off, "Task", { description: "d", prompt: "p", isolation: "remote" }, root, "a2")).decision).toBe("deny");
    expect((await pre(off, "Agent", { description: "d", prompt: "p", cwd: join(root, "..") }, root, "a3")).decision).toBe("deny");
    expect(off.notices.map((n) => (n as { code: string; toolName: string }).toolName)).toEqual(["Workflow", "Agent", "Task", "Agent"]);
    // A plain subagent (also one pinned to a folder of the project) is unaffected.
    expect((await pre(off, "Agent", { description: "d", prompt: "p" }, root, "a4")).decision).toBeUndefined();
    expect((await pre(off, "Agent", { description: "d", prompt: "p", cwd: join(root, "src") }, root, "a5")).decision).toBeUndefined();

    const on = ctx(root, { allowWorktreeIsolation: true, autoAllowTools: new Set(["Agent", "Workflow"]) });
    expect((await pre(on, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a6")).decision).toBe("ask");
    expect((await pre(on, "Workflow", { script: "x" }, root, "w1")).decision).toBe("ask");
    expect(on.notices).toEqual([]);
    // When it ran: the warning stays (its changes are outside this window's review).
    await post(on, "Agent", { description: "d", prompt: "p", isolation: "worktree" }, root, "a6", { worktreePath: join(root, ".claude", "worktrees", "agent-1"), worktreeBranch: "worktree-agent-1" });
    expect(on.notices).toEqual([{ code: "worktree_outside_review", toolName: "Agent", toolUseId: "a6", path: join(root, ".claude", "worktrees", "agent-1"), branch: "worktree-agent-1", reasonCode: "worktree_isolation" }]);
  });

  it("gitWorktreeAddTarget parses the new worktree's path (global options, -b / --reason values, --)", () => {
    // The target is absolute for the host (`D:\\wt2` on Windows), like every path the guard compares.
    const cwd = resolve("/repo");
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "../wt2", "-b", "x"], cwd)).toBe(resolve("/wt2"));
    expect(gitWorktreeAddTarget(["git", "worktree", "add", "-b", "feat", ".claude/worktrees/a"], cwd)).toBe(resolve("/repo/.claude/worktrees/a"));
    expect(gitWorktreeAddTarget(["git", "-C", "/other", "worktree", "add", "--lock", "--reason", "why", "wt"], cwd)).toBe(resolve("/other/wt"));
    expect(gitWorktreeAddTarget(["git", "--no-pager", "worktree", "add", "--", "-odd"], cwd)).toBe(resolve("/repo/-odd"));
    expect(gitWorktreeAddTarget(["git", "worktree", "list"], cwd)).toBeUndefined();
    expect(gitWorktreeAddTarget(["git", "status"], cwd)).toBeUndefined();
    expect(gitWorktreeAddTarget(["git", "worktree", "add"], cwd)).toBeNull();
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
      // §39.4: a worktree may be created, said at once; the review follows only when the user moves the chat there.
      expect(sp.append).toMatch(/never use EnterWorktree/i);
      expect(sp.append).toMatch(/you may create it/i);
      expect(sp.append).toMatch(/move this chat into that worktree/i);
      expect(sp.append).toMatch(/workbench/i);
      if (allowWorktreeIsolation) expect(sp.append).toMatch(/allowed by the user/i);
      else expect(sp.append).toMatch(/blocks them/i);
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
});
