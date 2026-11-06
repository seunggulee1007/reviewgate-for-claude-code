import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import {
  ASK_REASON,
  buildHooks,
  configScopeReason,
  planModeBlocked,
  READ_ONLY_BASH_REASON,
  readOnlyContextOf,
  unpromptedBlocked,
  type HookContext,
} from "../src/session/hooks.js";
import { foreignRepoDir } from "../src/session/reviewScope.js";
import { sideToolDenyReason } from "../src/side/sideQuery.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §19.3, §33.4, §39.5 (r1-scope): next door without asking. Reading in the repository's other worktrees
 * needs no card; what changes outside this window's review is listed after the call.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

/** A repository (with `sub/`, a nested clone `vendor/lib`) and a sibling worktree `<root>-42` (with `src/`). */
function repoWithSibling(): { root: string; sibling: string; lib: string } {
  const root = realpathSync(makeRepo());
  dirs.push(root);
  mkdirSync(join(root, "sub"), { recursive: true });
  write(root, "sub/a.txt", "a\n");
  const lib = join(root, "vendor", "lib");
  mkdirSync(lib, { recursive: true });
  sh(lib, "init", "-q");
  const sibling = join(dirname(root), `${basename(root)}-42`);
  sh(root, "worktree", "add", "-q", "-b", "acme-42", sibling);
  dirs.push(sibling);
  mkdirSync(join(sibling, "src"), { recursive: true });
  return { root, sibling, lib };
}

function ctx(root: string, over: Partial<HookContext> = {}): HookContext & { notices: unknown[] } {
  const notices: unknown[] = [];
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
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

function hookInput(event: "PreToolUse" | "PostToolUse", toolName: string, toolInput: Record<string, unknown>, cwd: string, toolUseId: string, extra: Record<string, unknown> = {}): HookInput {
  return { hook_event_name: event, tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId, ...extra } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

async function preBash(c: HookContext, command: string, cwd: string, toolUseId: string, extra: Record<string, unknown> = {}): Promise<{ decision?: string; reason?: string }> {
  const hook = buildHooks(c).PreToolUse![1]!.hooks[0] as HookCallback;
  return decision(await hook(hookInput("PreToolUse", "Bash", { command }, cwd, toolUseId, extra), toolUseId, opts));
}

describe("§19.3: reading next door needs no card", () => {
  it("a cd / git -C into the repository's other worktree is read-only; doing something there keeps the card in default mode", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root);
    for (const [i, command] of [`cd ${sibling} && ls`, `cd ../${basename(sibling)} && ls && git log --oneline -1`, `git -C ${sibling} log --oneline -3`, `git -C ../${basename(sibling)} status`, "cd sub && git status 2>&1 | head"].entries()) {
      expect(await preBash(c, command, root, `r${i}`), command).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
      expect(c.scopeReasons?.get(`r${i}`), command).toBeUndefined();
    }
    expect(await preBash(c, `cd ${sibling} && ./mvnw -q compile`, root, "w1")).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("w1")).toMatchObject({ code: "other_worktree", path: sibling });
    // Outside the repository a cd is no read: an ordinary card, no scope reason (it is no worktree of this repository).
    expect(await preBash(c, `cd ${dirname(root)} && git status`, root, "e1")).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(c.scopeReasons?.get("e1")).toBeUndefined();
  });

  it("a nested repository of its own is foreign: a cd there is no read", async () => {
    const { root, sibling, lib } = repoWithSibling();
    const c = ctx(root);
    expect(foreignRepoDir(lib, root, [sibling])).toBe(true);
    expect(foreignRepoDir(join(lib, "src"), root, [sibling])).toBe(true);
    expect(foreignRepoDir(join(root, "sub"), root, [sibling])).toBe(false);
    expect(foreignRepoDir(join(sibling, "src"), root, [sibling])).toBe(false);
    expect(await preBash(c, "cd vendor/lib && git status", root, "n1")).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("n1")).toMatchObject({ code: "nested_repository", path: lib });
  });

  it("plan mode, the unprompted-turn guard, the settings-file check and side questions judge the command where it runs", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root);
    const ro = await readOnlyContextOf(c, root);
    expect(ro).toMatchObject({ cwd: root, root, sameRepoDirs: [sibling] });
    const input = { command: `cd ${sibling} && git status` };
    expect(planModeBlocked("Bash", input, { permissionMode: "plan", cwd: root }, ro)).toBeUndefined();
    expect(planModeBlocked("Bash", input, { permissionMode: "plan", cwd: root })).toMatch(/plan mode/);
    expect(unpromptedBlocked("Bash", input, { turnActive: false }, ro)).toBe(false);
    expect(unpromptedBlocked("Bash", input, { turnActive: false })).toBe(true);
    mkdirSync(join(root, ".claude"), { recursive: true });
    expect(configScopeReason("Bash", { command: "cd .claude && cat settings.json" }, root, root, {}, ro)).toBeNull();
    expect(configScopeReason("Bash", { command: "cd .claude && cat settings.json" }, root, root, {})?.code).toBe("claude_config");
    expect(sideToolDenyReason("Bash", { command: "cd sub && ls" }, { allowWeb: false, readOnly: ro })).toBeUndefined();
    expect(sideToolDenyReason("Bash", { command: "cd sub && ls" }, { allowWeb: false })).toBeDefined();
  });
});
