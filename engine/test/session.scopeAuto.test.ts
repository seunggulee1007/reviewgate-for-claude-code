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
import { openCheckpoint } from "../src/git/checkpoint.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §19.3, §33.4, §39.5 (r1-scope): next door without asking. Reading in the repository's other worktrees
 * needs no card; what changes outside this window's review is listed after the call.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
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
  write(lib, "lib.txt", "lib\n");
  sh(lib, "add", "-A");
  sh(lib, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "lib");
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

async function preBash(c: HookContext, command: string, cwd: string, toolUseId: string, extra: Record<string, unknown> = {}, toolExtra: Record<string, unknown> = {}): Promise<{ decision?: string; reason?: string }> {
  const hook = buildHooks(c).PreToolUse![1]!.hooks[0] as HookCallback;
  return decision(await hook(hookInput("PreToolUse", "Bash", { command, ...toolExtra }, cwd, toolUseId, extra), toolUseId, opts));
}

async function postBash(c: HookContext, command: string, cwd: string, toolUseId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const hook = buildHooks(c).PostToolUse![1]!.hooks[0] as HookCallback;
  await hook(hookInput("PostToolUse", "Bash", { command }, cwd, toolUseId, { tool_response: {}, ...extra }), toolUseId, opts);
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

describe("§31: no worktree snapshot after a read-only command", () => {
  it("a read-only call takes no baseline before it and no snapshot after it; the next writing call is attributed as before", async () => {
    const { root } = repoWithSibling();
    const cp = await openCheckpoint(root);
    const c = ctx(root);
    c.checkpointTree = await cp.snapshot();
    let snapshots = 0;
    const real = cp.snapshot.bind(cp);
    cp.snapshot = async (...args: Parameters<typeof cp.snapshot>) => {
      snapshots++;
      return real(...args);
    };
    c.checkpoint = cp;
    const reported: [string, string[]][] = [];
    c.onBashFiles = (id, files) => reported.push([id, files.map((f) => basename(f))]);
    for (const [id, command] of [["s1", "git status"], ["s2", "grep -rn a sub 2>/dev/null | head"], ["s3", "cd sub && ls"]] as const) {
      await preBash(c, command, root, id);
      await postBash(c, command, root, id);
    }
    expect(snapshots).toBe(0);
    expect(c.bashBaseTree).toBeUndefined();
    // The first command that may write takes the baseline, then its own snapshot.
    await preBash(c, "touch x.txt", root, "w1");
    expect(snapshots).toBe(1);
    const base = c.bashBaseTree;
    write(root, "x.txt", "x\n");
    await postBash(c, "touch x.txt", root, "w1");
    expect(snapshots).toBe(2);
    expect(reported).toEqual([["w1", ["x.txt"]]]);
    expect(c.bashBaseTree).not.toBe(base);
    // A read-only call after it leaves the base tree where the last snapshot put it.
    const after = c.bashBaseTree;
    await preBash(c, "git log --oneline -1", root, "s4");
    await postBash(c, "git log --oneline -1", root, "s4");
    expect([snapshots, c.bashBaseTree]).toEqual([2, after]);
  });

  it("a read-only command run in the background is snapshotted as before", async () => {
    const { root } = repoWithSibling();
    const cp = await openCheckpoint(root);
    const c = ctx(root);
    c.checkpointTree = await cp.snapshot();
    let snapshots = 0;
    const real = cp.snapshot.bind(cp);
    cp.snapshot = async (...args: Parameters<typeof cp.snapshot>) => {
      snapshots++;
      return real(...args);
    };
    c.checkpoint = cp;
    c.onBashFiles = () => {};
    await preBash(c, "tail -f log.txt", root, "bg1", {}, { run_in_background: true });
    await postBash(c, "tail -f log.txt", root, "bg1");
    expect(snapshots).toBe(2);
  });

  it("a file a 'read-only' command wrote all the same still reaches the review at the turn's end", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    await h.engine.handle({ type: "send", text: "look around" });
    const s = h.session();
    // The hooks took no snapshot for it (§31): no tool_files, no cause — the collection's snapshot B still sees the file.
    s.emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "git status" } });
    write(root, "sneaky.txt", "written by a command judged read-only\n");
    s.emit({ type: "tool_result", toolUseId: "b1", isError: false, preview: "" });
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing", "review");
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([["sneaky.txt", "pending", "external"]]);
  });
});

describe("§33.4: what a command changed in another worktree or a nested repository is listed after it — only when something changed", () => {
  it("default mode: the card stays; after it ran a notice names the files it changed there; a call that changed nothing raises none", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root);
    const touch = `cd ${sibling} && touch made.txt`;
    expect(await preBash(c, touch, root, "w1")).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("w1")?.code).toBe("other_worktree");
    write(sibling, "made.txt", ""); // what the approved command did
    await postBash(c, touch, root, "w1");
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Bash", toolUseId: "w1", path: sibling, files: ["made.txt"], reasonCode: "other_worktree" }]);
    expect(c.scopeReasons?.has("w1")).toBe(false);
    // Approved, ran, changed nothing there: no notice.
    await preBash(c, `cd ${sibling} && ./mvnw -q compile`, root, "w2");
    await postBash(c, `cd ${sibling} && ./mvnw -q compile`, root, "w2");
    expect(c.notices).toHaveLength(1);
    // A file that was changed already and is changed again counts; one the call left alone does not.
    write(sibling, "dirty.txt", "a\n");
    await preBash(c, `cd ${sibling} && make`, root, "w3");
    await new Promise((r) => setTimeout(r, 20));
    write(sibling, "dirty.txt", "b\n");
    await postBash(c, `cd ${sibling} && make`, root, "w3");
    expect(c.notices.at(-1)).toMatchObject({ toolUseId: "w3", path: sibling, files: ["dirty.txt"] });
    // A commit there: the files it took out of `git status` are what changed.
    await preBash(c, `cd ${sibling} && make commit`, root, "w4");
    sh(sibling, "add", "dirty.txt");
    sh(sibling, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x");
    await postBash(c, `cd ${sibling} && make commit`, root, "w4");
    expect(c.notices.at(-1)).toMatchObject({ toolUseId: "w4", files: ["dirty.txt"] });
  });

  it("a nested repository the command cds into: the files it changed there", async () => {
    const { root, lib } = repoWithSibling();
    const c = ctx(root);
    const cmd = "cd vendor/lib && echo x >> lib.txt";
    expect(await preBash(c, cmd, root, "n1")).toMatchObject({ decision: "ask" });
    write(lib, "lib.txt", "lib\nx\n");
    await postBash(c, cmd, root, "n1");
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Bash", toolUseId: "n1", path: lib, files: ["lib.txt"], reasonCode: "nested_repository" }]);
  });
});

describe("§39.5: in auto mode a command in another worktree or a nested repository is the CLI's call", () => {
  const auto = { permission_mode: "auto" };

  it("no card and no reason: the hook leaves it to the CLI; the row after it lists what changed there", async () => {
    const { root, sibling, lib } = repoWithSibling();
    const c = ctx(root, { permissionMode: "auto" });
    const build = `cd ../${basename(sibling)} && ./mvnw -q compile`;
    expect(await preBash(c, build, root, "a1", auto)).toEqual({});
    expect(c.scopeReasons?.has("a1") ?? false).toBe(false);
    write(sibling, "target/x.class", "x"); // what the command did
    await postBash(c, build, root, "a1", auto);
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Bash", toolUseId: "a1", path: sibling, files: ["target/x.class"], reasonCode: "other_worktree" }]);
    // A nested repository too.
    expect(await preBash(c, "cd vendor/lib && make", root, "a2", auto)).toEqual({});
    await postBash(c, "cd vendor/lib && make", root, "a2", auto);
    expect(c.notices).toHaveLength(1); // nothing changed in vendor/lib
    expect(lib).toBeTruthy();
  });

  it("the same command keeps its card in default mode, and in auto mode when the CLI runs another mode", async () => {
    const { root, sibling } = repoWithSibling();
    const build = `cd ${sibling} && ./mvnw -q compile`;
    const def = ctx(root);
    expect(await preBash(def, build, root, "d1", { permission_mode: "default" })).toMatchObject({ decision: "ask" });
    expect(def.scopeReasons?.get("d1")).toMatchObject({ code: "other_worktree", path: sibling });
    const cliDefault = ctx(root, { permissionMode: "auto" });
    expect(await preBash(cliDefault, build, root, "d2", { permission_mode: "default" })).toMatchObject({ decision: "ask" });
    expect(cliDefault.scopeReasons?.get("d2")?.code).toBe("other_worktree");
  });

  it("the checks after the scope still apply: a git command that changes the repository and a settings file keep their card", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root, { permissionMode: "auto" });
    const reset = `cd ${sibling} && git reset --hard`;
    expect(await preBash(c, reset, root, "g1", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("g1")?.code).toBe("git_command");
    await postBash(c, reset, root, "g1", auto); // approved; it ran and left that worktree as it was: no row
    expect(c.scopeReasons?.has("g1")).toBe(false);
    expect(c.notices).toEqual([]);
    mkdirSync(join(sibling, ".claude"), { recursive: true });
    const config = `cd ${sibling} && echo '{}' > .claude/settings.json`;
    expect(await preBash(c, config, root, "c1", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("c1")?.code).toBe("claude_config");
  });
});
