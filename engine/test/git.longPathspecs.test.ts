// MARK: wave4 w4-install — a Windows command line stops at 32 767 characters: committing (or overlaying) hundreds of
// files must not put every path on it (3rd-round check-engine report).
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { commit, stagePaths } from "../src/git/commit.js";
import { chunkPaths, MAX_PATHSPEC_CHARS, pathsLength } from "../src/git/pathspecs.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

// Every git command line the code under test builds (the real git still runs).
const recorded = vi.hoisted(() => [] as string[][]);
vi.mock("../src/git/exec.js", async (orig) => {
  const real = await orig<typeof import("../src/git/exec.js")>();
  return {
    ...real,
    runGit: (root: string, args: string[], opts?: Parameters<typeof real.runGit>[2]) => {
      recorded.push(args);
      return real.runGit(root, args, opts);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  recorded.splice(0);
  for (const d of dirs.splice(0)) removeDir(d);
});

/** 400 files under a deep folder: ~30 000 characters of paths. */
function manyFiles(dir: string): string[] {
  const paths = Array.from({ length: 400 }, (_, i) => `src/main/java/com/example/acme/module/feature/File${String(i).padStart(4, "0")}.java`);
  for (const p of paths) write(dir, p, `class F${p.length}\n`);
  return paths;
}

/** The longest command line (sum of the arguments) of the git calls made since. */
function spyLongestArgs(): () => number {
  recorded.splice(0);
  return () => Math.max(0, ...recorded.map((args) => args.reduce((n, a) => n + a.length + 1, 0)));
}

describe("long pathspec lists", () => {
  it("chunks paths under the limit, in order, never splitting one", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `dir/${"x".repeat(40)}-${i}.txt`);
    const chunks = chunkPaths(paths, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(paths);
    for (const c of chunks) expect(pathsLength(c)).toBeLessThanOrEqual(2000);
    expect(chunkPaths([], 2000)).toEqual([]);
    // One path longer than the limit still goes, alone.
    expect(chunkPaths(["a".repeat(3000), "b"], 2000)).toEqual([["a".repeat(3000)], ["b"]]);
  });

  it("stages and commits 400 files without a command line over the limit", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const paths = manyFiles(dir);
    expect(pathsLength(paths)).toBeGreaterThan(MAX_PATHSPEC_CHARS * 3);
    const longest = spyLongestArgs();
    const specs = await stagePaths(dir, paths, []);
    expect(specs).toEqual(paths);
    const sha = await commit(dir, "many files", specs);
    expect(longest()).toBeLessThan(MAX_PATHSPEC_CHARS + 1000);
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(sha);
    const committed = sh(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(committed.sort()).toEqual([...paths].sort());
    // `--only`: the untracked file outside the list is not committed.
    expect(sh(dir, "status", "--porcelain")).toContain("untracked.txt");
  });

  it("overlays 400 worktree paths onto a tree the same way", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const cp = await openCheckpoint(dir);
    const base = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    const paths = manyFiles(dir);
    const longest = spyLongestArgs();
    const tree = await cp.overlayWorktree(base, [...paths, "README.md"]);
    expect(longest()).toBeLessThan(MAX_PATHSPEC_CHARS + 1000);
    const listed = sh(dir, "ls-tree", "-r", "--name-only", tree).trim().split("\n");
    for (const p of paths) expect(listed).toContain(p);
    expect(listed).toContain("README.md");
    expect(listed).not.toContain("untracked.txt");
  });
});
