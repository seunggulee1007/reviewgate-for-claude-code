import { mkdir, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { runGit } from "./exec.js";
import { parseRemoteURL } from "../pr/create.js";
import { parseTaskRef } from "../pr/task.js";

/**
 * docs/PROTOCOL.md §69 (start without a folder): the name of a new project folder made from what the user typed, a free
 * folder for it under the parent (`-2`, `-3`, … on a collision), and — for "Start from a task" — the recent projects whose
 * git remote is the task's repository. Both clients ask the engine, so the rules live here once.
 */

/** The fallback when the text holds nothing usable for a name. */
export const NEW_PROJECT_FALLBACK = "new-project";
/** A name is at most this many characters (cut at a word). */
export const PROJECT_NAME_MAX = 40;
/** At most this many words of the text make the name. */
const PROJECT_NAME_WORDS = 5;
/** Collisions try `-2` … `-<this>`. */
const MAX_SUFFIX = 99;
/** `project_match` reads at most this many folders, each with this cap. */
export const PROJECT_MATCH_MAX_PATHS = 30;
export const PROJECT_MATCH_TIMEOUT_MS = 3_000;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A short folder name from free text: its first words (letters and digits of any script — Korean stays), lower-cased,
 * joined by `-`, at most 40 characters cut at a word; `new-project` when nothing is left. Idempotent: a name it made
 * gives itself back, so an edited name goes through the same rule.
 */
export function projectSlug(text: string): string {
  const words = text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, PROJECT_NAME_WORDS);
  let name = "";
  for (const word of words) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > PROJECT_NAME_MAX) {
      if (!name) name = [...word].slice(0, PROJECT_NAME_MAX).join("");
      break;
    }
    name = next;
  }
  if (!name) return NEW_PROJECT_FALLBACK;
  return WINDOWS_RESERVED.test(name) ? `${name}-project` : name;
}

/** The parent folder: the one given (`~` is the home folder), else `<home>/ReviewGate`. Null when it is not absolute. */
export function resolveProjectParent(parent: string | null | undefined, home: string): string | null {
  const p = (parent ?? "").trim();
  if (!p) return join(home, "ReviewGate");
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : null;
}

/** The first of `name`, `name-2`, `name-3`, … that does not exist under `parent` (a preview; the create checks again). */
export function freeProjectPath(parent: string, name: string): string {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const path = join(parent, n === 1 ? name : `${name}-${n}`);
    if (!existsSync(path)) return path;
  }
  return join(parent, `${name}-${Date.now()}`);
}

/**
 * Makes the parent (with its parents) and then the first free `name`, `name-2`, … in it — each `mkdir` is the check, so
 * two creates never take the same folder. Throws `Error("parent_not_writable:<why>")`.
 */
export async function createProjectFolder(parent: string, name: string): Promise<string> {
  try {
    await mkdir(parent, { recursive: true });
  } catch (e) {
    throw new Error(`parent_not_writable:${(e as Error).message}`);
  }
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const path = join(parent, n === 1 ? name : `${name}-${n}`);
    try {
      await mkdir(path);
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error(`parent_not_writable:${(e as Error).message}`);
    }
  }
  throw new Error(`parent_not_writable:${name}-2 … ${name}-${MAX_SUFFIX} all exist`);
}

/** Removes the folder `createProjectFolder` made when the rest failed (only while it is still empty). */
export async function removeEmptyFolder(path: string): Promise<void> {
  await rmdir(path).catch(() => undefined);
}

/** Which repository a task names: `owner/repo` (and its host when a link gives one); null for a key, a number, text. */
export function taskRepo(text: string): { host: string | null; owner: string; repo: string } | null {
  const s = text.trim();
  const ref = parseTaskRef(s) ?? parseTaskRef(/https?:\/\/\S+/.exec(s)?.[0] ?? "");
  if (!ref?.repo) return null;
  const [owner, repo] = ref.repo.split("/") as [string, string];
  return { host: ref.host, owner, repo };
}

/** Every remote URL of the repository `path` is in (`git remote -v`); [] when it is none, or git does not answer in time. */
async function remoteURLs(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    const out = await runGit(path, ["remote", "-v"], { allowFailure: true, discover: true, timeoutMs: PROJECT_MATCH_TIMEOUT_MS });
    if (out.status !== 0) return [];
    return [...new Set(out.text.split(/\r?\n/).map((l) => l.split(/\s+/)[1] ?? "").filter(Boolean))];
  } catch {
    return [];
  }
}

export type ProjectMatches = { repo: string | null; matches: string[]; guess: string | null };

/**
 * The candidate folders (in the client's order — most recent first, at most 30) whose remote is the task's repository
 * (`owner/repo`, any case; a remote on the link's host first). `guess`: the first match, else a folder whose remote or
 * own name is the repository's name (a fork, a clone without a remote), else null. Read-only: `git remote -v` only.
 */
export async function matchProjects(text: string, paths: readonly string[]): Promise<ProjectMatches> {
  const target = taskRepo(text);
  if (!target) return { repo: null, matches: [], guess: null };
  const candidates = [...new Set(paths.filter((p) => typeof p === "string" && isAbsolute(p)))].slice(0, PROJECT_MATCH_MAX_PATHS);
  const remotes = await Promise.all(candidates.map(async (path) => ({ path, remotes: (await remoteURLs(path)).map(parseRemoteURL).filter((r) => r !== null) })));
  const lc = (s: string) => s.toLowerCase();
  const sameRepo = (r: { owner: string; repo: string }) => lc(r.owner) === lc(target.owner) && lc(r.repo) === lc(target.repo);
  const onHost = (r: { host: string }) => target.host === null || lc(r.host).replace(/^www\./, "") === target.host;
  const exact = remotes.filter((c) => c.remotes.some(sameRepo));
  const matches = [...exact.filter((c) => c.remotes.some((r) => sameRepo(r) && onHost(r))), ...exact.filter((c) => !c.remotes.some((r) => sameRepo(r) && onHost(r)))].map((c) => c.path);
  const named = remotes.find((c) => c.remotes.some((r) => lc(r.repo) === lc(target.repo)) || lc(basename(c.path)) === lc(target.repo));
  return { repo: `${target.owner}/${target.repo}`, matches, guess: matches[0] ?? named?.path ?? null };
}
