import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathLenient, samePath } from "../platform/paths.js";

/** Immediate subfolders of `dir` that contain a `.git` entry, sorted by name (hidden entries skipped). */
export function findGitCandidates(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => existsSync(join(dir, e.name, ".git")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((name) => join(dir, name));
}

function canonical(p: string): string {
  return realpathLenient(p);
}

const MAX_SAFE_ENTRIES = 200;

/**
 * `git init` here would swallow a whole user area: `/`, `$HOME`, ~/Desktop, ~/Documents, ~/Downloads,
 * or any folder with more than 200 direct entries.
 */
export function looksUnsafeForGitInit(dir: string, home: string = homedir()): boolean {
  const path = canonical(dir);
  const homePath = canonical(home);
  const unsafe = [canonical("/"), homePath];
  for (const sub of ["Desktop", "Documents", "Downloads"]) unsafe.push(canonical(join(home, sub)));
  if (unsafe.some((u) => samePath(u, path))) return true;
  let count = 0;
  try {
    count = readdirSync(path).length;
  } catch {
    count = 0;
  }
  return count > MAX_SAFE_ENTRIES;
}
