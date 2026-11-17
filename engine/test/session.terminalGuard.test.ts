import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitChangesRepository,
  TERMINAL_GIT_ASK_REASON,
  TERMINAL_GIT_DENY_REASON,
  TERMINAL_GIT_NO_ASK_REASON,
  terminalBashDecision,
  terminalEditDecision,
} from "../src/session/terminalGuard.js";
import { TERMINAL_GIT_INSTRUCTION, TERMINAL_SYSTEM_APPEND } from "../src/session/terminalSpec.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

// docs/PROTOCOL.md §57.8: a terminal chat's PreToolUse guard — git that changes the repository asks (in every mode the TUI
// can ask in), git that throws work away is blocked, edits the review does not see ask. Real git in a temp repository; never
// the real claude.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const dir = realpathSync(makeTempDir("rg-term-guard"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const decide = (dir: string, command: string, mode?: string, reviewPaths: ReadonlySet<string> = new Set()) =>
  terminalBashDecision(command, { cwd: dir, root: dir, reviewPaths, mode });

describe("terminal guard: git (§57.8)", () => {
  it("asks before git that changes the repository — commit (the incident), push, merge, rebase, checkout, stash, tag, …", async () => {
    const dir = repo();
    for (const c of [
      "git commit -m wip",
      "git commit -am 'feat: x'",
      "git -c user.email=a@b.c commit -m x",
      "git -C . commit -m x",
      "git add -A",
      "git push",
      "git push origin main",
      "git merge feature",
      "git rebase main",
      "git pull",
      "git checkout -b topic",
      "git switch -c topic",
      "git stash",
      "git stash pop",
      "git tag v1",
      "git branch topic",
      "git cherry-pick abc123",
      "git revert HEAD",
      "git am fix.patch",
      "git reflog expire --all",
      "git fetch --prune",
      "gh pr checkout 12",
      "gh pr merge 12",
    ]) {
      expect(await decide(dir, c), c).toEqual({ decision: "ask", reason: TERMINAL_GIT_ASK_REASON });
    }
  });

  it("reads chained, piped and wrapped command lines as git does", async () => {
    const dir = repo();
    for (const c of [
      "npm test && git commit -am x",
      "git status; git commit -m x",
      "true || git push",
      "echo done | git commit -F -",
      "bash -c 'git commit -m x'",
      "sh -c \"cd sub && git push\"",
      "eval 'git tag v2'",
      "git diff --name-only | xargs git add",
      "env GIT_AUTHOR_NAME=x git commit -m y",
      "(cd . && git commit -m x)",
    ]) {
      expect((await decide(dir, c))?.decision, c).toBe("ask");
    }
  });

  it("blocks what throws away uncommitted work or rewrites the remote", async () => {
    const dir = repo();
    write(dir, "README.md", "changed\n"); // uncommitted work
    for (const c of [
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git checkout -- .",
      "git checkout .",
      "git restore README.md",
      "git clean -fd",
      "git stash drop",
      "git stash clear",
      "git push --force",
      "git push -f origin main",
      "git push origin +main",
      "git branch -D topic",
      "npm test && git reset --hard",
      "sh -c 'git clean -fdx'",
    ]) {
      expect(await decide(dir, c), c).toEqual({ decision: "deny", reason: TERMINAL_GIT_DENY_REASON });
    }
  });

  it("leaves read-only git and everything else to the TUI", async () => {
    const dir = repo();
    for (const c of [
      "git status",
      "git status --short",
      "git diff",
      "git diff --cached HEAD~1",
      "git log --oneline -5",
      "git --no-pager log -1",
      "git show HEAD",
      "git branch",
      "git branch --list",
      "git -C . status",
      "git rev-parse HEAD",
      "git blame README.md",
      "git stash list",
      "git remote -v",
      "git --version",
      "git fetch",
      "git reflog",
      "npm test",
      "echo 'git commit -m x'",
      "grep -r 'git push' docs",
    ]) {
      expect(await decide(dir, c), c).toBeNull();
    }
  });

  it("blocks instead of asking where Claude Code never asks (bypassPermissions, dontAsk); asks in auto and the rest", async () => {
    const dir = repo();
    expect(await decide(dir, "git commit -m x", "bypassPermissions")).toEqual({ decision: "deny", reason: TERMINAL_GIT_NO_ASK_REASON });
    expect(await decide(dir, "git commit -m x", "dontAsk")).toEqual({ decision: "deny", reason: TERMINAL_GIT_NO_ASK_REASON });
    for (const mode of ["auto", "acceptEdits", "default", "plan"]) {
      expect((await decide(dir, "git commit -m x", mode))?.decision, mode).toBe("ask");
    }
    expect(await decide(dir, "git status", "bypassPermissions")).toBeNull();
  });

  it("checking out over a file under review is blocked even when it is committed", async () => {
    const dir = repo();
    expect((await decide(dir, "git checkout HEAD~0 -- README.md", undefined, new Set(["README.md"])))?.decision).toBe("deny");
  });

  it("gitChangesRepository: only git's words count", () => {
    expect(gitChangesRepository("git commit -m x", "/")).toBe(true);
    expect(gitChangesRepository("cat <<'EOF'\ngit commit -m x\nEOF", "/")).toBe(false);
    expect(gitChangesRepository("ls -la", "/")).toBe(false);
  });
});

describe("terminal guard: edits (§57.8)", () => {
  it("asks before an edit outside the project, in .git, in a nested repository or Claude Code's settings; not inside", () => {
    const dir = repo();
    const outside = realpathSync(makeTempDir("rg-term-guard-out"));
    dirs.push(outside);
    mkdirSync(join(outside, "x"), { recursive: true });
    const opts = { root: dir };
    expect(terminalEditDecision(join(dir, "src", "a.ts"), opts)).toBeNull();
    for (const f of [join(outside, "x", "b.ts"), join(dir, ".git", "config"), join(dir, ".claude", "settings.json")]) {
      expect(terminalEditDecision(f, opts)?.decision, f).toBe("ask");
    }
    expect(terminalEditDecision(join(outside, "x", "b.ts"), opts)?.reason).toMatch(/^ReviewGate: This edit is outside the project/);
    // Where the TUI never asks, it is blocked.
    expect(terminalEditDecision(join(outside, "x", "b.ts"), { ...opts, mode: "bypassPermissions" })?.decision).toBe("deny");
    // A plan file and Claude's memory are never asked for.
    expect(terminalEditDecision(join(outside, "x", "plan.md"), { ...opts, isPlanFile: () => true })).toBeNull();
    expect(terminalEditDecision(join(homedir(), ".claude", "projects", "p", "memory", "MEMORY.md"), opts)).toBeNull();
  });
});

describe("terminal system append (§57.8)", () => {
  it("carries the git rule", () => {
    expect(TERMINAL_SYSTEM_APPEND).toContain(TERMINAL_GIT_INSTRUCTION);
    expect(TERMINAL_GIT_INSTRUCTION).toMatch(/only when the user \(or a skill they ran\) asks you to, never on your own\s+initiative/);
  });
});
