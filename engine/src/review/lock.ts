import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Advisory per-worktree session lock (docs/M10-WORKBENCHES.md): `<gitdir>/reviewgate.lock` holds the
 * engine that has the worktree open. It only informs `open_project` (conflict → the client may take
 * over); it never stops a running engine.
 */
export const LOCK_FILE = "reviewgate.lock";

export type LockInfo = {
  pid: number;
  /** ISO-8601 */
  since: string;
  client: string;
  host: string;
  /** Distinguishes engine instances inside one process (Electron windows, tests). */
  token?: string;
};

export type LockOwner = { pid: number; client: string; host: string; token?: string };

export type AcquireResult = { ok: true } | { ok: false; conflict: LockInfo };

export function lockPath(gitDir: string): string {
  return join(gitDir, LOCK_FILE);
}

/** Parsed lock file; null when missing or unparsable. */
export async function readLock(gitDir: string): Promise<LockInfo | null> {
  let text: string;
  try {
    text = await readFile(lockPath(gitDir), "utf8");
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(text) as Partial<LockInfo>;
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid)) return null;
    return {
      pid: o.pid,
      since: typeof o.since === "string" ? o.since : "",
      client: typeof o.client === "string" ? o.client : "",
      host: typeof o.host === "string" ? o.host : "",
      ...(typeof o.token === "string" ? { token: o.token } : {}),
    };
  } catch {
    return null;
  }
}

/** `kill(pid, 0)`: ESRCH → dead; EPERM → alive but not ours; anything else alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock held by a live process that is not `owner` (same pid + same token counts as ours). */
export function isForeignLiveLock(lock: LockInfo, owner: LockOwner): boolean {
  if (!isPidAlive(lock.pid)) return false;
  if (lock.pid !== owner.pid) return true;
  return (lock.token ?? null) !== (owner.token ?? null);
}

/**
 * Writes the lock unless a live lock by another session exists (`takeover` overwrites it anyway).
 * A stale lock (dead pid) or our own lock is overwritten.
 */
export async function acquireLock(gitDir: string, owner: LockOwner, opts: { takeover?: boolean; now?: () => Date } = {}): Promise<AcquireResult> {
  const existing = await readLock(gitDir);
  if (existing && !opts.takeover && isForeignLiveLock(existing, owner)) return { ok: false, conflict: existing };
  const info: LockInfo = {
    pid: owner.pid,
    since: (opts.now?.() ?? new Date()).toISOString(),
    client: owner.client,
    host: owner.host,
    ...(owner.token !== undefined ? { token: owner.token } : {}),
  };
  await writeFile(lockPath(gitDir), JSON.stringify(info) + "\n", "utf8");
  return { ok: true };
}

/** Removes the lock when it is ours (pid + token match) — or unconditionally without `owner`. */
export async function releaseLock(gitDir: string, owner?: LockOwner): Promise<void> {
  if (owner) {
    const existing = await readLock(gitDir);
    if (existing && (existing.pid !== owner.pid || (existing.token ?? null) !== (owner.token ?? null))) return;
  }
  await rm(lockPath(gitDir), { force: true }).catch(() => undefined);
}
