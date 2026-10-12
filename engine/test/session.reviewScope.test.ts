import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, NESTED_REASON, type HookContext } from "../src/session/hooks.js";
import { nestedRepoRoot } from "../src/session/reviewScope.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.3 (audit robustness-06): the snapshot records a submodule, a nested clone or a worktree under
 * the root as one gitlink line, so an edit inside one never reaches the review. Such edits are not auto-allowed: they
 * ask, the card says why, and an approved one is listed in `changedOutside` like an edit outside the project.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

/** A repository with a nested clone (`vendor/lib`), a worktree under `.claude/worktrees/wt1` and an uninitialized submodule entry (`libs/sub`). */
function repoWithNested(): string {
  const root = realpathSync(makeRepo());
  dirs.push(root);
  const lib = join(root, "vendor", "lib");
  mkdirSync(lib, { recursive: true });
  sh(lib, "init", "-q");
  write(lib, "lib.txt", "lib\n");
  sh(root, "worktree", "add", "-q", "-b", "wt1", join(root, ".claude", "worktrees", "wt1"));
  write(root, ".gitmodules", '[submodule "libs/sub"]\n\tpath = libs/sub\n\turl = https://example.com/sub.git\n');
  mkdirSync(join(root, "libs", "sub"), { recursive: true });
  return root;
}

function hookCtx(root: string): HookContext {
  return { budget: new BudgetState({ maxFiles: 10, maxLines: 400 }), cwd: root, root, ignorePatterns: [], autoAllowTools: new Set(), interrupted: false, emit: () => {}, log: () => {} };
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>, cwd: string, toolUseId = "t1"): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

describe("nested repositories under the root (§33.3, audit robustness-06)", () => {
  it("nestedRepoRoot finds a nested clone, a worktree and a submodule path; plain paths and the root itself are not nested", () => {
    const root = repoWithNested();
    expect(nestedRepoRoot(join(root, "vendor", "lib", "lib.txt"), root)).toBe(join(root, "vendor", "lib"));
    expect(nestedRepoRoot(join(root, "vendor", "lib", "deep", "new.txt"), root)).toBe(join(root, "vendor", "lib"));
    expect(nestedRepoRoot(join(root, ".claude", "worktrees", "wt1", "README.md"), root)).toBe(join(root, ".claude", "worktrees", "wt1"));
    expect(nestedRepoRoot(join(root, "libs", "sub", "x.java"), root)).toBe(join(root, "libs", "sub"));
    expect(nestedRepoRoot(join(root, "README.md"), root)).toBeNull();
    expect(nestedRepoRoot(join(root, "src", "a.git.ts"), root)).toBeNull();
    expect(nestedRepoRoot(join(root, "vendor", "other.txt"), root)).toBeNull();
    expect(nestedRepoRoot(root, root)).toBeNull();
  });

  it("the PreToolUse hook asks for an edit inside a nested repository and allows the rest of the root", async () => {
    const root = repoWithNested();
    const preEdit = buildHooks(hookCtx(root)).PreToolUse![0]!.hooks[0]!;
    for (const file of [join(root, "vendor", "lib", "lib.txt"), join(root, ".claude", "worktrees", "wt1", "README.md"), join(root, "libs", "sub", "x.java")]) {
      const out = await preEdit(preToolUse("Write", { file_path: file, content: "x\n" }, root), "t1", opts);
      expect(decision(out), file).toEqual({ decision: "ask", reason: NESTED_REASON });
    }
    expect(await preEdit(preToolUse("Write", { file_path: join(root, "src", "ok.ts"), content: "x\n" }, root), "t1", opts)).toEqual({});
  });

  it("canUseTool puts the nested-repository edit on the card with a reason; approved, it is listed in changedOutside", async () => {
    const root = repoWithNested();
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: root,
      settings: { budget: { maxFiles: 10, maxLines: 400 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
    });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    const nestedFile = join(root, ".claude", "worktrees", "wt1", "README.md");
    const pending = canUseTool("Edit", { file_path: nestedFile, old_string: "line1", new_string: "x" }, { ...opts, toolUseID: "e1" } as never);
    for (let i = 0; i < 500 && !events.some((e) => e.type === "permission_request"); i++) await new Promise((r) => setTimeout(r, 10));
    const req = events.find((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(req).toMatchObject({ toolName: "Edit", file: nestedFile, toolUseId: "e1", reason: { code: "nested_repository", path: join(root, ".claude", "worktrees", "wt1") } });
    expect(req!.reason!.message).toMatch(/nested/i);
    s.respondPermission(req!.requestId, true);
    expect(await pending).toMatchObject({ behavior: "allow" });
    // An edit inside the root but outside any nested repository is still auto-allowed (no card).
    expect(await canUseTool("Edit", { file_path: join(root, "README.md"), old_string: "a", new_string: "b" }, { ...opts, toolUseID: "e2" } as never)).toMatchObject({ behavior: "allow" });
    (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage);
    const end = events.find((e): e is Extract<SessionEvent, { type: "turn_end" }> => e.type === "turn_end");
    expect(end!.changedOutside).toEqual([nestedFile]);
  });
});
