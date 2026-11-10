import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree, gitDir } from "../src/git/worktrees.js";
import { acquireLock, isForeignLiveLock, isPidAlive, lockPath, readLock, releaseLock, LOCK_FILE } from "../src/review/lock.js";
import { makeBranchRepo, makeTempDir, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A pid that is certainly not running (max pid on Linux is 4194304; macOS 99998). */
const DEAD_PID = 4_000_000_000;
const me = { pid: process.pid, client: "test", host: "box", token: "t1" };
const other = { pid: process.pid, client: "test", host: "box", token: "t2" };

describe("review lock", () => {
  it("isPidAlive: own pid alive, absurd pid dead, invalid pids dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("acquire writes JSON {pid, since, client, host, token}; read parses it; release removes it", async () => {
    const dir = track(makeTempDir("rg-lock"));
    expect(await readLock(dir)).toBeNull();
    const now = () => new Date("2026-09-14T00:00:00.000Z");
    expect(await acquireLock(dir, me, { now })).toEqual({ ok: true });
    expect(lockPath(dir)).toBe(join(dir, LOCK_FILE));
    expect(JSON.parse(readFileSync(lockPath(dir), "utf8"))).toEqual({ pid: process.pid, since: "2026-09-14T00:00:00.000Z", client: "test", host: "box", token: "t1" });
    expect(await readLock(dir)).toEqual({ pid: process.pid, since: "2026-09-14T00:00:00.000Z", client: "test", host: "box", token: "t1" });

    // Not ours → left alone; ours → removed; no owner → unconditional.
    await releaseLock(dir, other);
    expect(existsSync(lockPath(dir))).toBe(true);
    await releaseLock(dir, me);
    expect(existsSync(lockPath(dir))).toBe(false);
    await releaseLock(dir, me); // idempotent
    await acquireLock(dir, other);
    await releaseLock(dir);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("stale (dead pid) and unparsable locks are overwritten; live foreign locks conflict; takeover overrides", async () => {
    const dir = track(makeTempDir("rg-lock"));
    writeFileSync(lockPath(dir), JSON.stringify({ pid: DEAD_PID, since: "2020-01-01T00:00:00Z", client: "mac", host: "old" }));
    expect(isForeignLiveLock((await readLock(dir))!, me)).toBe(false);
    expect(await acquireLock(dir, me)).toEqual({ ok: true });
    expect((await readLock(dir))!.pid).toBe(process.pid);

    writeFileSync(lockPath(dir), "not json");
    expect(await readLock(dir)).toBeNull();
    expect(await acquireLock(dir, me)).toEqual({ ok: true });

    writeFileSync(lockPath(dir), JSON.stringify({ pid: "x" }));
    expect(await readLock(dir)).toBeNull();

    // Same pid, different token = another engine instance in this process → conflict.
    await acquireLock(dir, me);
    const conflict = await acquireLock(dir, other);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.conflict).toMatchObject({ pid: process.pid, client: "test", host: "box", token: "t1" });
    expect((await readLock(dir))!.token).toBe("t1");
    // Re-acquire by the same owner is fine (re-open).
    expect(await acquireLock(dir, me)).toEqual({ ok: true });
    // Takeover overwrites a live foreign lock.
    expect(await acquireLock(dir, other, { takeover: true })).toEqual({ ok: true });
    expect((await readLock(dir))!.token).toBe("t2");
    // A lock without a token from a live pid that is not ours is foreign.
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, since: "", client: "mac", host: "" }));
    expect(isForeignLiveLock((await readLock(dir))!, me)).toBe(true);
    expect(isForeignLiveLock((await readLock(dir))!, { pid: process.pid, client: "test", host: "" })).toBe(false);
  });

  it("linked worktree: the lock lives in the real gitdir (`.git` is a file), separate from the main worktree's", async () => {
    const repo = track(realpathSync(makeBranchRepo("rg-lock-repo")));
    const root = track(realpathSync(makeTempDir("rg-lock-root")));
    const wt = join(root, "wb");
    await addWorktree(repo, { path: wt, branch: "wb", existingBranch: false });
    const mainDir = await gitDir(repo);
    const linkedDir = await gitDir(wt);
    expect(mainDir).toBe(join(repo, ".git"));
    expect(linkedDir).toBe(join(repo, ".git", "worktrees", "wb"));
    expect(readFileSync(join(wt, ".git"), "utf8").startsWith("gitdir:")).toBe(true);

    await acquireLock(mainDir, me);
    await acquireLock(linkedDir, other);
    expect(existsSync(join(repo, ".git", LOCK_FILE))).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees", "wb", LOCK_FILE))).toBe(true);
    expect(existsSync(join(wt, ".git", LOCK_FILE))).toBe(false); // never next to the `.git` file
    expect((await readLock(mainDir))!.token).toBe("t1");
    expect((await readLock(linkedDir))!.token).toBe("t2");
  });
});
