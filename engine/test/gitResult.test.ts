import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import type { GitCommandResult } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, read, removeDir, sh, write } from "./helpers/repo.js";

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

// ------------------------------------------------------------------ M02: Claude's own commits (§46)

describe("postGitCommand: a HEAD move and the commits Claude made in it", () => {
  const head = (root: string) => sh(root, "rev-parse", "HEAD").trim();
  const branch = (root: string) => sh(root, "rev-parse", "--abbrev-ref", "HEAD").trim();

  it("git add + commit: from → to with the new commit as Claude's own; a new branch alone: a move without commits", async () => {
    const root = repo();
    const results: GitCommandResult[] = [];
    const ctx = hookCtx(root, results);
    const start = { sha: head(root), branch: branch(root) };
    await bashCall(ctx, "git checkout -b feature/acme-7", "b1", () => sh(root, "checkout", "-q", "-b", "feature/acme-7"));
    expect(results[0]).toEqual({ toolUseId: "b1", from: start, to: { sha: start.sha, branch: "feature/acme-7" } });
    write(root, "App.java", "class App {}\n");
    await bashCall(ctx, "git add -A && git commit -m 'feat: acme'", "c1", () => {
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "feat: acme");
    });
    const c1 = head(root);
    expect(results[1]).toEqual({ toolUseId: "c1", from: { sha: start.sha, branch: "feature/acme-7" }, to: { sha: c1, branch: "feature/acme-7" }, ownCommits: [c1] });
    // An amend replaces it: the new commit is Claude's, the replaced one is named.
    write(root, "App.java", "class App { int x; }\n");
    await bashCall(ctx, "git commit -a --amend --no-edit", "c2", () => sh(root, "commit", "-qa", "--amend", "--no-edit"));
    expect(results[2]).toMatchObject({ toolUseId: "c2", ownCommits: [head(root)], amended: [c1] });
    expect(results[2]!.foreign).toBeUndefined();
  });

  it("a merge or a fast-forward brings in commits that are not Claude's", async () => {
    const root = repo();
    const main = branch(root);
    sh(root, "checkout", "-q", "-b", "develop");
    write(root, "dev.txt", "from develop\n");
    sh(root, "add", "dev.txt");
    sh(root, "commit", "-qm", "develop work");
    sh(root, "checkout", "-q", main);
    const results: GitCommandResult[] = [];
    await bashCall(hookCtx(root, results), "git merge develop", "m1", () => sh(root, "merge", "-q", "develop"));
    expect(results).toHaveLength(1);
    expect(results[0]!.ownCommits).toBeUndefined();
    expect(results[0]!.to?.sha).toBe(head(root));
  });

  it("a move from before the command ran (the user's, while a card waited) makes it foreign", async () => {
    const root = repo();
    const results: GitCommandResult[] = [];
    const ctx = hookCtx(root, results);
    const base = { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" }, session_id: "s", transcript_path: "", cwd: root, tool_use_id: "r1" };
    const hooks = buildHooks(ctx);
    await hooks.PreToolUse![1]!.hooks[0]!({ hook_event_name: "PreToolUse", ...base } as unknown as HookInput, "r1", opts);
    // The user commits in a terminal meanwhile (an old clock: well before the command ran).
    write(root, "user.txt", "theirs\n");
    sh(root, "add", "user.txt");
    execFileSync("git", ["-C", root, "commit", "-qm", "user work"], { env: { ...process.env, GIT_COMMITTER_DATE: "@1000000000 +0000", GIT_AUTHOR_DATE: "@1000000000 +0000" } });
    for (const h of hooks.PostToolUse![1]!.hooks) await h({ hook_event_name: "PostToolUse", ...base, tool_response: {}, duration_ms: 50 } as unknown as HookInput, "r1", opts);
    expect(results).toEqual([expect.objectContaining({ toolUseId: "r1", foreign: true })]);
    expect(results[0]!.ownCommits).toBeUndefined(); // its reflog entry says `commit:` — but it is older than the call
  });
});

describe("the engine: Claude's own commit keeps its files in the review (§46)", () => {
  const head = (root: string) => sh(root, "rev-parse", "HEAD").trim();
  const branch = (root: string) => sh(root, "rev-parse", "--abbrev-ref", "HEAD").trim();

  async function turnThatCommits(): Promise<{ h: Harness; root: string; a: string; commit: string }> {
    const root = repo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    await h.engine.handle({ type: "send", text: "fix App.java and commit" });
    const a = h.engine.state.gate.turnStartTree!;
    const from = { sha: head(root), branch: branch(root) };
    write(root, "App.java", "class App { /* fixed */ }\n");
    sh(root, "add", "App.java");
    sh(root, "commit", "-qm", "fix: App");
    const commit = head(root);
    h.session().emit({ type: "git_result", toolUseId: "c1", from, to: { sha: commit, branch: from.branch }, ownCommits: [commit] });
    h.session().emitTurnEnd({ toolFiles: [{ path: `${root}/App.java`, tools: ["Bash"], count: 1, toolUseIds: ["c1"] }] });
    await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
    await h.settle();
    return { h, root, a, commit };
  }

  it("the committed file stays pending with committedIn; A is untouched; no head-moved bar — head_moved explainedBy claude_git and a row", async () => {
    const { h, a, commit } = await turnThatCommits();
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state, f.committedIn])).toEqual([["App.java", "pending", commit.slice(0, 7)]]);
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.gate.headMoved ?? null).toBeNull();
    expect(h.ofType("turn_end")[0]).toMatchObject({ files: 1 });
    expect(h.ofType("head_moved")).toEqual([expect.objectContaining({ explainedBy: "claude_git", commits: [commit.slice(0, 7)] })]);
    expect(h.ofType("error").filter((e) => e.code === "claude_committed")).toEqual([expect.objectContaining({ fatal: false, detail: commit.slice(0, 7) })]);
    expect(s.lastError).toBeNull();
  });

  it("a commit nobody reported (someone else's) is carried as before and keeps the bar", async () => {
    const root = repo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    await h.engine.handle({ type: "send", text: "x" });
    write(root, "App.java", "class App {}\n");
    sh(root, "add", "App.java");
    sh(root, "commit", "-qm", "theirs");
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
    await h.settle();
    expect(h.engine.state.changedFiles.map((f) => f.path)).not.toContain("App.java");
    expect(h.engine.state.gate.headMoved).not.toBeNull();
    expect(h.ofType("head_moved")[0]?.explainedBy).toBeUndefined();
  });

  it("rejecting a committed file reverts the working tree to A (the commit stays) and says so in a row", async () => {
    const { h, root, commit } = await turnThatCommits();
    await h.engine.handle({ type: "reject", paths: ["App.java"] });
    await h.settle();
    expect(read(root, "App.java")).toBeNull(); // A had no App.java
    expect(head(root)).toBe(commit);
    expect(h.ofType("error").filter((e) => e.code === "reject_committed")).toEqual([expect.objectContaining({ detail: `App.java (${commit.slice(0, 7)})` })]);
  });

  it("the app's commit of an accepted file Claude already committed answers alreadyCommitted instead of failing", async () => {
    const { h, root, commit } = await turnThatCommits();
    await h.engine.handle({ type: "accept", paths: ["App.java"] });
    const reply = await h.engine.request({ type: "commit", message: "fix: App", push: false });
    expect(reply).toMatchObject({ type: "committed", sha: commit, alreadyCommitted: ["App.java"] });
    expect(head(root)).toBe(commit); // no empty commit on top
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("an amend in a later turn keeps both changes in the review, on the amended commit", async () => {
    const { h, root, a, commit } = await turnThatCommits();
    await h.engine.handle({ type: "send", text: "also add a field and amend" });
    const from = { sha: commit, branch: branch(root) };
    write(root, "App.java", "class App { /* fixed */ int x; }\n");
    sh(root, "commit", "-qa", "--amend", "--no-edit");
    const amended = head(root);
    h.session().emit({ type: "git_result", toolUseId: "c2", from, to: { sha: amended, branch: from.branch }, ownCommits: [amended], amended: [commit] });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
    await h.settle();
    const s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.changedFiles.map((f) => [f.path, f.committedIn])).toEqual([["App.java", amended.slice(0, 7)]]);
    expect(s.gate.headMoved ?? null).toBeNull();
  });
});
