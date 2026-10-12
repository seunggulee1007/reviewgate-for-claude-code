import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CliResumableSession, CliRunningSession, CliSessionStatus, PeerSelf, PeerSessionInfo } from "../protocol.js";
import { realpathLenient } from "../platform/paths.js";
import { inWorktree, MAX_REGISTRY_FILES, processInfo as psInfo, readRegistry, REGISTRY_FILE_RE, SESSION_REGISTRY_DIR, type ProcessInfo } from "./concurrent.js";
import { isPidAlive } from "./lock.js";

/**
 * §36.9 (audit market-03): the user's other Claude sessions of this repository. Running ones come from the CLI's registry
 * (`<config>/sessions/<pid>.json`, §31.4 — only the `<digits>.json` files are read; the `*.key` token files next to them
 * are never opened), resumable ones from the SDK's `listSessions` (terminal / IDE conversations — `includeProgrammatic:
 * false` leaves out SDK sessions such as ReviewGate's own, like the terminal's /resume). Nothing is ever sent to them.
 */

const STATUSES = new Set<CliSessionStatus>(["idle", "busy", "waiting"]);
/** At most this many resumable sessions go out (newest first). */
export const MAX_RESUMABLE = 50;
const RESUMABLE_TITLE_MAX = 120;

export type RunningOptions = {
  /** `<CLAUDE_CONFIG_DIR | ~/.claude>`. */
  configDir: string;
  /** The repository's worktrees (main first): a session counts when its cwd is in one of them. */
  worktreeRoots: string[];
  /** This window's worktree (`sameWorktree`). */
  currentRoot: string;
  /** The engine's process: CLIs it spawned (side questions, drafts) have it as their parent. */
  selfPid: number;
  /** The engine's own main CLI (whatever its parent). */
  excludePids?: ReadonlySet<number>;
  /** Test seams. */
  isAlive?: (pid: number) => boolean;
  processInfo?: (pids: number[]) => Promise<Map<number, ProcessInfo>>;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function registryFiles(configDir: string): Promise<{ pid: number; path: string }[]> {
  const dir = join(configDir, SESSION_REGISTRY_DIR);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => REGISTRY_FILE_RE.test(n)).slice(0, MAX_REGISTRY_FILES);
  return names.map((n) => ({ pid: Number(REGISTRY_FILE_RE.exec(n)![1]), path: join(dir, n) }));
}

/** The live registered Claude processes working in this repository (any of its worktrees), this engine's own left out. */
export async function runningCliSessions(opts: RunningOptions): Promise<CliRunningSession[]> {
  const alive = opts.isAlive ?? isPidAlive;
  const roots = opts.worktreeRoots.map((r) => realpathLenient(r));
  const current = realpathLenient(opts.currentRoot);
  const found: { entry: CliRunningSession; procStart: string | null }[] = [];
  for (const { pid, path } of await registryFiles(opts.configDir)) {
    if (pid === opts.selfPid || opts.excludePids?.has(pid) || !alive(pid)) continue;
    const o = await readRegistry(path);
    if (!o || o.pid !== pid || typeof o.cwd !== "string" || !o.cwd) continue;
    let inRepo = false;
    for (const root of roots) if (await inWorktree(o.cwd, root)) inRepo = true;
    if (!inRepo) continue;
    const status = str(o.status);
    const sock = socketOfEntry(o); // MARK: wave4d w4d-peers — §42.2
    found.push({
      entry: {
        pid,
        sessionId: str(o.sessionId),
        name: str(o.name),
        cwd: o.cwd,
        status: status && STATUSES.has(status as CliSessionStatus) ? (status as CliSessionStatus) : "unknown",
        entrypoint: str(o.entrypoint),
        sameWorktree: await inWorktree(o.cwd, current),
        ...(sock ? { address: `uds:${sock}` } : {}),
      },
      procStart: str(o.procStart),
    });
  }
  if (found.length === 0) return [];
  const info = await (opts.processInfo ?? psInfo)(found.map((f) => f.entry.pid)).catch(() => new Map<number, ProcessInfo>());
  return found
    .filter(({ entry, procStart }) => {
      const p = info.get(entry.pid);
      if (!p) return true;
      if (p.ppid === opts.selfPid) return false; // a CLI this engine spawned
      return procStart === null || squash(procStart) === squash(p.lstart); // else the pid was reused
    })
    .map((f) => f.entry)
    .sort((a, b) => Number(b.sameWorktree) - Number(a.sameWorktree) || a.pid - b.pid);
}

/** A live registry entry runs `sessionId` (two processes on one conversation would corrupt it). Any cwd. */
export async function registryHasSession(opts: { configDir: string; sessionId: string; isAlive?: (pid: number) => boolean }): Promise<boolean> {
  const alive = opts.isAlive ?? isPidAlive;
  for (const { pid, path } of await registryFiles(opts.configDir)) {
    if (!alive(pid)) continue;
    const o = await readRegistry(path);
    if (o && o.pid === pid && o.sessionId === opts.sessionId) return true;
  }
  return false;
}

/** What `listSessions` returns that `resumable` needs (SDK `SDKSessionInfo`). */
export type ListedSession = { sessionId: string; summary?: string; customTitle?: string; firstPrompt?: string; lastModified: number; cwd?: string };
export type ListSessionsFn = (opts: { dir: string; includeWorktrees: boolean; includeProgrammatic: boolean; limit: number }) => Promise<ListedSession[]>;

function titleOf(s: ListedSession): string {
  const raw = [s.customTitle, s.summary, s.firstPrompt].find((t) => typeof t === "string" && t.trim()) ?? s.sessionId;
  const line = (raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? s.sessionId).replace(/\s+/g, " ");
  return line.length > RESUMABLE_TITLE_MAX ? `${line.slice(0, RESUMABLE_TITLE_MAX - 1)}…` : line;
}

/**
 * The conversations of this repository (every worktree) a terminal / IDE left that can be resumed here: newest first, at
 * most 50, without `exclude` (the running ones, the chats the app already has). A listing that fails is empty.
 */
export async function resumableCliSessions(opts: { mainRoot: string; exclude: ReadonlySet<string>; list: ListSessionsFn }): Promise<CliResumableSession[]> {
  let listed: ListedSession[];
  try {
    listed = await opts.list({ dir: opts.mainRoot, includeWorktrees: true, includeProgrammatic: false, limit: MAX_RESUMABLE * 4 });
  } catch {
    return [];
  }
  return listed
    .filter((s) => s && typeof s.sessionId === "string" && s.sessionId && !opts.exclude.has(s.sessionId))
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    .slice(0, MAX_RESUMABLE)
    .map((s) => ({
      sessionId: s.sessionId,
      title: titleOf(s),
      updatedAt: new Date(Number.isFinite(s.lastModified) ? s.lastModified : 0).toISOString(),
      cwd: typeof s.cwd === "string" && s.cwd ? s.cwd : null,
    }));
}

// MARK: wave4d w4d-peers
/*
 * §42.2 (audit peer-05, peer-07): whom a cross-session address names. The CLI addresses another session as
 * `uds:<socket>` (percent-encoded; a bare socket / named-pipe path works too) and lists each session's socket in its
 * registry entry (`messagingSocketPath`). Only `<pid>.json` files are read — never the `*.key` token files.
 */

const BARE_SOCKET_RE = /^\/\S*\.sock$/;
const PIPE_RE = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;
const SOCKET_PID_RE = /(?:^|[\\/])(\d+)\.sock$/;

/** The socket path `address` names (`uds:<path>` percent-decoded as the CLI does, or a bare socket / pipe path); null otherwise. */
export function peerSocketOf(address: string): string | null {
  if (address.startsWith("uds:")) {
    const raw = address.slice(4);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return BARE_SOCKET_RE.test(address) || PIPE_RE.test(address) ? address : null;
}

function socketOfEntry(o: object): string | null {
  return str((o as { messagingSocketPath?: unknown }).messagingSocketPath);
}

function statusOf(v: unknown): CliSessionStatus {
  const s = str(v);
  return s && STATUSES.has(s as CliSessionStatus) ? (s as CliSessionStatus) : "unknown";
}

/**
 * The live registry entry whose messaging socket `address` names — the session a SendMessage reaches; null when the
 * address is not a socket (an agent / teammate name) or no live entry lists it. The pid in the socket's name is tried
 * first, then every entry (bounded like §31.4).
 */
export async function peerAtAddress(opts: { configDir: string; address: string; isAlive?: (pid: number) => boolean }): Promise<PeerSessionInfo | null> {
  const sock = peerSocketOf(opts.address);
  if (!sock) return null;
  const alive = opts.isAlive ?? isPidAlive;
  const files = await registryFiles(opts.configDir);
  const hint = Number(SOCKET_PID_RE.exec(sock)?.[1] ?? NaN);
  const ordered = [...files.filter((f) => f.pid === hint), ...files.filter((f) => f.pid !== hint)];
  for (const { pid, path } of ordered) {
    const o = await readRegistry(path);
    if (!o || o.pid !== pid || socketOfEntry(o) !== sock || !alive(pid)) continue;
    return { address: opts.address, pid, name: str(o.name), cwd: str(o.cwd), status: statusOf(o.status), entrypoint: str(o.entrypoint) };
  }
  return null;
}

/** This window's main CLI (`pid`) as the user's other sessions see it: its registry name and address; null without an entry. */
export async function selfPeer(opts: { configDir: string; pid: number }): Promise<PeerSelf | null> {
  const o = await readRegistry(join(opts.configDir, SESSION_REGISTRY_DIR, `${opts.pid}.json`));
  if (!o || o.pid !== opts.pid) return null;
  const sock = socketOfEntry(o);
  return { pid: opts.pid, name: str(o.name), address: sock ? `uds:${sock}` : null };
}
