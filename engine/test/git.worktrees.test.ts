import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandError } from "../src/git/exec.js";
import { toNativeAbs } from "../src/platform/paths.js";
import {
  addWorktree,
  branchExists,
  canonicalPath,
  commonDir,
  gitDir,
  isValidBranchName,
  linkedGitDir,
  listWorktrees,
  managedWorktreeRoot,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  repoName,
  slugify,
  worktreeDirty,
} from "../src/git/worktrees.js";
import { makeBranchRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** `main` with a.txt committed; git prints the resolved toplevel (/private/var on macOS). */
function makeRepo(): string {
  return track(realpathSync(makeBranchRepo("rg-wt")));
}

describe("git worktrees", () => {
  it("parseWorktreeList reads main, linked, detached, locked, prunable and bare entries", () => {
    const text = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /wt/feature-x",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/x",
      "locked reason with spaces",
      "",
      "worktree /wt/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /bare.git",
      "bare",
      "",
    ].join("\n");
    const list = parseWorktreeList(text);
    expect(list.map((w) => [w.path, w.branch, w.detached, w.locked, w.lockReason, w.prunable, w.bare])).toEqual([
      [toNativeAbs("/repo"), "main", false, false, null, false, false],
      [toNativeAbs("/wt/feature-x"), "feature/x", false, true, "reason with spaces", false, false],
      [toNativeAbs("/wt/detached"), null, true, false, null, true, false],
      [toNativeAbs("/bare.git"), null, false, false, null, false, true],
    ]);
    expect(list[1]!.head).toBe("2222222222222222222222222222222222222222");
    expect(list[2]!.prunableReason).toBe("gitdir file points to non-existent location");
    expect(parseWorktreeList("")).toEqual([]);
    // Git for Windows prints C:/…; the listing carries the native form (docs/PROTOCOL.md §20).
    expect(parseWorktreeList("worktree C:/Users/x/repo\nHEAD 1\n")[0]!.path).toBe(toNativeAbs("C:/Users/x/repo"));
  });

  it("list → add (new branch, existing branch) → gitdir/commonDir → remove → prune", async () => {
    const repo = makeRepo();
    const root = track(realpathSync(makeTempDir("rg-wt-root")));
    const first = await listWorktrees(repo);
    expect(first.map((w) => [w.path, w.branch])).toEqual([[repo, "main"]]);
    expect(first[0]!.head).toBe(sh(repo, "rev-parse", "HEAD").trim());
    expect(await commonDir(repo)).toBe(join(repo, ".git"));
    expect(await gitDir(repo)).toBe(join(repo, ".git"));

    // New branch from HEAD; parent folder is created on demand.
    const wt1 = join(root, "nested", "feature-x");
    await addWorktree(repo, { path: wt1, branch: "feature/x", existingBranch: false });
    expect(existsSync(join(wt1, "a.txt"))).toBe(true);
    expect(sh(wt1, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/x");
    expect(await branchExists(repo, "feature/x")).toBe(true);

    // Existing branch (created without checkout) → `worktree add <path> <branch>`.
    sh(repo, "branch", "topic");
    const wt2 = join(root, "topic");
    await addWorktree(repo, { path: wt2, branch: "topic", existingBranch: true });
    expect(sh(wt2, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("topic");

    // `from` for a new branch.
    sh(repo, "commit", "-q", "--allow-empty", "-m", "second");
    const wt3 = join(root, "old");
    await addWorktree(repo, { path: wt3, branch: "old", from: "HEAD~1", existingBranch: false });
    expect(sh(wt3, "rev-parse", "HEAD").trim()).toBe(sh(repo, "rev-parse", "HEAD~1").trim());

    // Main is always first; linked worktrees follow in git's own (directory-name) order.
    const list = await listWorktrees(repo);
    expect(list[0]!.path).toBe(repo);
    expect(list.slice(1).map((w) => w.branch).sort()).toEqual(["feature/x", "old", "topic"]);
    expect(list.find((w) => w.branch === "feature/x")!.path).toBe(wt1);

    // Linked worktree: `.git` is a file → real gitdir under <common>/worktrees/<name>.
    const common = await commonDir(wt1);
    expect(common).toBe(join(repo, ".git"));
    const linked = await gitDir(wt1);
    expect(linked.startsWith(join(repo, ".git", "worktrees") + sep)).toBe(true);
    expect(await linkedGitDir(list.find((w) => w.path === wt1)!, common, false)).toBe(linked);
    expect(await linkedGitDir(list[0]!, common, true)).toBe(common);

    // Dirty per worktree (untracked counts), bounded by 2 s.
    expect(await worktreeDirty(wt1)).toBe(false);
    write(wt1, "scratch.txt", "x\n");
    expect(await worktreeDirty(wt1)).toBe(true);
    expect(await worktreeDirty(repo)).toBe(false);
    expect(await worktreeDirty(join(root, "does-not-exist"))).toBeNull();

    // Git itself refuses a dirty worktree without --force; --force removes it.
    await expect(removeWorktree(repo, wt1, false)).rejects.toBeInstanceOf(GitCommandError);
    expect(existsSync(wt1)).toBe(true);
    await removeWorktree(repo, wt1, true);
    expect(existsSync(wt1)).toBe(false);
    await removeWorktree(repo, wt2, false);
    expect((await listWorktrees(repo)).map((w) => w.branch)).toEqual(["main", "old"]);
    expect(await branchExists(repo, "feature/x")).toBe(true); // the branch survives the worktree

    // Manual `rm -rf` leaves a prunable entry; prune drops it.
    rmSync(wt3, { recursive: true, force: true });
    const stale = await listWorktrees(repo);
    expect(stale.find((w) => w.path === wt3)?.prunable).toBe(true);
    expect(await linkedGitDir(stale.find((w) => w.path === wt3)!, common, false)).toBeNull();
    await pruneWorktrees(repo);
    expect((await listWorktrees(repo)).map((w) => w.branch)).toEqual(["main"]);
  });

  it("git refuses a branch checked out elsewhere and an existing path; check-ref-format validates names", async () => {
    const repo = makeRepo();
    const root = track(realpathSync(makeTempDir("rg-wt-root")));
    await expect(addWorktree(repo, { path: join(root, "m"), branch: "main", existingBranch: true })).rejects.toThrow(/already (checked out|used by worktree)/);
    mkdirSync(join(root, "taken"));
    write(root, "taken/file.txt", "x\n");
    await expect(addWorktree(repo, { path: join(root, "taken"), branch: "t", existingBranch: false })).rejects.toThrow(/already exists/);
    expect(await isValidBranchName(repo, "feature/x")).toBe(true);
    expect(await isValidBranchName(repo, "bad..name")).toBe(false);
    expect(await isValidBranchName(repo, "-flag")).toBe(false);
    expect(await isValidBranchName(repo, "")).toBe(false);
    expect(await isValidBranchName(repo, "a b")).toBe(false);
  });

  it("managedWorktreeRoot, repoName and slugify", () => {
    const a = managedWorktreeRoot({}, "/x/my-repo/.git");
    expect(a).toMatch(/[\\/]\.reviewgate[\\/]worktrees[\\/]my-repo-[0-9a-f]{8}$/);
    const b = managedWorktreeRoot({}, "/y/my-repo/.git");
    expect(b).not.toBe(a); // same name, different clone → different hash
    // Native form of the host (`D:\\custom\\root\\…` on a Windows runner).
    const custom = managedWorktreeRoot({ worktreeRoot: "/custom/root" }, "/x/my-repo/.git");
    expect(custom.startsWith(join(resolve("/custom/root"), "my-repo-"))).toBe(true);
    expect(custom).toMatch(/my-repo-[0-9a-f]{8}$/);
    // The base is symlink-resolved as far as it exists (git prints /private/var for /var on macOS).
    const tmp = makeTempDir("rg-wt-managed");
    dirs.push(tmp);
    const notYet = managedWorktreeRoot({ worktreeRoot: join(tmp, "not", "yet") }, "/x/r/.git");
    expect(notYet.startsWith(join(realpathSync.native(tmp), "not", "yet", "r-"))).toBe(true);
    expect(notYet).toMatch(/r-[0-9a-f]{8}$/);
    expect(canonicalPath("/definitely/not/existing/anywhere")).toBe(resolve("/definitely/not/existing/anywhere"));
    expect(managedWorktreeRoot({ worktreeRoot: "  " }, "/x/my-repo/.git")).toBe(a);
    expect(repoName("/x/my-repo/.git")).toBe("my-repo");
    expect(repoName("/x/my-repo/.git/")).toBe("my-repo");
    expect(repoName("/srv/bare.git")).toBe("bare");
    expect(slugify("feature/x y")).toBe("feature-x-y");
    expect(slugify("rg-wb")).toBe("rg-wb");
    expect(slugify("--/..")).toBe("branch");
    expect(slugify("release/v1.2.3")).toBe("release-v1.2.3");
  });
});
