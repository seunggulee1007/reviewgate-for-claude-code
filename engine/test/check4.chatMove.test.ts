import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveTarget } from "../src/review/chatMove.js";
import { parseWorktreeList } from "../src/git/worktrees.js";
import { makeRepo, makeTempDir, removeDir, sh } from "./helpers/repo.js";

/**
 * MARK: wave4b w4b-check4 — docs/PROTOCOL.md §40.1: the adversarial cases of §39.4's target rule — a chat only ever moves
 * to a worktree of this repository: never through a symlink to another folder, `..`, or another repository's worktree.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const isWindows = process.platform === "win32";

function repoWithWorktree(): { main: string; wt: string } {
  const main = realpathSync(makeRepo());
  const wt = `${main}-wt`;
  sh(main, "worktree", "add", "-q", "-b", "feat", wt);
  dirs.push(main, wt);
  return { main, wt };
}

describe("chat_move target (§39.4) against tricks", () => {
  it.skipIf(isWindows)("a symlink to an unrelated folder or to another repository's worktree is not a worktree of this repository", () => {
    const { main } = repoWithWorktree();
    const other = realpathSync(makeRepo());
    const otherWt = `${other}-wt`;
    sh(other, "worktree", "add", "-q", "-b", "x", otherWt);
    const elsewhere = realpathSync(makeTempDir("rg-elsewhere"));
    dirs.push(other, otherWt, elsewhere);
    const list = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    symlinkSync(elsewhere, join(main, "link-out"));
    symlinkSync(otherWt, join(main, "link-other"));
    expect(moveTarget(join(main, "link-out"), main, list)).toEqual({ refused: "not_a_worktree" });
    expect(moveTarget(join(main, "link-other"), main, list)).toEqual({ refused: "not_a_worktree" });
    expect(moveTarget(otherWt, main, list)).toEqual({ refused: "not_a_worktree" });
    expect(moveTarget(other, main, list)).toEqual({ refused: "not_a_worktree" });
  });

  it("`..` out of this repository's worktree and a relative path are resolved before the check", () => {
    const { main, wt } = repoWithWorktree();
    const elsewhere = realpathSync(makeTempDir("rg-elsewhere"));
    dirs.push(elsewhere);
    mkdirSync(join(wt, "src"), { recursive: true });
    const list = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    expect(moveTarget(join(wt, "..", elsewhere.split(/[\\/]/).pop()!), main, list)).toHaveProperty("refused"); // never a target
    expect(moveTarget(join(wt, "src", "..", ".."), main, list)).toEqual({ refused: "not_a_worktree" });
    // A relative path is this window's: `../<main>-wt` from the main worktree names the worktree next to it.
    expect(moveTarget(`../${wt.split(/[\\/]/).pop()}`, main, list)).toMatchObject({ root: wt });
  });

  it.skipIf(isWindows)("a symlink inside this window's folder to this repository's other worktree names that worktree (it is one)", () => {
    const { main, wt } = repoWithWorktree();
    const list = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    symlinkSync(wt, join(main, "link-wt"));
    expect(moveTarget(join(main, "link-wt"), main, list)).toMatchObject({ root: wt, branch: "feat" });
  });
});
