import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJSON, writeAtomicJSON } from "../review/persist.js";

/**
 * Remembered allows of one worktree (docs/PROTOCOL.md §33.7): `<gitdir>/reviewgate/allows.json`, written only while
 * `settings.persistSessionAllows` is on. Each worktree (a workbench too) has its own gitdir, so its own set.
 */

export type PersistedAllows = { version: 1; keys: string[]; savedAt: string };

export function allowsFilePath(gitDir: string): string {
  return join(gitDir, "reviewgate", "allows.json");
}

/** The stored keys; empty when the file is missing, unreadable or of another version. */
export async function loadRememberedAllows(gitDir: string): Promise<string[]> {
  const f = await readJSON<PersistedAllows>(allowsFilePath(gitDir));
  if (!f || f.version !== 1 || !Array.isArray(f.keys)) return [];
  return f.keys.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 2000);
}

export async function saveRememberedAllows(gitDir: string, keys: readonly string[]): Promise<void> {
  const path = allowsFilePath(gitDir);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicJSON(path, { version: 1, keys: [...keys], savedAt: new Date().toISOString() } satisfies PersistedAllows);
}

export async function clearRememberedAllows(gitDir: string): Promise<void> {
  await rm(allowsFilePath(gitDir), { force: true });
}
