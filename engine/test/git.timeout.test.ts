// MARK: wave4 w4-safety — robustness-07: a hung git call of a snapshot / collect / revert ends with an error instead of
// holding the main lane forever (a VPN that dropped under an LFS filter, a lock another git process holds).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_GIT_TIMEOUT_MS, GitCheckpoint, GitTimeoutError, setCheckpointGitTimeout } from "../src/git/checkpoint.js";
import { GitCommandError, getGitPath, setGitPath } from "../src/git/exec.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const realGit = getGitPath();
afterEach(() => {
  setGitPath(realGit);
  setCheckpointGitTimeout(CHECKPOINT_GIT_TIMEOUT_MS);
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A "git" that never answers (or fails at once with `exit`). */
function fakeGit(body: string): string {
  const dir = makeTempDir();
  dirs.push(dir);
  const path = join(dir, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(!posix)("checkpoint git timeout", () => {
  it("a git call that does not answer ends with GitTimeoutError", async () => {
    // `sleep` runs as a child of the script (not exec'd): it keeps the output pipes open after the script is killed,
    // like an LFS filter or ssh left behind by a killed git — the call ends anyway.
    setGitPath(fakeGit("sleep 30; echo never"));
    setCheckpointGitTimeout(300);
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const started = Date.now();
    const err = await cp.git(["add", "-A"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect((err as Error).message).toContain("git add");
    expect((err as Error).message).toContain("did not respond");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("ends even while a process left behind keeps the output open", async () => {
    // A background child survives the killed script and holds stdout / stderr: exec alone would wait for it (30 s).
    setGitPath(fakeGit("sleep 30 &\nwait"));
    setCheckpointGitTimeout(200);
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const started = Date.now();
    const err = await cp.git(["add", "-A"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a failing git still throws GitCommandError, and allowFailure still resolves", async () => {
    setGitPath(fakeGit("echo boom >&2; exit 3"));
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const err = await cp.git(["status"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).status).toBe(3);
    const out = await cp.git(["status"], { allowFailure: true });
    expect(out.status).toBe(3);
  });

  it("an explicit timeout of the caller wins over the default", async () => {
    setGitPath(fakeGit("sleep 1; echo ok"));
    setCheckpointGitTimeout(100);
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const out = await cp.git(["rev-parse"], { timeoutMs: 5000 });
    expect(out.text.trim()).toBe("ok");
  });
});
