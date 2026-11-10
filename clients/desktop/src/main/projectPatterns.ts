/**
 * Per-project Bash allow patterns (`settings.projectBashAllowPatterns[projectRootHash(key)]`): the
 * permission card's "Always allow in this project" adds a line there — keyed by the repository (`state.project.commonDir`,
 * r2 M21; a list keyed by a worktree's own root before still applies to it). The engine still gets ONE
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

/**
 * The global patterns followed by the project's own (deduplicated, order kept) — MARK: r2-skills-side (§33.6, M21): its
 * repository's (`repo`, the git common dir every worktree of it shares), then what was kept by the folder `root` before.
 */
export function mergedAllowPatterns(globalText: string, perProject: Record<string, string> | undefined, root: string | null | undefined, repo?: string | null): string[] {
  const text = (key: string | null | undefined) => (key && perProject ? perProject[projectRootHash(key)] : undefined);
  const lists = [text(repo), text(root)].map((own) => (typeof own === "string" ? linesOf(own) : []));
  return [...new Set([...linesOf(globalText ?? ""), ...lists.flat()])];
}

export const PROJECT_HASH = /^[0-9a-f]{8}$/;
