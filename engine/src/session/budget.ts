import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { diffLines } from "diff";
import type { Budget } from "../protocol.js";

export const DEFAULT_HARD_MULTIPLIER = 1.5;

/** §54: a count's limit, or null for none — 0 (the default), a negative number or not a number. */
function limitOf(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** §54: whether the budget limits anything. The default `{maxFiles: 0, maxLines: 0}` does not: no change budget. */
export function budgetIsOn(b: Budget): boolean {
  return limitOf(b.maxFiles) !== null || limitOf(b.maxLines) !== null;
}

/** Per-turn change-budget state. Reset on every user_message / turn_end. */
export class BudgetState {
  files = new Set<string>();
  lines = 0;
  denied = false;
  callsAfterDeny = 0;
  /** soft (100%) warning already emitted this turn */
  warned = false;
  budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  reset(): void {
    this.files = new Set();
    this.lines = 0;
    this.denied = false;
    this.callsAfterDeny = 0;
    this.warned = false;
  }

  setBudget(budget: Budget): void {
    this.budget = budget;
  }

  get hardMultiplier(): number {
    return this.budget.hardMultiplier ?? DEFAULT_HARD_MULTIPLIER;
  }

  /** §54: false for a budget without limits — nothing is counted, warned of or denied, and Claude is told nothing. */
  get active(): boolean {
    return budgetIsOn(this.budget);
  }

  /** True if the given (projected) totals exceed the hard limit (budget × hardMultiplier) of a count that has one. */
  wouldExceedHard(files: number, lines: number): boolean {
    const m = this.hardMultiplier;
    const maxFiles = limitOf(this.budget.maxFiles);
    const maxLines = limitOf(this.budget.maxLines);
    return (maxFiles !== null && files > maxFiles * m) || (maxLines !== null && lines > maxLines * m);
  }

  /** True if current totals are at/over 100% of the soft budget of a count that has one. */
  exceedsSoft(): boolean {
    const maxFiles = limitOf(this.budget.maxFiles);
    const maxLines = limitOf(this.budget.maxLines);
    return (maxFiles !== null && this.files.size >= maxFiles) || (maxLines !== null && this.lines >= maxLines);
  }

  snapshot(): { files: number; lines: number; denied: boolean } {
    return { files: this.files.size, lines: this.lines, denied: this.denied };
  }
}

/** Number of lines in a string ("" → 0; trailing newline does not add a line). */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Resolve a tool file path against cwd. */
export function resolveToolPath(p: string, cwd: string): string {
  return resolvePath(cwd, p);
}

/** How long one line diff of the estimate may take before the cruder count stands in (the hook runs before every edit). */
const DIFF_TIMEOUT_MS = 500;

/**
 * Changed lines (added + removed) between two texts — what git's numstat counts. A diff that would take longer than
 * `DIFF_TIMEOUT_MS` (a huge, very different text) counts both texts whole instead.
 */
function changedLines(before: string, after: string): number {
  if (before === after) return 0;
  const parts = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) return countLines(before) + countLines(after);
  let changed = 0;
  for (const part of parts) {
    if (part.added || part.removed) changed += part.count ?? countLines(part.value);
  }
  return changed;
}

type EditSpec = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };

/** `content` with one edit applied (the first occurrence, or every one with `replace_all`); null when `old_string` is not in it. */
function applyEdit(content: string, edit: EditSpec): string | null {
  const oldS = str(edit.old_string);
  const newS = str(edit.new_string);
  if (oldS.length === 0) return null;
  const at = content.indexOf(oldS);
  if (at === -1) return null;
  if (edit.replace_all === true) return content.split(oldS).join(newS);
  return content.slice(0, at) + newS + content.slice(at + oldS.length);
}

/**
 * One edit without its file: the diff of the two strings (each ended by a newline, so a missing last newline is no
 * change), the other string's lines when one is empty, × its occurrences with `replace_all`.
 */
function editWithoutFile(edit: EditSpec, content: string | null): number {
  const oldS = str(edit.old_string);
  const newS = str(edit.new_string);
  const base = oldS.length === 0 || newS.length === 0 ? countLines(oldS) + countLines(newS) : changedLines(oldS + "\n", newS + "\n");
  if (edit.replace_all === true && content !== null) {
    const occ = countOccurrences(content, oldS);
    if (occ > 1) return base * occ;
  }
  return base;
}

/**
 * The lines a list of edits changes in its file: the file's content before vs after them, so the context an edit carries
 * in `old_string` / `new_string` is not counted (both strings counted whole made the estimate ~5× git's numstat). Without
 * the file, or when an edit's `old_string` is not in it, each edit's own diff.
 */
function estimateEdits(edits: EditSpec[], filePath: string | null): number {
  const content = filePath ? readFileOrNull(filePath) : null;
  if (content !== null) {
    let after: string | null = content;
    for (const e of edits) {
      after = after === null ? null : applyEdit(after, e);
    }
    if (after !== null) return changedLines(content, after);
  }
  return edits.reduce((n, e) => n + editWithoutFile(e, content), 0);
}

/**
 * Estimate the number of changed lines a file-editing tool call would produce (added + removed, as git counts them).
 * Edit / MultiEdit: the file's content before vs after the edits; without the file, each edit's diff (× occurrences with
 * replace_all). Write: diffLines(existing, content), or lines(content) for a new file. NotebookEdit: lines(new_source).
 */
export function estimateEditLines(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): number {
  const rawPath = str(input.file_path) || str(input.notebook_path);
  const filePath = rawPath ? resolveToolPath(rawPath, cwd) : null;

  switch (toolName) {
    case "Edit":
      return estimateEdits([input], filePath);
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.filter((e): e is EditSpec => !!e && typeof e === "object") : [];
      return estimateEdits(edits, filePath);
    }
    case "Write": {
      const content = str(input.content);
      const existing = filePath ? readFileOrNull(filePath) : null;
      if (existing === null) return countLines(content);
      return changedLines(existing, content);
    }
    case "NotebookEdit":
      return countLines(str(input.new_source));
    default:
      return 0;
  }
}

