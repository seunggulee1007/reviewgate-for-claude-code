import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptItem } from "../src/protocol.js";
import { TranscriptStore } from "../src/review/transcript.js";
import { BudgetState } from "../src/session/budget.js";
import type { SessionEvent } from "../src/session/events.js";
import {
  ALLOW_PATTERN_REASON,
  ASK_REASON,
  autoAllowReason,
  buildHooks,
  GIT_ASK_REASON,
  GIT_INTERNAL_REASON,
  isClaudeMemoryFile,
  isGitInternalPath,
  isOutsideRoot,
  OUTSIDE_REASON,
  READ_ONLY_BASH_REASON,
  realpathLenient,
  REMEMBERED_REASON,
  type HookContext,
} from "../src/session/hooks.js";
import { defaultScratchDirs, editScopeReason, isScratchPath } from "../src/session/reviewScope.js";
import { commit } from "../src/git/commit.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { runGit } from "../src/git/exec.js";
import { fileExists, makeRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function fakeCtx(root: string, budget = { maxFiles: 5, maxLines: 200 }): HookContext & { events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return {
    budget: new BudgetState(budget),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    interrupted: false,
    emit: (e) => events.push(e),
    log: () => {},
    events,
  };
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>, cwd: string): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: "t1" } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

describe("path containment (audit 1.1)", () => {
  it("isOutsideRoot resolves symlinks and paths that do not exist yet", () => {
    const root = track(makeTempDir("rg-root"));
    const outside = track(makeTempDir("rg-outside"));
    mkdirSync(join(root, "sub"));
    symlinkSync(outside, join(root, "escape"));
    expect(isOutsideRoot(join(root, "sub", "new.txt"), root)).toBe(false);
    expect(isOutsideRoot(join(root, "deep", "er", "new.txt"), root)).toBe(false);
    expect(isOutsideRoot(root, root)).toBe(false);
    expect(isOutsideRoot(join(outside, "x.txt"), root)).toBe(true);
    expect(isOutsideRoot(root + "-sibling/x.txt", root)).toBe(true);
    // A symlinked directory inside the root that points outside is an escape (existing and new files).
    expect(isOutsideRoot(join(root, "escape", "x.txt"), root)).toBe(true);
    writeFileSync(join(outside, "y.txt"), "y");
    expect(isOutsideRoot(join(root, "escape", "y.txt"), root)).toBe(true);
    expect(realpathLenient(join(root, "escape", "nope", "z.txt"))).toBe(join(realpathLenient(outside), "nope", "z.txt"));
  });

  it("preEdit answers `ask` for an edit outside the checkpoint root and allows edits inside it", async () => {
    const root = track(makeTempDir("rg-root"));
    const outside = track(makeTempDir("rg-outside"));
    const ctx = fakeCtx(root);
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };

    const inside = await preEdit(preToolUse("Write", { file_path: join(root, "a.txt"), content: "hi\n" }, root), "t1", opts);
    expect(inside).toEqual({});

    for (const [tool, input] of [
      ["Write", { file_path: join(outside, "zshrc"), content: "x\n" }],
      ["Edit", { file_path: "../" + basename(outside) + "/rel.txt", old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(outside, "m.txt"), edits: [{ old_string: "a", new_string: "b" }] }],
      ["NotebookEdit", { notebook_path: join(outside, "n.ipynb"), new_source: "print(1)" }],
    ] as const) {
      const out = await preEdit(preToolUse(tool, input as Record<string, unknown>, root), "t1", opts);
      expect(decision(out), tool).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
    }
    // Symlink escaping the root: same answer.
    symlinkSync(outside, join(root, "escape"));
    const viaLink = await preEdit(preToolUse("Write", { file_path: join(root, "escape", "x.txt"), content: "x\n" }, root), "t1", opts);
    expect(decision(viaLink)).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
    expect(ctx.events.filter((e) => e.type === "budget_event" && e.kind === "deny")).toEqual([]);
  });

  it("a throwaway file in a temporary folder outside any repository passes without the card or the budget; a repository there asks", async () => {
    const root = track(makeTempDir("rg-root"));
    const scratch = realpathLenient(track(makeTempDir("rg-scratch")));
    const ctx = { ...fakeCtx(root, { maxFiles: 1, maxLines: 2 }), scratchDirs: [scratch] };
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };

    const note = await preEdit(preToolUse("Write", { file_path: join(scratch, "claude-501", "notes", "plan.md"), content: "a\nb\nc\nd\n" }, root), "t1", opts);
    expect(note).toEqual({});
    expect(ctx.budget.files.size).toBe(0); // not counted: the budget is for the user's code
    // A clone or worktree made in the temporary folder is real work: the outside-the-project card as before.
    mkdirSync(join(scratch, "wt", "src"), { recursive: true });
    writeFileSync(join(scratch, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    const inRepo = await preEdit(preToolUse("Write", { file_path: join(scratch, "wt", "src", "A.java"), content: "x\n" }, root), "t1", opts);
    expect(decision(inRepo)).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
    // Without scratch folders (the default in a bare context) every outside edit asks.
    const bare = buildHooks(fakeCtx(root)).PreToolUse![0]!.hooks[0]!;
    expect(decision(await bare(preToolUse("Write", { file_path: join(scratch, "x.md"), content: "x\n" }, root), "t1", opts))).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
  });

  it("the permission card's scope reason: none for a scratch file, other_worktree for a worktree made in the temporary folder", () => {
    const root = track(makeTempDir("rg-root"));
    const scratch = realpathLenient(track(makeTempDir("rg-scratch")));
    mkdirSync(join(scratch, "wt"));
    writeFileSync(join(scratch, "wt", ".git"), "gitdir: /elsewhere\n");
    expect(isScratchPath(join(scratch, "a", "b.txt"), [scratch])).toBe(true);
    expect(isScratchPath(join(scratch, "wt", "b.txt"), [scratch])).toBe(false);
    expect(isScratchPath(join(root + "-elsewhere", "b.txt"), [scratch])).toBe(false);
    expect(isScratchPath(join(scratch, "b.txt"), undefined)).toBe(false);
    expect(editScopeReason(join(scratch, "a.txt"), root, isOutsideRoot, [], [scratch])).toBeNull();
    expect(editScopeReason(join(scratch, "wt", "a.txt"), root, isOutsideRoot, [join(scratch, "wt")], [scratch])?.code).toBe("other_worktree");
    expect(editScopeReason(join(scratch, "a.txt"), root, isOutsideRoot)?.code).toBe("outside_project");
    // The real temporary folders, as real paths (on macOS /private/tmp and the per-user /private/var/folders/…/T).
    const dirs = defaultScratchDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) expect(realpathLenient(d)).toBe(d);
  });

  it("budget deny still wins over the containment ask", async () => {
    const root = track(makeTempDir("rg-root"));
    const outside = track(makeTempDir("rg-outside"));
    const ctx = fakeCtx(root, { maxFiles: 1, maxLines: 2 });
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };
    const out = await preEdit(preToolUse("Write", { file_path: join(outside, "big.txt"), content: "1\n2\n3\n4\n5\n6\n" }, root), "t1", opts);
    expect(decision(out).decision).toBe("deny");
    expect(ctx.budget.denied).toBe(true);
    expect(ctx.events.map((e) => e.type)).toEqual(["budget_event"]);
    // Non-edit tools keep the plain ask reason.
    const preOther = buildHooks(ctx).PreToolUse![2]!.hooks[0]!;
    expect(decision(await preOther(preToolUse("WebFetch", { url: "https://x" }, root), "t2", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
  });

  it("Claude's own memory folder is outside the budget: over budget it still gets the outside card, and is not counted", async () => {
    const root = track(makeTempDir("rg-root"));
    const home = track(makeTempDir("rg-home"));
    const ctx = { ...fakeCtx(root, { maxFiles: 1, maxLines: 2 }), claudeHome: home };
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };
    await preEdit(preToolUse("Write", { file_path: join(root, "big.txt"), content: "1\n2\n3\n4\n5\n6\n" }, root), "t1", opts);
    expect(ctx.budget.denied).toBe(true);
    const memory = join(home, ".claude", "projects", "-x-y", "memory", "note.md");
    const out = await preEdit(preToolUse("Write", { file_path: memory, content: "a\nb\nc\nd\n" }, root), "t2", opts);
    expect(decision(out).decision).toBe("ask");
    expect(ctx.budget.files.has(memory)).toBe(false);
    expect(isClaudeMemoryFile(join(home, ".claude", "projects", "-x-y", "other.md"), home)).toBe(false);
  });
});

describe("edits into .git/ (release review H2)", () => {
  const opts = { signal: new AbortController().signal };

  it("isGitInternalPath: any `.git` component (case-insensitive, through symlinks) or a path under the git dirs", () => {
    const root = track(makeTempDir("rg-root"));
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "gitlink"));
    expect(isGitInternalPath(join(root, ".git", "hooks", "pre-commit"), [])).toBe(true);
    expect(isGitInternalPath(join(root, ".git"), [])).toBe(true); // a linked worktree's `.git` file
    expect(isGitInternalPath(join(root, ".GIT", "config"), [])).toBe(true);
    expect(isGitInternalPath(join(root, "gitlink", "config"), [])).toBe(true);
    expect(isGitInternalPath(join(root, "sub", "..", ".git", "config"), [])).toBe(true);
    expect(isGitInternalPath(join(root, "src", "a.git.ts"), [])).toBe(false);
    expect(isGitInternalPath(join(root, ".github", "workflows", "ci.yml"), [])).toBe(false);
    expect(isGitInternalPath("/elsewhere/gd/hooks/x", ["/elsewhere/gd"])).toBe(true);
    expect(isGitInternalPath("/elsewhere/gd", ["/elsewhere/gd/"])).toBe(true);
    expect(isGitInternalPath("/elsewhere/gdx/a", ["/elsewhere/gd"])).toBe(false);
  });

  it("preEdit denies every edit tool inside .git/ — before the budget, plan-file and containment rules", async () => {
    const root = track(makeRepo());
    const ctx = fakeCtx(root);
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    for (const [tool, input] of [
      ["Write", { file_path: join(root, ".git", "hooks", "pre-commit"), content: "#!/bin/sh\nrm -rf ~\n" }],
      ["Edit", { file_path: ".git/config", old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(root, ".git", "config"), edits: [{ old_string: "a", new_string: "b" }] }],
      ["NotebookEdit", { notebook_path: join(root, ".git", "x.ipynb"), new_source: "print(1)" }],
    ] as const) {
      const out = await preEdit(preToolUse(tool, input as Record<string, unknown>, root), "t1", opts);
      expect(decision(out), tool).toEqual({ decision: "deny", reason: GIT_INTERNAL_REASON });
    }
    expect(ctx.budget.files.size).toBe(0); // never counted
    expect(await preEdit(preToolUse("Write", { file_path: join(root, "a.txt"), content: "hi\n" }, root), "t1", opts)).toEqual({});
  });

  it("preEdit denies the git dir of a repository whose git dir has no `.git` component (`--separate-git-dir`)", async () => {
    const base = track(makeTempDir("rg-sep"));
    const work = join(base, "work");
    const gd = join(base, "store");
    mkdirSync(work);
    sh(base, "init", "-q", "--separate-git-dir", gd, work);
    const ctx = fakeCtx(work);
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const out = await preEdit(preToolUse("Write", { file_path: join(gd, "hooks", "post-checkout"), content: "x\n" }, work), "t1", opts);
    expect(decision(out)).toEqual({ decision: "deny", reason: GIT_INTERNAL_REASON });
  });

  it("runGit never runs a planted fsmonitor or hook for internal calls; the user's commit keeps its hooks", async () => {
    const root = track(makeRepo());
    const marker = (name: string) => join(root, `${name}.ran`);
    const script = (name: string) => {
      const path = join(root, ".git", "hooks", name);
      write(root, `.git/hooks/${name}`, `#!/bin/sh\ntouch "${marker(name)}"\nexit 0\n`);
      chmodSync(path, 0o755);
      return path;
    };
    sh(root, "config", "core.fsmonitor", script("fsmon"));
    script("post-checkout");
    script("pre-commit");
    write(root, "untracked.txt", "changed\n");
    const cp = await openCheckpoint(root);
    await cp.snapshot();
    await runGit(root, ["status", "--porcelain"]);
    await runGit(root, ["checkout", "-q", "-b", "side"]);
    expect(fileExists(marker("fsmon"))).toBe(false);
    expect(fileExists(marker("post-checkout"))).toBe(false);
    await runGit(root, ["add", "untracked.txt"]);
    await commit(root, "user commit");
    expect(fileExists(marker("pre-commit"))).toBe(true);
    expect(fileExists(marker("fsmon"))).toBe(false);
  });
});

describe("Bash auto-allow: read-only commands, allow patterns, remembered allows (docs/M16-FRICTION.md §1–2)", () => {
  const opts = { signal: new AbortController().signal };
  const preBash = (ctx: HookContext) => buildHooks(ctx).PreToolUse![1]!.hooks[0]!;
  const preOther = (ctx: HookContext) => buildHooks(ctx).PreToolUse![2]!.hooks[0]!;

  it("read-only Bash is allowed by the hook (default on), everything else still asks", async () => {
    const root = track(makeTempDir("rg-root"));
    const ctx = fakeCtx(root);
    for (const cmd of ["git status", "ls -la | head", "cat a.txt && git diff --stat"]) {
      expect(decision(await preBash(ctx)(preToolUse("Bash", { command: cmd }, root), "t1", opts)), cmd).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    }
    for (const cmd of ["echo hi > x.txt", "npm test", "git status && rm x", "ls $(rm x)"]) {
      expect(decision(await preBash(ctx)(preToolUse("Bash", { command: cmd }, root), "t1", opts)), cmd).toEqual({ decision: "ask", reason: ASK_REASON });
    }
    // A git command that changes the repository keeps its card (§46) over the auto-allow.
    expect(decision(await preBash(ctx)(preToolUse("Bash", { command: "git status && git commit -m x" }, root), "t1", opts))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
  });

  it("autoAllowReadOnlyBash: false turns the read-only rule off (patterns and remembered allows still apply)", async () => {
    const root = track(makeTempDir("rg-root"));
    const ctx = fakeCtx(root);
    ctx.autoAllowReadOnlyBash = false;
    expect(decision(await preBash(ctx)(preToolUse("Bash", { command: "git status" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    ctx.bashAllowPatterns = ["Bash(git *)"];
    expect(decision(await preBash(ctx)(preToolUse("Bash", { command: "git status" }, root), "t1", opts))).toEqual({ decision: "allow", reason: ALLOW_PATTERN_REASON });
  });

  it("bashAllowPatterns are evaluated before ask (Claude style `Bash(npm test:*)` / `Bash(git *)`)", async () => {
    const root = track(makeTempDir("rg-root"));
    const ctx = fakeCtx(root);
    ctx.bashAllowPatterns = ["Bash(npm test:*)", "Bash(git *)"];
    const hook = preBash(ctx);
    expect(decision(await hook(preToolUse("Bash", { command: "npm test -- --watch" }, root), "t1", opts))).toEqual({ decision: "allow", reason: ALLOW_PATTERN_REASON });
    expect(decision(await hook(preToolUse("Bash", { command: "git push origin main" }, root), "t1", opts))).toEqual({ decision: "allow", reason: ALLOW_PATTERN_REASON });
    expect(decision(await hook(preToolUse("Bash", { command: "npm run build" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    // A read-only command reports the read-only reason even when a pattern would match too.
    expect(decision(await hook(preToolUse("Bash", { command: "git status" }, root), "t1", opts))).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    // Patterns never override the git card (§46).
    expect(decision(await hook(preToolUse("Bash", { command: "git commit -m x" }, root), "t1", opts))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    // Patterns are about Bash only.
    expect(decision(await preOther(ctx)(preToolUse("WebFetch", { url: "https://x" }, root), "t2", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
  });

  it("remembered allows: `Bash:<first two words>` for Bash, `<tool>:<tool>` for other tools; the set is live", async () => {
    const root = track(makeTempDir("rg-root"));
    const ctx = fakeCtx(root);
    const remembered = new Set<string>();
    ctx.rememberedAllows = remembered;
    const bash = preBash(ctx);
    const other = preOther(ctx);
    expect(decision(await bash(preToolUse("Bash", { command: "npm run build" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    remembered.add("Bash:npm run");
    expect(decision(await bash(preToolUse("Bash", { command: "npm run build" }, root), "t1", opts))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    expect(decision(await bash(preToolUse("Bash", { command: "npm run lint -- --fix" }, root), "t1", opts))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    expect(decision(await bash(preToolUse("Bash", { command: "npm install x" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    // §19.3: a remembered key never covers a redirection or a chained command it does not cover itself.
    expect(decision(await bash(preToolUse("Bash", { command: "npm run build > out.txt" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(decision(await bash(preToolUse("Bash", { command: "npm run build && rm -rf x" }, root), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(decision(await other(preToolUse("WebFetch", { url: "https://x" }, root), "t2", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    remembered.add("WebFetch:WebFetch");
    expect(decision(await other(preToolUse("WebFetch", { url: "https://y" }, root), "t2", opts))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    remembered.clear(); // forget_allows
    expect(decision(await other(preToolUse("WebFetch", { url: "https://y" }, root), "t2", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    // autoAllowReason is what canUseTool consults as well.
    expect(autoAllowReason("Bash", { command: "ls" }, ctx)).toBe(READ_ONLY_BASH_REASON);
    expect(autoAllowReason("Bash", { command: "rm x" }, ctx)).toBeUndefined();
  });

  it("a key an older client remembered for SendMessage, a worktree / plan tool, an edit or a question answers nothing (§33.2)", () => {
    const root = track(makeTempDir("rg-root"));
    const ctx = fakeCtx(root);
    ctx.rememberedAllows = new Set(["SendMessage:SendMessage", "EnterWorktree:EnterWorktree", "ExitPlanMode:ExitPlanMode", "Edit:Edit", "AskUserQuestion:AskUserQuestion", "WebFetch:WebFetch"]);
    expect(autoAllowReason("SendMessage", { to: "team-lead", message: "hi" }, ctx)).toBeUndefined();
    expect(autoAllowReason("EnterWorktree", { name: "x" }, ctx)).toBeUndefined();
    expect(autoAllowReason("ExitPlanMode", { plan: "p" }, ctx)).toBeUndefined();
    expect(autoAllowReason("Edit", { file_path: "/elsewhere/a.txt" }, ctx)).toBeUndefined();
    expect(autoAllowReason("AskUserQuestion", { questions: [] }, ctx)).toBeUndefined();
    // Other tools keep their remembered answer.
    expect(autoAllowReason("WebFetch", { url: "https://x" }, ctx)).toBe(REMEMBERED_REASON);
  });
});

describe("TranscriptStore (audit 3.1)", () => {
  const row = (i: number): TranscriptItem => ({ at: "2026-01-01T00:00:00Z", turn: i, kind: "assistant_text", text: `row ${i} ` + "x".repeat(100) });

  it("appends NDJSON rows, caps the file and keeps the tail; tail() skips torn lines", () => {
    const dir = track(makeTempDir("rg-transcript"));
    const path = join(dir, "sub", "t.ndjson");
    const store = new TranscriptStore(path, 4000);
    for (let i = 0; i < 100; i++) store.append(row(i));
    expect(statSync(path).size).toBeLessThanOrEqual(4000);
    const items = store.tail(200);
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThan(40);
    expect(items.at(-1)).toEqual(row(99));
    expect(items.map((i) => i.turn)).toEqual(items.map((i) => i.turn).sort((a, b) => a - b)); // oldest first, contiguous tail
    expect(readFileSync(path, "utf8").split("\n")[0]!.startsWith("{")).toBe(true); // rotation cut at a row boundary
    writeFileSync(path, readFileSync(path, "utf8") + '{"torn":', "utf8");
    const after = store.tail(2);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual(row(99));
    expect(new TranscriptStore(join(dir, "missing.ndjson")).tail()).toEqual([]);
  });
});

describe("post-Bash file attribution (change → cause linkage)", () => {
  const postToolUse = (cwd: string, toolUseId: string): HookInput =>
    ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" }, tool_response: {}, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId }) as unknown as HookInput;

  it("each Bash call reports the files changed since the previous snapshot (the first one since its own pre-Bash baseline)", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = fakeCtx(root);
    // Turn start A, then something left on disk by an earlier turn: never attributed to this turn's Bash.
    ctx.checkpointTree = await cp.snapshot();
    write(root, "README.md", "earlier turn\n");
    const reported: [string, string[]][] = [];
    ctx.onBashFiles = (id, files) => reported.push([id, files.map((f) => basename(f))]);
    const hooks = buildHooks(ctx);
    const preBash = hooks.PreToolUse![1]!.hooks[0]!;
    const postBash = hooks.PostToolUse![1]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };

    await preBash(preToolUse("Bash", { command: "echo hi > other.txt" }, root), "b1", opts);
    write(root, "other.txt", "changed by bash\n");
    await postBash(postToolUse(root, "b1"), "b1", opts);
    await preBash(preToolUse("Bash", { command: "ls" }, root), "b2", opts);
    await postBash(postToolUse(root, "b2"), "b2", opts); // nothing changed: not reported
    await preBash(preToolUse("Bash", { command: "touch new.txt" }, root), "b3", opts);
    write(root, "new.txt", "x\n");
    await postBash(postToolUse(root, "b3"), "b3", opts);
    expect(reported).toEqual([["b1", ["other.txt"]], ["b3", ["new.txt"]]]);
  });

  it("§46: a git command that changes the repository gets the card; what it brings in is neither attributed nor counted", async () => {
    const root = track(makeRepo());
    sh(root, "checkout", "-q", "-b", "develop");
    write(root, "dev1.txt", "from develop\n");
    write(root, "dev2.txt", "from develop\n");
    sh(root, "add", "dev1.txt", "dev2.txt");
    sh(root, "commit", "-qm", "develop work");
    sh(root, "checkout", "-q", "-");
    const cp = await openCheckpoint(root);
    const ctx = fakeCtx(root);
    ctx.checkpointTree = await cp.snapshot();
    ctx.bashAllowPatterns = ["Bash(git *)"];
    const reported: [string, string[]][] = [];
    const notices: unknown[] = [];
    ctx.onBashFiles = (id, files) => reported.push([id, files.map((f) => basename(f))]);
    ctx.onScopeNotice = (n) => notices.push(n);
    const hooks = buildHooks(ctx);
    const preBash = hooks.PreToolUse![1]!.hooks[0]!;
    const postBash = hooks.PostToolUse![1]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };
    const pre = (command: string, id: string): HookInput => ({ ...(preToolUse("Bash", { command }, root) as object), tool_use_id: id }) as unknown as HookInput;
    const post = (command: string, id: string): HookInput => ({ ...(postToolUse(root, id) as object), tool_input: { command } }) as unknown as HookInput;

    // Not even an allow pattern skips the card; it carries the reason to canUseTool.
    const merge = "git merge -q --no-edit develop";
    expect(decision(await preBash(pre(merge, "g1"), "g1", opts))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(ctx.scopeReasons?.get("g1")?.code).toBe("git_command");
    sh(root, "merge", "-q", "--no-edit", "develop"); // approved: it runs
    await postBash(post(merge, "g1"), "g1", opts);
    expect(reported).toEqual([]);
    expect([ctx.budget.files.size, ctx.budget.lines]).toEqual([0, 0]);
    expect(notices).toEqual([]);

    // Claude's next command is attributed as usual — its own file only.
    await preBash(pre("echo x > mine.txt", "b1"), "b1", opts);
    write(root, "mine.txt", "x\n");
    await postBash(post("echo x > mine.txt", "b1"), "b1", opts);
    expect(reported).toEqual([["b1", ["mine.txt"]]]);
    expect([ctx.budget.files.size, ctx.budget.lines]).toEqual([1, 1]);
  });
});

describe("§54: no change budget by default", () => {
  const postToolUse = (tool: string, toolInput: Record<string, unknown>, cwd: string, toolUseId: string): HookInput =>
    ({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, tool_response: {}, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId }) as unknown as HookInput;

  it("without a limit nothing is counted, warned of, nudged or denied — a Bash call's files are still attributed", async () => {
    const root = track(makeRepo());
    const cp = await openCheckpoint(root);
    const ctx = fakeCtx(root, { maxFiles: 0, maxLines: 0 });
    ctx.checkpointTree = await cp.snapshot();
    const reported: [string, string[]][] = [];
    ctx.onBashFiles = (id, files) => reported.push([id, files.map((f) => basename(f))]);
    const hooks = buildHooks(ctx);
    const preEdit = hooks.PreToolUse![0]!.hooks[0]!;
    const preBash = hooks.PreToolUse![1]!.hooks[0]!;
    const postEdit = hooks.PostToolUse![0]!.hooks[0]!;
    const postBash = hooks.PostToolUse![1]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };

    // Thirty files of 100 lines each: far past any budget the app ever had (10 files / 400 lines, ×2).
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    for (let i = 0; i < 30; i++) {
      const input = { file_path: join(root, `f${i}.txt`), content: big };
      expect(await preEdit(preToolUse("Write", input, root), `w${i}`, opts)).toEqual({});
      write(root, `f${i}.txt`, big);
      expect(await postEdit(postToolUse("Write", input, root, `w${i}`), `w${i}`, opts)).toEqual({});
    }
    // A shell write after all that is not refused either (only the usual card decides).
    expect(decision(await preBash(preToolUse("Bash", { command: "echo x > mine.txt" }, root), "b1", opts)).decision).not.toBe("deny");
    write(root, "mine.txt", "x\n");
    await postBash(postToolUse("Bash", { command: "echo x > mine.txt" }, root, "b1"), "b1", opts);
    expect(reported).toEqual([["b1", ["mine.txt"]]]);
    expect(ctx.events.filter((e) => e.type === "budget_event")).toEqual([]);
    expect(ctx.budget.snapshot()).toEqual({ files: 0, lines: 0, denied: false });
  });
});
