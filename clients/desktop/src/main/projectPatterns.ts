/**
 * Per-project Bash allow patterns (`settings.projectBashAllowPatterns[projectRootHash(root)]`): the
 * permission card's "Always allow in this project" adds a line there. The engine still gets ONE
 * `bashAllowPatterns` list (docs/PROTOCOL.md §10) — the global lines plus the open project's — so
 * no engine change is needed. Pure (no `electron`), unit-tested.
 */
import { projectRootHash } from "../shared/hash.js";

/** "One per line" textareas → entries (blank lines and `#` comments dropped). */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** The global patterns followed by the project's own (deduplicated, order kept). */
export function mergedAllowPatterns(globalText: string, perProject: Record<string, string> | undefined, root: string | null | undefined): string[] {
  const own = root && perProject ? perProject[projectRootHash(root)] : undefined;
  const all = [...linesOf(globalText ?? ""), ...(typeof own === "string" ? linesOf(own) : [])];
  return [...new Set(all)];
}

export const PROJECT_HASH = /^[0-9a-f]{8}$/;
