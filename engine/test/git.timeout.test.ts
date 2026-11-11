// MARK: wave4 w4-safety — robustness-07: a hung git call of a snapshot / collect / revert ends with an error instead of
// holding the main lane forever (a VPN that dropped under an LFS filter, a lock another git process holds).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKPOINT_GIT_TIMEOUT_MS,
  GitCheckpoint,
  GitTimeoutError,
  OPEN_GIT_TIMEOUT_MS,
  openCheckpoint,
  setCheckpointGitTimeout,
  setOpenGitTimeout,
} from "../src/git/checkpoint.js";
import { GitCommandError, NotARepositoryError, getGitPath, setGitPath } from "../src/git/exec.js";
import { makeHarness } from "./helpers/engine.js";
import { makeRepo, makeTempDir, removeDir } from "./helpers/repo.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const realGit = getGitPath();
afterEach(() => {
  setGitPath(realGit);
  setCheckpointGitTimeout(CHECKPOINT_GIT_TIMEOUT_MS);
  setOpenGitTimeout(OPEN_GIT_TIMEOUT_MS);
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
    setGitPath(fakeGit("sleep 60; echo never"));
    setCheckpointGitTimeout(300);
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const started = Date.now();
    const err = await cp.git(["add", "-A"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect((err as Error).message).toContain("git add");
    expect((err as Error).message).toContain("did not respond");
    // the fake git outlives the bound (60 s), so only the timeout can end the call in time; wide for a stalled runner
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("ends even while a process left behind keeps the output open", async () => {
    // A background child survives the killed script and holds stdout / stderr: exec alone would wait for it (60 s).
    setGitPath(fakeGit("sleep 60 &\nwait"));
    setCheckpointGitTimeout(200);
    const cp = new GitCheckpoint(makeTempDir());
    dirs.push(cp.root);
    const started = Date.now();
    const err = await cp.git(["add", "-A"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect(Date.now() - started).toBeLessThan(30_000);
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
    const out = await cp.git(["rev-parse"], { timeoutMs: 30_000 });
    expect(out.text.trim()).toBe("ok");
  });

  // 0.5.12: the Mac app's open waited for ever on a `git rev-parse --show-toplevel` that never answered in the project
  // folder — no window opened it, nothing said why. Capped, the open ends with `project_open_failed` (the window's banner).
  it("open_project's first git call is capped: a git that does not answer is a timeout, not \"not a repository\"", async () => {
    setGitPath(fakeGit("sleep 30; echo never"));
    setOpenGitTimeout(300);
    const dir = makeTempDir();
    dirs.push(dir);
    const started = Date.now();
    const err = await openCheckpoint(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect(err).not.toBeInstanceOf(NotARepositoryError);
    expect((err as Error).message).toContain("git rev-parse");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("open_project with a git that does not answer ends with project_open_failed — no git-init offer", async () => {
    const h = makeHarness();
    await h.hello();
    setGitPath(fakeGit("sleep 30; echo never"));
    setOpenGitTimeout(300);
    const dir = makeTempDir();
    dirs.push(dir);
    await h.engine.handle({ type: "open_project", path: dir });
    await h.settle();
    const errors = h.ofType("error");
    expect(errors.map((e) => e.code)).toContain("project_open_failed");
    expect(errors.find((e) => e.code === "project_open_failed")?.message).toContain("did not respond");
    expect(h.engine.state.gitInit).toBeNull();
    expect(h.engine.state.project).toBeNull();
    await h.engine.dispose();
  }, 30_000);

  it("a newer open does not wait behind an open whose git does not answer", async () => {
    const h = makeHarness();
    await h.hello();
    setGitPath(fakeGit("sleep 30; echo never"));
    setOpenGitTimeout(20_000);
    const stuck = makeTempDir();
    dirs.push(stuck);
    const first = h.engine.handle({ type: "open_project", path: stuck });
    await new Promise((r) => setTimeout(r, 300));   // the first open is inside its git call
    setGitPath(realGit);
    const repo = makeRepo();
    dirs.push(repo);
    const started = Date.now();
    const s = await h.open(repo);
    await first;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(s.project?.path).toBe(repo);
    expect(h.ofType("error").map((e) => e.code)).not.toContain("project_open_failed");
    await h.engine.dispose();
  }, 30_000);
});
