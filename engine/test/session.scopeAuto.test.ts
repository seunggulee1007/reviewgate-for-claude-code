import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import {
  ASK_REASON,
  buildHooks,
  CLAUDE_CONFIG_ASK_REASON,
  configScopeReason,
  NESTED_REASON,
  OUTSIDE_REASON,
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
import { makeRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

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

/** A temporary folder removed after the test (a home folder for Claude's memory). */
function makeTempDirLocal(): string {
  const d = makeTempDir("rg-home");
  dirs.push(d);
  return d;
}

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

  it("the checks after the scope still apply: a git command that throws away work and a settings file keep their card", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root, { permissionMode: "auto" });
    const reset = `cd ${sibling} && git reset --hard`;
    expect(await preBash(c, reset, root, "g1", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("g1")?.code).toBe("git_command");
    await postBash(c, reset, root, "g1", auto); // approved; it ran and left that worktree as it was: no row
    expect(c.scopeReasons?.has("g1")).toBe(false);
    expect(c.notices).toEqual([]);
    // §46 (r1-git): `git -C` there is the same command; a commit there throws nothing away — the CLI's call, as in the terminal.
    expect(await preBash(c, `git -C ${sibling} reset --hard HEAD`, root, "g2", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("g2")?.code).toBe("git_command");
    expect(await preBash(c, `cd ${sibling} && git commit -qam wip`, root, "g3", auto)).toEqual({});
    expect(c.scopeReasons?.has("g3") ?? false).toBe(false);
    mkdirSync(join(sibling, ".claude"), { recursive: true });
    const config = `cd ${sibling} && echo '{}' > .claude/settings.json`;
    expect(await preBash(c, config, root, "c1", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("c1")?.code).toBe("claude_config");
  });

  it("an approved git card next door is followed by the row of what it changed there (§33.4, §46)", async () => {
    const { root, sibling } = repoWithSibling();
    const c = ctx(root, { permissionMode: "auto" });
    write(sibling, "other.txt", "work in progress\n"); // uncommitted work in the other worktree
    const reset = `cd ${sibling} && git reset --hard`;
    expect(await preBash(c, reset, root, "g4", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("g4")?.code).toBe("git_command");
    sh(sibling, "reset", "-q", "--hard"); // the user allowed it: what the command did
    await postBash(c, reset, root, "g4", auto);
    expect(c.notices).toEqual([{ code: "worktree_outside_review", toolName: "Bash", toolUseId: "g4", path: sibling, files: ["other.txt"], reasonCode: "other_worktree" }]);
  });
});

describe("§39.5: making a worktree in auto mode", () => {
  const auto = { permission_mode: "auto" };

  it("`git worktree add` of this repository runs without a card in auto mode; the notice after it carries the worktrees before", async () => {
    const { root } = repoWithSibling();
    const target = join(dirname(root), `${basename(root)}-43`);
    dirs.push(target);
    const add = `git worktree add ../${basename(target)} -b f`;
    const c = ctx(root, { permissionMode: "auto" });
    expect(await preBash(c, add, root, "m1", auto)).toEqual({});
    expect(c.scopeReasons?.has("m1") ?? false).toBe(false);
    sh(root, "worktree", "add", "-q", "-b", "f", target); // what the command did
    await postBash(c, add, root, "m1", auto);
    expect(c.notices).toHaveLength(1);
    const n = c.notices[0] as { code: string; path: string; reasonCode: string; worktreesBefore: { path: string }[] };
    expect(n).toMatchObject({ code: "worktree_outside_review", toolName: "Bash", toolUseId: "m1", path: target, reasonCode: "worktree_command" });
    expect(n.worktreesBefore.map((w) => w.path)).not.toContain(target);
    expect(n.worktreesBefore.map((w) => w.path)).toContain(root);
    // Default mode keeps the card (with "허용하고 따라가기").
    const def = ctx(root);
    expect(await preBash(def, "git worktree add ../acme-44 -b g", root, "m2")).toMatchObject({ decision: "ask" });
    expect(def.scopeReasons?.get("m2")).toMatchObject({ code: "worktree_command" });
  });

  it("another repository's worktree keeps its card in auto mode (no chat of this window can follow it there)", async () => {
    const { root } = repoWithSibling();
    const other = realpathSync(makeRepo());
    dirs.push(other);
    const c = ctx(root, { permissionMode: "auto" });
    expect(await preBash(c, `cd ${other} && git worktree add -b x ${other}-x`, root, "o1", auto)).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("o1")).toMatchObject({ code: "worktree_command", otherRepository: true });
  });
});

describe("§39.5: the engine — a worktree the CLI made in auto mode", () => {
  it("is listed, said in a row naming it (its actions can move the chat there), and reviews from HEAD when the chat moves", async () => {
    const main = realpathSync(makeRepo());
    const wt = `${main}-43`;
    dirs.push(main, wt);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(main);
    await h.engine.handle({ type: "send", text: "make a worktree for task 43" });
    const s = h.session();
    const before = (await import("../src/git/worktrees.js")).parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    sh(main, "worktree", "add", "-q", "-b", "task-43", wt);
    write(wt, "work.txt", "done there before the move\n");
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: wt, reasonCode: "worktree_command", worktreesBefore: before });
    await h.waitFor(() => h.ofType("error").some((e) => e.code === "worktree_outside_review"), "the row", 10_000);
    expect(h.engine.state.workbenches.list.some((w) => w.path === wt)).toBe(true);
    const row = h.ofType("error").find((e) => e.code === "worktree_outside_review")!;
    expect(row).toMatchObject({ fatal: false, scope: "session", toolName: "Bash", path: wt });
    expect(row).not.toHaveProperty("worktreesBefore");
    expect(h.engine.state.lastError).toBeNull();
    // The chat moves there (the row's action): this chat made it, so its review starts at HEAD and holds what was done there.
    s.emitTurnEnd({ sessionId: h.engine.state.sessions.currentId! });
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.request({ type: "chat_move", path: wt });
    expect(h.ofType("chat_moved").at(-1)).toMatchObject({ path: wt, baseline: "head" });
  });

  it("a worktree command that made nothing (git refused it) says nothing", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(main);
    await h.engine.handle({ type: "send", text: "make a worktree" });
    const before = (await import("../src/git/worktrees.js")).parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    h.session().emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: `${main}-none`, reasonCode: "worktree_command", worktreesBefore: before });
    await h.settle();
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    expect(h.ofType("error").filter((e) => e.code === "worktree_outside_review")).toEqual([]);
  });
});

describe("§39.5: edits the review does not see, in auto mode — no card, listed after the turn", () => {
  const auto = { permission_mode: "auto" };

  async function edit(c: HookContext, toolName: string, toolInput: Record<string, unknown>, cwd: string, id: string, extra: Record<string, unknown> = {}): Promise<{ decision?: string; reason?: string }> {
    const hooks = buildHooks(c);
    const pre = hooks.PreToolUse![0]!.hooks[0] as HookCallback;
    const d = decision(await pre(hookInput("PreToolUse", toolName, toolInput, cwd, id, extra), id, opts));
    if (d.decision !== "ask" && d.decision !== "deny") {
      for (const h of hooks.PostToolUse![0]!.hooks) await (h as HookCallback)(hookInput("PostToolUse", toolName, toolInput, cwd, id, { tool_response: {}, ...extra }), id, opts);
    }
    return d;
  }

  it("Claude's memory, a parent folder, a sibling worktree and a nested repository: no decision, each listed; settings files still ask", async () => {
    const { root, sibling, lib } = repoWithSibling();
    const home = realpathSync(makeTempDirLocal());
    const listed: string[] = [];
    const c = ctx(root, { permissionMode: "auto", claudeHome: home, onOutsideEdit: (f) => listed.push(f) });
    const memory = join(home, ".claude", "projects", "-work-acme", "memory", "note.md");
    const parent = join(dirname(root), "notes.txt");
    dirs.push(parent);
    expect(await edit(c, "Write", { file_path: memory, content: "remember\n" }, root, "e1", auto)).toEqual({});
    expect(await edit(c, "Write", { file_path: parent, content: "x\n" }, root, "e2", auto)).toEqual({});
    expect(await edit(c, "Write", { file_path: join(sibling, "src", "A.java"), content: "class A {}\n" }, root, "e3", auto)).toEqual({});
    expect(await edit(c, "Edit", { file_path: join(lib, "lib.txt"), old_string: "lib", new_string: "x" }, root, "e4", auto)).toEqual({});
    expect(listed).toEqual([memory, parent, join(sibling, "src", "A.java"), join(lib, "lib.txt")]);
    // Inside the project nothing is listed (the review has it).
    expect(await edit(c, "Write", { file_path: join(root, "sub", "b.txt"), content: "b\n" }, root, "e5", auto)).toEqual({});
    expect(listed).toHaveLength(4);
    // Claude Code's own settings keep their card in auto mode too (§33.9) — under the home folder as in the project.
    const userSettings = join(home, ".claude", "settings.json");
    expect(await edit(c, "Edit", { file_path: userSettings, old_string: "{", new_string: "{ " }, root, "e6", auto)).toMatchObject({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    expect(await edit(c, "Write", { file_path: join(lib, ".claude", "settings.json"), content: "{}" }, root, "e7", auto)).toMatchObject({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    // git's own state is still denied.
    expect(await edit(c, "Write", { file_path: join(sibling, ".git"), content: "x" }, root, "e8", auto)).toMatchObject({ decision: "deny" });
  });

  it("default mode, and auto mode whose CLI runs another mode, keep the cards", async () => {
    const { root, lib } = repoWithSibling();
    const home = realpathSync(makeTempDirLocal());
    const memory = join(home, ".claude", "projects", "-work-acme", "memory", "note.md");
    for (const [c, extra] of [[ctx(root, { claudeHome: home }), {}], [ctx(root, { permissionMode: "auto", claudeHome: home }), { permission_mode: "default" }]] as const) {
      expect(await edit(c, "Write", { file_path: memory, content: "x\n" }, root, "d1", extra)).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
      expect(await edit(c, "Write", { file_path: join(dirname(root), "n.txt"), content: "x\n" }, root, "d2", extra)).toEqual({ decision: "ask", reason: OUTSIDE_REASON });
      expect(await edit(c, "Write", { file_path: join(lib, "x.txt"), content: "x\n" }, root, "d3", extra)).toEqual({ decision: "ask", reason: NESTED_REASON });
    }
  });

  it("the session lists them in turn_end.changedOutside", async () => {
    const { root } = repoWithSibling();
    const home = realpathSync(makeTempDirLocal());
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: root,
      settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", permissionMode: "auto" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
    });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const hc = (s as unknown as { hookCtx: HookContext }).hookCtx;
    hc.claudeHome = home;
    hc.scratchDirs = []; // these test folders live in the temporary folder, which counts as throwaway space otherwise
    const memory = join(home, ".claude", "projects", "-work-acme", "memory", "MEMORY.md");
    const parent = join(dirname(root), `${basename(root)}-notes.txt`);
    dirs.push(parent);
    expect(await edit(hc, "Write", { file_path: memory, content: "- a note\n" }, root, "w1", auto)).toEqual({});
    expect(await edit(hc, "Write", { file_path: parent, content: "x\n" }, root, "w2", auto)).toEqual({});
    (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage);
    const end = events.find((e): e is Extract<SessionEvent, { type: "turn_end" }> => e.type === "turn_end");
    expect(end!.changedOutside).toEqual([memory, parent].sort());
    await s.dispose();
  });
});
