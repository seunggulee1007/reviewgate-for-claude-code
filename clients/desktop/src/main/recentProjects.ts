/**
 * MARK: wave4 w4-install — audit daily-17: the recent list's rules, the same as the Mac app's (`RecentProjects` in Core).
 * Temporary / test folders never enter it; a folder that is gone is shown dimmed with "Not found" and never opened.
 */
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RecentProjectEntry } from "../shared/ipc.js";

/** The Mac's list; `tmp` (this machine's temp folder — `%TEMP%` on Windows) is added on top. */
export const TRANSIENT_PREFIXES = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/"];

const slashed = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/";

export function isTransientProjectPath(path: string, tmp: string = tmpdir()): boolean {
  const p = slashed(path);
  if (TRANSIENT_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  return tmp !== "" && p.toLowerCase().startsWith(slashed(tmp).toLowerCase());
}

export function withoutRecent(list: readonly string[], path: string): string[] {
  const p = resolve(path);
  return list.filter((x) => x !== path && x !== p);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** What the menus and the empty window show: no temporary folders, each row knowing whether its folder still exists. */
export function recentEntries(list: readonly string[], exists: (path: string) => boolean = isDirectory, tmp: string = tmpdir()): RecentProjectEntry[] {
  return list.filter((p) => !isTransientProjectPath(p, tmp)).map((path) => ({ path, exists: exists(path) }));
}
