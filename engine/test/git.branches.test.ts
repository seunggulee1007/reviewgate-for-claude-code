import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { branches, createBranch, defaultBranch, isWorktreeDirty, parseTrack, remoteBranches, switchBranch, worktreeStatus } from "../src/git/branches.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { GitCommandError } from "../src/git/exec.js";
import { makeBranchRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("git branches", () => {
  it("list, create, switch and dirty", async () => {
    const dir = track(makeBranchRepo());
    const cp = await openCheckpoint(dir);

    let list = await branches(cp);
    expect(list.map((b) => b.name)).toEqual(["main"]);
    expect(list[0]!.isCurrent).toBe(true);
    expect(list[0]!.lastCommitDate).not.toBeNull();
    expect(list[0]!.upstream).toBeNull();
    expect(await isWorktreeDirty(cp)).toBe(false);

    await createBranch(cp, "feature/x");
    list = await branches(cp);
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe("feature/x"); // current first
    expect(list[0]!.isCurrent).toBe(true);
    expect(list.some((b) => b.name === "main" && !b.isCurrent)).toBe(true);
    expect(await cp.branchName()).toBe("feature/x");

    // Create without checkout from main: HEAD stays on feature/x.
    await createBranch(cp, "topic", "main", false);
    expect(await cp.branchName()).toBe("feature/x");
    expect((await branches(cp)).some((b) => b.name === "topic" && !b.isCurrent)).toBe(true);

    await switchBranch(cp, "main");
    expect(await cp.branchName()).toBe("main");
    expect((await branches(cp))[0]!.name).toBe("main");

    // Invalid names are rejected by check-ref-format before anything is created.
    await expect(createBranch(cp, "bad name")).rejects.toBeInstanceOf(GitCommandError);
    expect(await branches(cp)).toHaveLength(3);

    write(dir, "a.txt", "b\n");
    expect(await isWorktreeDirty(cp)).toBe(true);
    // a.txt is identical on both branches so the switch is allowed; the untracked case counts as dirty too.
    write(dir, "a.txt", "a\n");
    write(dir, "untracked.txt", "u\n");
    expect(await isWorktreeDirty(cp)).toBe(true);

    // fileContent: worktree vs a tree.
    const tree = await cp.snapshot();
    expect((await cp.fileContent("a.txt", null)).toString("utf8")).toBe("a\n");
    expect((await cp.fileContent("untracked.txt", tree)).toString("utf8")).toBe("u\n");
  });

  // MARK: a-gitflow — §61
  it("worktreeStatus: untracked and ignored-pattern paths never block a switch; renames count by either path", async () => {
    const dir = track(makeBranchRepo());
    const cp = await openCheckpoint(dir);
    expect(await worktreeStatus(cp, [".omc/"])).toMatchObject({ dirty: false, blocksSwitch: false });
    write(dir, "u.txt", "u\n");
    write(dir, ".omc/x.json", "{}\n");
    expect(await worktreeStatus(cp, [".omc/"])).toMatchObject({ dirty: true, blocksSwitch: false });
    write(dir, "a.txt", "b\n");
    expect(await worktreeStatus(cp, [".omc/"])).toMatchObject({ dirty: true, blocksSwitch: true });
    expect(await worktreeStatus(cp, ["a.txt"])).toMatchObject({ dirty: true, blocksSwitch: false });
    write(dir, "a.txt", "a\n");
    sh(dir, "mv", "a.txt", "renamed with space.txt");
    expect(await worktreeStatus(cp, ["a.txt"])).toMatchObject({ dirty: true, blocksSwitch: true });
    expect(await worktreeStatus(cp, ["a.txt", "renamed"])).toMatchObject({ dirty: true, blocksSwitch: false });
  });

  it("defaultBranch: origin/HEAD, else main / master", async () => {
    const remote = track(makeBranchRepo());
    sh(remote, "branch", "develop");
    sh(remote, "symbolic-ref", "HEAD", "refs/heads/develop");
    const dir = track(makeTempDir("rg-clone"));
    execFileSync("git", ["clone", "-q", remote, dir], { env: { ...process.env, LC_ALL: "C" } });
    const cp = await openCheckpoint(dir);
    expect(await defaultBranch(cp, await branches(cp), await remoteBranches(cp))).toBe("develop");
    sh(dir, "remote", "set-head", "origin", "--delete");
    expect(await defaultBranch(cp, await branches(cp), await remoteBranches(cp))).toBe("main");
    const local = track(makeBranchRepo());
    const lcp = await openCheckpoint(local);
    expect(await defaultBranch(lcp, await branches(lcp), [])).toBe("main");
    sh(local, "branch", "-m", "main", "trunk");
    expect(await defaultBranch(lcp, await branches(lcp), [])).toBeNull();
  });

  it("ahead/behind parsing", () => {
    expect(parseTrack("[ahead 1, behind 2]")).toEqual({ ahead: 1, behind: 2 });
    expect(parseTrack("[ahead 3]")).toEqual({ ahead: 3, behind: 0 });
    expect(parseTrack("[behind 4]")).toEqual({ ahead: 0, behind: 4 });
    expect(parseTrack("[gone]")).toEqual({ ahead: 0, behind: 0 });
    expect(parseTrack("")).toEqual({ ahead: 0, behind: 0 });
  });

  it("upstream ahead/behind from a local remote", async () => {
    const remote = track(makeBranchRepo());
    const dir = track(makeTempDir("rg-clone"));
    execFileSync("git", ["clone", "-q", remote, dir], { env: { ...process.env, LC_ALL: "C" } });
    sh(dir, "config", "user.email", "test@example.com");
    sh(dir, "config", "user.name", "Test");
    write(dir, "c.txt", "c\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "local");

    const cp = await openCheckpoint(dir);
    const main = (await branches(cp)).find((b) => b.name === "main");
    expect(main).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });
    expect(cp.root).toBe(realpathSync(dir)); // native form (docs/PROTOCOL.md §20)
  });

  it("sorts by commit date descending after the current branch", async () => {
    const dir = track(makeBranchRepo());
    const cp = await openCheckpoint(dir);
    const commitOn = (name: string, date: string): void => {
      sh(dir, "switch", "-q", "-c", name, "main");
      write(dir, `${name}.txt`, "x\n");
      sh(dir, "add", "-A");
      execFileSync("git", ["-C", dir, "commit", "-qm", name], {
        env: { ...process.env, LC_ALL: "C", GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
      });
    };
    commitOn("old", "2020-01-01T00:00:00Z");
    commitOn("newer", "2021-01-01T00:00:00Z");
    sh(dir, "switch", "-q", "main");
    const names = (await branches(cp)).map((b) => b.name);
    expect(names[0]).toBe("main");
    expect(names.slice(1)).toEqual(["newer", "old"]);
  });
});
