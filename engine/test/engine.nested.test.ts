import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, ToolFileEntry } from "../src/session/events.js";
import type { ToolWindow } from "../src/session/provenance.js";
import { pathTokens } from "../src/review/nested.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(prefix = "rg-nest"): string {
  const dir = realpathSync(makeTempDir(prefix));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "app.txt", "app\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function endTurnWith(h: Harness, toolFiles: ToolFileEntry[], toolWindows: ToolWindow[] = []): void {
  const s = h.session();
  s.turnActive = false;
  const ev: Extract<SessionEvent, { type: "turn_end" }> = {
    type: "turn_end",
    stopReason: "end_turn",
    sessionId: "sess-1",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 10 },
    toolFiles,
    budget: { files: 0, lines: 0, denied: false },
    changedOutside: [],
    planFiles: [],
    toolWindows,
  };
  s.emit(ev);
  s.emit({ type: "activity", kind: "idle" });
}

const settled = (h: Harness, turns: number) => h.waitFor((s) => s.hud.turnCount === turns && s.gate.turnEndTree !== null && s.gate.phase !== "collecting" && s.branches.list.length > 0, "settled");
const edit = (dir: string, rel: string, id: string): ToolFileEntry => ({ path: join(dir, rel), tools: ["Edit"], count: 1, toolUseIds: [id] });

describe("changes inside nested repositories are reported, not lost (market-01, robustness-06, §32)", () => {
  it("an edit inside a linked worktree under .claude/worktrees (EnterWorktree / isolation: worktree): reported with its kind, branch, files and status; nothing in the review", async () => {
    const dir = track(makeRepo());
    sh(dir, "worktree", "add", "-q", "-b", "wt1", join(dir, ".claude/worktrees/wt1"));
    // Another session's worktree, busy on its own: never this turn's business.
    sh(dir, "worktree", "add", "-q", "-b", "other", join(dir, ".claude/worktrees/other"));
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work in a worktree" });
    write(dir, ".claude/worktrees/wt1/app.txt", "edited in the worktree\n");
    write(dir, ".claude/worktrees/wt1/new.txt", "new\n");
    write(dir, ".claude/worktrees/other/app.txt", "someone else\n");
    endTurnWith(h, [edit(dir, ".claude/worktrees/wt1/app.txt", "e1"), edit(dir, ".claude/worktrees/wt1/new.txt", "e2")]);
    await settled(h, 1);
    const s = await h.waitFor((x) => (x.gate.nestedChanges?.length ?? 0) > 0, "nested changes");
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.nestedChanges).toEqual([
      { path: ".claude/worktrees/wt1", kind: "worktree", branch: "wt1", head: null, dirtyFiles: 2, touchedFiles: [".claude/worktrees/wt1/app.txt", ".claude/worktrees/wt1/new.txt"], via: ["edit"] },
    ]);
    expect(h.ofType("nested_changes")).toEqual([{ type: "nested_changes", turn: 1, repos: s.gate.nestedChanges }]);
    // Cleared when the next turn starts.
    await h.engine.handle({ type: "send", text: "next" });
    expect(h.engine.state.gate.nestedChanges).toEqual([]);
  });

  it("a submodule: a Bash call that ran inside it (hook cwd) and committed there is reported with its HEAD move", async () => {
    const lib = track(makeRepo("rg-nest-lib"));
    const dir = track(makeRepo());
    execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "libs/sub"], { env: { ...process.env, LC_ALL: "C" } });
    sh(dir, "commit", "-qm", "add submodule");
    const sub = join(dir, "libs/sub");
    sh(sub, "config", "user.email", "test@example.com");
    sh(sub, "config", "user.name", "Test");
    const before = sh(sub, "rev-parse", "HEAD").trim();
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "fix the library" });
    write(dir, "libs/sub/app.txt", "fixed in the submodule\n");
    sh(sub, "commit", "-qam", "fix");
    const after = sh(sub, "rev-parse", "HEAD").trim();
    endTurnWith(h, [], [{ toolUseId: "b1", name: "Bash", start: Date.now() - 1000, end: Date.now(), cwd: dir, cwdAfter: sub, command: "cd libs/sub && git commit -am fix" }]);
    await settled(h, 1);
    const s = await h.waitFor((x) => (x.gate.nestedChanges?.length ?? 0) > 0, "nested changes");
    expect(s.gate.nestedChanges).toEqual([{ path: "libs/sub", kind: "submodule", branch: "main", head: { from: before, to: after }, dirtyFiles: 0, touchedFiles: [], via: ["bash"] }]);
  });

  it("a clone inside the project that a command names is reported while it is dirty; an untouched or clean one is not", async () => {
    const dir = track(makeRepo());
    write(dir, ".gitignore", "vendor/\n");
    for (const name of ["lib", "quiet"]) {
      const v = join(dir, "vendor", name);
      write(v, "x.txt", "x\n");
      sh(v, "init", "-q", "-b", "main");
      sh(v, "config", "user.email", "test@example.com");
      sh(v, "config", "user.name", "Test");
      sh(v, "add", "-A");
      sh(v, "commit", "-qm", "init");
    }
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "patch the vendored lib" });
    write(dir, "vendor/lib/x.txt", "patched\n");
    write(dir, "vendor/quiet/x.txt", "someone else\n");
    endTurnWith(h, [], [
      { toolUseId: "b1", name: "Bash", start: Date.now() - 1000, end: Date.now(), cwd: dir, command: "sed -i '' s/x/patched/ vendor/lib/x.txt" },
      { toolUseId: "b2", name: "Bash", start: Date.now() - 900, end: Date.now(), cwd: dir, command: "ls vendor" },
    ]);
    await settled(h, 1);
    const s = await h.waitFor((x) => (x.gate.nestedChanges?.length ?? 0) > 0, "nested changes");
    expect(s.gate.nestedChanges!.map((n) => [n.path, n.kind, n.dirtyFiles, n.via])).toEqual([["vendor/lib", "repo", 1, ["bash"]]]);
  });

  it("pathTokens: the path-like words of a command", () => {
    expect(pathTokens("sed -i '' s/x/y/ vendor/lib/x.txt && git -C libs/sub commit -am 'a/b' > out/log.txt")).toEqual(["s/x/y/", "vendor/lib/x.txt", "libs/sub", "a/b", "out/log.txt"]);
    expect(pathTokens("curl https://x.y/z -o ~/a/b --out=c/d")).toEqual([]);
  });

  it("nothing nested touched: no nested_changes", async () => {
    const dir = track(makeRepo());
    sh(dir, "worktree", "add", "-q", "-b", "wt1", join(dir, ".claude/worktrees/wt1"));
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    write(dir, "app.txt", "changed\n");
    write(dir, ".claude/worktrees/wt1/app.txt", "another session\n");
    endTurnWith(h, [edit(dir, "app.txt", "e1")], [{ toolUseId: "b1", name: "Bash", start: Date.now() - 100, end: Date.now(), cwd: dir, command: "npm test" }]);
    await settled(h, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.engine.state.gate.nestedChanges).toEqual([]);
    expect(h.ofType("nested_changes")).toEqual([]);
  });
});
