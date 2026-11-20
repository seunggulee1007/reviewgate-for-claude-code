import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckpoint, openCheckpoint } from "../src/git/checkpoint.js";
import { NotARepositoryError, registerShadowRepo, runGit, shadowArgs, shadowGitDirFor } from "../src/git/exec.js";
import { setLargeFileLimit, DEFAULT_LARGE_FILE_MB } from "../src/git/largeFiles.js";
import {
  FolderTooLargeError,
  hasShadowRepo,
  markShadowRepo,
  prepareShadowRepo,
  scanShadowFolder,
  shadowBaseline,
  shadowRepoDir,
  SHADOW_IDENTITY,
  SHADOW_LIMITS,
} from "../src/git/shadow.js";
import { gitInternalKind, gitInternalDirs, type HookContext } from "../src/session/hooks.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const releases: (() => void)[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const r of releases.splice(0)) r();
  setLargeFileLimit(DEFAULT_LARGE_FILE_MB * 1024 * 1024);
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A plain folder (no repository) with two files, its real path; and an empty data folder. */
function setup(): { folder: string; data: string } {
  const folder = realpathSync.native(track(makeTempDir("rg-shadow-folder")));
  write(folder, "a.txt", "a\n");
  write(folder, "src/b.ts", "export const b = 1;\n");
  const data = track(makeTempDir("rg-shadow-data"));
  return { folder, data };
}

async function prepared(): Promise<{ folder: string; data: string; gitDir: string }> {
  const { folder, data } = setup();
  const gitDir = await prepareShadowRepo(data, folder);
  releases.push(registerShadowRepo(folder, gitDir));
  return { folder, data, gitDir };
}

describe("runGit shadow registry (§59)", () => {
  it("runs a registered folder's git on its hidden repository; discovery and other folders are untouched; counted releases", async () => {
    const { folder, data } = setup();
    expect(shadowGitDirFor(folder)).toBeNull();
    expect((await runGit(folder, ["rev-parse", "--git-dir"], { allowFailure: true })).status).not.toBe(0);
    const gitDir = await prepareShadowRepo(data, folder);
    const release1 = registerShadowRepo(folder, gitDir);
    const release2 = registerShadowRepo(folder, gitDir);
    expect(shadowGitDirFor(folder)).toBe(gitDir);
    expect(shadowArgs(folder)).toEqual([`--git-dir=${gitDir}`, `--work-tree=${folder}`]);
    expect(realpathSync.native((await runGit(folder, ["rev-parse", "--git-dir"])).text.trim())).toBe(realpathSync.native(gitDir));
    expect(realpathSync.native((await runGit(folder, ["rev-parse", "--show-toplevel"])).text.trim())).toBe(folder);
    // A subfolder discovers as before (none here); `discover` ignores the registry.
    expect((await runGit(join(folder, "src"), ["rev-parse", "--git-dir"], { allowFailure: true })).status).not.toBe(0);
    expect((await runGit(folder, ["rev-parse", "--git-dir"], { allowFailure: true, discover: true })).status).not.toBe(0);
    await expect(openCheckpoint(folder, undefined, { discover: true })).rejects.toBeInstanceOf(NotARepositoryError);
    expect((await openCheckpoint(folder)).root).toBe(folder);
    release1();
    release1(); // a second call of the same release does nothing
    expect(shadowGitDirFor(folder)).toBe(gitDir);
    release2();
    expect(shadowGitDirFor(folder)).toBeNull();
    expect(existsSync(join(folder, ".git"))).toBe(false);
  });
});

describe("hooks in a folder tracked without git (§59)", () => {
  it("the hooks' checkpoint is the folder on the hidden repository; an edit there is git's own data", async () => {
    const { folder, gitDir } = await prepared();
    await shadowBaseline(folder);
    const ctx = { cwd: folder, budget: {}, ignorePatterns: [], autoAllowTools: new Set<string>() } as unknown as HookContext;
    const dirs = await gitInternalDirs(ctx);
    expect(dirs.map((d) => realpathSync.native(d))).toContain(realpathSync.native(gitDir));
    expect(ctx.root).toBe(folder);
    expect(gitInternalKind(join(gitDir, "HEAD"), dirs)).toBe("machinery");
    expect(gitInternalKind(join(folder, "a.txt"), dirs)).toBeNull();
  });
});

describe("hidden repository (§59)", () => {
  it("is created under <dataDir>/shadow-repos with its own identity and excludes; the choice is remembered only once marked", async () => {
    const { folder, data, gitDir } = await prepared();
    expect(gitDir.startsWith(join(data, "shadow-repos"))).toBe(true);
    expect(shadowRepoDir(data, folder)).toBe(gitDir);
    expect(sh(gitDir, "config", "user.name").trim()).toBe(SHADOW_IDENTITY.name);
    expect(sh(gitDir, "config", "user.email").trim()).toBe(SHADOW_IDENTITY.email);
    expect(sh(gitDir, "config", "commit.gpgsign").trim()).toBe("false");
    expect(sh(gitDir, "config", "core.bare").trim()).toBe("true");
    const exclude = readFileSync(join(gitDir, "info", "exclude"), "utf8");
    for (const p of ["node_modules/", ".DS_Store", "build/", "dist/", ".venv/", "__pycache__/", "target/", "*.log"]) expect(exclude).toContain(p);
    expect(hasShadowRepo(data, folder)).toBe(false);
    await markShadowRepo(data, folder);
    expect(hasShadowRepo(data, folder)).toBe(true);
    // Prepared again: the same repository, its edited excludes kept.
    write(gitDir, "info/exclude", "custom/\n");
    expect(await prepareShadowRepo(data, folder)).toBe(gitDir);
    expect(readFileSync(join(gitDir, "info", "exclude"), "utf8")).toBe("custom/\n");
  });

  it("baseline: the folder's state is HEAD (excludes applied), a second one commits only when the folder changed", async () => {
    const { folder, gitDir } = await prepared();
    write(folder, "node_modules/x/index.js", "x\n");
    write(folder, "debug.log", "log\n");
    const first = await shadowBaseline(folder);
    expect(first.committed).toBe(true);
    expect(first.files).toBe(2);
    const files = (await runGit(folder, ["ls-tree", "-r", "--name-only", "HEAD"])).text.trim().split("\n");
    expect(files).toEqual(["a.txt", "src/b.ts"]);
    expect((await runGit(folder, ["log", "-1", "--format=%an <%ae>|%s"])).text.trim()).toBe(`${SHADOW_IDENTITY.name} <${SHADOW_IDENTITY.email}>|ReviewGate baseline`);
    const again = await shadowBaseline(folder);
    expect(again).toMatchObject({ committed: false, head: first.head });
    write(folder, "a.txt", "a2\n");
    const third = await shadowBaseline(folder);
    expect(third.committed).toBe(true);
    expect((await runGit(folder, ["rev-parse", "HEAD^"])).text.trim()).toBe(first.head);
    // The snapshot machinery works as in a repository.
    const cp = new GitCheckpoint(folder);
    const a = await cp.snapshot();
    write(folder, "c.txt", "c\n");
    const b = await cp.snapshot();
    expect((await cp.changes(a, b)).map((f) => [f.path, f.status])).toEqual([["c.txt", "A"]]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(existsSync(join(gitDir, "index"))).toBe(true);
  });

  it("size guard: too many files, too many bytes — refused with the limit named; untracked large files are not counted", async () => {
    const { folder } = await prepared();
    for (let i = 0; i < 5; i++) write(folder, `f${i}.txt`, "x".repeat(100));
    const filesErr = await scanShadowFolder(folder, { ...SHADOW_LIMITS, maxFiles: 4 }).catch((e: unknown) => e);
    expect(filesErr).toBeInstanceOf(FolderTooLargeError);
    expect((filesErr as FolderTooLargeError).limit).toBe("files");
    expect((filesErr as FolderTooLargeError).message).toMatch(/^folder_too_large:files/);
    const bytesErr = await scanShadowFolder(folder, { ...SHADOW_LIMITS, maxBytes: 300 }).catch((e: unknown) => e);
    expect((bytesErr as FolderTooLargeError).limit).toBe("bytes");
    // A large untracked file: left out of the bytes and of the baseline (snapshots keep a stub for it).
    setLargeFileLimit(1000);
    write(folder, "big.bin", Buffer.alloc(5000, 1));
    const scan = await scanShadowFolder(folder, { ...SHADOW_LIMITS, maxBytes: 1000 });
    expect(scan.largeUntracked).toEqual(["big.bin"]);
    const base = await shadowBaseline(folder, { ...SHADOW_LIMITS, maxBytes: 1000 });
    expect(base.committed).toBe(true);
    expect((await runGit(folder, ["ls-tree", "-r", "--name-only", "HEAD"])).text).not.toContain("big.bin");
  });
});
