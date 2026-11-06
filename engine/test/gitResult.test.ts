import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import type { GitCommandResult } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * MARK: r1-git — docs/PROTOCOL.md §46: what Claude's git commands did, told after the call (`postGitCommand`): a stash that
 * took files out of the working tree is a chat row.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function repo(): string {
  const d = realpathSync(makeRepo());
  dirs.push(d);
  return d;
}

/** The Bash hooks around one call: PreToolUse, the command itself (`run`), then every PostToolUse hook in order. */
async function bashCall(ctx: HookContext, command: string, id: string, run: () => void, event: "PostToolUse" | "PostToolUseFailure" = "PostToolUse"): Promise<void> {
  const hooks = buildHooks(ctx);
  const base = { tool_name: "Bash", tool_input: { command }, session_id: "s", transcript_path: "", cwd: ctx.cwd, tool_use_id: id };
  await hooks.PreToolUse![1]!.hooks[0]!({ hook_event_name: "PreToolUse", ...base } as unknown as HookInput, id, opts);
  run();
  for (const h of (event === "PostToolUse" ? hooks.PostToolUse! : hooks.PostToolUseFailure!)[1]!.hooks) {
    await h({ hook_event_name: event, ...base, tool_response: {} } as unknown as HookInput, id, opts);
  }
}

function hookCtx(root: string, results: GitCommandResult[], over: Partial<HookContext> = {}): HookContext {
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    permissionMode: "auto",
    onGitCommand: (r) => results.push(r),
    emit: () => {},
    log: () => {},
    ...over,
  };
}

describe("postGitCommand: a stash that takes work out of the working tree", () => {
  it("names the files git stash put away; untracked ones stay unless -u", async () => {
    const root = repo();
    write(root, "README.md", "changed by claude\n");
    write(root, "other.txt", "changed too\n");
    const results: GitCommandResult[] = [];
    const ctx = hookCtx(root, results);
    await bashCall(ctx, "git stash", "s1", () => sh(root, "stash", "-q"));
    expect(results).toEqual([{ toolUseId: "s1", stashed: ["README.md", "other.txt"] }]);
    // untracked.txt (makeRepo's) went with -u.
    write(root, "README.md", "again\n");
    await bashCall(ctx, "git stash push -u -m wip", "s2", () => sh(root, "stash", "push", "-q", "-u", "-m", "wip"));
    expect(results[1]).toEqual({ toolUseId: "s2", stashed: ["README.md", "untracked.txt"] });
    expect(ctx.gitBefore?.size ?? 0).toBe(0);
  });

  it("nothing for a stash of a clean tree, a stash pop or a command that only mentions git stash", async () => {
    const root = repo();
    sh(root, "stash", "-q", "-u"); // makeRepo leaves untracked.txt: a clean tree first
    const results: GitCommandResult[] = [];
    const ctx = hookCtx(root, results);
    await bashCall(ctx, "git stash", "s1", () => sh(root, "stash", "-q"));
    await bashCall(ctx, "git stash pop", "s2", () => sh(root, "stash", "pop", "-q"));
    write(root, "README.md", "dirty\n");
    await bashCall(ctx, "echo 'git stash' >> NOTES.md", "s3", () => write(root, "NOTES.md", "git stash\n"));
    expect(results).toEqual([]);
  });
});

describe("the engine: git_result", () => {
  async function opened(): Promise<{ h: Harness; root: string }> {
    const root = repo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    return { h, root };
  }

  it("a stash is a gray chat row naming the files — never state.lastError", async () => {
    const { h } = await opened();
    h.session().emit({ type: "git_result", toolUseId: "s1", stashed: ["src/App.java", "README.md"] });
    await h.settle();
    const rows = h.ofType("error").filter((e) => e.code === "git_stashed");
    expect(rows).toEqual([expect.objectContaining({ fatal: false, scope: "session", code: "git_stashed", detail: "src/App.java, README.md" })]);
    expect(h.engine.state.lastError).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    h.session().emit({ type: "git_result", toolUseId: "s2", stashed: many });
    await h.settle();
    expect(h.ofType("error").filter((e) => e.code === "git_stashed")[1]?.detail).toBe(`${many.slice(0, 10).join(", ")} (+2)`);
  });
});
