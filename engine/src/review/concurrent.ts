import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConcurrentClaude } from "../protocol.js";
import { isInsidePath, realpathLenient, samePath } from "../platform/paths.js";
import { exec } from "../util/exec.js";
import { isPidAlive } from "./lock.js";

/**
 * Other Claude Code processes working in this worktree (docs/PROTOCOL.md §31). Every CLI (2.1.30x) registers itself in
 * `<config>/sessions/<pid>.json` — `{pid, sessionId, cwd, startedAt (epoch ms), procStart (ps lstart, UTC), kind,
 * entrypoint, name, status, …}` (checked against CLI 2.1.308) — and removes the file when it exits. Only the
 * `<digits>.json` files are read: the `<pid>.<hash>.key` files next to them hold a token and are never opened.
 */
export const SESSION_REGISTRY_DIR = "sessions";
/** Registry entries looked at (newest pids first is not guaranteed: a cap against a runaway directory). */
export const MAX_REGISTRY_FILES = 500;
const MAX_REGISTRY_BYTES = 64 * 1024;
export const REGISTRY_FILE_RE = /^(\d+)\.json$/;

export type ConcurrentOptions = {
  /** `<CLAUDE_CONFIG_DIR | ~/.claude>`. */
  configDir: string;
  /** The worktree root (git toplevel). */
  root: string;
  /** The engine's process: CLIs it spawned itself (the main session, side questions) are its own. */
  selfPid: number;
  /** Pids that are the engine's own whatever their parent (the main session's CLI; Windows has no `ps`). */
  excludePids?: ReadonlySet<number>;
  /** Test seams. */
  isAlive?: (pid: number) => boolean;
  processInfo?: (pids: number[]) => Promise<Map<number, ProcessInfo>>;
};

export type ProcessInfo = { ppid: number; lstart: string };

/**
 * The live registered Claude processes whose cwd is in `root`'s worktree — the root or a directory below it that is
 * not inside another repository / worktree (a `.git` entry on the way up) — excluding the engine's own CLIs (parent
 * pid = `selfPid`, or `excludePids`) and entries whose pid was reused (its `procStart` is not the process's start).
 */
export async function findConcurrentClaude(opts: ConcurrentOptions): Promise<ConcurrentClaude[]> {
  const dir = join(opts.configDir, SESSION_REGISTRY_DIR);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => REGISTRY_FILE_RE.test(n)).slice(0, MAX_REGISTRY_FILES);
  const alive = opts.isAlive ?? isPidAlive;
  const root = realpathLenient(opts.root);
  const found: { entry: ConcurrentClaude; procStart: string | null }[] = [];
  for (const name of names) {
    const pid = Number(REGISTRY_FILE_RE.exec(name)![1]);
    if (pid === opts.selfPid || opts.excludePids?.has(pid) || !alive(pid)) continue;
    const o = await readRegistry(join(dir, name));
    if (!o || o.pid !== pid || typeof o.cwd !== "string" || !o.cwd) continue;
    if (!(await inWorktree(o.cwd, root))) continue;
    found.push({
      entry: {
        pid,
        sessionId: str(o.sessionId),
        cwd: o.cwd,
        name: str(o.name),
        kind: str(o.kind),
        entrypoint: str(o.entrypoint),
        status: str(o.status),
        startedAt: typeof o.startedAt === "number" && Number.isFinite(o.startedAt) ? new Date(o.startedAt).toISOString() : null,
      },
      procStart: str(o.procStart),
    });
  }
  if (found.length === 0) return [];
  const info = await (opts.processInfo ?? processInfo)(found.map((f) => f.entry.pid)).catch(() => new Map<number, ProcessInfo>());
  return found
    .filter(({ entry, procStart }) => {
      const p = info.get(entry.pid);
      if (!p) return true;
      if (p.ppid === opts.selfPid) return false;
      return procStart === null || squash(procStart) === squash(p.lstart);
    })
    .map((f) => f.entry)
    .sort((a, b) => a.pid - b.pid);
}

export type RegistryEntry = { pid?: unknown; sessionId?: unknown; cwd?: unknown; name?: unknown; kind?: unknown; entrypoint?: unknown; status?: unknown; startedAt?: unknown; procStart?: unknown };

// MARK: wave3 engine-session — exported for §36.9 (review/cliSessions.ts), like inWorktree below.
export async function readRegistry(path: string): Promise<RegistryEntry | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) return null;
    const o = JSON.parse(await readFile(path, "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as RegistryEntry) : null;
  } catch {
    return null;
  }
}

/** `cwd` is `root` or below it, and no directory between them holds a `.git` (that would be another repository / worktree). */
export async function inWorktree(cwd: string, root: string): Promise<boolean> {
  const real = realpathLenient(cwd);
  if (!isInsidePath(real, root)) return false;
  for (let d = real; !samePath(d, root); d = dirname(d)) {
    if (await lstat(join(d, ".git")).then(() => true, () => false)) return false;
    if (dirname(d) === d) return false;
  }
  return true;
}

/** `ps -o pid=,ppid=,lstart=` (UTC, like the CLI's `procStart`) for live pids; empty on Windows / failure. */
export async function processInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const out = new Map<number, ProcessInfo>();
  if (process.platform === "win32" || pids.length === 0) return out;
  const r = await exec("ps", ["-o", "pid=,ppid=,lstart=", "-p", pids.join(",")], { env: { TZ: "UTC", LC_ALL: "C" }, timeoutMs: 3000 });
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), lstart: m[3]! });
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
