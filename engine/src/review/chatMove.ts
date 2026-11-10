import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isPermissionMode, type ChatMoveBaseline, type ChatMoveRef, type PermissionMode, type SessionMeta } from "../protocol.js";
import { sameRepository, type GitWorktree } from "../git/worktrees.js";
import { isInsidePath, realpathLenient, samePath } from "../platform/paths.js";
import { readJSON, writeAtomicJSON } from "./persist.js";

/**
 * MARK: wave4b w4b-follow — docs/PROTOCOL.md §39.4: a chat handed to another worktree of the repository. The window that
 * gives it writes `<target gitdir>/reviewgate/incoming/<id>.json` (+ `<id>.ndjson`, a copy of its rows) once its CLI has
 * exited; the target's engine takes it on `open_project` or `chat_receive` — it is the only writer of its own sessions
 * index, so a window that already has the target open never sees the index change under its feet.
 */
export const INCOMING_DIR = join("reviewgate", "incoming");

export type ChatHandoff = {
  version: 1;
  /** The chat as it leaves (`movedFrom` set, never `movedTo`). */
  meta: SessionMeta;
  from: ChatMoveRef;
  /** The target worktree's root as the giving window saw it. */
  to: string;
  baseline: ChatMoveBaseline;
  /** Sent once in the target after the move (only when a running turn was stopped for it). */
  followUp: string | null;
  /** §11: the permission mode follows the chat. */
  permissionMode: PermissionMode | null;
  /** ISO-8601 */
  at: string;
};

export type IncomingChat = { handoff: ChatHandoff; file: string; rowsPath: string | null };

export function incomingDir(gitDir: string): string {
  return join(gitDir, INCOMING_DIR);
}

/** The rows first, the JSON last (atomic): a handoff file that exists always has its rows next to it. */
export async function writeHandoff(targetGitDir: string, handoff: ChatHandoff, transcriptPath: string | null): Promise<void> {
  const dir = incomingDir(targetGitDir);
  mkdirSync(dir, { recursive: true });
  const id = handoff.meta.id;
  const rows = join(dir, `${id}.ndjson`);
  if (transcriptPath && existsSync(transcriptPath)) copyFileSync(transcriptPath, rows);
  else rmSync(rows, { force: true });
  await writeAtomicJSON(join(dir, `${id}.json`), handoff);
}

function validHandoff(v: unknown): ChatHandoff | null {
  if (!v || typeof v !== "object") return null;
  const h = v as Partial<ChatHandoff>;
  if (h.version !== 1 || !h.meta || typeof h.meta !== "object" || typeof h.meta.id !== "string" || !h.meta.id) return null;
  if (!h.from || typeof h.from.path !== "string" || typeof h.at !== "string") return null;
  return {
    version: 1,
    meta: h.meta,
    from: { path: h.from.path, name: typeof h.from.name === "string" && h.from.name ? h.from.name : basename(h.from.path), at: typeof h.from.at === "string" ? h.from.at : h.at },
    to: typeof h.to === "string" ? h.to : "",
    baseline: h.baseline === "head" ? "head" : "disk",
    followUp: typeof h.followUp === "string" && h.followUp.trim() ? h.followUp : null,
    permissionMode: isPermissionMode(h.permissionMode) ? h.permissionMode : null,
    at: h.at,
  };
}

/** The chats waiting for this worktree, oldest first; a broken file is dropped (with its rows). */
export async function readIncoming(gitDir: string): Promise<IncomingChat[]> {
  const dir = incomingDir(gitDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: IncomingChat[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const handoff = validHandoff(await readJSON<unknown>(file));
    const rows = join(dir, name.replace(/\.json$/, ".ndjson"));
    if (!handoff || `${handoff.meta.id}.json` !== name) {
      rmSync(file, { force: true });
      rmSync(rows, { force: true });
      continue;
    }
    out.push({ handoff, file, rowsPath: existsSync(rows) ? rows : null });
  }
  return out.sort((a, b) => (a.handoff.at < b.handoff.at ? -1 : a.handoff.at > b.handoff.at ? 1 : 0));
}

export function dropIncoming(chat: IncomingChat): void {
  rmSync(chat.file, { force: true });
  if (chat.rowsPath) rmSync(chat.rowsPath, { force: true });
}

export type MoveTarget = { root: string; name: string; branch: string | null };
/** Why `chat_move` refuses a path: none given, not on disk, not a worktree of this repository, this window's own. */
export type MoveTargetRefusal = "path_not_found" | "not_a_worktree" | "same_worktree";

/**
 * §39.4: the refusal as the user should read it — a folder that is another repository's worktree is `other_repository`
 * (a chat moves only between worktrees of one repository: the CLI's record of the conversation stays with it).
 */
export async function moveRefusal(refused: MoveTargetRefusal, requested: unknown, currentRoot: string): Promise<MoveTargetRefusal | "other_repository"> {
  if (refused !== "not_a_worktree" || typeof requested !== "string" || !requested.trim()) return refused;
  return (await sameRepository(resolve(currentRoot, requested.trim()), currentRoot)) === false ? "other_repository" : refused;
}

/**
 * §39.4: the worktree `requested` names — its root, also for a folder inside it (the deepest listed root wins, so a
 * worktree nested in another is itself). Only a worktree of this repository (`git worktree list`, bare / prunable rows
 * left out) other than this window's (`currentRoot`).
 */
export function moveTarget(requested: unknown, currentRoot: string, worktrees: readonly GitWorktree[], exists: (p: string) => boolean = isDirectory): MoveTarget | { refused: MoveTargetRefusal } {
  if (typeof requested !== "string" || !requested.trim()) return { refused: "path_not_found" };
  const abs = resolve(currentRoot, requested.trim());
  if (!exists(abs)) return { refused: "path_not_found" };
  const real = realpathLenient(abs);
  let best: { wt: GitWorktree; root: string } | null = null;
  for (const wt of worktrees) {
    if (wt.bare || wt.prunable || !wt.path) continue;
    const root = realpathLenient(wt.path);
    if (!samePath(real, root) && !isInsidePath(real, root)) continue;
    if (!best || root.length > best.root.length) best = { wt, root };
  }
  if (!best) return { refused: "not_a_worktree" };
  if (samePath(best.root, realpathLenient(currentRoot))) return { refused: "same_worktree" };
  return { root: best.wt.path, name: basename(best.wt.path) || best.wt.path, branch: best.wt.branch };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True once `pid` is gone (`kill(pid, 0)` → ESRCH), polled every 50 ms for at most `ms`. EPERM counts as alive. */
export async function waitForExit(pid: number, ms: number, alive: (pid: number) => boolean = pidAlive): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
