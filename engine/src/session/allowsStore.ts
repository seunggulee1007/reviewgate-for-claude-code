import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readJSON, writeAtomicJSON } from "../review/persist.js";

/**
 * Remembered allows of one repository (docs/PROTOCOL.md §33.7): `<git common dir>/reviewgate/allows.json`, written while
 * `settings.persistSessionAllows` is on (the default). Every worktree of the repository (a workbench too) shares the file;
 * a set an older engine kept in a worktree's own gitdir (`<gitdir>/reviewgate/allows.json`) is read too and moved there.
 */

/**
 * `clearedAt` (release-2 review): when `forget_allows` last emptied the set — a window still open on another worktree drops
 * the keys it remembered before then at its next save or turn instead of writing them back.
 */
export type PersistedAllows = { version: 1; keys: string[]; savedAt: string; clearedAt?: string };

export function allowsFilePath(gitDir: string): string {
  return join(gitDir, "reviewgate", "allows.json");
}

/** The repository file's keys and its last clear (ms; null for none). */
export type AllowsFile = { keys: string[]; clearedAt: number | null };

async function readAllows(path: string): Promise<AllowsFile> {
  const f = await readJSON<PersistedAllows>(path);
  if (!f || f.version !== 1 || !Array.isArray(f.keys)) return { keys: [], clearedAt: null };
  const at = typeof f.clearedAt === "string" ? Date.parse(f.clearedAt) : NaN;
  return { keys: f.keys.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 2000), clearedAt: Number.isFinite(at) ? at : null };
}

async function readKeys(path: string): Promise<string[]> {
  return (await readAllows(path)).keys;
}

/** Release-2 review: the repository's file as it is now — its keys and when it was last cleared. */
export async function readAllowsFile(commonDir: string): Promise<AllowsFile> {
  return readAllows(allowsFilePath(commonDir));
}

/**
 * The stored keys: the repository's (`commonDir`), then a worktree's own older set (`gitDir`, when it differs); empty when
 * neither file is there, readable or of this version.
 */
export async function loadRememberedAllows(commonDir: string, gitDir: string = commonDir): Promise<string[]> {
  const keys = await readKeys(allowsFilePath(commonDir));
  if (resolve(gitDir) !== resolve(commonDir)) keys.push(...(await readKeys(allowsFilePath(gitDir))));
  return [...new Set(keys)];
}

/**
 * Adds `keys` to the repository's set — another worktree's window may have stored some meanwhile, so the file's keys are
 * kept — and drops a worktree's own older file (`gitDir`, when it differs): its keys are in `keys` since it was loaded.
 * Release-2 review: the file's `clearedAt` is kept; `keys` are what the caller holds after applying it (`readAllowsFile`).
 */
export async function saveRememberedAllows(commonDir: string, keys: readonly string[], gitDir: string = commonDir): Promise<void> {
  const path = allowsFilePath(commonDir);
  const file = await readAllows(path);
  const merged = [...new Set([...file.keys, ...keys])];
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicJSON(path, {
    version: 1,
    keys: merged,
    savedAt: new Date().toISOString(),
    ...(file.clearedAt !== null ? { clearedAt: new Date(file.clearedAt).toISOString() } : {}),
  } satisfies PersistedAllows);
  if (resolve(gitDir) !== resolve(commonDir)) await rm(allowsFilePath(gitDir), { force: true });
}

/**
 * `forget_allows`: the repository's set emptied for every worktree — release-2 review: an empty file with `clearedAt` (a
 * window open on another worktree drops what it remembered before then, instead of writing it back) — and a worktree's
 * own older file removed.
 */
export async function forgetRememberedAllows(commonDir: string, gitDir: string = commonDir, at: number = Date.now()): Promise<void> {
  const path = allowsFilePath(commonDir);
  await mkdir(dirname(path), { recursive: true });
  const now = new Date(at).toISOString();
  await writeAtomicJSON(path, { version: 1, keys: [], savedAt: now, clearedAt: now } satisfies PersistedAllows);
  if (resolve(gitDir) !== resolve(commonDir)) await rm(allowsFilePath(gitDir), { force: true });
}

/** The setting turned off: the repository's file and a worktree's own older one. */
export async function clearRememberedAllows(commonDir: string, gitDir: string = commonDir): Promise<void> {
  await rm(allowsFilePath(commonDir), { force: true });
  if (resolve(gitDir) !== resolve(commonDir)) await rm(allowsFilePath(gitDir), { force: true });
}
